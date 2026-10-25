/**
 * Guards against code the TV's runtimes cannot run.
 *
 * Both failures this catches are silent on device and invisible to every
 * other test: jsdom runs on a modern Node that happily accepts the syntax,
 * so only parsing against the TV's own grammar notices.
 *
 *  - the app's WAM is Chrome 53, where a binding-less `catch {}` is a parse
 *    error that aborts the whole script (no buttons, nothing defined)
 *  - the service runs on Node 0.12.2, which has no ES6 at all and dies with
 *    "SyntaxError: Unexpected token {" when the hub tries to start it
 */
const fs = require('fs');
const path = require('path');
const espree = require('espree');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function parses(source, ecmaVersion) {
  try {
    espree.parse(source, { ecmaVersion, sourceType: 'script' });
    return null;
  } catch (e) {
    return e.message + ' (line ' + e.lineNumber + ')';
  }
}

describe('frontend runs on WAM (Chrome 53, ES2017)', () => {
  test('main.js parses as ES2017', () => {
    expect(parses(read('frontend/main.js'), 2017)).toBeNull();
  });

  test('the check can tell: a binding-less catch is rejected', () => {
    // Proves the guard is live rather than vacuously passing.
    expect(parses('try {} catch {}', 2017)).not.toBeNull();
  });

  test('the check can tell: optional chaining is rejected', () => {
    expect(parses('var a = b?.c;', 2017)).not.toBeNull();
  });

  test('no webOS SDK global is used, since the app does not bundle it', () => {
    // `webOS` comes from webOSTV.js, which index.html never loads, so every
    // call through it threw. PalmServiceBridge is injected by WAM itself.
    // Tokenised rather than regex-matched so a comment explaining the bug
    // does not trip it; only real code counts.
    const identifiers = espree
      .tokenize(read('frontend/main.js'), { ecmaVersion: 2017 })
      .filter((t) => t.type === 'Identifier')
      .map((t) => t.value);
    expect(identifiers).not.toContain('webOS');
    expect(identifiers).toContain('PalmServiceBridge');
    expect(read('frontend/index.html')).not.toMatch(/webOSTV/);
  });
});

describe('stylesheet works on Chrome 53', () => {
  const css = read('frontend/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');

  test('uses no flexbox gap, which is inert before Chrome 84', () => {
    // Measured on device: it applied 0px, leaving every row flush.
    expect(css).not.toMatch(/(^|[;{\s])(row-|column-)?gap\s*:/);
  });

  test('uses no aspect-ratio, inset or other post-53 layout shorthand', () => {
    expect(css).not.toMatch(/aspect-ratio\s*:/);
    expect(css).not.toMatch(/(^|[;{\s])inset\s*:/);
  });
});

describe('service runs on Node 0.12 (ES5)', () => {
  const files = fs.readdirSync(path.join(ROOT, 'services'))
    .filter((f) => f.endsWith('.js'));

  test('there are service files to check', () => {
    expect(files).toEqual(expect.arrayContaining(['index.js', 'vpn.js']));
  });

  test.each(files)('services/%s parses as ES5', (file) => {
    expect(parses(read(path.join('services', file)), 5)).toBeNull();
  });

  test('the check can tell: const is rejected', () => {
    expect(parses('const x = 1;', 5)).not.toBeNull();
  });

  test('the check can tell: arrow functions are rejected', () => {
    expect(parses('var f = () => 1;', 5)).not.toBeNull();
  });

  test('the generated boot runner is ES5 too', () => {
    // It is built from strings inside vpn.js, so parsing vpn.js proves nothing
    // about it; it runs under the same Node 0.12 at boot.
    jest.resetModules();
    jest.doMock('fs');
    const mockFs = require('fs');
    mockFs.existsSync.mockReturnValue(true);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.chmodSync.mockImplementation(() => {});
    const VpnManager = require('../services/vpn');

    new VpnManager('/bin/x', '/cfg', ['--a', '/b']).setAutoConnect('br');

    const runner = mockFs.writeFileSync.mock.calls
      .map((c) => String(c[1]))
      .find((body) => body.includes('spawn('));
    expect(runner).toBeDefined();
    expect(parses(runner, 5)).toBeNull();

    jest.dontMock('fs');
  });
});
