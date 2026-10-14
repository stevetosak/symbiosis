#!/usr/bin/env bash
# The gutter marks: while pi types, ▌ marks the lines of this change and π the
# line it types now; when the change ends, the marks go. Runs run.sh slowly
# (80 characters per second) and reads its screenshots.
# Usage: test/e2e/marks.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:-$(mktemp -d)}
SPEED=80 LAG=-1 bash "$repo/test/e2e/run.sh" "$OUT" > /dev/null
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
# The gutter is the first column of each editor line, before the line number.
gutter() { grep -cE "^.?$1 *[0-9]+ " "$2" || true; }
now=0 bar=0
for shot in "$OUT"/shot-*.txt; do
	[ "$(gutter π "$shot")" -gt 0 ] && now=$((now + 1))
	[ "$(gutter ▌ "$shot")" -gt 0 ] && bar=$((bar + 1))
done
[ "$now" -gt 0 ] && ok "π on the line pi types ($now shots)" || bad "no π in any shot"
[ "$bar" -gt 0 ] && ok "▌ on the lines of the change ($bar shots)" || bad "no ▌ in any shot"
last=$(ls "$OUT"/shot-*.txt | tail -1)
if [ "$(gutter π "$last")" = 0 ] && [ "$(gutter ▌ "$last")" = 0 ]; then ok "no marks after the change"; else bad "marks left in $last"; fi
[ "$fails" = 0 ] || exit 1
echo "all passed ($OUT)"
