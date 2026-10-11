# Plan: symbiosis as its own app

Status: approved by the operator on 2026-10-11 (questions 1 to 12), then
changed after slice 2 (see "The change after slice 2"). Slice 1 is merged;
the launcher now opens a real pi beside ttt.

## What I understood

symbiosis felt like a messy herdr plugin: two programs side by side, held
together by herdr, with no clear answer to "where does it open". You want one
command of its own: ttt first, and pi beside it. herdr stays useful, but as an
option. A pi that you start yourself in a terminal stays first class: the
editor follows it too.

## The change after slice 2

Slice 2 built a chat panel in ttt for a pi in RPC mode. The operator tried it
and asked why anyone would use it instead of a terminal that runs the full pi.
Decided:

- **The panel goes** (operator: "Lets go with A. But B can be incorporated
  later on."). pi runs as a normal, full pi in its own pane; symbiosis is the
  editor side. A companion panel (B: links from pi's work into the editor) may
  come later.
- **The launcher makes the layout** in herdr or tmux. `layout` setting:
  `tabs` (default: pi in a tab of its own) or `split` (ttt left, pi right).
  The operator: "tabs as default. It was messy because of the split i think."
- **Goes:** `launcher/rpc.ts`, `launcher/backend.ts`, the ttt command-line
  dialogs, the chat panel (`pi/chat.ts`, `panel.bottom`).
- **Stays:** folder rules, config, "already open", `-c`, args after `--`, the
  model in the session record, `ctrl+k q` (now: stop pi's turn).
- **New:** the bar says `? waits for you` when pi shows a dialog.

## The decisions

| # | Question | Decision |
|---|---|---|
| 1 | Where it opens | A setting; default "here" (the pane you are in); `--tab` for one run |
| 2 | How you talk to pi | ~~A chat panel in ttt, pi in RPC mode~~ → pi's own terminal, in a pane the launcher makes |
| 3 | Where pi goes | ~~ttt's bottom panel~~ → `layout`: `tabs` (default) or `split` |
| 4 | What runs pi | ~~One process that stops pi with ttt~~ → the launcher starts pi in its pane and runs ttt; pi stays when ttt quits |
| 5 | A pi you started in a terminal | The editor follows it like any other session |
| 6 | Chat panel, first version | Dropped (see above) |
| 7 | Which folder | The argument, else the git root, else the current folder |
| 8 | Already open for that folder | Say where it runs (herdr or tmux pane) and stop; `--new` opens another |
| 9 | pi's session | New by default; `-c` continues; args after `--` go to pi |
| 10 | Language, install | TypeScript `launcher/main.ts`, run by pi's Node (22.19 or newer); a small `sh` shim `~/.local/bin/symbiosis` |
| 11 | Config | `~/.config/symbiosis/config.json`: `open`, `layout`, `piArgs`; flags win; a broken file stops the start |
| 12 | herdr | Optional: the action and key run `symbiosis --tab`; `install.sh` works without herdr; tmux works too |

## The command

```
symbiosis [folder] [--tab | --here] [--tabs | --split] [-c] [--new] [-- <pi args>]
```

1. Find the folder (decision 7) and read the config (decision 11).
2. Look for a record of a symbiosis already open for that folder
   (`~/.local/state/symbiosis/<hash>.json`: pid, host, pane). A live one: say
   where it runs and stop (decision 8). A dead one: remove it.
3. With `--tab` (or `open = "tab"`), inside herdr or tmux: open a new focused
   tab named after the folder that runs `symbiosis <folder> --here`, and exit.
   Outside both: say that a tab needs herdr or tmux, and open here.
4. Inside herdr or tmux: make pi's pane by `layout` and type the pi command
   (`pi [--continue] <piArgs> <args after -->`) into its shell. Outside both:
   print how to start pi.
5. Write the record, then run `ttt <folder>` in this pane as a child process,
   with the terminal passed through.
6. When ttt quits: remove the record, exit with ttt's code. pi stays in its
   pane.

## How the parts talk

- The pi extension in every pi writes its session record (`sessions/<id>.json`:
  pane, host, folder, model, working, `waiting`, plan, files) and the events.
- `ctrl+k q` writes `stop.json` `{id, to}`; the session `to` aborts its turn.
- pi emits `ui_prompt_start` / `ui_prompt_end` for every extension's dialog;
  the extension sets `waiting`, the plugin shows `? waits for you`.
- `ctrl+k g` goes to pi's pane (`herdr agent focus`, or tmux
  `select-window` + `select-pane`).

## Build order

Each slice is a branch and a pull request. You merge.

1. **The launcher** (merged, PR #3).
2. ~~The chat panel~~ → **the layout** (`feat/layout`): pi in a tab or a split,
   `--tab`/`--here`, stop key, `? waits for you`; the RPC parts removed.
3. **Install and herdr** (`feat/slice3-install`). `install.sh` installs the shim and works without
   herdr; the herdr action runs `symbiosis --tab`. Remove
   `herdr-plugin/scripts/open.sh` and `SYMBIOSIS_RATIO`. Rewrite the README
   around `symbiosis`.
4. **The demo** through the launcher.

## Tests

- Unit: arguments, folder (git root), config (missing, broken, layout, flags
  win), record (live, dead), layout command lines, stop file, pane from env.
- `test/e2e/app.sh`: fake herdr, tmux and ttt on PATH; tabs, split, `--tab`,
  tmux, neither, already open, a broken layout. No tokens.
- `test/e2e/stop.sh`: headless ttt, a FakePi dialog shows `? waits for you`,
  `ctrl+k q` aborts the turn.
- The existing e2e tests (run, demo, lag, tree, help, install) still pass.

## Costs

- Building and testing: no model tokens.
- Using it: the same as any pi session. A new session per run (decision 9)
  keeps each prompt small.

## Known limits

- The launcher types the pi command into a shell; a shell that changes the
  line (an alias for `pi`) changes what runs.
- pi's tab or pane stays after ttt quits; close it in herdr or tmux.
- "Already open" goes to the first one's pane only in the same herdr or tmux
  server; otherwise it says where it runs.
