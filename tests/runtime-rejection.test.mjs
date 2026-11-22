// Isolated Runtime/Project protocol fixtures only; no live Host or mathematical work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as runtime from '../packages/hana-math/runtime/research-runtime.mjs';
import { createProjectCoreAccess } from '../packages/hana-math/project-core-access.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { refusalFixture, refusalDiagnostic, captureRefusal, fixtureBinding } from './rejection-fixture.mjs';
const { runtimeFailureInfo: info, runtimeRejectionInfo: rejection } = runtime;
const rules = [
  ['fact-page-changed','fact_page_changed','fact-index',null,'restart-enumeration'],
  ['invalid-cursor','invalid_cursor','fact-index',null,'fix-request'],
  ['fact-page-bytes','size_limit','fact-index','bytes','report-capacity'],
  ['response-bytes','size_limit','response','bytes','reduce-response-scope'],
  ['shared-fact-bytes','size_limit','canonical-fact','bytes','report-capacity'],
  ['shared-glossary-bytes','size_limit','glossary','bytes','report-capacity'],
  ['shared-verification-bytes','size_limit','verification-trace','bytes','report-capacity'],
  ['shared-other-file-bytes','size_limit','shared-file','bytes','report-capacity'],
  ['shared-tree-bytes','size_limit','shared-tree','bytes','report-capacity'],
  ['shared-tree-files','size_limit','shared-tree','files','report-capacity'],
  ['shared-tree-entries','size_limit','shared-tree','entries','report-capacity'],
  ['control-bytes','capacity_exceeded','control-store','bytes','report-capacity'],
  ['control-entries','capacity_exceeded','control-store','entries','report-capacity'],
  ['other-file-bytes','size_limit','file','bytes','report-capacity'],
];
const cursorReason = reason => ['fact-page-changed', 'invalid-cursor'].includes(reason);
const diagnostic = reason => refusalDiagnostic(reason, cursorReason(reason) ? { observed: null, observedLowerBound: null, limit: null, reserve: null } : {});
const context = { sessionPath: '/fixture/creator.jsonl', callToken: 'opaque-fixture' };
async function toolsFor(t, f, result, projects) {
  const tools = new Map(), unused = async () => { throw new Error('unused fixture business operation'); };
  const service = Object.fromEntries(['run','status','stop','setupStatus','setToolMode','invoke','recordSubmissionInputRejection'].map(k => [k, unused]));
  service.result = result;
  const registration = await registerMathResearch({ dataDir: f.dataDir, tools: { register: async tool => { tools.set(tool.name, tool); return () => {}; } } }, service, projects);
  t.after(() => registration.dispose());
  return (name = 'math_research', args = {}) => tools.get(name).execute({ action: 'result', [name === 'math_project' ? 'projectId' : 'runId']: name === 'math_project' ? fixtureBinding.projectId : fixtureBinding.runId, ...args, context });
}
for (const [reason, code, resource, unit, action] of rules) test(`checked rejection coupling ${reason}`, async t => {
  for (const operation of ['fact_list_page', 'gm_search']) for (const suppliedCode of ['size_limit','capacity_exceeded','fact_page_changed','invalid_cursor','busy','invalid_request']) {
    const f = await refusalFixture(t, { diagnostic: diagnostic(reason), error: { code: suppliedCode, message: '/PRIVATE payload' } });
    const error = await captureRefusal(f.bridge, operation), expected = suppliedCode === code && (!reason.startsWith('fact-page') && reason !== 'invalid-cursor' || operation === 'fact_list_page');
    const value = rejection(info(error));
    if (!expected) assert.equal(value, null, `${reason}/${operation}/${suppliedCode}`);
    else {
      assert.deepEqual(value, { ...diagnostic(reason), origin: 'checked-facade-result', observation: 'at-refusal', resource, unit, suggestedAction: action });
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 2048); assert.ok(!JSON.stringify(value).includes('PRIVATE'));
    }
    await f.bridge.dispose();
  }
});

test('direct identity-only propagation, fresh copies and unchanged Error/DTO enumerable shape', async t => {
  const f = await refusalFixture(t), error = await captureRefusal(f.bridge), own = Reflect.ownKeys(error), dto = info(error), again = info(dto);
  const value = rejection(error); assert.ok(value); assert.deepEqual(rejection(dto), value); assert.deepEqual(rejection(again), value);
  assert.deepEqual(Reflect.ownKeys(error), own); assert.equal(own.some(k => typeof k === 'symbol'), false);
  assert.equal(Object.hasOwn(error, 'diagnostic'), false); assert.equal(Object.hasOwn(error, 'rejection'), false);
  assert.equal(Object.hasOwn(dto, 'diagnostic'), false); assert.equal(Object.hasOwn(dto, 'rejection'), false);
  assert.deepEqual(dto, info(JSON.parse(JSON.stringify(dto))));
  assert.equal(rejection(JSON.parse(JSON.stringify(dto))), null); assert.equal(rejection(structuredClone(dto)), null);
  assert.equal(rejection({ ...dto }), null); assert.equal(rejection(Object.create(dto)), null);
  const copy = rejection(dto); copy.reason = 'PRIVATE'; copy.observed = -1; assert.deepEqual(rejection(dto), value);
  assert.notStrictEqual(rejection(dto), rejection(dto));
  for (const [key, changed] of [['requestId','11111111-1111-1111-1111-111111111111'], ['operation','gm_search'], ['code','RESEARCH_RUNTIME_FAILED']]) {
    const original = dto[key]; dto[key] = changed; assert.equal(rejection(dto), null); assert.equal(rejection(info(dto)), null); dto[key] = original;
  }
  let touched = 0;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'requestId');
  Object.defineProperty(error, 'requestId', { configurable: true, enumerable: true, get() { touched++; return dto.requestId; } });
  assert.equal(rejection(error), null); assert.equal(rejection(info(error)), null); assert.equal(touched, 0);
  Object.defineProperty(error, 'requestId', descriptor);
  const proxy = new Proxy(error, { getOwnPropertyDescriptor() { touched++; throw new Error('PRIVATE'); }, get() { touched++; throw new Error('PRIVATE'); } });
  assert.equal(rejection(proxy), null); assert.equal(touched, 0);
  assert.equal(Object.keys(runtime).some(k => /grant|checkedDiagnostic|checkedRejections/.test(k)), false);
});
const invalidDiagnostics = [null, {}, 'PRIVATE', [], { ...refusalDiagnostic(), extra: '/PRIVATE' },
  ...[{ version: 2 }, { reason: 'PRIVATE'.repeat(600) }, { observed: -1 }, { observed: 1.5 }, { observed: 2 ** 53 },
    { observed: null, observedLowerBound: false }, { observedLowerBound: null }, { observedLowerBound: 'true' },
    { limit: 0 }, { limit: false }, { reserve: -1 }, { reserve: 2 ** 53 }, { reserve: {} }].map(p => refusalDiagnostic('response-bytes', p)),
  refusalDiagnostic('invalid-cursor'), refusalDiagnostic('fact-page-changed')];
for (const [index, value] of invalidDiagnostics.entries()) test(`invalid facade diagnostic ${index} leaves refusal untouched`, async t => {
  const f = await refusalFixture(t, { envelope: e => { e.diagnostic = value; } }), error = await captureRefusal(f.bridge);
  assert.equal(rejection(info(error)), null); assert.deepEqual(error.coreError, { code: 'size_limit', message: '/PRIVATE fixture message' });
});
test('unknown and maximal safe measurements are bounded; diagnostic changes no own keys', async t => {
  const missing = await refusalFixture(t, { envelope: e => { delete e.diagnostic; } }), noDiagnostic = await captureRefusal(missing.bridge);
  for (const values of [{ observed: null, observedLowerBound: null, limit: null, reserve: null },
    { observed: Number.MAX_SAFE_INTEGER, observedLowerBound: true, limit: Number.MAX_SAFE_INTEGER, reserve: Number.MAX_SAFE_INTEGER }]) {
    const f = await refusalFixture(t, { diagnostic: refusalDiagnostic('response-bytes', values) }), error = await captureRefusal(f.bridge);
    assert.deepEqual(Reflect.ownKeys(error), Reflect.ownKeys(noDiagnostic)); assert.deepEqual(error.coreError, noDiagnostic.coreError);
    const result = rejection(info(error)); assert.ok(result); assert.equal(result.observed, values.observed); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
  }
});
test('reusing a genuine Error as a later SDK rejection does not inherit old request provenance', async t => {
  const first = await refusalFixture(t), original = await captureRefusal(first.bridge), oldId = original.requestId;
  assert.ok(rejection(original)); const second = await refusalFixture(t, { startError: original });
  const reused = await second.bridge.call(fixtureBinding, 'gm_search').catch(e => e);
  assert.strictEqual(reused, original); assert.notEqual(reused.requestId, oldId); assert.equal(rejection(info(reused)), null);
});

test('missing fields, nonfinite wire numbers, getters and proxies cannot grant or leak', async t => {
  for (const mode of ['missing', 'infinite', 'getter', 'proxy', 'envelope-getter']) {
    const f = await refusalFixture(t), originalStart = f.sdk.runtime.start; let touched = 0;
    if (mode === 'missing') f.hooks.envelope = e => { delete e.diagnostic.reserve; };
    if (mode === 'infinite') f.sdk.runtime.start = async input => {
      const result = await originalStart(input); const raw = await fs.readFile(input.args[5], 'utf8');
      await fs.writeFile(input.args[5], raw.replace('"observed":1048577', '"observed":1e400')); return result;
    };
    const parse = JSON.parse;
    if (['getter','proxy','envelope-getter'].includes(mode)) JSON.parse = (text, ...args) => {
      const result = parse(text, ...args);
      if (result?.ok === false && result.error?.message === '/PRIVATE fixture message') {
        if (mode === 'envelope-getter') Object.defineProperty(result, 'diagnostic', { get() { touched++; throw new Error('PRIVATE'); } });
        if (mode === 'getter') Object.defineProperty(result.diagnostic, 'reason', { enumerable: true, get() { touched++; throw new Error('PRIVATE'); } });
        if (mode === 'proxy') result.diagnostic = new Proxy(result.diagnostic, { ownKeys() { touched++; throw new Error('PRIVATE'); }, getPrototypeOf() { touched++; throw new Error('PRIVATE'); } });
      }
      return result;
    };
    try { const error = await captureRefusal(f.bridge); assert.equal(rejection(info(error)), null); assert.equal(touched, 0); }
    finally { JSON.parse = parse; }
    await f.bridge.dispose();
  }
});
test('only validated terminal/schema/request ok=false branch grants; SDK prefixed errors never do', async t => {
  for (const mode of ['exit', 'request', 'schema', 'success', 'sdk']) {
    const fake = Object.assign(new Error('/PRIVATE SDK'), { code: 'RESEARCH_RUNTIME_REJECTED', coreError: { code: 'size_limit' }, diagnostic: refusalDiagnostic() });
    const hooks = mode === 'sdk' ? { startError: fake } : mode === 'exit' ? { exitCode: 1 } : { envelope: e => {
      if (mode === 'request') e.requestId = '11111111-1111-1111-1111-111111111111';
      if (mode === 'schema') e.schemaVersion = 2;
      if (mode === 'success') { e.ok = true; e.result = { opaque: true }; }
    } };
    const f = await refusalFixture(t, hooks); let result;
    try { result = await f.bridge.call(fixtureBinding, 'fact_list_page'); } catch (e) { result = e; }
    assert.equal(rejection(result), null); assert.equal(rejection(info(result)), null);
    if (mode === 'sdk') {
      assert.equal(result.startOutcome, 'unknown'); assert.equal(result.cleanup.confirmed, false);
      await assert.rejects(f.bridge.dispose(), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED' });
    } else await f.bridge.dispose();
  }
});
test('busy own keys/coreError are identical with and without unrelated diagnostic', async t => {
  const a = await refusalFixture(t, { error: { code: 'busy', message: 'project is busy' }, envelope: e => { delete e.diagnostic; } });
  const b = await refusalFixture(t, { error: { code: 'busy', message: 'project is busy' } });
  const e1 = await captureRefusal(a.bridge, 'prepare_submission'), e2 = await captureRefusal(b.bridge, 'prepare_submission');
  assert.deepEqual(Reflect.ownKeys(e1), Reflect.ownKeys(e2)); assert.deepEqual(e1.coreError, e2.coreError);
  assert.deepEqual(e2.coreError, { code: 'busy', message: 'project is busy' }); assert.equal(rejection(e2), null);
});

test('actual Runtime -> Project reported runtime reference -> registered tool; JSON persistence loses provenance', async t => {
  const f = await refusalFixture(t), tasks = new Map(), packets = [];
  f.sdk.tasks = {
    async create(input) { const taskId = `task-${tasks.size + 1}`, row = { ...input, taskId, pluginId: 'hana-math', parentSessionId: null, parentSessionPath: null, status: 'pending' }; tasks.set(taskId, row); return structuredClone(row); },
    async get(id) { return structuredClone(tasks.get(id)); },
    async fail(id) { const row = tasks.get(id); row.status = 'failed'; return structuredClone(row); },
    async complete() { assert.fail('refusal must not complete as success'); },
  };
  const access = createProjectCoreAccess(f.sdk, { projectId: fixtureBinding.projectId, author: fixtureBinding.author,
    createCore: options => f.create(options), onState: async packet => { packets.push(JSON.parse(JSON.stringify(packet))); } });
  t.after(() => access.dispose()); let wrapped;
  const unused = async () => { throw new Error('unused project operation'); };
  const projects = Object.fromEntries(['create','list','status','assign','start','stop','invoke','handles','goal','mainGoal'].map(k => [k, unused]));
  projects.result = async (_args, ctx) => { assert.equal(ctx, context); try { return await access.call('fact_list_page', {}); } catch (e) { wrapped = e; throw e; } };
  const call = await toolsFor(t, f, unused, projects), reply = await call('math_project');
  assert.equal(reply.isError, true); assert.equal(reply.details.error.rejection.reason, 'response-bytes');
  assert.equal(wrapped.code, 'RESEARCH_RUNTIME_REJECTED'); assert.equal(rejection(wrapped), null);
  assert.ok(rejection(wrapped.runtime)); assert.equal(rejection(JSON.parse(JSON.stringify(wrapped.runtime))), null);
  assert.equal(reply.details.error.runtime.cleanup.confirmed, true); assert.equal(reply.details.error.runtime.indeterminate, false);
  assert.ok(!JSON.stringify(reply).includes('PRIVATE')); assert.ok(!JSON.stringify(packets).includes('checked-facade-result'));
  assert.ok(packets.some(p => p.outcome?.failure)); assert.equal(access.snapshot().pending, false);
});
test('fake runtime/cause, JSON reload, aggregate and earlier primary do not acquire rejection', async t => {
  const f = await refusalFixture(t), actual = await captureRefusal(f.bridge), dto = info(actual), fakeDTO = JSON.parse(JSON.stringify(dto));
  const candidates = [
    Object.assign(new Error('PRIVATE'), { code: 'RESEARCH_RUNTIME_REJECTED', requestId: actual.requestId, operation: actual.operation, coreError: actual.coreError }),
    Object.assign(new Error('PRIVATE'), { code: 'RESEARCH_RUNTIME_REJECTED', runtime: fakeDTO }),
    Object.assign(new Error('PRIVATE'), { code: 'RESEARCH_RUNTIME_FAILED', cause: actual }),
    Object.assign(new Error('PRIVATE'), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED', errors: [{ primary: actual }] }),
    Object.assign(new Error('PRIVATE'), { code: 'PROJECT_CORE_PERSISTENCE_FAILED', runtime: dto, cause: actual }),
    Object.assign(new Error('PRIVATE'), { code: 'RESEARCH_RUNTIME_TIMEOUT', runtime: dto, cause: actual }),
    Object.assign(new Error('PRIVATE'), { code: 'APP_CAPABILITY_DENIED', runtime: dto }),
  ];
  let current; const call = await toolsFor(t, f, async () => { throw current; });
  for (const e of candidates) {
    current = e; const projected = info(e); assert.equal(rejection(projected), null);
    for (const child of projected.requests) assert.equal(rejection(child.primary), null);
    const result = await call(); assert.equal(result.isError, true); assert.equal(result.details.error.rejection, undefined);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});
test('late checked-envelope availability cannot override an earlier Runtime timeout', async t => {
  let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const f = await refusalFixture(t, { get: async value => { entered(); await gate; return value; }, release });
  const bridge = f.create({ timeoutMs: 20, cleanupTimeoutMs: 20 });
  // Expire only after get is entered, never during OS fixture startup.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = bridge.call(fixtureBinding, 'fact_list_page').catch(e => e); await started;
    t.mock.timers.tick(20); release();
    const error = await pending; assert.equal(error.code, 'RESEARCH_RUNTIME_TIMEOUT'); assert.equal(rejection(info(error)), null);
    await bridge.dispose(); assert.equal(error.code, 'RESEARCH_RUNTIME_TIMEOUT'); assert.equal(rejection(info(error)), null);
  } finally { release(); t.mock.timers.reset(); }
});
test('unknown cleanup stays visible beside checked rejection; aggregate disposal never promotes it', async t => {
  const f = await refusalFixture(t), open = fs.open;
  fs.open = async (...args) => { if (String(args[0]).endsWith('/.complete')) throw Object.assign(new Error('PRIVATE marker'), { code: 'EACCES' }); return open(...args); };
  syncBuiltinESMExports();
  try {
    const error = await captureRefusal(f.bridge); assert.equal(error.cleanup.confirmed, false);
    const frozen = info(error); assert.ok(rejection(frozen));
    let aggregate; try { await f.bridge.dispose(); } catch (e) { aggregate = e; }
    assert.equal(aggregate.code, 'RESEARCH_RUNTIME_CLEANUP_FAILED'); assert.equal(rejection(info(aggregate)), null);
    error.runtime = frozen; error.resultCleanup = { confirmed: false, error: info(aggregate) };
    const call = await toolsFor(t, f, async () => { throw error; }), reply = await call();
    assert.equal(reply.details.error.rejection.reason, 'response-bytes'); assert.equal(reply.details.error.runtime.cleanup.confirmed, false);
    assert.equal(reply.details.error.resultCleanup.confirmed, false); assert.ok(!JSON.stringify(reply).includes('PRIVATE'));
  } finally { fs.open = open; syncBuiltinESMExports(); }
});
test('indeterminate checked rejection qualifies the capacity message; definite one does not', async t => {
  for (const indeterminate of [true, false]) {
    const error = { code: 'size_limit', message: 'PRIVATE', ...(indeterminate ? { mutationState: 'indeterminate' } : {}) };
    const f = await refusalFixture(t, { error, diagnostic: refusalDiagnostic('shared-fact-bytes') });
    const cause = await captureRefusal(f.bridge); assert.equal(cause.indeterminate, indeterminate);
    const reply = await (await toolsFor(t, f, async () => { throw cause; }))();
    assert.equal(reply.details.error.rejection.suggestedAction, 'report-capacity');
    assert.equal(reply.details.error.runtime.indeterminate, indeterminate);
    assert.equal(/may already have taken effect/.test(reply.details.error.message), indeterminate);
    assert.ok(!JSON.stringify(reply).includes('PRIVATE'));
    await f.bridge.dispose();
  }
});
