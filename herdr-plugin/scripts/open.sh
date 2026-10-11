#!/bin/sh
# The "Open symbiosis" action: runs `symbiosis <folder> --tab`, which opens a
# new tab with ttt, and pi in a tab of its own (or a split, by the config).
# When symbiosis already runs for the folder, it goes to that tab. herdr runs
# actions without a terminal, so a failure shows as a herdr notification.
set -eu

HERDR="${HERDR_BIN_PATH:-herdr}"

# A string field from herdr's context JSON (no jq on every machine).
field() {
	printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" \
		| grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
		| head -1 \
		| sed "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"//; s/\"\$//"
}

tell() { "$HERDR" notification show symbiosis --body "$1" >/dev/null 2>&1 || true; }

# The folder: as the ttt.editor plugin picks it.
dir=$(field checkout_path)
[ -n "$dir" ] || dir=$(field focused_pane_cwd)
[ -n "$dir" ] || dir=$(field workspace_cwd)
[ -n "$dir" ] || dir=$PWD

cmd="${SYMBIOSIS_BIN_DIR:-$HOME/.local/bin}/symbiosis"
[ -x "$cmd" ] || cmd=$(command -v symbiosis 2>/dev/null || true)
if [ -z "$cmd" ]; then
	tell "The symbiosis command is not installed. Run install.sh from github.com/stevetosak/symbiosis."
	exit 1
fi

if out=$("$cmd" "$dir" --tab 2>&1 </dev/null); then
	exit 0
fi
tell "$(printf '%s' "$out" | head -3)"
exit 1
