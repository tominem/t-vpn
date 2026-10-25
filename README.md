# T-VPN

A VPN manager for a rooted LG webOS TV (webOS 5.x, ARMv7). The app picks a
country; a Luna service starts OpenVPN with a NordVPN configuration, routes
DNS through the tunnel and arms a kill switch.

## How it works

- `frontend/` is the app (Chrome 53, remote-control navigation, SVG flags).
- `services/` is the Luna service (Node 0.12, ES5): `connect`, `disconnect`,
  `status`, `setAutoConnect`, `getAutoConnect`.
- OpenVPN 2.6 comes from Alpine's armv7 packages (musl, with LZO). It is
  fetched and pinned by SHA-256 in `packaging/openvpn-runtime.lock`, and
  started by `openvpn-launch.sh`.
- `tvpn-updown.sh` runs on tunnel up/down: it points `/etc/resolv.conf` at the
  VPN's DNS and arms the kill switch.
- `tvpn-killswitch.sh` leaves only loopback, the tunnel, the VPN server and the
  local network reachable. If the tunnel dies, traffic stays blocked until the
  user disconnects. It is not persistent, so a reboot always restores the
  network. IPv6 is handled with a blackhole route because the kernel has no
  ip6tables.

## Credentials

Use NordVPN **service credentials**, not the account password. They live in
`/media/developer/vpn/.auth` on the TV (mode 600, directory 700) and are never
part of the package. Never commit `.auth`, `config.json` or anything under
`wireguard/`.

## Develop

```sh
npm install
npm test        # jest, enforces 100% coverage
npm run lint
python3 scripts/mutation-check.py   # slow (~45 min); do not edit files meanwhile
python3 scripts/mutation-check.py --restore   # after an interrupted run
```

## Build and install

```sh
scripts/build-ipk.sh                       # fetches the runtime, writes build/*.ipk
scripts/install-on-tv.sh [tv-host] [--auth-file FILE]
scripts/smoke-test.sh [tv-host] [country]  # needs the TV; see the script header
```

The TV's address comes from DHCP, so it is never stored here: pass it as an
argument, set `TV_HOST`, or keep it in `~/.config/webos-tv/tv.env`.

The installer never launches or closes the app. The smoke test refuses to run
over a tunnel that is already up unless `SMOKE_TAKE_OVER=1`, and
`SMOKE_SKIP_CRASH=1` skips the phase that kills OpenVPN on purpose.
