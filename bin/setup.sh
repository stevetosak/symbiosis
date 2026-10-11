#!/bin/sh
# Sets up this copy of symbiosis on the machine, after pi installed it as a
# package. install.sh and the herdr plugin's build run it; it asks nothing.
#
#   * copies the ttt plugin into ttt's plugin folder (a ttt plugin cannot read
#     through a link out of its folder); pi also does this each time it starts
#   * links the command: ~/.local/bin/symbiosis -> <this copy>/bin/symbiosis,
#     so the launcher, the pi extension and the ttt plugin come from one copy
#     and `pi update` updates all three
#
# Honours TTT_CONFIG_DIR and SYMBIOSIS_BIN_DIR (default ~/.local/bin).
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
ok() { printf '✓ %s\n' "$*"; }
say() { printf '%s\n' "$*"; }

dest="${TTT_CONFIG_DIR:-$HOME/.config/ttt}/plugins/symbiosis"
mkdir -p "$dest"
cp "$repo/ttt/symbiosis/plugin.lua" "$repo/ttt/symbiosis/plugin.ttt.json" "$dest/"
ok "ttt plugin copied to $dest (ttt asks you to allow it on its next start)"

bindir="${SYMBIOSIS_BIN_DIR:-$HOME/.local/bin}"
link="$bindir/symbiosis"
target="$repo/bin/symbiosis"
mkdir -p "$bindir"
if [ -e "$link" ] && [ ! -L "$link" ]; then
	say "  $link exists and is not a link: left alone. Remove it, then run $0 again."
elif [ "$(readlink "$link" 2>/dev/null || true)" = "$target" ]; then
	ok "command $link is there"
else
	ln -sf "$target" "$link"
	ok "command $link -> $target"
fi
case ":${SYMBIOSIS_PATH:-$PATH}:" in
*":$bindir:"*) ;;
*) say "  $bindir is not on your PATH: add it, or run $link" ;;
esac
