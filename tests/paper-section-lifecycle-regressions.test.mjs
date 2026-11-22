// Independent C software lifecycle regressions. All SDK/Host/model data below is opaque fake data.
// No production edits, live APIs, timers for sequencing, or imports from author test modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProjectReportService } from '../packages/hana-math/project-report-service.mjs';
import { capturePlanMaterial } from '../packages/hana-math/paper-plan.mjs';
import { reportReadoutTool } from './helpers/report-readout-tool-fixture.mjs';
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fault = code => Object.assign(new Error(code), { code });
const SECTION = { kind: 'paper-section' }, PLAN = { kind: 'paper-plan' };
const owner = { callToken: 'c-software-only-token', sessionPath: '/c-fixture/creator.jsonl' };
const fid = 'cccccccccccccccc';
const fragment = '\\section{Opaque}\\label{c:opaque}\nC_FRAGMENT_SOFTWARE_SENTINEL\n';

async function fixture(t, sectionCount = 4) {
  const files = new Map(), tasks = new Map(), schedules = new Map(), events = new Map(), sessions = new Map(), jobs = [], services = [], gates = [];
  const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); const value = { promise, resolve }; gates.push(value); return value; };
  const project = { meta: { projectId: 'c-software-project', creator: { sessionId: 'c-creator', sessionPath: owner.sessionPath } } };
  const fact = { fact_id: fid, predecessors: [], markdown: `---\nfact_id: ${fid}\npredecessors: []\nexternal_refs: []\n---\n## statement\nOPAQUE_C_STATEMENT\n## proof\nOPAQUE_C_PROOF\n` };
  const target = { schemaVersion: 1, projectId: project.meta.projectId, paperId: 'opaque-note', factIds: [fid], factDigests: { [fid]: hash(fact.markdown) }, finalizedBy: 'creator', at: 1 };
  const gathered = () => ({ facts: [clone(fact)], asOf: 'c-original-graph' });
  const planArgs = { kind: 'paper-plan', language: 'English', plan: { paperId: target.paperId, target, brief: 'Opaque C software fixture.', instructions: '', material: capturePlanMaterial({ ...gathered(), target }).material } };
  const planner = '%%%PREAMBLE%%%\nC_PREAMBLE\n%%%FRONTMATTER%%%\nC_FRONTMATTER\n%%%SECTIONS%%%\n' + JSON.stringify(Array.from({ length: sectionCount }, (_, i) => ({ title: 'Opaque ' + i, label: 'c:' + i, fact_ids: i === 0 ? [fid] : [] }))) + '\n%%%BIBLIOGRAPHY%%%\nC_BIBLIOGRAPHY\n';
  const state = { trace: [], starts: [], stops: [], stages: [], failures: [], completes: [], models: 0, creationAttempts: 0, taskCreates: 0, scheduleCreates: 0,
    onRead: null, onSchedule: null, postGet: null, onAdmissionGather: null, onRuntimeGather: null, onPublication: null,
    doneGate: null, doneEntered: gate(), ackGate: null, ackEntered: gate(), holdDoneOnStop: false, startFailure: null, authFailure: null,
    failFile: null, inBound: false, publicationLock: false, publicationEntries: 0, listOrder: null, reads: [], terminals: new Map(), text: fragment };
  let service, handler, sequence = 0;
  const store = { absolute: p => '/c-fixture/data/' + p, async mkdir(p) { return store.absolute(p); },
    async read(p) { if (!files.has(p)) throw fault('ENOENT'); const bytes = Buffer.from(files.get(p)); state.reads.push(p); await state.onRead?.(p, bytes); return bytes; },
    async readJson(p) { return JSON.parse((await store.read(p)).toString()); },
    async list(p) { const prefix = p + '/'; const names = [...new Set([...files.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length).split('/')[0]))];
      return state.listOrder ? [...state.listOrder.filter(name => names.includes(name)), ...names.filter(name => !state.listOrder.includes(name))] : names; },
    async write(p, bytes, replace = false) { if (state.failFile && p.endsWith('/' + state.failFile)) { state.failFile = null; throw fault('C_ARCHIVE_WRITE_FAILED'); }
      if (!replace && files.has(p)) throw fault('EEXIST'); files.set(p, Buffer.from(bytes)); } };
  const sdk = { tasks: {
    async registerHandler(_key, value) { handler = value; return () => {}; },
    async create(input) { state.taskCreates++; const row = { ...clone(input), pluginId: 'hana-math', taskId: 'c-task-' + ++sequence, parentSessionId: 'c-creator', parentSessionPath: owner.sessionPath, status: 'pending' }; tasks.set(row.taskId, row); return clone(row); },
    async get(id) { if (state.postGet) { const hook = state.postGet; state.postGet = null; await hook(id); } return clone(tasks.get(id)); },
    async schedule(input) { state.scheduleCreates++; const row = { ...clone(input), pluginId: 'hana-math', scheduleId: 'c-schedule-' + ++sequence }; schedules.set(row.scheduleId, row);
      events.set(input.payload.reportId, { kind: 'schedule', scheduleId: row.scheduleId, input: clone(input.payload) }); await state.onSchedule?.(row); return clone(row); },
    async unschedule(id) { schedules.delete(id); return { ok: true }; },
    async complete(id, result) { state.completes.push({ id, result: clone(result) }); if (state.ackGate) { state.ackEntered.resolve(id); await state.ackGate.promise; }
      Object.assign(tasks.get(id), { status: 'completed', result: clone(result) }); return clone(tasks.get(id)); },
    async fail(id, error) { state.failures.push({ id, error }); Object.assign(tasks.get(id), { status: 'failed', error }); return clone(tasks.get(id)); },
    async getDelivery() { return { state: 'published', delivered: false }; } },
    resources: { async stage(input) { state.stages.push(clone(input)); return { resource: { kind: 'session-file', fileId: 'c-file-' + state.stages.length, sessionId: 'c-creator' } }; } },
    sessions: { async get(ref) { return { session: clone([...sessions.values()].find(row => ref.sessionId ? row.sessionId === ref.sessionId : row.path === ref.sessionPath) ?? null) }; },
      async list() { return { sessions: [...sessions.values()].map(clone) }; }, async abort({ sessionId }) { state.trace.push(['abort', sessionId]); return { sessionId, aborted: true }; },
      async context({ sessionId }) { return { sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }; } } };
  const writer = { async start(input) {
    state.starts.push(input); state.creationAttempts++; state.trace.push(['creation-attempt', input.reportId]);
    if (state.startFailure) { const error = state.startFailure; state.startFailure = null; throw error; }
    const binding = { role: 'report-writer', agentId: `math-paper-${input.kind === 'paper-plan' ? 'planner' : 'section-writer'}-01234567-89ab-cdef-0123-456789abcdef`,
      sessionId: 'c-writer-' + input.reportId, sessionPath: '/c-fixture/' + input.reportId + '.jsonl', cwd: input.cwd, kind: `math-${input.kind}:${project.meta.projectId}:${input.reportId}`, sendPending: false, sendState: 'accepted', model: null, toolSelection: null };
    sessions.set(binding.sessionId, { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', lifecycle: 'active' });
    state.trace.push(['onBound-enter', input.reportId]); state.inBound = true;
    try { await input.onBound(binding); } finally { state.inBound = false; }
    state.trace.push(['onBound-return', input.reportId]);
    await input.onUpdate({ ...binding, state: 'running', cleanupPending: true, finalText: 'C_UPDATE_PRIVATE' });
    state.models++; state.trace.push(['fake-model-send', input.reportId]);
    const terminal = { ...binding, state: 'completed', modelStopReason: 'stop', cleanupPending: false,
      finalText: input.kind === 'paper-plan' ? planner : state.text };
    state.terminals.set(input.reportId, terminal);
    let latest = null;
    const done = (input.kind === 'paper-section' && state.doneGate ? state.doneGate.promise : Promise.resolve(terminal)).then(value => { latest = value ?? terminal; return latest; });
    return { get done() { state.doneEntered.resolve(input.reportId); return done; }, async stop() {
      state.stops.push(input.reportId); const snapshot = latest ?? { ...binding, state: 'stopped', cleanupPending: false, modelStopReason: 'stop' };
      if (!state.holdDoneOnStop) state.doneGate?.resolve(snapshot); return clone(snapshot); } };
  }, sectionPreparationFailedBeforeCreation() { return false; }, async dispose() { return { cleanupPending: false }; } };
  const admission = { async authorize() { if (state.authFailure) { const error = state.authFailure; state.authFailure = null; throw error; } }, guard() {},
    async gather(received) { if (received) assert.deepEqual(received, target, 'fixture target precondition'); await state.onAdmissionGather?.(); return gathered(); } };
  const metadataPath = q => `project/reports/${q.reportId}/metadata.json`;
  const metadata = q => store.readJson(metadataPath(q));
  const dispatch = q => { assert.ok(events.has(q.reportId), 'fixture scheduled event exists'); return handler.run(clone(events.get(q.reportId))); };
  async function open() { service = await createProjectReportService({ sdk, store, summaryWriter: writer, projects: () => [project], getProject: () => project, projectLocation: () => 'project',
    async authorizeCreator(p, ctx) { assert.equal(p, project); assert.equal(ctx, owner); }, assertLive() {}, track(_p, promise) { jobs.push(promise); promise.catch(() => {}); return promise; },
    async assertPaperTarget(_id, value) { assert.deepEqual(value, target, 'fixture current target'); },
    async gatherPaperFacts(_id, authority) { assert.equal(state.publicationLock, false, 'runtime gather must not re-enter the held publication lock'); await authority.guard(); authority.assertActive(); await state.onRuntimeGather?.(); return gathered(); },
    async withPaperPublication(_id, authority, value, callback) { await authority.guard(); authority.assertActive(); assert.deepEqual(value, target);
      assert.equal(state.publicationLock, false, 'publication lock cannot nest'); state.publicationLock = true; state.publicationEntries++;
      try { await state.onPublication?.(); return await callback(gathered()); } finally { state.publicationLock = false; } } }); services.push(service); return service; }
  t.after(async () => { for (const value of gates) value.resolve(); await Promise.allSettled(jobs); for (const s of services) await s.dispose(); });
  await open();
  const parent = await service.start(project, clone(planArgs), owner, admission); await dispatch(parent);
  assert.equal((await metadata(parent)).state, 'completed', 'fixture genuine parent production');
  assert.equal((await service.status(project, parent, owner, PLAN)).publicationStatus, 'reviewable-plan', 'fixture parent archive precondition');
  const counts = () => ({ reports: new Set([...files.keys()].filter(p => p.endsWith('/metadata.json')).map(p => p.split('/')[2])).size,
    tasks: state.taskCreates, schedules: state.scheduleCreates, models: state.models, starts: state.starts.length, creationAttempts: state.creationAttempts });
  const start = (previous, planReportId = parent.reportId) => service.start(project, { kind: 'paper-section', language: 'English', section: { planReportId, ...(previous ? { previousSectionReportId: previous.reportId } : {}) } }, owner, admission);
  const status = q => service.status(project, q, owner, SECTION), result = q => service.result(project, q, owner, SECTION), stop = q => service.stop(project, q, owner, SECTION);
  const complete = async previous => { const q = await start(previous); await dispatch(q); assert.equal((await status(q)).publicationStatus, 'reviewable-section', 'fixture predecessor readiness'); return q; };
  const remove = q => { for (const key of [...files.keys()]) if (key.startsWith('project/reports/' + q.reportId + '/')) files.delete(key); };
  return { files, tasks, schedules, events, state, gate, store, sdk, writer, admission, parent, metadata, metadataPath, counts, open, dispatch, start, status, result, stop, complete, remove,
    parentStatus: (query = parent) => service.status(project, query, owner, PLAN), startPlan: () => service.start(project, clone(planArgs), owner, admission),
    stopPlan: q => service.stop(project, q, owner, PLAN), handle: event => handler.run(clone(event)),
    reportRead: (method, kind) => (args, ctx) => { assert.equal(args.projectId, project.meta.projectId); return service[method](project, args, ctx, kind); } };
}
async function chainTwo(f) { const root = await f.complete(), previous = await f.complete(root); return { root, previous }; }
function equalAllocation(f, before) { assert.deepEqual(f.counts(), before, 'zero report/task/schedule/fake-model/creation delta'); }
async function corrupt(f, q, role) { const m = await f.metadata(q); f.files.set(m.artifacts[role].artifact, Buffer.from('C_CORRUPT_ARCHIVE')); }
function largeText() { const targetBytes = 512 * 1024 - 1, remaining = targetBytes - Buffer.byteLength(fragment);
  return fragment + 'λ'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2); }

// Expected lineage and source descriptors are assembled explicitly from public archive receipts,
// not by copying the implementation's binding, loader or ownership algorithms.
test('C section: nonfirst sibling branches pin root/previous/index/source and preserve complete parent/previous DTOs', { timeout: 15000 }, async t => {
  const f = await fixture(t), { root, previous } = await chainTwo(f);
  const parentBefore = await f.parentStatus(), previousBefore = await f.status(previous), rootBefore = await f.status(root);
  const pm = await f.metadata(f.parent), rm = await f.metadata(root), vm = await f.metadata(previous);
  const expectedSource = { projectId: 'c-software-project', planReportId: f.parent.reportId, paperId: 'opaque-note', planBindingSha256: hash(JSON.stringify(pm.plan)),
    artifacts: Object.fromEntries(['response', 'blocks', 'plan', 'ledger'].map(role => [role, { sha256: pm.artifacts[role].sha256, bytes: pm.artifacts[role].bytes }])) };
  const a = await f.complete(previous), b = await f.complete(previous);
  for (const q of [a, b]) {
    const m = await f.metadata(q); assert.equal(m.section.material.sectionIndex, 2); assert.equal(m.section.sectionCount, 4);
    assert.deepEqual(m.section.source, expectedSource);
    assert.deepEqual(m.section.lineage, { chainRootReportId: root.reportId, previousSectionReportId: previous.reportId, previousSourceSha256: vm.artifacts.source.sha256, previousResultSha256: vm.artifacts.section.sha256 });
    assert.equal(f.tasks.get(q.taskId).metadata.chainRootReportId, root.reportId); assert.equal(f.tasks.get(q.taskId).metadata.sectionIndex, 2);
    assert.equal(f.tasks.get(q.taskId).metadata.sectionBindingSha256, hash(JSON.stringify(m.section)));
  }
  assert.notEqual(a.reportId, b.reportId); assert.equal(rm.section.lineage.chainRootReportId, root.reportId);
  assert.deepEqual(await f.parentStatus(), parentBefore); assert.deepEqual(await f.status(previous), previousBefore); assert.deepEqual(await f.status(root), rootBefore);
  assert.deepEqual((await f.metadata(previous)).artifacts, vm.artifacts); assert.deepEqual((await f.metadata(f.parent)).artifacts, pm.artifacts);
});

test('C section: terminal no-next bypasses an active different-kind slot and unavailable writer with zero allocation', { timeout: 15000 }, async t => {
  const f = await fixture(t, 2), root = await f.complete(), last = await f.complete(root), other = await f.startPlan();
  const before = f.counts(), oldStart = f.writer.start; f.writer.start = undefined;
  f.state.onAdmissionGather = () => { throw fault('C_NO_NEXT_MUST_NOT_GATHER'); };
  const end = await f.start(last); f.writer.start = oldStart; f.state.onAdmissionGather = null;
  assert.equal(end.status, 'no_next_section'); assert.equal(end.nextSectionIndex, 2); assert.equal(end.chainRootReportId, root.reportId); assert.equal(end.assembled, false);
  equalAllocation(f, before); assert.equal((await f.stopPlan(other)).cleanupPending, false);
});

test('C section: held admission archive read detects previous drift on recheck before any allocation', { timeout: 15000 }, async t => {
  const f = await fixture(t), { previous } = await chainTwo(f), m = await f.metadata(previous), entered = f.gate(), release = f.gate();
  const before = f.counts(); let reads = 0;
  f.state.onRead = async path => { if (path === m.artifacts.source.artifact && reads++ === 0) { entered.resolve(); await release.promise; } };
  const pending = f.start(previous); pending.catch(() => {}); await entered.promise; equalAllocation(f, before);
  await corrupt(f, previous, 'source'); release.resolve();
  await assert.rejects(pending, { code: 'PROJECT_REPORT_ARTIFACT_INVALID' }); assert.ok(reads >= 2, 'the immutable original read cannot replace the later recheck'); equalAllocation(f, before);
});

test('C section: queued previous drift retains the actual job slot while archive read is held and starts no model', { timeout: 15000 }, async t => {
  const f = await fixture(t), { previous } = await chainTwo(f), q = await f.start(previous), original = (await f.metadata(q)).section;
  const pm = await f.metadata(previous), entered = f.gate(), release = f.gate(); let seen = false;
  f.state.onRead = async path => { if (!seen && path === pm.artifacts.response.artifact) { seen = true; entered.resolve(); await release.promise; } };
  const before = f.counts(), run = f.dispatch(q); await entered.promise;
  await assert.rejects(f.start(), e => e.code === 'PROJECT_SUMMARY_BUSY' && e.reportId === q.reportId); equalAllocation(f, before);
  await corrupt(f, previous, 'section'); release.resolve(); await run;
  const m = await f.metadata(q); assert.equal(seen, true); assert.equal(m.state, 'failed'); assert.equal(m.error, 'PROJECT_REPORT_ARTIFACT_INVALID');
  assert.deepEqual(m.section, original); assert.equal(f.state.models, before.models); assert.equal(f.state.starts.length, before.starts); assert.equal(m.artifacts?.source, undefined);
  assert.equal(f.state.failures.at(-1).id, q.taskId);
});

test('C section: root archive drift inside real onBound recheck keeps true identity and cannot send the fake model', { timeout: 15000 }, async t => {
  const f = await fixture(t), { root, previous } = await chainTwo(f), q = await f.start(previous), original = (await f.metadata(q)).section;
  const rm = await f.metadata(root), entered = f.gate(), release = f.gate(); let seen = false;
  f.state.onRead = async path => { if (!seen && f.state.inBound && path === rm.artifacts.response.artifact) { seen = true; entered.resolve(); await release.promise; } };
  const before = f.counts(), run = f.dispatch(q); await entered.promise;
  const bound = await f.metadata(q); assert.equal(bound.writer.sessionId, 'c-writer-' + q.reportId); assert.equal(bound.writer.state, 'preparing');
  await corrupt(f, root, 'source'); release.resolve(); await run;
  const m = await f.metadata(q); assert.equal(seen, true); assert.equal(m.error, 'PROJECT_REPORT_ARTIFACT_INVALID'); assert.equal(m.state, 'failed');
  assert.deepEqual(m.section, original); assert.equal(f.state.models, before.models); assert.equal(f.state.starts.length, before.starts + 1);
  assert.equal(f.state.trace.some(([op, id]) => op === 'onBound-return' && id === q.reportId), false); assert.equal(m.writerStarting, true); assert.equal(m.cleanupPending, true);
});

test('C section: previous archive drift under held publication lock rejects without recapture or nested gather', { timeout: 15000 }, async t => {
  const f = await fixture(t), { previous } = await chainTwo(f), q = await f.start(previous), original = (await f.metadata(q)).section;
  const entered = f.gate(), release = f.gate(); let calls = 0;
  f.state.onPublication = async () => { if (++calls === 1) { entered.resolve(); await release.promise; } };
  const run = f.dispatch(q); await entered.promise;
  assert.equal(f.state.publicationLock, true); const mid = await f.metadata(q); assert.ok(mid.artifacts.response); assert.equal(mid.artifacts.source, undefined);
  assert.equal((await f.status(q)).publicationStatus, 'not-ready'); await assert.rejects(f.result(q), { code: 'PROJECT_REPORT_NOT_READY' });
  await corrupt(f, previous, 'source'); release.resolve(); await run;
  const m = await f.metadata(q); assert.equal(calls, 1); assert.equal(m.error, 'PROJECT_REPORT_ARTIFACT_INVALID'); assert.deepEqual(m.section, original);
  assert.equal(m.artifacts.source, undefined); assert.equal(m.writer.cleanupPending, false); assert.equal(m.cleanupPending, false); assert.equal(f.state.publicationLock, false); assert.equal(f.state.stages.length, 0);
});

test('C section: historical own archives survive reverse loading/missing dependencies but new writes reject each missing parent/previous/root', { timeout: 15000 }, async t => {
  const f = await fixture(t), { root, previous } = await chainTwo(f), child = await f.complete(previous), original = new Map([...f.files].map(([key, bytes]) => [key, Buffer.from(bytes)]));
  const before = f.counts(); f.state.listOrder = [child.reportId, previous.reportId, root.reportId, f.parent.reportId]; f.state.reads.length = 0;
  f.state.onRuntimeGather = f.state.onAdmissionGather = () => { throw fault('C_HISTORICAL_MUST_NOT_GATHER'); };
  await f.open(); assert.ok(f.state.reads.slice(0, 6).every(path => path.startsWith('project/reports/' + child.reportId + '/')), 'own loader cannot consult an ancestor before finishing its five artifacts');
  assert.equal((await f.result(child)).status, 'ok'); equalAllocation(f, before);
  for (const missing of [f.parent, previous, root]) {
    f.files.clear(); for (const [key, bytes] of original) f.files.set(key, Buffer.from(bytes)); f.remove(missing); await f.open();
    const counts = f.counts(); await assert.rejects(f.start(previous), { code: 'PROJECT_REPORT_NOT_FOUND' }); equalAllocation(f, counts);
    assert.equal((await f.result(child)).status, 'ok', 'own result does not require the missing dependency');
  }
  f.files.clear(); for (const [key, bytes] of original) f.files.set(key, Buffer.from(bytes)); for (const q of [f.parent, previous, root]) f.remove(q);
  await f.open(); assert.equal((await f.status(child)).publicationStatus, 'reviewable-section'); assert.equal((await f.result(child)).status, 'ok');
  assert.equal(f.state.models, before.models); assert.equal(f.state.starts.length, before.starts);
});

test('C section: clean corrupt quarantine contrasts with genuine held-ack dirty corruption whose archiveError remains permanent', { timeout: 15000 }, async t => {
  const clean = await fixture(t), c = await clean.complete(), cleanBefore = clean.counts(); await corrupt(clean, c, 'source'); await clean.open();
  await assert.rejects(clean.status(c), { code: 'PROJECT_REPORT_NOT_FOUND' }); assert.equal(await clean.handle(clean.events.get(c.reportId)).then(r => r.status), 'ignored'); equalAllocation(clean, cleanBefore);
  const f = await fixture(t); f.state.ackGate = f.gate(); f.state.ackEntered = f.gate(); const q = await f.start(), run = f.dispatch(q); await f.state.ackEntered.promise;
  const m = await f.metadata(q), saved = Buffer.from(f.files.get(m.artifacts.source.artifact)), before = f.counts();
  assert.equal(m.taskSettlement, 'pending'); assert.equal(f.tasks.get(q.taskId).status, 'pending'); await corrupt(f, q, 'source');
  const dirty = await f.status(q); assert.equal(dirty.state, 'interrupted'); assert.equal(dirty.archiveError, 'PROJECT_REPORT_ARTIFACT_INVALID'); assert.equal(dirty.publicationStatus, 'not-ready');
  f.files.set(m.artifacts.source.artifact, saved); f.state.ackGate.resolve(); await run;
  assert.equal((await f.stop(q)).archiveError, 'PROJECT_REPORT_ARTIFACT_INVALID'); await f.open();
  const reloaded = await f.status(q); assert.equal(reloaded.archiveError, 'PROJECT_REPORT_ARTIFACT_INVALID'); assert.equal(reloaded.publicationStatus, 'not-ready');
  const result = await f.result(q); assert.equal(result.status, 'failed'); assert.deepEqual(result.files, []); assert.equal(result.diagnosis.archiveError, 'PROJECT_REPORT_ARTIFACT_INVALID'); equalAllocation(f, before);
});

test('C section: true immediate schedule producer completion remains not-ready and owns the slot until native acknowledgment', { timeout: 15000 }, async t => {
  const f = await fixture(t); f.state.ackGate = f.gate(); f.state.ackEntered = f.gate(); let run;
  f.state.onSchedule = async row => { f.state.onSchedule = null; run = f.dispatch({ reportId: row.payload.reportId }); await f.state.ackEntered.promise; };
  const q = await f.start(), mid = await f.metadata(q), before = f.counts();
  assert.equal(mid.state, 'completed'); assert.equal(mid.scheduleCreating, false); assert.equal(mid.scheduleId, null); assert.equal(mid.taskSettlement, 'pending');
  assert.equal((await f.status(q)).publicationStatus, 'not-ready'); await assert.rejects(f.result(q), { code: 'PROJECT_REPORT_NOT_READY' });
  await assert.rejects(f.start(), e => e.code === 'PROJECT_SUMMARY_BUSY' && e.reportId === q.reportId); equalAllocation(f, before);
  f.state.ackGate.resolve(); await run; assert.equal((await f.status(q)).publicationStatus, 'reviewable-section');
  assert.deepEqual((await f.metadata(q)).section, mid.section);
});

test('C section: late caller denial cannot rewrite completed producer and an old event cannot clear a new job slot', { timeout: 15000 }, async t => {
  const f = await fixture(t); f.state.ackGate = f.gate(); f.state.ackEntered = f.gate(); let run;
  f.state.onSchedule = async row => { f.state.onSchedule = null; f.state.postGet = async () => { run = f.dispatch({ reportId: row.payload.reportId }); await f.state.ackEntered.promise; f.state.authFailure = fault('C_LATE_COMPLETED_DENIED'); }; };
  const denied = await f.start().then(() => assert.fail('fixture late denial must enter'), error => error), q = { reportId: denied.reportId };
  assert.equal(denied.code, 'C_LATE_COMPLETED_DENIED'); const mid = await f.metadata(q); assert.equal(mid.state, 'completed'); assert.equal(mid.error, undefined); assert.equal(mid.stopRequested, false);
  assert.equal(f.state.stops.length, 0); assert.equal(f.state.failures.length, 0); assert.equal((await f.status(q)).publicationStatus, 'not-ready');
  await assert.rejects(f.start(), e => e.code === 'PROJECT_SUMMARY_BUSY' && e.reportId === q.reportId);
  f.state.ackGate.resolve(); await run; assert.equal((await f.status(q)).publicationStatus, 'reviewable-section'); assert.deepEqual((await f.metadata(q)).section, mid.section);
  f.state.ackGate = null; f.state.doneGate = f.gate(); f.state.doneEntered = f.gate(); const next = await f.start(), nextRun = f.dispatch(next); await f.state.doneEntered.promise;
  const before = f.counts(); assert.equal((await f.handle(f.events.get(q.reportId))).status, 'ignored');
  await assert.rejects(f.start(), e => e.code === 'PROJECT_SUMMARY_BUSY' && e.reportId === next.reportId); equalAllocation(f, before);
  f.state.doneGate.resolve(f.state.terminals.get(next.reportId)); await nextRun;
});

test('C section: caller denial with producer-owned done keeps original error and BUSY until the original job joins', { timeout: 15000 }, async t => {
  const f = await fixture(t); f.state.doneGate = f.gate(); f.state.doneEntered = f.gate(); f.state.holdDoneOnStop = true; let run;
  f.state.onSchedule = async row => { f.state.onSchedule = null; f.state.postGet = async () => { run = f.dispatch({ reportId: row.payload.reportId }); await f.state.doneEntered.promise; f.state.authFailure = fault('C_PRODUCER_OWNED_DENIED'); }; };
  const denied = await f.start().then(() => assert.fail('fixture denial must enter'), error => error), q = { reportId: denied.reportId };
  assert.equal(denied.code, 'C_PRODUCER_OWNED_DENIED'); assert.ok(f.state.stops.includes(q.reportId)); const before = f.counts(), captured = (await f.metadata(q)).section;
  assert.equal((await f.status(q)).publicationStatus, 'not-ready'); await assert.rejects(f.start(), e => e.code === 'PROJECT_SUMMARY_BUSY' && e.reportId === q.reportId); equalAllocation(f, before);
  f.state.doneGate.resolve(f.state.terminals.get(q.reportId)); await run;
  const m = await f.metadata(q); assert.equal(m.error, 'C_PRODUCER_OWNED_DENIED'); assert.deepEqual(m.section, captured); assert.equal(m.artifacts?.source, undefined);
  assert.equal(f.state.failures.find(row => row.id === m.taskId).error, 'C_PRODUCER_OWNED_DENIED');
  const next = await f.start(); await f.stop(next);
});

test('C section: near-512KiB raw survives source/publication failures without finalText metadata or false clean-save claims', { timeout: 15000 }, async t => {
  for (const failure of ['source-write', 'publication-denied']) {
    const f = await fixture(t); f.state.text = largeText(); assert.equal(Buffer.byteLength(f.state.text), 512 * 1024 - 1);
    let entered = 0;
    if (failure === 'source-write') f.state.failFile = 'section.tex'; else f.state.onPublication = () => { entered++; throw fault('C_PUBLICATION_DENIED'); };
    const q = await f.start(); await f.dispatch(q); const m = await f.metadata(q), raw = await f.store.read(m.artifacts.response.artifact);
    assert.equal(m.state, 'failed'); assert.equal(m.error, failure === 'source-write' ? 'C_ARCHIVE_WRITE_FAILED' : 'C_PUBLICATION_DENIED');
    assert.equal(raw.length, 512 * 1024 - 1); assert.ok(raw.equals(Buffer.from(f.state.text))); assert.equal(m.writer.cleanupPending, false); assert.ok(f.state.stops.includes(q.reportId));
    const metaBytes = await f.store.read(f.metadataPath(q)); assert.ok(metaBytes.length < 16 * 1024); assert.doesNotMatch(metaBytes.toString(), /finalText|C_FRAGMENT_SOFTWARE_SENTINEL/);
    assert.equal(m.cleanupPending, failure === 'source-write', 'failedSave is independent of a confirmed clean writer stop');
    if (failure === 'source-write') { await assert.rejects(f.result(q), { code: 'PROJECT_REPORT_NOT_READY' }); assert.equal((await f.stop(q)).cleanupPending, true); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' }); }
    else { assert.equal(entered, 1); const result = await f.result(q); assert.equal(result.status, 'failed'); assert.deepEqual(result.files, []); const next = await f.start(); await f.stop(next); }
    assert.equal(f.state.stages.length, 0);
  }
});

test('C section: lost real fake-Host create/schedule receipts preserve unknown ownership through loader and stop without replay', { timeout: 15000 }, async t => {
  for (const operation of ['create', 'schedule']) {
    const f = await fixture(t), before = f.counts(), original = f.sdk.tasks[operation]; let attempts = 0;
    f.sdk.tasks[operation] = async input => { attempts++; await original(input); throw fault('C_RECEIPT_LOST'); };
    const error = await f.start().then(() => assert.fail('fixture receipt must be lost'), error => error), q = { reportId: error.reportId };
    assert.equal(error.code, 'C_RECEIPT_LOST'); assert.equal(attempts, 1); assert.equal((await f.status(q)).cleanupPending, true); await f.open();
    const stopped = await f.stop(q); assert.equal(stopped.cleanupPending, true); assert.equal(stopped.publicationStatus, 'not-ready');
    const stable = f.counts(); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' }); equalAllocation(f, stable);
    assert.equal(stable.reports, before.reports + 1); assert.equal(stable.tasks, before.tasks + 1); assert.equal(stable.schedules, before.schedules + (operation === 'schedule' ? 1 : 0));
    assert.equal(stable.models, before.models); assert.equal(stable.starts, before.starts); assert.equal(attempts, 1);
  }
});

test('C section DEFENSIVE NON-HOST injection: throwing error-code getter must not erase unknown creation ownership in outer catch', { timeout: 15000 }, async t => {
  const f = await fixture(t), before = f.counts(); let codeGetterEntered = 0;
  const unusual = new Error('C defensive-only malformed dependency error; not a real Host error shape');
  Object.defineProperty(unusual, 'code', { get() { codeGetterEntered++; throw new Error('C defensive code normalization threw'); } });
  f.state.startFailure = unusual;
  const q = await f.start(); await f.dispatch(q); const m = await f.metadata(q), view = await f.status(q);
  // Observe the actual next-start lifecycle outcome before asserting, so the first
  // red cannot conceal whether the old slot was in fact released. No snapshot edits.
  const next = await f.start().then(value => ({ accepted: true, value }), error => ({ accepted: false, code: error.code, reportId: error.reportId }));
  if (next.accepted) await f.stop(next.value);
  const observed = { defensiveOnly: true, ordinaryHostReachability: 'not-established', creationAttempts: f.counts().creationAttempts - before.creationAttempts,
    codeGetterEntered, modelDelta: f.state.models - before.models, writerStarting: m.writerStarting, writer: m.writer, cleanupPending: view.cleanupPending,
    state: m.state, error: m.error, taskSettlement: m.taskSettlement, nextAccepted: next.accepted, nextCode: next.code ?? null };
  t.diagnostic('C_DEFENSIVE_OBSERVATION ' + JSON.stringify(observed));
  assert.equal(observed.creationAttempts, 1, 'the fake creation attempt must actually enter'); assert.equal(codeGetterEntered, 1, 'runSection code(error) must actually throw');
  assert.equal(observed.modelDelta, 0, 'no fake model may start during an unknown creation attempt');
  assert.equal(m.writerStarting, true, 'outer catch must retain the original unknown writer-creation evidence');
  assert.equal(view.cleanupPending, true); assert.equal(next.accepted, false); assert.equal(next.code, 'PROJECT_SUMMARY_BUSY');
});

for (const [kind, errorCode] of [['paper-plan', 'RESEARCH_RUNTIME_CAPACITY'], ['paper-section', 'C_PREWRITER_DENIED']]) {
  test(`${kind}: third runtime gather refusal after the persisted marker leaves no writer ownership`, { timeout: 15000 }, async t => {
    const f = await fixture(t), plan = kind === 'paper-plan', start = plan ? f.startPlan : f.start, stop = plan ? f.stopPlan : f.stop;
    const q = await start(), before = f.counts(); let gathers = 0;
    f.state.onRuntimeGather = async () => {
      if (++gathers !== 3) return;
      const m = await f.metadata(q);
      assert.equal(m.state, 'running'); assert.equal(m.writerStarting, true); assert.equal(m.writer, null);
      equalAllocation(f, before);
      throw fault(errorCode);
    };
    await f.dispatch(q); f.state.onRuntimeGather = null;
    assert.equal(gathers, 3); equalAllocation(f, before);
    const m = await f.metadata(q), expected = { state: 'failed', error: errorCode, writer: null, cleanupPending: false, taskSettlement: 'confirmed' };
    assert.partialDeepStrictEqual(m, { ...expected, writerStarting: false });
    const publicExpected = { ...expected, reportId: q.reportId, taskId: q.taskId, publicationStatus: 'not-ready' };
    assert.partialDeepStrictEqual(plan ? await f.parentStatus(q) : await f.status(q), publicExpected);
    assert.deepEqual(f.state.failures, [{ id: q.taskId, error: errorCode }]);
    const next = await start(); assert.equal(next.state, 'queued'); assert.notEqual(next.reportId, q.reportId);
    assert.equal((await stop(next)).cleanupPending, false);
    if (!plan) {
      const saved = await f.store.read(f.metadataPath(q)), counts = f.counts();
      await f.open(); assert.partialDeepStrictEqual(await f.status(q), publicExpected);
      assert.deepEqual(await f.store.read(f.metadataPath(q)), saved); equalAllocation(f, counts);
    }
  });
}

test('paper-section: isolated loader preserves writer uncertainty from a captured running prewriter snapshot', { timeout: 15000 }, async t => {
  const f = await fixture(t), fork = await fixture(t), q = await f.start(), before = f.counts();
  const entered = f.gate(), release = f.gate(); let gathers = 0;
  f.state.onRuntimeGather = async () => {
    if (++gathers !== 3) return;
    entered.resolve(); await release.promise; throw fault('C_ORIGINAL_DISPATCH_RELEASED');
  };
  const run = f.dispatch(q);
  try {
    await Promise.race([entered.promise, run.then(() => assert.fail('original dispatch did not reach the held third gather'))]);
    const m = await f.metadata(q);
    assert.partialDeepStrictEqual(m, { state: 'running', writerStarting: true, writer: null, cleanupPending: true, taskSettlement: 'pending', scheduleId: null });
    assert.equal(f.tasks.get(q.taskId).status, 'pending'); equalAllocation(f, before);
    const saved = await f.store.read(f.metadataPath(q));
    // Copy store bytes and fake task receipts, not the live service or its job/handler.
    fork.files.clear(); for (const [path, bytes] of f.files) fork.files.set(path, Buffer.from(bytes));
    fork.tasks.clear(); for (const [id, row] of f.tasks) fork.tasks.set(id, clone(row));
    const forkBefore = fork.counts();
    await fork.open();
    const expected = { state: 'interrupted', error: 'PROJECT_REPORT_INTERRUPTED', writer: null, cleanupPending: true, taskSettlement: 'confirmed' };
    assert.partialDeepStrictEqual(await fork.metadata(q), { ...expected, writerStarting: true, nonce: m.nonce });
    assert.partialDeepStrictEqual(await fork.status(q), { ...expected, publicationStatus: 'not-ready' });
    assert.deepEqual(await fork.handle(f.events.get(q.reportId)), { status: 'ignored' });
    const parent = await fork.parentStatus(f.parent);
    assert.partialDeepStrictEqual(parent, { reportId: f.parent.reportId, publicationStatus: 'reviewable-plan' });
    await assert.rejects(fork.start(undefined, f.parent.reportId), { code: 'PROJECT_SUMMARY_BUSY', reportId: q.reportId });
    equalAllocation(fork, forkBefore);
    assert.deepEqual(fork.state.failures, [{ id: q.taskId, error: 'PROJECT_REPORT_INTERRUPTED' }]);
    assert.deepEqual(await f.store.read(f.metadataPath(q)), saved); assert.equal(f.tasks.get(q.taskId).status, 'pending');
  } finally { release.resolve(); await run; }
});

test('paper-section: prewriter marker write failure keeps failedSave sticky despite zero writer attempts', { timeout: 15000 }, async t => {
  const f = await fixture(t), q = await f.start(), before = f.counts(), write = f.store.write;
  let rejectedMarker = 0; let gathers = 0;
  f.state.onRuntimeGather = () => { gathers++; };
  t.mock.method(f.store, 'write', async (path, bytes, replace) => {
    if (path === f.metadataPath(q) && JSON.parse(bytes).writerStarting && rejectedMarker++ === 0) throw fault('C_MARKER_WRITE_FAILED');
    return write(path, bytes, replace);
  });
  await f.dispatch(q);
  assert.equal(rejectedMarker, 1); assert.equal(gathers, 2); equalAllocation(f, before);
  const expected = { state: 'failed', error: 'C_MARKER_WRITE_FAILED', writer: null, cleanupPending: true, taskSettlement: 'confirmed' };
  assert.partialDeepStrictEqual(await f.metadata(q), { ...expected, writerStarting: false });
  assert.partialDeepStrictEqual(await f.status(q), expected);
  await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY', reportId: q.reportId }); equalAllocation(f, before);
});

const READ_INVALID = 'PROJECT_REPORT_ARTIFACT_INVALID';
async function realReportReads(t, f) {
  const tool = await reportReadoutTool(t, {
    paperSectionStatus: f.reportRead('status', SECTION), paperSectionResult: f.reportRead('result', SECTION),
    paperPlanStatus: f.reportRead('status', PLAN), paperPlanResult: f.reportRead('result', PLAN),
  });
  return async (action, q) => {
    const out = await tool.execute({ action, projectId: q.projectId, reportId: q.reportId, context: owner });
    assert.deepEqual(JSON.parse(out.content[0].text), out.details); return out;
  };
}

for (const kind of ['paper_plan', 'paper_section']) test(`real report service ${kind}: retained failure diagnosis is readable without export`, async t => {
  const f = await fixture(t), read = await realReportReads(t, f), q = await (kind === 'paper_plan' ? f.startPlan() : f.start());
  f.state.onRuntimeGather = () => { throw fault('C_READOUT_FAILED'); };
  await f.dispatch(q);
  const m = await f.metadata(q), tasks = clone(f.tasks), counts = f.counts();
  assert.partialDeepStrictEqual(m, { state: 'failed', error: 'C_READOUT_FAILED', taskSettlement: 'confirmed', cleanupPending: false });
  const status = await read(`${kind}_status`, q), result = await read(`${kind}_result`, q);
  const expected = { reportId: q.reportId, state: m.state, error: m.error, cleanupPending: m.cleanupPending, taskSettlement: m.taskSettlement };
  assert.partialDeepStrictEqual(status.details, expected);
  assert.partialDeepStrictEqual(result.details, { ...expected, saved: true, status: 'failed', files: [], diagnosis: { responseSaved: false, error: m.error } });
  assert.deepEqual(await f.metadata(q), m); assert.deepEqual(f.tasks, tasks); equalAllocation(f, counts); assert.deepEqual(f.state.stages, []);
  assert.deepEqual([status.isError, result.isError], [false, false]);
});

test('real report service: partial stage preserves file receipts, only the current result is red', async t => {
  const f = await fixture(t), read = await realReportReads(t, f), q = await f.complete();
  const stage = f.sdk.resources.stage; let attempts = 0;
  t.mock.method(f.sdk.resources, 'stage', async input => { if (++attempts === 2) throw fault('C_STAGE_UNAVAILABLE'); return stage(input); });
  const result = await read('paper_section_result', q), status = await read('paper_section_status', q);
  assert.partialDeepStrictEqual(result.details, { reportId: q.reportId, state: 'completed', error: null, saved: true, status: 'delivery-failed' });
  assert.equal(attempts, 3); assert.equal(result.details.files.length, 3);
  assert.deepEqual(result.details.files.map(row => [row.role, row.resource?.fileId ?? row.error]), [['source', 'c-file-1'], ['section', 'C_STAGE_UNAVAILABLE'], ['ledger', 'c-file-2']]);
  assert.deepEqual(status.details.delivery, { state: 'failed', delivered: false, files: result.details.files });
  assert.equal(Object.hasOwn(status.details, 'readError'), false); assert.equal(Object.hasOwn(await f.metadata(q), 'readError'), false);
  assert.deepEqual([result.isError, status.isError], [true, false]);
  assert.equal(result.details.readError?.code, 'PROJECT_REPORT_EXPORT_FAILED');
});

for (const ackBeforeSecond of [false, true]) test(`real report service: only the dirty archive converter is red (ack before second: ${ackBeforeSecond})`, { timeout: 15000 }, async t => {
  const f = await fixture(t), read = await realReportReads(t, f), q = await f.start();
  const entered = [f.gate(), f.gate()], release = [f.gate(), f.gate()];
  f.state.ackGate = f.gate();
  const run = f.dispatch(q); let a, b;
  try {
    await Promise.race([f.state.ackEntered.promise, run.then(() => assert.fail('did not reach fake NativeTask hold'))]);
    const initial = await f.metadata(q), counts = f.counts();
    assert.partialDeepStrictEqual(initial, { state: 'completed', cleanupPending: false, taskSettlement: 'pending' });
    await corrupt(f, q, 'source');
    const write = f.store.write, writes = []; let hits = 0;
    t.mock.method(f.store, 'write', async (path, bytes, replace) => { if (path === f.metadataPath(q)) writes.push(JSON.parse(bytes)); return write(path, bytes, replace); });
    f.state.onRead = async path => { if (path !== initial.artifacts.source.artifact) return; const i = hits++; assert.ok(i < 2); entered[i].resolve(); await release[i].promise; };
    a = read('paper_section_status', q); await Promise.race([entered[0].promise, a.then(() => assert.fail('first call did not reach archive read'))]);
    b = read('paper_section_status', q); await Promise.race([entered[1].promise, b.then(() => assert.fail('second call did not reach archive read'))]);
    assert.equal(writes.length, 0);
    release[0].resolve(); const first = await a;
    assert.equal(writes.length, 1); assert.equal(f.tasks.get(q.taskId).status, 'pending');
    const expected = { state: 'interrupted', reportId: q.reportId, error: READ_INVALID, archiveError: READ_INVALID, publicationStatus: 'not-ready' };
    assert.partialDeepStrictEqual(first.details, expected);
    if (ackBeforeSecond) { f.state.ackGate.resolve(); await run; assert.equal((await f.metadata(q)).taskSettlement, 'confirmed'); }
    const count = writes.length, task = clone(f.tasks.get(q.taskId));
    release[1].resolve(); const second = await b;
    const readCount = f.state.reads.length, third = await read('paper_section_status', q);
    const expectedHistorical = { ...expected, taskSettlement: ackBeforeSecond ? 'confirmed' : 'pending' };
    for (const out of [second, third]) { assert.partialDeepStrictEqual(out.details, expectedHistorical); assert.equal(Object.hasOwn(out.details, 'readError'), false); }
    assert.equal(f.state.reads.length, readCount); assert.deepEqual(f.tasks.get(q.taskId), task); equalAllocation(f, counts);
    assert.ok(writes.every(meta => !Object.hasOwn(meta, 'readError')));
    t.diagnostic(JSON.stringify({ first: first.isError, second: second.isError, third: third.isError, converterReadError: first.details.readError ?? null, writesAfterAckOrFirst: count, writesAfterSecondAndThird: writes.length }));
    assert.equal(writes.length, count, 'only the converter may save the downgrade');
    assert.deepEqual([first.isError, second.isError, third.isError], [true, false, false]);
    assert.deepEqual(first.details.readError, { code: READ_INVALID, phase: 'archive-validation' });
  } finally { f.state.onRead = null; release.forEach(g => g.resolve()); f.state.ackGate.resolve(); await Promise.allSettled([run, a, b]); }
});

test('real report service: independent dirty loader yields historical archive diagnosis without readError', async t => {
  const f = await fixture(t), fork = await fixture(t), q = await f.start(); f.state.ackGate = f.gate();
  const run = f.dispatch(q);
  try {
    await Promise.race([f.state.ackEntered.promise, run.then(() => assert.fail('did not reach fake NativeTask hold'))]);
    await corrupt(f, q, 'source');
    fork.files.clear(); for (const [path, bytes] of f.files) fork.files.set(path, Buffer.from(bytes));
    fork.tasks.clear(); for (const [id, row] of f.tasks) fork.tasks.set(id, clone(row));
    await fork.open(); const read = await realReportReads(t, fork), meta = await fork.metadata(q), task = clone(fork.tasks.get(q.taskId));
    assert.partialDeepStrictEqual(meta, { state: 'interrupted', archiveError: READ_INVALID });
    const counts = fork.counts(), reads = fork.state.reads.length, out = await read('paper_section_status', q);
    assert.partialDeepStrictEqual(out.details, { reportId: q.reportId, state: 'interrupted', archiveError: READ_INVALID, publicationStatus: 'not-ready' });
    assert.equal(Object.hasOwn(out.details, 'readError'), false); assert.equal(Object.hasOwn(meta, 'readError'), false);
    assert.equal(fork.state.reads.length, reads); assert.deepEqual(await fork.metadata(q), meta); assert.deepEqual(fork.tasks.get(q.taskId), task); equalAllocation(fork, counts);
    assert.equal((await f.metadata(q)).state, 'completed'); assert.equal(out.isError, false);
  } finally { f.state.ackGate.resolve(); await run; }
});

for (const action of ['paper_section_status', 'paper_section_result', 'next-section']) test(`real report service: ${action} fails closed on clean corrupt archive`, async t => {
  const f = await fixture(t), read = await realReportReads(t, f), q = await f.complete(), prev = await f.metadata(q), counts = f.counts();
  await corrupt(f, q, 'source');
  if (action === 'next-section') await assert.rejects(f.start(q), { code: READ_INVALID });
  else { const out = await read(action, q); assert.equal(out.isError, true); assert.equal(out.details.error.code, READ_INVALID); }
  const status = await read('paper_section_status', q); assert.equal(status.isError, true); assert.equal(status.details.error.code, 'PROJECT_REPORT_NOT_FOUND');
  assert.deepEqual(await f.metadata(q), prev); assert.deepEqual(f.state.stages, []); equalAllocation(f, counts);
});

const B_CAPACITY = 'RESEARCH_RUNTIME_CAPACITY', B_FIELD = 'managedIpcRefusal';
const bRecord = category => ({ version: 1, category });

for (const legal of [false, true]) test(`B history section: reload ${legal ? 'projects only recorded categories' : 'omits absent, malformed and non-capacity categories'} with zero read writes`, { timeout: 15000 }, async t => {
  const cases = legal ? ['unsafe-entry', 'invalid-completion-marker'].map(category => [category, bRecord(category), B_CAPACITY, { source: 'recorded', category }])
    : [['no field', undefined, B_CAPACITY], ['unknown category', bRecord('not-enumerated'), B_CAPACITY], ['wrong type', [1, 'byte-limit'], B_CAPACITY], ['null', null, B_CAPACITY], ['non-capacity', bRecord('byte-limit'), 'C_NONCAPACITY']];
  const rows = [];
  for (const [label, record, code, expected] of cases) {
    const f = await fixture(t), q = await f.start(); f.state.onRuntimeGather = () => { throw fault(code); };
    const runView = await f.dispatch(q), meta = await f.metadata(q);
    assert.partialDeepStrictEqual(meta, { state: 'failed', error: code, writer: null, taskSettlement: 'confirmed', cleanupPending: false });
    assert.equal(Object.hasOwn(meta, B_FIELD), false, 'plain fixture error is not runtime category proof');
    assert.equal(Object.hasOwn(runView, B_FIELD), false, 'generic producer view does not project the field');
    // This is a simulated historical field in the fixture store, not a current runtime refusal.
    if (record !== undefined) { meta[B_FIELD] = record; await f.store.write(f.metadataPath(q), JSON.stringify(meta), true); }
    const write = f.store.write, writes = [], tasks = clone(f.tasks), counts = f.counts();
    t.mock.method(f.store, 'write', async (...args) => { writes.push(args[0]); return write(...args); });
    await f.open(); const read = await realReportReads(t, f);
    const actions = ['paper_section_status', 'paper_section_result', 'paper_section_status', 'paper_section_result'];
    const actual = [];
    for (const action of actions) {
      const out = await read(action, q), dto = out.details;
      assert.equal(out.isError, false);
      assert.partialDeepStrictEqual(dto, { kind: SECTION.kind, reportId: q.reportId, state: 'failed', error: code, cleanupPending: false, taskSettlement: 'confirmed' });
      if (action === 'paper_section_result') assert.partialDeepStrictEqual(dto, { saved: true, files: [], diagnosis: { error: code } });
      actual.push(Object.hasOwn(dto, B_FIELD) ? { value: dto[B_FIELD] } : null);
    }
    const stop = await f.stop(q); assert.equal(stop.error, code); assert.equal(Object.hasOwn(stop, B_FIELD), false);
    assert.deepEqual(writes, []); assert.deepEqual(await f.metadata(q), meta); assert.deepEqual(f.tasks, tasks);
    assert.deepEqual(f.state.stages, []); assert.deepEqual(f.state.stops, []); equalAllocation(f, counts);
    rows.push({ label, actual, expected: actions.map(() => expected === undefined ? null : { value: expected }) });
  }
  t.diagnostic(JSON.stringify(rows));
  assert.deepEqual(rows.map(row => row.actual), rows.map(row => row.expected), 'history projection differs from recorded-only contract');
});

for (const corruptArchive of [false, true]) test(`B history section: clean completed ${corruptArchive ? 'corrupt quarantine' : 'readiness and delivery'} ignores the stored field`, { timeout: 15000 }, async t => {
  for (const record of [undefined, bRecord('byte-limit'), { version: 0, category: 'byte-limit' }]) {
    const f = await fixture(t), q = await f.complete(), original = await f.metadata(q);
    assert.partialDeepStrictEqual(original, { state: 'completed', cleanupPending: false, taskSettlement: 'confirmed' });
    if (record !== undefined) { original[B_FIELD] = record; await f.store.write(f.metadataPath(q), JSON.stringify(original), true); }
    if (corruptArchive) await corrupt(f, q, 'source');
    const write = f.store.write, writes = [], allocation = f.counts();
    t.mock.method(f.store, 'write', async (...args) => { writes.push(args[0]); return write(...args); });
    await f.open(); assert.deepEqual(writes, []);
    if (corruptArchive) {
      await assert.rejects(f.status(q), { code: 'PROJECT_REPORT_NOT_FOUND' }); await assert.rejects(f.result(q), { code: 'PROJECT_REPORT_NOT_FOUND' });
      await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
      assert.deepEqual(await f.metadata(q), original); assert.deepEqual(writes, []); assert.deepEqual(f.state.stages, []);
    } else {
      const status = await f.status(q), result = await f.result(q);
      assert.partialDeepStrictEqual(status, { state: 'completed', error: null, publicationStatus: 'reviewable-section', cleanupPending: false, taskSettlement: 'confirmed' });
      assert.partialDeepStrictEqual(result, { saved: true, status: 'ok', publicationStatus: 'reviewable-section' });
      assert.equal(result.files.length, 3); assert.equal(f.state.stages.length, 3);
      assert.ok([status, result, await f.stop(q)].every(dto => !Object.hasOwn(dto, B_FIELD)));
      const after = await f.metadata(q); assert.deepEqual(after, { ...original, delivery: after.delivery });
      assert.deepEqual(writes, [f.metadataPath(q)], 'only ordinary attachment delivery saves');
    }
    equalAllocation(f, allocation);
    if (!corruptArchive) { const next = await f.start(); assert.equal(next.state, 'queued'); await f.stop(next); }
  }
});
