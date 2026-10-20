-- Follow and the typed preview. pi (the extension in pi/) appends events to
-- events.jsonl while the model writes each write and edit; this feature
--   * shows in the status bar which file pi writes now and the last one it
--     wrote ("pi ✎ store.ts:12 · not following");
--   * when "Editor: follows pi" is on (ctrl+k a), types each change in the
--     buffer at the speed you set (slow, medium, high, uncapped), as a
--     preview: one undo group for each run of changes to one file. At the end
--     of a run the preview is undone and the file opens again from disk: the
--     file on disk is always the truth;
--   * when it is off (the start value), types nothing and moves nothing: pi
--     writes in the background and ttt reloads a file with no unsaved changes.
--     Turning it on again jumps to now: the change pi writes now is typed from
--     its start, the changes you missed are in the change list (ctrl+k v);
--   * tells the other features which file pi has a call open in (`quiet`), so
--     autosave never saves over a write that is under way.
-- pi never waits for the editor: the preview is behind pi, and the bar says
-- how many changes ("2 behind"); ctrl+k space skips to now.
-- Rules: a buffer with unsaved changes is never typed in; while a run is
-- typed in a file, your typing there waits. See docs/design.md.
--
-- Hooks it emits: "follow" (path) when the editor followed pi into a file;
-- "start", "abort" and "done" (event) when pi starts, drops or finishes a call;
-- "shown" (event) when you see a change pi finished: at once when not
-- following, else when the preview has typed it and the file is from disk.
-- Other features may hold the preview and autosave (follow.hold) or lock a
-- file against your typing (follow.lock): helpi! writes its answer in the buffer.
local ttt = require("ttt")
local editor = require("ttt.editor")
local fs = require("ttt.fs")
local util = require("core.util")
local buffer = require("core.buffer")
local POLL_MS = require("core.app").POLL_MS

-- Characters per second of the preview; 0 = as fast as pi sends.
local SPEEDS = { 40, 160, 640, 0 }
local SPEED_NAMES = { [40] = "slow", [160] = "medium", [640] = "high", [0] = "uncapped" }

local name = util.name

return {
	name = "follow",
	needs = { "sessions" },
	setup = function(app)
		local settings, channel = app.settings, app.channel
		local sessions = app:need("sessions")
		local open = {}        -- path -> the number of calls pi has open in it
		local here = nil       -- {path, line, mark}: where pi is, for the status bar
		local writing = nil    -- the file pi writes now
		local live = {}        -- call id -> {ev, keys, values, ready}: pi's calls not done yet, as they are now
		local order = {}       -- the call ids of `live`, in the order they started
		local disk = {}        -- path -> the sum of the file after pi's last change
		local calls = {}       -- call id -> call: the calls the preview has started
		local run = nil        -- {path, line, calls, changed}: the file being typed, one undo group
		local active = nil     -- the call the preview types now (in `run`)
		local queue = {}       -- the events to type, in order
		local qhead = 1
		local budget = 0       -- the characters the preview may type now
		local behind = 0       -- the changes pi made that the preview has not shown yet
		local held = nil       -- a timer: "your typing waits" stays in the bar for a while
		local holds = {}       -- fn() -> true: a feature writes in the buffer (a helpi! answer)
		local locks = {}       -- fn(path) -> true: your typing in that file waits
		local show, finish, jump, drop_queue

		local function following() return settings:get("follow") end

		local function emit_follow(path) app:emit("follow", path) end
		local function shown(ev) app:emit("shown", ev) end

		-- The step of pi's plan that is under way: "step 2/5 add the store".
		local function step_now()
			local owner = sessions.owner()
			local steps = owner and type(owner.plan) == "table" and owner.plan or {}
			for i, s in ipairs(steps) do
				if s.state == "now" and type(s.text) == "string" then
					return string.format("step %d/%d %s", i, #steps, util.cut(s.text, 24))
				end
			end
			return nil
		end

		-- Settings -----------------------------------------------------------------

		settings:define("speed", {
			values = SPEEDS, default = 2, label = "Preview speed", order = 10, steps = true,
			text = function(cps)
				return cps == 0 and SPEED_NAMES[cps] or string.format("%s (%d/s)", SPEED_NAMES[cps], cps)
			end,
			on_change = function() show() end,
		})

		-- The view -----------------------------------------------------------------

		local function toggle() settings:cycle("follow") end

		local function show_speed()
			if not following() then return ttt.remove_status_item("symbiosis.speed") end
			local text = "▶ " .. SPEED_NAMES[settings:get("speed")]
			if behind > 0 then text = text .. string.format(" · %d behind", behind) end
			ttt.set_status_item("left", "symbiosis.speed", text, { priority = 1001, on_click = function() settings:cycle("speed") end })
		end

		local function typing_text()
			if not (run and active) then return nil end
			local lines = 0
			for key, v in pairs(active.values) do
				local n = select(2, v:gsub("\n", ""))
				lines = lines + (key:match("%.old$") and -n or n)
			end
			local text = "✎ writing " .. name(active.path)
			if lines ~= 0 then text = text .. string.format(" %+d line%s", lines, math.abs(lines) == 1 and "" or "s") end
			if active.step then text = text .. " · " .. active.step end
			return text
		end

		-- `text`: one thing to say now (helpi! "thinks"), in place of the file; the next show() clears it.
		show = function(text)
			local mode = following() and "following" or "not following"
			if held then mode = mode .. " · your typing waits" end
			local what = text or typing_text()
			if not what and writing then what = "✎ writing " .. name(writing) end
			if not what and here then what = string.format("%s %s:%d", here.mark, name(here.path), here.line) end
			ttt.set_status_item("left", "symbiosis", "pi " .. (what and what .. " · " or "· ") .. mode, { on_click = toggle })
			show_speed()
		end

		local function go()
			if not here then return end
			ttt.open_file(here.path, here.line)
			emit_follow(here.path)
		end

		settings:define("follow", {
			values = { false, true }, label = "Editor", order = 40, persist = false,
			text = function(v) return v and "follows pi" or "stays" end,
			-- Off: the preview ends, pi writes on in the background. On: jump to now.
			on_change = function(v)
				if v then jump() else pcall(finish) drop_queue() calls = {} end
				show()
			end,
		})

		-- The preview ----------------------------------------------------------------
		-- A run: the changes that the preview shows in one file, one after the
		-- other, in one undo group. Each call types on top of the one before, so
		-- an edit finds its old text in the buffer as pi did on disk. The run ends
		-- when the preview goes to another file, at the end of the turn, or when
		-- it has shown all that pi sent: then `finish` undoes the group and opens
		-- the file again, which reloads it from disk.

		-- buffer.set_region, and: the other regions of the change below this one
		-- move with its line count.
		local function set_region(r, text)
			local d = select(2, text:gsub("\n", "")) - select(2, r.text:gsub("\n", ""))
			if d ~= 0 and active then
				for _, o in ipairs(active.regions) do
					if o ~= r and o.line > r.line then o.line = o.line + d end
				end
			end
			buffer.set_region(r, text)
		end

		-- A buffer with unsaved changes does not reload when the file changes on
		-- disk, and after the undo it is clean but old: closing the tab and
		-- opening the file again reloads it. ttt's notice about the change goes too.
		finish = function()
			local r = run
			if not r then return end
			run, active = nil, nil
			for id in pairs(r.calls) do
				local c = calls[id]
				if c then c.skip = c.skip or "ended" end
			end
			local back = buffer.on_buffer(r.path)
			editor.end_undo_group()
			if r.changed and not back then
				ttt.notify("symbiosis: " .. name(r.path) .. " did not open again; its buffer may hold the preview: do not save it", "warning")
			elseif r.changed then
				buffer.editing = true
				ttt.exec_command("editor.undo")
				ttt.exec_command("tab.close")
				buffer.editing = false
				ttt.open_file(r.path, r.line or 1)
				ttt.notify("")
			end
			for _, ev in ipairs(r.shown) do shown(ev) end
		end

		local function busy(path)
			return run ~= nil and run.path == path
		end

		local function start(ev)
			local c = { id = ev.call, tool = ev.tool, path = ev.path, step = ev.step, edits = {}, values = {}, regions = {} }
			calls[ev.call] = c
			if run and run.path ~= ev.path then finish() end
			if run then
				if not buffer.on_buffer(ev.path) then c.skip = "not opened" return end
			else
				ttt.open_file(ev.path)
				if editor.file_path() ~= ev.path then c.skip = "not opened" return end
				emit_follow(ev.path)
				local text = editor.buffer_text()
				-- Clean: the buffer is the file as pi found it, or as pi last wrote it.
				local sum = util.adler32(text)
				local clean = (ev.sum == nil and text == "") or sum == ev.sum or sum == disk[ev.path]
					or text == (fs.read(ev.path) or false)
				if not clean then
					c.skip = "unsaved"
					ttt.notify("symbiosis: " .. name(ev.path) .. " has unsaved changes; no preview", "warning")
					return
				end
				editor.begin_undo_group()
				run = { path = ev.path, calls = {}, changed = false, shown = {} }
				-- pi may already have changed the file again: show the change from the text pi started from.
				local before = ev.before or (ev.sum == nil and "" or nil)
				if before and before ~= text then
					set_region(buffer.whole(), before)
					run.changed = true
				end
			end
			run.calls[c.id] = true
			active = c
			if ev.tool == "write" then
				-- A write clears the buffer and types the new text in.
				c.region = buffer.whole()
				if c.region.text ~= "" then set_region(c.region, "") run.changed = true end
				table.insert(c.regions, c.region)
			end
		end

		local function edit_text(c, i, part, value)
			local e = c.edits[i] or {}
			c.edits[i] = e
			if e.skip then return end
			if part == "old" then
				local text = editor.buffer_text()
				local b = text:find(value, 1, true)
				if value == "" or not b or text:find(value, b + 1, true) then e.skip = true return end
				local line, col = util.position(text, b)
				e.region = { line = line, col = col, text = value }
				local el, ec = util.after(line, col, value)
				editor.set_selection(line, col, el, ec)
				buffer.reveal(line)
				run.line = line
			elseif e.region then
				editor.clear_selection()
				if not e.marked then
					e.marked = true
					table.insert(c.regions, e.region)
				end
				set_region(e.region, value)
				run.changed = true
			end
		end

		-- A text event: the value it names is its first `from` bytes, then `text`.
		local function grow(value, ev)
			return (value or ""):sub(1, ev.from) .. ev.text
		end

		local function text(ev)
			local c = calls[ev.call]
			if not c or c.skip then return end
			if not run or active ~= c or not buffer.on_buffer(c.path) then c.skip = "lost" return end
			local value = grow(c.values[ev.key], ev)
			c.values[ev.key] = value
			if ev.key == "content" then
				set_region(c.region, value)
				run.changed = true
				run.line = 1
			else
				local i, part = ev.key:match("^edits%.(%d+)%.(%a+)$")
				if i then edit_text(c, tonumber(i), part, value) end
			end
		end

		-- The call's text is all shown. The run goes on.
		local function ready(ev)
			local c = calls[ev.call]
			if not c then return end
			c.readied = true
			if active ~= c then return end
			active = nil
			if editor.file_path() == c.path then editor.clear_selection() end
		end

		-- The call will not run: its preview must go, and it is mixed with the run's.
		local function abort(ev)
			local c = calls[ev.call]
			calls[ev.call] = nil
			if c and run and run.calls[c.id] then pcall(finish) end
		end

		local function done(ev)
			calls[ev.call] = nil
			if not ev.ok then return end
			-- In a run, the buffer is the preview: the jump to the line waits for its end.
			if busy(ev.path) then
				run.line = ev.line
				table.insert(run.shown, ev)
				return
			end
			shown(ev)
			if run then return end
			ttt.open_file(ev.path, ev.line)
			emit_follow(ev.path)
		end

		local function stop(ev)
			if run then pcall(finish) end
			ttt.open_file(ev.path, ev.line)
			emit_follow(ev.path)
		end

		local typed_handlers = { start = start, text = text, ready = ready, abort = abort, done = done, stop = stop }

		-- pi now ----------------------------------------------------------------------
		-- Every event is read at once, for the status bar and the other features;
		-- while following, it also goes into the queue that the preview types.

		local function close_call(ev)
			if not live[ev.call] then return end
			live[ev.call] = nil
			local path = ev.path
			if path and open[path] then open[path] = open[path] > 1 and open[path] - 1 or nil end
			if writing == path and not open[path] then writing = nil end
		end

		local now_handlers = {
			start = function(ev)
				ev.step = step_now()
				open[ev.path] = (open[ev.path] or 0) + 1
				writing = ev.path
				live[ev.call] = { ev = ev, keys = {}, values = {} }
				table.insert(order, ev.call)
				app:emit("start", ev)
			end,
			text = function(ev)
				local l = live[ev.call]
				if not l or type(ev.text) ~= "string" or type(ev.from) ~= "number" then return end
				if l.values[ev.key] == nil then table.insert(l.keys, ev.key) end
				l.values[ev.key] = grow(l.values[ev.key], ev)
			end,
			ready = function(ev)
				local l = live[ev.call]
				if l then l.ready = true end
			end,
			abort = function(ev)
				local l = live[ev.call]
				if l then ev.path = l.ev.path close_call(ev) end
				app:emit("abort", ev)
			end,
			done = function(ev)
				close_call(ev)
				disk[ev.path] = ev.sum
				if not following() then shown(ev) end
				here = { path = ev.path, line = ev.line, mark = "✎" }
				-- ttt says the file changed on disk under the preview: not news here.
				if busy(ev.path) then
					for _, ms in ipairs({ 250, 700, 1500, 3000 }) do
						ttt.set_timeout(ms, function() if busy(ev.path) then ttt.notify("") end end)
					end
				end
				app:emit("done", ev)
			end,
			stop = function(ev)
				open, writing, live, order = {}, nil, {}, {}
				here = { path = ev.path, line = ev.line, mark = "■" }
			end,
		}

		local function guarded(op, f, ev)
			local fine, err = pcall(f, ev)
			if not fine then app.log("error", "symbiosis " .. op .. ": " .. tostring(err)) end
		end

		for op, handler in pairs(now_handlers) do
			channel:on(op, function(ev)
				guarded(op, handler, ev)
				if following() then table.insert(queue, ev) end
				show()
			end)
		end

		-- The calls pi has not finished, in the order they started, as events that
		-- type them from their start: what the preview shows when it jumps to now.
		local function now_events()
			local out, keep = {}, {}
			for _, id in ipairs(order) do
				local l = live[id]
				if l then
					table.insert(keep, id)
					table.insert(out, l.ev)
					for _, key in ipairs(l.keys) do
						table.insert(out, { op = "text", call = id, key = key, from = 0, text = l.values[key] })
					end
					if l.ready then table.insert(out, { op = "ready", call = id }) end
				end
			end
			order = keep
			return out
		end

		-- Follow on, or ctrl+k space: what is queued goes, the editor goes to where
		-- pi is, and the calls pi has not finished are typed from their start.
		-- The changes not typed yet go; their whys show now.
		drop_queue = function()
			for i = qhead, #queue do
				local ev = queue[i]
				if ev.op == "done" and ev.ok then shown(ev) end
			end
			queue, qhead, budget = {}, 1, 0
		end

		jump = function()
			pcall(finish)
			drop_queue()
			calls = {}
			queue = now_events()
			if #queue == 0 then go() end
		end

		-- The loop ------------------------------------------------------------------
		-- Text that the preview shows costs characters from a budget that grows
		-- every tick; every other event costs nothing but waits for the text before it.

		-- True when `ev` types text that the preview shows: a write's content or an
		-- edit's new text. An edit's old text is only selected.
		local function typed(ev)
			if ev.op ~= "text" or type(ev.text) ~= "string" then return false end
			local c = calls[ev.call]
			if not c or c.skip then return false end
			return ev.key == "content" or ev.key:match("%.new$") ~= nil
		end

		local function apply(ev)
			local f = typed_handlers[ev.op]
			if f then guarded(ev.op, f, ev) end
		end

		-- True when the run has nothing left to type: every call in it was shown.
		local function run_done()
			if not run then return false end
			for id in pairs(run.calls) do
				local c = calls[id]
				if c and not c.readied then return false end
			end
			return true
		end

		local function count_behind()
			local n = 0
			for i = qhead, #queue do
				if queue[i].op == "start" then n = n + 1 end
			end
			if n ~= behind then
				behind = n
				show()
			end
		end

		local function held_by_others()
			for _, h in ipairs(holds) do
				if h.fn() then return true end
			end
			return false
		end

		local function pace()
			if not following() or held_by_others() then return count_behind() end
			local cps = settings:get("speed")
			local typed_before = active and active.values
			-- At most 0.2 s of typing saved up: no burst after a quiet moment.
			if cps > 0 then budget = math.min(budget + cps * POLL_MS / 1000, math.max(cps / 5, 1)) end
			while qhead <= #queue do
				local ev = queue[qhead]
				local n = math.floor(budget)
				if cps == 0 or not typed(ev) then
					apply(ev)
					qhead = qhead + 1
				else
					local len = util.runes(ev.text)
					if len > n and n <= 0 then break end
					if len <= n then
						budget = budget - len
						apply(ev)
						qhead = qhead + 1
					else
						-- Type the first n characters; the rest waits for the next tick.
						local b = util.rune_bytes(ev.text, n)
						apply({ op = "text", call = ev.call, key = ev.key, from = ev.from, text = ev.text:sub(1, b) })
						ev.from = ev.from + b
						ev.text = ev.text:sub(b + 1)
						budget = budget - n
						break
					end
				end
			end
			if qhead > #queue then
				queue, qhead = {}, 1
				-- All that pi sent is shown: the run ends, the buffer comes from disk.
				if run_done() then guarded("finish", finish) end
			end
			count_behind()
			if run or typed_before then show() end
		end

		-- ctrl+k space: the changes not shown yet go; the preview types what pi writes now.
		local function skip_to_now()
			if not following() then return settings:cycle("follow") end
			jump()
			show()
		end

		-- Your typing --------------------------------------------------------------

		local function locked(path)
			if run and path == run.path then return true end
			for _, l in ipairs(locks) do
				if l.fn(path) then return true end
			end
			return false
		end

		-- While the preview or a feature writes in this file, your typing waits. Moves still work.
		app:on("key", function(key)
			if locked(editor.file_path()) and util.changes_buffer(key) then
				if held then ttt.clear_timeout(held) end
				held = ttt.set_timeout(1500, function() held = nil show() end)
				show()
				return true
			end
			return false
		end, 50)

		app:on("tick", pace)
		-- A feature that failed: its holds and locks go.
		app:on("drop", function(owner)
			local function keep(list)
				for i = #list, 1, -1 do
					if list[i].owner == owner then table.remove(list, i) end
				end
			end
			keep(holds)
			keep(locks)
		end)
		app:on("ready", function() show() end)

		app:command({ id = "symbiosis.toggleFollow", title = "symbiosis: Editor Follows pi / Stays", key = "ctrl+k a", run = toggle })
		app:command({ id = "symbiosis.goToAgent", title = "symbiosis: Go to the Agent's Last Edit", run = go })
		app:command({ id = "symbiosis.slower", title = "symbiosis: Preview Slower", key = "ctrl+k -", run = function() settings:step("speed", -1) end })
		app:command({ id = "symbiosis.faster", title = "symbiosis: Preview Faster", key = "ctrl+k =", run = function() settings:step("speed", 1) end })
		app:command({ id = "symbiosis.skipToNow", title = "symbiosis: Preview Skips to What pi Writes Now", key = "ctrl+k space", run = skip_to_now })
		app:hint({ key = "ctrl+k a", text = "the editor follows pi (typed preview) / stays", order = 30 })
		app:hint({ key = "ctrl+k - / =", text = "preview slower / faster", order = 40 })
		app:hint({ key = "ctrl+k space", text = "preview skips to now", order = 50 })

		return {
			show = show,
			finish = finish,
			-- The file the preview types in, or pi has a call open in, or wrote last, for the "pi files" panel.
			now_path = function() return (run and run.path) or writing or (here and here.path) end,
			-- pi has a call open, or the preview types.
			running = function() return next(open) ~= nil or run ~= nil end,
			-- pi has a call open in this file.
			editing = function(path) return open[path] ~= nil end,
			-- pi has no call open in `path`, the preview does not type there, and no feature writes in the buffer.
			quiet = function(path)
				return not open[path] and not busy(path) and not held_by_others()
			end,
			-- `fn` belongs to the feature that sets up now: it goes when that one is dropped.
			hold = function(fn) table.insert(holds, { fn = fn, owner = app.current }) end,
			lock = function(fn) table.insert(locks, { fn = fn, owner = app.current }) end,
		}
	end,
}
