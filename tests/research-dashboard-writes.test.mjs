// Exercise the real Research coordinator/dispatcher over an in-memory store,
// synthetic sessions/tasks and a gated Core. No disk, Python, model or Host work.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';

const serviceURL = new URL('../packages/hana-math/research-service.mjs', import.meta.url);
const storeKey = 'research-write-test-store';
const contextURL = new URL('./context-service.mjs', serviceURL);
const memoryAdapter = `export { contextId } from ${JSON.stringify(contextURL.href)};
export const createContextStore = () => globalThis[Symbol.for(${JSON.stringify(storeKey)})]();`;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === serviceURL.href && specifier === './context-service.mjs') return {
    url: `data:text/javascript,${encodeURIComponent(memoryAdapter)}`, shortCircuit: true,
  };
  return next(specifier, context);
} });
const { createResearchService } = await import(serviceURL).finally(() => hook.deregister());
const projectId = 'fixture-project', model = { provider: 'fixture', id: 'model' };
const origin = { callToken: 'fixture-token', sessionPath: '/fixture/origin' };
const error = code => Object.assign(new Error(code), { code });

async function fixture(t) {
  const dataDir = '/synthetic', files = new Map(), tasks = new Map(), schedules = new Map(), bindingsByPath = new Map();
  const sessionsByRun = new Map(), requests = [], handlers = new Map();
  let sequence = 0, holdIntent, service;
  const store = {
    mkdir: async () => {}, list: async () => [], absolute: file => `${dataDir}/${file}`,
    async read(file) { if (!files.has(file)) throw error('ENOENT'); return files.get(file); },
    async readJson(file) { return JSON.parse(await store.read(file)); },
    async write(file, value) {
      if (holdIntent && file.endsWith('/run.json') && JSON.parse(value).pendingMutations?.some(row => row.operation === 'gm_add')) {
        const gate = holdIntent; holdIntent = undefined; gate.entered.resolve(); await gate.release.promise;
      }
      files.set(file, value);
    },
  };
  const sdk = { dataDir, models: { async listAvailable() { return { models: [model] }; } }, tasks: {
    async registerHandler(key, handler) { handlers.set(key, handler); return () => handlers.delete(key); },
    async listSchedules() { return [...schedules.values()]; }, async list() { return [...tasks.values()]; },
    async create(input) {
      const root = input.scope === 'session', taskId = `task-${++sequence}`;
      const task = { ...input, taskId, pluginId: 'hana-math', status: 'pending', handlerKey: input.handlerKey ?? null,
        parentSessionId: root ? 'fixture-owner' : null, parentSessionPath: root ? origin.sessionPath : null };
      tasks.set(taskId, task); return task;
    },
    async schedule(input) { const schedule = { ...input, scheduleId: `schedule-${++sequence}`, pluginId: 'hana-math' }; schedules.set(schedule.scheduleId, schedule); return schedule; },
    async unschedule(id) { schedules.delete(id); return { ok: true }; }, async get(id) { return tasks.get(id); },
    async complete(id) { return Object.assign(tasks.get(id), { status: 'completed' }); },
    async fail(id) { return Object.assign(tasks.get(id), { status: 'failed' }); },
    async getDelivery() { return { state: 'delivered', delivered: true }; },
  } };
  const workspace = ({ projectId, role, workerId }) => {
    const cwd = store.absolute(`context/projects/${projectId}/workers/${workerId}`);
    return { state: 'ready', scope: 'logical-worker', projectId, role, workerId, verificationId: null, cwd, localMemory: `${cwd}/local_memory` };
  };
  function gate() { const value = Promise.withResolvers(); t.after(() => value.resolve()); return value; }
  const bindings = { register(row) { bindingsByPath.set(row.sessionPath, row); return row; },
    close(id) { bindingsByPath.delete(`/fixture/${id}`); }, closeRun() {},
    async authorize(_name, ctx) { return bindingsByPath.get(ctx.sessionPath); } };
  const dependencies = { contexts: { prepare() {}, prepareResearchWorkspace() {}, prepareProjectWorkspace: async input => workspace(input) },
    profiles: { async getRoleModel(role) { return { role, source: 'saved-role', agentId: `fixture-${role}`, model }; },
      async getRoleToolStatus(role) { return { role, agentId: `fixture-${role}`, resolvedMode: 'full', appEnabled: true, disabledTools: [] }; } },
    bindings, literature: { search() { assert.fail('no network'); } },
    createCore: () => ({ async call(binding, operation) {
      const reply = gate(); requests.push({ binding, operation, reply }); return reply.promise;
    }, async dispose() {} }),
    sessions: { start(input) {
      const sessionId = `session-${++sequence}`, sessionPath = `/fixture/${sessionId}`;
      const done = gate(), snapshot = { state: 'running', sessionId, modelTurn: 1 };
      const ready = (async () => {
        await input.onBound({ ...input, ...input.selection, sessionId, sessionPath });
        await input.onUpdate(snapshot);
        return { callToken: 'fixture-session-token', sessionPath };
      })();
      sessionsByRun.set(input.kind.split(':')[1], ready);
      return { done: done.promise, nextTurn: () => done.promise, snapshot: () => snapshot,
        resume() { assert.fail('never advances a synthetic model turn'); }, complete() { assert.fail('never completes a synthetic model turn'); },
        async stop() { const stopped = { ...snapshot, state: 'stopped', abortOutcome: 'aborted' }; done.resolve(stopped); return stopped; } };
    } },
  };
  const key = Symbol.for(storeKey);
  globalThis[key] = () => store;
  try { service = await createResearchService(sdk, dependencies); } finally { delete globalThis[key]; }
  t.after(() => service.dispose());
  async function until(read) {
    for (let attempt = 0; attempt < 100; attempt++) { const result = read(); if (result) return result; await tick(); }
    assert.fail('synthetic gate was not reached');
  }
  async function start(workerId) {
    const receipt = workspace({ projectId, role: 'worker', workerId }), base = `context/projects/${projectId}/workers/${workerId}`;
    files.set(`${base}/project-workspace.json`, JSON.stringify(receipt)); files.set(`${base}/TASK.md`, Buffer.from('Fixture only'));
    const run = await service.startWorkerRun({ projectId, workerId }, origin);
    const schedule = [...schedules.values()].find(row => row.payload.runId === run.runId);
    await handlers.get(schedule.handlerKey).run({ kind: 'schedule', scheduleId: schedule.scheduleId, input: schedule.payload });
    return { ...run, context: await until(() => sessionsByRun.get(run.runId)) };
  }
  return { service, start, gate, requests, until, holdIntent(value) { holdIntent = value; } };
}

test('project shared-write ledger fences durable intent and overlapping workers before any dashboard opens', async t => {
  const f = await fixture(t), a = await f.start('worker-a'), b = await f.start('worker-b');
  const state = (id = projectId) => f.service.projectDashboardWriteState(id);
  const clock = { now: 1760000000000 };
  t.mock.method(Date, 'now', () => clock.now);
  const intent = { entered: f.gate(), release: f.gate() };
  f.holdIntent(intent);
  const first = f.service.invoke('gm_add', { claim: 'fixture' }, a.context);
  await intent.entered.promise;
  const pending = state(); // The first observation is after dispatch admission, before any Core call.
  assert.equal(Object.isFrozen(pending), true);
  assert.deepEqual(pending, { pending: true, endedAt: 0 });
  assert.equal(f.requests.length, 0);
  intent.release.resolve();
  await f.until(() => f.requests[0]);
  const second = f.service.invoke('gm_add', { claim: 'sibling' }, b.context);
  await f.until(() => f.requests[1]);
  assert.deepEqual(state('other-project'), { pending: false, endedAt: 0 });
  // Reverse issue order. The failed sibling still advances the last completion
  // time, since a confirmed failure may have written a verification trace.
  clock.now += 10;
  f.requests[1].reply.resolve({ added: true }); await second;
  assert.deepEqual(state(), { pending: true, endedAt: clock.now });
  clock.now += 10;
  f.requests[0].reply.reject(Object.assign(error('FIXTURE_FAILED'), { indeterminate: false }));
  await assert.rejects(first, { code: 'FIXTURE_FAILED' });
  const sealed = state();
  assert.deepEqual(sealed, { pending: false, endedAt: clock.now });
  assert.deepEqual(pending, { pending: true, endedAt: 0 });

  const privateWrite = f.service.invoke('math_local_memory', { action: 'append', text: 'fixture' }, b.context);
  await f.until(() => f.requests[2]);
  assert.equal(f.requests[2].operation, 'local_memory_append');
  assert.deepEqual(state(), sealed);
  clock.now += 10;
  f.requests[2].reply.resolve({ appended: true }); await privateWrite;
  assert.deepEqual(state(), sealed);

  const unknown = f.service.invoke('gm_add', { claim: 'unconfirmed' }, b.context);
  await f.until(() => f.requests[3]);
  f.requests[3].reply.reject(error('UNKNOWN_WRITE'));
  await assert.rejects(unknown, { code: 'UNKNOWN_WRITE', indeterminate: true });
  assert.equal(state(), null);
  assert.deepEqual(state('other-project'), { pending: false, endedAt: 0 });
  await f.service.dispose();
  assert.equal(state('other-project'), null);
});
