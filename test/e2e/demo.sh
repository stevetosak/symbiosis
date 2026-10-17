#!/usr/bin/env bash
# The demo's scripted pi (demo/scripted-pi) end to end against headless ttt: turn 1 in one ttt,
# then a second ttt types the three helpi! questions of the demo in store.ts:
# code (remove), a note (why), an ask (test) that the demo's turn answers.
# At the end the workspace's own tests must pass. Usage: test/e2e/demo.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-e2e.XXXXXX)}
# The real path: ttt's fs sees no symlinks (macOS: /tmp, /var -> /private/...).
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
export DEMO_DIR="$OUT/ws" XDG_STATE_HOME="$OUT/state" TTT_CONFIG_DIR="$OUT/cfg" PAUSE_MS=${PAUSE_MS:-300} SUGGEST_MS=${SUGGEST_MS:-60000}
mkdir -p "$OUT/cfg/plugins/symbiosis"
"$repo/bin/run-node" "$repo/ttt/build.ts" >/dev/null
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
echo "{\"speed\":${SPEED:-1280},\"lag\":${LAG:-3}}" > "$OUT/cfg/plugins/symbiosis/settings.json"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"

# The copy as `npm run demo -- --reset` makes it, then the scripted pi in it,
# as the symbiosis command starts it (without the launcher: ttt is headless here).
"$repo/bin/run-node" "$repo/demo/run.ts" --reset > "$OUT/reset.log" 2>&1
(cd "$DEMO_DIR" && exec "$repo/demo/scripted-pi" > "$OUT/demo.log" 2>&1) &
demo=$!

steps="wait-for store.done(7) timeout=30000; screenshot $OUT/turn1.txt; quit"
(cd "$DEMO_DIR" && ttt --size 100x32 store.ts --exec "$steps" > /dev/null 2>&1) || true
until grep -q 'turn 1 done' "$OUT/demo.log"; do
	kill -0 $demo 2> /dev/null || { cat "$OUT/demo.log"; exit 1; }
	sleep 0.2
done

# The operator: in store.ts, on a new line after done() (2 lines above list()).
at=$(($(grep -n '^	list(): Todo' "$DEMO_DIR/store.ts" | cut -d: -f1) - 2))
steps="wait 2000"
for _ in $(seq $((at - 1))); do steps="$steps; key down"; done
steps="$steps; key end; key enter; type // remove a to-do by id helpi!; wait 2500; screenshot $OUT/code.txt"
steps="$steps; key end; key enter; type // why does list() copy? helpi!; key enter; wait 1500; screenshot $OUT/note.txt"
steps="$steps; type // write a test for remove helpi!; wait 1500; key ctrl+s"
steps="$steps; wait-for store.remove(1) timeout=30000; wait 1000; screenshot $OUT/answer.txt; quit"
(cd "$DEMO_DIR" && ttt --size 100x32 store.ts --exec "$steps" > /dev/null 2>&1) || true

for _ in $(seq 100); do grep -q 'done (1)' "$OUT/demo.log" && break; sleep 0.2; done
kill -INT $demo 2> /dev/null || true
wait $demo || true
sed 's/\x1b\[[0-9;]*m//g' "$OUT/demo.log"
echo "== store.ts"; cat "$DEMO_DIR/store.ts"
fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
grep -q 'helpi!' "$DEMO_DIR/store.ts" && fail "a helpi! marker is still in store.ts"
grep -q '^	remove(id: number): boolean {$' "$DEMO_DIR/store.ts" || fail "no remove() in store.ts"
grep -q '^	// pi: list() returns a copy' "$DEMO_DIR/store.ts" || fail "no note under the why question"
grep -q 'asked demo' "$DEMO_DIR/store.ts" || fail "no ask line"
grep -q "test('remove" "$DEMO_DIR/store.test.ts" || fail "the ask turn wrote no test"
(cd "$DEMO_DIR" && "$repo/bin/run-node" --test store.test.ts > "$OUT/test.log" 2>&1) || { cat "$OUT/test.log"; echo "FAIL: the workspace tests"; exit 1; }
grep -E '^ℹ (pass|fail)' "$OUT/test.log"
echo "out: $OUT"
