#!/usr/bin/env bash
# The symbiosis command end to end, with fake herdr, tmux, pi and ttt on PATH:
# they write down how they were called. No model, no tokens, no real tabs.
#
#  - herdr, default (tabs): pi in a new tab "pi · ws", ttt here;
#  - herdr --split: this pane splits, pi on the right;
#  - herdr --tab: a new tab runs symbiosis again with --here, nothing here;
#  - tmux, default: a new window that does not take the focus;
#  - neither: ttt only, and how to start pi;
#  - a second symbiosis for the same folder goes to the first one's tab, or
#    says where it runs when it cannot;
#  - ttt's own tab is named like pi's ("ttt · ws") and gets its old name back;
#  - `symbiosis close`: pi quits, its pane closes, then ttt is asked to quit;
#  - when ttt quits, the record is gone.
# Usage: test/e2e/app.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-e2e.XXXXXX)}
# The real path: ttt's fs sees no symlinks (macOS: /tmp, /var -> /private/...).
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
# macOS has no timeout(1): the same with perl.
command -v timeout > /dev/null || timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }
export TTT_CONFIG_DIR="$OUT/cfg" XDG_STATE_HOME="$OUT/state" XDG_CONFIG_HOME="$OUT/xdg" CALLS="$OUT/calls.log"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws" "$OUT/xdg/symbiosis" "$OUT/bin"
echo '{"piArgs": ["--model", "fake"]}' > "$OUT/xdg/symbiosis/config.json"

cat > "$OUT/bin/herdr" <<'SH'
#!/bin/sh
echo "herdr $*" >> "$CALLS"
case "$1 $2" in
	"tab create") echo '{"result":{"root_pane":{"pane_id":"w9:pT"},"tab":{"tab_id":"w9:tT"}}}' ;;
	"pane split") echo '{"result":{"pane":{"pane_id":"w9:pS"}}}' ;;
	"tab get") echo '{"result":{"tab":{"label":"2","tab_id":"'"$3"'"}}}' ;;
	"pane get")
		if [ "$3" = "${HERDR_GONE:-}" ]; then echo '{"error":{"message":"pane not found"}}'; exit 1; fi
		echo "{\"result\":{\"pane\":{\"pane_id\":\"$3\",\"tab_id\":\"w9:t1\",\"workspace_id\":\"w9\"}}}" ;;
	*) echo '{"result":{}}' ;;
esac
SH
cat > "$OUT/bin/tmux" <<'SH'
#!/bin/sh
echo "tmux $*" >> "$CALLS"
case "$1" in
	new-window|split-window) echo '%7' ;;
	display-message) printf '@5\tzsh\t1\n' ;;
esac
SH
cat > "$OUT/bin/ttt" <<'SH'
#!/bin/sh
echo "ttt $* (in $(pwd))" >> "$CALLS"
# Quits after TTT_HOLD seconds, or when the plugin is asked to (quit.json).
ticks=$(awk "BEGIN{print int(${TTT_HOLD:-0.3}*10)}")
while [ "$ticks" -gt 0 ] && [ ! -f "$TTT_CONFIG_DIR/plugins/symbiosis/quit.json" ]; do sleep 0.1; ticks=$((ticks - 1)); done
SH
chmod +x "$OUT/bin/"*
export PATH="$OUT/bin:$PATH"
unset HERDR_PANE_ID HERDR_BIN_PATH TMUX TMUX_PANE SYMBIOSIS_PI SYMBIOSIS_TTT

fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
has() { if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3"; fi; }
hasnt() { if grep -qF -- "$2" "$1"; then bad "$3"; else ok "$3"; fi; }
run() { : > "$CALLS"; (cd "$OUT/ws" && timeout 30 "$repo/bin/symbiosis" "$@" < /dev/null > "$OUT/out.txt" 2>&1) && code=0 || code=$?; }

echo "== herdr, the default: pi in a tab of its own"
HERDR_PANE_ID=w9:p1 run
[ "$code" = 0 ] || bad "exit $code: $(cat "$OUT/out.txt")"
has "$CALLS" "herdr tab create --workspace w9 --cwd $OUT/ws --label pi · ws" "a tab for pi, not focused"
hasnt "$CALLS" "--focus" "the focus stays on ttt"
has "$CALLS" "herdr pane run w9:pT pi --model fake" "pi with the config's piArgs in that tab"
has "$CALLS" "ttt $OUT/ws (in $OUT/ws)" "ttt here, in the folder"
has "$CALLS" "herdr tab rename w9:t1 ttt · ws" "ttt's tab is named like pi's"
has "$CALLS" "herdr tab rename w9:t1 2" "and gets its old name back when ttt quits"

echo "== herdr --split -c -- --thinking high"
HERDR_PANE_ID=w9:p1 run --split -c -- --thinking high
has "$CALLS" "herdr pane split w9:p1 --direction right --cwd $OUT/ws --no-focus" "this pane splits"
has "$CALLS" "herdr pane run w9:pS pi --continue --model fake --thinking high" "pi on the right, -c and the args after --"
has "$CALLS" "herdr tab rename w9:t1 symbiosis · ws" "split: the tab that holds both is named symbiosis"

echo "== herdr --tab"
HERDR_PANE_ID=w9:p1 run --tab
has "$CALLS" "herdr tab create --workspace w9 --cwd $OUT/ws --label ws --focus" "a new focused tab named after the folder"
has "$CALLS" "main.ts $OUT/ws --here --tabs" "symbiosis runs again there, with --here"
hasnt "$CALLS" "ttt " "no ttt in this pane"

echo "== tmux, the default"
TMUX=/tmp/t,1,0 TMUX_PANE=%1 run
has "$CALLS" "tmux new-window -d -P -F #{pane_id} -c $OUT/ws -n pi · ws" "a tmux window for pi, not focused"
has "$CALLS" "tmux send-keys -t %7 -l pi --model fake" "pi typed into it"
has "$CALLS" "tmux send-keys -t %7 Enter" "and started"
has "$CALLS" "tmux rename-window -t @5 ttt · ws" "ttt's window is named like pi's"
has "$CALLS" "tmux set-window-option -t @5 automatic-rename on" "and renames itself again when ttt quits"

echo "== neither herdr nor tmux"
run
has "$OUT/out.txt" "not in herdr or tmux, so this opens ttt only" "it says why"
has "$OUT/out.txt" "cd $OUT/ws && pi --model fake" "and how to start pi"
has "$CALLS" "ttt $OUT/ws" "ttt still opens"

echo "== a second symbiosis for the folder: it goes to the first"
: > "$CALLS"
(cd "$OUT/ws" && TTT_HOLD=3 HERDR_PANE_ID=w9:p1 "$repo/bin/symbiosis" < /dev/null > /dev/null 2>&1) &
first=$!
sleep 1.5
(cd "$OUT/ws" && HERDR_PANE_ID=w9:p2 "$repo/bin/symbiosis" --tab < /dev/null > "$OUT/second.txt" 2>&1) && c=0 || c=$?
has "$OUT/second.txt" "went to its herdr pane w9:p1" "it says it went there"
[ "$c" = 0 ] && ok "and ends well" || bad "the second exit is $c"
has "$CALLS" "herdr workspace focus w9" "its workspace in front"
has "$CALLS" "herdr tab focus w9:t1" "its tab in front"
[ "$(grep -c "herdr tab create" "$CALLS")" = 1 ] && ok "no second tab" || bad "a second tab was made"
(cd "$OUT/ws" && HERDR_GONE=w9:p1 HERDR_PANE_ID=w9:p2 "$repo/bin/symbiosis" < /dev/null > "$OUT/third.txt" 2>&1) && c=0 || c=$?
has "$OUT/third.txt" "already runs for $OUT/ws in herdr pane w9:p1" "its pane is gone: it says where it runs"
[ "$c" = 1 ] && ok "and stops" || bad "the third exit is $c"
wait $first
if ls "$OUT/state/symbiosis/"*.json > /dev/null 2>&1; then bad "the record is left"; else ok "the record is gone"; fi

echo "== symbiosis close: pi quits, its pane closes, ttt is asked to quit"
cat > "$OUT/bin/fakepi" <<'SH'
#!/bin/sh
# A pi session: registers in the plugin folder and quits when asked (close.json).
d="$TTT_CONFIG_DIR/plugins/symbiosis"
mkdir -p "$d/sessions"
printf '{"id":"s1","pane":"w9:pT","host":"herdr","pid":%s,"name":"ws","t":0}' "$$" > "$d/sessions/s1.json"
until grep -q '"to":"s1"' "$d/close.json" 2> /dev/null; do sleep 0.1; done
rm -f "$d/sessions/s1.json"
SH
chmod +x "$OUT/bin/fakepi"
rm -f "$OUT/cfg/plugins/symbiosis/close.json" "$OUT/cfg/plugins/symbiosis/quit.json"
: > "$CALLS"
(cd "$OUT/ws" && TTT_HOLD=30 HERDR_PANE_ID=w9:p1 "$repo/bin/symbiosis" < /dev/null > /dev/null 2>&1) &
first=$!
sleep 1.5
( "$OUT/bin/fakepi" & )
sleep 0.5
(cd "$OUT/ws" && timeout 20 "$repo/bin/symbiosis" close --keep-editor < /dev/null > "$OUT/close.txt" 2>&1) && c=0 || c=$?
[ "$c" = 0 ] && ok "close --keep-editor ends well" || bad "close --keep-editor exits $c: $(cat "$OUT/close.txt")"
has "$OUT/cfg/plugins/symbiosis/close.json" '"to":"s1"' "pi is asked to quit"
has "$CALLS" "herdr pane close w9:pT" "its pane is closed once it has quit"
[ -f "$OUT/cfg/plugins/symbiosis/quit.json" ] && bad "ttt was asked to quit" || ok "ttt is not asked (the plugin quits it itself)"
kill -0 $first 2> /dev/null && ok "and symbiosis still runs" || bad "symbiosis ended"
: > "$CALLS"
(cd "$OUT/ws" && timeout 20 "$repo/bin/symbiosis" close < /dev/null > "$OUT/close.txt" 2>&1) && c=0 || c=$?
[ "$c" = 0 ] && ok "close ends well" || bad "close exits $c: $(cat "$OUT/close.txt")"
has "$OUT/close.txt" "pi does not run in herdr pane w9:pT" "pi was gone already: it says so and leaves the pane"
hasnt "$CALLS" "pane close" "no second pane close"
has "$OUT/cfg/plugins/symbiosis/quit.json" '"id"' "ttt is asked to quit"
wait $first && ok "ttt quit, the launcher ended" || bad "the launcher ended with an error"
(cd "$OUT/ws" && "$repo/bin/symbiosis" close < /dev/null > "$OUT/close.txt" 2>&1) && c=0 || c=$?
[ "$c" = 1 ] && ok "close with nothing open fails" || bad "close with nothing open exits $c"
has "$OUT/close.txt" "symbiosis does not run for $OUT/ws" "and says so"
rm -f "$OUT/cfg/plugins/symbiosis/close.json" "$OUT/cfg/plugins/symbiosis/quit.json" # the fake ttt quits at once when one is left

echo "== the herdr action runs symbiosis <folder> --tab"
mkdir -p "$OUT/sbin"
printf '#!/bin/sh\necho "symbiosis $*" >> "$CALLS"\n[ -z "${SYM_FAIL:-}" ] || { echo "$SYM_FAIL" >&2; exit 1; }\n' > "$OUT/sbin/symbiosis"
chmod +x "$OUT/sbin/symbiosis"
action() { : > "$CALLS"; HERDR_BIN_PATH="$OUT/bin/herdr" SYMBIOSIS_BIN_DIR="$OUT/sbin" HERDR_PLUGIN_CONTEXT_JSON='{"workspace_cwd":"/w","focused_pane_cwd":"/f"}' sh "$repo/herdr-plugin/scripts/open.sh" && c=0 || c=$?; }
action
has "$CALLS" "symbiosis /f --tab" "the focused pane's folder, in a new tab"
hasnt "$CALLS" "notification" "no notification when it works"
SYM_FAIL="symbiosis: boom" action
has "$CALLS" "herdr notification show symbiosis --body symbiosis: boom" "a failure shows as a herdr notification"
[ "$c" = 1 ] && ok "and the action fails" || bad "the action exit is $c"
rm "$OUT/sbin/symbiosis"
PATH_BEFORE=$PATH; PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v "/.local/bin" | paste -sd: -)
action
PATH=$PATH_BEFORE
has "$CALLS" "The symbiosis command is not installed" "no command: it says so"

echo "== npm run demo: the scripted pi beside ttt"
demo() { : > "$CALLS"; (cd "$OUT/ws" && DEMO_DIR="$OUT/demo" timeout 30 "$repo/bin/run-node" "$repo/demo/run.ts" "$@" < /dev/null > "$OUT/out.txt" 2>&1) && code=0 || code=$?; }
HERDR_PANE_ID=w9:p1 demo
[ "$code" = 0 ] || bad "demo exit $code: $(cat "$OUT/out.txt")"
[ -f "$OUT/demo/store.ts" ] && [ -f "$OUT/demo/.symbiosis-demo" ] && ok "a fresh copy" || bad "no demo copy"
has "$CALLS" "herdr tab create --workspace w9 --cwd $OUT/demo --label pi · demo" "a tab for the scripted pi"
has "$CALLS" "herdr pane run w9:pT $repo/demo/scripted-pi --model fake" "the scripted pi runs there"
has "$CALLS" "ttt $OUT/demo (in $OUT/demo)" "ttt opens the copy"

echo "== npm run demo -- --real --split"
HERDR_PANE_ID=w9:p1 demo --real --split
has "$CALLS" "herdr pane split w9:p1" "--split goes to the symbiosis command"
has "$CALLS" "herdr pane run w9:pS pi --model fake --name demo @$repo/demo/PROMPT.md" "a real pi, given PROMPT.md"

echo "== npm run demo -- --tab"
HERDR_PANE_ID=w9:p1 demo --tab
has "$CALLS" "env SYMBIOSIS_PI=$repo/demo/scripted-pi" "the new tab keeps the scripted pi"

echo "== npm run demo while it runs"
: > "$CALLS"
(cd "$OUT/ws" && DEMO_DIR="$OUT/demo" TTT_HOLD=4 HERDR_PANE_ID=w9:p1 "$repo/bin/run-node" "$repo/demo/run.ts" < /dev/null > /dev/null 2>&1) &
first=$!
sleep 2.5
echo mine > "$OUT/demo/mine.txt"
(cd "$OUT/ws" && DEMO_DIR="$OUT/demo" HERDR_PANE_ID=w9:p2 "$repo/bin/run-node" "$repo/demo/run.ts" < /dev/null > "$OUT/second.txt" 2>&1) && c=0 || c=$?
wait $first
has "$OUT/second.txt" "the demo already runs in herdr pane w9:p1: quit its ttt first" "it says so"
[ "$c" = 1 ] && ok "and stops" || bad "the second demo exits $c"
[ -f "$OUT/demo/mine.txt" ] && ok "the running demo's copy is kept" || bad "the copy was reset under the running demo"

echo "== a broken layout in the config"
echo '{"layout": "grid"}' > "$OUT/xdg/symbiosis/config.json"
run
has "$OUT/out.txt" '"layout" must be "tabs" or "split"' "a clear stop"

[ "$fails" = 0 ] || { echo "== calls"; cat "$CALLS"; echo "== out"; cat "$OUT/out.txt"; exit 1; }
echo "all passed ($OUT)"
