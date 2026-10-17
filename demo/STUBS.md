# The stubs demo

A shopping cart (`stubs-workspace/`) with functions left for pi to write: five
stubs and one description in `cart.ts`, one stub and one description in
`tools/report.py`. A real pi waits in its own tab and gets no task: each fill
starts from the editor. The run below goes through every part of the
workflow, the guard and each kind of proposal included. Each fill is a model
turn, so the demo costs tokens.

```bash
npm run demo -- --stubs              # or: npm run demo -- --stubs --split
```

The copy is `/tmp/symbiosis-stubs` (`DEMO_DIR` for another one), made fresh
each time. pi loads the symbiosis extension from the checkout pi's settings
point at, and copies its ttt plugin into ttt when they differ; after such a
copy, run "Plugins: Reload" in ttt. Wait for `π stubs ○ idle` in the status
bar before the first step: the editor follows that session.

Two things help while testing. `ctrl+k h` opens the panel with the setting
"Stub scope". pi's own tab shows the fill message it got, each tool call, and
the guard's reason for each blocked call, word for word.

## 1. A stub filled from helpi!

In `cart.ts`, go to the end of the `// TODO(pi)` line in `subtotal` and type
` helpi!`. After a short pause the marker goes, the file is saved, and a
notice says `pi fills the stub at line 14 of cart.ts`. No side call runs: the
editor sees the stub itself. The status bar shows `· filling subtotal` while
pi works, the body is typed in by the replay, and the `filling` part goes
away at the end of pi's run, as the body is no longer a stub. A `why`, if pi
gave one, shows as a notice.

## 2. ctrl+k f, and a fill that runs the tests

Put the cursor anywhere in `total` and press `ctrl+k f`. Same flow, from the
palette key instead of the word. pi may run `node --test` on its own: the
`total` test passes once the body is in; the other tests still fail, which is
expected.

## 3. A new declaration: accept

Fill `applyCoupon` (` helpi!` on its marker line). Its doc asks for a table of
coupons "that the rest of the module can use too", so a good answer puts the
table outside the function. The guard blocks that edit (pi's tab shows
`new_decl`), and pi calls `propose`: a drawer on the right shows the kind,
the target (the table's name), what and why. Type a note, for example
`call it COUPONS`, and press Enter: that accepts. The table and the body go
in. The acceptance is good for that one change only: a second new
declaration would be blocked again.

## 4. A dependency: reject with a note

Fill `formatOrderDate`. Its doc names the date-fns package, which is not in
`package.json`, so the import is blocked as a `dependency` and pi proposes
it. This time press Tab to reach the buttons, type nothing, and choose
Reject; or type `use Intl.DateTimeFormat` in the note first, then Tab and
Reject. pi gets "Rejected" with the note and writes the body without the
package.

## 5. A signature change, and a proposal answered later

Fill `formatPrice`. Its doc wants an optional currency, which the signature
does not have, so pi proposes a `signature` change. Press Esc: the drawer
closes, but the proposal waits, and the status bar shows `? pi proposes a
signature change`. Press `ctrl+k p` (or click that item) to see it again, then
accept. The new parameter and the body go in, and the `formatPrice` test
passes.

## 6. A function from its description

At the bottom of `cart.ts`, end the comment `// a function that groups the
items by category ...` with ` helpi!` and pause. This time a side call runs
(a short `thinking` line under the comment) and answers `function`. The
marker goes, nothing is written under the comment, and a notice says
`pi writes the function described at line 48 of cart.ts`. The status bar
shows `· writing a function that groups the items…` and then the new
function's name. pi writes the signature and the body directly under the
comment, which stays as its doc. A helper beside it is blocked as
`new_decl`, as in step 3.

Try the two places that are refused, each with a notice from pi: a comment
directly above an existing function (no blank line between: it is that
function's doc), and a comment inside a function body (there the side call
usually answers `code` instead, which is the older in-place snippet).

## 7. Python

Open `tools/report.py`. Fill `parse_line` (` helpi!` on its `# TODO(pi)`
line), then end the description `# a function that reads a cart file ...`
with ` helpi!`. Both work as in TypeScript. `python3 tools/report.py` runs the
file; `tools/cart.csv` has two good lines and a bad one.

## 8. The guard's limits

Start a fill (any stub left, or reset the demo with `npm run demo -- --stubs`)
and try these while pi works, or just after the fill message, from pi's tab:

- **Another tool.** Ask pi to change `TAX_RATE` with `sed`. The change is
  undone, and the tool's result tells pi why.
- **Release.** Run "symbiosis: Release the Fill" from the palette. A notice
  says the fill is released, the status bar drops `filling`, and pi may edit
  anything again.
- **Scope.** In the panel (`ctrl+k h`), set "Stub scope" to `the stub's file`:
  a private helper next to the stub now goes in without a proposal. Set it to
  `anywhere (no guard)`: nothing is checked. Set it back to `the stub's body`
  after.
- **No editor.** Quit ttt while pi waits on a proposal: the proposal is
  rejected within about 1.5 s, as no one can answer it.

## 9. What changed, and why

`ctrl+k w` shows the diff of pi's last turn, and a notice lists the `why` pi
gave for each change.
