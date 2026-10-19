-- Review per stub, the editor side (pi/review.ts is the pi side). When pi
-- fills a body, the developer reads it before it counts as done:
--
--   * a drawer opens by itself with the signature, the intent, the body and
--     the reasons (`why`) pi gave; the Ack button (a) acks it. Esc hides the
--     drawer; ctrl+k x, a click on the mark, or the status item "● n to
--     review" shows it again. An edit of the body does not ack it.
--   * a gutter mark ● stays on the function's first line while it is not
--     acked (the function is found again by its first line's text, like a
--     note); the "pi files" tab shows "● n" at the file.
--
-- The list is pi's (the session record, field `review`): a restart of pi
-- forgets it. Nothing opens at startup: bodies the plugin sees on its first
-- look count as seen.
local ttt = require("ttt")
local editor = require("ttt.editor")
local events = require("ttt.events")
local util = require("core.util")
local wrap = require("core.wrap")
local review = require("core.review")

local MARK = "●"
local ANCHOR_MS = 300

local function setup(app)
	local has_marks, bookmarks = pcall(require, "ttt.bookmarks")
	local gutter = has_marks and require("core.gutter").new(bookmarks, MARK, "warning") or nil
	local sessions = app:need("sessions")
	local follow = app:need("follow")
	local acked = {}       -- id -> true: acked here; pi's record drops it within a second
	local seen = nil       -- id -> true: ids already looked at (nil until the first look)
	local list = {}        -- the un-acked bodies of every session
	local lines = {}       -- id -> the line of its function in the open file
	local current = nil    -- the body the drawer shows
	local waiting = nil    -- a body that landed and waits until pi has no call open
	local timer = nil

	-- The open file's buffer, to find each body's function again.
	local function locate()
		lines = {}
		local path = editor.file_path()
		if not path or path == "" then return end
		local buffer = nil
		for _, l in ipairs(list) do
			if l.path == path then
				buffer = buffer or editor.buffer_lines()
				lines[l.id] = review.line_of(l, buffer)
			end
		end
	end

	local function draw()
		if not gutter then return end
		local path = editor.file_path()
		local want = {}
		for id, line in pairs(lines) do
			if line <= editor.line_count() then want[line] = true end
		end
		gutter.draw(path, want)
	end

	local function draw_safe()
		local fine, err = pcall(draw)
		if not fine then
			gutter = nil
			app.log("error", "symbiosis review marks: " .. tostring(err))
		end
	end

	local function status()
		if #list == 0 then return ttt.remove_status_item("symbiosis.review") end
		ttt.set_status_item("left", "symbiosis.review", "● " .. #list .. " to review",
			{ priority = 930, on_click = function() app:emit("review.show") end })
	end

	-- The sessions changed: take the new list.
	local function refresh()
		list = review.pending(review.collect(sessions.list()), acked)
		for id in pairs(acked) do
			local still = false
			for _, l in ipairs(review.collect(sessions.list())) do
				if l.id == id then still = true end
			end
			if not still then acked[id] = nil end
		end
		local first = seen == nil
		seen = seen or {}
		local owner = sessions.owner()
		for _, l in ipairs(review.fresh(list, seen)) do
			seen[l.id] = true
			if not first and owner and l.session == owner.id then waiting = l end
		end
		if waiting and acked[waiting.id] then waiting = nil end
		locate()
		draw_safe()
		status()
	end

	local show

	local function ack(landed)
		acked[landed.id] = true
		app.channel:write_json("review.json", { id = "r" .. landed.id .. "-" .. os.time(), to = landed.session, ack = landed.id })
		ttt.notify("symbiosis: acked " .. (landed.name ~= "" and landed.name or "the body"), "info")
		current = nil
		refresh()
		-- The next body of that session, if any.
		for _, l in ipairs(list) do
			if l.session == landed.session then return show(l) end
		end
		app:close_drawer("review")
	end

	local function render(panel)
		local l = current
		if not l then return wrap.label(panel, { text = "Nothing to review.", style = "muted" }) end
		panel:title({ text = "pi filled " .. (l.name ~= "" and l.name or "a function"), badge = util.name(l.path) })
		panel:markdown({ text = "`" .. (l.signature or "") .. "`", padding_left = 1 })
		if l.intent and l.intent ~= "" then wrap.label(panel, { text = l.intent, style = "muted" }) end
		panel:markdown({ text = "```" .. (l.path:match("%.(%w+)$") or "") .. "\n" .. (l.body or "") .. "\n```", padding_left = 1 })
		for _, why in ipairs(type(l.whys) == "table" and l.whys or {}) do
			wrap.label(panel, { text = "Why: " .. why, style = "muted", margin_top = 1 })
		end
		panel:button({ label = "&Ack", on_click = function() ack(l) end })
		panel:button({ label = "Go to it", on_click = function()
			ttt.open_file(l.path, lines[l.id] or l.line)
		end })
		local more = #list - 1
		wrap.label(panel, {
			text = (more > 0 and (more .. " more to review · ") or "") .. "a: ack · Esc: later (ctrl+k x)",
			style = "muted", margin_top = 1,
		})
	end

	function show(landed)
		current = landed
		app:open_drawer("review", { width = 56, min_width = 34, side = "right", render = render })
	end

	-- ctrl+k x: the body nearest the cursor in this file, else the newest.
	local function show_here()
		if #list == 0 then return ttt.notify("symbiosis: no filled body waits for review", "info") end
		local owner = sessions.owner()
		local cursor = editor.cursor().line
		show(review.choose(list, editor.file_path(), cursor, lines, owner and owner.id))
	end

	app:on("review.show", show_here)
	app:on("sessions", refresh)
	app:on("file", function() locate() draw_safe() end)
	app:on("second", draw_safe)
	app:on("change", function()
		if timer then ttt.clear_timeout(timer) end
		timer = ttt.set_timeout(ANCHOR_MS, function()
			timer = nil
			local fine, err = pcall(function() locate() draw_safe() end)
			if not fine then app.log("error", "symbiosis review: " .. tostring(err)) end
		end)
	end)
	-- A body landed: the drawer opens once pi has finished its call.
	app:on("tick", function()
		if not waiting or follow.running() then return end
		local l = waiting
		waiting = nil
		show(l)
	end)

	-- A click on a mark shows its body.
	local fine = pcall(events.on, "gutter.click", function(a, b)
		local path, line = a, b
		if type(a) == "table" then path, line = a.path or a.file, a.line end
		if type(path) ~= "string" or type(line) ~= "number" or path ~= editor.file_path() then return false end
		for _, l in ipairs(list) do
			if lines[l.id] == line then
				show(l)
				return false
			end
		end
		return false
	end)
	if not fine then app.log("warn", "symbiosis: this ttt has no gutter.click; ctrl+k x shows the body") end

	app:command({ id = "symbiosis.review", title = "symbiosis: Review the Body pi Filled", key = "ctrl+k x", run = show_here })
	app:hint({ key = "ctrl+k x", text = "review what pi filled", order = 94 })

	return { pending = function() return list end, show = show_here }
end

return {
	name = "review",
	needs = { "sessions", "follow" },
	setup = setup,
}
