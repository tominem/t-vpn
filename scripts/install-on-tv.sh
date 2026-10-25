#!/bin/sh
# Installs the built IPK on the TV and finishes the setup, without launching
# anything: the app is not started or relaunched, so whatever the TV is
# showing stays on screen.
#
#   scripts/install-on-tv.sh [--auth-file FILE] [IPK] [TV-HOST]
#
#   IPK         default: the newest build/dist/*.ipk
#   --auth-file a local file with the NordVPN service credentials (username on
#               line 1, password on line 2). It is streamed over SSH straight
#               into /media/developer/vpn/.auth with mode 600, never placed in a
#               command line or left in a world-readable file.
#
# What it does: copy the IPK, install it with opkg (synchronous, unlike the
# system installer), then run the install-on-device.sh shipped inside it, which
# deploys the configs and boot scripts and registers the Luna service. Finishing
# step asks the Luna hub to rescan, which can drop SSH sessions for a moment, so
# that step runs detached on the TV and this script polls for its result.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
# shellcheck source=lib-tv.sh
. "$HERE/lib-tv.sh"

die() { echo "install-on-tv: $*" >&2; exit 1; }

AUTH_FILE=""
IPK=""
HOST_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --auth-file) [ "$#" -ge 2 ] || die "--auth-file needs a path"; AUTH_FILE=$2; shift 2 ;;
    -*) die "unknown option: $1" ;;
    *.ipk) IPK=$1; shift ;;
    *) HOST_ARG=$1; shift ;;
  esac
done

[ -z "$IPK" ] && IPK=$(ls -t "${TVPN_DIST_DIR:-$ROOT/build/dist}"/*.ipk 2>/dev/null | head -1 || true)
[ -n "$IPK" ] && [ -f "$IPK" ] || die "no IPK to install; run scripts/build-ipk.sh first"
[ -z "$AUTH_FILE" ] || [ -f "$AUTH_FILE" ] || die "credentials file not found: $AUTH_FILE"

resolve_tv "$HOST_ARG" || exit 2

APP=com.tominem.tvpn
SVC_DIR=/media/developer/apps/usr/palm/services/$APP.service
REMOTE_IPK=/tmp/$(basename "$IPK")

echo "installing $(basename "$IPK") on the TV"
tv_scp "$IPK" "$REMOTE_IPK" || die "could not copy the IPK to the TV (is SSH enabled in the Homebrew Channel?)"

# opkg's developer root needs this file to exist.
tv_ssh 'mkdir -p /media/developer/apps/etc/opkg
[ -f /media/developer/apps/etc/opkg/opkg.conf ] || cat > /media/developer/apps/etc/opkg/opkg.conf <<EOF
option info_dir /media/developer/apps/usr/lib/opkg/info
option status_file /media/developer/apps/usr/lib/opkg/status
option lock_file /tmp/opkg-developer.lock
EOF'

tv_ssh "opkg -o /media/developer/apps -f /media/developer/apps/etc/opkg/opkg.conf install '$REMOTE_IPK' \
  --no-install-insecure-symlink --force-reinstall --nodeps --force-space" \
  || die "opkg failed to install the package"

# Detached: the Luna rescan at the end of the installer can drop SSH sessions.
tv_ssh "rm -f /tmp/tvpn-install.rc
nohup sh -c 'sh $SVC_DIR/install-on-device.sh > /tmp/tvpn-install.log 2>&1; echo \$? > /tmp/tvpn-install.rc' >/dev/null 2>&1 &"

attempts=0
rc=""
while [ "$attempts" -lt "${TVPN_INSTALL_POLLS:-40}" ]; do
  rc=$(tv_ssh 'cat /tmp/tvpn-install.rc 2>/dev/null' 2>/dev/null || true)
  [ -n "$rc" ] && break
  attempts=$((attempts + 1))
  sleep "${TVPN_INSTALL_POLL_SECONDS:-3}"
done
[ -n "$rc" ] || die "the on-device installer did not finish in time; see /tmp/tvpn-install.log on the TV"

tv_ssh 'cat /tmp/tvpn-install.log' 2>/dev/null || true
[ "$rc" = "0" ] || die "the on-device installer failed (exit $rc)"

if [ -n "$AUTH_FILE" ]; then
  tv_ssh 'umask 077; cat > /media/developer/vpn/.auth && chmod 600 /media/developer/vpn/.auth' < "$AUTH_FILE" \
    || die "could not install the credentials file"
  echo "credentials installed (mode 600)"
fi

tv_ssh "rm -f '$REMOTE_IPK' /tmp/tvpn-install.rc" 2>/dev/null || true
echo "done. Run scripts/smoke-test.sh to verify end to end."
