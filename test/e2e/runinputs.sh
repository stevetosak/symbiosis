#!/usr/bin/env bash
# Run configurations with inputs, end to end against a headless ttt: a run
# whose ${input:device} has two options asks for one in a drawer, starts with
# the one picked, and F5 then runs it again without asking; the picker shows
# the pick, and `i` there asks again. An input with one option asks nothing.
# Usage: test/e2e/runinputs.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-runinputs.XXXXXX)}
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
rm -rf "$OUT/cfg" "$OUT/ws"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws/.symbiosis"
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
ws=$OUT/ws
cleanup() { "$repo/bin/symbiosis" run stop --folder "$ws" --all --runs "$OUT/cfg/plugins/symbiosis/runs" > /dev/null 2>&1 || true; }
trap cleanup EXIT
git -C "$ws" init -q
cat > "$ws/.symbiosis/run.json" <<'JSON'
{
	"inputs": [
		{ "id": "device", "type": "pick", "description": "device",
		  "command": "echo '[{\"value\": \"dev-1\", \"label\": \"First phone\", \"detail\": \"USB\"}, {\"value\": \"dev-2\", \"label\": \"Second phone\", \"ready\": true}, {\"value\": \"dev-3\", \"label\": \"Third phone\", \"ready\": true}]'" },
		{ "id": "only", "type": "pick", "options": ["the-only-one"] }
	],
	"configurations": [
		{ "name": "deploy", "command": "echo \"deploying to ${input:device}\"" },
		{ "name": "solo", "command": "echo \"solo on ${input:only}\"" }
	]
}
JSON
printf 'console.log("hi")\n' > "$ws/app.js"

export PATH="$repo/bin:$PATH"
s="screenshot $OUT"
# deploy: two ready options, none picked yet: the drawer asks. "second" + Enter picks it.
steps="wait 1500; key ctrl+k f5; wait 900; type deploy; wait 300; key enter; wait 1200; $s/ask.txt"
steps="$steps; type second; wait 300; key enter; wait 1500; $s/ran.txt"
# F5: deploy again, on the device picked, without asking.
steps="$steps; key f5; wait 1500; $s/again.txt"
# The picker shows the pick; i on deploy asks again, the one picked last marked.
steps="$steps; key ctrl+k f5; wait 900; type deploy; wait 300; $s/pick.txt; key tab; wait 200; key down; wait 200; key i; wait 1200; $s/reask.txt; key escape; wait 300"
# solo: one option, no drawer.
steps="$steps; key ctrl+k f5; wait 900; type solo; wait 300; key enter; wait 1500; $s/solo.txt; quit"
cd "$ws"
TTT_CONFIG_DIR="$OUT/cfg" ttt --size 110x32 app.js --exec "$steps" > /dev/null 2>&1 || true

fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
grep -q 'Pick the device' "$OUT/ask.txt" || fail "deploy did not ask for its device"
grep -q '● Second phone' "$OUT/ask.txt" || fail "the drawer does not mark the ready options"
grep -q 'First phone  USB' "$OUT/ask.txt" || fail "the drawer does not show an option's detail"
grep -q 'deploying to dev-2' "$OUT/ran.txt" || fail "deploy did not run on the device picked"
grep -q 'Pick the device' "$OUT/again.txt" && fail "F5 asked again for the device picked"
grep -q '› deploy' "$OUT/again.txt" || grep -q 'deploying to dev-2' "$OUT/again.txt" || fail "F5 did not run deploy again"
grep -q 'deploy → Second phone' "$OUT/pick.txt" || fail "the picker does not show the device picked"
grep -q 'Pick the device' "$OUT/reask.txt" || fail "i in the picker did not ask again"
grep -q '▶ Second phone' "$OUT/reask.txt" || fail "the drawer does not mark the one picked last"
grep -q 'solo on the-only-one' "$OUT/solo.txt" || fail "solo did not run with its only option"
grep -q '"device"' "$OUT/cfg/plugins/symbiosis/run-inputs.json" || fail "the pick was not remembered"
echo "all passed ($OUT)"
