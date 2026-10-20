# symbiosis: the design

## The goal

You read the agent's work in your editor while it works. pi writes to disk
at once and never waits for the editor. The editor stays where you are and
tells you which file pi writes; what pi changed in its last turn is the
diff key (`ctrl+k w`). When you want to follow pi, `ctrl+k a` makes the editor
open each file and type pi's change in it as a preview, at a speed you set.

## The parts

| Part | File | Job |
|---|---|---|
| pi extension | `pi/index.ts` | Reads the tool calls. Writes events. Wires `core/` into pi. |
| Protocol | `core/protocol.ts` | Types only: every event and record that crosses the channel, and `PROTOCOL`. |
| Calls | `core/call.ts` | Pure: a call's absolute path, and the first line of a tool result. |
| Stream | `core/stream.ts` | Pure: a tool call's arguments as pi streams them, as `text` events (what grew since the last); Adler-32 of a file. |
| Channel | `core/channel/channel.ts` | The interface the agent side talks to: send events, publish the session, read the editor's state and requests. |
| File channel | `core/channel/file.ts` | The one implementation: files in the plugin folder, `events.jsonl`, `head.json`, `ttt.json` (the stub scope), `fill.json` (a fill and its release), `answer.json` (the answer to a proposal). |
| helpi! | `core/help.ts` | Pure: the request, the side call's prompt, the answer parser (kind, imports, body). |
| Syntax | `core/syntax/` | tree-sitter (WASM): a file's outline (functions with signature, body, intent, stub flag; imports; declarations). One file per language in `languages/`. |
| Stubs | `core/stubs.ts` | Pure: find a stub on a line, find it again after an edit, the fill message. |
| Places | `core/place.ts`, `core/target.ts` | Pure: the description that ends on a line, the new function under it found again by the description's text, its message; `target.ts` names either kind of fill target. |
| Imports | `core/imports/` | One policy per language: does a new import resolve to the project, the standard library or the manifest. |
| Scope guard | `core/guard.ts` | Pure: is an edit or write inside the stub being filled; what blocks it and which `propose` kind lifts that. |
| Fill | `core/fill.ts` | One fill (a stub, or a new function under its description): starts it from a line, checks each call with the guard, keeps the accepted proposals, knows when the work is done. |
| Tools | `pi/tools.ts` | pi's own `edit` and `write` again, with a `why` argument and one call at a time; a probe that tells what an edit would leave in the file. |
| Filling | `pi/fill.ts` | The pi side of a fill: the fill request, the guard before each call, the `propose` tool that waits for the editor's answer. |
| Hunks | `core/hunks.ts` | Pure: the lines a change touched (a line diff, by the `diff` package), and where an old line stands after a later change. |
| Launcher | `launcher/main.ts` (`bin/symbiosis`) | Starts a real pi in its own herdr or tmux pane, runs ttt here as its child, ends when ttt quits. One record per folder in `~/.local/state/symbiosis/`. |
| Layout | `launcher/layout.ts` | Pure: the herdr and tmux command lines for a pi tab, a split, or a new tab for symbiosis itself. |
| ttt plugin | `ttt/src` (bundled into `ttt/symbiosis/plugin.lua`) | Polls every 40 ms. Shows which file pi writes. When you follow pi, types its changes as a preview. Sends helpi! questions and writes the answers. A host (`ttt/src/core`) and one module per feature (`ttt/src/features`); see `ttt/README.md`. |

A ttt plugin cannot open a socket and can read only its own folder and the
workspace. Thus the channel is files in the plugin folder.

`core/` holds what does not depend on pi: the protocol, the channel, and the stub rules (syntax, imports,
guard). It imports nothing from pi, so
another agent harness, or a socket in place of the files, is a new adapter or
a new `Channel` implementation, not a change to the rules. `pi/` holds only
what speaks pi: the extension, its `plan` tool, the change log it keeps for
the editor, and the setup.

## The buffer: one rule

**The file on disk is the truth. The preview is never saved.** pi does not
wait for the editor. Each `write` and `edit` goes to disk at once; the
extension sends what pi streams too, so the editor can show the change
while the model writes it. The events of one call:

1. `start`: the model started a call on a file (`call`, `tool`, `path`, and
   the file's Adler-32 `sum` and text `before`, up to 256 KB). The plugin
   notes that the file has a call open, so autosave does not save over it,
   and the bar says `pi ✎ writing store.ts`.
2. `text`: a part of the arguments (`key`: `content`, `edits.0.oldText`,
   `edits.0.newText`, ...; the value is its first `from` bytes, then `text`).
   Only the session the editor follows streams.
3. `ready`: the arguments are complete. `abort`: the call will not run (the
   stub guard blocked it, or the turn ended first), with the `reason`.
4. `done`: the call ended (`ok`, the first changed `line`, the `why`, the
   `sum` of the file now). The bar says `pi ✎ store.ts:12`. ttt reloads the
   file when its buffer has no unsaved changes.
5. `stop`: the turn ended; the bar shows `pi ■ store.ts:12`.

When the editor does not follow pi, that is all: nothing is typed, nothing
moves. When it follows (below), the plugin types the call in the buffer:

- At `start` it opens the file. If the buffer is neither `before` nor the
  file as pi last wrote it (the `sum` of the last `done`), it has unsaved
  changes: no preview for this call, and a warning.
- A run starts: one undo group. If pi already changed the file again, the
  plugin first sets the buffer to `before`, so the change shows from the
  text pi started from. A write clears the buffer and types the new
  content. An edit selects its `oldText` (only if it occurs once), then
  types `newText` over it. The next call to the same file types on top, in
  the same run, as pi did on disk.
- The tool writes the file at once. ttt says the file changed on disk under
  the preview; the plugin clears that notice.
- The run ends when the preview goes to another file, at the end of the
  turn, at an `abort`, or when it has shown all that pi sent. Then the plugin
  closes the undo group, undoes it (the buffer is clean but old), closes the
  tab and opens the file again: ttt reads it from disk, at the changed line.
- pi's `why` for a change shows when you see the change: at once when not
  following, else at the end of the run (hook `shown`).

Measured with headless ttt 1.7.1: a disk change under a dirty buffer gives a
notice ("changed on disk; you have unsaved changes", about 4 s over the
status bar) and no reload; a later undo leaves a clean but old buffer.
Closing the tab and opening the file again reloads it. `ttt.notify("")`
clears the notice. There is no revert command.

History: the first preview made pi wait for it (later: up to a limit). The
operator found the editor hopped to the next file while he tried to read
code, and the typing tied the editor to pi's speed, so it was removed
(2026-10) and the editor stayed put. It came back (2026-10) behind the
follow switch: off, the editor is yours and pi writes in the background; on,
you watch pi type. pi never waits for it.

## Following and the preview

The setting "Editor" (`ctrl+k a`, or a click on the status item): `stays`
(the start value) or `follows pi`. It is not kept in `settings.json`: each
start of ttt stays.

- On: the editor jumps to now. The calls pi has open are typed from their
  start; the changes pi finished while you did not follow are not typed
  (they are in the change list, `ctrl+k v`, and the diff, `ctrl+k w`). With
  no call open, the editor goes to pi's last change.
- Off: the preview ends at once (undone, the file from disk) and nothing is
  queued. pi writes on in the background.
- The preview is behind pi: the plugin reads the events into a queue and
  types it at the speed you set. The bar shows the speed and how many
  changes wait: `▶ medium · 2 behind`. `ctrl+k space` skips them: the
  preview types what pi writes now (with follow off, it turns follow on).
- While the preview types in a file, your typing in it waits (characters,
  Enter, Tab, Backspace, Delete, ctrl+v/x/z/y/s): the buffer is the preview,
  and pi has already changed the file on disk. The bar says
  `your typing waits`. Moves still work. `ctrl+k a` ends the preview.
- While it types, the bar names the file, the lines it adds and the step of
  pi's plan under way: `pi ✎ writing store.ts +4 lines · step 2/5 Add done(id) · following`.
- A failed call opens nothing.

The speed (`ctrl+k -` slower, `ctrl+k =` faster, or "Preview speed" in the
panel): slow (40 characters a second), medium (160, the start value), high
(640), uncapped (as fast as pi sends). It is kept in `settings.json`. Only
the text the preview shows costs time: a write's content and an edit's new
text. Every other event waits for the text before it. At most 0.2 s of
typing is saved up, so a quiet moment gives no burst.

## The panel, autosave, names

Operator feedback: the keys were not visible anywhere, and each setting key
showed a ttt notice that covers the whole status bar for about 4 s (measured),
so the new value was hidden. Now:

- `ctrl+k h` opens a drawer: Settings (a `list`; Enter cycles the value), pi sessions (Enter follows one, or "automatic"),
  and a key list. ttt calls a drawer's render on every frame, so render
  reads no files. Measured in ttt 1.7.1: a `button` keeps its first label
  after a redraw, a `list` item does not, so the settings are list items;
  Enter on a list item comes as `on_command("activate")`, `on_select` fires
  when the highlight moves.
- No notice for a setting or a session change: the status bar shows it at
  once.
- Autosave (ttt has none): after a key that changes text (a character,
  Enter, Tab, Backspace, Delete; no ctrl or alt), the plugin saves the file
  after 1 s (or 3 s, or off), only if the file is still open and pi has no
  call open in it. A clean
  buffer is what ttt's reload needs.
- Session names: the record carries pi's session name (`title`, from
  `pi.getSessionName()` and `session_info_changed`). The plugin shows the
  title, else the folder, and adds the herdr pane (or pid) when two sessions
  would show the same name.

## Panels wrap their text

ttt's `label`, `list` and `tree` widgets draw one row and cut what does not
fit (`internal/widgets/label.go`: height 1, text cut at the width), so a long
step title, a question or a "why" lost its end at the drawer's edge. The
plugin wraps its own text (`ttt/src/core/wrap.lua`): `wrap.label(panel, spec)`
gives one label for each line, `wrap.items(items, panel width)` splits a
list or tree row into the row and continuation rows, and `wrap.pairs` leaves
the keyvalue for a pair that does not fit. The width is `panel:size()`; a
row loses `ROW_CHROME` columns to ttt's own marks (measured: the drawer
inner width is 46 for a 48 request, and a row has room for 40).
A continuation row has the id of its row plus `\31` and a number, so a click
on it is a click on the row: a handler asks `wrap.id(node.id)`. A tree node's
continuation rows are its first children (children come right after their
node, so a sibling would land after them). Not wrapped: `markdown` (ttt wraps
prose itself; a fenced code line is not cut: it clips at the edge) and the
run panel's raw cell rows (its output wraps by default; `w` cuts instead; the
choice is saved as `nowrap` in its layout file).

## The other rules

- pi runs the calls of one message in parallel; `start` and `done` (or
  `abort`) count the calls open in each file, so the file counts as open
  until the last ends.

## Known weak points

- A file with unsaved changes is not reloaded: ttt shows its notice, and the
  buffer stays old until you save or close it.
- Two sessions in the same folder: the most recent one wins until you choose.
- The reveal moves the sidebar to the explorer, also from Find or Changes.
- The "pi files" tab is hidden behind `»` in a narrow sidebar.

## Slice 2: sessions

**Sessions.** pi runs in any terminal; you watch it there. (A chat panel in
ttt was tried and dropped: it took space from the code.) Each pi writes
`sessions/<id>.json` every second: id, protocol version, herdr pane
(`HERDR_PANE_ID`), folder, working or idle. The plugin picks one session, the
**owner**, and writes its id to `ttt.json`:

1. the session you chose with `ctrl+k n` (it cycles through the sessions, then
   to **detached**, then back to automatic). Detached has no owner at all: the
   chosen id is the sentinel `-`, `pick` returns no session, the bar says
   `π detached` and the features that need a pi say that the editor is
   detached. pi itself runs on;
2. else the session that wrote or edited the open file (each session record
   lists its last 20 files; pi adds a file when it starts to write it, before
   the editor opens it), the most recent;
3. else the session whose folder holds the open file: the deepest folder, then
   the most recent;
4. else the most recent session, with `(outside its folder)` in the status
   bar. The editor and the agent stay coupled: there is no "none" while a
   session runs. (Before, a file outside every folder gave "none for this
   file", also a file pi itself had just written in `/tmp`.)

Only the owner writes events and answers helpi! questions. The status bar shows it:
`π symbiosis ● working`, `π none`, or `π tosak-docs · old, /reload` for an
extension with another protocol. `ctrl+k g` or a click runs
`herdr agent focus <pane>` (the plugin's `system.exec` permission allows
`herdr` only). When the owner changes, its first event starts the log again,
so `head.json` and the log always agree.

(Slice 2 also had `AI!` / `AI?` comments, sent with `ctrl+k d` as one
message to pi. They were replaced by `helpi!`, below: "not smooth enough".
`ctrl+k d` is free again: it asks about code, see "Ask".)

Found in the spike, ttt 1.7.1: `gmatch("[^\n]*\n")` crashes with a nil
pointer on text that has an empty line. The plugin splits lines with `find`.
Keys `ctrl+k e t i j o r s u y` belong to ttt (`s` is Save As, `y` the keybindings); plugin chords that work are
`a d g h n q v w x z` and `.` `/` (`d` asks, see "Ask" below). A `local ready` flag once hid the `ready` handler:
Lua locals shadow quietly.

## Slice 3: the timeline

The operator wants to see the flow of the work: what pi did, what it does
now, what it does next. Not its thinking: a human cannot read that as fast as
the model writes it.

pi keeps the plan itself, with a tool of its own, `plan` (`pi/plan.ts`).
Each call sends the whole list, `{steps: [{text, state: done|now|next}]}`.
The tool only records it: the session record carries it to the plugin with
the next heartbeat (at most 1 s). After `/reload` or a resume, the last
`plan` result in the session branch comes back. Chosen over reading pi's
`todo` list (no extra tokens, but pi makes one only when it wants to) and
over a list built from tool calls (it has no "next").

A step may also name `files`: the files pi expects to create or change in it
(at most 12, each once; paths are made absolute against pi's folder when the
tool runs). It is pi's guess. The change list shows the files pi really
changed beside it, and a changed file that no step named is marked as not
planned. A call of `plan` sends the whole list again, so pi repeats the
`files` it still wants; the tool description and the guideline say so.

The plugin shows the owner's plan in the status bar, cut to about 56
characters: done steps become a count, later next steps drop off as `+k`.
`ctrl+k v` or a click opens a drawer with the whole list. The drawer takes
the keys while it is open, so a plugin key cannot close it: Esc does, as in
every ttt drawer. When the editor moved after the drawer opened (a stop),
`ctrl+k v` gives the drawer the focus again.

The drawer is also the change list. Under each step it lists files
(`ttt/src/core/changelist.lua`, pure, with the tests): first the files pi
changed in that step, in the order it first changed them (`●`; `✎` while a
call of pi is open in it; "new" for a file pi created; the number of
changes), then the files the step named that pi has not reached (`·`,
"planned"). When a step names files, a changed file it did not name says
"unplanned"; a step that names none tags nothing, so a plan without `files`
is not full of tags. A change belongs to the step it was logged under: the
same place in the plan with the same text, else the first step with that
text (pi rewrote the plan); a change with no step left goes under "Other
changes". Done steps are muted and collapsed. The drawer reads the owner's
`log/<session>/index.json` and redraws when the plan or the log changes (the
`start` and `done` hooks of follow). Enter on a file opens it at the first
line of its first change in that step; that line is as the change left it, and
it is not moved for later changes yet.

**Changed lines** (`ttt/src/features/changemarks.lua`). ttt gives a plugin
no line background, so the open file shows pi's changes two ways: a bar `▌` on
each changed line in the gutter (`ttt.bookmarks`, through `core/gutter.lua`,
which now takes a style for each line), and a hint diagnostic over each run
of lines (`ttt.diagnostics`, permission `editor.diagnostics`) with the hover
text "pi · <step> · changed|new file · <why>". The colour is the plan step's
place in a palette of six named ttt styles (`core/changelist.lua`
`style_of`); a change with no step is muted. The lines are where the log's
hunks put them, moved by the later changes of that file (`marked_lines`,
the Lua twin of `moveLine`; the later change owns a line it wrote again). When
the buffer is not what pi left (you edited it), `remap` compares the lines at the top
and at the bottom of pi's last text and the buffer: the lines they share keep
their mark, shifted at the bottom; the lines between, which you edited, lose
it. Texts over 256 KB are not kept, so such a file is marked as pi left it. A
line with another feature's bookmark (a note, a review mark) keeps that one.
It redraws on a file change, 300 ms after pi's call or your typing, and each
second; the setting "Changed lines" turns it off.

**Seen and the exact diff** (`changemarks.lua`, `changediff.lua`). A change
the operator has seen leaves no bar and no hover text. The ids are in
`log/<session>/seen.json` (`{ids: {<change id>: true}}`); the plugin writes it,
and pi's clean-up of old log directories removes it with them
(`changelist.mark_seen` drops ids that are no longer in the log).
`ctrl+k /` marks the changes of the open file; in the plan drawer `s` marks a
file row (its changes in that step) or a step row (all its changes). A file row
whose changes are all seen reads `✓ file · N changes · seen`, muted.
`ctrl+k .` opens ttt's own diff tab (`ttt.open_diff`) from the text before the
change to the text after it, for the change that wrote the cursor line; `d` on a
file row does the same for the first to the last change in that step. Neither
blocks pi. The keys are `.` and `/` because the letters are all taken (see
the key list in Slice 2): `s` is Save As and `y` the keybindings in ttt 1.7.1.

## The gutter marks

ttt's gutter (`ttt.bookmarks`, the column left of the line numbers) holds the
marks of features: `◆` a note, `●` a body to review (`core/gutter.lua`).

- Bookmarks stay on their line number when lines come in above them, so the
  plugin draws again each tick when the set changes (not at all when it is
  the same).
- One mark per line. The plugin never draws on a line that has another
  plugin's mark, and removes only its own. A bookmarks plugin that sets all
  its marks again (on file open) clears ours; they come back on the next tick.
- A failed draw turns the marks off until ttt starts again.

## The diff key

`ctrl+k w` shows what pi changed in its last turn (agent_start to
agent_end), in ttt's own diff tab (`ttt.open_diff`). Before is the file as it
was when pi first touched it in that turn; after is the file after pi's last
change. So five edits to one file show as one diff. The open file, or, if pi
did not change it, the last file pi changed.

Only the owner keeps these, in `changes/` in the plugin folder
(`pi/changes.ts`): ttt.fs cannot read outside the workspace, so the
extension writes both texts there. A new turn of the owner drops the last
one. Files over 1 MB are not kept.

## The change log

`pi/changelog.ts` keeps every `write` and `edit` of the session, in the order
pi made them (`log/<session>/index.json`, oldest first). The diff key keeps
the last turn only; this log is for the change list and keeps its entries
across turns, up to 300 (the oldest go first). An entry: `seq`, time, call,
tool, file, the plan step, the hunks, pi's `why`, and `created`. The texts
before and after are in `log/<session>/<id>.json`, for the exact diff of one
change; a file over 256 KB keeps its hunks and no texts.

- The step is the plan step that is `now` when the call ends; with no `now`,
  the last `done` one; with no plan, none. The entry keeps the step's index
  and its text, so a plan that pi rewrites later does not lose it.
- The hunks are in the file as it was after that change. A later change moves
  them: `moveLine` in `core/hunks.ts` gives the line again, or `null` when a
  later change replaced it.
- Every session logs, not only the one the editor follows: the owner may
  change, and the log of the other is there when it does. A log folder of a
  session that nobody has touched for 7 days is removed when a new session
  starts.
- A call that fails, is blocked by the guard, or changes nothing, is not
  logged. Changes by `bash` are not logged yet.

## The file tree

The tree follows pi, also across projects in different places. A ttt plugin
cannot add a folder to ttt's tree (measured, ttt 1.7.1: no API;
`workspace.addFolder` only opens the picker; `--exec` cannot reach a running
ttt), so there are two parts:

- ttt's own tree: when the editor follows pi into a file, the plugin runs
  `explorer.revealActiveFile`, once for each new file. Only for a file in a
  folder open in ttt: ttt.fs sees only those folders, so `fs.exists` tells.
  Outside them the reveal only says "File is not in the explorer".
- The "pi files" panel (a sidebar tab): each live session, by name and
  folder, with the files it wrote (`files` in its record, the last 20) as a
  tree under its folder; a file outside the folder goes under its own folder
  by full path. `▶` the session the editor follows, `✎` the file pi changes
  now; Enter opens a file.

The reveal switches the sidebar to the explorer. So while the "pi files" tab
is on screen (ttt draws it on each tick, the plugin notes the tick) there is
no reveal. ttt has no command to show a plugin's sidebar tab: you choose it.

## The cost

Events: no model tokens; the channel log holds three small events for each call.
helpi!: one side call per question to the session's model, outside pi's
conversation: the prompt (~400 tokens), the file (up to 150 lines, else 20
lines of the top and 60 around the question), pi's plan and up to 2000
characters of pi's last message: about 2–5k tokens in, my estimate, plus the
answer. An `ask` answer also sends one user message to pi (the question and
the same code).
Diff key: no model tokens; each file pi touches is copied twice per turn.
Timeline: the `plan` tool is in every request, about 150 tokens (schema,
one-line snippet, one guideline). Each call costs the steps it sends, about
10 tokens a step (more with `files`: about 8 a path), plus a one-line result.

## helpi!: ask where you write

You write a comment that ends in `helpi!`. 600 ms after your last change, or
at once on Enter at the end of that line, the plugin writes `help.json`
(`HelpRequest` in `core/protocol.ts`) addressed to the owner: the line, its number,
the language, and the code (the whole file up to 150 lines, else the first 20
lines and lines -40/+20 around the question). One question at a time. The
pause asks a line only once (unless it failed): ctrl+z, which brings the
question back, would else ask it again by itself. Enter at the end of the
line always asks. No owner, an old protocol, or
no answer in 3 s: the plugin says so.

The owner's extension reads `help.json` every 100 ms and makes a side call
with `ctx.modelRegistry.streamSimple` to the session's own model. It is not in
pi's conversation. The prompt (`HELP_SYSTEM`) asks for one first line, the
kind, then the answer:

| Kind | Answer | In the editor |
|---|---|---|
| `code` | `+import <line>` lines, then the code, from column 0 | The code takes the place of the comment, at its indent. Missing imports go after the last import line (or at the top). |
| `note` | plain lines | `pi:` comment lines under the question; `helpi!` leaves the question. |
| `ask` | nothing | The question, file and line go to the agent as a user message (a follow-up when it is busy). The line under the question says `pi: asked <session>; its answer comes in pi`. |
| `function` | nothing | The comment describes a new function. `helpi!` goes, nothing is written under the comment, and the editor starts a fill of mode `function` at that line (see "Filling a stub"). |

A `helpi!` on a stub's marker line (`TODO(pi)`) asks no model: the editor
knows the case, takes the marker off and starts a fill of the stub at once.
There was a second word, `fill!`, for that; the developer wanted one word for
everything (2026-10-16).

The extension streams `help` (taken), `help_start` (kind, imports),
`help_text` (the whole answer so far, at most every 40 ms) and `help_done`
(complete, `stopped`, or `error`). Until `help_start`, a waiting line under
the question shows `// pi ⠋ thinking · Esc stops` (the spinner turns every
120 ms); it opens the answer's undo group, the answer takes its place, and
Esc or an error takes it away (and undoes the group, so no empty undo step is
left). While it is there, keys that change that file wait, and autosave
does not save it. The plugin writes the help events at once. The answer is one undo group: one ctrl+z brings
the question back. While it writes, keys that change that file wait; Esc
writes `cancel` to `help.json` and pi stops the call (what is written
stays). When the answer is complete, autosave saves the file at once, as pi
may go on to another file.

Weak points: the kind comes from the model; a wrong kind (a note where you
wanted code) is undone with ctrl+z. The 3 s "did not take the question" timer
can fire on a slow first token only if pi does not write `help` (it does, at
once).

## Ask: what is this code, and why is it here?

The developer points at code and asks, with no comment in the file. Three ways:
`ctrl+k d` on the selection, or on the line under the cursor (the word under
the cursor goes along); a comment that ends in `why!`; a click on the `◆` mark
of a line that has notes. The plugin writes `ask.json` (`AskRequest` in
`core/protocol.ts`) for the owner: the file as it is in the buffer (a file over
200 KB sends 80 lines around the target instead, with no outline), the target
lines, the question, and for a drill-down the answer it grew from. pi answers
in one side call (`pi/ask.ts`, the same path as `helpi!`: `pi/side.ts`), never
in its conversation, and streams `ask`, `ask_text` and `ask_done` events
(`PROTOCOL` 13). `core/ask.ts` builds the prompt: the file's imports, the
innermost function around the target (cut at 60 lines) or, for code in no
function, 12 lines around it; the stub's signature and doc when the target is
inside a stub; the reasons (`why`) pi gave for its changes to that file in its
last turn (`pi/changes.ts`); the plan. The answer is 2 to 4 lines, then
`links:` and `terms:` sections, parsed by `parseAskAnswer` while it streams.

**`why!`.** The comment is the question. Code before the comment on the same
line is the target; a comment on its own line points at the next line of code.
The comment goes out of the file in one undo group (one `ctrl+z` brings it
back), as `helpi!` does; both triggers share `ttt/src/core/trigger.lua` (600 ms
pause or Enter at the end of the line, once for each text).

**The drawer** (id `ask`, on the right). ttt has no popup anchored to a line, so
the title names the line. It shows the answer as Markdown, the links, and the
terms. A project link (`path:line`) opens the file; ttt cannot open a URL, so a
URL is text, marked "the model wrote them; not checked", that can be selected
and copied. Enter on a term asks about it with this answer as context; the
input asks a follow-up of your own; `+` or the Deeper button asks the same
again for up to 8 lines; Back goes to the answer before; Stop ends a running
answer (Esc closes the drawer: ttt takes that key, so it cannot also stop).

**Notes** (`ttt/src/features/notes.lua`, `ttt/src/core/notes.lua`). Each answer
is kept as a line of JSON in `<folder>/.symbiosis/notes/<path>.jsonl`:
`{line, hash, question, answer, links, terms, time}`. The plugin writes it, in
Lua, as ttt's fs allows a folder open in ttt only (a file outside every open
folder gets its answer in the drawer but no note, with a notice). `fs.write`
returns `nil, reason` on a refusal and does not raise, and it does not make
missing folders (measured, ttt 1.7.1), so the ask request carries `notesDir` and
pi makes that folder (only one under `.symbiosis/notes`; `isNotesDir`). A `◆`
in the gutter (a ttt bookmark) shows a line with notes; a click on it
(`gutter.click` gives `(path, line)`; a click selects the line, so the handler
shows the notes of the line and does not ask), or `ctrl+k d` on that line with
no selection, shows them, the newest first and the older ones behind Back. The
hash is a sum over the line's text without its end blanks (gopher-lua has no
bit operations). 300 ms after a change each note looks for its text: the
nearest line with the same hash, else it is "moved" (no mark; it is in the
palette's "Notes of This File"). The first note in a git folder asks once
whether `.symbiosis/notes/` goes in `.gitignore` (`ttt.confirm` calls back only
on OK; Cancel has the focus).

Buttons in the ask drawer have no mnemonic (`&Again`): ttt gives a mnemonic
letter to the button even while the input has the focus, so typing "and add it"
pressed Again and Deeper and asked the old question again. The input is the
first widget, so a new answer has the focus on it.

Weak points:

- The `.gitignore` dialog takes the focus from the drawer, and ttt does not
  give it back (after OK or Cancel). `ctrl+k d` on the line (a click on the
  editor first) opens the drawer with the focus again. Once for each folder.
- `why` is kept for each file, not each hunk: `pi/changes.ts` records the
  reasons of a turn for the file. A file pi changed in several places sends
  all its reasons.
- A hash is the line's text, so two equal lines (`}`) cannot tell their notes
  apart: the nearest one wins. A blank line cannot hold a note (it is not
  anchored; the note shows as moved).
- A note cannot know that its line changed meaning: the text must change for it
  to move or hold, and if it still matches it stays, now possibly wrong.
- The `.symbiosis/notes/.ignore-asked` file, written when the question is
  asked, is in git when the operator says no.
- The drawer's Markdown area scrolls in a fixed height; a long answer with
  several URLs is cut off until it is scrolled.
- Code outside a function that pi's tree-sitter cannot parse (no grammar) gets
  the 12 lines around it, with no imports line.

## Review per stub: read what pi filled

A filled body is not done until the developer has read it. When a fill ends
(`Filling.settle` in `pi/fill.ts`: the stub's function is there and no longer a
stub), pi turns the function into a `Landing` (`core/review.ts`: signature on
one line, the doc comment as intent, the body without its braces and indent,
cut at 120 lines, and the text of the function's first line as an anchor), adds
the reasons (`why`) it gave for that file in the turn, and keeps it in
`pi/review.ts`. The list is the session record's `review` field (`PROTOCOL` 14),
the newest last, 20 at most; filling the same function again replaces its entry.

The plugin (`ttt/src/features/review.lua`) reads that list from every session
record:

- **Drawer.** A body from the session the editor follows opens the drawer by
  itself once pi has no call open. It shows the signature, the
  intent, the body and the reasons; the button `Ack` (key `a`) acks it. Esc hides
  the drawer; `ctrl+k x`, a click on the gutter mark or on the status item
  "● n to review" shows it again. After an ack the next body of that session
  shows, if there is one. Nothing opens at startup: what the plugin sees on its
  first look counts as seen.
- **Gutter.** `●` on the function's first line while it is not acked. The line
  is found again by the text of that line, like a note (`core/notes.lua`,
  `anchor`); the mark follows the function when lines move, and goes when the
  line's text changes. The drawing is `core/gutter.lua`, shared with the notes'
  `◆`.
- **Tree.** The "pi files" tab shows `● n` at a file with n bodies waiting.
- **Ack.** The plugin writes `review.json` (`{id, to, ack}`); pi drops the body
  from its list in the next poll and writes the record at once. `acked` in the
  plugin hides the body until the record agrees.

Decisions (operator, 2026-10-17): the drawer opens by itself; the state is the
session's only (a restart of pi forgets the marks: Gate 1 shows whether the habit
needs more); only `a` acks, an edit of the body does not.

Weak points:

- The marks are not on disk: a pi restart forgets what was not acked, and so
  does a second ttt that starts after the ack of the first.
- A function whose first line is edited loses its mark, though it is not acked:
  the list still holds it (the status item counts it, `ctrl+k x` shows it).
- A line holds one bookmark: where a note `◆` and a review `●` meet, the one
  drawn first stays.
- The drawer takes the focus when it opens by itself: a letter typed in that
  moment goes to it (`a` acks). The wait for pi's call makes this rare, but it
  can happen.
- `whys` is per file, not per function: a file filled in several places sends
  all its reasons with each body (as in "Ask").
- Only a stub fill lands. A body pi writes with no fill (no `helpi!`) is not
  listed: `ctrl+k w` shows the turn's diff.
- The body is shown as text: no syntax colors (ttt's Markdown area).

## Stubs and the scope guard

You write the signature and a one-line intent above it; the body is only a
`TODO(pi)` comment and the language's placeholder (`throw new Error()`,
`TODO()`, `panic()`, `pass` or `...`, `error()`, or nothing). That is a
stub. The agent fills the body, and the guard keeps it there.

The parser is tree-sitter through its WASM build (`web-tree-sitter`), with
the official grammars: TypeScript (and JavaScript, TSX), Kotlin, C#, Go,
Python and Lua. A grammar loads on the first file of its language and stays
(C# takes about 0.35 s, the others less). `core/syntax/parse.ts` turns a tree
into an `Outline` and frees the tree at once, so the rules read plain data
and their tests need no parser. A language is one file in
`core/syntax/languages/`: which nodes are functions, where the body starts,
what a placeholder is, what an import is, which declarations are private.
The intent is the comment block right above the function (no blank line
between), or a Python docstring.

The guard (`guard()` in `core/guard.ts`) gets both versions of the file, each
with its outline, and the stub (`StubRef`: path, name, signature, line). It
finds the stub again by its signature, nearest its old line, as an edit
above it moves it. Then it masks the stub's body and every import line in
both versions, cuts the declarations that are new, and compares what is left
with whitespace collapsed (a re-indent is not a change). What it reports:

| Kind | When |
|---|---|
| `outside_edit` | The rest of the file differs, an import is removed, another file is edited. Another stub in the file is outside too. |
| `signature` | The stub's signature changes, or the function is gone. |
| `new_decl` | A new declaration outside the body: a function, a class, a member. In `file` scope a new private one is allowed. |
| `dependency` | A new import that the language's policy does not resolve. |
| `new_file` | A write to a file that does not exist. |

Local functions and closures inside the body are the body. A `write` is
checked like an edit: the old text against the new. Each kind is also a
`propose` kind. An accepted proposal is an allowance for one kind and one
target (the path, the import, the declaration's name, the stub's name): it
lets that one violation through, once, and only when nothing else blocks the
call. The reason the model gets names every violation with its kind and
target, so the model can propose exactly that.

The import policies (`core/imports/`) read the project once: package.json;
the Gradle files and the version catalog (group ids); the .csproj files;
go.mod; requirements and pyproject.toml, and `python3` for its standard
library; rockspecs and module files for Lua. A relative import, the
standard library and the file's own package root always resolve.

Weak points: a package whose import name is not its manifest name
(`kotlinx.coroutines` from `org.jetbrains.kotlinx`, `yaml` from PyYAML) does
not resolve, so the model must propose it. Two functions with the same
signature are told apart only by their line. A file that does not parse
well can lose the stub; the guard then reports `signature`.

The guard is also wider than it looks in places. `file` scope lets in private code that runs at load
time (TypeScript `const _x = sideEffect()`); only Go `init` and `var _` and
C# static constructors are refused. The own package root is the first two
package segments in Kotlin and the first namespace segment in C#, which is
wide for `io.github.*` or `Microsoft.*`. A C# `using X = …` alias of a
namespace that resolves is allowed. Expression-body stubs
(`fun f() = TODO() // TODO(pi)`, C# `=> throw`) are not found. An import
inside a `try:` or `if TYPE_CHECKING:` block is not an import line, so a new
one reads as `outside_edit`.

The guard sees only what reaches it. A tool other than edit and write can
change any file but the stub's own (only that one is put back), and it can
write the plugin folder: a forged `fill.json` releases the fill. (A `scope`
written to `ttt.json` lasts until ttt's next heartbeat, at most a second;
from an editor that is gone it does not count.) An accepted `outside_edit`
names the file, not the region: it lets any one call that edits outside the
body through, whatever the proposal's `what` said. The developer chose to
keep it so (2026-10-16); tying it to a region needs the model to send exact
text, which it often gets wrong.

## Filling a stub

`helpi!` at the end of the marker line (or `ctrl+k f`) saves the file and
writes `fill.json`: the mode, the path, the line and the session the editor
follows. That session (`pi/fill.ts`) finds the stub at the line
(`core/fill.ts`) and sends its model one user message: the file, the
signature, the intent, the body's lines and the rule to edit only inside the
body. A new fill replaces the one before. The session record carries the
fill, so the status bar shows `filling <name>`.

A fill of mode `function` comes from a `helpi!` description the side call
answered with `function`. Its target is a place, not a stub
(`core/place.ts`): the comment lines that end at the line are the
description, and the new function is the declaration whose doc comment holds
the description, so it must come directly under it with no blank line. The
description's text is the anchor, as the signature is for a stub: in each
version of the file the place is found again by that text, nearest its old
line. The guard masks the region from the end of the description to the end
of that declaration and compares the rest like a stub's file; one more new
declaration is `new_decl`, and a change to the description itself is
`outside_edit`. A comment that already is a function's doc, or one inside a
body, is refused when the fill starts. The status bar shows
`writing <name>`: the description's first words until the function has a
name. The fill ends at the end of a run once the declaration is there and no
function in it is a stub.

The guard runs in pi's `tool_call`, before the call starts, so the
editor never hears of a call that will not run. A `write` brings its
new text. An `edit` does not: pi matches its old texts against the file
itself. Thus `pi/tools.ts` runs pi's own edit code with a `writeFile` that
throws the text it was given, and that text is what the edit would leave.
The same probe runs pi's write code, so the path is pi's too (`@`, `~`,
unicode spaces); then symlinks are resolved, as the editor sends real paths.
Matching, line endings and the BOM stay pi's. A call the guard blocks gets
the reason as its result; the editor gets no `start` for it. A call the guard lets through spends nothing yet:
its allowances are spent, and the stub moves with it, only in `tool_result`
of a call that ran. Esc in pi can still stop it.

Every other tool (bash, another extension's tool) can change files too. The
stub's file is kept before such a tool runs; if the tool changed it, the file
is put back and the tool's result tells the agent to use edit or write, or
propose. The developer chose this over blocking bash during a fill, so that
tests and reads still run.

The guard checks each call against the file as the call before left it. pi
runs the tool calls of one message in parallel by default, so all their
`tool_call` handlers would see the file before any of them ran. `edit` and
`write` are therefore registered again with `executionMode: 'sequential'`.
This holds in every session, with or without a fill or an editor: a message
with an edit runs all its tool calls one after the other.
The same registration adds `why`: an optional argument for the reason for a
choice that is not obvious, taken off before pi's code runs. It travels in
the `done` event (a notice when the plugin gets it) and in the
change log (`ctrl+k w`).

`propose` emits a `propose` event and polls `answer.json` every 100 ms. The
editor shows the proposal in a drawer with a note and two buttons. ttt's
command line does not open while a drawer is open (measured in 1.7.1), so the
note is an input in the drawer: Enter accepts. ttt does not tell a plugin that
its drawer was closed, so Esc only hides the proposal; `ctrl+k p` shows it
again. The tool gives up when pi's turn stops, or when the editor does not
follow the session for 1.5 s (one read of `ttt.json` while ttt writes it does
not count). With no editor following, it rejects at once. An accepted
proposal becomes the allowance above.

At the end of pi's run, a stub whose body is no longer a stub ends the fill.
A body that is still a stub keeps it: pi may have stopped to ask the
developer, and the answer comes in a new run. "symbiosis: Release the Fill"
ends it by hand.

Weak points of a function fill: the side call decides that a comment means
"write a function", so a question can be read as one; the developer sees it
at once, as the session starts writing, and Esc or release stops it. Two
equal descriptions are told apart only by their line. A description edited
while pi writes (in the editor, not by pi) loses the place, and the guard
then blocks every call until the fill is released.

## The symbiosis command: ttt and a real pi

`bin/symbiosis` opens ttt in the folder and a real, full pi beside it. pi is
not hidden behind ttt: it runs in its own pane, with its own chat, commands
and dialogs. (pi in RPC mode behind ttt, with a chat panel in ttt, was built
and dropped: the panel was a poorer copy of pi's own terminal.)

- **Where pi goes.** In herdr or tmux, by `layout` (config, or `--tabs`,
  `--split`):
  - `tabs` (the default): a new tab `pi · <folder>`, not focused; ttt stays
    in this pane.
  - `split`: this pane splits, pi on the right, the focus stays on ttt.
  The launcher makes the pane, then types the pi command into its shell, so
  the shell stays when pi quits and its last words can be read.
- **`--tab`** (or `open: "tab"`): a new focused tab named after the folder;
  symbiosis runs again there with `--here`, and this pane is free. The new
  tab's shell does not get this environment, so `SYMBIOSIS_PI` and
  `SYMBIOSIS_TTT` go along on the command line (`env ...`).
- **Demo scenarios.** `demo/scenarios/` has one `Scenario` for each feature
  (`kit.ts` is the shape: title, what to try, the scripted pi's `run`, and a
  `check` for a headless ttt). `npm run demo -- <name>` writes the name into the
  workspace's tag file, which the scripted pi reads (a pane has not the
  launcher's environment; `DEMO_SCENARIO` overrides, as the e2e script uses it); `--list` names them; `--show <name>` prints
  the check as JSON, which `test/e2e/scenarios.sh` runs. The task is data
  (`task.ts`): a scenario plays it through the fake pi or puts its result on
  disk. A scenario waits for pi by the plan drawer (it shows the last step),
  not by the status bar: pi's notices cover the bar.
- **The demo.** `npm run demo` runs the launcher on a fresh copy with
  `SYMBIOSIS_PI=demo/scripted-pi`: the scripted pi takes the place of pi and
  ends when the launcher's record goes (ttt quit). `--real` gives a real pi
  `--name demo @demo/PROMPT.md`.
- **Outside herdr and tmux** it opens ttt only and prints how to start pi.
- **pi stays.** When ttt quits (`ctrl+q`), the launcher removes its record and
  ends; pi is a normal session in its own pane, to go on with or to quit there.
- **Tab names.** The tab where ttt runs is named like pi's: `ttt · <folder>`
  (`symbiosis · <folder>` with `split`, where both share it). The launcher reads
  the old name first (herdr: `pane get` → `tab get`; tmux: `window_name` and
  `automatic-rename`) and restores it when ttt ends (tmux: `automatic-rename
  on` when the window had no name of its own).
- **Close.** `symbiosis close` (launcher/close.ts) ends what the launcher
  opened. The launcher's record holds the pi pane it made (`pi`). Steps: find
  the record (inside ttt by the pid in `SYMBIOSIS_SESSION`, else by folder);
  find the live session registered from that pane; write `close.json`
  `{id, to}` (PROTOCOL 15); pi's poll calls `ctx.shutdown()`; when the
  process has ended, close the pane (herdr `pane close`, tmux `kill-pane`; the
  tab goes with its last pane). A pi in another pane, or none, is never closed;
  pi that does not quit in 8 s keeps its pane and the command fails. Then ttt:
  the command writes `quit.json` `{id}` and the plugin (polled each second)
  runs ttt's own `editor.quit` command, which asks about unsaved files, as
  ctrl+q does. SIGTERM would drop unsaved text without a word, and
  `ttt.quit()` too, which is why neither is used. `ctrl+k z` in ttt asks first
  (a confirm; with programs running, the Run question is the confirm), runs
  `symbiosis close --keep-editor` and quits ttt itself only on success. The
  plugin needs the permission `system.env` to know it is under symbiosis
  (`SYMBIOSIS_SESSION`): ttt's Lua has no `os.getenv`. `shift+q` is not a key
  for this: ttt lowercases the keys of a chord, so `ctrl+k shift+q` never
  matched and `ctrl+k Q` fired `ctrl+k q` (stop).
- **Stop.** `ctrl+k q` writes `stop.json` `{id, to}` for the session the
  editor follows; that pi aborts its turn (`ctx.abort()`) if it works.
- **Waits for you.** pi emits `ui_prompt_start`/`ui_prompt_end` for every
  extension's dialog (a guard's "Allow?", a question). The session record
  gets `waiting`, the bar shows `π name ? waits for you`, and a notice says
  so; `ctrl+k g` goes to pi's pane to answer it.
- **Already open.** A second `symbiosis` for the same folder goes to the pane
  where the first one runs (herdr: `pane get`, then `workspace focus` and
  `tab focus`; tmux: `select-window` and `select-pane`). When that fails it
  says where it runs and stops. `--new` opens another.
- **Install.** `install.sh` installs ttt and pi when missing, then the pi
  package, then runs the package's `bin/setup.sh`: it builds the ttt plugin from `ttt/src` (git does not hold the bundle) and copies it
  and links `~/.local/bin/symbiosis` to `bin/symbiosis` in pi's copy of the
  package. So the launcher, the extension and the plugin come from one copy,
  and `pi update` updates all three. herdr is optional; install.sh does not
  install it.
- **Versions.** One number, in `package.json`; the ttt plugin manifest and
  `herdr-plugin/herdr-plugin.toml` carry the same one, and `test/version.test.ts`
  fails when they differ. release-please (`.github/workflows/release-please.yml`,
  `release-please-config.json`, `.release-please-manifest.json`) keeps a release
  PR open from the commit subjects (`feat:` and `fix:`), writes the number into
  the three files and `CHANGELOG.md`, and tags `vX.Y.Z` when the PR merges. Before
  1.0 a `feat:` raises the minor number. The plugin's channel `PROTOCOL` is a
  separate number: it changes when pi and the plugin can no longer talk, and
  `symbiosis version` shows both.
- **`symbiosis version`** (launcher/version.ts, core/version.ts). Offline by
  default: the package version (and `git describe` when the copy is a clone),
  the ttt plugin in the package against the copy in ttt's plugin folder, the
  `PROTOCOL` of the package against the installed `plugin.lua`, and the
  `PROTOCOL` of each open pi session (its record in `sessions/`), with the step
  to take for each difference (start pi once, reload the plugin, restart that
  pi). `--check` runs `git ls-remote --tags` on the repository and compares the
  newest `vX.Y.Z` tag; a failed check exits 1 and says why. The plugin's
  `version` is only stored by ttt, never compared, so the number may be set to
  the package's.
- **herdr.** With herdr there, install.sh adds the herdr plugin and a key.
  Its action **Open symbiosis** (`herdr-plugin/scripts/open.sh`) runs
  `symbiosis <folder> --tab` for the focused pane's folder; herdr runs
  actions without a terminal, so an error shows as a herdr notification.
