-- The change list: pi's plan, each step with the files pi named for it and
-- the files it really changed in it (the change log, pi/changelog.ts). Pure:
-- plan.lua gives it the steps and the log, it gives back the list's nodes and
-- what each node does when it is activated.
--
--   steps    pi's plan: {text, state = done|now|next, files = {absolute paths}?}
--   changes  the log, oldest first: {id, seq, path, step, stepText, created, hunks, why}
--   opts     cwd (paths show relative to it), editing(path) -> pi has a call open there
--
-- Returns nodes, actions: `actions[node.id]` is {path, line} for a file row.
local util = require("core.util")

local M = {}

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

-- The row of one file. Named but untouched: muted, "planned". Changed: "●";
-- pi has a call open in it: "✎". When the step names files, a changed file it
-- did not name says "unplanned".
local function file_node(e, id, group_named, opts)
	local editing = opts.editing and opts.editing(e.path)
	local mark = editing and "✎" or (#e.changes > 0 and "●" or "·")
	local parts = {}
	if #e.changes == 0 then
		table.insert(parts, "planned")
	else
		if e.changes[1].created then table.insert(parts, "new") end
		if #e.changes > 1 or not e.changes[1].created then table.insert(parts, plural(#e.changes, "change")) end
		if group_named and not e.planned then table.insert(parts, "unplanned") end
	end
	local label = mark .. " " .. relative(e.path, opts.cwd)
	if #parts > 0 then label = label .. " · " .. table.concat(parts, " · ") end
	local line = #e.changes > 0 and M.first_line(e.changes[1]) or 1
	return { id = id, label = label, muted = #e.changes == 0 and not editing }, { path = e.path, line = line }
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

return M
