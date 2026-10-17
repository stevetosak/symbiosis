-- Notes: the answers to ask (features/ask.lua) stay with the lines they are
-- about, in <folder>/.symbiosis/notes/<path>.jsonl (core/notes.lua). A gutter
-- mark ◆ shows a line with a note; a click on it, or ctrl+k d on the line,
-- opens the notes. A note finds its line again by the hash of the line's
-- text; one whose line is gone is "moved": it shows in the file's notes
-- (palette: symbiosis: Notes of This File), not in the gutter.
--
-- The first note in a git folder asks once whether .symbiosis/notes/ goes in
-- .gitignore; Cancel is remembered in .symbiosis/notes/.ignore-asked.
--
-- Gutter marks are ttt's bookmarks (see features/marks.lua): drawn again when
-- the set of lines changes, and each second, in case another plugin cleared them.
local ttt = require("ttt")
local editor = require("ttt.editor")
local events = require("ttt.events")
local fs = require("ttt.fs")
local util = require("core.util")
local folder = require("core.folder")
local notes = require("core.notes")

local MARK = "◆"
local ANCHOR_MS = 300
local IGNORE = ".symbiosis/notes/"

local function setup(app)
	local has_marks, bookmarks = pcall(require, "ttt.bookmarks")
	local files = {}                 -- path -> { notes = list, file = where it is kept }
	local marked, marked_path, marks_key = {}, nil, ""
	local timer = nil

	local function exists(path)
		local ok, yes = pcall(fs.exists, path)
		return ok and yes
	end

	-- The workspace folder of `path`, and the file its notes are kept in.
	local function location(path)
		local dir = folder.guess(path, exists)
		return dir, notes.path(dir, path)
	end

	local function entry(path)
		local e = files[path]
		if e then return e end
		local dir, file = location(path)
		e = { notes = {}, file = file, folder = dir }
		if file and exists(file) then e.notes = notes.decode(fs.read(file) or "") end
		files[path] = e
		return e
	end

	local function save(e)
		if not e.file then return false end
		-- fs.write does not raise on a refusal: it returns nil and the reason.
		local fine, wrote, err = pcall(fs.write, e.file, notes.encode(e.notes))
		if fine and wrote == nil then fine = false end
		if not fine then
			app.log("error", "symbiosis notes: " .. tostring(err))
			ttt.notify("symbiosis: the notes of this file are not kept: " .. tostring(err), "warning")
			return false
		end
		return true
	end

	-- First note in a git folder: ask once about .gitignore. ttt.confirm calls
	-- back only on OK; Cancel says nothing, so the question is marked asked now.
	local function ask_ignore(dir)
		local asked = dir .. "/" .. IGNORE .. ".ignore-asked"
		if not exists(dir .. "/.git") or exists(asked) then return end
		pcall(fs.write, asked, "asked\n")
		local fine, err = pcall(ttt.confirm, "Keep pi's notes out of git? This adds " .. IGNORE .. " to .gitignore.", function()
			local path = dir .. "/.gitignore"
			local text = exists(path) and fs.read(path) or ""
			for l in (text .. "\n"):gmatch("(.-)\n") do
				if l == IGNORE or l == IGNORE:sub(1, -2) then return end
			end
			if text ~= "" and text:sub(-1) ~= "\n" then text = text .. "\n" end
			pcall(fs.write, path, text .. IGNORE .. "\n")
		end)
		if not fine then app.log("warn", "symbiosis notes: could not ask about .gitignore: " .. tostring(err)) end
	end

	-- Draws the gutter for the open file.
	local function draw()
		if not has_marks then return end
		local path = editor.file_path()
		if path ~= marked_path then marked, marked_path, marks_key = {}, path, "" end
		local want, parts = {}, {}
		if path and path ~= "" then
			local last = editor.line_count()
			for line in pairs(notes.by_line(entry(path).notes)) do
				if line <= last then
					want[line] = true
					table.insert(parts, line)
				end
			end
		end
		table.sort(parts)
		local key = table.concat(parts, ",")
		local lost = false
		for line in pairs(want) do
			local b = bookmarks.get(line)
			if not b or b.icon ~= MARK then lost = true end
		end
		if key == marks_key and not lost then return end
		marks_key = key
		for line in pairs(marked) do
			if not want[line] then
				local b = bookmarks.get(line)
				if b and b.icon == MARK then bookmarks.remove(line) end
			end
		end
		marked = {}
		for line in pairs(want) do
			local b = bookmarks.get(line)
			if not b or b.icon == MARK then
				if not b then bookmarks.set(line, MARK, "success") end
				marked[line] = true
			end
		end
	end

	local function draw_safe()
		local fine, err = pcall(draw)
		if not fine then
			has_marks = false
			app.log("error", "symbiosis note marks: " .. tostring(err))
		end
	end

	-- The lines moved: find each note's line again (in the open file).
	local function reanchor()
		local path = editor.file_path()
		if not path or path == "" or not files[path] then return end
		local e = files[path]
		if #e.notes == 0 then return end
		if notes.anchor(e.notes, editor.buffer_lines()) then save(e) end
		draw_safe()
	end

	app:on("change", function()
		if timer then ttt.clear_timeout(timer) end
		timer = ttt.set_timeout(ANCHOR_MS, function()
			timer = nil
			local fine, err = pcall(reanchor)
			if not fine then app.log("error", "symbiosis notes: " .. tostring(err)) end
		end)
	end)
	app:on("file", function()
		local path = editor.file_path()
		if path and path ~= "" then
			files[path] = nil
			local e = entry(path)
			if #e.notes > 0 then
				notes.anchor(e.notes, editor.buffer_lines())
			end
		end
		draw_safe()
	end)
	app:on("ready", draw_safe)
	app:on("second", draw_safe)

	-- A click on a mark opens its notes (ttt may not have the event: then ctrl+k d does it).
	local fine = pcall(events.on, "gutter.click", function(a, b)
		local path, line = a, b
		if type(a) == "table" then path, line = a.path or a.file, a.line end
		if type(path) ~= "string" or type(line) ~= "number" then return false end
		if not notes.by_line(entry(path).notes)[line] then return false end
		app:emit("notes.open", path, line)
		return false
	end)
	if not fine then app.log("warn", "symbiosis: this ttt has no gutter.click; ctrl+k d opens the notes") end

	return {
		-- The notes of `path` (all, moved too), oldest first.
		list = function(path) return entry(path).notes end,
		-- The notes at `line` of `path`, oldest first.
		at = function(path, line) return notes.by_line(entry(path).notes)[line] or {} end,
		-- The folder the notes of `path` are kept in; pi makes it (ttt's fs cannot).
		dir = function(path)
			local e = entry(path)
			return e.file and e.file:match("^(.*)/[^/]*$") or ""
		end,
		-- Keeps an answer for `line` of `path`; `text` is that line's text then.
		add = function(path, line, text, fields)
			local e = entry(path)
			if not e.file then return nil end
			local note = notes.new({ [line] = text }, line, fields)
			table.insert(e.notes, note)
			local first = not exists(e.file)
			if save(e) and first then ask_ignore(e.folder) end
			draw_safe()
			return note
		end,
		forget = function(path) files[path] = nil end,
	}
end

return {
	name = "notes",
	setup = setup,
}
