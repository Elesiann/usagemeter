import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { createServer } from "node:http";

import { antigravitySummaryWindows, antigravityWindows, availableCredits, claudeWindows, codexWindows, ensureHubUp, isLoopbackHub, readLimits } from "../src/limits.ts";
import { scan, shiftDay } from "../src/scan.ts";
import { transcriptSources } from "../src/sources.ts";
import { createOverrideRateTable } from "../src/t3/usage/usagePricing.ts";

// Same shape as the fixture in T3 Code's UsageService.test.ts.
const claudeLine = (id: number, timestamp: string, outputTokens: number, model = "claude-test-model") =>
  JSON.stringify({
    type: "assistant",
    timestamp,
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: { id: `msg_${id}`, model, usage: { input_tokens: 10, output_tokens: outputTokens } },
  }) + "\n";

test("scan prices Claude records, dedupes copies across files and fills empty days", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usagemeter-test-"));
  try {
    const projects = path.join(home, "claude", "projects", "proj");
    await mkdir(projects, { recursive: true });
    const now = Date.parse("2026-10-05T12:00:00Z");
    await writeFile(path.join(projects, "a.jsonl"), claudeLine(1, "2026-10-05T10:00:00Z", 100) + claudeLine(2, "2026-10-03T10:00:00Z", 50));
    // A resumed session copies message 1 forward: it must count once.
    await writeFile(path.join(projects, "b.jsonl"), claudeLine(1, "2026-10-05T10:00:00Z", 100));
    const rates = createOverrideRateTable({ "claude-test-model": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 10 } });
    const env = {
      CLAUDE_CONFIG_DIR: path.join(home, "claude"),
      CODEX_HOME: path.join(home, "codex"),
      HOME: home,
      OPENCODE_DATA_DIR: path.join(home, "opencode"),
      ANTIGRAVITY_DATA_DIR: path.join(home, "antigravity"),
    };
    const result = await scan({ nowMs: now, timeZone: "UTC", rates, cacheDir: path.join(home, "cache"), env });
    const week = result.ranges["7d"];
    assert.equal(week.points.length, 7);
    assert.equal(week.points.at(-1)!.key, "2026-10-05");
    assert.equal(week.total.tokens, 10 + 100 + 10 + 50);
    assert.equal(week.total.output, 150);
    assert.equal(week.total.sessions, 1);
    assert.ok(Math.abs(week.total.costUsd - (20 * 1e-6 + 150 * 1e-5)) < 1e-12);
    assert.equal(week.points.find((p) => p.key === "2026-10-04")!.tokens, 0);
    // The 24h window holds only today's record.
    assert.equal(result.ranges["24h"].total.output, 100);

    // A second scan reads the same totals back from the cache.
    const again = await scan({ nowMs: now, timeZone: "UTC", rates, cacheDir: path.join(home, "cache"), env });
    assert.equal(again.ranges["7d"].total.tokens, week.total.tokens);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a Codex home that symlinks the default one is read once", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usagemeter-test-"));
  try {
    await mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
    await mkdir(path.join(home, "lane"), { recursive: true });
    await symlink(path.join(home, ".codex", "sessions"), path.join(home, "lane", "sessions"));
    const codex = transcriptSources({ HOME: home, CODEX_HOME: path.join(home, "lane") }).filter((s) => s.provider === "codex");
    assert.equal(codex.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("shiftDay crosses month ends", () => {
  assert.equal(shiftDay("2026-10-01", -1), "2026-09-30");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
});

test("Codex windows take their kind from the window length", () => {
  const windows = codexWindows({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 0, reset_at: null, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 78, reset_at: 4070908800, limit_window_seconds: 604800 },
    },
  });
  assert.deepEqual(windows.map((w) => [w.id, w.kind, w.usedPercent]), [["primary", "session", 0], ["secondary", "weekly", 78]]);
  assert.equal(windows[1]!.resetsAt, new Date(4070908800 * 1000).toISOString());
});

test("Claude windows include model-scoped weeklies", () => {
  const windows = claudeWindows({
    five_hour: { utilization: 10, resets_at: "2026-10-05T23:00:00Z" },
    seven_day: { utilization: 50, resets_at: "2026-10-11T22:00:00Z" },
    limits: [{ kind: "weekly_scoped", percent: 80, resets_at: "2026-10-11T22:00:00Z", scope: { model: { display_name: "Fable" } } }],
  });
  assert.deepEqual(windows.map((w) => [w.id, w.usedPercent]), [["five_hour", 10], ["seven_day", 50], ["seven_day_fable", 80]]);
});

test("only unexpired available Codex reset credits count", () => {
  const now = Date.parse("2026-10-05T00:00:00Z");
  const credit = (status: string, expires: string, type = "codex_rate_limits") => ({ id: expires, status, reset_type: type, expires_at: expires });
  const count = availableCredits({
    credits: [credit("available", "2026-10-10T00:00:00Z"), credit("available", "2026-10-01T00:00:00Z"), credit("redeemed", "2026-10-10T00:00:00Z"), credit("available", "2026-10-10T00:00:00Z", "other")],
  }, now);
  assert.equal(count, 1);
});

test("hub limits follow CLIProxyAPI's management contract", async () => {
  const seen: { method?: string; url?: string; auth?: string; body?: any }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (value: unknown) => res.end(JSON.stringify(value));
      if (req.url === "/v0/management/auth-files") {
        return send({
          files: [
            { id: "a", auth_index: 0, provider: "codex", email: "c@example.com", id_token: { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" } },
            { id: "b", auth_index: 1, provider: "claude", email: "k@example.com" },
            { id: "c", auth_index: 2, provider: "claude", disabled: true },
            { id: "d", auth_index: 3, provider: "gemini" },
            { id: "e", auth_index: 4, provider: "antigravity", email: "a@example.com", project_id: "proj-9" },
          ],
        });
      }
      if (req.url === "/v0/management/api-call") {
        const upstream = String(body.url);
        if (upstream.endsWith("/wham/usage")) return send({ status_code: 200, body: JSON.stringify({ plan_type: "plus", rate_limit: { secondary_window: { used_percent: 62, reset_at: 4070908800, limit_window_seconds: 604800 } } }) });
        if (upstream.endsWith("/rate-limit-reset-credits")) return send({ status_code: 200, body: JSON.stringify({ credits: [{ id: "x", status: "available", reset_type: "codex_rate_limits", expires_at: "2099-01-01T00:00:00Z" }] }) });
        if (upstream.endsWith("/api/oauth/usage")) return send({ status_code: 500, body: "do-not-publish" });
        // The daily host fails, so the production host must be tried next.
        if (upstream.startsWith("https://daily-cloudcode-pa")) return send({ status_code: 503, body: "" });
        if (upstream === "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary") {
          return send({ status_code: 200, body: JSON.stringify({ groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.25, resetTime: "2026-10-06T03:00:00Z" }, { bucketId: "gemini-weekly", remainingFraction: 0.9 }] }] }) });
        }
        if (upstream === "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels") {
          return send({ status_code: 200, body: JSON.stringify({ models: { "gemini-3-pro": { displayName: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.25, resetTime: "2026-10-06T03:00:00Z" } } } }) });
        }
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const out = await readLimits({ nowMs: Date.parse("2026-10-05T00:00:00Z"), hubUrl: `http://127.0.0.1:${port}`, hubKey: "management-secret", openCodeGo: false, env: {} });
    assert.equal(out.hub.status, "ok");
    assert.ok(seen.every((r) => r.auth === "Bearer management-secret"));
    const codexCall = seen.find((r) => String(r.body?.url).endsWith("/wham/usage"))!;
    assert.equal(codexCall.body.header["Chatgpt-Account-Id"], "acct-1");
    assert.equal(codexCall.body.header.Authorization, "Bearer $TOKEN$");
    const codex = out.accounts.find((a) => a.provider === "codex")!;
    assert.deepEqual(codex.windows.map((w) => [w.label, w.usedPercent]), [["Weekly", 62]]);
    assert.equal(codex.resetCredits, 1);
    assert.equal(codex.plan, "Plus");
    const claude = out.accounts.find((a) => a.provider === "claude")!;
    assert.match(claude.error ?? "", /HTTP 500/);
    assert.ok(!JSON.stringify(out).includes("do-not-publish"));
    const ag = out.accounts.find((a) => a.provider === "antigravity")!;
    assert.deepEqual(ag.windows.map((w) => [w.label, w.kind, Math.round(w.usedPercent)]), [["Session · Gemini", "session", 75], ["Weekly · Gemini", "weekly", 10]]);
    const agCall = seen.find((r) => String(r.body?.url).startsWith("https://cloudcode-pa"))!;
    assert.equal(agCall.body.method, "POST");
    assert.deepEqual(JSON.parse(agCall.body.data), {});
    assert.equal(agCall.body.header["User-Agent"], "antigravity");
    assert.equal(out.accounts.length, 3);
  } finally {
    server.close();
  }
});

test("Antigravity models collapse into families, worst member and earliest reset", () => {
  const windows = antigravityWindows({
    models: {
      "gemini-3-pro": { displayName: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.9, resetTime: "2026-10-06T05:00:00Z" } },
      "gemini-3-flash": { displayName: "Gemini 3 Flash", quotaInfo: { remainingFraction: 0.4, resetTime: "2026-10-06T04:00:00Z" } },
      "claude-sonnet-5-5": { displayName: "Claude Sonnet 5.5", quotaInfo: { remainingFraction: 1 } },
      "gpt-oss": { displayName: "GPT-OSS", quotaInfo: { isExhausted: true } },
      "gemini-3-flash-image": { quotaInfo: { remainingFraction: 0 } },
      "tab_flash": { quotaInfo: { remainingFraction: 0 } },
      "no-quota": { displayName: "Other" },
    },
  });
  assert.deepEqual(
    windows.map((w) => [w.label, w.usedPercent, w.resetsAt ?? null]),
    [["Claude + GPT", 100, null], ["Gemini", 60, "2026-10-06T04:00:00.000Z"]],
  );
});

test("Antigravity summary buckets become session and weekly windows per family", () => {
  const windows = antigravitySummaryWindows({
    groups: [
      { buckets: [{ bucketId: "3p-weekly", remainingFraction: 0.5, resetTime: "2026-10-11T00:00:00Z" }, { bucketId: "gemini-3.8-pro", remainingFraction: 0 }] },
      { buckets: [{ bucketId: "gemini-5h", remainingFraction: 1 }, { bucketId: "3p-5h", remainingFraction: 0 }] },
    ],
  });
  assert.deepEqual(
    windows.map((w) => [w.label, w.usedPercent, w.windowMins]),
    [["Session · Gemini", 0, 300], ["Session · Claude + GPT", 100, 300], ["Weekly · Claude + GPT", 50, 10080]],
  );
});

test("a malformed upstream body never reaches an error message", async () => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.url === "/v0/management/auth-files") return res.end(JSON.stringify({ files: [{ id: "b", auth_index: 1, provider: "claude", email: "k@example.com" }] }));
      if (req.url === "/v0/management/api-call") return res.end(JSON.stringify({ status_code: 200, body: "sk-do-not-leak {not json" }));
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const out = await readLimits({ nowMs: Date.now(), hubUrl: `http://127.0.0.1:${port}`, hubKey: "k", openCodeGo: false, env: {} });
    assert.equal(out.accounts[0]!.error, "The provider returned a response that is not JSON.");
    assert.ok(!JSON.stringify(out).includes("do-not-leak"));
  } finally {
    server.close();
  }
});

test("an unreachable hub is reported with the network error code only", async () => {
  const out = await readLimits({ nowMs: Date.now(), hubUrl: "http://127.0.0.1:9", hubKey: "k", openCodeGo: false, env: {} });
  assert.equal(out.hub.status, "error");
  assert.match(out.hub.message ?? "", /^The hub could not be reached( \([A-Z_]+\))?$/);
});

test("only a loopback hub URL may be started", () => {
  assert.ok(isLoopbackHub("http://localhost:8317"));
  assert.ok(isLoopbackHub("http://127.0.0.1:8317"));
  assert.ok(isLoopbackHub("http://[::1]:8317"));
  assert.ok(!isLoopbackHub("http://proxy.lan:8317"));
  assert.ok(!isLoopbackHub("not a url"));
});

test("no restart is attempted for a remote hub or when autostart is off", async () => {
  let calls = 0;
  const spawn = () => {
    calls += 1;
    return { once() {}, unref() {} };
  };
  assert.equal(await ensureHubUp("http://proxy.lan:8317", { autostart: true, home: os.tmpdir(), spawn }), false);
  assert.equal(await ensureHubUp("http://127.0.0.1:9", { autostart: false, home: os.tmpdir(), spawn }), false);
  assert.equal(calls, 0);
});

test("a missing explicit binary fails without searching PATH", async () => {
  let calls = 0;
  const spawn = () => {
    calls += 1;
    return { once() {}, unref() {} };
  };
  assert.equal(await ensureHubUp("http://127.0.0.1:9", { autostart: true, bin: "/nonexistent/cli-proxy-api", home: os.tmpdir(), spawn }), false);
  assert.equal(calls, 0);
});

test("a refused loopback hub is restarted through the injected spawner", async () => {
  // The "hub" is this test's own server; the spawner only records the call.
  const server = createServer((req, res) => {
    if (req.url === "/v0/management/auth-files") return res.end(JSON.stringify({ files: [] }));
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const out = await readLimits({
      nowMs: Date.now(),
      hubUrl: `http://127.0.0.1:${port}`,
      hubKey: "k",
      openCodeGo: false,
      env: {},
      hubAutostart: true,
      hubBin: "/nonexistent/cli-proxy-api",
      hubSpawn: (command, args) => {
        spawned.push({ command, args });
        return { once() {}, unref() {} };
      },
    });
    // The hub answers, so no restart is needed and the spawner stays idle.
    assert.equal(spawned.length, 0);
    assert.equal(out.hub.status, "ok");
    const started = await ensureHubUp(`http://127.0.0.1:${port}`, {
      autostart: true,
      bin: process.execPath,
      home: os.tmpdir(),
      timeoutMs: 5_000,
      spawn: (command, args) => {
        spawned.push({ command, args });
        return { once() {}, unref() {} };
      },
    });
    assert.equal(started, true);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]!.command, process.execPath);
  } finally {
    server.close();
  }
});

test("the 24h range covers every record of the past 24 hours", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usagemeter-test-"));
  try {
    const projects = path.join(home, ".claude", "projects", "p");
    await mkdir(projects, { recursive: true });
    // At 12:01, yesterday's 12:30 record is 23h31m old and must count; 12:00 and 11:30 are older than a day.
    await writeFile(path.join(projects, "a.jsonl"), claudeLine(1, "2026-10-04T12:30:00Z", 7) + claudeLine(2, "2026-10-04T11:30:00Z", 5) + claudeLine(3, "2026-10-04T12:00:00Z", 3));
    const rates = createOverrideRateTable({});
    const result = await scan({ nowMs: Date.parse("2026-10-05T12:01:00Z"), timeZone: "UTC", rates, cacheDir: path.join(home, "cache"), env: { HOME: home } });
    assert.equal(result.ranges["24h"].total.output, 7);
    assert.equal(result.ranges["24h"].points.length, 25);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("USAGEMETER_HOME points the scan at another home", () => {
  const sources = transcriptSources({ USAGEMETER_HOME: "/tmp/elsewhere", HOME: "/tmp/mine" });
  assert.deepEqual(sources.map((s) => s.dir), ["/tmp/elsewhere/.claude/projects", "/tmp/elsewhere/.codex/sessions"]);
});
