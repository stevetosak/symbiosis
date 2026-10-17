#!/bin/sh
# Runs install.sh in a throw-away HOME, with no network: curl, ttt and pi
# are stubs, herdr is the real binary. Runs: no herdr (ttt, pi, the package,
# the command; herdr is not installed), then herdr there (plugin, key,
# integration "yes"), again (nothing twice, integration "no"), and a config
# that already uses the key.
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
*eugenioenko/ttt*) echo 'mkdir -p "\$HOME/.local/bin"; cp "$stubs/ttt.real" "\$HOME/.local/bin/ttt"' ;;
*pi.dev*) echo 'mkdir -p "\$HOME/.pi/agent/bin"; cp "$stubs/pi.real" "\$HOME/.pi/agent/bin/pi"' ;;
esac
STUB
printf '#!/bin/sh\necho "ttt $*" >>"%s/log"\necho "ttt 1.7.1"\n' "$t" >"$stubs/ttt.real"
# pi: `list` prints each package as pi does, its source then its folder.
cat >"$stubs/pi.real" <<STUB
#!/bin/sh
echo "pi \$*" >>"$t/log"
case "\$1" in
list) echo "User packages:"; cat "\$HOME/pi-packages" 2>/dev/null || true ;;
install) printf '  %s\n    %s\n' "\$2" "\$2" >>"\$HOME/pi-packages" ;;
esac
STUB
ln -s "$(command -v node)" "$stubs/node" # setup.sh builds the plugin with it
chmod +x "$stubs"/*

run() {
	env -i HOME="$t/home" PATH="$stubs:/usr/bin:/bin" TERM=dumb \
		SYMBIOSIS_CHECKOUT="$repo" SYMBIOSIS_HERDR_INTEGRATION="$1" \
		sh "$repo/install.sh" </dev/null >"$t/out-$1" 2>&1 || { cat "$t/out-$1"; echo "FAIL: install.sh ($1)"; exit 1; }
}
check() { grep -q -- "$2" "$1" || { echo "FAIL: no '$2' in $1"; cat "$1"; exit 1; }; }
refuse() { if grep -q -- "$2" "$1"; then echo "FAIL: '$2' in $1"; cat "$1"; exit 1; fi; }

# 1. No herdr: it is not installed; the rest is.
run yes
refuse "$t/log" "herdr.dev"
check "$t/log" "pi install $repo"
check "$t/out-yes" "ttt installed"
check "$t/out-yes" "pi package installed: $repo"
check "$t/out-yes" "Go to a project folder and run: symbiosis"
if PATH="/usr/bin:/bin" command -v tmux >/dev/null 2>&1; then
	check "$t/out-yes" "Run it in tmux"
else
	check "$t/out-yes" "herdr: curl -fsSL https://herdr.dev/install.sh | sh"
fi
refuse "$t/out-yes" "herdr plugin"
cmp -s "$repo/ttt/symbiosis/plugin.lua" "$t/home/.config/ttt/plugins/symbiosis/plugin.lua" || { echo "FAIL: ttt plugin not copied"; ls -R "$t/home/.config"; exit 1; }
[ "$(readlink "$t/home/.local/bin/symbiosis")" = "$repo/bin/symbiosis" ] || { echo "FAIL: no command link"; ls -l "$t/home/.local/bin"; exit 1; }
check "$t/out-yes" "is not on your PATH"
echo "no herdr: ttt, pi, pi package, ttt plugin, command; herdr left out"

# 2. herdr there: the plugin, the key, the integration.
ln -s "$real_herdr" "$t/home/.local/bin/herdr"
: >"$t/log"
run yes
refuse "$t/log" "curl"
refuse "$t/log" "pi install"
check "$t/out-yes" "herdr is there"
check "$t/out-yes" "pi package is there: $repo"
check "$t/out-yes" "command $t/home/.local/bin/symbiosis is there"
check "$t/out-yes" "herdr pi integration installed"
test -f "$t/home/.pi/agent/extensions/herdr-agent-state.ts" || { echo "FAIL: no integration file"; exit 1; }
env -i HOME="$t/home" PATH="$stubs:/usr/bin:/bin" "$real_herdr" plugin list 2>&1 | grep -q "symbiosis (symbiosis) enabled" || { echo "FAIL: plugin not registered"; exit 1; }
cfg="$t/home/.config/herdr/config.toml"
check "$cfg" 'command = "symbiosis.open"'
check "$cfg" 'key = "prefix+shift+s"'
check "$t/out-yes" "herdr key prefix+shift+s opens symbiosis"
check "$t/out-yes" "In herdr, prefix+shift+s"
out=$(env -i HOME="$t/home" PATH="$stubs:/usr/bin:/bin" "$real_herdr" config check 2>&1 || true)
echo "$out" | grep -qi "config: ok" || { echo "FAIL: herdr config check: $out"; exit 1; }
echo "herdr there: plugin, key, integration"

# 3. Again: nothing twice, the key kept.
: >"$t/log"
rm "$t/home/.pi/agent/extensions/herdr-agent-state.ts"
run no
check "$t/out-no" "Skipped. Later: herdr integration install pi"
refuse "$t/log" "curl"
refuse "$t/log" "pi install"
check "$t/out-no" "herdr key for Open symbiosis is there: prefix+shift+s"
[ "$(grep -c 'symbiosis.open' "$cfg")" = 1 ] || { echo "FAIL: key added twice"; cat "$cfg"; exit 1; }
echo "again: nothing installed twice, key kept"

# 4. A config that already uses the key for something else: left alone.
printf '[[keys.command]]\nkey = "prefix+shift+s"\ntype = "shell"\ncommand = "true"\n' >"$cfg"
run no
check "$t/out-no" "prefix+shift+s is taken"
check "$t/out-no" "herdr plugin action invoke symbiosis.open does the same"
if grep -q symbiosis.open "$cfg"; then echo "FAIL: taken key overwritten"; exit 1; fi
echo "key taken: config left alone"

# 5. A file of its own at ~/.local/bin/symbiosis: left alone.
rm "$t/home/.local/bin/symbiosis"
printf '#!/bin/sh\n' >"$t/home/.local/bin/symbiosis"
run no
check "$t/out-no" "exists and is not a link: left alone"
echo "own command file: left alone"
