#!/usr/bin/env bash
# Review per stub in a headless ttt (test/e2e/review.ts is the fake pi).
# helpi! on a stub: pi fills it; when the body lands, the review drawer opens
# by itself with the signature, the body and pi's reason; the gutter marks the
# function and the status bar counts it. Esc hides the drawer, ctrl+k x shows
# it again, and `a` acks it: the record of pi drops the body, the mark goes.
# Usage: test/e2e/review.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-e2e.XXXXXX)}
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
export TTT_CONFIG_DIR="$OUT/cfg"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws"
"$repo/bin/run-node" "$repo/ttt/build.ts" >/dev/null
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
cp "$repo/test/fixtures/stubs/sample.ts" "$OUT/ws/"
echo "export const helper = (k: string, n: number) => k.length + n;" > "$OUT/ws/helper.ts"

# Line 8 is the stub's marker. The body lands about 2 s after helpi!.
steps="wait 2500; key down; key down; key down; key down; key down; key down; key down; key end; key space; type helpi!"
steps="$steps; wait 9000; screenshot $OUT/landed.txt; key escape; wait 600; screenshot $OUT/hidden.txt"
steps="$steps; key ctrl+k; key x; wait 800; screenshot $OUT/shown.txt; key a; wait 2500; screenshot $OUT/acked.txt; quit"
(cd "$OUT/ws" && ttt --size 140x30 sample.ts --exec "$steps" > /dev/null 2>&1) &
ttt=$!
sleep 1.2
"$repo/bin/run-node" "$repo/test/e2e/review.ts" "$OUT/ws" > "$OUT/pi.log" 2>&1 &
pi=$!
wait $ttt || true
wait $pi || true
cat "$OUT/pi.log"
fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
grep -q 'owner: this' "$OUT/pi.log" || fail "the editor did not follow the fake pi"
grep -q 'fill: Fill the stub `sumFile`' "$OUT/pi.log" || fail "helpi! on the stub did not reach pi"
grep -q 'body: went in' "$OUT/pi.log" || fail "the body did not go in"
grep -q 'landed: sumFile (Reads the whole file at once: the files are small.)' "$OUT/pi.log" || fail "the body is not in the record with its why"
grep -q 'pi filled sumFile' "$OUT/landed.txt" || fail "the drawer did not open by itself"
grep -q 'Sum the numbers in a file' "$OUT/landed.txt" || fail "the drawer does not show the intent"
grep -q 'Why: Reads the whole file at once' "$OUT/landed.txt" || fail "the drawer does not show the why"
grep -q '^│● 7 ' "$OUT/landed.txt" || fail "no gutter mark on the function"
grep -q 'to review' "$OUT/landed.txt" || fail "no status item"
grep -q 'pi filled sumFile' "$OUT/hidden.txt" && fail "Esc did not hide the drawer"
grep -q 'pi filled sumFile' "$OUT/shown.txt" || fail "ctrl+k x did not show the drawer again"
grep -q 'acked: yes' "$OUT/pi.log" || fail "the ack did not reach pi"
grep -q '^│● 7 ' "$OUT/acked.txt" && fail "the gutter mark stays after the ack"
grep -q 'to review' "$OUT/acked.txt" && fail "the status item stays after the ack"
echo "all passed ($OUT)"
