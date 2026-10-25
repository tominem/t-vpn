/**
 * Behavioural tests for the packaging and installation scripts.
 *
 * Everything here runs the real scripts. What they would normally reach (an
 * Alpine mirror, ares-package, the TV over ssh/scp) is replaced by stand-ins
 * on an isolated PATH, so a failure in any step is observable without a device.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const hasFile = spawnSync('sh', ['-c', 'command -v file']).status === 0;

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvpn-pkg-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(script, args, env) {
  return spawnSync('sh', [path.join(ROOT, script)].concat(args || []), {
    env: Object.assign({ PATH: SYSTEM_PATH, HOME: tmp }, env),
    encoding: 'utf8',
    timeout: 120000,
  });
}

function write(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { mode: mode || 0o644 });
  return file;
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const mode = (file) => fs.statSync(file).mode & 0o777;

/** A 52-byte ELF32 header for ARM: enough for file(1) to call it an ARM binary. */
function armElf() {
  const b = Buffer.alloc(52);
  b.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0);
  b.writeUInt16LE(2, 16);
  b.writeUInt16LE(0x28, 18);
  b.writeUInt32LE(1, 20);
  b.writeUInt16LE(52, 40);
  return b;
}

/* ───────────────────────── fetch-openvpn-runtime.sh ───────────────────────── */

describe('fetch-openvpn-runtime.sh', () => {
  /**
   * A fake Alpine mirror: one .apk per package holding the file layout the
   * script expects, plus a lock file pinning each package's real SHA-256.
   * `files` maps a package to its contents; a null value leaves the file out.
   */
  function fakeMirror(overrides) {
    const o = overrides || {};
    const mirror = path.join(tmp, 'mirror');
    fs.mkdirSync(mirror, { recursive: true });
    const packages = {
      'openvpn-1.apk': { 'usr/sbin/openvpn': o.binary === undefined ? armElf() : o.binary },
      'musl-1.apk': { 'lib/ld-musl-armhf.so.1': Buffer.from('loader') },
      'libcap-ng-1.apk': { 'usr/lib/libcap-ng.so.0.0.0': Buffer.from('capng') },
      'libcrypto3-1.apk': { 'lib/libcrypto.so.3': Buffer.from('crypto') },
      'libssl3-1.apk': { 'lib/libssl.so.3': Buffer.from('ssl') },
      'lz4-libs-1.apk': { 'usr/lib/liblz4.so.1.9.4': Buffer.from('lz4') },
      'lzo-1.apk': { 'usr/lib/liblzo2.so.2.0.0': Buffer.from('lzo') },
    };
    const lines = [];
    Object.keys(packages).forEach((apk) => {
      const root = path.join(tmp, `pkgroot-${apk}`);
      write(path.join(root, '.PKGINFO'), 'pkgname = fake\n');
      Object.keys(packages[apk]).forEach((rel) => {
        if (packages[apk][rel] !== null) write(path.join(root, rel), packages[apk][rel]);
      });
      spawnSync('tar', ['-czf', path.join(mirror, apk), '-C', root, '.']);
      lines.push(`${sha(path.join(mirror, apk))}  ${apk}`);
    });
    const lock = write(path.join(tmp, 'runtime.lock'), ['# pins', '', ...lines, ''].join('\n'));
    return { mirror, lock, out: path.join(tmp, 'out'), cache: path.join(tmp, 'cache') };
  }

  function fetch(m, env) {
    return run('scripts/fetch-openvpn-runtime.sh', [], Object.assign({
      ALPINE_MIRROR: `file://${m.mirror}`,
      TVPN_RUNTIME_LOCK: m.lock,
      TVPN_RUNTIME_OUT: m.out,
      TVPN_RUNTIME_CACHE: m.cache,
    }, env));
  }

  test('assembles the runtime from the pinned packages', () => {
    const m = fakeMirror();

    const res = fetch(m);

    expect(res.status).toBe(0);
    ['bin/openvpn', 'lib/ld-musl-armhf.so.1', 'lib/libcrypto.so.3', 'lib/libssl.so.3',
      'lib/libcap-ng.so.0', 'lib/liblz4.so.1', 'lib/liblzo2.so.2']
      .forEach((rel) => expect(fs.existsSync(path.join(m.out, rel))).toBe(true));
  });

  test('the binary and the loader are executable', () => {
    const m = fakeMirror();
    fetch(m);

    expect(mode(path.join(m.out, 'bin/openvpn')) & 0o111).not.toBe(0);
    expect(mode(path.join(m.out, 'lib/ld-musl-armhf.so.1')) & 0o111).not.toBe(0);
  });

  test('refuses a package whose hash does not match the pin, and forgets it', () => {
    const m = fakeMirror();
    fs.appendFileSync(path.join(m.mirror, 'openvpn-1.apk'), 'tampered');

    const res = fetch(m);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('SHA-256 mismatch for openvpn-1.apk');
    expect(res.stderr).toContain('pinned:');
    expect(res.stderr).toContain('received:');
    expect(fs.existsSync(m.out)).toBe(false);
    // The bad file must not stay where the next run would trust it.
    expect(fs.existsSync(path.join(m.cache, 'openvpn-1.apk'))).toBe(false);
  });

  test('works from the cache once downloaded', () => {
    const m = fakeMirror();
    expect(fetch(m).status).toBe(0);
    fs.rmSync(m.mirror, { recursive: true });

    expect(fetch(m).status).toBe(0);
  });

  test('rebuilds the output from scratch, dropping stale files', () => {
    const m = fakeMirror();
    write(path.join(m.out, 'lib/stale.so'), 'old');

    fetch(m);

    expect(fs.existsSync(path.join(m.out, 'lib/stale.so'))).toBe(false);
  });

  test('stops when a pinned package lacks an expected file', () => {
    const m = fakeMirror({ binary: null });

    const res = fetch(m);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('expected one of [usr/sbin/openvpn]');
  });

  test('stops when an expected file is empty', () => {
    const m = fakeMirror({ binary: Buffer.alloc(0) });

    const res = fetch(m);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/empty/);
  });

  (hasFile ? test : test.skip)('refuses a binary that is not for ARM', () => {
    // A host-architecture binary would fail only once it reached the TV.
    const m = fakeMirror({ binary: Buffer.from('#!/bin/sh\necho hi\n') });

    const res = fetch(m);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('not an ARM binary');
  });

  test('reports a package the mirror does not have', () => {
    const m = fakeMirror();
    fs.rmSync(path.join(m.mirror, 'lzo-1.apk'));

    const res = fetch(m);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('download failed');
  });

  test('reports a package that is not an archive', () => {
    const m = fakeMirror();
    write(path.join(m.mirror, 'lzo-1.apk'), 'not a tarball');
    // keep the pin honest so the failure is the unpacking, not the hash
    const lines = fs.readFileSync(m.lock, 'utf8').split('\n')
      .map((l) => (l.endsWith('lzo-1.apk') ? `${sha(path.join(m.mirror, 'lzo-1.apk'))}  lzo-1.apk` : l));
    fs.writeFileSync(m.lock, lines.join('\n'));

    const res = fetch(m);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('cannot unpack lzo-1.apk');
  });

  test('rejects a lock file that does not exist', () => {
    const res = run('scripts/fetch-openvpn-runtime.sh', [], {
      TVPN_RUNTIME_LOCK: path.join(tmp, 'nope.lock'),
      TVPN_RUNTIME_OUT: path.join(tmp, 'out'),
      TVPN_RUNTIME_CACHE: path.join(tmp, 'cache'),
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('lock file not found');
  });

  test('rejects a lock file that pins nothing', () => {
    const lock = write(path.join(tmp, 'empty.lock'), '# nothing here\n\n');

    const res = run('scripts/fetch-openvpn-runtime.sh', [], {
      TVPN_RUNTIME_LOCK: lock,
      TVPN_RUNTIME_OUT: path.join(tmp, 'out'),
      TVPN_RUNTIME_CACHE: path.join(tmp, 'cache'),
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('lists no packages');
  });

  test('rejects a malformed lock line', () => {
    const lock = write(path.join(tmp, 'bad.lock'), 'deadbeef\n');

    const res = run('scripts/fetch-openvpn-runtime.sh', [], {
      TVPN_RUNTIME_LOCK: lock,
      TVPN_RUNTIME_OUT: path.join(tmp, 'out'),
      TVPN_RUNTIME_CACHE: path.join(tmp, 'cache'),
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('malformed lock line');
  });

  test('the real lock pins the seven packages the runtime needs', () => {
    const lock = fs.readFileSync(path.join(ROOT, 'packaging/openvpn-runtime.lock'), 'utf8');
    const pins = lock.split('\n').filter((l) => l && !l.startsWith('#'));

    expect(pins).toHaveLength(7);
    pins.forEach((l) => expect(l).toMatch(/^[0-9a-f]{64} {2}\S+\.apk$/));
    ['openvpn-', 'musl-', 'libcrypto3-', 'libssl3-', 'libcap-ng-', 'lz4-libs-', 'lzo-']
      .forEach((p) => expect(pins.some((l) => l.includes(`  ${p}`))).toBe(true));
  });
});

/* ───────────────────────────── build-ipk.sh ───────────────────────────── */

describe('build-ipk.sh', () => {
  const APP_ID = 'com.tominem.tvpn';

  /** A runtime directory shaped like fetch-openvpn-runtime.sh's output. */
  function fakeRuntime() {
    const dir = path.join(tmp, 'runtime');
    write(path.join(dir, 'bin/openvpn'), armElf(), 0o755);
    write(path.join(dir, 'lib/ld-musl-armhf.so.1'), 'loader', 0o755);
    write(path.join(dir, 'lib/libssl.so.3'), 'ssl');
    return dir;
  }

  /** Stands in for ares-package: builds an ar archive the way the real one lays it out. */
  function fakeAres(extra) {
    const bin = path.join(tmp, 'aresbin');
    const log = path.join(tmp, 'ares.log');
    write(path.join(bin, 'ares-package'), `#!/bin/sh
echo "$@" >> "${log}"
out=""; app=""; svc=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --no-minify) shift ;;
    *) if [ -z "$app" ]; then app=$1; else svc=$1; fi; shift ;;
  esac
done
w=$(mktemp -d)
d=$w/data/usr/palm
mkdir -p "$d/applications/${APP_ID}" "$d/services/${APP_ID}.service" "$d/packages/${APP_ID}"
cp -R "$app/." "$d/applications/${APP_ID}/"
cp -R "$svc/." "$d/services/${APP_ID}.service/"
echo '{}' > "$d/packages/${APP_ID}/packageinfo.json"
${extra || ''}
( cd "$w/data" && tar -czf ../data.tar.gz . )
echo 2.0 > "$w/debian-binary"; echo "Package: ${APP_ID}" > "$w/control"
( cd "$w" && tar -czf control.tar.gz control && ar rc "$out/${APP_ID}_1.1.0_all.ipk" debian-binary control.tar.gz data.tar.gz )
rm -rf "$w"
`, 0o755);
    return { bin, log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
  }

  function build(opts) {
    const o = opts || {};
    const ares = o.ares || fakeAres();
    const runtime = o.runtime || fakeRuntime();
    const res = run('scripts/build-ipk.sh', [], Object.assign({
      ARES_PACKAGE: path.join(ares.bin, 'ares-package'),
      TVPN_BUILD_DIR: path.join(tmp, 'build'),
      TVPN_RUNTIME_OUT: runtime,
      TVPN_SKIP_FETCH: '1',
    }, o.env));
    return { res, ares, runtime, stage: path.join(tmp, 'build/stage'), dist: path.join(tmp, 'build/dist') };
  }

  test('stages the app and a self-contained service', () => {
    const { res, stage } = build();

    expect(res.status).toBe(0);
    ['appinfo.json', 'frontend/index.html', 'frontend/main.js', 'frontend/styles.css',
      'frontend/icon.png', 'frontend/icon_large.png']
      .forEach((rel) => expect(fs.existsSync(path.join(stage, 'app', rel))).toBe(true));
    ['index.js', 'vpn.js', 'package.json', 'services.json', 'run-js-service',
      'openvpn-launch.sh', 'tvpn-updown.sh', 'tvpn-killswitch.sh', 'install-on-device.sh',
      'install-luna-registration.sh', 'boot/10-entropy-seed', 'boot/20-tvpn-perms',
      'ovpn-runtime/bin/openvpn', 'ovpn-runtime/lib/ld-musl-armhf.so.1']
      .forEach((rel) => expect(fs.existsSync(path.join(stage, 'svc', rel))).toBe(true));
  });

  test('installs each server config under its country code', () => {
    const { stage } = build();
    const map = fs.readFileSync(path.join(ROOT, 'packaging/servers.txt'), 'utf8')
      .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));

    expect(map.length).toBeGreaterThanOrEqual(7);
    map.forEach(([code, host]) => {
      const staged = fs.readFileSync(path.join(stage, 'svc/configs', `${code}.ovpn`), 'utf8');
      const source = fs.readFileSync(path.join(ROOT, 'ovpn', `${host}.nordvpn.com.udp.ovpn`), 'utf8');
      expect(staged).toBe(source);
    });
  });

  test('every country the app offers has a config in the package', () => {
    // The UI lists countries by code; a code with no config is a button that fails.
    const { stage } = build();
    const main = fs.readFileSync(path.join(ROOT, 'frontend/main.js'), 'utf8');
    const codes = [...main.matchAll(/\{ code: '([a-z]{2})'/g)].map((m) => m[1]);

    expect(codes.length).toBeGreaterThanOrEqual(7);
    codes.forEach((c) => expect(fs.existsSync(path.join(stage, 'svc/configs', `${c}.ovpn`))).toBe(true));
  });

  test('scripts and the runtime are executable, data files are not', () => {
    const { stage } = build();
    const svc = (rel) => mode(path.join(stage, 'svc', rel));

    ['run-js-service', 'openvpn-launch.sh', 'tvpn-updown.sh', 'tvpn-killswitch.sh', 'install-on-device.sh',
      'install-luna-registration.sh', 'boot/10-entropy-seed', 'boot/20-tvpn-perms',
      'ovpn-runtime/bin/openvpn', 'ovpn-runtime/lib/ld-musl-armhf.so.1']
      .forEach((rel) => expect(svc(rel) & 0o111).not.toBe(0));
    ['index.js', 'vpn.js', 'package.json', 'services.json', 'configs/us.ovpn']
      .forEach((rel) => expect(svc(rel) & 0o111).toBe(0));
  });

  test('turns minification off, so the shipped code is the tested code', () => {
    const { ares } = build();

    expect(ares.log()).toContain('--no-minify');
  });

  test('builds and reports the package', () => {
    const { res, dist } = build();

    expect(res.stdout).toContain('built');
    expect(res.stdout).toMatch(/sha256 [0-9a-f]{64}/);
    expect(fs.readdirSync(dist).filter((f) => f.endsWith('.ipk'))).toHaveLength(1);
  });

  test('fails if the package does not carry what was staged', () => {
    // ares-package once rewrote main.js (minified it); this is the net for that.
    const ares = fakeAres(`echo '// altered' >> "$d/services/${APP_ID}.service/vpn.js"`);

    const { res } = build({ ares });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('packaged file differs from what was staged: ./vpn.js');
  });

  test.each([
    ['a credentials file', '.auth', 'user\npass\n'],
    ['a WireGuard config', 'wg0.conf', '[Interface]\n'],
    ['a key file', 'server.key', 'x'],
    ['a stored settings file', 'config.json', '{}'],
  ])('refuses to package %s', (_label, name, body) => {
    const runtime = fakeRuntime();
    write(path.join(runtime, name), body);

    const { res, dist } = build({ runtime });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('look like secrets');
    expect(fs.existsSync(dist) ? fs.readdirSync(dist).filter((f) => f.endsWith('.ipk')) : []).toHaveLength(0);
  });

  test.each([
    ['a WireGuard private key', 'PrivateKey = abc123'],
    ['a PEM private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ])('refuses to package %s hidden in an ordinary file', (_label, text) => {
    const runtime = fakeRuntime();
    write(path.join(runtime, 'lib/notes.txt'), `${text}\n`);

    const { res } = build({ runtime });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('private-key material');
  });

  test('explains when ares-package is not installed', () => {
    const res = run('scripts/build-ipk.sh', [], {
      TVPN_BUILD_DIR: path.join(tmp, 'build'),
      TVPN_RUNTIME_OUT: fakeRuntime(),
      TVPN_SKIP_FETCH: '1',
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('ares-package not found');
  });

  test('finds ares-package in the skill install location', () => {
    const ares = fakeAres();
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.local/share/webos-tv'), { recursive: true });
    fs.symlinkSync(ares.bin, path.join(home, '.local/share/webos-tv/bin'));

    const res = run('scripts/build-ipk.sh', [], {
      HOME: home,
      TVPN_BUILD_DIR: path.join(tmp, 'build'),
      TVPN_RUNTIME_OUT: fakeRuntime(),
      TVPN_SKIP_FETCH: '1',
    });

    expect(res.status).toBe(0);
  });

  test('stops when the OpenVPN runtime is missing', () => {
    const { res } = build({ runtime: path.join(tmp, 'no-runtime') });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('OpenVPN runtime missing');
  });

  test('stops when a mapped server has no config file', () => {
    const servers = write(path.join(tmp, 'servers.txt'), 'xx nowhere\n');

    const { res } = build({ env: { TVPN_SERVERS: servers } });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('no config for \'xx\'');
  });

  test('stops when the server map does not exist', () => {
    const { res } = build({ env: { TVPN_SERVERS: path.join(tmp, 'absent.txt') } });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('server map not found');
  });

  test('stops when the server map lists nothing', () => {
    const servers = write(path.join(tmp, 'servers.txt'), '# only a comment\n');

    const { res } = build({ env: { TVPN_SERVERS: servers } });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('produced no configs');
  });

  test('fetches the runtime itself unless told not to', () => {
    // End to end through fetch-openvpn-runtime.sh, with a fake mirror.
    const ares = fakeAres();
    const mirror = path.join(tmp, 'mirror');
    const root = path.join(tmp, 'pkgroot');
    write(path.join(root, 'usr/sbin/openvpn'), armElf());
    write(path.join(root, 'lib/ld-musl-armhf.so.1'), 'loader');
    ['lib/libcrypto.so.3', 'lib/libssl.so.3', 'usr/lib/libcap-ng.so.0.0.0',
      'usr/lib/liblz4.so.1.9.4', 'usr/lib/liblzo2.so.2.0.0']
      .forEach((rel) => write(path.join(root, rel), 'x'));
    fs.mkdirSync(mirror);
    spawnSync('tar', ['-czf', path.join(mirror, 'all-1.apk'), '-C', root, '.']);
    const lock = write(path.join(tmp, 'rt.lock'), `${sha(path.join(mirror, 'all-1.apk'))}  all-1.apk\n`);

    const res = run('scripts/build-ipk.sh', [], {
      ARES_PACKAGE: path.join(ares.bin, 'ares-package'),
      TVPN_BUILD_DIR: path.join(tmp, 'build'),
      ALPINE_MIRROR: `file://${mirror}`,
      TVPN_RUNTIME_LOCK: lock,
      TVPN_RUNTIME_CACHE: path.join(tmp, 'cache'),
    });

    expect(`${res.status} ${res.stderr}`).toMatch(/^0 /);
    expect(res.stdout).toContain('openvpn runtime assembled');
    expect(fs.existsSync(path.join(tmp, 'build/stage/svc/ovpn-runtime/bin/openvpn'))).toBe(true);
  });
});

/* ──────────────────────────── install-on-device.sh ──────────────────────────── */

describe('install-on-device.sh', () => {
  /** A service directory laid out as the IPK installs it, with scratch targets. */
  function fixture(options) {
    const o = options || {};
    const svc = path.join(tmp, 'svc');
    ['us', 'br'].forEach((c) => write(path.join(svc, 'configs', `${c}.ovpn`), `client ${c}\n`));
    if (!o.noBoot) {
      write(path.join(svc, 'boot/10-entropy-seed'), '#!/bin/sh\n', 0o644);
      write(path.join(svc, 'boot/20-tvpn-perms'), '#!/bin/sh\n', 0o644);
    }
    fs.copyFileSync(path.join(ROOT, 'scripts/install-on-device.sh'), path.join(svc, 'install-on-device.sh'));
    fs.copyFileSync(path.join(ROOT, 'scripts/install-luna-registration.sh'), path.join(svc, 'install-luna-registration.sh'));

    const luna = path.join(tmp, 'luna');
    ['services.d', 'roles.d', 'api-permissions.d', 'client-permissions.d', 'manifests.d']
      .forEach((d) => fs.mkdirSync(path.join(luna, d), { recursive: true }));
    const lsLog = path.join(tmp, 'ls.log');
    const lsControl = write(path.join(tmp, 'ls-control'), `#!/bin/sh\necho "$@" >> "${lsLog}"\n`, 0o755);

    return {
      svc, luna, lsLog,
      vpn: path.join(tmp, 'vpn'),
      initd: path.join(tmp, 'initd'),
      env: {
        TVPN_VPN_DIR: path.join(tmp, 'vpn'),
        TVPN_INITD_DIR: path.join(tmp, 'initd'),
        TVPN_LUNA_DIR: luna,
        TVPN_LS_CONTROL: lsControl,
        TVPN_NO_START: '1',
      },
    };
  }

  const install = (f) => spawnSync('sh', [path.join(f.svc, 'install-on-device.sh')], {
    env: Object.assign({ PATH: SYSTEM_PATH, HOME: tmp }, f.env),
    encoding: 'utf8',
  });

  test('puts the configs in a private directory, each private too', () => {
    const f = fixture();

    const res = install(f);

    expect(res.status).toBe(0);
    expect(mode(f.vpn)).toBe(0o700);
    ['us', 'br'].forEach((c) => {
      expect(fs.readFileSync(path.join(f.vpn, `${c}.ovpn`), 'utf8')).toBe(`client ${c}\n`);
      expect(mode(path.join(f.vpn, `${c}.ovpn`))).toBe(0o600);
    });
  });

  test('installs the boot scripts so they run on every boot', () => {
    const f = fixture();

    install(f);

    ['10-entropy-seed', '20-tvpn-perms'].forEach((n) => {
      expect(mode(path.join(f.initd, n))).toBe(0o755);
    });
  });

  test('registers the service on the Luna bus and asks the hub to rescan', () => {
    const f = fixture();

    install(f);

    expect(fs.existsSync(path.join(f.luna, 'manifests.d/com.tominem.tvpn.json'))).toBe(true);
    expect(fs.readFileSync(f.lsLog, 'utf8').trim()).toBe('scan-services');
  });

  test('registers the service at the directory it was installed in', () => {
    const f = fixture();

    install(f);

    const unit = fs.readFileSync(path.join(f.luna, 'services.d/com.tominem.tvpn.service.service'), 'utf8');
    expect(unit).toContain(`${f.svc}/run-js-service`);
  });

  test('never touches the credentials file', () => {
    const f = fixture();
    write(path.join(f.vpn, '.auth'), 'user\nsecret\n', 0o600);

    const res = install(f);

    expect(fs.readFileSync(path.join(f.vpn, '.auth'), 'utf8')).toBe('user\nsecret\n');
    expect(res.stdout).toContain('.auth is present');
  });

  test('says how to create the credentials when they are missing', () => {
    const f = fixture();

    const res = install(f);

    expect(res.stdout).toContain('.auth is NOT present');
    expect(fs.existsSync(path.join(f.vpn, '.auth'))).toBe(false);
  });

  test('is safe to run again', () => {
    const f = fixture();

    expect(install(f).status).toBe(0);
    expect(install(f).status).toBe(0);
    expect(fs.readdirSync(f.vpn).sort()).toEqual(['br.ovpn', 'us.ovpn']);
  });

  test('refuses to run beside a package with no configs directory', () => {
    const f = fixture();
    fs.rmSync(path.join(f.svc, 'configs'), { recursive: true });

    const res = install(f);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('no configs/');
  });

  test('refuses an empty configs directory', () => {
    const f = fixture();
    fs.rmSync(path.join(f.svc, 'configs/us.ovpn'));
    fs.rmSync(path.join(f.svc, 'configs/br.ovpn'));

    const res = install(f);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('no .ovpn files');
  });

  test('refuses a package whose boot scripts are missing', () => {
    const f = fixture({ noBoot: true });

    const res = install(f);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('boot/10-entropy-seed missing');
  });

  test('starts the boot scripts now when not told otherwise', () => {
    // Without this the first connection after install would wait for a reboot.
    const f = fixture();
    const marker = path.join(tmp, 'ran');
    write(path.join(f.svc, 'boot/10-entropy-seed'), `#!/bin/sh\necho seed >> "${marker}"\n`);
    write(path.join(f.svc, 'boot/20-tvpn-perms'), `#!/bin/sh\necho perms >> "${marker}"\n`);
    const env = Object.assign({}, f.env);
    delete env.TVPN_NO_START;

    spawnSync('sh', [path.join(f.svc, 'install-on-device.sh')], {
      env: Object.assign({ PATH: SYSTEM_PATH, HOME: tmp }, env),
      encoding: 'utf8',
    });

    expect(fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean)).toEqual(['perms', 'seed']);
  });
});

/* ────────────────────────────── install-on-tv.sh ────────────────────────────── */

describe('install-on-tv.sh', () => {
  const SECRET = 'hunter2-service-password';

  /** ssh/scp stand-ins that record every call and can be told to fail. */
  function fakeTv() {
    const bin = path.join(tmp, 'tvbin');
    const log = path.join(tmp, 'tv.log');
    const rcFile = path.join(tmp, 'rc');
    const authCapture = path.join(tmp, 'auth.captured');
    write(path.join(bin, 'ssh'), `#!/bin/sh
printf 'ssh %s\n' "$(printf '%s' "$*" | tr '\n' ' ')" >> "${log}"
if [ -n "$FAIL_ON" ]; then case "$*" in *"$FAIL_ON"*) exit 1 ;; esac; fi
case "$*" in
  *"cat /tmp/tvpn-install.rc"*) cat "${rcFile}" 2>/dev/null ;;
  *"cat /tmp/tvpn-install.log"*) echo "installer said hello" ;;
  *"cat > /media/developer/vpn/.auth"*) cat > "${authCapture}" ;;
esac
exit 0
`, 0o755);
    write(path.join(bin, 'scp'), `#!/bin/sh
printf 'scp %s\n' "$(printf '%s' "$*" | tr '\n' ' ')" >> "${log}"
[ -n "$SCP_FAIL" ] && exit 1
exit 0
`, 0o755);
    return {
      bin, authCapture,
      setRc: (v) => fs.writeFileSync(rcFile, `${v}\n`),
      lines: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
    };
  }

  function install(args, options) {
    const o = options || {};
    const tv = o.tv || fakeTv();
    if (!o.noRc) tv.setRc(o.rc === undefined ? 0 : o.rc);
    const ipk = write(path.join(tmp, 'dist/com.tominem.tvpn_1.1.0_all.ipk'), 'fake ipk');
    const res = run('scripts/install-on-tv.sh', (args || []).map((a) => (a === '@ipk' ? ipk : a)), Object.assign({
      PATH: `${tv.bin}:${SYSTEM_PATH}`,
      TV_HOST: '10.1.2.3',
      TV_KEY: path.join(tmp, 'key'),
      TV_CONFIG: path.join(tmp, 'absent.env'),
      TVPN_INSTALL_POLLS: '3',
      TVPN_INSTALL_POLL_SECONDS: '0',
    }, o.env));
    return { res, tv, ipk };
  }

  test('copies the package, installs it, runs the finisher, and cleans up, in that order', () => {
    const { res, tv } = install(['@ipk']);

    expect(res.status).toBe(0);
    const lines = tv.lines();
    const at = (needle) => lines.findIndex((l) => l.includes(needle));
    expect(at('scp ')).toBeGreaterThanOrEqual(0);
    expect(at('opkg ')).toBeGreaterThan(at('scp '));
    expect(at('install-on-device.sh')).toBeGreaterThan(at('opkg '));
    expect(at('cat /tmp/tvpn-install.rc')).toBeGreaterThan(at('install-on-device.sh'));
    expect(at('cat /tmp/tvpn-install.log')).toBeGreaterThan(at('cat /tmp/tvpn-install.rc'));
    expect(lines[lines.length - 1]).toContain('rm -f \'/tmp/com.tominem.tvpn_1.1.0_all.ipk\'');
    expect(res.stdout).toContain('installer said hello');
  });

  test('never launches or closes the app, so what the TV shows is left alone', () => {
    const { tv } = install(['@ipk']);

    tv.lines().forEach((l) => {
      expect(l).not.toMatch(/launch|closeByAppId|applicationmanager|applicationManager|initctl/);
    });
  });

  test('installs with opkg into the developer root, reinstalling over any previous copy', () => {
    const { tv } = install(['@ipk']);

    const opkg = tv.lines().find((l) => l.includes('opkg -o'));
    expect(opkg).toContain('-o /media/developer/apps');
    expect(opkg).toContain('--force-reinstall');
  });

  test('uses the address and key it was given', () => {
    const { tv } = install(['@ipk', '10.9.9.9']);

    tv.lines().forEach((l) => {
      expect(l).toContain('root@10.9.9.9');
      expect(l).toContain(`-i ${path.join(tmp, 'key')}`);
    });
  });

  test('picks the newest package in the dist directory by default', () => {
    const dist = path.join(tmp, 'dist');
    const older = write(path.join(dist, 'older_1.0.0_all.ipk'), 'old');
    const newer = write(path.join(dist, 'newer_1.1.0_all.ipk'), 'new');
    fs.utimesSync(older, new Date(2020, 1, 1), new Date(2020, 1, 1));
    fs.utimesSync(newer, new Date(2025, 1, 1), new Date(2025, 1, 1));

    const tv = fakeTv();
    tv.setRc(0);
    run('scripts/install-on-tv.sh', [], {
      PATH: `${tv.bin}:${SYSTEM_PATH}`,
      TV_HOST: '10.1.2.3',
      TV_KEY: path.join(tmp, 'key'),
      TV_CONFIG: path.join(tmp, 'absent.env'),
      TVPN_DIST_DIR: dist,
      TVPN_INSTALL_POLLS: '2',
      TVPN_INSTALL_POLL_SECONDS: '0',
    });

    const scp = tv.lines().find((l) => l.startsWith('scp '));
    expect(scp).toContain('newer_1.1.0_all.ipk');
    expect(scp).not.toContain('older_1.0.0_all.ipk');
  });

  test('streams credentials over stdin, never through a command line', () => {
    const authFile = write(path.join(tmp, 'auth.txt'), `user\n${SECRET}\n`, 0o600);

    const { res, tv } = install(['@ipk', '--auth-file', authFile]);

    expect(res.status).toBe(0);
    expect(fs.readFileSync(tv.authCapture, 'utf8')).toBe(`user\n${SECRET}\n`);
    const cmd = tv.lines().find((l) => l.includes('.auth'));
    expect(cmd).toContain('umask 077');
    expect(cmd).toContain('chmod 600');
    tv.lines().forEach((l) => expect(l).not.toContain(SECRET));
    expect(res.stdout).not.toContain(SECRET);
    expect(res.stderr).not.toContain(SECRET);
  });

  test('does not touch credentials unless asked to', () => {
    const { tv } = install(['@ipk']);

    expect(tv.lines().some((l) => l.includes('.auth'))).toBe(false);
  });

  test('fails, with the reason, when the on-device installer fails', () => {
    const { res } = install(['@ipk'], { rc: 3 });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('failed (exit 3)');
  });

  test('fails when the on-device installer never reports back', () => {
    const { res } = install(['@ipk'], { noRc: true });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('did not finish in time');
  });

  test('points at the Homebrew Channel when the TV cannot be reached', () => {
    const { res } = install(['@ipk'], { env: { SCP_FAIL: '1' } });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Homebrew Channel');
  });

  test('stops when opkg fails', () => {
    const { res, tv } = install(['@ipk'], { env: { FAIL_ON: 'opkg -o' } });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('opkg failed');
    expect(tv.lines().some((l) => l.includes('install-on-device.sh'))).toBe(false);
  });

  test('fails when the credentials cannot be installed', () => {
    const authFile = write(path.join(tmp, 'auth.txt'), 'u\np\n');

    const { res } = install(['@ipk', '--auth-file', authFile], { env: { FAIL_ON: 'umask 077' } });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('could not install the credentials file');
  });

  test('refuses to run when there is no package to install', () => {
    const tv = fakeTv();

    const res = run('scripts/install-on-tv.sh', [], {
      PATH: `${tv.bin}:${SYSTEM_PATH}`,
      TV_HOST: '10.1.2.3',
      TV_CONFIG: path.join(tmp, 'absent.env'),
      TVPN_DIST_DIR: path.join(tmp, 'empty'),
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('no IPK to install');
    expect(tv.lines()).toEqual([]);
  });

  test('refuses a credentials file that does not exist', () => {
    const { res, tv } = install(['@ipk', '--auth-file', path.join(tmp, 'missing.txt')]);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('credentials file not found');
    expect(tv.lines()).toEqual([]);
  });

  test('refuses --auth-file with no path', () => {
    const { res } = install(['@ipk', '--auth-file']);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--auth-file needs a path');
  });

  test('refuses an option it does not know', () => {
    const { res } = install(['@ipk', '--frobnicate']);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown option');
  });

  test('refuses to run with no TV address', () => {
    const tv = fakeTv();
    const ipk = write(path.join(tmp, 'a_1.0.0_all.ipk'), 'x');

    const res = run('scripts/install-on-tv.sh', [ipk], {
      PATH: `${tv.bin}:${SYSTEM_PATH}`,
      TV_CONFIG: path.join(tmp, 'absent.env'),
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toContain('No TV address');
    expect(tv.lines()).toEqual([]);
  });
});

/* ────────────────────────────── 10-entropy-seed ────────────────────────────── */

describe('10-entropy-seed', () => {
  const SCRIPT = path.join(ROOT, 'scripts/10-entropy-seed');

  /** python2 stand-in that counts how often the seeder asks it to seed. */
  function fixture() {
    const bin = path.join(tmp, 'pybin');
    const calls = path.join(tmp, 'seed.calls');
    write(path.join(bin, 'python2'), `#!/bin/sh\necho seeded >> "${calls}"\n`, 0o755);
    const avail = write(path.join(tmp, 'avail'), '4096\n');
    const pidfile = path.join(tmp, 'pid');
    return {
      avail, pidfile,
      seeds: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length : 0),
      env: {
        PATH: `${bin}:${SYSTEM_PATH}`,
        TVPN_ENTROPY_PID: pidfile,
        TVPN_ENTROPY_AVAIL: avail,
        TVPN_ENTROPY_INTERVAL: '1',
      },
    };
  }

  /** The seeder leaves a background loop running, so it must be stopped explicitly. */
  function start(f) {
    // stdio ignored: a live background child would otherwise hold the pipes open
    spawnSync('sh', [SCRIPT], { env: f.env, stdio: 'ignore' });
  }

  function stop(f) {
    if (fs.existsSync(f.pidfile)) {
      try { process.kill(parseInt(fs.readFileSync(f.pidfile, 'utf8'), 10), 'SIGTERM'); } catch (e) { /* already gone */ }
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = (f) => {
    try { process.kill(parseInt(fs.readFileSync(f.pidfile, 'utf8'), 10), 0); return true; } catch (e) { return false; }
  };

  test('seeds immediately and leaves a daemon running', () => {
    const f = fixture();
    try {
      start(f);

      expect(f.seeds()).toBe(1);
      expect(alive(f)).toBe(true);
    } finally {
      stop(f);
    }
  });

  test('does not start a second daemon when one is already running', () => {
    const f = fixture();
    try {
      start(f);
      const pid = fs.readFileSync(f.pidfile, 'utf8');
      const before = f.seeds();

      start(f);

      expect(fs.readFileSync(f.pidfile, 'utf8')).toBe(pid);
      expect(f.seeds()).toBe(before);
    } finally {
      stop(f);
    }
  });

  test('replaces a stale pidfile whose process is gone', () => {
    const f = fixture();
    fs.writeFileSync(f.pidfile, '999999\n');
    try {
      start(f);

      expect(fs.readFileSync(f.pidfile, 'utf8').trim()).not.toBe('999999');
      expect(alive(f)).toBe(true);
    } finally {
      stop(f);
    }
  });

  test('re-seeds when the entropy pool runs low', async () => {
    const f = fixture();
    try {
      start(f);
      const initial = f.seeds();
      fs.writeFileSync(f.avail, '100\n');

      await sleep(2600);

      expect(f.seeds()).toBeGreaterThan(initial);
    } finally {
      stop(f);
    }
  });

  test('leaves the pool alone while it is healthy', async () => {
    const f = fixture();
    try {
      start(f);
      const initial = f.seeds();

      await sleep(2600);

      expect(f.seeds()).toBe(initial);
    } finally {
      stop(f);
    }
  });
});
