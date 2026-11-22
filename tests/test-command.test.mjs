import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectNode, runTests } from '../scripts/test.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = name => ({ name, isDirectory: () => true });

test('test command prefers the current Node 26 without searching host artifacts', () => {
  assert.equal(selectNode({ execPath: '/current/node', version: '26.12.1',
    readDirectory: () => assert.fail('current Node 26 needs no discovery'),
    spawn: () => assert.fail('current runtime version is already known'),
  }), '/current/node');
});

test('Node 22 discovers the newest numerically ordered host with a verified Node 26', () => {
  const checked = [];
  const selected = selectNode({ execPath: '/system/node', version: '22.23.3', serverRoot: '/hosts',
    readDirectory: () => ['1.9.99-release', '1.11.0-release', '1.10.0-release', '1.12.0-release'].map(directory),
    spawn: (candidate, args) => {
      checked.push(candidate); assert.deepEqual(args, ['--version']);
      if (candidate.includes('1.12.0')) return { error: new Error('not executable'), status: null };
      return { status: 0, stdout: candidate.includes('1.11.0') ? 'v22.23.3\n' : 'v26.12.1\n' };
    },
  });
  assert.equal(selected, '/hosts/1.10.0-release/node');
  assert.deepEqual(checked, ['/hosts/1.12.0-release/node', '/hosts/1.11.0-release/node', '/hosts/1.10.0-release/node']);
});

test('Node 22 fails explicitly rather than silently running without an available Node 26', () => {
  assert.throws(() => selectNode({ version: '22.23.3', serverRoot: '/hosts',
    readDirectory: () => [directory('1.10.0-release')],
    spawn: () => ({ status: 0, stdout: 'v22.23.3\n' }),
  }), /Node 26 is required/);
});

test('test command forwards explicit Node arguments and all root test files and preserves termination', () => {
  const terminated = { status: 7, signal: null };
  assert.equal(runTests(['--test-name-pattern=example', '--test-timeout', '120000'], {
    select: () => '/selected/node',
    readDirectory: location => {
      assert.equal(location, path.join(root, 'tests'));
      return ['z.test.mjs', 'helper.mjs', 'a.test.mjs'].map(name => ({ name, isFile: () => true }))
        .concat({ name: 'nested.test.mjs', isFile: () => false });
    },
    spawn: (node, args, options) => {
      assert.equal(node, '/selected/node');
      assert.deepEqual(args, [
        '--test', '--test-name-pattern=example', '--test-timeout', '120000', 'tests/a.test.mjs', 'tests/z.test.mjs',
      ]);
      assert.deepEqual(options, { cwd: root, stdio: 'inherit' });
      return terminated;
    },
  }), terminated);
  const signalled = { status: null, signal: 'SIGTERM' };
  assert.equal(runTests([], { select: () => '/selected/node',
    readDirectory: () => [{ name: 'a.test.mjs', isFile: () => true }], spawn: () => signalled,
  }), signalled);
});

function fixtureCommand(t, fixture) {
  const project = mkdtempSync(path.join(os.tmpdir(), 'hana-test-command-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  for (const dir of ['scripts', 'tests']) mkdirSync(path.join(project, dir));
  const launcher = path.join(project, 'scripts/test.mjs');
  copyFileSync(path.join(root, 'scripts/test.mjs'), launcher);
  for (const [file, code] of Object.entries(fixture)) writeFileSync(path.join(project, file), code);
  const selected = selectNode();
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return args => {
    const result = spawnSync(selected, [launcher, '--test-reporter=tap', ...args], {
      cwd: path.dirname(project), env, encoding: 'utf8', timeout: 8000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
}

test('explicit Node timeouts fail an unreleased barrier and let the sibling run', t => {
  const run = fixtureCommand(t, { 'tests/barrier.test.mjs': `
import test from 'node:test';
test('synthetic barrier', async t => {
  const barrier = Promise.withResolvers();
  const hold = setInterval(() => {}, 1000);
  const fallback = setTimeout(() => {
    console.log('barrier released by fallback');
    barrier.resolve();
  }, 600).unref();
  t.after(() => { clearInterval(hold); clearTimeout(fallback); });
  await barrier.promise;
});
test('later test runs', () => {});
` });
  for (const [args, ms] of [
    [['--test-timeout=65'], 65],
    [['--test-timeout=1200', '--test-timeout', '75'], 75],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^not ok 1 - synthetic barrier$/m);
    assert.match(result.stdout, /failureType: 'testTimeoutFailure'/);
    assert.match(result.stdout, new RegExp(`test timed out after ${ms}ms`));
    assert.doesNotMatch(result.stdout, /released by fallback/);
    assert.match(result.stdout, /^ok 2 - later test runs$/m);
  }
  const disabled = run(['--test-timeout=0']);
  assert.equal(disabled.status, 0, disabled.stdout + disabled.stderr);
  assert.match(disabled.stdout, /released by fallback/);
  assert.match(disabled.stdout, /^ok 1 - synthetic barrier$/m);
});

test('the timeout is per test, not a deadline for a file worker', t => {
  const run = fixtureCommand(t, { 'tests/serial.test.mjs': `
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
for (let i = 1; i <= 3; i++) test('serial case ' + i, () => setTimeout(350));
` });
  const result = run(['--test-timeout=800']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ok 3 - serial case 3$/m);
  assert.match(result.stdout, /^# pass 3$/m);
  const duration = result.stdout.match(/^# duration_ms (\S+)$/m);
  assert.ok(duration && Number(duration[1]) > 800, result.stdout);
  // Node rejects this before running any tests; the wrapper must preserve failure.
  const invalid = run(['--invalid-test-command-option']);
  assert.ok(Number.isInteger(invalid.status) && invalid.status !== 0, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /--invalid-test-command-option/);
});
