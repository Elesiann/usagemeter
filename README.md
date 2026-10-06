# ledger

A Claude Code mod that opens a `/ledger` pane with what your coding agents cost,
how many tokens they used, and how much of each plan limit is left, across
Claude Code, Codex, OpenCode and Antigravity.

```text
1: Cost  2: Tokens  3: Limits  │  r: 7 days  g: by model  u: refresh

$412.30                                  Daily cost
96 sessions · API estimate                $120 ┤██████████               $104
                                               ┤██████████            ▄▄▄▄▄▄▄▄▄▄    $92
● Claude Code 41 sessions  $371.80             ┤██████████     $61    ██████████ ▄▄▄▄▄▄▄▄▄▄
  90.2% of cost · 1.31B tokens             $60 ┤██████████            ██████████ ██████████
● Codex 55 sessions  $40.50                    ┤██████████ ██████████ ██████████ ██████████
  9.8% of cost · 0.82B tokens            $0.00 ┼██████████ ██████████ ██████████ ██████████
                                                                                    ▲
                                               Sep 29                Oct 2          Oct 5
```

Cost is an estimate at API list prices (LiteLLM's table), not what a
subscription bills. Requires Claude Code 2.1.287 or later and Node.js 22.5 or
later on `PATH` (the helper uses `node:sqlite`).

## Install

```bash
claude plugin marketplace add Elesiann/ledger
claude plugin install ledger@ledger
```

To try a checkout without installing, run `claude --plugin-dir ./ledger`.

## Use

Run `/ledger` (or `/ledger refresh`). The pane opens with the last snapshot and
refreshes it in the background when it is older than five minutes.

| Key | Does |
| --- | --- |
| `1` `2` `3` | Cost, Tokens, Limits |
| `r` | Cycle the range: past 24h (hourly), 7, 30, 90 days |
| `g` | Group the breakdown by model, provider or day |
| `h` `l` | Move the selected day (or hour) and show its top models |
| `u` | Refresh now |
| `Esc` | Close |

The pane needs focus for the keys: it takes it when opened from an empty
prompt, or press Ctrl+X then Tab. On a narrow terminal it opens above the
prompt; Ctrl+X then ← makes a docked pane wider.

## Limits

- **Claude**: every Claude account in the hub, or else this session's own
  5-hour and weekly windows (available after the session's first reply).
- **Codex**: every Codex account in the hub, with banked reset credits.
- **Antigravity**: every Antigravity account in the hub, one window per model
  family (Gemini, Claude + GPT). This reads Google's internal Code Assist
  `fetchAvailableModels` endpoint, which is undocumented and may change.
- **OpenCode Go**: optional, from OpenCode's own `auth.json` key or
  `OPENCODE_API_KEY`.

The hub is a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
instance. Configure it with `/plugin configure ledger@ledger`:

| Option | Default | |
| --- | --- | --- |
| `hubUrl` | `http://localhost:8317` | Hub base URL |
| `hubKey` | empty | Management key, stored in secure storage; empty skips the hub |
| `openCodeGo` | `false` | Read OpenCode Go limits |

## How it works

`hooks/` is the mod: it keeps the pane's state and draws it with text-only
charts, so it renders the same in the terminal and the Desktop app.
`helper/dist/ledger-helper.mjs` does the heavy part in a separate Node process:

- `scan` reads `~/.claude/projects`, `~/.codex/sessions` (and `$CODEX_HOME`),
  OpenCode's database and Antigravity's conversations, prices every response,
  and prints the four ranges as JSON. Parsed transcripts are cached in
  `~/.cache/ledger/scan-cache.json`, so only new lines are read again: a cold
  90-day scan of a few GB takes under a minute, a warm one a few seconds.
- `limits` asks the hub and OpenCode Go for plan limits. The hub key reaches it
  through the environment, never the command line.

The transcript parsing, deduplication and pricing are
[T3 Code](https://github.com/pingdotgg/t3code)'s, vendored under
`helper/src/t3/` (MIT); see the README there.

Unlike T3 Code, ledger does not read T3's own data directory, so Antigravity
sessions that T3 itself launched are not counted.

### Privacy

Transcripts are read locally and never leave the machine. The helper makes
three kinds of network requests: LiteLLM's public price table (once a day),
your hub's management API, and OpenCode's usage endpoint when enabled.

## Develop

```bash
npm install
npm test                  # helper tests (node:test)
claude plugin test .      # mod tests
npm run typecheck
npm run build             # rebuilds helper/dist/ledger-helper.mjs with Bun
```

The built helper is committed so an installed plugin needs no dependencies.
