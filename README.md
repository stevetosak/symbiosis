# symbiosis

The [pi](https://github.com/earendil-works/pi) coding agent works inside the
[ttt](https://tttedit.dev) editor. Each file the agent writes or edits types
itself into your editor while the model writes it. Then the editor goes to the
changed line. You read the code as it comes. pi runs in any terminal; the
status bar shows which pi session the editor follows, and you leave that
session suggestions as comments in the code.

Status: the first slice. Built, then used, then changed. See
[docs/design.md](docs/design.md).

## Install

Needs Node 24, pi 1.1 and ttt 1.7.

```bash
bin/run-node install.ts          # --check shows what it would do
```

This links `~/.pi/agent/extensions/symbiosis` to `pi/` and copies
`ttt/symbiosis/` to `~/.config/ttt/plugins/symbiosis`. Run it again after you
change the plugin. Then `/reload` in pi and start ttt again; ttt asks you to
allow the plugin's permissions.

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
- Write a comment that ends in `AI!` (change this) or `AI?` (answer this),
  after a line, above a block, or at the top of a file. `ctrl+k d` sends all
  of them to that session in one message. pi deletes each marker when it is done.
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
watch in ttt, then answers your `AI!` comments. No model, no tokens, the same
every time. `demo/PROMPT.md` is the same task for a real pi. See
`demo/README.md`.

## Test

```bash
npm test          # unit tests
npm run e2e       # a fake pi against a headless ttt; prints the output folder
PLAN_AT=26 PLAN_CLOSE_AT=34 HOLD_MS=4000 npm run e2e   # also opens the plan drawer
DIFF_AT=30 HOLD_MS=4000 npm run e2e                     # also shows the diff (ctrl+k w)
bash test/e2e/suggest.sh   # the same, for sessions and suggestions
bash test/e2e/demo.sh      # the demo, with an AI! comment; the workspace tests must pass
bash test/e2e/lag.sh       # the replay behind pi (LAG=-1, SPEED=80); typing waits; buffer = disk at the end
bash test/e2e/tree.sh      # ttt's tree opens to pi's file; the "pi files" panel shows a file outside the folder
```
