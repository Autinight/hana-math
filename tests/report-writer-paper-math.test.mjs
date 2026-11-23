import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSummaryWriter } from '../packages/hana-math/report-writer.mjs';
import { createResearchSessions } from '../packages/hana-math/research-sessions.mjs';
import { buildPaperMathPrompt, readPaperMathResources, parsePaperMathReport } from '../packages/hana-math/paper-math-verification.mjs';

const kind = 'paper-math-verification';
const model = { provider: 'synthetic', id: 'saved-verifier-model' };
const output = '{"findings":[],"report":"Opaque advisory assessment."}';

async function fixture(t, { wrongTools = false, wrongModel = false, absentModel = false, roleModel } = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paper-math-writer-')));
  const calls = [], agents = [], sessions = new Map(), subscriptions = new Map();
  const sdk = { dataDir,
    agents: {
      async create(value) {
        calls.push(['agent', value]);
        const agent = { id: value.id, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private',
          plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: value.kind } };
        agents.push(agent); return { agent };
      },
      async list() { return { agents: [...agents] }; },
    },
    models: { async listAvailable() { return { models: absentModel ? [{ ...model, id: 'not-the-saved-model' }] : [model] }; } },
    tools: { async list() { assert.fail('no App tool catalog for the isolated verifier'); } },
    sessions: {
      async create(value) {
        calls.push(['session', value]);
        const sessionId = `synthetic-session-${sessions.size + 1}`, sessionPath = `/fixture/${sessionId}.jsonl`;
        const row = { ok: true, sessionId, sessionPath, path: sessionPath, ownerPluginId: 'hana-math', visibility: 'plugin_private',
          namespace: 'app', agentId: value.agentId, cwd: value.cwd, modelProvider: model.provider, modelId: wrongModel ? 'foreign-model' : model.id,
          kind: value.kind, lifecycle: 'active' };
        sessions.set(sessionId, row);
        return { ...row };
      },
      async setActiveTools(value) {
        calls.push(['tools', value]);
        assert.deepEqual(value.toolNames, []);
        return { sessionId: value.sessionId, toolNames: [], effective: 'current', pendingToolNames: null };
      },
      async getToolSelection(value) {
        calls.push(['readback', value]);
        return { sessionId: value.sessionId, toolNames: wrongTools ? ['read'] : [], effective: 'current', pendingToolNames: null };
      },
      async send(value) {
        calls.push(['send', value]);
        const row = sessions.get(value.sessionId), listener = subscriptions.get(row.sessionPath);
        assert.ok(listener, 'register events before send');
        setImmediate(() => listener({ type: 'agent_end', sessionId: row.sessionId, messages: [{ role: 'assistant', content: output, stopReason: 'stop' }] }, row.sessionPath));
        return { accepted: true, sessionId: row.sessionId, sessionPath: row.sessionPath };
      },
      async get({ sessionId }) { return { session: sessions.get(sessionId) }; },
      async list() { return { sessions: [...sessions.values()] }; },
      async abort({ sessionId }) { calls.push(['abort', { sessionId }]); return { aborted: true, sessionId }; },
    },
    bus: { async subscribe(callback, { sessionPath }) {
      subscriptions.set(sessionPath, callback);
      return () => subscriptions.delete(sessionPath);
    } },
  };
  const profiles = { async getRoleModel(role) {
    calls.push(['role', role]);
    assert.equal(role, 'verifier');
    return roleModel ? roleModel() : { role, source: 'saved-role', instanceState: 'active', agentId: 'saved-role-agent', model };
  } };
  const writer = createSummaryWriter({ sdk, profiles, sessions: createResearchSessions(sdk) });
  t.after(async () => { try { await writer.dispose(); } finally { await fs.rm(dataDir, { recursive: true, force: true }); } });
  const prompt = buildPaperMathPrompt({ mainTex: 'Opaque manuscript', ledger: 'Opaque ledger', ...await readPaperMathResources() });
  const input = { kind, projectId: 'project-fixture', reportId: 'report-fixture', prompt, cwd: dataDir, deadlineAt: Date.now() + 5000,
    onBound: binding => calls.push(['bound', binding]), assertActive() {} };
  return { dataDir, writer, input, calls };
}

test('paper math uses a dedicated private Agent, a new shell-free/no-memory session for each review, and the saved verifier model', async t => {
  const f = await fixture(t);
  const results = [], projectId = 'project-01234567-89ab-4def-8123-456789abcdef';
  const reportIds = ['report-01234567-89ab-4def-8123-456789abcdef', 'report-11234567-89ab-4def-8123-456789abcdef'];
  for (const reportId of reportIds) {
    const handle = await f.writer.start({ ...f.input, projectId, reportId });
    const result = await handle.done;
    assert.equal(result.state, 'completed', JSON.stringify(result.errors));
    assert.deepEqual(parsePaperMathReport(result.finalText), { findings: [], report: 'Opaque advisory assessment.', verdict: 'correct' });
    assert.equal(Object.hasOwn(handle, 'resume'), false);
    results.push(result);
  }
  // Legacy summary must have an independent identity, registry and session kind.
  const summary = await f.writer.start({ ...f.input, kind: undefined, reportId: 'report-summary', prompt: 'Opaque legacy fixture' });
  assert.equal((await summary.done).state, 'completed');
  const definitions = f.calls.filter(([op]) => op === 'agent').map(([, value]) => value);
  assert.equal(definitions.length, 2);
  assert.equal(definitions[0].kind, 'paper-math-verifier');
  assert.match(definitions[0].id, /^paper-math-verifier-/);
  assert.notEqual(definitions[0].id, 'saved-role-agent');
  assert.deepEqual(definitions[0].memoryPolicy, { enabled: false });
  assert.match(definitions[0].initialFiles.agents, /ledger is not authenticated/);
  assert.equal(definitions[1].kind, 'math-report-writer');
  assert.notEqual(definitions[1].id, definitions[0].id);
  const launches = f.calls.filter(([op]) => op === 'session').map(([, value]) => value);
  const expectedKinds = reportIds.map(reportId => `math-paper-math-verification:${projectId}:${reportId}`);
  assert.deepEqual(launches.slice(0, 2).map(value => value.kind), expectedKinds);
  assert.deepEqual(f.calls.filter(([op]) => op === 'bound').slice(0, 2).map(([, binding]) => binding.kind), expectedKinds);
  assert.notEqual(results[0].sessionId, results[1].sessionId);
  for (const value of launches.slice(0, 2)) {
    assert.deepEqual(value.model, model);
    assert.equal(value.memoryEnabled, false);
    assert.equal(value.namespace, 'app');
    assert.equal(value.agentId, definitions[0].id);
  }
  assert.ok(results.every(result => result.role === 'report-writer' && result.toolSelection.resolved.length === 0));
  assert.deepEqual(f.calls.filter(([op]) => ['session', 'bound', 'tools', 'readback', 'send'].includes(op)).slice(0, 10).map(([op]) => op),
    ['session', 'bound', 'tools', 'readback', 'send', 'session', 'bound', 'tools', 'readback', 'send']);
  const sends = f.calls.filter(([op]) => op === 'send');
  for (const [, value] of sends.slice(0, 2)) assert.equal(value.text, f.input.prompt);
});

for (const [options, code] of [[{ wrongTools: true }, 'TOOL_SELECTION_UNCONFIRMED'], [{ wrongModel: true }, 'SESSION_MODEL_MISMATCH'],
  [{ absentModel: true }, 'MODEL_NOT_AVAILABLE']]) test(`paper math sends nothing on ${code}`, async t => {
  const f = await fixture(t, options);
  const handle = await f.writer.start(f.input);
  const result = await handle.done;
  assert.equal(result.state, 'failed');
  assert.equal(result.error, code);
  assert.equal(f.calls.filter(([op]) => op === 'send').length, 0);
});

test('a missing or non-saved verifier profile never creates an agent or falls back', async t => {
  let selected;
  const f = await fixture(t, { roleModel: () => selected });
  for (const candidate of [undefined, { role: 'worker', source: 'saved-role', instanceState: 'active', model },
    { role: 'verifier', source: 'fallback', instanceState: 'active', model },
    { role: 'verifier', source: 'saved-role', instanceState: 'deleted', model }]) {
    selected = candidate;
    await assert.rejects(f.writer.start(f.input), { code: 'SAVED_ROLE_INVALID' });
  }
  assert.ok(f.calls.length > 0 && f.calls.every(([op, role]) => op === 'role' && role === 'verifier'));
  assert.deepEqual(await fs.readdir(f.dataDir), []);
});
