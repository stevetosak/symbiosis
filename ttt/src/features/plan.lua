-- The timeline: pi's plan (the `plan` tool, pi/plan.ts) comes in the owner's
-- session record. The status bar shows it as "✓ 3 › ▶ now › next"; ctrl+k v
-- (or a click) shows the whole plan in a drawer.
local ttt = require("ttt")
local json = require("ttt.json")
local util = require("core.util")

local PLAN_WIDTH = 56 -- the timeline in the status bar, in characters

local function plan_of(rec)
	return rec and type(rec.plan) == "table" and rec.plan or {}
end

-- One line: "✓ 3 › ▶ now › next › next +2". Done steps are a count; "next"
-- steps drop off at the right when the line is full.
local function plan_line(steps)
	if #steps == 0 then return nil end
	local done, now, nexts = 0, nil, {}
	for _, s in ipairs(steps) do
		if s.state == "done" then done = done + 1
		elseif s.state == "now" and not now then now = s.text
		else table.insert(nexts, s.text) end
	end
	if not now and #nexts == 0 then return "✓ " .. done .. " done" end
	local line = done > 0 and ("✓ " .. done) or ""
	local function add(part)
		line = line == "" and part or (line .. " › " .. part)
	end
	if now then add("▶ " .. util.cut(now, 28)) end
	local shown = 0
	for i, text in ipairs(nexts) do
		local part = util.cut(text, 20)
		local rest = #nexts - i
		local room = PLAN_WIDTH - util.runes(line) - 3 - (rest > 0 and 3 or 0)
		if shown > 0 and util.runes(part) > room then break end
		add(part)
		shown = shown + 1
	end
	if shown < #nexts then line = line .. " +" .. (#nexts - shown) end
	return line
end

return {
	name = "plan",
	needs = { "sessions" },
	plan_line = plan_line, -- for the unit tests
	setup = function(app)
		local sessions = app:need("sessions")
		local seen = nil   -- the plan as last shown, to redraw only on a change
		local drawer = nil -- the plan drawer's panel, once opened: redrawn on a change
		local open

		local function render(panel)
			drawer = panel
			local owner = sessions.owner()
			local steps = plan_of(owner)
			panel:title({ text = "pi plan", badge = owner and owner.name or "no session" })
			if #steps == 0 then
				panel:label({ text = "No plan yet. pi sends one for a task with several steps.", style = "muted" })
			end
			for _, s in ipairs(steps) do
				if s.state == "done" then
					panel:label({ text = "✓ " .. s.text, style = "muted" })
				elseif s.state == "now" then
					panel:label({ text = "▶ " .. s.text, style = "bold" })
				else
					panel:label({ text = "· " .. s.text })
				end
			end
			panel:label({ text = "Esc closes", style = "muted", margin_top = 1 })
		end

		-- Shows the owner's plan; only when it changed, so the drawer does not flicker.
		local function show()
			local owner = sessions.owner()
			local steps = plan_of(owner)
			local now = (owner and owner.id or "") .. json.encode(steps)
			if now == seen then return end
			seen = now
			local line = plan_line(steps)
			if line then
				ttt.set_status_item("left", "symbiosis.plan", line, { priority = 950, on_click = function() open() end })
			else
				ttt.remove_status_item("symbiosis.plan")
			end
			if drawer then drawer:redraw() end
		end

		-- ctrl+k v, or a click on the timeline: the whole plan in a drawer. The
		-- drawer takes the keys while it is open, so Esc closes it (as every ttt
		-- drawer); a plugin key cannot reach it, and the editor cannot keep the focus.
		open = function()
			app:open_drawer("plan", { width = 48, min_width = 30, side = "right", render = render })
		end

		app:on("sessions", show)
		app:command({ id = "symbiosis.showPlan", title = "symbiosis: Show pi's Plan", key = "ctrl+k v", run = function() open() end })
		app:hint({ key = "ctrl+k v", text = "pi's plan", order = 70 })
		return { open = open, plan_of = plan_of }
	end,
}
