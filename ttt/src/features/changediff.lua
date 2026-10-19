-- The exact diff of pi's changes: what a change did, from the text before
-- to the text after (pi/changelog.ts keeps both, log/<session>/<id>.json).
--
--   ctrl+k .   the change that wrote the line under the cursor (the bar in the gutter)
--   plan drawer, `d` on a file row: the file's changes in that step as one diff
--
-- A notice lists pi's reasons (`why`) for those changes. The diff is ttt's own
-- diff tab: it does not block pi, and it stays a tab until you close it.
local ttt = require("ttt")
local editor = require("ttt.editor")
local util = require("core.util")

local function setup(app)
	local changemarks = app:need("changemarks")
	local channel = app.channel

	local function texts(owner, change)
		local saved = channel:read_json("log/" .. owner.id .. "/" .. change.id .. ".json")
		if type(saved) ~= "table" or type(saved.after) ~= "string" then return nil end
		return saved
	end

	-- The diff of `changes` (the same file, oldest first): the text before the
	-- first, against the text after the last.
	local function open(owner, changes)
		local first, last = changes[1], changes[#changes]
		if not first then return ttt.notify("symbiosis: no change to show", "info") end
		local a, b = texts(owner, first), texts(owner, last)
		if not a or not b then
			return ttt.notify("symbiosis: pi's text of " .. util.name(first.path) .. " is not kept (the file was too big)", "warning")
		end
		local before = type(a.before) == "string" and util.split(a.before) or {}
		local after = util.split(b.after)
		if table.concat(before, "\n") == table.concat(after, "\n") then
			return ttt.notify("symbiosis: " .. util.name(first.path) .. " is the same after these changes", "info")
		end
		local step = first.stepText and (" · " .. util.cut(first.stepText, 30)) or ""
		ttt.open_diff("pi: " .. util.name(first.path) .. step .. (#changes > 1 and (" (" .. #changes .. " changes)") or ""), before, after, first.path)
		local whys = {}
		for _, c in ipairs(changes) do
			if type(c.why) == "string" and c.why ~= "" then table.insert(whys, c.why) end
		end
		if #whys > 0 then ttt.notify("pi, why: " .. table.concat(whys, " · "), "info") end
	end

	local function change_here()
		local line = editor.cursor().line
		local change, owner = changemarks.at(line)
		if not change then
			return ttt.notify("symbiosis: no change of pi on this line (the bar in the gutter shows them)", "info")
		end
		open(owner, { change })
	end

	app:command({ id = "symbiosis.changeHere", title = "symbiosis: pi's Change at This Line (diff)", key = "ctrl+k .", run = change_here })
	app:hint({ key = "ctrl+k .", text = "pi's change at this line (diff)", order = 81 })
	return { open = open }
end

return { name = "changediff", needs = { "changemarks" }, setup = setup }
