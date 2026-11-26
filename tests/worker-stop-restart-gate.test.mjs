// Software-only Project/Host/Research fixtures. No research, model or network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RUN_RESOURCE_FLAGS } from '../packages/hana-math/worker-stop-reconciliation.mjs';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';

const MAIN_CONTROL = 'math-project-main-control';
const turn = () => new Promise(setImmediate);
const clean = () => ({ state: 'stopped', ...Object.fromEntries(RUN_RESOURCE_FLAGS.map(key => [key, false])), pendingMutationCount: 0, unsettledMutation: false });
const status = (f, p) => f.service.goal('status', { projectId: p.projectId }, origin);
const goalFile = (f, p) => path.join(f.dataDir, 'research/main-controls', `${p.projectId}.json`);
const savedGoal = async (f, p) => JSON.parse(await fs.readFile(goalFile(f, p)));
async function sent(f, p) {
  for (let i = 0; i < 2000; i++) {
    const goal = await status(f, p);
    if (goal.state === 'active' && !goal.sendInFlight && goal.send?.state === 'accepted') return goal;
    await turn();
  }
  assert.fail('Software Goal fixture did not finish its send');
}
async function restartFixture(t, behavior = {}, authorized = true) {
  const f = await fixture(t, { roundBoundaryStop: true, recoveryIdle: true, ...behavior }), p = await f.create();
  await f.service.assign({ task: 'opaque restart gate fixture' }, p.context);
  await f.service.goal('start', { projectId: p.projectId, authorized: true, maxAutomaticContinues: 3,
    ...(authorized ? { restartAuthorization: { resume: 'preserve-budget' } } : {}) }, origin); await sent(f, p);
  const run = await f.service.start({ projectId: p.projectId }, p.context);
  const stopped = await f.service.mainGoal('stop', { projectId: p.projectId }, p.context);
  assert.equal(stopped.workerStop.cleanupPending, true); Object.assign(f.jobs.get(run.runId), clean());
  await f.service.goal('resume', { projectId: p.projectId }, origin); const active = await sent(f, p);
  assert.equal(active.workerStopReconciliation.state, 'settled');
  return { f, p, run, stopped, active };
}
async function publicRejected(f, p) {
  await assert.rejects(status(f, p), { code: 'PROJECT_DISPOSED' });
  await assert.rejects(f.service.mainGoal('status', { projectId: p.projectId }, p.context), { code: 'PROJECT_DISPOSED' });
  await assert.rejects(f.service.doctor({ projectId: p.projectId }, p.context), { code: 'PROJECT_DISPOSED' });
}

test('workerStop restart real Project dispose uses both private disposed guards without opening Goal status or doctor', async t => {
  const entered = defer(), release = defer(); t.after(() => release.resolve()); let holding = true;
  const { f, p, stopped, active } = await restartFixture(t, { disposeHandler: async key => {
    if (key === MAIN_CONTROL && holding) { entered.resolve(); await release.promise; }
  } });
  const stopCount = f.calls.stops.length, original = f.research.projectWorkerDiagnostic; let reads = 0;
  f.research.projectWorkerDiagnostic = (...args) => {
    reads++; assert.equal(f.calls.stops.length, stopCount, 'Project forced cleanup is still in the future'); return original(...args);
  };
  const closing = f.service.dispose(); await entered.promise;
  assert.equal(reads, 1, 'Settled proof was observed with both services already disposed'); await publicRejected(f, p);
  holding = false; release.resolve(); const outcome = await closing;
  assert.equal(outcome.cleanupPending, false); assert.equal(reads, 2, 'Marker requires a second fresh proof after unregister');
  await publicRejected(f, p); assert.equal(reads, 2, 'The closed window cannot observe through public reads');
  const saved = await savedGoal(f, p);
  assert.deepEqual(saved.restartIntent, { goalId: saved.goalId, generation: saved.generation, priorActive: true });
  assert.deepEqual(saved.workerStop, stopped.workerStop); assert.deepEqual(saved.workerStopScope, stopped.workerStopScope);
  assert.deepEqual(saved.continuationBudget, active.continuationBudget);
  f.research.projectWorkerDiagnostic = original;
  const counts = { sends: f.calls.sends.length, starts: f.calls.starts.length, stops: f.calls.stops.length, sessions: f.calls.sessions.length };
  await f.open(); const activation = f.service.activateRestarts(); await Promise.all([activation, f.service.activateRestarts()]);
  const current = await status(f, p); assert.equal(current.state, 'active');
  assert.deepEqual(current.workerStop, stopped.workerStop); assert.deepEqual(current.workerStopScope, stopped.workerStopScope);
  assert.deepEqual(current.continuationBudget, active.continuationBudget);
  assert.equal(f.calls.sends.length, counts.sends + 1); assert.equal(f.calls.starts.length, counts.starts);
  assert.equal(f.calls.stops.length, counts.stops); assert.equal(f.calls.sessions.length, counts.sessions);
});

for (const changed of ['recoveryUnsettled', 'pending', 'unknown']) test(`workerStop restart real Project rechecks ${changed} after awaiting handler disposal`, async t => {
  const entered = defer(), release = defer(); t.after(() => release.resolve()); let holding = true;
  const { f, p, run } = await restartFixture(t, { disposeHandler: async key => {
    if (key === MAIN_CONTROL && holding) { entered.resolve(); await release.promise; }
  } });
  const original = f.research.projectWorkerDiagnostic; let unknown = false, reads = 0;
  f.research.projectWorkerDiagnostic = (...args) => { reads++; const row = original(...args); return unknown ? { ...row, state: 'unknown' } : row; };
  const closing = f.service.dispose(); await entered.promise; assert.equal(reads, 1);
  if (changed === 'recoveryUnsettled') f.jobs.get(run.runId).recoveryUnsettled = true;
  if (changed === 'pending') f.jobs.get(run.runId).coreTaskSettlementPending = true;
  if (changed === 'unknown') unknown = true;
  const stop = f.research.stopProjectWorker;
  f.research.stopProjectWorker = async (...args) => {
    if (args[2].force) assert.equal(Object.hasOwn(await savedGoal(f, p), 'restartIntent'), false, 'Later forced cleanup cannot retroactively prove eligibility');
    return stop(...args);
  };
  holding = false; release.resolve(); await closing;
  assert.equal(reads, 2); assert.equal(Object.hasOwn(await savedGoal(f, p), 'restartIntent'), false);
  await publicRejected(f, p); assert.equal(reads, 2);
  f.research.projectWorkerDiagnostic = original; f.research.stopProjectWorker = stop;
});

test('workerStop restart Project closes its private window on MainControl handler rejection returned as errors', async t => {
  let fail = true;
  const { f, p } = await restartFixture(t, { disposeHandler: async key => {
    if (key === MAIN_CONTROL && fail) throw Object.assign(new Error('opaque unregister fixture'), { code: 'APP_HOST_ERROR' });
  } });
  const original = f.research.projectWorkerDiagnostic; let reads = 0;
  f.research.projectWorkerDiagnostic = (...args) => { reads++; return original(...args); };
  const outcome = await f.service.dispose(); fail = false;
  assert.equal(outcome.mainControlCleanupPending, true); assert.ok(outcome.errors.some(error => error.code === 'APP_HOST_ERROR'));
  assert.equal(Object.hasOwn(await savedGoal(f, p), 'restartIntent'), false); assert.equal(reads, 1);
  // Real MainControl catches unregister rejection and returns errors, rather
  // than rejecting goals.dispose(). Project's finally still closes the window.
  await publicRejected(f, p); assert.equal(reads, 1);
  f.research.projectWorkerDiagnostic = original;
});

for (const gate of ['missing-scope', 'null-scope', 'incomplete-scope', 'generation-mismatch', 'missing-run', 'wrong-owner']) test(`workerStop restart real Project ${gate} cannot create or activate a marker`, async t => {
  const { f, p, active } = await restartFixture(t);
  if (['missing-scope', 'null-scope', 'incomplete-scope', 'generation-mismatch'].includes(gate)) {
    await f.service.dispose(); const meta = await savedGoal(f, p);
    if (gate === 'missing-scope') delete meta.workerStopScope;
    if (gate === 'null-scope') meta.workerStopScope = null;
    if (gate === 'incomplete-scope') meta.workerStopScope.targets[0].complete = false;
    if (gate === 'generation-mismatch') meta.workerStopScope.generation++;
    await fs.writeFile(goalFile(f, p), JSON.stringify(meta)); await f.open();
    await f.service.goal('resume', { projectId: p.projectId }, origin); await sent(f, p);
  } else {
    const original = f.research.projectWorkerDiagnostic;
    f.research.projectWorkerDiagnostic = (...args) => ({ ...original(...args), ...(gate === 'missing-run' ? { state: 'missing' } : { workerId: 'worker-2' }) });
  }
  await f.service.dispose(); const saved = await savedGoal(f, p);
  assert.equal(Object.hasOwn(saved, 'restartIntent'), false); assert.equal(saved.workerStop.cleanupPending, true);
  assert.deepEqual(saved.continuationBudget, active.continuationBudget);
  const counts = { sends: f.calls.sends.length, starts: f.calls.starts.length, sessions: f.calls.sessions.length };
  await f.open(); await f.service.activateRestarts(); const blocked = await status(f, p);
  assert.equal(blocked.state, 'blocked'); assert.equal(f.calls.sends.length, counts.sends);
  assert.equal(f.calls.starts.length, counts.starts); assert.equal(f.calls.sessions.length, counts.sessions);
});

test('workerStop restart settled Project scope cannot create restart authorization', async t => {
  const { f, p } = await restartFixture(t, {}, false);
  await f.service.dispose(); const saved = await savedGoal(f, p);
  assert.equal(Object.hasOwn(saved, 'restartAuthorization'), false); assert.equal(Object.hasOwn(saved, 'restartIntent'), false);
  const sends = f.calls.sends.length; await f.open(); await f.service.activateRestarts();
  assert.equal((await status(f, p)).state, 'blocked'); assert.equal(f.calls.sends.length, sends);
});
