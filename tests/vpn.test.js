/**
 * Unit tests for VPN control logic (vpn.js).
 * The child_process module is mocked so no real OpenVPN process runs.
 */

jest.mock('child_process');
jest.mock('fs');

const { spawn } = require('child_process');
const fs = require('fs');
const VpnManager = require('../services/vpn');

function makeMockProcess(pid = 1234) {
  return {
    pid,
    kill: jest.fn(),
    on: jest.fn(),
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  fs.existsSync.mockReturnValue(true);
});

describe('VpnManager.connect()', () => {
  test('spawns openvpn with correct config path', () => {
    const proc = makeMockProcess();
    spawn.mockReturnValue(proc);

    const vpn = new VpnManager('/media/developer/openvpn', '/media/developer/vpn');
    vpn.connect('us');

    expect(spawn).toHaveBeenCalledWith(
      '/media/developer/openvpn',
      ['--config', '/media/developer/vpn/us.ovpn', '--auth-user-pass', '/media/developer/vpn/.auth'],
      { detached: false }
    );
  });

  test('returns error when config file does not exist', () => {
    fs.existsSync.mockReturnValue(false);

    const vpn = new VpnManager('/media/developer/openvpn', '/media/developer/vpn');
    const result = vpn.connect('xx');

    expect(result).toEqual({ ok: false, error: 'Config not found: /media/developer/vpn/xx.ovpn' });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('returns error when already connected', () => {
    const proc = makeMockProcess();
    spawn.mockReturnValue(proc);

    const vpn = new VpnManager('/media/developer/openvpn', '/media/developer/vpn');
    vpn.connect('us');
    const result = vpn.connect('br');

    expect(result).toEqual({ ok: false, error: 'Already connected. Disconnect first.' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('VpnManager.disconnect()', () => {
  test('kills the running process', () => {
    const proc = makeMockProcess();
    spawn.mockReturnValue(proc);

    const vpn = new VpnManager('/media/developer/openvpn', '/media/developer/vpn');
    vpn.connect('us');
    const result = vpn.disconnect();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toEqual({ ok: true });
  });

  test('returns error when not connected', () => {
    const vpn = new VpnManager('/media/developer/openvpn', '/media/developer/vpn');
    const result = vpn.disconnect();

    expect(result).toEqual({ ok: false, error: 'Not connected.' });
  });
});

describe('VpnManager.status()', () => {
  test('returns disconnected when no process is running', () => {
    const vpn = new VpnManager('/media/developer/openvpn', '/media/developer/vpn');
    expect(vpn.status()).toEqual({ connected: false, country: null, pid: null });
  });

  test('returns connected with country after connect()', () => {
    const proc = makeMockProcess(5678);
    spawn.mockReturnValue(proc);

    const vpn = new VpnManager('/media/developer/openvpn', '/media/developer/vpn');
    vpn.connect('br');

    expect(vpn.status()).toEqual({ connected: true, country: 'br', pid: 5678 });
  });

  test('returns disconnected after process exits', () => {
    const proc = makeMockProcess();
    spawn.mockReturnValue(proc);
    // Capture the 'exit' callback so we can trigger it
    let exitCallback;
    proc.on.mockImplementation((event, cb) => {
      if (event === 'exit') exitCallback = cb;
    });

    const vpn = new VpnManager('/media/developer/openvpn', '/media/developer/vpn');
    vpn.connect('us');
    exitCallback(0);

    expect(vpn.status()).toEqual({ connected: false, country: null, pid: null });
  });
});
