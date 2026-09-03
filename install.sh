#!/bin/sh
set -eu

umask 077

repository="mwe-support/codex-channel-bridge"
version="${CODEX_CHANNEL_BRIDGE_VERSION:-}"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
install_root="${CODEX_CHANNEL_BRIDGE_INSTALL_ROOT:-$data_home/codex-channel-bridge}"
bin_dir="${CODEX_CHANNEL_BRIDGE_BIN_DIR:-$HOME/.local/bin}"
release_base="${CODEX_CHANNEL_BRIDGE_RELEASE_BASE_URL:-}"
staging=""
temporary=""

fail() {
  printf 'codex-channel-bridge installer: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "$staging" ] && [ -d "$staging" ]; then rm -rf "$staging"; fi
  if [ -n "$temporary" ] && [ -d "$temporary" ]; then rm -rf "$temporary"; fi
}
trap cleanup EXIT HUP INT TERM

for command_name in curl node npm tar; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done

node_major=$(node -p "Number(process.versions.node.split('.')[0])")
[ "$node_major" -ge 22 ] || fail "Node.js 22 or newer is required"

codex_executable="${CODEX_EXECUTABLE:-codex}"
if [ "$codex_executable" = "codex" ]; then
  command -v codex >/dev/null 2>&1 || fail "Codex CLI is required and must be installed by the host administrator"
elif [ ! -x "$codex_executable" ]; then
  fail "CODEX_EXECUTABLE must name an executable file"
fi

if [ -z "$version" ]; then
  latest_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$repository/releases/latest") ||
    fail "no stable release is available; set CODEX_CHANNEL_BRIDGE_VERSION to an exact prerelease"
  version=${latest_url##*/}
fi
version=${version#v}
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$' ||
  fail "CODEX_CHANNEL_BRIDGE_VERSION must be an exact semantic version"

[ ! -L "$install_root" ] || fail "install root must not be a symbolic link"
[ ! -e "$install_root" ] || [ -d "$install_root" ] || fail "install root must be a directory"
[ ! -L "$bin_dir" ] || fail "bin directory must not be a symbolic link"
[ ! -e "$bin_dir" ] || [ -d "$bin_dir" ] || fail "bin directory must be a directory"
mkdir -p "$install_root/versions" "$bin_dir"
chmod 700 "$install_root" "$install_root/versions"

temporary=$(mktemp -d "${TMPDIR:-/tmp}/codex-channel-bridge-install.XXXXXX")
archive="codex-channel-bridge-$version.tar.gz"
checksum="$archive.sha256"
if [ -z "$release_base" ]; then
  release_base="https://github.com/$repository/releases/download/v$version"
fi
curl -fsSL "$release_base/$archive" -o "$temporary/$archive"
curl -fsSL "$release_base/$checksum" -o "$temporary/$checksum"

expected=$(awk 'NR == 1 { print $1 }' "$temporary/$checksum")
printf '%s\n' "$expected" | grep -Eq '^[0-9A-Fa-f]{64}$' || fail "published checksum is malformed"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$archive" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$temporary/$archive" | awk '{ print $1 }')
fi
[ "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" = "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" ] ||
  fail "release archive checksum does not match"

tar -xzf "$temporary/$archive" -C "$temporary"
source_directory="$temporary/codex-channel-bridge-$version"
[ -d "$source_directory" ] || fail "release archive has an unexpected layout"
manifest_version=$(cd "$source_directory" && node -p "require('./package.json').version")
[ "$manifest_version" = "$version" ] || fail "release archive version does not match"

target="$install_root/versions/$version"
if [ -d "$target" ]; then
  installed_version=$(cd "$target" && node -p "require('./package.json').version" 2>/dev/null || true)
  [ "$installed_version" = "$version" ] && [ -f "$target/packages/cli/dist/main.js" ] ||
    fail "target version directory already exists but is incomplete"
else
  staging="$install_root/versions/.$version.staging.$$"
  mv "$source_directory" "$staging"
  (
    cd "$staging"
    npm ci
    npm run build
  )
  [ -f "$staging/packages/cli/dist/main.js" ] || fail "Bridge CLI was not built"
  mv "$staging" "$target"
  staging=""
fi

shim="$bin_dir/bridge"
shim_temp="$shim.tmp.$$"
root_temp="$shim.root.tmp.$$"
cat >"$shim_temp" <<'EOF'
#!/bin/sh
set -eu
case "$0" in
  */*) launcher="$0" ;;
  *) launcher=$(command -v "$0") ;;
esac
bridge_root=$(cat "$launcher.root")
bridge_version=$(cat "$bridge_root/current")
exec node "$bridge_root/versions/$bridge_version/packages/cli/dist/main.js" "$@"
EOF
chmod 700 "$shim_temp"
printf '%s\n' "$install_root" >"$root_temp"
mv "$root_temp" "$shim.root"
mv "$shim_temp" "$shim"

current_temp="$install_root/current.tmp.$$"
printf '%s\n' "$version" >"$current_temp"
mv "$current_temp" "$install_root/current"

printf 'Codex Channel Bridge %s is installed.\n' "$version"
printf 'Command: %s\n' "$shim"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'Add %s to PATH before running bridge.\n' "$bin_dir" ;;
esac
