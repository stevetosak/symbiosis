-- features/debug.lua: its pure parts, and the bundle with a debug run's
-- files as the supervisor (launcher/debug.ts) writes them.
local t = require("check")
local stub = require("stub")
local debug_feature = require("features.debug")

local REMOVED = { "print", "load", "loadstring", "loadfile", "dofile", "getfenv", "setfenv", "rawget", "rawset", "module" }
local function load_bundle()
	local chunk = assert(loadfile("ttt/symbiosis/plugin.lua"))
	local env = setmetatable({}, { __index = _G })
	for _, name in ipairs(REMOVED) do env[name] = false end
	env.require = function(name)
		local mod = stub.modules[name]
		if not mod then error("module " .. name .. " is not available") end
		return mod
	end
	setfenv(chunk, env)
	chunk()
	stub.run_timers()
end

local function json() return require("ttt.json") end

local function command(id)
	for _, c in ipairs(stub.registered.commands) do
		if c.id == id then return c.handler() end
	end
	error("no command " .. id)
end

local function calls(sub)
	local out = {}
	for _, e in ipairs(stub.execs) do
		if e.args[1] == "run" and e.args[2] == sub then table.insert(out, e) end
	end
	return out
end

local function answer(sub, out)
	local list = calls(sub)
	out.ok = true
	list[#list].cb({ stdout = json().encode(out) })
end

local function has(list, value)
	for _, v in ipairs(list) do if v == value then return true end end
	return false
end

-- The bundle in /w with app.py open; `run list` answered with its configs.
local function workspace(configs)
	stub.set_text("/w/app.py", "import sys\ndef add(a, b):\n    total = a + b\n    return total\nadd(1, 2)")
	load_bundle()
	answer("list", { folder = "/w", problems = {}, configs = configs or {
		{ id = "saved:app", name = "app", group = "Saved", line = "python3 app.py", debug = "python" },
		{ id = "saved:make", name = "make", group = "Saved", line = "make" },
	} })
end

-- A live debug run r1 of /w, and its view (debug.json).
local function debug_run(view)
	stub.files["/plugin/runs/r1/state.json"] = json().encode({
		id = "r1", name = "app", configId = "saved:app", folder = "/w", line = "python3 app.py", cwd = "/w",
		status = "running", started = os.time() * 1000, seq = 1, t = os.time() * 1000, debug = "python",
	})
	stub.files["/plugin/runs/r1/debug.json"] = json().encode(view)
	stub.run_timers() -- a tick: the runs, then the view
	stub.run_timers()
end

local function paused(line, extra)
	local v = {
		seq = 1, ack = 0, status = "paused", type = "python", adapter = "debugpy",
		stop = { reason = "breakpoint", threadId = 1 },
		threads = { { id = 1, name = "main" } },
		frames = { { id = 2, name = "add", path = "/w/app.py", line = line, column = 1 }, { id = 3, name = "<module>", path = "/w/app.py", line = 5, column = 1 } },
		frame = 0,
		scopes = { { name = "Locals", ref = 5, expensive = false, key = "Locals" }, { name = "Globals", ref = 6, expensive = false, key = "Globals" } },
		vars = { Locals = { { name = "a", value = "1", ref = 0, key = "Locals\ta" }, { name = "items", value = "[1, 2]", ref = 7, key = "Locals\titems" } } },
		expanded = { "Locals" }, breakpoints = {}, evals = {},
	}
	for k, val in pairs(extra or {}) do v[k] = val end
	return v
end

local function cmds()
	local text = stub.files["/plugin/runs/r1/debug-in.json"]
	return text and json().decode(text).cmds or {}
end

return {
	{ "debug: toggle a breakpoint, by line", function()
		local list, on = debug_feature.toggle({ { line = 7 } }, 3, 11)
		t.eq(list, { { line = 3, hash = 11 }, { line = 7 } })
		t.eq(on, true)
		list, on = debug_feature.toggle(list, 7)
		t.eq(list, { { line = 3, hash = 11 } })
		t.eq(on, false)
		t.eq(debug_feature.lines_of(list), { { line = 3 } })
	end },
	{ "debug: the keys of a session; none when it is not live", function()
		local op = debug_feature.key_op
		t.eq(op({ key = "F5" }, "paused"), "continue")
		t.eq(op({ key = "F10", mod = "" }, "paused"), "next")
		t.eq(op({ key = "F11" }, "paused"), "stepIn")
		t.eq(op({ key = "F11", mod = "shift" }, "paused"), "stepOut")
		t.eq(op({ key = "F6" }, "running"), "pause")
		t.eq(op({ key = "F10" }, "running"), nil, "F10 is ttt's menu while it runs")
		t.eq(op({ key = "F5", mod = "shift" }, "paused"), nil, "shift+F5 stops: the run's")
		t.eq(op({ key = "F10" }, nil), nil)
		t.eq(debug_feature.letter_op("u", "paused"), "stepOut")
		t.eq(debug_feature.letter_op("p", "running"), "pause")
		t.eq(debug_feature.letter_op("n", "running"), nil)
	end },
	{ "debug: the variables' rows: watches, scopes, the open ones' children, what waits", function()
		local v = paused(3, { evals = { { expr = "a * 2", value = "2", ref = 0, key = "watch\t0" } } })
		local rows = debug_feature.var_rows(v)
		local texts = {}
		for _, r in ipairs(rows) do table.insert(texts, debug_feature.row_text(r)) end
		t.eq(texts, { "  ◇ a * 2 = 2", "▾ Locals", "    a = 1", "  ▸ items = [1, 2]", "▸ Globals" })
		-- Opened here, not yet by the session: its children wait.
		rows = debug_feature.var_rows(v, { ["Locals\titems"] = { open = true, seq = 3 } })
		texts = {}
		for _, r in ipairs(rows) do table.insert(texts, debug_feature.row_text(r)) end
		t.eq(texts[4], "  ▾ items = [1, 2]")
		t.eq(texts[5], "      …")
		t.eq(debug_feature.var_rows(nil), {})
	end },
	{ "debug: a frame's text and the head of a debug run", function()
		t.eq(debug_feature.frame_text({ name = "add", path = "/w/app.py", line = 3 }), "add  app.py:3")
		t.eq(debug_feature.frame_text({ name = "<native>", line = 0 }), "<native>")
		t.eq(debug_feature.state_text(paused(3)), "paused on breakpoint · app.py:3")
		t.eq(debug_feature.state_text(paused(3, { stop = { reason = "exception", text = "ZeroDivisionError: division by zero", threadId = 1 } })),
			"paused on exception · app.py:3 · ZeroDivisionError: division by zero")
		t.eq(debug_feature.state_text({ status = "running" }), "running")
		t.eq(debug_feature.state_text(nil), "starting the debugger")
	end },
	{ "debug bundle: F9 sets a breakpoint (◉, breakpoints.json), F9 again takes it off; a click on ◉ too", function()
		workspace()
		stub.cursor = { line = 3, col = 1 }
		command("symbiosis.debugToggleBreakpoint")
		local saved = json().decode(stub.files["/plugin/breakpoints.json"])
		t.eq(#saved.files["/w/app.py"], 1)
		t.eq(saved.files["/w/app.py"][1].line, 3)
		t.eq(stub.marks[3], { icon = "◉", style = "danger" })
		command("symbiosis.debugToggleBreakpoint")
		t.eq(stub.marks[3], nil)
		t.eq(json().decode(stub.files["/plugin/breakpoints.json"]).files["/w/app.py"], nil)
		command("symbiosis.debugToggleBreakpoint")
		stub.fire("gutter.click", "/w/app.py", 3)
		t.eq(stub.marks[3], nil, "a click on the mark took it off")
	end },
	{ "debug bundle: a breakpoint follows its line when lines come above it", function()
		workspace()
		stub.cursor = { line = 3, col = 1 }
		command("symbiosis.debugToggleBreakpoint")
		stub.set_text("/w/app.py", "import sys\n\n\ndef add(a, b):\n    total = a + b\n    return total\nadd(1, 2)")
		stub.events["editor.change"]()
		stub.run_timers()
		t.eq(json().decode(stub.files["/plugin/breakpoints.json"]).files["/w/app.py"][1].line, 5)
		t.eq(stub.marks[5].icon, "◉")
	end },
	{ "debug bundle: a stop: ▶ on its line, the cursor there, the status bar; F10 steps, F5 continues", function()
		workspace()
		stub.cursor = { line = 3, col = 1 }
		command("symbiosis.debugToggleBreakpoint")
		stub.cursor = { line = 1, col = 1 }
		debug_run(paused(3))
		t.eq(stub.marks[3], { icon = "▶", style = "warning" }, "▶ takes the breakpoint's line")
		t.eq(stub.cursor.line, 3, "the editor went to the line")
		t.ok(stub.status["symbiosis.debug"]:find("⏸ app.py:3", 1, true), stub.status["symbiosis.debug"])
		-- F10: the key hook takes it before ttt's menu.
		t.eq(stub.events["key.press"]({ key = "F10", type = "key" }), true)
		t.eq(cmds(), { { seq = 1, op = "next" } })
		-- The session did it and stopped on line 4: the breakpoint's mark comes back.
		stub.files["/plugin/runs/r1/debug.json"] = json().encode(paused(4, { seq = 2, ack = 1, stop = { reason = "step", threadId = 1 } }))
		stub.run_timers()
		t.eq(stub.marks[4].icon, "▶")
		t.eq(stub.marks[3].icon, "◉")
		t.eq(stub.events["key.press"]({ key = "F5", type = "key" }), true)
		t.eq(cmds(), { { seq = 2, op = "continue" } }, "the acked command is not sent again")
		-- Running: F10 is ttt's again, F6 pauses.
		stub.files["/plugin/runs/r1/debug.json"] = json().encode({ seq = 3, ack = 2, status = "running", frames = {}, scopes = {}, vars = {}, expanded = {}, breakpoints = {}, evals = {} })
		stub.run_timers()
		t.eq(stub.marks[4], nil)
		t.eq(stub.status["symbiosis.debug"], nil)
		t.eq(stub.events["key.press"]({ key = "F10", type = "key" }), false)
		t.eq(stub.events["key.press"]({ key = "F6", type = "key" }), true)
		t.eq(cmds()[1].op, "pause")
	end },
	{ "debug bundle: no session: F5 runs, F10 is ttt's; F5 as the run's command continues a paused one", function()
		workspace()
		t.eq(stub.events["key.press"]({ key = "F10", type = "key" }), false)
		debug_run(paused(3))
		command("symbiosis.run") -- F5 from the Run panel, where the key hook does not see keys
		t.eq(cmds(), { { seq = 1, op = "continue" } })
		t.eq(#calls("start"), 0, "it did not run the configuration again")
	end },
	{ "debug bundle: a breakpoint set while a session runs goes to it", function()
		workspace()
		debug_run(paused(4))
		stub.cursor = { line = 2, col = 1 }
		command("symbiosis.debugToggleBreakpoint")
		local c = cmds()[1]
		t.eq(c.op, "breakpoints")
		t.eq(c.path, "/w/app.py")
		t.eq(c.lines, { { line = 2 } })
	end },
	{ "debug bundle: shift+F9 debugs the chosen configuration; with none that can be, the Debug picker", function()
		workspace()
		command("symbiosis.debug")
		answer("list", { folder = "/w", problems = {}, configs = {
			{ id = "saved:app", name = "app", group = "Saved", line = "python3 app.py", debug = "python" },
			{ id = "saved:make", name = "make", group = "Saved", line = "make" },
		} })
		local title, tree
		stub.drawer.render(setmetatable({}, { __index = function(_, m)
			return function(_, arg)
				if m == "title" then title = arg end
				if m == "tree" then tree = arg end
				if m == "size" then return 60, 30 end
			end
		end }))
		t.eq(title, "Debug")
		t.eq(#tree.items, 1)
		t.eq(#tree.items[1].children, 1, "make cannot be debugged: not listed")
		tree.on_command("activate", tree.items[1].children[1])
		local start = calls("start")
		t.ok(has(start[1].args, "--debug"))
		t.ok(has(start[1].args, "saved:app"))
		-- Now app is chosen: shift+F9 debugs it at once.
		answer("start", { run = { id = "r9" } })
		command("symbiosis.debug")
		t.ok(has(calls("start")[2].args, "--debug"))
	end },
	{ "debug bundle: the Run panel shows a paused run's stack and variables; its letters", function()
		workspace()
		debug_run(paused(3))
		-- A screen: ttt's panel:text stops short of the right edge, so run.put draws cells there.
		local grid
		local panel = {}
		function panel:size() return 120, 12 end
		function panel:cell(x, y, ch)
			grid[y] = grid[y] or {}
			grid[y][x] = ch
		end
		function panel:text(x, y, text)
			local col = x
			for ch in text:gmatch("[^\128-\191][\128-\191]*") do self:cell(col, y, ch) col = col + 1 end
		end
		function panel:redraw() end
		local function screen()
			grid = {}
			stub.registered.bottom.render(panel)
			local lines = {}
			for y = 0, 11 do
				local row = {}
				for x = 0, 119 do row[#row + 1] = (grid[y] or {})[x] or " " end
				lines[#lines + 1] = table.concat(row)
			end
			return table.concat(lines, "\n")
		end
		local all = screen()
		t.ok(all:find("app · paused on breakpoint · app.py:3", 1, true), all)
		t.ok(all:find("CALL STACK", 1, true))
		t.ok(all:find("› add  app.py:3", 1, true))
		t.ok(all:find("▾ Locals", 1, true))
		t.ok(all:find("▸ items = [1, 2]", 1, true))
		local key = function(ev) ev.type = "key" return stub.registered.bottom.on_event(ev) end
		t.eq(key({ rune = "n" }), true)
		t.eq(cmds()[1].op, "next")
		-- Tab to the variables, down to items, Enter opens it.
		-- (The Run panel drops an event the same as the one before it within 8 ms:
		-- ttt hands a panel each event twice. So Down, then j.) Locals, a, items.
		key({ key = "Tab" })
		key({ key = "Down" })
		key({ rune = "j" })
		key({ key = "Enter" })
		local last = cmds()[#cmds()]
		t.eq({ last.op, last.key }, { "expand", "Locals\titems" })
		-- v: the output instead, and back.
		key({ rune = "v" })
		t.ok(not screen():find("CALL STACK", 1, true), "v shows the output")
	end },
}
