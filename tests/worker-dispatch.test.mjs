// Per-assignment dispatch software tests: no Host, model or Core processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/project-service-fixture.mjs';
import { normalizeWorkerDispatch, validateWorkerSelection } from '../packages/hana-math/worker-selection.mjs';
const model = { provider: 'p', id: 'one' }, other = { provider: 'p', id: 'two' };
const catalog = [{ ...model, thinkingLevels: ['high', 'low'] }, { ...other, thinkingLevels: ['low'] }];
const meta = async (f, p) => JSON.parse(await fs.readFile(path.join(f.dataDir, 'research/projects', p.projectId, 'project.json')));
function enable(f) {
  f.research.validateWorkerDispatch = async input => {
    const result = normalizeWorkerDispatch(input);
    validateWorkerSelection({ model, ...result }, catalog);
    return result;
  };
}
test('assignment dispatch replaces, start inherits fieldwise, and invalid inherited thinking writes nothing', async t => {
  const f = await fixture(t), p = await f.create(); enable(f);
  const assigned = await f.service.assign({ task: 'first', model, thinkingLevel: 'high' }, p.context);
  assert.deepEqual(assigned.dispatch, { model, thinkingLevel: 'high' }); assert.equal(assigned.lastKnownRun, null);
  const before = await meta(f, p);
  await assert.rejects(f.service.start({ projectId: p.projectId, model: other }, p.context), { code: 'INVALID_THINKING_LEVEL' });
  assert.deepEqual(await meta(f, p), before); assert.equal(f.calls.starts.length, 0);
  await f.service.start({ projectId: p.projectId, model: other, thinkingLevel: 'low' }, p.context);
  assert.deepEqual(f.calls.starts[0].input.model, other); assert.equal(f.calls.starts[0].input.thinkingLevel, 'low');
  const again = await f.service.assign({ task: 'second' }, p.context);
  assert.equal(again.dispatch, null); assert.deepEqual(again.lastKnownRun, { runId: 'run-1', observed: 'project-status-cache', selection: null });
  assert.equal(Object.hasOwn((await meta(f, p)).worker.assignment, 'dispatch'), false);
  assert.deepEqual(f.calls.starts[0].input.model, other);
});
test('invalid dispatch after bound-main auth does not touch TASK or assignment history', async t => {
  const f = await fixture(t), p = await f.create(); enable(f);
  await f.service.assign({ task: 'original', model }, p.context);
  const before = await meta(f, p), file = path.join(f.dataDir, 'context/projects', p.projectId, 'workers/worker-1/TASK.md'), task = await fs.readFile(file, 'utf8');
  await assert.rejects(f.service.assign({ task: 'changed', thinkingLevel: 'auto' }, p.context), { code: 'INVALID_THINKING_LEVEL' });
  assert.deepEqual(await meta(f, p), before); assert.equal(await fs.readFile(file, 'utf8'), task);
  const valid = f.research.validateWorkerDispatch;
  f.research.validateWorkerDispatch = () => assert.fail('unauthorized caller must not reach model lookup');
  await assert.rejects(f.service.assign({ task: 'no', model }, { callToken: 'external', sessionPath: '/external' }));
  f.research.validateWorkerDispatch = valid;
});
for (const code of ['ROLE_MISSING', 'CONTROL_TIMEOUT']) test(`trusted pre-admit ${code} rolls back start, unmarked same error remains unknown`, async t => {
  const f = await fixture(t), p = await f.create(); enable(f);
  await f.service.assign({ task: 'test', model }, p.context);
  const original = f.research.startWorkerRun, rejected = new WeakSet();
  f.research.isWorkerAdmissionRejection = error => rejected.has(error);
  f.research.startWorkerRun = async () => { const error = Object.assign(new Error(code), { code }); rejected.add(error); throw error; };
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code });
  assert.equal((await meta(f, p)).worker.start.state, 'idle');
  f.research.startWorkerRun = original;
  await f.service.start({ projectId: p.projectId }, p.context);
  await f.service.stop({ projectId: p.projectId }, p.context);
  f.research.startWorkerRun = async () => { throw Object.assign(new Error(code), { code }); };
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code });
  assert.equal((await meta(f, p)).worker.start.state, 'unknown');
});
test('two logical workers retain independent pending dispatch and immutable evidence', async t => {
  const f = await fixture(t, { multiWorker: true }), p = await f.create({ problem: 'two', workers: 2 }); enable(f);
  for (const [workerId, selected, thinkingLevel] of [['worker-1', model, 'high'], ['worker-2', other, 'low']]) {
    await f.service.assign({ workerId, task: workerId, model: selected, thinkingLevel }, p.context);
    const run = await f.service.start({ projectId: p.projectId, workerId }, p.context);
    f.jobs.get(run.runId).selections = { worker: { agentId: 'saved-worker', model: selected, thinkingLevel } };
    await f.service.status(p.projectId, p.context);
  }
  const before = structuredClone(f.jobs.get('run-1').selections.worker);
  const assignment = await f.service.assign({ workerId: 'worker-1', task: 'replacement', model: other }, p.context);
  assert.deepEqual(assignment.lastKnownRun.selection, before);
  assert.deepEqual(f.jobs.get('run-1').selections.worker, before);
  assert.deepEqual((await meta(f, p)).extraWorkers[0].assignment.dispatch, { model: other, thinkingLevel: 'low' });
});
