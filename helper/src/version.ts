import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

export interface VersionMetadata {
  readonly version: string;
  readonly sha: string;
  readonly dirty: boolean;
}

export async function readVersionMetadata(pluginRoot: string): Promise<VersionMetadata> {
  const manifestText = await readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8");
  const manifest = JSON.parse(manifestText) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("The loaded plugin manifest has no version.");
  }

  try {
    const git = (args: string[]) => execFileSync(
      "git",
      ["-C", pluginRoot, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const sha = git(["rev-parse", "--short=12", "HEAD"]);
    const dirty = git(["status", "--porcelain", "--untracked-files=all"]).length > 0;
    return { version: manifest.version, sha, dirty };
  } catch {
    throw new Error("Could not identify the loaded plugin's Git commit.");
  }
}
