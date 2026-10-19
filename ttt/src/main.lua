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
--   follow    which file pi writes; the editor follows it, when you turn that on
--   changemarks  the lines pi changed: a bar in the gutter, a colour per plan step, hover text
--   changediff   ctrl+k y: the diff of the change at the cursor line
--   autosave  saves your file a while after you type
--   helpi     a comment that ends in `helpi!` asks pi; on a stub, pi fills it
--   fill      a fill: a stub's body, or a new function under its description;
--             ctrl+k f; pi's proposals
--   notes     the answers to ask, kept for their lines; ◆ in the gutter
--   review    ctrl+k x: the bodies pi filled, until you ack them; ● in the gutter
--   ask       ctrl+k d and `why!`: ask pi about code, in a drawer
--   changes   ctrl+k w: what pi changed in its last turn
--   run       F5: run configurations, the Run panel (bottom)
--   close     ctrl+k z: close symbiosis, pi and ttt together
--   panel     ctrl+k h: settings, sessions, keys
-- See docs/design.md.
local app = require("core.app").new()

app:use("features.sessions")
app:use("features.plan")
app:use("features.tree")
app:use("features.follow")
app:use("features.changemarks")
app:use("features.changediff")
app:use("features.autosave")
app:use("features.helpi")
app:use("features.fill")
app:use("features.notes")
app:use("features.review")
app:use("features.ask")
app:use("features.changes")
app:use("features.run")
app:use("features.close")
app:use("features.panel")

app:start()
