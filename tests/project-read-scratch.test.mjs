// FakeSDK only. Real Project, CoreAccess, IPC and durable operation store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
import { fixtureFactPage } from './fact-page-fixture.mjs';
import { createResearchRuntime } from '../packages/hana-math/runtime/research-runtime.mjs';

const facts = [...'abcd'].map(ch => ({ fact_id: ch.repeat(16), predecessors: [], markdown: `---\nfact_id: ${ch.repeat(16)}\npredecessors: []\nexternal_refs: []\n---\n## statement\nFixture fact ${ch}.\n## proof\nFixture proof.\n` }));
const json = async f => JSON.parse(await fs.readFile(f,'utf8'));
const names = async f => (await fs.readdir(f)).sort();
const fault = code => Object.assign(new Error(code),{code});
// The fixture host creates and controls its fresh temporary data root; the
// permission smoke's parent creates its fresh sandbox before entering Node.
// This is not a claim about any real Host or an arbitrary SDK directory.
function freshFixtureLifetime(sdk, root) {
  let tenure = Symbol('fixture scratch tenure');
  return {
    withExclusiveReadScratch(owner, data, use) { if (tenure && owner === sdk && data === root) use(tenure); },
    revoke() { tenure = null; },
    renew() { tenure = Symbol('renewed fixture scratch tenure'); },
  };
}
async function setup(t, { exclusive = true, prepared } = {}) {
  const install = prepared?.install ?? await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'read-scratch-stub-')));
  if(!prepared){
    t.after(() => fs.rm(install,{recursive:true,force:true}));
    for (const [rel, source] of Object.entries({ 'runtime/research_entry.py': '../packages/hana-math/runtime/research_entry.py', 'engine/src/hana_math_engine/research.py': '../engine/src/hana_math_engine/research.py' })) {
      const to=path.join(install,rel); await fs.mkdir(path.dirname(to),{recursive:true}); await fs.copyFile(new URL(source,import.meta.url),to);
    }
    await fs.mkdir(path.join(install,'dependencies/python/bin'),{recursive:true});
    await fs.writeFile(path.join(install,'dependencies/python/bin/python3'),'never spawned',{mode:0o700});
    await fs.writeFile(path.join(install,'dependencies/runtime.json'),JSON.stringify({schemaVersion:1,platform:'darwin',arch:'arm64',pythonVersion:'3.12.14',executable:'dependencies/python/bin/python3'}));
  }
  const calls=[], runtimes=new Map(), hooks={}; let f, lifetime;
  const runtime = (o, sdk = f.sdk, withExclusiveReadScratch = lifetime?.withExclusiveReadScratch) =>
    createResearchRuntime(sdk,{taskId:o.taskId,packageRoot:install,platform:'darwin',arch:'arm64',
      ...(withExclusiveReadScratch === undefined ? {} : {withExclusiveReadScratch})});
  // The restricted child must not create or write anything outside its assigned root.
  const dataHook=prepared&&t.mock.method(fs,'mkdtemp',async prefix=>{
    assert.equal(prefix,path.join(os.tmpdir(),'math-project-service-'));return prepared.data;
  });
  if(dataHook)syncBuiltinESMExports();
  try { f=await fixture(prepared ? {after(){}} : t,{multiWorker:true,createCore:runtime,
    summaryWriter:{async start(input){
      const section=input.kind==='paper-section';
      const agentId=`math-paper-${section?'section-writer':'planner'}-01234567-89ab-cdef-0123-456789abcdef`;
      const binding={role:'report-writer',agentId,sessionId:`fake-scratch-${input.reportId}`,sessionPath:`/fixture/${input.reportId}.jsonl`,kind:`math-${input.kind}:${input.projectId}:${input.reportId}`,cwd:input.cwd,sendState:'accepted',sendPending:false};
      await input.onBound(binding);
      const terminal={...binding,state:'completed',modelStopReason:'stop',cleanupPending:false,finalText:section?'\\section{Fixture}\\label{sec:fixture}\nOpaque body.\n':`%%%PREAMBLE%%%\nFixture\n%%%FRONTMATTER%%%\nFixture\n%%%SECTIONS%%%\n[{"title":"Fixture","label":"sec:fixture","fact_ids":["${facts[0].fact_id}"]}]\n%%%BIBLIOGRAPHY%%%\nFixture\n`};
      return {done:Promise.resolve(terminal),async stop(){return terminal;}};
    },async dispose(){return {cleanupPending:false};}}}); }
  finally { if(dataHook){dataHook.mock.restore();syncBuiltinESMExports();} }
  assert.equal((await fs.stat(f.dataDir)).mode & 0o777, 0o700);
  if (exclusive) lifetime = freshFixtureLifetime(f.sdk, f.dataDir);
  f.sdk.sessions.send=()=>assert.fail('no model send');
  f.sdk.runtime={async start(input){
    const req=await json(input.args[4]); const call={req,dir:input.cwd,taskId:input.taskId};calls.push(call);
    const result=req.operation==='fact_list_page'?fixtureFactPage(facts,req.arguments,req.context.projectId):req.operation==='fact_get'?facts.find(f=>f.fact_id===req.arguments.fact_id):{hits:[]};
    await fs.writeFile(input.args[5],JSON.stringify({schemaVersion:1,requestId:req.requestId,ok:true,result,...hooks.envelope?.(call)}),{mode:0o600,flag:'wx'});
    await hooks.start?.(call);
    const receipt={runtimeId:req.requestId,state:'exited',exitCode:0,runtime:'command',profile:'scoped',network:'none'}; runtimes.set(req.requestId,receipt); return receipt;
  },async get(id){return runtimes.get(id);},watch(){assert.fail('no watch');},stop(){assert.fail('no stop');}};
  const {projectId,context}=await f.create(); const ipc=path.join(f.dataDir,'research/core-calls'), historical=path.join(ipc,'old-synthetic');
  await fs.mkdir(historical,{recursive:true,mode:0o700}); await fs.writeFile(path.join(historical,'.complete'),'',{mode:0o600}); await fs.writeFile(path.join(historical,'request.json'),'old unrelated bytes',{mode:0o600});
  const old=async()=>({bytes:await fs.readFile(path.join(historical,'request.json'),'utf8'),dir:(await fs.stat(historical)).ino,file:(await fs.stat(path.join(historical,'request.json'))).ino,entries:await names(historical)});
  const initial=await old(); return {f,ipc,install,projectId,context,calls,hooks,old,initial,runtime,lifetime,read:args=>f.service.result({projectId,...args},origin),
    records:path.join(f.dataDir,'research/projects',projectId,'core'),status:()=>f.service.status(projectId,origin)};
}
async function assertSettled(g,call){
  const id=call.req.context.runId, m=await json(path.join(g.records,id+'.json'));
  assert.partialDeepStrictEqual(m,{phase:'finished',pending:false,outcome:{state:'succeeded'},cleanup:{confirmed:true},settlement:{confirmed:true},taskId:call.taskId});
  assert.partialDeepStrictEqual(g.f.tasks.get(call.taskId),{status:'completed',result:{controlId:id,coreOutcome:'succeeded'}});
  return m;
}

for (const exclusive of [false,true]) test(`Project scratch: eight validated reads preserve eight settled records (${exclusive ? 'exclusive fixture' : 'default'})`,async t=>{
  const g=await setup(t,{exclusive}); let options={limit:1}; const m=[];
  assert.equal((await fs.stat(g.ipc)).mode & 0o777, 0o700);
  const before=await names(g.ipc), stat=syncFs.lstatSync, identityChecks=[];
  t.mock.method(syncFs,'lstatSync',(file,...args)=>{
    if(typeof file==='string' && (file===g.f.dataDir || file.startsWith(g.f.dataDir+path.sep)) && args[0]?.bigint)identityChecks.push(file);
    return stat(file,...args);
  });
  for(const fact of facts){
    const page=await g.read(options);assert.equal(page.facts[0].fact_id,fact.fact_id); options={limit:1,cursor:page.page.nextCursor};
    assert.deepEqual((await g.read({factId:fact.fact_id})).fact,fact);
  }
  assert.equal(options.cursor,null);assert.equal(g.calls.length,8);
  for(const call of g.calls)m.push(await assertSettled(g,call));
  await g.f.open();const status=await g.status();assert.equal(status.coreOperations.length,8);assert.equal(g.calls.length,8);
  for(const row of m){assert.deepEqual(await json(path.join(g.records,row.operationId+'.json')),row);assert.ok(status.coreOperations.some(r=>r.operationId===row.operationId&&r.outcome==='succeeded'&&!r.pending));}
  assert.deepEqual(await g.old(),g.initial);
  const retained=(await names(g.ipc)).filter(name=>!before.includes(name));
  assert.deepEqual(retained,exclusive?[]:g.calls.map(call=>path.basename(call.dir)).sort());
  for(const dir of retained)assert.deepEqual(await names(path.join(g.ipc,dir)),['.complete','request.json','result.json']);
  if(exclusive)assert.ok(identityChecks.length>0);else assert.deepEqual(identityChecks,[]);
  t.diagnostic(JSON.stringify({exclusive,rootMode:0o700,newIpcDirs:retained.length,settledRecords:m.length,nativeCallsAfterReopen:g.calls.length,historicalUnchanged:true,identityChecks:identityChecks.length}));
});

for (const exclusive of [false,true]) test(`Project scratch: plan/section admission and runner (${exclusive ? 'exclusive fixture' : 'default'}), other operations retain`,async t=>{
  const g=await setup(t,{exclusive});await g.f.service.finalize({projectId:g.projectId,factIds:[facts[0].fact_id]},origin);
  await g.f.service.graph({projectId:g.projectId},origin); await g.f.service.invoke('gm_search',{query:'fixture'},g.context);
  const retained=await names(g.ipc);assert.deepEqual(retained,['old-synthetic',...g.calls.map(call=>path.basename(call.dir))].sort());
  // Graph reads the page and separately rechecks the snapshot with limit:1.
  assert.deepEqual(g.calls.map(call=>call.req.operation),['fact_get','fact_list_page','fact_list_page','gm_search']);
  async function checkReport(submit,status,publicationStatus) {
    const previous=await names(g.ipc), before=g.calls.length, q=await submit(), admission=g.calls.length;
    const sched=[...g.f.schedules.values()].find(x=>x.payload?.reportId===q.reportId);assert.ok(sched);
    assert.ok(admission>before);
    await g.f.handlers.get('math-project-report').run({kind:'schedule',scheduleId:sched.scheduleId,input:sched.payload});
    assert.equal((await status(q)).publicationStatus,publicationStatus);assert.ok(g.calls.length>admission);
    for(const call of g.calls.slice(before))await assertSettled(g,call);
    const newDirs=g.calls.slice(before).map(call=>path.basename(call.dir));
    assert.deepEqual(await names(g.ipc),[...previous,...(exclusive?[]:newDirs)].sort());
    t.diagnostic(JSON.stringify({exclusive,publicationStatus,admissionReads:admission-before,runnerReads:g.calls.length-admission,retainedDirs:exclusive?0:newDirs.length}));return q;
  }
  const plan=await checkReport(()=>g.f.service.paperPlan({projectId:g.projectId,brief:'Fixture plan.'},origin),q=>g.f.service.paperPlanStatus({projectId:g.projectId,reportId:q.reportId},origin),'reviewable-plan');
  await checkReport(()=>g.f.service.paperSection({projectId:g.projectId,planReportId:plan.reportId},origin),q=>g.f.service.paperSectionStatus({projectId:g.projectId,reportId:q.reportId},origin),'reviewable-section');
  assert.deepEqual(await g.old(),g.initial);
});

for(const style of ['invalid-business','wrong-envelope','task-unconfirmed','extra','replaced','preexisting-marker','non-private','io-failure','partial','rmdir-failure'])test(`Project scratch: ${style} never misreports a release or changes the accepted read`,async t=>{
  const g=await setup(t); const complete=g.f.sdk.tasks.complete;
  if(style==='invalid-business')g.hooks.envelope=()=>({result:{...facts[1]}});
  if(style==='wrong-envelope')g.hooks.envelope=()=>({requestId:'wrong'});
  if(style==='task-unconfirmed')g.f.sdk.tasks.complete=async id=>structuredClone(g.f.tasks.get(id));
  if(style==='extra')g.hooks.start=call=>fs.writeFile(path.join(call.dir,'extra'),'owned by no call');
  if(style==='preexisting-marker')g.hooks.start=call=>fs.writeFile(path.join(call.dir,'.complete'),'',{mode:0o600});
  if(style==='non-private')await fs.chmod(g.ipc,0o755);
  if(style==='replaced')g.f.sdk.tasks.complete=async (...a)=>{const p=path.join(g.calls.at(-1).dir,'result.json');await fs.rename(p,p+'.held'); await fs.copyFile(p+'.held',p);await fs.unlink(p+'.held');return complete(...a);};
  if(style==='io-failure'||style==='partial'){
    const unlink=syncFs.unlinkSync;let n=0;
    t.mock.method(syncFs,'unlinkSync',function(p){if(g.calls.length&&path.dirname(p)===g.calls.at(-1).dir&&++n===(style==='partial'?2:1))throw fault('EIO');return unlink(p);});
  }
  if(style==='rmdir-failure'){
    const rmdir=syncFs.rmdirSync;
    t.mock.method(syncFs,'rmdirSync',function(p){if(g.calls.at(-1)?.dir===p)throw fault('EIO');return rmdir(p);});
  }
  if(['invalid-business','wrong-envelope','task-unconfirmed'].includes(style))await assert.rejects(g.read({factId:facts[0].fact_id}));
  else {assert.deepEqual((await g.read({factId:facts[0].fact_id})).fact,facts[0]);await assertSettled(g,g.calls[0]);}
  assert.equal(g.calls.length,1);const files=await names(g.calls[0].dir);
  if(style==='rmdir-failure')assert.deepEqual(files,[]); // Reservation stays conservative without .complete.
  else {
    assert.ok(files.includes('.complete'));
    if(style==='partial')assert.equal(files.length,2);else assert.ok(files.includes('request.json')&&files.includes('result.json'));
  }
  if(style==='extra')assert.equal(await fs.readFile(path.join(g.calls[0].dir,'extra'),'utf8'),'owned by no call');
  assert.deepEqual(await g.old(),g.initial);
});

test('Project scratch: cancel while native operation is in flight retains IPC and never repeats the read',async t=>{
  const g=await setup(t),entered=defer(),release=defer();g.hooks.start=async()=>{entered.resolve();await release.promise;};
  const read=g.read({factId:facts[0].fact_id});read.catch(()=>{});await entered.promise;
  const disposing=g.f.service.dispose();release.resolve();await assert.rejects(read);await disposing;
  assert.equal(g.calls.length,1);assert.ok((await names(g.ipc)).includes(path.basename(g.calls[0].dir)));assert.deepEqual(await g.old(),g.initial);
});

test('Project scratch: a settled report read whose creator guard fails is retained, earlier validated read is not undone',async t=>{
  const g=await setup(t);await g.f.service.finalize({projectId:g.projectId,factIds:[facts[0].fact_id]},origin);
  const split=g.calls.length, ctx={...origin}, complete=g.f.sdk.tasks.complete;
  g.f.sdk.tasks.complete=async (...args)=>{const result=await complete(...args);if(g.calls.length===split+2)ctx.callToken='fixture-guard-changed';return result;};
  await assert.rejects(g.f.service.paperPlan({projectId:g.projectId,brief:'Fixture bounded.'},ctx),{code:'PROJECT_PAPER_CHANGED'});
  const chain=g.calls.slice(split);assert.equal(chain.length,2);for(const row of chain)await assertSettled(g,row);
  const retained=await names(g.ipc);
  assert.ok(!retained.includes(path.basename(chain[0].dir)));assert.ok(retained.includes(path.basename(chain[1].dir)));
  assert.equal(g.f.calls.tasks.filter(row=>row.handlerKey==='math-project-report').length,0);
});

test('Project scratch: persisted/cloned results and wrong owners cannot consume the in-memory grant',async t=>{
  const g=await setup(t);
  const {createProjectCoreAccess,releaseValidatedProjectRead}=await import('../packages/hana-math/project-core-access.mjs');
  const {takeProjectReadScratch}=await import('../packages/hana-math/runtime/research-runtime.mjs');
  let bridge;
  const file=path.join(g.f.dataDir,'direct-fixture-receipt.json');
  const access=createProjectCoreAccess(g.f.sdk,{projectId:g.projectId,author:'saved-main',createCore:o=>(bridge=g.runtime(o)),onState:row=>fs.writeFile(file,JSON.stringify(row))});
  const value=await access.callReadScratch('fact_get',{fact_id:facts[0].fact_id});
  const persisted=await json(file), dir=g.calls.at(-1).dir;
  assert.equal(persisted.phase,'finished');assert.equal(persisted.settlement.confirmed,true);
  assert.equal(takeProjectReadScratch(bridge,Promise.resolve(value),'fact_get',value),null);
  releaseValidatedProjectRead(access,persisted.outcome.result);
  releaseValidatedProjectRead(access,structuredClone(value));
  releaseValidatedProjectRead({},value);
  assert.deepEqual(await names(dir),['.complete','request.json','result.json']);
  // Simulated trusted consumer after its own equality check; not a public action.
  assert.deepEqual(value,facts[0]);releaseValidatedProjectRead(access,value);
  assert.ok(!(await names(g.ipc)).includes(path.basename(dir)));
  releaseValidatedProjectRead(access,value);assert.deepEqual(await g.old(),g.initial);
});

test('Project scratch: separate default Project instances sharing one root both retain validated reads',async t=>{
  const g=await setup(t,{exclusive:false});
  const first=g.f.service, other=await g.f.create();
  const second=await g.f.open();
  assert.notEqual(first,second);
  const complete=async(service,projectId,fact)=>{
    assert.deepEqual((await service.result({projectId,factId:fact.fact_id},origin)).fact,fact);
    const call=g.calls.at(-1), records=path.join(path.dirname(path.dirname(g.records)),projectId,'core');
    await assertSettled({...g,records},call);
    assert.deepEqual(await names(call.dir),['.complete','request.json','result.json']);
  };
  try {
    await complete(first,g.projectId,facts[0]);
    await complete(second,other.projectId,facts[1]);
    assert.equal(g.calls.length,2);
    assert.deepEqual(await names(g.ipc),['old-synthetic',...g.calls.map(c=>path.basename(c.dir))].sort());
    assert.deepEqual(await g.old(),g.initial);
  } finally { await first.dispose(); }
});

test('Project scratch: forged, foreign, revoked and superseded lifetimes cannot retire a settled read',async t=>{
  const g=await setup(t);
  const {createProjectCoreAccess,releaseValidatedProjectRead}=await import('../packages/hana-math/project-core-access.mjs');
  const provider=g.lifetime.withExclusiveReadScratch, root=g.f.dataDir;
  const otherRoot=await fs.mkdtemp(path.join(os.tmpdir(),'scratch-other-unadmitted-'));
  t.after(()=>fs.rm(otherRoot,{recursive:true,force:true}));
  const foreign={...g.f.sdk};
  const cases=[
    {withLifetime:true}, {withLifetime:root}, {withLifetime:JSON.parse('{"tenure":1}')},
    {withLifetime:()=>true}, {withLifetime:(_sdk,_root,use)=>use({})},
    {sdk:foreign,withLifetime:provider},
    {withLifetime:provider,afterRead:()=>{g.f.sdk.dataDir=otherRoot;},restore:()=>{g.f.sdk.dataDir=root;}},
    {withLifetime:provider,afterRead:g.lifetime.revoke},
    {withLifetime:provider,afterRead:g.lifetime.renew},
    {withLifetime:(_sdk,_root,use)=>queueMicrotask(()=>use(Symbol('late')))},
  ];
  for(const {sdk=g.f.sdk,withLifetime,afterRead,restore} of cases){
    g.lifetime.renew();
    const access=createProjectCoreAccess(sdk,{projectId:g.projectId,author:'saved-main',createCore:o=>g.runtime(o,sdk,withLifetime),async onState(){}});
    const value=await access.callReadScratch('fact_get',{fact_id:facts[0].fact_id});assert.deepEqual(value,facts[0]);
    try {afterRead?.();releaseValidatedProjectRead(access,value);} finally {restore?.();}
    assert.deepEqual(await names(g.calls.at(-1).dir),['.complete','request.json','result.json']);
  }
  assert.equal(g.calls.length,cases.length);assert.deepEqual(await g.old(),g.initial);
});

test('Project scratch review: final revision persistence denial keeps the completed runtime exchange',async t=>{
  const g=await setup(t);
  await g.read({factId:facts[0].fact_id});
  const historicalPath=path.join(g.records,g.calls[0].req.context.runId+'.json');
  const historical=await fs.readFile(historicalPath);
  const rename=fs.rename, readdir=fs.readdir, rejected=[];
  const hook=t.mock.method(fs,'rename',async (from,to)=>{
    if(g.calls[1]&&to===path.join(g.records,g.calls[1].req.context.runId+'.json')){
      const attempted=await json(from);
      if(attempted.phase==='finished'){rejected.push(attempted);throw fault('EIO');}
    }
    return rename(from,to);
  });
  // Exercise the recovery of both canonical rows, then the fail-closed stop at
  // the actual leftover atomic temp. APFS enumeration order is not a contract.
  // No entry is hidden and the unacknowledged revision stays on disk as a temp.
  const order=t.mock.method(fs,'readdir',async (dir,...args)=>{
    const rows=await readdir(dir,...args);
    return dir===g.records ? rows.sort((a,b)=>Number(a.endsWith('.tmp'))-Number(b.endsWith('.tmp'))) : rows;
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(g.read({factId:facts[1].fact_id}),{code:'PROJECT_CORE_PERSISTENCE_FAILED'});
    assert.equal(g.calls.length,2); assert.equal(rejected.length,1);
    const call=g.calls[1], operationId=call.req.context.runId, file=path.join(g.records,operationId+'.json');
    assert.partialDeepStrictEqual(rejected[0],{operationId,phase:'finished',pending:false,taskStatus:'completed',outcome:{state:'succeeded',result:facts[1]},settlement:{confirmed:true}});
    assert.partialDeepStrictEqual(g.f.tasks.get(call.taskId),{status:'completed',result:{controlId:operationId,coreOutcome:'succeeded'}});
    const envelope=await json(path.join(call.dir,'result.json'));
    assert.deepEqual(envelope,{schemaVersion:1,requestId:call.req.requestId,ok:true,result:facts[1]});
    assert.deepEqual(await names(call.dir),['.complete','request.json','result.json']);
    const disk=await json(file);
    assert.partialDeepStrictEqual(disk,{operationId,phase:'settling',pending:true,settlement:{confirmed:false}});
    assert.ok(disk.revision<rejected[0].revision);
    assert.deepEqual(await fs.readFile(historicalPath),historical);
    const atomicTemps=(await names(g.records)).filter(name=>name.endsWith('.tmp'));
    assert.equal(atomicTemps.length,1);assert.deepEqual(await json(path.join(g.records,atomicTemps[0])),rejected[0]);
    await g.f.open();const status=await g.status();
    assert.equal(status.coreUnsettled,true);
    assert.ok(status.coreOperations.some(row=>row.operationId===operationId&&row.revision===disk.revision&&row.pending));
    assert.ok(status.coreOperations.some(row=>row.operationId===g.calls[0].req.context.runId&&!row.pending&&row.outcome==='succeeded'));
    assert.equal(g.calls.length,2); assert.deepEqual(await fs.readFile(historicalPath),historical); assert.deepEqual(await g.old(),g.initial);
    assert.deepEqual(await names(call.dir),['.complete','request.json','result.json']);
    t.diagnostic(JSON.stringify({error:'PROJECT_CORE_PERSISTENCE_FAILED',firstHistoryPreserved:true,runtimeEnvelopeOk:envelope.ok,task:'completed',onDisk:{phase:disk.phase,revision:disk.revision},unacknowledged:{phase:rejected[0].phase,revision:rejected[0].revision},calls:g.calls.length,retained:await names(call.dir)}));
  } finally { hook.mock.restore();order.mock.restore();syncBuiltinESMExports(); }
});

test('Project scratch review: a second bridge holding the same reservation root never schedules a late retirement', {timeout:20000},async t=>{
  const g=await setup(t), secondProject=await g.f.create();
  const firstSettling=defer(),ack=defer(),reserving=defer(),resume=defer();
  const complete=g.f.sdk.tasks.complete, readdir=fs.readdir, unlink=syncFs.unlinkSync, deleted=[];
  g.f.sdk.tasks.complete=async (id,payload)=>{
    const task=await complete(id,payload);
    if(id===g.calls[0]?.taskId){firstSettling.resolve();await ack.promise;}
    return task;
  };
  let armed=false,held=false,secondDone=false,first,second;
  const readHook=t.mock.method(fs,'readdir',async (dir,...args)=>{
    if(armed&&!held&&dir===g.ipc){held=true;reserving.resolve();await resume.promise;}
    return readdir(dir,...args);
  }); syncBuiltinESMExports();
  const deletionHook=t.mock.method(syncFs,'unlinkSync',file=>{if(path.dirname(path.dirname(file))===g.ipc)deleted.push(file);return unlink(file);});
  const sizes=async dir=>Object.fromEntries(await Promise.all((await names(dir)).map(async n=>[n,(await fs.stat(path.join(dir,n))).size])));
  try {
    first=g.read({factId:facts[0].fact_id});first.catch(()=>{});
    await Promise.race([firstSettling.promise,first.then(()=>assert.fail('first call returned before task acknowledgment'))]);
    const firstCall=g.calls[0], retainedBefore=await sizes(firstCall.dir);
    assert.equal(retainedBefore['.complete'],0);
    armed=true;
    second=g.f.service.result({projectId:secondProject.projectId,factId:facts[1].fact_id},origin);
    second.then(()=>{secondDone=true;},()=>{secondDone=true;});
    await Promise.race([reserving.promise,second.then(()=>assert.fail('second bridge did not enter actual IPC reservation'))]);
    assert.equal(g.calls.length,1,'second bridge is still inside admission before runtime.start');
    ack.resolve();
    assert.deepEqual((await first).fact,facts[0]);
    assert.equal(secondDone,false);assert.deepEqual(deleted,[]);
    await assertSettled(g,firstCall);assert.deepEqual(await sizes(firstCall.dir),retainedBefore);
    resume.resolve();
    assert.deepEqual((await second).fact,facts[1]);
    assert.equal(g.calls.length,2);
    const other=g.calls[1], otherRecords=path.join(path.dirname(path.dirname(g.records)),secondProject.projectId,'core');
    await assertSettled({...g,records:otherRecords},other);
    await new Promise(setImmediate);
    assert.deepEqual(await names(g.ipc),['old-synthetic',path.basename(firstCall.dir)].sort());
    assert.deepEqual(await sizes(firstCall.dir),retainedBefore);assert.deepEqual(await g.old(),g.initial);
    assert.deepEqual(deleted.map(f=>path.relative(other.dir,f)),['request.json','result.json','.complete']);
    const oldBytes=Object.values(await sizes(path.join(g.ipc,'old-synthetic'))).reduce((a,b)=>a+b,0);
    t.diagnostic(JSON.stringify({firstReturnedWhileSecondReservationHeld:true,createdExchanges:g.calls.length,retainedExchanges:2,retainedFirstFiles:retainedBefore,retainedRootLogicalBytes:oldBytes+Object.values(retainedBefore).reduce((a,b)=>a+b,0),lateFirstUnlinks:0,secondUnlinks:deleted.length}));
  } finally { ack.resolve();resume.resolve();await Promise.allSettled([first,second]);readHook.mock.restore();syncBuiltinESMExports();deletionHook.mock.restore();g.f.sdk.tasks.complete=complete; }
});

if(process.env.SCRATCH_REVIEW_CHILD==='1')test('Project scratch permission smoke: retire one read and keep its confirmed receipt',async t=>{
  const data=process.env.SCRATCH_REVIEW_DATA, install=process.env.SCRATCH_REVIEW_INSTALL, template=process.cwd();
  assert.ok(process.permission);
  assert.equal(process.permission.has('fs.read',path.dirname(template)),false);
  assert.equal(process.permission.has('fs.write',template),false);
  assert.equal(process.permission.has('fs.write',data),true);
  await assert.rejects(fs.lstat(path.dirname(template)),{code:'ERR_ACCESS_DENIED'});
  await assert.rejects(fs.writeFile(path.join(template,'write-probe'),'forbidden'),{code:'ERR_ACCESS_DENIED'});
  const g=await setup(t,{prepared:{data,install}}), errors=[], removed=[];
  for(const key of ['lstatSync','realpathSync','opendirSync','unlinkSync','rmdirSync']){
    const fn=syncFs[key];t.mock.method(syncFs,key,(file,...args)=>{
      try { const outcome=fn(file,...args); if(key==='unlinkSync')removed.push(path.relative(g.ipc,file));return outcome; }
      catch(error){errors.push({method:key,code:error.code});throw error;}
    });
  }
  assert.deepEqual((await g.read({factId:facts[0].fact_id})).fact,facts[0]);assert.equal(g.calls.length,1);
  const receipt=await assertSettled(g,g.calls[0]);
  const state=await names(g.ipc), rootMode=(await fs.stat(g.ipc)).mode&0o777;
  t.diagnostic(JSON.stringify({permission:true,rootMode,ipcEntries:state,removed,errors,operationId:receipt.operationId,taskId:receipt.taskId,phase:receipt.phase,settlement:receipt.settlement.confirmed}));
  assert.equal(rootMode,0o700);assert.deepEqual(removed.map(f=>path.basename(f)),['request.json','result.json','.complete']);
  assert.deepEqual(errors,[]);assert.deepEqual(state,['old-synthetic']);assert.deepEqual(await g.old(),g.initial);
});
