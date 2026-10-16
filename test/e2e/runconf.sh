#!/usr/bin/env bash
# Run configurations end to end, against a headless ttt: ctrl+k F5 lists
# what the workspace has (run.json, package.json, Makefile), F5 runs the
# chosen one into the Run panel, shift+F5 stops it, and ctrl+q asks what to
# do with a run that still goes. Usage: test/e2e/runconf.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-runconf.XXXXXX)}
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
rm -rf "$OUT/cfg" "$OUT/ws"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws/.symbiosis" "$OUT/ws/web"
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
ws=$OUT/ws
# Whatever happens, the ticker does not run on.
cleanup() { "$repo/bin/symbiosis" run stop --folder "$ws" --all --runs "$OUT/cfg/plugins/symbiosis/runs" > /dev/null 2>&1 || true; }
trap cleanup EXIT
git -C "$ws" init -q
cat > "$ws/.symbiosis/run.json" <<'JSON'
{
	// a server that runs until stopped
	"configurations": [
		{ "name": "ticker", "command": "i=0; while true; do i=$((i+1)); echo \"tick $i in $PWD\"; sleep 0.2; done", "cwd": "${workspaceFolder}/web" },
		{ "name": "fails", "command": "node", "args": ["-e", "console.error('boom at app.js:2'); process.exit(3)"] }
	]
}
JSON
printf '{ "scripts": { "dev": "node app.js", "test": "node --test" } }\n' > "$ws/web/package.json"
printf 'console.log("hi")\nconsole.log("there")\n' > "$ws/app.js"
printf 'build:\n\techo built\n' > "$ws/Makefile"

# The plugin runs `symbiosis`: this checkout's.
export PATH="$repo/bin:$PATH"
s="screenshot $OUT"
steps="wait 1500; key ctrl+k f5; wait 1200; $s/pick.txt; key escape; wait 100; key escape; wait 300"
# F5 with nothing chosen: the picker; "ticker" + Enter runs it and chooses it.
steps="$steps; key f5; wait 1200; type ticker; wait 300; key enter; wait 1500; $s/ran.txt"
steps="$steps; key shift+f5; wait 1500; $s/stopped.txt"
steps="$steps; key ctrl+k f5; wait 900; type fails; wait 300; key enter; wait 1500; $s/failed.txt"
# ctrl+k shift+F5 focuses the Run panel: Down goes to the older run, Esc back to the editor.
steps="$steps; key ctrl+k shift+f5; wait 300; key down; wait 400; $s/focused.txt; key escape; wait 300"
# The picker's list: the arrows only move (Enter or a click runs). The │ between the Run panel's panes drags.
steps="$steps; key ctrl+k f5; wait 900; key tab; wait 200; key down; wait 200; key down; wait 300; $s/moved.txt; key escape; wait 100; key escape; wait 300"
steps="$steps; drag 29 20 50 20; wait 400; $s/dragged.txt"
# F5 again: the chosen one, now "fails"; then ticker, and ctrl+q while it runs.
steps="$steps; key ctrl+k f5; wait 900; type ticker; wait 300; key enter; wait 1200; key ctrl+q; wait 400; $s/quit.txt; type k; wait 1500; debug $OUT/debug.json; quit"
cd "$ws"
TTT_CONFIG_DIR="$OUT/cfg" ttt --size 110x32 app.js --exec "$steps" > /dev/null 2>&1 || true
# Back: the kept run is there, in the Run panel.
TTT_CONFIG_DIR="$OUT/cfg" ttt --size 110x32 app.js --exec "wait 2500; $s/back.txt; quit" > /dev/null 2>&1 || true
export SYMBIOSIS_RUNS="$OUT/cfg/plugins/symbiosis/runs"
"$repo/bin/symbiosis" run ps --folder "$ws" > "$OUT/ps.json"
"$repo/bin/symbiosis" run stop --folder "$ws" --all > /dev/null

fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
grep -q '▼ Saved' "$OUT/pick.txt" || fail "the picker has no Saved group"
grep -q 'web: dev  npm run dev' "$OUT/pick.txt" || fail "the picker misses web/package.json's dev"
grep -q 'build  make build' "$OUT/pick.txt" || fail "the picker misses the Makefile"
grep -q 'Current file  node' "$OUT/pick.txt" || fail "the picker misses the file open"
grep -q 'tick 3 in .*/ws/web' "$OUT/ran.txt" || fail "F5 + ticker: no output, or not in its cwd"
grep -q '● ticker' "$OUT/ran.txt" || fail "the status bar does not say ticker runs"
grep -q 'ticker · stopped' "$OUT/stopped.txt" || fail "shift+F5 did not stop ticker"
grep -q 'fails · exited 3' "$OUT/failed.txt" || fail "fails: no exit code 3"
grep -q 'boom at app.js:2' "$OUT/failed.txt" || fail "fails: no stderr"
grep -q '✗ fails 3' "$OUT/failed.txt" || fail "the status bar does not say fails failed"
grep -q '›■ ticker' "$OUT/focused.txt" || fail "Down in the focused Run panel did not choose ticker"
grep -q 'ticker · stopped' "$OUT/focused.txt" || fail "the Run panel does not show ticker's output"
grep -q '▼ Saved' "$OUT/moved.txt" || fail "the arrows in the picker's list ran a configuration"
grep -q '"left":49' "$OUT/cfg/plugins/symbiosis/run-layout.json" || fail "dragging the │ did not resize the runs list"
grep -q '"ticker" runs: s stops them and quits' "$OUT/quit.txt" || fail "ctrl+q did not ask"
grep -q '1 program from the last time still runs' "$OUT/back.txt" || fail "no notice of the kept run"
grep -q '● ticker' "$OUT/back.txt" || fail "the Run panel does not show the kept run"
grep -q '"status":"running"' "$OUT/ps.json" || fail "k did not keep ticker running"
echo "all passed ($OUT)"
