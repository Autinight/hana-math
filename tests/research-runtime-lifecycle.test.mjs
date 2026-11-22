// Fixed SDK/stream software fixtures only. No Python, managed process or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createResearchRuntime, runtimeFailureInfo } from '../packages/hana-math/runtime/research-runtime.mjs';
const binding = { projectId: 'fixture', runId: 'fixture-run', role: 'main', author: 'fixture' };
const runtimeKeys = ['runtimeState', 'exitCode', 'signal', 'enforcement', 'backend'];
const runtimePart = (value) => Object.fromEntries(runtimeKeys.map((key) => [key, value[key]]));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(setImmediate);
const sdkError = (operation, patch = {}) => Object.assign(new Error('/private/SECRET raw host message and argv'), {
  code: 'APP_HOST_ERROR', operation, kind: 'host', details: { path: '/private/SECRET' }, ...patch,
});
const denial = () => sdkError('runtime.start', { code: 'APP_CAPABILITY_DENIED', kind: 'permission', capability: 'app/runtime.execute' });
async function fixture(t, hooks = {}, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const packageRoot = path.join(base, 'package'), dataDir = path.join(base, 'data'); await fs.mkdir(dataDir);
  const metadata = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' };
  for (const [name, text] of Object.entries({ 'dependencies/runtime.json': JSON.stringify(metadata), [metadata.executable]: 'opaque executable fixture', 'runtime/research_entry.py': '# fixture', 'engine/src/hana_math_engine/research.py': '# fixture' })) {
    const file = path.join(packageRoot, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  }
  await fs.chmod(path.join(packageRoot, metadata.executable), 0o700);
  const calls = [], started = deferred(), watched = deferred();
  let info, directory;
  const sdk = { dataDir, runtime: {
    async start(input) {
      calls.push({ method: 'start', input });
      const request = JSON.parse(await fs.readFile(input.args[4], 'utf8')); directory = input.cwd;
      info = { runtimeId: request.requestId, runtime: 'command', profile: 'scoped', network: 'none', state: 'ready', exitCode: null };
      started.resolve(info);
      if (hooks.startError) throw hooks.startError;
      await fs.writeFile(input.args[5], JSON.stringify({ schemaVersion: 1, requestId: request.requestId, ok: true, result: { facts: [] } }), { mode: 0o600 });
      return hooks.start ? hooks.start(info) : info;
    },
    async get(id) { calls.push({ method: 'get', id }); return hooks.get ? hooks.get(info, id) : info; },
    async stop(id) { calls.push({ method: 'stop', id }); return hooks.stop ? hooks.stop(info, id) : (info = { ...info, state: 'stopped' }); },
    async watch(id) {
      calls.push({ method: 'watch', id }); watched.resolve();
      if (hooks.watch) return hooks.watch(info, id);
      info = { ...info, state: 'exited', exitCode: 0 };
      return new Response(JSON.stringify({ type: 'state', runtime: info }) + '\n');
    },
    list() { assert.fail('Never infer runtime identity using list'); },
  } };
  const bridge = createResearchRuntime(sdk, { packageRoot, platform: 'darwin', arch: 'arm64', timeoutMs: 1000, cleanupTimeoutMs: 50, ...options });
  return { bridge, sdk, calls, started, watched, get directory() { return directory; }, get info() { return info; }, set info(value) { info = value; } };
}
function hangingStream() {
  let controller; const body = new ReadableStream({ start(value) { controller = value; } });
  return { response: new Response(body), terminal(info) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'state', runtime: info }) + '\n')); controller.close(); } };
}
async function cancelCall(f) {
  const controller = new AbortController();
  const pending = f.bridge.call(binding, 'fact_list', {}, undefined, { signal: controller.signal }).then(() => { assert.fail('cancelled call succeeded'); }, (e) => e);
  await f.watched.promise; controller.abort(); return pending;
}

// Intercept only the completion marker handle; all file creation/close work is
// real fixture IO. No sync fallback, process execution or permission expansion.
function markerHandles(t, close) {
  const open = fs.open.bind(fs), events = []; let opens = 0, closes = 0, synced = 0, closed = 0;
  t.mock.method(fs, 'open', async (...args) => {
    if (path.basename(String(args[0])) !== '.complete') return open(...args);
    events.push(`open:${++opens}`);
    const handle = await open(...args);
    return {
      sync: async () => { synced++; assert.fail('The empty IPC reservation marker must not call sync'); },
      close: async () => {
        const attempt = ++closes; events.push(`close:${attempt}`);
        if (close) await close(attempt);
        await handle.close(); closed++; events.push(`closed:${attempt}`);
      },
    };
  });
  return { events, get opens() { return opens; }, get closes() { return closes; }, get synced() { return synced; }, get closed() { return closed; } };
}

test('completion marker creation closes the real handle without sync', async (t) => {
  const observed = markerHandles(t); const f = await fixture(t);
  assert.deepEqual(await f.bridge.call(binding, 'fact_list'), { facts: [] });
  await f.bridge.dispose();
  assert.equal(observed.synced, 0); assert.equal(observed.opens, 1); assert.equal(observed.closed, 1);
  const stat = await fs.lstat(path.join(f.directory, '.complete'));
  assert.equal(stat.isFile(), true); assert.equal(stat.nlink, 1); assert.equal(stat.size, 0); assert.equal(stat.mode & 0o777, 0o600);
});

for (const code of ['EIO', 'EEXIST']) test(`completion marker retries failed close ${code} before allowing EEXIST confirmation`, async (t) => {
  const observed = markerHandles(t, async (attempt) => { if (attempt === 1) throw Object.assign(new Error('fixture close failure'), { code }); });
  const f = await fixture(t);
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e);
  assert.equal(error.code, 'RESEARCH_RUNTIME_CLEANUP_FAILED'); assert.equal(error.phase, 'cleanup-marker');
  assert.equal(error.cleanup.confirmed, false); assert.equal(observed.closed, 0); assert.equal(observed.opens, 1);
  assert.equal((await fs.lstat(path.join(f.directory, '.complete'))).size, 0);
  await f.bridge.dispose();
  assert.deepEqual(observed.events, ['open:1', 'close:1', 'close:2', 'closed:2', 'open:2']);
  assert.equal(error.cleanup.confirmed, true); assert.equal(error.indeterminate, true);
  assert.equal(observed.closed, 1); assert.equal(observed.synced, 0);
});

test('completion marker persistent close rejection never confirms via existing marker', async (t) => {
  let failClose = true;
  const observed = markerHandles(t, async () => { if (failClose) throw Object.assign(new Error('fixture close failure'), { code: 'EIO' }); });
  const f = await fixture(t);
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.bridge.dispose(), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED' });
    assert.equal(error.cleanup.confirmed, false); assert.equal(observed.opens, 1); assert.equal(observed.closed, 0);
  }
  assert.equal(observed.closes, 3); assert.equal(observed.synced, 0);
  failClose = false; await f.bridge.dispose(); // Release the real fixture descriptor only after the failure assertions.
  assert.equal(observed.closed, 1); assert.equal(error.cleanup.confirmed, true); assert.equal(error.indeterminate, true);
});

test('completion marker delayed close holds the serial lock beyond the cleanup budget', async (t) => {
  const gate = deferred(), entered = deferred();
  const observed = markerHandles(t, async () => { entered.resolve(); await gate.promise; });
  const f = await fixture(t, {}, { cleanupTimeoutMs: 50 });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const calling = f.bridge.call(binding, 'fact_list').catch((e) => e);
  await entered.promise; t.mock.timers.tick(51);
  const error = await calling;
  assert.equal(error.phase, 'cleanup-marker'); assert.equal(error.cleanup.confirmed, false);
  let settled = false;
  const disposing = f.bridge.dispose().then(() => { settled = true; });
  await turn(); await turn();
  assert.equal(settled, false); assert.equal(observed.closes, 1); assert.equal(observed.opens, 1); assert.equal(observed.closed, 0);
  assert.equal(error.cleanup.confirmed, false);
  gate.resolve(); await disposing;
  assert.equal(error.cleanup.confirmed, true); assert.equal(error.indeterminate, true);
  assert.deepEqual(observed.events, ['open:1', 'close:1', 'closed:1', 'open:2']);
  assert.equal(observed.synced, 0);
});

for (const taskId of [undefined, 'fixture-core-task']) test(`trusted Core task binding models SDK token injection: ${taskId || 'original owner scope'}`, async (t) => {
  const f = await fixture(t, {}, taskId ? { taskId } : {}), start = f.sdk.runtime.start, packets = [];
  const currentToken = taskId ? 'fixture-worker-token' : 'fixture-owner-token';
  f.sdk.runtime.start = async (input) => {
    // Fixed model of the public SDK branch, not an ALS escape or Host proof.
    const packet = { ...input };
    if (!packet.taskId && !packet.callToken) packet.callToken = currentToken;
    const sessionId = packet.taskId ? null : 'fixture-owner-session';
    if (packet.taskId) {
      assert.equal(packet.taskId, 'fixture-core-task'); assert.equal(packet.callToken, undefined); assert.equal(sessionId, null);
    } else { assert.equal(packet.callToken, currentToken); assert.equal(sessionId, 'fixture-owner-session'); }
    for (const key of ['scope', 'readRoots', 'writeRoots']) assert.equal(Object.hasOwn(packet, key), false);
    assert.equal(input.callToken, undefined); assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none');
    packets.push(packet); return start(packet);
  };
  assert.deepEqual(await f.bridge.call(binding, 'fact_list'), { facts: [] }); await f.bridge.dispose();
  assert.equal(packets.length, 1);
  assert.equal(Object.hasOwn(packets[0], 'taskId'), taskId !== undefined);
  assert.equal(f.calls.filter((c) => c.method === 'start').length, 1);
});

test('Host rejection of a trusted task never retries with caller scope or treats it as no-spawn proof', async (t) => {
  const f = await fixture(t, { startError: sdkError('runtime.start', { code: 'APP_RUNTIME_SCOPE_DENIED' }) }, { taskId: 'fixture-core-task' });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e);
  assert.equal(error.startOutcome, 'unknown'); assert.equal(error.cleanup.confirmed, false); assert.equal(error.indeterminate, true);
  await assert.rejects(f.bridge.dispose(), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED' });
  assert.equal(f.calls.filter((call) => call.method === 'start').length, 1);
  assert.equal(f.calls[0].input.taskId, 'fixture-core-task'); assert.equal(f.calls[0].input.callToken, undefined);
});

test('trusted task ID is constructor-only, strictly bounded, with no per-call or model binding override', async (t) => {
  for (const taskId of [null, '', '../foreign', 'bad\nvalue', 3, {}, 'x'.repeat(257)]) {
    assert.throws(() => createResearchRuntime({}, { taskId }), { code: 'RESEARCH_RUNTIME_INVALID_REQUEST' });
  }
  const f = await fixture(t, {}, { taskId: 'fixture-core-task' });
  await assert.rejects(f.bridge.call({ ...binding, taskId: 'foreign' }, 'fact_list'), { code: 'RESEARCH_RUNTIME_INVALID_REQUEST' });
  await assert.rejects(f.bridge.call(binding, 'fact_list', {}, undefined, { taskId: 'foreign' }), { code: 'RESEARCH_RUNTIME_INVALID_REQUEST' });
  assert.equal(f.calls.length, 0); await f.bridge.dispose();
});

test('only the exact start denial triple proves no spawn; no retry or fallback and dispose confirms', async (t) => {
  const original = denial(); const f = await fixture(t, { startError: original });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e); const dto = runtimeFailureInfo(error);
  assert.equal(error.cause, original); assert.equal(dto.code, 'RESEARCH_RUNTIME_DENIED'); assert.equal(dto.phase, 'start');
  assert.equal(dto.startOutcome, 'rejected-before-spawn'); assert.equal(dto.runtimeId, null); assert.equal(dto.processTerminalConfirmed, false);
  assert.equal(dto.indeterminate, false); assert.equal(dto.cleanup.confirmed, true);
  assert.deepEqual(dto.sdk, { code: 'APP_CAPABILITY_DENIED', operation: 'runtime.start', kind: 'permission', capability: 'app/runtime.execute' });
  assert.deepEqual(f.calls.map((c) => c.method), ['start']); await f.bridge.dispose(); await f.bridge.dispose();
  assert.equal((await fs.stat(path.join(f.directory, '.complete'))).size, 0);
  assert.ok(!JSON.stringify(dto).includes('SECRET'));
});

for (const field of ['code', 'operation', 'capability']) test(`denial missing ${field} remains unknown and dispose retains primary`, async (t) => {
  const cause = denial(); delete cause[field]; const f = await fixture(t, { startError: cause });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e);
  assert.equal(runtimeFailureInfo(error).startOutcome, 'unknown'); assert.equal(error.cleanup.confirmed, false); assert.equal(error.indeterminate, true);
  await assert.rejects(f.bridge.dispose(), (e) => {
    const dto = runtimeFailureInfo(e); assert.equal(dto.phase, 'dispose'); assert.equal(dto.requests.length, 1);
    assert.equal(dto.requests[0].primary.requestId, error.requestId); assert.equal(dto.requests[0].primary.code, error.code);
    assert.equal(dto.requests[0].primary.startOutcome, 'unknown'); assert.equal(dto.requests[0].primary.phase, 'start');
    assert.ok(!JSON.stringify(dto).includes('SECRET')); return true;
  });
  assert.equal(f.calls.length, 1);
});

for (const cause of [sdkError('runtime.start'), sdkError('runtime.stop', { code: 'APP_CAPABILITY_DENIED', capability: 'app/runtime.execute' }), sdkError('runtime.start', { code: 'APP_CAPABILITY_DENIED', capability: 'app/runtime.native' })]) {
  test(`non-proof rejection ${cause.code}/${cause.operation}/${cause.capability || 'none'} remains unknown`, async (t) => {
    const f = await fixture(t, { startError: cause });
    const error = await f.bridge.call(binding, 'fact_list').catch((e) => e);
    assert.equal(runtimeFailureInfo(error).startOutcome, 'unknown'); assert.equal(error.cleanup.confirmed, false);
    await assert.rejects(f.bridge.dispose(), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED' }); assert.equal(f.calls.length, 1);
  });
}

test('invalid start receipt does not turn an unconfirmed supplied ID into owned identity', async (t) => {
  const f = await fixture(t, { start: (info) => ({ ...info, profile: 'native' }) });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e);
  assert.equal(error.code, 'RESEARCH_RUNTIME_INVALID_RESULT'); assert.equal(runtimeFailureInfo(error).runtimeId, null);
  assert.equal(error.startOutcome, 'unknown'); await assert.rejects(f.bridge.dispose()); assert.equal(f.calls.length, 1);
});

test('stop accepts stopping but waits for terminal watch evidence after exact-ID get', async (t) => {
  const stream = hangingStream(), stopping = deferred();
  const f = await fixture(t, { watch: () => stream.response, stop: (info) => { stopping.resolve(); return { ...info, state: 'stopping' }; } });
  let settled = false; const pending = cancelCall(f).then((e) => { settled = true; return e; });
  await stopping.promise; await turn(); assert.equal(settled, false);
  stream.terminal({ ...f.info, state: 'stopped' });
  const error = await pending; const dto = runtimeFailureInfo(error);
  assert.equal(dto.phase, 'watch'); assert.equal(dto.startOutcome, 'acknowledged'); assert.equal(dto.processTerminalConfirmed, true); assert.equal(dto.cleanup.confirmed, true);
  const operations = f.calls.map((c) => c.method); assert.ok(operations.indexOf('get') < operations.indexOf('stop'));
  assert.ok(f.calls.filter((c) => c.id).every((c) => c.id === dto.runtimeId)); await f.bridge.dispose();
});

test('stop RPC rejection is retryable and the original cancellation remains primary', async (t) => {
  const stream = hangingStream(); let stops = 0;
  const f = await fixture(t, { watch: () => stream.response, stop: (info) => {
    if (++stops === 1) throw sdkError('runtime.stop'); return { ...info, state: 'stopped' };
  } });
  const error = await cancelCall(f); const initial = runtimeFailureInfo(error);
  assert.equal(initial.code, 'RESEARCH_RUNTIME_CANCELLED'); assert.equal(initial.cleanup.confirmed, false);
  assert.ok(initial.cleanup.errorCodes.includes('APP_HOST_ERROR'));
  await f.bridge.dispose(); assert.equal(stops, 2);
  const final = runtimeFailureInfo(error); assert.equal(final.code, initial.code); assert.equal(final.phase, initial.phase);
  assert.equal(final.cleanup.confirmed, true); assert.equal(final.processTerminalConfirmed, true);
});

test('reader cancellation failure retains its lock and retries instead of caching rejection', async (t) => {
  const read = deferred(); let cancels = 0, releases = 0;
  const reader = { read: () => read.promise, cancel: async () => { if (++cancels === 1) throw sdkError('runtime.watch'); read.resolve({ done: true }); }, releaseLock: () => { releases++; } };
  const f = await fixture(t, { watch: () => ({ ok: true, body: { getReader: () => reader } }) });
  const error = await cancelCall(f);
  assert.equal(error.cleanup.confirmed, false); assert.equal(releases, 0); assert.equal(cancels, 1);
  await f.bridge.dispose(); assert.equal(cancels, 2); assert.equal(releases, 1); assert.equal(error.cleanup.confirmed, true);
});

test('cleanup-only failure and dispose preserve first SDK cause without implying a residual process', async (t) => {
  let released = 0, canCancel = false, reads = 0;
  const f = await fixture(t, { watch: (info) => ({ ok: true, body: { getReader: () => ({
    read: async () => ++reads === 1 ? { value: new TextEncoder().encode(JSON.stringify({ type: 'state', runtime: { ...info, state: 'exited', exitCode: 0, enforcement: 'full', backend: 'fixture-backend' } }) + '\n') } : { done: true },
    cancel: async () => { if (!canCancel) throw sdkError('runtime.watch'); }, releaseLock: () => { released++; },
  }) } }) });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e); const first = runtimeFailureInfo(error);
  assert.equal(first.code, 'RESEARCH_RUNTIME_CLEANUP_FAILED'); assert.equal(first.phase, 'cleanup-reader');
  assert.equal(first.processTerminalConfirmed, true); assert.equal(first.sdk.operation, 'runtime.watch'); assert.equal(released, 0);
  assert.deepEqual(runtimePart(first), { runtimeState: 'exited', exitCode: 0, signal: null, enforcement: 'full', backend: 'fixture-backend' });
  assert.deepEqual(runtimePart(error), runtimePart(first));
  await assert.rejects(f.bridge.dispose(), (e) => {
    const primary = runtimeFailureInfo(e).requests[0].primary;
    assert.equal(primary.requestId, first.requestId); assert.equal(primary.phase, first.phase); assert.equal(primary.sdk.code, 'APP_HOST_ERROR');
    assert.equal(primary.processTerminalConfirmed, true); assert.equal(primary.cleanup.confirmed, false);
    assert.deepEqual(runtimePart(primary), runtimePart(first));
    const aggregate = runtimeFailureInfo(e);
    assert.deepEqual(runtimeFailureInfo(JSON.parse(JSON.stringify(aggregate))), aggregate); return true;
  });
  canCancel = true; await f.bridge.dispose(); assert.equal(error.cleanup.confirmed, true); assert.equal(released, 1);
  assert.equal(runtimeFailureInfo(error).sdk.code, 'APP_HOST_ERROR');
});

test('a late old get receipt cannot undo terminal evidence and unresolved RPC prevents premature cleanup', async (t) => {
  const get = deferred(), entered = deferred();
  const f = await fixture(t, { get: () => { entered.resolve(); return get.promise; } }, { timeoutMs: 40, cleanupTimeoutMs: 20 });
  const pending = f.bridge.call(binding, 'fact_list').catch((e) => e); await entered.promise;
  const error = await pending; assert.equal(error.processTerminalConfirmed, true); assert.equal(error.cleanup.confirmed, false);
  get.resolve({ ...f.info, state: 'ready', exitCode: null }); await f.bridge.dispose();
  assert.equal(error.processTerminalConfirmed, true); assert.equal(error.cleanup.confirmed, true); assert.equal(error.phase, 'get');
  assert.equal(f.calls.filter((c) => c.method === 'stop').length, 0);
});

test('late start is reconciled by its receipt, with no list guessing or false pre-spawn claim', async (t) => {
  const start = deferred(); const f = await fixture(t, { start: () => start.promise }, { timeoutMs: 35, cleanupTimeoutMs: 20 });
  const pending = f.bridge.call(binding, 'fact_list').catch((e) => e); const info = await f.started.promise;
  const error = await pending; assert.equal(error.startOutcome, 'unknown'); assert.equal(error.runtimeId, null); assert.equal(error.cleanup.confirmed, false);
  const stopped = deferred(), originalStop = f.sdk.runtime.stop;
  f.sdk.runtime.stop = async (...args) => { const receipt = await originalStop(...args); stopped.resolve(); return receipt; };
  start.resolve(info); await stopped.promise; // Late receipt itself initiates compensation, not dispose.
  await f.bridge.dispose();
  assert.equal(error.startOutcome, 'acknowledged'); assert.equal(error.runtimeId, info.runtimeId); assert.equal(error.cleanup.confirmed, true);
  assert.equal(f.calls.filter((c) => c.method === 'start').length, 1); assert.equal(f.calls.filter((c) => c.method === 'stop').length, 1);
});

test('late watch response is closed after terminal process confirmation, not leaked', async (t) => {
  const watch = deferred(), closed = deferred(); let cancelled = 0;
  const f = await fixture(t, { watch: () => watch.promise }, { timeoutMs: 35, cleanupTimeoutMs: 20 });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e);
  assert.equal(error.processTerminalConfirmed, true); assert.equal(error.cleanup.confirmed, false);
  watch.resolve(new Response(new ReadableStream({ cancel() { cancelled++; closed.resolve(); } })));
  await closed.promise; await f.bridge.dispose(); assert.equal(cancelled, 1); assert.equal(error.cleanup.confirmed, true);
});

test('cleanup uses one total budget across get, stopping acknowledgement and watch wait', async (t) => {
  const get = deferred(), stop = deferred(), got = deferred(), stopping = deferred(), stream = hangingStream();
  const f = await fixture(t, { watch: () => stream.response, get: () => { got.resolve(); return get.promise; }, stop: () => { stopping.resolve(); return stop.promise; } }, { cleanupTimeoutMs: 100 });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const pending = cancelCall(f); await got.promise; const start = Date.now();
  t.mock.timers.tick(60); get.resolve(f.info); await stopping.promise;
  t.mock.timers.tick(39); stop.resolve({ ...f.info, state: 'stopping' }); await turn();
  t.mock.timers.tick(2); const error = await pending;
  assert.equal(Date.now() - start, 101); assert.equal(error.cleanup.confirmed, false); assert.equal(error.processTerminalConfirmed, false);
  assert.ok(error.cleanup.errors.some((e) => e.phase === 'cleanup-watch'));
  stream.terminal({ ...f.info, state: 'stopped' }); await turn(); await f.bridge.dispose(); assert.equal(error.cleanup.confirmed, true);
});

test('watch RPC failure is not permanently cached across explicit cleanup attempts', async (t) => {
  let watches = 0;
  const f = await fixture(t, { stop: (info) => ({ ...info, state: 'stopping' }), watch: (info) => {
    if (++watches <= 2) throw sdkError('runtime.watch');
    return new Response(JSON.stringify({ type: 'state', runtime: { ...info, state: 'stopped' } }) + '\n');
  } });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e);
  assert.equal(error.cleanup.confirmed, false); assert.equal(error.phase, 'watch'); assert.equal(watches, 2);
  await f.bridge.dispose(); assert.equal(watches, 3); assert.equal(error.cleanup.confirmed, true);
  assert.equal(runtimeFailureInfo(error).sdk.operation, 'runtime.watch');
});

test('even an exact-looking denial from get cannot reclassify an acknowledged start', async (t) => {
  const f = await fixture(t, { get: () => { throw denial(); } });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e);
  const dto = runtimeFailureInfo(error); assert.equal(dto.phase, 'get'); assert.equal(dto.startOutcome, 'acknowledged');
  assert.equal(dto.processTerminalConfirmed, true); assert.equal(dto.cleanup.confirmed, true); await f.bridge.dispose();
});

test('late exact pre-spawn rejection resolves only the startup uncertainty, retaining the initial timeout', async (t) => {
  const start = deferred(); const f = await fixture(t, { start: () => start.promise }, { timeoutMs: 35, cleanupTimeoutMs: 20 });
  const pending = f.bridge.call(binding, 'fact_list').catch((e) => e); await f.started.promise;
  const error = await pending; const initial = runtimeFailureInfo(error);
  assert.equal(initial.code, 'RESEARCH_RUNTIME_TIMEOUT'); assert.equal(initial.startOutcome, 'unknown'); assert.equal(initial.indeterminate, true);
  start.reject(denial()); await f.bridge.dispose();
  const final = runtimeFailureInfo(error); assert.equal(final.code, initial.code); assert.equal(final.phase, initial.phase);
  assert.equal(final.startOutcome, 'rejected-before-spawn'); assert.equal(final.cleanup.confirmed, true); assert.equal(final.indeterminate, false);
  assert.equal(final.sdk.code, 'APP_CAPABILITY_DENIED');
  assert.equal(final.runtimeId, null); assert.deepEqual(f.calls.map((c) => c.method), ['start']);
});

const hostRuntimeCodes = [
  // Current server artifact 1.5.48-beta, bundle/index.js:171552–171570.
  'APP_RUNTIME_CAPABILITY_DENIED', 'APP_RUNTIME_NETWORK_DENIED', 'APP_RUNTIME_NATIVE_DENIED', 'APP_RUNTIME_LOCAL_MACHINE_DENIED',
  'APP_RUNTIME_DISPOSED', 'APP_RUNTIME_SANDBOX_UNAVAILABLE', 'APP_RUNTIME_LOOPBACK_UNSUPPORTED', 'APP_RUNTIME_INVALID_INPUT',
  'APP_RUNTIME_SCOPE_DENIED', 'APP_RUNTIME_CONCURRENCY_LIMIT', 'APP_RUNTIME_NOT_FOUND', 'APP_RUNTIME_NOT_READY',
  'APP_RUNTIME_FETCH_TIMEOUT', 'APP_RUNTIME_FETCH_RESPONSE_TOO_LARGE', 'APP_RUNTIME_SERVICE_STOPPED', 'APP_RUNTIME_SERVICE_UNAVAILABLE',
  'APP_RUNTIME_SERVICE_ID_CONFLICT', 'APP_RUNTIME_SERVICE_OBSERVER_LIMIT',
];
const persistedAgain = (dto) => runtimeFailureInfo(JSON.parse(JSON.stringify(dto)));

for (const terminal of [
  { state: 'exited', exitCode: 7, signal: null, enforcement: 'full', backend: 'macos-seatbelt' },
  { state: 'stopped', exitCode: null, signal: 'SIGTERM', enforcement: 'partial', backend: 'fixture_runtime' },
]) test(`verified terminal diagnostics distinguish exit and signal: ${terminal.state}/${terminal.exitCode}/${terminal.signal}`, async (t) => {
  const f = await fixture(t, { start: (info) => ({ ...info, ...terminal }) });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e); const dto = runtimeFailureInfo(error);
  const { state, ...rest } = terminal;
  assert.equal(dto.code, 'RESEARCH_RUNTIME_FAILED'); assert.equal(dto.processTerminalConfirmed, true);
  assert.deepEqual(runtimePart(dto), { runtimeState: state, ...rest }); assert.deepEqual(runtimePart(error), runtimePart(dto));
  assert.deepEqual(persistedAgain(dto), dto);
  // Fixture get returns an older ready record: terminal diagnostics must not regress.
  assert.deepEqual(f.calls.map((c) => c.method), ['start', 'get']); await f.bridge.dispose();
});

test('unacknowledged receipts and absent status never supply runtime diagnostics', async (t) => {
  const diagnostic = { state: 'exited', exitCode: 1, signal: 'SIGKILL', enforcement: 'full', backend: 'fixture-backend' };
  const f = await fixture(t, { start: (info) => ({ ...info, ...diagnostic, profile: 'native' }) });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e);
  assert.equal(error.code, 'RESEARCH_RUNTIME_INVALID_RESULT');
  assert.deepEqual(runtimePart(error), Object.fromEntries(runtimeKeys.map((key) => [key, null])));
  assert.deepEqual(runtimePart(runtimeFailureInfo(error)), runtimePart(error));
  await assert.rejects(f.bridge.dispose(), (e) => {
    const dto = runtimeFailureInfo(e); assert.deepEqual(runtimePart(dto.requests[0].primary), runtimePart(error));
    assert.deepEqual(persistedAgain(dto), dto); return true;
  });
  const g = await fixture(t, { startError: Object.assign(denial(), diagnostic) });
  const denied = await g.bridge.call(binding, 'fact_list').catch((e) => e);
  assert.deepEqual(runtimePart(denied), runtimePart(error)); await g.bridge.dispose();
});

test('runtime diagnostic scalars are bounded, getter-safe and JSON-idempotent', () => {
  for (const value of [undefined, null, '', '/private/SECRET', 'https://SECRET', 'raw SECRET message', {}, [], NaN, Infinity]) {
    const dto = runtimeFailureInfo(Object.fromEntries(runtimeKeys.map((key) => [key, value])));
    assert.deepEqual(runtimePart(dto), Object.fromEntries(runtimeKeys.map((key) => [key, null])));
    assert.deepEqual(persistedAgain(dto), dto); assert.ok(!JSON.stringify(dto).includes('SECRET'));
  }
  for (const exitCode of [-2147483649, 2147483648, 1.5, '7']) assert.equal(runtimeFailureInfo({ exitCode }).exitCode, null);
  for (const exitCode of [-2147483648, 0, 2147483647]) assert.equal(runtimeFailureInfo({ exitCode }).exitCode, exitCode);
  const zero = runtimeFailureInfo({ exitCode: -0 }); assert.equal(zero.exitCode, 0); assert.deepEqual(persistedAgain(zero), zero);
  for (const signal of ['sigterm', 'SIG', 'SIGTERM /private/SECRET', 'SIG' + 'A'.repeat(30)]) assert.equal(runtimeFailureInfo({ signal }).signal, null);
  for (const backend of ['../backend', 'https://host', 'C:\\private\\SECRET', 'x'.repeat(65)]) assert.equal(runtimeFailureInfo({ backend }).backend, null);
  for (const runtimeState of ['starting', 'ready', 'stopping', 'exited', 'failed', 'stopped']) {
    for (const enforcement of ['full', 'partial', 'none']) {
      const dto = runtimeFailureInfo({ runtimeState, exitCode: 0, signal: 'SIGKILL', enforcement, backend: 'x'.repeat(64) });
      assert.equal(dto.runtimeState, runtimeState); assert.equal(dto.enforcement, enforcement); assert.equal(dto.signal, 'SIGKILL');
      assert.equal(dto.backend.length, 64); assert.deepEqual(persistedAgain(dto), dto);
    }
  }
  const getters = {};
  for (const key of runtimeKeys) Object.defineProperty(getters, key, { get() { assert.fail('must not invoke runtime diagnostic getters'); } });
  assert.deepEqual(runtimePart(runtimeFailureInfo(getters)), Object.fromEntries(runtimeKeys.map((key) => [key, null])));
});

for (const code of hostRuntimeCodes) test(`verified Host diagnostic ${code} survives JSON reprojection but does not prove no spawn`, async (t) => {
  const original = sdkError('runtime.start', { code, capability: 'app/runtime.execute' });
  const f = await fixture(t, { startError: original });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e); const dto = runtimeFailureInfo(error);
  assert.equal(dto.sdk.code, code); assert.equal(dto.sdk.operation, 'runtime.start');
  assert.equal(dto.startOutcome, 'unknown'); assert.equal(dto.cleanup.confirmed, false);
  assert.deepEqual(persistedAgain(dto), dto); assert.deepEqual(persistedAgain(persistedAgain(dto)), dto);
  await assert.rejects(f.bridge.dispose(), (e) => {
    const aggregate = runtimeFailureInfo(e); assert.equal(aggregate.requests[0].primary.sdk.code, code);
    assert.deepEqual(persistedAgain(aggregate), aggregate); return true;
  });
  assert.deepEqual(f.calls.map((c) => c.method), ['start']);
});

for (const fields of [
  ...['APP_TASK_SCOPE_INVALID', 'APP_CALL_TOKEN_INVALID'].flatMap((code) => ['runtime.start', 'tasks.resolveScope'].map((operation) =>
    ({ code, operation, kind: 'host', capability: null }))),
  ...['tasks.resolveScope', 'runtime.start'].map((operation) =>
    ({ code: 'APP_CAPABILITY_DENIED', operation, kind: 'permission', capability: 'app/tasks.manage' })),
]) test(`verified task authorization diagnostic ${fields.code}/${fields.operation} stays unknown through JSON`, async (t) => {
  const original = sdkError(fields.operation, { ...fields, token: 'SECRET_TOKEN', path: '/private/SECRET' });
  const f = await fixture(t, { startError: original }, { taskId: 'fixture-core-task' });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e);
  const dto = runtimeFailureInfo(error);
  assert.deepEqual(dto.sdk, fields);
  assert.equal(dto.startOutcome, 'unknown'); assert.equal(dto.cleanup.confirmed, false);
  assert.equal(dto.indeterminate, true); assert.equal(dto.processTerminalConfirmed, false); assert.equal(dto.runtimeId, null);
  assert.deepEqual(persistedAgain(dto), dto); assert.deepEqual(persistedAgain(persistedAgain(dto)), dto);
  assert.doesNotMatch(JSON.stringify(dto), /SECRET|\/private\/|SECRET_TOKEN/);
  await assert.rejects(f.bridge.dispose(), (e) => {
    assert.equal(e.code, 'RESEARCH_RUNTIME_CLEANUP_FAILED');
    const aggregate = runtimeFailureInfo(e);
    assert.equal(aggregate.cleanup.confirmed, false);
    assert.deepEqual(aggregate.requests[0].primary.sdk, fields);
    assert.equal(aggregate.requests[0].primary.startOutcome, 'unknown');
    assert.deepEqual(persistedAgain(aggregate), aggregate);
    assert.deepEqual(persistedAgain(persistedAgain(aggregate)), aggregate);
    assert.doesNotMatch(JSON.stringify(aggregate), /SECRET|\/private\/|SECRET_TOKEN/);
    return true;
  });
  assert.deepEqual(f.calls.map((c) => c.method), ['start']); // No retry, caller-scope fallback or inferred no-spawn.
});

test('JSON reprojection retains exact denial and late-start SDK evidence', async (t) => {
  const f = await fixture(t, { startError: denial() });
  const error = await f.bridge.call(binding, 'fact_list').catch((e) => e); const dto = runtimeFailureInfo(error);
  assert.equal(dto.startOutcome, 'rejected-before-spawn'); assert.deepEqual(persistedAgain(dto), dto); await f.bridge.dispose();
  const delayed = runtimeFailureInfo({ code: 'RESEARCH_RUNTIME_TIMEOUT', phase: 'start', startOutcome: 'rejected-before-spawn',
    startError: denial(), cleanup: { confirmed: true, errors: [] } });
  assert.equal(delayed.sdk.code, 'APP_CAPABILITY_DENIED'); assert.deepEqual(persistedAgain(delayed), delayed);
});

test('dispose DTO requests.primary and cleanup errors retain all safe SDK scalars after JSON storage', async (t) => {
  const stream = hangingStream();
  const f = await fixture(t, { watch: () => stream.response, stop: () => { throw sdkError('runtime.stop', { code: 'APP_RUNTIME_SANDBOX_UNAVAILABLE', kind: 'unavailable', capability: 'app/runtime.execute' }); } });
  const error = await cancelCall(f); const dto = runtimeFailureInfo(error);
  assert.ok(dto.cleanup.errorCodes.includes('APP_RUNTIME_SANDBOX_UNAVAILABLE'));
  assert.deepEqual(dto.cleanup.errors[0].sdk, { code: 'APP_RUNTIME_SANDBOX_UNAVAILABLE', operation: 'runtime.stop', kind: 'unavailable', capability: 'app/runtime.execute' });
  assert.deepEqual(persistedAgain(dto), dto);
  await assert.rejects(f.bridge.dispose(), (e) => {
    const aggregate = runtimeFailureInfo(e);
    assert.equal(aggregate.requests.length, 1); assert.equal(aggregate.requests[0].primary.requestId, error.requestId);
    assert.deepEqual(persistedAgain(aggregate), aggregate);
    assert.deepEqual(persistedAgain(persistedAgain(aggregate)), aggregate);
    assert.ok(!JSON.stringify(aggregate).includes('SECRET')); return true;
  });
  f.sdk.runtime.stop = async () => ({ ...f.info, state: 'stopped' }); await f.bridge.dispose();
});

test('persisted-looking sdk objects are still scalar-whitelisted, not trusted or expanded', () => {
  const secret = '/private/SECRET';
  const sdk = { operation: 'runtime.stop', code: 'APP_RUNTIME_UNRECOGNIZED_SECRET', kind: secret, capability: { path: secret },
    message: secret, stack: secret, details: secret, cause: { code: 'APP_RUNTIME_NOT_FOUND', operation: 'runtime.get' } };
  const primary = { sdk, cleanup: { confirmed: false, errorCodes: [secret], errors: [{ code: 'APP_HOST_ERROR', sdk }] } };
  const dto = runtimeFailureInfo({ ...primary, requests: [{ primary, path: secret }], details: secret });
  assert.deepEqual(dto.sdk, { code: null, operation: 'runtime.stop', kind: null, capability: null });
  assert.deepEqual(dto.cleanup.errorCodes, ['APP_HOST_ERROR']); assert.deepEqual(dto.requests[0].primary.sdk, dto.sdk);
  assert.deepEqual(dto.cleanup.errors[0].sdk, dto.sdk); assert.ok(!JSON.stringify(dto).includes('SECRET'));
  assert.deepEqual(persistedAgain(dto), dto);
  for (const value of [null, [], secret, { operation: secret }, { operation: 'runtime.fetch', code: 'APP_RUNTIME_FETCH_TIMEOUT' }]) {
    assert.equal(runtimeFailureInfo({ sdk: value }).sdk, null);
  }
  const guarded = { operation: 'runtime.get', kind: 'host' };
  Object.defineProperty(guarded, 'code', { get() { assert.fail('must not execute sdk getters'); } });
  Object.defineProperty(guarded, 'details', { get() { assert.fail('must not inspect sdk details'); } });
  assert.equal(runtimeFailureInfo({ sdk: guarded }).sdk.code, null);
});

test('pure failure projection rejects unknown fields, getters, paths and unbounded nested input', () => {
  const secret = '/private/SECRET';
  const unsafe = { code: secret, phase: secret, requestId: secret, runtimeId: secret, operation: secret, startOutcome: secret,
    message: secret, stack: secret, details: secret, coreError: { message: secret }, coreResult: { proof: secret },
    cause: { code: secret, operation: secret, kind: secret, capability: secret }, cleanup: { confirmed: 'true', errors: Array(40).fill({ code: secret, phase: secret }) } };
  Object.defineProperty(unsafe, 'indeterminate', { get() { assert.fail('projection must not invoke getters'); } });
  unsafe.errors = Array(100).fill({ primary: unsafe });
  const dto = runtimeFailureInfo(unsafe); assert.equal(dto.code, null); assert.equal(dto.sdk, null); assert.equal(dto.runtimeId, null);
  assert.equal(dto.cleanup.confirmed, null); assert.equal(dto.cleanup.errors.length, 16); assert.equal(dto.requests.length, 32);
  assert.ok(dto.requests.every((entry) => !Object.hasOwn(entry.primary, 'requests'))); assert.ok(!JSON.stringify(dto).includes('SECRET'));
  assert.equal(runtimeFailureInfo(null).requestId, null);
  const valid = runtimeFailureInfo({ code: 'APP_HOST_ERROR', operation: 'runtime.list', kind: 'host', capability: 'app/runtime.execute' });
  assert.equal(valid.operation, null); assert.equal(valid.sdk.operation, 'runtime.list');
});
