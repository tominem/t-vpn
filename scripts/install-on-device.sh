#!/bin/sh
# Finishes the install ON the TV, from the installed service directory.
#
# An IPK can only drop files; it cannot run anything. Everything else the VPN
# needs is done here, and every step is safe to repeat, so this is also how an
# upgrade is finished:
#
#   - the server configs go to /media/developer/vpn (700; each file 600)
#   - the boot scripts go to the Homebrew Channel's init.d, so entropy seeding
#     and the credential permissions are redone on every boot
#   - the Luna bus is told about the app and the service
#
# It never touches .auth: that file holds the user's NordVPN service credentials
# and is created by them, not shipped.
#
# TVPN_* overrides exist only so the tests can run this without a TV.
set -eu

SVC_DIR=$(cd "$(dirname "$0")" && pwd)
VPN_DIR=${TVPN_VPN_DIR:-/media/developer/vpn}
INITD=${TVPN_INITD_DIR:-/var/lib/webosbrew/init.d}

[ -d "$SVC_DIR/configs" ] || { echo "install-on-device: no configs/ beside $0" >&2; exit 1; }

mkdir -p "$VPN_DIR"
chmod 700 "$VPN_DIR"
count=0
for f in "$SVC_DIR"/configs/*.ovpn; do
  [ -f "$f" ] || continue
  cp "$f" "$VPN_DIR/$(basename "$f")"
  chmod 600 "$VPN_DIR/$(basename "$f")"
  count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo "install-on-device: configs/ has no .ovpn files" >&2; exit 1; }
echo "installed $count server configs into $VPN_DIR"

mkdir -p "$INITD"
for name in 10-entropy-seed 20-tvpn-perms; do
  [ -f "$SVC_DIR/boot/$name" ] || { echo "install-on-device: boot/$name missing" >&2; exit 1; }
  cp "$SVC_DIR/boot/$name" "$INITD/$name"
  chmod 755 "$INITD/$name"
done
echo "installed boot scripts into $INITD"

# Run them now so the first connection does not wait for a reboot. The seeder
# starts a background loop, so the tests turn this off.
if [ -z "${TVPN_NO_START:-}" ]; then
  sh "$INITD/20-tvpn-perms"
  sh "$INITD/10-entropy-seed"
fi

TVPN_SVC_DIR="$SVC_DIR" sh "$SVC_DIR/install-luna-registration.sh"

if [ -f "$VPN_DIR/.auth" ]; then
  echo "credentials: $VPN_DIR/.auth is present"
else
  echo "credentials: $VPN_DIR/.auth is NOT present. Create it with your NordVPN"
  echo "service credentials (username on line 1, password on line 2), mode 600."
fi
