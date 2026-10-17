#!/usr/bin/env bash
# End to end against a headless ttt: a throw-away config with the plugin
# installed and allowed, a throw-away workspace, the pi side driven by
# drive.ts (HOLD_MS keeps the session alive at the end). Screenshots every 250 ms go to $OUT/shot-NN.txt, the editor state
# to $OUT/debug.json. Usage: test/e2e/run.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-e2e.XXXXXX)}
# The real path: ttt's fs sees no symlinks (macOS: /tmp, /var -> /private/...).
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws"
"$repo/bin/run-node" "$repo/ttt/build.ts" >/dev/null
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
# SPEED: the preview's typing speed in characters per second (0 = max); default the plugin's.
# LAG: how many changes pi may make before the editor shows them (-1 = no limit); default the plugin's.
echo "{${SPEED:+\"speed\":$SPEED,}\"lag\":${LAG:-3}}" > "$OUT/cfg/plugins/symbiosis/settings.json"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
printf 'notes\n' > "$OUT/ws/notes.txt"

steps="wait 1500"
for i in $(seq -w 1 ${SHOTS:-40}); do
	steps="$steps; screenshot $OUT/shot-$i.txt; wait ${SHOT_MS:-250}"
	# PLAN_AT=N: open the plan drawer (ctrl+k v) after shot N; PLAN_CLOSE_AT: ctrl+k v (focus it again), then Esc.
	if [ "$((10#$i))" = "${PLAN_AT:-0}" ]; then steps="$steps; key ctrl+k v; wait 300"; fi
	if [ "$((10#$i))" = "${PLAN_CLOSE_AT:-0}" ]; then steps="$steps; key ctrl+k v; wait 300; key escape; wait 300"; fi
	# DIFF_AT=N: show what pi changed (ctrl+k w) after shot N.
	if [ "$((10#$i))" = "${DIFF_AT:-0}" ]; then steps="$steps; key ctrl+k w; wait 400"; fi
	# PAUSE_AT / GO_AT=N: ctrl+k space (pause, then go on) after shot N. KEYS_AT=N: KEYS (e.g. "ctrl+k -") after shot N.
	if [ "$((10#$i))" = "${PAUSE_AT:-0}" ]; then steps="$steps; key ctrl+k space"; fi
	if [ "$((10#$i))" = "${GO_AT:-0}" ]; then steps="$steps; key ctrl+k space"; fi
	if [ "$((10#$i))" = "${KEYS_AT:-0}" ]; then steps="$steps; key $KEYS"; fi
done
steps="$steps; debug $OUT/debug.json; quit"

cd "$OUT/ws"
TTT_CONFIG_DIR="$OUT/cfg" ttt --size 90x30 notes.txt --exec "$steps" > /dev/null 2>&1 &
ttt_pid=$!
sleep 1.2
TTT_CONFIG_DIR="$OUT/cfg" "$repo/bin/run-node" "$repo/test/e2e/drive.ts" "$OUT/ws"
wait $ttt_pid || true
echo "out: $OUT"
