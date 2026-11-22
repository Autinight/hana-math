// Opaque software snapshots; no mathematical computation or real research data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProjectGraph, GRAPH_FACT_LIMIT, GRAPH_EDGE_LIMIT, GRAPH_PAGE_LIMIT } from '../packages/hana-math/project-graph.mjs';
import { fixtureFactPage } from './fact-page-fixture.mjs';
const projectId = 'project-opaque', now = () => 123456;
const rows = count => Array.from({ length: count }, (_, i) => ({ fact_id: i.toString(16).padStart(16, '0'), predecessors: [] }));
const drift = () => Object.assign(new Error('opaque drift'), { code: 'FIXTURE_DRIFT' });
const changed = e => e?.code === 'FIXTURE_DRIFT';
const value = (facts, options = {}) => ({ projectId, ...fixtureFactPage(facts, options, projectId) });

test('collects a complete stable index across pages then rereads one row; never requests proofs', async () => {
  const facts = rows(90), calls = [];
  const snapshot = await collectProjectGraph({ projectId, now, changed, readPage: async options => { calls.push(options); return value(facts, options); } });
  assert.deepEqual(snapshot.facts.map(f => f.fact_id), facts.map(f => f.fact_id));
  assert.equal(snapshot.projectId, projectId); assert.equal(snapshot.capturedAt, 123456);
  assert.equal(snapshot.asOf, value(facts).page.asOf); assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {}); assert.equal(typeof calls[1].cursor, 'string'); assert.deepEqual(calls[2], { limit: 1 });
  assert.ok(calls.every(c => !Object.hasOwn(c, 'factId')));
});
test('empty graph is a confirmed snapshot, not a missing or failed read', async () => {
  const s = await collectProjectGraph({ projectId, now, changed, readPage: async options => value([], options) });
  assert.deepEqual(s.facts, []); assert.equal(s.asOf, value([]).page.asOf);
});
for (const stage of ['continuation', 'final-reread']) test(`one ${stage} drift discards first observation and restarts once`, async () => {
  const before = rows(70), after = rows(71); let current = before, restarts = 0, reads = 0;
  const result = await collectProjectGraph({ projectId, now, changed, readPage: async options => {
    reads++;
    if ((stage === 'continuation' && options.cursor || stage === 'final-reread' && options.limit === 1) && current === before) {
      current = after; if (options.cursor) throw drift();
    }
    if (!Object.keys(options).length) restarts++;
    return value(current, options);
  } });
  assert.deepEqual(result.facts.map(f => f.fact_id), after.map(f => f.fact_id)); assert.equal(restarts, 2);
  assert.ok(reads <= 6); assert.equal(result.asOf, value(after).page.asOf);
});
test('repeated final drift refuses publication with no partial graph', async () => {
  let size = 1, calls = 0;
  await assert.rejects(collectProjectGraph({ projectId, now, changed, readPage: async options => {
    calls++; if (options.limit === 1) size++; return value(rows(size), options);
  } }), { code: 'PROJECT_GRAPH_CHANGED' });
  assert.equal(calls, 4);
});
test('permission/unknown errors propagate once; no retry or fallback reads', async () => {
  for (const code of ['PROJECT_OWNER_DENIED', 'RPC_TIMEOUT', 'PROJECT_CORE_UNSETTLED']) {
    let calls = 0; const failure = Object.assign(new Error(code), { code });
    await assert.rejects(collectProjectGraph({ projectId, now, changed, readPage: async () => { calls++; throw failure; } }), e => e === failure);
    assert.equal(calls, 1);
  }
});
test('fact bound is explicit and no partial snapshot is returned', async () => {
  let calls = 0;
  await assert.rejects(collectProjectGraph({ projectId, now, changed, readPage: async options => { calls++; return value(rows(GRAPH_FACT_LIMIT + 1), options); } }), { code: 'PROJECT_GRAPH_SIZE_LIMIT' });
  assert.equal(calls, 1);
});
test('edge bound is explicit even when individual index pages are valid', async () => {
  const facts = rows(Math.floor(GRAPH_EDGE_LIMIT / 128) + 1);
  for (const fact of facts) fact.predecessors = rows(128).map(f => f.fact_id);
  await assert.rejects(collectProjectGraph({ projectId, now, changed, readPage: async options => value(facts, options) }), { code: 'PROJECT_GRAPH_SIZE_LIMIT' });
});
test('page bound stops a valid but unusually small one-row-per-page observation', async () => {
  const facts = rows(GRAPH_PAGE_LIMIT + 1); let calls = 0;
  await assert.rejects(collectProjectGraph({ projectId, now, changed, readPage: async options => {
    calls++; const v = value(facts, options), start = v.page.startIndex;
    v.facts = v.facts.slice(0, 1); v.page.returned = 1;
    v.page.hasMore = start + 1 < facts.length; v.page.allFactsIncluded = false;
    v.page.nextCursor = v.page.hasMore ? Buffer.from(JSON.stringify({ asOf: v.page.asOf,
      limit: v.page.limit, offset: start + 1, projectId, v: 1 })).toString('base64url') : null;
    return v;
  } }), { code: 'PROJECT_GRAPH_SIZE_LIMIT' });
  assert.equal(calls, GRAPH_PAGE_LIMIT);
});
for (const defect of ['project', 'preview', 'clock']) test(`malformed ${defect} cannot become a graph`, async () => {
  await assert.rejects(collectProjectGraph({ projectId, now: defect === 'clock' ? () => NaN : now, changed, readPage: async options => {
    const v = value(rows(1), options);
    if (defect === 'project') v.projectId = 'another-project';
    if (defect === 'preview') v.page.previewOnly = false;
    return v;
  } }), { code: 'PROJECT_GRAPH_INVALID_RESULT' });
});
