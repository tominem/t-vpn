#!/bin/sh
# End-to-end check against a real, rooted TV. Not part of `npm test`: it needs
# the device, a working NordVPN credential and a couple of minutes.
#
# The unit tests prove the logic. This proves the things they cannot: that the
# hub routes the app's calls, that OpenVPN really comes up under the service's
# environment, that traffic and DNS genuinely go through the tunnel, and that
# disconnecting puts everything back.
#
#   scripts/smoke-test.sh [tv-host] [country]
#
# The TV's address comes from DHCP and changes, so it is never written here;
# lib-tv.sh resolves it from an argument, $TV_HOST, or the webos-tv skill's tv.env.
# Leaves the TV disconnected with its resolver restored, pass or fail.
# shellcheck source=lib-tv.sh
. "$(cd "$(dirname "$0")" && pwd)/lib-tv.sh"
resolve_tv "${1:-}" || exit 2
COUNTRY=${2:-br}

SSH=tv_ssh
FAILED=0

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=$((FAILED + 1)); }

check() {
  # check "<description>" "<remote command that must succeed>"
  if $SSH "$2" >/dev/null 2>&1; then pass "$1"; else fail "$1"; fi
}

# One Luna call, answered or not. The hub sometimes never replies, so the call
# is bounded and its reply read from a file instead of the terminal, where
# luna-send's output never appears over SSH.
luna() {
  $SSH "
    killall luna-send 2>/dev/null
    rm -f /tmp/smoke.out
    luna-send -f -n 1 luna://com.tominem.tvpn.service/$1 '$2' > /tmp/smoke.out 2>&1 &
    P=\$!; sleep ${3:-14}; kill \$P 2>/dev/null
    tr -d '\n ' < /tmp/smoke.out
  " 2>/dev/null
}

cleanup() {
  luna disconnect '{}' 8 >/dev/null
  $SSH 'mountpoint -q /etc/resolv.conf && umount /etc/resolv.conf; rm -f /tmp/smoke.out' >/dev/null 2>&1
}
trap cleanup EXIT

echo "T-VPN smoke test: $TV, server '$COUNTRY'"

echo "Installation"
check "OpenVPN reports LZO support" \
  '/media/developer/ovpn-alpine/openvpn --version 2>&1 | grep -q "\[LZO\]"'
check "credentials directory is 700" \
  '[ "$(stat -c %a /media/developer/vpn)" = 700 ]'
check "credentials file is 600" \
  '[ "$(stat -c %a /media/developer/vpn/.auth)" = 600 ]'
check "boot permission script is installed" \
  '[ -x /var/lib/webosbrew/init.d/20-tvpn-perms ]'
check "app-level Luna permissions are registered" \
  '[ -f /var/luna-service2-dev/client-permissions.d/com.tominem.tvpn.app.json ]'
check "app is known to the application manager" \
  'luna-send -f -n 1 luna://com.webos.applicationManager/getAppInfo "{\"id\":\"com.tominem.tvpn\"}" > /tmp/smoke.out 2>&1 & P=$!; sleep 8; kill $P 2>/dev/null; grep -q "\"returnValue\": true" /tmp/smoke.out'

echo "Service"
case "$(luna status '{}')" in
  *'"connected":false'*) pass "starts disconnected" ;;
  *) fail "starts disconnected (got: $(luna status '{}'))" ;;
esac

echo "Connect"
case "$(luna connect "{\"country\":\"$COUNTRY\"}" 15)" in
  *'"ok":true'*) pass "connect accepted" ;;
  *) fail "connect accepted" ;;
esac

$SSH 'i=0; while [ $i -lt 30 ]; do ip addr show tun0 2>/dev/null | grep -q "inet " && exit 0; sleep 2; i=$((i+1)); done; exit 1' \
  && pass "tunnel came up" || fail "tunnel came up"

case "$(luna status '{}' 14)" in
  *"\"connected\":true"*"\"country\":\"$COUNTRY\""*) pass "status reports $COUNTRY" ;;
  *) fail "status reports $COUNTRY (got: $(luna status '{}'))" ;;
esac

check "tunnel carries traffic" 'ping -c 2 -W 5 1.1.1.1'
check "default route goes through the tunnel" \
  'ip route get 1.1.1.1 | grep -q tun0'

echo "DNS"
check "resolver points at the VPN's DNS" \
  'mountpoint -q /etc/resolv.conf && grep -q "^nameserver 10\.\|^nameserver 103\.86\." /etc/resolv.conf'
check "that DNS is reached through the tunnel" \
  'ip route get "$(grep -m1 ^nameserver /etc/resolv.conf | cut -d" " -f2)" | grep -q tun0'
check "names still resolve" \
  'python2 -c "import socket; socket.setdefaulttimeout(8); socket.gethostbyname(\"example.com\")"'

echo "Service stays responsive while connected"
case "$(luna status '{}' 14)" in
  *'"returnValue":true'*) pass "status answered with the tunnel up" ;;
  *) fail "status answered with the tunnel up (hub wedged: run ls-control scan-services)" ;;
esac

echo "Disconnect"
case "$(luna disconnect '{}' 14)" in
  *'"ok":true'*) pass "disconnect accepted" ;;
  *) fail "disconnect accepted" ;;
esac
sleep 4
check "tunnel is gone" '! ip addr show tun0 2>/dev/null | grep -q "inet "'
check "resolver is restored" \
  '! mountpoint -q /etc/resolv.conf && grep -q "^nameserver 127.0.0.1" /etc/resolv.conf'
check "internet works again" 'ping -c 2 -W 5 1.1.1.1'
case "$(luna status '{}' 14)" in
  *'"connected":false'*) pass "status reports disconnected" ;;
  *) fail "status reports disconnected" ;;
esac

echo
if [ "$FAILED" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$FAILED check(s) failed."
  exit 1
fi
