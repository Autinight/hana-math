import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
import { createAppResearchCore } from '../packages/hana-math/runtime/research-runtime.mjs';
import { createWorkspaceDashboard, createWorkspaceMonitorTransport } from '../packages/hana-math/dashboard-monitor-transport.mjs';
import { dashboardSelection } from '../packages/hana-math/dashboard-request.mjs';
import { createWorkspaceMonitor } from '../packages/hana-math/ui/dashboard/workspace-monitor.mjs';
import { liveChannels } from '../packages/hana-math/ui/dashboard/live-protocol.mjs';

const prefix = '/workspace-monitor';
const header = 'x-hana-math-monitor-generation';
const GET = { method: 'GET', cache: 'no-store' };
const sha = bytes => createHash('sha256').update(bytes).digest();
const expected = { state: 'unavailable' };

async function until(predicate, label = 'observation') {
  const end = performance.now() + 3000;
  while (performance.now() < end) { if (predicate()) return; await delay(2); }
  assert.fail(`monitor fixture did not settle: ${label}`);
}

// Actual App managed transport, Project and authorization code; the fixture
// publishes a deterministic Core reply using synthetic Host runtime receipts.
// Neither Python nor a real Host, model or project storage is used.
async function projectFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-monitor-package-')));
  for (const [file, contents] of Object.entries({
    'dependencies/python/bin/python3': 'fixture is never executed',
    'dependencies/runtime.json': JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' }),
    'runtime/research_entry.py': '# unused', 'runtime/research_read_frame.py': '# unused',
    'engine/src/hana_math_engine/research.py': '# unused',
  })) {
    const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, { mode: 0o700 });
  }
  let appCore, heldStart;
  const f = await fixture(t, { createCore: options => appCore.createCore(options) });
  appCore = createAppResearchCore(f.sdk, { packageRoot: root });
  t.after(async () => { await appCore.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const starts = [], runtimeReceipts = new Map(), grants = new Map();
  f.sdk.runtime = {
    async start(input) {
      assert.equal(input.network, 'none'); assert.equal(input.profile, 'scoped');
      assert.equal(input.args[3], path.join(root, 'runtime/research_read_frame.py'));
      assert.equal(f.tasks.get(input.taskId)?.scope, 'app');
      const file = name => path.join(input.cwd, name + '.frame');
      const state = await fs.readFile(file('state'));
      assert.equal(state[8], 1);
      const length = state.readUInt32BE(33);
      const request = JSON.parse((await fs.readFile(file('request'))).subarray(0, length));
      const { projectId } = request.context;
      assert.equal(request.context.role, 'main');
      assert.equal(request.requestId, input.args[5]);
      starts.push({ projectId, operation: request.operation, args: request.arguments });
      const gate = heldStart; heldStart = undefined; if (gate) { gate.started.resolve(); await gate.release.promise; }
      const counts = Object.fromEntries(liveChannels.map(kind => [kind, kind === 'verification' ? 1 : 0]));
      let result;
      const { view, kind } = request.arguments;
      if (request.operation === 'dashboard_factgraph') result = { projectId, asOf: 'a'.repeat(64),
        graph: { nodes: [{ id: '1'.repeat(16), statement: 'Synthetic fact', proof: `Proof for ${projectId}` }], edges: [], max_depth: 0 } };
      else {
        assert.equal(request.operation, 'dashboard_memory');
        const data = view === 'overview' ? { project: projectId, facts: 1, facts_with_predecessors: 0, updated_at: 1, facts_by_author: {}, channel_counts: counts, verdicts: {} }
          : view === 'channels' ? { channels: liveChannels.map(kind => ({ kind, count: counts[kind], role: 'fixture' })) }
          : { kind, count: 1, entries: [{ claim: `Shared ${kind} for ${projectId}` }] };
        result = { projectId, data };
      }
      const body = Buffer.from(JSON.stringify({ schemaVersion: 1, requestId: request.requestId, ok: true, result }));
      const resultFrame = Buffer.alloc(1 << 20); body.copy(resultFrame);
      state[8] = 3; state.writeUInt32BE(body.length, 33); sha(body).copy(state, 37); sha(state.subarray(0, 69)).copy(state, 69);
      await fs.writeFile(file('result'), resultFrame); await fs.writeFile(file('state'), state);
      const receipt = { runtimeId: request.requestId, state: 'exited', exitCode: 0, runtime: 'command', profile: 'scoped', network: 'none' };
      runtimeReceipts.set(request.requestId, receipt); return receipt;
    },
    async get(runtimeId) { return runtimeReceipts.get(runtimeId); },
    watch() { assert.fail('no watch with exited fixture'); }, stop() { assert.fail('no stop with exited fixture'); },
  };
  f.research.projectWorkerMonitor = (projectId, workerId, runId) => {
    const row = f.jobs.get(runId); assert.equal(row.projectId, projectId); assert.equal(row.workerId, workerId);
    return { state: row.monitorState ?? 'active' };
  };
  const a = await f.create(), b = await f.create();
  for (const project of [a, b]) {
    await f.service.assign({ task: 'Synthetic in-memory fixture; no model' }, project.context);
    await f.service.start({ projectId: project.projectId }, project.context);
  }
  await assert.rejects(f.service.authorizeDashboardView({ projectId: a.projectId }, a.context), { code: 'PROJECT_OWNER_DENIED' });
  async function grant(project) {
    const projectId = project.projectId;
    const read = await f.service.authorizeDashboardView({ projectId }, origin);
    grants.set(projectId, Object.freeze({ projectId, read }));
  }
  let binding = Object.freeze({});
  const dashboard = createWorkspaceDashboard({ workspaceMonitor: f.service.workspaceMonitor, lookupReader: id => grants.get(id) });
  const transport = createWorkspaceMonitorTransport(dashboard, { current: () => binding });
  t.after(() => transport.dispose());
  const current = async () => (await transport.fetch(prefix + '/current', GET)).json();
  const fetch = (route, generation) => transport.fetch(prefix + route, { ...GET, headers: { [header]: generation } });
  return { f, a, b, starts, grants, grant, dashboard, transport, current, fetch,
    loseChannel() { binding = null; },
    holdStart() { heldStart = { started: defer(), release: defer() }; const gate = heldStart; t.after(() => gate.release.resolve()); return gate; },
  };
}

const managed = { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 15_000 };
test('there is no default channel or grant; discovery and leaked generations cannot authorize content', async () => {
  let gotSelection = 0, readCalls = 0;
  const projectId = 'project-fixture', token = Object.freeze({});
  const ticket = { status: 'selected', selection: {}, generation: Symbol() };
  const workspaceMonitor = { current() { gotSelection++; return ticket; }, read: () => ({ status:'ok', lifecycle:'active', projectId }) };
  const dashboard = createWorkspaceDashboard({ workspaceMonitor, lookupReader: () => ({ projectId, read() { readCalls++; } }) });
  const noChannel = createWorkspaceMonitorTransport(dashboard);
  await assert.rejects(noChannel.ready(), { code:'WORKSPACE_MONITOR_UNAVAILABLE' });
  assert.equal((await noChannel.fetch(prefix + '/current', GET)).status, 403);
  assert.equal(gotSelection, 0);
  assert.deepEqual(dashboard.current(async () => true), expected);
  assert.deepEqual(dashboard.current(() => false), expected);
  const noGrant = createWorkspaceMonitorTransport(createWorkspaceDashboard({ workspaceMonitor }), { current:() => token });
  await noGrant.ready(); assert.deepEqual(await (await noGrant.fetch(prefix + '/current', GET)).json(), expected);
  const running = createWorkspaceMonitorTransport(dashboard, { current: () => token });
  await running.ready();
  assert.equal((await running.fetch(prefix + '/api/overview', { ...GET, headers:{ [header]:'guessed' } })).status, 403);
  assert.equal(readCalls, 0);
});

test('closing the trusted channel suppresses a late reader and retires the public generation', async () => {
  const projectId = 'project-fixture';
  const channel = { current: () => binding }, binding = Object.freeze({});
  const ticket = { status:'selected', selection:{}, generation: Symbol() };
  const monitor = { current: () => ticket, read: () => ({ status:'ok', lifecycle:'active', projectId }) };
  const hold = defer(); let calls = 0;
  const grant = Object.freeze({ projectId, async read() { calls++; await hold.promise; return { project:projectId }; } });
  const dashboard = createWorkspaceDashboard({ workspaceMonitor:monitor, lookupReader:() => grant });
  const first = createWorkspaceMonitorTransport(dashboard, channel);
  await first.ready();
  const state = await (await first.fetch(prefix+'/current',GET)).json();
  assert.deepEqual(await dashboard.read({ view:'overview' },state.generation,()=>true),expected);
  assert.deepEqual(await dashboard.read(dashboardSelection('/api/overview'),state.generation,()=>false),expected);
  assert.equal(calls,0);
  const refreshed = await (await first.fetch(prefix+'/current',GET)).json();
  const pending = first.fetch(prefix+'/api/overview',{...GET,headers:{[header]:refreshed.generation}});
  assert.equal(calls,1);
  first.dispose(); hold.resolve();
  assert.equal((await pending).status,403);
  await assert.rejects(first.ready(),{code:'WORKSPACE_MONITOR_UNAVAILABLE'});
  const second = createWorkspaceMonitorTransport(dashboard, { current:() => ({}) });
  await assert.rejects(second.ready(),{code:'WORKSPACE_MONITOR_UNAVAILABLE'});
  assert.notEqual(dashboard.current(() => true).generation,refreshed.generation);
});

test('real workspace-monitor controller traverses Project selection and creator reader to settled fixture Core', managed, async t => {
  const g = await projectFixture(t);
  const status = [], renders = [], ui = { visible: null };
  const visibility = Object.assign(new EventTarget(), { hidden: false }), lifecycle = new EventTarget();
  const timers = new Map(); let ordinal = 0;
  const controller = createWorkspaceMonitor(g.transport, {
    clear() { ui.visible = null; }, render(value) { renders.push(value); ui.visible = value; }, status(value) { status.push(value.state); },
  }, { visibility, lifecycle, setTimer(fn, ms) { const id = ++ordinal; timers.set(id,{ fn, ms }); return id; }, clearTimer: id => timers.delete(id) });
  t.after(() => controller.dispose());
  const waitingForPoll = () => timers.size === 1 && [...timers.values()][0].ms === 8000;
  const poll = async () => { await until(waitingForPoll); const [id,t] = [...timers][0]; timers.delete(id); t.fn(); };
  await until(() => status.at(-1) === 'unavailable');
  assert.deepEqual(g.starts, []);
  // An available reader for the older project is not authority for the winner.
  await g.grant(g.a); await poll(); await until(waitingForPoll);
  assert.equal(ui.visible, null); assert.deepEqual(g.starts, []);
  await g.grant(g.b); await poll();
  await until(waitingForPoll, 'first settled overview');
  assert.equal(renders.length, 1, `status=${status.at(-1)}; coreStarts=${g.starts.length}`);
  assert.equal(ui.visible.scope.projectId, g.b.projectId);
  assert.equal(ui.visible.data.project, g.b.projectId);
  controller.select('graph'); await until(() => ui.visible?.tab === 'graph');
  assert.equal(ui.visible.data.nodes[0].proof, `Proof for ${g.b.projectId}`);
  controller.select('memory','verification'); await until(() => ui.visible?.tab === 'memory');
  assert.equal(ui.visible.entries[0].claim, `Shared verification for ${g.b.projectId}`);
  assert.deepEqual(g.starts.map(r => [r.operation, r.args]), [
    ['dashboard_memory',{view:'overview'}], ['dashboard_factgraph',{}], ['dashboard_memory',{view:'channels'}], ['dashboard_memory',{view:'channel',kind:'verification'}],
  ]);
  assert.ok(g.starts.every(row => row.projectId === g.b.projectId));
  const completed = [...g.f.tasks.values()].filter(task => task.metadata?.operation?.startsWith('dashboard_'));
  assert.equal(completed.length, 4);
  assert.ok(completed.every(task => task.status === 'completed' && task.result?.coreOutcome === 'succeeded'));
  const generation = (await g.current()).generation;
  for (const route of ['/api/overview?projectId=' + g.a.projectId, '/api/channel/_status', '/api/fact_get'])
    assert.equal((await g.fetch(route,generation)).status, 404);
  assert.equal((await g.transport.fetch(prefix + '/api/overview', { ...GET, projectId:g.a.projectId, headers:{[header]:generation} })).status, 400);
  assert.equal(g.starts.length, 4);
});

test('FIFO revocation blocks launch; switching, abort and channel loss never deliver an in-flight old result', managed, async t => {
  const g = await projectFixture(t); await g.grant(g.a); await g.grant(g.b); await g.transport.ready();
  const old = await g.current();
  const listing = g.f.sdk.sessions.list, entered = defer(), release = defer(); let reads = 0;
  t.after(() => release.resolve());
  g.f.sdk.sessions.list = async (...args) => { if (++reads === 2) { entered.resolve(); await release.promise; } return listing(...args); };
  const queued = g.fetch('/api/overview',old.generation);
  await entered.promise;
  g.grants.delete(g.b.projectId); release.resolve();
  assert.equal((await queued).status, 403); assert.equal(g.starts.length, 0);
  g.f.sdk.sessions.list = listing;
  await g.grant(g.b);
  const refreshed = await g.current(); assert.notEqual(refreshed.generation, old.generation);
  const held = g.holdStart(), packet = g.fetch('/api/factgraph',refreshed.generation);
  await held.started.promise;
  g.f.jobs.get('run-2').monitorState = 'idle';
  const next = await g.current(); assert.equal(next.projectId,g.a.projectId);
  held.release.resolve();
  const switched = await packet; assert.equal(switched.status,403); assert.deepEqual(await switched.json(),expected);
  assert.equal((await g.fetch('/api/factgraph',refreshed.generation)).status,403);
  const controller = new AbortController(), pendingGate = g.holdStart();
  const pending = g.transport.fetch(prefix+'/api/overview',{ ...GET, signal:controller.signal, headers:{[header]:next.generation} });
  await pendingGate.started.promise;
  controller.abort(); g.loseChannel(); pendingGate.release.resolve();
  assert.equal((await pending).status,403);
  assert.equal((await g.fetch('/api/overview',next.generation)).status,403);
  assert.equal(g.starts.length,2);
});
