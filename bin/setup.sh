#!/bin/sh
# Sets up this copy of symbiosis on the machine, after pi installed it as a
# package. install.sh and the herdr plugin's build run it; it asks nothing.
#
#   * builds the ttt plugin from ttt/src (git does not hold the bundle) and
#     copies it into ttt's plugin folder (a ttt plugin cannot read through a
#     link out of its folder); pi also does both each time it starts
#   * links the command: ~/.local/bin/symbiosis -> <this copy>/bin/symbiosis,
#     so the launcher, the pi extension and the ttt plugin come from one copy
#     and `pi update` updates all three
#   * with Claude Code there (`claude` on PATH): this copy goes into
#     CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json, so Claude loads the
#     symbiosis hooks from it too (claude/setup.mjs)
#
# Honours TTT_CONFIG_DIR, CLAUDE_CONFIG_DIR and SYMBIOSIS_BIN_DIR (default ~/.local/bin).
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
ok() { printf '✓ %s\n' "$*"; }
say() { printf '%s\n' "$*"; }

dest="${TTT_CONFIG_DIR:-$HOME/.config/ttt}/plugins/symbiosis"
# The build needs Node 24 (it runs TypeScript). When `node` here is older, pi
# (which runs the extension itself) builds and copies the plugin when it starts.
mkdir -p "$dest"
if node "$repo/ttt/build.ts" >/dev/null 2>&1; then
	cp "$repo/ttt/symbiosis/plugin.lua" "$repo/ttt/symbiosis/plugin.ttt.json" "$dest/"
	ok "ttt plugin built and copied to $dest (ttt asks you to allow it on its next start)"
else
	say "  could not build the ttt plugin with $(command -v node || echo 'no node') (needs Node 24): pi builds and copies it when it starts"
fi

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

if command -v claude >/dev/null 2>&1; then
	node "$repo/claude/setup.mjs" "$repo" || say "  could not add symbiosis to Claude Code's settings (claude/setup.mjs)"
fi
