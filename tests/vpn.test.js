/**
 * Unit tests for VPN control logic (vpn.js).
 * child_process and fs are mocked so no real OpenVPN process runs.
 *
 * Connection state lives on disk, not in the instance: the Luna service exits
 * between calls, so these tests model the files rather than object fields.
 */

jest.mock('child_process');
jest.mock('fs');

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const VpnManager = require('../services/vpn');

const BIN = '/media/developer/launch.sh';
const DIR = '/media/developer/vpn';
const PID_PATH = '/tmp/tvpn-openvpn.pid';
const STATE_PATH = '/tmp/tvpn-state.json';
const HOOK_SCRIPT = path.join(__dirname, '..', 'services', 'tvpn-updown.sh');
const KILL_SCRIPT = path.join(__dirname, '..', 'services', 'tvpn-killswitch.sh');
const KILL_MARKER = '/tmp/tvpn-killswitch';

/** connect() also spawns housekeeping commands; find the OpenVPN one. */
function openvpnCall() {
  return spawn.mock.calls.find((c) => c[0] === BIN);
}

function makeMockProcess(pid = 1234) {
  return { pid, kill: jest.fn(), on: jest.fn(), unref: jest.fn() };
}

/** Make the mocked fs behave as if no tunnel is recorded. */
function noTunnel() {
  // Config files exist; the pidfile and any /proc entry do not.
  fs.existsSync.mockImplementation((p) => {
    const path = String(p);
    return !path.startsWith('/proc/') && path !== PID_PATH && path !== KILL_MARKER;
  });
  fs.readFileSync.mockImplementation((p) => {
    if (p === PID_PATH) throw new Error('ENOENT');
    throw new Error('ENOENT: ' + p);
  });
}

/** Make the mocked fs behave as if `pid` is running for `country`. */
function liveTunnel(pid, country) {
  fs.existsSync.mockReturnValue(true);
  fs.readFileSync.mockImplementation((p) => {
    if (p === PID_PATH) return String(pid);
    if (p === STATE_PATH) return JSON.stringify({ country });
    throw new Error('ENOENT: ' + p);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  noTunnel();
  // By default lifting the kill switch works; tests for failure override it.
  spawnSync.mockReset();
  spawnSync.mockReturnValue({ status: 0 });
});

describe('VpnManager.connect()', () => {
  test('spawns openvpn daemonized, with log and pidfile', () => {
    spawn.mockReturnValue(makeMockProcess());

    new VpnManager(BIN, DIR).connect('us');

    expect(spawn).toHaveBeenCalledWith(
      BIN,
      [
        '--config', '/media/developer/vpn/us.ovpn',
        '--auth-user-pass', '/media/developer/vpn/.auth',
        '--log', '/tmp/tvpn-openvpn.log',
        '--writepid', PID_PATH,
        '--script-security', '2',
        '--up', HOOK_SCRIPT,
        '--down', HOOK_SCRIPT,
        '--daemon',
      ],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
  });

  test('detaches the child so it outlives the service process', () => {
    const proc = makeMockProcess();
    spawn.mockReturnValue(proc);

    new VpnManager(BIN, DIR).connect('us');

    expect(proc.unref).toHaveBeenCalled();
  });

  test('strips LD_PRELOAD from the child environment', () => {
    // webOS gives Luna services a glibc LD_PRELOAD. It has to be present here,
    // or there is nothing to strip and this passes whatever the code does.
    const saved = process.env.LD_PRELOAD;
    process.env.LD_PRELOAD = '/usr/lib/libsystrim.so.3';
    try {
      spawn.mockReturnValue(makeMockProcess());

      new VpnManager(BIN, DIR).connect('us');

      const env = openvpnCall()[2].env;
      expect(env).not.toHaveProperty('LD_PRELOAD');
      expect(env).toHaveProperty('PATH'); // the rest of the environment survives
    } finally {
      if (saved === undefined) delete process.env.LD_PRELOAD;
      else process.env.LD_PRELOAD = saved;
    }
  });

  test('passes prefix args ahead of the openvpn options', () => {
    spawn.mockReturnValue(makeMockProcess());

    new VpnManager(BIN, DIR, ['--library-path', '/libs', '/bin/openvpn']).connect('us');

    expect(openvpnCall()[1].slice(0, 3)).toEqual([
      '--library-path', '/libs', '/bin/openvpn',
    ]);
  });

  test('records the selected country on disk', () => {
    spawn.mockReturnValue(makeMockProcess());

    new VpnManager(BIN, DIR).connect('br');

    expect(fs.writeFileSync).toHaveBeenCalledWith(STATE_PATH, JSON.stringify({ country: 'br' }));
  });

  test('returns error when config file does not exist', () => {
    fs.existsSync.mockReturnValue(false);

    const result = new VpnManager(BIN, DIR).connect('xx');

    expect(result).toEqual({ ok: false, error: 'Config not found: /media/developer/vpn/xx.ovpn' });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('returns error when a tunnel is already running', () => {
    liveTunnel(4242, 'us');

    const result = new VpnManager(BIN, DIR).connect('br');

    expect(result).toEqual({ ok: false, error: 'Already connected. Disconnect first.' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('VpnManager.disconnect()', () => {
  test('signals the recorded pid and clears state', () => {
    liveTunnel(4242, 'us');
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {});

    const result = new VpnManager(BIN, DIR).disconnect();

    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(fs.unlinkSync).toHaveBeenCalledWith(PID_PATH);
    expect(result).toEqual({ ok: true });
    kill.mockRestore();
  });

  test('returns error when not connected', () => {
    const result = new VpnManager(BIN, DIR).disconnect();

    expect(result).toEqual({ ok: false, error: 'Not connected.' });
  });
});

describe('resolver override cleanup', () => {
  test('a crashed session has its override dropped on the next status()', () => {
    // Pidfile left behind by a killed OpenVPN: /proc entry gone, file present.
    fs.readFileSync.mockImplementation((p) => {
      if (p === PID_PATH) return '4242';
      throw new Error('ENOENT');
    });
    fs.existsSync.mockImplementation((p) => !String(p).startsWith('/proc/'));
    spawn.mockReturnValue(makeMockProcess());

    new VpnManager(BIN, DIR).status();

    const umount = spawn.mock.calls.find((c) => String(c[1]).includes('umount'));
    expect(umount).toBeDefined();
    expect(String(umount[1])).toContain('/etc/resolv.conf');
  });

  test('status() does not spawn cleanup when nothing was ever recorded', () => {
    new VpnManager(BIN, DIR).status();

    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('VpnManager.status()', () => {
  test('reports disconnected when no pidfile exists', () => {
    expect(new VpnManager(BIN, DIR).status()).toEqual({
      connected: false, blocked: false, country: null, pid: null,
    });
  });

  test('reports the running pid and country', () => {
    liveTunnel(5678, 'br');

    expect(new VpnManager(BIN, DIR).status()).toEqual({
      connected: true, blocked: false, country: 'br', pid: 5678,
    });
  });

  test('reports disconnected when the recorded pid is gone', () => {
    // Pidfile survives, but /proc/<pid> does not: the process has exited.
    fs.readFileSync.mockImplementation((p) => {
      if (p === PID_PATH) return '5678';
      if (p === STATE_PATH) return JSON.stringify({ country: 'br' });
      throw new Error('ENOENT');
    });
    fs.existsSync.mockImplementation((p) => !String(p).startsWith('/proc/') && p !== KILL_MARKER);

    expect(new VpnManager(BIN, DIR).status()).toEqual({
      connected: false, blocked: false, country: null, pid: null,
    });
  });
});

describe('failure handling', () => {
  /** Connects with a stand-in process and returns the handler it registered for 'error'. */
  function spawnErrorHandler() {
    const proc = makeMockProcess();
    spawn.mockReturnValue(proc);
    new VpnManager(BIN, DIR).connect('us');
    return proc.on.mock.calls.find((c) => c[0] === 'error')[1];
  }

  test('a spawn failure is recorded instead of taking the service down', () => {
    // An 'error' event with no listener is an uncaught exception in Node.
    const onError = spawnErrorHandler();

    expect(() => onError(new Error('spawn ENOENT'))).not.toThrow();

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/tmp/tvpn-spawn-error.log',
      expect.stringContaining('spawn ENOENT')
    );
  });

  test('the record names the binary that could not start', () => {
    const onError = spawnErrorHandler();

    onError(new Error('spawn EACCES'));

    expect(fs.appendFileSync.mock.calls[0][1]).toContain(BIN);
  });

  test('failing to write that record does not mask the original failure', () => {
    const onError = spawnErrorHandler();
    fs.appendFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => onError(new Error('spawn ENOENT'))).not.toThrow();
  });

  test('connect reports when it cannot record the session', () => {
    spawn.mockReturnValue(makeMockProcess());
    fs.writeFileSync.mockImplementationOnce(() => { throw new Error('read-only fs'); });

    const result = new VpnManager(BIN, DIR).connect('us');

    expect(result).toEqual({ ok: false, error: 'Failed to record state: read-only fs' });
  });

  test('disconnect reports a process it cannot signal, and still clears state', () => {
    liveTunnel(4242, 'us');
    const kill = jest.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw new Error('ESRCH');
    });

    const result = new VpnManager(BIN, DIR).disconnect();

    expect(result).toEqual({ ok: false, error: 'Failed to stop pid 4242: ESRCH' });
    expect(fs.unlinkSync).toHaveBeenCalledWith(PID_PATH);
    kill.mockRestore();
  });

  test('a live tunnel whose state file lacks a country still reports connected', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockImplementation((p) => {
      if (p === PID_PATH) return '77';
      if (p === STATE_PATH) return JSON.stringify({});
      throw new Error('ENOENT: ' + p);
    });

    expect(new VpnManager(BIN, DIR).status()).toEqual({
      connected: true, blocked: false, country: null, pid: 77,
    });
  });
});

describe('kill switch', () => {
  /** The tunnel died on its own: pidfile left behind, process gone, switch armed. */
  function blockedAfterCrash(options) {
    const o = options || {};
    fs.existsSync.mockImplementation((p) => {
      if (String(p).startsWith('/proc/')) return false;
      if (p === KILL_MARKER) return true;
      if (p === PID_PATH) return o.pidfile !== false;
      return true;
    });
    fs.readFileSync.mockImplementation((p) => {
      if (p === PID_PATH) return '4242';
      if (p === STATE_PATH) {
        if (o.noCountry) throw new Error('ENOENT');
        return JSON.stringify({ country: 'br' });
      }
      throw new Error('ENOENT: ' + p);
    });
  }

  describe('status()', () => {
    test('reports a dead tunnel with the switch armed as blocked, naming the server', () => {
      blockedAfterCrash();

      expect(new VpnManager(BIN, DIR).status()).toEqual({
        connected: false, blocked: true, country: 'br', pid: null,
      });
    });

    test('keeps the country while blocked, so every later check can still name it', () => {
      blockedAfterCrash();

      new VpnManager(BIN, DIR).status();

      expect(fs.unlinkSync).toHaveBeenCalledWith(PID_PATH);
      expect(fs.unlinkSync).not.toHaveBeenCalledWith(STATE_PATH);
    });

    test('still reports blocked on the next check, once the stale pidfile is gone', () => {
      blockedAfterCrash({ pidfile: false });

      expect(new VpnManager(BIN, DIR).status()).toEqual({
        connected: false, blocked: true, country: 'br', pid: null,
      });
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    test('copes with a blocked tunnel whose country was never recorded', () => {
      blockedAfterCrash({ noCountry: true });

      expect(new VpnManager(BIN, DIR).status()).toEqual({
        connected: false, blocked: true, country: null, pid: null,
      });
    });

    test('a dead tunnel with no switch armed is simply disconnected, and fully cleaned up', () => {
      fs.readFileSync.mockImplementation((p) => {
        if (p === PID_PATH) return '4242';
        throw new Error('ENOENT');
      });
      fs.existsSync.mockImplementation((p) => !String(p).startsWith('/proc/') && p !== KILL_MARKER);

      expect(new VpnManager(BIN, DIR).status()).toEqual({
        connected: false, blocked: false, country: null, pid: null,
      });
      expect(fs.unlinkSync).toHaveBeenCalledWith(STATE_PATH);
      expect(fs.unlinkSync).toHaveBeenCalledWith(PID_PATH);
    });

    test('a live tunnel is never reported as blocked', () => {
      liveTunnel(321, 'de');

      expect(new VpnManager(BIN, DIR).status()).toEqual({
        connected: true, blocked: false, country: 'de', pid: 321,
      });
    });
  });

  describe('disconnect()', () => {
    test('lifts the switch after stopping a live tunnel', () => {
      liveTunnel(4242, 'us');
      const kill = jest.spyOn(process, 'kill').mockImplementationOnce(() => {});

      const result = new VpnManager(BIN, DIR).disconnect();

      expect(result).toEqual({ ok: true });
      expect(spawnSync).toHaveBeenCalledWith(KILL_SCRIPT, ['off'], expect.any(Object));
      kill.mockRestore();
    });

    test('is how the user gets internet back when the tunnel already died', () => {
      blockedAfterCrash({ pidfile: false });

      const result = new VpnManager(BIN, DIR).disconnect();

      expect(result).toEqual({ ok: true });
      expect(spawnSync).toHaveBeenCalledWith(KILL_SCRIPT, ['off'], expect.any(Object));
    });

    test('says so when the switch cannot be lifted after a blocked tunnel', () => {
      blockedAfterCrash({ pidfile: false });
      spawnSync.mockReturnValue({ status: 1 });

      expect(new VpnManager(BIN, DIR).disconnect()).toEqual({
        ok: false, error: 'Could not lift the kill switch; traffic is still blocked.',
      });
    });

    test('says so when the switch cannot be lifted after stopping a live tunnel', () => {
      // Reporting plain success here would leave the user offline with no explanation.
      liveTunnel(4242, 'us');
      const kill = jest.spyOn(process, 'kill').mockImplementationOnce(() => {});
      spawnSync.mockReturnValue({ status: 1 });

      expect(new VpnManager(BIN, DIR).disconnect()).toEqual({
        ok: false,
        error: 'Disconnected, but the kill switch could not be lifted; traffic is still blocked.',
      });
      kill.mockRestore();
    });

    test('still lifts the switch when the process cannot be signalled', () => {
      liveTunnel(4242, 'us');
      const kill = jest.spyOn(process, 'kill').mockImplementationOnce(() => { throw new Error('ESRCH'); });

      new VpnManager(BIN, DIR).disconnect();

      expect(spawnSync).toHaveBeenCalledWith(KILL_SCRIPT, ['off'], expect.any(Object));
      kill.mockRestore();
    });

    test('has nothing to lift, and says "not connected", when no switch is armed', () => {
      const result = new VpnManager(BIN, DIR).disconnect();

      expect(result).toEqual({ ok: false, error: 'Not connected.' });
      expect(spawnSync).not.toHaveBeenCalled();
    });
  });

  describe('connect()', () => {
    test('lifts the switch first when reconnecting after the tunnel died', () => {
      // It only lets the old server through; a different country would be unreachable.
      blockedAfterCrash({ pidfile: false });
      spawn.mockReturnValue(makeMockProcess());

      const result = new VpnManager(BIN, DIR).connect('de');

      expect(result).toEqual({ ok: true });
      expect(spawnSync).toHaveBeenCalledWith(KILL_SCRIPT, ['off'], expect.any(Object));
      expect(spawnSync.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]);
    });

    test('does not start OpenVPN if the switch cannot be lifted', () => {
      blockedAfterCrash({ pidfile: false });
      spawnSync.mockReturnValue({ status: 1 });

      const result = new VpnManager(BIN, DIR).connect('de');

      expect(result).toEqual({ ok: false, error: 'Could not lift the kill switch before reconnecting.' });
      expect(spawn).not.toHaveBeenCalled();
    });

    test('leaves the switch alone on an ordinary first connection', () => {
      spawn.mockReturnValue(makeMockProcess());

      new VpnManager(BIN, DIR).connect('us');

      expect(spawnSync).not.toHaveBeenCalled();
    });
  });

  describe('lifting it', () => {
    test('runs synchronously, so "disconnected" is only said once it really is', () => {
      liveTunnel(4242, 'us');
      const kill = jest.spyOn(process, 'kill').mockImplementationOnce(() => {});

      new VpnManager(BIN, DIR).disconnect();

      expect(spawnSync).toHaveBeenCalledTimes(1);
      kill.mockRestore();
    });

    test('runs without the glibc LD_PRELOAD the Luna service carries', () => {
      const saved = process.env.LD_PRELOAD;
      process.env.LD_PRELOAD = '/usr/lib/libsystrim.so.3';
      try {
        liveTunnel(4242, 'us');
        const kill = jest.spyOn(process, 'kill').mockImplementationOnce(() => {});

        new VpnManager(BIN, DIR).disconnect();

        expect(spawnSync.mock.calls[0][2].env).not.toHaveProperty('LD_PRELOAD');
        kill.mockRestore();
      } finally {
        if (saved === undefined) delete process.env.LD_PRELOAD;
        else process.env.LD_PRELOAD = saved;
      }
    });

    test('is bounded in time, so a stuck iptables cannot hang the service', () => {
      liveTunnel(4242, 'us');
      const kill = jest.spyOn(process, 'kill').mockImplementationOnce(() => {});

      new VpnManager(BIN, DIR).disconnect();

      expect(spawnSync.mock.calls[0][2].timeout).toBeGreaterThan(0);
      kill.mockRestore();
    });

    test('counts a spawn that throws as a failure, not a crash', () => {
      blockedAfterCrash({ pidfile: false });
      spawnSync.mockImplementation(() => { throw new Error('EACCES'); });

      expect(new VpnManager(BIN, DIR).disconnect()).toEqual({
        ok: false, error: 'Could not lift the kill switch; traffic is still blocked.',
      });
    });

    test('counts a missing result as a failure', () => {
      blockedAfterCrash({ pidfile: false });
      spawnSync.mockReturnValue(undefined);

      expect(new VpnManager(BIN, DIR).disconnect().ok).toBe(false);
    });
  });
});
