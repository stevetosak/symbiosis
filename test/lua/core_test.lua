-- core/util, core/settings, core/channel, core/app.
local t = require("check")
local stub = require("stub")

local function new_app()
	local app = require("core.app").new({ dir = "/plugin", log = function(level, message) table.insert(stub.logs, { level = level, message = message }) end })
	return app
end

return {
	{ "util: runes, positions, prefix", function()
		local util = require("core.util")
		t.eq(util.runes("añb"), 3)
		t.eq({ util.after(1, 1, "ab\ncd") }, { 2, 3 })
		t.eq({ util.position("ab\ncd", 4) }, { 2, 1 })
		t.eq(util.prefix("añb", "añc"), 3)
		t.eq(util.prefix("añ", "aó"), 1, "not inside a character")
		t.eq(util.rune_bytes("añb", 2), 3)
		t.eq(util.adler32("Wikipedia"), 300286872)
	end },
	{ "util: lines, split, paths, cut", function()
		local util = require("core.util")
		local got = {}
		for l in util.lines("a\n\nb") do table.insert(got, l) end
		t.eq(got, { "a\n", "\n" }, "a line pi is still writing waits")
		t.eq(util.split("a\nb\n"), { "a", "b" })
		t.eq(util.split(nil), {})
		t.eq(util.name("/w/x/a.ts"), "a.ts")
		t.eq(util.short("/Users/me/w"), "~/w")
		t.eq(util.short("/home/me/w"), "~/w")
		t.eq(util.split_path("a/b/c"), { "a", "b", "c" })
		t.eq(util.cut("abcdef", 4), "abc…")
	end },
	{ "util: keys that change the buffer", function()
		local util = require("core.util")
		t.ok(util.edits_text({ rune = "x" }), "a character")
		t.ok(util.edits_text({ key = "Enter" }), "Enter")
		t.ok(not util.edits_text({ key = "Up" }), "a move")
		t.ok(not util.edits_text({ rune = "x", mod = "ctrl" }), "ctrl+x is not text")
		t.ok(util.changes_buffer({ rune = "x", mod = "ctrl" }), "ctrl+x cuts")
		t.ok(not util.changes_buffer({ rune = "f", mod = "ctrl" }), "ctrl+f")
	end },
	{ "settings: define, step, cycle, save, load", function()
		local settings = require("core.settings")
		local s = settings.new("/plugin/settings.json", function() return "f" end)
		local seen = {}
		s:define("speed", { values = { 10, 20, 0 }, default = 2, label = "Speed", order = 20, steps = true, on_change = function(v) table.insert(seen, v) end })
		s:define("pin", { values = { false, true }, label = "Pin", order = 10, persist = false })
		s:define("hidden", { values = { "a", "b" } })
		t.eq(s:get("speed"), 20)
		s:step("speed", 5)
		t.eq(s:get("speed"), 0, "no step past the end")
		s:cycle("speed")
		t.eq(s:get("speed"), 10, "cycle wraps")
		t.eq(seen, { 0, 10 })
		local shown = {}
		for _, def in ipairs(s:shown()) do table.insert(shown, def.key) end
		t.eq(shown, { "pin", "speed" }, "labelled, in order")
		s:cycle("pin")
		local saved = require("ttt.json").decode(stub.files["/plugin/settings.json"])
		t.eq(saved, { speed = 10, hidden = "a" }, "pin is not kept")
		t.raises(function() s:define("speed", { values = { 1 } }) end, "defined twice")

		stub.files["/plugin/settings.json"] = require("ttt.json").encode({ speed = 0, other = 5, hidden = "zz" })
		local s2 = settings.new("/plugin/settings.json")
		s2:define("speed", { values = { 10, 20, 0 }, default = 2 })
		s2:define("hidden", { values = { "a", "b" } })
		s2:load()
		t.eq(s2:get("speed"), 0)
		t.eq(s2:get("hidden"), "a", "an unknown value keeps the default")
		s2:save()
		t.eq(require("ttt.json").decode(stub.files["/plugin/settings.json"]).other, 5, "unknown keys stay")
	end },
	{ "app: a feature closes only its own drawer; no id closes any", function()
		local app = new_app()
		app:open_drawer("proposal", { render = "proposal" })
		app:open_drawer("run", { render = "run" })
		app:close_drawer("proposal")
		t.eq(stub.drawer and stub.drawer.render, "run", "the run picker stays")
		app:close_drawer("run")
		t.eq(stub.drawer, nil)
		app:open_drawer("proposal", { render = "proposal" })
		app:close_drawer()
		t.eq(stub.drawer, nil, "ctrl+q closes whatever is open")
	end },
	{ "channel: skips history, dispatches new events, one handler per op", function()
		local json = require("ttt.json")
		local channel = require("core.channel")
		local c = channel.new("/plugin", function() end, function() return "f" end)
		local got = {}
		c:on("start", function(ev) table.insert(got, ev.call) end)
		t.raises(function() c:on("start", function() end) end, "taken by f")
		local log = json.encode({ op = "start", call = "old" }) .. "\n"
		stub.files["/plugin/events.jsonl"] = log
		stub.files["/plugin/head.json"] = json.encode({ gen = "g1", size = #log })
		c:poll()
		t.eq(got, {}, "the log before ttt started is history")
		log = log .. json.encode({ op = "start", call = "new" }) .. "\n" .. json.encode({ op = "nobody", call = "x" }) .. "\n"
		stub.files["/plugin/events.jsonl"] = log
		stub.files["/plugin/head.json"] = json.encode({ gen = "g1", size = #log })
		c:poll()
		t.eq(got, { "new" })
		-- A new log (pi started again): read from its start.
		log = json.encode({ op = "start", call = "second" }) .. "\n"
		stub.files["/plugin/events.jsonl"] = log
		stub.files["/plugin/head.json"] = json.encode({ gen = "g2", size = #log })
		c:poll()
		t.eq(got, { "new", "second" })
		c:heartbeat_field(function(rec) rec.lag = 3 end)
		c:heartbeat()
		t.eq(json.decode(stub.files["/plugin/ttt.json"]).lag, 3)
	end },
	{ "app: features set up after the ones they need", function()
		local app = new_app()
		local order = {}
		app:use({ name = "b", needs = { "a" }, setup = function(a) table.insert(order, "b") return { x = a:need("a").x + 1 } end })
		app:use({ name = "a", setup = function() table.insert(order, "a") return { x = 1 } end })
		app:use({ name = "c", setup = function() table.insert(order, "c") end })
		app:setup()
		t.eq(order, { "a", "b", "c" })
		t.eq(app:get("b").x, 2)
		t.eq(app:get("c"), {}, "no api: an empty one")
		t.eq(app:get("nope"), nil)
	end },
	{ "app: a missing need, a cycle, a module that does not load: those features are off, the others run", function()
		local app = new_app()
		local ran = {}
		app:use({ name = "a", needs = { "zz" }, setup = function() table.insert(ran, "a") end })
		app:use({ name = "b", needs = { "c" }, setup = function() table.insert(ran, "b") end })
		app:use({ name = "c", needs = { "b" }, setup = function() table.insert(ran, "c") end })
		app:use("features.nothing_here")
		app:use({ name = "d", needs = { "nothing_here" }, setup = function() table.insert(ran, "d") end })
		app:use({ name = "e", setup = function() table.insert(ran, "e") end })
		local failed = app:setup()
		t.eq(ran, { "e" })
		t.eq(failed.a, "needs zz, which is not used")
		t.ok(failed.b and failed.c, "the cycle")
		t.ok(failed.nothing_here:find("nothing_here", 1, true), "the module")
		t.eq(failed.d, "needs nothing_here, which failed")
		t.raises(function() app:use({ name = "e", setup = function() end }) end, "used twice")
		t.raises(function() app:use({ name = "x" }) end, "setup function")
	end },
	{ "app: a dropped feature's holds go from the features that keep them", function()
		local app = new_app()
		local kept = {}
		app:use({ name = "keeper", setup = function(a)
			a:on("drop", function(name) kept[name] = nil end)
			return { keep = function() kept[a.current] = true end }
		end })
		app:use({ name = "bad", needs = { "keeper" }, setup = function(a) a:need("keeper").keep() error("boom") end })
		app:use({ name = "good", needs = { "keeper" }, setup = function(a) a:need("keeper").keep() end })
		app:setup()
		t.eq(kept, { good = true })
	end },
	{ "app: a feature that fails is dropped, with what it registered and its dependents", function()
		local app = new_app()
		app:use({ name = "good", setup = function(a)
			a:on("tick", function() end)
			a:hint({ key = "k1", text = "good" })
		end })
		app:use({ name = "bad", setup = function(a)
			a:on("tick", function() end)
			a:hint({ key = "k2", text = "bad" })
			a:command({ id = "bad.cmd", run = function() end })
			a.settings:define("bad", { values = { 1 } })
			a.channel:on("start", function() end)
			error("boom")
		end })
		app:use({ name = "child", needs = { "bad" }, setup = function() error("never") end })
		local failed = app:setup()
		t.ok(failed.bad:find("boom"), "bad failed")
		t.eq(failed.child, "needs bad, which failed")
		t.eq(#app.hooks.tick, 1)
		t.eq(#app.hints, 1)
		t.eq(#app.commands, 0)
		t.eq(app.settings.defs.bad, nil)
		t.ok(not app.channel:handles("start"), "the channel op is free again")
		t.eq(#stub.logs, 2)
	end },
	{ "app: hooks run in order; a failing handler does not stop the others; first() stops", function()
		local app = new_app()
		local got = {}
		app:on("x", function() table.insert(got, "late") end, 90)
		app:on("x", function() table.insert(got, "early") end, 10)
		app:on("x", function() error("oops") end)
		app:emit("x")
		t.eq(got, { "early", "late" })
		t.eq(#stub.logs, 1)
		app:on("key", function() return false end, 10)
		app:on("key", function() return true end, 20)
		app:on("key", function() error("not reached") end, 30)
		t.eq(app:first("key", {}), true)
		t.eq(#stub.logs, 1)
	end },
	{ "app: registration, commands and keys; one sidebar", function()
		local app = new_app()
		app:use({ name = "f", setup = function(a)
			a:command({ id = "s.one", title = "One", key = "ctrl+k 1", run = function() error("bad") end })
			a:command({ id = "s.two", run = function() end })
			a:sidebar({ title = "side", render = function() end })
			t.raises(function() a:sidebar({ title = "again" }) end, "taken")
			t.raises(function() a:command({ id = "s.one", run = function() end }) end, "taken")
		end })
		app:setup()
		local reg = app:registration()
		t.eq(#reg.commands, 2)
		t.eq(reg.keybindings, { { key = "ctrl+k 1", command = "s.one" } })
		t.eq(reg.sidebar.title, "side")
		reg.commands[1].handler()
		t.eq(#stub.logs, 1, "a failing command is logged")
	end },
	{ "app: start registers, loads the settings on ready, ticks", function()
		local app = new_app()
		local seen = {}
		app:use({ name = "f", setup = function(a)
			a.settings:define("v", { values = { 1, 2 } })
			a:on("ready", function() table.insert(seen, "ready " .. a.settings:get("v")) end)
			a:on("tick", function() table.insert(seen, "tick") end)
			a:on("key", function(key) return key.rune == "x" end)
		end })
		stub.files["/plugin/settings.json"] = require("ttt.json").encode({ v = 2 })
		app:start()
		t.ok(stub.registered, "registered")
		t.eq(seen, {})
		stub.run_timers()
		t.eq(seen, { "ready 2" })
		stub.run_timers()
		t.eq(seen, { "ready 2", "tick" })
		t.eq(stub.events["key.press"]({ rune = "x" }), true)
		t.eq(stub.events["key.press"]({ rune = "y" }), false)
		require("core.buffer").editing = true
		t.eq(stub.events["key.press"]({ rune = "x" }), false, "the plugin's own changes are not keys")
	end },
	{ "wrap: lines of at most the width, by words, a long word cut, newlines kept", function()
		local wrap = require("core.wrap")
		t.eq(wrap.lines("one two three four", 9), { "one two", "three", "four" })
		t.eq(wrap.lines("abcdefghij", 4), { "abcd", "efgh", "ij" })
		t.eq(wrap.lines("a\n\nb", 10), { "a", "", "b" }, "a blank line stays")
		t.eq(wrap.lines("  - one two three", 10), { "  - one", "  two", "  three" }, "the indent stays")
		t.eq(wrap.lines("Stub scope      body", 40), { "Stub scope      body" }, "a line that fits is not touched")
		t.eq(wrap.lines("ñandú ñandú", 5), { "ñandú", "ñandú" }, "characters, not bytes")
		t.eq(wrap.lines("", 5), { "" })
	end },
	{ "wrap: a label gives one widget row for each line, the margin and badge on the first", function()
		local wrap = require("core.wrap")
		local rows = {}
		local panel = setmetatable({}, { __index = function(_, method)
			return function(_, arg)
				if method == "size" then return 11, 5 end
				if method == "label" then table.insert(rows, arg) end
			end
		end })
		wrap.label(panel, { text = "alpha beta gamma delta", style = "muted", margin_top = 1, badge = "b" })
		t.eq(#rows, 3)
		t.eq(rows[1].text, "alpha beta")
		t.eq({ rows[1].margin_top, rows[1].badge, rows[1].style }, { 1, "b", "muted" })
		t.eq({ rows[2].margin_top, rows[2].badge, rows[2].style }, { nil, nil, "muted" })
	end },
	{ "wrap: list rows wrap into rows that answer to the same id", function()
		local wrap = require("core.wrap")
		local items = wrap.items({
			{ id = "a", label = "short" },
			{ id = "b", label = "one two three four five six seven eight", muted = true, children = {
				{ id = "b:1", label = "child one two three four five six seven eight" },
			} },
		}, 24)
		local ids = {}
		for _, it in ipairs(items) do table.insert(ids, wrap.id(it.id)) end
		t.eq(ids[1], "a")
		t.ok(#items > 3, "the long row took more rows")
		t.eq(items[3].muted, true, "a continuation keeps the muting")
		t.eq(ids[#ids], "b", "a continuation stands for its row")
		t.ok(items[2].children and #items[2].children > 1, "the children wrap too")
		for _, it in ipairs(items) do t.ok(require("core.util").runes(it.label) <= 24, "fits: " .. it.label) end
	end },
	{ "wrap: a pair that does not fit leaves the keyvalue", function()
		local wrap = require("core.wrap")
		local calls = {}
		local panel = setmetatable({}, { __index = function(_, method)
			return function(_, arg)
				if method == "size" then return 20, 5 end
				table.insert(calls, { method, arg })
			end
		end })
		wrap.pairs(panel, { { key = "ctrl+k a", value = "short" }, { key = "ctrl+k b", value = "a value that is much too long to fit" } })
		t.eq(calls[1][1], "keyvalue")
		t.eq(#calls[1][2], 1)
		t.eq(calls[2][1], "label")
	end },
}
