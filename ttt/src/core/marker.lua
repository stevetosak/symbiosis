-- A marker: a word at the end of a comment that asks pi for something
-- (helpi!, fill!). Comments in any language: the openers below; a closer
-- (*/, -->) after the word is allowed.
local util = require("core.util")

local M = {}

M.OPENERS = { "<!--", "/*", "//", "--", "#", ";" }

-- The comment on `line` when it ends in `word`: {byte, col, opener, indent}.
function M.find(line, word)
	local body = line:gsub("%s*%*/%s*$", ""):gsub("%s*%-%->%s*$", "")
	if not body:match(util.escape(word) .. "%s*$") then return nil end
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
	if not at then return line end
	return line:sub(1, at - 1):gsub("%s+$", "") .. line:sub(at + #word)
end

return M
