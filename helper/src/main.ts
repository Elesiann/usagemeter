// usagemeter-helper: the out-of-process half of the usagemeter mod. The mod runs it
// through $.process.run and reads one JSON document from stdout.
//
//   usagemeter-helper scan [--tz <zone>] [--refresh-rates]
//   usagemeter-helper limits      (hub URL and key from USAGEMETER_HUB_URL / USAGEMETER_HUB_KEY,
//                              OpenCode Go when USAGEMETER_OPENCODE_GO=1, hub autostart
//                              when USAGEMETER_HUB_AUTOSTART=1 with an optional USAGEMETER_HUB_BIN)
import * as os from "node:os";
import * as path from "node:path";

import { readLimits } from "./limits.ts";
import { loadRates } from "./rates.ts";
import { scan } from "./scan.ts";

export const OUTPUT_VERSION = 1;

function cacheDir(env: NodeJS.ProcessEnv): string {
  if (env.USAGEMETER_CACHE_DIR?.trim()) return env.USAGEMETER_CACHE_DIR.trim();
  const xdg = env.XDG_CACHE_HOME?.trim();
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".cache"), "usagemeter");
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
      hubUrl: env.USAGEMETER_HUB_URL,
      hubKey: env.USAGEMETER_HUB_KEY,
      openCodeGo: env.USAGEMETER_OPENCODE_GO === "1",
      hubAutostart: env.USAGEMETER_HUB_AUTOSTART === "1",
      ...(env.USAGEMETER_HUB_BIN?.trim() ? { hubBin: env.USAGEMETER_HUB_BIN.trim() } : {}),
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
