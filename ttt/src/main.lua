-- symbiosis, the ttt side: the plugin's entry. ttt runs one file per plugin
-- and lets it require only its own modules (ttt, ttt.editor, ...), so the
-- sources in ttt/src are bundled into ttt/symbiosis/plugin.lua by
-- ttt/build.ts. See ttt/README.md for how to write a feature.
--
-- pi (the extension in pi/) appends events to events.jsonl in the plugin
-- folder; the features read them through the channel (core/channel.lua):
--   sessions  the pi sessions; the one the editor follows (the owner)
--   plan      pi's plan in the status bar, ctrl+k v
--   tree      the "pi files" sidebar
--   replay    pi's writes and edits typed in the buffer, at your speed
--   marks     the gutter: ▌ on the change typed now, π on its line
--   autosave  saves your file a while after you type
--   helpi     a comment that ends in `helpi!` asks pi
--   changes   ctrl+k w: what pi changed in its last turn
--   panel     ctrl+k h: settings, sessions, keys
-- See docs/design.md.
local app = require("core.app").new()

app:use("features.sessions")
app:use("features.plan")
app:use("features.tree")
app:use("features.replay")
app:use("features.marks")
app:use("features.autosave")
app:use("features.helpi")
app:use("features.fill")
app:use("features.changes")
app:use("features.panel")

app:start()
