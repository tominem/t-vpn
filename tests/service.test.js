/**
 * Tests for the Luna service entry point (services/index.js).
 *
 * `webos-service` only exists on the TV, so it is replaced with a stand-in that
 * records the handlers the service registers; the VPN manager is replaced with
 * stubs so each method's request validation and response mapping is tested on
 * its own. The manager's own behaviour is covered in vpn.test.js.
 */
const path = require('path');

const mockHandlers = {};
const mockVpn = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  status: jest.fn(),
  setAutoConnect: jest.fn(),
  clearAutoConnect: jest.fn(),
  getAutoConnect: jest.fn(),
};

jest.mock('webos-service', () => jest.fn(function Service() {
  this.register = (name, fn) => { mockHandlers[name] = fn; };
}), { virtual: true });
jest.mock('../services/vpn', () => jest.fn(() => mockVpn));

const Service = require('webos-service');
const VpnManager = require('../services/vpn');

// Captured at load: the beforeEach below resets the stubs, not these.
require('../services/index');
const serviceCtorCalls = Service.mock.calls.slice();
const vpnCtorCalls = VpnManager.mock.calls.slice();

beforeEach(() => {
  Object.keys(mockVpn).forEach((m) => mockVpn[m].mockReset());
});

/** Invokes a registered method the way the Luna hub does, returning the reply. */
function call(method, payload) {
  const respond = jest.fn();
  mockHandlers[method]({ payload, respond });
  expect(respond).toHaveBeenCalledTimes(1);
  return respond.mock.calls[0][0];
}

describe('registration', () => {
  test('registers under the service name the app and the hub expect', () => {
    expect(serviceCtorCalls).toHaveLength(1);
    expect(serviceCtorCalls[0][0]).toBe('com.tominem.tvpn.service');
  });

  test('stays warm for longer than the interval at which the app checks status', () => {
    // Otherwise every check would cold-start the service (about 1.5 s of CPU each
    // on the TV) and the service would be restarting continuously while the app
    // is open. Tied to the app's real interval rather than a copy of the number.
    const main = require('fs').readFileSync(path.join(__dirname, '..', 'frontend', 'main.js'), 'utf8');
    const pollMs = Number(/const POLL_MS = (\d+);/.exec(main)[1]);

    const options = serviceCtorCalls[0][2];

    expect(options).toEqual({ idleTimer: expect.any(Number) });
    expect(options.idleTimer * 1000).toBeGreaterThan(pollMs);
  });

  test('registers exactly the five methods the app calls', () => {
    expect(Object.keys(mockHandlers).sort()).toEqual(
      ['connect', 'disconnect', 'getAutoConnect', 'setAutoConnect', 'status']
    );
  });

  test('starts OpenVPN through the launcher next to it, not the bare binary', () => {
    // The launcher drops LD_PRELOAD and closes inherited descriptors; bypassing
    // it makes the tunnel die silently or wedge the service.
    const [binary, configsDir] = vpnCtorCalls[0];
    expect(binary).toBe(path.join(__dirname, '..', 'services', 'openvpn-launch.sh'));
    expect(configsDir).toBe('/media/developer/vpn');
  });
});

describe('connect', () => {
  test('lower-cases the country and forwards it', () => {
    mockVpn.connect.mockReturnValue({ ok: true });

    const reply = call('connect', { country: 'BR' });

    expect(mockVpn.connect).toHaveBeenCalledWith('br');
    expect(reply).toEqual({ returnValue: true, ok: true });
  });

  test('passes a refusal through with its reason', () => {
    mockVpn.connect.mockReturnValue({ ok: false, error: 'Already connected. Disconnect first.' });

    expect(call('connect', { country: 'us' })).toEqual({
      returnValue: false, ok: false, error: 'Already connected. Disconnect first.',
    });
  });

  test.each([
    ['absent', {}],
    ['empty', { country: '' }],
    ['a number', { country: 7 }],
    ['an object', { country: { code: 'us' } }],
  ])('rejects a country that is %s without calling the manager', (_label, payload) => {
    expect(call('connect', payload)).toEqual({
      returnValue: false, error: 'Missing required field: country',
    });
    expect(mockVpn.connect).not.toHaveBeenCalled();
  });
});

describe('disconnect', () => {
  test('reports success', () => {
    mockVpn.disconnect.mockReturnValue({ ok: true });

    expect(call('disconnect', {})).toEqual({ returnValue: true, ok: true });
  });

  test('reports why it could not', () => {
    mockVpn.disconnect.mockReturnValue({ ok: false, error: 'Not connected.' });

    expect(call('disconnect', {})).toEqual({
      returnValue: false, ok: false, error: 'Not connected.',
    });
  });
});

describe('status', () => {
  test('reports a live tunnel', () => {
    mockVpn.status.mockReturnValue({ connected: true, country: 'de', pid: 321 });

    expect(call('status', {})).toEqual({
      returnValue: true, connected: true, country: 'de', pid: 321,
    });
  });

  test('reports a tunnel that died with the kill switch holding traffic', () => {
    // The app needs this to tell "blocked on purpose" from "internet is down".
    mockVpn.status.mockReturnValue({ connected: false, blocked: true, country: 'br', pid: null });

    expect(call('status', {})).toEqual({
      returnValue: true, connected: false, blocked: true, country: 'br', pid: null,
    });
  });

  test('reports no tunnel', () => {
    mockVpn.status.mockReturnValue({ connected: false, country: null, pid: null });

    expect(call('status', {})).toEqual({
      returnValue: true, connected: false, country: null, pid: null,
    });
  });
});

describe('setAutoConnect', () => {
  test('saves the country, lower-cased', () => {
    mockVpn.setAutoConnect.mockReturnValue({ ok: true });

    const reply = call('setAutoConnect', { enabled: true, country: 'DE' });

    expect(mockVpn.setAutoConnect).toHaveBeenCalledWith('de');
    expect(reply).toEqual({ returnValue: true, ok: true });
  });

  test('treats a missing "enabled" as turning it on', () => {
    mockVpn.setAutoConnect.mockReturnValue({ ok: true });

    call('setAutoConnect', { country: 'jp' });

    expect(mockVpn.setAutoConnect).toHaveBeenCalledWith('jp');
    expect(mockVpn.clearAutoConnect).not.toHaveBeenCalled();
  });

  test('turning it off needs no country', () => {
    mockVpn.clearAutoConnect.mockReturnValue({ ok: true });

    const reply = call('setAutoConnect', { enabled: false });

    expect(mockVpn.clearAutoConnect).toHaveBeenCalledTimes(1);
    expect(mockVpn.setAutoConnect).not.toHaveBeenCalled();
    expect(reply).toEqual({ returnValue: true, ok: true });
  });

  test('turning it off reports a failure to clear', () => {
    mockVpn.clearAutoConnect.mockReturnValue({ ok: false, error: 'busy' });

    expect(call('setAutoConnect', { enabled: false })).toEqual({
      returnValue: false, ok: false, error: 'busy',
    });
  });

  test.each([
    ['absent', { enabled: true }],
    ['empty', { enabled: true, country: '' }],
    ['not a string', { enabled: true, country: 42 }],
  ])('rejects a country that is %s without saving anything', (_label, payload) => {
    expect(call('setAutoConnect', payload)).toEqual({
      returnValue: false, error: 'Missing required field: country',
    });
    expect(mockVpn.setAutoConnect).not.toHaveBeenCalled();
  });

  test('reports a failure to save', () => {
    mockVpn.setAutoConnect.mockReturnValue({ ok: false, error: 'read-only filesystem' });

    expect(call('setAutoConnect', { enabled: true, country: 'us' })).toEqual({
      returnValue: false, ok: false, error: 'read-only filesystem',
    });
  });
});

describe('getAutoConnect', () => {
  test('reports the stored setting', () => {
    mockVpn.getAutoConnect.mockReturnValue({ enabled: true, country: 'br' });

    expect(call('getAutoConnect', {})).toEqual({
      returnValue: true, enabled: true, country: 'br',
    });
  });

  test('reports it off', () => {
    mockVpn.getAutoConnect.mockReturnValue({ enabled: false, country: null });

    expect(call('getAutoConnect', {})).toEqual({
      returnValue: true, enabled: false, country: null,
    });
  });
});
