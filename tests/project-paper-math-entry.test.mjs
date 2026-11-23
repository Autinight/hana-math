import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

const kind = 'paper-math-verification';
const source = 'report-01234567-89ab-cdef-0123-456789abcdef';
const plan = 'report-11234567-89ab-cdef-0123-456789abcdef';
const section = 'report-21234567-89ab-cdef-0123-456789abcdef';
const child = 'report-31234567-89ab-cdef-0123-456789abcdef';
const missing = 'report-41234567-89ab-cdef-0123-456789abcdef';
const observation = new WeakMap(), key = Symbol.for('hana-math.report-entry-test');
const fail = code => Object.assign(new Error(code), { code });
// Keep Project, context storage and Host authorization real. Replace only
// the Report dependency at the adapter boundary in this isolated test process.
globalThis[key] = async ({ sdk, authorizeCreator }) => {
  const calls = [], state = { calls, childProject: null, result: null };
  observation.set(sdk, state);
  const op = name => async (p, args, ctx, options) => {
    await authorizeCreator(p, ctx);
    calls.push({ name, projectId: p.meta.projectId, args, ctx, options });
    if (args.reportId === source || args.reportId === plan) throw fail('PROJECT_REPORT_KIND_MISMATCH');
    if (args.reportId !== child || p.meta.projectId !== state.childProject) throw fail('PROJECT_REPORT_NOT_FOUND');
    return name === 'result' ? state.result : { projectId: p.meta.projectId, reportId: child, kind, state: 'queued' };
  };
  return {
    async start(p, args, ctx) {
      calls.push({ name: 'start', projectId: p.meta.projectId, args, ctx });
      state.childProject = p.meta.projectId;
      return { projectId: state.childProject, reportId: child, kind, state: 'queued' };
    },
    status: op('status'), result: op('result'), stop: op('stop'),
    async stitch(p, args, authorize, guard) {
      await authorize(); guard();
      return { bytes: Buffer.from('manuscript'), ledger: 'private-ledger', sessionId: p.meta.creator.sessionId,
        summary: { projectId: p.meta.projectId, ...args }, checkDelivery: authorize };
    },
    dashboardShutdownIdle: () => true,
    async dispose() { return { cleanupPending: false }; },
  };
};
const project = new URL('../packages/hana-math/project-service.mjs', import.meta.url);
const stub = `export const createProjectReportService = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})];`;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === project.href && specifier === './project-report-service.mjs')
    return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
  return next(specifier, context);
} });
const { fixture, origin } = await import('./helpers/project-service-fixture.mjs').finally(() => {
  hook.deregister(); delete globalThis[key];
});

const activity = ({ tasks, schedules, starts, sends, factories, core, literature }) => ({
  tasks: tasks.length, schedules: schedules.length, starts: starts.length, sends: sends.length,
  factories: factories.length, core: core.length, literature: literature.length,
});

test('Project authorizes the original creator before forwarding only the selected frozen manuscript', async t => {
  const f = await fixture(t), p = await f.create(), { projectId } = p;
  const before = activity(f.calls), calls = observation.get(f.sdk).calls;
  const start = (args, ctx = origin) => f.service.paperVerifyMath({ projectId, ...args }, ctx);
  await assert.rejects(start({ reportId: source }, p.context), { code: 'PROJECT_SUMMARY_DENIED' });
  await assert.rejects(start({ reportId: source }, { ...origin, sessionPath: '/fixture/foreign.jsonl' }), { code: 'PROJECT_OWNER_DENIED' });
  for (const args of [{}, { reportId: source, planReportId: plan, finalSectionReportId: section },
    { planReportId: plan }, { finalSectionReportId: section }, { reportId: '../outside' }, { reportId: source, ledger: {} },
    { planReportId: plan, finalSectionReportId: section, path: '/forbidden' }, { reportId: source, text: 'caller text' }]) {
    await assert.rejects(start(args), { code: 'PROJECT_INVALID_INPUT' });
  }
  let called = false;
  const raw = { projectId };
  Object.defineProperty(raw, 'reportId', { enumerable: true, get() { called = true; return source; } });
  await assert.rejects(f.service.paperVerifyMath(raw, origin), { code: 'PROJECT_INVALID_INPUT' });
  assert.equal(called, false);
  assert.deepEqual(calls, []);
  assert.equal((await start({ reportId: source })).reportId, child);
  assert.equal((await start({ planReportId: plan, finalSectionReportId: section })).reportId, child);
  assert.deepEqual(calls, [{ name: 'start', projectId, args: { kind, language: 'English', math: { sourceReportId: source } }, ctx: origin },
    { name: 'start', projectId, args: { kind, language: 'English', math: { planReportId: plan, finalSectionReportId: section } }, ctx: origin }]);
  assert.equal(calls[0].ctx, origin);
  assert.deepEqual(activity(f.calls), before, 'adapter starts no Core, fact checks, research, writer, or extra Host tasks');
  const stitch = await f.service.paperStitch({ projectId, planReportId: plan, finalSectionReportId: section }, origin);
  assert.deepEqual(Object.keys(stitch).sort(), ['bytes', 'checkDelivery', 'sessionId', 'summary']);
  assert.doesNotMatch(JSON.stringify(stitch.summary), /ledger/);
});

test('Project child operations pin kind/project and expose only a creator-owned review attachment', async t => {
  const f = await fixture(t), p = await f.create(), other = await f.create(), { projectId } = p;
  const state = observation.get(f.sdk);
  await f.service.paperVerifyMath({ projectId, reportId: source }, origin);
  const args = { projectId, reportId: child };
  const result = { ...args, kind, state: 'completed', status: 'ok', saved: true };
  const review = { role: 'review', name: 'MATH_REVIEW.json', bytes: 24, sha256: 'a'.repeat(64),
    resource: { kind: 'session-file', fileId: 'private-review', sessionId: 'creator-stable' } };
  state.result = { ...result, files: [review] };
  for (const [suffix, name] of [['Status', 'status'], ['Result', 'result'], ['Stop', 'stop']]) {
    const call = (input = args, ctx = origin) => f.service['paperVerifyMath' + suffix](input, ctx);
    assert.equal((await call()).reportId, child);
    assert.deepEqual(state.calls.at(-1), { name, projectId, args, ctx: origin, options: { kind } });
    await assert.rejects(call(args, p.context), { code: 'PROJECT_SUMMARY_DENIED' });
    await assert.rejects(call({ projectId: other.projectId, reportId: child }), { code: 'PROJECT_REPORT_NOT_FOUND' });
    await assert.rejects(call({ projectId, reportId: missing }), { code: 'PROJECT_REPORT_NOT_FOUND' });
    await assert.rejects(call({ projectId, reportId: source }), { code: 'PROJECT_REPORT_KIND_MISMATCH' });
    await assert.rejects(call({ ...args, finalSectionReportId: section }), { code: 'PROJECT_INVALID_INPUT' });
  }
  const read = () => f.service.paperVerifyMathResult(args, origin);
  assert.deepEqual(await read(), state.result);
  for (const files of [[], [review, { ...review, role: 'response', name: 'raw-response.txt' }],
    [{ ...review, role: 'ledger' }], [{ ...review, name: 'PROVENANCE_LEDGER.json' }]]) {
    state.result = { ...result, files };
    await assert.rejects(read(), { code: 'PROJECT_REPORT_ARTIFACT_INVALID' });
  }
  state.result = { ...result, files: [{ ...review, resource: { ...review.resource, sessionId: 'foreign' } }] };
  await assert.rejects(read(), { code: 'PROJECT_REPORT_STAGE_INVALID' });
  state.result = { ...result, projectId: other.projectId, files: [review] };
  await assert.rejects(read(), { code: 'PROJECT_REPORT_ARTIFACT_INVALID' });
  state.result = { ...result, files: [{ role: 'review', name: 'MATH_REVIEW.json', error: 'PROJECT_REPORT_STAGE_INVALID' }],
    status: 'delivery-failed', readError: { code: 'PROJECT_REPORT_EXPORT_FAILED', phase: 'delivery' } };
  assert.deepEqual(await read(), state.result);
  assert.deepEqual(f.calls.core, []);
});
