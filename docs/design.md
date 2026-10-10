# symbiosis: the design of the first slice

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
| ttt plugin | `ttt/symbiosis/plugin.lua` | Polls every 40 ms. Shows the preview. Follows the result. |

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
- One pi session at a time: the last writer wins.

## The cost

No model tokens: the extension reads what pi streams anyway.
