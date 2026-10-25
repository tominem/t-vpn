/**
 * Tests for the boot-time auto-connect (services/autoconnect.js).
 *
 * The init.d script runs this file at every boot. It must go through the same
 * VpnManager.connect() as the app, so the tunnel comes up with the DNS hooks
 * and the kill switch, whichever version of the service is installed.
 */
jest.mock('fs');

const fs = require('fs');

const mockVpn = { getAutoConnect: jest.fn(), connect: jest.fn() };

let exit;

beforeEach(() => {
  jest.resetAllMocks();
  fs.appendFileSync.mockImplementation(() => {});
  exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
});

afterEach(() => exit.mockRestore());

/** Runs the boot script once, as the init.d entry does. */
function boot() {
  jest.isolateModules(() => {
    jest.doMock('../services/manager', () => mockVpn);
    require('../services/autoconnect');
  });
}

describe('autoconnect.js', () => {
  test('connects to the saved country', () => {
    mockVpn.getAutoConnect.mockReturnValue({ enabled: true, country: 'br' });
    mockVpn.connect.mockReturnValue({ ok: true });

    boot();

    expect(mockVpn.connect).toHaveBeenCalledWith('br');
    expect(exit).not.toHaveBeenCalled();
  });

  test('does nothing when auto-connect is off', () => {
    mockVpn.getAutoConnect.mockReturnValue({ enabled: false, country: 'br' });

    boot();

    expect(mockVpn.connect).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test('does nothing when no country was saved', () => {
    mockVpn.getAutoConnect.mockReturnValue({ enabled: true, country: null });

    boot();

    expect(mockVpn.connect).not.toHaveBeenCalled();
  });

  test('records why it could not connect, so a silent boot failure can be diagnosed', () => {
    mockVpn.getAutoConnect.mockReturnValue({ enabled: true, country: 'br' });
    mockVpn.connect.mockReturnValue({ ok: false, error: 'Config not found: /x/br.ovpn' });

    boot();

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/tmp/tvpn-autoconnect.log', expect.stringContaining('Config not found: /x/br.ovpn')
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('still exits non-zero when the failure cannot be written down', () => {
    mockVpn.getAutoConnect.mockReturnValue({ enabled: true, country: 'br' });
    mockVpn.connect.mockReturnValue({ ok: false, error: 'boom' });
    fs.appendFileSync.mockImplementation(() => { throw new Error('read-only'); });

    boot();

    expect(exit).toHaveBeenCalledWith(1);
  });
});
