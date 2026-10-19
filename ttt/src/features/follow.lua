-- Follow. pi (the extension in pi/) appends events to events.jsonl; this
-- feature
--   * shows in the status bar which file pi writes now and the last one it
--     wrote ("pi ✎ store.ts:12 · not following");
--   * opens the file at the changed line when "Editor: follows pi" is on
--     (ctrl+k a). It is off at the start: the editor stays where you are, so
--     you can read code while pi writes more. pi writes to disk at once and
--     never waits for the editor; ttt reloads a file that has no unsaved
--     changes;
--   * tells the other features which file pi has a call open in (`quiet`), so
--     autosave never saves over a write that is under way.
--
-- Hooks it emits: "follow" (path) when the editor followed pi into a file;
-- "done" (event) when pi finished a change (its `why` too).
-- Other features may hold autosave (follow.hold) or lock a file against
-- your typing (follow.lock): helpi! writes its answer in the buffer.
local ttt = require("ttt")
local editor = require("ttt.editor")
local util = require("core.util")

local name = util.name

return {
	name = "follow",
	setup = function(app)
		local settings, channel = app.settings, app.channel
		local open = {}        -- path -> the number of calls pi has open in it
		local here = nil       -- {path, line, mark}: what the status bar shows
		local writing = nil    -- the file pi writes now
		local held = nil       -- a timer: "your typing waits" stays in the bar for a while
		local holds = {}       -- fn() -> true: a feature writes in the buffer (a helpi! answer)
		local locks = {}       -- fn(path) -> true: your typing in that file waits
		local show

		local function following() return settings:get("follow") end

		local function emit_follow(path) app:emit("follow", path) end

		-- The view -----------------------------------------------------------------

		local function toggle() settings:cycle("follow") end

		-- `text`: one thing to say now (helpi! "thinks"), in place of the file; the next show() clears it.
		show = function(text)
			local mode = following() and "following" or "not following"
			if held then mode = mode .. " · your typing waits" end
			if text then
				ttt.set_status_item("left", "symbiosis", "pi " .. text .. " · " .. mode, { on_click = toggle })
			elseif writing then
				ttt.set_status_item("left", "symbiosis", "pi ✎ writing " .. name(writing) .. " · " .. mode, { on_click = toggle })
			elseif here then
				ttt.set_status_item("left", "symbiosis", string.format("pi %s %s:%d · %s", here.mark, name(here.path), here.line, mode), { on_click = toggle })
			else
				ttt.set_status_item("left", "symbiosis", "pi · " .. mode, { on_click = toggle })
			end
		end

		local function go()
			if not here then return end
			ttt.open_file(here.path, here.line)
			emit_follow(here.path)
		end

		settings:define("follow", {
			values = { false, true }, label = "Editor", order = 40, persist = false,
			text = function(v) return v and "follows pi" or "stays" end,
			-- Turning it on goes to where pi is now.
			on_change = function(v)
				if v then go() end
				show()
			end,
		})

		-- pi's calls -----------------------------------------------------------------

		local function start(ev)
			open[ev.path] = (open[ev.path] or 0) + 1
			writing = ev.path
			-- The features that want to know (the change list marks the file).
			app:emit("start", ev)
			show()
		end

		local function done(ev)
			if open[ev.path] then
				open[ev.path] = open[ev.path] > 1 and open[ev.path] - 1 or nil
			end
			if writing == ev.path and not open[ev.path] then writing = nil end
			here = { path = ev.path, line = ev.line, mark = "✎" }
			-- The features that want to know (fill: pi's why).
			app:emit("done", ev)
			if ev.ok and following() then
				ttt.open_file(ev.path, ev.line)
				emit_follow(ev.path)
			end
			show()
		end

		-- The end of pi's turn: nothing is open any more.
		local function stop(ev)
			open, writing = {}, nil
			here = { path = ev.path, line = ev.line, mark = "■" }
			if following() then
				ttt.open_file(ev.path, ev.line)
				emit_follow(ev.path)
			end
			show()
		end

		local handlers = { start = start, done = done, stop = stop }
		for op, handler in pairs(handlers) do
			channel:on(op, function(ev)
				local fine, err = pcall(handler, ev)
				if not fine then app.log("error", "symbiosis " .. op .. ": " .. tostring(err)) end
			end)
		end

		-- Your typing --------------------------------------------------------------

		local function locked(path)
			for _, l in ipairs(locks) do
				if l.fn(path) then return true end
			end
			return false
		end

		local function held_by_others()
			for _, h in ipairs(holds) do
				if h.fn() then return true end
			end
			return false
		end

		-- While a feature writes in this file (a helpi! answer), your typing waits. Moves still work.
		app:on("key", function(key)
			if locked(editor.file_path()) and util.changes_buffer(key) then
				if held then ttt.clear_timeout(held) end
				held = ttt.set_timeout(1500, function() held = nil show() end)
				show()
				return true
			end
			return false
		end, 50)

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
		app:hint({ key = "ctrl+k a", text = "the editor follows pi / stays", order = 30 })

		return {
			show = show,
			-- The file pi has a call open in, or wrote last, for the "pi files" panel.
			now_path = function() return writing or (here and here.path) end,
			-- pi has a call open in some file.
			running = function() return next(open) ~= nil end,
			-- pi has a call open in this file.
			editing = function(path) return open[path] ~= nil end,
			-- pi has no call open in `path`, and no feature writes in the buffer.
			quiet = function(path)
				return not open[path] and not held_by_others()
			end,
			-- `fn` belongs to the feature that sets up now: it goes when that one is dropped.
			hold = function(fn) table.insert(holds, { fn = fn, owner = app.current }) end,
			lock = function(fn) table.insert(locks, { fn = fn, owner = app.current }) end,
		}
	end,
}
