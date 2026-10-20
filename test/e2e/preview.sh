#!/usr/bin/env bash
# The typed preview behind pi (test/e2e/preview.ts) against a headless ttt:
# follow on, slow typing, pi does not wait. Typing in the file while it is
# typed must wait. Follow off in the middle: the preview stops; on again: the
# editor jumps to now. At the end the buffer must be the file on disk.
# Usage: test/e2e/preview.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-e2e.XXXXXX)}
# The real path: ttt's fs sees no symlinks (macOS: /tmp, /var -> /private/...).
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
export TTT_CONFIG_DIR="$OUT/cfg"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws"
"$repo/bin/run-node" "$repo/ttt/build.ts" >/dev/null
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
echo "{\"speed\":${SPEED:-40}}" > "$OUT/cfg/plugins/symbiosis/settings.json"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
printf '// a\nexport const one = 1;\n' > "$OUT/ws/a.ts"

steps="wait 1500; key ctrl+k a; wait 200"
for i in $(seq -w 1 40); do
	steps="$steps; screenshot $OUT/shot-$i.txt; wait 250"
	# A key while a.ts is typed: it must not reach the buffer.
	if [ "$i" = "06" ]; then steps="$steps; type Z"; fi
	# Follow off, then on again.
	if [ "$i" = "${OFF_AT:-10}" ] || [ "$i" = "${ON_AT:-16}" ]; then steps="$steps; key ctrl+k a; wait 200"; fi
done
steps="$steps; debug $OUT/debug.json; quit"
(cd "$OUT/ws" && ttt --size 90x24 a.ts --exec "$steps" > /dev/null 2>&1) &
ttt=$!
sleep 1.2
HOLD_MS=12000 "$repo/bin/run-node" "$repo/test/e2e/preview.ts" "$OUT/ws" > "$OUT/pi.log" 2>&1 &
pi=$!
wait $ttt || true
kill $pi 2> /dev/null || true
cat "$OUT/pi.log"
fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
grep -q 'FAIL' "$OUT/pi.log" && fail "pi waited for the editor"
grep -q 'behind' "$OUT"/shot-*.txt || fail "the bar never showed the preview behind pi"
grep -q 'typing waits' "$OUT"/shot-*.txt || fail "the key during the preview was not held"
grep -q 'not following' "$OUT"/shot-*.txt || fail "follow did not turn off"
grep -q "no preview" "$OUT"/shot-*.txt && fail "a buffer was taken for one with unsaved changes"
grep -q 'Z' "$OUT"/ws/*.ts "$OUT"/shot-*.txt && fail "the held key reached the buffer"
python3 - "$OUT" << 'PY'
import json, sys
out = sys.argv[1]
b = json.load(open(f"{out}/debug.json"))["buffer"]
disk = open(f"{out}/ws/a.ts").read()
assert "four = 4" in disk and "// a: numbers" in disk, "FAIL: pi's changes are not all on disk"
assert b["path"].endswith("/a.ts") and not b["modified"], f"FAIL: the buffer is {b['path']}, modified {b['modified']}"
assert "\n".join(b["text"]) == disk, "FAIL: the buffer is not the file on disk"
print("the buffer is a.ts as on disk, not modified")
PY
tail -3 "$OUT/shot-40.txt"
echo "out: $OUT"
