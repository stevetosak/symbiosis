-- Gutter marks of one kind (one icon), on ttt's bookmarks. A feature gives the
-- lines it wants marked in the open file; `draw` sets and removes only the
-- bookmarks of its own icon, and only when something changed or another plugin
-- cleared them. A line that holds another feature's bookmark is left alone.
-- Shared by features/notes.lua (◆) and features/review.lua (●).
--
--   local gutter = require("core.gutter").new(bookmarks, "●", "warning")
--   gutter.draw(path, { [12] = true })   -- the open file and the lines to mark
local M = {}

function M.new(bookmarks, icon, style)
	local marked, marked_path, key = {}, nil, ""
	local self = {}

	-- `want`: line -> true, for the file `path`, which is the open one.
	function self.draw(path, want)
		if path ~= marked_path then marked, marked_path, key = {}, path, "" end
		local parts = {}
		for line in pairs(want) do table.insert(parts, line) end
		table.sort(parts)
		local now = table.concat(parts, ",")
		local lost = false
		for line in pairs(want) do
			local b = bookmarks.get(line)
			if not b or b.icon ~= icon then lost = true end
		end
		if now == key and not lost then return end
		key = now
		for line in pairs(marked) do
			if not want[line] then
				local b = bookmarks.get(line)
				if b and b.icon == icon then bookmarks.remove(line) end
			end
		end
		marked = {}
		for line in pairs(want) do
			local b = bookmarks.get(line)
			if not b or b.icon == icon then
				if not b then bookmarks.set(line, icon, style) end
				marked[line] = true
			end
		end
	end

	return self
end

return M
