#!/usr/bin/env bash
# Filling in a headless ttt (test/e2e/stubs.ts is the fake pi). First a stub:
# helpi! on its marker line (no side call); pi's edit outside the stub is
# blocked; the body goes in; a proposal shows in a drawer, Enter in its note
# accepts it, and the import goes in. Then a function from its description:
# helpi! at the end of a comment, the side call answers `function`, and pi
# writes the function directly under the comment; a helper beside it is
# blocked.
# Usage: test/e2e/stubs.sh [out-dir]
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
cp "$repo/test/fixtures/stubs/sample.ts" "$OUT/ws/"
echo "export const helper = (k: string, n: number) => k.length + n;" > "$OUT/ws/helper.ts"
printf 'const LIMIT = 10;\n\n// clamp n between 0 and LIMIT\n\nexport const other = 1;\n' > "$OUT/ws/clamp.ts"

# Line 8 is the stub's marker: // TODO(pi). pi gets the fill about 1 s after
# helpi!, makes its edits, then waits for the answer to its proposal.
steps="wait 2500; key down; key down; key down; key down; key down; key down; key down; key end; key space; type helpi!"
steps="$steps; wait 5000; screenshot $OUT/propose.txt; type looks fine; key enter; wait 3000; screenshot $OUT/end.txt"
# Then clamp.ts (the tab before): line 3 is the description.
steps="$steps; exec \"View: Previous Tab\"; wait 800; key down; key down; key end; key space; type helpi!; wait 5000; screenshot $OUT/clamp.txt; quit"
(cd "$OUT/ws" && ttt --size 140x30 clamp.ts sample.ts --exec "$steps" > /dev/null 2>&1) &
ttt=$!
sleep 1.2
"$repo/bin/run-node" "$repo/test/e2e/stubs.ts" "$OUT/ws" > "$OUT/pi.log" 2>&1 &
pi=$!
wait $ttt || true
wait $pi || true
cat "$OUT/pi.log"
fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
grep -q 'owner: this' "$OUT/pi.log" || fail "the editor did not follow the fake pi"
grep -q 'fill: Fill the stub `sumFile`' "$OUT/pi.log" || fail "helpi! on the stub did not reach pi"
grep -q 'helpi!: answering' "$OUT/pi.log" && ! grep -q 'helpi!: answering (function)' "$OUT/pi.log" && fail "helpi! on a stub asked the model"
grep -q 'outside: blocked' "$OUT/pi.log" || fail "the edit outside the stub was not blocked"
grep -q 'body: went in' "$OUT/pi.log" || fail "the body did not go in"
grep -q 'pi proposes' "$OUT/propose.txt" || fail "no proposal drawer"
grep -q 'Import sum from lodash.' "$OUT/propose.txt" || fail "the drawer does not show the proposal"
grep -q 'answer: Accepted: dependency `lodash`, once. Note from the developer: "looks fine".' "$OUT/pi.log" || fail "the proposal was not accepted with the note"
grep -q 'import: went in' "$OUT/pi.log" || fail "the accepted import did not go in"
grep -q "import { sum } from 'lodash';" "$OUT/ws/sample.ts" || fail "the import is not on disk"
grep -q 'return sum(data' "$OUT/ws/sample.ts" || fail "the body is not on disk"
grep -q 'const LIMIT = 10;' "$OUT/ws/sample.ts" || fail "the line outside the stub changed"
grep -q 'helpi!' "$OUT/ws/sample.ts" && fail "the helpi! marker stays in the file"
grep -q 'filling' "$OUT/end.txt" && fail "the fill did not end with the filled body"
grep -q 'helpi!: answering (function)' "$OUT/pi.log" || fail "the side call was not asked for the description"
grep -q 'write: Write a new function in clamp.ts, directly under the description at line 3' "$OUT/pi.log" || fail "the function fill did not reach pi"
grep -q 'helper: blocked' "$OUT/pi.log" || fail "a helper beside the function was not blocked"
grep -q 'clamp: went in' "$OUT/pi.log" || fail "the function did not go in"
python3 - "$OUT/ws/clamp.ts" <<'PY' || fail "clamp.ts is not the description with the function under it"
import sys
text = open(sys.argv[1]).read()
want = "const LIMIT = 10;\n\n// clamp n between 0 and LIMIT\nexport function clamp(n: number): number {\n\treturn Math.min(LIMIT, Math.max(0, n));\n}\n\nexport const other = 1;\n"
sys.exit(0 if text == want else 1)
PY
grep -q 'clamp(n' "$OUT/clamp.txt" || fail "the editor does not show the function"
echo "all passed ($OUT)"
