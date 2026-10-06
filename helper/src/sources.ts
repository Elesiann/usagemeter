// Where each provider keeps its local history, resolved the way T3 Code's
// UsageService resolves it (apps/server/src/usage/UsageService.ts), minus T3's
// own provider-instance settings.
import { existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { UsageProviderKind } from "./t3/contracts.ts";

export interface TranscriptSource {
  readonly provider: Extract<UsageProviderKind, "claude" | "codex">;
  readonly dir: string;
}

/**
 * The home directory whose agent history is read: `LEDGER_HOME` when set, for
 * example a Windows profile seen from WSL, else the user's home. Explicit
 * per-tool variables such as `CLAUDE_CONFIG_DIR` still take precedence.
 */
export const historyHome = (env: NodeJS.ProcessEnv): string =>
  env.LEDGER_HOME?.trim() || env.HOME?.trim() || os.homedir();

const canonical = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

const expandHome = (value: string, home: string): string =>
  value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;

/** Splits a comma-separated list from the environment, ignoring blanks. */
const listFromEnv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Claude and Codex transcript directories.
 *
 * Codex is read from both `~/.codex` and `$CODEX_HOME` when they differ, since
 * a session may export a lane-specific home that symlinks or splits history.
 * Directories are de-duplicated by real path.
 */
export function transcriptSources(env: NodeJS.ProcessEnv = process.env): TranscriptSource[] {
  const home = historyHome(env);
  const claudeHomes = [env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude")];
  const codexHomes = [path.join(home, ".codex"), ...listFromEnv(env.CODEX_HOME)];
  const seen = new Set<string>();
  const sources: TranscriptSource[] = [];
  const add = (provider: TranscriptSource["provider"], dir: string) => {
    const resolved = canonical(expandHome(dir, home));
    const key = provider + "\0" + resolved;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ provider, dir: resolved });
  };
  for (const claudeHome of claudeHomes) add("claude", path.join(expandHome(claudeHome, home), "projects"));
  for (const codexHome of codexHomes) add("codex", path.join(expandHome(codexHome, home), "sessions"));
  return sources;
}

/** OpenCode data directories (`OPENCODE_DATA_DIR`, else `$XDG_DATA_HOME/opencode`). */
export function openCodeRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = historyHome(env);
  const dataHome = env.XDG_DATA_HOME?.trim();
  const defaults = [
    path.join(dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(home, ".local", "share"), "opencode"),
  ];
  const roots = listFromEnv(env.OPENCODE_DATA_DIR);
  return [...new Set((roots.length ? roots : defaults).map((root) => canonical(expandHome(root, home))))];
}

/** Antigravity conversation directories (`ANTIGRAVITY_DATA_DIR`, else the known install roots). */
export function antigravityDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = historyHome(env);
  const configured = listFromEnv(env.ANTIGRAVITY_DATA_DIR);
  const roots = configured.length
    ? configured
    : [
        ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((name) =>
          path.join(home, ".gemini", name),
        ),
        path.join(home, ".config", "antigravity"),
      ];
  const dirs = new Set<string>();
  for (const root of roots) {
    const resolved = canonical(expandHome(root, home));
    const nested = path.join(resolved, "conversations");
    dirs.add(canonical(existsSync(nested) ? nested : resolved));
  }
  return [...dirs];
}
