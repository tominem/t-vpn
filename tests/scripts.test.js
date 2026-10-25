/**
 * Behavioural tests for the shell scripts that run on the TV.
 *
 * They are executed for real, against scratch directories, with `mount`,
 * `mountpoint` and `umount` replaced by stand-ins on an isolated PATH so no
 * root and no TV is needed. The scripts take their paths from TVPN_* variables
 * for exactly this reason; the defaults are the on-device locations.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const script = (rel) => path.join(ROOT, rel);

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvpn-test-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

/**
 * Stand-ins for mount/mountpoint/umount. "Mounted" is a marker file, and every
 * call is logged so a test can assert what was (and was not) invoked.
 */
function fakeMountTools() {
  const bin = path.join(tmp, 'bin');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  const log = path.join(state, 'log');

  writeExecutable(path.join(bin, 'mountpoint'),
    `#!/bin/sh\n[ -e "${state}/mounted" ]\n`);
  writeExecutable(path.join(bin, 'mount'),
    `#!/bin/sh\necho "mount $*" >> "${log}"\ntouch "${state}/mounted"\n`);
  writeExecutable(path.join(bin, 'umount'),
    `#!/bin/sh\necho "umount $*" >> "${log}"\nrm -f "${state}/mounted"\n`);

  return {
    bin,
    markMounted: () => fs.writeFileSync(path.join(state, 'mounted'), ''),
    isMounted: () => fs.existsSync(path.join(state, 'mounted')),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

describe('tvpn-dns-updown.sh', () => {
  const SCRIPT = script('scripts/tvpn-dns-updown.sh');

  function run(scriptType, foreign, tools) {
    const env = {
      PATH: `${tools.bin}:/usr/bin:/bin`,
      TVPN_RESOLV: path.join(tmp, 'resolv.conf'),
      TVPN_OVERRIDE: path.join(tmp, 'override.conf'),
      script_type: scriptType,
    };
    foreign.forEach((v, i) => { env[`foreign_option_${i + 1}`] = v; });
    return spawnSync('sh', [SCRIPT], { env, encoding: 'utf8' });
  }

  test('up writes the pushed servers and mounts them over resolv.conf', () => {
    const tools = fakeMountTools();

    const res = run('up', [
      'dhcp-option DNS 103.86.96.100',
      'dhcp-option DNS 103.86.99.100',
    ], tools);

    expect(res.status).toBe(0);
    const override = fs.readFileSync(path.join(tmp, 'override.conf'), 'utf8');
    expect(override).toContain('nameserver 103.86.96.100');
    expect(override).toContain('nameserver 103.86.99.100');
    expect(tools.calls()).toEqual([
      `mount --bind ${path.join(tmp, 'override.conf')} ${path.join(tmp, 'resolv.conf')}`,
    ]);
  });

  test('up keeps the servers in the order they were pushed', () => {
    const tools = fakeMountTools();
    run('up', ['dhcp-option DNS 9.9.9.9', 'dhcp-option DNS 1.1.1.1'], tools);

    const lines = fs.readFileSync(path.join(tmp, 'override.conf'), 'utf8')
      .split('\n').filter((l) => l.startsWith('nameserver'));
    expect(lines).toEqual(['nameserver 9.9.9.9', 'nameserver 1.1.1.1']);
  });

  test('up ignores pushed options that are not DNS servers', () => {
    const tools = fakeMountTools();
    run('up', [
      'dhcp-option DOMAIN example.com',
      'dhcp-option DNS 10.8.0.1',
      'dhcp-option WINS 10.8.0.2',
    ], tools);

    const override = fs.readFileSync(path.join(tmp, 'override.conf'), 'utf8');
    expect(override).toContain('nameserver 10.8.0.1');
    expect(override).not.toContain('example.com');
    expect(override).not.toContain('10.8.0.2');
  });

  test('up with no DNS pushed leaves the system resolver alone', () => {
    // Breaking name resolution outright would be worse than not redirecting.
    const tools = fakeMountTools();

    const res = run('up', ['dhcp-option DOMAIN example.com'], tools);

    expect(res.status).toBe(0);
    expect(tools.calls()).toEqual([]);
    expect(tools.isMounted()).toBe(false);
  });

  test('up with nothing pushed at all mounts nothing', () => {
    const tools = fakeMountTools();

    expect(run('up', [], tools).status).toBe(0);
    expect(tools.calls()).toEqual([]);
  });

  test('up when already mounted does not stack a second mount', () => {
    const tools = fakeMountTools();
    tools.markMounted();

    run('up', ['dhcp-option DNS 103.86.96.100'], tools);

    expect(tools.calls()).toEqual([]);
  });

  test('down unmounts the override', () => {
    const tools = fakeMountTools();
    tools.markMounted();

    const res = run('down', [], tools);

    expect(res.status).toBe(0);
    expect(tools.calls()).toEqual([`umount ${path.join(tmp, 'resolv.conf')}`]);
    expect(tools.isMounted()).toBe(false);
  });

  test('down with nothing mounted does nothing and still succeeds', () => {
    // --down also fires after a crash that already cleaned up.
    const tools = fakeMountTools();

    const res = run('down', [], tools);

    expect(res.status).toBe(0);
    expect(tools.calls()).toEqual([]);
  });

  test('an unknown script_type is ignored rather than failing the tunnel', () => {
    const tools = fakeMountTools();

    expect(run('route-up', ['dhcp-option DNS 1.1.1.1'], tools).status).toBe(0);
    expect(tools.calls()).toEqual([]);
  });
});

describe('20-tvpn-perms', () => {
  const SCRIPT = script('scripts/20-tvpn-perms');

  function run(dir) {
    return spawnSync('sh', [SCRIPT], {
      env: { PATH: '/usr/bin:/bin', TVPN_VPN_DIR: dir },
      encoding: 'utf8',
    });
  }

  test('locks down a directory the platform left world-writable', () => {
    // The state the TV reverts to on boot.
    const dir = path.join(tmp, 'vpn');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o777);
    fs.writeFileSync(path.join(dir, '.auth'), 'user\npass\n', { mode: 0o666 });
    fs.chmodSync(path.join(dir, '.auth'), 0o777);
    fs.writeFileSync(path.join(dir, 'br.ovpn'), 'client\n');
    fs.chmodSync(path.join(dir, 'br.ovpn'), 0o777);

    expect(run(dir).status).toBe(0);

    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, '.auth'))).toBe(0o600);
    expect(mode(path.join(dir, 'br.ovpn'))).toBe(0o600);
  });

  test('covers every .ovpn, not just the first', () => {
    const dir = path.join(tmp, 'vpn');
    fs.mkdirSync(dir);
    ['us', 'br', 'de'].forEach((c) => {
      fs.writeFileSync(path.join(dir, `${c}.ovpn`), 'x');
      fs.chmodSync(path.join(dir, `${c}.ovpn`), 0o666);
    });

    run(dir);

    ['us', 'br', 'de'].forEach((c) => {
      expect(mode(path.join(dir, `${c}.ovpn`))).toBe(0o600);
    });
  });

  test('does not invent a credentials file that is not there', () => {
    const dir = path.join(tmp, 'vpn');
    fs.mkdirSync(dir);

    expect(run(dir).status).toBe(0);
    expect(fs.existsSync(path.join(dir, '.auth'))).toBe(false);
  });

  test('a missing directory is not an error at boot', () => {
    expect(run(path.join(tmp, 'absent')).status).toBe(0);
  });
});

describe('install-luna-registration.sh', () => {
  const SCRIPT = script('scripts/install-luna-registration.sh');
  const APP = 'com.tominem.tvpn';
  const SVC = 'com.tominem.tvpn.service';

  function lunaDir() {
    const dir = path.join(tmp, 'luna');
    ['services.d', 'roles.d', 'api-permissions.d', 'client-permissions.d', 'manifests.d']
      .forEach((d) => fs.mkdirSync(path.join(dir, d), { recursive: true }));
    return dir;
  }

  function fakeLsControl() {
    const log = path.join(tmp, 'ls-control.log');
    const bin = path.join(tmp, 'ls-control');
    writeExecutable(bin, `#!/bin/sh\necho "$@" >> "${log}"\n`);
    return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
  }

  function run(dir, lsControl) {
    return spawnSync('sh', [SCRIPT], {
      env: {
        PATH: '/usr/bin:/bin',
        TVPN_LUNA_DIR: dir,
        TVPN_SVC_DIR: path.join(tmp, 'svc'),
        TVPN_LS_CONTROL: lsControl.bin,
      },
      encoding: 'utf8',
    });
  }

  const readJson = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

  test('writes every file the bus needs, and all of it is valid JSON', () => {
    const dir = lunaDir();
    const res = run(dir, fakeLsControl());

    expect(res.status).toBe(0);
    [
      `roles.d/${SVC}.service.json`,
      `roles.d/${APP}.app.json`,
      `api-permissions.d/${SVC}.api.json`,
      `api-permissions.d/${SVC}.api.public.json`,
      `client-permissions.d/${SVC}.service.json`,
      `client-permissions.d/${SVC}.root.json`,
      `client-permissions.d/${APP}.app.json`,
      `manifests.d/${APP}.json`,
    ].forEach((rel) => {
      expect(fs.existsSync(path.join(dir, rel))).toBe(true);
      expect(() => readJson(dir, rel)).not.toThrow();
    });
    expect(fs.existsSync(path.join(dir, `services.d/${SVC}.service`))).toBe(true);
  });

  test('the app is granted the service group under its WAM caller identity', () => {
    // The easy-to-miss part: without this the service answers a root shell but
    // every call from the app itself times out, because WAM calls as
    // "<appId>-<instance>" and nothing granted that identity the group.
    const dir = lunaDir();
    run(dir, fakeLsControl());

    const perms = readJson(dir, `client-permissions.d/${APP}.app.json`);
    expect(perms[`${APP}-*`]).toEqual(expect.arrayContaining(['public', `${SVC}.group`]));

    const role = readJson(dir, `roles.d/${APP}.app.json`);
    expect(role.appId).toBe(APP);
    expect(role.allowedNames).toContain(`${APP}-*`);
  });

  test('the service group actually covers the service methods', () => {
    const dir = lunaDir();
    run(dir, fakeLsControl());

    const api = readJson(dir, `api-permissions.d/${SVC}.api.json`);
    expect(api[`${SVC}.group`]).toContain(`${SVC}/*`);
  });

  test('the manifest lists the app files and every listed file exists', () => {
    const dir = lunaDir();
    run(dir, fakeLsControl());

    const manifest = readJson(dir, `manifests.d/${APP}.json`);
    expect(manifest.id).toBe(APP);
    expect(manifest.roleFiles.some((f) => f.endsWith(`${APP}.app.json`))).toBe(true);
    expect(manifest.clientPermissionFiles.some((f) => f.endsWith(`${APP}.app.json`))).toBe(true);

    const listed = [].concat(
      manifest.serviceFiles,
      manifest.roleFiles,
      manifest.apiPermissionFiles,
      manifest.clientPermissionFiles
    );
    listed.forEach((f) => expect(fs.existsSync(f)).toBe(true));
  });

  test('the service is started on demand through run-js-service', () => {
    const dir = lunaDir();
    run(dir, fakeLsControl());

    const unit = fs.readFileSync(path.join(dir, `services.d/${SVC}.service`), 'utf8');
    expect(unit).toContain(`Name=${SVC}`);
    expect(unit).toContain('Type=dynamic');
    expect(unit).toMatch(/Exec=.*\/run-js-service -n /);
  });

  test('asks the hub to rescan once everything is written', () => {
    const dir = lunaDir();
    const ls = fakeLsControl();
    run(dir, ls);

    expect(ls.calls()).toEqual(['scan-services']);
  });

  test('running it twice is harmless', () => {
    const dir = lunaDir();
    const ls = fakeLsControl();

    expect(run(dir, ls).status).toBe(0);
    const first = fs.readFileSync(path.join(dir, `manifests.d/${APP}.json`), 'utf8');
    expect(run(dir, ls).status).toBe(0);

    expect(fs.readFileSync(path.join(dir, `manifests.d/${APP}.json`), 'utf8')).toBe(first);
  });

  test('refuses to run where the bus directories do not exist', () => {
    // i.e. not a rooted webOS TV; writing elsewhere would silently do nothing.
    const ls = fakeLsControl();
    const res = run(path.join(tmp, 'nowhere'), ls);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('missing');
    expect(ls.calls()).toEqual([]);
  });
});

describe('openvpn-launch.sh', () => {
  const SCRIPT = script('services/openvpn-launch.sh');

  /** A stand-in loader that reports what it was started with. */
  function standInLoader() {
    const dir = path.join(tmp, 'ovpn');
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    writeExecutable(path.join(dir, 'lib', 'ld-musl-armhf.so.1'),
      '#!/bin/sh\necho "LD_PRELOAD=[${LD_PRELOAD-unset}]"\necho "ARGS=$*"\n');
    return dir;
  }

  function run(dir, args, extraEnv) {
    return spawnSync('sh', [SCRIPT].concat(args), {
      env: Object.assign({ PATH: '/usr/bin:/bin', TVPN_OVPN_DIR: dir }, extraEnv),
      encoding: 'utf8',
    });
  }

  test('drops LD_PRELOAD before starting OpenVPN', () => {
    // webOS gives Luna services a glibc LD_PRELOAD; a musl binary dies on it
    // before it can open its log, which leaves no trace at all.
    const dir = standInLoader();

    const res = run(dir, [], { LD_PRELOAD: '/usr/lib/libsystrim.so.3' });

    expect(res.stdout).toContain('LD_PRELOAD=[unset]');
  });

  test('starts OpenVPN through the musl loader with its own libraries', () => {
    const dir = standInLoader();

    const res = run(dir, ['--config', 'br.ovpn']);

    expect(res.stdout).toContain(
      `ARGS=--library-path ${dir}/lib ${dir}/bin/openvpn --config br.ovpn`
    );
  });

  test('forwards arguments containing spaces intact', () => {
    const dir = standInLoader();

    const res = run(dir, ['--log', '/tmp/a b.log']);

    expect(res.stdout).toContain('--log /tmp/a b.log');
  });
});

describe('smoke-test.sh (address and exit status only; the checks need a TV)', () => {
  const SCRIPT = script('scripts/smoke-test.sh');

  /** An ssh that records who it was asked to reach and always fails. */
  function failingSsh() {
    const bin = path.join(tmp, 'sshbin');
    fs.mkdirSync(bin);
    const log = path.join(tmp, 'ssh.log');
    writeExecutable(path.join(bin, 'ssh'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
    return { bin, hosts: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
  }

  function run(args, env) {
    const ssh = failingSsh();
    const res = spawnSync('sh', [SCRIPT].concat(args), {
      env: Object.assign({
        PATH: `${ssh.bin}:/usr/bin:/bin`,
        HOME: tmp,
        TV_CONFIG: path.join(tmp, 'absent.env'),
      }, env),
      encoding: 'utf8',
      timeout: 60000,
    });
    return { res, ssh };
  }

  test('refuses to run with no address, and says how to get one', () => {
    const { res, ssh } = run([], {});

    expect(res.status).toBe(2);
    expect(res.stderr).toContain('No TV address');
    expect(res.stderr).toContain('tv-find.sh');
    expect(ssh.hosts()).toBe('');
  });

  test('takes the address from the first argument', () => {
    const { ssh } = run(['10.9.8.7'], {});

    expect(ssh.hosts()).toContain('root@10.9.8.7');
  });

  test('takes the address from TV_HOST when no argument is given', () => {
    const { ssh } = run([], { TV_HOST: '10.9.8.6' });

    expect(ssh.hosts()).toContain('root@10.9.8.6');
  });

  test('takes the address from the skill config file as a last resort', () => {
    const config = path.join(tmp, 'tv.env');
    fs.writeFileSync(config, 'TV_HOST=10.9.8.5\n');

    const { ssh } = run([], { TV_CONFIG: config });

    expect(ssh.hosts()).toContain('root@10.9.8.5');
  });

  test('an argument beats the environment, which beats the file', () => {
    const config = path.join(tmp, 'tv.env');
    fs.writeFileSync(config, 'TV_HOST=10.0.0.3\n');

    const { ssh } = run(['10.0.0.1'], { TV_CONFIG: config });

    expect(ssh.hosts()).toContain('root@10.0.0.1');
    expect(ssh.hosts()).not.toContain('10.0.0.3');
  });

  test('exits non-zero and reports each failed check when the TV is unhealthy', () => {
    const { res } = run(['10.9.8.7'], {});

    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/FAIL {2}tunnel came up/);
    expect(res.stdout).toMatch(/check\(s\) failed/);
  });
});
