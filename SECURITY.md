# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/Elesiann/usagemeter/security/advisories/new)
rather than in a public issue. Include the usagemeter version, your platform, and
the steps that reproduce the problem.

## What usagemeter handles

- **Your CLIProxyAPI management key.** It is declared `sensitive` in the
  plugin manifest, so Claude Code keeps it in secure storage, not in
  `settings.json`. usagemeter passes it to its helper through the child process
  environment, never on the command line, and never writes it to disk, the
  pane, or its saved snapshots.
- **Your OpenCode key**, only when `openCodeGo` is turned on: read from
  OpenCode's own `auth.json` (or `OPENCODE_API_KEY`) and sent only to
  `opencode.ai`.
- **Your local transcripts.** They are read on your machine and never leave
  it. The helper caches parsed token counts, not message content, in
  `~/.cache/usagemeter/`.

Responses from the hub and from providers are never shown or stored as they
came: errors carry fixed messages and, at most, a network error code.
