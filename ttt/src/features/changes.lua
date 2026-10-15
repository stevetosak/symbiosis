-- The diff key. pi/changes.ts keeps, per file, the text before pi's last
-- turn first changed it and the text after (changes/index.json and
-- changes/<key>.json). ctrl+k w shows that diff for the open file, or for
-- the last file pi changed, and the `why` pi gave for those changes.
local ttt = require("ttt")
local editor = require("ttt.editor")
local util = require("core.util")

local name = util.name

return {
	name = "changes",
	setup = function(app)
		local channel = app.channel

		local function show_changes()
			local index = channel:read_json("changes/index.json")
			if type(index) ~= "table" or type(index.files) ~= "table" or #index.files == 0 then
				return ttt.notify("symbiosis: pi changed no file in its last turn", "info")
			end
			local open = editor.file_path()
			local pick = index.files[#index.files]
			for _, f in ipairs(index.files) do
				if f.path == open then pick = f end
			end
			local change = channel:read_json("changes/" .. pick.key .. ".json")
			if type(change) ~= "table" then
				return ttt.notify("symbiosis: the changes to " .. name(pick.path) .. " are not readable", "warning")
			end
			if change.before == change.after then
				return ttt.notify("symbiosis: " .. name(pick.path) .. " is the same as before pi's last turn", "info")
			end
			ttt.open_diff("pi: " .. name(pick.path) .. " (last turn)", util.split(change.before), util.split(change.after), pick.path)
			-- pi's reasons for the choices in these changes (the `why` of its edits).
			if type(change.whys) == "table" and #change.whys > 0 then
				ttt.notify("pi, why: " .. table.concat(change.whys, " · "), "info")
			end
			if open and open ~= "" and pick.path ~= open then
				ttt.notify("symbiosis: pi did not change this file; this is " .. name(pick.path) .. ", its last change", "info")
			end
		end

		app:command({ id = "symbiosis.showChanges", title = "symbiosis: What pi Changed in Its Last Turn (diff)", key = "ctrl+k w", run = show_changes })
		app:hint({ key = "ctrl+k w", text = "what pi changed (diff)", order = 80 })

		return { show = show_changes }
	end,
}
