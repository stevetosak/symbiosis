-- A word at the end of a comment that asks pi for something (`helpi!`,
-- `why!`): it fires 600 ms after your last change, or at once on Enter at the
-- end of its line. Both features that have a word use this.
--
-- trigger.new(app, {
--   find = function(line) -> truthy when the line holds the word,
--   ms = 600,
--   busy = function() -> true while the feature does not take a new question,
--   quiet = function() -> true while changes are the plugin's own (optional),
--   fire = function(again) -- `again`: Enter asks also a line asked before
-- })
local ttt = require("ttt")
local editor = require("ttt.editor")
local util = require("core.util")
local buffer = require("core.buffer")

local M = {}

function M.new(app, opts)
	local timer = nil
	local ms = opts.ms or 600

	local function run(again)
		local fine, err = pcall(opts.fire, again)
		if not fine then
			buffer.editing = false
			app.log("error", "symbiosis " .. (opts.name or "trigger") .. ": " .. tostring(err))
		end
	end

	local function clear()
		if timer then ttt.clear_timeout(timer) timer = nil end
	end

	app:on("change", function()
		if not app.loaded or buffer.editing or opts.busy() or (opts.quiet and opts.quiet()) then return end
		clear()
		timer = ttt.set_timeout(ms, function()
			timer = nil
			run(false)
		end)
	end)

	-- Early (order 10): the Enter still goes in.
	app:on("key", function(key)
		local k = tostring(key.key or ""):lower()
		if k == "enter" and (not key.mod or key.mod == "") and not opts.busy() then
			local line = editor.current_line() or ""
			if editor.cursor().col > util.runes(line) and opts.find(line) then
				clear()
				run(true)
			end
		end
		return false
	end, 10)

	return { clear = clear }
end

return M
