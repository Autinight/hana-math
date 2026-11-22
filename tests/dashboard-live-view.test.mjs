import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerPanel } from '../packages/hana-math/panel-service.mjs';
import { createDashboardView } from '../packages/hana-math/dashboard-view.mjs';
import { createLivePage } from '../packages/hana-math/ui/dashboard/live-page.mjs';
import { LIVE_PROVIDER, LIVE_TTL, LIVE_CHECK, LIVE_COMMIT, LIVE_ROUTE, LIVE_ACTIVATE, EPOCH_HEADER, SEQUENCE_HEADER } from '../packages/hana-math/ui/dashboard/live-protocol.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let go; return { promise: new Promise(resolve => { go = resolve; }), release: x => go(x) }; };
const input = (page, action = 'bind', projectId = 'project-demo') => ({ action, projectId, documentId: page.stamp.documentId,
  viewId: page.stamp.viewId, clientId: page.clientId, expectedRevision: 0 });
const unauthorized = x => assert.equal(x.isError, true, JSON.stringify(x.details));
const ok = x => assert.equal(x.isError, false, JSON.stringify(x.details));

async function harness(t) {
  let now = 0, tool, registrations = 0, ordinal = 0;
  const routes = new Map(), pages = new Map(), access = new WeakMap(), grants = [], reads = [];
  const checks = [], hooks = {};
  const sdk = { documents: {
    async requestView(handle, request) {
      const p = access.get(handle);
      if (!p || !p.visible || !p.handler || request.expectedRevision !== 0) throw Error('HOST_REFUSED');
      const handler = p.handler;
      p.viewCalls.push(request.method);
      const result = await handler({ requestId:'host-view-request', revision:0, documentId:p.stamp.documentId,
        viewId:p.stamp.viewId, method:request.method, payload:request.payload });
      if (hooks.afterView) await hooks.afterView(p, request);
      if (!p.visible || p.handler !== handler) throw Error('HOST_REVOKED');
      return result;
    },
    async read(handle) {
      const p = access.get(handle);
      if (!p?.bound) throw Error('HOST_REVOKED');
      checks.push(p.label);
      return { content:'marker bytes are discarded' };
    },
  }, tools:{ async register(def) { tool = def; return () => {}; } },
  routes:{ async register(fn) { registrations++; fn({
    get(path, h) { assert.ok(!routes.has(path)); routes.set(path, h); },
    post(path, h) { routes.set(path, h); },
  }); } } };
  const service = createDashboardView(sdk, { async authorizeDashboardView({ projectId }, originalCtx) {
    grants.push(projectId);
    const owner = [...pages.values()].find(p => p.originalCtx === originalCtx);
    assert.ok(owner, 'Project receives the original context, not a copy or reconstructed token');
    if (hooks.authorize) await hooks.authorize(projectId, owner);
    return async (selection, guard) => {
      if (hooks.beforeRead) await hooks.beforeRead(selection, owner);
      guard();
      reads.push({ projectId, owner:owner.label, selection });
      if (hooks.afterRead) await hooks.afterRead(selection, owner);
      guard();
      return { witness: owner.label, view: selection.view };
    };
  } }, { now: () => now });
  t.after(() => { for (const p of pages.values()) p.ui.dispose(); service.dispose(); });
  await registerPanel(sdk, service);
  await service.registerTool();
  assert.equal(registrations, 1);
  assert.equal(tool.documentAccess, 'read'); assert.deepEqual(tool.view, { providerId: LIVE_PROVIDER });
  assert.deepEqual(tool.parameters.required, ['action','projectId','documentId','clientId','viewId','expectedRevision']);

  async function route(p, path, { epoch = p?.epoch, seq = p?.seq, context, method = 'GET', body, signal, header = {} } = {}) {
    const pathname = new URL(path,'http://fixture.invalid').pathname;
    const handler = routes.get(pathname);
    if (!handler) return new Response(null,{status:404});
    const raw = new Request(`http://fixture.invalid${path}`, { method, body, signal,
      headers: { ...header, [EPOCH_HEADER]: epoch ?? '', [SEQUENCE_HEADER]: seq ?? '' } });
    return handler({ req:{raw}, get(key) {
      assert.equal(key,'appRequestContext');
      return context ?? p?.routeContext;
    } });
  }
  async function page(label, stamp = {}) {
    const n = ++ordinal;
    const p = { label, stamp:{ appId:'hana-math', providerId:LIVE_PROVIDER, documentId:'doc-demo', viewId:`view-${n}`,
      generation:1, capabilities:['read'], ...stamp }, clientId:`client-${n}`, epoch:n.toString(16).padStart(32,'0'), visible:true, bound:true,
      calls:[], viewCalls:[], shown:[], timers:[], latest:null };
    const toolAccess = {}, routeAccess = {};
    p.originalCtx = Object.freeze({ sessionPath:'/fixture/creator.jsonl', callToken:'fixture-only', document:{ context:p.stamp, access:toolAccess } });
    p.routeContext = Object.freeze({ appId:'hana-math', agentId:null, document:{ context:p.stamp, access:routeAccess } });
    access.set(toolAccess,p); access.set(routeAccess,p);
    p.ui = createLivePage({ document:{ async getContext() { return p.bound ? { ...p.stamp } : null; },
      async reportStatus(status) { assert.deepEqual(status,{revision:0,dirty:false,canUndo:false,canRedo:false}); },
      onViewRequest(handler) { p.handler=handler; return () => { p.handler=null; }; } }, api:{ fetch(path, opts) {
      p.calls.push(path);
      if (!p.bound) return new Response(null,{status:403});
      assert.equal(opts.cache,'no-store');
      assert.match(opts.headers[SEQUENCE_HEADER],/^[1-9][0-9]*$/);
      assert.deepEqual(opts.headers,{[EPOCH_HEADER]:p.epoch,[SEQUENCE_HEADER]:opts.headers[SEQUENCE_HEADER]});
      if (path===LIVE_ACTIVATE) p.seq=opts.headers[SEQUENCE_HEADER];
      return route(p,path,{signal:opts.signal,seq:opts.headers[SEQUENCE_HEADER]});
    } } }, options => { p.shown.push(options); p.latest=options; }, { epoch:p.epoch, now:()=>now,
      timer(fn,ms) { const handle=setTimeout(fn,ms); p.timers.push(['start',ms]); return handle; },
      cancel(handle) { clearTimeout(handle); p.timers.push(['cancel']); } });
    pages.set(label,p);
    assert.equal(await p.ui.start(),true);
    assert.deepEqual(p.calls,[]);
    return p;
  }
  async function invoke(p, args = input(p)) {
    // This is the fixture Host's own document gate; the independently tested
    // backend receives only the stamped envelope, not a model-supplied context.
    if (!p.visible || args.clientId!==p.clientId || args.expectedRevision!==0) return {isError:true,details:{error:{code:'HOST_REFUSED'}}};
    return tool.execute({ ...args, context:p.originalCtx });
  }
  return { page, route, invoke, direct: args => tool.execute(args), hooks, checks, reads, grants,
    expire:() => { now += LIVE_TTL; }, dispose:() => service.dispose() };
}

const graph = `${LIVE_ROUTE}/api/factgraph`;
const body = async response => { assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store'); return response.json(); };

test('Host refusal, missing or wrong stamp and tampered input fail before Project authorization', async t => {
  const f=await harness(t), a=await f.page('A');
  for (const args of [{...input(a),clientId:'foreign'},{...input(a),expectedRevision:1},{...input(a),viewId:'other'},
    {...input(a),documentId:'other'},{...input(a),scope:'all'},{...input(a),action:'implicit'},{...input(a),projectId:'other'}]) unauthorized(await f.invoke(a,args));
  unauthorized(await f.direct({...input(a),context:{}}));
  a.visible=false; unauthorized(await f.invoke(a));
  assert.equal((await f.route(null,graph,{epoch:a.epoch})).status,403);
  assert.deepEqual(f.grants,[]); assert.deepEqual(f.reads,[]); assert.deepEqual(f.checks,[]);
});

test('same project A and B cannot share a lease or route data; only explicit selectors are admitted', async t => {
  const f=await harness(t), a=await f.page('A'), b=await f.page('B');
  ok(await f.invoke(a)); await tick();
  assert.deepEqual(await (await a.latest.request('/api/factgraph')).json(),{witness:'A',view:'factgraph'});
  assert.equal((await f.route(b,graph,{epoch:a.epoch})).status,403);
  assert.equal((await f.route(a,graph,{epoch:b.epoch})).status,403);
  ok(await f.invoke(b)); await tick();
  assert.deepEqual(await body(await f.route(b,graph)),{witness:'B',view:'factgraph'});
  assert.deepEqual(await body(await f.route(a,graph)),{witness:'A',view:'factgraph'});
  for(const [path,opts,status] of [[`${graph}?projectId=project-x`,{},400], [`${graph}?view=overview`,{},400],
    [graph,{header:{'content-type':'application/json'}},400], [graph,{method:'POST',body:'{}'},400],
    [`${LIVE_ROUTE}/api/channel/_status`,{},404], [`${LIVE_ROUTE}/api/channel/%70lan`,{},404]]) {
    assert.equal((await f.route(a,path,opts)).status,status);
  }
  assert.deepEqual(f.reads.map(r=>r.owner),['A','B','A']);
});

test('reopened instance and new Host generation must each bind explicitly; revoke during a read drops the body', async t => {
  const f=await harness(t), a=await f.page('A'); ok(await f.invoke(a)); await tick();
  a.ui.dispose(); a.bound=false;
  const b=await f.page('B',{viewId:a.stamp.viewId});
  assert.equal((await f.route(b,graph)).status,403);
  ok(await f.invoke(b)); await tick();
  const enter=gate(), release=gate();
  f.hooks.afterRead=async()=>{enter.release();await release.promise;};
  const get=f.route(b,graph); await enter.promise;
  b.bound=false; release.release();
  const rejected=await get; assert.equal(rejected.status,403);assert.doesNotMatch(await rejected.text(),/witness/);
  const c=await f.page('C',{viewId:a.stamp.viewId,generation:2});
  assert.equal((await f.route(c,graph,{epoch:b.epoch})).status,403);
  ok(await f.invoke(c)); await tick();
  assert.deepEqual(await body(await f.route(c,graph)),{witness:'C',view:'factgraph'});
});

test('late concurrent bind and unbind cannot revive or return queued data', async t => {
  const f=await harness(t), a=await f.page('A');
  const enter=gate(), release=gate();
  f.hooks.authorize=async project=>{if(project==='project-slow'){enter.release();await release.promise;}};
  const older=f.invoke(a,input(a,'bind','project-slow'));
  await enter.promise;
  assert.equal((await f.route(a,graph)).status,403);
  ok(await f.invoke(a)); await tick(); release.release(); unauthorized(await older);
  const queue=gate(), dequeue=gate();
  f.hooks.beforeRead=async()=>{queue.release();await dequeue.promise;};
  const reading=f.route(a,graph); await queue.promise;
  unauthorized(await f.invoke(a,input(a,'unbind','project-other')));
  ok(await f.invoke(a,input(a,'unbind')));
  assert.match(a.latest.notice,/未绑定/);
  dequeue.release(); assert.equal((await reading).status,403);
  assert.equal((await f.route(a,graph)).status,403);assert.deepEqual(f.reads,[]);
});

test('Project denial for bind and unbind has no page, timer, handshake or reader side effects', async t => {
  const f=await harness(t), a=await f.page('A'); ok(await f.invoke(a)); await tick();
  const shown=a.shown.length, timers=a.timers.length, requests=a.calls.length, handshake=a.viewCalls.length, seq=a.seq;
  const previous=a.latest;
  f.hooks.authorize=()=>{ throw Object.assign(Error('private project details'),{code:'PROJECT_OWNER_DENIED'}); };
  for (const action of ['bind','unbind']) {
    const reply=await f.invoke(a,input(a,action)); unauthorized(reply);
    assert.deepEqual(reply.details,{error:{code:'DASHBOARD_VIEW_DENIED'}});
  }
  assert.equal(a.latest,previous);
  assert.deepEqual([a.shown.length,a.timers.length,a.calls.length,a.viewCalls.length,a.seq],[shown,timers,requests,handshake,seq]);
  assert.deepEqual(await (await previous.request('/api/factgraph')).json(),{witness:'A',view:'factgraph'});
  assert.deepEqual(f.reads.map(r=>r.projectId),['project-demo']);
});

test('same page requires old-project unbind; old generation cannot dispatch after a different project binds', async t => {
  const f=await harness(t), a=await f.page('same'); ok(await f.invoke(a,input(a,'bind','project-alpha'))); await tick();
  const seq=a.seq, epoch=a.epoch, old=a.latest, shown=a.shown.length, timers=a.timers.length, probes=a.viewCalls.length;
  for (const action of ['bind','unbind']) {
    const reply=await f.invoke(a,input(a,action,'project-beta')); unauthorized(reply);
    assert.deepEqual(reply.details,{error:{code:'DASHBOARD_VIEW_UNBIND_REQUIRED'}});
    assert.doesNotMatch(JSON.stringify(reply),/project-alpha/);
  }
  assert.deepEqual(a.viewCalls.slice(probes),[LIVE_CHECK,LIVE_CHECK]);
  assert.deepEqual([a.latest,a.shown.length,a.timers.length,a.seq],[old,shown,timers,seq]);
  ok(await f.invoke(a,input(a,'unbind','project-alpha')));
  assert.match(a.latest.notice,/回到创建项目的对话/);
  assert.equal((await f.route(a,graph,{epoch,seq})).status,403);
  ok(await f.invoke(a,input(a,'bind','project-beta'))); await tick();
  assert.equal(a.epoch,epoch); assert.notEqual(a.seq,seq);
  for (const path of [graph,LIVE_ACTIVATE]) assert.equal((await f.route(a,path,{epoch,seq})).status,403);
  await assert.rejects(old.request('/api/factgraph'));
  assert.deepEqual(f.reads,[]);
  assert.deepEqual(await body(await f.route(a,graph)),{witness:'same',view:'factgraph'});
  assert.deepEqual(f.reads.map(r=>r.projectId),['project-beta']);
});

test('CAS rejects a slow authorized call even when a faster bind and unbind return the slot to absent', async t => {
  const f=await harness(t), a=await f.page('same'), started=gate(), release=gate();
  let first=true;
  f.hooks.authorize=async()=>{if(first){first=false;started.release();await release.promise;}};
  const slow=f.invoke(a); await started.promise;
  assert.deepEqual(a.viewCalls,[]);
  ok(await f.invoke(a)); await tick(); ok(await f.invoke(a,input(a,'unbind')));
  const viewCalls=[...a.viewCalls], unbound=a.latest;
  release.release();
  assert.deepEqual((await slow).details,{error:{code:'DASHBOARD_VIEW_REPLACED'}});
  assert.deepEqual(a.viewCalls,viewCalls); assert.equal(a.latest,unbound);
  assert.equal((await f.route(a,graph)).status,403); assert.deepEqual(f.reads,[]);
});

test('Host commit failure never releases pending data and leaves both UI and route unbound', async t => {
  const f=await harness(t), a=await f.page('A');
  const got=gate(), stop=gate();
  f.hooks.afterView=async(_,r)=>{if(r.method===LIVE_COMMIT){got.release();await stop.promise;throw Error('lost Host authorization after page ack');}};
  const bind=f.invoke(a); await got.promise; await tick();
  assert.ok(a.calls.includes(LIVE_ACTIVATE));
  assert.equal((await f.route(a,graph)).status,403); assert.deepEqual(f.reads,[]);
  stop.release(); unauthorized(await bind); await tick();
  assert.match(a.latest.notice,/已失效/);
  assert.equal((await f.route(a,graph)).status,403);
});

test('fixed expiry, Host replacement noticed by UI, and adapter disposal do not renew a page', async t => {
  const f=await harness(t), a=await f.page('A'); ok(await f.invoke(a)); await tick();
  const read=a.latest.request;
  await body(await f.route(a,graph)); f.expire();
  assert.equal((await f.route(a,graph)).status,403);
  await assert.rejects(read('/api/overview')); assert.match(a.latest.notice,/到期/);
  ok(await f.invoke(a)); await tick();
  a.stamp.generation++; a.ui.check(); await tick(); assert.match(a.latest.notice,/到期/);
  assert.equal((await f.route(a,graph)).status,403);
  f.dispose(); unauthorized(await f.invoke(a));
});

test('bundled SDK exports the checked server and UI doors; the second preview shares the unchanged Danus shell', async () => {
  const app = new URL('../packages/hana-math/',import.meta.url);
  const text = name => readFile(new URL(name,app),'utf8');
  const [manifest,live,snapshot,sdk,entry,sample] = await Promise.all(['manifest.json','ui/dashboard/live.html','ui/dashboard/index.html',
    'ui/assets/sdk.js','ui/dashboard/live-boot.js','../../examples/live-dashboard.hanamathboard'].map(text));
  assert.deepEqual(JSON.parse(manifest).contributes.previewers.map(x=>[x.id,x.mode,x.route]),[
    ['factgraph-snapshot','read','/dashboard/index.html'],['live-dashboard','read','/dashboard/live.html']]);
  assert.equal(live,snapshot.replace('./boot.js','./live-boot.js'));
  assert.match(entry,/livePreview: true/);
  assert.match(sdk,/return getSdk\(\)\.document\.onViewRequest\(handler\);/);
  assert.deepEqual(JSON.parse(sample),{kind:'hana-math.live-dashboard',schemaVersion:1});
});
