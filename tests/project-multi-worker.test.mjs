// Multi-worker software fixtures. No real model, network or private data.
import test from 'node:test';
import { fixtureFactPage } from './fact-page-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defer, fixture, origin } from './helpers/project-service-fixture.mjs';
const multiWorkerFixture = (t, behavior = {}) => fixture(t, { ...behavior, multiWorker: true });

const admissionsTurn = () => new Promise(resolve => setImmediate(resolve));
const projectFile = (f, id) => path.join(f.dataDir, 'research/projects', id, 'project.json');
const readMeta = async (f, id) => JSON.parse(await fs.readFile(projectFile(f, id)));
const createTwo = f => f.create({ problem: 'opaque multi-worker problem', workers: 2 });

test('create workers:2 prepares two worker workspaces and persists extraWorkers', async t => {
  const f = await multiWorkerFixture(t), p = await createTwo(f);
  assert.equal(p.status.state, 'ready');
  for (const id of ['worker-1', 'worker-2']) {
    const receipt = JSON.parse(await fs.readFile(path.join(f.dataDir, 'context/projects', p.projectId, 'workers', id, 'project-workspace.json')));
    assert.equal(receipt.workerId, id); assert.equal(receipt.role, 'worker');
  }
  await assert.rejects(fs.stat(path.join(f.dataDir, 'context/projects', p.projectId, 'workers/worker-3')), { code: 'ENOENT' });
  const meta = await readMeta(f, p.projectId);
  assert.equal(meta.worker.workerId, 'worker-1');
  assert.deepEqual(Object.keys(meta.worker).sort(), ['assignment', 'lastRun', 'runs', 'start', 'status', 'workerId']);
  assert.deepEqual(meta.extraWorkers, [{ workerId: 'worker-2', assignment: { state: 'unassigned' }, start: { state: 'idle' }, lastRun: null, runs: [], status: null }]);
});

test('create rejects workers 0, 5, non-integer and non-number before any task', async t => {
  const f = await multiWorkerFixture(t);
  for (const workers of [0, 5, 1.5, '2', null, -1]) {
    await assert.rejects(f.service.create({ problem: 'opaque invalid workers', workers }, origin), { code: 'PROJECT_INVALID_INPUT' });
  }
  assert.equal(f.calls.tasks.length, 0); assert.equal(f.calls.sessions.length, 0);
});

test('N=2 assign/start require workerId and deny out-of-range ids', async t => {
  const f = await multiWorkerFixture(t), p = await createTwo(f);
  await assert.rejects(f.service.assign({ task: 'opaque' }, p.context), { code: 'PROJECT_WORKER_REQUIRED' });
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'PROJECT_WORKER_REQUIRED' });
  for (const workerId of ['worker-3', 'worker-0', 'worker-one']) {
    await assert.rejects(f.service.assign({ task: 'opaque', workerId }, p.context), { code: 'PROJECT_WORKER_DENIED' });
    await assert.rejects(f.service.start({ projectId: p.projectId, workerId }, p.context), { code: 'PROJECT_WORKER_DENIED' });
    await assert.rejects(f.service.stop({ projectId: p.projectId, workerId }, p.context), { code: 'PROJECT_WORKER_DENIED' });
  }
  assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.stops.length, 0);
  const meta = await readMeta(f, p.projectId);
  assert.equal(meta.worker.assignment.state, 'unassigned'); assert.equal(meta.extraWorkers[0].assignment.state, 'unassigned');
});

test('worker-1 and worker-2 assign and start independently; second start is not blocked by the first active run', async t => {
  const f = await multiWorkerFixture(t), p = await createTwo(f);
  const a1 = await f.service.assign({ task: 'opaque task one', workerId: 'worker-1' }, p.context);
  const a2 = await f.service.assign({ task: 'opaque task two', workerId: 'worker-2' }, p.context);
  assert.equal(a1.workerId, 'worker-1'); assert.equal(a2.workerId, 'worker-2');
  for (const [id, body] of [['worker-1', 'opaque task one\n'], ['worker-2', 'opaque task two\n']]) {
    assert.equal(await fs.readFile(path.join(f.dataDir, 'context/projects', p.projectId, 'workers', id, 'TASK.md'), 'utf8'), body);
  }
  const r1 = await f.service.start({ projectId: p.projectId, workerId: 'worker-1' }, p.context);
  assert.equal(r1.state, 'running');
  // worker-1 is active: the same worker is refused, the other is not.
  await assert.rejects(f.service.start({ projectId: p.projectId, workerId: 'worker-1' }, p.context), { code: 'PROJECT_WORKER_UNSETTLED' });
  const r2 = await f.service.start({ projectId: p.projectId, workerId: 'worker-2' }, p.context);
  assert.equal(r2.state, 'running'); assert.notEqual(r1.runId, r2.runId);
  assert.deepEqual(f.calls.starts.map(s => s.input.workerId), ['worker-1', 'worker-2']);
  const meta = await readMeta(f, p.projectId);
  assert.deepEqual(meta.worker.runs, [r1.runId]); assert.equal(meta.worker.lastRun, r1.runId); assert.equal(meta.worker.start.state, 'started');
  assert.deepEqual(meta.extraWorkers[0].runs, [r2.runId]); assert.equal(meta.extraWorkers[0].lastRun, r2.runId); assert.equal(meta.extraWorkers[0].start.state, 'started');
  assert.deepEqual(meta.assignmentHistory.assignments.map(a => [a.workerId, a.lastRun]), [['worker-1', null], ['worker-2', null]]);
  const view = await f.service.status(p.projectId, origin);
  assert.deepEqual(view.assignmentHistory.assignments.map(a => a.workerId), ['worker-1', 'worker-2']);
});

test('stop without workerId requests stop on all workers; with workerId only that one', async t => {
  const f = await multiWorkerFixture(t), p = await createTwo(f);
  const runs = {};
  for (const id of ['worker-1', 'worker-2']) {
    await f.service.assign({ task: `opaque ${id}`, workerId: id }, p.context);
    runs[id] = (await f.service.start({ projectId: p.projectId, workerId: id }, p.context)).runId;
  }
  const one = await f.service.stop({ projectId: p.projectId, workerId: 'worker-2' }, p.context);
  assert.deepEqual(f.calls.stops.map(s => s.runId), [runs['worker-2']]);
  assert.equal(one.workers[1].stopRequested, true); assert.equal(one.workers[1].status.state, 'stopped');
  assert.notEqual(one.workers[0].stopRequested, true); assert.equal(one.workers[0].status.state, 'running');
  const all = await f.service.stop({ projectId: p.projectId, force: true }, p.context);
  assert.deepEqual(f.calls.stops.slice(1).map(s => [s.runId, s.options.force]), [[runs['worker-1'], true], [runs['worker-2'], true]]);
  assert.ok(all.workers.every(w => w.stopRequested === true && w.stopForce === true && w.status.state === 'stopped' && w.start.state === 'settled'));
});

test('view keeps worker as worker-1, lists workers in id order, and reload keeps both', async t => {
  const f = await multiWorkerFixture(t), p = await createTwo(f);
  await f.service.assign({ task: 'opaque two', workerId: 'worker-2' }, p.context);
  const run = await f.service.start({ projectId: p.projectId, workerId: 'worker-2' }, p.context);
  const view = await f.service.status(p.projectId, origin);
  assert.deepEqual(view.workers.map(w => w.workerId), ['worker-1', 'worker-2']); assert.deepEqual(view.worker, view.workers[0]);
  await f.service.dispose(); await f.open();
  const reloaded = await f.service.status(p.projectId, origin);
  assert.deepEqual(reloaded.workers.map(w => w.workerId), ['worker-1', 'worker-2']);
  assert.deepEqual(reloaded.workers[1].runs, [run.runId]); assert.equal(reloaded.workers[1].assignment.state, 'assigned');
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'PROJECT_WORKER_REQUIRED' });
});

test('legacy record without extraWorkers loads as N=1 with unchanged shapes', async t => {
  const f = await multiWorkerFixture(t), p = await f.create();
  const meta = await readMeta(f, p.projectId); assert.equal(Object.hasOwn(meta, 'extraWorkers'), false);
  await f.service.dispose(); await f.open();
  const assigned = await f.service.assign({ task: 'opaque legacy task' }, p.context);
  assert.equal(assigned.workerId, 'worker-1');
  const run = await f.service.start({ projectId: p.projectId }, p.context);
  assert.equal(f.calls.starts.at(-1).input.workerId, 'worker-1');
  const view = await f.service.status(p.projectId, origin);
  assert.equal(view.workers.length, 1); assert.deepEqual(view.workers[0], view.worker); assert.deepEqual(view.worker.runs, [run.runId]);
  assert.deepEqual(Object.keys(view.assignmentHistory.assignments[0]), ['sha256', 'at', 'lastRun']);
  const after = await readMeta(f, p.projectId);
  assert.equal(Object.hasOwn(after, 'extraWorkers'), false); assert.deepEqual(Object.keys(after.assignmentHistory.assignments[0]), ['sha256', 'at', 'lastRun']);
  await f.service.stop({ projectId: p.projectId }, p.context);
  assert.deepEqual(f.calls.stops.map(s => s.runId), [run.runId]);
});

test('invalid extraWorkers records are PROJECT_RECORD_INVALID without touching sibling projects', async t => {
  const f = await multiWorkerFixture(t), good = await f.create(), p = await createTwo(f); await f.service.dispose();
  const base = await readMeta(f, p.projectId), w2 = base.extraWorkers[0];
  const variants = [[], [{ ...w2, workerId: 'worker-3' }], [w2, { ...w2, workerId: 'worker-4' }],
    [w2, { ...w2, workerId: 'worker-3' }, { ...w2, workerId: 'worker-4' }, { ...w2, workerId: 'worker-5' }],
    [{ ...w2, runs: undefined }], [{ ...w2, assignment: null }], [{ ...w2, start: 'idle' }], 'worker-2', null];
  for (const extraWorkers of variants) {
    await fs.writeFile(projectFile(f, p.projectId), JSON.stringify({ ...base, extraWorkers }));
    await f.open(); await assert.rejects(f.service.status(p.projectId, origin), { code: 'PROJECT_RECORD_INVALID' }, JSON.stringify(extraWorkers));
    assert.equal((await f.service.status(good.projectId, origin)).state, 'ready'); await f.service.dispose();
  }
  const four = [w2, { ...w2, workerId: 'worker-3' }, { ...w2, workerId: 'worker-4' }];
  await fs.writeFile(projectFile(f, p.projectId), JSON.stringify({ ...base, extraWorkers: four }));
  await f.open(); assert.deepEqual((await f.service.status(p.projectId, origin)).workers.map(w => w.workerId), ['worker-1', 'worker-2', 'worker-3', 'worker-4']);
});

test('verification_reads for a worker-2 run passes workerId worker-2; unknown runs are refused', async t => {
  const f = await multiWorkerFixture(t), p = await createTwo(f);
  await f.service.assign({ task: 'opaque two', workerId: 'worker-2' }, p.context);
  const run = await f.service.start({ projectId: p.projectId, workerId: 'worker-2' }, p.context); await admissionsTurn();
  const dto = await f.service.verificationReads({ projectId: p.projectId, runId: run.runId, submissionId: 'submission-fixture' }, origin);
  assert.equal(dto.workerId, 'worker-2');
  assert.deepEqual(f.calls.readAudits, [{ projectId: p.projectId, runId: run.runId, workerId: 'worker-2', submissionId: 'submission-fixture' }]);
  await assert.rejects(f.service.verificationReads({ projectId: p.projectId, runId: 'run-unknown', submissionId: 'submission-fixture' }, origin), { code: 'PROJECT_WORKER_MISMATCH' });
  assert.equal(f.calls.readAudits.length, 1);
});

test('startup message lists both workers for N=2 and keeps the single-worker sentence for N=1', async t => {
  const f = await multiWorkerFixture(t); await f.create(); await createTwo(f);
  const [one, two] = f.calls.sends.map(s => s.text);
  assert.ok(one.includes('This session has only one logical worker, worker-1.'));
  assert.ok(one.includes('Exploratory subagents are for speculative text-only mathematics'));
  assert.ok(one.includes('; logical worker worker-1. Read PROBLEM.md'));
  assert.ok(!two.includes('only one logical worker'));
  for (const fragment of ['logical workers worker-1, worker-2. Read PROBLEM.md',
    'This session has 2 logical workers: worker-1, worker-2.', 'Exploratory subagents are for speculative text-only mathematics', 'Each has its own TASK and local memory',
    'all share global memory and the fact graph', 'math_assign and math_project start require workerId',
    'math_project stop without workerId stops all workers', 'share one project lock']) assert.ok(two.includes(fragment), fragment);
  assert.match(two, /^[\x20-\x7e\n]+$/);
});

for (const unsettled of [false, true]) test(`stopWorkers adapter cleanupPending=${unsettled} when worker-2 ${unsettled ? 'stays' : 'is not'} unsettled`, async t => {
  const f = await multiWorkerFixture(t, unsettled ? { stopIgnores: new Set(['worker-2']) } : {}), p = await createTwo(f);
  for (const id of ['worker-1', 'worker-2']) {
    await f.service.assign({ task: `opaque ${id}`, workerId: id }, p.context);
    await f.service.start({ projectId: p.projectId, workerId: id }, p.context);
  }
  await f.service.goal('start', { projectId: p.projectId, authorized: true }, origin);
  const stopped = await f.service.goal('stop', { projectId: p.projectId }, origin);
  assert.equal(stopped.workerStop.state, 'requested'); assert.equal(stopped.workerStop.cleanupPending, unsettled);
  assert.deepEqual(f.calls.stops.map(s => s.runId).sort(), ['run-1', 'run-2']);
  const view = await f.service.status(p.projectId, origin);
  assert.equal(view.workers[0].status.state, 'stopped'); assert.equal(view.workers[1].status.state, unsettled ? 'running' : 'stopped');
});

// Operator finalize (docs/design/finalize.md). Software graph: B depends on A; C is independent.
const FA = 'a'.repeat(16), FB = 'b'.repeat(16), FC = 'c'.repeat(16);
function graphCore({ drift = 0, missing = new Set() } = {}) {
  const state = { drift, lists: 0 };
  const coreCall = async (binding, operation, args) => {
    if (operation === 'fact_list_page') {
      state.lists++;
      if (state.drift > 0) { state.drift--; throw Object.assign(new Error('opaque drift'), { code: 'PROJECT_CORE_FAILED', coreError: { code: 'fact_page_changed', message: 'opaque' } }); }
      return { facts: [{ fact_id: FA, predecessors: [] }, { fact_id: FB, predecessors: [FA] }, { fact_id: FC, predecessors: [] }] };
    }
    if (operation === 'fact_get') {
      if (missing.has(args.fact_id)) throw Object.assign(new Error('opaque missing'), { code: 'PROJECT_CORE_FAILED', coreError: { code: 'not_found', message: 'opaque' } });
      return { fact_id: args.fact_id, markdown: `opaque canonical ${args.fact_id}`, predecessors: args.fact_id === FB ? [FA] : [] };
    }
    return { opaque: operation };
  };
  return { state, coreCall };
}
const targetFile = (f, id, paper = 'main') => path.join(f.dataDir, 'research/projects', id, 'targets', `${paper}.json`);

test('finalize without factIds suggests terminal facts and writes nothing', async t => {
  const g = graphCore(), f = await multiWorkerFixture(t, { coreCall: g.coreCall }), p = await f.create();
  const reply = await f.service.finalize({ projectId: p.projectId }, origin);
  assert.deepEqual(reply, { projectId: p.projectId, paperId: 'main', suggested: [FB, FC] });
  await assert.rejects(fs.stat(path.join(f.dataDir, 'research/projects', p.projectId, 'targets')), { code: 'ENOENT' });
});

test('finalize suggestion restarts once on fact_page_changed, then propagates', async t => {
  const once = graphCore({ drift: 1 }), f = await multiWorkerFixture(t, { coreCall: once.coreCall }), p = await f.create();
  assert.deepEqual((await f.service.finalize({ projectId: p.projectId }, origin)).suggested, [FB, FC]);
  assert.equal(once.state.lists, 2);
  once.state.drift = 2; once.state.lists = 0;
  await assert.rejects(f.service.finalize({ projectId: p.projectId }, origin));
  assert.equal(once.state.lists, 2);
});

test('creator finalize writes a deduplicated record with sha256 digests; main is denied', async t => {
  const g = graphCore(), f = await multiWorkerFixture(t, { coreCall: g.coreCall }), p = await f.create();
  await assert.rejects(f.service.finalize({ projectId: p.projectId, factIds: [FB] }, p.context), { code: 'PROJECT_FINALIZE_DENIED' });
  await assert.rejects(fs.stat(targetFile(f, p.projectId)), { code: 'ENOENT' });
  const record = await f.service.finalize({ projectId: p.projectId, factIds: [FB, FC, FB] }, origin);
  assert.deepEqual(record.factIds, [FB, FC]); assert.equal(record.finalizedBy, 'creator'); assert.equal(record.paperId, 'main');
  const { createHash } = await import('node:crypto');
  for (const id of [FB, FC]) assert.equal(record.factDigests[id], createHash('sha256').update(`opaque canonical ${id}`).digest('hex'));
  assert.deepEqual(JSON.parse(await fs.readFile(targetFile(f, p.projectId))), record);
  const view = await f.service.status(p.projectId, origin);
  assert.equal(view.targets.length, 1); assert.deepEqual(view.targets[0].factIds, [FB, FC]); assert.equal(view.targets[0].valid, true);
});

test('finalize rejects the whole call when any fact is missing and writes nothing', async t => {
  const g = graphCore({ missing: new Set([FC]) }), f = await multiWorkerFixture(t, { coreCall: g.coreCall }), p = await f.create();
  await assert.rejects(f.service.finalize({ projectId: p.projectId, factIds: [FB, FC] }, origin));
  await assert.rejects(fs.stat(targetFile(f, p.projectId)), { code: 'ENOENT' });
  assert.deepEqual((await f.service.status(p.projectId, origin)).targets, []);
});

test('finalize validates paperId and factIds, overwrites per paper, and survives reload', async t => {
  const g = graphCore(), f = await multiWorkerFixture(t, { coreCall: g.coreCall }), p = await f.create();
  for (const bad of [{ paperId: '' }, { paperId: 'A' }, { paperId: '../x' }, { paperId: 'a/b' }, { factIds: [] }, { factIds: ['xyz'] }, { factIds: 'a' }, { other: 1 }]) {
    await assert.rejects(f.service.finalize({ projectId: p.projectId, ...bad }, origin), { code: 'PROJECT_INVALID_INPUT' });
  }
  await f.service.finalize({ projectId: p.projectId, factIds: [FB] }, origin);
  await f.service.finalize({ projectId: p.projectId, factIds: [FC] }, origin);
  await f.service.finalize({ projectId: p.projectId, paperId: 'note-1', factIds: [FA] }, origin);
  assert.deepEqual(JSON.parse(await fs.readFile(targetFile(f, p.projectId))).factIds, [FC]);
  await f.service.dispose(); await f.open();
  const targets = (await f.service.status(p.projectId, origin)).targets;
  assert.deepEqual(targets.map(r => [r.paperId, r.factIds, r.valid]), [['main', [FC], true], ['note-1', [FA], true]]);
});

test('a damaged target record is reported invalid without breaking project load', async t => {
  const g = graphCore(), f = await multiWorkerFixture(t, { coreCall: g.coreCall }), p = await f.create();
  await f.service.finalize({ projectId: p.projectId, factIds: [FB] }, origin);
  await fs.writeFile(targetFile(f, p.projectId), '{"schemaVersion":1}\n');
  await f.service.dispose(); await f.open();
  const view = await f.service.status(p.projectId, origin);
  assert.equal(view.state, 'ready'); assert.deepEqual(view.targets, [{ paperId: 'main', valid: false, error: 'PROJECT_TARGET_RECORD_INVALID' }]);
});

test('background report reads canonical facts through the actual project FIFO without a retained caller token', async t => {
  const requests = [];
  const summaryWriter = {
    async start(input) {
      requests.push(input); input.assertActive();
      return { done: Promise.resolve({ state: 'completed', modelStopReason: 'stop', finalText: '# Report\n\nAn opaque complete result.\n', cleanupPending: false }),
        stop: async () => ({ state: 'stopped', cleanupPending: false }) };
    },
    async dispose() { return { cleanupPending: false, errors: [] }; },
  };

  const f = await multiWorkerFixture(t, { summaryWriter }), p = await f.create();
  const queued = await f.service.summary({ projectId: p.projectId }, origin);
  assert.equal(queued.state, 'queued'); assert.equal(requests.length, 0);
  const reportSchedule = [...f.schedules.values()].find(row => row.handlerKey === 'math-project-report');
  assert.ok(reportSchedule); assert.notEqual(reportSchedule.handlerKey, 'math-project-setup');
  await f.handlers.get(reportSchedule.handlerKey).run({ kind: 'schedule', scheduleId: reportSchedule.scheduleId, input: reportSchedule.payload });
  const status = await f.service.summaryStatus({ projectId: p.projectId, reportId: queued.reportId }, origin);
  assert.equal(status.state, 'completed', JSON.stringify(status)); assert.equal(status.cleanupPending, false); assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0].prompt, /opaque-origin-token/);
  assert.ok(f.calls.core.some(row => row.operation === 'fact_get'));
  assert.ok(f.calls.core.filter(row => row.operation === 'fact_list_page').length >= 3);
  await assert.rejects(f.service.summaryStatus({ projectId: p.projectId, reportId: queued.reportId }, p.context), { code: 'PROJECT_SUMMARY_DENIED' });
});

test('publication rechecks through the actual FIFO retry one fact addition but refuse continued drift', async t => {
  for (const continuous of [false, true]) await t.test(continuous ? 'continued drift' : 'one addition', async t => {
    const initial = [{ fact_id: FA, predecessors: [], markdown: '## statement\nOpaque captured result.\n## proof\nOpaque proof.\n' }];
    let facts = [...initial], writing = false, added = 0;
    const summaryWriter = {
      async start() { writing = true; return {
        done: Promise.resolve({ state: 'completed', modelStopReason: 'stop', finalText: '# Report\n\nAn opaque captured result.\n', cleanupPending: false }),
        stop: async () => ({ state: 'stopped', cleanupPending: false }),
      }; }, async dispose() { return { cleanupPending: false, errors: [] }; },
    };
    const coreCall = async (binding, operation, args) => {
      if (operation === 'fact_list_page') return fixtureFactPage(facts, args, binding.projectId);
      assert.equal(operation, 'fact_get');
      const row = facts.find(fact => fact.fact_id === args.fact_id); assert.ok(row);
      if (writing && (continuous || added === 0)) {
        added++;
        facts = [...facts, { fact_id: added.toString(16).padStart(16, '0'), predecessors: [], markdown: '## statement\nOpaque new result.\n' }];
      }
      return structuredClone(row);
    };
    const f = await multiWorkerFixture(t, { summaryWriter, coreCall }), p = await f.create();
    const q = await f.service.summary({ projectId: p.projectId }, origin);
    const scheduled = [...f.schedules.values()].find(row => row.handlerKey === 'math-project-report');
    await f.handlers.get(scheduled.handlerKey).run({ kind: 'schedule', scheduleId: scheduled.scheduleId, input: scheduled.payload });
    const status = await f.service.summaryStatus({ projectId: p.projectId, reportId: q.reportId }, origin);
    assert.equal(status.state, continuous ? 'failed' : 'completed', JSON.stringify(status));
    assert.equal(status.cleanupPending, false);
    const root = path.join(f.dataDir, 'research/projects', p.projectId);
    assert.match(await fs.readFile(path.join(root, 'reports', q.reportId, 'report.md'), 'utf8'), /opaque captured result/);
    if (continuous) {
      assert.equal(status.error, 'PROJECT_SUMMARY_GRAPH_CHANGED');
      assert.equal(f.calls.core.filter(row => row.operation === 'fact_list_page').length, 6);
      await assert.rejects(fs.readFile(path.join(root, 'report/report.md')), { code: 'ENOENT' });
    } else {
      assert.equal(status.snapshotAdvancedDuringWriting, true); assert.equal(added, 1);
      const published = await fs.readFile(path.join(root, 'report/report.md'), 'utf8');
      assert.equal(published, '# Report\n\nAn opaque captured result.\n');
    }
  });
});

test('dispose aggregates every worker: an unsettled worker-2 keeps cleanupPending', async t => {
  const f = await multiWorkerFixture(t), p = await createTwo(f);
  await f.service.assign({ task: 'opaque two', workerId: 'worker-2' }, p.context);
  const run = await f.service.start({ projectId: p.projectId, workerId: 'worker-2' }, p.context);
  f.research.stopProjectWorker = async (projectId, runId) => { f.calls.stops.push({ projectId, runId }); return structuredClone(f.jobs.get(runId)); };
  const disposed = await f.service.dispose();
  assert.equal(disposed.cleanupPending, true); assert.deepEqual(f.calls.stops.map(s => s.runId), [run.runId]);
});
