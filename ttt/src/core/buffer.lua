-- The buffer, as the features change it. `editing` is true while a feature
-- changes the buffer: the key handler and the change events ignore those
-- changes (they are the plugin's own, not yours).
local ttt = require("ttt")
local editor = require("ttt.editor")
local util = require("core.util")

local M = { editing = false }

-- Scrolls so that `line` is on screen, in the middle when it was not.
function M.reveal(line)
	local v = editor.viewport()
	if line < v.top_line or line > v.bottom_line - 1 then
		editor.scroll_to(math.max(1, line - math.floor(v.height / 2)))
	end
end

-- Regions: a stretch of the buffer that a feature owns: {line, col, text}.
-- Makes the region read `text`: replaces only what changed after the common
-- prefix. The cursor goes to its end, or `below` lines under its end.
function M.set_region(r, text, below)
	local p = util.prefix(r.text, text)
	local pl, pc = util.after(r.line, r.col, r.text:sub(1, p))
	local el, ec = util.after(r.line, r.col, r.text)
	M.editing = true
	editor.replace(pl, pc, el, ec, text:sub(p + 1))
	M.editing = false
	r.text = text
	local cl, cc = util.after(r.line, r.col, text)
	if below then cl, cc = cl + below.lines, below.col end
	editor.set_cursor(cl, cc)
	M.reveal(cl)
end

-- The text of the whole buffer, as a region: line 1, column 1 to the end.
function M.whole()
	return { line = 1, col = 1, text = editor.buffer_text() }
end

-- Opens `path` when it is not the open file. True when it is open now.
function M.on_buffer(path)
	if editor.file_path() ~= path then ttt.open_file(path) end
	return editor.file_path() == path
end

return M
