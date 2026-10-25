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
# Requires --script-security 2.
# Overridable only so the tests can run this without root or a TV.
RESOLV=${TVPN_RESOLV:-/etc/resolv.conf}
OVERRIDE=${TVPN_OVERRIDE:-/tmp/tvpn-resolv.conf}

case "$script_type" in
  up)
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
    # system resolver alone rather than breaking name resolution outright.
    grep -q '^nameserver ' "$OVERRIDE" || exit 0

    mountpoint -q "$RESOLV" || mount --bind "$OVERRIDE" "$RESOLV"
    ;;
  down)
    mountpoint -q "$RESOLV" && umount "$RESOLV"
    ;;
esac

exit 0
