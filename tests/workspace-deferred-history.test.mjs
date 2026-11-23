import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { createContextStore } from '../packages/hana-math/context-service.mjs';
import { createProjectService } from '../packages/hana-math/project-service.mjs';
import { createWorkspaceSnapshotArchive } from '../packages/hana-math/workspace-snapshot-archive.mjs';
import { liveChannels } from '../packages/hana-math/ui/dashboard/live-protocol.mjs';
import { registerWorkspaceDashboardRoutes } from '../packages/hana-math/workspace-dashboard-routes.mjs';
import { defer, fixture, origin } from './helpers/project-service-fixture.mjs';

const unavailable = { state: 'unavailable' };
const stamp = { appId: 'hana-math', agentId: null, document: null, principal: {
  kind: 'app', appId: 'hana-math', credentialKind: 'app_surface_session', connectionKind: 'local', credentialId: 'fixture',
} };

async function setup(t, { followed = true, archived = false } = {}) {
  const f = await fixture(t);
  const a = await f.create(), b = await f.create();
  async function start(service, p) {
    await service.assign({ task: 'opaque' }, p.context);
    return service.start({ projectId: p.projectId }, p.context);
  }
  const aRun = await start(f.service, a); await start(f.service, b);
  for (const p of [a, b]) {
    await f.service.stop({ projectId: p.projectId, force: true }, p.context);
    await fs.mkdir(path.join(f.dataDir, 'research/projects', p.projectId, 'core'), { recursive: true });
  }
  const monitor = (id, worker, runId) => {
    const job = f.jobs.get(runId);
    assert.equal(job.projectId, id); assert.equal(job.workerId, worker);
    return { state: job.state === 'running' ? 'active' : 'idle' };
  };
  f.research.projectWorkerMonitor = monitor;
  f.research.projectDashboardHistorySeal = () => 'a'.repeat(64);
  f.research.projectDashboardWriteState = () => ({ pending: false, endedAt: 0 });
  if (followed) await f.service.dashboardFollow({ projectId: a.projectId }, origin);
  function apiFor(service) {
    const routes = new Map();
    registerWorkspaceDashboardRoutes({ get: (name, handler) => routes.set(name, handler) }, service.workspaceDashboard);
    return async (suffix = '/current', { generation, auth = stamp, signal, query = '' } = {}) => {
      const name = '/workspace-monitor' + suffix;
      const raw = new Request('http://fixture.invalid' + name + query, { signal,
        headers: generation ? { 'x-hana-math-monitor-generation': generation } : {} });
      const result = await routes.get(name)({ req: { raw }, get: () => auth });
      return { status: result.status, body: await result.json() };
    };
  }
  const prior = (await apiFor(f.service)()).body;
  if (followed) assert.equal(prior.state, 'saved');
  await f.service.dispose();
  let endedAt;
  if (archived) {
    const meta = JSON.parse(await fs.readFile(path.join(f.dataDir, 'research/projects', a.projectId, 'project.json')));
    const { projectId, taskId, creator, main, worker } = meta;
    // v1 archive scope from the 0.36.6 layout, with the synthetic Research seal.
    const identity = ['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind', 'namespace', 'visibility', 'ownerPluginId',
      'state', 'identityConfirmed', 'role', 'phase'].map(k => main[k]);
    const scopeSeal = createHash('sha256').update(JSON.stringify(['workspace-publication-v1', projectId, taskId,
      creator.sessionId, creator.sessionPath, identity, [[worker.workerId, worker.lastRun, worker.runs]], [], 'a'.repeat(64), null])).digest('hex');
    endedAt = Date.now() - 1;
    const roles = ['result', 'result', 'result', 'result', 'judgment', 'judgment', 'deadend', 'deadend', 'verify', 'strategy', 'strategy'];
    const panels = {
      '/api/overview': { project: projectId, facts: 1, facts_with_predecessors: 0, facts_by_author: { fixture: 1 },
        verdicts: {}, updated_at: endedAt / 1000, channel_counts: Object.fromEntries(liveChannels.map(kind => [kind, 0])) },
      '/api/factgraph': { nodes: [{ id: 'a'.repeat(16), author: 'fixture', problem_id: 'problem', statement: 'Claim',
        proof: 'archived A proof', intuition: '', predecessors: [], depth: 0 }], edges: [], max_depth: 0 },
      '/api/channels': { channels: liveChannels.map((kind, i) => ({ kind, role: roles[i], count: 0 })) },
      ...Object.fromEntries(liveChannels.map(kind => [`/api/channel/${kind}`, { kind, count: 0, entries: [] }])),
    };
    await createWorkspaceSnapshotArchive(createContextStore(f.dataDir)).publish({ projectId, endedAt, scopeSeal, panels }, () => true);
  }
  const prepared = new Set(), attempts = [], host = [], disk = [];
  const controls = { owner: true, seal: true, prepare: async () => {} };
  f.research.projectWorkerMonitor = (id, worker, runId) => prepared.has(id) ? monitor(id, worker, runId) : { state: 'unknown' };
  f.research.projectDashboardHistorySeal = (id, exact) => {
    assert.equal(id, a.projectId, 'a scoped seal must not probe B');
    assert.deepEqual(exact, [aRun.runId]);
    return prepared.has(id) && controls.seal ? 'a'.repeat(64) : null;
  };
  f.research.projectDashboardWriteState = id => prepared.has(id) ? { pending: false, endedAt: 0 } : null;
  f.research.prepareProjectHistory = async (id, expected, guard, options) => {
    attempts.push(id);
    assert.equal(id, a.projectId); assert.deepEqual(expected, [{ runId: aRun.runId, workerId: aRun.workerId }]);
    assert.deepEqual(options, { fresh: false }); guard();
    assert.ok(disk.some(([method, name]) => method === 'readdir' && name === a.projectId), 'Project details load before Research');
    await controls.prepare(guard); guard(); prepared.add(id);
  };
  const service = await createProjectService(f.sdk, { contexts: f.contexts, profiles: f.profiles, research: f.research,
    createCore() { assert.fail('discovery must not create a Core'); }, literature: { search() { assert.fail('unexpected literature'); } }, deferHistoricalWork: true });
  t.after(() => service.dispose());
  const get = f.sdk.tasks.get;
  f.sdk.tasks.get = async id => {
    host.push(id);
    assert.notEqual(id, b.queued.taskId, 'a request for A must not verify B');
    const result = await get(id);
    return !controls.owner && id === a.queued.taskId ? undefined : result;
  };
  const read = fs.readdir, open = fs.open;
  const note = (method, name) => {
    const dir = typeof name === 'string' && [a.projectId, b.projectId].find(id => name.startsWith(path.join(f.dataDir, 'research/projects', id) + path.sep));
    if (dir) disk.push([method, dir]);
  };
  fs.readdir = (name, ...args) => { note('readdir', name); return read(name, ...args); };
  fs.open = (name, ...args) => { note('open', name); return open(name, ...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.readdir = read; fs.open = open; syncBuiltinESMExports(); });
  return { f, a, controls, host, disk, attempts, prior, endedAt, service, start, api: apiFor(service) };
}

test('deferred saved scope requires the real surface and a fresh Host owner before joining A only', { timeout: 10000 }, async t => {
  const { a, prior, api, attempts, controls, host, disk, f } = await setup(t);
  assert.deepEqual(await api('/api/overview', { generation: prior.generation }), { status: 409, body: unavailable });
  assert.deepEqual(await api('/current', { auth: { ...stamp, document: {} } }), { status: 403, body: unavailable });
  assert.deepEqual(await api('/current', { query: '?projectId=project-any' }), { status: 400, body: unavailable });
  assert.deepEqual({ attempts, host, disk }, { attempts: [], host: [], disk: [] });
  controls.owner = false;
  assert.deepEqual(await api(), { status: 200, body: unavailable });
  assert.deepEqual(attempts, []); assert.deepEqual(disk, []);
  assert.deepEqual(host, [a.queued.taskId]);
  controls.owner = true;
  const entered = defer(), release = defer();
  controls.prepare = async () => { entered.resolve(); await release.promise; };
  const first = api();
  await Promise.race([entered.promise, first.then(result => assert.fail(JSON.stringify({ result, attempts, host, disk })))]);
  const second = api();
  release.resolve();
  const response = await first;
  assert.equal(response.status, 200);
  const cur = response.body;
  assert.deepEqual(Object.keys(cur).sort(), ['asOf', 'generation', 'projectId', 'state']);
  assert.equal(cur.projectId, a.projectId); assert.equal(cur.state, 'saved'); assert.ok(cur.asOf > 0);
  assert.notEqual(cur.generation, prior.generation);
  assert.deepEqual(await second, response); assert.deepEqual(await api(), response);
  assert.deepEqual(attempts, [a.projectId]);
  assert.ok(disk.every(([, id]) => id === a.projectId));
  controls.seal = false;
  assert.deepEqual(await api(), { status: 200, body: unavailable }, 'A without an explicit clean scoped seal stays fenced');
  assert.deepEqual(await api('/api/overview', { generation: cur.generation }), { status: 409, body: unavailable });
  assert.deepEqual(attempts, [a.projectId]); assert.deepEqual(f.calls.factories, []);
});

test('an authorized current worker takes precedence over restored saved history', { timeout: 10000 }, async t => {
  const { f, a, api, attempts, service, start } = await setup(t);
  const saved = (await api()).body;
  assert.equal(saved.state, 'saved');
  f.research.confirmProjectAdmission = async (id, _refs, guard) => { assert.equal(id, a.projectId); guard(); };
  const run = await start(service, a);
  assert.equal(f.jobs.get(run.runId).state, 'running');
  const active = (await api()).body;
  assert.deepEqual(active, { state: 'active', projectId: a.projectId, generation: active.generation });
  assert.notEqual(active.generation, saved.generation);
  assert.deepEqual(await api('/api/overview', { generation: saved.generation }), { status: 409, body: unavailable });
  assert.deepEqual(attempts, [a.projectId], 'the active worker does not cause a dashboard history retry');
});

test('a protected current without nomination does not inspect Host or scoped details', { timeout: 10000 }, async t => {
  const { api, attempts, host, disk } = await setup(t, { followed: false });
  assert.deepEqual(await api(), { status: 200, body: unavailable });
  assert.deepEqual({ attempts, host, disk }, { attempts: [], host: [], disk: [] });
});

test('a valid fixed ticket nominates only its own project without a separate follow', { timeout: 10000 }, async t => {
  const { a, api, attempts, endedAt, disk, host, f } = await setup(t, { followed: false, archived: true });
  assert.deepEqual(await api('/api/factgraph', { generation: 'stale-generation' }), { status: 409, body: unavailable });
  assert.deepEqual({ attempts, host, disk }, { attempts: [], host: [], disk: [] });
  const { body, status } = await api();
  assert.equal(status, 200);
  assert.deepEqual(body, { state: 'snapshot', projectId: a.projectId, endedAt, generation: body.generation });
  assert.ok(body.generation);
  const graph = await api('/api/factgraph', { generation: body.generation });
  assert.equal(graph.status, 200); assert.equal(graph.body.nodes[0].proof, 'archived A proof');
  assert.deepEqual(attempts, [a.projectId]); assert.ok(disk.every(([, id]) => id === a.projectId));
  assert.deepEqual(f.calls.factories, []);
});

test('closing during scoped preparation cannot disclose a generation or consume the retry', { timeout: 10000 }, async t => {
  const { a, api, attempts, controls } = await setup(t);
  const entered = defer(), release = defer(), page = new AbortController();
  controls.prepare = async () => { entered.resolve(); await release.promise; };
  const closed = api('/current', { signal: page.signal });
  await Promise.race([entered.promise, closed.then(result => assert.fail(JSON.stringify({ result, attempts })))]);
  page.abort(); release.resolve();
  assert.deepEqual(await closed, { status: 403, body: unavailable });
  controls.prepare = async () => { throw new Error('unconfirmed A'); };
  assert.deepEqual(await api(), { status: 200, body: unavailable });
  assert.deepEqual(await api(), { status: 200, body: unavailable });
  assert.deepEqual(attempts, [a.projectId, a.projectId], 'one retry after cancellation, none after a stable denial');
});
