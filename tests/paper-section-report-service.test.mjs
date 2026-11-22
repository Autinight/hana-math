// B2 independent software-only archive/lifecycle fixture. No test-module imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createProjectReportService } from '../packages/hana-math/project-report-service.mjs';
import { capturePlanMaterial } from '../packages/hana-math/paper-plan.mjs';
const clone = v => structuredClone(v), hash = v => createHash('sha256').update(v).digest('hex');
const fault = code => Object.assign(new Error(code), { code });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const KIND = { kind: 'paper-section' }, owner = { callToken: 'b2-local-only', sessionPath: '/fixture/creator.jsonl' }, fid = 'a'.repeat(16);
const body = '\\section{Opaque}\\label{sec:first}\nBODY_PRIVATE_SENTINEL\n';
async function fixture(t, { sections = 2, factCount = 1, proofBytes = 0 } = {}) {
  const files = new Map(), tasks = new Map(), schedules = new Map(), services = [], jobs = [], sessions = new Map();
  const p = { meta: { projectId: 'project-section', creator: { sessionId: 'creator', sessionPath: owner.sessionPath } } };
  const fact = { fact_id: fid, predecessors: [], markdown: `---\nfact_id: ${fid}\npredecessors: []\nexternal_refs: []\n---\n## statement\nOpaque.\n## proof\nOpaque proof.\n` };
  fact.markdown += 'x'.repeat(proofBytes);
  const facts = Array.from({ length: factCount - 1 }, (_, i) => { const id = (i + 1).toString(16).padStart(16, '0'); return { fact_id: id, predecessors: [], markdown: `---\nfact_id: ${id}\npredecessors: []\nexternal_refs: []\n---\n## statement\nOpaque.\n## proof\nOpaque.\n` }; });
  if (facts.length) { fact.predecessors = facts.map(f => f.fact_id); fact.markdown = fact.markdown.replace('predecessors: []', `predecessors: [${fact.predecessors.join(', ')}]`); }
  facts.push(fact);
  const target = { schemaVersion: 1, projectId: p.meta.projectId, paperId: 'main', factIds: [fid], factDigests: { [fid]: hash(fact.markdown) }, finalizedBy: 'creator', at: 1 };
  const gathered = () => ({ facts: facts.map(clone), asOf: 'frozen-graph' });
  const plan = { kind: 'paper-plan', language: 'English', plan: { paperId: 'main', target, brief: 'Opaque brief', instructions: '', material: capturePlanMaterial({ ...gathered(), target }).material } };
  const planner = `%%%PREAMBLE%%%\nPREAMBLE_PRIVATE\n%%%FRONTMATTER%%%\nFRONT_PRIVATE\n%%%SECTIONS%%%\n${JSON.stringify(Array.from({ length: sections }, (_, i) => ({ title: 'Opaque ' + i, label: 'sec:' + i, fact_ids: i === 0 ? plan.plan.material.coverageFactIds : [] })))}\n%%%BIBLIOGRAPHY%%%\nBIB_PRIVATE\n`;
  const state = { text: body, starts: [], stops: [], stages: [], fail: [], complete: [], beforeBound: null, afterBound: null, afterTerminal: null, onGather: null, onPublish: null,
    outputGate: null, stopPending: false, failName: null, postReceipt: null, ackGate: null, ackEntered: defer(), started: defer(), readonly: null, startError: null, postDenied: false };
  let service, handler, seq = 0;
  const store = { absolute: s => '/fixture/data/' + s, async mkdir(s) { return store.absolute(s); },
    async read(s) { if (!files.has(s)) throw fault('ENOENT'); return Buffer.from(files.get(s)); }, async readJson(s) { return JSON.parse((await store.read(s)).toString()); },
    async list(s) { const prefix = s + '/'; return [...new Set([...files.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length).split('/')[0]))]; },
    async write(s, b, replace = false) { if (state.failName && s.endsWith('/' + state.failName)) { state.failName = null; throw fault('B2_SAVE_FAILED'); } if (!replace && files.has(s)) throw fault('EEXIST'); files.set(s, Buffer.from(b)); } };
  const sdk = { tasks: {
    async registerHandler(_key, h) { handler = h; return () => {}; },
    async create(input) { const row = { ...clone(input), pluginId: 'hana-math', taskId: 'task-' + ++seq, parentSessionId: 'creator', parentSessionPath: owner.sessionPath, status: 'pending' }; tasks.set(row.taskId, row); return clone(row); },
    async get(id) { if (state.postReceipt) { const callback = state.postReceipt; state.postReceipt = null; await callback(); } return clone(tasks.get(id)); },
    async schedule(input) { const row = { ...clone(input), pluginId: 'hana-math', scheduleId: 'schedule-' + ++seq }; schedules.set(row.scheduleId, row); return clone(row); },
    async unschedule(id) { schedules.delete(id); return { ok: true }; },
    async complete(id, result) { state.complete.push(id); if (state.ackGate) { state.ackEntered.resolve(); await state.ackGate.promise; } Object.assign(tasks.get(id), { status: 'completed', result: clone(result) }); return clone(tasks.get(id)); },
    async fail(id, error) { state.fail.push(id); Object.assign(tasks.get(id), { status: 'failed', error }); return clone(tasks.get(id)); },
    async getDelivery() { return { state: 'published', delivered: false }; } },
    resources: { async stage(input) { state.stages.push(clone(input)); return { resource: { kind: 'session-file', fileId: 'file-' + state.stages.length, sessionId: 'creator' } }; } },
    sessions: { async get(ref) { return { session: clone([...sessions.values()].find(s => ref.sessionId ? s.sessionId === ref.sessionId : s.path === ref.sessionPath) ?? null) }; },
      async list() { return { sessions: [...sessions.values()].map(clone) }; }, async context({ sessionId }) { return { sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }; }, async abort({ sessionId }) { return { sessionId, aborted: true }; } } };
  const writer = { async start(input) {
    state.starts.push(input); if (input.kind === 'paper-section' && state.startError) { if (state.proveReadonly) state.readonly = { error: state.startError, reportId: input.reportId }; throw state.startError; }
    const binding = { role: 'report-writer', agentId: `math-paper-${input.kind === 'paper-plan' ? 'planner' : 'section-writer'}-01234567-89ab-cdef-0123-456789abcdef`,
      sessionId: 'writer-' + input.reportId, sessionPath: '/fixture/' + input.reportId + '.jsonl', cwd: input.cwd, kind: `math-${input.kind}:${p.meta.projectId}:${input.reportId}`, sendPending: false, sendState: 'accepted' };
    sessions.set(binding.sessionId, { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', visibility: 'plugin_private', namespace: 'app', lifecycle: 'active' });
    await state.beforeBound?.(input); await input.onBound(binding); await input.onUpdate({ ...binding, state: 'running', cleanupPending: true, finalText: 'UPDATE_PRIVATE_SENTINEL' }); await state.afterBound?.(input);
    const terminal = { ...binding, state: 'completed', cleanupPending: false, modelStopReason: 'stop', finalText: input.kind === 'paper-plan' ? planner : state.text };
    state.terminal = terminal;
    let latest; const done = (input.kind === 'paper-section' && state.outputGate ? state.outputGate.promise : Promise.resolve(terminal)).then(async value => { latest = value; await state.afterTerminal?.(input); return value; });
    return { get done() { state.started.resolve(); return done; }, async stop() { state.stops.push(input.reportId); const result = { ...(latest ?? { ...binding, state: 'stopped', modelStopReason: 'stop' }), cleanupPending: state.stopPending }; if (!state.holdDoneOnStop) state.outputGate?.resolve(result); return clone(result); } };
  }, sectionPreparationFailedBeforeCreation(error, identity) { return state.readonly?.error === error && state.readonly.reportId === identity.reportId; }, async dispose() { return { cleanupPending: false }; } };
  const admission = { async authorize() { if (state.postDenied) { state.postDenied = false; throw fault('B2_LATE_DENIED'); } }, guard() {}, async gather(received, selected) { if (received) assert.deepEqual(received, target); await state.onGather?.('admission', selected); return gathered(); } };
  async function open() { service = await createProjectReportService({ sdk, store, summaryWriter: writer, projects: () => [p], getProject: () => p, projectLocation: () => 'project',
    async authorizeCreator(_p, ctx) { assert.equal(ctx, owner); }, assertLive() {}, track(_p, promise) { jobs.push(promise); promise.catch(() => {}); return promise; },
    async assertPaperTarget(_id, received) { assert.deepEqual(received, target); },
    async gatherPaperFacts(_id, authority) { await authority.guard(); authority.assertActive(); await state.onGather?.('runtime'); return gathered(); },
    async withPaperPublication(_id, authority, _target, callback) { await authority.guard(); authority.assertActive(); await state.onPublish?.(); return callback(gathered()); } }); services.push(service); return service; }
  await open();
  const metadataPath = q => `project/reports/${q.reportId}/metadata.json`, metadata = q => store.readJson(metadataPath(q));
  const dispatch = q => { const row = [...schedules.values()].find(s => s.payload.reportId === q.reportId); assert.ok(row); return handler.run({ kind: 'schedule', scheduleId: row.scheduleId, input: clone(row.payload) }); };
  const parent = await service.start(p, clone(plan), owner, admission); await dispatch(parent); assert.equal((await metadata(parent)).state, 'completed'); state.starts.length = 0; state.complete.length = 0; state.started = defer();
  const start = previous => service.start(p, { kind: 'paper-section', language: 'English', section: { planReportId: parent.reportId, ...(previous ? { previousSectionReportId: previous.reportId } : {}) } }, owner, admission);
  t.after(async () => { state.outputGate?.resolve({ state: 'stopped', cleanupPending: false }); state.ackGate?.resolve(); await Promise.allSettled(jobs); for (const s of services) await s.dispose(); });
  return { files, tasks, schedules, state, sdk, writer, store, target, fact, parent, start, dispatch, metadata, metadataPath, open,
    status: q => service.status(p, q, owner, KIND), result: q => service.result(p, q, owner, KIND), stop: q => service.stop(p, q, owner, KIND),
    mutate(q, update) { const value = JSON.parse(files.get(metadataPath(q))); update(value); files.set(metadataPath(q), Buffer.from(JSON.stringify(value))); },
    event: q => { const row = [...schedules.values()].find(s => s.payload.reportId === q.reportId); return { kind: 'schedule', scheduleId: row.scheduleId, input: clone(row.payload) }; }, handle: event => handler.run(event) };
}

test('B2 section root, explicit successor and retry branches bind the full parent and advance flagged content', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.state.text = body + '[GAP: opaque]'; const root = await f.start(); await f.dispatch(root);
  const first = await f.status(root); assert.equal(first.publicationStatus, 'reviewable-section'); assert.equal(first.sourceStatus, 'flagged'); assert.equal(first.chainRootReportId, root.reportId);
  for (let i = 0; i < 2; i++) { const q = await f.start(root); await f.dispatch(q); const meta = await f.metadata(q); assert.equal(meta.section.material.sectionIndex, 1); assert.equal(meta.section.lineage.previousSectionReportId, root.reportId); assert.equal(meta.section.lineage.chainRootReportId, root.reportId); assert.deepEqual(meta.section.source, (await f.metadata(root)).section.source); }
  assert.equal(f.state.starts.length, 3); assert.equal(f.state.starts[1].kind, 'paper-section'); assert.match(f.state.starts[1].prompt, /this section has no assigned facts/); assert.doesNotMatch(f.state.starts[1].prompt, /BODY_PRIVATE_SENTINEL|BIB_PRIVATE/);
});
test('B2 end of plan precedes writer availability and active-slot admission, with zero creation', async t => {
  const f = await fixture(t, { sections: 1 }), q = await f.start(); await f.dispatch(q); const active = await f.start(), counts = [f.files.size, f.tasks.size, f.schedules.size, f.state.starts.length];
  const start = f.writer.start; delete f.writer.start; const end = await f.start(q); f.writer.start = start;
  assert.equal(end.status, 'no_next_section'); assert.equal(end.assembled, false); assert.equal(end.previousSectionReportId, q.reportId); assert.deepEqual([f.files.size, f.tasks.size, f.schedules.size, f.state.starts.length], counts); await f.stop(active);
});
for (const [name, raw, status, code] of [['missing provenance', body, 'completed'], ['malformed provenance', body + '%%%PROVENANCE%%%{', 'completed'], ['blockers', body + Array.from({ length: 40 }, (_, i) => `[GAP: ${i}]`).join('\n'), 'completed'], ['leak', body + '\nfact_submit', 'failed', 'PROJECT_PAPER_SECTION_LEAK'], ['empty', '%%%PROVENANCE%%%{}', 'failed', 'PROJECT_PAPER_SECTION_OUTPUT_EMPTY']]) test(`B2 output ${name} retains raw, bounded truthful DTO and only permitted files`, async t => {
  const f = await fixture(t); f.state.text = raw; const q = await f.start(); await f.dispatch(q); const m = await f.metadata(q); assert.equal(m.state, status, m.error); assert.equal(m.error, code); assert.equal((await f.store.read(m.artifacts.response.artifact)).toString(), raw);
  assert.ok(!JSON.stringify(m).includes('finalText')); assert.ok(!JSON.stringify(m).includes('BODY_PRIVATE_SENTINEL')); assert.ok(!JSON.stringify(f.tasks.get(q.taskId)).includes('BODY_PRIVATE_SENTINEL'));
  if (status === 'failed') { assert.deepEqual(Object.keys(m.artifacts), ['response']); assert.equal((await f.result(q)).status, 'failed'); assert.equal(f.state.stages.length, 0); }
  else { assert.equal(Object.keys(m.artifacts).length, 5); const result = await f.result(q); assert.equal(result.status, name === 'blockers' ? 'flagged' : 'ok'); assert.deepEqual(f.state.stages.map(s => s.name), ['section.tex', 'SECTION_RESULT.json', 'REFERENCE_LEDGER.md']); assert.ok((await f.store.read(m.artifacts.ledger.artifact)).equals(await f.store.read((await f.metadata(f.parent)).artifacts.ledger.artifact))); if (name === 'blockers') { assert.equal(result.findings.blockers.length, 32); assert.equal(result.findingsTruncated, true); } }
});
for (const role of ['response', 'blocks', 'plan', 'ledger']) test(`B2 admission rejects corrupt parent ${role} before creation`, async t => {
  const f = await fixture(t), m = await f.metadata(f.parent), before = [f.tasks.size, f.schedules.size, f.state.starts.length]; f.files.set(m.artifacts[role].artifact, Buffer.from('CORRUPT'));
  await assert.rejects(f.start(), { code: 'PROJECT_REPORT_ARTIFACT_INVALID' }); assert.deepEqual([f.tasks.size, f.schedules.size, f.state.starts.length], before);
});
for (const phase of ['queue', 'onBound', 'return', 'publication']) for (const change of ['fact', 'resource', 'parent']) test(`B2 ${phase} rejects ${change} drift with immutable binding and no section delivery`, { timeout: 10000 }, async t => {
  const f = await fixture(t), q = await f.start(), binding = (await f.metadata(q)).section; let injected = false, resource = false;
  const read = fs.readFile; t.mock.method(fs, 'readFile', async (name, ...args) => { const bytes = await read(name, ...args); return resource && name instanceof URL && name.pathname.endsWith('/PAPER_SECTION_WRITER_PROMPT.md') ? bytes + '\nDRIFT' : bytes; });
  const mutate = async () => { if (injected) return; injected = true; if (change === 'fact') f.fact.markdown += '\nCHANGED'; if (change === 'resource') resource = true; if (change === 'parent') f.files.set((await f.metadata(f.parent)).artifacts.blocks.artifact, Buffer.from('CHANGED')); };
  if (phase === 'queue') await mutate(); if (phase === 'onBound') f.state.beforeBound = mutate; if (phase === 'return') f.state.afterTerminal = mutate; if (phase === 'publication') f.state.onPublish = mutate;
  await f.dispatch(q); const m = await f.metadata(q); assert.equal(injected, true); assert.equal(m.state, 'failed', m.error); assert.deepEqual(m.section, binding); assert.equal(f.state.stages.length, 0); assert.equal(m.artifacts?.source, undefined); if (phase !== 'queue') assert.ok(m.writer.sessionId); if (['return', 'publication'].includes(phase)) assert.ok(m.artifacts.response);
});
test('B2 publication save failure is sticky and partial archives never become ready', async t => {
  const f = await fixture(t), q = await f.start(); f.state.failName = 'REFERENCE_LEDGER.md'; await f.dispatch(q); const m = await f.metadata(q); assert.equal(m.state, 'failed'); assert.equal(m.cleanupPending, true); await assert.rejects(f.result(q), { code: 'PROJECT_REPORT_NOT_READY' }); assert.equal(m.artifacts.ledger, undefined); assert.equal((await f.stop(q)).cleanupPending, true);
});
test('B2 recovery reads a section independently of missing parent and previous; never reruns writer', async t => {
  const f = await fixture(t), root = await f.start(); await f.dispatch(root); const q = await f.start(root); await f.dispatch(q);
  for (const key of [...f.files.keys()]) if (key.includes('/' + f.parent.reportId + '/') || key.includes('/' + root.reportId + '/')) f.files.delete(key);
  f.fact.markdown = 'not current'; const count = f.state.starts.length; await f.open(); const s = await f.status(q); assert.equal(s.publicationStatus, 'reviewable-section'); assert.equal((await f.result(q)).status, 'ok'); assert.equal(f.state.starts.length, count);
});
for (const dirty of [false, true]) test(`B2 ${dirty ? 'dirty' : 'clean'} corrupt completed section recovery preserves honest ownership`, async t => {
  const f = await fixture(t), q = await f.start(); await f.dispatch(q); const m = await f.metadata(q); f.files.set(m.artifacts.source.artifact, Buffer.from('CORRUPT'));
  if (dirty) f.mutate(q, meta => { meta.cleanupPending = true; meta.writer.cleanupPending = true; meta.taskSettlement = 'unknown'; });
  await f.open(); if (dirty) { const s = await f.status(q); assert.equal(s.state, 'interrupted'); assert.equal(s.archiveError, 'PROJECT_REPORT_ARTIFACT_INVALID'); assert.equal(s.publicationStatus, 'not-ready'); assert.equal((await f.stop(q)).archiveError, 'PROJECT_REPORT_ARTIFACT_INVALID'); }
  else await assert.rejects(f.status(q), { code: 'PROJECT_REPORT_NOT_FOUND' }); assert.equal((await f.store.read(m.artifacts.source.artifact)).toString(), 'CORRUPT');
});
test('B2 stop before late onBound retains actual identity, uncertainty and no finalText', { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = defer(), release = defer(); t.after(() => release.resolve()); f.state.beforeBound = async () => { entered.resolve(); await release.promise; };
  const q = await f.start(), run = f.dispatch(q); await entered.promise; assert.equal((await f.stop(q)).cleanupPending, true); release.resolve(); await run;
  const m = await f.metadata(q); assert.equal(m.state, 'stopped'); assert.ok(m.writer.sessionId); assert.equal(m.writerStarting, true); assert.equal(m.cleanupPending, true); assert.ok(!JSON.stringify(m).includes('finalText'));
});
test('B2 held NativeTask acknowledgment hides readiness and retains slot without damaging producer', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.state.ackGate = defer(); const q = await f.start(), run = f.dispatch(q); await f.state.ackEntered.promise;
  const frozen = await f.metadata(q); assert.equal(frozen.state, 'completed'); assert.equal((await f.status(q)).publicationStatus, 'not-ready'); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' }); await assert.rejects(f.result(q), { code: 'PROJECT_REPORT_NOT_READY' }); assert.ok(frozen.artifacts.source); assert.equal(f.state.stops.length, 0);
  f.state.ackGate.resolve(); await run; assert.equal((await f.status(q)).publicationStatus, 'reviewable-section'); assert.deepEqual((await f.metadata(q)).section, frozen.section);
});

for (const confirmed of [false, true]) test(`B2 section ${confirmed ? 'private matching readonly' : 'forged readonly'} startup failure ${confirmed ? 'releases' : 'retains'} uncertain ownership`, async t => {
  const f = await fixture(t); f.state.startError = Object.assign(fault('B2_PREPARATION_DENIED'), { readonlyPreparation: true }); f.state.proveReadonly = confirmed;
  const q = await f.start(); await f.dispatch(q); const m = await f.metadata(q); assert.equal(m.error, 'B2_PREPARATION_DENIED'); assert.equal(m.writerStarting, !confirmed); assert.equal(m.cleanupPending, !confirmed); assert.equal(m.writer, null);
  if (!confirmed) await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' }); else { f.state.startError = null; const retry = await f.start(); await f.stop(retry); }
});
for (const operation of ['create', 'schedule']) test(`B2 unknown NativeTask ${operation} remains sticky through stop`, async t => {
  const f = await fixture(t); f.sdk.tasks[operation] = async () => { throw fault('B2_UNKNOWN_RESOURCE'); };
  const error = await f.start().then(() => assert.fail('creation unexpectedly succeeded'), e => e); assert.equal(error.code, 'B2_UNKNOWN_RESOURCE'); assert.ok(error.reportId);
  const s = await f.status(error); assert.equal(s.cleanupPending, true); assert.equal((await f.stop(error)).cleanupPending, true); assert.equal(f.state.starts.length, 0); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
});
test('B2 post-schedule creator denial stops original writer but retains the slot until its held job exits', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.state.outputGate = defer(); f.state.holdDoneOnStop = true; let run;
  const schedule = f.sdk.tasks.schedule; f.sdk.tasks.schedule = async input => { const row = await schedule(input); f.state.postReceipt = async () => { run = f.dispatch({ reportId: input.payload.reportId }); await f.state.started.promise; f.state.postDenied = true; }; return row; };
  const error = await f.start().then(() => assert.fail('late denial missing'), e => e); assert.equal(error.code, 'B2_LATE_DENIED'); assert.ok(error.reportId); assert.ok(f.state.stops.length > 0);
  assert.equal((await f.status(error)).publicationStatus, 'not-ready'); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  f.state.outputGate.resolve(f.state.terminal); await run; assert.equal((await f.metadata(error)).error, 'B2_LATE_DENIED'); assert.ok(!JSON.stringify(await f.metadata(error)).includes('finalText'));
});
test('B2 late creator denial preserves clean completed producer while original NativeTask acknowledgment is held', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.state.ackGate = defer(); let run;
  const schedule = f.sdk.tasks.schedule; f.sdk.tasks.schedule = async input => { const row = await schedule(input); f.state.postReceipt = async () => { run = f.dispatch({ reportId: input.payload.reportId }); await f.state.ackEntered.promise; f.state.postDenied = true; }; return row; };
  const error = await f.start().then(() => assert.fail('late denial missing'), e => e), m = await f.metadata(error);
  assert.equal(error.code, 'B2_LATE_DENIED'); assert.equal(m.state, 'completed'); assert.equal(m.error, undefined); assert.equal(m.stopRequested, false); assert.equal(f.state.stops.length, 0); assert.equal(f.state.fail.length, 0);
  assert.equal((await f.status(error)).publicationStatus, 'not-ready'); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' }); f.state.ackGate.resolve(); await run; assert.equal((await f.status(error)).publicationStatus, 'reviewable-section');
});
for (const role of ['response', 'source', 'provenance', 'ledger', 'section']) test(`B2 clean own ${role} archive corruption is isolated on recovery without parent lookup`, async t => {
  const f = await fixture(t), q = await f.start(); await f.dispatch(q); const m = await f.metadata(q); f.files.set(m.artifacts[role].artifact, Buffer.from('CORRUPT')); const count = f.state.starts.length;
  await f.open(); await assert.rejects(f.status(q), { code: 'PROJECT_REPORT_NOT_FOUND' }); assert.equal(f.state.starts.length, count);
});
for (const dirty of [false, true]) test(`B2 live ${dirty ? 'held-ack' : 'clean'} own archive corruption is not exposed as ready`, { timeout: 10000 }, async t => {
  const f = await fixture(t); if (dirty) f.state.ackGate = defer(); const q = await f.start(), run = f.dispatch(q);
  if (dirty) await f.state.ackEntered.promise; else await run;
  const m = await f.metadata(q); f.files.set(m.artifacts.source.artifact, Buffer.from('CORRUPT'));
  if (dirty) { const s = await f.status(q); assert.equal(s.state, 'interrupted'); assert.equal(s.archiveError, 'PROJECT_REPORT_ARTIFACT_INVALID'); assert.equal(s.publicationStatus, 'not-ready'); f.state.ackGate.resolve(); await run; assert.equal((await f.stop(q)).archiveError, 'PROJECT_REPORT_ARTIFACT_INVALID'); }
  else { await assert.rejects(f.status(q), { code: 'PROJECT_REPORT_ARTIFACT_INVALID' }); await assert.rejects(f.status(q), { code: 'PROJECT_REPORT_NOT_FOUND' }); }
});
for (const field of ['agentId', 'sessionPath', 'cwd', 'kind', 'finalText', 'modelStopReason']) test(`B2 persisted writer ${field} corruption cannot authorize section recovery`, async t => {
  const f = await fixture(t), q = await f.start(); await f.dispatch(q); f.mutate(q, m => { m.writer[field] = 'INVALID'; }); await f.open(); await assert.rejects(f.status(q), { code: 'PROJECT_REPORT_NOT_FOUND' });
});
for (const count of [9, 10]) test(`B2 local ${count}-fact full closure gates before all report/Host creation`, async t => {
  const f = await fixture(t, { factCount: count }), before = [f.files.size, f.tasks.size, f.schedules.size, f.state.starts.length];
  if (count === 10) { await assert.rejects(f.start(), { code: 'PROJECT_PAPER_SECTION_REPLAN_REQUIRED' }); assert.deepEqual([f.files.size, f.tasks.size, f.schedules.size, f.state.starts.length], before); }
  else { const q = await f.start(); await f.dispatch(q); assert.equal((await f.status(q)).publicationStatus, 'reviewable-section'); }
});
for (const count of [9, 10]) test(`B2 local assigned closure ${count} ${count === 9 ? 'is admitted' : 'requires replan before allocation'}`, async t => {
  const f = await fixture(t, { factCount: count }), before = [f.files.size, f.tasks.size, f.schedules.size, f.state.starts.length];
  if (count === 10) { await assert.rejects(f.start(), { code: 'PROJECT_PAPER_SECTION_REPLAN_REQUIRED' }); assert.deepEqual([f.files.size, f.tasks.size, f.schedules.size, f.state.starts.length], before); }
  else { const q = await f.start(); await f.dispatch(q); assert.equal((await f.status(q)).publicationStatus, 'reviewable-section'); assert.equal((await f.metadata(q)).section.material.factIds.length, 9); }
});
test('B2 512 KiB prompt budget rejects before any report or Host resource is allocated', async t => {
  const f = await fixture(t, { proofBytes: 600 * 1024 }), before = [f.files.size, f.tasks.size, f.schedules.size, f.state.starts.length];
  await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_INPUT_TOO_LARGE' }); assert.deepEqual([f.files.size, f.tasks.size, f.schedules.size, f.state.starts.length], before);
});
for (const role of ['response', 'source', 'provenance', 'ledger', 'section']) test(`B2 own ${role} with coherently changed per-file hash still fails independent rederivation`, async t => {
  const f = await fixture(t), q = await f.start(); await f.dispatch(q); const m = await f.metadata(q), bytes = Buffer.from(role === 'provenance' || role === 'section' ? '{}' : 'CHANGED');
  f.files.set(m.artifacts[role].artifact, bytes); f.mutate(q, meta => { meta.artifacts[role].sha256 = hash(bytes); meta.artifacts[role].bytes = bytes.length; if (role === 'source') { meta.sha256 = hash(bytes); meta.bytes = bytes.length; } });
  await f.open(); await assert.rejects(f.status(q), { code: 'PROJECT_REPORT_NOT_FOUND' });
});
for (const failPublication of [false, true]) test(`B2 near-session-limit terminal body stays only in raw/source through ${failPublication ? 'failed publication' : 'completion'}`, async t => {
  const f = await fixture(t); f.state.text = body + 'x'.repeat(512 * 1024 - 64 - Buffer.byteLength(body));
  if (failPublication) f.state.onPublish = () => { throw fault('B2_PUBLICATION_DENIED'); };
  const q = await f.start(); await f.dispatch(q); const m = await f.metadata(q), meta = await f.store.read(f.metadataPath(q));
  assert.equal(m.state, failPublication ? 'failed' : 'completed'); assert.ok(meta.length < 16 * 1024); assert.doesNotMatch(meta.toString(), /BODY_PRIVATE_SENTINEL|finalText/); assert.equal((await f.store.read(m.artifacts.response.artifact)).length, 512 * 1024 - 64);
});
test('B2 late returned handle is stopped after invalidation and confirmed stop clears only known cleanup', { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = defer(), release = defer(); t.after(() => release.resolve()); f.state.afterBound = async () => { entered.resolve(); await release.promise; };
  const q = await f.start(), run = f.dispatch(q); await entered.promise; assert.equal((await f.stop(q)).cleanupPending, true); release.resolve(); await run;
  assert.ok(f.state.stops.length > 0); assert.equal((await f.status(q)).state, 'stopped'); assert.equal((await f.status(q)).cleanupPending, false);
});
test('B2 failed previous and wrong-kind previous cannot advance', async t => {
  const f = await fixture(t); f.state.text = body + 'fact_submit'; const q = await f.start(); await f.dispatch(q);
  await assert.rejects(f.start(q), { code: 'PROJECT_PAPER_SECTION_PREVIOUS_NOT_READY' }); await assert.rejects(f.start(f.parent), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
});
