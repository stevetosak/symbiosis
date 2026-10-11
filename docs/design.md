# symbiosis: the design

## The goal

You watch the agent work in your editor, as it works. Each `write` and `edit`
of the pi agent types itself into the ttt buffer while the model writes it.
Then the editor shows the result at the changed line.

## The parts

| Part | File | Job |
|---|---|---|
| pi extension | `pi/index.ts` | Reads the tool calls while they stream. Writes events. |
| Events | `pi/stream.ts` | Pure: turns growing arguments into small `text` events. |
| Channel | `pi/channel.ts` | Files in the plugin folder: `events.jsonl`, `head.json`, `ttt.json` (with the lag limit), `ack.json` (the changes shown). |
| Suggestions | `pi/suggest.ts` | Pure: finds `AI!` and `AI?` comments, writes the message for pi. |
| ttt plugin | `ttt/symbiosis/plugin.lua` | Polls every 40 ms. Shows the preview. Follows the result. Marks suggestions. Opens the chat. |

A ttt plugin cannot open a socket and can read only its own folder and the
workspace. Thus the channel is files in the plugin folder.

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

## Slice 2: sessions and suggestions

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

Only the owner writes events and gets the markers. The status bar shows it:
`π symbiosis ● working`, `π none`, or `π tosak-docs · old, /reload` for an
extension with another protocol. `ctrl+k g` or a click runs
`herdr agent focus <pane>` (the plugin's `system.exec` permission allows
`herdr` only). When the owner changes, its first event starts the log again,
so `head.json` and the log always agree.

**Suggestions.** You write a comment that ends in `AI!` (make this change) or
`AI?` (answer this). Where the comment is sets its reach:

| Where | Reach |
|---|---|
| After code on the same line | that line |
| On its own line | the block below it (function, class, ...) |
| On its own line at the top of the file, a blank line after it | the whole file |

The plugin marks each one with an info diagnostic. `ctrl+k d` saves the file
and writes `request.json` addressed to the owner (`to`). No owner: the plugin
says so and sends nothing. No answer in 3 s: the plugin says so. The owner's
extension finds every marker (`git grep` over
the workspace, plus the saved file), sends ONE user message to pi (as a
follow-up when pi is busy), and writes a `sent` event back. The message tells
pi to delete each marker when it is done, so a closed suggestion leaves no
trace in the code.

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

## The cost

Streaming: no model tokens, the extension reads what pi streams anyway. The
speed costs wall-clock time only, and only past the lag limit. Each `start`
carries the file's text (up to 256 KB) in the channel log.
Suggestions: one user message per `ctrl+k d`, about 40 tokens plus ~20 per
marker.
Diff key: no model tokens; each file pi touches is copied twice per turn.
Timeline: the `plan` tool is in every request, about 150 tokens (schema,
one-line snippet, one guideline). Each call costs the steps it sends, about
10 tokens a step, plus a one-line result.
