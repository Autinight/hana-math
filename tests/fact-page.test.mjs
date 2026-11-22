// Pure software DTO/cursor checks, not mathematical validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { factPageOptions, validateFactPage } from '../packages/hana-math/fact-page.mjs';
import { fixtureFactPage } from './fact-page-fixture.mjs';
const project = 'project-fixture';
const rows = Array.from({ length: 5 }, (_, i) => ({ fact_id: i.toString(16).padStart(16, '0'), predecessors: [] }));
// Fixture producers use canonical key order; noncanonical wire tests use raw text.
const encode = v => Buffer.from(JSON.stringify(v, Object.keys(v).sort())).toString('base64url');
const first = () => fixtureFactPage(rows, { limit: 2 }, project);
const decoded = () => JSON.parse(Buffer.from(first().page.nextCursor, 'base64url'));
const bad = fn => assert.throws(fn, e => /^FACT_(?:PAGE_INVALID_INPUT|RESULT_INVALID)$/.test(e.code));

const codecText = JSON.stringify({ asOf: 'a'.repeat(64), limit: 2, offset: 1, projectId: project, v: 1 });
const codecVariants = [
  ['escaped duplicate after', codecText.slice(0, -1) + ',"\\u0076":1}'],
  ['escaped duplicate before', codecText.replace('"v":1', '"\\u0076":1,"v":1')],
  ['escaped single key', codecText.replace('"v":1', '"\\u0076":1')],
  ['escaped project key', codecText.replace('"projectId"', '"project\\u0049d"')],
  ['escaped project value', codecText.replace('project-fixture', 'project\\u002dfixture')],
  ['escaped asOf value', codecText.replace('"asOf":"a', '"asOf":"\\u0061')],
  ['leading whitespace', ' ' + codecText], ['trailing whitespace', codecText + '\n'],
  ['internal whitespace', codecText.replace(/,/g, ', ')],
  ['key order', JSON.stringify({ v: 1, projectId: project, offset: 1, limit: 2, asOf: 'a'.repeat(64) })],
  ...[['v', '1e0'], ['v', '1.0'], ['limit', '2e0'], ['limit', '2.0'], ['offset', '1e0'], ['offset', '1.0'], ['offset', '-0']]
    .map(([key, value]) => [`${key} ${value}`, codecText.replace(`"${key}":${key === 'limit' ? 2 : 1}`, `"${key}":${value}`)]),
];
for (const [name, raw] of codecVariants) test(`canonical codec rejects ${name}`, () => {
  assert.throws(() => factPageOptions({ cursor: Buffer.from(raw).toString('base64url') }, { projectId: project }), { code: 'FACT_PAGE_INVALID_INPUT' });
});
test('fixture and safe-integer codec positives keep the Python producer byte contract', () => {
  const actual = first().page.nextCursor, data = JSON.parse(Buffer.from(actual, 'base64url'));
  assert.equal(Buffer.from(actual, 'base64url').toString(), JSON.stringify({ asOf: data.asOf, limit: data.limit, offset: data.offset, projectId: data.projectId, v: data.v }));
  assert.deepEqual(factPageOptions({ cursor: actual }, { projectId: project }), { cursor: actual });
  for (const offset of [0, 1, Number.MAX_SAFE_INTEGER]) for (const limit of [1, 64]) {
    const value = encode({ v: 1, projectId: project, offset, limit, asOf: 'a'.repeat(64) });
    assert.deepEqual(factPageOptions({ cursor: value }, { projectId: project }), { cursor: value });
  }
});

test('stable traversal, inherited limit, last page is not whole-response coverage', () => {
  let options = { limit: 2 }, found = [], observation;
  for (;;) {
    const raw = fixtureFactPage(rows, options, project), value = validateFactPage(raw, project, options);
    assert.deepEqual(value, raw); assert.notEqual(value, raw); assert.notEqual(value.page, raw.page);
    assert.equal(value.page.startIndex, found.length); if (observation) assert.equal(value.page.asOf, observation);
    observation = value.page.asOf; found.push(...value.facts.map(r => r.fact_id));
    assert.equal(value.page.allFactsIncluded, false);
    if (!value.page.hasMore) break;
    options = { cursor: value.page.nextCursor };
  }
  assert.deepEqual(found, rows.map(r => r.fact_id));
  assert.equal(validateFactPage(fixtureFactPage([], {}, project), project).page.allFactsIncluded, true);
  assert.equal(validateFactPage(fixtureFactPage(rows, {}, project), project).page.allFactsIncluded, true);
});
for (const limit of [0, 65, -1, 1.1, true, null, '1', NaN, Infinity]) test(`invalid options limit ${String(limit)}`, () => bad(() => factPageOptions({ limit })));
for (const patch of [{ v: 2 }, { projectId: 'project-other' }, { asOf: 'a'.repeat(63) }, { offset: -1 }, { offset: 2 ** 53 },
  { offset: true }, { limit: 65 }, { extra: 'PRIVATE_PATH' }]) test(`cursor scalar/project rejection ${JSON.stringify(patch)}`, () => {
  bad(() => factPageOptions({ cursor: encode({ ...decoded(), ...patch }) }, { projectId: project }));
});
for (const token of ['', 'A', 'a'.repeat(1025), 'a=b', '😀', 'AAAA\n', encode({}),
  Buffer.from('{"v":1,"v":1,"projectId":"project-fixture","asOf":"' + 'a'.repeat(64) + '","offset":1,"limit":2}').toString('base64url')]) {
  test(`malformed cursor ${token.slice(0, 24)}`, () => bad(() => factPageOptions({ cursor: token })));
}
test('limit mismatch/full get options/unknown keys rejected without evaluating accessors', () => {
  const token = first().page.nextCursor;
  bad(() => factPageOptions({ cursor: token, limit: 3 }));
  bad(() => factPageOptions({ limit: 1 }, { factId: 'a'.repeat(16) }));
  bad(() => factPageOptions({ projectId: project }));
  assert.deepEqual(factPageOptions({}, { factId: 'a'.repeat(16) }), {});
  const getter = Object.defineProperty({}, 'limit', { enumerable: true, get() { assert.fail('getter executed'); } });
  bad(() => factPageOptions(getter)); bad(() => factPageOptions(new Proxy({}, { get() { assert.fail('proxy read'); } })));
  const options = { limit: 2 }, copy = factPageOptions(options); options.limit = 64; assert.equal(copy.limit, 2);
});
const mutations = {
  missingPage: v => delete v.page,
  extraRoot: v => { v.markdown = 'PRIVATE'; },
  extraPage: v => { v.page.privatePath = 'PRIVATE'; },
  version: v => { v.page.version = true; },
  snapshot: v => { v.page.asOf += '\n'; },
  negativeTotal: v => { v.page.total = -1; },
  unsafeTotal: v => { v.page.total = 2 ** 53; },
  start: v => { v.page.startIndex = 1; },
  returned: v => { v.page.returned++; },
  limit: v => { v.page.limit = 1; },
  more: v => { v.page.hasMore = false; },
  whole: v => { v.page.allFactsIncluded = true; },
  preview: v => { v.page.previewOnly = false; },
  cursorMissing: v => { v.page.nextCursor = null; },
  cursorOffset: v => { v.page.nextCursor = encode({ ...decoded(), offset: 3 }); },
  cursorSnapshot: v => { v.page.nextCursor = encode({ ...decoded(), asOf: 'b'.repeat(64) }); },
  cursorLimit: v => { v.page.nextCursor = encode({ ...decoded(), limit: 3 }); },
  cursorProject: v => { v.page.nextCursor = encode({ ...decoded(), projectId: 'other' }); },
  duplicate: v => { v.facts[1] = structuredClone(v.facts[0]); },
  unsorted: v => { v.facts.reverse(); },
  badId: v => { v.facts[0].fact_id += '\n'; },
  missingPreview: v => { delete v.facts[0].statementPreview; },
  proofLeak: v => { v.facts[0].markdown = 'PRIVATE'; },
  unicodeLimit: v => { v.facts[0].statementPreview = '界'.repeat(171); },
  surrogate: v => { v.facts[0].statementPreview = '\ud800'; },
  nul: v => { v.facts[0].statementPreview = '\0'; },
  truncationType: v => { v.facts[0].statementPreviewTruncated = 1; },
  canonicalLimit: v => { v.facts[0].canonicalBytes = (1 << 20) + 1; },
  canonicalUnderPreview: v => { v.facts[0].canonicalBytes = 1; },
  badPredecessor: v => { v.facts[0].predecessors = ['x']; },
  duplicatePredecessor: v => { v.facts[0].predecessors = ['a'.repeat(16), 'a'.repeat(16)]; },
  densePredecessor: v => { v.facts[0].predecessors = Array.from({ length: 129 }, (_, i) => i.toString(16).padStart(16, '0')); },
  sparse: v => { delete v.facts[1]; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`DTO rejects ${name}`, () => {
  const value = first(); mutate(value); bad(() => validateFactPage(value, project, { limit: 2 }));
});
test('actual escaping/continuation byte budget, predecessors retained', () => {
  const dense = Array.from({ length: 64 }, (_, i) => ({ fact_id: i.toString(16).padStart(16, '0'),
    predecessors: Array.from({ length: 128 }, (_, j) => (j + 1000).toString(16).padStart(16, '0')) }));
  const value = fixtureFactPage(dense, {}, project); assert.ok(value.page.returned < 64);
  assert.equal(validateFactPage(value, project).facts[0].predecessors.length, 128);
  const tooBig = fixtureFactPage(Array.from({ length: 64 }, (_, i) => ({ fact_id: i.toString(16).padStart(16, '0'), predecessors: [] })), {}, project);
  for (const row of tooBig.facts) { row.statementPreview = '\t'.repeat(512); row.canonicalBytes = 1000; row.statementPreviewTruncated = true; }
  assert.ok(Buffer.byteLength(JSON.stringify(tooBig)) > 16384); bad(() => validateFactPage(tooBig, project));
});
