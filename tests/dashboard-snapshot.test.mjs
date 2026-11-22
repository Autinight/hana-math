import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeSnapshot, decodeSnapshotFile } from '../packages/hana-math/ui/dashboard/snapshot.mjs';

const A = 'aa11111111111111', B = 'bb22222222222222';
const fact = id => ({id, author:'研究者', problem_id:'p', statement:'1 < 2 & 3', proof:'由 $x^2$。', intuition:'', predecessors:[], depth:0});
const sample = () => ({schemaVersion:1, kind:'hana-math.factgraph-snapshot', projectId:'fixture', asOf:'a'.repeat(64), capturedAt:1782907200000,
  graph:{nodes:[fact(A), {...fact(B), predecessors:[A], depth:1}], edges:[{source:A,target:B}], max_depth:1}});
const encoded = bytes => ({encoding:'base64', content:Buffer.from(bytes).toString('base64')});
const decode = value => decodeSnapshot(encoded(JSON.stringify(value)));

test('read result decodes strict UTF-8; snapshot keeps full text and admits an empty graph', () => {
  const s = sample(); assert.deepEqual(decode(s), s);
  s.graph = {nodes:[], edges:[], max_depth:0}; assert.deepEqual(decode(s), s);
  assert.throws(() => decodeSnapshot(encoded(Buffer.from([0xc0,0xaf]))));
  assert.throws(() => decodeSnapshot({encoding:'utf-8', content:JSON.stringify(s)}));
});
test('snapshot rejects byte and structural caps, foreign envelopes, and invalid capture times', () => {
  const bytes = Buffer.from(JSON.stringify(sample()));
  const fits = Buffer.alloc(1<<20, 0x20); bytes.copy(fits);
  assert.deepEqual(decodeSnapshot(encoded(fits)), sample());
  assert.throws(() => decodeSnapshot(encoded(Buffer.concat([fits, Buffer.from(' ')]))));
  for (const alter of [s=>{s.schemaVersion=2;},s=>{s.extra=1;},s=>{s.capturedAt=8.64e15+1;},
    s=>{s.capturedAt='0';},s=>{s.asOf='not-a-revision';},s=>{s.graph.nodes=Array(2049).fill(fact(A));},
    s=>{s.graph.edges=Array(32769).fill({source:A,target:B});}]) {
    const s = sample(); alter(s); assert.throws(() => decode(s), /Invalid fact graph snapshot/);
  }
});
test('local import uses the same decoder, checks size before reading and rejects non-snapshots', async () => {
  const s = sample(), text = JSON.stringify(s);
  assert.deepEqual(await decodeSnapshotFile(new File([text], 'selected.hanamathgraph')), decode(s));
  for (const meta of [{ name: 'wrong.hanamathboard', size: 12 }, { name: 'large.hanamathgraph', size: (1 << 20) + 1 }]) {
    await assert.rejects(decodeSnapshotFile({ ...meta, arrayBuffer: () => assert.fail('read refused before bytes') }), /Invalid fact graph snapshot/);
  }
  for (const bad of [new File(['{}'], 'not-a-graph.hanamathgraph'), new File([Uint8Array.of(0xc0,0xaf)], 'bad-utf8.hanamathgraph')])
    await assert.rejects(decodeSnapshotFile(bad));
});
test('snapshot requires exact and acyclic predecessor, edge and depth agreement', () => {
  for (const alter of [g=>{g.nodes[1].id=A;},g=>{g.nodes[0].id='only-eight';},g=>{g.nodes[1].proof=null;},
    g=>{g.nodes[1].predecessors=[A,A];},g=>{g.edges=[];},g=>{g.edges[0].target=A;},
    g=>{g.max_depth=0;},g=>{g.nodes[0].predecessors=[B];g.edges.push({source:B,target:A});}]) {
    const s = sample(); alter(s.graph); assert.throws(() => decode(s), /Invalid fact graph snapshot/);
  }
});
