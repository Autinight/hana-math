import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
import { createAppResearchCore } from '../packages/hana-math/runtime/research-runtime.mjs';
import { registerWorkspaceDashboardRoutes } from '../packages/hana-math/workspace-dashboard-routes.mjs';
import { liveChannels } from '../packages/hana-math/ui/dashboard/live-protocol.mjs';

const options = { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 20_000 };
const prefix = '/workspace-monitor', generationHeader = 'x-hana-math-monitor-generation';
const unavailable = { state:'unavailable' };
const sha = bytes => createHash('sha256').update(bytes).digest();
const stamp = Object.freeze({ appId:'hana-math', agentId:null, document:null,
  principal:Object.freeze({ kind:'app', appId:'hana-math', credentialKind:'app_surface_session', connectionKind:'local', credentialId:'synthetic-surface' }) });

async function until(observe) {
  const end = performance.now() + 3200;
  while (performance.now() < end) { const result = await observe(); if (result) return result; await sleep(3); }
  assert.fail('fixture observation did not settle');
}

async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'math-workspace-grant-package-')));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  for (const [file, text] of Object.entries({
    'dependencies/python/bin/python3':'Fixture, never executed',
    'dependencies/runtime.json':JSON.stringify({ schemaVersion:1, platform:'darwin', arch:'arm64', pythonVersion:'3.12.14', executable:'dependencies/python/bin/python3' }),
    'runtime/research_entry.py':'# unused', 'runtime/research_read_frame.py':'# unused', 'engine/src/hana_math_engine/research.py':'# unused',
  })) {
    const dest = path.join(root,file); await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.writeFile(dest,text,{mode:0o700});
  }
  let core, hold;
  const f = await fixture(t,{ createCore:options => core.createCore(options) });
  core = createAppResearchCore(f.sdk,{ packageRoot:root });
  t.after(() => core.dispose());
  const starts = [], receipts = new Map();
  f.sdk.runtime = { async start(input) {
    assert.equal(input.profile,'scoped'); assert.equal(input.network,'none');
    assert.equal(input.args[3],path.join(root,'runtime/research_read_frame.py'));
    assert.equal(f.tasks.get(input.taskId)?.scope,'app');
    const file = key => path.join(input.cwd,key+'.frame');
    const state = await fs.readFile(file('state'));
    assert.equal(state[8],1);
    const request = JSON.parse((await fs.readFile(file('request'))).subarray(0,state.readUInt32BE(33)));
    const { projectId } = request.context;
    assert.equal(request.requestId,input.args[5]); assert.equal(request.context.role,'main');
    starts.push({ projectId, operation:request.operation, selection:request.arguments });
    if (hold) { const gate = hold; hold = null; gate.started.resolve(); await gate.release.promise; }
    let result;
    if (request.operation === 'dashboard_factgraph') result = { projectId, asOf:'d'.repeat(64),
      graph:{ nodes:[{ id:'a'.repeat(16), statement:'Fixture statement', proof:`Fixture proof ${projectId}` }], edges:[], max_depth:0 } };
    else {
      assert.equal(request.operation,'dashboard_memory');
      assert.deepEqual(request.arguments,{view:'overview'});
      result = { projectId, data:{ project:projectId, facts:1, facts_with_predecessors:0, facts_by_author:{}, verdicts:{}, updated_at:1,
        channel_counts:Object.fromEntries(liveChannels.map(k=>[k,0])) } };
    }
    const bytes = Buffer.from(JSON.stringify({ schemaVersion:1, requestId:request.requestId, ok:true, result }));
    const frame = Buffer.alloc(1<<20); bytes.copy(frame); state[8] = 3; state.writeUInt32BE(bytes.length,33);
    sha(bytes).copy(state,37); sha(state.subarray(0,69)).copy(state,69);
    await fs.writeFile(file('result'),frame); await fs.writeFile(file('state'),state);
    const receipt = { runtimeId:request.requestId, state:'exited', exitCode:0, runtime:'command', profile:'scoped', network:'none' };
    receipts.set(receipt.runtimeId,receipt); return receipt;
  }, async get(id) { return receipts.get(id); }, watch() { assert.fail('no watch on exited fixture'); }, stop() { assert.fail('no stop on exited fixture'); } };
  f.research.projectWorkerMonitor = (id, worker, run) => {
    const row = f.jobs.get(run); assert.equal(row.projectId,id); assert.equal(row.workerId,worker);
    return { state:row.state === 'running' ? 'active' : 'idle' };
  };
  function mount(service = f.service) {
    const handlers = new Map();
    registerWorkspaceDashboardRoutes({ get(route, handler) { handlers.set(route,handler); } },service.workspaceDashboard);
    return async (route, generation, context = stamp) => {
      const req = new Request('http://fixture.invalid'+prefix+route, { headers:generation ? {[generationHeader]:generation} : undefined });
      return handlers.get(new URL(req.url).pathname)({ req:{raw:req}, get(key) { assert.equal(key,'appRequestContext'); return context; } });
    };
  }
  const start = async project => {
    await f.service.assign({task:'Synthetic fixture task; no model'}, project.context);
    await f.service.start({projectId:project.projectId},project.context);
  };
  const settleGoal = project => until(async () => {
    const status = await f.service.goal('status',{projectId:project.projectId},origin);
    return !status.sendInFlight && status.send?.state === 'accepted' && status;
  });
  return { f, start, mount, starts, settleGoal, hold() { hold = { started:defer(), release:defer() }; const gate = hold; t.after(()=>gate.release.resolve()); return gate; } };
}
const discover = route => route('/current').then(r=>r.json());

test('fresh confirmed creator setup enables only the active project; canceled settlement does not', options, async t => {
  const g = await setup(t), route = g.mount();
  assert.deepEqual(await discover(route),{state:'idle'});
  const fresh = await g.f.create();
  await until(async () => (await discover(route)).state === 'idle');
  assert.equal(g.starts.length,0);
  await g.start(fresh);
  const first = await until(async () => { const s = await discover(route); return s.state === 'active' && s; });
  assert.equal(first.projectId,fresh.projectId);
  const wrong = { ...stamp, principal:{ ...stamp.principal, connectionKind:'relay' } };
  assert.equal((await route('/api/overview',first.generation,wrong)).status,403);
  assert.equal(g.starts.length,0);
  const packet = await route('/api/factgraph',first.generation);
  assert.equal(packet.status,200); assert.equal((await packet.json()).nodes[0].proof,`Fixture proof ${fresh.projectId}`);
  const complete = g.f.sdk.tasks.complete;
  g.f.sdk.tasks.complete = async (id,data) => {
    const result = await complete(id,data);
    if (result.scope !== 'session' || result.handlerKey !== 'math-project-setup') return result;
    g.f.tasks.get(id).status = 'canceled'; return { ...result,status:'canceled' };
  };
  const canceled = await g.f.create(); await g.start(canceled);
  assert.equal((await discover(route)).projectId,fresh.projectId,'a canceled but cleaned setup must not create a grant');
  assert.deepEqual(g.starts.map(row=>row.projectId),[fresh.projectId]);
});

test('reopened records do not backfill; only genuine creator Goal start/resume mint, and a switched route cannot deliver late data', options, async t => {
  const g = await setup(t);
  const historical = await g.f.create();
  await g.f.service.dispose(); await g.f.open(); // Same synthetic data root, new process-local grant registry.
  const route = g.mount();
  assert.deepEqual(await discover(route),{state:'idle'});
  await g.start(historical);
  assert.deepEqual(await discover(route),unavailable);
  assert.equal(g.starts.length,0);
  const fresh = await g.f.create(); await g.start(fresh);
  await g.f.service.stop({projectId:historical.projectId},origin);
  await g.start(historical); // Latest legacy worker is real within the fixture, but cannot mint a display grant.
  const initial = await discover(route); assert.equal(initial.projectId,fresh.projectId);
  const id = historical.projectId;
  await assert.rejects(g.f.service.goal('start',{projectId:id,authorized:true},historical.context),{code:'MAIN_CONTROL_FORBIDDEN'});
  assert.equal((await discover(route)).projectId,fresh.projectId);
  await g.f.service.goal('start',{projectId:id,authorized:true},origin); await g.settleGoal(historical);
  const first = await discover(route); assert.equal(first.projectId,id); assert.notEqual(first.generation,initial.generation);
  assert.equal((await route('/api/overview',initial.generation)).status,409); assert.equal(g.starts.length,0);
  const gate = g.hold(), pending = route('/api/factgraph',first.generation);
  await gate.started.promise;
  await g.f.service.goal('pause',{projectId:id},origin);
  const second = await discover(route); assert.equal(second.projectId,fresh.projectId); assert.notEqual(second.generation,first.generation);
  gate.release.resolve(); const old = await pending;
  assert.equal(old.status,409); assert.deepEqual(await old.json(),unavailable);
  const freshResponse = await route('/api/overview',second.generation);
  assert.equal(freshResponse.status,200); assert.equal((await freshResponse.json()).project,fresh.projectId);
  await g.f.service.goal('resume',{projectId:id},origin); await g.settleGoal(historical);
  const third = await discover(route); assert.equal(third.projectId,id); assert.notEqual(third.generation,first.generation);
  assert.equal((await route('/api/factgraph',first.generation)).status,409);
  const current = await route('/api/factgraph',third.generation); assert.equal(current.status,200);
  assert.equal((await current.json()).nodes[0].proof,`Fixture proof ${id}`);
  await g.f.service.goal('stop',{projectId:id},origin);
  assert.equal((await discover(route)).projectId,fresh.projectId);
  assert.equal((await route('/api/factgraph',third.generation)).status,409);
  assert.deepEqual(g.starts.map(row=>row.projectId),[id,fresh.projectId,id]);
  const stop = g.f.service;
  await stop.dispose();
  assert.deepEqual(await discover(route),unavailable);
});
