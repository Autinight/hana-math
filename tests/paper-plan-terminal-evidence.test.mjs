// C3-owned terminal evidence / pending-settlement controls. No live Host/model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProjectReportService } from '../packages/hana-math/project-report-service.mjs';
import { capturePlanMaterial } from '../packages/hana-math/paper-plan.mjs';

const clone = value => structuredClone(value), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fault = code => Object.assign(new Error(code), { code });
const DENIED = 'C3_LATE_CREATOR_DENIED', PUBLICATION = 'C3_PUBLICATION_REJECTED', SENTINEL = 'C3_BODY_PRIVATE_SENTINEL';
const KIND = { kind: 'paper-plan' }, OPTIONS = { timeout: 10000 };
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
function plannerText(nearLimit) {
  const prefix = `%%%PREAMBLE%%%\n${SENTINEL}\n`, suffix = '\n%%%FRONTMATTER%%%\nOpaque\n%%%SECTIONS%%%\n[{"title":"Opaque","label":"sec:c3","fact_ids":["aaaaaaaaaaaaaaaa"]}]\n%%%BIBLIOGRAPHY%%%\nOpaque\n';
  const bytes = nearLimit ? 512 * 1024 - 64 : 1024;
  const text = prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
  assert.equal(Buffer.byteLength(text), bytes); assert.ok(bytes <= 512 * 1024, 'real research-session final-text budget is inclusive, not truncation');
  return text;
}

async function fixture(t, { mode = 'publication', nearLimit = false } = {}) {
  const files = new Map(), tasks = new Map(), schedules = new Map(), services = [], jobs = [];
  const publicationEntered = deferred(), publicationRelease = deferred(), completeEntered = deferred(), completeRelease = deferred(), denied = deferred(), stopIntent = deferred();
  const creator = { sessionId: 'c3-creator', sessionPath: '/fixture/c3/creator.jsonl' }, owner = { sessionPath: creator.sessionPath, callToken: 'mock-c3-only' };
  const p = { meta: { projectId: 'c3-terminal-evidence', creator } }, factId = 'a'.repeat(16);
  const fact = { fact_id: factId, predecessors: [], markdown: `---\nfact_id: ${factId}\npredecessors: []\nexternal_refs: []\n---\n## statement\nOpaque.\n## proof\nOpaque.\n` };
  const target = { schemaVersion: 1, projectId: p.meta.projectId, paperId: 'main', factIds: [factId], factDigests: { [factId]: hash(fact.markdown) }, finalizedBy: 'creator', at: 1 };
  const gathered = () => ({ facts: [clone(fact)], asOf: 'c3-capture' });
  const args = { kind: 'paper-plan', language: 'English', plan: { paperId: 'main', target, brief: 'Opaque', instructions: '', material: capturePlanMaterial({ ...gathered(), target }).material } };
  const text = plannerText(nearLimit), calls = { starts: [], stops: [], complete: [], fail: [], gather: 0, stage: 0 };
  let service, handler, sequence = 0, reportId, handlerRun, postReceipt = false, denyOnce = false, firstSchedule = true, stopConfirmed = false, frozen;
  const metadataPath = () => `project/reports/${reportId}/metadata.json`;
  const store = {
    absolute: name => '/fixture/c3/data/' + name,
    async mkdir(name) { return store.absolute(name); },
    async read(name) { if (!files.has(name)) throw fault('ENOENT'); return Buffer.from(files.get(name)); },
    async readJson(name) { return JSON.parse((await store.read(name)).toString('utf8')); },
    async list(name) { const prefix = name + '/'; return [...new Set([...files.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length).split('/')[0]))]; },
    async write(name, bytes, replace = false) {
      assert.ok(!name.startsWith('/') && !name.split('/').includes('..'));
      if (!replace && files.has(name)) throw fault('EEXIST'); files.set(name, Buffer.from(bytes));
      if (name === metadataPath() && JSON.parse(Buffer.from(bytes).toString('utf8')).stopRequested) stopIntent.resolve();
    },
  };
  function dispatch(row) {
    handlerRun = handler.run({ kind: 'schedule', scheduleId: row.scheduleId, input: clone(row.payload) });
    handlerRun.catch(() => {}); return handlerRun;
  }
  const sdk = {
    tasks: {
      async registerHandler(_key, value) { handler = value; return () => {}; },
      async create(input) { const row = { ...clone(input), pluginId: 'hana-math', taskId: `c3-task-${++sequence}`, parentSessionId: creator.sessionId, parentSessionPath: creator.sessionPath, status: 'pending' }; tasks.set(row.taskId, row); return clone(row); },
      async get(id) {
        const receipt = clone(tasks.get(id));
        if (postReceipt) {
          postReceipt = false; dispatch([...schedules.values()][0]);
          await (mode === 'settlement' ? completeEntered.promise : publicationEntered.promise);
          denyOnce = true;
        }
        return receipt;
      },
      async schedule(input) {
        const row = { ...clone(input), pluginId: 'hana-math', scheduleId: `c3-schedule-${++sequence}` }; schedules.set(row.scheduleId, row);
        if (firstSchedule) { firstSchedule = false; reportId = input.payload.reportId; postReceipt = ['admission', 'settlement'].includes(mode); }
        return clone(row);
      },
      async unschedule(id) { schedules.delete(id); return { ok: true }; },
      async complete(id, result) {
        calls.complete.push(id);
        if (mode === 'settlement') {
          assert.equal((await store.readJson(metadataPath())).state, 'completed', 'producer completion must already be durable at the ack barrier');
          frozen = new Map([...files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
          completeEntered.resolve(); await completeRelease.promise;
        }
        Object.assign(tasks.get(id), { status: 'completed', result: clone(result) }); return clone(tasks.get(id));
      },
      async fail(id, error) { calls.fail.push({ id, error }); Object.assign(tasks.get(id), { status: 'failed', error }); return clone(tasks.get(id)); },
      async getDelivery() { return { state: 'published', delivered: false }; },
    },
    resources: { async stage() { calls.stage++; throw fault('C3_UNEXPECTED_STAGE'); } },
  };
  const writer = {
    async start(input) {
      calls.starts.push(input.reportId);
      const binding = { role: 'report-writer', agentId: 'math-paper-planner-01234567-89ab-cdef-0123-456789abcdef', sessionId: `c3-writer-${input.reportId}`, sessionPath: `/fixture/c3/${input.reportId}.jsonl`,
        cwd: input.cwd, kind: `math-paper-plan:${p.meta.projectId}:${input.reportId}`, sendState: 'accepted', sendPending: false };
      await input.onBound(binding); await input.onUpdate({ ...binding, state: 'running', cleanupPending: true });
      const terminal = { ...binding, state: 'completed', cleanupPending: false, modelStopReason: 'stop', finalText: text };
      return { done: Promise.resolve(clone(terminal)), async stop() { calls.stops.push(input.reportId); return { ...clone(terminal), cleanupPending: !stopConfirmed }; } };
    }, async dispose() { return { cleanupPending: false }; },
  };
  const admission = {
    async authorize() { if (denyOnce) { denyOnce = false; denied.resolve(); throw fault(DENIED); } }, guard() {}, async gather() { return gathered(); },
  };
  async function open() {
    service = await createProjectReportService({ sdk, store, summaryWriter: writer, projects: () => [p], getProject: () => p, projectLocation: () => 'project',
      async authorizeCreator(_p, ctx) { assert.equal(ctx, owner); }, assertLive() {}, track(_p, job) { jobs.push(job); job.catch(() => {}); return job; },
      async assertPaperTarget(_id, received) { assert.deepEqual(received, target); },
      async gatherPaperFacts(_id, authority) { calls.gather++; await authority.guard(); authority.assertActive(); return gathered(); },
      async withPaperPublication(_id, authority, _target, callback) {
        if (mode === 'publication') throw fault(PUBLICATION);
        if (mode === 'admission') { publicationEntered.resolve(); await publicationRelease.promise; }
        await authority.guard(); authority.assertActive(); return callback(gathered());
      },
    });
    services.push(service); return service;
  }
  await open();
  t.after(async () => { stopConfirmed = true; publicationRelease.resolve(); completeRelease.resolve(); await Promise.allSettled([handlerRun, ...jobs]); for (const instance of services) await instance.dispose(); });
  return { files, tasks, calls, text, denied, stopIntent, completeEntered, completeRelease, publicationRelease,
    start: () => service.start(p, clone(args), owner, admission), open, confirmStop() { stopConfirmed = true; },
    dispatch: () => dispatch([...schedules.values()][0]), get reportId() { return reportId; }, get handlerRun() { return handlerRun; }, get frozen() { return frozen; },
    metadata: () => store.readJson(metadataPath()), metadataBytes: () => store.read(metadataPath()),
    raw: () => store.read(`project/reports/${reportId}/raw-response.txt`),
    status: () => service.status(p, { reportId }, owner, KIND), result: () => service.result(p, { reportId }, owner, KIND),
    stop: q => service.stop(p, q ?? { reportId }, owner, KIND), dispose: () => service.dispose() };
}

async function noBody(f) {
  const meta = await f.metadata(), bytes = await f.metadataBytes();
  assert.equal(Object.hasOwn(meta.writer, 'finalText'), false, 'every saved plan writer snapshot excludes finalText');
  assert.equal(bytes.includes(Buffer.from(SENTINEL)), false, 'body sentinel cannot leak through another metadata field');
  assert.ok(bytes.length < 16 * 1024, 'near-512KiB body must not enlarge metadata');
  assert.equal(meta.writer.role, 'report-writer'); assert.equal(meta.writer.kind, `math-paper-plan:c3-terminal-evidence:${f.reportId}`);
  assert.equal(meta.writer.sessionId, `c3-writer-${f.reportId}`); assert.equal(meta.writer.modelStopReason, 'stop');
  return meta;
}
async function reloadAndReuse(f) {
  const gathers = f.calls.gather, raw = await f.raw(); await f.open();
  assert.equal(f.calls.gather, gathers, 'recovery never resamples canonical material'); assert.equal(f.calls.starts.length, 1);
  assert.equal((await f.status()).cleanupPending, false); assert.deepEqual(await f.raw(), raw);
  const fresh = await f.start(); assert.notEqual(fresh.reportId, f.reportId); await f.stop(fresh); assert.equal(f.calls.starts.length, 1);
}

for (const nearLimit of [false, true]) test(`C3 evidence: ${nearLimit ? 'near-512KiB' : 'normal'} completed response survives publication failure and explicit clean stop without metadata body`, OPTIONS, async t => {
  const f = await fixture(t, { nearLimit }); await f.start(); await f.dispatch();
  const before = await noBody(f), raw = await f.raw();
  assert.equal(before.state, 'failed'); assert.equal(before.error, PUBLICATION); assert.equal(before.cleanupPending, true); assert.equal(f.calls.stops.length, 1);
  assert.deepEqual(raw, Buffer.from(f.text)); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  f.confirmStop(); await f.stop();
  const after = await noBody(f); assert.equal(after.cleanupPending, false); assert.equal(after.writer.cleanupPending, false); assert.equal(after.taskSettlement, 'confirmed');
  assert.deepEqual(await f.raw(), raw); assert.equal(f.calls.stage, 0); await reloadAndReuse(f);
});

test('C3 evidence: dispose uses the same body-free plan stop evidence and preserves raw bytes', OPTIONS, async t => {
  const f = await fixture(t); await f.start(); await f.dispatch(); const raw = await f.raw();
  assert.equal((await noBody(f)).cleanupPending, true); f.confirmStop();
  assert.equal((await f.dispose()).cleanupPending, false);
  assert.equal((await noBody(f)).cleanupPending, false); assert.deepEqual(await f.raw(), raw); await reloadAndReuse(f);
});

test('C3 evidence: failStartedPlan stopping a live producer with a completed near-512KiB body never persists that body', OPTIONS, async t => {
  const f = await fixture(t, { mode: 'admission', nearLimit: true }), starting = observe(f.start());
  await f.denied.promise; await Promise.race([starting, f.stopIntent.promise]);
  const first = await starting; assert.equal(first.error?.code, DENIED); assert.equal(first.error.reportId, f.reportId);
  const during = await noBody(f); assert.equal(during.cleanupPending, true); assert.ok(f.calls.stops.length >= 1);
  const raw = await f.raw(); assert.deepEqual(raw, Buffer.from(f.text)); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  f.publicationRelease.resolve(); await f.handlerRun;
  assert.equal((await noBody(f)).error, DENIED); f.confirmStop(); await f.stop();
  assert.equal((await noBody(f)).cleanupPending, false); assert.deepEqual(await f.raw(), raw); await reloadAndReuse(f);
});

test('C3 settlement: late caller denial cannot rewrite durable completed producer while NativeTask complete ack is pending', OPTIONS, async t => {
  const f = await fixture(t, { mode: 'settlement' }), starting = observe(f.start());
  await f.completeEntered.promise; await f.denied.promise; await Promise.race([starting, f.stopIntent.promise]);
  const pending = await f.metadata();
  assert.equal(pending.state, 'completed', 'NativeTask receipt is not producer failure'); assert.equal(pending.cleanupPending, false); assert.equal(pending.stopRequested, false); assert.equal(pending.error, undefined);
  assert.notEqual(pending.taskSettlement, 'confirmed'); assert.deepEqual(f.files, f.frozen, 'late caller failure writes neither metadata nor archived bytes');
  const status = await f.status(); assert.equal(status.publicationStatus, 'not-ready'); assert.equal(status.coverageStatus, 'not-established'); assert.equal(Object.hasOwn(status, 'coverage'), false);
  await assert.rejects(f.result(), { code: 'PROJECT_REPORT_NOT_READY' }); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.stops.length, 0); assert.equal(f.calls.fail.length, 0); assert.equal(f.calls.complete.length, 1);
  f.completeRelease.resolve(); const first = await starting; await f.handlerRun;
  assert.equal(first.error?.code, DENIED); assert.equal(first.error.reportId, f.reportId);
  const settled = await f.metadata(); assert.equal(settled.state, 'completed'); assert.equal(settled.taskSettlement, 'confirmed'); assert.equal(settled.stopRequested, false); assert.equal(settled.error, undefined);
  assert.equal((await f.status()).coverageStatus, 'exact-once'); assert.equal((await f.status()).publicationStatus, 'reviewable-plan');
  for (const [name, bytes] of f.frozen) if (!name.endsWith('/metadata.json')) assert.deepEqual(f.files.get(name), bytes);
  const fresh = await f.start(); assert.notEqual(fresh.reportId, f.reportId); await f.stop(fresh); assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.stage, 0);
});
