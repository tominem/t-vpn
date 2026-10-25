#!/bin/sh
# Assembles the OpenVPN runtime that ships inside the IPK.
#
# Stock static OpenVPN builds are compiled without compression framing, and
# NordVPN pushes "comp-lzo no": such a binary finishes the handshake and brings
# the tunnel up but carries no traffic. Alpine's OpenVPN 2.6 is built with LZO
# and LZ4, and being musl-linked it runs on the TV from its own loader. This
# script downloads the exact Alpine packages pinned in
# packaging/openvpn-runtime.lock, refuses any whose SHA-256 differs, and lays
# out:
#
#   <out>/bin/openvpn
#   <out>/lib/{ld-musl-armhf.so.1,libcrypto.so.3,libssl.so.3,
#              libcap-ng.so.0,liblz4.so.1,liblzo2.so.2}
#
# The result is build output, never committed: it is somebody else's binary,
# fetched by hash rather than vendored.
#
# Overrides (the tests use them): ALPINE_MIRROR, TVPN_RUNTIME_LOCK,
# TVPN_RUNTIME_OUT, TVPN_RUNTIME_CACHE.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MIRROR=${ALPINE_MIRROR:-https://dl-cdn.alpinelinux.org/alpine/v3.19/main/armv7}
LOCK=${TVPN_RUNTIME_LOCK:-$ROOT/packaging/openvpn-runtime.lock}
OUT=${TVPN_RUNTIME_OUT:-$ROOT/build/ovpn-runtime}
CACHE=${TVPN_RUNTIME_CACHE:-$ROOT/build/cache}

die() { echo "fetch-openvpn-runtime: $*" >&2; exit 1; }

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

[ -f "$LOCK" ] || die "lock file not found: $LOCK"
mkdir -p "$CACHE"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

count=0
while read -r want name; do
  case "$want" in ''|'#'*) continue ;; esac
  [ -n "$name" ] || die "malformed lock line (expected '<sha256>  <file>'): $want"

  file="$CACHE/$name"
  if [ ! -f "$file" ]; then
    echo "downloading $name"
    curl -fsS -o "$file.part" "$MIRROR/$name" || { rm -f "$file.part"; die "download failed: $MIRROR/$name"; }
    mv "$file.part" "$file"
  fi

  got=$(sha256 "$file")
  if [ "$got" != "$want" ]; then
    rm -f "$file"   # never leave a bad file where the next run would trust it
    die "SHA-256 mismatch for $name
  pinned:   $want
  received: $got
Refusing to use it. If the package was legitimately replaced, re-test it on the TV and update the pin."
  fi

  tar -xzf "$file" -C "$work" 2>/dev/null || die "cannot unpack $name"
  count=$((count + 1))
done < "$LOCK"

[ "$count" -gt 0 ] || die "lock file lists no packages: $LOCK"

# Locate each piece in the unpacked packages. Missing pieces mean the pinned
# packages are not what this script expects, which must stop the build.
pick() {
  for candidate in "$@"; do
    if [ -f "$work/$candidate" ]; then echo "$work/$candidate"; return 0; fi
  done
  return 1
}
need() {  # need <destination> <candidate path>...
  dest=$1; shift
  src=$(pick "$@") || die "expected one of [$*] in the pinned packages, found none"
  [ -s "$src" ] || die "$src is empty"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
}

rm -rf "$OUT"
need "$OUT/bin/openvpn"                usr/sbin/openvpn
need "$OUT/lib/ld-musl-armhf.so.1"     lib/ld-musl-armhf.so.1
need "$OUT/lib/libcrypto.so.3"         lib/libcrypto.so.3 usr/lib/libcrypto.so.3
need "$OUT/lib/libssl.so.3"            lib/libssl.so.3 usr/lib/libssl.so.3
need "$OUT/lib/libcap-ng.so.0"         usr/lib/libcap-ng.so.0.0.0 usr/lib/libcap-ng.so.0
need "$OUT/lib/liblz4.so.1"            usr/lib/liblz4.so.1.9.4 usr/lib/liblz4.so.1
need "$OUT/lib/liblzo2.so.2"           usr/lib/liblzo2.so.2.0.0 usr/lib/liblzo2.so.2
chmod 755 "$OUT/bin/openvpn" "$OUT/lib/ld-musl-armhf.so.1"

# The TV is 32-bit ARM; a host-arch binary here would fail only on the device.
if command -v file >/dev/null 2>&1; then
  file "$OUT/bin/openvpn" | grep -q 'ARM' || die "bin/openvpn is not an ARM binary: $(file "$OUT/bin/openvpn")"
fi

echo "openvpn runtime assembled from $count pinned packages: $OUT"
