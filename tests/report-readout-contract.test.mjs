// Registered tool contract matrix; project DTOs here are MOCKS, not real report archives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reportReadoutTool } from './helpers/report-readout-tool-fixture.mjs';

const projectId = 'project-readout', reportId = 'report-01234567-89ab-cdef-0123-456789abcdef';
const context = { callToken: 'readout-mock-token', sessionPath: '/fixture/readout.jsonl' };
const identity = { projectId, reportId, taskId: 'task-readout' };
const fault = code => Object.assign(new Error(code), { code });
const groups = [
  ['summary', 'summary', null], ['paper', 'paper', 'paper-source'], ['paper_audit', 'paperAudit', 'reference-audit'],
  ['paper_verify', 'paperVerify', 'reference-verification'], ['paper_revision', 'paperRevision', 'paper-revision'],
  ['paper_plan', 'paperPlan', 'paper-plan'], ['paper_section', 'paperSection', 'paper-section'],
];
const terminal = [['failed', 'RESEARCH_RUNTIME_CAPACITY'], ['stopped', null], ['interrupted', 'PROJECT_REPORT_INTERRUPTED']];
const report = (kind, state, error, extra = {}) => ({ ...identity, ...(kind && { kind }), state, error, cleanupPending: state === 'interrupted',
  taskSettlement: state === 'interrupted' ? 'unknown' : 'confirmed', ...extra });
const diagnostic = (row, status = 'failed') => ({ ...row, saved: true, status, files: [], diagnosis: { responseSaved: true, error: row.error } });
async function read(t, action, method) {
  let current, calls = 0;
  const tool = await reportReadoutTool(t, { [method]: async (args, ctx) => {
    assert.deepEqual(args, { projectId, reportId }); assert.equal(ctx, context); calls++;
    if (current instanceof Error) throw current;
    return current;
  } });
  assert.match(tool.description, /^Manage projects/);
  return async row => {
    current = row; const before = calls;
    const reply = await tool.execute({ action, projectId, reportId, context });
    assert.equal(calls, before + 1, 'fixture did not reach the expected authorized adapter route');
    assert.deepEqual(JSON.parse(reply.content[0].text), reply.details);
    return reply;
  };
}
for (const [prefix, method, kind] of groups) for (const mode of ['status', 'result']) {
  const action = `${prefix}_${mode}`;
  test(`mock report readout ${action}: historical and current outcomes are distinct`, async t => {
    const call = await read(t, action, method + (mode === 'status' ? 'Status' : 'Result'));
    if (prefix === 'summary' && mode === 'result') {
      const rejected = await call(fault('PROJECT_REPORT_NOT_READY'));
      assert.equal(rejected.isError, true); assert.equal(rejected.details.error.code, 'PROJECT_REPORT_NOT_READY');
      const leak = { ...report(null, 'leak', null), saved: true, status: 'leak' };
      assert.deepEqual((await call(leak)).details, leak); assert.equal((await call(leak)).isError, false);
      return;
    }
    const outcomes = [];
    for (const extra of kind === 'paper-revision' ? [{ mode: 'citation' }, { mode: 'operator-notes' }] : [{}]) for (const [state, error] of terminal) {
      let row = report(kind, state, error, extra);
      if (kind === 'reference-verification' && mode === 'status') row.writer = { toolAvailabilityReadback: { status: 'unconfirmed', errors: [{ code: 'HOST_UNAVAILABLE' }] } };
      if (mode === 'result') row = diagnostic(row, prefix === 'paper' && state === 'failed' ? 'flagged' : 'failed');
      const out = await call(row);
      assert.deepEqual(out.details, row, 'public report DTO must not be rewritten');
      outcomes.push({ state, mode: extra.mode ?? null, isError: out.isError });
    }
    t.diagnostic(JSON.stringify(outcomes));
    assert.deepEqual(outcomes.filter(out => out.isError), [], 'historical report reads must not be tool errors');
  });
}

test('mock report readout: success flagged and operator-notes no-op do not change', async t => {
  const paper = await read(t, 'paper_result', 'paperResult'), revision = await read(t, 'paper_revision_result', 'paperRevisionResult');
  const flagged = { ...report('paper-source', 'completed', null), sourceStatus: 'flagged', saved: true, status: 'flagged', files: [] };
  const noOp = { ...report('paper-revision', 'completed', null, { mode: 'operator-notes' }), proposalProduced: false, saved: true, status: 'no_edits_applied', files: [], diagnosis: { responseSaved: true } };
  for (const [reply, row] of [[await paper(flagged), flagged], [await revision(noOp), noOp]]) { assert.equal(reply.isError, false); assert.deepEqual(reply.details, row); }
});

test('mock report readout: denied, wrong-kind, not-ready, not-found and ordinary error objects are not historical data', async t => {
  const call = await read(t, 'paper_section_status', 'paperSectionStatus');
  for (const code of ['PROJECT_CREATOR_REQUIRED', 'PROJECT_REPORT_KIND_MISMATCH', 'PROJECT_REPORT_NOT_READY', 'PROJECT_REPORT_NOT_FOUND']) {
    const out = await call(fault(code)); assert.equal(out.isError, true); assert.equal(out.details.error.code, code);
  }
  const failed = report('paper-section', 'failed', 'REPORT_FAILURE');
  const cases = [{ error: { code: 'BACKEND_ERROR' } }, { ...failed, error: { code: 'BACKEND_ERROR' } },
    ...[{ ok: false }, { success: false }, { failed: true }, { indeterminate: true }, { write_error: 'WRITE_FAILED' }, { status: 'invalid' }, { verdict: 'error' }].map(a => ({ ...failed, ...a }))];
  for (const row of cases) { const out = await call(row); assert.equal(out.isError, true); assert.deepEqual(out.details, row); }
});

test('mock report readout: foreign identity or malformed lifecycle is never a readable historical DTO', async t => {
  const call = await read(t, 'paper_plan_status', 'paperPlanStatus');
  const row = report('paper-plan', 'stopped', null);
  const bad = [{ projectId: 'project-other' }, { reportId: 'report-other' }, { kind: 'paper-section' }, { kind: null },
    { taskId: 1 }, { taskSettlement: 'guessed' }, { cleanupPending: 'false' }];
  const actual = [];
  for (const change of bad) actual.push({ change, isError: (await call({ ...row, ...change })).isError });
  t.diagnostic(JSON.stringify(actual)); assert.ok(actual.every(x => x.isError));
});

test('mock report readout: result exemption needs a saved diagnostic and empty files', async t => {
  const call = await read(t, 'paper_section_result', 'paperSectionResult'), row = diagnostic(report('paper-section', 'failed', 'REPORT_FAILURE'));
  for (const change of [{ saved: false }, { diagnosis: null }, { diagnosis: { error: 'OTHER_ERROR' } }, { files: [{ fileId: 'contradiction' }] }, { status: 'ok' }]) {
    assert.equal((await call({ ...row, ...change })).isError, true, JSON.stringify(change));
  }
});

test('mock report readout: strict response JSON validation runs before report classification', async t => {
  const call = await read(t, 'paper_plan_status', 'paperPlanStatus'), row = report('paper-plan', 'failed', 'REPORT_FAILURE');
  let getterCalls = 0;
  const accessor = Object.defineProperty({ ...row }, 'hidden', { enumerable: true, get() { getterCalls++; return 'must not read'; } });
  const cyclic = { ...row }; cyclic.self = cyclic;
  for (const invalid of [null, 5, [], { ...row, nested: undefined }, { ...row, nested: new Array(1) }, { ...row, nested: Infinity }, cyclic, accessor]) {
    const out = await call(invalid); assert.equal(out.isError, true); assert.equal(typeof out.details.error.code, 'string');
    assert.equal(out.details.reportId, undefined);
  }
  assert.equal(getterCalls, 0);
});

test('mock report stop and ordinary project actions retain their existing error classification', async t => {
  const section = report('paper-section', 'stopped', 'PROJECT_REPORT_STOPPED');
  for (const [prefix, method, kind] of groups) {
    const stop = await read(t, `${prefix}_stop`, `${method}Stop`);
    const row = { ...section, ...(kind ? { kind } : {}) }; if (!kind) delete row.kind;
    const out = await stop(row); assert.equal(out.isError, true); assert.deepEqual(out.details, row);
  }
  const failed = { projectId, state: 'failed', error: 'FIXTURE_FAILURE' };
  const tool = await reportReadoutTool(t, { status: async () => failed, doctor: async () => failed, result: async () => failed, start: async () => failed });
  for (const [action, isError, args] of [['status', false, {}], ['doctor', false, {}], ['result', true, {}], ['start', true, {}]]) {
    const out = await tool.execute({ action, projectId, ...args, context }); assert.equal(out.isError, isError, action); assert.deepEqual(out.details, failed, action);
  }
});
