-- Pure helpers for text, positions and paths. No ttt API here: the Lua unit
-- tests (test/lua) load this module as it is.
local M = {}

-- Each line of `text` that ends in "\n", with its "\n". Not gmatch("[^\n]*\n"):
-- in ttt 1.7.1 that crashes (nil pointer) on text with an empty line.
function M.lines(text)
	local i = 1
	return function()
		local j = text:find("\n", i, true)
		if not j then return nil end
		local line = text:sub(i, j)
		i = j + 1
		return line
	end
end

-- Characters (not bytes) in a UTF-8 string: editor columns count characters.
function M.runes(s)
	local _, continuation = s:gsub("[\128-\191]", "")
	return #s - continuation
end

-- The position just after `text`, written from (line, col).
function M.after(line, col, text)
	local newlines = select(2, text:gsub("\n", ""))
	if newlines == 0 then return line, col + M.runes(text) end
	local tail = text:match("[^\n]*$")
	return line + newlines, 1 + M.runes(tail)
end

-- The position of byte `b` (1-based) in `text`.
function M.position(text, b)
	return M.after(1, 1, text:sub(1, b - 1))
end

-- The common prefix of two strings, in bytes, not ending inside a character.
function M.prefix(a, b)
	local n = math.min(#a, #b)
	local i = 0
	while i < n and a:byte(i + 1) == b:byte(i + 1) do i = i + 1 end
	while i > 0 and i < #b and b:byte(i + 1) >= 128 and b:byte(i + 1) < 192 do i = i - 1 end
	return i
end

-- The bytes of the first `n` characters of `s`.
function M.rune_bytes(s, n)
	local i, count = 1, 0
	while i <= #s and count < n do
		local b = s:byte(i)
		i = i + (b >= 240 and 4 or b >= 224 and 3 or b >= 192 and 2 or 1)
		count = count + 1
	end
	return math.min(i - 1, #s)
end

function M.adler32(s)
	local a, b = 1, 0
	for i = 1, #s do
		a = (a + s:byte(i)) % 65521
		b = (b + a) % 65521
	end
	return b * 65536 + a
end

-- The first `n` characters of `s`, with "…" when cut.
function M.cut(s, n)
	if M.runes(s) <= n then return s end
	local out, count = {}, 0
	for ch in s:gmatch("[^\128-\191][\128-\191]*") do
		if count == n - 1 then break end
		table.insert(out, ch)
		count = count + 1
	end
	return table.concat(out) .. "…"
end

-- Lines for open_diff; a final "\n" does not make an empty last line.
function M.split(text)
	local out = {}
	if type(text) ~= "string" then return out end
	local i = 1
	while i <= #text do
		local j = text:find("\n", i, true)
		if not j then
			table.insert(out, text:sub(i))
			break
		end
		table.insert(out, text:sub(i, j - 1))
		i = j + 1
	end
	return out
end

function M.starts_with(s, p) return s:sub(1, #p) == p end

-- Paths ---------------------------------------------------------------------

function M.name(path) return path:match("[^/]+$") or path end

function M.parent(path)
	return path:match("^(.*)/[^/]*$") or path
end

-- "~" for the home folder (Linux, macOS).
function M.short(path)
	return (path:gsub("^/home/[^/]+", "~"):gsub("^/Users/[^/]+", "~"))
end

function M.split_path(rel)
	local parts = {}
	for part in rel:gmatch("[^/]+") do table.insert(parts, part) end
	return parts
end

-- Keys ----------------------------------------------------------------------

-- A key that changes the text: a character, or Enter, Tab, Backspace, Delete.
-- Not a move, and not a key with ctrl or alt.
function M.edits_text(key)
	if key.mod and key.mod ~= "" and key.mod ~= "shift" then return false end
	if key.rune and key.rune ~= "" then return true end
	local k = tostring(key.key or ""):lower()
	return k == "enter" or k == "tab" or k == "backspace" or k == "delete"
end

-- ctrl+v, ctrl+x, ctrl+z, ctrl+y, ctrl+s: they change or save the buffer.
local CHANGES_KEYS = { v = true, x = true, z = true, y = true, s = true }

function M.changes_buffer(key)
	if M.edits_text(key) then return true end
	local k = tostring(key.key or key.rune or ""):lower():match("(%a)$")
	return key.mod == "ctrl" and k ~= nil and CHANGES_KEYS[k] == true
end

-- The lower-case name of a key: "esc", "enter", "a".
function M.key_name(key)
	return tostring(key.key or ""):lower()
end

return M
