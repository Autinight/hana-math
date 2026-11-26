// Opaque software fixtures only; Host operations are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createContextStore } from '../packages/hana-math/context-service.mjs';
import { createProjectReportService } from '../packages/hana-math/project-report-service.mjs';
import { capturePaperMaterial } from '../packages/hana-math/paper-source.mjs';
import { capturePlanMaterial } from '../packages/hana-math/paper-plan.mjs';
import { createSummaryWriter } from '../packages/hana-math/report-writer.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { fixture as projectFixture, origin as projectOwner } from './helpers/project-service-fixture.mjs';
const fid = 'a'.repeat(16), creator = { sessionId: 'creator', sessionPath: '/fixture/creator' };
const owner = { callToken: 'real-host-token', sessionPath: creator.sessionPath };
const fact = { fact_id: fid, predecessors: [], markdown: `---\nfact_id: ${fid}\npredecessors: []\n---\n## statement\nOpaque claim.\n## proof\nOpaque proof.\n` };
const digest = text => createHash('sha256').update(text).digest('hex');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const validOutput = (extra, provenance = {}) => `\\documentclass{article}\n\\begin{document}\nOpaque text. ${extra ?? ''}\n\\end{document}\n%%%PROVENANCE%%%\n${JSON.stringify(provenance)}`;
async function fixture(t, { references = false, plan = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paper-report-'))), store = createContextStore(root);
  const p = { meta: { projectId: 'project-paper', creator } }, tasks = new Map(), schedules = new Map();
  const calls = { writer: [], stages: [], gather: [], assertions: 0, literature: [], aborts: 0 }, sessions = new Map(), agents = [];
  const sourceFact = references ? { ...fact, markdown: fact.markdown.replace('predecessors: []\n', 'predecessors: []\nexternal_refs: ' + JSON.stringify([
    { key: 'Alpha', authors: ['Opaque Author'], title: 'Opaque Alpha', year: '2020', venue: 'Fixture' },
    { key: 'Beta', authors: ['Opaque Author'], title: 'Opaque Beta', year: '2021', venue: 'Fixture' }]) + '\n') } : fact;
  let started = defer();
  let output = defer(), lastBinding = {}, terminalSnapshot, abortReceipt = true;
  let handler, revoked = false, stageFailure = 0, drift = 0, facts = [sourceFact], asOf = 'one', sequence = 0, service, beforePrompt, createReceipt, beforeBound, onSessionList;
  const changeFacts = () => { facts = [{ ...fact, markdown: fact.markdown + 'Changed.' }]; asOf = 'two'; };
  const target = { schemaVersion: 1, projectId: p.meta.projectId, paperId: 'main', factIds: [fid], factDigests: { [fid]: digest(sourceFact.markdown) }, finalizedBy: 'creator', at: 1 };
  const base = { paperId: 'main', target, brief: 'Opaque brief', instructions: 'Opaque instructions' };
  const args = plan ? { projectId: p.meta.projectId, kind: 'paper-plan', language: 'English', plan: { ...base,
    material: capturePlanMaterial({ facts, target, asOf }).material } }
    : { kind: 'paper-source', language: 'English', paper: { ...base, material: capturePaperMaterial({ facts, target, asOf }).material } };
  const admission = plan ? { authorize: async () => {}, guard() { if (revoked) throw Object.assign(new Error('target'), { code: 'PROJECT_PAPER_TARGET_CHANGED' }); },
    gather: async () => ({ facts: structuredClone(facts), asOf }) } : undefined;
  const sdk = { agents: { async list() { return { agents: structuredClone(agents) }; } },
    sessions: {
      async get(ref) { const row = ref.sessionId ? [...sessions.values()].find(r => r.sessionId === ref.sessionId) : sessions.get(ref.sessionPath); return { session: row ? structuredClone(row) : null }; },
      async list(input) { onSessionList?.(); return { sessions: [...sessions.values()].filter(r => !input.agentId || r.agentId === input.agentId).map(r => structuredClone(r)) }; },
      async context({ sessionId }) { return { sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }; },
      async abort({ sessionId }) { calls.aborts++; return { sessionId, aborted: abortReceipt }; },
    }, resources: { async stage(input) {
    calls.stages.push(input); if (calls.stages.length === stageFailure) throw Object.assign(new Error('stage'), { code: 'HOST_UNAVAILABLE' });
    return { resource: { kind: 'session-file', sessionId: creator.sessionId, fileId: `file-${calls.stages.length}` } };
  } }, tasks: {
    async registerHandler(_name, value) { handler = value; return () => {}; },
    async create(input) { const task = { ...input, taskId: `task-${++sequence}`, pluginId: 'hana-math', parentSessionId: creator.sessionId, parentSessionPath: creator.sessionPath, status: 'pending' }; tasks.set(task.taskId, task); const receipt = structuredClone(task); createReceipt?.(receipt); return receipt; },
    async get(id) { return structuredClone(tasks.get(id)); },
    async schedule(input) { const row = { ...input, pluginId: 'hana-math', scheduleId: `schedule-${++sequence}` }; schedules.set(row.scheduleId, row); return structuredClone(row); },
    async unschedule(id) { schedules.delete(id); return { ok: true }; },
    async complete(id, result) { tasks.get(id).status = 'completed'; tasks.get(id).result = structuredClone(result); return structuredClone(tasks.get(id)); },
    async fail(id) { tasks.get(id).status = 'failed'; return structuredClone(tasks.get(id)); },
    async getDelivery() { return { state: 'published', delivered: false }; },
  } };
  const writer = { async start(input) {
    output = defer(); calls.writer.push(input); lastBinding = {}; terminalSnapshot = null;
    let binding = {};
    if (input.kind === 'paper-plan') {
      binding = { role: 'report-writer', agentId: 'math-paper-planner-01234567-89ab-cdef-0123-456789abcdef', sessionId: `plan-fixture-${sequence}`,
        sessionPath: `/fixture/plan-${sequence}.jsonl`, cwd: input.cwd, kind: `math-paper-plan:${input.projectId}:${input.reportId}`, sendState: 'not-sent', sendPending: false };
      sessions.set(binding.sessionPath, { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', lifecycle: 'active' });
      if (!agents.some(row => row.id === binding.agentId)) agents.push({ id: binding.agentId, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'math-report-writer' } });
      lastBinding = binding; await beforeBound?.(); await input.onBound(binding); await input.onUpdate({ ...binding, state: 'running', cleanupPending: true });
    } else if (input.kind === 'paper-math-verification') {
      binding = { role: 'report-writer', agentId: 'paper-math-verifier-01234567-89ab-cdef-0123-456789abcdef', sessionId: `math-fixture-${sequence}`,
        sessionPath: `/fixture/math-${sequence}.jsonl`, cwd: input.cwd, kind: `math-paper-math-verification:${input.projectId}:${input.reportId}`,
        sendState: 'not-sent', sendPending: false };
      sessions.set(binding.sessionPath, { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', lifecycle: 'active' });
      if (!agents.some(row => row.id === binding.agentId)) agents.push({ id: binding.agentId, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private',
        plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'paper-math-verifier' } });
      lastBinding = binding;
      await beforeBound?.(); await input.onBound(binding); await input.onUpdate({ ...binding, state: 'running', cleanupPending: true });
    } else if (input.kind === 'reference-verification') {
      binding = { role: 'reference-verifier', agentId: 'math-reference-verifier-01234567-89ab-cdef-0123-456789abcdef', sessionId: `verifier-fixture-${sequence}`,
        sessionPath: `/fixture/verifier-${sequence}.jsonl`, cwd: input.cwd, kind: `math-reference-verification:${input.projectId}:${input.reportId}` };
      sessions.set(binding.sessionPath, { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', lifecycle: 'active' });
      if (!agents.length) agents.push({ id: binding.agentId, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'math-reference-verifier' } });
      lastBinding = binding;
      await beforeBound?.(); await input.onBound(binding); await input.onUpdate({ ...binding, state: 'running', cleanupPending: true });
    } else if (input.kind === 'paper-revision' && input.revisionMode === 'operator-notes') {
      binding = { role: 'paper-reviser', agentId: 'math-paper-reviser-01234567-89ab-cdef-0123-456789abcdef', sessionId: `notes-fixture-${sequence}`,
        sessionPath: `/fixture/notes-${sequence}.jsonl`, cwd: input.cwd, kind: `math-paper-revision:${input.projectId}:${input.reportId}` };
      sessions.set(binding.sessionPath, { ...binding, path: binding.sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', lifecycle: 'active' });
      if (!agents.some(row => row.id === binding.agentId)) agents.push({ id: binding.agentId, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'math-paper-reviser' } });
      lastBinding = binding;
      await beforeBound?.(); await input.onBound(binding); await input.onUpdate({ ...binding, state: 'running', cleanupPending: true });
    }
    started.resolve(); started = defer();
    return { done: output.promise, async stop() { const result = terminalSnapshot ?? { ...binding, state: 'stopped', cleanupPending: false }; output.resolve(result); return result; } };
  }, async dispose() { return { cleanupPending: false }; } };
  async function open(options = {}) {
    service = await createProjectReportService({ sdk, store, summaryWriter: writer,
      literature: { async search(query, count) { calls.literature.push([query, count]); return { query, count, results: [] }; } },
      async authorizeCreator(_p, ctx) { if (ctx !== owner) throw Object.assign(new Error('denied'), { code: 'CREATOR_DENIED' }); },
      projects: () => [p], getProject: () => p, assertLive() {}, track: (_p, job) => job, projectLocation: () => 'project',
      readInput: async () => { beforePrompt?.(); return { problem: 'Opaque problem' }; },
      async assertPaperTarget(id, received) { calls.assertions++; assert.equal(id, p.meta.projectId); assert.deepEqual(received, target); if (revoked) throw Object.assign(new Error('changed'), { code: 'PROJECT_PAPER_TARGET_CHANGED' }); },
      async gatherPaperFacts(id, authority, received) { calls.gather.push(id); assert.deepEqual(received, target); assert.equal(Object.hasOwn(authority, 'callToken'), false); await authority.guard(); authority.assertActive(); if (drift-- > 0) throw Object.assign(new Error('drift'), { code: 'PROJECT_SUMMARY_GRAPH_CHANGED' }); return { facts: structuredClone(facts), asOf }; },
      async withPaperPublication(id, authority, received, callback) { assert.equal(id, p.meta.projectId); assert.deepEqual(received, target); await authority.guard(); authority.assertActive(); if (revoked) throw Object.assign(new Error('changed'), { code: 'PROJECT_PAPER_TARGET_CHANGED' }); return callback({ facts: structuredClone(facts), asOf }); },
      ...options,
    });
  }
  await open();
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { p, args, calls, tasks, schedules, store, open, sessions, agents, sdk, writer, root,
    beforeBound: action => { beforeBound = action; }, onSessionList: action => { onSessionList = action; }, abortReceipt: value => { abortReceipt = value; }, get started() { return started.promise; },
    get rawService() { return service; },
    get service() { return { ...service, ...Object.fromEntries(['status', 'result', 'stop'].map(method =>
      [method, (p, args, ctx) => service[method](p, args, ctx, { kind: 'paper-source' })])) }; },
    start: () => service.start(p, args, owner, admission),
    replay: event => handler.run(event),
    abortTask: taskId => handler.abort(taskId),
    dispatch: (q, nonce) => { const row = [...schedules.values()].find(s => s.payload.reportId === q.reportId); return handler.run({ kind: 'schedule', scheduleId: row.scheduleId, input: { ...row.payload, ...(nonce ? { nonce } : {}) } }); },
    complete: text => output.resolve({ ...lastBinding, state: 'completed', modelStopReason: 'stop', cleanupPending: false, finalText: text }),
    terminal: snapshot => { terminalSnapshot = { ...lastBinding, model: null, toolSelection: null, ...snapshot }; output.resolve(terminalSnapshot); },
    revoke: () => { revoked = true; }, failStage: n => { stageFailure = n; }, drift: n => { drift = n; },
    changeFacts, restoreFacts: () => { facts = [sourceFact]; asOf = 'one'; }, beforePrompt: action => { beforePrompt = action; }, createReceipt: action => { createReceipt = action; },
    advance: () => { facts = [...facts, { ...fact, fact_id: 'b'.repeat(16) }]; asOf = 'two'; },
    metadata: q => store.readJson(`project/reports/${q.reportId}/metadata.json`),
    artifact: (q, name) => store.read(`project/reports/${q.reportId}/${name}`),
  };
}
test('deferred report startup performs no historical Host work with empty, finished or unfinished history', async t => {
  for (const count of [0, 16, 2]) await t.test(`${count === 2 ? 'unfinished' : 'finished'}: ${count}`, async t => {
    const f = await fixture(t);
    await f.rawService.dispose();
    const calls = [];
    for (const name of ['get', 'complete', 'fail', 'getDelivery', 'unschedule']) {
      const original = f.sdk.tasks[name];
      f.sdk.tasks[name] = (...args) => { calls.push([name, args[0]]); return original(...args); };
    }
    f.sdk.tasks.getSchedule = async id => { calls.push(['getSchedule', id]); return f.schedules.get(id) ?? null; };
    const history = [];
    for (let i = 0; i < count; i++) {
      const reportId = `report-${randomUUID()}`, dir = `project/reports/${reportId}`;
      const taskId = `historical-task-${i}`, scheduleId = count === 2 ? `historical-schedule-${i}` : null;
      const nonce = 'f'.repeat(48), body = `Archived summary ${i}\n`;
      const { projectId } = f.p.meta;
      const meta = { schemaVersion: 1, projectId, reportId, state: scheduleId ? 'queued' : 'completed', language: 'English',
        creator, taskId, taskSettlement: 'pending', scheduleId, scheduleCleaned: false, nonce, taskCreating: false,
        scheduleCreating: false, writerStarting: false, cleanupPending: false, stopRequested: false,
        ...(scheduleId ? {} : { artifact: `${dir}/report.md`, bytes: Buffer.byteLength(body), sha256: digest(body), leakFindings: [] }) };
      f.tasks.set(taskId, { taskId, status: 'pending', pluginId: 'hana-math', scope: 'session', handlerKey: 'math-project-report',
        delivery: 'next-step', parentSessionId: creator.sessionId, parentSessionPath: creator.sessionPath, metadata: { projectId, reportId } });
      if (scheduleId) f.schedules.set(scheduleId, { scheduleId, pluginId: 'hana-math', scope: 'app', handlerKey: 'math-project-report', payload: { projectId, reportId, nonce } });
      else await f.store.write(meta.artifact, body);
      await f.store.write(`${dir}/metadata.json`, JSON.stringify(meta));
      history.push({ meta, dir, body });
    }
    await f.open({ deferHistoricalWork: true });
    assert.deepEqual(calls, []);
    for (const { meta, dir } of history) assert.deepEqual(await f.store.readJson(`${dir}/metadata.json`), meta);
    if (count === 2) {
      const [{ meta }, { meta: other }] = history;
      const args = { reportId: meta.reportId };
      assert.equal(f.rawService.dashboardShutdownIdle(), false);
      await assert.rejects(f.rawService.status(f.p, args, {}), { code: 'CREATOR_DENIED' });
      assert.equal((await f.rawService.status(f.p, args, owner)).state, 'queued');
      await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
      assert.deepEqual(await f.replay({ kind: 'schedule', scheduleId: meta.scheduleId, input: meta }), { status: 'ignored' });
      assert.deepEqual(await f.abortTask(meta.taskId), { status: 'ignored' });
      assert.deepEqual(calls, []);
      f.schedules.get(meta.scheduleId).payload.reportId = other.reportId;
      const unresolved = await f.rawService.stop(f.p, args, owner);
      assert.equal(unresolved.state, 'queued');
      assert.equal(unresolved.recoveryPending, true);
      assert.deepEqual(calls.splice(0), [['getSchedule', meta.scheduleId]]);
      f.schedules.get(meta.scheduleId).payload.reportId = meta.reportId;
      assert.equal((await f.rawService.stop(f.p, args, owner)).state, 'stopped');
      assert.deepEqual(calls.splice(0), [['getSchedule', meta.scheduleId], ['unschedule', meta.scheduleId],
        ['get', meta.taskId], ['fail', meta.taskId], ['getDelivery', meta.taskId]]);
      assert.equal(f.tasks.get(other.taskId).status, 'pending');
      assert.equal(await f.rawService.dispose().then(r => r.cleanupPending), true);
      assert.deepEqual(calls, []);
      await f.open();
      assert.equal((await f.rawService.status(f.p, { reportId: other.reportId }, owner)).state, 'interrupted');
      assert.deepEqual(calls.map(([name]) => name), ['unschedule', 'get', 'fail', 'getDelivery']);
    } else {
      if (history.length) {
        const [{ meta, dir, body }, { meta: foreign }] = history;
        assert.equal((await f.rawService.status(f.p, meta, owner)).state, 'completed');
        assert.equal((await f.rawService.result(f.p, meta, owner)).report, body);
        const foreignPath = `another-project/reports/${foreign.reportId}/report.md`;
        await f.store.write(foreignPath, body);
        await f.store.write(`${dir}/metadata.json`, JSON.stringify({ ...meta, artifact: foreignPath }), true);
        await f.rawService.dispose();
        await f.open({ deferHistoricalWork: true });
        const stages = f.calls.stages.length;
        await assert.rejects(f.rawService.result(f.p, meta, owner), { code: 'PROJECT_REPORT_ARTIFACT_INVALID' });
        assert.equal(f.calls.stages.length, stages);
      }
      await f.rawService.dispose();
      assert.deepEqual(calls, []);
      await f.open();
      assert.equal(calls.filter(([name]) => name === 'get').length, count);
    }
    assert.deepEqual(f.calls.writer, []);
    assert.deepEqual(f.calls.gather, []);
  });
});

test('deferred report metadata is cold, project-scoped, and shared by concurrent authorized operations', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.rawService.dispose();
  const projects = new Map(), entries = new Map(), reads = [];
  const project = id => {
    const p = { meta: { projectId: id, creator } };
    projects.set(id, p);
    return p;
  };
  const projectLocation = p => `projects/${p.meta.projectId}`;
  const selected = project('project-selected'), selectedDir = `${projectLocation(selected)}/reports`;
  const body = 'Archived summary from the selected project.\n';
  function seed(p, state) {
    const reportId = `report-${randomUUID()}`, dir = `${projectLocation(p)}/reports`;
    let history = entries.get(dir);
    if (!history) entries.set(dir, history = new Map());
    const meta = { schemaVersion: 1, projectId: p.meta.projectId, reportId, creator, state, language: 'English',
      taskId: null, taskCreating: false, scheduleId: null, scheduleCreating: false, scheduleCleaned: false,
      writerStarting: false, cleanupPending: false, stopRequested: false,
      taskSettlement: state === 'completed' ? 'confirmed' : 'pending', nonce: 'f'.repeat(48), delivery: null,
      artifact: `${dir}/${reportId}/report.md`, sha256: digest(body), bytes: Buffer.byteLength(body), leakFindings: [] };
    history.set(reportId, meta);
    return meta;
  }
  const saved = seed(selected, 'completed'), blocker = seed(selected, 'queued');
  await f.store.write(saved.artifact, body);
  for (let i = 0; i < 24; i++) {
    const p = project(`project-unrelated-${i}`);
    for (let j = 0; j < 4; j++) seed(p, j === 0 ? 'queued' : 'completed');
  }
  const listing = defer(), release = defer(), initiallyAuthorized = defer();
  const revocableOwner = { ...owner };
  let holdSelected = false, revoked = false, inventories = 0;
  t.after(release.resolve);
  await f.open({ deferHistoricalWork: true, projectLocation, getProject: id => projects.get(id),
    projects: () => { inventories++; return projects.values(); },
    async authorizeCreator(_p, ctx) {
      if (ctx === owner) return;
      if (ctx === revocableOwner && !revoked) { initiallyAuthorized.resolve(); return; }
      throw Object.assign(new Error('denied'), { code: 'CREATOR_DENIED' });
    },
    store: { ...f.store,
      async list(dir) {
        reads.push(['list', dir]);
        if (holdSelected && dir === selectedDir) { listing.resolve(); await release.promise; }
        return [...(entries.get(dir)?.keys() ?? await f.store.list(dir))];
      },
      async readJson(name) {
        reads.push(['readJson', name]);
        const dir = path.posix.dirname(path.posix.dirname(name)), id = path.posix.basename(path.posix.dirname(name));
        return entries.get(dir)?.has(id) ? structuredClone(entries.get(dir).get(id)) : f.store.readJson(name);
      },
    },
  });
  assert.equal(reads.length, 0, 'cold construction must not list or read report history');
  assert.equal(inventories, 0);
  await assert.rejects(f.rawService.status(selected, saved, {}), { code: 'CREATOR_DENIED' });
  assert.deepEqual(await f.replay({ kind: 'schedule', input: blocker }), { status: 'ignored' });
  assert.deepEqual(reads, []);
  const fresh = project('project-fresh');
  const request = p => ({ projectId: p.meta.projectId, language: 'English' });
  const queued = await f.rawService.start(fresh, request(fresh), owner);
  assert.equal(queued.state, 'queued');
  assert.deepEqual(reads.splice(0), [['list', `${projectLocation(fresh)}/reports`]]);
  assert.equal(inventories, 0);
  const taskCount = f.tasks.size;

  holdSelected = true;
  const viewing = f.rawService.status(selected, saved, owner);
  const waiting = assert.rejects(f.rawService.start(selected, request(selected), owner),
    { code: 'PROJECT_SUMMARY_BUSY', reportId: blocker.reportId });
  const deniedOnResume = assert.rejects(f.rawService.status(selected, saved, revocableOwner), { code: 'CREATOR_DENIED' });
  const outcomes = Promise.all([viewing, waiting, deniedOnResume]);
  try {
    await Promise.all([listing.promise, initiallyAuthorized.promise]);
    assert.deepEqual(reads, [['list', selectedDir]]);
    assert.equal(f.tasks.size, taskCount);
  } finally { revoked = true; release.resolve(); }
  const [status] = await outcomes;
  assert.equal(status.state, 'completed');
  assert.equal((await f.rawService.result(selected, saved, owner)).report, body);
  assert.equal((await f.rawService.status(selected, blocker, owner)).recoveryPending, true);
  assert.equal(f.tasks.size, taskCount);
  assert.deepEqual(reads, [['list', selectedDir], ['readJson', `${selectedDir}/${saved.reportId}/metadata.json`],
    ['readJson', `${selectedDir}/${blocker.reportId}/metadata.json`]]);
  assert.equal(inventories, 0);
  assert.deepEqual(f.calls.writer, []);
  assert.deepEqual(f.calls.gather, []);
});

test('shutdown distinguishes exclusively created projects from unopened report history without reading either', async t => {
  const f = await fixture(t);
  await f.rawService.dispose();
  const bornHere = { meta: { projectId: 'project-fresh', creator } };
  const rows = [bornHere];
  await f.open({ deferHistoricalWork: true, projects: () => rows,
    isFreshProject: p => p === bornHere,
    store: { ...f.store, list: () => assert.fail('shutdown must not enumerate report history'),
      readJson: () => assert.fail('shutdown must not load report history') },
  });
  assert.equal(f.rawService.dashboardShutdownIdle(), true);
  rows.push({ meta: { projectId: 'project-parked', creator } });
  assert.equal(f.rawService.dashboardShutdownIdle(), false);
  assert.equal((await f.rawService.dispose()).cleanupPending, true);
});

async function writing(f, q) {
  const run = f.dispatch(q); await Promise.race([f.started, run.then(result => { throw new Error(`writer did not start: ${JSON.stringify(result)}`); })]); return { run };
}
const paperMath = (...selector) => ({ kind: 'paper-math-verification', language: 'English', math: selector.length === 1
  ? { sourceReportId: selector[0] } : { planReportId: selector[0], finalSectionReportId: selector[1] } });
const mathText = findings => JSON.stringify({ findings, report: 'Synthetic text-only review.' });
test('paper math review accepts a clean flagged source, persists hashes and derives correct/wrong verdicts without rerunning', async t => {
  for (const [label, findings, expected] of [
    ['must-fix', [{ location: 'opaque line', issue: 'opaque missing hypothesis', class: 'must-fix' }], 'wrong'],
    ['ignorable-only', [{ location: 'opaque line', issue: 'opaque notation', class: 'ignorable' }], 'correct'],
  ]) await t.test(label, async t => {
    const f = await fixture(t), start = await completedPaper(f, '[GAP: opaque blocker]', {}), sourceId = start.audit.sourceReportId;
    const source = f.rawService; const sourceMeta = await f.store.readJson(`project/reports/${sourceId}/metadata.json`);
    assert.equal(sourceMeta.state, 'completed'); assert.equal(sourceMeta.sourceStatus, 'flagged');
    const queued = await source.start(f.p, paperMath(sourceId), owner);
    assert.equal(queued.state, 'queued');
    const writerRun = f.dispatch(queued); await f.started;
    const input = f.calls.writer.at(-1);
    assert.equal(input.kind, 'paper-math-verification');
    const promptEnvelope = JSON.parse(input.prompt.trimEnd().split('\n').at(-1));
    assert.equal(promptEnvelope.mainTex, (await f.artifact({ reportId: sourceId }, 'main.tex')).toString('utf8'));
    assert.equal(promptEnvelope.ledger, (await f.artifact({ reportId: sourceId }, 'REFERENCE_LEDGER.md')).toString('utf8'));
    f.complete(mathText(findings)); await writerRun;
    const metadata = await f.metadata(queued);
    assert.equal(metadata.state, 'completed'); assert.equal(metadata.mathVerdict, expected);
    assert.equal(Object.keys(metadata.math).sort().join(','), 'contractSha256,finalSectionReportId,ledgerSha256,mainSha256,planReportId,promptSha256,sourceReportId,verifierPromptSha256'.split(',').filter(k => Object.hasOwn(metadata.math, k)).sort().join(','));
    assert.deepEqual(Object.keys(metadata.math).sort(), ['contractSha256', 'ledgerSha256', 'mainSha256', 'promptSha256', 'sourceReportId', 'verifierPromptSha256'].sort());
    const review = JSON.parse((await f.artifact(queued, 'MATH_REVIEW.json')).toString('utf8'));
    assert.deepEqual(Object.keys(review).sort(), ['binding', 'findings', 'kind', 'limitations', 'projectId', 'report', 'reportId', 'schemaVersion', 'verdict'].sort());
    assert.equal(review.binding.promptSha256, digest(Buffer.from(input.prompt))); assert.equal(review.verdict, expected);
    const beforeWriters = f.calls.writer.length, first = await source.result(f.p, queued, owner, { kind: 'paper-math-verification' });
    assert.equal(first.mathVerdict, expected); assert.equal(first.files.length, 1); assert.equal(f.calls.writer.length, beforeWriters);
    await source.result(f.p, queued, owner, { kind: 'paper-math-verification' }); assert.equal(f.calls.writer.length, beforeWriters);
  });
});
test('paper math review rejects leaked, damaged, running and foreign paper sources before writer start', async t => {
  const leakFixture = await fixture(t), leaked = await leakFixture.start(), leakedRun = await writing(leakFixture, leaked);
  leakFixture.complete(validOutput('fact_submit')); await leakedRun;
  await assert.rejects(leakFixture.rawService.start(leakFixture.p, paperMath(leaked.reportId), owner), { code: 'PROJECT_PAPER_MATH_SOURCE_INVALID' });
  const f = await fixture(t), cleanGaps = await completedPaper(f, '[GAP: missing condition]', {}), sourceId = cleanGaps.audit.sourceReportId;
  const sourcePath = `project/reports/${sourceId}/main.tex`;
  await f.store.write(sourcePath, 'tampered source bytes', true);
  const prompt = f.calls.writer.length;
  const drift = await f.rawService.start(f.p, paperMath(sourceId), owner).catch(error => error);
  assert.equal(drift.code, 'PROJECT_PAPER_MATH_SOURCE_CHANGED');
  assert.equal(f.calls.writer.length, prompt);
  const otherProject = { meta: { projectId: 'foreign-project', creator } };
  await assert.rejects(f.rawService.start(otherProject, paperMath(sourceId), owner), { code: 'PROJECT_REPORT_NOT_FOUND' });
  await assert.rejects(f.rawService.start(f.p, { ...paperMath(sourceId), extra: true }, owner), { code: 'PROJECT_INVALID_INPUT' });
  const running = await f.start();
  await assert.rejects(f.rawService.start(f.p, paperMath(running.reportId), owner), { code: 'PROJECT_PAPER_MATH_SOURCE_INVALID' });
});
test('paper math source drift during generation and damaged review archive never expose a verdict', async t => {
  const f = await fixture(t), source = await completedPaper(f, undefined, {}), sourceId = source.audit.sourceReportId;
  const q = await f.rawService.start(f.p, paperMath(sourceId), owner), { run } = await writing(f, q);
  const sourcePath = `project/reports/${sourceId}/main.tex`; await f.store.write(sourcePath, 'changed after prompt admission', true);
  f.complete(mathText([])); await run;
  const failed = await f.rawService.status(f.p, q, owner, { kind: 'paper-math-verification' });
  assert.equal(failed.state, 'failed'); assert.equal(failed.mathVerdict, undefined);
  const saved = await f.metadata(q); assert.equal(Object.hasOwn(saved, 'mathVerdict'), false); assert.equal(saved.artifacts.review, undefined);

  const second = await fixture(t), secondSource = await completedPaper(second, undefined, {}), secondId = secondSource.audit.sourceReportId;
  const clean = await second.rawService.start(second.p, paperMath(secondId), owner), work = await writing(second, clean);
  second.complete(mathText([{ location: 'opaque', issue: 'opaque', class: 'ignorable' }])); await work.run;
  const archive = `project/reports/${clean.reportId}/MATH_REVIEW.json`;
  await second.store.write(archive, 'damaged review bytes', true);
  const status = await second.rawService.status(second.p, clean, owner, { kind: 'paper-math-verification' });
  assert.equal(status.readError.code, 'PROJECT_PAPER_MATH_REVIEW_INVALID');
  assert.equal(status.mathVerdict, undefined); assert.equal(status.paperMathGate, 'not-assessed');
  await assert.rejects(second.rawService.result(second.p, clean, owner, { kind: 'paper-math-verification' }), { code: 'PROJECT_PAPER_MATH_REVIEW_INVALID' });
});
// Real sender checkpoint timing, source mutation and cancellation are tested
// end-to-end in paper-math-transport-flow.test.mjs.
const planKind = { kind: 'paper-plan' };
const plannerOutput = `%%%PREAMBLE%%%\nPREAMBLE_SENTINEL\n%%%FRONTMATTER%%%\nFRONTMATTER_SENTINEL\n%%%SECTIONS%%%\n[{"title":"Opaque section","label":"sec:opaque","fact_ids":["${fid}"]}]\n%%%BIBLIOGRAPHY%%%\nBIBLIOGRAPHY_SENTINEL\n`;
test('M05 integration report kind completes only a plan and delivers three immutable files, never raw or TeX', async t => {
  const f = await fixture(t, { plan: true }), q = await f.start(), { run } = await writing(f, q);
  assert.equal(f.calls.writer[0].kind, 'paper-plan'); f.complete(plannerOutput); await run;
  const status = await f.rawService.status(f.p, q, owner, planKind), meta = await f.metadata(q);
  assert.equal(status.kind, 'paper-plan'); assert.equal(status.state, 'completed'); assert.equal(status.coverageStatus, 'exact-once');
  assert.equal(status.sectionOrdering, 'not-checked'); assert.equal(status.citationStatus, 'not-requested'); assert.equal(status.mathematicsStatus, 'unreviewed'); assert.equal(status.compileStatus, 'not-run');
  assert.equal(Object.hasOwn(status, 'sourceStatus'), false);
  assert.deepEqual(Object.keys(meta.artifacts).sort(), ['blocks', 'ledger', 'plan', 'response']);
  assert.deepEqual((await f.store.list(`project/reports/${q.reportId}`)).sort(), ['PLANNER_BLOCKS.json', 'REFERENCE_LEDGER.md', 'SECTION_PLAN.json', 'metadata.json', 'raw-response.txt'].sort());
  const result = await f.rawService.result(f.p, q, owner, planKind); assert.equal(result.status, 'ok');
  assert.deepEqual(result.files.map(file => file.name), ['PLANNER_BLOCKS.json', 'SECTION_PLAN.json', 'REFERENCE_LEDGER.md']);
  assert.deepEqual(f.calls.stages.map(row => row.name), result.files.map(file => file.name));
  assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), plannerOutput); assert.equal(f.calls.writer.length, 1);
  for (const publicValue of [status, result, f.tasks.get(q.taskId).metadata, f.tasks.get(q.taskId).result])
    assert.doesNotMatch(JSON.stringify(publicValue), /Opaque brief|Opaque instructions|Opaque claim|Opaque proof|PREAMBLE_SENTINEL|FRONTMATTER_SENTINEL|BIBLIOGRAPHY_SENTINEL|finalText|"prompt":/);
  for (const method of ['status', 'result', 'stop']) await assert.rejects(f.rawService[method](f.p, q, owner), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
});
test('M05 integration every planner attachment stage failure is delivery-failed without replay', async t => {
  for (const position of [1, 2, 3]) await t.test(`attachment ${position}`, async t => {
    const f = await fixture(t, { plan: true }), q = await f.start(), { run } = await writing(f, q); f.complete(plannerOutput); await run;
    f.failStage(position); const result = await f.rawService.result(f.p, q, owner, planKind);
    assert.equal(result.status, 'delivery-failed'); assert.equal(result.files.length, 3); assert.equal(result.files[position - 1].error, 'HOST_UNAVAILABLE');
    assert.equal(result.state, 'completed'); assert.equal(f.calls.writer.length, 1); assert.equal(f.calls.stages.length, 3);
  });
});
test('M05 integration completed archive validation rejects missing bytes, same-size tamper, path and binding before status registration', async t => {
  for (const change of ['missing', 'bytes', 'path', 'binding']) await t.test(change, async t => {
    const f = await fixture(t, { plan: true }), q = await f.start(), { run } = await writing(f, q); f.complete(plannerOutput); await run;
    const meta = await f.metadata(q);
    if (change === 'missing') await fs.unlink(f.store.absolute(meta.artifacts.blocks.artifact));
    if (change === 'bytes') { const bytes = await f.artifact(q, 'SECTION_PLAN.json'); bytes[10] ^= 1; assert.equal(bytes.length, meta.artifacts.plan.bytes); await f.store.write(meta.artifacts.plan.artifact, bytes, true); }
    if (change === 'path') meta.artifacts.ledger.artifact = `project/reports/${q.reportId}/elsewhere.md`;
    if (change === 'binding') meta.plan.promptSha256 = 'f'.repeat(64);
    if (change === 'path' || change === 'binding') await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify(meta), true);
    const frozen = await f.artifact(q, 'metadata.json'); await f.open();
    await assert.rejects(f.rawService.status(f.p, q, owner, planKind), { code: 'PROJECT_REPORT_NOT_FOUND' });
    await assert.rejects(f.rawService.result(f.p, q, owner, planKind), { code: 'PROJECT_REPORT_NOT_FOUND' });
    assert.deepEqual(await f.artifact(q, 'metadata.json'), frozen); assert.equal(f.calls.writer.length, 1); assert.equal(f.calls.stages.length, 0);
  });
});
test('M05 integration historical completed plans do not read current canonical facts or current resources', async t => {
  const f = await fixture(t, { plan: true }), q = await f.start(), { run } = await writing(f, q); f.complete(plannerOutput); await run;
  const gathered = f.calls.gather.length, frozen = await f.artifact(q, 'metadata.json'); f.changeFacts(); f.revoke();
  const read = fs.default.readFile; t.mock.method(fs.default, 'readFile', async (name, ...rest) => {
    if (name instanceof URL && name.href.includes('/references/danus/')) assert.fail('Historical plan sampled current resources');
    return read(name, ...rest);
  });
  await f.open(); assert.equal((await f.rawService.status(f.p, q, owner, planKind)).coverageStatus, 'exact-once');
  assert.deepEqual(await f.artifact(q, 'metadata.json'), frozen, 'status does not backfill or resample admission material');
  assert.equal((await f.rawService.result(f.p, q, owner, planKind)).status, 'ok');
  assert.equal(f.calls.gather.length, gathered); assert.equal(f.calls.writer.length, 1);
  assert.deepEqual((await f.metadata(q)).plan, JSON.parse(frozen).plan);
});
test('M05 integration queued recovery retains uncertainty, interrupts and ignores the original nonce without replay', async t => {
  for (const flag of [null, 'taskCreating', 'scheduleCreating', 'writerStarting']) await t.test(flag ?? 'plain queued', async t => {
    const f = await fixture(t, { plan: true }), q = await f.start(), schedule = [...f.schedules.values()][0];
    const event = { kind: 'schedule', scheduleId: schedule.scheduleId, input: structuredClone(schedule.payload) };
    if (flag) { const meta = await f.metadata(q); meta[flag] = true; meta.cleanupPending = true; await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify(meta), true); }
    f.changeFacts(); await f.open(); const status = await f.rawService.status(f.p, q, owner, planKind);
    assert.equal(status.state, 'interrupted'); assert.equal(status.coverageStatus, 'not-established'); assert.equal(Object.hasOwn(status, 'coverage'), false);
    const meta = await f.metadata(q); assert.equal(meta.nonce, event.input.nonce); if (flag) { assert.equal(meta[flag], true); assert.equal(status.cleanupPending, true); }
    assert.deepEqual(await f.replay(event), { status: 'ignored' }); assert.equal(f.calls.writer.length, 0);
    if (flag) { f.restoreFacts(); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' }); }
  });
});
test('M05 integration C1 readonly saved-model refusal settles and releases its slot with zero Host creates', async t => {
  const f = await fixture(t, { plan: true }); let modelReads = 0, creates = 0, starts = 0;
  const realWriter = createSummaryWriter({ sdk: { dataDir: f.root, agents: { async create() { creates++; assert.fail('model read failure must precede Agent creation'); }, async list() { assert.fail('model read failure must precede private Agent readback'); } } },
    profiles: { async getRoleModel(role) { assert.equal(role, 'verifier'); modelReads++; throw Object.assign(new Error('readonly saved-role lookup rejected'), { code: 'SAVED_ROLE_INVALID' }); } },
    sessions: { start() { starts++; assert.fail('model read failure must precede sessions.start'); }, dispose: async () => ({ cleanupPending: false }) } });
  t.after(() => realWriter.dispose()); t.mock.method(f.writer, 'start', input => realWriter.start(input));
  f.writer.planPreparationFailedBeforeCreation = (...args) => realWriter.planPreparationFailedBeforeCreation?.(...args);
  const q = await f.start(); await f.dispatch(q); const meta = await f.metadata(q);
  assert.equal(modelReads, 1); assert.equal(creates, 0); assert.equal(starts, 0); assert.equal(meta.error, 'SAVED_ROLE_INVALID'); assert.equal(meta.state, 'failed');
  assert.equal(meta.writerStarting, false); assert.equal(meta.writer, null); assert.equal(meta.cleanupPending, false); assert.equal(meta.taskSettlement, 'confirmed');
  assert.equal((await f.rawService.result(f.p, q, owner, planKind)).status, 'failed');
  const next = await f.start(); assert.equal(next.state, 'queued'); await f.rawService.stop(f.p, next, owner, planKind);
  await f.open(); const status = await f.rawService.status(f.p, q, owner, planKind); assert.equal(status.state, 'failed'); assert.equal(status.cleanupPending, false);
  const afterReopen = await f.start(); await f.rawService.stop(f.p, afterReopen, owner, planKind); assert.equal(creates, 0); assert.equal(starts, 0); assert.equal(modelReads, 1);
  t.diagnostic(JSON.stringify({ probe: 'readonly-model-before-any-Host-create', modelReads, creates, starts, writerStarting: meta.writerStarting, cleanupPending: meta.cleanupPending, slotReusableAfterReopen: true }));
});
test('M05 integration C1 invalid raw content preserves clean stop evidence and reloadable bounded metadata', async t => {
  for (const [name, text, code] of [['oversize', 'x'.repeat(2 * 1024 * 1024 + 1), 'PROJECT_PAPER_OUTPUT_TOO_LARGE'], ['ill-formed', '\ud800', 'PROJECT_PAPER_PLAN_OUTPUT_INVALID'], ['parse', 'Opaque invalid planner response', 'PROJECT_PAPER_PLAN_OUTPUT_INVALID']]) await t.test(name, async t => {
    const f = await fixture(t, { plan: true }), start = f.writer.start; let stops = 0;
    t.mock.method(f.writer, 'start', async input => { const handle = await start(input), stop = handle.stop;
      handle.stop = async () => { stops++; const receipt = await stop(); assert.equal(receipt.cleanupPending, false); return receipt; }; return handle; });
    const q = await f.start(), { run } = await writing(f, q); f.terminal({ state: 'completed', modelStopReason: 'stop', cleanupPending: false, finalText: text }); await run;
    const meta = await f.metadata(q); assert.equal(meta.state, 'failed'); assert.equal(meta.error, code); assert.equal(stops, 1);
    assert.equal(meta.writer.cleanupPending, false); assert.equal(meta.writerStarting, false); assert.equal(meta.cleanupPending, false);
    assert.equal(Object.hasOwn(meta.writer, 'finalText'), false); assert.ok((await f.artifact(q, 'metadata.json')).length < 16384);
    if (name === 'parse') assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), text);
    else { assert.equal(meta.artifacts?.response, undefined); assert.equal(meta.responseError, code); }
    await f.open(); const status = await f.rawService.status(f.p, q, owner, planKind); assert.equal(status.state, 'failed'); assert.equal(status.cleanupPending, false); assert.equal(status.coverageStatus, 'not-established'); assert.equal(f.calls.stages.length, 0);
    const next = await f.start(); await f.rawService.stop(f.p, next, owner, planKind);
    t.diagnostic(JSON.stringify({ probe: name, error: meta.error, acknowledgedWriterCleanupPending: meta.writer.cleanupPending, reportCleanupPending: meta.cleanupPending, stops, metadataReloadable: true, ordinaryPath: name === 'oversize' ? 'existing research-sessions assistant 512KiB App guard precedes this synthetic boundary' : 'software malformed output, not live acceptance' }));
  });
});
test('M05 integration C1 forged, foreign-bound and post-Agent failures remain unknown and block replacement', async t => {
  for (const phase of ['forged', 'foreign-bound', 'agent-started']) await t.test(phase, async t => {
    const f = await fixture(t, { plan: true }), original = Object.assign(new Error('Host reused a preparation-looking code'), { code: 'SAVED_ROLE_INVALID', noResourcesCreated: true, preparationFailed: true }); let creates = 0, starts = 0;
    const real = createSummaryWriter({ sdk: { dataDir: f.root, agents: { async create() { creates++; throw original; }, async list() { assert.fail('uncertain create cannot reach readback'); } } },
      profiles: { async getRoleModel() { if (phase !== 'agent-started') throw original; return { role: 'verifier', source: 'saved-role', instanceState: 'active', model: { provider: 'fixture', id: 'saved-verifier' } }; } },
      sessions: { start() { starts++; assert.fail('no session should start'); }, dispose: async () => ({ cleanupPending: false }) } });
    t.after(() => real.dispose()); f.writer.planPreparationFailedBeforeCreation = real.planPreparationFailedBeforeCreation;
    t.mock.method(f.writer, 'start', input => { if (phase === 'forged') throw original; return real.start(phase === 'foreign-bound' ? { ...input, reportId: 'other-report' } : input); });
    const q = await f.start(); await f.dispatch(q); const meta = await f.metadata(q);
    assert.equal(meta.state, 'failed'); assert.equal(meta.error, 'SAVED_ROLE_INVALID'); assert.equal(meta.writerStarting, true); assert.equal(meta.cleanupPending, true); assert.equal(starts, 0); assert.equal(creates, phase === 'agent-started' ? 1 : 0);
    let registry;
    if (phase === 'agent-started') { registry = await fs.readFile(path.join(f.root, 'report-writer/paper-plan-registry.json'), 'utf8'); assert.equal(JSON.parse(registry).state, 'creating'); }
    await f.open(); assert.equal((await f.rawService.stop(f.p, q, owner, planKind)).cleanupPending, true); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
    if (registry) assert.equal(await fs.readFile(path.join(f.root, 'report-writer/paper-plan-registry.json'), 'utf8'), registry);
  });
});
test('M05 integration C1 onUpdate never writes finalText into metadata and final raw archive remains authoritative', async t => {
  const f = await fixture(t, { plan: true }), q = await f.start(), { run } = await writing(f, q);
  await f.calls.writer[0].onUpdate({ state: 'running', cleanupPending: true, finalText: 'x'.repeat(2 * 1024 * 1024 + 1) });
  assert.equal(Object.hasOwn((await f.metadata(q)).writer, 'finalText'), false); assert.ok((await f.artifact(q, 'metadata.json')).length < 16384);
  f.complete(plannerOutput); await run; const meta = await f.metadata(q); assert.equal(meta.state, 'completed'); assert.equal(Object.hasOwn(meta.writer, 'finalText'), false);
  assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), plannerOutput); assert.equal((await f.rawService.result(f.p, q, owner, planKind)).status, 'ok');
});
test('M05 integration C1 unknown stop and failed raw persistence remain unclean without blind archive retries', async t => {
  for (const mode of ['unknown-stop', 'raw-write', 'raw-metadata']) await t.test(mode, async t => {
    const f = await fixture(t, { plan: true }), q = await f.start(), { run } = await writing(f, q), write = f.store.write; let rawWrites = 0, injected = false;
    f.store.write = async (name, bytes, ...rest) => {
      if (name.endsWith('/raw-response.txt')) {
        rawWrites++;
        if (mode === 'raw-write') { injected = true; await write(name, Buffer.from('partial'), ...rest); throw Object.assign(new Error('partial raw archive failure'), { code: 'HOST_UNAVAILABLE' }); }
      }
      if (mode === 'raw-metadata' && !injected && name.endsWith('/metadata.json') && JSON.parse(bytes).artifacts?.response) { injected = true; throw Object.assign(new Error('raw descriptor save failure'), { code: 'HOST_UNAVAILABLE' }); }
      return write(name, bytes, ...rest);
    };
    f.terminal({ state: 'completed', modelStopReason: 'stop', cleanupPending: mode === 'unknown-stop', finalText: 'Opaque malformed planner response' }); await run;
    const meta = await f.metadata(q), status = await f.rawService.status(f.p, q, owner, planKind);
    assert.equal(meta.state, 'failed'); assert.equal(status.cleanupPending, true); assert.equal(status.coverageStatus, 'not-established'); assert.equal(Object.hasOwn(meta.writer, 'finalText'), false); assert.equal(rawWrites, 1);
    if (mode === 'unknown-stop') { assert.equal(meta.writer.cleanupPending, true); assert.equal((await f.rawService.result(f.p, q, owner, planKind)).status, 'failed'); }
    else { assert.equal(injected, true); assert.equal(meta.writer.cleanupPending, false); assert.equal(meta.responseError, 'HOST_UNAVAILABLE'); await assert.rejects(f.rawService.result(f.p, q, owner, planKind), { code: 'PROJECT_REPORT_NOT_READY' }); }
    await f.open(); assert.equal((await f.rawService.status(f.p, q, owner, planKind)).cleanupPending, true); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' }); assert.equal(rawWrites, 1); assert.equal(f.calls.stages.length, 0);
  });
});

test('M05 integration unconfirmed NativeTask completion cannot expose successful coverage or result', async t => {
  const f = await fixture(t, { plan: true }), q = await f.start(), { run } = await writing(f, q);
  f.sdk.tasks.complete = async id => { f.tasks.get(id).status = 'pending'; return structuredClone(f.tasks.get(id)); };
  f.complete(plannerOutput); await run; const status = await f.rawService.status(f.p, q, owner, planKind);
  assert.equal(status.state, 'completed'); assert.equal(status.taskSettlement, 'unknown'); assert.equal(status.coverageStatus, 'not-established'); assert.equal(Object.hasOwn(status, 'coverage'), false);
  await assert.rejects(f.rawService.result(f.p, q, owner, planKind), { code: 'PROJECT_REPORT_NOT_READY' }); assert.equal(f.calls.stages.length, 0);
});
test('M05 integration final metadata failedSave remains diagnostic and blocks successful result', async t => {
  const f = await fixture(t, { plan: true }), q = await f.start(), { run } = await writing(f, q), write = f.store.write; let failed = false;
  f.store.write = async (name, bytes, ...rest) => {
    if (!failed && name.endsWith('/metadata.json') && JSON.parse(bytes).state === 'completed') { failed = true; throw Object.assign(new Error('fixture save failure'), { code: 'HOST_UNAVAILABLE' }); }
    return write(name, bytes, ...rest);
  };
  f.complete(plannerOutput); await run; assert.equal(failed, true);
  const status = await f.rawService.status(f.p, q, owner, planKind); assert.equal(status.state, 'failed'); assert.equal(status.cleanupPending, true); assert.equal(status.coverageStatus, 'not-established');
  await assert.rejects(f.rawService.result(f.p, q, owner, planKind), { code: 'PROJECT_REPORT_NOT_READY' }); assert.equal(f.calls.stages.length, 0);
  assert.deepEqual(Object.keys((await f.metadata(q)).artifacts).sort(), ['blocks', 'ledger', 'plan', 'response']);
});
test('M05 integration pre-task failedSave stop never uses operator-notes pre-task settlement exception', async t => {
  const f = await fixture(t, { plan: true }), write = f.store.write; let injected = false, q;
  f.store.write = async (name, ...rest) => { if (!injected && name.endsWith('/metadata.json')) { injected = true; throw Object.assign(new Error('save uncertainty'), { code: 'HOST_UNAVAILABLE' }); } return write(name, ...rest); };
  await assert.rejects(f.start(), error => { q = { reportId: error.reportId }; return error.code === 'HOST_UNAVAILABLE'; });
  assert.equal(f.tasks.size, 0); await f.open(); const stopped = await f.rawService.stop(f.p, q, owner, planKind);
  assert.notEqual(stopped.taskSettlement, 'confirmed'); assert.equal(stopped.cleanupPending, true); assert.equal(stopped.coverageStatus, 'not-established'); assert.equal(f.calls.writer.length, 0);
});
test('M05 integration unconfirmed task creation remains durable and forbids a replacement', async t => {
  const f = await fixture(t, { plan: true }); let q;
  f.createReceipt(receipt => { delete receipt.taskId; });
  await assert.rejects(f.start(), error => { q = { reportId: error.reportId }; return error.code === 'PROJECT_REPORT_TASK_UNCONFIRMED'; });
  assert.equal(f.tasks.size, 1); assert.equal((await f.metadata(q)).taskCreating, true); await f.open();
  const status = await f.rawService.stop(f.p, q, owner, planKind); assert.equal(status.cleanupPending, true); assert.notEqual(status.taskSettlement, 'confirmed');
  await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' }); assert.equal(f.tasks.size, 1); assert.equal(f.calls.writer.length, 0);
});

test('paper admission authorizes first and rejects malformed kinds and canonical target changes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.start(f.p, { kind: 'invalid' }, {}), { code: 'CREATOR_DENIED' });
  assert.equal(f.calls.assertions, 0);
  for (const args of [{ ...f.args, kind: 'invalid' }, { ...f.args, language: 'Chinese' }, { ...f.args, paper: { ...f.args.paper, target: {} } }]) await assert.rejects(f.service.start(f.p, args, owner), { code: 'PROJECT_INVALID_INPUT' });
  f.revoke(); await assert.rejects(f.start(), { code: 'PROJECT_PAPER_TARGET_CHANGED' }); assert.equal(f.tasks.size, 0);
});
test('paper schedule requires nonce and exact creator task receipt before fact reads', async t => {
  const f = await fixture(t), q = await f.start();
  assert.equal((await f.dispatch(q, 'foreign')).status, 'ignored');
  f.tasks.get(q.taskId).parentSessionId = 'foreign'; await f.dispatch(q);
  assert.equal(f.calls.gather.length, 0); assert.equal(f.calls.writer.length, 0);
});
test('paper target is checked again at run before model or fact reads', async t => {
  const f = await fixture(t), q = await f.start(); f.revoke(); await f.dispatch(q);
  const status = await f.service.status(f.p, q, owner); assert.equal(status.error, 'PROJECT_PAPER_TARGET_CHANGED');
  assert.equal(f.calls.writer.length, 0); assert.equal(f.calls.gather.length, 0);
  assert.equal(status.compileStatus, 'not-run'); assert.equal(status.citationStatus, 'unverified'); assert.equal(status.mathematicsStatus, 'unreviewed');
  assert.equal(Object.hasOwn(status, 'paper'), false); assert.equal(Object.hasOwn(status, 'brief'), false);
});
test('queued paper restart is interrupted with no model replay; invalid persisted kind blocks admission', async t => {
  const f = await fixture(t), q = await f.start(); await f.open();
  assert.equal((await f.service.status(f.p, q, owner)).state, 'interrupted'); assert.equal(f.calls.writer.length, 0);
  const meta = await f.metadata(q); meta.kind = 'foreign'; await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify(meta), true);
  await f.open(); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
});
test('queued paper stop and dispose never invoke writer', async t => {
  const f = await fixture(t), q = await f.start(); await f.service.stop(f.p, q, owner);
  assert.equal((await f.service.status(f.p, q, owner)).state, 'stopped'); assert.equal(f.calls.writer.length, 0);
  await f.start(); await f.service.dispose(); assert.equal(f.calls.writer.length, 0); assert.equal(f.schedules.size, 0);
});
test('malformed paper response survives splitting failure and export retry without regeneration', async t => {
  const f = await fixture(t), q = await f.start(), { run } = await writing(f, q);
  assert.equal(f.calls.writer[0].kind, 'paper-source'); assert.equal(Object.hasOwn(f.calls.writer[0], 'model'), false);
  const raw = 'Malformed opaque model response'; f.complete(raw); await run;
  assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), raw);
  const meta = await f.metadata(q); assert.equal(meta.sha256, digest(raw)); assert.equal(meta.state, 'failed');
  const result = await f.service.result(f.p, q, owner);
  assert.equal(result.status, 'failed'); assert.equal(result.sourceStatus, 'invalid'); assert.deepEqual(result.files, []);
  assert.equal(result.diagnosis.responseSaved, true); assert.equal(f.calls.stages.length, 0);
  assert.equal(f.calls.writer.length, 1); assert.equal(JSON.stringify(result).includes('project/reports/'), false);
});
test('completed paper stages each immutable artifact with honest partial receipts and restart retry', async t => {
  const f = await fixture(t); f.drift(1); const q = await f.start(), { run } = await writing(f, q);
  f.advance(); const raw = validOutput(); f.complete(raw); await run;
  assert.equal(f.calls.gather.length, 2);
  const status = await f.service.status(f.p, q, owner); assert.equal(status.state, 'completed'); assert.equal(status.snapshotAdvancedDuringWriting, true);
  const tex = await f.artifact(q, 'main.tex'); assert.equal(tex.toString(), raw.split('%%%PROVENANCE%%%')[0]);
  f.failStage(2); const partial = await f.service.result(f.p, q, owner);
  assert.equal(partial.status, 'delivery-failed'); assert.equal(partial.files.length, 2); assert.ok(partial.files[0].resource); assert.equal(partial.files[1].error, 'HOST_UNAVAILABLE');
  assert.deepEqual(f.calls.stages.map(s => s.name), ['main.tex', 'REFERENCE_LEDGER.md']);
  await f.open(); f.failStage(0); const result = await f.service.result(f.p, q, owner);
  assert.equal(result.status, 'ok'); assert.equal(result.files.length, 2); assert.equal(f.calls.writer.length, 1);
  assert.equal(Object.hasOwn(result, 'report'), false); assert.equal(Object.hasOwn(result, 'tex'), false);
  assert.deepEqual(await f.artifact(q, 'main.tex'), tex);
});
test('target revocation and adopted fact changes preserve raw but prevent source completion', async t => {
  for (const change of ['target', 'fact']) await t.test(change, async t => {
    const f = await fixture(t), q = await f.start(), { run } = await writing(f, q);
    if (change === 'target') f.revoke(); else f.changeFacts();
    const raw = validOutput(); f.complete(raw); await run;
    const status = await f.service.status(f.p, q, owner); assert.equal(status.state, 'failed');
    assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), raw);
    const result = await f.service.result(f.p, q, owner); assert.equal(result.status, 'failed'); assert.equal(result.files.length, 0); assert.equal(f.calls.stages.length, 0);
  });
});
test('blockers are source flags and leaks are diagnostic failures, never certification', async t => {
  for (const extra of ['[GAP: opaque missing support]', 'fact_submit']) await t.test(extra, async t => {
    const f = await fixture(t), q = await f.start(), { run } = await writing(f, q); f.complete(validOutput(extra)); await run;
    const status = await f.service.status(f.p, q, owner);
    const leaking = extra === 'fact_submit';
    assert.equal(status.state, leaking ? 'failed' : 'completed'); assert.equal(status.sourceStatus, 'flagged');
    const result = await f.service.result(f.p, q, owner); assert.equal(result.status, 'flagged');
    if (leaking) {
      assert.deepEqual(result.files, []); assert.equal(f.calls.stages.length, 0);
      await assert.rejects(f.artifact(q, 'main.tex'), { code: 'ENOENT' });
      assert.match((await f.artifact(q, 'main.leaky.tex')).toString(), /fact_submit/);
      assert.equal(status.findings.leaks, 2); assert.equal(JSON.stringify(status).includes('matched'), false);
    } else {
      assert.deepEqual(result.files.map(f => f.name), ['main.tex', 'REFERENCE_LEDGER.md']);
      assert.ok((await f.artifact(q, 'main.tex')).length); assert.equal(status.findings.blockers, 1);
      assert.equal(JSON.stringify(status).includes('opaque missing support'), false);
    }
    assert.equal(status.compileStatus, 'not-run'); assert.equal(status.citationStatus, 'unverified'); assert.equal(status.mathematicsStatus, 'unreviewed');
  });
});
test('saved artifact corruption is reported per file and never staged as valid source', async t => {
  const f = await fixture(t), q = await f.start(), { run } = await writing(f, q); f.complete(validOutput()); await run;
  await f.store.write(`project/reports/${q.reportId}/main.tex`, 'corrupted', true);
  const result = await f.service.result(f.p, q, owner);
  assert.equal(result.status, 'delivery-failed'); assert.equal(result.files[0].error, 'PROJECT_REPORT_ARTIFACT_INVALID');
  assert.equal(f.calls.stages.length, 1); assert.equal(f.calls.writer.length, 1);
});
test('active source stop and dispose settle without publishing or model replay', async t => {
  for (const action of ['stop', 'dispose']) await t.test(action, async t => {
    const f = await fixture(t), q = await f.start(), { run } = await writing(f, q);
    if (action === 'stop') await f.service.stop(f.p, q, owner); else await f.service.dispose();
    await run; assert.equal((await f.service.status(f.p, q, owner)).state, 'stopped');
    await assert.rejects(f.artifact(q, 'main.tex'), { code: 'ENOENT' }); assert.equal(f.calls.writer.length, 1);
  });
});
test('public methods reject cross-kind reports and paper receipts bind kind and paper ID', async t => {
  const f = await fixture(t), q = await f.start();
  assert.equal(f.tasks.get(q.taskId).metadata.kind, 'paper-source'); assert.equal(f.tasks.get(q.taskId).metadata.paperId, 'main');
  for (const method of ['status', 'result', 'stop']) await assert.rejects(f.rawService[method](f.p, q, owner), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
  f.tasks.get(q.taskId).metadata.paperId = 'foreign'; await f.dispatch(q);
  assert.equal(f.calls.writer.length, 0); assert.equal(f.calls.gather.length, 0);
  assert.equal((await f.service.status(f.p, q, owner)).error, 'PROJECT_REPORT_TASK_UNCONFIRMED');
  assert.equal(f.calls.stages.length, 0);
});
test('paper selector rejects legacy summary reports while default summary access remains compatible', async t => {
  const f = await fixture(t), q = await f.rawService.start(f.p, { language: 'English' }, owner);
  assert.equal(Object.hasOwn(f.tasks.get(q.taskId).metadata, 'kind'), false);
  assert.equal((await f.rawService.status(f.p, q, owner)).state, 'queued');
  for (const method of ['status', 'result', 'stop']) await assert.rejects(f.rawService[method](f.p, q, owner, { kind: 'paper-source' }), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
});
test('paper task receipt refuses a changed kind even with matching paper ID', async t => {
  const f = await fixture(t), q = await f.start(); f.tasks.get(q.taskId).metadata.kind = 'summary'; await f.dispatch(q);
  assert.equal(f.calls.writer.length, 0); assert.equal(f.calls.gather.length, 0);
});
test('optional provenance and outer fences preserve raw and allow clean source delivery', async t => {
  for (const suffix of ['', '\n%%%PROVENANCE%%%\nmalformed']) await t.test(suffix || 'absent', async t => {
    const f = await fixture(t), q = await f.start(), { run } = await writing(f, q);
    const tex = '\\documentclass{article}\n\\begin{document}\nworker verifier predecessors\n\\end{document}\n';
    const raw = '```latex\n' + tex + suffix + '\n```'; f.complete(raw); await run;
    const status = await f.service.status(f.p, q, owner); assert.equal(status.state, 'completed'); assert.ok(status.findings.warnings > 0);
    assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), raw);
    const result = await f.service.result(f.p, q, owner); assert.equal(result.status, 'ok'); assert.deepEqual(result.files.map(f => f.role), ['source', 'ledger']);
  });
});
test('target and captured canonical facts are revalidated after prompt input before writer', async t => {
  for (const change of ['target', 'fact']) await t.test(change, async t => {
    const f = await fixture(t), q = await f.start(); f.beforePrompt(change === 'target' ? f.revoke : f.changeFacts);
    await f.dispatch(q); const status = await f.service.status(f.p, q, owner);
    assert.equal(status.state, 'failed'); assert.equal(f.calls.writer.length, 0);
    assert.equal(status.error, change === 'target' ? 'PROJECT_PAPER_TARGET_CHANGED' : 'PROJECT_SUMMARY_FACT_REVOKED');
  });
});
test('reference audit binds immutable completed source hashes across deferred restart and stages only its report', async t => {
  const f = await fixture(t), source = await f.start(), { run } = await writing(f, source);
  f.complete(validOutput('[GAP: audit fixture blocker]')); await run;
  const auditSource = await f.metadata(source);
  assert.equal(auditSource.state, 'completed'); assert.equal(auditSource.sourceStatus, 'flagged');
  await f.rawService.dispose();
  await f.open({ deferHistoricalWork: true });
  const q = await f.rawService.start(f.p, { kind: 'reference-audit', language: 'English', audit: { sourceReportId: source.reportId, paperId: 'main' } }, owner);
  const task = f.tasks.get(q.taskId);
  assert.equal(task.metadata.kind, 'reference-audit'); assert.equal(task.metadata.sourceReportId, source.reportId);
  assert.equal(task.metadata.mainSha256, auditSource.artifacts.source.sha256);
  assert.equal(task.metadata.ledgerSha256, auditSource.artifacts.ledger.sha256);
  assert.match(task.metadata.promptSha256, /^[a-f0-9]{64}$/);
  assert.match(auditSource.artifacts.source.sha256, /^[a-f0-9]{64}$/);
  assert.match(auditSource.artifacts.ledger.sha256, /^[a-f0-9]{64}$/);
  const sourceBefore = await f.artifact(source, 'main.tex'), ledgerBefore = await f.artifact(source, 'REFERENCE_LEDGER.md');
  const auditRun = f.dispatch(q), wait = f.started;
  await wait;
  const prompt = f.calls.writer.at(-1).prompt;
  const jsonStart = prompt.lastIndexOf('\n{') + 1;
  assert.ok(jsonStart > 0 && prompt.endsWith('\n'));
  const payload = JSON.parse(prompt.slice(jsonStart, -1));
  assert.equal(payload.mainTex, sourceBefore.toString('utf8'));
  assert.equal(payload.ledger, ledgerBefore.toString('utf8'));
  assert.deepEqual(Object.keys(payload).sort(), ['auditorPrompt', 'contract', 'ledger', 'mainTex']);
  for (const denied of ['FACT_GRAPH_CONTENT', 'PROJECT_BRIEF.md', 'Opaque problem']) assert.equal(prompt.includes(denied), false);
  f.complete('Advisory only; offline.'); await auditRun;
  assert.deepEqual(await f.artifact(source, 'main.tex'), sourceBefore);
  assert.deepEqual(await f.artifact(source, 'REFERENCE_LEDGER.md'), ledgerBefore);
  f.failStage(f.calls.stages.length + 1);
  const partial = await f.rawService.result(f.p, q, owner, { kind: 'reference-audit' });
  assert.equal(partial.status, 'delivery-failed'); assert.equal(f.calls.writer.length, 2);
  f.failStage(0);
  const result = await f.rawService.result(f.p, q, owner, { kind: 'reference-audit' });
  assert.deepEqual(result.files.map(file => file.name), ['REFERENCE_AUDIT.md']);
  assert.equal(result.citationStatus, 'unverified'); assert.equal(result.auditMode, 'offline');
  assert.deepEqual(f.calls.stages.map(stage => stage.name), ['REFERENCE_AUDIT.md', 'REFERENCE_AUDIT.md']);
  assert.equal(f.calls.writer.length, 2, 'delivery retry must not regenerate the audit');
  assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), 'Advisory only; offline.');
});

test('audit rejects unauthorized, wrong-kind, incomplete and corrupted source reports before model calls', async t => {
  const f = await fixture(t), source = await f.start(), { run } = await writing(f, source);
  f.complete(validOutput()); await run;
  const args = { kind: 'reference-audit', language: 'English', audit: { sourceReportId: source.reportId, paperId: 'main' } };
  await assert.rejects(f.rawService.start(f.p, args, {}), { code: 'CREATOR_DENIED' });
  assert.equal(f.calls.writer.length, 1);
  await assert.rejects(f.rawService.start(f.p, { ...args, audit: { ...args.audit, paperId: 'foreign' } }, owner), { code: 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID' });
  const sourceMeta = await f.metadata(source); sourceMeta.state = 'failed';
  await f.store.write(`project/reports/${source.reportId}/metadata.json`, JSON.stringify(sourceMeta), true); await f.open();
  await assert.rejects(f.rawService.start(f.p, args, owner), { code: 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID' });
  sourceMeta.state = 'completed'; await f.store.write(`project/reports/${source.reportId}/metadata.json`, JSON.stringify(sourceMeta), true); await f.open();
  await f.store.write(`project/reports/${source.reportId}/REFERENCE_LEDGER.md`, 'tampered', true);
  await assert.rejects(f.rawService.start(f.p, args, owner), { code: 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID' });
  assert.equal(f.calls.writer.length, 1);
});

test('queued audit recovery marks interrupted without replaying the model', async t => {
  const f = await fixture(t), source = await f.start(), { run } = await writing(f, source);
  f.complete(validOutput()); await run;
  const audit = await f.rawService.start(f.p, { kind: 'reference-audit', language: 'English', audit: { sourceReportId: source.reportId, paperId: 'main' } }, owner);
  assert.equal(f.calls.writer.length, 1);
  await f.open();
  const status = await f.rawService.status(f.p, audit, owner, { kind: 'reference-audit' });
  assert.equal(status.state, 'interrupted'); assert.equal(status.citationStatus, 'unverified');
  assert.equal(f.calls.writer.length, 1);
});

test('reference audit rejects changed source or ledger after admission', async t => {
  for (const [artifact, name] of [['main.tex', 'source'], ['REFERENCE_LEDGER.md', 'ledger']]) await t.test(name, async t => {
    const f = await fixture(t), source = await f.start(), { run } = await writing(f, source);
    f.complete(validOutput()); await run;
    const audit = await f.rawService.start(f.p, { kind: 'reference-audit', language: 'English', audit: { sourceReportId: source.reportId, paperId: 'main' } }, owner);
    await f.store.write(`project/reports/${source.reportId}/${artifact}`, 'tampered after admission', true);
    const auditRun = f.dispatch(audit); await auditRun;
    const status = await f.rawService.status(f.p, audit, owner, { kind: 'reference-audit' });
    assert.equal(status.state, 'failed'); assert.equal(status.error, 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
    assert.equal(f.calls.writer.length, 1, 'tampered input must not start the audit writer');
  });
});

test('two whole snapshot drifts stop without model generation', async t => {
  const f = await fixture(t); f.drift(2); const q = await f.start(); await f.dispatch(q);
  assert.equal(f.calls.gather.length, 2); assert.equal(f.calls.writer.length, 0);
});

async function completedPaper(f, extra, provenance) {
  const source = await f.start(), { run } = await writing(f, source);
  f.complete(validOutput(extra, provenance)); await run;
  return { kind: 'reference-audit', language: 'English', audit: { sourceReportId: source.reportId, paperId: 'main' } };
}

const verifyKind = { kind: 'reference-verification' };
const verdict = (key, result = 'verified') => ({ key, verdict: result,
  confirmed_metadata: ['verified', 'corrected'].includes(result) ? { authors: 'Opaque Author', title: `Opaque ${key}`, year: '2020', venue: 'Fixture' } : null,
  source_url: ['verified', 'corrected'].includes(result) ? 'https://example.org/opaque-source' : null,
  note: 'Opaque software check only.', replacement_suggestion: 'Keep citation context.' });
async function completedAudit(f, extra, provenance) {
  const args = await completedPaper(f, extra, provenance), source = { reportId: args.audit.sourceReportId };
  const audit = await f.rawService.start(f.p, args, owner), { run } = await writing(f, audit);
  f.complete('Offline opaque advisory for Alpha and Beta.'); await run;
  return { source, audit, args: { kind: 'reference-verification', language: 'English', verification: { auditReportId: audit.reportId, paperId: 'main' } } };
}

test('failed online verifier exposes sanitized writer diagnostics without private failure details', async t => {
  const f = await fixture(t, { references: true }), a = await completedAudit(f);
  const q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q);
  const secret = 'private-secret-payload';
  f.terminal({ state: 'failed', cleanupPending: false, finalText: '', error: 'APP_SDK_PERMISSION_DENIED',
    phase: 'failed', failurePhase: 'tool-selection', sendState: 'not-sent',
    actualModel: { provider: 'fixture-provider', id: 'fixture-model', details: secret },
    sdkError: { code: 'APP_SDK_PERMISSION_DENIED', operation: 'sessions.setActiveTools', kind: 'permission', capability: secret,
      message: secret, cause: { details: secret }, details: secret },
    message: secret, cause: { message: secret }, rawText: secret, sessionPath: `/private/${secret}`, capabilities: [secret] });
  await run;
  const status = await f.rawService.status(f.p, q, owner, verifyKind);
  assert.equal(status.error, 'PROJECT_SUMMARY_WRITER_FAILED');
  assert.equal(status.writer.error, 'APP_SDK_PERMISSION_DENIED');
  assert.equal(status.writer.phase, 'failed'); assert.equal(status.writer.failurePhase, 'tool-selection');
  assert.equal(status.writer.sendState, 'not-sent'); assert.equal(status.writer.cleanupPending, false);
  assert.equal(status.writer.toolSelection, null); assert.equal(status.writer.model, null);
  assert.deepEqual(status.writer.actualModel, { provider: 'fixture-provider', id: 'fixture-model' });
  assert.deepEqual(status.writer.sdkError, { code: 'APP_SDK_PERMISSION_DENIED', operation: 'sessions.setActiveTools', kind: 'permission', capability: null });
  assert.equal(JSON.stringify(status).includes(secret), false);
  for (const field of ['message', 'cause', 'rawText', 'sessionPath', 'capabilities']) assert.equal(Object.hasOwn(status.writer, field), false);
});

test('terminal verifier tool readback is snapshot-only, sanitized, read-only and rejects foreign identity before queries', async t => {
  const f = await fixture(t, { references: true }), a = await completedAudit(f);
  const q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q);
  f.terminal({ state: 'failed', cleanupPending: false, finalText: '', error: 'APP_HOST_ERROR',
    phase: 'failed', failurePhase: 'tool-selection', sendState: 'not-sent' });
  await run;
  const before = await f.metadata(q), snapshot = JSON.stringify(before), queries = [], secret = 'private-readback-secret';
  const binding = before.writer;
  f.sdk.sessions.tools = async input => { queries.push('tools'); assert.deepEqual(input, { sessionId: binding.sessionId });
    return { sessionId: binding.sessionId, toolNames: ['web_search', 'web_fetch'], raw: secret }; };
  f.sdk.sessions.getToolSelection = async input => { queries.push('selection'); assert.deepEqual(input, { sessionId: binding.sessionId });
    return { sessionId: binding.sessionId, toolNames: [], effective: 'current', pendingToolNames: null, message: secret }; };
  f.sdk.agents.profile = async input => { queries.push('profile'); assert.deepEqual(input, { agentId: binding.agentId, scope: 'own' });
    return { profile: { id: binding.agentId, ownerPluginId: 'hana-math', visibility: 'plugin_private',
      toolPolicy: { disabled: ['web_fetch'] }, identity: secret, models: { secret }, prompt: secret } }; };
  f.sdk.agents.config = async input => { queries.push('config'); assert.deepEqual(input, { agentId: binding.agentId, scope: 'own' });
    return { config: { tool_call_mode: 'standard', tools: { disabled: ['web_fetch'] }, extensions: { app: { 'hana-math': { enabled: true, tools: { search_arxiv_theorems: true } } } }, model: secret, identity: secret } }; };
  const write = t.mock.method(f.store, 'write', () => { assert.fail('status must not save'); });
  const read = t.mock.method(f.store, 'read', () => { assert.fail('status must not read source artifacts'); });
  const status = await f.rawService.status(f.p, q, owner, verifyKind), info = status.writer.toolAvailabilityReadback;
  assert.equal(status.error, 'PROJECT_SUMMARY_WRITER_FAILED'); assert.equal(status.writer.error, 'APP_HOST_ERROR');
  assert.equal(status.writer.sendState, 'not-sent'); assert.equal(status.taskSettlement, 'confirmed');
  assert.deepEqual(info, { status: 'confirmed', snapshotKind: 'current-session-tool-names-not-live-availability',
    configuredToolNames: ['web_search', 'web_fetch'], requestedToolPresence: { web_search: true, web_fetch: true },
    selection: { toolNames: [], effective: 'current', pendingToolNames: null }, disabledToolNames: ['web_fetch'],
    verifierConfig: { mode: 'standard', modeSource: 'explicit', appEnabled: true, disabledNames: ['web_fetch'] }, errors: [] });
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.deepEqual(queries, ['tools', 'selection', 'profile', 'config']);
  f.sessions.get(binding.sessionPath).ownerPluginId = 'foreign';
  const foreign = await f.rawService.status(f.p, q, owner, verifyKind);
  assert.equal(foreign.writer.toolAvailabilityReadback.status, 'unconfirmed');
  assert.deepEqual(queries, ['tools', 'selection', 'profile', 'config'], 'foreign session prevents every diagnostic query');
  assert.equal(f.calls.writer.length, 3); assert.equal(f.calls.stages.length, 0);
  read.mock.restore(); write.mock.restore();
  assert.equal(JSON.stringify(await f.metadata(q)), snapshot, 'status preserves durable record exactly');
});

test('online verification authorizes before preparation, refuses cross-kind and empty targets', async t => {
  const f = await fixture(t), a = await completedAudit(f);
  await assert.rejects(f.rawService.start(f.p, a.args, {}), { code: 'CREATOR_DENIED' });
  await assert.rejects(f.rawService.start(f.p, { ...a.args, verification: { auditReportId: a.source.reportId, paperId: 'main' } }, owner), { code: 'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID' });
  await assert.rejects(f.rawService.start(f.p, a.args, owner), { code: 'PROJECT_REFERENCE_VERIFY_NO_TARGETS' });
  assert.equal(f.calls.writer.length, 2); assert.equal(f.tasks.size, 2);
});
test('online verification publishes new bound verdicts/ledger, never source edits; retry is delivery only', async t => {
  const f = await fixture(t, { references: true }), a = await completedAudit(f);
  const before = await f.artifact(a.source, 'main.tex'), ledger = await f.artifact(a.source, 'REFERENCE_LEDGER.md');
  const q = await f.rawService.start(f.p, a.args, owner), prepared = await f.metadata(q);
  assert.deepEqual(prepared.verification.keys, ['Alpha', 'Beta']); assert.equal(prepared.schemaVersion, 1);
  for (const key of ['mainSha256','ledgerSha256','auditSha256','contractSha256','verifierPromptSha256','promptSha256']) assert.match(prepared.verification[key], /^[a-f0-9]{64}$/);
  assert.equal(prepared.verification.mainSha256, digest(before)); assert.equal(prepared.verification.auditSha256, digest(await f.artifact(a.audit, 'REFERENCE_AUDIT.md')));
  const fields = f.tasks.get(q.taskId).metadata;
  assert.equal(fields.kind, 'reference-verification'); assert.equal(fields.auditReportId, a.audit.reportId); assert.equal(fields.sourceReportId, a.source.reportId);
  await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  for (const method of ['status', 'result', 'stop']) await assert.rejects(f.rawService[method](f.p, q, owner, { kind: 'reference-audit' }), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
  const { run } = await writing(f, q); const input = f.calls.writer.at(-1);
  assert.equal(input.kind, 'reference-verification'); assert.equal(digest(input.prompt), fields.promptSha256);
  assert.ok(input.deadlineAt > Date.now() && input.deadlineAt <= Date.now() + 30 * 60 * 1000);
  const raw = JSON.stringify([verdict('Alpha'), verdict('Beta', 'corrected')]); f.complete(raw); await run;
  const result = await f.rawService.result(f.p, q, owner, verifyKind);
  assert.equal(result.state, 'completed'); assert.equal(result.citationStatus, 'verified'); assert.equal(result.compileStatus, 'not-run'); assert.equal(result.mathematicsStatus, 'unreviewed');
  assert.deepEqual(result.files.map(file => file.name), ['REFERENCE_VERDICTS.json', 'REFERENCE_LEDGER.md']);
  assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), raw); assert.match((await f.artifact(q, 'REFERENCE_LEDGER.md')).toString(), /verified-by: verifier/);
  await assert.rejects(f.artifact(q, 'main.tex'), { code: 'ENOENT' }); assert.deepEqual(await f.artifact(a.source, 'main.tex'), before); assert.deepEqual(await f.artifact(a.source, 'REFERENCE_LEDGER.md'), ledger);
  await f.open(); await f.rawService.result(f.p, q, owner, verifyKind); assert.equal(f.calls.writer.length, 3);
});
test('mixed sourced promotions are partial; malformed verdicts retain raw without derived success', async t => {
  const f = await fixture(t, { references: true }), a = await completedAudit(f);
  const q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q);
  f.complete(JSON.stringify([verdict('Alpha'), verdict('Beta', 'unverifiable')])); await run;
  assert.equal((await f.rawService.status(f.p, q, owner, verifyKind)).citationStatus, 'partial');
  const invalid = await f.rawService.start(f.p, a.args, owner), active = await writing(f, invalid);
  const raw = 'Malformed final verdict fixture.'; f.complete(raw); await active.run;
  const result = await f.rawService.result(f.p, invalid, owner, verifyKind);
  assert.equal(result.state, 'failed'); assert.equal(result.citationStatus, 'unverified'); assert.equal(result.diagnosis.responseSaved, true);
  assert.deepEqual(result.files, []); assert.equal((await f.artifact(invalid, 'raw-response.txt')).toString(), raw);
  await assert.rejects(f.artifact(invalid, 'REFERENCE_LEDGER.md'), { code: 'ENOENT' });
  await f.rawService.result(f.p, invalid, owner, verifyKind); assert.equal(f.calls.writer.length, 4);
});
test('source/audit tampering is refused at admission, before binding, and before derived publication', async t => {
  const f = await fixture(t, { references: true }), a = await completedAudit(f), auditPath = `project/reports/${a.audit.reportId}/REFERENCE_AUDIT.md`;
  const findings = await f.artifact(a.audit, 'REFERENCE_AUDIT.md');
  await f.store.write(auditPath, 'tampered', true);
  await assert.rejects(f.rawService.start(f.p, a.args, owner), { code: 'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID' });
  await f.store.write(auditPath, findings, true);
  const q = await f.rawService.start(f.p, a.args, owner);
  f.beforeBound(async () => { await f.store.write(auditPath, 'changed before binding', true); });
  await f.dispatch(q); assert.equal((await f.rawService.status(f.p, q, owner, verifyKind)).state, 'failed');
  assert.equal((await f.metadata(q)).artifacts, undefined);
  // Bound-but-unsent identity remains cleanup evidence; restart reconciles it, no replay.
  f.beforeBound(null); await f.store.write(auditPath, findings, true); await f.rawService.stop(f.p, q, owner, verifyKind);
  const later = await f.rawService.start(f.p, a.args, owner), active = await writing(f, later);
  const mainPath = `project/reports/${a.source.reportId}/main.tex`; await f.store.write(mainPath, 'changed during verification', true);
  f.complete(JSON.stringify([verdict('Alpha'), verdict('Beta')])); await active.run;
  const failed = await f.rawService.result(f.p, later, owner, verifyKind);
  assert.equal(failed.state, 'failed'); assert.equal(failed.diagnosis.responseSaved, true); assert.equal(failed.diagnosis.ledgerSaved, false);
});
test('queued verification stop and restart never replay the verifier', async t => {
  const f = await fixture(t, { references: true }), a = await completedAudit(f);
  const stopped = await f.rawService.start(f.p, a.args, owner); await f.rawService.stop(f.p, stopped, owner, verifyKind);
  assert.equal((await f.rawService.status(f.p, stopped, owner, verifyKind)).state, 'stopped');
  const queued = await f.rawService.start(f.p, a.args, owner); await f.open();
  assert.equal((await f.rawService.status(f.p, queued, owner, verifyKind)).state, 'interrupted'); assert.equal(f.calls.writer.length, 2);
});
test('reference verifier Matlas calls are denied without search or authority fallback', async t => {
  const f = await fixture(t, { references: true }), a = await completedAudit(f), q = await f.rawService.start(f.p, a.args, owner), active = await writing(f, q);
  const m = await f.metadata(q), binding = m.writer, ctx = { callToken: 'host-verifier-token', sessionPath: binding.sessionPath };
  assert.equal(await f.rawService.handlesLiterature(ctx), true, 'route must capture the verifier before fallback');
  await assert.rejects(f.rawService.invokeLiterature('search_arxiv_theorems', { query: 'opaque source' }, ctx), { code: 'PROJECT_REFERENCE_VERIFY_DENIED' });
  const deny = (name, args, caller = ctx) => assert.rejects(f.rawService.invokeLiterature(name, args, caller));
  await deny('gm_search', { query: 'opaque' }); await deny('search_arxiv_theorems', { query: 'opaque', num_results: 0 });
  await deny('search_arxiv_theorems', { query: 'opaque' }, { ...ctx, callToken: '' });
  await deny('search_arxiv_theorems', { query: 'opaque' }, owner);
  const row = f.sessions.get(ctx.sessionPath);
  for (const patch of [{ agentId: 'foreign' }, { lifecycle: 'archived' }, { namespace: 'home' }, { kind: 'wrong' }]) {
    const before = structuredClone(row); Object.assign(row, patch); await deny('search_arxiv_theorems', { query: 'opaque' }); Object.assign(row, before);
  }
  f.agents[0].plugin.roleId = 'verifier'; await deny('search_arxiv_theorems', { query: 'opaque' }); delete f.agents[0].plugin.roleId;
  f.tasks.get(q.taskId).status = 'completed'; await deny('search_arxiv_theorems', { query: 'opaque' }); f.tasks.get(q.taskId).status = 'pending';
  const input = f.calls.writer.at(-1); await input.onUpdate({ ...binding, role: 'report-writer' });
  await deny('search_arxiv_theorems', { query: 'opaque' }); await input.onUpdate(binding);
  f.onSessionList(() => { row.agentId = 'changed-during-check'; }); await deny('search_arxiv_theorems', { query: 'opaque' }); f.onSessionList(null); row.agentId = binding.agentId;
  assert.equal(f.calls.literature.length, 0);
  const moved = '/fixture/moved-verifier.jsonl'; f.sessions.delete(ctx.sessionPath); f.sessions.set(moved, { ...row, path: moved });
  assert.equal(await f.rawService.handlesLiterature({ ...ctx, sessionPath: moved }), true, 'stable ID routes without granting migrated authority');
  await deny('search_arxiv_theorems', { query: 'opaque' }, { ...ctx, sessionPath: moved });
  f.sessions.delete(moved); f.sessions.set(ctx.sessionPath, row);
  f.complete(JSON.stringify([verdict('Alpha'), verdict('Beta')])); await active.run;
  assert.equal(await f.rawService.handlesLiterature(ctx), true);
  await deny('search_arxiv_theorems', { query: 'opaque' }); assert.equal(f.calls.literature.length, 0);
});

test('real ProjectService denies verifier Matlas without main or legacy authority', async t => {
  const source = await fixture(t, { references: true }), a = await completedAudit(source), done = defer(), started = defer();
  let real, binding;
  const writer = { async start(input) {
    assert.equal(input.kind, 'reference-verification');
    binding = { role: 'reference-verifier', sessionId: 'fixture-online-verifier', sessionPath: '/fixture/online-verifier.jsonl',
      agentId: 'math-reference-verifier-01234567-89ab-cdef-0123-456789abcdef', cwd: input.cwd,
      kind: `math-reference-verification:${input.projectId}:${input.reportId}`,
      model: { provider: 'fixture-provider', id: 'fixture-verifier-model' },
      toolSelection: { sessionId: 'fixture-online-verifier', toolNames: ['web_search', 'web_fetch'], effective: 'current', pendingToolNames: null } };
    real.host.set(binding.sessionPath, { ...binding, path: binding.sessionPath, namespace: 'app', visibility: 'plugin_private', ownerPluginId: 'hana-math', lifecycle: 'active' });
    real.agents.push({ id: binding.agentId, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'math-reference-verifier' } });
    await input.onBound(binding); await input.onUpdate({ ...binding, state: 'running', cleanupPending: true }); started.resolve();
    return { done: done.promise, stop: async () => { const state = { ...binding, state: 'stopped', cleanupPending: false }; done.resolve(state); return state; } };
  }, dispose: async () => ({ cleanupPending: false, errors: [] }) };
  real = await projectFixture(t, { multiWorker: true, summaryWriter: writer }); const p = await real.create(), store = createContextStore(real.dataDir);
  const project = await store.readJson(`research/projects/${p.projectId}/project.json`);
  for (const q of [a.source, a.audit]) {
    const meta = await source.metadata(q); meta.projectId = p.projectId; meta.creator = project.creator;
    if (meta.paper) meta.paper.target.projectId = p.projectId;
    for (const artifact of Object.values(meta.artifacts)) {
      const bytes = await source.store.read(artifact.artifact); artifact.artifact = `research/projects/${p.projectId}/reports/${q.reportId}/${artifact.name}`;
      await store.write(artifact.artifact, bytes);
    }
    await store.write(`research/projects/${p.projectId}/reports/${q.reportId}/metadata.json`, JSON.stringify(meta));
  }
  await real.open();
  await assert.rejects(real.service.paperVerify({ projectId: p.projectId, reportId: a.audit.reportId }, p.context), { code: 'PROJECT_SUMMARY_DENIED' });
  const q = await real.service.paperVerify({ projectId: p.projectId, reportId: a.audit.reportId }, projectOwner);
  const schedule = [...real.schedules.values()].find(s => s.payload.reportId === q.reportId);
  const run = real.handlers.get('math-project-report').run({ kind: 'schedule', scheduleId: schedule.scheduleId, input: schedule.payload });
  await Promise.race([started.promise, run.then(() => { throw new Error('verifier did not bind'); })]);
  const tools = new Map(); let legacyCalls = 0;
  real.sdk.tools.register = async tool => { tools.set(tool.name, tool); return () => {}; };
  real.sdk.resources = { stage: async () => ({ resource: { kind: 'session-file', sessionId: 'creator-stable', fileId: 'fixture-reference-output' } }) };
  const unexpected = async () => { legacyCalls++; throw new Error('legacy fallback forbidden'); };
  const legacy = Object.fromEntries(['run','status','setupStatus','setToolMode','result','stop','invoke','recordSubmissionInputRejection'].map(k => [k, unexpected]));
  const registration = await registerMathResearch(real.sdk, legacy, real.service); t.after(() => registration.dispose());
  const ctx = { callToken: 'opaque-bound-verifier', sessionPath: binding.sessionPath };
  assert.equal(await real.service.handles(ctx), true);
  const search = await tools.get('search_arxiv_theorems').execute({ query: 'must be denied', num_results: 2, context: ctx });
  assert.equal(search.isError, true); assert.deepEqual(real.calls.literature, []);
  assert.equal((await tools.get('gm_search').execute({ query: 'not main authority', context: ctx })).isError, true);
  real.host.get(ctx.sessionPath).agentId = 'foreign-agent';
  assert.equal((await tools.get('search_arxiv_theorems').execute({ query: 'must not search', context: ctx })).isError, true);
  assert.equal(real.calls.literature.length, 0); assert.equal(legacyCalls, 0);
  real.host.get(ctx.sessionPath).agentId = binding.agentId;
  done.resolve({ ...binding, state: 'completed', modelStopReason: 'stop', cleanupPending: false, finalText: JSON.stringify([verdict('Alpha'), verdict('Beta')]) });
  await run;
  const result = await tools.get('math_project').execute({ action: 'paper_verify_result', projectId: p.projectId, reportId: q.reportId, context: projectOwner });
  assert.equal(result.isError, false, JSON.stringify(result.details)); assert.equal(result.details.citationStatus, 'verified');
  assert.equal((await tools.get('search_arxiv_theorems').execute({ query: 'terminal cannot search', context: ctx })).isError, true);
  assert.equal(legacyCalls, 0); assert.equal(real.calls.literature.length, 0);
  await assert.rejects(real.service.paperRevise({ projectId: p.projectId, reportId: q.reportId }, p.context), { code: 'PROJECT_SUMMARY_DENIED' });
  const revise = await tools.get('math_project').execute({ action: 'paper_revise', projectId: p.projectId, reportId: q.reportId, context: projectOwner });
  assert.equal(revise.isError, false, JSON.stringify(revise.details));
  const child = revise.details;
  assert.equal((await real.service.paperRevisionStatus({ projectId: p.projectId, reportId: child.reportId }, projectOwner)).kind, 'paper-revision');
  await assert.rejects(real.service.paperVerifyStatus({ projectId: p.projectId, reportId: child.reportId }, projectOwner), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
  await real.service.paperRevisionStop({ projectId: p.projectId, reportId: child.reportId }, projectOwner);
  assert.equal((await real.service.paperRevisionResult({ projectId: p.projectId, reportId: child.reportId }, projectOwner)).state, 'stopped');
});

test('audit creation and later task reads both enforce the shared receipt matcher', async t => {
  const create = await fixture(t), createArgs = await completedPaper(create);
  create.createReceipt(task => { task.metadata.mainSha256 = 'foreign'; });
  await assert.rejects(create.rawService.start(create.p, createArgs, owner), { code: 'PROJECT_REPORT_TASK_UNCONFIRMED' });
  assert.equal(create.calls.writer.length, 1); assert.equal(create.calls.stages.length, 0);

  const read = await fixture(t), readArgs = await completedPaper(read), audit = await read.rawService.start(read.p, readArgs, owner);
  read.tasks.get(audit.taskId).metadata.promptSha256 = 'foreign'; await read.dispatch(audit);
  const status = await read.rawService.status(read.p, audit, owner, { kind: 'reference-audit' });
  assert.equal(status.state, 'failed'); assert.equal(status.error, 'PROJECT_REPORT_TASK_UNCONFIRMED');
  assert.equal(read.calls.writer.length, 1); assert.equal(read.calls.stages.length, 0);
});

test('audit accepts extra Host receipt metadata at create and get and refuses cross-kind staging or stopping', async t => {
  const f = await fixture(t), args = await completedPaper(f);
  f.createReceipt(task => { task.metadata.hostTrace = 'opaque'; });
  const q = await f.rawService.start(f.p, args, owner);
  f.tasks.get(q.taskId).metadata.hostTrace = 'another opaque value';
  for (const kind of ['summary', 'paper-source']) for (const method of ['status', 'result', 'stop']) {
    await assert.rejects(f.rawService[method](f.p, q, owner, { kind }), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
  }
  assert.equal((await f.metadata(q)).stopRequested, false);
  assert.equal(f.schedules.size, 1); assert.equal(f.calls.stages.length, 0);
  await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  const { run } = await writing(f, q); f.complete('Opaque advisory fixture.'); await run;
  for (const kind of ['summary', 'paper-source']) {
    await assert.rejects(f.rawService.result(f.p, q, owner, { kind }), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
  }
  assert.equal(f.calls.stages.length, 0, 'cross-kind completed result must reject before stage');
  const result = await f.rawService.result(f.p, q, owner, { kind: 'reference-audit' });
  assert.equal(result.status, 'ok'); assert.deepEqual(result.files.map(file => file.role), ['audit']);
});

const revisionKind = { kind: 'paper-revision' };
const patchOutput = (find = 'Opaque text.', replace = 'Opaque revised text.') => `%%%PATCH%%%\n<<<<<<< FIND\n${find}\n=======\n${replace}\n>>>>>>> REPLACE\n%%%REVISION_SUMMARY%%%\nCitation-targeted software proposal only.\n`;
const revisionResponse = edits => '%%%PATCH%%%\n' + edits.map(([find, replace]) =>
  `<<<<<<< FIND\n${find}\n=======\n${replace}\n>>>>>>> REPLACE\n`).join('') + '%%%REVISION_SUMMARY%%%\nBounded software revision summary.\n';
async function completedVerification(f, extra, provenance) {
  const a = await completedAudit(f, extra, provenance), verification = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, verification);
  f.complete(JSON.stringify([verdict('Alpha'), verdict('Beta', 'unverifiable')])); await run;
  return { ...a, verification, revisionArgs: { kind: 'paper-revision', language: 'English',
    revision: { verificationReportId: verification.reportId, paperId: 'main' } } };
}

test('revision creates only immutable child proposal artifacts with hash-bound inherited judgments', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  const before = await Promise.all([f.metadata(a.source), f.metadata(a.verification), f.artifact(a.source, 'main.tex'), f.artifact(a.source, 'provenance.json')]);
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), meta = await f.metadata(q);
  for (const key of ['mainSha256', 'verdictsSha256', 'ledgerSha256', 'originalLedgerSha256', 'provenanceSha256', 'promptSha256']) {
    assert.equal(f.tasks.get(q.taskId).metadata[key], meta.revision[key]);
  }
  const { run } = await writing(f, q);
  assert.equal(f.calls.writer.at(-1).kind, 'paper-revision');
  assert.ok(Buffer.byteLength(f.calls.writer.at(-1).prompt) <= 512 * 1024);
  const raw = patchOutput(); f.complete(raw); await run;
  const status = await f.rawService.status(f.p, q, owner, revisionKind);
  assert.equal(status.state, 'completed'); assert.equal(status.proposalOnly, true);
  assert.equal(status.publicationStatus, 'reviewable-proposal');
  assert.equal(status.citationStatus, 'inherited-verification-source-judgment'); assert.equal(status.inheritedCitationStatus, 'partial');
  assert.equal(status.mathematicsStatus, 'unreviewed'); assert.equal(status.compileStatus, 'not-run');
  assert.deepEqual(status.provenance, { sourceReportId: a.source.reportId, sha256: digest(before[3]), status: 'inherited-not-revalidated' });
  assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), raw);
  assert.match((await f.artifact(q, 'proposal.tex')).toString(), /Opaque revised text/);
  assert.deepEqual(await f.artifact(q, 'INHERITED_PROVENANCE.json'), before[3]);
  const proposal = JSON.parse(await f.artifact(q, 'REVISION_PROPOSAL.json'));
  assert.deepEqual(proposal.provenanceReconciliation, { status: 'unresolved-for-edited-tex', archiveRole: 'historical-only',
    parentMappingState: 'present', reusableMapping: {}, unresolvedLabels: [], reason: 'document-edited-no-provenance-revalidation' });
  assert.equal(proposal.citationKeyCheck.status, 'no-literal-key-issues');
  assert.equal(proposal.citationKeyCheck.scope, 'literal-key-membership-in-inherited-ledger');
  assert.equal(proposal.findings.warnings.filter(w => w.startsWith('All provenance for edited TeX is unresolved;')).length, 1);
  for (const field of ['provenanceReconciliation', 'citationKeyCheck']) {
    assert.equal(Object.hasOwn(status, field), false); assert.equal(Object.hasOwn(await f.metadata(q), field), false);
  }
  assert.deepEqual((await f.metadata(q)).revision, meta.revision);
  assert.deepEqual(proposal.binding, meta.revision);
  assert.deepEqual(proposal.revisionOutcome, status.revisionOutcome);
  assert.deepEqual((await f.metadata(q)).revisionOutcome, status.revisionOutcome);
  assert.equal(status.revisionOutcome.status, 'proposal');
  assert.equal(Object.hasOwn(f.tasks.get(q.taskId).metadata, 'revisionOutcome'), false);
  assert.deepEqual(await Promise.all([f.metadata(a.source), f.metadata(a.verification), f.artifact(a.source, 'main.tex'), f.artifact(a.source, 'provenance.json')]), before);
  const result = await f.rawService.result(f.p, q, owner, revisionKind);
  assert.deepEqual(result.files.map(file => file.name), ['proposal.tex', 'REVISION_SUMMARY.md', 'REVISION_PROPOSAL.json', 'INHERITED_REFERENCE_LEDGER.md']);
  for (const file of result.files) {
    const bytes = await f.artifact(q, file.name);
    assert.equal(file.sha256, digest(bytes)); assert.equal(file.bytes, bytes.length);
    assert.equal(file.sha256, (await f.metadata(q)).artifacts[file.role].sha256);
  }
  assert.equal(Object.hasOwn(result, 'provenanceReconciliation'), false); assert.equal(Object.hasOwn(result, 'citationKeyCheck'), false);
  const deliveredHashes = result.files.map(file => file.sha256);
  await f.open();
  assert.deepEqual((await f.rawService.result(f.p, q, owner, revisionKind)).files.map(file => file.sha256), deliveredHashes);
  assert.equal((await f.rawService.status(f.p, q, owner, revisionKind)).state, 'completed');
  assert.equal(f.calls.writer.length, 4);
  for (const method of ['status', 'result', 'stop']) for (const kind of ['summary', 'paper-source', 'reference-audit', 'reference-verification']) {
    await assert.rejects(f.rawService[method](f.p, q, owner, { kind }), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
  }
  await assert.rejects(f.rawService.start(f.p, { ...a.revisionArgs, revision: { ...a.revisionArgs.revision, verificationReportId: q.reportId } }, owner), { code: 'PROJECT_PAPER_REVISION_SOURCE_INVALID' });
});

test('new revision proposals retain null and removed-label provenance as historical-only unresolved archives', async t => {
  for (const provenance of [null, { retained: fid, removed: fid }]) {
    const f = await fixture(t, { references: true });
    const a = await completedVerification(f, String.raw`\label{retained}\label{removed}`, provenance);
    const archive = await f.artifact(a.source, 'provenance.json');
    const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q);
    f.complete(patchOutput(String.raw`\label{removed}`, 'Opaque removed label.')); await run;
    const proposal = JSON.parse(await f.artifact(q, 'REVISION_PROPOSAL.json'));
    assert.equal(proposal.provenanceReconciliation.parentMappingState, provenance === null ? 'absent' : 'present');
    assert.deepEqual(proposal.provenanceReconciliation.unresolvedLabels, provenance === null ? [] : ['retained', 'removed']);
    assert.deepEqual(proposal.provenanceReconciliation.reusableMapping, {});
    assert.deepEqual(await f.artifact(q, 'INHERITED_PROVENANCE.json'), archive);
    assert.doesNotMatch((await f.artifact(q, 'proposal.tex')).toString(), /label\{removed\}/);
  }
});

test('literal citation issues flag new proposals with one fixed blocker and private detailed diagnostics', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  for (const [replacement, expected] of [
    [String.raw`\cite[locator]{Alpha, Beta}`, 'no-literal-key-issues'],
    [String.raw`\cite{PrivateUnknownKey}\cite{}`, 'flagged'],
    [String.raw`\cite{\dynamicKey}`, 'incomplete'],
  ]) {
    const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q);
    f.complete(patchOutput('Opaque text.', replacement)); await run;
    const proposal = JSON.parse(await f.artifact(q, 'REVISION_PROPOSAL.json'));
    const status = await f.rawService.status(f.p, q, owner, revisionKind);
    assert.equal(proposal.citationKeyCheck.status, expected);
    assert.equal(status.sourceStatus, expected === 'no-literal-key-issues' ? 'generated' : 'flagged');
    assert.equal(proposal.findings.blockers.filter(b => b.startsWith('Revision literal citation-key check')).length,
      expected === 'no-literal-key-issues' ? 0 : 1);
    assert.equal(JSON.stringify(status).includes('PrivateUnknownKey'), false);
    assert.equal(status.error, null);
  }
});

test('malformed inherited provenance fails after apply but before any proposal artifact with a fixed public error', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  const invalid = Buffer.from('{"PrivateInvalidLabel":"not-a-fact-id"}'), source = await f.metadata(a.source);
  source.artifacts.provenance.sha256 = digest(invalid); source.artifacts.provenance.bytes = invalid.length;
  await f.store.write(`project/reports/${a.source.reportId}/provenance.json`, invalid, true);
  await f.store.write(`project/reports/${a.source.reportId}/metadata.json`, JSON.stringify(source), true);
  await f.open();
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q);
  const raw = patchOutput(); f.complete(raw); await run;
  const result = await f.rawService.result(f.p, q, owner, revisionKind);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
  assert.deepEqual(result.files, []); assert.equal(JSON.stringify(result).includes('PrivateInvalidLabel'), false);
  assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), raw);
  for (const name of ['proposal.tex', 'REVISION_PROPOSAL.json', 'INHERITED_PROVENANCE.json']) {
    await assert.rejects(f.artifact(q, name), { code: 'ENOENT' });
  }
});

test('historical revision recovery neither synthesizes new proposal fields nor replays the writer', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q);
  f.complete(patchOutput()); await run;
  // Simulate a pre-follow-up immutable proposal using its own authentic descriptor.
  const proposal = JSON.parse(await f.artifact(q, 'REVISION_PROPOSAL.json'));
  delete proposal.provenanceReconciliation; delete proposal.citationKeyCheck;
  const historical = Buffer.from(JSON.stringify(proposal, null, 2) + '\n'), meta = await f.metadata(q);
  meta.artifacts.proposal.sha256 = digest(historical); meta.artifacts.proposal.bytes = historical.length;
  await f.store.write(`project/reports/${q.reportId}/REVISION_PROPOSAL.json`, historical, true);
  await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify(meta), true);
  const dto = await f.rawService.status(f.p, q, owner, revisionKind);
  await f.open();
  assert.deepEqual(await f.rawService.status(f.p, q, owner, revisionKind), dto);
  assert.deepEqual(await f.artifact(q, 'REVISION_PROPOSAL.json'), historical);
  assert.deepEqual((await f.metadata(q)).revision, meta.revision);
  const result = await f.rawService.result(f.p, q, owner, revisionKind);
  assert.equal(result.files.find(file => file.role === 'proposal').sha256, digest(historical));
  assert.equal(f.calls.writer.length, 4);
});

test('revision rejects unauthorized, dirty, unsettled, wrong-kind parents and source changes', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  await assert.rejects(f.rawService.start(f.p, a.revisionArgs, {}), { code: 'CREATOR_DENIED' });
  for (const reportId of [a.source.reportId, a.audit.reportId]) {
    await assert.rejects(f.rawService.start(f.p, { ...a.revisionArgs, revision: { ...a.revisionArgs.revision, verificationReportId: reportId } }, owner), { code: 'PROJECT_PAPER_REVISION_SOURCE_INVALID' });
  }
  const original = await f.metadata(a.verification);
  for (const changes of [{ state: 'failed' }, { cleanupPending: true }, { taskSettlement: 'unknown' }, { error: 'FAILED' }, { stopRequested: true }]) {
    // Recovery may legitimately confirm an unknown settlement. Keep the Host
    // unavailable for this case so admission sees an actually unsettled parent.
    const getTask = f.sdk.tasks.get;
    if (changes.taskSettlement) f.sdk.tasks.get = async id => {
      if (id === a.verification.taskId) throw Object.assign(new Error('unavailable'), { code: 'HOST_UNAVAILABLE' });
      return getTask(id);
    };
    await f.store.write(`project/reports/${a.verification.reportId}/metadata.json`, JSON.stringify({ ...original, ...changes }), true); await f.open();
    await assert.rejects(f.rawService.start(f.p, a.revisionArgs, owner), { code: 'PROJECT_PAPER_REVISION_SOURCE_INVALID' });
    f.sdk.tasks.get = getTask;
  }
  await f.store.write(`project/reports/${a.verification.reportId}/metadata.json`, JSON.stringify(original), true); await f.open();
  const q = await f.rawService.start(f.p, a.revisionArgs, owner);
  await f.store.write(`project/reports/${a.source.reportId}/main.tex`, 'tampered', true); await f.dispatch(q);
  assert.equal((await f.rawService.status(f.p, q, owner, revisionKind)).state, 'failed');
  assert.equal(f.calls.writer.length, 3);
});

test('confirmed recovery stop projects the interrupted writer as stopped with bounded Host evidence', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), meta = await f.metadata(q);
  const writer = { role: 'paper-reviser', agentId: 'math-paper-reviser-01234567-89ab-cdef-0123-456789abcdef',
    sessionId: 'paper-reviser-recovery', sessionPath: '/fixture/paper-reviser-recovery.jsonl', cwd: '/fixture/paper-reviser',
    kind: `math-paper-revision:${f.p.meta.projectId}:${q.reportId}`, state: 'running', sendState: 'accepted', cleanupPending: true,
    toolSelection: { requested: [], resolved: [], effective: 'current', pendingToolNames: null }, model: { provider: 'fixture', id: 'model' } };
  await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify({ ...meta,
    state: 'interrupted', error: 'PROJECT_REPORT_INTERRUPTED', cleanupPending: true, writer }), true);
  f.sessions.set(writer.sessionPath, { ...writer, path: writer.sessionPath, ownerPluginId: 'hana-math', namespace: 'app',
    visibility: 'plugin_private', lifecycle: 'active' });
  await f.open();
  const recovered = await f.rawService.status(f.p, q, owner, revisionKind);
  assert.equal(recovered.state, 'interrupted'); assert.equal(recovered.cleanupPending, true);
  assert.deepEqual(recovered.sessionStop, { outcome: 'aborted', confirmed: true, error: null });
  assert.equal(recovered.writer.state, 'stopped'); assert.equal(recovered.writer.cleanupPending, false);
  assert.equal(recovered.writer.stopEvidence, 'aborted');
  const stopped = await f.rawService.stop(f.p, q, owner, revisionKind);
  assert.equal(stopped.cleanupPending, false); assert.equal(stopped.sessionStop.confirmed, true);
  assert.equal(stopped.writer.state, 'stopped'); assert.equal(stopped.writer.stopEvidence, 'aborted');
  assert.equal(f.calls.writer.length, 3);
});

test('confirmed recovery stop preserves a prior failed writer state', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), meta = await f.metadata(q);
  const writer = { role: 'paper-reviser', agentId: 'math-paper-reviser-01234567-89ab-cdef-0123-456789abcdef',
    sessionId: 'paper-reviser-failed', sessionPath: '/fixture/paper-reviser-failed.jsonl', cwd: '/fixture/paper-reviser',
    kind: `math-paper-revision:${f.p.meta.projectId}:${q.reportId}`, state: 'failed', sendState: 'accepted', cleanupPending: false,
    error: 'PROJECT_SUMMARY_WRITER_FAILED', toolSelection: { requested: [], resolved: [], effective: 'current', pendingToolNames: null },
    model: { provider: 'fixture', id: 'model' } };
  await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify({ ...meta,
    state: 'interrupted', error: 'PROJECT_REPORT_INTERRUPTED', cleanupPending: true, writer }), true);
  f.sessions.set(writer.sessionPath, { ...writer, path: writer.sessionPath, ownerPluginId: 'hana-math', namespace: 'app',
    visibility: 'plugin_private', lifecycle: 'active' });
  await f.open();
  const status = await f.rawService.status(f.p, q, owner, revisionKind);
  assert.equal(status.cleanupPending, true); assert.equal(status.sessionStop.confirmed, true);
  assert.equal(status.writer.state, 'failed'); assert.equal(status.writer.error, 'PROJECT_SUMMARY_WRITER_FAILED');
  assert.equal(status.writer.cleanupPending, false); assert.equal(status.writer.stopEvidence, 'aborted');
  assert.equal(f.calls.writer.length, 3);
});

test('pending send recovery evidence keeps cleanup blocked and writer running', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), meta = await f.metadata(q);
  const writer = { role: 'paper-reviser', agentId: 'math-paper-reviser-01234567-89ab-cdef-0123-456789abcdef',
    sessionId: 'paper-reviser-pending', sessionPath: '/fixture/paper-reviser-pending.jsonl', cwd: '/fixture/paper-reviser',
    kind: `math-paper-revision:${f.p.meta.projectId}:${q.reportId}`, state: 'running', sendState: 'accepted',
    sendPending: true, cleanupPending: true, toolSelection: { requested: [], resolved: [], effective: 'current', pendingToolNames: null },
    model: { provider: 'fixture', id: 'model' } };
  await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify({ ...meta,
    state: 'interrupted', error: 'PROJECT_REPORT_INTERRUPTED', cleanupPending: true,
    recoveryStop: 'aborted', writer }), true);
  f.sessions.set(writer.sessionPath, { ...writer, path: writer.sessionPath, ownerPluginId: 'hana-math', namespace: 'app',
    visibility: 'plugin_private', lifecycle: 'active' });
  f.abortReceipt(false);
  await f.open();
  const status = await f.rawService.status(f.p, q, owner, revisionKind);
  assert.equal(status.state, 'interrupted'); assert.equal(status.cleanupPending, true);
  assert.deepEqual(status.sessionStop, { outcome: 'awaiting-send-receipt', confirmed: false, error: null });
  assert.equal(status.writer.state, 'running'); assert.equal(status.writer.stopEvidence, 'awaiting-send-receipt');
  assert.equal(f.calls.aborts, 1); assert.equal(f.calls.writer.length, 3);
});

test('revision patch failure retains raw output with no partial proposal and restart never replays', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f), before = await revisionParentBytes(f, a);
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q);
  const raw = patchOutput().replace('%%%REVISION_SUMMARY%%%', '<<<<<<< FIND\nabsent\n======= extra\nreplacement\n>>>>>>> REPLACE\n%%%REVISION_SUMMARY%%%');
  f.complete(raw); await run;
  const result = await f.rawService.result(f.p, q, owner, revisionKind);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'PROJECT_PAPER_REVISION_PATCH_INVALID');
  assert.equal(result.diagnosis.responseSaved, true); assert.deepEqual(result.files, []);
  assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), raw);
  await assert.rejects(f.artifact(q, 'proposal.tex'), { code: 'ENOENT' });
  assert.deepEqual(await revisionParentBytes(f, a), before);
  const next = await f.rawService.start(f.p, a.revisionArgs, owner); await f.open();
  const status = await f.rawService.status(f.p, next, owner, revisionKind);
  assert.equal(status.state, 'interrupted'); assert.equal(status.kind, 'paper-revision'); assert.equal(f.calls.writer.length, 4);
  const stopped = await f.rawService.start(f.p, a.revisionArgs, owner);
  await f.rawService.stop(f.p, stopped, owner, revisionKind);
  assert.equal((await f.rawService.status(f.p, stopped, owner, revisionKind)).state, 'stopped');
});

test('revision validates verdict JSON against original ledger and binds task receipt hashes', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  const original = await f.metadata(a.verification);
  const bytes = Buffer.from(JSON.stringify([verdict('Foreign'), verdict('Beta')]));
  await f.store.write(`project/reports/${a.verification.reportId}/REFERENCE_VERDICTS.json`, bytes, true);
  original.artifacts.verdicts.sha256 = digest(bytes); original.artifacts.verdicts.bytes = bytes.length;
  await f.store.write(`project/reports/${a.verification.reportId}/metadata.json`, JSON.stringify(original), true); await f.open();
  await assert.rejects(f.rawService.start(f.p, a.revisionArgs, owner), { code: 'PROJECT_REFERENCE_VERIFICATION_OUTPUT_INVALID' });
  assert.equal(f.calls.writer.length, 3);
  const g = await fixture(t, { references: true }), b = await completedVerification(g);
  const q = await g.rawService.start(g.p, b.revisionArgs, owner);
  g.tasks.get(q.taskId).metadata.provenanceSha256 = 'foreign'; await g.dispatch(q);
  assert.equal((await g.rawService.status(g.p, q, owner, revisionKind)).error, 'PROJECT_REPORT_TASK_UNCONFIRMED');
  assert.equal(g.calls.writer.length, 3);
});

test('revision preserves source blocker flags even if a patch removes them and rejects changed inherited bytes', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f, '[GAP: opaque missing support]');
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q);
  f.complete(patchOutput('[GAP: opaque missing support]', 'Opaque text.')); await run;
  assert.equal((await f.rawService.status(f.p, q, owner, revisionKind)).sourceStatus, 'flagged');
  assert.doesNotMatch((await f.artifact(q, 'proposal.tex')).toString(), /\[GAP:/);
  const next = await f.rawService.start(f.p, a.revisionArgs, owner), pending = await writing(f, next);
  await f.store.write(`project/reports/${a.source.reportId}/provenance.json`, '{"tampered":true}', true);
  f.complete(patchOutput()); await pending.run;
  const status = await f.rawService.status(f.p, next, owner, revisionKind);
  assert.equal(status.state, 'failed'); assert.equal(status.error, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
  assert.equal((await f.artifact(next, 'raw-response.txt')).toString(), patchOutput());
  await assert.rejects(f.artifact(next, 'proposal.tex'), { code: 'ENOENT' });
});

test('operator-notes rejects wrong kinds, unclean or unsettled sources, and leaves explicit citation on its legacy binding', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  for (const reportId of [a.audit.reportId, a.verification.reportId]) await assert.rejects(f.rawService.revise(f.p, { reportId, mode: 'operator-notes', notes: 'x' }, owner), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
  const legacy = await f.rawService.revise(f.p, { reportId: a.verification.reportId }, owner), original = (await f.metadata(legacy)).revision;
  await f.rawService.stop(f.p, legacy, owner, revisionKind);
  const explicit = await f.rawService.revise(f.p, { reportId: a.verification.reportId, mode: 'citation' }, owner);
  assert.deepEqual((await f.metadata(explicit)).revision, original); assert.equal(Object.hasOwn(original, 'mode'), false);
  await f.rawService.stop(f.p, explicit, owner, revisionKind);
  await assert.rejects(f.rawService.revise(f.p, { reportId: explicit.reportId, mode: 'operator-notes', notes: 'x' }, owner), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
  for (const extra of [{ notes: '' }, { notes: null }, { mode: 'citation', notes: 'x' }, { mode: 'style' }, { mode: 'operator-notes', notes: 'x', paperId: 'main' }]) {
    await assert.rejects(f.rawService.revise(f.p, { reportId: a.verification.reportId, ...extra }, owner), { code: 'PROJECT_INVALID_INPUT' });
  }
  for (const changed of [{ state: 'failed' }, { cleanupPending: true }, { taskSettlement: 'unknown' }, { error: 'FAILED' },
    { stopRequested: true }, { taskCreating: true }, { writerStarting: true }, { scheduleCreating: true },
    { sourceStatus: 'pending' }, { scheduleId: 'stale-schedule' }, { leakFindings: ['opaque leak'] }]) await t.test(JSON.stringify(changed), async t => {
    const g = await fixture(t), b = await notesSource(g), meta = await g.metadata(b.source);
    if (changed.taskSettlement) g.sdk.tasks.get = async () => { throw Object.assign(new Error('unavailable'), { code: 'HOST_UNAVAILABLE' }); };
    await g.store.write(`project/reports/${b.source.reportId}/metadata.json`, JSON.stringify({ ...meta, ...changed }), true); await g.open();
    await assert.rejects(g.rawService.start(g.p, b.args, owner), { code: 'PROJECT_PAPER_REVISION_SOURCE_INVALID' }); assert.equal(g.calls.writer.length, 1);
  });
  const g = await fixture(t), b = await notesSource(g);
  await assert.rejects(g.rawService.revise(g.p, { reportId: b.source.reportId, mode: 'operator-notes', notes: 'x' }, {}), { code: 'CREATOR_DENIED' });
  g.p.meta.creator = { ...creator, sessionId: 'foreign' };
  await assert.rejects(g.rawService.start(g.p, b.args, owner), { code: 'PROJECT_PAPER_REVISION_SOURCE_INVALID' });
});

const opaqueNotes = '  Opaque operator 编辑🙂\r\nRequested local edit only.\r\n ';
async function notesSource(f, extra, provenance) {
  const args = await completedPaper(f, extra, provenance), source = { reportId: args.audit.sourceReportId };
  return { source, args: { kind: 'paper-revision', language: 'English', revision: { mode: 'operator-notes', sourceReportId: source.reportId, paperId: 'main' }, notes: opaqueNotes } };
}
const notesParentBytes = (f, source) => Promise.all(['metadata.json', 'main.tex', 'REFERENCE_LEDGER.md', 'provenance.json'].map(name => f.artifact(source, name)));

test('operator-notes directly revises paper-source with private original-byte archive and no fabricated verification binding', async t => {
  const f = await fixture(t, { references: true }), a = await notesSource(f, String.raw`\label{opaque}`, { opaque: fid });
  const before = await notesParentBytes(f, a.source), gathers = f.calls.gather.length;
  const q = await f.rawService.revise(f.p, { reportId: a.source.reportId, mode: 'operator-notes', notes: opaqueNotes }, owner);
  const queued = await f.metadata(q), { run } = await writing(f, q);
  assert.deepEqual(await f.artifact(q, 'OPERATOR_NOTES.md'), Buffer.from(opaqueNotes));
  assert.equal(queued.revision.notesBytes, Buffer.byteLength(opaqueNotes)); assert.equal(queued.revision.notesSha256, digest(opaqueNotes));
  assert.equal(queued.artifacts.notes.artifact, `project/reports/${q.reportId}/OPERATOR_NOTES.md`);
  assert.equal(f.calls.writer.at(-1).revisionMode, 'operator-notes'); assert.equal(f.calls.gather.length, gathers);
  const prompt = JSON.parse(f.calls.writer.at(-1).prompt.trimEnd().split('\n').at(-1));
  assert.equal(prompt.operator_notes, opaqueNotes); assert.equal(Object.hasOwn(prompt, 'citation_fixes'), false);
  const taskFields = f.tasks.get(q.taskId).metadata;
  assert.ok(Object.values(taskFields).every(value => typeof value === 'string' || typeof value === 'number'));
  for (const forbidden of ['notes', 'verificationReportId', 'verdictsSha256', 'originalLedgerSha256', 'citationStatus']) assert.equal(Object.hasOwn(taskFields, forbidden), false);
  f.complete(revisionResponse([['absent', 'x'], ['Opaque text.', 'Opaque revised text.']])); await run;
  const proposal = JSON.parse(await f.artifact(q, 'REVISION_PROPOSAL.json')), status = await f.rawService.status(f.p, q, owner, revisionKind);
  assert.deepEqual(proposal.revisionOutcome.skipped, [{ edit: 1, reason: 'FIND_NOT_FOUND' }]);
  assert.equal(status.state, 'completed'); assert.equal(status.citationStatus, 'not-requested'); assert.equal(Object.hasOwn(status, 'inheritedCitationStatus'), false);
  assert.equal(proposal.citationStatus, 'not-requested'); assert.equal(Object.hasOwn(proposal, 'inheritedCitationStatus'), false);
  assert.equal(proposal.binding.mode, 'operator-notes'); assert.equal(proposal.provenanceReconciliation.parentMappingState, 'present');
  assert.deepEqual(proposal.provenanceReconciliation.unresolvedLabels, ['opaque']);
  assert.deepEqual(proposal.provenanceReconciliation.reusableMapping, {});
  assert.equal(status.mathematicsStatus, 'unreviewed'); assert.equal(status.reviewStatus, 'unreviewed'); assert.equal(status.compileStatus, 'not-run');
  assert.deepEqual(await f.artifact(q, 'INHERITED_REFERENCE_LEDGER.md'), before[2]);
  assert.deepEqual(await f.artifact(q, 'INHERITED_PROVENANCE.json'), before[3]);
  assert.deepEqual(await notesParentBytes(f, a.source), before);
  const result = await f.rawService.result(f.p, q, owner, revisionKind);
  assert.deepEqual(result.files.map(row => row.role), ['source', 'summary', 'proposal', 'ledger']);
  assert.equal(f.calls.stages.some(row => row.name === 'OPERATOR_NOTES.md' || row.name === 'raw-response.txt'), false);
  for (const publicData of [queued, await f.metadata(q), taskFields, status, result, proposal, f.tasks.get(q.taskId).result]) assert.equal(JSON.stringify(publicData).includes(JSON.stringify(opaqueNotes).slice(1, -1)), false);
  assert.equal(f.calls.writer.length, 2); assert.equal(f.calls.literature.length, 0);
});

test('operator-notes genuine Project/public dispatch accepts source directly without verification or new Core work', async t => {
  const sourceFixture = await fixture(t), a = await notesSource(sourceFixture), started = defer(), output = defer();
  const binding = { sessionId: 'opaque-public-notes', agentId: 'math-paper-reviser-01234567-89ab-cdef-0123-456789abcdef' };
  const writer = { async start(input) {
    assert.equal(input.kind, 'paper-revision'); assert.equal(input.revisionMode, 'operator-notes');
    await input.onBound(binding); started.resolve();
    return { done: output.promise, async stop() { const stopped = { state: 'stopped', cleanupPending: false }; output.resolve(stopped); return stopped; } };
  }, async dispose() { return { cleanupPending: false, errors: [] }; } };
  const real = await projectFixture(t, { multiWorker: true, summaryWriter: writer }), p = await real.create(), store = createContextStore(real.dataDir);
  const project = await store.readJson(`research/projects/${p.projectId}/project.json`), meta = await sourceFixture.metadata(a.source);
  meta.projectId = p.projectId; meta.creator = project.creator; meta.paper.target.projectId = p.projectId;
  for (const artifact of Object.values(meta.artifacts)) {
    const bytes = await sourceFixture.store.read(artifact.artifact); artifact.artifact = `research/projects/${p.projectId}/reports/${a.source.reportId}/${artifact.name}`;
    await store.write(artifact.artifact, bytes);
  }
  await store.write(`research/projects/${p.projectId}/reports/${a.source.reportId}/metadata.json`, JSON.stringify(meta)); await real.open();
  const input = { projectId: p.projectId, reportId: a.source.reportId, mode: 'operator-notes', notes: opaqueNotes };
  await assert.rejects(real.service.paperRevise(input, p.context), { code: 'PROJECT_SUMMARY_DENIED' });
  const tools = new Map(); real.sdk.tools.register = async tool => { tools.set(tool.name, tool); return () => {}; };
  const unexpected = async () => assert.fail('legacy/model fallback forbidden');
  const legacy = Object.fromEntries(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection'].map(key => [key, unexpected]));
  const registration = await registerMathResearch(real.sdk, legacy, real.service); t.after(() => registration.dispose());
  const coreCalls = real.calls.core.length, reply = await tools.get('math_project').execute({ action: 'paper_revise', ...input, context: projectOwner });
  assert.equal(reply.isError, false, JSON.stringify(reply.details)); const q = reply.details;
  const schedule = [...real.schedules.values()].find(row => row.payload.reportId === q.reportId);
  const run = real.handlers.get('math-project-report').run({ kind: 'schedule', scheduleId: schedule.scheduleId, input: schedule.payload });
  await Promise.race([started.promise, run.then(() => assert.fail('notes writer not reached'))]);
  output.resolve({ ...binding, state: 'completed', model: null, toolSelection: null, modelStopReason: 'stop', cleanupPending: false, finalText: revisionResponse([]) }); await run;
  const result = await tools.get('math_project').execute({ action: 'paper_revision_result', projectId: p.projectId, reportId: q.reportId, context: projectOwner });
  assert.equal(result.isError, false, JSON.stringify(result.details)); assert.equal(result.details.status, 'no_edits_applied'); assert.equal(result.details.citationStatus, 'not-requested');
  assert.deepEqual(result.details.files, []); assert.equal(real.calls.core.length, coreCalls); assert.equal(real.calls.literature.length, 0);
  assert.deepEqual(await store.read(`research/projects/${p.projectId}/reports/${q.reportId}/OPERATOR_NOTES.md`), Buffer.from(opaqueNotes));
});

test('operator-notes archives exact 32 KiB, Unicode CRLF and leading U+FEFF without source-text normalization', async t => {
  const f = await fixture(t), a = await notesSource(f);
  for (const notes of ['x'.repeat(32768), '界'.repeat(10922) + 'ab', '\ufeff  Opaque 编辑🙂\r\n ']) {
    const q = await f.rawService.start(f.p, { ...a.args, notes }, owner), bytes = await f.artifact(q, 'OPERATOR_NOTES.md'), meta = await f.metadata(q);
    assert.deepEqual(bytes, Buffer.from(notes)); assert.equal(meta.revision.notesBytes, bytes.length); assert.equal(meta.revision.notesSha256, digest(bytes));
    await f.rawService.stop(f.p, q, owner, revisionKind);
  }
  const tasks = f.tasks.size;
  for (const notes of ['x'.repeat(32769), '界'.repeat(10922) + 'abc', '\0', '\ud800']) {
    await assert.rejects(f.rawService.start(f.p, { ...a.args, notes }, owner), { code: 'PROJECT_INVALID_INPUT' });
  }
  assert.equal(f.tasks.size, tasks); assert.equal(f.calls.writer.length, 1); assert.equal(f.calls.stages.length, 0);
});

test('operator-notes no-op reasons retain only archived notes plus raw response with empty repeatable delivery and explicit SDK false', async t => {
  const f = await fixture(t), a = await notesSource(f, 'dropAnchor UniqueTail.'), before = await notesParentBytes(f, a.source);
  for (const [edits, reason] of [[[], 'EMPTY_PATCH'], [[['absent', 'x']], 'ALL_INVALID'], [[['Opaque text.', 'Opaque text.']], 'ALL_NO_CHANGE'],
    [[['absent', 'x'], ['Opaque text.', 'Opaque text.']], 'MIXED_SKIPS'], [[['dropAnchor', ''], [' UniqueTail.', 'dropAnchor UniqueTail.']], 'NET_NO_CHANGE']]) {
    const q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q);
    f.complete(revisionResponse(edits)); await run;
    const meta = await f.metadata(q), first = await f.rawService.result(f.p, q, owner, revisionKind);
    assert.equal(first.status, 'no_edits_applied', reason); assert.equal(first.revisionOutcome.reason, reason);
    assert.equal(first.proposalProduced, false); assert.equal(first.sourceStatus, 'not-produced'); assert.equal(first.sha256, null); assert.equal(first.bytes, null);
    assert.deepEqual(first.files, []); assert.equal(first.diagnosis.responseSaved, true); assert.deepEqual(Object.keys(meta.artifacts).sort(), ['notes', 'response']);
    assert.equal(f.tasks.get(q.taskId).result.proposalProduced, false); assert.equal(f.tasks.get(q.taskId).status, 'completed');
    const frozen = await f.artifact(q, 'metadata.json'), writers = f.calls.writer.length;
    assert.deepEqual(await f.rawService.result(f.p, q, owner, revisionKind), first); await f.open();
    assert.deepEqual(await f.rawService.result(f.p, q, owner, revisionKind), first); assert.deepEqual(await f.artifact(q, 'metadata.json'), frozen);
    assert.equal(f.calls.writer.length, writers); assert.equal(f.calls.stages.length, 0); assert.deepEqual(await notesParentBytes(f, a.source), before);
  }
});

test('operator-notes keeps literal-key diagnostics and inherited flagged status without a verification judgment', async t => {
  for (const [extra, replacement, expected] of [
    ['', String.raw`\cite{PrivateUnknown}`, 'flagged'], ['', String.raw`\cite{\dynamicKey}`, 'incomplete'],
    ['[GAP: opaque support]', 'Opaque repaired sentence.', 'no-literal-key-issues'],
  ]) {
    const f = await fixture(t, { references: true }), a = await notesSource(f, extra), q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q);
    f.complete(patchOutput(extra || 'Opaque text.', replacement)); await run;
    const proposal = JSON.parse(await f.artifact(q, 'REVISION_PROPOSAL.json'));
    assert.equal(proposal.citationKeyCheck.status, expected); assert.equal(proposal.sourceStatus, 'flagged'); assert.equal(proposal.citationStatus, 'not-requested');
    assert.equal(proposal.mathematicsStatus, 'unreviewed'); assert.equal(proposal.compileStatus, 'not-run');
  }
});

test('operator-notes rejects malformed inherited provenance even for a no-op and preserves raw evidence only', async t => {
  const f = await fixture(t), a = await notesSource(f), parent = await f.metadata(a.source), invalid = Buffer.from('{"opaque":"not-a-fact-id"}');
  parent.artifacts.provenance.sha256 = digest(invalid); parent.artifacts.provenance.bytes = invalid.length;
  await f.store.write(parent.artifacts.provenance.artifact, invalid, true); await f.store.write(`project/reports/${a.source.reportId}/metadata.json`, JSON.stringify(parent), true); await f.open();
  const q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q); f.complete(revisionResponse([])); await run;
  const result = await f.rawService.result(f.p, q, owner, revisionKind);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'PROJECT_PAPER_REVISION_SOURCE_INVALID'); assert.deepEqual(result.files, []);
  assert.deepEqual(Object.keys((await f.metadata(q)).artifacts).sort(), ['notes', 'response']); assert.equal(f.calls.stages.length, 0);
});

test('operator-notes partial input archive failures remain loadable, cleanable and never replay a model', async t => {
  for (const point of ['before-write', 'after-write', 'descriptor-save']) await t.test(point, async t => {
    const f = await fixture(t), a = await notesSource(f), write = f.store.write; let triggered = false;
    f.store.write = async (name, bytes, ...rest) => {
      if (!triggered && ((point !== 'descriptor-save' && name.endsWith('/OPERATOR_NOTES.md'))
        || (point === 'descriptor-save' && name.endsWith('/metadata.json') && JSON.parse(bytes).artifacts?.notes))) {
        triggered = true; if (point === 'after-write') await write(name, bytes, ...rest);
        throw Object.assign(new Error('archive fixture failure'), { code: 'HOST_UNAVAILABLE' });
      }
      return write(name, bytes, ...rest);
    };
    let q; await assert.rejects(f.rawService.start(f.p, a.args, owner).catch(error => { q = { reportId: error.reportId }; throw error; }), { code: 'HOST_UNAVAILABLE' });
    assert.equal(triggered, true); f.store.write = write;
    const meta = await f.metadata(q); assert.equal(meta.state, 'failed'); assert.equal(meta.taskId, null);
    await f.open(); const recovered = await f.rawService.status(f.p, q, owner, revisionKind);
    assert.notEqual(recovered.state, 'completed'); await f.rawService.stop(f.p, q, owner, revisionKind);
    assert.equal(f.calls.writer.length, 1); assert.equal(f.calls.stages.length, 0);
    // A separately failed input must not poison report admission or discard cleanup evidence.
    await f.rawService.start(f.p, { language: 'English' }, owner);
  });
});

test('operator-notes input and selector snapshots precede awaits at Project and report admission', async t => {
  const f = await fixture(t), a = await notesSource(f), input = structuredClone(a.args);
  const pending = f.rawService.start(f.p, input, owner); input.notes = 'later mutation'; input.revision.sourceReportId = 'foreign'; input.revision.mode = 'citation';
  const q = await pending; assert.equal((await f.artifact(q, 'OPERATOR_NOTES.md')).toString(), opaqueNotes);
  await f.rawService.stop(f.p, q, owner, revisionKind);
  let reads = 0; const getter = { ...a.args }; Object.defineProperty(getter, 'notes', { enumerable: true, get() { reads++; return opaqueNotes; } });
  await assert.rejects(f.rawService.start(f.p, getter, owner), { code: 'PROJECT_INVALID_INPUT' });
  await assert.rejects(f.rawService.start(f.p, new Proxy(a.args, { getOwnPropertyDescriptor() { reads++; return undefined; } }), owner), { code: 'PROJECT_INVALID_INPUT' });
  assert.equal(reads, 0);
  const real = await projectFixture(t), project = await real.service.create({ problem: 'Opaque fixture' }, projectOwner);
  const direct = { projectId: project.projectId, reportId: a.source.reportId, mode: 'operator-notes', notes: opaqueNotes };
  const waiting = real.service.paperRevise(direct, projectOwner); direct.mode = 'citation'; direct.notes = null; direct.reportId = '../file';
  await assert.rejects(waiting, { code: 'PROJECT_REPORT_NOT_FOUND' });
  const bad = { projectId: project.projectId, reportId: a.source.reportId, mode: 'operator-notes' };
  Object.defineProperty(bad, 'notes', { enumerable: true, get() { reads++; return opaqueNotes; } });
  await assert.rejects(real.service.paperRevise(bad, projectOwner), { code: 'PROJECT_INVALID_INPUT' }); assert.equal(reads, 0);
});

test('operator-notes admission captures before reread and rejects archive/source changes before queue', async t => {
  for (const phase of ['captured-source', 'archived-notes', 'task-created']) await t.test(phase, async t => {
    const f = await fixture(t), a = await notesSource(f), read = f.store.read, write = f.store.write; let changed = false;
    if (phase === 'captured-source') f.store.read = async name => {
      const bytes = await read(name);
      if (!changed && name === `project/reports/${a.source.reportId}/main.tex`) { changed = true; await write(name, 'changed after capture', true); }
      return bytes;
    };
    if (phase === 'archived-notes') f.store.write = async (name, bytes, ...rest) => {
      await write(name, bytes, ...rest);
      if (!changed && name.endsWith('/OPERATOR_NOTES.md')) { changed = true; await write(name, 'changed archive', true); }
    };
    if (phase === 'task-created') f.createReceipt(task => {
      if (task.metadata.mode === 'operator-notes') { changed = true; f.tasks.get(task.taskId).metadata.notesBytes++; }
    });
    await assert.rejects(f.rawService.start(f.p, a.args, owner)); assert.equal(changed, true);
    assert.equal(f.calls.writer.length, 1); assert.equal(f.calls.stages.length, 0);
  });
});

test('operator-notes queue, onBound and return rechecks refuse notes/source/provenance drift without derived artifacts', async t => {
  for (const phase of ['queue', 'bound', 'return']) for (const material of ['notes', 'main.tex', 'REFERENCE_LEDGER.md', 'provenance.json']) await t.test(`${phase}/${material}`, async t => {
    const f = await fixture(t), a = await notesSource(f), q = await f.rawService.start(f.p, a.args, owner);
    const change = () => f.store.write(material === 'notes' ? `project/reports/${q.reportId}/OPERATOR_NOTES.md` : `project/reports/${a.source.reportId}/${material}`, 'changed material', true);
    if (phase === 'queue') { await change(); await f.dispatch(q); }
    if (phase === 'bound') { f.beforeBound(change); await f.dispatch(q); }
    if (phase === 'return') { const { run } = await writing(f, q); await change(); f.complete(revisionResponse([])); await run; }
    const meta = await f.metadata(q); assert.notEqual(meta.state, 'completed'); assert.equal(meta.artifacts.source, undefined);
    assert.equal(meta.artifacts.proposal, undefined); assert.equal(f.calls.stages.length, 0);
    assert.equal(f.calls.writer.length, phase === 'queue' ? 1 : 2);
  });
});

test('operator-notes guards every derived artifact and final exclusive no-op against changed archived inputs', async t => {
  for (const filename of ['proposal.tex', 'REVISION_SUMMARY.md', 'REVISION_PROPOSAL.json', 'INHERITED_REFERENCE_LEDGER.md', 'INHERITED_PROVENANCE.json']) await t.test(filename, async t => {
    const f = await fixture(t), a = await notesSource(f), q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q), write = f.store.write;
    let changed = false;
    f.store.write = async (name, bytes, ...rest) => {
      await write(name, bytes, ...rest);
      if (!changed && name.endsWith(`/${q.reportId}/${filename}`)) { changed = true; await write(`project/reports/${q.reportId}/OPERATOR_NOTES.md`, 'changed archived instructions', true); }
    };
    f.complete(patchOutput()); await run; assert.equal(changed, true);
    const result = await f.rawService.result(f.p, q, owner, revisionKind);
    assert.equal(result.state, 'failed'); assert.deepEqual(result.files, []); assert.equal(f.calls.stages.length, 0);
  });
  const f = await fixture(t), a = await notesSource(f), q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q);
  const write = f.store.write, getTask = f.sdk.tasks.get, reached = defer(), release = defer(); let rawSaved = false, guards = 0;
  f.store.write = async (...args) => { await write(...args); if (args[0].endsWith(`/${q.reportId}/raw-response.txt`)) rawSaved = true; };
  f.sdk.tasks.get = async id => { const task = await getTask(id); if (id === q.taskId && rawSaved && ++guards === 3) { reached.resolve(); await release.promise; } return task; };
  f.complete(revisionResponse([])); await Promise.race([reached.promise, run.then(() => assert.fail('exclusive final guard not reached'))]);
  await write(`project/reports/${q.reportId}/OPERATOR_NOTES.md`, 'changed at final authority read', true); release.resolve(); await run;
  const result = await f.rawService.result(f.p, q, owner, revisionKind); assert.equal(result.state, 'failed'); assert.deepEqual(result.files, []);
  assert.deepEqual(Object.keys((await f.metadata(q)).artifacts).sort(), ['notes', 'response']); assert.equal(f.calls.stages.length, 0);
});

test('operator-notes lifecycle and task authority changes cannot complete either a proposal or a no-op', async t => {
  for (const change of ['owner', 'authority', 'permission', 'stop', 'dispose']) await t.test(change, async t => {
    const f = await fixture(t), a = await notesSource(f), q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q);
    if (change === 'owner') f.p.meta.creator = { ...creator, sessionId: 'foreign' };
    if (change === 'authority') f.tasks.get(q.taskId).metadata.notesSha256 = 'f'.repeat(64);
    if (change === 'permission') { const get = f.sdk.tasks.get; f.sdk.tasks.get = async id => { if (id === q.taskId) throw Object.assign(new Error('revoked'), { code: 'PERMISSION_DENIED' }); return get(id); }; }
    if (change === 'stop') await f.rawService.stop(f.p, q, owner, revisionKind);
    if (change === 'dispose') await f.rawService.dispose();
    f.complete(revisionResponse([])); await run;
    const meta = await f.metadata(q); assert.notEqual(meta.state, 'completed'); assert.equal(meta.artifacts.source, undefined); assert.equal(meta.artifacts.proposal, undefined);
    assert.equal(f.calls.stages.length, 0);
  });
});

test('operator-notes missing/replaced input descriptors and failed/running diagnostics recover without replay or false no-op', async t => {
  for (const state of ['failed', 'running']) await t.test(state, async t => {
    const f = await fixture(t), a = await notesSource(f), q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q);
    f.complete(revisionResponse([])); await run;
    const meta = await f.metadata(q); meta.state = state; meta.error = state === 'failed' ? 'OPAQUE_FAILURE' : null;
    delete meta.artifacts.notes; await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify(meta), true); await f.open();
    const result = await f.rawService.result(f.p, q, owner, revisionKind); assert.notEqual(result.status, 'no_edits_applied'); assert.deepEqual(result.files, []); assert.equal(f.calls.writer.length, 2);
  });
  for (const change of ['missing', 'descriptor', 'bytes']) await t.test(change, async t => {
    const f = await fixture(t), a = await notesSource(f), q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q);
    f.complete(revisionResponse([])); await run; const meta = await f.metadata(q);
    assert.equal(meta.revisionOutcome.reason, 'EMPTY_PATCH'); assert.equal(meta.sourceStatus, 'not-produced');
    if (change === 'missing') await fs.unlink(f.store.absolute(meta.artifacts.notes.artifact));
    if (change === 'descriptor') { meta.artifacts.notes.artifact = `project/reports/${q.reportId}/elsewhere.md`; await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify(meta), true); }
    if (change === 'bytes') {
      const tampered = Buffer.from(await f.artifact(q, 'OPERATOR_NOTES.md')); tampered[0] ^= 1;
      assert.equal(tampered.length, meta.artifacts.notes.bytes); assert.notEqual(digest(tampered), meta.artifacts.notes.sha256);
      await f.store.write(meta.artifacts.notes.artifact, tampered, true);
      assert.deepEqual(await f.metadata(q), meta, 'byte tampering must not update the bound metadata hash');
    }
    const frozen = await f.artifact(q, 'metadata.json');
    await f.open();
    await assert.rejects(f.rawService.status(f.p, q, owner, revisionKind), { code: 'PROJECT_REPORT_NOT_FOUND' });
    await assert.rejects(f.rawService.result(f.p, q, owner, revisionKind), { code: 'PROJECT_REPORT_NOT_FOUND' });
    assert.deepEqual(await f.artifact(q, 'metadata.json'), frozen, 'invalid completed evidence is not rewritten or cleaned');
    assert.equal(f.calls.writer.length, 2); assert.equal(f.calls.stages.length, 0);
  });
});

test('operator-notes final metadata save failure preserves uncertainty and both input artifacts', async t => {
  const f = await fixture(t), a = await notesSource(f), q = await f.rawService.start(f.p, a.args, owner), { run } = await writing(f, q), write = f.store.write; let failed = false;
  f.store.write = async (name, bytes, ...rest) => {
    if (!failed && name.endsWith(`/${q.reportId}/metadata.json`) && JSON.parse(bytes).state === 'completed') { failed = true; throw Object.assign(new Error('save uncertainty'), { code: 'HOST_UNAVAILABLE' }); }
    return write(name, bytes, ...rest);
  };
  f.complete(revisionResponse([])); await run; assert.equal(failed, true);
  const status = await f.rawService.status(f.p, q, owner, revisionKind); assert.equal(status.state, 'failed'); assert.equal(status.cleanupPending, true);
  await assert.rejects(f.rawService.result(f.p, q, owner, revisionKind), { code: 'PROJECT_REPORT_NOT_READY' });
  assert.deepEqual(Object.keys((await f.metadata(q)).artifacts).sort(), ['notes', 'response']); assert.equal(f.calls.stages.length, 0);
});

async function revisionParentBytes(f, a) {
  return Promise.all([
    ...['metadata.json', 'main.tex', 'REFERENCE_LEDGER.md', 'provenance.json'].map(name => f.artifact(a.source, name)),
    ...['metadata.json', 'REFERENCE_VERDICTS.json', 'REFERENCE_LEDGER.md'].map(name => f.artifact(a.verification, name)),
  ]);
}
test('revision no-op reasons complete tasks with raw evidence only, immutable parents and repeatable side-effect-free result', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f), before = await revisionParentBytes(f, a);
  const cases = [
    [[], 'EMPTY_PATCH'], [[['absent', 'replacement']], 'ALL_INVALID'],
    [[['Opaque text.', 'Opaque text.']], 'ALL_NO_CHANGE'],
    [[['Opaque text.', 'Opaque text.'], ['absent', 'replacement']], 'MIXED_SKIPS'],
    [[['Opaque', ''], [' text.', 'Opaque text.']], 'NET_NO_CHANGE'],
  ];
  for (const [edits, reason] of cases) {
    const q = await f.rawService.start(f.p, a.revisionArgs, owner), binding = (await f.metadata(q)).revision;
    const { run } = await writing(f, q), raw = revisionResponse(edits);
    f.complete(raw); await run;
    const result = await f.rawService.result(f.p, q, owner, revisionKind), meta = await f.metadata(q);
    assert.equal(result.state, 'completed'); assert.equal(result.status, 'no_edits_applied');
    assert.equal(result.publicationStatus, 'no_edits_applied'); assert.equal(result.sourceStatus, 'not-produced');
    assert.equal(result.proposalProduced, false); assert.equal(result.sha256, null); assert.equal(result.bytes, null);
    assert.deepEqual(result.files, []); assert.equal(result.diagnosis.responseSaved, true);
    assert.equal(result.revisionOutcome.reason, reason); assert.deepEqual(meta.revisionOutcome, result.revisionOutcome);
    assert.deepEqual(meta.revision, binding); assert.equal(meta.taskSettlement, 'confirmed'); assert.equal(meta.cleanupPending, false);
    assert.deepEqual(Object.keys(meta.artifacts), ['response']);
    assert.deepEqual(meta.delivery, { state: 'published', delivered: false }, 'normal task delivery bookkeeping is not file staging');
    assert.deepEqual((await f.store.list(`project/reports/${q.reportId}`)).sort(), ['metadata.json', 'raw-response.txt']);
    assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), raw);
    const task = f.tasks.get(q.taskId);
    assert.equal(task.status, 'completed'); assert.equal(task.result.status, 'completed'); assert.equal(task.result.proposalProduced, false);
    assert.deepEqual(task.result.revisionOutcome, result.revisionOutcome); assert.equal(task.result.sha256, null);
    assert.equal(Object.hasOwn(task.metadata, 'revisionOutcome'), false);
    const writerCount = f.calls.writer.length, saved = await f.artifact(q, 'metadata.json');
    assert.deepEqual(await f.rawService.result(f.p, q, owner, revisionKind), result);
    assert.deepEqual(await f.artifact(q, 'metadata.json'), saved);
    await f.open();
    assert.deepEqual(await f.rawService.result(f.p, q, owner, revisionKind), result);
    assert.equal(f.calls.writer.length, writerCount); assert.equal(f.calls.stages.length, 0);
    assert.deepEqual(await revisionParentBytes(f, a), before);
    assert.deepEqual((await revisionParentBytes(f, a)).map(digest), before.map(digest));
  }
});

test('mixed revision skips still publish only a changed child and never alter parent ledger/provenance bytes', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f), before = await revisionParentBytes(f, a);
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q);
  f.complete(revisionResponse([['absent', 'replacement'], ['Opaque text.', 'Opaque text.'], ['Opaque text.', 'Changed text.'], ['Changed text.', 'replay']]));
  await run;
  const result = await f.rawService.result(f.p, q, owner, revisionKind);
  assert.equal(result.revisionOutcome.status, 'proposal'); assert.equal(result.revisionOutcome.appliedCount, 1);
  assert.deepEqual(result.revisionOutcome.skipped, [{ edit: 1, reason: 'FIND_NOT_FOUND' }, { edit: 2, reason: 'NO_CHANGE' }, { edit: 4, reason: 'OVERLAPPING_EDIT' }]);
  assert.match((await f.artifact(q, 'proposal.tex')).toString(), /Changed text\./);
  assert.deepEqual(JSON.parse(await f.artifact(q, 'REVISION_PROPOSAL.json')).revisionOutcome, result.revisionOutcome);
  assert.deepEqual(await revisionParentBytes(f, a), before);
});

test('no-op cannot bypass malformed original provenance or claim a failed computation succeeded', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  const bytes = Buffer.from('{"PrivateInvalidLabel":"not-a-fact-id"}'), meta = await f.metadata(a.source);
  meta.artifacts.provenance.sha256 = digest(bytes); meta.artifacts.provenance.bytes = bytes.length;
  await f.store.write(`project/reports/${a.source.reportId}/provenance.json`, bytes, true);
  await f.store.write(`project/reports/${a.source.reportId}/metadata.json`, JSON.stringify(meta), true); await f.open();
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q);
  f.complete(revisionResponse([])); await run;
  const result = await f.rawService.result(f.p, q, owner, revisionKind);
  assert.equal(result.state, 'failed'); assert.equal(result.status, 'failed'); assert.equal(result.error, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
  assert.equal(result.revisionOutcome.status, 'no_edits_applied'); assert.notEqual(result.publicationStatus, 'no_edits_applied');
  assert.equal(result.diagnosis.responseSaved, true); assert.deepEqual(result.files, []);
  assert.equal(JSON.stringify(result).includes('PrivateInvalidLabel'), false);
  assert.deepEqual(Object.keys((await f.metadata(q)).artifacts), ['response']); assert.equal(f.calls.stages.length, 0);
});

test('legacy completed revision lacks outcome without backfill; malformed new outcomes fail recovery closed', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q);
  f.complete(patchOutput()); await run;
  const original = await f.metadata(q), legacy = structuredClone(original); delete legacy.revisionOutcome;
  const proposal = await f.artifact(q, 'REVISION_PROPOSAL.json');
  await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify(legacy), true); await f.open();
  const result = await f.rawService.result(f.p, q, owner, revisionKind);
  assert.equal(result.state, 'completed'); assert.equal(result.status, 'ok'); assert.equal(Object.hasOwn(result, 'revisionOutcome'), false);
  assert.equal(Object.hasOwn(await f.metadata(q), 'revisionOutcome'), false);
  assert.deepEqual(await f.artifact(q, 'REVISION_PROPOSAL.json'), proposal);
  const count = f.calls.writer.length;
  for (const outcome of [null, { ...original.revisionOutcome, parsedCount: 129 }, { ...original.revisionOutcome, appliedCount: 0 }]) {
    await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify({ ...original, revisionOutcome: outcome }), true); await f.open();
    await assert.rejects(f.rawService.status(f.p, q, owner, revisionKind), { code: 'PROJECT_REPORT_NOT_FOUND' });
    assert.equal(f.calls.writer.length, count);
  }
});

test('computed no-op diagnostics in failed or recovered running records do not become successful no-op results', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q);
  f.complete(revisionResponse([])); await run;
  const original = await f.metadata(q), count = f.calls.writer.length;
  for (const state of ['failed', 'running']) {
    await f.store.write(`project/reports/${q.reportId}/metadata.json`, JSON.stringify({ ...original, state, error: 'PROJECT_REPORT_INTERRUPTED' }), true);
    await f.open();
    const result = await f.rawService.result(f.p, q, owner, revisionKind);
    assert.equal(result.status, 'failed'); assert.notEqual(result.publicationStatus, 'no_edits_applied');
    assert.equal(result.revisionOutcome.reason, 'EMPTY_PATCH'); assert.deepEqual(result.files, []);
    assert.equal(f.calls.writer.length, count); assert.equal(f.calls.stages.length, 0);
  }
});

test('no-op final guards refuse source drift, ownership/authority changes, stop and dispose without derived output', async t => {
  for (const change of ['source', 'owner', 'authority', 'stop', 'dispose']) {
    const f = await fixture(t, { references: true }), a = await completedVerification(f);
    const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q);
    const write = f.store.write, getTask = f.sdk.tasks.get, reached = defer(), release = defer();
    let rawSaved = false, held = false;
    f.store.write = async (...args) => { await write(...args); if (args[0].endsWith(`/${q.reportId}/raw-response.txt`)) rawSaved = true; };
    f.sdk.tasks.get = async id => {
      const task = await getTask(id);
      if (id === q.taskId && rawSaved && !held) { held = true; reached.resolve(); await release.promise; }
      return task;
    };
    f.complete(revisionResponse([]));
    await Promise.race([reached.promise, run.then(() => { throw new Error('no-op final guard was not reached'); })]);
    if (change === 'source') await f.store.write(`project/reports/${a.source.reportId}/main.tex`, 'changed source', true);
    if (change === 'owner') f.p.meta.creator = { ...creator, sessionId: 'foreign' };
    if (change === 'authority') f.tasks.get(q.taskId).pluginId = 'foreign';
    if (change === 'stop') await f.rawService.stop(f.p, q, owner, revisionKind);
    if (change === 'dispose') await f.rawService.dispose();
    release.resolve(); await run;
    const status = await f.rawService.status(f.p, q, owner, revisionKind);
    assert.notEqual(status.state, 'completed', change); assert.notEqual(status.publicationStatus, 'no_edits_applied', change);
    assert.equal((await f.artifact(q, 'raw-response.txt')).toString(), revisionResponse([]));
    assert.deepEqual(Object.keys((await f.metadata(q)).artifacts), ['response']); assert.equal(f.calls.stages.length, 0);
  }
});

test('no-op metadata save failure retains uncertainty, never a successful result or derived files', async t => {
  const f = await fixture(t, { references: true }), a = await completedVerification(f);
  const q = await f.rawService.start(f.p, a.revisionArgs, owner), { run } = await writing(f, q), write = f.store.write;
  let failed = false;
  f.store.write = async (name, bytes, ...rest) => {
    if (!failed && name.endsWith(`/${q.reportId}/metadata.json`)) {
      const meta = JSON.parse(bytes);
      if (meta.state === 'completed' && meta.revisionOutcome?.status === 'no_edits_applied') {
        failed = true; throw Object.assign(new Error('fixture persistence failure'), { code: 'HOST_UNAVAILABLE' });
      }
    }
    return write(name, bytes, ...rest);
  };
  f.complete(revisionResponse([])); await run;
  assert.equal(failed, true);
  const status = await f.rawService.status(f.p, q, owner, revisionKind);
  assert.equal(status.state, 'failed'); assert.equal(status.cleanupPending, true); assert.notEqual(status.publicationStatus, 'no_edits_applied');
  await assert.rejects(f.rawService.result(f.p, q, owner, revisionKind), { code: 'PROJECT_REPORT_NOT_READY' });
  assert.deepEqual(Object.keys((await f.metadata(q)).artifacts), ['response']); assert.equal(f.calls.stages.length, 0);
});

test('in-memory handle stop clears stale recoveryStop and recoveryError receipts on both clean and failing handle stops', async t => {
  const planKind = { kind: 'paper-plan' };
  for (const mode of ['stale-recovery-stop', 'stale-recovery-error']) await t.test(mode, async t => {
    const f = await fixture(t, { plan: true });
    const origStart = f.writer.start;
    const boundReached = defer(), releaseHandle = defer(), handleAssigned = defer();
    let handleStops = 0, assigned = false;
    if (mode === 'stale-recovery-error') {
      // Streaming session forces confirmResearchSessionStop to invoke sessions.abort, recording recoveryError.
      f.sdk.sessions.context = async ({ sessionId }) => ({ sessionId, isStreaming: true, isCompacting: false, pendingMessageCount: 1 });
      f.sdk.sessions.abort = async () => { throw Object.assign(new Error('abort failed'), { code: 'HOST_UNAVAILABLE' }); };
    }
    f.writer.start = async input => {
      const origOnBound = input.onBound;
      let boundDone = false;
      const wrapped = await origStart({
        ...input,
        async onBound(binding) {
          const out = await origOnBound(binding);
          boundDone = true;
          return out;
        },
        async onUpdate(snapshot) {
          const out = await input.onUpdate(snapshot);
          if (boundDone) {
            boundReached.resolve();
            await releaseHandle.promise;
          }
          return out;
        },
      });
      return {
        done: wrapped.done,
        async stop() {
          handleStops++;
          if (mode === 'stale-recovery-error') throw Object.assign(new Error('handle stop failed'), { code: 'HOST_UNAVAILABLE' });
          const res = await wrapped.stop();
          // Keep cleanupPending true on the catch-path stop so the explicit second stop() enters
          // stopInternal()'s in-memory `if (r.handle)` branch and must delete the stale recoveryStop receipt.
          return handleStops === 1 ? { ...res, cleanupPending: true } : res;
        },
      };
    };
    const origWrite = f.store.write;
    f.store.write = async (name, bytes, ...rest) => {
      await origWrite(name, bytes, ...rest);
      if (!assigned && name.endsWith('/metadata.json')) {
        const meta = JSON.parse(bytes);
        if (meta.writerStarting === false && meta.writer?.sessionId && (meta.recoveryStop || meta.recoveryError)) {
          assigned = true;
          handleAssigned.resolve();
        }
      }
    };
    t.after(() => releaseHandle.resolve());

    const q = await f.start();
    const run = f.dispatch(q);
    await boundReached.promise;

    // First stop runs while r.meta.writer.sessionId exists but r.handle is not yet assigned,
    // recording a recoveryStop or recoveryError receipt on the report metadata.
    const firstStop = await f.rawService.stop(f.p, q, owner, planKind);
    assert.equal(firstStop.cleanupPending, true);
    if (mode === 'stale-recovery-stop') {
      assert.deepEqual(firstStop.sessionStop, { outcome: 'aborted', confirmed: true, error: null });
      assert.equal((await f.metadata(q)).recoveryStop, 'aborted');
    } else {
      assert.deepEqual(firstStop.sessionStop, { outcome: null, confirmed: false, error: 'HOST_UNAVAILABLE' });
      assert.equal((await f.metadata(q)).recoveryError, 'HOST_UNAVAILABLE');
    }

    // Allow summaryWriter.start() to return the handle so r.handle is assigned, then call stop() again.
    releaseHandle.resolve();
    await handleAssigned.promise;
    await run;
    const secondStop = await f.rawService.stop(f.p, q, owner, planKind);

    assert.equal(handleStops >= 1, true);
    assert.equal(secondStop.sessionStop, null);
    assert.equal(secondStop.cleanupPending, mode === 'stale-recovery-error');
    const saved = await f.metadata(q);
    assert.equal(Object.hasOwn(saved, 'recoveryStop'), false);
    assert.equal(Object.hasOwn(saved, 'recoveryError'), false);
    if (mode === 'stale-recovery-stop') {
      assert.equal(secondStop.writer?.stopEvidence, undefined);
      assert.equal(saved.cleanupPending, false);
    }
  });
});
