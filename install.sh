#!/bin/sh
# Installs symbiosis: the pi coding agent works inside the ttt editor.
#
#   curl -fsSL https://raw.githubusercontent.com/stevetosak/symbiosis/main/install.sh | sh
#
# Without herdr: installs herdr, ttt and pi with their own official
# installers, then the symbiosis herdr plugin. With herdr: adds the plugin,
# and installs ttt or pi only if one is missing. Each official installer is a
# script from the internet that runs on this machine, as this one does:
#   herdr  https://herdr.dev/install.sh
#   ttt    https://raw.githubusercontent.com/eugenioenko/ttt/main/install.sh
#   pi     https://pi.dev/install.sh
#
# It binds a herdr key to "Open symbiosis" (prefix+shift+s, or SYMBIOSIS_KEY)
# unless the config already binds that key or the action. It asks one
# question, on the terminal: install herdr's pi integration?
# Answer it beforehand with SYMBIOSIS_HERDR_INTEGRATION=yes or =no.
# SYMBIOSIS_PLUGIN_DIR=<checkout>/herdr-plugin links a local checkout instead.
set -eu

PLUGIN="stevetosak/symbiosis/herdr-plugin"
PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"
export PATH

ok() { printf '✓ %s\n' "$*"; }
say() { printf '%s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

# A yes/no question on the terminal (stdin is this script when piped). No: the default.
ask() {
	if ! (: </dev/tty) 2>/dev/null; then return 1; fi
	printf '%s [y/N] ' "$1" >/dev/tty
	answer=
	IFS= read -r answer </dev/tty || answer=
	case "$answer" in y | Y | yes | YES | Yes) return 0 ;; *) return 1 ;; esac
}

case "$(uname -s)" in
Linux | Darwin) ;;
*) fail "symbiosis runs on Linux and macOS only" ;;
esac
has curl || fail "curl is needed"
has git || fail "git is needed (herdr and pi clone the plugin)"

if has herdr; then
	mode=plugin
	ok "herdr is there: $(herdr --version 2>/dev/null | head -1)"
else
	mode=full
	say "Installing herdr..."
	curl -fsSL https://herdr.dev/install.sh | sh
	has herdr || fail "herdr was installed but is not found"
	ok "herdr installed"
fi

if has ttt; then
	ok "ttt is there"
else
	say "Installing ttt..."
	curl -sSfL https://raw.githubusercontent.com/eugenioenko/ttt/main/install.sh | sh
	has ttt || fail "ttt was installed but is not found"
	ok "ttt installed"
fi

if has pi; then
	ok "pi is there"
else
	say "Installing pi (it may ask to install Node.js)..."
	# Through cat: pi's installer then does not offer to start pi here.
	curl -fsSL https://pi.dev/install.sh | sh | cat
	has pi || fail "pi was not installed; see the messages above"
	ok "pi installed"
fi

say "Adding the symbiosis plugin to herdr..."
if [ -n "${SYMBIOSIS_PLUGIN_DIR:-}" ]; then
	# A local checkout, for work on symbiosis and its tests.
	# herdr does not run a linked plugin's build: this script does.
	(cd "$SYMBIOSIS_PLUGIN_DIR" && sh scripts/build.sh)
	herdr plugin link "$SYMBIOSIS_PLUGIN_DIR" >/dev/null
else
	herdr plugin install "$PLUGIN" --yes
fi
ok "herdr plugin: Open symbiosis"

# A key for "Open symbiosis": herdr has no menu for plugin actions.
config="${HERDR_CONFIG_PATH:-$HOME/.config/herdr/config.toml}"
key="${SYMBIOSIS_KEY:-prefix+shift+s}"
if [ -f "$config" ] && grep -q '"symbiosis.open"' "$config"; then
	key=$(grep -B3 '"symbiosis.open"' "$config" | sed -n 's/^key[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' | tail -1)
	ok "herdr key for Open symbiosis is there${key:+: $key}"
elif [ -f "$config" ] && grep -q "^key[[:space:]]*=[[:space:]]*\"$key\"" "$config"; then
	say "  $key is taken in $config; bind symbiosis.open to another key (see the README)"
	key=
else
	mkdir -p "$(dirname "$config")"
	if [ -s "$config" ]; then printf '\n' >>"$config"; fi
	cat >>"$config" <<KEY
[[keys.command]]
key = "$key"
type = "plugin_action"
command = "symbiosis.open"
description = "open symbiosis (ttt + pi)"
KEY
	herdr server reload-config >/dev/null 2>&1 || true
	ok "herdr key $key opens symbiosis (added to $config)"
fi

# herdr's own pi integration: optional, symbiosis does not need it.
status=$(herdr integration status 2>/dev/null | grep '^pi:' || true)
case "$status" in
*"not installed"* | "")
	case "${SYMBIOSIS_HERDR_INTEGRATION:-ask}" in
	yes | y) want=yes ;;
	no | n) want=no ;;
	*)
		say ""
		say "herdr's pi integration shows in herdr's sidebar when pi works, waits or is done."
		say "It adds one file: ~/.pi/agent/extensions/herdr-agent-state.ts. symbiosis works without it."
		if ask "Install herdr's pi integration?"; then want=yes; else want=no; fi
		;;
	esac
	if [ "$want" = yes ]; then
		herdr integration install pi
		ok "herdr pi integration installed"
	else
		say "  Skipped. Later: herdr integration install pi"
	fi
	;;
*) ok "herdr pi integration is there" ;;
esac

say ""
say "symbiosis is installed. Next:"
if [ "$mode" = full ]; then
	say "  1. Open a new terminal, go to a project folder and run: herdr"
else
	say "  1. In herdr, go to a workspace with your project."
fi
if [ -n "$key" ]; then
	say "  2. Press $key (prefix is ctrl+b by default), or run: herdr plugin action invoke symbiosis.open"
else
	say "  2. Run: herdr plugin action invoke symbiosis.open"
fi
say "     A tab opens with ttt on the left and pi on the right."
say "  3. ttt asks you to allow the symbiosis plugin: allow it."
say "  4. pi needs a model once: /login, or an API key."
