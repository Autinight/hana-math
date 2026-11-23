import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createSummaryWriter } from '../packages/hana-math/report-writer.mjs';
import { createResearchSessions } from '../packages/hana-math/research-sessions.mjs';

// Share the existing report store, task fixture and completed-source recipe.
// Only this import's test registrations are suppressed; no product import is replaced.
const fixtureUrl = new URL('./paper-report-service.test.mjs', import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:test' && context.parentURL === fixtureUrl) {
      return { url: 'data:text/javascript,export default function(){}', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const loaded = next(url, context);
    return url === fixtureUrl ? { ...loaded, source: `${loaded.source}\nexport { fixture, completedPaper, owner };` } : loaded;
  },
});
const { fixture, completedPaper, owner } = await import(fixtureUrl).finally(() => hook.deregister());

const kind = 'paper-math-verification';
const model = { provider: 'fixture', id: 'saved-verifier-model' };
const response = '{"findings":[],"report":"Opaque text-only review."}';

async function runFlow(t, mode) {
  const f = await fixture(t);
  const { audit: { sourceReportId } } = await completedPaper(f, undefined, {});
  const sourcePath = `project/reports/${sourceReportId}/main.tex`;
  const original = await f.store.read(sourcePath), changed = Buffer.from(original);
  changed[0] ^= 1;
  const calls = [], updates = [], refusals = [];
  let q, row, listener, toolRead, reachedFault = false;
  f.sdk.dataDir = f.root;
  f.sdk.agents.create = async input => {
    assert.equal(input.kind, 'paper-math-verifier');
    assert.deepEqual(input.memoryPolicy, { enabled: false });
    const agent = { id: input.id, state: 'active', deletedAt: null, visibility: 'plugin_private', ownerPluginId: 'hana-math',
      plugin: { visibility: 'plugin_private', ownerPluginId: 'hana-math', kind: input.kind } };
    f.agents.push(agent);
    return { agent };
  };
  f.sdk.models = { async listAvailable() { calls.push('model-catalog'); return { models: [model] }; } };
  f.sdk.tools = { async list() { assert.fail('tool-less transport must not query the tool catalog'); } };
  f.sdk.bus = { async subscribe(callback, filter) {
    assert.equal(filter.sessionPath, row.sessionPath); listener = callback;
    return () => { listener = null; };
  } };
  f.sdk.sessions.create = async input => {
    calls.push('session-create');
    assert.deepEqual(input.model, model);
    assert.equal(input.memoryEnabled, false);
    assert.equal(input.namespace, 'app');
    assert.equal(input.kind, `math-${kind}:${q.projectId}:${q.reportId}`);
    row = { sessionId: 'paper-math-session', sessionPath: '/fixture/math-transport.jsonl', path: '/fixture/math-transport.jsonl',
      ownerPluginId: 'hana-math', visibility: 'plugin_private', namespace: input.namespace, lifecycle: 'active',
      modelProvider: model.provider, modelId: model.id, agentId: input.agentId, cwd: input.cwd, kind: input.kind };
    f.sessions.set(row.sessionPath, row);
    return { ...row };
  };
  const emptyTools = sessionId => ({ sessionId, toolNames: [], effective: 'current', pendingToolNames: null });
  f.sdk.sessions.setActiveTools = async input => {
    calls.push('setActiveTools');
    assert.deepEqual(input, { sessionId: row.sessionId, toolNames: [] });
    return emptyTools(input.sessionId);
  };
  f.sdk.sessions.getToolSelection = async input => {
    calls.push('getToolSelection');
    assert.deepEqual(input, { sessionId: row.sessionId });
    toolRead = await f.metadata(q);
    if (mode === 'source drift') await f.store.write(sourcePath, changed, true);
    if (mode === 'task canceled') f.tasks.get(q.taskId).status = 'canceled';
    reachedFault = true;
    return emptyTools(input.sessionId);
  };
  f.sdk.sessions.send = async input => {
    calls.push('send');
    assert.equal(input.sessionId, row.sessionId);
    assert.equal(JSON.parse(input.text.trimEnd().split('\n').at(-1)).mainTex, original.toString('utf8'));
    assert.equal(typeof listener, 'function');
    const emit = listener;
    setImmediate(() => emit({ type: 'agent_end', sessionId: row.sessionId,
      messages: [{ role: 'assistant', content: response, stopReason: 'stop' }] }, row.sessionPath));
    return { accepted: true, sessionId: row.sessionId, sessionPath: row.sessionPath };
  };
  const realWriter = createSummaryWriter({ sdk: f.sdk, sessions: createResearchSessions(f.sdk), profiles: {
    async getRoleModel(role) { assert.equal(role, 'verifier'); return { role, source: 'saved-role', instanceState: 'active', model }; },
  } });
  t.after(() => realWriter.dispose());
  t.mock.method(f.writer, 'start', input => {
    assert.equal(input.kind, kind);
    return realWriter.start({ ...input, async onUpdate(snapshot) {
      const { phase, sessionId, sessionPath, state } = snapshot;
      updates.push({ phase, sessionId, sessionPath, state });
      try { return await input.onUpdate(snapshot); }
      catch (error) { refusals.push({ phase, code: error.code }); throw error; }
    } });
  });
  q = await f.rawService.start(f.p, { kind, language: 'English', math: { sourceReportId } }, owner);
  assert.equal(q.state, 'queued');
  await f.dispatch(q);
  const meta = await f.metadata(q);
  assert.deepEqual(updates.slice(0, 2), ['model-catalog', 'session-create'].map(phase => ({ phase, sessionId: null, sessionPath: null, state: 'preparing' })),
    JSON.stringify({ mode, calls, updates, reportState: meta.state, writerError: meta.writer?.error }));
  assert.deepEqual(calls, ['model-catalog', 'session-create', 'setActiveTools', 'getToolSelection', ...(mode === 'success' ? ['send'] : [])]);
  assert.equal(reachedFault, true, 'test reached the real tool-selection readback');
  assert.equal(toolRead.writer.sessionId, row.sessionId, 'real onBound persisted before tool readback');
  assert.equal(toolRead.writer.sessionPath, row.sessionPath);
  const status = await f.rawService.status(f.p, q, owner, { kind });
  const result = await f.rawService.result(f.p, q, owner, { kind });
  const success = mode === 'success';
  assert.equal(status.paperMathGate, success ? 'passed' : 'not-assessed');
  if (success) {
    assert.equal(meta.state, 'completed');
    assert.equal(f.tasks.get(q.taskId).status, 'completed');
    assert.equal(result.status, 'ok');
    assert.equal(result.mathVerdict, 'correct');
    assert.deepEqual(result.files.map(file => file.name), ['MATH_REVIEW.json']);
    assert.equal(f.calls.aborts, 0);
  } else {
    const canceled = mode === 'task canceled';
    assert.equal(meta.state, canceled ? 'stopped' : 'failed');
    assert.equal(f.tasks.get(q.taskId).status, canceled ? 'canceled' : 'failed');
    assert.ok(refusals.some(({ phase, code }) => canceled
      ? code === 'PROJECT_REPORT_TASK_INACTIVE' && ['subscribe', 'send'].includes(phase)
      : code === 'PROJECT_PAPER_MATH_SOURCE_CHANGED' && phase === 'send'), JSON.stringify(refusals));
    assert.equal(result.paperMathGate, 'not-assessed');
    assert.equal(Object.hasOwn(result, 'mathVerdict'), false);
    assert.equal(Object.hasOwn(meta, 'mathVerdict'), false);
    assert.equal(meta.artifacts?.review, undefined);
    assert.equal(f.calls.stages.length, 0);
    assert.ok(f.calls.aborts > 0, 'the created session was stopped after refusal');
  }
  assert.deepEqual(await f.store.read(sourcePath), mode === 'source drift' ? changed : original);
}

for (const mode of ['success', 'source drift', 'task canceled']) {
  test(`paper math real writer/session flow: ${mode}`, { timeout: 10000 }, t => runFlow(t, mode));
}
