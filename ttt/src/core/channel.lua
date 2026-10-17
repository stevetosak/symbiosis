-- The channel to pi: files in the plugin folder (see docs/design.md).
--
--   head.json, events.jsonl   pi appends events; poll() reads the new ones
--                             and hands each to the handler of its `op`
--   ttt.json                  the heartbeat: the features add their fields
--   ack.json, help.json, fill.json, answer.json, ...
--                             written by the features through write_json
--
-- A feature takes the events it handles: channel:on("start", fn). One
-- handler for each op; events no feature handles are skipped.
local fs = require("ttt.fs")
local json = require("ttt.json")
local util = require("core.util")

local M = {
	PROTOCOL = 14, -- the channel protocol of core/protocol.ts
}

local Channel = {}
Channel.__index = Channel

-- `log(level, message)`, `owner()`: the feature that registers now.
function M.new(dir, log, owner)
	return setmetatable({
		dir = dir, log = log, owner = owner or function() return nil end,
		handlers = {}, fields = {}, gen = nil, offset = 0,
	}, Channel)
end

function Channel:path(name) return self.dir .. "/" .. name end

function Channel:read_json(name)
	local ok, v = pcall(json.decode, fs.read(self:path(name)) or "")
	if ok then return v end
	return nil
end

function Channel:write_json(name, value)
	fs.write(self:path(name), json.encode(value))
end

-- The handler for pi's events with this `op`.
function Channel:on(op, fn)
	if self.handlers[op] then
		error("the channel op " .. op .. " is taken by " .. tostring(self.handlers[op].owner), 2)
	end
	self.handlers[op] = { fn = fn, owner = self.owner() }
end

-- `fn(fields)` adds its fields to each heartbeat.
function Channel:heartbeat_field(fn)
	table.insert(self.fields, { fn = fn, owner = self.owner() })
end

-- Drops what a feature registered (its setup failed).
function Channel:drop(owner)
	for op, h in pairs(self.handlers) do
		if h.owner == owner then self.handlers[op] = nil end
	end
	local keep = {}
	for _, f in ipairs(self.fields) do
		if f.owner ~= owner then table.insert(keep, f) end
	end
	self.fields = keep
end

function Channel:handles(op) return self.handlers[op] ~= nil end

-- ttt.json: pi reads it to know the editor runs, and the features' fields.
function Channel:heartbeat()
	local rec = { t = os.time() }
	for _, f in ipairs(self.fields) do
		local ok, err = pcall(f.fn, rec)
		if not ok then self.log("error", "symbiosis " .. tostring(f.owner) .. " heartbeat: " .. tostring(err)) end
	end
	fs.write(self:path("ttt.json"), json.encode(rec))
end

-- Reads the events pi appended since the last poll.
function Channel:poll()
	local raw = fs.read(self:path("head.json"))
	-- No log when ttt starts: whatever comes later is new, not history.
	if not raw then
		if self.gen == nil then self.gen = "" end
		return
	end
	local head = json.decode(raw)
	if not head or not head.gen then return end
	if head.gen ~= self.gen then
		-- The first log seen is history from before ttt started: skip it.
		self.offset = self.gen == nil and head.size or 0
		self.gen = head.gen
	end
	if head.size <= self.offset then return end
	local log = fs.read(self:path("events.jsonl"))
	if not log then return end
	local chunk = log:sub(self.offset + 1)
	for line in util.lines(chunk) do
		self.offset = self.offset + #line
		local ok, ev = pcall(json.decode, line)
		local h = ok and type(ev) == "table" and self.handlers[ev.op]
		if h then
			local fine, err = pcall(h.fn, ev)
			if not fine then self.log("error", "symbiosis " .. ev.op .. ": " .. tostring(err)) end
		end
	end
end

return M
