-- The workspace folder of a file, as far as the plugin can tell: the nearest
-- folder with .symbiosis/run.json up to the git root, else the git root,
-- else the file's folder. (`symbiosis run list` says the same.)
local M = {}

-- `exists(path)`: true when the path is a file or a folder.
function M.guess(file, exists)
	local d = file:match("^(.*)/[^/]*$")
	local saved = nil
	while d and d ~= "" do
		if not saved and exists(d .. "/.symbiosis/run.json") then saved = d end
		if exists(d .. "/.git") then return saved or d end
		d = d:match("^(.*)/[^/]*$")
	end
	return saved or file:match("^(.*)/[^/]*$")
end

return M
