import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { createServer } from "node:http";

import { availableCredits, claudeWindows, codexWindows, readLimits } from "../src/limits.ts";
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
  const home = await mkdtemp(path.join(os.tmpdir(), "ledger-test-"));
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
  const home = await mkdtemp(path.join(os.tmpdir(), "ledger-test-"));
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
          ],
        });
      }
      if (req.url === "/v0/management/api-call") {
        const upstream = String(body.url);
        if (upstream.endsWith("/wham/usage")) return send({ status_code: 200, body: JSON.stringify({ plan_type: "plus", rate_limit: { secondary_window: { used_percent: 62, reset_at: 4070908800, limit_window_seconds: 604800 } } }) });
        if (upstream.endsWith("/rate-limit-reset-credits")) return send({ status_code: 200, body: JSON.stringify({ credits: [{ id: "x", status: "available", reset_type: "codex_rate_limits", expires_at: "2099-01-01T00:00:00Z" }] }) });
        if (upstream.endsWith("/api/oauth/usage")) return send({ status_code: 500, body: "do-not-publish" });
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
    assert.equal(out.accounts.length, 2);
  } finally {
    server.close();
  }
});
