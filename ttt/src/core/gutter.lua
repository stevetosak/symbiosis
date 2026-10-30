-- Gutter marks of one kind (one icon), on ttt's bookmarks. A feature gives the
-- lines it wants marked in the open file; `draw` sets and removes only the
-- bookmarks of its own icon, and only when something changed or another plugin
-- cleared them. A line that holds another feature's bookmark is left alone.
-- Shared by features/notes.lua (◆) and features/review.lua (●).
--
--   local gutter = require("core.gutter").new(bookmarks, "●", "warning")
--   gutter.draw(path, { [12] = true })   -- the open file and the lines to mark
--
-- A line may name its own style instead of true: { [12] = "success" } (the
-- change marks use one colour for each plan step).
--
-- opts.force: the mark takes its line even from another feature's mark (the
-- debugger's breakpoints and paused line: they matter more while you debug).
-- The other feature's mark comes back when the line is free again.
local M = {}

function M.new(bookmarks, icon, style, opts)
	local force = opts and opts.force or false
	local marked, marked_path, key = {}, nil, ""
	local self = {}

	-- `want`: line -> true, for the file `path`, which is the open one.
	function self.draw(path, want)
		if path ~= marked_path then marked, marked_path, key = {}, path, "" end
		local function style_at(line)
			return type(want[line]) == "string" and want[line] or style
		end
		local parts = {}
		for line in pairs(want) do table.insert(parts, line) end
		table.sort(parts)
		for i, line in ipairs(parts) do parts[i] = line .. style_at(line) end
		local now = table.concat(parts, ",")
		local lost = false
		for line in pairs(want) do
			local b = bookmarks.get(line)
			if not b or b.icon ~= icon or b.style ~= style_at(line) then lost = true end
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
			if not b or b.icon == icon or force then
				if not b or b.icon ~= icon or b.style ~= style_at(line) then bookmarks.set(line, icon, style_at(line)) end
				marked[line] = true
			end
		end
	end

	return self
end

return M
