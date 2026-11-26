// Software-only test for simultaneous delivery of two worker results to main
// (docs/open-issues.md: "两条结果同时送达 main").
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContextService } from '../packages/hana-math/context-service.mjs';
import { createResearchService } from '../packages/hana-math/research-service.mjs';
import { createProjectService } from '../packages/hana-math/project-service.mjs';
import { createProjectMainSession } from '../packages/hana-math/project-main-session.mjs';

const APP = 'hana-math';
const origin = Object.freeze({ callToken: 'opaque-creator-token', sessionPath: '/fixture/creator.jsonl' });
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

async function concurrentDeliveryFixture(t, deliveryByWorker) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-concurrent-delivery-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const tasks = new Map(), schedules = new Map(), handlers = new Map(), host = new Map(), selections = new Map(), configuredModels = new Map();
  const completions = new Map(), deliveries = [], completeBarrier = { entered: 0, ready: defer(), release: defer() };
  let taskSeq = 0, sessionSeq = 0, unexpectedFailure;

  const agents = [
    { id: 'saved-main', state: 'active', deletedAt: null, ownerPluginId: APP, visibility: 'plugin_private',
      plugin: { ownerPluginId: APP, visibility: 'plugin_private', kind: 'role', roleId: 'main' } },
    { id: 'saved-worker', state: 'active', deletedAt: null, ownerPluginId: APP, visibility: 'plugin_private',
      plugin: { ownerPluginId: APP, visibility: 'plugin_private', kind: 'role', roleId: 'worker' } },
    { id: 'saved-verifier', state: 'active', deletedAt: null, ownerPluginId: APP, visibility: 'plugin_private',
      plugin: { ownerPluginId: APP, visibility: 'plugin_private', kind: 'role', roleId: 'verifier' } },
  ];
  host.set(origin.sessionPath, {
    sessionId: 'creator-stable', path: origin.sessionPath, agentId: 'user-agent',
    namespace: 'home', visibility: 'public', ownerPluginId: null, lifecycle: 'active',
  });

  const diskProjection = row => { const out = structuredClone(row); out.modelId = null; delete out.modelProvider; return out; };
  const profiles = {
    async getRoleModel(role) {
      return { role, source: 'saved-role', instanceState: 'active', agentId: `saved-${role}`,
        model: { provider: 'fixture-provider', id: 'fixture-model' } };
    },
    async getRoleToolStatus(role) {
      return { role, agentId: `saved-${role}`, resolvedMode: 'full', appEnabled: true, disabledTools: [] };
    },
  };

  let research, projects;
  const workerHandles = new Map(), bothWorkersStarted = defer();
  const sdk = {
    dataDir,
    bus: { async subscribe() { return Object.assign(() => {}, { ready: Promise.resolve() }); } },
    agents: { list: async () => ({ agents: structuredClone(agents) }) },
    models: { listAvailable: async () => ({ models: [{ provider: 'fixture-provider', id: 'fixture-model' }] }) },
    tools: {
      async list() {
        return ['gm_add', 'gm_search', 'fact_submit', 'fact_search', 'fact_revoke', 'search_arxiv_theorems',
          'math_assign', 'math_local_memory', 'math_verification_report', 'math_project', 'math_goal', 'math_goal_main']
          .map(name => ({ name, source: { kind: 'app', appId: APP }, availability: { registered: true } }));
      },
    },
    sessions: {
      async get({ sessionId, sessionPath }) {
        const row = sessionPath ? host.get(sessionPath) : [...host.values()].find(s => s.sessionId === sessionId);
        if (row?.ownerPluginId !== APP) throw Object.assign(new Error('denied'), { code: 'SESSION_ACCESS_DENIED' });
        return { session: diskProjection(row) };
      },
      async context({ sessionId }) {
        const row = [...host.values()].find(s => s.sessionId === sessionId);
        if (row?.ownerPluginId !== APP || !configuredModels.has(sessionId)) throw Object.assign(new Error('denied'), { code: 'SESSION_ACCESS_DENIED' });
        return { sessionId, model: structuredClone(configuredModels.get(sessionId)), isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
      },
      async list(input) {
        return { sessions: [...host.values()].filter(s => s.ownerPluginId === APP && (!input.agentId || s.agentId === input.agentId)).map(diskProjection) };
      },
      async create(input) {
        const sessionId = `sess-${++sessionSeq}`, sessionPath = `/fixture/${sessionId}.jsonl`;
        const row = { sessionId, path: sessionPath, agentId: input.agentId, cwd: input.cwd, namespace: input.namespace ?? 'home',
          visibility: input.visibility ?? 'public', ownerPluginId: APP, kind: input.kind, lifecycle: 'active', modelId: null };
        host.set(sessionPath, row); configuredModels.set(sessionId, structuredClone(input.model));
        return { ok: true, ...structuredClone(row), sessionPath, modelId: input.model.id, modelProvider: input.model.provider };
      },
      async setActiveTools({ sessionId, toolNames }) {
        selections.set(sessionId, [...toolNames]);
        return { sessionId, toolNames: [...toolNames], effective: 'current', pendingToolNames: null };
      },
      async getToolSelection({ sessionId }) {
        return { sessionId, toolNames: selections.get(sessionId) ?? [], effective: 'current', pendingToolNames: null };
      },
      async send(input) {
        const row = [...host.values()].find(s => s.sessionId === input.sessionId);
        return { accepted: true, sessionId: row.sessionId, sessionPath: row.path };
      },
      async abort({ sessionId }) { return { sessionId, aborted: true }; },
    },
    tasks: {
      async registerHandler(key, value) {
        handlers.set(key, value);
        return Object.assign(() => handlers.delete(key), { ready: Promise.resolve(), disposeAsync: async () => handlers.delete(key) });
      },
      async create(input) {
        const taskId = input.scope === 'app' ? `app:hana-math:core-${++taskSeq}` : `task-${++taskSeq}`;
        let parentSessionId = null, parentSessionPath = null;
        if (input.scope === 'session') {
          if (input.callToken === origin.callToken) {
            parentSessionId = 'creator-stable'; parentSessionPath = origin.sessionPath;
          } else {
            const mainRow = [...host.values()].find(s => s.ownerPluginId === APP && s.kind?.endsWith(':main'));
            parentSessionId = mainRow.sessionId; parentSessionPath = mainRow.path;
          }
        }
        const row = { ...input, handlerKey: input.handlerKey ?? null, taskId, pluginId: APP, status: 'pending', parentSessionId, parentSessionPath };
        tasks.set(taskId, row);
        return structuredClone(row);
      },
      async get(id) { return structuredClone(tasks.get(id)); },
      async list() { return [...tasks.values()].map(v => structuredClone(v)); },
      async listSchedules() { return [...schedules.values()].map(v => structuredClone(v)); },
      async schedule(input) {
        const scheduleId = `schedule-${schedules.size + 1}`;
        const row = { ...input, scheduleId, pluginId: APP };
        schedules.set(scheduleId, row);
        return structuredClone(row);
      },
      async getSchedule(id) { return structuredClone(schedules.get(id) ?? null); },
      async unschedule(id) { schedules.delete(id); return { ok: true }; },
      async complete(id, result) {
        const row = tasks.get(id);
        if (row.scope === 'session' && row.metadata?.researchRunId) {
          completeBarrier.entered++;
          if (completeBarrier.entered === 2) completeBarrier.ready.resolve();
          await completeBarrier.release.promise;
        }
        row.status = 'completed';
        row.result = structuredClone(result);
        if (row.metadata?.projectId) completions.get(row.metadata.projectId)?.resolve();
        return structuredClone(row);
      },
      async fail(id, error) {
        const row = tasks.get(id);
        row.status = 'failed';
        row.error = String(error);
        if (row.scope === 'session' && row.metadata?.researchRunId) {
          unexpectedFailure = new Error(`Worker task ${id} failed unexpectedly: ${error}`);
          bothWorkersStarted.resolve();
          completeBarrier.ready.resolve();
          completeBarrier.release.resolve();
        }
        return structuredClone(row);
      },
      async getDelivery(id) {
        const row = tasks.get(id);
        const workerId = row?.result?.workerId ?? null;
        const receipt = workerId && deliveryByWorker[workerId]
          ? structuredClone(deliveryByWorker[workerId])
          : { state: 'delivered', delivered: true };
        deliveries.push({ taskId: id, workerId, parentSessionPath: row?.parentSessionPath, receipt });
        return receipt;
      },
    },
  };

  const contexts = createContextService(sdk);
  const sessions = {
    start(input) {
      const done = defer(), turnDone = defer();
      const id = `worker-sess-${++sessionSeq}`, sessPath = `/fixture/worker-${sessionSeq}.jsonl`;
      const binding = {
        role: input.role, agentId: input.selection.agentId, cwd: input.cwd,
        sessionId: id, sessionPath: sessPath, model: structuredClone(input.selection.model),
      };
      let currentSnapshot = { ...binding, state: 'preparing', cleanupPending: true };
      const ready = Promise.resolve().then(async () => {
        await input.onBound?.(binding);
        currentSnapshot = { ...binding, state: 'running', cleanupPending: true };
        await input.onUpdate?.(currentSnapshot);
        workerHandles.set(id, { handle, done, turnDone, binding, input });
        if (workerHandles.size === 2) bothWorkersStarted.resolve();
        return done.promise;
      });
      const handle = {
        done: ready,
        snapshot: () => structuredClone(currentSnapshot),
        async nextTurn() { return turnDone.promise; },
        async resume() { return turnDone.promise; },
        async complete() {
          currentSnapshot = { ...binding, state: 'completed', modelTurn: 1, roundEnded: true, cleanupPending: false, modelStopReason: 'stop', finalText: 'Worker completed cleanly.' };
          await input.onUpdate?.(currentSnapshot);
          done.resolve(currentSnapshot);
          return currentSnapshot;
        },
        async stop() {
          if (currentSnapshot.state !== 'completed') {
            currentSnapshot = { ...binding, state: 'stopped', abortOutcome: 'idle-confirmed', cleanupPending: false };
            await input.onUpdate?.(currentSnapshot);
            turnDone.resolve(currentSnapshot);
            done.resolve(currentSnapshot);
          }
          return currentSnapshot;
        },
      };
      return handle;
    },
    async dispose() { return { cleanupPending: false, errors: [] }; },
  };
  const createCore = () => ({ call: async () => ({}), dispose: async () => ({ confirmed: true }) });
  const literature = { search: async () => ({ results: [] }) };

  async function open() {
    research = await createResearchService(sdk, { contexts, profiles, createCore, sessions, literature });
    projects = await createProjectService(sdk, {
      contexts, profiles, research, createCore, literature, createMainSession: createProjectMainSession,
    });
  }
  await open();
  t.after(async () => {
    await projects?.dispose().catch(() => {});
    await research?.dispose().catch(() => {});
  });

  // Create a 2-worker project (1 round per worker) and run its setup schedule to readiness.
  const created = await projects.create({
    problem: 'Simultaneous worker delivery test',
    workers: 2,
    workerPolicy: { maxRounds: 1, roundDelaySeconds: 0 },
  }, origin);
  const setupDone = defer();
  completions.set(created.projectId, setupDone);
  const setupSchedule = [...schedules.values()].find(s => s.handlerKey === 'math-project-setup');
  await handlers.get('math-project-setup').run({ kind: 'schedule', scheduleId: setupSchedule.scheduleId, input: setupSchedule.payload });
  await setupDone.promise;
  const readyProject = await projects.status(created.projectId, origin);
  const mainContext = Object.freeze({ callToken: 'opaque-main-token', sessionPath: readyProject.main.sessionPath });

  return {
    get research() { return research; },
    get projects() { return projects; },
    projectId: created.projectId,
    mainContext,
    handlers,
    schedules,
    tasks,
    workerHandles,
    bothWorkersStarted,
    deliveries,
    completeBarrier,
    assertNoFailure() { if (unexpectedFailure) throw unexpectedFailure; },
    async waitFinished(runId) {
      for (let i = 0; i < 200; i++) {
        this.assertNoFailure();
        const s = await research.projectWorkerStatus(created.projectId, runId);
        if (s.phase === 'finished' && s.delivery?.state !== 'pending') return s;
        await new Promise(r => setTimeout(r, 10));
      }
      throw new Error(`Run ${runId} did not finish`);
    },
    async restart() {
      await projects.dispose();
      await research.dispose();
      await open();
    },
  };
}

test('two worker results delivered simultaneously to main both settle cleanly without dropping either receipt', async t => {
  const f = await concurrentDeliveryFixture(t, {
    'worker-1': { state: 'delivered', delivered: true },
    'worker-2': { state: 'delivered', delivered: true },
  });
  await f.projects.assign({ workerId: 'worker-1', task: 'Prove Lemma A' }, f.mainContext);
  await f.projects.assign({ workerId: 'worker-2', task: 'Prove Lemma B' }, f.mainContext);
  const run1 = await f.projects.start({ projectId: f.projectId, workerId: 'worker-1' }, f.mainContext);
  const run2 = await f.projects.start({ projectId: f.projectId, workerId: 'worker-2' }, f.mainContext);

  const sched1 = [...f.schedules.values()].find(s => s.payload?.runId === run1.runId);
  const sched2 = [...f.schedules.values()].find(s => s.payload?.runId === run2.runId);
  await f.handlers.get(sched1.handlerKey).run({ kind: 'schedule', scheduleId: sched1.scheduleId, input: sched1.payload });
  await f.handlers.get(sched2.handlerKey).run({ kind: 'schedule', scheduleId: sched2.scheduleId, input: sched2.payload });

  // Wait until both worker sessions are running, then finish both at the exact same tick.
  await f.bothWorkersStarted.promise;
  f.assertNoFailure();
  for (const { turnDone, binding } of f.workerHandles.values()) {
    turnDone.resolve({ ...binding, state: 'running', turnEnded: true, modelTurn: 1, cleanupPending: false, modelStopReason: 'stop', finalText: 'Worker completed cleanly.' });
  }

  // Both workers hit tasks.complete() concurrently targeting main's session.
  await f.completeBarrier.ready.promise;
  f.assertNoFailure();
  f.completeBarrier.release.resolve();

  const status1 = await f.waitFinished(run1.runId);
  const status2 = await f.waitFinished(run2.runId);
  assert.equal(status1.phase, 'finished');
  assert.equal(status2.phase, 'finished');
  assert.deepEqual(status1.delivery, { state: 'delivered', delivered: true });
  assert.deepEqual(status2.delivery, { state: 'delivered', delivered: true });

  assert.equal(f.deliveries.length, 2);
  assert.ok(f.deliveries.every(d => d.parentSessionPath === f.mainContext.sessionPath));
  assert.deepEqual(f.deliveries.map(d => d.workerId).sort(), ['worker-1', 'worker-2']);

  const projectStatus = await f.projects.status(f.projectId, origin);
  assert.equal(projectStatus.coreUnsettled, false);
  const w1 = projectStatus.workers.find(w => w.workerId === 'worker-1');
  const w2 = projectStatus.workers.find(w => w.workerId === 'worker-2');
  assert.equal(w1.lastRun, run1.runId);
  assert.equal(w2.lastRun, run2.runId);
  assert.deepEqual(w1.status.delivery, { state: 'delivered', delivered: true });
  assert.deepEqual(w2.status.delivery, { state: 'delivered', delivered: true });
});

test('simultaneous mixed delivery preserves published vs delivered per worker across restart without conflation', async t => {
  const f = await concurrentDeliveryFixture(t, {
    'worker-1': { state: 'delivered', delivered: true },
    'worker-2': { state: 'published', delivered: false },
  });
  await f.projects.assign({ workerId: 'worker-1', task: 'Prove Lemma A' }, f.mainContext);
  await f.projects.assign({ workerId: 'worker-2', task: 'Prove Lemma B' }, f.mainContext);
  const run1 = await f.projects.start({ projectId: f.projectId, workerId: 'worker-1' }, f.mainContext);
  const run2 = await f.projects.start({ projectId: f.projectId, workerId: 'worker-2' }, f.mainContext);

  const sched1 = [...f.schedules.values()].find(s => s.payload?.runId === run1.runId);
  const sched2 = [...f.schedules.values()].find(s => s.payload?.runId === run2.runId);
  await f.handlers.get(sched1.handlerKey).run({ kind: 'schedule', scheduleId: sched1.scheduleId, input: sched1.payload });
  await f.handlers.get(sched2.handlerKey).run({ kind: 'schedule', scheduleId: sched2.scheduleId, input: sched2.payload });

  await f.bothWorkersStarted.promise;
  f.assertNoFailure();
  for (const { turnDone, binding } of f.workerHandles.values()) {
    turnDone.resolve({ ...binding, state: 'running', turnEnded: true, modelTurn: 1, cleanupPending: false, modelStopReason: 'stop', finalText: 'Worker completed cleanly.' });
  }

  await f.completeBarrier.ready.promise;
  f.assertNoFailure();
  f.completeBarrier.release.resolve();
  await f.waitFinished(run1.runId);
  await f.waitFinished(run2.runId);

  const beforeRestart = await f.projects.status(f.projectId, origin);
  assert.deepEqual(beforeRestart.workers.find(w => w.workerId === 'worker-1').status.delivery, { state: 'delivered', delivered: true });
  assert.deepEqual(beforeRestart.workers.find(w => w.workerId === 'worker-2').status.delivery, { state: 'published', delivered: false });

  await f.restart();
  const afterRestart = await f.projects.status(f.projectId, origin);
  assert.deepEqual(afterRestart.workers.find(w => w.workerId === 'worker-1').status.delivery, { state: 'delivered', delivered: true });
  assert.deepEqual(afterRestart.workers.find(w => w.workerId === 'worker-2').status.delivery, { state: 'published', delivered: false });
});
