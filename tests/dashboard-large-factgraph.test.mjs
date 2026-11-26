// M-07 large fact-graph tests (3157 facts, 8616 edges) across ProjectService,
// workspace routes, workspace monitor, and collectProjectGraph without raising IPC limits.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { collectProjectGraph, GRAPH_FACT_LIMIT, GRAPH_EDGE_LIMIT } from '../packages/hana-math/project-graph.mjs';
import { dashboardSelection } from '../packages/hana-math/dashboard-request.mjs';
import { registerWorkspaceDashboardRoutes } from '../packages/hana-math/workspace-dashboard-routes.mjs';
import { createWorkspaceMonitor } from '../packages/hana-math/ui/dashboard/workspace-monitor.mjs';
import { createAppResearchCore, validProjectDashboardReadArguments } from '../packages/hana-math/runtime/research-runtime.mjs';
import { fixtureFactPage } from './fact-page-fixture.mjs';
import { fixture, origin } from './helpers/project-service-fixture.mjs';

const managed = { skip: process.platform !== 'darwin' || process.arch !== 'arm64' };
const sha = data => createHash('sha256').update(data).digest();

function buildScaleGraph(nodeCount = 3157, targetEdges = 8616) {
  const ids = Array.from({ length: nodeCount }, (_, i) => (i + 1).toString(16).padStart(16, '0'));
  const preds = Array.from({ length: nodeCount }, () => []);
  let edges = 0;
  for (let i = 1; i <= 40 && i < nodeCount && edges < targetEdges; i++) {
    preds[i].push(ids[i - 1]); edges++;
  }
  let idx = 10;
  while (edges < targetEdges) {
    for (let k = 1; k <= 5 && idx - k >= 0 && edges < targetEdges; k++) {
      const cand = ids[idx - k];
      if (!preds[idx].includes(cand)) { preds[idx].push(cand); edges++; }
    }
    idx = idx + 1 >= nodeCount ? 10 : idx + 1;
  }
  const depth = new Map();
  let maxDepth = 0;
  const nodes = ids.map((id, i) => {
    const d = preds[i].length ? 1 + Math.max(...preds[i].map(p => depth.get(p) ?? 0)) : 0;
    depth.set(id, d);
    if (d > maxDepth) maxDepth = d;
    return { id, author: `worker-${(i % 4) + 1}`, depth: d, statement: `Statement for ${id}`, predecessors: preds[i] };
  });
  return { ids, nodes, edgesCount: edges, maxDepth };
}

test('M-07 runtime argument validation allows index/fact modes while rejecting invalid payloads', () => {
  const sha = 'a'.repeat(64), fid = '0'.repeat(16);
  assert.equal(validProjectDashboardReadArguments('dashboard_factgraph', {}, false), true);
  assert.equal(validProjectDashboardReadArguments('dashboard_factgraph', { mode: 'index', offset: 0, limit: 512 }, false), true);
  assert.equal(validProjectDashboardReadArguments('dashboard_factgraph', { mode: 'index', offset: 512, limit: 512, asOf: sha, terminal: true }, true), true);
  assert.equal(validProjectDashboardReadArguments('dashboard_factgraph', { mode: 'fact', factId: fid }, false), true);
  assert.equal(validProjectDashboardReadArguments('dashboard_factgraph', { mode: 'fact', factId: fid, asOf: sha }, true), true);
  for (const bad of [
    { mode: 'unknown' }, { mode: 'index', offset: -1 }, { mode: 'index', offset: 4096 }, { mode: 'index', limit: 1025 },
    { mode: 'index', asOf: 'bad' }, { mode: 'fact' }, { mode: 'fact', factId: 'short' },
    { mode: 'fact', factId: fid, extra: 1 }, { mode: 'index', offset: 0, terminal: true },
  ]) {
    assert.equal(validProjectDashboardReadArguments('dashboard_factgraph', bad, false), false);
  }
});

test('M-07 ProjectService dashboard view streams 3157 facts and 8616 edges via paginated index on size_limit and loads proof on demand', managed, async t => {
  const scale = buildScaleGraph(3157, 8616);
  let asOf = 'b'.repeat(64);
  let driftedOnce = false;
  const indexCalls = [], factCalls = [], frameSizes = [];
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hana-math-m07-pkg-')));
  await fs.mkdir(path.join(root, 'dependencies/python/bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'dependencies/python/bin/python3'), '#!/bin/sh\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'dependencies/runtime.json'), JSON.stringify({
    schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3',
  }));
  for (const rel of ['runtime/research_entry.py', 'runtime/research_read_frame.py', 'engine/src/hana_math_engine/research.py']) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), '# fixture\n');
  }
  let appCore;
  const f = await fixture(t, { multiWorker: true, createCore: options => appCore.createCore(options) });
  appCore = createAppResearchCore(f.sdk, { packageRoot: root });
  t.after(async () => { await appCore.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const receipts = new Map();
  f.sdk.runtime = {
    async start(input) {
      const file = name => path.join(input.cwd, `${name}.frame`);
      const state = await fs.readFile(file('state'));
      const length = state.readUInt32BE(33);
      const request = JSON.parse((await fs.readFile(file('request'))).subarray(0, length));
      assert.equal(request.operation, 'dashboard_factgraph');
      const args = request.arguments;
      let envelope;
      if (!args.mode) {
        envelope = { schemaVersion: 1, requestId: request.requestId, ok: false, error: { code: 'size_limit', message: 'dashboard fact index exceeds 2048 facts' } };
      } else if (args.mode === 'index') {
        indexCalls.push(args);
        if (!driftedOnce && args.offset === 512) {
          driftedOnce = true;
          asOf = 'c'.repeat(64);
          envelope = { schemaVersion: 1, requestId: request.requestId, ok: false, error: { code: 'fact_page_changed', message: 'factgraph observation changed' } };
        } else {
          const offset = args.offset ?? 0, limit = args.limit ?? 512;
          const slice = scale.nodes.slice(offset, offset + limit);
          const next = offset + slice.length;
          const hasMore = next < scale.nodes.length;
          envelope = {
            schemaVersion: 1, requestId: request.requestId, ok: true,
            result: {
              projectId: request.context.projectId, asOf,
              page: {
                nodes: slice, max_depth: scale.maxDepth, total_nodes: scale.nodes.length,
                total_edges: scale.edgesCount, offset, returned: slice.length,
                has_more: hasMore, next_offset: hasMore ? next : null,
              },
            },
          };
        }
      } else if (args.mode === 'fact') {
        factCalls.push(args);
        const n = scale.nodes.find(x => x.id === args.factId);
        envelope = {
          schemaVersion: 1, requestId: request.requestId, ok: true,
          result: {
            projectId: request.context.projectId, asOf,
            fact: {
              id: n.id, author: n.author, problem_id: request.context.projectId,
              statement: `Full statement for ${n.id}`, proof: `Complete proof for ${n.id}`,
              intuition: `Intuition for ${n.id}`, predecessors: n.predecessors, depth: n.depth,
            },
          },
        };
      } else {
        throw new Error(`unexpected args ${JSON.stringify(args)}`);
      }
      const body = Buffer.from(JSON.stringify(envelope));
      assert.ok(body.length <= (1 << 20), `IPC envelope exceeded 1 MiB: ${body.length}`);
      frameSizes.push(body.length);
      const resultFrame = Buffer.alloc(1 << 20);
      body.copy(resultFrame);
      state[8] = 3; state.writeUInt32BE(body.length, 33);
      sha(body).copy(state, 37); sha(state.subarray(0, 69)).copy(state, 69);
      await fs.writeFile(file('result'), resultFrame);
      await fs.writeFile(file('state'), state);
      const receipt = { runtimeId: request.requestId, state: 'exited', exitCode: 0, runtime: 'command', profile: 'scoped', network: 'none' };
      receipts.set(request.requestId, receipt);
      return receipt;
    },
    async get(runtimeId) { return receipts.get(runtimeId); },
    watch() { assert.fail('no watch with exited fixture'); },
    stop() { assert.fail('no stop with exited fixture'); },
  };
  const p = await f.create();
  const reader = await f.service.authorizeDashboardView({ projectId: p.projectId }, origin);

  const graph = await reader({ view: 'factgraph' }, () => true);
  assert.equal(graph.nodes.length, 3157);
  assert.equal(graph.edges.length, 8616);
  assert.equal(graph.max_depth, scale.maxDepth);
  assert.equal(graph.detailOnDemand, true);
  assert.equal(graph.nodes[0].detailLoaded, false);
  // 2 pages before drift + 7 pages on retry = 9 index calls.
  assert.equal(indexCalls.length, 2 + Math.ceil(3157 / 512));
  assert.ok(frameSizes.every(sz => sz <= (1 << 20)));

  const targetId = scale.ids[1234];
  const detail = await reader({ view: 'fact', factId: targetId }, () => true);
  assert.equal(detail.id, targetId);
  assert.equal(detail.proof, `Complete proof for ${targetId}`);
  assert.deepEqual(detail.predecessors, scale.nodes[1234].predecessors);
  assert.equal(factCalls.length, 1);
});

test('M-07 workspace routes and monitor enforce strict factId validation and generation checks on /api/fact/:factId', async () => {
  const fid = '0123456789abcdef';
  assert.deepEqual(dashboardSelection(`/api/fact/${fid}`), { view: 'fact', factId: fid });
  assert.equal(dashboardSelection('/api/fact/not-a-hex-id'), undefined);
  assert.equal(dashboardSelection('/api/fact/0123456789abcdef/extra'), undefined);

  const handlers = new Map();
  const scope = { state: 'active', projectId: 'project-m07', generation: 'gen-1' };
  const stamp = Object.freeze({
    appId: 'hana-math', agentId: null, document: null,
    principal: Object.freeze({ appId: 'hana-math', kind: 'app', credentialKind: 'app_surface_session', connectionKind: 'local', credentialId: 'sess-1' }),
  });
  registerWorkspaceDashboardRoutes({ get(path, h) { handlers.set(path, h); } }, {
    current: () => scope,
    read: async (selection, gen) => {
      if (gen !== scope.generation) return { state: 'unavailable' };
      if (selection.view === 'fact') return { id: selection.factId, author: 'worker-1', problem_id: 'project-m07', statement: 'S', proof: 'P', intuition: '', predecessors: [], depth: 0 };
      if (selection.view === 'overview') return { channel_counts: {}, facts_by_author: {}, verdicts: {} };
      return { nodes: [], edges: [], max_depth: 0 };
    },
  });
  const factHandler = handlers.get('/workspace-monitor/api/fact/:factId');
  assert.ok(factHandler);
  const send = (pathname, headers = { 'x-hana-math-monitor-generation': 'gen-1' }) => factHandler({
    req: { raw: new Request(`http://fixture.invalid${pathname}`, { headers }) },
    get: () => stamp,
  });
  const okRes = await send(`/workspace-monitor/api/fact/${fid}`);
  assert.equal(okRes.status, 200);
  assert.equal((await okRes.json()).proof, 'P');
  assert.equal((await send('/workspace-monitor/api/fact/bad')).status, 400);
  assert.equal((await send(`/workspace-monitor/api/fact/${fid}`, { 'x-hana-math-monitor-generation': 'stale' })).status, 409);

  // Monitor readFact succeeds for current scope and rejects invalid factIds.
  const listeners = new Map();
  const stub = { hidden: false, addEventListener: (k, fn) => listeners.set(k, fn), removeEventListener() {} };
  const monitor = createWorkspaceMonitor({
    ready: async () => {},
    fetch: async (url, init) => {
      if (url === '/workspace-monitor/current') return Response.json(scope);
      if (url === '/workspace-monitor/api/overview') return Response.json({ channel_counts: {}, facts_by_author: {}, verdicts: {} });
      if (url.startsWith('/workspace-monitor/api/fact/')) return send(url, init.headers);
      return new Response(null, { status: 404 });
    },
  }, { clear() {}, render() {}, status() {}, graphValidated() {} }, { visibility: stub, lifecycle: stub, interval: 60000 });
  await new Promise(r => setImmediate(r));
  const loaded = await monitor.readFact(fid);
  assert.equal(loaded.id, fid);
  assert.equal(loaded.proof, 'P');
  await assert.rejects(monitor.readFact('bad-id'));
  monitor.dispose();
});

test('M-07 collectProjectGraph supports 3157 facts and 8616 edges within updated 4096-fact cap', async () => {
  assert.ok(GRAPH_FACT_LIMIT >= 3157 && GRAPH_EDGE_LIMIT >= 8616);
  const scale = buildScaleGraph(3157, 8616);
  const rows = scale.nodes.map(n => ({ fact_id: n.id, predecessors: n.predecessors }));
  const snapshot = await collectProjectGraph({
    projectId: 'project-m07',
    now: () => 123456,
    changed: () => false,
    readPage: async options => ({ projectId: 'project-m07', ...fixtureFactPage(rows, options, 'project-m07') }),
  });
  assert.equal(snapshot.facts.length, 3157);
  assert.equal(snapshot.facts.reduce((sum, f) => sum + f.predecessors.length, 0), 8616);
});
