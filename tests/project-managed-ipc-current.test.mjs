// Software-only: actual tool, Project, FIFO, CoreAccess and runtime; no executed Python/Host/model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
import { fixtureFactPage } from './fact-page-fixture.mjs';
import { createResearchRuntime } from '../packages/hana-math/runtime/research-runtime.mjs';
import { projectCoreManagedIpcRefusal } from '../packages/hana-math/project-core-access.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';

const CAPACITY = 'RESEARCH_RUNTIME_CAPACITY', expected = { source: 'current', category: 'invalid-completion-marker' };
const factId = 'a'.repeat(16), fact = { fact_id: factId, predecessors: [], markdown: `---\nfact_id: ${factId}\npredecessors: []\nexternal_refs: []\n---\n## statement\nOpaque.\n## proof\nOpaque.\n` };
const planner = `%%%PREAMBLE%%%\nPREAMBLE\n%%%FRONTMATTER%%%\nFRONT\n%%%SECTIONS%%%\n[{"title":"Opaque","label":"sec:opaque","fact_ids":["${factId}"]}]\n%%%BIBLIOGRAPHY%%%\nBIB\n`;
const fault = code => Object.assign(new Error('fixture'), { code });
const capture = promise => promise.then(() => assert.fail('Expected rejection'), error => error);
const methodNames = ['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection'];
async function registered(t, f, projects = f.service) {
  const unused = async () => assert.fail('Not a worker/legacy call');
  const research = Object.fromEntries(methodNames.map(k => [k, unused])); let tool;
  const sdk = { ...f.sdk, tools: { async register(def) { if (def.name === 'math_project') tool = def; return () => {}; } } };
  const registration = await registerMathResearch(sdk, research, projects); t.after(() => registration.dispose());
  return input => tool.execute({ ...input, context: origin });
}
async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-ipc-test-install-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries({ 'dependencies/python/bin/python3': 'not executed', 'runtime/research_entry.py': '# fixture',
    'engine/src/hana_math_engine/research.py': '# fixture', 'dependencies/runtime.json': JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' }) })) {
    const dest = path.join(base, rel); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, content, { mode: 0o700 });
  }
  const reads = [], receipts = new Map(), writers = [], state = { onStart: null, getError: null };
  let f;
  f = await fixture(t, { multiWorker: true, createCore: options => createResearchRuntime(f.sdk, { ...options, packageRoot: base, platform: 'darwin', arch: 'arm64' }),
    summaryWriter: { async start(input) {
      assert.equal(input.kind, 'paper-plan'); writers.push(input.reportId);
      const model = { provider: 'fixture', id: 'fixture-verifier' };
      const binding = { role: 'report-writer', agentId: 'math-paper-planner-01234567-89ab-cdef-0123-456789abcdef',
        sessionId: 'fixture-plan-' + writers.length, sessionPath: '/fixture/' + input.reportId + '.jsonl', cwd: input.cwd, kind: `math-paper-plan:${input.projectId}:${input.reportId}`, model, sendState: 'accepted', sendPending: false };
      f.host.set(binding.sessionPath, { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', lifecycle: 'active' });
      f.agents.push({ id: binding.agentId, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'math-report-writer' } });
      await input.onBound(binding);
      const terminal = { ...binding, state: 'completed', modelStopReason: 'stop', cleanupPending: false, finalText: planner, toolSelection: { requested: [], resolved: [], effective: 'current', pendingToolNames: null } };
      return { done: Promise.resolve(terminal), async stop() { return terminal; } };
    }, async dispose() { return { cleanupPending: false }; } } });
  f.sdk.runtime = { async start(input) {
    const req = JSON.parse(await fs.readFile(input.args[4], 'utf8')); reads.push(req);
    assert.equal(f.tasks.get(input.taskId)?.scope, 'app'); assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none');
    await state.onStart?.(req);
    const result = req.operation === 'fact_get' ? fact : fixtureFactPage([fact], req.arguments, req.context.projectId);
    await fs.writeFile(input.args[5], JSON.stringify({ schemaVersion: 1, ok: true, requestId: req.requestId, result }), { mode: 0o600 });
    const receipt = { runtimeId: req.requestId, state: 'exited', exitCode: 0, runtime: 'command', profile: 'scoped', network: 'none' };
    receipts.set(receipt.runtimeId, receipt); return receipt;
  }, async get(id) { if (state.getError) throw state.getError; return receipts.get(id); },
  async watch() { assert.fail('No watch for exited runtime'); }, async stop() { assert.fail('No stop for exited runtime'); } };
  const p = await f.create(), projectId = p.projectId;
  await f.service.finalize({ projectId, factIds: [factId] }, origin);
  const plan = { projectId, brief: 'Opaque brief' }, execute = await registered(t, f);
  async function parent() {
    const q = await f.service.paperPlan(plan, origin);
    const event = [...f.schedules.values()].find(row => row.payload?.reportId === q.reportId); assert.ok(event);
    await f.handlers.get('math-project-report').run({ kind: 'schedule', scheduleId: event.scheduleId, input: event.payload });
    assert.equal((await f.service.paperPlanStatus({ projectId, reportId: q.reportId }, origin)).publicationStatus, 'reviewable-plan'); return q;
  }
  const reports = path.join(f.dataDir, 'research/projects', projectId, 'reports'), history = path.join(f.dataDir, 'research/core-calls', 'retained-fixture');
  await fs.mkdir(history, { recursive: true });
  const marker = bad => fs.writeFile(path.join(history, '.complete'), bad ? 'fixture-bad-marker' : '', { mode: 0o600 });
  async function counts() {
    const dirs = await fs.readdir(reports).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    return { reportDirs: dirs.sort(), reportTasks: f.calls.tasks.filter(x => x.scope === 'session' && x.handlerKey === 'math-project-report').length,
      coreTasks: f.calls.tasks.filter(x => x.scope === 'app' && typeof x.metadata?.controlId === 'string').length,
      schedules: f.calls.schedules.length, writers: writers.length, runtimeStarts: reads.length };
  }
  return { f, projectId, plan, parent, marker, execute, state, counts, reports };
}
function errorOf(out, code, diagnostic = undefined) {
  assert.equal(out.isError, true); assert.deepEqual(JSON.parse(out.content[0].text), out.details);
  assert.equal(out.details.error.code, code);
  if (diagnostic) assert.deepEqual(out.details.error.managedIpcRefusal, diagnostic);
  else assert.equal(Object.hasOwn(out.details.error, 'managedIpcRefusal'), false);
  return out.details.error;
}
for (const action of ['paper_plan', 'paper_section']) test(`${action} exposes current pre-record IPC refusal from the full creator tool path`, async t => {
  const g = await setup(t), args = action === 'paper_plan' ? g.plan : { projectId: g.projectId, planReportId: (await g.parent()).reportId };
  const before = await g.counts(); await g.marker(true);
  const out = await g.execute({ action, ...args });
  const after = await g.counts(); assert.deepEqual(after, { ...before, coreTasks: before.coreTasks + 1 });
  assert.equal([...g.f.tasks.values()].at(-1).status, 'failed');
  const error = errorOf(out, CAPACITY, expected); assert.equal(error.runtime.startOutcome, 'not-attempted');
  assert.deepEqual(Object.keys(error.managedIpcRefusal).sort(), ['category', 'source']);
});

test('old wrappers, SDK same-code refusals, ordinary actions and generic tool errors have no current projection', async t => {
  const g = await setup(t), parent = await g.parent(); await g.marker(true);
  const prior = g.f.service.paperPlan(g.plan, origin), stale = await capture(prior);
  assert.equal(projectCoreManagedIpcRefusal(stale), expected.category, 'use the actual A-branded wrapper');
  const oldLookup = g.f.service.paperStartIpcRefusal?.(prior, stale) ?? null;
  assert.equal(g.f.service.paperStartIpcRefusal?.(prior.catch(() => {}), stale) ?? null, null);
  for (const action of ['paper', 'paper_subgraph', 'result']) {
    const args = action === 'paper' ? g.plan : { projectId: g.projectId };
    errorOf(await g.execute({ action, ...args }), CAPACITY);
  }
  await g.marker(false);
  g.state.getError = fault(CAPACITY);
  const sdk = errorOf(await g.execute({ action: 'paper_plan', ...g.plan }), CAPACITY); assert.equal(sdk.runtime.startOutcome, 'acknowledged'); g.state.getError = null;
  const list = g.f.sdk.sessions.list; g.f.sdk.sessions.list = async () => { throw stale; };
  try { errorOf(await g.execute({ action: 'paper_plan', ...g.plan }), CAPACITY); }
  finally { g.f.sdk.sessions.list = list; }
  const open = fs.open, readPath = path.join(g.reports, parent.reportId, 'raw-response.txt'); let injected = 0;
  const hook = t.mock.method(fs, 'open', async (p, ...args) => { if (p === readPath) { injected++; throw stale; } return open(p, ...args); });
  syncBuiltinESMExports(); // The real context store uses the named fs/promises namespace.
  try { errorOf(await g.execute({ action: 'paper_section', projectId: g.projectId, planReportId: parent.reportId }), CAPACITY); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, 1);
  const unrelated = await registered(t, g.f, { ...g.f.service, async paperPlan() { throw stale; } });
  errorOf(await unrelated({ action: 'paper_plan', ...g.plan }), CAPACITY);
  assert.equal(oldLookup, expected.category);
});

// Observe the real queue timer installation; never assume the pump's caller owns a later slot.
function observeQueue(t) {
  const installed = [], waiting = [], original = globalThis.setTimeout;
  const hook = t.mock.method(globalThis, 'setTimeout', function (fn, ms, ...args) {
    const timer = original(fn, ms, ...args);
    if (ms === 10000 && typeof fn === 'function' && Function.prototype.toString.call(fn).includes('PROJECT_CORE_QUEUE_TIMEOUT')) {
      installed.push({ expired: () => fn() }); waiting.shift()?.resolve();
    }
    return timer;
  });
  return { async next() { while (!installed.length) { const gate = defer(); waiting.push(gate); await gate.promise; } return installed.shift(); }, restore() { hook.mock.restore(); } };
}

test('a different caller pumps both queued creator reads; only the dispatched IPC refusal is current', { timeout: 15000 }, async t => {
  const g = await setup(t); await g.marker(true); const stale = await capture(g.f.service.paperPlan(g.plan, origin)); await g.marker(false);
  assert.equal(projectCoreManagedIpcRefusal(stale), expected.category);
  const entered = defer(), release = defer(); let starts = 0;
  g.state.onStart = async () => { if (++starts === 1) { entered.resolve(); await release.promise; } };
  const queue = observeQueue(t);
  const blocker = g.f.service.result({ projectId: g.projectId }, origin);
  let a, b; const list = g.f.sdk.sessions.list;
  try {
    await queue.next(); await entered.promise;
    a = g.execute({ action: 'paper_plan', ...g.plan }); await queue.next();
    b = g.execute({ action: 'paper_plan', ...g.plan }); await queue.next();
    await g.marker(true); let pumpedAuth = 0;
    g.f.sdk.sessions.list = async (...args) => { if (++pumpedAuth === 2) throw stale; return list(...args); };
    const before = await g.counts(); release.resolve(); await blocker;
    const resultA = await a, resultB = await b;
    assert.equal(pumpedAuth, 2); assert.deepEqual(await g.counts(), { ...before, coreTasks: before.coreTasks + 1 });
    errorOf(resultB, CAPACITY); errorOf(resultA, CAPACITY, expected);
  } finally { release.resolve(); queue.restore(); g.f.sdk.sessions.list = list; await Promise.allSettled([blocker, a, b]); }
});

test('expired queued read with late SDK auth replay cannot dispatch or attach a current refusal', { timeout: 15000 }, async t => {
  const g = await setup(t); await g.marker(true); const stale = await capture(g.f.service.paperPlan(g.plan, origin));
  assert.equal(projectCoreManagedIpcRefusal(stale), expected.category);
  const queue = observeQueue(t), entered = defer(), late = defer(); let auth = 0;
  const list = g.f.sdk.sessions.list;
  g.f.sdk.sessions.list = async (...args) => { if (++auth === 3) { entered.resolve(); await late.promise; throw stale; } return list(...args); };
  const original = await g.counts(), pending = g.execute({ action: 'paper_plan', ...g.plan });
  try {
    const ticket = await queue.next(); await entered.promise; ticket.expired();
    errorOf(await pending, 'PROJECT_CORE_QUEUE_TIMEOUT'); assert.deepEqual(await g.counts(), original);
    g.f.sdk.sessions.list = list;
    const next = g.execute({ action: 'paper_plan', ...g.plan }); await queue.next(); late.resolve();
    const fresh = await next; assert.deepEqual(await g.counts(), { ...original, coreTasks: original.coreTasks + 1 });
    errorOf(fresh, CAPACITY, expected);
  } finally { late.resolve(); queue.restore(); g.f.sdk.sessions.list = list; await pending; }
});
