// Read-only software Host/store fixtures; no actual App/session/Goal or mathematics.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { auditVerificationReads, verificationReadBudget } from '../packages/hana-math/verification-read-audit.mjs';
import { sha256 } from '../packages/hana-math/verification-read-evidence.mjs';
const ids = { projectId: 'project-fixture', runId: 'run-fixture', workerId: 'worker-1', submissionId: 'submission-fixture' };
const root = '/fixture/private-app', fid = 'a'.repeat(16), raw = 'opaque canonical Markdown\n';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(setImmediate);
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await turn(); } assert.fail('Fixture did not reach expected boundary'); }
function fixture() {
  const absolute = relative => path.posix.join(root, relative);
  const candidateFile = `research/runs/${ids.runId}/submissions/${ids.submissionId}/candidate.json`;
  const cwd = absolute(`context/projects/${ids.projectId}/research/${ids.runId}/verifiers/${ids.submissionId}`), workerCwd = absolute(`context/projects/${ids.projectId}/workers/${ids.workerId}`);
  const selection = role => ({ role, source: 'saved-role', agentId: 'saved-' + role, model: { id: 'opaque', provider: 'fixture' } });
  const binding = (role, cwd) => ({ projectId: ids.projectId, runId: ids.runId, role, agentId: 'saved-' + role, author: 'saved-' + role,
    cwd, sessionId: role + '-sid', sessionPath: '/private-host/' + role + '.jsonl', active: true, ...(role === 'worker' ? { workerId: ids.workerId } : { submissionId: ids.submissionId }) });
  const worker = { role: 'worker', agentId: 'saved-worker', cwd: workerCwd, sessionId: 'worker-sid', sessionPath: '/private-host/worker.jsonl', binding: binding('worker', workerCwd) };
  const verifier = { role: 'verifier', agentId: 'saved-verifier', cwd, sessionId: 'verifier-sid', sessionPath: '/private-host/verifier.jsonl', binding: binding('verifier', cwd),
    submissionId: ids.submissionId, kind: 'math-research:run-fixture:1', state: 'completed', active: false, cleanupPending: false, finalizing: false, setupPending: false, sendPending: false, sendState: 'accepted', modelStopReason: 'stop', error: null };
  const meta = { ...ids, schemaVersion: 1, mode: 'project-worker', selections: { worker: selection('worker'), verifier: selection('verifier') },
    sessions: [worker, verifier], submissions: [{ submissionId: ids.submissionId, candidateFile, workerSessionId: worker.sessionId, state: 'rejected' }] };
  const candidate = { binding: { projectId: ids.projectId, runId: ids.runId, workerId: ids.workerId, role: 'worker', author: 'saved-worker' },
    arguments: { statement: 'SECRET candidate statement', proof: 'SECRET proof body', predecessors: [fid] },
    prepared: { candidateDigest: 'b'.repeat(64), predecessorDigests: { [fid]: sha256(raw) }, precheck: { passed: true } } };
  const host = { sessionId: verifier.sessionId, path: verifier.sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', agentId: verifier.agentId, cwd, kind: verifier.kind, lifecycle: 'active' };
  const canonical = absolute(`context/projects/${ids.projectId}/shared/fact_graph/facts/${fid}.md`);
  const response = { sessionId: host.sessionId, leafId: 'b', entries: [
    { id: 'a', parentId: null, type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: canonical } }] } },
    { id: 'b', parentId: 'a', type: 'message', message: { role: 'toolResult', toolCallId: 'read-call', toolName: 'read', isError: false, content: [{ type: 'text', text: raw }], details: { truncation: { truncated: false } } } },
  ] };
  const calls = [], hooks = {}; let authorized = true;
  const sdk = { sessions: {
    async get(ref) { calls.push(['get', ref]); assert.deepEqual(ref, { sessionId: 'verifier-sid' }); if (hooks.get) await hooks.get(); return { session: structuredClone(host) }; },
    async list(options) { calls.push(['list', options]); assert.equal(options.scope, 'own'); assert.equal(options.ownerPluginId, 'hana-math'); if (hooks.list) await hooks.list(); const row = structuredClone(host); delete row.namespace; return { sessions: [row] }; },
    async entries(ref) { calls.push(['entries', ref]); assert.deepEqual(ref, { sessionId: 'verifier-sid', scope: 'own' }); if (hooks.entries) await hooks.entries(); return response; },
    send() { assert.fail('No send'); }, abort() { assert.fail('No abort'); }, create() { assert.fail('No create'); },
  }, tools: { invoke() { assert.fail('No tool invoke'); } }, runtime: { execute() { assert.fail('No runtime'); } } };
  const store = { absolute, async read(file) { calls.push(['read', file]); assert.equal(file, candidateFile, 'No worker memory, session file or current graph reads'); if (hooks.read) await hooks.read(); return Buffer.from(JSON.stringify(candidate)); },
    write() { assert.fail('No write'); }, readJson() { assert.fail('Only bounded candidate bytes'); }, list() { assert.fail('No storage scans'); }, mkdir() { assert.fail('No mkdir'); } };
  const recheck = async () => { calls.push(['recheck']); if (hooks.recheck) await hooks.recheck(); if (!authorized) throw Object.assign(new Error('SECRET authority detail'), { code: 'PROJECT_OWNER_DENIED' }); };
  return { meta, verifier, worker, candidate, host, response, sdk, store, calls, hooks, deny() { authorized = false; },
    run: () => auditVerificationReads(sdk, { identity: ids, getMeta: () => meta, store, recheck }) };
}
function privateFree(value) { assert.doesNotMatch(JSON.stringify(value), /SECRET|private-host|private-app|candidate statement|proof body|canonical Markdown/); }
test('a clean rejected verifier is enough; no acceptance gate, persistence, Core or worker-history reads', async () => {
  const f = fixture(), before = JSON.stringify({ meta: f.meta, candidate: f.candidate, host: f.host });
  const dto = await f.run(); privateFree(dto);
  assert.equal(dto.coverage, 'complete'); assert.equal(dto.verifierSessionId, 'verifier-sid'); assert.equal(dto.predecessors[0].exactMatchCount, 1);
  assert.equal(dto.verdictTiming, 'not-established'); assert.equal(dto.currentGraphValidity, 'not-queried'); assert.equal(dto.hostMaterializationBounded, false);
  assert.equal(f.calls.filter(c => c[0] === 'entries').length, 1); assert.equal(f.calls.filter(c => c[0] === 'get').length, 2);
  assert.equal(f.calls.filter(c => c[0] === 'list').length, 2); assert.equal(JSON.stringify({ meta: f.meta, candidate: f.candidate, host: f.host }), before);
});
for (const change of [
  f => { f.meta.projectId = 'foreign'; }, f => { f.meta.runId = 'foreign'; }, f => { f.meta.workerId = 'foreign'; }, f => { f.meta.mode = 'legacy'; },
  f => { f.meta.submissions[0].candidateFile = 'private/worker-memory.json'; }, f => { f.meta.submissions.push({ ...f.meta.submissions[0] }); }, f => { f.meta.submissions[0].submissionId = 'other'; },
  f => { f.meta.sessions.push(structuredClone(f.verifier)); }, f => { f.verifier.binding = undefined; }, f => { f.meta.selections.verifier.agentId = 'other'; },
  f => { f.worker.binding.workerId = 'other'; }, f => { f.meta.submissions[0].workerSessionId = f.verifier.sessionId; },
]) test('invalid/cross-project/legacy linkage refuses before candidate or Host entries', async () => {
  const f = fixture(); change(f); const dto = await f.run(); assert.equal(dto.coverage, 'unavailable'); privateFree(dto);
  assert.equal(f.calls.some(c => c[0] === 'entries' || c[0] === 'read'), false);
});
for (const patch of [{ state: 'running' }, { active: true }, { cleanupPending: true }, { finalizing: true }, { setupPending: true }, { sendPending: true }, { modelStopReason: 'length' }, { sendState: 'unconfirmed' }, { error: 'opaque' }, { updateFailed: true }]) test('unclean verifier unavailable ' + JSON.stringify(patch), async () => {
  const f = fixture(); Object.assign(f.verifier, patch); const dto = await f.run(); assert.equal(dto.coverage, 'unavailable'); assert.ok(dto.reasons.includes('VERIFIER_NOT_CLEAN_COMPLETED')); assert.equal(f.calls.some(c => c[0] === 'entries'), false);
});
for (const change of [f => { f.candidate.binding.author = 'foreign'; }, f => { f.candidate.binding.workerId = 'foreign'; }, f => { f.candidate.prepared.predecessorDigests = {}; }, f => { f.candidate.prepared.predecessorDigests.extra = 'bad'; }]) test('poisoned candidate binding/digest keys do not select a Host session', async () => {
  const f = fixture(); change(f); const dto = await f.run(); assert.equal(dto.coverage, 'unavailable'); assert.equal(f.calls.some(c => c[0] === 'entries' || c[0] === 'get'), false); privateFree(dto);
});
for (const phase of ['before', 'after']) for (const [key, value] of [['sessionId', 'foreign'], ['ownerPluginId', 'foreign'], ['namespace', 'home'], ['visibility', 'public'], ['agentId', 'foreign'], ['cwd', '/SECRET'], ['kind', 'foreign']]) test(`Host ${key} mismatch ${phase} entries is unavailable`, async () => {
  const f = fixture(); if (phase === 'before') f.host[key] = value; else f.hooks.entries = () => { f.host[key] = value; };
  const dto = await f.run(); assert.equal(dto.coverage, 'unavailable'); assert.equal(dto.verifierSessionId, null); privateFree(dto);
  assert.equal(f.calls.filter(c => c[0] === 'entries').length, phase === 'before' ? 0 : 1);
});
test('entries response must name the exact independently confirmed SID', async () => {
  const f = fixture(); f.response.sessionId = 'foreign'; const dto = await f.run(); assert.deepEqual(dto.reasons, ['ENTRIES_SESSION_MISMATCH']); assert.equal(dto.predecessors.length, 0); privateFree(dto);
});
for (const boundary of ['read', 'get', 'list', 'entries']) test('record linkage changed during ' + boundary + ' cannot disclose old evidence', async () => {
  const f = fixture(); f.hooks[boundary] = () => { f.verifier.binding.author = 'other'; };
  const dto = await f.run(); assert.equal(dto.coverage, 'unavailable'); assert.equal(dto.predecessors.length, 0); privateFree(dto);
});
test('candidate changes after entries discard observed matches without current graph reads', async () => {
  const f = fixture(); f.hooks.entries = () => { f.candidate.arguments.proof += 'changed'; };
  const dto = await f.run(); assert.deepEqual(dto.reasons, ['CANDIDATE_CHANGED']); assert.equal(dto.predecessors.length, 0); privateFree(dto);
});
for (const boundary of ['get', 'entries']) test('authorization loss during ' + boundary + ' remains an error, never a successful DTO', async () => {
  const f = fixture(); f.hooks[boundary] = () => f.deny(); await assert.rejects(f.run(), error => { privateFree(error); return error.code === 'PROJECT_OWNER_DENIED'; });
});
test('API errors do not mask later permission denial or leak raw details', async () => {
  const f = fixture(); f.hooks.entries = () => { f.deny(); throw new Error('SECRET raw SDK failure'); };
  await assert.rejects(f.run(), { code: 'PROJECT_OWNER_DENIED' });
  const g = fixture(); g.hooks.entries = () => { throw Object.assign(new Error('SECRET permission'), { code: 'APP_CAPABILITY_DENIED', kind: 'permission' }); };
  await assert.rejects(g.run(), error => { privateFree(error); assert.equal(error.message, 'APP_CAPABILITY_DENIED'); return error.code === 'APP_CAPABILITY_DENIED'; });
});
test('missing entries API and ordinary API failure are bounded unavailable evidence', async () => {
  const f = fixture(); delete f.sdk.sessions.entries; const dto = await f.run(); assert.deepEqual(dto.reasons, ['ENTRIES_UNSUPPORTED']); privateFree(dto);
  const g = fixture(); g.hooks.entries = () => { throw new Error('SECRET private provider failure'); }; const failed = await g.run(); assert.deepEqual(failed.reasons, ['HOST_OR_RECORD_UNAVAILABLE']); privateFree(failed);
});
for (const boundary of ['read', 'entries']) for (const variant of ['huge-properties', 'fake-timeout', 'accessors', 'primitive']) test(`untrusted ${boundary} error ${variant} cannot supply coverage/reasons or private output`, async () => {
  const f = fixture(); let error = new Error('SECRET raw failure');
  if (variant === 'huge-properties') { error.evidenceReason = 'SECRET'.repeat(100000); error.coverage = { toJSON() { assert.fail('error coverage serializer'); } }; }
  if (variant === 'fake-timeout') { error.evidenceReason = 'READ_TIMEOUT'; error.coverage = 'complete'; }
  if (variant === 'accessors') for (const key of ['evidenceReason', 'coverage']) Object.defineProperty(error, key, { get() { assert.fail('error getter ' + key); } });
  if (variant === 'primitive') error = 'SECRET primitive';
  f.hooks[boundary] = () => { throw error; };
  const dto = await f.run(); assert.equal(dto.coverage, 'unavailable'); assert.deepEqual(dto.reasons, ['HOST_OR_RECORD_UNAVAILABLE']);
  assert.equal(dto.verifierSessionId, null); assert.deepEqual(dto.predecessors, []); privateFree(dto);
  assert.ok(Buffer.byteLength(JSON.stringify(dto)) < 256 * 1024);
  assert.ok(f.calls.filter(c => c[0] === 'recheck').length >= 2, 'Forged timeout cannot skip the final permission recheck');
});
test('forged timeout properties cannot disguise a project authorization rejection', async () => {
  const f = fixture(); f.hooks.recheck = () => { throw Object.assign(new Error('SECRET'), { code: 'PROJECT_OWNER_DENIED', evidenceReason: 'READ_TIMEOUT', coverage: 'complete' }); };
  await assert.rejects(f.run(), error => { privateFree(error); return error.code === 'PROJECT_OWNER_DENIED'; });
  assert.equal(f.calls.some(c => c[0] === 'entries'), false);
});
test('missing optional native truncation details still gives complete branch coverage and exact recorded bytes', async () => {
  const f = fixture(); delete f.response.entries[1].message.details;
  const dto = await f.run(); assert.equal(dto.coverage, 'complete'); assert.deepEqual(dto.reasons, []);
  assert.equal(dto.predecessors[0].exactMatchCount, 1); assert.deepEqual(dto.predecessors[0].firstExactMatch.truncation, { known: false }); privateFree(dto);
});
test('no predecessors never requests entries, even if the API is absent', async () => {
  const f = fixture(); f.candidate.arguments.predecessors = null; f.candidate.prepared.predecessorDigests = {}; delete f.sdk.sessions.entries;
  const dto = await f.run(); assert.equal(dto.coverage, 'not-needed'); assert.equal(dto.verifierSessionId, 'verifier-sid'); assert.deepEqual(dto.predecessors, []); assert.equal(f.calls.some(c => c[0] === 'entries'), false);
});
for (const jump of [-86400000, 86400000]) test(`wall-clock jump ${jump} cannot extend or shorten the audit monotonic budget`, async t => {
  let wall = 200000000, elapsed = 0; const delays = [], original = setTimeout;
  t.mock.method(Date, 'now', () => wall); t.mock.method(performance, 'now', () => elapsed);
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => { delays.push(delay); return original(callback, delay, ...args); });
  const budget = verificationReadBudget(); assert.equal(await budget.step(() => 'first'), 'first');
  wall += jump; elapsed = 4000; assert.doesNotThrow(budget.guard);
  assert.equal(await budget.step(() => 'second'), 'second'); assert.deepEqual(delays, [10000, 6000]);
  wall -= jump; elapsed = 10000; assert.throws(budget.guard, { evidenceReason: 'READ_TIMEOUT' });
  let invoked = false; await assert.rejects(budget.step(() => { invoked = true; }), { evidenceReason: 'READ_TIMEOUT' }); assert.equal(invoked, false);
});
test('sequential steps consume one remaining monotonic budget, including completion guards', async t => {
  let elapsed = 1000; const delays = [], original = setTimeout;
  t.mock.method(performance, 'now', () => elapsed); t.mock.method(Date, 'now', () => 100);
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => { delays.push(delay); return original(callback, delay, ...args); });
  const budget = verificationReadBudget(); await budget.step(() => 'first');
  elapsed = 6000; await budget.step(() => 'second'); elapsed = 10999;
  await assert.rejects(budget.step(() => { elapsed = 11000; return 'late'; }), { evidenceReason: 'READ_TIMEOUT' });
  assert.deepEqual(delays, [10000, 5000, 1]);
  elapsed = 1000; assert.throws(budget.guard, { evidenceReason: 'READ_TIMEOUT' }, 'Expiry stays latched even under a clock fixture reset');
});

for (const boundary of ['get', 'entries']) test('ten-second timeout prevents late ' + boundary + ' continuation from starting further operations or disclosing', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const f = fixture(), gate = deferred(); let entered = false;
  f.hooks[boundary] = async () => { entered = true; await gate.promise; };
  const work = f.run(); await until(() => entered); t.mock.timers.tick(10000);
  const dto = await work; assert.deepEqual(dto.reasons, ['READ_TIMEOUT']); assert.equal(dto.verifierSessionId, null); assert.deepEqual(dto.predecessors, []);
  const count = f.calls.length, before = JSON.stringify(dto); gate.resolve(); await turn(); await turn();
  assert.equal(f.calls.length, count); assert.equal(JSON.stringify(dto), before); privateFree(dto);
});
