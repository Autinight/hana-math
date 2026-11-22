import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installDashboardDrop } from '../packages/hana-math/ui/assets/dashboard-launcher.mjs';

const app = id => `app:hana-math/${id}`;
const workspace = 'application/x-hana-file-drag';
const makeEvent = (types, { trusted = true, canceled = false, count = 1 } = {}) => ({
  isTrusted: trusted, defaultPrevented: canceled,
  dataTransfer: {types, files:{length:count}, getData(){assert.fail('launcher must not read an opaque drag payload');}},
  preventDefault(){this.defaultPrevented = true;},
});
function fixture(t, reply = () => ({opened:true})) {
  const events = new Map(), calls = [], status = {textContent:''};
  let binding = {appId:'hana-math', slot:'card', cardInstanceId:'fixture-card'};
  const zone = { addEventListener:(name,fn)=>events.set(name,fn), removeEventListener:(name,fn)=>{
    assert.equal(events.get(name), fn); events.delete(name);
  }};
  const host = {surface:{getContext:()=>binding},document:{async openDrop(...args){
    assert.equal(args.length,1); assert.equal(args[0].defaultPrevented,false,'SDK sees the uncanceled original drop');
    calls.push(args[0]); return reply();
  }}};
  const stop = installDashboardDrop(host, zone, status);
  t.after(()=>{if(events.size)stop();});
  return {event:(e,name='drop')=>events.get(name)(e),calls,status,stop,events,bind:value=>{binding=value;}};
}

test('legacy card drop handler forwards one native workspace drop without extension or provider inference', async t => {
  const f = fixture(t); const drop = makeEvent([workspace]);
  f.event(makeEvent([workspace]),'dragover');
  await f.event(drop);
  assert.deepEqual(f.calls,[drop]); assert.equal(drop.defaultPrevented,true);
  assert.match(f.status.textContent,/已交给 Hana/);
  for (const binding of [null,{appId:'hana-math',slot:'settings',cardInstanceId:null},
    {appId:'hana-math',slot:'page',cardInstanceId:'fixture-page'},{appId:'other',slot:'card',cardInstanceId:'other-card'}]) {
    f.bind(binding); const e = makeEvent([workspace]); await f.event(e); assert.ok(e.defaultPrevented);
  }
  assert.equal(f.calls.length,1); assert.match(f.status.textContent,/卡片中心/);
});

test('canceled/text/untrusted drops and multiple native files do not open; Host refusal is not success', async t => {
  const f = fixture(t, () => { throw new Error('private-fixture-refusal'); });
  for(const e of [makeEvent(['text/uri-list']), makeEvent([workspace],{canceled:true}),
    makeEvent([workspace],{trusted:false}), makeEvent(['Files'],{count:2})]) await f.event(e);
  assert.equal(f.calls.length,0);
  const single=makeEvent(['Files']); await f.event(single);
  assert.equal(f.calls[0],single);
  assert.match(f.status.textContent,/没有打开文件/);
  assert.doesNotMatch(f.status.textContent,/private-fixture-refusal/);
});

test('one in-flight handoff; closing card ignores its late result', async t => {
  let resolve;
  const f=fixture(t,()=>new Promise(r=>{resolve=r;}));
  const done=f.event(makeEvent([workspace]));
  await f.event(makeEvent([workspace]));
  assert.equal(f.calls.length,1);
  f.stop(); assert.equal(f.events.size,0);
  const before=f.status.textContent;
  resolve({opened:true}); await done;
  assert.equal(f.status.textContent,before);
});

function saveFixture(t, saveFile) {
  let ctx = {appId:'hana-math', slot:'card', cardInstanceId:'fixture-card'}, notify, click;
  const saves = [], opens = [], status = {textContent:''};
  const button = { disabled:true, addEventListener(name,fn){assert.equal(name,'click'); click=fn;},
    removeEventListener(name,fn){assert.equal(name,'click');assert.equal(click,fn); click=undefined;} };
  const zone = {addEventListener(){}, removeEventListener(){}};
  const sdk = {surface:{getContext:()=>ctx, onContextChanged(fn){notify=fn;fn(ctx);return ()=>{notify=undefined;};}},
    resources:{saveFile(args){saves.push(args);return saveFile();}},
    document:{open(args){opens.push(args);return Promise.resolve({opened:true});}},
  };
  const dispose = installDashboardDrop(sdk,zone,status,button);
  t.after(()=>{if(click)dispose();});
  return {saves,opens,status,button,dispose,click:(isTrusted = true)=>click({isTrusted,defaultPrevented:false}),
    setContext(next){ctx=next;notify?.(ctx);},card:()=>ctx};
}
const marker = Object.freeze({kind:'local-file',path:'/work/research.hanamathboard'});

test('trusted click hands exact blank seed to Host and opens only the original saved resource', async t => {
  const f=saveFixture(t,()=>Promise.resolve({kind:'saved',resource:marker,saveReceipt:'unused',overwritten:false,version:{}}));
  assert.equal(f.button.disabled,false); assert.deepEqual(f.saves,[]);
  await f.click(false); assert.deepEqual(f.saves,[]);
  const pending = f.click();
  assert.equal(f.saves.length,1,'saving starts within the button callback');
  assert.equal(f.button.disabled,true);
  f.setContext({...f.card()}); // A same-instance notification must not cancel the dialog.
  await pending;
  const [seed]=f.saves;
  assert.deepEqual(Object.keys(seed),['suggestedName','mimeType','contentBase64']);
  assert.equal(seed.suggestedName,'research.hanamathboard'); assert.equal(seed.mimeType,'application/json');
  const bytes=Buffer.from(seed.contentBase64,'base64'); assert.equal(bytes.length,54);
  assert.deepEqual(bytes,readFileSync(new URL('../examples/live-dashboard.hanamathboard', import.meta.url)));
  assert.deepEqual(f.opens,[{providerId:app('live-dashboard'),resource:marker}]);
  assert.equal(f.opens[0].resource,marker);
});

test('canceled, conflict, download, SDK rejection or wrong saved file never opens or retries', async t => {
  const cases=[{kind:'canceled'},{kind:'conflict',resource:marker,phase:'after-write',mayHaveWritten:true},
    {kind:'download-started',suggestedName:'research.hanamathboard',mimeType:'application/json'},
    {kind:'saved',resource:{kind:'local-file',path:'/work/research.hanamathgraph'}},
    {kind:'saved',resource:{kind:'local-file',path:'research.hanamathboard'}},
    {kind:'saved',resource:{kind:'resource',path:'/work/research.hanamathboard'}},null];
  for (const receipt of cases) {
    const f=saveFixture(t,()=>Promise.resolve(receipt)); await f.click();
    assert.equal(f.saves.length,1); assert.deepEqual(f.opens,[]);
  }
  const rejected=saveFixture(t,()=>Promise.reject(Error('opaque-refusal')));
  await rejected.click();assert.equal(rejected.saves.length,1);assert.deepEqual(rejected.opens,[]);
  assert.doesNotMatch(rejected.status.textContent,/opaque-refusal/);
});

test('settings never saves; duplicate clicks, card replacement and disposal cannot hand off late saves', async t => {
  const settings=saveFixture(t,()=>assert.fail('settings must not save'));
  settings.setContext({appId:'hana-math',slot:'settings',cardInstanceId:null});await settings.click();
  assert.equal(settings.button.disabled,true);assert.deepEqual(settings.saves,[]);
  for (const end of [f=>f.dispose(),f=>f.setContext({...f.card(),cardInstanceId:'other-card'}), f=>{
    const before=f.card();f.setContext({...before,cardInstanceId:'other-card'});f.setContext(before);
  }]) {
    let finish;
    const f=saveFixture(t,()=>new Promise(resolve=>{finish=resolve;}));const request=f.click();
    await f.click(); assert.equal(f.saves.length,1);
    end(f);finish({kind:'saved',resource:marker});await request;
    assert.deepEqual(f.opens,[]);
  }
});

test('existing Host selectors still distinguish live marker and snapshot, and never claim ordinary JSON', () => {
  const {contributes}=JSON.parse(readFileSync(new URL('../packages/hana-math/manifest.json',import.meta.url)));
  const registrations = suffix => contributes.previewers.filter(p=>p.selectors.some(s=>s.extensions?.includes(suffix)))
    .map(p=>[app(p.id),p.route,p.mode]);
  assert.deepEqual(registrations('hanamathboard'),[[app('live-dashboard'),'/dashboard/live.html','read']]);
  assert.deepEqual(registrations('hanamathgraph'),[[app('factgraph-snapshot'),'/dashboard/index.html','read']]);
  assert.deepEqual(registrations('json'),[]);
  assert.deepEqual(contributes.settings.ui,{route:'/panel.html'});
});

test('catalog has one uniquely titled whole-page primary (Host click-only contract), not a legacy card choice', () => {
  const file = name => readFileSync(new URL(`../packages/hana-math/${name}`, import.meta.url), 'utf8');
  const {contributes:{cards}} = JSON.parse(file('manifest.json'));
  // APPS_EN.md:1388–1393: a page primary activates its own Host page; no drag-out or detach.
  // This tests the declaration, not an actual Host click or placement.
  assert.deepEqual(cards,[{id:'research-dashboard-page',title:'研究看板',face:{image:'assets/cover.svg'},
    route:'/dashboard/workspace.html',realization:'page',siteNavEntry:true,pageIcon:'assets/dashboard-nav.svg',
    cardForm:'edge-to-edge',titleMode:'hide'}]);
  assert.match(file(`ui/${cards[0].pageIcon}`), /<svg\b/);
  assert.match(file('ui/dashboard/workspace.html'), /data-dashboard-entry="page"/);
  assert.match(file('ui/dashboard-launcher.html'), /data-dashboard-entry="card"/);
  const landing = file('ui/dashboard/landing.js');
  assert.match(landing, /ordinary = entry === 'card', workspaceMonitor = entry === 'page'/);
  assert.match(landing, /startDashboard\(hana, \{ workspaceMonitor \}\)/);
  assert.match(landing, /\$\{ordinary \? '<label[^\n]*id="snapshot-file"[^\n]*id="new-dashboard"[^\n]*\.hanamathboard[^\n]*绑定/);
  assert.doesNotMatch(landing, /从工作区打开 \.hanamathboard|或普通卡/);
});
