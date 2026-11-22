import assert from 'node:assert/strict';
import test from 'node:test';
import { createMainControlService } from '../packages/hana-math/main-control-service.mjs';
import { createWorkspaceMonitorSelection, createWorkspaceDashboardSelection, observeProjectLifecycle, observeProjectSnapshot } from '../packages/hana-math/dashboard-monitor-selection.mjs';

// No installed Host, actual schedule, or model. All receipts and records are in memory.
test('Goal monitor stamps only confirmed start/resume; waiting remains selected and exit revokes the ticket', async t => {
  const projectId = 'project-monitor-fixture', project = {};
  const creator = { callToken:'creator-fixture', sessionPath:'/fixture/creator' };
  const main = { callToken:'main-fixture', sessionPath:'/fixture/main' };
  const binding = { identityConfirmed:true, sessionId:'fixture-main', sessionPath:main.sessionPath,
    agentId:'fixture-agent', cwd:'/fixture/cwd', kind:'fixture-kind' };
  let sequence = 0, scheduled = 0, reads = 0, writes = 0, io = 0;
  const stopEntered = Promise.withResolvers(), stopRelease = Promise.withResolvers();
  const files = new Map(), schedules = new Map();
  const store = {
    async mkdir() {}, async list() { reads++; return []; },
    async write(name, bytes) { writes++; files.set(name, JSON.parse(bytes)); },
  };
  const session = { ...binding, path:binding.sessionPath, ownerPluginId:'hana-math', visibility:'public', namespace:'home', lifecycle:'active' };
  const sdk = {
    sessions: {
      async get() { io++; return { session }; },
      async list() { io++; return { sessions:[session] }; },
      async send() { io++; return { accepted:true, sessionId:binding.sessionId, sessionPath:binding.sessionPath }; },
    },
    bus: { async subscribe() { io++; return () => {}; } },
    tasks: {
      async registerHandler() { return () => {}; },
      async schedule(input) { io++; const row = { ...input, scheduleId:`schedule-${++scheduled}`, pluginId:'hana-math', intervalMs:null };
        schedules.set(row.scheduleId,row); return row; },
      async getSchedule(id) { io++; return schedules.get(id) ?? null; },
      async unschedule(id) { io++; assert.ok(schedules.delete(id)); return { ok:true }; },
    },
  };
  let clock = 42_000;
  const scheduler = { now:() => clock, setTimeout:() => Symbol(), clearTimeout() {} };
  const goals = await createMainControlService(sdk, { store, clock:scheduler, nextMonitorActivation:() => ++sequence,
    authorize:async ctx => ctx === creator ? 'creator' : ctx === main ? 'main' : null,
    getMainBinding:async () => binding,
    verifyCompletion:async (_ctx, args) => ({ ...args, verified:true }),
    stopWorkers:async () => { stopEntered.resolve(); await stopRelease.promise; return { requested:true, cleanupPending:false }; },
  });
  t.after(() => goals.dispose());
  const observe = () => observeProjectLifecycle({ reliable:true, goal:goals.monitorLifecycle(projectId), workers:[{state:'idle'}] });
  const monitor = createWorkspaceMonitorSelection(() => [{project, projectId, ...observe()}], () => sequence);
  const mainArgs = x => ({ projectId, goalId:x.goalId, generation:x.generation });
  assert.deepEqual(monitor.current(), {status:'idle'});
  const starting = goals.start({ projectId, authorized:true }, creator);
  assert.deepEqual(monitor.current(), {status:'idle'});
  const started = await starting;
  await new Promise(setImmediate); // Drain only the fake Host's immediately accepted send.
  const first = monitor.current();
  const counters = [reads,writes,io];
  assert.equal(monitor.read(first.selection,first.generation,()=>true).source,'goal');
  assert.deepEqual([reads,writes,io],counters);
  await goals.acknowledge({ ...mainArgs(started), controlAt:started.due.control.at, auditAt:started.due.audit.at },main);
  await goals.wait(mainArgs(started),main);
  assert.equal(monitor.current().generation,first.generation);
  assert.equal(sequence,1);
  await goals.pause({projectId},creator);
  assert.equal(observe().lifecycle,'paused');
  assert.deepEqual(monitor.current(),{status:'idle'});
  const resumed = await goals.resume({projectId},creator);
  await new Promise(setImmediate);
  const second = monitor.current();
  assert.equal(sequence,2);
  assert.notEqual(second.generation,first.generation);
  assert.deepEqual(monitor.read(first.selection,first.generation,()=>true),{status:'unavailable'});
  clock = 49_001;
  await assert.rejects(goals.complete({ ...mainArgs(started), factIds:['aaaaaaaaaaaaaaaa'] },main), { code:'MAIN_CONTROL_STALE' });
  const grant = { projectId };
  const dashboard = createWorkspaceDashboardSelection(() => [{ project, projectId, ...observe(),
    snapshot:observeProjectSnapshot(goals.monitorLifecycle(projectId),[{state:'idle'}]) }], () => sequence, () => grant);
  const completion = goals.complete({ ...mainArgs(resumed), factIds:['aaaaaaaaaaaaaaaa'] },main);
  await stopEntered.promise;
  try { assert.deepEqual(dashboard.current(),{ status:'unavailable' }); }
  finally { stopRelease.resolve(); }
  await completion;
  clock = 51_000;
  assert.equal(observe().lifecycle,'completed');
  const snapshot = dashboard.current();
  assert.deepEqual(dashboard.read(snapshot.selection,snapshot.generation,()=>true),
    { status:'ok', lifecycle:'snapshot', projectId, projectName:projectId, endedAt:49_001 });
  assert.equal(goals.monitorLifecycle(projectId).terminal.order,2);
  assert.deepEqual(monitor.current(),{status:'idle'});
  assert.deepEqual(monitor.read(second.selection,second.generation,()=>true),{status:'unavailable'});
  assert.ok([...files.values()].every(value => !Object.hasOwn(value,'monitorActivation') && !Object.hasOwn(value,'monitorCompletion')));
});
