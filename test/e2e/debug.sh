#!/usr/bin/env bash
# The debugger end to end, against a headless ttt and a real debugpy: F9 sets
# a breakpoint (◉ in the gutter), shift+F9 debugs (the Debug picker, as no
# configuration is chosen), the program pauses there (▶, the call stack and
# the variables in the Run panel), F10 steps over, shift+F11 steps out, a
# variable opens, a watch is evaluated, F9 takes the breakpoint off, F5 runs
# to the end. Needs debugpy: pip's, or VS Code's Python Debugger extension's.
# Usage: test/e2e/debug.sh [out-dir]
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if ! python3 -c 'import debugpy' 2>/dev/null && ! compgen -G "$HOME/.vscode*/extensions/ms-python.debugpy-*/bundled/libs/debugpy" > /dev/null; then
	echo "skip: no debugpy (python3 -m pip install debugpy)"
	exit 0
fi
OUT=${1:-$(mktemp -d /tmp/symbiosis-debug.XXXXXX)}
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd -P)
rm -rf "$OUT/cfg" "$OUT/ws"
mkdir -p "$OUT/cfg/plugins/symbiosis" "$OUT/ws/.symbiosis"
"$repo/bin/run-node" "$repo/ttt/build.ts" >/dev/null
cp "$repo"/ttt/symbiosis/* "$OUT/cfg/plugins/symbiosis/"
perms=$(python3 -c "import json; print(json.dumps(json.load(open('$repo/ttt/symbiosis/plugin.ttt.json'))['permissions']))")
echo "[{\"name\":\"symbiosis\",\"displayName\":\"symbiosis\",\"version\":\"0.1.0\",\"enabled\":true,\"permissions\":$perms}]" > "$OUT/cfg/plugins.ttt.json"
ws=$OUT/ws
runs=$OUT/cfg/plugins/symbiosis/runs
cleanup() { "$repo/bin/symbiosis" run stop --folder "$ws" --all --runs "$runs" > /dev/null 2>&1 || true; }
trap cleanup EXIT
git -C "$ws" init -q
cat > "$ws/.symbiosis/run.json" <<'JSON'
{ "configurations": [{ "name": "cart", "command": "python3 cart.py" }, { "name": "echo", "command": "echo not this one" }] }
JSON
cat > "$ws/cart.py" <<'PY'
import sys

def add(a, b):
    total = a + b
    return total

def main():
    items = [1, 2, 3]
    info = {"name": "cart", "n": len(items)}
    s = 0
    for i in items:
        s = add(s, i)
    print("sum", s, flush=True)

main()
PY

export PATH="$repo/bin:$PATH"
s="screenshot $OUT"
# Line 4 (total = a + b): F9.
steps="wait 1500; key down; key down; key down; key f9; wait 300; $s/bp.txt"
# shift+F9 with nothing chosen: the Debug picker lists what it can debug; Enter on cart.
steps="$steps; key shift+f9; wait 1200; $s/pick.txt; type cart; wait 300; key enter; wait 4000; $s/paused.txt"
# F10: over to line 5. shift+F11: out, to main's line 12.
steps="$steps; key f10; wait 1500; $s/over.txt; key shift+f11; wait 1500; $s/out.txt"
# The Run panel: Tab to the variables, down to items, Enter opens it.
steps="$steps; key ctrl+k shift+f5; wait 300; key tab; wait 200; key down; key down; key down; wait 200; key enter; wait 1200; $s/open.txt"
# e: a watch.
steps="$steps; type e; wait 500; type len(items) * 10; key enter; wait 1200; $s/watch.txt; key escape; wait 300"
# The panel has the focus: c continues, to the breakpoint again (the next item);
# the focus stays in the panel, so n steps over from there.
steps="$steps; key ctrl+k shift+f5; wait 300; type c; wait 1500; $s/again.txt; type n; wait 1500; $s/panel-n.txt"
# Esc: the editor, its cursor on the paused line (5); up to 4, F9 takes the breakpoint off; F5 runs to the end.
steps="$steps; key escape; wait 300; key up; key f9; wait 300; $s/off.txt; key f5; wait 3000; $s/ended.txt; quit"
cd "$ws"
TTT_CONFIG_DIR="$OUT/cfg" ttt --size 130x40 cart.py --exec "$steps" > /dev/null 2>&1 || true

fail() { echo "FAIL: $*"; echo "out: $OUT"; exit 1; }
grep -q '│◉ 4 ' "$OUT/bp.txt" || fail "F9 did not mark line 4"
grep -q '▼ Saved' "$OUT/pick.txt" && grep -q 'cart' "$OUT/pick.txt" || fail "shift+F9 did not open the Debug picker with cart"
grep -q 'echo not this one' "$OUT/pick.txt" && fail "the Debug picker lists a configuration it cannot debug"
grep -q '│▶ 4 ' "$OUT/paused.txt" || fail "not paused on line 4 (no ▶)"
grep -q 'paused on breakpoint · cart.py:4' "$OUT/paused.txt" || fail "the Run panel does not say where it paused"
grep -q 'CALL STACK' "$OUT/paused.txt" && grep -q '› add  cart.py:4' "$OUT/paused.txt" && grep -q 'main  cart.py:12' "$OUT/paused.txt" || fail "no call stack"
grep -q '▾ Locals' "$OUT/paused.txt" && grep -q 'a = 0' "$OUT/paused.txt" && grep -q 'b = 1' "$OUT/paused.txt" || fail "no locals"
grep -q '⏸ cart.py:4' "$OUT/paused.txt" || fail "the status bar does not say it is paused"
grep -q '│▶ 5 ' "$OUT/over.txt" && grep -q 'total = 1' "$OUT/over.txt" || fail "F10 did not step over to line 5"
grep -q '│▶12 ' "$OUT/out.txt" && grep -q 'main  cart.py:12' "$OUT/out.txt" || fail "shift+F11 did not step out to main"
grep -q '│◉ 4 ' "$OUT/out.txt" || fail "the breakpoint mark did not come back when ▶ left its line"
grep -q '▾ items = \[1, 2, 3\]' "$OUT/open.txt" || fail "Enter did not open items"
grep -q "0 = 1" "$OUT/open.txt" || fail "items' children are not shown"
grep -q '◇ len(items) \* 10 = 30' "$OUT/watch.txt" || fail "the watch was not evaluated"
grep -q 'paused on breakpoint · cart.py:4' "$OUT/again.txt" && grep -q 'a = 1' "$OUT/again.txt" && grep -q 'b = 2' "$OUT/again.txt" || fail "c in the Run panel did not continue to the breakpoint"
grep -q 'paused on step · cart.py:5' "$OUT/panel-n.txt" || fail "n in the Run panel did not step over"
grep -q 'nc' "$ws/cart.py" && fail "the letters went into the file, not the Run panel"
grep -q '│◉ 4 ' "$OUT/off.txt" && fail "F9 did not take the breakpoint off"
grep -q '"line"' "$OUT/cfg/plugins/symbiosis/breakpoints.json" && fail "breakpoints.json keeps the breakpoint F9 took off"
grep -q '"command":"setBreakpoints","arguments":{"source":{"path":"[^"]*cart.py"},"breakpoints":\[{"line":4}\]' "$runs"/*/dap.log || fail "the session did not get the breakpoint from breakpoints.json"
grep -q 'sum 6' "$OUT/ended.txt" || fail "F5 did not run to the end (no output)"
grep -q '✓ cart' "$OUT/ended.txt" || fail "the run did not end well"
echo "all passed ($OUT)"
