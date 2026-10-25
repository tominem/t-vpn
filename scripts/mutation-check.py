"""
Mutation check: reintroduce each bug that was fixed on device and confirm the
test suite fails. A suite that stays green with a known bug put back is not
protecting anything.

    python3 scripts/mutation-check.py                 every mutation (before a release)
    python3 scripts/mutation-check.py --changed       only mutations touching files that
                                                      differ from origin/main (or HEAD)
    python3 scripts/mutation-check.py --changed REF   ... differing from REF
    python3 scripts/mutation-check.py --jobs N        N mutations at a time (default: half the cores, max 4)

Exits non-zero if any mutation survives, any anchor no longer matches, or any
run was inconclusive. An anchor that stops matching means the code moved and
the mutation silently tests nothing, so it is reported rather than skipped. A
run that only failed by timing out proves nothing about the tests, so it is
reported as inconclusive rather than counted as caught.

Every mutation runs in its own throw-away copy of the repository, so the real
files are never touched: interrupting this at any point, or running several at
once, cannot leave a mutated file behind. (wireguard/, which holds a key, is
never copied.)

Each mutation runs only the test files likely to catch it first; if they all
pass, the whole suite decides, so "survived" always means the full suite.
"""
import concurrent.futures
import os
import queue
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COPY_IGNORE = shutil.ignore_patterns('node_modules', 'build', 'coverage', '.git', 'wireguard', '.DS_Store')

FRONTEND_TESTS = ['tests/frontend.test.js', 'tests/compat.test.js']
SERVICE_TESTS = ['tests/vpn.test.js', 'tests/autoconnect.test.js', 'tests/service.test.js', 'tests/compat.test.js']
SHELL_TESTS = ['tests/scripts.test.js']
PACKAGING_TESTS = ['tests/packaging.test.js']

# First match wins, so the specific entries come before the general ones.
DEFAULT_TESTS = [
    ('frontend/', FRONTEND_TESTS),
    ('services/vpn.js', SERVICE_TESTS),
    ('services/index.js', ['tests/service.test.js', 'tests/compat.test.js']),
    ('services/autoconnect.js', ['tests/boot.test.js', 'tests/compat.test.js']),
    ('services/manager.js', ['tests/service.test.js', 'tests/boot.test.js', 'tests/compat.test.js']),
    ('services/', SHELL_TESTS),
    ('scripts/build-ipk.sh', PACKAGING_TESTS),
    ('scripts/fetch-openvpn-runtime.sh', PACKAGING_TESTS),
    ('scripts/install-on-', PACKAGING_TESTS),
    ('scripts/10-entropy-seed', PACKAGING_TESTS),
    ('scripts/', SHELL_TESTS),
]


# Within a test file, the describe blocks worth running first for a given target
# (a jest -t pattern). scripts.test.js alone takes over two minutes, almost all of
# it other scripts' tests, so a kill switch mutation would wait on those for
# nothing. Only the first, narrow run uses it: a mutation that survives it is
# retried against the whole suite, so this saves time without ever hiding a bug.
FILTERS = {
    'services/tvpn-killswitch.sh': 'tvpn-killswitch|kill switch',
    'services/tvpn-updown.sh': 'tvpn-updown',
    'services/openvpn-launch.sh': 'openvpn-launch',
    'scripts/20-tvpn-perms': '20-tvpn-perms',
    'scripts/install-luna-registration.sh': 'install-luna-registration',
    'scripts/build-ipk.sh': 'build-ipk',
    'scripts/fetch-openvpn-runtime.sh': 'fetch-openvpn-runtime',
    'scripts/install-on-device.sh': 'install-on-device',
    'scripts/install-on-tv.sh': 'install-on-tv',
    'scripts/10-entropy-seed': '10-entropy-seed',
}


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

    ('boot script no longer hands over to the shipped runner',
     'services/vpn.js',
     "'#!/bin/sh\\nnode ' + BOOT_RUNNER + '\\n'",
     "'#!/bin/sh\\nnode ' + path.join(this._configsDir, 'autoconnect.js') + '\\n'",
     ['tests/autoconnect.test.js']),

    ('old generated runner left behind after enabling auto-connect',
     'services/vpn.js',
     "  fs.chmodSync(STARTUP_SCRIPT_PATH, '755');\n  this._removeLegacyRunner();",
     "  fs.chmodSync(STARTUP_SCRIPT_PATH, '755');",
     ['tests/autoconnect.test.js']),

    ('boot auto-connect ignores the on/off switch',
     'services/autoconnect.js',
     "if (setting.enabled && setting.country) {",
     "if (setting.country) {",
     ['tests/boot.test.js']),

    ('boot auto-connect failure goes unreported (exit status stays 0)',
     'services/autoconnect.js',
     "  process.exit(1);\n}",
     "}",
     ['tests/boot.test.js']),

    ('boot auto-connect failure leaves no trace',
     'services/autoconnect.js',
     "    fs.appendFileSync(LOG_PATH, new Date().toString() + ' ' + message + '\\n');",
     "    void message;",
     ['tests/boot.test.js']),

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
    ('killswitch: the router may no longer answer DNS (apps behind connmand time out)',
     'services/tvpn-killswitch.sh',
     '      iptables -A "$CHAIN" -p "$proto" -d "$net" --dport 53 -j ACCEPT || return 1\n', '',
     ['tests/scripts.test.js']),
    ('killswitch: LAN DNS allowed over udp only',
     'services/tvpn-killswitch.sh',
     '    for proto in udp tcp; do', '    for proto in udp; do',
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
    ('install-on-device: old generated auto-connect runner left in place',
     'scripts/install-on-device.sh',
     'rm -f "$VPN_DIR/autoconnect.js"\n', '',
     ['tests/packaging.test.js']),
    ('install-on-device: boot script not repointed for users with auto-connect on',
     'scripts/install-on-device.sh',
     "  printf '#!/bin/sh\\nnode %s/autoconnect.js\\n' \"$SVC_DIR\" > \"$INITD/99-tvpn\"\n", '',
     ['tests/packaging.test.js']),
    ('build: a service module is no longer packaged',
     'scripts/build-ipk.sh',
     '  cp "$m" "$STAGE/svc/$(basename "$m")"\n', '',
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


def tests_of(mutation):
    return mutation[4] if len(mutation) > 4 else tests_for(mutation[1])


def select(mutations, changed):
    """The mutations worth running when only `changed` files differ: those whose
    target file changed, or whose tests changed (a weaker test can let it through)."""
    changed = set(changed)
    return [m for m in mutations if m[1] in changed or changed & set(tests_of(m) or [])]


def changed_files(ref):
    """Files that differ from `ref`, including uncommitted and untracked ones."""
    def git(*args):
        res = subprocess.run(['git'] + list(args), cwd=REPO, capture_output=True, text=True)
        return res.stdout.split('\n') if res.returncode == 0 else None

    for base in ([ref] if ref else ['origin/main', 'HEAD']):
        diff = git('diff', '--name-only', base)
        if diff is not None:
            untracked = git('ls-files', '--others', '--exclude-standard') or []
            return sorted(f for f in diff + untracked if f), base
    return [], None


def run_suite(cwd, tests=None, workers=None, only=None):
    cmd = ['npx', 'jest', '--silent', '--coverage=false']
    if only:
        cmd += ['-t', only]
    if workers:
        cmd.append('--maxWorkers=%d' % workers)
    try:
        res = subprocess.run(cmd + list(tests or []), cwd=cwd, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        return None, 'timed out'
    return res.returncode, res.stdout + res.stderr


def make_workdir(parent, index):
    dst = os.path.join(parent, 'w%d' % index)
    shutil.copytree(REPO, dst, ignore=COPY_IGNORE)
    os.symlink(os.path.join(REPO, 'node_modules'), os.path.join(dst, 'node_modules'))
    return dst


def judge(code, out):
    """caught / survived / inconclusive. Failing only by timeout is not evidence."""
    if code is None:
        return 'inconclusive'
    if code == 0:
        return 'survived'
    failed_by_assertion = 'Exceeded timeout' not in out or 'Expected' in out or 'expect(' in out
    return 'caught' if failed_by_assertion else 'inconclusive'


def run_one(mutation, workdir, workers):
    name, rel, old, new = mutation[:4]
    tests = tests_of(mutation)
    path = os.path.join(workdir, rel)
    original = open(path).read()
    if original.count(old) != 1:
        return name, 'bad-anchor', original.count(old)
    try:
        open(path, 'w').write(original.replace(old, new, 1))
        verdict = judge(*run_suite(workdir, tests, workers, FILTERS.get(rel)))
        if verdict == 'survived' and (tests or FILTERS.get(rel)):
            verdict = judge(*run_suite(workdir, None, workers))
    finally:
        open(path, 'w').write(original)
    return name, verdict, None


def run_mutations(mutations, jobs):
    code, out = run_suite(REPO)
    if code != 0:
        print('BASELINE IS RED - fix before mutating\n' + out[-1500:])
        return 2

    workers = max(1, (os.cpu_count() or 2) // jobs)
    parent = tempfile.mkdtemp(prefix='tvpn-mutation-')
    results = []
    try:
        free = queue.Queue()
        for i in range(jobs):
            free.put(make_workdir(parent, i))

        def task(mutation):
            workdir = free.get()
            try:
                return run_one(mutation, workdir, workers)
            finally:
                free.put(workdir)

        with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
            for name, verdict, extra in pool.map(task, mutations):
                results.append((name, verdict, extra))
                label = {'caught': 'CAUGHT   ', 'survived': 'SURVIVED ',
                         'inconclusive': 'UNCLEAR  ', 'bad-anchor': 'BAD ANCHOR '}[verdict]
                print(label + name + (' (%d matches)' % extra if verdict == 'bad-anchor' else ''), flush=True)
    finally:
        shutil.rmtree(parent, ignore_errors=True)

    count = lambda v: [n for n, verdict, _ in results if verdict == v]
    print('\ncaught %d / %d' % (len(count('caught')), len(mutations)))
    for verdict, label in (('survived', 'SURVIVOR'), ('inconclusive', 'INCONCLUSIVE (timed out, rerun it)'),
                           ('bad-anchor', 'BAD ANCHOR')):
        for n in count(verdict):
            print('%s: %s' % (label, n))
    return 0 if len(count('caught')) == len(mutations) else 1


def default_jobs():
    return max(1, min(4, (os.cpu_count() or 2) // 2))


def parse_args(argv):
    """-> (changed, ref, jobs). `changed` is whether --changed was given."""
    changed, ref, jobs = False, None, default_jobs()
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == '--changed':
            changed = True
            if i + 1 < len(argv) and not argv[i + 1].startswith('--'):
                ref = argv[i + 1]
                i += 1
        elif arg == '--jobs' and i + 1 < len(argv) and argv[i + 1].isdigit() and int(argv[i + 1]) > 0:
            jobs = int(argv[i + 1])
            i += 1
        else:
            raise SystemExit('usage: mutation-check.py [--changed [REF]] [--jobs N]')
        i += 1
    return changed, ref, jobs


def main():
    changed, ref, jobs = parse_args(sys.argv[1:])
    mutations = MUTATIONS
    if changed:
        files, base = changed_files(ref)
        mutations = select(MUTATIONS, files)
        print('%d file(s) differ from %s; %d of %d mutations apply'
              % (len(files), base, len(mutations), len(MUTATIONS)), flush=True)
        if not mutations:
            print('nothing to mutate')
            return 0
    jobs = min(jobs, len(mutations))
    try:
        return run_mutations(mutations, jobs)
    except KeyboardInterrupt:
        print('\ninterrupted (no repository file was touched)')
        return 130


if __name__ == '__main__':
    sys.exit(main())
