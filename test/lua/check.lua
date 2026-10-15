-- Assertions for the Lua tests.
local M = {}

local function show(v)
	if type(v) == "string" then return string.format("%q", v) end
	if type(v) ~= "table" then return tostring(v) end
	local keys = {}
	for k in pairs(v) do table.insert(keys, k) end
	table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
	local out = {}
	for _, k in ipairs(keys) do table.insert(out, tostring(k) .. "=" .. show(v[k])) end
	return "{" .. table.concat(out, ", ") .. "}"
end
M.show = show

local function same(a, b)
	if type(a) ~= type(b) then return false end
	if type(a) ~= "table" then return a == b end
	for k, v in pairs(a) do
		if not same(v, b[k]) then return false end
	end
	for k in pairs(b) do
		if a[k] == nil then return false end
	end
	return true
end

function M.eq(got, want, what)
	if not same(got, want) then
		error((what and (what .. ": ") or "") .. "got " .. show(got) .. ", want " .. show(want), 2)
	end
end

function M.ok(v, what)
	if not v then error("not true: " .. (what or "?"), 2) end
end

-- `fn` raises an error that contains `part`.
function M.raises(fn, part)
	local ok, err = pcall(fn)
	if ok then error("no error; want one with " .. part, 2) end
	if not tostring(err):find(part, 1, true) then error("error " .. tostring(err) .. "; want one with " .. part, 2) end
end

return M
