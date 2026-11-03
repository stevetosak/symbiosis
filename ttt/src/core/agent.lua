local M = {}

local MARKS = { pi = "π", claude = "✻" }

function M.name(rec)
	if type(rec) == "table" and type(rec.agent) == "string" and rec.agent ~= "" then return rec.agent end
	return "pi"
end

function M.mark(rec)
	local name = M.name(rec)
	return MARKS[name] or name
end

function M.can(rec, what)
	if type(rec) ~= "table" or type(rec.can) ~= "table" then return true end
	for _, c in ipairs(rec.can) do
		if c == what then return true end
	end
	return false
end

return M
