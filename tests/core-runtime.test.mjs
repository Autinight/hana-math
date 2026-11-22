// Software lifecycle fixtures only; no Python, model, network or Hana process starts here.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCoreRuntime } from '../packages/hana-math/runtime/core-runtime.mjs';
import { windowsAbsolute, sameWindowsPath } from '../packages/hana-math/runtime/python-launch.mjs';

const METADATA = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' };
const WINDOWS = { ...METADATA, platform: 'win32', arch: 'x64', executable: 'dependencies/python/python.exe' };
const CHECKS = { imports: true, glossary: true, globalMemory: true, verifierRequired: true, noFacts: true };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const expectCode = (promise, code) => assert.rejects(promise, (error) => { assert.equal(error.code, `CORE_RUNTIME_${code}`, error.stack); return true; });

async function fixture(t, behavior = {}, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-core-runtime-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const packageRoot = path.join(base, 'install');
  const dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir);
  const metadata = behavior.windows ? WINDOWS : METADATA;
  for (const [name, text] of Object.entries({
    'dependencies/runtime.json': JSON.stringify(metadata),
    [metadata.executable]: 'isolated test fixture; never executed',
    'runtime/core_entry.py': '# fake SDK never executes this file\n',
    'engine/src/danus/core/glossary_global.json': '{}',
    'engine/src/hana_math_engine/service.py': '# fixture\n',
  })) {
    const file = path.join(packageRoot, name);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  }
  await fs.chmod(path.join(packageRoot, metadata.executable), 0o755);
  const calls = { start: [], get: [], watch: [], stop: [], canceled: 0, logs: [] };
  const started = deferred();
  const watched = deferred();
  const stopped = deferred();
  let info;
  let sequence = 0;
  const sdk = { dataDir, logger: { error: async (...args) => { calls.logs.push(args); if (behavior.logError) throw behavior.logError; } }, runtime: {
    async start(input) {
      calls.start.push(input);
      info = { runtimeId: `fixture-${++sequence}`, state: 'ready', runtime: 'command',
        ...(behavior.windows ? { profile: 'native', network: 'external', enforcement: 'partial' } : { profile: 'scoped', network: 'none', enforcement: 'full' }),
        backend: 'fake-sdk', exitCode: null, ...behavior.startStatus };
      started.resolve(info);
      if (behavior.startError) throw behavior.startError;
      const request = JSON.parse(await fs.readFile(input.args[5], 'utf8'));
      const output = { schemaVersion: 1, requestId: request.requestId, operation: 'core-diagnostic', ok: true, pythonVersion: '3.12.14', checks: { ...CHECKS } };
      if (behavior.writeResult) await behavior.writeResult({ input, request, output, base });
      else if (!behavior.noResult) await fs.writeFile(input.args[7], JSON.stringify(behavior.result ? behavior.result(output) : output));
      if (behavior.startPending) return behavior.startPending.promise;
      if (behavior.alreadyExited) info = { ...info, state: 'exited', exitCode: 0 };
      return info;
    },
    async get(id) {
      calls.get.push(id);
      if (behavior.getError) throw behavior.getError;
      if (behavior.getNull) return null;
      if (behavior.eofThenExit) info = { ...info, state: 'exited', exitCode: 0 };
      return behavior.getStatus ? { ...info, ...behavior.getStatus } : info;
    },
    async watch(id) {
      calls.watch.push(id); watched.resolve();
      if (behavior.watchError) throw behavior.watchError;
      const body = new ReadableStream({
        start(controller) {
          if (behavior.hang) return;
          const final = { ...info, state: behavior.terminal || 'exited', exitCode: behavior.exitCode ?? 0 };
          const records = behavior.raw ?? `${JSON.stringify({ type: 'snapshot', runtime: info })}\n${JSON.stringify({ type: 'log', runtimeId: id, stream: 'stdout', text: JSON.stringify({ ok: true }) })}\n${behavior.eofThenExit ? '' : JSON.stringify({ type: 'state', runtime: final }) + '\n'}`;
          const bytes = new TextEncoder().encode(records);
          controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17));
          if (!behavior.eofThenExit) info = final;
          controller.close();
        },
        cancel() { calls.canceled++; },
      });
      return new Response(body);
    },
    async stop(id) {
      calls.stop.push(id);
      if (behavior.stopError) throw behavior.stopError;
      info = { ...info, runtimeId: id, state: 'stopped', exitCode: null };
      stopped.resolve(info);
      return info;
    },
  } };
  const bridge = createCoreRuntime(sdk, { packageRoot, platform: metadata.platform, arch: metadata.arch, timeoutMs: 2000, cleanupTimeoutMs: 100, ...options });
  return { base, packageRoot, dataDir, sdk, bridge, calls, started, watched, stopped };
}

test('successful bounded NDJSON lifecycle uses only the formal scoped command API and matched file result', async (t) => {
  const f = await fixture(t);
  const result = await f.bridge.check();
  assert.equal(result.ok, true); assert.equal(result.runtime.state, 'exited');
  assert.deepEqual(result.diagnostic.checks, CHECKS);
  assert.equal(f.calls.start.length, 1); assert.deepEqual(f.calls.get, ['fixture-1']);
  assert.deepEqual(f.calls.watch, ['fixture-1']); assert.deepEqual(f.calls.stop, []);
  const input = f.calls.start[0];
  assert.deepEqual(Object.keys(input).sort(), ['runtime', 'command', 'args', 'cwd', 'profile', 'network'].sort());
  assert.equal(input.command, path.join(f.packageRoot, METADATA.executable));
  assert.deepEqual(input.args.slice(0, 4), ['-I', '-S', '-B', path.join(f.packageRoot, 'runtime/core_entry.py')]);
  assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none');
  assert.equal(input.cwd, result.directory);
  assert.equal(path.relative(f.dataDir, input.cwd), `core-checks/${result.requestId}`);
  assert.deepEqual(JSON.parse(await fs.readFile(input.args[5], 'utf8')), { schemaVersion: 1, requestId: result.requestId, operation: 'core-diagnostic' });
  await f.bridge.dispose(); await f.bridge.dispose();
});

test('Windows x64 uses the fixed native/external command and matching watch/get receipts', async t => {
  const f = await fixture(t, { windows: true });
  const result = await f.bridge.check();
  assert.equal(result.runtime.enforcement, 'partial');
  assert.deepEqual(f.calls.start, [{ runtime: 'command', command: path.join(f.packageRoot, WINDOWS.executable),
    args: ['-I', '-S', '-B', path.join(f.packageRoot, 'runtime/core_entry.py'), '--request', path.join(result.directory, 'request.json'),
      '--result', path.join(result.directory, 'result.json')], cwd: result.directory, profile: 'native', network: 'external' }]);
  assert.deepEqual([f.calls.watch, f.calls.get, f.calls.stop], [['fixture-1'], ['fixture-1'], []]);
  await f.bridge.dispose();
});

test('Windows path grammar rejects aliases, non-local drives and alternate streams', () => {
  for (const value of [String.raw`C:\App\data`, String.raw`d:\Install\python.exe`]) assert.equal(windowsAbsolute(value), true);
  for (const value of [String.raw`C:relative`, String.raw`\missing-drive`, String.raw`\\server\share\file`, String.raw`\\?\C:\App`,
    String.raw`C:\App\..\file`, 'C:/App/file', String.raw`C:\App\file:alternate`, String.raw`C:\App\file.`, String.raw`C:\App\NUL.txt`]) {
    assert.equal(windowsAbsolute(value), false, value);
  }
  assert.equal(sameWindowsPath(String.raw`C:\App\data`, String.raw`c:\App\data`), true);
  assert.equal(sameWindowsPath(String.raw`C:\App\data`, String.raw`C:\APP\data`), false);
  assert.equal(sameWindowsPath(String.raw`C:\App\data`, String.raw`D:\App\data`), false);
});

test('Windows runtime capability and helper errors are returned without a second launch', async t => {
  for (const [sdkCode, bridgeCode] of [['APP_RUNTIME_NATIVE_DENIED', 'DENIED'], ['APP_RUNTIME_NETWORK_DENIED', 'DENIED'],
    ['APP_RUNTIME_SANDBOX_UNAVAILABLE', 'START_FAILED']]) {
    const startError = Object.assign(new Error('fixture Host refusal'), { code: sdkCode, operation: 'runtime.start' });
    const f = await fixture(t, { windows: true, startError });
    await assert.rejects(f.bridge.check(), error => error.code === `CORE_RUNTIME_${bridgeCode}` && error.cause === startError);
    assert.deepEqual(f.calls.start.map(({ profile, network }) => [profile, network]), [['native', 'external']]);
    assert.deepEqual([f.calls.watch, f.calls.get, f.calls.stop], [[], [], []]);
    await f.bridge.dispose();
  }
});

test('Windows rejects mismatched runtime status and unsafe packaged or result files', async t => {
  for (const getStatus of [{ profile: 'scoped' }, { network: 'none' }, { enforcement: 'none' }]) {
    const f = await fixture(t, { windows: true, getStatus });
    await expectCode(f.bridge.check(), 'INVALID_RESULT'); assert.equal(f.calls.start.length, 1);
    await f.bridge.dispose();
  }
  for (const name of ['dependencies/runtime.json', WINDOWS.executable, 'runtime/core_entry.py']) {
    const f = await fixture(t, { windows: true });
    await fs.link(path.join(f.packageRoot, name), path.join(f.base, 'other-link'));
    await expectCode(f.bridge.check(), 'PATH_INVALID'); assert.equal(f.calls.start.length, 0);
  }
  const f = await fixture(t, { windows: true, async writeResult({ input, output, base }) {
    const outside = path.join(base, 'external-result');
    await fs.writeFile(outside, JSON.stringify(output)); await fs.symlink(outside, input.args[7]);
  } });
  await expectCode(f.bridge.check(), 'INVALID_RESULT'); assert.equal(f.calls.start.length, 1);
});

test('Windows result read rejects an identity swap between path check and open', async t => {
  const f = await fixture(t, { windows: true });
  const open = fs.open; let replaced = false;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (!replaced && file === f.calls.start[0]?.args[7]) {
      replaced = true;
      await fs.rename(file, `${file}.old`);
      await fs.copyFile(`${file}.old`, file); // Valid payload, different inode.
    }
    return open(file, ...args);
  });
  await expectCode(f.bridge.check(), 'INVALID_RESULT');
  assert.equal(replaced, true); assert.equal(f.calls.start.length, 1);
  await f.bridge.dispose();
});

test('concurrent checks share one run, later checks use fresh diagnostic directories', async (t) => {
  const f = await fixture(t);
  const one = f.bridge.check(); const two = f.bridge.check();
  assert.equal(one, two);
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a, b); assert.equal(f.calls.start.length, 1);
  const c = await f.bridge.check();
  assert.notEqual(a.requestId, c.requestId); assert.equal(f.calls.start.length, 2);
  await f.bridge.dispose();
  await expectCode(f.bridge.check(), 'DISPOSED');
});

test('fixed check rejects caller input without starting anything', async (t) => {
  const f = await fixture(t);
  await expectCode(f.bridge.check({ operation: 'fact_submit' }), 'INVALID_RESULT');
  assert.equal(f.calls.start.length, 0);
});

test('missing runtime API and missing Python assets fail without system fallback', async (t) => {
  const f = await fixture(t);
  delete f.sdk.runtime.start;
  await expectCode(f.bridge.check(), 'MISSING');
  for (const missing of ['dependencies/runtime.json', METADATA.executable]) {
    const g = await fixture(t);
    await fs.unlink(path.join(g.packageRoot, missing));
    await expectCode(g.bridge.check(), 'MISSING');
    assert.equal(g.calls.start.length, 0);
  }
});

test('unsupported platform, architecture, metadata version and interpreter version are explicit', async (t) => {
  for (const options of [{ platform: 'linux' }, { arch: 'x64' }]) {
    const f = await fixture(t, {}, options);
    await expectCode(f.bridge.check(), 'UNSUPPORTED'); assert.equal(f.calls.start.length, 0);
  }
  for (const patch of [{ platform: 'linux' }, { arch: 'x64' }, { schemaVersion: 2 }, { pythonVersion: '3.12.13' }]) {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.packageRoot, 'dependencies/runtime.json'), JSON.stringify({ ...METADATA, ...patch }));
    await expectCode(f.bridge.check(), 'UNSUPPORTED'); assert.equal(f.calls.start.length, 0);
  }
});

test('startup exceptions and denied grants are distinct and never retried with elevated profiles', async (t) => {
  for (const [code, expected] of [['APP_CAPABILITY_DENIED', 'DENIED'], ['STARTUP_FIXTURE_FAILURE', 'START_FAILED']]) {
    const f = await fixture(t, { startError: Object.assign(new Error('fixture start failure'), { code }) });
    await expectCode(f.bridge.check(), expected);
    assert.equal(f.calls.start.length, 1); assert.equal(f.calls.watch.length, 0);
    assert.deepEqual(f.calls.stop, []);
  }
});

test('ready plus valid result is not completion; timeout stops the runtime and cancels its reader', async (t) => {
  const f = await fixture(t, { hang: true }, { timeoutMs: 100 });
  await expectCode(f.bridge.check(), 'TIMEOUT');
  assert.deepEqual(f.calls.stop, ['fixture-1']); assert.equal(f.calls.canceled, 1);
  await f.bridge.dispose();
});

test('dispose cancels in-flight observation and terminates only this bridge owned runtime', async (t) => {
  const f = await fixture(t, { hang: true });
  const check = f.bridge.check(); const rejected = expectCode(check, 'DISPOSED');
  await f.watched.promise;
  await f.bridge.dispose(); await rejected;
  assert.deepEqual(f.calls.stop, ['fixture-1']); assert.equal(f.calls.canceled, 1);
});

test('watch response arriving during timeout cleanup is canceled rather than leaked', async (t) => {
  const f = await fixture(t, {}, { timeoutMs: 100 });
  const pendingWatch = deferred();
  f.sdk.runtime.watch = async () => { f.watched.resolve(); return pendingWatch.promise; };
  const checking = f.bridge.check();
  const rejected = expectCode(checking, 'TIMEOUT');
  await f.watched.promise;
  await f.stopped.promise;
  pendingWatch.resolve(new Response(new ReadableStream({ cancel() { f.calls.canceled++; } })));
  await rejected;
  assert.equal(f.calls.canceled, 1); assert.deepEqual(f.calls.stop, ['fixture-1']);
  await f.bridge.dispose();
});

test('dispose before preparation completes never launches a process', async (t) => {
  const f = await fixture(t);
  const checking = f.bridge.check(); const rejected = expectCode(checking, 'DISPOSED');
  await f.bridge.dispose(); await rejected;
  assert.equal(f.calls.start.length, 0);
});

test('late start after timeout is stopped; disposal waits for that owned late receipt', async (t) => {
  const startPending = deferred();
  const f = await fixture(t, { startPending }, { timeoutMs: 100 });
  await expectCode(f.bridge.check(), 'TIMEOUT');
  await expectCode(f.bridge.check(), 'BUSY');
  const info = await f.started.promise;
  startPending.resolve(info);
  await f.bridge.dispose();
  assert.deepEqual(f.calls.stop, ['fixture-1']);
});

test('unresolved start during disposal is an explicit cleanup failure, not a false stop receipt', async (t) => {
  const startPending = deferred();
  const f = await fixture(t, { startPending }, { timeoutMs: 100 });
  await expectCode(f.bridge.check(), 'TIMEOUT');
  await expectCode(f.bridge.dispose(), 'CLEANUP_FAILED');
  startPending.resolve(await f.started.promise);
  await f.bridge.dispose();
  assert.deepEqual(f.calls.stop, ['fixture-1']);
});

test('late stop failure uses the public async logger and is not hidden by cached cleanup', async (t) => {
  const startPending = deferred();
  const stopError = new Error('late fixture stop failure');
  const f = await fixture(t, { startPending, stopError }, { timeoutMs: 100 });
  let timeoutError;
  await assert.rejects(f.bridge.check(), (error) => { timeoutError = error; return error.code === 'CORE_RUNTIME_TIMEOUT'; });
  startPending.resolve(await f.started.promise);
  await assert.rejects(f.bridge.dispose(), (error) => {
    assert.equal(error.code, 'CORE_RUNTIME_CLEANUP_FAILED'); assert.ok(error.errors.includes(stopError)); return true;
  });
  assert.equal(f.calls.logs.length, 1);
  assert.equal(f.calls.logs[0][1], 'late fixture stop failure');
  assert.ok(timeoutError.cleanupErrors.includes(stopError));
  await expectCode(f.bridge.dispose(), 'CLEANUP_FAILED');
});

test('async logger rejection and synchronous throw preserve cleanup failure with console fallback', async (t) => {
  const fallback = t.mock.method(console, 'error', () => {});
  for (const synchronous of [false, true]) {
    const startPending = deferred();
    const stopError = new Error('late fixture stop failure');
    const logError = new Error('fixture logger unavailable');
    const f = await fixture(t, { startPending, stopError, logError }, { timeoutMs: 100 });
    if (synchronous) f.sdk.logger.error = () => { throw logError; };
    await expectCode(f.bridge.check(), 'TIMEOUT');
    startPending.resolve(await f.started.promise);
    await expectCode(f.bridge.dispose(), 'CLEANUP_FAILED');
    assert.equal(stopError.loggingError, logError);
  }
  assert.equal(fallback.mock.callCount(), 2);
});

test('stop failures remain attached to timeout and are also reported by disposal', async (t) => {
  const f = await fixture(t, { hang: true, stopError: new Error('fixture stop failed') }, { timeoutMs: 100 });
  await assert.rejects(f.bridge.check(), (error) => {
    assert.equal(error.code, 'CORE_RUNTIME_TIMEOUT'); assert.match(error.cleanupErrors[0].message, /stop failed/); return true;
  });
  assert.equal(f.calls.canceled, 1);
  await expectCode(f.bridge.dispose(), 'CLEANUP_FAILED');
});

test('nonzero exits and failed/stopped terminal states reject even a valid result', async (t) => {
  for (const behavior of [{ exitCode: 2 }, { terminal: 'failed' }, { terminal: 'stopped' }]) {
    const f = await fixture(t, behavior);
    await expectCode(f.bridge.check(), 'FAILED');
    assert.deepEqual(f.calls.stop, []);
  }
});

test('already-exited start and EOF race are checked with get rather than polling', async (t) => {
  const f = await fixture(t, { alreadyExited: true });
  await f.bridge.check(); assert.deepEqual(f.calls.watch, []); assert.equal(f.calls.get.length, 1);
  const g = await fixture(t, { eofThenExit: true });
  await g.bridge.check(); assert.equal(g.calls.get.length, 1);
});

test('unknown terminal record and prematurely closed active watch cannot pass', async (t) => {
  const f = await fixture(t, { getNull: true });
  await expectCode(f.bridge.check(), 'INVALID_RESULT');
  const g = await fixture(t);
  g.sdk.runtime.watch = async () => new Response('');
  await expectCode(g.bridge.check(), 'FAILED');
  assert.equal(g.calls.get.length, 1); assert.deepEqual(g.calls.stop, ['fixture-1']);
});

test('watch denial is explicit and still cleans up the owned process', async (t) => {
  const f = await fixture(t, { watchError: Object.assign(new Error('revoked'), { code: 'APP_CAPABILITY_DENIED' }) });
  await expectCode(f.bridge.check(), 'DENIED'); assert.deepEqual(f.calls.stop, ['fixture-1']);
});

test('missing result and identity/check/version mismatches reject successful process exits', async (t) => {
  const f = await fixture(t, { noResult: true });
  await expectCode(f.bridge.check(), 'INVALID_RESULT');
  for (const patch of [{ requestId: 'wrong-id' }, { schemaVersion: 2 }, { operation: 'fact_submit' }, { ok: false }, { pythonVersion: '3.9.0' }, { checks: { ...CHECKS, noFacts: false } }]) {
    const g = await fixture(t, { result: (output) => ({ ...output, ...patch }) });
    await expectCode(g.bridge.check(), 'INVALID_RESULT');
  }
});

test('stdout logs are ignored and bounded malformed/oversize result files fail', async (t) => {
  for (const text of ['not JSON', 'x'.repeat(17000)]) {
    const f = await fixture(t, { writeResult: ({ input }) => fs.writeFile(input.args[7], text) });
    await expectCode(f.bridge.check(), 'INVALID_RESULT');
  }
});

test('malformed, oversized or foreign runtime watch records fail and stop residual work', async (t) => {
  for (const raw of ['not json\n', 'x'.repeat(65537), 'x'.repeat(1024 * 1024 + 1), JSON.stringify({ type: 'state', runtime: { runtimeId: 'foreign', state: 'exited' } })]) {
    const f = await fixture(t, { raw });
    await expectCode(f.bridge.check(), 'INVALID_RESULT'); assert.deepEqual(f.calls.stop, ['fixture-1']);
  }
});

test('executable metadata traversal and symlink escaping the install are refused', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.packageRoot, 'dependencies/runtime.json'), JSON.stringify({ ...METADATA, executable: '../outside-python' }));
  await expectCode(f.bridge.check(), 'PATH_INVALID');
  const g = await fixture(t);
  const executable = path.join(g.packageRoot, METADATA.executable);
  const outside = path.join(g.base, 'external-python'); await fs.writeFile(outside, 'fixture'); await fs.chmod(outside, 0o755);
  await fs.unlink(executable); await fs.symlink(outside, executable);
  await expectCode(g.bridge.check(), 'PATH_INVALID'); assert.equal(g.calls.start.length, 0);
});

test('an internal Python symlink is launched by its canonical install target', async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.packageRoot, METADATA.executable); const target = `${alias}.12`;
  await fs.rename(alias, target); await fs.symlink('python3.12', alias);
  await f.bridge.check(); assert.equal(f.calls.start[0].command, target);
});

test('diagnostic parent symlink is refused before request creation', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.dataDir, 'core-checks'));
  await expectCode(f.bridge.check(), 'PATH_INVALID');
  assert.deepEqual(await fs.readdir(outside), []); assert.equal(f.calls.start.length, 0);
});

test('result symlinks and hardlinks to outside files are refused', async (t) => {
  for (const link of ['symlink', 'link']) {
    const f = await fixture(t, { writeResult: async ({ input, output, base }) => {
      const outside = path.join(base, 'external-result.json'); await fs.writeFile(outside, JSON.stringify(output));
      await fs[link](outside, input.args[7]);
    } });
    await expectCode(f.bridge.check(), 'INVALID_RESULT');
  }
});

test('source-entry symlink and overlapping data/install roots are refused', async (t) => {
  const f = await fixture(t);
  const entry = path.join(f.packageRoot, 'runtime/core_entry.py'); const external = path.join(f.base, 'entry.py');
  await fs.writeFile(external, '# fixture'); await fs.unlink(entry); await fs.symlink(external, entry);
  await expectCode(f.bridge.check(), 'PATH_INVALID');
  const g = await fixture(t); g.sdk.dataDir = g.packageRoot;
  await expectCode(g.bridge.check(), 'PATH_INVALID'); assert.equal(g.calls.start.length, 0);
});
