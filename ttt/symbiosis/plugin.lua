-- symbiosis, the ttt side. pi (the extension in pi/) appends events to
-- events.jsonl in this folder; this plugin reads them every 40 ms and
--   * replays each write and edit in the buffer at the speed you set, as a
--     preview: one undo group for each run of changes to one file;
--   * writes ack.json when it has shown a change. pi does not wait for the
--     editor: it waits only when more changes than your limit (`lag`) are
--     not shown yet. So the file on disk is where pi is now, and the buffer
--     is the replay, behind it;
--   * at the end of a run: undoes the preview and opens the file again from
--     disk: the file on disk is always the truth;
--   * follows the result: opens the file at the changed line.
-- Rules: a buffer with unsaved changes is never touched; while a run is
-- replayed in a file, your typing there waits; pinned (ctrl+k a) means no
-- preview and no jumps, but the end of the turn (a stop) moves the editor
-- anyway. See docs/design.md.
--
-- Sessions: each pi writes sessions/<id>.json. The editor follows one of them,
-- the owner: the session whose folder holds the open file (the most recent
-- one if several do), or the one you chose with ctrl+k n. Only the owner
-- writes events and answers helpi!. ctrl+k g goes to its herdr or tmux pane,
-- ctrl+k q stops its turn (stop.json), and the bar says when it waits on a
-- dialog in its own pane.
--
-- helpi!: a comment that ends in `helpi!` asks the owner, at once: the answer
-- (a note, code, or "asked pi") is written at that place. See "helpi!" below.
local ttt = require("ttt")
local editor = require("ttt.editor")
local fs = require("ttt.fs")
local json = require("ttt.json")
local events = require("ttt.events")
local system = require("ttt.system")

local DIR = ttt.plugin_dir()
local HEAD, EVENTS, ACK, ALIVE = DIR .. "/head.json", DIR .. "/events.jsonl", DIR .. "/ack.json", DIR .. "/ttt.json"
local HELP, SESSIONS, CHANGES = DIR .. "/help.json", DIR .. "/sessions", DIR .. "/changes"
local SETTINGS = DIR .. "/settings.json"
-- Typing speeds of the preview, in characters per second; 0 = as fast as pi sends.
local SPEEDS = { 10, 20, 40, 80, 160, 320, 640, 1280, 0 }
local SPEED = 5        -- the speed before you choose one: 160 characters per second
-- Autosave: milliseconds after your last key press; 0 = off.
local AUTOSAVES = { 0, 1000, 3000 }
-- How many changes pi may make that the editor has not shown yet; -1 = no limit.
-- 0 = pi waits for each change, as it did before.
local LAGS = { 0, 3, 10, -1 }
local POLL_MS = 40
local PROTOCOL = 10    -- the channel protocol of pi/index.ts
local PLAN_WIDTH = 56  -- the timeline in the status bar, in characters

local gen, offset = nil, 0
local pinned = false
local calls = {}       -- call id -> call
local run = nil        -- {path, line, calls, changed}: the file being replayed, one undo group
local active = nil     -- the call the replay types now (in `run`)
local disk = {}        -- path -> the sum of the file after pi's last change, as read
local acks = {}        -- the last call ids acknowledged
local here = nil       -- {path, line, mark}: what the status bar shows
local editing = false  -- true while this plugin changes the buffer
local sessions = {}    -- the live pi sessions, by name
local owner = nil      -- the session the editor follows
local chosen = nil     -- the id you chose with ctrl+k n; nil = by the open file
local outside = false  -- the owner is only the most recent session, not this file's
local plan_seen = nil  -- the plan as last shown, to redraw only on a change
local drawer = nil     -- the plan drawer's panel, once opened: redrawn on a change
local speed = SPEED    -- index in SPEEDS; ctrl+k - and ctrl+k = change it, settings.json keeps it
local paused = false   -- ctrl+k space: the replay stops; pi goes on up to the lag limit
local lag = 2          -- index in LAGS: 3 changes
local behind = 0       -- the changes pi made that the replay has not shown yet
local autosave = 2     -- index in AUTOSAVES: 1 s
local save_timer = nil
local queue = {}       -- the events read from the log, not yet applied
local qhead = 1
local budget = 0       -- the characters the preview may type now
local rush = nil       -- ctrl+k .: the call whose preview shows at once
local ticks = 0        -- poll ticks, every POLL_MS
local tree_seen = -100 -- the tick when ttt last drew the "pi files" panel
local tree_items = {}  -- the "pi files" tree, built when the sessions or the follow change
local tree_paths = {}  -- node id -> file path
local revealed = nil   -- the file last shown in ttt's file tree
local toggle_pin, finish, heartbeat, go_session, open_plan, follow_tree, build_tree, help_soon
local help = nil -- the helpi! question under way; see "helpi!" below

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

local waiting_said = nil -- the dialog the notice told about

local function show_session()
	local text
	if not owner then
		text = "π none"
	else
		local waiting = type(owner.waiting) == "string" and owner.waiting or nil
		-- pi shows a dialog in its own pane: a notice says so for 5 s, then the
		-- bar keeps it.
		if waiting and waiting_said ~= owner.id .. waiting then
			local said = owner.id .. waiting
			waiting_said = said
			ttt.notify("symbiosis: pi " .. owner.name .. " waits for you: " .. waiting .. " (ctrl+k g goes there)", "info")
			-- Measured: here the notice stays (a bare plugin's goes in about 4 s).
			ttt.set_timeout(5000, function()
				if waiting_said == said then ttt.notify("") end
			end)
		elseif not waiting and waiting_said then
			-- The notice goes with the dialog.
			waiting_said = nil
			ttt.notify("")
		end
		text = "π " .. owner.name .. (waiting and " ? waits for you" or owner.working and " ● working" or " ○ idle")
		if owner.version ~= PROTOCOL then text = "π " .. owner.name .. " · old, /reload" end
		if chosen then text = text .. " (chosen)"
		elseif outside then text = text .. " (outside its folder)" end
	end
	ttt.set_status_item("left", "symbiosis.session", text, { priority = 900, on_click = function() go_session() end })
end

-- The timeline -------------------------------------------------------------
-- pi's plan (the `plan` tool, pi/plan.ts) comes in the owner's session record.

local function plan_of(rec)
	return rec and type(rec.plan) == "table" and rec.plan or {}
end

-- The first `n` characters of `s`, with "…" when cut.
local function cut(s, n)
	if runes(s) <= n then return s end
	local out, count = {}, 0
	for ch in s:gmatch("[^\128-\191][\128-\191]*") do
		if count == n - 1 then break end
		table.insert(out, ch)
		count = count + 1
	end
	return table.concat(out) .. "…"
end

-- One line: "✓ 3 › ▶ now › next › next +2". Done steps are a count; "next"
-- steps drop off at the right when the line is full.
local function plan_line(steps)
	if #steps == 0 then return nil end
	local done, now, nexts = 0, nil, {}
	for _, s in ipairs(steps) do
		if s.state == "done" then done = done + 1
		elseif s.state == "now" and not now then now = s.text
		else table.insert(nexts, s.text) end
	end
	if not now and #nexts == 0 then return "✓ " .. done .. " done" end
	local line = done > 0 and ("✓ " .. done) or ""
	local function add(part)
		line = line == "" and part or (line .. " › " .. part)
	end
	if now then add("▶ " .. cut(now, 28)) end
	local shown = 0
	for i, text in ipairs(nexts) do
		local part = cut(text, 20)
		local rest = #nexts - i
		local room = PLAN_WIDTH - runes(line) - 3 - (rest > 0 and 3 or 0)
		if shown > 0 and runes(part) > room then break end
		add(part)
		shown = shown + 1
	end
	if shown < #nexts then line = line .. " +" .. (#nexts - shown) end
	return line
end

local function render_plan(panel)
	drawer = panel
	local steps = plan_of(owner)
	panel:title({ text = "pi plan", badge = owner and owner.name or "no session" })
	if #steps == 0 then
		panel:label({ text = "No plan yet. pi sends one for a task with several steps.", style = "muted" })
	end
	for _, s in ipairs(steps) do
		if s.state == "done" then
			panel:label({ text = "✓ " .. s.text, style = "muted" })
		elseif s.state == "now" then
			panel:label({ text = "▶ " .. s.text, style = "bold" })
		else
			panel:label({ text = "· " .. s.text })
		end
	end
	panel:label({ text = "Esc closes", style = "muted", margin_top = 1 })
end

-- Shows the owner's plan; only when it changed, so the drawer does not flicker.
local function show_plan()
	local steps = plan_of(owner)
	local seen = (owner and owner.id or "") .. json.encode(steps)
	if seen == plan_seen then return end
	plan_seen = seen
	local line = plan_line(steps)
	if line then
		ttt.set_status_item("left", "symbiosis.plan", line, { priority = 950, on_click = function() open_plan() end })
	else
		ttt.remove_status_item("symbiosis.plan")
	end
	if drawer then drawer:redraw() end
end

-- ctrl+k v, or a click on the timeline: the whole plan in a drawer. The
-- drawer takes the keys while it is open, so Esc closes it (as every ttt
-- drawer); a plugin key cannot reach it, and the editor cannot keep the focus.
open_plan = function()
	ttt.open_drawer({ width = 48, min_width = 30, side = "right", render = render_plan })
end

local function speed_text()
	local cps = SPEEDS[speed]
	return cps == 0 and "max" or string.format("%d/s", cps)
end

local function lag_text()
	local n = LAGS[lag]
	if n < 0 then return "no limit" end
	if n == 0 then return "0 (pi waits for each change)" end
	return string.format("%d changes", n)
end

local function pace_text()
	local text = paused and "⏸ paused" or "▶ " .. speed_text()
	if behind > 0 then text = text .. string.format(" · %d behind", behind) end
	return text
end

local cycle_speed

local held = nil -- a timer: "your typing waits" stays in the bar for a while

local function show(text)
	local mode = pinned and "pinned" or "following"
	if held then mode = mode .. " · your typing waits" end
	ttt.set_status_item("left", "symbiosis.speed", pace_text(), { priority = 1001, on_click = function() cycle_speed() end })
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
	if not here then return end
	ttt.open_file(here.path, here.line)
	follow_tree(here.path)
end

toggle_pin = function()
	pinned = not pinned
	-- Pinning ends the replay; leaving the pin goes to where the agent is now.
	if pinned and run then finish() end
	if not pinned then go() end
	show()
end

-- Regions: a stretch of the buffer that this plugin owns --------------------

-- Makes the region read `text`: replaces only what changed after the common
-- prefix. The cursor goes to its end, or `below` lines under its end.
local function set_region(r, text, below)
	local p = prefix(r.text, text)
	local pl, pc = after(r.line, r.col, r.text:sub(1, p))
	local el, ec = after(r.line, r.col, r.text)
	editing = true
	editor.replace(pl, pc, el, ec, text:sub(p + 1))
	editing = false
	r.text = text
	local cl, cc = after(r.line, r.col, text)
	if below then cl, cc = cl + below.lines, below.col end
	editor.set_cursor(cl, cc)
	reveal(cl)
end

-- Applies a text event to the value it names: its first `from` bytes, then `text`.
local function grow(value, ev)
	return (value or ""):sub(1, ev.from) .. ev.text
end

-- Calls ---------------------------------------------------------------------
-- A run: the changes that the replay shows in one file, one after the other,
-- in one undo group. Each call types on top of the one before, so an edit
-- finds its old text in the buffer as pi did on disk. The run ends when the
-- replay goes to another file, at the end of the turn, or when it has shown
-- all that pi sent: then `finish` undoes the group and opens the file again,
-- which reloads it from disk.

local function ack(id)
	table.insert(acks, id)
	while #acks > 200 do table.remove(acks, 1) end
	fs.write(ACK, json.encode(acks))
end

local function on_buffer(path)
	if editor.file_path() ~= path then ttt.open_file(path) end
	return editor.file_path() == path
end

-- Ends the run: the preview is undone and the file comes from disk again.
-- A buffer with unsaved changes does not reload when the file changes on
-- disk, and after the undo it is clean but old: closing the tab and opening
-- the file again reloads it. ttt's notice about the change on disk goes too.
finish = function()
	local r = run
	if not r then return end
	run, active = nil, nil
	for id in pairs(r.calls) do
		local c = calls[id]
		if c then c.skip = c.skip or "ended" end
	end
	editor.end_undo_group()
	if not r.changed or not on_buffer(r.path) then return end
	editing = true
	ttt.exec_command("editor.undo")
	ttt.exec_command("tab.close")
	editing = false
	local line = here and here.path == r.path and here.line or r.line or 1
	ttt.open_file(r.path, line)
	ttt.notify("")
end

local function busy(path)
	return run ~= nil and run.path == path
end

-- The text of the whole buffer: line 1, column 1 to the end.
local function whole()
	local text = editor.buffer_text()
	return { line = 1, col = 1, text = text }
end

local function start(ev)
	local c = { id = ev.call, tool = ev.tool, path = ev.path, edits = {}, values = {} }
	calls[ev.call] = c
	if pinned then c.skip = "pinned" return end
	if run and run.path ~= ev.path then finish() end
	if run then
		-- The next change in the same file: it types on top of the one before.
		if not on_buffer(ev.path) then c.skip = "not opened" return end
	else
		ttt.open_file(ev.path)
		if editor.file_path() ~= ev.path then c.skip = "not opened" return end
		follow_tree(ev.path)
		local text = editor.buffer_text()
		-- Clean: the buffer is the file as pi found it, or as pi last wrote it
		-- (a clean buffer reloads when pi is ahead of the replay).
		local sum = adler32(text)
		local clean = (ev.sum == nil and text == "") or sum == ev.sum or sum == disk[ev.path]
		if not clean then
			c.skip = "unsaved"
			ttt.notify("symbiosis: " .. name(ev.path) .. " has unsaved changes; no preview", "warning")
			return
		end
		editor.begin_undo_group()
		run = { path = ev.path, calls = {}, changed = false }
		-- pi may already have changed the file again: show the change from
		-- the text pi started from.
		local before = ev.before or (ev.sum == nil and "" or nil)
		if before and before ~= text then
			editing = true
			set_region(whole(), before)
			editing = false
			run.changed = true
		end
	end
	run.calls[c.id] = true
	active = c
	show("✎ writing " .. name(ev.path))
	if ev.tool == "write" then
		-- A full write clears the buffer and types the new text in.
		c.region = whole()
		if c.region.text ~= "" then set_region(c.region, "") run.changed = true end
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
		run.line = line
	elseif e.region then
		editor.clear_selection()
		set_region(e.region, value)
		run.changed = true
	end
end

local function text(ev)
	local c = calls[ev.call]
	if not c or c.skip then return end
	if not run or active ~= c or not on_buffer(c.path) then c.skip = "lost" return end
	local value = grow(c.values[ev.key], ev)
	c.values[ev.key] = value
	if ev.key == "content" then
		set_region(c.region, value)
		run.changed = true
		run.line = 1
	else
		local i, part = ev.key:match("^edits%.(%d+)%.(%a+)$")
		if i then edit_text(c, tonumber(i), part, value) end
	end
	local lines = select(2, value:gsub("\n", ""))
	show(string.format("✎ writing %s +%d lines", name(c.path), lines))
end

-- The call's text is all shown: acknowledge it. The run goes on.
local function ready(ev)
	local c = calls[ev.call]
	if c then
		c.readied = true
		if active == c then active = nil end
		if editor.file_path() == c.path then editor.clear_selection() end
	end
	if rush == ev.call then rush = nil end
	ack(ev.call)
end

-- The call will not run: its preview must go, and it is mixed with the run's.
local function abort(ev)
	local c = calls[ev.call]
	calls[ev.call] = nil
	if rush == ev.call then rush = nil end
	if c and run and run.calls[c.id] then pcall(finish) end
end

local function done(ev)
	calls[ev.call] = nil
	here = { path = ev.path, line = ev.line, mark = "✎" }
	if not ev.ok then return show() end
	-- In a run, the buffer is the replay: the jump waits for its end.
	if busy(ev.path) then run.line = ev.line return show() end
	if run then return show() end
	-- A new file shown before it existed reloads only when opened again.
	if not pinned then
		ttt.open_file(ev.path, ev.line)
		follow_tree(ev.path)
	end
	show()
end

local function stop(ev)
	if run then pcall(finish) end
	here = { path = ev.path, line = ev.line, mark = "■" }
	ttt.open_file(ev.path, ev.line)
	follow_tree(ev.path)
	show()
end

-- True when the run has nothing left to type: every call in it was shown.
local function run_done()
	if not run then return false end
	for id in pairs(run.calls) do
		local c = calls[id]
		if c and not c.readied then return false end
	end
	return true
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
	-- The name shown: pi's session name (/name), else the folder. When two
	-- sessions would show the same name, the herdr pane (or pid) tells them apart.
	local count = {}
	for _, rec in ipairs(list) do
		rec.folder = rec.name
		if type(rec.title) == "string" and rec.title ~= "" then rec.name = rec.title end
		count[rec.name] = (count[rec.name] or 0) + 1
	end
	for _, rec in ipairs(list) do
		if count[rec.name] > 1 then rec.name = rec.name .. " · " .. (rec.pane or tostring(rec.pid)) end
	end
	table.sort(list, function(a, b)
		if a.name ~= b.name then return a.name < b.name end
		return a.id < b.id
	end)
	return list
end

local function wrote(rec, path)
	if type(rec.files) ~= "table" then return false end
	for _, p in ipairs(rec.files) do
		if p == path then return true end
	end
	return false
end

-- The session the editor follows, for the open file:
--   1. the one you chose (ctrl+k n);
--   2. else the one that wrote or edited the file, the most recent;
--   3. else the one whose folder holds the file, the deepest folder, then the
--      most recent;
--   4. else the most recent one: the editor stays with the agent. `outside`
--      is then set, for the status bar.
local function pick()
	outside = false
	for _, rec in ipairs(sessions) do
		if rec.id == chosen then return rec end
	end
	chosen = nil
	local path = editor.file_path() or ""
	local writer, best, latest = nil, nil, nil
	for _, rec in ipairs(sessions) do
		local active = rec.active or 0
		if not latest or active > (latest.active or 0) then latest = rec end
		if path ~= "" and wrote(rec, path) and (not writer or active > (writer.active or 0)) then writer = rec end
		if path ~= "" and starts_with(path, rec.cwd .. "/")
			and (not best or #rec.cwd > #best.cwd or (#rec.cwd == #best.cwd and active > (best.active or 0))) then
			best = rec
		end
	end
	if writer or best then return writer or best end
	outside = latest ~= nil and path ~= ""
	return latest
end

local function refresh_sessions()
	sessions = load_sessions()
	local before = owner and owner.id
	owner = pick()
	if (owner and owner.id) ~= before then heartbeat() end
	build_tree()
	show_session()
	show_plan()
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
	-- No notice: a notice covers the status bar for 4 s, and the bar shows it.
	refresh_sessions()
end

-- ctrl+k g, or a click on "π ...": go to the owner's pane in herdr or tmux.
go_session = function()
	if not owner then
		return ttt.notify("symbiosis: no pi session is running", "warning")
	end
	if not owner.pane then
		return ttt.notify("symbiosis: pi " .. owner.name .. " does not run in herdr or tmux", "warning")
	end
	local binary, args = "herdr", { "agent", "focus", owner.pane }
	if owner.host == "tmux" then
		binary, args = "tmux", { "select-window", "-t", owner.pane, ";", "select-pane", "-t", owner.pane }
	end
	system.exec_async(binary, args, function(result)
		if result.exit_code ~= 0 then
			ttt.notify("symbiosis: " .. binary .. " could not focus " .. owner.pane .. ": " .. (result.stderr or ""), "error")
		end
	end)
end

-- ctrl+k q: stop the owner's turn, as Esc in pi does. pi reads stop.json.
local stops = 0
local function stop_pi()
	if not owner then
		return ttt.notify("symbiosis: no pi session is running", "warning")
	end
	if not owner.working then
		return ttt.notify("symbiosis: pi " .. owner.name .. " is idle", "info")
	end
	stops = stops + 1
	fs.write(DIR .. "/stop.json", json.encode({ id = tostring(os.time()) .. "-" .. stops, to = owner.id }))
end

-- The diff key -------------------------------------------------------------
-- pi/changes.ts keeps, per file, the text before pi's last turn first changed
-- it and the text after. ctrl+k w shows that diff for the open file, or for
-- the last file pi changed.

-- Lines for open_diff; a final "\n" does not make an empty last line.
local function split(text)
	local out = {}
	if type(text) ~= "string" then return out end
	local i = 1
	while i <= #text do
		local j = text:find("\n", i, true)
		if not j then
			table.insert(out, text:sub(i))
			break
		end
		table.insert(out, text:sub(i, j - 1))
		i = j + 1
	end
	return out
end

local function show_changes()
	local ok, index = pcall(json.decode, fs.read(CHANGES .. "/index.json") or "")
	if not ok or type(index) ~= "table" or type(index.files) ~= "table" or #index.files == 0 then
		return ttt.notify("symbiosis: pi changed no file in its last turn", "info")
	end
	local open = editor.file_path()
	local pick = index.files[#index.files]
	for _, f in ipairs(index.files) do
		if f.path == open then pick = f end
	end
	local fine, change = pcall(json.decode, fs.read(CHANGES .. "/" .. pick.key .. ".json") or "")
	if not fine or type(change) ~= "table" then
		return ttt.notify("symbiosis: the changes to " .. name(pick.path) .. " are not readable", "warning")
	end
	if change.before == change.after then
		return ttt.notify("symbiosis: " .. name(pick.path) .. " is the same as before pi's last turn", "info")
	end
	ttt.open_diff("pi: " .. name(pick.path) .. " (last turn)", split(change.before), split(change.after), pick.path)
	if open and open ~= "" and pick.path ~= open then
		ttt.notify("symbiosis: pi did not change this file; this is " .. name(pick.path) .. ", its last change", "info")
	end
end

local loaded = false    -- the editor API is usable only after the plugin loaded

local handlers = {
	start = start,
	text = text,
	ready = ready,
	abort = abort,
	done = done,
	stop = stop,
}

-- The loop ------------------------------------------------------------------
-- poll() reads new events into the queue; pace() applies them. Text that the
-- preview shows is typed at the speed you set: it costs characters from a
-- budget that grows every tick. All other events cost nothing, but wait for
-- the text before them. So `ready` comes after the last character, and pi,
-- which waits for its ack, writes the file only when you have seen it all.

local function apply(ev)
	local fine, err = pcall(handlers[ev.op], ev)
	if not fine then ttt.log("error", "symbiosis " .. ev.op .. ": " .. tostring(err)) end
end

-- True when `ev` types text that the preview shows: a write's content or an
-- edit's new text. An edit's old text is only selected.
local function typed(ev)
	if ev.op ~= "text" or type(ev.text) ~= "string" then return false end
	local c = calls[ev.call]
	if not c or c.skip then return false end
	return ev.key == "content" or ev.key:match("%.new$") ~= nil
end

-- The bytes of the first `n` characters of `s`.
local function rune_bytes(s, n)
	local i, count = 1, 0
	while i <= #s and count < n do
		local b = s:byte(i)
		i = i + (b >= 240 and 4 or b >= 224 and 3 or b >= 192 and 2 or 1)
		count = count + 1
	end
	return math.min(i - 1, #s)
end

-- The changes pi made (it sent `ready`) that the replay has not shown yet.
local function count_behind()
	local n = 0
	for i = qhead, #queue do
		if queue[i].op == "ready" then n = n + 1 end
	end
	if n ~= behind then
		behind = n
		show()
	end
end

local function pace()
	-- A helpi! answer is being written: the replay waits for it.
	if paused or (help and help.group) then return count_behind() end
	local cps = SPEEDS[speed]
	-- At most 0.2 s of typing saved up: no burst after a quiet moment.
	if cps > 0 then budget = math.min(budget + cps * POLL_MS / 1000, math.max(cps / 5, 1)) end
	while qhead <= #queue do
		local ev = queue[qhead]
		local n = math.floor(budget)
		if cps == 0 or ev.call == rush or not typed(ev) then
			apply(ev)
			qhead = qhead + 1
		else
			local len = runes(ev.text)
			if len > n and n <= 0 then break end
			if len <= n then
				budget = budget - len
				apply(ev)
				qhead = qhead + 1
			else
				-- Type the first n characters; the rest waits for the next tick.
				local b = rune_bytes(ev.text, n)
				apply({ op = "text", call = ev.call, key = ev.key, from = ev.from, text = ev.text:sub(1, b) })
				ev.from = ev.from + b
				ev.text = ev.text:sub(b + 1)
				budget = budget - n
				break
			end
		end
	end
	if qhead > #queue then
		queue, qhead = {}, 1
		-- All that pi sent is shown: the run ends, the buffer comes from disk.
		if run_done() then
			local fine, err = pcall(finish)
			if not fine then ttt.log("error", "symbiosis finish: " .. tostring(err)) end
		end
	end
	count_behind()
end

local function save_settings()
	fs.write(SETTINGS, json.encode({ speed = SPEEDS[speed], autosave = AUTOSAVES[autosave], lag = LAGS[lag] }))
end

local function load_settings()
	local ok, saved = pcall(json.decode, fs.read(SETTINGS) or "")
	if not ok or type(saved) ~= "table" then return end
	for i, cps in ipairs(SPEEDS) do
		if cps == saved.speed then speed = i end
	end
	for i, ms in ipairs(AUTOSAVES) do
		if ms == saved.autosave then autosave = i end
	end
	for i, n in ipairs(LAGS) do
		if n == saved.lag then lag = i end
	end
end

-- ctrl+k - and ctrl+k =: slower and faster. The last step is "max": as fast
-- as pi sends. No notice: it would cover the status bar, which shows the speed.
local function set_speed(step)
	speed = math.max(1, math.min(#SPEEDS, speed + step))
	save_settings()
	show()
end

-- A click on the speed, or Enter in the panel: the next speed, round.
cycle_speed = function()
	speed = speed % #SPEEDS + 1
	save_settings()
	show()
end

local function autosave_text()
	local ms = AUTOSAVES[autosave]
	return ms == 0 and "off" or string.format("%g s after you type", ms / 1000)
end

-- How far pi may run ahead of the replay. pi reads it from ttt.json.
local function cycle_lag()
	lag = lag % #LAGS + 1
	save_settings()
	heartbeat()
end

local function cycle_autosave()
	autosave = autosave % #AUTOSAVES + 1
	save_settings()
end

-- Autosave: a while after your last key press, the file is saved, so the
-- buffer is clean when pi writes it (a dirty buffer gets no preview and no
-- reload). Never while pi has a change to this file under way: that would
-- save a preview, or the old text over pi's write.
-- `soon`: at once (a helpi! answer is complete: pi may go to another file next).
local function schedule_save(soon)
	local ms = AUTOSAVES[autosave]
	local path = editor.file_path() or ""
	if ms == 0 or path == "" then return end
	if save_timer then ttt.clear_timeout(save_timer) end
	save_timer = ttt.set_timeout(soon and 10 or ms, function()
		save_timer = nil
		if editor.file_path() ~= path or active or busy(path) or qhead <= #queue then return end
		if help and help.group then return end
		for _, c in pairs(calls) do
			if c.path == path then return end
		end
		ttt.exec_command("file.save")
	end)
end

-- ctrl+k space: the replay stops where it is; pi goes on up to the lag limit.
local function toggle_pause()
	paused = not paused
	show()
end

-- ctrl+k .: the rest of this call's preview shows at once, also what pi has
-- not sent yet. The next call is typed at your speed again.
local function rush_now()
	rush = active and active.id or (queue[qhead] and queue[qhead].call)
	paused = false
	pace()
	show()
end

-- helpi! ----------------------------------------------------------------------
-- A comment that ends in `helpi!` asks the session the editor follows, at
-- once: 600 ms after your last change, or on Enter at the end of its line.
-- help.json carries the question and the code around it, as in the buffer.
-- pi asks its model in a side call (pi/help.ts) and sends events back:
--   help        pi has the question; it is thinking
--   help_start  the kind: note, code or ask; for code, the imports it needs
--   help_text   the answer so far (all of it)
--   help_done   the answer is complete, stopped, or failed
-- note: comment lines under the question, the first one starts "pi:". code:
-- takes the place of the comment, and missing imports go in at the top. ask:
-- the question went to pi's agent. All in one undo group: one ctrl+z takes
-- it back. While the answer is written, your typing in that file waits, and
-- the replay too. Esc stops it; what is written stays. Until the answer
-- starts, a line under the question shows that pi thinks (a spinner); it is
-- in the same undo group, and the answer takes its place.

local OPENERS = { "<!--", "/*", "//", "--", "#", ";" }
local CLOSERS = { ["<!--"] = " -->", ["/*"] = " */" }
local HELP_MS = 600
local MAX_LINES = 150 -- a longer file sends its top and the lines around the question
local help_seq = 0
local help_timer = nil
local help_wait = nil  -- the timer that says pi did not take the question
local help_asked = {}  -- path:line:text -> true: the pause does not ask again (Enter does)
local help_quiet = 0   -- poll tick: changes before it are the plugin's own (the waiting line)
local FRAMES = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }

-- The comment on `line` when it ends in helpi!: where its opener is, and the indent.
local function helpi(line)
	local body = line:gsub("%s*%*/%s*$", ""):gsub("%s*%-%->%s*$", "")
	if not body:match("helpi!%s*$") then return nil end
	local best = nil
	for _, o in ipairs(OPENERS) do
		local b = body:find(o, 1, true)
		if b and b < #body - 5 then best = { byte = b, opener = o } break end
	end
	if not best then return nil end
	best.col = runes(line:sub(1, best.byte - 1)) + 1
	best.indent = line:match("^%s*")
	return best
end

-- The line without its last `helpi!` (and the space before it).
local function unmark(line)
	local at = line:match(".*()helpi!")
	if not at then return line end
	return line:sub(1, at - 1):gsub("%s+$", "") .. line:sub(at + 6)
end

-- The text the answer region holds for `body`.
local function render(h, body, final)
	local out = {}
	local parts = split(body)
	if h.kind == "code" then
		for i, l in ipairs(parts) do
			if i == 1 then table.insert(out, l)
			else table.insert(out, "\n" .. (l == "" and "" or h.indent .. l)) end
		end
		return table.concat(out)
	end
	-- A note: one comment line each. A closer (*/, -->) only on a complete line.
	local closer = CLOSERS[h.opener] or ""
	if #parts == 0 then parts = { "" } end
	for i, l in ipairs(parts) do
		local text = (i == 1 and "pi: " or "") .. l
		local close = (final or i < #parts) and closer or ""
		table.insert(out, "\n" .. h.indent .. h.opener .. (text == "" and "" or " " .. text) .. close)
	end
	return table.concat(out)
end

-- The waiting line: a comment under the question, with the question's indent.
local function loader_text(h)
	return h.indent .. h.opener .. " pi " .. FRAMES[h.frame] .. " thinking · Esc stops" .. (CLOSERS[h.opener] or "")
end

-- The line the waiting line is on now, if it is still there.
local function loader_at(h)
	if not h.loader or editor.file_path() ~= h.path then return nil end
	if editor.get_line(h.loader) == h.loader_shown then return h.loader end
	for i, l in ipairs(editor.buffer_lines()) do
		if l == h.loader_shown then return i end
	end
	return nil
end

-- Shows the waiting line and opens the answer's undo group (the line is in it).
local function show_loader()
	local h = help
	if not h or h.kind or h.group or editor.file_path() ~= h.path then return end
	if editor.get_line(h.line) ~= h.text then return end
	local cur = editor.cursor()
	editor.begin_undo_group()
	h.group = true
	h.frame = 1
	h.loader_shown = loader_text(h)
	editing = true
	if h.line < editor.line_count() then
		editor.insert(h.line + 1, 1, h.loader_shown .. "\n")
	else
		editor.insert(h.line, runes(h.text) + 1, "\n" .. h.loader_shown)
	end
	editing = false
	h.loader = h.line + 1
	editor.set_cursor(cur.line > h.line and cur.line + 1 or cur.line, cur.col)
end

-- The spinner turns: called on each poll tick.
local function spin_loader()
	local h = help
	if not h or not h.loader or h.kind or ticks % 3 ~= 0 then return end
	local at = loader_at(h)
	if not at then return end
	local cur = editor.cursor()
	h.frame = h.frame % #FRAMES + 1
	h.loader_shown = loader_text(h)
	editing = true
	editor.set_line(at, h.loader_shown)
	editing = false
	h.loader = at
	editor.set_cursor(cur.line, cur.col)
end

-- Takes the waiting line away; the cursor stays where it was in your text.
local function hide_loader(h)
	local at = loader_at(h)
	h.loader = nil
	if not at then return end
	local cur = editor.cursor()
	editing = true
	if at < editor.line_count() then
		editor.replace(at, 1, at + 1, 1, "")
	else
		local prev = editor.get_line(at - 1) or ""
		editor.replace(at - 1, runes(prev) + 1, at, runes(h.loader_shown) + 1, "")
	end
	editing = false
	if cur.line > at then editor.set_cursor(cur.line - 1, cur.col)
	elseif cur.line == at then editor.set_cursor(at - 1, runes(editor.get_line(at - 1) or "") + 1)
	else editor.set_cursor(cur.line, cur.col) end
end

local function help_end(message, level)
	local h = help
	if not h then return end
	help = nil
	if help_wait then ttt.clear_timeout(help_wait) help_wait = nil end
	if h.loader then hide_loader(h) end
	help_quiet = ticks + 8
	if h.group then
		editor.end_undo_group()
		-- Only the waiting line was in the group (Esc or an error before the
		-- answer): undo it, so your next ctrl+z is not a step that does nothing.
		if not h.region then
			local cur = editor.cursor()
			editing = true
			ttt.exec_command("editor.undo")
			editing = false
			editor.set_cursor(cur.line, cur.col)
		end
	end
	if message then ttt.notify("symbiosis: " .. message, level or "info") end
	show()
	if h.region then schedule_save(true) end
end

local function help_write(fields)
	fs.write(HELP, json.encode(fields))
end

-- `again`: Enter asks also a line that was asked before (after ctrl+z, say).
local function ask_help(again)
	if not loaded or help or editing or run then return end
	local path = editor.file_path()
	if not path or path == "" then return end
	local pos = editor.cursor()
	local text = editor.get_line(pos.line) or ""
	local c = helpi(text)
	if not c then return end
	local key = path .. ":" .. pos.line .. ":" .. text
	if help_asked[key] and not again then return end
	help_asked[key] = true
	refresh_sessions()
	if not owner then return ttt.notify("symbiosis: helpi! needs a pi session; none runs", "warning") end
	if owner.version ~= PROTOCOL then
		return ttt.notify("symbiosis: pi " .. owner.name .. " runs an old symbiosis: /reload it", "warning")
	end
	local all = editor.buffer_lines()
	local first, last, head = 1, #all, ""
	if #all > MAX_LINES then
		first, last = math.max(1, pos.line - 40), math.min(#all, pos.line + 20)
		if first > 21 then head = table.concat(all, "\n", 1, 20) else first = 1 end
	end
	help_seq = help_seq + 1
	help = {
		id = os.time() .. "-" .. help_seq, path = path, line = pos.line, text = text,
		byte = c.byte, col = c.col, opener = c.opener, indent = c.indent, to = owner.id, name = owner.name,
	}
	help_write({
		id = help.id, to = help.to, path = path, line = pos.line, question = text,
		language = editor.language() or "", head = head,
		window = { first = first, text = table.concat(all, "\n", first, last) }, cancel = false,
	})
	show("helpi! → " .. owner.name)
	-- After the key that asked (Enter goes in first).
	ttt.set_timeout(10, function()
		local fine, err = pcall(show_loader)
		if not fine then
			editing = false
			ttt.log("error", "symbiosis helpi! loader: " .. tostring(err))
		end
	end)
	help_wait = ttt.set_timeout(3000, function()
		help_wait = nil
		if help and not help.taken then
			help_asked[key] = nil
			help_end("pi " .. help.name .. " did not take the question: /reload it?", "error")
		end
	end)
end

help_soon = function()
	if not loaded or editing or help or ticks < help_quiet then return end
	if help_timer then ttt.clear_timeout(help_timer) end
	help_timer = ttt.set_timeout(HELP_MS, function()
		help_timer = nil
		local fine, err = pcall(ask_help)
		if not fine then ttt.log("error", "symbiosis helpi!: " .. tostring(err)) end
	end)
end

-- Esc: pi stops the side call; what is written stays.
local function help_stop()
	if not help then return end
	help_write({ id = help.id, to = help.to, cancel = true })
	help.stopped = true
	help_end(help.region and "helpi! stopped" or "helpi! stopped before pi answered")
end

-- After the last import line near the top (or after a package line), or at line 1.
local IMPORT_LINE = { "^import[%s{\"']", "^from%s", "^use%s", "^#include", "^require[%s(]", "^const%s.-=%s*require%(", "^using%s" }
local function import_at(all)
	local at, package = 0, 0
	for i = 1, math.min(#all, 200) do
		local l = all[i]
		for _, p in ipairs(IMPORT_LINE) do
			if l:match(p) then at = i break end
		end
		if l:match("^package%s") then package = i end
	end
	return at, package
end

-- Missing imports go in at the top. Returns how many lines went in.
local function add_imports(imports, before)
	local all = editor.buffer_lines()
	local have = {}
	for _, l in ipairs(all) do have[l:match("^%s*(.-)%s*$")] = true end
	local new = {}
	for _, imp in ipairs(imports or {}) do
		local t = imp:match("^%s*(.-)%s*$")
		if t ~= "" and not have[t] then table.insert(new, t) have[t] = true end
	end
	if #new == 0 then return 0 end
	local at, package = import_at(all)
	local text = table.concat(new, "\n") .. "\n"
	local line = at + 1
	if at == 0 then
		-- No imports yet: after a package line, or at the top; then a blank line.
		line = package > 0 and package + 1 or 1
		if package > 0 then text = "\n" .. text end
		if (all[line] or "") ~= "" then text = text .. "\n" end
	end
	if line > #all then
		editor.insert(#all, runes(all[#all] or "") + 1, "\n" .. text:sub(1, -2))
	else
		editor.insert(line, 1, text)
	end
	if line > before then return 0 end
	return select(2, text:gsub("\n", ""))
end

local function help_taken(ev)
	help.taken = true
	if help_wait then ttt.clear_timeout(help_wait) help_wait = nil end
	show("helpi! · " .. help.name .. " thinks · Esc stops")
end

local function help_start(ev)
	help.kind = ev.kind
	if run then finish() end
	if not on_buffer(help.path) then return help_end("helpi!: the file did not open", "warning") end
	-- The question may have moved: find its line again.
	local line = help.line
	if editor.get_line(line) ~= help.text then
		line = nil
		for i, l in ipairs(editor.buffer_lines()) do
			if l == help.text then line = i break end
		end
		if not line then return help_end("helpi!: the question changed; the answer is not written", "warning") end
	end
	-- The waiting line goes; the answer takes its place.
	if help.loader then hide_loader(help) end
	-- You pressed Enter after the question: the cursor stays on your new line.
	local cursor = editor.cursor()
	if cursor.line > line then help.below = { lines = cursor.line - line, col = cursor.col } end
	if not help.group then
		editor.begin_undo_group()
		help.group = true
	end
	editing = true
	if ev.kind == "code" then
		line = line + add_imports(ev.imports, line)
		help.region = { line = line, col = help.col, text = help.text:sub(help.byte) }
	else
		local stripped = unmark(help.text)
		editor.set_line(line, stripped)
		help.region = { line = line, col = runes(stripped) + 1, text = "" }
	end
	editing = false
	if ev.kind == "ask" then
		set_region(help.region, render(help, "asked " .. help.name .. "; its answer comes in pi", true), help.below)
		return help_end()
	end
	show("helpi! · " .. help.name .. " writes · Esc stops")
end

local function help_text(ev)
	if help.region then set_region(help.region, render(help, ev.text or "", false), help.below) end
end

local function help_done(ev)
	if ev.error then
		help_asked[help.path .. ":" .. help.line .. ":" .. help.text] = nil
		return help_end("helpi! failed: " .. tostring(ev.error), "error")
	end
	if help.region and not ev.stopped then set_region(help.region, render(help, ev.text or "", true), help.below) end
	help_end()
end

local help_handlers = { help = help_taken, help_start = help_start, help_text = help_text, help_done = help_done }

-- A help event, at once (not through the replay queue): only for the question under way.
local function apply_help(ev)
	if not help or help.stopped or ev.id ~= help.id then return end
	if ev.op ~= "help" and not help.taken then help_taken(ev) end
	local fine, err = pcall(help_handlers[ev.op], ev)
	if not fine then
		editing = false
		ttt.log("error", "symbiosis " .. ev.op .. ": " .. tostring(err))
		help_end("helpi! failed in the editor: " .. tostring(err), "error")
	end
end

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
		if ok and ev and help_handlers[ev.op] then
			apply_help(ev)
		elseif ok and ev and handlers[ev.op] then
			table.insert(queue, ev)
			-- pi changed the file now; the replay may be behind.
			if ev.op == "done" then
				disk[ev.path] = ev.sum
				-- ttt says the file changed on disk under the replay: not news here.
				if busy(ev.path) then
					for _, ms in ipairs({ 250, 700 }) do
						ttt.set_timeout(ms, function() if busy(ev.path) then ttt.notify("") end end)
					end
				end
			end
		end
	end
end

heartbeat = function()
	fs.write(ALIVE, json.encode({ t = os.time(), pinned = pinned, owner = owner and owner.id or nil, lag = LAGS[lag] }))
end

-- The file tree ---------------------------------------------------------------
-- The tree follows pi: when the editor follows pi into a file, ttt's own file
-- tree opens to it (explorer.revealActiveFile), if the file is in a folder
-- open in ttt. A plugin cannot add a folder to ttt's tree, so the "pi files"
-- panel in the sidebar shows the files of every pi session, by its folder, at
-- any path. While that panel is on screen, the tree is not moved to the
-- explorer: the reveal would take the sidebar away from it.

-- "~" for the home folder.
local function short(path)
	return (path:gsub("^/home/[^/]+", "~"))
end

local function parent(path)
	return path:match("^(.*)/[^/]*$") or path
end

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

local function split_path(rel)
	local parts = {}
	for part in rel:gmatch("[^/]+") do table.insert(parts, part) end
	return parts
end

-- The tree: one node for each session ("▶" = the one the editor follows),
-- its files under its folder; a file outside the folder goes under its own
-- folder, by full path. "✎" marks the file pi changes now.
build_tree = function()
	local items, paths = {}, {}
	local now = run and run.path or (here and here.path)
	for _, rec in ipairs(sessions) do
		local followed = owner and owner.id == rec.id
		local node = {
			id = rec.id,
			label = (followed and "▶ " or "") .. rec.name,
			badge = short(rec.cwd or ""),
			expanded = true,
			children = {},
		}
		local seen = {}
		for _, path in ipairs(type(rec.files) == "table" and rec.files or {}) do
			if type(path) == "string" and not seen[path] then
				seen[path] = true
				local id = rec.id .. "|" .. path
				paths[id] = path
				local file = { id = id, label = name(path), icon = (followed and path == now) and "✎" or " " }
				if rec.cwd and starts_with(path, rec.cwd .. "/") then
					place(node, rec.id, split_path(path:sub(#rec.cwd + 2)), file)
				else
					place(node, rec.id, { short(parent(path)), name(path) }, file)
				end
			end
		end
		if #node.children == 0 then
			node.children = { { id = rec.id .. "|none", label = "no files changed yet", muted = true } }
		end
		tidy(node)
		table.insert(items, node)
	end
	tree_items, tree_paths = items, paths
end

-- After the editor followed pi into `path`.
follow_tree = function(path)
	build_tree()
	-- ttt draws the panel on each tick while it is on screen.
	if ticks - tree_seen <= 12 then return end
	if path == revealed then return end
	revealed = path
	-- ttt.fs sees only the folders open in ttt (and the plugin's folder): so
	-- this says if the file is in ttt's tree. Outside it, the reveal would
	-- only show "File is not in the explorer".
	if editor.file_path() == path and fs.exists(path) then
		ttt.exec_command("explorer.revealActiveFile")
	end
end

local function render_tree(panel)
	tree_seen = ticks
	if #tree_items == 0 then
		panel:label({ text = "No pi session is running.", style = "muted" })
		return
	end
	panel:tree({
		items = tree_items,
		on_select = function(node)
			local path = tree_paths[node.id]
			if path then ttt.open_file(path) end
		end,
	})
end

-- The panel: ctrl+k h --------------------------------------------------------
-- Settings you change in place (Enter cycles a value), the pi sessions (Enter
-- follows one), and every key. ttt calls render on every frame: no file reads
-- here. Up/Down move in a list, Tab to the next list, Esc closes.

local KEYS = {
	{ key = "ctrl+k h", value = "this panel" },
	{ key = "ctrl+k q", value = "stop pi's turn" },
	{ key = "ctrl+k a", value = "pin / unpin the editor" },
	{ key = "ctrl+k - / =", value = "preview slower / faster" },
	{ key = "ctrl+k space", value = "pause the replay" },
	{ key = "ctrl+k .", value = "rest of this change at once" },
	{ key = "ctrl+k v", value = "pi's plan" },
	{ key = "ctrl+k w", value = "what pi changed (diff)" },
	{ key = "// … helpi!", value = "ask pi here: wait, or Enter" },
	{ key = "Esc", value = "stop a helpi! answer" },
	{ key = "ctrl+k n", value = "next pi session" },
	{ key = "ctrl+k g", value = "go to pi's pane (herdr, tmux)" },
}

local function render_help(panel)
	panel:title("symbiosis")
	panel:label({ text = "Settings · Enter changes", style = "bold" })
	panel:list({
		items = {
			{ id = "speed", label = "Replay speed    " .. speed_text() },
			{ id = "lag", label = "pi ahead (max)  " .. lag_text() },
			{ id = "autosave", label = "Autosave        " .. autosave_text() },
			{ id = "pin", label = "Editor          " .. (pinned and "pinned" or "follows pi") },
		},
		key_commands = { ["-"] = "slower", ["="] = "faster" },
		on_command = function(command, node)
			if node.id == "speed" then
				if command == "slower" then set_speed(-1)
				elseif command == "faster" then set_speed(1)
				else cycle_speed() end
			elseif command == "activate" and node.id == "lag" then cycle_lag()
			elseif command == "activate" and node.id == "autosave" then cycle_autosave()
			elseif command == "activate" and node.id == "pin" then toggle_pin() end
		end,
	})
	panel:label({ text = "pi sessions · Enter: follow it", style = "bold", margin_top = 1 })
	-- ✓ = how the editor picks; ▶ = the session it follows now.
	local items = { { id = "", label = (chosen and "  " or "✓ ") .. "automatic: by the open file" } }
	for _, rec in ipairs(sessions) do
		local now = ""
		for _, st in ipairs(plan_of(rec)) do
			if st.state == "now" then now = " — " .. st.text break end
		end
		local mark = owner and owner.id == rec.id and "▶ " or "  "
		table.insert(items, {
			id = rec.id,
			label = mark .. rec.name .. (type(rec.waiting) == "string" and " ?" or rec.working and " ●" or " ○")
				.. (type(rec.model) == "string" and (" · " .. rec.model) or "")
				.. (chosen == rec.id and " ✓ chosen" or "") .. now,
			muted = rec.version ~= PROTOCOL,
		})
	end
	panel:list({
		items = items,
		truncate_left = false,
		on_command = function(command, node)
			if command ~= "activate" then return end
			chosen = node.id ~= "" and node.id or nil
			refresh_sessions()
		end,
	})
	panel:label({ text = "Keys", style = "bold", margin_top = 1 })
	panel:keyvalue(KEYS)
	panel:label({ text = "Sidebar: the \"pi files\" tab lists pi's files", style = "muted", margin_top = 1 })
	panel:label({ text = "Esc closes · clicks: π goes to pi, ▶ speed cycles", style = "muted" })
end

local function open_help()
	ttt.open_drawer({ width = 52, min_width = 36, side = "right", render = render_help })
end

ttt.register({
	sidebar = { title = "pi files", render = render_tree },
	commands = {
		{ id = "symbiosis.togglePin", title = "symbiosis: Pin / Unpin the Editor", handler = toggle_pin },
		{ id = "symbiosis.goToAgent", title = "symbiosis: Go to the Agent's Last Edit", handler = go },
		{ id = "symbiosis.nextSession", title = "symbiosis: Next pi Session Takes Over", handler = next_session },
		{ id = "symbiosis.goToSession", title = "symbiosis: Go to the pi Session (herdr, tmux)", handler = go_session },
		{ id = "symbiosis.showPlan", title = "symbiosis: Show pi's Plan", handler = function() open_plan() end },
		{ id = "symbiosis.showChanges", title = "symbiosis: What pi Changed in Its Last Turn (diff)", handler = show_changes },
		{ id = "symbiosis.slower", title = "symbiosis: Preview Slower", handler = function() set_speed(-1) end },
		{ id = "symbiosis.faster", title = "symbiosis: Preview Faster", handler = function() set_speed(1) end },
		{ id = "symbiosis.pause", title = "symbiosis: Pause / Go On (pi waits)", handler = toggle_pause },
		{ id = "symbiosis.rush", title = "symbiosis: Show the Rest of the Preview Now", handler = rush_now },
		{ id = "symbiosis.help", title = "symbiosis: Settings, Sessions and Keys", handler = open_help },
		{ id = "symbiosis.stop", title = "symbiosis: Stop pi's Turn", handler = stop_pi },
	},
	keybindings = {
		{ key = "ctrl+k a", command = "symbiosis.togglePin" },
		{ key = "ctrl+k n", command = "symbiosis.nextSession" },
		{ key = "ctrl+k g", command = "symbiosis.goToSession" },
		{ key = "ctrl+k v", command = "symbiosis.showPlan" },
		{ key = "ctrl+k w", command = "symbiosis.showChanges" },
		{ key = "ctrl+k -", command = "symbiosis.slower" },
		{ key = "ctrl+k =", command = "symbiosis.faster" },
		{ key = "ctrl+k space", command = "symbiosis.pause" },
		{ key = "ctrl+k .", command = "symbiosis.rush" },
		{ key = "ctrl+k h", command = "symbiosis.help" },
		{ key = "ctrl+k q", command = "symbiosis.stop" },
	},
})

-- A key that changes the text: a character, or Enter, Tab, Backspace, Delete.
-- Not a move, and not a key with ctrl or alt.
local function edits_text(key)
	if key.mod and key.mod ~= "" and key.mod ~= "shift" then return false end
	if key.rune and key.rune ~= "" then return true end
	local k = tostring(key.key or ""):lower()
	return k == "enter" or k == "tab" or k == "backspace" or k == "delete"
end

-- ctrl+v, ctrl+x, ctrl+z, ctrl+y, ctrl+s: they change or save the buffer.
local CHANGES_KEYS = { v = true, x = true, z = true, y = true, s = true }

local function changes_buffer(key)
	if edits_text(key) then return true end
	local k = tostring(key.key or key.rune or ""):lower():match("(%a)$")
	return key.mod == "ctrl" and k ~= nil and CHANGES_KEYS[k] == true
end

-- While the replay runs in this file, your typing waits: the buffer is the
-- replay, and pi has already changed the file on disk. Moves still work.
events.on("key.press", function(key)
	if editing then return false end
	local k = tostring(key.key or ""):lower()
	if help and (k == "esc" or k == "escape") then
		help_stop()
		return true
	end
	-- Enter at the end of a helpi! line asks at once; the Enter still goes in.
	if k == "enter" and (not key.mod or key.mod == "") and not help then
		local line = editor.current_line() or ""
		if editor.cursor().col > runes(line) and helpi(line) then
			if help_timer then ttt.clear_timeout(help_timer) help_timer = nil end
			local fine, err = pcall(ask_help, true)
			if not fine then ttt.log("error", "symbiosis helpi!: " .. tostring(err)) end
		end
	end
	local writing = help and help.group and editor.file_path() == help.path
	if (writing or (run and editor.file_path() == run.path)) and changes_buffer(key) then
		if held then ttt.clear_timeout(held) end
		held = ttt.set_timeout(1500, function() held = nil show() end)
		show()
		return true
	end
	if edits_text(key) then schedule_save() end
	return false
end)

local function on_file()
	if loaded then refresh_sessions() end
end
events.on("file.open", on_file)
events.on("tab.change", on_file)
events.on("editor.change", function() help_soon() end)

-- fs.read and the status bar are not ready while the plugin loads.
ttt.set_timeout(100, function()
	loaded = true
	load_settings()
	refresh_sessions()
	show()
	heartbeat()
	ttt.set_interval(POLL_MS, function()
		ticks = ticks + 1
		poll()
		pace()
		local fine, err = pcall(spin_loader)
		if not fine then editing = false ttt.log("error", "symbiosis helpi! spinner: " .. tostring(err)) end
	end)
	ttt.set_interval(1000, function()
		refresh_sessions()
		heartbeat()
	end)
end)
