#!/usr/bin/env bash
# The file tree follows pi (test/e2e/tree.ts) in a headless ttt opened on a
# folder: ttt's tree opens to pi's file; the "pi files" panel shows pi's files
# also outside that folder, and while it is on screen the tree stays on it.
# Usage: test/e2e/tree.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d)}
export TTT_CONFIG_DIR="$OUT/cfg"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws/src" "$OUT/ws/docs"
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
echo '{"speed":0}' > "$OUT/cfg/plugins/symbiosis/settings.json"
# A wide sidebar, so the "pi files" tab shows and a click reaches it.
echo '{"sidebarWidth":70}' > "$OUT/cfg/state.json"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
echo "notes" > "$OUT/ws/docs/notes.md"

# pi writes src/deep/a.ts at about 2 s and the outside file at about 6.5 s.
steps="wait 5000; screenshot $OUT/explorer.txt; click 37 2; wait 4500; screenshot $OUT/panel.txt; quit"
(cd "$OUT/ws" && ttt --size 150x24 . --exec "$steps" > /dev/null 2>&1) &
ttt=$!
sleep 1.2
GAP_MS=4000 HOLD_MS=6000 "$repo/bin/run-node" "$repo/test/e2e/tree.ts" "$OUT/ws" "$OUT/other" > "$OUT/pi.log" 2>&1 &
pi=$!
wait $ttt || true
kill $pi 2> /dev/null || true
cat "$OUT/pi.log"
fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
side() { cut -c1-72 "$1"; }
side "$OUT/explorer.txt" | grep -q '▼ deep' || fail "ttt's tree did not open to src/deep"
side "$OUT/explorer.txt" | grep -q 'a.ts' || fail "ttt's tree does not show a.ts"
side "$OUT/panel.txt" | grep -q '▶ ws' || fail "the panel does not show the session the editor follows"
side "$OUT/panel.txt" | grep -q 'deep/' || fail "the panel does not show src/deep"
side "$OUT/panel.txt" | grep -q 'other/' || fail "the panel does not show the folder outside ttt's tree"
side "$OUT/panel.txt" | grep -q '✎ a.ts' || fail "the panel does not mark the file pi changed last"
grep -q 'not in the explorer' "$OUT/panel.txt" && fail "the reveal ran for a file outside ttt's tree"
side "$OUT/explorer.txt"
side "$OUT/panel.txt"
echo "out: $OUT"
