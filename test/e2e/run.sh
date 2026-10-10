#!/usr/bin/env bash
# End to end against a headless ttt: a throw-away config with the plugin
# installed and allowed, a throw-away workspace, the pi side driven by
# drive.ts. Screenshots every 250 ms go to $OUT/shot-NN.txt, the editor state
# to $OUT/debug.json. Usage: test/e2e/run.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d)}
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws"
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
printf 'notes\n' > "$OUT/ws/notes.txt"

steps="wait 1500"
for i in $(seq -w 1 ${SHOTS:-40}); do steps="$steps; screenshot $OUT/shot-$i.txt; wait ${SHOT_MS:-250}"; done
steps="$steps; debug $OUT/debug.json; quit"

cd "$OUT/ws"
TTT_CONFIG_DIR="$OUT/cfg" ttt --size 90x30 notes.txt --exec "$steps" > /dev/null 2>&1 &
ttt_pid=$!
sleep 1.2
TTT_CONFIG_DIR="$OUT/cfg" "$repo/bin/run-node" "$repo/test/e2e/drive.ts" "$OUT/ws"
wait $ttt_pid || true
echo "out: $OUT"
