-- The replay. pi (the extension in pi/) appends events to events.jsonl; this
-- feature
--   * replays each write and edit in the buffer at the speed you set, as a
--     preview: one undo group for each run of changes to one file;
--   * writes ack.json when it has shown a change. pi does not wait for the
--     editor: it waits only when more changes than your limit (`lag`) are
--     not shown yet. So the file on disk is where pi is now, and the buffer
--     is the replay, behind it;
--   * at the end of a run: undoes the preview and opens the file again from
--     disk: the file on disk is always the truth;
--   * follows the result: opens the file at the changed line.
-- Rules: a buffer with unsaved changes is never touched; while a run is
-- replayed in a file, your typing there waits; pinned (ctrl+k a) means no
-- preview and no jumps, but the end of the turn (a stop) moves the editor
-- anyway. See docs/design.md.
--
-- Hooks it emits: "follow" (path) when the editor followed pi into a file.
-- replay.typing() is the change typed now, for the gutter (features/marks.lua).
-- Other features may hold the replay (replay.hold) or lock a file against
-- your typing (replay.lock).
local ttt = require("ttt")
local editor = require("ttt.editor")
local util = require("core.util")
local buffer = require("core.buffer")
local POLL_MS = require("core.app").POLL_MS

-- Typing speeds of the preview, in characters per second; 0 = as fast as pi sends.
local SPEEDS = { 10, 20, 40, 80, 160, 320, 640, 1280, 0 }
-- How many changes pi may make that the editor has not shown yet; -1 = no limit.
-- 0 = pi waits for each change, as it did before.
local LAGS = { 0, 3, 10, -1 }

local name = util.name

return {
	name = "replay",
	setup = function(app)
		local settings, channel = app.settings, app.channel
		local calls = {}       -- call id -> call
		local run = nil        -- {path, line, calls, changed}: the file being replayed, one undo group
		local active = nil     -- the call the replay types now (in `run`)
		local disk = {}        -- path -> the sum of the file after pi's last change, as read
		local acks = {}        -- the last call ids acknowledged
		local here = nil       -- {path, line, mark}: what the status bar shows
		local paused = false   -- ctrl+k space: the replay stops; pi goes on up to the lag limit
		local behind = 0       -- the changes pi made that the replay has not shown yet
		local queue = {}       -- the events read from the log, not yet applied
		local qhead = 1
		local budget = 0       -- the characters the preview may type now
		local rush = nil       -- ctrl+k .: the call whose preview shows at once
		local held = nil       -- a timer: "your typing waits" stays in the bar for a while
		local holds = {}       -- fn() -> true: the replay waits (a helpi! answer is written)
		local locks = {}       -- fn(path) -> true: your typing in that file waits
		local show, finish

		local function pinned() return settings:get("pin") end

		local function follow(path) app:emit("follow", path) end

		-- Settings ---------------------------------------------------------------

		settings:define("speed", {
			values = SPEEDS, default = 5, label = "Replay speed", order = 10, steps = true,
			text = function(cps) return cps == 0 and "max" or string.format("%d/s", cps) end,
			on_change = function() show() end,
		})
		settings:define("lag", {
			values = LAGS, default = 2, label = "pi ahead (max)", order = 20,
			text = function(n)
				if n < 0 then return "no limit" end
				if n == 0 then return "0 (pi waits for each change)" end
				return string.format("%d changes", n)
			end,
			-- How far pi may run ahead of the replay. pi reads it from ttt.json.
			on_change = function() channel:heartbeat() end,
		})

		-- The view -----------------------------------------------------------------

		local function pace_text()
			local text = paused and "⏸ paused" or "▶ " .. settings:text("speed")
			if behind > 0 then text = text .. string.format(" · %d behind", behind) end
			return text
		end

		local function toggle_pin() settings:cycle("pin") end

		show = function(text)
			local mode = pinned() and "pinned" or "following"
			if held then mode = mode .. " · your typing waits" end
			ttt.set_status_item("left", "symbiosis.speed", pace_text(), { priority = 1001, on_click = function() settings:cycle("speed") end })
			if text then
				ttt.set_status_item("left", "symbiosis", "pi " .. text .. " · " .. mode, { on_click = toggle_pin })
			elseif here then
				ttt.set_status_item("left", "symbiosis", string.format("pi %s %s:%d · %s", here.mark, name(here.path), here.line, mode), { on_click = toggle_pin })
			else
				ttt.set_status_item("left", "symbiosis", "pi · " .. mode, { on_click = toggle_pin })
			end
		end

		local function go()
			if not here then return end
			ttt.open_file(here.path, here.line)
			follow(here.path)
		end

		settings:define("pin", {
			values = { false, true }, label = "Editor", order = 40, persist = false,
			text = function(v) return v and "pinned" or "follows pi" end,
			-- Pinning ends the replay; leaving the pin goes to where the agent is now.
			on_change = function(v)
				if v and run then finish() end
				if not v then go() end
				show()
			end,
		})

		-- Calls ---------------------------------------------------------------------
		-- A run: the changes that the replay shows in one file, one after the other,
		-- in one undo group. Each call types on top of the one before, so an edit
		-- finds its old text in the buffer as pi did on disk. The run ends when the
		-- replay goes to another file, at the end of the turn, or when it has shown
		-- all that pi sent: then `finish` undoes the group and opens the file again,
		-- which reloads it from disk.

		-- buffer.set_region, and: the other regions of the change below this one
		-- move with its line count; run.at is the line the cursor ends on.
		local function set_region(r, text)
			local d = select(2, text:gsub("\n", "")) - select(2, r.text:gsub("\n", ""))
			if d ~= 0 and active and active.regions then
				for _, o in ipairs(active.regions) do
					if o ~= r and o.line > r.line then o.line = o.line + d end
				end
			end
			buffer.set_region(r, text)
			if run then run.at = (util.after(r.line, r.col, text)) end
		end

		local function ack(id)
			table.insert(acks, id)
			while #acks > 200 do table.remove(acks, 1) end
			channel:write_json("ack.json", acks)
		end

		-- Ends the run: the preview is undone and the file comes from disk again.
		-- A buffer with unsaved changes does not reload when the file changes on
		-- disk, and after the undo it is clean but old: closing the tab and opening
		-- the file again reloads it. ttt's notice about the change on disk goes too.
		finish = function()
			local r = run
			if not r then return end
			run, active = nil, nil
			for id in pairs(r.calls) do
				local c = calls[id]
				if c then c.skip = c.skip or "ended" end
			end
			editor.end_undo_group()
			if not r.changed or not buffer.on_buffer(r.path) then return end
			buffer.editing = true
			ttt.exec_command("editor.undo")
			ttt.exec_command("tab.close")
			buffer.editing = false
			local line = here and here.path == r.path and here.line or r.line or 1
			ttt.open_file(r.path, line)
			ttt.notify("")
		end

		local function busy(path)
			return run ~= nil and run.path == path
		end

		local function start(ev)
			local c = { id = ev.call, tool = ev.tool, path = ev.path, edits = {}, values = {}, regions = {} }
			calls[ev.call] = c
			if pinned() then c.skip = "pinned" return end
			if run and run.path ~= ev.path then finish() end
			if run then
				-- The next change in the same file: it types on top of the one before.
				if not buffer.on_buffer(ev.path) then c.skip = "not opened" return end
			else
				ttt.open_file(ev.path)
				if editor.file_path() ~= ev.path then c.skip = "not opened" return end
				follow(ev.path)
				local text = editor.buffer_text()
				-- Clean: the buffer is the file as pi found it, or as pi last wrote it
				-- (a clean buffer reloads when pi is ahead of the replay).
				local sum = util.adler32(text)
				local clean = (ev.sum == nil and text == "") or sum == ev.sum or sum == disk[ev.path]
				if not clean then
					c.skip = "unsaved"
					ttt.notify("symbiosis: " .. name(ev.path) .. " has unsaved changes; no preview", "warning")
					return
				end
				editor.begin_undo_group()
				run = { path = ev.path, calls = {}, changed = false }
				-- pi may already have changed the file again: show the change from
				-- the text pi started from.
				local before = ev.before or (ev.sum == nil and "" or nil)
				if before and before ~= text then
					buffer.editing = true
					set_region(buffer.whole(), before)
					buffer.editing = false
					run.changed = true
				end
			end
			run.calls[c.id] = true
			active = c
			show("✎ writing " .. name(ev.path))
			if ev.tool == "write" then
				-- A full write clears the buffer and types the new text in.
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
				run.line, run.at = line, line
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

		-- Applies a text event to the value it names: its first `from` bytes, then `text`.
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
			local lines = select(2, value:gsub("\n", ""))
			show(string.format("✎ writing %s +%d lines", name(c.path), lines))
		end

		-- The call's text is all shown: acknowledge it. The run goes on.
		local function ready(ev)
			local c = calls[ev.call]
			if c then
				c.readied = true
				if active == c then active = nil end
				if editor.file_path() == c.path then editor.clear_selection() end
			end
			if rush == ev.call then rush = nil end
			ack(ev.call)
		end

		-- The call will not run: its preview must go, and it is mixed with the run's.
		local function abort(ev)
			local c = calls[ev.call]
			calls[ev.call] = nil
			if rush == ev.call then rush = nil end
			if c and run and run.calls[c.id] then pcall(finish) end
		end

		local function done(ev)
			calls[ev.call] = nil
			here = { path = ev.path, line = ev.line, mark = "✎" }
			if not ev.ok then return show() end
			-- In a run, the buffer is the replay: the jump waits for its end.
			if busy(ev.path) then run.line = ev.line return show() end
			if run then return show() end
			-- A new file shown before it existed reloads only when opened again.
			if not pinned() then
				ttt.open_file(ev.path, ev.line)
				follow(ev.path)
			end
			show()
		end

		local function stop(ev)
			if run then pcall(finish) end
			here = { path = ev.path, line = ev.line, mark = "■" }
			ttt.open_file(ev.path, ev.line)
			follow(ev.path)
			show()
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

		local handlers = { start = start, text = text, ready = ready, abort = abort, done = done, stop = stop }

		-- The loop ------------------------------------------------------------------
		-- The channel hands the events to `read`, into the queue; pace() applies
		-- them. Text that the preview shows is typed at the speed you set: it costs
		-- characters from a budget that grows every tick. All other events cost
		-- nothing, but wait for the text before them. So `ready` comes after the
		-- last character, and pi, which waits for its ack, writes the file only
		-- when you have seen it all.

		local function read(ev)
			table.insert(queue, ev)
			-- pi changed the file now; the replay may be behind.
			if ev.op == "done" then
				disk[ev.path] = ev.sum
				-- ttt says the file changed on disk under the replay: not news here.
				if busy(ev.path) then
					for _, ms in ipairs({ 250, 700 }) do
						ttt.set_timeout(ms, function() if busy(ev.path) then ttt.notify("") end end)
					end
				end
			end
		end
		for op in pairs(handlers) do channel:on(op, read) end

		local function apply(ev)
			local fine, err = pcall(handlers[ev.op], ev)
			if not fine then app.log("error", "symbiosis " .. ev.op .. ": " .. tostring(err)) end
		end

		-- True when `ev` types text that the preview shows: a write's content or an
		-- edit's new text. An edit's old text is only selected.
		local function typed(ev)
			if ev.op ~= "text" or type(ev.text) ~= "string" then return false end
			local c = calls[ev.call]
			if not c or c.skip then return false end
			return ev.key == "content" or ev.key:match("%.new$") ~= nil
		end

		-- The changes pi made (it sent `ready`) that the replay has not shown yet.
		local function count_behind()
			local n = 0
			for i = qhead, #queue do
				if queue[i].op == "ready" then n = n + 1 end
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
			-- Another feature writes in the buffer (a helpi! answer): the replay waits.
			if paused or held_by_others() then return count_behind() end
			local cps = settings:get("speed")
			-- At most 0.2 s of typing saved up: no burst after a quiet moment.
			if cps > 0 then budget = math.min(budget + cps * POLL_MS / 1000, math.max(cps / 5, 1)) end
			while qhead <= #queue do
				local ev = queue[qhead]
				local n = math.floor(budget)
				if cps == 0 or ev.call == rush or not typed(ev) then
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
				if run_done() then
					local fine, err = pcall(finish)
					if not fine then app.log("error", "symbiosis finish: " .. tostring(err)) end
				end
			end
			count_behind()
		end

		-- ctrl+k space: the replay stops where it is; pi goes on up to the lag limit.
		local function toggle_pause()
			paused = not paused
			show()
		end

		-- ctrl+k .: the rest of this call's preview shows at once, also what pi has
		-- not sent yet. The next call is typed at your speed again.
		local function rush_now()
			rush = active and active.id or (queue[qhead] and queue[qhead].call)
			paused = false
			pace()
			show()
		end

		local function locked(path)
			if run and path == run.path then return true end
			for _, l in ipairs(locks) do
				if l.fn(path) then return true end
			end
			return false
		end

		-- While the replay runs in this file, your typing waits: the buffer is the
		-- replay, and pi has already changed the file on disk. Moves still work.
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
		channel:heartbeat_field(function(fields)
			fields.pinned = pinned()
			fields.lag = settings:get("lag")
		end)

		app:command({ id = "symbiosis.togglePin", title = "symbiosis: Pin / Unpin the Editor", key = "ctrl+k a", run = toggle_pin })
		app:command({ id = "symbiosis.goToAgent", title = "symbiosis: Go to the Agent's Last Edit", run = go })
		app:command({ id = "symbiosis.slower", title = "symbiosis: Preview Slower", key = "ctrl+k -", run = function() settings:step("speed", -1) end })
		app:command({ id = "symbiosis.faster", title = "symbiosis: Preview Faster", key = "ctrl+k =", run = function() settings:step("speed", 1) end })
		app:command({ id = "symbiosis.pause", title = "symbiosis: Pause / Go On (pi waits)", key = "ctrl+k space", run = toggle_pause })
		app:command({ id = "symbiosis.rush", title = "symbiosis: Show the Rest of the Preview Now", key = "ctrl+k .", run = rush_now })
		app:hint({ key = "ctrl+k a", text = "pin / unpin the editor", order = 30 })
		app:hint({ key = "ctrl+k - / =", text = "preview slower / faster", order = 40 })
		app:hint({ key = "ctrl+k space", text = "pause the replay", order = 50 })
		app:hint({ key = "ctrl+k .", text = "rest of this change at once", order = 60 })

		return {
			show = show,
			finish = finish,
			busy = busy,
			running = function() return run ~= nil end,
			-- The change typed now: {path, regions, at}, or nil.
			typing = function()
				if not (run and active) then return nil end
				return { path = active.path, regions = active.regions, at = run.at }
			end,
			-- The file pi changes now, for the "pi files" panel.
			now_path = function() return run and run.path or (here and here.path) end,
			-- Nothing of the replay is under way for `path`: no call, no queue, no hold.
			quiet = function(path)
				if active or busy(path) or qhead <= #queue or held_by_others() then return false end
				for _, c in pairs(calls) do
					if c.path == path then return false end
				end
				return true
			end,
			-- `fn` belongs to the feature that sets up now: it goes when that one is dropped.
			hold = function(fn) table.insert(holds, { fn = fn, owner = app.current }) end,
			lock = function(fn) table.insert(locks, { fn = fn, owner = app.current }) end,
		}
	end,
}
