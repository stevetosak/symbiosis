-- Run configurations, as in Rider and VSCode: F5 runs the chosen
-- configuration, shift+F5 stops it, ctrl+k F5 picks one. The configurations
-- come from .symbiosis/run.json, .vscode/launch.json and tasks.json, the file
-- open, and what the project's files say (package.json scripts, Cargo,
-- go.mod, .csproj, Makefile, ...): core/run/ in TypeScript.
--
-- ttt lets a plugin start a program but not keep it, read it as it goes, or
-- kill it; so `symbiosis run` (launcher/run.ts) does: each run gets a
-- supervisor of its own, which writes the run's state and output to
-- runs/<id>/ in the plugin folder. This feature reads those files:
--   the status bar   ▶ api   ● api 0:42   ✓ api   ✗ api 1
--   the Run panel    a tab of the bottom panel: the runs, and the output of one
-- Runs outlive ttt when you say so at ctrl+q; the Run panel shows them again
-- the next time.
local ttt = require("ttt")
local editor = require("ttt.editor")
local fs = require("ttt.fs")
local json = require("ttt.json")
local system = require("ttt.system")
local util = require("core.util")

local PANEL_ID = "plugin.symbiosis"
local STALE_POLL = 5 -- ticks between reads of the runs while one runs (200 ms)

local M = { name = "run" }

-- Pure helpers (the Lua unit tests use them) ---------------------------------------

local LIVE = { starting = true, running = true }
function M.live(run) return run ~= nil and LIVE[run.status] == true end

-- A run that says it runs but whose supervisor has not written for 8 s
-- (a crash, a reboot): lost. `now` in seconds.
function M.settle(run, now)
	if run.status == "running" and run.t and now - run.t / 1000 > 8 then run.status = "lost" end
	return run
end

-- "0:42", "12:03", "1:02:03".
function M.elapsed(seconds)
	seconds = math.max(0, math.floor(seconds))
	local h, m, s = math.floor(seconds / 3600), math.floor(seconds / 60) % 60, seconds % 60
	if h > 0 then return string.format("%d:%02d:%02d", h, m, s) end
	return string.format("%d:%02d", m, s)
end

-- The icon and the word for a run's state.
function M.badge(run)
	local st = run.status
	if st == "starting" or st == "running" then return "●", "running", "success" end
	if st == "exited" and (run.code or 0) == 0 then return "✓", "exited 0", "muted" end
	if st == "exited" then return "✗", "exited " .. tostring(run.code), "danger" end
	if st == "stopped" then return "■", "stopped", "muted" end
	if st == "lost" then return "?", "lost", "warning" end
	return "✗", run.error or "failed", "danger"
end

-- How long it ran, or runs: from the run's started/ended (ms) and now (s).
function M.duration(run, now)
	local ended = run.ended and run.ended / 1000 or now
	return M.elapsed(ended - (run.started or 0) / 1000)
end

-- The status bar: the latest run of the chosen configuration, else the choice.
function M.status_line(chosen, runs, now)
	local live, last = 0, nil
	for _, r in ipairs(runs) do
		if M.live(r) then live = live + 1 end
	end
	for i = #runs, 1, -1 do
		local r = runs[i]
		if chosen and r.configId == chosen.id then last = r break end
	end
	if not last and live > 0 then
		for i = #runs, 1, -1 do if M.live(runs[i]) then last = runs[i] break end end
	end
	local text
	if last then
		local icon = M.badge(last)
		text = icon .. " " .. util.cut(last.name, 24)
		if M.live(last) then text = text .. " " .. M.duration(last, now)
		elseif last.status == "exited" and (last.code or 0) ~= 0 then text = text .. " " .. tostring(last.code) end
	elseif chosen then
		text = "▶ " .. util.cut(chosen.name, 24)
	else
		return nil
	end
	local others = live - ((last and M.live(last)) and 1 or 0)
	if others > 0 then text = text .. " +" .. others end
	return text
end

-- The configs that match a query: every word in the name, the group or the
-- command, in any case. Keeps their order.
function M.filter(configs, query)
	local words = {}
	for w in tostring(query or ""):lower():gmatch("%S+") do table.insert(words, w) end
	local out = {}
	for _, c in ipairs(configs) do
		local hay = (c.name .. " " .. c.group .. " " .. (c.line or "")):lower()
		local ok = true
		for _, w in ipairs(words) do
			if not hay:find(w, 1, true) then ok = false break end
		end
		if ok then table.insert(out, c) end
	end
	return out
end

-- A file reference in a line of output: "src/app.ts:12:5", "at f (/x/y.js:3:1)",
-- 'File "a.py", line 7'. Returns path, line or nil.
function M.file_ref(line)
	local path, n = line:match('File "([^"]+)", line (%d+)')
	if path then return path, tonumber(n) end
	line = line:gsub("%a[%w+.-]*://%S+", "") -- not a URL's host:port
	for p, l in line:gmatch("([%w_%./~@%-]+%.[%a]+):(%d+)") do return p, tonumber(l) end
	for p, l in line:gmatch("([%w_%./~@%-]+%.[%a]+)%((%d+)") do return p, tonumber(l) end -- C#: Program.cs(12,5)
	return nil
end

-- What `symbiosis run list` will say the workspace folder of `file` is, as
-- far as the plugin can tell: the nearest folder with .symbiosis/run.json up
-- to the git root, else the git root, else the file's folder.
function M.guess_folder(file, exists)
	local d = file:match("^(.*)/[^/]*$")
	local saved = nil
	while d and d ~= "" do
		if not saved and exists(d .. "/.symbiosis/run.json") then saved = d end
		if exists(d .. "/.git") then return saved or d end
		d = d:match("^(.*)/[^/]*$")
	end
	return saved or file:match("^(.*)/[^/]*$")
end

-- tail.txt's text → its lines.
-- The screen cell of a bottom panel's top left, from ttt.debug's state: the
-- BottomPanel widget, below its tab row and the divider. Nil when not found.
function M.panel_origin(state)
	local function walk(node)
		if type(node) ~= "table" then return nil end
		if node.type == "BottomPanel" and type(node.rect) == "table" then return node.rect end
		for _, child in ipairs(node.children or {}) do
			local r = walk(child)
			if r then return r end
		end
		return nil
	end
	local r = type(state) == "table" and walk(state.widget_tree) or nil
	if not r then return nil end
	return r.x or 0, (r.y or 0) + 2
end

function M.split_lines(text)
	local out = {}
	for line in util.lines(text or "") do table.insert(out, (line:gsub("\n$", ""))) end
	return out
end

-- The tree's items: a node per group, the configurations under it.
function M.picker_items(list, chosen_id)
	local items, groups = {}, {}
	for _, c in ipairs(list) do
		local g = groups[c.group]
		if not g then
			g = { id = "group:" .. c.group, label = c.group, expandable = true, expanded = true, muted = true, children = {} }
			groups[c.group] = g
			table.insert(items, g)
		end
		table.insert(g.children, {
			id = c.id,
			label = c.name .. (c.line and c.line ~= "" and ("  " .. c.line) or ""),
			icon = c.id == chosen_id and "▶" or " ",
		})
	end
	return items
end

-- panel:text at x stops at column w - x, not w (ttt 1.7: lua_panel.go passes
-- w - x as the width, the surface takes it as the right edge). put draws
-- what panel:text cannot reach a cell at a time.
function M.put(panel, x, y, text, style)
	local w = panel:size()
	local edge = w - x
	if x == 0 or x + util.runes(text) <= edge then return panel:text(x, y, text, style) end
	local head, col = {}, x
	for ch in text:gmatch("[^\128-\191][\128-\191]*") do
		if col >= w then break end
		if col < edge then table.insert(head, ch) else panel:cell(col, y, ch, style) end
		col = col + 1
	end
	if #head > 0 then panel:text(x, y, table.concat(head), style) end
end

-- The feature ---------------------------------------------------------------------

function M.setup(app)
	local dir = app.dir .. "/runs"
	local chosen_file = app.dir .. "/run-chosen.json"

	local folder = nil        -- the workspace folder (from `symbiosis run list`)
	local configs = {}        -- the configurations, as `run list` gives them
	local problems = {}
	local runs = {}           -- the runs of the folder, oldest first (state.json)
	local chosen_ids = {}     -- folder -> the chosen config's id
	local selected = nil      -- the run the panel shows
	local scroll = 0          -- lines up from the end of the output; 0 follows it
	local tail = { id = nil, seq = -1, lines = {} }
	local panel_ref = nil
	local picker = nil        -- { items } while the picker is open
	local busy = false
	local ticks = 0
	local welcomed = false
	local list_runs, refresh_list

	local function notify(text, level) ttt.notify("symbiosis: " .. text, level or "info") end

	local function chosen()
		local id = folder and chosen_ids[folder]
		for _, c in ipairs(configs) do if c.id == id then return c end end
		return nil
	end

	local function redraw()
		if panel_ref then panel_ref:redraw() end
	end

	local function file_now()
		local ok, path = pcall(editor.file_path)
		if ok and type(path) == "string" and path ~= "" then return path end
		return nil
	end

	-- `symbiosis run <args>`: cb(result) with the JSON it printed, or nil after a notice.
	local function cli(args, cb)
		if table.maxn(args) ~= #args then
			-- A nil in the arguments: no workspace folder yet.
			notify("no workspace folder yet: open a file of the project", "warning")
			if cb then cb(nil) end
			return
		end
		local argv = { "run" }
		for _, a in ipairs(args) do table.insert(argv, a) end
		-- The runs folder this reads, whatever the environment says.
		table.insert(argv, "--runs")
		table.insert(argv, dir)
		local ok, err = pcall(system.exec_async, "symbiosis", argv, function(result)
			local out = nil
			if result and type(result.stdout) == "string" and result.stdout ~= "" then
				local good, decoded = pcall(json.decode, result.stdout)
				if good then out = decoded end
			end
			if not out then
				local why = result and (result.stderr ~= "" and result.stderr or result.error) or "no answer"
				notify("`symbiosis run` failed: " .. tostring(why) .. " (is symbiosis on PATH? install.sh links it)", "error")
				return cb and cb(nil)
			end
			if not out.ok then
				notify(tostring(out.error), "error")
				return cb and cb(nil)
			end
			if cb then cb(out) end
		end)
		if not ok then
			notify("could not start symbiosis: " .. tostring(err), "error")
			if cb then cb(nil) end
		end
	end

	-- The runs from runs/*/state.json: this folder's, and those still going.
	local function read_runs()
		local entries = fs.list(dir)
		local out = {}
		for _, e in ipairs(entries or {}) do
			if e.is_dir then
				local text = fs.read(dir .. "/" .. e.name .. "/state.json")
				local ok, st = pcall(json.decode, text or "")
				if ok and type(st) == "table" and st.id and (st.folder == folder or (folder == nil and M.live(st))) then
					table.insert(out, M.settle(st, os.time()))
				end
			end
		end
		table.sort(out, function(a, b) return (a.started or 0) < (b.started or 0) end)
		return out
	end

	local function find_run(id)
		for _, r in ipairs(runs) do if r.id == id then return r end end
		return nil
	end

	local function status()
		local line = M.status_line(chosen(), runs, os.time())
		if line then
			ttt.set_status_item("left", "symbiosis.run", line, { priority = 900, on_click = function() M.api.pick() end })
		else
			ttt.remove_status_item("symbiosis.run")
		end
	end

	local function read_tail()
		local run = find_run(selected)
		if not run then
			tail = { id = nil, seq = -1, lines = {} }
			return
		end
		if tail.id == run.id and tail.seq == run.seq then return end
		local text = fs.read(dir .. "/" .. run.id .. "/tail.txt") or ""
		tail = { id = run.id, seq = run.seq, lines = M.split_lines(text) }
	end

	list_runs = function()
		runs = read_runs()
		if selected and not find_run(selected) then selected = nil end
		if not selected and #runs > 0 then selected = runs[#runs].id end
		read_tail()
		status()
		redraw()
	end

	local function load_chosen()
		local text = fs.exists(chosen_file) and fs.read(chosen_file) or nil
		local ok, data = pcall(json.decode, text or "")
		if ok and type(data) == "table" then chosen_ids = data end
	end

	local function choose(config)
		if not folder then return end
		chosen_ids[folder] = config.id
		pcall(fs.write, chosen_file, json.encode(chosen_ids))
	end

	-- `run list` for the file open: the folder, its configurations, its runs.
	refresh_list = function(after)
		cli({ "list", "--file", file_now() or "" }, function(out)
			if not out then return end
			folder, configs, problems = out.folder, out.configs or {}, out.problems or {}
			list_runs()
			if after then after() end
		end)
	end

	-- ttt's state, as ttt.debug writes it: the bottom panel's tabs, the widgets' places.
	local function debug_state()
		local path = app.dir .. "/run-debug.json"
		if not pcall(ttt.debug, path) then return nil end
		local ok, d = pcall(json.decode, fs.read(path) or "")
		return ok and type(d) == "table" and d or nil
	end

	-- The Run panel tab: brings it up. ttt has no call for it: the panel's
	-- tabs are cycled with tab.next while the panel has the focus, then the
	-- focus goes back to the editor.
	-- With focus, the panel keeps the focus (for its keys).
	local function reveal(focus)
		local d = debug_state()
		local bp = type(d) == "table" and d.bottom_panel or nil
		if type(bp) ~= "table" then return end
		if bp.visible and bp.active == PANEL_ID then
			if focus then ttt.exec_command("panel.focus") end
			return
		end
		local from, to, n = nil, nil, #(bp.panels or {})
		for i, id in ipairs(bp.panels or {}) do
			if id == bp.active then from = i end
			if id == PANEL_ID then to = i end
		end
		if not to then return end
		ttt.exec_command("panel.focus")
		for _ = 1, ((to - (from or to)) % n) do ttt.exec_command("tab.next") end
		if not focus then ttt.exec_command("editor.focus") end
	end

	local function start(config)
		if busy then return end
		busy = true
		choose(config)
		local pos = select(2, pcall(editor.cursor))
		local args = { "start", "--folder", folder, "--config", config.id, "--file", file_now() or "" }
		if type(pos) == "table" and pos.line then
			table.insert(args, "--line")
			table.insert(args, tostring(pos.line))
		end
		cli(args, function(out)
			busy = false
			if not out then return end
			selected, scroll = out.run.id, 0
			list_runs()
			reveal()
		end)
	end

	local function run_chosen()
		local c = chosen()
		if c then return start(c) end
		M.api.pick()
	end

	local function stop(run)
		if not run or not M.live(run) then return end
		cli({ "stop", run.id }, function() list_runs() end)
	end

	-- shift+F5: the run the panel shows when it runs, else the newest that runs.
	local function stop_current()
		local run = find_run(selected)
		if not M.live(run) then
			run = nil
			for i = #runs, 1, -1 do if M.live(runs[i]) then run = runs[i] break end end
		end
		if not run then return notify("nothing runs") end
		stop(run)
	end

	local function again(run)
		if not run or busy then return end
		busy = true
		cli({ "again", run.id }, function(out)
			busy = false
			if not out then return end
			selected, scroll = out.run.id, 0
			list_runs()
		end)
	end

	-- The picker -------------------------------------------------------------------
	-- A drawer: an input that filters, and the configurations by where they
	-- come from. ttt gives a drawer no keys of its own, so the widgets do it:
	-- Enter in the input runs the first match, Tab goes down to the list.

	local function edit_run_json()
		if not folder then return end
		local path = folder .. "/.symbiosis/run.json"
		if not fs.exists(path) then
			fs.write(path, '{\n\t// "command" with "args" runs the program; "command" alone is a shell line.\n'
				.. '\t// Variables: ${workspaceFolder} ${file} ${fileDirname} ${lineNumber} ${env:NAME} ...\n'
				.. '\t"configurations": [\n\t\t{ "name": "dev", "command": "npm", "args": ["run", "dev"], "cwd": "${workspaceFolder}", "env": {} }\n\t]\n}\n')
		end
		ttt.open_file(path)
	end

	local function save(config)
		if not config or config.group == "Saved" then return end
		cli({ "save", "--folder", folder, "--config", config.id, "--file", file_now() or "" }, function(out)
			if not out then return end
			notify("saved \"" .. tostring(out.saved) .. "\" to .symbiosis/run.json")
			refresh_list()
		end)
	end

	local function close_picker()
		picker = nil
		pcall(ttt.close_drawer)
	end

	local function by_id(id)
		for _, c in ipairs(configs) do if c.id == id then return c end end
		return nil
	end

	local function render_picker(panel)
		if not picker then return end
		local now = chosen()
		panel:title("Run")
		panel:label({ text = folder and util.short(folder) or "", style = "muted" })
		panel:input({
			placeholder = "filter: name, group or command",
			on_change = function(text)
				if not picker then return end
				picker.items = M.filter(configs, text)
				panel:redraw()
			end,
			on_submit = function()
				local c = picker and picker.items[1]
				if not c then return end
				close_picker()
				start(c)
			end,
		})
		if #picker.items == 0 then
			panel:label({ text = #configs == 0 and "Nothing to run found here." or "No configuration matches.", style = "muted" })
		end
		panel:tree({
			items = M.picker_items(picker.items, now and now.id),
			key_commands = { s = "save", e = "edit" },
			on_select = function(node)
				local c = by_id(node.id)
				if not c then return end
				close_picker()
				start(c)
			end,
			on_command = function(command, node)
				if command == "edit" then
					close_picker()
					return edit_run_json()
				end
				if command == "save" then
					local c = by_id(node and node.id)
					close_picker()
					save(c)
				end
			end,
		})
		for _, p in ipairs(problems) do panel:label({ text = "⚠ " .. p, style = "warning" }) end
		panel:label({ text = "Enter runs the first · Tab to the list · s saves it to run.json · e edits run.json · Esc", style = "muted", margin_top = 1 })
	end

	local function show_picker()
		picker = { items = configs }
		ttt.open_drawer({ width = 64, min_width = 40, side = "right", render = render_picker })
	end

	local function pick()
		refresh_list(show_picker)
	end

	-- The Run panel ------------------------------------------------------------------

	local layout = { left = 0, rows = {}, out_top = 1, out_rows = 0, first = 1, w = 0, h = 0 }
	-- Where the panel is on the screen: ttt gives a panel's mouse events in
	-- screen cells, and the panel its own size only. From ttt.debug, again
	-- when the panel's size changes.
	local origin = nil

	local function render_panel(panel)
		panel_ref = panel
		local w, h = panel:size()
		if w <= 0 or h <= 0 then return end
		if w ~= layout.w or h ~= layout.h then origin = nil end
		layout.w, layout.h = w, h
		local now = os.time()
		if #runs == 0 then
			local c = chosen()
			M.put(panel, 1, 0, "Nothing runs.", "bold")
			M.put(panel, 1, 1, c and ("F5 runs " .. c.name .. " · ctrl+k F5 picks a configuration") or "F5 or ctrl+k F5 picks a configuration to run", "muted")
			M.put(panel, 1, 2, "From .symbiosis/run.json, .vscode, package.json, Cargo.toml, go.mod, *.csproj, Makefile, ...", "muted")
			return
		end
		local left = math.min(28, math.max(16, math.floor(w * 0.28)))
		layout.left = left
		layout.rows = {}
		-- The runs, newest at the top.
		local y = 0
		for i = #runs, 1, -1 do
			if y >= h then break end
			local r = runs[i]
			local icon, _, style = M.badge(r)
			local on = r.id == selected
			local time = M.duration(r, now)
			local name = util.cut(r.name, left - 4 - #time)
			M.put(panel, 0, y, on and "›" or " ", on and "selected" or "default")
			M.put(panel, 1, y, icon, style)
			M.put(panel, 3, y, name, on and "selected" or "default")
			M.put(panel, left - #time - 1, y, time, "muted")
			layout.rows[y] = r.id
			y = y + 1
		end
		for row = 0, h - 1 do M.put(panel, left, row, "│", "border") end
		-- The output of the selected run.
		local run = find_run(selected)
		if not run then return end
		local x = left + 2
		local ow = w - x
		local _, word, style = M.badge(run)
		local head = run.name .. " · " .. word
		if run.pid and M.live(run) then head = head .. " · pid " .. run.pid end
		M.put(panel, x, 0, util.cut(head, ow), style == "muted" and "bold" or style)
		local hw = util.runes(head)
		if ow - hw > 10 then M.put(panel, x + hw + 3, 0, util.cut(run.line or "", ow - hw - 3), "muted") end
		local rows = h - 2
		local lines = tail.lines
		local last = #lines - scroll
		local first = math.max(1, last - rows + 1)
		layout.out_top, layout.out_rows, layout.first = 1, rows, first
		for i = first, last do
			local line = lines[i]
			local st = "default"
			if line:find("[Ee]rror") or line:find("FAIL") or line:find("[Ee]xception") then st = "danger"
			elseif line:find("[Ww]arn") then st = "warning" end
			M.put(panel, x, 1 + i - first, util.cut(line, ow), st)
		end
		local hint = M.live(run) and "s stop · r restart" or "r run again · x remove"
		hint = hint .. " · ↑↓ runs · PgUp/PgDn scroll · o full log · click a file:line · Esc editor"
		if scroll > 0 then hint = "↓ " .. scroll .. " more · End follows · " .. hint end
		M.put(panel, x, h - 1, util.cut(hint, ow), "muted")
	end

	local function select_run(delta)
		if #runs == 0 then return end
		local at = #runs
		for i, r in ipairs(runs) do if r.id == selected then at = i end end
		-- The list shows the newest first: Up (1) is newer, Down (-1) older.
		at = math.max(1, math.min(#runs, at + delta))
		selected, scroll = runs[at].id, 0
		read_tail()
		redraw()
	end

	local function scroll_by(n)
		local max = math.max(0, #tail.lines - layout.out_rows)
		scroll = math.max(0, math.min(max, scroll + n))
		redraw()
	end

	local function open_ref(line)
		local run = find_run(selected)
		local path, n = M.file_ref(line or "")
		if not path or not run then return false end
		if path:sub(1, 2) == "~/" then path = (os.getenv("HOME") or "~") .. path:sub(2) end
		if path:sub(1, 1) ~= "/" then path = (run.cwd or folder or "") .. "/" .. path:gsub("^%./", "") end
		if not fs.exists(path) then return false end
		ttt.open_file(path, n)
		ttt.exec_command("editor.focus")
		return true
	end

	local function on_event(ev)
		if ev.type == "key" then
			local k, rune = ev.key, ev.rune
			local run = find_run(selected)
			if k == "Up" or rune == "k" then select_run(1)
			elseif k == "Down" or rune == "j" then select_run(-1)
			elseif k == "PgUp" then scroll_by(math.max(1, layout.out_rows - 1))
			elseif k == "PgDn" then scroll_by(-math.max(1, layout.out_rows - 1))
			elseif k == "Home" then scroll_by(#tail.lines)
			elseif k == "End" then scroll = 0 redraw()
			elseif k == "Esc" or k == "Escape" then ttt.exec_command("editor.focus")
			elseif rune == "s" then stop(run)
			elseif rune == "r" then again(run)
			elseif rune == "x" and run and not M.live(run) then
				selected = nil
				cli({ "remove", run.id }, function() list_runs() end)
			elseif rune == "o" and run then ttt.open_file(dir .. "/" .. run.id .. "/output.log", 0, true)
			elseif k == "Enter" then
				local lines = tail.lines
				for i = #lines - scroll, math.max(1, #lines - scroll - layout.out_rows + 1), -1 do
					if open_ref(lines[i]) then break end
				end
			else
				return false
			end
			return true
		elseif ev.type == "mouse" then
			if ev.button == "wheel_up" then scroll_by(3) return true end
			if ev.button == "wheel_down" then scroll_by(-3) return true end
			if ev.button ~= "left" then return false end
			-- A click focuses the panel: ttt does that only for a panel that
			-- tells it it took the click, which a plugin's cannot.
			ttt.exec_command("panel.focus")
			if not origin then origin = { M.panel_origin(debug_state()) } end
			if not origin[1] then return true end
			local x, y = ev.x - origin[1], ev.y - origin[2]
			if x < layout.left then
				local id = layout.rows[y]
				if id then selected, scroll = id, 0 read_tail() redraw() end
				return true
			end
			local i = layout.first + y - layout.out_top
			if y >= layout.out_top and y < layout.out_top + layout.out_rows then open_ref(tail.lines[i]) end
			return true
		end
		return false
	end

	-- ctrl+q --------------------------------------------------------------------------

	local quitting = false

	-- ctrl+q while programs run: stop them, keep them, or stay.
	local function ask_quit(live)
		pcall(ttt.close_drawer)
		picker = nil
		local names = {}
		for _, r in ipairs(live) do table.insert(names, r.name) end
		local what = #live == 1 and ("\"" .. live[1].name .. "\" runs") or (#live .. " programs run (" .. table.concat(names, ", ") .. ")")
		ttt.command_line.show({
			prefix = util.cut(what, 50) .. ": s stops them and quits · k keeps them running · Esc stays ",
			on_key = function(ev)
				local r = ev.rune
				if r == "s" or r == "S" or ev.key == "Enter" then
					ttt.command_line.hide()
					quitting = true
					local args = { "stop" }
					for _, run in ipairs(live) do table.insert(args, run.id) end
					notify("stopping " .. #live .. " program" .. (#live == 1 and "" or "s") .. "…")
					cli(args, function() ttt.quit() end)
					return true
				elseif r == "k" or r == "K" then
					ttt.command_line.hide()
					quitting = true
					local args = { "keep" }
					for _, run in ipairs(live) do table.insert(args, run.id) end
					cli(args, function() ttt.quit() end)
					return true
				elseif ev.key == "Escape" or ev.key == "Esc" then
					return false
				end
				return true
			end,
		})
	end

	app:on("key", function(key)
		if quitting or key.key ~= "Ctrl-Q" then return false end
		local live = {}
		for _, r in ipairs(read_runs()) do if M.live(r) and not fs.exists(dir .. "/" .. r.id .. "/keep") then table.insert(live, r) end end
		if #live == 0 then return false end
		ask_quit(live)
		return true
	end, 10)

	-- The clock --------------------------------------------------------------------------

	app:on("ready", function()
		load_chosen()
		refresh_list(function()
			if welcomed then return end
			welcomed = true
			-- Programs from the last time, kept running when ttt quit: they are ours again.
			local kept = 0
			for _, r in ipairs(runs) do if M.live(r) then kept = kept + 1 end end
			if kept > 0 then
				cli({ "ps", "--adopt", "--folder", folder }, function()
					list_runs()
					reveal()
				end)
				notify(kept .. " program" .. (kept == 1 and "" or "s") .. " from the last time still run" .. (kept == 1 and "s" or "") .. ": see the Run panel", "warning")
			end
		end)
	end)

	app:on("tick", function()
		ticks = ticks + 1
		if ticks % STALE_POLL ~= 0 then return end
		local any = false
		for _, r in ipairs(runs) do if M.live(r) then any = true break end end
		if any then list_runs() end
	end)

	app:on("second", function()
		-- Runs started elsewhere (`symbiosis run start` in a terminal), and the elapsed time.
		list_runs()
	end)

	local last_file = nil
	-- A new file: the configurations again only when it may be another
	-- workspace folder (`run list` walks the folder; the picker lists afresh).
	local last_guess = nil
	app:on("file", function()
		local f = file_now()
		if f == last_file then return end
		last_file = f
		local guess = f and M.guess_folder(f, function(p)
			local ok, yes = pcall(fs.exists, p)
			return ok and yes
		end)
		if guess and guess == last_guess then return end
		last_guess = guess
		refresh_list()
	end)

	app:bottom({ title = "Run", render = render_panel, on_event = on_event })
	app:command({ id = "symbiosis.run", title = "symbiosis: Run", key = "f5", run = run_chosen })
	app:command({ id = "symbiosis.runStop", title = "symbiosis: Stop the Run", key = "shift+f5", run = stop_current })
	app:command({ id = "symbiosis.runPick", title = "symbiosis: Run Configuration…", key = "ctrl+k f5", run = pick })
	app:command({ id = "symbiosis.runPanel", title = "symbiosis: Focus the Run Panel", key = "ctrl+k shift+f5", run = function() list_runs() reveal(true) end })
	app:command({ id = "symbiosis.runEdit", title = "symbiosis: Edit Run Configurations", run = function() refresh_list(edit_run_json) end })
	app:hint({ key = "F5 · shift+F5", text = "run · stop", order = 95 })
	app:hint({ key = "ctrl+k F5", text = "pick a run configuration", order = 96 })

	M.api = { pick = pick, start = start, stop = stop, runs = function() return runs end, reveal = reveal }
	return M.api
end

return M
