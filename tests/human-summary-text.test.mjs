import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { factBundle } from '../packages/hana-math/human-summary.mjs';
import { createSummaryWriter } from '../packages/hana-math/report-writer.mjs';
import { createResearchSessions } from '../packages/hana-math/research-sessions.mjs';
const A = '0123456789abcdef';
const f = body => [{ fact_id: A, predecessors: [], markdown: `---\nfact_id: ${A}\n---\n## statement\n${body}` }];
const guard = () => {};
const profiles = { async getRoleModel(role) { return { role, source: 'saved-role', instanceState: 'active', agentId: 'saved-verifier', model: { provider: 'saved', id: 'model' } }; } };

test('complete locator replacement preserves unrelated code, math, arXiv and URLs', () => {
  const output = factBundle(f(`fact_id ${A}; factId: <${A}>; \`fact_id ${A}\`; fact_graph/facts/${A}.md; runtime/projects/p-1/fact_graph/facts/${A}.md; \`see ${A}\`.\n$x^2$ \\nabla u; arXiv:2401.12345 https://example.org/${A}`));
  assert.doesNotMatch(output, /fact_graph\/facts|fact_id|factId/);
  assert.ok(output.includes('`see Result 1`')); assert.ok(output.includes('`Result 1`'));
  assert.ok(output.includes('https://example.org/' + A)); assert.ok(output.includes('arXiv:2401.12345'));
  assert.ok(output.includes('$x^2$ \\nabla u')); assert.ok(output.startsWith('--- Result 1 ---\n## statement\n'));
});
test('unknown internal IDs, slugs and paths refuse before writer', () => {
  for (const body of ['unknown ' + 'f'.repeat(16), 'fact_unproved', 'fact_graph/facts/missing.md', 'factId missing']) {
    assert.throws(() => factBundle(f(body)), { code: 'PROJECT_SUMMARY_UNRESOLVED_REFERENCE' });
  }
});
async function setup(t, patch = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'writer-test-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls = []; let id;
  const sdk = { dataDir, agents: {
    async create(input) { calls.push(['create', input]); if (patch.create) return patch.create(input); id = input.id;
      return { agent: { id, ownerPluginId: 'hana-math', visibility: 'plugin_private' } }; },
    async list(input) { calls.push(['list', input]); const row = { id, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private',
      plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'math-report-writer' } };
      return { agents: [patch.row ? patch.row(row) : row] }; },
  } };
  return { dataDir, sdk, calls };
}
const input = { projectId: 'project-p', reportId: 'report-r', prompt: 'Opaque report input.', cwd: '/fixture', deadlineAt: Date.now() + 60000,
  onBound: async () => ({ ok: true }), assertActive: guard };

test('dedicated writer agent uses configured verifier model without verifier persona', async t => {
  const { sdk, calls } = await setup(t), starts = [];
  const sessions = { start(value) { starts.push(value); return { done: Promise.resolve({ cleanupPending: false }), stop: async () => ({ cleanupPending: false }) }; },
    dispose: async () => ({ cleanupPending: false, errors: [] }) };
  const writer = createSummaryWriter({ sdk, sessions, profiles }); const handle = await writer.start(input); await handle.done;
  assert.equal(starts.length, 1); assert.notEqual(starts[0].selection.agentId, 'saved-verifier');
  assert.deepEqual(starts[0].selection.model, { provider: 'saved', id: 'model' });
  assert.equal(starts[0].role, 'report-writer'); assert.deepEqual(starts[0].toolNames, []);
  const created = calls.find(c => c[0] === 'create')[1];
  assert.equal(created.kind, 'math-report-writer'); assert.equal(created.memoryPolicy.enabled, false);
  assert.match(created.initialFiles.agents, /report author/); assert.doesNotMatch(created.initialFiles.agents, /verification_report/);
  assert.deepEqual(calls.filter(c => c[0] === 'list').map(c => c[1].scope), ['own']);
  await writer.dispose();
});
test('foreign writer identity and unknown creation receipt fail without a session', async t => {
  for (const patch of [{ row: row => ({ ...row, ownerPluginId: 'foreign' }) }, { create: async () => ({}) }]) {
    const { sdk } = await setup(t, patch); let starts = 0;
    const sessions = { start() { starts++; }, dispose: async () => ({ cleanupPending: false, errors: [] }) };
    const writer = createSummaryWriter({ sdk, sessions, profiles });
    await assert.rejects(writer.start(input), { code: patch.row ? 'REPORT_WRITER_IDENTITY_UNCONFIRMED' : 'REPORT_WRITER_CREATE_UNCONFIRMED' });
    assert.equal(starts, 0); await writer.dispose();
  }
});
test('cancel during agent creation prevents late model session creation', async t => {
  let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const { sdk } = await setup(t, { create: async value => { entered(); await gate;
    return { agent: { id: value.id, ownerPluginId: 'hana-math', visibility: 'plugin_private' } }; } });
  let cancelled = false, starts = 0;
  const writer = createSummaryWriter({ sdk, profiles, sessions: { start() { starts++; }, dispose: async () => ({ cleanupPending: false, errors: [] }) } });
  const pending = writer.start({ ...input, assertActive() { if (cancelled) throw Object.assign(new Error('stop'), { code: 'PROJECT_SUMMARY_STOPPED' }); } });
  const rejected = assert.rejects(pending, { code: 'PROJECT_SUMMARY_STOPPED' }); await started; cancelled = true; release(); await rejected;
  assert.equal(starts, 0); await writer.dispose();
});
test('real session selection independently rejects a nonempty empty-tools readback before send', async t => {
  const calls = []; const model = { provider: 'saved', id: 'model' };
  const sdk = { models: { listAvailable: async () => ({ models: [model] }) },
    sessions: { create: async value => ({ ok: true, sessionId: 's', sessionPath: '/s', path: '/s', ownerPluginId: 'hana-math', visibility: 'plugin_private',
      namespace: 'app', agentId: value.agentId, cwd: value.cwd, modelProvider: model.provider, modelId: model.id, kind: value.kind }),
      setActiveTools: async ({ sessionId }) => ({ sessionId, toolNames: [], effective: 'current', pendingToolNames: null }),
      getToolSelection: async ({ sessionId }) => { calls.push('readback'); return { sessionId, toolNames: ['read'], effective: 'current', pendingToolNames: null }; },
      send: async () => { calls.push('send'); return {}; }, abort: async () => ({ aborted: true }),
      get: async () => { throw new Error('cleanup unavailable fixture'); } }, bus: { subscribe: async () => () => {} } };
  const sessions = createResearchSessions(sdk); t.after(() => sessions.dispose());
  const handle = sessions.start({ ...input, role: 'report-writer', toolless: true, toolNames: [], selection: { agentId: 'dedicated', model } });
  const outcome = await handle.done; assert.equal(outcome.error, 'TOOL_SELECTION_UNCONFIRMED'); assert.deepEqual(calls, ['readback']);
});
