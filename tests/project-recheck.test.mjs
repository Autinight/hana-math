// Project authorization/membership fixtures only; Research cleanup is tested separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, origin, APP } from './helpers/project-service-fixture.mjs';

async function assigned(t, behavior = {}) {
  const f = await fixture(t, { multiWorker: true, ...behavior }), p = await f.create({ problem: 'opaque recheck fixture', workers: 2 });
  await f.service.assign({ workerId: 'worker-1', task: 'opaque' }, p.context);
  const run = await f.service.start({ projectId: p.projectId, workerId: 'worker-1' }, p.context);
  return { f, p, args: { projectId: p.projectId, workerId: 'worker-1', runId: run.runId } };
}
async function loaded(t, f, p) {
  const parse = JSON.parse; let record;
  const mock = t.mock.method(JSON, 'parse', (...args) => {
    const value = parse(...args); if (value?.projectId === p.projectId && value.creator && value.worker?.runs) record = value; return value;
  });
  try { await f.open(); } finally { mock.mock.restore(); }
  assert.ok(record); return record;
}
function counts(f) { return Object.fromEntries(['tasks', 'schedules', 'unschedules', 'sessions', 'sends', 'starts', 'stops', 'core', 'factories'].map(k => [k, f.calls[k].length])); }

for (const caller of ['main', 'moved-main', 'worker', 'other-creator']) test(`recheck denies ${caller} for existing and nonexistent run before Research`, async t => {
  const { f, p, args } = await assigned(t); let ctx = p.context;
  if (caller === 'moved-main') {
    const row = f.host.get(ctx.sessionPath); f.host.delete(ctx.sessionPath);
    ctx = { ...ctx, sessionPath: '/fixture/moved-main.jsonl' }; f.host.set(ctx.sessionPath, { ...row, path: ctx.sessionPath });
  } else if (caller !== 'main') {
    ctx = { callToken: 'genuine-fixture', sessionPath: '/fixture/' + caller };
    f.host.set(ctx.sessionPath, { sessionId: caller, path: ctx.sessionPath, ownerPluginId: caller === 'worker' ? APP : null,
      namespace: caller === 'worker' ? 'app' : 'home', visibility: caller === 'worker' ? 'plugin_private' : 'public', lifecycle: 'active' });
  }
  const before = counts(f), file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), bytes = await fs.readFile(file);
  for (const runId of [args.runId, 'run-does-not-exist']) await assert.rejects(f.service.recheck({ ...args, runId }, ctx), { code: 'PROJECT_OWNER_DENIED' });
  assert.equal(f.calls.rechecks, undefined); assert.deepEqual(counts(f), before); assert.deepEqual(await fs.readFile(file), bytes);
});

test('recheck creator uses exact historical membership, not lastRun, with no Project writes or unrelated controls', async t => {
  const { f, p, args } = await assigned(t);
  await f.service.stop({ projectId: p.projectId, workerId: args.workerId, force: true }, p.context);
  const newer = await f.service.start({ projectId: p.projectId, workerId: args.workerId }, p.context); assert.notEqual(newer.runId, args.runId);
  const before = counts(f), file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), bytes = await fs.readFile(file);
  f.research.projectWorkerStatus = () => assert.fail('no status/refresh');
  const result = await f.service.recheck(args, origin);
  assert.equal(result.code, 'RECHECK_NOT_NEEDED'); assert.deepEqual(f.calls.rechecks, [args]);
  assert.deepEqual(counts(f), before); assert.deepEqual(await fs.readFile(file), bytes);
});

test('recheck refuses unknown/default/extra inputs, wrong worker and duplicate run ownership', async t => {
  const { f, p, args } = await assigned(t), record = await loaded(t, f, p);
  for (const key of ['projectId', 'workerId', 'runId']) {
    const missing = { ...args }; delete missing[key]; await assert.rejects(f.service.recheck(missing, origin), { code: 'PROJECT_INVALID_INPUT' });
  }
  for (const key of ['force', 'all', 'guard', 'sessionPath']) await assert.rejects(f.service.recheck({ ...args, [key]: true }, origin), { code: 'PROJECT_INVALID_INPUT' });
  for (const input of [{ ...args, [Symbol('hidden')]: true }, Object.assign(Object.create({ all: true }), args),
    Object.defineProperty({ ...args }, 'runId', { enumerable: false, value: args.runId }),
    Object.defineProperty({ ...args }, 'runId', { enumerable: true, get() { assert.fail('identity getter must not run'); } })])
    await assert.rejects(f.service.recheck(input, origin), { code: 'PROJECT_INVALID_INPUT' });
  await assert.rejects(f.service.recheck({ ...args, workerId: 'worker-2' }, origin), { code: 'PROJECT_WORKER_MISMATCH' });
  for (const owner of [record.worker, record.extraWorkers[0]]) {
    owner.runs.push(args.runId);
    await assert.rejects(f.service.recheck(args, origin), { code: 'PROJECT_WORKER_MISMATCH' }); owner.runs.pop();
  }
  record.extraWorkers[0].runs = null;
  await assert.rejects(f.service.recheck(args, origin), { code: 'PROJECT_WORKER_MISMATCH' }); record.extraWorkers[0].runs = [];
  assert.equal(f.calls.rechecks, undefined);
});

for (const change of ['creator-object', 'creator-id', 'creator-path', 'rejected', 'project-id', 'worker-object', 'worker-id', 'membership', 'duplicate-owner', 'other-worker-object', 'other-runs-unknown', 'extras-unknown'])
  test(`recheck synchronous guard detects ${change} across Research await`, async t => {
    const { f, p, args } = await assigned(t), record = await loaded(t, f, p);
    const file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), bytes = await fs.readFile(file), before = counts(f);
    const old = { creator: record.creator, worker: record.worker, projectId: record.projectId, rejected: record.creatorRejected,
      creatorId: record.creator.sessionId, creatorPath: record.creator.sessionPath, workerId: record.worker.workerId, runs: [...record.worker.runs], extras: [...record.extraWorkers] };
    f.behavior.recheckHook = async () => {
      await Promise.resolve();
      if (change === 'creator-object') record.creator = { ...record.creator };
      if (change === 'creator-id') record.creator.sessionId = 'different-creator';
      if (change === 'creator-path') record.creator.sessionPath = '/fixture/different.jsonl';
      if (change === 'rejected') record.creatorRejected = true;
      if (change === 'project-id') record.projectId = 'project-other';
      if (change === 'worker-object') record.worker = { ...record.worker };
      if (change === 'worker-id') record.worker.workerId = 'worker-other';
      if (change === 'membership') record.worker.runs = [];
      if (change === 'duplicate-owner') record.extraWorkers[0].runs.push(args.runId);
      if (change === 'other-worker-object') record.extraWorkers[0] = { ...record.extraWorkers[0] };
      if (change === 'other-runs-unknown') record.extraWorkers[0].runs = null;
      if (change === 'extras-unknown') record.extraWorkers = {};
    };
    try {
      await assert.rejects(f.service.recheck(args, origin), { code: ['worker-object', 'worker-id', 'membership', 'duplicate-owner', 'other-worker-object', 'other-runs-unknown', 'extras-unknown'].includes(change) ? 'PROJECT_WORKER_MISMATCH' : 'PROJECT_RECHECK_CHANGED' });
      assert.equal(f.calls.rechecks.length, 1); assert.deepEqual(counts(f), before); assert.deepEqual(await fs.readFile(file), bytes);
    } finally {
      record.creator = old.creator; record.creator.sessionId = old.creatorId; record.creator.sessionPath = old.creatorPath;
      record.projectId = old.projectId; record.creatorRejected = old.rejected; record.worker = old.worker;
      record.worker.workerId = old.workerId; record.worker.runs = old.runs; record.extraWorkers = old.extras; record.extraWorkers[0].runs = [];
    }
  });
