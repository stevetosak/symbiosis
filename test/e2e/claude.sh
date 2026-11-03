#!/usr/bin/env bash
# Claude Code through its hooks (test/e2e/claude.ts plays one turn into the
# real claude/hook.mjs and keeper) against a headless ttt: the bar shows the
# claude session working, which file it wrote, the plan from its tasks, the
# diff of the turn, and idle after Stop.
# Usage: test/e2e/claude.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-e2e.XXXXXX)}
# The real path: ttt's fs sees no symlinks (macOS: /tmp, /var -> /private/...).
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
export TTT_CONFIG_DIR="$OUT/cfg"
export SYMBIOSIS_RUN_DIR="$OUT/run"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws"
mkdir -m 700 "$OUT/run"
"$repo/bin/run-node" "$repo/ttt/build.ts" >/dev/null
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
printf 'notes\n' > "$OUT/ws/notes.txt"
: > "$OUT/transcript.jsonl"

# Claude writes and edits by about 3 s, works until about 8 s, then stops.
steps="wait 4500; screenshot $OUT/working.txt; key ctrl+k v; wait 600; screenshot $OUT/plan.txt; key escape; wait 300; key ctrl+k w; wait 800; screenshot $OUT/diff.txt; wait 4000; screenshot $OUT/idle.txt; quit"
(cd "$OUT/ws" && ttt --size 140x30 notes.txt --exec "$steps" > /dev/null 2>&1) &
ttt=$!
sleep 0.4
"$repo/bin/run-node" "$repo/test/e2e/claude.ts" "$OUT/ws" "$OUT/transcript.jsonl" > "$OUT/claude.log" 2>&1 &
claude=$!
wait $ttt || true
wait $claude || true
cat "$OUT/claude.log"
fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
grep -q 'owner: this' "$OUT/claude.log" || fail "the editor did not follow the claude session"
grep -q '✻ ws ● working' "$OUT/working.txt" || fail "the bar does not show the claude session working"
grep -q 'claude ✎ store.ts' "$OUT/working.txt" || fail "the bar does not say which file claude wrote"
grep -q 'claude plan' "$OUT/plan.txt" || fail "the plan drawer is not claude's"
grep -q 'Write the store' "$OUT/plan.txt" || fail "the plan drawer does not list the first task"
grep -q 'Add done(i)' "$OUT/plan.txt" || fail "the plan drawer does not list the second task"
grep -q 'store.ts (diff)' "$OUT/diff.txt" || fail "ctrl+k w did not open the diff of claude's turn"
grep -q 'claude did not change this file; this is store.ts' "$OUT/diff.txt" || fail "the diff notice does not name claude"
grep -q '✻ ws ○ idle' "$OUT/idle.txt" || fail "the bar does not go idle after Stop"
pgrep -f "claude/keeper.ts e2e-claude" > /dev/null && fail "the keeper did not end with the session"
echo "all passed ($OUT)"
