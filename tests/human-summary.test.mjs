// Opaque software fixtures. No real mathematics or private runtime reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createContextStore } from '../packages/hana-math/context-service.mjs';
import { createProjectReportService } from '../packages/hana-math/project-report-service.mjs';
import { bodySections, orderFacts, factBundle, buildPrompt, leakFindings, readWriterPrompt, LEAK_PATTERNS } from '../packages/hana-math/human-summary.mjs';
const A = 'a'.repeat(16), B = 'b'.repeat(16), C = 'c'.repeat(16);
const fact = (id, predecessors = [], text = 'opaque') => ({ fact_id: id, predecessors,
  markdown: `---\nfact_id: ${id}\nauthor: fixture\n---\n## statement\n${text}\n## proof\nOpaque proof.\n` });
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const owner = { callToken: 'host-token', sessionPath: '/fixture/creator.jsonl' };
const creator = { sessionId: 'creator-1', sessionPath: owner.sessionPath };


test('report assembly preserves mathematics, dependency order and fixed writer prompt', async () => {
  const facts = [fact(B, [A], `Use fact_id ${A}, $x^2$ and \\nabla u.`), fact(C), fact(A)];
  const ordered = orderFacts(facts); assert.ok(ordered.indexOf(A) < ordered.indexOf(B));
  assert.match(bodySections(facts[0].markdown), /^## statement/);
  const bundle = factBundle(facts); assert.doesNotMatch(bundle, /\b[0-9a-f]{16}\b|fact_id|author:/);
  assert.match(bundle, /\$x\^2\$/); assert.ok(bundle.includes('\\nabla u.'));
  assert.ok(bundle.includes('--- Result 1 ---\n## statement'));
  const writerPrompt = await readWriterPrompt();
  assert.ok(buildPrompt({ writerPrompt, problem: 'opaque', facts, language: 'Chinese' }).includes(writerPrompt));
});
test('all nine leak categories detected, clean prose allowed', () => {
  const examples = [A, 'author: x', 'predecessors', 'fact_lemma', 'master_guidance', 'fact_submit', 'Verifier', 'worker', 'global memory'];
  examples.forEach((text, index) => assert.ok(leakFindings(text).some(hit => hit.startsWith(LEAK_PATTERNS[index][1]))));
  assert.deepEqual(leakFindings('# Report\nA precise result.'), []);
});

async function fixture(t, options = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'report-task-'))), store = createContextStore(dataDir);
  const p = { meta: { projectId: 'project-report-test', creator }, jobs: new Set() };
  const handlers = new Map(), tasks = new Map(), schedules = new Map(), outcomes = new Map(), dispatches = [];
  const calls = { creates: [], writer: [], stages: [], staged: [], reads: [], stops: 0, completes: [], sessionLookups: 0, aborts: 0 }, writerWaiters = [], boundWaiters = [];
  let sequence = 0, asOf = '1'.repeat(64), failStage = false, htmlStageFault = null, sessionLookupFails = 0, failWriterStart = options.failWriterStart === true;
  let activeFacts = [fact(B, [A], `Use fact_id ${A}.`), fact(A)];
  let writerKind = 'math-summary:project-report-test:report-test';
  const sdk = { dataDir, sessions: {
    async get() { calls.sessionLookups++; if (sessionLookupFails > 0) { sessionLookupFails--; throw Object.assign(new Error('session lookup unavailable'), { code: 'HOST_UNAVAILABLE' }); }
      return { session: { sessionId: 'writer-session', ownerPluginId: 'hana-math', visibility: 'plugin_private', namespace: 'app', agentId: 'writer-agent', cwd: '/fixture/report', path: '/writer-session', kind: writerKind } }; },
    async list() { return { sessions: [{ sessionId: 'writer-session', ownerPluginId: 'hana-math', visibility: 'plugin_private', namespace: 'app', agentId: 'writer-agent', cwd: '/fixture/report', path: '/writer-session', kind: writerKind, lifecycle: 'active' }] }; },
    async abort() { calls.aborts++; return { aborted: true, sessionId: 'writer-session' }; },
    async context() { return { sessionId: 'writer-session', isStreaming: false, isCompacting: false, pendingMessageCount: 0 }; },
  }, resources: { async stage(input) {
    calls.stages.push(input);
    const ordinal = calls.stages.length;
    const html = /\.html$/i.test(input.name) || /^text\/html\b/i.test(input.mime);
    if (failStage || (html && htmlStageFault === 'throw')) throw Object.assign(new Error('fixture-only private stage refusal'), { code: 'APP_CAPABILITY_DENIED' });
    const bytes = await fs.readFile(input.path);
    const resource = { kind: 'session-file', sessionId: html && htmlStageFault === 'foreign' ? 'foreign-receipt-session' : creator.sessionId,
      fileId: html && htmlStageFault === 'foreign' ? 'foreign-receipt-file' : `report-file-${ordinal}` };
    calls.staged.push({ input, bytes, resource });
    return { resource };
  } }, tasks: {
    async registerHandler(name, handler) { handlers.set(name, handler); return Object.assign(() => handlers.delete(name), { ready: Promise.resolve() }); },
    async create(input) { calls.creates.push(input); const taskId = `app:hana-math:report-${++sequence}`;
      const task = { ...input, taskId, pluginId: 'hana-math', parentSessionId: creator.sessionId, parentSessionPath: creator.sessionPath, status: 'pending' };
      tasks.set(taskId, task);
      if (options.taskGate) { options.entered.resolve(); await options.taskGate.promise; }
      return structuredClone(task); },
    async get(id) { return structuredClone(tasks.get(id)); },
    async schedule(input) { const scheduleId = `report-schedule-${++sequence}`, row = { ...input, scheduleId, pluginId: 'hana-math' };
      schedules.set(scheduleId, row);
      if (options.scheduleGate) { options.entered.resolve(); await options.scheduleGate.promise; }
      if (options.autoDispatch) dispatches.push(handlers.get(input.handlerKey).run({ kind: 'schedule', scheduleId, input: input.payload }));
      return structuredClone(row); },
    async unschedule(id) { assert.ok(schedules.has(id)); schedules.delete(id); return { ok: true }; },
    async complete(id, result) { calls.completes.push(result); if (options.settlementFailure) throw Object.assign(new Error('settlement unavailable'), { code: 'HOST_UNAVAILABLE' }); const task = tasks.get(id); task.status = 'completed'; task.result = result; return structuredClone(task); },
    async fail(id, error) { if (options.settlementFailure) throw Object.assign(new Error('settlement unavailable'), { code: 'HOST_UNAVAILABLE' }); const task = tasks.get(id); task.status = 'failed'; task.error = error; return structuredClone(task); },
    async getDelivery() { if (options.deliveryError) throw Object.assign(new Error('delivery receipt unavailable'), { code: 'HOST_UNAVAILABLE' });
      return { state: 'published', delivered: false }; },
  } };
  const writer = { async start(input) {
    if (failWriterStart) { failWriterStart = false; throw Object.assign(new Error('writer setup failed before session start'), { code: 'SAVED_ROLE_INVALID' }); }
    calls.writer.push(input); for (const waiter of [...writerWaiters]) if (calls.writer.length >= waiter.count) waiter.resolve();
    const gate = defer(); outcomes.set(input.reportId, gate);
    writerKind = `math-summary:${input.projectId}:${input.reportId}`;
    const state = { state: 'running', sessionId: 'writer-session', sessionPath: '/writer-session', agentId: 'writer-agent',
      cwd: '/fixture/report', kind: writerKind, sendState: 'accepted', sendPending: false, cleanupPending: true };
    await input.onBound({ sessionId: state.sessionId, sessionPath: state.sessionPath, agentId: state.agentId, cwd: state.cwd,
      kind: state.kind, sendState: state.sendState, sendPending: state.sendPending });
    calls.bound = (calls.bound ?? 0) + 1; for (const waiter of [...boundWaiters]) waiter.resolve();
    return { done: gate.promise, snapshot: () => structuredClone(state), async stop() {
      calls.stops++; Object.assign(state, { state: 'stopped', cleanupPending: options.cleanupPendingStop === true });
      if (!options.lateWriter && options.cleanupPendingStop !== true) gate.resolve({ ...state, modelStopReason: 'aborted', finalText: '' });
      return { ...state }; } };
  }, async dispose() { return { cleanupPending: false, errors: [] }; } };
  const track = (_p, promise) => { p.jobs.add(promise); promise.finally(() => p.jobs.delete(promise)).catch(() => {}); return promise; };
  let service;
  async function open() {
    service = await createProjectReportService({ sdk, store, summaryWriter: writer,
      authorizeCreator: async (_p, ctx) => { assert.equal(_p, p); if (ctx.sessionPath !== owner.sessionPath) throw Object.assign(new Error('denied'), { code: 'PROJECT_SUMMARY_DENIED' }); },
      projects: () => [p], getProject: id => { assert.equal(id, p.meta.projectId); return p; }, assertLive: () => {},
      async gatherFacts(projectId, authority) { calls.reads.push(projectId); await authority.guard(); authority.assertActive();
        if (options.gather) return options.gather({ asOf, attempt: calls.reads.length });
        return { facts: structuredClone(activeFacts), asOf }; },
      async withReportPublication(_id, authority, publish) { await authority.guard(); authority.assertActive();
        assert.ok(!Object.hasOwn(authority, 'callToken')); return publish({ facts: structuredClone(activeFacts), asOf }); },
      readInput: async () => ({ problem: 'Opaque original problem.\n' }), track, projectLocation: _p => `research/projects/${_p.meta.projectId}` });
  }
  await open();
  t.after(async () => { try { await service.dispose(); } finally { await fs.rm(dataDir, { recursive: true, force: true }); } });
  const args = { projectId: p.meta.projectId, language: 'English' };
  function dispatch(q) { const schedule = [...schedules.values()].find(row => row.payload.reportId === q.reportId);
    return handlers.get(schedule.handlerKey).run({ kind: 'schedule', scheduleId: schedule.scheduleId, input: schedule.payload }); }
  async function untilWriter(count = 1) {
    if (calls.writer.length >= count) return;
    await new Promise((resolve, reject) => {
      let waiter;
      const timer = setTimeout(() => { writerWaiters.splice(writerWaiters.indexOf(waiter), 1); reject(new Error(`writer ${count} did not start`)); }, 15000);
      waiter = { count, resolve: () => { clearTimeout(timer); writerWaiters.splice(writerWaiters.indexOf(waiter), 1); resolve(); } };
      writerWaiters.push(waiter);
    });
  }
  async function untilBound() {
    if (calls.bound >= calls.writer.length) return;
    await new Promise((resolve, reject) => {
      let waiter;
      const timer = setTimeout(() => { boundWaiters.splice(boundWaiters.indexOf(waiter), 1); reject(new Error('writer was not bound')); }, 15000);
      waiter = { resolve: () => { clearTimeout(timer); boundWaiters.splice(boundWaiters.indexOf(waiter), 1); resolve(); } };
      boundWaiters.push(waiter);
    });
  }
  function complete(id, text = '# Progress report\n\nA precise opaque result.\n') {
    outcomes.get(id).resolve({ state: 'completed', modelStopReason: 'stop', finalText: text, cleanupPending: false }); }
  return { p, sdk, store, calls, tasks, schedules, handlers, dispatches, args, open, dispatch, untilWriter, untilBound, complete,
    get service() { return service; }, start: () => service.start(p, args, owner),
    root: id => `research/projects/${p.meta.projectId}/reports/${id}`, setAsOf: value => { asOf = value; }, failStage: value => { failStage = value; },
    setHtmlStageFault: value => { htmlStageFault = value; },
    failSessionLookup: value => { sessionLookupFails = value === true ? 1 : value === false ? 0 : value; },
    setFacts: value => { activeFacts = structuredClone(value); }, setSettlementFailure: value => { options.settlementFailure = value; },
    setTaskStatus: (id, status) => { tasks.get(id).status = status; } };
}

test('schedule firing before its SDK receipt does not restore a stale schedule ID', async t => {
  const f = await fixture(t, { autoDispatch: true }), q = await f.start();
  assert.equal(q.state, 'queued'); await f.untilWriter(); f.complete(q.reportId); await f.dispatches[0];
  const state = await f.service.status(f.p, q, owner);
  assert.equal(state.state, 'completed'); assert.equal(state.cleanupPending, false);
});

const reportText = '# Progress report\r\n\r\nA precise result. 不透明结果。 $x^2$\r\n';
const names = calls => calls.stages.map(input => path.extname(input.name));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function savedMarkdown(f, result, text, ordinal) {
  const fileId = `report-file-${ordinal}`, stage = f.calls.stages[ordinal - 1];
  assert.ok(stage, 'expected Markdown staging at the original position');
  assert.equal(stage.name, 'math-progress-report.md');
  assert.equal(stage.mime, 'text/markdown');
  assert.equal(stage.deliverAs, 'attachment');
  assert.deepEqual(f.calls.staged.find(row => row.input === stage)?.bytes, Buffer.from(text));
  assert.equal(result.status, 'ok'); assert.equal(result.saved, true); assert.equal(result.state, 'completed');
  assert.equal(result.fileId, fileId); assert.equal(result.fullTextInFile, true);
  assert.deepEqual(result.resource, { kind: 'session-file', fileId, sessionId: creator.sessionId });
  assert.equal(result.report, text);
  assert.equal(result.sha256, sha(Buffer.from(text))); assert.equal(result.bytes, Buffer.byteLength(text));
}
function unavailableHtml(result, reason) {
  assert.equal(result.html?.status, 'not-staged');
  assert.match(result.html.reason, /^[A-Z][A-Z0-9_]{0,95}$/);
  assert.deepEqual(result.html, { status: 'not-staged', reason: reason ?? result.html.reason });
}
async function completeReport(f, text = reportText) {
  const q = await f.start(), run = f.dispatch(q);
  await f.untilWriter(); await f.untilBound();
  f.complete(q.reportId, text); await run;
  assert.equal((await f.service.status(f.p, q, owner)).state, 'completed');
  return q;
}
async function htmlFiles(f) {
  const entries = await fs.readdir(f.sdk.dataDir, { recursive: true, withFileTypes: true });
  return entries.filter(entry => entry.isFile() && /\.html$/i.test(entry.name))
    .map(entry => path.relative(f.sdk.dataDir, path.join(entry.parentPath, entry.name))).sort();
}

test('summary returns queued before writer; saved result delivers Markdown first and rendered HTML without model regeneration', async t => {
  const f = await fixture(t), q = await f.start();
  assert.equal(q.state, 'queued'); assert.equal(f.calls.writer.length, 0); assert.equal(f.calls.creates[0].delivery, 'next-step');
  const running = f.dispatch(q); await f.untilWriter(); await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
  assert.equal((await f.service.status(f.p, q, owner)).state, 'running');
  await f.untilBound(); f.complete(q.reportId, reportText); await running;
  const result = await f.service.result(f.p, q, owner);
  savedMarkdown(f, result, reportText, 1);
  assert.deepEqual(names(f.calls), ['.md', '.html']);
  const htmlStage = f.calls.staged[1], html = htmlStage.bytes.toString('utf8');
  assert.equal(htmlStage.input.mime, 'text/html');
  assert.equal(htmlStage.input.name, 'math-progress-report.html');
  assert.equal(htmlStage.input.deliverAs, 'attachment');
  assert.match(html, /<h1>Progress report<\/h1>/);
  assert.match(html, /<span class="katex">/);
  assert.match(html, /<msup>/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.deepEqual(result.html, { status: 'staged', resource: { kind: 'session-file', sessionId: creator.sessionId, fileId: 'report-file-2' },
    sha256: sha(htmlStage.bytes), bytes: htmlStage.bytes.length });
  const onDisk = await htmlFiles(f);
  assert.deepEqual(onDisk, [`${f.root(q.reportId)}/report.html`], 'one stable derived report file');
  assert.deepEqual(await f.store.read(`${f.root(q.reportId)}/report.md`), Buffer.from(reportText));
  assert.deepEqual(await f.store.read(`research/projects/${f.p.meta.projectId}/report/report.md`), Buffer.from(reportText));
  const again = await f.service.result(f.p, q, owner);
  savedMarkdown(f, again, reportText, 3);
  assert.deepEqual(names(f.calls), ['.md', '.html', '.md', '.html']);
  assert.deepEqual(again.html, { ...result.html, resource: { ...result.html.resource, fileId: 'report-file-4' } });
  assert.deepEqual(f.calls.staged[3].bytes, htmlStage.bytes);
  assert.deepEqual(await htmlFiles(f), onDisk, 'repeat retrieval must not accumulate derived files');
  assert.equal(f.calls.writer.length, 1); assert.equal(f.calls.creates.length, 1); assert.equal(f.calls.completes.length, 1);
});

test('remote and relative Markdown images deliver only the unchanged Markdown', async t => {
  for (const [kind, image] of [['remote', 'https://example.invalid/opaque.png'], ['relative', './opaque.png']]) await t.test(kind, async t => {
    const f = await fixture(t), text = `${reportText}\r\n![Opaque figure](${image})\r\n`;
    const q = await completeReport(f, text);
    const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('summary attempted to fetch an external asset'));
    const result = await f.service.result(f.p, q, owner);
    savedMarkdown(f, result, text, 1);
    unavailableHtml(result, 'SUMMARY_HTML_NOT_SELF_CONTAINED');
    assert.deepEqual(names(f.calls), ['.md']);
    assert.deepEqual(await htmlFiles(f), []);
    assert.deepEqual(await f.store.read(`${f.root(q.reportId)}/report.md`), Buffer.from(text));
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(f.calls.writer.length, 1);
  });
});

test('HTML stage refusal or wrong-session receipt does not discard Markdown, claim success or retry', async t => {
  for (const fault of ['throw', 'foreign']) await t.test(fault, async t => {
    const f = await fixture(t), q = await completeReport(f);
    f.setHtmlStageFault(fault);
    const result = await f.service.result(f.p, q, owner);
    savedMarkdown(f, result, reportText, 1);
    unavailableHtml(result, fault === 'throw' ? 'SUMMARY_HTML_STAGE_FAILED' : 'SUMMARY_HTML_STAGE_INVALID');
    assert.doesNotMatch(JSON.stringify(result), /foreign-receipt|fixture-only private stage refusal/);
    assert.deepEqual(names(f.calls), ['.md', '.html']);
    assert.equal(f.calls.writer.length, 1); assert.equal(f.calls.completes.length, 1);
  });
});

test('Markdown stage failure preserves the original delivery error and never attempts HTML staging', async t => {
  const f = await fixture(t), q = await completeReport(f);
  f.failStage(true);
  const result = await f.service.result(f.p, q, owner);
  assert.equal(result.saved, true); assert.equal(result.state, 'completed'); assert.equal(result.status, 'delivery-failed');
  assert.deepEqual(result.error, { code: 'PROJECT_REPORT_EXPORT_FAILED', cause: 'APP_CAPABILITY_DENIED' });
  assert.equal(result.fileId, undefined); assert.equal(result.resource, undefined);
  assert.notEqual(result.html?.status, 'staged');
  assert.deepEqual(names(f.calls), ['.md']);
  assert.deepEqual(await htmlFiles(f), []);
  assert.deepEqual(await f.store.read(`${f.root(q.reportId)}/report.md`), Buffer.from(reportText));
  assert.equal(f.calls.writer.length, 1);
});
test('archived flagged or nonzero findings do not gain HTML on re-read', async t => {
  for (const [label, flag] of [['flagged', { sourceStatus: 'flagged' }], ['nonzero findings', { leakFindings: ['fixture: retained finding'] }]]) await t.test(label, async t => {
    const f = await fixture(t), q = await completeReport(f);
    await f.service.dispose();
    const metadataPath = `${f.root(q.reportId)}/metadata.json`;
    const metadata = JSON.parse(await f.store.read(metadataPath));
    await f.store.write(metadataPath, `${JSON.stringify({ ...metadata, ...flag })}\n`, true);
    await f.open();
    const result = await f.service.result(f.p, q, owner);
    savedMarkdown(f, result, reportText, 1);
    unavailableHtml(result, 'SUMMARY_HTML_NOT_CLEAN');
    assert.deepEqual(names(f.calls), ['.md']);
    assert.deepEqual(await htmlFiles(f), []);
    assert.equal(f.calls.writer.length, 1);
  });
});

test('summary result preserves authorization, kind, missing record and invalid archive errors without staging', async t => {
  const f = await fixture(t), q = await completeReport(f);
  await assert.rejects(f.service.result(f.p, q, { ...owner, sessionPath: '/foreign' }), { code: 'PROJECT_SUMMARY_DENIED' });
  await assert.rejects(f.service.result(f.p, q, owner, { kind: 'paper-source' }), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
  await assert.rejects(f.service.result(f.p, { reportId: 'report-00000000-0000-4000-8000-000000000000' }, owner), { code: 'PROJECT_REPORT_NOT_FOUND' });
  await f.store.write(`${f.root(q.reportId)}/report.md`, 'Changed fixture bytes.\n', true);
  await assert.rejects(f.service.result(f.p, q, owner), { code: 'PROJECT_REPORT_ARTIFACT_INVALID' });
  assert.deepEqual(names(f.calls), []);
  assert.deepEqual(await htmlFiles(f), []);
  assert.equal(f.calls.writer.length, 1);
});

test('creator and exact task parent binding are checked before reads', async t => {
  const f = await fixture(t); await assert.rejects(f.service.start(f.p, f.args, { ...owner, sessionPath: '/foreign' }), { code: 'PROJECT_SUMMARY_DENIED' });
  assert.equal(f.calls.creates.length, 0); const q = await f.start();
  await assert.rejects(f.service.status(f.p, q, { ...owner, sessionPath: '/main' }), { code: 'PROJECT_SUMMARY_DENIED' });
  f.tasks.get(q.taskId).parentSessionId = 'foreign'; await f.dispatch(q);
  assert.equal(f.calls.reads.length, 0); assert.equal(f.calls.writer.length, 0);
  assert.equal((await f.service.status(f.p, q, owner)).state, 'failed');
  await assert.rejects(f.service.result(f.p, q, owner), { code: 'PROJECT_REPORT_NOT_READY' });
  assert.deepEqual(names(f.calls), []);
  assert.deepEqual(await htmlFiles(f), []);
});
test('new facts during writing preserve writer bytes and expose freshness only in metadata', async t => {
  const text = '# Progress report\r\n\r\nA precise opaque result. 不透明结果。\r\n', bytes = Buffer.from(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const f = await fixture(t), q = await f.start(), run = f.dispatch(q); await f.untilWriter();
  f.setFacts([fact('d'.repeat(16)), fact(B, [A], `Use fact_id ${A}.`), fact(A)]); f.setAsOf('2'.repeat(64)); f.complete(q.reportId, text); await run;
  const status = await f.service.status(f.p, q, owner); assert.equal(status.state, 'completed');
  assert.equal(status.asOf, '1'.repeat(64)); assert.ok(Number.isSafeInteger(status.snapshotCapturedAt));
  assert.equal(status.snapshotAdvancedDuringWriting, true);
  assert.deepEqual(await f.store.read(`${f.root(q.reportId)}/report.md`), bytes);
  assert.deepEqual(await f.store.read(`research/projects/${f.p.meta.projectId}/report/report.md`), bytes);
  const meta = JSON.parse(await f.store.read(`${f.root(q.reportId)}/metadata.json`));
  assert.equal(meta.publishedArtifact, meta.artifact); assert.equal(meta.artifact, `${f.root(q.reportId)}/report.md`);
  assert.equal(meta.publishedSha256, sha256); assert.equal(meta.sha256, sha256);
  assert.equal(meta.publishedBytes, bytes.length); assert.equal(meta.bytes, bytes.length);
  await assert.rejects(f.store.read(`${f.root(q.reportId)}/report.snapshot.md`), { code: 'ENOENT' });
  const delivery = await f.service.result(f.p, q, owner);
  assert.equal(delivery.status, 'ok'); assert.equal(delivery.report, text);
  assert.equal(f.calls.completes.length, 1);
  for (const result of [status, delivery, f.calls.completes[0]]) {
    assert.equal(result.sha256, sha256); assert.equal(result.bytes, bytes.length);
    assert.equal(result.asOf, status.asOf); assert.equal(result.snapshotCapturedAt, status.snapshotCapturedAt);
    assert.equal(result.snapshotAdvancedDuringWriting, true);
  }
});
test('leak is not staged, and later success preserves old failure artifact', async t => {
  const f = await fixture(t), q = await f.start(), run = f.dispatch(q); await f.untilWriter();
  f.complete(q.reportId, `A worker uses ${A}.`); await run;
  const leaky = await f.service.result(f.p, q, owner);
  assert.equal(leaky.status, 'leak'); assert.ok(leaky.leakFindings.length > 0);
  assert.equal(leaky.fileId, undefined); assert.equal(leaky.resource, undefined);
  assert.notEqual(leaky.html?.status, 'staged'); assert.equal(f.calls.stages.length, 0);
  assert.deepEqual(await htmlFiles(f), []);
  const q2 = await f.start(), run2 = f.dispatch(q2); await f.untilWriter(2); f.complete(q2.reportId); await run2;
  assert.equal((await f.service.result(f.p, q2, owner)).status, 'ok');
  assert.ok((await f.store.read(`${f.root(q.reportId)}/report.leaky.md`)).toString().endsWith(`A worker uses ${A}.`));
  assert.ok((await f.store.read(`${f.root(q2.reportId)}/previous-report.leaky.md`)).toString().endsWith(`A worker uses ${A}.`));
});
test('explicit stop prevents late output publication', async t => {
  const f = await fixture(t, { lateWriter: true }), q = await f.start(), run = f.dispatch(q); await f.untilWriter();
  assert.equal((await f.service.stop(f.p, q, owner)).state, 'stopped'); f.complete(q.reportId, '# Late report'); await run;
  assert.equal((await f.service.status(f.p, q, owner)).state, 'stopped');
  await assert.rejects(f.store.read(`${f.root(q.reportId)}/report.md`), { code: 'ENOENT' });
});
test('collection retries only one drift without starting writer on repeated drift', async t => {
  const f = await fixture(t, { gather: () => { throw Object.assign(new Error('drift'), { code: 'PROJECT_SUMMARY_GRAPH_CHANGED' }); } }), q = await f.start();
  await f.dispatch(q); assert.equal(f.calls.reads.length, 2); assert.equal(f.calls.writer.length, 0);
});
test('summary_stop retries uncertain writer cleanup and preserves interrupted state', async t => {
  const f = await fixture(t, { cleanupPendingStop: true }), q = await f.start();
  const run = f.dispatch(q); await f.untilWriter(); await f.untilBound();
  const stopped = await f.service.stop(f.p, q, owner);
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.cleanupPending, true);
  f.complete(q.reportId, '# Output after stop'); await run;
  f.failSessionLookup(2);
  await f.open();
  const uncertain = await f.service.status(f.p, q, owner);
  assert.equal(uncertain.state, 'interrupted'); assert.equal(uncertain.cleanupPending, true);
  const stillUncertain = await f.service.stop(f.p, q, owner);
  assert.equal(stillUncertain.state, 'interrupted'); assert.equal(stillUncertain.cleanupPending, true);
  const recovered = await f.service.stop(f.p, q, owner);
  assert.equal(recovered.state, 'interrupted'); assert.equal(recovered.cleanupPending, false);
  assert.equal((await f.start()).state, 'queued');
});

test('captured fact removal or body change preserves raw text but refuses publication', async t => {
  for (const change of ['removed', 'changed']) await t.test(change, async t => {
    const f = await fixture(t), q = await f.start(), run = f.dispatch(q); await f.untilWriter();
    f.setFacts(change === 'removed' ? [fact(C)] : [fact(B, [A], 'Changed canonical body.'), fact(A)]);
    f.setAsOf('3'.repeat(64)); f.complete(q.reportId); await run;
    const status = await f.service.status(f.p, q, owner);
    assert.equal(status.state, 'failed'); assert.equal(status.error, 'PROJECT_SUMMARY_FACT_REVOKED');
    assert.match((await f.store.read(`${f.root(q.reportId)}/report.md`)).toString(), /precise opaque/);
    await assert.rejects(f.store.read(`research/projects/${f.p.meta.projectId}/report/report.md`), { code: 'ENOENT' });
    assert.equal(f.calls.stages.length, 0);
  });
});

test('delivery lookup failure preserves confirmed settlement and completed result across restart', async t => {
  const f = await fixture(t, { deliveryError: true }), q = await f.start(), run = f.dispatch(q); await f.untilWriter();
  f.complete(q.reportId); await run;
  const before = await f.service.status(f.p, q, owner);
  assert.equal(before.state, 'completed'); assert.equal(before.taskSettlement, 'confirmed'); assert.equal(before.delivery.state, 'unknown');
  await f.open();
  const after = await f.service.status(f.p, q, owner);
  assert.equal(after.state, 'completed'); assert.equal(after.taskSettlement, 'confirmed');
  assert.equal((await f.service.result(f.p, q, owner)).status, 'ok'); assert.equal(f.calls.writer.length, 1);
});

test('writer setup failure before session binding releases project admission', async t => {
  const f = await fixture(t, { failWriterStart: true }), q = await f.start();
  const result = await f.dispatch(q);
  assert.equal(result.state, 'failed'); assert.equal(result.cleanupPending, false);
  assert.equal((await f.start()).state, 'queued');
});

test('clean completed and leaky reports retry settlement only on recovery', async t => {
  for (const state of ['completed', 'leak']) await t.test(state, async t => {
    const f = await fixture(t, { settlementFailure: true }), q = await f.start(), run = f.dispatch(q); await f.untilWriter();
    f.complete(q.reportId, state === 'leak' ? `A worker uses ${A}.` : undefined); await run;
    const before = await f.service.status(f.p, q, owner);
    assert.equal(before.state, state); assert.equal(before.cleanupPending, false); assert.equal(before.taskSettlement, 'unknown');
    await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
    const artifact = `${f.root(q.reportId)}/${state === 'leak' ? 'report.leaky.md' : 'report.md'}`;
    const original = await f.store.read(artifact), lookups = f.calls.sessionLookups;
    f.setSettlementFailure(false); await f.open();
    const after = await f.service.status(f.p, q, owner);
    assert.equal(after.state, state); assert.equal(after.taskSettlement, 'confirmed');
    assert.equal(f.calls.writer.length, 1); assert.equal(f.calls.stops, 0); assert.equal(f.calls.aborts, 0); assert.equal(f.calls.sessionLookups, lookups);
    assert.deepEqual(await f.store.read(artifact), original);
    assert.equal((await f.service.result(f.p, q, owner)).status, state === 'leak' ? 'leak' : 'ok');
    assert.equal((await f.start()).state, 'queued');
  });
});

test('unrecognized Host task status keeps settlement unknown and admission blocked', async t => {
  for (const taskStatus of ['paused', 'blocked', 'unexpected']) await t.test(taskStatus, async t => {
    const f = await fixture(t, { settlementFailure: true }), q = await f.start(), run = f.dispatch(q); await f.untilWriter();
    f.complete(q.reportId); await run; f.setSettlementFailure(false); f.setTaskStatus(q.taskId, taskStatus); await f.open();
    const status = await f.service.status(f.p, q, owner);
    assert.equal(status.state, 'completed'); assert.equal(status.taskSettlement, 'unknown');
    await assert.rejects(f.start(), error => error.code === 'PROJECT_SUMMARY_BUSY' && error.reportId === q.reportId);
    assert.equal(f.calls.writer.length, 1); assert.equal(f.calls.aborts, 0);
    f.setTaskStatus(q.taskId, 'completed'); await f.open();
    assert.equal((await f.service.status(f.p, q, owner)).taskSettlement, 'confirmed');
  });
});

test('stop retains admission uncertainty and cleans late task or schedule receipts', async t => {
  for (const phase of ['task', 'schedule']) await t.test(phase, async t => {
    const gate = defer(), entered = defer(), f = await fixture(t, { [`${phase}Gate`]: gate, entered });
    const starting = f.start(); const rejected = assert.rejects(starting, { code: 'PROJECT_SUMMARY_STOPPED' });
    await entered.promise;
    const reportId = f.calls.creates[0].metadata.reportId;
    const stopped = await f.service.stop(f.p, { reportId }, owner);
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.cleanupPending, true);
    await assert.rejects(f.start(), { code: 'PROJECT_SUMMARY_BUSY' });
    gate.resolve(); await rejected;
    const status = await f.service.status(f.p, { reportId }, owner);
    assert.equal(status.state, 'stopped'); assert.equal(status.cleanupPending, false); assert.equal(status.taskSettlement, 'confirmed');
    assert.equal(f.schedules.size, 0); assert.equal(f.calls.writer.length, 0);
    assert.equal((await f.start()).state, 'queued');
  });
});

test('dispose cleans a late schedule receipt without starting the writer', async t => {
  const scheduleGate = defer(), entered = defer(), f = await fixture(t, { scheduleGate, entered });
  const starting = f.start(); const rejected = assert.rejects(starting, { code: 'PROJECT_DISPOSED' });
  await entered.promise; const reportId = f.calls.creates[0].metadata.reportId;
  assert.equal((await f.service.dispose()).cleanupPending, true);
  scheduleGate.resolve(); await rejected;
  const status = await f.service.status(f.p, { reportId }, owner);
  assert.equal(status.state, 'stopped'); assert.equal(status.cleanupPending, false); assert.equal(status.taskSettlement, 'confirmed');
  assert.equal(f.schedules.size, 0); assert.equal(f.calls.writer.length, 0);
});

test('restart never replays queued report', async t => {
  const f = await fixture(t), q = await f.start(); await f.open();
  const result = await f.service.status(f.p, q, owner); assert.equal(result.state, 'interrupted'); assert.equal(f.calls.writer.length, 0);
  assert.equal(f.calls.creates.length, 1);
});
