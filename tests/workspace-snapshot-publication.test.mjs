import test from 'node:test';
import assert from 'node:assert/strict';
import {withPublishedWorkspaceDashboard,createSnapshotPublisher} from '../packages/hana-math/workspace-snapshot-publication.mjs';
import {workspaceProjectBusy} from '../packages/hana-math/dashboard-monitor-transport.mjs';
import {dashboardSelection} from '../packages/hana-math/dashboard-request.mjs';
import {liveChannels,livePaths} from '../packages/hana-math/ui/dashboard/live-protocol.mjs';
const yes=()=>true, id='project-a', endedAt=900, scopeSeal='0'.repeat(64), ticket={projectId:id,endedAt,scopeSeal};
const unavailable={state:'unavailable'}, idle={state:'idle'};
function defer(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('publisher needs no viewer; uses exactly the nonempty channels and one canonical grant; never publishes partial results',async()=>{
  const calls=[], publications=[], begins=[]; let ticketSaved=null,busy=true;
  const archive={latest:()=>ticketSaved,async begin(identity,guard){assert.equal(guard(),true);begins.push(identity);},async publish(pkg,guard){assert.equal(guard(),true);publications.push(pkg);ticketSaved=ticket;}};
  let valid=true;
  const source={endedAt,scopeSeal,guard:()=>valid,authorize:async guard=>guard(),getRevision:()=>'a'.repeat(64),async read(sel,guard,end){assert.equal(guard(),true);assert.equal(end,endedAt);calls.push(sel);
    if(sel.view==='channels')return {channels:liveChannels.map(kind=>({kind,count:kind==='verification'?1:0}))};
    if(sel.view==='factgraph'&&busy){busy=false;throw workspaceProjectBusy;}
    return {some:'already checked production payload'};}};
  const pub=createSnapshotPublisher({archive,capture:()=>source,delay:async()=>{}});
  pub.notify(id);pub.notify(id);await pub.drain();pub.notify(id);await pub.drain();
  assert.equal(begins.length,1);assert.equal(publications.length,1);
  assert.deepEqual(Object.keys(publications[0].panels).sort(),[...livePaths].sort());
  assert.deepEqual(publications[0].panels['/api/channel/plan'],{kind:'plan',count:0,entries:[]});
  assert.deepEqual(calls.filter(s=>s.view==='channel').map(s=>s.kind),['verification']);assert.equal(calls.length,5);
  ticketSaved=null;source.read=async()=>{valid=false;return {};};pub.notify(id);await pub.drain();assert.equal(publications.length,1);
});

test('a pending or corrupt publication never causes fallback to an older live terminal; active still wins',()=>{
  const prev={state:'snapshot',projectId:id,generation:'terminal-1',endedAt};let state=prev;
  const live={current:()=>state}; const archive={latest:()=>null,barrier:()=>({endedAt:endedAt+1,state:'pending'})};
  const d=withPublishedWorkspaceDashboard({live,archive,allowed:()=>false,authorize:()=>assert.fail(),epoch:()=>1});
  assert.deepEqual(d.current(yes),unavailable);state={state:'active',projectId:id,generation:'new-run'};
  assert.equal(d.current(yes),state);
});

test('a freshly authorized idle choice reads present canonical data without inventing a historical end time',async()=>{
  let state=idle, stamp=0, chosen, barrier=null, oldArchive=null, oldValid=false; const hook=defer(); let hold=false;
  const s=dashboardSelection('/api/factgraph'); const live={current:()=>state,read:()=>assert.fail('not a live selection')};
  const archive={latest:()=>oldArchive,barrier:()=>barrier,read:()=>assert.fail('never replay a superseded archive')};
  const d=withPublishedWorkspaceDashboard({live,archive,allowed:()=>oldValid,authorize:async(t,g)=>g(),epoch:()=>stamp,getSaved:()=>chosen});
  chosen={projectId:id,asOf:12345,authorize:async guard=>guard(),read:async(sel,g,at)=>{assert.equal(at,12345);assert.equal(sel,s);g();if(hold)await hook.promise;return {nodes:[{proof:'current bytes'}]};}};
  const first=await d.current(yes); assert.equal(first.state,'saved');assert.equal(first.asOf,12345);assert.ok(!Object.hasOwn(first,'endedAt'));
  assert.deepEqual(await d.read(s,first.generation,yes),{nodes:[{proof:'current bytes'}]});
  oldArchive=ticket;barrier={state:'published',endedAt}; assert.equal((await d.current(yes)).state,'saved');oldValid=true;assert.equal((await d.current(yes)).state,'snapshot');
  oldValid=false;const next=await d.current(yes);hold=true;const read=d.read(s,next.generation,yes);await new Promise(r=>setImmediate(r));
  chosen=null;stamp++;hook.resolve();assert.deepEqual(await read,unavailable);
  state={state:'active',projectId:'new-project',generation:'real-live'};assert.equal(d.current(yes),state);
});

test('a superseded foreign publication cannot hide the explicitly followed, quiescent project',async()=>{
  const staleTicket={...ticket,projectId:'project-b'}, graph=dashboardSelection('/api/factgraph');
  let available=true, validity=false, barrier={state:'published',endedAt}, cur=idle, reads=0;
  const saved={projectId:id,asOf:12345,authorize:async guard=>guard(),read:async(sel,g)=>{g();reads++;assert.equal(sel,graph);return {nodes:[{proof:'A-only'}]};}};
  const d=withPublishedWorkspaceDashboard({live:{current:()=>cur},archive:{latest:()=>staleTicket,barrier:()=>barrier,read:()=>assert.fail('must never read the stale B archive')},
    allowed:()=>{if(validity instanceof Error)throw validity;return validity;},authorize:async(t,g)=>g(),epoch:()=>1,getSaved:()=>available?saved:null});
  const result=await d.current(yes);assert.equal(result.state,'saved');assert.equal(result.projectId,id);assert.equal(result.asOf,saved.asOf);assert.equal('endedAt' in result,false);
  assert.deepEqual(await d.read(graph,result.generation,yes),{nodes:[{proof:'A-only'}]});assert.equal(reads,1);
  available=false;assert.deepEqual(await d.read(graph,result.generation,yes),unavailable);available=true;
  validity=true;assert.equal((await d.current(yes)).projectId,'project-b','valid higher-priority archive wins');
  validity=new Error('uncertain scope');assert.deepEqual(await d.current(yes),unavailable);
  validity=false;barrier={state:'conflict',endedAt};assert.deepEqual(await d.current(yes),unavailable);
  barrier={state:'published',endedAt};cur=unavailable;assert.deepEqual(await d.current(yes),unavailable);assert.equal(reads,1);
});

test('archive content is read on its own generation only, never grants a live read or overrides uncertain activity',async()=>{
  let state=idle, currentTicket=ticket, epoch=1, grant=true;const wait=defer();let hold=false,contentReads=0,liveReads=0;
  const archive={latest:()=>currentTicket,read(t,s){assert.equal(t,ticket);assert.equal(s,dashboardSelection('/api/factgraph'));contentReads++;return {nodes:[{proof:'stored proof'}]};}};
  const live={current:()=>state,read(){liveReads++;return {facts:0};}};
  const d=withPublishedWorkspaceDashboard({live,archive,epoch:()=>epoch,allowed:()=>grant,authorize:async(t,guard)=>{guard();if(hold)await wait.promise;guard();}});
  const s=dashboardSelection('/api/factgraph'), saved=await d.current(yes);assert.equal(saved.state,'snapshot');assert.equal(saved.projectId,id);
  assert.deepEqual(await d.read(s,saved.generation,yes),{nodes:[{proof:'stored proof'}]});assert.equal(liveReads,0);
  grant=false;assert.deepEqual(d.current(yes),unavailable);grant=true;
  const lateGen=(await d.current(yes)).generation;assert.notEqual(lateGen,saved.generation);hold=true;const late=d.read(s,lateGen,yes);
  state={state:'active',projectId:'project-b',generation:'live-b'};epoch++;wait.resolve();assert.deepEqual(await late,unavailable);assert.equal(contentReads,1);
  assert.equal(d.current(yes),state);assert.deepEqual(await d.read(s,lateGen,yes),unavailable);assert.equal(liveReads,0);
  state=unavailable;assert.deepEqual(d.current(yes),unavailable);
  state=idle;currentTicket=null;assert.deepEqual(d.current(yes),idle);assert.deepEqual(await d.read(s,lateGen,yes),unavailable);
  assert.deepEqual(d.current(()=>false),unavailable);
});
