-- The file tree follows pi: when the editor follows pi into a file, ttt's own
-- file tree opens to it (explorer.revealActiveFile), if the file is in a
-- folder open in ttt. A plugin cannot add a folder to ttt's tree, so the
-- "pi files" panel in the sidebar shows the files of every pi session, by
-- its folder, at any path. While that panel is on screen, the tree is not
-- moved to the explorer: the reveal would take the sidebar away from it.
--
-- Hooks it takes: "sessions" (rebuild), "follow" (path): the editor followed
-- pi into a file.
local ttt = require("ttt")
local editor = require("ttt.editor")
local fs = require("ttt.fs")
local util = require("core.util")
local review = require("core.review")

-- Adds `node` under `dir` (a node), in the folder named by `parts`.
local function place(dir, id, parts, node)
	for i = 1, #parts - 1 do
		local part = parts[i]
		dir.by = dir.by or {}
		local sub = dir.by[part]
		if not sub then
			sub = { id = id .. "/" .. table.concat(parts, "/", 1, i), label = part .. "/", expanded = true, children = {} }
			dir.by[part] = sub
			table.insert(dir.children, sub)
		end
		dir = sub
	end
	table.insert(dir.children, node)
end

-- Folders first, then files, by name; and drops the lookup tables.
local function tidy(node)
	node.by = nil
	if not node.children then return end
	table.sort(node.children, function(a, b)
		local ad, bd = a.children ~= nil, b.children ~= nil
		if ad ~= bd then return ad end
		return a.label < b.label
	end)
	for _, child in ipairs(node.children) do tidy(child) end
end

-- The tree: one node for each session ("▶" = the one the editor follows),
-- its files under its folder; a file outside the folder goes under its own
-- folder, by full path. "✎" marks the file pi changes now (`now`); "● n" a file
-- with n filled bodies the developer has not acked.
local function build(sessions, owner, now)
	local items, paths = {}, {}
	for _, rec in ipairs(sessions) do
		local followed = owner and owner.id == rec.id
		local node = {
			id = rec.id,
			label = (followed and "▶ " or "") .. rec.name,
			badge = util.short(rec.cwd or ""),
			expanded = true,
			children = {},
		}
		local seen = {}
		-- A file with bodies pi filled that are not acked (features/review.lua) shows how many.
		local waiting = review.count(review.collect({ rec }))
		for _, path in ipairs(type(rec.files) == "table" and rec.files or {}) do
			if type(path) == "string" and not seen[path] then
				seen[path] = true
				local id = rec.id .. "|" .. path
				paths[id] = path
				local file = { id = id, label = util.name(path), icon = (followed and path == now) and "✎" or " " }
				if waiting[path] then file.badge = "● " .. waiting[path] end
				if rec.cwd and util.starts_with(path, rec.cwd .. "/") then
					place(node, rec.id, util.split_path(path:sub(#rec.cwd + 2)), file)
				else
					place(node, rec.id, { util.short(util.parent(path)), util.name(path) }, file)
				end
			end
		end
		if #node.children == 0 then
			node.children = { { id = rec.id .. "|none", label = "no files changed yet", muted = true } }
		end
		tidy(node)
		table.insert(items, node)
	end
	return items, paths
end

return {
	name = "tree",
	needs = { "sessions" },
	build = build, -- for the unit tests
	setup = function(app)
		local sessions = app:need("sessions")
		local seen = -100  -- the tick when ttt last drew the "pi files" panel
		local items = {}   -- the "pi files" tree, built when the sessions or the follow change
		local paths = {}   -- node id -> file path
		local revealed = nil -- the file last shown in ttt's file tree

		local function rebuild()
			-- The file pi changes now.
			local follower = app:get("follow")
			local now = follower and follower.now_path() or nil
			items, paths = build(sessions.list(), sessions.owner(), now)
		end

		-- After the editor followed pi into `path`.
		local function follow(path)
			rebuild()
			-- ttt draws the panel on each tick while it is on screen.
			if app.ticks - seen <= 12 then return end
			if path == revealed then return end
			revealed = path
			-- ttt.fs sees only the folders open in ttt (and the plugin's folder): so
			-- this says if the file is in ttt's tree. Outside it, the reveal would
			-- only show "File is not in the explorer".
			if editor.file_path() == path and fs.exists(path) then
				ttt.exec_command("explorer.revealActiveFile")
			end
		end

		app:on("sessions", rebuild)
		app:on("follow", follow)
		app:sidebar({
			title = "pi files",
			render = function(panel)
				seen = app.ticks
				if #items == 0 then
					panel:label({ text = "No pi session is running.", style = "muted" })
					return
				end
				panel:tree({
					items = items,
					on_select = function(node)
						local path = paths[node.id]
						if path then ttt.open_file(path) end
					end,
				})
			end,
		})
		app:note("Sidebar: the \"pi files\" tab lists pi's files", 10)
		return { follow = follow }
	end,
}
