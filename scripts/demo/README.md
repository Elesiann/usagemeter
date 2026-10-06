# README images

The screenshots and the animation in `docs/images/` come from the real pane,
running on generated history and a fake CLIProxyAPI hub. Nothing in them is
real usage.

You need tmux, Python 3 with Pillow, and Chromium (set `CHROME` to its path if
it is not on `PATH` as `chromium`).

1. Generate 90 days of demo history and start the fake hub:

   ```bash
   node scripts/demo/gen.mjs /tmp/um-demo/home
   node scripts/demo/hub.mjs 18317 &
   ```

2. Write `/tmp/um-demo/settings.json`. It points the mod at the demo history
   and the fake hub, and turns off an installed copy of the plugin:

   ```json
   {
     "enabledPlugins": { "usagemeter@usagemeter": false },
     "pluginConfigs": { "usagemeter@inline": { "options": { "hubUrl": "http://127.0.0.1:18317", "hubKey": "demo" } } },
     "env": { "CODEX_HOME": "", "USAGEMETER_HOME": "/tmp/um-demo/home", "USAGEMETER_CACHE_DIR": "/tmp/um-demo/cache" }
   }
   ```

3. Run Claude Code in a 230×52 tmux window, open the pane with
   `/usagemeter refresh`, and capture each view with
   `tmux capture-pane -p -e > NAME.ansi` and `tmux capture-pane -p > NAME.txt`:

   ```bash
   tmux new-session -d -s demo -x 230 -y 52 \
     "COLORTERM=truecolor claude --plugin-dir . --settings /tmp/um-demo/settings.json"
   ```

4. Render, from a directory holding the captures:

   - `python3 render.py cost Updated cost.png` (and `tokens`, `limits Checked`)
     reads `shots/NAME.ansi` and `shots/NAME.txt` and writes a cropped PNG.
   - `python3 gif.py` reads `gif/f1…f6` (Cost, Tokens, Limits, then Cost at
     30 days, 90 days and 24 hours) and writes `gif/demo.gif`.

`ansi2html.py` turns a tmux capture into HTML; both scripts use it.
