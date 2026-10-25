/**
 * Tests for the mutation harness itself (scripts/mutation-check.py).
 *
 * A tool that decides whether the tests can be trusted needs to be trustworthy:
 * which mutations --changed picks, that a run never touches the real files, and
 * that "caught", "survived" and "unclear" are told apart correctly.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'mutation-check.py');

/** Runs `body` (Python) with the harness imported as `m`; returns parsed JSON it prints. */
function py(body, cwd) {
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(SCRIPT)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    body,
  ].join('\n');
  const res = spawnSync('python3', ['-I', '-c', code], { cwd: cwd || ROOT, encoding: 'utf8', timeout: 240000 });
  if (res.status !== 0) throw new Error(res.stderr || res.stdout);
  return res.stdout;
}

const json = (body) => JSON.parse(py(body).trim().split('\n').pop());

describe('which mutations --changed picks', () => {
  const M = (name, file, tests) => `("${name}", "${file}", "a", "b"${tests ? `, ${JSON.stringify(tests)}` : ''})`;

  test('those whose target file changed', () => {
    const picked = json(`
ms = [${M('x', 'services/vpn.js')}, ${M('y', 'frontend/main.js')}]
print(json.dumps([n[0] for n in m.select(ms, ["services/vpn.js"])]))`);

    expect(picked).toEqual(['x']);
  });

  test('those whose tests changed, since a weakened test can let a bug through', () => {
    const picked = json(`
ms = [${M('x', 'services/vpn.js', ['tests/vpn.test.js'])}, ${M('y', 'frontend/main.js', ['tests/frontend.test.js'])}]
print(json.dumps([n[0] for n in m.select(ms, ["tests/vpn.test.js"])]))`);

    expect(picked).toEqual(['x']);
  });

  test('uses the default tests for a file when a mutation names none', () => {
    const picked = json(`
ms = [${M('x', 'frontend/main.js')}]
print(json.dumps([n[0] for n in m.select(ms, ["tests/frontend.test.js"])]))`);

    expect(picked).toEqual(['x']);
  });

  test('none when nothing relevant changed', () => {
    const picked = json(`
ms = [${M('x', 'services/vpn.js', ['tests/vpn.test.js'])}]
print(json.dumps(m.select(ms, ["README.md"])))`);

    expect(picked).toEqual([]);
  });

  test('every real mutation is selected when its own file changes', () => {
    const missed = json(`
bad = [mu[0] for mu in m.MUTATIONS if mu not in m.select(m.MUTATIONS, [mu[1]])]
print(json.dumps(bad))`);

    expect(missed).toEqual([]);
  });
});

describe('arguments', () => {
  const args = (argv) => json(`print(json.dumps(list(m.parse_args(${JSON.stringify(argv)}))))`);

  test('defaults to everything, with a sensible number of jobs', () => {
    const [changed, ref, jobs] = args([]);

    expect(changed).toBe(false);
    expect(ref).toBeNull();
    expect(jobs).toBeGreaterThanOrEqual(1);
    expect(jobs).toBeLessThanOrEqual(4);
  });

  test('--changed alone, and with a ref', () => {
    expect(args(['--changed']).slice(0, 2)).toEqual([true, null]);
    expect(args(['--changed', 'main']).slice(0, 2)).toEqual([true, 'main']);
    expect(args(['--changed', '--jobs', '2'])).toEqual([true, null, 2]);
  });

  test.each([['--jobs'], ['--jobs', '0'], ['--jobs', 'x'], ['--nope']])('rejects %s', (...argv) => {
    expect(() => args(argv)).toThrow(/usage/);
  });
});

describe('judging a run', () => {
  const judge = (code, out) => py(`print(m.judge(${code}, ${JSON.stringify(out)}))`).trim();

  test('a failing run is a catch', () => expect(judge(1, 'Expected: 1\nReceived: 2')).toBe('caught'));
  test('a passing run is a survivor', () => expect(judge(0, '')).toBe('survived'));
  test('a run that timed out proves nothing', () => expect(judge('None', '')).toBe('inconclusive'));
  test('failing only by exceeding a test timeout is not a catch', () => {
    expect(judge(1, 'thrown: "Exceeded timeout of 5000 ms for a test."')).toBe('inconclusive');
  });
  test('a timeout next to a real assertion failure still is a catch', () => {
    expect(judge(1, 'Exceeded timeout of 5000 ms\nExpected: 1\nReceived: 2')).toBe('caught');
  });
});

describe('a real run on a small project', () => {
  let project;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'mutfix-'));
    fs.mkdirSync(path.join(project, 'src'));
    fs.mkdirSync(path.join(project, 'tests'));
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ jest: { testEnvironment: 'node' } }));
    fs.writeFileSync(path.join(project, 'src/a.js'), 'exports.add = (a, b) => a + b;\nexports.neg = (a) => -a;\n');
    fs.writeFileSync(path.join(project, 'tests/a.test.js'),
      'const a = require(\'../src/a\');\ntest(\'add\', () => expect(a.add(2, 3)).toBe(5));\n');
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(project, 'node_modules'));
  });

  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  const run = (jobs) => JSON.parse(py(`
m.REPO = ${JSON.stringify(project)}
ms = [
  ("add is wrong", "src/a.js", "a + b", "a - b", ["tests/a.test.js"]),
  ("neg is untested", "src/a.js", "-a", "a", ["tests/a.test.js"]),
  ("moved code", "src/a.js", "no such text", "x", ["tests/a.test.js"]),
]
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    status = m.run_mutations(ms, ${jobs})
print(json.dumps({"status": status, "out": buf.getvalue()}))`));

  test('tells caught, survived and moved-anchor apart, and leaves the real files alone', () => {
    const before = fs.readFileSync(path.join(project, 'src/a.js'), 'utf8');

    const { status, out } = run(2);

    expect(out).toMatch(/CAUGHT\s+add is wrong/);
    expect(out).toMatch(/SURVIVED\s+neg is untested/);
    expect(out).toMatch(/BAD ANCHOR\s+moved code/);
    expect(out).toContain('SURVIVOR: neg is untested');
    expect(out).toContain('caught 1 / 3');
    expect(status).toBe(1);
    expect(fs.readFileSync(path.join(project, 'src/a.js'), 'utf8')).toBe(before);
  });

  test('works one at a time too, and removes its scratch copies', () => {
    const scratchBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('tvpn-mutation-'));

    const { out } = run(1);

    expect(out).toMatch(/CAUGHT\s+add is wrong/);
    const scratchAfter = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('tvpn-mutation-'));
    expect(scratchAfter).toEqual(scratchBefore);
  });

  test('a mutation the narrow run misses is retried against the whole suite', () => {
    // The narrowing is only for speed: a "survivor" must have beaten every test.
    fs.writeFileSync(path.join(project, 'tests/b.test.js'),
      'const a = require(\'../src/a\');\ntest(\'neg\', () => expect(a.neg(4)).toBe(-4));\n');

    const { out } = JSON.parse(py(`
m.REPO = ${JSON.stringify(project)}
m.FILTERS = {"src/a.js": "a pattern no test has"}
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    status = m.run_mutations([("neg is wrong", "src/a.js", "-a", "a", ["tests/a.test.js"])], 1)
print(json.dumps({"status": status, "out": buf.getvalue()}))`));

    expect(out).toMatch(/CAUGHT\s+neg is wrong/);
  });

  test('refuses to mutate when the tests are already failing', () => {
    fs.writeFileSync(path.join(project, 'tests/a.test.js'), 'test(\'red\', () => expect(1).toBe(2));\n');

    const { status, out } = run(1);

    expect(status).toBe(2);
    expect(out).toContain('BASELINE IS RED');
  });
});

describe('the copy never carries secrets', () => {
  test('wireguard/ is not copied', () => {
    const out = py('print(m.COPY_IGNORE("/x", ["wireguard", "src", "node_modules", "build", ".git"]))');

    expect(out).toContain('wireguard');
    expect(out).not.toContain('\'src\'');
  });
});

describe('narrowing a run to the relevant tests', () => {
  test('every filter names a describe block that exists, so it never narrows to nothing', () => {
    const missing = json(`
import re
files = open(${JSON.stringify(path.join(ROOT, 'tests/scripts.test.js'))}).read() + open(${JSON.stringify(path.join(ROOT, 'tests/packaging.test.js'))}).read()
bad = [rel for rel, pat in m.FILTERS.items() if not any(re.search(p, files) for p in pat.split('|'))]
print(json.dumps(bad))`);

    expect(missing).toEqual([]);
  });
});
