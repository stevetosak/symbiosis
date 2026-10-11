# symbiosis herdr plugin

```bash
herdr plugin install stevetosak/symbiosis/herdr-plugin
```

- **Build** (`scripts/build.sh`, once at install and update): installs ttt if
  it is missing, checks that pi is there, runs
  `pi install git:github.com/stevetosak/symbiosis` unless pi already lists a
  symbiosis package, and copies the ttt plugin into
  `~/.config/ttt/plugins/symbiosis`. It cannot install pi: pi's installer asks
  questions on the terminal and herdr runs builds without one. The
  repository's `install.sh` does that.
- **Action "Open symbiosis"** (`symbiosis.open`, `scripts/open.sh`): a new tab
  named `symbiosis` in the folder of the focused pane (a worktree's checkout
  first, the workspace folder last), with `ttt .` on the left (60 %) and `pi`
  on the right, which has the focus. `SYMBIOSIS_RATIO` changes the split.
  herdr has no menu for plugin actions: bind a key (`type = "plugin_action"`,
  `command = "symbiosis.open"`, see the main README) or run
  `herdr plugin action invoke symbiosis.open`. The repository's `install.sh`
  binds `prefix+shift+s`; `herdr plugin install` alone does not.

From a checkout, `herdr plugin link herdr-plugin` does not run the build; run
`sh herdr-plugin/scripts/build.sh` yourself, or use `npm run install:local`.
