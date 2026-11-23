import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { createContextService } from '../packages/hana-math/context-service.mjs';
import { createResearchService } from '../packages/hana-math/research-service.mjs';
import { createMainControlService } from '../packages/hana-math/main-control-service.mjs';

const projectId = 'project-terminal-fixture', workerId = 'worker-1';
const creator = { callToken: 'opaque-creator', sessionPath: '/fixture/creator.jsonl' };
const main = { callToken: 'opaque-main', sessionPath: '/fixture/main.jsonl' };
const binding = { sessionId: 'main-fixture', sessionPath: main.sessionPath, agentId: 'saved-main', cwd: '/fixture/project/main', kind: 'math-main', identityConfirmed: true };
const deferred = () => Promise.withResolvers();
const accept = { accepted: true, sessionId: binding.sessionId, sessionPath: binding.sessionPath };

async function researchFixture(t, behavior = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-terminal-')));
  const tasks = new Map(), schedules = new Map(), boundWorkers = new Map(), sessions = new Map();
  const scheduleEntered = deferred(), rootEntered = deferred(), workerEntered = deferred();
  let handler, sequence = 0;
  const sdk = { dataDir, models: { listAvailable: async () => ({ models: [{ provider: 'fixture', id: 'model' }] }) },
    sessions: {
      get: async ({ sessionId }) => ({ session: structuredClone(sessions.get(sessionId)) }),
      list: async () => ({ sessions: [...sessions.values()] }),
      abort: async ({ sessionId }) => ({ ok: true, aborted: true, sessionId }),
    }, tasks: {
      async registerHandler(key, value) { assert.equal(key, 'math-research-once'); handler = value; return () => {}; },
      async create(input) {
        const session = input.scope === 'session', taskId = `task-${++sequence}`;
        const task = { ...input, taskId, pluginId: 'hana-math', status: 'pending', parentSessionId: session ? 'creator-fixture' : null,
          parentSessionPath: session ? creator.sessionPath : null, handlerKey: input.handlerKey ?? null };
        delete task.callToken;
        tasks.set(taskId, task); return structuredClone(task);
      },
      async get(id) { return structuredClone(tasks.get(id)); },
      async list() { return [...tasks.values()].map(row => structuredClone(row)); },
      async schedule(input) {
        const row = { ...input, scheduleId: 'schedule-fixture', pluginId: 'hana-math' }; schedules.set(row.scheduleId, row);
        scheduleEntered.resolve(row);
        await behavior.schedule?.promise; return row;
      },
      async unschedule(id) { schedules.delete(id); return { ok: true }; },
      async listSchedules() { return [...schedules.values()]; },
      async complete(id) {
        const row = tasks.get(id);
        if (row.scope === 'session') { rootEntered.resolve(row); await behavior.root?.promise; }
        row.status = row.scope === 'session' && behavior.badRoot ? 'failed' : 'completed';
        return structuredClone(row);
      },
      async fail(id) { const row = tasks.get(id); row.status = 'failed'; return structuredClone(row); },
      async getDelivery() { throw new Error('fixture delivery lookup failed'); },
    } };
  const contexts = createContextService(sdk);
  await contexts.prepare({ projectId, problem: 'opaque fixture', operatorProfile: 'opaque fixture', workerTask: 'opaque fixture' });
  await contexts.prepareProjectWorkspace({ projectId, role: 'worker', workerId });
  await contexts.assignWorkerTask({ projectId, workerId, task: 'opaque fixture' });
  const profiles = { async getRoleModel(role) { return { role, source: 'saved-role', agentId: `saved-${role}`, model: { provider: 'fixture', id: 'model' } }; },
    async getRoleToolStatus(role) { return { role, agentId: `saved-${role}`, resolvedMode: 'full', appEnabled: true, disabledTools: [] }; } };
  const dependencies = { contexts, profiles, literature: { async search() { assert.fail('unexpected literature call'); } },
    ...(behavior.coreCall ? { bindings: {
      register(worker) { boundWorkers.set(worker.sessionPath, worker); return worker; },
      authorize(_name, ctx) { return boundWorkers.get(ctx.sessionPath); }, close() {}, closeRun() {},
    } } : {}),
    createCore: () => ({ call: behavior.coreCall ?? (() => assert.fail('unexpected Core call')), async dispose() {} }),
    sessions: { start(input) {
      const sessionId = `worker-${++sequence}`, sessionPath = `/fixture/${sessionId}.jsonl`;
      sessions.set(sessionId, { sessionId, path: sessionPath, cwd: input.cwd, agentId: input.selection.agentId, kind: input.kind,
        ownerPluginId: 'hana-math', visibility: 'plugin_private', namespace: 'app', lifecycle: 'active' });
      let state = { sessionId, state: 'running', cleanupPending: false, modelTurn: 1 };
      const done = deferred();
      const bound = input.onBound({ ...input, ...input.selection, sessionId, sessionPath });
      bound.catch(() => {});
      return { done: done.promise, snapshot: () => state,
        async nextTurn() { await bound; workerEntered.resolve({ callToken: 'opaque-worker', sessionPath }); await behavior.turn?.promise; return { ...state, turnEnded: true }; },
        async complete() { state = { ...state, state: 'completed', roundEnded: true }; done.resolve(state); return state; },
        async resume() { assert.fail('unexpected resume'); },
        async stop() { if (state.state !== 'completed') state = { ...state, state: 'stopped' }; done.resolve(state); return state; },
      };
    } } };
  const service = await createResearchService(sdk, dependencies);
  t.after(async () => {
    behavior.schedule?.resolve(); behavior.root?.resolve(); behavior.turn?.resolve();
    try { await service.dispose(); }
    finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });
  return { service, sdk, tasks, dependencies, scheduleEntered, rootEntered, workerEntered,
    start: () => service.startWorkerRun({ projectId, workerId, workerPolicy: { maxRounds: 1, roundDelaySeconds: 0 } }, creator),
    dispatch: row => handler.run({ kind: 'schedule', scheduleId: row.scheduleId, input: row.payload }) };
}

for (const earlySchedule of [false, true]) test(`worker terminal requires root settlement and coordinator release (early schedule: ${earlySchedule})`, { timeout: 5000 }, async t => {
  const schedule = earlySchedule ? deferred() : undefined, root = deferred();
  const worker = earlySchedule ? deferred() : undefined;
  const f = await researchFixture(t, { schedule, root, turn: worker });
  const terminal = deferred(), observed = [], failures = [], removed = [];
  const unsub = f.service.subscribeProjectDashboardTerminal(id => removed.push(id));
  unsub(); unsub();
  f.service.subscribeProjectDashboardTerminal(id => { failures.push(id); throw new Error('ignored sync failure'); });
  f.service.subscribeProjectDashboardTerminal(async id => { failures.push(id); throw new Error('ignored async failure'); });
  f.service.subscribeProjectDashboardTerminal((...args) => {
    observed.push(args);
    const evidence = f.service.projectWorkerMonitor(projectId, workerId, runId);
    terminal.resolve(evidence);
    return new Promise(() => {}); // Observers must not join the coordinator.
  });
  const starting = f.start(), row = await f.scheduleEntered.promise, runId = row.payload.runId;
  if (!schedule) await starting;
  assert.equal((await f.dispatch(row)).status, 'started');
  assert.equal((await f.dispatch(row)).status, 'ignored');
  if (schedule) {
    // Host may dispatch before its schedule creation receipt has returned.
    await f.workerEntered.promise;
    assert.equal((await f.service.projectWorkerStatus(projectId, runId)).coordinatorActive, true);
    assert.deepEqual(observed, []);
    schedule.resolve(); await starting; worker.resolve();
  }
  await f.rootEntered.promise;
  assert.deepEqual(observed, []);
  assert.equal(f.service.projectWorkerMonitor(projectId, workerId, runId).terminal, undefined);
  root.resolve();
  const evidence = await terminal.promise;
  assert.equal(evidence.terminal.runId, runId);
  assert.deepEqual(observed, [[projectId]]);
  assert.deepEqual(failures, [projectId, projectId]);
  assert.deepEqual(removed, []);
  assert.equal((await f.service.projectWorkerStatus(projectId, runId)).coordinatorActive, false);
  const late = [];
  f.service.subscribeProjectDashboardTerminal(id => late.push(id));
  await f.service.stopProjectWorker(projectId, runId);
  await f.service.dispose(); await turn();
  assert.deepEqual(observed, [[projectId]]); assert.deepEqual(late, []);
  const recovered = await createResearchService(f.sdk, f.dependencies);
  try {
    recovered.subscribeProjectDashboardTerminal(id => late.push(id));
    await turn();
    assert.equal(recovered.projectWorkerMonitor(projectId, workerId, runId).terminal, undefined);
    assert.deepEqual(late, []);
  } finally { await recovered.dispose(); }
});

for (const ending of ['unconfirmed', 'stop', 'dispose']) test(`worker dashboard terminal is silent on ${ending}`, { timeout: 5000 }, async t => {
  const gate = deferred();
  const f = await researchFixture(t, ending === 'unconfirmed' ? { badRoot: true } : { turn: gate });
  const events = [], settlements = [];
  f.service.subscribeProjectDashboardTerminal(id => events.push(id));
  f.service.subscribeProjectWorkerSettlement(id => settlements.push(id));
  const run = await f.start(); await f.dispatch(await f.scheduleEntered.promise);
  if (ending === 'unconfirmed') await f.rootEntered.promise;
  else {
    await f.workerEntered.promise;
    const closing = ending === 'stop' ? f.service.stopProjectWorker(projectId, run.runId, { force: true }) : f.service.dispose();
    await closing; gate.resolve();
  }
  for (let i = 0; (await f.service.projectWorkerStatus(projectId, run.runId)).coordinatorActive; ++i) {
    assert.ok(i < 10000, 'coordinator cleanup must settle'); await turn();
  }
  await turn();
  assert.deepEqual(events, []);
  assert.deepEqual(settlements, ending === 'stop' ? [projectId] : []);
  assert.equal(f.service.projectDashboardHistoricalCleanup(projectId, new Map([[run.runId, workerId]])), false);
});

test('Research history seal records each shared intent, not private memory, and survives reload', { timeout: 5000 }, async t => {
  const round = deferred(), wake = deferred(), inspected = [];
  const f = await researchFixture(t, { turn: round,
    async coreCall(binding, operation) {
      const journal = path.join(f.sdk.dataDir, 'research/runs', binding.runId, 'run.json');
      const meta = JSON.parse(await fs.readFile(journal, 'utf8'));
      assert.deepEqual(meta.pendingMutations.map(marker => marker.operation), [operation]);
      const nonce = meta.dashboardSharedWriteNonce;
      if (operation === 'gm_add') assert.equal(nonce, meta.pendingMutations[0].callTag);
      inspected.push(nonce);
      if (operation === 'gm_add' && inspected.length === 2) {
        throw Object.assign(new Error('confirmed fixture write rejection'), { indeterminate: false });
      }
      return { ok: true };
    },
  });
  const noRuns = f.service.projectDashboardHistorySeal(projectId, []);
  assert.match(noRuns, /^[a-f0-9]{64}$/);
  const run = await f.start(); await f.dispatch(await f.scheduleEntered.promise);
  const ctx = await f.workerEntered.promise;
  assert.equal(f.service.projectDashboardHistorySeal(projectId, [run.runId]), null);
  await f.service.invoke('gm_add', {}, ctx);
  await assert.rejects(f.service.invoke('gm_add', {}, ctx), /confirmed fixture write rejection/);
  await f.service.invoke('math_local_memory', { action: 'append', text: 'opaque private note' }, ctx);
  assert.notEqual(inspected[0], inspected[1]); assert.equal(inspected[1], inspected[2]);
  f.service.subscribeProjectDashboardTerminal(() => wake.resolve()); round.resolve(); await wake.promise;
  assert.equal(f.service.projectDashboardHistorySeal(projectId, []), null, 'expected run membership must match exactly');
  const seal = f.service.projectDashboardHistorySeal(projectId, [run.runId]);
  assert.match(seal, /^[a-f0-9]{64}$/); assert.notEqual(seal, noRuns);
  await f.service.dispose();
  const restored = await createResearchService(f.sdk, f.dependencies);
  try {
    assert.equal(restored.projectWorkerDiagnostic(projectId, run.runId).recoveryUnsettled, false);
    assert.equal(restored.projectDashboardHistorySeal(projectId, [run.runId]), seal);
    assert.equal(restored.projectDashboardHistoricalCleanup(projectId, new Map([[run.runId, workerId]])), false);
  } finally { await restored.dispose(); }

  // An incomplete Host projection is not proof that recovery finished, even
  // with the very same journal bytes and a persisted shared-write nonce.
  const list = f.sdk.sessions.list;
  f.sdk.sessions.list = async () => ({ sessions: [] });
  try {
    const incomplete = await createResearchService(f.sdk, f.dependencies);
    try {
      assert.equal(incomplete.projectWorkerDiagnostic(projectId, run.runId).recoveryUnsettled, true);
      assert.equal(incomplete.projectDashboardHistorySeal(projectId, [run.runId]), null);
      assert.equal(incomplete.projectDashboardHistoricalCleanup(projectId, new Map([[run.runId, workerId]])), true);
      assert.equal(incomplete.projectDashboardHistoricalCleanup(projectId, new Map([[run.runId, 'worker-2']])), false);
      assert.equal(incomplete.projectDashboardHistoricalCleanup(projectId, new Map([[run.runId, workerId], ['missing-run', workerId]])), false);
    } finally { await incomplete.dispose(); }

    const record = path.join(f.sdk.dataDir, 'research/runs', run.runId, 'run.json');
    const meta = JSON.parse(await fs.readFile(record, 'utf8'));
    await fs.writeFile(record, JSON.stringify({ ...meta, state: 'running', phase: 'working' }));
    const interrupted = await createResearchService(f.sdk, f.dependencies);
    try {
      assert.equal((await interrupted.projectWorkerStatus(projectId, run.runId)).state, 'interrupted');
      assert.deepEqual(interrupted.projectWorkerMonitor(projectId, workerId, run.runId), { state: 'unknown' });
      assert.equal(interrupted.projectDashboardHistoricalCleanup(projectId, new Map([[run.runId, workerId]])), false,
        'interrupting an active record during this boot is not proof it was already historical');
    } finally { await interrupted.dispose(); }
  } finally { f.sdk.sessions.list = list; }
});

async function goalFixture(t, behavior = {}, files = new Map()) {
  const schedules = new Map(), scheduleEntered = deferred(), sendEntered = deferred(), cleanEntered = deferred();
  const deadlines = new Map();
  let sequence = 0, activation = 0, handler, now = 100_000;
  const clock = { now: () => now,
    setTimeout(fn, ms) {
      const timer = setTimeout(() => { deadlines.delete(timer); fn(); }, ms);
      if (ms === 10000) deadlines.set(timer, fn);
      return timer;
    },
    clearTimeout(timer) { deadlines.delete(timer); clearTimeout(timer); },
  };
  const sdk = { sessions: {
    async get() { return { session: { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', visibility: 'public', lifecycle: 'active', namespace: 'home' } }; },
    async list() { return { sessions: [(await this.get()).session] }; },
    async send() { sendEntered.resolve(); return behavior.send ? behavior.send.promise : accept; },
  }, bus: { async subscribe() { return () => {}; } }, tasks: {
    async registerHandler(_key, value) { handler = value; return () => {}; },
    async schedule(input) {
      const row = { ...input, scheduleId: `alarm-${++sequence}`, intervalMs: null, pluginId: 'hana-math' }; schedules.set(row.scheduleId, row);
      if (sequence === 2) { scheduleEntered.resolve(); await behavior.arm?.promise; }
      return row;
    },
    async unschedule(id) { cleanEntered.resolve(); await behavior.clean?.promise; assert.ok(schedules.delete(id)); return { ok: true }; },
    async getSchedule(id) { return schedules.get(id) ?? null; },
  } };
  const base = 'research/main-controls/';
  const store = { async mkdir() {}, async list() { return [...files.keys()].map(name => name.slice(base.length)); },
    async readJson(name) { return JSON.parse(files.get(name)); },
    async write(name, value) { await behavior.write?.(JSON.parse(value)); files.set(name, value); },
  };
  const service = await createMainControlService(sdk, {
    store, clock,
    nextMonitorActivation: () => ++activation, onDashboardTerminal: behavior.onDashboardTerminal,
    authorize: ctx => ctx === creator ? 'creator' : ctx === main ? 'main' : null,
    getMainBinding: () => binding, verifyCompletion: (_ctx, args) => ({ ...args, verified: true }),
    stopWorkers: behavior.stopWorkers ?? (() => ({ requested: true, cleanupPending: Boolean(behavior.observe) })),
    captureWorkerStopScope: () => ({ targets: [{ workerId, runId: null, complete: true }] }),
    observeWorkerStopScope: input => ({ projectId, targets: input.scope.targets.map(row => ({ ...row,
      state: behavior.observe?.() ? 'settled' : 'pending', reasons: [] })) }),
  });
  t.after(async () => { behavior.send?.resolve(accept); behavior.arm?.resolve(); behavior.clean?.resolve(); await service.dispose(); });
  return { service, files, sendEntered, cleanEntered, scheduleEntered,
    expireDeadline() {
      assert.equal(deadlines.size, 1, 'the send receipt must be the only remaining deadline');
      const [[timer, fn]] = deadlines; clock.clearTimeout(timer); fn();
    },
    fire(id) {
      const row = schedules.get(id); now = row.runAt;
      return handler.run({ kind: 'schedule', scheduleId: id, input: row.payload });
    },
    start: () => service.start({ projectId, authorized: true }, creator),
    complete: goal => service.complete({ projectId, goalId: goal.goalId, generation: goal.generation, factIds: ['aaaaaaaaaaaaaaaa'] }, main),
  };
}

for (const finalBarrier of ['send', 'arming', 'worker-cleanup', 'unschedule']) test(`Goal terminal waits for ${finalBarrier} and wakes without a viewer`, { timeout: 5000 }, async t => {
  const wake = deferred(), events = [];
  const send = finalBarrier === 'send' ? deferred() : undefined;
  const arm = finalBarrier === 'arming' ? deferred() : undefined;
  const clean = finalBarrier === 'unschedule' ? deferred() : undefined;
  let workerSettled = false;
  const f = await goalFixture(t, { send, arm, clean, ...(finalBarrier === 'worker-cleanup' ? { observe: () => workerSettled } : {}),
    async onDashboardTerminal(...args) { events.push({ args, lifecycle: f.service.monitorLifecycle(projectId) }); wake.resolve(); throw new Error('ignored observer rejection'); },
  });
  const goal = await f.start(); await f.sendEntered.promise;
  if (arm) {
    assert.equal(f.fire(goal.alarm.id).status, 'accepted');
    await f.scheduleEntered.promise;
  }
  const completion = f.complete(goal);
  if (clean) { await f.cleanEntered.promise; await turn(); assert.deepEqual(events, []); clean.resolve(); }
  assert.equal((await completion).state, 'completed');
  if (send || arm || finalBarrier === 'worker-cleanup') {
    await turn(); assert.deepEqual(events, []);
    assert.deepEqual(f.service.monitorLifecycle(projectId), { state: 'completed', snapshotUnconfirmed: true });
    if (send) send.resolve(accept);
    else if (arm) arm.resolve();
    else { workerSettled = true; f.service.refreshDashboardTerminal(projectId); }
  }
  await wake.promise;
  assert.equal(events.length, 1); assert.deepEqual(events[0].args, [projectId]);
  assert.equal(events[0].lifecycle.state, 'completed'); assert.equal(events[0].lifecycle.terminal.order, 1);
  f.service.refreshDashboardTerminal(projectId); f.service.refreshDashboardTerminal(projectId);
  await turn(); assert.equal(events.length, 1);
});

test('Goal waits for durable late send acceptance even after sendJob times out', { timeout: 5000 }, async t => {
  const send = deferred(), committing = deferred(), commit = deferred(), wake = deferred();
  const events = [];
  t.after(() => commit.resolve());
  const f = await goalFixture(t, { send,
    async write(meta) {
      if (meta.state === 'completed' && meta.send.state === 'accepted') { committing.resolve(); await commit.promise; }
    },
    onDashboardTerminal(id) { events.push(id); wake.resolve(); throw new Error('advisory observer'); },
  });
  const goal = await f.start(); await f.sendEntered.promise;
  await f.complete(goal); await turn();
  f.expireDeadline(); await turn();
  const status = await f.service.status({ projectId }, creator);
  assert.equal(status.sendInFlight, false); assert.equal(status.send.state, 'unknown');
  send.resolve(accept); await committing.promise;
  f.service.refreshDashboardTerminal(projectId); await turn(); assert.deepEqual(events, []);
  commit.resolve(); await wake.promise;
  assert.deepEqual(events, [projectId]);
});

test('Goal waiting on a real worker coordinator wakes on graceful stop, not on a worker terminal event', { timeout: 5000 }, async t => {
  const round = deferred(), wake = deferred(), workerEvents = [];
  const research = await researchFixture(t, { turn: round });
  const worker = await research.start(); await research.dispatch(await research.scheduleEntered.promise);
  await research.workerEntered.promise;
  const goalService = await goalFixture(t, {
    async stopWorkers() {
      const receipt = await research.service.stopProjectWorker(projectId, worker.runId);
      assert.equal(receipt.coordinatorActive, true);
      return { requested: true, cleanupPending: true };
    },
    observe: () => {
      const diagnostic = research.service.projectWorkerDiagnostic(projectId, worker.runId);
      return diagnostic.state === 'stopped' && !diagnostic.coordinatorActive && !diagnostic.cleanupPending && !diagnostic.taskSettlementPending;
    },
    onDashboardTerminal: id => wake.resolve(id),
  });
  t.after(research.service.subscribeProjectDashboardTerminal(id => workerEvents.push(id)));
  t.after(research.service.subscribeProjectWorkerSettlement(goalService.service.refreshDashboardTerminal));
  const goal = await goalService.start(); await goalService.sendEntered.promise;
  assert.equal((await goalService.complete(goal)).state, 'completed');
  assert.equal(goalService.service.monitorLifecycle(projectId).terminal, undefined);
  round.resolve();
  assert.equal(await wake.promise, projectId);
  assert.ok(goalService.service.monitorLifecycle(projectId).terminal);
  assert.deepEqual(workerEvents, []);
});

test('Goal pause, stop, historical completion and disposal before dispatch do not publish', { timeout: 5000 }, async t => {
  let events = 0;
  const onDashboardTerminal = () => { events++; throw new Error('observer must not be called'); };
  const a = await goalFixture(t, { onDashboardTerminal });
  await a.start(); await a.service.pause({ projectId }, creator); await a.service.resume({ projectId }, creator);
  await a.service.stop({ projectId }, creator); await turn(); assert.equal(events, 0);
  const b = await goalFixture(t, { onDashboardTerminal });
  const goal = await b.start(); await turn(); await b.complete(goal); await b.service.dispose();
  await turn(); assert.equal(events, 0);
  const c = await goalFixture(t, { onDashboardTerminal }, new Map(b.files));
  await c.service.activateRestarts(); c.service.refreshDashboardTerminal(projectId);
  await turn(); assert.deepEqual(c.service.monitorLifecycle(projectId), { state: 'completed' }); assert.equal(events, 0);
});

test('Goal completion seal is stable across status and reload, but not pending cleanup or changed facts', { timeout: 5000 }, async t => {
  const clean = deferred();
  const f = await goalFixture(t, { clean });
  const goal = await f.start(); await f.sendEntered.promise;
  const completing = f.complete(goal);
  await f.cleanEntered.promise;
  assert.equal(f.service.dashboardCompletionSeal(projectId), null);
  clean.resolve(); await completing;
  const seal = f.service.dashboardCompletionSeal(projectId);
  assert.match(seal, /^[a-f0-9]{64}$/);
  await f.service.status({ projectId }, creator);
  assert.equal(f.service.dashboardCompletionSeal(projectId), seal);
  const loaded = await goalFixture(t, {}, new Map(f.files));
  assert.equal(loaded.service.dashboardCompletionSeal(projectId), seal);
  assert.deepEqual(loaded.service.monitorLifecycle(projectId), { state: 'completed' });
  const changed = new Map([...f.files].map(([name, value]) => {
    const meta = JSON.parse(value); meta.completion.factIds = ['bbbbbbbbbbbbbbbb']; return [name, JSON.stringify(meta)];
  }));
  const revised = await goalFixture(t, {}, changed);
  assert.notEqual(revised.service.dashboardCompletionSeal(projectId), seal);
});
