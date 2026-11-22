// Software-only through the real registered tool, Project service, queue and
// CoreAccess. Fake Host injects a graph; no installed App, Python or models.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { projectDashboardFactgraphOptions } from '../packages/hana-math/runtime/research-runtime.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';

const MIB=1<<20, A='a'.repeat(16), B='b'.repeat(16);
const sha=b=>createHash('sha256').update(b).digest('hex');
const serial=(n)=>n.toString(16).padStart(64,'0');
const graphFor=projectId=>({nodes:[
  {id:A,author:'fixture',problem_id:projectId,statement:'Synthetic statement',proof:'PRIVATE synthetic proof 甲\n\\[x^2\\ge0\\]',intuition:'',predecessors:[],depth:0},
  {id:B,author:'fixture',problem_id:projectId,statement:'Synthetic consequence',proof:'Using A.',intuition:'直观',predecessors:[A],depth:1},
],edges:[{source:A,target:B}],max_depth:1});
const checkError=(r,code)=>{assert.equal(r.isError,true,JSON.stringify(r.details)); assert.equal(r.details.error.code,code);assert.doesNotMatch(JSON.stringify(r),/PRIVATE|creator-stable|factgraph\.hanamathgraph/);};
const absent=p=>assert.rejects(fs.lstat(p),{code:'ENOENT'});
const turn=()=>new Promise(resolve=>setImmediate(resolve));

async function setup(t) {
  const controls={}, calls=[], stages=[];let f, tool;
  f=await fixture(t,{createCore:({taskId})=>({
    async call(binding,op,args,verification,options){
      assert.equal(op,'dashboard_factgraph');assert.equal(binding.role,'main');assert.match(binding.runId,/^control-/);
      assert.deepEqual(args,{});assert.equal(verification,undefined);assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(Object.keys(options),Object.keys(projectDashboardFactgraphOptions(options.signal)));
      const r={taskId,binding,asOf:serial(calls.length+1),disposed:false};calls.push(r);
      await controls.core?.(r);
      const result={projectId:binding.projectId,asOf:r.asOf,graph:graphFor(binding.projectId)};
      return controls.result?controls.result(result):result;
    },
    async dispose(){const r=calls.find(c=>c.taskId===taskId);if(r)r.disposed=true;return {confirmed:true};},
  })});
  const p=await f.create(); const startTasks=f.calls.tasks.length;
  const fail=()=>assert.fail('Unexpected model/research path');f.sdk.sessions.send=fail;
  const forbidden=['run','status','setupStatus','setToolMode','result','stop','invoke','recordSubmissionInputRejection'];
  const registration=await registerMathResearch({...f.sdk,tools:{async register(d){if(d.name==='math_project')tool=d;return ()=>{};}},resources:{async stage(input){
    const bytes=await fs.readFile(input.path), body=JSON.parse(bytes), call=calls.find(c=>c.asOf===body.asOf);
    assert.ok(call&&call.disposed);assert.equal(f.tasks.get(call.taskId).status,'completed');
    const row=JSON.parse(await fs.readFile(path.join(f.dataDir,'research/projects',body.projectId,'core',call.binding.runId+'.json'),'utf8'));
    assert.partialDeepStrictEqual(row,{operation:'dashboard_factgraph',phase:'finished',pending:false,taskStatus:'completed',settlement:{confirmed:true},cleanup:{confirmed:true}});
    assert.equal(row.outcome.result.asOf,body.asOf);
    stages.push({input,bytes,body});
    if(controls.stageError)throw Object.assign(new Error('PRIVATE opaque stage denial'),{code:'APP_CAPABILITY_DENIED'});
    return {ok:true, resource:{kind:'session-file',sessionId:controls.wrongOwner?'fixture-other-owner':'creator-stable',fileId:`graph-${stages.length}`}};
  }}},Object.fromEntries(forbidden.map(k=>[k,fail])), {...f.service, dashboardSnapshot:(...args)=>f.service.dashboardSnapshot(...args)});
  t.after(()=>registration.dispose());
  const request=(patch={},context=origin)=>tool.execute({action:'dashboard_snapshot',projectId:p.projectId,...patch,context});
  const exports=path.join(f.dataDir,'research/project-exports');
  const restart=async()=>{await f.service.dispose();await f.open();};
  return {f,p,controls,calls,stages,tool,request,exports,restart,startTasks};
}

test('dashboard snapshot stages UTF-8 bytes and metadata only; settled audit survives reopen', async t=>{
  const g=await setup(t);
  const schema=g.tool.parameters.oneOf.find(v=>v.properties.action.const==='dashboard_snapshot');
  assert.deepEqual(schema.required,['action','projectId']);assert.equal(schema.additionalProperties,false);
  assert.deepEqual(Object.keys(schema.properties),['action','projectId']);
  const dir=path.join(g.f.dataDir,'research/projects',g.p.projectId,'core');
  await fs.mkdir(dir,{recursive:true});
  const old=path.join(dir,'control-legacy.json');
  const oldRecord={operationId:'control-legacy',operation:'fact_list_page',revision:13,projectId:g.p.projectId,author:g.p.status.main.agentId,
    role:'main',phase:'finished',pending:false,taskStatus:'failed',outcome:{state:'failed'},cleanup:{confirmed:true},settlement:{confirmed:true}};
  await fs.writeFile(old,JSON.stringify(oldRecord));const oldBytes=await fs.readFile(old);await g.restart();
  const lower=Date.now(), reply=await g.request();assert.equal(reply.isError,false,JSON.stringify(reply.details));
  assert.equal(g.f.calls.tasks.length-g.startTasks,1);assert.equal(g.calls.length,1);assert.equal(g.stages.length,1);
  const [{body,bytes,input}]=g.stages;
  assert.deepEqual(body,{schemaVersion:1,kind:'hana-math.factgraph-snapshot',projectId:g.p.projectId,asOf:serial(1),capturedAt:body.capturedAt,graph:graphFor(g.p.projectId)});
  assert.ok(Number.isSafeInteger(body.capturedAt)&&body.capturedAt>=lower&&body.capturedAt<=Date.now());
  assert.equal(input.name,'factgraph.hanamathgraph');assert.equal(input.mime,'application/vnd.hana-math.factgraph+json');assert.equal(input.deliverAs,'attachment');
  assert.ok(bytes.length<=MIB);assert.equal((await fs.stat(input.path)).mode&0o777,0o600);
  const expected={projectId:body.projectId,asOf:body.asOf,capturedAt:body.capturedAt,nodeCount:2,edgeCount:1,sha256:sha(bytes),bytes:bytes.length,
    resource:{kind:'session-file',sessionId:'creator-stable',fileId:'graph-1'}};
  assert.deepEqual(reply.details,expected);assert.deepEqual(JSON.parse(reply.content[0].text),expected);
  assert.doesNotMatch(JSON.stringify(reply),/PRIVATE|Synthetic statement|proof|\/research\//);
  const id=g.calls[0].binding.runId, record=path.join(g.f.dataDir,'research/projects',body.projectId,'core',id+'.json');
  const saved=await fs.readFile(record);await g.restart();
  const s=await g.f.service.status(g.p.projectId,origin);
  assert.ok(s.coreOperations.some(x=>x.operationId===id&&x.operation==='dashboard_factgraph'&&x.outcome==='succeeded'&&!x.pending));
  assert.ok(s.coreOperations.some(x=>x.operationId===oldRecord.operationId&&x.outcome==='failed'&&!x.pending));
  assert.equal(s.coreUnsettled,false);assert.deepEqual(await fs.readFile(record),saved);assert.deepEqual(await fs.readFile(old),oldBytes);
  assert.equal(g.calls.length,1);assert.equal(g.stages.length,1);
});

test('dashboard snapshot rejects foreign project, bound roles and malformed selectors before a Core task', async t=>{
  const g=await setup(t), other=await g.f.create(), file=path.join(g.f.dataDir,'research/projects',other.projectId,'project.json');
  // Finish the first service's queued setup writes before seeding the foreign
  // fixture. Otherwise disposal can persist the old creator over this edit.
  await g.f.service.dispose();
  const meta=JSON.parse(await fs.readFile(file,'utf8'));
  meta.creator={sessionId:'creator-other',sessionPath:'/fixture/another-origin.jsonl'};
  await fs.writeFile(file,JSON.stringify(meta));await g.f.open();
  const foreign={...origin,sessionPath:meta.creator.sessionPath};
  assert.equal((await g.f.service.status(other.projectId,foreign)).state,'ready');
  const start=g.f.calls.tasks.length;
  for(const [patch,context,code] of [
    [{path:'/untrusted'},origin,'RESEARCH_TOOL_INVALID_INPUT'],[{factId:A},origin,'RESEARCH_TOOL_INVALID_INPUT'],
    [{projectId:undefined},origin,'RESEARCH_TOOL_INVALID_INPUT'],[{action:'dashboard_factgraph'},origin,'RESEARCH_TOOL_INVALID_INPUT'],
    [{projectId:other.projectId},origin,'PROJECT_OWNER_DENIED'],[{},g.p.context,'PROJECT_OWNER_DENIED'],
    [{},{...origin,sessionPath:'/fixture/worker.jsonl'},'PROJECT_OWNER_DENIED'],
    [{},{...origin,sessionPath:'/fixture/verifier.jsonl'},'PROJECT_OWNER_DENIED'],
  ]) await t.test(`${patch.projectId===other.projectId?'other project':context===g.p.context?'bound Main':context===origin?Object.keys(patch).join(','):context.sessionPath}`,async()=>{
    checkError(await g.request(patch,context),code);
  });
  assert.equal(g.f.calls.tasks.length,start);assert.equal(g.calls.length,0);assert.equal(g.stages.length,0);await absent(g.exports);
});

test('concurrent dashboard requests queue, and no staging before the matching task settles', async t=>{
  const g=await setup(t), entered=defer(), release=defer(), complete=g.f.sdk.tasks.complete;
  g.f.sdk.tasks.complete=async(id,body)=>{if(g.calls.length===1&&id===g.calls[0].taskId){entered.resolve();await release.promise;}return complete(id,body);};
  const pending=[g.request()];
  try{
    await entered.promise;pending.push(g.request());await turn();await turn();
    assert.equal(g.calls.length,1);assert.equal(g.stages.length,0);assert.equal(g.f.calls.tasks.length-g.startTasks,1);
  }finally{release.resolve();await Promise.allSettled(pending);}
  const replies=await Promise.all(pending);
  assert.ok(replies.every(r=>r.isError===false));assert.equal(g.calls.length,2);assert.equal(g.stages.length,2);
  assert.equal(new Set(g.calls.map(x=>x.binding.runId)).size,2);assert.equal(g.f.calls.tasks.length-g.startTasks,2);
  assert.deepEqual(replies.map(x=>x.details.asOf),[serial(1),serial(2)]);
});

test('creator checked again after export write, before stage', async t=>{
  const g=await setup(t), ctx={...origin}, open=fs.open;let hit=0;
  const hook=t.mock.method(fs,'open',async (filename,...args)=>{
    const v=await open(filename,...args);
    if(typeof filename==='string'&&filename.startsWith(g.exports+path.sep)&&filename.endsWith('.hanamathgraph')){hit++;ctx.callToken='torn-fixture-token';}
    return v;
  });syncBuiltinESMExports();
  try{checkError(await g.request({},ctx),'PROJECT_DASHBOARD_SNAPSHOT_CHANGED');}
  finally{hook.mock.restore();syncBuiltinESMExports();}
  assert.ok(hit>=1);assert.equal(g.calls.length,1);assert.equal(g.stages.length,0);
});

test('complete snapshot UTF-8 budget rejects oversized document before creating export', async t=>{
  const g=await setup(t);
  g.controls.result=result=>{const n=MIB-Buffer.byteLength(JSON.stringify(result));result.graph.nodes[0].proof+='x'.repeat(n);assert.equal(Buffer.byteLength(JSON.stringify(result)),MIB);return result;};
  checkError(await g.request(),'PROJECT_DASHBOARD_SNAPSHOT_TOO_LARGE');
  assert.equal(g.calls.length,1);assert.equal(g.stages.length,0);await absent(g.exports);
});

test('dashboard distinguishes local export failure from Host stage failure and invalid owner', async t=>{
  const g=await setup(t), open=fs.open;let writeFailure=0;
  const hook=t.mock.method(fs,'open',async (filename,...args)=>{
    if(typeof filename==='string'&&filename.startsWith(g.exports+path.sep)&&filename.endsWith('.hanamathgraph')){writeFailure++;throw Object.assign(new Error('PRIVATE path'),{code:'EIO'});}
    return open(filename,...args);
  });syncBuiltinESMExports();
  try{checkError(await g.request(),'PROJECT_DASHBOARD_SNAPSHOT_EXPORT_FAILED');}
  finally{hook.mock.restore();syncBuiltinESMExports();}
  assert.equal(writeFailure,1);assert.equal(g.calls.length,1);assert.equal(g.stages.length,0);
  g.controls.stageError=true;checkError(await g.request(),'PROJECT_DASHBOARD_SNAPSHOT_STAGE_FAILED');
  g.controls.stageError=false;g.controls.wrongOwner=true;checkError(await g.request(),'PROJECT_DASHBOARD_SNAPSHOT_STAGE_INVALID');
  assert.equal(g.calls.length,3);assert.equal(g.stages.length,2);assert.equal(g.f.calls.tasks.length-g.startTasks,3);
});
