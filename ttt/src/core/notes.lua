-- Notes: the answers to "ask" (features/ask.lua), kept for the lines they
-- are about. A note belongs to a line by the hash of that line's text, not
-- by its number: lines come and go above it, so the number is found again
-- (`anchor`). Pure: no ttt API but the json module.
--
-- One file for each source file: <folder>/.symbiosis/notes/<path>.jsonl, a
-- JSON object a line:
--   { line, hash, question, answer, links, terms, time }
local json = require("ttt.json")
local util = require("core.util")

local M = {}

-- The hash of a line's text; blanks at the ends do not count.
function M.hash(text)
	return util.adler32((text:gsub("^%s+", ""):gsub("%s+$", "")))
end

local function blank(text) return text:match("^%s*$") ~= nil end

-- Where the notes of `file` are kept, or nil when the file is not under `folder`.
function M.path(folder, file)
	if not folder or file:sub(1, #folder + 1) ~= folder .. "/" then return nil end
	return folder .. "/.symbiosis/notes/" .. file:sub(#folder + 2) .. ".jsonl"
end

-- A new note for line `line` of `lines`.
function M.new(lines, line, fields)
	return {
		line = line, hash = M.hash(lines[line] or ""), question = fields.question or "", answer = fields.answer or "",
		links = fields.links or {}, terms = fields.terms or {}, time = fields.time or os.time(),
	}
end

-- Finds each note's line again in `lines`: where its hash is still (nothing
-- to do), else the nearest line with the same hash, else the note is
-- `moved` (no line). A note on a blank line has no hash to find: moved.
-- Returns true when a note's line changed (the file wants a write).
function M.anchor(notes, lines)
	local changed = false
	for _, n in ipairs(notes) do
		local at = nil
		if n.hash ~= M.hash("") then
			for d = 0, math.max(#lines, n.line) do
				local up, down = n.line - d, n.line + d
				if up >= 1 and up <= #lines and not blank(lines[up]) and M.hash(lines[up]) == n.hash then at = up break end
				if d > 0 and down >= 1 and down <= #lines and not blank(lines[down]) and M.hash(lines[down]) == n.hash then at = down break end
			end
		end
		if at ~= nil and (at ~= n.line or n.moved) then changed = true end
		if at then n.line, n.moved = at, nil else n.moved = true end
	end
	return changed
end

-- line -> the notes of that line (not the moved ones), oldest first.
function M.by_line(notes)
	local out = {}
	for _, n in ipairs(notes) do
		if not n.moved then
			out[n.line] = out[n.line] or {}
			table.insert(out[n.line], n)
		end
	end
	return out
end

-- jsonl text → the list of notes; a line that is not a note is skipped.
function M.decode(text)
	local out = {}
	for l in ((text or "") .. "\n"):gmatch("(.-)\n") do
		if not blank(l) then
			local ok, n = pcall(json.decode, l)
			if ok and type(n) == "table" and type(n.line) == "number" and type(n.hash) == "number" and type(n.answer) == "string" then
				n.links = type(n.links) == "table" and n.links or {}
				n.terms = type(n.terms) == "table" and n.terms or {}
				n.question = type(n.question) == "string" and n.question or ""
				table.insert(out, n)
			end
		end
	end
	return out
end

-- The list of notes → jsonl text. `moved` is not kept: it is found again.
function M.encode(notes)
	local out = {}
	for _, n in ipairs(notes) do
		local copy = {}
		for k, v in pairs(n) do
			if k ~= "moved" then copy[k] = v end
		end
		table.insert(out, json.encode(copy))
	end
	return #out == 0 and "" or table.concat(out, "\n") .. "\n"
end

return M
