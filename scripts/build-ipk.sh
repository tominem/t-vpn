#!/bin/sh
# Builds the IPK: the app, plus a service directory that carries everything the
# VPN needs, so installing it does not depend on files placed by hand.
#
#   app      appinfo.json + frontend/
#   service  index.js vpn.js package.json services.json run-js-service
#            openvpn-launch.sh tvpn-updown.sh tvpn-killswitch.sh tvpn-routewatch.sh
#            ovpn-runtime/   OpenVPN 2.6 with its musl loader and libraries
#            configs/        <country>.ovpn, from packaging/servers.txt
#            boot/           init.d scripts (entropy seeding, credential perms)
#            install-on-device.sh, install-luna-registration.sh
#
#   scripts/build-ipk.sh        ->  build/dist/<id>_<version>_all.ipk
#
# Never packaged: .auth (the user's credentials), WireGuard configs (private
# keys), config.json. A final scan refuses the build if any slipped in.
#
# Overrides (the tests use them): ARES_PACKAGE, TVPN_BUILD_DIR, TVPN_RUNTIME_OUT,
# TVPN_SKIP_FETCH.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${TVPN_BUILD_DIR:-$ROOT/build}
RUNTIME=${TVPN_RUNTIME_OUT:-$BUILD/ovpn-runtime}
STAGE=$BUILD/stage
DIST=$BUILD/dist
SERVERS=${TVPN_SERVERS:-$ROOT/packaging/servers.txt}

die() { echo "build-ipk: $*" >&2; exit 1; }

ares=${ARES_PACKAGE:-}
if [ -z "$ares" ]; then
  for candidate in "$(command -v ares-package 2>/dev/null || true)" \
                   "$HOME/.local/share/webos-tv/bin/ares-package" \
                   "$HOME/.npm-global/bin/ares-package"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then ares=$candidate; break; fi
  done
fi
[ -n "$ares" ] || die "ares-package not found. Install the webOS CLI, or set ARES_PACKAGE."

if [ -z "${TVPN_SKIP_FETCH:-}" ]; then
  # Tell the fetch where this build expects the runtime: left to itself it
  # writes under the repository's build/, which differs when TVPN_BUILD_DIR is set.
  TVPN_RUNTIME_OUT="$RUNTIME" TVPN_RUNTIME_CACHE="${TVPN_RUNTIME_CACHE:-$BUILD/cache}" \
    sh "$ROOT/scripts/fetch-openvpn-runtime.sh"
fi
[ -x "$RUNTIME/bin/openvpn" ] || die "OpenVPN runtime missing at $RUNTIME (run scripts/fetch-openvpn-runtime.sh)"

rm -rf "$STAGE"
mkdir -p "$STAGE/app" "$STAGE/svc/configs" "$STAGE/svc/boot" "$DIST"

cp "$ROOT/appinfo.json" "$STAGE/app/"
cp -R "$ROOT/frontend" "$STAGE/app/frontend"

# Every module in services/ ships: a hand-kept list let a new one go missing,
# and the service then dies at load on the TV.
for m in "$ROOT"/services/*.js; do
  cp "$m" "$STAGE/svc/$(basename "$m")"
done
for f in package.json services.json run-js-service openvpn-launch.sh tvpn-updown.sh tvpn-killswitch.sh tvpn-routewatch.sh; do
  [ -f "$ROOT/services/$f" ] || die "services/$f is missing"
  cp "$ROOT/services/$f" "$STAGE/svc/$f"
done
cp -R "$RUNTIME" "$STAGE/svc/ovpn-runtime"

[ -f "$SERVERS" ] || die "server map not found: $SERVERS"
while read -r code host; do
  case "$code" in ''|'#'*) continue ;; esac
  src="$ROOT/ovpn/$host.nordvpn.com.udp.ovpn"
  [ -f "$src" ] || die "no config for '$code': $src"
  cp "$src" "$STAGE/svc/configs/$code.ovpn"
done < "$SERVERS"
[ -n "$(ls "$STAGE/svc/configs")" ] || die "server map produced no configs"

cp "$ROOT/scripts/10-entropy-seed" "$ROOT/scripts/20-tvpn-perms" "$STAGE/svc/boot/"
cp "$ROOT/scripts/install-on-device.sh" "$ROOT/scripts/install-luna-registration.sh" "$STAGE/svc/"

# Source files can carry odd modes (some were 666); the package should not.
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +

chmod 755 "$STAGE/svc/run-js-service" "$STAGE/svc/openvpn-launch.sh" "$STAGE/svc/tvpn-updown.sh" \
          "$STAGE/svc/tvpn-killswitch.sh" "$STAGE/svc/tvpn-routewatch.sh" \
          "$STAGE/svc/install-on-device.sh" "$STAGE/svc/install-luna-registration.sh" \
          "$STAGE/svc/boot/"*
chmod 755 "$STAGE/svc/ovpn-runtime/bin/openvpn" "$STAGE/svc/ovpn-runtime/lib/ld-musl-armhf.so.1"

# Last line of defence: credentials and private keys must never ride along.
leaked=$(find "$STAGE" \( -name '.auth' -o -name 'config.json' -o -name '*.conf' -o -name '*.pem' -o -name '*.key' \) | head -5)
[ -z "$leaked" ] || die "refusing to package files that look like secrets:
$leaked"
if grep -rIlE 'PrivateKey|PRIVATE KEY' "$STAGE" >/dev/null 2>&1; then
  die "refusing to package: private-key material found in $(grep -rIlE 'PrivateKey|PRIVATE KEY' "$STAGE" | head -3 | tr '\n' ' ')"
fi

rm -f "$DIST"/*.ipk
# --no-minify: ares-package otherwise rewrites every .js under the app, so the
# frontend that ships would not be the one the tests ran against (it halved
# main.js). Hidden in --help but accepted by this CLI.
"$ares" --no-minify -o "$DIST" "$STAGE/app" "$STAGE/svc" >&2

ipk=$(ls "$DIST"/*.ipk 2>/dev/null | head -1)
[ -n "$ipk" ] || die "ares-package produced no .ipk in $DIST"

# Prove the package carries exactly what was staged. ares-package has changed
# files under us before, and a test suite only vouches for the bytes it ran.
check=$(mktemp -d)
trap 'rm -rf "$check"' EXIT
cp "$ipk" "$check/pkg.ipk"
( cd "$check" && ar x pkg.ipk && mkdir data && tar -xzf data.tar.gz -C data ) \
  || die "could not open the package to verify it"
app_id=$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' "$ROOT/appinfo.json" | head -1)
verify_tree() {  # verify_tree <staged dir> <dir inside the package>
  ( cd "$1" && find . -type f ) | while read -r rel; do
    cmp -s "$1/$rel" "$2/$rel" || { echo "build-ipk: packaged file differs from what was staged: $rel" >&2; exit 1; }
  done
}
verify_tree "$STAGE/app" "$check/data/usr/palm/applications/$app_id" || die "package does not match the staged app"
verify_tree "$STAGE/svc" "$check/data/usr/palm/services/$app_id.service" || die "package does not match the staged service"
echo "verified: every staged file is byte-identical inside the package" >&2

hash=$(shasum -a 256 "$ipk" | cut -d' ' -f1)
echo "built $ipk"
echo "  size   $(wc -c < "$ipk" | tr -d ' ') bytes"
echo "  sha256 $hash"
