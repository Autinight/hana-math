import test from 'node:test';
import { fixtureFactPage } from './fact-page-fixture.mjs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { AppSdkError } from '../packages/hana-math/sdk/app-contract/sdk-error.js';

const FID = '0123456789abcdef', PRED = 'fedcba9876543210';
const RUN = 'run-fixture', PROJECT = 'project-fixture';
const TEXT = 256 * 1024, TOTAL = 1024 * 1024;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const context = { sessionPath: '/fixture/origin-a.jsonl', messageId: null, messageText: null, callToken: 'host-token-fixture-a' };
const other = { ...context, sessionPath: '/fixture/origin-b.jsonl', callToken: 'host-token-fixture-b' };
const names = ['math_research', 'gm_add', 'gm_search', 'fact_submit', 'fact_search', 'fact_revoke', 'search_arxiv_theorems', 'math_assign', 'math_local_memory', 'math_verification_report'];
const correct = { verification_report: { summary: 'Software fixture report', critical_errors: [], gaps: [] }, verdict: 'correct', repair_hints: '' };
const valid = {
  math_research: { action: 'run', problem: 'Software fixture only; no mathematics.' },
  gm_add: { kind: 'plan', claim: 'Fixture claim' }, gm_search: { query: '' }, fact_submit: { statement: 'Fixture statement', proof: 'Fixture proof only' },
  fact_search: { query: '' }, fact_revoke: { fact_id: FID, reason: 'Fixture reason' }, search_arxiv_theorems: { query: 'Software fixture only' },
  math_assign: { task: 'Fixture assignment' }, math_local_memory: { action: 'read' }, math_verification_report: correct,
};
const request = { action: 'result', runId: RUN, factId: FID };
const markdown = (body = 'Fixture proof only.\r\nOriginal bytes remain unchanged.\n') => `---\nfact_id: ${FID}\nproblem_id: ${PROJECT}\nauthor: fixture-author\npredecessors: [${PRED}]\n---\n\n## statement\nFixture statement only.\n\n## proof\n${body}`;
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
const turn = () => new Promise(setImmediate);
async function until(predicate) { for (let n = 0; n < 5000; n++) { if (predicate()) return; await turn(); } assert.fail('Fixture did not settle'); }
async function fixture(t, { nativeProjects = false } = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-research-tools-')));
  const tools = new Map(), removed = [], calls = [], stages = [], host = new AsyncLocalStorage();
  // Business calls remain separate from the code-only rejection metadata hook.
  const rejectionCalls = [], rejectionRecords = [];
  const controls = { replies: {}, stageError: null, stageReceipt: null, stageGate: null,
    rejectionAuthorized: false, rejectionError: null, rejectionGate: null };
  let registration;
  t.after(async () => { await registration?.dispose(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const value = { runId: RUN, projectId: PROJECT, fact: { fact_id: FID, markdown: markdown(), predecessors: [PRED] }, metadata: { state: 'finished', wholeProblemVerified: false } };
  function record(method, args, ctx, fallback) {
    calls.push({ method, args: structuredClone(args), context: ctx });
    if (controls.serviceError) throw controls.serviceError;
    return Object.hasOwn(controls.replies, method) ? structuredClone(controls.replies[method]) : structuredClone(fallback);
  }
  const service = {
    async recordSubmissionInputRejection(...args) {
      assert.equal(args.length, 2); const [ctx, code] = args;
      assert.match(code, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
      rejectionCalls.push({ context: ctx, code });
      if (controls.rejectionGate) await controls.rejectionGate;
      if (controls.rejectionError) throw controls.rejectionError;
      if (!controls.rejectionAuthorized) return false;
      rejectionRecords.push({ code }); return true;
    },
    async run(input, ctx) { return record('run', input, ctx, { runId: RUN, projectId: null, state: 'queued', pending: true }); },
    async setupStatus(runId, ctx) { return record('setupStatus', { runId }, ctx, { runId, roles: [], capabilities: [] }); },
    async setToolMode(runId, role, toolMode, ctx) { return record('setToolMode', { runId, role, toolMode }, ctx, { runId, saved: true }); },
    async status(runId, ctx) { return record('status', { runId }, ctx, { runId, state: 'running' }); },
    async result(runId, factId, ctx, options = {}) { return record('result', { runId, factId, ...(Object.keys(options).length ? { options } : {}) }, ctx, factId ? value : { runId, projectId: PROJECT, ...fixtureFactPage([{ fact_id: FID, predecessors: [PRED] }], options, PROJECT) }); },
    async stop(runId, ctx) { return record('stop', { runId }, ctx, { runId, state: 'stopped', abortOutcome: 'aborted' }); },
    async invoke(name, input, ctx) { return record(name, input, ctx, name === 'fact_submit' ? { pending: true, accepted: false, submissionId: 'submission-fixture' } : { applied: true }); },
  };
  // Routing fixtures only: these stubs do not prove ProjectService authorization.
  const projectValue = { projectId: PROJECT, fact: value.fact };
  const projects = {
    async handles(ctx) {
      calls.push({ method: 'project.handles', args: {}, context: ctx });
      if (controls.routeError) throw controls.routeError;
      if (controls.routeGate) await controls.routeGate;
      return Object.hasOwn(controls, 'handled') ? controls.handled : true;
    },
    async create(input, ctx) { return record('project.create', input, ctx, { projectId: PROJECT, state: 'ready' }); },
    async list(ctx) { return record('project.list', {}, ctx, { projects: [] }); },
    async status(projectId, ctx) { return record('project.status', { projectId }, ctx, { projectId, state: 'ready' }); },
    async assign(input, ctx) { return record('project.assign', input, ctx, { projectId: PROJECT, assigned: true }); },
    async start(input, ctx) { return record('project.start', input, ctx, { projectId: PROJECT, state: 'running' }); },
    async stop(input, ctx) { return record('project.stop', input, ctx, { projectId: PROJECT, state: 'stopped' }); },
    async recheck(input, ctx) { return record('project.recheck', input, ctx, { ...input, state: 'unknown', code: 'RECHECK_NOT_NEEDED' }); },
    async result(input, ctx) { return record('project.result', input, ctx, input.factId ? projectValue : { projectId: PROJECT, ...fixtureFactPage([{ fact_id: FID, predecessors: [PRED] }], Object.fromEntries(['cursor', 'limit'].filter(k => Object.hasOwn(input, k)).map(k => [k, input[k]])), PROJECT) }); },
    async graph(input, ctx) { return record('project.graph', input, ctx, { projectId: PROJECT, capturedAt: 123456,
      asOf: fixtureFactPage([], {}, PROJECT).page.asOf, facts: fixtureFactPage([{ fact_id: FID, predecessors: [PRED] }], {}, PROJECT).facts }); },
    async summary(input, ctx) { return record('project.summary', input, ctx, { projectId: PROJECT, language: input.language ?? 'English', state: 'queued', reportId: 'report-01234567-89ab-cdef-0123-456789abcdef', taskId: 'task-fixture' }); },
    async summaryStatus(input, ctx) { return record('project.summary_status', input, ctx, { projectId: PROJECT, reportId: input.reportId, state: 'queued' }); },
    async summaryResult(input, ctx) { return record('project.summary_result', input, ctx, { saved: true, state: 'completed', report: '# Fixture' }); },
    async summaryStop(input, ctx) { return record('project.summary_stop', input, ctx, { reportId: input.reportId, state: 'stopped' }); },
    async verificationReads(input, ctx) { return record('project.verification_reads', input, ctx, { schemaVersion: 1, action: 'verification_reads', kind: 'verification_reads', ...input,
      source: 'host-session-entries', coverage: 'unavailable', coverageScope: 'returned-active-branch', verifierSessionId: null, predecessors: [], reasons: ['ENTRIES_UNSUPPORTED'], verdictTiming: 'not-established', currentGraphValidity: 'not-queried', hostMaterializationBounded: false }); },
    async invoke(name, input, ctx) { return record(`project.${name}`, input, ctx, { applied: true }); },
    async goal(action, input, ctx) { return record(`goal.${action}`, input, ctx, { projectId: PROJECT, managed: true, state: 'active' }); },
    async mainGoal(action, input, ctx) { return record(`mainGoal.${action}`, input, ctx, { projectId: PROJECT, managed: true, state: 'active' }); },
  };
  const sdk = { dataDir,
    tools: { async register(tool) { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); return () => { removed.push(tool.name); }; } },
    resources: { async stage(input) {
      const ctx = host.getStore(); assert.ok(ctx?.callToken); assert.equal(Object.hasOwn(input, 'callToken'), false);
      assert.deepEqual(Object.keys(input).sort(), ['deliverAs', 'mime', 'name', 'path']);
      const bytes = await fs.readFile(input.path); const index = stages.length + 1;
      stages.push({ input, bytes, context: ctx });
      if (controls.stageGate) await controls.stageGate;
      if (controls.stageError) throw controls.stageError;
      return controls.stageReceipt ?? { file: { id: `file-${index}`, size: bytes.length, sha256: sha(bytes) }, mediaItem: null,
        resource: { kind: 'session-file', fileId: `file-${index}`, sessionId: ctx.sessionPath === context.sessionPath ? 'session-a' : 'session-b' } };
    } },
  };
  registration = await registerMathResearch(sdk, service, nativeProjects ? projects : undefined);
  const execute = (name, input, ctx = context) => host.run(ctx, () => tools.get(name).execute({ ...input, context: ctx }));
  return { sdk, service, projects, projectValue, registration, tools, removed, calls, stages, controls, dataDir, value, execute, rejectionCalls, rejectionRecords };
}
function resultText(reply) { assert.deepEqual(reply.content.map((part) => part.type), ['text']); return JSON.parse(reply.content[0].text); }

test('native graph exports an offline HTML index using real invocation context and never asks for proofs', async t => {
  const f = await fixture(t, { nativeProjects: true });
  const result = await f.execute('math_project', { action: 'graph', projectId: PROJECT });
  assert.equal(result.isError, false, JSON.stringify(result.details));
  assert.equal(result.details.previewOnly, true); assert.equal(result.details.facts, 1); assert.equal(result.details.edges, 1);
  assert.equal(result.details.fileId, 'file-1'); assert.equal(f.stages.length, 1);
  assert.equal(f.stages[0].input.mime, 'text/html'); assert.equal(f.stages[0].context, context);
  assert.equal(f.calls.at(-1).method, 'project.graph'); assert.equal(f.calls.at(-1).context, context);
  assert.equal(f.calls.some(c => c.method === 'result' || c.method === 'project.result'), false);
  assert.match(f.stages[0].bytes.toString(), /<!doctype html>/i);
  const calls = f.calls.length;
  for (const extra of [{ factId: FID }, { cursor: 'opaque' }, { limit: 1 }, { workerId: 'worker-1' }, { callToken: 'spoof' }]) {
    assert.equal((await f.execute('math_project', { action: 'graph', projectId: PROJECT, ...extra })).isError, true);
  }
  assert.equal(f.calls.length, calls);
});
test('graph permission denial or unknown attachment receipt remains failure with no mutation fallback', async t => {
  const f = await fixture(t, { nativeProjects: true });
  f.controls.serviceError = Object.assign(new Error('opaque denied'), { code: 'PROJECT_OWNER_DENIED' });
  const denied = await f.execute('math_project', { action: 'graph', projectId: PROJECT });
  assert.equal(denied.isError, true); assert.equal(denied.details.error.code, 'PROJECT_OWNER_DENIED'); assert.equal(f.stages.length, 0);
  f.controls.serviceError = null; f.controls.stageReceipt = { ok: true };
  const unknown = await f.execute('math_project', { action: 'graph', projectId: PROJECT });
  assert.equal(unknown.isError, true); assert.equal(unknown.details.error.code, 'PROJECT_GRAPH_STAGE_UNCONFIRMED');
  assert.equal(Object.hasOwn(unknown.details, 'fileId'), false);
});

// All registrations, identities, SDK calls and source facts below are fixtures.
test('registers exactly ten formal tools with strict schemas and one-argument execution, without visibility-based authorization', async (t) => {
  const f = await fixture(t); assert.deepEqual([...f.tools.keys()], names);
  for (const tool of f.tools.values()) {
    assert.equal(tool.execute.length, 1); assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(Object.hasOwn(tool.parameters.properties, 'context'), false); assert.equal(Object.hasOwn(tool, 'isEnabledForAgentConfig'), false);
  }
  assert.equal(f.tools.get('gm_add').parameters.properties.kind.enum.length, 11);
  for (const tool of f.tools.values()) assert.doesNotMatch(JSON.stringify({ description: tool.description, parameters: tool.parameters }), /\p{Script=Han}/u);
  const description = f.tools.get('math_research').description;
  for (const word of ['user authorization', '900', '3 worker', 'saved roles', 'without restarting', 'pending/finished']) assert.ok(description.includes(word));
  const memory = f.tools.get('math_local_memory').description;
  assert.match(memory, /persists across runs/); assert.match(memory, /legacy research memory is private to one run/);
  assert.doesNotMatch(memory, /for this run/);
  const submission = f.tools.get('fact_submit');
  assert.match(submission.description, /only way to write a fact/);
  assert.match(submission.description, /Cite the returned `?fact_id`?/);
  assert.match(submission.description, /global memory/);
  assert.match(submission.description, /After `pending`, end this turn and wait for verifier feedback/);
  assert.match(submission.parameters.properties.source_id.description, /not an arXiv ID/);
  assert.match(submission.parameters.properties.external_refs.description, /Illustrative entry only/);
  assert.match(submission.parameters.properties.external_refs.description, /metadata is not supplied to the verifier/);
  assert.match(submission.parameters.properties.proof.description, /precise theorem, hypotheses and source locator/);
  assert.match(f.tools.get('search_arxiv_theorems').description, /Semantic search over arXiv/);
  await f.registration.dispose(); await f.registration.dispose(); assert.deepEqual(f.removed, names);
  assert.equal((await f.execute('fact_search', valid.fact_search)).isError, true);
});

for (const name of ['math_research', 'math_project']) test(`${name} pagination schema, forwarding, DTO checks and full-get separation`, async t => {
  const f = await fixture(t, { nativeProjects: true }), native = name === 'math_project';
  const query = { action: 'result', [native ? 'projectId' : 'runId']: native ? PROJECT : RUN };
  const schema = f.tools.get(name).parameters;
  const variants = schema.oneOf.filter(v => v.properties.action.const === 'result'); assert.equal(variants.length, 2);
  assert.ok(variants.some(v => v.properties.cursor && !v.properties.factId));
  assert.ok(variants.some(v => v.required.includes('factId') && !v.properties.cursor && !v.properties.limit));
  assert.equal(schema.properties.limit.maximum, 64); assert.equal(schema.properties.cursor.maxLength, 1024);
  assert.match(f.tools.get(name).description, /never mix different asOf|never mix observations/); assert.match(f.tools.get(name).description, /preview(?:-only)? pages/);
  const result = await f.execute(name, { ...query, limit: 1 }); assert.equal(result.isError, false, JSON.stringify(result.details));
  assert.equal(result.details.page.limit, 1); assert.equal(result.details.page.allFactsIncluded, true);
  assert.equal(f.calls.at(-1).context, context);
  assert.deepEqual(native ? f.calls.at(-1).args : f.calls.at(-1).args.options, native ? { projectId: PROJECT, limit: 1 } : { limit: 1 });
  const before = f.calls.length;
  for (const patch of [{ factId: FID, limit: 1 }, { factId: FID, cursor: 'bad' }, { limit: 0 }, { limit: 65 }, { cursor: null }])
    assert.equal((await f.execute(name, { ...query, ...patch })).isError, true);
  assert.equal(f.calls.length, before);
  const key = native ? 'project.result' : 'result';
  const valid = { ...(native ? {} : { runId: RUN }), projectId: PROJECT, ...fixtureFactPage([{ fact_id: FID, predecessors: [PRED] }], {}, PROJECT) };
  for (const alter of [v => delete v.page, v => v.page.returned++, v => { v.page.allFactsIncluded = false; }, v => { v.facts[0].markdown = 'PRIVATE'; }]) {
    const value = structuredClone(valid); alter(value); f.controls.replies[key] = value;
    const reply = await f.execute(name, query); assert.equal(reply.isError, true); assert.equal(reply.details.error.code, 'FACT_RESULT_INVALID'); assert.ok(!JSON.stringify(reply).includes('PRIVATE'));
  }
});

for (const name of ['math_research', 'math_project']) test(`${name} rejects noncanonical cursor before any service/Core admission`, async t => {
  const f = await fixture(t, { nativeProjects: true }), native = name === 'math_project';
  const frame = fixtureFactPage([{ fact_id: FID, predecessors: [PRED] }], {}, PROJECT);
  const raw = JSON.stringify({ asOf: frame.page.asOf, limit: 64, offset: 0, projectId: PROJECT, v: 1 });
  const variants = [raw.slice(0, -1) + ',"\\u0076":1}', raw.replace('"v":1', '"\\u0076":1,"v":1'),
    raw.replace('"v":1', '"\\u0076":1'), raw.replace('"projectId"', '"project\\u0049d"'),
    raw.replace('project-fixture', 'project\\u002dfixture'), raw.replace(frame.page.asOf, '\\u' + frame.page.asOf.charCodeAt(0).toString(16).padStart(4, '0') + frame.page.asOf.slice(1)),
    ' ' + raw, raw + '\n', raw.replace(/,/g, ', '),
    JSON.stringify({ v: 1, projectId: PROJECT, offset: 0, limit: 64, asOf: frame.page.asOf }),
    ...[['v', 1, '1e0'], ['v', 1, '1.0'], ['limit', 64, '64e0'], ['limit', 64, '64.0'], ['offset', 0, '0e0'], ['offset', 0, '0.0'], ['offset', 0, '-0']]
      .map(([key, original, value]) => raw.replace(`"${key}":${original}`, `"${key}":${value}`))];
  const query = { action: 'result', [native ? 'projectId' : 'runId']: native ? PROJECT : RUN };
  const before = f.calls.length;
  for (const text of variants) {
    const reply = await f.execute(name, { ...query, cursor: Buffer.from(text).toString('base64url') });
    assert.equal(reply.isError, true, text); assert.equal(reply.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT', text);
    assert.equal(f.calls.length, before, 'invalid cursor must not invoke the service and therefore cannot reach Core');
  }
  const canonical = await f.execute(name, { ...query, cursor: Buffer.from(raw).toString('base64url') });
  assert.equal(canonical.isError, false, JSON.stringify(canonical.details)); assert.equal(f.calls.length, before + 1);
  assert.equal(canonical.details.page.asOf, frame.page.asOf); assert.equal(canonical.details.page.startIndex, 0);
});

test('setup and tool-mode actions have strict schemas and preserve host owner context', async (t) => {
  const f = await fixture(t), schema = f.tools.get('math_research').parameters;
  assert.ok(schema.properties.action.enum.includes('setup_status'));
  const setter = schema.oneOf.find((s) => s.properties.action.const === 'set_tool_mode');
  assert.deepEqual(setter.required.sort(), ['action', 'role', 'runId', 'toolMode']); assert.equal(setter.additionalProperties, false);
  await f.execute('math_research', { action: 'setup_status', runId: RUN });
  await f.execute('math_research', { action: 'set_tool_mode', runId: RUN, role: 'main', toolMode: 'full' });
  assert.deepEqual(f.calls.map((c) => c.method), ['setupStatus', 'setToolMode']); assert.equal(f.calls[1].context, context);
  for (const input of [
    { action: 'setup_status' }, { action: 'setup_status', runId: RUN, role: 'main' },
    ...[null, 'inherit', {}, 'FULL'].map((toolMode) => ({ action: 'set_tool_mode', runId: RUN, role: 'main', toolMode })),
    { action: 'set_tool_mode', runId: RUN, toolMode: 'full' },
    ...['agentId', 'partial', 'sessionPath'].map((key) => ({ action: 'set_tool_mode', runId: RUN, role: 'main', toolMode: 'full', [key]: 'foreign' })),
  ]) assert.equal((await f.execute('math_research', input)).isError, true);
  assert.equal(f.calls.length, 2);
});

test('failed historical status is a successful query but a failed explicit mode save is an error', async (t) => {
  const f = await fixture(t);
  f.controls.replies.status = { runId: RUN, state: 'failed', indeterminate: true, error: { code: 'SESSION_NOT_COMPLETED' } };
  assert.equal((await f.execute('math_research', { action: 'status', runId: RUN })).isError, false);
  f.controls.replies.setToolMode = { runId: RUN, saved: false, error: { code: 'SAVE_NOT_CONFIRMED' } };
  assert.equal((await f.execute('math_research', { action: 'set_tool_mode', runId: RUN, role: 'main', toolMode: 'full' })).isError, true);
  f.controls.replies.setToolMode = { runId: RUN, saved: false };
  assert.equal((await f.execute('math_research', { action: 'set_tool_mode', runId: RUN, role: 'main', toolMode: 'full' })).isError, true);
});

test('runtime catch keeps bounded primary and secondary diagnostics without internal error content', async (t) => {
  const f = await fixture(t);
  const primary = { code: 'RESEARCH_RUNTIME_FAILED', phase: 'watch', runtimeId: 'runtime-fixture', operation: 'fact_list',
    requestId: '12345678-1234-1234-1234-123456789abc', startOutcome: 'acknowledged', processTerminalConfirmed: false,
    cause: { code: 'APP_HOST_ERROR', operation: 'runtime.watch', kind: 'host', capability: 'app/runtime.execute', message: 'PRIVATE_SDK' },
    cleanup: { confirmed: false, errors: Array.from({ length: 40 }, () => ({ code: 'RPC_TIMEOUT', phase: 'cleanup-stop', message: 'PRIVATE_CLEANUP' })) } };
  f.controls.serviceError = Object.assign(new Error('PRIVATE_MESSAGE'), primary, { coreError: 'PRIVATE_CORE', coreResult: 'PRIVATE_RESULT', path: '/PRIVATE_PATH',
    runtime: { code: 'APP_RUNTIME_SANDBOX_UNAVAILABLE', path: 'PRIVATE_INVALID_DTO' },
    errors: Array.from({ length: 60 }, () => ({ primary })),
    resultCleanup: { confirmed: false, error: { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED', runtime: { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED', phase: 'dispose',
      sdk: { code: 'RPC_TIMEOUT', operation: 'runtime.stop', kind: 'timeout', capability: 'app/runtime.execute' }, details: 'PRIVATE_DETAIL' } } } });
  const response = await f.execute('math_research', { action: 'result', runId: RUN });
  assert.equal(response.isError, true); const error = response.details.error;
  assert.equal(error.code, 'RESEARCH_RUNTIME_FAILED'); assert.equal(error.runtime.requestId, primary.requestId);
  assert.equal(error.runtime.sdk.operation, 'runtime.watch'); assert.equal(error.runtime.requests.length, 32);
  assert.equal(error.runtime.cleanup.errors.length, 16); assert.equal(error.resultCleanup.confirmed, false);
  assert.equal(error.resultCleanup.error.runtime.sdk.operation, 'runtime.stop');
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE|coreError|coreResult|details.*PRIVATE/);
  f.controls.serviceError = Object.assign(new Error('PRIVATE_OTHER'), { code: 'OWNER_DENIED', phase: 'start', runtimeId: 'not-runtime', runtime: { code: 'APP_RUNTIME_SANDBOX_UNAVAILABLE' } });
  const other = await f.execute('math_research', { action: 'result', runId: RUN });
  assert.equal(Object.hasOwn(other.details.error, 'runtime'), false);
});

test('forwards every API with original field names, nulls and original text; the host context is not synthesized', async (t) => {
  const f = await fixture(t);
  const originals = {
    gm_add: { kind: 'plan', claim: '  Original\r\nclaim  ', evidence: '', verifiable: null, glossary: null, links: { author: 'reference data', path: 'bibliographic locator', context: { role: 'not authority' }, extra: [null, 3, false] } },
    gm_search: { query: '  original  ', kinds: null, limit_per_kind: 128 },
    fact_submit: { statement: '  Original statement  ', proof: 'Original\r\nproof\n', predecessors: null, glossary_introduces: null, intuition: '', source_id: null,
      external_refs: [{ authors: ['fixture'], year: 2020, custom: { unrecognized: [null, true] }, author: 'bibliography field' }] },
    fact_search: { query: '', limit: 1 }, fact_revoke: valid.fact_revoke,
    search_arxiv_theorems: { query: '  fixture query  ', num_results: 100 }, math_assign: valid.math_assign,
    math_local_memory: { action: 'append', text: '  Original note\r\n' }, math_verification_report: correct,
  };
  for (const [name, input] of Object.entries(originals)) {
    const reply = await f.execute(name, input); assert.equal(reply.isError, false);
    assert.equal(f.calls.at(-1).method, name); assert.deepEqual(f.calls.at(-1).args, input); assert.strictEqual(f.calls.at(-1).context, context);
  }
  const run = { action: 'run', problem: '  Fixture problem  ', operatorProfile: 'Fixture operator', workerTask: 'Fixture task', timeoutSeconds: 60 };
  await f.execute('math_research', run); const { action, ...args } = run;
  assert.equal(f.calls.at(-1).method, 'run'); assert.deepEqual(f.calls.at(-1).args, args);
  for (const action of ['status', 'result', 'stop']) {
    const reply = await f.execute('math_research', { action, runId: RUN }); assert.equal(reply.isError, false);
    assert.equal(f.calls.at(-1).method, action); assert.equal(f.calls.at(-1).args.runId, RUN);
  }
  assert.equal(f.stages.length, 0);
  await f.execute('gm_search', valid.gm_search); assert.deepEqual(f.calls.at(-1).args, { query: '' });
});

test('unknown identity/receipt/path fields are rejected for every tool and each control action', async (t) => {
  const f = await fixture(t);
  const forbidden = ['role', 'model', 'path', 'projectId', 'author', 'verification', 'sessionId', 'scope', 'callToken', 'unknown'];
  for (const [name, input] of Object.entries(valid)) for (const key of forbidden) assert.equal((await f.execute(name, { ...input, [key]: 'spoof' })).isError, true, `${name}.${key}`);
  for (const action of ['status', 'result', 'stop']) for (const key of forbidden) assert.equal((await f.execute('math_research', { action, runId: RUN, [key]: 'spoof' })).isError, true);
  for (const input of [{ action: 'run', problem: 'fixture', runId: RUN }, { action: 'status', runId: RUN, factId: FID }, { action: 'stop', runId: RUN, problem: 'extra' }, { action: 'result', runId: RUN, timeoutSeconds: 90 }]) {
    assert.equal((await f.execute('math_research', input)).isError, true);
  }
  assert.equal(f.calls.length, 0);
});

test('array and non-string research actions cannot coerce into dispatch or bypass proof export', async (t) => {
  const f = await fixture(t); f.value.fact.markdown = markdown('Long software fixture only. '.repeat(1000));
  const inputs = [
    { ...request, action: ['result'] }, { ...request, action: [['result']] },
    { action: ['status'], runId: RUN }, { action: ['stop'], runId: RUN },
    { ...valid.math_research, action: ['run'] },
    ...[[], ['result', 'status'], null, undefined, false, true, 0, 1, {}, { 0: 'result', length: 1 }, { toString: 'result' }]
      .map((action) => ({ ...request, action })),
  ];
  for (const input of inputs) {
    const reply = await f.execute('math_research', input);
    assert.equal(reply.isError, true);
    assert.equal(reply.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
    assert.equal(f.calls.length, 0, 'invalid action must not reach any service method');
    assert.equal(f.stages.length, 0, 'invalid action must not create a delivery');
    assert.equal(reply.content[0].text.includes('Long software fixture'), false);
  }
});

test('the host stamps context last; absent context or old two-argument execute cannot manufacture identity', async (t) => {
  const f = await fixture(t);
  await f.execute('fact_search', { ...valid.fact_search, context: { sessionPath: '/victim', callToken: 'forged' } });
  assert.strictEqual(f.calls[0].context, context);
  const tool = f.tools.get('fact_search');
  assert.equal((await tool.execute(valid.fact_search, context)).isError, true);
  assert.equal((await tool.execute({ ...valid.fact_search, context: null })).isError, true);
  assert.equal(f.calls.length, 1);
  f.controls.serviceError = Object.assign(new Error('private host token should not leak'), { code: 'ROLE_DENIED' });
  const denied = await f.execute('math_assign', valid.math_assign, other);
  assert.equal(denied.isError, true); assert.equal(denied.details.error.code, 'ROLE_DENIED'); assert.strictEqual(f.calls.at(-1).context, other);
  assert.doesNotMatch(denied.content[0].text, /private host token/);
});

test('registration requires the internal input-rejection contract before registering any tool', async (t) => {
  const f = await fixture(t); let registrations = 0;
  const sdk = { ...f.sdk, tools: { async register() { registrations++; assert.fail('Incomplete service registered a tool'); } } };
  for (const hook of [undefined, null, false, {}]) {
    const service = { ...f.service, recordSubmissionInputRejection: hook };
    await assert.rejects(registerMathResearch(sdk, service), { code: 'RESEARCH_SERVICE_REQUIRED' });
  }
  assert.equal(registrations, 0); assert.equal(f.rejectionCalls.length, 0);
});

for (const nativeProjects of [false, true]) test(`fact_submit validation records only code with original Host context (projects=${nativeProjects})`, async (t) => {
  const f = await fixture(t, { nativeProjects }); f.controls.rejectionAuthorized = true;
  // Authorization is a fixture here, not a claim that this context has real worker authority.
  const ctx = Object.freeze({ ...context, messageText: 'OPAQUE_HOST_MESSAGE' });
  const invalid = { statement: 'PRIVATE_STATEMENT', proof: 'PRIVATE_PROOF', source_id: 'PRIVATE_SOURCE'.repeat(400) };
  const response = await f.execute('fact_submit', invalid, ctx);
  assert.equal(response.isError, true); assert.equal(response.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  assert.equal(f.rejectionCalls.length, 1); assert.strictEqual(f.rejectionCalls[0].context, ctx);
  assert.deepEqual(Object.keys(f.rejectionCalls[0]), ['context', 'code']);
  assert.equal(f.rejectionCalls[0].code, 'RESEARCH_TOOL_INVALID_INPUT');
  assert.deepEqual(f.rejectionRecords, [{ code: 'RESEARCH_TOOL_INVALID_INPUT' }]);
  assert.doesNotMatch(JSON.stringify({ response, records: f.rejectionRecords }), /PRIVATE_|OPAQUE_HOST_MESSAGE|statement|proof|source_id/);
  assert.equal(f.calls.length, 0); assert.equal(f.stages.length, 0);
});

test('forged identity arguments cannot replace the Host context supplied to rejection recording', async (t) => {
  const f = await fixture(t); f.controls.rejectionAuthorized = true;
  const response = await f.execute('fact_submit', { ...valid.fact_submit, runId: 'forged-run', role: 'worker', author: 'forged-author',
    callToken: 'forged-token', context: { sessionPath: '/forged', callToken: 'forged-token' } });
  assert.equal(response.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  assert.equal(f.rejectionCalls.length, 1); assert.strictEqual(f.rejectionCalls[0].context, context);
  assert.deepEqual(f.rejectionRecords, [{ code: 'RESEARCH_TOOL_INVALID_INPUT' }]); assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(f.rejectionRecords), /forged|worker|author|runId/);
});

test('unauthorized false is not a record, success, retry or fallback', async (t) => {
  const f = await fixture(t); f.controls.rejectionAuthorized = false;
  const response = await f.execute('fact_submit', { statement: 'PRIVATE_STATEMENT', proof: '' }, other);
  assert.equal(response.isError, true); assert.equal(response.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  assert.equal(f.rejectionCalls.length, 1); assert.strictEqual(f.rejectionCalls[0].context, other);
  assert.deepEqual(f.rejectionRecords, []); assert.equal(f.calls.length, 0); assert.equal(f.stages.length, 0);
  assert.equal(Object.hasOwn(response.details, 'recorded'), false);
});

test('rejection hook is awaited once, without invoking the submission pipeline', async (t) => {
  const f = await fixture(t), gate = deferred(); t.after(() => gate.resolve());
  f.controls.rejectionAuthorized = true; f.controls.rejectionGate = gate.promise;
  let settled = false;
  const pending = f.execute('fact_submit', { statement: 'PRIVATE_STATEMENT' }).then(value => { settled = true; return value; });
  await until(() => f.rejectionCalls.length === 1);
  assert.equal(settled, false); assert.equal(f.rejectionRecords.length, 0); assert.equal(f.calls.length, 0);
  gate.resolve(); const response = await pending;
  assert.equal(response.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  assert.equal(f.rejectionCalls.length, 1); assert.deepEqual(f.rejectionRecords, [{ code: 'RESEARCH_TOOL_INVALID_INPUT' }]);
});

for (const kind of ['sync', 'async', 'opaque-error']) test(`recording ${kind} failure never masks the original parameter error or retries`, async (t) => {
  const f = await fixture(t); f.controls.rejectionAuthorized = true;
  const secondary = kind === 'opaque-error' ? {
    get code() { assert.fail('Secondary private error code read'); },
    get message() { assert.fail('Secondary private error message read'); },
  } : Object.assign(new Error('PRIVATE_PERSISTENCE_MESSAGE'), { code: 'PERSISTENCE_FAILED' });
  if (kind === 'sync') f.service.recordSubmissionInputRejection = (...args) => {
    assert.equal(args.length, 2); f.rejectionCalls.push({ context: args[0], code: args[1] }); throw secondary;
  };
  else f.controls.rejectionError = secondary;
  const response = await f.execute('fact_submit', { statement: 'PRIVATE_STATEMENT', proof: '' });
  assert.equal(response.isError, true); assert.equal(response.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE|PERSISTENCE_FAILED/);
  assert.equal(f.rejectionCalls.length, 1); assert.equal(f.rejectionRecords.length, 0); assert.equal(f.calls.length, 0);
});

test('failed invocation cannot manufacture an attributable rejection, even when a context property exists', async (t) => {
  const f = await fixture(t); f.controls.rejectionAuthorized = true; let getterReads = 0;
  const tool = f.tools.get('fact_submit');
  const getter = { context, statement: 'PRIVATE_STATEMENT' };
  Object.defineProperty(getter, 'proof', { enumerable: true, get() { getterReads++; return 'PRIVATE_PROOF'; } });
  const cycle = {}; cycle.self = cycle;
  for (const raw of [
    { statement: 'PRIVATE_STATEMENT' }, { statement: 'PRIVATE_STATEMENT', context: null },
    { ...valid.fact_submit, context: [] }, getter,
    { statement: 'PRIVATE_STATEMENT', proof: undefined, context },
    { statement: 'PRIVATE_STATEMENT', proof: 'x'.repeat(TEXT + 1), context },
    { ...valid.fact_submit, external_refs: [cycle], context },
    new Proxy({ ...valid.fact_submit, context }, {}),
  ]) assert.equal((await tool.execute(raw)).isError, true);
  assert.equal(getterReads, 0); assert.equal(f.rejectionCalls.length, 0); assert.equal(f.calls.length, 0);
  assert.equal((await tool.execute({ statement: 'PRIVATE_STATEMENT' }, context)).isError, true);
  assert.equal(f.rejectionCalls.length, 0);
});

test('other tool validation and post-disposal rejection do not call the submission hook', async (t) => {
  const f = await fixture(t); f.controls.rejectionAuthorized = true;
  assert.equal((await f.execute('gm_add', { kind: 'bad-kind', claim: 'PRIVATE' })).isError, true);
  assert.equal((await f.execute('math_assign', { task: '' })).isError, true);
  assert.equal((await f.execute('math_verification_report', { ...correct, verdict: 'wrong' })).isError, true);
  await f.registration.dispose();
  assert.equal((await f.execute('fact_submit', { statement: 'PRIVATE_STATEMENT' })).details.error.code, 'RESEARCH_TOOLS_DISPOSED');
  assert.equal(f.rejectionCalls.length, 0); assert.equal(f.calls.length, 0);
});

test('valid submission, invoke failure and malformed service result never double-count through the front hook', async (t) => {
  const f = await fixture(t); f.controls.rejectionAuthorized = true;
  const input = { statement: '  Original fixture\r\n', proof: 'Original opaque proof\n' };
  const validReply = await f.execute('fact_submit', input);
  assert.equal(validReply.isError, false); assert.equal(validReply.details.pending, true);
  assert.deepEqual(f.calls[0].args, input); assert.strictEqual(f.calls[0].context, context);
  f.controls.serviceError = Object.assign(new Error('PRIVATE_CORE_FAILURE'), { code: 'RESEARCH_TOOL_INVALID_INPUT' });
  assert.equal((await f.execute('fact_submit', input)).details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  delete f.controls.serviceError;
  f.controls.replies.fact_submit = undefined;
  assert.equal((await f.execute('fact_submit', input)).isError, true);
  f.controls.replies.fact_submit = { ok: false, error: { code: 'FIXTURE_INVOKE_FAILURE' } };
  assert.equal((await f.execute('fact_submit', input)).isError, true);
  assert.equal(f.calls.length, 4); assert.equal(f.rejectionCalls.length, 0); assert.equal(f.rejectionRecords.length, 0);
});

test('runtime validation does not trust mutable registration schemas', async (t) => {
  const f = await fixture(t); const tool = f.tools.get('gm_add');
  tool.parameters.additionalProperties = true; tool.parameters.properties.kind.enum.push('forged-kind');
  assert.equal((await f.execute('gm_add', { kind: 'forged-kind', claim: 'fixture' })).isError, true);
  assert.equal((await f.execute('gm_add', { ...valid.gm_add, role: 'main' })).isError, true); assert.equal(f.calls.length, 0);
});

test('nullable/default fields follow Core signatures rather than coercing values', async (t) => {
  const f = await fixture(t);
  for (const [name, input] of [
    ['gm_add', { ...valid.gm_add, evidence: null }], ['gm_add', { ...valid.gm_add, verifiable: 'false' }],
    ['gm_add', { kind: 'conclusion', claim: 'fixture' }], ['gm_add', { ...valid.gm_add, verifiable: true, evidence: '  ' }],
    ['gm_search', { query: '', limit_per_kind: null }], ['gm_search', { query: '', kinds: ['invented'] }],
    ['fact_search', { query: '', limit: true }], ['fact_search', { query: '', limit: 129 }],
    ['fact_submit', { ...valid.fact_submit, intuition: null }], ['fact_submit', { ...valid.fact_submit, external_refs: ['citation'] }],
    ['fact_submit', { ...valid.fact_submit, predecessors: [PRED, PRED] }], ['fact_submit', { ...valid.fact_submit, predecessors: [PRED.toUpperCase()] }],
    ['search_arxiv_theorems', { query: 'fixture', num_results: null }], ['search_arxiv_theorems', { query: 'fixture', num_results: 101 }],
    ['math_local_memory', { action: 'read', text: '' }], ['math_local_memory', { action: 'append' }],
  ]) assert.equal((await f.execute(name, input)).isError, true, `${name}: ${JSON.stringify(input)}`);
  assert.equal(f.calls.length, 0);
  for (const kind of f.tools.get('gm_add').parameters.properties.kind.enum) assert.equal((await f.execute('gm_add', { kind, claim: 'fixture', evidence: 'fixture evidence' })).isError, false);
  assert.equal((await f.execute('gm_add', { kind: 'conclusion', claim: 'fixture', verifiable: false })).isError, false);
  assert.equal((await f.execute('fact_submit', { ...valid.fact_submit, external_refs: null })).isError, false);
});

test('verifier report shape and bidirectional consistency are checked without making the wrapper a verifier', async (t) => {
  const f = await fixture(t);
  const wrong = { verification_report: { summary: '', critical_errors: [], gaps: [{ location: 'Fixture section', issue: 'Missing fixture data' }] }, verdict: 'wrong', repair_hints: 'Provide fixture data' };
  assert.equal((await f.execute('math_verification_report', wrong)).isError, false);
  for (const input of [{ ...wrong, verdict: 'correct' }, { ...wrong, repair_hints: '' }, { ...correct, verdict: 'wrong' }, { ...correct, repair_hints: 'unexpected' },
    { ...correct, verification_report: { ...correct.verification_report, summary: null } },
    { ...wrong, verification_report: { ...wrong.verification_report, gaps: [{ location: 'x', issue: 'fixture', author: 'override' }] } }]) assert.equal((await f.execute('math_verification_report', input)).isError, true);
  assert.equal(f.calls.length, 1);
});

test('UTF-8, small text, per-tool limits, item counts, depth and total JSON bytes are enforced without truncation', async (t) => {
  const f = await fixture(t);
  const claim = '界'.repeat(Math.floor(TEXT / 3));
  assert.equal((await f.execute('gm_add', { kind: 'plan', claim })).isError, false); assert.equal(f.calls.at(-1).args.claim, claim);
  assert.equal((await f.execute('gm_add', { kind: 'plan', claim: claim + '界' })).isError, true);
  for (const [name, key, maximum, base] of [['gm_search', 'query', 4096, {}], ['search_arxiv_theorems', 'query', 16384, {}], ['math_assign', 'task', 128 * 1024, {}], ['math_research', 'problem', 128 * 1024, { action: 'run' }]]) {
    assert.equal((await f.execute(name, { ...base, [key]: 'x'.repeat(maximum) })).isError, false);
    assert.equal((await f.execute(name, { ...base, [key]: 'x'.repeat(maximum + 1) })).isError, true);
  }
  for (const timeoutSeconds of [60, 900]) assert.equal((await f.execute('math_research', { ...valid.math_research, timeoutSeconds })).isError, false);
  for (const timeoutSeconds of [59, 901, 90.5, null, '60']) assert.equal((await f.execute('math_research', { ...valid.math_research, timeoutSeconds })).isError, true);
  const links = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`key${i}`, 'fixture']));
  assert.equal((await f.execute('gm_add', { ...valid.gm_add, links })).isError, false);
  assert.equal((await f.execute('gm_add', { ...valid.gm_add, links: { ...links, excess: true } })).isError, true);
  assert.equal((await f.execute('fact_submit', { ...valid.fact_submit, external_refs: Array.from({ length: 128 }, () => ({})) })).isError, false);
  assert.equal((await f.execute('fact_submit', { ...valid.fact_submit, external_refs: Array.from({ length: 129 }, () => ({})) })).isError, true);
  assert.equal((await f.execute('gm_add', { ...valid.gm_add, links: { a: { b: { c: { d: { e: 'leaf' } } } } } })).isError, false);
  assert.equal((await f.execute('gm_add', { ...valid.gm_add, links: { a: { b: { c: { d: { e: { f: 'leaf' } } } } } } })).isError, true);
  const exact = { statement: 's', proof: 'p', external_refs: [{ a: 'x'.repeat(TEXT), b: 'x'.repeat(TEXT), c: 'x'.repeat(TEXT), d: '' }] };
  exact.external_refs[0].d = 'x'.repeat(TOTAL - Buffer.byteLength(JSON.stringify(exact)));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), TOTAL);
  assert.equal((await f.execute('fact_submit', exact)).isError, false);
  exact.external_refs[0].d += 'x'; assert.equal((await f.execute('fact_submit', exact)).isError, true);
});

test('NUL, invalid Unicode and non-JSON values are rejected without invoking getters', async (t) => {
  const f = await fixture(t); let getterReads = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { getterReads++; return 'fixture'; } });
  const hidden = Object.defineProperty({}, 'hidden', { value: 'hidden' }); const cycle = {}; cycle.self = cycle;
  const withSymbol = { [Symbol('not JSON')]: true }; const extraArray = []; extraArray.extra = true;
  const bad = [undefined, NaN, Infinity, 1n, () => {}, new Date(), new Map(), new Set(), Buffer.from('fixture'), new Proxy({}, {}), getter, hidden, cycle, withSymbol, new Array(1), extraArray, { toJSON() { getterReads++; return {}; } }, { value: '\0' }, { value: '\ud800' }, { ['bad\0key']: true }];
  for (const value of bad) assert.equal((await f.execute('gm_add', { ...valid.gm_add, links: { value } })).isError, true);
  assert.equal(getterReads, 0); assert.equal(f.calls.length, 0);
});

test('glossary limits mirror the unquoted upstream frontmatter contract', async (t) => {
  const f = await fixture(t);
  const glossary = { '\\alpha': 'Fixture symbol', 'x_1': 'Original definition' };
  assert.equal((await f.execute('fact_submit', { ...valid.fact_submit, glossary_introduces: glossary })).isError, false);
  assert.deepEqual(f.calls.at(-1).args.glossary_introduces, glossary);
  for (const value of [{ bad: '' }, { 'bad:key': 'fixture' }, { ok: ' leading' }, { ok: 'a: b' }, { ok: 'line\nbreak' }, { ok: 'x # comment' }, { ok: null }, { ok: 'x'.repeat(4097) }]) {
    assert.equal((await f.execute('fact_submit', { ...valid.fact_submit, glossary_introduces: value })).isError, true);
  }
});

test('errors and accepted-without-write are never successful; pending and wrong verdict preserve their business meaning', async (t) => {
  const f = await fixture(t);
  for (const value of [{ error: 'fixture error' }, { error: { code: 'FORBIDDEN' } }, { ok: false }, { success: false }, { failed: true }, { state: 'failed' }, { status: 'timed-out' },
    { accepted: false, verdict: 'error' }, { accepted: true, fact_id: null, write_error: 'fixture' }, { accepted: true, fact_id: null },
    { accepted: true, fact_id: FID, write_error: 'not settled' }, { accepted: true, fact_id: FID, pending: true }, { indeterminate: true }]) {
    f.controls.replies.fact_submit = value; const reply = await f.execute('fact_submit', valid.fact_submit);
    assert.equal(reply.isError, true); assert.deepEqual(resultText(reply), value);
  }
  for (const value of [{ pending: true, accepted: false, submissionId: 'submission-fixture' }, { accepted: false, verdict: 'wrong', repair_hints: 'Fixture repair' }, { accepted: true, fact_id: FID }]) {
    f.controls.replies.fact_submit = value; const reply = await f.execute('fact_submit', valid.fact_submit);
    assert.equal(reply.isError, false); assert.deepEqual(reply.details, value);
  }
  f.controls.replies.status = { runId: RUN, state: 'finished' };
  const finished = await f.execute('math_research', { action: 'status', runId: RUN }); assert.deepEqual(finished.details, f.controls.replies.status);
  f.controls.replies.fact_search = undefined; assert.equal((await f.execute('fact_search', valid.fact_search)).isError, true);
});

test('small proof is preserved in chat and exported whole as a 0600 file with a validated session-file receipt', async (t) => {
  const f = await fixture(t); const reply = await f.execute('math_research', request);
  assert.equal(reply.isError, false); assert.equal(reply.details.fact.markdown, f.value.fact.markdown);
  assert.deepEqual(reply.details.predecessors, [PRED]); assert.equal(reply.details.fact_id, FID); assert.equal(reply.details.fullTextInFile, true);
  assert.deepEqual(reply.details.metadata, f.value.metadata); assert.equal(reply.details.fileId, 'file-1');
  assert.deepEqual(reply.details.resource, { kind: 'session-file', fileId: 'file-1', sessionId: 'session-a' });
  const stage = f.stages[0]; assert.strictEqual(stage.context, context); assert.equal(stage.input.mime, 'text/markdown'); assert.equal(stage.input.deliverAs, 'attachment');
  assert.ok(stage.input.path.startsWith(path.join(f.dataDir, 'research/exports') + path.sep));
  assert.equal((await fs.stat(stage.input.path)).mode & 0o777, 0o600);
  assert.deepEqual(stage.bytes, Buffer.from(f.value.fact.markdown)); assert.equal(reply.details.sha256, sha(stage.bytes)); assert.equal(reply.details.bytes, stage.bytes.length);
  assert.deepEqual(await fs.readFile(stage.input.path), stage.bytes); assert.doesNotMatch(stage.bytes.toString(), /host-token-fixture/);
  assert.deepEqual(resultText(reply), reply.details);
});

test('long proof is delivered completely, with no truncated markdown masquerading as the full proof', async (t) => {
  const f = await fixture(t); f.value.fact.markdown = markdown('Unicode fixture 字'.repeat(3000));
  const reply = await f.execute('math_research', request);
  assert.equal(reply.isError, false); assert.equal(Object.hasOwn(reply.details.fact, 'markdown'), false); assert.equal(reply.details.fullTextInFile, true);
  assert.deepEqual(f.stages[0].bytes, Buffer.from(f.value.fact.markdown)); assert.equal(reply.details.sha256, sha(f.stages[0].bytes));
  assert.ok(Buffer.byteLength(reply.content[0].text) < 16384); assert.equal(reply.content[0].text.includes('Unicode fixture'), false);
});

test('16 KiB chat boundary uses UTF-8 bytes, not character count', async (t) => {
  const f = await fixture(t); const header = markdown('');
  f.value.fact.markdown = header + 'x'.repeat(16384 - Buffer.byteLength(header));
  const small = await f.execute('math_research', request); assert.equal(Buffer.byteLength(small.details.fact.markdown), 16384);
  f.value.fact.markdown = header + '字'.repeat(6000);
  const large = await f.execute('math_research', request); assert.equal(Object.hasOwn(large.details.fact, 'markdown'), false); assert.equal(f.stages.length, 2);
});

test('lists facts without staging, including an empty pending project; validates result identity and canonical headers', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.execute('math_research', { action: 'result', runId: RUN })).isError, false); assert.equal(f.stages.length, 0);
  f.controls.replies.result = { runId: RUN, projectId: null, facts: [], page: null, state: 'queued' };
  assert.equal((await f.execute('math_research', { action: 'result', runId: RUN })).isError, false); delete f.controls.replies.result;
  const bad = [
    { ...f.value, runId: 'another-run' }, { ...f.value, projectId: '../outside' },
    { ...f.value, fact: { ...f.value.fact, fact_id: PRED } }, { ...f.value, fact: { ...f.value.fact, predecessors: [] } },
    { ...f.value, fact: { ...f.value.fact, predecessors: [PRED, PRED] } },
    { ...f.value, fact: { ...f.value.fact, markdown: f.value.fact.markdown.replace(`fact_id: ${FID}`, `fact_id: ${PRED}`) } },
    { ...f.value, fact: { ...f.value.fact, markdown: f.value.fact.markdown.replace('predecessors: [', `fact_id: ${FID}\npredecessors: [`) } },
    { ...f.value, fact: { ...f.value.fact, markdown: f.value.fact.markdown.replace('---\n', '---\r\n') } },
    { ...f.value, fact: { ...f.value.fact, markdown: f.value.fact.markdown.replace('predecessors: [', '  predecessors: []\npredecessors: [') } },
    { ...f.value, fact: { ...f.value.fact, markdown: f.value.fact.markdown.replace('predecessors: [', ' ---\npredecessors: [') } },
  ];
  for (const value of bad) { f.controls.replies.result = value; assert.equal((await f.execute('math_research', request)).isError, true); }
  assert.equal(f.stages.length, 0);
});

for (const [label, receipt] of [
  ['wrong kind', { resource: { kind: 'local-file', fileId: 'x', sessionId: 'session-a' } }],
  ['missing fileId', { resource: { kind: 'session-file', sessionId: 'session-a' } }],
  ['missing sessionId', { resource: { kind: 'session-file', fileId: 'x' } }],
  ['numeric fileId', { resource: { kind: 'session-file', fileId: 1, sessionId: 'session-a' } }],
  ['ok false', { ok: false, resource: { kind: 'session-file', fileId: 'x', sessionId: 'session-a' } }],
  ['error', { error: 'denied', resource: { kind: 'session-file', fileId: 'x', sessionId: 'session-a' } }],
]) test(`invalid stage receipt ${label} is an error, not a delivered proof`, async (t) => {
  const f = await fixture(t); f.controls.stageReceipt = receipt;
  const reply = await f.execute('math_research', request);
  assert.equal(reply.isError, true); assert.equal(reply.details.error.code, 'FACT_EXPORT_FAILED'); assert.equal(reply.details.delivery, 'failed');
  assert.equal(Object.hasOwn(reply.details, 'resource'), false); assert.equal(Object.hasOwn(reply.details, 'fileId'), false);
  assert.equal(reply.details.factUnchanged, true); assert.deepEqual(f.stages[0].bytes, Buffer.from(f.value.fact.markdown));
});

for (const [label, metadata] of [
  ['SDK capability field', { code: 'APP_CAPABILITY_DENIED', kind: 'permission', capability: 'app/session.stage-file', message: 'PRIVATE_STAGE_ERROR' }],
  ['SDK capability field without a specialized code', { code: 'APP_HOST_ERROR', capability: 'app/session.stage-file', message: 'PRIVATE_STAGE_ERROR' }],
  ['permission code plus capability name', { code: 'CAPABILITY_DENIED', kind: 'permission', message: 'Denied app/session.stage-file; PRIVATE_STAGE_ERROR' }],
  ['legacy named denial', { code: 'APP_HOST_ERROR', message: 'App requires app/session.stage-file permission. PRIVATE_STAGE_ERROR' }],
]) test(`stage-file denial via ${label} names the required capability without exposing the host error or changing facts`, async (t) => {
  const f = await fixture(t); const original = structuredClone(f.value);
  f.controls.stageError = new AppSdkError({ operation: 'resources.stage', ...metadata });
  const reply = await f.execute('math_research', request);
  assert.equal(reply.isError, true); assert.equal(reply.details.error.code, 'FACT_EXPORT_FAILED');
  assert.equal(reply.details.error.requiredCapability, 'app/session.stage-file');
  assert.match(reply.details.error.message, /App Capabilities page in Hana settings/);
  assert.match(reply.details.error.message, /user to authorize app\/session\.stage-file for Hana Math/);
  assert.doesNotMatch(reply.content[0].text, /PRIVATE_STAGE_ERROR/);
  assert.equal(reply.details.factUnchanged, true); assert.equal(reply.details.delivery, 'failed');
  assert.equal(Object.hasOwn(reply.details, 'fileId'), false); assert.equal(Object.hasOwn(reply.details, 'resource'), false);
  assert.deepEqual(f.value, original); assert.deepEqual(f.calls.map((call) => call.method), ['result']);
  assert.equal(f.stages.length, 1); assert.deepEqual(f.stages[0].bytes, Buffer.from(original.fact.markdown));
  // Clearing the fixture rejection simulates a later user decision, not an
  // authorization API call or an automatic retry from this tool.
  f.controls.stageError = null;
  const retried = await f.execute('math_research', request);
  assert.equal(retried.isError, false); assert.equal(f.stages.length, 2); assert.deepEqual(f.value, original);
});

for (const [label, metadata] of [
  ['file-copy EACCES', { code: 'EACCES', capability: 'app/session.stage-file', message: 'EACCES: file write denied near app/session.stage-file; PRIVATE_STAGE_ERROR' }],
  ['file-copy EPERM', { code: 'EPERM', message: 'Permission denied; PRIVATE_STAGE_ERROR' }],
  ['filesystem permission model', { code: 'ERR_ACCESS_DENIED', message: 'File write access denied; PRIVATE_STAGE_ERROR' }],
  ['transport timeout', { code: 'RPC_TIMEOUT', kind: 'timeout', capability: 'app/session.stage-file', message: 'Timed out checking app/session.stage-file; PRIVATE_STAGE_ERROR' }],
  ['different named capability', { code: 'APP_CAPABILITY_DENIED', kind: 'permission', capability: 'app/resources.write', message: 'Denied source permission before app/session.stage-file; PRIVATE_STAGE_ERROR' }],
  ['unnamed capability denial', { code: 'CAPABILITY_DENIED', kind: 'permission', message: 'PRIVATE_STAGE_ERROR' }],
  ['similar capability name', { code: 'CAPABILITY_DENIED', kind: 'permission', message: 'Denied app/session.stage-files; PRIVATE_STAGE_ERROR' }],
  ['ordinary named stage exception', { code: 'APP_HOST_ERROR', message: 'Unexpected exception while handling app/session.stage-file; PRIVATE_STAGE_ERROR' }],
]) test(`${label} does not misreport a missing stage-file grant`, async (t) => {
  const f = await fixture(t); const original = structuredClone(f.value);
  f.controls.stageError = new AppSdkError({ operation: 'resources.stage', ...metadata });
  const reply = await f.execute('math_research', request);
  assert.equal(reply.isError, true); assert.equal(reply.details.error.code, 'FACT_EXPORT_FAILED');
  assert.equal(reply.details.error.cause, metadata.code);
  assert.equal(Object.hasOwn(reply.details.error, 'requiredCapability'), false);
  assert.doesNotMatch(reply.details.error.message, /应用能力|stage-file|授权/);
  assert.doesNotMatch(reply.content[0].text, /PRIVATE_STAGE_ERROR/);
  assert.deepEqual(f.value, original); assert.equal(f.stages.length, 1);
});

test('stage failure leaves the canonical result intact and can retry without overwriting exports or caching failure', async (t) => {
  const f = await fixture(t); const original = structuredClone(f.value);
  f.controls.stageError = Object.assign(new Error('host-token-fixture-secret'), { code: 'FORBIDDEN' });
  const failed = await f.execute('math_research', request);
  assert.equal(failed.isError, true); assert.equal(failed.details.error.cause, 'FORBIDDEN'); assert.doesNotMatch(failed.content[0].text, /host-token-fixture-secret/);
  assert.deepEqual(f.value, original); assert.deepEqual(f.calls.map((call) => call.method), ['result']);
  f.controls.stageError = null; const success = await f.execute('math_research', request);
  assert.equal(success.isError, false); assert.equal(f.stages.length, 2); assert.equal(f.stages[0].input.path, f.stages[1].input.path);
});

test('same-origin concurrent and repeated queries reuse only confirmed delivery, reauthorize each call, and do not cross origins', async (t) => {
  const gate = deferred(); t.after(() => gate.resolve()); const f = await fixture(t); f.controls.stageGate = gate.promise;
  const pending = Array.from({ length: 5 }, (_, i) => f.execute('math_research', request, { ...context, callToken: `ephemeral-${i}` }));
  await until(() => f.stages.length === 1); gate.resolve(); const replies = await Promise.all(pending);
  assert.equal(f.stages.length, 1); assert.equal(f.calls.length, 5); assert.ok(replies.every((reply) => reply.details.fileId === 'file-1'));
  replies[0].details.resource.fileId = 'mutated';
  assert.equal((await f.execute('math_research', request)).details.resource.fileId, 'file-1'); assert.equal(f.stages.length, 1);
  const secondOrigin = await f.execute('math_research', request, other);
  assert.equal(secondOrigin.details.resource.sessionId, 'session-b'); assert.equal(secondOrigin.details.fileId, 'file-2');
  assert.equal(f.stages.length, 2);
  f.controls.serviceError = Object.assign(new Error('no longer authorized'), { code: 'OWNER_DENIED' });
  assert.equal((await f.execute('math_research', request)).isError, true); assert.equal(f.stages.length, 2);
});

test('missing current callToken cannot stage using a forged sessionId or an old cached receipt', async (t) => {
  const f = await fixture(t); await f.execute('math_research', request);
  const reply = await f.execute('math_research', request, { sessionPath: context.sessionPath, sessionId: 'forged' });
  assert.equal(reply.isError, true); assert.equal(f.stages.length, 1);
});

for (const conflict of ['directory-symlink', 'file-symlink', 'existing-content']) test(`export refuses ${conflict} without overwriting existing content`, async (t) => {
  const f = await fixture(t); const outside = path.join(f.dataDir, 'outside-fixture'); await fs.mkdir(outside);
  const protectedFile = path.join(outside, 'protected.txt'); await fs.writeFile(protectedFile, 'Protected fixture content');
  const directory = path.join(f.dataDir, 'research/exports', PROJECT, RUN);
  if (conflict === 'directory-symlink') {
    await fs.mkdir(path.join(f.dataDir, 'research')); await fs.symlink(outside, path.join(f.dataDir, 'research/exports'));
  } else {
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, `${FID}-${sha(Buffer.from(f.value.fact.markdown))}.md`);
    if (conflict === 'file-symlink') await fs.symlink(protectedFile, target);
    else await fs.writeFile(target, 'Existing export must not be overwritten', { mode: 0o600 });
  }
  const reply = await f.execute('math_research', request);
  assert.equal(reply.isError, true); assert.equal(f.stages.length, 0);
  assert.equal(Object.hasOwn(reply.details.error, 'requiredCapability'), false);
  assert.doesNotMatch(reply.details.error.message, /应用能力|stage-file|授权/);
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'Protected fixture content');
  if (conflict === 'existing-content') assert.equal(await fs.readFile(path.join(directory, `${FID}-${sha(Buffer.from(f.value.fact.markdown))}.md`), 'utf8'), 'Existing export must not be overwritten');
});

test('proof export works with Node filesystem grants limited to the module files and App data root', async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL('../packages/hana-math/research-tools.mjs', import.meta.url);
  const storeUrl = new URL('../packages/hana-math/context-service.mjs', import.meta.url);
  const runtimeUrl = new URL('../packages/hana-math/runtime/research-runtime.mjs', import.meta.url);
  const pythonLaunchUrl = new URL('../packages/hana-math/runtime/python-launch.mjs', import.meta.url);
  const ownerUrl = new URL('./managed-read-owner.mjs', runtimeUrl);
  const policyUrl = new URL('../packages/hana-math/worker-policy.mjs', import.meta.url);
  const pageUrl = new URL('../packages/hana-math/fact-page.mjs', import.meta.url);
  const selectionUrl = new URL('../packages/hana-math/worker-selection.mjs', import.meta.url);
  const revisionInputUrl = new URL('../packages/hana-math/paper-revision-input.mjs', import.meta.url);
  const deliveryUrl = new URL('../packages/hana-math/paper-delivery.mjs', import.meta.url);
  const chapterTreeUrl = new URL('../packages/hana-math/paper-chapter-tree.mjs', import.meta.url);
  const refVerifyUrl = new URL('../packages/hana-math/reference-verification.mjs', import.meta.url);
  const compilePlanUrl = new URL('../packages/hana-math/paper-compile-plan.mjs', import.meta.url);
  const planInputUrl = new URL('../packages/hana-math/paper-plan-input.mjs', import.meta.url);
  const sectionInputUrl = new URL('../packages/hana-math/paper-section-input.mjs', import.meta.url);
  const operatorUrl = new URL('../packages/hana-math/operator-interview.mjs', import.meta.url);
  const source = `import {registerMathResearch} from ${JSON.stringify(moduleUrl.href)};
    import * as fs from 'node:fs/promises';
    let control;
    const service = {async recordSubmissionInputRejection(){throw Error('unused')},setupStatus(){throw Error('unused')},setToolMode(){throw Error('unused')},run(){throw Error('unused')},status(){throw Error('unused')},stop(){throw Error('unused')},invoke(){throw Error('unused')},result:async()=>(${JSON.stringify(f.value)})};
    const sdk = {dataDir:${JSON.stringify(f.dataDir)},tools:{register:async(tool)=>{if(tool.name==='math_research')control=tool;return ()=>{};}},resources:{stage:async(input)=>{
      const body=await fs.readFile(input.path,'utf8');if(body!==${JSON.stringify(f.value.fact.markdown)})throw Error('fixture bytes changed');
      return {file:{},mediaItem:null,resource:{kind:'session-file',fileId:'permission-fixture',sessionId:'fixture-session'}};
    }}};
    const registration=await registerMathResearch(sdk,service);
    console.log(JSON.stringify(await control.execute({...${JSON.stringify(request)},context:${JSON.stringify(context)}})));
    await registration.dispose();`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--permission', `--allow-fs-read=${fileURLToPath(moduleUrl)}`, `--allow-fs-read=${fileURLToPath(storeUrl)}`, `--allow-fs-read=${fileURLToPath(runtimeUrl)}`, `--allow-fs-read=${fileURLToPath(pythonLaunchUrl)}`, `--allow-fs-read=${fileURLToPath(ownerUrl)}`, `--allow-fs-read=${fileURLToPath(policyUrl)}`, `--allow-fs-read=${fileURLToPath(pageUrl)}`, `--allow-fs-read=${fileURLToPath(selectionUrl)}`, `--allow-fs-read=${fileURLToPath(revisionInputUrl)}`, `--allow-fs-read=${fileURLToPath(deliveryUrl)}`, `--allow-fs-read=${fileURLToPath(chapterTreeUrl)}`, `--allow-fs-read=${fileURLToPath(refVerifyUrl)}`, `--allow-fs-read=${fileURLToPath(compilePlanUrl)}`, `--allow-fs-read=${fileURLToPath(planInputUrl)}`, `--allow-fs-read=${fileURLToPath(sectionInputUrl)}`, `--allow-fs-read=${fileURLToPath(operatorUrl)}`,
    `--allow-fs-read=${f.dataDir}`, `--allow-fs-write=${f.dataDir}`, '--input-type=module', '-e', source], { timeout: 20000 });
  const reply = JSON.parse(stdout); assert.equal(reply.isError, false); assert.equal(reply.details.fileId, 'permission-fixture');
  assert.equal(reply.details.sha256, sha(Buffer.from(f.value.fact.markdown)));
});

const projectRequest = { action: 'result', projectId: PROJECT, factId: FID };
const projectInputs = [
  { action: 'create', problem: '  Original software fixture\r\n', operatorProfile: '  Original operator fixture  ' },
  { action: 'list' }, { action: 'status', projectId: PROJECT },
  { action: 'start', projectId: PROJECT, workerId: 'worker-fixture', timeoutSeconds: 60 },
  { action: 'stop', projectId: PROJECT, workerId: 'worker-fixture' }, { action: 'result', projectId: PROJECT },
];

test('SUBMISSION_CORE_BUSY projects static explicit-retry guidance and only safe Runtime diagnostics', async t => {
  const f = await fixture(t);
  f.controls.serviceError = Object.assign(new Error('PRIVATE source message'), { code: 'SUBMISSION_CORE_BUSY',
    coreError: { code: 'busy', message: '/PRIVATE/core/path' }, context: { callToken: 'PRIVATE token' },
    runtime: { code: 'RESEARCH_RUNTIME_REJECTED', requestId: 'a9ce7831-83e1-45af-8a5f-3fe37dd72af8', operation: 'prepare_submission',
      phase: 'result', startOutcome: 'acknowledged', processTerminalConfirmed: true, indeterminate: false, cleanup: { confirmed: true, errors: [] } } });
  const result = await f.execute('fact_submit', { statement: 'opaque statement', proof: 'opaque proof' });
  assert.equal(result.isError, true); assert.equal(result.details.error.code, 'SUBMISSION_CORE_BUSY');
  assert.match(result.details.error.message, /did not execute in Core and did not register a candidate/);
  assert.match(result.details.error.message, /same worker, if still active, may explicitly retry/);
  assert.match(result.details.error.message, /No automatic replay/);
  assert.equal(result.details.error.runtime.operation, 'prepare_submission'); assert.equal(result.details.error.runtime.cleanup.confirmed, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|coreError|callToken/); assert.equal(f.calls.length, 1);
});

test('math_goal_main forwards the original context without routing and cannot start, resume or replenish budgets', async t => {
  const f = await fixture(t, { nativeProjects: true }), identity = { projectId: PROJECT, goalId: 'goal-fixture', generation: 1 };
  for (const request of [{ action: 'status', projectId: PROJECT }, { action: 'acknowledge', ...identity, controlAt: 0 },
    ...['wait', 'continue_work'].map(action => ({ action, ...identity })), { action: 'pause', projectId: PROJECT },
    { action: 'stop', projectId: PROJECT, force: true }, { action: 'complete', ...identity, factIds: [FID] }]) {
    assert.equal((await f.execute('math_goal_main', request)).isError, false);
    const { action, ...args } = request; assert.deepEqual(f.calls.at(-1).args, args);
    assert.equal(f.calls.at(-1).method, `mainGoal.${action}`); assert.equal(f.calls.at(-1).context, context);
  }
  assert.equal(f.calls.some(call => call.method === 'project.handles'), false);
  const before = f.calls.length;
  for (const request of [{ action: 'start', projectId: PROJECT, authorized: true }, { action: 'resume', projectId: PROJECT },
    { action: 'acknowledge', ...identity }, { action: 'wait', ...identity, generation: 0 }, { action: 'complete', ...identity, factIds: [FID, FID] },
    ...['actor', 'sessionId', 'authorized', 'maxAutomaticContinues'].map(key => ({ action: 'status', projectId: PROJECT, [key]: true }))]) {
    assert.equal((await f.execute('math_goal_main', request)).details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  }
  assert.equal(f.calls.length, before);
  assert.equal(Object.hasOwn(f.tools.get('math_goal'), 'sessionPermission'), false);
  assert.equal(f.tools.get('math_goal_main').sessionPermission.auto, 'allow');
  assert.equal((await fixture(t)).tools.has('math_goal_main'), false);
});

test('math_goal registers strict action shapes and forwards the genuine context without legacy routing', async t => {
  const f = await fixture(t, { nativeProjects: true }), identity = { projectId: PROJECT, goalId: 'goal-fixture', generation: 1 };
  const requests = [{ action: 'start', projectId: PROJECT, authorized: true }, ...['resume', 'status', 'pause', 'stop'].map(action => ({ action, projectId: PROJECT })),
    ...[0, 2, Number.MAX_SAFE_INTEGER].flatMap(maxAutomaticContinues => [
      { action: 'start', projectId: PROJECT, authorized: true, maxAutomaticContinues }, { action: 'resume', projectId: PROJECT, maxAutomaticContinues }]),
    { action: 'stop', projectId: PROJECT, force: true }, { action: 'acknowledge', ...identity, controlAt: 0, auditAt: 1 },
    ...['wait', 'continue_work'].map(action => ({ action, ...identity })), { action: 'complete', ...identity, factIds: [FID] }];
  for (const request of requests) {
    assert.equal((await f.execute('math_goal', request)).isError, false);
    const { action, ...args } = request; assert.deepEqual(f.calls.at(-1).args, args); assert.equal(f.calls.at(-1).method, `goal.${action}`); assert.equal(f.calls.at(-1).context, context);
  }
  assert.equal(f.calls.some(c => c.method === 'project.handles'), false);
  f.controls.replies['goal.status'] = { projectId: PROJECT, managed: true, state: 'blocked', error: 'OPAQUE_ERROR' };
  assert.equal((await f.execute('math_goal', { action: 'status', projectId: PROJECT })).isError, false);
  const before = f.calls.length;
  for (const request of [{ action: 'start', projectId: PROJECT }, { action: 'start', projectId: PROJECT, authorized: false },
    { action: 'resume', ...identity }, { action: 'acknowledge', ...identity }, { action: 'acknowledge', ...identity, controlAt: -1 },
    { action: 'acknowledge', ...identity, auditAt: 1.5 }, { action: 'wait', ...identity, generation: 0 }, { action: 'wait', ...identity, goalId: '../goal' },
    { action: 'wait', ...identity, generation: Number.MAX_SAFE_INTEGER + 1 }, { action: 'stop', projectId: PROJECT, force: 'true' },
    { action: 'complete', ...identity, factIds: [] }, { action: 'complete', ...identity, factIds: [FID, FID] },
    { action: 'complete', ...identity, factIds: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(16, '0')) },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '2', false].flatMap(maxAutomaticContinues => [
      { action: 'start', projectId: PROJECT, authorized: true, maxAutomaticContinues }, { action: 'resume', projectId: PROJECT, maxAutomaticContinues }]),
    ...['status', 'pause', 'stop', 'wait', 'continue_work', 'acknowledge', 'complete'].map(action => ({ action, ...identity, maxAutomaticContinues: 1 })),
    { action: 'status', projectId: 'not-project' }, { action: 'status', projectId: PROJECT, callToken: 'spoof' }, { action: 'finalize', projectId: PROJECT }]) {
    assert.equal((await f.execute('math_goal', request)).isError, true);
  }
  assert.equal(f.calls.length, before);
  const goal = f.tools.get('math_goal'); assert.equal(goal.parameters.additionalProperties, false); assert.equal(goal.parameters.oneOf.length, 9);
  assert.match(goal.description, /existing workers continue/); assert.match(goal.description, /operator authorization/);
  for (const action of ['start', 'resume']) {
    const variant = goal.parameters.oneOf.find(item => item.properties.action.const === action);
    assert.deepEqual(variant.properties.maxAutomaticContinues, { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
    assert.equal(variant.required.includes('maxAutomaticContinues'), false);
  }
  assert.match(goal.description, /reservations, not model calls/); assert.match(goal.description, /Deadline reviews do not consume/);
  assert.match(goal.description, /complete checks fact existence, not target coverage/);
  assert.match(goal.description, /does not perform creator-only math_project finalize/);
  assert.equal((await fixture(t)).tools.has('math_goal'), false);
});

test('D04 only creator Goal start accepts a strict restart authorization in schema and dispatch', async t => {
  const f = await fixture(t, { nativeProjects: true }), schema = f.tools.get('math_goal').parameters;
  const start = schema.oneOf.find(item => item.properties.action.const === 'start');
  assert.deepEqual(start.properties.restartAuthorization, { type: 'object', properties: { resume: { type: 'string', enum: ['none', 'preserve-budget'] } }, required: ['resume'], additionalProperties: false });
  assert.equal(Object.hasOwn(f.tools.get('math_goal_main').parameters.properties, 'restartAuthorization'), false);
  for (const resume of ['none', 'preserve-budget']) {
    assert.equal((await f.execute('math_goal', { action: 'start', projectId: PROJECT, authorized: true, restartAuthorization: { resume } })).isError, false);
    assert.deepEqual(f.calls.at(-1).args.restartAuthorization, { resume });
  }
  const before = f.calls.length;
  for (const restartAuthorization of [null, undefined, {}, { resume: 'auto' }, { resume: 'preserve-budget', extra: true }]) {
    assert.equal((await f.execute('math_goal', { action: 'start', projectId: PROJECT, authorized: true, restartAuthorization })).isError, true);
  }
  for (const action of ['resume', 'status']) assert.equal((await f.execute('math_goal', { action, projectId: PROJECT, restartAuthorization: { resume: 'preserve-budget' } })).isError, true);
  assert.equal((await f.execute('math_goal_main', { action: 'status', projectId: PROJECT, restartAuthorization: { resume: 'preserve-budget' } })).isError, true);
  assert.equal(f.calls.length, before);
});

test('only math_goal wait projects a validated same-epoch pending review and fixed corrective guidance', async t => {
  const f = await fixture(t, { nativeProjects: true }), identity = { projectId: PROJECT, goalId: 'goal-fixture', generation: 1 };
  for (const points of [{ controlAt: 0, auditAt: 1 }, { controlAt: 0, auditAt: null }, { controlAt: null, auditAt: Number.MAX_SAFE_INTEGER }]) {
    const pending = { ...identity, ...points }, cause = Object.assign(new Error('PRIVATE_MESSAGE'), { code: 'MAIN_CONTROL_DUE_UNACKNOWLEDGED', pendingReview: pending });
    for (const key of ['runtime', 'resultCleanup', 'context', 'toJSON']) Object.defineProperty(cause, key, { get() { assert.fail('Private error field read: ' + key); } });
    f.controls.serviceError = cause;
    const response = await f.execute('math_goal', { action: 'wait', ...identity });
    assert.equal(response.isError, true); assert.deepEqual(response.details.error.pendingReview, pending);
    assert.deepEqual(Object.keys(response.details.error).sort(), ['code', 'message', 'pendingReview']);
    assert.match(response.details.error.message, /substantive.*acknowledge/); assert.doesNotMatch(JSON.stringify(response), /PRIVATE|host-token|origin-a|context|stack/);
    assert.deepEqual(resultText(response), response.details);
  }
  f.controls.serviceError = Object.assign(new Error('PRIVATE_MESSAGE'), { code: 'MAIN_CONTROL_DUE_UNACKNOWLEDGED', pendingReview: { ...identity, controlAt: 0, auditAt: null } });
  for (const request of [{ action: 'status', projectId: PROJECT }, { action: 'acknowledge', ...identity, controlAt: 0 }]) {
    assert.equal(Object.hasOwn((await f.execute('math_goal', request)).details.error, 'pendingReview'), false);
  }
  assert.equal(Object.hasOwn((await f.execute('gm_add', valid.gm_add)).details.error, 'pendingReview'), false);
  const before = f.calls.length;
  assert.equal(Object.hasOwn((await f.execute('math_goal', { action: 'wait', ...identity, generation: 0 })).details.error, 'pendingReview'), false);
  assert.equal(f.calls.length, before); assert.match(f.tools.get('math_goal').description, /wait only when no review is pending/);
});

test('pending-review projection rejects malformed values, identity mismatch, accessors and proxies without touching private data', async t => {
  const f = await fixture(t, { nativeProjects: true }), identity = { projectId: PROJECT, goalId: 'goal-fixture', generation: 1 };
  const validPending = { ...identity, controlAt: 0, auditAt: null };
  const getter = { ...validPending }; Object.defineProperty(getter, 'controlAt', { enumerable: true, get() { assert.fail('Untrusted point getter'); } });
  const proxy = new Proxy(validPending, { get() { assert.fail('Untrusted point proxy'); }, getOwnPropertyDescriptor() { assert.fail('Untrusted point descriptor'); } });
  for (const pending of [null, [], {}, { ...validPending, projectId: 'project-other' }, { ...validPending, goalId: 'goal-other' },
    { ...validPending, generation: 2 }, { ...validPending, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...validPending, controlAt: -1 }, { ...validPending, controlAt: 0.5 }, { ...validPending, controlAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...validPending, controlAt: null }, { ...validPending, auditAt: undefined }, { ...validPending, context }, getter, proxy]) {
    const cause = Object.assign(new Error('PRIVATE_ERROR'), { code: 'MAIN_CONTROL_DUE_UNACKNOWLEDGED', pendingReview: pending });
    Object.defineProperty(cause, 'resultCleanup', { get() { assert.fail('Do not read arbitrary error metadata'); } });
    f.controls.serviceError = cause;
    const response = await f.execute('math_goal', { action: 'wait', ...identity });
    assert.equal(response.isError, true); assert.equal(response.details.error.code, 'MAIN_CONTROL_DUE_UNACKNOWLEDGED');
    assert.equal(Object.hasOwn(response.details.error, 'pendingReview'), false); assert.doesNotMatch(JSON.stringify(response), /PRIVATE|host-token|origin-a/);
  }
  const cause = Object.assign(new Error('PRIVATE_ERROR'), { code: 'MAIN_CONTROL_DUE_UNACKNOWLEDGED' });
  Object.defineProperty(cause, 'pendingReview', { get() { assert.fail('Do not execute an error payload getter'); } }); f.controls.serviceError = cause;
  assert.equal(Object.hasOwn((await f.execute('math_goal', { action: 'wait', ...identity })).details.error, 'pendingReview'), false);
});

test('project policy and force schemas opt in explicitly without changing legacy controls', async t => {
  const f = await fixture(t, { nativeProjects: true }), schema = f.tools.get('math_project').parameters;
  const create = schema.oneOf.find(v => v.properties.action.const === 'create'), start = schema.oneOf.find(v => v.properties.action.const === 'start'), stop = schema.oneOf.find(v => v.properties.action.const === 'stop');
  assert.equal(create.required.includes('workerPolicy'), false); assert.deepEqual(create.properties.workerPolicy.required, []);
  assert.equal(create.properties.workerPolicy.additionalProperties, false);
  assert.deepEqual(Object.keys(create.properties.workerPolicy.properties), ['maxRounds', 'roundTimeoutSeconds', 'roundDelaySeconds', 'maxConsecutiveFailures']);
  assert.equal(Object.hasOwn(start.properties, 'workerPolicy'), false); assert.equal(stop.properties.force.type, 'boolean');
  assert.equal(Object.hasOwn(f.tools.get('math_research').parameters.properties, 'workerPolicy'), false);
  assert.equal(Object.hasOwn(f.tools.get('math_research').parameters.properties, 'force'), false);
  for (const workerPolicy of [{}, { maxRounds: 2 }, { maxRounds: 0, roundTimeoutSeconds: 14400, roundDelaySeconds: 0.5, maxConsecutiveFailures: 0 }]) {
    const input = { action: 'create', problem: '  opaque original\r\n', operatorProfile: 'opaque operator\t', workerPolicy };
    assert.equal((await f.execute('math_project', input)).isError, false);
    const { action, ...args } = input; assert.deepEqual(f.calls.at(-1).args, args); assert.equal(f.calls.at(-1).context, context);
  }
  await f.execute('math_project', { action: 'create', problem: 'opaque legacy' });
  assert.equal(Object.hasOwn(f.calls.at(-1).args, 'workerPolicy'), false);
  for (const force of [true, false]) {
    assert.equal((await f.execute('math_project', { action: 'stop', projectId: PROJECT, force })).isError, false);
    assert.deepEqual(f.calls.at(-1).args, { projectId: PROJECT, force }); assert.equal(f.calls.at(-1).context, context);
  }
  assert.match(f.tools.get('math_project').description, /no total timeout/); assert.match(f.tools.get('math_project').description, /round boundary/);
});

test('invalid project policies and per-start overrides are rejected before any service call', async t => {
  const f = await fixture(t, { nativeProjects: true });
  for (const workerPolicy of [null, [], 'research', { maxRounds: -1 }, { maxRounds: 0.5 }, { roundTimeoutSeconds: 0 },
    { roundDelaySeconds: -1 }, { roundTimeoutSeconds: 2147484 }, { maxConsecutiveFailures: -1 }, { unknown: true }]) {
    assert.equal((await f.execute('math_project', { action: 'create', problem: 'opaque', workerPolicy })).isError, true);
  }
  for (const input of [{ action: 'start', projectId: PROJECT, workerPolicy: {} }, { action: 'start', projectId: PROJECT, force: true },
    { action: 'stop', projectId: PROJECT, workerPolicy: {} }, { action: 'stop', projectId: PROJECT, force: 'true' },
    { action: 'create', problem: 'opaque', force: true }, { action: 'create', problem: 'opaque', timeoutSeconds: 14400 }]) {
    assert.equal((await f.execute('math_project', input)).isError, true);
  }
  assert.equal(f.calls.length, 0);
});

test('create.workers is an optional 1..4 integer checked before any service call', async t => {
  const f = await fixture(t, { nativeProjects: true }), schema = f.tools.get('math_project').parameters;
  const create = schema.oneOf.find(v => v.properties.action.const === 'create');
  assert.equal(create.required.includes('workers'), false);
  assert.equal(create.properties.workers.type, 'integer'); assert.equal(create.properties.workers.minimum, 1); assert.equal(create.properties.workers.maximum, 4);
  // Named plans are service-only preparation in this slice, not a public API.
  for (const workers of [0, 5, 1.5, -1, '2', null, true, { worker1: 2, worker2: 2 }]) {
    assert.equal((await f.execute('math_project', { action: 'create', problem: 'opaque', workers })).isError, true);
  }
  assert.equal(f.calls.length, 0);
  for (const workers of [1, 4]) {
    assert.equal((await f.execute('math_project', { action: 'create', problem: 'opaque', workers })).isError, false);
    assert.deepEqual(f.calls.at(-1).args, { problem: 'opaque', workers });
  }
  for (const action of ['start', 'stop']) assert.equal((await f.execute('math_project', { action, projectId: PROJECT, workers: 2 })).isError, true);
  assert.match(f.tools.get('math_project').description, /multi-worker start requires workerId/);
  assert.match(f.tools.get('math_assign').description, /PROJECT_WORKER_REQUIRED/);
});

test('optional projects register English strict tools without changing the legacy schema', async (t) => {
  const f = await fixture(t, { nativeProjects: true });
  assert.deepEqual([...f.tools.keys()], [...names, 'math_project', 'math_goal', 'math_goal_main']);
  const project = f.tools.get('math_project');
  assert.equal(project.execute.length, 1); assert.equal(project.parameters.additionalProperties, false);
  assert.deepEqual(project.parameters.properties.action.enum, ['operator_read', 'operator_save', 'ipc_usage', 'paper_stitch', 'paper_section', 'paper_section_status', 'paper_section_result', 'paper_section_stop', 'paper_plan', 'paper_plan_status', 'paper_plan_result', 'paper_plan_stop', 'paper_revise', 'paper_revision_status', 'paper_revision_result', 'paper_revision_stop', 'create', 'list', 'status', 'start', 'stop', 'result', 'graph', 'dashboard_snapshot', 'dashboard_overview', 'dashboard_follow', 'dashboard_unfollow', 'worker_models', 'doctor', 'recheck', 'verification_reads', 'finalize', 'summary', 'summary_status', 'summary_result', 'summary_stop', 'paper_subgraph', 'paper', 'paper_status', 'paper_result', 'paper_stop', 'paper_audit', 'paper_audit_status', 'paper_audit_result', 'paper_audit_stop', 'paper_verify', 'paper_verify_status', 'paper_verify_result', 'paper_verify_stop', 'paper_verify_math', 'paper_verify_math_status', 'paper_verify_math_result', 'paper_verify_math_stop', 'paper_compile', 'paper_deliver', 'paper_chapter_tree_stitch']);
  for (const variant of project.parameters.oneOf) assert.equal(variant.additionalProperties, false);
  assert.deepEqual(project.parameters.oneOf.find((s) => s.properties.action.const === 'create').required, ['action', 'problem']);
  assert.deepEqual(project.parameters.oneOf.find((s) => s.properties.action.const === 'list').required, ['action']);
  for (const action of ['status', 'start', 'stop', 'result']) {
    assert.deepEqual(project.parameters.oneOf.find((s) => s.properties.action.const === action).required, ['action', 'projectId']);
  }
  assert.deepEqual(f.tools.get('math_assign').parameters.required, ['task']);
  assert.ok(f.tools.get('math_assign').parameters.properties.workerId);
  for (const tool of f.tools.values()) assert.doesNotMatch(JSON.stringify({ description: tool.description, parameters: tool.parameters }), /\p{Script=Han}/u);
  const legacy = await fixture(t);
  assert.deepEqual(f.tools.get('math_research').parameters, legacy.tools.get('math_research').parameters);
  assert.deepEqual(legacy.tools.get('math_assign').parameters.required, ['task']);
  assert.equal(Object.hasOwn(legacy.tools.get('math_assign').parameters.properties, 'workerId'), false);
  assert.equal((await legacy.execute('math_assign', { task: 'fixture', workerId: 'worker-fixture' })).isError, true);
  await f.registration.dispose(); assert.deepEqual(f.removed, [...names, 'math_project', 'math_goal', 'math_goal_main']);
});

test('project worker root labels: math_assign advertises an optional project-only displayTitle', async t => {
  const project = (await fixture(t, { nativeProjects: true })).tools.get('math_assign').parameters;
  const legacyFixture = await fixture(t), legacy = legacyFixture.tools.get('math_assign').parameters;
  assert.deepEqual(project.required, ['task']); assert.equal(project.additionalProperties, false);
  assert.equal(project.properties.displayTitle?.type, 'string');
  assert.deepEqual(legacy.required, ['task']); assert.equal(Object.hasOwn(legacy.properties, 'displayTitle'), false);
  assert.equal((await legacyFixture.execute('math_assign', { task: 'Opaque instruction', displayTitle: 'Public title' })).isError, true);
  assert.deepEqual(legacyFixture.calls, []);
});

test('recheck strictly requires three explicit IDs, declares Host mutations and forwards the genuine context', async t => {
  const f = await fixture(t, { nativeProjects: true }), args = { projectId: PROJECT, workerId: 'worker-1', runId: RUN };
  const tool = f.tools.get('math_project'), variant = tool.parameters.oneOf.find(v => v.properties.action.const === 'recheck');
  assert.deepEqual(variant.required, ['action', 'projectId', 'workerId', 'runId']); assert.equal(variant.additionalProperties, false);
  assert.match(tool.description, /Creator only: recheck/); assert.match(tool.description, /may remove schedules, abort sessions, fail tasks/);
  assert.equal(tool.autoAllow, undefined);
  for (const key of Object.keys(args)) {
    const input = { action: 'recheck', ...args }; delete input[key];
    assert.equal((await f.execute('math_project', input)).isError, true);
    for (const value of [null, 1, '', '../escape']) assert.equal((await f.execute('math_project', { action: 'recheck', ...args, [key]: value })).isError, true);
  }
  for (const key of ['all', 'force', 'timeoutSeconds', 'sessionPath', 'callToken', 'guard', 'role', 'readOnly', 'worker'])
    assert.equal((await f.execute('math_project', { action: 'recheck', ...args, [key]: true })).isError, true);
  assert.equal(f.calls.length, 0);
  const reply = await f.execute('math_project', { action: 'recheck', ...args });
  assert.equal(reply.isError, false); assert.equal(reply.details.code, 'RECHECK_NOT_NEEDED');
  assert.deepEqual(f.calls, [{ method: 'project.recheck', args, context }]); assert.equal(f.stages.length, 0);
});

test('verification_reads is an explicit read-only dispatch, unavailable coverage is not a tool error', async t => {
  const f = await fixture(t, { nativeProjects: true }), args = { projectId: PROJECT, runId: RUN, submissionId: 'submission-fixture' };
  const variant = f.tools.get('math_project').parameters.oneOf.find(v => v.properties.action.const === 'verification_reads');
  assert.deepEqual(variant.required, ['action', 'projectId', 'runId', 'submissionId']); assert.equal(variant.additionalProperties, false);
  const reply = await f.execute('math_project', { action: 'verification_reads', ...args });
  assert.equal(reply.isError, false); assert.equal(reply.details.coverage, 'unavailable');
  assert.deepEqual(f.calls, [{ method: 'project.verification_reads', args, context }]); assert.equal(f.stages.length, 0);
  f.controls.serviceError = Object.assign(new Error('opaque permission'), { code: 'PROJECT_OWNER_DENIED' });
  const denied = await f.execute('math_project', { action: 'verification_reads', ...args }); assert.equal(denied.isError, true); assert.equal(denied.details.error.code, 'PROJECT_OWNER_DENIED');
});
test('verification_reads requires all three IDs and refuses caller identity/locator selectors before dispatch', async t => {
  const f = await fixture(t, { nativeProjects: true }), input = { action: 'verification_reads', projectId: PROJECT, runId: RUN, submissionId: 'submission-fixture' };
  for (const key of ['projectId', 'runId', 'submissionId']) {
    const missing = { ...input }; delete missing[key]; assert.equal((await f.execute('math_project', missing)).isError, true);
    assert.equal((await f.execute('math_project', { ...input, [key]: '../escape' })).isError, true);
  }
  for (const key of ['sessionId', 'sessionPath', 'path', 'scope', 'role', 'author', 'workerId', 'agentId', 'factId', 'readOnly', 'budget']) assert.equal((await f.execute('math_project', { ...input, [key]: 'spoof' })).isError, true);
  assert.equal(f.calls.length, 0); assert.equal(f.stages.length, 0);
});

test('project actions forward original bytes and the exact Host context without inferred IDs/defaults', async (t) => {
  const f = await fixture(t, { nativeProjects: true });
  for (const input of projectInputs) {
    assert.equal((await f.execute('math_project', input)).isError, false);
    const call = f.calls.at(-1), { action, ...args } = input;
    assert.equal(call.method, `project.${action}`); assert.deepEqual(call.args, args); assert.equal(call.context, context);
  }
  for (const action of ['start', 'stop']) {
    assert.equal((await f.execute('math_project', { action, projectId: PROJECT })).isError, false);
    assert.deepEqual(f.calls.at(-1).args, { projectId: PROJECT });
  }
  assert.equal(f.calls.some((call) => call.method === 'project.handles'), false);
  assert.equal(f.stages.length, 0);
});

test('M04 doctor has an exact readonly action schema and keeps coded diagnostic failures as query results', async t => {
  const f = await fixture(t, { nativeProjects: true }), tool = f.tools.get('math_project');
  const variant = tool.parameters.oneOf.find(row => row.properties.action.const === 'doctor');
  assert.deepEqual(variant.required, ['action', 'projectId']); assert.equal(variant.additionalProperties, false);
  assert.deepEqual(Object.keys(variant.properties).sort(), ['action', 'projectId']);
  assert.match(tool.description, /doctor reads loaded project\/Goal\/run\/Core diagnostics/);
  const calls = [];
  f.projects.doctor = async (args, ctx) => { calls.push({ args, ctx }); return { projectId: args.projectId, state: 'invalid', error: { code: 'PROJECT_RECORD_INVALID' } }; };
  const result = await f.execute('math_project', { action: 'doctor', projectId: PROJECT });
  assert.equal(result.isError, false); assert.equal(result.details.error.code, 'PROJECT_RECORD_INVALID');
  assert.deepEqual(calls, [{ args: { projectId: PROJECT }, ctx: context }]);
  for (const extra of [{ action: 'doctor' }, { action: 'doctor', projectId: '../escape' },
    ...['role', 'actor', 'sessionId', 'runId', 'callToken', 'force', 'offset', 'recover'].map(key => ({ action: 'doctor', projectId: PROJECT, [key]: 'spoof' }))]) {
    assert.equal((await f.execute('math_project', extra)).isError, true);
  }
  assert.equal(calls.length, 1);
});

test('worker_models schema, normalization and routing preserve pagination and reject cross-action offsets', async t => {
  const f = await fixture(t, { nativeProjects: true });
  const tool = f.tools.get('math_project'), variant = tool.parameters.oneOf.find(row => row.properties.action.const === 'worker_models');
  assert.deepEqual(variant.required, ['action', 'projectId']); assert.equal(variant.properties.offset.minimum, 0);
  assert.equal(variant.properties.limit.maximum, 64); assert.equal(variant.additionalProperties, false);
  assert.equal((await f.execute('math_project', { action: 'worker_models', projectId: PROJECT })).isError, true);
  f.projects.workerModels = async (args, ctx) => { f.calls.push({ method: 'project.worker_models', args, context: ctx }); return { projectId: args.projectId, models: [], catalogTiming: 'current-read' }; };
  assert.equal((await f.execute('math_project', { action: 'worker_models', projectId: PROJECT, offset: 32, limit: 64 })).isError, false);
  assert.deepEqual(f.calls.at(-1), { method: 'project.worker_models', args: { projectId: PROJECT, offset: 32, limit: 64 }, context });
  for (const input of [{ action: 'worker_models', projectId: PROJECT, offset: -1 }, { action: 'worker_models', projectId: PROJECT, offset: 0.5 },
    { action: 'worker_models', projectId: PROJECT, limit: 65 }, { action: 'worker_models', offset: 0 },
    { action: 'result', projectId: PROJECT, offset: 0 }, { action: 'start', projectId: PROJECT, offset: 0 }]) {
    const count = f.calls.length; assert.equal((await f.execute('math_project', input)).isError, true); assert.equal(f.calls.length, count);
  }
});

test('project dispatch is exposed only to start and bound project assignment; legacy stays task-only', async t => {
  const f = await fixture(t, { nativeProjects: true }), model = { provider: 'p', id: 'one' };
  assert.equal((await f.execute('math_project', { action: 'start', projectId: PROJECT, model, thinkingLevel: 'high' })).isError, false);
  assert.deepEqual(f.calls.at(-1).args, { projectId: PROJECT, model, thinkingLevel: 'high' });
  assert.equal((await f.execute('math_assign', { task: 'dispatch', model, thinkingLevel: 'high' })).isError, false);
  assert.deepEqual(f.calls.at(-1).args, { task: 'dispatch', model, thinkingLevel: 'high' });
  for (const input of [{ action: 'status', projectId: PROJECT, model }, { action: 'create', problem: 'bad', thinkingLevel: 'high' },
    { action: 'start', projectId: PROJECT, model, verifierModel: model }, { action: 'start', projectId: PROJECT, thinkingLevel: null },
    { action: 'start', projectId: PROJECT, thinkingLevel: 'auto' }, { action: 'start', projectId: PROJECT, thinkingLevel: ' '.repeat(4) }]) {
    const before = f.calls.length;
    assert.equal((await f.execute('math_project', input)).isError, true);
    assert.equal(f.calls.length, before);
  }
  f.controls.handled = false;
  assert.equal((await f.execute('math_assign', { task: 'legacy', model })).isError, true);
  assert.equal(f.calls.at(-1).method, 'project.handles');
  const legacy = await fixture(t);
  assert.equal((await legacy.execute('math_assign', { task: 'legacy', thinkingLevel: 'high' })).isError, true);
  assert.equal(legacy.calls.length, 0);
});

test('project controls reject unknown, identity and cross-action fields before routing', async (t) => {
  const f = await fixture(t, { nativeProjects: true });
  for (const input of projectInputs) for (const name of ['role', 'author', 'agentId', 'model', 'session', 'sessionId', 'sessionPath', 'cwd', 'callToken', 'scope', 'runId', 'unknown']) {
    assert.equal((await f.execute('math_project', { ...input, [name]: 'spoof' })).isError, true, `${input.action}.${name}`);
  }
  for (const input of [
    { action: 'create', problem: 'fixture', projectId: PROJECT }, { action: 'create', problem: 'fixture', timeoutSeconds: 60 },
    { action: 'create', problem: 'fixture', workerTask: 'fixture' }, { action: 'list', projectId: PROJECT },
    { action: 'status', projectId: PROJECT, workerId: 'worker-fixture' }, { action: 'stop', projectId: PROJECT, timeoutSeconds: 60 },
    { action: 'start', projectId: PROJECT, timeoutSeconds: 59 }, { action: 'start', projectId: PROJECT, timeoutSeconds: 901 },
    { action: 'start', projectId: PROJECT, timeoutSeconds: 60.5 }, { action: 'start', projectId: PROJECT, workerId: '../worker' },
    { action: 'result', projectId: PROJECT, factId: 'not-a-fact' }, { action: 'result', projectId: PROJECT, workerId: 'worker-fixture' },
    { action: ['list'] }, { action: '__proto__' }, { action: 'finalize' },
    ...['status', 'start', 'stop', 'result'].map((action) => ({ action })),
    { action: 'create', problem: 'x'.repeat(128 * 1024 + 1) },
  ]) assert.equal((await f.execute('math_project', input)).isError, true);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.execute('math_project', { action: 'start', projectId: PROJECT, timeoutSeconds: 900 })).isError, false);
});

test('async handles routes only assignment and the original five main tools; every business call is forwarded', async (t) => {
  const f = await fixture(t, { nativeProjects: true }), gate = deferred(); t.after(() => gate.resolve());
  f.controls.routeGate = gate.promise;
  const assignment = { task: '  Original assignment\r\n', workerId: 'worker-fixture' };
  const pending = f.execute('math_assign', assignment);
  await until(() => f.calls.length === 1); assert.equal(f.calls[0].method, 'project.handles');
  gate.resolve(); assert.equal((await pending).isError, false);
  assert.equal(f.calls[1].method, 'project.assign'); assert.deepEqual(f.calls[1].args, assignment); assert.equal(f.calls[1].context, context);
  for (const name of ['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems']) {
    const before = f.calls.length; assert.equal((await f.execute(name, valid[name])).isError, false);
    assert.deepEqual(f.calls.slice(before).map((call) => call.method), ['project.handles', `project.${name}`]);
    assert.deepEqual(f.calls.at(-1).args, valid[name]); assert.equal(f.calls.at(-1).context, context);
  }
  for (const name of ['fact_submit', 'math_local_memory', 'math_verification_report']) {
    const before = f.calls.length; assert.equal((await f.execute(name, valid[name])).isError, false);
    assert.deepEqual(f.calls.slice(before).map((call) => call.method), [name]);
  }
});

test('an unhandled context retains legacy invocation, but cannot inject native workerId into it', async (t) => {
  const f = await fixture(t, { nativeProjects: true }); f.controls.handled = false;
  for (const name of ['math_assign', 'gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems']) {
    const before = f.calls.length; assert.equal((await f.execute(name, valid[name])).isError, false);
    assert.deepEqual(f.calls.slice(before).map((call) => call.method), ['project.handles', name]);
  }
  const before = f.calls.length;
  assert.equal((await f.execute('math_assign', { task: 'fixture', workerId: 'worker-fixture' })).isError, true);
  assert.deepEqual(f.calls.slice(before).map((call) => call.method), ['project.handles']);
});

test('unknown route and native authorization failures never fall back to legacy', async (t) => {
  const f = await fixture(t, { nativeProjects: true });
  for (const handled of [null, undefined, {}, 'true', 1]) {
    f.controls.handled = handled; const before = f.calls.length;
    const response = await f.execute('fact_search', valid.fact_search);
    assert.equal(response.details.error.code, 'PROJECT_ROUTE_INVALID');
    assert.deepEqual(f.calls.slice(before).map((call) => call.method), ['project.handles']);
  }
  f.controls.handled = true; f.controls.routeError = Object.assign(new Error('fixture route failure'), { code: 'PROJECT_AUTHORITY_UNAVAILABLE' });
  assert.equal((await f.execute('fact_search', valid.fact_search)).details.error.code, 'PROJECT_AUTHORITY_UNAVAILABLE');
  delete f.controls.routeError; f.controls.serviceError = Object.assign(new Error('fixture denial'), { code: 'PROJECT_AUTHORITY_DENIED' });
  for (const name of ['math_assign', 'fact_search']) {
    const before = f.calls.length; const response = await f.execute(name, valid[name]);
    assert.equal(response.details.error.code, 'PROJECT_AUTHORITY_DENIED');
    assert.deepEqual(f.calls.slice(before).map((call) => call.method), ['project.handles', name === 'math_assign' ? 'project.assign' : 'project.fact_search']);
  }
});

test('foreign/worker/verifier fixture denials pass through without legacy bypass; not a service security proof', async (t) => {
  const f = await fixture(t, { nativeProjects: true });
  f.controls.handled = false;
  f.controls.serviceError = Object.assign(new Error('fixture authorization denial'), { code: 'PROJECT_AUTHORITY_DENIED' });
  for (const label of ['foreign', 'worker', 'verifier']) {
    const ctx = { sessionPath: `/fixture/${label}.jsonl`, callToken: `opaque-${label}` };
    for (const input of projectInputs) {
      const before = f.calls.length; const response = await f.execute('math_project', input, ctx);
      assert.equal(response.isError, true); assert.equal(response.details.error.code, 'PROJECT_AUTHORITY_DENIED');
      assert.deepEqual(f.calls.slice(before).map((call) => call.method), [`project.${input.action}`]);
      assert.equal(f.calls.at(-1).context, ctx);
    }
  }
});

test('failed project status remains a successful query, never a restart or automatic recovery', async (t) => {
  const f = await fixture(t, { nativeProjects: true });
  f.controls.replies['project.status'] = { projectId: PROJECT, state: 'failed', indeterminate: true, error: { code: 'MAIN_UNCONFIRMED' } };
  const response = await f.execute('math_project', { action: 'status', projectId: PROJECT });
  assert.equal(response.isError, false); assert.deepEqual(response.details, f.controls.replies['project.status']);
  assert.deepEqual(f.calls.map((call) => call.method), ['project.status']);
});

test('project proof export needs no runId, preserves full canonical bytes and isolates legacy delivery caches', async (t) => {
  const f = await fixture(t, { nativeProjects: true }); f.projectValue.fact.markdown = markdown('Opaque fixture proof 字\r\n'.repeat(4000));
  const response = await f.execute('math_project', projectRequest);
  assert.equal(response.isError, false); assert.equal(response.details.fullTextInFile, true);
  assert.equal(Object.hasOwn(response.details, 'runId'), false); assert.equal(Object.hasOwn(response.details.fact, 'markdown'), false);
  assert.deepEqual(f.stages[0].bytes, Buffer.from(f.projectValue.fact.markdown));
  assert.equal(response.details.sha256, sha(f.stages[0].bytes)); assert.equal(response.details.bytes, f.stages[0].bytes.length);
  assert.ok(f.stages[0].input.path.startsWith(path.join(f.dataDir, 'research/project-exports', PROJECT) + path.sep));
  assert.equal((await fs.stat(f.stages[0].input.path)).mode & 0o777, 0o600);
  assert.equal((await f.execute('math_project', projectRequest)).details.fileId, response.details.fileId);
  assert.equal(f.stages.length, 1); assert.equal(f.calls.filter((call) => call.method === 'project.result').length, 2);
  assert.equal((await f.execute('math_research', request)).isError, false);
  assert.equal(f.stages.length, 2); assert.notEqual(f.stages[0].input.path, f.stages[1].input.path);
  assert.deepEqual(f.stages[0].bytes, f.stages[1].bytes);
  assert.equal((await f.execute('math_project', projectRequest, other)).details.resource.sessionId, 'session-b');
  assert.equal(f.stages.length, 3);
  f.controls.serviceError = Object.assign(new Error('fixture revocation'), { code: 'PROJECT_AUTHORITY_DENIED' });
  assert.equal((await f.execute('math_project', projectRequest)).isError, true); assert.equal(f.stages.length, 3);
});

test('project result lists without staging and rejects mismatched IDs, fake runId and invalid canonical headers', async (t) => {
  const f = await fixture(t, { nativeProjects: true });
  assert.equal((await f.execute('math_project', { action: 'result', projectId: PROJECT })).isError, false);
  f.controls.replies['project.result'] = { projectId: PROJECT, ...fixtureFactPage([], {}, PROJECT) };
  assert.equal((await f.execute('math_project', { action: 'result', projectId: PROJECT })).isError, false);
  for (const value of [
    { ...f.projectValue, projectId: 'other-project' }, { ...f.projectValue, runId: RUN }, { ...f.projectValue, projectId: null },
    { ...f.projectValue, fact: { ...f.projectValue.fact, fact_id: PRED } },
    { ...f.projectValue, fact: { ...f.projectValue.fact, markdown: 'Not canonical' } },
    { ...f.projectValue, fact: { ...f.projectValue.fact, predecessors: [] } },
  ]) {
    f.controls.replies['project.result'] = value;
    assert.equal((await f.execute('math_project', projectRequest)).isError, true);
  }
  assert.equal(f.stages.length, 0);
});

test('project attachment failure has project identity only and preserves complete proof for explicit retry', async (t) => {
  const f = await fixture(t, { nativeProjects: true }), original = structuredClone(f.projectValue);
  f.controls.stageError = new AppSdkError({ code: 'APP_CAPABILITY_DENIED', kind: 'permission', capability: 'app/session.stage-file', operation: 'resources.stage', message: 'PRIVATE_DETAIL' });
  const response = await f.execute('math_project', projectRequest);
  assert.equal(response.isError, true); assert.equal(response.details.factUnchanged, true);
  assert.equal(response.details.projectId, PROJECT); assert.equal(Object.hasOwn(response.details, 'runId'), false);
  assert.equal(response.details.error.requiredCapability, 'app/session.stage-file');
  assert.deepEqual(f.stages[0].bytes, Buffer.from(original.fact.markdown)); assert.deepEqual(f.projectValue, original);
  f.controls.stageError = null;
  assert.equal((await f.execute('math_project', projectRequest)).isError, false); assert.equal(f.stages.length, 2);
  assert.equal(f.stages[0].input.path, f.stages[1].input.path);
});

test('partial registration failure removes only its own installed handles and never owns service lifetime', async (t) => {
  const f = await fixture(t); const installed = [], removed = [];
  const sdk = { ...f.sdk, tools: { async register(tool) { if (installed.length === 3) throw new Error('registration fixture'); installed.push(tool.name); return () => removed.push(tool.name); } } };
  await assert.rejects(registerMathResearch(sdk, f.service), /registration fixture/); assert.deepEqual(removed, installed);
  assert.equal(f.calls.length, 0);
});

test('summary is an explicit creator dispatch with projectId and optional language only', async t => {
  const f = await fixture(t, { nativeProjects: true });
  const variant = f.tools.get('math_project').parameters.oneOf.find(v => v.properties.action.const === 'summary');
  assert.deepEqual(variant.required, ['action', 'projectId']); assert.equal(variant.additionalProperties, false);
  assert.deepEqual(Object.keys(variant.properties).sort(), ['action', 'language', 'projectId']);
  assert.match(f.tools.get('math_project').description, /summary is creator-only/);
  assert.match(f.tools.get('math_project').description, /summary_status, summary_result, and summary_stop/);
  assert.match(f.tools.get('math_project').description, /same asOf/);
  for (const input of [{ action: 'summary', projectId: PROJECT }, { action: 'summary', projectId: PROJECT, language: 'Simplified Chinese' }]) {
    const reply = await f.execute('math_project', input); assert.equal(reply.isError, false);
    const { action, ...args } = input; assert.deepEqual(f.calls.at(-1), { method: 'project.summary', args, context });
  }
  const before = f.calls.length;
  for (const input of [{ action: 'summary' }, { action: 'summary', projectId: '../x' }, { action: 'summary', projectId: PROJECT, language: '' },
    { action: 'summary', projectId: PROJECT, language: 'x'.repeat(65) }, { action: 'summary', projectId: PROJECT, language: 'Eng1ish' },
    { action: 'summary', projectId: PROJECT, paperId: 'main' }, { action: 'summary', projectId: PROJECT, factIds: ['a'.repeat(16)] },
    { action: 'finalize', projectId: PROJECT, language: 'English' }]) assert.equal((await f.execute('math_project', input)).isError, true, JSON.stringify(input));
  assert.equal(f.calls.length, before);
});

test('B2 section actions have exact schemas, preserve creator context and reject untrusted selector data', async t => {
  const f = await fixture(t, { nativeProjects: true }), tool = f.tools.get('math_project'), reportId = 'report-01234567-89ab-cdef-0123-456789abcdef';
  assert.match(tool.description, /^Manage projects/); assert.match(tool.description, /no_next_section/); assert.match(tool.description, /not certify/);
  for (const [action, method] of [['paper_section', 'paperSection'], ['paper_section_status', 'paperSectionStatus'], ['paper_section_result', 'paperSectionResult'], ['paper_section_stop', 'paperSectionStop']]) {
    const variant = tool.parameters.oneOf.find(v => v.properties.action.const === action);
    assert.ok(tool.parameters.properties.action.enum.includes(action)); assert.equal(variant.additionalProperties, false);
    assert.deepEqual(variant.required, ['action', 'projectId', action === 'paper_section' ? 'planReportId' : 'reportId']);
    assert.deepEqual(Object.keys(variant.properties).sort(), (action === 'paper_section' ? ['action', 'projectId', 'planReportId', 'previousSectionReportId'] : ['action', 'projectId', 'reportId']).sort());
    const args = { projectId: PROJECT, [action === 'paper_section' ? 'planReportId' : 'reportId']: reportId };
    f.projects[method] = async (received, ctx) => { f.calls.push({ method, args: received, context: ctx }); return { state: 'fixture' }; };
    assert.equal((await f.execute('math_project', { action, ...args })).isError, false); assert.deepEqual(f.calls.at(-1), { method, args, context });
    if (action === 'paper_section') { assert.equal((await f.execute('math_project', { action, ...args, previousSectionReportId: reportId })).isError, false); assert.equal(f.calls.at(-1).args.previousSectionReportId, reportId); }
    const before = f.calls.length;
    for (const extra of [{ model: {} }, { path: '/caller' }, { resources: {} }, { prompt: 'caller' }, { binding: {} }, { language: 'English' }, { previousSectionReportId: null }, { planReportId: '../bad' }]) assert.equal((await f.execute('math_project', { action, ...args, ...extra })).isError, true);
    assert.equal(f.calls.length, before);
  }
  let gets = 0; const raw = { action: 'paper_section', projectId: PROJECT, context }; Object.defineProperty(raw, 'planReportId', { enumerable: true, get() { gets++; return reportId; } });
  assert.equal((await tool.execute(raw)).isError, true); assert.equal(gets, 0);
});
