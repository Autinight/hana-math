// Same test bytes run against both Git-frozen originals and the patch.
// Minimal DOM, actual theme.js/app.js/workspace-monitor.mjs; no Host or SDK credential.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.SIGMA_TEST_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
assert.ok(path.isAbsolute(root));
const themeURL = pathToFileURL(path.join(root, 'packages/hana-math/ui/dashboard/theme.js'));
const idle = '当前没有正在推进的研究';
const notReady = '研究状态暂不可用 · SDK 未就绪，尚未发请求';
const pending = '正在确认研究状态';
const injected = new Error('synthetic readiness / theme failure');
const interval = 8_000; // Existing workspace monitor cadence.
const projectId = 'fixture-project', generation = 'fixture-generation';
const currentPath = '/workspace-monitor/current', overviewPath = '/workspace-monitor/api/overview';
let instance = 0;

async function fixture(t, { ready, themeRead, themeSubscribe, initiallyHidden = false, facts, discovery } = {}) {
  const elements = new Map(), window = new EventTarget(), document = new EventTarget();
  const node = () => ({ dataset: {}, textContent: '', children: [], style: {},
    appendChild(child) { this.children.push(child); }, replaceChildren(...children) { this.textContent = ''; this.children = children; }, remove() {} });
  Object.assign(document, { hidden: initiallyHidden, body: node(), documentElement: { style: { removeProperty(k) { delete this[k]; } } },
    createElement: node, querySelectorAll: () => [], querySelector(selector) {
      if (selector === '.nav-link.active') return null;
      if (!elements.has(selector)) elements.set(selector, node());
      return elements.get(selector);
    }, head: { appendChild() {} } });
  const globals = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window, document });
  // Advance one deadline at a time and flush the real async continuations.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const advance = async ms => { t.mock.timers.tick(ms); await flush(); };
  let sdk = 0, reads = 0, subscribes = 0, unsubscribes = 0, contexts = 0;
  const requests = [], events = [];
  const hana = { ready() { sdk++; return ready?.(sdk); },
    theme: { getSnapshot() { ++reads; return themeRead ? themeRead() : { appearance: 'light' }; },
      subscribe(callback) { ++subscribes; themeSubscribe?.(callback); return () => { ++unsubscribes; }; } },
    api: { async fetch(url, options) {
      const { signal, ...init } = options;
      requests.push({ url, ...init, aborted: signal.aborted });
      assert.equal(options.method, 'GET'); assert.equal(signal.aborted, false);
      if (url === currentPath) {
        assert.equal(options.headers, undefined);
        return Response.json(discovery?.() ?? (facts ? { state: 'active', projectId, generation } : { state: 'idle' }));
      }
      assert.equal(url, overviewPath); assert.equal(typeof facts, 'function');
      assert.deepEqual(options.headers, { 'x-hana-math-monitor-generation': generation });
      return Response.json({ project: projectId, facts: facts(), facts_with_predecessors: 0,
        facts_by_author: {}, channel_counts: {}, verdicts: {}, updated_at: 1 });
    } }, document: { async getContext() { contexts++; return null; } } };
  const { startDashboard } = await import(themeURL.href + `?fixture=${++instance}`);
  const page = (name, persisted = false) => window.dispatchEvent(Object.assign(new Event(name), { persisted }));
  const vis = hidden => { document.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
  const measure = label => {
    const el = document.querySelector('#landing-state');
    const row = { label, ready: sdk, get: requests.length, state: el.dataset.monitorState ?? null, text: el.textContent,
      themeReads: reads, subscriptions: subscribes, unsubscribes, contexts, appearance: document.documentElement.style.colorScheme ?? null };
    events.push(row); return row;
  };
  t.after(() => { page('pagehide'); t.diagnostic(JSON.stringify(events)); Object.assign(globalThis, globals); });
  return { start: (opts = { workspaceMonitor: true }) => startDashboard(hana, opts), page, vis, measure, advance, requests, hana, document };
}
function expect(row, counts, text) {
  assert.deepEqual([row.ready, row.get], counts, row.label);
  if (text !== undefined) assert.equal(row.text, text, row.label);
}

test('saved workspace overview labels the reading basis instead of an end time', async t => {
  const asOf = Date.parse('2026-01-02T03:04:05.678Z');
  let target = { state: 'saved', projectId, generation, asOf };
  const f = await fixture(t, { facts: () => 1, discovery: () => target });
  await f.start(); await flush();
  assert.equal(f.measure('saved').state, 'saved');
  assert.equal(f.document.querySelector('#landing-state').textContent, '当前已保存结果（只读）');
  assert.equal(f.document.querySelector('#refresh-note').textContent, '读取基准时间 2026-01-02T03:04:05.678Z');
  assert.deepEqual(f.requests.map(row => row.url), [currentPath, overviewPath, currentPath]);
  target = { state: 'active', projectId, generation };
  await f.advance(interval);
  assert.equal(f.measure('active').state, 'active');
  assert.doesNotMatch(f.document.querySelector('#refresh-note').textContent, /读取基准时间|结束时间/);
});

test('healthy mount and genuine visibility edge do not duplicate ready or GET; close stops them', async t => {
  const f = await fixture(t); await f.start(); await flush();
  expect(f.measure('initial'), [1, 1], idle);
  f.vis(false); f.vis(false); await flush(); expect(f.measure('duplicate visible'), [1, 1], idle);
  f.vis(true); await flush(); expect(f.measure('hidden'), [1, 1], pending);
  f.vis(false); f.vis(false); await flush(); expect(f.measure('visible again'), [1, 2], idle);
  f.page('pagehide'); f.vis(true); f.vis(false); f.page('pageshow');
  t.mock.timers.tick(90_000); await flush(); expect(f.measure('closed'), [1, 2]);
});

test('an always-visible Σ retries once after 8 seconds, then the existing monitor alone refreshes 0 → 1', async t => {
  let facts = 0;
  const f = await fixture(t, { ready: n => n === 1 ? Promise.reject(injected) : undefined, facts: () => facts });
  await f.start(); await flush();
  expect(f.measure('SDK rejects before any read'), [1, 0], notReady);
  await f.advance(interval - 1);
  expect(f.measure('visible without interaction: just before first retry'), [1, 0], notReady);
  await f.advance(1);
  const first = f.measure('visible without interaction: retry mounts the active monitor');
  expect(first, [2, 3], '正在跟踪研究');
  assert.equal(first.state, 'active');
  assert.deepEqual([first.themeReads, first.subscriptions], [1, 1]);
  const count = () => f.document.querySelector('#ov-cards').children[0]?.children[1]?.textContent;
  assert.equal(f.document.querySelector('#project-badge').textContent, projectId);
  assert.equal(count(), '0');
  facts = 1;
  await f.advance(interval - 1);
  assert.equal(count(), '0'); expect(f.measure('normal poll has not fired'), [2, 3]);
  await f.advance(1);
  assert.equal(count(), '1');
  expect(f.measure('same mounted overview updates on the normal poll'), [2, 6], '正在跟踪研究');
  const get = url => ({ url, method: 'GET', cache: 'no-store', aborted: false });
  const cycle = [get(currentPath), { ...get(overviewPath), headers: { 'x-hana-math-monitor-generation': generation } }, get(currentPath)];
  assert.deepEqual(f.requests, [...cycle, ...cycle], 'only current → overview → final current through the existing SDK transport');
});

test('persistent SDK failure stays on the 8-second cadence; a real visibility edge alone retries early', async t => {
  const f = await fixture(t, { ready() { throw injected; } });
  await f.start(); await flush(); expect(f.measure('first synchronous failure'), [1, 0], notReady);
  for (const attempt of [1, 2]) {
    await f.advance(interval - 1);
    f.vis(false); f.vis(false); await flush();
    expect(f.measure(`no early retry or extra visible-edge call after attempt ${attempt}`), [attempt, 0], notReady);
    await f.advance(1);
    expect(f.measure(`exactly one scheduled retry after attempt ${attempt}`), [attempt + 1, 0], notReady);
  }
  await f.advance(2_000);
  f.vis(true); f.vis(true); await f.advance(9_000);
  expect(f.measure('hidden across the armed deadline'), [3, 0], notReady);
  f.vis(false); f.vis(false); await flush();
  expect(f.measure('first genuine show retries immediately, only once'), [4, 0], notReady);
  await f.advance(interval - 1); expect(f.measure('no old deadline after show'), [4, 0], notReady);
  await f.advance(1); expect(f.measure('visible retries on its fresh deadline'), [5, 0], notReady);
});

test('a pending timed retry is single-flight across elapsed intervals and visibility edges', async t => {
  const late = Promise.withResolvers();
  const f = await fixture(t, { ready(n) { if (n === 1) throw injected; return late.promise; } });
  await f.start(); await f.advance(interval);
  expect(f.measure('timed retry has started and is pending'), [2, 0]);
  for (let i = 0; i < 3; i++) {
    f.vis(true); f.vis(false); await f.advance(interval);
    expect(f.measure(`unresolved retry is not duplicated (${i + 1})`), [2, 0]);
  }
  late.resolve(); await flush(); expect(f.measure('one monitor is installed when retry resolves'), [2, 1], idle);
  await f.advance(interval); expect(f.measure('post-recovery monitor poll does not call ready again'), [2, 2], idle);
});

test('pagehide retires the old startup deadline; a persisted resume owns a fresh one', async t => {
  const f = await fixture(t, { ready(n) { if (n <= 2) throw injected; } });
  await f.start(); await f.advance(2_000);
  f.page('pagehide', true);
  await f.advance(1_000);
  f.page('pageshow', true); f.page('pageshow', true); await flush();
  expect(f.measure('persisted resume failed once and owns a new deadline'), [2, 0], notReady);
  await f.advance(5_000);
  expect(f.measure('old deadline cannot act on the restored page'), [2, 0], notReady);
  await f.advance(2_999); expect(f.measure('new deadline has not fired early'), [2, 0], notReady);
  await f.advance(1); expect(f.measure('only the new deadline recovers'), [3, 1], idle);
});

for (const part of ['theme read', 'theme subscribe']) test(`${part} exception does not block the known idle response at initial mount`, async t => {
  let fail = true;
  const f = await fixture(t, part === 'theme read'
    ? { themeRead() { if (fail) throw injected; }, themeSubscribe(callback) { callback({ appearance: 'dark' }); } }
    : { themeRead: () => undefined, themeSubscribe() { if (fail) throw injected; } });
  let error; await f.start().catch(e => { error = e; }); await flush();
  const first = f.measure('initial without any visibility change');
  // Preserve the evidence if the old implementation never builds a monitor.
  fail = false; f.vis(true); f.vis(false); await flush(); const next = f.measure('ordinary hide/show');
  assert.equal(error, undefined); expect(first, [1, 1], idle); assert.equal(first.state, 'idle'); assert.equal(first.appearance, null);
  expect(next, [1, 2], idle); assert.equal(next.themeReads, 1); assert.equal(next.subscriptions, 1);
});

test('unresolved setup stays single-flight; resolving while hidden cannot GET until visible', async t => {
  const late = Promise.withResolvers(), f = await fixture(t, { ready: () => late.promise });
  const first = f.start(); f.vis(true); f.vis(false); f.vis(true); await flush(); expect(f.measure('ready pending, repeated edges'), [1, 0]);
  late.resolve(); await first; await flush(); expect(f.measure('ready resolves while hidden'), [1, 0], pending);
  f.vis(false); f.vis(false); await flush(); expect(f.measure('same mount becomes visible'), [1, 1], idle);
});

for (const outcome of ['resolve', 'reject']) test(`pagehide revokes late ${outcome}; adjacent persisted pageshow starts exactly once`, async t => {
  const late = Promise.withResolvers(), f = await fixture(t, { ready: n => n === 1 ? late.promise : undefined });
  const first = f.start(); f.page('pagehide', true); f.vis(true); f.vis(false); await flush();
  expect(f.measure('suspended before SDK completion'), [1, 0]);
  f.page('pageshow', true); f.page('pageshow', true); await flush();
  const restored = f.measure('adjacent persisted shows');
  late[outcome](outcome === 'reject' ? injected : undefined); await first; await flush();
  const settled = f.measure('stale completion after restore');
  f.page('pageshow', true); await flush();
  const repeated = f.measure('repeated persisted show after healthy restore');
  expect(restored, [2, 1], idle); expect(settled, [2, 1], idle); expect(repeated, [2, 1], idle);
  assert.deepEqual([settled.themeReads, settled.subscriptions, settled.unsubscribes], [1, 1, 0]);
});

test('replacement disposes failed workspace startup; ordinary card and preview use original paths', async t => {
  const f = await fixture(t, { ready(n) { if (n === 1) throw injected; } });
  await f.start(); expect(f.measure('workspace failed'), [1, 0], notReady);
  await f.start({}); f.vis(true); f.vis(false); await f.advance(interval);
  expect(f.measure('ordinary card did not adopt workspace retry'), [2, 0]);
  assert.equal(f.document.querySelector('#conn-banner').textContent, 'Dashboard is not bound to a project.');
  await f.start({ workspaceMonitor: true, documentPreview: true });
  f.vis(true); f.vis(false); await flush();
  const preview = f.measure('snapshot Preview remains unbound with no monitor');
  expect(preview, [3, 0]); assert.equal(preview.contexts, 1);
  assert.equal(f.document.querySelector('#conn-banner').textContent, '请在 Hana 中打开 .hanamathgraph 附件。此视图未绑定文档。');
  await f.start({ workspaceMonitor: true, livePreview: true }); await flush();
  const live = f.measure('live Preview does not adopt workspace retry');
  expect(live, [4, 0]); assert.equal(live.contexts, 1);
});

for (const [label, options] of [
  ['ordinary card', {}], ['snapshot Preview', { workspaceMonitor: true, documentPreview: true }],
  ['live Preview', { workspaceMonitor: true, livePreview: true }],
]) test(`${label} does not adopt the disposed workspace timer or schedule an SDK retry of its own`, async t => {
  const f = await fixture(t, { ready() { return Promise.reject(injected); } });
  await f.start(); await f.advance(2_000);
  await f.start(options);
  f.vis(true); f.vis(false); await flush();
  expect(f.measure('replacement has one failed attempt and no route activity'), [2, 0]);
  for (let i = 0; i < 3; i++) await f.advance(interval);
  expect(f.measure('neither the old workspace timer nor a replacement retry fired'), [2, 0]);
});

test('a synchronous theme replay does not hide an unrelated renderer exception', async t => {
  const f = await fixture(t, { themeSubscribe(callback) { callback({ appearance: 'dark', cssUrl: '/fixture.css' }); } });
  f.document.head.appendChild = () => { throw injected; };
  await assert.rejects(f.start(), error => error === injected);
  expect(f.measure('renderer exception propagated outside subscription'), [1, 0]);
});

test('a non-theme startup error still propagates', async t => {
  const f = await fixture(t);
  Object.defineProperty(f.hana.api, 'fetch', { get() { throw injected; } });
  await assert.rejects(f.start(), error => error === injected);
  f.vis(true); f.vis(false); await flush(); expect(f.measure('non-theme transport failure'), [1, 0]);
});
