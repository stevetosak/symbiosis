# The demo

A small to-do app (`workspace/`) and one task in it. It shows the whole flow:
the plan, a new file typed into the editor, edits, the diff of the turn, and
your `AI!` comments going back to pi. Use it to try symbiosis, and to test it
after a change.

Two ways to run it. Both work in a copy, `/tmp/symbiosis-demo` (set
`DEMO_DIR` for another one), and make a new copy each time: the repo never
changes.

## A scripted pi (no model, no tokens)

```bash
npm run demo
```

1. The script prints `ttt /tmp/symbiosis-demo/store.ts`. Open that in ttt,
   in another herdr pane. When the status bar shows `π demo`, the editor
   follows the script, and it starts.
2. Turn 1: the plan in the status bar, `format.ts` typed in as a new file,
   then edits in `store.ts`, `cli.ts` (three in one call) and
   `store.test.ts`. Try the keys while it types: `ctrl+k -` / `ctrl+k =`
   (speed), `ctrl+k space` (pause the replay), `ctrl+k .` (the rest of this change at
   once), `ctrl+k v` (the plan), `ctrl+k h` (the panel). The script runs
   ahead of the editor: the bar shows `· 2 behind`, and its log says how
   long pi waited. "pi ahead (max)" in the panel sets the limit (0 = pi
   waits for each change). Typing in the replayed file waits.
3. At the end of the turn: `ctrl+k w` shows the diff of the turn.
4. Then you: write a comment that ends in `AI!` or `AI?`, for example
   `// add remove(id) AI!` above `list()` in `store.ts`, and press
   `ctrl+k d`. The script gets the message pi would get, deletes the
   marker and adds `remove(id)` with a test. It does not read your note: the
   change is always the same. Send more as often as you like; `ctrl+c` ends
   the demo.

The script always does the same thing, so it is the one to test with.
`PAUSE_MS` sets the time between steps (default 1500).
`test/e2e/demo.sh` runs it against a headless ttt and checks the end result.

## A real pi

```bash
npm run demo -- --reset          # only make a fresh copy
cd /tmp/symbiosis-demo && pi     # then /name demo, and give it PROMPT.md
```

Open `store.ts` in ttt as above. `PROMPT.md` is the same task as the script,
so you see the real agent do it: different every time, and it costs tokens.
