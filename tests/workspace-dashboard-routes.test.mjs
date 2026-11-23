import assert from 'node:assert/strict';
import test from 'node:test';
import { registerPanel } from '../packages/hana-math/panel-service.mjs';
import { dashboardSelection } from '../packages/hana-math/dashboard-request.mjs';
import { workspaceProjectBusy } from '../packages/hana-math/dashboard-monitor-transport.mjs';
import { LIVE_ACTIVATE, LIVE_ROUTE, livePaths } from '../packages/hana-math/ui/dashboard/live-protocol.mjs';

const prefix = '/workspace-monitor';
const generation = 'x-hana-math-monitor-generation';
const scope = Object.freeze({ state: 'active', projectId: 'only-fixture-project', generation: 'fixture-generation' });
// Handler-level DTO fixture only. No Host login, token, real request stamping,
// networking, or claim that this is an actual Host authorization test.
function requestStamp(principal = {}, context = {}) {
  return Object.freeze({ appId: 'hana-math', agentId: null, document: null, ...context,
    principal: Object.freeze({ appId: 'hana-math', kind: 'app', credentialKind: 'app_surface_session', connectionKind: 'local',
      credentialId: 'opaque-surface-session-label', ...principal }) });
}
const witness = { overview: { channel_counts: {}, facts_by_author: {}, verdicts: {} },
  factgraph: { nodes: [], edges: [] }, channels: { channels: [] }, channel: { entries: [] } };

async function routes(build = () => ({
  current(guard) { assert.equal(guard(), true); return scope; },
  async read(selection, g, guard) {
    assert.equal(guard(), true);
    if (g !== scope.generation) return { state: 'unavailable' };
    return witness[selection.view];
  },
})) {
  const handlers = new Map(), calls = [];
  let registrations = 0;
  const mount = { async register(fn) {
    registrations++;
    fn({ get(path, handler) { assert.ok(!handlers.has(`GET ${path}`)); handlers.set(`GET ${path}`, handler); },
      post(path, handler) { handlers.set(`POST ${path}`, handler); } });
  } };
  const dashboard = build();
  const previous = { registerRoutes(app) {
    for (const path of [LIVE_ACTIVATE, ...livePaths.map(p => LIVE_ROUTE + p)]) app.get(path, () => new Response());
  } };
  const monitor = !dashboard ? dashboard : { ...dashboard,
    ...(typeof dashboard.current === 'function' && { current(guard) { calls.push(['current']); return dashboard.current(guard); } }),
    ...(typeof dashboard.read === 'function' && { read(selection, gen, guard) { calls.push(['read', selection, gen]); return dashboard.read(selection, gen, guard); } }),
  };
  await registerPanel({ routes: mount }, previous, monitor);
  assert.equal(registrations, 1);
  function send(path, { stamp = () => requestStamp(), stable = true, method = 'GET', headers, signal } = {}) {
    const raw = new Request(`http://fixture.invalid${path}`, { method, headers, signal });
    const name = new URL(raw.url).pathname;
    const handler = handlers.get(`${method} ${name}`) ?? (method === 'HEAD' && handlers.get(`GET ${name}`));
    if (!handler) return Promise.resolve(new Response(null, { status: 404 }));
    const initial = stamp();
    return handler({ req: { raw }, get(key) { assert.equal(key, 'appRequestContext'); return stable ? initial : stamp(); } });
  }
  return { send, calls, handlers };
}

async function checked(response, status, data) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), data);
}
const unavailable = { state: 'unavailable' };
const header = { [generation]: scope.generation };

test('one awaited panel registrar adds only discovery and the fixed Danus GET paths', async () => {
  const f = await routes();
  assert.deepEqual([...f.handlers.keys()].filter(x => x.includes(prefix)),
    ['/current', ...livePaths].map(path => `GET ${prefix}${path}`));
  assert.ok(f.handlers.has(`GET ${LIVE_ACTIVATE}`));
  assert.ok(livePaths.every(path => f.handlers.has(`GET ${LIVE_ROUTE}${path}`)));
  await checked(await f.send(`${prefix}/current`), 200, scope);
  for (const path of livePaths) await checked(await f.send(`${prefix}${path}`, { headers: header }), 200, witness[dashboardSelection(path).view]);
  assert.equal(f.calls.length, 1 + livePaths.length);
  for (const [i, path] of livePaths.entries()) {
    const [, selection, value] = f.calls[i + 1];
    assert.equal(selection, dashboardSelection(path));
    assert.equal(value, scope.generation);
  }
});

test('terminal discovery returns only project, end and new scope; it cannot grant a read', async () => {
  let result = {...scope,state:'snapshot',endedAt:1795312000123};
  const f = await routes(() => ({current:() => ({...result,privateClaim:'must never leak'}),read:() => unavailable}));
  await checked(await f.send(`${prefix}/current`),200,result);
  result = {...result,projectName:'公开项目名'};
  await checked(await f.send(`${prefix}/current`),200,result);
  await checked(await f.send(`${prefix}/api/overview`,{headers:header}),409,unavailable);
  await checked(await f.send(`${prefix}/current`,{stamp:()=>requestStamp({connectionKind:'lan'})}),403,unavailable);
  for (const endedAt of [null, -1, 0, '2026-11-22', Number.MAX_SAFE_INTEGER]) {
    result = {...result,endedAt}; await checked(await f.send(`${prefix}/current`),503,unavailable);
  }
});

test('saved discovery emits only the reading basis; business GETs still require the issued scope', async () => {
  const saved = { ...scope, state: 'saved', asOf: 1795312000123 };
  let result = { ...saved, endedAt: 123, projectName: 'not part of the saved DTO', privateClaim: 'must not leak' };
  const f = await routes(() => ({ current: () => result,
    read: (selection, gen, guard) => gen === saved.generation && guard() ? witness[selection.view] : unavailable }));
  await checked(await f.send(`${prefix}/current`), 200, saved);
  for (const path of ['/api/overview', '/api/factgraph', '/api/channels', '/api/channel/verification']) {
    await checked(await f.send(prefix + path, { headers: header }), 200, witness[dashboardSelection(path).view]);
  }
  await checked(await f.send(`${prefix}/api/factgraph`, { headers: { [generation]: 'old' } }), 409, unavailable);
  await checked(await f.send(`${prefix}/api/factgraph`, { headers: header, stamp: () => requestStamp({}, { document: {} }) }), 403, unavailable);
  for (const asOf of [undefined, null, '1795312000123', -1, 0, 1.25, 8640000000000001]) {
    result = { ...saved, asOf }; await checked(await f.send(`${prefix}/current`), 503, unavailable);
  }
  for (const invalid of [{ projectId: '../other' }, { generation: 'a,b' }]) {
    result = { ...saved, ...invalid }; await checked(await f.send(`${prefix}/current`), 503, unavailable);
  }
});

test('unauthorized or out-of-scope Host stamps never reach Project', async () => {
  const f = await routes();
  for (const value of [null, requestStamp({ appId: 'foreign-app' }), requestStamp({}, { appId: 'foreign-app' }),
    requestStamp({ credentialKind: 'other' }), requestStamp({ credentialId: null }), requestStamp({ kind: 'local_user' }),
    requestStamp({ connectionKind: 'lan' }), requestStamp({ connectionKind: 'relay' }), requestStamp({ connectionKind: 'custom_remote' }),
    requestStamp({}, { agentId: 'selected-fixture-agent' }), requestStamp({}, { document: {} })]) {
    await checked(await f.send(`${prefix}/current`, { stamp: () => value, headers: { 'x-hana-app-id': 'hana-math' } }), 403, unavailable);
    await checked(await f.send(`${prefix}/api/factgraph`, { stamp: () => value, headers: header }), 403, unavailable);
  }
  assert.deepEqual(f.calls, []);
});

test('method, fixed path, query and generation constraints apply before I/O', async () => {
  const f = await routes();
  for (const path of ['/api/project/opaque', '/api/channel/private', '/api/channel/%63onclusion', '/api/overview/'])
    assert.equal((await f.send(prefix + path, { headers: header })).status, 404);
  assert.equal((await f.send(`${prefix}/api/overview`, { method: 'POST', headers: header })).status, 404);
  await checked(await f.send(`${prefix}/current`, { method: 'HEAD' }), 405, unavailable);
  for (const query of ['projectId=other', 'limit=1', 'unused=']) await checked(await f.send(`${prefix}/api/channels?${query}`, { headers: header }), 400, unavailable);
  await checked(await f.send(`${prefix}/current?projectId=other`), 400, unavailable);
  await checked(await f.send(`${prefix}/current`, { headers: header }), 400, unavailable);
  for (const g of [undefined, '', 'two, tags', 'a'.repeat(257)]) await checked(await f.send(`${prefix}/api/overview`,
    { headers: g === undefined ? {} : { [generation]: g } }), 400, unavailable);
  assert.deepEqual(f.calls, []);
  await checked(await f.send(`${prefix}/api/overview`, { headers: { [generation]: 'stale' } }), 409, unavailable);
  assert.equal(f.calls.length, 1, 'stale generation goes only to the protected reader');
});

test('only the exact fulfilled transport busy sentinel changes a protected GET conflict body', async () => {
  const busy = { state: 'unavailable', reason: 'project_busy' };
  let result = workspaceProjectBusy, throwing = false;
  const f = await routes(() => ({ current: () => busy, async read() { if (throwing) throw result; return result; } }));
  await checked(await f.send(`${prefix}/current`), 200, unavailable);
  for (const route of ['/api/overview', '/api/factgraph', '/api/channel/plan']) {
    await checked(await f.send(prefix + route, { headers: header }), 409, busy);
  }
  for (const lookalike of [busy, { ...busy, private: 'do not disclose this' }, { state: 'unavailable', reason: 'other' }]) {
    result = lookalike;
    await checked(await f.send(`${prefix}/api/overview`, { headers: header }), 409, unavailable);
  }
  result = { reason: 'project_busy' };
  await checked(await f.send(`${prefix}/api/overview`, { headers: header }), 503, unavailable);
  throwing = true; result = workspaceProjectBusy;
  await checked(await f.send(`${prefix}/api/overview`, { headers: header }), 409, unavailable);
});

test('a late transport busy sentinel cannot override a revoked route guard', async () => {
  let finish;
  const f = await routes(() => ({ current: () => scope, read: () => new Promise(resolve => { finish = resolve; }) }));
  const abort = new AbortController();
  const response = f.send(`${prefix}/api/overview`, { headers: header, signal: abort.signal });
  abort.abort(); finish(workspaceProjectBusy);
  await checked(await response, 403, unavailable);
});

test('aborted and replaced requests cannot reach the reader or disclose a late response', async () => {
  let resume, guarded;
  const f = await routes(() => ({ current: () => scope, async read(selection, gen, guard) {
    assert.equal(guard(), true);
    await new Promise(done => { resume = done; });
    guarded = guard();
    return witness[selection.view]; // Even if the reader resolves, the route drops this after revocation.
  } }));
  const abort = new AbortController();
  let stamp = requestStamp();
  const inFlight = f.send(`${prefix}/api/factgraph`, { signal: abort.signal, headers: header, stamp: () => stamp, stable: false });
  abort.abort(); stamp = null; resume();
  await checked(await inFlight, 403, unavailable);
  assert.equal(guarded, false);
  await checked(await f.send(`${prefix}/current`, { signal: abort.signal }), 403, unavailable);
  assert.equal(f.calls.length, 1);
});

test('not-ready, malformed and throwing Project interfaces fail closed without a legacy fallback', async () => {
  const noInterface = await routes(() => undefined);
  assert.ok(noInterface.handlers.has(`GET ${LIVE_ACTIVATE}`));
  assert.equal((await noInterface.send(`${prefix}/current`)).status, 404);
  const badInterface = await routes(() => ({}));
  await checked(await badInterface.send(`${prefix}/current`), 503, unavailable);
  const incompatible = await routes(() => ({ current: () => ({ status: 'selected', projectId: 'must-not-expose' }),
    read: () => Response.json({ nodes: [], edges: [] }) }));
  await checked(await incompatible.send(`${prefix}/current`), 503, unavailable);
  await checked(await incompatible.send(`${prefix}/api/factgraph`, { headers: header }), 503, unavailable);
  const failed = await routes(() => ({ current: () => ({ state: 'unavailable', projectId: 'must-not-expose' }),
    async read() { throw new Error('reader-private-fixture'); } }));
  await checked(await failed.send(`${prefix}/current`), 200, unavailable);
  await checked(await failed.send(`${prefix}/api/factgraph`, { headers: header }), 409, unavailable);
  const idle = await routes(() => ({ current: () => ({ state: 'idle', projectId: 'must-not-expose' }), read: () => assert.fail('no read') }));
  await checked(await idle.send(`${prefix}/current`), 200, { state: 'idle' });
});
