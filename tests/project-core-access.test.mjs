import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppSdk } from '../packages/hana-math/sdk/index.js';
import { createResearchRuntime, runtimeFailureInfo } from '../packages/hana-math/runtime/research-runtime.mjs';
import * as coreAccess from '../packages/hana-math/project-core-access.mjs';
const { createProjectCoreAccess } = coreAccess;
const ipcReason = error => coreAccess.projectCoreManagedIpcRefusal?.(error) ?? null;

const clone = (v) => JSON.parse(JSON.stringify(v));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise((resolve) => setImmediate(resolve));
const runtimeReceipt = () => ({ runtimeId: 'opaque-runtime', runtime: 'command', profile: 'scoped', network: 'none', state: 'exited', exitCode: 0, enforcement: 'full', backend: 'seatbelt' });
const failure = (code, extra = {}) => Object.assign(new Error('opaque fixture detail /not-for-public-report'), { code, ...extra });
async function rejected(promise, code) {
  const error = await promise.then(() => assert.fail('expected rejection'), (e) => e);
  assert.equal(error.code, code); assert.ok(error.state); assert.deepEqual(clone(error.state), error.state); return error;
}
async function fixture(t, hooks = {}, realCore = false) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-core-fixture-')));
  const dataDir = path.join(base, 'data'), packageRoot = path.join(base, 'package'), projectId = hooks.projectId || 'project-a';
  await fs.mkdir(dataDir);
  const tasks = new Map(), events = [], states = [], calls = [], disposals = new Set(); let sequence = 0;
  const createEntered = deferred(), coreEntered = deferred(), disposeEntered = deferred(), completeEntered = deferred(), factoryEntered = deferred(), settled = deferred();
  const host = {
    dataDir, models: {}, tools: {}, hooks: {}, storage: { global: {}, agent: () => ({}) }, media: {}, providers: {},
    bus: { async request() { assert.fail('No ambient session/model bus calls'); } },
    tasks: {
      async create(input) {
        events.push('create'); assert.equal(input.scope, 'app'); assert.equal(input.delivery, 'none');
        assert.deepEqual(Object.keys(input).sort(), ['delivery', 'externalId', 'label', 'metadata', 'scope']);
        assert.equal(states.at(-1).phase, 'creating'); assert.equal(states.at(-1).pending, true);
        const record = { taskId: `app:hana-math:fixture-${++sequence}`, type: 'app', pluginId: 'hana-math', scope: 'app', delivery: 'none',
          parentSessionId: null, parentSessionPath: null, status: 'pending', metadata: clone(input.metadata), createdAt: 0, updatedAt: 0 };
        tasks.set(record.taskId, record); createEntered.resolve();
        if (hooks.createGate) await hooks.createGate.promise;
        if (hooks.createError) throw hooks.createError;
        return hooks.createReceipt ? hooks.createReceipt(clone(record)) : clone(record);
      },
      async get(id) { events.push('get'); return hooks.getReceipt ? hooks.getReceipt(clone(tasks.get(id))) : clone(tasks.get(id)); },
      async complete(id, result) {
        events.push('complete'); assert.ok(disposals.has(id), 'Core dispose must precede complete');
        if (hooks.completeError) throw hooks.completeError;
        const record = tasks.get(id); assert.ok(['pending', 'running'].includes(record.status));
        record.status = 'completed'; record.result = clone(result);
        completeEntered.resolve(); if (hooks.completeGate) await hooks.completeGate.promise;
        settled.resolve(); return hooks.completeReceipt ? hooks.completeReceipt(clone(record)) : clone(record);
      },
      async fail(id, error) {
        events.push('fail');
        if (hooks.failError) throw hooks.failError;
        if (calls.some((call) => call.taskId === id)) assert.ok(disposals.has(id), 'Core dispose must precede fail');
        const record = tasks.get(id); assert.ok(['pending', 'running'].includes(record.status));
        record.status = 'failed'; record.error = clone(error); settled.resolve(); return clone(record);
      },
    },
    runtime: {
      async start(input) {
        events.push('runtime.start');
        const scope = tasks.get(input.taskId);
        if (!scope || !['pending', 'running'].includes(scope.status)) throw failure('APP_TASK_SCOPE_INVALID');
        assert.equal(scope.scope, 'app'); assert.equal(scope.delivery, 'none'); assert.equal(scope.parentSessionId, null);
        assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none'); assert.equal(Object.hasOwn(input, 'callToken'), false);
        const request = JSON.parse(await fs.readFile(input.args.at(-2), 'utf8'));
        calls.push({ taskId: input.taskId, binding: request.context, operation: request.operation, args: request.arguments });
        const result = { fact_id: '0123456789abcdef', markdown: 'opaque stored document', predecessors: [] };
        await fs.writeFile(input.args.at(-1), JSON.stringify({ schemaVersion: 1, requestId: request.requestId, ok: true, result }), { mode: 0o600 });
        return runtimeReceipt();
      },
      async get() { return runtimeReceipt(); },
      async stop() { return runtimeReceipt(); },
      async watch() { assert.fail('Already terminal fixture needs no watch'); },
    },
  };
  if (realCore) {
    const executable = path.join(packageRoot, 'dependencies', 'python', 'bin', 'python3');
    await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'opaque non-executable fixture', { mode: 0o700 });
    await fs.writeFile(path.join(packageRoot, 'dependencies', 'runtime.json'), JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' }));
    await fs.mkdir(path.join(packageRoot, 'runtime'));
    await fs.writeFile(path.join(packageRoot, 'runtime', 'research_entry.py'), '# opaque fixture; never executed\n');
    await fs.mkdir(path.join(packageRoot, 'engine', 'src', 'hana_math_engine'), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'engine', 'src', 'hana_math_engine', 'research.py'), '# opaque fixture\n');
  }
  const sdk = createAppSdk(host);
  const options = { projectId, author: 'main-agent',
    async onState(packet) {
      assert.equal(packet.projectId, projectId); assert.equal(packet.author, 'main-agent');
      states.push(clone(packet)); events.push(`state:${packet.phase}`);
      if (hooks.onState) return hooks.onState(packet);
    },
    createCore(input) {
      events.push('factory'); assert.deepEqual(Object.keys(input), ['taskId']);
      const task = tasks.get(input.taskId); assert.ok(['pending', 'running'].includes(task.status));
      assert.equal(states.at(-1).phase, 'core-pending'); assert.equal(states.at(-1).taskId, input.taskId);
      if (hooks.factoryError) throw hooks.factoryError;
      const core = realCore ? createResearchRuntime(sdk, { ...input, packageRoot, platform: 'darwin', arch: 'arm64', timeoutMs: 1000, cleanupTimeoutMs: 100 }) : {
        async call(binding, operation, args, verification, control) {
          events.push('call'); assert.equal(verification, undefined); assert.ok(control.signal instanceof AbortSignal);
          assert.equal(states.at(-1).phase, 'calling'); assert.ok(['pending', 'running'].includes(task.status));
          calls.push({ taskId: input.taskId, binding: clone(binding), operation, args: clone(args) }); coreEntered.resolve();
          if (hooks.callGate) await hooks.callGate.promise;
          if (hooks.coreError) throw hooks.coreError;
          return hooks.coreResult ? hooks.coreResult(operation, args) : { opaque: operation };
        },
        async dispose() {
          disposeEntered.resolve(); if (hooks.disposeGate) await hooks.disposeGate.promise;
          if (hooks.disposeError) throw hooks.disposeError;
          return hooks.disposeReceipt;
        },
      };
      const wrapper = { call: (...args) => core.call(...args), async dispose() {
        events.push('dispose'); const result = await core.dispose();
        if (!hooks.disposeReceipt) disposals.add(input.taskId);
        return result;
      } };
      factoryEntered.resolve();
      if (hooks.directIpc) { assert.equal(realCore, true); return core; }
      return hooks.factoryGate ? hooks.factoryGate.promise.then(() => wrapper) : wrapper;
    },
  };
  const access = createProjectCoreAccess(sdk, options);
  t.after(async () => {
    try { await access.dispose(); assert.ok(!hooks.expectUnsettled, 'expected unresolved resource state'); }
    catch (error) { if (!hooks.expectUnsettled) throw error; assert.equal(error.code, 'PROJECT_CORE_CLEANUP_FAILED'); assert.equal(error.state.pending, true); }
    finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  return { access, sdk, dataDir, options, hooks, events, states, tasks, calls, createEntered, coreEntered, disposeEntered, completeEntered, factoryEntered, settled };
}

test('real bridge uses active App task authority; dispose precedes complete; export remains a read', async (t) => {
  const f = await fixture(t, {}, true);
  assert.deepEqual(await f.access.call('fact_get', { fact_id: '0123456789abcdef' }), { fact_id: '0123456789abcdef', markdown: 'opaque stored document', predecessors: [] });
  assert.deepEqual(f.calls[0].binding, { projectId: 'project-a', runId: f.states[0].operationId, role: 'main', author: 'main-agent' });
  assert.match(f.calls[0].binding.runId, /^control-[a-f0-9-]{36}$/);
  assert.ok(f.events.indexOf('runtime.start') < f.events.indexOf('dispose'));
  assert.ok(f.events.indexOf('dispose') < f.events.indexOf('complete'));
  const resource = [...f.tasks.values()][0]; assert.equal(resource.result.coreOutcome, 'succeeded');
  assert.equal(Object.hasOwn(resource.result, 'accepted'), false); assert.equal(Object.hasOwn(resource.result, 'markdown'), false);
  assert.equal(f.access.snapshot().pending, false); assert.equal(f.access.snapshot().busy, false);
});

test('only managed dashboard view requests may carry an exact terminal witness', async t => {
  const inventoryRevision = 'b'.repeat(64), projectId = 'project-a';
  const graph = { nodes: [], edges: [], max_depth: 0 };
  const data = { kind: 'plan', count: 0, entries: [] };
  const outputs = { dashboard_factgraph: { projectId, asOf: 'a'.repeat(64), graph }, dashboard_memory: { projectId, data } };
  let adjust = value => value;
  const f = await fixture(t, { coreResult: (op, args) => adjust({ ...outputs[op], ...(args.terminal ? { inventoryRevision } : {}) }) });
  const guard = () => {};
  for (const [op, args, method] of [['dashboard_factgraph', {}, 'dashboardFactgraph'],
    ['dashboard_memory', { view: 'channel', kind: 'plan' }, 'dashboardMemory']]) {
    const terminal = { ...args, terminal: true };
    const before = f.calls.length;
    await rejected(f.access[method](terminal), 'PROJECT_CORE_INVALID_INPUT');
    await rejected(f.access.call(op, terminal), 'PROJECT_CORE_FORBIDDEN_OPERATION');
    for (const wrong of [false, null, 1, 'true', undefined])
      await rejected(f.access.dashboardViewRead(op, { ...args, terminal: wrong }, guard), 'PROJECT_CORE_INVALID_INPUT');
    await rejected(f.access.dashboardViewRead(op, { ...terminal, projectId }, guard), 'PROJECT_CORE_INVALID_INPUT');
    assert.equal(f.calls.length, before);
    assert.deepEqual(await f.access.dashboardViewRead(op, args, guard), outputs[op]);
    assert.deepEqual(await f.access.dashboardViewRead(op, terminal, guard), { ...outputs[op], inventoryRevision });
    assert.deepEqual(f.calls.at(-1).args, terminal);
    assert.deepEqual(f.states.at(-1).outcome, { state: 'succeeded' });
    assert.doesNotMatch(JSON.stringify(f.states), new RegExp(inventoryRevision));
    for (const invalid of [undefined, null, 'b'.repeat(63), 'B'.repeat(64), `${inventoryRevision}\n`]) {
      adjust = value => ({ ...value, inventoryRevision: invalid });
      await rejected(f.access.dashboardViewRead(op, terminal, guard), 'PROJECT_CORE_INVALID_RESULT');
    }
    adjust = ({ inventoryRevision: _revision, ...value }) => value;
    await rejected(f.access.dashboardViewRead(op, terminal, guard), 'PROJECT_CORE_INVALID_RESULT');
    adjust = value => ({ ...value, inventoryRevision });
    await rejected(f.access.dashboardViewRead(op, args, guard), 'PROJECT_CORE_INVALID_RESULT');
    await rejected(f.access[method](args), 'PROJECT_CORE_INVALID_RESULT');
    adjust = value => value;
  }
});

const capacityCode = 'RESEARCH_RUNTIME_CAPACITY';
async function malformedIpcMarker(f) {
  const dir = path.join(f.dataDir, 'research', 'core-calls', 'history');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, '.complete'), 'not-empty', { mode: 0o600 });
  return dir;
}

test('selected current managed IPC failure alone brands the new Core wrapper without changing public DTOs', async t => {
  const hooks = { directIpc: true, failError: failure('APP_HOST_ERROR') };
  const f = await fixture(t, hooks, true); await malformedIpcMarker(f);
  const result = await rejected(f.access.call('fact_list'), capacityCode);
  assert.equal(result.state.current.outcome.failure.code, capacityCode); assert.equal(result.state.current.error.code, capacityCode);
  assert.equal(result.state.current.settlement.confirmed, false); assert.ok(result.state.current.settlement.failure);
  assert.equal(result.state.current.cleanup.confirmed, true); assert.equal(f.events.includes('runtime.start'), false);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'runtime', 'state']);
  assert.deepEqual(result.runtime, runtimeFailureInfo(result.cause));
  assert.doesNotMatch(JSON.stringify([result.runtime, result.state, f.states]), /invalid-completion-marker|history|not-empty/);
  for (const fake of [result.cause, result.runtime, { runtime: result.runtime }, { runtime: result }, { cause: result }, Object.assign(new Error(), result), clone(result)])
    assert.equal(ipcReason(fake), null);
  const copy = await fixture(t, { coreError: Object.assign(failure(capacityCode), { runtime: result.runtime }) });
  assert.equal(ipcReason(await rejected(copy.access.call('fact_list'), capacityCode)), null);
  const replay = await fixture(t, { coreError: result });
  assert.equal(ipcReason(await rejected(replay.access.call('fact_list'), capacityCode)), null);
  replay.hooks.coreError = result.cause;
  const replayedRaw = await rejected(replay.access.call('fact_list'), capacityCode);
  assert.equal(replayedRaw.runtime.requestId, result.runtime.requestId, 'Even identical raw summary fields cannot renew the proof');
  assert.equal(ipcReason(replayedRaw), null);
  hooks.failError = null; await f.access.dispose();
  assert.equal(ipcReason(result), 'invalid-completion-marker');
});

test('late genuine IPC refusal cannot replace the selected primary disposal error', async t => {
  const f = await fixture(t, { directIpc: true }, true), dir = await malformedIpcMarker(f);
  const entered = deferred(), release = deferred(), readdir = fs.readdir;
  t.mock.method(fs, 'readdir', async (p, ...args) => {
    if (p === dir) { entered.resolve(); await release.promise; }
    return readdir(p, ...args);
  });
  const pending = rejected(f.access.call('fact_list'), 'PROJECT_CORE_DISPOSED');
  await Promise.race([entered.promise, pending.then(() => assert.fail('Call settled before scan barrier'))]);
  const disposing = f.access.dispose(); await turn(); release.resolve();
  const error = await pending; await disposing;
  assert.equal(error.state.current.outcome.failure.code, capacityCode, 'Real capacity refusal reached the late outcome');
  assert.equal(error.state.current.error.code, 'PROJECT_CORE_DISPOSED');
  assert.equal(error.runtime.code, null); assert.equal(ipcReason(error), null);
  assert.equal(f.events.includes('runtime.start'), false);
});

test('all seven internal main operations get distinct fresh control scopes and fixed immutable identity', async (t) => {
  const f = await fixture(t);
  f.options.projectId = 'other'; f.options.author = 'other';
  for (const [operation, args] of [['gm_add', { kind: 'master_guidance', claim: 'opaque' }], ['gm_search', { query: 'opaque' }], ['fact_search', { query: 'opaque' }],
    ['fact_revoke', { fact_id: '0123456789abcdef', reason: 'opaque' }], ['fact_list', {}], ['fact_list_page', { limit: 1 }], ['fact_get', { fact_id: '0123456789abcdef' }]]) await f.access.call(operation, args);
  assert.equal(new Set(f.calls.map((call) => call.binding.runId)).size, 7); assert.equal(f.tasks.size, 7);
  for (const call of f.calls) { assert.equal(call.binding.role, 'main'); assert.equal(call.binding.projectId, 'project-a'); assert.equal(call.binding.author, 'main-agent'); assert.equal(Object.hasOwn(call.binding, 'workerId'), false); }
  assert.equal(f.events.filter((event) => event === 'complete').length, 7);
});

test('forbidden operations, identity/path selectors and exotic JSON are rejected before task creation', async (t) => {
  const f = await fixture(t);
  for (const operation of ['fact_submit', 'prepare_submission', 'local_memory_read', 'local_memory_append', 'constructor', '__proto__']) await rejected(f.access.call(operation, {}), 'PROJECT_CORE_FORBIDDEN_OPERATION');
  for (const args of [{ context: { role: 'worker' } }, { workerId: 'worker-a' }, { projectId: 'other' }, { runId: 'existing' }, { taskId: 'old' }, { path: '/outside' }]) for (const operation of ['fact_list', 'fact_list_page']) await rejected(f.access.call(operation, args), 'PROJECT_CORE_INVALID_INPUT');
  let evaluated = false;
  await rejected(f.access.call('gm_search', { get query() { evaluated = true; return 'opaque'; } }), 'PROJECT_CORE_INVALID_INPUT');
  await rejected(f.access.call('gm_search', new Proxy({}, { ownKeys() { evaluated = true; return []; } })), 'PROJECT_CORE_INVALID_INPUT');
  await rejected(f.access.call('gm_search', { query: 'x'.repeat((1 << 20) + 1) }), 'PROJECT_CORE_INVALID_INPUT');
  await rejected(f.access.call('fact_list', {}, { role: 'worker' }), 'PROJECT_CORE_INVALID_INPUT');
  class Exotic extends Array { toJSON() { evaluated = true; return []; } }
  await rejected(f.access.call('gm_search', { query: 'opaque', kinds: new Exotic() }), 'PROJECT_CORE_INVALID_INPUT');
  assert.equal(evaluated, false); assert.equal(f.tasks.size, 0);
  await f.access.call('fact_list', {});
});

test('constructor validates project/author and requires real task and persistence APIs', () => {
  for (const [projectId, author] of [['../outside', 'main'], ['Project', 'main'], ['ok', '../main'], ['ok', 'x'.repeat(129)], ['x'.repeat(65), 'main']]) {
    assert.throws(() => createProjectCoreAccess({}, { projectId, author, createCore() {}, onState() {} }), { code: 'PROJECT_CORE_INVALID_BINDING' });
  }
  assert.throws(() => createProjectCoreAccess({}, { projectId: 'ok', author: 'main', createCore() {}, onState() {} }), { code: 'PROJECT_CORE_INVALID_BINDING' });
});

test('known Core rejection survives diagnostics and successful cleanup releases busy state', async (t) => {
  const coreError = failure('RESEARCH_RUNTIME_REJECTED', { phase: 'core-envelope', indeterminate: false, startOutcome: 'acknowledged', processTerminalConfirmed: true,
    runtimeState: 'exited', exitCode: 0, enforcement: 'full', backend: 'seatbelt', cleanup: { confirmed: true } });
  const f = await fixture(t, { coreError });
  const error = await rejected(f.access.call('gm_add', { kind: 'invalid', claim: 'opaque' }), 'RESEARCH_RUNTIME_REJECTED');
  assert.equal(error.state.current.outcome.failure.runtime.indeterminate, false);
  assert.equal(error.state.current.outcome.failure.runtime.runtimeState, 'exited');
  assert.equal(error.state.current.outcome.failure.runtime.exitCode, 0);
  assert.equal(JSON.stringify(error.state).includes('/not-for-public-report'), false);
  assert.equal(error.state.pending, false); assert.equal(error.state.busy, false); assert.equal(f.events.at(-2), 'fail');
  f.hooks.coreError = null; await f.access.call('fact_list', {}); assert.equal(f.calls.length, 2);
});

test('confirmed resource cleanup and task settlement never erase mutation indeterminacy', async (t) => {
  const coreError = failure('RESEARCH_RUNTIME_REJECTED', { phase: 'result', indeterminate: true,
    startOutcome: 'acknowledged', processTerminalConfirmed: true, runtimeState: 'exited', exitCode: 0,
    enforcement: 'full', backend: 'seatbelt', cleanup: { confirmed: true } });
  const records = new Map();
  const f = await fixture(t, { coreError, onState(record) { records.set(record.operationId, clone(record)); } });
  const error = await rejected(f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }), 'RESEARCH_RUNTIME_REJECTED');
  const operationId = error.state.current.operationId;
  assert.equal(error.state.pending, false);
  assert.equal(error.state.current.outcome.failure.runtime.indeterminate, true);
  assert.equal(f.calls[0].binding.role, 'main');
  const disposed = await f.access.dispose(); await turn();
  const snapshot = f.access.snapshot(), saved = records.get(operationId);
  assert.equal(disposed.disposed, true); assert.equal(disposed.pending, false);
  assert.equal(snapshot.pending, false); assert.equal(snapshot.busy, false);
  assert.equal(records.size, 1); assert.ok(saved); assert.notStrictEqual(saved, snapshot.current);
  for (const record of [error.state.current, disposed.current, snapshot.current, saved]) {
    assert.equal(record.operationId, operationId); assert.equal(record.pending, false); assert.equal(record.phase, 'finished');
    assert.equal(record.cleanup.confirmed, true); assert.equal(record.settlement.confirmed, true);
    assert.equal(record.outcome.state, 'failed'); assert.equal(Object.hasOwn(record.outcome, 'result'), false);
    assert.equal(record.outcome.failure.runtime.indeterminate, true);
    assert.equal(record.outcome.failure.runtime.processTerminalConfirmed, true);
    assert.equal(record.outcome.failure.runtime.cleanup.confirmed, true);
  }
  assert.equal([...f.tasks.values()][0].status, 'failed');
  assert.equal(f.events.filter((event) => event === 'fail').length, 1);
  assert.equal(f.events.includes('complete'), false);
  assert.equal(f.events.filter((event) => event === 'dispose').length, 1);
  assert.equal(f.tasks.size, 1); assert.equal(f.calls.length, 1); // No mutation replay during disposal/settlement.
});

test('create error without authoritative receipt remains unresolved; no Core or false task completion', async (t) => {
  const f = await fixture(t, { createError: failure('APP_HOST_ERROR'), expectUnsettled: true });
  const error = await rejected(f.access.call('fact_list', {}), 'APP_HOST_ERROR');
  assert.equal(error.state.current.taskCreation, 'unconfirmed'); assert.equal(error.state.current.outcome.state, 'not-started');
  assert.equal(error.state.pending, true); assert.equal(f.events.includes('factory'), false); assert.equal(f.events.includes('complete'), false);
  await rejected(f.access.call('fact_list', {}), 'PROJECT_CORE_BUSY');
});

test('unknown runtime and unconfirmed cleanup preserve known failure and leave authority task unsettled', async (t) => {
  const error = failure('RESEARCH_RUNTIME_TIMEOUT', { phase: 'runtime-start', startOutcome: 'unknown', indeterminate: true, cleanup: { confirmed: false } });
  const f = await fixture(t, { coreError: error, disposeError: failure('RESEARCH_RUNTIME_CLEANUP_FAILED'), expectUnsettled: true });
  const rejectedCall = await rejected(f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }), 'RESEARCH_RUNTIME_TIMEOUT');
  assert.equal(rejectedCall.state.current.outcome.failure.runtime.startOutcome, 'unknown'); assert.equal(rejectedCall.state.pending, true);
  assert.equal([...f.tasks.values()][0].status, 'pending'); assert.equal(f.calls.length, 1);
  assert.equal(f.events.includes('complete'), false); assert.equal(f.events.includes('fail'), false);
});

test('known successful result is retained when cleanup is rejected or explicitly unconfirmed', async (t) => {
  for (const hooks of [{ disposeError: failure('RESEARCH_RUNTIME_CLEANUP_FAILED') }, { disposeReceipt: { cleanupPending: true } }]) await t.test('cleanup receipt', async (t) => {
    const f = await fixture(t, hooks);
    const error = await f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }).catch((e) => e);
    assert.ok(error instanceof Error); assert.equal(error.state.pending, true);
    assert.deepEqual(error.state.current.outcome.result, { opaque: 'gm_add' }); assert.equal(error.state.current.outcome.state, 'succeeded');
    assert.equal(f.events.includes('complete'), false);
    hooks.disposeError = null; hooks.disposeReceipt = undefined;
    const state = await f.access.dispose(); assert.equal(state.pending, false); assert.equal(f.calls.length, 1);
    assert.deepEqual(state.current.outcome.result, { opaque: 'gm_add' }); assert.equal([...f.tasks.values()][0].status, 'completed');
  });
});

test('settlement rejection does not erase result; dispose reconciles only owned resource, never mutation', async (t) => {
  const f = await fixture(t, { completeError: failure('APP_HOST_ERROR') });
  const error = await rejected(f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }), 'APP_HOST_ERROR');
  assert.equal(error.state.current.cleanup.confirmed, true); assert.equal(error.state.current.settlement.confirmed, false); assert.equal(error.state.pending, true);
  assert.equal(error.state.current.outcome.state, 'succeeded'); assert.equal([...f.tasks.values()][0].status, 'pending');
  f.hooks.completeError = null; const state = await f.access.dispose(); assert.equal(state.pending, false); assert.equal(f.calls.length, 1);
});

test('wrong terminal acknowledgement is not success; authoritative get can confirm already completed task without replay', async (t) => {
  const f = await fixture(t, { completeReceipt: (record) => ({ ...record, status: 'running' }) });
  const error = await rejected(f.access.call('fact_list', {}), 'PROJECT_CORE_SETTLEMENT_FAILED');
  assert.equal(error.state.pending, true); assert.equal(f.calls.length, 1);
  await f.access.dispose(); assert.equal(f.events.filter((event) => event === 'complete').length, 1); assert.equal(f.calls.length, 1);
});

test('foreign task receipt is never used as authority or settled', async (t) => {
  const f = await fixture(t, { createReceipt: (record) => ({ ...record, metadata: { controlId: 'another-operation' } }), expectUnsettled: true });
  await rejected(f.access.call('fact_list', {}), 'PROJECT_CORE_TASK_RECEIPT_INVALID');
  assert.equal(f.events.includes('factory'), false); assert.equal(f.events.includes('fail'), false);
});

test('terminal task cannot authorize new Core work', async (t) => {
  const f = await fixture(t, { createReceipt: (record) => { record.status = 'failed'; return record; }, getReceipt: (record) => ({ ...record, status: 'failed' }) });
  await rejected(f.access.call('fact_list', {}), 'PROJECT_CORE_TASK_INACTIVE');
  assert.equal(f.events.includes('factory'), false); assert.equal(f.events.includes('complete'), false); assert.equal(f.access.snapshot().pending, false);
});

test('negative persistence receipts remain unconfirmed and prevent task/Core creation', async (t) => {
  for (const [name, onState] of [
    ['error object', () => ({ error: { code: 'WRITE_FAILED' } })],
    ['false', () => false],
    ['ok false', () => ({ ok: false })],
    ['throw', () => { throw failure('EIO'); }],
  ]) await t.test(name, async (t) => {
    const f = await fixture(t, { onState, expectUnsettled: true });
    const error = await rejected(f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }), 'PROJECT_CORE_PERSISTENCE_FAILED');
    assert.equal(error.state.pending, true);
    assert.ok(error.state.persistenceError);
    assert.equal(error.state.current.taskCreation, 'not-attempted');
    assert.equal(error.state.current.outcome.state, 'not-started');
    assert.equal(f.access.snapshot().pending, true);
    assert.equal(f.tasks.size, 0); assert.equal(f.calls.length, 0);
    assert.equal(f.events.includes('create'), false); assert.equal(f.events.includes('factory'), false);
  });
});

test('undefined persistence receipt still authorizes a normally confirmed operation', async (t) => {
  const f = await fixture(t, { onState: () => undefined });
  await f.access.call('fact_list', {});
  assert.equal(f.tasks.size, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.access.snapshot().pending, false); assert.equal(f.access.snapshot().persistenceError, null);
});

test('persistence rejection before creation prevents all external work and does not permanently lock instance', async (t) => {
  let once = true;
  const f = await fixture(t, { onState() { if (once) { once = false; throw failure('EIO'); } } });
  await rejected(f.access.call('fact_list', {}), 'PROJECT_CORE_PERSISTENCE_FAILED');
  assert.equal(f.tasks.size, 0); assert.equal(f.access.snapshot().pending, false); await f.access.call('fact_list', {});
});

test('persistence failure after task receipt prevents Core execution but releases the owned task', async (t) => {
  let once = true;
  const f = await fixture(t, { onState(packet) { if (packet.taskId && packet.phase === 'creating' && once) { once = false; throw failure('EIO'); } } });
  await rejected(f.access.call('fact_list', {}), 'PROJECT_CORE_PERSISTENCE_FAILED');
  assert.equal(f.events.includes('factory'), false); assert.equal([...f.tasks.values()][0].status, 'failed'); assert.equal(f.access.snapshot().pending, false);
});

test('concurrent operations are busy, never queued; input is copied before awaiting persistence', async (t) => {
  const gate = deferred(); const f = await fixture(t, { callGate: gate });
  const args = { kind: 'master_guidance', claim: 'opaque original' };
  const call = f.access.call('gm_add', args); args.claim = 'mutated caller input'; await f.coreEntered.promise;
  await rejected(f.access.call('fact_revoke', { fact_id: '0123456789abcdef', reason: 'opaque' }), 'PROJECT_CORE_BUSY');
  gate.resolve(); await call; await turn();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.claim, 'opaque original'); assert.equal(f.tasks.size, 1);
});

test('dispose interrupts an in-flight operation and waits for owned Core, retaining a late known result', async (t) => {
  const gate = deferred(); const f = await fixture(t, { callGate: gate });
  const call = f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }).catch((e) => e); await f.coreEntered.promise;
  const disposal = f.access.dispose(); gate.resolve();
  const state = await disposal, error = await call;
  assert.equal(error.code, 'PROJECT_CORE_DISPOSED'); assert.equal(state.pending, false); assert.equal(state.current.outcome.state, 'succeeded');
  assert.equal(f.calls.length, 1); await rejected(f.access.call('fact_list', {}), 'PROJECT_CORE_DISPOSED');
});

test('create timeout retains unknown ownership; a late receipt is released without ever executing Core', async (t) => {
  const gate = deferred(); const f = await fixture(t, { createGate: gate });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const call = f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }).catch((e) => e); await f.createEntered.promise;
  t.mock.timers.tick(5000); await turn(); t.mock.timers.tick(5000); await turn();
  const error = await call; assert.equal(error.code, 'PROJECT_CORE_TIMEOUT'); assert.equal(error.state.pending, true);
  assert.equal(f.events.includes('complete'), false); assert.equal(f.calls.length, 0);
  gate.resolve(); await f.settled.promise; await turn();
  assert.equal([...f.tasks.values()][0].status, 'failed'); assert.equal(f.calls.length, 0); assert.equal(f.events.includes('factory'), false);
  t.mock.timers.reset(); await f.access.dispose();
});

test('timed-out persistence cannot later dispatch a mutation', async (t) => {
  const gate = deferred(), entered = deferred(); let first = true;
  const f = await fixture(t, { onState() { if (first) { first = false; entered.resolve(); return gate.promise; } } });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const call = f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }).catch((e) => e); await entered.promise;
  t.mock.timers.tick(5000); await turn(); t.mock.timers.tick(5000); await turn();
  const error = await call; assert.equal(error.code, 'PROJECT_CORE_TIMEOUT'); assert.equal(error.state.pending, true);
  gate.resolve(); await turn(); t.mock.timers.reset(); await f.access.dispose(); assert.equal(f.tasks.size, 0); assert.equal(f.calls.length, 0);
});

test('late factory receipt is disposed without dispatching a timed-out mutation', async (t) => {
  const gate = deferred(); const f = await fixture(t, { factoryGate: gate });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const call = f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }).catch((e) => e); await f.factoryEntered.promise;
  t.mock.timers.tick(5000); await turn(); t.mock.timers.tick(5000); await turn();
  const error = await call; assert.equal(error.code, 'PROJECT_CORE_TIMEOUT'); assert.equal(error.state.pending, true);
  gate.resolve(); await f.settled.promise; await turn();
  assert.equal(f.calls.length, 0); assert.equal([...f.tasks.values()][0].status, 'failed');
  t.mock.timers.reset(); await f.access.dispose();
});

test('late Core disposal acknowledgement preserves result and settles exactly once', async (t) => {
  const gate = deferred(); const f = await fixture(t, { disposeGate: gate });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const call = f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }).catch((e) => e); await f.disposeEntered.promise;
  t.mock.timers.tick(5000); await turn();
  const error = await call; assert.equal(error.code, 'PROJECT_CORE_TIMEOUT'); assert.equal(error.state.pending, true);
  assert.equal(error.state.current.outcome.state, 'succeeded'); assert.equal(f.events.includes('complete'), false);
  gate.resolve(); await f.settled.promise; await turn();
  assert.equal(f.calls.length, 1); assert.equal(f.events.filter((event) => event === 'dispose').length, 1);
  assert.equal(f.events.filter((event) => event === 'complete').length, 1);
  t.mock.timers.reset(); await f.access.dispose();
});

test('late settlement receipt is retained; no second completion or mutation is sent', async (t) => {
  const gate = deferred(); const f = await fixture(t, { completeGate: gate });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const call = f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }).catch((e) => e); await f.completeEntered.promise;
  t.mock.timers.tick(5000); await turn();
  const error = await call; assert.equal(error.code, 'PROJECT_CORE_TIMEOUT'); assert.equal(error.state.current.settlement.confirmed, false);
  assert.equal(error.state.current.outcome.state, 'succeeded'); gate.resolve(); await f.settled.promise; await turn();
  t.mock.timers.reset(); const state = await f.access.dispose(); assert.equal(state.pending, false); assert.equal(state.current.settlement.confirmed, true);
  assert.equal(f.calls.length, 1); assert.equal(f.events.filter((event) => event === 'complete').length, 1);
});

test('dispose cannot settle a still unresolved Core call even when its disposal method returns', async (t) => {
  const gate = deferred(); const f = await fixture(t, { callGate: gate });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const call = f.access.call('gm_add', { kind: 'master_guidance', claim: 'opaque' }).catch((e) => e); await f.coreEntered.promise;
  const disposal = f.access.dispose().catch((e) => e); await f.disposeEntered.promise; await turn();
  t.mock.timers.tick(5000); await turn();
  const error = await disposal; assert.equal(error.code, 'PROJECT_CORE_CLEANUP_FAILED'); assert.equal(error.state.pending, true);
  assert.equal(f.events.includes('complete'), false); assert.equal((await call).code, 'PROJECT_CORE_DISPOSED');
  gate.resolve(); await f.settled.promise; await turn(); t.mock.timers.reset(); await f.access.dispose(); assert.equal(f.calls.length, 1);
});

test('another project access instance is not blocked by an unresolved resource', async (t) => {
  const a = await fixture(t, { createError: failure('APP_HOST_ERROR'), expectUnsettled: true });
  const b = await fixture(t, { projectId: 'project-b' }); await rejected(a.access.call('fact_list', {}), 'APP_HOST_ERROR');
  await b.access.call('fact_list', {}); assert.equal(b.access.snapshot().pending, false); assert.equal(a.access.snapshot().pending, true);
});
