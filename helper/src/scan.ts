// Reads every provider's local history once and folds it into the four ranges
// the pane shows. The parse, cache, dedupe and pricing rules are T3 Code's
// (vendored under ./t3); this file is the orchestration T3 keeps in its
// Effect-based UsageService.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { UsageBucket, UsageProviderKind } from "./t3/contracts.ts";
import { UsageAggregator } from "./t3/usage/usageAggregation.ts";
import { readAntigravityUsage } from "./t3/usage/antigravityUsageReader.ts";
import { readOpenCodeUsage } from "./t3/usage/opencodeUsageReader.ts";
import type { RateTable } from "./t3/usage/usagePricing.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  makeScanCacheWriter,
  pruneScanCache,
  type CachedFile,
  type ScanCache,
} from "./t3/usage/usageScanCache.ts";
import { listTranscriptFiles, readTranscriptRecords } from "./t3/usage/usageTranscriptReader.ts";
import type { UsageRecord } from "./t3/usage/usageTranscripts.ts";
import { antigravityDirs, openCodeRoots, transcriptSources } from "./sources.ts";

export const RANGE_IDS = ["24h", "7d", "30d", "90d"] as const;
export type RangeId = (typeof RANGE_IDS)[number];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Files last written this long before a window can still hold records inside it (T3's slack). */
const MTIME_SLACK_MS = 36 * HOUR_MS;
const RETENTION_DAYS = 90;
const READ_CONCURRENCY = 4;
const CACHE_FILE = "scan-cache.json";

export interface Slice {
  costUsd: number;
  tokens: number;
}

export interface ModelRow extends Slice {
  readonly model: string;
  readonly provider: UsageProviderKind;
  unpriced: boolean;
}

export interface ProviderRow extends Slice {
  readonly provider: UsageProviderKind;
  sessions: number;
}

export interface Point extends Slice {
  /** `YYYY-MM-DD` for a day, an ISO instant for an hour. */
  readonly key: string;
  providers: Partial<Record<UsageProviderKind, Slice>>;
  models: ModelRow[];
}

export interface RangeSummary {
  readonly id: RangeId;
  readonly resolution: "day" | "hour";
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly total: {
    costUsd: number;
    tokens: number;
    cachedInput: number;
    uncachedInput: number;
    cacheWrite: number;
    output: number;
    savingsUsd: number;
    sessions: number;
    unpricedRecords: number;
  };
  readonly categoryCost: { input: number; cacheRead: number; cacheWrite: number; output: number; other: number };
  readonly speed: { standard: number; fast: number; ultrafast: number; premium: number };
  readonly providers: ProviderRow[];
  readonly models: ModelRow[];
  readonly points: Point[];
}

export interface SourceStatus {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly status: "ok" | "missing" | "partial";
  readonly files: number;
}

export interface ScanOutput {
  readonly sources: SourceStatus[];
  readonly ranges: Record<RangeId, RangeSummary>;
}

const tokensOf = (bucket: UsageBucket): number =>
  bucket.totals.uncachedInputTokens +
  bucket.totals.cachedInputTokens +
  bucket.totals.cacheCreationTokens +
  bucket.totals.outputTokens;

/** `YYYY-MM-DD` in `timeZone`, falling back to UTC for an unknown zone. */
export function dayFormatter(timeZone: string): (ms: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  return (ms) => format.format(new Date(ms));
}

/** The day `delta` days after a `YYYY-MM-DD` day. */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10);
}

interface Window {
  readonly id: RangeId;
  readonly aggregator: UsageAggregator;
  readonly sessions: Map<UsageProviderKind, Set<string>>;
  readonly keys: string[];
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly resolution: "day" | "hour";
}

function makeWindows(nowMs: number, timeZone: string, rates: RateTable): Window[] {
  const today = dayFormatter(timeZone)(nowMs);
  const windows: Window[] = [];
  for (const [id, days] of [["7d", 7], ["30d", 30], ["90d", 90]] as const) {
    const sinceDay = shiftDay(today, -(days - 1));
    const keys = Array.from({ length: days }, (_, i) => shiftDay(sinceDay, i));
    windows.push({
      id,
      aggregator: new UsageAggregator({ timeZone, sinceDay, untilDay: today, rates, resolution: "day" }),
      sessions: new Map(),
      keys,
      sinceDay,
      untilDay: today,
      resolution: "day",
    });
  }
  // Whole hours from the one 24 hours ago through the current one, so every
  // record of the past 24 hours falls inside: 25 hourly buckets.
  const untilTimeMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  const sinceTimeMs = untilTimeMs - DAY_MS - HOUR_MS;
  const toDay = dayFormatter(timeZone);
  windows.unshift({
    id: "24h",
    aggregator: new UsageAggregator({
      timeZone,
      sinceDay: toDay(sinceTimeMs),
      untilDay: today,
      rates,
      resolution: "hour",
      sinceTimeMs,
      untilTimeMs,
    }),
    sessions: new Map(),
    keys: Array.from({ length: 25 }, (_, i) => new Date(sinceTimeMs + i * HOUR_MS).toISOString()),
    sinceDay: toDay(sinceTimeMs),
    untilDay: today,
    resolution: "hour",
  });
  return windows;
}

function summarize(window: Window): RangeSummary {
  const { buckets } = window.aggregator.finish();
  const total = {
    costUsd: 0,
    tokens: 0,
    cachedInput: 0,
    uncachedInput: 0,
    cacheWrite: 0,
    output: 0,
    savingsUsd: 0,
    sessions: 0,
    unpricedRecords: 0,
  };
  const categoryCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 };
  const speed = { standard: 0, fast: 0, ultrafast: 0, premium: 0 };
  const providers = new Map<UsageProviderKind, ProviderRow>();
  const models = new Map<string, ModelRow>();
  const points = new Map<string, Point>(
    window.keys.map((key) => [key, { key, costUsd: 0, tokens: 0, providers: {}, models: [] }]),
  );

  for (const bucket of buckets) {
    const tokens = tokensOf(bucket);
    const cost = bucket.costUsd;
    total.costUsd += cost;
    total.tokens += tokens;
    total.cachedInput += bucket.totals.cachedInputTokens;
    total.uncachedInput += bucket.totals.uncachedInputTokens;
    total.cacheWrite += bucket.totals.cacheCreationTokens;
    total.output += bucket.totals.outputTokens;
    total.savingsUsd += bucket.cacheSavingsUsd;
    total.unpricedRecords += bucket.unpricedRecords;

    const split = bucket.categoryCostUsd;
    if (split) {
      categoryCost.input += split.input;
      categoryCost.cacheRead += split.cacheRead;
      categoryCost.cacheWrite += split.cacheWrite;
      categoryCost.output += split.output;
      categoryCost.other += cost - (split.input + split.cacheRead + split.cacheWrite + split.output);
    } else {
      categoryCost.other += cost;
    }
    const fast = bucket.fastCostUsd ?? 0;
    const ultrafast = bucket.ultrafastCostUsd ?? 0;
    speed.fast += fast;
    speed.ultrafast += ultrafast;
    speed.standard += cost - fast - ultrafast;
    speed.premium += bucket.speedPremiumUsd ?? 0;

    const provider = providers.get(bucket.provider) ?? { provider: bucket.provider, costUsd: 0, tokens: 0, sessions: 0 };
    provider.costUsd += cost;
    provider.tokens += tokens;
    providers.set(bucket.provider, provider);

    const modelKey = bucket.provider + "\0" + bucket.model;
    const model = models.get(modelKey) ?? { model: bucket.model, provider: bucket.provider, costUsd: 0, tokens: 0, unpriced: false };
    model.costUsd += cost;
    model.tokens += tokens;
    model.unpriced ||= bucket.costSource === "unpriced" && bucket.records === bucket.unpricedRecords;
    models.set(modelKey, model);

    const point = points.get(window.resolution === "hour" ? (bucket.hourStart ?? "") : bucket.day);
    if (point) {
      point.costUsd += cost;
      point.tokens += tokens;
      const slice = (point.providers[bucket.provider] ??= { costUsd: 0, tokens: 0 });
      slice.costUsd += cost;
      slice.tokens += tokens;
      const row = point.models.find((m) => m.provider === bucket.provider && m.model === bucket.model);
      if (row) {
        row.costUsd += cost;
        row.tokens += tokens;
      } else {
        point.models.push({ model: bucket.model, provider: bucket.provider, costUsd: cost, tokens, unpriced: false });
      }
    }
  }

  for (const [provider, ids] of window.sessions) {
    const row = providers.get(provider);
    if (row) row.sessions = ids.size;
    total.sessions += ids.size;
  }
  const byCost = <T extends Slice>(a: T, b: T) => b.costUsd - a.costUsd || b.tokens - a.tokens;
  for (const point of points.values()) point.models.sort(byCost);
  return {
    id: window.id,
    resolution: window.resolution,
    sinceDay: window.sinceDay,
    untilDay: window.untilDay,
    total,
    categoryCost,
    speed,
    providers: [...providers.values()].sort(byCost),
    models: [...models.values()].sort(byCost),
    points: [...points.values()],
  };
}

async function loadCache(file: string): Promise<ScanCache> {
  try {
    return decodeScanCache(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return new Map();
  }
}

/** Runs `task` over `items` with at most `limit` in flight, keeping input order in the result. */
async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const isWithin = (file: string, dir: string): boolean => {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** Codex sessions with records in more than one file (T3's `sharedCodexSessions`). */
function sharedCodexSessions(files: readonly { records: readonly UsageRecord[] }[]): Set<string> {
  const firstFile = new Map<string, number>();
  const shared = new Set<string>();
  files.forEach((file, index) => {
    let previous = "";
    for (const { provider, sessionId } of file.records) {
      if (provider !== "codex" || sessionId === previous || sessionId.length === 0) continue;
      previous = sessionId;
      const first = firstFile.get(sessionId);
      if (first === undefined) firstFile.set(sessionId, index);
      else if (first !== index) shared.add(sessionId);
    }
  });
  return shared;
}

export interface ScanOptions {
  readonly nowMs: number;
  readonly timeZone: string;
  readonly rates: RateTable;
  readonly cacheDir: string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function scan(options: ScanOptions): Promise<ScanOutput> {
  const { nowMs, timeZone, rates, cacheDir } = options;
  const env = options.env ?? process.env;
  const windows = makeWindows(nowMs, timeZone, rates);
  const windowStartMs = Date.parse(windows.at(-1)!.sinceDay + "T00:00:00Z") - MTIME_SLACK_MS;
  const retentionCutoffMs = nowMs - RETENTION_DAYS * DAY_MS;
  const cacheFile = path.join(cacheDir, CACHE_FILE);
  const cache = await loadCache(cacheFile);
  let cacheDirty = false;
  const sources: SourceStatus[] = [];

  const add = (provider: UsageProviderKind, dir: string, record: UsageRecord) => {
    for (const window of windows) {
      if (window.aggregator.add(record, dir) && record.sessionId.length > 0) {
        let ids = window.sessions.get(provider);
        if (!ids) window.sessions.set(provider, (ids = new Set()));
        ids.add(record.sessionId);
      }
    }
  };

  // Claude and Codex transcripts, incrementally through T3's scan cache.
  for (const { provider, dir } of transcriptSources(env)) {
    let files;
    try {
      files = await listTranscriptFiles(dir, windowStartMs);
    } catch {
      sources.push({ provider, dir, status: "missing", files: 0 });
      continue;
    }
    const read = await mapLimit(files, READ_CONCURRENCY, async (file) => {
      const cached = cache.get(file.path);
      if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs && cached.provider === provider) {
        return { path: file.path, records: [...cached.records, ...cached.tailRecords] };
      }
      const resumeFrom = cached && cached.provider === provider && file.size > cached.size ? cached.position : undefined;
      const parsed = await readTranscriptRecords(file.path, provider, resumeFrom);
      if (parsed === null) {
        return { path: file.path, records: cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : [] };
      }
      const base = parsed.resumed && cached ? cached.records : [];
      const seen = new Set<string>();
      const records = dedupeWithinFile([...base, ...parsed.records], seen);
      const tailRecords = dedupeWithinFile(parsed.tailRecords, seen);
      const entry: CachedFile = { size: file.size, mtimeMs: file.mtimeMs, provider, records, tailRecords, position: parsed.position };
      cache.set(file.path, entry);
      cacheDirty = true;
      return { path: file.path, records: [...records, ...tailRecords] };
    });
    // Usage already saved for transcripts that were since deleted still counts.
    const live = new Set(read.map((file) => file.path));
    const retainedSinceMs = Math.max(windowStartMs, retentionCutoffMs);
    for (const [filePath, entry] of cache) {
      if (entry.provider !== provider || entry.mtimeMs < retainedSinceMs || live.has(filePath) || !isWithin(filePath, dir)) continue;
      read.push({ path: filePath, records: [...entry.records, ...entry.tailRecords] });
    }
    const shared = sharedCodexSessions(read);
    for (const file of read) {
      const occurrences = new Map<string, number>();
      for (const record of file.records) {
        let usageRecord = record;
        if (record.provider === "codex" && shared.has(record.sessionId)) {
          const key = JSON.stringify([record.provider, record.sessionId, record.timestampMs, record.model, record.totals]);
          const occurrence = (occurrences.get(key) ?? 0) + 1;
          occurrences.set(key, occurrence);
          usageRecord = { ...record, dedupeKey: key + ":" + occurrence };
        }
        add(provider, dir, usageRecord);
      }
    }
    sources.push({ provider, dir, status: "ok", files: files.length });
  }

  for (const dir of openCodeRoots(env)) {
    const result = await readOpenCodeUsage(dir, windowStartMs);
    for (const file of result.files) for (const record of file.records) add("opencode", dir, record);
    sources.push({
      provider: "opencode",
      dir,
      status: result.missing && !result.error ? "missing" : result.error ? "partial" : "ok",
      files: result.files.length,
    });
  }

  const agDirs = antigravityDirs(env);
  const antigravity = await readAntigravityUsage(agDirs, windowStartMs);
  for (const file of antigravity.files) for (const record of file.records) add("antigravity", file.root, record);
  for (const dir of agDirs) {
    const files = antigravity.files.filter((file) => file.root === dir).length;
    const failed = antigravity.errors.some((error) => error === dir || error.startsWith(dir + path.sep));
    if (files > 0 || failed) sources.push({ provider: "antigravity", dir, status: failed ? "partial" : "ok", files });
  }

  if (pruneScanCache(cache, retentionCutoffMs) > 0) cacheDirty = true;
  if (cacheDirty) {
    try {
      await mkdir(cacheDir, { recursive: true });
      const temp = cacheFile + ".tmp";
      await writeFile(temp, makeScanCacheWriter()(cache, {}));
      await rename(temp, cacheFile);
    } catch {
      // A cache that cannot be written only makes the next scan slower.
    }
  }

  const ranges = Object.fromEntries(windows.map((window) => [window.id, summarize(window)])) as Record<RangeId, RangeSummary>;
  return { sources, ranges };
}
