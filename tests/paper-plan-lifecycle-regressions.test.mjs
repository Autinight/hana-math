// C2 PREPARATION ONLY: intentionally not executed before C1 is frozen.
// Independent in-memory fixture; never import an existing *.test.mjs module.
// Product expectations are the parent's C2 decisions, not current implementation output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProjectReportService } from '../packages/hana-math/project-report-service.mjs';
import { capturePlanMaterial } from '../packages/hana-math/paper-plan.mjs';
import { reportReadoutTool } from './helpers/report-readout-tool-fixture.mjs';

const KIND = { kind: 'paper-plan' }, OPTIONS = { timeout: 10000 }; // Watchdog only; no timer sequences the race.
const POST_DENIED = 'C2_POST_SCHEDULE_CREATOR_DENIED';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const fault = code => Object.assign(new Error(code), { code });
function deferred() {
  let resolve, resolved = false;
  const promise = new Promise(yes => { resolve = value => { resolved = true; yes(value); }; });
  return { promise, resolve, get resolved() { return resolved; } };
}
const observe = promise => Promise.resolve(promise).then(value => ({ value }), error => ({ error }));
const creator = { sessionId: 'c2-test-creator', sessionPath: '/fixture/c2/creator' };
// This token belongs only to the local mock below, never a real Host/API call.
const owner = { sessionPath: creator.sessionPath, callToken: 'c2-in-memory-stub-token' };
const fid = 'a'.repeat(16);
const fact = { fact_id: fid, predecessors: [], markdown: `---\nfact_id: ${fid}\npredecessors: []\nexternal_refs: []\n---\n## statement\nOpaque C2 statement.\n## proof\nOpaque C2 proof.\n` };
const plannerOutput = `%%%PREAMBLE%%%\nPREAMBLE_C2\n%%%FRONTMATTER%%%\nFRONTMATTER_C2\n%%%SECTIONS%%%\n[{"title":"Opaque section","label":"sec:c2","fact_ids":["${fid}"]}]\n%%%BIBLIOGRAPHY%%%\nBIBLIOGRAPHY_C2\n`;

function memoryStore() {
  const files = new Map(), dirs = new Set(['']), writes = [], observers = new Set();
  let failName = null;
  const normalize = name => {
    assert.equal(typeof name, 'string'); assert.ok(!name.startsWith('/') && !name.split('/').includes('..'));
    return name.replace(/\/$/, '');
  };
  function parents(name) { const parts = name.split('/'); for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
  const store = {
    absolute: name => '/fixture/c2/data/' + normalize(name),
    async mkdir(name, exclusive = false) {
      name = normalize(name); if (exclusive && dirs.has(name)) throw fault('EEXIST'); parents(name); return store.absolute(name);
    },
    async read(name) { name = normalize(name); if (!files.has(name)) throw fault('ENOENT'); return Buffer.from(files.get(name)); },
    async readJson(name) { return JSON.parse((await store.read(name)).toString('utf8')); },
    async list(name) {
      name = normalize(name); if (!dirs.has(name)) throw fault('ENOENT');
      const prefix = name ? name + '/' : '';
      return [...new Set([...dirs, ...files.keys()].filter(n => n.startsWith(prefix) && n !== name).map(n => n.slice(prefix.length).split('/')[0]))].sort();
    },
    async write(name, bytes, replace = false) {
      name = normalize(name);
      if (failName && name.endsWith('/' + failName)) { failName = null; throw fault('C2_LEDGER_WRITE_FAILED'); }
      if (!replace && files.has(name)) throw fault('EEXIST');
      const parent = name.split('/').slice(0, -1).join('/'); parents(parent);
      const saved = Buffer.from(bytes); files.set(name, saved); writes.push(name);
      if (name.endsWith('/metadata.json')) {
        const meta = JSON.parse(saved.toString('utf8')); for (const notify of observers) notify(meta);
      }
    },
    async remove(name) { files.delete(normalize(name)); },
  };
  return { store, files, writes, observers, failNextLedger() { failName = 'REFERENCE_LEDGER.md'; } };
}

async function fixture(t, { raceAt = null, runtimeError = null } = {}) {
  const memory = memoryStore(), store = memory.store, p = { meta: { projectId: 'project-c2-plan', creator: clone(creator) } };
  const target = { schemaVersion: 1, projectId: p.meta.projectId, paperId: 'main', factIds: [fid], factDigests: { [fid]: hash(fact.markdown) }, finalizedBy: 'creator', at: 1 };
  const gathered = () => ({ facts: [clone(fact)], asOf: 'c2-admission' });
  const args = { projectId: p.meta.projectId, kind: 'paper-plan', language: 'English', plan: { paperId: 'main', target,
    brief: 'Opaque C2 brief', instructions: '', material: capturePlanMaterial({ ...gathered(), target }).material } };
  const tasks = new Map(), schedules = new Map(), sessions = new Map(), writers = new Map(), services = [], jobs = [], handlers = [], writerWaiters = new Map();
  const writerWait = reportId => { if (!writerWaiters.has(reportId)) writerWaiters.set(reportId, deferred()); return writerWaiters.get(reportId); };
  const calls = { starts: [], stages: [], stops: [], aborts: [], unschedules: [], fail: [], complete: [], runtimeGather: 0, postScheduleFailures: 0 };
  const gatherEntered = deferred(), gatherRelease = deferred(), modelEntered = deferred(), postDenied = deferred(), stopIntent = deferred(), writerStopEntered = deferred();
  let sequence = 0, handler, service, taskConfirmed = true, scheduleConfirmed = true, abortConfirmed = true;
  let dispatchOnNextTaskGet = false, rejectAdmissionOnce = false;
  const race = { reportId: null, handlerRun: null, handlerSettled: false, entered: raceAt === 'gather' ? gatherEntered : modelEntered };
  const metaPath = q => `project/reports/${q.reportId}/metadata.json`;
  memory.observers.add(meta => { if (meta.reportId === race.reportId && meta.stopRequested) stopIntent.resolve(); });

  const sdk = {
    tasks: {
      async registerHandler(name, value) { assert.equal(name, 'math-project-report'); handler = value; return () => { if (handler === value) handler = null; }; },
      async create(input) {
        const row = { ...clone(input), taskId: `task-c2-${++sequence}`, pluginId: 'hana-math', parentSessionId: creator.sessionId, parentSessionPath: creator.sessionPath, status: 'pending' };
        tasks.set(row.taskId, row); return clone(row);
      },
      async get(taskId) {
        if (dispatchOnNextTaskGet) {
          // start has evaluated `if (queued)` and is now awaiting taskReceipt.
          // Start the real registered handler here; NEVER await its whole run.
          dispatchOnNextTaskGet = false;
          const row = [...schedules.values()].find(s => s.payload.reportId === race.reportId);
          assert.ok(row, 'schedule receipt and its exact payload must already exist');
          const run = handler.run({ kind: 'schedule', scheduleId: row.scheduleId, input: clone(row.payload) });
          race.handlerRun = run; handlers.push(run);
          run.then(() => { race.handlerSettled = true; }, () => { race.handlerSettled = true; });
          await Promise.race([race.entered.promise, run.then(() => { throw new Error('C2 fixture: handler ended before the requested barrier'); })]);
          rejectAdmissionOnce = true;
        }
        assert.ok(tasks.has(taskId)); return clone(tasks.get(taskId));
      },
      async schedule(input) {
        const row = { ...clone(input), pluginId: 'hana-math', scheduleId: `schedule-c2-${++sequence}` }; schedules.set(row.scheduleId, row);
        if (raceAt && !race.reportId) { race.reportId = input.payload.reportId; dispatchOnNextTaskGet = true; }
        return clone(row); // The handler is not joined by this receipt.
      },
      async unschedule(id) { calls.unschedules.push(id); if (!scheduleConfirmed) return { ok: false }; schedules.delete(id); return { ok: true }; },
      async complete(id, result) { calls.complete.push(id); const row = tasks.get(id); if (taskConfirmed) { row.status = 'completed'; row.result = clone(result); } return clone(row); },
      async fail(id, error) { calls.fail.push({ id, error }); const row = tasks.get(id); if (taskConfirmed) { row.status = 'failed'; row.error = error; } return clone(row); },
      async getDelivery() { return { state: 'published', delivered: false }; },
    },
    resources: { async stage(input) { calls.stages.push(clone(input)); return { resource: { kind: 'session-file', fileId: `c2-file-${calls.stages.length}`, sessionId: creator.sessionId } }; } },
    sessions: {
      async get(ref) { const row = [...sessions.values()].find(s => ref.sessionId ? s.sessionId === ref.sessionId : s.path === ref.sessionPath); return { session: row ? clone(row) : null }; },
      async list(input) { return { sessions: [...sessions.values()].filter(s => !input.agentId || input.agentId === s.agentId).map(clone) }; },
      async abort({ sessionId }) { calls.aborts.push(sessionId); if (abortConfirmed) sessions.get(sessionId).streaming = false; return { sessionId, aborted: abortConfirmed }; },
      async context({ sessionId }) { return { sessionId, isStreaming: sessions.get(sessionId).streaming, isCompacting: false, pendingMessageCount: 0 }; },
    },
  };
  const writer = {
    async start(input) {
      assert.equal(input.kind, 'paper-plan'); calls.starts.push({ reportId: input.reportId, kind: input.kind });
      const done = deferred(), binding = { role: 'report-writer', sessionId: `c2-writer-${input.reportId}`, agentId: 'math-paper-planner-01234567-89ab-cdef-0123-456789abcdef',
        sessionPath: `/fixture/c2/${input.reportId}.jsonl`, cwd: input.cwd, kind: `math-paper-plan:${input.projectId}:${input.reportId}`, sendState: 'accepted', sendPending: false };
      const row = { binding, done, terminal: null, wait: writerWait(input.reportId) }; writers.set(input.reportId, row);
      sessions.set(binding.sessionId, { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', visibility: 'plugin_private', namespace: 'app', lifecycle: 'active', streaming: true });
      await input.onBound(clone(binding)); await input.onUpdate({ ...clone(binding), state: 'running', cleanupPending: true });
      return {
        get done() { row.wait.resolve(); if (input.reportId === race.reportId) modelEntered.resolve(); return done.promise; },
        async stop() {
          calls.stops.push(input.reportId); writerStopEntered.resolve(); sessions.get(binding.sessionId).streaming = false;
          // Acknowledged stop is not job/send completion. The barrier deliberately
          // leaves done pending until the test releases it (the ownership race).
          return clone(row.terminal ?? { ...binding, state: 'stopped', cleanupPending: false, modelStopReason: 'stop' });
        },
      };
    },
    async dispose() { return { cleanupPending: false }; },
  };
  const admission = {
    async authorize() {
      if (rejectAdmissionOnce) {
        rejectAdmissionOnce = false; calls.postScheduleFailures++; postDenied.resolve(); throw fault(POST_DENIED);
      }
    },
    guard() {}, async gather() { return gathered(); },
  };
  async function open() {
    service = await createProjectReportService({ sdk, store, summaryWriter: writer,
      async authorizeCreator(_p, ctx) { assert.equal(ctx, owner, 'C2 fixture accepts only its local owner object'); },
      projects: () => [p], getProject: id => { assert.equal(id, p.meta.projectId); return p; }, assertLive() {}, projectLocation: () => 'project',
      track(_p, job) { jobs.push(job); job.catch(() => {}); return job; },
      async assertPaperTarget(id, received) { assert.equal(id, p.meta.projectId); assert.deepEqual(received, target); },
      async gatherPaperFacts(id, authority, received) {
        calls.runtimeGather++; assert.equal(id, p.meta.projectId); assert.deepEqual(received, target); assert.equal(Object.hasOwn(authority, 'callToken'), false);
        await authority.guard(); authority.assertActive();
        if (runtimeError) throw fault(runtimeError);
        if (raceAt === 'gather' && authority.reportId === race.reportId) { gatherEntered.resolve(); await gatherRelease.promise; }
        await authority.guard(); authority.assertActive(); return gathered();
      },
      async withPaperPublication(id, authority, received, callback) {
        assert.equal(id, p.meta.projectId); assert.deepEqual(received, target); await authority.guard(); authority.assertActive(); return callback(gathered());
      },
    });
    services.push(service); return service;
  }
  await open();
  const start = () => service.start(p, clone(args), owner, admission);
  function finish(q, patch = {}) {
    const row = writers.get(q.reportId); assert.ok(row, 'C2 writer must have started before completion');
    row.terminal = { ...clone(row.binding), state: 'completed', modelStopReason: 'stop', cleanupPending: false, finalText: plannerOutput, ...patch };
    sessions.get(row.binding.sessionId).streaming = false; row.done.resolve(clone(row.terminal));
  }
  function releaseHeld() {
    gatherRelease.resolve();
    for (const [reportId, row] of writers) if (!row.done.resolved) finish({ reportId }, { state: 'stopped', finalText: '' });
  }
  t.after(async () => {
    releaseHeld(); await Promise.allSettled([...handlers, ...jobs]);
    for (const instance of services) await instance.dispose();
  });
  return { p, args, sdk, store, memory, tasks, schedules, sessions, writers, calls, race, admission,
    get service() { return service; }, start, open, finish, releaseHeld, postDenied, stopIntent, writerStopEntered,
    whenWriting: q => writerWait(q.reportId).promise,
    status: q => service.status(p, q, owner, KIND), result: q => service.result(p, q, owner, KIND), stop: q => service.stop(p, q, owner, KIND),
    metadata: q => store.readJson(metaPath(q)), saveMetadata: (q, meta) => store.write(metaPath(q), JSON.stringify(meta) + '\n', true),
    setConfirmation({ task = true, schedule = true, abort = true } = {}) { taskConfirmed = task; scheduleConfirmed = schedule; abortConfirmed = abort; },
    dispatch(q) {
      const row = [...schedules.values()].find(s => s.payload.reportId === q.reportId); assert.ok(row);
      const run = handler.run({ kind: 'schedule', scheduleId: row.scheduleId, input: clone(row.payload) }); handlers.push(run); run.catch(() => {}); return run;
    },
  };
}

async function writing(f, q) {
  const entered = f.whenWriting(q), run = f.dispatch(q);
  // `done` is observed only after the service has installed its handle and
  // performed the post-start recheck. This is stronger than a start() signal.
  await Promise.race([entered, run.then(() => { throw new Error('C2 fixture: run ended without waiting for the writer'); })]);
  return { run }; // Do not assimilate/join run before the test releases done.
}
async function complete(f) {
  const q = await f.start(), { run } = await writing(f, q);
  f.finish(q); await run; return q;
}
function notReady(value) {
  assert.equal(value.kind, 'paper-plan'); assert.equal(value.publicationStatus, 'not-ready');
  assert.notEqual(value.coverageStatus, 'exact-once'); assert.equal(Object.hasOwn(value, 'coverage'), false);
  if (Object.hasOwn(value, 'files')) assert.deepEqual(value.files, []);
  assert.notEqual(value.status, 'ok');
}
function reportRejection(error) { return typeof error?.code === 'string' && /^PROJECT_(REPORT|PAPER_PLAN)_/.test(error.code); }
async function closedOrDiagnostic(f, q) {
  const status = await observe(f.status(q)), result = await observe(f.result(q));
  for (const read of [status, result]) {
    if (read.error) { assert.ok(reportRejection(read.error), 'only a typed report/archive rejection counts'); assert.notEqual(read.error.code, 'PROJECT_REPORT_NOT_FOUND', 'dirty record must remain addressable for cleanup'); }
    else notReady(read.value);
  }
  return [status, result];
}
const diagnostic = values => JSON.stringify(values, (_key, value) => value instanceof Error ? { code: value.code, message: value.message } : value);

for (const raceAt of ['gather', 'model']) test(`C2 lifecycle race: post-schedule creator failure retains BUSY until old ${raceAt} job joins and preserves original diagnosis`, OPTIONS, async t => {
  const f = await fixture(t, { raceAt }), first = observe(f.start());
  try {
    await f.postDenied.promise;
    // Broken catch deletes active before throwing; wait for its finished start.
    // A safe stop-and-join implementation may instead announce its stop intent
    // while start remains pending. Both paths permit this deterministic probe.
    await Promise.race([first, f.stopIntent.promise, f.writerStopEntered.promise]);
    assert.equal(f.calls.postScheduleFailures, 1); assert.equal(f.race.entered.resolved, true); assert.equal(f.race.handlerSettled, false);
    const next = await observe(f.start());
    assert.equal(next.error?.code, 'PROJECT_SUMMARY_BUSY', 'post-schedule catch must not free the slot while its original job is still pending');
    const q = { reportId: f.race.reportId };
    const stopping = observe(f.stop(q)); // May legitimately join the held job.
    f.releaseHeld(); await stopping;
    await f.race.handlerRun;
    const firstOutcome = await first;
    assert.equal(firstOutcome.error?.code, POST_DENIED, 'the rejected creator check is the original admission failure');
    const meta = await f.metadata(q);
    assert.equal(meta.error, POST_DENIED, 'late current()/STOPPED must not replace the original failure');
    assert.equal(meta.cleanupPending, false); assert.equal(meta.taskSettlement, 'confirmed'); assert.equal(f.race.handlerSettled, true);
    if (raceAt === 'model') assert.ok(f.calls.stops.includes(q.reportId), 'the original writer, not a replacement, is stopped');
    const fresh = await f.start(); assert.notEqual(fresh.reportId, q.reportId); assert.equal(f.calls.postScheduleFailures, 1, 'later requests are authorized normally');
    await f.stop(fresh);
  } finally { f.releaseHeld(); await Promise.allSettled([first, ...(f.race.handlerRun ? [f.race.handlerRun] : [])]); }
});

test('C2 lifecycle recovery control: corrupt clean completed archive still rejects status/result and never replays a model', OPTIONS, async t => {
  const f = await fixture(t), q = await complete(f), before = await f.status(q);
  assert.equal(before.publicationStatus, 'reviewable-plan'); assert.equal(before.coverageStatus, 'exact-once');
  const meta = await f.metadata(q), original = await f.store.read(meta.artifacts.plan.artifact), changed = Buffer.from(original); changed[10] ^= 1;
  await f.store.write(meta.artifacts.plan.artifact, changed, true);
  await f.open();
  await assert.rejects(f.status(q), reportRejection); await assert.rejects(f.result(q), reportRejection);
  assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.stages.length, 0);
  assert.deepEqual(await f.store.read(meta.artifacts.plan.artifact), changed, 'recovery must not repair corrupt plan bytes or replay the model');
});

for (const pending of ['cleanup', 'settlement', 'schedule']) test(`C2 lifecycle recovery: corrupt completed archive with pending ${pending} retains stop ownership without successful publication`, OPTIONS, async t => {
  const f = await fixture(t), q = await complete(f), meta = await f.metadata(q), sessionId = meta.writer.sessionId;
  const original = await f.store.read(meta.artifacts.plan.artifact), corrupt = Buffer.from(original); corrupt[10] ^= 1; await f.store.write(meta.artifacts.plan.artifact, corrupt, true);
  let scheduleId = null;
  if (pending === 'cleanup') {
    meta.cleanupPending = true; meta.writer.state = 'running'; meta.writer.cleanupPending = true;
    f.sessions.get(sessionId).streaming = true;
  } else if (pending === 'settlement') {
    meta.taskSettlement = 'unknown'; f.tasks.get(meta.taskId).status = 'pending';
  } else {
    scheduleId = 'schedule-c2-recovered'; meta.scheduleId = scheduleId; meta.scheduleCleaned = false;
    // Deliberately no cleanupPending bit: a known live schedule is independently
    // unconfirmed evidence and must not disappear behind a clean-looking flag.
    f.schedules.set(scheduleId, { scheduleId, pluginId: 'hana-math', scope: 'app', handlerKey: 'math-project-report', payload: { projectId: f.p.meta.projectId, reportId: q.reportId, nonce: meta.nonce } });
  }
  await f.saveMetadata(q, meta); f.setConfirmation({ task: false, schedule: false, abort: false });
  await f.open();
  const beforeStop = await closedOrDiagnostic(f, q);
  await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.stages.length, 0);
  if (scheduleId) { assert.equal(f.schedules.has(scheduleId), true); assert.equal((await f.metadata(q)).scheduleId, scheduleId); }
  f.setConfirmation();
  const stopped = await observe(f.stop(q));
  if (stopped.error) { assert.ok(reportRejection(stopped.error)); assert.notEqual(stopped.error.code, 'PROJECT_REPORT_NOT_FOUND'); }
  else notReady(stopped.value);
  const after = await f.metadata(q), afterStop = await closedOrDiagnostic(f, q);
  assert.equal(after.cleanupPending, false, 'confirmed Host resource cleanup is separate from the still-invalid archive');
  assert.equal(after.taskSettlement, 'confirmed');
  if (scheduleId) { assert.equal(f.schedules.has(scheduleId), false); assert.ok(f.calls.unschedules.includes(scheduleId)); }
  if (pending === 'cleanup') { assert.ok(f.calls.aborts.includes(sessionId)); assert.equal(f.sessions.get(sessionId).streaming, false); }
  if (pending === 'settlement') assert.ok(['completed', 'failed', 'aborted', 'canceled'].includes(f.tasks.get(meta.taskId).status));
  assert.match(diagnostic([after, ...afterStop]), /PROJECT_REPORT_ARTIFACT_INVALID/, 'archive error must remain diagnosable after resource cleanup, without choosing a new DTO field');
  assert.deepEqual(await f.store.read(meta.artifacts.plan.artifact), corrupt, 'stop is not an archive repair');
  assert.notEqual(hash(corrupt), meta.artifacts.plan.sha256); assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.stages.length, 0);
  assert.ok(beforeStop.length === 2);
});

test('C2 lifecycle DTO: queued plan is not-ready and has no exact-once coverage', OPTIONS, async t => {
  const f = await fixture(t), q = await f.start(), status = await f.status(q);
  assert.equal(status.state, 'queued'); notReady(status); await assert.rejects(f.result(q), { code: 'PROJECT_REPORT_NOT_READY' });
});

test('C2 lifecycle DTO: running plan is not-ready until both job and settlement finish', OPTIONS, async t => {
  const f = await fixture(t), q = await f.start(), { run } = await writing(f, q);
  try { const status = await f.status(q); assert.equal(status.state, 'running'); notReady(status); }
  finally { const stopping = observe(f.stop(q)); f.releaseHeld(); await stopping; await run; }
});

test('C2 lifecycle DTO: stopped plan is not-ready and uses four plan artifact diagnosis flags', OPTIONS, async t => {
  const f = await fixture(t), q = await f.start(); await f.stop(q);
  const status = await f.status(q), result = await f.result(q); assert.equal(status.state, 'stopped'); notReady(status); notReady(result);
  assert.deepEqual(Object.fromEntries(['responseSaved', 'blocksSaved', 'planSaved', 'ledgerSaved'].map(k => [k, result.diagnosis[k]])), { responseSaved: false, blocksSaved: false, planSaved: false, ledgerSaved: false });
  assert.equal(Object.hasOwn(result.diagnosis, 'sourceSaved'), false);
});

test('C2 lifecycle DTO: interrupted queued plan is not-ready without writer replay', OPTIONS, async t => {
  const f = await fixture(t), q = await f.start(); await f.open();
  const status = await f.status(q), result = await f.result(q); assert.equal(status.state, 'interrupted'); notReady(status); notReady(result);
  assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.stages.length, 0);
});

test('C2 lifecycle DTO: failed planner reports response/blocks/plan/ledger saved flags, not sourceSaved', OPTIONS, async t => {
  const f = await fixture(t), q = await f.start(), { run } = await writing(f, q);
  f.finish(q, { state: 'failed', finalText: 'Opaque retained diagnostic response.' }); await run;
  const status = await f.status(q), result = await f.result(q); assert.equal(status.state, 'failed'); notReady(status); notReady(result);
  assert.deepEqual(Object.fromEntries(['responseSaved', 'blocksSaved', 'planSaved', 'ledgerSaved'].map(k => [k, result.diagnosis[k]])), { responseSaved: true, blocksSaved: false, planSaved: false, ledgerSaved: false });
  assert.equal(Object.hasOwn(result.diagnosis, 'sourceSaved'), false); assert.equal(result.diagnosis.error, (await f.metadata(q)).error);
});

test('C2 lifecycle DTO: partial plan archive failure distinguishes saved response/blocks/plan from unsaved ledger', OPTIONS, async t => {
  const f = await fixture(t); f.memory.failNextLedger(); const q = await complete(f);
  const status = await f.status(q), result = await f.result(q); assert.equal(status.state, 'failed'); notReady(status); notReady(result);
  assert.deepEqual(Object.fromEntries(['responseSaved', 'blocksSaved', 'planSaved', 'ledgerSaved'].map(k => [k, result.diagnosis[k]])), { responseSaved: true, blocksSaved: true, planSaved: true, ledgerSaved: false });
  assert.equal(Object.hasOwn(result.diagnosis, 'sourceSaved'), false); assert.equal(result.diagnosis.error, 'C2_LEDGER_WRITE_FAILED'); assert.equal(f.calls.stages.length, 0);
});

test('C2 lifecycle DTO: completed but unconfirmed NativeTask settlement is not-ready, not reviewable-plan', OPTIONS, async t => {
  const f = await fixture(t); f.setConfirmation({ task: false }); const q = await complete(f), status = await f.status(q);
  assert.equal(status.state, 'completed'); assert.equal(status.taskSettlement, 'unknown'); notReady(status);
  await assert.rejects(f.result(q), { code: 'PROJECT_REPORT_NOT_READY' }); assert.equal(f.calls.stages.length, 0);
});

const B_CAPACITY = 'RESEARCH_RUNTIME_CAPACITY', B_FIELD = 'managedIpcRefusal';
const bRecord = category => ({ version: 1, category });
const bExpected = category => ({ source: 'recorded', category });

for (const legal of [false, true]) test(`B history plan: reload ${legal ? 'projects only recorded categories' : 'omits absent, malformed and non-capacity categories'} with zero read writes`, OPTIONS, async t => {
  const cases = legal ? ['byte-limit', 'directory-limit', 'entry-limit'].map(category => [category, bRecord(category), B_CAPACITY, bExpected(category)])
    : [['no field', undefined, B_CAPACITY], ['unknown version', { ...bRecord('byte-limit'), version: 2 }, B_CAPACITY], ['extra key', { ...bRecord('byte-limit'), source: 'current' }, B_CAPACITY], ['non-capacity', bRecord('byte-limit'), 'C2_NONCAPACITY']];
  const projections = [];
  for (const [label, record, code, expected] of cases) {
    const f = await fixture(t, { runtimeError: code }), q = await f.start(), runView = await f.dispatch(q);
    const meta = await f.metadata(q);
    assert.partialDeepStrictEqual(meta, { state: 'failed', error: code, writer: null, taskSettlement: 'confirmed', cleanupPending: false });
    assert.equal(Object.hasOwn(meta, B_FIELD), false, 'plain fixture error is not runtime category proof');
    assert.equal(Object.hasOwn(runView, B_FIELD), false, 'generic producer view does not project the field');
    // Simulate historical bytes only, never a current refusal or runtime proof.
    if (record !== undefined) { meta[B_FIELD] = record; await f.saveMetadata(q, meta); }
    const writes = f.memory.writes.length, tasks = clone(f.tasks);
    await f.open();
    const bind = method => (args, ctx) => { assert.equal(args.projectId, f.p.meta.projectId); return f.service[method](f.p, args, ctx, KIND); };
    const tool = await reportReadoutTool(t, { paperPlanStatus: bind('status'), paperPlanResult: bind('result'), paperPlanStop: bind('stop') });
    const read = action => tool.execute({ action, projectId: q.projectId, reportId: q.reportId, context: owner });
    const actions = ['paper_plan_status', 'paper_plan_result', 'paper_plan_status', 'paper_plan_result'];
    const actual = [];
    for (const action of actions) {
      const out = await read(action); const dto = out.details;
      assert.equal(out.isError, false); assert.deepEqual(JSON.parse(out.content[0].text), dto);
      assert.partialDeepStrictEqual(dto, { kind: KIND.kind, reportId: q.reportId, state: 'failed', error: code, cleanupPending: false, taskSettlement: 'confirmed' });
      if (action === 'paper_plan_result') assert.partialDeepStrictEqual(dto, { saved: true, files: [], diagnosis: { error: code } });
      actual.push(Object.hasOwn(dto, B_FIELD) ? { value: dto[B_FIELD] } : null);
    }
    const stop = await read('paper_plan_stop'); assert.equal(stop.isError, true); assert.equal(stop.details.error, code);
    assert.equal(Object.hasOwn(stop.details, B_FIELD), false);
    assert.equal(f.memory.writes.length, writes); assert.deepEqual(await f.metadata(q), meta); assert.deepEqual(f.tasks, tasks);
    assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.stages.length, 0); assert.equal(f.calls.stops.length, 0);
    projections.push({ label, actual, expected: actions.map(() => expected === undefined ? null : { value: expected }) });
  }
  t.diagnostic(JSON.stringify(projections));
  assert.deepEqual(projections.map(row => row.actual), projections.map(row => row.expected), 'history projection differs from recorded-only contract');
});

test('B history plan: dirty corrupt recovery retains cleanup entry and removes stale evidence in its existing error save', OPTIONS, async t => {
  const rows = [];
  for (const [label, record] of [['absent', undefined], ['valid shape', bRecord('directory-limit')], ['malformed', { version: 1, category: 'unknown' }]]) {
    const f = await fixture(t); f.setConfirmation({ task: false }); const q = await complete(f), archived = await f.metadata(q);
    assert.partialDeepStrictEqual(archived, { state: 'completed', cleanupPending: false, taskSettlement: 'unknown' });
    assert.equal(f.tasks.get(q.taskId).status, 'pending');
    const path = archived.artifacts.plan.artifact, corrupt = Buffer.from('B_HISTORY_CORRUPT'); await f.store.write(path, corrupt, true);
    if (record !== undefined) { archived[B_FIELD] = record; await f.saveMetadata(q, archived); }
    const saves = []; f.memory.observers.add(m => { if (m.reportId === q.reportId) saves.push(m); });
    await f.open();
    const loaded = await f.metadata(q), loadWrites = saves.length;
    assert.partialDeepStrictEqual(loaded, { state: 'interrupted', error: 'PROJECT_REPORT_ARTIFACT_INVALID', archiveError: 'PROJECT_REPORT_ARTIFACT_INVALID', taskSettlement: 'unknown' });
    assert.equal(loadWrites, 2, 'existing archive downgrade and attempted task settlement each save once');
    assert.equal(saves[0].error, loaded.error);
    const [status, result] = await closedOrDiagnostic(f, q);
    assert.equal(status.value?.archiveError, loaded.error); assert.equal(result.value?.diagnosis?.archiveError, loaded.error);
    assert.ok([status.value, result.value].every(v => !Object.hasOwn(v, B_FIELD)));
    await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY', reportId: q.reportId });
    assert.equal(saves.length, loadWrites, 'reads and BUSY do not save');
    f.setConfirmation(); const stopped = await f.stop(q);
    assert.partialDeepStrictEqual(stopped, { state: 'interrupted', publicationStatus: 'not-ready', cleanupPending: false, taskSettlement: 'confirmed' });
    assert.equal(Object.hasOwn(stopped, B_FIELD), false); assert.deepEqual(await f.store.read(path), corrupt);
    const replacement = await f.start(); assert.equal(replacement.state, 'queued'); await f.stop(replacement);
    assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.stages.length, 0);
    rows.push({ label, loadWrites, reportWrites: saves.length, fieldsInErrorSaves: saves.map(m => Object.hasOwn(m, B_FIELD)) });
  }
  t.diagnostic(JSON.stringify(rows));
  assert.ok(rows.every(row => row.loadWrites === rows[0].loadWrites && row.reportWrites === rows[0].reportWrites));
  assert.ok(rows.every(row => row.fieldsInErrorSaves.every(hasField => !hasField)), 'the first existing save of the new main error must remove even a malformed old category');
});

test('B history plan: intact completed but unsettled stays BUSY until the original task is confirmed', OPTIONS, async t => {
  for (const record of [undefined, bRecord('byte-limit'), { version: 1, category: false }]) {
    const f = await fixture(t); f.setConfirmation({ task: false }); const q = await complete(f), meta = await f.metadata(q);
    assert.partialDeepStrictEqual(meta, { state: 'completed', taskSettlement: 'unknown', cleanupPending: false });
    if (record !== undefined) { meta[B_FIELD] = record; await f.saveMetadata(q, meta); }
    const writes = f.memory.writes.length; await f.open(); const loaded = await f.metadata(q);
    assert.equal(f.memory.writes.length - writes, 1, 'only the existing unconfirmed settlement save');
    assert.deepEqual(loaded, meta, 'no main-error replacement, so leave even malformed history unchanged');
    const status = await f.status(q); notReady(status); assert.equal(Object.hasOwn(status, B_FIELD), false);
    await assert.rejects(f.result(q), { code: 'PROJECT_REPORT_NOT_READY' });
    await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY', reportId: q.reportId });
    assert.equal(f.memory.writes.length - writes, 1);
    f.setConfirmation(); const stopped = await f.stop(q); assert.equal(Object.hasOwn(stopped, B_FIELD), false);
    assert.partialDeepStrictEqual(stopped, { taskSettlement: 'confirmed', cleanupPending: false });
    const replacement = await f.start(); assert.equal(replacement.state, 'queued'); await f.stop(replacement);
    assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.stages.length, 0);
  }
});
