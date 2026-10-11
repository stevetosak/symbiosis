#!/usr/bin/env bash
# The symbiosis command end to end, with a fake pi in RPC mode
# (test/e2e/fake-rpc-pi.ts) and a headless ttt. No model, no tokens.
#
#  - the launcher starts pi in the folder with --mode rpc and the config's piArgs;
#  - ctrl+k q sends a prompt; pi's three dialogs open in ttt's command line
#    and are answered there (y, the number 2, a typed line);
#  - a second `symbiosis` for the same folder says it already runs;
#  - when ttt quits, pi's stdin is closed and the record and bridge are gone.
# Usage: test/e2e/app.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d)}
export TTT_CONFIG_DIR="$OUT/cfg" XDG_STATE_HOME="$OUT/state" XDG_CONFIG_HOME="$OUT/xdg" FAKE_LOG="$OUT/pi.log"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws" "$OUT/xdg/symbiosis"
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
echo '{"autosave":0}' > "$OUT/cfg/plugins/symbiosis/settings.json"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
echo '{"piArgs": ["--model", "fake"]}' > "$OUT/xdg/symbiosis/config.json"
echo 'export const x = 1;' > "$OUT/ws/a.ts"
rm -f "$FAKE_LOG"

cat > "$OUT/fake-pi" <<SH
#!/bin/sh
exec "$repo/bin/run-node" "$repo/test/e2e/fake-rpc-pi.ts" "\$@"
SH
steps="wait 2000; key ctrl+k q; type ask; key enter; wait 1200; screenshot $OUT/1-confirm.txt"
steps="$steps; type y; wait 800; screenshot $OUT/2-select.txt"
steps="$steps; type 2; wait 800; screenshot $OUT/3-input.txt"
steps="$steps; type hello there; key enter; wait 800; screenshot $OUT/4-notice.txt"
steps="$steps; key ctrl+k q; type more; key enter; wait 800; quit"
cat > "$OUT/ttt" <<SH
#!/bin/sh
exec ttt --size 140x24 "\$@" a.ts --exec "$steps"
SH
chmod +x "$OUT/fake-pi" "$OUT/ttt"
export SYMBIOSIS_PI="$OUT/fake-pi" SYMBIOSIS_TTT="$OUT/ttt"

(sleep 2.5; "$repo/bin/symbiosis" "$OUT/ws" > "$OUT/second.txt" 2>&1 && c=0 || c=$?; echo "exit $c" >> "$OUT/second.txt") &
second=$!
code=0
(cd "$OUT/ws" && timeout 60 "$repo/bin/symbiosis" < /dev/null > "$OUT/launcher.txt" 2>&1) || code=$?
wait $second

fails=0
check() { if grep -q -- "$2" "$1"; then echo "ok   $3"; else echo "FAIL $3"; fails=$((fails + 1)); fi; }
echo "launcher exit: $code"; [ "$code" = 0 ] || { echo "FAIL launcher exit"; cat "$OUT/launcher.txt"; fails=$((fails + 1)); }
check "$FAKE_LOG" "argv: --mode rpc --model fake" "pi in RPC mode with the config's piArgs"
check "$FAKE_LOG" "cwd: $OUT/ws" "pi runs in the folder"
check "$OUT/1-confirm.txt" "pi: Allow this one call? rm -rf build  y/n:" "the confirm dialog in the command line"
check "$FAKE_LOG" 'answer c1: {"confirmed":true}' "y answers yes"
check "$OUT/2-select.txt" "1 Allow · 2 Block" "the select dialog lists its options"
check "$FAKE_LOG" 'answer s1: {"value":"Block"}' "2 picks Block"
check "$OUT/3-input.txt" "pi: Your name:" "the input dialog"
check "$FAKE_LOG" 'answer i1: {"value":"hello there"}' "the typed line is the value"
check "$OUT/4-notice.txt" "pi: all answered" "pi's notice shows"
check "$FAKE_LOG" "prompt: more" "a second prompt"
check "$FAKE_LOG" "stdin closed" "pi's stdin closed when ttt quit"
check "$OUT/second.txt" "already runs for $OUT/ws" "a second symbiosis for the folder says it runs"
check "$OUT/second.txt" "exit 1" "and stops"
if ls "$OUT/state/symbiosis/"*.json > /dev/null 2>&1; then echo "FAIL the record is left"; fails=$((fails + 1)); else echo "ok   the record is gone"; fi
if [ -n "$(ls -A "$OUT/cfg/plugins/symbiosis/backends" 2> /dev/null)" ]; then echo "FAIL the bridge is left"; fails=$((fails + 1)); else echo "ok   the bridge is gone"; fi
[ "$fails" = 0 ] || { echo "== pi.log"; cat "$FAKE_LOG"; echo "== launcher"; cat "$OUT/launcher.txt"; exit 1; }
echo "all passed ($OUT)"
