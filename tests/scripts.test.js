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

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function write(file, data, fileMode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { mode: fileMode || 0o644 });
  return file;
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
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const log = path.join(state, 'log');

  writeExecutable(path.join(bin, 'mountpoint'),
    `#!/bin/sh\n[ -e "${state}/mounted" ]\n`);
  writeExecutable(path.join(bin, 'mount'),
    `#!/bin/sh\necho "mount $*" >> "${log}"\ntouch "${state}/mounted"\n`);
  writeExecutable(path.join(bin, 'umount'),
    `#!/bin/sh\necho "umount $*" >> "${log}"\nrm -f "${state}/mounted"\n`);

  // Stand-ins for the tuning tools, so no test renices a real process. They log
  // apart from mount/umount: a test asserts on one set without the other.
  const tuneLog = path.join(state, 'tune');
  writeExecutable(path.join(bin, 'renice'),
    `#!/bin/sh\necho "renice $*" >> "${tuneLog}"\n`);
  writeExecutable(path.join(bin, 'ip'),
    `#!/bin/sh\necho "ip $*" >> "${tuneLog}"\n`);

  return {
    bin,
    tuneCalls: () => (fs.existsSync(tuneLog) ? fs.readFileSync(tuneLog, 'utf8').trim().split('\n') : []),
    markMounted: () => fs.writeFileSync(path.join(state, 'mounted'), ''),
    isMounted: () => fs.existsSync(path.join(state, 'mounted')),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

describe('tvpn-updown.sh', () => {
  const SCRIPT = script('services/tvpn-updown.sh');

  function run(scriptType, foreign, tools) {
    const env = {
      PATH: `${tools.bin}:/usr/bin:/bin`,
      TVPN_RESOLV: path.join(tmp, 'resolv.conf'),
      TVPN_OVERRIDE: path.join(tmp, 'override.conf'),
      TVPN_ROUTEWATCH_PID: path.join(tmp, 'routewatch.pid'),
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

  describe('tuning the tunnel for the TV', () => {
    const tuneEnv = (tools, extra) => Object.assign({
      PATH: `${tools.bin}:/usr/bin:/bin`,
      TVPN_RESOLV: path.join(tmp, 'resolv.conf'),
      TVPN_OVERRIDE: path.join(tmp, 'override.conf'),
      TVPN_OPENVPN_PID: '4242',
      TVPN_ROUTEWATCH_PID: path.join(tmp, 'routewatch.pid'),
      script_type: 'up',
    }, extra);
    const runWith = (env) => spawnSync('sh', [SCRIPT], { env, encoding: 'utf8' });

    test('up gives OpenVPN a higher priority and the tunnel a longer queue', () => {
      const tools = fakeMountTools();

      const res = runWith(tuneEnv(tools, { dev: 'tun3' }));

      expect(res.status).toBe(0);
      expect(tools.tuneCalls()).toEqual([
        'renice -n -10 -p 4242',
        'ip link set dev tun3 txqueuelen 2000',
      ]);
    });

    test('up falls back to tun0, and the values can be changed', () => {
      const tools = fakeMountTools();

      runWith(tuneEnv(tools, { TVPN_NICE: '-5', TVPN_TXQUEUELEN: '1000' }));

      expect(tools.tuneCalls()).toEqual([
        'renice -n -5 -p 4242',
        'ip link set dev tun0 txqueuelen 1000',
      ]);
    });

    test('up renices its parent, OpenVPN, unless told another pid', () => {
      const tools = fakeMountTools();
      const env = tuneEnv(tools);
      delete env.TVPN_OPENVPN_PID;
      const res = spawnSync('sh', ['-c', `sh "${SCRIPT}"`], { env, encoding: 'utf8' });

      expect(res.status).toBe(0);
      expect(tools.tuneCalls()[0]).toMatch(/^renice -n -10 -p \d+$/);
      expect(tools.tuneCalls()[0]).not.toContain('4242');
    });

    test('up tunes even when the server pushed no DNS', () => {
      const tools = fakeMountTools();

      runWith(tuneEnv(tools));

      expect(tools.calls()).toEqual([]);
      expect(tools.tuneCalls()).toHaveLength(2);
    });

    test('down tunes nothing', () => {
      const tools = fakeMountTools();

      runWith(tuneEnv(tools, { script_type: 'down' }));

      expect(tools.tuneCalls()).toEqual([]);
    });

    test('a failing renice or ip only warns and the tunnel stays up', () => {
      const tools = fakeMountTools();
      writeExecutable(path.join(tools.bin, 'renice'), '#!/bin/sh\nexit 1\n');
      writeExecutable(path.join(tools.bin, 'ip'), '#!/bin/sh\nexit 1\n');

      const res = runWith(tuneEnv(tools, { trusted_ip: '' }));

      expect(res.status).toBe(0);
      expect(res.stderr).toContain('could not raise the priority of OpenVPN');
      expect(res.stderr).toContain('could not lengthen the tunnel\'s transmit queue');
    });
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

describe('tvpn-killswitch.sh', () => {
  const SCRIPT = script('services/tvpn-killswitch.sh');
  const SERVER = '187.15.85.146';
  const RULES = [
    '-A TVPN_KILL -o lo -j ACCEPT',
    '-A TVPN_KILL -o tun+ -j ACCEPT',
    '-A TVPN_KILL -p udp -d 10.0.0.0/8 --dport 53 -j ACCEPT',
    '-A TVPN_KILL -p tcp -d 10.0.0.0/8 --dport 53 -j ACCEPT',
    '-A TVPN_KILL -p udp -d 172.16.0.0/12 --dport 53 -j ACCEPT',
    '-A TVPN_KILL -p tcp -d 172.16.0.0/12 --dport 53 -j ACCEPT',
    '-A TVPN_KILL -p udp -d 192.168.0.0/16 --dport 53 -j ACCEPT',
    '-A TVPN_KILL -p tcp -d 192.168.0.0/16 --dport 53 -j ACCEPT',
    '-A TVPN_KILL -p udp --dport 53 -j DROP',
    '-A TVPN_KILL -p tcp --dport 53 -j DROP',
    `-A TVPN_KILL -d ${SERVER} -j ACCEPT`,
    '-A TVPN_KILL -d 10.0.0.0/8 -j ACCEPT',
    '-A TVPN_KILL -d 172.16.0.0/12 -j ACCEPT',
    '-A TVPN_KILL -d 192.168.0.0/16 -j ACCEPT',
    '-A TVPN_KILL -d 169.254.0.0/16 -j ACCEPT',
    '-A TVPN_KILL -d 224.0.0.0/4 -j ACCEPT',
    '-A TVPN_KILL -d 255.255.255.255 -j ACCEPT',
    '-A TVPN_KILL -j DROP',
  ];

  /**
   * iptables and ip stand-ins with just enough state to be honest: whether the
   * chain exists, how many times it is hooked into OUTPUT, and the rules in it.
   */
  function fakeNetfilter() {
    const bin = path.join(tmp, 'nfbin');
    const state = path.join(tmp, 'nfstate');
    fs.mkdirSync(state, { recursive: true });
    const log = path.join(tmp, 'nf.log');
    write(path.join(state, 'jumps'), '0\n');
    write(path.join(bin, 'iptables'), `#!/bin/sh
echo "iptables $*" >> "${log}"
S="${state}"
if [ -n "$FAIL_ON" ]; then case "$*" in *"$FAIL_ON"*) exit 1 ;; esac; fi
case "$1" in
  -N) [ -e "$S/chain" ] && exit 1; touch "$S/chain"; : > "$S/rules"; exit 0 ;;
  -F) : > "$S/rules"; exit 0 ;;
  -X) rm -f "$S/chain" "$S/rules"; exit 0 ;;
  -A) shift; echo "-A $*" | sed 's/^-A -A /-A /' >> "$S/rules"; exit 0 ;;
  -C) if [ "$(cat "$S/jumps")" -gt 0 ]; then exit 0; else exit 1; fi ;;
  -I) echo $(( $(cat "$S/jumps") + 1 )) > "$S/jumps"; exit 0 ;;
  -D) n=$(cat "$S/jumps"); [ "$n" -gt 0 ] || exit 1; echo $((n - 1)) > "$S/jumps"; exit 0 ;;
esac
exit 0
`, 0o755);
    write(path.join(bin, 'ip'), `#!/bin/sh
echo "ip $*" >> "${log}"
[ -n "$FAIL_IP" ] && exit 1
case "$*" in
  *"route replace blackhole"*) touch "${state}/v6" ;;
  *"route del blackhole"*) rm -f "${state}/v6" ;;
esac
exit 0
`, 0o755);
    return {
      bin,
      setJumps: (n) => fs.writeFileSync(path.join(state, 'jumps'), `${n}\n`),
      jumps: () => parseInt(fs.readFileSync(path.join(state, 'jumps'), 'utf8'), 10),
      rules: () => (fs.existsSync(path.join(state, 'rules'))
        ? fs.readFileSync(path.join(state, 'rules'), 'utf8').trim().split('\n').filter(Boolean) : []),
      chainExists: () => fs.existsSync(path.join(state, 'chain')),
      v6Blackholed: () => fs.existsSync(path.join(state, 'v6')),
      calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
    };
  }

  function run(args, nf, env) {
    return spawnSync('sh', [SCRIPT].concat(args), {
      env: Object.assign({
        PATH: `${nf.bin}:${SYSTEM_PATH}`,
        TVPN_KILL_MARKER: path.join(tmp, 'marker'),
      }, env),
      encoding: 'utf8',
    });
  }
  const marker = () => path.join(tmp, 'marker');

  test('arms: loopback and the tunnel pass, plain DNS is dropped, the LAN and the server pass, the rest is dropped', () => {
    const nf = fakeNetfilter();

    const res = run(['on', SERVER], nf);

    expect(res.status).toBe(0);
    expect(nf.rules()).toEqual(RULES);
  });

  test('drops plain DNS to the internet, but lets the local router answer it', () => {
    // Regression: dropping all plain DNS broke every app that resolves through
    // connmand, which forwards to the router: the IPTV app timed out with 502/504
    // while the tunnel was healthy. Names asked of the router stay on the LAN;
    // anything aimed at a public resolver is still dropped, so none leak out.
    const rules = (() => { const nf = fakeNetfilter(); run(['on', SERVER], nf); return nf.rules(); })();

    const drop = rules.findIndex((r) => r === '-A TVPN_KILL -p udp --dport 53 -j DROP');
    const tun = rules.findIndex((r) => r.includes('-o tun+'));
    const lanDns = rules.map((r, i) => (r.includes('--dport 53 -j ACCEPT') ? i : -1)).filter((i) => i >= 0);
    expect(lanDns).toHaveLength(6);
    lanDns.forEach((i) => {
      expect(i).toBeGreaterThan(tun);
      expect(i).toBeLessThan(drop);
    });
    ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].forEach((net) => {
      expect(rules).toContain(`-A TVPN_KILL -p udp -d ${net} --dport 53 -j ACCEPT`);
      expect(rules).toContain(`-A TVPN_KILL -p tcp -d ${net} --dport 53 -j ACCEPT`);
    });
  });

  test('the very last rule drops everything else', () => {
    const nf = fakeNetfilter();
    run(['on', SERVER], nf);

    expect(nf.rules()[nf.rules().length - 1]).toBe('-A TVPN_KILL -j DROP');
  });

  test('lets the VPN server through, so the tunnel can be re-established', () => {
    const nf = fakeNetfilter();
    run(['on', '203.0.113.9'], nf);

    expect(nf.rules()).toContain('-A TVPN_KILL -d 203.0.113.9 -j ACCEPT');
  });

  test('puts the chain into the path only after it is fully built', () => {
    // A half-built chain in OUTPUT would block traffic it was never meant to.
    const nf = fakeNetfilter();
    run(['on', SERVER], nf);

    const calls = nf.calls();
    const hook = calls.findIndex((c) => c.startsWith('iptables -I OUTPUT 1 -j TVPN_KILL'));
    const lastRule = calls.map((c, i) => (c.startsWith('iptables -A TVPN_KILL') ? i : -1)).reduce((a, b) => Math.max(a, b));
    expect(hook).toBeGreaterThan(lastRule);
  });

  test('blackholes global IPv6, since there is no ip6tables and the tunnel carries only IPv4', () => {
    const nf = fakeNetfilter();

    run(['on', SERVER], nf);

    expect(nf.v6Blackholed()).toBe(true);
    expect(nf.calls()).toContain('ip -6 route replace blackhole 2000::/3');
  });

  test('records that it is armed, with the server', () => {
    const nf = fakeNetfilter();

    run(['on', SERVER], nf);

    expect(fs.readFileSync(marker(), 'utf8').trim()).toBe(SERVER);
  });

  test('arming twice never stacks rules or hooks', () => {
    const nf = fakeNetfilter();

    run(['on', SERVER], nf);
    run(['on', SERVER], nf);

    expect(nf.rules()).toEqual(RULES);
    expect(nf.jumps()).toBe(1);
  });

  test('still arms when the IPv6 route cannot be added', () => {
    const nf = fakeNetfilter();

    const res = run(['on', SERVER], nf, { FAIL_IP: '1' });

    expect(res.status).toBe(0);
    expect(fs.existsSync(marker())).toBe(true);
  });

  test('refuses to arm without a server address, rather than block the handshake', () => {
    const nf = fakeNetfilter();

    const res = run(['on'], nf);

    expect(res.status).toBe(2);
    expect(res.stderr).toContain('usage');
    expect(nf.calls()).toEqual([]);
    expect(fs.existsSync(marker())).toBe(false);
  });

  test('if building the chain fails part way, it undoes everything instead of leaving a half-built one', () => {
    const nf = fakeNetfilter();

    const res = run(['on', SERVER], nf, { FAIL_ON: '-d 10.0.0.0/8' });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('could not arm');
    expect(nf.jumps()).toBe(0);
    expect(nf.chainExists()).toBe(false);
    expect(fs.existsSync(marker())).toBe(false);
  });

  test('if the chain cannot be hooked in, it disarms rather than claim to be armed', () => {
    const nf = fakeNetfilter();

    const res = run(['on', SERVER], nf, { FAIL_ON: '-I OUTPUT' });

    expect(res.status).toBe(1);
    expect(fs.existsSync(marker())).toBe(false);
    expect(nf.chainExists()).toBe(false);
  });

  test('fails loudly when iptables is not installed', () => {
    const nf = fakeNetfilter();
    fs.rmSync(path.join(nf.bin, 'iptables'));
    const hasSystemIptables = spawnSync('sh', ['-c', `PATH=${SYSTEM_PATH} command -v iptables`]).status === 0;
    if (hasSystemIptables) return; // a system iptables would be found instead

    const res = run(['on', SERVER], nf);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('iptables not found');
    expect(fs.existsSync(marker())).toBe(false);
  });

  test('disarms: unhooks, flushes and deletes the chain, restores IPv6, clears the marker', () => {
    const nf = fakeNetfilter();
    run(['on', SERVER], nf);

    const res = run(['off'], nf);

    expect(res.status).toBe(0);
    expect(nf.jumps()).toBe(0);
    expect(nf.chainExists()).toBe(false);
    expect(nf.v6Blackholed()).toBe(false);
    expect(fs.existsSync(marker())).toBe(false);
  });

  test('removes a hook that an interrupted run left in twice', () => {
    const nf = fakeNetfilter();
    nf.setJumps(2);
    write(marker(), `${SERVER}\n`);

    run(['off'], nf);

    expect(nf.jumps()).toBe(0);
  });

  test('disarming when nothing is armed is harmless', () => {
    const nf = fakeNetfilter();

    const res = run(['off'], nf);

    expect(res.status).toBe(0);
    expect(fs.existsSync(marker())).toBe(false);
  });

  test('disarming works even when iptables itself misbehaves', () => {
    // The user must always be able to get their internet back.
    const nf = fakeNetfilter();
    write(marker(), `${SERVER}\n`);

    const res = run(['off'], nf, { FAIL_ON: 'TVPN_KILL' });

    expect(res.status).toBe(0);
    expect(fs.existsSync(marker())).toBe(false);
  });

  test.each([[[]], [['frobnicate']]])('rejects %j with a usage message', (args) => {
    const nf = fakeNetfilter();

    const res = run(args, nf);

    expect(res.status).toBe(2);
    expect(res.stderr).toContain('usage');
  });
});

describe('tvpn-updown.sh and the kill switch', () => {
  const HOOK = script('services/tvpn-updown.sh');

  /** A kill switch stand-in that records how it was called. */
  function fakeKill(extra) {
    const file = path.join(tmp, 'killswitch');
    const log = path.join(tmp, 'kill.log');
    write(file, `#!/bin/sh\necho "$@" >> "${log}"\n${extra || ''}`, 0o755);
    return { file, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
  }

  /** A route watcher stand-in that records how it was started. */
  function fakeWatch(body) {
    const file = path.join(tmp, 'routewatch');
    const log = path.join(tmp, 'watch.log');
    write(file, `#!/bin/sh\necho "$@" >> "${log}"\n${body || ''}`, 0o755);
    return { file, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
  }

  function hook(type, env, kill, watch) {
    watch = watch || fakeWatch();
    const tools = fakeMountTools();
    const res = spawnSync('sh', [HOOK], {
      env: Object.assign({
        PATH: `${tools.bin}:/usr/bin:/bin`,
        TVPN_RESOLV: path.join(tmp, 'resolv.conf'),
        TVPN_OVERRIDE: path.join(tmp, 'override.conf'),
        TVPN_KILLSWITCH: kill.file,
        TVPN_ROUTEWATCH: watch.file,
        TVPN_ROUTEWATCH_PID: path.join(tmp, 'routewatch.pid'),
        script_type: type,
      }, env),
      encoding: 'utf8',
    });
    return { res, tools };
  }

  test('up arms the kill switch for the server OpenVPN connected to', () => {
    const kill = fakeKill();

    hook('up', { trusted_ip: '187.15.85.146', foreign_option_1: 'dhcp-option DNS 1.1.1.1' }, kill);

    expect(kill.calls()).toEqual(['on 187.15.85.146']);
  });

  test('up arms it even when the server pushed no DNS', () => {
    // Regression: the DNS step used to `exit 0` when nothing was pushed, which
    // skipped everything after it, so no DNS pushed meant no kill switch either.
    const kill = fakeKill();

    const { res, tools } = hook('up', { trusted_ip: '187.15.85.146' }, kill);

    expect(res.status).toBe(0);
    expect(tools.calls()).toEqual([]);
    expect(kill.calls()).toEqual(['on 187.15.85.146']);
  });

  test('up does not arm blind when OpenVPN did not say which server it reached', () => {
    // Without the server address the chain could not let the handshake through.
    const kill = fakeKill();

    hook('up', { foreign_option_1: 'dhcp-option DNS 1.1.1.1' }, kill);

    expect(kill.calls()).toEqual([]);
  });

  test('down leaves the kill switch armed: a tunnel that dies must keep traffic blocked', () => {
    const kill = fakeKill();
    const tools = fakeMountTools();
    tools.markMounted();

    const res = spawnSync('sh', [HOOK], {
      env: {
        PATH: `${tools.bin}:/usr/bin:/bin`,
        TVPN_RESOLV: path.join(tmp, 'resolv.conf'),
        TVPN_KILLSWITCH: kill.file,
        TVPN_ROUTEWATCH_PID: path.join(tmp, 'routewatch.pid'),
        script_type: 'down',
        trusted_ip: '187.15.85.146',
      },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(kill.calls()).toEqual([]);
    expect(tools.calls()).toEqual([`umount ${path.join(tmp, 'resolv.conf')}`]);
  });

  test('up still succeeds, and says why, if the kill switch cannot be armed', () => {
    // Tearing the tunnel down over this would be worse than a warning.
    const kill = fakeKill('exit 1\n');

    const { res } = hook('up', { trusted_ip: '187.15.85.146' }, kill);

    expect(res.status).toBe(0);
    expect(res.stderr).toContain('kill switch could not be armed');
  });

  describe('the route watcher', () => {
    function waitFor(check, what) {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        if (check()) return;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      throw new Error(`timed out waiting for ${what}`);
    }
    const alive = (pid) => {
      try { process.kill(pid, 0); return true; } catch (e) { return false; }
    };
    const pidFile = () => path.join(tmp, 'routewatch.pid');
    const readPid = () => Number(fs.readFileSync(pidFile(), 'utf8'));
    // A watcher that stays up, as the real one does, and says which process it is.
    const longLived = () => fakeWatch(`echo $$ > "${path.join(tmp, 'watcher.pid')}"\nexec sleep 30\n`);

    afterEach(() => {
      try { process.kill(readPid()); } catch (e) { /* none left running */ }
    });

    test('up starts it for the server OpenVPN connected to, and for OpenVPN itself', () => {
      const watch = fakeWatch();

      hook('up', { trusted_ip: '187.15.85.146', TVPN_OPENVPN_PID: '4242' }, fakeKill(), watch);

      waitFor(() => watch.calls().length > 0, 'the watcher to start');
      expect(watch.calls()).toEqual(['run 187.15.85.146 4242']);
      expect(fs.existsSync(pidFile())).toBe(true);
    });

    test('up starts it even when the server pushed no DNS', () => {
      const watch = fakeWatch();

      hook('up', { trusted_ip: '187.15.85.146' }, fakeKill(), watch);

      waitFor(() => watch.calls().length > 0, 'the watcher to start');
    });

    test('up does not start it when OpenVPN did not say which server it reached', () => {
      const watch = fakeWatch();

      hook('up', {}, fakeKill(), watch);

      expect(watch.calls()).toEqual([]);
      expect(fs.existsSync(pidFile())).toBe(false);
    });

    test('a second up replaces the watcher instead of stacking another', () => {
      const watch = longLived();
      hook('up', { trusted_ip: '187.15.85.146' }, fakeKill(), watch);
      waitFor(() => fs.existsSync(path.join(tmp, 'watcher.pid')), 'the first watcher');
      const first = readPid();

      hook('up', { trusted_ip: '187.15.85.146' }, fakeKill(), watch);

      waitFor(() => !alive(first), 'the first watcher to stop');
      expect(alive(readPid())).toBe(true);
    });

    test('down stops it', () => {
      const watch = longLived();
      hook('up', { trusted_ip: '187.15.85.146' }, fakeKill(), watch);
      waitFor(() => fs.existsSync(path.join(tmp, 'watcher.pid')), 'the watcher');
      const pid = readPid();

      hook('down', {}, fakeKill(), watch);

      waitFor(() => !alive(pid), 'the watcher to stop');
      expect(fs.existsSync(pidFile())).toBe(false);
    });

    test('down with no watcher running is fine', () => {
      const { res } = hook('down', {}, fakeKill(), fakeWatch());

      expect(res.status).toBe(0);
    });

    test('up still succeeds if the watcher cannot be started', () => {
      const { res } = hook('up', { trusted_ip: '187.15.85.146' }, fakeKill(), { file: path.join(tmp, 'missing') });

      expect(res.status).toBe(0);
    });
  });

  test('finds the kill switch beside itself when not told where it is', () => {
    // As installed on the TV: both scripts in the service directory.
    const dir = path.join(tmp, 'svc');
    fs.mkdirSync(dir);
    fs.copyFileSync(HOOK, path.join(dir, 'tvpn-updown.sh'));
    const log = path.join(tmp, 'sibling.log');
    write(path.join(dir, 'tvpn-killswitch.sh'), `#!/bin/sh\necho "$@" >> "${log}"\n`, 0o755);
    const tools = fakeMountTools();

    spawnSync('sh', [path.join(dir, 'tvpn-updown.sh')], {
      env: {
        PATH: `${tools.bin}:/usr/bin:/bin`,
        TVPN_RESOLV: path.join(tmp, 'resolv.conf'),
        TVPN_OVERRIDE: path.join(tmp, 'override.conf'),
        TVPN_ROUTEWATCH_PID: path.join(tmp, 'routewatch.pid'),
        script_type: 'up',
        trusted_ip: '198.51.100.7',
      },
      encoding: 'utf8',
    });

    expect(fs.readFileSync(log, 'utf8').trim()).toBe('on 198.51.100.7');
  });
});

describe('tvpn-routewatch.sh', () => {
  const SCRIPT = script('services/tvpn-routewatch.sh');
  const SERVER = '198.51.100.7';
  const VIA_TUN = `${SERVER} via 10.100.0.1 dev tun0  src 10.100.0.2\n    cache\n`;
  const VIA_ETH = `${SERVER} via 192.168.1.1 dev eth0  src 192.168.1.15\n    cache\n`;
  const DEFAULT_ETH = 'default via 192.168.1.1 dev eth0\n';

  /**
   * `ip` stand-in. The route lookup answers from a state file, and a replace is
   * logged, makes the lookup answer "physical" from then on (as the kernel
   * would) and, if asked, disarms the kill switch so a looping run ends.
   */
  function fakeIp(opts) {
    const bin = path.join(tmp, 'bin');
    const state = path.join(tmp, 'state');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    const log = path.join(state, 'log');
    write(path.join(state, 'get'), opts.get, 0o644);
    write(path.join(state, 'default'), opts.defaults === undefined ? DEFAULT_ETH : opts.defaults, 0o644);
    writeExecutable(path.join(bin, 'ip'), `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "route get")
    [ -s "${state}/get" ] || exit 2
    cat "${state}/get" ;;
  "route show") cat "${state}/default" ;;
  "route replace")
    ${opts.replaceFails ? 'exit 2' : `printf '%s' '${VIA_ETH}' > "${state}/get"`}
    ${opts.disarmOnReplace ? `rm -f "${opts.disarmOnReplace}"` : ''}
    ;;
esac
`);
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
    return { bin, calls, replaces: () => calls().filter((c) => c.startsWith('route replace')) };
  }

  function run(args, ip, env) {
    return spawnSync('sh', [SCRIPT].concat(args), {
      env: Object.assign({ PATH: `${ip ? `${ip.bin}:` : ''}/usr/bin:/bin` }, env),
      encoding: 'utf8',
      timeout: 15000,
    });
  }

  describe('check', () => {
    test('puts the route to the server back when it is reached through the tunnel', () => {
      const ip = fakeIp({ get: VIA_TUN });

      const res = run(['check', SERVER], ip);

      expect(res.status).toBe(0);
      expect(ip.replaces()).toEqual([`route replace ${SERVER}/32 via 192.168.1.1 dev eth0`]);
      expect(res.stderr).toContain('put the route to the VPN server back via 192.168.1.1 on eth0');
    });

    test('leaves a route that already goes over the physical network alone', () => {
      const ip = fakeIp({ get: VIA_ETH });

      const res = run(['check', SERVER], ip);

      expect(res.status).toBe(0);
      expect(ip.replaces()).toEqual([]);
      expect(res.stderr).toBe('');
    });

    test('does nothing when the server cannot be looked up at all', () => {
      const ip = fakeIp({ get: '' });

      const res = run(['check', SERVER], ip);

      expect(res.status).toBe(0);
      expect(ip.replaces()).toEqual([]);
    });

    test('waits when there is no physical default route yet', () => {
      const ip = fakeIp({ get: VIA_TUN, defaults: '' });

      const res = run(['check', SERVER], ip);

      expect(res.status).toBe(0);
      expect(ip.replaces()).toEqual([]);
    });

    test('never uses a default route that enters a tunnel as the way out', () => {
      const ip = fakeIp({ get: VIA_TUN, defaults: 'default via 10.100.0.1 dev tun0\n' });

      run(['check', SERVER], ip);

      expect(ip.replaces()).toEqual([]);
    });

    test('takes the physical default among others, whatever extra fields it has', () => {
      const ip = fakeIp({
        get: VIA_TUN,
        defaults: 'default via 10.100.0.1 dev tun0\ndefault via 192.168.7.1 dev wlan0 proto dhcp metric 600\n',
      });

      run(['check', SERVER], ip);

      expect(ip.replaces()).toEqual([`route replace ${SERVER}/32 via 192.168.7.1 dev wlan0`]);
    });

    test('says nothing, and still succeeds, if the route cannot be replaced', () => {
      const ip = fakeIp({ get: VIA_TUN, replaceFails: true });

      const res = run(['check', SERVER], ip);

      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
    });

    test('is idempotent: a second pass finds the route right', () => {
      const ip = fakeIp({ get: VIA_TUN });

      run(['check', SERVER], ip);
      run(['check', SERVER], ip);

      expect(ip.replaces()).toHaveLength(1);
    });
  });

  describe('run', () => {
    const marker = () => path.join(tmp, 'killswitch');
    const env = () => ({ TVPN_KILL_MARKER: marker(), TVPN_ROUTEWATCH_INTERVAL: '1' });

    test('returns at once when the kill switch is not armed', () => {
      const ip = fakeIp({ get: VIA_TUN });

      const res = run(['run', SERVER, String(process.pid)], ip, env());

      expect(res.status).toBe(0);
      expect(ip.calls()).toEqual([]);
    });

    test('returns when OpenVPN is gone', () => {
      const ip = fakeIp({ get: VIA_TUN });
      fs.writeFileSync(marker(), `${SERVER}\n`);
      const gone = spawnSync('true').pid;

      const res = run(['run', SERVER, String(gone)], ip, env());

      expect(res.status).toBe(0);
      expect(ip.calls()).toEqual([]);
    });

    test('keeps checking while OpenVPN runs, and stops when the kill switch is disarmed', () => {
      const ip = fakeIp({ get: VIA_TUN, disarmOnReplace: marker() });
      fs.writeFileSync(marker(), `${SERVER}\n`);

      const res = run(['run', SERVER, String(process.pid)], ip, env());

      expect(res.status).toBe(0);
      expect(ip.replaces()).toEqual([`route replace ${SERVER}/32 via 192.168.1.1 dev eth0`]);
    });
  });

  test('asks for what it needs', () => {
    expect(run(['check'], null).status).toBe(2);
    expect(run(['run', SERVER], null).status).toBe(2);
    expect(run([], null).status).toBe(2);
    expect(run(['bogus'], null).stderr).toContain('usage:');
  });
});
