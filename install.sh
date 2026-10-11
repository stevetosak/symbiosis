#!/bin/sh
# Installs symbiosis: the `symbiosis` command opens the ttt editor and a real
# pi coding agent beside it, and pi's writes type themselves into ttt.
#
#   curl -fsSL https://raw.githubusercontent.com/stevetosak/symbiosis/main/install.sh | sh
#
# It installs ttt and pi with their own official installers when one is
# missing, then the symbiosis pi package and the `symbiosis` command
# (~/.local/bin/symbiosis, a link into pi's copy of the package). Each official
# installer is a script from the internet that runs on this machine, as this
# one does:
#   ttt    https://raw.githubusercontent.com/eugenioenko/ttt/main/install.sh
#   pi     https://pi.dev/install.sh
#
# herdr is optional, and this script does not install it. With herdr there, it
# also adds the symbiosis herdr plugin, binds a herdr key to "Open symbiosis"
# (prefix+shift+s, or SYMBIOSIS_KEY) unless the config already binds that key
# or the action, and asks one question on the terminal: install herdr's pi
# integration? Answer it beforehand with SYMBIOSIS_HERDR_INTEGRATION=yes or =no.
#
# SYMBIOSIS_CHECKOUT=<a checkout> installs that checkout instead of GitHub's.
set -eu

PACKAGE="git:github.com/stevetosak/symbiosis"
PLUGIN="stevetosak/symbiosis/herdr-plugin"
SYMBIOSIS_PATH=$PATH
export SYMBIOSIS_PATH
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

# The folder of the symbiosis package, from `pi list`: a source line, then its path.
package_dir() {
	pi list 2>/dev/null | awk '/^  [^ ]/ { found = ($0 ~ /symbiosis/); next } found && /^    \// { sub(/^ +/, ""); print; exit }'
}

case "$(uname -s)" in
Linux | Darwin) ;;
*) fail "symbiosis runs on Linux and macOS only" ;;
esac
has curl || fail "curl is needed"
has git || fail "git is needed (pi clones the package)"

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

# One copy of the package only: a checkout installed by path counts too.
pkg=$(package_dir)
if [ -n "$pkg" ]; then
	ok "pi package is there: $pkg"
else
	source="${SYMBIOSIS_CHECKOUT:-$PACKAGE}"
	pi install "$source"
	pkg=$(package_dir)
	[ -n "$pkg" ] || fail "pi installed $source but does not list it"
	ok "pi package installed: $source"
fi
[ -x "$pkg/bin/setup.sh" ] || fail "$pkg has no bin/setup.sh: update it (pi update), then run this again"
sh "$pkg/bin/setup.sh"

key=
if has herdr; then
	ok "herdr is there: $(herdr --version 2>/dev/null | head -1)"
	say "Adding the symbiosis plugin to herdr..."
	if [ -n "${SYMBIOSIS_CHECKOUT:-}" ]; then
		# herdr does not run a linked plugin's build: this script did its work.
		herdr plugin link "$SYMBIOSIS_CHECKOUT/herdr-plugin" >/dev/null
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
fi

say ""
say "symbiosis is installed. Next:"
say "  1. Go to a project folder and run: symbiosis"
if has herdr; then
	if [ -n "$key" ]; then
		say "     In herdr, $key (prefix is ctrl+b by default) does the same in a new tab."
	else
		say "     In herdr, herdr plugin action invoke symbiosis.open does the same in a new tab."
	fi
elif has tmux; then
	say "     Run it in tmux: pi gets a window of its own."
else
	say "     In herdr or tmux, pi gets a tab of its own; without them, start pi in a"
	say "     second terminal. herdr: curl -fsSL https://herdr.dev/install.sh | sh"
fi
say "  2. ttt asks you to allow the symbiosis plugin: allow it."
say "  3. pi needs a model once: /login, or an API key."
