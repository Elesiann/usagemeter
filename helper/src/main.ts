// ledger-helper: the out-of-process half of the ledger mod. The mod runs it
// through $.process.run and reads one JSON document from stdout.
//
//   ledger-helper scan [--tz <zone>] [--refresh-rates]
//   ledger-helper limits      (hub URL and key from LEDGER_HUB_URL / LEDGER_HUB_KEY,
//                              OpenCode Go when LEDGER_OPENCODE_GO=1)
import * as os from "node:os";
import * as path from "node:path";

import { readLimits } from "./limits.ts";
import { loadRates } from "./rates.ts";
import { scan } from "./scan.ts";

export const OUTPUT_VERSION = 1;

function cacheDir(env: NodeJS.ProcessEnv): string {
  if (env.LEDGER_CACHE_DIR?.trim()) return env.LEDGER_CACHE_DIR.trim();
  const xdg = env.XDG_CACHE_HOME?.trim();
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".cache"), "ledger");
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  const env = process.env;
  const startedAt = Date.now();
  if (command === "scan") {
    const timeZone = flag(args, "--tz") || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const dir = cacheDir(env);
    const rates = await loadRates(dir, startedAt, args.includes("--refresh-rates"));
    const result = await scan({ nowMs: startedAt, timeZone, rates: rates.table, cacheDir: dir, env });
    write({
      version: OUTPUT_VERSION,
      readAt: new Date().toISOString(),
      timeZone,
      scanMs: Date.now() - startedAt,
      rates: { status: rates.status, fetchedAt: rates.fetchedAtMs === null ? null : new Date(rates.fetchedAtMs).toISOString() },
      ...result,
    });
    return 0;
  }
  if (command === "limits") {
    const result = await readLimits({
      nowMs: startedAt,
      hubUrl: env.LEDGER_HUB_URL,
      hubKey: env.LEDGER_HUB_KEY,
      openCodeGo: env.LEDGER_OPENCODE_GO === "1",
      env,
    });
    write({ version: OUTPUT_VERSION, checkedAt: new Date().toISOString(), ...result });
    return 0;
  }
  write({ version: OUTPUT_VERSION, error: `Unknown command '${command ?? ""}'. Use 'scan' or 'limits'.` });
  return 2;
}

function write(document: unknown): void {
  process.stdout.write(JSON.stringify(document) + "\n");
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    write({ version: OUTPUT_VERSION, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  },
);
