# The ttt plugin

ttt runs one Lua file per plugin (Lua 5.1), and its `require` loads only
ttt's own modules (`ttt`, `ttt.editor`, `ttt.fs`, ...): a plugin cannot load
a file next to it. So the sources are here, in modules, and `npm run build`
(`ttt/build.ts`) bundles them into `ttt/symbiosis/plugin.lua`, the file ttt
runs. Git ignores the bundle (a generated file in git conflicts at every
merge and goes stale). pi builds it when it starts, and `bin/setup.sh`,
`install.ts` and the tests build it too. Never edit the bundle.

```
ttt/
  build.ts              the bundler: ttt/src/a/b.lua is the module "a.b"
  src/
    main.lua            the entry: the features, in order
    core/
      app.lua           the host: features, hooks, commands, the panel's parts
      channel.lua       pi's events (events.jsonl, head.json), ttt.json
      settings.lua      settings, settings.json
      buffer.lua        changes to the buffer (regions, the `editing` flag)
      util.lua          pure helpers: text, positions, paths, keys
      marker.lua        a word at the end of a comment (helpi!)
      trigger.lua       a marker's pause and Enter, once for each text (helpi!, why!)
      notes.lua         the pure parts of notes: hash, anchoring, file path, JSON lines
      gutter.lua        gutter marks of one icon on ttt's bookmarks (notes ◆, review ●)
      review.lua        the pure parts of review: the list, finding a function again, choosing
      folder.lua        the workspace folder of a file
    features/
      sessions.lua      the pi sessions; the one the editor follows
      changemarks.lua   the lines pi changed: a gutter bar by plan step, hover text; seen marks (ctrl+k /)
      changediff.lua    the exact diff of one change (ctrl+k . and `d` in the plan drawer)
      plan.lua          pi's plan in the status bar, ctrl+k v: the steps with their files and changes
      tree.lua          the "pi files" sidebar
      follow.lua        which file pi writes; when you follow pi, types its changes as a preview
      autosave.lua      saves the file a while after you type
      helpi.lua         `// ... helpi!` asks pi
      ask.lua           ctrl+k d and `why!`: ask pi about code, in a drawer
      notes.lua         the answers kept for their lines, ◆ in the gutter
      review.lua        ctrl+k x: the bodies pi filled, until acked; ● in the gutter
      fill.lua          a fill (a stub, or a function under its description), ctrl+k f; proposals, ctrl+k p
      changes.lua       ctrl+k w: what pi changed
      close.lua         ctrl+k z: close symbiosis (pi and ttt)
      panel.lua         ctrl+k h: settings, sessions, keys
  symbiosis/
    plugin.lua          GENERATED, not in git
    plugin.ttt.json     the manifest (permissions, version)
```

## A feature

A feature is a module that returns a table: a name, the features it needs,
and `setup(app)`. What setup returns is its API, for the others.

```lua
-- ttt/src/features/hello.lua
local ttt = require("ttt")

return {
	name = "hello",
	needs = { "sessions" },
	setup = function(app)
		local sessions = app:need("sessions")

		app.settings:define("greet", {
			values = { true, false }, label = "Greeting", order = 50,
			text = function(v) return v and "on" or "off" end,
		})

		local function hello()
			local owner = sessions.owner()
			if app.settings:get("greet") and owner then ttt.notify("hello, " .. owner.name) end
		end

		app:command({ id = "symbiosis.hello", title = "symbiosis: Hello", key = "ctrl+k y", run = hello })
		app:hint({ key = "ctrl+k y", text = "say hello", order = 130 })
		app:on("sessions", function() end) -- after each refresh of the sessions
		return { hello = hello }
	end,
}
```

Then one line in `ttt/src/main.lua`: `app:use("features.hello")`,
and `npm run build`. If it uses a new ttt permission, add it to
`ttt/symbiosis/plugin.ttt.json`.

What the host gives (`ttt/src/core/app.lua` has the details):

| | |
|---|---|
| `app:need(name)`, `app:get(name)` | another feature's API; `get` gives nil when it is not there |
| `app:on(hook, fn, order)` | a hook; lower `order` runs first (default 50) |
| `app:emit(hook, ...)` | runs a hook: features have their own hooks too |
| `app:command{ id, title, key, run }` | a command, with a key if you give one |
| `app:hint{ key, text, order }` | a line in the panel's key list |
| `app:section{ render, order }` | a part of the panel (ctrl+k h) |
| `app:note(text, order)` | a muted line at the end of the panel |
| `app:sidebar{ title, render }` | the sidebar panel (one for the plugin) |
| `app.settings:define(key, def)` | a setting: the panel shows it, `settings.json` keeps it |
| `app.channel:on(op, fn)` | pi's events with that `op` (one feature for each op) |
| `app.channel:heartbeat_field(fn)` | a field in `ttt.json`, which pi reads |
| `app.loaded`, `app.ticks`, `app.log` | the editor API is ready; poll ticks; ttt's log |

The hooks of the host: `ready` (once, 100 ms after load: the file system and
the status bar work then), `tick` (every 40 ms), `second`, `key` (a key
press: the first handler that returns true takes the key), `file` (a file
opened or the tab changed), `change` (the buffer changed). The features add
`sessions` (after each refresh), `follow` (the editor followed pi into a
file), `start`, `abort` and `done` (pi started, dropped or finished a call)
and `shown` (you saw a finished change: at once, or at the end of the preview).

The order of the `key` handlers: helpi! (10: Esc, Enter), follow (50:
your typing waits while the preview or helpi! writes in the file), autosave (90).

## Rules

- **A failure stays in its feature.** When `setup` fails, the feature is off:
  all it registered goes, and so do the features that need it; the others run,
  and ttt shows a notice. A hook handler, a command or a channel handler that
  fails is logged (ttt's log); the next one runs.
- **Changes to the buffer go through `core/buffer.lua`**, or set
  `buffer.editing = true` around them: the key and change hooks then know they
  are the plugin's own.
- **One feature owns a thing**: a channel op, a command id, a setting, the
  sidebar. Taking one twice is an error in `setup`.
- **Features talk through the host**: an API from `app:need`, or a hook.
  A feature does not require another feature's module (only to test it).
- **Pure parts are testable.** Put logic that needs no ttt API in `core/util.lua`
  or in plain functions of the feature, and export them on the feature table
  for the tests (`sessions.pick`, `plan.plan_line`, `helpi.render`, ...).
- The sandbox: no `print`, `load`, `loadstring`, `dofile`, `setfenv`; an
  unknown event name in `events.on` is an error.

## Tests

`test/lua` runs the sources and the bundle under LuaJIT, with a stand-in
for ttt (`test/lua/stub.lua`): `npm run test:lua`, or `npm test` (which also
checks that the bundle is up to date). The e2e tests (`README.md`, "Test")
run the bundle in a headless ttt.

An error in ttt's log names a line of the bundle; the bundle's header maps
its lines to the source files.
