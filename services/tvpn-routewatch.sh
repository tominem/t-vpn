#!/bin/sh
# Keeps the route to the VPN server on the physical network.
#
#   tvpn-routewatch.sh check <server-ip>                one pass
#   tvpn-routewatch.sh run <server-ip> <openvpn-pid>    pass after pass, until
#                                                       OpenVPN exits or the kill
#                                                       switch is disarmed
#
# OpenVPN reaches its server through a host route over the physical network;
# every other destination goes into the tunnel (redirect-gateway def1). When the
# TV's address changes (the router hands out another one) the kernel drops the
# routes tied to the old address, host route included. OpenVPN then times out,
# restarts, and sends its handshake into its own tunnel: "TLS key negotiation
# failed" every minute, forever, while tun0 stays up and swallows all traffic.
# It only puts the route back after a handshake, which can no longer happen.
#
# This puts the route back whenever the server is being reached through the
# tunnel. It changes nothing while the route is right.
#
# TVPN_KILL_MARKER, like the interval, only exists so the tests can run this
# without root or a TV.
MARKER=${TVPN_KILL_MARKER:-/tmp/tvpn-killswitch}
INTERVAL=${TVPN_ROUTEWATCH_INTERVAL:-10}

# Prints "<gateway> <device>" of the default route that does not enter a tunnel.
physical_default() {
  ip route show default 2>/dev/null | awk '
    $1 == "default" {
      gw = ""; dev = ""
      for (i = 2; i < NF; i++) {
        if ($i == "via") gw = $(i + 1)
        if ($i == "dev") dev = $(i + 1)
      }
      if (gw != "" && dev != "" && dev !~ /^tun/) { print gw, dev; exit }
    }'
}

check() {
  server=$1
  case "$(ip route get "$server" 2>/dev/null | head -n 1)" in
    *" dev tun"*) ;;
    *) return 0 ;;
  esac
  # No physical default yet (the link is still coming back): try again next pass.
  set -- $(physical_default)
  [ -n "$2" ] || return 0
  if ip route replace "$server/32" via "$1" dev "$2" 2>/dev/null; then
    echo "tvpn-routewatch: put the route to the VPN server back via $1 on $2" >&2
  fi
}

run() {
  server=$1
  pid=$2
  while kill -0 "$pid" 2>/dev/null && [ -e "$MARKER" ]; do
    check "$server"
    sleep "$INTERVAL"
  done
}

case "$1" in
  check)
    [ -n "$2" ] || { echo "usage: tvpn-routewatch.sh check <server-ip>" >&2; exit 2; }
    check "$2"
    ;;
  run)
    [ -n "$2" ] && [ -n "$3" ] || { echo "usage: tvpn-routewatch.sh run <server-ip> <openvpn-pid>" >&2; exit 2; }
    run "$2" "$3"
    ;;
  *)
    echo "usage: tvpn-routewatch.sh check <server-ip> | run <server-ip> <openvpn-pid>" >&2
    exit 2
    ;;
esac

exit 0
