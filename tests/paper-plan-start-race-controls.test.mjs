// C2b-owned controls. Independent fixture; never import another test module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProjectReportService } from '../packages/hana-math/project-report-service.mjs';
import { capturePlanMaterial } from '../packages/hana-math/paper-plan.mjs';

const clone = value => structuredClone(value), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const DENIED = 'C2B_LATE_CREATOR_DENIED', UNKNOWN = 'C2B_SCHEDULE_RECEIPT_UNKNOWN';
const KIND = { kind: 'paper-plan' }, OPTIONS = { timeout: 10000 };
function defer() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

async function fixture(t, mode) {
  const files = new Map(), tasks = new Map(), schedules = new Map(), jobs = [], entered = defer(), release = defer();
  const creator = { sessionId: 'c2b-creator', sessionPath: '/fixture/c2b/creator.jsonl' }, owner = { sessionPath: creator.sessionPath, callToken: 'mock-only' };
  const p = { meta: { projectId: 'c2b-controls', creator } }, factId = 'a'.repeat(16);
  const fact = { fact_id: factId, predecessors: [], markdown: `---\nfact_id: ${factId}\npredecessors: []\nexternal_refs: []\n---\n## statement\nOpaque.\n## proof\nOpaque.\n` };
  const target = { schemaVersion: 1, projectId: p.meta.projectId, paperId: 'main', factIds: [factId], factDigests: { [factId]: hash(fact.markdown) }, finalizedBy: 'creator', at: 1 };
  const gathered = () => ({ facts: [clone(fact)], asOf: 'c2b-control' });
  const output = `%%%PREAMBLE%%%\nOpaque\n%%%FRONTMATTER%%%\nOpaque\n%%%SECTIONS%%%\n[{"title":"Opaque","label":"sec:opaque","fact_ids":["${factId}"]}]\n%%%BIBLIOGRAPHY%%%\nOpaque\n`;
  const args = { kind: 'paper-plan', language: 'English', plan: { paperId: 'main', target, brief: 'Opaque', instructions: '', material: capturePlanMaterial({ ...gathered(), target }).material } };
  let handler, service, firstSchedule = true, postReceipt = false, deny = false, sequence = 0, reportId, handlerRun, frozen, writeFailed = false;
  const calls = { starts: [], stops: [], fail: [], complete: [], stages: [], denied: 0 };
  const store = {
    absolute: name => '/fixture/c2b/data/' + name,
    async mkdir(name) { return store.absolute(name); },
    async read(name) { if (!files.has(name)) throw fail('ENOENT'); return Buffer.from(files.get(name)); },
    async readJson(name) { return JSON.parse((await store.read(name)).toString('utf8')); },
    async list(name) { const prefix = name + '/'; return [...new Set([...files.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length).split('/')[0]))]; },
    async write(name, bytes, replace = false) {
      assert.ok(!name.startsWith('/') && !name.split('/').includes('..'));
      if (name.endsWith('/metadata.json')) {
        const meta = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (mode === 'failed-save' && !writeFailed && meta.stopRequested && meta.error === DENIED) { writeFailed = true; throw fail('C2B_METADATA_WRITE_FAILED'); }
      }
      if (!replace && files.has(name)) throw fail('EEXIST'); files.set(name, Buffer.from(bytes));
    },
  };
  function dispatch(row) {
    handlerRun = handler.run({ kind: 'schedule', scheduleId: row.scheduleId, input: clone(row.payload) });
    handlerRun.catch(() => {}); return handlerRun;
  }
  const sdk = {
    tasks: {
      async registerHandler(_key, value) { handler = value; return () => {}; },
      async create(input) { const row = { ...clone(input), pluginId: 'hana-math', taskId: `c2b-task-${++sequence}`, parentSessionId: creator.sessionId, parentSessionPath: creator.sessionPath, status: 'pending' }; tasks.set(row.taskId, row); return clone(row); },
      async get(id) {
        const receipt = clone(tasks.get(id));
        if (postReceipt) {
          postReceipt = false; dispatch([...schedules.values()][0]);
          await entered.promise; deny = true;
        }
        return receipt;
      },
      async schedule(input) {
        const row = { ...clone(input), pluginId: 'hana-math', scheduleId: `c2b-schedule-${++sequence}` }; schedules.set(row.scheduleId, row);
        if (firstSchedule) {
          firstSchedule = false; reportId = input.payload.reportId;
          if (mode === 'schedule-unknown') { dispatch(row); await entered.promise; throw fail(UNKNOWN); }
          if (mode !== 'asof') postReceipt = true;
        }
        return clone(row);
      },
      async unschedule(id) { schedules.delete(id); return { ok: true }; },
      async complete(id, result) { calls.complete.push(id); Object.assign(tasks.get(id), { status: 'completed', result: clone(result) }); return clone(tasks.get(id)); },
      async fail(id, error) { calls.fail.push({ id, error }); Object.assign(tasks.get(id), { status: 'failed', error }); return clone(tasks.get(id)); },
      async getDelivery() { return { state: 'published', delivered: false }; },
    },
    resources: { async stage(input) { calls.stages.push(input); throw fail('C2B_UNEXPECTED_STAGE'); } },
  };
  const writer = {
    async start(input) {
      calls.starts.push(input.reportId);
      const binding = { role: 'report-writer', agentId: 'math-paper-planner-01234567-89ab-cdef-0123-456789abcdef', sessionId: 'c2b-session', sessionPath: '/fixture/c2b/writer.jsonl', cwd: input.cwd,
        kind: `math-paper-plan:${p.meta.projectId}:${input.reportId}`, sendState: 'accepted', sendPending: false };
      await input.onBound(binding); await input.onUpdate({ ...binding, state: 'running', cleanupPending: true });
      return { done: Promise.resolve({ ...binding, state: 'completed', cleanupPending: false, modelStopReason: 'stop', finalText: output }), async stop() { calls.stops.push(input.reportId); return { ...binding, state: 'stopped', cleanupPending: false }; } };
    }, async dispose() { return { cleanupPending: false }; },
  };
  const admission = {
    async authorize() {
      if (!deny) return;
      deny = false; calls.denied++;
      if (mode === 'late-completed') { await handlerRun; frozen = new Map([...files].map(([name, bytes]) => [name, Buffer.from(bytes)])); }
      throw fail(DENIED);
    }, guard() {}, async gather() { return gathered(); },
  };
  service = await createProjectReportService({ sdk, store, summaryWriter: writer, projects: () => [p], getProject: () => p, projectLocation: () => 'project',
    async authorizeCreator(_p, ctx) { assert.equal(ctx, owner); }, assertLive() {}, track(_p, job) { jobs.push(job); job.catch(() => {}); return job; },
    async assertPaperTarget(_id, received) { assert.deepEqual(received, target); },
    async gatherPaperFacts(_id, authority) { entered.resolve(); if (!['late-completed', 'asof'].includes(mode)) await release.promise; await authority.guard(); authority.assertActive(); return gathered(); },
    async withPaperPublication(_id, authority, _target, callback) {
      await authority.guard(); authority.assertActive();
      return callback(mode === 'asof' ? { ...gathered(), asOf: 'c2b-unrelated-advance' } : gathered());
    },
  });
  t.after(async () => { release.resolve(); await Promise.allSettled([handlerRun, ...jobs]); await service.dispose(); });
  return { files, tasks, calls, release, material: clone(args.plan.material), start: () => service.start(p, clone(args), owner, admission),
    dispatch: () => dispatch([...schedules.values()][0]),
    get reportId() { return reportId; }, get handlerRun() { return handlerRun; }, get frozen() { return frozen; }, get writeFailed() { return writeFailed; },
    metadata: () => store.readJson(`project/reports/${reportId}/metadata.json`), status: () => service.status(p, { reportId }, owner, KIND),
    stop: q => service.stop(p, q ?? { reportId }, owner, KIND) };
}

test('C2b control: late caller admission failure never rewrites a durable completed settled plan', OPTIONS, async t => {
  const f = await fixture(t, 'late-completed');
  await assert.rejects(f.start(), { code: DENIED }); await f.handlerRun;
  const meta = await f.metadata(); assert.equal(meta.state, 'completed'); assert.equal(meta.taskSettlement, 'confirmed'); assert.equal(meta.stopRequested, false); assert.equal(meta.error, undefined);
  assert.equal((await f.status()).publicationStatus, 'reviewable-plan');
  assert.deepEqual(f.files, f.frozen, 'caller failure changes neither persisted metadata nor archive bytes');
  assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.stops.length, 0); assert.equal(f.calls.fail.length, 0); assert.equal(f.calls.complete.length, 1); assert.equal(f.calls.denied, 1); assert.equal(f.calls.stages.length, 0);
  const fresh = await f.start(); assert.notEqual(fresh.reportId, meta.reportId); await f.stop(fresh);
});

test('C2b control: handler before uncertain schedule receipt retains unknown creation and original failure after job joins', OPTIONS, async t => {
  const f = await fixture(t, 'schedule-unknown');
  await assert.rejects(f.start(), { code: UNKNOWN });
  await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  f.release.resolve(); await f.handlerRun;
  const meta = await f.metadata(); assert.equal(meta.error, UNKNOWN); assert.equal(meta.scheduleCreating, true); assert.equal(meta.cleanupPending, true); assert.equal(meta.taskSettlement, 'confirmed');
  assert.equal(meta.stopRequested, true); assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.stages.length, 0);
  await f.stop(); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  assert.equal((await f.metadata()).cleanupPending, true, 'known unschedule does not certify an unknown schedule creation receipt');
});

test('C2b control: failed metadata save cannot become clean when the stopped original job joins', OPTIONS, async t => {
  const f = await fixture(t, 'failed-save');
  await assert.rejects(f.start(), { code: DENIED }); assert.equal(f.writeFailed, true);
  await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  f.release.resolve(); await f.handlerRun;
  const meta = await f.metadata(); assert.equal(meta.error, DENIED); assert.equal(meta.cleanupPending, true); assert.equal(meta.taskSettlement, 'confirmed');
  assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.stages.length, 0);
  await f.stop(); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  assert.equal((await f.status()).publicationStatus, 'not-ready');
});

test('C2b control: unrelated publication asOf advance is reported without resampling plan material', OPTIONS, async t => {
  const f = await fixture(t, 'asof'), q = await f.start(); await f.dispatch();
  const meta = await f.metadata(), status = await f.status(), task = f.tasks.get(q.taskId);
  assert.equal(meta.state, 'completed'); assert.equal(meta.taskSettlement, 'confirmed'); assert.equal(status.publicationStatus, 'reviewable-plan');
  assert.equal(meta.asOf, 'c2b-control'); assert.deepEqual(meta.plan.material, f.material);
  assert.equal(meta.plan.material.admissionAsOf, 'c2b-control');
  for (const value of [meta, status, task.result]) assert.equal(value.snapshotAdvancedDuringWriting, true);
  const plan = JSON.parse(f.files.get(meta.artifacts.plan.artifact).toString('utf8'));
  assert.deepEqual(plan.binding.material, f.material); assert.deepEqual(plan.coverage.factIds, f.material.coverageFactIds);
  assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.stops.length, 0); assert.equal(f.calls.stages.length, 0);
});
