// Software-only fixtures. No research, Host runtime, model or network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { RUN_RESOURCE_FLAGS, resourceBlockedFlag, runSettlementState, stopScope, combineSettlement } from '../packages/hana-math/worker-stop-reconciliation.mjs';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';

const turn = () => new Promise(setImmediate);
const clean = () => ({ state: 'stopped', ...Object.fromEntries(RUN_RESOURCE_FLAGS.map(key => [key, false])), pendingMutationCount: 0, unsettledMutation: false });
async function bytes(root) {
  const result = {};
  async function visit(dir) { for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name); if (item.isDirectory()) await visit(file); else result[path.relative(root, file)] = (await fs.readFile(file)).toString('base64');
  } }
  await visit(root); return result;
}
const goalStatus = (f, p, ctx = origin) => f.service.goal('status', { projectId: p.projectId }, ctx);
async function startGoal(f, p) {
  const result = await f.service.goal('start', { projectId: p.projectId, authorized: true, maxAutomaticContinues: 1 }, origin);
  for (let i = 0; i < 6; i++) await turn(); return result;
}
async function assigned(t, behavior = {}) {
  const f = await fixture(t, { roundBoundaryStop: true, ...behavior }), p = await f.create();
  await f.service.assign({ task: 'opaque stop scope fixture' }, p.context); await startGoal(f, p);
  return { f, p };
}

test('workerStop settlement requires every resource flag, not merely a terminal state', () => {
  assert.equal(runSettlementState(clean()), 'settled');
  for (const key of RUN_RESOURCE_FLAGS) {
    assert.equal(runSettlementState({ ...clean(), [key]: true }), 'pending', key);
    const missing = clean(); delete missing[key]; assert.equal(runSettlementState(missing), 'unknown', key);
  }
  assert.equal(runSettlementState({ ...clean(), state: 'running' }), 'pending');
  assert.equal(runSettlementState({ ...clean(), pendingMutationCount: 1 }), 'pending');
  assert.equal(runSettlementState({ ...clean(), state: 'missing', cleanupPending: true }), 'unknown');
  assert.equal(runSettlementState({ ...clean(), unsettledMutation: undefined }), 'unknown');
  assert.equal(combineSettlement(['pending', 'unknown']), 'unknown');
  assert.equal(combineSettlement(['settled', 'pending']), 'pending');
  assert.equal(combineSettlement([]), 'unknown');
});

test('workerStop resourceBlocked normalizes only existing metadata semantics and scope rejects bad references', () => {
  assert.equal(resourceBlockedFlag(undefined), false); assert.equal(resourceBlockedFlag(false), false);
  assert.equal(resourceBlockedFlag({ code: 'RESEARCH_RESOURCE_BLOCKED', private: 'not-projected' }), true);
  for (const value of [null, true, 1, 'blocked', {}, []]) assert.equal(resourceBlockedFlag(value), 'unknown');
  const input = { generation: 2, targets: [{ workerId: 'worker-1', runId: 'run-old', complete: true }] };
  const bound = stopScope(input, 2); input.targets[0].runId = 'run-new';
  assert.equal(bound.targets[0].runId, 'run-old'); assert.ok(Object.isFrozen(bound.targets[0]));
  assert.equal(stopScope(input, 3), null);
  assert.equal(stopScope({ generation: 2, targets: [] }, 2), null);
  assert.equal(stopScope({ generation: 2, targets: [{ workerId: 'worker-1', runId: null }] }, 2), null);
});

test('workerStop captures all stop targets including explicit no-run, and status/doctor observe without writes or side effects', async t => {
  const f = await fixture(t, { multiWorker: true, roundBoundaryStop: true }), p = await f.create({ problem: 'opaque all-worker stop', workers: 2 });
  await f.service.assign({ task: 'opaque target', workerId: 'worker-1' }, p.context); await startGoal(f, p);
  const run = await f.service.start({ projectId: p.projectId, workerId: 'worker-1' }, p.context);
  const stopped = await f.service.goal('stop', { projectId: p.projectId }, origin);
  assert.deepEqual(stopped.workerStopScope, { generation: stopped.workerStop.generation, targets: [
    { workerId: 'worker-1', runId: run.runId, complete: true }, { workerId: 'worker-2', runId: null, complete: true },
  ] });
  assert.equal(stopped.workerStop.cleanupPending, true); assert.equal(stopped.workerStopReconciliation.state, 'pending');
  Object.assign(f.jobs.get(run.runId), clean());
  const before = await bytes(f.dataDir), counts = Object.fromEntries(Object.entries(f.calls).map(([key, calls]) => [key, calls.length]));
  const originalStatus = f.research.projectWorkerStatus, originalStop = f.research.stopProjectWorker;
  f.research.projectWorkerStatus = () => assert.fail('No refresh/status in read-only evidence');
  f.research.stopProjectWorker = () => assert.fail('No stop from observation');
  const methods = ['writeFile', 'rename', 'mkdir', 'unlink'].map(name => t.mock.method(fs, name, () => assert.fail('No write from observation')));
  syncBuiltinESMExports();
  try {
    const current = await goalStatus(f, p), report = await f.service.doctor({ projectId: p.projectId }, p.context);
    assert.equal(current.workerStopReconciliation.state, 'settled'); assert.equal(current.workerStopReconciliation.source, 'loaded-memory');
    assert.deepEqual(current.workerStop, stopped.workerStop); assert.deepEqual(current.workerStopScope, stopped.workerStopScope);
    assert.deepEqual(current.continuationBudget, stopped.continuationBudget);
    assert.deepEqual(report.goal.workerStopReconciliation, current.workerStopReconciliation);
    assert.equal(current.workerStopReconciliation.targets.length, 2);
    assert.doesNotMatch(JSON.stringify(report), /sessionPath|provider|callToken|TASK|private/);
    assert.deepEqual(await bytes(f.dataDir), before);
    for (const key of ['tasks', 'schedules', 'unschedules', 'sessions', 'sends', 'starts', 'stops', 'core', 'factories']) assert.equal(f.calls[key].length, counts[key], key);
  } finally { methods.forEach(method => method.mock.restore()); syncBuiltinESMExports(); f.research.projectWorkerStatus = originalStatus; f.research.stopProjectWorker = originalStop; }
});

test('workerStop bound-main complete verifies canonical facts through Project Core and reconciles the exact run after cleanup', async t => {
  const { f, p } = await assigned(t), run = await f.service.start({ projectId: p.projectId }, p.context), goal = await goalStatus(f, p);
  const completed = await f.service.mainGoal('complete', { projectId: p.projectId, goalId: goal.goalId, generation: goal.generation, factIds: ['a'.repeat(16)] }, p.context);
  assert.equal(completed.state, 'completed'); assert.equal(completed.workerStop.cleanupPending, true);
  assert.deepEqual(f.calls.core.filter(call => call.operation === 'fact_get').map(call => call.args), [{ fact_id: 'a'.repeat(16) }]);
  assert.deepEqual(completed.workerStopScope.targets, [{ workerId: 'worker-1', runId: run.runId, complete: true }]);
  assert.equal(completed.workerStopReconciliation.state, 'pending'); Object.assign(f.jobs.get(run.runId), clean());
  const before = await bytes(f.dataDir), current = await f.service.mainGoal('status', { projectId: p.projectId }, p.context);
  assert.equal(current.workerStopReconciliation.state, 'settled'); assert.equal(current.workerStopReconciliation.source, 'loaded-memory');
  assert.deepEqual(current.workerStop, completed.workerStop); assert.equal(current.workerStop.cleanupPending, true);
  assert.deepEqual(current.workerStopScope, completed.workerStopScope); assert.deepEqual(await bytes(f.dataDir), before);
});

test('workerStop an unrelated pending Project Core job does not make a known worker run scope incomplete', async t => {
  const entered = defer(), release = defer(); t.after(() => release.resolve());
  const { f, p } = await assigned(t, { coreCall: async (_binding, operation, args) => {
    assert.equal(operation, 'fact_get'); entered.resolve(); await release.promise;
    return { fact_id: args.fact_id, markdown: 'opaque unrelated canonical fixture', predecessors: [] };
  } });
  const run = await f.service.start({ projectId: p.projectId }, p.context);
  const unrelated = f.service.result({ projectId: p.projectId, factId: 'b'.repeat(16) }, p.context); await entered.promise;
  try {
    assert.equal((await f.service.doctor({ projectId: p.projectId }, p.context)).project.jobsPending, true);
    const stopped = await f.service.mainGoal('stop', { projectId: p.projectId }, p.context);
    assert.equal(stopped.workerStop.cleanupPending, true);
    assert.deepEqual(stopped.workerStopScope.targets, [{ workerId: 'worker-1', runId: run.runId, complete: true }]);
    const job = f.jobs.get(run.runId); Object.assign(job, clean(), { coreTaskSettlementPending: true });
    assert.equal((await goalStatus(f, p)).workerStopReconciliation.state, 'pending', 'Known targets still require every run resource clear');
    Object.assign(job, clean()); const before = await bytes(f.dataDir), current = await goalStatus(f, p);
    assert.equal(current.workerStopReconciliation.state, 'settled'); assert.equal(current.workerStopReconciliation.source, 'loaded-memory');
    assert.deepEqual(current.workerStop, stopped.workerStop); assert.equal(current.workerStop.cleanupPending, true);
    const report = await f.service.doctor({ projectId: p.projectId }, p.context);
    assert.equal(report.project.jobsPending, true); assert.equal(report.ready, false, 'Unrelated Core work still blocks project readiness');
    assert.deepEqual(report.goal.workerStopReconciliation, current.workerStopReconciliation); assert.deepEqual(await bytes(f.dataDir), before);
  } finally { release.resolve(); await unrelated; }
});

test('workerStop old scope stays bound after resume and a new active run; a second stop captures only the new target', async t => {
  const { f, p } = await assigned(t), first = await f.service.start({ projectId: p.projectId }, p.context);
  const stopped = await f.service.goal('stop', { projectId: p.projectId }, origin), frozenBytes = JSON.stringify(stopped.workerStopScope);
  Object.assign(f.jobs.get(first.runId), clean());
  await f.service.goal('resume', { projectId: p.projectId }, origin);
  const entered = defer(), release = defer(); t.after(() => release.resolve());
  f.behavior.onAdmission = () => entered.resolve(); f.behavior.startGate = release;
  const starting = f.service.start({ projectId: p.projectId }, p.context); await entered.promise;
  assert.equal((await goalStatus(f, p)).workerStopReconciliation.state, 'settled', 'A new pending start must not contaminate the old run scope');
  release.resolve(); const second = await starting, historical = await goalStatus(f, p);
  assert.equal(historical.workerStopReconciliation.state, 'settled'); assert.equal(historical.workerStopReconciliation.generation, stopped.workerStop.generation);
  assert.equal(historical.workerStopReconciliation.targets[0].runId, first.runId); assert.equal(f.jobs.get(second.runId).state, 'running');
  assert.equal(JSON.stringify(historical.workerStopScope), frozenBytes);
  const stoppedAgain = await f.service.goal('stop', { projectId: p.projectId }, origin);
  assert.equal(stoppedAgain.workerStopScope.generation, stoppedAgain.workerStop.generation);
  assert.equal(stoppedAgain.workerStopScope.targets[0].runId, second.runId); assert.equal(stoppedAgain.workerStopReconciliation.state, 'pending');
});

for (const window of ['before-admission', 'after-admission']) test(`workerStop inflight start ${window} scope stays incomplete and never backfills the late run`, async t => {
  const entered = defer(), release = defer(); t.after(() => release.resolve());
  const behavior = { onAdmission: () => entered.resolve(), ...(window === 'before-admission' ? { admissionGate: release, checkLateAdmission: true } : { startGate: release }) };
  const { f, p } = await assigned(t, behavior), starting = f.service.start({ projectId: p.projectId }, p.context);
  await entered.promise;
  const stopped = await f.service.goal('stop', { projectId: p.projectId }, origin);
  const scopeBytes = JSON.stringify(stopped.workerStopScope);
  assert.deepEqual(stopped.workerStopScope.targets, [{ workerId: 'worker-1', runId: null, complete: false }]);
  assert.equal(stopped.workerStopReconciliation.state, 'unknown'); release.resolve();
  if (window === 'before-admission') { await assert.rejects(starting, { code: 'MAIN_CONTROL_WORK_DENIED' }); assert.equal(f.jobs.size, 0); }
  else {
    const late = await starting; assert.equal(f.jobs.size, 1); assert.ok(f.calls.stops.some(call => call.runId === late.runId));
    Object.assign(f.jobs.get(late.runId), clean());
  }
  const after = await goalStatus(f, p);
  assert.equal(JSON.stringify(after.workerStopScope), scopeBytes); assert.equal(after.workerStopReconciliation.state, 'unknown');
});

test('workerStop doctor and stop settlement both include the four additional resource flags and preserve missing-field unknowns', async t => {
  const { f, p } = await assigned(t), run = await f.service.start({ projectId: p.projectId }, p.context);
  await f.service.goal('stop', { projectId: p.projectId }, origin); const job = f.jobs.get(run.runId); Object.assign(job, clean());
  const original = f.research.projectWorkerDiagnostic;
  for (const key of ['resourceBlocked', 'taskCreatePending', 'taskSettlementPending', 'schedulePending']) {
    job[key] = true;
    assert.equal((await goalStatus(f, p)).workerStopReconciliation.state, 'pending', key);
    const report = await f.service.doctor({ projectId: p.projectId }, p.context);
    assert.equal(report.runs[0][key], true); assert.equal(report.ready, false, key); job[key] = false;
    f.research.projectWorkerDiagnostic = (...args) => { const value = original(...args); delete value[key]; return value; };
    assert.equal((await goalStatus(f, p)).workerStopReconciliation.state, 'unknown', key);
    const unknown = await f.service.doctor({ projectId: p.projectId }, p.context);
    assert.equal(unknown.runs[0][key], 'unknown'); assert.notEqual(unknown.ready, true, key);
    f.research.projectWorkerDiagnostic = original;
  }
  f.research.projectWorkerDiagnostic = (...args) => ({ ...original(...args), workerId: 'worker-2' });
  assert.equal((await goalStatus(f, p)).workerStopReconciliation.state, 'unknown');
  f.research.projectWorkerDiagnostic = async (...args) => original(...args);
  assert.equal((await goalStatus(f, p)).workerStopReconciliation.state, 'unknown');
  f.research.projectWorkerDiagnostic = original;
});

for (const scope of ['missing', 'null', 'malformed']) for (const cleanupPending of [true, false]) test(`workerStop legacy ${scope} scope cleanupPending=${cleanupPending} preserves receipt and does not migrate`, async t => {
  const { f, p } = await assigned(t);
  await f.service.goal('stop', { projectId: p.projectId }, origin); await f.service.dispose();
  const file = path.join(f.dataDir, 'research/main-controls', `${p.projectId}.json`), record = JSON.parse(await fs.readFile(file));
  if (scope === 'missing') delete record.workerStopScope;
  else record.workerStopScope = scope === 'null' ? null : { generation: record.workerStop.generation, targets: [] };
  record.workerStop.cleanupPending = cleanupPending; await fs.writeFile(file, JSON.stringify(record)); await f.open();
  const before = await bytes(f.dataDir), result = await goalStatus(f, p), doctor = await f.service.doctor({ projectId: p.projectId }, p.context);
  assert.equal(Object.hasOwn(result, 'workerStopScope'), scope !== 'missing');
  if (scope !== 'missing') assert.deepEqual(result.workerStopScope, record.workerStopScope);
  const settled = scope !== 'malformed' && cleanupPending === false;
  assert.equal(result.workerStopReconciliation.state, settled ? 'settled' : 'unknown');
  assert.equal(result.workerStopReconciliation.source, settled ? 'receipt' : 'unknown');
  assert.deepEqual(result.workerStop, record.workerStop); assert.deepEqual(doctor.goal.workerStopReconciliation, result.workerStopReconciliation);
  assert.deepEqual(await bytes(f.dataDir), before);
});

test('workerStop a loaded scope rejects an unconfirmed same-run start and guards project references around observation', async t => {
  const { f, p } = await assigned(t), run = await f.service.start({ projectId: p.projectId }, p.context);
  await f.service.goal('stop', { projectId: p.projectId }, origin); Object.assign(f.jobs.get(run.runId), clean());
  await f.service.dispose();
  const file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), record = JSON.parse(await fs.readFile(file));
  record.worker.start = { state: 'unknown', runId: run.runId }; await fs.writeFile(file, JSON.stringify(record));
  let loaded; const parse = JSON.parse, decoder = t.mock.method(JSON, 'parse', (...args) => {
    const value = parse(...args); if (value?.projectId === p.projectId && value.worker && value.main) loaded = value; return value;
  });
  try { await f.open(); } finally { decoder.mock.restore(); }
  const unknown = await goalStatus(f, p); assert.equal(unknown.workerStopReconciliation.state, 'unknown');
  assert.deepEqual(unknown.workerStopReconciliation.targets[0].reasons, ['WORKER_STOP_START_UNCONFIRMED']);
  loaded.worker.start = { state: 'settled', runId: run.runId };
  const original = f.research.projectWorkerDiagnostic;
  f.research.projectWorkerDiagnostic = (...args) => { const value = original(...args); loaded.worker.lastRun = null; return value; };
  const changed = await goalStatus(f, p); assert.equal(changed.workerStopReconciliation.state, 'unknown');
  assert.deepEqual(changed.workerStopReconciliation.reasons, ['WORKER_STOP_OBSERVATION_FAILED']);
  f.research.projectWorkerDiagnostic = original;
});

test('workerStop Goal status keeps a legacy locator unchanged; the ordinary write route still migrates it', async t => {
  const f = await fixture(t), p = await f.create(); await startGoal(f, p);
  await f.service.goal('pause', { projectId: p.projectId }, origin);
  const row = f.host.get(p.context.sessionPath), moved = '/fixture/stop-status-moved.jsonl';
  f.host.delete(p.context.sessionPath); f.host.set(moved, { ...row, path: moved }); const ctx = { ...p.context, sessionPath: moved };
  const before = await bytes(f.dataDir), observed = await goalStatus(f, p, ctx);
  assert.equal(observed.main.sessionPath, p.context.sessionPath); assert.deepEqual(await bytes(f.dataDir), before);
  assert.equal((await f.service.mainGoal('status', { projectId: p.projectId }, ctx)).main.sessionPath, p.context.sessionPath);
  assert.deepEqual(await bytes(f.dataDir), before);
  assert.equal((await f.service.status(p.projectId, ctx)).main.sessionPath, moved);
});
