// Composed software check: real packaged Python facade (research_entry.py) ->
// real Runtime -> registered tool. Opaque oversized fixture file; no model,
// live Host or mathematical content.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createResearchRuntime, projectDashboardFactgraphOptions, projectDashboardMemoryOptions } from '../packages/hana-math/runtime/research-runtime.mjs';
import { createProjectCoreAccess } from '../packages/hana-math/project-core-access.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = promisify(execFile);
const python = process.env.HANA_TEST_DASHBOARD_PYTHON ?? 'python3.12';
const MAX_JSON = 1 << 20;
const binding = { projectId: 'project-python-refusal', runId: 'run-python-refusal', role: 'main', author: 'fixture' };

async function packaged(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'python-refusal-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const packageRoot = path.join(base, 'package'), dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.cp(path.join(repo, 'engine/src'), path.join(packageRoot, 'engine/src'), {
    recursive: true, filter: (source) => !source.includes('__pycache__') && !source.endsWith('.pyc') });
  await fs.mkdir(path.join(packageRoot, 'runtime'), { recursive: true });
  await fs.copyFile(path.join(repo, 'packages/hana-math/runtime/research_entry.py'), path.join(packageRoot, 'runtime/research_entry.py'));
  // Install-receipt placeholder only; the fixture SDK runs python3.12 itself.
  await fs.mkdir(path.join(packageRoot, 'dependencies/python/bin'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'dependencies/python/bin/python3'), 'software runtime placeholder', { mode: 0o700 });
  await fs.writeFile(path.join(packageRoot, 'dependencies/runtime.json'), JSON.stringify({ schemaVersion: 1,
    platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' }));
  const envelopes = [], states = new Map();
  const sdk = { dataDir, runtime: {
    async start(input) {
      await run(python, input.args, { cwd: input.cwd, timeout: 20000, maxBuffer: 2 << 20 });
      envelopes.push(JSON.parse(await fs.readFile(input.args[5], 'utf8')));
      const info = { runtimeId: envelopes.length.toString().padStart(8, '0'), state: 'exited', exitCode: 0, signal: null, runtime: 'command', profile: 'scoped', network: 'none' };
      states.set(info.runtimeId, info); return { ...info };
    },
    async get(id) { return { ...states.get(id) }; },
    async watch() { throw new Error('exited fixture must not watch'); },
    async stop(id) { return { ...states.get(id) }; },
  } };
  const bridge = createResearchRuntime(sdk, { packageRoot, platform: 'darwin', arch: 'arm64', timeoutMs: 20000, cleanupTimeoutMs: 3000 });
  t.after(() => bridge.dispose());
  return { base, dataDir, packageRoot, sdk, bridge, envelopes };
}

test('real Python capacity refusal reaches the registered tool as a checked rejection', async t => {
  const f = await packaged(t);
  const shared = path.join(f.dataDir, 'context/projects', binding.projectId, 'shared');
  await fs.mkdir(path.join(shared, 'global_memory'), { recursive: true });
  await fs.writeFile(path.join(shared, 'global_memory/verification.jsonl'), 'x'.repeat(MAX_JSON + 10));
  const tools = new Map(), unused = async () => { throw new Error('unused fixture business operation'); };
  const service = Object.fromEntries(['run', 'status', 'stop', 'setupStatus', 'setToolMode', 'invoke', 'recordSubmissionInputRejection'].map(k => [k, unused]));
  service.result = async (runId, factId, ctx, options) => {
    assert.equal(factId, undefined); assert.deepEqual(options, {});
    return f.bridge.call(binding, 'fact_list_page', options);
  };
  const registration = await registerMathResearch({ dataDir: f.dataDir, tools: { register: async tool => { tools.set(tool.name, tool); return () => {}; } } }, service);
  t.after(() => registration.dispose());
  const reply = await tools.get('math_research').execute({ action: 'result', runId: binding.runId,
    context: { sessionPath: '/fixture/creator.jsonl', callToken: 'opaque-fixture' } });

  // The facade itself emitted a separate top-level diagnostic; error shape unchanged.
  assert.equal(f.envelopes.length, 1);
  const [envelope] = f.envelopes;
  assert.equal(envelope.ok, false); assert.deepEqual(Object.keys(envelope.error).sort(), ['code', 'message']);
  assert.equal(envelope.error.code, 'size_limit');
  assert.deepEqual(envelope.diagnostic, { version: 1, reason: 'shared-verification-bytes', observed: MAX_JSON + 1,
    observedLowerBound: true, limit: MAX_JSON, reserve: 0 });

  assert.equal(reply.isError, true);
  const error = reply.details.error;
  assert.equal(error.code, 'RESEARCH_RUNTIME_REJECTED');
  assert.deepEqual(error.rejection, { version: 1, origin: 'checked-facade-result', observation: 'at-refusal',
    reason: 'shared-verification-bytes', resource: 'verification-trace', unit: 'bytes', observed: MAX_JSON + 1,
    observedLowerBound: true, limit: MAX_JSON, reserve: 0, suggestedAction: 'report-capacity' });
  assert.match(error.message, /exceeded a capacity check/);
  assert.doesNotMatch(error.message, /may already have taken effect/);
  assert.equal(error.runtime.indeterminate, false); assert.equal(error.runtime.cleanup.confirmed, true);
  const text = JSON.stringify(reply);
  for (const leak of [f.base, 'verification.jsonl', 'file exceeds']) assert.ok(!text.includes(leak), leak);
});

test('internal dashboard graph uses one task-bound legacy managed command with real Python', async t => {
  const f = await packaged(t);
  const seed = `import sys, json
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from danus.core.factgraph import FactGraph
project = sys.argv[3]
g = FactGraph(Path(sys.argv[2]) / 'context/projects' / project / 'shared')
a = g.add(problem_id=project, author='fixture', statement=r'$x^2 \\ge 0$', proof='平方非负。')
b = g.add(problem_id=project, author='fixture', statement='推论', proof='由上式。', predecessors=[a])
print(json.dumps([a,b]))`;
  const {stdout} = await run(python, ['-I','-S','-B','-c',seed,path.join(f.packageRoot,'engine/src'),f.dataDir,binding.projectId], {timeout:5000});
  const [a,b] = JSON.parse(stdout), states = [], commands = [];
  let task;
  f.sdk.tasks = {
    async create(input) { assert.equal(task, undefined); assert.equal(input.scope, 'app'); assert.equal(input.delivery,'none');
      task={pluginId:'hana-math',taskId:'app:hana-math:dashboard-fixture',scope:'app',delivery:'none',parentSessionId:null,parentSessionPath:null,
        status:'pending',metadata:input.metadata};return structuredClone(task); },
    async get(id) { assert.equal(id,task.taskId); return structuredClone(task); },
    async complete(id) { assert.equal(id,task.taskId); task.status='completed'; return structuredClone(task); },
    async fail() { assert.fail('No task failure expected'); },
  };
  const start=f.sdk.runtime.start;
  f.sdk.runtime.start=async input=>{commands.push(input);return start(input);};
  const access=createProjectCoreAccess(f.sdk,{projectId:binding.projectId,author:binding.author,
    createCore:({taskId})=>createResearchRuntime(f.sdk,{taskId,packageRoot:f.packageRoot}),
    onState:record=>{states.push(record);}});
  t.after(()=>access.dispose());
  await assert.rejects(access.call('dashboard_factgraph',{}),{code:'PROJECT_CORE_FORBIDDEN_OPERATION'});
  await assert.rejects(access.callReadScratch('dashboard_factgraph',{}),{code:'PROJECT_CORE_FORBIDDEN_OPERATION'});
  await assert.rejects(access.dashboardFactgraph({projectId:'project-other'}),{code:'PROJECT_CORE_INVALID_INPUT'});
  const guard=createResearchRuntime(f.sdk,{taskId:'app:hana-math:rejected-test',packageRoot:f.packageRoot});
  const context={...binding,runId:'control-00000000-0000-4000-8000-000000000000'};
  try {
    await assert.rejects(guard.call(context,'dashboard_factgraph',{},undefined,{...projectDashboardFactgraphOptions()}),{code:'RESEARCH_RUNTIME_INVALID_REQUEST'});
    await assert.rejects(guard.call({...context,role:'worker'},'dashboard_factgraph',{},undefined,projectDashboardFactgraphOptions()),{code:'RESEARCH_RUNTIME_INVALID_REQUEST'});
  } finally { await guard.dispose(); }
  assert.equal(task,undefined);assert.equal(commands.length,0);
  const result=await access.dashboardFactgraph({});
  assert.deepEqual(Object.keys(result).sort(),['asOf','graph','projectId']);
  assert.equal(result.projectId,binding.projectId);
  assert.match(result.asOf,/^[a-f0-9]{64}$/);
  assert.deepEqual(result.graph.edges,[{source:a,target:b}]);
  assert.deepEqual(result.graph.nodes.map(x=>x.id),[a,b].sort());
  assert.equal(result.graph.nodes.find(x=>x.id===b).proof,'由上式。');
  assert.equal(result.graph.max_depth,1);
  assert.equal(commands.length,1);assert.equal(f.envelopes.length,1);
  assert.deepEqual(result,f.envelopes[0].result);
  const command=commands[0];assert.equal(command.taskId,task.taskId);assert.equal(command.network,'none');assert.equal(command.profile,'scoped');
  assert.deepEqual(command.args.slice(0,4),['-I','-S','-B',path.join(f.packageRoot,'runtime/research_entry.py')]);
  assert.deepEqual((await fs.readdir(command.cwd)).sort(),['.complete','request.json','result.json']);
  const wire=JSON.parse(await fs.readFile(command.args[4],'utf8'));assert.equal(wire.operation,'dashboard_factgraph');assert.deepEqual(wire.arguments,{});
  assert.equal(states.at(-1).phase,'finished');assert.equal(states.at(-1).cleanup.confirmed,true);assert.equal(states.at(-1).settlement.confirmed,true);
  assert.equal(task.status,'completed');
});

test('internal dashboard memory stays task-bound and keeps shared prose out of operation state', async t => {
  const f = await packaged(t);
  const seed = `import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from danus.core.global_memory import GlobalMemory
base = Path(sys.argv[2]) / 'context/projects'
for project, text in ((sys.argv[3], '共享证明'), ('project-other', 'OTHER-PROJECT')):
    GlobalMemory(base / project / 'shared').append('verification', text, '非 ASCII', 'fixture', verdict='correct')`;
  await run(python, ['-I','-S','-B','-c',seed,path.join(f.packageRoot,'engine/src'),f.dataDir,binding.projectId], {timeout:5000});
  const commands = [], states = [];
  let task;
  f.sdk.tasks = {
    async create(input) { assert.equal(task, undefined); assert.equal(input.scope,'app'); assert.equal(input.delivery,'none');
      task={pluginId:'hana-math',taskId:'app:hana-math:dashboard-memory-fixture',scope:'app',delivery:'none',parentSessionId:null,
        parentSessionPath:null,status:'pending',metadata:input.metadata}; return structuredClone(task); },
    async get(id) { assert.equal(id,task.taskId); return structuredClone(task); },
    async complete(id) { assert.equal(id,task.taskId); task.status='completed'; return structuredClone(task); },
    async fail() { assert.fail('unexpected task failure'); },
  };
  const start=f.sdk.runtime.start;
  f.sdk.runtime.start=async input=>{commands.push(input);return start(input);};
  const access=createProjectCoreAccess(f.sdk,{projectId:binding.projectId,author:binding.author,
    createCore:({taskId})=>createResearchRuntime(f.sdk,{taskId,packageRoot:f.packageRoot}), onState:record=>{states.push(record);}});
  t.after(()=>access.dispose());
  const args = {view:'channel',kind:'verification'};
  for (const method of ['call','callReadScratch']) await assert.rejects(access[method]('dashboard_memory',args),{code:'PROJECT_CORE_FORBIDDEN_OPERATION'});
  for (const selection of [{...args,projectId:'project-other'},{...args,kind:'_status'},{view:'channels',kind:'verification'}]) {
    await assert.rejects(access.dashboardMemory(selection),{code:'PROJECT_CORE_INVALID_INPUT'});
  }
  const context={...binding,runId:'control-00000000-0000-4000-8000-000000000000'};
  const guard=createResearchRuntime(f.sdk,{taskId:'app:hana-math:memory-check',packageRoot:f.packageRoot});
  try {
    for (const options of [{...projectDashboardMemoryOptions()},projectDashboardFactgraphOptions()]) {
      await assert.rejects(guard.call(context,'dashboard_memory',args,undefined,options),{code:'RESEARCH_RUNTIME_INVALID_REQUEST'});
    }
    await assert.rejects(guard.call(context,'dashboard_factgraph',{},undefined,projectDashboardMemoryOptions()),{code:'RESEARCH_RUNTIME_INVALID_REQUEST'});
    await assert.rejects(guard.call({...context,role:'worker'},'dashboard_memory',args,undefined,projectDashboardMemoryOptions()),{code:'RESEARCH_RUNTIME_INVALID_REQUEST'});
    await assert.rejects(f.bridge.call(context,'dashboard_memory',args,undefined,projectDashboardMemoryOptions()),{code:'RESEARCH_RUNTIME_INVALID_REQUEST'});
  } finally { await guard.dispose(); }
  assert.equal(task,undefined);assert.equal(commands.length,0);
  const result=await access.dashboardMemory(args);
  assert.equal(result.projectId,binding.projectId);
  assert.equal(result.data.kind,'verification');assert.equal(result.data.count,1);
  assert.equal(result.data.entries[0].claim,'共享证明');assert.equal(result.data.entries[0].evidence,'非 ASCII');
  assert.deepEqual(f.envelopes.map(x=>x.result),[result]);
  assert.equal(commands.length,1);assert.equal(commands[0].taskId,task.taskId);
  assert.equal(commands[0].network,'none');assert.equal(commands[0].profile,'scoped');
  assert.equal(task.status,'completed');assert.equal(states.at(-1).phase,'finished');
  assert.deepEqual(states.at(-1).outcome,{state:'succeeded'});
  assert.equal(states.at(-1).cleanup.confirmed,true);assert.equal(states.at(-1).settlement.confirmed,true);
  assert.doesNotMatch(JSON.stringify(states),/共享证明|OTHER-PROJECT/);
});
