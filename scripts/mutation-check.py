"""
Mutation check: reintroduce each bug that was fixed on device and confirm the
test suite fails. A suite that stays green with a known bug put back is not
protecting anything.

    python3 scripts/mutation-check.py             run every mutation
    python3 scripts/mutation-check.py --restore   put files back after an interrupted run

Exits non-zero if any mutation survives or any anchor no longer matches (an
anchor that stops matching means the code moved and the mutation silently
tests nothing, so it is reported rather than skipped).

A mutated file on disk is the danger here, so this is built to be interrupted:
- each original is saved to build/mutation-backup/ BEFORE it is touched, in a
  fixed place, never a random temp directory nobody can find afterwards
- SIGINT, SIGTERM and SIGHUP all restore before exiting. A process started in
  the background inherits SIGINT as ignored, which silently disables Python's
  own handling, so the handlers are installed explicitly
- if a run was killed outright (SIGKILL, power loss) the saved originals are
  still there, and the next run refuses to start until --restore puts them back

Each mutation runs only the test files likely to catch it first; if they all
pass, the whole suite decides, so "survived" always means the full suite.
"""
import os
import shutil
import signal
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP = os.path.join(REPO, 'build', 'mutation-backup')

FRONTEND_TESTS = ['tests/frontend.test.js', 'tests/compat.test.js']
SERVICE_TESTS = ['tests/vpn.test.js', 'tests/autoconnect.test.js', 'tests/service.test.js', 'tests/compat.test.js']
SHELL_TESTS = ['tests/scripts.test.js']
PACKAGING_TESTS = ['tests/packaging.test.js']

# First match wins, so the specific entries come before the general ones.
DEFAULT_TESTS = [
    ('frontend/', FRONTEND_TESTS),
    ('services/vpn.js', SERVICE_TESTS),
    ('services/index.js', ['tests/service.test.js', 'tests/compat.test.js']),
    ('services/', SHELL_TESTS),
    ('scripts/build-ipk.sh', PACKAGING_TESTS),
    ('scripts/fetch-openvpn-runtime.sh', PACKAGING_TESTS),
    ('scripts/install-on-', PACKAGING_TESTS),
    ('scripts/10-entropy-seed', PACKAGING_TESTS),
    ('scripts/', SHELL_TESTS),
]


def tests_for(rel):
    for prefix, tests in DEFAULT_TESTS:
        if rel.startswith(prefix):
            return tests
    return None


# (name, file, old, new)  -- old must occur exactly once
MUTATIONS = [
    ('binding-less catch (killed the whole UI on Chrome 53)',
     'frontend/main.js',
     "  } catch (err) {\n    // WAM here is Chrome 53",
     "  } catch {\n    // WAM here is Chrome 53"),

    ('use webOS.service global (undefined on device)',
     'frontend/main.js',
     "    bridge.call(SERVICE + method, JSON.stringify(params || {}));",
     "    webOS.service.request(SERVICE + method, {});"),

    ('flag as emoji (BR/NL/AR drew nothing)',
     'frontend/main.js',
     "btn.innerHTML = flagSvg(code) + '<span>' + label + '</span>';",
     "btn.innerHTML = '\\uD83C\\uDDE7\\uD83C\\uDDF7 <span>' + label + '</span>';"),

    ('flexbox gap (inert on Chrome 53)',
     'frontend/styles.css',
     "  margin: -12px;\n}",
     "  margin: -12px;\n  gap: 24px;\n}"),

    ('no initial focus',
     'frontend/main.js',
     "keepFocusAlive();\n\nrefreshStatus();",
     "refreshStatus();"),

    ('focus lost when grid is disabled',
     'frontend/main.js',
     "  });\n\n  keepFocusAlive();\n}",
     "  });\n}"),

    ('row wraps sideways instead of stopping',
     'frontend/main.js',
     "    if (horizontal && overlap <= 0) return;\n",
     ""),

    ('OK handled natively too (double connect)',
     'frontend/main.js',
     "      event.preventDefault();\n      target.click();",
     "      target.click();"),

    ('OK not handled at all',
     'frontend/main.js',
     "      event.preventDefault();\n      target.click();",
     "      void target;"),

    ('no call timeout (UI hangs forever)',
     'frontend/main.js',
     "const CALL_TIMEOUT_MS = 20000;",
     "const CALL_TIMEOUT_MS = 2000000000;"),

    ('connected tunnel with no country crashes the badge',
     'frontend/main.js',
     "'Connected' + (activeCountry ? ` \u00b7 ${activeCountry.toUpperCase()}` : '')",
     "'Connected' + ` \u00b7 ${country.toUpperCase()}`"),

    ('service state only in memory (status always disconnected)',
     'services/vpn.js',
     "    pid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);",
     "    pid = NaN;"),

    ('LD_PRELOAD inherited by openvpn',
     'services/vpn.js',
     "    if (k !== 'LD_PRELOAD') env[k] = process.env[k];",
     "    env[k] = process.env[k];"),

    ('openvpn not daemonised',
     'services/vpn.js',
     "  '--daemon',\n];",
     "];"),

    ('DNS hooks missing from connect()',
     'services/vpn.js',
     "  '--up', HOOK_SCRIPT,\n  '--down', HOOK_SCRIPT,\n",
     ""),

    ('boot runner drops the country record',
     'services/vpn.js',
     "    '  fs.writeFileSync(\\'' + STATE_PATH",
     "    '  void (\\'' + STATE_PATH"),

    ('stale resolver override never cleaned',
     'services/vpn.js',
     "    if (fs.existsSync(PID_PATH)) this._clearState(blocked);",
     "",
     ['tests/vpn.test.js']),

    ('dns script stacks mounts',
     'services/tvpn-updown.sh',
     '  mountpoint -q "$RESOLV" || mount --bind "$OVERRIDE" "$RESOLV"',
     '  mount --bind "$OVERRIDE" "$RESOLV"',
     ['tests/scripts.test.js']),

    ('dns script mounts even with no DNS pushed',
     'services/tvpn-updown.sh',
     "  grep -q '^nameserver ' \"$OVERRIDE\" || return 0\n",
     "",
     ['tests/scripts.test.js']),

    ('dns down never unmounts',
     'services/tvpn-updown.sh',
     '  mountpoint -q "$RESOLV" && umount "$RESOLV"',
     '  true',
     ['tests/scripts.test.js']),

    ('perms script skips .ovpn files',
     'scripts/20-tvpn-perms',
     '  [ -f "$f" ] && chmod 600 "$f"',
     '  true'),

    ('perms script leaves dir open',
     'scripts/20-tvpn-perms',
     'chmod 700 "$VPN_DIR"',
     'true'),

    ('registration omits the app-level permission file',
     'scripts/install-luna-registration.sh',
     """printf '{"%s-*":["public","%s.group"]}' "$APP" "$SVC" > "$D/client-permissions.d/$APP.app.json\"""",
     "true"),

    ('registration never rescans',
     'scripts/install-luna-registration.sh',
     '"$LS_CONTROL" scan-services\n',
     'true\n'),

    ('launcher keeps LD_PRELOAD',
     'services/openvpn-launch.sh',
     "unset LD_PRELOAD\n",
     ""),

    # ── kill switch: the shell script ─────────────────────────────────────────
    ('killswitch: plain DNS no longer dropped (names leak to the router)',
     'services/tvpn-killswitch.sh',
     '  iptables -A "$CHAIN" -p udp --dport 53 -j DROP || return 1\n', '',
     ['tests/scripts.test.js']),
    ('killswitch: no final DROP (arming blocks nothing)',
     'services/tvpn-killswitch.sh',
     '  iptables -A "$CHAIN" -j DROP || return 1\n', '',
     ['tests/scripts.test.js']),
    ('killswitch: the VPN server is not let through (cannot reconnect)',
     'services/tvpn-killswitch.sh',
     '  iptables -A "$CHAIN" -d "$server" -j ACCEPT || return 1\n', '',
     ['tests/scripts.test.js']),
    ('killswitch: the tunnel itself is blocked',
     'services/tvpn-killswitch.sh',
     "  iptables -A \"$CHAIN\" -o 'tun+' -j ACCEPT || return 1\n", '',
     ['tests/scripts.test.js']),
    ('killswitch: chain hooked in at the end of OUTPUT, after the allow rules',
     'services/tvpn-killswitch.sh',
     'iptables -I OUTPUT 1 -j "$CHAIN"', 'iptables -A OUTPUT -j "$CHAIN"',
     ['tests/scripts.test.js']),
    ('killswitch: IPv6 left open (bypasses the tunnel)',
     'services/tvpn-killswitch.sh',
     '  ip -6 route replace blackhole "$V6_BLACKHOLE" 2>/dev/null\n', '',
     ['tests/scripts.test.js']),
    ('killswitch: IPv6 blackhole survives disarming',
     'services/tvpn-killswitch.sh',
     '  ip -6 route del blackhole "$V6_BLACKHOLE" 2>/dev/null\n', '',
     ['tests/scripts.test.js']),
    ('killswitch: armed state never recorded',
     'services/tvpn-killswitch.sh',
     "  printf '%s\\n' \"$server\" > \"$MARKER\"\n", '',
     ['tests/scripts.test.js']),
    ('killswitch: a half-built chain is left in place on failure',
     'services/tvpn-killswitch.sh',
     "could not arm; disarming rather than leaving a half-built chain\" >&2; disarm; exit 1;",
     "could not arm; disarming rather than leaving a half-built chain\" >&2; exit 1;",
     ['tests/scripts.test.js']),
    ('killswitch: only one hook removed on disarm (an interrupted run leaves the other)',
     'services/tvpn-killswitch.sh',
     '  while iptables -C OUTPUT -j "$CHAIN" 2>/dev/null; do', '  if iptables -C OUTPUT -j "$CHAIN" 2>/dev/null; then',
     ['tests/scripts.test.js']),
    ('killswitch: re-arming stacks duplicate rules',
     'services/tvpn-killswitch.sh',
     '  iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN" || return 1\n',
     '  iptables -N "$CHAIN" 2>/dev/null\n',
     ['tests/scripts.test.js']),

    # ── kill switch: the OpenVPN hook ─────────────────────────────────────────
    ('hook: --down disarms the kill switch (a dying tunnel would reopen the leak)',
     'services/tvpn-updown.sh',
     '  down)\n    dns_down\n', '  down)\n    dns_down\n    "$KILLSWITCH" off\n',
     ['tests/scripts.test.js']),
    ('hook: no DNS pushed exits the whole script, skipping the kill switch',
     'services/tvpn-updown.sh',
     "grep -q '^nameserver ' \"$OVERRIDE\" || return 0", "grep -q '^nameserver ' \"$OVERRIDE\" || exit 0",
     ['tests/scripts.test.js']),
    ('hook: arms without knowing which server to let through',
     'services/tvpn-updown.sh',
     '    if [ -n "$trusted_ip" ]; then', '    if true; then',
     ['tests/scripts.test.js']),
    ('hook: a failed arming is silent',
     'services/tvpn-updown.sh',
     '        || echo "tvpn-updown: kill switch could not be armed; traffic will leak if the tunnel drops" >&2',
     '        || true',
     ['tests/scripts.test.js']),

    # ── kill switch: the service ──────────────────────────────────────────────
    ('vpn.js: disconnect never lifts the kill switch (user stays offline)',
     'services/vpn.js',
     "  this._clearState();\n  return this._killSwitchOff()\n    ? { ok: true }\n    : { ok: false, error: 'Disconnected,",
     "  this._clearState();\n  return true\n    ? { ok: true }\n    : { ok: false, error: 'Disconnected,",
     ['tests/vpn.test.js']),
    ('vpn.js: reconnect while blocked does not lift the switch first',
     'services/vpn.js',
     '  if (this._isBlocked() && !this._killSwitchOff()) {', '  if (false) {',
     ['tests/vpn.test.js']),
    ('vpn.js: a dead tunnel with the switch armed is not reported as blocked',
     'services/vpn.js',
     '    var blocked = this._isBlocked();', '    var blocked = false;',
     ['tests/vpn.test.js']),
    ('vpn.js: the country is lost while blocked',
     'services/vpn.js',
     'this._clearState(blocked);', 'this._clearState(false);',
     ['tests/vpn.test.js']),
    ('vpn.js: lifting the switch can hang the service forever',
     'services/vpn.js',
     "stdio: 'ignore', timeout: 10000 }", "stdio: 'ignore' }",
     ['tests/vpn.test.js']),
    ('vpn.js: a failed lift is reported as success',
     'services/vpn.js',
     '    return !!result && result.status === 0;', '    return true;',
     ['tests/vpn.test.js']),

    # ── kill switch: the screen ───────────────────────────────────────────────
    ('frontend: Disconnect disabled while blocked (no way to get internet back)',
     'frontend/main.js',
     '  btnDisconnect.disabled = !(connected || blocked);', '  btnDisconnect.disabled = !connected;',
     ['tests/frontend.test.js']),
    ('frontend: the blocked warning never clears',
     'frontend/main.js',
     "    if (messageEl.textContent === BLOCKED_TEXT) setMessage('');\n", '',
     ['tests/frontend.test.js']),
    ('frontend: status checks overlap themselves',
     'frontend/main.js',
     '  if (busy || polling) return;', '  if (busy) return;',
     ['tests/frontend.test.js']),
    ('frontend: status checks run over an action in progress',
     'frontend/main.js',
     '  if (busy || polling) return;', '  if (polling) return;',
     ['tests/frontend.test.js']),
    ('frontend: a late status answer redraws over a newer action',
     'frontend/main.js',
     '    if (!busy) applyStatus(status);', '    applyStatus(status);',
     ['tests/frontend.test.js']),

    # ── packaging ─────────────────────────────────────────────────────────────
    ('build: minification left on (shipped code differs from tested code)',
     'scripts/build-ipk.sh',
     '"$ares" --no-minify -o', '"$ares" -o',
     ['tests/packaging.test.js']),
    ('build: no check that the package matches what was staged',
     'scripts/build-ipk.sh',
     '    cmp -s "$1/$rel" "$2/$rel" ||', '    true ||',
     ['tests/packaging.test.js']),
    ('build: credentials are not scanned for',
     'scripts/build-ipk.sh',
     "-name '.auth' -o ", "-name '.auth-never' -o ",
     ['tests/packaging.test.js']),
    ('build: private keys are not scanned for',
     'scripts/build-ipk.sh',
     "if grep -rIlE 'PrivateKey|PRIVATE KEY' \"$STAGE\" >/dev/null 2>&1; then",
     'if false; then',
     ['tests/packaging.test.js']),
    ('fetch: package hashes are not verified',
     'scripts/fetch-openvpn-runtime.sh',
     '  if [ "$got" != "$want" ]; then', '  if false; then',
     ['tests/packaging.test.js']),
    ('fetch: a bad download stays in the cache for the next run to trust',
     'scripts/fetch-openvpn-runtime.sh',
     '    rm -f "$file"   # never leave a bad file where the next run would trust it\n', '',
     ['tests/packaging.test.js']),
    ('fetch: a non-ARM binary is accepted',
     'scripts/fetch-openvpn-runtime.sh',
     "file \"$OUT/bin/openvpn\" | grep -q 'ARM' ||", 'true ||',
     ['tests/packaging.test.js']),
    ('install-on-device: credentials directory left world-accessible',
     'scripts/install-on-device.sh',
     'chmod 700 "$VPN_DIR"', 'true',
     ['tests/packaging.test.js']),
    ('install-on-device: configs left world-readable',
     'scripts/install-on-device.sh',
     '  chmod 600 "$VPN_DIR/$(basename "$f")"\n', '',
     ['tests/packaging.test.js']),
    ('install-on-device: boot scripts not made executable',
     'scripts/install-on-device.sh',
     '  chmod 755 "$INITD/$name"\n', '',
     ['tests/packaging.test.js']),
    ('install-on-tv: relaunches the app, interrupting what the TV is showing',
     'scripts/install-on-tv.sh',
     'tv_ssh "rm -f \'$REMOTE_IPK\' /tmp/tvpn-install.rc" 2>/dev/null || true',
     'tv_ssh "luna-send -n 1 luna://com.webos.applicationManager/launch \'{}\'; rm -f \'$REMOTE_IPK\' /tmp/tvpn-install.rc" 2>/dev/null || true',
     ['tests/packaging.test.js']),
    ('install-on-tv: credentials passed on the command line',
     'scripts/install-on-tv.sh',
     "  tv_ssh 'umask 077; cat > /media/developer/vpn/.auth && chmod 600 /media/developer/vpn/.auth' < \"$AUTH_FILE\" \\",
     "  tv_ssh \"umask 077; echo $(cat \"$AUTH_FILE\") > /media/developer/vpn/.auth && chmod 600 /media/developer/vpn/.auth\" \\",
     ['tests/packaging.test.js']),
    ('entropy: a second seeder is started when one is already running',
     'scripts/10-entropy-seed',
     'if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then', 'if false; then',
     ['tests/packaging.test.js']),
]


def run_suite(tests=None):
    res = subprocess.run(
        ['npx', 'jest', '--silent', '--coverage=false'] + list(tests or []),
        cwd=REPO, capture_output=True, text=True, timeout=900,
    )
    return res.returncode, res.stdout + res.stderr


def saved_originals():
    return sorted(os.listdir(BACKUP)) if os.path.isdir(BACKUP) else []


def restore_saved():
    """Put back every original a previous run saved. Returns the files restored."""
    restored = []
    for name in saved_originals():
        rel = name.replace('__', '/')
        shutil.copy2(os.path.join(BACKUP, name), os.path.join(REPO, rel))
        os.remove(os.path.join(BACKUP, name))
        restored.append(rel)
    return restored


def _interrupt(signum, frame):
    raise KeyboardInterrupt()


def run_mutations():
    survivors, caught, bad_anchor = [], [], []

    code, _ = run_suite()
    if code != 0:
        print('BASELINE IS RED - fix before mutating')
        return 2

    os.makedirs(BACKUP, exist_ok=True)
    for mutation in MUTATIONS:
        name, rel, old, new = mutation[:4]
        tests = mutation[4] if len(mutation) > 4 else tests_for(rel)
        path = os.path.join(REPO, rel)
        backup = os.path.join(BACKUP, rel.replace('/', '__'))
        shutil.copy2(path, backup)          # saved BEFORE anything is changed
        try:
            src = open(path).read()
            if src.count(old) != 1:
                bad_anchor.append((name, src.count(old)))
                continue
            open(path, 'w').write(src.replace(old, new, 1))
            code, out = run_suite(tests)
            if code == 0 and tests:
                code, out = run_suite()
            (caught if code != 0 else survivors).append(name)
            print(('CAUGHT   ' if code != 0 else 'SURVIVED ') + name, flush=True)
        finally:
            shutil.copy2(backup, path)
            os.remove(backup)

    code, _ = run_suite()
    print('\n--- restored; baseline green again: %s' % (code == 0))
    print('caught %d / %d' % (len(caught), len(MUTATIONS) - len(bad_anchor)))
    for n, c in bad_anchor:
        print('BAD ANCHOR (%d matches): %s' % (c, n))
    for n in survivors:
        print('SURVIVOR: ' + n)
    return 1 if (survivors or bad_anchor) else 0


def main():
    if '--restore' in sys.argv:
        files = restore_saved()
        print('restored: %s' % (', '.join(files) if files else 'nothing to restore'))
        return 0

    left = saved_originals()
    if left:
        print('A previous run was interrupted and left saved originals in build/mutation-backup/:')
        for name in left:
            print('  ' + name.replace('__', '/'))
        print('Those files may currently contain a mutation. Run:')
        print('  python3 scripts/mutation-check.py --restore')
        return 2

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, _interrupt)
    try:
        return run_mutations()
    except KeyboardInterrupt:
        print('\ninterrupted: originals restored')
        return 130


if __name__ == '__main__':
    sys.exit(main())
