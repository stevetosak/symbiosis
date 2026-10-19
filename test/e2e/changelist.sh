#!/usr/bin/env bash
# The plan drawer (ctrl+k v) lists each plan step with the files pi named for
# it and the files it really changed (test/e2e/changelist.ts), in a headless ttt.
# Usage: test/e2e/changelist.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-e2e.XXXXXX)}
# The real path: ttt's fs sees no symlinks (macOS: /tmp, /var -> /private/...).
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
export TTT_CONFIG_DIR="$OUT/cfg"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws"
"$repo/bin/run-node" "$repo/ttt/build.ts" >/dev/null
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
echo 'export const x = 1;' > "$OUT/ws/a.ts"

# The drawer opens after pi wrote (about 3 s); Tab goes into the list, Enter
# opens the file under the cursor.
steps="wait 4000; key ctrl+k v; wait 1200; screenshot $OUT/drawer.txt; key tab; key down; key enter; wait 1500; key escape; wait 300; screenshot $OUT/opened.txt; debug $OUT/debug.json; key ctrl+k .; wait 1200; screenshot $OUT/diff.txt; click 24 2; wait 500; screenshot $OUT/back.txt; key ctrl+k /; wait 1500; screenshot $OUT/seen.txt; key ctrl+k v; wait 600; key tab; key down; wait 300; screenshot $OUT/seen-row.txt; key down; key d; wait 1200; screenshot $OUT/row-diff.txt; key ctrl+k v; wait 400; key tab; key up; key up; key up; key up; key down; key down; key s; wait 800; screenshot $OUT/row-seen.txt; quit"
(cd "$OUT/ws" && ttt --size 140x30 a.ts --exec "$steps" > /dev/null 2>&1) &
ttt=$!
sleep 0.4
"$repo/bin/run-node" "$repo/test/e2e/changelist.ts" "$OUT/ws" > "$OUT/pi.log" 2>&1 &
pi=$!
wait $ttt || true
wait $pi || true
cat "$OUT/pi.log"
fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
grep -q 'owner: this' "$OUT/pi.log" || fail "the editor did not follow the fake pi"
grep -q '▶ Write the store' "$OUT/drawer.txt" || fail "the step is not in the drawer"
grep -q '● store.ts · new' "$OUT/drawer.txt" || fail "the file pi wrote under its step is not listed as changed"
grep -q '● extra.ts · new · unplanned' "$OUT/drawer.txt" || fail "the file no step named is not marked unplanned"
grep -q '· store.test.ts · planned' "$OUT/drawer.txt" || fail "a planned file pi has not reached is not listed"
grep -q '· Document it' "$OUT/drawer.txt" || fail "the next step is not in the drawer"
grep -q '    kept' "$OUT/drawer.txt" || fail "a long step title is cut at the drawer's edge, not wrapped"
grep -q '│ store.ts x │' "$OUT/opened.txt" || fail "Enter on the file row did not open it"
grep -q '▌ 1  export const store' "$OUT/opened.txt" || fail "no change bar on the line pi wrote"
grep -q 'pi · Write the store · new file · the store is a Map' "$OUT/debug.json" || fail "no hover text (step and why) on the changed lines"
grep -q 'the store is a Map' "$OUT/diff.txt" || fail "ctrl+k . did not open the diff of the change (no why notice)"
grep -q 'store.ts' "$OUT/diff.txt" || fail "no diff tab for store.ts"
grep -q '▌ 1  export const store' "$OUT/seen.txt" && fail "the change bar stayed after ctrl+k /"
grep -q '│ store.ts x │' "$OUT/back.txt" || fail "the click did not go back to store.ts"
grep -q '▌ 1  export const store' "$OUT/back.txt" || fail "the change bar is not back before ctrl+k /"
grep -q '│  1  export const store' "$OUT/seen.txt" || fail "store.ts is not open after ctrl+k /"
grep -q '✓ store.ts' "$OUT/seen-row.txt" || fail "the file row is not marked seen in the drawer"
grep -q 'extra.ts (diff)' "$OUT/row-diff.txt" || fail "d on a file row did not open its diff"
grep -q '✓ extra.ts' "$OUT/row-seen.txt" || fail "s on a file row did not mark it seen"
echo "all passed ($OUT)"
