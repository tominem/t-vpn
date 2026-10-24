/**
 * Unit tests for VPN control logic (vpn.js).
 * child_process and fs are mocked so no real OpenVPN process runs.
 *
 * Connection state lives on disk, not in the instance: the Luna service exits
 * between calls, so these tests model the files rather than object fields.
 */

jest.mock('child_process');
jest.mock('fs');

const { spawn } = require('child_process');
const fs = require('fs');
const VpnManager = require('../services/vpn');

const BIN = '/media/developer/launch.sh';
const DIR = '/media/developer/vpn';
const PID_PATH = '/tmp/tvpn-openvpn.pid';
const STATE_PATH = '/tmp/tvpn-state.json';

function makeMockProcess(pid = 1234) {
  return { pid, kill: jest.fn(), on: jest.fn(), unref: jest.fn() };
}

/** Make the mocked fs behave as if no tunnel is recorded. */
function noTunnel() {
  fs.existsSync.mockImplementation((p) => !String(p).startsWith('/proc/'));
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
    spawn.mockReturnValue(makeMockProcess());

    new VpnManager(BIN, DIR).connect('us');

    const env = spawn.mock.calls[0][2].env;
    expect(env).not.toHaveProperty('LD_PRELOAD');
  });

  test('passes prefix args ahead of the openvpn options', () => {
    spawn.mockReturnValue(makeMockProcess());

    new VpnManager(BIN, DIR, ['--library-path', '/libs', '/bin/openvpn']).connect('us');

    expect(spawn.mock.calls[0][1].slice(0, 3)).toEqual([
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

describe('VpnManager.status()', () => {
  test('reports disconnected when no pidfile exists', () => {
    expect(new VpnManager(BIN, DIR).status()).toEqual({
      connected: false, country: null, pid: null,
    });
  });

  test('reports the running pid and country', () => {
    liveTunnel(5678, 'br');

    expect(new VpnManager(BIN, DIR).status()).toEqual({
      connected: true, country: 'br', pid: 5678,
    });
  });

  test('reports disconnected when the recorded pid is gone', () => {
    // Pidfile survives, but /proc/<pid> does not: the process has exited.
    fs.readFileSync.mockImplementation((p) => {
      if (p === PID_PATH) return '5678';
      if (p === STATE_PATH) return JSON.stringify({ country: 'br' });
      throw new Error('ENOENT');
    });
    fs.existsSync.mockImplementation((p) => !String(p).startsWith('/proc/'));

    expect(new VpnManager(BIN, DIR).status()).toEqual({
      connected: false, country: null, pid: null,
    });
  });
});
