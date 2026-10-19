-- Sessions: each pi writes sessions/<id>.json. The editor follows one of
-- them, the owner: the session whose folder holds the open file (the most
-- recent one if several do), or the one you chose with ctrl+k n. Only the
-- owner writes events and answers helpi!. "detached" is a choice too: the
-- editor follows no pi (the status bar says so), and no pi writes events or
-- gets questions; pi itself runs on. ctrl+k g goes to its herdr or tmux
-- pane, ctrl+k q stops its turn (stop.json), and the bar says when it waits
-- on a dialog in its own pane.
--
-- Hooks it emits: "sessions" after each refresh (the list or the owner may
-- have changed).
local ttt = require("ttt")
local editor = require("ttt.editor")
local fs = require("ttt.fs")
local json = require("ttt.json")
local system = require("ttt.system")
local util = require("core.util")
local wrap = require("core.wrap")
local channel_mod = require("core.channel")

local PROTOCOL = channel_mod.PROTOCOL

-- `chosen` when you detached the editor from every pi: no owner at all.
local DETACHED = "-"

-- Reads sessions/: the records with a heartbeat in the last 3 seconds.
local function load(dir)
	local list = {}
	local entries = fs.list(dir) or {}
	for _, e in ipairs(entries) do
		if not e.is_dir and e.name:match("%.json$") then
			local raw = fs.read(dir .. "/" .. e.name)
			local ok, rec = pcall(json.decode, raw or "")
			if ok and type(rec) == "table" and rec.id and type(rec.t) == "number" and os.time() - rec.t < 4 then
				table.insert(list, rec)
			end
		end
	end
	-- The name shown: pi's session name (/name), else the folder. When two
	-- sessions would show the same name, the herdr pane (or pid) tells them apart.
	local count = {}
	for _, rec in ipairs(list) do
		rec.folder = rec.name
		if type(rec.title) == "string" and rec.title ~= "" then rec.name = rec.title end
		count[rec.name] = (count[rec.name] or 0) + 1
	end
	for _, rec in ipairs(list) do
		if count[rec.name] > 1 then rec.name = rec.name .. " · " .. (rec.pane or tostring(rec.pid)) end
	end
	table.sort(list, function(a, b)
		if a.name ~= b.name then return a.name < b.name end
		return a.id < b.id
	end)
	return list
end

local function wrote(rec, path)
	if type(rec.files) ~= "table" then return false end
	for _, p in ipairs(rec.files) do
		if p == path then return true end
	end
	return false
end

-- The session the editor follows, for the file at `path`:
--   0. none, when you detached (ctrl+k n, the panel);
--   1. the one you chose (ctrl+k n);
--   2. else the one that wrote or edited the file, the most recent;
--   3. else the one whose folder holds the file, the deepest folder, then the
--      most recent;
--   4. else the most recent one: the editor stays with the agent.
-- Returns the session, and true for 4 (for the status bar), and whether the
-- chosen one is still there.
local function pick(sessions, chosen, path)
	if chosen == DETACHED then return nil, false, true end
	for _, rec in ipairs(sessions) do
		if rec.id == chosen then return rec, false, true end
	end
	local writer, best, latest = nil, nil, nil
	for _, rec in ipairs(sessions) do
		local active = rec.active or 0
		if not latest or active > (latest.active or 0) then latest = rec end
		if path ~= "" and wrote(rec, path) and (not writer or active > (writer.active or 0)) then writer = rec end
		if path ~= "" and util.starts_with(path, rec.cwd .. "/")
			and (not best or #rec.cwd > #best.cwd or (#rec.cwd == #best.cwd and active > (best.active or 0))) then
			best = rec
		end
	end
	if writer or best then return writer or best, false, false end
	return latest, latest ~= nil and path ~= "", false
end

-- The plan step under way, for the session list.
local function now_step(rec)
	if type(rec.plan) ~= "table" then return "" end
	for _, st in ipairs(rec.plan) do
		if st.state == "now" then return " — " .. st.text end
	end
	return ""
end

return {
	name = "sessions",
	pick = pick, -- for the unit tests
	DETACHED = DETACHED,
	setup = function(app)
		local DIR = app.channel:path("sessions")
		local sessions = {} -- the live pi sessions, by name
		local owner = nil   -- the session the editor follows
		local chosen = nil  -- the id you chose with ctrl+k n; nil = by the open file
		local outside = false -- the owner is only the most recent session, not this file's
		local waiting_said = nil -- the dialog the notice told about
		local go_session

		local function show()
			local text
			if chosen == DETACHED then
				text = "π detached"
			elseif not owner then
				text = "π none"
			else
				local waiting = type(owner.waiting) == "string" and owner.waiting or nil
				-- pi shows a dialog in its own pane: a notice says so for 5 s, then the
				-- bar keeps it.
				if waiting and waiting_said ~= owner.id .. waiting then
					local said = owner.id .. waiting
					waiting_said = said
					ttt.notify("symbiosis: pi " .. owner.name .. " waits for you: " .. waiting .. " (ctrl+k g goes there)", "info")
					-- Measured: here the notice stays (a bare plugin's goes in about 4 s).
					ttt.set_timeout(5000, function()
						if waiting_said == said then ttt.notify("") end
					end)
				elseif not waiting and waiting_said then
					-- The notice goes with the dialog.
					waiting_said = nil
					ttt.notify("")
				end
				text = "π " .. owner.name .. (waiting and " ? waits for you" or owner.working and " ● working" or " ○ idle")
				local fill = owner.fill
				if type(fill) == "table" and fill.name then
					text = text .. (fill.kind == "place" and " · writing " or " · filling ") .. fill.name
				end
				if owner.version ~= PROTOCOL then text = "π " .. owner.name .. " · old, /reload" end
				if chosen then text = text .. " (chosen)"
				elseif outside then text = text .. " (outside its folder)" end
			end
			ttt.set_status_item("left", "symbiosis.session", text, { priority = 900, on_click = function() go_session() end })
		end

		local function refresh()
			sessions = load(DIR)
			local before = owner and owner.id
			local still
			owner, outside, still = pick(sessions, chosen, editor.file_path() or "")
			if not still then chosen = nil end
			if (owner and owner.id) ~= before then app.channel:heartbeat() end
			app:emit("sessions")
			show()
		end

		-- ctrl+k n: the next session takes over; after the last one, "detached";
		-- then back to "by the open file".
		local function next_session()
			sessions = load(DIR)
			if #sessions == 0 and chosen ~= DETACHED then
				ttt.notify("symbiosis: no pi session is running", "warning")
				return refresh()
			end
			if chosen == DETACHED then
				chosen = nil
			else
				local i = 0
				for k, rec in ipairs(sessions) do
					if rec.id == chosen then i = k end
				end
				local nxt = sessions[i + 1]
				chosen = nxt and nxt.id or DETACHED
			end
			-- No notice: a notice covers the status bar for 4 s, and the bar shows it.
			refresh()
		end

		-- The editor follows no pi, or follows one again (by the open file).
		local function toggle_detach()
			chosen = chosen ~= DETACHED and DETACHED or nil
			refresh()
		end

		-- ctrl+k g, or a click on "π ...": go to the owner's pane in herdr or tmux.
		go_session = function()
			-- "π detached": a click follows pi again.
			if chosen == DETACHED then return toggle_detach() end
			if not owner then
				return ttt.notify("symbiosis: no pi session is running", "warning")
			end
			if not owner.pane then
				return ttt.notify("symbiosis: pi " .. owner.name .. " does not run in herdr or tmux", "warning")
			end
			local binary, args = "herdr", { "agent", "focus", owner.pane }
			if owner.host == "tmux" then
				binary, args = "tmux", { "select-window", "-t", owner.pane, ";", "select-pane", "-t", owner.pane }
			end
			local pane = owner.pane
			system.exec_async(binary, args, function(result)
				if result.exit_code ~= 0 then
					ttt.notify("symbiosis: " .. binary .. " could not focus " .. pane .. ": " .. (result.stderr or ""), "error")
				end
			end)
		end

		-- ctrl+k q: stop the owner's turn, as Esc in pi does. pi reads stop.json.
		local stops = 0
		local function stop_pi()
			if not owner then
				return ttt.notify("symbiosis: no pi session is running", "warning")
			end
			if not owner.working then
				return ttt.notify("symbiosis: pi " .. owner.name .. " is idle", "info")
			end
			stops = stops + 1
			app.channel:write_json("stop.json", { id = tostring(os.time()) .. "-" .. stops, to = owner.id })
		end

		app.channel:heartbeat_field(function(fields) fields.owner = owner and owner.id or nil end)
		app:on("ready", refresh)
		app:on("second", refresh)
		app:on("file", refresh)

		app:command({ id = "symbiosis.nextSession", title = "symbiosis: Next pi Session Takes Over", key = "ctrl+k n", run = next_session })
		app:command({ id = "symbiosis.detach", title = "symbiosis: Detach from pi (or Follow pi Again)", run = toggle_detach })
		app:command({ id = "symbiosis.goToSession", title = "symbiosis: Go to the pi Session (herdr, tmux)", key = "ctrl+k g", run = go_session })
		app:command({ id = "symbiosis.stop", title = "symbiosis: Stop pi's Turn", key = "ctrl+k q", run = stop_pi })
		app:hint({ key = "ctrl+k q", text = "stop pi's turn", order = 20 })
		app:hint({ key = "ctrl+k n", text = "next pi session, then detached", order = 110 })
		app:hint({ key = "ctrl+k g", text = "go to pi's pane (herdr, tmux)", order = 120 })

		-- In the panel: the sessions; Enter follows one.
		-- ✓ = how the editor picks; ▶ = the session it follows now.
		app:section({
			order = 20,
			render = function(panel)
				panel:label({ text = "pi sessions · Enter: follow it", style = "bold", margin_top = 1 })
				local items = { { id = "", label = (chosen and "  " or "✓ ") .. "automatic: by the open file" } }
				for _, rec in ipairs(sessions) do
					local mark = owner and owner.id == rec.id and "▶ " or "  "
					table.insert(items, {
						id = rec.id,
						label = mark .. rec.name .. (type(rec.waiting) == "string" and " ?" or rec.working and " ●" or " ○")
							.. (type(rec.model) == "string" and (" · " .. rec.model) or "")
							.. (chosen == rec.id and " ✓ chosen" or "") .. now_step(rec),
						muted = rec.version ~= PROTOCOL,
					})
				end
				table.insert(items, { id = DETACHED, label = (chosen == DETACHED and "✓ " or "  ") .. "detached: follow no pi" })
				panel:list({
					items = wrap.items(items, wrap.width(panel)),
					truncate_left = false,
					on_command = function(command, node)
						if command ~= "activate" then return end
						local picked = wrap.id(node.id)
						chosen = picked ~= "" and picked or nil
						refresh()
					end,
				})
			end,
		})

		return {
			PROTOCOL = PROTOCOL,
			owner = function() return owner end,
			detached = function() return chosen == DETACHED end,
			-- What to tell when a feature needs a pi session and there is none.
			missing = function(default)
				if chosen == DETACHED then return "the editor is detached from pi (ctrl+k n, or the panel, follows one again)" end
				return default
			end,
			list = function() return sessions end,
			refresh = refresh,
		}
	end,
}
