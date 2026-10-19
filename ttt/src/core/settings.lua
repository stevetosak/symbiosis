-- Settings: each one a list of values; the features define them, the panel
-- (ctrl+k h) shows them, settings.json keeps them.
--
--   settings:define("autosave", {
--     values = { 0, 1000, 3000 }, -- the values, in the order Enter cycles them
--     default = 2,             -- the index before you choose one
--     label = "Autosave",      -- in the panel; nil: not in the panel
--     order = 10,              -- the place in the panel
--     text = function(v) ... end, -- the value as the panel shows it
--     steps = true,            -- "-" and "=" in the panel step it (no wrap)
--     persist = false,         -- not kept in settings.json (default: kept)
--     on_change = function(v) ... end,
--   })
local fs = require("ttt.fs")
local json = require("ttt.json")

local Settings = {}
Settings.__index = Settings

local M = {}

function M.new(path, owner)
	return setmetatable({ path = path, defs = {}, list = {}, saved = {}, owner = owner or function() return nil end }, Settings)
end

function Settings:define(key, def)
	if self.defs[key] then error("setting " .. key .. " is defined twice", 2) end
	if type(def.values) ~= "table" or #def.values == 0 then error("setting " .. key .. " has no values", 2) end
	def.key = key
	def.index = def.default or 1
	def.order = def.order or 50
	def.owner = self.owner()
	def.seq = #self.list + 1
	self.defs[key] = def
	table.insert(self.list, def)
	return def
end

-- Drops the settings a feature defined (its setup failed).
function Settings:drop(owner)
	local keep = {}
	for _, def in ipairs(self.list) do
		if def.owner == owner then self.defs[def.key] = nil else table.insert(keep, def) end
	end
	self.list = keep
end

function Settings:get(key)
	local def = self.defs[key]
	return def.values[def.index]
end

function Settings:index(key) return self.defs[key].index end

function Settings:text(key)
	local def = self.defs[key]
	local v = def.values[def.index]
	return def.text and def.text(v) or tostring(v)
end

function Settings:set_index(key, i)
	local def = self.defs[key]
	def.index = i
	-- A file that cannot be written does not stop the change.
	if def.persist ~= false then pcall(self.save, self) end
	if def.on_change then def.on_change(def.values[i]) end
end

-- One step up or down, not past the ends.
function Settings:step(key, delta)
	local def = self.defs[key]
	self:set_index(key, math.max(1, math.min(#def.values, def.index + delta)))
end

-- The next value, round.
function Settings:cycle(key)
	local def = self.defs[key]
	self:set_index(key, def.index % #def.values + 1)
end

-- The definitions with a label, in panel order.
function Settings:shown()
	local out = {}
	for _, def in ipairs(self.list) do
		if def.label then table.insert(out, def) end
	end
	table.sort(out, function(a, b)
		if a.order ~= b.order then return a.order < b.order end
		return a.seq < b.seq
	end)
	return out
end

-- Reads settings.json: a value it names is chosen when it is one of the
-- setting's values. Keys no setting knows are kept as they are.
function Settings:load()
	local ok, saved = pcall(json.decode, fs.read(self.path) or "")
	if not ok or type(saved) ~= "table" then return end
	self.saved = {}
	for k, v in pairs(saved) do
		if type(k) == "string" then self.saved[k] = v end
	end
	for _, def in ipairs(self.list) do
		if def.persist ~= false then
			for i, v in ipairs(def.values) do
				if v == saved[def.key] then def.index = i end
			end
		end
	end
end

function Settings:save()
	local out = {}
	for k, v in pairs(self.saved) do out[k] = v end
	for _, def in ipairs(self.list) do
		if def.persist ~= false then out[def.key] = def.values[def.index] end
	end
	fs.write(self.path, json.encode(out))
end

return M
