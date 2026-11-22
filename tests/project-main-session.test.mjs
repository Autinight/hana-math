// Software-only public SDK bus fixtures: no real sessions, model calls or storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppSdk } from '../packages/hana-math/sdk/app-contract/server-client.js';
import { readExplorerContract } from '../packages/hana-math/explorer-profile.mjs';
import { nativeExplorationGuidance } from '../packages/hana-math/native-exploration.mjs';
import { AppSdkError } from '../packages/hana-math/sdk/app-contract/sdk-error.js';
import { createProjectMainSession, ensureProjectMainGoalTools, readProjectMainRecoveryReadiness } from '../packages/hana-math/project-main-session.mjs';

const model = { provider: 'fixture-provider', id: 'fixture-model' };
const NATIVE_EXPLORATION_FIXTURES = ['subagent', 'subagent_reply', 'subagent_message', 'subagent_close'];
const builtins = ['read', 'web_search', 'web_fetch', 'subagent', 'subagent_reply', 'subagent_message', 'subagent_close', 'wait_for_tasks', 'current_status', 'loop_control'];
const appTools = ['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems', 'math_assign', 'math_project'];
const requested = [...builtins, ...appTools];
// Opaque names are supplied by the fixture host, never computed by the helper.
const resolved = [...builtins, 'opaque-a', 'opaque-b', 'opaque-c', 'opaque-d', 'opaque-e', 'opaque-f', 'opaque-g'];
const goalRequested = [...requested, 'math_goal_main'], goalResolved = [...resolved, 'opaque-goal'];
function fixture(includeGoalTools = false) {
  const identity = { sessionId: 'stable-main-fixture', path: '/fixture/session.jsonl', agentId: 'hana-math-main-saved',
    cwd: '/fixture/projects/example/main', namespace: 'home', ownerPluginId: 'hana-math', visibility: 'public' };
  const get = { ...identity, modelId: null, sessionKind: 'not-public-authority' };
  const row = { ...identity, modelId: null, kind: 'math-project:fixture', lifecycle: 'active' }; delete row.namespace;
  const created = { ...identity, ok: true, modelId: model.id, modelProvider: model.provider, sessionPath: identity.path,
    sessionRef: { sessionId: identity.sessionId, sessionPath: identity.path }, kind: row.kind };
  const selection = { sessionId: identity.sessionId, toolNames: [...(includeGoalTools ? goalResolved : resolved)], effective: 'current', pendingToolNames: null };
  const replies = { 'model:list': { models: [{ ...model }] }, 'session:create': created, 'session:get': { session: get },
    'session:list': { sessions: [row] }, 'session:context': { sessionId: identity.sessionId, model: { ...model } },
    'session:set-active-tools': selection, 'session:tool-selection': structuredClone(selection) };
  const tools = [...appTools, ...(includeGoalTools ? ['math_goal_main'] : [])].map((name) => ({ name, source: { kind: 'app', appId: 'hana-math' }, availability: { registered: true } }));
  const webTools = ['web_search', 'web_fetch', 'subagent', 'subagent_reply', 'subagent_message', 'subagent_close'].map(name => ({ name, source: { kind: 'custom' }, availability: { registered: true } }));
  // Public Host selector semantics: exact target getAllTools membership after App alias resolution.
  const availableTools = new Set(goalResolved), aliases = new Map(goalRequested.map((name, i) => [name, goalResolved[i]]));
  const calls = [], states = [], hooks = {}; let refusedExplorationSet = false;
  const selected = { role: 'main', agentId: identity.agentId, model: { ...model }, source: 'saved-role', instanceState: 'active' };
  const status = { role: 'main', agentId: identity.agentId, resolvedMode: 'full', appEnabled: true, disabledTools: [] };
  const profiles = { async getRoleModel(role) { calls.push({ verb: 'getRoleModel', input: role }); return selected; },
    async getRoleToolStatus(role, options) { calls.push({ verb: 'getRoleToolStatus', input: { role, options: structuredClone(options) } }); return status; } };
  const sdk = createAppSdk({ dataDir: '/fixture/data', models: {}, hooks: {}, media: {}, providers: {}, storage: { global: {}, agent: () => ({}) },
    tools: { async list(input) { calls.push({ verb: 'tools.list', input }); return hooks['tools.list'] ? hooks['tools.list'](input) : input.scope === 'all' ? webTools : tools; } },
    bus: { async request(verb, input) {
      calls.push({ verb, input: structuredClone(input) });
      if (verb === 'session:set-active-tools') {
        assert.equal(input.sessionId, identity.sessionId);
        const names = input.toolNames.map(name => availableTools.has(name) ? name : aliases.get(name) ?? name);
        if (new Set(names).size !== names.length || names.some(name => !availableTools.has(name))) {
          if (input.toolNames.some(name => NATIVE_EXPLORATION_FIXTURES.includes(name))) refusedExplorationSet = true;
          const missing = names.filter(name => !availableTools.has(name));
          throw new Error(`setSessionActiveTools: requested tools are unavailable for this session: ${missing.join(', ')}`);
        }
        if (refusedExplorationSet && input.toolNames.every(name => !NATIVE_EXPLORATION_FIXTURES.includes(name))) {
          const selection = { sessionId: identity.sessionId, toolNames: names, effective: 'current', pendingToolNames: null };
          replies['session:set-active-tools'] = selection; replies['session:tool-selection'] = structuredClone(selection);
          return structuredClone(selection);
        }
      }
      if (hooks[verb]) return hooks[verb](input);
      assert.ok(Object.hasOwn(replies, verb), `Forbidden/unexpected operation: ${verb}`);
      return structuredClone(replies[verb]);
    }, subscribe() { assert.fail('The main helper must not subscribe to model events'); } },
  });
  const input = { profiles, cwd: identity.cwd, kind: row.kind, ...(includeGoalTools ? { includeGoalTools: true } : {}), async onState(state) {
    calls.push({ verb: 'onState', input: structuredClone(state) }); states.push(structuredClone(state));
    if (hooks.onState) return hooks.onState(state);
  } };
  const binding = { ...identity, state: 'ready', identityConfirmed: true, sessionPath: identity.path, kind: row.kind, model: { ...model }, sessionModel: { ...model },
    toolSelection: { sessionId: identity.sessionId, requested: [...(includeGoalTools ? goalRequested : requested)], resolved: [...selection.toolNames],
      effective: 'current', pendingToolNames: null } };
  return { sdk, input, binding, identity, get, row, created, selected, status, selection, replies, tools, webTools, availableTools, calls, states, hooks,
    run: () => createProjectMainSession(sdk, input), ensure: () => ensureProjectMainGoalTools(sdk, { profiles, binding }),
    recovery: () => readProjectMainRecoveryReadiness(sdk, { profiles, binding }) };
}
async function rejected(f, code) {
  let failure;
  await assert.rejects(f.run(), (error) => { failure = error; return error.code === code; });
  assert.notEqual(failure.state?.state, 'ready');
  assert.equal(Object.hasOwn(failure.state, 'actualModel'), false);
  assert.ok(f.calls.filter((call) => call.verb === 'session:create').length <= 1);
  assert.equal(f.calls.some((call) => /send|abort|archive|delete|switch-model|agent:create|agent:update/.test(call.verb)), false);
  return failure;
}

test('D04 readonly recovery observes saved opaque tools, current model and idle without creating or repairing', async () => {
  const f = fixture(true), before = structuredClone(f.binding);
  Object.assign(f.replies['session:context'], { isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  Object.defineProperty(f.replies['session:context'], 'systemPrompt', { get() { assert.fail('Private context must not be read'); } });
  f.hooks['session:context'] = () => f.replies['session:context'];
  assert.deepEqual(await f.recovery(), { ready: true }); assert.deepEqual(f.binding, before);
  assert.equal(f.calls.some(c => /session:create|set-active-tools|agent:create|Explorer/.test(c.verb)), false);
});

test('D04 readonly recovery refuses unknown/busy idle and mismatched or pending tools without repairing', async () => {
  const unknownModel = fixture(true); unknownModel.binding.sessionModel = null;
  await assert.rejects(unknownModel.recovery(), { code: 'SESSION_MODEL_READBACK_INVALID' }); assert.equal(unknownModel.calls.length, 0);
  for (const patch of [{}, { isStreaming: true, isCompacting: false, pendingMessageCount: 0 },
    { isStreaming: false, isCompacting: false, pendingMessageCount: null },
    { isStreaming: false, isCompacting: true, pendingMessageCount: 0 }]) {
    const f = fixture(true); Object.assign(f.replies['session:context'], patch);
    await assert.rejects(f.recovery(), { code: 'MAIN_CONTROL_MAIN_NOT_IDLE' });
    assert.equal(f.calls.some(c => /session:create|set-active-tools|agent:create/.test(c.verb)), false);
  }
  for (const drift of ['missing', 'pending', 'changed']) {
    const f = fixture(true); Object.assign(f.replies['session:context'], { isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    if (drift === 'missing') f.binding.toolSelection = null;
    if (drift === 'pending') f.replies['session:tool-selection'].pendingToolNames = [...goalResolved];
    if (drift === 'changed') f.replies['session:tool-selection'].toolNames[goalResolved.length - 1] = 'foreign-opaque';
    await assert.rejects(f.recovery(), { code: 'TOOL_SELECTION_UNCONFIRMED' });
    assert.equal(f.calls.some(c => /session:create|set-active-tools|agent:create/.test(c.verb)), false);
  }
});

test('main records a distinct explicit explorer descriptor without touching existing native children', async () => {
  const f = fixture(true), contract = await readExplorerContract();
  const descriptor = { schemaVersion: 1, state: 'available', role: 'explorer', agentId: 'hana-math-explorer', model: { provider: 'explicit-provider', id: 'explorer-model' }, contract: { ...contract.binding, configuredIdentitySha256: 'a'.repeat(64), configuredContractSha256: 'b'.repeat(64) } };
  f.input.profiles.getExplorerSelection = async () => structuredClone(descriptor);
  const result = await f.run(); assert.equal(result.explorer.agentId, 'hana-math-explorer'); assert.notEqual(result.explorer.agentId, result.agentId);
  assert.equal(result.explorer.actualChildModel, 'unknown'); assert.deepEqual(f.states.at(-1).explorer, result.explorer);
  const text = nativeExplorationGuidance(result.toolSelection, result.explorer);
  assert.match(text, /"agent":"hana-math-explorer"/); assert.match(text, /"model":"explicit-provider\/explorer-model"/); assert.match(text, /"access":"read"/);
  assert.match(text, /confirm the exact explorer Agent identity from returned executorAgentId\/agentId/);
  assert.match(text, /native current_status subagents agentId/); assert.match(text, /actualChildModel UNKNOWN \(not verified\)/);
  assert.match(text, /do not disable exploration solely because child-model evidence is absent/);
  assert.match(text, /current_status key=model reports the invoking main model only/);
  assert.match(text, /status projection exposes no child-model field/);
  assert.match(text, /Never read raw child sessions or fabricate\/infer child-model evidence/);
  assert.match(text, /actual Agent identity mismatches or cannot be confirmed, or native explicit model\/target selection is denied/);
  assert.match(text, /never fallback to Shiraha/); assert.equal(result.explorer.actualChildModel, 'unknown');
  assert.match(text, /never relabel, replace or replay/i); assert.doesNotMatch(text, /omit agent\/model overrides|subagent identity and model before using advice/);
  f.binding.oldChildren = [{ threadId: 'old-native-thread', agentId: 'old-global' }]; const before = structuredClone(f.binding);
  const upgraded = await f.ensure(); assert.equal(upgraded.explorer.agentId, descriptor.agentId); assert.deepEqual(f.binding, before);
});
test('missing explorer or same-main target is gracefully unavailable without blocking main readiness', async () => {
  for (const mode of ['missing', 'same-main']) {
    const f = fixture(true);
    f.input.profiles.getExplorerSelection = async () => { if (mode === 'missing') throw Object.assign(new Error('opaque'), { code: 'ROLE_NOT_CONFIGURED' }); return { schemaVersion: 1, state: 'available', role: 'explorer', agentId: f.identity.agentId, model }; };
    const state = await f.run(); assert.equal(state.state, 'ready'); assert.equal(state.explorer.state, 'unavailable');
    const text = nativeExplorationGuidance(state.toolSelection, state.explorer); assert.match(text, /report exploration unavailable/); assert.match(text, /never use a global\/default/);
  }
});

test('saved main gets one public App-owned home session, with durable checkpoints and real current tools', async () => {
  const f = fixture(); const result = await f.run();
  assert.deepEqual(f.calls.map((call) => call.verb), ['getRoleModel', 'getRoleToolStatus', 'model:list', 'tools.list', 'onState',
    'session:create', 'onState', 'session:get', 'session:list', 'onState', 'session:context', 'session:set-active-tools', 'session:tool-selection', 'onState']);
  assert.deepEqual(f.calls.find((call) => call.verb === 'session:create').input, {
    agentId: f.identity.agentId, cwd: f.identity.cwd, namespace: 'home', memoryEnabled: false, model, kind: f.row.kind,
  });
  assert.deepEqual(f.calls.find((call) => call.verb === 'session:list').input, {
    scope: 'own', lifecycle: 'all', ownerPluginId: 'hana-math', agentId: f.identity.agentId,
  });
  assert.deepEqual(f.calls.find((call) => call.verb === 'session:set-active-tools').input, { sessionId: f.identity.sessionId, toolNames: requested });
  assert.deepEqual(f.calls.find((call) => call.verb === 'tools.list').input, { scope: 'own' });
  assert.deepEqual(f.states.map((state) => state.state), ['pending', 'created', 'created', 'ready']);
  assert.equal(f.states[2].phase, 'model-readback');
  assert.equal(f.states[2].modelReadback.configurationConfirmed, false);
  assert.deepEqual(f.states[2].modelProjection, result.modelProjection);
  assert.deepEqual(f.calls.find((call) => call.verb === 'session:context').input, { sessionId: f.identity.sessionId });
  assert.deepEqual(result.modelProjection, {
    get: { modelId: { state: 'null', value: null }, modelProvider: { state: 'missing' } },
    list: { modelId: { state: 'null', value: null }, modelProvider: { state: 'missing' } },
  });
  assert.deepEqual(result.modelReadback, { source: 'sessions.context', state: 'confirmed', sessionId: f.identity.sessionId,
    model, configurationConfirmed: true, error: null });
  assert.equal(f.states[0].createState, 'pending'); assert.equal(f.states[0].sessionId, null);
  assert.equal(f.states[1].sessionId, f.identity.sessionId); assert.equal(f.states[1].identityConfirmed, false);
  assert.deepEqual(f.calls.find((call) => call.verb === 'getRoleToolStatus').input, { role: 'main', options: { additionalAppTools: ['math_project'] } });
  assert.deepEqual(result.selection, f.selected); assert.deepEqual(result.model, model); assert.deepEqual(result.sessionModel, model);
  assert.equal(Object.hasOwn(result, 'actualModel'), false);
  for (const state of f.states) assert.equal(Object.hasOwn(state, 'actualModel'), false);
  assert.equal(f.states[0].sessionModel, null); assert.deepEqual(f.states[1].sessionModel, model);
  for (const key of ['agentId', 'cwd', 'namespace', 'visibility', 'sessionId', 'ownerPluginId']) assert.equal(result[key], f.identity[key]);
  assert.equal(result.sessionPath, f.identity.path); assert.equal(result.lifecycle, 'active'); assert.equal(result.identityConfirmed, true);
  assert.equal(result.createState, 'confirmed'); assert.equal(result.persistenceFailed, false);
  assert.deepEqual(result.toolSelection, { sessionId: f.identity.sessionId, requested, resolved, effective: 'current', pendingToolNames: null,
    exploration: { state: 'available', errorCode: null } });
  assert.deepEqual(result, f.states.at(-1));
});

// Supersedes the global-core/membership/exposure schema tests: that catalog is not target availability.
for (const operation of ['run', 'ensure']) for (const lane of ['custom', 'absent', 'denied']) test(`main ${operation} uses target tools without reading the ${lane} global Agent lane`, async () => {
  const f = operation === 'ensure' ? upgradeFixture() : fixture(true);
  if (lane === 'absent') f.webTools.length = 0;
  f.hooks['tools.list'] = input => { if (input.scope === 'own') return f.tools;
    if (lane === 'denied') throw new AppSdkError({ code: 'APP_CAPABILITY_DENIED', kind: 'permission', operation: 'tools.list', capability: 'app/tools.read', message: 'PRIVATE' }); return f.webTools; };
  assert.equal((await f[operation]()).state, 'ready');
  assert.deepEqual(f.calls.filter(c => c.verb === 'tools.list').map(c => c.input), [{ scope: 'own' }]);
  assert.equal(f.calls.filter(c => c.verb === 'session:set-active-tools').length, 1);
  if (operation === 'ensure') assertExistingOnly(f);
});
// One required base tool and one optional exploration tool cover both branches.
for (const operation of ['run', 'ensure']) for (const name of ['read', 'subagent_close']) test(`main ${operation} handles unavailable target ${name}`, async () => {
  const f = operation === 'ensure' ? upgradeFixture() : fixture(true); f.availableTools.delete(name);
  if (operation === 'ensure') f.replies['session:tool-selection'] = { sessionId: f.identity.sessionId, toolNames: [...resolved], effective: 'current', pendingToolNames: null };
  if (NATIVE_EXPLORATION_FIXTURES.includes(name)) {
    const result = operation === 'run' ? await f.run() : await f.ensure();
    assert.equal(result.state, 'ready');
    const selection = operation === 'run' ? result.toolSelection : result.selection;
    assert.deepEqual(selection.requested, goalRequested.filter(name => !NATIVE_EXPLORATION_FIXTURES.includes(name)));
    assert.deepEqual(selection.exploration, { state: 'unavailable', errorCode: 'APP_HOST_ERROR' });
    assert.equal(f.calls.filter(c => c.verb === 'session:set-active-tools').length, 2);
    if (operation === 'ensure') assertExistingOnly(f);
  } else {
    if (operation === 'run') { const error = await rejected(f, 'APP_HOST_ERROR'); assert.equal(error.state.createState, 'confirmed'); assert.equal(error.state.state, 'unconfirmed'); assert.equal(error.state.failurePhase, 'tool-selection'); assert.equal(f.calls.filter(c => c.verb === 'session:set-active-tools').length, 1); }
    else { await assert.rejects(f.ensure(), { code: 'APP_HOST_ERROR' }); assertExistingOnly(f); }
  }
});
for (const [label, code, message] of [['permission', 'APP_CAPABILITY_DENIED', 'PRIVATE'], ['unknown host', 'APP_HOST_ERROR', 'opaque host failure'],
  ['named base-tool refusal', 'APP_HOST_ERROR', 'session tool selection contains unavailable tool names: read, subagent']]) test(`native exploration fallback does not mask ${label}`, async () => {
  const f = fixture(true), sets = f.calls.filter(c => c.verb === 'session:set-active-tools').length;
  f.hooks['session:set-active-tools'] = () => { throw new AppSdkError({ code, kind: code === 'APP_CAPABILITY_DENIED' ? 'permission' : 'host', operation: 'session:set-active-tools', message }); };
  const error = await rejected(f, code); assert.equal(error.state.failurePhase, 'tool-selection');
  assert.equal(f.calls.filter(c => c.verb === 'session:set-active-tools').length, sets + 1);
});
for (const [code, operation, message] of [
  ['APP_CAPABILITY_DENIED', 'session:set-active-tools', 'setSessionActiveTools: requested tools are unavailable for this session: subagent'],
  ['RPC_TIMEOUT', 'session:set-active-tools', 'setSessionActiveTools: requested tools are unavailable for this session: subagent'],
  ['session_tool_selection_persistence_failed', 'session:set-active-tools', 'session tool selection names tools that are not configured for this session'],
  ['APP_HOST_ERROR', 'session:get', 'setSessionActiveTools: requested tools are unavailable for this session: subagent'],
  ['APP_HOST_ERROR', 'session:set-active-tools', 'setSessionActiveTools: requested tools are unavailable for this session: subagent, read'],
  ['APP_HOST_ERROR', 'session:set-active-tools', 'setSessionActiveTools: requested tools are unavailable for this session: other_tool'],
]) test(`no optional fallback for ${code}/${operation}/${message}`, async () => {
  const f = fixture(true);
  f.hooks['session:set-active-tools'] = () => { throw new AppSdkError({ code, operation, message }); };
  await rejected(f, code);
  assert.equal(f.calls.filter(c => c.verb === 'session:set-active-tools').length, 1);
});
for (const pending of [false, true]) test(`confirmed unavailable Goal selection survives fresh SDK without retry, pending=${pending}`, async () => {
  const f = upgradeFixture(), baseRequested = goalRequested.filter(n => !NATIVE_EXPLORATION_FIXTURES.includes(n));
  const baseResolved = goalResolved.filter(n => !NATIVE_EXPLORATION_FIXTURES.includes(n));
  f.hooks['session:set-active-tools'] = input => {
    if (input.toolNames.includes('subagent')) throw new Error('setSessionActiveTools: requested tools are unavailable for this session: subagent');
    assert.deepEqual(input.toolNames, baseRequested);
    const receipt = { sessionId: f.identity.sessionId, toolNames: pending ? [...resolved] : baseResolved,
      effective: pending ? 'next-turn' : 'current', pendingToolNames: pending ? baseResolved : null };
    f.replies['session:tool-selection'] = structuredClone(receipt); return receipt;
  };
  const first = await f.ensure(); assert.equal(first.state, pending ? 'pending' : 'ready');
  assert.deepEqual(first.selection.exploration, { state: 'unavailable', errorCode: 'APP_HOST_ERROR' });
  assert.equal(f.calls.filter(c => c.verb === 'session:set-active-tools').length, 2); assertExistingOnly(f);
  const g = fixture(true); g.binding.toolSelection = structuredClone(first.selection);
  g.replies['session:tool-selection'] = structuredClone(f.replies['session:tool-selection']);
  assert.deepEqual(await g.ensure(), first);
  assert.equal(g.calls.some(c => c.verb === 'session:set-active-tools'), false); assertExistingOnly(g);
});

test('exact Host unavailable message triggers one baseline retry', async () => {
  const f = fixture(true); let attempts = 0;
  f.hooks['session:set-active-tools'] = input => {
    attempts++;
    if (input.toolNames.includes('subagent')) throw new AppSdkError({ code: 'APP_HOST_ERROR', operation: 'session:set-active-tools',
      message: 'setSessionActiveTools: requested tools are unavailable for this session: subagent' });
    const selection = { sessionId: f.identity.sessionId, toolNames: [...input.toolNames], effective: 'current', pendingToolNames: null };
    f.replies['session:tool-selection'] = structuredClone(selection); return selection;
  };
  const result = await f.run(); assert.equal(result.state, 'ready'); assert.equal(attempts, 2);
  assert.deepEqual(result.toolSelection.exploration, { state: 'unavailable', errorCode: 'APP_HOST_ERROR' });
});
// Receipts are compared as exact name lists; one base and one exploration name are representative.
for (const operation of ['run', 'ensure']) for (const name of ['read', 'subagent']) test(`main ${operation} rejects the same substituted native in both receipts: ${name}`, async () => {
  const f = operation === 'ensure' ? upgradeFixture() : fixture(true), bad = goalResolved.map(n => n === name ? 'opaque-not-native' : n);
  f.replies['session:set-active-tools'].toolNames = [...bad];
  if (operation === 'run') f.replies['session:tool-selection'].toolNames = [...bad];
  await assert.rejects(f[operation](), { code: 'TOOL_SELECTION_UNCONFIRMED' });
  if (operation === 'ensure') assertExistingOnly(f);
  assert.equal(f.calls.some(c => /send|abort|delete/.test(c.verb)), false);
});
for (const name of ['web_fetch', 'subagent_reply']) for (const verb of ['session:set-active-tools', 'session:tool-selection']) {
  test(`new main rejects substituted native ${name} in ${verb}`, async () => {
    const f = fixture(true); f.replies[verb].toolNames = goalResolved.map(n => n === name ? 'opaque-not-native' : n);
    await rejected(f, 'TOOL_SELECTION_UNCONFIRMED');
  });
}
for (const pending of [false, true]) test(`pre-web stored Goal selection upgrades once and survives fresh-SDK readback, pending=${pending}`, async () => {
  const f = upgradeFixture(pending), withoutWeb = names => names.filter(n => !['web_search', 'web_fetch'].includes(n));
  const old = withoutWeb(goalResolved);
  f.binding.toolSelection = { sessionId: f.identity.sessionId, requested: withoutWeb(goalRequested), resolved: old, effective: 'current', pendingToolNames: null };
  f.replies['session:tool-selection'] = { sessionId: f.identity.sessionId, toolNames: old, effective: 'current', pendingToolNames: null };
  if (pending) f.replies['session:set-active-tools'].toolNames = old;
  const result = await f.ensure(); assert.equal(result.state, pending ? 'pending' : 'ready');
  assert.deepEqual(result.selection.requested, goalRequested);
  assert.equal(f.calls.filter(c => c.verb === 'session:set-active-tools').length, 1); assertExistingOnly(f);
  const g = fixture(true); g.binding.toolSelection = structuredClone(result.selection);
  g.replies['session:tool-selection'] = structuredClone(f.replies['session:tool-selection']);
  assert.equal((await g.ensure()).state, result.state);
  assert.equal(g.calls.some(c => c.verb === 'session:set-active-tools'), false); assertExistingOnly(g);
});
for (const name of ['web_search', 'subagent_message']) test(`pending Goal target must retain exact native ${name}`, async () => {
  const f = upgradeFixture(true); f.replies['session:set-active-tools'].pendingToolNames = goalResolved.map(n => n === name ? 'opaque-substitute' : n);
  await assert.rejects(f.ensure(), { code: 'TOOL_SELECTION_UNCONFIRMED' }); assertExistingOnly(f);
});

for (const pending of [false, true]) test(`pre-exploration stored Goal selection upgrades once and survives fresh-SDK readback, pending=${pending}`, async () => {
  const f = upgradeFixture(pending), exploration = new Set(['subagent', 'subagent_reply', 'subagent_message', 'subagent_close']);
  const legacy = names => names.filter(name => !exploration.has(name));
  const old = legacy(goalResolved);
  f.binding.toolSelection = { sessionId: f.identity.sessionId, requested: legacy(goalRequested), resolved: old, effective: 'current', pendingToolNames: null };
  f.replies['session:tool-selection'] = { sessionId: f.identity.sessionId, toolNames: old, effective: 'current', pendingToolNames: null };
  if (pending) f.replies['session:set-active-tools'].toolNames = old;
  const result = await f.ensure(); assert.equal(result.state, pending ? 'pending' : 'ready');
  assert.deepEqual(result.selection.requested, goalRequested);
  assert.equal(f.calls.filter(call => call.verb === 'session:set-active-tools').length, 1); assertExistingOnly(f);
  const g = fixture(true); g.binding.toolSelection = structuredClone(result.selection);
  g.replies['session:tool-selection'] = structuredClone(f.replies['session:tool-selection']);
  assert.equal((await g.ensure()).state, result.state);
  assert.equal(g.calls.some(call => call.verb === 'session:set-active-tools'), false); assertExistingOnly(g);
});

function assertExistingOnly(f) {
  assert.equal(f.calls.some(({ verb }) => /session:create|send|abort|archive|delete|switch-model|agent:create|agent:update|onState/.test(verb)), false);
  assert.equal(f.states.length, 0);
}
function upgradeFixture(pending = false) {
  const f = fixture(); f.tools.push({ name: 'math_goal_main', source: { kind: 'app', appId: 'hana-math' }, availability: { registered: true } });
  f.replies['session:set-active-tools'] = { sessionId: f.identity.sessionId, toolNames: [...(pending ? resolved : goalResolved)],
    pendingToolNames: pending ? [...goalResolved] : null, effective: pending ? 'next-turn' : 'current' };
  f.hooks['session:set-active-tools'] = () => {
    const accepted = structuredClone(f.replies['session:set-active-tools']);
    f.replies['session:tool-selection'] = structuredClone(accepted); return accepted;
  };
  return f;
}

for (const pending of [false, true]) test(`legacy math_goal selection upgrades via SDK resolution, pending=${pending}`, async () => {
  const f = upgradeFixture(pending), oldResolved = [...resolved, 'opaque-old-goal'];
  f.binding.toolSelection = { sessionId: f.identity.sessionId, requested: [...requested, 'math_goal'], resolved: oldResolved, effective: 'current', pendingToolNames: null };
  f.replies['session:tool-selection'] = { sessionId: f.identity.sessionId, toolNames: oldResolved, effective: 'current', pendingToolNames: null };
  if (pending) f.replies['session:set-active-tools'].toolNames = oldResolved;
  const result = await f.ensure(); assert.equal(result.state, pending ? 'pending' : 'ready');
  assert.deepEqual(result.selection.requested, goalRequested);
  assert.deepEqual(pending ? result.selection.pendingToolNames : result.selection.resolved, goalResolved);
  assert.deepEqual(f.calls.find(call => call.verb === 'session:set-active-tools').input, { sessionId: f.identity.sessionId, toolNames: goalRequested });
  assert.equal(f.calls.filter(call => call.verb === 'session:set-active-tools').length, 1); assertExistingOnly(f);
});

test('includeGoalTools creates the same saved main with the complete original contract plus math_goal_main', async () => {
  const f = fixture(true), result = await f.run();
  assert.equal(result.state, 'ready'); assert.equal(result.identityConfirmed, true);
  assert.deepEqual(f.calls.find(({ verb }) => verb === 'session:set-active-tools').input, { sessionId: f.identity.sessionId, toolNames: goalRequested });
  assert.deepEqual(f.calls.find(({ verb }) => verb === 'getRoleToolStatus').input.options, { additionalAppTools: ['math_project', 'math_goal_main'] });
  assert.deepEqual(result.toolSelection, { sessionId: f.identity.sessionId, requested: goalRequested, resolved: goalResolved, effective: 'current', pendingToolNames: null,
    exploration: { state: 'available', errorCode: null } });
  assert.equal(f.calls.filter(({ verb }) => verb === 'session:create').length, 1);
  assert.equal(f.calls.filter(({ verb }) => verb === 'session:tool-selection').length, 1);
});

test('explicit includeGoalTools=false does not require math_goal_main registration or permission', async () => {
  const f = fixture(); f.input.includeGoalTools = false; f.status.disabledTools = ['math_goal_main'];
  assert.deepEqual((await f.run()).toolSelection.requested, requested);
  assert.deepEqual(f.calls.find(({ verb }) => verb === 'getRoleToolStatus').input.options, { additionalAppTools: ['math_project'] });
});

for (const value of [null, 'true', 1, {}]) test(`includeGoalTools=${JSON.stringify(value)} is rejected before Host access`, async () => {
  const f = fixture(); f.input.includeGoalTools = value;
  await assert.rejects(f.run(), { code: 'INVALID_INPUT' }); assert.equal(f.calls.length, 0);
});

for (const patch of [{ effective: 'next-turn', pendingToolNames: goalResolved }, { pendingToolNames: [] }]) {
  test(`Goal-enabled creation still requires current tools: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(true); Object.assign(f.selection, patch);
    const error = await rejected(f, 'TOOL_SELECTION_UNCONFIRMED'); assert.equal(error.state.state, 'unconfirmed');
  });
}

test('ensure reads matching current Host-resolved tools without rewriting, even in another order', async () => {
  const f = fixture(true); f.replies['session:tool-selection'].toolNames.reverse();
  const result = await f.ensure(); assert.equal(result.state, 'ready');
  assert.deepEqual(result.selection.resolved, [...goalResolved].reverse());
  assert.deepEqual(f.calls.map(({ verb }) => verb), ['getRoleModel', 'getRoleToolStatus', 'model:list', 'tools.list',
    'session:get', 'session:list', 'session:context', 'session:tool-selection']);
  assertExistingOnly(f);
});

for (const pending of [false, true]) test(`ensure replaces the whole list once and independently reads ${pending ? 'pending' : 'ready'}`, async () => {
  const f = upgradeFixture(pending), before = structuredClone(f.binding);
  const result = await f.ensure(); assert.equal(result.state, pending ? 'pending' : 'ready');
  assert.deepEqual(result.selection.requested, goalRequested);
  assert.deepEqual(pending ? result.selection.pendingToolNames : result.selection.resolved, goalResolved);
  assert.deepEqual(f.calls.filter(({ verb }) => /tool-selection|set-active-tools/.test(verb)).map(({ verb }) => verb),
    ['session:tool-selection', 'session:set-active-tools', 'session:tool-selection']);
  assert.deepEqual(f.calls.find(({ verb }) => verb === 'session:set-active-tools').input.toolNames, goalRequested);
  assert.deepEqual(f.binding, before, 'Do not mutate the caller binding or claim persistence');
  const again = await f.ensure(); assert.deepEqual(again, result);
  assert.equal(f.calls.filter(({ verb }) => verb === 'session:set-active-tools').length, 1, 'Get is the query, never a second set');
  if (pending) {
    f.replies['session:tool-selection'] = { sessionId: f.identity.sessionId, toolNames: [...goalResolved], effective: 'current', pendingToolNames: null };
    assert.equal((await f.ensure()).state, 'ready');
    assert.equal(f.calls.filter(({ verb }) => verb === 'session:set-active-tools').length, 1);
  }
  assertExistingOnly(f);
});

test('persisted pending evidence avoids rewriting on a fresh SDK; current tools alone are not a pending target', async () => {
  const f = upgradeFixture(true), result = await f.ensure(), g = fixture(true);
  g.binding.toolSelection = structuredClone(result.selection);
  g.replies['session:tool-selection'] = { sessionId: g.identity.sessionId, toolNames: [...resolved], effective: 'next-turn', pendingToolNames: [...goalResolved].reverse() };
  assert.equal((await g.ensure()).state, 'pending');
  assert.equal(g.calls.some(({ verb }) => verb === 'session:set-active-tools'), false); assertExistingOnly(g);
});

for (const pendingToolNames of [[], resolved]) test(`explicit deferred ${pendingToolNames.length ? 'old' : 'empty'} selection is not ready even if current matches Goal`, async () => {
  const f = upgradeFixture(true); f.binding.toolSelection.requested = [...goalRequested]; f.binding.toolSelection.resolved = [...goalResolved];
  f.replies['session:tool-selection'] = { sessionId: f.identity.sessionId, toolNames: [...goalResolved], effective: 'next-turn', pendingToolNames };
  const result = await f.ensure(); assert.equal(result.state, 'pending');
  assert.deepEqual(result.selection.pendingToolNames, goalResolved);
  assert.equal(f.calls.filter(({ verb }) => verb === 'session:set-active-tools').length, 1); assertExistingOnly(f);
});

test('set pending then independent get current returns ready; set current then get pending returns pending', async () => {
  for (const acceptedPending of [false, true]) {
    const f = upgradeFixture(acceptedPending);
    f.hooks['session:set-active-tools'] = () => {
      f.replies['session:tool-selection'] = { sessionId: f.identity.sessionId, toolNames: [...goalResolved],
        pendingToolNames: acceptedPending ? null : [...goalResolved], effective: acceptedPending ? 'current' : 'next-turn' };
      return structuredClone(f.replies['session:set-active-tools']);
    };
    assert.equal((await f.ensure()).state, acceptedPending ? 'ready' : 'pending'); assertExistingOnly(f);
  }
});

test('same-sized but different opaque set is not treated as the Goal target', async () => {
  const f = upgradeFixture();
  f.binding.toolSelection = { sessionId: f.identity.sessionId, requested: goalRequested, resolved: goalResolved, effective: 'current', pendingToolNames: null };
  f.replies['session:tool-selection'].toolNames = [...goalResolved.slice(0, -1), 'opaque-other'];
  assert.equal((await f.ensure()).state, 'ready');
  assert.equal(f.calls.filter(({ verb }) => verb === 'session:set-active-tools').length, 1); assertExistingOnly(f);
});

test('unknown opaque names without saved Host resolution require one set, not guessed name matching', async () => {
  const f = upgradeFixture(); f.replies['session:tool-selection'].toolNames = [...goalResolved];
  await f.ensure(); assert.equal(f.calls.filter(({ verb }) => verb === 'session:set-active-tools').length, 1); assertExistingOnly(f);
});

for (const [label, change, code] of [
  ['unconfirmed binding', f => { f.binding.identityConfirmed = false; }, 'SESSION_BINDING_MISMATCH'],
  ['foreign binding owner', f => { f.binding.ownerPluginId = 'foreign'; }, 'SESSION_BINDING_MISMATCH'],
  ['wrong SID', f => { f.get.sessionId = 'foreign'; }, 'SESSION_INFO_INVALID'],
  ['wrong owner', f => { f.get.ownerPluginId = f.row.ownerPluginId = 'foreign'; }, 'SESSION_INFO_INVALID'],
  ['wrong Agent', f => { f.get.agentId = f.row.agentId = 'other'; }, 'SESSION_BINDING_MISMATCH'],
  ['wrong path', f => { f.get.path = f.row.path = '/other'; }, 'SESSION_BINDING_MISMATCH'],
  ['wrong cwd', f => { f.get.cwd = f.row.cwd = '/other'; }, 'SESSION_BINDING_MISMATCH'],
  ['wrong kind', f => { f.row.kind = 'other'; }, 'SESSION_BINDING_MISMATCH'],
  ['archived SID', f => { f.row.lifecycle = 'archived'; }, 'SESSION_BINDING_MISMATCH'],
  ['saved role changed', f => { f.selected.agentId = 'other'; }, 'ROLE_SELECTION_CONFLICT'],
  ['not saved role', f => { f.selected.source = 'template'; }, 'ROLE_SELECTION_INVALID'],
  ['saved model changed', f => { f.selected.model.id = 'other'; }, 'SESSION_MODEL_MISMATCH'],
  ['get model conflict', f => { f.get.modelId = 'other'; }, 'SESSION_MODEL_MISMATCH'],
  ['list provider conflict', f => { f.row.modelProvider = 'other'; }, 'SESSION_MODEL_MISMATCH'],
  ['context wrong SID', f => { f.replies['session:context'].sessionId = 'other'; }, 'SESSION_BINDING_MISMATCH'],
  ['context wrong model', f => { f.replies['session:context'].model.id = 'other'; }, 'SESSION_MODEL_MISMATCH'],
  ['context missing model', f => { f.replies['session:context'].model = null; }, 'SESSION_MODEL_READBACK_INVALID'],
  ['App disabled', f => { f.status.appEnabled = false; }, 'ROLE_TOOLS_DISABLED'],
  ['Goal disabled', f => { f.status.disabledTools = ['math_goal_main']; }, 'ROLE_TOOLS_DISABLED'],
  ['original tool disabled', f => { f.status.disabledTools = ['math_assign']; }, 'ROLE_TOOLS_DISABLED'],
  ['non-full role', f => { f.status.resolvedMode = 'light'; }, 'ROLE_TOOLS_REQUIRE_FULL'],
  ['missing Goal catalog', f => { f.tools.pop(); }, 'TOOL_NOT_AVAILABLE'],
  ['foreign Goal catalog', f => { f.tools.at(-1).source.appId = 'foreign'; }, 'TOOL_NOT_AVAILABLE'],
  ['duplicate Goal catalog', f => { f.tools.push({ ...f.tools.at(-1) }); }, 'TOOL_NOT_AVAILABLE'],
  ['Goal exposure denied', f => { f.tools.at(-1).availability.modelExposureAllowed = false; }, 'TOOL_NOT_AVAILABLE'],
]) test(`ensure ${label} refuses without touching selection`, async () => {
  const f = fixture(true); change(f);
  await assert.rejects(f.ensure(), { code });
  assert.equal(f.calls.some(({ verb }) => verb === 'session:set-active-tools'), false); assertExistingOnly(f);
});

for (const [verb, code] of [['session:get', 'APP_CAPABILITY_DENIED'], ['session:context', 'APP_CAPABILITY_DENIED'],
  ['tools.list', 'HOST_UNAVAILABLE'], ['session:tool-selection', 'APP_CAPABILITY_DENIED'],
  ['session:set-active-tools', 'APP_CAPABILITY_DENIED'], ['session:set-active-tools', 'APP_HOST_ERROR']]) {
  test(`ensure ${verb} ${code} refuses, including registered but session-unselectable Goal`, async () => {
    const f = upgradeFixture(); f.hooks[verb] = () => { throw new AppSdkError({ code, kind: 'permission', operation: verb, message: 'PRIVATE_HOST_DETAIL' }); };
    await assert.rejects(f.ensure(), error => { assert.doesNotMatch(JSON.stringify(error), /PRIVATE_HOST_DETAIL/); return error.code === code; });
    assert.ok(f.calls.filter(call => call.verb === 'session:set-active-tools').length <= 1); assertExistingOnly(f);
  });
}

for (const field of ['toolNames', 'pendingToolNames']) test(`independent readback rejects a conflicting ${field} without a second set`, async () => {
  const f = upgradeFixture(field === 'pendingToolNames');
  f.hooks['session:set-active-tools'] = () => {
    const accepted = structuredClone(f.replies['session:set-active-tools']);
    f.replies['session:tool-selection'] = structuredClone(accepted);
    f.replies['session:tool-selection'][field] = [...goalResolved.slice(0, -1), 'other-opaque']; return accepted;
  };
  await assert.rejects(f.ensure(), { code: 'TOOL_SELECTION_UNCONFIRMED' });
  assert.equal(f.calls.filter(({ verb }) => verb === 'session:set-active-tools').length, 1); assertExistingOnly(f);
});

test('accepted pending resolution survives a failed get without repeating set on explicit retry', async () => {
  const f = upgradeFixture(true); let reads = 0;
  f.hooks['session:tool-selection'] = () => {
    if (++reads === 2) throw Object.assign(new Error('opaque'), { code: 'HOST_UNAVAILABLE' });
    return structuredClone(f.replies['session:tool-selection']);
  };
  await assert.rejects(f.ensure(), { code: 'HOST_UNAVAILABLE' });
  assert.equal((await f.ensure()).state, 'pending');
  assert.equal(f.calls.filter(({ verb }) => verb === 'session:set-active-tools').length, 1); assertExistingOnly(f);
});

test('ensure reads null disk model projections via context without accessing or exporting prompt fields', async () => {
  const f = fixture(true), configuration = { ...model }, context = { sessionId: f.identity.sessionId, model: configuration };
  f.get.modelId = f.get.modelProvider = f.row.modelId = f.row.modelProvider = null;
  for (const key of ['systemPrompt', 'contextUsage', 'messages', 'ok', 'error', 'toJSON']) Object.defineProperty(context, key, { enumerable: true, get() { assert.fail(`PRIVATE ${key}`); } });
  for (const key of ['apiKey', 'headers', 'toJSON']) Object.defineProperty(configuration, key, { enumerable: true, get() { assert.fail(`PRIVATE ${key}`); } });
  f.hooks['session:context'] = () => context;
  const result = await f.ensure(); assert.equal(result.state, 'ready');
  assert.deepEqual(Object.keys(result).sort(), ['explorer', 'selection', 'state']);
  assert.equal(result.explorer.state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|systemPrompt|contextUsage|messages|apiKey|headers/); assertExistingOnly(f);
});

for (const patch of [{ effective: 'next-turn' }, { pendingToolNames: goalResolved }]) test('either Host deferral signal prevents ready without a redundant set', async () => {
  const f = fixture(true); Object.assign(f.replies['session:tool-selection'], patch);
  assert.equal((await f.ensure()).state, 'pending');
  assert.equal(f.calls.some(({ verb }) => verb === 'session:set-active-tools'), false); assertExistingOnly(f);
});

for (const verb of ['session:tool-selection', 'session:set-active-tools']) for (const patch of [
  { sessionId: 'foreign' }, { pendingToolNames: undefined }, { toolNames: ['read', 'read'] },
]) test(`ensure rejects malformed ${verb} receipt ${JSON.stringify(patch)}`, async () => {
  const f = upgradeFixture(); Object.assign(f.replies[verb], patch);
  await assert.rejects(f.ensure(), { code: 'TOOL_SELECTION_UNCONFIRMED' });
  assert.equal(f.calls.filter(call => call.verb === 'session:set-active-tools').length, verb === 'session:tool-selection' ? 0 : 1);
  assertExistingOnly(f);
});

for (const [label, change, code] of [
  ['disabled Goal', f => { f.status.disabledTools = ['math_goal_main']; }, 'ROLE_TOOLS_DISABLED'],
  ['unregistered Goal', f => { f.tools.at(-1).availability.registered = false; }, 'TOOL_NOT_AVAILABLE'],
  ['unavailable model', f => { f.replies['model:list'].models = []; }, 'MODEL_NOT_AVAILABLE'],
]) test(`Goal-enabled creation refuses ${label} before creating`, async () => {
  const f = fixture(true); change(f); await rejected(f, code);
  assert.equal(f.calls.some(({ verb }) => verb === 'session:create'), false);
});

test('a profile facade that does not yet allow math_goal_main fails closed, without downgrading the required list', async () => {
  for (const operation of ['run', 'ensure']) {
    const f = fixture(true);
    f.input.profiles.getRoleToolStatus = async (role, options) => {
      assert.equal(role, 'main'); assert.deepEqual(options.additionalAppTools, ['math_project', 'math_goal_main']);
      throw Object.assign(new Error('opaque profile whitelist'), { code: 'INVALID_INPUT' });
    };
    await assert.rejects(f[operation](), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.some(({ verb }) => verb === 'session:create' || verb === 'session:set-active-tools'), false);
  }
});

test('cached resolution never bypasses fresh role permission checks', async () => {
  const f = upgradeFixture(true); await f.ensure(); f.status.disabledTools = ['math_goal_main'];
  await assert.rejects(f.ensure(), { code: 'ROLE_TOOLS_DISABLED' });
  assert.equal(f.calls.filter(({ verb }) => verb === 'session:set-active-tools').length, 1); assertExistingOnly(f);
});

test('ensure snapshots binding before awaiting profile checks', async () => {
  const f = fixture(true); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { entered = resolve; });
  const original = f.input.profiles.getRoleModel;
  f.input.profiles.getRoleModel = async role => { entered(); await gate; return original(role); };
  const work = f.ensure(); await waiting; f.binding.sessionId = 'foreign'; f.binding.model.id = 'foreign';
  f.binding.toolSelection.resolved.fill('foreign'); release();
  assert.equal((await work).state, 'ready');
  assert.equal(f.calls.filter(({ verb }) => verb.startsWith('session:')).every(({ input }) => input.sessionId === f.identity.sessionId || input.scope === 'own'), true);
  assertExistingOnly(f);
});

test('builtin names do not become App configuration switches', async () => {
  const f = fixture(); f.status.disabledTools = [...builtins];
  const result = await f.run();
  assert.equal(result.state, 'ready');
  assert.deepEqual(f.calls.find((call) => call.verb === 'session:set-active-tools').input.toolNames, requested);
});

test('optional kind and recovered saved instance do not clone or repair the Agent', async () => {
  const f = fixture(); delete f.input.kind; f.created.kind = null; f.row.kind = null; f.selected.instanceState = 'recovered';
  assert.equal((await f.run()).selection.instanceState, 'recovered');
  assert.equal(Object.hasOwn(f.calls.find((call) => call.verb === 'session:create').input, 'kind'), false);
});

test('pending save is awaited, and callback mutation cannot change the selected instance or tool set', async () => {
  const f = fixture(); let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  f.hooks.onState = async (state) => {
    if (state.state === 'pending') { entered(); await gate; }
    state.agentId = 'foreign'; state.model.id = 'changed'; state.cwd = '/foreign';
  };
  const pending = f.run(); await waiting;
  assert.equal(f.calls.some((call) => call.verb === 'session:create'), false);
  release(); const result = await pending;
  assert.equal(result.agentId, f.identity.agentId); assert.deepEqual(result.model, model);
});

test('returned identity must be durably saved before get/list or tool writes', async () => {
  const f = fixture(); let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  f.hooks.onState = async (state) => { if (state.state === 'created') { entered(); await gate; } };
  const pending = f.run(); await waiting;
  assert.equal(f.calls.some((call) => ['session:get', 'session:list', 'session:context', 'session:set-active-tools'].includes(call.verb)), false);
  release(); assert.equal((await pending).state, 'ready');
});

test('the formal sessionRef supplies a stable ID when the optional top-level ID is absent', async () => {
  const f = fixture(); delete f.created.sessionId;
  assert.equal((await f.run()).sessionId, f.identity.sessionId);
});

for (const [label, change, code] of [
  ['not saved', (f) => { f.selected.source = 'template'; }, 'ROLE_SELECTION_INVALID'],
  ['retired', (f) => { f.selected.instanceState = 'retired'; }, 'ROLE_SELECTION_INVALID'],
  ['other role', (f) => { f.selected.role = 'worker'; }, 'ROLE_SELECTION_INVALID'],
  ['missing model', (f) => { f.selected.model = null; }, 'ROLE_SELECTION_INVALID'],
  ['changed binding', (f) => { f.status.agentId = 'another-main'; }, 'ROLE_SELECTION_CONFLICT'],
  ['non-full tools', (f) => { f.status.resolvedMode = 'standard'; }, 'ROLE_TOOLS_REQUIRE_FULL'],
  ['App disabled', (f) => { f.status.appEnabled = false; }, 'ROLE_TOOLS_DISABLED'],
  ['project tool disabled', (f) => { f.status.disabledTools = ['math_project']; }, 'ROLE_TOOLS_DISABLED'],
  ['original main tool disabled', (f) => { f.status.disabledTools = ['gm_add']; }, 'ROLE_TOOLS_DISABLED'],
  ['original assign tool disabled', (f) => { f.status.disabledTools = ['math_assign']; }, 'ROLE_TOOLS_DISABLED'],
  ['malformed disabled tools', (f) => { f.status.disabledTools = null; }, 'ROLE_TOOLS_DISABLED'],
  ['array model catalog', (f) => { f.replies['model:list'] = [model]; }, 'MODEL_CATALOG_INVALID'],
  ['malformed model catalog row', (f) => { f.replies['model:list'] = { models: [{}] }; }, 'MODEL_CATALOG_INVALID'],
  ['unavailable model', (f) => { f.replies['model:list'] = { models: [{ provider: 'other', id: model.id }] }; }, 'MODEL_NOT_AVAILABLE'],
  ['missing App tool', (f) => { f.tools.pop(); }, 'TOOL_NOT_AVAILABLE'],
  ['foreign App tool', (f) => { f.tools[0].source.appId = 'other'; }, 'TOOL_NOT_AVAILABLE'],
  ['builtin impostor', (f) => { f.tools[0].source.kind = 'core'; }, 'TOOL_NOT_AVAILABLE'],
  ['unregistered tool', (f) => { f.tools[0].availability.registered = false; }, 'TOOL_NOT_AVAILABLE'],
  ['no model exposure', (f) => { f.tools[0].availability.modelExposureAllowed = false; }, 'TOOL_NOT_AVAILABLE'],
  ['ambiguous tool', (f) => { f.tools.push({ ...f.tools[0] }); }, 'TOOL_NOT_AVAILABLE'],
]) test(`${label} fails before any creation`, async () => {
  const f = fixture(); change(f); const error = await rejected(f, code);
  assert.equal(error.state.createState, 'not-attempted');
  assert.equal(f.calls.some((call) => call.verb === 'session:create'), false);
});

for (const [key, value] of [['agentId', 'other-main'], ['cwd', '/other'], ['namespace', 'app'], ['ownerPluginId', 'other'],
  ['visibility', 'plugin_private'], ['path', '/other.jsonl'], ['kind', 'other'], ['modelId', 'other'], ['modelProvider', 'other'],
  ['sessionRef', { sessionId: 'other-id', sessionPath: '/other.jsonl' }]]) {
  test(`create ${key} mismatch keeps the returned locator but cannot select tools`, async () => {
    const f = fixture(); f.created[key] = value;
    const error = await rejected(f, key.startsWith('model') ? 'SESSION_MODEL_MISMATCH' : 'SESSION_BINDING_MISMATCH');
    assert.equal(error.state.sessionId, f.identity.sessionId); assert.equal(error.state.sessionPath, f.identity.path);
    assert.deepEqual(error.state.creation[key], value);
    assert.equal(error.state.identityConfirmed, false); assert.equal(f.states[1].state, 'created');
    assert.equal(f.calls.some((call) => call.verb === 'session:set-active-tools'), false);
  });
}

for (const [label, change, code = 'SESSION_INFO_INVALID'] of [
  ['home is private', (f) => { f.get.visibility = f.row.visibility = 'plugin_private'; }],
  ['foreign owner', (f) => { f.get.ownerPluginId = f.row.ownerPluginId = 'other'; }],
  ['wrong namespace', (f) => { f.get.namespace = 'app'; }],
  ['wrong stable ID', (f) => { f.get.sessionId = 'other'; }],
  ['different Agent', (f) => { f.get.agentId = f.row.agentId = 'other-main'; }, 'SESSION_BINDING_MISMATCH'],
  ['different cwd', (f) => { f.get.cwd = f.row.cwd = '/other'; }, 'SESSION_BINDING_MISMATCH'],
  ['different path', (f) => { f.get.path = f.row.path = '/other.jsonl'; }, 'SESSION_BINDING_MISMATCH'],
  ['archived', (f) => { f.row.lifecycle = 'archived'; }, 'SESSION_BINDING_MISMATCH'],
  ['wrong kind', (f) => { f.row.kind = 'other'; }, 'SESSION_BINDING_MISMATCH'],
  ['model mismatch', (f) => { f.get.modelId = f.row.modelId = 'other'; }, 'SESSION_MODEL_MISMATCH'],
  ['provider mismatch', (f) => { f.get.modelProvider = 'other'; }, 'SESSION_MODEL_MISMATCH'],
  ['list model mismatch', (f) => { f.get.modelId = model.id; f.row.modelId = 'other'; }],
  ['only list model mismatch', (f) => { f.row.modelId = 'other'; }, 'SESSION_MODEL_MISMATCH'],
  ['only get model mismatch', (f) => { f.get.modelId = 'other'; }, 'SESSION_MODEL_MISMATCH'],
  ['only list provider mismatch', (f) => { f.row.modelProvider = 'other'; }, 'SESSION_MODEL_MISMATCH'],
  ['list Agent mismatch', (f) => { f.row.agentId = 'other'; }],
  ['list cwd mismatch', (f) => { f.row.cwd = '/other'; }],
  ['list namespace mismatch', (f) => { f.row.namespace = 'app'; }],
  ['duplicate ID', (f) => { f.replies['session:list'].sessions.push({ ...f.row }); }],
  ['foreign duplicate ID', (f) => { f.replies['session:list'].sessions.push({ ...f.row, ownerPluginId: 'other' }); }],
  ['missing from list', (f) => { f.replies['session:list'].sessions = []; }],
]) test(`${label} refuses ready and leaves the visible session intact`, async () => {
  const f = fixture(); change(f); const error = await rejected(f, code);
  assert.equal(error.state.sessionId, f.identity.sessionId); assert.equal(error.state.identityConfirmed, false);
  assert.equal(f.calls.some((call) => call.verb === 'session:set-active-tools' || call.verb === 'session:context'), false);
  if (label.includes('model') || label.includes('provider')) {
    assert.ok(error.state.modelProjection); assert.deepEqual(f.states.at(-1).modelProjection, error.state.modelProjection);
  }
});

for (const getMode of ['missing', 'null', 'matching']) for (const listMode of ['missing', 'null', 'matching']) {
  test(`optional get=${getMode}, list=${listMode} model projections require independent context confirmation`, async () => {
    const f = fixture();
    for (const [row, mode] of [[f.get, getMode], [f.row, listMode]]) for (const [key, value] of [['modelId', model.id], ['modelProvider', model.provider]]) {
      if (mode === 'missing') delete row[key]; else row[key] = mode === 'null' ? null : value;
    }
    const result = await f.run();
    for (const [side, mode] of [['get', getMode], ['list', listMode]]) for (const [key, value] of [['modelId', model.id], ['modelProvider', model.provider]]) {
      assert.deepEqual(result.modelProjection[side][key], mode === 'missing' ? { state: 'missing' }
        : mode === 'null' ? { state: 'null', value: null } : { state: 'value', value });
    }
    assert.equal(result.modelReadback.configurationConfirmed, true);
    assert.equal(f.calls.filter((call) => call.verb === 'session:context').length, 1);
  });
}

for (const [label, value, code] of [
  ['foreign session ID', { sessionId: 'foreign', model }, 'SESSION_BINDING_MISMATCH'],
  ['missing session ID', { model }, 'SESSION_BINDING_MISMATCH'],
  ['null receipt', null, 'SESSION_BINDING_MISMATCH'],
  ['missing model', { sessionId: 'stable-main-fixture' }, 'SESSION_MODEL_READBACK_INVALID'],
  ['null model', { sessionId: 'stable-main-fixture', model: null }, 'SESSION_MODEL_READBACK_INVALID'],
  ['array model', { sessionId: 'stable-main-fixture', model: [] }, 'SESSION_MODEL_READBACK_INVALID'],
  ['no provider', { sessionId: 'stable-main-fixture', model: { id: model.id } }, 'SESSION_MODEL_READBACK_INVALID'],
  ['no ID', { sessionId: 'stable-main-fixture', model: { provider: model.provider } }, 'SESSION_MODEL_READBACK_INVALID'],
  ['invalid ID', { sessionId: 'stable-main-fixture', model: { ...model, id: '' } }, 'SESSION_MODEL_READBACK_INVALID'],
  ['long provider', { sessionId: 'stable-main-fixture', model: { ...model, provider: 'p'.repeat(257) } }, 'SESSION_MODEL_READBACK_INVALID'],
  ['different ID', { sessionId: 'stable-main-fixture', model: { ...model, id: 'other' } }, 'SESSION_MODEL_MISMATCH'],
  ['different provider', { sessionId: 'stable-main-fixture', model: { ...model, provider: 'other' } }, 'SESSION_MODEL_MISMATCH'],
]) test(`context ${label} cannot fall back to matching create/disk receipts`, async () => {
  const f = fixture(); f.get.modelId = f.row.modelId = model.id;
  f.get.modelProvider = f.row.modelProvider = model.provider;
  f.replies['session:context'] = value;
  const error = await rejected(f, code);
  assert.equal(error.state.modelReadback.source, 'sessions.context'); assert.equal(error.state.modelReadback.state, 'failed');
  assert.equal(error.state.modelReadback.configurationConfirmed, false); assert.equal(error.state.identityConfirmed, false);
  assert.equal(error.state.modelReadback.error, code); assert.equal(error.state.failurePhase, 'model-readback');
  assert.deepEqual(f.states.at(-1).modelProjection, error.state.modelProjection);
  assert.deepEqual(f.states.at(-1).modelReadback, error.state.modelReadback);
  assert.equal(f.calls.some((call) => call.verb === 'session:set-active-tools'), false);
});

test('context exposes only configuration fields; prompt, usage and other getters are never touched or forwarded', async () => {
  const f = fixture(); const configuration = { ...model };
  const context = { sessionId: f.identity.sessionId, model: configuration };
  const forbidden = ['systemPrompt', 'contextUsage', 'thinkingLevel', 'isStreaming', 'isCompacting', 'pendingMessageCount', 'ok', 'error', 'toJSON'];
  for (const key of forbidden) Object.defineProperty(context, key, { enumerable: true, get() { assert.fail(`PRIVATE context ${key} read`); } });
  for (const key of ['name', 'apiKey', 'headers', 'toJSON']) Object.defineProperty(configuration, key, { enumerable: true, get() { assert.fail(`PRIVATE model ${key} read`); } });
  f.hooks['session:context'] = (ref) => { assert.deepEqual(ref, { sessionId: f.identity.sessionId }); return context; };
  const result = await f.run();
  assert.deepEqual(result.modelReadback.model, model);
  assert.deepEqual(Object.keys(result.modelReadback).sort(), ['source', 'state', 'sessionId', 'model', 'configurationConfirmed', 'error'].sort());
  assert.doesNotMatch(JSON.stringify({ result, states: f.states }), /systemPrompt|contextUsage|thinkingLevel|isStreaming|apiKey|headers|PRIVATE/);
});

test('context failure preserves narrow diagnostics but never host error payloads', async () => {
  const f = fixture();
  f.hooks['session:context'] = () => { const error = new AppSdkError({ code: 'APP_CAPABILITY_DENIED', kind: 'permission', operation: 'sessions.context', message: 'PRIVATE' });
    Object.defineProperty(error, 'details', { get() { assert.fail('PRIVATE details read'); } }); throw error; };
  const error = await rejected(f, 'APP_CAPABILITY_DENIED');
  assert.equal(error.state.modelReadback.configurationConfirmed, false); assert.equal(error.state.modelReadback.error, 'APP_CAPABILITY_DENIED');
  assert.equal(error.state.modelProjection.get.modelId.state, 'null');
  assert.equal(error.state.modelProjection.get.modelProvider.state, 'missing');
  assert.doesNotMatch(JSON.stringify(f.states), /PRIVATE|details/);
});

for (const side of ['get', 'row']) for (const key of ['modelId', 'modelProvider']) {
  test(`invalid ${side}.${key} projection is bounded, retained as invalid and never copied wholesale`, async () => {
    const f = fixture();
    const invalid = { get privateValue() { assert.fail('Private projection payload read'); }, toJSON() { assert.fail('Projection serialization attempted'); } };
    f[side][key] = invalid;
    f.hooks['session:get'] = () => ({ session: f.get }); f.hooks['session:list'] = () => ({ sessions: [f.row] });
    const error = await rejected(f, 'SESSION_INFO_INVALID');
    assert.deepEqual(error.state.modelProjection[side === 'get' ? 'get' : 'list'][key], { state: 'invalid' });
    assert.deepEqual(f.states.at(-1).modelProjection, error.state.modelProjection);
    assert.equal(f.calls.some((call) => call.verb === 'session:context'), false);
    assert.doesNotMatch(JSON.stringify(error.state), /privateValue|toJSON/);
  });
}

for (const behavior of ['reject', 'false', 'not-ok', 'error']) test(`model-readback checkpoint ${behavior} stops before context/tools`, async () => {
  const f = fixture(); f.hooks.onState = (state) => {
    if (state.phase !== 'model-readback') return;
    if (behavior === 'reject') throw new Error('fixture persistence failed');
    return behavior === 'false' ? false : behavior === 'not-ok' ? { ok: false } : { error: 'fixture persistence failed' };
  };
  const error = await rejected(f, 'PROJECT_MAIN_STATE_SAVE_FAILED');
  assert.equal(error.state.persistenceFailed, true); assert.ok(error.state.modelProjection);
  assert.equal(error.state.modelReadback.configurationConfirmed, false);
  assert.equal(f.calls.some((call) => ['session:context', 'session:set-active-tools'].includes(call.verb)), false);
  assert.equal(f.calls.filter((call) => call.verb === 'session:create').length, 1);
});

for (const [label, patch] of [
  ['foreign ID', { sessionId: 'other' }], ['deferred', { effective: 'next-turn' }], ['pending empty', { pendingToolNames: [] }],
  ['pending missing', { pendingToolNames: undefined }], ['extra tools', { toolNames: [...resolved, 'extra'] }],
  ...['read'].map((name) => [`missing builtin ${name}`, { toolNames: resolved.map((tool) => tool === name ? 'other' : tool) }]),
  ['duplicates', { toolNames: [...resolved.slice(0, -1), resolved[builtins.length]] }],
  ...['exec', 'exec_command', 'write', 'tool_call'].map((name) => [name, { toolNames: [...resolved.slice(0, -1), name] }]),
]) test(`tool receipt ${label} is not ready`, async () => {
  const f = fixture(); Object.assign(f.selection, patch); const error = await rejected(f, 'TOOL_SELECTION_UNCONFIRMED');
  assert.equal(error.state.identityConfirmed, true); assert.equal(error.state.createState, 'confirmed');
  assert.equal(f.states.some((state) => state.state === 'ready'), false);
});

test('readback must agree with the accepted set, not just have the right length', async () => {
  const f = fixture(); f.replies['session:tool-selection'].toolNames[builtins.length] = 'other-opaque';
  await rejected(f, 'TOOL_SELECTION_UNCONFIRMED');
});

test('readback order is not significant and the result preserves the actual readback', async () => {
  const f = fixture(); f.replies['session:tool-selection'].toolNames.reverse();
  assert.deepEqual((await f.run()).toolSelection.resolved, [...resolved].reverse());
});

for (const [verb, code] of [['session:create', 'app_home_session_not_granted'], ['session:create', 'TIMEOUT'],
  ['session:get', 'HOST_UNAVAILABLE'], ['session:context', 'HOST_UNAVAILABLE'], ['session:set-active-tools', 'APP_CAPABILITY_DENIED'], ['session:tool-selection', 'HOST_UNAVAILABLE']]) {
  test(`${verb} ${code} is retained without fallback, resend or cleanup`, async () => {
    const f = fixture(); f.hooks[verb] = () => { throw Object.assign(new Error('private host detail'), { code }); };
    const error = await rejected(f, code);
    assert.equal(error.state.sessionId, verb === 'session:create' ? null : f.identity.sessionId);
    assert.equal(error.state.createState, verb === 'session:create' ? 'unconfirmed' : ['session:get', 'session:context'].includes(verb) ? 'returned' : 'confirmed');
    assert.equal(f.calls.filter((call) => call.verb === 'session:create').length, 1);
    assert.equal(f.states.some((state) => state.state === 'ready'), false);
    assert.doesNotMatch(JSON.stringify(error.state), /private host detail/);
  });
}

for (const response of [null, {}, { ok: false }, { error: 'uncertain' }]) test(`unconfirmed create ${JSON.stringify(response)} is preserved`, async () => {
  const f = fixture(); f.replies['session:create'] = response;
  const error = await rejected(f, 'SESSION_BINDING_MISMATCH');
  assert.equal(error.state.state, 'unconfirmed'); assert.equal(error.state.identityConfirmed, false);
  assert.equal(f.calls.filter((call) => call.verb === 'session:create').length, 1);
});

test('a partial failed create receipt still retains every known locator', async () => {
  const f = fixture(); f.replies['session:create'] = { ok: false, sessionRef: f.created.sessionRef };
  const error = await rejected(f, 'SESSION_BINDING_MISMATCH');
  assert.equal(error.state.sessionId, f.identity.sessionId); assert.equal(error.state.sessionPath, f.identity.path);
});

for (const checkpoint of ['pending', 'created', 'ready']) for (const behavior of ['reject']) {
  test(`${checkpoint} persistence ${behavior} stops without retrying or claiming ready`, async () => {
    const f = fixture(); let failed = 0;
    f.hooks.onState = (state) => {
      if (state.state !== checkpoint) return;
      failed += 1;
      if (behavior === 'reject') throw new Error('fixture storage failed');
      return behavior === 'false' ? false : behavior === 'not-ok' ? { ok: false } : { error: 'fixture storage failed' };
    };
    const error = await rejected(f, 'PROJECT_MAIN_STATE_SAVE_FAILED');
    assert.equal(failed, 1); assert.equal(error.state.persistenceFailed, true);
    assert.equal(error.state.sessionId, checkpoint === 'pending' ? null : f.identity.sessionId);
    assert.equal(f.calls.filter((call) => call.verb === 'session:create').length, checkpoint === 'pending' ? 0 : 1);
    if (checkpoint !== 'ready') assert.equal(f.calls.some((call) => call.verb === 'session:set-active-tools'), false);
    if (checkpoint === 'created') assert.equal(f.calls.some((call) => call.verb === 'session:get'), false);
  });
}

test('failure-state persistence failure retains the original error and known identity in the thrown snapshot', async () => {
  const f = fixture(); f.row.cwd = '/wrong';
  f.hooks.onState = (state) => { if (state.state === 'unconfirmed') throw new Error('storage unavailable'); };
  const error = await rejected(f, 'SESSION_INFO_INVALID');
  assert.equal(error.state.persistenceFailed, true); assert.equal(error.state.sessionPath, f.identity.path);
});

for (const patch of [{ cwd: 'relative' }, { cwd: '/fixture/../other' }, { onState: null }, { kind: '/untrusted' },
  { toolNames: ['exec'] }, { namespace: 'app' }, { visibility: 'public' }, { model: { provider: 'override', id: 'override' } }]) {
  test(`invalid input ${JSON.stringify(patch)} cannot invoke the host`, async () => {
    const f = fixture(); Object.assign(f.input, patch);
    await assert.rejects(f.run()); assert.equal(f.calls.length, 0);
  });
}
