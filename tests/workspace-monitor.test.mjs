import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createWorkspaceMonitor } from '../packages/hana-math/ui/dashboard/workspace-monitor.mjs';

const prefix = '/workspace-monitor';
const genHeader = 'x-hana-math-monitor-generation';
const interval = 8000;
const active = (projectId, generation = `gen-${projectId}`) => ({ state: 'active', projectId, generation });
const snapshot = (projectId, generation = `snapshot-${projectId}`) => ({ state: 'snapshot', projectId, generation, endedAt: 1760000000123 });
const saved = (projectId = 'project-a', generation = 'scope-a', asOf = 1795312000123) => ({ state: 'saved', projectId, generation, asOf });
const ok = json => ({ ok: true, status: 200, json: async () => structuredClone(json) });
const overview = (project, facts) => ({ project, facts, facts_with_predecessors: 0,
  facts_by_author: {}, channel_counts: {}, verdicts: {} });
const graph = (id, proof = 'Opaque proof') => ({ nodes: [{ id, proof }], edges: [], max_depth: 0 });
const entries = (claim) => ({ entries: [{ claim }] });
const paths = calls => calls.map(call => call.path.slice(prefix.length));

function clock() {
  let now = 0, ordinal = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) { timers.set(++ordinal, { at: now + ms, fn }); return ordinal; },
    clearTimer(id) { timers.delete(id); },
    count: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort(([, a], [, b]) => a.at - b.at)[0];
        if (!next) break;
        const [key, { at, fn }] = next;
        timers.delete(key); now = at; fn(); await flush();
      }
      now = end;
      await flush();
    },
  };
}

function fixture(t, initial = { state: 'idle' }) {
  const visibility = new EventTarget(); visibility.hidden = false;
  const lifecycle = new EventTarget(), c = clock(), requests = [], running = new Set();
  const events = [], statuses = [], commits = [];
  const UI = { badge: null, graph: null, detail: null, memory: null, selectedChannel: null, renderedEntries: null, overview: null };
  let target = initial, respond, onReady, handshakeCount = 0;
  const base = new Map([
    ['/api/overview', generation => overview(generation, 1)],
    ['/api/factgraph', generation => graph(generation)],
    ['/api/channels', () => ({ channels: [{ kind: 'plan', count: 1 }, { kind: 'verification', count: 1 }] })],
    ['/api/channel/plan', () => entries('first plan')],
    ['/api/channel/verification', () => entries('verification body')],
  ]);
  const hana = {
    async ready() { handshakeCount++; await onReady?.(); },
    get document() { assert.fail('monitor must not call document methods'); },
    get surface() { assert.fail('monitor must not call surface methods'); },
    api: { async fetch(path, init) {
      assert.ok(handshakeCount > 0);
      assert.equal(init.method, 'GET'); assert.equal(init.cache, 'no-store');
      assert.deepEqual(Object.keys(init).sort(), (path.endsWith('/current') ? ['method', 'cache', 'signal'] : ['method', 'cache', 'signal', 'headers']).sort());
      assert.equal([...running].filter(s => !s.aborted).length, 0, 'overlapping non-aborted fetches');
      assert.ok(path.startsWith(prefix));
      const sub = path.slice(prefix.length), generation = init.headers?.[genHeader];
      if (sub === '/current') assert.equal(generation, undefined);
      else assert.deepEqual(init.headers, { [genHeader]: target.generation });
      const call = { path, sub, generation, signal: init.signal };
      requests.push(call);
      running.add(call.signal);
      try {
        const override = respond?.(call);
        if (override !== undefined) return await override;
        if (sub === '/current') return ok(target);
        const reply = base.get(sub); assert.ok(reply, `unexpected path: ${sub}`);
        return ok(reply(generation));
      } finally { running.delete(call.signal); }
    } },
  };
  const view = {
    clear() { events.push({ kind: 'clear' }); for (const key of Object.keys(UI)) UI[key] = null; },
    status(value) { statuses.push(value); events.push({ kind: 'status', value }); },
    render(value) {
      commits.push(value); events.push({ kind: 'commit', value }); UI.badge = value.scope.projectId;
      if (value.tab === 'overview') UI.overview = value.data;
      if (value.tab === 'graph') { UI.graph = value.data; }
      if (value.tab === 'memory') {
        if (value.changes.data) UI.memory = value.data;
        if (value.changes.channel) UI.selectedChannel = value.channel;
        if (value.changes.entries) UI.renderedEntries = value.entries;
      }
    },
  };
  let monitor;
  function open() {
    const transport = { ready: () => hana.ready(), fetch: (path, init) => hana.api.fetch(path, init) };
    monitor = createWorkspaceMonitor(transport, view, { visibility, lifecycle, setTimer: c.setTimer, clearTimer: c.clearTimer });
    return monitor;
  }
  t.after(() => monitor?.dispose());
  return { c, requests, commits, statuses, events, UI, open, setTarget: v => { target = v; }, setResponse: fn => { respond = fn; },
    setReady: fn => { onReady = fn; }, base,
    handshakeCount: () => handshakeCount,
    hide(hidden) { visibility.hidden = hidden; visibility.dispatchEvent(new Event('visibilitychange')); },
    page(event) { lifecycle.dispatchEvent(new Event(event)); },
    lastStatus: () => statuses.at(-1),
  };
}

test('missing page transport is unsupported, not idle, and never falls back to a generic Hana route', async () => {
  for (const transport of [null, { ready: () => assert.fail('generic ready'), api: { fetch: () => assert.fail('generic fetch') } }]) {
    const effects = [];
    const monitor = createWorkspaceMonitor(transport, {
      clear() { effects.push('clear'); },
      render() { assert.fail('unexpected render without page transport'); },
      status(value) { effects.push(value); },
    }, { setTimer: () => assert.fail('scheduled without page transport') });
    monitor.select('memory', 'plan');
    monitor.dispose();
    await flush();
    assert.deepEqual(effects, ['clear', { state: 'unsupported', text: '当前版本无法连接实时研究看板' }]);
  }
});

test('workspace discovers idle → active without a bind, polls beyond fifteen minutes, and clears paused or completed state', async t => {
  const f = fixture(t); f.open(); await flush();
  assert.deepEqual(paths(f.requests), ['/current']);
  assert.deepEqual(f.lastStatus(), { state: 'idle', text: '当前没有正在推进的研究' });
  f.setTarget(active('A'));
  await f.c.advance(interval - 1); assert.equal(f.UI.badge, null);
  await f.c.advance(1);
  assert.deepEqual(paths(f.requests).slice(-3), ['/current', '/api/overview', '/current']);
  assert.equal(f.UI.badge, 'A');
  await f.c.advance(16 * 60 * 1000);
  assert.ok(f.requests.filter(req => req.sub === '/api/overview').length > 100);
  assert.equal(f.commits.length, 1, 'identical data did not replace the view');
  assert.equal(f.handshakeCount(), 1);
  f.setTarget({ state: 'idle' }); await f.c.advance(interval);
  assert.equal(f.UI.badge, null); assert.equal(f.UI.overview, null); assert.equal(f.lastStatus().state, 'idle');
  f.setTarget(active('B')); await f.c.advance(interval);
  assert.equal(f.UI.badge, 'B');
  f.setTarget({ state: 'idle' }); await f.c.advance(interval);
  assert.equal(f.UI.badge, null);
});

test('snapshot rechecks fresh authority, preserves the selected tab, and yields to the active selection', async t => {
  const f = fixture(t, active('A')), monitor = f.open(); await flush();
  monitor.select('graph'); await flush();
  assert.equal(f.UI.graph.nodes[0].id, 'gen-A');
  const pending = Promise.withResolvers();
  // Even if the backend reuses the token, active data must not be a snapshot.
  const terminal = { ...snapshot('A', 'gen-A'), projectName: 'Opaque A title' };
  f.setTarget(terminal);
  f.setResponse(call => call.sub === '/api/factgraph' ? pending.promise : undefined);
  const reads = f.requests.length;
  await f.c.advance(interval);
  assert.equal(f.UI.graph, null); assert.equal(f.UI.overview, null);
  assert.deepEqual(paths(f.requests.slice(reads)), ['/current', '/api/factgraph']);
  pending.resolve(ok(graph('canonical-final'))); await flush();
  assert.deepEqual(f.commits.at(-1).scope, terminal);
  assert.equal(f.UI.graph.nodes[0].id, 'canonical-final');
  assert.deepEqual(f.lastStatus(), { state: 'snapshot', text: '只读快照' });

  const late = Promise.withResolvers(), start = f.commits.length;
  f.setResponse(call => call.sub === '/api/factgraph' && call.generation === terminal.generation ? late.promise : undefined);
  await f.c.advance(interval);
  f.setTarget(active('B'));
  late.resolve(ok(graph('must-not-paint'))); await flush();
  assert.deepEqual(f.commits.slice(start).map(({ scope, tab }) => [scope.state, scope.projectId, tab]), [['active', 'B', 'graph']]);
  assert.equal(f.UI.graph.nodes[0].id, 'gen-B');
  assert.deepEqual(f.lastStatus(), { state: 'active', text: '正在跟踪研究' });
  f.setTarget({ state: 'unavailable' }); await f.c.advance(interval);
  assert.equal(f.UI.badge, null); assert.equal(f.UI.graph, null);
});

test('malformed snapshots never reach a business GET and a valid unnamed snapshot recovers', async t => {
  const f = fixture(t); f.open(); await flush();
  const valid = snapshot('A');
  const { endedAt, ...missingTime } = valid;
  for (const target of [missingTime, ...[0, -1, 1.5, '1760000000123', Number.MAX_SAFE_INTEGER + 1, 8640000000000001].map(endedAt => ({ ...valid, endedAt })),
    { ...valid, projectName: null }, { ...valid, projectId: '' }, { ...valid, generation: '' }, { ...valid, extra: 'private' }]) {
    const start = f.requests.length;
    f.setTarget(target); await f.c.advance(interval);
    assert.deepEqual(paths(f.requests.slice(start)), ['/current']);
    assert.equal(f.UI.badge, null);
    assert.deepEqual(f.lastStatus(), failure('发现 GET：HTTP 200：响应无法使用'));
  }
  assert.equal(f.commits.length, 0);
  f.setTarget(valid); await f.c.advance(interval);
  assert.deepEqual(f.commits.at(-1).scope, valid);
  assert.equal(f.UI.badge, 'A'); assert.deepEqual(f.lastStatus(), { state: 'snapshot', text: '只读快照' });
});

test('saved uses all protected tabs; a changed reading basis invalidates the in-flight body even with the same generation', async t => {
  const first = saved(), f = fixture(t, first), monitor = f.open(); await flush();
  assert.deepEqual(f.lastStatus(), { state: 'saved', text: '当前已保存结果（只读）' });
  assert.deepEqual(f.commits.at(-1).scope, first);
  monitor.select('memory', 'verification'); await flush();
  assert.deepEqual(paths(f.requests).slice(-4), ['/current', '/api/channels', '/api/channel/verification', '/current']);
  assert.equal(f.UI.renderedEntries[0].claim, 'verification body');
  monitor.select('graph'); await flush();
  assert.deepEqual(paths(f.requests).slice(-3), ['/current', '/api/factgraph', '/current']);
  assert.deepEqual(f.commits.map(x => x.tab), ['overview', 'memory', 'graph']);

  const withheld = Promise.withResolvers(), start = f.commits.length;
  f.setResponse(call => call.sub === '/api/factgraph' ? withheld.promise : undefined);
  await f.c.advance(interval);
  const later = { ...first, asOf: first.asOf + 1 };
  f.setTarget(later); f.setResponse(undefined);
  withheld.resolve(ok(graph('outgoing-saved'))); await flush();
  assert.deepEqual(f.commits.slice(start).map(x => x.scope), [later]);
  assert.notEqual(f.UI.graph.nodes[0].id, 'outgoing-saved');
  for (const replacement of [snapshot(first.projectId, first.generation), active(first.projectId, first.generation)]) {
    f.setTarget(replacement); await f.c.advance(interval);
    assert.deepEqual(f.commits.at(-1).scope, replacement);
  }
});

test('saved requires exact discovery fields and a positive representable reading basis', async t => {
  const f = fixture(t); f.open(); await flush();
  const valid = saved(), { asOf, ...missing } = valid;
  for (const invalid of [missing, ...[0, -1, 1.5, '1795312000123', 8640000000000001].map(asOf => ({ ...valid, asOf })),
    { ...valid, endedAt: asOf }, { ...valid, projectId: 'not/a/project' }, { ...valid, generation: 'a,b' }]) {
    const start = f.requests.length;
    f.setTarget(invalid); await f.c.advance(interval);
    assert.deepEqual(paths(f.requests.slice(start)), ['/current']);
    assert.deepEqual(f.lastStatus(), failure('发现 GET：HTTP 200：响应无法使用'));
  }
  f.setTarget(valid); await f.c.advance(interval);
  assert.equal(f.commits.length, 1);
  assert.deepEqual(f.lastStatus(), { state: 'saved', text: '当前已保存结果（只读）' });
});

test('active tab refreshes; unchanged graph and memory body are preserved, including an explicitly selected channel', async t => {
  const f = fixture(t, active('A')), monitor = f.open(); await flush();
  f.base.set('/api/overview', () => overview('A', 2)); await f.c.advance(interval);
  assert.equal(f.UI.overview.facts, 2);
  monitor.select('graph'); await flush();
  const oldGraph = f.UI.graph;
  f.UI.detail = { open: true, text: 'currently reading' };
  await f.c.advance(interval);
  assert.equal(f.UI.graph, oldGraph);
  assert.equal(f.UI.detail.text, 'currently reading');
  f.base.set('/api/factgraph', () => graph('second')); await f.c.advance(interval);
  assert.equal(f.UI.graph.nodes[0].id, 'second');
  monitor.select('memory', 'verification'); await flush();
  assert.equal(f.UI.selectedChannel, 'verification');
  const body = f.UI.renderedEntries;
  assert.deepEqual(paths(f.requests).slice(-4), ['/current', '/api/channels', '/api/channel/verification', '/current']);
  f.base.set('/api/channels', () => ({ channels: [{ kind: 'plan', count: 2 }, { kind: 'verification', count: 1 }] }));
  await f.c.advance(interval);
  assert.equal(f.UI.memory.channels[0].count, 2); assert.equal(f.UI.renderedEntries, body);
  assert.equal(f.commits.at(-1).changes.entries, false);
  f.base.set('/api/channel/verification', () => entries('new verification body'));
  await f.c.advance(interval);
  assert.equal(f.UI.selectedChannel, 'verification'); assert.equal(f.UI.renderedEntries[0].claim, 'new verification body');
  f.setTarget(active('A', 'gen-new-incarnation'));
  await f.c.advance(interval);
  assert.equal(f.UI.detail, null); assert.equal(f.UI.graph, null);
  assert.equal(f.UI.selectedChannel, 'plan', 'generation changes clear selection even when project id repeats');
});

test('late A response is not painted after the route rotates; clear old badge, proof and memory before B commits', async t => {
  const f = fixture(t, active('A')), monitor = f.open(); await flush();
  monitor.select('memory'); await flush();
  monitor.select('graph'); await flush();
  f.UI.detail = { text: 'old A proof' };
  const pending = Promise.withResolvers();
  f.setResponse(call => call.sub === '/api/factgraph' && call.generation === 'gen-A' ? pending.promise : undefined);
  await f.c.advance(interval);
  assert.equal(f.requests.at(-1).generation, 'gen-A');
  const previous = f.events.length;
  f.setTarget(active('B')); pending.resolve(ok(graph('late A'))); await flush();
  const events = f.events.slice(previous);
  assert.equal(events[0].kind, 'clear');
  assert.deepEqual(events.filter(row => row.kind === 'commit').map(row => row.value.scope.projectId), ['B']);
  assert.equal(f.UI.badge, 'B'); assert.equal(f.UI.detail, null);
  assert.equal(f.UI.memory, null); assert.equal(f.UI.renderedEntries, null);
  assert.equal(f.UI.graph.nodes[0].id, 'gen-B');
});

test('tab changes coalesce with an in-flight request and cannot paint the just-left panel', async t => {
  const f = fixture(t, active('A')), monitor = f.open(); await flush();
  const pending = Promise.withResolvers();
  f.setResponse(call => call.sub === '/api/factgraph' ? pending.promise : undefined);
  monitor.select('graph'); await flush();
  const started = f.requests.length;
  monitor.select('overview'); monitor.select('memory', 'plan'); monitor.select('memory', 'verification');
  assert.equal(f.requests.length, started);
  pending.resolve(ok(graph('not wanted'))); await flush();
  assert.deepEqual(f.commits.map(row => row.tab), ['overview', 'memory']);
  assert.deepEqual(paths(f.requests).slice(started), ['/current', '/current', '/api/channels', '/api/channel/verification', '/current']);
});

test('visibility and two opens clear the view and immediately restart discovery, ignoring replies from suspended instances', async t => {
  const f = fixture(t, active('A')), first = f.open(); await flush();
  const pending = Promise.withResolvers();
  let calls = 0;
  f.setResponse(call => call.sub === '/api/overview' && ++calls === 1 ? pending.promise : undefined);
  await f.c.advance(interval);
  const abandoned = f.requests.at(-1);
  f.hide(true);
  assert.equal(abandoned.signal.aborted, true); assert.equal(f.UI.badge, null); assert.equal(f.c.count(), 0);
  await f.c.advance(interval * 2); assert.equal(f.requests.at(-1), abandoned);
  f.setTarget(active('B')); f.hide(false); await flush();
  assert.equal(f.UI.badge, 'B');
  pending.resolve(ok(overview('stale', 99))); await flush();
  assert.equal(f.UI.overview.project, 'gen-B');
  f.page('pagehide'); assert.equal(f.UI.badge, null); assert.equal(f.c.count(), 0);
  f.page('pageshow'); await flush(); assert.equal(f.UI.badge, 'B');
  first.dispose(); assert.equal(f.c.count(), 0); assert.equal(f.UI.badge, null);
  const second = f.open(); await flush();
  assert.equal(f.UI.badge, 'B'); assert.equal(f.handshakeCount(), 4);
  second.dispose(); const requestCount = f.requests.length;
  f.page('pageshow'); f.hide(false); await f.c.advance(interval * 2);
  assert.equal(f.requests.length, requestCount);
});

test('unavailable or timed-out reads withdraw all data and retry without accepting a late success', async t => {
  const f = fixture(t, active('A')); f.open(); await flush();
  f.setTarget({ state: 'unavailable' }); await f.c.advance(interval);
  assert.deepEqual(f.lastStatus(), { state: 'unavailable', text: '研究状态暂不可用 · 发现 GET：HTTP 200：服务返回不可用' });
  assert.equal(f.UI.badge, null);
  f.setTarget(active('B'));
  const hung = Promise.withResolvers();
  f.setResponse(call => call.sub === '/api/overview' ? hung.promise : undefined);
  await f.c.advance(interval); const request = f.requests.at(-1);
  await f.c.advance(12000);
  assert.equal(request.signal.aborted, true); assert.equal(f.UI.badge, null);
  assert.deepEqual(f.lastStatus(), failure('发现 GET：HTTP 200：服务返回不可用'), 'later business deadline does not replace the first failed discovery');
  hung.resolve(ok(overview('late', 99))); f.setResponse(undefined);
  await f.c.advance(interval);
  assert.equal(f.UI.badge, 'B'); assert.equal(f.UI.overview.facts, 1);
  f.setResponse(call => call.sub === '/current' ? ok({ state: 'active', projectId: 'B', generation: '' }) : undefined);
  await f.c.advance(interval);
  assert.equal(f.UI.badge, null);
  assert.deepEqual(f.lastStatus(), failure('发现 GET：HTTP 200：响应无法使用'));
});

const failure = tail => ({ state: 'unavailable', text: `研究状态暂不可用 · ${tail}` });
const confidential = 'synthetic-private-body https://fixture.invalid/hidden?token=synthetic';
const rejectResponse = status => ({ ok: false, status, json() { assert.fail('must not read HTTP error bodies'); } });
const busyBody = { state: 'unavailable', reason: 'project_busy' };
const conflict = json => ({ ok: false, status: 409, json });
const busy = failure('业务读取：项目正忙，看板会自动重试');
const genericConflict = failure('业务读取：HTTP 409（读取未获确认）');

test('readiness failure, 403, identical 200-unavailable, other HTTP status and no HTTP stay distinct, then idle recovers', async t => {
  const f = fixture(t);
  f.setReady(() => { throw Error(confidential); });
  f.open(); await flush();
  assert.deepEqual(f.lastStatus(), failure('SDK 未就绪，尚未发请求'));
  assert.equal(f.requests.length, 0);
  f.setReady(undefined); await f.c.advance(interval);
  assert.deepEqual(f.lastStatus(), { state: 'idle', text: '当前没有正在推进的研究' });
  for (const [reply, expected] of [
    [() => rejectResponse(403), '发现 GET：HTTP 403（请求被拒绝）'],
    [() => ok({ state: 'unavailable', private: confidential }), '发现 GET：HTTP 200：服务返回不可用'],
    [() => rejectResponse(503), '发现 GET：HTTP 503'],
    [() => { throw Error(confidential); }, '发现 GET：未收到 HTTP 响应'],
    [() => rejectResponse(confidential), '发现 GET：未收到 HTTP 响应'],
    [() => ({ ok: true, status: 200, json() { throw Error(confidential); } }), '发现 GET：HTTP 200：响应无法使用'],
  ]) {
    f.setResponse(reply); await f.c.advance(interval);
    assert.deepEqual(f.lastStatus(), failure(expected));
    f.setResponse(undefined); await f.c.advance(interval);
    assert.deepEqual(f.lastStatus(), { state: 'idle', text: '当前没有正在推进的研究' });
  }
  assert.deepEqual(paths(f.requests), Array(13).fill('/current'));
  assert.equal(f.commits.length, 0);
  assert.doesNotMatch(JSON.stringify(f.statuses), /synthetic-private|fixture\.invalid|token/);
});

test('refresh 409 is a business failure; final discovery has its own stage and neither can commit data', async t => {
  const f = fixture(t, active('secret-project', 'secret-generation'));
  f.open(); await flush(); assert.equal(f.UI.badge, 'secret-project');
  f.setResponse(call => call.sub === '/api/overview' ? rejectResponse(409) : undefined);
  await f.c.advance(interval);
  assert.deepEqual(paths(f.requests).slice(-2), ['/current', '/api/overview']);
  assert.deepEqual(f.lastStatus(), failure('业务读取：HTTP 409（读取未获确认）'));
  assert.equal(f.UI.badge, null); assert.equal(f.UI.overview, null);
  f.setResponse(undefined); await f.c.advance(interval);
  assert.deepEqual(f.lastStatus(), { state: 'active', text: '正在跟踪研究' });
  let current = 0;
  f.setResponse(call => call.sub === '/current' && ++current === 2 ? rejectResponse(403) : undefined);
  await f.c.advance(interval);
  assert.deepEqual(paths(f.requests).slice(-3), ['/current', '/api/overview', '/current']);
  assert.deepEqual(f.lastStatus(), failure('最终代次复核：HTTP 403（请求被拒绝）'));
  assert.equal(f.commits.length, 2);
  assert.doesNotMatch(JSON.stringify(f.statuses), /secret-project|secret-generation/);
  f.setResponse(undefined); await f.c.advance(interval);
  assert.deepEqual(f.lastStatus(), { state: 'active', text: '正在跟踪研究' });
});

test('project busy withdraws the old view and recovers by discovery, business and recheck at the next 8s poll', async t => {
  const f = fixture(t, active('A'));
  f.open(); await flush();
  assert.equal(f.UI.overview.facts, 1);
  const before = f.requests.length;
  let bodies = 0;
  f.setResponse(call => call.sub === '/api/overview' ? conflict(async () => { bodies++; return busyBody; }) : undefined);
  await f.c.advance(interval);
  assert.deepEqual(f.lastStatus(), busy);
  assert.equal(bodies, 1);
  assert.equal(f.UI.overview, null); assert.equal(f.UI.badge, null); assert.equal(f.commits.length, 1);
  assert.deepEqual(paths(f.requests).slice(before), ['/current', '/api/overview']);
  f.setResponse(undefined); f.base.set('/api/overview', generation => overview(generation, 2));
  await f.c.advance(interval - 1); assert.equal(f.requests.length, before + 2);
  await f.c.advance(1);
  assert.deepEqual(paths(f.requests).slice(before), ['/current', '/api/overview', '/current', '/api/overview', '/current']);
  assert.equal(f.UI.overview.facts, 2); assert.equal(f.commits.length, 2);
  assert.deepEqual(f.lastStatus(), { state: 'active', text: '正在跟踪研究' });
});

test('only an exact 409 business error packet can report busy; the first failure survives until recovery', async t => {
  const f = fixture(t, active('A')); f.open(); await flush();
  for (const json of [async () => ({ ...busyBody, message: confidential }), async () => ({ ...busyBody, reason: confidential }),
    async () => ({ state: 'unavailable' }), async () => [busyBody], async () => { throw Error(confidential); }]) {
    f.setResponse(call => call.sub === '/api/overview' ? conflict(json) : undefined);
    await f.c.advance(interval); assert.deepEqual(f.lastStatus(), genericConflict);
    f.setResponse(undefined); await f.c.advance(interval); assert.equal(f.lastStatus().state, 'active');
  }
  f.setResponse(call => call.sub === '/api/overview' ? rejectResponse(403) : undefined);
  await f.c.advance(interval);
  const first = failure('业务读取：HTTP 403（请求被拒绝）');
  assert.deepEqual(f.lastStatus(), first);
  f.setResponse(call => call.sub === '/api/overview' ? conflict(async () => busyBody) : undefined);
  await f.c.advance(interval); assert.deepEqual(f.lastStatus(), first);
  f.setResponse(undefined); await f.c.advance(interval); assert.equal(f.lastStatus().state, 'active');

  let bodies = 0, discovery = 0;
  for (const stage of ['发现 GET', '最终代次复核', '业务读取']) {
    f.setResponse(call => {
      const isCurrent = call.sub === '/current';
      if (stage === '发现 GET' && !isCurrent || stage === '最终代次复核' && (!isCurrent || ++discovery !== 2)
        || stage === '业务读取' && isCurrent) return;
      return { ok: false, status: stage === '业务读取' ? 503 : 409, json: async () => { bodies++; return busyBody; } };
    });
    await f.c.advance(interval);
    assert.deepEqual(f.lastStatus(), failure(`${stage}：${stage === '业务读取' ? 'HTTP 503' : 'HTTP 409（读取未获确认）'}`));
    f.setResponse(undefined); await f.c.advance(interval);
  }
  assert.equal(bodies, 0);
  assert.doesNotMatch(JSON.stringify(f.statuses), /synthetic-private|fixture\.invalid|token/);
});

test('late busy JSON cannot replace a timed-out or suspended business read', async t => {
  for (const cancel of ['deadline', 'pagehide']) {
    const f = fixture(t, active('A'));
    const pending = Promise.withResolvers(); let bodyReads = 0;
    f.setResponse(call => call.sub === '/api/overview' ? conflict(() => { bodyReads++; return pending.promise; }) : undefined);
    f.open(); await flush(); assert.equal(bodyReads, 1);
    assert.equal(f.lastStatus().state, 'pending');
    if (cancel === 'deadline') {
      await f.c.advance(12000);
      assert.deepEqual(f.lastStatus(), failure('业务读取：超过时限'));
    } else f.page('pagehide');
    assert.equal(f.requests[1].signal.aborted, true);
    f.setResponse(undefined);
    if (cancel === 'deadline') await f.c.advance(interval);
    else { f.page('pageshow'); await flush(); }
    const count = f.requests.length;
    pending.resolve(busyBody); await flush();
    assert.equal(f.lastStatus().state, 'active'); assert.equal(f.commits.length, 1);
    assert.ok(!f.statuses.some(s => s.text === busy.text)); assert.equal(f.requests.length, count);
  }
});

test('A business result followed by valid B is cleared; the immediate B discovery 403 is the first fault', async t => {
  const f = fixture(t, active('A'));
  f.open(); await flush(); assert.equal(f.UI.badge, 'A');
  f.UI.detail = { text: 'old A proof' };
  const before = f.requests.length, events = f.events.length;
  let discoveries = 0;
  f.setResponse(call => {
    if (call.sub !== '/current') return;
    if (++discoveries === 2) { f.setTarget(active('B')); return ok(active('B')); }
    if (discoveries === 3) return rejectResponse(403);
  });
  await f.c.advance(interval);
  assert.deepEqual(paths(f.requests).slice(before), ['/current', '/api/overview', '/current', '/current']);
  assert.deepEqual(f.events.slice(events).map(e => e.kind === 'status' ? e.value : e.kind), [
    'clear', { state: 'pending', text: '正在确认研究状态' }, 'clear', failure('发现 GET：HTTP 403（请求被拒绝）'),
  ]);
  assert.equal(f.commits.length, 1); assert.equal(f.UI.badge, null); assert.equal(f.UI.detail, null);
  f.setResponse(undefined); await f.c.advance(interval);
  assert.equal(f.UI.badge, 'B'); assert.deepEqual(f.lastStatus(), { state: 'active', text: '正在跟踪研究' });
});

test('deadline is latched before transport abort rejects, and retries still run at the original cadence', async t => {
  const f = fixture(t);
  f.setResponse(({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Error(confidential)), { once: true });
  }));
  f.open(); await flush();
  await f.c.advance(11999); assert.equal(f.lastStatus().state, 'pending');
  await f.c.advance(1);
  assert.deepEqual(f.lastStatus(), failure('发现 GET：超过时限'));
  assert.equal(f.statuses.filter(row => row.state === 'unavailable').length, 1);
  assert.equal(f.requests[0].signal.aborted, true);
  f.setResponse(undefined);
  await f.c.advance(interval - 1); assert.equal(f.requests.length, 1);
  await f.c.advance(1); assert.equal(f.requests.length, 2);
  assert.equal(f.lastStatus().state, 'idle');
});

test('hide and pagehide cancel normally; late rejection and success cannot publish a fault; next live read recovers', async t => {
  for (const [suspend, resume, late] of [
    [f => f.hide(true), f => f.hide(false), pending => pending.reject(Error(confidential))],
    [f => f.page('pagehide'), f => f.page('pageshow'), pending => pending.resolve(ok(active('old-project')))],
  ]) {
    const f = fixture(t), pending = Promise.withResolvers();
    f.setResponse(() => pending.promise); f.open(); await flush();
    suspend(f); assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.c.count(), 0);
    late(pending); await f.c.advance(12000 + interval);
    assert.equal(f.requests.length, 1);
    assert.ok(!f.statuses.some(row => row.state === 'unavailable'));
    assert.equal(f.commits.length, 0);
    f.setTarget(active('new-project')); f.setResponse(undefined); resume(f); await flush();
    assert.deepEqual(f.lastStatus(), { state: 'active', text: '正在跟踪研究' });
    assert.equal(f.UI.badge, 'new-project');
    assert.ok(!f.statuses.some(row => row.state === 'unavailable'));
  }
});
