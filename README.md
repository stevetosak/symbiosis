# symbiosis

The [pi](https://github.com/earendil-works/pi) coding agent works inside the
[ttt](https://tttedit.dev) editor. Each file the agent writes or edits types
itself into your editor while the model writes it. Then the editor goes to the
changed line. You read the code as it comes. pi runs in any terminal; the
status bar shows which pi session the editor follows. A comment that ends in
`helpi!` asks that session's model a question, and the answer is written
where you are.

Status: the first slice. Built, then used, then changed. See
[docs/design.md](docs/design.md).

## Install

On Linux or macOS, one line:

```bash
curl -fsSL https://raw.githubusercontent.com/stevetosak/symbiosis/main/install.sh | sh
```

- **Without [herdr](https://herdr.dev):** it installs herdr, ttt and pi, then
  the symbiosis herdr plugin.
- **With herdr:** it adds the plugin, and installs ttt or pi only if one is
  missing.

It uses each tool's own official installer. Each one is a script from the
internet that runs on your machine, as this one does; read
[install.sh](install.sh) first if you want to. It asks one question: whether
to install herdr's pi integration, which shows pi's state (working, idle) in
herdr's sidebar. symbiosis works without it. To answer before it asks, set
`SYMBIOSIS_HERDR_INTEGRATION=yes` or `=no`.

It also binds a herdr key to the action **Open symbiosis**: `prefix+shift+s`
(the prefix is `ctrl+b` by default). It does not change the config when the
key or the action is already bound there; `SYMBIOSIS_KEY` picks another key.
herdr has no menu for plugin actions, so a key or the command
`herdr plugin action invoke symbiosis.open` starts it. To bind it yourself, in
`~/.config/herdr/config.toml`, then `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+shift+s"
type = "plugin_action"
command = "symbiosis.open"
description = "open symbiosis (ttt + pi)"
```

Then, in herdr, press the key in a pane in your project. A tab opens in the
folder of the focused pane: ttt on the left, pi on the right. Two steps the
first time:

- ttt asks you to allow the plugin's permissions.
- pi needs a model: `/login`, or an API key.

**If you already use herdr:** `herdr plugin install stevetosak/symbiosis/herdr-plugin`
does the same, but cannot install pi (pi's installer asks questions on the
terminal, and herdr runs the plugin's build without one).

**Without herdr:** install [ttt](https://tttedit.dev) and
[pi](https://pi.dev), then `pi install git:github.com/stevetosak/symbiosis`.
Start `ttt .` and `pi` in two terminals in the same folder. Everything works
but the jump from ttt's bar to pi's pane.

**What goes where:** the pi package holds the extension and the ttt plugin.
Each time pi starts, it copies the plugin into `~/.config/ttt/plugins/symbiosis`
when ttt's copy differs, and says so; then run "Plugins: Reload" in ttt.

**From a checkout** (to work on symbiosis): `npm run install:local`
(`--check` shows what it would do). It runs `pi install <checkout>`, so pi
loads the code from the checkout, copies the ttt plugin, and removes the link
`~/.pi/agent/extensions/symbiosis` that older versions made (with it, pi would
load the extension twice). `/reload` in pi after a change.

## Use

- `ctrl+k h`: the symbiosis panel. Settings you change in place (Enter
  cycles a value: preview speed, autosave, pin), the pi sessions (Enter
  follows one), and every key. Up/Down move, Tab goes to the next list, Esc
  closes.

- Status bar: `pi ✎ writing store.ts +12 lines · following`.
- `ctrl+k a` (or a click on the status item): pin the editor. Pinned, the
  agent does not move it; at the end of the agent's turn it moves anyway.
- Command palette: `symbiosis: Go to the Agent's Last Edit`.
- The editor replays pi's changes at a speed you set, behind pi: the file on
  disk is where pi is now. pi waits only when more of its changes than your
  limit are not shown (3 by default; 0 = pi waits for each change; 10; no
  limit; in the panel). `ctrl+k -` slower, `ctrl+k =` faster (10 to 1280
  characters per second, then max), `ctrl+k space` pause (the replay only),
  `ctrl+k .` the rest of this change at once. The status bar shows
  `▶ 160/s · 2 behind` or `⏸ paused`; a click on it cycles the speed.
- While a file is replayed, your typing in it waits (the bar says so); moves
  work. At the end of the replay the file comes from disk again.
- Autosave (on by default): a file is saved 1 s after you last typed in it,
  so pi's next write gets a preview and a reload. Never while pi changes that
  file. Off or 3 s in the panel.
- Status bar `π symbiosis ● working`: the pi session the editor follows, by
  the open file: the session that wrote it, else the one whose folder holds
  it, else the most recent one. Its name is pi's session name (`/name`), else
  the folder; two sessions with one name also show their herdr pane. Click it or `ctrl+k g` to go to its herdr
  pane. `ctrl+k n`: the next session takes over (then back to automatic).
- `helpi!`: write a comment that ends in `helpi!`, for example
  `// make the folder helpi!`, and stop typing (600 ms) or press Enter at the
  end of the line. The session the editor follows asks its model in a side
  call (not in pi's conversation), with your line, the code around it, pi's
  plan and pi's last message. The model chooses the answer: **code** takes the
  place of your comment (a missing import goes in at the top; one ctrl+z
  brings your comment back), a **note** comes as `pi:` lines under it, or
  **ask**: the question goes to the session's agent, and its answer comes in
  pi. Until the answer starts, a line under the question shows
  `// pi ⠋ thinking · Esc stops`. The answer streams in at full speed; your
  keys in that file wait, Esc stops it. After ctrl+z, Enter at the end of the
  line asks again (the pause alone does not).
- Status bar `✓ 3 › ▶ Run the tests › Update the README +1`: pi's plan as a
  timeline, done › now › next. pi sends it with its `plan` tool for a task
  with several steps. `ctrl+k v` (or a click) shows the whole plan in a
  drawer; Esc closes it.
- `ctrl+k w`: what pi changed in its last turn, as a diff: the open file, or
  the last file pi changed if pi did not touch the open one.
- The file tree follows pi: when the editor follows pi into a file, ttt's
  tree opens to it, if the file is in a folder open in ttt (start ttt on a
  folder, or on several: `ttt ~/a ~/b`). The "pi files" tab in the sidebar
  shows the files each pi session changed (its last 20), by its folder, at
  any path: `▶` is the session the editor follows, `✎` the file pi changes
  now, Enter opens a file. While that tab is on screen, the tree stays on it.

## Demo

`npm run demo`: a scripted pi does a small task in a to-do app while you
watch in ttt, then answers your `helpi!` questions with set answers. No model, no tokens, the same
every time. `demo/PROMPT.md` is the same task for a real pi. See
`demo/README.md`.

## Test

```bash
npm test          # unit tests
npm run e2e       # a fake pi against a headless ttt; prints the output folder
PLAN_AT=26 PLAN_CLOSE_AT=34 HOLD_MS=4000 npm run e2e   # also opens the plan drawer
DIFF_AT=30 HOLD_MS=4000 npm run e2e                     # also shows the diff (ctrl+k w)
bash test/e2e/help.sh      # helpi!: code, note, ask, Esc; only the session the editor follows answers
bash test/e2e/demo.sh      # the demo, with its three helpi! questions; the workspace tests must pass
bash test/e2e/lag.sh       # the replay behind pi (LAG=-1, SPEED=80); typing waits; buffer = disk at the end
bash test/e2e/tree.sh      # ttt's tree opens to pi's file; the "pi files" panel shows a file outside the folder
sh test/e2e/install.sh     # install.sh in a throw-away HOME (stubs for curl, ttt, pi): with and without herdr
```
