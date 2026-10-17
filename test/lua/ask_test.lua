-- ask (features/ask.lua) and notes (core/notes.lua): the pure parts.
local t = require("check")

return {
	{ "ask: a why! line, the code and the question", function()
		local parse = require("features.ask").parse_why
		local w = parse("  retry(3) // why 3? why!")
		t.eq({ w.code, w.question }, { "  retry(3)", "why 3?" })
		w = parse("// why is this here? why!")
		t.eq({ w.code, w.question }, { "", "why is this here?" })
		w = parse("x = 1 /* odd */ /* why this? why! */")
		t.eq(w.question, "odd */ /* why this?", "the first opener is the comment's start")
		t.eq(parse("// why!").question, "")
		t.eq(parse("// why? helpi!"), nil)
		t.eq(parse("x = why!"), nil, "no comment")
		t.eq(parse("// nowhy!"), nil, "a word of its own")
	end },
	{ "ask: the word under the cursor, the code line, the link", function()
		local ask = require("features.ask")
		t.eq(ask.word_at("local x = foo_bar(1)", 12), "foo_bar")
		t.eq(ask.word_at("local x = foo_bar(1)", 18), "foo_bar", "at its end")
		t.eq(ask.word_at("a  b", 2), "a", "just after a word: that word")
		t.eq(ask.word_at("a  b", 3), "", "between words: none")
		t.eq(ask.word_at("(  )", 2), "")
		t.eq(ask.code_line({ "", "  ", "x" }, 1), 3)
		t.eq(ask.code_line({ "x", "" }, 2), nil)
		t.eq({ ask.split_link("core/ask.ts:12") }, { "core/ask.ts", 12 })
		t.eq({ ask.split_link("a/b.go:3-9") }, { "a/b.go", 3 })
	end },
	{ "notes: the hash ignores the blanks at the ends", function()
		local notes = require("core.notes")
		t.eq(notes.hash("  return x  "), notes.hash("return x"))
		t.ok(notes.hash("return x") ~= notes.hash("return y"))
	end },
	{ "notes: a note finds its line again, or is moved", function()
		local notes = require("core.notes")
		local lines = { "a", "b()", "c", "b()", "d" }
		local list = { notes.new(lines, 2, { answer = "x" }), notes.new(lines, 5, { answer = "y" }) }
		t.eq(notes.anchor(list, lines), false, "nothing moved")
		-- Two lines come in above: the nearest same line is found.
		local moved = { "n1", "n2", "a", "b()", "c", "b()", "d" }
		t.eq(notes.anchor(list, moved), true)
		t.eq({ list[1].line, list[2].line }, { 4, 7 })
		-- The line of the second note is gone.
		local gone = { "n1", "n2", "a", "b()", "c", "b()" }
		notes.anchor(list, gone)
		t.eq(list[2].moved, true)
		t.eq(notes.by_line(list)[4][1], list[1])
		t.eq(notes.by_line(list)[7], nil, "a moved note has no line")
		-- It comes back when the line does.
		notes.anchor(list, moved)
		t.eq(list[2].moved, nil)
		t.eq(list[2].line, 7)
		-- A note on a blank line has nothing to find.
		local blank = { notes.new({ "", "x" }, 1, { answer = "z" }) }
		notes.anchor(blank, { "", "x" })
		t.eq(blank[1].moved, true)
	end },
	{ "notes: the path, and the file as lines of JSON", function()
		local notes = require("core.notes")
		t.eq(notes.path("/w", "/w/src/a.ts"), "/w/.symbiosis/notes/src/a.ts.jsonl")
		t.eq(notes.path("/w", "/x/a.ts"), nil)
		t.eq(notes.path("/w", "/wx/a.ts"), nil, "a folder of its own")
		local list = { notes.new({ "a" }, 1, { question = "q", answer = "ans", links = { { title = "t", target = "a:1", kind = "file" } }, terms = { "x" }, time = 5 }) }
		list[1].moved = true
		local text = notes.encode(list)
		local back = notes.decode(text)
		t.eq(#back, 1)
		t.eq({ back[1].line, back[1].question, back[1].answer, back[1].moved }, { 1, "q", "ans", nil })
		t.eq(back[1].links[1].target, "a:1")
		t.eq(notes.decode("not json\n\n" .. text), back, "a line that is no note is skipped")
		t.eq(notes.encode({}), "")
	end },
}
