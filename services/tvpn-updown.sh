#!/bin/sh
# Points the system resolver at the DNS servers the VPN pushes, so lookups
# travel inside the tunnel.
#
# Without this the tunnel leaks DNS: webOS keeps /etc/resolv.conf pointing at
# 127.0.0.1, where connmand proxies to the DHCP nameservers on eth0. Those
# queries leave over eth0 even while the tunnel is up, so the ISP still sees
# every name the TV resolves. Confirmed on device by connmand holding
# established UDP sockets to the router's port 53 with a VPN session active.
#
# The override is a bind mount over /etc/resolv.conf, the same approach the
# Homebrew Channel uses for /etc/hosts, so nothing on disk is rewritten and
# the original file reappears on umount.
#
# OpenVPN runs this as both --up and --down; $script_type says which. Using
# OpenVPN's hooks rather than doing this from the service matters for
# correctness: --up only fires once tun0 is actually configured, and --down
# fires even when the tunnel dies on its own, so DNS is never left pointing
# into a tunnel that no longer exists.
#
# --up also arms the kill switch (tvpn-killswitch.sh), so traffic cannot leak if
# the tunnel later drops. --down deliberately does NOT disarm it: a tunnel that
# dies by itself must leave traffic blocked, and that is the whole point. Only a
# deliberate disconnect (the service) or a reconnect turns it off.
#
# --up also tunes the tunnel for the TV's CPU, see tune_tunnel.
#
# Requires --script-security 2.
# Overridable only so the tests can run this without root or a TV.
RESOLV=${TVPN_RESOLV:-/etc/resolv.conf}
OVERRIDE=${TVPN_OVERRIDE:-/tmp/tvpn-resolv.conf}
KILLSWITCH=${TVPN_KILLSWITCH:-$(cd "$(dirname "$0")" && pwd)/tvpn-killswitch.sh}
# OpenVPN runs this script itself, so its parent is OpenVPN.
OPENVPN_PID=${TVPN_OPENVPN_PID:-$PPID}
NICE=${TVPN_NICE:--10}
TXQUEUELEN=${TVPN_TXQUEUELEN:-2000}

dns_up() {
  # The pushed servers arrive as foreign_option_N="dhcp-option DNS <addr>".
  printf '# T-VPN: pushed by the VPN server, reached through tun0\n' > "$OVERRIDE"
  i=1
  while true; do
    eval "opt=\${foreign_option_$i}"
    [ -z "$opt" ] && break
    # shellcheck disable=SC2086
    set -- $opt
    if [ "$1" = "dhcp-option" ] && [ "$2" = "DNS" ] && [ -n "$3" ]; then
      printf 'nameserver %s\n' "$3" >> "$OVERRIDE"
    fi
    i=$((i + 1))
  done

  # Nothing pushed means there is nothing better to point at: leave the
  # system resolver alone rather than breaking name resolution outright. This
  # is a return, not an exit: the kill switch below must still be armed.
  grep -q '^nameserver ' "$OVERRIDE" || return 0

  mountpoint -q "$RESOLV" || mount --bind "$OVERRIDE" "$RESOLV"
}

dns_down() {
  mountpoint -q "$RESOLV" && umount "$RESOLV"
}

# OpenVPN encrypts every packet in user space, on a TV whose CPU is shared with
# the apps in front of it. At normal priority it loses that CPU: it cannot drain
# the tunnel's transmit queue (qlen 500 by default), the queue overflows and
# drops packets, ACKs among them, and live streams stall. Measured on device
# with a stream running: thousands of dropped packets on tun0 within seconds.
# Raising OpenVPN's priority and lengthening the queue stops that. Neither is
# worth tearing the tunnel down over, so a failure only warns.
tune_tunnel() {
  renice -n "$NICE" -p "$OPENVPN_PID" >/dev/null 2>&1 \
    || echo "tvpn-updown: could not raise the priority of OpenVPN" >&2
  ip link set dev "${dev:-tun0}" txqueuelen "$TXQUEUELEN" >/dev/null 2>&1 \
    || echo "tvpn-updown: could not lengthen the tunnel's transmit queue" >&2
}

case "$script_type" in
  up)
    dns_up
    # trusted_ip is the server OpenVPN actually connected to. Without it the
    # chain could not let the handshake through, so do not arm blind.
    if [ -n "$trusted_ip" ]; then
      "$KILLSWITCH" on "$trusted_ip" \
        || echo "tvpn-updown: kill switch could not be armed; traffic will leak if the tunnel drops" >&2
    fi
    tune_tunnel
    ;;
  down)
    dns_down
    ;;
esac

exit 0
