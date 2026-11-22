// Software-only Project + CoreAccess + research runtime. The recorded SDK
// starts one real local Python command per start receipt; never an installed Host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
import { reportReadoutTool } from './helpers/report-readout-tool-fixture.mjs';
import { MANAGED_READ_SLOT_BYTES } from '../packages/hana-math/runtime/managed-read-owner.mjs';
import { acceptDashboardViewRead, createProjectCoreAccess } from '../packages/hana-math/project-core-access.mjs';
import { createAppResearchCore, CORE_CALLS_MAX_BYTES, CORE_CALL_RESERVATION_BYTES, projectReadScratchOptions,
  projectDashboardFactgraphOptions, projectDashboardMemoryOptions, projectDashboardViewOptions,
  runtimeManagedIpcRefusal } from '../packages/hana-math/runtime/research-runtime.mjs';

const run = promisify(execFile), repo = fileURLToPath(new URL('..', import.meta.url));
const FID = 'a'.repeat(16), FRAME = 1 << 20;
const fact = { fact_id: FID, predecessors: [], markdown: `---\nfact_id: ${FID}\npredecessors: []\nexternal_refs: []\n---\n## statement\nSynthetic nonempty fact.\n## proof\nSynthetic proof.\n` };
const files = ['request.frame', 'result.frame', 'state.frame'];
const hash = b => createHash('sha256').update(b).digest('hex');
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const pathIdentity = async p => { const s = await fs.lstat(p, { bigint: true }); return `${s.dev}:${s.ino}`; };
const fingerprint = async dir => Promise.all((await fs.readdir(dir)).sort().map(async name => {
  const f = path.join(dir, name), { size, mode } = await fs.lstat(f);
  return { name, id: await pathIdentity(f), size, mode, sha: hash(await fs.readFile(f)) };
}));
const reduced = u => ({ directories: u.directories.used, entries: u.entries.used, charged: u.chargedBytes.used, logical: u.logicalBytes });
const delta = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, a[k] - b[k]]));
const childOptions = cwd => ({ cwd, timeout: 4000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } });

async function setup(t, { timeoutMs, cleanupTimeoutMs } = {}) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const pkg = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-frame-test-package-')));
  t.after(() => fs.rm(pkg, { recursive: true, force: true }));
  const interpreter = process.env.HANA_TEST_READ_FRAME_PYTHON ?? 'python3.12';
  const identity = await run(interpreter, ['-I','-S','-B','-c', 'import os,platform,sys; assert platform.machine()=="arm64" and sys.version_info[:2]==(3,12); print(os.path.realpath(sys.executable))'], {timeout:4000});
  const packagedPython = identity.stdout.trim();
  assert.ok(path.isAbsolute(packagedPython));
  await fs.mkdir(path.join(pkg, 'dependencies/python/bin'), { recursive: true });
  await fs.writeFile(path.join(pkg, 'dependencies/python/bin/python3'), 'managed command approval fixture', { mode: 0o700 });
  await fs.writeFile(path.join(pkg, 'dependencies/runtime.json'), JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' }));
  await fs.cp(path.join(repo, 'engine/src'), path.join(pkg, 'engine/src'), { recursive: true, filter: f => !f.includes('__pycache__') && !f.endsWith('.pyc') });
  await fs.mkdir(path.join(pkg, 'runtime'));
  for (const n of ['research_entry.py', 'research_read_frame.py']) await fs.copyFile(path.join(repo, 'packages/hana-math/runtime', n), path.join(pkg, 'runtime', n));
  let f, instance;
  const starts = [], reads = [], receipts = new Map(), runtimeHooks = {}, instances = [];
  const build = () => { const next = createAppResearchCore(f.sdk, { packageRoot: pkg, timeoutMs, cleanupTimeoutMs }); instances.push(next); return next; };
  const bridge = taskId => instance.createCore({taskId});
  f = await fixture(t, { createCore: ({ taskId }) => bridge(taskId) });
  instance = build();
  t.after(async () => { for (const item of instances) await item.dispose(); });
  f.sdk.sessions.send = () => assert.fail('No model');
  f.sdk.runtime = {
    async start(input) {
      const isFrame = input.args[3] === path.join(pkg, 'runtime/research_read_frame.py');
      assert.deepEqual(Object.keys(input).sort(), ['args','command','cwd','network','profile','runtime','taskId']);
      assert.equal(input.runtime, 'command'); assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none');
      assert.equal(input.command, path.join(pkg, 'dependencies/python/bin/python3'));
      assert.deepEqual(input.args.slice(0, 3), ['-I', '-S', '-B']);
      assert.equal(f.tasks.get(input.taskId)?.scope, 'app');
      assert.equal(path.dirname(input.cwd), path.join(f.dataDir, 'research/core-calls'));
      let request;
      if (isFrame) {
        assert.equal(input.args.length, 13);
        assert.match(input.args[4], /^[1-9][0-9]*$/);
        assert.ok(input.args.slice(6).every(v => /^[0-9]+:[0-9]+$/.test(v)));
        const b = await fs.readFile(path.join(input.cwd, 'state.frame')), length = b.readUInt32BE(33);
        assert.equal(b[8], 1);
        request = JSON.parse((await fs.readFile(path.join(input.cwd, 'request.frame'))).subarray(0, length));
        assert.equal(input.args[5], request.requestId);
        assert.ok(['fact_get', 'fact_list_page', 'dashboard_memory', 'dashboard_factgraph'].includes(request.operation));
        assert.equal(request.verification, undefined);
        assert.equal(request.context.role, 'main');
      } else {
        assert.deepEqual(input.args.slice(3), [path.join(pkg,'runtime/research_entry.py'), path.join(input.cwd,'request.json'), path.join(input.cwd,'result.json')]);
        request = await json(input.args[4]);
      }
      const record = { input, request, isFrame, generation: isFrame ? Number(input.args[4]) : null };
      starts.push(record); if (isFrame) reads.push(record);
      assert.deepEqual(await run(packagedPython, input.args, childOptions(input.cwd)), { stdout: '', stderr: '' });
      const value = { runtimeId: request.requestId, state: 'exited', exitCode: 0, runtime: 'command', profile: 'scoped', network: 'none' };
      receipts.set(request.requestId, value);
      await runtimeHooks.afterChild?.(record);
      return value;
    },
    async get(id) { return receipts.get(id); },
    watch() { assert.fail('Terminal fake receipt does not need watch'); },
    stop() { assert.fail('Terminal fake receipt does not need stop'); },
  };
  const ipc = path.join(f.dataDir, 'research/core-calls'), oldDirs = ['old-settled', 'old-unknown'].map(x => path.join(ipc, x));
  for (const [i, p] of oldDirs.entries()) {
    await fs.mkdir(p, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(p,'request.json'), `historic fixture ${i}`, { mode: 0o600 });
    if (!i) await fs.writeFile(path.join(p,'.complete'), '', { mode: 0o600 });
  }
  const beforeOld = await Promise.all(oldDirs.map(fingerprint));
  const beforeHistory = () => Promise.all(oldDirs.map(fingerprint));
  const tool = await reportReadoutTool(t, { ipcUsage: (a,c) => f.service.ipcUsage(a,c) });
  const initialize = async () => {
    const p = await f.create(), book = path.join(f.dataDir, 'context/projects', p.projectId, 'shared/fact_graph/facts');
    await fs.mkdir(book, { recursive: true }); await fs.writeFile(path.join(book, FID+'.md'), fact.markdown);
    return p;
  };
  const p = await initialize();
  const usage = async () => {
    const reply = await tool.execute({ action: 'ipc_usage', projectId: p.projectId, context: origin });
    assert.equal(reply.isError, false, JSON.stringify(reply.details)); return reduced(reply.details);
  };
  const get = opts => f.service.result({ projectId: p.projectId, ...opts }, origin);
  const recordPath = r => path.join(f.dataDir, 'research/projects', r.request.context.projectId, 'core', r.request.context.runId+'.json');
  const record = r => json(recordPath(r));
  const audit = async r => {
    const v = await record(r);
    assert.partialDeepStrictEqual(v, { phase:'finished', pending:false, operation:r.request.operation, operationId:r.request.context.runId,
      outcome:{state:'succeeded'}, settlement:{confirmed:true}, cleanup:{confirmed:true}, taskId:r.input.taskId });
    assert.partialDeepStrictEqual(f.tasks.get(v.taskId), { status:'completed', result:{controlId:v.operationId,coreOutcome:'succeeded'} });
    return { id: v.operationId, revision:v.revision, taskId:v.taskId, sha:hash(await fs.readFile(recordPath(r))) };
  };
  return { f, p, pkg, ipc, oldDirs, beforeOld, beforeHistory, starts, reads, usage, runtimeHooks, bridge, get, record, recordPath, audit, initialize, packagedPython,
    async reopenOverlapping() {
      await f.service.dispose(); // Ends the synthetic Project, not the App owner.
      const old = instance;
      instance = build(); await f.open();
      return old; // Kept alive across the first read by the fresh instance.
    } };
}

async function seedDashboard(g, projectId, label) {
  const shared=path.join(g.f.dataDir,'context/projects',projectId,'shared');
  // Remove only setup's temporary, handcrafted fact so the real Core writes it.
  await fs.unlink(path.join(shared,'fact_graph/facts',FID+'.md'));
  const seed=`import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from danus.core.factgraph import FactGraph
from danus.core.global_memory import GlobalMemory
p=Path(sys.argv[2]); fact=FactGraph(p).add(problem_id=sys.argv[3],author='作者',statement=sys.argv[4],proof='PRIVATE-LIVE-PROOF:'+sys.argv[4]);print(fact)
GlobalMemory(p).append('plan',sys.argv[4],'PRIVATE-LIVE-EVIDENCE','合作者')`;
  return (await run(g.packagedPython,['-I','-S','-B','-c',seed,path.join(g.pkg,'engine/src'),shared,projectId,label],childOptions(shared))).stdout.trim();
}

test('live dashboard uses one slot per bound project across all selections; snapshot remains legacy', async t=>{
  const g=await setup(t), other=await g.initialize();
  const a=await seedDashboard(g,g.p.projectId,'项目甲'), b=await seedDashboard(g,other.projectId,'项目乙');
  const caller={...origin}, yes=()=>true;
  const read=await g.f.service.authorizeDashboardView({projectId:g.p.projectId},caller);
  const otherRead=await g.f.service.authorizeDashboardView({projectId:other.projectId},origin);
  caller.callToken='changed-after-mint'; caller.sessionPath='/unrelated/path';
  const start=g.f.calls.tasks.length, base=await g.usage();
  for(const selector of [{view:'overview',projectId:other.projectId},{view:'channel',kind:'_status'}, {view:'factgraph',kind:'plan'}, {view:'gm_add'}, {}])
    await assert.rejects(read(selector,yes),{code:'PROJECT_INVALID_INPUT'});
  await assert.rejects(read({view:'overview'}),{code:'PROJECT_DASHBOARD_VIEW_GUARD_REQUIRED'});
  await assert.rejects(read({view:'overview'},async()=>true),{code:'PROJECT_DASHBOARD_VIEW_GUARD_REQUIRED'});
  assert.equal(g.f.calls.tasks.length,start);
  const av=await read({view:'overview'},yes);assert.equal(av.project,g.p.projectId);assert.equal(av.channel_counts.plan,1);
  const provision=await g.usage();assert.equal(provision.directories-base.directories,1);
  assert.equal((await read({view:'channels'},yes)).channels.length,11);
  assert.deepEqual((await read({view:'channel',kind:'plan'},yes)).entries.map(e=>e.claim),['项目甲']);
  const graph=await read({view:'factgraph'},yes);assert.deepEqual(graph.nodes.map(n=>n.id),[a]);
  assert.equal(graph.nodes[0].proof,'PRIVATE-LIVE-PROOF:项目甲');
  assert.deepEqual(delta(await g.usage(),provision),{directories:0,entries:0,charged:0,logical:0});
  const graph2=await otherRead({view:'factgraph'},yes);assert.deepEqual(graph2.nodes.map(n=>n.id),[b]);
  assert.deepEqual((await otherRead({view:'channel',kind:'plan'},yes)).entries.map(e=>e.claim),['项目乙']);
  assert.equal(g.reads.length,6);assert.equal(g.f.calls.tasks.length-start,6);
  const slots=g.reads.map(r=>r.input.cwd);
  assert.deepEqual(g.reads.map(r=>r.generation),[1,2,3,4,1,2]);
  assert.equal(new Set(slots.slice(0,4)).size,1);assert.equal(slots[4],slots[5]);assert.notEqual(slots[0],slots[4]);
  assert.deepEqual(delta(await g.usage(),provision),{directories:1,entries:3,charged:MANAGED_READ_SLOT_BYTES,logical:MANAGED_READ_SLOT_BYTES});
  assert.deepEqual(await g.beforeHistory(),g.beforeOld);
  for(const r of g.reads){
    await g.audit(r);
    assert.deepEqual((await g.record(r)).outcome,{state:'succeeded'});
  }
  await assert.rejects(g.f.service.authorizeDashboardView({projectId:g.p.projectId},g.p.context),{code:'PROJECT_OWNER_DENIED'});
  await assert.rejects(g.f.service.authorizeDashboardView({projectId:g.p.projectId,owner:'creator'},origin),{code:'PROJECT_INVALID_INPUT'});
  const snapshot=await g.f.service.dashboardSnapshot({projectId:g.p.projectId},origin);
  assert.equal(JSON.parse(snapshot.bytes).graph.nodes[0].id,a);
  assert.equal(g.starts.at(-1).isFrame,false);
  assert.equal((await g.record(g.starts.at(-1))).outcome.result.graph.nodes[0].id,a);
});

test('terminal graph and memory carry one canonical witness through confirmed managed slot reuse', async t => {
  const g = await setup(t), projectId = g.p.projectId;
  const factId = await seedDashboard(g, projectId, 'Terminal witness fixture');
  const rows = [];
  const access = createProjectCoreAccess(g.f.sdk, { projectId, author: 'fixture', createCore: ({ taskId }) => g.bridge(taskId),
    onState: row => rows.push(row) });
  t.after(() => access.dispose());
  const guard = () => {};
  const graphArgs = { terminal: true }, memoryArgs = { view: 'channels', terminal: true };
  const bridge = g.bridge('opaque-fixture-task');
  t.after(() => bridge.dispose());
  const binding = { projectId, role: 'main', author: 'fixture', runId: 'control-00000000-0000-4000-8000-000000000000' };
  const memoryOp = 'dashboard_memory', graphOp = 'dashboard_factgraph';
  for (const [op, args, options] of [
    [graphOp, graphArgs, projectDashboardFactgraphOptions()], [memoryOp, memoryArgs, projectDashboardMemoryOptions()],
    [graphOp, graphArgs, { ...projectDashboardViewOptions(graphOp, undefined, guard) }],
    [memoryOp, { ...memoryArgs, terminal: false }, projectDashboardViewOptions(memoryOp, undefined, guard)],
    ['fact_list_page', graphArgs, projectReadScratchOptions()],
  ]) await assert.rejects(bridge.call(binding, op, args, undefined, options), { code: 'RESEARCH_RUNTIME_INVALID_REQUEST' });
  assert.equal(g.reads.length, 0);

  const graph = await access.dashboardViewRead(graphOp, graphArgs, guard);
  assert.match(graph.inventoryRevision, /^[a-f0-9]{64}$/);
  assert.deepEqual(graph.graph.nodes.map(node => node.id), [factId]);
  assert.equal(acceptDashboardViewRead(access, structuredClone(graph)), false, 'copies cannot redeem a managed receipt');
  assert.equal(acceptDashboardViewRead(access, graph), true);
  assert.equal(acceptDashboardViewRead(access, graph), false, 'receipt is one-shot');
  const memory = await access.dashboardViewRead(memoryOp, memoryArgs, guard);
  assert.equal(memory.inventoryRevision, graph.inventoryRevision);
  assert.equal(memory.data.channels.length, 11);
  assert.equal(acceptDashboardViewRead(access, memory), true);
  assert.deepEqual(g.reads.map(read => read.request.arguments), [graphArgs, memoryArgs]);
  assert.deepEqual(g.reads.map(read => read.generation), [1, 2]);
  assert.equal(g.reads[0].input.cwd, g.reads[1].input.cwd);
  for (const read of g.reads) {
    const finished = rows.filter(row => row.operationId === read.request.context.runId).at(-1);
    assert.equal(finished.phase, 'finished');
    assert.deepEqual(finished.outcome, { state: 'succeeded' });
    assert.equal(finished.settlement.confirmed, true);
    assert.equal(finished.cleanup.confirmed, true);
    assert.equal(g.f.tasks.get(finished.taskId).status, 'completed');
  }
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(graph.inventoryRevision));
});

test('live dashboard checks view and creator again in FIFO and before publishing data', async t=>{
  const g=await setup(t);
  const id=await seedDashboard(g,g.p.projectId,'项目甲');
  const read=await g.f.service.authorizeDashboardView({projectId:g.p.projectId},origin);
  const delivered=defer(), release=defer();
  g.runtimeHooks.afterChild=async()=>{delivered.resolve();await release.promise;};
  const hold=read({view:'overview'},()=>true);
  await delivered.promise;
  let allowed=true, seen=0;
  const queued=read({view:'channels'},()=>{seen++;return allowed;});
  try{
    const end=Date.now()+1000;
    while(seen<4&&Date.now()<end)await new Promise(r=>setImmediate(r));
    assert.ok(seen>=4);allowed=false;assert.equal(g.reads.length,1);
  }finally{release.resolve();}
  await hold;
  await assert.rejects(queued,{code:'PROJECT_DASHBOARD_VIEW_DENIED'});
  assert.equal(g.reads.length,1);
  const tasks=g.f.calls.tasks.length;
  const list=g.f.sdk.sessions.list;
  let n=0;
  g.f.sdk.sessions.list=async args=>{
    const reply=await list(args);
    if(++n===2)reply.sessions.push({sessionId:'creator-stable',path:origin.sessionPath,ownerPluginId:'hana-math',lifecycle:'active',visibility:'public'});
    return reply;
  };
  await assert.rejects(read({view:'channels'},()=>true),{code:'PROJECT_OWNER_DENIED'});
  assert.equal(g.f.calls.tasks.length,tasks);
  assert.equal(g.reads.length,1);
  g.f.sdk.sessions.list=list;
  const factBefore=await g.get({factId:id});
  const factSlot=g.reads.at(-1), liveSlot=g.reads[0];
  assert.notEqual(factSlot.input.cwd,liveSlot.input.cwd);
  // Revoke after durable settlement but while the delivery recheck is pending.
  n=0;const post=defer(), resume=defer(); allowed=true;
  g.f.sdk.sessions.list=async args=>{if(++n===3){post.resolve();await resume.promise;}return list(args);};
  const late=read({view:'factgraph'},()=>allowed);
  try{await post.promise;assert.equal(g.reads.length,3);await g.audit(g.reads[2]);allowed=false;}
  finally{resume.resolve();}
  await assert.rejects(late,{code:'PROJECT_DASHBOARD_VIEW_DENIED'});
  g.f.sdk.sessions.list=list;
  assert.deepEqual((await g.record(g.reads[2])).outcome,{state:'succeeded'});
  const capacity=await g.usage();
  assert.deepEqual(await g.get({factId:id}),factBefore);
  assert.deepEqual(await g.usage(),capacity);
  assert.equal(g.reads[3].input.cwd,factSlot.input.cwd);assert.equal(g.reads[3].generation,2);
  await assert.rejects(read({view:'overview'},()=>allowed),{code:'PROJECT_DASHBOARD_VIEW_DENIED'});
  const next=await g.f.service.authorizeDashboardView({projectId:g.p.projectId},origin);
  assert.deepEqual((await next({view:'factgraph'},()=>true)).nodes.map(x=>x.id),[id]);
  assert.equal(g.reads[4].input.cwd,liveSlot.input.cwd);assert.equal(g.reads[4].generation,3);
  assert.deepEqual((await next({view:'channel',kind:'plan'},()=>true)).entries.map(x=>x.claim),['项目甲']);
  assert.equal(g.reads[5].input.cwd,liveSlot.input.cwd);assert.equal(g.reads[5].generation,4);
  assert.deepEqual(await g.usage(),capacity);
  assert.deepEqual(await g.beforeHistory(),g.beforeOld);
});

test('live dashboard settles a started read after close; inconsistent frame still fences only its lane', async t=>{
  const g=await setup(t), id=await seedDashboard(g,g.p.projectId,'项目甲');
  const read=await g.f.service.authorizeDashboardView({projectId:g.p.projectId},origin);
  const fact=await g.get({factId:id}), factSlot=g.reads[0].input.cwd;
  let allowed=true;
  g.runtimeHooks.afterChild=async(r)=>{if(r.request.operation==='dashboard_factgraph')allowed=false;};
  await assert.rejects(read({view:'factgraph'},()=>allowed),{code:'PROJECT_DASHBOARD_VIEW_DENIED'});
  const live=g.reads[1]; assert.notEqual(live.input.cwd,factSlot);
  await g.audit(live);
  assert.deepEqual((await g.record(live)).outcome,{state:'succeeded'});
  const bud=await g.usage();
  const newRead=await g.f.service.authorizeDashboardView({projectId:g.p.projectId},origin);
  g.runtimeHooks.afterChild=async(r)=>{
    if(r.request.operation!=='dashboard_memory')return;
    const h=await fs.open(path.join(r.input.cwd,'state.frame'),'r+');
    try { await h.write(Buffer.from([0]),0,1,0); }
    finally { await h.close(); }
  };
  await assert.rejects(newRead({view:'overview'},()=>true),{code:'RESEARCH_RUNTIME_READ_SLOT_FENCED'});
  assert.equal(g.reads.length,3);
  assert.equal(g.reads[2].input.cwd,live.input.cwd);assert.equal(g.reads[2].generation,2);
  const refused=await g.record(g.reads[2]);
  assert.partialDeepStrictEqual(refused,{phase:'finished',pending:false,taskStatus:'failed',settlement:{confirmed:true},cleanup:{confirmed:true},outcome:{state:'failed'}});
  const damaged=await fingerprint(live.input.cwd);
  g.runtimeHooks.afterChild=undefined;
  await assert.rejects(newRead({view:'channels'},()=>true),{code:'RESEARCH_RUNTIME_READ_SLOT_FENCED'});
  assert.equal(g.reads.length,3);assert.deepEqual(await fingerprint(live.input.cwd),damaged);
  assert.deepEqual(await g.get({factId:id}),fact);
  assert.equal(g.reads[3].input.cwd,factSlot);assert.equal(g.reads[3].generation,2);
  assert.deepEqual(await g.usage(),bud);
  assert.deepEqual(await g.beforeHistory(),g.beforeOld);
});

test('live tool, document handshake and original Overview route reach settled Project and Python', async t=>{
  const [{createDashboardView},{registerPanel},{createLivePage},p]=await Promise.all([
    import('../packages/hana-math/dashboard-view.mjs'),import('../packages/hana-math/panel-service.mjs'),
    import('../packages/hana-math/ui/dashboard/live-page.mjs'),import('../packages/hana-math/ui/dashboard/live-protocol.mjs'),
  ]);
  const g=await setup(t);
  await seedDashboard(g,g.p.projectId,'真实计划');
  const {LIVE_APP,LIVE_PROVIDER,LIVE_CHECK,LIVE_PREPARE,LIVE_COMMIT,LIVE_ROUTE,LIVE_ACTIVATE,EPOCH_HEADER,SEQUENCE_HEADER,liveChannels}=p;
  const stamp=Object.freeze({appId:LIVE_APP,providerId:LIVE_PROVIDER,documentId:'fixture-board-doc',viewId:'fixture-board-view',
    generation:1,capabilities:Object.freeze(['read'])});
  const selector={documentId:stamp.documentId,clientId:'fixture-preview-client',viewId:stamp.viewId,expectedRevision:0};
  const toolAccess=Object.freeze({}), routeAccess=Object.freeze({});
  const toolContext=Object.freeze({...origin,document:Object.freeze({context:stamp,access:toolAccess})});
  const routeContext=Object.freeze({appId:LIVE_APP,agentId:null,document:Object.freeze({context:stamp,access:routeAccess})});
  const mounted=defer(), routes=new Map(), handshakes=[], fetches=[];
  let tool, handler, show, hostReads=0, hold;
  // Only this Host fixture stamps ctx and owns opaque document handles. It calls
  // the actual page-side document callback, not a synthesized success receipt.
  Object.assign(g.f.sdk,{documents:{
    async requestView(access,{method,payload,expectedRevision}){
      assert.equal(access,toolAccess);assert.equal(expectedRevision,selector.expectedRevision);assert.ok(handler);
      const result=await handler({requestId:'fixture-host-view-request',documentId:stamp.documentId,viewId:stamp.viewId,
        revision:expectedRevision,method,payload});
      handshakes.push({method,payload,result});return result;
    },
    async read(access){assert.equal(access,routeAccess);hostReads++;
      if(hold){hold.entered.resolve();await hold.resume.promise;}
      return {content:'fixture-only marker'};
    },
  },routes:{async register(register){register({get(route,fn){assert.ok(!routes.has(route));routes.set(route,fn);},post(){}});}}});
  g.f.sdk.tools.register=async def=>{assert.equal(tool,undefined);tool=def;return ()=>{};};
  const adapter=createDashboardView(g.f.sdk,g.f.service);
  t.after(()=>adapter.dispose());
  await registerPanel(g.f.sdk,adapter);
  await adapter.registerTool();
  assert.equal(tool.name,'math_dashboard_view');assert.equal(tool.documentAccess,'read');
  assert.deepEqual(tool.view,{providerId:LIVE_PROVIDER});
  const route=(pathname,init)=>{
    const registered=routes.get(pathname);assert.ok(registered,pathname);
    return registered({req:{raw:new Request(`https://fixture.invalid${pathname}`,init)},get(name){
      assert.equal(name,'appRequestContext');return routeContext;
    }});
  };
  const page=createLivePage({document:{async getContext(){return stamp;},
    async reportStatus(data){assert.deepEqual(data,{revision:0,dirty:false,canUndo:false,canRedo:false});},
    onViewRequest(fn){handler=fn;return ()=>{handler=undefined;};},
  },api:{fetch(pathname,init){fetches.push({pathname,headers:{...init.headers}});return route(pathname,init);}}},
  options=>{show=options;if(options.request)mounted.resolve(options.request);});
  t.after(()=>page.dispose());
  const invoke=action=>tool.execute({action,projectId:g.p.projectId,...selector,context:toolContext});
  const initialTasks=g.f.calls.tasks.length;
  assert.equal(await page.start(),true);assert.equal(fetches.length,0);
  const bound=await invoke('bind');assert.equal(bound.isError,false,JSON.stringify(bound.details));assert.equal(bound.details.state,'bound');
  const request=await mounted.promise;
  assert.deepEqual(handshakes.map(x=>x.method),[LIVE_CHECK,LIVE_PREPARE,LIVE_COMMIT]);
  const epoch=handshakes[0].result.data.epoch, sequence=handshakes[1].payload.seq;
  assert.equal(handshakes[1].payload.epoch,epoch);assert.equal(handshakes[2].payload.seq,sequence);
  const headers={[EPOCH_HEADER]:epoch,[SEQUENCE_HEADER]:String(sequence)};
  assert.deepEqual(fetches,[{pathname:LIVE_ACTIVATE,headers}]);
  assert.equal(g.starts.length,0);assert.equal(g.f.calls.tasks.length,initialTasks);
  const earliest=Date.now()/1000;
  const response=await request('/api/overview');assert.equal(response.ok,true);
  const {updated_at,...overview}=await response.json();
  assert.ok(updated_at>=earliest&&updated_at<=Date.now()/1000);
  assert.deepEqual(overview,{project:g.p.projectId,facts:1,facts_with_predecessors:0,facts_by_author:{作者:1},
    channel_counts:Object.fromEntries(liveChannels.map(kind=>[kind,kind==='plan'?1:0])),verdicts:{}});
  assert.deepEqual(fetches.at(-1),{pathname:`${LIVE_ROUTE}/api/overview`,headers});
  assert.equal(g.starts.length,1);assert.equal(g.reads.length,1);
  const [read]=g.reads;assert.equal(read.request.context.projectId,g.p.projectId);
  assert.equal(read.request.operation,'dashboard_memory');assert.deepEqual(read.request.arguments,{view:'overview'});
  assert.equal(read.generation,1);await g.audit(read);
  assert.deepEqual((await g.record(read)).outcome,{state:'succeeded'});
  assert.equal(g.f.calls.tasks.length,initialTasks+1);assert.equal(hostReads,3);

  // This second authenticated request is paused before Project dispatch. Unbind
  // via the real tool, then use the same recorded headers, not a guessed epoch.
  hold={entered:defer(),resume:defer()};const url=fetches.at(-1).pathname;
  const awaiting=route(url,{headers});
  try{
    await Promise.race([hold.entered.promise,awaiting.then(()=>assert.fail('route did not reach the pre-dispatch document check'))]);
    const unbound=await invoke('unbind');assert.equal(unbound.isError,false,JSON.stringify(unbound.details));
    assert.deepEqual(unbound.details,{state:'unbound'});
  } finally {hold.resume.resolve();}
  assert.deepEqual(handshakes.slice(3).map(x=>x.method),[LIVE_CHECK,LIVE_PREPARE]);
  assert.ok(handshakes.at(-1).payload.seq>sequence); assert.equal(show.request,undefined);
  const refused=await awaiting;
  assert.equal(refused.status,403);assert.deepEqual(await refused.json(),{error:{code:'DASHBOARD_VIEW_INVALIDATED'}});
  const count=hostReads, stale=await route(url,{headers});
  assert.equal(stale.status,403);assert.deepEqual(await stale.json(),{error:{code:'DASHBOARD_VIEW_UNBOUND'}});
  assert.equal(hostReads,count);assert.equal(g.starts.length,1);assert.equal(g.f.calls.tasks.length,initialTasks+1);
  assert.deepEqual(await g.beforeHistory(),g.beforeOld);
  t.diagnostic(JSON.stringify({registered:tool.name,source:'/api/overview',bindSequence:sequence,unbindSequence:handshakes.at(-1).payload.seq,
    factCount:overview.facts,planCount:overview.channel_counts.plan,fixedFrameStarts:g.reads.length,postUnbindStarts:0,denials:[refused.status,stale.status]}));
});

// One separate provisioning read, then N=8 through the genuine Project API.
test('managed owner: eight validated reads retain one budgeted slot, normal write protocol and history', async t => {
  const g = await setup(t), before = await g.usage();
  assert.equal(g.starts.length, 0);
  assert.deepEqual((await g.get({factId:FID})).fact, fact);
  const provision = g.reads[0], baseline = await g.usage(), s = provision.input.cwd;
  assert.deepEqual(delta(baseline,before), { directories:1, entries:3, charged:MANAGED_READ_SLOT_BYTES, logical:MANAGED_READ_SLOT_BYTES });
  const physical = (await fingerprint(s)).map(({sha:_,...rest})=>rest);
  assert.deepEqual(physical.map(x=>x.name),files);
  assert.deepEqual(physical.map(x=>x.size),[FRAME,FRAME,101]);
  const bundle = [];
  for (let i=0; i<8; i++) {
    const value=await g.get(i%2 ? {factId:FID} : {limit:1});
    if (i%2) assert.deepEqual(value.fact,fact);
    else { assert.equal(value.page.total,1); assert.equal(value.facts[0].fact_id,FID); }
    const r=g.reads.at(-1); assert.equal(r.input.cwd,s); assert.equal(r.generation,i+2);
    bundle.push(await g.audit(r));
  }
  const after = await g.usage(); assert.deepEqual(after,baseline);
  assert.deepEqual((await fingerprint(s)).map(({sha:_,...rest})=>rest),physical);
  assert.equal(new Set(g.reads.map(x=>x.request.requestId)).size,9);
  assert.deepEqual(await g.beforeHistory(),g.beforeOld);
  const slotSnapshot=await fingerprint(s);
  await g.f.service.invoke('gm_add',{kind:'plan',claim:'Fixture write using old exchange.'},g.p.context);
  const write=g.starts.at(-1);assert.equal(write.request.operation,'gm_add');assert.equal(write.isFrame,false);
  assert.deepEqual((await fs.readdir(write.input.cwd)).sort(),['.complete','request.json','result.json']);
  assert.deepEqual(await fingerprint(s),slotSnapshot);
  const count = g.starts.length;
  const oldInstance = await g.reopenOverlapping(), beforeFresh = await g.usage();
  const status=await g.f.service.status(g.p.projectId,origin);assert.equal(g.starts.length,count);
  for(const a of bundle){const r=g.reads.find(x=>x.request.context.runId===a.id);assert.deepEqual(await g.audit(r),a);assert.ok(status.coreOperations.some(x=>x.operationId===a.id&&x.outcome==='succeeded'&&x.pending===false));}
  assert.deepEqual((await g.get({factId:FID})).fact,fact);
  const reopened=g.reads.at(-1);assert.equal(reopened.generation,1);assert.notEqual(reopened.input.cwd,s);
  const freshDelta=delta(await g.usage(),beforeFresh);
  assert.deepEqual(freshDelta,{directories:1,entries:3,charged:MANAGED_READ_SLOT_BYTES,logical:MANAGED_READ_SLOT_BYTES});
  assert.deepEqual(await fingerprint(s),slotSnapshot);assert.deepEqual(await g.beforeHistory(),g.beforeOld);
  await oldInstance.dispose();
  assert.deepEqual(await fingerprint(s),slotSnapshot);
  t.diagnostic(JSON.stringify({provision:delta(baseline,before),steady:delta(after,baseline),readCount:8,audits:bundle,overlapFreshSlot:freshDelta,oldOwnerClosedOnlyAfterFreshRead:true,reopenOldBytesUnchanged:true,writeLegacy:true}));
});

test('managed owner: parallel projects and unbranded main reads cannot share a slot', async t => {
  const g=await setup(t), q=await g.initialize();
  const readQ=()=>g.f.service.result({projectId:q.projectId,factId:FID},origin);
  const packed=await Promise.all([g.get({factId:FID}),readQ()]);assert.deepEqual(packed.map(x=>x.fact),[fact,fact]);
  assert.equal(new Set(g.reads.map(x=>x.input.cwd)).size,2);assert.deepEqual(g.reads.map(x=>x.generation),[1,1]);
  const old=await Promise.all(g.reads.map(x=>fingerprint(x.input.cwd)));
  const unbranded=g.bridge(g.reads[0].input.taskId);
  try {
    assert.deepEqual(await unbranded.call(g.reads[0].request.context,'fact_get',{fact_id:FID}),fact);
    assert.equal(g.starts.at(-1).isFrame,false);assert.equal(g.reads.length,2);
  } finally { await unbranded.dispose(); }
  assert.deepEqual(await Promise.all(g.reads.map(x=>fingerprint(x.input.cwd))),old);
});

test('managed owner: fresh budget refusal before slot mkdir leaves no fenced placeholder', async t => {
  const g=await setup(t), p = path.join(g.oldDirs[0],'fill');
  const now=await g.usage();await fs.writeFile(p,'');await fs.truncate(p,CORE_CALLS_MAX_BYTES - now.charged - CORE_CALL_RESERVATION_BYTES);
  const baseline=await g.usage(); assert.equal(CORE_CALLS_MAX_BYTES-baseline.charged,CORE_CALL_RESERVATION_BYTES);
  const d=g.bridge('test-managed-budget');
  const request={projectId:g.p.projectId,runId:'control-budget',role:'main',author:'saved-main'};
  try {
    const promise=d.call(request,'fact_get',{fact_id:FID},undefined,projectReadScratchOptions());
    await assert.rejects(promise,e=>{assert.equal(e.code,'RESEARCH_RUNTIME_CAPACITY');assert.equal(runtimeManagedIpcRefusal(d,promise,e,'fact_get'),'byte-limit');assert.equal(e.startOutcome,'not-attempted');return true;});
    assert.equal(g.starts.length,0);assert.deepEqual(await g.usage(),baseline);
  } finally { await d.dispose(); }
  await fs.truncate(p,0); // Synthetic capacity restoration, not a runtime action.
  assert.deepEqual((await g.get({factId:FID})).fact,fact);
  assert.equal(g.reads.length,1); assert.equal(g.reads[0].generation,1);
});

for (const reason of ['unsafe-entry','byte-limit']) test(`managed owner: reuse rejects whole-root ${reason} without touching its slot`, async t => {
  const g=await setup(t);
  assert.deepEqual((await g.get({factId:FID})).fact,fact);
  const original=g.reads[0], s=original.input.cwd;
  if(reason==='unsafe-entry') await fs.symlink(g.oldDirs[1],path.join(g.oldDirs[0],'synthetic-alias'));
  else {
    const target=path.join(g.oldDirs[0],'fill'); await fs.writeFile(target,'');
    await fs.truncate(target, CORE_CALLS_MAX_BYTES-(await g.usage()).charged);
    // At exactly the byte ceiling, a reserved slot is not charged again.
    const end=await g.usage();assert.equal(end.charged,CORE_CALLS_MAX_BYTES);
    assert.deepEqual((await g.get({factId:FID})).fact,fact);
    assert.deepEqual(await g.usage(),end); assert.equal(g.reads.at(-1).input.cwd,s);
    await fs.truncate(target,(await fs.stat(target)).size+1);
  }
  const saved=await fingerprint(s), before=g.starts.length, b=g.bridge('test-reuse-budget');
  try {
    const p=b.call(original.request.context,'fact_get',{fact_id:FID},undefined,projectReadScratchOptions());
    await assert.rejects(p,e=>{assert.equal(e.code,'RESEARCH_RUNTIME_CAPACITY');assert.equal(e.startOutcome,'not-attempted');
      assert.equal(runtimeManagedIpcRefusal(b,p,e,'fact_get'),reason);return true;});
  }finally{await b.dispose();}
  assert.equal(g.starts.length,before); assert.deepEqual(await fingerprint(s),saved);
});

test('managed owner: replaced slot path confers no authority even with identical files', async t=>{
  const g=await setup(t);assert.deepEqual((await g.get({factId:FID})).fact,fact);
  const r=g.reads[0], displaced=path.join(g.ipc,'displaced-original-fixture');
  await fs.rename(r.input.cwd,displaced);await fs.cp(displaced,r.input.cwd,{recursive:true});
  const a=await fingerprint(displaced), b=await fingerprint(r.input.cwd);
  await assert.rejects(g.get({factId:FID}),{code:'RESEARCH_RUNTIME_READ_SLOT_FENCED'});
  assert.deepEqual(await fingerprint(displaced),a);assert.deepEqual(await fingerprint(r.input.cwd),b);assert.equal(g.starts.length,1);
});

test('managed owner: preflight denial closes original handles without deleting an exchange', async t=>{
  const g=await setup(t); const original=fs.open, opens=[]; let hook;
  try {
    hook=t.mock.method(fs,'open',async (...args)=>{
      const handle=await original(...args);
      if(typeof args[0]==='string'&&args[0].startsWith(g.ipc+path.sep)&&typeof args[1]==='number'&&(args[1]&constants.O_CREAT)) opens.push(handle);
      return handle;
    });
    g.f.sdk.runtime.start=async()=>{throw Object.assign(new Error('Synthetic explicit pre-spawn refusal'),{code:'APP_CAPABILITY_DENIED',operation:'runtime.start',capability:'app/runtime.execute'});};
    await assert.rejects(g.get({factId:FID}),{code:'RESEARCH_RUNTIME_DENIED'});
    assert.equal(opens.length,3);assert.ok(opens.every(fd=>fd.fd===-1));
    const extra=(await fs.readdir(g.ipc)).find(x=>!x.startsWith('old-'));
    assert.deepEqual((await fs.readdir(path.join(g.ipc,extra))).sort(),files);
    await assert.rejects(g.get({factId:FID}),{code:'RESEARCH_RUNTIME_READ_SLOT_FENCED'});
    assert.deepEqual(await g.beforeHistory(),g.beforeOld);
  }finally{hook?.mock.restore();}
});

test('managed owner: narrow Node permission permits preparation and matched readback', async t => {
  const g=await setup(t), data=g.f.dataDir, taskId='synthetic-narrow-task';
  g.f.tasks.set(taskId,{scope:'app'});
  const runtimeRoot=path.join(repo,'packages/hana-math/runtime');
  const runtimeURL=new URL('../packages/hana-math/runtime/research-runtime.mjs',import.meta.url).href;
  const code=`import assert from 'node:assert/strict';
    import { createAppResearchCore, projectReadScratchOptions } from ${JSON.stringify(runtimeURL)};
    const [dataDir,packageRoot,projectId,taskId,factId]=process.argv.slice(1);
    assert.equal(process.permission.has('child'),false);
    assert.equal(process.permission.has('fs.write',packageRoot),false);
    assert.equal(process.permission.has('fs.write',dataDir),true);
    let terminal;
    const sdk={dataDir,runtime:{
      start(input){return new Promise((resolve,reject)=>{
        process.once('message',m=>{if(m.error)reject(Error(m.error));else{terminal=m.runtime;resolve(terminal);}});
        process.send({start:input});
      });},
      get(id){assert.equal(id,terminal.runtimeId);return terminal;},
      watch(){assert.fail('no watch');},stop(){assert.fail('no stop');},
    }};
    const instance=createAppResearchCore(sdk,{packageRoot});const bridge=instance.createCore({taskId});
    try {
      const result=await bridge.call({projectId,runId:'control-narrow',role:'main',author:'saved-main'},'fact_get',{fact_id:factId},undefined,projectReadScratchOptions());
      assert.equal(result.fact_id,factId);assert.ok(result.markdown.includes('Synthetic nonempty fact.'));
      process.send({readback:true,length:Buffer.byteLength(result.markdown)});
    } finally {await bridge.dispose();await instance.dispose();process.disconnect();}`;
  const child=spawn(process.execPath,['--permission',`--allow-fs-read=${runtimeRoot}`,`--allow-fs-read=${g.pkg}`,`--allow-fs-read=${data}`,`--allow-fs-write=${data}`, '--input-type=module','-e',code,data,g.pkg,g.p.projectId,taskId,FID],
    {stdio:['ignore','pipe','pipe','ipc'],timeout:10000});
  let stdout='',stderr='',observed=null,count=0;
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.on('message',m=>{
    if(m.start){count++;g.f.sdk.runtime.start(m.start).then(runtime=>{if(child.connected)child.send({runtime});},err=>{if(child.connected)child.send({error:String(err)});});}
    else observed=m;
  });
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  assert.deepEqual(exit,{code:0,signal:null},stderr);assert.equal(stdout,'');
  assert.equal(count,1);assert.deepEqual(observed,{readback:true,length:Buffer.byteLength(fact.markdown)});
  assert.equal(g.reads.length,1);assert.equal(g.reads[0].generation,1);
  assert.deepEqual(await g.beforeHistory(),g.beforeOld);
  t.diagnostic(JSON.stringify({node:process.version,narrowFs:true,childPermission:false,outerPackagedPython:true,prepareAndReadback:true}));
});

for (const mode of ['audit EIO','unsettled task','late terminal receipt']) test(`managed owner: ${mode} cannot release a generation`, async t=>{
  const late=mode==='late terminal receipt';
  const g=await setup(t,late?{timeoutMs:500,cleanupTimeoutMs:100}:{}), gate=defer(), childDone=defer();
  let hook;const hits=[];
  try {
    if (mode==='audit EIO') {
      const rename=fs.rename;
      hook=t.mock.method(fs,'rename',async (from,to)=>{
        const item=g.reads.at(-1);
        if(item&&to===g.recordPath(item)){const attempted=await json(from);if(attempted.phase==='finished'){
          hits.push({revision:attempted.revision,old:(await g.record(item)).revision,error:'EIO'});
          throw Object.assign(new Error('Synthetic final audit denial'),{code:'EIO'});
        }}
        return rename(from,to);
      });syncBuiltinESMExports();
    } else if (mode==='unsettled task') {
      const original=g.f.sdk.tasks.complete;
      g.f.sdk.tasks.complete=async(id,...a)=>id===g.reads.at(-1)?.input.taskId?structuredClone(g.f.tasks.get(id)):original(id,...a);
    } else {
      g.runtimeHooks.afterChild=async()=>{childDone.resolve();await gate.promise;};
    }
    const actual=g.get({factId:FID}), expected=mode==='audit EIO'?'PROJECT_CORE_PERSISTENCE_FAILED':mode==='unsettled task'?'PROJECT_CORE_SETTLEMENT_FAILED':'RESEARCH_RUNTIME_TIMEOUT';
    const rejection=assert.rejects(actual,{code:expected});
    if(late) await Promise.race([childDone.promise,actual.then(()=>assert.fail('unexpected completion'),e=>{assert.fail(`no actual child before ${e.code}`);})]);
    await rejection;
    assert.equal(g.reads.length,1);
    const first=g.reads[0], oldSlot=await fingerprint(first.input.cwd), record=await g.record(first);
    assert.equal((await fs.readFile(path.join(first.input.cwd,'state.frame')))[8],3); // even valid published bytes do not release
    assert.ok(record.phase!=='finished'||record.pending||!record.settlement.confirmed);
    if(mode==='audit EIO'){assert.ok(hits.length>0&&hits.every(h=>h.revision>h.old));assert.equal(g.f.tasks.get(first.input.taskId).status,'completed');}
    if(mode==='unsettled task')assert.equal(g.f.tasks.get(first.input.taskId).status,'pending');
    gate.resolve();
    const blocked=g.bridge('test-fence-after-failure');
    try {
      await assert.rejects(blocked.call(first.request.context,'fact_get',{fact_id:FID},undefined,projectReadScratchOptions()),{code:'RESEARCH_RUNTIME_READ_SLOT_FENCED'});
    } finally { await blocked.dispose(); }
    assert.equal(g.starts.length,1);assert.deepEqual(await fingerprint(first.input.cwd),oldSlot);assert.deepEqual(await g.beforeHistory(),g.beforeOld);
    t.diagnostic(JSON.stringify({mode,error:expected,actualChildPublished:true,faults:hits,audit:{phase:record.phase,revision:record.revision,confirmed:record.settlement.confirmed},noSecondProcess:true,historyUnchanged:true}));
  } finally { gate.resolve(); if(hook){hook.mock.restore();syncBuiltinESMExports();} }
});
