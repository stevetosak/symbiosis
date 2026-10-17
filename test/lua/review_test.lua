-- review (features/review.lua, core/review.lua): the pure parts.
local t = require("check")

local function landed(id, path, line, anchor)
	return { id = id, path = path, line = line, anchor = anchor or "function f() {", name = "f", whys = {} }
end

return {
	{ "review: collect flattens the sessions' lists and drops bad entries", function()
		local review = require("core.review")
		local list = review.collect({
			{ id = "s1", review = { landed("a", "/w/x.ts", 3), { id = 5 }, "junk" } },
			{ id = "s2" },
			{ id = "s3", review = { landed("b", "/w/y.ts", 1) } },
		})
		t.eq(#list, 2)
		t.eq({ list[1].id, list[1].session, list[2].id, list[2].session }, { "a", "s1", "b", "s3" })
	end },
	{ "review: pending skips what was acked here", function()
		local review = require("core.review")
		local list = { landed("a", "/x", 1), landed("b", "/x", 2) }
		local rest = review.pending(list, { a = true })
		t.eq(#rest, 1)
		t.eq(rest[1].id, "b")
	end },
	{ "review: the function is found again by its first line, or lost", function()
		local review = require("core.review")
		local l = landed("a", "/x", 3, "function f() {")
		t.eq(review.line_of(l, { "a", "b", "function f() {", "}" }), 3)
		t.eq(review.line_of(l, { "new", "new", "a", "b", "function f() {", "}" }), 5, "lines came in above")
		t.eq(review.line_of(l, { "  function f() {" }), 1, "indent does not count")
		t.eq(review.line_of(l, { "a", "b", "function g() {" }), nil, "the line is gone")
	end },
	{ "review: count by file", function()
		local review = require("core.review")
		local n = review.count({ landed("a", "/x", 1), landed("b", "/x", 2), landed("c", "/y", 1) })
		t.eq(n, { ["/x"] = 2, ["/y"] = 1 })
	end },
	{ "review: choose the body nearest the cursor, else the owner's newest", function()
		local review = require("core.review")
		local a, b, c = landed("a", "/x", 3), landed("b", "/x", 40), landed("c", "/y", 1)
		a.session, b.session, c.session = "s1", "s1", "s2"
		local list = { a, b, c }
		local lines = { a = 3, b = 40 }
		t.eq(review.choose(list, "/x", 35, lines, "s2").id, "b", "in this file, the nearest")
		t.eq(review.choose(list, "/x", 1, lines, "s2").id, "a")
		t.eq(review.choose(list, "/z", 1, lines, "s1").id, "b", "else the newest of the followed session")
		t.eq(review.choose(list, "/z", 1, lines, nil).id, "c", "else the newest")
		t.eq(review.choose({}, "/z", 1, {}, nil), nil)
	end },
	{ "review: fresh ids are the ones not seen", function()
		local review = require("core.review")
		local fresh = review.fresh({ landed("a", "/x", 1), landed("b", "/x", 2) }, { a = true })
		t.eq(#fresh, 1)
		t.eq(fresh[1].id, "b")
	end },
	{ "gutter: sets, keeps, removes its own marks and leaves other icons", function()
		local marks = {}
		local bookmarks = {
			get = function(line) return marks[line] end,
			set = function(line, icon, style) marks[line] = { icon = icon, style = style } end,
			remove = function(line) marks[line] = nil end,
		}
		local gutter = require("core.gutter").new(bookmarks, "●", "warning")
		marks[2] = { icon = "π" }
		gutter.draw("/x", { [1] = true, [2] = true })
		t.eq(marks[1], { icon = "●", style = "warning" })
		t.eq(marks[2], { icon = "π" }, "another feature's mark stays")
		gutter.draw("/x", { [3] = true })
		t.eq(marks[1], nil, "no longer wanted")
		t.eq(marks[3].icon, "●")
		marks[3] = nil
		gutter.draw("/x", { [3] = true })
		t.eq(marks[3].icon, "●", "cleared by another plugin: drawn again")
		gutter.draw("/y", {})
		t.eq(marks[3].icon, "●", "a new file starts clean (its own lines are the open file's)")
	end },
	{ "tree: a file with bodies waiting shows how many", function()
		local build = require("features.tree").build
		local rec = { id = "s", name = "pi", cwd = "/w", files = { "/w/a.ts", "/w/b.ts" },
			review = { landed("1", "/w/a.ts", 1), landed("2", "/w/a.ts", 5) } }
		local items = build({ rec }, nil, nil)
		local badges = {}
		for _, n in ipairs(items[1].children) do badges[n.label] = n.badge end
		t.eq(badges, { ["a.ts"] = "● 2" })
	end },
}
