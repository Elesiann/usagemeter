// Plan limits from a CLIProxyAPI hub (Codex and Claude accounts) and from
// OpenCode Go, normalized the way T3 Code normalizes them
// (apps/server/src/usage/cliproxyApi.ts and provider/Layers/*UsageLimits.ts).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type WindowKind = "session" | "weekly" | "monthly" | "other";

export interface LimitWindow {
  readonly id: string;
  readonly label: string;
  readonly kind: WindowKind;
  readonly usedPercent: number;
  readonly resetsAt?: string;
  readonly windowMins?: number;
}

export interface LimitAccount {
  readonly provider: "codex" | "claude" | "antigravity" | "opencode-go";
  readonly label: string;
  readonly plan?: string;
  readonly windows: LimitWindow[];
  /** Codex rate-limit reset credits that are available now. */
  readonly resetCredits?: number;
  readonly error?: string;
}

export interface LimitsOutput {
  readonly accounts: LimitAccount[];
  readonly hub: { readonly status: "ok" | "off" | "error"; readonly message?: string; readonly restarted?: boolean };
  readonly openCodeGo: { readonly status: "ok" | "off" | "unsupported" | "error"; readonly message?: string };
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;
const HUB_TIMEOUT_MS = 15_000;
const CODEX_BASE = "https://chatgpt.com/backend-api/wham";
/**
 * Antigravity's Code Assist hosts. The daily host is the one Antigravity
 * itself and CLIProxyAPI use; paid tiers are reported to get wrong session
 * numbers from the production host, which is only the fallback.
 */
const ANTIGRAVITY_HOSTS = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];

const clamp = (value: number): number => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const kindFor = (mins: number): WindowKind => (mins >= MONTH_MINS ? "monthly" : mins >= WEEK_MINS ? "weekly" : "session");
const labelFor = (kind: WindowKind): string =>
  kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Other";
const isoFromEpochSeconds = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : undefined;
const isoFromString = (value: unknown): string | undefined =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;

/** Codex `usage` → windows. `primary`/`secondary` are positions; durations decide the kind. */
export function codexWindows(usage: unknown): LimitWindow[] {
  if (!isRecord(usage) || !isRecord(usage.rate_limit)) return [];
  const monthlyPlan = usage.plan_type === "free" || usage.plan_type === "go";
  const windows: LimitWindow[] = [];
  for (const [id, fallbackMins] of [["primary", monthlyPlan ? MONTH_MINS : SESSION_MINS], ["secondary", WEEK_MINS]] as const) {
    const raw = usage.rate_limit[`${id}_window`];
    if (!isRecord(raw) || typeof raw.used_percent !== "number") continue;
    const mins = typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds / 60 : fallbackMins;
    const kind = kindFor(mins);
    const resetsAt = isoFromEpochSeconds(raw.reset_at);
    windows.push({ id, label: labelFor(kind), kind, usedPercent: clamp(raw.used_percent), windowMins: mins, ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows;
}

/** Claude OAuth `usage` → session, weekly and model-scoped weekly windows. */
export function claudeWindows(usage: unknown): LimitWindow[] {
  if (!isRecord(usage)) return [];
  const windows: LimitWindow[] = [];
  for (const [id, kind, mins] of [["five_hour", "session", SESSION_MINS], ["seven_day", "weekly", WEEK_MINS]] as const) {
    const raw = usage[id];
    if (!isRecord(raw) || typeof raw.utilization !== "number") continue;
    const resetsAt = isoFromString(raw.resets_at);
    windows.push({ id, label: labelFor(kind), kind, usedPercent: clamp(raw.utilization), windowMins: mins, ...(resetsAt ? { resetsAt } : {}) });
  }
  for (const limit of Array.isArray(usage.limits) ? usage.limits : []) {
    if (!isRecord(limit) || limit.kind !== "weekly_scoped" || typeof limit.percent !== "number") continue;
    const model = isRecord(limit.scope) && isRecord(limit.scope.model) ? limit.scope.model.display_name : undefined;
    if (typeof model !== "string" || !model.trim()) continue;
    const resetsAt = isoFromString(limit.resets_at);
    windows.push({
      id: "seven_day_" + model.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      label: "Weekly · " + model.trim(),
      kind: "weekly",
      usedPercent: clamp(limit.percent),
      windowMins: WEEK_MINS,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

/** Codex reset credits that can be used now. */
export function availableCredits(response: unknown, nowMs: number): number {
  if (!isRecord(response) || !Array.isArray(response.credits)) return 0;
  return response.credits.filter(
    (credit) =>
      isRecord(credit) &&
      credit.reset_type === "codex_rate_limits" &&
      credit.status === "available" &&
      typeof credit.expires_at === "string" &&
      Date.parse(credit.expires_at) > nowMs,
  ).length;
}

const ANTIGRAVITY_BUCKETS: Readonly<Record<string, { label: string; kind: WindowKind; windowMins: number }>> = {
  "gemini-5h": { label: "Session · Gemini", kind: "session", windowMins: SESSION_MINS },
  "gemini-weekly": { label: "Weekly · Gemini", kind: "weekly", windowMins: WEEK_MINS },
  "3p-5h": { label: "Session · Claude + GPT", kind: "session", windowMins: SESSION_MINS },
  "3p-weekly": { label: "Weekly · Claude + GPT", kind: "weekly", windowMins: WEEK_MINS },
};

/**
 * Antigravity `retrieveUserQuotaSummary` → the 5-hour and weekly windows of
 * each model family, from `groups[].buckets[]` with a known `bucketId`.
 */
export function antigravitySummaryWindows(response: unknown): LimitWindow[] {
  if (!isRecord(response) || !Array.isArray(response.groups)) return [];
  const found = new Map<string, LimitWindow>();
  for (const group of response.groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      if (!isRecord(bucket) || typeof bucket.bucketId !== "string" || typeof bucket.remainingFraction !== "number") continue;
      const known = ANTIGRAVITY_BUCKETS[bucket.bucketId];
      if (!known) continue;
      const resetsAt = isoFromString(bucket.resetTime);
      found.set(bucket.bucketId, {
        id: bucket.bucketId,
        ...known,
        usedPercent: clamp((1 - Math.min(1, Math.max(0, bucket.remainingFraction))) * 100),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return Object.keys(ANTIGRAVITY_BUCKETS).flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
}

/** Internal or feature-specific Antigravity model ids that carry no user-facing quota. */
const excludedAntigravityModel = (id: string): boolean =>
  /^(chat_|tab_|rev_)/.test(id) || id.includes("image") || id.includes("mquery") || id.includes("lite");

/**
 * Antigravity `fetchAvailableModels` → one window per model family, as
 * Antigravity groups its quota: Gemini, and Claude with GPT. Each family shows
 * its most used member and its earliest reset. `remainingFraction` is 0..1;
 * a value above 1 is read as a percentage left.
 */
export function antigravityWindows(response: unknown): LimitWindow[] {
  if (!isRecord(response) || !isRecord(response.models)) return [];
  const families = new Map<string, { used: number; resetsAt?: string }>();
  for (const [id, info] of Object.entries(response.models)) {
    if (!isRecord(info) || !isRecord(info.quotaInfo) || excludedAntigravityModel(id)) continue;
    const quota = info.quotaInfo;
    const remaining = quota.remainingFraction;
    const used =
      typeof remaining === "number" ? clamp(remaining <= 1 ? (1 - remaining) * 100 : 100 - remaining) : quota.isExhausted === true ? 100 : null;
    if (used === null) continue;
    const name = `${id} ${typeof info.displayName === "string" ? info.displayName : ""}`.toLowerCase();
    const family = name.includes("gemini") ? "Gemini" : name.includes("claude") || name.includes("gpt") ? "Claude + GPT" : typeof info.displayName === "string" ? info.displayName : id;
    const resetsAt = isoFromString(quota.resetTime);
    const current = families.get(family);
    families.set(family, {
      used: Math.max(current?.used ?? 0, used),
      resetsAt: [current?.resetsAt, resetsAt].filter((v): v is string => !!v).sort((x, y) => Date.parse(x) - Date.parse(y))[0],
    });
  }
  return [...families.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, { used, resetsAt }]) => ({
      id: "ag_" + family.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      label: family,
      kind: "other" as const,
      usedPercent: used,
      ...(resetsAt ? { resetsAt } : {}),
    }));
}

/** OpenCode Go `usage` → rolling, weekly and monthly windows. */
export function openCodeGoWindows(response: unknown): LimitWindow[] {
  if (!isRecord(response) || !isRecord(response.usage)) return [];
  const windows: LimitWindow[] = [];
  for (const [key, kind, mins] of [["rolling", "session", SESSION_MINS], ["weekly", "weekly", WEEK_MINS], ["monthly", "monthly", undefined]] as const) {
    const raw = response.usage[key];
    if (!isRecord(raw) || typeof raw.percent !== "number") continue;
    const resetsAt = isoFromString(raw.resetsAt);
    windows.push({ id: "go_" + key, label: "Go · " + labelFor(kind), kind, usedPercent: clamp(raw.percent), ...(mins ? { windowMins: mins } : {}), ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows;
}

/** An error whose message was written here and is safe to show; anything else is described generically. */
class LimitsError extends Error {}

/**
 * The message to show for a failed read. Only messages written here pass
 * through: a JSON parser's or another library's message can quote the body it
 * was reading, and upstream bodies can carry account details.
 */
function describe(error: unknown, fallback: string): string {
  if (error instanceof LimitsError) return error.message;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return fallback + " (timed out)";
  const code = error instanceof Error && isRecord(error.cause) && typeof error.cause.code === "string" ? error.cause.code : null;
  return code && /^[A-Z_]+$/.test(code) ? `${fallback} (${code})` : fallback;
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new LimitsError(`${source} returned a response that is not JSON.`);
  }
}

interface HubConfig {
  readonly url: string;
  readonly key: string;
}

/** Spawns the hub detached; only `once("error")` and `unref()` are used. Exported for tests. */
export type HubSpawner = (command: string, args: readonly string[]) => {
  once(event: "error", listener: () => void): void;
  unref(): void;
};

export interface HubStartDeps {
  readonly autostart: boolean;
  /** Explicit binary (USAGEMETER_HUB_BIN). When set and missing, PATH is not searched. */
  readonly bin?: string;
  readonly home: string;
  readonly timeoutMs?: number;
  readonly spawn?: HubSpawner;
}

const HUB_START_TIMEOUT_MS = 15_000;
const HUB_START_POLL_MS = 250;

/** Only a hub on this machine may be started; anything else is left alone. Exported for tests. */
export function isLoopbackHub(hubUrl: string): boolean {
  let host = "";
  try {
    host = new URL(hubUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function hubBinary(deps: HubStartDeps): string | undefined {
  if (deps.bin?.trim()) return existsSync(deps.bin.trim()) ? deps.bin.trim() : undefined;
  const local = path.join(deps.home, ".local", "bin", "cli-proxy-api");
  if (existsSync(local)) return local;
  // PATH lookup: a missing binary surfaces as an async "error" event below.
  return "cli-proxy-api";
}

/** Any HTTP answer means something listens; the body is never read. */
async function hubListening(hubUrl: string, timeoutMs: number): Promise<boolean> {
  let origin = "";
  try {
    origin = new URL(hubUrl).origin;
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(origin + "/", { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, HUB_START_POLL_MS));
  }
  return false;
}

/**
 * Start a stopped local hub and wait until it answers. Best effort: false
 * means the caller reports the original connection error. Exported for tests.
 */
export async function ensureHubUp(hubUrl: string, deps: HubStartDeps): Promise<boolean> {
  if (!deps.autostart || !isLoopbackHub(hubUrl)) return false;
  const bin = hubBinary(deps);
  if (!bin) return false;
  const config = path.join(deps.home, ".cli-proxy-api", "config.yaml");
  const args = existsSync(config) ? ["-config", config] : [];
  const run: HubSpawner = deps.spawn ?? ((command, spawnArgs) => spawn(command, [...spawnArgs], { detached: true, stdio: "ignore", windowsHide: true }));
  let child: ReturnType<HubSpawner>;
  try {
    child = run(bin, args);
  } catch {
    return false;
  }
  let failed = false;
  child.once("error", () => {
    failed = true;
  });
  child.unref();
  // Let a synchronous ENOENT surface before polling for the port.
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (failed) return false;
  return hubListening(hubUrl, deps.timeoutMs ?? HUB_START_TIMEOUT_MS);
}

const connectionRefused = (error: unknown): boolean =>
  error instanceof Error && isRecord(error.cause) && (error.cause as { code?: unknown }).code === "ECONNREFUSED";

async function management(hub: HubConfig, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(`/v0/management/${route}`, hub.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${hub.key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!response.ok) throw new LimitsError(`The hub answered HTTP ${response.status}.`);
  return parseJson(await response.text(), "The hub");
}

interface AuthFile {
  readonly auth_index: unknown;
  readonly provider: string;
  readonly email?: string;
  readonly project_id?: string;
  readonly disabled?: boolean;
  readonly id_token?: { readonly chatgpt_account_id?: string; readonly chatgpt_plan_type?: string };
}

/** One upstream read through the hub's `api-call`, which substitutes the account's token for `$TOKEN$`. */
async function apiCall(hub: HubConfig, account: AuthFile, url: string, data?: unknown): Promise<unknown> {
  const header =
    account.provider === "antigravity"
      ? { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", Accept: "application/json", "User-Agent": "antigravity" }
      : account.provider === "codex"
      ? {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "OpenAI-Beta": "codex-1",
          Originator: "Codex Desktop",
          ...(account.id_token?.chatgpt_account_id ? { "Chatgpt-Account-Id": account.id_token.chatgpt_account_id } : {}),
        }
      : { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" };
  const raw = await management(hub, "api-call", {
    auth_index: account.auth_index,
    method: data === undefined ? "GET" : "POST",
    url,
    header,
    ...(data === undefined ? {} : { data: JSON.stringify(data) }),
  });
  if (!isRecord(raw) || typeof raw.status_code !== "number") throw new LimitsError("The hub returned an unexpected answer.");
  // The upstream body is never surfaced: it can carry account details.
  if (raw.status_code < 200 || raw.status_code >= 300) throw new LimitsError(`The provider refused the hub request (HTTP ${raw.status_code}).`);
  return typeof raw.body === "string" ? parseJson(raw.body, "The provider") : raw.body;
}

const planLabel = (plan: unknown): string | undefined =>
  typeof plan === "string" && plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined;

/**
 * The 5-hour and weekly windows from `retrieveUserQuotaSummary`, or, when no
 * host answers it, one window per model family from `fetchAvailableModels`.
 */
async function readAntigravity(hub: HubConfig, account: AuthFile): Promise<LimitWindow[]> {
  let lastError: unknown;
  for (const host of ANTIGRAVITY_HOSTS) {
    try {
      const windows = antigravitySummaryWindows(await apiCall(hub, account, `${host}/v1internal:retrieveUserQuotaSummary`, {}));
      if (windows.length > 0) return windows;
    } catch (error) {
      lastError = error;
    }
  }
  const body = account.project_id ? { project: account.project_id } : {};
  for (const host of ANTIGRAVITY_HOSTS) {
    try {
      return antigravityWindows(await apiCall(hub, account, `${host}/v1internal:fetchAvailableModels`, body));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function readHubAccount(hub: HubConfig, account: AuthFile, nowMs: number): Promise<LimitAccount> {
  const provider = account.provider === "codex" ? "codex" : account.provider === "antigravity" ? "antigravity" : "claude";
  const label = account.email || ({ codex: "Codex account", claude: "Claude account", antigravity: "Antigravity account" } as const)[provider];
  try {
    if (provider === "antigravity") {
      return { provider, label, windows: await readAntigravity(hub, account) };
    }
    if (provider === "claude") {
      const usage = await apiCall(hub, account, "https://api.anthropic.com/api/oauth/usage");
      return { provider, label, windows: claudeWindows(usage) };
    }
    const usage = await apiCall(hub, account, `${CODEX_BASE}/usage`);
    // A credits outage must not hide the windows that were read.
    const credits = await apiCall(hub, account, `${CODEX_BASE}/rate-limit-reset-credits`).then(
      (response) => availableCredits(response, nowMs),
      () => undefined,
    );
    const plan = planLabel(isRecord(usage) ? usage.plan_type : undefined) ?? planLabel(account.id_token?.chatgpt_plan_type);
    return { provider, label, ...(plan ? { plan } : {}), windows: codexWindows(usage), ...(credits === undefined ? {} : { resetCredits: credits }) };
  } catch (error) {
    return { provider, label, windows: [], error: describe(error, "The hub could not read this account.") };
  }
}

async function readHub(hub: HubConfig, nowMs: number, start: HubStartDeps): Promise<{ accounts: LimitAccount[]; status: LimitsOutput["hub"] }> {
  let listed: unknown;
  let restarted = false;
  try {
    listed = await management(hub, "auth-files");
  } catch (error) {
    if (connectionRefused(error) && (await ensureHubUp(hub.url, start))) {
      try {
        listed = await management(hub, "auth-files");
        restarted = true;
      } catch (retryError) {
        return { accounts: [], status: { status: "error", message: describe(retryError, "The hub could not be reached") } };
      }
    } else {
      return { accounts: [], status: { status: "error", message: describe(error, "The hub could not be reached") } };
    }
  }
  const files = isRecord(listed) && Array.isArray(listed.files) ? (listed.files as AuthFile[]) : [];
  const usable = files.filter((file) => isRecord(file) && !file.disabled && ["codex", "claude", "antigravity"].includes(file.provider));
  const accounts = await Promise.all(usable.map((file) => readHubAccount(hub, file, nowMs)));
  return { accounts, status: { status: "ok", ...(restarted ? { restarted: true as const } : {}) } };
}

async function readOpenCodeGo(env: NodeJS.ProcessEnv): Promise<{ account?: LimitAccount; status: LimitsOutput["openCodeGo"] }> {
  const dataHome = env.XDG_DATA_HOME || path.join(env.HOME?.trim() || os.homedir(), ".local", "share");
  let key = env.OPENCODE_API_KEY?.trim();
  try {
    const auth: unknown = JSON.parse(await readFile(path.join(dataHome, "opencode", "auth.json"), "utf8"));
    const entry = isRecord(auth) ? auth["opencode-go"] : undefined;
    if (isRecord(entry) && entry.type === "api" && typeof entry.key === "string" && entry.key.trim()) key = entry.key.trim();
  } catch {
    // No auth file: fall back to the environment key, if any.
  }
  if (!key) return { status: { status: "unsupported", message: "No OpenCode Go key found." } };
  try {
    const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
    // A valid Zen key can exist without a Go subscription.
    if (response.status === 403) return { status: { status: "unsupported", message: "This key has no OpenCode Go plan." } };
    if (!response.ok) throw new LimitsError(`OpenCode answered HTTP ${response.status}.`);
    const windows = openCodeGoWindows(parseJson(await response.text(), "OpenCode"));
    return { account: { provider: "opencode-go", label: "OpenCode Go", windows }, status: { status: "ok" } };
  } catch (error) {
    return { status: { status: "error", message: describe(error, "OpenCode Go could not be read") } };
  }
}

export interface LimitsOptions {
  readonly nowMs: number;
  readonly hubUrl?: string;
  readonly hubKey?: string;
  readonly openCodeGo: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /** Restart a stopped loopback hub before reading. Off unless enabled. */
  readonly hubAutostart?: boolean;
  /** Explicit hub binary (USAGEMETER_HUB_BIN). */
  readonly hubBin?: string;
  /** Test-only hub spawner. */
  readonly hubSpawn?: HubSpawner;
}

export async function readLimits(options: LimitsOptions): Promise<LimitsOutput> {
  const env = options.env ?? process.env;
  const hubUrl = options.hubUrl?.trim();
  const hubKey = options.hubKey?.trim();
  const home = env.HOME?.trim() || os.homedir();
  const [hub, go] = await Promise.all([
    hubUrl && hubKey
      ? readHub({ url: hubUrl, key: hubKey }, options.nowMs, {
          autostart: options.hubAutostart ?? false,
          ...(options.hubBin ? { bin: options.hubBin } : {}),
          home,
          ...(options.hubSpawn ? { spawn: options.hubSpawn } : {}),
        })
      : Promise.resolve({ accounts: [], status: { status: "off" as const, message: hubUrl ? "No management key configured." : undefined } }),
    options.openCodeGo ? readOpenCodeGo(env) : Promise.resolve({ status: { status: "off" as const } }),
  ]);
  return {
    accounts: [...hub.accounts, ...("account" in go && go.account ? [go.account] : [])],
    hub: hub.status,
    openCodeGo: go.status,
  };
}
