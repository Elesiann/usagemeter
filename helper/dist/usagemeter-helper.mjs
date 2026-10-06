// usagemeter-helper (MIT). Bundles T3 Code (MIT), stream-json and stream-chain (BSD-3-Clause): see THIRD_PARTY_NOTICES.md.
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: !0,
      configurable: !0,
      set: __exportSetter.bind(all, name)
    });
};

// helper/src/main.ts
import * as os3 from "node:os";
import * as path5 from "node:path";

// helper/src/limits.ts
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
var SESSION_MINS = 300, WEEK_MINS = 10080, MONTH_MINS = 43200, HUB_TIMEOUT_MS = 15000, CODEX_BASE = "https://chatgpt.com/backend-api/wham", ANTIGRAVITY_HOSTS = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"], clamp = (value) => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)), isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value), kindFor = (mins) => mins >= MONTH_MINS ? "monthly" : mins >= WEEK_MINS ? "weekly" : "session", labelFor = (kind) => kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Other", isoFromEpochSeconds = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : void 0, isoFromString = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : void 0;
function codexWindows(usage) {
  if (!isRecord(usage) || !isRecord(usage.rate_limit))
    return [];
  let monthlyPlan = usage.plan_type === "free" || usage.plan_type === "go", windows = [];
  for (let [id, fallbackMins] of [["primary", monthlyPlan ? MONTH_MINS : SESSION_MINS], ["secondary", WEEK_MINS]]) {
    let raw = usage.rate_limit[`${id}_window`];
    if (!isRecord(raw) || typeof raw.used_percent !== "number")
      continue;
    let mins = typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds / 60 : fallbackMins, kind = kindFor(mins), resetsAt = isoFromEpochSeconds(raw.reset_at);
    windows.push({ id, label: labelFor(kind), kind, usedPercent: clamp(raw.used_percent), windowMins: mins, ...resetsAt ? { resetsAt } : {} });
  }
  return windows;
}
function claudeWindows(usage) {
  if (!isRecord(usage))
    return [];
  let windows = [];
  for (let [id, kind, mins] of [["five_hour", "session", SESSION_MINS], ["seven_day", "weekly", WEEK_MINS]]) {
    let raw = usage[id];
    if (!isRecord(raw) || typeof raw.utilization !== "number")
      continue;
    let resetsAt = isoFromString(raw.resets_at);
    windows.push({ id, label: labelFor(kind), kind, usedPercent: clamp(raw.utilization), windowMins: mins, ...resetsAt ? { resetsAt } : {} });
  }
  for (let limit of Array.isArray(usage.limits) ? usage.limits : []) {
    if (!isRecord(limit) || limit.kind !== "weekly_scoped" || typeof limit.percent !== "number")
      continue;
    let model = isRecord(limit.scope) && isRecord(limit.scope.model) ? limit.scope.model.display_name : void 0;
    if (typeof model !== "string" || !model.trim())
      continue;
    let resetsAt = isoFromString(limit.resets_at);
    windows.push({
      id: "seven_day_" + model.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      label: "Weekly · " + model.trim(),
      kind: "weekly",
      usedPercent: clamp(limit.percent),
      windowMins: WEEK_MINS,
      ...resetsAt ? { resetsAt } : {}
    });
  }
  return windows;
}
function availableCredits(response, nowMs) {
  if (!isRecord(response) || !Array.isArray(response.credits))
    return 0;
  return response.credits.filter((credit) => isRecord(credit) && credit.reset_type === "codex_rate_limits" && credit.status === "available" && typeof credit.expires_at === "string" && Date.parse(credit.expires_at) > nowMs).length;
}
var ANTIGRAVITY_BUCKETS = {
  "gemini-5h": { label: "Session · Gemini", kind: "session", windowMins: SESSION_MINS },
  "gemini-weekly": { label: "Weekly · Gemini", kind: "weekly", windowMins: WEEK_MINS },
  "3p-5h": { label: "Session · Claude + GPT", kind: "session", windowMins: SESSION_MINS },
  "3p-weekly": { label: "Weekly · Claude + GPT", kind: "weekly", windowMins: WEEK_MINS }
};
function antigravitySummaryWindows(response) {
  if (!isRecord(response) || !Array.isArray(response.groups))
    return [];
  let found = /* @__PURE__ */ new Map;
  for (let group of response.groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets))
      continue;
    for (let bucket of group.buckets) {
      if (!isRecord(bucket) || typeof bucket.bucketId !== "string" || typeof bucket.remainingFraction !== "number")
        continue;
      let known = ANTIGRAVITY_BUCKETS[bucket.bucketId];
      if (!known)
        continue;
      let resetsAt = isoFromString(bucket.resetTime);
      found.set(bucket.bucketId, {
        id: bucket.bucketId,
        ...known,
        usedPercent: clamp((1 - Math.min(1, Math.max(0, bucket.remainingFraction))) * 100),
        ...resetsAt ? { resetsAt } : {}
      });
    }
  }
  return Object.keys(ANTIGRAVITY_BUCKETS).flatMap((id) => found.has(id) ? [found.get(id)] : []);
}
var excludedAntigravityModel = (id) => /^(chat_|tab_|rev_)/.test(id) || id.includes("image") || id.includes("mquery") || id.includes("lite");
function antigravityWindows(response) {
  if (!isRecord(response) || !isRecord(response.models))
    return [];
  let families = /* @__PURE__ */ new Map;
  for (let [id, info] of Object.entries(response.models)) {
    if (!isRecord(info) || !isRecord(info.quotaInfo) || excludedAntigravityModel(id))
      continue;
    let quota = info.quotaInfo, remaining = quota.remainingFraction, used = typeof remaining === "number" ? clamp(remaining <= 1 ? (1 - remaining) * 100 : 100 - remaining) : quota.isExhausted === !0 ? 100 : null;
    if (used === null)
      continue;
    let name = `${id} ${typeof info.displayName === "string" ? info.displayName : ""}`.toLowerCase(), family = name.includes("gemini") ? "Gemini" : name.includes("claude") || name.includes("gpt") ? "Claude + GPT" : typeof info.displayName === "string" ? info.displayName : id, resetsAt = isoFromString(quota.resetTime), current = families.get(family);
    families.set(family, {
      used: Math.max(current?.used ?? 0, used),
      resetsAt: [current?.resetsAt, resetsAt].filter((v) => !!v).sort((x, y) => Date.parse(x) - Date.parse(y))[0]
    });
  }
  return [...families.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([family, { used, resetsAt }]) => ({
    id: "ag_" + family.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    label: family,
    kind: "other",
    usedPercent: used,
    ...resetsAt ? { resetsAt } : {}
  }));
}
function openCodeGoWindows(response) {
  if (!isRecord(response) || !isRecord(response.usage))
    return [];
  let windows = [];
  for (let [key, kind, mins] of [["rolling", "session", SESSION_MINS], ["weekly", "weekly", WEEK_MINS], ["monthly", "monthly", void 0]]) {
    let raw = response.usage[key];
    if (!isRecord(raw) || typeof raw.percent !== "number")
      continue;
    let resetsAt = isoFromString(raw.resetsAt);
    windows.push({ id: "go_" + key, label: "Go · " + labelFor(kind), kind, usedPercent: clamp(raw.percent), ...mins ? { windowMins: mins } : {}, ...resetsAt ? { resetsAt } : {} });
  }
  return windows;
}

class LimitsError extends Error {
}
function describe(error, fallback) {
  if (error instanceof LimitsError)
    return error.message;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return fallback + " (timed out)";
  let code = error instanceof Error && isRecord(error.cause) && typeof error.cause.code === "string" ? error.cause.code : null;
  return code && /^[A-Z_]+$/.test(code) ? `${fallback} (${code})` : fallback;
}
function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch {
    throw new LimitsError(`${source} returned a response that is not JSON.`);
  }
}
async function management(hub, route, body) {
  let response = await fetch(new URL(`/v0/management/${route}`, hub.url), {
    method: body === void 0 ? "GET" : "POST",
    headers: { Authorization: `Bearer ${hub.key}`, ...body === void 0 ? {} : { "Content-Type": "application/json" } },
    ...body === void 0 ? {} : { body: JSON.stringify(body) },
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS)
  });
  if (!response.ok)
    throw new LimitsError(`The hub answered HTTP ${response.status}.`);
  return parseJson(await response.text(), "The hub");
}
async function apiCall(hub, account, url, data) {
  let header = account.provider === "antigravity" ? { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", Accept: "application/json", "User-Agent": "antigravity" } : account.provider === "codex" ? {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "OpenAI-Beta": "codex-1",
    Originator: "Codex Desktop",
    ...account.id_token?.chatgpt_account_id ? { "Chatgpt-Account-Id": account.id_token.chatgpt_account_id } : {}
  } : { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" }, raw = await management(hub, "api-call", {
    auth_index: account.auth_index,
    method: data === void 0 ? "GET" : "POST",
    url,
    header,
    ...data === void 0 ? {} : { data: JSON.stringify(data) }
  });
  if (!isRecord(raw) || typeof raw.status_code !== "number")
    throw new LimitsError("The hub returned an unexpected answer.");
  if (raw.status_code < 200 || raw.status_code >= 300)
    throw new LimitsError(`The provider refused the hub request (HTTP ${raw.status_code}).`);
  return typeof raw.body === "string" ? parseJson(raw.body, "The provider") : raw.body;
}
var planLabel = (plan) => typeof plan === "string" && plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : void 0;
async function readAntigravity(hub, account) {
  let lastError;
  for (let host of ANTIGRAVITY_HOSTS)
    try {
      let windows = antigravitySummaryWindows(await apiCall(hub, account, `${host}/v1internal:retrieveUserQuotaSummary`, {}));
      if (windows.length > 0)
        return windows;
    } catch (error) {
      lastError = error;
    }
  let body = account.project_id ? { project: account.project_id } : {};
  for (let host of ANTIGRAVITY_HOSTS)
    try {
      return antigravityWindows(await apiCall(hub, account, `${host}/v1internal:fetchAvailableModels`, body));
    } catch (error) {
      lastError = error;
    }
  throw lastError;
}
async function readHubAccount(hub, account, nowMs) {
  let provider = account.provider === "codex" ? "codex" : account.provider === "antigravity" ? "antigravity" : "claude", label = account.email || { codex: "Codex account", claude: "Claude account", antigravity: "Antigravity account" }[provider];
  try {
    if (provider === "antigravity")
      return { provider, label, windows: await readAntigravity(hub, account) };
    if (provider === "claude") {
      let usage = await apiCall(hub, account, "https://api.anthropic.com/api/oauth/usage");
      return { provider, label, windows: claudeWindows(usage) };
    }
    let usage = await apiCall(hub, account, `${CODEX_BASE}/usage`), credits = await apiCall(hub, account, `${CODEX_BASE}/rate-limit-reset-credits`).then((response) => availableCredits(response, nowMs), () => {
      return;
    }), plan = planLabel(isRecord(usage) ? usage.plan_type : void 0) ?? planLabel(account.id_token?.chatgpt_plan_type);
    return { provider, label, ...plan ? { plan } : {}, windows: codexWindows(usage), ...credits === void 0 ? {} : { resetCredits: credits } };
  } catch (error) {
    return { provider, label, windows: [], error: describe(error, "The hub could not read this account.") };
  }
}
async function readHub(hub, nowMs) {
  let listed;
  try {
    listed = await management(hub, "auth-files");
  } catch (error) {
    return { accounts: [], status: { status: "error", message: describe(error, "The hub could not be reached") } };
  }
  let usable = (isRecord(listed) && Array.isArray(listed.files) ? listed.files : []).filter((file) => isRecord(file) && !file.disabled && ["codex", "claude", "antigravity"].includes(file.provider));
  return { accounts: await Promise.all(usable.map((file) => readHubAccount(hub, file, nowMs))), status: { status: "ok" } };
}
async function readOpenCodeGo(env) {
  let dataHome = env.XDG_DATA_HOME || path.join(env.HOME?.trim() || os.homedir(), ".local", "share"), key = env.OPENCODE_API_KEY?.trim();
  try {
    let auth = JSON.parse(await readFile(path.join(dataHome, "opencode", "auth.json"), "utf8")), entry = isRecord(auth) ? auth["opencode-go"] : void 0;
    if (isRecord(entry) && entry.type === "api" && typeof entry.key === "string" && entry.key.trim())
      key = entry.key.trim();
  } catch {}
  if (!key)
    return { status: { status: "unsupported", message: "No OpenCode Go key found." } };
  try {
    let response = await fetch("https://opencode.ai/zen/go/v1/usage", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS)
    });
    if (response.status === 403)
      return { status: { status: "unsupported", message: "This key has no OpenCode Go plan." } };
    if (!response.ok)
      throw new LimitsError(`OpenCode answered HTTP ${response.status}.`);
    return { account: { provider: "opencode-go", label: "OpenCode Go", windows: openCodeGoWindows(parseJson(await response.text(), "OpenCode")) }, status: { status: "ok" } };
  } catch (error) {
    return { status: { status: "error", message: describe(error, "OpenCode Go could not be read") } };
  }
}
async function readLimits(options) {
  let env = options.env ?? process.env, hubUrl = options.hubUrl?.trim(), hubKey = options.hubKey?.trim(), [hub, go] = await Promise.all([
    hubUrl && hubKey ? readHub({ url: hubUrl, key: hubKey }, options.nowMs) : Promise.resolve({ accounts: [], status: { status: "off", message: hubUrl ? "No management key configured." : void 0 } }),
    options.openCodeGo ? readOpenCodeGo(env) : Promise.resolve({ status: { status: "off" } })
  ]);
  return {
    accounts: [...hub.accounts, ..."account" in go && go.account ? [go.account] : []],
    hub: hub.status,
    openCodeGo: go.status
  };
}

// helper/src/rates.ts
import { mkdir, readFile as readFile2, writeFile } from "node:fs/promises";
import * as path2 from "node:path";

// helper/src/t3/usage/usagePricing.ts
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function readTokenRates(entry, suffix, standard) {
  let input = finiteNumber(entry[`input_cost_per_token${suffix}`]), output = finiteNumber(entry[`output_cost_per_token${suffix}`]);
  if (input === null || output === null)
    return null;
  let cacheRate = (name, field) => finiteNumber(entry[`${name}${suffix}`]) ?? (standard !== void 0 && standard.inputCostPerToken > 0 ? standard[field] / standard.inputCostPerToken * input : input);
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheReadCostPerToken: cacheRate("cache_read_input_token_cost", "cacheReadCostPerToken"),
    cacheCreationCostPerToken: cacheRate("cache_creation_input_token_cost", "cacheCreationCostPerToken")
  };
}
function scaleTokenRates(rates, multiple) {
  return {
    inputCostPerToken: rates.inputCostPerToken * multiple,
    outputCostPerToken: rates.outputCostPerToken * multiple,
    cacheReadCostPerToken: rates.cacheReadCostPerToken * multiple,
    cacheCreationCostPerToken: rates.cacheCreationCostPerToken * multiple
  };
}
function fastMultiplier(entry) {
  let specific = entry.provider_specific_entry;
  if (typeof specific !== "object" || specific === null)
    return null;
  let fast = finiteNumber(specific.fast);
  return fast !== null && fast > 0 ? fast : null;
}
function parseRateTable(document) {
  let table = /* @__PURE__ */ new Map;
  if (typeof document !== "object" || document === null)
    return table;
  for (let [name, raw] of Object.entries(document)) {
    if (typeof raw !== "object" || raw === null)
      continue;
    let entry = raw, standard = readTokenRates(entry, "");
    if (standard === null)
      continue;
    let key = normalizeRateKey(name);
    if (key.length === 0)
      continue;
    let multiple = fastMultiplier(entry);
    table.set(key, {
      ...standard,
      fast: multiple === null ? readTokenRates(entry, "_priority", standard) : scaleTokenRates(standard, multiple),
      ultrafast: readTokenRates(entry, "_ultrafast", standard)
    });
  }
  let aliasCandidates = /* @__PURE__ */ new Map;
  for (let [key, rate] of table) {
    let alias = bareModelName(key);
    if (alias.length === 0 || alias === key || table.has(alias))
      continue;
    let held = aliasCandidates.get(alias);
    if (held === void 0)
      aliasCandidates.set(alias, rate);
    else if (held !== null && !sameRate(held, rate))
      aliasCandidates.set(alias, null);
  }
  for (let [alias, rate] of aliasCandidates)
    if (rate !== null)
      table.set(alias, rate);
  return table;
}
function sameTokenRates(a, b) {
  if (a === null || b === null)
    return a === b;
  return a.inputCostPerToken === b.inputCostPerToken && a.outputCostPerToken === b.outputCostPerToken && a.cacheReadCostPerToken === b.cacheReadCostPerToken && a.cacheCreationCostPerToken === b.cacheCreationCostPerToken;
}
function sameRate(a, b) {
  return sameTokenRates(a, b) && sameTokenRates(a.fast, b.fast) && sameTokenRates(a.ultrafast, b.ultrafast);
}
function ratesAt(rate, speed) {
  return (speed === "standard" ? null : rate[speed]) ?? rate;
}
function normalizeRateKey(model) {
  return model.trim().toLowerCase();
}
function bareModelName(key) {
  let slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}
function stripVariantSuffix(key) {
  let bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}
var UNPRICEABLE_MODELS = /* @__PURE__ */ new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable"
]), resolvedRates = /* @__PURE__ */ new WeakMap;
function lookupRate(table, model) {
  let resolved = resolvedRates.get(table);
  if (resolved === void 0)
    resolved = /* @__PURE__ */ new Map, resolvedRates.set(table, resolved);
  let rate = resolved.get(model);
  if (rate === void 0)
    rate = resolveRate(table, model), resolved.set(model, rate);
  return rate;
}
function resolveRate(table, model) {
  let key = stripVariantSuffix(normalizeRateKey(model)), bareName = bareModelName(key);
  if (bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName))
    return null;
  return table.get(key) ?? null;
}
function costByCategory(totals, rates) {
  return {
    input: totals.uncachedInputTokens * rates.inputCostPerToken,
    cacheRead: totals.cachedInputTokens * rates.cacheReadCostPerToken,
    cacheWrite: totals.cacheCreationTokens * rates.cacheCreationCostPerToken,
    output: totals.outputTokens * rates.outputCostPerToken
  };
}
function sumCategories(cost) {
  return cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
}
function priceUsage(table, record, overrides) {
  let { model, totals, reportedCostUsd } = record, override = overrides?.get(model.trim()), reported = override === void 0 && reportedCostUsd !== null && Number.isFinite(reportedCostUsd) ? reportedCostUsd : null, unsplit = (costUsd, costSource) => ({
    costUsd,
    costSource,
    categoryCostUsd: null,
    speedPremiumUsd: 0
  }), rate = override ?? lookupRate(table, record.rateModel ?? model);
  if (rate === null)
    return reported === null ? unsplit(0, "unpriced") : unsplit(reported, "providerReported");
  let listCost = costByCategory(totals, ratesAt(rate, record.speed)), listCostUsd = sumCategories(listCost);
  if (reported !== null && listCostUsd <= 0)
    return unsplit(reported, "providerReported");
  let premiumUsd = record.speed === "standard" ? 0 : listCostUsd - sumCategories(costByCategory(totals, rate)), scale = reported === null ? 1 : reported / listCostUsd;
  return {
    costUsd: reported ?? listCostUsd,
    costSource: reported === null ? "modelPriced" : "providerReported",
    categoryCostUsd: {
      input: listCost.input * scale,
      cacheRead: listCost.cacheRead * scale,
      cacheWrite: listCost.cacheWrite * scale,
      output: listCost.output * scale
    },
    speedPremiumUsd: premiumUsd * scale
  };
}
function cacheSavingsUsd(table, record, overrides) {
  let rate = overrides?.get(record.model.trim()) ?? lookupRate(table, record.rateModel ?? record.model);
  if (rate === null)
    return 0;
  let rates = ratesAt(rate, record.speed);
  return record.totals.cachedInputTokens * (rates.inputCostPerToken - rates.cacheReadCostPerToken);
}

// helper/src/rates.ts
var RATES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json", TTL_MS = 86400000, FETCH_TIMEOUT_MS = 15000;
async function readCached(file) {
  try {
    let parsed = JSON.parse(await readFile2(file, "utf8"));
    return typeof parsed.fetchedAtMs === "number" && parsed.document !== void 0 ? { fetchedAtMs: parsed.fetchedAtMs, document: parsed.document } : null;
  } catch {
    return null;
  }
}
async function loadRates(cacheDir, nowMs, force = !1) {
  let file = path2.join(cacheDir, "rates.json"), cached = await readCached(file);
  if (cached && !force && nowMs - cached.fetchedAtMs < TTL_MS)
    return { table: parseRateTable(cached.document), status: "cached", fetchedAtMs: cached.fetchedAtMs };
  try {
    let response = await fetch(RATES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok)
      throw Error(`HTTP ${response.status}`);
    let document = await response.json();
    return await mkdir(cacheDir, { recursive: !0 }), await writeFile(file, JSON.stringify({ fetchedAtMs: nowMs, document })), { table: parseRateTable(document), status: "fresh", fetchedAtMs: nowMs };
  } catch {
    if (cached)
      return { table: parseRateTable(cached.document), status: "stale", fetchedAtMs: cached.fetchedAtMs };
    return { table: /* @__PURE__ */ new Map, status: "unavailable", fetchedAtMs: null };
  }
}

// helper/src/scan.ts
import { mkdir as mkdir2, readFile as readFile4, rename, writeFile as writeFile2 } from "node:fs/promises";
import * as path4 from "node:path";

// helper/src/t3/usage/usageTranscripts.ts
var EMPTY_TOTALS = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0
};
function int(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
function parseTimestampMs(value) {
  if (typeof value !== "string")
    return null;
  let parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
function totalTokens(totals) {
  return totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + totals.outputTokens;
}
function mightCarryUsage(line, provider) {
  if (provider === "claude")
    return line.includes('"usage"');
  if (provider === "grok")
    return line.includes('"turn_completed"');
  return line.includes('"token_count"');
}
var GROK_COST_USD_TICKS_PER_DOLLAR = 10000000000;
function grokCostTicksToUsd(ticks) {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0)
    return null;
  return ticks / GROK_COST_USD_TICKS_PER_DOLLAR;
}
function parseClaudeLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseClaudeRecord(parsed);
}
function parseClaudeRecord(parsed) {
  if (typeof parsed !== "object" || parsed === null)
    return null;
  let record = parsed;
  if (record.type !== "assistant")
    return null;
  let message = record.message;
  if (typeof message !== "object" || message === null)
    return null;
  let messageRecord = message, usage = messageRecord.usage;
  if (typeof usage !== "object" || usage === null)
    return null;
  let usageRecord = usage, timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null)
    return null;
  let model = typeof messageRecord.model === "string" ? messageRecord.model : "";
  if (model.length === 0)
    return null;
  let messageId = typeof messageRecord.id === "string" ? messageRecord.id : null, requestId = typeof record.requestId === "string" ? record.requestId : null, dedupeKey = messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`, cost = record.costUSD;
  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
    totals: {
      uncachedInputTokens: int(usageRecord.input_tokens),
      cachedInputTokens: int(usageRecord.cache_read_input_tokens),
      cacheCreationTokens: int(usageRecord.cache_creation_input_tokens),
      outputTokens: int(usageRecord.output_tokens),
      reasoningTokens: 0
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord.speed === "fast" ? "fast" : "standard",
    dedupeKey
  };
}
function initialCodexScanState() {
  return {
    model: "",
    speed: "standard",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: !1,
    suppressingForkCopies: !1,
    forkCopyAnchorMs: 0
  };
}
var FORK_COPY_MAX_GAP_MS = 1000;
function isForkedSessionMeta(payload) {
  if (typeof payload.forked_from_id === "string")
    return !0;
  let source = payload.source;
  if (typeof source !== "object" || source === null)
    return !1;
  let subagent = source.subagent;
  if (typeof subagent !== "object" || subagent === null)
    return !1;
  let spawn = subagent.thread_spawn;
  if (typeof spawn !== "object" || spawn === null)
    return !1;
  return typeof spawn.parent_thread_id === "string";
}
function parseCodexLine(line, state) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseCodexRecord(parsed, state);
}
function parseCodexRecord(parsed, state) {
  if (typeof parsed !== "object" || parsed === null)
    return null;
  let record = parsed, payload = record.payload;
  if (typeof payload !== "object" || payload === null)
    return null;
  let payloadRecord = payload, payloadType = payloadRecord.type;
  if (record.type === "session_meta") {
    if (state.sawSessionMeta)
      return null;
    state.sawSessionMeta = !0;
    let id = payloadRecord.id ?? payloadRecord.session_id;
    if (typeof id === "string")
      state.sessionId = id;
    let metaTimestampMs = parseTimestampMs(record.timestamp);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord))
      state.suppressingForkCopies = !0, state.forkCopyAnchorMs = metaTimestampMs;
    return null;
  }
  if (record.type === "turn_context") {
    if (typeof payloadRecord.model === "string")
      state.model = payloadRecord.model;
    return null;
  }
  if (payloadType === "thread_settings_applied") {
    let settings = payloadRecord.thread_settings;
    if (typeof settings === "object" && settings !== null)
      state.speed = codexSpeed(settings.service_tier);
    return null;
  }
  if (payloadType !== "token_count")
    return null;
  let info = payloadRecord.info;
  if (typeof info !== "object" || info === null)
    return null;
  let last = info.last_token_usage;
  if (typeof last !== "object" || last === null)
    return null;
  let lastRecord = last, timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null)
    return null;
  if (state.model.length === 0)
    return null;
  let signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature)
    return null;
  if (state.lastUsageSignature = signature, state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS)
      return state.forkCopyAnchorMs = timestampMs, null;
    state.suppressingForkCopies = !1;
  }
  let inputTokens = int(lastRecord.input_tokens), cachedInputTokens = int(lastRecord.cached_input_tokens), cacheCreationTokens = int(lastRecord.cache_write_input_tokens), outputTokens = int(lastRecord.output_tokens), totals = {
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, int(lastRecord.reasoning_output_tokens))
  };
  if (totalTokens(totals) === 0)
    return null;
  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    reportedCostUsd: null,
    speed: state.speed,
    dedupeKey: null
  };
}
function codexSpeed(serviceTier) {
  if (serviceTier === "priority" || serviceTier === "fast")
    return "fast";
  if (serviceTier === "ultrafast")
    return "ultrafast";
  return "standard";
}
function readGrokUsageTotals(value) {
  if (typeof value !== "object" || value === null)
    return null;
  let record = value;
  return {
    inputTokens: int(record.inputTokens),
    outputTokens: int(record.outputTokens),
    cachedReadTokens: int(record.cachedReadTokens),
    cacheCreationTokens: int(record.cacheCreationTokens),
    reasoningTokens: int(record.reasoningTokens),
    costUsdTicks: typeof record.costUsdTicks === "number" && Number.isFinite(record.costUsdTicks) ? record.costUsdTicks : null
  };
}
function grokTotalsToUsage(totals) {
  let { cachedReadTokens: cachedInputTokens, cacheCreationTokens } = totals, uncachedInputTokens = Math.max(0, totals.inputTokens - cachedInputTokens - cacheCreationTokens), outputTokens = totals.outputTokens;
  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, totals.reasoningTokens)
  };
}
function parseGrokLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return parseGrokRecord(parsed);
}
function parseGrokRecord(parsed) {
  if (typeof parsed !== "object" || parsed === null)
    return [];
  let record = parsed, params = record.params;
  if (typeof params !== "object" || params === null)
    return [];
  let paramsRecord = params, update = paramsRecord.update;
  if (typeof update !== "object" || update === null)
    return [];
  let updateRecord = update;
  if (updateRecord.sessionUpdate !== "turn_completed")
    return [];
  let usage = updateRecord.usage;
  if (typeof usage !== "object" || usage === null)
    return [];
  let usageRecord = usage, sessionId = typeof paramsRecord.sessionId === "string" ? paramsRecord.sessionId : "", promptId = typeof updateRecord.prompt_id === "string" ? updateRecord.prompt_id : null, meta = paramsRecord._meta, timestampMs = null;
  if (typeof meta === "object" && meta !== null) {
    let agentTimestampMs = meta.agentTimestampMs;
    if (typeof agentTimestampMs === "number" && Number.isFinite(agentTimestampMs))
      timestampMs = agentTimestampMs;
  }
  if (timestampMs === null) {
    let timestamp = record.timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp))
      timestampMs = timestamp > 1000000000000 ? timestamp : timestamp * 1000;
  }
  if (timestampMs === null)
    return [];
  let topLevel = readGrokUsageTotals(usageRecord);
  if (topLevel === null)
    return [];
  let modelUsage = usageRecord.modelUsage, modelEntries = [];
  if (typeof modelUsage === "object" && modelUsage !== null)
    for (let [model, raw] of Object.entries(modelUsage)) {
      if (model.length === 0)
        continue;
      let totals = readGrokUsageTotals(raw);
      if (totals === null)
        continue;
      modelEntries.push({ model, totals });
    }
  if (modelEntries.length === 0) {
    if (totalTokens(grokTotalsToUsage(topLevel)) === 0)
      return [];
    return [
      {
        provider: "grok",
        timestampMs,
        model: "grok",
        sessionId,
        totals: grokTotalsToUsage(topLevel),
        reportedCostUsd: grokCostTicksToUsd(topLevel.costUsdTicks),
        speed: "standard",
        dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:grok`
      }
    ];
  }
  let topLevelCostUsd = grokCostTicksToUsd(topLevel.costUsdTicks), usedTickedCostUsd = 0, untickedTokenDenominator = 0;
  for (let entry of modelEntries) {
    let tokens = totalTokens(grokTotalsToUsage(entry.totals));
    if (tokens === 0)
      continue;
    if (entry.totals.costUsdTicks !== null)
      usedTickedCostUsd += grokCostTicksToUsd(entry.totals.costUsdTicks) ?? 0;
    else
      untickedTokenDenominator += tokens;
  }
  let remainingCostUsd = topLevelCostUsd === null ? null : Math.max(0, topLevelCostUsd - usedTickedCostUsd), results = [];
  for (let entry of modelEntries) {
    let totals = grokTotalsToUsage(entry.totals);
    if (totalTokens(totals) === 0)
      continue;
    let reportedCostUsd = grokCostTicksToUsd(entry.totals.costUsdTicks);
    if (reportedCostUsd === null && remainingCostUsd !== null && untickedTokenDenominator > 0)
      reportedCostUsd = remainingCostUsd * (totalTokens(totals) / untickedTokenDenominator);
    results.push({
      provider: "grok",
      timestampMs,
      model: entry.model,
      sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:${entry.model}`
    });
  }
  return results;
}

// helper/src/t3/usage/usageAggregation.ts
function makeDayFormatter(timeZone) {
  let format;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
  }
  let days = /* @__PURE__ */ new Map;
  return (timestampMs) => {
    let slot = Math.floor(timestampMs / QUARTER_HOUR_MS), day = days.get(slot);
    if (day === void 0) {
      let first = format.format(new Date(slot * QUARTER_HOUR_MS)), last = format.format(new Date((slot + 1) * QUARTER_HOUR_MS - 1));
      day = first === last ? first : null, days.set(slot, day);
    }
    return day ?? format.format(new Date(timestampMs));
  };
}
var QUARTER_HOUR_MS = 900000, HOUR_MS = 3600000;
class UsageAggregator {
  #buckets = /* @__PURE__ */ new Map;
  #seen = /* @__PURE__ */ new Set;
  #toDay;
  #hourlyWindow;
  #options;
  #lastBucket = null;
  #duplicatesDropped = 0;
  #outOfWindow = 0;
  constructor(options) {
    if (this.#options = options, this.#toDay = makeDayFormatter(options.timeZone), options.resolution === "hour") {
      if (options.sinceTimeMs === void 0 || options.untilTimeMs === void 0)
        throw Error("Hourly usage aggregation requires exact time bounds");
      this.#hourlyWindow = {
        sinceTimeMs: options.sinceTimeMs,
        untilTimeMs: options.untilTimeMs
      };
    } else
      this.#hourlyWindow = null;
  }
  add(input, sourcePath) {
    let record = this.#mapModel(input);
    if (record.dedupeKey !== null) {
      if (this.#seen.has(record.dedupeKey))
        return this.#duplicatesDropped += 1, !1;
      this.#seen.add(record.dedupeKey);
    }
    if (this.#hourlyWindow !== null && (record.timestampMs < this.#hourlyWindow.sinceTimeMs || record.timestampMs >= this.#hourlyWindow.untilTimeMs))
      return this.#outOfWindow += 1, !1;
    let day = this.#toDay(record.timestampMs);
    if (this.#hourlyWindow === null && (day < this.#options.sinceDay || day > this.#options.untilDay))
      return this.#outOfWindow += 1, !1;
    let hourIndex = this.#hourlyWindow === null ? -1 : Math.floor((record.timestampMs - this.#hourlyWindow.sinceTimeMs) / HOUR_MS), bucket = this.#bucketFor(day, hourIndex, record.provider, record.model, sourcePath ?? ""), priced = priceUsage(this.#options.rates, record, this.#options.priceOverrides), totals = bucket.totals;
    if (totals.uncachedInputTokens += record.totals.uncachedInputTokens, totals.cachedInputTokens += record.totals.cachedInputTokens, totals.cacheCreationTokens += record.totals.cacheCreationTokens, totals.outputTokens += record.totals.outputTokens, totals.reasoningTokens += record.totals.reasoningTokens, bucket.costUsd += priced.costUsd, priced.categoryCostUsd !== null) {
      let sum = bucket.categoryCostUsd, add = priced.categoryCostUsd;
      bucket.categoryCostUsd = sum === null ? add : {
        input: sum.input + add.input,
        cacheRead: sum.cacheRead + add.cacheRead,
        cacheWrite: sum.cacheWrite + add.cacheWrite,
        output: sum.output + add.output
      };
    }
    if (record.speed === "fast")
      bucket.fastCostUsd += priced.costUsd;
    if (record.speed === "ultrafast")
      bucket.ultrafastCostUsd += priced.costUsd;
    if (bucket.speedPremiumUsd += priced.speedPremiumUsd, bucket.cacheSavingsUsd += cacheSavingsUsd(this.#options.rates, record, this.#options.priceOverrides), bucket.records += 1, priced.costSource === "unpriced")
      bucket.unpricedRecords += 1;
    if (priced.costSource === "providerReported")
      bucket.providerReportedRecords += 1;
    if (record.sessionId.length > 0)
      bucket.sessions.add(record.sessionId);
    return !0;
  }
  #mapModel(record) {
    let model = this.#options.modelAliases?.get(record.model);
    if (model === void 0)
      return record;
    let { rateModel: _rateModel, ...rest } = record;
    return { ...rest, model };
  }
  #bucketFor(day, hourIndex, provider, model, source) {
    let last = this.#lastBucket;
    if (last !== null && last.day === day && last.hourIndex === hourIndex && last.provider === provider && last.model === model && last.source === source)
      return last.bucket;
    let window = this.#hourlyWindow, hourStart = window === null ? "" : new Date(window.sinceTimeMs + hourIndex * HOUR_MS).toISOString(), key = `${day}\x00${hourStart}\x00${provider}\x00${model}\x00${source}`, bucket = this.#buckets.get(key);
    if (bucket === void 0)
      bucket = {
        totals: { ...EMPTY_TOTALS },
        costUsd: 0,
        cacheSavingsUsd: 0,
        categoryCostUsd: null,
        fastCostUsd: 0,
        ultrafastCostUsd: 0,
        speedPremiumUsd: 0,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: /* @__PURE__ */ new Set
      }, this.#buckets.set(key, bucket);
    return this.#lastBucket = { day, hourIndex, provider, model, source, bucket }, bucket;
  }
  finish() {
    let buckets = [];
    for (let [key, bucket] of this.#buckets) {
      let [day = "", hourStart = "", provider = "", model = "", sourcePath = ""] = key.split("\x00"), category = bucket.categoryCostUsd, fastCostUsd = roundUsd(bucket.fastCostUsd), ultrafastCostUsd = roundUsd(bucket.ultrafastCostUsd), speedPremiumUsd = roundUsd(bucket.speedPremiumUsd);
      buckets.push({
        day,
        ...hourStart === "" ? {} : { hourStart },
        provider,
        model,
        ...sourcePath === "" ? {} : { sourcePath },
        totals: { ...bucket.totals },
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        ...category === null ? {} : {
          categoryCostUsd: {
            input: roundUsd(category.input),
            cacheRead: roundUsd(category.cacheRead),
            cacheWrite: roundUsd(category.cacheWrite),
            output: roundUsd(category.output)
          }
        },
        ...fastCostUsd === 0 ? {} : { fastCostUsd },
        ...ultrafastCostUsd === 0 ? {} : { ultrafastCostUsd },
        ...speedPremiumUsd === 0 ? {} : { speedPremiumUsd },
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        sessions: bucket.sessions.size
      });
    }
    return buckets.sort((a, b) => a.day.localeCompare(b.day) || (a.hourStart ?? "").localeCompare(b.hourStart ?? "") || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)), {
      buckets,
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow: this.#outOfWindow
    };
  }
}
function roundUsd(value) {
  return Math.round(value * 1e6) / 1e6;
}
function resolveCostSource(bucket) {
  if (bucket.unpricedRecords === bucket.records)
    return "unpriced";
  if (bucket.providerReportedRecords === bucket.records)
    return "providerReported";
  return "modelPriced";
}

// helper/src/t3/usage/antigravityUsageReader.ts
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";
function fields(bytes) {
  let offset = 0, result = /* @__PURE__ */ new Map, varint = () => {
    let value = 0n;
    for (let shift = 0n;shift < 70n; shift += 7n) {
      let byte = bytes[offset++];
      if (byte === void 0 || shift === 63n && byte > 1)
        throw Error("Invalid Antigravity protobuf varint");
      if (value |= BigInt(byte & 127) << shift, byte < 128)
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
    }
    throw Error("Invalid Antigravity protobuf varint");
  };
  while (offset < bytes.length) {
    let tag = varint();
    if (typeof tag !== "number")
      throw Error("Invalid protobuf field");
    let number = Math.floor(tag / 8), wire = tag % 8;
    if (number === 0)
      throw Error("Invalid protobuf field");
    let value;
    if (wire === 0)
      value = varint();
    else if (wire === 1 || wire === 5 || wire === 2) {
      let length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number")
        throw Error("Invalid protobuf field length");
      if (length > bytes.length - offset)
        throw Error("Truncated protobuf field");
      if (value = bytes.subarray(offset, offset + length), offset += length, wire !== 2)
        continue;
    } else
      throw Error("Unsupported protobuf wire type");
    let entries = result.get(number) ?? [];
    entries.push(value), result.set(number, entries);
  }
  return result;
}
var numberAt = (value, key) => {
  let entry = value.get(key)?.[0];
  return typeof entry === "number" ? entry : 0;
}, bytesAt = (value, key) => {
  let entry = value.get(key)?.[0];
  return entry instanceof Uint8Array ? entry : void 0;
}, nested = (value, key) => {
  let bytes = bytesAt(value, key);
  return bytes === void 0 ? /* @__PURE__ */ new Map : fields(bytes);
}, textAt = (value, key) => {
  let bytes = bytesAt(value, key);
  return bytes === void 0 ? "" : new TextDecoder("utf-8", { fatal: !0 }).decode(bytes).trim();
}, timestamp = (value) => {
  let seconds = numberAt(value, 1);
  return seconds > 0 ? seconds * 1000 + Math.floor(numberAt(value, 2) / 1e6) : null;
}, MODEL_IDS = {
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-sonnet-4",
  282: "claude-sonnet-4",
  290: "claude-opus-4",
  291: "claude-opus-4",
  333: "claude-sonnet-4-5",
  334: "claude-sonnet-4-5",
  340: "claude-haiku-4-5",
  341: "claude-haiku-4-5",
  1026: "claude-opus-4-6",
  1035: "claude-sonnet-4-6",
  1016: "gemini-3.1-pro",
  1036: "gemini-3.1-pro",
  1037: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview",
  1084: "gemini-3-flash-preview",
  1047: "gemini-3-flash-preview"
};
function modelName(name, id) {
  if (name) {
    let normalized = name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").replaceAll(" ", "-");
    if (normalized.startsWith("claude-"))
      return normalized.replace(/^claude-(4(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1").replaceAll(".", "-");
    return normalized;
  }
  return MODEL_IDS[id] ?? (id > 0 ? `antigravity-model-${id}` : "");
}
function metadata(bytes, step) {
  let root = fields(bytes);
  if (!step && bytesAt(root, 1) === void 0)
    throw Error("Missing Antigravity generation metadata");
  let data = step ? root : nested(root, 1), model = step ? nested(data, 24) : data, usage = bytesAt(data, step ? 9 : 4), usages = usage === void 0 ? [] : [fields(usage)];
  for (let retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array))
      throw Error("Invalid retry metadata");
    let retryUsage = bytesAt(fields(retry), 2);
    if (retryUsage !== void 0)
      usages.push(fields(retryUsage));
  }
  return {
    model: modelName(textAt(model, step ? 12 : 19) || textAt(model, step ? 8 : 21), numberAt(model, step ? 1 : 3)),
    timestampMs: step ? timestamp(nested(data, 8)) ?? timestamp(nested(data, 1)) : timestamp(nested(nested(data, 9), 4)),
    usages
  };
}
function blob(value) {
  if (!(value instanceof Uint8Array))
    throw Error("Invalid Antigravity metadata blob");
  return value;
}
async function readDatabase(path, fallbackTimestamp) {
  let db = new NodeSqlite.DatabaseSync(path, { readOnly: !0 });
  try {
    db.exec("PRAGMA busy_timeout = 100; BEGIN");
    let tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has("gen_metadata") && !tables.has("steps"))
      throw Error("Missing Antigravity usage tables");
    let readMetadata = async (query, column, step) => {
      let entries = [];
      for (let row of db.prepare(query).iterate()) {
        if (typeof row.idx !== "number")
          throw Error("Invalid Antigravity metadata index");
        if (entries.push({ idx: row.idx, entry: metadata(blob(row[column]), step) }), entries.length % 256 === 0)
          await NodeTimersPromises.setImmediate();
      }
      return entries;
    }, generations = tables.has("gen_metadata") ? await readMetadata("SELECT idx, data FROM gen_metadata ORDER BY idx", "data", !1) : [], trajectoryTimestamp = null;
    if (tables.has("trajectory_metadata_blob"))
      for (let row of db.prepare("SELECT data FROM trajectory_metadata_blob").iterate())
        trajectoryTimestamp ??= timestamp(nested(fields(blob(row.data)), 2));
    let steps = tables.has("steps") ? await readMetadata("SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx", "metadata", !0) : [], sessionId = NodePath.basename(path, ".db"), records = [], generationModels = new Map(generations.map(({ idx, entry }) => [idx, entry.model]));
    for (let [source, entries] of [
      ["step", steps],
      ["generation", generations]
    ])
      for (let [index, { idx, entry }] of entries.entries())
        for (let [usageIndex, usage] of entry.usages.entries()) {
          let outputTokens = Math.max(numberAt(usage, 3), numberAt(usage, 9) + numberAt(usage, 10)), totals = {
            uncachedInputTokens: numberAt(usage, 2),
            cachedInputTokens: numberAt(usage, 5),
            cacheCreationTokens: numberAt(usage, 4),
            outputTokens,
            reasoningTokens: Math.min(outputTokens, numberAt(usage, 9))
          };
          if (totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + outputTokens === 0)
            continue;
          let keys = [11, 12, 7].flatMap((key) => {
            let id = textAt(usage, key);
            return id ? [`antigravity:${key}:${id}`] : [];
          }), record = {
            provider: "antigravity",
            sessionId,
            timestampMs: entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp,
            model: MODEL_IDS[numberAt(usage, 1)] || entry.model || (source === "step" ? generationModels.get(idx) : "") || modelName("", numberAt(usage, 1)) || "antigravity-unknown",
            totals,
            reportedCostUsd: null,
            speed: "standard",
            dedupeKey: keys[0] ?? `antigravity:${sessionId}:${source}:${index}:${usageIndex}`
          };
          records.push({
            record,
            keys,
            timestampQuality: entry.timestampMs !== null ? 2 : trajectoryTimestamp !== null ? 1 : 0
          });
        }
    return records;
  } finally {
    db.close();
  }
}
async function readAntigravityUsage(conversationsDirectories, sinceMs) {
  let roots = typeof conversationsDirectories === "string" ? [conversationsDirectories] : conversationsDirectories, files = [], errors = [], identities = /* @__PURE__ */ new Map, groups = [], find = (index) => {
    let root = index;
    while (groups[root].parent !== root)
      root = groups[root].parent;
    while (index !== root) {
      let parent = groups[index].parent;
      groups[index].parent = root, index = parent;
    }
    return root;
  }, merge = (left, right) => {
    let a = find(left), b = find(right);
    if (a === b)
      return a;
    if (groups[a].size < groups[b].size)
      [a, b] = [b, a];
    let target = groups[a], source = groups[b], first = target.owner < source.owner ? target : source, bestTime = source.timestampQuality > target.timestampQuality || source.timestampQuality === target.timestampQuality && source.record.timestampMs < target.record.timestampMs ? source : target, x = target.record.totals, y = source.record.totals;
    return target.record = {
      ...first.record,
      model: first.record.model === "antigravity-unknown" ? first === target ? source.record.model : target.record.model : first.record.model,
      timestampMs: bestTime.record.timestampMs,
      totals: {
        uncachedInputTokens: Math.max(x.uncachedInputTokens, y.uncachedInputTokens),
        cachedInputTokens: Math.max(x.cachedInputTokens, y.cachedInputTokens),
        cacheCreationTokens: Math.max(x.cacheCreationTokens, y.cacheCreationTokens),
        outputTokens: Math.max(x.outputTokens, y.outputTokens),
        reasoningTokens: Math.max(x.reasoningTokens, y.reasoningTokens)
      }
    }, target.timestampQuality = bestTime.timestampQuality, target.owner = first.owner, target.fileIndex = first.fileIndex, target.size += source.size, source.parent = a, a;
  }, append = (candidate, fileIndex) => {
    let index = groups.length;
    groups.push({ ...candidate, parent: index, size: 1, owner: index, fileIndex });
    for (let key of candidate.keys) {
      let existing = identities.get(key);
      if (existing !== void 0)
        merge(index, existing);
      identities.set(key, index);
    }
  }, visited = /* @__PURE__ */ new Set, walk = async (directory, root) => {
    let entries;
    try {
      entries = await NodeFSP.readdir(directory, { withFileTypes: !0 });
    } catch (error) {
      if (error.code !== "ENOENT")
        errors.push(directory);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let entry of entries) {
      let path = NodePath.join(directory, entry.name);
      if (entry.isDirectory())
        await walk(path, root);
      else if (entry.isFile() && entry.name.endsWith(".db"))
        try {
          let canonical = await NodeFSP.realpath(path);
          if (visited.has(canonical))
            continue;
          visited.add(canonical);
          let stat2 = await NodeFSP.stat(path), candidates = await readDatabase(path, stat2.mtimeMs), fileIndex = files.length;
          files.push({ root, path, records: [] });
          for (let [index, candidate] of candidates.entries())
            if (append(candidate, fileIndex), index % 256 === 255)
              await NodeTimersPromises.setImmediate();
        } catch {
          errors.push(path);
        }
    }
  };
  for (let root of roots)
    await walk(root, root);
  for (let [index, group] of groups.entries())
    if (group.parent === index && group.record.timestampMs >= sinceMs)
      files[group.fileIndex].records.push(group.record);
  return { files, errors };
}

// helper/src/t3/usage/opencodeUsageReader.ts
import * as NodeFSP2 from "node:fs/promises";
import * as NodePath2 from "node:path";
import * as NodeSqlite2 from "node:sqlite";
import * as NodeTimersPromises2 from "node:timers/promises";
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function tokens(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
function text(value) {
  return typeof value === "string" ? value : "";
}
function parseOpenCodeMessage(source, fallback = {}) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  let message = object(parsed);
  if (message.role !== void 0 && message.role !== "assistant")
    return null;
  let usage = object(message.tokens), cache = object(usage.cache), modelReference = object(message.model), model = text(modelReference.id) || text(modelReference.modelID) || text(message.modelID), timestampMs = object(message.time).created ?? fallback.timestampMs;
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs))
    return null;
  let reasoningTokens = tokens(usage.reasoning), totals = {
    uncachedInputTokens: tokens(usage.input),
    cachedInputTokens: tokens(cache.read),
    cacheCreationTokens: tokens(cache.write),
    outputTokens: tokens(usage.output) + reasoningTokens,
    reasoningTokens
  };
  if (totalTokens(totals) === 0)
    return null;
  let id = fallback.id || text(message.id), cost = message.cost;
  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: fallback.sessionId || text(message.sessionID),
    totals,
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null,
    speed: "standard",
    dedupeKey: id ? `opencode:${id}` : null
  };
}
async function readOpenCodeUsage(root, sinceMs) {
  let files = [], seen = /* @__PURE__ */ new Set, found = !1, error = !1, append = (records, record) => {
    if (record === null || record.timestampMs < sinceMs)
      return;
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey))
        return;
      seen.add(record.dedupeKey);
    }
    records.push(record);
  }, databases = [];
  try {
    databases = (await NodeFSP2.readdir(root, { withFileTypes: !0 })).filter((entry) => entry.isFile() && /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(entry.name)).map((entry) => entry.name).sort((a, b) => a === "opencode.db" ? -1 : b === "opencode.db" ? 1 : a.localeCompare(b));
  } catch (cause) {
    if (object(cause).code !== "ENOENT")
      error = !0;
  }
  for (let name of databases) {
    found = !0;
    let file = { path: NodePath2.join(root, name), records: [] };
    files.push(file);
    let database;
    try {
      database = new NodeSqlite2.DatabaseSync(NodePath2.join(root, name), { readOnly: !0 }), database.exec("PRAGMA busy_timeout = 100");
      let tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
      if (!tables.has("message") && !tables.has("session_message"))
        error = !0;
      for (let table of ["message", "session_message"]) {
        if (!tables.has(table))
          continue;
        let timestamp = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)).has("time_created") ? "time_created" : "NULL", predicates = table === "session_message" ? ["type = 'assistant'"] : [];
        if (timestamp !== "NULL")
          predicates.push("time_created >= ?");
        let where = predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : "", statement = database.prepare(`SELECT id, session_id, data, ${timestamp} AS created FROM ${table}${where}`), count = 0;
        for (let row of statement.iterate(...timestamp === "NULL" ? [] : [sinceMs]))
          if (append(file.records, parseOpenCodeMessage(text(row.data), {
            id: text(row.id),
            sessionId: text(row.session_id),
            ...typeof row.created === "number" ? { timestampMs: row.created } : {}
          })), ++count % 256 === 0)
            await NodeTimersPromises2.setImmediate();
      }
    } catch {
      error = !0;
    } finally {
      database?.close();
    }
  }
  let directories = [NodePath2.join(root, "storage", "message")];
  while (directories.length > 0) {
    let directory = directories.pop();
    try {
      for (let entry of await NodeFSP2.readdir(directory, { withFileTypes: !0 })) {
        let path = NodePath2.join(directory, entry.name);
        if (entry.isDirectory())
          directories.push(path);
        else if (entry.isFile() && entry.name.endsWith(".json")) {
          found = !0;
          let id = entry.name.slice(0, -5);
          if (seen.has(`opencode:${id}`))
            continue;
          let file = { path, records: [] };
          files.push(file);
          try {
            append(file.records, parseOpenCodeMessage(await NodeFSP2.readFile(path, "utf8"), { id }));
          } catch (cause) {
            if (object(cause).code !== "ENOENT")
              error = !0;
          }
        }
      }
    } catch (cause) {
      if (object(cause).code !== "ENOENT")
        error = !0;
    }
  }
  return { files, missing: !found && !error, error };
}

// helper/src/t3/usage/usageTranscriptReader.ts
import * as NodeFSP3 from "node:fs/promises";
import * as NodePath3 from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

// node_modules/stream-chain/src/defs.js
var none = Symbol.for("object-stream.none"), stop = Symbol.for("object-stream.stop"), finalSymbol = Symbol.for("object-stream.final"), manySymbol = Symbol.for("object-stream.many"), flushSymbol = Symbol.for("object-stream.flush"), fListSymbol = Symbol.for("object-stream.fList"), finalValue = (value) => ({ [finalSymbol]: 1, value }), many = (values) => ({ [manySymbol]: 1, values }), isFinalValue = (o) => o && o[finalSymbol] === 1, isMany = (o) => o && o[manySymbol] === 1, isFlushable = (o) => o && o[flushSymbol] === 1, isFunctionList = (o) => o && o[fListSymbol] === 1, getFinalValue = (o) => o.value, getManyValues = (o) => o.values, getFunctionList = (o) => o.fList, flushable = (write, final = null) => {
  let fn = final ? (value) => value === none ? final() : write(value) : write;
  return fn[flushSymbol] = 1, fn;
}, setFunctionList = (o, fns) => (o.fList = fns, o[fListSymbol] = 1, o), clearFunctionList = (o) => (delete o.fList, delete o[fListSymbol], o);

class Stop extends Error {
}
var toMany = (value) => value === none ? many([]) : value && value[manySymbol] === 1 ? value : many([value]), normalizeMany = (o) => {
  if (o?.[manySymbol] === 1)
    switch (o.values.length) {
      case 0:
        return none;
      case 1:
        return o.values[0];
    }
  return o;
}, combineMany = (...args) => {
  let values = [];
  for (let i = 0;i < args.length; ++i) {
    let a = args[i];
    if (a === none)
      continue;
    if (a?.[manySymbol] === 1)
      values.push(...a.values);
    else
      values.push(a);
  }
  return many(values);
}, combineManyMut = (a, ...args) => {
  let values = a === none ? [] : a?.[manySymbol] === 1 ? a.values : [a];
  for (let i = 0;i < args.length; ++i) {
    let b = args[i];
    if (b === none)
      continue;
    if (b?.[manySymbol] === 1)
      values.push(...b.values);
    else
      values.push(b);
  }
  return many(values);
};
var final = finalValue;

// node_modules/stream-chain/src/exec.js
var next = (value, fns, index, push) => {
  for (let i = index;; ) {
    if (value && typeof value.then == "function") {
      let ii = i;
      return value.then((v) => next(v, fns, ii, push));
    }
    if (value == null || value === none)
      return;
    if (value === stop)
      throw new Stop;
    if (isFinalValue(value))
      return push(getFinalValue(value));
    if (isMany(value))
      return nextMany(getManyValues(value), fns, i, push);
    if (value && typeof value.next == "function")
      return nextGen(value, fns, i, push);
    if (i >= fns.length)
      return push(value);
    value = fns[i++](value);
  }
}, nextMany = (values, fns, i, push) => {
  let step = (j) => {
    for (;j < values.length; ++j) {
      let r = next(values[j], fns, i, push);
      if (r && typeof r.then == "function") {
        let jj = j;
        return r.then(() => step(jj + 1));
      }
    }
  };
  return step(0);
}, nextGen = (it, fns, i, push) => {
  let step = () => {
    for (;; ) {
      let data = it.next();
      if (data && typeof data.then == "function")
        return data.then((d) => {
          if (d.done)
            return;
          let r = next(d.value, fns, i, push);
          return r && typeof r.then == "function" ? r.then(step) : step();
        });
      if (data.done)
        return;
      let r = next(data.value, fns, i, push);
      if (r && typeof r.then == "function")
        return r.then(step);
    }
  }, abort = (err) => {
    let onCleanupError = (cleanupErr) => err instanceof Error ? AggregateError([err, cleanupErr], "pipeline error; generator cleanup also failed") : err, ret;
    try {
      ret = it.return ? it.return() : void 0;
    } catch (cleanupErr) {
      throw onCleanupError(cleanupErr);
    }
    if (ret && typeof ret.then == "function")
      return ret.then(() => {
        throw err;
      }, (cleanupErr) => {
        throw onCleanupError(cleanupErr);
      });
    throw err;
  }, r;
  try {
    r = step();
  } catch (err) {
    return abort(err);
  }
  return r && typeof r.then == "function" ? r.then(void 0, abort) : r;
}, flush = (fns, index, push) => {
  let step = (i) => {
    for (;i < fns.length; ++i) {
      let f = fns[i];
      if (!isFlushable(f))
        continue;
      let r = next(f(none), fns, i + 1, push);
      if (r && typeof r.then == "function") {
        let ii = i;
        return r.then(() => step(ii + 1));
      }
    }
  };
  return step(index);
};

// node_modules/stream-chain/src/gen.js
var gen = (...fns) => {
  if (fns = fns.filter((fn) => fn).flat(1 / 0).map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(1 / 0), !fns.length)
    fns = [(x) => x];
  let flushed = !1, g = async function* (value) {
    if (flushed)
      throw Error("Call to a flushed pipe.");
    let isFlush = value === none;
    if (isFlush)
      flushed = !0;
    let pending = [], wakeConsumer = null, resolveProducer = null, rejectProducer = null, done = !1, error = null, cancelled = !1, CANCEL = Symbol("cancel"), push = (v) => {
      if (cancelled)
        throw CANCEL;
      if (pending.push(v), wakeConsumer) {
        let w = wakeConsumer;
        wakeConsumer = null, w();
      }
      return new Promise((res, rej) => {
        resolveProducer = res, rejectProducer = rej;
      });
    };
    Promise.resolve().then(() => isFlush ? flush(fns, 0, push) : next(value, fns, 0, push)).then(() => {}, (e) => {
      if (e !== CANCEL)
        error = e;
    }).finally(() => {
      if (done = !0, wakeConsumer) {
        let w = wakeConsumer;
        wakeConsumer = null, w();
      }
    });
    try {
      for (;; ) {
        while (pending.length) {
          let v = pending.shift();
          if (resolveProducer) {
            let r = resolveProducer;
            resolveProducer = rejectProducer = null, r();
          }
          yield v;
        }
        if (error)
          throw error;
        if (done)
          return;
        await new Promise((res) => wakeConsumer = res);
      }
    } finally {
      if (cancelled = !0, rejectProducer) {
        let rj = rejectProducer;
        resolveProducer = rejectProducer = null, rj(CANCEL);
      }
    }
  };
  if (fns.some((fn) => isFlushable(fn)))
    g = flushable(g);
  return setFunctionList(g, fns);
}, gen_default = gen;

// node_modules/stream-chain/src/fun.js
var asArray = (...fns) => {
  if (fns = fns.filter((fn) => fn).flat(1 / 0).map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(1 / 0), !fns.length)
    fns = [(x) => x];
  let flushed = !1, g = (value) => {
    if (flushed)
      throw Error("Call to a flushed pipe.");
    let results = [], push = (v) => {
      results.push(v);
    }, pending;
    if (value !== none)
      pending = next(value, fns, 0, push);
    else
      flushed = !0, pending = flush(fns, 0, push);
    return pending && typeof pending.then == "function" ? pending.then(() => results) : results;
  };
  if (fns.some((fn) => isFlushable(fn)))
    g = flushable(g);
  return setFunctionList(g, fns);
}, fun = (...fns) => {
  let f = asArray(...fns), g = (value) => {
    let result = f(value);
    if (result && typeof result.then == "function")
      return result.then((results) => many(results));
    return many(result);
  };
  if (isFlushable(f))
    g = flushable(g);
  return setFunctionList(g, getFunctionList(f));
}, fun_default = fun;

// node_modules/stream-chain/src/dataSource.js
var dataSource = (fn) => {
  if (typeof fn == "function")
    return fn;
  if (fn) {
    if (typeof fn[Symbol.asyncIterator] == "function")
      return fn[Symbol.asyncIterator].bind(fn);
    if (typeof fn[Symbol.iterator] == "function")
      return fn[Symbol.iterator].bind(fn);
  }
  throw TypeError("The argument should be a function or an iterable object.");
}, dataSource_default = dataSource;

// node_modules/stream-chain/src/core/index.js
var chain = (fns, _options) => {
  let flat = (Array.isArray(fns) ? fns : []).flat(1 / 0).filter(Boolean).map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(1 / 0), g = gen_default(...flat), c = async function* (input) {
    if (input == null)
      return;
    if (typeof input === "string" || input[Symbol.asyncIterator] === void 0 && input[Symbol.iterator] === void 0) {
      yield* g(input);
      return;
    }
    for await (let value of input)
      yield* g(value);
  };
  return c.streams = null, c.input = null, c.output = null, c;
};
chain.none = none;
chain.stop = stop;
chain.Stop = Stop;
chain.finalSymbol = finalSymbol;
chain.finalValue = finalValue;
chain.final = final;
chain.isFinalValue = isFinalValue;
chain.getFinalValue = getFinalValue;
chain.manySymbol = manySymbol;
chain.many = many;
chain.isMany = isMany;
chain.getManyValues = getManyValues;
chain.flushSymbol = flushSymbol;
chain.flushable = flushable;
chain.isFlushable = isFlushable;
chain.fListSymbol = fListSymbol;
chain.isFunctionList = isFunctionList;
chain.getFunctionList = getFunctionList;
chain.setFunctionList = setFunctionList;
chain.clearFunctionList = clearFunctionList;
chain.toMany = toMany;
chain.normalizeMany = normalizeMany;
chain.combineMany = combineMany;
chain.combineManyMut = combineManyMut;
chain.chain = chain;
chain.chainUnchecked = chain;
chain.gen = gen_default;
chain.fun = fun_default;
chain.dataSource = dataSource_default;

// node_modules/stream-json/src/core/assembler.js
var startObject = (Ctr) => function() {
  if (this.done)
    this.done = !1;
  else
    this.stack.push(this.current, this.key);
  this.current = new Ctr, this.key = null;
};

class Assembler {
  static connectTo(stream, options) {
    return new Assembler(options).connectTo(stream);
  }
  constructor(options) {
    if (this.stack = [], this.current = this.key = null, this.done = !0, this._onDone = null, options) {
      if (this.reviver = typeof options.reviver == "function" && options.reviver, this.reviver)
        this.stringValue = this._saveValue = this._saveValueWithReviver;
      if (options.numberAsString)
        this.numberValue = this.stringValue;
      if (typeof options.onDone == "function")
        this._onDone = options.onDone;
    }
    this.tapChain = (chunk) => {
      if (this[chunk.name]) {
        if (this[chunk.name](chunk.value), this.done)
          return this.current;
      }
      return none;
    };
  }
  connectTo(stream) {
    let consume = (chunk) => {
      if (this[chunk.name]) {
        if (this[chunk.name](chunk.value), this.done)
          this._onDone?.(this);
      }
    };
    if (typeof stream?.getReader === "function") {
      let reader = stream.getReader();
      (async () => {
        try {
          for (;; ) {
            let { done, value } = await reader.read();
            if (done)
              return;
            consume(value);
          }
        } finally {
          reader.releaseLock();
        }
      })();
    } else
      stream.on("data", consume);
    return this;
  }
  onDone(fn) {
    return this._onDone = typeof fn == "function" ? fn : null, this;
  }
  get depth() {
    return (this.stack.length >> 1) + (this.done ? 0 : 1);
  }
  get path() {
    let path = [];
    for (let i = 0;i < this.stack.length; i += 2) {
      let key = this.stack[i + 1];
      path.push(key === null ? this.stack[i].length : key);
    }
    return path;
  }
  dropToLevel(level) {
    if (level < this.depth)
      if (level > 0) {
        let index = level - 1 << 1;
        this.current = this.stack[index], this.key = this.stack[index + 1], this.stack.splice(index);
      } else
        this.stack = [], this.current = this.key = null, this.done = !0;
    return this;
  }
  consume(chunk) {
    return this[chunk.name]?.(chunk.value), this;
  }
  keyValue(value) {
    this.key = value;
  }
  numberValue(value) {
    this._saveValue(parseFloat(value));
  }
  nullValue() {
    this._saveValue(null);
  }
  trueValue() {
    this._saveValue(!0);
  }
  falseValue() {
    this._saveValue(!1);
  }
  endObject() {
    if (this.stack.length) {
      let value = this.current;
      this.key = this.stack.pop(), this.current = this.stack.pop(), this._saveValue(value);
    } else {
      if (this.reviver)
        this.current = this.reviver.call({ "": this.current }, "", this.current);
      this.done = !0;
    }
  }
  _saveValue(value) {
    if (this.done) {
      this.current = value;
      return;
    }
    if (this.current instanceof Array)
      this.current.push(value);
    else {
      if (this.key === "__proto__")
        Object.defineProperty(this.current, this.key, { value, writable: !0, enumerable: !0, configurable: !0 });
      else
        this.current[this.key] = value;
      this.key = null;
    }
  }
  _saveValueWithReviver(value) {
    if (this.done) {
      this.current = this.reviver.call({ "": value }, "", value);
      return;
    }
    if (this.current instanceof Array)
      if (this.current.push(value), value = this.reviver.call(this.current, String(this.current.length - 1), value), value === void 0)
        delete this.current[this.current.length - 1];
      else
        this.current[this.current.length - 1] = value;
    else {
      if (value = this.reviver.call(this.current, this.key, value), value !== void 0)
        if (this.key === "__proto__")
          Object.defineProperty(this.current, this.key, { value, writable: !0, enumerable: !0, configurable: !0 });
        else
          this.current[this.key] = value;
      this.key = null;
    }
  }
}
var proto = Assembler.prototype;
proto.stringValue = Assembler.prototype._saveValue;
proto.startObject = startObject(Object);
proto.startArray = startObject(Array);
proto.endArray = Assembler.prototype.endObject;
var assembler = (options) => new Assembler(options);
Assembler.assembler = assembler;

// node_modules/stream-json/src/core/parser.js
var exports_parser = {};
__export(exports_parser, {
  default: () => parser_default,
  jsonParser: () => jsonParser,
  parser: () => parser
});

// node_modules/stream-chain/src/utils/fixUtf8Stream.js
var makeTextDecoderImpl = () => {
  let textDecoder = /* @__PURE__ */ new TextDecoder;
  return flushable((chunk) => {
    if (chunk === none)
      return textDecoder.decode();
    if (typeof chunk == "string")
      return chunk;
    if (chunk instanceof Uint8Array)
      return textDecoder.decode(chunk, { stream: !0 });
    throw TypeError("Expected a string or a Uint8Array");
  });
}, makeStringDecoderImpl = (StringDecoder) => () => {
  let stringDecoder = new StringDecoder;
  return flushable((chunk) => {
    if (chunk === none)
      return stringDecoder.end();
    if (typeof chunk == "string")
      return chunk;
    if (chunk instanceof Uint8Array)
      return stringDecoder.write(chunk);
    throw TypeError("Expected a string or a Uint8Array");
  });
}, impl = makeTextDecoderImpl, isDeno = typeof globalThis.Deno == "object" && globalThis.Deno?.version, isBun = typeof globalThis.Bun == "object" && globalThis.Bun?.version, isNode = !isDeno && !isBun && typeof process == "object" && process?.versions?.node, readyPromise = isNode ? import("node:string_decoder").then(({ StringDecoder }) => {
  impl = makeStringDecoderImpl(StringDecoder);
}, () => {}) : Promise.resolve(), fixUtf8Stream = () => impl();
var fixUtf8Stream_default = fixUtf8Stream;

// node_modules/stream-json/src/core/parser.js
var patterns = {
  value1: /[\"\{\[\]\-\d]|true\b|false\b|null\b|\s{1,256}/y,
  string: /[^\x00-\x1f\"\\]{1,256}|\\[bfnrt\"\\\/]|\\u[\da-fA-F]{4}|\"/y,
  numberStart: /\d/y,
  numberDigit: /\d{0,256}/y,
  numberFraction: /[\.eE]/y,
  numberExponent: /[eE]/y,
  numberExpSign: /[-+]/y
}, MAX_PATTERN_SIZE = 16;
patterns.numberFracStart = patterns.numberExpStart = patterns.numberStart;
patterns.numberFracDigit = patterns.numberExpDigit = patterns.numberDigit;
var expected = { object: "objectStop", array: "arrayStop", "": "done" }, tokenStartObject = { name: "startObject" }, tokenEndObject = { name: "endObject" }, tokenStartArray = { name: "startArray" }, tokenEndArray = { name: "endArray" }, tokenStartString = { name: "startString" }, tokenEndString = { name: "endString" }, tokenStartNumber = { name: "startNumber" }, tokenEndNumber = { name: "endNumber" }, tokenStartKey = { name: "startKey" }, tokenEndKey = { name: "endKey" }, literalTokens = {
  true: { name: "trueValue", value: !0 },
  false: { name: "falseValue", value: !1 },
  null: { name: "nullValue", value: null }
}, fromHex = (s) => String.fromCharCode(parseInt(s.slice(2), 16)), codes = { b: "\b", f: "\f", n: `
`, r: "\r", t: "\t", '"': '"', "\\": "\\", "/": "/" }, ASCII_TAB = 9, ASCII_LF = 10, ASCII_CR = 13, ASCII_SPACE = 32, ASCII_QUOTE = 34, ASCII_BACKSLASH = 92, ASCII_OPEN_BRACE = 123, ASCII_CLOSE_BRACE = 125, ASCII_OPEN_BRACKET = 91, ASCII_CLOSE_BRACKET = 93, ASCII_MINUS = 45, ASCII_COLON = 58, ASCII_COMMA = 44, ASCII_ZERO = 48, ASCII_NINE = 57, ASCII_UPPER_A = 65, ASCII_UPPER_F = 70, ASCII_LOWER_A = 97, ASCII_LOWER_F = 102, ASCII_LOWER_N = 110, ASCII_LOWER_T = 116, ASCII_LOWER_U = 117, TERM = [];
for (let ch of `,}] 	
\r`)
  TERM[ch.charCodeAt(0)] = 1;
var numberFull = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/y, HEX = (c) => c >= ASCII_ZERO && c <= ASCII_NINE || c >= ASCII_UPPER_A && c <= ASCII_UPPER_F || c >= ASCII_LOWER_A && c <= ASCII_LOWER_F, jsonParser = (options) => {
  let packKeys = !0, packStrings = !0, packNumbers = !0, streamKeys = !0, streamStrings = !0, streamNumbers = !0, jsonStreaming = !1;
  if (options)
    "packValues" in options && (packKeys = packStrings = packNumbers = options.packValues), "packKeys" in options && (packKeys = options.packKeys), "packStrings" in options && (packStrings = options.packStrings), "packNumbers" in options && (packNumbers = options.packNumbers), "streamValues" in options && (streamKeys = streamStrings = streamNumbers = options.streamValues), "streamKeys" in options && (streamKeys = options.streamKeys), "streamStrings" in options && (streamStrings = options.streamStrings), "streamNumbers" in options && (streamNumbers = options.streamNumbers), jsonStreaming = options.jsonStreaming;
  !packKeys && (streamKeys = !0), !packStrings && (streamStrings = !0), !packNumbers && (streamNumbers = !0);
  let done = !1, expect = jsonStreaming ? "done" : "value", parent = "", openNumber = !1, accumulator = "", buffer = "", stack = [];
  return flushable((buf) => {
    let tokens = [];
    if (buf === none)
      done = !0;
    else
      buffer += buf;
    let match, fm, s, e, q, rs, cc, value, index = 0;
    main:
      for (;; )
        switch (expect) {
          case "value1":
          case "value": {
            while (index < buffer.length) {
              if (cc = buffer.charCodeAt(index), cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
                ++index;
                continue;
              }
              break;
            }
            if (index >= buffer.length) {
              if (done)
                throw Error("Parser has expected a value");
              break main;
            }
            if (cc = buffer.charCodeAt(index), cc === ASCII_QUOTE) {
              q = index + 1, rs = q, s = "";
              for (;; ) {
                if (q >= buffer.length) {
                  q = -1;
                  break;
                }
                if (e = buffer.charCodeAt(q), e === ASCII_QUOTE) {
                  s += buffer.slice(rs, q);
                  break;
                }
                if (e < ASCII_SPACE) {
                  q = -1;
                  break;
                }
                if (e === ASCII_BACKSLASH) {
                  if (q + 1 >= buffer.length) {
                    q = -1;
                    break;
                  }
                  if (cc = buffer.charCodeAt(q + 1), cc === ASCII_LOWER_U) {
                    if (q + 6 > buffer.length || !(HEX(buffer.charCodeAt(q + 2)) && HEX(buffer.charCodeAt(q + 3)) && HEX(buffer.charCodeAt(q + 4)) && HEX(buffer.charCodeAt(q + 5)))) {
                      q = -1;
                      break;
                    }
                    s += buffer.slice(rs, q) + String.fromCharCode(parseInt(buffer.slice(q + 2, q + 6), 16)), q += 6;
                  } else {
                    if (value = codes[buffer.charAt(q + 1)], value === void 0) {
                      q = -1;
                      break;
                    }
                    s += buffer.slice(rs, q) + value, q += 2;
                  }
                  rs = q;
                  continue;
                }
                ++q;
              }
              if (q >= 0) {
                if (streamStrings) {
                  if (tokens.push(tokenStartString), s)
                    tokens.push({ name: "stringChunk", value: s });
                  tokens.push(tokenEndString);
                }
                if (packStrings)
                  tokens.push({ name: "stringValue", value: s });
                index = q + 1, expect = expected[parent];
                continue main;
              }
              if (streamStrings)
                tokens.push(tokenStartString);
              expect = "string", ++index;
              continue main;
            }
            if (cc === ASCII_OPEN_BRACE) {
              tokens.push(tokenStartObject), stack.push(parent), parent = "object", expect = "key1", ++index;
              continue main;
            }
            if (cc === ASCII_OPEN_BRACKET) {
              tokens.push(tokenStartArray), stack.push(parent), parent = "array", expect = "value1", ++index;
              continue main;
            }
            if (cc === ASCII_CLOSE_BRACKET) {
              if (expect !== "value1")
                throw Error("Parser cannot parse input: unexpected token ']'");
              tokens.push(tokenEndArray), parent = stack.pop(), expect = expected[parent], ++index;
              continue main;
            }
            if (cc === ASCII_MINUS || cc >= ASCII_ZERO && cc <= ASCII_NINE) {
              if (numberFull.lastIndex = index, fm = numberFull.exec(buffer), fm) {
                if (e = index + fm[0].length, e < buffer.length && TERM[buffer.charCodeAt(e)]) {
                  if (s = fm[0], streamNumbers)
                    tokens.push(tokenStartNumber, { name: "numberChunk", value: s }, tokenEndNumber);
                  if (packNumbers)
                    tokens.push({ name: "numberValue", value: s });
                  index = e, expect = expected[parent];
                  continue main;
                }
              }
              if (openNumber = !0, cc === ASCII_MINUS) {
                if (streamNumbers)
                  tokens.push(tokenStartNumber, { name: "numberChunk", value: "-" });
                packNumbers && (accumulator = "-"), expect = "numberStart";
              } else if (cc === ASCII_ZERO) {
                if (streamNumbers)
                  tokens.push(tokenStartNumber, { name: "numberChunk", value: "0" });
                packNumbers && (accumulator = "0"), expect = "numberFraction";
              } else {
                if (s = buffer.charAt(index), streamNumbers)
                  tokens.push(tokenStartNumber, { name: "numberChunk", value: s });
                packNumbers && (accumulator = s), expect = "numberDigit";
              }
              ++index;
              continue main;
            }
            if (cc === ASCII_LOWER_T || cc === ASCII_LOWER_F || cc === ASCII_LOWER_N) {
              if (patterns.value1.lastIndex = index, match = patterns.value1.exec(buffer), !match) {
                if (done || index + MAX_PATTERN_SIZE < buffer.length)
                  throw Error("Parser cannot parse input: expected a value");
                break main;
              }
              if (value = match[0], buffer.length - index === value.length && !done)
                break main;
              tokens.push(literalTokens[value]), expect = expected[parent], index += value.length;
              continue main;
            }
            throw Error("Parser cannot parse input: expected a value");
          }
          case "keyVal":
          case "string":
            if (patterns.string.lastIndex = index, match = patterns.string.exec(buffer), !match) {
              if (index < buffer.length && (done || buffer.length - index >= 6))
                throw Error("Parser cannot parse input: escaped characters");
              if (done)
                throw Error("Parser has expected a string value");
              break main;
            }
            if (value = match[0], value === '"')
              if (expect === "keyVal") {
                if (streamKeys)
                  tokens.push(tokenEndKey);
                if (packKeys)
                  tokens.push({ name: "keyValue", value: accumulator }), accumulator = "";
                expect = "colon";
              } else {
                if (streamStrings)
                  tokens.push(tokenEndString);
                if (packStrings)
                  tokens.push({ name: "stringValue", value: accumulator }), accumulator = "";
                expect = expected[parent];
              }
            else if (value.length > 1 && value.charAt(0) === "\\") {
              let t = value.length == 2 ? codes[value.charAt(1)] : fromHex(value);
              if (expect === "keyVal" ? streamKeys : streamStrings)
                tokens.push({ name: "stringChunk", value: t });
              if (expect === "keyVal" ? packKeys : packStrings)
                accumulator += t;
            } else {
              if (expect === "keyVal" ? streamKeys : streamStrings)
                tokens.push({ name: "stringChunk", value });
              if (expect === "keyVal" ? packKeys : packStrings)
                accumulator += value;
            }
            index += value.length;
            break;
          case "key1":
          case "key": {
            while (index < buffer.length) {
              if (cc = buffer.charCodeAt(index), cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
                ++index;
                continue;
              }
              break;
            }
            if (index >= buffer.length) {
              if (done)
                throw Error("Parser cannot parse input: expected an object key");
              break main;
            }
            if (cc = buffer.charCodeAt(index), cc === ASCII_QUOTE) {
              q = index + 1, rs = q, s = "";
              for (;; ) {
                if (q >= buffer.length) {
                  q = -1;
                  break;
                }
                if (e = buffer.charCodeAt(q), e === ASCII_QUOTE) {
                  s += buffer.slice(rs, q);
                  break;
                }
                if (e < ASCII_SPACE) {
                  q = -1;
                  break;
                }
                if (e === ASCII_BACKSLASH) {
                  if (q + 1 >= buffer.length) {
                    q = -1;
                    break;
                  }
                  if (cc = buffer.charCodeAt(q + 1), cc === ASCII_LOWER_U) {
                    if (q + 6 > buffer.length || !(HEX(buffer.charCodeAt(q + 2)) && HEX(buffer.charCodeAt(q + 3)) && HEX(buffer.charCodeAt(q + 4)) && HEX(buffer.charCodeAt(q + 5)))) {
                      q = -1;
                      break;
                    }
                    s += buffer.slice(rs, q) + String.fromCharCode(parseInt(buffer.slice(q + 2, q + 6), 16)), q += 6;
                  } else {
                    if (value = codes[buffer.charAt(q + 1)], value === void 0) {
                      q = -1;
                      break;
                    }
                    s += buffer.slice(rs, q) + value, q += 2;
                  }
                  rs = q;
                  continue;
                }
                ++q;
              }
              if (q >= 0) {
                if (streamKeys) {
                  if (tokens.push(tokenStartKey), s)
                    tokens.push({ name: "stringChunk", value: s });
                  tokens.push(tokenEndKey);
                }
                if (packKeys)
                  tokens.push({ name: "keyValue", value: s });
                index = q + 1, expect = "colon";
                continue main;
              }
              if (streamKeys)
                tokens.push(tokenStartKey);
              expect = "keyVal", ++index;
              continue main;
            }
            if (cc === ASCII_CLOSE_BRACE) {
              if (expect !== "key1")
                throw Error("Parser cannot parse input: unexpected token '}'");
              tokens.push(tokenEndObject), parent = stack.pop(), expect = expected[parent], ++index;
              continue main;
            }
            throw Error("Parser cannot parse input: expected an object key");
          }
          case "colon": {
            while (index < buffer.length) {
              if (cc = buffer.charCodeAt(index), cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
                ++index;
                continue;
              }
              break;
            }
            if (index >= buffer.length) {
              if (done)
                throw Error("Parser cannot parse input: expected ':'");
              break main;
            }
            if (cc = buffer.charCodeAt(index), cc === ASCII_COLON) {
              expect = "value", ++index;
              continue main;
            }
            throw Error("Parser cannot parse input: expected ':'");
          }
          case "arrayStop":
          case "objectStop": {
            while (index < buffer.length) {
              if (cc = buffer.charCodeAt(index), cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
                ++index;
                continue;
              }
              break;
            }
            if (index >= buffer.length) {
              if (done)
                throw Error("Parser cannot parse input: expected ','");
              break main;
            }
            if (openNumber) {
              if (streamNumbers)
                tokens.push(tokenEndNumber);
              if (openNumber = !1, packNumbers)
                tokens.push({ name: "numberValue", value: accumulator }), accumulator = "";
            }
            if (cc = buffer.charCodeAt(index), cc === ASCII_COMMA) {
              expect = expect === "arrayStop" ? "value" : "key", ++index;
              continue main;
            }
            if (cc === ASCII_CLOSE_BRACE || cc === ASCII_CLOSE_BRACKET) {
              if (cc === ASCII_CLOSE_BRACE ? expect === "arrayStop" : expect !== "arrayStop")
                throw Error("Parser cannot parse input: expected '" + (expect === "arrayStop" ? "]" : "}") + "'");
              tokens.push(cc === ASCII_CLOSE_BRACE ? tokenEndObject : tokenEndArray), parent = stack.pop(), expect = expected[parent], ++index;
              continue main;
            }
            throw Error("Parser cannot parse input: expected ','");
          }
          case "numberStart":
            if (patterns.numberStart.lastIndex = index, match = patterns.numberStart.exec(buffer), !match) {
              if (index < buffer.length || done)
                throw Error("Parser cannot parse input: expected a starting digit");
              break main;
            }
            if (value = match[0], streamNumbers)
              tokens.push({ name: "numberChunk", value });
            packNumbers && (accumulator += value), expect = value === "0" ? "numberFraction" : "numberDigit", index += value.length;
            break;
          case "numberDigit":
            if (patterns.numberDigit.lastIndex = index, match = patterns.numberDigit.exec(buffer), !match) {
              if (index < buffer.length || done)
                throw Error("Parser cannot parse input: expected a digit");
              break main;
            }
            if (value = match[0], value) {
              if (streamNumbers)
                tokens.push({ name: "numberChunk", value });
              packNumbers && (accumulator += value), index += value.length;
            } else {
              if (index < buffer.length) {
                expect = "numberFraction";
                break;
              }
              if (done) {
                expect = expected[parent];
                break;
              }
              break main;
            }
            break;
          case "numberFraction":
            if (patterns.numberFraction.lastIndex = index, match = patterns.numberFraction.exec(buffer), !match) {
              if (index < buffer.length || done) {
                expect = expected[parent];
                break;
              }
              break main;
            }
            if (value = match[0], streamNumbers)
              tokens.push({ name: "numberChunk", value });
            packNumbers && (accumulator += value), expect = value === "." ? "numberFracStart" : "numberExpSign", index += value.length;
            break;
          case "numberFracStart":
            if (patterns.numberFracStart.lastIndex = index, match = patterns.numberFracStart.exec(buffer), !match) {
              if (index < buffer.length || done)
                throw Error("Parser cannot parse input: expected a fractional part of a number");
              break main;
            }
            if (value = match[0], streamNumbers)
              tokens.push({ name: "numberChunk", value });
            packNumbers && (accumulator += value), expect = "numberFracDigit", index += value.length;
            break;
          case "numberFracDigit":
            if (patterns.numberFracDigit.lastIndex = index, match = patterns.numberFracDigit.exec(buffer), value = match[0], value) {
              if (streamNumbers)
                tokens.push({ name: "numberChunk", value });
              packNumbers && (accumulator += value), index += value.length;
            } else {
              if (index < buffer.length) {
                expect = "numberExponent";
                break;
              }
              if (done) {
                expect = expected[parent];
                break;
              }
              break main;
            }
            break;
          case "numberExponent":
            if (patterns.numberExponent.lastIndex = index, match = patterns.numberExponent.exec(buffer), !match) {
              if (index < buffer.length) {
                expect = expected[parent];
                break;
              }
              if (done) {
                expect = expected[parent];
                break;
              }
              break main;
            }
            if (value = match[0], streamNumbers)
              tokens.push({ name: "numberChunk", value });
            packNumbers && (accumulator += value), expect = "numberExpSign", index += value.length;
            break;
          case "numberExpSign":
            if (patterns.numberExpSign.lastIndex = index, match = patterns.numberExpSign.exec(buffer), !match) {
              if (index < buffer.length) {
                expect = "numberExpStart";
                break;
              }
              if (done)
                throw Error("Parser has expected an exponent value of a number");
              break main;
            }
            if (value = match[0], streamNumbers)
              tokens.push({ name: "numberChunk", value });
            packNumbers && (accumulator += value), expect = "numberExpStart", index += value.length;
            break;
          case "numberExpStart":
            if (patterns.numberExpStart.lastIndex = index, match = patterns.numberExpStart.exec(buffer), !match) {
              if (index < buffer.length || done)
                throw Error("Parser cannot parse input: expected an exponent part of a number");
              break main;
            }
            if (value = match[0], streamNumbers)
              tokens.push({ name: "numberChunk", value });
            packNumbers && (accumulator += value), expect = "numberExpDigit", index += value.length;
            break;
          case "numberExpDigit":
            if (patterns.numberExpDigit.lastIndex = index, match = patterns.numberExpDigit.exec(buffer), value = match[0], value) {
              if (streamNumbers)
                tokens.push({ name: "numberChunk", value });
              packNumbers && (accumulator += value), index += value.length;
            } else {
              if (index < buffer.length || done) {
                expect = expected[parent];
                break;
              }
              break main;
            }
            break;
          case "done": {
            while (index < buffer.length) {
              if (cc = buffer.charCodeAt(index), cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
                if (openNumber) {
                  if (streamNumbers)
                    tokens.push(tokenEndNumber);
                  if (openNumber = !1, packNumbers)
                    tokens.push({ name: "numberValue", value: accumulator }), accumulator = "";
                }
                ++index;
                continue;
              }
              break;
            }
            if (index >= buffer.length)
              break main;
            if (jsonStreaming) {
              if (openNumber) {
                if (streamNumbers)
                  tokens.push(tokenEndNumber);
                if (openNumber = !1, packNumbers)
                  tokens.push({ name: "numberValue", value: accumulator }), accumulator = "";
              }
              expect = "value";
              continue main;
            }
            throw Error("Parser cannot parse input: unexpected characters");
          }
        }
    if (done && openNumber) {
      if (streamNumbers)
        tokens.push(tokenEndNumber);
      if (openNumber = !1, packNumbers)
        tokens.push({ name: "numberValue", value: accumulator }), accumulator = "";
    }
    return buffer = buffer.slice(index), tokens.length ? many(tokens) : none;
  });
}, parser = (options) => gen_default(fixUtf8Stream_default(), jsonParser(options));
parser.parser = parser;
var parser_default = parser;

// helper/src/t3/project/AgentSessionJson.ts
class TranscriptJsonLimitError extends Error {
}
function createTranscriptJsonReader(reserve, selectPath, options) {
  let { jsonParser } = exports_parser, tokenize = jsonParser({ packValues: !1 }), assembler = new Assembler, key = null, value = "", depth = 0, complete = !1, malformed = !1, assemble = (token) => {
    switch (reserve(64 + ("value" in token && typeof token.value === "string" ? token.value.length * 2 : 0)), token.name) {
      case "startString":
      case "startNumber":
        value = "";
        break;
      case "stringChunk":
      case "numberChunk":
        value += token.value;
        break;
      case "endString":
        assembler.consume({ name: "stringValue", value }), value = "";
        break;
      case "endNumber":
        assembler.consume({ name: "numberValue", value }), value = "";
        break;
      default:
        assembler.consume(token);
    }
  }, stack = [], selectedValue = !1, startValue = () => {
    let parent = stack.at(-1), path = parent?.selected ? [...parent.path, parent.key] : [], selected = (parent?.selected ?? !0) && selectPath(path);
    if (selected && typeof parent?.key === "string")
      assemble({ name: "keyValue", value: parent.key });
    return { path, selected };
  }, endValue = () => {
    let parent = stack.at(-1);
    if (parent && typeof parent.key === "number")
      parent.key++;
  }, selectToken = (token) => {
    if (token === none)
      return;
    switch (token.name) {
      case "keyValue": {
        let parent = stack.at(-1);
        if (parent)
          parent.key = token.value;
        return;
      }
      case "startObject":
      case "startArray": {
        let frame = startValue();
        if (stack.push({ ...frame, key: token.name === "startArray" ? 0 : null }), frame.selected)
          assemble(token);
        return;
      }
      case "endObject":
      case "endArray":
        if (stack.pop()?.selected)
          assemble(token);
        endValue();
        return;
      case "startString":
      case "startNumber":
        if (selectedValue = startValue().selected, selectedValue)
          assemble(token);
        return;
      case "endString":
      case "endNumber":
        if (selectedValue)
          assemble(token);
        endValue();
        return;
      case "nullValue":
      case "trueValue":
      case "falseValue":
        if (startValue().selected)
          assemble(token);
        endValue();
        return;
      default:
        if (selectedValue)
          assemble(token);
    }
  }, consume = (input) => {
    if (malformed)
      return;
    try {
      let tokens = tokenize(input);
      if (tokens === none)
        return;
      for (let token of tokens.values) {
        if (token.name === "startObject" || token.name === "startArray") {
          if (++depth > (options?.maxDepth ?? 128))
            throw new TranscriptJsonLimitError("Transcript JSON nesting exceeds the depth limit");
        } else if (token.name === "endObject" || token.name === "endArray") {
          if (--depth === 0)
            complete = !0;
        }
        if (token.name === "startKey")
          key = "";
        else if (token.name === "stringChunk" && key !== null)
          reserve(token.value.length * 2), key += token.value;
        else if (token.name === "endKey")
          selectToken({ name: "keyValue", value: key ?? "" }), key = null;
        else
          selectToken(token);
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("Parser "))
        malformed = !0;
      else
        throw cause;
    }
  };
  return {
    write: (chunk) => consume(chunk),
    finish: () => {
      if (consume(none), malformed || !complete)
        return;
      return selectToken(none), assembler.done ? assembler.current : void 0;
    }
  };
}

// helper/src/t3/usage/usageTranscriptReader.ts
var GUARD_LENGTH = 64, STREAMING_THRESHOLD_BYTES = 8388608, NEWLINE = 10, STAT_CONCURRENCY = 32, CARRIAGE_RETURN = 13, USAGE_FIELDS = {
  claude: {
    type: !0,
    timestamp: !0,
    requestId: !0,
    sessionId: !0,
    costUSD: !0,
    message: { id: !0, model: !0, usage: !0 }
  },
  codex: {
    type: !0,
    timestamp: !0,
    payload: {
      type: !0,
      id: !0,
      session_id: !0,
      model: !0,
      thread_settings: { service_tier: !0 },
      forked_from_id: !0,
      source: { subagent: { thread_spawn: { parent_thread_id: !0 } } },
      info: { last_token_usage: !0 }
    }
  },
  grok: {
    timestamp: !0,
    params: {
      sessionId: !0,
      _meta: { agentTimestampMs: !0 },
      update: { sessionUpdate: !0, prompt_id: !0, usage: !0 }
    }
  }
};
function selectUsageFields(provider) {
  let fields = USAGE_FIELDS[provider === "codex" || provider === "grok" ? provider : "claude"];
  return (path) => {
    let selected = fields;
    for (let key of path) {
      if (selected === !0)
        return !0;
      if (typeof key !== "string" || !Object.hasOwn(selected, key))
        return !1;
      selected = selected[key];
    }
    return !0;
  };
}
function fnv1a(buffer) {
  let hash = 2166136261;
  for (let index = 0;index < buffer.length; index += 1)
    hash ^= buffer[index], hash = Math.imul(hash, 16777619);
  return hash >>> 0;
}
async function listTranscriptFiles(root, sinceMs, options) {
  let fileName = options?.fileName, candidates = [], walk = async (dir) => {
    let entries;
    try {
      entries = await NodeFSP3.readdir(dir, { withFileTypes: !0 });
    } catch {
      return;
    }
    for (let entry of entries) {
      let child = NodePath3.join(dir, entry.name);
      if (entry.isDirectory())
        await walk(child);
      else if (fileName !== void 0 ? entry.name === fileName : entry.name.endsWith(".jsonl"))
        candidates.push(child);
    }
  };
  await walk(root);
  let found = Array.from({ length: candidates.length }), queue = candidates.entries(), statQueued = async () => {
    for (let [index, path] of queue)
      try {
        let stats = await NodeFSP3.stat(path);
        if (stats.mtimeMs >= sinceMs)
          found[index] = { path, size: stats.size, mtimeMs: stats.mtimeMs };
      } catch {}
  };
  return await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, statQueued)), found.filter((file) => file !== void 0);
}
async function guardMatches(handle, position) {
  if (position.guardLength <= 0 || position.guardLength > GUARD_LENGTH)
    return !1;
  try {
    let window = Buffer.alloc(position.guardLength), { bytesRead } = await handle.read(window, 0, position.guardLength, position.resumeOffset - position.guardLength);
    return bytesRead === position.guardLength && fnv1a(window) === position.guardHash;
  } catch {
    return !1;
  }
}
async function readTranscriptRecords(filePath, provider, resumeFrom, options) {
  let streamingThresholdBytes = options?.streamingThresholdBytes ?? STREAMING_THRESHOLD_BYTES, handle;
  try {
    handle = await NodeFSP3.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    let codexState = initialCodexScanState(), resumed = !1, start = 0;
    if (resumeFrom !== void 0 && resumeFrom.resumeOffset > 0 && (provider !== "codex" || resumeFrom.codexState !== null) && await guardMatches(handle, resumeFrom)) {
      if (resumeFrom.codexState !== null)
        codexState = { ...resumeFrom.codexState };
      start = resumeFrom.resumeOffset, resumed = !0;
    }
    let parseLine = (line, state, out) => {
      if (provider === "codex") {
        if (!mightCarryUsage(line, provider) && !line.includes('"turn_context"') && !line.includes('"thread_settings_applied"') && !line.includes('"session_meta"'))
          return;
        let record = parseCodexLine(line, state);
        if (record !== null)
          out.push(record);
        return;
      }
      if (!mightCarryUsage(line, provider))
        return;
      if (provider === "grok") {
        for (let grokRecord of parseGrokLine(line))
          out.push(grokRecord);
        return;
      }
      let record = parseClaudeLine(line);
      if (record !== null)
        out.push(record);
    }, toLineString = (lineBuffer) => (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === CARRIAGE_RETURN ? lineBuffer.subarray(0, -1) : lineBuffer).toString("utf8"), records = [], resumeOffset = start, scanOffset = start, pendingChunks = [], pendingBytes = 0, streaming, decoder, selectPath = selectUsageFields(provider), append = (segment) => {
      if (!streaming && pendingBytes + segment.length <= streamingThresholdBytes) {
        if (segment.length > 0)
          pendingChunks.push(segment);
        pendingBytes += segment.length;
        return;
      }
      if (!streaming) {
        streaming = createTranscriptJsonReader(() => {}, selectPath, { maxDepth: 1 / 0 }), decoder = new NodeStringDecoder.StringDecoder("utf8");
        for (let pending of pendingChunks)
          streaming.write(decoder.write(pending));
        pendingChunks = [], pendingBytes = 0;
      }
      streaming.write(decoder.write(segment));
    }, finish = (state, out) => {
      if (streaming) {
        streaming.write(decoder.end());
        let projected = streaming.finish();
        if (provider === "grok")
          out.push(...parseGrokRecord(projected));
        else {
          let record = provider === "codex" ? parseCodexRecord(projected, state) : parseClaudeRecord(projected);
          if (record !== null)
            out.push(record);
        }
      } else if (pendingBytes > 0) {
        let line = pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks, pendingBytes);
        parseLine(toLineString(line), state, out);
      }
      pendingChunks = [], pendingBytes = 0, streaming = void 0, decoder = void 0;
    }, stream = handle.createReadStream({
      start,
      autoClose: !1,
      highWaterMark: 262144
    });
    for await (let chunk of stream) {
      let lineStart = 0;
      while (lineStart < chunk.length) {
        let newlineIndex = chunk.indexOf(NEWLINE, lineStart);
        if (newlineIndex === -1) {
          append(chunk.subarray(lineStart));
          break;
        }
        if (!streaming && pendingBytes === 0)
          parseLine(toLineString(chunk.subarray(lineStart, newlineIndex)), codexState, records);
        else
          append(chunk.subarray(lineStart, newlineIndex)), finish(codexState, records);
        lineStart = newlineIndex + 1, resumeOffset = scanOffset + lineStart;
      }
      scanOffset += chunk.length;
    }
    let tailRecords = [];
    finish({ ...codexState }, tailRecords);
    let guardLength = Math.min(GUARD_LENGTH, resumeOffset), guardHash = 0;
    if (guardLength > 0) {
      let window = Buffer.alloc(guardLength);
      await handle.read(window, 0, guardLength, resumeOffset - guardLength), guardHash = fnv1a(window);
    }
    return {
      records,
      tailRecords,
      position: {
        resumeOffset,
        guardLength,
        guardHash,
        codexState: provider === "codex" ? codexState : null
      },
      resumed
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {
      return;
    });
  }
}

// helper/src/t3/usage/usageScanCache.ts
var USAGE_SCAN_CACHE_VERSION = 5, SPEED_COMPATIBLE_SINCE_VERSION = 4;
var SPEEDS = ["standard", "fast", "ultrafast"];
function isSpeed(value) {
  return SPEEDS.some((speed) => speed === value);
}
function makeInternTables() {
  return { models: [], sessions: [], modelIndex: /* @__PURE__ */ new Map, sessionIndex: /* @__PURE__ */ new Map };
}
function intern(table, index, value) {
  let existing = index.get(value);
  if (existing !== void 0)
    return existing;
  let next = table.length;
  return table.push(value), index.set(value, next), next;
}
function serializeFile(entry, tables) {
  let serializeRecord = (record) => [
    record.timestampMs,
    intern(tables.models, tables.modelIndex, record.model),
    intern(tables.sessions, tables.sessionIndex, record.sessionId),
    record.totals.uncachedInputTokens,
    record.totals.cachedInputTokens,
    record.totals.cacheCreationTokens,
    record.totals.outputTokens,
    record.totals.reasoningTokens,
    record.dedupeKey,
    record.reportedCostUsd,
    SPEEDS.indexOf(record.speed)
  ];
  return {
    s: entry.size,
    m: entry.mtimeMs,
    p: entry.provider,
    r: entry.records.map(serializeRecord),
    t: entry.tailRecords.map(serializeRecord),
    o: entry.position.resumeOffset,
    gl: entry.position.guardLength,
    gh: entry.position.guardHash,
    cs: entry.position.codexState
  };
}
function makeScanCacheWriter() {
  let tables = makeInternTables(), fragments = /* @__PURE__ */ new WeakMap;
  return (cache, extra) => {
    let files = [];
    for (let [path, entry] of cache) {
      let fragment = fragments.get(entry);
      if (fragment === void 0)
        fragment = JSON.stringify(serializeFile(entry, tables)), fragments.set(entry, fragment);
      files.push(`${JSON.stringify(path)}:${fragment}`);
    }
    return `${JSON.stringify({
      ...extra,
      version: USAGE_SCAN_CACHE_VERSION,
      models: tables.models,
      sessions: tables.sessions
    }).slice(0, -1)},"files":{${files.join(",")}}}`;
  };
}
function isRecordArray(value) {
  return Array.isArray(value);
}
function decodeScanCache(document) {
  let cache = /* @__PURE__ */ new Map;
  if (typeof document !== "object" || document === null)
    return cache;
  let root = document, version = root.version;
  if (typeof version !== "number" || version < SPEED_COMPATIBLE_SINCE_VERSION || version > USAGE_SCAN_CACHE_VERSION)
    return cache;
  if (!isRecordArray(root.models) || !isRecordArray(root.sessions))
    return cache;
  if (typeof root.files !== "object" || root.files === null)
    return cache;
  if (!root.models.every((value) => typeof value === "string"))
    return cache;
  if (!root.sessions.every((value) => typeof value === "string"))
    return cache;
  let { models, sessions } = root, decodeRecords = (rows, provider) => {
    let records = [];
    for (let row of rows) {
      if (!isRecordArray(row) || row.length < 11)
        return null;
      let [
        timestampMs,
        modelIndex,
        sessionIndex,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
        speedIndex
      ] = row, speed = typeof speedIndex === "number" ? SPEEDS[speedIndex] : void 0, model = typeof modelIndex === "number" ? models[modelIndex] : void 0;
      if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs) || model === void 0 || !Number.isFinite(uncached) || !Number.isFinite(cached) || !Number.isFinite(cacheCreation) || !Number.isFinite(output) || !Number.isFinite(reasoning) || speed === void 0)
        return null;
      records.push({
        provider,
        timestampMs,
        model,
        sessionId: (typeof sessionIndex === "number" ? sessions[sessionIndex] : void 0) ?? "",
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: reasoning
        },
        reportedCostUsd: typeof reportedCostUsd === "number" ? reportedCostUsd : null,
        speed,
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null
      });
    }
    return records;
  };
  for (let [path, raw] of Object.entries(root.files)) {
    if (typeof raw !== "object" || raw === null)
      continue;
    let entry = raw;
    if (typeof entry.s !== "number" || typeof entry.m !== "number")
      continue;
    if (entry.p !== "claude" && entry.p !== "codex" && entry.p !== "grok")
      continue;
    if (!isRecordArray(entry.r) || !isRecordArray(entry.t))
      continue;
    if (typeof entry.o !== "number" || !Number.isSafeInteger(entry.o) || entry.o < 0 || typeof entry.gl !== "number" || !Number.isSafeInteger(entry.gl) || entry.gl < 0 || entry.gl > GUARD_LENGTH || entry.gl > entry.o || typeof entry.gh !== "number" || !Number.isFinite(entry.gh))
      continue;
    let legacyCodex = entry.p === "codex" && version < USAGE_SCAN_CACHE_VERSION, codexState = legacyCodex ? null : decodeCodexState(entry.cs);
    if (codexState === void 0)
      continue;
    let provider = entry.p, records = decodeRecords(entry.r, provider), tailRecords = decodeRecords(entry.t, provider);
    if (records === null || tailRecords === null)
      continue;
    cache.set(path, {
      size: legacyCodex ? -1 : entry.s,
      mtimeMs: entry.m,
      provider,
      records,
      tailRecords,
      position: legacyCodex ? { resumeOffset: 0, guardLength: 0, guardHash: 0, codexState: null } : { resumeOffset: entry.o, guardLength: entry.gl, guardHash: entry.gh, codexState }
    });
  }
  return cache;
}
function decodeCodexState(value) {
  if (value === null)
    return null;
  if (typeof value !== "object")
    return;
  let state = value;
  if (typeof state.model !== "string" || !isSpeed(state.speed) || typeof state.sessionId !== "string" || state.lastUsageSignature !== null && typeof state.lastUsageSignature !== "string" || typeof state.sawSessionMeta !== "boolean" || typeof state.suppressingForkCopies !== "boolean" || typeof state.forkCopyAnchorMs !== "number" || !Number.isFinite(state.forkCopyAnchorMs))
    return;
  return {
    model: state.model,
    speed: state.speed,
    sessionId: state.sessionId,
    lastUsageSignature: state.lastUsageSignature ?? null,
    sawSessionMeta: state.sawSessionMeta,
    suppressingForkCopies: state.suppressingForkCopies,
    forkCopyAnchorMs: state.forkCopyAnchorMs
  };
}
function pruneScanCache(cache, retentionCutoffMs) {
  let removed = 0;
  for (let [path, entry] of cache)
    if (entry.mtimeMs < retentionCutoffMs)
      cache.delete(path), removed += 1;
  return removed;
}
function dedupeWithinFile(records, seen = /* @__PURE__ */ new Set) {
  let kept = [];
  for (let record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey))
        continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}

// helper/src/sources.ts
import { existsSync, realpathSync } from "node:fs";
import * as os2 from "node:os";
import * as path3 from "node:path";
var historyHome = (env) => env.USAGEMETER_HOME?.trim() || env.HOME?.trim() || os2.homedir(), canonical = (dir) => {
  try {
    return realpathSync(dir);
  } catch {
    return path3.resolve(dir);
  }
}, expandHome = (value, home) => value === "~" ? home : value.startsWith("~/") ? path3.join(home, value.slice(2)) : value, listFromEnv = (value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
function transcriptSources(env = process.env) {
  let home = historyHome(env), claudeHomes = [env.CLAUDE_CONFIG_DIR?.trim() || path3.join(home, ".claude")], codexHomes = [path3.join(home, ".codex"), ...listFromEnv(env.CODEX_HOME)], seen = /* @__PURE__ */ new Set, sources = [], add = (provider, dir) => {
    let resolved = canonical(expandHome(dir, home)), key = provider + "\x00" + resolved;
    if (seen.has(key))
      return;
    seen.add(key), sources.push({ provider, dir: resolved });
  };
  for (let claudeHome of claudeHomes)
    add("claude", path3.join(expandHome(claudeHome, home), "projects"));
  for (let codexHome of codexHomes)
    add("codex", path3.join(expandHome(codexHome, home), "sessions"));
  return sources;
}
function openCodeRoots(env = process.env) {
  let home = historyHome(env), dataHome = env.XDG_DATA_HOME?.trim(), defaults = [
    path3.join(dataHome && path3.isAbsolute(dataHome) ? dataHome : path3.join(home, ".local", "share"), "opencode")
  ], roots = listFromEnv(env.OPENCODE_DATA_DIR);
  return [...new Set((roots.length ? roots : defaults).map((root) => canonical(expandHome(root, home))))];
}
function antigravityDirs(env = process.env) {
  let home = historyHome(env), configured = listFromEnv(env.ANTIGRAVITY_DATA_DIR), roots = configured.length ? configured : [
    ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((name) => path3.join(home, ".gemini", name)),
    path3.join(home, ".config", "antigravity")
  ], dirs = /* @__PURE__ */ new Set;
  for (let root of roots) {
    let resolved = canonical(expandHome(root, home)), nested = path3.join(resolved, "conversations");
    dirs.add(canonical(existsSync(nested) ? nested : resolved));
  }
  return [...dirs];
}

// helper/src/scan.ts
var HOUR_MS2 = 3600000, DAY_MS = 24 * HOUR_MS2, MTIME_SLACK_MS = 36 * HOUR_MS2, RETENTION_DAYS = 90, READ_CONCURRENCY = 4, CACHE_FILE = "scan-cache.json", tokensOf = (bucket) => bucket.totals.uncachedInputTokens + bucket.totals.cachedInputTokens + bucket.totals.cacheCreationTokens + bucket.totals.outputTokens;
function dayFormatter(timeZone) {
  let format;
  try {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  return (ms) => format.format(new Date(ms));
}
function shiftDay(day, delta) {
  let [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}
function makeWindows(nowMs, timeZone, rates) {
  let today = dayFormatter(timeZone)(nowMs), windows = [];
  for (let [id, days] of [["7d", 7], ["30d", 30], ["90d", 90]]) {
    let sinceDay = shiftDay(today, -(days - 1)), keys = Array.from({ length: days }, (_, i) => shiftDay(sinceDay, i));
    windows.push({
      id,
      aggregator: new UsageAggregator({ timeZone, sinceDay, untilDay: today, rates, resolution: "day" }),
      sessions: /* @__PURE__ */ new Map,
      keys,
      sinceDay,
      untilDay: today,
      resolution: "day"
    });
  }
  let untilTimeMs = Math.floor(nowMs / HOUR_MS2) * HOUR_MS2 + HOUR_MS2, sinceTimeMs = untilTimeMs - DAY_MS - HOUR_MS2, toDay = dayFormatter(timeZone);
  return windows.unshift({
    id: "24h",
    aggregator: new UsageAggregator({
      timeZone,
      sinceDay: toDay(sinceTimeMs),
      untilDay: today,
      rates,
      resolution: "hour",
      sinceTimeMs,
      untilTimeMs
    }),
    sessions: /* @__PURE__ */ new Map,
    keys: Array.from({ length: 25 }, (_, i) => new Date(sinceTimeMs + i * HOUR_MS2).toISOString()),
    sinceDay: toDay(sinceTimeMs),
    untilDay: today,
    resolution: "hour"
  }), windows;
}
function summarize(window) {
  let { buckets } = window.aggregator.finish(), total = {
    costUsd: 0,
    tokens: 0,
    cachedInput: 0,
    uncachedInput: 0,
    cacheWrite: 0,
    output: 0,
    savingsUsd: 0,
    sessions: 0,
    unpricedRecords: 0
  }, categoryCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 }, speed = { standard: 0, fast: 0, ultrafast: 0, premium: 0 }, providers = /* @__PURE__ */ new Map, models = /* @__PURE__ */ new Map, points = new Map(window.keys.map((key) => [key, { key, costUsd: 0, tokens: 0, providers: {}, models: [] }]));
  for (let bucket of buckets) {
    let tokens = tokensOf(bucket), cost = bucket.costUsd;
    total.costUsd += cost, total.tokens += tokens, total.cachedInput += bucket.totals.cachedInputTokens, total.uncachedInput += bucket.totals.uncachedInputTokens, total.cacheWrite += bucket.totals.cacheCreationTokens, total.output += bucket.totals.outputTokens, total.savingsUsd += bucket.cacheSavingsUsd, total.unpricedRecords += bucket.unpricedRecords;
    let split = bucket.categoryCostUsd;
    if (split)
      categoryCost.input += split.input, categoryCost.cacheRead += split.cacheRead, categoryCost.cacheWrite += split.cacheWrite, categoryCost.output += split.output, categoryCost.other += cost - (split.input + split.cacheRead + split.cacheWrite + split.output);
    else
      categoryCost.other += cost;
    let fast = bucket.fastCostUsd ?? 0, ultrafast = bucket.ultrafastCostUsd ?? 0;
    speed.fast += fast, speed.ultrafast += ultrafast, speed.standard += cost - fast - ultrafast, speed.premium += bucket.speedPremiumUsd ?? 0;
    let provider = providers.get(bucket.provider) ?? { provider: bucket.provider, costUsd: 0, tokens: 0, sessions: 0 };
    provider.costUsd += cost, provider.tokens += tokens, providers.set(bucket.provider, provider);
    let modelKey = bucket.provider + "\x00" + bucket.model, model = models.get(modelKey) ?? { model: bucket.model, provider: bucket.provider, costUsd: 0, tokens: 0, unpriced: !1 };
    model.costUsd += cost, model.tokens += tokens, model.unpriced ||= bucket.costSource === "unpriced" && bucket.records === bucket.unpricedRecords, models.set(modelKey, model);
    let point = points.get(window.resolution === "hour" ? bucket.hourStart ?? "" : bucket.day);
    if (point) {
      point.costUsd += cost, point.tokens += tokens;
      let slice = point.providers[bucket.provider] ??= { costUsd: 0, tokens: 0 };
      slice.costUsd += cost, slice.tokens += tokens;
      let row = point.models.find((m) => m.provider === bucket.provider && m.model === bucket.model);
      if (row)
        row.costUsd += cost, row.tokens += tokens;
      else
        point.models.push({ model: bucket.model, provider: bucket.provider, costUsd: cost, tokens, unpriced: !1 });
    }
  }
  for (let [provider, ids] of window.sessions) {
    let row = providers.get(provider);
    if (row)
      row.sessions = ids.size;
    total.sessions += ids.size;
  }
  let byCost = (a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens;
  for (let point of points.values())
    point.models.sort(byCost);
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
    points: [...points.values()]
  };
}
async function loadCache(file) {
  try {
    return decodeScanCache(JSON.parse(await readFile4(file, "utf8")));
  } catch {
    return /* @__PURE__ */ new Map;
  }
}
async function mapLimit(items, limit, task) {
  let results = Array(items.length), next = 0, worker = async () => {
    while (next < items.length) {
      let index = next++;
      results[index] = await task(items[index]);
    }
  };
  return await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)), results;
}
var isWithin = (file, dir) => {
  let relative2 = path4.relative(dir, file);
  return relative2 !== "" && !relative2.startsWith("..") && !path4.isAbsolute(relative2);
};
function sharedCodexSessions(files) {
  let firstFile = /* @__PURE__ */ new Map, shared = /* @__PURE__ */ new Set;
  return files.forEach((file, index) => {
    let previous = "";
    for (let { provider, sessionId } of file.records) {
      if (provider !== "codex" || sessionId === previous || sessionId.length === 0)
        continue;
      previous = sessionId;
      let first = firstFile.get(sessionId);
      if (first === void 0)
        firstFile.set(sessionId, index);
      else if (first !== index)
        shared.add(sessionId);
    }
  }), shared;
}
async function scan(options) {
  let { nowMs, timeZone, rates, cacheDir } = options, env = options.env ?? process.env, windows = makeWindows(nowMs, timeZone, rates), windowStartMs = Date.parse(windows.at(-1).sinceDay + "T00:00:00Z") - MTIME_SLACK_MS, retentionCutoffMs = nowMs - RETENTION_DAYS * DAY_MS, cacheFile = path4.join(cacheDir, CACHE_FILE), cache = await loadCache(cacheFile), cacheDirty = !1, sources = [], add = (provider, dir, record) => {
    for (let window of windows)
      if (window.aggregator.add(record, dir) && record.sessionId.length > 0) {
        let ids = window.sessions.get(provider);
        if (!ids)
          window.sessions.set(provider, ids = /* @__PURE__ */ new Set);
        ids.add(record.sessionId);
      }
  };
  for (let { provider, dir } of transcriptSources(env)) {
    let files;
    try {
      files = await listTranscriptFiles(dir, windowStartMs);
    } catch {
      sources.push({ provider, dir, status: "missing", files: 0 });
      continue;
    }
    let read = await mapLimit(files, READ_CONCURRENCY, async (file) => {
      let cached = cache.get(file.path);
      if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs && cached.provider === provider)
        return { path: file.path, records: [...cached.records, ...cached.tailRecords] };
      let resumeFrom = cached && cached.provider === provider && file.size > cached.size ? cached.position : void 0, parsed = await readTranscriptRecords(file.path, provider, resumeFrom);
      if (parsed === null)
        return { path: file.path, records: cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : [] };
      let base = parsed.resumed && cached ? cached.records : [], seen = /* @__PURE__ */ new Set, records = dedupeWithinFile([...base, ...parsed.records], seen), tailRecords = dedupeWithinFile(parsed.tailRecords, seen), entry = { size: file.size, mtimeMs: file.mtimeMs, provider, records, tailRecords, position: parsed.position };
      return cache.set(file.path, entry), cacheDirty = !0, { path: file.path, records: [...records, ...tailRecords] };
    }), live = new Set(read.map((file) => file.path)), retainedSinceMs = Math.max(windowStartMs, retentionCutoffMs);
    for (let [filePath, entry] of cache) {
      if (entry.provider !== provider || entry.mtimeMs < retainedSinceMs || live.has(filePath) || !isWithin(filePath, dir))
        continue;
      read.push({ path: filePath, records: [...entry.records, ...entry.tailRecords] });
    }
    let shared = sharedCodexSessions(read);
    for (let file of read) {
      let occurrences = /* @__PURE__ */ new Map;
      for (let record of file.records) {
        let usageRecord = record;
        if (record.provider === "codex" && shared.has(record.sessionId)) {
          let key = JSON.stringify([record.provider, record.sessionId, record.timestampMs, record.model, record.totals]), occurrence = (occurrences.get(key) ?? 0) + 1;
          occurrences.set(key, occurrence), usageRecord = { ...record, dedupeKey: key + ":" + occurrence };
        }
        add(provider, dir, usageRecord);
      }
    }
    sources.push({ provider, dir, status: "ok", files: files.length });
  }
  for (let dir of openCodeRoots(env)) {
    let result = await readOpenCodeUsage(dir, windowStartMs);
    for (let file of result.files)
      for (let record of file.records)
        add("opencode", dir, record);
    sources.push({
      provider: "opencode",
      dir,
      status: result.missing && !result.error ? "missing" : result.error ? "partial" : "ok",
      files: result.files.length
    });
  }
  let agDirs = antigravityDirs(env), antigravity = await readAntigravityUsage(agDirs, windowStartMs);
  for (let file of antigravity.files)
    for (let record of file.records)
      add("antigravity", file.root, record);
  for (let dir of agDirs) {
    let files = antigravity.files.filter((file) => file.root === dir).length, failed = antigravity.errors.some((error) => error === dir || error.startsWith(dir + path4.sep));
    if (files > 0 || failed)
      sources.push({ provider: "antigravity", dir, status: failed ? "partial" : "ok", files });
  }
  if (pruneScanCache(cache, retentionCutoffMs) > 0)
    cacheDirty = !0;
  if (cacheDirty)
    try {
      await mkdir2(cacheDir, { recursive: !0 });
      let temp = cacheFile + ".tmp";
      await writeFile2(temp, makeScanCacheWriter()(cache, {})), await rename(temp, cacheFile);
    } catch {}
  let ranges = Object.fromEntries(windows.map((window) => [window.id, summarize(window)]));
  return { sources, ranges };
}

// helper/src/main.ts
var OUTPUT_VERSION = 1;
function cacheDir(env) {
  if (env.USAGEMETER_CACHE_DIR?.trim())
    return env.USAGEMETER_CACHE_DIR.trim();
  let xdg = env.XDG_CACHE_HOME?.trim();
  return path5.join(xdg && path5.isAbsolute(xdg) ? xdg : path5.join(os3.homedir(), ".cache"), "usagemeter");
}
function flag(args, name) {
  let index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : void 0;
}
async function main(argv) {
  let [command, ...args] = argv, env = process.env, startedAt = Date.now();
  if (command === "scan") {
    let timeZone = flag(args, "--tz") || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", dir = cacheDir(env), rates = await loadRates(dir, startedAt, args.includes("--refresh-rates")), result = await scan({ nowMs: startedAt, timeZone, rates: rates.table, cacheDir: dir, env });
    return write({
      version: OUTPUT_VERSION,
      readAt: (/* @__PURE__ */ new Date()).toISOString(),
      timeZone,
      scanMs: Date.now() - startedAt,
      rates: { status: rates.status, fetchedAt: rates.fetchedAtMs === null ? null : new Date(rates.fetchedAtMs).toISOString() },
      ...result
    }), 0;
  }
  if (command === "limits") {
    let result = await readLimits({
      nowMs: startedAt,
      hubUrl: env.USAGEMETER_HUB_URL,
      hubKey: env.USAGEMETER_HUB_KEY,
      openCodeGo: env.USAGEMETER_OPENCODE_GO === "1",
      env
    });
    return write({ version: OUTPUT_VERSION, checkedAt: (/* @__PURE__ */ new Date()).toISOString(), ...result }), 0;
  }
  return write({ version: OUTPUT_VERSION, error: `Unknown command '${command ?? ""}'. Use 'scan' or 'limits'.` }), 2;
}
function write(document) {
  process.stdout.write(JSON.stringify(document) + `
`);
}
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error) => {
  write({ version: OUTPUT_VERSION, error: error instanceof Error ? error.message : String(error) }), process.exitCode = 1;
});
export {
  OUTPUT_VERSION
};
