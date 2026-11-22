// B2 actual Project/Core-FIFO/report wiring; software Host/writer only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
const fid = n => n.toString(16).padStart(16, '0');
const fact = n => ({ fact_id: fid(n), predecessors: n === 1 ? [] : [fid(1)], markdown: `---\nfact_id: ${fid(n)}\npredecessors: [${n === 1 ? '' : fid(1)}]\nexternal_refs: []\n---\n## statement\nSTATEMENT_${n}_PRIVATE\n## proof\nPROOF_${n}_PRIVATE\n` });
const planner = `%%%PREAMBLE%%%\nPREAMBLE_PRIVATE\n%%%FRONTMATTER%%%\nFRONT_PRIVATE\n%%%SECTIONS%%%\n[{"title":"First","label":"sec:first","fact_ids":["${fid(1)}"]},{"title":"Second","label":"sec:second","fact_ids":["${fid(2)}"]}]\n%%%BIBLIOGRAPHY%%%\nBIB_PRIVATE\n`;
async function setup(t) {
  const state = { facts: new Map([1, 2].map(n => [fid(n), fact(n)])), starts: [], stages: [], onCore: null, beforeBound: null, onTerminal: null, boundReads: 0, binding: null, q: null, inBound: false };
  let f, dir;
  f = await fixture(t, { multiWorker: true, async coreCall(_binding, op, args) {
    await state.onCore?.(op, args);
    if (op === 'fact_list_page') { if (state.inBound) { const m = JSON.parse(await fs.readFile(path.join(dir, state.q.reportId, 'metadata.json'))); assert.equal(m.writer.sessionId, state.binding.sessionId); state.boundReads++; } return { facts: [...state.facts.values()] }; }
    assert.equal(op, 'fact_get', 'section admission/runtime never mutates canonical data'); return structuredClone(state.facts.get(args.fact_id));
  }, summaryWriter: { async start(input) {
    state.starts.push(input); const section = input.kind === 'paper-section', binding = { role: 'report-writer', sessionId: (section ? 'section-' : 'planner-') + state.starts.length,
      agentId: `math-paper-${section ? 'section-writer' : 'planner'}-01234567-89ab-cdef-0123-456789abcdef`, sessionPath: `/fixture/writer-${state.starts.length}.jsonl`, cwd: input.cwd,
      kind: `math-${input.kind}:${input.projectId}:${input.reportId}`, sendState: 'accepted', sendPending: false };
    state.binding = binding; state.q = { reportId: input.reportId };
    f.host.set(binding.sessionPath, { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', lifecycle: 'active' });
    if (!f.agents.some(a => a.id === binding.agentId)) f.agents.push({ id: binding.agentId, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'math-report-writer' } });
    await state.beforeBound?.(input); state.inBound = section; await input.onBound(binding); state.inBound = false;
    const terminal = { ...binding, state: 'completed', modelStopReason: 'stop', cleanupPending: false,
      finalText: section ? '\\section{Opaque}\\label{sec:opaque}\nBODY_PRIVATE\n' : planner };
    let latest; return { done: Promise.resolve().then(async () => { latest = terminal; await state.onTerminal?.(input); return terminal; }), async stop() { return latest ?? { ...binding, state: 'stopped', cleanupPending: false }; } };
  }, async dispose() { return { cleanupPending: false }; } } });
  f.sdk.resources = { async stage(input) { state.stages.push(input); return { resource: { kind: 'session-file', sessionId: 'creator-stable', fileId: 'section-file-' + state.stages.length } }; } };
  const old = f.sdk.sessions.context; f.sdk.sessions.context = async input => /^(section|planner)-/.test(input.sessionId) ? { sessionId: input.sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0 } : old(input);
  f.sdk.sessions.abort = async ({ sessionId }) => ({ sessionId, aborted: true });
  const p = await f.create(); dir = path.join(f.dataDir, 'research/projects', p.projectId, 'reports');
  await f.service.finalize({ projectId: p.projectId, factIds: [fid(2)] }, origin);
  const request = q => ({ projectId: p.projectId, reportId: q.reportId });
  const event = q => { const row = [...f.schedules.values()].find(s => s.payload?.reportId === q.reportId); assert.ok(row); return { kind: 'schedule', scheduleId: row.scheduleId, input: structuredClone(row.payload) }; };
  const dispatch = q => f.handlers.get('math-project-report').run(event(q));
  const parent = await f.service.paperPlan({ projectId: p.projectId, brief: 'Original archived brief' }, origin); await dispatch(parent); assert.equal((await f.service.paperPlanStatus(request(parent), origin)).state, 'completed'); state.starts.length = 0;
  return { f, p, state, parent, request, event, dispatch, dir, start: previous => f.service.paperSection({ projectId: p.projectId, planReportId: parent.reportId, ...(previous ? { previousSectionReportId: previous.reportId } : {}) }, origin),
    metadata: q => fs.readFile(path.join(dir, q.reportId, 'metadata.json'), 'utf8').then(JSON.parse), status: q => f.service.paperSectionStatus(request(q), origin), result: q => f.service.paperSectionResult(request(q), origin) };
}

test('B2 Project creator admission uses genuine Core authority and publication avoids target/FIFO re-entry', { timeout: 15000 }, async t => {
  const g = await setup(t), q = await g.start(); await g.dispatch(q); const s = await g.status(q), result = await g.result(q);
  assert.equal(s.state, 'completed'); assert.equal(s.publicationStatus, 'reviewable-section'); assert.ok(g.state.boundReads > 0); assert.equal(g.state.starts.length, 1); assert.equal(g.state.starts[0].kind, 'paper-section');
  assert.match(g.state.starts[0].prompt, /PROOF_1_PRIVATE/); assert.doesNotMatch(g.state.starts[0].prompt, /PROOF_2_PRIVATE|BIB_PRIVATE/);
  assert.deepEqual(g.state.stages.map(a => a.name), ['section.tex', 'SECTION_RESULT.json', 'REFERENCE_LEDGER.md']);
  for (const value of [s, result, g.f.tasks.get(q.taskId), await g.metadata(q)]) assert.doesNotMatch(JSON.stringify(value), /BODY_PRIVATE|PROOF_[12]_PRIVATE|"finalText"|"prompt":/);
  assert.equal(g.f.tasks.get(q.taskId).metadata.chainRootReportId, q.reportId);
  for (const name of ['paperPlanStatus', 'paperStatus', 'summaryStatus']) await assert.rejects(g.f.service[name](g.request(q), origin), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
});
for (const who of ['main', 'stranger']) test(`B2 Project section ${who} cannot start or read creator reports`, async t => {
  const g = await setup(t), before = g.f.calls.tasks.length, ctx = who === 'main' ? g.p.context : { sessionPath: '/fixture/stranger', callToken: 'fixture-token' };
  if (who === 'stranger') g.f.host.set(ctx.sessionPath, { sessionId: 'stranger', path: ctx.sessionPath, namespace: 'home', visibility: 'public', lifecycle: 'active' });
  for (const [name, args] of [['paperSection', { projectId: g.p.projectId, planReportId: g.parent.reportId }], ...['paperSectionStatus', 'paperSectionResult', 'paperSectionStop'].map(name => [name, g.request(g.parent)])]) await assert.rejects(g.f.service[name](args, ctx), { code: who === 'main' ? 'PROJECT_SUMMARY_DENIED' : 'PROJECT_OWNER_DENIED' });
  assert.equal(g.f.calls.tasks.length, before); assert.equal(g.state.starts.length, 0);
});
test('B2 Project snapshots selectors synchronously before creator authorization and rejects accessors/Proxy', async t => {
  const g = await setup(t), entered = defer(), release = defer(), list = g.f.sdk.sessions.list; let once = true;
  t.after(() => release.resolve()); g.f.sdk.sessions.list = async input => { if (once) { once = false; entered.resolve(); await release.promise; } return list(input); };
  const args = { projectId: g.p.projectId, planReportId: g.parent.reportId }, start = g.f.service.paperSection(args, origin); await entered.promise; args.planReportId = 'report-00000000-0000-0000-0000-000000000000'; release.resolve();
  const q = await start; assert.equal((await g.metadata(q)).section.source.planReportId, g.parent.reportId);
  let reads = 0; const getter = Object.defineProperty({ projectId: g.p.projectId }, 'planReportId', { enumerable: true, get() { reads++; return g.parent.reportId; } });
  await assert.rejects(g.f.service.paperSection(getter, origin), { code: 'PROJECT_INVALID_INPUT' }); await assert.rejects(g.f.service.paperSection(new Proxy(args, {}), origin), { code: 'PROJECT_INVALID_INPUT' }); assert.equal(reads, 0);
  await g.f.service.paperSectionStop(g.request(q), origin);
});
for (const phase of ['onBound', 'return', 'publication']) test(`B2 Project ${phase} detects task permission revocation and retains true writer identity`, { timeout: 15000 }, async t => {
  const g = await setup(t), q = await g.start(); let injected = false;
  const mutate = () => { if (injected) return; injected = true; const get = g.f.sdk.tasks.get; g.f.sdk.tasks.get = async id => { if (id === q.taskId) throw Object.assign(new Error('fixture denied'), { code: 'PERMISSION_DENIED' }); return get(id); }; };
  if (phase === 'onBound') g.state.beforeBound = mutate;
  if (phase === 'return') g.state.onTerminal = mutate;
  if (phase === 'publication') g.state.onCore = async op => { if (op === 'fact_list_page' && (await g.metadata(q)).artifacts?.response) mutate(); };
  await g.dispatch(q); const m = await g.metadata(q); assert.equal(injected, true); assert.equal(m.state, 'failed'); assert.equal(m.error, 'PERMISSION_DENIED'); assert.ok(m.writer.sessionId); assert.equal(g.state.stages.length, 0); assert.equal(m.artifacts?.source, undefined); assert.doesNotMatch(JSON.stringify(m), /"finalText"/);
});
test('B2 Project historical section remains readable after fresh fact/target drift; new successor refuses it', { timeout: 15000 }, async t => {
  const g = await setup(t), q = await g.start(); await g.dispatch(q); g.state.facts.get(fid(1)).markdown += '\nChanged proof.';
  assert.equal((await g.result(q)).status, 'ok'); const count = g.state.starts.length; await assert.rejects(g.start(q), { code: 'PROJECT_SUMMARY_FACT_REVOKED' }); assert.equal(g.state.starts.length, count);
});
for (const phase of ['queue', 'onBound', 'return']) test(`B2 Project ${phase} target replacement invalidates the frozen parent without FIFO deadlock`, { timeout: 15000 }, async t => {
  const g = await setup(t), q = await g.start(), binding = (await g.metadata(q)).section;
  const change = () => g.f.service.finalize({ projectId: g.p.projectId, factIds: [fid(1)] }, origin);
  if (phase === 'queue') await change(); if (phase === 'onBound') g.state.beforeBound = change; if (phase === 'return') g.state.onTerminal = change;
  await g.dispatch(q); const m = await g.metadata(q); assert.equal(m.state, 'failed'); assert.equal(m.error, 'PROJECT_TARGET_CHANGED'); assert.deepEqual(m.section, binding); assert.equal(g.state.stages.length, 0); assert.equal(m.artifacts?.source, undefined);
});
test('B2 Project predecessor from another plan cannot create a report or writer', { timeout: 15000 }, async t => {
  const g = await setup(t), root = await g.start(); await g.dispatch(root);
  const other = await g.f.service.paperPlan({ projectId: g.p.projectId, brief: 'Other independent parent' }, origin); await g.dispatch(other); const count = g.f.calls.tasks.length, writers = g.state.starts.length;
  await assert.rejects(g.f.service.paperSection({ projectId: g.p.projectId, planReportId: other.reportId, previousSectionReportId: root.reportId }, origin), { code: 'PROJECT_PAPER_SECTION_SOURCE_CHANGED' }); assert.equal(g.f.calls.tasks.length, count); assert.equal(g.state.starts.length, writers);
});
for (const phase of ['queue', 'onBound', 'return']) test(`B2 Project ${phase} rejects target replacement without lock reentry or recapture`, { timeout: 15000 }, async t => {
  const g = await setup(t), q = await g.start(), binding = (await g.metadata(q)).section;
  const replace = () => g.f.service.finalize({ projectId: g.p.projectId, factIds: [fid(1)] }, origin);
  if (phase === 'queue') await replace(); if (phase === 'onBound') g.state.beforeBound = replace; if (phase === 'return') g.state.onTerminal = replace;
  await g.dispatch(q); const m = await g.metadata(q); assert.equal(m.state, 'failed'); assert.equal(m.error, 'PROJECT_TARGET_CHANGED'); assert.deepEqual(m.section, binding); assert.equal(m.artifacts?.source, undefined); assert.equal(g.state.stages.length, 0);
});
