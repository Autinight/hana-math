// B3: local FakeSDK only; actual registered tool/Project/FIFO/CoreAccess/runtime/report chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defer, origin } from './helpers/project-service-fixture.mjs';
import { pairingFixture } from './helpers/managed-ipc-pairing-fixture.mjs';
import { projectCoreManagedIpcRefusal } from '../packages/hana-math/project-core-access.mjs';
const CAP = 'RESEARCH_RUNTIME_CAPACITY', marker = 'invalid-completion-marker', unsafe = 'unsafe-entry';
const opts = { timeout: 20000 };
const observation = (name, data) => console.log('PAIRING ' + JSON.stringify({ name, ...data }));
const current = (out, category) => {
  assert.equal(out.isError, true); assert.equal(out.details.error.code, CAP);
  assert.deepEqual(JSON.parse(out.content[0].text), out.details);
  assert.deepEqual(out.details.error.managedIpcRefusal, category ? { source: 'current', category } : undefined);
};
const projection = (out, category) => {
  assert.equal(out.isError, false); assert.equal(out.details.error, CAP);
  assert.deepEqual(JSON.parse(out.content[0].text), out.details);
  assert.deepEqual(out.details.managedIpcRefusal, category ? { source: 'recorded', category } : undefined);
};
const record = (m, category) => {
  assert.equal(m.error, CAP); assert.deepEqual(m.managedIpcRefusal, category ? { version: 1, category } : undefined);
};
const metaWrites = (g, id) => g.writes.filter(m => m.reportId === id);
async function readouts(g, kind, id) {
  const args = { projectId: g.projectId, reportId: id };
  return Promise.all(['status', 'result'].map(op => g.execute({ action: `paper_${kind}_${op}`, ...args })));
}
async function staleWrapper(g) {
  await g.marker(); const error = await g.f.service.paperPlan(g.plan, origin).then(() => assert.fail('Expected capacity'), e => e);
  assert.equal(projectCoreManagedIpcRefusal(error), marker); await g.marker('clear'); return error;
}
function noTaskField(g, m) {
  assert.equal(Object.hasOwn(g.f.tasks.get(m.taskId).metadata, 'managedIpcRefusal'), false);
  const task = g.f.tasks.get(m.taskId); assert.doesNotMatch(JSON.stringify(task.result ?? null), /managedIpcRefusal/);
}

for (const kind of ['plan', 'section']) test(`${kind} created before scheduling: current, recorded readouts, and reload pair in the original saves`, opts, async t => {
  const g = await pairingFixture(t), args = await g.argsFor(kind); let id;
  const before = await g.counts();
  g.state.onMeta = async m => { if (!id && m.state === 'queued' && m.taskId && !m.scheduleCreating) { id = m.reportId; await g.marker(); } };
  const out = await g.execute({ action: `paper_${kind}`, ...args });
  g.state.onMeta = null;
  assert.ok(id); assert.equal(g.findSchedule(id), undefined);
  const meta = await g.metadata(id), writes = metaWrites(g, id);
  assert.equal(meta.state, 'failed'); assert.equal(meta.cleanupPending, false); assert.equal(meta.taskSettlement, 'confirmed'); assert.equal(meta.writer, null);
  assert.equal(g.f.tasks.get(meta.taskId).status, 'failed'); noTaskField(g, meta);
  assert.deepEqual(writes.map(m => [m.state, m.taskSettlement]), [['queued','pending'],['queued','pending'],['queued','pending'],['failed','pending'],['failed','confirmed'],['failed','confirmed']]);
  const after = await g.counts(); assert.equal(after.writers, before.writers); assert.equal(after.schedules, before.schedules); assert.equal(after.reportTasks, before.reportTasks + 1);
  assert.equal(after.coreTasks - before.coreTasks, after.runtimeStarts - before.runtimeStarts + 1);
  const saved = await readouts(g, kind, id); assert.deepEqual(await g.counts(), after); assert.equal(metaWrites(g, id).length, writes.length);
  assert.equal(saved[1].details.diagnosis.error, CAP); assert.deepEqual(saved[1].details.files, []);
  assert.equal((await g.execute({ action: `paper_${kind}_stop`, projectId: g.projectId, reportId: id })).details.managedIpcRefusal, undefined);
  await g.f.service.dispose(); await g.f.open();
  const reread = await Promise.all(['Status', 'Result'].map(method => g.f.service[`paper${kind === 'plan' ? 'Plan' : 'Section'}${method}`]({ projectId: g.projectId, reportId: id }, origin)));
  assert.deepEqual(await g.metadata(id), meta); assert.equal(metaWrites(g, id).length, writes.length); assert.deepEqual(await g.counts(), after);
  observation(kind + '-admission', { saves: writes.length, firstFailureWrite: writes.findIndex(m => m.state === 'failed') + 1, coreRefusals: 1, actual: meta.managedIpcRefusal ?? null, tool: out.details.error.managedIpcRefusal });
  current(out, marker); record(meta, marker); writes.filter(m => m.error).forEach(m => record(m, marker));
  saved.forEach(out => projection(out, marker)); reread.forEach(x => assert.deepEqual(x.managedIpcRefusal, { source: 'recorded', category: marker }));
});

for (const [kind, phase] of [['plan','prewriter'], ['section','publication']]) test(`${kind} runner ${phase}: actual FIFO refusal keeps expected artifacts, writes, and task settlement`, opts, async t => {
  const g = await pairingFixture(t), args = await g.argsFor(kind);
  const q = await g.f.service[kind === 'plan' ? 'paperPlan' : 'paperSection'](args, origin), initial = metaWrites(g, q.reportId).length;
  let armed = false, atRefusal;
  g.state.onMeta = async m => {
    if (armed || m.reportId !== q.reportId) return;
    // Parsed findings are saved after the post-model/raw recheck, before the first publication.
    const atBoundary = phase === 'prewriter' ? m.writerStarting : m.artifacts?.response && m.sourceStatus === 'generated';
    if (!atBoundary) return;
    if (phase === 'publication') assert.deepEqual(Object.keys(m.artifacts), ['response']);
    armed = true; atRefusal = g.reads.length; await g.marker();
  };
  const before = await g.counts(); await g.dispatch(q.reportId);
  g.state.onMeta = null;
  const after = await g.counts(), meta = await g.metadata(q.reportId), writes = metaWrites(g, q.reportId).slice(initial);
  assert.ok(armed); assert.equal(g.reads.length, atRefusal); assert.equal(g.f.tasks.get(q.taskId).status, 'failed');
  assert.equal(meta.writerStarting, false); assert.equal(meta.cleanupPending, false); assert.equal(meta.taskSettlement, 'confirmed'); noTaskField(g, meta);
  assert.equal(after.coreTasks - before.coreTasks, after.runtimeStarts - before.runtimeStarts + 1);
  assert.equal(after.writers - before.writers, phase === 'prewriter' ? 0 : 1); assert.equal(after.stops - before.stops, phase === 'prewriter' ? 0 : 1);
  assert.deepEqual(Object.keys(meta.artifacts ?? {}), phase === 'prewriter' ? [] : ['response']);
  if (phase === 'publication') assert.equal((await fs.stat(path.join(g.reports, q.reportId, 'raw-response.txt'))).size, meta.artifacts.response.bytes);
  assert.equal(writes.filter(m => m.error === CAP).length, phase === 'prewriter' ? 3 : 4);
  const saved = await readouts(g, kind, q.reportId); assert.equal(saved[1].details.diagnosis.responseSaved, phase === 'publication');
  assert.deepEqual(await g.counts(), after); assert.equal(metaWrites(g, q.reportId).length, initial + writes.length);
  observation(kind + '-' + phase, { runnerSaves: writes.length, failureSaves: writes.filter(m => m.error === CAP).length, artifacts: Object.keys(meta.artifacts ?? {}), runtimeStartsBeforeRefusal: after.runtimeStarts - before.runtimeStarts, actual: meta.managedIpcRefusal ?? null });
  record(meta, marker); writes.filter(m => m.error).forEach(m => record(m, marker)); saved.forEach(out => projection(out, marker));
});

// Drive the existing post-schedule receipt check; return the pending receipt captured before dispatch.
function onLateReceipt(g, engage) {
  let id = null, once = false;
  g.f.behavior.onSchedule = row => { if (row.payload?.reportId) id = row.payload.reportId; };
  const get = g.f.sdk.tasks.get;
  g.f.sdk.tasks.get = async taskId => {
    const pending = await get(taskId);
    if (!once && id && pending?.metadata.reportId === id) { once = true; await engage(id); }
    return pending;
  };
  return () => { g.f.sdk.tasks.get = get; g.f.behavior.onSchedule = null; };
}
for (const mode of ['different-category', 'stale-same-code']) test(`late admission ${mode} selects its own evidence, not runner or prior report evidence`, opts, async t => {
  const g = await pairingFixture(t), stale = await staleWrapper(g); let id, runner;
  const reset = onLateReceipt(g, async q => {
    id = q; await g.marker(); await g.dispatch(id); runner = await g.metadata(id);
    if (mode === 'stale-same-code') throw stale;
    await g.marker('unsafe');
  });
  let out;
  try { out = await g.execute({ action: 'paper_plan', ...g.plan }); } finally { reset(); }
  const m = await g.metadata(id), category = mode === 'different-category' ? unsafe : null;
  assert.equal(runner.state, 'failed'); assert.equal(m.state, 'failed'); assert.equal(m.stopRequested, true); assert.equal(m.taskSettlement, 'confirmed'); noTaskField(g, m);
  const afterRunner = metaWrites(g, id).slice(-1)[0]; assert.deepEqual(afterRunner, m);
  observation('race-' + mode, { runner: runner.managedIpcRefusal ?? null, final: m.managedIpcRefusal ?? null, saves: metaWrites(g, id).length });
  current(out, category); record(runner, marker); record(m, category);
});

test('late genuine capacity cannot rewrite an already completed producer under held acknowledgment', opts, async t => {
  const g = await pairingFixture(t), entered = defer(), release = defer(); let id, run, frozen, count;
  const complete = g.f.sdk.tasks.complete;
  g.f.sdk.tasks.complete = async (taskId, value) => { if (id && value?.reportId === id) { entered.resolve(); await release.promise; } return complete(taskId, value); };
  const reset = onLateReceipt(g, async q => {
    id = q; run = g.dispatch(q); await Promise.race([entered.promise, run.then(() => assert.fail('No held completion'))]);
    frozen = await g.metadata(q); count = metaWrites(g, q).length; await g.marker();
  });
  try {
    const out = await g.execute({ action: 'paper_plan', ...g.plan });
    assert.equal(frozen.state, 'completed'); assert.equal(frozen.taskSettlement, 'pending'); assert.deepEqual(await g.metadata(id), frozen);
    assert.equal(metaWrites(g, id).length, count); assert.equal(g.stops.length, 0); current(out, marker);
  } finally { reset(); release.resolve(); await run; }
  const m = await g.metadata(id); assert.equal(m.state, 'completed'); assert.equal(m.taskSettlement, 'confirmed'); assert.equal(m.managedIpcRefusal, undefined);
});

test('genuine admission primary survives later unclassified runner error of the same code', opts, async t => {
  const g = await pairingFixture(t), entered = defer(), rejectDone = defer(); let id, run;
  g.state.onDone = async () => { entered.resolve(); await rejectDone.promise; throw Object.assign(Error('fixture'), { code: CAP }); };
  const reset = onLateReceipt(g, async q => {
    id = q; run = g.dispatch(q); await Promise.race([entered.promise, run.then(() => assert.fail('Runner failed before done barrier'))]); await g.marker();
  });
  try {
    const out = await g.execute({ action: 'paper_plan', ...g.plan });
    // Depending on whether the runner changed state before the post-schedule receipt check,
    // the existing handoff guard still selects the direct creator gather refusal here.
    current(out, marker); record(await g.metadata(id), marker);
  } finally { reset(); rejectDone.resolve(); await run; }
  const m = await g.metadata(id); assert.equal(m.state, 'stopped'); assert.equal(m.stopRequested, true); assert.equal(m.taskSettlement, 'confirmed'); record(m, marker);
});

test('old wrapper in writer and actual publication artifact store cannot supply a run category', opts, async t => {
  const g = await pairingFixture(t), stale = await staleWrapper(g);
  for (const phase of ['writer', 'publication-store']) {
    const q = await g.f.service.paperPlan(g.plan, origin); let injected = 0;
    if (phase === 'writer') g.state.onDone = async () => { injected++; throw stale; };
    else g.state.onArtifact = async file => { if (file.endsWith('/PLANNER_BLOCKS.json')) { injected++; throw stale; } };
    await g.dispatch(q.reportId); g.state.onDone = g.state.onArtifact = null;
    assert.equal(injected, 1); const m = await g.metadata(q.reportId); assert.equal(m.state, 'failed'); record(m, null);
    assert.equal(m.taskSettlement, 'confirmed'); noTaskField(g, m);
    if (phase === 'publication-store') { assert.equal(m.cleanupPending, false); assert.ok(m.artifacts.response); assert.equal(m.artifacts.blocks, undefined); }
  }
});
