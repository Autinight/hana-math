import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';

const PROJECT = 'project-fixture';
const REPORT = 'report-01234567-89ab-cdef-0123-456789abcdef';
const PLAN = 'report-11234567-89ab-cdef-0123-456789abcdef';
const SECTION = 'report-21234567-89ab-cdef-0123-456789abcdef';
const CHILD = 'report-31234567-89ab-cdef-0123-456789abcdef';
const MATH = 'paper-math-verification';
const mathMethods = { paper_verify_math: 'paperVerifyMath', paper_verify_math_status: 'paperVerifyMathStatus',
  paper_verify_math_result: 'paperVerifyMathResult', paper_verify_math_stop: 'paperVerifyMathStop' };
const context = { sessionPath: '/fixture/creator.jsonl', callToken: 'host-fixture-token', messageId: null, messageText: null };
const methods = { paper: 'paper', paper_status: 'paperStatus', paper_result: 'paperResult', paper_stop: 'paperStop' };
const planMethods = { paper_plan: 'paperPlan', paper_plan_status: 'paperPlanStatus', paper_plan_result: 'paperPlanResult', paper_plan_stop: 'paperPlanStop' };
const auditMethods = { paper_audit: 'paperAudit', paper_audit_status: 'paperAuditStatus', paper_audit_result: 'paperAuditResult', paper_audit_stop: 'paperAuditStop' };
const revisionMethods = { paper_revise: 'paperRevise', paper_revision_status: 'paperRevisionStatus', paper_revision_result: 'paperRevisionResult', paper_revision_stop: 'paperRevisionStop' };
const verifyMethods = { paper_verify: 'paperVerify', paper_verify_status: 'paperVerifyStatus', paper_verify_result: 'paperVerifyResult', paper_verify_stop: 'paperVerifyStop' };
const inputs = {
  paper: { projectId: PROJECT, brief: 'Software writing fixture only.' },
  paper_status: { projectId: PROJECT, reportId: REPORT },
  paper_result: { projectId: PROJECT, reportId: REPORT },
  paper_stop: { projectId: PROJECT, reportId: REPORT },
};
async function fixture(t) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-paper-tools-')));
  const tools = new Map(), calls = [], controls = {};
  let registration;
  t.after(async () => { await registration?.dispose(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const unexpected = async () => { assert.fail('Unexpected legacy service, result, finalize or staging call'); };
  const service = Object.fromEntries(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection'].map(name => [name, unexpected]));
  const projects = Object.fromEntries(['create', 'list', 'status', 'assign', 'start', 'stop', 'result', 'invoke', 'handles', 'goal', 'mainGoal', 'finalize'].map(name => [name, unexpected]));
  for (const method of [...Object.values(methods), ...Object.values(planMethods), ...Object.values(auditMethods), ...Object.values(verifyMethods), ...Object.values(revisionMethods), ...Object.values(mathMethods), 'summary', 'paperSubgraph']) projects[method] = async (...args) => {
    assert.equal(args.length, 2);
    calls.push({ method, args: args[0], context: args[1] });
    if (controls.error) throw controls.error;
    return controls.reply ?? { projectId: PROJECT, reportId: REPORT, state: 'queued' };
  };
  registration = await registerMathResearch({ dataDir,
    tools: { async register(tool) { tools.set(tool.name, tool); return () => {}; } },
    resources: { stage: input => (controls.stage ?? unexpected)(input) },
  }, service, projects);
  const tool = tools.get('math_project');
  return { tool, tools, projects, calls, controls, execute: input => tool.execute({ ...input, context }) };
}

// Evaluate the JSON Schema keywords used by these flat action variants without
// adding a validator dependency. Runtime validation is exercised separately.
function accepts(schema, input) {
  if (schema.type && (schema.type === 'array' ? !Array.isArray(input) : typeof input !== schema.type)) return false;
  if (Array.isArray(input)) {
    if (schema.minItems !== undefined && input.length < schema.minItems || schema.maxItems !== undefined && input.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(input.map(item => JSON.stringify(item))).size !== input.length) return false;
    if (schema.items && !input.every(item => accepts(schema.items, item))) return false;
  }
  if (Object.hasOwn(schema, 'const') && input !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(input)) return false;
  if (typeof input === 'string') {
    if (schema.minLength && [...input].length < schema.minLength) return false;
    if (schema.maxLength && [...input].length > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(input)) return false;
  }
  if (schema.properties) {
    if (schema.required.some(key => !Object.hasOwn(input, key))) return false;
    if (Object.entries(input).some(([key, value]) => schema.properties[key] ? !accepts(schema.properties[key], value) : schema.additionalProperties === false)) return false;
  }
  return !schema.oneOf || schema.oneOf.filter(variant => accepts(variant, input)).length === 1;
}

test('M05 integration public plan schemas and dispatch preserve creator context and exact request fields', async t => {
  const f = await fixture(t), schema = f.tool.parameters;
  for (const [action, method] of Object.entries(planMethods)) {
    const base = action === 'paper_plan' ? { projectId: PROJECT, brief: 'Opaque plan', factIds: [] } : { projectId: PROJECT, reportId: REPORT };
    const variants = schema.oneOf.filter(v => v.properties.action.const === action); assert.equal(variants.length, 1); assert.equal(variants[0].additionalProperties, false);
    assert.deepEqual(variants[0].required, action === 'paper_plan' ? ['action', 'projectId', 'brief'] : ['action', 'projectId', 'reportId']);
    assert.equal(accepts(schema, { action, ...base }), true); const result = await f.execute({ action, ...base }); assert.equal(result.isError, false);
    assert.deepEqual(f.calls.at(-1), { method, args: base, context });
    const count = f.calls.length;
    for (const extra of [{ kind: 'summary' }, { language: 'English' }, { target: {} }, { material: {} }, { taskId: 'spoof' }, { model: {} }]) assert.equal((await f.execute({ action, ...base, ...extra })).isError, true);
    assert.equal(f.calls.length, count);
  }
  for (const brief of ['', ' \r\n', '\0', '\ud800', '界'.repeat(10923)]) assert.equal((await f.execute({ action: 'paper_plan', projectId: PROJECT, brief })).isError, true);
  let reads = 0; const input = { action: 'paper_plan', projectId: PROJECT, context };
  Object.defineProperty(input, 'brief', { enumerable: true, get() { reads++; return 'bad'; } }); assert.equal((await f.tool.execute(input)).isError, true); assert.equal(reads, 0);
  for (const text of [/phase-1 linear section-plan preview/, /not section ordering/, /not claims about Host hard limits/, /not raw-response.txt/]) assert.match(f.tool.description, text);
});

test('whole-paper math actions use exact, mutually exclusive selectors and preserve Host context', async t => {
  const f = await fixture(t), schema = f.tool.parameters;
  const start = { action: 'paper_verify_math', projectId: PROJECT };
  const source = { ...start, reportId: REPORT }, stitched = { ...start, planReportId: PLAN, finalSectionReportId: SECTION };
  const childRead = action => ({ action, projectId: PROJECT, reportId: CHILD });
  assert.equal(schema.oneOf.filter(v => v.properties.action.const === start.action).length, 2);
  f.controls.reply = { projectId: PROJECT, kind: MATH, reportId: CHILD, state: 'queued' };
  for (const input of [source, stitched, ...Object.keys(mathMethods).slice(1).map(childRead)]) {
    const { action, ...args } = input;
    assert.ok(accepts(schema, input), JSON.stringify(input));
    assert.equal((await f.execute(input)).isError, false);
    assert.deepEqual(f.calls.at(-1), { method: mathMethods[action], args, context });
    assert.equal(f.calls.at(-1).context, context);
  }
  const before = f.calls.length;
  for (const input of [start, { ...source, ...stitched }, { ...start, planReportId: PLAN }, { ...start, finalSectionReportId: SECTION },
    { ...source, planReportId: PLAN }, { ...source, finalSectionReportId: SECTION }, { ...source, sourceReportId: REPORT },
    { ...source, reportId: '../outside' }, { ...stitched, planReportId: REPORT.toUpperCase() }, { ...stitched, finalSectionReportId: null },
    { ...source, path: '/private/foreign' }, { ...source, text: 'user text' }, { ...source, ledger: {} },
    { ...source, factIds: ['a'.repeat(16)] }, { ...source, verificationReportId: REPORT }, { ...source, language: 'English' },
    ...Object.keys(mathMethods).slice(1).flatMap(action => [{ ...stitched, action }, { ...childRead(action), ledger: 'spoof' }])]) {
    assert.equal(accepts(schema, input), false, JSON.stringify(input));
    const response = await f.execute(input);
    assert.equal(response.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  }
  let accessed = false;
  const raw = { ...stitched, context };
  Object.defineProperty(raw, 'finalSectionReportId', { enumerable: true, get() { accessed = true; return SECTION; } });
  assert.equal((await f.tool.execute(raw)).isError, true);
  assert.equal(accessed, false);
  assert.equal(f.calls.length, before);
  assert.match(f.tool.description, /MATH_REVIEW\.json/);
});

test('whole-paper math reads distinguish saved failure from delivery failure and reject foreign receipts', async t => {
  const f = await fixture(t);
  const historical = { projectId: PROJECT, reportId: CHILD, kind: MATH, state: 'failed', error: 'REVIEW_FAILED',
    taskId: 'report-task', taskSettlement: 'confirmed', cleanupPending: false };
  f.controls.reply = historical;
  const run = action => f.execute({ action, projectId: PROJECT, reportId: CHILD });
  assert.equal((await run('paper_verify_math_status')).isError, false);
  f.controls.reply = { ...historical, status: 'failed', saved: true, files: [], diagnosis: { responseSaved: true, error: historical.error } };
  assert.equal((await run('paper_verify_math_result')).isError, false);
  f.controls.reply = { ...f.controls.reply, status: 'delivery-failed', readError: { code: 'PROJECT_REPORT_EXPORT_FAILED' } };
  assert.equal((await run('paper_verify_math_result')).isError, true);
  for (const patch of [{ kind: 'reference-verification' }, { projectId: 'project-foreign' }, { reportId: REPORT }]) {
    f.controls.reply = { ...historical, ...patch, secret: 'do not disclose' };
    const result = await run('paper_verify_math_status');
    assert.equal(result.details.error.code, 'RESEARCH_RESULT_INVALID');
    assert.doesNotMatch(result.content[0].text, /do not disclose/);
  }
  f.controls.reply = { ...historical, reportId: REPORT, state: 'queued', error: null };
  assert.equal((await f.execute({ action: 'paper_verify_math', projectId: PROJECT, reportId: REPORT })).details.error.code, 'RESEARCH_RESULT_INVALID');
});

test('public stitch still stages only main.tex and never projects internal ledger', async t => {
  const f = await fixture(t), bytes = Buffer.from('synthetic frozen TeX'), staged = [];
  let checked = 0, foreign = false;
  f.projects.paperStitch = async () => ({ bytes, ledger: Buffer.from('internal-ledger'), sessionId: 'creator-stable',
    summary: { projectId: PROJECT, planReportId: PLAN, finalSectionReportId: SECTION, sectionCount: 1, ledger: 'private-summary-ledger' },
    async checkDelivery() { checked++; } });
  f.controls.stage = async input => {
    assert.deepEqual(await fs.readFile(input.path), bytes); staged.push(input);
    return { resource: { kind: 'session-file', fileId: 'artifact', sessionId: foreign ? 'foreign' : 'creator-stable' } };
  };
  const request = { action: 'paper_stitch', projectId: PROJECT, planReportId: PLAN, finalSectionReportId: SECTION };
  const response = await f.execute(request);
  assert.equal(response.isError, false);
  assert.deepEqual(staged.map(({ name, mime, deliverAs }) => ({ name, mime, deliverAs })),
    [{ name: 'main.tex', mime: 'text/x-tex', deliverAs: 'attachment' }]);
  assert.equal(checked, 1);
  assert.doesNotMatch(response.content[0].text, /ledger|internal|private-summary/);
  foreign = true;
  const refused = await f.execute(request);
  assert.equal(refused.details.error.code, 'PROJECT_PAPER_STITCH_EXPORT_FAILED');
  assert.equal(Object.hasOwn(refused.details, 'resource'), false);
});

test('operator-notes public schema and runtime keep mutually exclusive citation and direct-notes variants', async t => {
  const f = await fixture(t), schema = f.tool.parameters;
  const base = { action: 'paper_revise', projectId: PROJECT, reportId: REPORT };
  assert.equal(schema.oneOf.filter(v => v.properties.action.const === 'paper_revise').length, 2);
  for (const input of [base, { ...base, mode: 'citation' }, { ...base, mode: 'operator-notes', notes: '  Opaque 编辑🙂\r\n ' },
    { ...base, mode: 'operator-notes', notes: '界'.repeat(10922) + 'ab' }]) {
    assert.equal(accepts(schema, input), true); assert.equal((await f.execute(input)).isError, false);
    const { action, ...args } = input; assert.deepEqual(f.calls.at(-1), { method: 'paperRevise', args, context });
  }
  const count = f.calls.length;
  for (const input of [{ ...base, mode: 'operator-notes' }, { ...base, mode: 'style', notes: 'x' }, { ...base, notes: 'x' },
    { ...base, mode: 'citation', notes: '' }, { ...base, mode: 'citation', notes: null }, { ...base, mode: null },
    { ...base, mode: 'operator-notes', notes: 'x', verificationReportId: REPORT },
    { ...base, mode: 'operator-notes', notes: 'x', sourceReportId: REPORT }]) {
    assert.equal(accepts(schema, input), false); assert.equal((await f.execute(input)).isError, true);
  }
  for (const notes of ['', ' \r\n', null, '\0', '\ud800', 'x'.repeat(32769), '界'.repeat(10923)]) {
    const reply = await f.execute({ ...base, mode: 'operator-notes', notes });
    assert.equal(reply.isError, true); assert.equal(reply.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  }
  let reads = 0;
  for (const key of ['notes', 'mode', 'reportId']) {
    const raw = { ...base, mode: 'operator-notes', notes: 'x', context };
    Object.defineProperty(raw, key, { enumerable: true, get() { reads++; return 'x'; } });
    assert.equal((await f.tool.execute(raw)).isError, true);
  }
  assert.equal(reads, 0); assert.equal(f.calls.length, count);
  assert.match(f.tool.description, /not mechanically established/); assert.match(f.tool.description, /requests no citation verification/);
});

test('paper extends only math_project with strict action schemas and explicit source limitations', async t => {
  const f = await fixture(t), schema = f.tool.parameters;
  // The full action list and tool registry are pinned once in research-tools.test.mjs.
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties, 'context'), false);
  for (const action of Object.keys(inputs)) {
    const variants = schema.oneOf.filter(v => v.properties.action.const === action);
    assert.equal(variants.length, 1);
    assert.equal(variants[0].additionalProperties, false);
    assert.deepEqual(variants[0].required, action === 'paper' ? ['action', 'projectId', 'brief'] : ['action', 'projectId', 'reportId']);
  }
  for (const key of ['brief', 'instructions']) {
    assert.equal(schema.properties[key].maxLength, 32768);
    assert.equal(schema.properties[key].type, 'string');
  }
  // Invalid paper inputs are exercised through runtime dispatch below; only the disclosure contract is pinned here.
  assert.match(f.tool.description, /citations, mathematics and compilation remain unverified/);
  assert.match(f.tool.description, /citations remain unverified/i);
});

test('offline paper audit actions have strict creator dispatch schemas and preserve Host context', async t => {
  const f = await fixture(t), schema = f.tool.parameters;
  for (const [action, method] of [...Object.entries(auditMethods), ...Object.entries(verifyMethods), ...Object.entries(revisionMethods)]) {
    const args = { projectId: PROJECT, reportId: REPORT };
    const variant = schema.oneOf.find(item => item.properties.action.const === action);
    assert.ok(variant); assert.equal(variant.additionalProperties, false);
    assert.deepEqual(variant.required, ['action', 'projectId', 'reportId']);
    assert.equal(accepts(schema, { action, ...args }), true);
    for (const invalid of [{ action, ...args, unknown: true }, { action, ...args, brief: 'extra' },
      { action, projectId: PROJECT, reportId: '../foreign' }, { action, projectId: PROJECT }]) {
      assert.equal(accepts(schema, invalid), false);
    }
    const reply = await f.execute({ action, ...args });
    assert.equal(reply.isError, false);
    assert.deepEqual(f.calls.at(-1), { method, args, context });
  }
});

test('revision proposal disclosures do not certify inherited provenance or revised mathematics', async t => {
  const f = await fixture(t);
  assert.match(f.tool.description, /paper_revise is creator-only/);
  assert.match(f.tool.description, /never publishes a canonical paper/);
  assert.match(f.tool.description, /not revalidated/);
  assert.match(f.tool.description, /mathematics is unreviewed and compilation not-run/);
  assert.ok(f.tool.description.startsWith('Manage projects'));
  assert.ok(f.tool.description.indexOf('paper_verify is creator-only') < f.tool.description.indexOf('paper_revise is creator-only'));
  assert.match(f.tool.description, /archive-only.*all mapping labels remain unresolved.*none are reusable/);
  assert.match(f.tool.description, /nonexpanding citation scan is syntactic-only literal-key membership in all inherited ledger sections/);
  assert.match(f.tool.description, /clean scan certifies neither source identity nor mathematical use/);
  assert.match(f.tool.description, /only in new REVISION_PROPOSAL.json artifacts/);
  for (const action of Object.keys(revisionMethods)) {
    assert.equal((await f.execute({ action, projectId: PROJECT, reportId: REPORT, paperId: 'spoof' })).isError, true);
  }
  assert.equal(f.calls.length, 0);
});

test('online verification disclosures remain separate from source, compilation and whole-paper review', async t => {
  const f = await fixture(t);
  assert.match(f.tool.description, /paper_verify is creator-only/);
  assert.match(f.tool.description, /never changes main.tex/);
  assert.match(f.tool.description, /partial or unverified/);
  for (const action of Object.keys(verifyMethods)) {
    assert.equal((await f.execute({ action, projectId: PROJECT, reportId: REPORT, sessionId: 'spoof' })).isError, true);
    assert.equal((await f.execute({ action, projectId: PROJECT, reportId: REPORT, paperId: 'spoof' })).isError, true);
  }
  assert.equal(f.calls.length, 0);
});

test('creator paper dispatch preserves host context and forwards exactly supplied fields without staging or finalizing', async t => {
  const f = await fixture(t);
  for (const [action, base] of Object.entries(inputs)) {
    const options = action === 'paper' ? [base, { ...base, paperId: 'draft-1', instructions: '' }, { ...base, instructions: 'Preserve fixture text.\n' }] : [base];
    for (const args of options) {
      const before = f.calls.length, reply = await f.execute({ action, ...args });
      assert.equal(reply.isError, false);
      assert.equal(f.calls.length, before + 1);
      assert.deepEqual(f.calls.at(-1), { method: methods[action], args, context });
      assert.equal(f.calls.at(-1).context, context);
      assert.equal(Object.hasOwn(f.calls.at(-1).args, 'action'), false);
    }
  }
  const reply = await f.execute({ action: 'summary', projectId: PROJECT });
  assert.equal(reply.isError, false);
  assert.deepEqual(f.calls.at(-1), { method: 'summary', args: { projectId: PROJECT }, context });
});

test('paper validation rejects missing, malformed, oversized and leaking arguments before dispatch', async t => {
  const f = await fixture(t);
  const invalid = [];
  for (const [action, base] of Object.entries(inputs)) {
    for (const key of ['projectId', action === 'paper' ? 'brief' : 'reportId']) {
      const input = { action, ...base }; delete input[key]; invalid.push(input);
    }
    for (const extra of [{ unknown: true }, { language: 'English' }, { factIds: action === 'paper' ? ['a'.repeat(16), 'a'.repeat(16)] : ['a'.repeat(16)] }, { callToken: 'spoof' }, { force: true }, { cursor: 'fixture' }]) invalid.push({ action, ...base, ...extra });
    invalid.push({ action, ...base, projectId: '../outside' });
    if (action !== 'paper') {
      for (const extra of [{ brief: 'leak' }, { instructions: '' }, { paperId: 'main' }]) invalid.push({ action, ...base, ...extra });
      for (const reportId of ['report-fixture', REPORT.toUpperCase(), null, 1]) invalid.push({ action, ...base, reportId });
    }
  }
  for (const brief of ['', ' \n\t', null, 1, '\0', '\ud800', '\udfff', 'x'.repeat(32769), '界'.repeat(10923)]) invalid.push({ action: 'paper', projectId: PROJECT, brief });
  for (const instructions of [null, false, '\0', '\ud800', 'x'.repeat(32769), '界'.repeat(10923)]) invalid.push({ action: 'paper', ...inputs.paper, instructions });
  for (const paperId of ['', '../main', 'Main', 'a'.repeat(65), null]) invalid.push({ action: 'paper', ...inputs.paper, paperId });
  for (const input of invalid) {
    const reply = await f.execute(input);
    assert.equal(reply.isError, true, JSON.stringify(input).slice(0, 160));
    assert.equal(reply.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  }
  assert.equal(f.calls.length, 0);
});

test('paper_subgraph schema and runtime accept only project/paper identity and preserve the genuine Host context', async t => {
  const f = await fixture(t), schema = f.tool.parameters, variant = schema.oneOf.find(v => v.properties.action.const === 'paper_subgraph');
  assert.ok(variant); assert.deepEqual(variant.required, ['action', 'projectId']); assert.equal(variant.additionalProperties, false);
  for (const args of [{ projectId: PROJECT }, { projectId: PROJECT, paperId: 'main' }]) {
    assert.equal(accepts(schema, { action: 'paper_subgraph', ...args }), true);
    assert.equal((await f.execute({ action: 'paper_subgraph', ...args })).isError, false);
    assert.deepEqual(f.calls.at(-1), { method: 'paperSubgraph', args, context }); assert.equal(f.calls.at(-1).context, context);
  }
  const count = f.calls.length;
  for (const extra of [{ brief: 'no' }, { selection: ['a'.repeat(16)] }, { supportFactIds: ['a'.repeat(16)] }, { factIds: ['a'.repeat(16)] },
    { force: true }, { callToken: 'spoof' }, { requiredActor: 'creator' }, { guard: true }, { reportId: REPORT }]) {
    const input = { action: 'paper_subgraph', projectId: PROJECT, ...extra };
    assert.equal(accepts(schema, input), false); assert.equal((await f.execute(input)).isError, true);
  }
  assert.equal((await f.execute({ action: 'paper_subgraph' })).isError, true); assert.equal(f.calls.length, count);
  assert.match(f.tool.description, /Creator only: paper_subgraph/); assert.match(f.tool.description, /Core runtime\/task\/audit bookkeeping may occur/);
  assert.match(f.tool.description, /no writer\/session\/report\/TeX/); assert.equal(f.tool.autoAllow, undefined);
  delete f.projects.paperSubgraph;
  const reply = await f.execute({ action: 'paper_subgraph', projectId: PROJECT }); assert.equal(reply.isError, true); assert.equal(reply.details.error.code, 'PROJECT_PAPER_UNAVAILABLE');
});

test('paper selection schema/runtime accept empty or 1..64 IDs but never material or subgraph/finalize empty overrides', async t => {
  const f = await fixture(t), schema = f.tool.parameters;
  for (const factIds of [[], ['a'.repeat(16)], Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(16, '0'))]) {
    const input = { action: 'paper', projectId: PROJECT, brief: 'Brief', factIds };
    assert.equal(accepts(schema, input), true); assert.equal((await f.execute(input)).isError, false);
    assert.deepEqual(f.calls.at(-1).args, { projectId: PROJECT, brief: 'Brief', factIds }); assert.equal(f.calls.at(-1).context, context);
  }
  const count = f.calls.length;
  for (const factIds of [null, ['bad'], ['a'.repeat(16), 'a'.repeat(16)], Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(16, '0'))]) {
    const input = { action: 'paper', projectId: PROJECT, brief: 'Brief', factIds };
    assert.equal(accepts(schema, input), false); assert.equal((await f.execute(input)).isError, true);
  }
  for (const input of [{ action: 'paper', projectId: PROJECT, brief: 'Brief', material: {} },
    { action: 'finalize', projectId: PROJECT, factIds: [] }, { action: 'paper_subgraph', projectId: PROJECT, factIds: [] }]) {
    assert.equal(accepts(schema, input), false); assert.equal((await f.execute(input)).isError, true);
  }
  assert.equal(f.calls.length, count);
});

test('paper UTF-8 limits accept exact boundaries and preserve original text', async t => {
  const f = await fixture(t);
  for (const text of ['x'.repeat(32768), '界'.repeat(10922) + 'ab']) {
    assert.equal(Buffer.byteLength(text), 32768);
    const args = { ...inputs.paper, brief: text, instructions: text };
    assert.equal((await f.execute({ action: 'paper', ...args })).isError, false);
    assert.deepEqual(f.calls.at(-1).args, args);
  }
});

test('paper service errors and failure values are retained with no result fallback', async t => {
  const f = await fixture(t);
  for (const [action, args] of Object.entries(inputs)) {
    for (const code of ['PROJECT_OWNER_DENIED', 'PROJECT_TARGET_NOT_FINALIZED', 'PAPER_WRITER_FAILED']) {
      f.controls.error = Object.assign(new Error('Fixture failure'), { code });
      const before = f.calls.length, reply = await f.execute({ action, ...args });
      assert.equal(reply.isError, true);
      assert.equal(reply.details.error.code, code);
      assert.equal(f.calls.length, before + 1);
      assert.equal(f.calls.at(-1).method, methods[action]);
    }
    f.controls.error = null;
    f.controls.reply = { error: { code: 'PAPER_SOURCE_CHANGED' }, saved: false };
    const reply = await f.execute({ action, ...args });
    assert.equal(reply.isError, true);
    assert.deepEqual(reply.details, f.controls.reply);
  }
  delete f.projects.paper;
  const before = f.calls.length, reply = await f.execute({ action: 'paper', ...inputs.paper });
  assert.equal(reply.isError, true);
  assert.equal(reply.details.error.code, 'PROJECT_PAPER_UNAVAILABLE');
  assert.equal(f.calls.length, before);
});
