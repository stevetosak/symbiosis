-- helpi!: a comment that ends in `helpi!` asks the session the editor
-- follows, at once: 600 ms after your last change, or on Enter at the end of
-- its line. help.json carries the question and the code around it, as in
-- the buffer. pi asks its model in a side call (core/help.ts) and sends events
-- back:
--   help        pi has the question; it is thinking
--   help_start  the kind: note, code or ask; for code, the imports it needs
--   help_text   the answer so far (all of it)
--   help_done   the answer is complete, stopped, or failed
-- note: comment lines under the question, the first one starts "pi:". code:
-- takes the place of the comment, and missing imports go in at the top. ask:
-- the question went to pi's agent. All in one undo group: one ctrl+z takes
-- it back. While the answer is written, your typing in that file waits, and
-- the replay too. Esc stops it; what is written stays. Until the answer
-- starts, a line under the question shows that pi thinks (a spinner); it is
-- in the same undo group, and the answer takes its place.
--
-- The help events skip the replay's queue: they apply at once, and only for
-- the question under way.
local ttt = require("ttt")
local editor = require("ttt.editor")
local util = require("core.util")
local buffer = require("core.buffer")

local runes = util.runes

local OPENERS = { "<!--", "/*", "//", "--", "#", ";" }
local CLOSERS = { ["<!--"] = " -->", ["/*"] = " */" }
local HELP_MS = 600
local MAX_LINES = 150 -- a longer file sends its top and the lines around the question
local FRAMES = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }

-- The comment on `line` when it ends in helpi!: where its opener is, and the indent.
local function helpi(line)
	local body = line:gsub("%s*%*/%s*$", ""):gsub("%s*%-%->%s*$", "")
	if not body:match("helpi!%s*$") then return nil end
	local best = nil
	for _, o in ipairs(OPENERS) do
		local b = body:find(o, 1, true)
		if b and b < #body - 5 then best = { byte = b, opener = o } break end
	end
	if not best then return nil end
	best.col = runes(line:sub(1, best.byte - 1)) + 1
	best.indent = line:match("^%s*")
	return best
end

-- The line without its last `helpi!` (and the space before it).
local function unmark(line)
	local at = line:match(".*()helpi!")
	if not at then return line end
	return line:sub(1, at - 1):gsub("%s+$", "") .. line:sub(at + 6)
end

-- The text the answer region holds for `body`. h: {kind, indent, opener}.
local function render(h, body, final)
	local out = {}
	local parts = util.split(body)
	if h.kind == "code" then
		for i, l in ipairs(parts) do
			if i == 1 then table.insert(out, l)
			else table.insert(out, "\n" .. (l == "" and "" or h.indent .. l)) end
		end
		return table.concat(out)
	end
	-- A note: one comment line each. A closer (*/, -->) only on a complete line.
	local closer = CLOSERS[h.opener] or ""
	if #parts == 0 then parts = { "" } end
	for i, l in ipairs(parts) do
		local text = (i == 1 and "pi: " or "") .. l
		local close = (final or i < #parts) and closer or ""
		table.insert(out, "\n" .. h.indent .. h.opener .. (text == "" and "" or " " .. text) .. close)
	end
	return table.concat(out)
end

-- After the last import line near the top (or after a package line), or at line 1.
local IMPORT_LINE = { "^import[%s{\"']", "^from%s", "^use%s", "^#include", "^require[%s(]", "^const%s.-=%s*require%(", "^using%s" }
local function import_at(all)
	local at, package = 0, 0
	for i = 1, math.min(#all, 200) do
		local l = all[i]
		for _, p in ipairs(IMPORT_LINE) do
			if l:match(p) then at = i break end
		end
		if l:match("^package%s") then package = i end
	end
	return at, package
end

local function setup(app)
	local replay = app:need("replay")
	local sessions = app:need("sessions")
	local channel = app.channel
	local help = nil       -- the question under way
	local seq = 0
	local timer = nil      -- asks after the pause
	local wait = nil       -- the timer that says pi did not take the question
	local asked = {}       -- path:line:text -> true: the pause does not ask again (Enter does)
	local quiet = 0        -- poll tick: changes before it are the plugin's own (the waiting line)

	local function show(text) replay.show(text) end

	-- The waiting line: a comment under the question, with the question's indent.
	local function loader_text(h)
		return h.indent .. h.opener .. " pi " .. FRAMES[h.frame] .. " thinking · Esc stops" .. (CLOSERS[h.opener] or "")
	end

	-- The line the waiting line is on now, if it is still there.
	local function loader_at(h)
		if not h.loader or editor.file_path() ~= h.path then return nil end
		if editor.get_line(h.loader) == h.loader_shown then return h.loader end
		for i, l in ipairs(editor.buffer_lines()) do
			if l == h.loader_shown then return i end
		end
		return nil
	end

	-- Shows the waiting line and opens the answer's undo group (the line is in it).
	local function show_loader()
		local h = help
		if not h or h.kind or h.group or editor.file_path() ~= h.path then return end
		if editor.get_line(h.line) ~= h.text then return end
		local cur = editor.cursor()
		editor.begin_undo_group()
		h.group = true
		h.frame = 1
		h.loader_shown = loader_text(h)
		buffer.editing = true
		if h.line < editor.line_count() then
			editor.insert(h.line + 1, 1, h.loader_shown .. "\n")
		else
			editor.insert(h.line, runes(h.text) + 1, "\n" .. h.loader_shown)
		end
		buffer.editing = false
		h.loader = h.line + 1
		editor.set_cursor(cur.line > h.line and cur.line + 1 or cur.line, cur.col)
	end

	-- The spinner turns: called on each poll tick.
	local function spin_loader()
		local h = help
		if not h or not h.loader or h.kind or app.ticks % 3 ~= 0 then return end
		local at = loader_at(h)
		if not at then return end
		local cur = editor.cursor()
		h.frame = h.frame % #FRAMES + 1
		h.loader_shown = loader_text(h)
		buffer.editing = true
		editor.set_line(at, h.loader_shown)
		buffer.editing = false
		h.loader = at
		editor.set_cursor(cur.line, cur.col)
	end

	-- Takes the waiting line away; the cursor stays where it was in your text.
	local function hide_loader(h)
		local at = loader_at(h)
		h.loader = nil
		if not at then return end
		local cur = editor.cursor()
		buffer.editing = true
		if at < editor.line_count() then
			editor.replace(at, 1, at + 1, 1, "")
		else
			local prev = editor.get_line(at - 1) or ""
			editor.replace(at - 1, runes(prev) + 1, at, runes(h.loader_shown) + 1, "")
		end
		buffer.editing = false
		if cur.line > at then editor.set_cursor(cur.line - 1, cur.col)
		elseif cur.line == at then editor.set_cursor(at - 1, runes(editor.get_line(at - 1) or "") + 1)
		else editor.set_cursor(cur.line, cur.col) end
	end

	local function help_end(message, level)
		local h = help
		if not h then return end
		help = nil
		if wait then ttt.clear_timeout(wait) wait = nil end
		if h.loader then hide_loader(h) end
		quiet = app.ticks + 8
		if h.group then
			editor.end_undo_group()
			-- Only the waiting line was in the group (Esc or an error before the
			-- answer): undo it, so your next ctrl+z is not a step that does nothing.
			if not h.region then
				local cur = editor.cursor()
				buffer.editing = true
				ttt.exec_command("editor.undo")
				buffer.editing = false
				editor.set_cursor(cur.line, cur.col)
			end
		end
		if message then ttt.notify("symbiosis: " .. message, level or "info") end
		show()
		local autosave = app:get("autosave")
		if h.region and autosave then autosave.schedule(true) end
	end

	local function help_write(fields)
		channel:write_json("help.json", fields)
	end

	-- `again`: Enter asks also a line that was asked before (after ctrl+z, say).
	local function ask_help(again)
		if not app.loaded or help or buffer.editing or replay.running() then return end
		local path = editor.file_path()
		if not path or path == "" then return end
		local pos = editor.cursor()
		local text = editor.get_line(pos.line) or ""
		local c = helpi(text)
		if not c then return end
		local key = path .. ":" .. pos.line .. ":" .. text
		if asked[key] and not again then return end
		asked[key] = true
		sessions.refresh()
		local owner = sessions.owner()
		if not owner then return ttt.notify("symbiosis: helpi! needs a pi session; none runs", "warning") end
		if owner.version ~= sessions.PROTOCOL then
			return ttt.notify("symbiosis: pi " .. owner.name .. " runs an old symbiosis: /reload it", "warning")
		end
		local all = editor.buffer_lines()
		local first, last, head = 1, #all, ""
		if #all > MAX_LINES then
			first, last = math.max(1, pos.line - 40), math.min(#all, pos.line + 20)
			if first > 21 then head = table.concat(all, "\n", 1, 20) else first = 1 end
		end
		seq = seq + 1
		help = {
			id = os.time() .. "-" .. seq, path = path, line = pos.line, text = text,
			byte = c.byte, col = c.col, opener = c.opener, indent = c.indent, to = owner.id, name = owner.name,
		}
		help_write({
			id = help.id, to = help.to, path = path, line = pos.line, question = text,
			language = editor.language() or "", head = head,
			window = { first = first, text = table.concat(all, "\n", first, last) }, cancel = false,
		})
		show("helpi! → " .. owner.name)
		-- After the key that asked (Enter goes in first).
		ttt.set_timeout(10, function()
			local fine, err = pcall(show_loader)
			if not fine then
				buffer.editing = false
				app.log("error", "symbiosis helpi! loader: " .. tostring(err))
			end
		end)
		wait = ttt.set_timeout(3000, function()
			wait = nil
			if help and not help.taken then
				asked[key] = nil
				help_end("pi " .. help.name .. " did not take the question: /reload it?", "error")
			end
		end)
	end

	local function help_soon()
		if not app.loaded or buffer.editing or help or app.ticks < quiet then return end
		if timer then ttt.clear_timeout(timer) end
		timer = ttt.set_timeout(HELP_MS, function()
			timer = nil
			local fine, err = pcall(ask_help)
			if not fine then app.log("error", "symbiosis helpi!: " .. tostring(err)) end
		end)
	end

	-- Esc: pi stops the side call; what is written stays.
	local function help_stop()
		if not help then return end
		help_write({ id = help.id, to = help.to, cancel = true })
		help.stopped = true
		help_end(help.region and "helpi! stopped" or "helpi! stopped before pi answered")
	end

	-- Missing imports go in at the top. Returns how many lines went in.
	local function add_imports(imports, before)
		local all = editor.buffer_lines()
		local have = {}
		for _, l in ipairs(all) do have[l:match("^%s*(.-)%s*$")] = true end
		local new = {}
		for _, imp in ipairs(imports or {}) do
			local t = imp:match("^%s*(.-)%s*$")
			if t ~= "" and not have[t] then table.insert(new, t) have[t] = true end
		end
		if #new == 0 then return 0 end
		local at, package = import_at(all)
		local text = table.concat(new, "\n") .. "\n"
		local line = at + 1
		if at == 0 then
			-- No imports yet: after a package line, or at the top; then a blank line.
			line = package > 0 and package + 1 or 1
			if package > 0 then text = "\n" .. text end
			if (all[line] or "") ~= "" then text = text .. "\n" end
		end
		if line > #all then
			editor.insert(#all, runes(all[#all] or "") + 1, "\n" .. text:sub(1, -2))
		else
			editor.insert(line, 1, text)
		end
		if line > before then return 0 end
		return select(2, text:gsub("\n", ""))
	end

	local function help_taken()
		help.taken = true
		if wait then ttt.clear_timeout(wait) wait = nil end
		show("helpi! · " .. help.name .. " thinks · Esc stops")
	end

	local function help_start(ev)
		help.kind = ev.kind
		if replay.running() then replay.finish() end
		if not buffer.on_buffer(help.path) then return help_end("helpi!: the file did not open", "warning") end
		-- The question may have moved: find its line again.
		local line = help.line
		if editor.get_line(line) ~= help.text then
			line = nil
			for i, l in ipairs(editor.buffer_lines()) do
				if l == help.text then line = i break end
			end
			if not line then return help_end("helpi!: the question changed; the answer is not written", "warning") end
		end
		-- The waiting line goes; the answer takes its place.
		if help.loader then hide_loader(help) end
		-- You pressed Enter after the question: the cursor stays on your new line.
		local cursor = editor.cursor()
		if cursor.line > line then help.below = { lines = cursor.line - line, col = cursor.col } end
		if not help.group then
			editor.begin_undo_group()
			help.group = true
		end
		buffer.editing = true
		if ev.kind == "code" then
			line = line + add_imports(ev.imports, line)
			help.region = { line = line, col = help.col, text = help.text:sub(help.byte) }
		else
			local stripped = unmark(help.text)
			editor.set_line(line, stripped)
			help.region = { line = line, col = runes(stripped) + 1, text = "" }
		end
		buffer.editing = false
		if ev.kind == "ask" then
			buffer.set_region(help.region, render(help, "asked " .. help.name .. "; its answer comes in pi", true), help.below)
			return help_end()
		end
		show("helpi! · " .. help.name .. " writes · Esc stops")
	end

	local function help_text(ev)
		if help.region then buffer.set_region(help.region, render(help, ev.text or "", false), help.below) end
	end

	local function help_done(ev)
		if ev.error then
			asked[help.path .. ":" .. help.line .. ":" .. help.text] = nil
			return help_end("helpi! failed: " .. tostring(ev.error), "error")
		end
		if help.region and not ev.stopped then buffer.set_region(help.region, render(help, ev.text or "", true), help.below) end
		help_end()
	end

	local handlers = { help = help_taken, help_start = help_start, help_text = help_text, help_done = help_done }

	-- A help event, at once (not through the replay queue): only for the question under way.
	local function apply_help(ev)
		if not help or help.stopped or ev.id ~= help.id then return end
		if ev.op ~= "help" and not help.taken then help_taken(ev) end
		local fine, err = pcall(handlers[ev.op], ev)
		if not fine then
			buffer.editing = false
			app.log("error", "symbiosis " .. ev.op .. ": " .. tostring(err))
			help_end("helpi! failed in the editor: " .. tostring(err), "error")
		end
	end
	for op in pairs(handlers) do channel:on(op, apply_help) end

	-- While an answer is written, the replay waits, and your typing in its file too.
	replay.hold(function() return help ~= nil and help.group == true end)
	replay.lock(function(path) return help ~= nil and help.group == true and path == help.path end)

	-- Early: Esc stops an answer; Enter at the end of a helpi! line asks at
	-- once (the Enter still goes in).
	app:on("key", function(key)
		local k = tostring(key.key or ""):lower()
		if help and (k == "esc" or k == "escape") then
			help_stop()
			return true
		end
		if k == "enter" and (not key.mod or key.mod == "") and not help then
			local line = editor.current_line() or ""
			if editor.cursor().col > runes(line) and helpi(line) then
				if timer then ttt.clear_timeout(timer) timer = nil end
				local fine, err = pcall(ask_help, true)
				if not fine then app.log("error", "symbiosis helpi!: " .. tostring(err)) end
			end
		end
		return false
	end, 10)

	app:on("change", help_soon)
	app:on("tick", spin_loader, 60)
	app:hint({ key = "// … helpi!", text = "ask pi here: wait, or Enter", order = 90 })
	app:hint({ key = "Esc", text = "stop a helpi! answer", order = 100 })

	return {
		busy = function() return help ~= nil end,
		stop = help_stop,
	}
end

return {
	name = "helpi",
	needs = { "replay", "sessions" },
	setup = setup,
	-- For the tests.
	helpi = helpi,
	unmark = unmark,
	render = render,
	import_at = import_at,
}
