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
| Channel | `pi/channel.ts` | Files in the plugin folder: `events.jsonl`, `head.json`, `ttt.json`, `ack.json`. |
| Suggestions | `pi/suggest.ts` | Pure: finds `AI!` and `AI?` comments, writes the message for pi. |
| ttt plugin | `ttt/symbiosis/plugin.lua` | Polls every 40 ms. Shows the preview. Follows the result. Marks suggestions. Opens the chat. |

A ttt plugin cannot open a socket and can read only its own folder and the
workspace. Thus the channel is files in the plugin folder.

## The buffer: one rule

**The file on disk is the truth. The preview is never saved.**

1. `start`: the plugin opens the file. If the buffer has unsaved changes (its
   Adler-32 is not the sum pi sent), there is no preview for this call.
2. `text`: the plugin opens one undo group and types into the buffer. A write
   clears the buffer and types the new content. An edit selects its `oldText`
   (only if it occurs once), then types `newText` over it.
3. `ready`: pi is about to run the tool. The plugin closes the undo group,
   undoes it once (the buffer is clean again) and writes the call id to
   `ack.json`. pi waits for the ack (at most 1.5 s, only if the heartbeat is
   live).
4. The tool writes the file. ttt reloads a clean buffer by itself.
5. `done`: the editor goes to the changed line. `stop` (end of the turn) goes
   there even when you pinned the editor.

Measured with headless ttt 1.7.1: undo FIRST, then the disk change, gives a
reload. A disk change under a dirty buffer gives no reload, and a later undo
leaves a clean but stale buffer. That is why the order in step 3 is fixed.

## The other rules

- Pinned (`ctrl+k a`, or click the status item): no preview and no jumps.
- One preview at a time. A new call closes the open undo group.
- A key press in the editor ends the preview: the buffer is yours.
- A call that will not run (the turn ended) gets `abort`: the preview is undone.
- pi runs the calls of one message in parallel. Only one preview can be open,
  so the second call of a message may show no preview.

## Known weak points

- Between the undo and the reload, the old text shows for up to ~1.5 s.
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
2. else the session whose folder holds the open file: the deepest folder, then
   the most recent;
3. else, with no file open, the most recent session.

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

## The cost

Streaming: no model tokens, the extension reads what pi streams anyway.
Suggestions: one user message per `ctrl+k d`, about 40 tokens plus ~20 per
marker.
Timeline: the `plan` tool is in every request, about 150 tokens (schema,
one-line snippet, one guideline). Each call costs the steps it sends, about
10 tokens a step, plus a one-line result.
