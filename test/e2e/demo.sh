#!/usr/bin/env bash
# The demo (demo/run.ts) end to end against a headless ttt: turn 1, then an
# AI! comment (written on disk; the clean buffer reloads), ctrl+k d, the answer.
# At the end the workspace's own tests must pass. Usage: test/e2e/demo.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d)}
export DEMO_DIR="$OUT/ws" TTT_CONFIG_DIR="$OUT/cfg" PAUSE_MS=${PAUSE_MS:-300} SUGGEST_MS=${SUGGEST_MS:-60000}
mkdir -p "$OUT/cfg/plugins/symbiosis"
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
echo "{\"speed\":${SPEED:-1280}}" > "$OUT/cfg/plugins/symbiosis/settings.json"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"

"$repo/bin/run-node" "$repo/demo/run.ts" > "$OUT/demo.log" 2>&1 &
demo=$!
until [ -f "$DEMO_DIR/store.ts" ]; do sleep 0.1; done

steps="wait-for store.done(7) timeout=30000; screenshot $OUT/turn1.txt"
steps="$steps; wait-for AI! timeout=60000; wait 500; key ctrl+k d"
steps="$steps; wait-for store.remove(1) timeout=60000; wait 1000; screenshot $OUT/answer.txt; debug $OUT/debug.json; quit"
(cd "$DEMO_DIR" && ttt --size 100x32 store.ts --exec "$steps" > /dev/null 2>&1) &
ttt=$!

until grep -q 'turn 1 done' "$OUT/demo.log"; do
	kill -0 $demo 2> /dev/null || { cat "$OUT/demo.log"; exit 1; }
	sleep 0.2
done
sleep 1
# The operator's comment, in the open file (pi's last change): the buffer is clean, so ttt reloads it.
sed -i "s|^test('done marks|// add remove(id) AI!\n&|" "$DEMO_DIR/store.test.ts"

wait $ttt || true
for _ in $(seq 100); do grep -q '^.*done (' "$OUT/demo.log" && break; sleep 0.2; done
kill -INT $demo 2> /dev/null || true
wait $demo || true
sed 's/\x1b\[[0-9;]*m//g' "$OUT/demo.log"
grep -q 'AI!' "$DEMO_DIR/store.test.ts" && { echo "FAIL: the marker is still in store.test.ts"; exit 1; }
grep -q 'remove(id: number)' "$DEMO_DIR/store.ts" || { echo "FAIL: no remove() in store.ts"; exit 1; }
(cd "$DEMO_DIR" && "$repo/bin/run-node" --test store.test.ts > "$OUT/test.log" 2>&1) || { cat "$OUT/test.log"; echo "FAIL: the workspace tests"; exit 1; }
grep -E '^ℹ (pass|fail)' "$OUT/test.log"
echo "out: $OUT"
