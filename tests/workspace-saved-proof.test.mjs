// Software DOM + chart stubs, real registered workspace routes, monitor and app view.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as flush } from 'node:timers/promises';

const root = process.env.SIGMA_TEST_ROOT ? pathToFileURL(path.resolve(process.env.SIGMA_TEST_ROOT) + '/') : new URL('../', import.meta.url);
const appFile = name => new URL(`packages/hana-math/${name}`, root);
const { registerWorkspaceDashboardRoutes } = await import(appFile('workspace-dashboard-routes.mjs'));
const { mountWorkspaceDashboard } = await import(appFile('ui/dashboard/app.js'));
const { createWorkspaceMonitor } = await import(appFile('ui/dashboard/workspace-monitor.mjs'));

class Node {
  children = []; dataset = {}; style = {}; className = ''; parentNode = null; text = '';
  classList = {
    contains: name => this.className.split(/\s+/).includes(name),
    toggle: (name, on) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      if (on ?? !set.has(name)) set.add(name); else set.delete(name);
      this.className = [...set].join(' ');
    },
    add: name => this.classList.toggle(name, true),
  };
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this.replaceChildren(); this.text = String(text); }
  append(...children) { for (const child of children) this.appendChild(typeof child === 'string' ? Object.assign(new Node(), { text: child }) : child); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, at) { child.remove(); child.parentNode = this; this.children.splice(at ? this.children.indexOf(at) : this.children.length, 0, child); return child; }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...children); }
  remove() { const parent = this.parentNode; if (parent) parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null; }
  querySelector(selector) { return this.children.find(child => child.classList.contains(selector.slice(1))) ?? this.children.map(child => child.querySelector(selector)).find(Boolean); }
  setAttribute() {}
}

function dom() {
  const tabs = ['overview', 'graph', 'memory'];
  const links = tabs.map(tab => Object.assign(new Node(), { dataset: { tab }, className: tab === 'overview' ? 'active' : '' }));
  const panels = tabs.map(tab => Object.assign(new Node(), { id: `tab-${tab}` }));
  const elements = new Map(), document = new EventTarget(), window = new EventTarget();
  Object.assign(document, { hidden: false, body: new Node(), createElement(tag) {
    return tag === 'canvas' ? { getContext: () => ({ clearRect() {}, fillRect() {}, getImageData: () => ({ data: [0, 0, 0, 255] }) }) } : new Node();
  }, createTextNode: text => Object.assign(new Node(), { text }),
  querySelectorAll: selector => selector === '.nav-link' ? links : selector === '.tab' ? panels : [],
  querySelector(selector) {
    if (selector === '.nav-link.active') return links.find(link => link.classList.contains('active'));
    if (!elements.has(selector)) elements.set(selector, new Node());
    return elements.get(selector);
  } });
  const prior = Object.fromEntries(['document', 'window', 'getComputedStyle', 'echarts'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document, window, getComputedStyle: () => ({ getPropertyValue: () => '#000' }),
    echarts: { init: () => ({ setOption() {}, resize() {}, on() {}, off() {}, dispose() {} }) } });
  return { document, window, restore: () => Object.assign(globalThis, prior) };
}

test('saved verification click waits for recheck and opens the exact fact despite a shared prefix', async t => {
  const { document, window, restore } = dom(), read = selector => document.querySelector(selector);
  let monitor, view;
  t.after(() => { try { monitor?.dispose(); view?.dispose(); } finally { restore(); } });
  const scope = { state: 'saved', projectId: 'project-fixture', generation: 'saved-generation', asOf: 1767323045678 };
  const ids = ['0123456789000001', '0123456789000002'];
  const graph = { max_depth: 1, edges: [], nodes: ids.map((id, i) => ({ id, depth: 0, predecessors: [], proof: `exact proof ${i + 1}` })) };
  const overview = { facts: 2, facts_with_predecessors: 0, channel_counts: {}, facts_by_author: {}, verdicts: {}, updated_at: 1 };
  const handlers = new Map(), calls = [];
  const proofRead = Promise.withResolvers(); let holdGraph = true;
  registerWorkspaceDashboardRoutes({ get: (route, handler) => handlers.set(route, handler) }, {
    current: () => scope,
    async read(selection, generation, guard) {
      assert.equal(generation, scope.generation); assert.equal(guard(), true);
      if (selection.view === 'overview') return overview;
      if (selection.view === 'channels') return { channels: [{ kind: 'verification', count: 1 }] };
      if (selection.view === 'channel') return { entries: [{ id: 'entry', fact_id: ids[1], claim: 'fixture verification' }] };
      assert.equal(selection.view, 'factgraph');
      if (holdGraph) await proofRead.promise;
      return graph;
    },
  });
  const stamp = { appId: 'hana-math', agentId: null, document: null, principal: { kind:'app', appId:'hana-math', credentialKind:'app_surface_session', connectionKind:'local', credentialId:'fixture' } };
  view = mountWorkspaceDashboard((tab, channel) => monitor.select(tab, channel));
  monitor = createWorkspaceMonitor({ ready() {}, fetch(route, init) {
    calls.push(route.slice('/workspace-monitor'.length));
    return handlers.get(route)({ req: { raw: new Request('http://fixture.invalid' + route, init) }, get: () => stamp });
  } }, view, { visibility: document, lifecycle: window });
  await flush();
  assert.equal(read('#landing-state').textContent, '当前已保存结果（只读）');
  assert.equal(read('#refresh-note').textContent, `读取基准时间 ${new Date(scope.asOf).toISOString()}`);
  view.select('memory'); await flush();
  const button = read('#mem-list').querySelector('.fid');
  assert.equal(button.textContent, ids[0].slice(0, 10)); // Intentionally ambiguous display label.
  button.onclick(); await flush();
  assert.equal(read('#fact-detail').querySelector('.fid'), undefined);
  assert.deepEqual(calls.slice(-2), ['/current', '/api/factgraph']);
  holdGraph = false; proofRead.resolve(); await flush();
  assert.equal(calls.at(-1), '/current');
  assert.equal(read('#fact-detail').querySelector('.fid').textContent, ids[1]);
  assert.match(read('#fact-detail').textContent, /exact proof 2/);
  assert.doesNotMatch(read('#fact-detail').textContent, /exact proof 1/);
  assert.equal(read('#refresh-note').textContent, `读取基准时间 ${new Date(scope.asOf).toISOString()}`);
});
