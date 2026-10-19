-- Ask: "what is this code, and why is it here?" with no comment in the file.
--
-- Point at code and ask pi's model, in a drawer:
--   ctrl+k d     the selection, else the line under the cursor (and the word
--                under it). On a line that has notes (◆ in the gutter), and
--                with no selection: the notes of the line.
--   why!         a comment that ends in `why!`: code on its line, else the
--                code below it. The comment is the question; it goes out of
--                the file (one ctrl+z brings it back).
-- ask.json carries the question, the code and the file as in the buffer; pi
-- asks its model in a side call (core/ask.ts) and sends events back:
--   ask        pi has the question
--   ask_text   the answer so far (all of it)
--   ask_done   the answer: text, links, terms; or stopped, or failed
-- The drawer shows the answer, its links, and the terms to ask about next.
-- Enter on a link opens a file of the project (a URL is text: select and
-- copy it; the model wrote it, nobody checked it). Enter on a term asks about
-- it, with this answer as context. The input asks your own follow-up. `+` or
-- the Deeper button asks the same again for a longer answer. Back goes to the
-- answer before. Each answer is kept as a note (features/notes.lua).
local ttt = require("ttt")
local editor = require("ttt.editor")
local fs = require("ttt.fs")
local util = require("core.util")
local buffer = require("core.buffer")
local folder = require("core.folder")
local marker = require("core.marker")
local trigger = require("core.trigger")

local runes = util.runes

local WORD = "why!"
local MAX_BYTES = 200 * 1024 -- a bigger file sends the lines around the code only
local AROUND = 80
local TAKE_MS = 3000
local CLOSERS = { "%*/", "%-%->" }

-- Pure parts ---------------------------------------------------------------------

-- A why! line: the code before its comment, the question in it, where the
-- comment starts. nil when the line has no why! comment.
local function parse_why(line)
	local c = marker.find(line, WORD)
	if not c then return nil end
	local stripped = marker.strip(line, WORD)
	local question = stripped:sub(c.byte + #c.opener)
	for _, closer in ipairs(CLOSERS) do question = question:gsub("%s*" .. closer .. "%s*$", "") end
	return {
		code = line:sub(1, c.byte - 1):gsub("%s+$", ""),
		question = question:gsub("^%s+", ""):gsub("%s+$", ""),
		byte = c.byte,
	}
end

-- The word of letters, digits and _ at byte `b` of `line`, or the one that ends there.
local function word_at(line, col)
	local b = util.rune_bytes(line, col - 1) + 1
	local function word_char(i) return i >= 1 and i <= #line and line:sub(i, i):match("[%w_]") ~= nil end
	if not word_char(b) then b = b - 1 end
	if not word_char(b) then return "" end
	local s, e = b, b
	while word_char(s - 1) do s = s - 1 end
	while word_char(e + 1) do e = e + 1 end
	return line:sub(s, e)
end

-- The first line from `from` that is not blank, or nil.
local function code_line(lines, from)
	for i = from, #lines do
		if not lines[i]:match("^%s*$") then return i end
	end
	return nil
end

-- `path:line` or `path:line-line` → path, line.
local function split_link(target)
	local path, line = target:match("^(.-):(%d+)")
	return path or target, tonumber(line) or 1
end

local function setup(app)
	local sessions = app:need("sessions")
	local follow = app:need("follow")
	local notes = app:need("notes")
	local channel = app.channel
	local cur = nil          -- the answer in the drawer
	local stack = {}         -- the answers before it (Back)
	local seq = 0
	local asked = {}         -- path:line:text -> true: the pause does not ask again (Enter does)
	local waiting = nil      -- the timer that says pi did not take the question
	local pending = false    -- a why! comment is being taken out of the file

	local function owner()
		sessions.refresh()
		local o = sessions.owner()
		if not o then
			ttt.notify("symbiosis: " .. sessions.missing("ask needs a pi session; none runs"), "warning")
			return nil
		end
		if o.version ~= sessions.PROTOCOL then
			ttt.notify("symbiosis: pi " .. o.name .. " runs an old symbiosis: /reload it", "warning")
			return nil
		end
		return o
	end

	-- The request for `target`, with the file as it is in the buffer.
	local function request_fields(c)
		local text = editor.buffer_text() or ""
		local all = editor.buffer_lines()
		local window = { first = 1, text = "" }
		if #text > MAX_BYTES then
			local first = math.max(1, c.target.startLine - AROUND)
			window = { first = first, text = table.concat(all, "\n", first, math.min(#all, c.target.endLine + AROUND)) }
			text = ""
		end
		local fields = {
			id = c.id, to = c.to, path = c.path, language = editor.language() or "", question = c.question,
			target = c.target, word = c.word or "", notesDir = notes.dir(c.path), text = text, window = window,
			deeper = c.deeper == true, cancel = false,
		}
		if c.parent then fields.parent = c.parent end
		return fields
	end

	local function stop_waiting()
		if waiting then ttt.clear_timeout(waiting) waiting = nil end
	end

	-- A view of an answer: opts = { path, target, anchor, anchor_text, word, question, parent, deeper }.
	local function view(opts, o)
		seq = seq + 1
		return {
			id = os.time() .. "-" .. seq, to = o.id, name = o.name, path = opts.path, target = opts.target,
			anchor = opts.anchor, anchor_text = opts.anchor_text, word = opts.word, question = opts.question or "",
			parent = opts.parent, deeper = opts.deeper, text = "", links = {}, terms = {}, status = "wait",
		}
	end

	local function show() end -- set below: the drawer's open function

	-- Asks pi about opts.target. `keep`: the answer in the drawer goes on the stack.
	local function ask(opts, keep)
		local o = owner()
		if not o then return end
		if cur and (cur.status == "wait" or cur.status == "text") then
			channel:write_json("ask.json", { id = cur.id, to = cur.to, cancel = true })
		end
		if keep and cur then table.insert(stack, cur) end
		cur = view(opts, o)
		channel:write_json("ask.json", request_fields(cur))
		stop_waiting()
		local mine = cur
		waiting = ttt.set_timeout(TAKE_MS, function()
			waiting = nil
			if cur == mine and mine.status == "wait" then
				mine.status, mine.error = "error", "pi " .. mine.name .. " did not take the question: /reload it?"
			end
		end)
		show()
	end

	-- The target of the selection, or of the line under the cursor.
	-- `line`: this line, whatever is selected (a click on the gutter selects it).
	local function here(line)
		local path = editor.file_path()
		if not path or path == "" then
			ttt.notify("symbiosis: save the file first, so the notes have a name", "warning")
			return nil
		end
		local all = editor.buffer_lines()
		local sel = not line and editor.selection() or nil
		local from, to, text, word = nil, nil, nil, ""
		if line then
			from, to, text = line, line, all[line] or ""
		elseif sel and sel.active then
			from, to = math.min(sel.start_line, sel.end_line), math.max(sel.start_line, sel.end_line)
			-- A selection that ends at the start of a line does not hold that line.
			if to > from and (sel.end_line > sel.start_line and sel.end_col == 1) then to = to - 1 end
			text = editor.selection_text()
		end
		if not text or text == "" then
			local pos = editor.cursor()
			from, to = pos.line, pos.line
			text = all[from] or ""
			if not line then word = word_at(text, pos.col) end
		end
		local anchor = code_line(all, from)
		if not anchor or anchor > to then anchor = from end
		return { path = path, target = { startLine = from, endLine = to, text = text }, anchor = anchor, anchor_text = all[anchor] or "", word = word }
	end

	-- ctrl+k d; from a click on a gutter mark: `line` (the notes of that line).
	local function ask_here(line)
		if not app.loaded then return end
		local opts = here(line)
		if not opts then return end
		local sel = not line and editor.selection() or nil
		if not (sel and sel.active) then
			local old = notes.at(opts.path, opts.anchor)
			if #old > 0 then
				-- The notes of the line: the newest first, the older ones behind Back.
				stack = {}
				local o = sessions.owner() or { id = "", name = "" }
				for i, n in ipairs(old) do
					local v = view({ path = opts.path, target = opts.target, anchor = opts.anchor, anchor_text = opts.anchor_text, word = opts.word, question = n.question }, o)
					v.text, v.links, v.terms, v.status, v.saved = n.answer, n.links, n.terms, "done", true
					if i < #old then table.insert(stack, v) else cur = v end
				end
				return show()
			end
			if line then return end -- the notes of a line, and it has none
		end
		stack = {}
		ask(opts, false)
	end

	-- why! ----------------------------------------------------------------------------

	local function fire_why(again)
		if not app.loaded or pending or buffer.editing or follow.running() then return end
		local path = editor.file_path()
		if not path or path == "" then return end
		local pos = editor.cursor()
		local text = editor.get_line(pos.line) or ""
		local w = parse_why(text)
		if not w then return end
		local key = path .. ":" .. pos.line .. ":" .. text
		if asked[key] and not again then return end
		asked[key] = true
		local o = owner()
		if not o then return end
		local all = editor.buffer_lines()
		-- The code the question is about: before the comment, or the next code line.
		local target = pos.line
		if w.code == "" then
			target = code_line(all, pos.line + 1)
			if not target then return ttt.notify("symbiosis: why! has no code below it", "warning") end
		end
		local function go()
			-- The comment goes: the rest of the line, or the whole line.
			local at = pos.line
			if editor.get_line(at) ~= text then
				at = nil
				for i, l in ipairs(editor.buffer_lines()) do
					if l == text then at = i break end
				end
				if not at then return ttt.notify("symbiosis: the question changed; nothing asked", "warning") end
			end
			local line = at == pos.line and target or target + (at - pos.line)
			local cursor = editor.cursor()
			editor.begin_undo_group()
			buffer.editing = true
			if w.code ~= "" then
				editor.set_line(at, w.code)
			elseif at < editor.line_count() then
				editor.replace(at, 1, at + 1, 1, "")
				line = line - 1
			else
				local prev = editor.get_line(at - 1) or ""
				editor.replace(at - 1, runes(prev) + 1, at, runes(text) + 1, "")
				line = line - 1
			end
			buffer.editing = false
			editor.end_undo_group()
			if w.code == "" and cursor.line > at then editor.set_cursor(cursor.line - 1, cursor.col) end
			pending = false
			local now = editor.buffer_lines()
			local code = now[line] or ""
			stack = {}
			ask({
				path = path, target = { startLine = line, endLine = line, text = code }, anchor = line, anchor_text = code,
				word = "", question = w.question,
			}, false)
		end
		-- After the key that asked: Enter goes in first.
		pending = true
		ttt.set_timeout(again and 10 or 0, function()
			local fine, err = pcall(go)
			if not fine then
				buffer.editing = false
				pending = false
				app.log("error", "symbiosis why!: " .. tostring(err))
			end
		end)
	end

	trigger.new(app, {
		name = WORD,
		find = function(line) return marker.find(line, WORD) end,
		busy = function() return pending end,
		fire = fire_why,
	})

	-- Events ---------------------------------------------------------------------------

	local function mine(ev) return cur ~= nil and ev.id == cur.id end

	channel:on("ask", function(ev)
		if not mine(ev) then return end
		stop_waiting()
	end)

	channel:on("ask_text", function(ev)
		if not mine(ev) or cur.status == "stopped" then return end
		stop_waiting()
		cur.status, cur.text = "text", ev.text or ""
	end)

	channel:on("ask_done", function(ev)
		if not mine(ev) then return end
		stop_waiting()
		if cur.status == "stopped" then return end
		cur.text = ev.text or cur.text
		if ev.error then
			cur.status, cur.error = "error", tostring(ev.error)
			return ttt.notify("symbiosis: ask failed: " .. cur.error, "error")
		end
		if ev.stopped then cur.status = "stopped" return end
		cur.links, cur.terms = ev.links or {}, ev.terms or {}
		cur.status = "done"
		if cur.text ~= "" and not cur.saved then
			cur.saved = true
			notes.add(cur.path, cur.anchor, cur.anchor_text, { question = cur.question, answer = cur.text, links = cur.links, terms = cur.terms })
		end
	end)

	-- The drawer ------------------------------------------------------------------------

	local function open_link(link)
		if link.kind ~= "file" then return end
		local path, line = split_link(link.target)
		local dir = cur and cur.path and folder.guess(cur.path, function(p) return fs.exists(p) end)
		local full = path:sub(1, 1) == "/" and path or ((dir or "") .. "/" .. path)
		if not fs.exists(full) then
			return ttt.notify("symbiosis: pi pointed to " .. path .. ", which is not there (the model wrote the link)", "warning")
		end
		ttt.open_file(full, line)
	end

	-- A term, a follow-up, or "deeper": a new answer with this one as its context.
	local function drill(question, deeper)
		if not cur or cur.status ~= "done" and cur.status ~= "stopped" and cur.status ~= "error" then return end
		local parent = cur.parent
		if not deeper then parent = { question = cur.question, answer = cur.text } end
		ask({
			path = cur.path, target = cur.target, anchor = cur.anchor, anchor_text = cur.anchor_text, word = cur.word,
			question = question, parent = parent, deeper = deeper,
		}, true)
	end

	local function again()
		if not cur then return end
		local c = cur
		ask({
			path = c.path, target = c.target, anchor = c.anchor, anchor_text = c.anchor_text, word = c.word,
			question = c.question, parent = c.parent, deeper = false,
		}, true)
	end

	local function stop()
		if not cur or (cur.status ~= "wait" and cur.status ~= "text") then return end
		channel:write_json("ask.json", { id = cur.id, to = cur.to, cancel = true })
		cur.status = "stopped"
	end

	local function back()
		if #stack == 0 then return end
		if cur and (cur.status == "wait" or cur.status == "text") then stop() end
		cur = table.remove(stack)
	end

	local STATUS = { wait = "thinking…", text = "writing…", done = "", stopped = "stopped", error = "failed" }

	local function render(panel)
		local c = cur
		if not c then return panel:label({ text = "Nothing asked.", style = "muted" }) end
		local where = c.target.startLine == c.target.endLine and ("line " .. c.target.startLine) or ("lines " .. c.target.startLine .. "-" .. c.target.endLine)
		panel:title({ text = "pi · " .. util.name(c.path) .. " " .. where, badge = STATUS[c.status] ~= "" and STATUS[c.status] or nil })
		panel:label({ text = util.cut((c.target.text or ""):match("[^\n]*"):gsub("^%s+", ""), 44), style = "muted" })
		if c.question ~= "" then panel:label({ text = "? " .. c.question, style = "bold", margin_top = 1 }) end
		-- The input comes first, so it has the focus when the answer opens: typing asks a
		-- follow-up. (Buttons have no mnemonic: a letter typed here must not press one.)
		panel:input({
			prefix = "ask: ", placeholder = "a follow-up question", clear_on_submit = true,
			on_submit = function(text)
				if text and text:match("%S") then drill(text, false) end
			end,
		})

		if c.status == "error" then
			panel:label({ text = c.error or "failed", style = "error", margin_top = 1 })
		elseif c.text == "" then
			panel:label({ text = c.status == "stopped" and "Stopped before pi answered." or "pi thinks…", style = "muted", margin_top = 1 })
		else
			local text = c.text
			local urls = {}
			for _, l in ipairs(c.links) do
				if l.kind == "url" then table.insert(urls, "- " .. l.title .. ": " .. l.target) end
			end
			if #urls > 0 then text = text .. "\n\n**Links** (the model wrote them; not checked)\n" .. table.concat(urls, "\n") end
			panel:markdown({ text = text, padding_left = 1 })
		end
		local files = {}
		for i, l in ipairs(c.links) do
			if l.kind == "file" then table.insert(files, { id = "link:" .. i, label = "↗ " .. l.title .. " · " .. l.target }) end
		end
		if #files > 0 then
			panel:label({ text = "Open · Tab, then Enter", style = "muted", margin_top = 1 })
			panel:list({
				items = files, truncate_left = false,
				on_command = function(command, node)
					if command ~= "activate" then return end
					local n = tonumber(tostring(node.id):match("^link:(%d+)"))
					if n and c.links[n] then open_link(c.links[n]) end
				end,
			})
		end
		if #c.terms > 0 then
			local items = {}
			for i, term in ipairs(c.terms) do table.insert(items, { id = "term:" .. i, label = "? " .. term }) end
			panel:label({ text = "Ask about · Tab, then Enter · + deeper", style = "muted", margin_top = 1 })
			panel:list({
				items = items, truncate_left = false, key_commands = { ["+"] = "deeper" },
				on_command = function(command, node)
					if command == "deeper" then return drill(c.question, true) end
					if command ~= "activate" then return end
					local n = tonumber(tostring(node.id):match("^term:(%d+)"))
					if n and c.terms[n] then drill('What is "' .. c.terms[n] .. '" here?', false) end
				end,
			})
		end
		if c.status == "wait" or c.status == "text" then
			panel:button({ label = "Stop", on_click = stop })
		else
			panel:button({ label = "Deeper", on_click = function() drill(c.question, true) end })
			panel:button({ label = "Again", on_click = again })
		end
		if #stack > 0 then panel:button({ label = "Back", on_click = back }) end
	end

	show = function()
		app:open_drawer("ask", { width = 56, min_width = 34, side = "right", render = render })
	end

	-- The notes of a file: the lines that have them, and the ones that moved.
	local function render_notes(panel)
		local path = editor.file_path()
		if not path or path == "" then return panel:label({ text = "No file open.", style = "muted" }) end
		local list = notes.list(path)
		panel:title({ text = "pi's notes · " .. util.name(path), badge = tostring(#list) })
		if #list == 0 then return panel:label({ text = "None yet: ctrl+k d on some code.", style = "muted" }) end
		local items = {}
		for i, n in ipairs(list) do
			local head = n.question ~= "" and n.question or (n.answer:match("[^\n]*") or "")
			table.insert(items, { id = "note:" .. i, label = (n.moved and "moved · " or ("line " .. n.line .. " · ")) .. util.cut(head, 36), muted = n.moved })
		end
		panel:list({
			items = items, truncate_left = false,
			on_command = function(command, node)
				if command ~= "activate" then return end
				local n = list[tonumber(tostring(node.id):match("^note:(%d+)"))]
				if not n or n.moved then return end
				editor.set_cursor(n.line, 1)
				ask_here(n.line)
			end,
		})
		panel:label({ text = "Enter: show the note on its line", style = "muted", margin_top = 1 })
	end

	local function show_notes()
		app:open_drawer("ask", { width = 56, min_width = 34, side = "right", render = render_notes })
	end

	-- A click on a gutter mark.
	app:on("notes.open", function(path, line)
		if editor.file_path() ~= path then return end
		editor.set_cursor(line, 1)
		ask_here(line)
	end)

	app:command({ id = "symbiosis.ask", title = "symbiosis: Ask pi About This Code", key = "ctrl+k d", run = function() ask_here() end })
	app:command({ id = "symbiosis.notes", title = "symbiosis: Notes of This File", run = show_notes })
	app:hint({ key = "ctrl+k d", text = "ask pi about this code", order = 75 })
	app:hint({ key = "// … why!", text = "ask pi why: the comment goes", order = 91 })

	return { ask_here = ask_here, busy = function() return cur ~= nil and (cur.status == "wait" or cur.status == "text") end }
end

return {
	name = "ask",
	needs = { "sessions", "follow", "notes" },
	setup = setup,
	-- For the tests.
	parse_why = parse_why,
	word_at = word_at,
	code_line = code_line,
	split_link = split_link,
}
