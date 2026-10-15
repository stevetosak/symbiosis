-- The Lua unit tests of the ttt plugin: luajit test/lua/run.lua [repo root].
-- Each test/lua/*_test.lua returns a list of { name, fn }. Exit 1 on a failure.
local root = arg[1] or "."
package.path = root .. "/test/lua/?.lua;" .. package.path
local stub = require("stub")
stub.install(root)

local t = require("check")

local files = {}
local list = io.popen('ls "' .. root .. '/test/lua"')
for name in list:lines() do
	if name:match("_test%.lua$") then table.insert(files, name) end
end
list:close()
table.sort(files)

local passed, failed = 0, 0
for _, file in ipairs(files) do
	local tests = dofile(root .. "/test/lua/" .. file)
	for _, case in ipairs(tests) do
		stub.reset()
		stub.unload()
		local ok, err = xpcall(case[2], debug.traceback)
		if ok then
			passed = passed + 1
		else
			failed = failed + 1
			io.stderr:write("not ok  " .. file .. ": " .. case[1] .. "\n" .. tostring(err) .. "\n")
		end
	end
end
print(string.format("lua: %d passed, %d failed", passed, failed))
os.exit(failed == 0 and 0 or 1)
