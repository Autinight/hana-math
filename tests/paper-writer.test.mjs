import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSummaryWriter } from '../packages/hana-math/report-writer.mjs';
import { createResearchSessions } from '../packages/hana-math/research-sessions.mjs';

const identity = 'Write a human-facing mathematical progress report using only the problem and results embedded in this request. Do not use tools, memory or outside sources.';
const contract = `${identity}\n\nYou are a report author, not a proof-verdict service. Follow the embedded REPORT_WRITER_PROMPT.md. Write Markdown prose, never a verification JSON object. Preserve the hypotheses and limitations of each supplied result. Never invent evidence, internal identifiers or research history. Mathematics is text-only; execute no computation.\n`;
const hash = value => createHash('sha256').update(value).digest('hex');
const model = { provider: 'saved-provider', id: 'saved-verifier-model' };
const input = { projectId: 'project-p', reportId: 'report-r', prompt: 'Separately embedded original role/style documents and verified material.',
  cwd: '/fixture', deadlineAt: Date.now() + 60000, onBound: async () => ({ ok: true }), assertActive() {} };
const paper = { ...input, kind: 'paper-source' };
const audit = { ...input, kind: 'reference-audit' };
const verification = { ...input, kind: 'reference-verification' };
const revision = { ...input, kind: 'paper-revision' };
const referenceTools = ['web_search', 'web_fetch'];
async function fixture(t, initialConfig = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paper-writer-test-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls = [], starts = [], agents = new Map(), configs = new Map(), handles = [];
  const sdk = { dataDir, agents: {
    async create(value) {
      calls.push(['create', structuredClone(value)]);
      agents.set(value.id, { id: value.id, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private',
        plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: value.kind } });
      configs.set(value.id, structuredClone(initialConfig));
      return { agent: { id: value.id, ownerPluginId: 'hana-math', visibility: 'plugin_private' } };
    },
    async list(value) { calls.push(['list', value]); return { agents: [...agents.values()] }; },
    async config(value) { calls.push(['config', structuredClone(value)]); return { config: configs.get(value.agentId) }; },
    async updateConfig(value) {
      calls.push(['updateConfig', structuredClone(value)]);
      Object.assign(configs.get(value.agentId), value.partial);
      return { config: configs.get(value.agentId) };
    },
  } };
  const profiles = { async getRoleModel(role) { calls.push(['model', role]); return { role, source: 'saved-role', instanceState: 'active', agentId: 'saved-verifier', model }; } };
  const sessions = {
    start(value) {
      calls.push(['start']); starts.push(value);
      let finish;
      const handle = { done: new Promise(resolve => { finish = resolve; }), stops: 0,
        async stop() { this.stops++; finish({ cleanupPending: false }); return { cleanupPending: false }; } };
      handles.push(handle); return handle;
    },
    async dispose() { calls.push(['dispose']); return { cleanupPending: false, errors: [] }; },
  };
  const writer = createSummaryWriter({ sdk, profiles, sessions });
  t.after(() => writer.dispose());
  return { dataDir, sdk, profiles, sessions, writer, calls, starts, handles, agents, configs };
}
const created = fixture => fixture.calls.filter(([op]) => op === 'create').map(([, value]) => value);
const registry = (fixture, name) => fs.readFile(path.join(fixture.dataDir, 'report-writer', name), 'utf8').then(JSON.parse);

test('M05 integration planner has an isolated durable registry and no new runtime role, config, memory or tools', async t => {
  const f = await fixture(t, { tool_call_mode: 'full' });
  for (const request of [input, paper, revision, { ...revision, revisionMode: 'operator-notes' }]) await f.writer.start(request);
  const names = ['registry.json', 'paper-source-registry.json', 'paper-revision-registry.json', 'paper-notes-revision-registry.json'];
  const before = await Promise.all(names.map(name => fs.readFile(path.join(f.dataDir, 'report-writer', name))));
  const request = { ...input, kind: 'paper-plan' }; await Promise.all([f.writer.start(request), f.writer.start(request)]);
  const agent = created(f).find(row => row.id.startsWith('math-paper-planner-')); assert.ok(agent);
  assert.equal(agent.kind, 'math-report-writer'); assert.equal(agent.memoryPolicy.enabled, false); assert.match(agent.initialFiles.identity, /phase-1 section-plan preview/);
  const state = await registry(f, 'paper-plan-registry.json'); assert.equal(state.state, 'created'); assert.equal(state.id, agent.id); assert.equal(state.contractHash, hash(agent.initialFiles.agents));
  for (const start of f.starts.slice(-2)) { assert.equal(start.role, 'report-writer'); assert.equal(start.kind, 'math-paper-plan:project-p:report-r');
    assert.equal(start.toolless, true); assert.deepEqual(start.toolNames, []); assert.deepEqual(start.selection, { agentId: agent.id, model }); }
  assert.equal(f.calls.some(([op]) => op === 'config' || op === 'updateConfig'), false);
  assert.ok(f.calls.filter(([op]) => op === 'model').every(([, role]) => role === 'verifier'));
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(f.dataDir, 'report-writer', name)))), before);
  const reopened = createSummaryWriter(f); t.after(() => reopened.dispose()); await reopened.start(request); assert.equal(created(f).length, 5); assert.equal(f.starts.at(-1).selection.agentId, agent.id);
});
test('M05 integration C1 readonly failure proof is writer-private, identity-bound, unforgeable and absent on legacy kinds', async t => {
  for (const phase of ['active', 'lookup', 'validation']) await t.test(phase, async t => {
    const f = await fixture(t), original = Object.assign(new Error('Host-shaped failure'), { code: 'SAVED_ROLE_INVALID', noResourcesCreated: true });
    const filename = path.join(f.dataDir, 'report-writer/paper-plan-registry.json'), bytes = '{"schemaVersion":1,"state":"creating","opaque":"must stay unchanged"}';
    await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, bytes);
    f.profiles.getRoleModel = async () => { if (phase === 'lookup') throw original; return { role: 'verifier', source: 'not-saved' }; };
    const request = { ...input, kind: 'paper-plan', assertActive() { if (phase === 'active') throw original; } }; let caught;
    await assert.rejects(f.writer.start(request), error => { caught = error; return error.code === 'SAVED_ROLE_INVALID'; });
    const identity = { projectId: input.projectId, reportId: input.reportId };
    assert.notStrictEqual(caught, original); assert.equal(f.writer.planPreparationFailedBeforeCreation(caught, identity), true);
    assert.equal(f.writer.planPreparationFailedBeforeCreation(caught, { ...identity, projectId: 'other-project' }), false);
    assert.equal(f.writer.planPreparationFailedBeforeCreation(caught, { ...identity, reportId: 'other-report' }), false);
    assert.equal(f.writer.planPreparationFailedBeforeCreation(original, identity), false);
    assert.equal(f.writer.planPreparationFailedBeforeCreation({ code: caught.code, ...identity, noResourcesCreated: true }, identity), false);
    const reopened = createSummaryWriter(f); t.after(() => reopened.dispose()); assert.equal(reopened.planPreparationFailedBeforeCreation(caught, identity), false);
    await assert.rejects(f.writer.start({ ...input, assertActive() { throw original; } }), error => error === original);
    assert.equal(f.writer.planPreparationFailedBeforeCreation(original, identity), false);
    assert.equal(created(f).length, 0); assert.equal(f.starts.length, 0); assert.equal(await fs.readFile(filename, 'utf8'), bytes);
  });
});

test('M05 integration review synthetic synchronous post-start cancellation self-stops but caller receives no handle or receipt', async t => {
  const f = await fixture(t); let active = true, starts = 0, stops = 0;
  f.sessions.start = () => { starts++; active = false; return { done: Promise.resolve({ cleanupPending: false }), async stop() { stops++; return { cleanupPending: false }; } }; };
  await assert.rejects(f.writer.start({ ...input, kind: 'paper-plan', assertActive() { if (!active) throw Object.assign(new Error('synthetic sync cancellation'), { code: 'PROJECT_SUMMARY_STOPPED' }); } }), { code: 'PROJECT_SUMMARY_STOPPED' });
  assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(created(f).length, 1); assert.equal((await registry(f, 'paper-plan-registry.json')).state, 'created');
  t.diagnostic('Boundary mock only: sessions.start synchronously flips authority; this is not a real research-sessions race reproduction.');
});
test('M05 integration review real research-sessions has no synchronous callback between handle return and writer final active check', async t => {
  const f = await fixture(t), events = []; let returned = false, postStartChecks = 0;
  const real = createResearchSessions({ models: { async listAvailable() { events.push('model-catalog'); return { models: [] }; } } }); t.after(() => real.dispose());
  f.sessions.start = request => {
    const handle = real.start({ ...request, onUpdate: async value => { events.push('update'); return request.onUpdate(value); } });
    assert.deepEqual(events, [], 'real start schedules setup in a microtask'); returned = true; return handle;
  };
  const handle = await f.writer.start({ ...input, kind: 'paper-plan', assertActive() { if (returned && events.length === 0) postStartChecks++; } });
  assert.equal(postStartChecks, 1); assert.equal(typeof handle.stop, 'function'); const terminal = await handle.done;
  assert.equal(terminal.state, 'failed'); assert.ok(events.includes('model-catalog')); assert.equal(terminal.sessionId, null);
  t.diagnostic('Real synchronous start ordering verified using a software empty model catalog; no SDK sessions are created. Reachability via ordinary async stop in that same JS stack is not established.');
});
test('M05 integration planner unknown creation is not retried, replaced or borrowed from summary', async t => {
  const f = await fixture(t), create = f.sdk.agents.create, request = { ...input, kind: 'paper-plan' };
  f.sdk.agents.create = async value => value.id.startsWith('math-paper-planner-') ? (f.calls.push(['create', value]), {}) : create(value);
  await assert.rejects(f.writer.start(request), { code: 'REPORT_WRITER_CREATE_UNCONFIRMED' });
  await assert.rejects(f.writer.start(request), { code: 'REPORT_WRITER_CREATE_UNCONFIRMED' }); await f.writer.start(input);
  const reopened = createSummaryWriter(f); t.after(() => reopened.dispose());
  await assert.rejects(reopened.start(request), { code: 'REPORT_WRITER_CREATION_UNKNOWN' }); assert.equal(created(f).length, 2); assert.equal(f.starts.length, 1);
  assert.equal((await registry(f, 'paper-plan-registry.json')).state, 'creating');
});

test('default summary identity, contract bytes/hash, registry and session API stay compatible', async t => {
  const f = await fixture(t);
  await f.writer.start(input);
  const [agent] = created(f);
  assert.match(agent.id, /^math-report-writer-[0-9a-f-]{36}$/);
  assert.deepEqual(agent, { id: agent.id, name: 'Math Report Writer', kind: 'math-report-writer', memoryPolicy: { enabled: false },
    initialFiles: { identity, agents: contract, publicAgents: identity } });
  assert.deepEqual(await registry(f, 'registry.json'), { schemaVersion: 1, state: 'created', id: agent.id, contractHash: hash(contract) });
  const [start] = f.starts;
  assert.equal(start.kind, 'math-summary:project-p:report-r');
  assert.equal(start.role, 'report-writer'); assert.equal(start.prompt, input.prompt);
  assert.deepEqual(start.selection, { agentId: agent.id, model });
  assert.equal(start.toolless, true); assert.deepEqual(start.toolNames, []);
  await start.onBound({ sessionId: 's' });
  assert.deepEqual(await start.onUpdate({}), { ok: true });
});

test('paper source has a separate private persona/registry and unchanged saved verifier selection', async t => {
  const f = await fixture(t);
  await Promise.all([f.writer.start(input), f.writer.start(paper), f.writer.start(paper)]);
  assert.equal(created(f).length, 2);
  const summary = created(f).find(a => a.kind === 'math-report-writer');
  const source = created(f).find(a => a.kind === 'math-paper-source-writer');
  assert.match(source.id, /^math-paper-source-writer-[0-9a-f-]{36}$/);
  assert.notEqual(source.id, summary.id);
  assert.deepEqual(source.memoryPolicy, { enabled: false });
  assert.deepEqual(Object.keys(source).sort(), ['id', 'initialFiles', 'kind', 'memoryPolicy', 'name']);
  assert.deepEqual(Object.keys(source.initialFiles).sort(), ['agents', 'identity', 'publicAgents']);
  assert.equal(source.initialFiles.publicAgents, source.initialFiles.identity);
  assert.notEqual(source.initialFiles.identity, identity);
  assert.match(source.initialFiles.identity, /raw LaTeX source/);
  assert.match(source.initialFiles.identity, /verified material.*original paper role\/style/);
  assert.match(source.initialFiles.identity, /Do not use tools, memory or outside sources/);
  assert.match(source.initialFiles.identity, /text-only/);
  assert.match(source.initialFiles.identity, /Do not certify citations, compilation or mathematical correctness/);
  const c = source.initialFiles.agents;
  for (const phrase of ['AGENTS.md', 'PAPER_WRITER_PROMPT.md', 'STYLE_GUIDE.md', 'PAPER_STRUCTURE.md',
    'separately embedded', '\\documentclass', '\\end{document}', '%%%PROVENANCE%%%', 'source_fact',
    'every labeled result', 'never in the LaTeX, even in comments', 'locked editorial macros', 'blocker', 'downstream requirements']) assert.ok(c.includes(phrase), phrase);
  assert.doesNotMatch(c, /You are a report author|verification_report|You are the (main|worker|verifier)/);
  assert.deepEqual(await registry(f, 'paper-source-registry.json'), { schemaVersion: 1, state: 'created', id: source.id, contractHash: hash(c) });
  assert.notEqual(hash(c), hash(contract));
  for (const start of f.starts.filter(s => s.kind.startsWith('math-paper-source:'))) {
    assert.equal(start.kind, 'math-paper-source:project-p:report-r');
    assert.equal(start.role, 'report-writer'); assert.equal(start.toolless, true); assert.deepEqual(start.toolNames, []);
    assert.equal(start.prompt, input.prompt);
    assert.deepEqual(start.selection, { agentId: source.id, model });
    assert.notEqual(start.selection.agentId, 'saved-verifier');
    assert.notEqual(start.selection.model, model);
  }
  assert.deepEqual(f.calls.filter(([op]) => op === 'model').map(([, role]) => role), ['verifier', 'verifier', 'verifier']);
  assert.ok(f.calls.filter(([op]) => op === 'list').every(([, value]) => value.scope === 'own' && value.lifecycle === 'all'));
  // A new factory reuses both persisted identities without creating or rewriting them.
  const reopened = createSummaryWriter(f); t.after(() => reopened.dispose());
  await reopened.start(paper); await reopened.start(input);
  assert.equal(created(f).length, 2);
});

test('paper reviser has a distinct private memory-off identity, registry and empty-tool session role', async t => {
  const f = await fixture(t);
  await f.writer.start(input); await f.writer.start(paper); await f.writer.start(audit); await f.writer.start(verification);
  const names = ['registry.json', 'paper-source-registry.json', 'reference-audit-registry.json', 'reference-verification-web-registry.json'];
  const before = await Promise.all(names.map(name => fs.readFile(path.join(f.dataDir, 'report-writer', name), 'utf8')));
  await f.writer.start(revision);
  const agent = created(f).find(row => row.kind === 'math-paper-reviser'), session = f.starts.at(-1);
  assert.match(agent.id, /^math-paper-reviser-[0-9a-f-]{36}$/); assert.equal(agent.name, 'Math Paper Reviser');
  assert.deepEqual(agent.memoryPolicy, { enabled: false }); assert.equal(agent.initialFiles.publicAgents, agent.initialFiles.identity);
  for (const phrase of ['citation-targeted', 'no tools, memory or outside sources', 'text-only']) assert.ok(agent.initialFiles.identity.includes(phrase), phrase);
  for (const phrase of ['AGENTS.md', 'PAPER_REVISER_PROMPT.md', 'STYLE_GUIDE.md', 'patch format', 'mathematics, compilation or provenance']) assert.ok(agent.initialFiles.agents.includes(phrase), phrase);
  assert.match(agent.initialFiles.agents, /no files, tools, network, compiler/i);
  assert.deepEqual(await registry(f, 'paper-revision-registry.json'), { schemaVersion: 1, state: 'created', id: agent.id, contractHash: hash(agent.initialFiles.agents) });
  assert.equal(session.kind, 'math-paper-revision:project-p:report-r'); assert.equal(session.role, 'paper-reviser');
  assert.equal(session.toolless, true); assert.deepEqual(session.toolNames, []); assert.equal(session.prompt, input.prompt);
  assert.deepEqual(session.selection, { agentId: agent.id, model });
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(f.dataDir, 'report-writer', name), 'utf8'))), before);
  const reopened = createSummaryWriter(f); t.after(() => reopened.dispose()); await reopened.start(revision);
  assert.equal(created(f).length, 5); assert.equal(f.starts.at(-1).selection.agentId, agent.id);
});

test('operator-notes private registry isolates the unchanged citation contract and reuses both identities after restart', async t => {
  const f = await fixture(t), notes = { ...revision, revisionMode: 'operator-notes' };
  await f.writer.start(revision);
  const filename = path.join(f.dataDir, 'report-writer/paper-revision-registry.json'), oldBytes = await fs.readFile(filename, 'utf8');
  const oldAgent = created(f)[0];
  await Promise.all([f.writer.start(notes), f.writer.start(notes)]);
  assert.equal(created(f).length, 2);
  const agent = created(f)[1]; assert.notEqual(agent.id, oldAgent.id); assert.equal(agent.kind, 'math-paper-reviser');
  assert.match(agent.id, /^math-paper-reviser-[0-9a-f-]{36}$/); assert.deepEqual(agent.memoryPolicy, { enabled: false });
  assert.notEqual(hash(agent.initialFiles.agents), hash(oldAgent.initialFiles.agents));
  assert.match(agent.initialFiles.identity, /operator-notes/); assert.match(agent.initialFiles.agents, /not authentication/);
  assert.deepEqual(await registry(f, 'paper-notes-revision-registry.json'), { schemaVersion: 1, state: 'created', id: agent.id, contractHash: hash(agent.initialFiles.agents) });
  for (const session of f.starts.slice(1)) {
    assert.equal(session.kind, 'math-paper-revision:project-p:report-r'); assert.equal(session.role, 'paper-reviser');
    assert.equal(session.toolless, true); assert.deepEqual(session.toolNames, []); assert.deepEqual(session.selection, { agentId: agent.id, model });
  }
  assert.equal(await fs.readFile(filename, 'utf8'), oldBytes);
  const reopened = createSummaryWriter(f); t.after(() => reopened.dispose());
  await reopened.start(revision); await reopened.start(notes);
  assert.equal(created(f).length, 2); assert.equal(f.starts.at(-2).selection.agentId, oldAgent.id); assert.equal(f.starts.at(-1).selection.agentId, agent.id);
  assert.equal(await fs.readFile(filename, 'utf8'), oldBytes);
  assert.equal(f.calls.some(([op]) => ['config', 'updateConfig'].includes(op)), false);
});

test('operator-notes unknown or unconfirmed creation never recreates, and old citation registry still works', async t => {
  for (const scenario of ['creating', 'bad-hash', 'unconfirmed']) await t.test(scenario, async t => {
    const f = await fixture(t), notes = { ...revision, revisionMode: 'operator-notes' };
    await f.writer.start(revision); const old = await registry(f, 'paper-revision-registry.json');
    const filename = path.join(f.dataDir, 'report-writer/paper-notes-revision-registry.json');
    if (scenario === 'unconfirmed') f.sdk.agents.create = async () => ({});
    else await fs.writeFile(filename, JSON.stringify({ ...old, ...(scenario === 'creating' ? { state: 'creating' } : { contractHash: old.contractHash }) }));
    await assert.rejects(f.writer.start(notes)); const bytes = await fs.readFile(filename, 'utf8');
    await assert.rejects(f.writer.start(notes));
    const reopened = createSummaryWriter(f); t.after(() => reopened.dispose());
    await assert.rejects(reopened.start(notes), { code: 'REPORT_WRITER_CREATION_UNKNOWN' }); await reopened.start(revision);
    assert.equal(created(f).length, 1); assert.equal(f.starts.length, 2); assert.equal(await fs.readFile(filename, 'utf8'), bytes);
  });
});

test('operator-notes, gap-fill and compile-fix writer modes are explicit and valid only on paper-revision', async t => {
  const f = await fixture(t);
  for (const value of [null, '', 'citation', 'style', 'unknown']) await assert.rejects(f.writer.start({ ...revision, revisionMode: value }), { code: 'PROJECT_INVALID_INPUT' });
  for (const mode of ['operator-notes', 'gap-fill', 'compile-fix']) {
    for (const kind of [undefined, 'paper-source', 'reference-audit', 'reference-verification']) {
      await assert.rejects(f.writer.start({ ...input, kind, revisionMode: mode }), { code: 'PROJECT_INVALID_INPUT' });
    }
  }
  assert.deepEqual(f.calls, []);
  await f.writer.start({ ...revision, revisionMode: 'gap-fill' });
  await f.writer.start({ ...revision, revisionMode: 'compile-fix' });
  assert.equal((await registry(f, 'paper-gap-fill-revision-registry.json')).state, 'created');
  assert.equal((await registry(f, 'paper-compile-fix-revision-registry.json')).state, 'created');
  assert.equal(f.starts.every(s => s.toolless === true && s.toolNames.length === 0), true);
});

test('reference auditor has a distinct private identity, registry and session role', async t => {
  const f = await fixture(t);
  await f.writer.start(audit);
  const [agent] = created(f), [session] = f.starts;
  assert.equal(agent.kind, 'math-reference-auditor'); assert.match(agent.id, /^math-reference-auditor-[0-9a-f-]{36}$/);
  assert.equal(agent.memoryPolicy.enabled, false);
  assert.equal(session.kind, 'math-reference-audit:project-p:report-r');
  assert.equal(session.role, 'reference-auditor'); assert.equal(session.toolless, true); assert.deepEqual(session.toolNames, []);
  assert.equal(session.selection.model.id, model.id);
  assert.deepEqual(await registry(f, 'reference-audit-registry.json'), { schemaVersion: 1, state: 'created', id: agent.id, contractHash: hash(agent.initialFiles.agents) });
});

test('online reference verifier uses a versioned native-web registry and preserves the prior Matlas registry', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dataDir, 'report-writer'), { recursive: true });
  const legacy = JSON.stringify({ schemaVersion: 1, state: 'created', id: 'math-reference-verifier-' + 'a'.repeat(36), contractHash: 'legacy-contract' });
  await fs.writeFile(path.join(f.dataDir, 'report-writer/reference-verification-registry.json'), legacy);
  await f.writer.start(input); await f.writer.start(paper); await f.writer.start(audit);
  assert.equal(f.calls.some(([op]) => op === 'config' || op === 'updateConfig'), false);
  const existingNames = ['registry.json', 'paper-source-registry.json', 'reference-audit-registry.json'];
  const existingBytes = await Promise.all(existingNames.map(name => fs.readFile(path.join(f.dataDir, 'report-writer', name), 'utf8')));
  await f.writer.start(verification);
  const agent = created(f).find(row => row.kind === 'math-reference-verifier'), session = f.starts.at(-1);
  assert.equal(created(f).length, 4); assert.equal(new Set(created(f).map(row => row.id)).size, 4);
  assert.match(agent.id, /^math-reference-verifier-[0-9a-f-]{36}$/);
  assert.equal(agent.name, 'Math Reference Verifier'); assert.deepEqual(agent.memoryPolicy, { enabled: false });
  assert.equal(agent.initialFiles.publicAgents, agent.initialFiles.identity);
  assert.match(agent.initialFiles.identity, /flagged bibliography.*authoritative online/);
  for (const phrase of ['AGENTS.md', 'REFERENCE_VERIFIER_PROMPT.md', 'separately embedded original', 'Matlas is not available',
    'web_search', 'web_fetch', 'startChar/maxLength', 'no local read tool', 'read no project files', 'Write no files',
    'do not edit main.tex', 'REFERENCE_LEDGER.md', 'unverifiable', 'text-only', 'executable mathematical experiments']) {
    assert.ok(agent.initialFiles.agents.includes(phrase), phrase);
  }
  assert.deepEqual(await registry(f, 'reference-verification-web-registry.json'), {
    schemaVersion: 1, state: 'created', id: agent.id, contractHash: hash(agent.initialFiles.agents),
  });
  assert.equal(await fs.readFile(path.join(f.dataDir, 'report-writer/reference-verification-registry.json'), 'utf8'), legacy);
  assert.equal(session.kind, 'math-reference-verification:project-p:report-r');
  assert.equal(session.role, 'reference-verifier'); assert.equal(Object.hasOwn(session, 'toolless'), false);
  assert.deepEqual(session.toolNames, referenceTools); assert.equal(session.prompt, input.prompt); assert.equal(session.cwd, input.cwd);
  assert.deepEqual(session.selection, { agentId: agent.id, model }); assert.notEqual(session.selection.model, model);
  assert.ok(f.calls.filter(([op]) => op === 'model').every(([, role]) => role === 'verifier'));
  assert.ok(f.calls.filter(([op]) => op === 'list').every(([, value]) => value.scope === 'own' && value.lifecycle === 'all'));
  for (const offline of f.starts.slice(0, 3)) { assert.equal(offline.toolless, true); assert.deepEqual(offline.toolNames, []); }
  assert.deepEqual(await Promise.all(existingNames.map(name => fs.readFile(path.join(f.dataDir, 'report-writer', name), 'utf8'))), existingBytes);
  const reopened = createSummaryWriter(f); t.after(() => reopened.dispose());
  await reopened.start(verification);
  assert.equal(created(f).length, 4); assert.equal(f.starts.at(-1).selection.agentId, agent.id);
});

test('online verifier cannot reuse an auditor identity or replace a damaged verifier registry', async t => {
  const f = await fixture(t);
  await f.writer.start(audit); await f.writer.start(verification);
  const auditRegistry = await registry(f, 'reference-audit-registry.json');
  const verifierRegistry = await registry(f, 'reference-verification-web-registry.json');
  const filename = path.join(f.dataDir, 'report-writer/reference-verification-web-registry.json');
  const bytes = JSON.stringify({ ...verifierRegistry, id: auditRegistry.id }); await fs.writeFile(filename, bytes);
  const reopened = createSummaryWriter(f); t.after(() => reopened.dispose());
  await assert.rejects(reopened.start(verification), { code: 'REPORT_WRITER_CREATION_UNKNOWN' });
  await reopened.start(audit);
  assert.equal(created(f).length, 2); assert.equal(f.starts.length, 3);
  assert.equal(f.starts.at(-1).selection.agentId, auditRegistry.id);
  assert.equal(await fs.readFile(filename, 'utf8'), bytes);
  assert.deepEqual(await registry(f, 'reference-audit-registry.json'), auditRegistry);
});

test('online verifier preserves saved config modes and selects only native web source tools', async t => {
  for (const config of [{}, { tool_call_mode: 'light' }, { tool_call_mode: 'full' }, { lightweight_tools: true }]) {
    const f = await fixture(t, config);
    await f.writer.start(verification);
    const id = created(f)[0].id, session = f.starts[0];
    assert.deepEqual(f.configs.get(id), config, 'verifier mode is never rewritten');
    assert.equal(f.calls.some(([op]) => op === 'config' || op === 'updateConfig'), false);
    assert.deepEqual(session.toolNames, ['web_search', 'web_fetch']);
    assert.deepEqual(session.selection, { agentId: id, model });
    assert.ok(f.calls.filter(([op]) => op === 'model').every(([, role]) => role === 'verifier'));
    assert.deepEqual(Object.keys(await registry(f, 'reference-verification-web-registry.json')).sort(), ['schemaVersion', 'state', 'id', 'contractHash'].sort());
  }
});

test('unknown explicit kinds reject before model, Agent or session operations', async t => {
  const f = await fixture(t);
  for (const kind of ['paper', 'summary', 'reference-revision', '', null, {}, 1]) await assert.rejects(f.writer.start({ ...input, kind }), { code: 'PROJECT_INVALID_INPUT' });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.starts, []);
});

test('damaged or unknown registries fail closed independently in both directions', async t => {
  for (const damagedPaper of [true, false]) {
    for (const bytes of ['{broken', '{}', JSON.stringify({ schemaVersion: 1, state: 'creating', id: 'unknown' }),
      JSON.stringify({ schemaVersion: 1, state: 'created', id: 'math-paper-source-writer-' + 'a'.repeat(36), contractHash: hash(contract) })]) {
      const f = await fixture(t);
      const name = damagedPaper ? 'paper-source-registry.json' : 'registry.json';
      await fs.mkdir(path.join(f.dataDir, 'report-writer'));
      await fs.writeFile(path.join(f.dataDir, 'report-writer', name), bytes);
      const badInput = damagedPaper ? paper : input, goodInput = damagedPaper ? input : paper;
      await assert.rejects(f.writer.start(badInput));
      await f.writer.start(goodInput);
      await assert.rejects(f.writer.start(badInput));
      assert.equal(created(f).length, 1); assert.equal(f.starts.length, 1);
      assert.equal(created(f)[0].kind, damagedPaper ? 'math-report-writer' : 'math-paper-source-writer');
      assert.equal(await fs.readFile(path.join(f.dataDir, 'report-writer', name), 'utf8'), bytes);
    }
  }
});

test('an unconfirmed paper creation is never retried or replaced and summary still starts', async t => {
  const f = await fixture(t), create = f.sdk.agents.create;
  f.sdk.agents.create = async value => value.kind === 'math-paper-source-writer'
    ? (f.calls.push(['create', value]), {}) : create(value);
  await assert.rejects(f.writer.start(paper), { code: 'REPORT_WRITER_CREATE_UNCONFIRMED' });
  await assert.rejects(f.writer.start(paper), { code: 'REPORT_WRITER_CREATE_UNCONFIRMED' });
  await f.writer.start(input);
  const reopened = createSummaryWriter(f); t.after(() => reopened.dispose());
  await assert.rejects(reopened.start(paper), { code: 'REPORT_WRITER_CREATION_UNKNOWN' });
  assert.equal(created(f).length, 2); assert.equal(f.starts.length, 1);
  assert.equal((await registry(f, 'paper-source-registry.json')).state, 'creating');
});

test('paper identity readback rejects foreign or inherited role identities', async t => {
  for (const patch of [row => { row.plugin.kind = 'math-report-writer'; }, row => { row.plugin.roleId = 'worker'; },
    row => { row.ownerPluginId = 'foreign'; }, row => { row.plugin.visibility = 'public'; }]) {
    const f = await fixture(t), list = f.sdk.agents.list;
    f.sdk.agents.list = async value => { const result = await list(value); result.agents.forEach(patch); return result; };
    await assert.rejects(f.writer.start(paper), { code: 'REPORT_WRITER_IDENTITY_UNCONFIRMED' });
    assert.equal(f.starts.length, 0); assert.equal(created(f).length, 1);
  }
});

test('shared disposal stops outstanding paper and summary handles once', async t => {
  const f = await fixture(t);
  await Promise.all([f.writer.start(paper), f.writer.start(input)]);
  const first = f.writer.dispose(); assert.equal(f.writer.dispose(), first);
  assert.deepEqual(await first, { cleanupPending: false, errors: [] });
  assert.deepEqual(f.handles.map(h => h.stops), [1, 1]);
  assert.equal(f.calls.filter(([op]) => op === 'dispose').length, 1);
  await assert.rejects(f.writer.start(paper), { code: 'PROJECT_DISPOSED' });
});

test('paper uses research-sessions memory off and independent empty-tools readback before send', async t => {
  const f = await fixture(t), operations = [];
  Object.assign(f.sdk, { models: { listAvailable: async () => ({ models: [model] }) }, bus: { subscribe: async () => () => {} }, sessions: {
    async create(value) {
      operations.push(['create', value]);
      return { ok: true, sessionId: 's', sessionPath: '/s', path: '/s', ownerPluginId: 'hana-math', visibility: 'plugin_private',
        namespace: 'app', agentId: value.agentId, cwd: value.cwd, modelProvider: model.provider, modelId: model.id, kind: value.kind };
    },
    async setActiveTools(value) { operations.push(['tools', value]); return { sessionId: 's', toolNames: [], effective: 'current', pendingToolNames: null }; },
    async getToolSelection(value) { operations.push(['readback', value]); return { sessionId: 's', toolNames: ['main-worker-tool'], effective: 'current', pendingToolNames: null }; },
    async send() { operations.push(['send']); return {}; }, abort: async () => ({ aborted: true }),
    async get() { throw new Error('cleanup unavailable fixture'); },
  } });
  const sessions = createResearchSessions(f.sdk);
  const writer = createSummaryWriter({ sdk: f.sdk, profiles: f.profiles, sessions }); t.after(() => writer.dispose());
  const handle = await writer.start(paper), outcome = await handle.done;
  assert.equal(outcome.error, 'TOOL_SELECTION_UNCONFIRMED');
  assert.deepEqual(operations.map(([op]) => op), ['create', 'tools', 'readback']);
  const creation = operations[0][1];
  assert.equal(creation.memoryEnabled, false); assert.deepEqual(creation.model, model);
  assert.equal(creation.kind, 'math-paper-source:project-p:report-r');
  assert.equal(creation.agentId, created(f)[0].id);
  assert.deepEqual(operations[1][1].toolNames, []);
});

// Reuse the writer/Agent fixture; all session/catalog responses below are opaque
// software fixtures, not Host authorization, Matlas access or a real model run.
async function sessionFixture(t) {
  const f = await fixture(t), operations = [];
  let session, selection, listener;
  const receipt = names => ({ sessionId: session.sessionId, toolNames: names, effective: 'current', pendingToolNames: null });
  Object.assign(f.sdk, {
    models: { async listAvailable() { operations.push(['models']); return { models: [model] }; } },
    tools: { async list(value) {
      operations.push(['catalog', value]); assert.deepEqual(value, { scope: 'own' });
      return [];
    } },
    sessions: {
      async create(value) {
        operations.push(['session', value]);
        session = { ok: true, sessionId: 's', sessionPath: '/s', path: '/s', ownerPluginId: 'hana-math', visibility: 'plugin_private',
          namespace: 'app', agentId: value.agentId, cwd: value.cwd, modelProvider: value.model.provider, modelId: value.model.id, kind: value.kind };
        return structuredClone(session);
      },
      async setActiveTools(value) {
        operations.push(['tools', value]);
        selection = receipt(value.toolNames);
        return structuredClone(selection);
      },
      async getToolSelection(value) { operations.push(['readback', value]); return structuredClone(selection); },
      async send(value) { operations.push(['send', value]); return { accepted: true, sessionId: 's', sessionPath: '/s' }; },
      async get() { return { session: { ...session } }; },
      async list() { return { sessions: [{ ...session, lifecycle: 'active' }] }; },
      async abort() { operations.push(['abort']); return { aborted: true, sessionId: 's' }; },
    },
    bus: { async subscribe(callback) { operations.push(['subscribe']); listener = callback; return async () => { operations.push(['unsubscribe']); }; } },
  });
  const sessions = createResearchSessions(f.sdk), writer = createSummaryWriter({ sdk: f.sdk, profiles: f.profiles, sessions });
  t.after(() => writer.dispose());
  return { ...f, writer, sessionService: sessions, operations,
    end() { listener({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Opaque reference fixture response.', stopReason: 'stop' }] }, '/s'); } };
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(predicate) {
  for (let index = 0; index < 2000; index++) { if (predicate()) return; await new Promise(setImmediate); }
  assert.fail('Session software fixture did not settle');
}

test('online session binds before exact native web selection and independent readback before send', async t => {
  const f = await sessionFixture(t), bound = deferred(), releaseBound = deferred(), updated = deferred(), releaseUpdate = deferred();
  t.after(() => { releaseBound.resolve(); releaseUpdate.resolve(); });
  const handle = await f.writer.start({ ...verification,
    onBound: async value => { f.operations.push(['binding', value]); bound.resolve(); await releaseBound.promise; f.operations.push(['binding-saved']); },
    onUpdate: async value => {
      if (value.phase === 'tool-selection') { updated.resolve(); await releaseUpdate.promise; f.operations.push(['update-saved', value]); }
    },
  });
  await bound.promise; assert.equal(f.operations.some(([op]) => op === 'tools' || op === 'send'), false);
  releaseBound.resolve(); await updated.promise;
  assert.equal(f.operations.some(([op]) => op === 'tools' || op === 'send'), false);
  releaseUpdate.resolve(); await until(() => handle.snapshot().phase === 'awaiting-agent-end');
  const ops = f.operations.map(([op]) => op);
  assert.ok(ops.indexOf('binding-saved') < ops.indexOf('update-saved'));
  assert.ok(ops.indexOf('update-saved') < ops.indexOf('tools'));
  assert.ok(ops.indexOf('tools') < ops.indexOf('readback') && ops.indexOf('readback') < ops.indexOf('send'));
  assert.equal(f.operations.some(([op]) => op === 'catalog'), false, 'native web tools need no App catalog');
  const creation = f.operations.find(([op]) => op === 'session')[1];
  assert.equal(creation.memoryEnabled, false); assert.equal(creation.namespace, 'app'); assert.equal(creation.cwd, input.cwd);
  assert.equal(creation.kind, 'math-reference-verification:project-p:report-r');
  assert.equal(creation.agentId, created(f)[0].id); assert.deepEqual(creation.model, model);
  const binding = f.operations.find(([op]) => op === 'binding')[1];
  assert.equal(binding.role, 'reference-verifier'); assert.equal(binding.agentId, creation.agentId);
  assert.deepEqual(f.operations.find(([op]) => op === 'tools')[1].toolNames, referenceTools);
  assert.deepEqual(handle.snapshot().toolSelection, { requested: referenceTools, resolved: referenceTools, effective: 'current', pendingToolNames: null });
  assert.equal(Object.hasOwn(handle, 'resume'), false);
  f.end(); const result = await handle.done;
  assert.equal(result.state, 'completed'); assert.equal(result.roundEnded, true); assert.equal(result.finalText, 'Opaque reference fixture response.');
  assert.equal(f.operations.filter(([op]) => op === 'send').length, 1);
});

test('reference-verifier policy accepts only the exact ordered native web pair with no read, extras or mode flags', async t => {
  const f = await sessionFixture(t);
  const base = { ...verification, role: 'reference-verifier', toolNames: referenceTools,
    selection: { agentId: 'dedicated-reference-fixture', model } };
  for (const change of [
    { toolNames: ['read', ...referenceTools] }, { toolNames: [...referenceTools, 'fact_search'] },
    { toolNames: ['web_search'] }, { toolNames: [...referenceTools].reverse() }, { toolNames: [] }, { toolNames: new Array(2) },
    { toolless: false }, { toolless: true }, { turnMode: 'controlled' },
  ]) assert.throws(() => f.sessionService.start({ ...base, ...change }), error => error.code === 'INVALID_TOOL_SELECTION' || error.code === 'INVALID_TURN_MODE');
  assert.deepEqual(f.operations, []); assert.deepEqual(f.calls, []);
});

test('online verifier uses only native web tools and does not query the App literature catalog', async t => {
  const f = await sessionFixture(t), handle = await f.writer.start(verification);
  await until(() => handle.snapshot().phase === 'awaiting-agent-end');
  assert.equal(f.operations.some(([op]) => op === 'catalog'), false);
  assert.ok(f.operations.some(([op]) => op === 'tools'));
  assert.ok(f.operations.some(([op]) => op === 'send'));
  f.end(); assert.equal((await handle.done).state, 'completed');
});

test('online verifier rejects a Host substitution of a native web tool by read even if both receipts agree', async t => {
  const f = await sessionFixture(t), select = f.sdk.sessions.setActiveTools;
  f.sdk.sessions.setActiveTools = async value => { const receipt = await select(value); receipt.toolNames[0] = 'read'; return receipt; };
  f.sdk.sessions.getToolSelection = async () => ({ sessionId: 's', toolNames: ['read', 'web_fetch'], effective: 'current', pendingToolNames: null });
  const result = await (await f.writer.start(verification)).done;
  assert.equal(result.error, 'TOOL_SELECTION_UNCONFIRMED'); assert.equal(result.abortOutcome, 'aborted');
  assert.equal(f.operations.some(([op]) => op === 'send'), false);
});

test('online verifier independently rejects extra tools in readback instead of trusting the selection receipt', async t => {
  const f = await sessionFixture(t), readback = f.sdk.sessions.getToolSelection;
  f.sdk.sessions.getToolSelection = async value => { const receipt = await readback(value); receipt.toolNames.push('fact_search'); return receipt; };
  const result = await (await f.writer.start(verification)).done;
  assert.equal(result.error, 'TOOL_SELECTION_UNCONFIRMED'); assert.equal(result.abortOutcome, 'aborted');
  assert.ok(f.operations.some(([op]) => op === 'readback')); assert.equal(f.operations.some(([op]) => op === 'send'), false);
});

test('operator-notes real session adapter retains saved verifier, memory-off and independently read-back empty tools', async t => {
  const f = await sessionFixture(t), handle = await f.writer.start({ ...revision, revisionMode: 'operator-notes' });
  await until(() => handle.snapshot().phase === 'awaiting-agent-end');
  const creation = f.operations.find(([op]) => op === 'session')[1];
  assert.equal(creation.memoryEnabled, false); assert.deepEqual(creation.model, model); assert.equal(creation.kind, 'math-paper-revision:project-p:report-r');
  assert.deepEqual(f.operations.find(([op]) => op === 'tools')[1].toolNames, []);
  assert.deepEqual(handle.snapshot().toolSelection.resolved, []); assert.equal(f.operations.some(([op]) => op === 'catalog'), false);
  const ops = f.operations.map(([op]) => op); assert.ok(ops.indexOf('readback') < ops.indexOf('send'));
  f.end(); assert.equal((await handle.done).state, 'completed');
});

test('existing offline audit still selects and independently reads back empty tools without catalog access', async t => {
  const f = await sessionFixture(t), handle = await f.writer.start(audit);
  await until(() => handle.snapshot().phase === 'awaiting-agent-end');
  assert.deepEqual(f.operations.find(([op]) => op === 'tools')[1].toolNames, []);
  assert.deepEqual(handle.snapshot().toolSelection.resolved, []);
  const ops = f.operations.map(([op]) => op);
  assert.equal(ops.includes('catalog'), false); assert.ok(ops.indexOf('readback') < ops.indexOf('send'));
  f.end(); assert.equal((await handle.done).state, 'completed');
});

// B1: all SDK/Agent/session operations below are software fixture calls only.
test('M05 B1 section writer isolated registry/identity reuses one private Agent across independent sessions', async t => {
  const f = await fixture(t, { tool_call_mode: 'full' });
  for (const kind of [undefined, 'paper-source', 'paper-plan']) await f.writer.start({ ...input, kind });
  const names = ['registry.json', 'paper-source-registry.json', 'paper-plan-registry.json'];
  const before = await Promise.all(names.map(name => fs.readFile(path.join(f.dataDir, 'report-writer', name))));
  await Promise.all(['report-first', 'report-next'].map(reportId => f.writer.start({ ...input, reportId, kind: 'paper-section' })));
  const agent = created(f).find(row => row.id.startsWith('math-paper-section-writer-')); assert.ok(agent);
  assert.equal(agent.kind, 'math-report-writer'); assert.equal(agent.memoryPolicy.enabled, false);
  assert.match(agent.initialFiles.identity, /ONE phase-2 LaTeX section fragment/); assert.match(agent.initialFiles.agents, /PAPER_SECTION_WRITER_PROMPT.md/);
  assert.doesNotMatch(agent.initialFiles.agents, /phase-1 section-plan preview|single complete raw main.tex|PAPER_WRITER_PROMPT.md|PAPER_PLANNER_PROMPT.md/);
  const state = await registry(f, 'paper-section-registry.json'); assert.equal(state.id, agent.id); assert.equal(state.contractHash, hash(agent.initialFiles.agents));
  assert.deepEqual(f.starts.slice(-2).map(s => s.kind).sort(), ['math-paper-section:project-p:report-first', 'math-paper-section:project-p:report-next']);
  for (const start of f.starts.slice(-2)) { assert.equal(start.role, 'report-writer'); assert.equal(start.toolless, true); assert.deepEqual(start.toolNames, []); assert.deepEqual(start.selection, { agentId: agent.id, model }); }
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(f.dataDir, 'report-writer', name)))), before);
  assert.equal(f.calls.some(([op]) => op === 'config' || op === 'updateConfig'), false);
  const reopened = createSummaryWriter(f); t.after(() => reopened.dispose()); await reopened.start({ ...input, kind: 'paper-section' });
  assert.equal(created(f).length, 4); assert.equal(f.starts.at(-1).selection.agentId, agent.id);
});

test('M05 B1 section readonly proof is phase/project/report/kind/writer bound with no foreign endorsement', async t => {
  for (const phase of ['active', 'lookup', 'validation']) await t.test(phase, async t => {
    const f = await fixture(t), original = Object.assign(Error('Host forged marker'), { code: 'SAVED_ROLE_INVALID', noResourcesCreated: true, kind: 'paper-section' });
    f.profiles.getRoleModel = async () => { if (phase === 'lookup') throw original; return { role: 'verifier', source: 'not-saved' }; };
    let caught; await assert.rejects(f.writer.start({ ...input, kind: 'paper-section', assertActive() { if (phase === 'active') throw original; } }), error => { caught = error; return error.code === 'SAVED_ROLE_INVALID'; });
    const identity = { projectId: input.projectId, reportId: input.reportId };
    assert.notEqual(caught, original); assert.equal(f.writer.sectionPreparationFailedBeforeCreation(caught, identity), true);
    assert.equal(f.writer.planPreparationFailedBeforeCreation(caught, identity), false);
    assert.equal(f.writer.sectionPreparationFailedBeforeCreation(original, identity), false);
    assert.equal(f.writer.sectionPreparationFailedBeforeCreation({ code: caught.code, ...identity, noResourcesCreated: true }, identity), false);
    assert.equal(f.writer.sectionPreparationFailedBeforeCreation(caught, { ...identity, projectId: 'foreign' }), false);
    assert.equal(f.writer.sectionPreparationFailedBeforeCreation(caught, { ...identity, reportId: 'foreign' }), false);
    const reopened = createSummaryWriter(f); t.after(() => reopened.dispose()); assert.equal(reopened.sectionPreparationFailedBeforeCreation(caught, identity), false);
    let planError; await assert.rejects(f.writer.start({ ...input, kind: 'paper-plan' }), e => { planError = e; return true; });
    assert.equal(f.writer.planPreparationFailedBeforeCreation(planError, identity), true); assert.equal(f.writer.sectionPreparationFailedBeforeCreation(planError, identity), false);
    await assert.rejects(f.writer.start({ ...input, assertActive() { throw original; } }), e => e === original);
    assert.equal(created(f).length, 0); assert.equal(f.starts.length, 0);
    await assert.rejects(fs.stat(path.join(f.dataDir, 'report-writer')), { code: 'ENOENT' });
  });
});

test('M05 B1 section unknown Agent creation stays sticky and never gains readonly clean proof', async t => {
  const f = await fixture(t), originalCreate = f.sdk.agents.create, request = { ...input, kind: 'paper-section' };
  f.sdk.agents.create = async value => value.id.startsWith('math-paper-section-writer-') ? (f.calls.push(['create', value]), {}) : originalCreate(value);
  let caught; await assert.rejects(f.writer.start(request), e => { caught = e; return e.code === 'REPORT_WRITER_CREATE_UNCONFIRMED'; });
  assert.equal(f.writer.sectionPreparationFailedBeforeCreation(caught, input), false); assert.equal(f.writer.planPreparationFailedBeforeCreation(caught, input), false);
  await assert.rejects(f.writer.start(request), { code: 'REPORT_WRITER_CREATE_UNCONFIRMED' });
  const reopened = createSummaryWriter(f); t.after(() => reopened.dispose()); await assert.rejects(reopened.start(request), { code: 'REPORT_WRITER_CREATION_UNKNOWN' });
  await f.writer.start(input); assert.equal(created(f).length, 2); assert.equal(f.starts.length, 1); assert.equal((await registry(f, 'paper-section-registry.json')).state, 'creating');
});

test('M05 B1 section later creation/session failures invalidate even a reused genuine readonly wrapper', async t => {
  for (const phase of ['create', 'session']) await t.test(phase, async t => {
    const f = await fixture(t), get = f.profiles.getRoleModel; let wrapped;
    f.profiles.getRoleModel = async () => { throw Object.assign(Error('lookup'), { code: 'SAVED_ROLE_MISSING' }); };
    const request = { ...input, kind: 'paper-section' };
    await assert.rejects(f.writer.start(request), e => { wrapped = e; return true; });
    assert.equal(f.writer.sectionPreparationFailedBeforeCreation(wrapped, input), true); f.profiles.getRoleModel = get;
    if (phase === 'create') f.sdk.agents.create = async () => { throw wrapped; }; else f.sessions.start = () => { throw wrapped; };
    await assert.rejects(f.writer.start(request), e => e === wrapped);
    assert.equal(f.writer.sectionPreparationFailedBeforeCreation(wrapped, input), false); assert.equal(f.writer.planPreparationFailedBeforeCreation(wrapped, input), false);
    assert.equal(f.starts.length, 0);
  });
});

test('M05 B1 section cannot borrow planner registry or trust foreign Agent identity', async t => {
  for (const scenario of ['planner-registry', 'foreign-owner']) await t.test(scenario, async t => {
    const f = await fixture(t); await f.writer.start({ ...input, kind: scenario === 'planner-registry' ? 'paper-plan' : 'paper-section' });
    if (scenario === 'planner-registry') await fs.copyFile(path.join(f.dataDir, 'report-writer/paper-plan-registry.json'), path.join(f.dataDir, 'report-writer/paper-section-registry.json'));
    else [...f.agents.values()][0].ownerPluginId = 'foreign';
    const reopened = createSummaryWriter(f); t.after(() => reopened.dispose()); let caught;
    await assert.rejects(reopened.start({ ...input, kind: 'paper-section' }), e => { caught = e; return e.code === (scenario === 'planner-registry' ? 'REPORT_WRITER_CREATION_UNKNOWN' : 'REPORT_WRITER_IDENTITY_UNCONFIRMED'); });
    assert.equal(reopened.sectionPreparationFailedBeforeCreation(caught, input), false); assert.equal(created(f).length, 1); assert.equal(f.starts.length, 1);
  });
});

test('M05 B1 section session adapter uses saved verifier/memory-off and independently checks zero tools before send', async t => {
  const f = await sessionFixture(t), handle = await f.writer.start({ ...input, kind: 'paper-section' });
  await until(() => handle.snapshot().phase === 'awaiting-agent-end');
  const creation = f.operations.find(([op]) => op === 'session')[1]; assert.equal(creation.memoryEnabled, false); assert.deepEqual(creation.model, model); assert.equal(creation.kind, 'math-paper-section:project-p:report-r');
  assert.deepEqual(f.operations.find(([op]) => op === 'tools')[1].toolNames, []); assert.deepEqual(handle.snapshot().toolSelection.resolved, []);
  const ops = f.operations.map(([op]) => op); assert.equal(ops.includes('catalog'), false); assert.ok(ops.indexOf('readback') < ops.indexOf('send'));
  f.end(); assert.equal((await handle.done).state, 'completed');
});

test('M05 B1 section tool readback substitution blocks send without claiming readonly/no-resource failure', async t => {
  const f = await sessionFixture(t), original = f.sdk.sessions.getToolSelection;
  f.sdk.sessions.getToolSelection = async value => ({ ...await original(value), toolNames: ['foreign-tool'] });
  const handle = await f.writer.start({ ...input, kind: 'paper-section' }), outcome = await handle.done;
  assert.equal(outcome.error, 'TOOL_SELECTION_UNCONFIRMED'); assert.equal(f.operations.some(([op]) => op === 'send'), false);
  assert.equal(f.writer.sectionPreparationFailedBeforeCreation(Object.assign(Error('forged'), { code: outcome.error, noResourcesCreated: true }), input), false);
});
