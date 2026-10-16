-- The host. The plugin is a set of features (ttt/src/features/*.lua); each
-- one plugs into the host and talks to the others only through it.
--
-- A feature is a table:
--
--   return {
--     name = "plan",
--     needs = { "sessions" },        -- features set up before this one
--     setup = function(app)
--       local sessions = app:need("sessions")  -- the api `sessions` returned
--       app:on("sessions", function() ... end)
--       app:command({ id = "symbiosis.showPlan", title = "...", key = "ctrl+k v", run = open })
--       return { open = open }      -- this feature's api, for app:need("plan")
--     end,
--   }
--
-- main.lua: app:use("features.plan") for each feature, then app:start().
--
-- What the host gives a feature:
--   app:need(name) / app:get(name)  another feature's api (get: nil if absent)
--   app:on(hook, fn, order)         a hook; lower `order` first (default 50)
--   app:emit(hook, ...)             runs a hook's handlers
--   app:command(def)                a command, with an optional key
--   app:hint(def)                   a line in the panel's key list
--   app:sidebar(def)                the sidebar panel (one for the plugin)
--   app:section(def)                a section of the panel (ctrl+k h)
--   app:note(text, order)           a muted line at the end of the panel
--   app.settings                    core/settings.lua
--   app.channel                     core/channel.lua: pi's events, heartbeat
--   app.loaded, app.ticks           the editor API is usable; poll ticks
--
-- Hooks the host runs:
--   ready            once, 100 ms after load: fs and the status bar work now
--   tick             every POLL_MS (40 ms)
--   second           every second
--   key (key)        a key press; a handler that returns true takes the key
--   file             a file opened or the tab changed (after ready)
--   change           the buffer changed
--   drop (name)      feature `name` failed and is dropped: forget what you keep for it
-- Features emit their own hooks too: "sessions", "owner", "follow" ...
--
-- A feature whose setup fails is dropped with all it registered, and so are
-- the features that need it; the others run. A hook handler that fails is
-- logged; the next handler runs.
local ttt = require("ttt")
local events = require("ttt.events")
local buffer = require("core.buffer")
local settings = require("core.settings")
local channel = require("core.channel")

local M = { POLL_MS = 40 }

local App = {}
App.__index = App

-- opts.dir: the plugin folder (its files: the channel, settings.json).
function M.new(opts)
	opts = opts or {}
	local app = setmetatable({
		dir = opts.dir or ttt.plugin_dir(),
		features = {}, by_name = {}, apis = {}, failed = {},
		hooks = {}, commands = {}, hints = {}, sections = {}, notes = {}, side = nil,
		current = "core", seq = 0, loaded = false, ticks = 0,
	}, App)
	local function owner() return app.current end
	app.log = opts.log or function(level, message) ttt.log(level, message) end
	app.settings = settings.new(app.dir .. "/settings.json", owner)
	app.channel = channel.new(app.dir, app.log, owner)
	return app
end

-- Features -------------------------------------------------------------------

-- `feature`: the table, or the name of its module ("features.plan"). A
-- module that fails to load is a feature that failed: the others run.
function App:use(feature)
	if type(feature) == "string" then
		local ok, mod = pcall(require, feature)
		if not ok then
			local name = feature:match("[^.]+$")
			self.failed[name] = tostring(mod)
			self.log("error", "symbiosis: feature " .. name .. " is off: " .. tostring(mod))
			return self
		end
		feature = mod
	end
	if type(feature) ~= "table" or type(feature.name) ~= "string" or type(feature.setup) ~= "function" then
		error("a feature is a table with a name and a setup function", 2)
	end
	if self.by_name[feature.name] then error("feature " .. feature.name .. " is used twice", 2) end
	self.by_name[feature.name] = feature
	table.insert(self.features, feature)
	return self
end

function App:get(name) return self.apis[name] end

function App:need(name)
	local api = self.apis[name]
	if api == nil then error("feature " .. self.current .. " needs " .. name .. ", which is not set up", 2) end
	return api
end

-- The features in the order they set up: each after the ones it needs, else
-- in the order of use(). Returns the order, and name -> why for the features
-- that cannot set up: a need that is not used (or failed to load), or a cycle.
function App:order()
	local out, state, bad = {}, {}, {}
	local function visit(f, path)
		if state[f.name] == "done" then return end
		if state[f.name] == "visiting" then
			bad[f.name] = "features need each other: " .. path .. " → " .. f.name
			return
		end
		state[f.name] = "visiting"
		for _, n in ipairs(f.needs or {}) do
			local dep = self.by_name[n]
			if not dep then
				bad[f.name] = bad[f.name] or ("needs " .. n .. ", which " .. (self.failed[n] and "failed" or "is not used"))
			else
				visit(dep, path == "" and f.name or (path .. " → " .. f.name))
			end
		end
		state[f.name] = "done"
		table.insert(out, f)
	end
	for _, f in ipairs(self.features) do visit(f, "") end
	return out, bad
end

-- Drops all that `name` registered.
function App:drop(name)
	local function keep(list)
		local out = {}
		for _, e in ipairs(list) do
			if e.owner ~= name then table.insert(out, e) end
		end
		return out
	end
	for hook, list in pairs(self.hooks) do self.hooks[hook] = keep(list) end
	self.commands, self.hints = keep(self.commands), keep(self.hints)
	self.sections, self.notes = keep(self.sections), keep(self.notes)
	if self.side and self.side.owner == name then self.side = nil end
	self.settings:drop(name)
	self.channel:drop(name)
	-- The other features drop what they keep for it (see replay.hold).
	self:emit("drop", name)
end

-- Sets up each feature. Returns the names of those that failed.
function App:setup()
	local order, bad = self:order()
	for _, f in ipairs(order) do
		local missing = nil
		for _, n in ipairs(f.needs or {}) do
			if self.apis[n] == nil then missing = n break end
		end
		if bad[f.name] then
			self.failed[f.name] = bad[f.name]
		elseif missing then
			self.failed[f.name] = "needs " .. missing .. ", which failed"
		else
			self.current = f.name
			local ok, api = pcall(f.setup, self)
			self.current = "core"
			if ok then
				self.apis[f.name] = api or {}
			else
				self:drop(f.name)
				self.failed[f.name] = tostring(api)
			end
		end
		if self.failed[f.name] then
			self.log("error", "symbiosis: feature " .. f.name .. " is off: " .. self.failed[f.name])
		end
	end
	return self.failed
end

-- Registries -------------------------------------------------------------------

local function entry(app, e)
	app.seq = app.seq + 1
	e.owner, e.seq = app.current, app.seq
	return e
end

local function sorted(list)
	table.sort(list, function(a, b)
		if a.order ~= b.order then return a.order < b.order end
		return a.seq < b.seq
	end)
end

function App:on(hook, fn, order)
	local list = self.hooks[hook] or {}
	self.hooks[hook] = list
	table.insert(list, entry(self, { fn = fn, order = order or 50 }))
	sorted(list)
end

local function failed(app, e, what, err)
	buffer.editing = false
	app.log("error", "symbiosis " .. tostring(e.owner) .. " " .. what .. ": " .. tostring(err))
end

-- Runs every handler of `hook`.
function App:emit(hook, ...)
	for _, e in ipairs(self.hooks[hook] or {}) do
		local ok, err = pcall(e.fn, ...)
		if not ok then failed(self, e, hook, err) end
	end
end

-- Runs the handlers of `hook` until one returns true; then returns true.
function App:first(hook, ...)
	for _, e in ipairs(self.hooks[hook] or {}) do
		local ok, taken = pcall(e.fn, ...)
		if not ok then failed(self, e, hook, taken)
		elseif taken == true then return true end
	end
	return false
end

-- def: { id, title, run, key = "ctrl+k x" (optional) }
function App:command(def)
	if type(def.id) ~= "string" or type(def.run) ~= "function" then error("a command needs an id and run", 2) end
	for _, c in ipairs(self.commands) do
		if c.id == def.id then error("command " .. def.id .. " is taken by " .. tostring(c.owner), 2) end
	end
	table.insert(self.commands, entry(self, { id = def.id, title = def.title or def.id, key = def.key, run = def.run, order = 0 }))
end

-- def: { key = "ctrl+k v", text = "pi's plan", order = 70 }
function App:hint(def)
	table.insert(self.hints, entry(self, { key = def.key, value = def.text, order = def.order or 50 }))
	sorted(self.hints)
end

-- def: { title, render(panel) }. ttt has one sidebar panel for each plugin.
function App:sidebar(def)
	if self.side then error("the sidebar is taken by " .. tostring(self.side.owner), 2) end
	self.side = entry(self, { title = def.title, render = def.render })
end

-- def: { render(panel), order }. The panel (ctrl+k h) draws the sections in order.
function App:section(def)
	table.insert(self.sections, entry(self, { render = def.render, order = def.order or 50 }))
	sorted(self.sections)
end

-- The drawer: one at a time in ttt. `id` names who opened it last, so a
-- feature closes only its own. ttt does not tell a plugin that Esc closed
-- it: after that, close_drawer(id) closes nothing, or whatever ttt shows
-- (a no-op when no drawer is open).
function App:open_drawer(id, opts)
	self.drawer = id
	ttt.open_drawer(opts)
end

function App:close_drawer(id)
	if self.drawer ~= id then return end
	self.drawer = nil
	ttt.close_drawer()
end

function App:note(text, order)
	table.insert(self.notes, entry(self, { text = text, order = order or 50 }))
	sorted(self.notes)
end

-- Start ------------------------------------------------------------------------

-- What ttt.register gets: the sidebar, the commands and their keys.
function App:registration()
	local reg = { commands = {}, keybindings = {} }
	if self.side then reg.sidebar = { title = self.side.title, render = self.side.render } end
	for _, c in ipairs(self.commands) do
		local cmd = c
		table.insert(reg.commands, {
			id = cmd.id,
			title = cmd.title,
			handler = function(...)
				local ok, err = pcall(cmd.run, ...)
				if not ok then failed(self, cmd, cmd.id, err) end
			end,
		})
		if cmd.key then table.insert(reg.keybindings, { key = cmd.key, command = cmd.id }) end
	end
	return reg
end

-- Sets up the features, registers them with ttt, and starts the clock.
function App:start()
	local channel = self.channel
	self:on("tick", function() channel:poll() end, 0)
	self:on("ready", function() channel:heartbeat() end, 90)
	self:on("second", function() channel:heartbeat() end, 90)
	self:setup()
	ttt.register(self:registration())

	events.on("key.press", function(key)
		if buffer.editing then return false end
		return self:first("key", key)
	end)
	local function on_file()
		if self.loaded then self:emit("file") end
	end
	events.on("file.open", on_file)
	events.on("tab.change", on_file)
	events.on("editor.change", function() self:emit("change") end)

	-- fs.read and the status bar are not ready while the plugin loads.
	ttt.set_timeout(100, function()
		self.loaded = true
		local ok, err = pcall(self.settings.load, self.settings)
		if not ok then self.log("error", "symbiosis settings.json: " .. tostring(err)) end
		self:emit("ready")
		local off = {}
		for name in pairs(self.failed) do table.insert(off, name) end
		if #off > 0 then
			table.sort(off)
			ttt.notify("symbiosis: off after an error: " .. table.concat(off, ", ") .. " (see ttt's log)", "error")
		end
		ttt.set_interval(M.POLL_MS, function()
			self.ticks = self.ticks + 1
			self:emit("tick")
		end)
		ttt.set_interval(1000, function() self:emit("second") end)
	end)
	return self
end

return M
