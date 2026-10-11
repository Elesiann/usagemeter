import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { readLimits, type LimitsOptions, type LimitsOutput } from "./limits.ts";
import { loadRates } from "./rates.ts";
import { scan, type ScanOptions } from "./scan.ts";

const CACHED_SCAN_ROUNDS = 10;
const COLD_SCAN_ROUNDS = 1;
const LIMITS_ROUNDS = 10;
const LIMITS_INTERVAL_MS = 3_000;

export interface BenchPhase {
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
  readonly p90Ms: number;
}

export interface BenchReport {
  readonly version: string;
  readonly sha: string;
  readonly dirty: boolean;
  readonly warmupMs: number;
  readonly generatedAt: string;
  readonly rounds: {
    readonly cachedScan: number;
    readonly coldScan: number;
    readonly limits: number;
    readonly warmupScans: number;
    readonly warmupLimits: number;
  };
  readonly phases: {
    readonly cachedScan: BenchPhase;
    readonly coldScan: BenchPhase;
    readonly limits: BenchPhase;
  };
}

export interface BenchOptions {
  readonly reportDir: string;
  readonly tempDir?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly version: string;
  readonly sha: string;
  readonly dirty: boolean;
}

export interface BenchDependencies {
  readonly loadRates?: typeof loadRates;
  readonly scan?: (options: ScanOptions) => Promise<unknown>;
  readonly readLimits?: (options: LimitsOptions) => Promise<LimitsOutput>;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface BenchResult {
  readonly report: BenchReport;
  readonly reportDir: string;
  readonly fileName: string;
}

export function summarizeSamples(samples: readonly number[]): Pick<BenchPhase, "medianMs" | "p90Ms"> {
  if (samples.length === 0) throw new Error("A benchmark phase needs at least one sample.");
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  const p90 = sorted[Math.ceil(sorted.length * 0.9) - 1]!;
  return { medianMs: roundMs(median), p90Ms: roundMs(p90) };
}

export async function runBench(options: BenchOptions, dependencies: BenchDependencies = {}): Promise<BenchResult> {
  const hubUrl = options.env.USAGEMETER_HUB_URL?.trim();
  const hubKey = options.env.USAGEMETER_HUB_KEY?.trim();
  if (!hubUrl || !hubKey) throw new Error("The bench requires a configured hub URL and management key.");

  const loadRatesForBench = dependencies.loadRates ?? loadRates;
  const scanForBench = dependencies.scan ?? scan;
  const readLimitsForBench = dependencies.readLimits ?? readLimits;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const wallNow = dependencies.wallNow ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tempRoot = await mkdtemp(path.join(options.tempDir ?? os.tmpdir(), "usagemeter-bench-"));

  try {
    const ratesCacheDir = path.join(tempRoot, "rates");
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const cachedCacheDir = path.join(tempRoot, "cached-scan");
    const coldCacheDir = path.join(tempRoot, "cold-scan");
    const scanOnce = async (cacheDir: string) => {
      const nowMs = wallNow().getTime();
      const rates = await loadRatesForBench(ratesCacheDir, nowMs);
      return scanForBench({ nowMs, timeZone, rates: rates.table, cacheDir, env: options.env });
    };

    await scanOnce(cachedCacheDir);
    const cachedScan = await measure(CACHED_SCAN_ROUNDS, () => scanOnce(cachedCacheDir), monotonicNow, sleep);
    const coldScan = await measure(COLD_SCAN_ROUNDS, () => scanOnce(coldCacheDir), monotonicNow, sleep);
    const openCodeGoEnabled = options.env.USAGEMETER_OPENCODE_GO === "1";
    const readLimitsSample = async (phase: string) => {
      try {
        const result = await readLimitsForBench({
          nowMs: wallNow().getTime(),
          hubUrl,
          hubKey,
          openCodeGo: openCodeGoEnabled,
          hubAutostart: options.env.USAGEMETER_HUB_AUTOSTART === "1",
          ...(options.env.USAGEMETER_HUB_BIN?.trim() ? { hubBin: options.env.USAGEMETER_HUB_BIN.trim() } : {}),
          env: options.env,
        });
        const reason = limitsFailureReason(result, openCodeGoEnabled);
        if (reason) throw new Error(reason);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : "The limits request failed.";
        throw new Error(`${phase} failed: ${withoutHubKey(message, hubKey)}`);
      }
    };
    const warmupStartedAt = monotonicNow();
    await readLimitsSample("Limits warm-up");
    const warmupMs = roundMs(monotonicNow() - warmupStartedAt);
    await sleep(LIMITS_INTERVAL_MS);
    const limits = await measure(
      LIMITS_ROUNDS,
      () => readLimitsSample("Limits phase"),
      monotonicNow,
      sleep,
      LIMITS_INTERVAL_MS,
    );

    const report: BenchReport = {
      version: options.version,
      sha: options.sha,
      dirty: options.dirty,
      warmupMs,
      generatedAt: wallNow().toISOString(),
      rounds: {
        cachedScan: CACHED_SCAN_ROUNDS,
        coldScan: COLD_SCAN_ROUNDS,
        limits: LIMITS_ROUNDS,
        warmupScans: 1,
        warmupLimits: 1,
      },
      phases: { cachedScan, coldScan, limits },
    };
    const fileName = `bench-${report.generatedAt.replace(/[:.]/g, "-")}-${randomUUID()}.json`;
    await mkdir(options.reportDir, { recursive: true });
    await writeReport(path.join(options.reportDir, fileName), report);
    return { report, reportDir: options.reportDir, fileName };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function measure(
  count: number,
  run: () => Promise<unknown>,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  intervalMs = 0,
): Promise<BenchPhase> {
  const samplesMs: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = now();
    await run();
    samplesMs.push(roundMs(now() - startedAt));
    if (intervalMs > 0 && index < count - 1) await sleep(intervalMs);
  }
  return { samplesMs, ...summarizeSamples(samplesMs) };
}

async function writeReport(file: string, report: BenchReport): Promise<void> {
  const temporary = `${file}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function limitsFailureReason(result: LimitsOutput, openCodeGoEnabled: boolean): string | undefined {
  if (result.hub.status !== "ok") {
    return result.hub.message ?? `The hub returned status "${result.hub.status}".`;
  }

  const hubAccounts = result.accounts.filter((account) => account.provider !== "opencode-go");
  if (hubAccounts.length === 0) {
    return "The hub returned no account limit data.";
  }
  if (hubAccounts.some((account) => account.error || account.windows.length === 0)) {
    return "The hub returned incomplete account limit data.";
  }

  if (openCodeGoEnabled) {
    if (result.openCodeGo.status !== "ok") {
      return result.openCodeGo.message ?? `OpenCode Go returned status "${result.openCodeGo.status}".`;
    }
    if (!result.accounts.some((account) => account.provider === "opencode-go" && account.windows.length > 0)) {
      return "OpenCode Go returned no limit data.";
    }
  }

  return undefined;
}

function withoutHubKey(message: string, hubKey: string): string {
  return hubKey ? message.replaceAll(hubKey, "[redacted]") : message;
}
