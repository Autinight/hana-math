import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

const ui = new URL('../packages/hana-math/ui/', import.meta.url);
const html = readFileSync(new URL('panel.html', ui), 'utf8');
const source = readFileSync(new URL('assets/panel.js', ui), 'utf8');

test('settings retains its panel and has no research dashboard entry, status or card navigation', () => {
  assert.match(html, /<main id="math-panel" data-hana-app-ui><\/main>/);
  const oldEntry = /研究看板|open-research-dashboard|research-dashboard-status|research-dashboard/;
  assert.doesNotMatch(html, oldEntry);
  assert.doesNotMatch(source, oldEntry);
  assert.doesNotMatch(source, /\bhana\s*(?:\?\.|\.)\s*cards\b/);
});

test('settings still mounts through its own API and restores on pageshow without opening a card', async () => {
  const root = { replaceChildren() {} };
  const window = new EventTarget();
  const document = {
    getElementById: id => id === 'math-panel' ? root : null,
    documentElement: { style: { removeProperty() {} } },
  };
  const apiCalls = [];
  const cardCalls = [];
  const mounted = [];
  const ready = Promise.withResolvers();
  const hana = {
    ready: () => ready.promise,
    theme: { getSnapshot: () => ({}), subscribe: () => () => {} },
    api: { fetch: (...args) => { apiCalls.push(args); } },
    cards: { open: (...args) => { cardCalls.push(args); } },
  };
  function mountMathPanel(element, { request }) {
    const view = { element, request, destroyed: false, destroy() { this.destroyed = true; } };
    mounted.push(view);
    return view;
  }
  const script = source.replace(/^import [^\n]+\n/gm, '');
  runInNewContext(script, { window, document, hana, mountMathPanel }, { filename: 'panel.js' });
  assert.equal(mounted.length, 0);
  ready.resolve();
  await turn();
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].element, root);
  mounted[0].request('/panel', { method: 'GET' });
  assert.deepEqual(apiCalls, [['/panel', { method: 'GET' }]]);
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(mounted[0].destroyed, true);
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  await turn();
  assert.equal(mounted.length, 2);
  assert.equal(mounted[1].element, root);
  assert.deepEqual(cardCalls, []);
});
