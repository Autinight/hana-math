// Real Project/report/Core FIFO wiring with software-only Host and canonical
// readers. No production injection API, model, private fact-file read or research.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
const id = n => n.toString(16).padStart(16, '0');
const fact = (n, predecessors = []) => ({ fact_id: id(n), predecessors,
  markdown: `---\nfact_id: ${id(n)}\npredecessors: [${predecessors.join(', ')}]\nexternal_refs: [{"key":"K${n}","title":"REFERENCE_${n}","cited_for":"USE_${n}"}]\n---\n## statement\nSTATEMENT_${n}_SENTINEL\n## proof\nPROOF_${n}_SENTINEL\n` });
const tex = provenance => '\\documentclass{article}\n\\begin{document}\n\\label{outside}\\label{unselected}Opaque text.\n\\end{document}\n%%%PROVENANCE%%%\n' + JSON.stringify(provenance ?? {});
async function setup(t, { size = 10, target = true, allHeadlines = false, large = false } = {}) {
  const facts = new Map(Array.from({ length: size }, (_, i) => { const f = fact(i + 1, i ? [id(i)] : []); return [f.fact_id, f]; }));
  facts.set(id(11), fact(11, [id(2)])); facts.set(id(12), fact(12, [id(11)]));
  if (large) facts.get(id(size)).markdown += 'x'.repeat(520 * 1024);
  const state = { facts, writer: [], stages: [], beforeCore: null, onWriter: null, output: tex({ outside: id(12), unselected: id(11) }) };
  const f = await fixture(t, { multiWorker: true, async coreCall(_binding, operation, args) {
    await state.beforeCore?.(operation, args);
    if (operation === 'fact_list_page') return { facts: [...facts.values()] };
    assert.equal(operation, 'fact_get'); const row = facts.get(args.fact_id);
    if (!row) throw Object.assign(new Error('unknown or revoked fixture fact'), { code: 'PROJECT_CORE_INVALID_RESULT' });
    return structuredClone(row);
  }, summaryWriter: { async start(input) { state.writer.push(input); await state.onWriter?.(input);
    return { done: Promise.resolve({ state: 'completed', modelStopReason: 'stop', cleanupPending: false, finalText: state.output }),
      stop: async () => ({ state: 'stopped', cleanupPending: false }) }; } } });
  f.sdk.resources = { async stage(input) { state.stages.push(input); return { resource: { kind: 'session-file', fileId: 'software-file', sessionId: 'creator-stable' } }; } };
  const p = await f.create();
  if (target) await f.service.finalize({ projectId: p.projectId, factIds: allHeadlines ? Array.from({ length: size }, (_, i) => id(i + 1)) : [id(size)] }, origin);
  let runtime; const set = Map.prototype.set;
  const mock = t.mock.method(Map.prototype, 'set', function(key, value) {
    if (key === p.projectId && value?.meta?.creator && value?.targets instanceof Map) runtime = value;
    return set.call(this, key, value);
  });
  try { await f.open(); } finally { mock.mock.restore(); }
  assert.ok(runtime);
  const args = { projectId: p.projectId, brief: 'Opaque brief' }, dir = path.join(f.dataDir, 'research/projects', p.projectId, 'reports');
  const status = q => f.service.paperStatus({ projectId: p.projectId, reportId: q.reportId }, origin);
  const result = q => f.service.paperResult({ projectId: p.projectId, reportId: q.reportId }, origin);
  const metadataPath = q => path.join(dir, q.reportId, 'metadata.json');
  const metadata = async q => JSON.parse(await fs.readFile(metadataPath(q), 'utf8'));
  const dispatch = q => { const schedule = [...f.schedules.values()].find(row => row.payload?.reportId === q.reportId);
    assert.ok(schedule); return f.handlers.get('math-project-report').run({ kind: 'schedule', scheduleId: schedule.scheduleId, input: schedule.payload }); };
  return { f, p, runtime, state, args, status, result, metadata, metadataPath, dispatch, dir };
}
const reportWork = ({ f, state }) => ({ tasks: f.calls.tasks.filter(t => t.handlerKey === 'math-project-report').length,
  schedules: f.calls.schedules.filter(s => s.handlerKey === 'math-project-report').length, writers: state.writer.length, sessions: f.calls.sessions.length });
const noReport = async g => { assert.equal(g.state.writer.length, 0);
  assert.deepEqual(await fs.readdir(g.dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), []); };

test('paper admission no target wins over legal selections without canonical/report/task/writer work', async t => {
  const g = await setup(t, { target: false }), before = reportWork(g), core = g.f.calls.core.length;
  for (const factIds of [undefined, [], [id(99)]]) assert.deepEqual(await g.f.service.paper({ ...g.args, factIds,
    brief: 'headline_fact_ids: unknown\nstructural_exemplar: outside' }, origin), { projectId: g.p.projectId, paperId: 'main', status: 'needs_target' });
  for (const factIds of [[id(1), id(1)], ['bad'], null, Array.from({ length: 65 }, (_, i) => id(i + 1))])
    await assert.rejects(g.f.service.paper({ ...g.args, factIds }, origin), { code: 'PROJECT_INVALID_INPUT' });
  await assert.rejects(g.f.service.paper({ ...g.args, material: {} }, origin), { code: 'PROJECT_INVALID_INPUT' });
  assert.equal(g.f.calls.core.length, core); assert.deepEqual(reportWork(g), before); await noReport(g);
});

for (const role of ['main', 'worker', 'other-creator']) for (const target of [true, false]) test(`paper selection denies ${role} before ${target ? 'present' : 'absent'} target disclosure`, async t => {
  const g = await setup(t, { target }), before = reportWork(g), core = g.f.calls.core.length;
  const ctx = role === 'main' ? g.p.context : { callToken: 'software-context', sessionPath: '/fixture/' + role };
  if (role !== 'main') g.f.host.set(ctx.sessionPath, { path: ctx.sessionPath, sessionId: role, ownerPluginId: role === 'worker' ? 'hana-math' : null,
    namespace: role === 'worker' ? 'app' : 'home', visibility: role === 'worker' ? 'plugin_private' : 'public', lifecycle: 'active' });
  await assert.rejects(g.f.service.paper({ ...g.args, factIds: [id(10)] }, ctx), { code: role === 'main' ? 'PROJECT_SUMMARY_DENIED' : 'PROJECT_OWNER_DENIED' });
  assert.deepEqual(reportWork(g), before); assert.equal(g.f.calls.core.length, core); await noReport(g);
});

for (const at of [1, 2, 3]) test(`paper final handoff creator authorization ${at} refuses drift before report creation`, async t => {
  const g = await setup(t), list = g.f.sdk.sessions.list; let pages = 0, calls = 0, finished = false;
  g.state.beforeCore = async operation => { if (operation === 'fact_list_page' && ++pages === 2) finished = true; };
  g.f.sdk.sessions.list = async input => {
    const result = await list(input); if (finished && ++calls === at) g.runtime.meta.creator = { ...g.runtime.meta.creator }; return result;
  };
  await assert.rejects(g.f.service.paper({ ...g.args, factIds: [id(10)] }, origin), { code: 'PROJECT_PAPER_CHANGED' });
  assert.equal(calls, at); await noReport(g);
});

for (const size of [9, 10]) for (const empty of [false, true]) test(`paper admission ${size}-fact target with ${empty ? 'empty' : 'omitted'} selection`, async t => {
  const g = await setup(t, { size }), before = reportWork(g);
  const request = g.f.service.paper({ ...g.args, ...(empty ? { factIds: [] } : {}) }, origin);
  if (size === 10) { await assert.rejects(request, { code: 'PROJECT_PAPER_SELECTION_REQUIRED' }); assert.deepEqual(reportWork(g), before); await noReport(g); }
  else { const q = await request, m = await g.metadata(q); assert.equal(m.paper.material.mode, 'legacy'); assert.equal(Object.hasOwn(m.paper, 'factIds'), false);
    assert.equal(m.paper.material.writerFactIds.length, 9); assert.equal(g.state.writer.length, 0); }
});

test('paper admission full closure, superset, missing headline, unknown/revoked and 64-ID shape rules create no report', async t => {
  for (const kind of ['full', 'superset', 'headline', 'unknown', 'revoked', 'duplicate', 'oversized', 'all-headlines']) await t.test(kind, async t => {
    const g = await setup(t, { allHeadlines: kind === 'all-headlines' }), before = reportWork(g); let ids, code;
    const full = Array.from({ length: 10 }, (_, i) => id(i + 1));
    if (kind === 'full' || kind === 'all-headlines') { ids = full; code = 'PROJECT_PAPER_SELECTION_FULL_CLOSURE'; }
    if (kind === 'superset') { ids = [...full, id(12)]; code = 'PROJECT_PAPER_SELECTION_FULL_CLOSURE'; }
    if (kind === 'headline') { ids = [id(9)]; code = 'PROJECT_PAPER_HEADLINE_NOT_SELECTED'; }
    if (kind === 'unknown' || kind === 'revoked') { ids = [id(10), id(12)]; if (kind === 'unknown') ids.push(id(99)); else g.state.facts.delete(id(12)); code = 'PROJECT_CORE_INVALID_RESULT'; }
    if (kind === 'duplicate') { ids = [id(10), id(10)]; code = 'PROJECT_INVALID_INPUT'; }
    if (kind === 'oversized') { ids = Array.from({ length: 65 }, (_, i) => id(i + 1)); code = 'PROJECT_INVALID_INPUT'; }
    await assert.rejects(g.f.service.paper({ ...g.args, factIds: ids }, origin), { code }); assert.deepEqual(reportWork(g), before); await noReport(g);
  });
  const small = await setup(t, { size: 9 });
  assert.equal((await small.f.service.paper({ ...small.args, factIds: Array.from({ length: 9 }, (_, i) => id(i + 1)) }, origin)).state, 'queued');
  await assert.rejects(small.f.service.finalize({ projectId: small.p.projectId, factIds: [] }, origin), { code: 'PROJECT_INVALID_INPUT' });
});

test('paper selected outside body and warning persist through completion/reopen/result; ancestors are ledger-only and provenance stays tolerant', async t => {
  const g = await setup(t), q = await g.f.service.paper({ ...g.args, factIds: [id(12), id(10)] }, origin), captured = (await g.metadata(q)).paper;
  assert.equal(captured.material.validationFactIds.length, 12); assert.deepEqual(captured.material.writerFactIds, [id(10), id(12)]);
  assert.doesNotMatch(JSON.stringify(captured.material), /markdown|PROOF_|STATEMENT_|predecessors/);
  assert.doesNotMatch(JSON.stringify(await g.metadata(q)), /"callToken":|"ctx":/);
  await g.dispatch(q); assert.equal(g.state.writer.length, 1);
  const prompt = g.state.writer[0].prompt;
  for (const n of [10, 12]) assert.ok(prompt.includes(`PROOF_${n}_SENTINEL`));
  for (let n = 1; n <= 11; n++) if (n !== 10) { assert.ok(!prompt.includes(`PROOF_${n}_SENTINEL`)); assert.ok(!prompt.includes(`STATEMENT_${n}_SENTINEL`)); }
  assert.match(prompt, /REFERENCE_11/); assert.match(prompt, /USE_11/); assert.match(prompt, /BEGIN SELECTED_FACTS/);
  const m = await g.metadata(q); assert.deepEqual(m.paper, captured); assert.equal(m.state, 'completed');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(g.dir, q.reportId, 'provenance.json'), 'utf8')), { outside: id(12) });
  assert.ok(m.findings.warnings.some(w => w.includes('unselected'))); assert.equal(m.sourceStatus, 'generated');
  const expected = { mode: 'selected', factIds: [id(12), id(10)], writerFactCount: 2, validationFactCount: 12,
    outsideTargetFactIds: [id(12)], warnings: ['PROJECT_PAPER_SELECTION_OUTSIDE_TARGET'] };
  assert.deepEqual((await g.status(q)).selection, expected); await g.f.open();
  assert.deepEqual((await g.status(q)).selection, expected); assert.deepEqual((await g.result(q)).selection, expected);
  assert.equal((await g.result(q)).status, 'ok'); assert.equal(g.state.writer.length, 1);
});

for (const stage of ['queue', 'before-start', 'publication']) for (const n of [1, 11, 12, 10]) test(`paper ${stage} refuses captured ${n === 1 ? 'target ancestor' : n === 11 ? 'outside ancestor' : n === 12 ? 'outside selected' : 'headline'} drift`, async t => {
  const g = await setup(t), q = await g.f.service.paper({ ...g.args, factIds: [id(10), id(12)] }, origin), capture = (await g.metadata(q)).paper.material;
  const change = () => { g.state.facts.get(id(n)).markdown += '\nChanged original bytes.'; };
  if (stage === 'queue') change();
  if (stage === 'before-start') { let pages = 0; g.state.beforeCore = async operation => { if (operation === 'fact_list_page' && ++pages === 3) change(); }; }
  if (stage === 'publication') g.state.onWriter = change;
  await g.dispatch(q); const m = await g.metadata(q); assert.equal(m.state, 'failed');
  assert.equal(m.error, n === 10 ? 'PROJECT_TARGET_FACT_CHANGED' : 'PROJECT_SUMMARY_FACT_REVOKED');
  assert.equal(g.state.writer.length, stage === 'publication' ? 1 : 0); assert.deepEqual(m.paper.material, capture);
  assert.equal((await g.result(q)).files.length, 0); assert.equal(g.state.stages.length, 0);
});

test('paper publication refuses a deleted outside ancestor without replacing admission capture or staging files', async t => {
  const g = await setup(t), q = await g.f.service.paper({ ...g.args, factIds: [id(10), id(12)] }, origin), capture = (await g.metadata(q)).paper.material;
  g.state.onWriter = () => { assert.equal(g.state.facts.delete(id(11)), true); };
  await g.dispatch(q); const m = await g.metadata(q);
  assert.equal(g.state.writer.length, 1); assert.equal(g.state.facts.has(id(11)), false);
  assert.equal(m.state, 'failed'); assert.equal(m.error, 'PROJECT_CORE_INVALID_RESULT'); assert.deepEqual(m.paper.material, capture);
  const result = await g.result(q); assert.equal(result.status, 'failed'); assert.deepEqual(result.files, []); assert.equal(g.state.stages.length, 0);
});

test('paper queued graph-drift retry does not replace admission material; unrelated graph advancement remains permitted', async t => {
  for (const materialChanged of [true, false]) await t.test(String(materialChanged), async t => {
    const g = await setup(t), q = await g.f.service.paper({ ...g.args, factIds: [id(10), id(12)] }, origin), capture = (await g.metadata(q)).paper.material;
    if (materialChanged) {
      let changed = false; g.state.beforeCore = async operation => { if (operation === 'fact_get' && !changed) { changed = true; g.state.facts.get(id(11)).markdown += 'Changed.'; } };
    } else g.state.facts.set(id(20), fact(20));
    const before = g.f.calls.core.length; await g.dispatch(q); const m = await g.metadata(q);
    assert.deepEqual(m.paper.material, capture);
    if (materialChanged) { assert.equal(m.state, 'failed'); assert.equal(m.error, 'PROJECT_SUMMARY_FACT_REVOKED'); assert.equal(g.state.writer.length, 0);
      assert.equal(g.f.calls.core.slice(before).filter(c => c.operation === 'fact_list_page').length, 4); }
    else { assert.equal(m.state, 'completed'); assert.equal(m.snapshotAdvancedDuringWriting, true); }
  });
});

test('paper selected prompt still has the 512KiB gate even below 1MiB material; refusal leaves no writer or hung Core', async t => {
  const g = await setup(t, { large: true }), q = await g.f.service.paper({ ...g.args, factIds: [id(10)] }, origin);
  await g.dispatch(q); assert.equal((await g.status(q)).error, 'PROJECT_SUMMARY_INPUT_TOO_LARGE'); assert.equal(g.state.writer.length, 0);
  assert.ok((await g.f.service.result({ projectId: g.p.projectId, factId: id(10) }, origin)).fact.markdown.length > 512 * 1024);
});

test('paper legacy completed metadata reads without material/selection or backfill; legacy queued recovers interrupted without model replay', async t => {
  for (const queued of [false, true]) await t.test(String(queued), async t => {
    const g = await setup(t, { size: 9 }), q = await g.f.service.paper(g.args, origin);
    if (!queued) await g.dispatch(q);
    const m = await g.metadata(q); delete m.paper.material; assert.deepEqual(Object.keys(m.paper), ['paperId', 'target', 'brief', 'instructions']);
    await fs.writeFile(g.metadataPath(q), JSON.stringify(m)); const writerCount = g.state.writer.length;
    await g.f.open(); const status = await g.status(q); assert.equal(status.state, queued ? 'interrupted' : 'completed'); assert.equal(status.selection, undefined);
    const after = await g.metadata(q); assert.equal(Object.hasOwn(after.paper, 'material'), false); assert.equal(g.state.writer.length, writerCount);
    if (!queued) assert.equal((await g.result(q)).status, 'ok');
  });
});

test('paper historical four-field queued schedule replay is ignored after interrupted recovery without writer or material backfill', async t => {
  const g = await setup(t, { size: 9 }), q = await g.f.service.paper(g.args, origin);
  const schedule = [...g.f.schedules.values()].find(row => row.payload?.reportId === q.reportId);
  assert.ok(schedule); assert.equal(schedule.handlerKey, 'math-project-report');
  const event = structuredClone({ kind: 'schedule', scheduleId: schedule.scheduleId, input: schedule.payload });
  const m = await g.metadata(q); assert.equal(event.input.nonce, m.nonce); delete m.paper.material;
  assert.deepEqual(Object.keys(m.paper), ['paperId', 'target', 'brief', 'instructions']); const oldPaper = structuredClone(m.paper);
  await fs.writeFile(g.metadataPath(q), JSON.stringify(m)); const writerCount = g.state.writer.length;
  await g.f.open(); assert.equal((await g.status(q)).state, 'interrupted');
  assert.equal((await g.metadata(q)).nonce, event.input.nonce, 'replay retains the original nonce, not an invalid replacement');
  const handler = g.f.handlers.get(schedule.handlerKey); assert.ok(handler);
  assert.deepEqual(await handler.run(event), { status: 'ignored' }); assert.equal(g.state.writer.length, writerCount);
  const after = await g.metadata(q); assert.equal(after.state, 'interrupted'); assert.deepEqual(after.paper, oldPaper);
  assert.equal(Object.hasOwn(after.paper, 'material'), false);
});

test('paper loader rejects a new oversized legacy capture independently of selected-mode mismatch', async t => {
  const g = await setup(t), q = await g.f.service.paper({ ...g.args, factIds: [id(10), id(12)] }, origin), m = await g.metadata(q);
  delete m.paper.factIds; m.paper.material.mode = 'legacy';
  m.paper.material.writerFactIds = [...m.paper.material.validationFactIds];
  m.paper.material.outsideTargetFactIds = []; m.paper.material.warnings = [];
  await fs.writeFile(g.metadataPath(q), JSON.stringify(m)); await g.f.open();
  await assert.rejects(g.status(q), { code: 'PROJECT_REPORT_NOT_FOUND' }); assert.equal(g.state.writer.length, 0);
});

test('paper new persisted material loader rejects invalid mode/nesting/counts and does not launch a model', async t => {
  for (const patch of [{ mode: 'legacy' }, { writerFactIds: [id(10)] }, { schemaVersion: 2 }, { proof: 'forbidden' },
    { validationFactIds: Array.from({ length: 2049 }, (_, i) => id(i + 1)) }]) await t.test(JSON.stringify(Object.keys(patch)), async t => {
    const g = await setup(t), q = await g.f.service.paper({ ...g.args, factIds: [id(10), id(12)] }, origin), m = await g.metadata(q);
    Object.assign(m.paper.material, patch); await fs.writeFile(g.metadataPath(q), JSON.stringify(m));
    await g.f.open(); await assert.rejects(g.status(q), { code: 'PROJECT_REPORT_NOT_FOUND' }); assert.equal(g.state.writer.length, 0);
  });
});

for (const name of ['creator', 'main', 'ctx', 'target', 'dispose']) test(`paper creator FIFO admission refuses ${name} drift without a report`, async t => {
  const g = await setup(t), entered = defer(), release = defer(), queued = defer(), ctx = { ...origin }; t.after(() => release.resolve());
  let blocked = false; g.state.beforeCore = async () => { if (!blocked) { blocked = true; entered.resolve(); await release.promise; } };
  const blocker = g.f.service.result({ projectId: g.p.projectId, factId: id(1) }, origin); blocker.catch(() => {}); await entered.promise;
  const push = g.runtime.coreQueue.push;
  g.runtime.coreQueue.push = function(slot) { const n = push.call(this, slot); if (slot.creatorAdmission) queued.resolve(); return n; };
  const request = g.f.service.paper({ ...g.args, factIds: [id(10)] }, ctx);
  const refusal = assert.rejects(request, error => {
    assert.ok((name === 'dispose' ? ['PROJECT_CORE_QUEUE_CANCELLED', 'PROJECT_DISPOSED'] : name === 'target' ? ['PROJECT_TARGET_CHANGED'] : ['PROJECT_PAPER_CHANGED']).includes(error.code)); return true;
  });
  await queued.promise; g.runtime.coreQueue.push = push;
  let disposing;
  if (name === 'creator') g.runtime.meta.creator = { ...g.runtime.meta.creator };
  if (name === 'main') g.runtime.meta.main = { ...g.runtime.meta.main };
  if (name === 'ctx') ctx.callToken = 'changed';
  if (name === 'target') g.runtime.targets.set('main', { ...g.runtime.targets.get('main'), at: 0 });
  if (name === 'dispose') disposing = g.f.service.dispose();
  release.resolve(); await blocker.catch(() => {}); await refusal; await disposing; await noReport(g);
});
