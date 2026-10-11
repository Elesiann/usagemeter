import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { runBench, summarizeSamples } from "../src/bench.ts";
import { readLimits } from "../src/limits.ts";
import { readVersionMetadata } from "../src/version.ts";

test("bench reports the median and nearest-rank p90", () => {
  assert.deepEqual(summarizeSamples([10, 1, 8, 2, 9, 3, 7, 4, 6, 5]), {
    medianMs: 5.5,
    p90Ms: 9,
  });
});

test("bench measures isolated scan caches and saves timing metadata only", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usagemeter-bench-test-"));
  const rateDirs: string[] = [];
  const scanCalls: { cacheDir: string }[] = [];
  const limitCalls: { hubUrl?: string; hubKey?: string }[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  let limitRounds = 0;

  try {
    const result = await runBench({
      reportDir: path.join(home, ".cache", "usagemeter"),
      tempDir: home,
      env: {
        HOME: home,
        USAGEMETER_HUB_URL: "http://localhost:8317",
        USAGEMETER_HUB_KEY: "test-only-value",
      },
      version: "0.2.0",
      sha: "abcdef012345",
      dirty: false,
    }, {
      loadRates: async (cacheDir) => {
        rateDirs.push(cacheDir);
        return { table: new Map(), status: "unavailable", fetchedAtMs: null };
      },
      scan: async ({ cacheDir }) => {
        scanCalls.push({ cacheDir });
        clock += 12.5;
        return { account: "sample-account", quotaPercent: 73 };
      },
      readLimits: async ({ hubUrl, hubKey }) => {
        limitCalls.push({ hubUrl, hubKey });
        limitRounds += 1;
        clock += limitRounds === 1 ? 5_000 : 12.5;
        return {
          accounts: [{
            provider: "codex",
            label: "sample-account",
            windows: [{ id: "primary", label: "Session", kind: "session", usedPercent: 73 }],
          }],
          hub: { status: "ok" },
          openCodeGo: { status: "off" },
        };
      },
      monotonicNow: () => clock,
      wallNow: () => new Date("2026-10-11T12:30:00.000Z"),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    assert.equal(scanCalls.length, 12);
    assert.equal(rateDirs.length, 12);
    assert.equal(new Set(rateDirs).size, 1);
    assert.ok(rateDirs[0]!.startsWith(home + path.sep));
    assert.equal(new Set(scanCalls.slice(0, 11).map((call) => call.cacheDir)).size, 1);
    assert.notEqual(scanCalls[0]!.cacheDir, scanCalls[11]!.cacheDir);
    assert.ok(scanCalls.every((call) => call.cacheDir.startsWith(home + path.sep)));
    assert.equal(limitCalls.length, 11);
    assert.ok(limitCalls.every((call) => call.hubUrl === "http://localhost:8317" && call.hubKey === "test-only-value"));
    assert.deepEqual(sleeps, Array(10).fill(3000));

    assert.deepEqual(result.report.rounds, { cachedScan: 10, coldScan: 1, limits: 10, warmupScans: 1, warmupLimits: 1 });
    assert.equal(result.report.warmupMs, 5_000);
    assert.equal(result.report.phases.cachedScan.medianMs, 12.5);
    assert.equal(result.report.phases.cachedScan.p90Ms, 12.5);
    assert.equal(result.report.phases.coldScan.medianMs, 12.5);
    assert.equal(result.report.phases.limits.medianMs, 12.5);
    assert.equal(result.report.phases.limits.p90Ms, 12.5);
    assert.deepEqual(result.report.phases.limits.samplesMs, Array(10).fill(12.5));

    const saved = await readFile(path.join(result.reportDir, result.fileName), "utf8");
    const document = JSON.parse(saved);
    assert.deepEqual(Object.keys(document).sort(), ["dirty", "generatedAt", "phases", "rounds", "sha", "version", "warmupMs"]);
    assert.equal(document.warmupMs, 5_000);
    const phases = document.phases as Record<string, Record<string, unknown>>;
    for (const phase of Object.values(phases)) {
      assert.deepEqual(Object.keys(phase).sort(), ["medianMs", "p90Ms", "samplesMs"]);
    }
    assert.ok(!saved.includes("sample-account"));
    assert.ok(!saved.includes("quotaPercent"));
    assert.ok(!saved.includes("usedPercent"));
    assert.ok(!saved.includes("test-only-value"));
    assert.match(result.fileName, /^bench-2026-10-11T12-30-00-000Z-[0-9a-f-]{36}\.json$/);

    const temporaryScanRoot = path.dirname(scanCalls[0]!.cacheDir);
    await assert.rejects(access(temporaryScanRoot));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("bench refuses to run without a configured hub key", async () => {
  await assert.rejects(
    runBench({
      reportDir: os.tmpdir(),
      env: { USAGEMETER_HUB_URL: "http://localhost:8317" },
      version: "0.2.0",
      sha: "abcdef012345",
      dirty: false,
    }),
    /hub URL and management key/,
  );
});

test("version and bench work without a Git checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usagemeter-version-no-git-test-"));
  try {
    await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.3" }));

    const metadata = await readVersionMetadata(root);
    assert.deepEqual(metadata, { version: "1.2.3", sha: "unknown", dirty: false });

    const result = await runBench({
      reportDir: path.join(root, "cache"),
      tempDir: root,
      env: { USAGEMETER_HUB_URL: "http://localhost:8317", USAGEMETER_HUB_KEY: "k" },
      ...metadata,
    }, {
      loadRates: async () => ({ table: new Map(), status: "unavailable", fetchedAtMs: null }),
      scan: async () => ({}),
      readLimits: async () => ({
        accounts: [{ provider: "codex", label: "sample-account", windows: [
          { id: "primary", label: "Session", kind: "session", usedPercent: 73 },
        ] }],
        hub: { status: "ok" },
        openCodeGo: { status: "off" },
      }),
      monotonicNow: (() => {
        let clock = 0;
        return () => (clock += 1);
      })(),
      wallNow: () => new Date("2026-10-11T12:30:00.000Z"),
      sleep: async () => {},
    });

    assert.equal(result.report.version, "1.2.3");
    assert.equal(result.report.sha, "unknown");
    const saved = JSON.parse(await readFile(path.join(result.reportDir, result.fileName), "utf8"));
    assert.equal(saved.sha, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bench aborts the limits phase when the hub is unreachable", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usagemeter-bench-offline-test-"));
  const reportDir = path.join(home, "reports");
  const hubKey = "test-only-value";
  let clock = 0;

  try {
    await assert.rejects(
      runBench({
        reportDir,
        tempDir: home,
        env: { USAGEMETER_HUB_URL: "http://localhost:1", USAGEMETER_HUB_KEY: hubKey },
        version: "0.2.0",
        sha: "abcdef012345",
        dirty: false,
      }, {
        loadRates: async () => ({ table: new Map(), status: "unavailable", fetchedAtMs: null }),
        scan: async () => ({}),
        readLimits: (options) => readLimits({ ...options, openCodeGo: false, env: {} }),
        monotonicNow: () => {
          clock += 1;
          return clock;
        },
        wallNow: () => new Date("2026-10-11T12:30:00.000Z"),
        sleep: async () => {},
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Limits warm-up failed:.*hub could not be reached/i);
        assert.ok(!error.message.includes(hubKey));
        return true;
      },
    );
    await assert.rejects(access(reportDir));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("bench rejects a hub response without limit data", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usagemeter-bench-empty-hub-test-"));
  const reportDir = path.join(home, "reports");
  try {
    await assert.rejects(
      runBench({
        reportDir,
        tempDir: home,
        env: { USAGEMETER_HUB_URL: "http://localhost:8317", USAGEMETER_HUB_KEY: "k" },
        version: "0.2.0",
        sha: "abcdef012345",
        dirty: false,
      }, {
        loadRates: async () => ({ table: new Map(), status: "unavailable", fetchedAtMs: null }),
        scan: async () => ({}),
        readLimits: async () => ({ accounts: [], hub: { status: "ok" }, openCodeGo: { status: "off" } }),
        monotonicNow: () => 0,
        wallNow: () => new Date("2026-10-11T12:30:00.000Z"),
        sleep: async () => {},
      }),
      /Limits warm-up failed: The hub returned no account limit data\./,
    );
    await assert.rejects(access(reportDir));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("bench rejects a failed configured OpenCode Go limits source", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usagemeter-bench-opencode-error-test-"));
  const reportDir = path.join(home, "reports");
  try {
    await assert.rejects(
      runBench({
        reportDir,
        tempDir: home,
        env: {
          USAGEMETER_HUB_URL: "http://localhost:8317",
          USAGEMETER_HUB_KEY: "k",
          USAGEMETER_OPENCODE_GO: "1",
        },
        version: "0.2.0",
        sha: "abcdef012345",
        dirty: false,
      }, {
        loadRates: async () => ({ table: new Map(), status: "unavailable", fetchedAtMs: null }),
        scan: async () => ({}),
        readLimits: async () => ({
          accounts: [{ provider: "codex", label: "sample-account", windows: [
            { id: "primary", label: "Session", kind: "session", usedPercent: 73 },
          ] }],
          hub: { status: "ok" },
          openCodeGo: { status: "error", message: "OpenCode Go could not be read." },
        }),
        monotonicNow: () => 0,
        wallNow: () => new Date("2026-10-11T12:30:00.000Z"),
        sleep: async () => {},
      }),
      /Limits warm-up failed: OpenCode Go could not be read\./,
    );
    await assert.rejects(access(reportDir));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("version metadata reports the Git commit and whether the checkout is dirty", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usagemeter-version-test-"));
  try {
    await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.3" }));
    await writeFile(path.join(root, "tracked.txt"), "initial\n");
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["-C", root, "config", "user.name", "Unit Test"]);
    execFileSync("git", ["-C", root, "config", "user.email", "unit-test@example.invalid"]);
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "initial"]);

    const clean = await readVersionMetadata(root);
    const sha = execFileSync("git", ["-C", root, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
    assert.deepEqual(clean, { version: "1.2.3", sha, dirty: false });

    await writeFile(path.join(root, "tracked.txt"), "changed\n");
    assert.deepEqual(await readVersionMetadata(root), { version: "1.2.3", sha, dirty: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
