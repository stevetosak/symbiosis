#!/usr/bin/env bash
# The demo's proving ground: each scenario of demo/scenarios/ runs its scripted
# pi against a headless ttt, and its own check (drive, expect, absent) is read
# from the screen at the end. A scenario with no check is covered by another
# script (flow: test/e2e/demo.sh). Usage: test/e2e/scenarios.sh [scenario ...]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=$(mktemp -d /tmp/symbiosis-e2e.XXXXXX)
# The real path: ttt's fs sees no symlinks (macOS: /tmp, /var -> /private/...).
OUT=$(cd "$OUT" && pwd -P)
"$repo/bin/run-node" "$repo/ttt/build.ts" > /dev/null
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
if [ $# -gt 0 ]; then names="$*"; else names=$("$repo/bin/run-node" "$repo/demo/run.ts" --list | awk 'NR>1 && /^  [a-z]/ && !/stubs demo/ {print $1}'); fi

failed=0
fail() { echo "FAIL $name: $*"; failed=1; }  # one failure stays failed for the rest of the run
for name in $names; do
	check=$("$repo/bin/run-node" "$repo/demo/run.ts" --show "$name")
	if [ "$check" = null ]; then echo "skip $name (no check here)"; continue; fi
	S="$OUT/$name"
	mkdir -p "$S/cfg/plugins/symbiosis" "$S/state"
	cp "$repo"/ttt/symbiosis/* "$S/cfg/plugins/symbiosis/"
	echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$S/cfg/plugins.ttt.json"
	export DEMO_DIR="$S/ws" XDG_STATE_HOME="$S/state" TTT_CONFIG_DIR="$S/cfg" PAUSE_MS=300 START_MS=500
	"$repo/bin/run-node" "$repo/demo/run.ts" --reset "$name" > "$S/reset.log" 2>&1
	open=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('open',''))" "$check")
	steps=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['drive'].replace('\$SHOT', sys.argv[2]))" "$check" "$S/shot.txt")
	(cd "$DEMO_DIR" && DEMO_SCENARIO="$name" exec "$repo/demo/scripted-pi" > "$S/pi.log" 2>&1) &
	pi=$!
	# ttt first: the scripted pi waits until ttt follows it.
	(cd "$DEMO_DIR" && ttt --size 120x34 ${open:+"$open"} --exec "$steps; quit" > "$S/ttt.log" 2>&1) || fail "ttt did not finish its script ($S/ttt.log)"
	kill -INT $pi 2> /dev/null || true
	wait $pi 2> /dev/null || true
	[ -s "$S/shot.txt" ] || { fail "no screenshot"; continue; }
	while IFS= read -r text; do
		grep -qF -- "$text" "$S/shot.txt" || fail "the screen has no \"$text\""
	done < <(python3 -c "import json,sys; print('\n'.join(json.loads(sys.argv[1])['expect']))" "$check")
	while IFS= read -r text; do
		[ -z "$text" ] || ! grep -qF -- "$text" "$S/shot.txt" || fail "the screen has \"$text\""
	done < <(python3 -c "import json,sys; print('\n'.join(json.loads(sys.argv[1]).get('absent', [])))" "$check")
	if [ "$failed" = 0 ]; then echo "ok $name"; fi
done
if [ "$failed" = 0 ]; then echo "all passed ($OUT)"; else echo "out: $OUT"; exit 1; fi
