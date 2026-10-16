-- Run configurations, as in Rider and VSCode: F5 runs the chosen
-- configuration, shift+F5 stops it, ctrl+k F5 picks one. The configurations
-- come from .symbiosis/run.json, .vscode/launch.json and tasks.json, the file
-- open, and what the project's files say (package.json scripts, Cargo,
-- go.mod, .csproj, Makefile, ...): core/run/ in TypeScript.
-- A configuration's inputs (${input:id}: a device, a mode) are picked when
-- it starts, in a drawer, when `symbiosis run start` cannot pick them itself.
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

-- The items whose text (hay(item)) has every word of the query, in any
-- case. Keeps their order.
local function filter_by(items, query, hay)
	local words = {}
	for w in tostring(query or ""):lower():gmatch("%S+") do table.insert(words, w) end
	local out = {}
	for _, item in ipairs(items) do
		local text = hay(item):lower()
		local ok = true
		for _, w in ipairs(words) do
			if not text:find(w, 1, true) then ok = false break end
		end
		if ok then table.insert(out, item) end
	end
	return out
end

-- The configs that match a query: every word in the name, the group, the
-- command or what its inputs picked last.
function M.filter(configs, query)
	return filter_by(configs, query, function(c) return c.name .. " " .. c.group .. " " .. (c.line or "") .. " " .. (c.picked or "") end)
end

-- An input's options that match a query: every word in the label, the detail or the value.
function M.filter_options(options, query)
	return filter_by(options, query, function(o) return o.label .. " " .. (o.detail or "") .. " " .. o.value end)
end

-- An input's options as the drawer's list: ▶ the one picked last, ● one up already.
function M.input_items(options, current)
	local items = {}
	for _, o in ipairs(options) do
		table.insert(items, {
			id = o.value,
			label = o.label .. (o.detail and o.detail ~= "" and ("  " .. o.detail) or ""),
			icon = o.value == current and "▶" or (o.ready and "●" or " "),
		})
	end
	return items
end

-- `run start`'s arguments for the inputs picked so far: --input and
-- --input-label, by id (in order, the same every time).
function M.input_args(given, labels)
	local ids = {}
	for id in pairs(given or {}) do table.insert(ids, id) end
	table.sort(ids)
	local args = {}
	for _, id in ipairs(ids) do
		table.insert(args, "--input")
		table.insert(args, id .. "=" .. given[id])
		if labels and labels[id] then
			table.insert(args, "--input-label")
			table.insert(args, id .. "=" .. labels[id])
		end
	end
	return args
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
-- The rows the output takes in a pane `width` wide: a line each, or with
-- wrap, as many as its text needs. Each row: { text, line = its line's index }.
function M.output_rows(lines, width, wrap)
	local rows = {}
	width = math.max(1, width)
	for i, line in ipairs(lines) do
		if not wrap or util.runes(line) <= width then
			table.insert(rows, { text = line, line = i })
		else
			local rest = line
			while rest ~= "" do
				local n = util.rune_bytes(rest, width)
				table.insert(rows, { text = rest:sub(1, n), line = i })
				rest = rest:sub(n + 1)
			end
		end
	end
	return rows
end

-- ttt 1.7 hands a focused plugin panel each event twice, a millisecond apart
-- (ui.WidgetAdapter asks its focus manager, then the panel itself, when the
-- panel says it ignored it, and a plugin panel cannot say otherwise). The
-- function this returns says whether an event is that second copy: the same
-- event within `window` seconds (os.clock: seconds since ttt started).
function M.twice_filter(window)
	window = window or 0.008
	local last, at = nil, -1
	return function(ev, now)
		local sig = table.concat({ tostring(ev.type), tostring(ev.key), tostring(ev.rune), tostring(ev.mod),
			tostring(ev.x), tostring(ev.y), tostring(ev.button) }, "\1")
		local again = sig == last and now - at < window
		last, at = sig, now
		return again
	end
end

-- The runs list's width in a Run panel w wide: the one dragged (wanted),
-- else 28% of it; never so wide or narrow that a pane disappears.
function M.split_width(w, wanted)
	local width = wanted or math.min(28, math.max(16, math.floor(w * 0.28)))
	return math.max(8, math.min(math.floor(width), w - 16))
end

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
			label = c.name .. (c.picked and c.picked ~= "" and (" → " .. c.picked) or "") .. (c.line and c.line ~= "" and ("  " .. c.line) or ""),
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
	local asking = nil        -- { config, ask, opts, items } while an input's drawer is open
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

	local function choose(config, at)
		at = at or folder
		if not at then return end
		chosen_ids[at] = config.id
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

	local ask_input -- the drawer for an input `run start` cannot pick itself

	-- opts: again = the user picks every input again; given, labels = the
	-- inputs decided so far (id -> value, id -> label); folder = the one the
	-- run was asked in (a drawer stays open while another project's file opens).
	local function start(config, opts)
		if busy then return end
		opts = opts or {}
		local at = opts.folder or folder
		busy = true
		choose(config, at)
		local pos = select(2, pcall(editor.cursor))
		local args = { "start", "--folder", at, "--config", config.id, "--file", file_now() or "" }
		if type(pos) == "table" and pos.line then
			table.insert(args, "--line")
			table.insert(args, tostring(pos.line))
		end
		for _, a in ipairs(M.input_args(opts.given, opts.labels)) do table.insert(args, a) end
		if opts.again then table.insert(args, "--ask") end
		cli(args, function(out)
			busy = false
			if not out then return end
			if out.ask then return ask_input(config, out.ask, { again = opts.again, folder = at }) end
			selected, scroll = out.run.id, 0
			-- What its inputs picked, for the picker.
			if out.picked then config.picked = out.picked end
			list_runs()
			reveal()
		end)
	end

	-- F5 that asks again for every input of the chosen configuration.
	local function run_chosen_again()
		local c = chosen()
		if c then return start(c, { again = true }) end
		M.api.pick()
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
		asking = nil
		pcall(ttt.close_drawer)
	end

	-- The drawer for an input: a filter and the options; Enter or a click
	-- picks one, and the run starts again with it (it may ask for the next).
	local function render_input(panel)
		if not asking then return end
		local a = asking
		local function take(option)
			if not option then return end
			close_picker()
			-- The inputs decided before this one come back with the ask: given, they are not listed again.
			local given, labels = {}, {}
			for k, v in pairs(a.ask.given or {}) do given[k] = v end
			for k, v in pairs(a.ask.labels or {}) do labels[k] = v end
			given[a.ask.input.id], labels[a.ask.input.id] = option.value, option.label
			start(a.config, { again = a.opts.again, given = given, labels = labels, folder = a.opts.folder })
		end
		local function by_value(value)
			for _, o in ipairs(a.ask.options) do if o.value == value then return o end end
			return nil
		end
		panel:title("Run " .. util.cut(a.ask.name, 40))
		panel:label({ text = "Pick the " .. a.ask.input.description, style = "bold" })
		panel:input({
			placeholder = "filter",
			on_change = function(text)
				if asking ~= a then return end
				a.items = M.filter_options(a.ask.options, text)
				panel:redraw()
			end,
			on_submit = function() take(a.items[1]) end,
		})
		if #a.items == 0 then panel:label({ text = "None matches.", style = "muted" }) end
		panel:tree({
			items = M.input_items(a.items, a.ask.current),
			on_command = function(command, node)
				if command == "activate" then take(by_value(node and node.id)) end
			end,
		})
		panel:label({ text = "Enter picks the first · ↓ to the list: Enter or a click picks · ▶ picked last · ● up already · Esc", style = "muted", margin_top = 1 })
	end

	ask_input = function(config, ask, opts)
		asking = { config = config, ask = ask, opts = opts, items = ask.options }
		ttt.open_drawer({ width = 64, min_width = 40, side = "right", render = render_input })
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
			key_commands = { s = "save", e = "edit", i = "inputs" },
			-- on_select comes with every move of the selection (the arrows);
			-- Enter and a click are "activate".
			on_command = function(command, node)
				if command == "activate" then
					local c = by_id(node and node.id)
					if not c then return end
					close_picker()
					return start(c)
				end
				if command == "edit" then
					close_picker()
					return edit_run_json()
				end
				if command == "save" then
					local c = by_id(node and node.id)
					close_picker()
					save(c)
				end
				if command == "inputs" then
					local c = by_id(node and node.id)
					if not c then return end
					close_picker()
					start(c, { again = true })
				end
			end,
		})
		for _, p in ipairs(problems) do panel:label({ text = "⚠ " .. p, style = "warning" }) end
		panel:label({ text = "Enter runs the first · ↓ to the list: Enter or a click runs one, i picks its inputs again, s saves it to run.json, e edits run.json · Esc", style = "muted", margin_top = 1 })
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
	-- The runs list's width: dragged at the │ between the panes, kept in run-layout.json.
	local layout_file = app.dir .. "/run-layout.json"
	local split = nil
	local wrap = false -- long output lines: cut at the pane's edge, or wrapped (w)
	local dragging = false
	-- At "ready": ttt's fs answers a plugin only once it has loaded.
	local function load_layout()
		local ok, d = pcall(json.decode, fs.exists(layout_file) and fs.read(layout_file) or "")
		if ok and type(d) == "table" then
			if tonumber(d.left) then split = tonumber(d.left) end
			wrap = d.wrap == true
		end
	end
	local function save_layout() pcall(fs.write, layout_file, json.encode({ left = split, wrap = wrap })) end
	-- The output's rows, made again when the output, the width or wrap change.
	local view = { key = nil, rows = {} }
	local function output_rows(width)
		local key = tostring(tail.id) .. ":" .. tostring(tail.seq) .. ":" .. width .. ":" .. tostring(wrap)
		if view.key ~= key then view = { key = key, rows = M.output_rows(tail.lines, width, wrap) } end
		return view.rows
	end

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
		local left = M.split_width(w, split)
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
		local view_rows = output_rows(ow)
		scroll = math.min(scroll, math.max(0, #view_rows - rows))
		local last = #view_rows - scroll
		local first = math.max(1, last - rows + 1)
		layout.out_top, layout.out_rows, layout.first = 1, rows, first
		local styles = {}
		for i = first, last do
			local row = view_rows[i]
			local st = styles[row.line]
			if not st then
				local line = tail.lines[row.line]
				st = "default"
				if line:find("[Ee]rror") or line:find("FAIL") or line:find("[Ee]xception") then st = "danger"
				elseif line:find("[Ww]arn") then st = "warning" end
				styles[row.line] = st
			end
			M.put(panel, x, 1 + i - first, util.cut(row.text, ow), st)
		end
		local hint = M.live(run) and "s stop · r restart" or "r run again · x remove"
		hint = hint .. " · ↑↓ runs · PgUp/PgDn scroll · w " .. (wrap and "no wrap" or "wrap") .. " · o full log · click a file:line · drag │ to resize · Esc editor"
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

	local function toggle_wrap()
		wrap = not wrap
		scroll = 0
		save_layout()
		redraw()
	end

	local function scroll_by(n)
		local max = math.max(0, #view.rows - layout.out_rows)
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

	local seen_twice = M.twice_filter()

	local function on_event(ev)
		if seen_twice(ev, os.clock()) then return true end
		if ev.type == "key" then
			local k, rune = ev.key, ev.rune
			local run = find_run(selected)
			if k == "Up" or rune == "k" then select_run(1)
			elseif k == "Down" or rune == "j" then select_run(-1)
			elseif k == "PgUp" then scroll_by(math.max(1, layout.out_rows - 1))
			elseif k == "PgDn" then scroll_by(-math.max(1, layout.out_rows - 1))
			elseif k == "Home" then scroll_by(#view.rows)
			elseif rune == "w" then toggle_wrap()
			elseif k == "End" then scroll = 0 redraw()
			elseif k == "Esc" or k == "Escape" then ttt.exec_command("editor.focus")
			elseif rune == "s" then stop(run)
			elseif rune == "r" then again(run)
			elseif rune == "x" and run and not M.live(run) then
				selected = nil
				cli({ "remove", run.id }, function() list_runs() end)
			elseif rune == "o" and run then ttt.open_file(dir .. "/" .. run.id .. "/output.log", 0, true)
			elseif k == "Enter" then
				local rows = view.rows
				for i = #rows - scroll, math.max(1, #rows - scroll - layout.out_rows + 1), -1 do
					if open_ref(tail.lines[rows[i].line]) then break end
				end
			else
				return false
			end
			return true
		elseif ev.type == "mouse" then
			if ev.button == "wheel_up" then scroll_by(3) return true end
			if ev.button == "wheel_down" then scroll_by(-3) return true end
			if ev.button ~= "left" then
				if dragging then
					dragging = false
					save_layout()
					return true
				end
				return false
			end
			if not origin then origin = { M.panel_origin(debug_state()) } end
			if not origin[1] then return true end
			local x, y = ev.x - origin[1], ev.y - origin[2]
			-- The button held down: the │ goes where the mouse is.
			if dragging then
				split = M.split_width(layout.w, x)
				redraw()
				return true
			end
			-- A click focuses the panel: ttt does that only for a panel that
			-- tells it it took the click, which a plugin's cannot.
			ttt.exec_command("panel.focus")
			if #runs > 0 and math.abs(x - layout.left) <= 1 then
				dragging = true
				return true
			end
			if x < layout.left then
				local id = layout.rows[y]
				if id then selected, scroll = id, 0 read_tail() redraw() end
				return true
			end
			local row = view.rows[layout.first + y - layout.out_top]
			if row and y >= layout.out_top and y < layout.out_top + layout.out_rows then open_ref(tail.lines[row.line]) end
			return true
		end
		return false
	end

	-- ctrl+q --------------------------------------------------------------------------

	local quitting = false

	-- ctrl+q while programs run: stop them, keep them, or stay.
	local function ask_quit(live)
		pcall(ttt.close_drawer)
		picker, asking = nil, nil
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
		load_layout()
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
	app:command({ id = "symbiosis.runAsk", title = "symbiosis: Run, Choosing Inputs Again…", run = run_chosen_again })
	app:command({ id = "symbiosis.runPanel", title = "symbiosis: Focus the Run Panel", key = "ctrl+k shift+f5", run = function() list_runs() reveal(true) end })
	app:command({ id = "symbiosis.runWrap", title = "symbiosis: Toggle Wrap in the Run Output", run = toggle_wrap })
	app:command({ id = "symbiosis.runEdit", title = "symbiosis: Edit Run Configurations", run = function() refresh_list(edit_run_json) end })
	app:hint({ key = "F5 · shift+F5", text = "run · stop", order = 95 })
	app:hint({ key = "ctrl+k F5", text = "pick a run configuration", order = 96 })

	M.api = { pick = pick, start = start, stop = stop, runs = function() return runs end, reveal = reveal }
	return M.api
end

return M
