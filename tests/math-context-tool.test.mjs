import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCoreCheck, registerMathContext } from '../packages/hana-math/math-context-tool.mjs';
import { profileService, ProfileError } from '../packages/hana-math/profile-service.mjs';

const savedSelection = (role) => ({ role, agentId: `saved-${role}`, instanceState: 'active', model: { provider: 'saved-provider', id: `saved-${role}-model` }, source: 'saved-role' });
async function fixture({ injectProfiles = true } = {}) {
  const calls = []; let definition;
  const operation = (name) => async (...args) => { calls.push([name, ...args]); return { ok: true, operation: name }; };
  const services = {
    contexts: { prepare: operation('prepare'), inspect: operation('inspect') },
    core: { check: operation('core_check') },
    probes: { start: operation('probe'), get: operation('probe_status'), stop: operation('probe_stop') },
  };
  if (injectProfiles) services.profiles = { async getRoleModel(role) { calls.push(['getRoleModel', role]); return savedSelection(role); } };
  const sdk = { tools: { async register(tool) { definition = tool; return { ready: Promise.resolve() }; } } };
  const registered = await registerMathContext(sdk, services);
  return { calls, services, sdk, registered, definition, execute: (input) => definition.execute(input) };
}

test('context tool registers without starting a runtime or inference', async () => {
  const f = await fixture();
  assert.equal(f.definition.name, 'math_context');
  assert.doesNotMatch(JSON.stringify({ description: f.definition.description, parameters: f.definition.parameters }), /\p{Script=Han}/u);
  assert.deepEqual(f.calls, []);
  const response = await f.execute({ action: 'status' });
  assert.equal(response.isError, undefined);
  assert.equal(response.details.result.researchScheduling, 'use_math_research');
  assert.equal(response.details.result.researchToolAdapter, 'six_role_bound_tools');
  assert.equal(response.details.result.mcpReplacement, 'partial');
  assert.equal(response.details.result.verificationEvidence, 'query_actual_run_and_facts');
  assert.equal(response.details.result.core, 'use_core_check');
  assert.equal(response.details.result.modelSource, 'saved-role');
  assert.equal(response.details.result.roleModels, 'use_role_status');
  assert.ok(response.details.result.actions.includes('role_status'));
  assert.equal(Object.hasOwn(f.definition.parameters.properties, 'model'), false);
  assert.match(f.definition.description, /uses only the corresponding role model saved in Math/);
  assert.match(f.definition.description, /without chat-model fallback/);
  assert.deepEqual(f.definition.parameters.properties.role.enum, ['main', 'worker', 'verifier', 'explorer']);
  assert.match(f.definition.parameters.properties.role.description, /role_status reads any of the four/);
  assert.match(f.definition.parameters.properties.role.description, /probe action accepts only main, worker or verifier/);
  assert.deepEqual(f.calls, []);
});

test('model-facing ProfileError messages are English without changing editor errors or codes', async () => {
  const f = await fixture();
  const original = new ProfileError('ROLE_NOT_CONFIGURED', 'Math 角色尚未保存为实例，请先在 Math 中选择模型并保存。');
  f.services.profiles.getRoleModel = async () => { throw original; };
  const response = await f.execute({ action: 'role_status', role: 'worker' });
  assert.equal(response.isError, true); assert.equal(response.details.result.roles[0].error.code, original.code);
  assert.match(response.details.result.roles[0].error.message, /Select a model and save it in Math first/);
  assert.doesNotMatch(response.content[0].text, /\p{Script=Han}/u);
  assert.match(original.message, /角色尚未保存/);
  const probe = await f.execute({ action: 'probe', projectId: 'fixture', role: 'worker' });
  assert.equal(probe.isError, true); assert.equal(probe.details.error.code, original.code);
  assert.doesNotMatch(probe.content[0].text, /\p{Script=Han}/u);
});

test('prepare forwards only the supplied project material', async () => {
  const f = await fixture();
  const payload = { projectId: 'fixture', problem: '中文软件样本，原样保留', operatorProfile: '操作者原文', workerTask: '只读测试原文' };
  await f.execute({ action: 'prepare', ...payload, context: { callToken: 'host-issued-fixture' } });
  assert.deepEqual(f.calls, [['prepare', payload]]);
});

test('probe rejects every model/identity override before lookup and forwards only the saved model with host context', async () => {
  const f = await fixture();
  for (const model of [undefined, null, 'default', {}, { provider: 'saved-provider', id: 'saved-worker-model' }, { provider: 'fixture', id: 'model', apiKey: 'not-allowed' }]) {
    const response = await f.execute({ action: 'probe', projectId: 'fixture', role: 'worker', model });
    assert.equal(response.isError, true); assert.equal(response.details.error.code, 'MATH_CONTEXT_INVALID_INPUT');
  }
  for (const extra of [{ provider: 'override' }, { agentId: 'other' }, { modelSelection: { source: 'saved-role', agentId: 'other' } }, { source: 'chat' }, { thinkingLevel: 'high' }, { cwd: '/outside' }, { author: 'other' }]) {
    const response = await f.execute({ action: 'probe', projectId: 'fixture', role: 'worker', ...extra });
    assert.equal(response.isError, true); assert.equal(response.details.error.code, 'MATH_CONTEXT_INVALID_INPUT');
  }
  assert.deepEqual(f.calls, []);
  const payload = { projectId: 'fixture', role: 'worker' };
  const context = { callToken: 'host-issued-fixture', sessionPath: 'fixture-session', model: { provider: 'chat-provider', id: 'not-a-fallback' } };
  const response = await f.execute({ action: 'probe', ...payload, context });
  assert.equal(response.isError, undefined);
  assert.deepEqual(f.calls, [['getRoleModel', 'worker'], ['probe', { ...payload, model: savedSelection('worker').model, modelSelection: { source: 'saved-role', agentId: 'saved-worker' } }, context]]);
  assert.equal(f.calls[1][2], context);
});

test('role_status queries one or all roles without starting anything and returns only model-selection fields', async () => {
  const f = await fixture();
  f.services.profiles.getRoleModel = async (role) => {
    f.calls.push(['getRoleModel', role]);
    return { ...savedSelection(role), config: { secret: 'PRIVATE_FIXTURE' }, revision: 'PRIVATE_REVISION',
      model: { ...savedSelection(role).model, apiKey: 'PRIVATE_KEY' } };
  };
  const all = await f.execute({ action: 'role_status' });
  assert.equal(all.isError, undefined); assert.equal(all.details.ok, true);
  assert.deepEqual(all.details.result, { ok: true, roles: ['main', 'worker', 'verifier', 'explorer'].map(savedSelection) });
  assert.deepEqual(f.calls, ['main', 'worker', 'verifier', 'explorer'].map((role) => ['getRoleModel', role]));
  assert.doesNotMatch(JSON.stringify(all), /PRIVATE_|config|revision|apiKey/);
  f.calls.length = 0;
  const one = await f.execute({ action: 'role_status', role: 'worker' });
  assert.deepEqual(one.details.result, { ok: true, roles: [savedSelection('worker')] });
  assert.deepEqual(f.calls, [['getRoleModel', 'worker']]);
});

test('role_status reports each failed role, sets top-level ok false and keeps successful role results', async () => {
  const f = await fixture();
  f.services.profiles.getRoleModel = async (role) => {
    f.calls.push(['getRoleModel', role]);
    if (role === 'worker') throw Object.assign(new Error('请先保存角色'), { code: 'ROLE_NOT_CONFIGURED' });
    return savedSelection(role);
  };
  const response = await f.execute({ action: 'role_status' });
  assert.equal(response.isError, true); assert.equal(response.details.ok, false);
  assert.equal(JSON.parse(response.content[0].text).ok, false);
  assert.deepEqual(response.details.result, { ok: false, roles: [savedSelection('main'), { role: 'worker', error: { code: 'ROLE_NOT_CONFIGURED', message: '请先保存角色' } }, savedSelection('verifier'), savedSelection('explorer')] });
  assert.deepEqual(f.calls, ['main', 'worker', 'verifier', 'explorer'].map(role => ['getRoleModel', role]));
});

test('explorer probe is rejected before every lookup/start while all original three probes remain accepted', async () => {
  const f = await fixture(), context = { callToken: 'opaque-fixture-token' };
  const denied = await f.execute({ action: 'probe', projectId: 'fixture', role: 'explorer', context });
  assert.equal(denied.isError, true); assert.equal(denied.details.error.code, 'MATH_CONTEXT_INVALID_INPUT');
  assert.deepEqual(f.calls, []);
  for (const role of ['main', 'worker', 'verifier']) {
    const response = await f.execute({ action: 'probe', projectId: 'fixture', role, context });
    assert.equal(response.isError, undefined);
    assert.deepEqual(f.calls.splice(0), [['getRoleModel', role], ['probe', { projectId: 'fixture', role, model: savedSelection(role).model, modelSelection: { source: 'saved-role', agentId: `saved-${role}` } }, context]]);
  }
});
test('failed explorer role_status retains all healthy business-role DTOs without inference or writes', async () => {
  const f = await fixture();
  f.services.profiles.getRoleModel = async role => {
    f.calls.push(['getRoleModel', role]);
    if (role === 'explorer') throw new ProfileError('EXPLORER_CREATION_UNCONFIRMED', 'Opaque unconfirmed initialization');
    return savedSelection(role);
  };
  const response = await f.execute({ action: 'role_status' });
  assert.equal(response.isError, true); assert.equal(response.details.ok, false);
  assert.deepEqual(response.details.result.roles.slice(0, 3), ['main', 'worker', 'verifier'].map(savedSelection));
  assert.deepEqual(response.details.result.roles[3], { role: 'explorer', error: { code: 'EXPLORER_CREATION_UNCONFIRMED', message: 'The Math profile operation failed; inspect the error code.' } });
  assert.deepEqual(f.calls, ['main', 'worker', 'verifier', 'explorer'].map(role => ['getRoleModel', role]));
});

test('invalid role_status and probe inputs never query saved profiles or start probes', async () => {
  const f = await fixture();
  for (const input of [
    { action: 'role_status', role: null }, { action: 'role_status', role: 'unknown' },
    { action: 'role_status', role: 'main', model: {} }, { action: 'role_status', projectId: 'extra' },
    { action: 'probe', projectId: 'fixture' }, { action: 'probe', projectId: 'fixture', role: 'unknown' },
  ]) assert.equal((await f.execute(input)).isError, true);
  assert.deepEqual(f.calls, []);
});

async function savedProfilesFixture() {
  const f = await fixture({ injectProfiles: false });
  const row = (id = 'hana-math-main') => ({ id, state: 'active', deletedAt: null,
    ownerPluginId: 'hana-math', visibility: 'plugin_private',
    plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'role', roleId: 'main' } });
  const state = { agents: [row()], binding: { agentId: 'hana-math-main' },
    config: { models: { chat: { provider: 'saved-provider', id: 'saved-model', apiKey: 'PRIVATE_MODEL' }, utility: { provider: 'utility', id: 'not-a-fallback' } }, api: { api_key: 'PRIVATE_CONFIG' } } };
  f.sdk.agents = {
    async list(input) { f.calls.push(['agents.list', input]); return { agents: structuredClone(state.agents) }; },
    async config(input) {
      f.calls.push(['agents.config', input]);
      if (state.configError) throw state.configError;
      return state.configMissing ? { error: 'agent_not_found' } : { config: structuredClone(state.config) };
    },
  };
  f.sdk.storage = { global: { async get(key) { f.calls.push(['storage.get', key]); return structuredClone(state.binding); } } };
  return { ...f, state, row };
}

test('tool shares the existing profileService and its default role_status reads no persona, avatar, revision or state writes', async () => {
  const f = await savedProfilesFixture();
  assert.equal(f.registered.profiles, profileService(f.sdk));
  assert.deepEqual(f.calls, []);
  const response = await f.execute({ action: 'role_status', role: 'main' });
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.details.result, { ok: true, roles: [{ role: 'main', agentId: 'hana-math-main', instanceState: 'active', model: { provider: 'saved-provider', id: 'saved-model' }, source: 'saved-role' }] });
  assert.deepEqual(f.calls, [
    ['agents.list', { lifecycle: 'all' }], ['storage.get', 'profile.role.main'],
    ['agents.config', { agentId: 'hana-math-main' }],
    ['agents.list', { lifecycle: 'all' }], ['storage.get', 'profile.role.main'],
  ]);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_|utility|apiKey|revision/);
  f.calls.length = 0;
  const context = { callToken: 'host-issued-fixture' };
  const probe = await f.execute({ action: 'probe', projectId: 'fixture', role: 'main', context });
  assert.equal(probe.isError, undefined);
  assert.deepEqual(f.calls.at(-1), ['probe', { projectId: 'fixture', role: 'main', model: { provider: 'saved-provider', id: 'saved-model' }, modelSelection: { source: 'saved-role', agentId: 'hana-math-main' } }, context]);
});

test('explicit explorer role_status uses saved profiles and exposes only a strict read-only model-selection DTO', async () => {
  const f = await savedProfilesFixture(), id = 'hana-math-explorer';
  f.state.agents = [{ ...f.row(id), identity: 'PRIVATE_PERSONA', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'role', roleId: 'explorer' } }];
  f.state.binding = { agentId: id };
  f.sdk.storage.global.get = async key => { f.calls.push(['storage.get', key]); return key === 'profile.role.explorer' ? structuredClone(f.state.binding) : null; };
  const response = await f.execute({ action: 'role_status', role: 'explorer' });
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.details, { action: 'role_status', ok: true, result: { ok: true, roles: [{ role: 'explorer', agentId: id, instanceState: 'active', model: { provider: 'saved-provider', id: 'saved-model' }, source: 'saved-role' }] } });
  assert.deepEqual(JSON.parse(response.content[0].text), response.details);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_|persona|identity|config|revision|apiKey|utility/);
  assert.deepEqual(f.calls, [
    ['agents.list', { lifecycle: 'all' }], ['storage.get', 'profile.role.explorer'], ['storage.get', 'profile.explorer.creation'],
    ['agents.config', { agentId: id }],
    ['agents.list', { lifecycle: 'all' }], ['storage.get', 'profile.role.explorer'], ['storage.get', 'profile.explorer.creation'],
  ]);
});

test('unconfigured, missing, retired, foreign, ambiguous, model-less and denied saved profiles never call probe', async () => {
  for (const [scenario, code] of [
    ['preset', 'ROLE_NOT_CONFIGURED'], ['missing', 'ROLE_MISSING'], ['retired', 'ROLE_RETIRED'],
    ['foreign', 'FORBIDDEN'], ['ambiguous', 'AMBIGUOUS_INSTANCE'], ['model-less', 'MODEL_NOT_CONFIGURED'],
    ['denied', 'FORBIDDEN'], ['config-missing', 'NOT_FOUND'],
  ]) {
    const f = await savedProfilesFixture();
    if (scenario === 'preset') { f.state.agents = []; f.state.binding = null; }
    if (scenario === 'missing') f.state.agents = [];
    if (scenario === 'retired') f.state.agents[0].state = 'retired';
    if (scenario === 'foreign') f.state.agents[0].plugin.roleId = 'worker';
    if (scenario === 'ambiguous') { f.state.binding = null; f.state.agents.push(f.row('hana-math-main-12345678-1234-1234-1234-123456789012')); }
    if (scenario === 'model-less') f.state.config.models.chat = null;
    if (scenario === 'denied') f.state.configError = Object.assign(new Error('PRIVATE_CONFIG permission denied'), { code: 'APP_CAPABILITY_DENIED' });
    if (scenario === 'config-missing') f.state.configMissing = true;
    const response = await f.execute({ action: 'probe', projectId: 'fixture', role: 'main' });
    assert.equal(response.isError, true, scenario); assert.equal(response.details.error.code, code, scenario);
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE_CONFIG/);
    const status = await f.execute({ action: 'role_status', role: 'main' });
    assert.equal(status.isError, true, scenario); assert.equal(status.details.ok, false, scenario);
    assert.equal(status.details.result.roles[0].error.code, code, scenario);
    assert.ok(f.calls.every(([name]) => ['agents.list', 'agents.config', 'storage.get'].includes(name)), scenario);
  }
});

test('diagnostic calls select exact operations without accepting arbitrary paths or actions', async () => {
  const f = await fixture();
  for (const input of [
    { action: 'unknown' }, { action: '__proto__' },
    { action: 'core_check', command: 'arbitrary-command' },
    { action: 'status', projectId: 'unexpected' }, { action: 'inspect' },
    { action: 'prepare', problem: 'missing fields' },
    { action: 'probe_stop', probeId: 'p', sessionId: 'foreign' },
  ]) assert.equal((await f.execute(input)).isError, true);
  assert.deepEqual(f.calls, []);
  await f.execute({ action: 'core_check' });
  await f.execute({ action: 'inspect', projectId: 'fixture' });
  await f.execute({ action: 'probe_status', probeId: 'p' });
  await f.execute({ action: 'probe_stop', probeId: 'p' });
  assert.deepEqual(f.calls, [['core_check'], ['inspect', 'fixture'], ['probe_status', 'p'], ['probe_stop', 'p']]);
});

test('resolved failures are errors while pending diagnostics remain pending', async () => {
  const f = await fixture();
  const failure = { ok: false, error: { code: 'DOCUMENT_MISSING', message: 'fixture' }, issues: ['missing'] };
  f.services.contexts.inspect = async () => failure;
  const response = await f.execute({ action: 'inspect', projectId: 'fixture' });
  assert.equal(response.isError, true);
  assert.deepEqual(response.details.result, failure);
  for (const state of ['invalid', 'incomplete', 'missing']) {
    f.services.contexts.inspect = async () => ({ state, issues: [{ code: 'FIXTURE_FAILURE' }] });
    assert.equal((await f.execute({ action: 'inspect', projectId: 'fixture' })).isError, true);
  }
  f.services.probes.get = async () => ({ state: 'timed-out', error: 'PROBE_TIMEOUT' });
  assert.equal((await f.execute({ action: 'probe_status', probeId: 'p' })).isError, true);
  f.services.probes.get = async () => ({ status: 'failed', error: 'read failed' });
  assert.equal((await f.execute({ action: 'probe_status', probeId: 'p' })).isError, true);
  f.services.probes.get = async () => ({ status: 'running', probeId: 'p' });
  const pending = await f.execute({ action: 'probe_status', probeId: 'p' });
  assert.equal(pending.isError, undefined);
  assert.equal(pending.details.result.status, 'running');
});

test('startup and core tool require a positive success receipt', async () => {
  const f = await fixture();
  for (const result of [null, {}, { ok: false }, { ok: true, status: 'failed' }]) {
    assert.throws(() => assertCoreCheck(result), { code: 'MATH_CORE_CHECK_FAILED' });
    f.services.core.check = async () => result;
    assert.equal((await f.execute({ action: 'core_check' })).isError, true);
  }
  assert.throws(() => assertCoreCheck({ ok: false, error: { code: 'APP_CAPABILITY_DENIED', message: 'denied' } }), { code: 'APP_CAPABILITY_DENIED' });
  const passed = { ok: true, checks: ['fixture'] };
  assert.equal(assertCoreCheck(passed), passed);
});

test('host capability failures remain explicit tool failures', async () => {
  const f = await fixture();
  f.services.core.check = async () => { throw Object.assign(new Error('app/runtime.execute was not granted'), { code: 'APP_CAPABILITY_DENIED' }); };
  const response = await f.execute({ action: 'core_check' });
  assert.equal(response.isError, true);
  assert.equal(response.details.error.code, 'APP_CAPABILITY_DENIED');
  assert.match(response.details.error.message, /app\/runtime.execute/);
});
