# Contributing

Thanks for helping. Bug reports, fixes and new history sources are welcome.

## Set up

You need Node.js 22.5 or later, [Bun](https://bun.sh) 1.4 (to bundle the
helper) and Claude Code 2.1.287 or later.

```bash
git clone https://github.com/Elesiann/usagemeter
cd usagemeter
npm install
claude --plugin-dir .      # loads your checkout; the mod reloads on save
```

## Layout

| Path | What lives there |
| --- | --- |
| `hooks/register.js` | The mod: commands, refresh logic, pane state |
| `hooks/view.js`, `hooks/charts.js`, `hooks/format.js` | Pure drawing code: plain data in, element tree out |
| `helper/src/` | The out-of-process helper (`scan`, `limits`) |
| `helper/src/t3/` | Parsing and pricing vendored from T3 Code; see its README before editing |
| `helper/dist/usagemeter-helper.mjs` | The bundled helper that ships with the plugin |
| `tests/` | Mod tests, run by `claude plugin test` |
| `helper/test/` | Helper tests, run by `node --test` |
| `scripts/demo/` | How the README images are made from demo data |

## Before you open a pull request

```bash
npm run typecheck
npm test                  # helper tests
claude plugin test .      # mod tests
claude plugin validate . --strict
npm run build             # then commit helper/dist/usagemeter-helper.mjs
```

CI runs the same steps and fails when the committed bundle does not match its
source. Add a line under `Unreleased` in `CHANGELOG.md` for any user-visible
change.

## Guidelines

- Keep the mod's drawing code pure: `view.js` and `charts.js` receive the
  resolved elements and plain state, never `$`.
- Anything read from a provider or the hub is untrusted: never put a response
  body into an error message, the pane, or a saved snapshot.
- Text-only charts keep the pane identical in the terminal and the Desktop app;
  prefer them over `Raster` or `Svg`.
