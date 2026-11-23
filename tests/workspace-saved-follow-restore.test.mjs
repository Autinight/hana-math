import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createAppResearchCore } from '../packages/hana-math/runtime/research-runtime.mjs';
import { createContextStore } from '../packages/hana-math/context-service.mjs';
import { createProjectService } from '../packages/hana-math/project-service.mjs';
import { createWorkspaceSnapshotArchive } from '../packages/hana-math/workspace-snapshot-archive.mjs';
import { withPublishedWorkspaceDashboard } from '../packages/hana-math/workspace-snapshot-publication.mjs';
import { liveChannels } from '../packages/hana-math/ui/dashboard/live-protocol.mjs';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
import { registerWorkspaceDashboardRoutes } from '../packages/hana-math/workspace-dashboard-routes.mjs';

const unavailable = { state: 'unavailable' };
const stamp = { appId: 'hana-math', agentId: null, document: null, principal: {
  kind: 'app', appId: 'hana-math', credentialKind: 'app_surface_session', connectionKind: 'local', credentialId: 'fixture' } };
const projectFile = (f, id) => path.join(f.dataDir, 'research/projects', id, 'project.json');
const ledger = () => ({ pending: false, endedAt: 0 });
async function setup(t, options) {
  const f = await fixture(t, { roundBoundaryStop: true, ...options });
  const writes = new Map(), uncertain = new Set(), historical = new Set();
  f.research.projectWorkerMonitor = (projectId, workerId, runId) => {
    const job = f.jobs.get(runId); assert.equal(job.projectId, projectId); assert.equal(job.workerId, workerId);
    if (job.cleanupPending) return { state: 'unknown' };
    if (job.terminal) return { state: 'idle', terminal: job.terminal };
    return job.state === 'running' ? { state: 'active' } : { state: 'idle' };
  };
  f.research.projectDashboardHistoricalCleanup = (id, expected) => {
    const jobs = [...f.jobs.values()].filter(job => job.projectId === id);
    return jobs.length === expected.size && jobs.some(job => job.cleanupPending)
      && jobs.every(job => historical.has(job.runId) && job.state === 'stopped' && expected.get(job.runId) === job.workerId);
  };
  f.research.projectDashboardWriteState = id => writes.has(id) ? writes.get(id) : ledger();
  f.research.projectDashboardHistorySeal = (id, runs) => {
    const actual = [...f.jobs.values()].filter(job => job.projectId === id);
    if (uncertain.has(id) || actual.some(job => job.coordinatorActive || job.cleanupPending)) return null;
    assert.deepEqual([...runs].sort(), actual.map(job => job.runId).sort());
    return 'a'.repeat(64);
  };
  let external;
  const service = () => external ?? f.service;
  const start = async p => {
    await service().assign({ task: 'Opaque saved view fixture' }, p.context);
    return service().start({ projectId: p.projectId }, p.context);
  };
  const force = p => service().stop({ projectId: p.projectId, force: true }, p.context);
  const follow = p => service().dashboardFollow({ projectId: p.projectId }, origin);
  const unfollow = p => service().dashboardUnfollow({ projectId: p.projectId }, origin);
  const reopen = async () => {
    await service().dispose();
    if (options?.managedFactory) {
      external = await createProjectService(f.sdk, { contexts: f.contexts, profiles: f.profiles, research: f.research,
        createCore: options.managedFactory(), literature: { search() { assert.fail('unexpected literature'); } } });
    } else await f.open();
  };
  const api = async (sub, generation, auth = stamp) => {
    const routes = new Map();
    registerWorkspaceDashboardRoutes({ get: (name, handler) => routes.set(name, handler) }, service().workspaceDashboard);
    const name = '/workspace-monitor' + sub;
    const request = new Request('http://fixture.invalid' + name, { headers: generation ? { 'x-hana-math-monitor-generation': generation } : {} });
    const result = await routes.get(name)({ req: { raw: request }, get: () => auth });
    return { status: result.status, body: await result.json() };
  };
  const current = async () => (await api('/current')).body;
  return { f, service, writes, uncertain, historical, start, force, follow, unfollow, reopen, current, api };
}
function isSaved(value, projectId) {
  assert.equal(value.state, 'saved'); assert.equal(value.projectId, projectId);
  assert.deepEqual(Object.keys(value).sort(), ['asOf', 'generation', 'projectId', 'state']);
  assert.ok(Number.isSafeInteger(value.asOf) && value.asOf > 0);
  return value;
}

test('a follow during graceful stop restores saved results when quiet and after reopening without another tool call', async t => {
  const s = await setup(t), { f } = s;
  const p = await f.create({ problem: 'opaque saved result', workerPolicy: {} });
  const run = await s.start(p);
  await f.service.stop({ projectId: p.projectId }, p.context); // Synthetic backend is still running at round boundary.
  assert.equal(f.jobs.get(run.runId).state, 'running');
  assert.equal(f.jobs.get(run.runId).stopRequested, true);
  await s.follow(p);
  assert.notEqual((await s.current()).state, 'saved');
  Object.assign(f.jobs.get(run.runId), { state: 'stopped', coordinatorActive: false });
  const first = isSaved(await s.current(), p.projectId);
  assert.deepEqual(await s.current(), first);
  assert.deepEqual(f.calls.core, []); assert.deepEqual(f.calls.factories, []);
  const persisted = JSON.parse(await fs.readFile(projectFile(f, p.projectId), 'utf8')).workspaceFollow;
  assert.equal(persisted.enabled, true);
  const starts = f.calls.starts.length;
  await s.reopen();
  const second = isSaved(await s.current(), p.projectId);
  assert.notEqual(second.generation, first.generation);
  assert.equal(f.calls.starts.length, starts);
  assert.deepEqual(JSON.parse(await fs.readFile(projectFile(f, p.projectId), 'utf8')).workspaceFollow, persisted);
  assert.deepEqual(await s.api('/api/factgraph', first.generation), { status: 409, body: unavailable });
  assert.deepEqual(f.calls.core, []); assert.deepEqual(f.calls.factories, []);
  await s.unfollow(p);
  assert.notEqual((await s.current()).state, 'saved');
  assert.deepEqual(await s.api('/api/factgraph', second.generation), { status: 409, body: unavailable });
  await s.reopen(); assert.notEqual((await s.current()).state, 'saved');
});

test('explicit choice is local, cold ties do not guess, invalid and absent records cannot nominate', async t => {
  const s = await setup(t), { f } = s;
  const a = await f.create(), b = await f.create();
  for (const p of [a, b]) { await s.start(p); await s.force(p); }
  assert.deepEqual(await s.current(), { state: 'idle' });
  await s.follow(a); isSaved(await s.current(), a.projectId);
  await s.follow(b); isSaved(await s.current(), b.projectId);
  await s.reopen(); assert.notEqual((await s.current()).state, 'saved');
  await s.follow(a); isSaved(await s.current(), a.projectId);
  await s.unfollow(b); isSaved(await s.current(), a.projectId);
  await f.service.dispose();
  const file = projectFile(f, a.projectId), meta = JSON.parse(await fs.readFile(file, 'utf8'));
  meta.workspaceFollow.binding = '0'.repeat(64);
  await fs.writeFile(file, JSON.stringify(meta));
  await f.open(); assert.notEqual((await s.current()).state, 'saved');
  assert.deepEqual(f.calls.core, []);
});

test('saved rechecks the owner before discovery and yields to active or unsettled evidence', async t => {
  const s = await setup(t), { f } = s;
  const p = await f.create(), other = await f.create();
  await s.start(p); await s.force(p); await s.follow(p); await s.reopen();
  const before = isSaved(await s.current(), p.projectId);
  const orig = f.sdk.tasks.get;
  const hold = defer(), entered = defer(); let gated = true;
  f.sdk.tasks.get = async id => {
    if (gated && id === p.queued.taskId) { gated = false; entered.resolve(); await hold.promise; }
    return orig(id);
  };
  const late = s.current();
  try {
    await Promise.race([entered.promise, late.then(() => assert.fail('saved metadata was disclosed without the Host owner check'))]);
    const otherRun = await s.start(other);
    assert.equal((await s.current()).state, 'unavailable', 'ungranted active work must also block saved exposure');
    hold.resolve(); assert.deepEqual(await late, unavailable);
    await s.follow(other);
    assert.equal((await s.current()).state, 'active'); assert.equal((await s.current()).projectId, other.projectId);
    assert.deepEqual(await s.api('/api/overview', before.generation), { status: 409, body: unavailable });
    assert.equal(f.jobs.get(otherRun.runId).state, 'running');
    await s.force(other);
  } finally { hold.resolve(); f.sdk.tasks.get = orig; }
  const quiet = isSaved(await s.current(), other.projectId);
  s.uncertain.add(other.projectId);
  assert.notEqual((await s.current()).state, 'saved');
  assert.deepEqual(await s.api('/api/overview', quiet.generation), { status: 409, body: unavailable });
  s.uncertain.delete(other.projectId);
  s.writes.set(other.projectId, { pending: true, endedAt: 0 });
  assert.notEqual((await s.current()).state, 'saved');
  s.writes.delete(other.projectId);
  f.host.delete(other.status.main.sessionPath);
  assert.deepEqual(await s.current(), unavailable);
  assert.deepEqual(await s.api('/current', undefined, { ...stamp, document: {} }), { status: 403, body: unavailable });
  assert.deepEqual(f.calls.core, []); assert.deepEqual(f.calls.factories, []);
});

test('only attributable historical cleanup can be isolated from an exact saved follow', async t => {
  const s = await setup(t), { f } = s;
  const a = await f.create(), b = await f.create(), c = await f.create();
  const aRun = await s.start(a), bRun = await s.start(b);
  await s.force(a); await s.force(b); await s.reopen();
  const bJob = f.jobs.get(bRun.runId);
  bJob.cleanupPending = true;
  s.historical.add(bRun.runId);
  assert.deepEqual(await s.current(), unavailable, 'without consent there is no fixed scope');
  await s.follow(a);
  const saved = isSaved(await s.current(), a.projectId);
  assert.deepEqual(await s.current(), saved);
  await s.reopen();
  const cold = isSaved(await s.current(), a.projectId);
  assert.notEqual(cold.generation, saved.generation);
  assert.deepEqual(await s.api('/api/overview', saved.generation), { status: 409, body: unavailable });
  s.historical.delete(bRun.runId);
  assert.deepEqual(await s.current(), unavailable, 'unknown B is not historical evidence');
  s.historical.add(bRun.runId);
  const next = isSaved(await s.current(), a.projectId);
  assert.notEqual(next.generation, cold.generation);
  const aJob = f.jobs.get(aRun.runId);
  aJob.cleanupPending = true;
  s.historical.add(aRun.runId);
  assert.deepEqual(await s.current(), unavailable, 'A itself must be clean');
  aJob.cleanupPending = false;
  s.writes.set(a.projectId, null);
  assert.deepEqual(await s.current(), unavailable, 'A writes must be confirmed');
  s.writes.delete(a.projectId);
  const beforeActive = isSaved(await s.current(), a.projectId);
  await s.start(c);
  assert.deepEqual(await s.current(), unavailable, 'never fall back to saved around ungranted active work');
  await s.follow(c);
  assert.equal((await s.current()).state, 'active', 'an authorized active selection wins');
  await s.force(c); await s.unfollow(c);
  await s.follow(a);
  assert.notEqual(isSaved(await s.current(), a.projectId).generation, beforeActive.generation);

  await s.follow(b);
  assert.deepEqual(await s.current(), unavailable, 'explicitly choosing B must not fall back to A');
  await s.reopen();
  assert.deepEqual(await s.current(), unavailable, 'cold consent ties do not guess');
  await s.unfollow(b); await s.follow(a);
  const scoped = isSaved(await s.current(), a.projectId);
  bJob.cleanupPending = false;
  assert.notEqual(isSaved(await s.current(), a.projectId).generation, scoped.generation, 'scoped and globally idle selections have distinct generations');
  await s.unfollow(a);
  bJob.cleanupPending = true;
  assert.deepEqual(await s.current(), unavailable);
});

test('historical cleanup selection does not cross a pending or corrupt publication', async t => {
  const s = await setup(t), { f } = s;
  const a = await f.create(), b = await f.create();
  await s.start(a); const bRun = await s.start(b);
  await s.force(a); await s.force(b); await s.follow(a);
  f.jobs.get(bRun.runId).cleanupPending = true;
  s.historical.add(bRun.runId);
  isSaved(await s.current(), a.projectId);
  const archive = createWorkspaceSnapshotArchive(createContextStore(f.sdk.dataDir));
  await archive.begin({ projectId: b.projectId, endedAt: Date.now(), scopeSeal: 'a'.repeat(64) }, () => true);
  await s.reopen();
  assert.deepEqual(await s.current(), unavailable);
  await fs.writeFile(path.join(f.sdk.dataDir, 'context/workspace-snapshot/latest.json'), 'corrupt');
  await s.reopen();
  assert.deepEqual(await s.current(), unavailable);
});

test('scoped publication demands the exact published barrier and a positive scope check', async () => {
  const ticket = { projectId: 'project-a', endedAt: 100 }, choice = {};
  let barrier, valid = true, considered = 0;
  const dashboard = withPublishedWorkspaceDashboard({ live: { current: () => unavailable }, epoch: () => 1,
    archive: { latest: () => ticket, barrier: () => barrier, read: () => assert.fail('discovery is metadata-only') },
    allowed: () => valid, authorize: async (_ticket, guard) => guard(),
    getHistoricalSaved: () => assert.fail('never fall back to saved with an archive'),
    getHistoricalPublication: actual => { assert.equal(actual, ticket); considered++; return choice; } });
  for (barrier of [null, { state: 'pending', endedAt: 100 }, { state: 'corrupt', endedAt: null },
    { state: 'conflict', endedAt: 100 }, { state: 'published', endedAt: 101 }]) {
    assert.deepEqual(await dashboard.current(() => true), unavailable);
  }
  assert.equal(considered, 0);
  barrier = { state: 'published', endedAt: 100 };
  valid = false;
  assert.deepEqual(await dashboard.current(() => true), unavailable);
  valid = true;
  const result = await dashboard.current(() => true);
  assert.deepEqual(result, { state: 'snapshot', ...ticket, generation: result.generation });
});

for (const mode of ['idle saved', 'historical saved', 'historical snapshot']) test(`workspace reading through a synthetic managed frame: ${mode}`, {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const snapshot = mode === 'historical snapshot', historical = mode !== 'idle saved';
  let core, publish;
  const options = { createCore: options => core.createCore(options) };
  const s = await setup(t, options), { f } = s;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-saved-managed-frame-')));
  try {
    for (const [file, text] of Object.entries({
      'dependencies/python/bin/python3': 'Fixture, never executed',
      'dependencies/runtime.json': JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' }),
      'runtime/research_entry.py': '# unused', 'runtime/research_read_frame.py': '# unused', 'engine/src/hana_math_engine/research.py': '# unused',
    })) {
      const dest = path.join(root, file);
      await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, text, { mode: 0o700 });
    }
    core = createAppResearchCore(f.sdk, { packageRoot: root });
    const starts = [], receipts = new Map(), sha = bytes => createHash('sha256').update(bytes).digest();
    f.sdk.runtime = { async start(input) {
      assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none');
      assert.equal(input.args[3], path.join(root, 'runtime/research_read_frame.py'));
      assert.equal(f.tasks.get(input.taskId)?.scope, 'app');
      const file = key => path.join(input.cwd, key + '.frame');
      const state = await fs.readFile(file('state')); assert.equal(state[8], 1);
      const request = JSON.parse((await fs.readFile(file('request'))).subarray(0, state.readUInt32BE(33)));
      assert.equal(request.requestId, input.args[5]); assert.equal(request.context.role, 'main');
      starts.push(request);
      const { projectId } = request.context, { view, terminal } = request.arguments;
      assert.equal(terminal, true);
      const result = { projectId, inventoryRevision: 'a'.repeat(64) };
      if (request.operation === 'dashboard_factgraph' && snapshot) {
        assert.deepEqual(request.arguments, { terminal: true });
        result.asOf = 'b'.repeat(64);
        result.graph = { nodes: [{ id: 'a'.repeat(16), author: 'fixture', problem_id: 'problem', statement: 'Claim',
          proof: 'archived A proof', intuition: '', predecessors: [], depth: 0 }], edges: [], max_depth: 0 };
      } else {
        assert.equal(request.operation, 'dashboard_memory');
        if (view === 'channels' && snapshot) {
          const roles = ['result', 'result', 'result', 'result', 'judgment', 'judgment', 'deadend', 'deadend', 'verify', 'strategy', 'strategy'];
          result.data = { channels: liveChannels.map((kind, i) => ({ kind, role: roles[i], count: 0 })) };
        } else {
          assert.deepEqual(request.arguments, { view: 'overview', terminal: true });
          result.data = { project: projectId, facts: 1, facts_with_predecessors: 0, facts_by_author: { fixture: 1 },
            verdicts: {}, updated_at: 1, channel_counts: Object.fromEntries(liveChannels.map(k => [k, 0])) };
        }
      }
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, requestId: request.requestId, ok: true, result }));
      const frame = Buffer.alloc(1 << 20); bytes.copy(frame); state[8] = 3; state.writeUInt32BE(bytes.length, 33);
      sha(bytes).copy(state, 37); sha(state.subarray(0, 69)).copy(state, 69);
      await fs.writeFile(file('result'), frame); await fs.writeFile(file('state'), state);
      const receipt = { runtimeId: request.requestId, state: 'exited', exitCode: 0, runtime: 'command', profile: 'scoped', network: 'none' };
      receipts.set(receipt.runtimeId, receipt); return receipt;
    }, async get(id) { return receipts.get(id); }, watch() { assert.fail('no watch for exited fixture'); }, stop() { assert.fail('no stop for exited fixture'); } };
    const p = await f.create(), b = historical ? await f.create() : null, c = snapshot ? await f.create() : null;
    if (snapshot) {
      options.managedFactory = () => core.createCore;
      f.research.subscribeProjectDashboardTerminal = fn => { publish = fn; return () => { publish = null; }; };
      await s.reopen();
    }
    const run = await s.start(p);
    if (!snapshot) await s.force(p);
    await s.follow(p);
    let bRun, bJob;
    if (historical) {
      bRun = await s.start(b);
      await s.force(b);
      bJob = f.jobs.get(bRun.runId);
      bJob.cleanupPending = true;
      s.historical.add(bRun.runId);
    }
    if (snapshot) {
      const job = f.jobs.get(run.runId), endedAt = Date.now();
      const terminal = { runId: run.runId, startedAt: endedAt - 1, endedAt };
      const active = await s.current();
      assert.equal(active.state, 'active');
      Object.assign(job, { state: 'finished', coordinatorActive: false, terminal });
      publish(p.projectId);
      let ticket;
      for (let i = 0; !ticket && i < 100; i++) {
        await delay(10);
        ticket = await createWorkspaceSnapshotArchive(createContextStore(f.sdk.dataDir)).load();
      }
      assert.equal(ticket?.endedAt, endedAt, `normal completion produced a complete, verifiable archive (calls: ${JSON.stringify(starts.map(r => [r.operation, r.arguments]))})`);
      const captured = starts.length;
      assert.equal(captured, 3);
      const first = await s.current();
      assert.deepEqual(first, { state: 'snapshot', projectId: p.projectId, endedAt, generation: first.generation });
      assert.ok(first.generation); assert.notEqual(first.generation, active.generation);
      assert.deepEqual(await s.api('/api/factgraph', active.generation), { status: 409, body: unavailable });
      const read = await s.api('/api/factgraph', first.generation);
      assert.equal(read.status, 200); assert.equal(read.body.nodes[0].proof, 'archived A proof');
      assert.equal(starts.length, captured, 'serving a complete archive must never invoke Core');

      job.terminal = { ...terminal, endedAt: endedAt + 1 };
      assert.deepEqual(await s.current(), unavailable, 'in-process terminal must match published endedAt');
      job.terminal = terminal;
      const scoped = await s.current();
      assert.notEqual(scoped.generation, first.generation);
      bJob.cleanupPending = false;
      const normal = await s.current();
      assert.equal(normal.state, 'snapshot'); assert.notEqual(normal.generation, scoped.generation);
      assert.deepEqual(await s.api('/api/factgraph', scoped.generation), { status: 409, body: unavailable });
      bJob.cleanupPending = true;
      assert.deepEqual(await s.api('/api/factgraph', normal.generation), { status: 409, body: unavailable });
      await s.reopen();
      const restored = await s.current();
      assert.deepEqual(restored, { state: 'snapshot', projectId: p.projectId, endedAt, generation: restored.generation });
      assert.notEqual(restored.generation, scoped.generation);
      assert.deepEqual(await s.api('/api/factgraph', restored.generation), read);
      const mainPath = p.status.main.sessionPath, main = f.host.get(mainPath);
      assert.ok(main);
      f.host.delete(mainPath);
      assert.deepEqual(await s.current(), unavailable, 'even metadata requires confirmed Host ownership');
      assert.deepEqual(await s.api('/api/factgraph', restored.generation), { status: 409, body: unavailable });
      f.host.set(mainPath, main);
      s.uncertain.add(p.projectId);
      assert.deepEqual(await s.current(), unavailable, 'A itself must have clean history');
      s.uncertain.delete(p.projectId);
      s.writes.set(p.projectId, { pending: true, endedAt: 0 });
      assert.deepEqual(await s.current(), unavailable);
      assert.deepEqual(await s.api('/api/factgraph', restored.generation), { status: 409, body: unavailable });
      s.writes.delete(p.projectId);
      s.historical.delete(bRun.runId);
      assert.deepEqual(await s.current(), unavailable, 'ordinary unknown is not sufficient');
      s.historical.add(bRun.runId);
      const beforeOther = await s.current();
      await s.start(c);
      assert.deepEqual(await s.current(), unavailable, 'an ungranted active project blocks a scoped publication');
      assert.deepEqual(await s.api('/api/factgraph', beforeOther.generation), { status: 409, body: unavailable });
      await s.force(c);
      await s.follow(c);
      assert.deepEqual(await s.current(), unavailable, 'the selected project cannot use a different project’s archive');
      await s.reopen();
      assert.deepEqual(await s.current(), unavailable, 'two affirmative cold consents cannot select a target');
      await s.unfollow(c); await s.follow(p);
      const beforeNewRun = await s.current();
      assert.equal(beforeNewRun.state, 'snapshot');
      await s.start(p);
      assert.equal((await s.current()).state, 'active');
      assert.deepEqual(await s.api('/api/factgraph', beforeNewRun.generation), { status: 409, body: unavailable });
      await s.force(p);
      assert.deepEqual(await s.current(), unavailable, 'a later A run fences its old archive, even if stopped');
      await s.unfollow(p);
      assert.deepEqual(await s.current(), unavailable);
      assert.equal(starts.length, captured);
      return;
    }
    await s.reopen();
    const saved = isSaved(await s.current(), p.projectId);
    assert.deepEqual(await s.current(), saved);
    assert.equal(starts.length, 0);
    const overview = await s.api('/api/overview', saved.generation);
    assert.equal(overview.status, 200, JSON.stringify(overview));
    assert.equal(overview.body.project, p.projectId); assert.equal(overview.body.facts, 1);
    assert.equal(overview.body.updated_at, saved.asOf / 1000);
    assert.equal(starts.length, 1);
    await s.unfollow(p);
    assert.deepEqual(await s.api('/api/overview', saved.generation), { status: 409, body: unavailable });
    assert.equal(starts.length, 1);
  } finally { await s.service().dispose(); await core?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
