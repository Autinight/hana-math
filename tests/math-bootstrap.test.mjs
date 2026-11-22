import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import entry from '../packages/hana-math/index.js';
import { createMathBootstrap } from '../packages/hana-math/bootstrap.mjs';
import { createMainControlService } from '../packages/hana-math/main-control-service.mjs';

const deferred = () => Promise.withResolvers();
const forbidden = () => assert.fail('Unexpected business invocation');
const receipt = () => Object.assign(() => {}, { ready: Promise.resolve() });
const methods = ['math-research-once', 'math-project-report', 'math-project-setup', 'math-project-main-control'];
const errors = { pending:'MATH_BOOTSTRAP_PENDING', unavailable:'MATH_BOOTSTRAP_UNAVAILABLE' };
const zeroProgress = { reconciledRuns:0, listQueries:0, getQueries:0, deliveryQueries:0,
  historicalSessionAbortAttempts:0, elapsedMs:0 };
function toolReply(details, isError = true) {
  return { content:[{type:'text',text:JSON.stringify(details)}], details, ...(isError && {isError:true}) };
}
function readReceipt(value, progress) {
  const { elapsedMs } = value ?? {};
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0, 'recovery elapsedMs is finite and nonnegative');
  assert.deepEqual(value, { ...progress, elapsedMs });
  assert.ok(Object.isFrozen(value));
  return value;
}
async function until(read) {
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline) { const value = await read(); if (value) return value; await delay(3); }
  assert.fail('Fixture observation did not settle');
}
async function applyFixture(t, { breakProbe=false, failRegistration=false, callbackDuringRegistration=false } = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'math-bootstrap-fixture-')));
  const hold = deferred(), entered = deferred();
  t.after(async () => { hold.resolve(); await fs.rm(dataDir,{recursive:true,force:true}); });
  const runId = 'run-fixture', runDir = path.join(dataDir,'research/runs',runId), taskId = 'opaque-fixture-task';
  const task = { taskId, pluginId:'hana-math', scope:'session', delivery:'next-step', status:'completed',
    parentSessionId:'opaque-fixture-parent', parentSessionPath:'/fixture/private-parent.jsonl', metadata:{researchRunId:runId} };
  const delivery = { state:'published', delivered:false };
  await fs.mkdir(runDir,{recursive:true});
  const record = JSON.stringify({ schemaVersion:1,runId,state:'finished',finalizing:false,cleanupPending:false,indeterminate:false,
    cleanupErrors:[],sessions:[],submissions:[],verifiedFactIds:[],pendingMutations:[],coreTaskId:null,coreTaskCreatePending:false,
    coreTaskSettlementPending:false,runtimeCleanupPending:false,runtimeCleanupError:null,taskId,delivery });
  const file = path.join(runDir,'run.json'); await fs.writeFile(file,record);
  if (breakProbe) await fs.writeFile(path.join(dataDir,'context'), 'not a trusted directory');
  const tools = new Map(), handlers = new Map(), routes = new Map(), calls = [], registrationRefusals = [];
  let registrationStatus;
  let registrars = 0;
  const ctx = { dataDir, models:{}, media:{}, providers:{}, hooks:{}, resources:{}, runtime:{start:forbidden},
    storage:{global:{}, agent:forbidden}, logger:{warn:forbidden,info:forbidden,error(_message,value){calls.push(['bootstrap-error',value]);}},
    launchArgs:{async get() { return false; }}, documents:{read:forbidden,requestView:forbidden},
    tasks:{ create:forbidden, schedule:forbidden, unschedule:forbidden, fail:forbidden, complete:forbidden,
      async get(id){assert.equal(id,taskId); calls.push('get'); return task;},
      async getDelivery(id){assert.equal(id,taskId); calls.push('getDelivery'); return delivery;},
      async registerHandler(key,handler){
        assert.ok(!handlers.has(key)); handlers.set(key,handler);
        if (callbackDuringRegistration) {
          await assert.rejects(handler.run({kind:'schedule'}),{code:errors.pending}); registrationRefusals.push([key,'run']);
          if (handler.abort) { await assert.rejects(handler.abort('synthetic-task'),{code:errors.pending}); registrationRefusals.push([key,'abort']); }
        }
        return receipt();
      },
      async listSchedules(){calls.push('listSchedules'); entered.resolve(); await hold.promise; return [];},
      async list(){calls.push('list');return [task];}, },
    bus:{ async request(verb, args) { assert.equal(verb,'session:list'); assert.deepEqual(args,{scope:'own',lifecycle:'all',ownerPluginId:'hana-math'}); calls.push('session:list'); return {sessions:[]}; } },
    tools:{ async register(tool) { assert.ok(!tools.has(tool.name)); tools.set(tool.name,tool);
      if (tool.name === 'math_context') registrationStatus = await tool.execute({action:'status'});
      if (failRegistration && tool.name==='math_goal_main') throw Error('synthetic registry failure'); return receipt(); } },
    routes:{ async register(register) { assert.equal(++registrars,1); register({ get(route,fn){routes.set(route,fn);}, post(route,fn){routes.set(route,fn);} }); return receipt(); } },
  };
  return { ctx, tools, handlers, routes, calls, hold, entered, file, record, registrationRefusals,
    get registrationStatus() { return registrationStatus; },
    catcher: name => tools.get(name).execute({action:'status'}), apply:()=>entry.apply(ctx) };
}
function wakeFixture(tools = {}) {
  const shell = new Map();
  const sdk = { tasks:{async registerHandler(name,handler){shell.set(name,handler);return receipt();}}, logger:{error:forbidden}, tools, routes:{} };
  return { shell, boot:createMathBootstrap(sdk) };
}

test('real apply cannot deadlock on callbacks during registration, and rejects rather than queues through recovery', {timeout:3500}, async t => {
  const f = await applyFixture(t,{callbackDuringRegistration:true});
  await f.apply();
  assert.deepEqual(f.registrationStatus, toolReply({error:{code:errors.pending},
    readiness:{state:'registering',ready:false,...zeroProgress}}));
  assert.deepEqual([...f.handlers.keys()],methods);
  assert.deepEqual(f.registrationRefusals,methods.flatMap((key,i)=>i===3 ? [[key,'run']] : [[key,'run'],[key,'abort']]));
  assert.ok(f.tools.has('math_project')); assert.ok(f.tools.has('math_dashboard_view'));
  await f.entered.promise;
  assert.deepEqual(f.calls,['listSchedules']);
  const event = {kind:'schedule',scheduleId:'fixture-old',input:{runId:'run-fixture',nonce:'stale'}};
  for (const handler of f.handlers.values()) {
    await assert.rejects(handler.run(event),{code:errors.pending});
    if (handler.abort) await assert.rejects(handler.abort('synthetic-task'),{code:errors.pending});
  }
  for (const [name,args] of [['math_context',{action:'prepare',problem:'Synthetic'}],
    ['math_context',{action:'status',projectId:'opaque-extra'}], ['math_research',{action:'status'}],
    ['math_project',{action:'list'}], ['math_goal',{action:'resume'}], ['math_dashboard_view',{action:'bind'}]]) {
    assert.deepEqual(await f.tools.get(name).execute(args), toolReply({error:{code:errors.pending}}));
  }
  const during = await f.catcher('math_context');
  const progress = during.details.readiness;
  // A progress receipt may include the in-flight read but cannot count later calls.
  assert.ok(progress?.listQueries === 0 || progress?.listQueries === 1);
  readReceipt(progress, {state:'preparing',ready:false,...zeroProgress,listQueries:progress.listQueries});
  assert.deepEqual(during, toolReply({error:{code:errors.pending},readiness:progress}));
  const discovery = await f.routes.get('/workspace-monitor/current')({});
  assert.equal(discovery.status,200); assert.equal(discovery.headers.get('cache-control'),'no-store');
  assert.deepEqual(await discovery.json(),{state:'unavailable'});
  const panel = await f.routes.get('/panel')({});
  assert.equal(panel.status,503); assert.equal(panel.headers.get('cache-control'),'no-store');
  assert.deepEqual(await panel.json(),{error:{code:errors.pending}});
  await assert.rejects(f.apply(),{code:'HANA_MATH_DUPLICATE_SETUP'});
  assert.deepEqual(f.calls,['listSchedules']);
  f.hold.resolve();
  const status = await until(async () => {
    const result = await f.catcher('math_context');
    if (!result.isError) return result;
  });
  const readiness = readReceipt(status.details.result.readiness,
    {state:'ready',ready:true,reconciledRuns:1,listQueries:3,getQueries:1,deliveryQueries:1,historicalSessionAbortAttempts:0});
  assert.deepEqual(status, toolReply({ action:'status', result:{
    checkpoint:'CP2B', actions:['status','role_status','core_check','prepare','inspect','probe','probe_status','probe_stop'],
    core:'use_core_check', roleReading:'use_probe_status', modelSource:'saved-role', roleModels:'use_role_status',
    researchScheduling:'use_math_research', researchToolAdapter:'six_role_bound_tools', mcpReplacement:'partial',
    verificationEvidence:'query_actual_run_and_facts', readiness,
  } },false));
  assert.deepEqual(await f.handlers.get('math-research-once').run(event),{status:'ignored'},'the existing owner adjudicates only this fresh callback');
  assert.deepEqual(f.calls,['listSchedules','list','session:list','get','getDelivery']);
  assert.equal(await fs.readFile(f.file,'utf8'),f.record);
  const invalid = await f.tools.get('math_context').execute({action:'status',projectId:'opaque-extra'});
  assert.deepEqual(invalid, toolReply({error:{code:'MATH_CONTEXT_INVALID_INPUT',message:'The action contains unsupported arguments.'}}));
});

test('failed registration never starts history; failed preparation is unavailable, never successful', async t => {
  const failed = await applyFixture(t,{failRegistration:true});
  await assert.rejects(failed.apply(),/synthetic registry failure/); await delay(12);
  assert.deepEqual(failed.calls,[]);
  assert.deepEqual(await failed.catcher('math_context'), toolReply({error:{code:errors.unavailable},
    readiness:{state:'disposed',ready:false,...zeroProgress}}));
  await assert.rejects(failed.handlers.get('math-research-once').run({kind:'schedule'}),{code:errors.unavailable});
  const broken = await applyFixture(t,{breakProbe:true});
  await broken.apply();
  const failedStatus = await until(async () => {
    const result = await broken.catcher('math_context');
    if (result.details.error.code === errors.unavailable) return result;
  });
  assert.deepEqual(failedStatus, toolReply({error:{code:errors.unavailable},
    readiness:{state:'failed',ready:false,...zeroProgress}}));
  await assert.rejects(broken.handlers.get('math-project-setup').run({kind:'schedule'}),{code:errors.unavailable});
  assert.equal(broken.calls.filter(row=>Array.isArray(row)&&row[0]==='bootstrap-error').length,1);
  assert.ok(broken.calls.every(Array.isArray),'probe failure prevents historical research reconciliation');
});

const goalKey = 'math-project-main-control';
const event = Object.freeze({kind:'retry',taskId:'opaque-fixture',input:Object.freeze({})});
async function attach(boot, overrides = {}) {
  for (const key of methods) {
    if (overrides[key] === null) continue;
    await boot.attachHandler(key,overrides[key] ?? {run:forbidden,...(key!==goalKey&&{abort:forbidden})});
  }
}
const ready = boot => until(() => { try { boot.assertReady(); return true; } catch { return false; } });

test('only the App gate decides readiness; polling is read-only even after Research progress completes', async t => {
  const tools = new Map();
  const {boot} = wakeFixture({async register(tool) { tools.set(tool.name,tool); return receipt(); }});
  await boot.registerHandlers();
  await boot.guardedSdk.tools.register({name:'math_context',execute:forbidden});
  const hold = deferred(), activating = deferred();
  t.after(async () => { hold.resolve(); await boot.dispose(); });
  const stats = {reconciledRuns:1,listQueries:3,getQueries:4,deliveryQueries:1,historicalSessionAbortAttempts:2,elapsedMs:3.25};
  const status = args => tools.get('math_context').execute(args);
  const trustedContext = {callToken:'opaque-private',sessionPath:'/fixture/private.jsonl'};
  assert.deepEqual(await status({action:'status',context:trustedContext}), toolReply({error:{code:errors.pending},
    readiness:{state:'registering',ready:false,...zeroProgress}}));
  boot.start(async ({enableGoalAlarms}) => {
    boot.onRecoveryProgress(Object.freeze({...stats,state:'ready',ready:true,runId:'opaque-private',path:'/fixture/private.jsonl'}));
    for (const invalid of [{getQueries:0.5}, {deliveryQueries:-1}, {historicalSessionAbortAttempts:Infinity}, {elapsedMs:NaN}])
      boot.onRecoveryProgress(Object.freeze({...stats,...invalid}));
    await attach(boot);
    enableGoalAlarms(); activating.resolve(); await hold.promise;
  });
  await activating.promise;
  const readiness = {state:'activating-goals',ready:false,...stats};
  assert.deepEqual(await status({action:'status',context:trustedContext}), toolReply({error:{code:errors.pending},readiness}));
  for (const args of [undefined, ['status'], Object.create({action:'status'}),
    {action:'status',projectId:undefined}, {action:'status',[Symbol('extra')]:0}]) {
    assert.deepEqual(await status(args), toolReply({error:{code:errors.pending}}));
  }
  assert.throws(boot.assertReady,{code:errors.pending});
  await boot.dispose(); hold.resolve();
  boot.onRecoveryProgress(Object.freeze({...stats,listQueries:99}));
  assert.deepEqual(await status({action:'status',context:trustedContext}), toolReply({error:{code:errors.unavailable},
    readiness:{...readiness,state:'disposed'}}));
  assert.deepEqual(await status({action:'status',projectId:'opaque-extra'}), toolReply({error:{code:errors.unavailable}}));
});

test('pending aborts never reach an owner; closing after entry suppresses the reply without undoing invocation', async t => {
  const {boot,shell} = wakeFixture(); await boot.registerHandlers(); t.after(()=>boot.dispose());
  const hold = deferred(), preparation = deferred(), entered = deferred(), finish = deferred(), calls = [];
  t.after(()=>{hold.resolve();finish.resolve();});
  boot.start(async ({enableGoalAlarms}) => {
    preparation.resolve(); await hold.promise;
    await attach(boot,{'math-project-setup':{async run(value){calls.push(value); entered.resolve(); return finish.promise;},
      abort(value){calls.push(value); return 'existing owner result';}}});
    enableGoalAlarms();
  });
  await preparation.promise;
  await assert.rejects(shell.get('math-project-setup').abort('before-owner'),{code:errors.pending});
  await delay(20); // Departure with the hold still acquired, not after release.
  await assert.rejects(shell.get('math-project-setup').abort('still-pending'),{code:errors.pending});
  assert.deepEqual(calls,[]);
  hold.resolve(); await ready(boot);
  assert.deepEqual(calls,[]);
  assert.equal(await shell.get('math-project-setup').abort('new-abort'),'existing owner result');
  const result = shell.get('math-project-setup').run(event);
  const rejected = assert.rejects(result,{code:errors.unavailable});
  await entered.promise;
  assert.equal(calls[1],event);
  await boot.dispose(); finish.resolve('must not escape'); await rejected;
  await assert.rejects(shell.get('math-project-setup').abort('after-close'),{code:errors.unavailable});
  assert.deepEqual(calls,['new-abort',event]);
});

test('failure closes the Goal exception before slow cleanup; a late attachment after disposal is not published', async t => {
  const f = wakeFixture(), close = deferred(), cleanupEntered = deferred(), order = [];
  await f.boot.registerHandlers(); t.after(async()=>{close.resolve(); await f.boot.dispose();});
  await f.boot.own(()=>order.push('earlier'));
  await f.boot.own(async()=>{order.push('later');cleanupEntered.resolve();await close.promise;});
  f.boot.start(async ({enableGoalAlarms})=>{
    await attach(f.boot);
    enableGoalAlarms();
    throw Error('synthetic preparation failure');
  });
  await cleanupEntered.promise;
  await assert.rejects(f.shell.get(goalKey).run({kind:'schedule'}),{code:errors.unavailable});
  await assert.rejects(f.shell.get('math-research-once').abort('old'),{code:errors.unavailable});
  assert.throws(f.boot.assertReady,{code:errors.unavailable});
  assert.deepEqual(order,['later']);
  close.resolve(); await f.boot.dispose(); assert.deepEqual(order,['later','earlier']);

  const g = wakeFixture(), release = deferred(), started = deferred(), lateCleaned = deferred();
  await g.boot.registerHandlers(); t.after(()=>release.resolve());
  g.boot.start(async ({enableGoalAlarms})=>{
    started.resolve(); await release.promise;
    await g.boot.own(()=>lateCleaned.resolve());
    enableGoalAlarms();
  });
  await started.promise; await g.boot.dispose(); release.resolve(); await lateCleaned.promise;
  assert.throws(g.boot.assertReady,{code:errors.unavailable});
  await assert.rejects(g.shell.get(goalKey).run({kind:'schedule'}),{code:errors.unavailable});
});

test('the real Goal restart owner accepts exactly one matching early alarm before the schedule receipt', {timeout:3500}, async t => {
  const shell = new Map(), schedules = new Map(), answers = [], lookedUp = [];
  const projectId = 'project-fixture', goalId = 'goal-fixture', anchor = 1_000_000;
  const main = { sessionId:'fixture-main',sessionPath:'/fixture/main',agentId:'fixture-agent',cwd:'/fixture/project/main',kind:'fixture-kind',identityConfirmed:true };
  let persisted = { schemaVersion:1,projectId,goalId,revision:0,generation:1,state:'active',authorization:{explicit:true,at:1},main,
    restartAuthorization:{resume:'preserve-budget'},continuationBudget:{limit:3,reserved:1},nextControlAt:anchor+10_000,nextAuditAt:anchor+20_000,
    lastAuditAt:null,waiting:true,continueRequested:false,due:{control:null,audit:null},ack:{control:null,audit:null},
    workerStop:{state:'not-requested',cleanupPending:null},send:null,alarm:null };
  const row = {...main,path:main.sessionPath,ownerPluginId:'hana-math',visibility:'public',namespace:'home',lifecycle:'active'};
  let boot;
  const sdk = {
    tasks:{async registerHandler(key,handler){shell.set(key,handler);return receipt();},
      async schedule(input){
        const result = {...input,scheduleId:'fixture-alarm',pluginId:'hana-math',intervalMs:null}; schedules.set(result.scheduleId,result);
        const value = {kind:'schedule',scheduleId:result.scheduleId,input:result.payload};
        assert.throws(boot.assertReady,{code:errors.pending});
        await assert.rejects(shell.get('math-project-setup').abort('old'),{code:errors.pending});
        await assert.rejects(shell.get(goalKey).run({ ...value,kind:'retry' }),{code:errors.pending});
        for (const input of [{...value.input,generation:1},{...value.input,token:'wrong-token'},value.input,value.input])
          answers.push(await shell.get(goalKey).run({...value,input}));
        return result;
      }, async getSchedule(id){lookedUp.push(id);return schedules.get(id);},
      async unschedule(id){assert.ok(schedules.delete(id));return {ok:true};}},
    sessions:{async list(){return {sessions:[row]};},async get(){return {session:row};},
      async send(){return {accepted:true,sessionId:main.sessionId,sessionPath:main.sessionPath};}},
    bus:{async subscribe(){return Object.assign(()=>{},{ready:Promise.resolve()});}},
    logger:{error:forbidden},tools:{},routes:{},
  };
  boot = createMathBootstrap(sdk); await boot.registerHandlers(); t.after(()=>boot.dispose());
  boot.start(async ({enableGoalAlarms})=>{
    await attach(boot,{[goalKey]:null});
    const goals = await createMainControlService({...sdk,tasks:{...sdk.tasks,registerHandler:boot.attachHandler}}, {
      store:{async mkdir(){},async list(){return [`${projectId}.json`];},async readJson(){return structuredClone(persisted);},
        async write(_file,bytes){persisted=JSON.parse(bytes);}},
      clock:{now:()=>anchor,setTimeout:()=>Symbol(),clearTimeout(){}},
      authorize:forbidden,getMainBinding:forbidden,verifyCompletion:forbidden,stopWorkers:forbidden,
      recoveryReadiness:async()=>({ready:true}),
    });
    await boot.own(()=>goals.dispose());
    enableGoalAlarms(); await goals.activateRestarts();
  });
  await ready(boot);
  assert.deepEqual(answers,[{status:'ignored'},{status:'ignored'},{status:'accepted',projectId},{status:'ignored'}]);
  assert.deepEqual(lookedUp,['fixture-alarm']);
  assert.equal(persisted.state,'active');
  assert.equal(persisted.generation,3);
  assert.deepEqual(persisted.continuationBudget,{limit:3,reserved:1});
});
