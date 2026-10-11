# symbiosis herdr plugin

```bash
herdr plugin install stevetosak/symbiosis/herdr-plugin
```

- **Build** (`scripts/build.sh`, once at install and update): installs ttt if
  it is missing, checks that pi is there, runs
  `pi install git:github.com/stevetosak/symbiosis` unless pi already lists a
  symbiosis package, then runs that package's `bin/setup.sh`: it copies the
  ttt plugin into `~/.config/ttt/plugins/symbiosis` and links the command
  `~/.local/bin/symbiosis`. It cannot install pi: pi's installer asks
  questions on the terminal and herdr runs builds without one. The
  repository's `install.sh` does that.
- **Action "Open symbiosis"** (`symbiosis.open`, `scripts/open.sh`): runs
  `symbiosis <folder> --tab` for the folder of the focused pane (a worktree's
  checkout first, the workspace folder last): a new tab with ttt, and pi in a
  tab of its own (or on the right, with `"layout": "split"` in
  `~/.config/symbiosis/config.json`). When symbiosis already runs for that
  folder, it goes to its tab. A failure shows as a herdr notification.
  herdr has no menu for plugin actions: bind a key (`type = "plugin_action"`,
  `command = "symbiosis.open"`, see the main README) or run
  `herdr plugin action invoke symbiosis.open`. The repository's `install.sh`
  binds `prefix+shift+s`; `herdr plugin install` alone does not.

From a checkout, `herdr plugin link herdr-plugin` does not run the build; run
`npm run install:local` (it installs the checkout as the pi package and runs
its `bin/setup.sh`).
