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
  /**
   * Generates the boot runner and EXECUTES it against fake fs and
   * child_process modules, so these tests see what it does rather than what
   * its source text happens to contain. (A text match on the generated source
   * passed with the country-recording line deleted.)
   */
  function runBootRunner(options) {
    const opts = options || {};
    const prefix = opts.prefix || ['--library-path', '/libs', '/bin/openvpn'];
    new VpnManager('/bin/launch', CONFIGS_DIR, prefix).setAutoConnect('br');

    const source = fs.writeFileSync.mock.calls
      .map((c) => String(c[1]))
      .find((body) => body.includes('spawn('));
    expect(source).toBeDefined();

    const spawned = [];
    const written = {};
    const fakeFs = {
      readFileSync: () => JSON.stringify(opts.config ||
        { autoConnect: true, country: 'br' }),
      existsSync: () => true,
      writeFileSync: (file, data) => { written[file] = String(data); },
    };
    const fakeChild = {
      spawn: (bin, args, spawnOpts) => {
        spawned.push({ bin, args, opts: spawnOpts });
        return { unref: () => {} };
      },
    };
    // The real process.exit stops the script, so the fake must too, or the
    // code after an early exit(0) would keep running and spawn anyway. The
    // runner wraps itself in try/catch, which swallows the first throw and
    // calls exit(1); only the FIRST exit call is the decision under test.
    const exitSignal = new Error('process.exit');
    const fakeProcess = {
      env: opts.env || { PATH: '/usr/bin', LD_PRELOAD: '/usr/lib/libsystrim.so.3' },
      exit: jest.fn(() => { throw exitSignal; }),
    };

    try {
      // eslint-disable-next-line no-new-func
      new Function('require', 'process', source)(
        (name) => (name === 'fs' ? fakeFs : fakeChild),
        fakeProcess
      );
    } catch (e) {
      if (e !== exitSignal) throw e;
    }
    return { spawned, written, exit: fakeProcess.exit };
  }

  test('the boot runner records the country, so the UI can show it', () => {
    const { written } = runBootRunner();

    expect(JSON.parse(written['/tmp/tvpn-state.json'])).toEqual({ country: 'br' });
  });

  test('the boot runner carries the DNS hooks, like connect() does', () => {
    // Regression: the runner was built separately from connect() and came up
    // without --up/--down, so an auto-connected tunnel leaked every lookup.
    const { spawned } = runBootRunner();

    expect(spawned).toHaveLength(1);
    const args = spawned[0].args;
    expect(args).toEqual(expect.arrayContaining([
      '--script-security', '2',
      '--up', '/media/developer/ovpn-alpine/tvpn-dns-updown.sh',
      '--down', '/media/developer/ovpn-alpine/tvpn-dns-updown.sh',
      '--daemon',
    ]));
  });

  test('the boot runner launches the same way connect() does', () => {
    const { spawned } = runBootRunner();

    expect(spawned[0].bin).toBe('/bin/launch');
    expect(spawned[0].args.slice(0, 3)).toEqual(['--library-path', '/libs', '/bin/openvpn']);
    expect(spawned[0].args).toEqual(expect.arrayContaining([
      '--config', `${CONFIGS_DIR}/br.ovpn`,
      '--auth-user-pass', `${CONFIGS_DIR}/.auth`,
      '--writepid', '/tmp/tvpn-openvpn.pid',
    ]));
    expect(spawned[0].opts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  test('the boot runner strips LD_PRELOAD from what it starts', () => {
    const { spawned } = runBootRunner();

    expect(spawned[0].opts.env).not.toHaveProperty('LD_PRELOAD');
    expect(spawned[0].opts.env).toHaveProperty('PATH', '/usr/bin');
  });

  test('the boot runner does nothing when auto-connect was turned off', () => {
    const { spawned, written, exit } = runBootRunner({
      config: { autoConnect: false, country: 'br' },
    });

    expect(exit.mock.calls[0]).toEqual([0]);
    expect(spawned).toHaveLength(0);
    expect(written).toEqual({});
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
