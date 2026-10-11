# Plan: symbiosis as its own app

Status: approved by the operator on 2026-10-11. Decided in the design
session of 2026-10-11 (questions 1 to 12). Nothing below is built yet.

## What I understood

symbiosis feels like a messy herdr plugin: two programs side by side, held
together by herdr, with no clear answer to "where does it open". You want one
experience of its own: ttt first, with the whole screen, and pi as the backend.
You talk to pi in a chat panel inside ttt. herdr stays useful, but as an
option. A pi that you start yourself in a terminal stays first class: the
editor and the chat can follow it too.

## The decisions

| # | Question | Decision |
|---|---|---|
| 1 | Where it opens | A setting; default "here" (the pane you are in); `--tab` for one run |
| 2 | How you talk to pi | A chat panel in ttt; pi runs headless (`pi --mode rpc`) behind it |
| 3 | Where the chat goes | ttt's bottom panel, docked right (an editor tab if that fails) |
| 4 | What runs pi | One process: `symbiosis` starts pi, runs ttt as its child, stops pi when ttt quits |
| 5 | A pi you started in a terminal | Full chat: its stream shows, your messages go to it; its dialogs stay in its terminal |
| 6 | Chat panel, first version | Messages, streamed markdown, one line per tool call, header, sticks to the end + PgUp/PgDn, Esc stops the turn, dialogs as ttt dialogs, thinking collapsed, `/` commands sent as typed |
| 7 | Which folder | The argument, else the git root, else the current folder |
| 8 | Already open for that folder | Go to it (herdr, tmux); else say where it runs; `--new` opens another |
| 9 | pi's session | New by default; `-c` continues; `/resume`; args after `--` go to pi |
| 10 | Language, install | TypeScript `launcher/main.ts`, run by pi's Node (22.19 or newer); a small `sh` shim `~/.local/bin/symbiosis` |
| 11 | Config | `~/.config/symbiosis/config.json`: `open`, `piArgs`; flags win; a broken file stops the start |
| 12 | herdr | Optional: the action and key run `symbiosis --tab`; sidebar state; `install.sh` works without herdr |

## The command

```
symbiosis [folder] [--tab] [-c] [--new] [-- <pi args>]
```

1. Find the folder (decision 7) and read the config (decision 11).
2. Look for a record of a symbiosis already open for that folder
   (`~/.local/state/symbiosis/<hash>.json`: pid, host, pane). A live one: go to
   it and exit (decision 8). A dead one: remove it.
3. With `--tab` (or `open = "tab"`), inside herdr or tmux: open a new tab that
   runs `symbiosis <folder>` without `--tab`, and exit. Outside both: say that
   a tab needs herdr or tmux, and open here.
4. Start `pi --mode rpc` in the folder, with `piArgs`, `-c` and the args after
   `--`.
5. Write the record, then run `ttt <folder>` in this pane as a child process,
   with the terminal passed through.
6. While ttt runs: pass messages between the plugin and pi (see below), and
   answer pi's dialogs through the plugin.
7. When ttt quits: close pi's stdin (pi saves the session and exits), remove
   the record, exit with ttt's code. Ctrl+c and SIGTERM do the same.

## How the parts talk

```
            ttt plugin (Lua)
        ▲ chat/<session>.jsonl      │ requests
        │ dialogs                   ▼ (prompt, abort, dialog answer)
  pi extension ◀── same channel ──▶ symbiosis launcher ──stdin/stdout──▶ pi --mode rpc
  (in every pi)                                                          (the backend)
```

- **Chat content comes from the pi extension, for every pi.** The extension
  already sees each session's events. It writes the chat to the channel: your
  messages, text deltas, one line per tool call, working/idle, model. So the
  panel is the same for the backend pi and for a pi in a terminal (decision 5).
- **Your messages:**
  - backend pi: plugin → launcher → RPC `prompt` (with `streamingBehavior:
    "followUp"` while pi works). RPC runs `/` commands without a model call.
  - pi in a terminal: plugin → its extension → `pi.sendUserMessage` (followUp
    while it works), the way a helpi! "ask" works today.
- **Esc (stop the turn):** backend → RPC `abort`; terminal pi → its extension
  calls `ctx.abort()`.
- **Dialogs** (`confirm`, `select`, `input`, `editor`) of the backend pi:
  launcher → plugin → `ttt.confirm`, a list, or the command line → launcher →
  `extension_ui_response`. A terminal pi asks in its own terminal; the panel
  says "pi waits for your answer in its terminal".
- **The panel follows the session the editor follows.** `ctrl+k n` changes
  both.

## Build order

Each slice is a branch and a pull request. You merge.

1. **The launcher, no chat yet.** `launcher/main.ts`: arguments, folder,
   config, record, start pi in RPC mode, run ttt, stop pi. A small JSONL client
   of our own (pi's `RpcClient` cannot answer dialogs). Dialogs are answered in
   ttt from the start, so the backend pi never hangs. Prompts are typed in a
   temporary one-line command (`ctrl+k i`), so the slice is usable.
2. **The chat panel.** Chat events in the channel, the panel (tail rendering,
   PgUp/PgDn, header, tool lines, input, Esc), prompts for both kinds of pi.
3. **Install and herdr.** `install.sh` installs the launcher and the shim and
   works without herdr; the herdr action runs `symbiosis --tab`; "already open"
   goes to the pane in herdr and tmux; sidebar state with `herdr pane
   report-agent`. Remove `herdr-plugin/scripts/open.sh` and `SYMBIOSIS_RATIO`.
   Rewrite the README around `symbiosis`.
4. **The demo.** `npm run demo` starts the launcher with the fake pi as the
   backend, so the demo shows the chat too.

## Tests

- Unit: arguments, folder (git root), config (missing, broken, flags win),
  record (live, dead), JSONL framing (no split on U+2028), dialog mapping.
- A fake RPC pi (a Node script that speaks the JSONL protocol): the launcher
  starts it, a headless ttt runs, a prompt goes in, a dialog is answered, ttt
  quits, the fake pi gets stdin closed. No tokens.
- Headless ttt e2e for the chat panel: streaming, tail, scroll, input, Esc,
  a terminal pi (FakePi) and the backend.
- The existing e2e tests (run, suggest, demo, lag, tree, help, install) still
  pass.
- One real check at the end: one prompt through the real backend pi.

## Costs

- Building and testing: no model tokens, apart from the last real check: about
  14k tokens (about $0.07 on Opus), measured in the spike.
- Using it: the same as any pi session. A new session per run (decision 9)
  keeps each prompt small.

## Checks still open (done during the build)

- Picking the plugin's "pi" tab from the plugin (the spike used a mouse
  click); if impossible, ttt's memory of the last tab may be enough.
- `/model` and other built-in commands in RPC mode, and the `set_model` command.
- `/` commands sent to a terminal pi with `pi.sendUserMessage`: they may arrive
  as plain text.
- herdr: focusing a pane that runs ttt by its id; `herdr pane report-agent`.
- tmux: switching to a pane in another window or session.

## Known limits of the first version

- Quitting ttt in the middle of a turn stops that turn (decision 4).
- The input is one line; long or pasted prompts come later.
- No history of earlier sessions in the panel; with `-c` it shows only
  "continued session · N messages".
- A terminal pi's dialogs are answered in its terminal.
