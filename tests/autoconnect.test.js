/**
 * Unit tests for auto-connect persistence in VpnManager.
 */

jest.mock('child_process');
jest.mock('fs');

const fs = require('fs');
const path = require('path');
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
  const BOOT_RUNNER = path.join(__dirname, '..', 'services', 'autoconnect.js');
  const LEGACY_RUNNER = `${CONFIGS_DIR}/autoconnect.js`;

  test('writes config.json with autoConnect=true and country', () => {
    const vpn = new VpnManager('/media/developer/openvpn', CONFIGS_DIR);
    const result = vpn.setAutoConnect('br');

    expect(result).toEqual({ ok: true });

    const written = JSON.parse(fs.writeFileSync.mock.calls
      .find(([p]) => p === CONFIG_PATH)[1]);
    expect(written).toEqual({ autoConnect: true, country: 'br' });
  });

  test('the boot script runs the autoconnect.js that ships with the service', () => {
    new VpnManager('/media/developer/openvpn', CONFIGS_DIR).setAutoConnect('us');

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      STARTUP_PATH, `#!/bin/sh\nnode ${BOOT_RUNNER}\n`
    );
    expect(fs.chmodSync).toHaveBeenCalledWith(STARTUP_PATH, '755');
  });

  test('the boot script carries no OpenVPN paths or flags that an upgrade could leave stale', () => {
    // Regression: the boot runner used to be generated with the binary, hook and
    // flags of the version that wrote it. After an upgrade it still pointed at a
    // directory that no longer existed, so auto-connect silently stopped working.
    new VpnManager('/media/developer/openvpn', CONFIGS_DIR, ['--library-path', '/libs'])
      .setAutoConnect('de');

    const everything = fs.writeFileSync.mock.calls.map((c) => String(c[1])).join('\n');
    expect(everything).not.toMatch(/openvpn|--up|--down|--library-path|ovpn-alpine/);
  });

  test('removes the runner older versions generated into the configs directory', () => {
    new VpnManager('/media/developer/openvpn', CONFIGS_DIR).setAutoConnect('de');

    expect(fs.unlinkSync).toHaveBeenCalledWith(LEGACY_RUNNER);
    expect(fs.writeFileSync.mock.calls.map(([p]) => p)).not.toContain(LEGACY_RUNNER);
  });

  test('still succeeds when there is no old runner to remove', () => {
    fs.unlinkSync.mockImplementation(() => { throw new Error('ENOENT'); });

    expect(new VpnManager('/media/developer/openvpn', CONFIGS_DIR).setAutoConnect('de'))
      .toEqual({ ok: true });
  });
});

describe('VpnManager.clearAutoConnect()', () => {
  test('removes config.json and startup script', () => {
    const vpn = new VpnManager('/media/developer/openvpn', CONFIGS_DIR);
    const result = vpn.clearAutoConnect();

    expect(result).toEqual({ ok: true });
    expect(fs.unlinkSync).toHaveBeenCalledWith(CONFIG_PATH);
    expect(fs.unlinkSync).toHaveBeenCalledWith(STARTUP_PATH);
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${CONFIGS_DIR}/autoconnect.js`);
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

  test('reports enabled with no country when none was stored', () => {
    fs.readFileSync.mockReturnValueOnce(JSON.stringify({ autoConnect: true }));

    expect(new VpnManager('/media/developer/openvpn', CONFIGS_DIR).getAutoConnect())
      .toEqual({ enabled: true, country: null });
  });

  test('returns disabled when config JSON is corrupt', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('not-json{{');
    const vpn = new VpnManager('/media/developer/openvpn', CONFIGS_DIR);
    expect(vpn.getAutoConnect()).toEqual({ enabled: false, country: null });
  });
});
