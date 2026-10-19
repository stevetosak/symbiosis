# The demo

A small to-do app (`workspace/`) and one task in it. It shows the whole flow:
the plan, a new file, edits, the diff of the turn, and
your `helpi!` questions answered where you write them. Use it to try symbiosis, and to test it
after a change.

Two ways to run it. Both open it with the `symbiosis` command: ttt here,
pi in a tab of its own (`--split`: on the right; `--tab`: all of it in a new
tab). Both work in a copy, `/tmp/symbiosis-demo` (set `DEMO_DIR` for another
one), and make a new copy each time: the repo never changes. While a demo
runs, a second one stops and says where the first runs.

For stubs, proposals and functions from a description there is a second
demo with its own workspace: `npm run demo -- --stubs`, see
[STUBS.md](STUBS.md).

## A scripted pi (no model, no tokens)

```bash
npm run demo                 # or: npm run demo -- --split
```

1. ttt opens the copy here; the scripted pi (`demo/scripted-pi`) starts in
   the tab `pi · symbiosis-demo` and prints what it does there. When the
   status bar shows `π demo`, the editor follows it, and it starts. Outside
   herdr and tmux, ttt opens alone and the command prints how to start the
   scripted pi in a second terminal.
2. Turn 1: the plan in the status bar, `format.ts` written as a new file,
   then edits in `store.ts`, `cli.ts` (three in one call) and
   `store.test.ts`. The editor stays where you are; the bar says which file
   pi writes. Try `ctrl+k a` (the editor follows pi), `ctrl+k v` (the plan),
   `ctrl+k h` (the panel).
3. At the end of the turn: `ctrl+k w` shows the diff of the turn.
4. Then you: in `store.ts`, on a new line above `list()`, write a comment
   that ends in `helpi!` and stop typing (or press Enter). The script's
   "model" has three set answers, by a word in your comment:
   - `// remove a to-do by id helpi!`: **code**, `remove(id)` takes the
     place of the comment. One ctrl+z brings the comment back.
   - `// why does list() copy? helpi!`: a **note**, `pi:` lines under it.
   - `// write a test for remove helpi!`: **ask**, the question goes to the
     session as a message, and the script's turn writes the test.
   While the "model" thinks (0.8 s), a `// pi ⠋ thinking` line shows under
   your question. Esc stops an answer. After ctrl+z, Enter at the end of the
   line asks again. Ask as often as you like; `ctrl+c` in its tab ends the demo; so does quitting ttt.

The script always does the same thing, so it is the one to test with.
`PAUSE_MS` sets the time between steps (default 1500).
`test/e2e/demo.sh` runs it against a headless ttt and checks the end result.

## A real pi

```bash
npm run demo -- --real
```

The same, with a real pi that gets `PROMPT.md` (the same task as the
script) as its first message and starts at once, named `demo`. It is
different every time, and it costs tokens: about 14k for the first prompt
(about $0.07 on Opus), more for the whole task.

`npm run demo -- --reset` only makes a fresh copy, for a pi you start
yourself.
