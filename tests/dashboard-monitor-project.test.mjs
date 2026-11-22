import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
import { dashboardSelection } from '../packages/hana-math/dashboard-request.mjs';
import { observeProjectLifecycle, observeProjectSnapshot, createWorkspaceMonitorSelection, createWorkspaceDashboardSelection } from '../packages/hana-math/dashboard-monitor-selection.mjs';

const stamp = order => ({ order });
const goal = (state, order) => ({ state, activation: order === undefined ? null : stamp(order) });
const observed = (input = {}) => observeProjectLifecycle({ reliable: true, goal: null, workers: [], ...input });

test('project observation distinguishes idle, paused, completed, stopped and uncertainty without treating a worker as a completed project', () => {
  assert.equal(observed().lifecycle, 'idle');
  for (const [state, expected] of [['paused','paused'], ['completed','completed'], ['stopped','idle'], ['unknown','unknown']]) {
    assert.equal(observed({ goal: goal(state), workers: [{ state:'active', activation:stamp(4) }] }).lifecycle, expected);
  }
  assert.equal(observed({ reliable:false, goal:goal('active', 1) }).lifecycle, 'unknown');
  assert.equal(observed({ workers:[{state:'unknown'}] }).lifecycle, 'unknown');
  assert.deepEqual(observed({ goal:goal('active', 3), workers:[{state:'idle'}] }),
    { lifecycle:'active', source:'goal', activation:stamp(3) });
  assert.deepEqual(observed({ workers:[{state:'active', activation:stamp(3)}] }),
    { lifecycle:'active', source:'legacy-worker', activation:stamp(3) });
  assert.equal(observed({ goal:goal('active', 3), workers:[{state:'unknown'}] }).lifecycle, 'unknown');
});

test('orders by confirmed activation only, preserves tickets across unrelated reads/facts and invalidates on exit or generation change', () => {
  const a = {}, b = {}, rows = new Map(); let sequence = 2;
  function row(project, projectId, proof) { rows.set(project, { project, projectId, ...proof }); }
  const older = goal('active', 1), newer = goal('active', 2);
  row(a, 'a', observed({ goal:older })); row(b, 'b', observed({ goal:newer }));
  const source = createWorkspaceMonitorSelection(() => [...rows.values()], () => sequence);
  const ticket = source.current();
  assert.equal(ticket.status, 'selected');
  assert.equal(Object.hasOwn(ticket,'projectId'),false);
  assert.deepEqual(source.read(ticket.selection,ticket.generation,()=>true), { status:'ok', projectId:'b', lifecycle:'active', source:'goal' });
  rows.get(a).mtime = 1e12; rows.get(a).factWrites = 500;
  assert.equal(source.current().generation, ticket.generation);
  for (const guard of [undefined,()=>false,async()=>true,()=>{ throw Error('opaque'); }])
    assert.deepEqual(source.read(ticket.selection,ticket.generation,guard), {status:'unavailable'});
  assert.deepEqual(source.read({}, ticket.generation, () => true), {status:'unavailable'});
  row(b, 'b', observed({ goal:goal('paused') }));
  const fallback = source.current();
  assert.notEqual(fallback.generation, ticket.generation);
  assert.deepEqual(source.read(ticket.selection,ticket.generation,()=>true),{status:'unavailable'});
  sequence++;
  // The newer activation can leave again before observation; the old epoch still cannot be redeemed.
  assert.deepEqual(source.read(fallback.selection,fallback.generation,()=>true),{status:'unavailable'});
  const latest = source.current();
  assert.deepEqual(source.read(latest.selection,latest.generation,()=>{row(a,'a',observed({goal:goal('completed')})); return true;}), {status:'unavailable'});
  assert.deepEqual(source.current(), {status:'idle'});
});

test('unrankable activity and conflicting order evidence refuse without guessing from IDs', () => {
  let rows = [{ project:{}, projectId:'a', ...observed({ goal:goal('active',1) }) },
    { project:{}, projectId:'b', ...observed({ goal:goal('active') }) }];
  const source = createWorkspaceMonitorSelection(() => rows, () => 2);
  assert.deepEqual(source.current(), {status:'unavailable'});
  rows = rows.map((r, i) => i ? { ...r, activation:stamp(1) } : r);
  assert.deepEqual(source.current(), {status:'unavailable'});
});

test('idle is explicit; a sole proven active is selectable without order, but unknown competitors fail closed', () => {
  const project = {}, contender = {};
  const active = { project, projectId:'only-active', ...observed({ goal:goal('active') }) };
  let rows = [];
  const source = createWorkspaceMonitorSelection(() => rows, () => 0);
  assert.deepEqual(source.current(), {status:'idle'});
  rows = [active, { project:contender, ...observed({ goal:goal('paused') }) }];
  const first = source.current();
  assert.equal(source.read(first.selection,first.generation,()=>true).projectId,'only-active');
  rows[1] = { project:contender, lifecycle:'unknown' };
  assert.deepEqual(source.current(), {status:'unavailable'});
  rows.pop();
  const latest = source.current();
  assert.notEqual(latest.generation,first.generation);
  assert.deepEqual(source.read(first.selection,first.generation,()=>true),{status:'unavailable'});
  assert.equal(source.read(latest.selection,latest.generation,()=>true).projectId,'only-active');
});

test('snapshot-only observation refuses unsettled work and only a Goal terminal can finish a Goal project', () => {
  const finished = { state:'idle', terminal:{ order:4, startedAt:1_000, endedAt:2_000 } };
  assert.deepEqual(observeProjectSnapshot(null,[finished]), { lifecycle:'snapshot', source:'legacy-worker', activation:stamp(4), endedAt:2_000 });
  for (const state of ['paused','stopped','active','completed']) assert.deepEqual(observeProjectSnapshot({ state },[finished]), { lifecycle:'idle' });
  for (const worker of [{ state:'idle', snapshotUnconfirmed:true }, { state:'active' }, { state:'unknown' }]) {
    assert.deepEqual(observeProjectSnapshot(null,[finished,worker]), { lifecycle:'unknown' });
    assert.deepEqual(observeProjectSnapshot({ state:'completed', terminal:finished.terminal },[worker]), { lifecycle:'unknown' });
  }
  for (const endedAt of [NaN, Infinity, '2000', 0, 999, 1000.5, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(observeProjectSnapshot(null,[{ ...finished, terminal:{ ...finished.terminal, endedAt } }]), { lifecycle:'unknown' });
  }
});

test('dashboard ranks true terminal time, keeps tickets opaque, and does not fall back on uncertainty or revocation', () => {
  const a = {}, b = {}, c = {}, ok = () => true;
  let epoch = 2;
  const grants = new Map([[a,{ projectId:'project-a' }],[b,{ projectId:'project-b' }]]);
  const snap = (project, projectId, order, endedAt, projectName) => ({ project, projectId, lifecycle:'idle', projectName,
    snapshot:{ lifecycle:'snapshot', source:'legacy-worker', activation:stamp(order), endedAt } });
  const later = snap(a,'project-a',1,4_000,'独立标题');
  const older = snap(b,'project-b',2,3_000,'bad\nname');
  const rows = [later,older];
  const dashboard = createWorkspaceDashboardSelection(() => rows, () => epoch, p => grants.get(p));
  const monitor = createWorkspaceMonitorSelection(() => rows, () => epoch);
  const first = dashboard.current();
  assert.deepEqual(Object.keys(first), ['status','selection','generation']);
  assert.deepEqual(monitor.current(),{ status:'idle' });
  assert.deepEqual(dashboard.read(first.selection,first.generation,ok),
    { status:'ok', lifecycle:'snapshot', projectId:'project-a', projectName:'独立标题', endedAt:4_000 });
  assert.deepEqual(dashboard.read(first.selection,first.generation,() => { grants.delete(a); return true; }),{ status:'unavailable' });
  assert.deepEqual(dashboard.current(),{ status:'unavailable' },'do not pass a revoked newer snapshot and disclose an older one');
  grants.set(a,{ projectId:'project-a' });
  for (const row of [{ project:c, lifecycle:'unknown' }, { project:c, lifecycle:'active' },
    { project:c, lifecycle:'idle', snapshot:{ lifecycle:'unknown' } }]) {
    rows.push(row);
    assert.deepEqual(dashboard.current(),{ status:'unavailable' });
    rows.pop();
  }
  rows[0] = { project:a, projectId:'project-a', lifecycle:'active', source:'legacy-worker', activation:stamp(++epoch) };
  const active = dashboard.current();
  assert.deepEqual(dashboard.read(active.selection,active.generation,ok),{ status:'ok', projectId:'project-a', lifecycle:'active', source:'legacy-worker' });
  rows[0] = snap(a,'project-a',epoch,3_000);
  assert.deepEqual(dashboard.current(),{ status:'unavailable' },'different projects ending on the same millisecond are ambiguous');
  rows.shift();
  const fallback = dashboard.current();
  assert.deepEqual(dashboard.read(fallback.selection,fallback.generation,ok),
    { status:'ok', lifecycle:'snapshot', projectId:'project-b', projectName:'project-b', endedAt:3_000 });
  assert.deepEqual(dashboard.read(first.selection,first.generation,ok),{ status:'unavailable' });
});

test('ProjectService observes only formally started fixture workers and never calls status, Core, or Host on selection', async t => {
  const f = await fixture(t);
  const monitor = f.service.workspaceMonitor;
  assert.deepEqual(monitor.current(), { status:'idle' });
  const a = await f.create();
  const b = await f.create();
  assert.deepEqual(monitor.current(), { status:'idle' });
  f.research.projectWorkerMonitor = (projectId, workerId, runId) => {
    const row = f.jobs.get(runId);
    assert.equal(row.projectId, projectId);
    assert.equal(row.workerId, workerId);
    return { state: row.monitorState ?? 'active' };
  };
  for (const p of [a,b]) {
    await f.service.assign({ task:'Synthetic fixture task' }, p.context);
    await f.service.start({ projectId:p.projectId }, p.context);
  }
  const files = [a,b].map(p => join(f.dataDir,'research/projects',p.projectId,'project.json'));
  const before = await Promise.all(files.map(file => readFile(file)));
  const calls = structuredClone(f.calls);
  const ticket = monitor.current();
  assert.equal(monitor.read(ticket.selection,ticket.generation,()=>true).projectId,b.projectId);
  const original = f.research.projectWorkerStatus;
  try {
    f.research.projectWorkerStatus = () => assert.fail('must not use a public status path');
    f.jobs.get('run-2').monitorState = 'unknown';
    assert.deepEqual(monitor.current(), {status:'unavailable'});
    f.jobs.get('run-2').monitorState = 'idle';
    const fallback = monitor.current();
    assert.equal(monitor.read(fallback.selection,fallback.generation,()=>true).projectId,a.projectId);
    assert.deepEqual(monitor.read(ticket.selection,ticket.generation,()=>true), {status:'unavailable'});
    f.jobs.get('run-1').monitorState = 'idle';
    assert.deepEqual(monitor.current(), {status:'idle'});
    assert.deepEqual(f.calls, calls);
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
  } finally { f.research.projectWorkerStatus = original; }
});

test('ProjectService selects a worker that ended without a viewer, invalidates on same-project admission and grant revocation', async t => {
  const f = await fixture(t), guard = () => true;
  let record;
  const mapSet = Map.prototype.set;
  const capture = t.mock.method(Map.prototype,'set',function(key, value) {
    if (value?.meta?.projectId === key && value?.meta?.worker && value.mathematicalFences instanceof Set) record = value;
    return mapSet.call(this,key,value);
  });
  let project;
  try { project = await f.create(); } finally { capture.mock.restore(); }
  assert.equal(record?.meta.projectId,project.projectId);
  const dashboard = f.service.workspaceDashboard;
  f.research.projectWorkerMonitor = (projectId, workerId, runId) => {
    const job = f.jobs.get(runId);
    assert.equal(job.projectId,projectId); assert.equal(job.workerId,workerId);
    return job.observation ?? { state:'active' };
  };
  const start = async () => {
    await f.service.assign({ task:'Synthetic fixture only' },project.context);
    return f.service.start({ projectId:project.projectId },project.context);
  };
  const finish = (runId, endedAt) => Object.assign(f.jobs.get(runId), { state:'finished', coordinatorActive:false,
    observation:{ state:'idle', terminal:{ runId, startedAt:endedAt-10, endedAt } } });
  const firstRun = await start();
  finish(firstRun.runId,48_001);
  const first = dashboard.current(guard);
  assert.equal(first.state,'snapshot'); assert.equal(first.projectId,project.projectId); assert.equal(first.endedAt,48_001);
  assert.equal(typeof first.generation,'string');
  assert.deepEqual(f.service.workspaceMonitor.current(),{ status:'idle' });
  const gate = f.behavior.startGate = defer();
  const admission = f.behavior.admissionGate = defer(), entered = defer();
  f.behavior.onAdmission = () => entered.resolve();
  const secondStarting = start();
  await entered.promise;
  assert.deepEqual(dashboard.current(guard),{ state:'unavailable' });
  admission.resolve(); gate.resolve();
  const secondRun = await secondStarting;
  Object.assign(f.jobs.get(secondRun.runId), { observation:{ state:'idle', snapshotUnconfirmed:true } });
  assert.deepEqual(dashboard.current(guard),{ state:'unavailable' },'queued/setup is not a terminal run');
  assert.deepEqual(await dashboard.read(dashboardSelection('/api/overview'),first.generation,guard),{ state:'unavailable' });
  finish(secondRun.runId,50_003);
  const second = dashboard.current(guard);
  assert.equal(second.endedAt,50_003);
  assert.notEqual(second.generation,first.generation);
  record.meta.main = { ...record.meta.main }; // Replaced identity invalidates the issued grant, even with identical fields.
  assert.deepEqual(dashboard.current(guard),{ state:'unavailable' });
  assert.deepEqual(await dashboard.read(dashboardSelection('/api/overview'),second.generation,guard),{ state:'unavailable' });
  assert.deepEqual(f.calls.core,[]);
  await f.service.dispose(); await f.open();
  assert.deepEqual(f.service.workspaceDashboard.current(guard),{ state:'idle' },'neither a grant nor activation may be rebuilt from history');
});

test('ProjectService carries a creator Goal grant across only its confirmed matching terminal generation', async t => {
  const f = await fixture(t), project = await f.create(), guard = () => true;
  const dashboard = f.service.workspaceDashboard;
  const id = project.projectId;
  const goal = await f.service.goal('start',{ projectId:id, authorized:true },origin);
  // Drain the real service's asynchronous send using only its synthetic SDK.
  for (let i = 0; i < 100; i++) {
    const status = await f.service.goal('status',{ projectId:id },origin);
    if (!status.sendInFlight && status.send?.state === 'accepted') break;
    await new Promise(resolve => setTimeout(resolve,5));
  }
  const before = Date.now();
  await f.service.mainGoal('complete',{ projectId:id, goalId:goal.goalId, generation:goal.generation, factIds:['aaaaaaaaaaaaaaaa'] },project.context);
  const after = Date.now(), snapshot = dashboard.current(guard);
  assert.equal(snapshot.state,'snapshot');
  assert.equal(snapshot.projectId,id);
  assert.ok(snapshot.endedAt >= before && snapshot.endedAt <= after);
  assert.deepEqual(f.service.workspaceMonitor.current(),{ status:'idle' });
});
