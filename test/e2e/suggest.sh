#!/usr/bin/env bash
# End to end for sessions and suggestions: two fake pi sessions run
# (suggest-drive.ts), one in the workspace, one in another folder. A headless
# ttt opens a file with AI!/AI? markers and presses ctrl+k d: only the
# workspace session may get the message. Then ctrl+k n: the other session
# takes over. Usage: test/e2e/suggest.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d)}
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws" "$OUT/other"
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.3.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
cd "$OUT/ws"
git init -q
cat > store.ts <<'TS'
// A store for to-do items.

export class Store {
	private next = 0; // start at 1 AI!

	// Why not a Map? AI?
	add(text: string) {
		return { id: this.next++, text };
	}
}
TS

TTT_CONFIG_DIR="$OUT/cfg" "$repo/bin/run-node" "$repo/test/e2e/suggest-drive.ts" "$OUT/ws" 9000 > "$OUT/pi-ws.txt" &
ws_pid=$!
TTT_CONFIG_DIR="$OUT/cfg" "$repo/bin/run-node" "$repo/test/e2e/suggest-drive.ts" "$OUT/other" 9000 > "$OUT/pi-other.txt" &
other_pid=$!
sleep 0.5
TTT_CONFIG_DIR="$OUT/cfg" ttt --size 110x24 store.ts --exec "wait 2000; screenshot $OUT/1-markers.txt; key ctrl+k d; wait 900; screenshot $OUT/2-sent.txt; key ctrl+k n; wait 4500; screenshot $OUT/3-chosen.txt; debug $OUT/debug.json; quit" > /dev/null 2>&1 || true
wait $ws_pid $other_pid || true
echo "== ws session"; cat "$OUT/pi-ws.txt"
echo "== other session"; cat "$OUT/pi-other.txt"
for f in 1-markers 2-sent 3-chosen; do echo "$f: $(tail -1 "$OUT/$f.txt" | sed 's/  */ /g')"; done
echo "out: $OUT"
