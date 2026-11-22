// B3 software fixture derived from the frozen B2 test, without importing or changing its assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fixture, origin, defer } from './project-service-fixture.mjs';
import { fixtureFactPage } from '../fact-page-fixture.mjs';
import { createResearchRuntime } from '../../packages/hana-math/runtime/research-runtime.mjs';
import { registerMathResearch } from '../../packages/hana-math/research-tools.mjs';

const factId = 'a'.repeat(16), fact = { fact_id: factId, predecessors: [], markdown: `---\nfact_id: ${factId}\npredecessors: []\nexternal_refs: []\n---\n## statement\nOpaque.\n## proof\nOpaque.\n` };
const planner = `%%%PREAMBLE%%%\nPREAMBLE\n%%%FRONTMATTER%%%\nFRONT\n%%%SECTIONS%%%\n[{"title":"Opaque","label":"sec:opaque","fact_ids":["${factId}"]}]\n%%%BIBLIOGRAPHY%%%\nBIB\n`;
const methodNames = ['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection'];
async function registered(t, f, projects = f.service) {
  const unused = async () => assert.fail('Not a worker/legacy call');
  const research = Object.fromEntries(methodNames.map(k => [k, unused])); let tool;
  const sdk = { ...f.sdk, tools: { async register(def) { if (def.name === 'math_project') tool = def; return () => {}; } } };
  const registration = await registerMathResearch(sdk, research, projects); t.after(() => registration.dispose());
  return input => tool.execute({ ...input, context: origin });
}
export async function pairingFixture(t, { plannerOutput = planner, sectionOutput = () => '\\section{Opaque}\\label{sec:opaque}\nOpaque.\n' } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-ipc-test-install-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries({ 'dependencies/python/bin/python3': 'not executed', 'runtime/research_entry.py': '# fixture',
    'engine/src/hana_math_engine/research.py': '# fixture', 'dependencies/runtime.json': JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' }) })) {
    const dest = path.join(base, rel); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, content, { mode: 0o700 });
  }
  const reads = [], receipts = new Map(), writers = [], stops = [], writes = [], state = { onStart: null, onGet: null, getError: null, onMeta: null, onDone: null, onArtifact: null, facadeReply: null };
  let f;
  f = await fixture(t, { multiWorker: true, createCore: options => createResearchRuntime(f.sdk, { ...options, packageRoot: base, platform: 'darwin', arch: 'arm64' }),
    summaryWriter: { async start(input) {
      assert.ok(['paper-plan', 'paper-section'].includes(input.kind)); const section = input.kind === 'paper-section'; writers.push(input.reportId);
      const model = { provider: 'fixture', id: 'fixture-verifier' };
      const binding = { role: 'report-writer', agentId: `math-paper-${section ? 'section-writer' : 'planner'}-01234567-89ab-cdef-0123-456789abcdef`,
        sessionId: 'fixture-plan-' + writers.length, sessionPath: '/fixture/' + input.reportId + '.jsonl', cwd: input.cwd, kind: `math-${input.kind}:${input.projectId}:${input.reportId}`, model, sendState: 'accepted', sendPending: false };
      f.host.set(binding.sessionPath, { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', lifecycle: 'active' });
      if (!f.agents.some(a => a.id === binding.agentId)) f.agents.push({ id: binding.agentId, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'math-report-writer' } });
      await input.onBound(binding);
      const terminal = { ...binding, state: 'completed', modelStopReason: 'stop', cleanupPending: false, finalText: section ? sectionOutput(input) : plannerOutput, toolSelection: { requested: [], resolved: [], effective: 'current', pendingToolNames: null } };
      const done = Promise.resolve().then(async () => { await state.onDone?.(input); return terminal; });
      done.catch(() => {}); // A writer handle may settle while the caller is still checking its binding.
      return { done, async stop() { stops.push(input.reportId); return terminal; } };
    }, async dispose() { return { cleanupPending: false }; } } });
  f.sdk.runtime = { async start(input) {
    const req = JSON.parse(await fs.readFile(input.args[4], 'utf8')); reads.push(req);
    assert.equal(f.tasks.get(input.taskId)?.scope, 'app'); assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none');
    await state.onStart?.(req);
    const result = req.operation === 'fact_get' ? fact : fixtureFactPage([fact], req.arguments, req.context.projectId);
    const reply = state.facadeReply ? await state.facadeReply(req, result) : { ok: true, result };
    await fs.writeFile(input.args[5], JSON.stringify({ schemaVersion: 1, requestId: req.requestId, ...reply }), { mode: 0o600 });
    const receipt = { runtimeId: req.requestId, state: 'exited', exitCode: 0, runtime: 'command', profile: 'scoped', network: 'none' };
    receipts.set(receipt.runtimeId, { receipt, req }); return receipt;
  }, async get(id) { const row = receipts.get(id); await state.onGet?.(row.req); if (state.getError) throw state.getError; return row.receipt; },
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
  f.sdk.resources = { async stage() { assert.fail('No stage in failed-report read/stop'); } };
  const reports = path.join(f.dataDir, 'research/projects', projectId, 'reports'), history = path.join(f.dataDir, 'research/core-calls', 'retained-fixture');
  await fs.mkdir(history, { recursive: true });
  const markerPath = path.join(history, '.complete'), unsafe = path.join(history, 'unsafe');
  async function marker(kind = 'marker') {
    await fs.unlink(unsafe).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await fs.writeFile(markerPath, kind === 'marker' ? 'fixture-bad-marker' : '', { mode: 0o600 });
    if (kind === 'unsafe') await fs.symlink('.complete', unsafe);
  }
  const rename = fs.rename, open = fs.open;
  const hook = t.mock.method(fs, 'rename', async (a, b) => {
    if (path.dirname(path.dirname(b)) !== reports || path.basename(b) !== 'metadata.json') return rename(a, b);
    const m = JSON.parse(await fs.readFile(a, 'utf8')); await rename(a, b); writes.push(m); await state.onMeta?.(m);
  });
  const artifactHook = t.mock.method(fs, 'open', async (p, ...args) => {
    if (typeof p === 'string' && path.dirname(path.dirname(p)) === reports) await state.onArtifact?.(p);
    return open(p, ...args);
  });
  syncBuiltinESMExports(); t.after(() => { hook.mock.restore(); artifactHook.mock.restore(); syncBuiltinESMExports(); });
  const request = q => ({ projectId, reportId: q.reportId });
  const metadata = id => fs.readFile(path.join(reports, id, 'metadata.json'), 'utf8').then(JSON.parse);
  const argsFor = async kind => kind === 'plan' ? plan : { projectId, planReportId: (await parent()).reportId };
  const findSchedule = id => [...f.schedules.values()].find(row => row.payload?.reportId === id);
  const dispatch = id => { const row = findSchedule(id); assert.ok(row); return f.handlers.get('math-project-report').run({ kind: 'schedule', scheduleId: row.scheduleId, input: row.payload }); };
  async function counts() {
    const dirs = await fs.readdir(reports).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    return { reportDirs: dirs.sort(), reportTasks: f.calls.tasks.filter(x => x.scope === 'session' && x.handlerKey === 'math-project-report').length,
      coreTasks: f.calls.tasks.filter(x => x.scope === 'app' && typeof x.metadata?.controlId === 'string').length,
      schedules: f.calls.schedules.length, writers: writers.length, runtimeStarts: reads.length, stops: stops.length };
  }
  return { f, projectId, plan, parent, marker, execute, state, counts, reports, request, metadata, argsFor, findSchedule, dispatch, reads, writes, stops };
}
