// Retired named plans are rejected; integer/default project behavior stays intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, origin } from './helpers/project-service-fixture.mjs';
const file = (f, id) => path.join(f.dataDir, 'research/projects', id, 'project.json');
test('create only accepts integer worker counts and does not persist a workerPlan', async t => {
  const f = await fixture(t, { multiWorker: true });
  for (const workers of [{ worker1: 2, worker2: 2 }, null, 0, 5]) await assert.rejects(f.service.create({ problem: 'opaque', workers }, origin), { code: 'PROJECT_INVALID_INPUT' });
  assert.equal(f.calls.tasks.length, 0);
  for (const workers of [undefined, 4]) {
    const p = await f.create({ problem: 'opaque', ...(workers === undefined ? {} : { workers }) });
    const meta = JSON.parse(await fs.readFile(file(f, p.projectId)));
    assert.equal(Object.hasOwn(meta, 'workerPlan'), false);
    assert.equal(p.status.workers.length, workers ?? 1);
    assert.ok(p.status.workers.every(w => !Object.hasOwn(w, 'tierId')));
  }
});
test('unreleased records carrying any workerPlan fail closed without rewriting or damaging siblings', async t => {
  const f = await fixture(t, { multiWorker: true }); const p = await f.create(), sibling = await f.create();
  await f.service.dispose(); const base = JSON.parse(await fs.readFile(file(f, p.projectId)));
  for (const workerPlan of [null, { schemaVersion: 1, counts: { worker1: 1 }, workerTiers: { 'worker-1': 'worker1' } }]) {
    const bytes = JSON.stringify({ ...base, workerPlan }); await fs.writeFile(file(f, p.projectId), bytes);
    await f.open(); await assert.rejects(f.service.status(p.projectId, origin), { code: 'PROJECT_RECORD_INVALID' });
    assert.equal((await f.service.status(sibling.projectId, origin)).state, 'ready');
    assert.equal(await fs.readFile(file(f, p.projectId), 'utf8'), bytes); await f.service.dispose();
  }
});
