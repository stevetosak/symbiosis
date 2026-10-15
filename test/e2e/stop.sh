#!/usr/bin/env bash
# The status bar says when pi waits on a dialog in its own pane, and ctrl+k q
# stops pi's turn (test/e2e/stop.ts), in a headless ttt.
# Usage: test/e2e/stop.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-e2e.XXXXXX)}
# The real path: ttt's fs sees no symlinks (macOS: /tmp, /var -> /private/...).
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
export TTT_CONFIG_DIR="$OUT/cfg"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws"
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
echo 'export const x = 1;' > "$OUT/ws/a.ts"

# pi shows its dialog at about 2.5 s and ends it at about 8.5 s. The notice
# shows for 5 s, then the bar shows it.
steps="wait 3500; screenshot $OUT/notice.txt; wait 4500; screenshot $OUT/waits.txt; wait 2000; screenshot $OUT/working.txt; key ctrl+k q; wait 1500; quit"
(cd "$OUT/ws" && ttt --size 140x24 a.ts --exec "$steps" > /dev/null 2>&1) &
ttt=$!
# The fake pi loads pi's package first (about 0.8 s): it starts earlier.
sleep 0.4
"$repo/bin/run-node" "$repo/test/e2e/stop.ts" "$OUT/ws" > "$OUT/pi.log" 2>&1 &
pi=$!
wait $ttt || true
wait $pi || true
cat "$OUT/pi.log"
fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
grep -q 'owner: this' "$OUT/pi.log" || fail "the editor did not follow the fake pi"
grep -q 'π ws ? waits for you' "$OUT/waits.txt" || fail "the bar does not say pi waits"
grep -q 'waits for you: Allow this one call' "$OUT/notice.txt" || fail "no notice with the dialog's title"
grep -q 'π ws ● working' "$OUT/working.txt" || fail "the bar does not go back to working"
grep -q 'waits for you' "$OUT/working.txt" && fail "the notice stays after the dialog"
grep -q 'aborts: 1' "$OUT/pi.log" || fail "ctrl+k q did not stop the turn"
echo "all passed ($OUT)"
