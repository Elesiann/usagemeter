// LiteLLM's public price table, cached on disk for a day, as T3 Code does.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { parseRateTable, type RateTable } from "./t3/usage/usagePricing.ts";

export const RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export interface LoadedRates {
  readonly table: RateTable;
  /** `fresh` was fetched now, `cached` is within the TTL, `stale` is an old copy used after a failed fetch. */
  readonly status: "fresh" | "cached" | "stale" | "unavailable";
  readonly fetchedAtMs: number | null;
}

interface RatesFile {
  readonly fetchedAtMs: number;
  readonly document: unknown;
}

async function readCached(file: string): Promise<RatesFile | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<RatesFile>;
    return typeof parsed.fetchedAtMs === "number" && parsed.document !== undefined
      ? { fetchedAtMs: parsed.fetchedAtMs, document: parsed.document }
      : null;
  } catch {
    return null;
  }
}

/** Loads the rate table, refetching past the TTL and falling back to the last copy offline. */
export async function loadRates(cacheDir: string, nowMs: number, force = false): Promise<LoadedRates> {
  const file = path.join(cacheDir, "rates.json");
  const cached = await readCached(file);
  if (cached && !force && nowMs - cached.fetchedAtMs < TTL_MS) {
    return { table: parseRateTable(cached.document), status: "cached", fetchedAtMs: cached.fetchedAtMs };
  }
  try {
    const response = await fetch(RATES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const document: unknown = await response.json();
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, JSON.stringify({ fetchedAtMs: nowMs, document } satisfies RatesFile));
    return { table: parseRateTable(document), status: "fresh", fetchedAtMs: nowMs };
  } catch {
    if (cached) return { table: parseRateTable(cached.document), status: "stale", fetchedAtMs: cached.fetchedAtMs };
    return { table: new Map(), status: "unavailable", fetchedAtMs: null };
  }
}
