#!/usr/bin/env bash
# End to end for suggestions and the chat: a headless ttt opens a file with
# AI!/AI? markers, presses ctrl+k d (send), then ctrl+k h (chat), while a fake
# pi (suggest-drive.ts) waits for the message. Usage: test/e2e/suggest.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d)}
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws"
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.2.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
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

TTT_CONFIG_DIR="$OUT/cfg" "$repo/bin/run-node" "$repo/test/e2e/suggest-drive.ts" "$OUT/ws" 12000 > "$OUT/pi.txt" &
pi_pid=$!
sleep 0.5
TTT_CONFIG_DIR="$OUT/cfg" ttt --size 110x24 store.ts --exec "wait 1500; screenshot $OUT/1-markers.txt; key ctrl+k d; wait 900; screenshot $OUT/2-sent.txt; key ctrl+k h; wait 1200; type echo chat-here; key enter; wait 600; screenshot $OUT/3-chat.txt; debug $OUT/debug.json; quit" > /dev/null 2>&1 || true
wait $pi_pid || true
cat "$OUT/pi.txt"
echo "out: $OUT"
