#!/bin/sh
# End-to-end check against a real, rooted TV. Not part of `npm test`: it needs
# the device, a working NordVPN credential and a few minutes.
#
# The unit tests prove the logic. This proves the things they cannot: that the
# hub routes the app's calls, that OpenVPN really comes up under the service's
# environment, that traffic and DNS genuinely go through the tunnel, that the
# kill switch really blocks traffic when the tunnel dies, and that disconnecting
# puts everything back.
#
#   scripts/smoke-test.sh [tv-host] [country]
#
#   SMOKE_SKIP_CRASH=1   skip the second phase, which kills the tunnel on
#                        purpose and so cuts the TV's internet for a few seconds
#   SMOKE_TAKE_OVER=1    run even though a tunnel is already up, disconnecting it
#
# It refuses to run over a tunnel somebody else started: it would disconnect it.
#
# The TV's address comes from DHCP and changes, so it is never written here;
# lib-tv.sh resolves it from an argument, $TV_HOST, or the webos-tv skill's tv.env.
# Leaves the TV disconnected with its resolver and traffic restored, pass or fail.
# shellcheck source=lib-tv.sh
. "$(cd "$(dirname "$0")" && pwd)/lib-tv.sh"
resolve_tv "${1:-}" || exit 2
COUNTRY=${2:-br}

SSH=tv_ssh
FAILED=0
SVC=/media/developer/apps/usr/palm/services/com.tominem.tvpn.service

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

wait_for_tunnel() {
  $SSH 'i=0; while [ $i -lt 30 ]; do ip addr show tun0 2>/dev/null | grep -q "inet " && exit 0; sleep 2; i=$((i+1)); done; exit 1' \
    && pass "tunnel came up" || fail "tunnel came up"
}

connect() {
  case "$(luna connect "{\"country\":\"$COUNTRY\"}" 15)" in
    *'"ok":true'*) pass "connect accepted" ;;
    *) fail "connect accepted" ;;
  esac
  wait_for_tunnel
}

# Only touch the TV's tunnel once this run owns it.
OWNS_TUNNEL=0
cleanup() {
  [ "$OWNS_TUNNEL" = 1 ] || return 0
  luna disconnect '{}' 8 >/dev/null
  # Belt and braces: if the service is wedged the kill switch must still come
  # off, or an aborted test would leave the TV without internet.
  $SSH "$SVC/tvpn-killswitch.sh off; mountpoint -q /etc/resolv.conf && umount /etc/resolv.conf; rm -f /tmp/smoke.out" >/dev/null 2>&1
}

echo "T-VPN smoke test: $TV, server '$COUNTRY'"

echo "Installation"
check "the packaged OpenVPN runs and reports LZO support" \
  "$SVC/openvpn-launch.sh --version 2>&1 | grep -q '\\[LZO\\]'"
check "credentials directory is 700" \
  '[ "$(stat -c %a /media/developer/vpn)" = 700 ]'
check "credentials file is 600" \
  '[ "$(stat -c %a /media/developer/vpn/.auth)" = 600 ]'
check "boot permission script is installed" \
  '[ -x /var/lib/webosbrew/init.d/20-tvpn-perms ]'
check "boot entropy script is installed" \
  '[ -x /var/lib/webosbrew/init.d/10-entropy-seed ]'
check "the entropy pool is seeded" \
  '[ "$(cat /proc/sys/kernel/random/entropy_avail)" -ge 256 ]'
check "app-level Luna permissions are registered" \
  '[ -f /var/luna-service2-dev/client-permissions.d/com.tominem.tvpn.app.json ]'
check "app is known to the application manager" \
  'luna-send -f -n 1 luna://com.webos.applicationManager/getAppInfo "{\"id\":\"com.tominem.tvpn\"}" > /tmp/smoke.out 2>&1 & P=$!; sleep 8; kill $P 2>/dev/null; grep -q "\"returnValue\": true" /tmp/smoke.out'

echo "Service"
before=$(luna status '{}')
case "$before" in
  *'"connected":true'*)
    if [ -z "${SMOKE_TAKE_OVER:-}" ]; then
      echo "  A tunnel is already up: $before"
      echo "  Refusing to run, because the test would disconnect it."
      echo "  Disconnect it yourself, or set SMOKE_TAKE_OVER=1 to let the test do it."
      exit 3
    fi
    OWNS_TUNNEL=1
    trap cleanup EXIT
    luna disconnect '{}' 14 >/dev/null; sleep 4
    pass "took over and disconnected the existing tunnel" ;;
  *'"connected":false'*) OWNS_TUNNEL=1; trap cleanup EXIT; pass "starts disconnected" ;;
  *) OWNS_TUNNEL=1; trap cleanup EXIT; fail "starts disconnected (got: $before)" ;;
esac

echo "Connect"
connect

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

echo "Kill switch is armed"
check "the chain is the first rule in OUTPUT" \
  'iptables -S OUTPUT | grep -m1 "^-A" | grep -q TVPN_KILL'
check "plain DNS is dropped outside the tunnel" \
  'iptables -S TVPN_KILL | grep -q -- "--dport 53 -j DROP"'
check "everything else is dropped last" \
  '[ "$(iptables -S TVPN_KILL | tail -1)" = "-A TVPN_KILL -j DROP" ]'
check "global IPv6 is blackholed (the tunnel carries only IPv4)" \
  'ip -6 route show | grep -q "blackhole 2000::/3"'

echo "OpenVPN does not hold the Luna bus socket"
# The launcher closes inherited descriptors for this reason: a child that
# outlives the service and keeps the bus socket makes the hub believe the
# service name is still registered, and later calls to it hang.
check "no descriptor of the OpenVPN process is a Luna socket" \
  'PID=$(cat /tmp/tvpn-openvpn.pid); leak=0
   for fd in /proc/$PID/fd/*; do
     l=$(readlink "$fd" 2>/dev/null)
     case "$l" in
       "socket:["*) ino=${l#socket:[}; ino=${ino%]}
         if awk -v i="$ino" '"'"'$7==i && $NF ~ /luna|palm|hub/ {f=1} END{exit f?0:1}'"'"' /proc/net/unix; then leak=1; fi ;;
     esac
   done
   [ "$leak" = 0 ]'

echo "Service stays responsive while connected"
case "$(luna status '{}' 14)" in
  *'"returnValue":true'*) pass "status answered with the tunnel up" ;;
  *) fail "status answered with the tunnel up (hub wedged: run ls-control scan-services)" ;;
esac

echo "Disconnect puts everything back"
case "$(luna disconnect '{}' 14)" in
  *'"ok":true'*) pass "disconnect accepted" ;;
  *) fail "disconnect accepted" ;;
esac
sleep 4
check "tunnel is gone" '! ip addr show tun0 2>/dev/null | grep -q "inet "'
check "resolver is restored" \
  '! mountpoint -q /etc/resolv.conf && grep -q "^nameserver 127.0.0.1" /etc/resolv.conf'
check "kill switch is lifted" \
  '! iptables -S | grep -q TVPN_KILL && [ ! -e /tmp/tvpn-killswitch ]'
check "IPv6 is restored" '! ip -6 route show | grep -q "blackhole 2000::/3"'
check "internet works again" 'ping -c 2 -W 5 1.1.1.1'
case "$(luna status '{}' 14)" in
  *'"connected":false'*'"blocked":false'*|*'"blocked":false'*'"connected":false'*) pass "status reports disconnected, not blocked" ;;
  *) fail "status reports disconnected, not blocked (got: $(luna status '{}'))" ;;
esac

if [ -z "${SMOKE_SKIP_CRASH:-}" ]; then
  echo "Kill switch holds when the tunnel dies"
  echo "  (kills OpenVPN on purpose: the TV's internet is cut for a few seconds)"
  connect
  $SSH 'kill -9 "$(cat /tmp/tvpn-openvpn.pid)"' >/dev/null 2>&1
  sleep 4
  check "traffic is blocked, nothing leaks around the dead tunnel" \
    '! ping -c 1 -W 4 1.1.1.1'
  check "the local network still works" \
    'ping -c 1 -W 4 "$(ip route | awk "/^default/ {print \$3; exit}")"'
  case "$(luna status '{}' 14)" in
    *'"blocked":true'*) pass "status says the tunnel is blocked, not simply disconnected" ;;
    *) fail "status says the tunnel is blocked (got: $(luna status '{}'))" ;;
  esac
  case "$(luna disconnect '{}' 14)" in
    *'"ok":true'*) pass "disconnect from a blocked state accepted" ;;
    *) fail "disconnect from a blocked state accepted" ;;
  esac
  sleep 3
  check "internet is back once the user disconnects" 'ping -c 2 -W 5 1.1.1.1'
  check "kill switch is lifted after a blocked state" \
    '! iptables -S | grep -q TVPN_KILL && [ ! -e /tmp/tvpn-killswitch ]'
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$FAILED check(s) failed."
  exit 1
fi
