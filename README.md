# symbiosis

The [pi](https://github.com/earendil-works/pi) coding agent works inside the
[ttt](https://tttedit.dev) editor. Run `symbiosis` in a project: ttt opens
there, and a real, full pi beside it. Each file the agent writes or edits types
itself into your editor while the model writes it. Then the editor goes to the
changed line. You read the code as it comes. The status bar shows which pi
session the editor follows; a pi you start yourself in any terminal works too.
A comment that ends in `helpi!` asks that session's model a question, and the
answer is written where you are.

Status: built, then used, then changed. See [docs/design.md](docs/design.md).

## Install

On Linux or macOS, one line:

```bash
curl -fsSL https://raw.githubusercontent.com/stevetosak/symbiosis/main/install.sh | sh
```

It installs ttt and pi when one is missing, the symbiosis pi package, and the
command `~/.local/bin/symbiosis`. It uses each tool's own official installer.
Each one is a script from the internet that runs on your machine, as this one
does; read [install.sh](install.sh) first if you want to.

The command is a link into pi's copy of the package
(`~/.pi/agent/git/github.com/stevetosak/symbiosis`), so the command, the pi
extension and the ttt plugin always come from one copy: `pi update` updates
all three. Each time pi starts, it copies the ttt plugin into
`~/.config/ttt/plugins/symbiosis` when ttt's copy differs, and says so; then
run "Plugins: Reload" in ttt.

Two steps the first time:

- ttt asks you to allow the plugin's permissions.
- pi needs a model: `/login`, or an API key.

**[herdr](https://herdr.dev) or tmux** is optional, and install.sh installs
neither. In one of them, pi gets a tab of its own; without them, symbiosis
opens ttt and tells you how to start pi in a second terminal.

**With herdr there**, install.sh also adds the symbiosis herdr plugin. Its
action **Open symbiosis** runs `symbiosis <folder> --tab` for the focused
pane's folder, or goes to the tab where symbiosis already runs for it.
install.sh binds it to `prefix+shift+s` (the prefix is `ctrl+b` by default),
unless the config already binds that key or the action; `SYMBIOSIS_KEY` picks
another key. herdr has no menu for plugin actions. To bind it yourself, in
`~/.config/herdr/config.toml`, then `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+shift+s"
type = "plugin_action"
command = "symbiosis.open"
description = "open symbiosis (ttt + pi)"
```

It asks one question: whether to install herdr's pi integration, which shows
pi's state (working, idle) in herdr's sidebar. symbiosis works without it. To
answer before it asks, set `SYMBIOSIS_HERDR_INTEGRATION=yes` or `=no`.
`herdr plugin install stevetosak/symbiosis/herdr-plugin` alone does the same
as install.sh, but cannot install pi (pi's installer asks questions on the
terminal, and herdr runs the plugin's build without one).

**By hand:** install ttt and pi, run
`pi install git:github.com/stevetosak/symbiosis`, then
`sh ~/.pi/agent/git/github.com/stevetosak/symbiosis/bin/setup.sh` (it copies
the ttt plugin and links the command).

**From a checkout** (to work on symbiosis): `npm run install:local`
(`--check` shows what it would do). It runs `pi install <checkout>`, so pi
loads the code from the checkout, copies the ttt plugin, links
`~/.local/bin/symbiosis` to the checkout, and removes the link
`~/.pi/agent/extensions/symbiosis` that older versions made (with it, pi would
load the extension twice). `/reload` in pi after a change.
`SYMBIOSIS_CHECKOUT=<checkout> sh install.sh` runs the full installer on it.

## The symbiosis command

```
symbiosis [folder] [--tab | --here] [--tabs | --split] [-c] [--new] [-- <pi args>]
```

It opens ttt in the folder and a real pi beside it. The folder is the
argument, else the git root, else this folder.

- In herdr or tmux, pi gets a tab of its own, "pi · <folder>", and ttt opens
  here (`--tabs`, the default). `--split`: this pane splits, ttt left, pi
  right. `--tab`: all of it in a new tab. Outside herdr and tmux, ttt opens
  alone and symbiosis prints how to start pi.
- `-c` continues pi's last session there, `--new` opens a second one,
  `-- <args>` go to pi.
- A second `symbiosis` for the same folder goes to the tab where the first one
  runs (herdr, tmux), or says where it runs.
- When ttt quits, pi stays: it is a full pi session in its own pane.
- Config: `~/.config/symbiosis/config.json`
  `{"open": "here" | "tab", "layout": "tabs" | "split", "piArgs": [...]}`.
  A flag wins over the config.

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
- The gutter marks the change being replayed: `▌` on each line of this
  change, `π` on the line being typed now. The marks go when the change ends
  (`ctrl+k w` shows it after). A line with another plugin's mark (a bookmark)
  keeps that mark.
- While a file is replayed, your typing in it waits (the bar says so); moves
  work. At the end of the replay the file comes from disk again.
- Autosave (on by default): a file is saved 1 s after you last typed in it,
  so pi's next write gets a preview and a reload. Never while pi changes that
  file. Off or 3 s in the panel.
- Status bar `π symbiosis ● working`: the pi session the editor follows, by
  the open file: the session that wrote it, else the one whose folder holds
  it, else the most recent one. Its name is pi's session name (`/name`), else
  the folder; two sessions with one name also show their pane. Click it or `ctrl+k g` to go to its herdr
  or tmux pane. `ctrl+k n`: the next session takes over (then back to
  automatic). `ctrl+k q` stops its turn, as Esc in pi does.
- `π symbiosis ? waits for you`: pi shows a dialog in its own pane (a guard's
  "Allow this one call?", a question) and waits. A notice says so with the
  dialog's title; `ctrl+k g` goes there.
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

## Run configurations

Run a project from ttt, as in Rider or VS Code (debugging comes later).

- `F5` runs the chosen configuration; with none chosen yet, it opens the
  picker. `shift+F5` stops it. `ctrl+k F5` (or a click on the status item)
  opens the picker: type to filter (Enter runs the first match), Tab to the
  list, Enter runs one and chooses it for `F5`, `s` saves a detected one to
  `.symbiosis/run.json`, `e` opens that file.
- Status bar: `▶ api` (chosen), `● api 0:42` (runs), `✓ api`, `✗ api 1`
  (its exit code), `+2` (others that run).
- The Run tab of the bottom panel: the runs, newest at the top, and the
  output of one. Up/Down choose a run, PgUp/PgDn/Home/End scroll (End
  follows the output again), `s` stops, `r` runs it again, `x` removes an
  ended run, `o` opens its whole log, Enter or a click opens a `file:line` from
  the output.
- `ctrl+q` while programs run asks: `s` stops them and quits, `k` keeps them
  running, Esc stays. Kept programs show in the Run panel the next time ttt
  opens the folder. When ttt quits without asking (ctrl+q from its terminal),
  the `symbiosis` command asks in the terminal instead.

Where the configurations come from, in the picker's order:

- `.symbiosis/run.json` (yours, "Saved"):

  ```jsonc
  {
    "configurations": [
      // "command" with "args": the program, no shell. "command" alone: a shell line.
      { "name": "api", "command": "npm", "args": ["run", "dev"], "cwd": "${workspaceFolder}/api",
        "env": { "PORT": "3001" }, "envFile": ".env" },
      { "name": "this test", "command": "node --test ${file}" }
    ]
  }
  ```

  Variables, as in VS Code: `${workspaceFolder}`, `${workspaceFolderBasename}`,
  `${file}`, `${relativeFile}`, `${fileBasename}`,
  `${fileBasenameNoExtension}`, `${fileDirname}`, `${fileExtname}`,
  `${lineNumber}`, `${env:NAME}`, `${pathSeparator}`.
- `.vscode/launch.json` (the `node`, `python`, `go`, ... programs it can run
  without a debugger) and `.vscode/tasks.json`.
- The file open: `node`, `python3`, `go run`, `bash`, `ruby`, ... by its
  extension (`.venv` python when there is one).
- The project's files, up to 3 folders deep (not `node_modules`, `target`,
  `dist`, ...): `package.json` scripts (npm, pnpm, yarn or bun, by the
  lockfile), `deno.json` tasks, `Cargo.toml`, `go.mod` (each `main`
  package), `*.csproj`/`*.fsproj` and their `launchSettings.json` profiles,
  Django's `manage.py`, `pyproject.toml` scripts, Gradle, Maven, `Makefile`,
  `justfile`, `Taskfile.yml`, `Procfile`, `compose.yaml`.

The workspace folder is the nearest folder above the open file with a
`.symbiosis/run.json`, else its git root. Each run gets a small supervisor
(`symbiosis run supervise`), so a program outlives ttt when you keep it; its
state and output are in `runs/` in the plugin's folder. From a terminal:
`symbiosis run ps --folder .`, `symbiosis run stop --folder . --all`.

## Demo

`npm run demo` opens a copy of a small to-do app with the `symbiosis`
command: ttt here, a scripted pi in its own tab. The scripted pi does a small
task while you watch in ttt, then answers your `helpi!` questions with set
answers. No model, no tokens, the same every time. `npm run demo -- --real`
gives the same task (`demo/PROMPT.md`) to a real pi, which costs tokens. See
`demo/README.md`.

## The ttt plugin

The plugin's sources are in `ttt/src`: a small host (`ttt/src/core`) and one
file per feature (`ttt/src/features`: the replay, helpi!, the sessions, the
plan, ...). ttt runs one Lua file per plugin, so `npm run build` bundles them
into `ttt/symbiosis/plugin.lua`, which is committed. Edit `ttt/src`, never
the bundle; `npm test` fails when the bundle is not up to date. How to add a
feature: `ttt/README.md`.

## Test

```bash
npm test          # unit tests; also the plugin's Lua tests (test/lua) when luajit is installed
npm run build     # bundles ttt/src into ttt/symbiosis/plugin.lua
npm run test:lua  # only the Lua tests: luajit test/lua/run.lua .
npm run e2e       # a fake pi against a headless ttt; prints the output folder
PLAN_AT=26 PLAN_CLOSE_AT=34 HOLD_MS=4000 npm run e2e   # also opens the plan drawer
DIFF_AT=30 HOLD_MS=4000 npm run e2e                     # also shows the diff (ctrl+k w)
bash test/e2e/help.sh      # helpi!: code, note, ask, Esc; only the session the editor follows answers
bash test/e2e/demo.sh      # the demo, with its three helpi! questions; the workspace tests must pass
bash test/e2e/lag.sh       # the replay behind pi (LAG=-1, SPEED=80); typing waits; buffer = disk at the end
bash test/e2e/tree.sh      # ttt's tree opens to pi's file; the "pi files" panel shows a file outside the folder
bash test/e2e/app.sh       # the symbiosis command, the herdr action and npm run demo, with fake herdr, tmux, pi and ttt: tabs, split, --tab, no multiplexer, already open
bash test/e2e/marks.sh     # the gutter: ▌ on the change's lines and π on the line typed now, none after
bash test/e2e/stop.sh      # "? waits for you" while pi shows a dialog; ctrl+k q stops pi's turn
bash test/e2e/runconf.sh   # run configurations: the picker, F5, shift+F5, a failing run, ctrl+q keeps a run, back in ttt it shows
sh test/e2e/install.sh     # install.sh in a throw-away HOME (stubs for curl, ttt, pi): without herdr, with it, twice, key taken, own command file
```
