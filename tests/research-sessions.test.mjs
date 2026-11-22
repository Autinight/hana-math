import test from 'node:test';
import assert from 'node:assert/strict';
import { AppSdkError } from '../packages/hana-math/sdk/app-contract/sdk-error.js';
import { researchSessionDiagnostics } from '../packages/hana-math/research-sessions.mjs';
import { createAppSdk } from '../packages/hana-math/sdk/app-contract/server-client.js';
import { createResearchSessions, confirmResearchSessionStop } from '../packages/hana-math/research-sessions.mjs';

const model = { provider: 'fixture-provider', id: 'fixture-model' };
const turn = () => new Promise(setImmediate);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(predicate) { for (let index = 0; index < 5000; index += 1) { if (predicate()) return; await turn(); } assert.fail('Fixture condition did not settle'); }
function fixture(t, behavior = {}) {
  const calls = []; const updates = []; const bindings = []; const known = new Map(); const selections = new Map(); let callback; let session; let sessionCount = 0;
  const webTools = ['web_search', 'web_fetch'].map(name => ({ name, source: { kind: 'custom' }, availability: { registered: true } }));
  const availableTools = new Set(['read', 'web_search', 'web_fetch', 'opaque-host-resolved-name-7']);
  const appTools = [{ name: 'fact_search', description: 'Software fixture', parameters: {}, source: { kind: 'app', appId: 'hana-math' }, availability: { registered: true } }];
  const call = (name, input) => { calls.push({ name, input: structuredClone(input) }); };
  const sdk = {
    models: { async listAvailable() {
      call('models.listAvailable');
      if (behavior.modelError) throw behavior.modelError;
      return Object.hasOwn(behavior, 'catalog') ? structuredClone(behavior.catalog) : { models: [{ ...model }] };
    } },
    tools: { async list(options) {
      call('tools.list', options);
      if (options.scope === 'all') { if (behavior.webError) throw behavior.webError; return structuredClone(webTools); }
      assert.equal(options.scope, 'own'); return structuredClone(appTools);
    } },
    sessions: {
      async create(input) {
        call('sessions.create', input);
        sessionCount += 1;
        const sessionPath = `/fixture/sessions/${sessionCount === 1 ? 'one' : sessionCount}.jsonl`;
        session = { ok: true, namespace: 'app', sessionId: sessionCount === 1 ? 'fixture-session' : `fixture-session-${sessionCount}`, sessionPath, path: sessionPath,
          agentId: input.agentId, agentName: 'Saved role fixture', cwd: input.cwd, modelProvider: input.model.provider, modelId: input.model.id,
          ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: input.kind ?? null, workspaceFolders: [], authorizedFolders: [], thinkingLevel: Object.hasOwn(behavior, 'reportedThinkingLevel') ? behavior.reportedThinkingLevel : input.thinkingLevel ?? null, permissionMode: null };
        session.sessionRef = { sessionId: session.sessionId, sessionPath: session.sessionPath };
        known.set(session.sessionId, { ...session, lifecycle: 'active' });
        return structuredClone(session);
      },
      async get({ sessionId }) {
        const { kind, lifecycle, ...value } = structuredClone(known.get(sessionId));
        return { session: { ...value, sessionKind: kind } };
      },
      async list(input) {
        return { sessions: [...known.values()].filter((s) => !input.agentId || s.agentId === input.agentId).map((s) => {
          const { namespace, ...value } = structuredClone(s); return value;
        }) };
      },
      async context({ sessionId }) { return { sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0, systemPrompt: 'fixture', model }; },
      async setActiveTools(input) {
        call('sessions.setActiveTools', input);
        // Host checks the target session's getAllTools after resolving App aliases, not its global Agent lane.
        assert.ok(known.has(input.sessionId));
        const names = input.toolNames.map(name => availableTools.has(name) ? name : name === 'fact_search' ? 'opaque-host-resolved-name-7' : name);
        if (new Set(names).size !== names.length || names.some(name => !availableTools.has(name))) throw Object.assign(new Error('Unavailable target tool'), { code: 'HOST_TOOL_UNAVAILABLE' });
        const selection = { sessionId: input.sessionId, toolNames: names, effective: 'current', pendingToolNames: null };
        selections.set(input.sessionId, selection); return structuredClone(selection);
      },
      async getToolSelection(input) { call('sessions.getToolSelection', input); return structuredClone(selections.get(input.sessionId)); },
      async send(input) { call('sessions.send', input); return { accepted: true, sessionId: session.sessionId, sessionPath: session.sessionPath, sessionRef: { ...session.sessionRef } }; },
      async abort(input) { call('sessions.abort', input); return { aborted: true, sessionId: input.sessionId, sessionRef: { ...session.sessionRef } }; },
    },
    bus: { async subscribe(listener, filter) {
      call('bus.subscribe', filter); callback = listener; const dispose = async () => { call('unsubscribe'); };
      return Object.assign(dispose, { ready: Promise.resolve(), disposeAsync: dispose });
    } },
  };
  // The official SDK performs the actual model:list/session:* mapping over this
  // fixed bus fixture, matching profile.test.mjs; no real host context is claimed.
  const officialSdk = behavior.officialSdk ? createAppSdk({ dataDir: '/fixture/app-data', models: {}, tools: sdk.tools, hooks: {}, media: {}, providers: {},
    storage: { global: {}, agent: () => ({}) }, bus: { subscribe: sdk.bus.subscribe, async request(verb, input) {
      call('bus.request', { verb, input });
      if (verb === 'model:list') { assert.equal(input, undefined); return sdk.models.listAvailable(); }
      const method = { 'session:create': 'create', 'session:get': 'get', 'session:list': 'list', 'session:context': 'context', 'session:set-active-tools': 'setActiveTools', 'session:tool-selection': 'getToolSelection', 'session:send': 'send', 'session:abort': 'abort' }[verb];
      assert.ok(method, `Unexpected SDK request ${verb}`); return sdk.sessions[method](input);
    } },
  }) : sdk;
  const service = createResearchSessions(officialSdk);
  t.after(() => service.dispose());
  const input = { role: 'worker', selection: { agentId: 'hana-math-worker-saved', model: { ...model } }, cwd: '/fixture/research/run/worker',
    toolNames: ['read', 'fact_search'], prompt: 'Software fixture only. No mathematical computation.', deadlineAt: Date.now() + 60000, kind: 'research.fixture-run',
    onBound: async (binding) => { call('bound', binding); bindings.push(structuredClone(binding)); },
    onUpdate: async (record) => { updates.push(record); },
  };
  return { sdk: officialSdk, service, calls, updates, bindings, input, webTools, availableTools, appTools, get session() { return session; },
    start: (change = {}) => service.start({ ...input, ...change }),
    emit: (event, sourcePath = session.sessionPath) => callback(event, sourcePath),
    end: (change = {}) => callback({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Do not expose this reasoning block' }, { type: 'text', text: 'Final software fixture text' }], stopReason: 'stop' }], ...change }, session.sessionPath),
  };
}

// Every SDK method above is a software fixture. No Agent, service or model runs.
test('uses only the saved instance, binds before send, and keeps local requests plus opaque resolved receipts', async (t) => {
  const f = fixture(t); const handle = f.start();
  assert.equal(handle instanceof Promise, false); assert.equal(handle.snapshot().state, 'preparing'); assert.equal(f.calls.length, 0);
  f.input.selection.agentId = 'mutated-after-start'; f.input.selection.model.id = 'mutated-after-start';
  await until(() => handle.snapshot().sendState === 'accepted');
  const creation = f.calls.find((entry) => entry.name === 'sessions.create').input;
  assert.equal(creation.agentId, 'hana-math-worker-saved'); assert.deepEqual(creation.model, model);
  assert.equal(creation.memoryEnabled, false); assert.equal(creation.namespace, 'app'); assert.equal(creation.kind, 'research.fixture-run');
  assert.equal(f.calls.filter((entry) => entry.name === 'sessions.create').length, 1);
  assert.equal(f.calls.findIndex((entry) => entry.name === 'bound') < f.calls.findIndex((entry) => entry.name === 'sessions.send'), true);
  assert.equal(f.calls.findIndex((entry) => entry.name === 'bus.subscribe') < f.calls.findIndex((entry) => entry.name === 'sessions.send'), true);
  assert.deepEqual(handle.snapshot().toolSelection, { requested: ['read', 'fact_search'], resolved: ['read', 'opaque-host-resolved-name-7'], effective: 'current', pendingToolNames: null });
  f.end(); const result = await handle.done;
  assert.equal(result.state, 'completed'); assert.equal(result.roundEnded, true); assert.equal(result.finalText, 'Final software fixture text');
  assert.deepEqual(result.actualModel, model); assert.equal(result.sessionId, f.session.sessionId);
  assert.equal(f.calls.filter((entry) => entry.name === 'sessions.send').length, 1); assert.equal(f.calls.some((entry) => entry.name === 'sessions.abort'), false);
  const snapshot = handle.snapshot(); snapshot.model.id = 'changed'; assert.equal(handle.snapshot().model.id, model.id);
});

test('actualModel diagnostics preserve Unicode and spaced Host model references through repeated projection', async t => {
  for (const [selected, thinkingLevel] of [
    [{ provider: 'bug cursor', id: 'claude-opus-5-5' }, 'high'],
    [{ provider: '智叶-gpt-pro-企业', id: 'gpt-6.1-sol' }, 'xhigh'],
  ]) {
    const f = fixture(t, { officialSdk: true, catalog: { models: [{ ...selected, thinkingLevels: [thinkingLevel] }] } });
    const handle = f.start({ selection: { ...f.input.selection, model: selected, thinkingLevel } });
    await until(() => handle.snapshot().sendState === 'accepted');
    assert.deepEqual(f.calls.find(c => c.name === 'sessions.create').input.model, selected);
    assert.deepEqual(f.bindings[0].model, selected);
    f.end(); const result = await handle.done;
    assert.equal(result.state, 'completed'); assert.equal(result.reportedThinkingLevel, thinkingLevel);
    const projected = researchSessionDiagnostics(result);
    assert.deepEqual(projected.actualModel, selected);
    assert.deepEqual(researchSessionDiagnostics(projected), projected);
  }
  const padded = { provider: ' Provider (企业), + @! ', id: ' model/v1:beta [试用] ' };
  assert.deepEqual(researchSessionDiagnostics({ actualModel: padded }).actualModel, padded);
});

test('actualModel diagnostics reject unsafe references without reading getters or exposing private fields', () => {
  const unsafe = ['https://private.example/model', ' /private/model ', './model', '../model', 'C:/private/model',
    'model\\private', 'bad\u0000model', 'bad\u007fmodel', 'bad\u0085model', '\ud800', 'x'.repeat(257), '   '];
  for (const value of unsafe) {
    assert.equal(researchSessionDiagnostics({ actualModel: { provider: value, id: 'model' } }).actualModel, null);
    assert.equal(researchSessionDiagnostics({ actualModel: { provider: 'provider', id: value } }).actualModel, null);
  }
  const forbidden = () => assert.fail('Diagnostic getter must not execute');
  const actual = { provider: '企业 provider', id: 'model', credential: 'PRIVATE_CREDENTIAL' };
  Object.defineProperty(actual, 'path', { get: forbidden });
  const value = { actualModel: actual, privateMetadata: 'PRIVATE_METADATA' };
  Object.defineProperty(value, 'error', { get: forbidden });
  const safe = researchSessionDiagnostics(value);
  assert.deepEqual(safe.actualModel, { provider: actual.provider, id: actual.id });
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_|credential|privateMetadata|path/);
  const getterModel = Object.defineProperty({ id: 'model' }, 'provider', { get: forbidden });
  assert.equal(researchSessionDiagnostics({ actualModel: getterModel }).actualModel, null);
  assert.equal(researchSessionDiagnostics(Object.defineProperty({}, 'actualModel', { get: forbidden })).actualModel, null);
});

test('thinking selection forwards explicit catalog levels and retains Host receipts', async t => {
  for (const thinkingLevel of ['high', 'fixture-custom']) {
    const f = fixture(t, { officialSdk: true, catalog: { models: [{ ...model, thinkingLevels: ['high'], customThinkingLevels: ['fixture-custom'] }] } });
    const h = f.start({ selection: { ...f.input.selection, thinkingLevel } });
    await until(() => h.snapshot().sendState === 'accepted');
    assert.equal(f.calls.find(c => c.name === 'sessions.create').input.thinkingLevel, thinkingLevel);
    assert.equal(f.bindings[0].thinkingLevel, thinkingLevel); assert.equal(f.bindings[0].reportedThinkingLevel, thinkingLevel);
    f.end(); const result = await h.done;
    assert.equal(result.thinkingLevel, thinkingLevel); assert.equal(result.reportedThinkingLevel, thinkingLevel);
    assert.equal(researchSessionDiagnostics(result).reportedThinkingLevel, thinkingLevel);
  }
});

test('thinking selection omission leaves create and requested binding properties absent', async t => {
  const f = fixture(t, { reportedThinkingLevel: 'host-default' }), h = f.start();
  await until(() => h.snapshot().sendState === 'accepted');
  assert.equal(Object.hasOwn(f.calls.find(c => c.name === 'sessions.create').input, 'thinkingLevel'), false);
  assert.equal(Object.hasOwn(f.bindings[0], 'thinkingLevel'), false);
  assert.equal(Object.hasOwn(h.snapshot(), 'thinkingLevel'), false);
  assert.equal(f.bindings[0].reportedThinkingLevel, 'host-default');
  f.end(); assert.equal((await h.done).state, 'completed');
});

test('thinking selection rejects explicit invalid values and unsupported defaults before creation', async t => {
  const f = fixture(t, { catalog: { models: [{ ...model, thinkingLevels: ['high'], defaultThinkingLevel: 'default-only' }] } });
  for (const thinkingLevel of [null, undefined, '', ' ', 'auto', 1]) {
    assert.throws(() => f.start({ selection: { ...f.input.selection, thinkingLevel } }), { code: 'INVALID_THINKING_LEVEL' });
  }
  for (const thinkingLevel of ['default-only', 'HIGH', 'custom-absent']) {
    const h = f.start({ selection: { ...f.input.selection, thinkingLevel } }), result = await h.done;
    assert.equal(result.error, 'INVALID_THINKING_LEVEL'); assert.equal(result.failurePhase, 'model-catalog');
  }
  assert.equal(f.calls.some(c => c.name === 'sessions.create'), false);
});

test('thinking selection Host mismatch retains identity and diagnostics, aborts and never sends', async t => {
  const f = fixture(t, { catalog: { models: [{ ...model, thinkingLevels: ['high'] }] }, reportedThinkingLevel: 'low' });
  const h = f.start({ selection: { ...f.input.selection, thinkingLevel: 'high' } }), result = await h.done;
  assert.equal(result.error, 'SESSION_THINKING_LEVEL_MISMATCH'); assert.equal(result.state, 'failed');
  assert.equal(result.sessionId, f.session.sessionId); assert.equal(result.sessionPath, f.session.sessionPath);
  assert.equal(result.thinkingLevel, 'high'); assert.equal(result.reportedThinkingLevel, 'low');
  const diagnostic = researchSessionDiagnostics(result);
  assert.equal(diagnostic.error, 'SESSION_THINKING_LEVEL_MISMATCH'); assert.equal(diagnostic.thinkingLevel, 'high');
  assert.equal(diagnostic.reportedThinkingLevel, 'low');
  assert.equal(f.calls.some(c => c.name === 'sessions.send'), false); assert.equal(f.bindings.length, 0);
  assert.equal(f.calls.filter(c => c.name === 'sessions.abort').length, 1); assert.equal(result.cleanupPending, false);
});

test('saved main dispatch and summary use two explicitly started private sessions with one shared cwd', async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t);
  const mainModel = { provider: 'main-fixture-provider', id: 'main-fixture-model' };
  f.sdk.models.listAvailable = async () => ({ models: [{ ...model }, { ...mainModel }] });
  let bindingEntered = false;
  const input = { role: 'main', selection: { agentId: 'hana-math-main-saved', model: mainModel }, cwd: '/fixture/research/run/main',
    onBound: async (binding) => { bindingEntered = true; await gate.promise; return f.input.onBound(binding); } };
  const dispatch = f.start({ ...input, prompt: 'Dispatch software fixture only.' });
  assert.equal(dispatch instanceof Promise, false); await until(() => bindingEntered);
  assert.equal(f.calls.some((entry) => entry.name === 'sessions.send'), false);
  gate.resolve(); await until(() => dispatch.snapshot().sendState === 'accepted');
  f.end(); const first = await dispatch.done;
  assert.equal(first.state, 'completed'); assert.equal(first.role, 'main'); assert.deepEqual(first.actualModel, mainModel);
  await turn(); assert.equal(f.calls.filter((entry) => entry.name === 'sessions.create').length, 1);
  assert.equal(f.calls.filter((entry) => entry.name === 'sessions.send').length, 1);
  // A second round exists only because the caller explicitly starts it. No cwd
  // assembly, config mutation, clone or strategy scheduler is part of this API.
  const summary = f.start({ ...input, prompt: 'Summarize software fixture only.' });
  await until(() => summary.snapshot().sendState === 'accepted'); f.end(); const second = await summary.done;
  assert.equal(second.state, 'completed'); assert.notEqual(second.sessionId, first.sessionId); assert.equal(second.cwd, first.cwd);
  const creations = f.calls.filter((entry) => entry.name === 'sessions.create'); assert.equal(creations.length, 2);
  for (const creation of creations) {
    assert.equal(creation.input.agentId, 'hana-math-main-saved'); assert.deepEqual(creation.input.model, mainModel);
    assert.equal(creation.input.cwd, input.cwd); assert.equal(creation.input.namespace, 'app'); assert.equal(creation.input.memoryEnabled, false);
  }
  assert.equal(f.bindings.length, 2);
  for (const binding of f.bindings) {
    assert.equal(binding.role, 'main'); assert.equal(binding.agentId, 'hana-math-main-saved'); assert.deepEqual(binding.model, mainModel);
    const boundIndex = f.calls.findIndex((entry) => entry.name === 'bound' && entry.input.sessionId === binding.sessionId);
    const sendIndex = f.calls.findIndex((entry) => entry.name === 'sessions.send' && entry.input.sessionId === binding.sessionId);
    assert.ok(boundIndex >= 0 && sendIndex > boundIndex);
  }
  assert.deepEqual(second.toolSelection.requested, input.toolNames ?? f.input.toolNames);
  assert.deepEqual(second.toolSelection.resolved, ['read', 'opaque-host-resolved-name-7']);
  await turn(); assert.equal(f.calls.filter((entry) => entry.name === 'sessions.send').length, 2);
});

test('official SDK model:list envelope reaches session creation with the exact saved model', async (t) => {
  const f = fixture(t, { officialSdk: true }); const handle = f.start();
  await until(() => handle.snapshot().sendState === 'accepted'); f.end();
  assert.equal((await handle.done).state, 'completed');
  assert.deepEqual(f.calls.find((c) => c.name === 'bus.request' && c.input.verb === 'model:list').input, { verb: 'model:list', input: undefined });
  assert.deepEqual(f.calls.find((c) => c.name === 'sessions.create').input.model, model);
  assert.equal(f.calls.filter((c) => c.name === 'models.listAvailable').length, 1);
  assert.deepEqual(f.calls.find((c) => c.name === 'tools.list').input, { scope: 'own' });
});

const webSelection = ['read', 'web_search', 'web_fetch', 'fact_search'];
test('new research selection uses only own-App catalog and reads back exact target names before send', async (t) => {
  const f = fixture(t, { officialSdk: true }), handle = f.start({ toolNames: webSelection });
  await until(() => handle.snapshot().sendState === 'accepted');
  assert.deepEqual(f.calls.filter(c => c.name === 'tools.list').map(c => c.input), [{ scope: 'own' }]);
  assert.deepEqual(handle.snapshot().toolSelection.resolved, ['read', 'web_search', 'web_fetch', 'opaque-host-resolved-name-7']);
  assert.ok(f.calls.findIndex(c => c.name === 'sessions.getToolSelection') < f.calls.findIndex(c => c.name === 'sessions.send'));
  f.end(); assert.equal((await handle.done).state, 'completed');
});
// Supersedes global-core/source/exposure assumptions; target selection and per-call permissions remain authoritative.
// Tool selection does not branch on main/worker/verifier role, so one tool-using role is representative below.
for (const role of ['worker']) for (const lane of ['custom', 'absent', 'denied']) test(`${role} selects target natives without reading the ${lane} global lane`, async t => {
  const f = fixture(t, { officialSdk: true, ...(lane === 'denied' ? { webError: new AppSdkError({ code: 'APP_CAPABILITY_DENIED', kind: 'permission', operation: 'tools.list', capability: 'app/tools.read', message: 'PRIVATE' }) } : {}) });
  if (lane === 'absent') f.webTools.length = 0;
  const handle = f.start({ role, selection: { agentId: `saved-${role}`, model }, toolNames: webSelection });
  await until(() => handle.snapshot().sendState === 'accepted'); f.end(); assert.equal((await handle.done).state, 'completed');
  assert.deepEqual(f.calls.filter(c => c.name === 'tools.list').map(c => c.input), [{ scope: 'own' }]);
  assert.equal(f.calls.filter(c => c.name === 'sessions.setActiveTools').length, 1); assert.equal(f.calls.filter(c => c.name === 'sessions.getToolSelection').length, 1);
});
for (const role of ['worker']) for (const name of ['read', 'web_fetch']) test(`${role} with unavailable target ${name} creates then fails selection without sending`, async t => {
  const f = fixture(t); f.availableTools.delete(name);
  const result = await f.start({ role, selection: { agentId: `saved-${role}`, model }, toolNames: webSelection }).done;
  assert.equal(result.error, 'HOST_TOOL_UNAVAILABLE'); assert.equal(result.failurePhase, 'tool-selection');
  assert.equal(f.calls.filter(c => c.name === 'sessions.create').length, 1); assert.equal(f.calls.some(c => c.name === 'sessions.send'), false);
  assert.ok(f.calls.some(c => c.name === 'sessions.abort'), 'Research retains its own cleanup, unlike public main');
});
for (const role of ['worker']) for (const method of ['setActiveTools', 'getToolSelection']) test(`${role} target ${method} permission denial is retained and never sends`, async t => {
  const f = fixture(t); f.sdk.sessions[method] = async () => { throw new AppSdkError({ code: 'APP_CAPABILITY_DENIED', kind: 'permission', operation: method, capability: 'app/session.tools.configure', message: 'PRIVATE' }); };
  const result = await f.start({ role, selection: { agentId: `saved-${role}`, model }, toolNames: webSelection }).done;
  assert.equal(result.error, 'APP_CAPABILITY_DENIED'); assert.equal(result.sdkError.capability, 'app/session.tools.configure'); assert.equal(f.calls.some(c => c.name === 'sessions.send'), false);
});
for (const role of ['worker']) for (const defect of ['foreign-app', 'unregistered', 'missing']) test(`${role} still rejects own-App business ${defect} before create`, async t => {
  const f = fixture(t); if (defect === 'foreign-app') f.appTools[0].source.appId = 'foreign'; else if (defect === 'unregistered') f.appTools[0].availability.registered = false; else f.appTools.length = 0;
  const result = await f.start({ role, selection: { agentId: `saved-${role}`, model }, toolNames: webSelection }).done;
  assert.equal(result.error, 'TOOL_NOT_AVAILABLE'); assert.equal(f.calls.some(c => c.name === 'sessions.create' || c.name === 'sessions.send'), false);
});
for (const method of ['setActiveTools', 'getToolSelection']) for (const defect of ['missing', 'duplicate', 'extra-unsafe', 'wrong-sid', 'pending']) test(`web ${method} rejects ${defect} before send`, async t => {
  const f = fixture(t), original = f.sdk.sessions[method]; f.sdk.sessions[method] = async input => { const r = await original(input);
    if (defect === 'missing') r.toolNames.pop(); if (defect === 'duplicate') r.toolNames[1] = r.toolNames[0]; if (defect === 'extra-unsafe') r.toolNames.push('exec'); if (defect === 'wrong-sid') r.sessionId = 'foreign'; if (defect === 'pending') { r.effective = 'next-turn'; r.pendingToolNames = [...r.toolNames]; } return r; };
  assert.equal((await f.start({ toolNames: webSelection }).done).error, 'TOOL_SELECTION_UNCONFIRMED'); assert.equal(f.calls.some(c => c.name === 'sessions.send'), false);
});
for (const name of ['web_fetch']) test(`matching substituted ${name} in both web receipts still cannot send`, async t => {
  const f = fixture(t); for (const method of ['setActiveTools', 'getToolSelection']) { const original = f.sdk.sessions[method]; f.sdk.sessions[method] = async input => { const r = await original(input); r.toolNames = r.toolNames.map(n => n === name ? 'opaque-not-native' : n); return r; }; }
  assert.equal((await f.start({ toolNames: webSelection }).done).error, 'TOOL_SELECTION_UNCONFIRMED'); assert.equal(f.calls.some(c => c.name === 'sessions.send'), false);
});
for (const method of ['setActiveTools', 'getToolSelection']) for (const ending of ['stop', 'deadline']) test(`${ending} during web ${method} prevents a late send and retains cleanup`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const f = fixture(t), gate = deferred(), original = f.sdk.sessions[method]; let entered = false; t.after(() => gate.resolve());
  f.sdk.sessions[method] = async input => { entered = true; await gate.promise; return original(input); };
  const handle = f.start({ toolNames: webSelection, deadlineAt: Date.now() + 1000 }); await until(() => entered);
  if (ending === 'stop') await handle.stop(); else t.mock.timers.tick(1000);
  const result = await handle.done; assert.equal(result.state, ending === 'stop' ? 'stopped' : 'timed-out'); assert.equal(result.cleanupPending, true);
  gate.resolve(); await f.service.dispose(); await turn(); assert.equal(f.calls.some(c => c.name === 'sessions.send'), false); assert.equal(handle.snapshot().state, result.state);
});
test('only fixed natives bypass own-App preflight; arbitrary unknown names never fall back to native', async (t) => {
  const f = fixture(t); const result = await f.start({ toolNames: [...webSelection, 'unknown_native'] }).done;
  assert.equal(result.error, 'TOOL_NOT_AVAILABLE');
  assert.equal(f.calls.some(c => c.input?.scope === 'all' || c.name === 'sessions.create' || c.name === 'sessions.send'), false);
});
test('legacy read-only helper needs neither new catalog nor web readback', async (t) => {
  const f = fixture(t); f.sdk.tools.list = () => assert.fail('No catalog for legacy read-only');
  f.sdk.sessions.getToolSelection = () => assert.fail('No new SDK requirement for legacy selection');
  const handle = f.start({ toolNames: ['read'] }); await until(() => handle.snapshot().sendState === 'accepted');
  f.end(); assert.equal((await handle.done).state, 'completed');
});
for (const name of ['web_search']) for (const method of ['setActiveTools', 'getToolSelection']) {
  test(`research refuses substituted native ${name} in ${method} without sending`, async (t) => {
    const f = fixture(t), original = f.sdk.sessions[method];
    f.sdk.sessions[method] = async input => { const r = await original(input); r.toolNames = r.toolNames.map(n => n === name ? 'opaque-substitute' : n); return r; };
    const result = await f.start({ toolNames: webSelection }).done;
    assert.equal(result.error, 'TOOL_SELECTION_UNCONFIRMED');
    assert.equal(f.calls.some(c => c.name === 'sessions.send'), false);
  });
}
test('web readback rejects a deferred selection and changed opaque App resolution', async (t) => {
  for (const deferred of [false, true]) {
    const f = fixture(t), original = f.sdk.sessions.getToolSelection;
    f.sdk.sessions.getToolSelection = async input => { const r = await original(input); if (deferred) { r.effective = 'next-turn'; r.pendingToolNames = r.toolNames; }
      else r.toolNames[r.toolNames.length - 1] = 'different-opaque-app'; return r; };
    assert.equal((await f.start({ toolNames: webSelection }).done).error, 'TOOL_SELECTION_UNCONFIRMED');
    assert.equal(f.calls.some(c => c.name === 'sessions.send'), false);
  }
});
test('stop during deferred web selection readback cannot send after a late readback', async t => {
  const f = fixture(t), gate = deferred(), original = f.sdk.sessions.getToolSelection; t.after(() => gate.resolve()); let entered = false;
  f.sdk.sessions.getToolSelection = async input => { entered = true; await gate.promise; return original(input); };
  const handle = f.start({ toolNames: webSelection }); await until(() => entered);
  assert.equal(f.calls.some(c => c.name === 'sessions.send'), false);
  const stopped = await handle.stop(); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.cleanupPending, true);
  gate.resolve(); await f.service.dispose(); await turn();
  assert.equal(f.calls.some(c => c.name === 'sessions.send'), false);
  assert.equal(handle.snapshot().state, 'stopped');
});
test('stop during own-App catalog wait preserves cancellation and cannot create later', async (t) => {
  const f = fixture(t), gate = deferred(), original = f.sdk.tools.list; t.after(() => gate.resolve()); let entered = false;
  f.sdk.tools.list = async options => { assert.equal(options.scope, 'own'); entered = true; await gate.promise; return original(options); };
  const handle = f.start({ toolNames: webSelection }); await until(() => entered);
  await handle.stop(); gate.resolve(); await handle.done; await turn();
  assert.equal(f.calls.some(c => c.name === 'sessions.create' || c.name === 'sessions.send'), false);
});

for (const [name, catalog, code] of [
  ['empty', { models: [] }, 'MODEL_NOT_AVAILABLE'],
  ['missing ID', { models: [{ ...model, id: 'other' }] }, 'MODEL_NOT_AVAILABLE'],
  ['wrong provider', { models: [{ ...model, provider: 'other' }] }, 'MODEL_NOT_AVAILABLE'],
  ['cross-paired identity', { models: [{ ...model, provider: 'other' }, { ...model, id: 'other' }] }, 'MODEL_NOT_AVAILABLE'],
  ['bare array', [model], 'MODEL_CATALOG_INVALID'], ['null', null, 'MODEL_CATALOG_INVALID'],
  ['missing models', {}, 'MODEL_CATALOG_INVALID'], ['non-array models', { models: {} }, 'MODEL_CATALOG_INVALID'],
  ['null row', { models: [null] }, 'MODEL_CATALOG_INVALID'], ['invalid ID', { models: [{ provider: model.provider, id: 3 }] }, 'MODEL_CATALOG_INVALID'],
]) test(`official model catalog ${name} is rejected before session creation`, async (t) => {
  const f = fixture(t, { officialSdk: true, catalog }); const result = await f.start().done;
  assert.equal(result.error, code); assert.equal(result.state, 'failed');
  assert.equal(f.calls.some((c) => c.name === 'sessions.create' || c.name === 'sessions.send' || c.name === 'tools.list'), false);
});

for (const code of ['APP_CAPABILITY_DENIED', 'RPC_TIMEOUT']) test(`official model catalog SDK error ${code} is retained without fallback`, async (t) => {
  const f = fixture(t, { officialSdk: true, modelError: Object.assign(new Error('fixture catalog failure'), { code }) });
  const result = await f.start().done; assert.equal(result.error, code);
  assert.equal(f.calls.filter((c) => c.name === 'models.listAvailable').length, 1);
  assert.equal(f.calls.some((c) => c.name === 'sessions.create'), false);
});

test('unknown saved main model never falls back to the worker catalog model', async (t) => {
  const f = fixture(t);
  const result = await f.start({ role: 'main', selection: { agentId: 'hana-math-main-saved', model: { provider: model.provider, id: 'missing-main-model' } }, cwd: '/fixture/research/run/main' }).done;
  assert.equal(result.error, 'MODEL_NOT_AVAILABLE'); assert.equal(f.calls.some((entry) => entry.name === 'sessions.create'), false);
});

test('retry agent_end and foreign messages cannot end the round; only final assistant text is returned', async (t) => {
  const f = fixture(t); const handle = f.start({ role: 'verifier', selection: { agentId: 'hana-math-verifier-saved', model } }); let ended = false; handle.done.then(() => { ended = true; });
  await until(() => handle.snapshot().sendState === 'accepted');
  f.end({ willRetry: true }); await until(() => handle.snapshot().retryEvents === 1); assert.equal(ended, false);
  f.emit({ type: 'agent_end', messages: [] }, '/foreign/session');
  f.end({ sessionId: 'foreign', messages: [] }); await turn(); assert.equal(ended, false);
  f.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Final fallback text' }] } });
  f.emit({ type: 'message_end', message: { role: 'user', content: 'Not an assistant answer' } });
  f.emit({ type: 'agent_end' });
  const result = await handle.done; assert.equal(result.state, 'completed'); assert.equal(result.finalText, 'Final fallback text');
  assert.equal(f.calls.filter((entry) => entry.name === 'sessions.send').length, 1);
});

for (const [message, state, error] of [
  [{ role: 'user', content: 'user' }, 'failed', 'FINAL_ASSISTANT_MISSING'],
  [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning only' }] }, 'failed', 'FINAL_ASSISTANT_MISSING'],
  [{ role: 'assistant', content: 'API error', stopReason: 'error' }, 'failed', 'MODEL_TURN_FAILED'],
  [{ role: 'assistant', content: '', stopReason: 'aborted' }, 'stopped', 'HOST_TURN_ABORTED'],
]) test(`turn completion reports ${error}`, async (t) => {
  const f = fixture(t); const handle = f.start(); await until(() => handle.snapshot().sendState === 'accepted');
  f.end({ messages: [message] }); const result = await handle.done;
  assert.equal(result.state, state); assert.equal(result.error, error); assert.equal(result.abortOutcome, 'aborted');
});

for (const catalog of ['model', 'tool']) test(`unknown saved ${catalog} fails explicitly before creating a session`, async (t) => {
  const f = fixture(t);
  if (catalog === 'model') f.sdk.models.listAvailable = async () => ({ models: [] });
  else f.sdk.tools.list = async () => [];
  const result = await f.start().done;
  assert.equal(result.error, catalog === 'model' ? 'MODEL_NOT_AVAILABLE' : 'TOOL_NOT_AVAILABLE');
  assert.equal(f.calls.some((entry) => entry.name === 'sessions.create'), false);
});

test('input validation rejects general write/exec, namespaces, invalid callbacks and missing explicit saved model', (t) => {
  const f = fixture(t);
  for (const change of [{ toolNames: ['read', 'exec'] }, { toolNames: ['read', 'write'] }, { toolNames: ['read', 'app:hana-math/fact_search'] }, { toolNames: ['read', 'read'] },
    { selection: { agentId: 'saved' } }, { onBound: null }, { cwd: 'relative' }, { deadlineAt: NaN }, { role: 'observer' }]) assert.throws(() => f.start(change));
  assert.equal(f.calls.length, 0);
});

test('paper reviser accepts only explicit toolless empty-tool sessions', async t => {
  const f = fixture(t), input = { role: 'paper-reviser', selection: { agentId: 'math-paper-reviser-saved', model }, cwd: '/fixture/revision',
    toolNames: [], toolless: true, prompt: 'Opaque patch request.', deadlineAt: Date.now() + 60000,
    onBound: async binding => { f.bindings.push(structuredClone(binding)); return { ok: true }; } };
  const handle = f.service.start(input); await until(() => f.bindings.length === 1);
  assert.ok(f.calls.some(entry => entry.name === 'sessions.create'));
  assert.ok(f.calls.some(entry => entry.name === 'sessions.setActiveTools' && entry.input.toolNames.length === 0));
  assert.ok(f.calls.some(entry => entry.name === 'sessions.send'));
  f.end(); assert.equal((await handle.done).state, 'completed');
  for (const invalid of [{ toolNames: ['read'] }, { toolNames: [], toolless: undefined }, { toolNames: ['read'], toolless: true }, { toolNames: [], toolless: false }]) {
    assert.throws(() => f.service.start({ ...input, ...invalid }));
  }
});

for (const [key, value] of [['ownerPluginId', 'foreign'], ['agentId', 'another-agent'], ['cwd', '/elsewhere'], ['namespace', 'home'], ['visibility', 'public'], ['modelId', 'fallback'], ['modelProvider', 'fallback']]) {
  test(`session receipt mismatch ${key} cannot send or bind`, async (t) => {
    const f = fixture(t); const original = f.sdk.sessions.create;
    f.sdk.sessions.create = async (input) => ({ ...await original(input), [key]: value });
    const result = await f.start().done;
    assert.equal(result.state, 'failed'); assert.match(result.error, /^SESSION_(BINDING|MODEL)_MISMATCH$/);
    assert.equal(f.bindings.length, 0); assert.equal(f.calls.some((entry) => entry.name === 'sessions.send'), false);
    if (key.startsWith('model')) assert.equal(result.abortOutcome, 'aborted');
    else assert.equal(f.calls.some((entry) => entry.name === 'sessions.abort'), false);
  });
}

for (const [name, change] of [['expanded', { toolNames: ['read', 'opaque', 'exec'] }], ['duplicate', { toolNames: ['read', 'read'] }],
  ['pending-empty', { pendingToolNames: [] }], ['pending-missing', { pendingToolNames: undefined }], ['deferred', { effective: 'next-turn' }],
  ['foreign', { sessionId: 'foreign' }], ['missing-read', { toolNames: ['other', 'opaque'] }], ['unsafe', { toolNames: ['read', 'write'] }]]) {
  test(`unconfirmed tool receipt ${name} refuses model start`, async (t) => {
    const f = fixture(t); const original = f.sdk.sessions.setActiveTools;
    f.sdk.sessions.setActiveTools = async (input) => ({ ...await original(input), ...change });
    const result = await f.start().done;
    assert.equal(result.error, 'TOOL_SELECTION_UNCONFIRMED'); assert.equal(result.abortOutcome, 'aborted');
    assert.equal(f.calls.some((entry) => entry.name === 'sessions.send'), false);
  });
}

test('binding rejection is explicit and no model can start before persistence finishes', async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t);
  let bindingStarted = false;
  const handle = f.start({ onBound: async () => { bindingStarted = true; await gate.promise; throw Object.assign(new Error('private persistence detail'), { code: 'BINDING_FAILED' }); } });
  await until(() => bindingStarted); assert.equal(handle.snapshot().setupPending, true);
  assert.equal(f.calls.some((entry) => entry.name === 'sessions.send'), false);
  gate.resolve(); const result = await handle.done;
  assert.equal(result.error, 'BINDING_FAILED'); assert.equal(result.abortOutcome, 'aborted');
  assert.doesNotMatch(JSON.stringify(result), /private persistence detail/);
});

for (const stage of ['catalog', 'create', 'binding', 'tools', 'subscription', 'send']) test(`stop during slow ${stage} returns promptly and compensates late resources`, async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t); let entered = false;
  const wrap = (fn) => async (...args) => { const result = await fn(...args); entered = true; await gate.promise; return result; };
  const change = {};
  if (stage === 'catalog') f.sdk.models.listAvailable = wrap(f.sdk.models.listAvailable);
  if (stage === 'create') f.sdk.sessions.create = wrap(f.sdk.sessions.create);
  if (stage === 'binding') change.onBound = wrap(f.input.onBound);
  if (stage === 'tools') f.sdk.sessions.setActiveTools = wrap(f.sdk.sessions.setActiveTools);
  if (stage === 'subscription') f.sdk.bus.subscribe = wrap(f.sdk.bus.subscribe);
  if (stage === 'send') f.sdk.sessions.send = wrap(f.sdk.sessions.send);
  const handle = f.start(change); assert.equal(handle instanceof Promise, false);
  await until(() => entered); assert.equal(handle.snapshot().setupPending, true);
  const stopped = await handle.stop(); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.cleanupPending, true);
  if (stage === 'send') assert.equal(stopped.abortOutcome, 'awaiting-send-receipt');
  gate.resolve(); await f.service.dispose();
  const result = handle.snapshot(); assert.equal(result.state, 'stopped'); assert.equal(result.cleanupPending, false);
  assert.equal(f.calls.filter((entry) => entry.name === 'sessions.send').length, stage === 'send' ? 1 : 0);
  assert.equal(f.calls.filter((entry) => entry.name === 'sessions.abort').length, stage === 'catalog' ? 0 : stage === 'send' ? 2 : 1);
  for (const entry of f.calls.filter((entry) => entry.name === 'sessions.abort')) assert.equal(entry.input.sessionId, 'fixture-session');
  if (stage === 'subscription' || stage === 'send') assert.equal(f.calls.filter((entry) => entry.name === 'unsubscribe').length, 1);
  assert.equal(f.updates.at(-1).state, 'stopped'); assert.equal(f.updates.at(-1).cleanupPending, false);
  if (stage === 'create') assert.equal(f.updates.at(-1).sessionId, 'fixture-session');
});

test('slow send does not block snapshot; early agent_end cannot succeed until acceptance', async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t); const original = f.sdk.sessions.send;
  f.sdk.sessions.send = async (input) => { const receipt = await original(input); await gate.promise; return receipt; };
  const handle = f.start(); await until(() => f.calls.some((entry) => entry.name === 'sessions.send'));
  f.end(); await turn(); assert.equal(handle.snapshot().state, 'running'); assert.equal(handle.snapshot().sendPending, true);
  gate.resolve(); const result = await handle.done;
  assert.equal(result.state, 'completed'); assert.equal(result.finalText, 'Final software fixture text');
});

test('rejected acceptance cannot be turned into success by an earlier event', async (t) => {
  const f = fixture(t);
  f.sdk.sessions.send = async () => { f.end(); return { accepted: false, sessionPath: f.session.sessionPath }; };
  const result = await f.start().done; assert.equal(result.error, 'SEND_NOT_ACCEPTED'); assert.equal(result.abortOutcome, 'aborted');
});

test('absolute deadline aborts a pending send, and its late receipt causes a second exact abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t); const original = f.sdk.sessions.send;
  f.sdk.sessions.send = async (input) => { const receipt = await original(input); await gate.promise; return receipt; };
  const handle = f.start({ deadlineAt: Date.now() + 1000 }); await until(() => f.calls.some((entry) => entry.name === 'sessions.send'));
  t.mock.timers.tick(1000); const result = await handle.done;
  assert.equal(result.state, 'timed-out'); assert.equal(result.abortOutcome, 'awaiting-send-receipt');
  gate.resolve(); await f.service.dispose();
  assert.equal(handle.snapshot().abortOutcome, 'aborted'); assert.equal(handle.snapshot().cleanupPending, false);
  assert.equal(f.calls.filter((entry) => entry.name === 'sessions.abort').length, 2);
});

test('dispose bounds waiting and still tracks an accepted send after it returns', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t); const original = f.sdk.sessions.send;
  f.sdk.sessions.send = async (input) => { const receipt = await original(input); await gate.promise; return receipt; };
  const handle = f.start(); await until(() => f.calls.some((entry) => entry.name === 'sessions.send'));
  const disposing = f.service.dispose(); await handle.done; await turn(); t.mock.timers.tick(10000); await disposing;
  assert.equal(handle.snapshot().cleanupPending, true); assert.equal(handle.snapshot().sendPending, true);
  gate.resolve(); await f.service.dispose();
  assert.equal(handle.snapshot().abortOutcome, 'aborted'); assert.equal(handle.snapshot().lateSendReceipt, true);
  assert.equal(f.calls.filter((entry) => entry.name === 'sessions.abort').length, 2);
  assert.throws(() => f.start(), { code: 'DISPOSED' });
});

test('late rejected send, failed second abort and onUpdate errors remain visible without skipping cleanup', async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t); const original = f.sdk.sessions.send;
  let rejectUpdates = false; let aborts = 0;
  f.sdk.sessions.send = async (input) => { await original(input); await gate.promise; throw Object.assign(new Error('secret raw host error'), { code: 'FORBIDDEN' }); };
  const abort = f.sdk.sessions.abort;
  f.sdk.sessions.abort = async (input) => { aborts += 1; if (aborts === 2) throw Object.assign(new Error('private abort text'), { code: 'FORBIDDEN' }); return abort(input); };
  const handle = f.start({ onUpdate: async (record) => { if (rejectUpdates) throw new Error('credential fixture'); f.updates.push(record); } });
  await until(() => f.calls.some((entry) => entry.name === 'sessions.send')); rejectUpdates = true;
  await handle.stop(); gate.resolve(); await f.service.dispose();
  const result = handle.snapshot(); assert.equal(aborts, 2); assert.equal(result.state, 'stopped'); assert.equal(result.abortOutcome, 'failed');
  assert.equal(result.cleanupPending, true); assert.equal(result.updateFailed, true); assert.equal(result.sendPending, false);
  assert.ok(result.errors.some((entry) => entry.operation === 'send-receipt' && entry.code === 'FORBIDDEN'));
  assert.doesNotMatch(JSON.stringify(result), /secret raw|private abort|credential fixture/);
});

test('onUpdate failure after binding aborts the owned session instead of bypassing cleanup', async (t) => {
  const f = fixture(t); const handle = f.start({ onUpdate: async (record) => { if (record.bound) throw new Error('fixture write failure'); } });
  const result = await handle.done; assert.equal(result.error, 'UPDATE_FAILED'); assert.equal(result.abortOutcome, 'aborted');
  assert.equal(result.updateFailed, true); assert.equal(f.calls.some((entry) => entry.name === 'sessions.send'), false);
});

test('a timed-out persistence callback cannot block cleanup or overwrite the later terminal update', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t); let entered = false;
  const handle = f.start({ onUpdate: async (record) => {
    if (record.phase === 'tool-selection') { entered = true; await gate.promise; }
    f.updates.push(record);
  } });
  await until(() => entered); t.mock.timers.tick(10000);
  await until(() => handle.snapshot().abortOutcome === 'aborted');
  t.mock.timers.tick(10000); const result = await handle.done;
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'UPDATE_FAILED'); assert.equal(result.cleanupPending, true);
  assert.ok(result.errors.some((entry) => entry.operation === 'onUpdate' && entry.code === 'CONTROL_TIMEOUT'));
  gate.resolve(); await f.service.dispose();
  assert.equal(handle.snapshot().cleanupPending, false); assert.equal(f.updates.at(-1).state, 'failed'); assert.equal(f.updates.at(-1).cleanupPending, false);
  assert.equal(f.calls.some((entry) => entry.name === 'sessions.send'), false);
});

for (const method of ['create', 'setActiveTools', 'send']) test(`host permission failure in ${method} is explicit and has no fallback`, async (t) => {
  const f = fixture(t);
  f.sdk.sessions[method] = async () => { throw Object.assign(new Error('raw private error fixture'), { code: 'FORBIDDEN' }); };
  const result = await f.start().done;
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'FORBIDDEN');
  if (method !== 'create') assert.equal(result.abortOutcome, 'aborted');
  assert.doesNotMatch(JSON.stringify(result), /raw private error fixture/);
});

test('thinking selection Host create permission rejection preserves exact request without retry or send', async t => {
  const f = fixture(t, { catalog: { models: [{ ...model, thinkingLevels: ['high'] }] } });
  const requests = [];
  f.sdk.sessions.create = async input => {
    requests.push(structuredClone(input));
    throw new AppSdkError({ code: 'APP_HOST_ERROR', operation: 'session:create', kind: 'permission', message: 'private fixture rejection' });
  };
  const result = await f.start({ selection: { ...f.input.selection, thinkingLevel: 'high' } }).done;
  assert.equal(requests.length, 1); assert.equal(requests[0].thinkingLevel, 'high'); assert.deepEqual(requests[0].model, model);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'APP_HOST_ERROR'); assert.equal(result.failurePhase, 'session-create');
  assert.equal(result.sdkError.code, 'APP_HOST_ERROR'); assert.equal(result.sdkError.operation, 'session:create');
  assert.equal(result.thinkingLevel, 'high'); assert.equal(Object.hasOwn(result, 'reportedThinkingLevel'), false);
  assert.equal(f.calls.some(c => c.name === 'sessions.send'), false); assert.equal(f.bindings.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private fixture rejection/);
});

test('stop immediately after start does not create a session or run a model', async (t) => {
  const f = fixture(t); const handle = f.start();
  await handle.stop(); await f.service.dispose(); assert.equal(f.calls.length, 0); assert.equal(handle.snapshot().cleanupPending, false);
});

test('abort false confirms only strict owned idle contexts, including explicitly unloaded sessions', async (t) => {
  for (const context of [
    { pendingMessageCount: 0, systemPrompt: 'loaded', model },
    { pendingMessageCount: null, systemPrompt: null, model: null },
  ]) {
    const f = fixture(t); const handle = f.start(); await until(() => handle.snapshot().sendState === 'accepted');
    f.sdk.sessions.abort = async ({ sessionId }) => ({ aborted: false, sessionId });
    f.sdk.sessions.context = async ({ sessionId }) => ({ sessionId, isStreaming: false, isCompacting: false, ...context });
    const stopped = await handle.stop(); assert.equal(stopped.abortOutcome, 'idle-confirmed'); assert.equal(stopped.cleanupPending, false);
  }
});

test('busy, unknown pending counts and foreign identity cannot certify idle', async (t) => {
  for (const patch of [{ isStreaming: true }, { isCompacting: true }, { pendingMessageCount: 1 }, { pendingMessageCount: null }, { sessionId: 'foreign' }]) {
    const f = fixture(t); const handle = f.start(); await until(() => handle.snapshot().sendState === 'accepted');
    f.sdk.sessions.abort = async ({ sessionId }) => ({ aborted: false, sessionId });
    f.sdk.sessions.context = async ({ sessionId }) => ({ sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0, systemPrompt: 'loaded', model, ...patch });
    assert.equal((await handle.stop()).cleanupPending, true);
  }
  const f = fixture(t); const handle = f.start(); await until(() => handle.snapshot().sendState === 'accepted');
  const get = f.sdk.sessions.get;
  f.sdk.sessions.get = async (input) => ({ session: { ...(await get(input)).session, agentId: 'foreign' } });
  await assert.rejects(confirmResearchSessionStop(f.sdk, handle.snapshot()), { code: 'STOP_SESSION_MISMATCH' });
  assert.equal(f.calls.filter((c) => c.name === 'sessions.abort').length, 0);
});

test('unknown send receipt cannot be cleared by idle, but explicit later abort may confirm', async (t) => {
  const f = fixture(t);
  f.sdk.sessions.send = async () => { throw new Error('unknown delivery'); };
  f.sdk.sessions.abort = async ({ sessionId }) => ({ aborted: false, sessionId });
  const handle = f.start(); const result = await handle.done;
  assert.equal(result.sendState, 'unconfirmed'); assert.equal(result.cleanupPending, true);
  assert.equal((await handle.stop()).cleanupPending, true);
  f.sdk.sessions.abort = async ({ sessionId }) => ({ aborted: true, sessionId });
  assert.equal((await handle.stop()).abortOutcome, 'aborted'); assert.equal(handle.snapshot().cleanupPending, false);
  assert.ok(handle.snapshot().errors.some((e) => e.code === 'SEND_UNCONFIRMED'));
});

test('native aborted turn_end stops without agent_end, including while send receipt is pending', async (t) => {
  for (const pending of [false, true]) {
    const f = fixture(t), gate = deferred(); t.after(() => gate.resolve()); const send = f.sdk.sessions.send;
    if (pending) f.sdk.sessions.send = async (input) => { const receipt = await send(input); await gate.promise; return receipt; };
    const handle = f.start(); await until(() => f.calls.some((c) => c.name === 'sessions.send'));
    f.emit({ type: 'turn_end', aborted: true, sessionId: 'foreign' }); await turn(); assert.equal(handle.snapshot().state, 'running');
    f.emit({ type: 'turn_end', aborted: true, sessionId: f.session.sessionId });
    const result = await handle.done; assert.equal(result.state, 'stopped'); assert.equal(result.modelStopReason, 'aborted');
    assert.ok(f.calls.find((c) => c.name === 'bus.subscribe').input.types.includes('turn_end'));
    if (pending) { assert.equal(result.cleanupPending, true); gate.resolve(); await f.service.dispose(); assert.equal(handle.snapshot().cleanupPending, false); }
  }
});

test('native stop after subscribing but before send prevents the first send', async (t) => {
  const f = fixture(t); let interrupted = false;
  const handle = f.start({ onUpdate: async (record) => {
    if (!interrupted && record.phase === 'send' && record.sendState === 'not-sent') {
      interrupted = true; f.emit({ type: 'turn_end', aborted: true, sessionId: record.sessionId });
    }
  } });
  const result = await handle.done; assert.equal(result.state, 'stopped'); assert.equal(result.modelStopReason, 'aborted');
  assert.equal(f.calls.filter((c) => c.name === 'sessions.send').length, 0);
});

test('explicit repeated stop retries abort and unsubscribe failures without another send', async (t) => {
  const f = fixture(t); let aborts = 0, unsubscriptions = 0;
  const subscribe = f.sdk.bus.subscribe;
  f.sdk.bus.subscribe = async (...args) => { const close = await subscribe(...args); return async () => { if (++unsubscriptions === 1) throw new Error('temporary unsubscribe'); await close(); }; };
  f.sdk.sessions.abort = async ({ sessionId }) => { if (++aborts === 1) throw new Error('temporary abort'); return { aborted: false, sessionId }; };
  const handle = f.start(); await until(() => handle.snapshot().sendState === 'accepted');
  assert.equal((await handle.stop()).cleanupPending, true);
  const stopped = await handle.stop(); assert.equal(stopped.cleanupPending, false); assert.equal(stopped.abortOutcome, 'idle-confirmed');
  assert.equal(aborts, 2); assert.equal(unsubscriptions, 2); assert.equal(stopped.errors.length >= 2, true);
  assert.equal(f.calls.filter((c) => c.name === 'sessions.send').length, 1);
});

for (const pending of [false, true]) test(`session:send error terminates ${pending ? 'pending' : 'accepted'} send without exposing raw error`, async (t) => {
  const f = fixture(t), gate = deferred(); t.after(() => gate.resolve()); const send = f.sdk.sessions.send;
  if (pending) f.sdk.sessions.send = async (input) => { const receipt = await send(input); await gate.promise; return receipt; };
  const handle = f.start();
  await until(() => pending ? f.calls.some((c) => c.name === 'sessions.send') : handle.snapshot().phase === 'awaiting-agent-end');
  if (pending) { f.end(); await turn(); } // Block the ordinary event queue on acceptance.
  f.emit({ type: 'error', source: 'session:send', sessionId: f.session.sessionId, error: { message: 'PRIVATE_EVENT', stack: 'PRIVATE_STACK' } });
  const result = await handle.done;
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'SESSION_SEND_COMPLETION_FAILED');
  assert.equal(result.failurePhase, pending ? 'send' : 'awaiting-agent-end');
  assert.equal(result.modelStopReason, null);
  assert.ok(f.calls.find((c) => c.name === 'bus.subscribe').input.types.includes('error'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_EVENT|PRIVATE_STACK/);
  if (pending) {
    assert.equal(result.cleanupPending, true); assert.equal(result.abortOutcome, 'awaiting-send-receipt');
    gate.resolve(); await f.service.dispose();
    assert.equal(handle.snapshot().lateSendReceipt, true); assert.equal(handle.snapshot().cleanupPending, false);
    assert.equal(f.calls.filter((c) => c.name === 'sessions.abort').length, 2);
  }
  await handle.stop(); assert.equal(handle.snapshot().failurePhase, result.failurePhase);
});

test('foreign path, ID, source and pre-send errors are not completion evidence', async (t) => {
  const f = fixture(t); let early = false;
  const handle = f.start({ onUpdate: async (record) => {
    if (!early && record.phase === 'send') {
      early = true; f.emit({ type: 'error', source: 'session:send', sessionId: record.sessionId });
      await turn();
    }
  } });
  await until(() => handle.snapshot().phase === 'awaiting-agent-end');
  for (const [patch, sourcePath] of [
    [{}, '/foreign.jsonl'], [{ sessionId: 'foreign' }], [{ sessionId: null }], [{ sessionId: '' }],
    [{ source: 'session:create' }], [{ source: undefined }],
  ]) {
    f.emit({ type: 'error', source: 'session:send', ...patch }, sourcePath);
    await turn(); assert.equal(handle.snapshot().state, 'running');
  }
  assert.equal(early, true); f.end(); assert.equal((await handle.done).state, 'completed');
  f.emit({ type: 'error', source: 'session:send' }); await turn(); assert.equal(handle.snapshot().state, 'completed');
});

for (const [name, patch, sourcePath] of [
  ['path', {}, '/foreign.jsonl'], ['ID', { sessionId: 'foreign' }],
  ['null ID', { sessionId: null }], ['source', { source: 'session:create' }],
]) test(`ignored error with wrong ${name} preserves the in-flight event queue`, async (t) => {
  const f = fixture(t), gate = deferred(); t.after(() => gate.resolve()); let updating = false;
  const handle = f.start({ onUpdate: async (record) => {
    if (record.retryEvents === 1 && !updating) { updating = true; await gate.promise; }
  } });
  await until(() => handle.snapshot().phase === 'awaiting-agent-end');
  f.emit({ type: 'agent_end', willRetry: true }); await until(() => updating);
  f.emit({ type: 'error', source: 'session:send', ...patch }, sourcePath);
  f.emit({ type: 'agent_end', willRetry: true }); f.end();
  await turn(); await turn();
  // Check processing order while the first notification is blocked, not merely
  // the eventual terminal state: neither later ordinary event may run yet.
  assert.equal(handle.snapshot().retryEvents, 1); assert.equal(handle.snapshot().roundEnded, false);
  assert.equal(handle.snapshot().state, 'running');
  gate.resolve(); const result = await handle.done;
  assert.equal(result.retryEvents, 2); assert.equal(result.state, 'completed');
});

test('async send error plus unknown late send cannot use idle to claim cleanup', async (t) => {
  const f = fixture(t), gate = deferred(); t.after(() => gate.resolve()); const send = f.sdk.sessions.send;
  f.sdk.sessions.send = async (input) => { await send(input); await gate.promise; throw new Error('PRIVATE_SEND'); };
  f.sdk.sessions.abort = async ({ sessionId }) => ({ aborted: false, sessionId });
  const handle = f.start(); await until(() => f.calls.some((c) => c.name === 'sessions.send'));
  f.emit({ type: 'error', source: 'session:send' });
  assert.equal((await handle.done).abortOutcome, 'awaiting-send-receipt');
  gate.resolve(); await f.service.dispose();
  const result = handle.snapshot(); assert.equal(result.sendState, 'unconfirmed'); assert.equal(result.cleanupPending, true);
  assert.equal(result.abortOutcome, 'failed'); assert.equal(result.error, 'SESSION_SEND_COMPLETION_FAILED');
  assert.equal(result.failurePhase, 'send'); assert.ok(result.errors.some((e) => e.code === 'SEND_UNCONFIRMED'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SEND/);
});

test('formal SDK diagnostics retain only validated metadata and original failure phase', async (t) => {
  const sdkError = new AppSdkError({ code: 'APP_CAPABILITY_DENIED', operation: 'session:create', kind: 'permission',
    capability: 'sessions.create', message: 'PRIVATE_MESSAGE', details: { secret: 'PRIVATE_DETAIL' } });
  const f = fixture(t); f.sdk.sessions.create = async () => { throw sdkError; };
  const handle = f.start(); const result = await handle.done;
  assert.equal(result.failurePhase, 'session-create');
  assert.equal(result.sdkError.code, 'APP_CAPABILITY_DENIED'); assert.equal(result.sdkError.operation, 'session:create');
  assert.equal(result.sdkError.kind, 'permission');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MESSAGE|PRIVATE_DETAIL/);
  await handle.stop(); assert.equal(handle.snapshot().failurePhase, 'session-create');
  const safe = researchSessionDiagnostics({ agentId: '/PRIVATE/path', error: 'PRIVATE error', phase: 'PRIVATE_PHASE',
    failurePhase: 'PRIVATE_PHASE', sendState: 'PRIVATE_SEND', modelStopReason: 'PRIVATE_STOP',
    sdkError: { code: 'X'.repeat(65), operation: 'PRIVATE_OP', kind: 'PRIVATE_KIND', capability: 'PRIVATE_CAP', details: 'PRIVATE_DETAIL' },
    transcript: 'PRIVATE_TRANSCRIPT' });
  assert.deepEqual(safe, { agentId: null, error: null, phase: null, failurePhase: null, sendState: null, modelStopReason: null,
    actualModel: null, sdkError: { code: null, operation: null, kind: null, capability: null } });
});

test('an expired deadline starts no host work', async (t) => {
  const f = fixture(t); const result = await f.start({ deadlineAt: Date.now() - 1 }).done;
  assert.equal(result.state, 'timed-out'); assert.equal(f.calls.length, 0);
});

async function pausedWorker(f, change = {}) {
  const handle = f.start({ turnMode: 'controlled', ...change });
  await until(() => handle.snapshot().phase === 'awaiting-agent-end');
  f.end(); const first = await handle.nextTurn();
  assert.equal(first.state, 'running'); assert.equal(first.modelTurn, 1);
  assert.equal(first.turnEnded, true); assert.equal(first.roundEnded, false);
  return handle;
}

test('controlled mode is explicitly worker-only; default handle stays one-shot', async (t) => {
  const f = fixture(t);
  for (const change of [{ role: 'main', turnMode: 'controlled' }, { role: 'verifier', turnMode: 'controlled' },
    { turnMode: null }, { turnMode: 'one-shot' }, { turnMode: true }]) assert.throws(() => f.start(change), { code: 'INVALID_TURN_MODE' });
  assert.equal(f.calls.length, 0);
  const handle = f.start(); assert.deepEqual(Object.keys(handle).sort(), ['done', 'snapshot', 'stop']);
  assert.equal(Object.hasOwn(handle.snapshot(), 'modelTurn'), false);
  await handle.stop();
});

test('controlled official SDK keeps one SID/model/tools/cwd through multiple turns; only complete resolves done', async (t) => {
  const f = fixture(t, { officialSdk: true }); const handle = await pausedWorker(f);
  let done = false; handle.done.then(() => { done = true; });
  const first = await handle.nextTurn(); first.model.id = 'mutated-copy';
  assert.deepEqual((await handle.nextTurn()).model, model);
  assert.equal(handle.snapshot().phase, 'awaiting-feedback'); assert.equal(handle.snapshot().cleanupPending, false);
  assert.ok(f.calls.find(c => c.name === 'bus.subscribe').input.types.includes('agent_start'));
  for (const n of [2, 3]) {
    const receipt = await handle.resume(`Opaque feedback ${n}`);
    assert.deepEqual(receipt, { accepted: true, sessionId: f.session.sessionId, modelTurn: n });
    assert.equal(done, false); assert.equal(handle.snapshot().turnEnded, false);
    f.emit({ type: 'agent_start', sessionId: f.session.sessionId });
    f.emit({ type: 'message_end', message: { role: 'assistant', content: `Opaque revision ${n}`, stopReason: 'stop' } });
    f.emit({ type: 'agent_end' });
    const ended = await handle.nextTurn();
    assert.equal(ended.modelTurn, n); assert.equal(ended.finalText, `Opaque revision ${n}`);
    assert.equal(ended.state, 'running'); assert.equal(ended.turnEnded, true); assert.equal(ended.roundEnded, false);
    assert.equal(done, false);
  }
  for (const name of ['sessions.create', 'sessions.setActiveTools', 'bound', 'bus.subscribe']) assert.equal(f.calls.filter(c => c.name === name).length, 1);
  const sends = f.calls.filter(c => c.name === 'sessions.send'); assert.equal(sends.length, 3);
  assert.ok(sends.every(c => c.input.sessionId === f.session.sessionId));
  assert.deepEqual(sends.slice(1).map(c => c.input.text), ['Opaque feedback 2', 'Opaque feedback 3']);
  assert.equal(f.calls.some(c => c.name === 'unsubscribe' || c.name === 'sessions.abort'), false);
  assert.ok(f.updates.filter(s => s.turnEnded).every(s => s.state === 'running'));
  const result = await handle.complete(); assert.equal(result.state, 'completed'); assert.equal(result.roundEnded, true);
  assert.equal((await handle.done).modelTurn, 3); assert.equal((await handle.nextTurn()).state, 'completed');
  assert.equal(f.calls.filter(c => c.name === 'unsubscribe').length, 1);
  assert.equal(f.calls.some(c => c.name === 'sessions.abort'), false);
  assert.deepEqual(result.model, model); assert.equal(result.cwd, f.input.cwd);
});

for (const resumed of [false, true]) test(`controlled early end waits for ${resumed ? 'resumed' : 'initial'} send receipt`, async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t);
  let handle = resumed ? await pausedWorker(f) : null; const send = f.sdk.sessions.send;
  f.sdk.sessions.send = async input => {
    const receipt = await send(input); f.emit({ type: 'agent_start' }); f.end(); f.end(); await gate.promise; return receipt;
  };
  const sending = resumed ? handle.resume('Opaque feedback') : null;
  if (!handle) handle = f.start({ turnMode: 'controlled' });
  let settled = false; const waiting = handle.nextTurn().then(s => { settled = true; return s; });
  await until(() => f.calls.filter(c => c.name === 'sessions.send').length === (resumed ? 2 : 1));
  await turn(); assert.equal(settled, false); assert.equal(handle.snapshot().sendPending, true);
  assert.equal(handle.snapshot().turnEnded, false);
  gate.resolve(); if (sending) await sending;
  const result = await waiting; assert.equal(result.modelTurn, resumed ? 2 : 1); assert.equal(result.state, 'running');
  await handle.complete();
});

test('paused/old ends, pre-start events and wrong SID cannot end or prime a resumed turn', async (t) => {
  const f = fixture(t); const handle = await pausedWorker(f);
  f.end(); f.emit({ type: 'agent_start' }); f.end();
  await handle.resume('Opaque feedback');
  let ended = false; const waiting = handle.nextTurn().then(s => { ended = true; return s; });
  f.end(); f.emit({ type: 'message_end', message: { role: 'assistant', content: 'OLD QUEUED TEXT', stopReason: 'stop' } });
  for (const [data, source] of [[{ sessionId: 'foreign' }], [{ sessionId: null }], [{ sessionId: '' }], [{}, '/foreign']]) {
    f.emit({ type: 'agent_start', ...data }, source); f.end({ ...data });
  }
  f.end(); await turn(); assert.equal(ended, false); assert.equal(handle.snapshot().finalText, '');
  f.emit({ type: 'agent_start' }); f.end({ sessionId: 'foreign' }); await turn(); assert.equal(ended, false);
  f.end(); assert.equal((await waiting).modelTurn, 2); await handle.complete();
});

test('queued early duplicate ends cannot complete the next generation or block callback return', async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t); const send = f.sdk.sessions.send;
  f.sdk.sessions.send = async input => { const value = await send(input); await gate.promise; return value; };
  const handle = f.start({ turnMode: 'controlled' });
  await until(() => f.calls.some(c => c.name === 'sessions.send'));
  assert.equal(f.emit({ type: 'agent_end', willRetry: true }), undefined);
  assert.equal(f.end(), undefined); assert.equal(f.end(), undefined);
  const next = handle.nextTurn().then(() => handle.resume('Opaque next generation'));
  gate.resolve(); await next;
  assert.equal(handle.snapshot().modelTurn, 2); assert.equal(handle.snapshot().retryEvents, 1);
  assert.equal(handle.snapshot().turnEnded, false); assert.equal(handle.snapshot().roundEnded, false);
  f.end(); await turn(); assert.equal(handle.snapshot().turnEnded, false);
  f.emit({ type: 'agent_start' }); f.end(); await handle.nextTurn(); await handle.complete();
});

test('resume reserves synchronously; concurrent resume/complete and invalid prompt never start another send', async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t);
  const handle = await pausedWorker(f, { onUpdate: async s => { if (s.modelTurn === 2 && s.phase === 'send') await gate.promise; f.updates.push(s); } });
  for (const prompt of ['', ' ', null, 'x\0y', 'x'.repeat(512 * 1024 + 1)]) await assert.rejects(handle.resume(prompt), { code: 'INVALID_PROMPT' });
  const resumed = handle.resume('Opaque feedback');
  assert.equal(handle.snapshot().modelTurn, 2); assert.equal(handle.snapshot().turnEnded, false); assert.equal(handle.snapshot().sendPending, true);
  await assert.rejects(handle.resume('Concurrent'), { code: 'MODEL_TURN_BUSY' });
  await assert.rejects(handle.complete(), { code: 'MODEL_TURN_BUSY' });
  assert.equal(f.calls.filter(c => c.name === 'sessions.send').length, 1);
  gate.resolve(); await resumed;
  await assert.rejects(handle.complete(), { code: 'MODEL_TURN_NOT_PAUSED' });
  await assert.rejects(handle.resume('Before end'), { code: 'MODEL_TURN_NOT_PAUSED' });
  f.emit({ type: 'agent_start' }); f.end(); await handle.nextTurn(); await handle.complete();
});

for (const outcome of ['accepted', 'rejected', 'unknown', 'throw']) test(`controlled stopped resumed send compensates late ${outcome} without hanging waiters`, async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t); const handle = await pausedWorker(f); const send = f.sdk.sessions.send;
  f.sdk.sessions.send = async input => {
    const receipt = await send(input); await gate.promise;
    if (outcome === 'throw') throw Object.assign(new Error('PRIVATE_LATE_ERROR'), { code: 'FORBIDDEN' });
    return outcome === 'accepted' ? receipt : outcome === 'rejected' ? { ...receipt, accepted: false } : {};
  };
  const sending = assert.rejects(handle.resume('Opaque feedback'), { code: 'STOPPED' });
  const waiters = [handle.nextTurn(), handle.nextTurn()];
  await until(() => f.calls.filter(c => c.name === 'sessions.send').length === 2);
  const stopped = await handle.stop(); assert.equal(stopped.abortOutcome, 'awaiting-send-receipt');
  for (const waiter of waiters) { const result = await waiter; assert.equal(result.state, 'stopped'); assert.equal(result.modelTurn, 2); }
  await sending; gate.resolve(); await f.service.dispose();
  const result = handle.snapshot(); assert.equal(result.lateSendReceipt, true); assert.equal(result.sendPending, false);
  assert.equal(result.cleanupPending, false); assert.equal(result.abortOutcome, 'aborted');
  assert.equal(f.calls.filter(c => c.name === 'sessions.abort').length, 2);
  assert.equal(f.calls.filter(c => c.name === 'sessions.send').length, 2);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_LATE_ERROR/);
});

for (const event of [{ type: 'turn_end', aborted: true }, { type: 'error', source: 'session:send' }]) test(`controlled ${event.type} interrupts a resumed early-end queue`, async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t); const handle = await pausedWorker(f); const send = f.sdk.sessions.send;
  f.sdk.sessions.send = async input => { const receipt = await send(input); f.emit({ type: 'agent_start' }); f.end(); await gate.promise; return receipt; };
  const sending = assert.rejects(handle.resume('Opaque feedback'), { code: 'STOPPED' });
  const waiting = handle.nextTurn(); await until(() => f.calls.filter(c => c.name === 'sessions.send').length === 2);
  f.emit(event); const result = await waiting;
  assert.equal(result.state, event.type === 'error' ? 'failed' : 'stopped');
  assert.equal((await handle.done).state, result.state); await sending;
  gate.resolve(); await f.service.dispose(); assert.equal(handle.snapshot().cleanupPending, false);
});

for (const outcome of ['rejected', 'foreign', 'throw']) test(`controlled resumed ${outcome} send fails despite early start/end`, async (t) => {
  const f = fixture(t); const handle = await pausedWorker(f); const send = f.sdk.sessions.send;
  f.sdk.sessions.send = async input => {
    const receipt = await send(input); f.emit({ type: 'agent_start' }); f.end();
    if (outcome === 'throw') throw Object.assign(new Error('PRIVATE_SEND_BODY'), { code: 'FORBIDDEN' });
    return outcome === 'rejected' ? { ...receipt, accepted: false } : { ...receipt, sessionId: 'foreign' };
  };
  const code = outcome === 'throw' ? 'FORBIDDEN' : 'SEND_NOT_ACCEPTED';
  const sending = assert.rejects(handle.resume('Opaque feedback'), { code });
  const result = await handle.nextTurn(); await sending;
  assert.equal(result.state, 'failed'); assert.equal(result.error, code); assert.equal((await handle.done).state, 'failed');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SEND_BODY/);
});

test('controlled stop with failed abort/unsubscribe resolves all waiters and preserves cleanup flags', async (t) => {
  const f = fixture(t), subscribe = f.sdk.bus.subscribe; let fail = true;
  f.sdk.bus.subscribe = async (...args) => { const close = await subscribe(...args); return async () => { if (fail) throw new Error('unsubscribe fixture'); await close(); }; };
  f.sdk.sessions.abort = async ({ sessionId }) => { if (fail) throw new Error('abort fixture'); return { aborted: true, sessionId }; };
  const handle = await pausedWorker(f); await handle.resume('Opaque feedback'); const waiting = handle.nextTurn();
  const stopped = await handle.stop(); assert.equal(stopped.cleanupPending, true); assert.equal(stopped.abortOutcome, 'failed');
  assert.equal((await waiting).state, 'stopped'); assert.equal((await handle.done).state, 'stopped');
  fail = false; assert.equal((await handle.stop()).cleanupPending, false);
  await assert.rejects(handle.resume('After stop'), { code: 'STOPPED' });
});

test('controlled paused deadline ends the round without another send', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const f = fixture(t); const handle = await pausedWorker(f, { deadlineAt: Date.now() + 1000 });
  t.mock.timers.tick(1000); const result = await handle.done;
  assert.equal(result.state, 'timed-out'); assert.equal(result.failurePhase, 'awaiting-feedback');
  assert.equal((await handle.nextTurn()).state, 'timed-out'); assert.equal(f.calls.filter(c => c.name === 'sessions.send').length, 1);
});

test('controlled pause persistence failure resolves nextTurn as failure, not a usable pause', async (t) => {
  const f = fixture(t); const handle = f.start({ turnMode: 'controlled', onUpdate: async s => { if (s.phase === 'awaiting-feedback') throw new Error('PRIVATE_PERSIST'); } });
  const waiting = handle.nextTurn(); await until(() => handle.snapshot().phase === 'awaiting-agent-end'); f.end();
  const result = await waiting; assert.equal(result.state, 'failed'); assert.equal(result.error, 'UPDATE_FAILED');
  assert.equal(result.failurePhase, 'awaiting-feedback'); assert.equal((await handle.done).state, 'failed');
  await assert.rejects(handle.resume('Unsafe'), { code: 'STOPPED' });
});

test('controlled retry keeps the same generation; a resumed empty end cannot reuse previous text', async (t) => {
  const f = fixture(t); const handle = await pausedWorker(f); await handle.resume('Opaque feedback');
  f.emit({ type: 'agent_start' }); f.end({ willRetry: true }); await until(() => handle.snapshot().retryEvents === 1);
  assert.equal(handle.snapshot().modelTurn, 2); assert.equal(handle.snapshot().turnEnded, false);
  f.emit({ type: 'agent_end' }); const result = await handle.nextTurn();
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'FINAL_ASSISTANT_MISSING');
});

test('controlled end received before agent_start is not retroactively accepted by a later start', async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = fixture(t); const handle = await pausedWorker(f); const send = f.sdk.sessions.send;
  f.sdk.sessions.send = async input => { const receipt = await send(input); f.end(); f.emit({ type: 'agent_start' }); await gate.promise; return receipt; };
  const sending = handle.resume('Opaque feedback'); let settled = false;
  const waiting = handle.nextTurn().then(s => { settled = true; return s; });
  await until(() => f.calls.filter(c => c.name === 'sessions.send').length === 2);
  gate.resolve(); await sending; await turn(); assert.equal(settled, false); assert.equal(handle.snapshot().turnEnded, false);
  f.end(); assert.equal((await waiting).modelTurn, 2); await handle.complete();
});

test('controlled stop immediately after resume reservation performs no second send', async (t) => {
  const f = fixture(t); const handle = await pausedWorker(f);
  const sending = assert.rejects(handle.resume('Opaque feedback'), { code: 'STOPPED' });
  const waiting = handle.nextTurn(); await handle.stop(); await sending; await f.service.dispose();
  assert.equal((await waiting).state, 'stopped'); assert.equal(f.calls.filter(c => c.name === 'sessions.send').length, 1);
  assert.equal(handle.snapshot().sendPending, false); assert.equal(handle.snapshot().sendState, 'not-sent');
  assert.equal(handle.snapshot().phase, 'stopped'); assert.equal(handle.snapshot().cleanupPending, false);
});

test('controlled accepted resume without matching start/end is not completion and times out within the original deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const f = fixture(t); const handle = await pausedWorker(f, { deadlineAt: Date.now() + 1000 });
  await handle.resume('Opaque feedback'); const waiting = handle.nextTurn();
  f.end(); await turn(); assert.equal(handle.snapshot().turnEnded, false);
  t.mock.timers.tick(1000); assert.equal((await waiting).state, 'timed-out'); assert.equal((await handle.done).state, 'timed-out');
  assert.equal(f.calls.filter(c => c.name === 'sessions.create').length, 1);
});

for (const [reason, code, state] of [['error', 'MODEL_TURN_FAILED', 'failed'], ['aborted', 'HOST_TURN_ABORTED', 'stopped']]) test(`controlled resumed model ${reason} settles both waits`, async (t) => {
  const f = fixture(t); const handle = await pausedWorker(f); await handle.resume('Opaque feedback');
  f.emit({ type: 'agent_start' }); f.end({ messages: [{ role: 'assistant', content: 'Opaque final', stopReason: reason }] });
  const result = await handle.nextTurn(); assert.equal(result.state, state); assert.equal(result.error, code);
  assert.equal((await handle.done).state, state); assert.equal(result.modelStopReason, reason);
});

test('controlled setup failure and early complete leave no pending turn promise', async (t) => {
  const f = fixture(t, { catalog: { models: [] } }); const handle = f.start({ turnMode: 'controlled' });
  await assert.rejects(handle.complete(), { code: 'MODEL_TURN_NOT_PAUSED' });
  const result = await handle.nextTurn(); assert.equal(result.error, 'MODEL_NOT_AVAILABLE');
  assert.equal((await handle.done).state, 'failed'); assert.equal(f.calls.some(c => c.name === 'sessions.send'), false);
});

test('controlled narrow diagnostics include only valid phase, generation and ended flag', () => {
  const safe = researchSessionDiagnostics({ phase: 'awaiting-feedback', modelTurn: 2, turnEnded: true });
  assert.equal(safe.phase, 'awaiting-feedback'); assert.equal(safe.modelTurn, 2); assert.equal(safe.turnEnded, true);
  const opaque = { modelTurn: 0, turnEnded: 'PRIVATE' };
  Object.defineProperty(opaque, 'modelTurn', { get() { assert.fail('Diagnostic getter'); } });
  const result = researchSessionDiagnostics(opaque); assert.equal(result.modelTurn, null); assert.equal(result.turnEnded, null);
});
