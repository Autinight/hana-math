import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, origin } from './helpers/project-service-fixture.mjs';

const id = 'a'.repeat(16);
const rejected = async (promise, code) => assert.rejects(promise, error => error.code === code);

test('paper validates strict arguments and returns needs_target without creating a task', async t => {
  const f = await fixture(t, { multiWorker: true, summaryWriter: { start() { assert.fail('writer must not start'); } } });
  const p = await f.create();
  const before = f.calls.tasks.length;
  await rejected(f.service.paper({ projectId: p.projectId, brief: 'brief', extra: true }, origin), 'PROJECT_INVALID_INPUT');
  await rejected(f.service.paper({ projectId: p.projectId, brief: '   ' }, origin), 'PROJECT_INVALID_INPUT');
  await rejected(f.service.paper({ projectId: p.projectId, brief: 'brief', instructions: '\0' }, origin), 'PROJECT_INVALID_INPUT');
  await rejected(f.service.paper({ projectId: p.projectId, brief: `bad unicode: ${String.fromCharCode(0xd800)}` }, origin), 'PROJECT_INVALID_INPUT');
  assert.deepEqual(await f.service.paper({ projectId: p.projectId, brief: 'opaque brief' }, origin),
    { projectId: p.projectId, paperId: 'main', status: 'needs_target' });
  assert.equal(f.calls.tasks.length, before);
});

test('paper admits only a creator-finalized target and binds its immutable digest snapshot', async t => {
  let received;
  const canonical = { fact_id: id, predecessors: [], markdown: `---\nfact_id: ${id}\npredecessors: []\n---\n## statement\nOpaque.\n## proof\nOpaque proof.\n` };
  const f = await fixture(t, { multiWorker: true, coreCall: async (_binding, operation) => operation === 'fact_get' ? canonical : { facts: [canonical] }, summaryWriter: { async start(input) {
    received = input;
    return { done: new Promise(() => {}), stop: async () => ({ cleanupPending: false }) };
  } } });
  const p = await f.create();
  const target = await f.service.finalize({ projectId: p.projectId, paperId: 'series-a', factIds: [id] }, origin);
  assert.equal(target.finalizedBy, 'creator');
  await rejected(f.service.paper({ projectId: p.projectId, paperId: 'series-a', brief: 'headline_fact_ids: ffffffffffffffff' }, origin), 'PROJECT_PAPER_BRIEF_TARGET_CONFLICT');
  await rejected(f.service.paper({ projectId: p.projectId, paperId: 'series-a', brief: 'headline_fact_ids: <placeholder>\nheadline_fact_ids: ffffffffffffffff' }, origin), 'PROJECT_PAPER_BRIEF_TARGET_CONFLICT');
  await rejected(f.service.paper({ projectId: p.projectId, paperId: 'series-a', brief: 'headline_fact_ids: definitely-not-a-fact-id' }, origin), 'PROJECT_PAPER_BRIEF_TARGET_CONFLICT');
  await rejected(f.service.paper({ projectId: p.projectId, paperId: 'series-a', brief: 'structural_exemplar: \nstructural_exemplar: old-paper' }, origin), 'PROJECT_PAPER_BRIEF_TARGET_CONFLICT');
  await rejected(f.service.paper({ projectId: p.projectId, paperId: 'series-a', brief: 'structural_exemplar: old-paper' }, origin), 'PROJECT_PAPER_EXEMPLAR_UNAVAILABLE');
  const queued = await f.service.paper({ projectId: p.projectId, paperId: 'series-a', brief: `headline_fact_ids: ${id} (main result)\nstructural_exemplar: <folder name>`, instructions: 'opaque instructions' }, origin);
  assert.equal(queued.state, 'queued');
  const task = f.calls.tasks.find(row => row.metadata?.reportId === queued.reportId);
  assert.ok(task);
  assert.equal(task.metadata.projectId, p.projectId);
  assert.equal(f.calls.starts.length, 0);
  assert.equal(received, undefined);
});

test('summary wrappers retain their existing contract and do not admit paper arguments', async t => {
  const f = await fixture(t, { multiWorker: true, summaryWriter: { start() { assert.fail('no writer expected'); } } });
  const p = await f.create();
  await rejected(f.service.summary({ projectId: p.projectId, paperId: 'main', brief: 'not a summary option' }, origin), 'PROJECT_INVALID_INPUT');
});
