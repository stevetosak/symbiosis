-- Autosave: a while after your last key press, the file is saved, so the
-- buffer is clean when pi writes it (a dirty buffer gets no preview and no
-- reload). Never while pi has a change to this file under way: that would
-- save a preview, or the old text over pi's write.
local ttt = require("ttt")
local editor = require("ttt.editor")
local util = require("core.util")

-- Milliseconds after your last key press; 0 = off.
local AUTOSAVES = { 0, 1000, 3000 }

return {
	name = "autosave",
	needs = { "replay" },
	setup = function(app)
		local replay = app:need("replay")
		local settings = app.settings
		local timer = nil

		settings:define("autosave", {
			values = AUTOSAVES, default = 2, label = "Autosave", order = 30,
			text = function(ms) return ms == 0 and "off" or string.format("%g s after you type", ms / 1000) end,
		})

		-- `soon`: at once (a helpi! answer is complete: pi may go to another file next).
		local function schedule(soon)
			local ms = settings:get("autosave")
			local path = editor.file_path() or ""
			if ms == 0 or path == "" then return end
			if timer then ttt.clear_timeout(timer) end
			timer = ttt.set_timeout(soon and 10 or ms, function()
				timer = nil
				if editor.file_path() ~= path or not replay.quiet(path) then return end
				ttt.exec_command("file.save")
			end)
		end

		-- Late: only a key that no other feature took.
		app:on("key", function(key)
			if util.edits_text(key) then schedule() end
			return false
		end, 90)

		return { schedule = schedule }
	end,
}
