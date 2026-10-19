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
steps="wait 4000; key ctrl+k v; wait 1200; screenshot $OUT/drawer.txt; key tab; key down; key enter; wait 1500; screenshot $OUT/opened.txt; quit"
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
grep -q '│ store.ts x │' "$OUT/opened.txt" || fail "Enter on the file row did not open it"
echo "all passed ($OUT)"
