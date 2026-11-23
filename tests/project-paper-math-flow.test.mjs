// The public tool, Project, Report, artifact store and schedule handler are
// real. Host calls, canonical fact replies and writer/model output are fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { createProjectService } from '../packages/hana-math/project-service.mjs';
import { defer, fixture, origin } from './helpers/project-service-fixture.mjs';

const kind = 'paper-math-verification', handler = 'math-project-report';
const factId = 'a'.repeat(16), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const title = 'Synthetic frozen manuscript';
const sourceText = `\\documentclass{article}\n\\begin{document}\n\\section{${title}}\\label{sec:synthetic}\nA synthetic assertion.\n\\end{document}\n%%%PROVENANCE%%%\n${JSON.stringify({ 'sec:synthetic': factId })}`;
const finding = { location: 'A synthetic assertion.', issue: 'A hypothesis is missing.', class: 'must-fix' };
const reviewText = { findings: [finding], report: 'The argument needs the missing hypothesis.' };

async function setup(t) {
  const writers = [], stages = [];
  let mathOutput = JSON.stringify(reviewText), wrongOwner = false, coreForbidden = false;
  const fact = { fact_id: factId, predecessors: [], markdown: `---\nfact_id: ${factId}\npredecessors: []\nexternal_refs: []\n---\n## statement\nOpaque fixture.\n## proof\nOpaque fixture proof.\n` };
  const f = await fixture(t, { multiWorker: true,
    coreCall(_binding, op, args) {
      assert.equal(coreForbidden, false, `unexpected Core call after freezing source: ${op}`);
      if (op === 'fact_list_page') return { facts: [fact] };
      assert.equal(op, 'fact_get'); assert.equal(args.fact_id, factId);
      return structuredClone(fact);
    }, summaryWriter: { async start(input) {
      assert.ok(['paper-source', kind].includes(input.kind), 'only the isolated paper writers may run');
      writers.push(input);
      const math = input.kind === kind;
      const agentId = `${math ? 'paper-math-verifier' : 'math-paper-writer'}-01234567-89ab-cdef-0123-456789abcdef`;
      const sessionId = `writer-${writers.length}`, sessionPath = `/fixture/${sessionId}.jsonl`;
      // The dedicated math verifier is an Agent kind; its transport role is report-writer.
      const binding = { role: 'report-writer', agentId, sessionId, sessionPath,
        kind: `${math ? 'math-paper-math-verification' : 'math-paper-source'}:${input.projectId}:${input.reportId}`, cwd: input.cwd,
        sendState: 'not-sent', sendPending: false, model: null, toolSelection: null };
      f.host.set(sessionPath, { ...binding, path: sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', lifecycle: 'active' });
      if (!f.agents.some(row => row.id === agentId)) f.agents.push({ id: agentId, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private',
        plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: math ? 'paper-math-verifier' : 'math-report-writer' } });
      await input.onBound(binding);
      const terminal = { ...binding, sendState: 'accepted', state: 'completed', modelStopReason: 'stop', cleanupPending: false,
        finalText: math ? mathOutput : sourceText };
      return { done: Promise.resolve(terminal), stop: async () => terminal };
    } },
  });
  f.sdk.resources = { async stage(input) {
    const bytes = await fs.readFile(input.path); stages.push({ ...input, bytes });
    return { resource: { kind: 'session-file', fileId: `fixture-file-${stages.length}`, sessionId: wrongOwner ? 'foreign' : 'creator-stable' } };
  } };
  const p = await f.create(), projectId = p.projectId;
  const tools = new Map();
  f.sdk.tools = { async register(tool) { tools.set(tool.name, tool); return () => {}; } };
  const unused = async () => assert.fail('unexpected legacy Research call');
  const legacyResearch = Object.fromEntries(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection'].map(name => [name, unused]));
  const registration = await registerMathResearch(f.sdk, legacyResearch, f.service);
  t.after(() => registration.dispose());
  const call = (action, args = {}, ctx = origin) => tools.get('math_project').execute({ action, projectId, ...args, context: ctx });
  const good = async (...args) => {
    const reply = await call(...args);
    assert.equal(reply.isError, false, JSON.stringify(reply.details));
    return reply.details;
  };
  const queued = (action, reportId) => good(action, { reportId });
  const dispatch = q => {
    const scheduled = [...f.schedules.values()].find(row => row.handlerKey === handler && row.payload.reportId === q.reportId);
    assert.ok(scheduled, 'registered schedule for the selected child');
    return f.handlers.get(handler).run({ kind: 'schedule', scheduleId: scheduled.scheduleId, input: scheduled.payload });
  };
  const reportFile = (q, name) => path.join(f.dataDir, 'research', 'projects', projectId, 'reports', q.reportId, name);
  await good('finalize', { factIds: [factId] });
  const source = await good('paper', { brief: 'Use the synthetic frozen manuscript.' });
  assert.equal(source.state, 'queued');
  await dispatch(source);
  const parentStatus = await queued('paper_status', source.reportId);
  assert.equal(parentStatus.kind, 'paper-source');
  assert.equal(parentStatus.sourceStatus, 'generated');
  const parentFiles = ['main.tex', 'REFERENCE_LEDGER.md', 'metadata.json'];
  const readParent = () => Promise.all(parentFiles.map(name => fs.readFile(reportFile(source, name))));
  const original = await readParent();
  assert.ok(original[0].includes(title));
  coreForbidden = true;
  return { f, p, writers, stages, source, original, readParent, reportFile, dispatch, call, good, queued,
    setMathOutput(value) { mathOutput = value; }, setWrongOwner(value) { wrongOwner = value; } };
}

test('public math review uses the exact archived source, reports a wrong verdict and stages just the review', { timeout: 25000 }, async t => {
  const g = await setup(t), { source, writers, stages, f, original } = g;
  const core = f.calls.core.length, factories = f.calls.factories.length, parent = { reportId: source.reportId };
  const foreign = await g.call('paper_verify_math', parent, g.p.context);
  assert.equal(foreign.details.error.code, 'PROJECT_SUMMARY_DENIED');
  const queued = await g.good('paper_verify_math', parent);
  assert.equal(queued.state, 'queued'); assert.notEqual(queued.reportId, source.reportId);
  assert.equal(writers.length, 1, 'a queue receipt is not a model launch');
  assert.deepEqual(stages, []);
  await g.dispatch(queued);
  const status = await g.queued('paper_verify_math_status', queued.reportId);
  assert.equal(status.kind, kind); assert.equal(status.state, 'completed'); assert.equal(status.mathVerdict, 'wrong');
  assert.equal(status.sourceReportId, source.reportId);
  assert.equal(status.mainSha256, sha(original[0])); assert.equal(status.ledgerSha256, sha(original[1]));
  assert.deepEqual(writers.map(row => row.kind), ['paper-source', kind]);
  const prompt = writers[1].prompt, envelope = JSON.parse(prompt.trimEnd().split('\n').at(-1));
  assert.equal(envelope.mainTex, original[0].toString('utf8')); assert.equal(envelope.ledger, original[1].toString('utf8'));
  assert.equal(status.promptSha256, sha(prompt));
  const result = await g.queued('paper_verify_math_result', queued.reportId);
  assert.equal(result.mathVerdict, 'wrong', 'a valid negative mathematical opinion is a successful report');
  assert.equal(stages.length, 1);
  const staged = stages[0], review = JSON.parse(staged.bytes);
  assert.deepEqual(result.files, [{ role: 'review', name: 'MATH_REVIEW.json', bytes: staged.bytes.length, sha256: sha(staged.bytes),
    resource: { kind: 'session-file', fileId: 'fixture-file-1', sessionId: 'creator-stable' } }]);
  assert.equal(staged.name, 'MATH_REVIEW.json'); assert.equal(staged.mime, 'application/json'); assert.equal(staged.deliverAs, 'attachment');
  assert.equal(staged.path, g.reportFile(queued, 'MATH_REVIEW.json'));
  assert.equal(review.projectId, g.p.projectId); assert.equal(review.reportId, queued.reportId);
  assert.equal(review.binding.sourceReportId, source.reportId);
  assert.equal(review.binding.mainSha256, sha(original[0])); assert.equal(review.binding.ledgerSha256, sha(original[1]));
  assert.deepEqual(review.findings, reviewText.findings); assert.equal(review.report, reviewText.report); assert.equal(review.verdict, 'wrong');
  assert.doesNotMatch(JSON.stringify(result), /REFERENCE_LEDGER\.md|raw-response\.txt|main\.tex|The argument needs the missing hypothesis/);
  const wrongKind = await g.call('paper_result', { reportId: queued.reportId });
  assert.equal(wrongKind.details.error.code, 'PROJECT_REPORT_KIND_MISMATCH'); assert.equal(stages.length, 1);
  g.setWrongOwner(true);
  const failedDelivery = await g.call('paper_verify_math_result', { reportId: queued.reportId });
  assert.equal(failedDelivery.isError, true); assert.equal(failedDelivery.details.status, 'delivery-failed');
  assert.equal(failedDelivery.details.readError.code, 'PROJECT_REPORT_EXPORT_FAILED');
  assert.ok(failedDelivery.details.files.every(file => !file.resource));
  assert.equal((await g.queued('paper_verify_math_status', queued.reportId)).state, 'completed');
  assert.deepEqual(await g.readParent(), original);
  assert.equal(f.calls.core.length, core); assert.equal(f.calls.factories.length, factories);
});

test('invalid model output is a saved execution failure, not a review verdict or delivery failure', { timeout: 25000 }, async t => {
  const g = await setup(t), core = g.f.calls.core.length;
  // A caller/model cannot supply the derived verdict, even in otherwise valid JSON.
  g.setMathOutput(JSON.stringify({ ...reviewText, verdict: 'correct' }));
  const queued = await g.queued('paper_verify_math', g.source.reportId);
  await g.dispatch(queued);
  const status = await g.queued('paper_verify_math_status', queued.reportId);
  assert.equal(status.state, 'failed'); assert.equal(status.error, 'PROJECT_PAPER_MATH_OUTPUT_INVALID');
  assert.equal(Object.hasOwn(status, 'mathVerdict'), false);
  const result = await g.queued('paper_verify_math_result', queued.reportId);
  assert.equal(result.status, 'failed'); assert.equal(result.saved, true);
  assert.deepEqual(result.files, []); assert.equal(result.diagnosis.responseSaved, true);
  assert.deepEqual(g.stages, []);
  assert.deepEqual(await g.readParent(), g.original);
  assert.equal(g.f.calls.core.length, core);
});

async function reopenDeferred(t, f) {
  const service = await createProjectService(f.sdk, { contexts: f.contexts, profiles: f.profiles, research: f.research,
    createCore() { assert.fail('deferred report reads must not call Core'); }, literature: { search() { assert.fail('unexpected search'); } }, deferHistoricalWork: true });
  t.after(() => service.dispose());
  return service;
}

const noVerdict = value => {
  assert.equal(Object.hasOwn(value, 'mathVerdict'), false);
  assert.equal(Object.hasOwn(value, 'verdict'), false);
  assert.equal(value.paperMathGate, 'not-assessed');
};

for (const hostStatus of ['completed', 'canceled', 'failed', 'aborted']) test(`math settlement joins stop and distinguishes Host ${hostStatus}`, { timeout: 25000 }, async t => {
  const g = await setup(t), { f } = g;
  const q = await g.queued('paper_verify_math', g.source.reportId), args = { reportId: q.reportId };
  const entered = defer(), release = defer(), complete = f.sdk.tasks.complete;
  let calls = 0;
  f.sdk.tasks.complete = async (id, result) => {
    if (id !== q.taskId) return complete(id, result);
    calls++; entered.resolve(result);
    await release.promise;
    if (hostStatus === 'completed') return complete(id, result);
    const row = f.tasks.get(id); row.status = hostStatus; return structuredClone(row);
  };
  const running = g.dispatch(q);
  let stop;
  try {
    const payload = await Promise.race([entered.promise, running.then(row => assert.fail(`no Host settlement: ${JSON.stringify(row)}`))]);
    assert.doesNotMatch(JSON.stringify(payload), /verdict|paperMathGate/i);
    const pending = await g.queued('paper_verify_math_status', q.reportId);
    assert.equal(pending.state, 'completed'); assert.equal(pending.taskSettlement, 'pending'); noVerdict(pending);
    const blocked = await g.call('paper_verify_math_result', args);
    assert.equal(blocked.isError, true); assert.deepEqual(g.stages, []);
    // Exercise the actual Host task handler's abort callback, which shares
    // stopInternal with creator stop and service disposal.
    stop = f.handlers.get(handler).abort(q.taskId);
    const observer = await g.queued('paper_verify_math_status', q.reportId);
    assert.equal(observer.stopRequested, false); noVerdict(observer);
  } finally { release.resolve(); }
  const [handled, stopped] = await Promise.all([running, stop]);
  const status = await g.queued('paper_verify_math_status', q.reportId);
  assert.equal(calls, 1);
  for (const value of [handled, stopped, status]) {
    assert.equal(value.taskSettlement, 'confirmed');
    assert.equal(value.mathTaskStatus, hostStatus);
    if (hostStatus === 'completed') {
      assert.equal(value.state, 'completed'); assert.equal(value.stopRequested, false);
      assert.equal(value.mathVerdict, 'wrong'); assert.equal(value.paperMathGate, 'failed');
    } else {
      assert.equal(value.state, hostStatus === 'failed' ? 'failed' : 'stopped');
      assert.equal(value.error, `PROJECT_REPORT_TASK_${hostStatus.toUpperCase()}`);
      noVerdict(value);
    }
  }
  const result = await g.queued('paper_verify_math_result', q.reportId);
  if (hostStatus === 'completed') assert.equal(result.files[0].name, 'MATH_REVIEW.json');
  else { assert.deepEqual(result.files, []); assert.deepEqual(g.stages, []); noVerdict(result); }
});

test('dispose joins a terminal math settlement and the next service can claim the review', { timeout: 25000 }, async t => {
  const g = await setup(t), { f } = g;
  const q = await g.queued('paper_verify_math', g.source.reportId);
  const entered = defer(), release = defer(), complete = f.sdk.tasks.complete;
  let calls = 0;
  f.sdk.tasks.complete = async (id, result) => {
    if (id === q.taskId) { calls++; entered.resolve(); await release.promise; }
    return complete(id, result);
  };
  const running = g.dispatch(q);
  let shutdown;
  try {
    await Promise.race([entered.promise, running.then(row => assert.fail(`no settlement to join: ${JSON.stringify(row)}`))]);
    shutdown = f.service.dispose();
    const early = await Promise.race([shutdown, delay(25, 'held')]);
    assert.equal(early, 'held');
    const pending = JSON.parse(await fs.readFile(g.reportFile(q, 'metadata.json')));
    assert.equal(pending.stopRequested, false); assert.equal(pending.taskSettlement, 'pending');
  } finally { release.resolve(); await Promise.allSettled([running, shutdown]); }
  assert.equal((await running).mathVerdict, 'wrong');
  assert.equal((await shutdown).summaryWriterCleanupPending, false);
  assert.equal(calls, 1);
  const reopened = await reopenDeferred(t, f), args = { projectId: g.p.projectId, reportId: q.reportId };
  const status = await reopened.paperVerifyMathStatus(args, origin);
  assert.equal(status.state, 'completed'); assert.equal(status.mathTaskStatus, 'completed'); assert.equal(status.stopRequested, false);
  assert.equal((await reopened.paperVerifyMathResult(args, origin)).files[0].name, 'MATH_REVIEW.json');
});

for (const phase of ['producer', 'settlement']) test(`math ${phase} save failure clears verdict and deferred reload can read the failed record`, { timeout: 25000 }, async t => {
  const g = await setup(t), { f } = g;
  const q = await g.queued('paper_verify_math', g.source.reportId), reportFile = g.reportFile(q, 'metadata.json');
  const rename = fs.rename, entered = defer(), release = defer();
  let injected = false;
  fs.rename = async (from, to) => {
    if (!injected && to === reportFile) {
      const m = JSON.parse(await fs.readFile(from));
      if (m.state === 'completed' && (m.taskSettlement === 'confirmed') === (phase === 'settlement')) {
        injected = true; entered.resolve(m); await release.promise;
        throw Object.assign(new Error('synthetic metadata rename failure'), { code: 'EIO' });
      }
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  const running = g.dispatch(q);
  const checkDeadline = new AbortController();
  let attempt;
  try {
    const write = await Promise.race([entered.promise, running.then(row => assert.fail(`no targeted write: ${JSON.stringify(row)}`))]);
    assert.equal(write.mathVerdict, 'wrong');
    const pending = await g.queued('paper_verify_math_status', q.reportId);
    assert.notEqual(pending.taskSettlement, 'confirmed'); noVerdict(pending);
    attempt = g.call('paper_verify_math_result', { reportId: q.reportId });
    const withheld = await Promise.race([attempt, delay(2000, undefined, { signal: checkDeadline.signal })]);
    assert.ok(withheld?.isError, 'result must refuse without waiting on the held metadata write');
    assert.deepEqual(g.stages, [], 'a held metadata write is not authority to stage');
  } finally {
    checkDeadline.abort(); fs.rename = rename; syncBuiltinESMExports(); release.resolve();
    await Promise.allSettled([running, attempt]);
  }
  const handled = await running;
  assert.equal(handled.state, 'failed'); assert.equal(handled.cleanupPending, true); noVerdict(handled);
  const saved = JSON.parse(await fs.readFile(reportFile));
  assert.equal(saved.state, 'failed'); assert.equal(saved.cleanupPending, true);
  assert.equal(Object.hasOwn(saved, 'mathVerdict'), false); assert.equal(saved.completedAt, null);
  assert.equal(f.tasks.get(q.taskId).status, phase === 'settlement' ? 'completed' : 'failed');
  assert.equal((await g.call('paper_verify_math_result', { reportId: q.reportId })).isError, true);
  await f.service.dispose();
  const reopened = await reopenDeferred(t, f);
  const args = { projectId: g.p.projectId, reportId: q.reportId };
  const status = await reopened.paperVerifyMathStatus(args, origin);
  assert.equal(status.state, 'failed'); assert.equal(status.cleanupPending, true); noVerdict(status);
  const result = await reopened.paperVerifyMathResult(args, origin);
  assert.deepEqual(result.files, []); noVerdict(result);
  assert.deepEqual(g.stages, []);
});
