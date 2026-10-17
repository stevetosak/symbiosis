-- The features' pure parts, and the whole bundle under the stub.
local t = require("check")
local stub = require("stub")

-- The bundle as ttt runs it: ttt/symbiosis/plugin.lua, with ttt's modules
-- from the stub (the bundle's own require falls back to the global one).
-- The globals ttt's sandbox takes away: the bundle must not use them.
local REMOVED = { "print", "load", "loadstring", "loadfile", "dofile", "getfenv", "setfenv", "rawget", "rawset", "module" }
local function load_bundle()
	local chunk = assert(loadfile("ttt/symbiosis/plugin.lua"))
	local env = setmetatable({}, { __index = _G })
	for _, name in ipairs(REMOVED) do env[name] = false end
	-- Not nil: false hides _G's value; calling it fails as in ttt.
	env.require = function(name)
		local mod = stub.modules[name]
		if not mod then error("module " .. name .. " is not available") end
		return mod
	end
	setfenv(chunk, env)
	chunk()
	stub.run_timers() -- the ready timeout
end

-- A live pi session for /w, the one the editor follows.
local function session(fields)
	local json = require("ttt.json")
	local rec = { id = "s1", t = os.time(), cwd = "/w", name = "w", version = require("core.channel").PROTOCOL, active = 1 }
	for k, v in pairs(fields or {}) do rec[k] = v end
	stub.files["/plugin/sessions/s1.json"] = json.encode(rec)
end

local function send(events)
	local json = require("ttt.json")
	local log = stub.files["/plugin/events.jsonl"] or ""
	for _, ev in ipairs(events) do log = log .. json.encode(ev) .. "\n" end
	stub.files["/plugin/events.jsonl"] = log
	stub.files["/plugin/head.json"] = json.encode({ gen = "g1", size = #log })
end

return {
	{ "helpi: the question, the mark, the answer", function()
		local helpi = require("features.helpi")
		local q = helpi.helpi("  // why? helpi!")
		t.eq({ q.opener, q.col, q.indent }, { "//", 3, "  " })
		t.eq(helpi.helpi("/* why? helpi! */").opener, "/*")
		t.eq(helpi.helpi("<!-- why helpi! -->").opener, "<!--")
		t.eq(helpi.helpi("x = helpi!"), nil, "no comment")
		t.eq(helpi.helpi("// why helpi"), nil)
		t.eq(helpi.unmark("// why? helpi!"), "// why?")
		local h = { kind = "note", indent = "  ", opener = "/*" }
		t.eq(helpi.render(h, "one\ntwo", false), "\n  /* pi: one */\n  /* two")
		t.eq(helpi.render(h, "one\ntwo", true), "\n  /* pi: one */\n  /* two */")
		t.eq(helpi.render({ kind = "code", indent = "\t" }, "a()\n\nb()", true), "a()\n\n\tb()")
		t.eq({ helpi.import_at({ "package x", "import a", "import b", "", "code" }) }, { 3, 1 })
	end },
	{ "plan: the line in the status bar", function()
		local plan = require("features.plan")
		t.eq(plan.plan_line({}), nil)
		t.eq(plan.plan_line({ { state = "done", text = "a" } }), "✓ 1 done")
		t.eq(plan.plan_line({ { state = "done", text = "a" }, { state = "now", text = "b" }, { state = "next", text = "c" } }), "✓ 1 › ▶ b › c")
	end },
	{ "sessions: which one the editor follows", function()
		local pick = require("features.sessions").pick
		local a = { id = "a", cwd = "/w", active = 1 }
		local b = { id = "b", cwd = "/w/sub", active = 0 }
		local c = { id = "c", cwd = "/x", active = 5, files = { "/w/sub/f.ts" } }
		t.eq({ pick({ a, b }, nil, "/w/sub/f.ts") }, { b, false, false }, "the deepest folder")
		t.eq({ pick({ a, b, c }, nil, "/w/sub/f.ts") }, { c, false, false }, "the one that wrote it")
		t.eq({ pick({ a, b }, nil, "/y/f.ts") }, { a, true, false }, "else the most recent")
		t.eq({ pick({ a, b }, "b", "/y/f.ts") }, { b, false, true }, "the chosen one")
	end },
	{ "tree: files under their session's folder", function()
		local build = require("features.tree").build
		local items, paths = build({ { id = "s", name = "pi", cwd = "/w", files = { "/w/src/a.ts", "/elsewhere/b.ts" } } }, { id = "s" }, "/w/src/a.ts")
		t.eq(#items, 1)
		t.eq(items[1].label, "▶ pi")
		t.eq(paths["s|/w/src/a.ts"], "/w/src/a.ts")
		local labels = {}
		for _, n in ipairs(items[1].children) do table.insert(labels, n.label) end
		t.eq(labels, { "/elsewhere/", "src/" }, "folders, by name")
	end },
	{ "bundle: registers every command and key, no feature off", function()
		load_bundle()
		local reg = stub.registered
		local ids, keys = {}, {}
		for _, c in ipairs(reg.commands) do ids[c.id] = true end
		for _, k in ipairs(reg.keybindings) do keys[k.key] = k.command end
		for _, id in ipairs({ "togglePin", "goToAgent", "nextSession", "goToSession", "showPlan", "showChanges", "slower", "faster", "pause", "rush", "help", "stop", "fillStub", "releaseStub", "showProposal", "ask", "notes", "run", "runStop", "runPick", "runPanel", "runWrap", "runEdit", "runAsk" }) do
			t.ok(ids["symbiosis." .. id], id)
		end
		t.eq(#reg.commands, 24)
		t.eq(keys, {
			["ctrl+k a"] = "symbiosis.togglePin", ["ctrl+k n"] = "symbiosis.nextSession", ["ctrl+k g"] = "symbiosis.goToSession",
			["ctrl+k v"] = "symbiosis.showPlan", ["ctrl+k w"] = "symbiosis.showChanges", ["ctrl+k -"] = "symbiosis.slower",
			["ctrl+k ="] = "symbiosis.faster", ["ctrl+k space"] = "symbiosis.pause", ["ctrl+k ."] = "symbiosis.rush",
			["ctrl+k h"] = "symbiosis.help", ["ctrl+k q"] = "symbiosis.stop", ["ctrl+k f"] = "symbiosis.fillStub", ["ctrl+k p"] = "symbiosis.showProposal", ["ctrl+k d"] = "symbiosis.ask",
			["f5"] = "symbiosis.run", ["shift+f5"] = "symbiosis.runStop", ["ctrl+k f5"] = "symbiosis.runPick", ["ctrl+k shift+f5"] = "symbiosis.runPanel",
		})
		t.eq(reg.bottom.title, "Run")
		t.eq(reg.sidebar.title, "pi files")
		t.eq(stub.notices, {}, "no feature is off")
		t.eq(stub.status.symbiosis, "pi · following")
		t.eq(stub.status["symbiosis.speed"], "▶ 160/s")
	end },
	{ "bundle: the panel lists the settings and the keys in order", function()
		load_bundle()
		for _, c in ipairs(stub.registered.commands) do
			if c.id == "symbiosis.help" then c.handler() end
		end
		local out = {}
		local panel = setmetatable({}, { __index = function(_, method)
			return function(_, arg)
				if method == "list" and arg.items[1].id == "speed" then
					for _, it in ipairs(arg.items) do table.insert(out, it.label) end
				elseif method == "keyvalue" then
					for _, kv in ipairs(arg) do table.insert(out, kv.key) end
				end
			end
		end })
		stub.drawer.render(panel)
		t.eq(out, {
			"Replay speed    160/s", "pi ahead (max)  3 changes", "Stub scope      the stub's body", "Autosave        1 s after you type", "Editor          follows pi",
			"ctrl+k h", "ctrl+k q", "ctrl+k a", "ctrl+k - / =", "ctrl+k space", "ctrl+k .", "ctrl+k v", "ctrl+k d", "ctrl+k w",
			"// … helpi!", "// … why!", "// TODO(pi) helpi!", "ctrl+k p", "F5 · shift+F5", "ctrl+k F5", "Esc", "ctrl+k n", "ctrl+k g",
		})
	end },
	{ "bundle: a write is typed at the speed, acknowledged, then the file comes from disk", function()
		local util = require("core.util")
		load_bundle()
		stub.run_timers() -- a tick with no log: what comes next is new
		stub.set_text("/w/a.ts", "old")
		send({
			{ op = "start", call = "c1", tool = "write", path = "/w/a.ts", sum = util.adler32("old") },
			{ op = "text", call = "c1", key = "content", from = 0, text = "brand new text here" },
			{ op = "ready", call = "c1" },
			{ op = "done", call = "c1", path = "/w/a.ts", line = 1, ok = true, sum = util.adler32("brand new text here") },
		})
		stub.run_timers()
		-- 160 characters a second, 40 ms a tick: 6.4 characters a tick, and
		-- the tick before saved up its 6.4.
		t.eq(stub.text(), "brand new te")
		t.eq(stub.groups, 1, "one undo group")
		t.eq(stub.files["/plugin/ack.json"], nil, "not acknowledged before it is shown")
		stub.run_timers()
		t.eq(stub.text(), "brand new text here")
		local json = require("ttt.json")
		t.eq(json.decode(stub.files["/plugin/ack.json"]), { "c1" })
		t.eq(stub.groups, 0)
		t.eq(stub.commands, { "editor.undo", "tab.close" }, "the preview goes, the file opens again")
		t.eq(stub.status.symbiosis, "pi ✎ a.ts:1 · following")
	end },
	{ "bundle: typing waits while the replay runs in the file", function()
		local util = require("core.util")
		load_bundle()
		stub.run_timers()
		stub.set_text("/w/a.ts", "old")
		send({
			{ op = "start", call = "c1", tool = "write", path = "/w/a.ts", sum = util.adler32("old") },
			{ op = "text", call = "c1", key = "content", from = 0, text = "a long text that takes a while" },
		})
		stub.run_timers()
		t.eq(stub.events["key.press"]({ rune = "x" }), true, "your key waits")
		t.eq(stub.events["key.press"]({ key = "Up" }), false, "a move goes")
		t.ok(stub.status.symbiosis:find("your typing waits", 1, true), "the bar says so")
	end },
	{ "marker: fill! and helpi! at the end of a comment", function()
		local marker = require("core.marker")
		t.eq(marker.find("\t// TODO(pi) fill!", "fill!").opener, "//")
		t.eq(marker.find("# TODO(pi) fill! ", "fill!").opener, "#")
		t.eq(marker.find("/* TODO(pi) fill! */", "fill!").opener, "/*")
		t.eq(marker.find("fill!", "fill!"), nil, "no comment")
		t.eq(marker.find("// fill!x", "fill!"), nil)
		t.eq(marker.find("// TODO(pi) fill", "fill!"), nil)
		t.eq(marker.strip("\t// TODO(pi) fill!", "fill!"), "\t// TODO(pi)")
		t.eq(marker.strip("/* TODO(pi) fill! */", "fill!"), "/* TODO(pi) */")
		t.eq(marker.find("// TODO: refill!", "fill!"), nil, "a word of its own")
		t.eq(marker.strip("// TODO: refill!", "fill!"), "// TODO: refill!")
		t.eq(marker.find("// TODO(pi):fill!", "fill!").opener, "//")
	end },
	{ "bundle: helpi! on a stub's marker asks no model: it saves the file and asks for the fill", function()
		local json = require("ttt.json")
		load_bundle()
		session()
		stub.set_text("/w/a.ts", "function f() {\n\t// TODO(pi) helpi!\n}")
		stub.cursor = { line = 2, col = 19 }
		stub.run_timers() -- the sessions refresh
		stub.events["editor.change"]()
		stub.run_timers() -- the helpi! timer
		t.eq(stub.text(), "function f() {\n\t// TODO(pi)\n}", "the marker goes")
		t.eq(stub.files["/plugin/help.json"], nil, "no side call")
		stub.run_timers() -- the tick sends it, the file is saved
		local req = json.decode(stub.files["/plugin/fill.json"])
		t.eq({ req.to, req.mode, req.path, req.line, req.release }, { "s1", "stub", "/w/a.ts", 2, false })
		t.eq(stub.files["/w/a.ts"], stub.text(), "saved first")
		t.eq(#stub.notices, 1, "no warning: " .. tostring(stub.notices[1] and stub.notices[1].text))
		session({ fill = { kind = "stub", path = "/w/a.ts", name = "f", line = 1 }, working = true })
		stub.run_timers()
		t.ok(stub.status["symbiosis.session"]:find("filling f", 1, true), stub.status["symbiosis.session"])
	end },
	{ "bundle: helpi! answered `function`: the marker goes, nothing under the description, pi writes it", function()
		local json = require("ttt.json")
		load_bundle()
		session()
		stub.set_text("/w/a.ts", "const a = 1;\n\n// clamp n to 0..3 helpi!\n\nexport const b = 2;")
		stub.cursor = { line = 3, col = 25 }
		stub.run_timers()
		stub.events["editor.change"]()
		stub.run_timers() -- the helpi! timer: the side call is asked
		local q = json.decode(stub.files["/plugin/help.json"])
		send({ { op = "help", id = q.id, session = "s1" }, { op = "help_start", id = q.id, kind = "function", imports = {} }, { op = "help_done", id = q.id, text = "" } })
		stub.run_timers()
		stub.run_timers()
		t.eq(stub.text(), "const a = 1;\n\n// clamp n to 0..3\n\nexport const b = 2;", "only the marker goes")
		local req = json.decode(stub.files["/plugin/fill.json"])
		t.eq({ req.mode, req.path, req.line }, { "function", "/w/a.ts", 3 })
		t.ok(stub.notices[#stub.notices].text:find("pi writes the function described at line 3 of a.ts", 1, true), stub.notices[#stub.notices].text)
		session({ fill = { kind = "place", path = "/w/a.ts", name = "clamp", line = 3 }, working = true })
		stub.run_timers()
		t.ok(stub.status["symbiosis.session"]:find("writing clamp", 1, true), stub.status["symbiosis.session"])
	end },
	{ "bundle: a fill waits for the save, not for what is typed after it", function()
		local json = require("ttt.json")
		load_bundle()
		session()
		stub.set_text("/w/a.ts", "function f() {\n\t// TODO(pi) helpi!\n}")
		stub.cursor = { line = 2, col = 19 }
		stub.run_timers()
		-- This save is slow, and writes a final newline.
		stub.save = function(text) stub.saved_later = text .. "\n" end
		stub.events["editor.change"]()
		stub.run_timers() -- helpi!: the save starts
		stub.run_timers() -- a tick: not on disk yet
		t.eq(stub.files["/plugin/fill.json"], nil, "waits for the save")
		stub.files["/w/a.ts"] = stub.saved_later
		stub.set_text("/w/a.ts", stub.text() .. "\n// typed after helpi!")
		stub.run_timers()
		t.eq(json.decode(stub.files["/plugin/fill.json"]).line, 2)
		for _, n in ipairs(stub.notices) do t.ok(not n.text:find("did not save", 1, true), n.text) end
	end },
	{ "bundle: propose_end closes only the proposal's drawer", function()
		load_bundle()
		session()
		stub.set_text("/w/a.ts", "x")
		stub.run_timers()
		send({ { op = "propose", id = "p1", session = "s1", kind = "new_file", target = "/w/b.ts", what = "b", why = "c" } })
		stub.run_timers()
		stub.drawer = nil -- Esc
		for _, c in ipairs(stub.registered.commands) do
			if c.id == "symbiosis.help" then c.handler() end
		end
		local panel = stub.drawer
		t.ok(panel ~= nil, "the panel is open")
		send({ { op = "propose_end", id = "p1" } })
		stub.run_timers()
		t.eq(stub.drawer, panel, "the panel stays")
		t.eq(stub.status["symbiosis.proposal"], nil)
	end },
	{ "bundle: a proposal: Enter in the note accepts, Esc leaves it waiting, propose_end ends it", function()
		local json = require("ttt.json")
		load_bundle()
		session()
		stub.set_text("/w/a.ts", "x")
		stub.run_timers()
		send({ { op = "propose", id = "p1", session = "s1", kind = "dependency", target = "lodash", what = "import lodash", why = "its helper" } })
		stub.run_timers()
		-- The drawer's widgets, by kind.
		local function widgets()
			local w = { label = {}, button = {} }
			stub.drawer.render(setmetatable({}, { __index = function(_, m)
				return function(_, arg)
					if m == "label" then table.insert(w.label, arg.text)
					elseif m == "button" then table.insert(w.button, arg)
					elseif m == "input" then w.input = arg end
				end
			end }))
			return w
		end
		local w = widgets()
		t.eq(w.label[1], "import lodash")
		t.eq(stub.status["symbiosis.proposal"], "? pi proposes a new dependency")
		stub.drawer = nil -- Esc: ttt closes the drawer, the plugin is not told
		for _, c in ipairs(stub.registered.commands) do
			if c.id == "symbiosis.showProposal" then c.handler() end
		end
		w = widgets()
		w.input.on_change("fine")
		w.input.on_submit("fine")
		t.eq(json.decode(stub.files["/plugin/answer.json"]), { id = "p1", accept = true, note = "fine" })
		t.eq({ stub.drawer, stub.status["symbiosis.proposal"] }, { nil, nil })

		send({ { op = "propose", id = "p2", session = "s1", kind = "new_file", target = "/w/b.ts", what = "b", why = "c" } })
		stub.run_timers()
		widgets().button[2].on_click()
		t.eq(json.decode(stub.files["/plugin/answer.json"]), { id = "p2", accept = false, note = "" })

		send({ { op = "propose", id = "p3", session = "s1", kind = "new_file", target = "/w/b.ts", what = "b", why = "c" } })
		stub.run_timers()
		send({ { op = "propose_end", id = "p3" } })
		stub.run_timers()
		t.eq({ stub.drawer, stub.status["symbiosis.proposal"] }, { nil, nil }, "stopped: no question left")
		send({ { op = "propose", id = "p4", session = "other", kind = "new_file", target = "/w/b.ts", what = "b", why = "c" } })
		stub.run_timers()
		t.eq(stub.drawer, nil, "another session's proposal is not shown")
	end },
	{ "bundle: the why of a change shows when the replay shows it; pi's notices show", function()
		local util = require("core.util")
		load_bundle()
		stub.run_timers()
		stub.set_text("/w/a.ts", "old")
		send({ { op = "done", call = "c1", tool = "edit", path = "/w/a.ts", line = 1, ok = true, sum = util.adler32("old"), why = "small files" } })
		stub.run_timers()
		t.eq(stub.notices[#stub.notices].text, "pi, why (a.ts): small files")
		send({ { op = "notice", text = "symbiosis: no stub at line 1", level = "warn" } })
		stub.run_timers()
		t.eq(stub.notices[#stub.notices], { text = "symbiosis: no stub at line 1", level = "warning" })
	end },
}
