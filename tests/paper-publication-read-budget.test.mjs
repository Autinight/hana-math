// Software only: actual Project/FIFO/CoreAccess/runtime/report via pairingFixture's FakeSDK.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pairingFixture } from './helpers/managed-ipc-pairing-fixture.mjs';
import { fixtureFactPage } from './fact-page-fixture.mjs';
import { defer, origin } from './helpers/project-service-fixture.mjs';
const options = { timeout: 90000 }, factId = 'a'.repeat(16), budget = 216;
const three = [{ title: 'Introduction', label: 'sec:intro', fact_ids: [] }, { title: 'Result', label: 'sec:result', fact_ids: [factId] }, { title: 'Acknowledgments', label: 'sec:ack', fact_ids: [] }];
const plannerOutput = `%%%PREAMBLE%%%\nPREAMBLE\n%%%FRONTMATTER%%%\nFRONT\n%%%SECTIONS%%%\n${JSON.stringify(three)}\n%%%BIBLIOGRAPHY%%%\nBIB\n`;
const emit = value => console.log('READ_BUDGET ' + JSON.stringify(value));
const getScope = (g, q) => ({ projectId: g.projectId, reportId: q.reportId });
const roles = m => Object.keys(m.artifacts ?? {});
const digest = b => createHash('sha256').update(b).digest('hex');
async function serial(t, bounded) {
  const g = await pairingFixture(t, { plannerOutput }), first = await g.counts();
  const reports = [], readTape = [], startedByOp = {}, closures = [], payloads = [];
  let consumed = 0, refusing = 0, previous, plan, activeId = null, previousMark = null;
  const planned = ['paper-plan', 'paper-section', 'paper-section', 'paper-section'];
  if (bounded) g.state.onGet = async () => { if (consumed === budget) {
    refusing++; throw Object.assign(new Error('Test-only remaining read budget exhausted'), { code: 'FIXTURE_READ_BUDGET_EXHAUSTED' });
  } consumed++; };
  g.f.sdk.resources = { async stage(input) { payloads.push(input.name); return { resource: { kind: 'session-file', fileId: 'fixture-' + payloads.length, sessionId: 'creator-stable' } }; } };
  g.state.onMeta = async m => {
    if (m.reportId !== activeId) return;
    const prior = previousMark;
    const mark = { at: g.reads.length, state: m.state, artifacts: roles(m) };
    const boundary = prior && (m.state === 'completed' && prior.state !== 'completed' || mark.artifacts.length > prior.artifacts.length);
    if (boundary) {
      const role = m.state === 'completed' ? 'completed' : mark.artifacts.at(-1);
      if (role !== 'response') closures.push({ kind: m.kind, role, reads: g.reads.slice(prior.at, mark.at).map(v => v.operation) });
    }
    previousMark = mark;
  };
  for (const [i, kind] of planned.entries()) {
    const before = await g.counts();
    const q = i === 0 ? await g.f.service.paperPlan(g.plan, origin) : await g.f.service.paperSection({ projectId: g.projectId, planReportId: plan.reportId, ...(previous ? { previousSectionReportId: previous.reportId } : {}) }, origin);
    if (i === 0) plan = q;
    activeId = q.reportId; previousMark = null;
    const atRunner = g.reads.length; await g.dispatch(q.reportId); const atReadout = g.reads.length;
    const m = await g.metadata(q.reportId), after = await g.counts();
    reports.push({ kind, state: m.state, error: m.error ?? null, artifacts: roles(m), reads: after.runtimeStarts - before.runtimeStarts,
      admissionReads: atRunner - before.runtimeStarts, runnerReads: after.runtimeStarts - atRunner, coreTasks: after.coreTasks - before.coreTasks, index: m.section?.material.sectionIndex ?? null });
    if (m.state !== 'completed') break;
    assert.equal(m.taskSettlement, 'confirmed'); assert.equal(m.cleanupPending, false);
    const scope = getScope(g, q), status = i ? await g.f.service.paperSectionStatus(scope, origin) : await g.f.service.paperPlanStatus(scope, origin);
    const result = i ? await g.f.service.paperSectionResult(scope, origin) : await g.f.service.paperPlanResult(scope, origin);
    assert.equal(status.publicationStatus, i ? 'reviewable-section' : 'reviewable-plan'); assert.equal(result.status, 'ok'); assert.equal(g.reads.length, atReadout);
    assert.deepEqual(roles(m), i ? ['response', 'source', 'provenance', 'ledger', 'section'] : ['response', 'blocks', 'plan', 'ledger']);
    for (const a of Object.values(m.artifacts)) assert.equal(digest(await fs.readFile(path.join(g.reports, q.reportId, a.name))), a.sha256);
    if (i) { assert.equal(status.sectionIndex, i - 1); assert.equal(status.sectionCount, 3); assert.equal(status.title, three[i - 1].title); assert.deepEqual(status.material.factIds, three[i - 1].fact_ids); previous = q; }
  }
  const after = await g.counts(), calls = g.reads.slice(first.runtimeStarts);
  for (const v of calls) { startedByOp[v.operation] = (startedByOp[v.operation] ?? 0) + 1; readTape.push(v.operation); }
  const observation = { name: bounded ? 'bounded' : 'unbounded', budget: bounded ? budget : null, consumed: bounded ? consumed : calls.length, refusedFixtureReads: refusing,
    actualCoreReads: calls.length, coreTasks: after.coreTasks - first.coreTasks, reportTasks: after.reportTasks - first.reportTasks, reports, reportCount: after.reportDirs.length - first.reportDirs.length,
    archiveCount: reports.reduce((n, p) => n + p.artifacts.length, 0), deliveredCount: payloads.length, writerCount: after.writers - first.writers, stopCount: after.stops - first.stops, startedByOp, closures };
  emit(observation);
  assert.equal(calls.length, observation.coreTasks); assert.deepEqual(calls.map(x => x.operation), readTape);
  assert.deepEqual(reports.map(x => x.state), Array(4).fill('completed'), 'same plan + three sections must finish');
  assert.equal(observation.archiveCount, 19); assert.equal(observation.deliveredCount, 12); assert.equal(observation.writerCount, 4); assert.equal(observation.stopCount, 0);
  assert.equal(observation.reportCount, 4); assert.equal(observation.reportTasks, 4); assert.equal(refusing, 0);
  const n = await g.f.service.paperSection({ projectId: g.projectId, planReportId: plan.reportId, previousSectionReportId: previous.reportId }, origin);
  assert.equal(n.status, 'no_next_section'); assert.deepEqual(await g.counts(), after);
  if (bounded) assert.ok(consumed <= budget);
  // For the first planner artifact the interval includes the deliberately retained raw recheck.
  assert.equal(closures.length, 19);
  for (const {kind, role, reads} of closures) {
    const one = ['fact_list_page', 'fact_get', 'fact_list_page'];
    assert.deepEqual(reads, kind === 'paper-plan' && role === 'blocks' ? [...one, ...one] : one, `${kind} ${role} needs one publication closure`);
  }
}
test('actual serial one-fact plan and three-section chain, with explicit Core/readout accounting', options, t => serial(t, false));
test('the same serial chain fits a finite fixture-only remaining-read budget', options, t => serial(t, true));

for (const [kind, mode, expected] of [
  ['section', 'withdrawn', 'RESEARCH_RUNTIME_REJECTED'], ['section', 'bad-parent', 'PROJECT_REPORT_ARTIFACT_INVALID'], ['section', 'denied', 'PERMISSION_DENIED'],
  ['plan', 'asOf-drift', 'PROJECT_SUMMARY_GRAPH_CHANGED'], ['section', 'asOf-drift', 'PROJECT_SUMMARY_GRAPH_CHANGED'],
]) test(`${kind} final publication refuses ${mode} without delivery, replay, or a new writer`, options, async t => {
  const g = await pairingFixture(t), plan = kind === 'section' ? await g.parent() : null;
  const q = plan ? await g.f.service.paperSection({ projectId: g.projectId, planReportId: plan.reportId }, origin) : await g.f.service.paperPlan(g.plan, origin);
  const reached = defer(), release = defer(), targetRole = plan ? 'section' : 'ledger'; let held;
  g.state.onMeta = async m => {
    if (held || m.reportId !== q.reportId || !m.artifacts?.[targetRole]) return;
    held = m; reached.resolve(); await release.promise;
  };
  const start = g.dispatch(q.reportId);
  try {
    await Promise.race([reached.promise, start.then(() => assert.fail('Missing last-artifact barrier'))]);
    assert.equal(held.state, 'running'); assert.ok(held.artifacts.response);
    const before = await g.counts(); let injected = 0, changed = false, sawFact = false;
    if (mode === 'withdrawn') g.state.facadeReply = async (req, result) => {
      if (req.operation === 'fact_list_page') return { ok: true, result: fixtureFactPage([], req.arguments, g.projectId) };
      assert.equal(req.operation, 'fact_get'); injected++;
      return { ok: false, error: { code: 'fact_not_found', message: 'Software fixture revoked the selected fact.' } };
    };
    if (mode === 'bad-parent') {
      const file = path.join(g.reports, plan.reportId, 'SECTION_PLAN.json'); const body = await fs.readFile(file); body[0] ^= 1; await fs.writeFile(file, body); injected++;
    }
    if (mode === 'denied') {
      const orig = g.f.sdk.tasks.get; let deny = false;
      g.state.onGet = async req => { if (req.operation === 'fact_get') sawFact = true; else if (sawFact) deny = true; };
      g.f.sdk.tasks.get = async id => {
        if (id === q.taskId && deny && injected === 0) { injected++; throw Object.assign(Error('Software fixture withheld report task read permission'), { code: 'PERMISSION_DENIED' }); }
        return orig(id);
      };
    }
    if (mode === 'asOf-drift') g.state.facadeReply = async (req, result) => {
      if (req.operation === 'fact_get') { changed = true; return { ok: true, result }; }
      if (changed) { injected++; return { ok: true, result: { ...result, page: { ...result.page, asOf: 'f'.repeat(64) } } }; }
      return { ok: true, result };
    };
    release.resolve(); await start;
    const meta = await g.metadata(q.reportId), after = await g.counts(), operations = g.reads.slice(before.runtimeStarts).map(r => r.operation);
    const read = plan ? g.f.service.paperSectionResult : g.f.service.paperPlanResult;
    const result = await read(getScope(g, q), origin);
    emit({ name: `${kind}-${mode}`, state: meta.state, error: meta.error, reads: operations, injected, rawPreserved: Boolean(meta.artifacts.response), addedWriters: after.writers - before.writers, ready: result.publicationStatus });
    assert.equal(meta.state, 'failed'); assert.equal(meta.error, expected); assert.equal(injected, 1);
    assert.deepEqual(meta.artifacts, held.artifacts); assert.equal(digest(await fs.readFile(path.join(g.reports, q.reportId, 'raw-response.txt'))), held.artifacts.response.sha256);
    assert.equal(result.publicationStatus, 'not-ready'); assert.equal(result.diagnosis.responseSaved, true); assert.deepEqual(result.files, []);
    assert.equal(after.writers, before.writers); assert.equal(after.stops, before.stops + 1); assert.equal(meta.taskSettlement, 'confirmed'); assert.equal(meta.cleanupPending, false);
    assert.deepEqual(operations, mode === 'bad-parent' ? [] : mode === 'withdrawn' ? ['fact_list_page', 'fact_get'] : ['fact_list_page', 'fact_get', 'fact_list_page']);
  } finally { release.resolve(); await start; }
});
