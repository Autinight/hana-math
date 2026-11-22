import assert from 'node:assert/strict';
import test from 'node:test';
import { hana } from '../packages/hana-math/ui/assets/sdk.js';
import { installTabHitRegions } from '../packages/hana-math/ui/dashboard/tab-hit-regions.mjs';

const applied = { applied: true };
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function button(x, y) {
  return { isConnected: true, rect: { x, y, width: 39.5, height: 26.25, ignored: 'not a protocol field' },
    getBoundingClientRect() { return this.rect; },
    checkVisibility(opts) { assert.equal(opts.visibilityProperty, true); return !this.invisible; } };
}
function fixture(t, { ready = () => {}, send = () => applied, supported = true } = {}) {
  const frames = new Map(), calls = [], watchers = [];
  let nextFrame = 0, readyCalls = 0;
  class Observer {
    constructor(notify) { this.notify = notify; this.targets = []; watchers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets.length = 0; }
  }
  const view = Object.assign(new EventTarget(), {
    innerWidth: 220, innerHeight: 160,
    ResizeObserver: Observer, MutationObserver: Observer,
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle: b => b.style ?? { display: 'block', visibility: 'visible', opacity: '1' },
  });
  const doc = Object.assign(new EventTarget(), { defaultView: view, documentElement: {}, body: {}, fonts: new EventTarget() });
  const tabs = [button(12.25, 3.75), button(54, 3.75), button(96, 3.75)];
  const header = { ownerDocument: doc, querySelectorAll(selector) {
    assert.equal(selector, '.header-nav > button.nav-link[data-tab]'); return tabs;
  } };
  const sdk = { ready() { readyCalls++; return ready(); }, surface: supported ? {
    setInteractiveRegions(regions) { assert.equal(this, sdk.surface); calls.push(regions); return send(regions); },
  } : {} };
  const dispose = installTabHitRegions(sdk, header);
  t.after(dispose);
  return { calls, frames, tabs, view, doc, watchers, dispose, readyCalls: () => readyCalls,
    event(type, persisted = false) { view.dispatchEvent(Object.assign(new Event(type), { persisted })); },
    async tick() {
      const current = [...frames.values()]; frames.clear();
      for (const run of current) void run();
      await settle();
    },
  };
}

test('the same packaged browser SDK imported by landing exposes the documented API', () => {
  assert.equal(typeof hana.surface.setInteractiveRegions, 'function');
});

test('waits for SDK readiness, reports only the three exact viewport rectangles and dedupes merged notifications', async t => {
  const ready = deferred();
  const f = fixture(t, { ready: () => ready.promise });
  f.event('resize'); await f.tick(); assert.deepEqual(f.calls, []);
  ready.resolve(); await settle();
  assert.equal(f.frames.size, 1);
  await f.tick();
  assert.deepEqual(f.calls, [[
    { x: 12.25, y: 3.75, width: 39.5, height: 26.25 },
    { x: 54, y: 3.75, width: 39.5, height: 26.25 },
    { x: 96, y: 3.75, width: 39.5, height: 26.25 },
  ]]);
  f.event('scroll'); f.event('resize'); f.watchers[0].notify(); f.watchers[1].notify();
  f.doc.dispatchEvent(new Event('load')); f.doc.fonts.dispatchEvent(new Event('loadingdone'));
  assert.equal(f.frames.size, 1);
  await f.tick(); assert.equal(f.calls.length, 1);
  f.tabs[1].rect.y = 34.5;
  f.watchers[0].notify(); f.event('resize'); f.event('scroll');
  assert.equal(f.frames.size, 1);
  await f.tick(); assert.equal(f.calls.length, 2); assert.equal(f.calls[1][1].y, 34.5);
});

test('excludes hidden, disconnected, disabled, invalid and offscreen controls without clipping partial bounds', async t => {
  const f = fixture(t);
  await settle(); await f.tick();
  f.tabs[0].invisible = true;
  f.tabs[1].rect.x = 220;
  f.tabs[2].rect.y = -18.75;
  f.watchers[1].notify(); await f.tick();
  assert.deepEqual(f.calls.at(-1), [{ x: 96, y: -18.75, width: 39.5, height: 26.25 }]);
  f.tabs[0].invisible = false; f.tabs[0].disabled = true;
  f.tabs[1].isConnected = false; f.tabs[1].rect.x = 54;
  f.tabs[2].rect.height = Infinity;
  f.event('scroll'); await f.tick(); assert.deepEqual(f.calls.at(-1), []);
  f.tabs[1].isConnected = true; f.tabs[1].checkVisibility = undefined;
  f.tabs[1].style = { display: 'block', visibility: 'hidden', opacity: '1' };
  f.event('resize'); await f.tick(); assert.equal(f.calls.length, 3);
});

test('changes during an in-flight registration send only the latest geometry after the receipt', async t => {
  const held = deferred();
  const f = fixture(t, { send: () => f.calls.length === 1 ? held.promise : applied });
  await settle(); await f.tick();
  f.tabs[0].rect.y = 18;
  f.event('scroll'); f.watchers[1].notify();
  f.tabs[0].rect.y = 39;
  f.event('resize'); await f.tick(); assert.equal(f.calls.length, 1);
  held.resolve(applied); await settle();
  assert.equal(f.frames.size, 1);
  await f.tick(); assert.equal(f.calls.length, 2); assert.equal(f.calls[1][0].y, 39);
});

test('pagehide clears an outstanding registration; only persisted pageshow re-arms and reports afresh', async t => {
  const held = deferred(), resumed = deferred();
  let readiness = 0;
  const f = fixture(t, { ready: () => ++readiness === 2 ? resumed.promise : undefined,
    send: () => f.calls.length === 1 ? held.promise : applied });
  await settle(); await f.tick();
  f.event('scroll'); f.event('pagehide', true);
  assert.deepEqual(f.calls[1], []);
  assert.ok(f.watchers.every(w => w.targets.length === 0));
  f.event('pageshow'); await settle(); assert.equal(f.readyCalls(), 1);
  f.event('pageshow', true); await settle(); assert.equal(f.readyCalls(), 2);
  assert.equal(f.frames.size, 0);
  resumed.resolve(); held.resolve(applied); await settle(); await f.tick();
  assert.deepEqual(f.calls, [f.calls[0], [], f.calls[0]]);
  f.event('resize'); f.dispose(); assert.equal(f.frames.size, 0);
  assert.deepEqual(f.calls.at(-1), []);
  f.event('pageshow', true); await settle(); assert.equal(f.readyCalls(), 2);
});

test('a page hidden before SDK ready sends nothing, even if ready settles after pagehide', async t => {
  const ready = deferred();
  const f = fixture(t, { ready: () => ready.promise });
  f.event('pagehide'); ready.resolve(); await settle();
  await f.tick(); assert.deepEqual(f.calls, []); assert.equal(f.watchers.length, 0);
});

test('missing capability, failed SDK readiness and unsupported Host receipts do not cause layout retries', async t => {
  const noMethod = fixture(t, { supported: false });
  const noReady = fixture(t, { ready: async () => { throw Error('not ready'); } });
  const refused = fixture(t, { send: async () => { throw Error('unsupported'); } });
  const notApplied = fixture(t, { send: () => ({ applied: false }) });
  await settle();
  for (const f of [noMethod, noReady, refused, notApplied]) {
    await f.tick(); f.tabs[0].rect.y = 41; f.event('resize'); f.event('scroll');
    assert.equal(f.frames.size, 0); await f.tick(); f.event('pagehide');
  }
  assert.deepEqual([noMethod.readyCalls(), noReady.readyCalls()], [0, 1]);
  assert.deepEqual([noMethod.calls.length, noReady.calls.length, refused.calls.length, notApplied.calls.length], [0, 0, 1, 1]);
});
