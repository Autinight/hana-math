// Only SDK/network software fixtures, never real HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiteratureService } from '../packages/hana-math/literature-service.mjs';
function fixture(fetch = async () => new Response('[]')) {
  const calls = [];
  const service = createLiteratureService({ network: { fetch: (...args) => { calls.push(args); return fetch(...args); } } });
  return { service, calls };
}
test('single fixed POST endpoint, original Danus protocol and exact theorem fidelity', async () => {
  const item = { title: 'Original', theorem: '  ∀ x,\n\\alpha(x) = x.  ', arxiv_id: '1234.5678', theorem_id: 'Lemma 2' };
  const f = fixture(async () => new Response(JSON.stringify([item])));
  assert.deepEqual(await f.service.search('  query  ', 3), { query: 'query', count: 1, results: [item], endpoint: 'https://leansearch.net/thm/search' });
  const [url, init] = f.calls[0]; assert.equal(url, 'https://leansearch.net/thm/search'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.timeoutMs, 20000); assert.equal(init.maxResponseBytes, 1 << 20);
  assert.equal(init.headers.Accept, 'application/json'); assert.equal(init.headers['User-Agent'], 'danus/1.0 (+https://frenzymath.com)');
  assert.deepEqual(JSON.parse(init.body), { query: 'query', task: 'Given a math statement, retrieve useful references, such as theorems, lemmas, and definitions, that are useful for solving the given problem.', num_results: 3 });
});
test('strict input bounds do not reach network', async () => {
  const f = fixture();
  for (const [q, n] of [['', 1], [null, 1], ['x'.repeat(16385), 1], ['x', 0], ['x', 101], ['x', 1.5], ['x', '2']]) {
    const result = await f.service.search(q, n); assert.ok(result.error); assert.deepEqual(result.results, []);
  }
  assert.equal(f.calls.length, 0);
});
test('denied, HTTP, malformed JSON, schema and size errors are not empty successes', async () => {
  for (const fetch of [
    async () => { throw Object.assign(new Error('not granted'), { code: 'APP_CAPABILITY_DENIED' }); },
    async () => new Response('blocked', { status: 403 }),
    async () => new Response('{'),
    async () => new Response('{}'),
    async () => new Response('[null]'),
    async () => new Response('[{"theorem":4}]'),
    async () => new Response(JSON.stringify(Array(11).fill({ theorem: 'x' }))),
    async () => new Response('[]', { headers: { 'content-length': '1048577' } }),
    async () => new Response(JSON.stringify([{ theorem: 'a'.repeat(1 << 20) }])),
  ]) {
    const f = fixture(fetch); const result = await f.service.search('x');
    assert.ok(result.error); assert.equal(result.count, 0); assert.deepEqual(result.results, []);
    assert.equal(result.endpoint, 'https://leansearch.net/thm/search');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'https://leansearch.net/thm/search');
  }
});
test('missing fields normalize to empty strings; no truncation of valid large theorem', async () => {
  const theorem = '原文\n'.repeat(50000);
  const f = fixture(async () => new Response(JSON.stringify([{ theorem }])));
  const result = await f.service.search('x'); assert.equal(result.results[0].theorem, theorem); assert.equal(result.results[0].title, '');
  assert.equal((await fixture().service.search('x')).error, undefined);
});
test('host cancellation before fetch and while reading is explicit', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture();
  assert.match((await f.service.search('x', 10, { signal: controller.signal })).error, /cancelled/); assert.equal(f.calls.length, 0);
  const other = new AbortController(); let resolve; const started = new Promise((r) => { resolve = r; }); let cancelled = false;
  const g = fixture(async () => new Response(new ReadableStream({ start() { resolve(); }, cancel() { cancelled = true; } })));
  const pending = g.service.search('x', 10, { signal: other.signal }); await started; other.abort();
  assert.match((await pending).error, /cancelled/); await new Promise((r) => setImmediate(r)); assert.equal(cancelled, true);
});
test('20-second host deadline returns explicit error without waiting for fetch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => new Promise(() => {}));
  const pending = f.service.search('x');
  await Promise.resolve();
  t.mock.timers.tick(20000);
  const result = await pending;
  assert.match(result.error, /timeout/); assert.deepEqual(result.results, []);
  assert.equal(f.calls[0][1].signal.aborted, true);
});
test('late fetch body is cancelled rather than consumed after cancellation', async () => {
  let resolve, started; const ready = new Promise((r) => { started = r; });
  const f = fixture(() => { started(); return new Promise((r) => { resolve = r; }); });
  const controller = new AbortController(); const pending = f.service.search('x', 10, { signal: controller.signal }); await ready; controller.abort();
  assert.ok((await pending).error); let cancelled = false;
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise((r) => setImmediate(r)); assert.equal(cancelled, true);
});
