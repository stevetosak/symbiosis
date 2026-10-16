-- A marker: a word at the end of a comment that asks pi for something
-- (helpi!). Comments in any language: the openers below; a closer
-- (*/, -->) after the word is allowed.
local util = require("core.util")

local M = {}

M.OPENERS = { "<!--", "/*", "//", "--", "#", ";" }

-- True when the word at byte `at` is a word of its own: "refill!" is not
-- "fill!". (ttt's Lua has no %f frontier pattern: measured in 1.7.1.)
local function own_word(text, at)
	return not text:sub(at - 1, at - 1):match("[%w_]")
end

-- The comment on `line` when it ends in `word`: {byte, col, opener, indent}.
function M.find(line, word)
	local body = line:gsub("%s*%*/%s*$", ""):gsub("%s*%-%->%s*$", "")
	local at = body:match("()" .. util.escape(word) .. "%s*$")
	if not at or not own_word(body, at) then return nil end
	for _, o in ipairs(M.OPENERS) do
		local b = body:find(o, 1, true)
		if b and b <= #body - #word then
			return { byte = b, opener = o, col = util.runes(line:sub(1, b - 1)) + 1, indent = line:match("^%s*") }
		end
	end
	return nil
end

-- `line` without its last `word` (and the space before it).
function M.strip(line, word)
	local at = line:match(".*()" .. util.escape(word))
	if not at or not own_word(line, at) then return line end
	return line:sub(1, at - 1):gsub("%s+$", "") .. line:sub(at + #word)
end

return M
