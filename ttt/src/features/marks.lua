-- The gutter: ▌ on each line pi typed in this change (the call shown now),
-- π on the line it types now. Gutter marks are ttt's bookmarks, one per line,
-- shared with other plugins: a line with another plugin's mark keeps it. They
-- stay at their line numbers when the text moves, so they are drawn again on
-- each tick, after the replay's (only when something changed). They go when
-- the change is all shown. Needs the editor.bookmarks permission.
local ttt = require("ttt")
local editor = require("ttt.editor")

local BAR, NOW = "▌", "π"

return {
	name = "marks",
	needs = { "replay" },
	setup = function(app)
		local replay = app:need("replay")
		local has_marks, bookmarks = pcall(require, "ttt.bookmarks")
		local marked, marked_path, marks_key = {}, nil, ""

		local function ours(line)
			local b = bookmarks.get(line)
			return b and (b.icon == BAR or b.icon == NOW)
		end

		local function draw()
			local path = editor.file_path()
			if path ~= marked_path then marked, marked_path, marks_key = {}, path, "" end
			local want, now = {}, nil
			local t = replay.typing()
			if t and t.path == path then
				local last = editor.line_count()
				for _, r in ipairs(t.regions) do
					if r.text ~= "" then
						local n = select(2, r.text:gsub("\n", ""))
						if n > 0 and r.text:sub(-1) == "\n" then n = n - 1 end
						for l = r.line, math.min(r.line + n, last) do want[l] = BAR end
					end
				end
				if t.at and t.at <= last then
					now = t.at
					want[now] = NOW
				end
			end
			local parts = {}
			for l, icon in pairs(want) do table.insert(parts, l .. icon) end
			table.sort(parts)
			local key = table.concat(parts, ",")
			-- Another plugin may have replaced every mark (on opening a file).
			if key == marks_key and not (now and not ours(now)) then return end
			marks_key = key
			for l in pairs(marked) do
				if not want[l] and ours(l) then bookmarks.remove(l) end
			end
			marked = {}
			for l, icon in pairs(want) do
				local b = bookmarks.get(l)
				if not b or b.icon == BAR or b.icon == NOW then
					if not b or b.icon ~= icon then bookmarks.set(l, icon, "success") end
					marked[l] = true
				end
			end
		end

		app:on("tick", function()
			if not has_marks then return end
			local fine, err = pcall(draw)
			if not fine then
				has_marks = false
				app.log("error", "symbiosis gutter marks: " .. tostring(err))
			end
		end, 60)
	end,
}
