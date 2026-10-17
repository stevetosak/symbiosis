-- Review per stub (features/review.lua): the pure parts. pi's session record
-- holds `review`, the bodies it filled that the developer has not acked
-- (core/review.ts, `Landed`). Here: flattening those lists, finding a body's
-- function again in the buffer, counting by file, choosing what to show.
local notes = require("core.notes")

local M = {}

-- Every un-acked body of `sessions`, each with the id of its session as
-- `session`; a bad entry is dropped. Order: by session, then as pi sent it.
function M.collect(sessions)
	local out = {}
	for _, rec in ipairs(sessions) do
		for _, l in ipairs(type(rec.review) == "table" and rec.review or {}) do
			if type(l) == "table" and type(l.id) == "string" and type(l.path) == "string" then
				local copy = { session = rec.id }
				for k, v in pairs(l) do copy[k] = v end
				table.insert(out, copy)
			end
		end
	end
	return out
end

-- The un-acked bodies in `list` (from collect) that `acked` (id -> true) does not hold.
function M.pending(list, acked)
	local out = {}
	for _, l in ipairs(list) do
		if not acked[l.id] then table.insert(out, l) end
	end
	return out
end

-- Where the function of `landed` is in `lines`: its first line, found again by
-- the text pi saw when the body landed (the nearest equal line, like a note).
-- nil when that line is gone.
function M.line_of(landed, lines)
	local probe = { { line = landed.line or 1, hash = notes.hash(landed.anchor or "") } }
	notes.anchor(probe, lines)
	return probe[1].line and not probe[1].moved and probe[1].line or nil
end

-- path -> how many bodies of `list` wait there.
function M.count(list)
	local out = {}
	for _, l in ipairs(list) do out[l.path] = (out[l.path] or 0) + 1 end
	return out
end

-- The body to show for ctrl+k x: in the open file, the one nearest the cursor
-- line (`lines`: id -> line from line_of); else the newest of the followed
-- session; else the newest at all. nil when `list` is empty.
function M.choose(list, path, cursor, lines, owner)
	local best, gap = nil, nil
	for _, l in ipairs(list) do
		if l.path == path and lines[l.id] then
			local d = math.abs(lines[l.id] - cursor)
			if not gap or d < gap then best, gap = l, d end
		end
	end
	if best then return best end
	for i = #list, 1, -1 do
		if owner and list[i].session == owner then return list[i] end
	end
	return list[#list]
end

-- The ids of `list` that are not in `seen` (id -> true).
function M.fresh(list, seen)
	local out = {}
	for _, l in ipairs(list) do
		if not seen[l.id] then table.insert(out, l) end
	end
	return out
end

return M
