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
--
-- Sessions: each pi writes sessions/<id>.json. The editor follows one of them,
-- the owner: the session whose folder holds the open file (the most recent
-- one if several do), or the one you chose with ctrl+k n. Only the owner
-- writes events and gets the markers. ctrl+k g goes to its herdr pane.
--
-- Suggestions: ctrl+k d sends every AI!/AI? marker comment to the owner
-- (pi/suggest.ts). Open markers in this buffer show as diagnostics.
local ttt = require("ttt")
local editor = require("ttt.editor")
local fs = require("ttt.fs")
local json = require("ttt.json")
local events = require("ttt.events")
local diagnostics = require("ttt.diagnostics")
local system = require("ttt.system")

local DIR = ttt.plugin_dir()
local HEAD, EVENTS, ACK, ALIVE = DIR .. "/head.json", DIR .. "/events.jsonl", DIR .. "/ack.json", DIR .. "/ttt.json"
local REQUEST, SESSIONS = DIR .. "/request.json", DIR .. "/sessions"
local POLL_MS = 40
local PROTOCOL = 3     -- the channel protocol of pi/index.ts

local gen, offset = nil, 0
local pinned = false
local calls = {}       -- call id -> call
local active = nil     -- the call whose undo group is open
local acks = {}        -- the last call ids acknowledged
local here = nil       -- {path, line, mark}: what the status bar shows
local editing = false  -- true while this plugin changes the buffer
local sessions = {}    -- the live pi sessions, by name
local owner = nil      -- the session the editor follows
local chosen = nil     -- the id you chose with ctrl+k n; nil = by the open file
local toggle_pin, end_preview, heartbeat, go_session

-- Positions -----------------------------------------------------------------

-- Each line of `text` that ends in "\n", with its "\n". Not gmatch("[^\n]*\n"):
-- in ttt 1.7.1 that crashes (nil pointer) on text with an empty line.
local function lines(text)
	local i = 1
	return function()
		local j = text:find("\n", i, true)
		if not j then return nil end
		local line = text:sub(i, j)
		i = j + 1
		return line
	end
end

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

local function show_session()
	local text
	if not owner then
		text = #sessions == 0 and "π none" or "π none for this file"
	else
		text = "π " .. owner.name .. (owner.working and " ● working" or " ○ idle")
		if owner.version ~= PROTOCOL then text = "π " .. owner.name .. " · old, /reload" end
		if chosen then text = text .. " (chosen)" end
	end
	ttt.set_status_item("left", "symbiosis.session", text, { priority = 900, on_click = function() go_session() end })
end

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

-- Sessions ------------------------------------------------------------------

local function starts_with(s, p) return s:sub(1, #p) == p end

-- Reads sessions/: the records with a heartbeat in the last 3 seconds.
local function load_sessions()
	local list = {}
	local entries = fs.list(SESSIONS) or {}
	for _, e in ipairs(entries) do
		if not e.is_dir and e.name:match("%.json$") then
			local raw = fs.read(SESSIONS .. "/" .. e.name)
			local ok, rec = pcall(json.decode, raw or "")
			if ok and type(rec) == "table" and rec.id and type(rec.t) == "number" and os.time() - rec.t < 4 then
				table.insert(list, rec)
			end
		end
	end
	table.sort(list, function(a, b)
		if a.name ~= b.name then return a.name < b.name end
		return a.id < b.id
	end)
	return list
end

-- The session the editor follows: the one you chose, else the one whose folder
-- holds the open file (the deepest folder, then the most recent), else, with
-- no file open, the most recent one.
local function pick()
	for _, rec in ipairs(sessions) do
		if rec.id == chosen then return rec end
	end
	chosen = nil
	local path = editor.file_path() or ""
	local best = nil
	for _, rec in ipairs(sessions) do
		local fits = path == "" or starts_with(path, rec.cwd .. "/")
		if fits and (not best or #rec.cwd > #best.cwd or (#rec.cwd == #best.cwd and (rec.active or 0) > (best.active or 0))) then
			best = rec
		end
	end
	return best
end

local function refresh_sessions()
	sessions = load_sessions()
	local before = owner and owner.id
	owner = pick()
	if (owner and owner.id) ~= before then heartbeat() end
	show_session()
end

-- ctrl+k n: the next session takes over; after the last one, back to "by the open file".
local function next_session()
	sessions = load_sessions()
	if #sessions == 0 then
		ttt.notify("symbiosis: no pi session is running", "warning")
		return refresh_sessions()
	end
	local i = 0
	for k, rec in ipairs(sessions) do
		if rec.id == chosen then i = k end
	end
	local nxt = sessions[i + 1]
	chosen = nxt and nxt.id or nil
	refresh_sessions()
	if chosen then
		ttt.notify("symbiosis: pi " .. owner.name .. " takes over (chosen)", "info")
	else
		ttt.notify("symbiosis: back to the session of the open file" .. (owner and (": " .. owner.name) or ": none"), "info")
	end
end

-- ctrl+k g, or a click on "π ...": go to the owner's pane in herdr.
go_session = function()
	if not owner then
		return ttt.notify("symbiosis: no pi session for this file (ctrl+k n chooses one)", "warning")
	end
	if not owner.pane then
		return ttt.notify("symbiosis: pi " .. owner.name .. " does not run in herdr", "warning")
	end
	system.exec_async("herdr", { "agent", "focus", owner.pane }, function(result)
		if result.exit_code ~= 0 then
			ttt.notify("symbiosis: herdr could not focus " .. owner.pane .. ": " .. (result.stderr or ""), "error")
		end
	end)
end

-- Suggestions: AI!/AI? comments -------------------------------------------

local OPENERS = { "<!--", "/*", "//", "--", "#", ";" }

-- The kind ("!" or "?") when the line is a comment that ends in AI! or AI?.
local function marker(line)
	local body = line:gsub("%s*%*/%s*$", "")
	body = body:gsub("%s*%-%->%s*$", "")
	local kind = body:match("AI([!?])%s*$")
	if not kind then return nil end
	for _, o in ipairs(OPENERS) do
		if body:find(o, 1, true) then return kind end
	end
	return nil
end

local function refresh_markers()
	local path = editor.file_path()
	if not path or path == "" then return end
	local items, n = {}, 0
	for full in lines(editor.buffer_text() .. "\n") do
		local line = full:sub(1, -2)
		n = n + 1
		local kind = marker(line)
		if kind then
			table.insert(items, {
				line = n, col = 1, end_col = runes(line) + 1, severity = "info", source = "symbiosis",
				message = (kind == "!" and "change for pi" or "question for pi") .. " · send all: ctrl+k, then d",
			})
		end
	end
	diagnostics.publish(path, items)
end

local loaded = false    -- the editor API is usable only after the plugin loaded
local refresh_timer = nil
local function refresh_soon()
	if not loaded then return end
	if refresh_timer then ttt.clear_timeout(refresh_timer) end
	refresh_timer = ttt.set_timeout(300, function()
		refresh_timer = nil
		local ok, err = pcall(refresh_markers)
		if not ok then ttt.log("error", "symbiosis markers: " .. tostring(err)) end
	end)
end

local sends = 0
local waiting = nil   -- the timer that says pi did not answer
local function send_markers()
	refresh_sessions()
	if not owner then
		return ttt.notify("symbiosis: no pi session for this file. Start pi in its folder, or choose one with ctrl+k n", "warning")
	end
	if owner.version ~= PROTOCOL then
		return ttt.notify("symbiosis: pi " .. owner.name .. " runs an old symbiosis: /reload it", "warning")
	end
	local path = editor.file_path()
	-- pi reads the file from disk: save your changes first.
	if path and path ~= "" then ttt.exec_command("file.save") end
	sends = sends + 1
	fs.write(REQUEST, json.encode({ id = os.time() .. "-" .. sends, path = path or "", to = owner.id }))
	show("⇢ sending suggestions to " .. owner.name)
	if waiting then ttt.clear_timeout(waiting) end
	local name_ = owner.name
	waiting = ttt.set_timeout(3000, function()
		waiting = nil
		ttt.notify("symbiosis: pi " .. name_ .. " did not answer", "error")
		show()
	end)
end

local function sent(ev)
	if waiting then ttt.clear_timeout(waiting) waiting = nil end
	if ev.count == 0 then
		ttt.notify("symbiosis: no AI! or AI? markers found", "info")
	else
		local s = ev.count == 1 and "" or "s"
		ttt.notify(string.format("symbiosis: %d suggestion%s sent to pi%s", ev.count, s, ev.busy and ", after the current turn" or ""), "info")
	end
	show()
end

local handlers = {
	start = start,
	text = text,
	ready = function(ev) ready(ev, true) end,
	abort = function(ev) ready(ev, false) end,
	done = done,
	stop = stop,
	sent = sent,
}

-- The loop ------------------------------------------------------------------

local function poll()
	local raw = fs.read(HEAD)
	-- No log when ttt starts: whatever comes later is new, not history.
	if not raw then
		if gen == nil then gen = "" end
		return
	end
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
	for line in lines(chunk) do
		offset = offset + #line
		local ok, ev = pcall(json.decode, line)
		if ok and ev and handlers[ev.op] then
			local fine, err = pcall(handlers[ev.op], ev)
			if not fine then ttt.log("error", "symbiosis " .. ev.op .. ": " .. tostring(err)) end
		end
	end
end

heartbeat = function()
	fs.write(ALIVE, json.encode({ t = os.time(), pinned = pinned, owner = owner and owner.id or nil }))
end

ttt.register({
	commands = {
		{ id = "symbiosis.togglePin", title = "symbiosis: Pin / Unpin the Editor", handler = toggle_pin },
		{ id = "symbiosis.goToAgent", title = "symbiosis: Go to the Agent's Last Edit", handler = go },
		{ id = "symbiosis.sendMarkers", title = "symbiosis: Send AI!/AI? Markers to the Agent", handler = send_markers },
		{ id = "symbiosis.nextSession", title = "symbiosis: Next pi Session Takes Over", handler = next_session },
		{ id = "symbiosis.goToSession", title = "symbiosis: Go to the pi Session (herdr)", handler = go_session },
	},
	keybindings = {
		{ key = "ctrl+k a", command = "symbiosis.togglePin" },
		{ key = "ctrl+k d", command = "symbiosis.sendMarkers" },
		{ key = "ctrl+k n", command = "symbiosis.nextSession" },
		{ key = "ctrl+k g", command = "symbiosis.goToSession" },
	},
})

-- Your key press in the editor ends the preview: the buffer is yours again.
events.on("key.press", function(key)
	if active and not editing and not key.mod then end_preview(active) show() end
	return false
end)

local function on_file()
	refresh_soon()
	if loaded then refresh_sessions() end
end
events.on("file.open", on_file)
events.on("tab.change", on_file)
events.on("file.save", refresh_soon)
events.on("editor.change", refresh_soon)

-- fs.read and the status bar are not ready while the plugin loads.
ttt.set_timeout(100, function()
	loaded = true
	refresh_sessions()
	refresh_soon()
	show()
	heartbeat()
	ttt.set_interval(POLL_MS, poll)
	ttt.set_interval(1000, function()
		refresh_sessions()
		heartbeat()
	end)
end)
