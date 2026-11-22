// Real registered tool + Project queue + managed Runtime + real Python, with a
// synthetic Host/creator receipt and two temporary projects. No models or Host calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createResearchRuntime } from '../packages/hana-math/runtime/research-runtime.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { fixture, origin } from './helpers/project-service-fixture.mjs';

const run = promisify(execFile), repo = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.HANA_TEST_DASHBOARD_PYTHON ?? 'python3.12';
const upstream = process.env.HANA_TEST_DANUS_REPO ?? '';
const kinds = ['conclusion','example','counterexample','proof_attempt','plan','direction','obstacle','dead_end','verification','elaboration','master_guidance'];
const before = ['action','projectId'];
const fail = () => assert.fail('unexpected model, resource staging or research operation');
const seed = String.raw`import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from danus.core.factgraph import FactGraph
from danus.core.global_memory import GlobalMemory
base = Path(sys.argv[3]) / 'context/projects'
a, b = sys.argv[4:6]
root_a, root_b = (base / p / 'shared' for p in (a, b))
ga, gb = (FactGraph(root) for root in (root_a, root_b))
ma, mb = (GlobalMemory(root) for root in (root_a, root_b))
f = ga.add(problem_id=a, author='作者甲', statement='SECRET-STMT-A', proof='SECRET-PROOF-A')
ga.add(problem_id=a, author='作者乙', statement='另一条', proof='不可输出', predecessors=[f])
ma.append('plan', 'SECRET-CLAIM-A', 'SECRET-EVIDENCE-A', '作者甲')
ma.append('plan', '两项相同频道', '', '作者乙')
for verdict in ('correct', 'correct', 'wrong', 'error'):
    ma.append('verification', '验证条目', '不可输出', '作者乙', verdict=verdict)
gb.add(problem_id=b, author='作者丙', statement='SECRET-STMT-B', proof='SECRET-PROOF-B')
mb.append('direction', 'SECRET-CLAIM-B', 'SECRET-EVIDENCE-B', '作者丙')
private = root_a.parent / 'workers/worker-1/local_memory/notes.jsonl'
private.parent.mkdir(parents=True, exist_ok=True)
private.write_text('PRIVATE-MEMORY-ONLY', encoding='utf-8')
if sys.argv[6]:
    sys.path.insert(0, sys.argv[2]); from test_dashboard_memory import oracle
    build = oracle(Path(sys.argv[6]))['build_overview']
    rows = [build(root) for root in (root_a, root_b)]
    for row, project in zip(rows, (a, b)):
        assert row.pop('project') == 'shared'; row.pop('updated_at'); row['project'] = project
    print(json.dumps(rows))
else:
    print('null')`;

function checkError(reply, code) {
  assert.equal(reply.isError, true); assert.equal(reply.details.error.code, code);
  assert.doesNotMatch(JSON.stringify(reply), /SECRET-|PRIVATE-MEMORY-ONLY|creator-stable/);
}
const tally = (changes) => Object.fromEntries(kinds.map(k => [k,changes[k] ?? 0]));

async function setup(t) {
  let f, tool;
  const commands = [], packets = [], disposals = [], runtime = new Map();
  let packageRoot;
  f = await fixture(t,{ createCore({taskId}){
    const bridge = createResearchRuntime(f.sdk,{taskId,packageRoot,platform:'darwin',arch:'arm64'});
    return {call:(...args)=>bridge.call(...args), async dispose(){await bridge.dispose();disposals.push(taskId);}};
  }});
  const a = await f.create(), b = await f.create();
  const pathname = path.join(f.dataDir,'research','projects',b.projectId,'project.json');
  await f.service.dispose();
  const record = JSON.parse(await fs.readFile(pathname));
  const other = {...origin, sessionPath:'/fixture/other-creator.jsonl'};
  record.creator = {sessionId:'other-creator-stable',sessionPath:other.sessionPath};
  await fs.writeFile(pathname,JSON.stringify(record));
  f.host.set(other.sessionPath,{...f.host.get(origin.sessionPath),...record.creator,path:other.sessionPath});
  await f.open();
  // Runtime requires disjoint package/DataDir roots.
  packageRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'overview-package-')));
  t.after(() => fs.rm(packageRoot,{recursive:true,force:true}));
  await fs.cp(path.join(repo,'engine/src'),path.join(packageRoot,'engine/src'),{recursive:true,filter:p=>!p.includes('__pycache__')});
  await fs.mkdir(path.join(packageRoot,'dependencies/python/bin'),{recursive:true});
  await fs.writeFile(path.join(packageRoot,'dependencies/python/bin/python3'),'fixture runtime receipt',{mode:0o700});
  await fs.writeFile(path.join(packageRoot,'dependencies/runtime.json'),JSON.stringify({schemaVersion:1, platform:'darwin',arch:'arm64',pythonVersion:'3.12.14',executable:'dependencies/python/bin/python3'}));
  await fs.mkdir(path.join(packageRoot,'runtime'));
  await fs.copyFile(path.join(repo,'packages/hana-math/runtime/research_entry.py'),path.join(packageRoot,'runtime/research_entry.py'));
  const out = await run(python,['-I','-S','-B','-c',seed,path.join(packageRoot,'engine/src'),path.join(repo,'engine/tests'),f.dataDir,a.projectId,b.projectId,upstream],{timeout:10000});
  const expected = JSON.parse(out.stdout);
  f.sdk.runtime = {
    async start(cmd) {
      const id = `runtime-${commands.length+1}`;
      assert.equal(cmd.profile,'scoped');assert.equal(cmd.network,'none');
      const wire = JSON.parse(await fs.readFile(cmd.args[4]));
      assert.equal(wire.operation,'dashboard_memory');assert.deepEqual(wire.arguments,{view:'overview'});
      assert.equal(wire.context.role,'main');assert.match(wire.context.runId,/^control-/);
      assert.equal(f.tasks.get(cmd.taskId).metadata.controlId,wire.context.runId);
      commands.push({cmd,wire});
      await run(python,cmd.args,{cwd:cmd.cwd,timeout:10000});
      packets.push(JSON.parse(await fs.readFile(cmd.args[5])));
      const result={runtimeId:id,state:'exited',exitCode:0,signal:null,runtime:'command',profile:'scoped',network:'none'};
      runtime.set(id,result);return result;
    }, get:async id=>runtime.get(id), stop:async id=>runtime.get(id), watch:fail,
  };
  f.sdk.sessions.send=fail; f.sdk.models.listAvailable=fail;
  const registration = await registerMathResearch({...f.sdk,resources:{stage:fail},tools:{async register(def){if(def.name==='math_project')tool=def;return()=>{};}}},
    Object.fromEntries(['run','status','setupStatus','setToolMode','result','stop','invoke','recordSubmissionInputRejection'].map(k=>[k,fail])), f.service);
  t.after(()=>registration.dispose());
  const request=(projectId,context=origin,extra={})=>tool.execute({action:'dashboard_overview',projectId,...extra,context});
  return {f,a,b,other,tool,request,commands,packets,disposals,expected};
}

test('registered overview observes one authenticated operation per project and emits Danus aggregates only', async t => {
  const g=await setup(t);
  const schema=g.tool.parameters.oneOf.find(v=>v.properties.action.const==='dashboard_overview');
  assert.deepEqual(schema.required,before);assert.deepEqual(Object.keys(schema.properties),before);assert.equal(schema.additionalProperties,false);
  assert.equal(g.tool.parameters.properties.action.enum.filter(a=>a==='dashboard_overview').length,1);
  assert.ok(!g.tool.parameters.properties.action.enum.some(a=>['dashboard_memory','dashboard_channel','dashboard_channels'].includes(a)));
  const initialSends=g.f.calls.sends.length; // The fixture sent setup messages before registering the read tool.
  const expectations=[{project:g.a.projectId,facts:2,facts_with_predecessors:1,facts_by_author:{作者甲:1,作者乙:1},channel_counts:tally({plan:2,verification:4}),verdicts:{correct:2,wrong:1,error:1}},
    {project:g.b.projectId,facts:1,facts_with_predecessors:0,facts_by_author:{作者丙:1},channel_counts:tally({direction:1}),verdicts:{}}];
  if(upstream) assert.deepEqual(g.expected,expectations);
  for(const [i,p,context] of [[0,g.a,origin],[1,g.b,g.other]]) {
    const start = g.f.calls.tasks.length, subscriptions=g.f.calls.lists.length, lower=Date.now()/1000;
    const reply=await g.request(p.projectId,context);
    assert.equal(reply.isError,false,JSON.stringify(reply.details));
    assert.equal(g.f.calls.tasks.length-start,1);assert.equal(g.f.calls.lists.length-subscriptions,2);
    assert.equal(g.commands.length,i+1);assert.equal(g.disposals.length,i+1);
    const call=g.commands.at(-1);assert.equal(call.wire.context.projectId,p.projectId);
    const {updated_at,...fields}=reply.details;assert.deepEqual(fields,expectations[i]);
    assert.ok(updated_at>=lower && updated_at<=Date.now()/1000);
    assert.deepEqual(reply.details,g.packets.at(-1).result.data);
    assert.deepEqual(JSON.parse(reply.content[0].text),reply.details);
    assert.doesNotMatch(JSON.stringify(reply),/SECRET-|PRIVATE-MEMORY-ONLY|"claim"|"evidence"|"proof"|session-file/);
    const row=JSON.parse(await fs.readFile(path.join(g.f.dataDir,'research/projects',p.projectId,'core',call.wire.context.runId+'.json')));
    assert.partialDeepStrictEqual(row,{operation:'dashboard_memory',phase:'finished',pending:false,taskStatus:'completed',settlement:{confirmed:true},cleanup:{confirmed:true},outcome:{state:'succeeded'}});
    assert.deepEqual(row.outcome,{state:'succeeded'});assert.equal(g.f.tasks.get(call.cmd.taskId).status,'completed');
  }
  await assert.rejects(fs.stat(path.join(g.f.dataDir,'research/project-exports')),{code:'ENOENT'});
  assert.equal(g.f.calls.sends.length,initialSends);
});

test('Overview rejects ordinary roles, foreign project, surplus selectors and lost queue authorization before task creation', async t => {
  const g=await setup(t), start=g.f.calls.tasks.length;
  for(const [p,ctx,extra,code] of [
    [g.b.projectId,origin,{},'PROJECT_OWNER_DENIED'],[g.a.projectId,g.other,{},'PROJECT_OWNER_DENIED'],
    [g.a.projectId,g.a.context,{},'PROJECT_OWNER_DENIED'],[g.a.projectId,{...origin,sessionPath:'/fixture/worker.jsonl'},{},'PROJECT_OWNER_DENIED'],
    [g.a.projectId,{...origin,sessionPath:'/fixture/verifier.jsonl'},{},'PROJECT_OWNER_DENIED'],
    ...Object.entries({route:'/api/overview',view:'channel',kind:'verification',owner:'creator-stable',factId:'a'.repeat(16),action:'dashboard_memory',projectId:undefined})
      .map(([k,v])=>[g.a.projectId,origin,{[k]:v},'RESEARCH_TOOL_INVALID_INPUT'])]) {
    checkError(await g.request(p,ctx,extra),code);
  }
  for(const selection of [{view:'channel',kind:'_status'},{view:'channels',kind:'plan'},{view:'overview',owner:'creator-stable'}]) {
    await assert.rejects(g.f.service.readDashboard({projectId:g.a.projectId,...selection},origin),{code:'PROJECT_INVALID_INPUT'});
  }
  await assert.rejects(g.f.service.readDashboard({projectId:g.a.projectId,view:'channel',kind:'plan'},g.other),{code:'PROJECT_OWNER_DENIED'});
  let checked=0;
  const list=g.f.sdk.sessions.list;
  g.f.sdk.sessions.list=async input=>{
    const rows=await list(input);
    if(++checked===2)rows.sessions.push({sessionId:'creator-stable',path:origin.sessionPath,ownerPluginId:'hana-math',lifecycle:'active',visibility:'public'});
    return rows;
  };
  checkError(await g.request(g.a.projectId),'PROJECT_OWNER_DENIED');
  assert.equal(checked,2);assert.equal(g.f.calls.tasks.length,start);assert.equal(g.commands.length,0);
});
