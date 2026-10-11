#!/bin/sh
# herdr runs this from the plugin folder (herdr-plugin/ in a clone of the
# whole repo) when the plugin is installed or updated. It does not ask
# questions: herdr runs it without a terminal. The symbiosis that runs is pi's
# copy of the package, not this clone: bin/setup.sh of that copy links the
# `symbiosis` command and copies the ttt plugin.
set -eu

SYMBIOSIS_PATH=$PATH
export SYMBIOSIS_PATH
PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"
PACKAGE="git:github.com/stevetosak/symbiosis"

ok() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

package_dir() {
	pi list 2>/dev/null | awk '/^  [^ ]/ { found = ($0 ~ /symbiosis/); next } found && /^    \// { sub(/^ +/, ""); print; exit }'
}

if command -v ttt >/dev/null 2>&1; then
	ok "ttt is there: $(ttt --version 2>/dev/null | head -1)"
else
	echo "Installing ttt (its official installer)..."
	curl -sSfL https://raw.githubusercontent.com/eugenioenko/ttt/main/install.sh | sh
	command -v ttt >/dev/null 2>&1 || fail "ttt was installed but is not on PATH"
	ok "ttt installed"
fi

if command -v pi >/dev/null 2>&1; then
	ok "pi is there: $(pi --version 2>/dev/null | head -1)"
else
	# pi's installer asks about Node.js on the terminal, and herdr gives this
	# script none. install.sh installs pi before it gets here.
	fail "pi is not installed. Install it: curl -fsSL https://pi.dev/install.sh | sh, then update this plugin (herdr plugin install stevetosak/symbiosis/herdr-plugin)"
fi

# One copy of the package only: a checkout installed by path counts too.
pkg=$(package_dir)
if [ -n "$pkg" ]; then
	ok "pi package is there: $pkg"
else
	pi install "$PACKAGE"
	pkg=$(package_dir)
	[ -n "$pkg" ] || fail "pi installed $PACKAGE but does not list it"
	ok "pi package installed: $PACKAGE"
fi
[ -x "$pkg/bin/setup.sh" ] || fail "$pkg has no bin/setup.sh: run pi update, then update this plugin"
sh "$pkg/bin/setup.sh"
