-- Stub filling, the editor side (pi/fill.ts is the pi side).
--
--   fill! at the end of a stub's marker line (// TODO(pi) fill!), or ctrl+k f
--   with the cursor in a stub: the file is saved, and the session the editor
--   follows fills the stub. Its guard holds its edits to the body.
--   "symbiosis: Release the Stub" ends the fill.
--
--   A proposal (pi's `propose` tool: a change the guard blocks) opens a
--   drawer with an optional note: Enter accepts, the Reject button rejects,
--   both send the note. ctrl+k p shows it again.
--
--   The `why` pi gives a change shows as a notice when the replay shows the
--   change; ctrl+k w lists them again (features/changes.lua).
--
--   The setting "Stub scope" (the panel): how far the guard lets a fill reach.
local ttt = require("ttt")
local editor = require("ttt.editor")
local fs = require("ttt.fs")
local buffer = require("core.buffer")
local marker = require("core.marker")
local util = require("core.util")

local WORD = "fill!"
local FILL_MS = 600   -- after the last key press on a fill! line
local SAVE_TICKS = 30 -- how long a fill waits for the save (poll ticks)
local SCOPES = { "stub", "file", "off" }
local SCOPE_TEXT = {
	stub = "the stub's body",
	file = "the stub's file",
	off = "anywhere (no guard)",
}
local KIND_TEXT = {
	new_file = "a new file",
	new_decl = "a new declaration",
	signature = "a signature change",
	dependency = "a new dependency",
	outside_edit = "an edit outside the stub",
}

local function setup(app)
	local channel, settings = app.channel, app.settings
	local sessions = app:need("sessions")
	local seq = 0
	local timer = nil
	local saving = nil   -- {path, line, ticks}: a fill that waits for the save
	local proposal = nil -- the proposal pi waits on
	local note = ""
	local show_proposal

	settings:define("scope", {
		values = SCOPES, default = 1, label = "Stub scope", order = 25,
		text = function(v) return SCOPE_TEXT[v] or v end,
		-- pi reads it from ttt.json.
		on_change = function() channel:heartbeat() end,
	})
	channel:heartbeat_field(function(fields) fields.scope = settings:get("scope") end)

	local function owner()
		local o = sessions.owner()
		if not o then ttt.notify("symbiosis: no pi session follows this file", "warning") end
		return o
	end

	local function request(fields)
		local o = owner()
		if not o then return end
		seq = seq + 1
		fields.id = tostring(os.time()) .. "-" .. seq
		fields.to = o.id
		channel:write_json("fill.json", fields)
		return true
	end

	-- Fill the stub at `line` of the open file, once the file on disk is the buffer.
	local function fill_at(line)
		local path = editor.file_path()
		if not path or path == "" then return ttt.notify("symbiosis: save the file first", "warning") end
		if not sessions.owner() then return owner() end
		ttt.exec_command("file.save")
		saving = { path = path, line = line, ticks = 0 }
	end

	-- Each tick: the fill that waits for the save goes once the save is on disk.
	local function send_saved()
		if not saving then return end
		saving.ticks = saving.ticks + 1
		local on_disk = fs.read(saving.path) == editor.buffer_text()
		if not on_disk and saving.ticks < SAVE_TICKS then return end
		local s = saving
		saving = nil
		if not on_disk then ttt.notify("symbiosis: the file did not save; pi fills the stub as it is on disk", "warning") end
		if request({ path = s.path, line = s.line, release = false }) then
			ttt.notify("symbiosis: pi fills the stub at line " .. s.line .. " of " .. util.name(s.path), "info")
		end
	end

	-- fill!: the marker goes from the line, and the stub is filled.
	local function fill_marked()
		if not app.loaded or buffer.editing then return end
		local cursor = editor.cursor()
		local line = editor.get_line(cursor.line) or ""
		if not marker.find(line, WORD) then return end
		buffer.editing = true
		editor.set_line(cursor.line, marker.strip(line, WORD))
		buffer.editing = false
		fill_at(cursor.line)
	end

	local function fill_soon()
		if not app.loaded or buffer.editing then return end
		if not marker.find(editor.current_line() or "", WORD) then return end
		if timer then ttt.clear_timeout(timer) end
		timer = ttt.set_timeout(FILL_MS, function()
			timer = nil
			local fine, err = pcall(fill_marked)
			if not fine then app.log("error", "symbiosis fill!: " .. tostring(err)) end
		end)
	end

	local function release()
		if request({ release = true }) then ttt.notify("symbiosis: the stub is released", "info") end
	end

	-- Proposals ------------------------------------------------------------------
	-- The drawer holds the proposal, a note and two buttons. Enter in the note
	-- accepts; Tab goes to the buttons. Esc only closes the drawer (ttt tells
	-- the plugin nothing): the proposal waits in the status bar, and a click
	-- or ctrl+k p shows it again. (ttt.command_line does not open while a
	-- drawer is open: measured in ttt 1.7.1.)

	local function waiting(on)
		if not on then return ttt.remove_status_item("symbiosis.proposal") end
		ttt.set_status_item("left", "symbiosis.proposal", "? pi proposes " .. (KIND_TEXT[proposal.kind] or proposal.kind),
			{ priority = 940, on_click = function() show_proposal() end })
	end

	local function answer(accept)
		if not proposal then return end
		channel:write_json("answer.json", { id = proposal.id, accept = accept, note = note })
		ttt.notify("symbiosis: " .. (accept and "accepted" or "rejected") .. " " .. (KIND_TEXT[proposal.kind] or proposal.kind), "info")
		proposal = nil
		waiting(false)
		ttt.close_drawer()
	end

	local function render(panel)
		local p = proposal
		if not p then return panel:label({ text = "pi waits for no answer.", style = "muted" }) end
		panel:title({ text = "pi proposes", badge = KIND_TEXT[p.kind] or p.kind })
		panel:keyvalue({ { key = "target", value = util.short(p.target) } })
		panel:label({ text = p.what, margin_top = 1 })
		panel:label({ text = "Why: " .. p.why, style = "muted", margin_top = 1 })
		panel:input({
			prefix = "note: ", placeholder = "optional, for pi",
			on_change = function(text) note = text end,
			on_submit = function(text) note = text answer(true) end,
		})
		panel:button({ label = "&Accept", on_click = function() answer(true) end })
		panel:button({ label = "&Reject", on_click = function() answer(false) end })
		panel:label({ text = "Enter accepts · Tab: the buttons · Esc: later (ctrl+k p)", style = "muted", margin_top = 1 })
	end

	function show_proposal()
		if not proposal then return ttt.notify("symbiosis: pi waits for no answer", "info") end
		ttt.open_drawer({ width = 52, min_width = 30, side = "right", render = render })
	end

	channel:on("propose", function(ev)
		local o = sessions.owner()
		if not o or ev.session ~= o.id then return end
		proposal, note = ev, ""
		waiting(true)
		show_proposal()
	end)

	channel:on("propose_end", function(ev)
		if not proposal or ev.id ~= proposal.id then return end
		proposal = nil
		waiting(false)
		ttt.close_drawer()
		ttt.notify("symbiosis: pi does not wait for that answer any more", "info")
	end)

	-- What pi says about a fill (no stub at that line, the stub is released).
	local LEVELS = { info = "info", warn = "warning", error = "error" }
	channel:on("notice", function(ev)
		if type(ev.text) == "string" then ttt.notify(ev.text, LEVELS[ev.level] or "info") end
	end)

	-- Why ------------------------------------------------------------------------

	app:on("done", function(ev)
		if type(ev.why) == "string" and ev.why ~= "" then
			ttt.notify("pi, why (" .. util.name(ev.path) .. "): " .. ev.why, "info")
		end
	end)

	app:on("change", fill_soon)
	app:on("tick", send_saved)
	app:command({ id = "symbiosis.fillStub", title = "symbiosis: Fill This Stub", key = "ctrl+k f", run = function() fill_at(editor.cursor().line) end })
	app:command({ id = "symbiosis.showProposal", title = "symbiosis: Answer pi's Proposal", key = "ctrl+k p", run = function() show_proposal() end })
	app:command({ id = "symbiosis.releaseStub", title = "symbiosis: Release the Stub", run = release })
	app:hint({ key = "// TODO(pi) fill!", text = "pi fills this stub (or ctrl+k f)", order = 92 })
	app:hint({ key = "ctrl+k p", text = "answer pi's proposal", order = 93 })

	return {
		proposal = function() return proposal end,
	}
end

return {
	name = "fill",
	needs = { "sessions", "replay" },
	setup = setup,
}
