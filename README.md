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

- Status bar: `pi ✎ writing store.ts +12 lines · following`.
- `ctrl+k a` (or a click on the status item): pin the editor. Pinned, the
  agent does not move it; at the end of the agent's turn it moves anyway.
- Command palette: `symbiosis: Go to the Agent's Last Edit`.
- Press a key in the buffer during a preview: the preview stops, the buffer
  is yours.
- Status bar `π symbiosis ● working`: the pi session the editor follows, by
  the open file: the session that wrote it, else the one whose folder holds
  it, else the most recent one. Click it or `ctrl+k g` to go to its herdr
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

## Test

```bash
npm test          # unit tests
npm run e2e       # a fake pi against a headless ttt; prints the output folder
PLAN_AT=26 PLAN_CLOSE_AT=34 HOLD_MS=4000 npm run e2e   # also opens the plan drawer
DIFF_AT=30 HOLD_MS=4000 npm run e2e                     # also shows the diff (ctrl+k w)
bash test/e2e/suggest.sh   # the same, for sessions and suggestions
```
