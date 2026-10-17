-- Close symbiosis: ctrl+k z. pi quits, its tab or pane closes, then ttt
-- quits (ctrl+q quits ttt alone and leaves pi). The work is `symbiosis close
-- --keep-editor` (launcher/close.ts): it knows the pane the launcher made for
-- pi. ttt quits itself afterwards, so it asks about unsaved files as for ctrl+q.
-- When programs run (F5), the question about them is the confirmation.
--
-- `symbiosis close` in a terminal does the first half itself and then writes
-- quit.json: the plugin reads it each second and quits as ctrl+q does (programs
-- that run are asked about; ttt itself asks about unsaved files).
--
-- Only a ttt that the `symbiosis` command started has something to close: its
-- environment holds SYMBIOSIS_SESSION.
local ttt = require("ttt")
local system = require("ttt.system")

-- ttt's Lua has no os.getenv: the environment comes through ttt.system.env
-- (the permission "system.env").
local function env(name)
	local ok, value = pcall(system.env, name)
	if ok and type(value) == "string" and value ~= "" then return value end
	return nil
end

-- ttt's own quit command: it asks about unsaved files, as ctrl+q does
-- (ttt.quit() would drop them without a word).
local function quit_editor()
	ttt.exec_command("editor.quit")
end

return {
	name = "close",
	needs = { "sessions", "run" },
	setup = function(app)
		local sessions = app:need("sessions")
		local runs = app:need("run")
		local closing = false

		local function notify(text, level)
			ttt.notify("symbiosis: " .. text, level or "info")
		end

		local function close_pi_then_quit()
			closing = true
			notify("closing pi…")
			local ok, err = pcall(system.exec_async, "symbiosis", { "close", "--keep-editor" }, function(result)
				closing = false
				if result and result.exit_code == 0 then return quit_editor() end
				local why = result and ((result.stderr or "") ~= "" and result.stderr or result.error) or "no answer"
				notify("could not close pi, ttt stays open: " .. tostring(why):gsub("%s+$", ""), "error")
			end)
			if not ok then
				closing = false
				notify("could not start `symbiosis close`: " .. tostring(err), "error")
			end
		end

		local function close()
			if closing then return end
			if not env("SYMBIOSIS_SESSION") then
				return notify("this ttt was not started by the `symbiosis` command; ctrl+q quits ttt", "warning")
			end
			-- Programs that run: the question about them confirms the close too.
			if runs.before_quit(close_pi_then_quit) then return end
			local owner = sessions.owner()
			local busy = owner and owner.working and (" pi " .. owner.name .. " is working now.") or ""
			local ok, err = pcall(ttt.confirm, "Close symbiosis? pi quits and its tab closes, then ttt quits." .. busy, close_pi_then_quit)
			if not ok then notify("could not ask: " .. tostring(err), "error") end
		end

		-- A quit request from before this ttt started is old.
		local seen = (type(app.channel:read_json("quit.json")) == "table" and app.channel:read_json("quit.json").id) or nil
		app:on("second", function()
			local request = app.channel:read_json("quit.json")
			if type(request) ~= "table" or type(request.id) ~= "string" or request.id == seen then return end
			seen = request.id
			if not runs.before_quit(quit_editor) then quit_editor() end
		end)

		app:command({ id = "symbiosis.close", title = "symbiosis: Close (pi and ttt)", key = "ctrl+k z", run = close })
		app:hint({ key = "ctrl+k z", text = "close symbiosis: pi and ttt (ctrl+q: ttt only)", order = 25 })
		return { close = close }
	end,
}
