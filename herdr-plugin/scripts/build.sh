#!/bin/sh
# herdr runs this from the plugin folder (herdr-plugin/ in a clone of the
# whole repo) when the plugin is installed or updated. It does not ask
# questions: herdr runs it without a terminal.
set -eu

PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"
REPO_DIR=$(cd "$(dirname "$0")/../.." && pwd)
PACKAGE="git:github.com/stevetosak/symbiosis"

ok() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

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

# One copy of the extension only: a checkout installed by path counts too.
if pi list 2>/dev/null | grep -q 'symbiosis'; then
	ok "pi package is there"
else
	pi install "$PACKAGE"
	ok "pi package installed: $PACKAGE"
fi

dest="${TTT_CONFIG_DIR:-$HOME/.config/ttt}/plugins/symbiosis"
mkdir -p "$dest"
cp "$REPO_DIR/ttt/symbiosis/plugin.lua" "$REPO_DIR/ttt/symbiosis/plugin.ttt.json" "$dest/"
ok "ttt plugin copied to $dest (ttt asks you to allow it on its next start)"
