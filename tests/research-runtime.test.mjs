// Software fixtures only: no Python, model, network, or managed processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as runtime from '../packages/hana-math/runtime/research-runtime.mjs';
import { createManagedReadOwner } from '../packages/hana-math/runtime/managed-read-owner.mjs';
const { createResearchRuntime, CORE_CALLS_MAX_BYTES, CORE_CALLS_MAX_DIRECTORIES, CORE_CALL_RESERVATION_BYTES } = runtime;
const ipcReason = (...args) => runtime.runtimeManagedIpcRefusal?.(...args) ?? null;
const binding = { projectId: 'project', runId: 'run', role: 'worker', author: 'fixture' };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, behavior = {}, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'research-fixture-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const packageRoot = path.join(base, 'install'), dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir);
  const metadata = { schemaVersion: 1, pythonVersion: '3.12.14', ...behavior.windows
    ? { platform: 'win32', arch: 'x64', executable: 'dependencies/python/python.exe' }
    : { platform: 'darwin', arch: 'arm64', executable: 'dependencies/python/bin/python3' } };
  for (const [name, data] of Object.entries({ 'dependencies/runtime.json': JSON.stringify(metadata), [metadata.executable]: 'never executed', 'runtime/research_entry.py': '# fixture', 'engine/src/hana_math_engine/research.py': '# fixture' })) {
    const target = path.join(packageRoot, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data);
  }
  await fs.chmod(path.join(packageRoot, metadata.executable), 0o700);
  const starts = [], stops = [], states = new Map(); let cancellations = 0;
  const started = deferred(), watched = deferred();
  const sdk = { dataDir, runtime: {
    async start(input) {
      starts.push(input);
      if (behavior.sdkStartError) throw behavior.sdkStartError;
      const request = JSON.parse(await fs.readFile(input.args[4], 'utf8'));
      const info = { runtimeId: request.requestId, state: behavior.exited ? 'exited' : 'ready', exitCode: 0, runtime: 'command',
        ...(behavior.windows ? { profile: 'native', network: 'external', enforcement: 'partial' } : { profile: 'scoped', network: 'none' }) };
      states.set(info.runtimeId, info);
      const envelope = { schemaVersion: 1, requestId: request.requestId, ok: true, result: { text: 'verbatim', id: request.requestId } };
      if (behavior.write) await behavior.write(input, envelope);
      else await fs.writeFile(input.args[5], JSON.stringify(behavior.result ? behavior.result(envelope) : envelope), { mode: 0o600 });
      started.resolve(info);
      if (behavior.startError) throw new Error('start failed after effect');
      if (behavior.start) return behavior.start.promise;
      return info;
    },
    async get(id) { return states.get(id); },
    async watch(id) {
      watched.resolve();
      if (behavior.watch) return behavior.watch.promise;
      return new Response(new ReadableStream({
        start(controller) {
          if (behavior.hang) return;
          const info = { ...states.get(id), state: 'exited', exitCode: behavior.exitCode ?? 0 };
          states.set(id, info);
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'state', runtime: { ...info, ...behavior.watchStatus } }) + '\n')); controller.close();
        }, cancel() { cancellations++; },
      }));
    },
    async stop(id) {
      stops.push(id);
      if (behavior.stop) return behavior.stop.promise;
      if (behavior.stopError) throw new Error('stop failed');
      const info = { ...states.get(id), state: 'stopped' }; states.set(id, info); return info;
    },
  } };
  const bridge = createResearchRuntime(sdk, { packageRoot, platform: metadata.platform, arch: metadata.arch, timeoutMs: 1000, cleanupTimeoutMs: 30, ...options });
  return { bridge, sdk, packageRoot, starts, stops, started, watched, get cancellations() { return cancellations; } };
}
const rejects = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, `RESEARCH_RUNTIME_${code}`); assert.match(e.requestId, /^[a-f0-9-]{36}$/); assert.equal(typeof e.indeterminate, 'boolean'); assert.ok(e.cleanup); return true; });
test('fixed isolated command, private request, Python envelope and concurrent call isolation', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.bridge.call(binding, 'fact_list'), f.bridge.call(binding, 'gm_search', { query: 'original' })]);
  assert.notEqual(results[0].id, results[1].id);
  for (const input of f.starts) {
    assert.deepEqual(input.args.slice(0, 4), ['-I', '-S', '-B', path.join(f.packageRoot, 'runtime/research_entry.py')]);
    assert.equal(input.command, path.join(f.packageRoot, 'dependencies/python/bin/python3'));
    assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none');
    const request = JSON.parse(await fs.readFile(input.args[4], 'utf8'));
    assert.equal(input.cwd, path.join(f.sdk.dataDir, 'research/core-calls', request.requestId));
    assert.deepEqual(request.context, binding); assert.equal(request.schemaVersion, 1);
    assert.equal((await fs.stat(input.args[4])).mode & 0o777, 0o600);
  }
  await f.bridge.dispose(); await rejects(f.bridge.call(binding, 'fact_list'), 'DISPOSED');
});
test('Windows x64 fixes native/external Python launch to the original task and retains the IPC budget', async t => {
  const taskId = 'fixture-app-task';
  const f = await fixture(t, { windows: true }, { taskId });
  const a = await f.bridge.call(binding, 'fact_list');
  const b = await f.bridge.call(binding, 'gm_search', { query: 'synthetic' });
  assert.equal(f.starts.length, 2);
  for (const [input, result] of [[f.starts[0], a], [f.starts[1], b]]) {
    const cwd = path.join(f.sdk.dataDir, 'research/core-calls', result.id);
    assert.deepEqual(input, { runtime: 'command', command: path.join(f.packageRoot, 'dependencies/python/python.exe'),
      args: ['-I', '-S', '-B', path.join(f.packageRoot, 'runtime/research_entry.py'), path.join(cwd, 'request.json'), path.join(cwd, 'result.json')],
      cwd, profile: 'native', network: 'external', taskId });
    assert.equal((await fs.stat(path.join(cwd, '.complete'))).size, 0);
  }
  const usage = await runtime.readManagedIpcUsage(f.sdk.dataDir);
  assert.equal(usage.directories.used, 2); assert.equal(usage.chargedBytes.used, usage.logicalBytes);
  await rejects(f.bridge.call(binding, 'fact_list', {}, undefined, { profile: 'local-machine' }), 'INVALID_REQUEST');
  assert.equal(f.starts.length, 2);
  await f.bridge.dispose();
});

test('Windows refuses unmatched native/helper grants and never issues a fallback start', async t => {
  for (const code of ['APP_CAPABILITY_DENIED', 'APP_RUNTIME_NATIVE_DENIED', 'APP_RUNTIME_NETWORK_DENIED', 'APP_RUNTIME_SANDBOX_UNAVAILABLE']) {
    const sdkStartError = Object.assign(new Error('fixture Host refusal'), { code, operation: 'runtime.start',
      ...(code === 'APP_CAPABILITY_DENIED' ? { capability: 'app/runtime.execute' } : {}) });
    const f = await fixture(t, { windows: true, sdkStartError });
    const guaranteed = code === 'APP_CAPABILITY_DENIED';
    await assert.rejects(f.bridge.call(binding, 'fact_list'), error => {
      assert.equal(error.cause, sdkStartError);
      assert.equal(runtime.runtimeFailureInfo(error).sdk.code, code);
      assert.equal(error.cleanup.confirmed, guaranteed);
      return true;
    });
    assert.deepEqual(f.starts.map(({ profile, network }) => [profile, network]), [['native', 'external']]);
    assert.deepEqual(f.stops, []);
    if (guaranteed) await f.bridge.dispose();
    else await assert.rejects(f.bridge.dispose(), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED' });
  }
});

test('Windows rejects foreign runtime status, wrong package target, and aliased executable or result', async t => {
  for (const watchStatus of [{ profile: 'local-machine' }, { network: 'none' }, { enforcement: 'none' }]) {
    const f = await fixture(t, { windows: true, watchStatus });
    await rejects(f.bridge.call(binding, 'fact_list'), 'INVALID_RESULT');
    assert.equal(f.starts.length, 1);
    await f.bridge.dispose();
  }
  const wrong = await fixture(t, {}, { platform: 'win32', arch: 'x64' });
  await rejects(wrong.bridge.call(binding, 'fact_list'), 'UNSUPPORTED'); assert.deepEqual(wrong.starts, []);
  const f = await fixture(t, { windows: true });
  const executable = path.join(f.packageRoot, 'dependencies/python/python.exe');
  await fs.rename(executable, `${executable}.real`); await fs.symlink('python.exe.real', executable);
  await rejects(f.bridge.call(binding, 'fact_list'), 'PATH_INVALID'); assert.deepEqual(f.starts, []);
  const linked = await fixture(t, { windows: true, async write(input, envelope) {
    const other = path.join(path.dirname(input.cwd), '..', 'other-result');
    await fs.writeFile(other, JSON.stringify(envelope), { mode: 0o600 }); await fs.link(other, input.args[5]);
  } });
  await rejects(linked.bridge.call(binding, 'fact_list'), 'PATH_INVALID'); assert.equal(linked.starts.length, 1);
});

test('Windows controlled project reads refuse before IPC allocation without an enabled frame owner', async t => {
  const f = await fixture(t, { windows: true });
  const owner = createManagedReadOwner(f.sdk);
  const bridge = createResearchRuntime(f.sdk, { packageRoot: f.packageRoot, platform: 'win32', arch: 'x64', taskId: 'view-task', managedReadOwner: owner });
  const control = { ...binding, role: 'main', runId: 'control-00000000-0000-4000-8000-000000000001' };
  for (const [operation, args, options] of [
    ['fact_get', { fact_id: 'a'.repeat(16) }, {}],
    ['fact_list_page', {}, runtime.projectReadScratchOptions(undefined)],
    ['dashboard_factgraph', {}, runtime.projectDashboardFactgraphOptions(undefined)],
    ['dashboard_memory', { view: 'overview' }, runtime.projectDashboardMemoryOptions(undefined)],
    ['dashboard_memory', { view: 'overview' }, runtime.projectDashboardViewOptions('dashboard_memory', undefined, () => {})],
  ]) await rejects(bridge.call(control, operation, args, undefined, options), 'UNSUPPORTED');
  assert.deepEqual(f.starts, []);
  await assert.rejects(fs.stat(path.join(f.sdk.dataDir, 'research')), { code: 'ENOENT' });
  await bridge.dispose(); await owner.dispose();
});

test('strict JSON, binding, whitelist and internal verification reject before starting', async (t) => {
  const f = await fixture(t); const cycle = {}; cycle.self = cycle;
  for (const args of [[{ ...binding, role: 'admin' }, 'fact_list'], [{ ...binding, projectId: '../bad' }, 'fact_list'], [binding, 'spawn'], [binding, 'gm_add', cycle], [binding, 'gm_add', { x: undefined }], [binding, 'gm_add', { x: 'a'.repeat(1 << 20) }], [binding, 'fact_list', {}, {}]]) await rejects(f.bridge.call(...args), 'INVALID_REQUEST');
  assert.equal(f.starts.length, 0);
});
test('optional trusted workerId is transported unchanged with independent run identity', async (t) => {
  const f = await fixture(t);
  for (const context of [{ ...binding, workerId: 'logical-worker' }, { ...binding, runId: 'run-b', workerId: 'logical-worker' },
    { ...binding, workerId: 'a'.repeat(64) }, binding]) {
    await f.bridge.call(context, 'local_memory_read');
    const request = JSON.parse(await fs.readFile(f.starts.at(-1).args[4], 'utf8'));
    assert.deepEqual(request.context, context);
    assert.equal(request.operation, 'local_memory_read'); assert.deepEqual(request.arguments, {});
  }
  assert.equal(f.starts.length, 4); assert.equal(new Set(f.starts.map((start) => start.cwd)).size, 4);
  await f.bridge.dispose();
});

test('workerId remains worker-only, strictly ID-bounded, and cannot select arbitrary paths', async (t) => {
  const f = await fixture(t);
  for (const workerId of [undefined, null, true, 7, {}, [], '', '.', '..', '../outside', '/absolute', 'a/b', 'a\\b',
    'worker_id', 'Worker', 'é', 'worker\n', 'a\0b', 'x'.repeat(65)]) {
    await rejects(f.bridge.call({ ...binding, workerId }, 'local_memory_read'), 'INVALID_REQUEST');
  }
  for (const role of ['main', 'verifier']) await rejects(f.bridge.call({ ...binding, role, workerId: 'logical-worker' }, 'fact_list'), 'INVALID_REQUEST');
  for (const key of ['projectId', 'runId', 'role', 'author']) {
    const missing = { ...binding, workerId: 'logical-worker' }; delete missing[key];
    await rejects(f.bridge.call(missing, 'fact_list'), 'INVALID_REQUEST');
  }
  for (const key of ['path', 'privateDir', 'root']) await rejects(f.bridge.call({ ...binding, workerId: 'logical-worker', [key]: '/opaque/not-used' }, 'local_memory_read'), 'INVALID_REQUEST');
  assert.equal(f.starts.length, 0); await f.bridge.dispose();
});

test('trusted verification is transmitted unchanged only to fact_submit', async (t) => {
  const f = await fixture(t);
  const verification = { candidateDigest: 'a'.repeat(64), predecessorDigests: { ['b'.repeat(16)]: 'c'.repeat(64) }, verifierSessionId: 'verifier-1', report: { verdict: 'correct' } };
  await f.bridge.call(binding, 'fact_submit', { statement: 'fixture text' }, verification);
  assert.deepEqual(JSON.parse(await fs.readFile(f.starts[0].args[4], 'utf8')).verification, verification);
});
test('identity mismatch, missing result, false envelope and failed exit cannot succeed', async (t) => {
  for (const [behavior, code] of [
    [{ result: (x) => ({ ...x, requestId: 'wrong' }) }, 'INVALID_RESULT'],
    [{ result: (x) => { delete x.result; return x; } }, 'INVALID_RESULT'],
    [{ result: (x) => ({ ...x, ok: false, error: { code: 'io_error', message: 'write failed', mutationState: 'indeterminate' } }) }, 'REJECTED'],
    [{ exitCode: 1 }, 'FAILED'],
  ]) { const f = await fixture(t, behavior); await rejects(f.bridge.call(binding, 'fact_list'), code); }
});
test('partial core fact write rejects and preserves the full original result on the error', async (t) => {
  const coreResult = { accepted: true, fact_id: null, write_error: 'opaque glossary failure', undefined_symbols: ['opaque'] };
  const coreError = { code: 'fact_write_failed', message: 'opaque glossary failure', mutationState: 'indeterminate' };
  const f = await fixture(t, { result: (envelope) => ({ ...envelope, ok: false, error: coreError, result: coreResult }) });
  await assert.rejects(f.bridge.call(binding, 'fact_submit', { statement: 'opaque fixture', proof: 'opaque fixture' }), (error) => {
    assert.equal(error.code, 'RESEARCH_RUNTIME_REJECTED');
    assert.equal(error.indeterminate, true);
    assert.deepEqual(error.coreError, coreError);
    assert.deepEqual(error.coreResult, coreResult);
    assert.equal(error.cleanup.confirmed, true);
    return true;
  });
});

test('unsafe result permissions, symlink and oversized result are rejected', async (t) => {
  for (const write of [
    async (i, e) => fs.writeFile(i.args[5], JSON.stringify(e), { mode: 0o644 }),
    async (i) => fs.symlink(i.args[4], i.args[5]),
    async (i) => fs.writeFile(i.args[5], ' '.repeat((1 << 20) + 1), { mode: 0o600 }),
  ]) { const f = await fixture(t, { write }); await assert.rejects(f.bridge.call(binding, 'fact_list')); }
});
test('timeout and host cancellation stop owned process and cancel watcher', async (t) => {
  const f = await fixture(t, { hang: true }, { timeoutMs: 40 });
  await rejects(f.bridge.call(binding, 'gm_add'), 'TIMEOUT'); assert.equal(f.stops.length, 1); assert.equal(f.cancellations, 1);
  const g = await fixture(t, { hang: true }); const controller = new AbortController();
  const pending = g.bridge.call(binding, 'gm_search', {}, undefined, { signal: controller.signal });
  const rejected = rejects(pending, 'CANCELLED'); await g.watched.promise; controller.abort(); await rejected;
  assert.equal(g.stops.length, 1); await g.bridge.dispose();
});
test('late start is stopped, uncertainty remains visible until cleanup confirms', async (t) => {
  const start = deferred(); const f = await fixture(t, { start }, { timeoutMs: 40 });
  let error; const pending = f.bridge.call(binding, 'gm_add').catch((e) => { error = e; });
  const info = await f.started.promise; await pending;
  assert.equal(error.indeterminate, true); assert.equal(error.cleanup.confirmed, false);
  start.resolve(info); await f.bridge.dispose(); assert.equal(f.stops.length, 1); assert.equal(error.cleanup.confirmed, true);
});
test('late watch is cancelled and failed stop is not hidden', async (t) => {
  const watch = deferred(); const f = await fixture(t, { watch }, { timeoutMs: 40 });
  await rejects(f.bridge.call(binding, 'fact_list'), 'TIMEOUT');
  let cancelled = false;
  watch.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await f.bridge.dispose(); assert.equal(cancelled, true);
  const g = await fixture(t, { hang: true, stopError: true }, { timeoutMs: 40 });
  await assert.rejects(g.bridge.call(binding, 'gm_add'), (e) => e.indeterminate && !e.cleanup.confirmed);
  await assert.rejects(g.bridge.dispose(), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED' });
});
test('late stop confirmation is preserved, start rejection after effect stays indeterminate', async (t) => {
  const stop = deferred(); const f = await fixture(t, { hang: true, stop }, { timeoutMs: 40 });
  const pending = f.bridge.call(binding, 'gm_add'); const info = await f.started.promise;
  await assert.rejects(pending, (e) => e.indeterminate && !e.cleanup.confirmed);
  stop.resolve({ ...info, state: 'stopped' }); await f.bridge.dispose();
  const g = await fixture(t, { startError: true });
  await assert.rejects(g.bridge.call(binding, 'gm_add'), (e) => e.indeterminate && !e.cleanup.confirmed);
  await assert.rejects(g.bridge.dispose());
});
const callsRoot = (f) => path.join(f.sdk.dataDir, 'research/core-calls');
async function retained(f, name, { complete = false, bytes = 0 } = {}) {
  const directory = path.join(callsRoot(f), name);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (bytes) {
    const handle = await fs.open(path.join(directory, 'request.json'), 'w', 0o600);
    try { await handle.truncate(bytes); } finally { await handle.close(); }
  }
  if (complete) await fs.writeFile(path.join(directory, '.complete'), '', { mode: 0o600 });
  return directory;
}
function anotherBridge(f) {
  return createResearchRuntime(f.sdk, { packageRoot: f.packageRoot, platform: 'darwin', arch: 'arm64', timeoutMs: 20000, cleanupTimeoutMs: 30 });
}
const capacityRejected = (promise, check) => assert.rejects(promise, (error) => {
  assert.equal(error.code, 'RESEARCH_RUNTIME_CAPACITY');
  assert.equal(error.indeterminate, false);
  assert.equal(error.cleanup.confirmed, true);
  check?.(error);
  return true;
});
async function capacityReason(bridge, operation, args, reason, message) {
  const pending = bridge.call(binding, operation, args); let caught;
  await capacityRejected(pending, e => { caught = e; });
  assert.equal(caught.phase, 'request'); assert.equal(caught.startOutcome, 'not-attempted');
  assert.equal(caught.message, message);
  assert.equal(ipcReason(bridge, pending, caught, operation), reason);
  return { pending, caught };
}
const reserveMessage = 'Managed IPC capacity exhausted; retained calls require explicit reconciliation';
const unsafeMessage = 'Unsafe or excessive managed IPC entries';

test('disk byte capacity rejects before runtime.start and does not delete retained IPC', async (t) => {
  const f = await fixture(t);
  const retainedDir = await retained(f, 'completed-fixture', { complete: true, bytes: CORE_CALLS_MAX_BYTES - CORE_CALL_RESERVATION_BYTES + 1 });
  await capacityReason(f.bridge, 'gm_add', { kind: 'plan', claim: 'opaque' }, 'byte-limit', reserveMessage);
  assert.equal(f.starts.length, 0);
  assert.deepEqual(await fs.readdir(callsRoot(f)), ['completed-fixture']);
  assert.equal((await fs.stat(path.join(retainedDir, 'request.json'))).size, CORE_CALLS_MAX_BYTES - CORE_CALL_RESERVATION_BYTES + 1);
});

test('restart conservatively reserves unfinished directories but completed small calls use actual bytes', async (t) => {
  const f = await fixture(t, {}, { timeoutMs: 20000 });
  const count = CORE_CALLS_MAX_BYTES / CORE_CALL_RESERVATION_BYTES;
  for (let index = 0; index < count; index++) await retained(f, `unfinished-${index}`);
  const recovered = anotherBridge(f);
  await capacityReason(recovered, 'local_memory_append', { text: 'opaque' }, 'byte-limit', reserveMessage);
  assert.equal(f.starts.length, 0);
  assert.equal((await fs.readdir(callsRoot(f))).length, count);
  // Separate fixture emulates disk records whose cleanup was confirmed before restart.
  const g = await fixture(t, {}, { timeoutMs: 20000 });
  for (let index = 0; index <= count; index++) await retained(g, `complete-${index}`, { complete: true, bytes: 32 });
  const restarted = anotherBridge(g);
  for (let index = 0; index < 3; index++) await restarted.call(binding, 'fact_list');
  assert.equal(g.starts.length, 3);
  for (const call of g.starts) assert.equal((await fs.stat(path.join(call.cwd, '.complete'))).size, 0);
  await recovered.dispose(); await restarted.dispose();
});

test('a healthy history at the former 2048-directory ceiling admits a fact read without pruning', async t => {
  const f = await fixture(t, {}, { timeoutMs: 20000 });
  for (let i = 0; i < 2048; i++) await retained(f, `old-${i}`, { complete: true });
  await f.bridge.call({ ...binding, role: 'main' }, 'fact_list_page', { limit: 1 });
  assert.equal(f.starts.length, 1);
  assert.equal((await fs.readdir(callsRoot(f))).length, 2049);
  assert.equal((await fs.stat(path.join(callsRoot(f), 'old-0', '.complete'))).size, 0);
  await f.bridge.dispose();
});

test('directory capacity includes completed history, precedes simultaneous byte reservation and refuses without pruning', async (t) => {
  const f = await fixture(t, {}, { timeoutMs: 20000 });
  for (let index = 0; index < CORE_CALLS_MAX_DIRECTORIES; index++) await retained(f, `retained-${index}`, { complete: true,
    bytes: index === 0 ? CORE_CALLS_MAX_BYTES - CORE_CALL_RESERVATION_BYTES + 1 : 0 });
  await capacityReason(f.bridge, 'gm_add', { kind: 'plan', claim: 'opaque' }, 'directory-limit', reserveMessage);
  assert.equal(f.starts.length, 0);
  assert.equal((await fs.readdir(callsRoot(f))).length, CORE_CALLS_MAX_DIRECTORIES);
});

test('managed IPC scan refusals keep existing short-circuit order and messages', async t => {
  for (const [name, reason, message] of [
    ['entry before unsafe', 'entry-limit', unsafeMessage],
    ['unsafe before marker', 'unsafe-entry', unsafeMessage],
    ['marker before bytes', 'invalid-completion-marker', 'Invalid IPC completion marker'],
    ['file bytes before later marker', 'byte-limit', 'Managed IPC storage is full'],
  ]) await t.test(name, async t => {
    const f = await fixture(t, {}, { timeoutMs: 20000 });
    const dir = await retained(f, 'history'), marker = path.join(dir, '.complete'), large = path.join(dir, 'large');
    const readdir = fs.readdir, lstat = fs.lstat; let checks = 0, unsafeChecks = 0, laterChecks = 0;
    const file = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, nlink: 1, size: 0, mode: 0o600 };
    t.mock.method(fs, 'readdir', async (p, ...args) => p !== dir ? readdir(p, ...args) : name === 'entry before unsafe'
      ? [...Array(16384).fill('small'), '.complete', 'later'] : name === 'file bytes before later marker' ? ['large', '.complete', 'later'] : ['.complete', 'later']);
    t.mock.method(fs, 'lstat', async (p, ...args) => {
      if (p === path.join(dir, 'small')) { checks++; return file; }
      if (p === path.join(dir, 'later')) { laterChecks++; return file; }
      if (p === large) return { ...file, size: CORE_CALLS_MAX_BYTES + 1 };
      if (p !== marker) return lstat(p, ...args);
      return { ...file, size: CORE_CALLS_MAX_BYTES + 1, isSymbolicLink() {
        unsafeChecks++; return ['entry before unsafe', 'unsafe before marker'].includes(name);
      } };
    });
    await capacityReason(f.bridge, 'fact_list', {}, reason, message);
    assert.equal(f.starts.length, 0); assert.deepEqual(await fs.readdir(callsRoot(f)), ['history']);
    assert.equal(laterChecks, 0); assert.equal(unsafeChecks, name === 'unsafe before marker' || name === 'marker before bytes' ? 1 : 0);
    assert.equal(checks, name === 'entry before unsafe' ? 16384 : 0);
  });
});

test('managed IPC proof is exact bridge, promise, error and operation; SDK replay cannot renew it', async t => {
  const f = await fixture(t, { exited: true });
  const dir = await retained(f, 'history', { complete: true }), marker = path.join(dir, '.complete');
  await fs.chmod(marker, 0o644);
  const { pending, caught } = await capacityReason(f.bridge, 'fact_list', {}, 'invalid-completion-marker', 'Invalid IPC completion marker');
  const projection = runtime.runtimeFailureInfo(caught), other = anotherBridge(f);
  const forwarded = pending.catch(e => e); await forwarded;
  assert.equal(ipcReason(other, pending, caught, 'fact_list'), null);
  assert.equal(ipcReason(f.bridge, forwarded, caught, 'fact_list'), null);
  assert.equal(ipcReason(f.bridge, pending, caught, 'fact_get'), null);
  for (const fake of [Object.assign(new Error(caught.message), caught), projection, { runtime: projection }, { runtime: caught }, { cause: caught }])
    assert.equal(ipcReason(f.bridge, pending, fake, 'fact_list'), null);
  assert.deepEqual(Object.keys(f.bridge), ['call', 'dispose']);
  assert.doesNotMatch(JSON.stringify(caught), /invalid-completion-marker/);
  assert.doesNotMatch(JSON.stringify(projection), /invalid-completion-marker/);
  await fs.chmod(marker, 0o600);
  const priorRequest = caught.requestId;
  for (const sdkError of [Object.assign(new Error('same SDK code'), { code: 'RESEARCH_RUNTIME_CAPACITY' }), caught]) {
    f.sdk.runtime.get = async () => { throw sdkError; };
    const current = f.bridge.call(binding, 'fact_list');
    await assert.rejects(current, e => e === sdkError && e.code === 'RESEARCH_RUNTIME_CAPACITY' && e.startOutcome === 'acknowledged');
    assert.notEqual(sdkError.requestId, priorRequest);
    assert.equal(ipcReason(f.bridge, current, sdkError, 'fact_list'), null);
  }
  assert.equal(f.starts.length, 2); assert.equal(ipcReason(f.bridge, pending, caught, 'fact_list'), null, 'Restamped old object no longer agrees with its old request');
  await f.bridge.dispose(); await other.dispose();
});

test('two bridge instances serialize disk reservation; confirmed cleanup releases only the byte reserve', async (t) => {
  const gate = deferred(); const behavior = { exited: true, start: gate };
  const f = await fixture(t, behavior, { timeoutMs: 20000 });
  await retained(f, 'near-capacity', { complete: true, bytes: CORE_CALLS_MAX_BYTES - CORE_CALL_RESERVATION_BYTES - 1024 });
  const second = anotherBridge(f);
  const firstCall = f.bridge.call(binding, 'fact_list').then((value) => ({ value }), (error) => ({ error }));
  const secondCall = second.call(binding, 'fact_list').then((value) => ({ value }), (error) => ({ error }));
  const info = await f.started.promise;
  const refusal = await Promise.race([firstCall, secondCall]);
  assert.equal(refusal.error.code, 'RESEARCH_RUNTIME_CAPACITY');
  assert.equal(refusal.error.indeterminate, false);
  assert.equal(f.starts.length, 1);
  delete behavior.start;
  gate.resolve(info);
  const results = await Promise.all([firstCall, secondCall]);
  assert.equal(results.filter((item) => item.value).length, 1);
  await second.call(binding, 'fact_list');
  assert.equal(f.starts.length, 2);
  await second.dispose();
});

test('unconfirmed cleanup retains disk reservation across a new bridge', async (t) => {
  const f = await fixture(t, { startError: true }, { timeoutMs: 20000 });
  await retained(f, 'near-capacity', { complete: true, bytes: CORE_CALLS_MAX_BYTES - CORE_CALL_RESERVATION_BYTES - 1024 });
  await assert.rejects(f.bridge.call(binding, 'gm_add'), (error) => error.indeterminate && !error.cleanup.confirmed);
  assert.equal(f.starts.length, 1);
  await assert.rejects(fs.stat(path.join(f.starts[0].cwd, '.complete')), { code: 'ENOENT' });
  const recovered = anotherBridge(f);
  await capacityRejected(recovered.call(binding, 'gm_add'));
  assert.equal(f.starts.length, 1);
});

test('dispose during request preparation cannot release a reservation while file writes remain pending', async (t) => {
  const f = await fixture(t, {}, { timeoutMs: 20000 });
  const entered = deferred(), release = deferred(); const original = fs.open;
  fs.open = async (file, ...args) => {
    if (String(file).startsWith(callsRoot(f)) && path.basename(file) === 'request.json') {
      entered.resolve(path.dirname(file)); await release.promise;
    }
    return original(file, ...args);
  };
  t.after(() => { fs.open = original; release.resolve(); });
  const pending = f.bridge.call(binding, 'gm_add').catch((error) => error);
  const directory = await entered.promise;
  await assert.rejects(f.bridge.dispose(), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED' });
  await assert.rejects(fs.stat(path.join(directory, '.complete')), { code: 'ENOENT' });
  release.resolve();
  const error = await pending;
  assert.equal(error.code, 'RESEARCH_RUNTIME_DISPOSED');
  assert.equal(error.cleanup.confirmed, true);
  assert.equal(f.starts.length, 0);
  assert.equal((await fs.stat(path.join(directory, '.complete'))).size, 0);
});

test('unsupported installation and symlink data root never start', async (t) => {
  const f = await fixture(t, {}, { platform: 'linux' }); await rejects(f.bridge.call(binding, 'fact_list'), 'UNSUPPORTED'); assert.equal(f.starts.length, 0);
  const g = await fixture(t); const target = g.sdk.dataDir + '-link'; await fs.symlink(g.sdk.dataDir, target); g.sdk.dataDir = target;
  await rejects(g.bridge.call(binding, 'fact_list'), 'PATH_INVALID'); assert.equal(g.starts.length, 0);
});
