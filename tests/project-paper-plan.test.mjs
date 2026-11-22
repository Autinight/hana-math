// Actual Project/report/Core-FIFO wiring, software-only Host and planner. No live research.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
const id = n => n.toString(16).padStart(16, '0');
const fact = (n, predecessors = [], statement = true) => ({ fact_id: id(n), predecessors,
  markdown: `---\nfact_id: ${id(n)}\npredecessors: [${predecessors.join(', ')}]\nexternal_refs: [{"key":"K${n}","title":"REFERENCE_${n}","cited_for":"USE_${n}"}]\n---\n${statement ? '## statement\nSTATEMENT_' + n + '_SENTINEL\n' : '## opaque-ancestor\nUNSELECTED_ANCESTOR_SENTINEL\n'}## proof\nPROOF_${n}_SENTINEL\n` });
const output = '%%%PREAMBLE%%%\nPREAMBLE_SENTINEL\n%%%FRONTMATTER%%%\nFRONTMATTER_SENTINEL\n%%%SECTIONS%%%\n[{"title":"Opaque section","label":"sec:opaque","fact_ids":[]}]\n%%%BIBLIOGRAPHY%%%\nBIBLIOGRAPHY_SENTINEL\n';
async function setup(t, { target = true, headlines = false } = {}) {
  const facts = new Map(Array.from({ length: 10 }, (_, i) => { const f = fact(i + 1, headlines || !i ? [] : [id(i)]); return [f.fact_id, f]; }));
  facts.set(id(11), fact(11, [id(2)], false)); facts.set(id(12), fact(12, [id(11)]));
  const state = { facts, writer: [], stages: [], beforeCore: null, beforeBound: null, afterBound: null, onTerminal: null, phase: 'admission', boundGather: 0, started: defer(), outputGate: null, stopReceipt: null, stageFailure: 0 };
  let g;
  const f = await fixture(t, { multiWorker: true, async coreCall(_binding, operation, args) {
    await state.beforeCore?.(operation, args);
    if (state.phase === 'onBound' && operation === 'fact_list_page') {
      const meta = await g.metadata(state.q); assert.equal(meta.writer.sessionId, state.binding.sessionId, 'identity must be durable before onBound fresh gather'); state.boundGather++;
    }
    if (operation === 'fact_list_page') return { facts: [...facts.values()] };
    assert.equal(operation, 'fact_get', 'no canonical mutation or downstream operation'); const row = facts.get(args.fact_id);
    if (!row) throw Object.assign(new Error('unknown fixture fact'), { code: 'PROJECT_CORE_INVALID_RESULT' }); return structuredClone(row);
  }, summaryWriter: { async start(input) {
    state.writer.push(input); const binding = { role: 'report-writer', agentId: 'math-paper-planner-01234567-89ab-cdef-0123-456789abcdef',
      sessionId: `planner-${state.writer.length}`, sessionPath: `/fixture/planner-${state.writer.length}.jsonl`, cwd: input.cwd,
      kind: `math-paper-plan:${input.projectId}:${input.reportId}`, sendState: 'not-sent', sendPending: false };
    state.binding = binding; state.q = { reportId: input.reportId };
    f.host.set(binding.sessionPath, { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', lifecycle: 'active' });
    if (!f.agents.some(row => row.id === binding.agentId)) f.agents.push({ id: binding.agentId, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'math-report-writer' } });
    await state.beforeBound?.(input); state.phase = 'onBound'; await input.onBound(binding); state.phase = 'afterBound'; await state.afterBound?.(input); state.started.resolve();
    const terminal = { ...binding, state: 'completed', modelStopReason: 'stop', cleanupPending: false, finalText: output };
    const done = (state.outputGate ? state.outputGate.promise : Promise.resolve(terminal)).then(async value => { state.lastTerminal = value; state.phase = 'return'; await state.onTerminal?.(); return value; });
    // The real session's stop returns its latest record, including obtained raw
    // text when completion already won the race; do not erase it in the fake.
    return { done, async stop() { const stopped = { ...(state.lastTerminal ?? { ...binding, state: 'stopped', cleanupPending: false }), ...(state.stopReceipt ?? {}) }; state.outputGate?.resolve(stopped); return stopped; } };
  }, async dispose() { return { cleanupPending: false }; } } });
  const oldContext = f.sdk.sessions.context;
  f.sdk.sessions.context = async input => input.sessionId.startsWith('planner-') ? { sessionId: input.sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0 } : oldContext(input);
  f.sdk.sessions.abort = async ({ sessionId }) => { assert.match(sessionId, /^planner-/); return { sessionId, aborted: true }; };
  f.sdk.resources = { async stage(input) { state.stages.push(input); if (state.stages.length === state.stageFailure) throw Object.assign(new Error('stage fixture'), { code: 'HOST_UNAVAILABLE' });
    return { resource: { kind: 'session-file', fileId: 'fixture-file-' + state.stages.length, sessionId: 'creator-stable' } }; } };
  const p = await f.create(), headlinesIds = headlines ? Array.from({ length: 10 }, (_, i) => id(i + 1)) : [id(10)];
  if (target) await f.service.finalize({ projectId: p.projectId, factIds: headlinesIds }, origin);
  let runtime; const set = Map.prototype.set;
  const mock = t.mock.method(Map.prototype, 'set', function(key, value) { if (key === p.projectId && value?.targets instanceof Map) runtime = value; return set.call(this, key, value); });
  try { await f.open(); } finally { mock.mock.restore(); } assert.ok(runtime);
  const dir = path.join(f.dataDir, 'research/projects', p.projectId, 'reports'), args = { projectId: p.projectId, brief: 'BRIEF_PRIVATE_SENTINEL' };
  const request = q => ({ projectId: p.projectId, reportId: q.reportId });
  const metadataPath = q => path.join(dir, q.reportId, 'metadata.json');
  const event = q => { const row = [...f.schedules.values()].find(row => row.payload?.reportId === q.reportId); assert.ok(row); return { kind: 'schedule', scheduleId: row.scheduleId, input: structuredClone(row.payload) }; };
  g = { f, p, runtime, state, args, dir, request, metadataPath, metadata: async q => JSON.parse(await fs.readFile(metadataPath(q))),
    status: q => f.service.paperPlanStatus(request(q), origin), result: q => f.service.paperPlanResult(request(q), origin), stop: q => f.service.paperPlanStop(request(q), origin),
    dispatch: q => f.handlers.get('math-project-report').run(event(q)), event };
  return g;
}
const work = g => ({ reports: g.f.calls.tasks.filter(row => row.handlerKey === 'math-project-report').length, writers: g.state.writer.length, sessions: g.f.calls.sessions.length, sends: g.f.calls.sends.length });

test('M05 integration Project creator needs_target precedes canonical work, but own-data and brief limits remain strict', async t => {
  const g = await setup(t, { target: false }), before = work(g), core = g.f.calls.core.length;
  for (const brief of ['x'.repeat(32768), '界'.repeat(10922) + 'ab']) assert.equal((await g.f.service.paperPlan({ ...g.args, brief }, origin)).status, 'needs_target');
  for (const ids of [undefined, [], [id(99)]]) assert.deepEqual(await g.f.service.paperPlan({ ...g.args, ...(ids ? { factIds: ids } : {}), brief: 'headline_fact_ids: unknown\nstructural_exemplar: absent' }, origin), { projectId: g.p.projectId, paperId: 'main', status: 'needs_target' });
  for (const brief of ['', ' \r\n', '\ud800', '\0', 'x'.repeat(32769), '界'.repeat(10923)]) await assert.rejects(g.f.service.paperPlan({ ...g.args, brief }, origin), { code: 'PROJECT_INVALID_INPUT' });
  for (const extra of [{ model: {} }, { material: {} }, { factIds: [id(1), id(1)] }, { factIds: ['bad'] }, { factIds: Array.from({ length: 65 }, (_, i) => id(i + 1)) }]) await assert.rejects(g.f.service.paperPlan({ ...g.args, ...extra }, origin), { code: 'PROJECT_INVALID_INPUT' });
  let gets = 0; const raw = { ...g.args }; Object.defineProperty(raw, 'brief', { enumerable: true, get() { gets++; return 'bad'; } }); await assert.rejects(g.f.service.paperPlan(raw, origin), { code: 'PROJECT_INVALID_INPUT' });
  await assert.rejects(g.f.service.paperPlan(new Proxy(g.args, {}), origin), { code: 'PROJECT_INVALID_INPUT' }); assert.equal(gets, 0);
  assert.deepEqual(work(g), before); assert.equal(g.f.calls.core.length, core);
});
for (const target of [false, true]) for (const role of ['main', 'worker', 'other-creator']) test(`M05 integration Project denies ${role} before ${target ? 'present' : 'absent'} target disclosure`, async t => {
  const g = await setup(t, { target }), before = work(g), core = g.f.calls.core.length;
  const ctx = role === 'main' ? g.p.context : { callToken: 'fixture-token', sessionPath: '/fixture/' + role };
  if (role !== 'main') g.f.host.set(ctx.sessionPath, { path: ctx.sessionPath, sessionId: role, ownerPluginId: role === 'worker' ? 'hana-math' : null, namespace: role === 'worker' ? 'app' : 'home', visibility: role === 'worker' ? 'plugin_private' : 'public', lifecycle: 'active' });
  await assert.rejects(g.f.service.paperPlan(g.args, ctx), { code: role === 'main' ? 'PROJECT_SUMMARY_DENIED' : 'PROJECT_OWNER_DENIED' }); assert.deepEqual(work(g), before); assert.equal(g.f.calls.core.length, core);
});
for (const selection of ['omitted', 'empty', 'selected']) test(`M05 integration ten independent headlines allow ${selection} full coverage and only one planner`, { timeout: 10000 }, async t => {
  const g = await setup(t, { headlines: true }), before = work(g), ids = Array.from({ length: 10 }, (_, i) => id(i + 1));
  const q = await g.f.service.paperPlan({ ...g.args, ...(selection === 'omitted' ? {} : { factIds: selection === 'empty' ? [] : ids }) }, origin), capture = (await g.metadata(q)).plan;
  assert.deepEqual(capture.material.coverageFactIds, ids); assert.equal(capture.material.mode, selection === 'selected' ? 'selected' : 'target-closure'); await g.dispatch(q);
  const status = await g.status(q); assert.equal(status.state, 'completed'); assert.equal(status.coverageStatus, 'exact-once'); assert.deepEqual(status.coverage.factIds, ids);
  assert.ok(g.state.boundGather > 0, 'onBound fresh Core gather completed without target-lock reentry'); assert.equal(g.state.writer.length, 1); assert.equal(g.state.writer[0].kind, 'paper-plan');
  assert.equal(work(g).sessions, before.sessions); assert.equal(work(g).sends, before.sends);
  const names = await fs.readdir(path.join(g.dir, q.reportId)); assert.deepEqual(names.sort(), ['PLANNER_BLOCKS.json', 'REFERENCE_LEDGER.md', 'SECTION_PLAN.json', 'metadata.json', 'raw-response.txt'].sort());
  for (const method of ['paperStatus', 'summaryStatus']) await assert.rejects(g.f.service[method](g.request(q), origin), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
  const result = await g.result(q); assert.equal(result.status, 'ok'); assert.equal(result.publicationStatus, 'reviewable-plan'); assert.equal(result.sourceStatus, undefined); assert.equal(result.sectionOrdering, 'not-checked');
  const native = g.f.tasks.get(q.taskId); assert.equal(native.metadata.kind, 'paper-plan'); assert.equal(native.result.kind, 'paper-plan');
  for (const value of [status, result, native.metadata, native.result]) assert.doesNotMatch(JSON.stringify(value), /BRIEF_PRIVATE_SENTINEL|STATEMENT_\d+_SENTINEL|PROOF_\d+_SENTINEL|PREAMBLE_SENTINEL|"prompt":|"finalText":/);
});
test('M05 integration outside selection includes ancestor ledger but no unselected statements, proofs or parsing gates', async t => {
  const g = await setup(t), q = await g.f.service.paperPlan({ ...g.args, factIds: [id(12), id(10)] }, origin), captured = (await g.metadata(q)).plan; await g.dispatch(q);
  assert.equal((await g.status(q)).state, 'completed'); assert.deepEqual(captured.material.coverageFactIds, [id(10), id(12)]); assert.deepEqual(captured.material.outsideTargetFactIds, [id(12)]); assert.equal(captured.material.validationFactIds.length, 12);
  const prompt = g.state.writer[0].prompt; for (const n of [10, 12]) assert.match(prompt, new RegExp(`STATEMENT_${n}_SENTINEL`));
  assert.doesNotMatch(prompt, /STATEMENT_(?:[1-9]|11)_SENTINEL|PROOF_\d+_SENTINEL|UNSELECTED_ANCESTOR_SENTINEL/); assert.match(prompt, /REFERENCE_11/); assert.match(prompt, /USE_11/);
  assert.deepEqual((await g.status(q)).selection.warnings, ['PROJECT_PAPER_SELECTION_OUTSIDE_TARGET']); assert.deepEqual((await g.metadata(q)).plan, captured);
});
test('M05 integration request is snapshotted before first creator authorization await', async t => {
  const g = await setup(t), entered = defer(), release = defer(), list = g.f.sdk.sessions.list, ids = [id(10), id(12)], args = { ...g.args, instructions: 'ORIGINAL_INSTRUCTIONS', factIds: ids }; let held = false;
  t.after(() => release.resolve()); g.f.sdk.sessions.list = async input => { if (!held) { held = true; entered.resolve(); await release.promise; } return list(input); };
  const request = g.f.service.paperPlan(args, origin); await entered.promise; ids.pop(); args.brief = 'MUTATED_BRIEF'; args.instructions = 'MUTATED_INSTRUCTIONS'; args.paperId = 'unknown'; release.resolve();
  const q = await request, meta = await g.metadata(q); assert.equal(meta.plan.brief, 'BRIEF_PRIVATE_SENTINEL'); assert.equal(meta.plan.instructions, 'ORIGINAL_INSTRUCTIONS'); assert.equal(meta.plan.paperId, 'main'); assert.deepEqual(meta.plan.factIds, [id(10), id(12)]);
});
test('M05 integration brief conflicts, unsupported exemplar and omitted headline reject before report admission', async t => {
  const g = await setup(t, { headlines: true }), before = work(g);
  for (const [extra, code] of [[{ brief: 'headline_fact_ids: ' + id(1) }, 'PROJECT_PAPER_BRIEF_TARGET_CONFLICT'], [{ brief: 'structural_exemplar: outside' }, 'PROJECT_PAPER_EXEMPLAR_UNAVAILABLE'], [{ factIds: [id(10)] }, 'PROJECT_PAPER_HEADLINE_NOT_SELECTED']]) await assert.rejects(g.f.service.paperPlan({ ...g.args, ...extra }, origin), { code });
  assert.deepEqual(work(g), before);
});
for (const phase of ['queue', 'start', 'onBound', 'return', 'publication']) for (const change of ['fact', 'target', 'resource', 'permission']) test(`M05 integration ${phase} blocks ${change} drift without successful coverage`, { timeout: 15000 }, async t => {
  const g = await setup(t), q = await g.f.service.paperPlan(g.args, origin), captured = (await g.metadata(q)).plan; let injected = false, resourceChanged = false;
  const read = fs.readFile; t.mock.method(fs, 'readFile', async (name, ...rest) => { const bytes = await read(name, ...rest); return resourceChanged && name instanceof URL && name.pathname.endsWith('/roles/PAPER_PLANNER_PROMPT.md') ? bytes + '\nRESOURCE_DRIFT' : bytes; });
  const mutate = () => { if (injected) return; injected = true;
    if (change === 'fact') g.state.facts.get(id(1)).markdown += '\nChanged proof bytes.';
    if (change === 'target') g.runtime.targets.set('main', { ...g.runtime.targets.get('main'), at: 0 });
    if (change === 'resource') resourceChanged = true;
    if (change === 'permission') {
      const get = g.f.sdk.tasks.get;
      g.f.sdk.tasks.get = async taskId => { if (taskId === q.taskId) throw Object.assign(new Error('Host task read permission revoked'), { code: 'PERMISSION_DENIED' }); return get(taskId); };
    }
  };
  if (phase === 'queue') mutate();
  if (phase === 'start') g.state.beforeCore = async operation => { if (operation === 'fact_list_page') mutate(); };
  if (phase === 'onBound') g.state.beforeBound = mutate;
  if (phase === 'return') g.state.onTerminal = mutate;
  if (phase === 'publication') g.state.beforeCore = async operation => { if (operation === 'fact_list_page' && (await g.metadata(q)).artifacts?.blocks) mutate(); };
  await g.dispatch(q); const meta = await g.metadata(q); assert.equal(injected, true, 'named boundary was reached'); assert.equal(meta.state, 'failed', meta.error ?? `Unexpected ${meta.state}`); if (change === 'permission') assert.equal(meta.error, 'PERMISSION_DENIED'); assert.equal(g.state.stages.length, 0);
  assert.equal(g.state.writer.length, ['queue', 'start'].includes(phase) ? 0 : 1); assert.deepEqual(meta.plan, captured, 'drift cannot replace captured material, resources or prompt binding');
  if (['onBound', 'return', 'publication'].includes(phase)) assert.equal(meta.writer.sessionId, g.state.binding.sessionId, 'real identity remains after a failed recheck');
  if (['return', 'publication'].includes(phase)) { assert.ok(meta.artifacts.response); assert.equal(await fs.readFile(path.join(g.dir, q.reportId, 'raw-response.txt'), 'utf8'), output); }
  if (phase === 'publication') { assert.ok(meta.artifacts.blocks); assert.equal(meta.artifacts.plan, undefined); }
  const task = g.f.tasks.get(q.taskId); assert.notEqual(task.result?.coverageStatus, 'exact-once');
});
test('M05 integration predecessor drift also invalidates the full-text admission digest', async t => {
  const g = await setup(t), q = await g.f.service.paperPlan(g.args, origin), captured = (await g.metadata(q)).plan.material;
  g.state.facts.set(id(20), fact(20)); g.state.facts.set(id(1), fact(1, [id(20)])); await g.dispatch(q);
  const meta = await g.metadata(q); assert.equal(meta.state, 'failed'); assert.deepEqual(meta.plan.material, captured); assert.equal(g.state.writer.length, 0);
});
test('M05 integration late onBound after stop retains identity durably before refusing fresh work', async t => {
  const g = await setup(t), entered = defer(), release = defer(); t.after(() => release.resolve());
  g.state.beforeBound = async () => { entered.resolve(); await release.promise; };
  const q = await g.f.service.paperPlan(g.args, origin), run = g.dispatch(q); run.catch(() => {}); await entered.promise;
  const stopped = await g.stop(q); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.cleanupPending, true); release.resolve(); await run;
  const meta = await g.metadata(q); assert.equal(meta.writer.sessionId, g.state.binding.sessionId); assert.equal(meta.writer.agentId, g.state.binding.agentId); assert.equal(meta.writerStarting, true); assert.equal(meta.cleanupPending, true); assert.equal(meta.state, 'stopped'); assert.equal(g.state.stages.length, 0);
  assert.equal((await g.status(q)).coverageStatus, 'not-established');
});
test('M05 integration unknown running cleanup acknowledgement cannot become a clean stopped plan', async t => {
  const g = await setup(t); g.state.outputGate = defer(); g.state.stopReceipt = { cleanupPending: true };
  const q = await g.f.service.paperPlan(g.args, origin), run = g.dispatch(q); await g.state.started.promise;
  await g.stop(q); await run; const status = await g.status(q); assert.equal(status.state, 'stopped'); assert.equal(status.cleanupPending, true); assert.equal(status.coverageStatus, 'not-established'); assert.equal(g.state.stages.length, 0);
});
test('M05 integration recovered original queued nonce never replays and no current resource resampling is required', async t => {
  const g = await setup(t), q = await g.f.service.paperPlan(g.args, origin), event = g.event(q); g.state.facts.clear();
  const read = fs.readFile; t.mock.method(fs, 'readFile', async (name, ...rest) => { if (name instanceof URL && name.href.includes('/references/danus/')) assert.fail('Queued recovery resampled planner resources'); return read(name, ...rest); });
  await g.f.open(); assert.equal((await g.status(q)).state, 'interrupted'); assert.deepEqual(await g.f.handlers.get('math-project-report').run(event), { status: 'ignored' }); assert.equal(g.state.writer.length, 0);
});
