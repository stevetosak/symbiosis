-- The panel: ctrl+k h. The settings that features define (Enter cycles a
-- value; "-" and "=" step one that steps), the sections features add (the pi
-- sessions, ...), every key hint, and the notes. ttt calls render on every
-- frame: no file reads here. Up/Down move in a list, Tab to the next list,
-- Esc closes.
local ttt = require("ttt")

-- Settings labels are padded to this many characters, so the values line up.
local LABEL_WIDTH = 16

return {
	name = "panel",
	setup = function(app)
		local settings = app.settings

		local function render(panel)
			panel:title("symbiosis")
			local shown = settings:shown()
			if #shown > 0 then
				panel:label({ text = "Settings · Enter changes", style = "bold" })
				local items = {}
				for _, def in ipairs(shown) do
					local label = def.label
					if #label < LABEL_WIDTH then label = label .. string.rep(" ", LABEL_WIDTH - #label) else label = label .. " " end
					table.insert(items, { id = def.key, label = label .. settings:text(def.key) })
				end
				panel:list({
					items = items,
					key_commands = { ["-"] = "slower", ["="] = "faster" },
					on_command = function(command, node)
						local def = settings.defs[node.id]
						if not def then return end
						if def.steps and command == "slower" then settings:step(def.key, -1)
						elseif def.steps and command == "faster" then settings:step(def.key, 1)
						elseif command == "activate" or def.steps then
							settings:cycle(def.key)
						end
					end,
				})
			end
			for _, s in ipairs(app.sections) do
				local ok, err = pcall(s.render, panel)
				if not ok then app.log("error", "symbiosis " .. tostring(s.owner) .. " panel: " .. tostring(err)) end
			end
			if #app.hints > 0 then
				panel:label({ text = "Keys", style = "bold", margin_top = 1 })
				local keys = {}
				for _, h in ipairs(app.hints) do table.insert(keys, { key = h.key, value = h.value }) end
				panel:keyvalue(keys)
			end
			for i, n in ipairs(app.notes) do
				panel:label({ text = n.text, style = "muted", margin_top = i == 1 and 1 or nil })
			end
		end

		local function open()
			ttt.open_drawer({ width = 52, min_width = 36, side = "right", render = render })
		end

		app:command({ id = "symbiosis.help", title = "symbiosis: Settings, Sessions and Keys", key = "ctrl+k h", run = open })
		app:hint({ key = "ctrl+k h", text = "this panel", order = 10 })
		app:note("Esc closes · clicks: π goes to pi, ▶ speed cycles", 90)

		return { open = open, render = render }
	end,
}
