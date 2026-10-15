-- A stand-in for ttt's modules (ttt, ttt.editor, ttt.fs, ...) so that the
-- plugin's Lua runs under plain LuaJIT for the unit tests. It records what
-- the plugin asks of ttt; timers run only when a test calls stub.run_timers.
local M = {}

local function reset()
	M.files = {}        -- path -> text
	M.status = {}       -- id -> text
	M.notices = {}      -- {text, level}
	M.logs = {}         -- {level, message}
	M.registered = nil  -- what ttt.register got
	M.events = {}       -- event -> handler
	M.timers = {}       -- id -> {ms, fn, every}
	M.timer_seq = 0
	M.commands = {}     -- exec_command names
	M.opened = {}       -- open_file paths
	M.buffer = { path = nil, lines = { "" } }
	M.cursor = { line = 1, col = 1 }
	M.groups = 0
end
reset()
M.reset = reset

-- JSON: a store, not text. encode returns a key that decode gives back.
local store, seq = {}, 0
local json = {
	encode = function(v)
		seq = seq + 1
		local key = "json#" .. seq
		store[key] = v
		return key
	end,
	decode = function(s)
		local v = store[(tostring(s):gsub("%s+$", ""))]
		if v == nil then error("not json: " .. tostring(s)) end
		return v
	end,
}

local ttt = {
	plugin_dir = function() return "/plugin" end,
	log = function(level, message) table.insert(M.logs, { level = level, message = message }) end,
	notify = function(text, level) table.insert(M.notices, { text = text, level = level }) end,
	set_status_item = function(_, id, text) M.status[id] = text end,
	remove_status_item = function(_, id) M.status[id] = nil end,
	register = function(reg) M.registered = reg end,
	set_timeout = function(ms, fn)
		M.timer_seq = M.timer_seq + 1
		M.timers[M.timer_seq] = { ms = ms, fn = fn }
		return M.timer_seq
	end,
	set_interval = function(ms, fn)
		M.timer_seq = M.timer_seq + 1
		M.timers[M.timer_seq] = { ms = ms, fn = fn, every = true }
		return M.timer_seq
	end,
	clear_timeout = function(id) M.timers[id] = nil end,
	clear_interval = function(id) M.timers[id] = nil end,
	open_file = function(path) table.insert(M.opened, path) M.buffer.path = path end,
	open_drawer = function(opts) M.drawer = opts end,
	open_diff = function(...) M.diff = { ... } end,
	exec_command = function(name) table.insert(M.commands, name) end,
}

-- Runs the timers that are due once (timeouts), and each interval once.
function M.run_timers()
	local due = {}
	for id, t in pairs(M.timers) do table.insert(due, { id = id, t = t }) end
	table.sort(due, function(a, b) return a.id < b.id end)
	for _, d in ipairs(due) do
		if not d.t.every then M.timers[d.id] = nil end
		d.t.fn()
	end
end

-- The buffer: lines of ASCII text (a column is a byte here).
local function text() return table.concat(M.buffer.lines, "\n") end
local function set_text(s)
	local lines = {}
	for l in (s .. "\n"):gmatch("(.-)\n") do table.insert(lines, l) end
	M.buffer.lines = lines
end
M.set_text = function(path, s) M.buffer.path = path set_text(s) end
M.text = text
-- The byte offset of (line, col) in the text, 0-based.
local function offset(line, col)
	local n = 0
	for i = 1, line - 1 do n = n + #M.buffer.lines[i] + 1 end
	return n + col - 1
end

local editor = {
	file_path = function() return M.buffer.path end,
	buffer_text = text,
	buffer_lines = function() return M.buffer.lines end,
	get_line = function(i) return M.buffer.lines[i] end,
	line_count = function() return #M.buffer.lines end,
	current_line = function() return M.buffer.lines[M.cursor.line] end,
	cursor = function() return { line = M.cursor.line, col = M.cursor.col } end,
	set_cursor = function(line, col) M.cursor = { line = line, col = col } end,
	replace = function(l1, c1, l2, c2, s)
		local t = text()
		set_text(t:sub(1, offset(l1, c1)) .. s .. t:sub(offset(l2, c2) + 1))
	end,
	insert = function(l, c, s)
		local t = text()
		set_text(t:sub(1, offset(l, c)) .. s .. t:sub(offset(l, c) + 1))
	end,
	set_line = function(i, s) M.buffer.lines[i] = s end,
	begin_undo_group = function() M.groups = M.groups + 1 end,
	end_undo_group = function() M.groups = M.groups - 1 end,
	set_selection = function() end,
	clear_selection = function() end,
	viewport = function() return { top_line = 1, bottom_line = 40, height = 40 } end,
	scroll_to = function() end,
	language = function() return "lua" end,
}

local fs = {
	read = function(path) return M.files[path] end,
	write = function(path, text) M.files[path] = text return true end,
	exists = function(path) return M.files[path] ~= nil end,
	list = function() return {} end,
}

local events = {
	on = function(name, fn) M.events[name] = fn end,
}

local system = { exec_async = function() end }

M.modules = {
	ttt = ttt, ["ttt.editor"] = editor, ["ttt.fs"] = fs, ["ttt.json"] = json,
	["ttt.events"] = events, ["ttt.system"] = system,
}

-- Makes require find the stubs, and the plugin's sources by module name.
function M.install(root)
	package.path = root .. "/ttt/src/?.lua;" .. package.path
	for name, mod in pairs(M.modules) do
		package.preload[name] = function() return mod end
	end
end

-- Forgets the plugin's modules, so the next require loads them fresh.
function M.unload()
	for name in pairs(package.loaded) do
		if name:match("^core%.") or name:match("^features%.") or name == "main" then package.loaded[name] = nil end
	end
end

return M
