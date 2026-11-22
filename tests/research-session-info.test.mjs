// Public SDK over fixed producer-shaped bus fixtures; no host/model/network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppSdk } from '../packages/hana-math/sdk/app-contract/server-client.js';
import { readResearchSessionInfo } from '../packages/hana-math/research-session-info.mjs';
import { confirmResearchSessionStop } from '../packages/hana-math/research-sessions.mjs';

function fixture() {
  const identity = { sessionId: 'stable-fixture', ownerPluginId: 'hana-math', visibility: 'plugin_private', agentId: 'saved-main',
    cwd: '/fixture/research/run/main', path: '/fixture/current-session.jsonl' };
  const get = { ...identity, namespace: 'app', sessionKind: 'internal-not-authority' };
  const row = { ...identity, kind: 'math-research:fixture:0', lifecycle: 'active' };
  const replies = { 'session:get': { session: get }, 'session:list': { sessions: [row] } };
  const hooks = {}, calls = [];
  const sdk = createAppSdk({ dataDir: '/fixture/data', models: {}, tools: {}, hooks: {}, media: {}, providers: {}, storage: { global: {}, agent: () => ({}) },
    bus: { async request(verb, input) {
      calls.push({ verb, input: structuredClone(input) });
      if (hooks[verb]) return hooks[verb](input);
      if (Object.hasOwn(replies, verb)) return structuredClone(replies[verb]);
      if (verb === 'session:abort') return { sessionId: identity.sessionId, aborted: false };
      if (verb === 'session:context') return { sessionId: identity.sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0, systemPrompt: 'fixture', model: {} };
      assert.fail(`Unexpected SDK operation ${verb}`);
    } },
  });
  const record = { ...identity, kind: row.kind, sendState: 'accepted', sendPending: false, state: 'completed', modelStopReason: 'stop' };
  return { sdk, identity, get, row, record, replies, hooks, calls, read: (ref = { sessionId: identity.sessionId }) => readResearchSessionInfo(sdk, ref) };
}

test('official get/list projections jointly prove the session, never internal sessionKind', async () => {
  const f = fixture(); const result = await f.read({ sessionPath: '/fixture/host-alias.jsonl' });
  assert.deepEqual(result, { ...f.identity, namespace: 'app', kind: f.row.kind, lifecycle: 'active' });
  assert.equal(Object.hasOwn(result, 'sessionKind'), false);
  assert.deepEqual(f.calls, [
    { verb: 'session:get', input: { sessionPath: '/fixture/host-alias.jsonl' } },
    { verb: 'session:list', input: { scope: 'own', lifecycle: 'all', ownerPluginId: 'hana-math', agentId: 'saved-main' } },
  ]);
  assert.equal(Object.hasOwn(f.get, 'kind'), false); assert.equal(Object.hasOwn(f.get, 'lifecycle'), false); assert.equal(Object.hasOwn(f.row, 'namespace'), false);
});

test('future fully populated projections work only when public fields agree', async () => {
  const f = fixture(); Object.assign(f.get, { kind: f.row.kind, lifecycle: 'active' }); f.row.namespace = 'app';
  assert.equal((await f.read()).kind, f.row.kind);
});

for (const [label, change] of [
  ['get namespace absent', (f) => { delete f.get.namespace; f.row.namespace = 'app'; }],
  ['get non-app namespace', (f) => { f.get.namespace = 'home'; }],
  ['get foreign owner', (f) => { f.get.ownerPluginId = 'foreign'; }],
  ['get public visibility', (f) => { f.get.visibility = 'public'; }],
  ['get agent missing', (f) => { delete f.get.agentId; }],
  ['get cwd missing', (f) => { delete f.get.cwd; }],
  ['get locator missing', (f) => { delete f.get.path; }],
  ['get wrong stable ID', (f) => { f.get.sessionId = 'other'; }],
  ['list namespace contradictory', (f) => { f.row.namespace = 'code'; }],
  ['list namespace explicit null', (f) => { f.row.namespace = null; }],
  ['list owner contradictory', (f) => { f.row.ownerPluginId = 'foreign'; }],
  ['list visibility contradictory', (f) => { f.row.visibility = 'public'; }],
  ['list agent contradictory', (f) => { f.row.agentId = 'other-agent'; }],
  ['list cwd contradictory', (f) => { f.row.cwd = '/other-project'; }],
  ['list locator contradictory', (f) => { f.row.path = '/other-session.jsonl'; }],
  ['public get kind contradictory', (f) => { f.get.kind = 'another-kind'; }],
  ['public get lifecycle contradictory', (f) => { f.get.lifecycle = 'archived'; }],
  ['list public kind absent despite internal kind', (f) => { delete f.row.kind; }],
  ['list lifecycle absent', (f) => { delete f.row.lifecycle; }],
  ['list lifecycle unknown', (f) => { f.row.lifecycle = 'unloaded'; }],
  ['stable ID absent from list', (f) => { f.replies['session:list'] = { sessions: [] }; }],
  ['stable ID duplicate', (f) => { f.replies['session:list'].sessions.push({ ...f.row }); }],
  ['stable ID duplicate with foreign owner', (f) => { f.replies['session:list'].sessions.push({ ...f.row, ownerPluginId: 'foreign' }); }],
]) test(`${label} fails closed before any stop`, async () => {
  const f = fixture(); change(f);
  await assert.rejects(f.read(), { code: 'SESSION_INFO_INVALID' });
  assert.equal(f.calls.some((c) => c.verb === 'session:abort'), false);
});

for (const verb of ['session:get', 'session:list']) {
  for (const reply of [null, {}, { ok: false }, { error: 'not-ready' }]) test(`${verb} not-ready reply ${JSON.stringify(reply)} is not authority`, async () => {
    const f = fixture(); f.replies[verb] = reply;
    await assert.rejects(f.read(), { code: 'SESSION_INFO_INVALID' });
  });
  test(`${verb} SDK rejection retains its code`, async () => {
    const f = fixture(); f.hooks[verb] = async () => { throw Object.assign(new Error('fixture permission failure'), { code: 'APP_CAPABILITY_DENIED' }); };
    await assert.rejects(f.read(), { code: 'APP_CAPABILITY_DENIED' });
  });
  test(`${verb} unfinished lookup is bounded and cannot later authorize an abort`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(); let entered; const ready = new Promise((resolve) => { entered = resolve; });
    f.hooks[verb] = () => { entered(); return new Promise(() => {}); };
    const pending = assert.rejects(f.read(), { code: 'AUTHORITY_TIMEOUT' });
    await ready; t.mock.timers.tick(10000); await pending;
    assert.equal(f.calls.some((c) => c.verb === 'session:abort'), false);
  });
}

test('explicit home namespace accepts only owned public get/list projections; default and stop stay private', async () => {
  const f = fixture(); f.get.namespace = 'home'; f.get.visibility = f.row.visibility = 'public';
  f.get.modelId = f.row.modelId = 'fixture-model'; f.get.modelProvider = 'fixture-provider';
  const result = await readResearchSessionInfo(f.sdk, { sessionId: f.identity.sessionId }, { namespace: 'home' });
  assert.equal(result.namespace, 'home'); assert.equal(result.visibility, 'public'); assert.equal(result.ownerPluginId, 'hana-math');
  assert.equal(result.modelId, 'fixture-model'); assert.equal(result.modelProvider, 'fixture-provider');
  assert.deepEqual(result.modelProjection, {
    get: { modelId: { state: 'value', value: 'fixture-model' }, modelProvider: { state: 'value', value: 'fixture-provider' } },
    list: { modelId: { state: 'value', value: 'fixture-model' }, modelProvider: { state: 'missing' } },
  });
  await assert.rejects(f.read(), { code: 'SESSION_INFO_INVALID' });
  await assert.rejects(confirmResearchSessionStop(f.sdk, f.record), { code: 'STOP_SESSION_MISMATCH' });
  assert.equal(f.calls.some((call) => call.verb === 'session:abort'), false);
});

for (const [label, change] of [
  ['private visibility', (f) => { f.get.visibility = f.row.visibility = 'plugin_private'; }],
  ['other owner', (f) => { f.get.ownerPluginId = f.row.ownerPluginId = 'other'; }],
  ['namespace absent', (f) => { delete f.get.namespace; }],
  ['namespace code', (f) => { f.get.namespace = 'code'; }],
  ['list visibility mismatch', (f) => { f.row.visibility = 'plugin_private'; }],
  ['list namespace mismatch', (f) => { f.row.namespace = 'app'; }],
  ['list model mismatch', (f) => { f.get.modelId = 'selected'; f.row.modelId = 'other'; }],
  ['duplicate stable ID', (f) => { f.replies['session:list'].sessions.push({ ...f.row }); }],
  ['foreign duplicate stable ID', (f) => { f.replies['session:list'].sessions.push({ ...f.row, ownerPluginId: 'other' }); }],
]) test(`explicit home refuses ${label}`, async () => {
  const f = fixture(); f.get.namespace = 'home'; f.get.visibility = f.row.visibility = 'public'; change(f);
  await assert.rejects(readResearchSessionInfo(f.sdk, { sessionId: f.identity.sessionId }, { namespace: 'home' }), { code: 'SESSION_INFO_INVALID' });
});

for (const getMode of ['missing', 'null', 'value']) for (const listMode of ['missing', 'null', 'value']) {
  test(`home diagnostics distinguish get=${getMode} from list=${listMode} without claiming current model authority`, async () => {
    const f = fixture(); f.get.namespace = 'home'; f.get.visibility = f.row.visibility = 'public';
    for (const [row, mode] of [[f.get, getMode], [f.row, listMode]]) for (const key of ['modelId', 'modelProvider']) {
      if (mode !== 'missing') row[key] = mode === 'null' ? null : 'fixture-model-part';
    }
    const result = await readResearchSessionInfo(f.sdk, { sessionId: f.identity.sessionId }, { namespace: 'home' });
    for (const [side, mode] of [['get', getMode], ['list', listMode]]) for (const key of ['modelId', 'modelProvider']) {
      assert.deepEqual(result.modelProjection[side][key], mode === 'missing' ? { state: 'missing' }
        : { state: mode, value: mode === 'null' ? null : 'fixture-model-part' });
    }
    assert.deepEqual(f.calls.map((call) => call.verb), ['session:get', 'session:list']);
  });
}

for (const key of ['modelId', 'modelProvider']) test(`conflicting nonnull ${key} retains both narrow projections on the failure`, async () => {
  const f = fixture(); f.get.namespace = 'home'; f.get.visibility = f.row.visibility = 'public';
  f.get[key] = 'selected'; f.row[key] = 'other';
  await assert.rejects(readResearchSessionInfo(f.sdk, { sessionId: f.identity.sessionId }, { namespace: 'home' }), (error) => {
    assert.equal(error.code, 'SESSION_INFO_INVALID');
    assert.deepEqual(error.modelProjection.get[key], { state: 'value', value: 'selected' });
    assert.deepEqual(error.modelProjection.list[key], { state: 'value', value: 'other' });
    return true;
  });
});

for (const value of [undefined, '', 'x'.repeat(257), 1, [], {}, 'bad\nmodel']) test(`invalid optional model metadata ${JSON.stringify(value)} is not serialized as public data`, async () => {
  const f = fixture(); f.get.namespace = 'home'; f.get.visibility = f.row.visibility = 'public'; f.get.modelId = value;
  await assert.rejects(readResearchSessionInfo(f.sdk, { sessionId: f.identity.sessionId }, { namespace: 'home' }), (error) => {
    assert.equal(error.code, 'SESSION_INFO_INVALID'); assert.deepEqual(error.modelProjection.get.modelId, { state: 'invalid' });
    assert.deepEqual(Object.keys(error.modelProjection.get), ['modelId', 'modelProvider']); return true;
  });
});

test('home projection reads only public data descriptors and ignores unrelated getter fields', async () => {
  const f = fixture(); f.get.namespace = 'home'; f.get.visibility = f.row.visibility = 'public';
  f.get.modelId = null; f.row.modelProvider = null;
  for (const row of [f.get, f.row]) Object.defineProperty(row, 'systemPrompt', { enumerable: true, get() { assert.fail('Private field read'); } });
  f.hooks['session:get'] = () => ({ session: f.get }); f.hooks['session:list'] = () => ({ sessions: [f.row] });
  const result = await readResearchSessionInfo(f.sdk, { sessionId: f.identity.sessionId }, { namespace: 'home' });
  assert.doesNotMatch(JSON.stringify(result), /systemPrompt/);
  Object.defineProperty(f.get, 'modelId', { enumerable: true, get() { assert.fail('Model metadata accessor invoked'); } });
  await assert.rejects(readResearchSessionInfo(f.sdk, { sessionId: f.identity.sessionId }, { namespace: 'home' }), (error) => {
    assert.deepEqual(error.modelProjection.get.modelId, { state: 'invalid' }); return error.code === 'SESSION_INFO_INVALID';
  });
});

test('default private read neither inspects nor exports optional model metadata', async () => {
  const f = fixture();
  for (const row of [f.get, f.row]) for (const key of ['modelId', 'modelProvider']) {
    Object.defineProperty(row, key, { enumerable: true, get() { assert.fail('Default private model behavior changed'); } });
  }
  f.hooks['session:get'] = () => ({ session: f.get }); f.hooks['session:list'] = () => ({ sessions: [f.row] });
  const result = await f.read();
  assert.deepEqual(result, { ...f.identity, namespace: 'app', kind: f.row.kind, lifecycle: 'active' });
});

for (const options of [null, {}, { namespace: 'code' }, { namespace: 'all' }, { namespace: 'home', scope: 'all' },
  { namespace: 'home', ownerPluginId: 'other' }, { namespace: 'home', visibility: 'plugin_private' }]) {
  test(`namespace options ${JSON.stringify(options)} cannot widen authority`, async () => {
    const f = fixture();
    await assert.rejects(readResearchSessionInfo(f.sdk, { sessionId: f.identity.sessionId }, options), { code: 'SESSION_INFO_INVALID' });
    assert.equal(f.calls.length, 0);
  });
}

test('explicit app keeps the exact default projection', async () => {
  const f = fixture();
  assert.deepEqual(await readResearchSessionInfo(f.sdk, { sessionId: f.identity.sessionId }, { namespace: 'app' }), await f.read());
});

test('stop obtains public kind/lifecycle by exact get+list before confirming idle', async () => {
  const f = fixture();
  assert.deepEqual(await confirmResearchSessionStop(f.sdk, f.record), { abortOutcome: 'idle-confirmed', sessionPath: f.identity.path });
  assert.deepEqual(f.calls.map((c) => c.verb), ['session:get', 'session:list', 'session:abort', 'session:context']);
});

for (const mode of ['archived', 'wrong-kind', 'list-missing']) test(`stop refuses ${mode} even if get appears owned`, async () => {
  const f = fixture();
  if (mode === 'archived') f.row.lifecycle = 'archived';
  else if (mode === 'wrong-kind') f.row.kind = 'unrelated';
  else f.replies['session:list'] = {};
  await assert.rejects(confirmResearchSessionStop(f.sdk, f.record), { code: 'STOP_SESSION_MISMATCH' });
  assert.equal(f.calls.some((c) => c.verb === 'session:abort'), false);
});
