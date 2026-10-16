-- features/run.lua's pure parts: the status bar, the picker, the output.
local t = require("check")
local run = require("features.run")

local function cell_panel(w)
	local p = { w = w, texts = {}, cells = {} }
	function p:size() return self.w, 10 end
	function p:text(x, y, text) table.insert(self.texts, { x, y, text }) end
	function p:cell(x, y, ch) table.insert(self.cells, { x, y, ch }) end
	return p
end

return {
	{ "run: elapsed and badge", function()
		t.eq(run.elapsed(42), "0:42")
		t.eq(run.elapsed(723), "12:03")
		t.eq(run.elapsed(3723), "1:02:03")
		t.eq(run.elapsed(-5), "0:00")
		t.eq({ run.badge({ status = "running" }) }, { "●", "running", "success" })
		t.eq({ run.badge({ status = "exited", code = 0 }) }, { "✓", "exited 0", "muted" })
		t.eq({ run.badge({ status = "exited", code = 3 }) }, { "✗", "exited 3", "danger" })
		t.eq({ run.badge({ status = "stopped" }) }, { "■", "stopped", "muted" })
		t.eq({ run.badge({ status = "failed", error = "spawn ENOENT" }) }, { "✗", "spawn ENOENT", "danger" })
	end },
	{ "run: a run whose supervisor went quiet is lost", function()
		t.eq(run.settle({ status = "running", t = 100000 }, 105).status, "running")
		t.eq(run.settle({ status = "running", t = 100000 }, 109).status, "lost")
		t.eq(run.settle({ status = "exited", t = 100000 }, 500).status, "exited")
		t.ok(not run.live({ status = "lost" }))
	end },
	{ "run: the status bar", function()
		local api = { id = "saved:api", name = "api" }
		t.eq(run.status_line(nil, {}, 0), nil, "nothing chosen, nothing ran")
		t.eq(run.status_line(api, {}, 0), "▶ api")
		local runs = {
			{ configId = "saved:web", name = "web", status = "running", started = 0 },
			{ configId = "saved:api", name = "api", status = "running", started = 10000 },
		}
		t.eq(run.status_line(api, runs, 52), "● api 0:42 +1")
		runs[2] = { configId = "saved:api", name = "api", status = "exited", code = 2, started = 0, ended = 1000 }
		t.eq(run.status_line(api, runs, 52), "✗ api 2 +1")
		t.eq(run.status_line({ id = "x", name = "x" }, { runs[1] }, 5), "● web 0:05", "a run when the chosen never ran")
	end },
	{ "run: the picker filters on every word, keeps the order", function()
		local cs = {
			{ id = "a", name = "dev", group = "npm · web", line = "npm run dev" },
			{ id = "b", name = "build", group = "make", line = "make build" },
			{ id = "c", name = "test", group = "npm · web", line = "npm run test" },
		}
		local ids = function(list) local out = {} for _, c in ipairs(list) do table.insert(out, c.id) end return out end
		t.eq(ids(run.filter(cs, "")), { "a", "b", "c" })
		t.eq(ids(run.filter(cs, "NPM")), { "a", "c" })
		t.eq(ids(run.filter(cs, "web te")), { "c" })
		t.eq(ids(run.filter(cs, "nope")), {})
		local items = run.picker_items(cs, "c")
		t.eq(#items, 2, "a node per group")
		t.eq(items[1].label, "npm · web")
		t.eq(items[1].children[2].label, "test  npm run test")
		t.eq(items[1].children[2].icon, "▶", "the chosen one")
		t.eq(items[2].children[1].id, "b")
	end },
	{ "run: file references in output", function()
		t.eq({ run.file_ref("src/app.ts:12:5 - error TS2322") }, { "src/app.ts", 12 })
		t.eq({ run.file_ref("    at f (/x/y.js:3:1)") }, { "/x/y.js", 3 })
		t.eq({ run.file_ref('  File "a/b.py", line 7, in <module>') }, { "a/b.py", 7 })
		t.eq({ run.file_ref("Program.cs(12,5): error CS1002") }, { "Program.cs", 12 })
		t.eq(run.file_ref("listening on http://localhost.dev:8080"), nil, "a URL is no file")
		t.eq(run.file_ref("no reference here"), nil)
	end },
	{ "run: put reaches the right edge that panel:text cannot", function()
		local p = cell_panel(20)
		run.put(p, 0, 0, "short")
		t.eq(p.texts, { { 0, 0, "short" } })
		p = cell_panel(20)
		run.put(p, 8, 1, "abcdefghijklmn") -- panel:text stops at 20 - 8 = 12
		t.eq(p.texts, { { 8, 1, "abcd" } })
		t.eq(#p.cells, 8, "e..l a cell each, up to the edge")
		t.eq(p.cells[1], { 12, 1, "e" })
		t.eq(p.cells[8], { 19, 1, "l" })
	end },
	{ "run: tail lines", function()
		t.eq(run.split_lines("a\nb\n"), { "a", "b" })
		t.eq(run.split_lines(""), {})
	end },
	{ "run: the workspace folder the plugin guesses", function()
		local have = { ["/r/.git"] = true, ["/r/api/.symbiosis/run.json"] = true }
		local exists = function(p) return have[p] == true end
		t.eq(run.guess_folder("/r/api/src/a.ts", exists), "/r/api", "the nearest run.json")
		t.eq(run.guess_folder("/r/web/b.ts", exists), "/r", "else the git root")
		t.eq(run.guess_folder("/tmp/x/c.py", exists), "/tmp/x", "else the file's folder")
	end },
	{ "run: where the bottom panel's cells start on the screen", function()
		local state = { widget_tree = { type = "Root", children = {
			{ type = "SplitPanel", children = { { type = "Sidebar" }, { type = "ContentSplit", children = {
				{ type = "EditorGroup", rect = { x = 32, y = 1, w = 67, h = 12 } },
				{ type = "BottomPanel", rect = { x = 32, y = 13, w = 67, h = 15 } },
			} } } },
		} } }
		local x, y = run.panel_origin(state)
		t.eq({ x, y }, { 32, 15 }, "below the tab row and the divider")
		t.eq(run.panel_origin({ widget_tree = { type = "Root" } }), nil)
		t.eq(run.panel_origin(nil), nil)
	end },
	{ "run: the runs list's width, dragged or not", function()
		t.eq(run.split_width(100), 28, "28% up to 28")
		t.eq(run.split_width(50), 16, "at least 16")
		t.eq(run.split_width(100, 60), 60, "where it was dragged")
		t.eq(run.split_width(100, 95), 84, "the output keeps 16")
		t.eq(run.split_width(100, 2), 8, "the list keeps 8")
	end },
	{ "run: output rows, cut or wrapped", function()
		local lines = { "short", "abcdefghij", "", "äöüäöü" }
		local rows = run.output_rows(lines, 4, false)
		t.eq(#rows, 4, "a row per line")
		t.eq(rows[2], { text = "abcdefghij", line = 2 })
		rows = run.output_rows(lines, 4, true)
		local texts, of = {}, {}
		for _, r in ipairs(rows) do table.insert(texts, r.text) table.insert(of, r.line) end
		t.eq(texts, { "shor", "t", "abcd", "efgh", "ij", "", "äöüä", "öü" })
		t.eq(of, { 1, 1, 2, 2, 2, 3, 4, 4 }, "each row knows its line")
	end },
	{ "run: an event ttt hands over twice counts once", function()
		local twice = run.twice_filter(0.008)
		local down = { type = "key", key = "Down" }
		t.eq(twice(down, 1.000), false)
		t.eq(twice({ type = "key", key = "Down" }, 1.001), true, "the copy")
		t.eq(twice(down, 1.040), false, "a second press, 40 ms on")
		t.eq(twice({ type = "key", key = "Up" }, 1.041), false, "another key")
		t.eq(twice({ type = "mouse", x = 3, y = 4, button = "left" }, 2), false)
		t.eq(twice({ type = "mouse", x = 3, y = 5, button = "left" }, 2.001), false, "the mouse moved")
	end },
}
