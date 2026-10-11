#!/bin/sh
# The "Open symbiosis" action: a new tab in the workspace folder, ttt on the
# left and pi on the right. herdr runs actions without a terminal, so this
# script only makes the panes and types the commands into their shells. pi
# has the focus: you talk to it.
set -eu

HERDR="${HERDR_BIN_PATH:-herdr}"

# A string field from herdr's context JSON (no jq on every machine).
field() {
	printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" \
		| grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
		| head -1 \
		| sed "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"//; s/\"\$//"
}

# The first pane ID after a key in a herdr reply.
pane_after() {
	printf '%s' "$2" | tr -d '\n' | sed -n "s/.*\"$1\"[^}]*\"pane_id\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

# The folder: as the ttt.editor plugin picks it.
dir=$(field checkout_path)
[ -n "$dir" ] || dir=$(field focused_pane_cwd)
[ -n "$dir" ] || dir=$(field workspace_cwd)
[ -n "$dir" ] || dir=$PWD

tab=$("$HERDR" tab create --cwd "$dir" --label symbiosis --focus)
editor=$(pane_after root_pane "$tab")
[ -n "$editor" ] || { echo "symbiosis: no pane in the new tab: $tab" >&2; exit 1; }

split=$("$HERDR" pane split "$editor" --direction right --ratio "${SYMBIOSIS_RATIO:-0.6}" --cwd "$dir" --focus)
agent=$(pane_after pane "$split")
[ -n "$agent" ] || { echo "symbiosis: the split made no pane: $split" >&2; exit 1; }

"$HERDR" pane run "$editor" "ttt ."
"$HERDR" pane run "$agent" "pi"
