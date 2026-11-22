import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppSdk } from '../packages/hana-math/sdk/app-contract/server-client.js';
import { createResearchBindings, assertResearchOwner, researchToolNames, researchAppToolNames,
  RESEARCH_ROLE_TOOLS, RESEARCH_IO_TOOLS } from '../packages/hana-math/research-bindings.mjs';

// Official SDK over a fixed bus fixture, never a real host/model/filesystem.
// Agent metadata matches profile.test.mjs and app-contract/agents.d.ts;
// Current producers differ: get includes namespace but omits kind/lifecycle;
// list supplies kind/lifecycle but omits namespace. Neither is a create receipt.
const clone = structuredClone;
const getProjection = (session) => { const { kind, lifecycle, ...value } = clone(session); return { ...value, sessionKind: kind }; };
const listProjection = (session) => { const { namespace, ...value } = clone(session); return value; };
const ownedAgent = (role) => ({ id: `saved-${role}`, name: `Fixture ${role}`, state: 'active', deletedAt: null,
  ownerPluginId: 'hana-math', visibility: 'plugin_private',
  plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'role', roleId: role } });
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
const hasCode = (code) => (error) => error?.code === code;
function fixture(role = 'worker', workerId, cwd = `/fixture/research/fixture-run/${role}`) {
  const binding = { ...(workerId === undefined ? {} : { workerId }), projectId: 'fixture-project', runId: 'fixture-run', role,
    agentId: `saved-${role}`, author: `saved-${role}`, sessionId: 'stable-session',
    sessionPath: '/fixture/sessions/original.jsonl', cwd };
  const session = { sessionId: binding.sessionId, path: binding.sessionPath, namespace: 'app',
    title: 'Opaque SDK fixture', firstMessage: 'Opaque fixture', agentId: binding.agentId,
    agentName: `Fixture ${role}`, modelId: 'opaque-model', messageCount: 0, cwd: binding.cwd,
    modified: 'fixture-time', ownerPluginId: 'hana-math', kind: 'research.fixture-run',
    visibility: 'plugin_private', lifecycle: 'active', archivedAt: null, thinkingLevel: null };
  const calls = []; const changes = []; const hooks = {};
  const state = { agents: [ownedAgent(role)], session, active: new Map([[binding.runId, true]]) };
  const context = { dataDir: '/unused-fixture', models: {}, tools: {}, hooks: {},
    storage: { global: {}, agent: () => ({}) }, media: {}, providers: {},
    bus: { async request(verb, input) {
    calls.push({ verb, input: clone(input) });
    if (hooks[verb]) return hooks[verb](input);
    if (verb === 'session:get') return { session: getProjection(state.session) };
    if (verb === 'session:list') {
      assert.deepEqual(input, { scope: 'own', lifecycle: 'all', ownerPluginId: 'hana-math', agentId: state.session.agentId });
      return { sessions: [listProjection(state.session)] };
    }
    if (verb === 'agent:list') return { agents: clone(state.agents) };
    assert.fail(`Unexpected SDK operation ${verb}`);
  } } };
  const sdk = createAppSdk(context);
  const service = createResearchBindings(sdk, {
    isRunActive: (runId) => state.active.get(runId),
    onLocatorChanged: async (changed) => { changes.push(clone(changed)); if (hooks.locator) await hooks.locator(changed); },
  });
  const invocation = { callToken: 'opaque-host-stamped-token', sessionPath: binding.sessionPath };
  service.register(binding);
  return { service, sdk, state, binding, invocation, calls, hooks, changes,
    authorize: (tool = 'search_arxiv_theorems', caller = invocation) => service.authorize(tool, caller) };
}

test('trusted logical worker identity survives authorization; other roles and malformed identities reject it', async () => {
  const f = fixture('worker', 'worker-one');
  assert.equal((await f.authorize('math_local_memory')).workerId, 'worker-one');
  assert.equal(f.service.snapshot()[0].workerId, 'worker-one');
  assert.equal(Object.hasOwn(await fixture().authorize(), 'workerId'), false);
  for (const role of ['main', 'verifier']) assert.throws(() => fixture(role, 'worker-one'), { code: 'BINDING_INVALID' });
  for (const workerId of ['', '../other', '/other', null, undefined]) {
    assert.throws(() => f.service.register({ ...f.binding, sessionId: 'other-session', workerId }), { code: 'BINDING_INVALID' });
  }
});

test('backend worker on a Windows drive retains exact Host cwd and cannot use another drive or locator alias as its identity', async () => {
  const cwd = String.raw`D:\Hana 工作区\project-fixture\worker-1`;
  const f = fixture('worker', 'worker-1', cwd);
  assert.equal((await f.authorize('fact_submit')).cwd, cwd);
  f.state.session.cwd = cwd.replace('D:', 'C:');
  await assert.rejects(f.authorize('fact_submit'), hasCode('CALLER_UNBOUND'));
  for (const bad of ['D:relative', String.raw`\root-relative`, String.raw`\\host\share`, String.raw`\\?\C:\fake`, String.raw`C:\root\..\other`])
    assert.throws(() => fixture('worker', 'worker-1', bad), hasCode('BINDING_INVALID'));
});

const expectedRoles = {
  main: ['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems'],
  worker: ['gm_add', 'gm_search', 'fact_submit', 'fact_search', 'search_arxiv_theorems'],
  verifier: ['search_arxiv_theorems'],
};
const expectedIO = { main: ['math_assign'], worker: ['math_local_memory'], verifier: ['math_verification_report'] };

test('host resolves invocation path to stable ID; only host locator changes persist', async () => {
  const f = fixture();
  f.invocation.sessionPath = '/fixture/host-alias.jsonl';
  f.state.session.path = '/fixture/sessions/moved.jsonl';
  const result = await f.authorize();
  assert.equal(result.sessionId, 'stable-session');
  assert.equal(result.sessionPath, f.state.session.path);
  assert.deepEqual(f.calls, [{ verb: 'session:get', input: { sessionPath: '/fixture/host-alias.jsonl' } },
    { verb: 'session:list', input: { scope: 'own', lifecycle: 'all', ownerPluginId: 'hana-math', agentId: f.binding.agentId } },
    { verb: 'agent:list', input: { lifecycle: 'all' } }]);
  assert.deepEqual(f.changes, [result]);
  await f.authorize(); assert.equal(f.changes.length, 1);
});

for (const role of Object.keys(expectedRoles)) test(`${role} exact public tool table and dispatch authority`, async () => {
  assert.deepEqual(RESEARCH_ROLE_TOOLS[role], expectedRoles[role]);
  assert.deepEqual(RESEARCH_IO_TOOLS[role], expectedIO[role]);
  assert.deepEqual(researchAppToolNames(role), [...expectedRoles[role], ...expectedIO[role]]);
  assert.deepEqual(researchAppToolNames(role, { assign: false }), [...expectedRoles[role], ...expectedIO[role].filter((name) => name !== 'math_assign')]);
  assert.deepEqual(researchToolNames(role), ['read', 'web_search', 'web_fetch', ...expectedRoles[role], ...expectedIO[role]]);
  assert.deepEqual(researchToolNames(role, { assign: false }),
    ['read', 'web_search', 'web_fetch', ...expectedRoles[role], ...expectedIO[role].filter((name) => name !== 'math_assign')]);
  const f = fixture(role);
  const allowed = [...expectedRoles[role], ...expectedIO[role]];
  for (const name of allowed) assert.equal((await f.authorize(name)).role, role);
  const all = new Set([...Object.values(expectedRoles).flat(), ...Object.values(expectedIO).flat(),
    'exec', 'write', 'read', 'web_search', 'web_fetch', 'constructor', 'fact_get', 'app:hana-math/fact_submit']);
  for (const name of all) if (!allowed.includes(name)) await assert.rejects(f.authorize(name), hasCode('ROLE_DENIED'));
  // read is intentionally host-owned, not a facade-dispatched authority.
});

for (const [key, value] of [
  ['ownerPluginId', 'foreign-app'], ['ownerPluginId', null], ['namespace', 'home'], ['namespace', 'code'],
  ['visibility', 'public'], ['visibility', 'private'], ['lifecycle', 'archived'], ['lifecycle', undefined],
  ['sessionId', 'unknown-session'], ['sessionId', 123], ['sessionId', null],
  ['agentId', 'foreign-active-agent'], ['agentId', undefined], ['cwd', '/fixture/different-run'], ['cwd', null],
]) test(`host session mismatch ${key}=${String(value)} rejects`, async () => {
  const f = fixture(); f.state.session[key] = value;
  await assert.rejects(f.authorize(), hasCode('CALLER_UNBOUND'));
  assert.equal(f.changes.length, 0);
});

for (const [label, change] of [
  ['retired', (a) => { a.state = 'retired'; }],
  ['state-missing', (a) => { delete a.state; }],
  ['deleted', (a) => { a.deletedAt = 'fixture-time'; }],
  ['foreign-owner', (a) => { a.ownerPluginId = 'foreign'; }],
  ['public', (a) => { a.visibility = 'public'; }],
  ['foreign-plugin-owner', (a) => { a.plugin.ownerPluginId = 'foreign'; }],
  ['public-plugin', (a) => { a.plugin.visibility = 'public'; }],
  ['not-role', (a) => { a.plugin.kind = 'assistant'; }],
  ['wrong-role', (a) => { a.plugin.roleId = 'main'; }],
  ['missing-plugin', (a) => { delete a.plugin; }],
]) test(`owned role metadata ${label} rejects`, async () => {
  const f = fixture(); change(f.state.agents[0]);
  await assert.rejects(f.authorize(), hasCode('ROLE_DENIED'));
});

for (const visibility of ['plugin_private', 'private']) test(`profile-compatible agent visibility ${visibility}`, async () => {
  const f = fixture(); f.state.agents[0].visibility = visibility; f.state.agents[0].plugin.visibility = visibility;
  assert.equal((await f.authorize()).agentId, f.binding.agentId);
});

test('missing/duplicate agent identity and explicit SDK failure fail closed', async () => {
  for (const agents of [[], [ownedAgent('worker'), ownedAgent('worker')]]) {
    const f = fixture(); f.state.agents = agents;
    await assert.rejects(f.authorize(), hasCode('ROLE_DENIED'));
  }
  for (const reply of [{ ok: false, agents: [ownedAgent('worker')] }, {}, { agents: null }]) {
    const f = fixture(); f.hooks['agent:list'] = async () => reply;
    await assert.rejects(f.authorize(), hasCode('AUTHORITY_UNAVAILABLE'));
  }
  for (const reply of [{ session: null }, { ok: false, session: fixture().state.session }]) {
    const f = fixture(); f.hooks['session:get'] = async () => reply;
    await assert.rejects(f.authorize(), hasCode('CALLER_UNBOUND'));
  }
});

test('external invocations and invented context authority cannot bind an unknown session', async () => {
  const f = fixture();
  for (const caller of [null, {}, [], { sessionPath: f.binding.sessionPath },
    { callToken: '', sessionPath: f.binding.sessionPath }, { callToken: 1, sessionPath: f.binding.sessionPath }]) {
    await assert.rejects(f.authorize('fact_search', caller), hasCode('CALLER_UNBOUND'));
  }
  assert.equal(f.calls.length, 0);
  f.state.session.sessionId = 'unknown';
  await assert.rejects(f.authorize('fact_submit', { ...f.invocation, role: 'worker', projectId: f.binding.projectId,
    runId: f.binding.runId, sessionId: f.binding.sessionId }), hasCode('CALLER_UNBOUND'));
});

for (const value of [false, undefined, null, 0, 1, 'true', {}, Promise.resolve(true)]) {
  test(`isRunActive requires strict true, not ${String(value)}`, async () => {
    const f = fixture(); f.state.active.set(f.binding.runId, value);
    await assert.rejects(f.authorize(), hasCode('CALLER_UNBOUND'));
    assert.equal(f.calls.some((call) => call.verb === 'agent:list'), false);
  });
}

test('run filtering and closeRun never close another run with the same agent', async () => {
  const f = fixture();
  const second = { ...f.binding, runId: 'second-run', sessionId: 'second-session',
    cwd: '/fixture/research/second-run/worker', sessionPath: '/fixture/second.jsonl' };
  f.service.register(second); f.state.active.set(second.runId, true);
  f.service.closeRun(f.binding.runId);
  await assert.rejects(f.authorize(), hasCode('CALLER_UNBOUND'));
  f.state.session = { ...f.state.session, sessionId: second.sessionId, cwd: second.cwd, path: second.sessionPath };
  assert.equal((await f.authorize()).runId, second.runId);
  assert.equal(f.service.snapshot(f.binding.runId)[0].active, false);
  assert.equal(f.service.snapshot(second.runId)[0].active, true);
  f.state.session.cwd = f.binding.cwd;
  await assert.rejects(f.authorize(), hasCode('CALLER_UNBOUND'));
});

for (const stage of ['session:get', 'session:list', 'agent:list', 'locator']) {
  for (const action of ['close', 'closeRun', 'stop']) test(`${action} while awaiting ${stage} rejects authorization`, async () => {
    const f = fixture(); const entered = deferred(); const release = deferred();
    if (stage === 'locator') f.state.session.path = '/fixture/moved.jsonl';
    f.hooks[stage] = async () => {
      entered.resolve(); await release.promise;
      return stage === 'session:get' ? { session: getProjection(f.state.session) }
        : stage === 'session:list' ? { sessions: [listProjection(f.state.session)] } : { agents: clone(f.state.agents) };
    };
    const authorization = f.authorize();
    await entered.promise;
    if (action === 'close') f.service.close(f.binding.sessionId);
    else if (action === 'closeRun') f.service.closeRun(f.binding.runId);
    else f.state.active.set(f.binding.runId, false);
    release.resolve();
    await assert.rejects(authorization, hasCode(['session:get', 'session:list'].includes(stage) ? 'CALLER_UNBOUND' : 'RUN_INACTIVE'));
    assert.equal(f.service.snapshot()[0].sessionPath, f.binding.sessionPath);
  });
}

test('isRunActive also requires strict true after locator persistence', async () => {
  const f = fixture(); f.state.session.path = '/fixture/moved.jsonl';
  f.hooks.locator = async () => { f.state.active.set(f.binding.runId, 1); };
  await assert.rejects(f.authorize(), hasCode('RUN_INACTIVE'));
  assert.equal(f.service.snapshot()[0].sessionPath, f.binding.sessionPath);
});

test('explicitly inactive binding cannot authorize even with an active run', async () => {
  const f = fixture();
  f.service.register({ ...f.binding, sessionId: 'inactive-session', active: false });
  f.state.session.sessionId = 'inactive-session';
  await assert.rejects(f.authorize(), hasCode('CALLER_UNBOUND'));
  assert.throws(() => createResearchBindings(f.sdk), TypeError);
});

test('locator persistence rejection never changes binding; successful retry updates it', async () => {
  const f = fixture(); f.state.session.path = '/fixture/moved.jsonl';
  const failure = Object.assign(new Error('opaque fixture storage failure'), { code: 'FIXTURE_WRITE_FAILED' });
  f.hooks.locator = async (changed) => { changed.role = 'main'; throw failure; };
  await assert.rejects(f.authorize(), (error) => error === failure);
  assert.equal(f.service.snapshot()[0].sessionPath, f.binding.sessionPath);
  assert.equal(f.service.snapshot()[0].role, 'worker');
  delete f.hooks.locator;
  assert.equal((await f.authorize()).sessionPath, f.state.session.path);
});

test('missing host locator rejects rather than trusting invocation path', async () => {
  const f = fixture(); delete f.state.session.path;
  await assert.rejects(f.authorize(), hasCode('CALLER_UNBOUND'));
});

test('owner control requires exact originating host-stamped conversation, never token decoding', () => {
  const run = { owner: { sessionId: 'origin-stable', sessionPath: '/fixture/origin.jsonl' } };
  const caller = { callToken: 'opaque-host-token', sessionPath: '/fixture/origin.jsonl' };
  assert.equal(assertResearchOwner(run, caller), undefined);
  for (const path of ['/fixture/foreign.jsonl', '/fixture/moved-origin.jsonl', '/fixture/./origin.jsonl']) {
    assert.throws(() => assertResearchOwner(run, { ...caller, sessionPath: path, sessionId: 'origin-stable' }), hasCode('OWNER_DENIED'));
  }
  for (const owner of [null, {}, { sessionId: '', sessionPath: caller.sessionPath }, { sessionId: 123, sessionPath: caller.sessionPath }]) {
    assert.throws(() => assertResearchOwner({ owner }, caller), hasCode('OWNER_DENIED'));
  }
  assert.throws(() => assertResearchOwner(run, { sessionPath: caller.sessionPath }), hasCode('CALLER_UNBOUND'));
});

test('register validates ID types, role keys, attribution and duplicate stable bindings', () => {
  const f = fixture();
  const invalid = [{ role: 'all' }, { role: 'constructor' }, { role: '__proto__' }, { role: 1 },
    { projectId: 123 }, { runId: 123 }, { agentId: 123, author: 123 }, { sessionId: 123 }, { submissionId: 123 },
    { projectId: '../outside' }, { runId: 'Uppercase' }, { agentId: '../agent' }, { author: 'another-agent' },
    { cwd: 'relative' }, { sessionPath: '' }, { submissionId: '../outside' }];
  for (const change of invalid) assert.throws(() => f.service.register({ ...f.binding, sessionId: 'fresh', ...change }), hasCode('BINDING_INVALID'));
  for (const role of ['all', 'constructor', '__proto__', 1]) assert.throws(() => researchToolNames(role), hasCode('ROLE_INVALID'));
  assert.throws(() => f.service.register({ ...f.binding, runId: 'different-run' }), hasCode('BINDING_CONFLICT'));
  f.service.close(f.binding.sessionId);
  assert.throws(() => f.service.register(f.binding), hasCode('BINDING_CONFLICT'));
});

test('tool role must be a literal string, not an array coerced to a property key', () => {
  assert.throws(() => researchToolNames(['worker']), hasCode('ROLE_INVALID'));
});

test('binding role must be a literal string, not an array coerced to a property key', () => {
  const f = fixture();
  assert.throws(() => f.service.register({ ...f.binding, sessionId: 'fresh', role: ['worker'] }), hasCode('BINDING_INVALID'));
});

test('registered inputs, returned copies, locator callbacks and snapshots cannot mutate authority', async () => {
  const f = fixture();
  const originalAgent = f.binding.agentId;
  f.binding.role = 'main'; f.binding.author = 'spoof';
  const snapshot = f.service.snapshot(); snapshot[0].role = 'main'; snapshot[0].active = false; snapshot.push({});
  const result = await f.authorize(); result.role = 'main'; result.active = false;
  assert.equal((await f.authorize()).role, 'worker');
  assert.equal(f.service.snapshot()[0].author, originalAgent);
  const registered = f.service.register({ ...f.service.snapshot()[0], sessionId: 'second' });
  registered.active = false; registered.role = 'main';
  assert.equal(f.service.snapshot().find((b) => b.sessionId === 'second').role, 'worker');
  f.state.session.path = '/fixture/moved.jsonl';
  f.hooks.locator = async (changed) => { changed.role = 'main'; changed.active = false; changed.author = 'spoof'; };
  const moved = await f.authorize(); assert.equal(moved.role, 'worker'); assert.equal(moved.active, true);
  assert.equal(moved.author, originalAgent);
  assert.throws(() => RESEARCH_ROLE_TOOLS.worker.push('fact_revoke'), TypeError);
});
