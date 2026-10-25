#!/bin/sh
# Launches OpenVPN for the T-VPN Luna service. Two things must happen before
# exec, both of which fail silently if skipped:
#
#  - LD_PRELOAD must be dropped. webOS starts Luna services with
#    LD_PRELOAD=/usr/lib/libsystrim.so.3, a glibc library. The musl-linked
#    OpenVPN then aborts with "Error relocating /usr/lib/libsystrim.so.3:
#    __register_atfork: symbol not found" before it can open its log.
#
#  - Every inherited descriptor above stderr must be closed. The service's
#    Luna bus socket is among them. OpenVPN outlives the service, so holding
#    that socket keeps the hub believing the service name is still registered,
#    and every later call to the service goes unanswered until the hub is
#    rescanned. The Homebrew Channel startup script closes fds for the same
#    reason.
unset LD_PRELOAD

for fd in $(ls /proc/$$/fd 2>/dev/null); do
  case "$fd" in
    0 | 1 | 2) ;;
    *) eval "exec ${fd}>&-" 2>/dev/null ;;
  esac
done

# The OpenVPN runtime (musl loader, libraries, binary) is packaged beside this
# script, so the service directory is self-contained. TVPN_OVPN_DIR exists only
# so the tests can point this at a stand-in loader.
DIR=${TVPN_OVPN_DIR:-$(cd "$(dirname "$0")" && pwd)/ovpn-runtime}
exec "$DIR/lib/ld-musl-armhf.so.1" --library-path "$DIR/lib" "$DIR/bin/openvpn" "$@"
