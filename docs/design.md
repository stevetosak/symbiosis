# symbiosis: the design

## The goal

You watch the agent work in your editor, as it works. Each `write` and `edit`
of the pi agent types itself into the ttt buffer while the model writes it.
Then the editor shows the result at the changed line.

## The parts

| Part | File | Job |
|---|---|---|
| pi extension | `pi/index.ts` | Reads the tool calls while they stream. Writes events. Wires `core/` into pi. |
| Protocol | `core/protocol.ts` | Types only: every event and record that crosses the channel, and `PROTOCOL`. |
| Events | `core/stream.ts` | Pure: turns growing arguments into small `text` events. |
| Channel | `core/channel/channel.ts` | The interface the agent side talks to: send events, publish the session, read the editor's state and requests. |
| File channel | `core/channel/file.ts` | The one implementation: files in the plugin folder, `events.jsonl`, `head.json`, `ttt.json` (with the lag limit and the stub scope), `ack.json` (the changes shown), `fill.json` (a fill and its release), `answer.json` (the answer to a proposal). |
| helpi! | `core/help.ts` | Pure: the request, the side call's prompt, the answer parser (kind, imports, body). |
| Syntax | `core/syntax/` | tree-sitter (WASM): a file's outline (functions with signature, body, intent, stub flag; imports; declarations). One file per language in `languages/`. |
| Stubs | `core/stubs.ts` | Pure: find a stub on a line, find it again after an edit, the fill message. |
| Places | `core/place.ts`, `core/target.ts` | Pure: the description that ends on a line, the new function under it found again by the description's text, its message; `target.ts` names either kind of fill target. |
| Imports | `core/imports/` | One policy per language: does a new import resolve to the project, the standard library or the manifest. |
| Scope guard | `core/guard.ts` | Pure: is an edit or write inside the stub being filled; what blocks it and which `propose` kind lifts that. |
| Fill | `core/fill.ts` | One fill (a stub, or a new function under its description): starts it from a line, checks each call with the guard, keeps the accepted proposals, knows when the work is done. |
| Tools | `pi/tools.ts` | pi's own `edit` and `write` again, with a `why` argument and one call at a time; a probe that tells what an edit would leave in the file. |
| Filling | `pi/fill.ts` | The pi side of a fill: the fill request, the guard before each call, the `propose` tool that waits for the editor's answer. |
| Launcher | `launcher/main.ts` (`bin/symbiosis`) | Starts a real pi in its own herdr or tmux pane, runs ttt here as its child, ends when ttt quits. One record per folder in `~/.local/state/symbiosis/`. |
| Layout | `launcher/layout.ts` | Pure: the herdr and tmux command lines for a pi tab, a split, or a new tab for symbiosis itself. |
| ttt plugin | `ttt/src` (bundled into `ttt/symbiosis/plugin.lua`) | Polls every 40 ms. Shows the preview. Follows the result. Sends helpi! questions and writes the answers. A host (`ttt/src/core`) and one module per feature (`ttt/src/features`); see `ttt/README.md`. |

A ttt plugin cannot open a socket and can read only its own folder and the
workspace. Thus the channel is files in the plugin folder.

`core/` holds what does not depend on pi: the protocol, the rules that turn
a tool call into events, the channel, and the stub rules (syntax, imports,
guard). It imports nothing from pi, so
another agent harness, or a socket in place of the files, is a new adapter or
a new `Channel` implementation, not a change to the rules. `pi/` holds only
what speaks pi: the extension, its `plan` tool, the change log it keeps for
the editor, and the setup.

## The buffer: one rule

**The file on disk is the truth. The preview is never saved.** pi does not
wait for the editor (up to a limit, see the replay below): the file on disk
is where pi is now, and the buffer is a replay of pi's changes, behind it.

1. `start`: the plugin opens the file. It sends the file's Adler-32 (`sum`)
   and its text (`before`, up to 256 KB). If the buffer is neither that text
   nor the file as pi last wrote it (the `sum` of the last `done`), it has
   unsaved changes: no preview for this call.
2. A run starts: one undo group. If pi already changed the file again, the
   plugin first sets the buffer to `before`, so the change shows from the
   text pi started from. A write clears the buffer and types the new
   content. An edit selects its `oldText` (only if it occurs once), then
   types `newText` over it. The next call to the same file types on top, in
   the same run, as pi did on disk.
3. `ready`: the arguments are complete. When the replay has typed all of
   them, the plugin writes the call id to `ack.json` (shown).
4. The tool writes the file at once. ttt says the file changed on disk under
   the replay; the plugin clears that notice.
5. The run ends when the replay goes to another file, at the end of the turn,
   or when it has shown all that pi sent. Then the plugin closes the undo
   group, undoes it (the buffer is clean but old), closes the tab and opens
   the file again: ttt reads it from disk.
6. `done`: the editor goes to the changed line (after the run, when one is
   open). `stop` (end of the turn) goes there even when you pinned the editor.

Measured with headless ttt 1.7.1: a disk change under a dirty buffer gives a
notice ("changed on disk; you have unsaved changes", about 4 s over the
status bar) and no reload; a later undo leaves a clean but old buffer.
Closing the tab and opening the file again reloads it. `ttt.notify("")`
clears the notice. There is no revert command.

## The replay: pi runs ahead

Operator: "Because now we can stream the response being written in slower
speeds, that should not stop the agent from actually doing other things
proactively." Decision B: a limit. pi waits in `tool_call` only while more
of its changes than the limit are not shown (`Channel.waitBehind`). The
plugin puts the limit in `ttt.json` (`lag`): 0 (pi waits for each change, as
before), 3 (the start value), 10, or no limit; Enter on "pi ahead (max)"
in the panel cycles it.

- No separate writer program: the disk must change at once, or pi's next
  read or test would see old code. The plugin is the replayer.
- While a file is replayed, your typing in it waits (characters, Enter, Tab,
  Backspace, Delete, ctrl+v/x/z/y/s): the buffer is the replay, and pi has
  already changed the file on disk. The bar says `your typing waits`. Moves
  still work. Pin (`ctrl+k a`) ends the replay.
- Pause stops only the replay; pi goes on up to the limit.
- The bar shows the lag: `▶ 160/s · 2 behind` (the `ready` events queued).
- Risk: pi can run its tests on code you have not seen yet. That is the
  limit's job; 0 gives the old behaviour for guided work.

## The speed

The plugin does not apply the events as they come. It reads them into a
queue and types the preview at a speed you set: `ctrl+k -` slower, `ctrl+k =`
faster, in steps 10, 20, 40, 80, 160, 320, 640, 1280 characters per second,
and max (as fast as pi sends). The speed is kept in `settings.json` in the
plugin folder. 160/s is only the start value until you choose one.

Only the text that the preview shows costs time: a write's content and an
edit's new text. Every other event waits for the text before it, so the ack
comes after the last character. A 3 KB write at 160/s takes about 19 s to
show; pi waits for it only past the lag limit.

- `ctrl+k space`: pause. The replay stops where it is; pi goes on up to the
  limit. Press it again to go on.
- `ctrl+k .`: the rest of this call's preview at once, also the text pi has
  not sent yet. The next call is typed at your speed again.
- The status bar shows the speed: `· ▶ 160/s`, `· ▶ max`, `· ⏸ paused`,
  and the lag: `· 2 behind`.

Operator's choice (A + C): pi waits for the preview, plus a pause key; the
speed is adjustable, the start value not chosen yet.

## The panel, autosave, names

Operator feedback: the keys were not visible anywhere, and each setting key
showed a ttt notice that covers the whole status bar for about 4 s (measured),
so the new value was hidden. Now:

- `ctrl+k h` opens a drawer: Settings (a `list`; Enter cycles the value,
  `-`/`=` step the speed), pi sessions (Enter follows one, or "automatic"),
  and a key list. ttt calls a drawer's render on every frame, so render
  reads no files. Measured in ttt 1.7.1: a `button` keeps its first label
  after a redraw, a `list` item does not, so the settings are list items;
  Enter on a list item comes as `on_command("activate")`, `on_select` fires
  when the highlight moves.
- No notice for a setting or a session change: the status bar shows it at
  once. The speed has its own status item; a click cycles it.
- Autosave (ttt has none): after a key that changes text (a character,
  Enter, Tab, Backspace, Delete; no ctrl or alt), the plugin saves the file
  after 1 s (or 3 s, or off), only if the file is still open and pi has no
  change to it under way (no preview, no queued event, no open call). A clean
  buffer is what the preview and ttt's reload need.
- Session names: the record carries pi's session name (`title`, from
  `pi.getSessionName()` and `session_info_changed`). The plugin shows the
  title, else the folder, and adds the herdr pane (or pid) when two sessions
  would show the same name.

## The other rules

- Pinned (`ctrl+k a`, or click the status item): no preview and no jumps.
- One run at a time: a call to another file ends the run.
- A call that will not run (the turn ended) gets `abort`: the run ends.
- pi runs the calls of one message in parallel. Calls to one file follow each
  other in one run; calls that alternate between two files of one message may
  show no preview (`before` is the text before the message).

## Known weak points

- When the replay catches up before pi writes, the old text shows between the
  undo and the reload, for up to ~1.5 s.
- ttt's "changed on disk" notice shows for up to 0.25 s before the plugin
  clears it.
- Past the limit pi waits with no time limit. If the plugin acks nothing
  while it lives (a bug), Esc in pi ends the wait.
- A new file: ttt shows "New file", and after the undo the plugin opens the
  file again so ttt reads it from disk.
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
   back to automatic);
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
message to pi. They were replaced by `helpi!`, below: "not smooth enough".)

Found in the spike, ttt 1.7.1: `gmatch("[^\n]*\n")` crashes with a nil
pointer on text that has an empty line. The plugin splits lines with `find`.
Keys `ctrl+k e t i j o r u` belong to ttt; plugin chords that work are
`a d g h n q v w x z`. A `local ready` flag once hid the `ready` handler:
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

The plugin shows the owner's plan in the status bar, cut to about 56
characters: done steps become a count, later next steps drop off as `+k`.
`ctrl+k v` or a click opens a drawer with the whole list. The drawer takes
the keys while it is open, so a plugin key cannot close it: Esc does, as in
every ttt drawer. When the editor moved after the drawer opened (a stop),
`ctrl+k v` gives the drawer the focus again.

## The gutter marks

While the editor replays a change, ttt's gutter (`ttt.bookmarks`, the column
left of the line numbers) shows `▌` on each line of that change and `π` on
the line being typed now. Only the change in the open file, only while it
runs: when it ends, the marks go, and `ctrl+k w` shows the turn after.

- Each call keeps its own line ranges (a write: one; an edit: one per
  replaced text). When a range grows or shrinks, the ranges below it move by
  the same number of lines.
- Bookmarks stay on their line number when lines come in above them, so the
  plugin draws again each tick when the set changes (not at all when it is
  the same).
- One mark per line. The plugin never draws on a line that has another
  plugin's mark, and removes only its own. A bookmarks plugin that sets all
  its marks again (on file open) clears ours; they come back on the next tick.
- Not used: a selection trail (the selection already marks the old text of an
  edit) and diagnostics (they show in the Problems panel as problems).
- The marks stay on screen until the next tick after the change ends; a
  failed draw turns the marks off until ttt starts again; the replay goes on.

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

Streaming: no model tokens, the extension reads what pi streams anyway. The
speed costs wall-clock time only, and only past the lag limit. Each `start`
carries the file's text (up to 256 KB) in the channel log.
helpi!: one side call per question to the session's model, outside pi's
conversation: the prompt (~400 tokens), the file (up to 150 lines, else 20
lines of the top and 60 around the question), pi's plan and up to 2000
characters of pi's last message: about 2–5k tokens in, my estimate, plus the
answer. An `ask` answer also sends one user message to pi (the question and
the same code).
Diff key: no model tokens; each file pi touches is copied twice per turn.
Timeline: the `plan` tool is in every request, about 150 tokens (schema,
one-line snippet, one guideline). Each call costs the steps it sends, about
10 tokens a step, plus a one-line result.

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
left). While it is there, keys in that file and the replay wait, and autosave
does not save it. The plugin writes the help events at once, not through
the replay queue: full speed. The answer is one undo group: one ctrl+z brings
the question back. While it writes, keys that change that file wait; Esc
writes `cancel` to `help.json` and pi stops the call (what is written
stays). When the answer is complete, autosave saves the file at once, as pi
may go on to another file.

Weak points: the kind comes from the model; a wrong kind (a note where you
wanted code) is undone with ctrl+z. The 3 s "did not take the question" timer
can fire on a slow first token only if pi does not write `help` (it does, at
once).

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

The guard runs in pi's `tool_call`, before the replay's own handling, so the
editor never waits to show a call that will not run. A `write` brings its
new text. An `edit` does not: pi matches its old texts against the file
itself. Thus `pi/tools.ts` runs pi's own edit code with a `writeFile` that
throws the text it was given, and that text is what the edit would leave.
The same probe runs pi's write code, so the path is pi's too (`@`, `~`,
unicode spaces); then symlinks are resolved, as the editor sends real paths.
Matching, line endings and the BOM stay pi's. A call the guard blocks gets
the reason as its result; a preview that has started is undone with
`abort` and that reason. A call the guard lets through spends nothing yet:
its allowances are spent, and the stub moves with it, only in `tool_result`
of a call that ran. The editor's lag wait or Esc can still stop it.

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
the `done` event (a notice when the replay shows the change) and in the
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
- **The demo.** `npm run demo` runs the launcher on a fresh copy with
  `SYMBIOSIS_PI=demo/scripted-pi`: the scripted pi takes the place of pi and
  ends when the launcher's record goes (ttt quit). `--real` gives a real pi
  `--name demo @demo/PROMPT.md`.
- **Outside herdr and tmux** it opens ttt only and prints how to start pi.
- **pi stays.** When ttt quits, the launcher removes its record and ends; pi
  is a normal session in its own pane, to go on with or to quit there.
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
- **herdr.** With herdr there, install.sh adds the herdr plugin and a key.
  Its action **Open symbiosis** (`herdr-plugin/scripts/open.sh`) runs
  `symbiosis <folder> --tab` for the focused pane's folder; herdr runs
  actions without a terminal, so an error shows as a herdr notification.
