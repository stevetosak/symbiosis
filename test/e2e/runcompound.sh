#!/usr/bin/env bash
# A compound launch end to end, against a headless ttt: ctrl+k F5 starts
# "Pair"; the Run panel shows it as one row with its steps under it (a step
# that waits is muted), its output is the event log, the status bar counts
# its started steps; s on its row stops every step.
# Usage: test/e2e/runcompound.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-runcompound.XXXXXX)}
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
rm -rf "$OUT/cfg" "$OUT/ws"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws/.symbiosis"
"$repo/bin/run-node" "$repo/ttt/build.ts" >/dev/null
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
ws=$OUT/ws
cleanup() { "$repo/bin/symbiosis" run stop --folder "$ws" --all --runs "$OUT/cfg/plugins/symbiosis/runs" > /dev/null 2>&1 || true; }
trap cleanup EXIT
git -C "$ws" init -q
cat > "$ws/.symbiosis/run.json" <<'JSON'
{
	"configurations": [
		{ "name": "x", "command": "while true; do echo x up; sleep 0.3; done" },
		{ "name": "y", "command": "while true; do echo y up; sleep 0.3; done" },
		{ "name": "z", "command": "echo z" }
	],
	"compounds": [
		{ "name": "Pair", "steps": [{ "run": "x" }, { "run": "y", "after": "started" }, { "run": "z", "after": "finished" }] }
	]
}
JSON
printf 'console.log("hi")\n' > "$ws/app.js"

export PATH="$repo/bin:$PATH"
s="screenshot $OUT"
steps="wait 1500; key ctrl+k f5; wait 1200; type Pair; wait 300; key enter; wait 2500; $s/ran.txt"
steps="$steps; key ctrl+k shift+f5; wait 300; key s; wait 2500; $s/stopped.txt; quit"
cd "$ws"
TTT_CONFIG_DIR="$OUT/cfg" ttt --size 110x32 app.js --exec "$steps" > /dev/null 2>&1 || true

fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
grep -q '│›● Pair' "$OUT/ran.txt" || fail "the Run panel has no Pair row, chosen"
grep -q '│   ● x' "$OUT/ran.txt" || fail "x does not run under Pair"
grep -q '│   ● y' "$OUT/ran.txt" || fail "y does not run under Pair"
grep -q '│   ○ z' "$OUT/ran.txt" || fail "z, which waits, is not a muted row under Pair"
grep -q 'x starts' "$OUT/ran.txt" || fail "Pair's output is not its event log"
grep -q 'z waits for x, y to finish' "$OUT/ran.txt" || fail "the event log does not say z waits"
grep -q '● Pair 2/3' "$OUT/ran.txt" || fail "the status bar does not count Pair's started steps"
grep -q '│›■ Pair' "$OUT/stopped.txt" || fail "s on Pair's row did not stop it"
grep -q '│   ■ x' "$OUT/stopped.txt" || fail "s on Pair's row did not stop x"
grep -q '│   ■ y' "$OUT/stopped.txt" || fail "s on Pair's row did not stop y"
grep -q '│   ○ z' "$OUT/stopped.txt" || fail "z started after the stop"
echo "all passed ($OUT)"
