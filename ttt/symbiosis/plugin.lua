-- symbiosis, the ttt side. pi (the extension in pi/) appends events to
-- events.jsonl in this folder; this plugin reads them every 40 ms and
--   * types each write and edit into the buffer while the model writes it,
--     as a preview in one undo group;
--   * undoes the preview when the tool is about to run (`ready`) and writes
--     ack.json, so the file on disk changes under a clean buffer and ttt
--     reloads it: the file on disk is always the truth;
--   * follows the result: opens the file at the changed line.
-- Rules: a buffer with unsaved changes is never touched; pinned (ctrl+k a)
-- means no preview and no jumps, but the end of the turn (a stop) moves the
-- editor anyway; a key press in the editor ends the preview. See docs/design.md.
local ttt = require("ttt")
local editor = require("ttt.editor")
local fs = require("ttt.fs")
local json = require("ttt.json")
local events = require("ttt.events")

local DIR = ttt.plugin_dir()
local HEAD, EVENTS, ACK, ALIVE = DIR .. "/head.json", DIR .. "/events.jsonl", DIR .. "/ack.json", DIR .. "/ttt.json"
local POLL_MS = 40

local gen, offset = nil, 0
local pinned = false
local calls = {}       -- call id -> call
local active = nil     -- the call whose undo group is open
local acks = {}        -- the last call ids acknowledged
local here = nil       -- {path, line, mark}: what the status bar shows
local editing = false  -- true while this plugin changes the buffer
local toggle_pin, end_preview

-- Positions -----------------------------------------------------------------

-- Characters (not bytes) in a UTF-8 string: editor columns count characters.
local function runes(s)
	local _, continuation = s:gsub("[\128-\191]", "")
	return #s - continuation
end

-- The position just after `text`, written from (line, col).
local function after(line, col, text)
	local newlines = select(2, text:gsub("\n", ""))
	if newlines == 0 then return line, col + runes(text) end
	local tail = text:match("[^\n]*$")
	return line + newlines, 1 + runes(tail)
end

-- The position of byte `b` (1-based) in `text`.
local function position(text, b)
	return after(1, 1, text:sub(1, b - 1))
end

-- The common prefix of two strings, in bytes, not ending inside a character.
local function prefix(a, b)
	local n = math.min(#a, #b)
	local i = 0
	while i < n and a:byte(i + 1) == b:byte(i + 1) do i = i + 1 end
	while i > 0 and i < #b and b:byte(i + 1) >= 128 and b:byte(i + 1) < 192 do i = i - 1 end
	return i
end

local function adler32(s)
	local a, b = 1, 0
	for i = 1, #s do
		a = (a + s:byte(i)) % 65521
		b = (b + a) % 65521
	end
	return b * 65536 + a
end

-- The view ------------------------------------------------------------------

local function name(path) return path:match("[^/]+$") or path end

local function show(text)
	local mode = pinned and "pinned" or "following"
	if text then
		ttt.set_status_item("left", "symbiosis", "pi " .. text .. " · " .. mode, { on_click = function() toggle_pin() end })
	elseif here then
		ttt.set_status_item("left", "symbiosis", string.format("pi %s %s:%d · %s", here.mark, name(here.path), here.line, mode), { on_click = function() toggle_pin() end })
	else
		ttt.set_status_item("left", "symbiosis", "pi · " .. mode, { on_click = function() toggle_pin() end })
	end
end

local function reveal(line)
	local v = editor.viewport()
	if line < v.top_line or line > v.bottom_line - 1 then
		editor.scroll_to(math.max(1, line - math.floor(v.height / 2)))
	end
end

local function go()
	if here then ttt.open_file(here.path, here.line) end
end

toggle_pin = function()
	pinned = not pinned
	-- Pinning ends a preview; leaving the pin goes to where the agent is now.
	if pinned and active then end_preview(active) end
	if not pinned then go() end
	show()
end

-- Regions: a stretch of the buffer that this plugin owns --------------------

-- Makes the region read `text`: replaces only what changed after the common prefix.
local function set_region(r, text)
	local p = prefix(r.text, text)
	local pl, pc = after(r.line, r.col, r.text:sub(1, p))
	local el, ec = after(r.line, r.col, r.text)
	editing = true
	editor.replace(pl, pc, el, ec, text:sub(p + 1))
	editing = false
	r.text = text
	local cl, cc = after(r.line, r.col, text)
	editor.set_cursor(cl, cc)
	reveal(cl)
end

-- Applies a text event to the value it names: its first `from` bytes, then `text`.
local function grow(value, ev)
	return (value or ""):sub(1, ev.from) .. ev.text
end

-- Calls ---------------------------------------------------------------------

local function ack(id)
	table.insert(acks, id)
	while #acks > 20 do table.remove(acks, 1) end
	fs.write(ACK, json.encode(acks))
end

local function on_buffer(c)
	if editor.file_path() ~= c.path then ttt.open_file(c.path) end
	return editor.file_path() == c.path
end

local function close_group(c)
	if active == c then
		editor.end_undo_group()
		active = nil
	end
end

-- Undoes the preview of `c`, once. The buffer is clean again.
end_preview = function(c)
	close_group(c)
	if c.changed and not c.undone and on_buffer(c) then
		editing = true
		ttt.exec_command("editor.undo")
		editing = false
	end
	c.undone = true
	c.skip = c.skip or "ended"
end

local function busy(path)
	for _, c in pairs(calls) do
		if c.path == path and c.changed and not c.undone then return true end
	end
	return false
end

local function start(ev)
	local c = { id = ev.call, tool = ev.tool, path = ev.path, edits = {}, values = {} }
	calls[ev.call] = c
	if pinned then c.skip = "pinned" return end
	if busy(ev.path) then c.skip = "busy" return end
	if active then close_group(active) end
	ttt.open_file(ev.path)
	if editor.file_path() ~= ev.path then c.skip = "not opened" return end
	local text = editor.buffer_text()
	local clean = ev.sum == nil and text == "" or adler32(text) == ev.sum
	if not clean then
		c.skip = "unsaved"
		ttt.notify("symbiosis: " .. name(ev.path) .. " has unsaved changes; no preview", "warning")
		return
	end
	editor.begin_undo_group()
	active = c
	show("✎ writing " .. name(ev.path))
	if ev.tool == "write" then
		-- A full write clears the buffer and types the new text in.
		c.region = { line = 1, col = 1, text = text }
		if text ~= "" then set_region(c.region, "") c.changed = true end
	end
end

local function edit_text(c, i, part, value)
	local e = c.edits[i] or {}
	c.edits[i] = e
	if e.skip then return end
	if part == "old" then
		local text = editor.buffer_text()
		local b = text:find(value, 1, true)
		if value == "" or not b or text:find(value, b + 1, true) then e.skip = true return end
		local line, col = position(text, b)
		e.region = { line = line, col = col, text = value }
		local el, ec = after(line, col, value)
		editor.set_selection(line, col, el, ec)
		reveal(line)
	elseif e.region then
		editor.clear_selection()
		set_region(e.region, value)
		c.changed = true
	end
end

local function text(ev)
	local c = calls[ev.call]
	if not c or c.skip then return end
	if active ~= c or not on_buffer(c) then c.skip = "lost" return end
	local value = grow(c.values[ev.key], ev)
	c.values[ev.key] = value
	if ev.key == "content" then
		set_region(c.region, value)
		c.changed = true
	else
		local i, part = ev.key:match("^edits%.(%d+)%.(%a+)$")
		if i then edit_text(c, tonumber(i), part, value) end
	end
	local lines = select(2, value:gsub("\n", ""))
	show(string.format("✎ writing %s +%d lines", name(c.path), lines))
end

local function ready(ev, final)
	local c = calls[ev.call]
	if c then
		end_preview(c)
		calls[ev.call] = nil
	end
	if final then ack(ev.call) end
end

local function done(ev)
	here = { path = ev.path, line = ev.line, mark = "✎" }
	if not ev.ok then return show() end
	-- A new file shown before it existed reloads only when opened again.
	if not pinned then ttt.open_file(ev.path, ev.line) end
	show()
end

local function stop(ev)
	here = { path = ev.path, line = ev.line, mark = "■" }
	ttt.open_file(ev.path, ev.line)
	show()
end

local handlers = {
	start = start,
	text = text,
	ready = function(ev) ready(ev, true) end,
	abort = function(ev) ready(ev, false) end,
	done = done,
	stop = stop,
}

-- The loop ------------------------------------------------------------------

local function poll()
	local raw = fs.read(HEAD)
	if not raw then return end
	local head = json.decode(raw)
	if not head or not head.gen then return end
	if head.gen ~= gen then
		-- The first log seen is history from before ttt started: skip it.
		offset = gen == nil and head.size or 0
		gen = head.gen
	end
	if head.size <= offset then return end
	local log = fs.read(EVENTS)
	if not log then return end
	local chunk = log:sub(offset + 1)
	for line in chunk:gmatch("[^\n]*\n") do
		offset = offset + #line
		local ok, ev = pcall(json.decode, line)
		if ok and ev and handlers[ev.op] then
			local fine, err = pcall(handlers[ev.op], ev)
			if not fine then ttt.log("error", "symbiosis " .. ev.op .. ": " .. tostring(err)) end
		end
	end
end

local function heartbeat()
	fs.write(ALIVE, json.encode({ t = os.time(), pinned = pinned }))
end

ttt.register({
	commands = {
		{ id = "symbiosis.togglePin", title = "symbiosis: Pin / Unpin the Editor", handler = toggle_pin },
		{ id = "symbiosis.goToAgent", title = "symbiosis: Go to the Agent's Last Edit", handler = go },
	},
	keybindings = {
		{ key = "ctrl+k a", command = "symbiosis.togglePin" },
	},
})

-- Your key press in the editor ends the preview: the buffer is yours again.
events.on("key.press", function(key)
	if active and not editing and not key.mod then end_preview(active) show() end
	return false
end)

-- fs.read and the status bar are not ready while the plugin loads.
ttt.set_timeout(100, function()
	show()
	heartbeat()
	ttt.set_interval(POLL_MS, poll)
	ttt.set_interval(1000, heartbeat)
end)
