#!/usr/bin/env bash
# helpi! end to end: two fake pi sessions (test/e2e/help.ts), one in the
# workspace, one in another folder. A headless ttt types helpi! comments in a
# workspace file: a code answer with an import (fires after the pause), a note
# (fires on Enter), an ask (goes to the agent), a slow note stopped with Esc.
# Only the workspace session may answer. Usage: test/e2e/help.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d)}
export TTT_CONFIG_DIR="$OUT/cfg"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws" "$OUT/other"
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
echo '{"autosave":0}' > "$OUT/cfg/plugins/symbiosis/settings.json"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
cat > "$OUT/ws/store.ts" <<'TS'
import { writeFileSync } from 'node:fs';

export function save(dir: string, text: string) {
	return dir;
}
TS

"$repo/bin/run-node" "$repo/test/e2e/help.ts" "$OUT/ws" ws 16000 > "$OUT/pi-ws.txt" 2>&1 &
ws=$!
"$repo/bin/run-node" "$repo/test/e2e/help.ts" "$OUT/other" other 16000 > "$OUT/pi-other.txt" 2>&1 &
other=$!
sleep 0.8
# The cursor goes to the end of line 4 ("	return dir;"), then a new line.
steps="wait 2000; key down; key down; key down; key end; key enter"
steps="$steps; type // make the folder helpi!; wait 2000; screenshot $OUT/1-code.txt"
steps="$steps; key end; key enter; type // why a string helpi!; key enter; wait 1200; screenshot $OUT/2-note.txt"
steps="$steps; type // what does the project use for errors helpi!; wait 1500; screenshot $OUT/3-ask.txt"
steps="$steps; key end; key enter; type // slow helpi!; wait 1300; key esc; wait 300; type Q; wait 300; screenshot $OUT/4-stop.txt"
steps="$steps; key ctrl+s; wait 300; quit"
(cd "$OUT/ws" && ttt --size 120x30 store.ts --exec "$steps" > /dev/null 2>&1) || true
wait $ws $other || true
echo "== ws"; cat "$OUT/pi-ws.txt"
echo "== other"; cat "$OUT/pi-other.txt"
echo "== store.ts"; cat -A "$OUT/ws/store.ts" | sed 's/\^I/→/g; s/\$$//'
fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
f="$OUT/ws/store.ts"
grep -q "^import { mkdirSync } from 'node:fs';$" "$f" || fail "the import did not go in"
grep -q "^	mkdirSync(dir, { recursive: true });$" "$f" || fail "the code did not take the comment's place"
grep -q "make the folder" "$f" && fail "the code comment is still there"
grep -q "^	// why a string$" "$f" || fail "the note question lost its text or kept helpi!"
grep -q "^	// pi: writeFileSync takes a string or a Buffer.$" "$f" || fail "no note under the question"
grep -q "^	// pi: asked ws; its answer comes in pi$" "$f" || fail "the ask line is missing"
grep -q "helpi!" "$f" && fail "a helpi! marker is still in the file"
grep -q "Q" "$f" || fail "typing after Esc did not reach the buffer"
grep -q "asked: 4" "$OUT/pi-ws.txt" || fail "the ws session did not get the 4 questions"
grep -q "agent got: 1" "$OUT/pi-ws.txt" || fail "the ask did not go to the ws agent"
grep -q "asked: 0" "$OUT/pi-other.txt" || fail "the other session got a question"
n=$(grep -c "This answer is long" "$f" || true)
slow=$(grep "This answer is long" "$f" | head -1 | wc -c)
[ "$slow" -lt 700 ] || fail "Esc did not stop the slow answer"
echo "ok (slow answer stopped at $slow bytes)"
echo "out: $OUT"
