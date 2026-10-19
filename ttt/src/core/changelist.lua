-- The change list: pi's plan, each step with the files pi named for it and
-- the files it really changed in it (the change log, pi/changelog.ts). Pure:
-- plan.lua gives it the steps and the log, it gives back the list's nodes and
-- what each node does when it is activated.
--
--   steps    pi's plan: {text, state = done|now|next, files = {absolute paths}?}
--   changes  the log, oldest first: {id, seq, path, step, stepText, created, hunks, why}
--   opts     cwd (paths show relative to it), editing(path) -> pi has a call open there
--
-- Returns nodes, actions: `actions[node.id]` is {kind = "file", path, line,
-- changes} for a file row (the changes it lists, oldest first), and
-- {kind = "step", changes} for a step row (all of its changes). opts.seen: id -> true.
local util = require("core.util")

local M = {}

-- The owner's change log (pi/changelog.ts): the changes, oldest first.
function M.read_log(channel, owner)
	if not owner then return {} end
	local index = channel:read_json("log/" .. owner.id .. "/index.json")
	return type(index) == "table" and type(index.changes) == "table" and index.changes or {}
end

-- The changes you marked seen: id -> true (log/<session>/seen.json, which
-- the plugin writes beside pi's log; pi's 7-day clean removes both).
function M.read_seen(channel, owner)
	if not owner then return {} end
	local saved = channel:read_json("log/" .. owner.id .. "/seen.json")
	return type(saved) == "table" and type(saved.ids) == "table" and saved.ids or {}
end

-- Marks the changes with these ids seen. Ids of changes that left the log go.
function M.mark_seen(channel, owner, ids, changes)
	local seen = M.read_seen(channel, owner)
	for _, id in ipairs(ids) do seen[id] = true end
	local keep = {}
	for _, c in ipairs(changes or {}) do
		if seen[c.id] then keep[c.id] = true end
	end
	channel:write_json("log/" .. owner.id .. "/seen.json", { ids = keep })
end

-- The index of the plan step a change belongs to. The plan may have been
-- rewritten since: the same place with the same text, else the first step with
-- that text, else none (the change is listed under "Other changes").
function M.step_index(steps, change)
	if change.step == nil or change.stepText == nil then return nil end
	local at = steps[change.step + 1]
	if at and at.text == change.stepText then return change.step + 1 end
	for i, s in ipairs(steps) do
		if s.text == change.stepText then return i end
	end
	return nil
end

-- The line a change starts at (1-based), in the file as that change left it.
function M.first_line(change)
	local h = type(change.hunks) == "table" and change.hunks[1] or nil
	return h and math.max(1, h.newStart) or 1
end

local function relative(path, cwd)
	if cwd and cwd ~= "" and util.starts_with(path, cwd .. "/") then return path:sub(#cwd + 2) end
	return util.short(path)
end

-- The files of one group: the changed ones in the order pi first changed
-- them, then the planned ones it has not reached.
local function entries(planned, changed)
	local list, by = {}, {}
	for _, c in ipairs(changed) do
		local e = by[c.path]
		if not e then
			e = { path = c.path, changes = {}, planned = false }
			by[c.path] = e
			table.insert(list, e)
		end
		table.insert(e.changes, c)
	end
	for _, path in ipairs(planned) do
		if by[path] then
			by[path].planned = true
		else
			table.insert(list, { path = path, changes = {}, planned = true })
		end
	end
	return list
end

local function plural(n, word)
	return n .. " " .. word .. (n == 1 and "" or "s")
end

-- Whether every change of the list is seen.
local function all_seen(list, seen)
	for _, c in ipairs(list) do
		if not seen[c.id] then return false end
	end
	return #list > 0
end

-- The row of one file. Named but untouched: muted, "planned". Changed: "●";
-- pi has a call open in it: "✎"; you marked every change seen: "✓", muted.
-- When the step names files, a changed file it did not name says "unplanned".
local function file_node(e, id, group_named, opts)
	local editing = opts.editing and opts.editing(e.path)
	local seen = all_seen(e.changes, opts.seen or {}) and not editing
	local mark = editing and "✎" or (seen and "✓" or (#e.changes > 0 and "●" or "·"))
	local parts = {}
	if #e.changes == 0 then
		table.insert(parts, "planned")
	else
		if e.changes[1].created then table.insert(parts, "new") end
		if #e.changes > 1 or not e.changes[1].created then table.insert(parts, plural(#e.changes, "change")) end
		if seen then table.insert(parts, "seen") end
		if group_named and not e.planned then table.insert(parts, "unplanned") end
	end
	local label = mark .. " " .. relative(e.path, opts.cwd)
	if #parts > 0 then label = label .. " · " .. table.concat(parts, " · ") end
	local line = #e.changes > 0 and M.first_line(e.changes[1]) or 1
	return { id = id, label = label, muted = (#e.changes == 0 or seen) and not editing },
		{ kind = "file", path = e.path, line = line, changes = e.changes }
end

-- The list: a node per plan step with its files under it, then "Other
-- changes": what pi changed when no step of the plan matched.
function M.build(steps, changes, opts)
	opts = opts or {}
	local per_step, other = {}, {}
	for _, c in ipairs(changes or {}) do
		local i = M.step_index(steps, c)
		if i then
			per_step[i] = per_step[i] or {}
			table.insert(per_step[i], c)
		else
			table.insert(other, c)
		end
	end

	local nodes, actions = {}, {}
	local function group(id, label, list, named, state)
		local children = {}
		for n, e in ipairs(list) do
			local node, action = file_node(e, id .. ":" .. n, named, opts)
			table.insert(children, node)
			actions[node.id] = action
		end
		local all = {}
		for _, e in ipairs(list) do
			for _, c in ipairs(e.changes) do table.insert(all, c) end
		end
		actions[id] = { kind = "step", changes = all }
		local node = { id = id, label = label, muted = state == "done", children = #children > 0 and children or nil }
		if node.children then
			node.expandable = true
			node.expanded = state ~= "done"
		end
		table.insert(nodes, node)
	end

	for i, s in ipairs(steps) do
		local planned = type(s.files) == "table" and s.files or {}
		local icon = s.state == "done" and "✓" or (s.state == "now" and "▶" or "·")
		group("step:" .. i, icon .. " " .. s.text, entries(planned, per_step[i] or {}), #planned > 0, s.state)
	end
	if #other > 0 then group("other", "Other changes", entries({}, other), false, "now") end
	return nodes, actions
end

-- The lines pi changed ------------------------------------------------------------

-- Where a line of the file stands after a later change (the hunks of that
-- change, as core/hunks.ts `moveLine`); nil when the later change replaced it.
function M.move_line(line, later)
	local shift = 0
	for _, h in ipairs(later or {}) do
		if line < h.oldStart then break end
		if line < h.oldStart + h.oldLines then return nil end
		shift = shift + h.newLines - h.oldLines
	end
	return line + shift
end

-- The lines pi changed in `path`, as the file is after pi's last change in it:
-- line -> the change that wrote it last. A pure delete leaves no line to mark.
function M.marked_lines(changes, path, seen)
	seen = seen or {}
	local mine = {}
	for _, c in ipairs(changes or {}) do
		if c.path == path then table.insert(mine, c) end
	end
	local marks = {}
	for i, c in ipairs(mine) do
		for _, h in ipairs(c.hunks or {}) do
			for n = h.newStart, h.newStart + h.newLines - 1 do
				local line = n
				for j = i + 1, #mine do
					line = line and M.move_line(line, mine[j].hunks)
				end
				-- A change you saw leaves no mark, but still moves the lines of the others.
				if line and not seen[c.id] then marks[line] = c end
				if line and seen[c.id] then marks[line] = nil end
			end
		end
	end
	return marks
end

-- The same marks in the buffer as it is now, when you edited the file after
-- pi did. `after` and `buffer` are lists of lines. The lines both texts share
-- at the top and at the bottom keep their marks (the bottom ones shifted); the
-- lines in between are the ones you edited, and lose theirs.
function M.remap(marks, after, buffer)
	local a, b = #after, #buffer
	local top = 0
	while top < a and top < b and after[top + 1] == buffer[top + 1] do top = top + 1 end
	local bottom = 0
	while bottom < a - top and bottom < b - top and after[a - bottom] == buffer[b - bottom] do bottom = bottom + 1 end
	local out = {}
	for line, change in pairs(marks) do
		if line <= top then
			out[line] = change
		elseif line > a - bottom and line <= a then
			out[line + (b - a)] = change
		end
	end
	return out
end

-- The colour of a plan step: a named ttt style, the step's place in a short palette.
local PALETTE = { "success", "warning", "syntax_function", "syntax_keyword", "syntax_number", "syntax_type" }
function M.style_of(steps, change)
	local i = M.step_index(steps or {}, change)
	if not i then return "muted" end
	return PALETTE[(i - 1) % #PALETTE + 1]
end

-- Runs of marked lines written by the same change: {first, last, change}, by line.
function M.runs(marks)
	local lines = {}
	for line in pairs(marks) do table.insert(lines, line) end
	table.sort(lines)
	local out = {}
	for _, line in ipairs(lines) do
		local last = out[#out]
		if last and last.last == line - 1 and last.change == marks[line] then
			last.last = line
		else
			table.insert(out, { first = line, last = line, change = marks[line] })
		end
	end
	return out
end

return M
