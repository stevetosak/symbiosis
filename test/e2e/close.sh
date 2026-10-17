#!/usr/bin/env bash
# Detach and close, in a headless ttt with a idle fake pi (test/e2e/close.ts):
#   ctrl+k n goes pi → detached → pi again; the bar says "π detached".
#   ctrl+k z asks, then runs `symbiosis close --keep-editor` (a stub in
#   PATH logs it) and quits ttt only when the command worked: a first run where
#   it fails keeps ttt open and says why, a second run where it works quits.
# Usage: test/e2e/close.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-e2e.XXXXXX)}
# The real path: ttt's fs sees no symlinks (macOS: /tmp, /var -> /private/...).
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
export TTT_CONFIG_DIR="$OUT/cfg"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws" "$OUT/bin"
"$repo/bin/run-node" "$repo/ttt/build.ts" >/dev/null
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
echo '{"autosave":0}' > "$OUT/cfg/plugins/symbiosis/settings.json"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
echo 'export const x = 1;' > "$OUT/ws/a.ts"
# The stub `symbiosis`: logs its arguments; fails when $OUT/fail exists.
# Other commands (`symbiosis run`, which the Run panel calls) go to the real one.
cat > "$OUT/bin/symbiosis" <<SH
#!/bin/sh
[ "\$1" = close ] || exec "$repo/bin/symbiosis" "\$@"
echo "symbiosis \$*" >> "$OUT/calls.txt"
[ ! -f "$OUT/fail" ] || { echo "pi did not quit in 8 s" >&2; exit 1; }
SH
chmod +x "$OUT/bin/symbiosis"
: > "$OUT/calls.txt"
fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }

"$repo/bin/run-node" "$repo/test/e2e/close.ts" "$OUT/ws" 60000 > "$OUT/pi.log" 2>&1 &
pi=$!
sleep 0.4

echo "== detach"
steps="wait 2500; screenshot $OUT/follow.txt; key ctrl+k n; wait 300; screenshot $OUT/chosen.txt; key ctrl+k n; wait 300; screenshot $OUT/detached.txt"
steps="$steps; key ctrl+k n; wait 300; screenshot $OUT/again.txt; key ctrl+k n; key ctrl+k n; wait 300; screenshot $OUT/detached2.txt; key ctrl+k g; wait 300; screenshot $OUT/click.txt"
steps="$steps; quit"
(cd "$OUT/ws" && PATH="$OUT/bin:$PATH" SYMBIOSIS_SESSION=1-x ttt --size 140x24 a.ts --exec "$steps" > /dev/null 2>&1) || true
grep -q 'π ws' "$OUT/follow.txt" || fail "the bar shows no pi"
grep -q 'π detached' "$OUT/chosen.txt" && fail "one ctrl+k n detached at once"
grep -q 'π ws.*(chosen)' "$OUT/chosen.txt" || fail "ctrl+k n did not choose the session"
grep -q 'π detached' "$OUT/detached.txt" || fail "the next ctrl+k n did not detach"
grep -q 'π ws ○ idle  ' "$OUT/again.txt" || fail "the cycle did not go back to following by the open file"
grep -q 'π detached' "$OUT/detached2.txt" || fail "no second detach"
grep -q 'π ws' "$OUT/click.txt" || fail "ctrl+k g on detached did not follow pi again"
echo "ok detach"

echo "== close"
steps="wait 2500; type edited; key ctrl+k z; wait 600; screenshot $OUT/ask.txt; key tab; key enter; wait 1500; screenshot $OUT/failed.txt"
steps="$steps; screenshot $OUT/stays.txt; wait 500; quit"
touch "$OUT/fail"
(cd "$OUT/ws" && PATH="$OUT/bin:$PATH" SYMBIOSIS_SESSION=1-x ttt --size 140x24 a.ts --exec "$steps" > /dev/null 2>&1) || true
grep -q 'Close symbiosis' "$OUT/ask.txt" || fail "no question"
grep -q 'symbiosis close --keep-editor' "$OUT/calls.txt" || fail "the command did not run: $(cat "$OUT/calls.txt")"
grep -q 'could not close pi' "$OUT/failed.txt" || fail "no error when the command fails"
grep -q 'edited' "$OUT/stays.txt" || fail "ttt did not stay open after a failed close"

rm "$OUT/fail"; : > "$OUT/calls.txt"
steps="wait 2500; key ctrl+k z; wait 600; key tab; key enter; wait 4000; screenshot $OUT/gone.txt; wait 6000"
start=$(date +%s)
(cd "$OUT/ws" && PATH="$OUT/bin:$PATH" SYMBIOSIS_SESSION=1-x ttt --size 140x24 a.ts --exec "$steps" > /dev/null 2>&1) || true
took=$(( $(date +%s) - start ))
grep -q 'symbiosis close --keep-editor' "$OUT/calls.txt" || fail "the command did not run the second time"
[ "$took" -lt 9 ] && echo "ok ttt quit by itself after $took s" || fail "ttt did not quit after a good close ($took s)"

echo "== a good close with an unsaved file: ttt asks, as ctrl+q does"
steps="wait 2500; type edited; key ctrl+k z; wait 600; key tab; key enter; wait 1500; screenshot $OUT/unsaved.txt; key escape; wait 300; quit"
(cd "$OUT/ws" && PATH="$OUT/bin:$PATH" SYMBIOSIS_SESSION=1-x ttt --size 140x24 a.ts --exec "$steps" > /dev/null 2>&1) || true
grep -q 'Unsaved changes' "$OUT/unsaved.txt" || fail "ttt quit without asking about the unsaved file"
echo "ok unsaved"

echo "== quit.json: the symbiosis command in a terminal asks ttt to quit"
(sleep 3.5; echo '{"id":"7-1"}' > "$OUT/cfg/plugins/symbiosis/quit.json") &
start=$(date +%s)
(cd "$OUT/ws" && PATH="$OUT/bin:$PATH" SYMBIOSIS_SESSION=1-x ttt --size 140x24 a.ts --exec "wait 9000" > /dev/null 2>&1) || true
took=$(( $(date +%s) - start ))
[ "$took" -lt 8 ] && echo "ok quit.json ended ttt after $took s" || fail "ttt ignored quit.json ($took s)"
rm -f "$OUT/cfg/plugins/symbiosis/quit.json"

echo "== not started by symbiosis"
steps="wait 2500; key ctrl+k z; wait 600; screenshot $OUT/not.txt; quit"
(cd "$OUT/ws" && env -u SYMBIOSIS_SESSION PATH="$OUT/bin:$PATH" ttt --size 140x24 a.ts --exec "$steps" > /dev/null 2>&1) || true
grep -q 'not started by the' "$OUT/not.txt" || fail "no notice without SYMBIOSIS_SESSION"
echo "ok no session"
kill $pi 2> /dev/null || true
wait $pi 2> /dev/null || true
echo "all passed ($OUT)"
