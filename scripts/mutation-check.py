"""
Mutation check: reintroduce each bug that was fixed on device and confirm the
test suite fails. A suite that stays green with a known bug put back is not
protecting anything. Every file is restored afterwards, even on error.

    python3 scripts/mutation-check.py

Exits non-zero if any mutation survives or any anchor no longer matches (an
anchor that stops matching means the code moved and the mutation silently
tests nothing, so it is reported rather than skipped).
"""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP = tempfile.mkdtemp(prefix='tvpn-mutation-')

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
     "  '--up', DNS_SCRIPT,\n  '--down', DNS_SCRIPT,\n",
     ""),

    ('boot runner drops the country record',
     'services/vpn.js',
     "    '  fs.writeFileSync(\\'' + STATE_PATH",
     "    '  void (\\'' + STATE_PATH"),

    ('stale resolver override never cleaned',
     'services/vpn.js',
     "    if (fs.existsSync(PID_PATH)) this._clearState();",
     ""),

    ('dns script stacks mounts',
     'scripts/tvpn-dns-updown.sh',
     '    mountpoint -q "$RESOLV" || mount --bind "$OVERRIDE" "$RESOLV"',
     '    mount --bind "$OVERRIDE" "$RESOLV"'),

    ('dns script mounts even with no DNS pushed',
     'scripts/tvpn-dns-updown.sh',
     "    grep -q '^nameserver ' \"$OVERRIDE\" || exit 0\n",
     ""),

    ('dns down never unmounts',
     'scripts/tvpn-dns-updown.sh',
     '    mountpoint -q "$RESOLV" && umount "$RESOLV"',
     '    true'),

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
]


def run_suite():
    res = subprocess.run(
        ['npx', 'jest', '--silent', '--coverage=false'],
        cwd=REPO, capture_output=True, text=True, timeout=600,
    )
    return res.returncode, res.stdout + res.stderr


def main():
    survivors, caught, bad_anchor = [], [], []

    code, _ = run_suite()
    if code != 0:
        print('BASELINE IS RED - fix before mutating')
        sys.exit(2)

    for name, rel, old, new in MUTATIONS:
        path = os.path.join(REPO, rel)
        backup = os.path.join(BACKUP, rel.replace('/', '__'))
        shutil.copy2(path, backup)
        try:
            src = open(path).read()
            if src.count(old) != 1:
                bad_anchor.append((name, src.count(old)))
                continue
            open(path, 'w').write(src.replace(old, new, 1))
            code, out = run_suite()
            (caught if code != 0 else survivors).append(name)
            print(('CAUGHT   ' if code != 0 else 'SURVIVED ') + name, flush=True)
        finally:
            shutil.copy2(backup, path)

    code, _ = run_suite()
    shutil.rmtree(BACKUP, ignore_errors=True)
    print('\n--- restored; baseline green again: %s' % (code == 0))
    print('caught %d / %d' % (len(caught), len(MUTATIONS) - len(bad_anchor)))
    for n, c in bad_anchor:
        print('BAD ANCHOR (%d matches): %s' % (c, n))
    for n in survivors:
        print('SURVIVOR: ' + n)
    sys.exit(1 if (survivors or bad_anchor) else 0)


if __name__ == '__main__':
    main()
