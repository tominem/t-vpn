/**
 * Unit tests for auto-connect persistence in VpnManager.
 */

jest.mock('child_process');
jest.mock('fs');

const fs = require('fs');
const VpnManager = require('../services/vpn');

const CONFIGS_DIR = '/media/developer/vpn';
const CONFIG_PATH = `${CONFIGS_DIR}/config.json`;
const STARTUP_PATH = '/var/lib/webosbrew/init.d/99-tvpn';

beforeEach(() => {
  jest.clearAllMocks();
  fs.existsSync.mockReturnValue(true);
  fs.writeFileSync.mockImplementation(() => {});
  fs.unlinkSync.mockImplementation(() => {});
  fs.chmodSync.mockImplementation(() => {});
});

describe('VpnManager.setAutoConnect()', () => {
  test('the boot runner records the country, so the UI can show it', () => {
    new VpnManager('/media/developer/openvpn', CONFIGS_DIR).setAutoConnect('br');

    const runner = fs.writeFileSync.mock.calls
      .map((c) => String(c[1]))
      .find((body) => body.includes('spawn('));

    expect(runner).toContain('/tmp/tvpn-state.json');
    expect(runner).toContain('country: c.country');
  });

  test('the boot runner carries the DNS hooks, like connect() does', () => {
    // Regression: the runner was built separately from connect() and came up
    // without --up/--down, so an auto-connected tunnel leaked every lookup.
    new VpnManager('/media/developer/openvpn', CONFIGS_DIR).setAutoConnect('br');

    const runner = fs.writeFileSync.mock.calls
      .map((c) => String(c[1]))
      .find((body) => body.includes('spawn('));

    expect(runner).toBeDefined();
    expect(runner).toContain('--script-security');
    expect(runner).toContain('--up');
    expect(runner).toContain('--down');
    expect(runner).toContain('tvpn-dns-updown.sh');
  });

  test('writes config.json with autoConnect=true and country', () => {
    const vpn = new VpnManager('/media/developer/openvpn', CONFIGS_DIR);
    const result = vpn.setAutoConnect('br');

    expect(result).toEqual({ ok: true });

    const written = JSON.parse(fs.writeFileSync.mock.calls
      .find(([p]) => p === CONFIG_PATH)[1]);
    expect(written).toEqual({ autoConnect: true, country: 'br' });
  });

  test('creates executable startup script at HBC init.d path', () => {
    const vpn = new VpnManager('/media/developer/openvpn', CONFIGS_DIR);
    vpn.setAutoConnect('us');

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      STARTUP_PATH,
      expect.stringContaining('autoconnect.js')
    );
    expect(fs.chmodSync).toHaveBeenCalledWith(STARTUP_PATH, '755');
  });

  test('writes autoconnect.js runner script to configs dir', () => {
    const vpn = new VpnManager('/media/developer/openvpn', CONFIGS_DIR);
    vpn.setAutoConnect('de');

    const runnerCall = fs.writeFileSync.mock.calls
      .find(([p]) => p === `${CONFIGS_DIR}/autoconnect.js`);
    expect(runnerCall).toBeTruthy();
    expect(runnerCall[1]).toContain('openvpn');
  });
});

describe('VpnManager.clearAutoConnect()', () => {
  test('removes config.json and startup script', () => {
    const vpn = new VpnManager('/media/developer/openvpn', CONFIGS_DIR);
    const result = vpn.clearAutoConnect();

    expect(result).toEqual({ ok: true });
    expect(fs.unlinkSync).toHaveBeenCalledWith(CONFIG_PATH);
    expect(fs.unlinkSync).toHaveBeenCalledWith(STARTUP_PATH);
  });

  test('returns ok even if files do not exist', () => {
    fs.unlinkSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const vpn = new VpnManager('/media/developer/openvpn', CONFIGS_DIR);
    const result = vpn.clearAutoConnect();
    expect(result).toEqual({ ok: true });
  });
});

describe('VpnManager.getAutoConnect()', () => {
  test('returns disabled state when no config file', () => {
    fs.existsSync.mockReturnValue(false);
    const vpn = new VpnManager('/media/developer/openvpn', CONFIGS_DIR);
    expect(vpn.getAutoConnect()).toEqual({ enabled: false, country: null });
  });

  test('returns enabled=true and country from config file', () => {
    fs.existsSync.mockImplementation((p) => p === CONFIG_PATH);
    fs.readFileSync.mockReturnValue(JSON.stringify({ autoConnect: true, country: 'jp' }));
    const vpn = new VpnManager('/media/developer/openvpn', CONFIGS_DIR);
    expect(vpn.getAutoConnect()).toEqual({ enabled: true, country: 'jp' });
  });

  test('returns disabled when config JSON is corrupt', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('not-json{{');
    const vpn = new VpnManager('/media/developer/openvpn', CONFIGS_DIR);
    expect(vpn.getAutoConnect()).toEqual({ enabled: false, country: null });
  });
});
