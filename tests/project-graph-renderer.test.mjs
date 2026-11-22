import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { renderProjectGraph } from '../packages/hana-math/project-graph-renderer.mjs';

const A = '0000000000000001', B = '0000000000000002', C = '0000000000000003', M = 'ffffffffffffffff';
const fact = (id, predecessors = [], statementPreview = `Statement ${id}`) => ({ fact_id: id, predecessors,
  statementPreview, statementPreviewTruncated: false, canonicalBytes: 120 });
const snapshot = facts => ({ projectId: 'fixture-project', asOf: 'a'.repeat(64), capturedAt: 1700000000000, facts });

// Same dependency-free VM/control-fixture approach as ui.test.mjs. This fixture
// executes the actual embedded script and records DOM structure/events, not pixels.
function mount(input) {
  const html = renderProjectGraph(input);
  const elements = new Map();
  class Element {
    constructor(tag) { this.tagName = tag; this.attributes = new Map(); this.children = []; this.listeners = new Map(); this.value = ''; this.hidden = false; this._text = ''; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ''; this.children = [...children]; }
    addEventListener(type, listener) { const handlers = this.listeners.get(type) || []; handlers.push(listener); this.listeners.set(type, handlers); }
    emit(type, extra = {}) { const event = { target: this, button: 0, pointerId: 1, ...extra }; for (const listener of this.listeners.get(type) || []) listener(event); }
    click() { this.emit('click'); }
    select() { this.selectedText = true; }
    setPointerCapture(id) { this.capturedPointer = id; }
    getBoundingClientRect() { return { width: 1000, height: 520 }; }
  }
  // Register real template IDs, retaining attributes and tags for structural checks.
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    assert.ok(!elements.has(match[3]), `unique template ID ${match[3]}`);
    const node = new Element(match[1]);
    for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
    elements.set(match[3], node);
  }
  const data = /<script id="snapshot-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];
  elements.get('snapshot-data').textContent = data;
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2, 'exactly data plus one executable script');
  const document = { getElementById(id) { assert.ok(elements.has(id), `template has #${id}`); return elements.get(id); },
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
  // No host/network/storage APIs supplied: accidental dependencies fail execution.
  const globalEvents = new Map();
  const context = vm.createContext({ document, addEventListener(type, handler) { globalEvents.set(type, handler); } });
  vm.runInContext(scripts[1][1], context, { timeout: 5000 });
  const $ = id => elements.get(id);
  const buttons = id => $(id).children.map(li => li.children[0]).filter(Boolean);
  const node = id => $('nodes').children.find(item => item.getAttribute('data-fact-id') === id);
  const choose = id => buttons('node-list').find(button => button.getAttribute('data-fact-id') === id).click();
  return { html, $, buttons, node, choose, context, data, globalEvents };
}

test('portable document, explicit projection, deterministic ordering and no caller mutation', () => {
  const input = snapshot([fact(B, [A]), fact(A)]);
  input.privateBody = 'PRIVATE_BODY'; input.facts[0].proof = 'PRIVATE_PROOF';
  const before = JSON.stringify(input);
  const html = renderProjectGraph(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(html, renderProjectGraph({ ...input, facts: [...input.facts].reverse() }));
  assert.doesNotMatch(html, /PRIVATE_BODY|PRIVATE_PROOF|\/Users\/|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  assert.doesNotMatch(html, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|eval)\s*\(|window\.card|<script[^>]+src=|<link\b/i);
  assert.match(html, /connect-src 'none'/); assert.match(html, /<noscript>/);
  assert.match(html, /previews only/); assert.match(html, /Proof bodies are not included/);
  const f = mount(input);
  assert.match(f.$('metadata').textContent, /2023-11-14T22:13:20\.000Z/);
  assert.match(f.$('revision').textContent, new RegExp('a'.repeat(64)));
  assert.equal(f.$('graph').getAttribute('role'), 'img');
  assert.equal(f.$('filter').getAttribute('type'), 'search');
  assert.match(html, /<label for="filter">/); assert.match(html, /<input id="fact-id"[^>]*readonly/);
 });

test('hostile preview and project strings remain inert data, including script terminators and separators', () => {
  const attack = '</script><script>globalThis.pwned=true</script><img src=x onerror=alert(1)>&\u2028\u2029';
  const input = snapshot([fact(A, [], attack)]); input.projectId = attack;
  const f = mount(input);
  assert.doesNotMatch(f.data, /[<>&\u2028\u2029]/);
  assert.match(f.data, /\\u003c\/script\\u003e/);
  assert.equal(JSON.parse(f.data).facts[0].statementPreview, attack);
  assert.equal(f.$('preview').textContent, attack); assert.equal(f.$('preview').children.length, 0);
  assert.equal(f.context.pwned, undefined);
  assert.match(f.$('metadata').textContent, /globalThis\.pwned/);
  assert.equal(JSON.parse(f.$('proof-example').textContent).projectId, attack);
});

test('DAG edges go predecessor to dependent and nodes use deterministic relation layers', () => {
  const f = mount(snapshot([fact(C, [A, B]), fact(A), fact(B, [A])]));
  assert.deepEqual(f.$('edges').children.map(edge => [edge.getAttribute('data-source'), edge.getAttribute('data-target')]), [[A, B], [A, C], [B, C]]);
  assert.equal(f.node(A).getAttribute('transform'), 'translate(30 48)');
  assert.equal(f.node(B).getAttribute('transform'), 'translate(320 48)');
  assert.equal(f.node(C).getAttribute('transform'), 'translate(610 48)');
  assert.ok(f.$('edges').children.every(edge => edge.getAttribute('marker-end') === 'url(#arrow)'));
  assert.equal(f.$('warnings').textContent, '');
  assert.equal(f.$('fact-id').value, A, 'first fact is useful initial selection');
});

test('missing predecessors are visible navigable placeholders, never verified facts', () => {
  const f = mount(snapshot([fact(A, [M]), fact(B, [M])]));
  assert.equal(f.buttons('node-list').length, 3);
  assert.match(f.$('warnings').textContent, /1 predecessor\(s\) missing/);
  assert.match(f.$('summary').textContent, /2 verified facts.*1 missing placeholders/);
  assert.match(f.node(M).textContent, /Missing in snapshot/);
  f.buttons('predecessors')[0].click();
  assert.equal(f.$('fact-id').value, M); assert.match(f.$('selection-status').textContent, /placeholder/);
  assert.match(f.$('preview').textContent, /No statement/);
  assert.deepEqual(f.buttons('dependents').map(button => button.getAttribute('data-fact-id')), [A, B]);
  f.buttons('dependents')[1].click(); assert.equal(f.$('fact-id').value, B);
});

test('cycles and downstream nodes have explicit unlayered status without invented depth', () => {
  const f = mount(snapshot([fact(A, [B]), fact(B, [A]), fact(C, [B]), fact(M)]));
  assert.match(f.$('warnings').textContent, /Cycle detected\. 3 node\(s\) are unlayered/);
  const labels = f.$('nodes').children.filter(node => node.tagName === 'text').map(node => node.textContent);
  assert.deepEqual(labels, ['Relation layer 0', 'Unlayered · cycle / blocked']);
  assert.equal(f.node(A).getAttribute('transform'), 'translate(320 48)');
  assert.equal(f.node(B).getAttribute('transform'), 'translate(320 130)');
  assert.equal(f.node(C).getAttribute('transform'), 'translate(320 212)');
  assert.equal(f.$('edges').children.length, 3);
  const self = mount(snapshot([fact(A, [A])]));
  assert.match(self.$('warnings').textContent, /1 node\(s\) are unlayered/);
  assert.equal(self.$('edges').children.length, 1);
});

test('filter, native selection buttons, relation navigation and copyable result example', () => {
  const input = snapshot([fact(A, [], 'Alpha <b>literal</b>'), { ...fact(B, [A], 'Beta'), statementPreviewTruncated: true }]);
  const f = mount(input);
  f.$('filter').value = '  BETA '; f.$('filter').emit('input');
  assert.equal(f.$('node-list').children[0].hidden, true);
  assert.equal(f.$('node-list').children[1].hidden, false);
  assert.match(f.$('filter-count').textContent, /1 of 2/);
  assert.equal(f.$('edges').children.length, 1, 'filter does not hide graph relations');
  f.choose(B);
  assert.equal(f.$('fact-id').value, B); assert.equal(f.$('preview').textContent, 'Beta');
  assert.match(f.$('fact-meta').textContent, /120 canonical bytes.*preview truncated/);
  assert.deepEqual(JSON.parse(f.$('proof-example').textContent), { action: 'result', projectId: 'fixture-project', factId: B });
  assert.equal(f.buttons('node-list')[1].tagName, 'button', 'native keyboard activation');
  assert.equal(f.buttons('node-list')[1].getAttribute('aria-pressed'), 'true');
  f.buttons('predecessors')[0].click();
  assert.equal(f.$('fact-id').value, A); assert.equal(f.$('preview').textContent, 'Alpha <b>literal</b>');
  f.buttons('dependents')[0].click(); assert.equal(f.$('fact-id').value, B);
  f.$('fact-id').click(); assert.equal(f.$('fact-id').selectedText, true);
  f.$('filter').value = 'no-match'; f.$('filter').emit('input'); assert.match(f.$('filter-count').textContent, /0 of 2/);
  f.node(A).click(); assert.equal(f.$('fact-id').value, A);
});

test('zoom, reset and pointer pan change only local SVG view state', () => {
  const f = mount(snapshot([fact(A), fact(B, [A])]));
  const original = f.$('viewport').getAttribute('transform');
  f.$('zoom-in').click(); const zoomed = f.$('viewport').getAttribute('transform'); assert.notEqual(zoomed, original);
  f.$('zoom-out').click();
  const coordinates = value => value.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const restored = coordinates(f.$('viewport').getAttribute('transform'));
  coordinates(original).forEach((value, index) => assert.ok(Math.abs(restored[index] - value) < 1e-10, 'zoom round trip restores geometry within floating point precision'));
  f.$('graph').emit('pointerdown', { clientX: 20, clientY: 30 });
  f.$('graph').emit('pointermove', { clientX: 70, clientY: 80 });
  const panned = f.$('viewport').getAttribute('transform'); assert.notEqual(panned, original);
  f.$('graph').emit('pointerup');
  f.$('graph').emit('pointermove', { clientX: 90, clientY: 100 }); assert.equal(f.$('viewport').getAttribute('transform'), panned);
  f.$('reset').click(); assert.equal(f.$('viewport').getAttribute('transform'), original);
  f.$('zoom-in').click(); f.globalEvents.get('resize')();
  assert.equal(f.$('viewport').getAttribute('transform'), original, 'viewport changes refit the complete graph');
  for (let i = 0; i < 50; i++) f.$('zoom-in').click(); assert.equal(f.$('zoom-status').textContent, '400%');
  for (let i = 0; i < 80; i++) f.$('zoom-out').click(); assert.equal(f.$('zoom-status').textContent, '10%');
});

test('empty snapshot gives useful status with working view and filter controls', () => {
  const f = mount(snapshot([]));
  assert.match(f.$('summary').textContent, /0 verified facts/);
  assert.match(f.$('selection-status').textContent, /No verified facts/);
  assert.match(f.$('preview').textContent, /index is empty/);
  assert.equal(f.buttons('node-list').length, 0);
  assert.match(f.$('filter-count').textContent, /0 of 0/);
  f.$('zoom-in').click(); f.$('reset').click();
});

test('bounded maximum-size index retains every fact and relation without truncation', () => {
  const facts = Array.from({ length: 2048 }, (_, i) => fact(i.toString(16).padStart(16, '0')));
  // 16 cyclic predecessor relations per fact = exactly 32768; this is graph
  // layout validation on synthetic text fixtures, not mathematical execution.
  facts.forEach((f, i) => { f.predecessors = Array.from({ length: 16 }, (_, j) => facts[(i + j + 1) % facts.length].fact_id); });
  const f = mount(snapshot(facts));
  assert.equal(f.buttons('node-list').length, 2048); assert.equal(f.$('edges').children.length, 32768);
  assert.match(f.$('warnings').textContent, /2048 node\(s\) are unlayered/);
  f.choose(facts.at(-1).fact_id); assert.equal(f.$('fact-id').value, facts.at(-1).fact_id);
});

test('basic malformed shape is rejected explicitly', () => {
  for (const input of [null, {}, { ...snapshot([]), asOf: 'bad' }, { ...snapshot([]), capturedAt: Infinity },
    snapshot([fact('bad')]), snapshot([fact(A), fact(A)]), snapshot([{ ...fact(A), predecessors: ['bad'] }]),
    snapshot([{ ...fact(A), canonicalBytes: 0 }])]) assert.throws(() => renderProjectGraph(input), TypeError);
});
