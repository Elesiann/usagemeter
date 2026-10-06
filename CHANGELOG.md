# Changelog

All notable changes to usagemeter are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-06

First public release.

### Added

- Antigravity plan limits from a CLIProxyAPI hub: session (5-hour) and weekly
  windows for Gemini and for Claude + GPT models.
- `USAGEMETER_HOME` to read agent history from another home directory, such as a
  Windows profile seen from WSL.
- A clear message when Node.js is missing or older than 22.5.
- CI that type-checks, runs both test suites, validates the plugin and checks
  that the bundled helper matches its source.

### Changed

- The past-24-hours range covers the whole previous day, in 25 hourly buckets.
- The summary column aligns its values, and the chart beside it takes the
  same height.
- Plan limits are read again every time the pane opens.
- Narrow panes use shorter labels so rows fit.

### Removed

- The selectable day (`h`/`l`) in the Cost and Tokens tabs. Group the
  breakdown by day with `g` instead.

### Fixed

- Response bodies from the hub or a provider can no longer appear in an error
  message, the pane, or a saved snapshot.
- Merged chart columns (30 and 90 days on narrow panes) are scaled to their
  merged totals.
- Pressing `u` during a running scan schedules another scan instead of being
  ignored.

## 0.1.0 - 2026-10-05

### Added

- `/usagemeter` pane with Cost, Tokens and Limits tabs over 24 hours, 7, 30 and 90
  days, a stacked daily chart, totals, cost by type and speed, and a breakdown
  by model, provider or day.
- Local history for Claude Code, Codex, OpenCode and Antigravity, parsed and
  priced with code vendored from T3 Code.
- Plan limits for Codex and Claude accounts in a CLIProxyAPI hub, OpenCode Go,
  and the current Claude session.

[Unreleased]: https://github.com/Elesiann/usagemeter/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Elesiann/usagemeter/releases/tag/v0.2.0
