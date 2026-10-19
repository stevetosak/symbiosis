-- The lines pi changed, in the open file: a coloured bar ▌ in the gutter on
-- each of them, one colour for each plan step, and a hint underline over each
-- run with a hover text (the step and pi's `why`). The lines come from the
-- change log (pi/changelog.ts, core/changelist.lua): where each change put
-- them, moved by the later changes. When you edited the file after pi, the
-- lines you edited lose their mark and the others keep it. Nothing blocks pi.
--
-- ttt gives a plugin no line background, so this is the gutter (ttt.bookmarks)
-- and a diagnostic (ttt.diagnostics). A line with a note or a review mark keeps
-- that mark: the bar is not drawn there.
--
-- A change you marked seen (ctrl+k / for the open file, or `s` in the plan
-- drawer) leaves no bar: core/changelist.lua `mark_seen` keeps them in
-- log/<session>/seen.json. ctrl+k y opens the diff of the change that wrote
-- the line under the cursor (features/changediff.lua).
--
-- Hooks it takes: "file", "second", "done", "change", "seen". API: `at(line)`.
local ttt = require("ttt")
local editor = require("ttt.editor")
local json = require("ttt.json")
local util = require("core.util")
local changelist = require("core.changelist")

local MARK = "▌"
local SETTLE_MS = 300 -- pi wrote the file: ttt reloads the buffer a moment later

local function setup(app)
	local has_marks, bookmarks = pcall(require, "ttt.bookmarks")
	local has_diag, diagnostics = pcall(require, "ttt.diagnostics")
	local gutter = has_marks and require("core.gutter").new(bookmarks, MARK, "muted") or nil
	local sessions = app:need("sessions")
	local channel, settings = app.channel, app.settings
	local texts = {}        -- change id -> the lines of the file after that change
	local published = nil   -- the path that holds our diagnostics, and the key of them
	local drawn_key = ""
	local timer = nil

	settings:define("changemarks", {
		values = { true, false }, label = "Changed lines", order = 45,
		text = function(v) return v and "marked in the gutter" or "not marked" end,
		on_change = function() drawn_key = "" end,
	})

	-- The lines of the file as it was after `change`, or nil (not kept: too big).
	local function after_lines(owner, change)
		if not change.texts then return nil end
		if texts[change.id] == nil then
			local saved = channel:read_json("log/" .. owner.id .. "/" .. change.id .. ".json")
			texts[change.id] = type(saved) == "table" and type(saved.after) == "string" and util.split(saved.after) or false
		end
		return texts[change.id] or nil
	end

	local function clear_diagnostics()
		if has_diag and published then pcall(diagnostics.clear, published.path) end
		published = nil
	end

	local function plan_of(owner)
		return owner and type(owner.plan) == "table" and owner.plan or {}
	end

	-- line -> the change that wrote it, in the open file as it is now, the
	-- changes you did not see yet. Also the owner and the whole log.
	local function current()
		local path = editor.file_path()
		local owner = sessions.owner()
		if not path or path == "" or not owner then return {}, owner, {} end
		local changes = changelist.read_log(channel, owner)
		local marks = changelist.marked_lines(changes, path, changelist.read_seen(channel, owner))
		if next(marks) then
			local last
			for _, c in ipairs(changes) do if c.path == path then last = c end end
			local after = last and after_lines(owner, last)
			if after then marks = changelist.remap(marks, after, editor.buffer_lines()) end
		end
		return marks, owner, changes
	end

	local function draw()
		local path = editor.file_path()
		local want, runs = {}, {}
		local owner = sessions.owner()
		local steps = plan_of(owner)
		if settings:get("changemarks") then
			local marks = current()
			local count = editor.line_count()
			for line, c in pairs(marks) do
				if line <= count then want[line] = changelist.style_of(steps, c) end
			end
			runs = changelist.runs(marks)
		end
		if gutter then gutter.draw(path, want) end
		if not has_diag then return end
		-- The hover texts: one hint over each run of lines.
		local items = {}
		for _, r in ipairs(runs) do
			if r.last <= editor.line_count() then
				local why = r.change.why and (" · " .. r.change.why) or ""
				local step = r.change.stepText and (r.change.stepText .. " · ") or ""
				table.insert(items, {
					line = r.first, col = 1, end_line = r.last, end_col = math.max(2, util.runes(editor.get_line(r.last)) + 1),
					severity = "hint", style = changelist.style_of(steps, r.change),
					message = "pi · " .. step .. (r.change.created and "new file" or "changed") .. why, source = "pi",
				})
			end
		end
		local key = (path or "") .. json.encode(items)
		if published and published.key == key then return end
		if published and published.path ~= path then clear_diagnostics() end
		if #items > 0 then
			pcall(diagnostics.publish, path, items)
			published = { path = path, key = key }
		else
			clear_diagnostics()
		end
	end

	local function draw_safe()
		local fine, err = pcall(draw)
		if not fine then
			has_marks, has_diag = false, false
			gutter = nil
			app.log("error", "symbiosis change marks: " .. tostring(err))
		end
	end

	-- A moment after pi's write, and after your typing stopped.
	local function later()
		if timer then pcall(ttt.clear_timeout, timer) end
		timer = ttt.set_timeout(SETTLE_MS, function()
			timer = nil
			draw_safe()
		end)
	end

	-- ctrl+k /: the changes pi made in the open file are seen: the bars go.
	local function seen_here()
		local path = editor.file_path()
		local owner = sessions.owner()
		if not path or path == "" or not owner then return ttt.notify("symbiosis: no file, or no pi followed", "info") end
		local changes = changelist.read_log(channel, owner)
		local ids, seen = {}, changelist.read_seen(channel, owner)
		for _, c in ipairs(changes) do
			if c.path == path and not seen[c.id] then table.insert(ids, c.id) end
		end
		if #ids == 0 then return ttt.notify("symbiosis: no change of pi in " .. util.name(path) .. " waits to be seen", "info") end
		changelist.mark_seen(channel, owner, ids, changes)
		app:emit("seen")
		ttt.notify("symbiosis: " .. #ids .. " change" .. (#ids == 1 and "" or "s") .. " of pi in " .. util.name(path) .. " marked seen", "info")
	end

	app:command({ id = "symbiosis.markSeen", title = "symbiosis: Mark pi's Changes in This File Seen", key = "ctrl+k /", run = seen_here })
	app:command({
		id = "symbiosis.markAllSeen", title = "symbiosis: Mark All of pi's Changes Seen",
		run = function()
			local owner = sessions.owner()
			if not owner then return ttt.notify("symbiosis: no pi followed", "info") end
			local changes = changelist.read_log(channel, owner)
			local ids = {}
			for _, c in ipairs(changes) do table.insert(ids, c.id) end
			changelist.mark_seen(channel, owner, ids, changes)
			app:emit("seen")
			ttt.notify("symbiosis: all of pi's changes marked seen", "info")
		end,
	})
	app:hint({ key = "ctrl+k /", text = "mark pi's changes in this file seen", order = 82 })

	app:on("seen", draw_safe)
	app:on("file", draw_safe)
	app:on("ready", draw_safe)
	app:on("second", draw_safe)
	app:on("done", later)
	app:on("change", later)
	return {
		-- The change that wrote `line` of the open file (not seen yet), and the owner.
		at = function(line)
			local marks, owner = current()
			return marks[line], owner
		end,
	}
end

return { name = "changemarks", needs = { "sessions", "follow" }, setup = setup }
