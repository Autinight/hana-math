// Offline entry smoke: import the actual production dependency graph and execute
// setup over public SDK fixtures with an empty temporary App-data directory.
// This is not a real Host, session, permission, runtime or model acceptance test.
import test from 'node:test';
import { fixtureFactPage } from './fact-page-fixture.mjs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const appRoot = new URL('../packages/hana-math/', import.meta.url);
async function awaitBusinessReady(tool) {
  const end = performance.now() + 3000;
  while (performance.now() < end) {
    const result = await tool.execute({ action: 'status' });
    if (!result.isError) return;
    assert.equal(result.details.error.code, 'MATH_BOOTSTRAP_PENDING');
    await delay(3);
  }
  assert.fail('App business preparation did not complete');
}

test('production index and project dependencies import and register through the actual defineApp without inference', async (t) => {
  const entry = await import(new URL('index.js', appRoot));
  const project = await import(new URL('project-service.mjs', appRoot));
  const main = await import(new URL('project-main-session.mjs', appRoot));
  assert.equal(entry.name, 'hana-math'); assert.equal(typeof entry.default.apply, 'function');
  assert.equal(typeof project.createProjectService, 'function'); assert.equal(typeof main.createProjectMainSession, 'function');
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-project-entry-')));
  const tools = new Map(), routes = [], disposers = [], calls = [];
  const origin = Object.freeze({ callToken: 'opaque-fixture-token', sessionPath: '/fixture/owner.jsonl' });
  t.after(async () => { for (const dispose of disposers) await dispose(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const unused = (name) => async () => { assert.fail(`Unexpected Host operation during setup: ${name}`); };
  function registration() {
    const dispose = () => {};
    dispose.ready = Promise.resolve(); dispose.disposeAsync = async () => dispose();
    disposers.push(dispose); return dispose;
  }
  const tasks = Object.fromEntries(['create', 'schedule', 'unschedule', 'get', 'complete', 'fail', 'getDelivery'].map((name) => [name, unused(`tasks.${name}`)]));
  Object.assign(tasks, {
    async registerHandler(name) { calls.push(['tasks.registerHandler', name]); return registration(); },
    async list() { calls.push(['tasks.list']); return []; },
    async listSchedules() { calls.push(['tasks.listSchedules']); return []; },
  });
  const context = { dataDir, tasks,
    models: {}, media: {}, providers: {}, hooks: {}, runtime: {}, resources: {}, network: { fetch: unused('network.fetch') },
    bus: { async request(verb, input) {
      assert.equal(verb, 'session:get'); assert.deepEqual(input, { sessionPath: origin.sessionPath });
      calls.push(['bus.request', verb]); return { session: null }; // No authorized worker in this fixture.
    }, subscribe: unused('bus.subscribe') },
    storage: { global: { get: unused('storage.get'), set: unused('storage.set') }, agent: () => assert.fail('No Agent storage is read during setup') },
    tools: { async register(tool) { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); return registration(); } },
    routes: { async register(register) { assert.equal(routes.length, 0, 'one registrar'); register({ get(route) { routes.push(['GET', route]); }, post(route) { routes.push(['POST', route]); } }); return registration(); } },
    documents: { read: unused('documents.read'), requestView: unused('documents.requestView') },
    launchArgs: { async get(name) { assert.equal(name, 'core-self-test'); return false; } },
    logger: { info: unused('logger.info'), warn: unused('logger.warn'), error: unused('logger.error') },
  };
  await entry.default.apply(context);
  const registered = calls.length;
  await assert.rejects(entry.default.apply({ ...context }), { code:'HANA_MATH_DUPLICATE_SETUP' });
  assert.equal(calls.length, registered);
  await assert.rejects(fs.lstat(path.join(dataDir,'research/core-calls')), {code:'ENOENT'});
  assert.deepEqual([...tools.keys()], ['math_context', 'math_dashboard_view', 'math_research', 'gm_add', 'gm_search', 'fact_submit', 'fact_search',
    'fact_revoke', 'search_arxiv_theorems', 'math_assign', 'math_local_memory', 'math_verification_report', 'math_project', 'math_goal', 'math_goal_main']);
  assert.deepEqual(tools.get('math_dashboard_view').view, { providerId: 'app:hana-math/live-dashboard' });
  const { LIVE_ACTIVATE, LIVE_ROUTE, livePaths } = await import(new URL('ui/dashboard/live-protocol.mjs', appRoot));
  assert.deepEqual(routes, [['GET', '/panel'], ['GET', '/editor/assistant/:id'], ['POST', '/editor/assistant/:id'], ['GET', '/editor/role/:id'], ['POST', '/editor/role/:id'],
    ...[LIVE_ACTIVATE, ...livePaths.map(p => LIVE_ROUTE + p), `${LIVE_ROUTE}/api/fact/:factId`].map(p => ['GET', p]),
    ['GET', '/workspace-monitor/current'],
    ['GET', '/workspace-monitor/api/overview'],
    ['GET', '/workspace-monitor/api/factgraph'],
    ['GET', '/workspace-monitor/api/channels'],
    ['GET', '/workspace-monitor/api/channel/conclusion'],
    ['GET', '/workspace-monitor/api/channel/example'],
    ['GET', '/workspace-monitor/api/channel/counterexample'],
    ['GET', '/workspace-monitor/api/channel/proof_attempt'],
    ['GET', '/workspace-monitor/api/channel/plan'],
    ['GET', '/workspace-monitor/api/channel/direction'],
    ['GET', '/workspace-monitor/api/channel/obstacle'],
    ['GET', '/workspace-monitor/api/channel/dead_end'],
    ['GET', '/workspace-monitor/api/channel/verification'],
    ['GET', '/workspace-monitor/api/channel/elaboration'],
    ['GET', '/workspace-monitor/api/channel/master_guidance'],
    ['GET', '/workspace-monitor/api/fact/:factId']]);
  assert.ok(calls.some(([name]) => name === 'tasks.registerHandler'));
  assert.equal(calls.some(([name]) => name === 'bus.request'), false, 'Setup must not query a session');
  await awaitBusinessReady(tools.get('math_context'));
  const result = await tools.get('math_project').execute({ action: 'create', problem: 'Opaque software fixture', role: 'main', context: origin });
  assert.equal(result.isError, true); assert.equal(result.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  const rejected = await tools.get('fact_submit').execute({ statement: 'PRIVATE opaque fixture', proof: '', context: origin });
  assert.equal(rejected.isError, true); assert.equal(rejected.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE/);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'research/runs')).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e)), [], 'Unauthorized input must not create run metadata');
});

for (const failRegistration of [false, true]) test(`D04 production entry defers historical Goals on App load without scanning or mutating seeded state: fail=${failRegistration}`, async t => {
  const entry = await import(new URL('index.js', appRoot));
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-restart-entry-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const projectId = 'project-restart-entry', main = { sessionId: 'opaque-main', sessionPath: '/fixture/main.jsonl', agentId: 'saved-main',
    cwd: path.join(dataDir, 'context/projects', projectId, 'main'), kind: `math-project:${projectId}:main`, namespace: 'home', visibility: 'public', ownerPluginId: 'hana-math', state: 'ready', identityConfirmed: true };
  const projectDir = path.join(dataDir, 'research/projects', projectId), goalDir = path.join(dataDir, 'research/main-controls');
  await fs.mkdir(projectDir, { recursive: true }); await fs.mkdir(goalDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ schemaVersion: 1, projectId, revision: 0, state: 'ready', main, taskCreation: 'confirmed', taskSettlement: 'confirmed', startup: { state: 'accepted' },
    worker: { workerId: 'worker-1', assignment: { state: 'unassigned' }, start: { state: 'idle' }, runs: [], lastRun: null } }));
  const goalFile = path.join(goalDir, `${projectId}.json`);
  await fs.writeFile(goalFile, JSON.stringify({ schemaVersion: 1, projectId, goalId: 'goal-restart-entry', revision: 0, generation: 1, state: 'active',
    authorization: { explicit: true, at: 0 }, restartAuthorization: { resume: 'preserve-budget' }, main,
    nextControlAt: 1, nextAuditAt: 1, lastAuditAt: null, waiting: true, continueRequested: false,
    due: { control: null, audit: null }, ack: { control: null, audit: null }, workerStop: { state: 'not-requested', cleanupPending: null }, send: null, alarm: null }));
  const reads = [], tools = new Map(), registration = () => Object.assign(() => {}, { ready: Promise.resolve() });
  const setup = entry.default.apply({ dataDir, models: {}, media: {}, providers: {}, hooks: {}, runtime: {}, resources: {},
    tasks: { ...Object.fromEntries(['create', 'schedule', 'unschedule', 'get', 'complete', 'fail', 'getDelivery'].map(key => [key, () => assert.fail(`Unexpected task ${key}`)])),
      async registerHandler() { return registration(); }, async list() { return []; }, async listSchedules() { return []; } },
    bus: { async request(verb) { reads.push(verb); if (verb === 'session:get') return { session: null }; if (verb === 'session:list') return { sessions: [] }; assert.fail(verb); }, subscribe() { assert.fail('No valid identity to subscribe'); } },
    storage: { global: {}, agent: () => assert.fail('No Agent creation') },
    tools: { async register(tool) { tools.set(tool.name, tool); if (failRegistration && tool.name === 'math_goal') throw new Error('D04 registration fixture'); return registration(); } },
    routes: { async register(register) { register({ get() {}, post() {} }); return registration(); } },
    launchArgs: { async get() { return false; } }, logger: { info() {}, warn() {}, error() {} },
  });
  if (failRegistration) {
    await assert.rejects(setup, /D04 registration fixture/);
    await delay(10);
  } else {
    await setup;
    await awaitBusinessReady(tools.get('math_context'));
  }
  // Production entry sets deferHistoricalWork=true and never auto-resumes prior Goals on load.
  assert.equal(reads.length, 0);
  assert.equal(JSON.parse(await fs.readFile(goalFile)).state, 'active');
  assert.ok(tools.has('math_project'));
});

test('actual ProjectService result projects canonical Core facts into project identity without a runId', async (t) => {
  const { createProjectService } = await import(new URL('project-service.mjs', appRoot));
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-project-result-entry-')));
  const projectId = 'project-fixture', factId = '0123456789abcdef';
  const ctx = { sessionPath: '/fixture/owner.jsonl', callToken: 'opaque-owner-token' };
  const fact = { fact_id: factId, predecessors: [], markdown: `---\nfact_id: ${factId}\npredecessors: []\n---\nOpaque fixture proof bytes.\r\n` };
  const directory = path.join(dataDir, 'research/projects', projectId);
  await fs.mkdir(directory, { recursive: true });
  // Persisted, purely opaque fixture state. No real App state or session is read.
  await fs.writeFile(path.join(directory, 'project.json'), JSON.stringify({ schemaVersion: 1, projectId, revision: 0, state: 'ready',
    taskId: null, taskSettlement: 'confirmed', creator: { sessionId: 'owner-fixture', sessionPath: ctx.sessionPath },
    main: { state: 'ready', identityConfirmed: true, namespace: 'home', visibility: 'public', ownerPluginId: 'hana-math',
      cwd: path.join(dataDir, 'context/projects', projectId, 'main'), kind: `math-project:${projectId}:main`, sessionId: 'main-fixture', agentId: 'saved-main-fixture' },
    worker: { workerId: 'worker-1', assignment: { state: 'unassigned' }, start: { state: 'idle' }, runs: [], lastRun: null } }), { mode: 0o600 });
  const tasks = new Map(), disposed = new Set(); let sequence = 0, service;
  const sessions = new Map([[ctx.sessionPath, { sessionId: 'owner-fixture', path: ctx.sessionPath, namespace: 'home', ownerPluginId: null }]]);
  for (const role of ['foreign', 'worker', 'verifier']) sessions.set(`/fixture/${role}.jsonl`, {
    sessionId: `${role}-fixture`, path: `/fixture/${role}.jsonl`, namespace: role === 'foreign' ? 'home' : 'app', ownerPluginId: role === 'foreign' ? null : 'hana-math',
    agentId: `saved-${role}`, cwd: `/fixture/${role}`, lifecycle: 'active', visibility: role === 'foreign' ? 'public' : 'plugin_private',
  });
  const sdk = { dataDir,
    sessions: {
      async get(ref) { const row = sessions.get(ref.sessionPath); assert.equal(row?.ownerPluginId, 'hana-math', 'default own get must not read the external creator'); return { session: structuredClone(row) }; },
      async list(input) { assert.deepEqual(input, { scope: 'own', lifecycle: 'all', ownerPluginId: 'hana-math' });
        return { sessions: [...sessions.values()].filter(row => row.ownerPluginId === 'hana-math').map(row => structuredClone(row)) }; },
    },
    tasks: {
      async registerHandler() { const remove = () => {}; remove.ready = Promise.resolve(); remove.disposeAsync = async () => {}; return remove; },
      async create(input) {
        assert.equal(input.scope, 'app'); assert.equal(input.delivery, 'none');
        const task = { taskId: `app:hana-math:entry-${++sequence}`, pluginId: 'hana-math', scope: 'app', delivery: 'none',
          parentSessionId: null, parentSessionPath: null, status: 'pending', metadata: structuredClone(input.metadata) };
        tasks.set(task.taskId, task); return structuredClone(task);
      },
      async get(taskId) { return structuredClone(tasks.get(taskId)); },
      async complete(taskId) { assert.ok(disposed.has(taskId)); const task = tasks.get(taskId); task.status = 'completed'; return structuredClone(task); },
      async fail() { assert.fail('Successful fixture Core facts must not fail a task'); },
    },
  };
  t.after(async () => { try { await service?.dispose(); } finally { await fs.rm(dataDir, { recursive: true, force: true }); } });
  const unused = () => assert.fail('Result must not start workers, prepare workspaces, send models or search literature');
  service = await createProjectService(sdk, { contexts: { prepare: unused, prepareProjectWorkspace: unused, assignWorkerTask: unused }, profiles: {},
    research: { startWorkerRun: unused, projectWorkerStatus: unused, stopProjectWorker: unused }, literature: { search: unused },
    createCore({ taskId }) { return {
      async call(binding, operation, args) {
        assert.equal(binding.projectId, projectId); assert.equal(binding.author, 'saved-main-fixture'); assert.equal(binding.role, 'main');
        assert.equal(tasks.get(taskId).status, 'pending');
        if (operation === 'fact_get') { assert.deepEqual(args, { fact_id: factId }); return structuredClone(fact); }
        assert.equal(operation, 'fact_list_page'); assert.deepEqual(args, {}); return fixtureFactPage([{ fact_id: factId, predecessors: [] }], args, projectId);
      },
      async dispose() { disposed.add(taskId); return { cleanupPending: false }; },
    }; },
  });
  await t.test('actual authorization rejects foreign/worker/verifier control before any Core work', async () => {
    for (const role of ['foreign', 'worker', 'verifier']) {
      const caller = { sessionPath: `/fixture/${role}.jsonl`, callToken: `opaque-${role}-token` };
      for (const request of [() => service.status(projectId, caller), () => service.start({ projectId }, caller),
        () => service.stop({ projectId }, caller), () => service.result({ projectId, factId }, caller)]) {
        await assert.rejects(request(), { code: 'PROJECT_OWNER_DENIED' });
      }
      await assert.rejects(service.assign({ task: 'Opaque task fixture' }, caller), { code: 'PROJECT_MAIN_DENIED' });
      await assert.rejects(service.invoke('fact_search', { query: '' }, caller), { code: 'PROJECT_MAIN_DENIED' });
    }
    assert.equal(tasks.size, 0);
  });
  await t.test('list receipt', async () => assert.deepEqual(await service.result({ projectId }, ctx), { projectId, ...fixtureFactPage([{ fact_id: factId, predecessors: [] }], {}, projectId) }));
  await t.test('complete fact receipt', async () => assert.deepEqual(await service.result({ projectId, factId }, ctx), { projectId, fact }));
});

test('bundled defineApp has no public shutdown-disposer contract; entry does not invent one', async () => {
  const types = await fs.readFile(new URL('sdk/app-contract/server-client.d.ts', appRoot), 'utf8');
  const sdk = await fs.readFile(new URL('sdk/app-contract/server-client.js', appRoot), 'utf8');
  const entry = await fs.readFile(new URL('index.js', appRoot), 'utf8');
  assert.match(types, /defineApp\(setup: \(sdk: AppSdk\) => void \| Promise<void>\)/);
  assert.match(sdk, /await setup\(createAppSdk\(context\)\)/);
  assert.doesNotMatch(entry, /sdk\.(?:onDispose|onShutdown|dispose|bus|hooks)|process\.on\(|return\s+(?:async\s*)?\(\)\s*=>/);
});
