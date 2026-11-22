import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectPaperFacts } from '../packages/hana-math/paper-facts.mjs';

const id = n => n.toString(16).padStart(16, '0');
const fact = (n, predecessors = []) => ({ fact_id: id(n), predecessors,
  markdown: `---\nfact_id: ${id(n)}\npredecessors: [${predecessors.join(', ')}]\nglossary_introduces: {}\nexternal_refs: []\n---\n## statement\nOpaque.\n## proof\nPROOF_SENTINEL\n` });
const digest = f => createHash('sha256').update(f.markdown).digest('hex');
function fixture(facts, headline, hooks = {}) {
  const map = new Map(facts.map(f => [f.fact_id, f])), calls = { gets: [], pages: 0, guards: 0 };
  const target = { factIds: headline, factDigests: Object.fromEntries(headline.map(k => [k, digest(map.get(k))])) };
  const options = { target,
    async fetchPage() { calls.pages++; return { page: { asOf: hooks.drift && calls.pages > 1 ? 'changed' : 'stable' } }; },
    async fetchFact(key) { calls.gets.push(key); if (!map.has(key)) throw Object.assign(new Error('missing'), { code: 'PROJECT_CORE_INVALID_RESULT' }); return { fact: map.get(key) }; },
    async assertTarget() { calls.guards++; hooks.guard?.(calls.guards); },
    async verifySnapshot(asOf) { const end = await options.fetchPage(); if (end.page.asOf !== asOf) throw Object.assign(new Error('changed'), { code: 'PROJECT_SUMMARY_GRAPH_CHANGED' }); },
  };
  return { options, calls, target, map };
}

test('paper collector deduplicates shared ancestry and guards the two asOf/target boundaries without authority', async () => {
  const f = fixture([fact(1), fact(2, [id(1)]), fact(3, [id(1)]), fact(4)], [id(2), id(3)]);
  const result = await collectPaperFacts(f.options);
  assert.deepEqual(result.facts.map(f => f.fact_id), [id(1), id(2), id(3)]); assert.equal(result.asOf, 'stable');
  assert.equal(f.calls.gets.length, 3); assert.equal(new Set(f.calls.gets).size, 3); assert.equal(f.calls.pages, 2); assert.equal(f.calls.guards, 2);
  assert.equal(Object.hasOwn(f.options, 'authority'), false); assert.equal(Object.hasOwn(f.options, 'ctx'), false);
});

test('paper collector retains exact 2048-fact limit, not a whole-graph count or a ten-fact selection rule', async () => {
  for (const size of [2048, 2049]) {
    const facts = Array.from({ length: size }, (_, i) => fact(i + 1, i ? [id(i)] : [])), f = fixture(facts, [id(size)]);
    if (size === 2048) assert.equal((await collectPaperFacts(f.options)).facts.length, 2048);
    else { await assert.rejects(collectPaperFacts(f.options), { code: 'PROJECT_PAPER_CLOSURE_TOO_LARGE' }); assert.equal(f.calls.gets.length, 2048); }
  }
});

test('paper collector retains the 1MiB canonical JSON byte boundary including Unicode/escaping accounting', async () => {
  const root = fact(1); root.markdown += '\n界\\"';
  const padding = 1024 * 1024 - Buffer.byteLength(JSON.stringify(root)); root.markdown += 'x'.repeat(padding);
  assert.equal(Buffer.byteLength(JSON.stringify(root)), 1024 * 1024);
  const exact = fixture([root], [id(1)]); assert.equal((await collectPaperFacts(exact.options)).facts.length, 1);
  const overflow = fixture([{ ...root, markdown: root.markdown + 'x' }], [id(1)]);
  await assert.rejects(collectPaperFacts(overflow.options), { code: 'PROJECT_PAPER_CLOSURE_TOO_LARGE' });
});

test('paper collector selection unions share one deduplicated exact fact and byte budget across all roots', async () => {
  const facts = Array.from({ length: 2047 }, (_, i) => fact(i + 1, i ? [id(i)] : []));
  facts.push(fact(2048, [id(1024)]));
  const exact = fixture(facts, [id(2047)]); exact.options.selectedFactIds = [id(2048)];
  assert.equal((await collectPaperFacts(exact.options)).facts.length, 2048); assert.equal(exact.calls.gets.length, 2048);
  const overflow = fixture([...facts, fact(2049, [id(1024)])], [id(2047)]); overflow.options.selectedFactIds = [id(2048), id(2049)];
  await assert.rejects(collectPaperFacts(overflow.options), { code: 'PROJECT_PAPER_CLOSURE_TOO_LARGE' }); assert.equal(overflow.calls.gets.length, 2048);
  const bytes = [fact(1), fact(2), fact(3, [id(2)])]; bytes[1].markdown += '界\\\\';
  bytes[1].markdown += 'x'.repeat(1024 * 1024 - bytes.reduce((n, f) => n + Buffer.byteLength(JSON.stringify(f)), 0));
  const accepted = fixture(bytes, [id(1)]); accepted.options.selectedFactIds = [id(3)];
  assert.equal((await collectPaperFacts(accepted.options)).facts.length, 3);
  bytes[1].markdown += 'x'; const rejected = fixture(bytes, [id(1)]); rejected.options.selectedFactIds = [id(3)];
  await assert.rejects(collectPaperFacts(rejected.options), { code: 'PROJECT_PAPER_CLOSURE_TOO_LARGE' });
});

test('paper collector refuses missing facts, cycles, headline digest drift, asOf drift and late target guard failure', async () => {
  const missing = fixture([fact(1, [id(2)])], [id(1)]);
  await assert.rejects(collectPaperFacts(missing.options), { code: 'PROJECT_CORE_INVALID_RESULT' });
  const cycle = fixture([fact(1, [id(2)]), fact(2, [id(1)])], [id(1)]);
  await assert.rejects(collectPaperFacts(cycle.options), { code: 'PROJECT_PAPER_CLOSURE_INVALID' });
  const hash = fixture([fact(1)], [id(1)]); hash.target.factDigests[id(1)] = '0'.repeat(64);
  await assert.rejects(collectPaperFacts(hash.options), { code: 'PROJECT_TARGET_FACT_CHANGED' });
  await assert.rejects(collectPaperFacts(fixture([fact(1)], [id(1)], { drift: true }).options), { code: 'PROJECT_SUMMARY_GRAPH_CHANGED' });
  const target = fixture([fact(1)], [id(1)], { guard: n => { if (n === 2) throw Object.assign(new Error('target changed'), { code: 'PROJECT_TARGET_CHANGED' }); } });
  await assert.rejects(collectPaperFacts(target.options), { code: 'PROJECT_TARGET_CHANGED' });
});
