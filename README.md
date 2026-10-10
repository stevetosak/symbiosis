# symbiosis

The [pi](https://github.com/earendil-works/pi) coding agent works inside the
[ttt](https://tttedit.dev) editor. Each file the agent writes or edits types
itself into your editor while the model writes it. Then the editor goes to the
changed line. You read the code as it comes. You talk to pi in a terminal
docked in the editor, and you leave it suggestions as comments in the code.

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
- `ctrl+k h`: the chat, ttt's terminal docked right. Start `pi` in it.
- Write a comment that ends in `AI!` (change this) or `AI?` (answer this),
  after a line, above a block, or at the top of a file. `ctrl+k d` sends all
  of them to pi in one message. pi deletes each marker when it is done.

## Test

```bash
npm test          # unit tests
npm run e2e       # a fake pi against a headless ttt; prints the output folder
bash test/e2e/suggest.sh   # the same, for suggestions and the chat
```
