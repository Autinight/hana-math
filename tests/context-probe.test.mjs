import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createContextProbe } from '../packages/hana-math/context-probe.mjs';

const model = { provider: 'software-fixture', id: 'read-test' };
const turn = () => new Promise(setImmediate);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const immediateSnapshot = (promise) => Promise.race([promise, turn().then(() => { throw new Error('Snapshot/queued response blocked behind setup or finalization'); })]);
async function fixture(t) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-probe-')));
  const calls = []; const listeners = new Set(); const completed = []; const failed = [];
  const taskRecords = new Map(); const taskStreams = new Map(); const encoder = new TextEncoder(); const texts = new Map();
  let probe, session, selected = ['read'];
  const controls = { readAvailable: true, dirtyContext: false, errorAt: null, completeFails: false, initialTaskStatus: 'pending', watchCancelFails: false, unsubscribeFails: false };
  const track = (name, input) => { calls.push({ name, input: structuredClone(input) }); if (controls.errorAt === name) { const error = new Error('Do not persist raw credentials in errors: fixture-private'); error.code = 'FORBIDDEN'; throw error; } };
  const contexts = { async prepareProbe({ projectId, role }) {
    const probeId = `probe-${randomUUID()}`; const cwd = path.join(dataDir, 'context/projects', projectId, 'probes', probeId, role);
    const paths = ['AGENTS.md', 'PROBLEM.md', 'OPERATOR.md', 'TASK.md', 'CONTEXT.md', 'PATHS.json', 'danus/core/glossary_global.json', 'skills/read/SKILL.md', 'references/common.md', 'READ-PROBE-NONCE.txt'];
    probe = { probeId, projectId, role, cwd, expectedNonce: randomUUID(), requiredReadPaths: paths.map((name) => path.join(cwd, name)), files: paths.map((name) => ({ path: path.join(cwd, name), relativePath: name, sha256: 'a'.repeat(64) })), contractMarkers: { main: '# Main fixture contract', worker: '# Worker fixture contract', verifier: '# Verifier fixture contract' } };
    for (const file of probe.files) {
      const text = file.relativePath === 'READ-PROBE-NONCE.txt' ? probe.expectedNonce : controls.materialText ?? `Software-only file: ${file.relativePath}\nSecond fixture line\nThird fixture line\n`;
      texts.set(file.path, text);
      await fs.mkdir(path.dirname(file.path), { recursive: true }); await fs.writeFile(file.path, text);
      file.sha256 = createHash('sha256').update(text).digest('hex');
    }
    return probe;
  } };
  const sdk = {
    dataDir,
    models: { async listAvailable() { track('models.listAvailable', {}); return { models: [model] }; } },
    agents: { async createFromRole(input) { track('agents.createFromRole', input); return { agent: { id: input.id, visibility: 'plugin_private', ownerPluginId: 'hana-math', roleId: input.roleId } }; } },
    sessions: {
      async create(input) { track('sessions.create', input); session = { sessionId: `session-${randomUUID()}`, sessionPath: `/software-fixture/${randomUUID()}.jsonl`, ...input, visibility: 'plugin_private', modelId: input.model.id, modelProvider: input.model.provider }; return session; },
      async tools(input) { track('sessions.tools', input); return { toolNames: controls.readAvailable ? ['read', 'exec_command', 'write'] : ['exec_command'] }; },
      async setActiveTools(input) { track('sessions.setActiveTools', input); selected = input.toolNames; return { toolNames: selected, pendingToolNames: null, effective: 'current' }; },
      async context(input) { track('sessions.context', input); return { systemPrompt: `${probe.contractMarkers[probe.role]}\nMentions main worker verifier as ordinary words.\n${controls.dirtyContext ? Object.entries(probe.contractMarkers).find(([role]) => role !== probe.role)[1] : ''}` }; },
      async send(input) { track('sessions.send', input); return { accepted: true }; },
      async abort(input) { track('sessions.abort', input); return { aborted: true }; },
    },
    bus: { async subscribe(callback, filter) { track('bus.subscribe', filter); const entry = { callback, filter }; listeners.add(entry); return async () => { track('bus.unsubscribe', {}); listeners.delete(entry); if (controls.unsubscribeFails) throw new Error('unsubscribe failure'); }; } },
    tasks: {
      async create(input) {
        track('tasks.create', input);
        const task = { taskId: `task-${randomUUID()}`, type: 'app:hana-math/read-probe', pluginId: 'hana-math', parentSessionId: input.scope === 'session' ? 'fixture-parent-session' : null, parentSessionPath: input.scope === 'session' ? '/software-fixture/parent.jsonl' : null, status: controls.initialTaskStatus, progress: null, createdAt: Date.now(), updatedAt: Date.now(), delivery: input.delivery, scope: input.scope, chipVisibility: 'show', handlerKey: null, retryable: false, suspension: {}, metadata: input.metadata, ...(['failed', 'canceled', 'aborted'].includes(controls.initialTaskStatus) ? { error: 'Fixture task outcome reason' } : {}) };
        taskRecords.set(task.taskId, task); return structuredClone(task);
      },
      async get(taskId) { track('tasks.get', { taskId }); return taskRecords.get(taskId); },
      async watch(taskId) {
        track('tasks.watch', { taskId });
        let controller;
        const stream = new ReadableStream({ start(value) {
          controller = value;
          if (!taskStreams.has(taskId)) taskStreams.set(taskId, new Set()); taskStreams.get(taskId).add(controller);
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(taskRecords.get(taskId))}\n\n`));
        }, cancel() {
          track('tasks.watch.cancel', { taskId }); taskStreams.get(taskId).delete(controller);
          if (controls.watchCancelFails) throw new Error('reader cancel failure');
        } });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      },
      async complete(taskId, result) { track('tasks.complete', { taskId }); if (controls.completeFails) throw new Error('delivery failed'); completed.push({ taskId, result }); const record = { ...taskRecords.get(taskId), status: 'completed', result, updatedAt: Date.now(), completedAt: Date.now() }; taskRecords.set(taskId, record); return structuredClone(record); },
      async fail(taskId, error) { track('tasks.fail', { taskId }); failed.push({ taskId, error }); const record = { ...taskRecords.get(taskId), status: 'failed', error, updatedAt: Date.now(), completedAt: Date.now() }; taskRecords.set(taskId, record); return structuredClone(record); },
    },
  };
  let service = createContextProbe(sdk, contexts);
  t.after(async () => { await service.dispose(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const emit = (event, sourcePath = session.sessionPath) => { for (const { callback } of listeners) callback(event, sourcePath); };
  // Software-fixture waiting only. Production get is deliberately non-draining.
  const waitForProbe = async (probeId, predicate) => {
    const deadline = Date.now() + 5000; let last;
    do {
      last = await service.get(probeId);
      if (predicate(last)) return last;
      await turn();
    } while (Date.now() < deadline);
    assert.fail(`Fixture state did not settle: ${JSON.stringify(last)}`);
  };
  const settled = (probeId) => waitForProbe(probeId, (record) => !['preparing', 'running'].includes(record.state) && !record.finalizing && !record.setupPending);
  const waitReads = (probeId) => waitForProbe(probeId, (record) => record.readPaths.length === probe.requiredReadPaths.length);
  const enqueue = (context, extra = {}) => service.start({ projectId: 'fixture', role: 'worker', model, ...extra }, context);
  const start = async (context) => {
    const queued = await enqueue(context);
    return waitForProbe(queued.probeId, (record) => !record.setupPending && !record.finalizing);
  };
  const readOne = (file, options = {}) => {
    const toolCallId = `call-${randomUUID()}`;
    const args = options.resource ? { resource: { kind: 'local-file', path: file } } : { path: path.relative(probe.cwd, file) };
    if (options.offset !== undefined) args.offset = options.offset;
    if (options.limit !== undefined) args.limit = options.limit;
    // Mirror the public read tool's non-auto-truncated branch: raw split keeps the EOF empty line.
    const raw = texts.get(file); const lines = raw.split('\n');
    const first = (options.offset || 1) - 1; const end = Math.min(first + (options.limit ?? lines.length), lines.length);
    const body = lines.slice(first, end).join('\n');
    const footer = options.limit !== undefined && end < lines.length && !options.omitFooter ? `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]` : '';
    const text = options.text ?? body + footer;
    emit({ type: 'tool_execution_start', toolCallId, toolName: 'read', args });
    emit({ type: 'tool_execution_end', toolCallId, toolName: 'read', result: { content: [{ type: 'text', text }], ...(options.truncated ? { truncated: true } : {}), ...(options.details ? { details: options.details } : {}) }, isError: options.error === true });
  };
  const reads = (options = {}) => {
    for (const [index, file] of probe.requiredReadPaths.entries()) {
      if (options.omit === index) continue;
      const spec = { resource: index % 2 === 1, error: options.error === index, ...(options.limit === undefined ? {} : { limit: options.limit }) };
      if (options.pageSize) {
        const lines = texts.get(file).split('\n');
        const offsets = Array.from({ length: Math.ceil(lines.length / options.pageSize) }, (_, page) => page * options.pageSize + 1);
        if (options.reverse) offsets.reverse();
        for (const offset of offsets) readOne(file, { ...spec, offset, limit: options.pageSize });
      } else readOne(file, spec);
    }
  };
  const end = (extra = {}) => emit({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: `Read marker: ${probe.expectedNonce}` }] }], ...extra });
  const taskEvent = (taskId, status, type = 'app-task') => {
    taskRecords.set(taskId, { ...taskRecords.get(taskId), status, updatedAt: Date.now(), ...(['failed', 'canceled', 'aborted'].includes(status) ? { error: 'Fixture host task reason' } : {}) });
    for (const controller of taskStreams.get(taskId) || []) controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(taskRecords.get(taskId))}\n\n`));
  };
  return { sdk, contexts, controls, calls, listeners, taskRecords, taskStreams, taskEvent, completed, failed, dataDir, texts, emit, readOne, reads, end, start, enqueue, settled, waitReads, waitForProbe, get probe() { return probe; }, get session() { return session; }, get service() { return service; }, restart(options) { service = createContextProbe(sdk, contexts, options); return service; } };
}

test('setup is inference-free; explicit start uses isolated role/session, selects read only, subscribes before send', async (t) => {
  const f = await fixture(t); await turn(); assert.equal(f.calls.length, 0);
  const started = await f.start({ callToken: 'software-only-token' });
  assert.equal(started.state, 'running'); assert.equal(f.completed.length, 0);
  assert.deepEqual(started.modelSelection, { source: 'not-provided', agentId: null });
  const agent = f.calls.find((call) => call.name === 'agents.createFromRole').input;
  assert.match(agent.id, /^hana-math-probe-worker-/); assert.equal(agent.importMemory, false);
  const create = f.calls.find((call) => call.name === 'sessions.create').input;
  assert.equal(create.cwd, f.probe.cwd); assert.equal(create.memoryEnabled, false); assert.equal(create.namespace, 'app'); assert.deepEqual(create.model, model);
  assert.deepEqual(f.calls.find((call) => call.name === 'sessions.setActiveTools').input.toolNames, ['read']);
  assert.ok(f.calls.findIndex((call) => call.name === 'bus.subscribe') < f.calls.findIndex((call) => call.name === 'sessions.send'));
  const sent = f.calls.find((call) => call.name === 'sessions.send').input.text;
  assert.equal(sent.includes(f.probe.expectedNonce), false); assert.match(sent, /Only read is allowed/);
  assert.match(sent, /Hana read-probe adapter/); assert.doesNotMatch(sent, /\p{Script=Han}/u);
  assert.match(sent, /offset is 1-based/); assert.match(sent, /remaining-lines/);
  const task = f.calls.find((call) => call.name === 'tasks.create').input;
  assert.equal(task.scope, 'session'); assert.equal(task.delivery, 'next-step'); assert.equal(task.callToken, 'software-only-token');
  const stored = await fs.readFile(path.join(f.dataDir, `context/probe-runs/${started.probeId}.json`), 'utf8');
  assert.doesNotMatch(stored, /software-only-token|expectedNonce|credentials/);
  f.reads(); f.end(); const result = await f.settled(started.probeId);
  assert.equal(result.state, 'passed'); assert.equal(result.nonceSeen, true); assert.equal(result.readPaths.length, 10);
  assert.equal(result.taskDelivery, 'recorded'); assert.equal(f.completed.length, 1); assert.equal(f.listeners.size, 0);
});

test('model is mandatory and must match catalog exactly before Agent creation', async (t) => {
  const f = await fixture(t);
  for (const input of [undefined, { provider: model.provider, id: 'invented' }, { ...model, endpoint: 'not-allowed' }]) await assert.rejects(f.service.start({ projectId: 'fixture', role: 'worker', model: input }));
  assert.equal(f.calls.some((call) => call.name === 'agents.createFromRole'), false);
});

test('model claim alone, missing required read and failed read can never pass', async (t) => {
  for (const scenario of ['claim', 'missing', 'failed']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t); const started = await f.start();
      if (scenario === 'missing') f.reads({ omit: 2 });
      if (scenario === 'failed') f.reads({ error: 2 });
      f.end(); const result = await f.settled(started.probeId);
      assert.equal(result.state, 'failed'); assert.equal(f.completed.length, 0); assert.equal(f.failed.length, 1);
      assert.equal(result.error, scenario === 'failed' ? 'READ_FAILED' : 'REQUIRED_READ_MISSING');
      assert.equal(f.calls.find((call) => call.name === 'tasks.create').input.scope, 'app');
      assert.equal(Object.hasOwn(f.calls.find((call) => call.name === 'tasks.create').input, 'callToken'), false);
    });
  }
});

test('retry agent_end does not complete; final assistant nonce is mandatory, not reasoning or user text', async (t) => {
  const f = await fixture(t); const started = await f.start(); f.reads(); f.end({ willRetry: true });
  assert.equal((await f.waitReads(started.probeId)).state, 'running'); assert.equal(f.completed.length, 0);
  f.end({ messages: [{ role: 'user', content: f.probe.expectedNonce }, { role: 'assistant', content: [{ type: 'thinking', text: f.probe.expectedNonce }, { type: 'text', text: 'I claim success' }] }] });
  const result = await f.settled(started.probeId); assert.equal(result.state, 'failed'); assert.equal(result.error, 'NONCE_NOT_CONFIRMED');
});

test('foreign session events are ignored and unmatched end/outside paths/unselected tools are refused', async (t) => {
  for (const scenario of ['outside', 'tool', 'unmatched']) await t.test(scenario, async (t) => {
    const f = await fixture(t); const started = await f.start();
    f.emit({ type: 'agent_end', messages: [] }, '/foreign/session');
    assert.equal((await f.service.get(started.probeId)).state, 'running');
    if (scenario === 'unmatched') f.emit({ type: 'tool_execution_end', toolCallId: 'unknown', isError: false, result: { content: [{ type: 'text', text: 'fake' }] } });
    else f.emit({ type: 'tool_execution_start', toolCallId: 'test', toolName: scenario === 'tool' ? 'exec_command' : 'read', args: { path: scenario === 'outside' ? '../private/AGENTS.md' : f.probe.requiredReadPaths[0] } });
    const result = await f.settled(started.probeId); assert.equal(result.state, 'failed'); assert.equal(result.abortOutcome, 'aborted'); assert.equal(f.completed.length, 0);
  });
});

test('foreign known role heading rejects context but ordinary mentions of other roles do not', async (t) => {
  const f = await fixture(t); f.controls.dirtyContext = true;
  const started = await f.start(); assert.equal(started.state, 'failed'); assert.equal(started.error, 'FOREIGN_ROLE_CONTRACT');
  assert.equal(f.calls.some((call) => call.name === 'sessions.send'), false);
});

test('permission refusal/read-tool absence/setup failure never sends a model request and retains safe diagnostics', async (t) => {
  for (const errorAt of ['sessions.create', 'sessions.setActiveTools', 'bus.subscribe']) await t.test(errorAt, async (t) => {
    const f = await fixture(t); f.controls.errorAt = errorAt;
    const started = await f.start(); assert.equal(started.state, 'failed'); assert.equal(started.error, 'FORBIDDEN');
    assert.equal(f.calls.some((call) => call.name === 'sessions.send'), false); assert.equal(f.listeners.size, 0);
    assert.doesNotMatch(JSON.stringify(started), /fixture-private/);
  });
  const f = await fixture(t); f.controls.readAvailable = false;
  assert.equal((await f.start()).error, 'READ_TOOL_UNAVAILABLE');
});

test('180-second deadline aborts exact recorded session and unsubscribes; late events cannot resurrect success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t); const started = await f.start();
  t.mock.timers.tick(180000);
  const result = await f.settled(started.probeId);
  assert.equal(result.state, 'timed-out'); assert.equal(result.error, 'PROBE_TIMEOUT'); assert.equal(result.abortOutcome, 'aborted');
  assert.equal(f.calls.find((call) => call.name === 'sessions.abort').input.sessionId, f.session.sessionId);
  assert.equal(f.listeners.size, 0); f.reads(); f.end(); assert.equal((await f.settled(started.probeId)).state, 'timed-out');
});

test('explicit stop and dispose stop only owned probes and never purge Agent records', async (t) => {
  const f = await fixture(t); const a = await f.start();
  assert.equal((await f.service.stop(a.probeId)).state, 'stopped');
  const b = await f.start(); await f.service.dispose();
  assert.equal((await f.settled(b.probeId)).state, 'stopped'); assert.equal(f.listeners.size, 0);
  assert.equal(f.calls.filter((call) => call.name === 'sessions.abort').length, 2);
  await assert.rejects(f.service.stop('missing'), { code: 'ENOENT' });
  await assert.rejects(f.start(), { code: 'PROBE_DISPOSED' });
});

test('recovery aborts recorded unfinished own sessions and marks interrupted without model replay', async (t) => {
  const f = await fixture(t); const started = await f.start(); await f.service.dispose();
  const filename = path.join(f.dataDir, `context/probe-runs/${started.probeId}.json`);
  const record = JSON.parse(await fs.readFile(filename)); record.state = 'running'; await fs.writeFile(filename, JSON.stringify(record));
  const before = f.calls.length; f.restart();
  const result = await f.settled(started.probeId); assert.equal(result.state, 'interrupted');
  assert.deepEqual(f.calls.slice(before).map((call) => call.name), ['sessions.abort', 'tasks.fail']);
  assert.equal(result.abortOutcome, 'aborted'); assert.match(result.limitation, /unexpected App crash/);
  assert.equal((await f.service.stop(started.probeId)).state, 'interrupted');
  assert.equal(f.calls.findLast((call) => call.name === 'sessions.abort').input.sessionId, record.sessionId);
});

test('deferred probe startup leaves unrelated history untouched and verifies only the explicit stop target', async t => {
  for (const count of [0, 16, 2]) await t.test(`${count === 2 ? 'unfinished' : 'finished'}: ${count}`, async t => {
    const f = await fixture(t);
    await f.service.dispose();
    const sdkSessions = new Map(), records = [];
    f.sdk.sessions.get = async ({ sessionId }) => { f.calls.push({ name: 'sessions.get', input: { sessionId } }); return { session: sdkSessions.get(sessionId) }; };
    f.sdk.sessions.list = async ({ agentId }) => { f.calls.push({ name: 'sessions.list', input: { agentId } }); return { sessions: [...sdkSessions.values()].filter(s => s.agentId === agentId) }; };
    for (let i = 0; i < count; ++i) {
      const probeId = `probe-${randomUUID()}`, projectId = `fixture-${i}`, role = 'worker';
      const taskId = `historic-task-${i}`, sessionId = `historic-session-${i}`, agentId = `hana-math-probe-worker-${randomUUID()}`;
      const cwd = path.join(f.dataDir, 'context/projects', projectId, 'probes', probeId, role), sessionPath = `/software-fixture/${sessionId}.jsonl`;
      const record = { schemaVersion: 1, probeId, projectId, role, state: count === 2 ? 'running' : 'passed',
        taskId, sessionId, sessionPath, agentId, cwd, sendState: 'accepted', sendPending: false, setupPending: false,
        finalizing: false, cleanupPending: false, taskDelivery: count === 2 ? 'pending' : 'recorded' };
      const file = path.join(f.dataDir, 'context/probe-runs', `${probeId}.json`);
      sdkSessions.set(sessionId, { sessionId, path: sessionPath, agentId, cwd, ownerPluginId: 'hana-math',
        visibility: 'plugin_private', namespace: 'app', kind: null, lifecycle: 'active' });
      f.taskRecords.set(taskId, { taskId, scope: 'app', pluginId: 'hana-math', handlerKey: null, status: 'pending', metadata: { probeId, projectId, role } });
      await fs.writeFile(file, JSON.stringify(record)); records.push({ file, record });
    }
    await f.restart({ deferHistoricalWork: true }).recoveryReady;
    for (const { file, record } of records) {
      assert.deepEqual(await f.service.get(record.probeId), record);
      assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(record));
    }
    assert.deepEqual(f.calls, []);
    if (count === 2) {
      const [{ record }, other] = records;
      const row = sdkSessions.get(record.sessionId);
      row.cwd = sdkSessions.get(other.record.sessionId).cwd;
      const failed = await f.service.stop(record.probeId);
      assert.equal(failed.state, 'running');
      assert.equal(failed.cleanupPending, true);
      assert.equal(failed.abortError, 'STOP_SESSION_MISMATCH');
      assert.deepEqual(f.calls.splice(0).map(c => c.name), ['sessions.get', 'sessions.list']);
      row.cwd = record.cwd;
      f.taskRecords.get(record.taskId).metadata.probeId = other.record.probeId;
      const unbound = await f.service.stop(record.probeId);
      assert.equal(unbound.state, 'running');
      assert.equal(unbound.taskDeliveryError, 'TASK_RECEIPT_INVALID');
      assert.deepEqual(f.calls.splice(0).map(c => c.name), ['sessions.get', 'sessions.list', 'sessions.abort', 'tasks.get']);
      f.taskRecords.get(record.taskId).metadata.probeId = record.probeId;
      const [stopped, sameStop] = await Promise.all([f.service.stop(record.probeId), f.service.stop(record.probeId)]);
      assert.deepEqual(stopped, sameStop);
      assert.equal(stopped.state, 'stopped');
      assert.equal(stopped.cleanupPending, false);
      assert.deepEqual(f.calls.splice(0), [{ name: 'tasks.get', input: { taskId: record.taskId } },
        { name: 'tasks.fail', input: { taskId: record.taskId } }]);
      assert.equal(f.failed.at(-1).taskId, record.taskId);
      assert.equal(await fs.readFile(other.file, 'utf8'), JSON.stringify(other.record));
      const fresh = await f.start();
      assert.equal(fresh.state, 'running');
      await f.service.dispose(); f.calls.length = 0;
    } else await f.service.dispose();
    assert.deepEqual(f.calls, []);
    await f.restart().recoveryReady;
    assert.deepEqual(f.calls.map(c => c.name), count === 2 ? ['sessions.abort', 'tasks.fail'] : []);
  });
});

test('an automatic retry can later pass, but final context must still match the role', async (t) => {
  for (const dirtyContext of [false, true]) await t.test(String(dirtyContext), async (t) => {
    const f = await fixture(t); const started = await f.start(); f.reads(); f.end({ willRetry: true });
    assert.equal((await f.waitReads(started.probeId)).state, 'running');
    f.controls.dirtyContext = dirtyContext; f.end();
    const result = await f.settled(started.probeId);
    assert.equal(result.state, dirtyContext ? 'failed' : 'passed');
    if (dirtyContext) assert.equal(result.error, 'FOREIGN_ROLE_CONTRACT');
  });
});

test('events arriving before send acceptance cannot turn a rejected send into a pass', async (t) => {
  const f = await fixture(t); let entered, release;
  const sending = new Promise((resolve) => { entered = resolve; });
  f.sdk.sessions.send = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
  const starting = f.start(); await sending;
  f.reads(); f.end(); release({ accepted: false });
  const result = await starting; assert.equal(result.state, 'failed'); assert.equal(result.error, 'TURN_NOT_ACCEPTED');
  assert.equal((await f.settled(result.probeId)).state, 'failed'); assert.equal(f.completed.length, 0);
});

test('timeout during session creation prevents send and aborts the late session by its actual returned ID', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t); const original = f.sdk.sessions.create; const originalAbort = f.sdk.sessions.abort;
  let entered, release, aborted;
  const creating = new Promise((resolve) => { entered = resolve; });
  const lateAbort = new Promise((resolve) => { aborted = resolve; });
  f.sdk.sessions.create = async (input) => { const result = await original(input); entered(); return new Promise((resolve) => { release = () => resolve(result); }); };
  f.sdk.sessions.abort = async (input) => { const result = await originalAbort(input); aborted(input); return result; };
  const starting = f.start(); await creating; t.mock.timers.tick(180000);
  const result = await starting; assert.equal(result.state, 'timed-out'); assert.equal(result.sessionId, null);
  release(); assert.equal((await lateAbort).sessionId, f.session.sessionId);
  assert.equal(f.calls.some((call) => call.name === 'sessions.send'), false);
  await turn();
});

test('changed or symlinked diagnostic files invalidate apparently successful read events', async (t) => {
  for (const link of [false, true]) await t.test(String(link), async (t) => {
    const f = await fixture(t); const started = await f.start();
    const target = f.probe.requiredReadPaths[0];
    if (link) { await fs.unlink(target); await fs.symlink(f.probe.requiredReadPaths[1], target); }
    else await fs.writeFile(target, 'changed after preparation');
    f.reads(); f.end(); const result = await f.settled(started.probeId);
    assert.equal(result.state, 'failed'); assert.equal(result.error, link ? 'SYMLINK_REFUSED' : 'PROBE_FILE_CHANGED');
  });
});

test('persistence failure during completion still unsubscribes and aborts instead of leaving a live model', async (t) => {
  const f = await fixture(t); const started = await f.start();
  const file = path.join(f.dataDir, `context/probe-runs/${started.probeId}.json`);
  await fs.unlink(file); await fs.symlink(f.probe.requiredReadPaths[0], file);
  const result = await f.service.stop(started.probeId);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'PERSISTENCE_FAILED');
  assert.equal(result.abortOutcome, 'aborted'); assert.equal(f.listeners.size, 0);
});

test('all added contextual documents must have actual successful read traces', async (t) => {
  for (const name of ['OPERATOR.md', 'CONTEXT.md', 'PATHS.json', 'danus/core/glossary_global.json']) await t.test(name, async (t) => {
    const f = await fixture(t); const started = await f.start();
    f.reads({ omit: f.probe.requiredReadPaths.indexOf(path.join(f.probe.cwd, name)) }); f.end();
    const result = await f.settled(started.probeId);
    assert.equal(result.state, 'failed'); assert.equal(result.error, 'REQUIRED_READ_MISSING');
  });
});

for (const status of ['canceled', 'aborted']) test(`host task ${status} is observed by SSE and aborts its bound session`, async (t) => {
  const f = await fixture(t); const started = await f.start();
  f.taskEvent(started.taskId, status);
  assert.equal(f.taskRecords.get(started.taskId).error, 'Fixture host task reason');
  await turn();
  const result = await f.settled(started.probeId);
  assert.equal(result.state, 'stopped'); assert.equal(result.error, `HOST_TASK_${status.toUpperCase()}`);
  assert.equal(result.hostTaskStatus, status); assert.equal(result.taskDelivery, 'recorded');
  assert.equal(result.abortOutcome, 'aborted'); assert.equal(f.listeners.size, 0);
  assert.equal(f.taskStreams.get(started.taskId).size, 0);
  assert.equal(f.calls.find((call) => call.name === 'sessions.abort').input.sessionId, started.sessionId);
});

test('canceled first task snapshot prevents Agent/session creation and inference', async (t) => {
  const f = await fixture(t); f.controls.initialTaskStatus = 'canceled';
  const result = await f.start(); assert.equal(result.state, 'stopped');
  assert.equal(f.calls.some((call) => ['agents.createFromRole', 'sessions.create', 'sessions.send'].includes(call.name)), false);
  assert.equal(f.taskStreams.get(result.taskId).size, 0);
});

test('host cancellation during pending session creation aborts the late returned session and never sends', async (t) => {
  const f = await fixture(t); const original = f.sdk.sessions.create; let entered, release;
  const creating = new Promise((resolve) => { entered = resolve; });
  f.sdk.sessions.create = async (input) => { const session = await original(input); entered(); return new Promise((resolve) => { release = () => resolve(session); }); };
  const starting = f.start(); await creating;
  const taskId = [...f.taskRecords.keys()][0]; f.taskEvent(taskId, 'aborted');
  const stopped = await starting; assert.equal(stopped.state, 'stopped'); assert.equal(stopped.sessionId, null);
  release(); await f.service.dispose();
  const result = await f.settled(stopped.probeId);
  assert.equal(result.sessionId, f.session.sessionId); assert.equal(result.abortOutcome, 'aborted');
  assert.equal(f.calls.some((call) => call.name === 'sessions.send'), false);
});

test('SSE reset reconciles task state through get instead of treating reset data as a fresh grant', async (t) => {
  const f = await fixture(t); const started = await f.start();
  f.taskEvent(started.taskId, 'canceled', 'reset'); await turn();
  const result = await f.settled(started.probeId);
  assert.equal(result.state, 'stopped'); assert.ok(f.calls.some((call) => call.name === 'tasks.get'));
});

test('late watch response is canceled after bounded opening timeout, with no model start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t); const original = f.sdk.tasks.watch; let entered, release;
  const opening = new Promise((resolve) => { entered = resolve; });
  f.sdk.tasks.watch = async (id) => { const response = await original(id); entered(); return new Promise((resolve) => { release = () => resolve(response); }); };
  const starting = f.start(); await opening; t.mock.timers.tick(10000);
  const result = await starting; assert.equal(result.state, 'failed'); assert.equal(result.error, 'CONTROL_TIMEOUT');
  release(); await f.service.dispose();
  assert.equal(f.taskStreams.get(result.taskId).size, 0);
  assert.equal(f.calls.some((call) => call.name === 'sessions.send'), false);
});

test('late event unsubscribe and reader-cancel failures remain visible after host cancellation', async (t) => {
  const f = await fixture(t); const original = f.sdk.bus.subscribe; let entered, release;
  const subscribing = new Promise((resolve) => { entered = resolve; });
  f.controls.unsubscribeFails = true; f.controls.watchCancelFails = true;
  f.sdk.bus.subscribe = async (...args) => { const unsubscribe = await original(...args); entered(); return new Promise((resolve) => { release = () => resolve(unsubscribe); }); };
  const starting = f.start(); await subscribing;
  const taskId = [...f.taskRecords.keys()][0]; f.taskEvent(taskId, 'canceled');
  const result = await starting; release(); await f.service.dispose();
  const final = await f.service.stop(result.probeId);
  assert.equal(final.error, 'HOST_TASK_CANCELED'); assert.equal(final.watchCleanup, 'failed'); assert.equal(final.subscriptionCleanup, 'failed');
  assert.ok(final.errors.some((entry) => entry.operation === 'event-unsubscribe'));
  assert.ok(final.errors.some((entry) => entry.operation === 'task-watch-cancel'));
  assert.equal(f.calls.some((call) => call.name === 'sessions.send'), false);
});

test('recovery abort and task delivery errors survive explicit stop and remain in history after retry', async (t) => {
  const f = await fixture(t); const started = await f.start(); await f.service.dispose();
  const filename = path.join(f.dataDir, `context/probe-runs/${started.probeId}.json`);
  const record = JSON.parse(await fs.readFile(filename)); record.state = 'running'; await fs.writeFile(filename, JSON.stringify(record));
  f.controls.errorAt = 'sessions.abort'; const originalFail = f.sdk.tasks.fail;
  f.sdk.tasks.fail = async () => { const error = new Error('private fixture message'); error.code = 'DELIVERY_DENIED'; throw error; };
  f.restart(); const recovered = await f.settled(started.probeId);
  assert.equal(recovered.state, 'interrupted'); assert.equal(recovered.abortOutcome, 'failed'); assert.equal(recovered.taskDelivery, 'failed');
  const stopped = await f.service.stop(started.probeId);
  assert.equal(stopped.state, 'interrupted'); assert.equal(stopped.error, 'PROCESS_RESTARTED');
  assert.equal(stopped.abortError, 'FORBIDDEN'); assert.equal(stopped.taskDeliveryError, 'DELIVERY_DENIED');
  assert.doesNotMatch(JSON.stringify(stopped), /private fixture message/);
  f.controls.errorAt = null; f.sdk.tasks.fail = originalFail;
  const retried = await f.service.stop(started.probeId);
  assert.equal(retried.abortOutcome, 'aborted'); assert.equal(retried.taskDelivery, 'recorded');
  assert.ok(retried.errors.some((entry) => entry.code === 'DELIVERY_DENIED'));
});

for (const mode of ['stop', 'timeout']) test(`late accepted send after ${mode} triggers a second exact abort and leaves no successful probe`, async (t) => {
  if (mode === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t); const originalAbort = f.sdk.sessions.abort; let entered, release, live = false;
  const sending = new Promise((resolve) => { entered = resolve; });
  f.sdk.sessions.send = () => { entered(); return new Promise((resolve) => { release = () => { live = true; resolve({ accepted: true }); }; }); };
  f.sdk.sessions.abort = async (input) => { const result = await originalAbort(input); live = false; return result; };
  const starting = f.start(); await sending;
  if (mode === 'timeout') t.mock.timers.tick(180000);
  else await f.service.stop(f.probe.probeId);
  const stopped = await starting;
  assert.equal(stopped.state, mode === 'stop' ? 'stopped' : 'timed-out');
  assert.equal(stopped.sendPending, true); assert.equal(stopped.cleanupPending, true);
  assert.equal(stopped.abortOutcome, 'awaiting-send-receipt', 'idle abort cannot confirm a pending send was stopped');
  assert.equal(f.calls.filter((call) => call.name === 'sessions.abort').length, 1);
  release(); await f.service.dispose();
  const final = await f.settled(stopped.probeId);
  assert.equal(final.state, stopped.state); assert.equal(final.sendPending, false); assert.equal(final.lateSendReceipt, true);
  assert.equal(final.cleanupPending, false); assert.equal(final.abortOutcome, 'aborted'); assert.equal(live, false);
  assert.deepEqual(f.calls.filter((call) => call.name === 'sessions.abort').map((call) => call.input.sessionId), [f.session.sessionId, f.session.sessionId]);
  assert.equal(f.completed.length, 0); assert.equal(f.listeners.size, 0); assert.equal(f.taskStreams.get(final.taskId).size, 0);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, `context/probe-runs/${final.probeId}.json`)));
  assert.equal(saved.abortOutcome, 'aborted'); assert.equal(saved.cleanupPending, false);
});

test('dispose bounds its wait for a still-unaccepted send, and a later receipt still aborts after disposal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t); let entered, release;
  const sending = new Promise((resolve) => { entered = resolve; });
  f.sdk.sessions.send = () => { entered(); return new Promise((resolve) => { release = () => resolve({ accepted: true }); }); };
  const starting = f.start(); await sending;
  const disposing = f.service.dispose(); const initial = await starting; await turn(); t.mock.timers.tick(10000); await disposing;
  const pending = await f.settled(initial.probeId);
  assert.equal(pending.cleanupPending, true); assert.equal(pending.abortOutcome, 'awaiting-send-receipt');
  release(); await f.service.dispose();
  const final = await f.settled(initial.probeId);
  assert.equal(final.cleanupPending, false); assert.equal(final.abortOutcome, 'aborted'); assert.notEqual(final.state, 'passed');
  assert.equal(f.calls.filter((call) => call.name === 'sessions.abort').length, 2);
});

test('late send cleanup still aborts if result persistence becomes unavailable', async (t) => {
  const f = await fixture(t); let entered, release;
  const sending = new Promise((resolve) => { entered = resolve; });
  f.sdk.sessions.send = () => { entered(); return new Promise((resolve) => { release = () => resolve({ accepted: true }); }); };
  const starting = f.start(); await sending; await f.service.stop(f.probe.probeId); const stopped = await starting;
  const filename = path.join(f.dataDir, `context/probe-runs/${stopped.probeId}.json`);
  await fs.unlink(filename); await fs.symlink(f.probe.requiredReadPaths[0], filename);
  release(); await f.service.dispose();
  const final = await f.settled(stopped.probeId);
  assert.equal(final.persistence, 'failed'); assert.equal(final.abortOutcome, 'aborted');
  assert.equal(f.calls.filter((call) => call.name === 'sessions.abort').length, 2); assert.equal(f.completed.length, 0);
});

test('late-send abort failure keeps cleanup pending rather than reusing the earlier idle abort', async (t) => {
  const f = await fixture(t); let entered, release;
  const sending = new Promise((resolve) => { entered = resolve; });
  f.sdk.sessions.send = () => { entered(); return new Promise((resolve) => { release = () => resolve({ accepted: true }); }); };
  const starting = f.start(); await sending; await f.service.stop(f.probe.probeId); const stopped = await starting;
  f.controls.errorAt = 'sessions.abort'; release(); await f.service.dispose();
  const final = await f.settled(stopped.probeId);
  assert.equal(final.state, 'stopped'); assert.equal(final.abortOutcome, 'failed'); assert.equal(final.cleanupPending, true);
  assert.equal(final.abortError, 'FORBIDDEN'); assert.equal(f.completed.length, 0);
});

test('one-line reads of every file plus the real nonce do not establish full-read coverage', async (t) => {
  const f = await fixture(t); const started = await f.start(); f.reads({ limit: 1 }); f.end();
  const result = await f.settled(started.probeId);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'REQUIRED_READ_MISSING');
  assert.equal(result.readPaths.length, 1, 'only the one-line nonce was fully returned');
  assert.ok(result.readCoverage.some((entry) => entry.totalLines === 4 && entry.ranges[0][1] === 1));
  assert.equal(f.completed.length, 0);
});

for (const reverse of [false, true]) test(`full paginated original text passes with merged coverage (reverse=${reverse})`, async (t) => {
  const f = await fixture(t); f.controls.materialText = 'First line\r\nSecond line\r\nThird line\r\n';
  const started = await f.start(); f.reads({ pageSize: 2, reverse }); f.end();
  const result = await f.settled(started.probeId);
  assert.equal(result.state, 'passed'); assert.equal(result.readPaths.length, 10);
  assert.ok(result.readCoverage.every((entry) => entry.ranges.length === 1 && entry.ranges[0][0] === 1 && entry.ranges[0][1] === entry.totalLines));
});

test('re-reading one page cannot cover the missing lines', async (t) => {
  const f = await fixture(t); const started = await f.start();
  f.reads({ limit: 1 }); f.reads({ limit: 1 }); f.end();
  const result = await f.settled(started.probeId);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'REQUIRED_READ_MISSING');
});

for (const output of ['truncated', 'formatted', 'incorrect']) test(`${output} read output fails closed even when nonempty`, async (t) => {
  const f = await fixture(t); const started = await f.start(); const file = f.probe.requiredReadPaths[0];
  const text = output === 'truncated' ? `${f.texts.get(file).split('\n')[0]}\n[more lines omitted]` : output === 'formatted' ? `1: ${f.texts.get(file)}` : 'not the original file';
  f.readOne(file, { text, truncated: output === 'truncated' });
  const result = await f.settled(started.probeId);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'READ_CONTENT_UNVERIFIABLE'); assert.equal(f.completed.length, 0);
});

test('oversized diagnostic lines fail explicitly before any Agent or model call without changing originals', async (t) => {
  const f = await fixture(t); f.controls.materialText = 'x'.repeat(24 * 1024 + 1);
  const result = await f.start();
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'DIAGNOSTIC_MATERIAL_TOO_LARGE');
  assert.equal(result.evidencePolicy.maxLineBytes, 24 * 1024);
  assert.equal(f.calls.some((call) => ['agents.createFromRole', 'sessions.send'].includes(call.name)), false);
  assert.equal(await fs.readFile(f.probe.requiredReadPaths[0], 'utf8'), f.controls.materialText);
});

test('a failed task receipt with its business error is confirmed recorded', async (t) => {
  const f = await fixture(t); const started = await f.start(); f.end();
  const result = await f.settled(started.probeId);
  const task = f.taskRecords.get(result.taskId);
  assert.equal(result.state, 'failed'); assert.equal(task.status, 'failed'); assert.equal(typeof task.error, 'string');
  assert.equal(result.taskDelivery, 'recorded'); assert.equal(result.taskDeliveryError, undefined);
});

for (const verb of ['complete', 'fail']) for (const defect of ['taskId', 'terminalStatus', 'okFalse']) test(`${verb} task receipt rejects ${defect}`, async (t) => {
  const f = await fixture(t); const original = f.sdk.tasks[verb];
  f.sdk.tasks[verb] = async (...args) => {
    const record = await original(...args);
    if (defect === 'taskId') return { ...record, taskId: 'foreign-fixture-task' };
    if (defect === 'terminalStatus') return { ...record, status: verb === 'complete' ? 'failed' : 'completed', error: 'Legitimate business reason, but wrong terminal state' };
    return { ...record, ok: false, error: 'Operation rejected' };
  };
  const started = await f.start(); if (verb === 'complete') f.reads(); f.end();
  const result = await f.settled(started.probeId);
  assert.equal(result.taskDelivery, 'failed');
  assert.equal(result.taskDeliveryError, defect === 'okFalse' ? 'HOST_OPERATION_FAILED' : 'TASK_RECEIPT_INVALID');
});

for (const defect of ['taskId', 'status', 'okFalse']) test(`create task receipt rejects ${defect} before starting an Agent`, async (t) => {
  const f = await fixture(t); const original = f.sdk.tasks.create;
  f.sdk.tasks.create = async (input) => {
    const record = await original(input);
    return defect === 'taskId' ? { ...record, taskId: '' } : defect === 'status' ? { ...record, status: 'unknown-state' } : { ...record, ok: false, error: 'Operation rejected' };
  };
  const result = await f.start(); assert.equal(result.state, 'failed');
  assert.equal(result.error, defect === 'okFalse' ? 'HOST_OPERATION_FAILED' : 'TASK_NOT_CREATED');
  assert.equal(f.calls.some((call) => call.name === 'agents.createFromRole'), false);
});

for (const channel of ['watch', 'get']) for (const defect of ['taskId', 'status', 'okFalse']) test(`${channel} task snapshot rejects ${defect}`, async (t) => {
  const f = await fixture(t); const started = await f.start();
  const task = f.taskRecords.get(started.taskId);
  const invalid = defect === 'taskId' ? { ...task, taskId: 'foreign-fixture-task', status: 'canceled', error: 'Business reason' } : defect === 'status' ? { ...task, status: 'unknown-state' } : { ...task, ok: false, error: 'Operation rejected' };
  if (channel === 'get') { f.sdk.tasks.get = async () => invalid; f.taskEvent(started.taskId, 'running', 'reset'); }
  else for (const controller of f.taskStreams.get(started.taskId)) controller.enqueue(new TextEncoder().encode(`event: app-task\ndata: ${JSON.stringify(invalid)}\n\n`));
  await turn(); const result = await f.settled(started.probeId);
  assert.equal(result.state, 'failed'); assert.equal(result.error, defect === 'okFalse' ? 'HOST_OPERATION_FAILED' : 'TASK_WATCH_INVALID');
});

for (const material of ['First\nSecond\nThird', 'First\nSecond\nThird\n', 'First\r\nSecond\r\nThird\r\n']) test(`read footer and EOF coverage preserve source line semantics: ${JSON.stringify(material)}`, async (t) => {
  const f = await fixture(t); f.controls.materialText = material;
  const started = await f.start(); f.reads({ pageSize: 1 }); f.end();
  const result = await f.settled(started.probeId);
  assert.equal(result.state, 'passed');
  const coverage = result.readCoverage.find((entry) => entry.path.endsWith('/AGENTS.md'));
  assert.equal(coverage.totalLines, material.split('\n').length);
  assert.deepEqual(coverage.ranges, [[1, material.split('\n').length]]);
  assert.equal(result.requiredReadPlan.find((entry) => entry.path.endsWith('/AGENTS.md')).totalLines, coverage.totalLines);
});

for (const defect of ['count', 'nextOffset', 'body', 'missingBodyLine', 'extraFooter']) test(`requested-page output rejects forged ${defect}`, async (t) => {
  const f = await fixture(t); const started = await f.start(); const file = f.probe.requiredReadPaths[0];
  const lines = f.texts.get(file).split('\n'); const body = lines.slice(0, 2).join('\n');
  const footer = `\n\n[${lines.length - 2} more lines in file. Use offset=3 to continue.]`;
  const text = defect === 'count' ? body + footer.replace(`${lines.length - 2} more`, '999 more')
    : defect === 'nextOffset' ? body + footer.replace('offset=3', 'offset=4')
      : defect === 'body' ? body.replace('Second', 'Altered') + footer
        : defect === 'missingBodyLine' ? lines[0] + footer : body + footer + footer;
  f.readOne(file, { offset: 1, limit: 2, text });
  const result = await f.settled(started.probeId);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'READ_CONTENT_UNVERIFIABLE');
});

test('literal footer-like source text is never stripped as metadata', async (t) => {
  const f = await fixture(t); f.controls.materialText = 'Original\n\n[2 more lines in file. Use offset=4 to continue.]\nActual last line';
  const started = await f.start(); f.reads({ pageSize: 3 }); f.end();
  assert.equal((await f.settled(started.probeId)).state, 'passed');
  const g = await fixture(t); g.controls.materialText = f.controls.materialText;
  const other = await g.start(); const file = g.probe.requiredReadPaths[0];
  g.readOne(file, { text: 'Original\n\nActual last line' });
  assert.equal((await g.settled(other.probeId)).error, 'READ_CONTENT_UNVERIFIABLE');
});

for (const kind of ['automaticTruncation', 'middleClippedOldDetails']) test(`${kind} remains unverified`, async (t) => {
  const f = await fixture(t); const started = await f.start(); const file = f.probe.requiredReadPaths[0];
  const lines = f.texts.get(file).split('\n');
  const text = kind === 'automaticTruncation' ? `${lines[0]}\n\n[Showing lines 1-1 of ${lines.length}. Use offset=2 to continue.]` : `${lines[0]}\n[... middle clipped ...]\n${lines.at(-2)}\n`;
  const details = { truncation: { truncated: kind === 'automaticTruncation', totalLines: lines.length, outputLines: lines.length, content: f.texts.get(file) } };
  f.readOne(file, { limit: lines.length, text, details });
  const result = await f.settled(started.probeId);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'READ_CONTENT_UNVERIFIABLE');
});

test('a correct raw requested page is also accepted without a remaining-lines footer', async (t) => {
  const f = await fixture(t); const started = await f.start();
  for (const file of f.probe.requiredReadPaths) {
    const total = f.texts.get(file).split('\n').length;
    for (let offset = 1; offset <= total; offset += 2) f.readOne(file, { offset, limit: 2, omitFooter: true });
  }
  f.end(); assert.equal((await f.settled(started.probeId)).state, 'passed');
});

test('start returns durable queued IDs before slow session setup and records saved-role provenance without reusing that Agent', async (t) => {
  const gate = deferred(); const entered = deferred(); t.after(() => gate.resolve());
  const f = await fixture(t); const original = f.sdk.sessions.create;
  f.sdk.sessions.create = async (input) => { entered.resolve(); await gate.promise; return original(input); };
  const source = { source: 'saved-role', agentId: 'hana-math-worker-saved-fixture' };
  const starting = f.enqueue({ callToken: 'only-current-invocation-token' }, { modelSelection: source });
  await entered.promise;
  const queued = await immediateSnapshot(starting);
  assert.equal(queued.state, 'preparing'); assert.equal(queued.setupState, 'queued'); assert.equal(queued.setupPending, true);
  assert.ok(queued.probeId); assert.ok(queued.taskId); assert.equal(queued.sessionId, null);
  assert.deepEqual(queued.modelSelection, source);
  const status = await immediateSnapshot(f.service.get(queued.probeId));
  assert.equal(status.phase, 'session-create'); assert.equal(status.setupPending, true);
  const durable = JSON.parse(await fs.readFile(path.join(f.dataDir, `context/probe-runs/${queued.probeId}.json`)));
  assert.equal(durable.taskId, queued.taskId); assert.deepEqual(durable.modelSelection, source);
  assert.doesNotMatch(JSON.stringify(durable), /only-current-invocation-token/);
  assert.equal(f.calls.find((call) => call.name === 'tasks.create').input.callToken, 'only-current-invocation-token');
  for (const call of f.calls.filter((entry) => entry.name !== 'tasks.create')) assert.doesNotMatch(JSON.stringify(call.input), /only-current-invocation-token/);
  gate.resolve(); await f.waitForProbe(queued.probeId, (record) => !record.setupPending && !record.finalizing);
  assert.notEqual(f.session.agentId, source.agentId); assert.match(f.session.agentId, /^hana-math-probe-worker-/);
  assert.deepEqual(f.session.model, model);
  f.reads(); f.end(); const result = await f.settled(queued.probeId);
  assert.equal(result.state, 'passed'); assert.deepEqual(result.modelSelection, source);
});

test('running status does not wait for queued read events while send acceptance is delayed', async (t) => {
  const gate = deferred(); const entered = deferred(); t.after(() => gate.resolve({ accepted: true }));
  const f = await fixture(t);
  f.sdk.sessions.send = () => { entered.resolve(); return gate.promise; };
  const starting = f.enqueue(); await entered.promise;
  const queued = await immediateSnapshot(starting); assert.equal(queued.setupState, 'queued');
  f.reads({ pageSize: 2 }); f.end();
  const status = await immediateSnapshot(f.service.get(queued.probeId));
  assert.equal(status.state, 'running'); assert.equal(status.sendPending, true); assert.equal(status.setupPending, true);
  assert.equal(status.phase, 'send'); assert.equal(status.readPaths.length, 0);
  gate.resolve({ accepted: true });
  const result = await f.settled(queued.probeId); assert.equal(result.state, 'passed'); assert.equal(result.readPaths.length, 10);
});

test('status exposes terminal finalizing state without waiting for task publication, retaining its later failure', async (t) => {
  const gate = deferred(); const entered = deferred(); t.after(() => gate.resolve());
  const f = await fixture(t);
  f.sdk.tasks.complete = async () => { entered.resolve(); await gate.promise; const error = new Error('publication fixture'); error.code = 'FORBIDDEN'; throw error; };
  const started = await f.start(); f.reads(); f.end(); await entered.promise;
  const status = await immediateSnapshot(f.service.get(started.probeId));
  assert.equal(status.state, 'passed'); assert.equal(status.finalizing, true); assert.equal(status.taskDelivery, 'pending');
  gate.resolve(); const result = await f.settled(started.probeId);
  assert.equal(result.finalizing, false); assert.equal(result.taskDelivery, 'failed'); assert.equal(result.taskDeliveryError, 'FORBIDDEN');
});

test('invalid provenance shapes are rejected before catalog/task creation and cannot claim saved-role origin', async (t) => {
  const f = await fixture(t);
  for (const selection of [null, [], {}, { source: 'external', agentId: 'a' }, { source: 'saved-role', agentId: '' }, { source: 'saved-role', agentId: '../a' }, { source: 'saved-role', agentId: 'a', callToken: 'extra' }, Object.assign(Object.create({ source: 'saved-role' }), { agentId: 'a' })]) {
    await assert.rejects(f.enqueue({}, { modelSelection: selection }), { code: 'INVALID_MODEL_SELECTION' });
  }
  assert.equal(f.calls.length, 0);
});

for (const action of ['stop', 'timeout', 'dispose']) test(`queued background session setup handles ${action} and a late session without sending`, async (t) => {
  if (action === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred(); const entered = deferred(); t.after(() => gate.resolve());
  const f = await fixture(t); const original = f.sdk.sessions.create;
  f.sdk.sessions.create = async (input) => { const result = await original(input); entered.resolve(); await gate.promise; return result; };
  const queued = await f.enqueue(); await entered.promise;
  if (action === 'timeout') t.mock.timers.tick(180000);
  else if (action === 'stop') await f.service.stop(queued.probeId);
  else { const disposing = f.service.dispose(); await f.settled(queued.probeId); gate.resolve(); await disposing; }
  const stopped = await f.settled(queued.probeId);
  assert.equal(stopped.state, action === 'timeout' ? 'timed-out' : 'stopped');
  gate.resolve(); await f.service.dispose();
  const final = await immediateSnapshot(f.service.get(queued.probeId));
  assert.equal(final.abortOutcome, 'aborted'); assert.equal(f.calls.some((call) => call.name === 'sessions.send'), false);
  assert.equal(f.completed.length, 0);
});

test('an error after queued return terminates that same task and record', async (t) => {
  const gate = deferred(); const entered = deferred(); t.after(() => gate.resolve());
  const f = await fixture(t);
  f.sdk.sessions.create = async () => { entered.resolve(); await gate.promise; const error = new Error('setup denied'); error.code = 'FORBIDDEN'; throw error; };
  const starting = f.enqueue(); await entered.promise; const queued = await immediateSnapshot(starting);
  gate.resolve(); const failed = await f.settled(queued.probeId);
  assert.equal(failed.state, 'failed'); assert.equal(failed.error, 'FORBIDDEN'); assert.equal(failed.taskId, queued.taskId);
  assert.equal(failed.taskDelivery, 'recorded'); assert.equal(f.calls.filter((call) => call.name === 'tasks.create').length, 1);
  assert.equal(f.failed[0].taskId, queued.taskId); assert.equal(f.calls.some((call) => call.name === 'sessions.send'), false);
});

test('task publication failure stays explicit and does not rewrite successful read evidence as delivered', async (t) => {
  const f = await fixture(t); f.controls.completeFails = true;
  const started = await f.start(); f.reads(); f.end();
  const result = await f.settled(started.probeId);
  assert.equal(result.state, 'passed'); assert.equal(result.taskDelivery, 'failed'); assert.equal(f.failed.length, 0);
});
