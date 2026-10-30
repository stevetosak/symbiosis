-- The debugger, as in VS Code and Rider. The session itself runs outside ttt
-- (core/debug, launcher/debug.ts: a debug run is a run, `symbiosis run start
-- --debug`); this feature is the editor's side of it:
--
--   F9               a breakpoint on the cursor's line, or off again: ◉ in the
--                    gutter (a click on it takes it off), kept in breakpoints.json
--   shift+F9         debugs the chosen run configuration (F5's); ctrl+k F9, or d
--                    in the Run picker, picks one
--   while paused     F5 continues, F10 steps over, F11 into, shift+F11 out,
--                    shift+F5 stops; F6 pauses a program that runs
--   ▶                the line it is paused on (the chosen frame): the editor opens it
--   the Run panel    a paused debug run shows its call stack and its variables
--                    (and the watches): Tab goes between the runs, the stack and
--                    the variables; ↑↓ move, Enter or → opens, ← closes, Enter on
--                    a frame shows its variables and its line; c continue, n over,
--                    i into, u out, p pause, e watch an expression, x drops a watch,
--                    v the output and back
--
-- F5, F6, F10 and F11 are the debugger's only while a debug session is live:
-- else they stay ttt's (F10 its menu, F6 the next group) and F5 runs.
--
-- Files (core/debug/view.ts): breakpoints.json in the plugin folder,
-- { files = { [path] = { { line, hash } } } }, which a session reads when it
-- starts; each debug run's runs/<id>/debug.json (what it shows), read every
-- tick while it is live, and debug-in.json (the commands for it).
local ttt = require("ttt")
local editor = require("ttt.editor")
local events = require("ttt.events")
local fs = require("ttt.fs")
local json = require("ttt.json")
local util = require("core.util")
local notes = require("core.notes")
local buffer = require("core.buffer")

local BP = "◉"
local HERE = "▶"
local SEP = "\t"
local ANCHOR_MS = 300

local M = { name = "debug", needs = { "run" } }

-- Pure helpers (the Lua unit tests use them) ---------------------------------------

local LIVE = { starting = true, running = true }
local function live(run) return run ~= nil and LIVE[run.status] == true end

-- A breakpoint at `line` on, or off when there is one: the new list (by
-- line), and whether it is on now.
function M.toggle(list, line, hash)
	local out, found = {}, false
	for _, b in ipairs(list or {}) do
		if b.line == line then found = true else table.insert(out, b) end
	end
	if not found then table.insert(out, { line = line, hash = hash }) end
	table.sort(out, function(a, b) return a.line < b.line end)
	return out, not found
end

-- The command a key gives while a debug session is `status` (paused,
-- running, starting), or nil: then the key is not the debugger's.
function M.key_op(key, status)
	if type(key) ~= "table" or not status then return nil end
	local k, mod = key.key, key.mod
	local plain = mod == nil or mod == ""
	if status == "paused" then
		if k == "F5" and plain then return "continue" end
		if k == "F10" and plain then return "next" end
		if k == "F11" and plain then return "stepIn" end
		if k == "F11" and mod == "shift" then return "stepOut" end
	elseif status == "running" then
		if k == "F6" and plain then return "pause" end
	end
	return nil
end

-- The panel's letters for a paused (or running) session.
local LETTERS = { c = "continue", n = "next", i = "stepIn", u = "stepOut" }
function M.letter_op(rune, status)
	if status == "paused" and LETTERS[rune] then return LETTERS[rune] end
	if status == "running" and rune == "p" then return "pause" end
	return nil
end

local function is_open(key, view, overlay)
	local o = overlay and overlay[key]
	if o ~= nil then return o.open end
	for _, k in ipairs(view.expanded or {}) do if k == key then return true end end
	return false
end

-- The rows of the variables pane: the watches, then each scope, and under
-- each open one its children (fetched: view.vars), depth first. `overlay`:
-- key -> { open } that the session has not done yet (it shows at once).
-- Each row: { kind = "watch"|"scope"|"var"|"wait", key, depth, name, value, ref, open, error }.
function M.var_rows(view, overlay)
	local rows = {}
	if type(view) ~= "table" then return rows end
	local vars = view.vars or {}
	local function under(key, depth)
		if depth > 12 then return end
		local children = vars[key]
		if not children then
			table.insert(rows, { kind = "wait", key = key .. SEP .. "…", depth = depth, name = "…", value = "", ref = 0 })
			return
		end
		for _, c in ipairs(children) do
			local open = c.ref > 0 and is_open(c.key, view, overlay)
			table.insert(rows, { kind = "var", key = c.key, depth = depth, name = c.name, value = c.value, type = c.type, ref = c.ref, open = open })
			if open then under(c.key, depth + 1) end
		end
	end
	for _, e in ipairs(view.evals or {}) do
		local open = e.ref > 0 and is_open(e.key, view, overlay)
		table.insert(rows, { kind = "watch", key = e.key, depth = 0, name = e.expr, value = e.value, ref = e.ref, open = open, error = e.error })
		if open then under(e.key, 1) end
	end
	for _, s in ipairs(view.scopes or {}) do
		local open = s.ref > 0 and is_open(s.key, view, overlay)
		table.insert(rows, { kind = "scope", key = s.key, depth = 0, name = s.name, value = "", ref = s.ref, open = open })
		if open then under(s.key, 1) end
	end
	return rows
end

-- A row's text: "▸ items = [1, 2, 3]", "▾ Locals", "◇ s * 10 = 0".
function M.row_text(row)
	local icon = row.ref > 0 and (row.open and "▾ " or "▸ ") or "  "
	local indent = string.rep("  ", row.depth)
	if row.kind == "scope" then return indent .. icon .. row.name end
	if row.kind == "wait" then return indent .. "  …" end
	local name = row.kind == "watch" and ("◇ " .. row.name) or row.name
	if row.value == "" then return indent .. icon .. name end
	return indent .. icon .. name .. " = " .. row.value:gsub("\n", " ")
end

-- A frame's text: "add  app.py:4".
function M.frame_text(frame)
	if not frame.path then return frame.name end
	return frame.name .. "  " .. util.name(frame.path) .. ":" .. tostring(frame.line)
end

-- The head of a debug run: "paused on breakpoint · app.py:4", "running", ...
function M.state_text(view)
	if type(view) ~= "table" then return "starting the debugger" end
	if view.status == "paused" then
		local stop = view.stop or {}
		local f = (view.frames or {})[(view.frame or 0) + 1]
		local where = f and f.path and (" · " .. util.name(f.path) .. ":" .. tostring(f.line)) or ""
		local text = stop.text and stop.text ~= "" and (" · " .. stop.text) or ""
		return "paused on " .. tostring(stop.reason or "pause") .. where .. text
	end
	if view.status == "ended" then return "ended" end
	return view.status or "running"
end

-- The breakpoints of a file as the session takes them: { { line, condition? } }.
function M.lines_of(list)
	local out = {}
	for _, b in ipairs(list or {}) do table.insert(out, { line = b.line, condition = b.condition }) end
	return out
end

-- The feature ---------------------------------------------------------------------

function M.setup(app)
	local run = app:need("run")
	local has_marks, bookmarks = pcall(require, "ttt.bookmarks")
	local gutter = require("core.gutter")
	local bp_marks = has_marks and gutter.new(bookmarks, BP, "danger", { force = true }) or nil
	local here_marks = has_marks and gutter.new(bookmarks, HERE, "warning", { force = true }) or nil
	local bp_file = app.dir .. "/breakpoints.json"
	local runs_dir = app.dir .. "/runs"

	local bps = {}          -- path -> { { line, hash } }, by line
	local views = {}        -- run id -> { text, view }
	local sent = {}         -- run id -> the last command's seq
	local pending = {}      -- run id -> the commands not acked yet
	local overlay = {}      -- run id -> key -> { open, seq }: opened or closed, not done yet
	local stops = {}        -- run id -> the stop the editor went to (its first frame's id and the frame chosen)
	local mode = {}         -- run id -> "debug" | "output": the panel's choice (nil: debug while paused)
	local cursor = {}       -- run id -> { frame, var, var_top, frame_top }
	local col = "stack"     -- the pane the panel's keys move in: runs, stack, vars
	local layout = { stack_w = 0, frame_top = 1, var_top = 1, rows = {} }
	local anchor_timer = nil

	local function notify(text, level) ttt.notify("symbiosis: " .. text, level or "info") end

	-- Breakpoints -----------------------------------------------------------------

	local function load_bps()
		local ok, data = pcall(json.decode, fs.exists(bp_file) and fs.read(bp_file) or "")
		bps = {}
		if ok and type(data) == "table" and type(data.files) == "table" then
			for path, list in pairs(data.files) do
				if type(list) == "table" then
					local clean = {}
					for _, b in ipairs(list) do
						-- A condition comes from the file (written by hand); the editor keeps it.
						if type(b) == "table" and type(b.line) == "number" then
							table.insert(clean, { line = b.line, hash = b.hash, condition = type(b.condition) == "string" and b.condition or nil })
						end
					end
					if #clean > 0 then bps[path] = clean end
				end
			end
		end
	end

	local function save_bps()
		pcall(fs.write, bp_file, json.encode({ files = bps }))
	end

	local function view_of(id)
		local e = views[id]
		return e and e.view or nil
	end

	local function live_debug_runs()
		local out = {}
		for _, r in ipairs(run.runs()) do if r.debug and live(r) then table.insert(out, r) end end
		return out
	end

	-- The debug run the keys act on: the one the Run panel shows when it is a
	-- live debug run; else the newest paused one; else the newest live one.
	local function current()
		local sel = run.selected()
		if sel and sel.debug and live(sel) then return sel end
		local list = live_debug_runs()
		for i = #list, 1, -1 do
			local v = view_of(list[i].id)
			if v and v.status == "paused" then return list[i] end
		end
		return list[#list]
	end

	-- Commands for a session: written with those it has not done yet.
	local function send(id, op, fields)
		local v = view_of(id)
		local seq = math.max(sent[id] or 0, v and v.ack or 0) + 1
		sent[id] = seq
		local cmd = { seq = seq, op = op }
		for k, val in pairs(fields or {}) do cmd[k] = val end
		local list = {}
		for _, c in ipairs(pending[id] or {}) do
			if not v or c.seq > (v.ack or 0) then table.insert(list, c) end
		end
		table.insert(list, cmd)
		pending[id] = list
		local ok, err = pcall(fs.write, runs_dir .. "/" .. id .. "/debug-in.json", json.encode({ cmds = list }))
		if not ok then notify("could not reach the debug session: " .. tostring(err), "error") end
		return seq
	end

	local function send_bps(path)
		for _, r in ipairs(live_debug_runs()) do send(r.id, "breakpoints", { path = path, lines = M.lines_of(bps[path]) }) end
	end

	local draw -- the gutter, below

	local function set_bps(path, list)
		bps[path] = (list and #list > 0) and list or nil
		save_bps()
		send_bps(path)
		draw()
	end

	local function toggle()
		local path = editor.file_path()
		if not path or path == "" then return notify("no file is open") end
		local pos = editor.cursor()
		local line = pos and pos.line or 1
		local list = M.toggle(bps[path], line, notes.hash(editor.get_line(line) or ""))
		set_bps(path, list)
	end

	-- Lines come and go above a breakpoint: it is found again by its line's
	-- text, nearest its old line (core/notes.lua anchor). A breakpoint whose
	-- line was edited stays on its line number and takes the new text.
	local function anchor()
		local path = editor.file_path()
		local list = path and bps[path]
		if not list then return end
		local lines = editor.buffer_lines()
		local before = {}
		for i, b in ipairs(list) do before[i] = b.line end
		notes.anchor(list, lines)
		local out, seen, changed = {}, {}, false
		for i, b in ipairs(list) do
			if b.moved then b.line = math.min(before[i], #lines) b.moved = nil end
			if b.line ~= before[i] then changed = true end
			b.hash = notes.hash(lines[b.line] or "")
			if b.line >= 1 and not seen[b.line] then
				seen[b.line] = true
				table.insert(out, b)
			else
				changed = true
			end
		end
		if changed then
			table.sort(out, function(a, b) return a.line < b.line end)
			set_bps(path, out)
		end
	end

	-- The gutter -------------------------------------------------------------------

	-- The line the current session is paused on, in `path`.
	local function here_in(path)
		local r = current()
		local v = r and view_of(r.id)
		if not v or v.status ~= "paused" then return nil end
		local f = (v.frames or {})[(v.frame or 0) + 1]
		if f and f.path == path then return f.line end
		return nil
	end

	draw = function()
		if not bp_marks then return end
		local ok, err = pcall(function()
			local path = editor.file_path()
			if not path or path == "" then return end
			local here = here_in(path)
			local count = editor.line_count()
			local want = {}
			for _, b in ipairs(bps[path] or {}) do
				if b.line ~= here and b.line <= count then want[b.line] = true end
			end
			-- The breakpoints first: a line the ▶ leaves is theirs again (core/gutter.lua, force).
			bp_marks.draw(path, want)
			here_marks.draw(path, here and { [here] = true } or {})
		end)
		if not ok then
			bp_marks, here_marks = nil, nil
			app.log("error", "symbiosis debug marks: " .. tostring(err))
		end
	end

	-- The sessions -----------------------------------------------------------------

	local function status_item()
		local r = current()
		local v = r and view_of(r.id)
		if v and v.status == "paused" then
			local f = (v.frames or {})[(v.frame or 0) + 1]
			local where = f and f.path and (util.name(f.path) .. ":" .. tostring(f.line)) or tostring(v.stop and v.stop.reason or "paused")
			ttt.set_status_item("left", "symbiosis.debug", "⏸ " .. where .. " · F5 F10 F11 ⇧F11", { priority = 901, on_click = function() run.select(r.id) run.reveal(true) end })
		else
			pcall(ttt.remove_status_item, "symbiosis.debug")
		end
	end

	-- The frame's line in the editor: the file opened when it is not the open
	-- one (ttt.open_file does not move the cursor in a file already open).
	local function open_frame(f)
		if not f or not f.path then return end
		if editor.file_path() ~= f.path then pcall(ttt.open_file, f.path, f.line) end
		if editor.file_path() == f.path then
			pcall(editor.set_cursor, f.line, 1)
			pcall(buffer.reveal, f.line)
		end
	end

	-- A session's new view: a new stop opens its line and shows it in the panel.
	local function on_view(r, v)
		local id = r.id
		for key, o in pairs(overlay[id] or {}) do
			if (v.ack or 0) >= o.seq then overlay[id][key] = nil end
		end
		if v.status == "paused" then
			local top = (v.frames or {})[1]
			local key = top and (tostring(top.id) .. ":" .. tostring(top.line) .. ":" .. tostring(v.stop and v.stop.reason)) or "paused"
			if stops[id] ~= key and top then
				stops[id] = key
				mode[id] = nil
				cursor[id] = { frame = (v.frame or 0) + 1, var = 1, var_top = 1, frame_top = 1 }
				-- The focus stays where it is: you may step from the Run panel (n, i, u).
				open_frame(v.frames[(v.frame or 0) + 1])
				run.select(id)
				run.reveal()
				if v.stop and v.stop.reason == "exception" then
					notify("paused on an exception" .. (v.stop.text and (": " .. v.stop.text) or ""), "warning")
				end
			end
		else
			stops[id] = nil
		end
		if v.error and v.error ~= "" then app.log("warn", "symbiosis debug: " .. v.error) end
	end

	local function read_views()
		local changed = false
		local alive = {}
		for _, r in ipairs(live_debug_runs()) do
			alive[r.id] = true
			local text = fs.read(runs_dir .. "/" .. r.id .. "/debug.json")
			local e = views[r.id]
			if text and text ~= "" and (not e or e.text ~= text) then
				local ok, v = pcall(json.decode, text)
				if ok and type(v) == "table" then
					views[r.id] = { text = text, view = v }
					changed = true
					on_view(r, v)
				end
			end
		end
		for id in pairs(views) do
			if not alive[id] then
				views[id], pending[id], overlay[id] = nil, nil, nil
				changed = true
			end
		end
		if changed then
			draw()
			status_item()
			run.redraw()
		end
	end

	-- What a key or a letter does to the current session.
	local function act(op)
		local r = current()
		if not r then return notify("no debug session: shift+F9 debugs the chosen configuration") end
		local v = view_of(r.id)
		if (op == "continue" or op == "next" or op == "stepIn" or op == "stepOut") and not (v and v.status == "paused") then
			return notify("the program is not paused")
		end
		send(r.id, op)
	end

	local function debug_chosen()
		local c = run.chosen()
		if c and c.debug then return run.start(c, { debug = true }) end
		run.pick_debug()
	end

	-- The watch drawer: an expression, evaluated now and at each stop.
	local watch_text = ""
	local function render_watch(panel)
		local r = current()
		local v = r and view_of(r.id)
		panel:title("Watch")
		panel:input({
			placeholder = "an expression, in the frame chosen",
			on_change = function(text) watch_text = text or "" end,
			on_submit = function(text)
				local expr = type(text) == "string" and text ~= "" and text or watch_text
				watch_text = ""
				app:close_drawer("debug")
				if r and expr ~= "" then send(r.id, "evaluate", { expr = expr }) end
			end,
		})
		for _, e in ipairs(v and v.evals or {}) do
			panel:label({ text = "◇ " .. e.expr .. " = " .. e.value, style = e.error and "warning" or "default" })
		end
		panel:label({ text = "Enter adds it · x on a watch in the Run panel drops it · Esc", style = "muted", margin_top = 1 })
	end

	local function watch()
		if not current() then return notify("no debug session") end
		watch_text = ""
		app:open_drawer("debug", { width = 56, min_width = 36, side = "right", render = render_watch })
	end

	-- The Run panel's debug view ------------------------------------------------------

	local function shows(r)
		if not live(r) then return false end
		local m = mode[r.id]
		if m == "output" then return false end
		if m == "debug" then return true end
		local v = view_of(r.id)
		return v ~= nil and v.status == "paused"
	end

	local function cur_of(id)
		cursor[id] = cursor[id] or { frame = 1, var = 1, var_top = 1, frame_top = 1 }
		return cursor[id]
	end

	local function render(panel, x, ow, h, r)
		local put = run.put
		local v = view_of(r.id)
		local c = cur_of(r.id)
		local paused = v and v.status == "paused"
		put(panel, x, 0, util.cut(r.name .. " · " .. M.state_text(v), ow), paused and "warning" or "bold")
		local hint = paused and "c continue · n over · i into · u out · Tab runs/stack/variables · Enter opens · e watch · v output · s stop"
			or "p pauses · v output · s stop"
		put(panel, x, h - 1, util.cut(hint, ow), "muted")
		if not paused then
			put(panel, x, 1, "Running: the stack and the variables show when it pauses (a breakpoint, F6).", "muted")
			layout.rows = {}
			return
		end
		local body = h - 3 -- rows under the pane titles
		local sw = math.max(16, math.min(48, math.floor(ow * 0.38)))
		layout.stack_w = sw
		-- The call stack.
		local frames = v.frames or {}
		c.frame = math.max(1, math.min(#frames, c.frame))
		if c.frame < c.frame_top then c.frame_top = c.frame end
		if c.frame >= c.frame_top + body then c.frame_top = c.frame - body + 1 end
		layout.frame_top = c.frame_top
		put(panel, x, 1, "CALL STACK", col == "stack" and "bold" or "muted")
		for i = c.frame_top, math.min(#frames, c.frame_top + body - 1) do
			local f = frames[i]
			local chosen = i == (v.frame or 0) + 1
			local style = (col == "stack" and i == c.frame) and "selected" or ((f.hint == "subtle" or not f.path) and "muted" or "default")
			put(panel, x, 2 + i - c.frame_top, util.cut((chosen and "› " or "  ") .. M.frame_text(f), sw - 1), style)
		end
		for row = 1, h - 2 do put(panel, x + sw, row, "│", "border") end
		-- The variables.
		local vx, vw = x + sw + 2, ow - sw - 2
		local rows = M.var_rows(v, overlay[r.id])
		layout.rows = rows
		c.var = math.max(1, math.min(#rows, c.var))
		if c.var < c.var_top then c.var_top = c.var end
		if c.var >= c.var_top + body then c.var_top = c.var - body + 1 end
		layout.var_top = c.var_top
		put(panel, vx, 1, "VARIABLES", col == "vars" and "bold" or "muted")
		for i = c.var_top, math.min(#rows, c.var_top + body - 1) do
			local row = rows[i]
			local style = (col == "vars" and i == c.var) and "selected" or (row.kind == "scope" and "bold" or (row.error and "warning" or "default"))
			put(panel, vx, 2 + i - c.var_top, util.cut(M.row_text(row), vw), style)
		end
		if #rows == 0 then put(panel, vx, 2, "No variables in this frame.", "muted") end
	end

	local function choose_frame(r, index)
		local v = view_of(r.id)
		local f = v and (v.frames or {})[index]
		if not f then return end
		cur_of(r.id).frame = index
		send(r.id, "frame", { index = index - 1 })
		open_frame(f)
		run.redraw()
	end

	local function open_row(r, row, open)
		if not row or row.ref <= 0 then return end
		overlay[r.id] = overlay[r.id] or {}
		local seq = send(r.id, open and "expand" or "collapse", { key = row.key })
		overlay[r.id][row.key] = { open = open, seq = seq }
		run.redraw()
	end

	local function on_key(ev, r)
		local k, rune = ev.key, ev.rune
		if rune == "v" and live(r) then
			mode[r.id] = shows(r) and "output" or "debug"
			run.redraw()
			return true
		end
		-- No F keys here: a plugin's panel cannot tell ttt it took a key, so F10
		-- would step and open ttt's menu too. The letters do it (F5 comes as
		-- the run's command, which continues: `continue_paused`).
		if not shows(r) then return false end
		local v = view_of(r.id)
		local status = v and v.status
		local op = M.letter_op(rune, status)
		if op then
			send(r.id, op)
			return true
		end
		if rune == "e" then watch() return true end
		if k == "Tab" then
			col = col == "runs" and "stack" or (col == "stack" and "vars" or "runs")
			run.redraw()
			return true
		end
		if col == "runs" then return false end
		local c = cur_of(r.id)
		local up = k == "Up" or rune == "k"
		local down = k == "Down" or rune == "j"
		if col == "stack" then
			if up or down then
				c.frame = c.frame + (up and -1 or 1)
				run.redraw()
				return true
			end
			if k == "Enter" or k == "Right" then choose_frame(r, c.frame) return true end
			return false
		end
		-- The variables.
		local rows = layout.rows
		local row = rows[c.var]
		if up or down then
			c.var = c.var + (up and -1 or 1)
			run.redraw()
			return true
		end
		if k == "Enter" then open_row(r, row, row and not row.open) return true end
		if k == "Right" then open_row(r, row, true) return true end
		if k == "Left" then
			if row and row.open then open_row(r, row, false) return true end
			-- To the row it is under.
			for i = c.var - 1, 1, -1 do
				if rows[i].depth < (row and row.depth or 0) then c.var = i break end
			end
			run.redraw()
			return true
		end
		if (rune == "x" or k == "Delete") and row and row.kind == "watch" then
			send(r.id, "unwatch", { expr = row.name })
			return true
		end
		return false
	end

	-- A click at (cx, y) of the debug view (cx from its left edge).
	local function on_click(cx, y, r)
		if not shows(r) then return end
		local c = cur_of(r.id)
		if y < 2 then return end
		if cx < layout.stack_w then
			col = "stack"
			choose_frame(r, layout.frame_top + y - 2)
			return
		end
		col = "vars"
		local i = layout.var_top + y - 2
		local row = layout.rows[i]
		if not row then return end
		c.var = i
		open_row(r, row, not row.open)
		run.redraw()
	end

	-- Hooks --------------------------------------------------------------------------

	app:on("ready", function()
		load_bps()
		draw()
	end)

	app:on("tick", function()
		if #live_debug_runs() > 0 or next(views) then read_views() end
	end)

	app:on("second", function()
		draw()
		status_item()
	end)

	app:on("file", function()
		anchor()
		draw()
	end)

	app:on("change", function()
		if not bps[editor.file_path() or ""] then return end
		if anchor_timer then pcall(ttt.clear_timeout, anchor_timer) end
		anchor_timer = ttt.set_timeout(ANCHOR_MS, function()
			anchor_timer = nil
			anchor()
		end)
	end)

	-- F5, F10, F11, shift+F11 while paused, F6 while it runs: before ttt's own keys.
	app:on("key", function(key)
		local r = current()
		if not r then return false end
		local v = view_of(r.id)
		local op = M.key_op(key, v and v.status)
		if not op then return false end
		send(r.id, op)
		return true
	end, 5)

	-- A click on a breakpoint's mark takes it off.
	local fine = pcall(events.on, "gutter.click", function(a, b)
		local path, line = a, b
		if type(a) == "table" then path, line = a.path or a.file, a.line end
		if type(path) ~= "string" or type(line) ~= "number" then return false end
		for _, bp in ipairs(bps[path] or {}) do
			if bp.line == line and line ~= here_in(path) then
				set_bps(path, M.toggle(bps[path], line))
				return false
			end
		end
		return false
	end)
	if not fine then app.log("warn", "symbiosis: this ttt has no gutter.click; F9 takes a breakpoint off") end

	app:command({ id = "symbiosis.debugToggleBreakpoint", title = "symbiosis: Toggle Breakpoint", key = "f9", run = toggle })
	app:command({ id = "symbiosis.debug", title = "symbiosis: Debug", key = "shift+f9", run = debug_chosen })
	app:command({ id = "symbiosis.debugPick", title = "symbiosis: Debug Configuration…", key = "ctrl+k f9", run = function() run.pick_debug() end })
	app:command({ id = "symbiosis.debugContinue", title = "symbiosis: Continue (Debug)", run = function() act("continue") end })
	app:command({ id = "symbiosis.debugStepOver", title = "symbiosis: Step Over", run = function() act("next") end })
	app:command({ id = "symbiosis.debugStepInto", title = "symbiosis: Step Into", run = function() act("stepIn") end })
	app:command({ id = "symbiosis.debugStepOut", title = "symbiosis: Step Out", run = function() act("stepOut") end })
	app:command({ id = "symbiosis.debugPause", title = "symbiosis: Pause (Debug)", run = function() act("pause") end })
	app:command({ id = "symbiosis.debugWatch", title = "symbiosis: Watch an Expression…", run = watch })
	app:command({
		id = "symbiosis.debugRemoveBreakpoints", title = "symbiosis: Remove All Breakpoints",
		run = function()
			local paths = {}
			for path in pairs(bps) do table.insert(paths, path) end
			bps = {}
			save_bps()
			for _, path in ipairs(paths) do send_bps(path) end
			draw()
			notify("all breakpoints removed")
		end,
	})
	app:hint({ key = "F9 · shift+F9", text = "breakpoint · debug", order = 97 })
	app:hint({ key = "F5 F10 F11 ⇧F11", text = "paused: continue, over, into, out", order = 98 })

	return {
		-- F5 as the run's command (the Run panel has the focus): continues a
		-- paused session instead of running its configuration again. True when it did.
		continue_paused = function()
			local r = current()
			local v = r and view_of(r.id)
			if not (v and v.status == "paused") then return false end
			send(r.id, "continue")
			return true
		end,
		shows = shows,
		render = render,
		on_key = on_key,
		on_click = on_click,
		breakpoints = function(path) return bps[path] or {} end,
		view = view_of,
		toggle = toggle,
	}
end

return M
