#!/bin/sh
# Runs install.sh in a throw-away HOME, with no network: curl, ttt and pi
# are stubs, herdr is the real binary. Two runs: no herdr (the full setup,
# integration "yes"), then herdr there (plugin only, integration "no").
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
real_herdr=$(command -v herdr) || { echo "SKIP: needs herdr"; exit 0; }
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
stubs="$t/stubs"
mkdir -p "$stubs" "$t/home"

# curl: prints an "installer" that puts the program in place.
cat >"$stubs/curl" <<STUB
#!/bin/sh
for a; do url=\$a; done
echo "curl \$url" >>"$t/log"
case "\$url" in
*herdr.dev*) echo 'mkdir -p "\$HOME/.local/bin"; ln -sf "$real_herdr" "\$HOME/.local/bin/herdr"' ;;
*eugenioenko/ttt*) echo 'mkdir -p "\$HOME/.local/bin"; cp "$stubs/ttt.real" "\$HOME/.local/bin/ttt"' ;;
*pi.dev*) echo 'mkdir -p "\$HOME/.pi/agent/bin"; cp "$stubs/pi.real" "\$HOME/.pi/agent/bin/pi"' ;;
esac
STUB
printf '#!/bin/sh\necho "ttt $*" >>"%s/log"\necho "ttt 1.7.1"\n' "$t" >"$stubs/ttt.real"
cat >"$stubs/pi.real" <<STUB
#!/bin/sh
echo "pi \$*" >>"$t/log"
case "\$1" in
list) cat "\$HOME/pi-packages" 2>/dev/null || true ;;
install) echo "  \$2" >>"\$HOME/pi-packages" ;;
esac
STUB
chmod +x "$stubs"/*

run() {
	env -i HOME="$t/home" PATH="$stubs:/usr/bin:/bin" TERM=dumb \
		SYMBIOSIS_PLUGIN_DIR="$repo/herdr-plugin" SYMBIOSIS_HERDR_INTEGRATION="$1" \
		sh "$repo/install.sh" </dev/null >"$t/out-$1" 2>&1 || { cat "$t/out-$1"; echo "FAIL: install.sh ($1)"; exit 1; }
}
check() { grep -q -- "$2" "$1" || { echo "FAIL: no '$2' in $1"; cat "$1"; exit 1; }; }

run yes
check "$t/log" "curl https://herdr.dev/install.sh"
check "$t/log" "pi install git:github.com/stevetosak/symbiosis"
check "$t/out-yes" "herdr installed"
check "$t/out-yes" "go to a project folder and run: herdr"
check "$t/out-yes" "herdr pi integration installed"
test -f "$t/home/.pi/agent/extensions/herdr-agent-state.ts" || { echo "FAIL: no integration file"; exit 1; }
cmp -s "$repo/ttt/symbiosis/plugin.lua" "$t/home/.config/ttt/plugins/symbiosis/plugin.lua" || { echo "FAIL: ttt plugin not copied"; ls -R "$t/home/.config" ; exit 1; }
env -i HOME="$t/home" PATH="$stubs:/usr/bin:/bin" "$real_herdr" plugin list 2>&1 | grep -q "symbiosis (symbiosis) enabled" || { echo "FAIL: plugin not registered"; exit 1; }
cfg="$t/home/.config/herdr/config.toml"
check "$cfg" 'command = "symbiosis.open"'
check "$cfg" 'key = "prefix+shift+s"'
check "$t/out-yes" "herdr key prefix+shift+s opens symbiosis"
check "$t/out-yes" "Press prefix+shift+s"
out=$(env -i HOME="$t/home" PATH="$stubs:/usr/bin:/bin" "$real_herdr" config check 2>&1 || true)
echo "$out" | grep -qi "config: ok" || { echo "FAIL: herdr config check: $out"; exit 1; }
echo "full setup: herdr, ttt, pi, pi package, ttt plugin, key, integration"

: >"$t/log"
rm "$t/home/.pi/agent/extensions/herdr-agent-state.ts"
run no
check "$t/out-no" "herdr is there"
check "$t/out-no" "Skipped. Later: herdr integration install pi"
check "$t/out-no" "In herdr, go to a workspace"
if grep -q "curl\|pi install" "$t/log"; then echo "FAIL: second run installed again"; cat "$t/log"; exit 1; fi
check "$t/out-no" "herdr key for Open symbiosis is there: prefix+shift+s"
[ "$(grep -c 'symbiosis.open' "$cfg")" = 1 ] || { echo "FAIL: key added twice"; cat "$cfg"; exit 1; }
echo "herdr there: plugin only, nothing installed twice, key kept"

# A config that already uses the key for something else: left alone.
printf '[[keys.command]]\nkey = "prefix+shift+s"\ntype = "shell"\ncommand = "true"\n' >"$cfg"
run no
check "$t/out-no" "prefix+shift+s is taken"
check "$t/out-no" "2. Run: herdr plugin action invoke symbiosis.open"
if grep -q symbiosis.open "$cfg"; then echo "FAIL: taken key overwritten"; exit 1; fi
echo "key taken: config left alone"
