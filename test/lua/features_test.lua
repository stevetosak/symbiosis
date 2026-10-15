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
		for _, id in ipairs({ "togglePin", "goToAgent", "nextSession", "goToSession", "showPlan", "showChanges", "slower", "faster", "pause", "rush", "help", "stop" }) do
			t.ok(ids["symbiosis." .. id], id)
		end
		t.eq(#reg.commands, 12)
		t.eq(keys, {
			["ctrl+k a"] = "symbiosis.togglePin", ["ctrl+k n"] = "symbiosis.nextSession", ["ctrl+k g"] = "symbiosis.goToSession",
			["ctrl+k v"] = "symbiosis.showPlan", ["ctrl+k w"] = "symbiosis.showChanges", ["ctrl+k -"] = "symbiosis.slower",
			["ctrl+k ="] = "symbiosis.faster", ["ctrl+k space"] = "symbiosis.pause", ["ctrl+k ."] = "symbiosis.rush",
			["ctrl+k h"] = "symbiosis.help", ["ctrl+k q"] = "symbiosis.stop",
		})
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
			"Replay speed    160/s", "pi ahead (max)  3 changes", "Autosave        1 s after you type", "Editor          follows pi",
			"ctrl+k h", "ctrl+k q", "ctrl+k a", "ctrl+k - / =", "ctrl+k space", "ctrl+k .", "ctrl+k v", "ctrl+k w",
			"// … helpi!", "Esc", "ctrl+k n", "ctrl+k g",
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
}
