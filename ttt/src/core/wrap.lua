-- Word wrap for the plugin's panels. ttt's label and list widgets draw one
-- row and clip what does not fit, so a panel wraps its own text: it asks the
-- panel for its width (panel:size()) and gives the widget one row for each
-- line. Every panel text goes through here, so none of them clips.
local util = require("core.util")

local M = {}

-- A list row loses these columns to ttt's own marks: the expander or icon,
-- one column for the scrollbar, and two columns for each level of nesting.
M.ROW_CHROME = 4
M.INDENT = 2
-- The id of a continuation row is the row's id, this, and a number: a click
-- on any line of a wrapped row is a click on the row.
M.SEP = "\31"

-- The width a panel draws in, or `fallback` where it cannot say (a test).
function M.width(panel, fallback)
	local ok, w = pcall(panel.size, panel)
	if ok and type(w) == "number" and w > 0 then return w end
	return fallback or 40
end

-- A word longer than the width, cut in pieces of that width.
local function pieces(word, width)
	local out = {}
	while util.runes(word) > width do
		local n = util.rune_bytes(word, width)
		table.insert(out, word:sub(1, n))
		word = word:sub(n + 1)
	end
	table.insert(out, word)
	return out
end

-- One paragraph (no newline) as lines of at most `width` characters. The
-- paragraph's own leading spaces stay on every line, so a list item keeps its
-- indent.
local function paragraph(text, width)
	local indent = text:match("^%s*")
	local room = math.max(width - util.runes(indent), 1)
	local lines, line = {}, ""
	for word in text:gmatch("%S+") do
		local candidate = line == "" and word or (line .. " " .. word)
		if util.runes(candidate) <= room then
			line = candidate
		else
			if line ~= "" then table.insert(lines, indent .. line) end
			local parts = pieces(word, room)
			for i = 1, #parts - 1 do table.insert(lines, indent .. parts[i]) end
			line = parts[#parts]
		end
	end
	table.insert(lines, indent .. line)
	return lines
end

-- `text` as a list of lines of at most `width` characters; its own newlines
-- stay, and a blank line stays a blank line.
function M.lines(text, width)
	width = math.max(math.floor(width or 40), 1)
	local out = {}
	for _, line in ipairs(util.split(tostring(text or "")) or {}) do
		if util.runes(line) <= width then
			table.insert(out, line) -- fits: as it is, its spaces too (a settings row pads its label)
		elseif line:match("%S") then
			for _, l in ipairs(paragraph(line, width)) do table.insert(out, l) end
		else
			table.insert(out, "")
		end
	end
	if #out == 0 then out[1] = "" end
	return out
end

-- panel:label, wrapped: one label for each line. `spec` is the label's table
-- (text, style, margin_top, padding_left, badge): the margin stays above the
-- first line, the badge on it.
function M.label(panel, spec)
	local lines = M.lines(spec.text, M.width(panel) - (spec.padding_left or 0) - 1)
	for i, line in ipairs(lines) do
		local row = {}
		for k, v in pairs(spec) do row[k] = v end
		row.text = line
		if i > 1 then
			row.margin_top = nil
			row.badge = nil
		end
		panel:label(row)
	end
end

-- panel:keyvalue, wrapped: pairs whose value fits stay in a keyvalue; one
-- that does not becomes labels ("key  value", cut into lines). `pairs` is the
-- keyvalue's list of { key, value }.
function M.pairs(panel, pairs)
	local width = M.width(panel)
	local keyw = 0
	for _, p in ipairs(pairs) do keyw = math.max(keyw, util.runes(p.key)) end
	local fit = {}
	local function flush()
		if #fit > 0 then panel:keyvalue(fit) end
		fit = {}
	end
	for _, p in ipairs(pairs) do
		if keyw + 2 + util.runes(p.value) < width then
			table.insert(fit, p)
		else
			flush()
			M.label(panel, { text = p.key .. "  " .. p.value })
		end
	end
	flush()
end

-- Rows for a list or a tree, each label wrapped: the first line keeps the
-- row's id and its marks; the rest are rows of their own (no children) with
-- the label's remainder, indented. A row without children has them right
-- after it. A row with children (a tree node) has them first among its
-- children, as a node's children are what follows it. `width` is the panel's
-- width, `depth` the nesting of `items` (0 for the top).
function M.items(items, width, depth)
	depth = depth or 0
	local room = math.max(width - M.ROW_CHROME - depth * M.INDENT, 8)
	local out = {}
	for _, item in ipairs(items) do
		local lines = M.lines(item.label, room - 2)
		local first = {}
		for k, v in pairs(item) do first[k] = v end
		first.label = lines[1]
		local rest = {}
		for i = 2, #lines do
			table.insert(rest, { id = tostring(item.id) .. M.SEP .. i, label = "  " .. lines[i], muted = item.muted })
		end
		if item.children then
			local children = M.items(item.children, width, depth + 1)
			for i = #rest, 1, -1 do table.insert(children, 1, rest[i]) end
			first.children = children
			rest = {}
		end
		table.insert(out, first)
		for _, row in ipairs(rest) do table.insert(out, row) end
	end
	return out
end

-- The id of the row a node stands for: a continuation line gives its first.
function M.id(id)
	return (tostring(id):gsub(M.SEP .. "%d+$", ""))
end

return M
