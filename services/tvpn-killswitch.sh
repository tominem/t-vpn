#!/bin/sh
# Kill switch: keeps the TV's traffic from leaking if the VPN drops.
#
#   tvpn-killswitch.sh on <server-ip>    arm
#   tvpn-killswitch.sh off               disarm
#
# While armed, anything leaving the TV must go through the tunnel. What is
# still allowed besides tun+ is exactly what keeps the TV usable and the VPN
# able to reconnect:
#
#   - loopback
#   - the VPN server itself (so OpenVPN can finish, or redo, its handshake)
#   - the local network: RFC 1918 ranges, link-local, multicast and broadcast
#     (the router, DHCP renewals, mDNS, SSDP; and ssh from the Mac)
#
# Plain DNS to anywhere else is dropped before the LAN rules. Without that, once
# the tunnel is gone connmand would still ask the router, and the names the TV
# looks up would leak even though the connections themselves are blocked.
#
# IPv6 is not filtered because this kernel has no ip6tables. The tunnel carries
# only IPv4, so global IPv6 would bypass it entirely; a blackhole route for
# 2000::/3 closes that without needing a firewall. Link-local and ULA addresses
# are untouched, so LAN features keep working.
#
# The marker file records that the switch is armed. The service reads it to
# tell "never connected" from "tunnel died, traffic is blocked on purpose".
#
# Nothing here is persistent: iptables rules and the route vanish on reboot, so
# a reboot always leaves the TV online (it fails open at boot, then the
# auto-connect, if enabled, arms it again once the tunnel is up).
#
# TVPN_KILL_MARKER only exists so the tests can run this without root.
CHAIN=TVPN_KILL
MARKER=${TVPN_KILL_MARKER:-/tmp/tvpn-killswitch}
V6_BLACKHOLE=2000::/3

disarm() {
  # The jump may have been added more than once by an interrupted run.
  while iptables -C OUTPUT -j "$CHAIN" 2>/dev/null; do
    iptables -D OUTPUT -j "$CHAIN" 2>/dev/null || break
  done
  iptables -F "$CHAIN" 2>/dev/null
  iptables -X "$CHAIN" 2>/dev/null
  ip -6 route del blackhole "$V6_BLACKHOLE" 2>/dev/null
  rm -f "$MARKER"
}

arm() {
  server=$1
  command -v iptables >/dev/null 2>&1 || { echo "tvpn-killswitch: iptables not found" >&2; return 1; }

  # Start from a clean chain so re-arming never stacks duplicate rules.
  iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN" || return 1

  iptables -A "$CHAIN" -o lo -j ACCEPT || return 1
  iptables -A "$CHAIN" -o 'tun+' -j ACCEPT || return 1
  iptables -A "$CHAIN" -p udp --dport 53 -j DROP || return 1
  iptables -A "$CHAIN" -p tcp --dport 53 -j DROP || return 1
  iptables -A "$CHAIN" -d "$server" -j ACCEPT || return 1
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 224.0.0.0/4 255.255.255.255; do
    iptables -A "$CHAIN" -d "$net" -j ACCEPT || return 1
  done
  iptables -A "$CHAIN" -j DROP || return 1

  # Only now put the chain in the path, so a half-built chain never blocks anything.
  iptables -C OUTPUT -j "$CHAIN" 2>/dev/null || iptables -I OUTPUT 1 -j "$CHAIN" || return 1

  ip -6 route replace blackhole "$V6_BLACKHOLE" 2>/dev/null

  printf '%s\n' "$server" > "$MARKER"
}

case "$1" in
  on)
    [ -n "$2" ] || { echo "usage: tvpn-killswitch.sh on <server-ip>" >&2; exit 2; }
    arm "$2" || { echo "tvpn-killswitch: could not arm; disarming rather than leaving a half-built chain" >&2; disarm; exit 1; }
    ;;
  off)
    disarm
    ;;
  *)
    echo "usage: tvpn-killswitch.sh on <server-ip> | off" >&2
    exit 2
    ;;
esac

exit 0
