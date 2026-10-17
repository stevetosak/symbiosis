#!/usr/bin/env bash
# ask end to end: a fake pi (test/e2e/ask.ts) answers side calls. A headless
# ttt: ctrl+k d on a line opens the drawer with the answer, a file link and
# terms, and the answer is kept as a note (file in .symbiosis/notes, ◆ in the
# gutter); in a git folder ttt asks once about .gitignore. A `why!` comment asks about its line and goes out of the file.
# A click on a term asks about it. ctrl+k d on the noted line shows its notes
# and does not ask again.
# Usage: test/e2e/ask.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d /tmp/symbiosis-e2e.XXXXXX)}
# The real path: ttt's fs sees no symlinks (macOS: /tmp, /var -> /private/...).
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
export TTT_CONFIG_DIR="$OUT/cfg"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws"
"$repo/bin/run-node" "$repo/ttt/build.ts" >/dev/null
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
echo '{"autosave":0}' > "$OUT/cfg/plugins/symbiosis/settings.json"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
cat > "$OUT/ws/code.ts" <<'TS'
export function retry(times: number): number {
	let n = 0;
	for (let i = 0; i < times; i++) {
		n += 1;
	}
	return n;
}
TS

git -C "$OUT/ws" init -q
"$repo/bin/run-node" "$repo/test/e2e/ask.ts" "$OUT/ws" ${PI_MS:-24000} > "$OUT/pi.log" 2>&1 &
pi=$!
sleep 0.8
# Line 3 is the loop. ctrl+k d asks; the answer comes in about 1.5 s.
steps="wait 2000; key down; key down; key ctrl+k d; wait 600; screenshot $OUT/0-think.txt; wait 2500"
# The first note in a git folder: ttt asks whether to keep the notes out of git (Cancel has the focus: Tab, then OK).
steps="$steps; screenshot $OUT/1a-confirm.txt; key tab; key enter; wait 500; screenshot $OUT/1-answer.txt"
# A typed follow-up (the dialog took the focus from the drawer: ctrl+k d on the noted line gives it back).
# The letters of "and add it" are the ones the buttons used to take as mnemonics.
steps="$steps; click 40 6; key ctrl+k d; wait 500; type and add it; wait 300; screenshot $OUT/1c-typed.txt; key enter; wait 3000; screenshot $OUT/1d-follow.txt"
# A click on a term and Enter: a new question, with this answer as context.
steps="$steps; click 70 25; wait 300; key enter; wait 3000; screenshot $OUT/1b-drill.txt"
# Esc closes the drawer. Line 4 end: a why! comment on its own line, under it.
steps="$steps; key esc; wait 500; screenshot $OUT/2-gutter.txt"
# (click is 0-based: x 32, y 6.) A click on the mark of line 3 opens its notes (newest first).
steps="$steps; click 32 6; wait 800; screenshot $OUT/2b-click.txt; key esc; wait 300"
steps="$steps; key down; key end; type // why add one? why!; wait 3500; screenshot $OUT/3-why.txt; key esc; wait 300"
# Back on line 3: the newest note shows (the drill-down), no new question.
steps="$steps; key up; key ctrl+k d; wait 1000; screenshot $OUT/4-note.txt; key esc; wait 300"
steps="$steps; key ctrl+s; wait 500; quit"
(cd "$OUT/ws" && ttt --size 120x30 . code.ts --exec "$steps" > /dev/null 2>&1) || true
wait $pi || true
echo "== pi"; cat "$OUT/pi.log"
echo "== code.ts"; sed 's/	/→/g' "$OUT/ws/code.ts"
echo "== notes"; cat "$OUT/ws/.symbiosis/notes/code.ts.jsonl" 2>&1 || true
fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }

grep -q 'pi · code.ts line 3' "$OUT/1-answer.txt" || fail "no drawer titled with the line"
grep -q 'The loop runs' "$OUT/1-answer.txt" || fail "the answer is not in the drawer"
grep -q 'the loop · code.ts:3' "$OUT/1-answer.txt" || fail "no file link"
grep -q 'accumulator' "$OUT/1-answer.txt" || fail "no term to ask about"
grep -q 'not checked' "$OUT/1-answer.txt" || fail "the URL is not marked as unchecked"
grep -q 'developer.mozilla.org' "$OUT/1-answer.txt" || fail "the URL link is not shown"
grep -q 'times' "$OUT/pi.log" || fail "the word under the cursor did not reach pi"
grep -q 'Keep pi.s notes out of git' "$OUT/1a-confirm.txt" || fail "no question about .gitignore"
grep -qx '.symbiosis/notes/' "$OUT/ws/.gitignore" || fail "OK did not add the notes to .gitignore"
test -s "$OUT/ws/.symbiosis/notes/code.ts.jsonl" || fail "no note file"
grep -q 'pi · code.ts line 3' "$OUT/2b-click.txt" || fail "a click on the gutter mark did not open the notes"
grep -q '◆' "$OUT/2-gutter.txt" || fail "no mark in the gutter"
grep -q 'add one' "$OUT/ws/code.ts" && fail "the why! comment stays in the file"
grep -q '^		n += 1;$' "$OUT/ws/code.ts" || fail "the code line lost its text"
grep -q 'why!' "$OUT/ws/code.ts" && fail "why! stays in the file"
grep -q 'question: why add one?' "$OUT/pi.log" || fail "the why! question did not reach pi"
grep -q 'line: 4; question: why add one?' "$OUT/pi.log" || fail "the why! did not ask about its line"
grep -q 'The loop runs' "$OUT/3-why.txt" || fail "the why! answer is not in the drawer"
grep -q 'question: and add it; word: -; parent: (explain this code)' "$OUT/pi.log" || fail "the typed follow-up did not reach pi with the answer before"
grep -q '? and add it' "$OUT/1d-follow.txt" || fail "the follow-up is not in the drawer"
grep -q 'question: What is "accumulator" here?; word: -; parent: and add it' "$OUT/pi.log" || fail "the drill-down did not carry the answer before"
grep -q '? What is "accumulator" here?' "$OUT/1b-drill.txt" || fail "the drill-down is not in the drawer"
grep -q '? What is "accumulator" here?' "$OUT/4-note.txt" || fail "the line's newest note is not shown"
grep -q 'Back' "$OUT/4-note.txt" || fail "no Back to the older note"
grep -q 'asked: 4$' "$OUT/pi.log" || fail "a letter typed in the input pressed a button, or the noted line asked again"
[ "$(wc -l < "$OUT/ws/.symbiosis/notes/code.ts.jsonl")" = 4 ] || fail "not four notes in the file"
echo "all passed ($OUT)"
