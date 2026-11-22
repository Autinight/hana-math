import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceDashboard } from '../packages/hana-math/dashboard-monitor-transport.mjs';
import { dashboardSelection } from '../packages/hana-math/dashboard-request.mjs';
import { createTerminalReadFence, terminalWriteState } from '../packages/hana-math/terminal-dashboard-read.mjs';

const at = 1795312000123, allowed = () => true, overview = dashboardSelection('/api/overview');
const missing = {state:'unavailable'};
test('terminal discovery requires its own reader, validates the end time, and cannot dispatch a live read', async () => {
  let ticket = { status:'selected', selection:{}, generation:Symbol() }, endedAt = at, calls = 0;
  let release, held = new Promise(r => { release = r; });
  const live = () => assert.fail('terminal did not use the snapshot reader');
  const projectId = 'project-test'; let grant = { projectId, read:live };
  const monitor = {current:() => ticket, read:() => ({status:'ok', lifecycle:'snapshot', projectId, endedAt})};
  const api = createWorkspaceDashboard({ workspaceMonitor:monitor, lookupReader:() => grant });
  assert.deepEqual(api.current(allowed), missing);
  const readSnapshot = async (s,g,end) => { ++calls; assert.equal(s, overview); assert.equal(g(), true); assert.equal(end, at); await held; return {facts:1}; };
  grant = {projectId,read:live,readSnapshot};
  for (endedAt of [null,0,-1,Infinity,Number.MAX_SAFE_INTEGER]) assert.deepEqual(api.current(allowed),missing);
  endedAt=at;
  const cur = api.current(allowed); assert.deepEqual(cur,{state:'snapshot',generation:cur.generation,projectId,endedAt});
  assert.deepEqual(await api.read(overview,'wrong',allowed),missing); assert.equal(calls,0);
  const first = api.read(overview,cur.generation,allowed); assert.equal(calls,1);
  ticket = {...ticket, selection:{},generation:Symbol()}; release(); assert.deepEqual(await first,missing);
  const next = api.current(allowed); assert.notEqual(next.generation,cur.generation);
  assert.deepEqual(await api.read(overview,next.generation,allowed),{facts:1});
  grant = undefined; assert.deepEqual(api.current(allowed),missing);
  assert.deepEqual(await api.read(overview,next.generation,allowed),missing);
});

test('a post-end mutation by main or any sibling worker invalidates even a first late open', () => {
  const clean = {pending:false,endedAt:0};
  for (const pair of [[{pending:false,endedAt:at+1},clean],[null,{pending:false,endedAt:at+1}],
    [{pending:true,endedAt:0},clean],[null,{pending:true,endedAt:0}],[null,undefined],[null,null],[clean,null]]) {
    assert.throws(() => createTerminalReadFence(() => terminalWriteState(...pair)).begin(at));
  }
  const fence=createTerminalReadFence(() => terminalWriteState(null,{pending:false,endedAt:at-1}));
  assert.doesNotThrow(()=>fence.begin(at));
});

test('fence pins one revision for every tab, freezes overview time and latches any changed bytes until a later end', () => {
  let write = null;
  const fence = createTerminalReadFence(() => write);
  const op = (end, rev, selection={view:'overview'}) => fence.project(fence.begin(end), selection,
    {inventoryRevision:rev.repeat(64),data:{facts:1,updated_at:5555},graph:{nodes:[{id:'abc'}]}});
  assert.deepEqual(op(at,'a'),{facts:1,updated_at:at/1000});
  assert.deepEqual(op(at,'a',{view:'factgraph'}),{nodes:[{id:'abc'}]});
  assert.throws(() => op(at,'b')); assert.throws(() => op(at,'a'));
  assert.deepEqual(op(at+2,'c'),{facts:1,updated_at:(at+2)/1000});
  assert.throws(() => op(at,'a'));
  write={pending:true,endedAt:0}; assert.throws(() => op(at+2,'c'));
  write={pending:false,endedAt:at+3}; assert.throws(() => op(at+2,'c'));
  const token = fence.begin(at+4); fence.begin(at+5); assert.throws(() => fence.assert(token));
});
