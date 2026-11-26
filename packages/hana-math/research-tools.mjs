import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { createContextStore } from './context-service.mjs';
import { runtimeDiagnostics, runtimeRejectionInfo } from './runtime/research-runtime.mjs';
import { normalizeResearchWorkerPolicy, MAX_TIMER_SECONDS } from './worker-policy.mjs';
import { factPageOptions, validateFactPage } from './fact-page.mjs';
import { normalizeWorkerDispatch, WORKER_DISPLAY_TITLE_GUIDANCE } from './worker-selection.mjs';
import { snapshotPaperRevisionRequest } from './paper-revision-input.mjs';
import { snapshotPaperDeliveryRequest } from './paper-delivery.mjs';
import { snapshotChapterTreeRequest } from './paper-chapter-tree.mjs';
import { snapshotPaperPlanRequest } from './paper-plan-input.mjs';
import { snapshotPaperSectionRequest, snapshotPaperStitchRequest } from './paper-section-input.mjs';
import { operatorFields, updateOperatorAnswers } from './operator-interview.mjs';

const TEXT = 256 * 1024, SMALL = 4096, TOTAL = 1024 * 1024, ITEMS = 128;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/, FID = /^[a-f0-9]{16}$/;
const KINDS = ['conclusion', 'example', 'counterexample', 'proof_attempt', 'plan', 'dead_end', 'direction', 'obstacle', 'master_guidance', 'verification', 'elaboration'];
const VERIFIED_DEFAULTS = new Set(KINDS.slice(0, 4));
const plain = (v) => v !== null && typeof v === 'object' && !isProxy(v) && !Array.isArray(v) && [null, Object.prototype].includes(Object.getPrototypeOf(v));
const error = (code) => Object.assign(new Error(code), { code });
function check(ok, code = 'RESEARCH_TOOL_INVALID_INPUT') { if (!ok) throw error(code); }
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safeCode = (cause) => typeof cause?.code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(cause.code) ? cause.code : 'RESEARCH_TOOL_FAILED';
const STAGE_FILE_CAPABILITY = 'app/session.stage-file';
function isStageFileDenial(cause) {
  if (['EACCES', 'EPERM', 'ERR_ACCESS_DENIED'].includes(cause?.code)) return false;
  const permission = cause?.kind === 'permission' || ['APP_CAPABILITY_DENIED', 'CAPABILITY_DENIED', 'FORBIDDEN', 'PERMISSION_DENIED'].includes(cause?.code);
  const legacy = (cause?.code === undefined || cause.code === 'APP_HOST_ERROR') && (cause?.kind === undefined || cause.kind === 'host');
  if (!permission && !legacy) return false;
  if (cause?.capability != null) return cause.capability === STAGE_FILE_CAPABILITY;
  const message = typeof cause?.message === 'string' ? cause.message : '';
  const named = /(?:^|[^A-Za-z0-9_./-])app\/session\.stage-file(?:$|[^A-Za-z0-9_./-])/.test(message);
  return named && (permission || /denied|unauthori[sz]ed|not (?:allowed|authori[sz]ed|granted|enabled)|requires?|required|missing|未授权|未获|未开启|未允许|拒绝|需要|缺少/i.test(message));
}
function string(value, max = TEXT, nonempty = false) {
  check(typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && Buffer.byteLength(value) <= max && (!nonempty || value.trim().length > 0));
}
function fields(value, names, required = names) {
  check(plain(value) && Object.keys(value).every((name) => names.includes(name)) && required.every((name) => Object.hasOwn(value, name)));
}
function integer(value, min, max) { check(Number.isInteger(value) && value >= min && value <= max); }
function fid(value) { check(typeof value === 'string' && FID.test(value)); }
function id(value) { check(typeof value === 'string' && ID.test(value)); }
function predecessors(value) { check(Array.isArray(value) && value.length <= ITEMS && new Set(value).size === value.length); value.forEach(fid); }
// Inspect descriptors before reading values: never execute getters/toJSON, drop
// undefined, collapse sparse arrays, or coerce non-JSON inputs into JSON.
function jsonValue(value, { maxText = TEXT, maxTotal = TOTAL, maxItems = ITEMS, maxDepth = 6 } = {}) {
  let bytes = 0; const ancestors = new Set();
  function add(size) { bytes += size; check(bytes <= maxTotal, 'RESEARCH_TOOL_INPUT_LIMIT'); }
  function visit(v, depth) {
    check(depth <= maxDepth, 'RESEARCH_TOOL_INPUT_LIMIT');
    if (typeof v === 'string') { string(v, maxText); add(Buffer.byteLength(JSON.stringify(v))); return v; }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) { add(Buffer.byteLength(JSON.stringify(v))); return v; }
    check(!isProxy(v) && (plain(v) || Array.isArray(v)) && !ancestors.has(v));
    const array = Array.isArray(v); const keys = Reflect.ownKeys(v).filter((key) => !(array && key === 'length'));
    check(keys.length <= maxItems && (!array || v.length === keys.length), 'RESEARCH_TOOL_INPUT_LIMIT');
    ancestors.add(v); add(2 + Math.max(0, keys.length - 1));
    const entries = keys.map((key) => {
      check(typeof key === 'string'); string(key, SMALL);
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
      if (array) check(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < v.length);
      else add(Buffer.byteLength(JSON.stringify(key)) + 1);
      return [key, visit(descriptor.value, depth + 1)];
    });
    ancestors.delete(v);
    return array ? entries.map((entry) => entry[1]) : Object.fromEntries(entries);
  }
  return visit(value, 0);
}
function invocation(value) {
  check(plain(value));
  const entries = []; let context;
  for (const key of Reflect.ownKeys(value)) {
    check(typeof key === 'string');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    if (key === 'context') context = descriptor.value;
    else entries.push([key, descriptor.value]);
  }
  check(plain(context), 'HOST_CONTEXT_REQUIRED');
  // Host stamps context last. Ordinary arguments never supply identity, paths,
  // authority or a replacement context; the service still authorizes every call.
  return { input: jsonValue(Object.fromEntries(entries)), context };
}
function glossary(value) {
  if (value === null) return;
  check(plain(value));
  for (const [key, val] of Object.entries(value)) {
    string(key, 128, true); string(val, SMALL, true);
    check(/^[A-Za-z0-9_\\{}^().+\-]+$/.test(key) && !/[\x00-\x1f\x7f\x85\u2028\u2029]/.test(val)
      && val === val.trim() && !/^[-?:,\[\]{}#&*!|>'"%@`]/.test(val) && !val.includes(': ') && !val.includes(' #'));
  }
}
const optional = (input, key, validate) => { if (Object.hasOwn(input, key)) validate(input[key]); };
const nullable = (validate) => (value) => { if (value !== null) validate(value); };
const pageOptions = input => Object.fromEntries(['cursor', 'limit'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
function validate(name, input, projects = false) {
  if (name === 'math_research') {
    const actions = { run: ['problem', 'operatorProfile', 'workerTask', 'timeoutSeconds'], status: ['runId'], result: ['runId', 'factId', 'cursor', 'limit'], stop: ['runId'], setup_status: ['runId'], set_tool_mode: ['runId', 'role', 'toolMode'] };
    check(typeof input.action === 'string' && Object.hasOwn(actions, input.action));
    fields(input, ['action', ...actions[input.action]], ['action', input.action === 'run' ? 'problem' : 'runId']);
    if (input.action === 'run') {
      string(input.problem, 128 * 1024, true);
      for (const key of ['operatorProfile', 'workerTask']) optional(input, key, (v) => string(v, 128 * 1024, true));
      optional(input, 'timeoutSeconds', (v) => integer(v, 60, 900));
    } else {
      id(input.runId); optional(input, 'factId', fid);
      if (input.action === 'result') factPageOptions(pageOptions(input), { factId: input.factId, code: 'RESEARCH_TOOL_INVALID_INPUT' });
      if (input.action === 'set_tool_mode') {
        check(['main', 'worker', 'verifier'].includes(input.role));
        check(['minimal', 'light', 'standard', 'full'].includes(input.toolMode));
      }
    }
  } else if (name === 'math_goal' || name === 'math_goal_main') {
    check(projects, 'PROJECT_SERVICE_REQUIRED');
    const actions = { start: ['authorized', 'maxAutomaticContinues', 'restartAuthorization'], resume: ['maxAutomaticContinues'], status: [], pause: [], stop: ['force'],
      acknowledge: ['goalId', 'generation', 'controlAt', 'auditAt'], wait: ['goalId', 'generation'],
      continue_work: ['goalId', 'generation'], complete: ['goalId', 'generation', 'factIds'] };
    check(typeof input.action === 'string' && Object.hasOwn(actions, input.action));
    if (name === 'math_goal_main') check(MAIN_GOAL_ACTIONS.includes(input.action));
    const exact = ['acknowledge', 'wait', 'continue_work', 'complete'].includes(input.action);
    fields(input, ['action', 'projectId', ...actions[input.action]], ['action', 'projectId',
      ...(exact ? ['goalId', 'generation'] : []), ...(input.action === 'start' ? ['authorized'] : []), ...(input.action === 'complete' ? ['factIds'] : [])]);
    id(input.projectId); check(/^project-/.test(input.projectId));
    if (exact) { id(input.goalId); check(/^goal-/.test(input.goalId)); integer(input.generation, 1, Number.MAX_SAFE_INTEGER); }
    if (input.action === 'start') check(input.authorized === true);
    if (Object.hasOwn(input, 'restartAuthorization')) {
      const value = input.restartAuthorization;
      check(plain(value) && Reflect.ownKeys(value).length === 1 && Object.getOwnPropertyDescriptor(value, 'resume')?.enumerable === true
        && ['none', 'preserve-budget'].includes(Object.getOwnPropertyDescriptor(value, 'resume')?.value));
    }
    optional(input, 'maxAutomaticContinues', value => integer(value, 0, Number.MAX_SAFE_INTEGER));
    optional(input, 'force', value => check(typeof value === 'boolean'));
    for (const key of ['controlAt', 'auditAt']) optional(input, key, value => integer(value, 0, Number.MAX_SAFE_INTEGER));
    if (input.action === 'acknowledge') check(Object.hasOwn(input, 'controlAt') || Object.hasOwn(input, 'auditAt'));
    if (input.action === 'complete') { check(Array.isArray(input.factIds) && input.factIds.length > 0 && input.factIds.length <= 64 && new Set(input.factIds).size === input.factIds.length); input.factIds.forEach(fid); }
  } else if (name === 'math_project') {
    check(projects, 'PROJECT_SERVICE_REQUIRED');
    const actions = { operator_read: [], operator_save: ['answers'], create: ['problem', 'operatorProfile', 'workerPolicy', 'workers'], list: [], status: ['projectId'], ipc_usage: ['projectId'], start: ['projectId', 'workerId', 'timeoutSeconds', 'model', 'thinkingLevel'],
      worker_models: ['projectId', 'offset', 'limit'], doctor: ['projectId'], recheck: ['projectId', 'workerId', 'runId'], stop: ['projectId', 'workerId', 'force'], result: ['projectId', 'factId', 'cursor', 'limit'], graph: ['projectId'], dashboard_snapshot: ['projectId'], dashboard_overview: ['projectId'], dashboard_follow: ['projectId'], dashboard_unfollow: ['projectId'], verification_reads: ['projectId', 'runId', 'submissionId'],
      finalize: ['projectId', 'paperId', 'factIds'], summary: ['projectId', 'language'], summary_status: ['projectId', 'reportId'], summary_result: ['projectId', 'reportId'], summary_stop: ['projectId', 'reportId'],
      paper_stitch: ['projectId', 'planReportId', 'finalSectionReportId'],
      paper_section: ['projectId', 'planReportId', 'previousSectionReportId'], paper_section_status: ['projectId', 'reportId'], paper_section_result: ['projectId', 'reportId'], paper_section_stop: ['projectId', 'reportId'],
      paper_plan: ['projectId', 'brief', 'paperId', 'instructions', 'factIds'], paper_plan_status: ['projectId', 'reportId'], paper_plan_result: ['projectId', 'reportId'], paper_plan_stop: ['projectId', 'reportId'],
      paper_subgraph: ['projectId', 'paperId'], paper: ['projectId', 'brief', 'paperId', 'instructions', 'factIds'], paper_status: ['projectId', 'reportId'], paper_result: ['projectId', 'reportId'], paper_stop: ['projectId', 'reportId'],
      paper_audit: ['projectId', 'reportId', 'planReportId', 'finalSectionReportId'], paper_audit_status: ['projectId', 'reportId'], paper_audit_result: ['projectId', 'reportId'], paper_audit_stop: ['projectId', 'reportId'],
      paper_revise: ['projectId', 'reportId', 'planReportId', 'finalSectionReportId', 'mode', 'notes', 'factIds', 'missingBacking', 'compileLog'], paper_revision_status: ['projectId', 'reportId'], paper_revision_result: ['projectId', 'reportId'], paper_revision_stop: ['projectId', 'reportId'],
      paper_verify: ['projectId', 'reportId'], paper_verify_status: ['projectId', 'reportId'], paper_verify_result: ['projectId', 'reportId'], paper_verify_stop: ['projectId', 'reportId'],
      paper_verify_math: ['projectId', 'reportId', 'planReportId', 'finalSectionReportId'],
      paper_verify_math_status: ['projectId', 'reportId'], paper_verify_math_result: ['projectId', 'reportId'], paper_verify_math_stop: ['projectId', 'reportId'],
      paper_deliver: ['projectId', 'reportId', 'planReportId', 'finalSectionReportId', 'mathReviewReportId', 'override', 'allowUncompiledTex'],
      paper_chapter_tree_stitch: ['projectId', 'host', 'chapters', 'confirmedStyleRules'] };
    check(typeof input.action === 'string' && Object.hasOwn(actions, input.action));
    const required = input.action === 'create' ? ['action', 'problem'] : ['list', 'operator_read'].includes(input.action) ? ['action']
      : input.action === 'operator_save' ? ['action', 'answers']
      : input.action === 'recheck' ? ['action', 'projectId', 'workerId', 'runId']
      : input.action === 'verification_reads' ? ['action', 'projectId', 'runId', 'submissionId']
      : input.action === 'paper_stitch' ? ['action', 'projectId', 'planReportId', 'finalSectionReportId']
      : input.action === 'paper_section' ? ['action', 'projectId', 'planReportId']
      : input.action === 'paper_deliver' ? ['action', 'projectId', 'mathReviewReportId']
      : input.action === 'paper_chapter_tree_stitch' ? ['action', 'projectId', 'host', 'chapters']
      : ['paper', 'paper_plan'].includes(input.action) ? ['action', 'projectId', 'brief']
      : ['paper_section_status', 'paper_section_result', 'paper_section_stop', 'paper_plan_status', 'paper_plan_result', 'paper_plan_stop', 'paper_revision_status', 'paper_revision_result', 'paper_revision_stop', 'summary_status', 'summary_result', 'summary_stop', 'paper_status', 'paper_result', 'paper_stop', 'paper_audit_status', 'paper_audit_result', 'paper_audit_stop', 'paper_verify', 'paper_verify_status', 'paper_verify_result', 'paper_verify_stop'].includes(input.action) ? ['action', 'projectId', 'reportId'] : ['action', 'projectId'];
    fields(input, ['action', ...actions[input.action]], required);
    if (input.action === 'paper_plan' || ['paper_plan_status', 'paper_plan_result', 'paper_plan_stop'].includes(input.action))
      snapshotPaperPlanRequest(input, { tool: true, read: input.action !== 'paper_plan', code: 'RESEARCH_TOOL_INVALID_INPUT' });
    if (['paper_section', 'paper_section_status', 'paper_section_result', 'paper_section_stop'].includes(input.action))
      snapshotPaperSectionRequest(input, { tool: true, read: input.action !== 'paper_section', code: 'RESEARCH_TOOL_INVALID_INPUT' });
    if (input.action === 'paper_stitch') snapshotPaperStitchRequest(input, { tool: true, code: 'RESEARCH_TOOL_INVALID_INPUT' });
    if (input.action === 'paper_audit') {
      const { action, ...selector } = input;
      const code = 'RESEARCH_TOOL_INVALID_INPUT';
      if (Object.hasOwn(selector, 'reportId')) snapshotPaperSectionRequest(selector, { read: true, code });
      else snapshotPaperStitchRequest(selector, { code });
    }
    if (paperMathActions.includes(input.action)) {
      const { action, ...selector } = input;
      const code = 'RESEARCH_TOOL_INVALID_INPUT';
      if (action === 'paper_verify_math' && !Object.hasOwn(selector, 'reportId')) snapshotPaperStitchRequest(selector, { code });
      else snapshotPaperSectionRequest(selector, { read: true, code });
    }
    if (input.action === 'paper_revise') snapshotPaperRevisionRequest(input, { tool: true, code: 'RESEARCH_TOOL_INVALID_INPUT' });
    if (input.action === 'paper_deliver') snapshotPaperDeliveryRequest(input, { tool: true, code: 'RESEARCH_TOOL_INVALID_INPUT' });
    if (input.action === 'paper_chapter_tree_stitch') snapshotChapterTreeRequest(input, { tool: true, code: 'RESEARCH_TOOL_INVALID_INPUT' });
    if (input.action === 'operator_save') {
      try { updateOperatorAnswers({}, input.answers); } catch { throw error('RESEARCH_TOOL_INVALID_INPUT'); }
      check(Object.keys(input.answers).length > 0);
    } else if (input.action === 'create') {
      string(input.problem, 128 * 1024, true); optional(input, 'operatorProfile', (v) => string(v, 128 * 1024, true));
      optional(input, 'workerPolicy', normalizeResearchWorkerPolicy); optional(input, 'workers', (v) => integer(v, 1, 4));
    } else {
      optional(input, 'projectId', id); optional(input, 'workerId', id); optional(input, 'factId', fid);
      if (input.action === 'start') normalizeWorkerDispatch(Object.fromEntries(['model', 'thinkingLevel'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])));
      if (input.action === 'worker_models') {
        optional(input, 'offset', v => integer(v, 0, Number.MAX_SAFE_INTEGER));
        optional(input, 'limit', v => integer(v, 1, 64));
      }
      if (input.action === 'result') factPageOptions(pageOptions(input), { factId: input.factId, projectId: input.projectId, code: 'RESEARCH_TOOL_INVALID_INPUT' });
      optional(input, 'runId', id); optional(input, 'submissionId', id);
      optional(input, 'reportId', v => check(typeof v === 'string' && /^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)));
      optional(input, 'timeoutSeconds', (v) => integer(v, 60, 900)); optional(input, 'force', v => check(typeof v === 'boolean'));
      optional(input, 'paperId', id);
      optional(input, 'brief', v => string(v, 32 * 1024, true));
      optional(input, 'instructions', v => string(v, 32 * 1024));
      optional(input, 'factIds', v => { check(Array.isArray(v) && (['paper', 'paper_plan', 'paper_revise'].includes(input.action) || v.length > 0) && v.length <= 64 && new Set(v).size === v.length); Array.from(v).forEach(fid); });
      optional(input, 'language', v => check(typeof v === 'string' && LANGUAGE_NAME.test(v)));
    }
  } else if (name === 'gm_add') {
    fields(input, ['kind', 'claim', 'evidence', 'verifiable', 'glossary', 'links'], ['kind', 'claim']);
    check(KINDS.includes(input.kind)); string(input.claim, TEXT, true);
    optional(input, 'evidence', (v) => string(v)); optional(input, 'verifiable', nullable((v) => check(typeof v === 'boolean')));
    optional(input, 'glossary', glossary); optional(input, 'links', nullable((v) => check(plain(v))));
    if (input.verifiable ?? VERIFIED_DEFAULTS.has(input.kind)) string(input.evidence, TEXT, true);
  } else if (name === 'gm_search' || name === 'fact_search') {
    const limit = name === 'gm_search' ? 'limit_per_kind' : 'limit';
    fields(input, name === 'gm_search' ? ['query', limit, 'kinds'] : ['query', limit], ['query']);
    string(input.query, SMALL); optional(input, limit, (v) => integer(v, 1, ITEMS));
    optional(input, 'kinds', nullable((v) => check(Array.isArray(v) && v.every((kind) => KINDS.includes(kind)))));
  } else if (name === 'fact_submit') {
    fields(input, ['statement', 'proof', 'predecessors', 'glossary_introduces', 'intuition', 'source_id', 'external_refs'], ['statement', 'proof']);
    string(input.statement, TEXT, true); string(input.proof, TEXT, true);
    optional(input, 'predecessors', nullable(predecessors)); optional(input, 'glossary_introduces', glossary);
    optional(input, 'intuition', (v) => string(v)); optional(input, 'source_id', nullable((v) => string(v, SMALL)));
    optional(input, 'external_refs', nullable((v) => check(Array.isArray(v) && v.every(plain))));
  } else if (name === 'fact_revoke') {
    fields(input, ['fact_id', 'reason']); fid(input.fact_id); string(input.reason, SMALL, true);
  } else if (name === 'search_arxiv_theorems') {
    fields(input, ['query', 'num_results'], ['query']); string(input.query, 16384, true); optional(input, 'num_results', (v) => integer(v, 1, 100));
  } else if (name === 'math_assign') {
    fields(input, projects ? ['task', 'workerId', 'model', 'thinkingLevel', 'displayTitle'] : ['task'], ['task']); string(input.task, 128 * 1024, true);
    if (projects) {
      optional(input, 'workerId', id);
      optional(input, 'displayTitle', value => check(typeof value === 'string'));
      normalizeWorkerDispatch(Object.fromEntries(['model', 'thinkingLevel'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])));
    }
  } else if (name === 'math_local_memory') {
    check(input.action === 'read' || input.action === 'append');
    fields(input, input.action === 'read' ? ['action'] : ['action', 'text']);
    if (input.action === 'append') string(input.text, TEXT, true);
  } else if (name === 'math_verification_report') {
    fields(input, ['verification_report', 'verdict', 'repair_hints']);
    const report = input.verification_report; fields(report, ['summary', 'critical_errors', 'gaps']);
    string(report.summary); string(input.repair_hints);
    for (const key of ['critical_errors', 'gaps']) {
      check(Array.isArray(report[key]));
      for (const issue of report[key]) { fields(issue, ['location', 'issue']); string(issue.location, SMALL, true); string(issue.issue, TEXT, true); }
    }
    const issues = report.critical_errors.length + report.gaps.length;
    check(input.verdict === 'correct' && issues === 0 && input.repair_hints === ''
      || input.verdict === 'wrong' && issues > 0 && input.repair_hints.trim().length > 0, 'REPORT_CONTRADICTION');
  }
}

const str = (max = TEXT, nonempty = false) => ({ type: 'string', maxLength: max, ...(nonempty ? { minLength: 1 } : {}) });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const nil = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const list = (items) => ({ type: 'array', maxItems: ITEMS, items });
const int = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const fidSchema = { type: 'string', pattern: FID.source };
const idSchema = { type: 'string', pattern: ID.source };
const dictionary = { type: 'object', maxProperties: ITEMS, additionalProperties: true, description: 'Preserve the JSON dictionary verbatim; execution checks UTF-8, item count, depth and total size.' };
const glossarySchema = nil({ type: 'object', maxProperties: ITEMS, propertyNames: { type: 'string', maxLength: 128 }, additionalProperties: str(SMALL, true) });
const runProperties = { action: { const: 'run' }, problem: str(128 * 1024, true), operatorProfile: str(128 * 1024, true), workerTask: str(128 * 1024, true), timeoutSeconds: int(60, 900) };
const pagingProperties = { cursor: { type: 'string', minLength: 1, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$', description: 'Opaque continuation from the same project/asOf observation; not an authority token.' }, limit: int(1, 64) };
const resultVariants = key => [obj({ action: { const: 'result' }, [key]: idSchema, ...pagingProperties }, ['action', key]),
  obj({ action: { const: 'result' }, [key]: idSchema, factId: fidSchema })];
const controlVariants = [obj(runProperties, ['action', 'problem']), ...['status', 'stop', 'setup_status'].map((action) => obj({ action: { const: action }, runId: idSchema }, ['action', 'runId'])), ...resultVariants('runId')];
controlVariants.push(obj({ action: { const: 'set_tool_mode' }, runId: idSchema, role: { type: 'string', enum: ['main', 'worker', 'verifier'] }, toolMode: { type: 'string', enum: ['minimal', 'light', 'standard', 'full'] } }));
const reportIssue = obj({ location: str(SMALL, true), issue: str(TEXT, true) });
const schemas = {
  math_research: { ...obj({ ...runProperties, action: { type: 'string', enum: ['run', 'status', 'result', 'stop', 'setup_status', 'set_tool_mode'] }, runId: idSchema, factId: fidSchema, ...pagingProperties, role: { type: 'string', enum: ['main', 'worker', 'verifier'] }, toolMode: { type: 'string', enum: ['minimal', 'light', 'standard', 'full'] } }, ['action']), oneOf: controlVariants },
  gm_add: obj({ kind: { type: 'string', enum: KINDS }, claim: str(TEXT, true), evidence: str(), verifiable: { type: ['boolean', 'null'] }, glossary: glossarySchema, links: nil(dictionary) }, ['kind', 'claim']),
  gm_search: obj({ query: str(SMALL), kinds: nil(list({ type: 'string', enum: KINDS })), limit_per_kind: int(1, ITEMS) }, ['query']),
  fact_submit: obj({ statement: str(TEXT, true), proof: { ...str(TEXT, true), description: 'Complete proof text. Include every external citation needed by the verifier with precise theorem, hypotheses and source locator; candidate metadata is intentionally not sent to the verifier.' }, predecessors: nil({ ...list(fidSchema), uniqueItems: true }), glossary_introduces: glossarySchema, intuition: str(),
    source_id: { ...nil(str(SMALL)), description: 'Optional GLOBAL MEMORY finding ID being promoted, not an arXiv ID.' },
    external_refs: { ...nil(list(dictionary)), description: 'Mutable bibliography metadata, excluded from fact-ID hashing. Illustrative entry only: {"key":"HL26","authors":["Han","Liu"],"title":"...","arxiv":"2603.03817","year":2026,"cited_for":"Theorem 1.2"}. Ground actual entries in sources; this example is not evidence. Also place verifier-needed citations in proof text; metadata is not supplied to the verifier.' } }, ['statement', 'proof']),
  fact_search: obj({ query: str(SMALL), limit: int(1, ITEMS) }, ['query']),
  fact_revoke: obj({ fact_id: fidSchema, reason: str(SMALL, true) }),
  search_arxiv_theorems: obj({ query: str(16384, true), num_results: int(1, 100) }, ['query']),
  math_assign: obj({ task: str(128 * 1024, true) }),
  math_local_memory: { ...obj({ action: { type: 'string', enum: ['read', 'append'] }, text: str(TEXT, true) }, ['action']), oneOf: [obj({ action: { const: 'read' } }), obj({ action: { const: 'append' }, text: str(TEXT, true) })] },
  math_verification_report: obj({ verification_report: obj({ summary: str(), critical_errors: list(reportIssue), gaps: list(reportIssue) }), verdict: { type: 'string', enum: ['correct', 'wrong'] }, repair_hints: str() }),
};
const workerPolicySchema = { ...obj({ maxRounds: int(0, Number.MAX_SAFE_INTEGER), roundTimeoutSeconds: int(1, MAX_TIMER_SECONDS),
  roundDelaySeconds: { type: 'number', minimum: 0, maximum: MAX_TIMER_SECONDS }, maxConsecutiveFailures: int(0, Number.MAX_SAFE_INTEGER) }, []),
  description: 'Danus research rounds. Omitted or empty uses Danus defaults 0/14400/5/5; maxRounds=0 is unlimited. Round timeout is not a total-run cap.' };
const dispatchProperties = { model: obj({ provider: str(256, true), id: str(256, true) }), thinkingLevel: str(128, true) };
const workersSchema = { ...int(1, 4), description: 'Number of logical workers fixed at create: worker-1..worker-N. Default 1.' };
const LANGUAGE_NAME = /^[A-Za-z][A-Za-z -]{0,63}$/;
const languageSchema = { type: 'string', minLength: 1, maxLength: 64, pattern: LANGUAGE_NAME.source, description: 'Report narrative language name, default English.' };
const paperBriefSchema = { ...str(32 * 1024, true), description: 'Required writing brief; nonblank, well-formed Unicode, no NUL, at most 32 KiB UTF-8.' };
const paperInstructionsSchema = { ...str(32 * 1024), description: 'Optional writing instructions; well-formed Unicode, no NUL, at most 32 KiB UTF-8.' };
const paperReportIdSchema = { type: 'string', pattern: '^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const operatorAnswersSchema = { ...obj(Object.fromEntries(operatorFields.map(key => [key, nil(key === 'spendWarningUsd'
  ? { type: 'number', minimum: 0, description: 'USD warning only, not a stop or charge.' }
  : str(1024, true))])), []), minProperties: 1 };
const paperMathActions = ['paper_verify_math', 'paper_verify_math_status', 'paper_verify_math_result', 'paper_verify_math_stop'];
const missingBackingSchema = { type: 'array', minItems: 1, maxItems: 16, items: str(1024, true) };
const deliveryOverrideSchema = obj({ reason: str(2048, true) });
const chapterIdSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$' };
const chapterHostSchema = {
  oneOf: [
    obj({ reportId: paperReportIdSchema, assemblyAnchor: str(1024, true) }, ['reportId']),
    obj({ planReportId: paperReportIdSchema, finalSectionReportId: paperReportIdSchema, assemblyAnchor: str(1024, true) }, ['planReportId', 'finalSectionReportId']),
  ],
};
const chapterItemSchema = {
  oneOf: [
    obj({ chapterId: chapterIdSchema, title: str(1024, true), reportId: paperReportIdSchema,
      dependsOn: { type: 'array', maxItems: 32, uniqueItems: true, items: chapterIdSchema }, hostPointerLabel: str(256, true) }, ['chapterId', 'title', 'reportId']),
    obj({ chapterId: chapterIdSchema, title: str(1024, true), planReportId: paperReportIdSchema, finalSectionReportId: paperReportIdSchema,
      dependsOn: { type: 'array', maxItems: 32, uniqueItems: true, items: chapterIdSchema }, hostPointerLabel: str(256, true) }, ['chapterId', 'title', 'planReportId', 'finalSectionReportId']),
  ],
};
const confirmedStyleRulesSchema = obj({ confirmedByOperator: { const: true }, rules: str(16 * 1024, true) });
const projectVariants = [
  obj({ action: { const: 'operator_read' } }),
  obj({ action: { const: 'operator_save' }, answers: operatorAnswersSchema }),
  obj({ action: { const: 'create' }, problem: str(128 * 1024, true), operatorProfile: str(128 * 1024, true), workerPolicy: workerPolicySchema, workers: workersSchema }, ['action', 'problem']),
  obj({ action: { const: 'list' } }),
  obj({ action: { const: 'graph' }, projectId: idSchema }),
  obj({ action: { const: 'dashboard_snapshot' }, projectId: idSchema }),
  obj({ action: { const: 'dashboard_overview' }, projectId: idSchema }),
  ...['dashboard_follow', 'dashboard_unfollow'].map(action => obj({ action: { const: action }, projectId: idSchema })),
  obj({ action: { const: 'doctor' }, projectId: idSchema }),
  obj({ action: { const: 'ipc_usage' }, projectId: idSchema }),
  obj({ action: { const: 'recheck' }, projectId: idSchema, workerId: idSchema, runId: idSchema }),
  obj({ action: { const: 'worker_models' }, projectId: idSchema, offset: int(0, Number.MAX_SAFE_INTEGER), limit: int(1, 64) }, ['action', 'projectId']),
  obj({ action: { const: 'verification_reads' }, projectId: idSchema, runId: idSchema, submissionId: idSchema }),
  obj({ action: { const: 'finalize' }, projectId: idSchema, paperId: idSchema, factIds: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: fidSchema } }, ['action', 'projectId']),
  obj({ action: { const: 'summary' }, projectId: idSchema, language: languageSchema }, ['action', 'projectId']),
  ...['summary_status', 'summary_result', 'summary_stop'].map(action => obj({ action: { const: action }, projectId: idSchema, reportId: idSchema }, ['action', 'projectId', 'reportId'])),
  obj({ action: { const: 'paper_subgraph' }, projectId: idSchema, paperId: idSchema }, ['action', 'projectId']),
  obj({ action: { const: 'paper' }, projectId: idSchema, brief: paperBriefSchema, paperId: idSchema, instructions: paperInstructionsSchema,
    factIds: { type: 'array', minItems: 0, maxItems: 64, uniqueItems: true, items: fidSchema } }, ['action', 'projectId', 'brief']),
  obj({ action: { const: 'paper_plan' }, projectId: idSchema, brief: paperBriefSchema, paperId: idSchema, instructions: paperInstructionsSchema,
    factIds: { type: 'array', minItems: 0, maxItems: 64, uniqueItems: true, items: fidSchema } }, ['action', 'projectId', 'brief']),
  obj({ action: { const: 'paper_stitch' }, projectId: idSchema, planReportId: paperReportIdSchema, finalSectionReportId: paperReportIdSchema }),
  obj({ action: { const: 'paper_section' }, projectId: idSchema, planReportId: paperReportIdSchema, previousSectionReportId: paperReportIdSchema }, ['action', 'projectId', 'planReportId']),
  ...['paper_section_status', 'paper_section_result', 'paper_section_stop'].map(action => obj({ action: { const: action }, projectId: idSchema, reportId: paperReportIdSchema })),
  ...['paper_plan_status', 'paper_plan_result', 'paper_plan_stop'].map(action => obj({ action: { const: action }, projectId: idSchema, reportId: paperReportIdSchema })),
  obj({ action: { const: 'paper_revise' }, projectId: idSchema, reportId: paperReportIdSchema, mode: { const: 'citation' } }, ['action', 'projectId', 'reportId']),
  obj({ action: { const: 'paper_revise' }, projectId: idSchema, reportId: paperReportIdSchema,
    mode: { const: 'operator-notes' }, notes: paperBriefSchema }),
  obj({ action: { const: 'paper_revise' }, projectId: idSchema, planReportId: paperReportIdSchema, finalSectionReportId: paperReportIdSchema,
    mode: { const: 'operator-notes' }, notes: paperBriefSchema }),
  obj({ action: { const: 'paper_revise' }, projectId: idSchema, reportId: paperReportIdSchema,
    mode: { const: 'gap-fill' }, factIds: { type: 'array', minItems: 0, maxItems: 16, uniqueItems: true, items: fidSchema },
    notes: paperBriefSchema, missingBacking: missingBackingSchema }, ['action', 'projectId', 'reportId', 'mode', 'factIds', 'notes']),
  obj({ action: { const: 'paper_revise' }, projectId: idSchema, reportId: paperReportIdSchema,
    mode: { const: 'compile-fix' }, compileLog: paperBriefSchema }),
  obj({ action: { const: 'paper_revise' }, projectId: idSchema, planReportId: paperReportIdSchema, finalSectionReportId: paperReportIdSchema,
    mode: { const: 'compile-fix' }, compileLog: paperBriefSchema }),
  obj({ action: { const: 'paper_audit' }, projectId: idSchema, reportId: paperReportIdSchema }),
  obj({ action: { const: 'paper_audit' }, projectId: idSchema, planReportId: paperReportIdSchema, finalSectionReportId: paperReportIdSchema }),
  ...['paper_revision_status', 'paper_revision_result', 'paper_revision_stop', 'paper_status', 'paper_result', 'paper_stop', 'paper_audit_status', 'paper_audit_result', 'paper_audit_stop', 'paper_verify', 'paper_verify_status', 'paper_verify_result', 'paper_verify_stop'].map(action => obj({ action: { const: action }, projectId: idSchema, reportId: paperReportIdSchema })),
  ...paperMathActions.map(action => obj({ action: { const: action }, projectId: idSchema, reportId: paperReportIdSchema })),
  obj({ action: { const: 'paper_verify_math' }, projectId: idSchema, planReportId: paperReportIdSchema, finalSectionReportId: paperReportIdSchema }),
  obj({ action: { const: 'paper_deliver' }, projectId: idSchema, reportId: paperReportIdSchema, mathReviewReportId: paperReportIdSchema,
    override: deliveryOverrideSchema, allowUncompiledTex: { type: 'boolean' } }, ['action', 'projectId', 'reportId', 'mathReviewReportId']),
  obj({ action: { const: 'paper_deliver' }, projectId: idSchema, planReportId: paperReportIdSchema, finalSectionReportId: paperReportIdSchema,
    mathReviewReportId: paperReportIdSchema, override: deliveryOverrideSchema, allowUncompiledTex: { type: 'boolean' } },
    ['action', 'projectId', 'planReportId', 'finalSectionReportId', 'mathReviewReportId']),
  obj({ action: { const: 'paper_chapter_tree_stitch' }, projectId: idSchema, host: chapterHostSchema,
    chapters: { type: 'array', minItems: 1, maxItems: 32, items: chapterItemSchema }, confirmedStyleRules: confirmedStyleRulesSchema },
    ['action', 'projectId', 'host', 'chapters']),
  ...resultVariants('projectId'),
  ...['status', 'start', 'stop'].map((action) => obj({ action: { const: action }, projectId: idSchema,
    ...(['start', 'stop'].includes(action) ? { workerId: idSchema } : {}), ...(action === 'start' ? { timeoutSeconds: int(60, 900), ...dispatchProperties } : {}),
    ...(action === 'stop' ? { force: { type: 'boolean' } } : {}) }, ['action', 'projectId'])),
];
const projectSchema = { ...obj({ action: { type: 'string', enum: ['operator_read', 'operator_save', 'ipc_usage', 'paper_stitch', 'paper_section', 'paper_section_status', 'paper_section_result', 'paper_section_stop', 'paper_plan', 'paper_plan_status', 'paper_plan_result', 'paper_plan_stop', 'paper_revise', 'paper_revision_status', 'paper_revision_result', 'paper_revision_stop', 'create', 'list', 'status', 'start', 'stop', 'result', 'graph', 'dashboard_snapshot', 'dashboard_overview', 'dashboard_follow', 'dashboard_unfollow', 'worker_models', 'doctor', 'recheck', 'verification_reads', 'finalize', 'summary', 'summary_status', 'summary_result', 'summary_stop', 'paper_subgraph', 'paper', 'paper_status', 'paper_result', 'paper_stop', 'paper_audit', 'paper_audit_status', 'paper_audit_result', 'paper_audit_stop', 'paper_verify', 'paper_verify_status', 'paper_verify_result', 'paper_verify_stop', ...paperMathActions, 'paper_deliver', 'paper_chapter_tree_stitch'] },
  answers: operatorAnswersSchema, problem: str(128 * 1024, true), operatorProfile: str(128 * 1024, true), workerPolicy: workerPolicySchema, workers: workersSchema, ...dispatchProperties, projectId: idSchema, workerId: idSchema, runId: idSchema, submissionId: idSchema, timeoutSeconds: int(60, 900), force: { type: 'boolean' }, factId: fidSchema, ...pagingProperties, offset: int(0, Number.MAX_SAFE_INTEGER),
  paperId: idSchema, factIds: { type: 'array', minItems: 0, maxItems: 64, uniqueItems: true, items: fidSchema }, language: languageSchema, reportId: idSchema, planReportId: paperReportIdSchema, previousSectionReportId: paperReportIdSchema, finalSectionReportId: paperReportIdSchema, brief: paperBriefSchema, instructions: paperInstructionsSchema,
  mode: { type: 'string', enum: ['citation', 'operator-notes', 'gap-fill', 'compile-fix'] }, notes: paperBriefSchema,
  missingBacking: missingBackingSchema, compileLog: paperBriefSchema, mathReviewReportId: paperReportIdSchema,
  override: deliveryOverrideSchema, allowUncompiledTex: { type: 'boolean' },
  host: chapterHostSchema, chapters: { type: 'array', minItems: 1, maxItems: 32, items: chapterItemSchema },
  confirmedStyleRules: confirmedStyleRulesSchema }, ['action']), oneOf: projectVariants };
const goalIdentity = { projectId: { ...idSchema, pattern: '^project-[a-z0-9][a-z0-9-]{0,59}$' },
  goalId: { ...idSchema, pattern: '^goal-[a-z0-9][a-z0-9-]{0,59}$' }, generation: int(1, Number.MAX_SAFE_INTEGER) };
const restartAuthorizationSchema = obj({ resume: { type: 'string', enum: ['none', 'preserve-budget'] } });
const goalVariants = [
  obj({ action: { const: 'start' }, projectId: goalIdentity.projectId, authorized: { const: true }, maxAutomaticContinues: int(0, Number.MAX_SAFE_INTEGER), restartAuthorization: restartAuthorizationSchema }, ['action', 'projectId', 'authorized']),
  ...['resume', 'status', 'pause', 'stop'].map(action => obj({ action: { const: action }, projectId: goalIdentity.projectId,
    ...(action === 'resume' ? { maxAutomaticContinues: int(0, Number.MAX_SAFE_INTEGER) } : {}),
    ...(action === 'stop' ? { force: { type: 'boolean' } } : {}) }, ['action', 'projectId'])),
  ...['wait', 'continue_work'].map(action => obj({ action: { const: action }, ...goalIdentity })),
  { ...obj({ action: { const: 'acknowledge' }, ...goalIdentity, controlAt: int(0, Number.MAX_SAFE_INTEGER), auditAt: int(0, Number.MAX_SAFE_INTEGER) }, ['action', ...Object.keys(goalIdentity)]),
    anyOf: [{ required: ['controlAt'] }, { required: ['auditAt'] }] },
  obj({ action: { const: 'complete' }, ...goalIdentity, factIds: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: fidSchema } }),
];
const goalSchema = { ...obj({ action: { type: 'string', enum: ['start', 'resume', 'status', 'pause', 'stop', 'acknowledge', 'wait', 'continue_work', 'complete'] },
  ...goalIdentity, authorized: { const: true }, maxAutomaticContinues: int(0, Number.MAX_SAFE_INTEGER), restartAuthorization: restartAuthorizationSchema, force: { type: 'boolean' }, controlAt: int(0, Number.MAX_SAFE_INTEGER), auditAt: int(0, Number.MAX_SAFE_INTEGER),
  factIds: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: fidSchema } }, ['action', 'projectId']), oneOf: goalVariants };
const MAIN_GOAL_ACTIONS = ['status', 'acknowledge', 'wait', 'continue_work', 'pause', 'stop', 'complete'];
const mainGoalSchema = { ...obj({ ...Object.fromEntries(Object.entries(goalSchema.properties).filter(([key]) => !['authorized', 'maxAutomaticContinues', 'restartAuthorization'].includes(key))),
  action: { type: 'string', enum: MAIN_GOAL_ACTIONS } }, ['action', 'projectId']),
  oneOf: goalVariants.filter(variant => MAIN_GOAL_ACTIONS.includes(variant.properties.action.const)) };
const MAIN_GOAL_PERMISSION = { auto: 'allow',
  description: 'Bound project main only: inspect and update an already authorized Goal, including requesting its workers to stop. Does not start or resume Goals or replenish continuation allowances. Ask mode may still require human confirmation.',
  sideEffect: { updatesGoalState: true, mayStopProjectWorkers: true, startsNewGoal: false, replenishesContinuationAllowance: false } };
const PROJECT_MAIN_TOOLS = new Set(['math_assign', 'gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems']);
const descriptions = {
  math_goal_main: 'Control an already authorized Goal from its bound project main. Use status, acknowledge, wait, continue_work, pause, stop, or complete with the current projectId and exact goalId/generation. Acknowledge only substantive reviews performed; wait requires all pending reviews to be acknowledged. Pause stops automatic main inputs while workers continue. Stop and complete request project workers to stop; stop.force requests immediate termination. Complete records the main decision after checking the supplied canonical facts exist; it does not assess target coverage or perform the creator’s finalize action.',
  math_goal: 'Manage the project main Goal. Starting long-term research requires prior explicit operator authorization and authorized:true; only the creator may start or resume. Only start accepts restartAuthorization:{resume:"none"|"preserve-budget"}; omission means no automatic restart. On App restart, old Goals stay parked and do not auto-resume. A creator may explicitly resume the selected historical Goal after its own binding, budget and cleanup checks. preserve-budget retains its reservation policy; restarting the App never widens this authorization. start/resume.maxAutomaticContinues sets the continuation reservation limit: omitted or 0 means unlimited; positive values count reservations, not model calls or mathematical progress. Deadline reviews do not consume reservations. Exhaustion leaves the Goal active in budget wait; reviews, continue_work and global memory do not refill it. Creator pause/resume starts a new epoch and resets reservations. Acknowledge due reviews after substantive review work with exact goalId, generation and controlAt/auditAt; wait only when no review is pending. continue_work resumes useful work in an active Goal. Pause stops automatic main inputs while existing workers continue; stop or complete also requests worker stopping, and stop.force requests immediate termination. complete checks fact existence, not target coverage, and does not perform creator-only math_project finalize.',
  math_research: 'Run bounded research with saved roles. run requires user authorization, lasts at most 900 seconds and uses at most 3 worker turns. status and result inspect without restarting; pending/finished does not establish the whole problem. result can deliver one complete proof attachment. stop requests termination. setup_status reads role setup; set_tool_mode saves a mode after the run stops and does not grant Host permissions.',
  math_project: 'Manage projects with saved roles. dashboard_follow and dashboard_unfollow require an explicit request in the original project-creation conversation and only accept projectId. They grant or revoke permission for local Σ to keep following that project across restarts, for verified new activity or a confirmed terminal result associated with that project. App startup does not replay old research; an unfinished previous run can block that project’s next worker, without requiring other projects to recover it. If the project already ended and no terminal dashboard was archived, explicit follow may show its current saved results read-only when all research is confirmed idle and no active or trusted terminal view takes precedence. The reading basis is not an end time. Never infer consent or migrate an older project without it. These actions do not select an arbitrary dashboard target, start, stop or resume a Goal or worker, or change .hanamathboard document permissions. dashboard_snapshot is creator-only: export one complete fact-graph snapshot as a same-conversation attachment; no automatic refresh. dashboard_overview is creator-only: read one point-in-time project summary with counts, verdicts and sampling time; no finding bodies, attachment or automatic refresh. ipc_usage is a creator-only, non-atomic App-wide managed IPC capacity read, not project attribution or cleanup. paper_stitch is creator-only: select a frozen plan and completed terminal section to export main.tex as text. No new research, writer or compilation. paper_section is creator-only: one explicit next section from a clean settled paper_plan, with optional previousSectionReportId; omission starts index 0, explicit retries may branch. End-of-plan returns no_next_section without creating a report, task or writer. Results deliver only section.tex, SECTION_RESULT.json and inherited REFERENCE_LEDGER.md; raw response/provenance are archived separately. Flagged blockers may advance; leaks/empty output fail. Historical fragments do not certify current chain validity, body coverage, labels, macros, citations, mathematics, assembly or compilation. paper_section_status/result/stop accept projectId and reportId. paper_plan is creator-only: an explicit phase-1 linear section-plan preview, not a paper-source, automatic chunk-trigger claim, section writer, stitch or PDF. It needs a finalized target and nonblank brief; paperId defaults to main. Omitted/empty factIds covers the full target closure (including 10 or more headlines); explicit selection permits 0..64 unique IDs and must include every headline. It may cover the entire closure. Outside-target same-project selections retain warnings. Only coverage canonical statements and predecessors are supplied, never proofs/intuition or unselected ancestor statements; the reference ledger is the validation-union adaptation. paper_plan_status/result/stop use its reportId. Clean completed plans expose exact-once normalized coverage only, not section ordering, citation correctness, mathematics, style or compilation acceptance. Default files are PLANNER_BLOCKS.json, SECTION_PLAN.json and REFERENCE_LEDGER.md, not raw-response.txt or any TeX source. 128 input sections, 4096 UTF-8 bytes per title/label and 512 KiB prompt are explicit App resource guardrails, not claims about Host hard limits or upstream automatic trigger thresholds. The effective shared research-session finalText limit is 512 KiB; oversized finalText is rejected, not truncated. The planner parser/artifact guard is separately 2 MiB, not a usable session output allowance. Creator only: paper_subgraph reads the finalized target closure as a compact statement-only skeleton, with no proof or reference text; paperId defaults to main. It accepts no selection or brief, creates no writer/session/report/TeX, and does not change paper writing. Existing Core runtime/task/audit bookkeeping may occur; this is not a zero-write promise. Creator only: recheck requires explicit projectId, workerId and runId (no all/default worker), actively rechecks a loaded terminal worker run with a transient recovery fence and may remove schedules, abort sessions, fail tasks. It is not read-only or doctor and never starts/replays research. mutationAttempts are cumulative attempts for the shared cleanup job, not successful actions or actions initiated by a joiner; recheckPending means that job is still in flight. RECHECK_NOT_NEEDED means no current recovery fence and no reconciliation by this request, not proof of resource readiness or credit for a historical request. Bound main only: doctor reads loaded project/Goal/run/Core diagnostics without refreshing, repairing or replaying; unknown remains unknown and does not certify recovery readiness. worker_models reads the current model directory with offset (default 0) and limit (default 32, maximum 64), supported thinking levels and persistent permission status. Optional model/thinkingLevel on math_assign replace pending choices; start overrides supplied fields and inherits others. Omission uses saved-role/model defaults without changing presets. create requires operator authorization and the original problem; workerPolicy overrides Danus round defaults; workers fixes worker-1..worker-N. multi-worker start requires workerId; stop without it stops all. Runs have no total timeout unless timeoutSeconds is set; stop waits for a round boundary unless force is true. result returns preview pages: continue with nextCursor from the same asOf and never mix observations; factId returns a complete fact. graph: offline previews of the verified index and predecessor edges, max 2048 facts/32768 edges; drift or size refusal exports nothing. finalize is creator-only and selects paper facts. summary is creator-only; summary_status, summary_result, and summary_stop use its reportId. For a clean progress report, summary_result stages the original Markdown and, when it can be rendered offline, an HTML attachment with typeset formulas. The top-level fileId is the Markdown. For PDF, in the creator conversation, use the staged html.resource.fileId to materialize that HTML attachment, then call the Host office_html-to-pdf tool with its htmlPath and allowJavaScript:false. If HTML was not staged, report html.reason and keep the Markdown; do not print a different source. Deliver the files rather than pasting raw $...$ or LaTeX into the chat. A report refuses revoked or changed captured facts and excludes later facts; metadata records snapshot timing and advancement. paper is creator-only: needs a finalized target (paperId defaults to main) and brief. Optional factIds selects 0..64 unique canonical fact IDs; omitted/empty uses the legacy target closure only when it has fewer than 10 facts. At 10 or more, explicit selection must omit at least one closure fact, even for a superset, and every finalized headline must be selected. Selected full text only is supplied, not unselected internal statements/proofs; citation support comes from the bounded validation union ledger. Outside-target selections persist a warning. Canonical creator preflight occurs before a paper report/task/schedule/writer; Core bookkeeping may occur. Captured material is checked again at queue, model start and publication. Immutable sources; citations, mathematics and compilation remain unverified; no PDF. paper_status/result/stop use its reportId. paper_audit is a creator-only offline reference audit of a completed paper-source, settled revision proposal (proposal.tex), or frozen stitched manuscript (planReportId + finalSectionReportId); citations remain unverified. paper_verify is creator-only: from a completed reference audit, bounded online checks of unverified ledger entries only, writing a new verdicts JSON and ledger. It never changes main.tex, does not review whole-paper mathematics, and does not compile or produce a PDF. Citation status is verified only if every selected entry gets a sourced verified/corrected verdict; otherwise partial or unverified. paper_audit_status/result/stop and paper_verify_status/result/stop use the returned reportId.\n\npaper_revise is creator-only; mode omitted or citation keeps the completed verification-parent path and forbids notes. mode operator-notes requires nonblank well-formed notes (at most 32 KiB UTF-8, no NUL), accepts only a completed clean settled paper-source parent or frozen stitched manuscript (planReportId + finalSectionReportId), archives notes privately without default delivery and requests no citation verification. Notes guide requested edits and necessary adjacent repairs only, never authenticate identity or authorize fabricated verification claims, global style/gap-fill or new mathematics. Both modes return proposal-only edits; editorial-only scope is not mechanically established. In citation mode, paper_revise is creator-only and accepts only a completed, settled, clean reference-verification report, never a revision. Complete patch blocks are processed in order: empty, unchanged, missing, ambiguous or overlapping edits are individually skipped; malformed structure and whole-document/resource gates still reject the response. A new immutable reviewable proposal is produced only when final bytes change. Otherwise paper_revision_result returns no_edits_applied with bounded revisionOutcome diagnostics, proposalProduced:false and no files; repeating result never reruns the model. It never publishes a canonical paper or modifies the parent. paper_revision_status/result/stop use the child reportId. Inherited provenance is hash-bound, archive-only and not revalidated: all mapping labels remain unresolved for edited TeX; none are reusable. The bounded nonexpanding citation scan is syntactic-only literal-key membership in all inherited ledger sections; flagged or incomplete coverage is not verification, and a clean scan certifies neither source identity nor mathematical use. Detailed provenance and citation-scan diagnostics appear only in new REVISION_PROPOSAL.json artifacts; revisionOutcome exposes only bounded counts and skipped-edit reasons. Citation judgment is inherited, not a judgment on revised text; mathematics is unreviewed and compilation not-run. Citation-only scope and mathematical preservation are not certified.',
  gm_add: 'Publish a finding to shared global memory (claim + evidence). Verifiable kinds (conclusion/example/counterexample/proof_attempt) require explicit evidence; judgments (plan/direction/obstacle/master_guidance/elaboration) do not. Define your symbols in glossary and reuse project terminology.',
  gm_search: 'BM25 over shared global-memory findings. Use to reuse others’ results, avoid duplicate work, and learn which paths already died.',
  fact_submit: 'The only way to write a fact. Runs the glossary-coverage check, calls the verifier, and writes the node IFF accepted. On reject, returns repair hints and writes nothing. Cite the returned `fact_id` in downstream proofs.\n\nOnce a verdict exists, the verification outcome is always recorded to global memory (kind `verification`): accept, reject, or accept-but-write-failed. `source_id` optionally links the global-memory finding being promoted. For published results, supply structured `external_refs` metadata; it is mutable and does not affect `fact_id`. Also include verifier-needed citations in the proof text because metadata is not sent to the verifier. After `pending`, end this turn and wait for verifier feedback; pending is not acceptance.',
  fact_search: 'BM25 search over the verified fact graph (statement, proof and glossary), rebuilt from fact files. Use it before proving to check whether a fact already exists and find verified facts relevant to your subgoal, so you can cite their `fact_id`. Returns ranked `{fact_id, score, statement}` results.',
  fact_revoke: 'Cascade-revoke a wrong fact and everything that depends on it. Destructive; operator or project main only.',
  search_arxiv_theorems: 'Semantic search over arXiv theorem statements (Matlas). Returns verbatim, as-published theorem, lemma and definition statements; statement fidelity matters for mathematical reasoning and citation checking. Phrase the query as a complete mathematical statement when possible. Ranked results contain title, full theorem text, arxiv_id and in-paper theorem_id. External HTTP, no auth; on outage returns error and empty results (retry or use built-in web search). Results are literature leads, not full-source verification.',
  math_assign: 'Only the bound main may supply task once during assignment. This does not start a long-running strategy loop; the backend checks role and phase.',
  math_local_memory: 'Bound worker only: read or append private notes. Project logical-worker memory persists across runs; legacy research memory is private to one run. read accepts no text; append requires text. File paths, project overrides and author or identity overrides are not accepted.',
  math_verification_report: 'Only the bound verifier may write a report to its own fixed report location; path/id are not accepted. correct requires no errors/gaps and empty repair hints; wrong requires issues and nonempty repair hints. The backend still strictly validates the report; it does not directly authorize fact insertion.',
};
const refusalMessages = {
  'restart-enumeration': 'The fact-index observation changed. Discard all accumulated pages and restart from the first page; never mix snapshots. This diagnostic does not establish write settlement or cleanup.',
  'fix-request': 'The fact-page cursor is invalid. Correct the request or restart from the first page using the returned cursor unchanged. This is not an empty graph or a successful request.',
  'reduce-response-scope': 'The facade response exceeded its limit. Use bounded listing pages or reduce a search limit where appropriate; fact_search is not complete enumeration. Do not truncate complete proofs or omit mathematically required data. Report the failure if a full fact cannot be delivered; no automatic retry or cleanup was performed.',
  'report-capacity': 'The indicated file or storage resource exceeded a capacity check. Report the affected category; the request did not complete and this is not an empty graph. Measurements describe the refusal, not current free space or write/cleanup certainty. Do not automatically retry, revoke facts, delete history or unknown records, reset the project, or omit mathematically required data.',
};
function toolError(cause) {
  const runtime = runtimeDiagnostics(cause);
  const error = { code: safeCode(cause), message: safeCode(cause) === 'SUBMISSION_CORE_BUSY'
    ? 'This preparation did not execute in Core and did not register a candidate. The same worker, if still active, may explicitly retry its submission. No automatic replay was performed.'
    : 'The research tool request did not complete; no identity, model or permission fallback was used.', ...(runtime ? { runtime } : {}) };
  // Project wrappers carry the original in-memory runtime DTO, not a branded
  // replacement Error. Never promote a nested/late rejection over another code.
  const primaryCode = cause && !isProxy(cause) ? Object.getOwnPropertyDescriptor(cause, 'code')?.value : null;
  const rejection = primaryCode === 'RESEARCH_RUNTIME_REJECTED' && error.code === primaryCode ? runtimeRejectionInfo(runtime) : null;
  if (rejection) {
    error.rejection = rejection;
    error.message = refusalMessages[rejection.suggestedAction] + (runtime?.indeterminate === true
      ? ' runtime.indeterminate is true: a mutation may already have taken effect; reconcile state before any retry.' : '');
  }
  if (cause?.resultCleanup) {
    const cleanup = cause.resultCleanup, secondary = cleanup.error;
    const diagnostic = secondary ? runtimeDiagnostics(secondary) : null;
    error.resultCleanup = { confirmed: typeof cleanup.confirmed === 'boolean' ? cleanup.confirmed : null,
      error: secondary ? { code: safeCode(secondary), ...(diagnostic ? { runtime: diagnostic } : {}) } : null };
  }
  return error;
}
function pendingReviewError(cause, args, toolName = 'math_goal') {
  if (cause === null || typeof cause !== 'object' || isProxy(cause)
    || Object.getOwnPropertyDescriptor(cause, 'code')?.value !== 'MAIN_CONTROL_DUE_UNACKNOWLEDGED') return null;
  // Only this named wait error may expose a narrow same-call DTO. Never spread
  // Error/ctx, execute payload getters, or forward a service-provided message.
  const error = { code: 'MAIN_CONTROL_DUE_UNACKNOWLEDGED',
    message: `Wait requires all pending reviews to be acknowledged. Read ${toolName} status, perform the substantive reviews, then acknowledge the exact current due points before retrying wait.` };
  const pending = Object.getOwnPropertyDescriptor(cause, 'pendingReview')?.value;
  const keys = ['projectId', 'goalId', 'generation', 'controlAt', 'auditAt'];
  if (!plain(pending) || Reflect.ownKeys(pending).length !== keys.length) return error;
  const values = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(pending, key);
    if (!field || !Object.hasOwn(field, 'value')) return error;
    values[key] = field.value;
  }
  const point = value => value === null || Number.isSafeInteger(value) && value >= 0;
  if (typeof values.projectId !== 'string' || !/^project-[a-z0-9][a-z0-9-]{0,59}$/.test(values.projectId)
    || typeof values.goalId !== 'string' || !/^goal-[a-z0-9][a-z0-9-]{0,59}$/.test(values.goalId)
    || !Number.isSafeInteger(values.generation) || values.generation < 1
    || values.projectId !== args.projectId || values.goalId !== args.goalId || values.generation !== args.generation
    || !point(values.controlAt) || !point(values.auditAt) || values.controlAt === null && values.auditAt === null) return error;
  error.message = `Perform the substantive pending reviews, then call ${toolName} acknowledge with the exact goalId, generation and non-null controlAt/auditAt below before retrying wait; do not acknowledge work not performed.`;
  error.pendingReview = values;
  return error;
}
function failed(value) {
  return value.ok === false || value.success === false || value.failed === true || value.indeterminate === true
    || (Object.hasOwn(value, 'error') && value.error !== null && value.error !== false && value.error !== '')
    || (Object.hasOwn(value, 'write_error') && value.write_error !== null && value.write_error !== false && value.write_error !== '')
    || ['failed', 'error', 'invalid', 'incomplete', 'missing', 'interrupted', 'timed-out', 'indeterminate'].some((state) => value.state === state || value.status === state)
    || value.verdict === 'error' || (value.accepted === true && (typeof value.fact_id !== 'string' || !FID.test(value.fact_id) || value.pending === true));
}
function reply(value, isError = false) { return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, isError }; }
const reportReads = new Map([
  ['summary_status', ['summary', false]], ['summary_result', ['summary', true]],
  ['paper_status', ['paper-source', false]], ['paper_result', ['paper-source', true]],
  ['paper_audit_status', ['reference-audit', false]], ['paper_audit_result', ['reference-audit', true]],
  ['paper_verify_status', ['reference-verification', false]], ['paper_verify_result', ['reference-verification', true]],
  ['paper_revision_status', ['paper-revision', false]], ['paper_revision_result', ['paper-revision', true]],
  ['paper_plan_status', ['paper-plan', false]], ['paper_plan_result', ['paper-plan', true]],
  ['paper_section_status', ['paper-section', false]], ['paper_section_result', ['paper-section', true]],
  ['paper_verify_math_status', ['paper-math-verification', false]], ['paper_verify_math_result', ['paper-math-verification', true]],
]);
function reportReadReply(input, value) {
  const read = reportReads.get(input.action);
  if (!read) return null;
  const [kind, isResult] = read;
  const matchingIdentity = value.projectId === input.projectId && value.reportId === input.reportId
    && (value.kind === kind || kind === 'summary' && !Object.hasOwn(value, 'kind'));
  if (Object.hasOwn(value, 'readError') || isResult && value.status === 'delivery-failed') {
    check(matchingIdentity, 'RESEARCH_RESULT_INVALID');
    return reply(value, true);
  }
  if (!['failed', 'stopped', 'interrupted'].includes(value.state)) return null;
  const { state, error, status, ...operation } = value;
  const matchingReport = matchingIdentity && (value.taskId === null || typeof value.taskId === 'string' && value.taskId.length > 0)
    && typeof value.cleanupPending === 'boolean' && ['pending', 'unknown', 'confirmed'].includes(value.taskSettlement)
    && (error === null || typeof error === 'string' && /^[A-Z0-9_]{1,96}$/.test(error));
  const historicalRead = isResult
    ? kind !== 'summary' && ['failed', 'flagged'].includes(status) && value.saved === true && Array.isArray(value.files) && value.files.length === 0
      && plain(value.diagnosis) && typeof value.diagnosis.responseSaved === 'boolean' && value.diagnosis.error === error
    : status === undefined && value.saved !== false;
  // Only the report's historical state/error/status are exempt; any other
  // current-operation error signal retains the generic failure behavior.
  if (matchingReport && historicalRead && !failed(operation)) return reply(value);
  if (failed(value)) return reply(value, true);
  check(false, 'RESEARCH_RESULT_INVALID');
}
function factResult(value, input, projectScoped = false) {
  check(plain(value) && (projectScoped ? value.projectId === input.projectId && !Object.hasOwn(value, 'runId') : value.runId === input.runId), 'FACT_RESULT_INVALID');
  if (projectScoped) id(value.projectId);
  if (!input.factId) {
    if (value.projectId === null) {
      check(!projectScoped && Array.isArray(value.facts) && value.facts.length === 0 && value.page === null && !Object.hasOwn(input, 'cursor'), 'FACT_RESULT_INVALID');
    } else {
      id(value.projectId);
      validateFactPage({ facts: value.facts, page: value.page }, value.projectId, pageOptions(input));
    }
    return;
  }
  id(value.projectId);
  const fact = value.fact;
  check(plain(fact) && fact.fact_id === input.factId, 'FACT_RESULT_INVALID'); predecessors(fact.predecessors);
  string(fact.markdown, TOTAL, true);
  check(fact.markdown.startsWith(`---\nfact_id: ${fact.fact_id}\n`), 'FACT_HEADER_MISMATCH');
  const lines = fact.markdown.split('\n'); const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  check(end > 1 && lines[end] === '---', 'FACT_HEADER_MISMATCH'); const header = lines.slice(1, end);
  check(header.filter((line) => line.startsWith('fact_id:')).length === 1
    && header.filter((line) => line.startsWith('predecessors:')).length === 1
    && header.filter((line) => /^predecessors:\s*\[.*\]\s*$/.test(line.trim())).length === 1
    && header.includes(`predecessors: [${fact.predecessors.join(', ')}]`), 'FACT_HEADER_MISMATCH');
}
function inFlight(map, key, fn) {
  if (map.has(key)) return map.get(key);
  const job = Promise.resolve().then(fn); map.set(key, job);
  job.finally(() => { if (map.get(key) === job) map.delete(key); }).catch(() => {});
  return job;
}

/** Register only: the parent owns service creation, grants, registry and lifetime. */
export async function registerMathResearch(sdk, researchService, projects) {
  check(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection'].every((name) => typeof researchService?.[name] === 'function'), 'RESEARCH_SERVICE_REQUIRED');
  check(projects === undefined || ['create', 'list', 'status', 'assign', 'start', 'stop', 'result', 'invoke', 'handles', 'goal', 'mainGoal'].every((name) => typeof projects?.[name] === 'function'), 'PROJECT_SERVICE_REQUIRED');
  const store = createContextStore(sdk.dataDir);
  const files = new Map(), deliveries = new Map(), delivered = new Map();
  const stageFileDenials = new WeakSet();
  const registrations = []; let disposed = false;
  async function fileFor(value, projectScoped) {
    const bytes = Buffer.from(value.fact.markdown, 'utf8'); const sha256 = digest(bytes);
    const directory = projectScoped ? `research/project-exports/${value.projectId}` : `research/exports/${value.projectId}/${value.runId}`;
    const name = `${value.fact.fact_id}-${sha256}.md`;
    return exportFile(directory, name, bytes, sha256);
  }
  async function exportFile(directory, name, bytes, sha256) {
    const relative = `${directory}/${name}`;
    await inFlight(files, relative, async () => {
      await store.mkdir(directory);
      try { await store.write(relative, bytes); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    });
    await store.mkdir(directory); // Recheck every ancestor before opening a reused export.
    const handle = await fs.open(store.absolute(relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat(), size = bytes.length;
      check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size === size, 'FACT_EXPORT_CONFLICT');
      const buffer = Buffer.alloc(size + 1); // One extra byte detects growth without reading the whole file.
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      check(offset === size && digest(buffer.subarray(0, size)) === sha256, 'FACT_EXPORT_CONFLICT');
    } finally { await handle.close(); }
    return { path: store.absolute(relative), name, sha256, bytes: bytes.length };
  }
  async function exportFact(value, context, projectScoped) {
    string(context.callToken, SMALL, true); string(context.sessionPath, SMALL, true);
    const sha256 = digest(Buffer.from(value.fact.markdown, 'utf8'));
    // The service reauthorizes every request before this cache. The key uses only
    // the exact host-stamped origin, never an argument or a stored callToken.
    const key = JSON.stringify([context.sessionPath, value.projectId, projectScoped ? null : value.runId, value.fact.fact_id, sha256]);
    if (delivered.has(key)) return delivered.get(key);
    return inFlight(deliveries, key, async () => {
      const file = await fileFor(value, projectScoped);
      let receipt;
      try { receipt = await sdk.resources.stage({ path: file.path, name: file.name, mime: 'text/markdown', deliverAs: 'attachment' }); }
      catch (cause) {
        // Only this SDK call can diagnose the delivery capability; local export
        // writes and malformed receipts must never suggest granting it.
        if (isStageFileDenial(cause)) stageFileDenials.add(cause);
        throw cause;
      }
      const resource = receipt?.resource;
      check(plain(receipt) && !failed(receipt) && plain(resource) && resource.kind === 'session-file', 'FACT_STAGE_RECEIPT_INVALID');
      string(resource.fileId, SMALL, true); string(resource.sessionId, SMALL, true);
      const delivery = { fileId: resource.fileId, resource: { kind: 'session-file', fileId: resource.fileId, sessionId: resource.sessionId }, sha256: file.sha256, bytes: file.bytes };
      if (delivered.size >= 256) delivered.delete(delivered.keys().next().value);
      delivered.set(key, delivery); return delivery;
    });
  }
  async function exportStitch(stitch) {
    const { bytes, summary, sessionId, checkDelivery } = stitch;
    // Export only the established public summary, never internal stitch inputs.
    const publicKeys = ['projectId', 'paperId', 'planReportId', 'finalSectionReportId', 'chainRootReportId', 'sectionCount', 'sections',
      'bibliographyStatus', 'mathematicsStatus', 'citationStatus', 'compileStatus', 'limitations'];
    check(plain(summary), 'PROJECT_PAPER_STITCH_EXPORT_FAILED');
    const publicSummary = Object.fromEntries(publicKeys.flatMap(key => {
      const field = Object.getOwnPropertyDescriptor(summary, key);
      if (!field) return [];
      check(field.enumerable && Object.hasOwn(field, 'value'), 'PROJECT_PAPER_STITCH_EXPORT_FAILED');
      return [[key, field.value]];
    }));
    const verified = jsonValue(publicSummary, { maxText: TOTAL, maxTotal: 2 * TOTAL - 2 * SMALL - 1024, maxItems: 16384, maxDepth: 16 });
    id(verified.projectId);
    const sha256 = digest(bytes), failedExport = () => Object.assign(new Error('PROJECT_PAPER_STITCH_EXPORT_FAILED'), { code: 'PROJECT_PAPER_STITCH_EXPORT_FAILED' });
    let file;
    try { file = await exportFile(`research/project-exports/${verified.projectId}/paper-stitch/${sha256}`, 'main.tex', bytes, sha256); }
    catch { throw failedExport(); }
    await checkDelivery();
    try {
      const receipt = await sdk.resources.stage({ path: file.path, name: 'main.tex', mime: 'text/x-tex', deliverAs: 'attachment' });
      const resource = receipt?.resource;
      check(plain(receipt) && !failed(receipt) && plain(resource) && resource.kind === 'session-file'
        && resource.sessionId === sessionId, 'PROJECT_PAPER_STITCH_STAGE_INVALID');
      string(resource.fileId, SMALL, true); string(resource.sessionId, SMALL, true);
      return { ...verified, status: 'staged', fileName: 'main.tex', fileId: resource.fileId,
        resource: { kind: 'session-file', fileId: resource.fileId, sessionId: resource.sessionId }, sha256, bytes: file.bytes };
    } catch { throw failedExport(); }
  }
  async function exportDashboardSnapshot(snapshot) {
    const { bytes, summary, sessionId, checkDelivery } = snapshot;
    const { projectId, asOf, capturedAt, nodeCount, edgeCount } = summary;
    id(projectId); string(sessionId, SMALL, true);
    check(Buffer.isBuffer(bytes) && bytes.length <= (1 << 20), 'PROJECT_DASHBOARD_SNAPSHOT_TOO_LARGE');
    const sha256 = digest(bytes), name = 'factgraph.hanamathgraph';
    let file, receipt;
    try { file = await exportFile(`research/project-exports/${projectId}/dashboard-snapshot/${sha256}`, name, bytes, sha256); }
    catch { check(false, 'PROJECT_DASHBOARD_SNAPSHOT_EXPORT_FAILED'); }
    // Same creator reauthorized after disk I/O, immediately before Host staging.
    await checkDelivery();
    try { receipt = await sdk.resources.stage({ path: file.path, name, mime: 'application/vnd.hana-math.factgraph+json', deliverAs: 'attachment' }); }
    catch { check(false, 'PROJECT_DASHBOARD_SNAPSHOT_STAGE_FAILED'); }
    const resource = receipt?.resource;
    check(plain(receipt) && !failed(receipt) && plain(resource) && resource.kind === 'session-file' && resource.sessionId === sessionId
      && typeof resource.fileId === 'string' && !!resource.fileId && resource.fileId.length <= SMALL, 'PROJECT_DASHBOARD_SNAPSHOT_STAGE_INVALID');
    return { projectId, asOf, capturedAt, nodeCount, edgeCount, sha256, bytes: file.bytes,
      resource: { kind: 'session-file', sessionId, fileId: resource.fileId } };
  }
  async function exportGraph(snapshot, context) {
    string(context.callToken, SMALL, true); string(context.sessionPath, SMALL, true); id(snapshot.projectId);
    const { renderProjectGraph } = await import('./project-graph-renderer.mjs');
    const bytes = Buffer.from(renderProjectGraph(snapshot), 'utf8');
    check(bytes.length <= 2 * TOTAL, 'PROJECT_GRAPH_SIZE_LIMIT');
    const sha256 = digest(bytes), name = `fact-graph-${sha256}.html`;
    const file = await exportFile(`research/project-exports/${snapshot.projectId}`, name, bytes, sha256);
    const receipt = await sdk.resources.stage({ path: file.path, name, mime: 'text/html', deliverAs: 'attachment' });
    const resource = receipt?.resource;
    check(plain(receipt) && !failed(receipt) && plain(resource) && resource.kind === 'session-file', 'PROJECT_GRAPH_STAGE_UNCONFIRMED');
    string(resource.fileId, SMALL, true); string(resource.sessionId, SMALL, true);
    return { projectId: snapshot.projectId, asOf: snapshot.asOf, capturedAt: snapshot.capturedAt, previewOnly: true,
      facts: snapshot.facts.length, edges: snapshot.facts.reduce((n, f) => n + f.predecessors.length, 0),
      fileId: resource.fileId, resource: { kind: 'session-file', fileId: resource.fileId, sessionId: resource.sessionId }, sha256, bytes: bytes.length };
  }
  async function execute(name, raw) {
    try {
      check(!disposed, 'RESEARCH_TOOLS_DISPOSED');
      const { input, context } = invocation(raw);
      try { validate(name, input, projects !== undefined); }
      catch (cause) {
        // Only this post-invocation validation boundary is observable here. The
        // service must authorize the current worker entry before recording a code.
        // Host rejections are unobservable; failed invocation cannot be attributed.
        // A zero recorded count is not evidence of no submission attempt.
        if (name === 'fact_submit') {
          try { await researchService.recordSubmissionInputRejection(context, safeCode(cause)); }
          catch { /* The service owns persistence-failure latches; preserve the original input error. */ }
        }
        throw cause;
      }
      let value;
      if (name === 'math_research') {
        const { action, ...args } = input;
        if (action === 'run') value = await researchService.run(args, context);
        else if (action === 'status') value = await researchService.status(args.runId, context);
        else if (action === 'stop') value = await researchService.stop(args.runId, context);
        else if (action === 'setup_status') value = await researchService.setupStatus(args.runId, context);
        else if (action === 'set_tool_mode') value = await researchService.setToolMode(args.runId, args.role, args.toolMode, context);
        else value = await researchService.result(args.runId, args.factId, context, pageOptions(args));
      } else if (name === 'math_goal' || name === 'math_goal_main') {
        const { action, ...args } = input;
        try { value = await (name === 'math_goal_main' ? projects.mainGoal(action, args, context) : projects.goal(action, args, context)); }
        catch (cause) {
          const pending = action === 'wait' ? pendingReviewError(cause, args, name) : null;
          if (pending) return reply({ error: pending }, true);
          throw cause;
        }
      } else if (name === 'math_project') {
        const { action, ...args } = input;
        if (action === 'create') value = await projects.create(args, context);
        else if (action === 'operator_read') value = await projects.operatorRead(context);
        else if (action === 'operator_save') value = await projects.operatorSave(args, context);
        else if (action === 'list') value = await projects.list(context);
        else if (action === 'status') value = await projects.status(args.projectId, context);
        else if (action === 'ipc_usage') { check(typeof projects.ipcUsage === 'function', 'PROJECT_IPC_USAGE_UNAVAILABLE'); value = await projects.ipcUsage(args, context); }
        else if (action === 'doctor') { check(typeof projects.doctor === 'function', 'PROJECT_DOCTOR_UNAVAILABLE'); value = await projects.doctor(args, context); }
        else if (action === 'start') value = await projects.start(args, context);
        else if (action === 'stop') value = await projects.stop(args, context);
        else if (action === 'recheck') { check(typeof projects.recheck === 'function', 'PROJECT_RECHECK_UNAVAILABLE'); value = await projects.recheck(args, context); }
        else if (action === 'graph') {
          check(typeof projects.graph === 'function', 'PROJECT_GRAPH_UNAVAILABLE');
          const snapshot = await projects.graph(args, context);
          return reply(await exportGraph(snapshot, context));
        } else if (action === 'dashboard_snapshot') {
          check(typeof projects.dashboardSnapshot === 'function', 'PROJECT_DASHBOARD_SNAPSHOT_UNAVAILABLE');
          value = await exportDashboardSnapshot(await projects.dashboardSnapshot(args, context));
        } else if (action === 'dashboard_overview') {
          check(typeof projects.dashboardOverview === 'function', 'PROJECT_DASHBOARD_OVERVIEW_UNAVAILABLE');
          value = await projects.dashboardOverview(args, context);
        } else if (action === 'dashboard_follow') {
          check(typeof projects.dashboardFollow === 'function', 'PROJECT_DASHBOARD_FOLLOW_UNAVAILABLE');
          value = await projects.dashboardFollow({ projectId: args.projectId }, context);
        } else if (action === 'dashboard_unfollow') {
          check(typeof projects.dashboardUnfollow === 'function', 'PROJECT_DASHBOARD_UNFOLLOW_UNAVAILABLE');
          value = await projects.dashboardUnfollow({ projectId: args.projectId }, context);
        } else if (action === 'worker_models') {
          check(typeof projects.workerModels === 'function', 'PROJECT_WORKER_MODELS_UNAVAILABLE');
          value = await projects.workerModels(args, context);
        } else if (action === 'verification_reads') {
          check(typeof projects.verificationReads === 'function', 'PROJECT_READ_AUDIT_UNAVAILABLE');
          value = await projects.verificationReads(args, context);
        } else if (action === 'finalize') {
          check(typeof projects.finalize === 'function', 'PROJECT_FINALIZE_UNAVAILABLE');
          value = await projects.finalize(args, context);
        } else if (action === 'summary') {
          check(typeof projects.summary === 'function', 'PROJECT_SUMMARY_UNAVAILABLE');
          value = await projects.summary(args, context);
        } else if (action === 'summary_status') value = await projects.summaryStatus(args, context);
        else if (action === 'summary_result') value = await projects.summaryResult(args, context);
        else if (action === 'summary_stop') value = await projects.summaryStop(args, context);
        else if (action === 'paper_subgraph') {
          check(typeof projects.paperSubgraph === 'function', 'PROJECT_PAPER_UNAVAILABLE');
          value = await projects.paperSubgraph(args, context);
        } else if (action === 'paper') {
          check(typeof projects.paper === 'function', 'PROJECT_PAPER_UNAVAILABLE');
          value = await projects.paper(args, context);
        } else if (action === 'paper_stitch') {
          check(typeof projects.paperStitch === 'function', 'PROJECT_PAPER_STITCH_UNAVAILABLE');
          value = await exportStitch(await projects.paperStitch(args, context));
        } else if (action === 'paper_section' || action === 'paper_plan') {
          const section = action === 'paper_section', method = section ? 'paperSection' : 'paperPlan';
          check(typeof projects[method] === 'function', section ? 'PROJECT_PAPER_SECTION_UNAVAILABLE' : 'PROJECT_PAPER_PLAN_UNAVAILABLE');
          const pending = projects[method](args, context);
          try { value = await pending; }
          catch (cause) {
            const category = safeCode(cause) === 'RESEARCH_RUNTIME_CAPACITY' && typeof projects.paperStartIpcRefusal === 'function'
              ? projects.paperStartIpcRefusal(pending, cause) : null;
            if (!category) throw cause;
            return reply({ error: { ...toolError(cause), managedIpcRefusal: { source: 'current', category } } }, true);
          }
        } else if (action === 'paper_section_status') value = await projects.paperSectionStatus(args, context);
        else if (action === 'paper_section_result') value = await projects.paperSectionResult(args, context);
        else if (action === 'paper_section_stop') value = await projects.paperSectionStop(args, context);
        else if (action === 'paper_plan_status') value = await projects.paperPlanStatus(args, context);
        else if (action === 'paper_plan_result') value = await projects.paperPlanResult(args, context);
        else if (action === 'paper_plan_stop') value = await projects.paperPlanStop(args, context);
        else if (action === 'paper_status') value = await projects.paperStatus(args, context);
        else if (action === 'paper_result') value = await projects.paperResult(args, context);
        else if (action === 'paper_stop') value = await projects.paperStop(args, context);
        else if (action === 'paper_audit') value = await projects.paperAudit(args, context);
        else if (action === 'paper_audit_status') value = await projects.paperAuditStatus(args, context);
        else if (action === 'paper_audit_result') value = await projects.paperAuditResult(args, context);
        else if (action === 'paper_audit_stop') value = await projects.paperAuditStop(args, context);
        else if (action === 'paper_revise') value = await projects.paperRevise(args, context);
        else if (action === 'paper_revision_status') value = await projects.paperRevisionStatus(args, context);
        else if (action === 'paper_revision_result') value = await projects.paperRevisionResult(args, context);
        else if (action === 'paper_revision_stop') value = await projects.paperRevisionStop(args, context);
        else if (action === 'paper_verify') value = await projects.paperVerify(args, context);
        else if (action === 'paper_verify_status') value = await projects.paperVerifyStatus(args, context);
        else if (action === 'paper_verify_result') value = await projects.paperVerifyResult(args, context);
        else if (action === 'paper_verify_stop') value = await projects.paperVerifyStop(args, context);
        else if (action === 'paper_verify_math') value = await projects.paperVerifyMath(args, context);
        else if (action === 'paper_verify_math_status') value = await projects.paperVerifyMathStatus(args, context);
        else if (action === 'paper_verify_math_result') value = await projects.paperVerifyMathResult(args, context);
        else if (action === 'paper_verify_math_stop') value = await projects.paperVerifyMathStop(args, context);
        else if (action === 'paper_deliver') {
          check(typeof projects.paperDeliver === 'function', 'PROJECT_PAPER_DELIVERY_UNAVAILABLE');
          value = await projects.paperDeliver(args, context);
        } else if (action === 'paper_chapter_tree_stitch') {
          check(typeof projects.paperChapterTreeStitch === 'function', 'PROJECT_PAPER_TREE_UNAVAILABLE');
          value = await projects.paperChapterTreeStitch(args, context);
        } else value = await projects.result(args, context);
      } else {
        // handles is routing only, never authorization. A denial or unknown route
        // result cannot fall back to the legacy authority path.
        const handled = projects && PROJECT_MAIN_TOOLS.has(name) ? await projects.handles(context) : false;
        check(typeof handled === 'boolean', 'PROJECT_ROUTE_INVALID');
        if (handled) value = name === 'math_assign' ? await projects.assign(input, context) : await projects.invoke(name, input, context);
        else { if (name === 'math_assign') validate(name, input); value = await researchService.invoke(name, input, context); }
      }
      value = jsonValue(value, { maxText: TOTAL, maxTotal: 2 * TOTAL, maxItems: 16384, maxDepth: 16 });
      check(plain(value), 'RESEARCH_RESULT_INVALID');
      // A failed historical run is still a successful status query, not an RPC failure.
      if (['math_research', 'math_project', 'math_goal', 'math_goal_main'].includes(name) && input.action === 'status'
        || name === 'math_project' && input.action === 'doctor') return reply(value);
      if (name === 'math_research' && input.action === 'set_tool_mode' && value.saved === false) return reply(value, true);
      if (name === 'math_project') {
        if (paperMathActions.includes(input.action)) {
          const started = input.action === 'paper_verify_math';
          check(value.projectId === input.projectId && typeof value.reportId === 'string' && new RegExp(paperReportIdSchema.pattern).test(value.reportId)
            && (started ? (!Object.hasOwn(value, 'kind') || value.kind === 'paper-math-verification') && value.state === 'queued'
              && ![input.reportId, input.planReportId, input.finalSectionReportId].includes(value.reportId)
              : value.kind === 'paper-math-verification' && value.reportId === input.reportId), 'RESEARCH_RESULT_INVALID');
        }
        const reportRead = reportReadReply(input, value);
        if (reportRead) return reportRead;
      }
      if (failed(value)) return reply(value, true);
      if (['math_research', 'math_project'].includes(name) && input.action === 'result') {
        const projectScoped = name === 'math_project';
        factResult(value, input, projectScoped);
        if (input.factId) {
          try {
            const delivery = structuredClone(await exportFact(value, context, projectScoped));
            const fact = { ...value.fact };
            if (Buffer.byteLength(fact.markdown) > 16384) delete fact.markdown;
            return reply({ ...value, fact, fact_id: fact.fact_id, predecessors: fact.predecessors, ...delivery, fullTextInFile: true });
          } catch (cause) {
            const capabilityDenied = stageFileDenials.has(cause);
            return reply({ ...(!projectScoped ? { runId: value.runId } : {}), projectId: value.projectId, fact_id: value.fact.fact_id, predecessors: value.fact.predecessors,
              error: { code: 'FACT_EXPORT_FAILED', cause: safeCode(cause), ...(capabilityDenied ? {
                requiredCapability: STAGE_FILE_CAPABILITY,
                message: 'The complete fact was not modified. Attachment delivery failed because permission was denied. Ask the user to authorize app/session.stage-file for Hana Math on the App Capabilities page in Hana settings, then retry result.',
              } : { message: 'The complete fact was not modified. Attachment delivery is unconfirmed; retry result.' }) }, delivery: 'failed', factUnchanged: true }, true);
          }
        }
      }
      // Do not turn queued/pending, a wrong verdict or finished into accepted:true.
      return reply(value);
    } catch (cause) { return reply({ error: toolError(cause) }, true); }
  }
  async function dispose() {
    if (disposed) return; disposed = true; delivered.clear();
    const results = await Promise.allSettled(registrations.map((registration) => Promise.resolve().then(registration)));
    const rejected = results.find((result) => result.status === 'rejected'); if (rejected) throw rejected.reason;
  }
  try {
    const registeredSchemas = projects ? { ...schemas, math_assign: obj({ task: str(128 * 1024, true), workerId: idSchema, ...dispatchProperties,
      displayTitle: { type: 'string', description: WORKER_DISPLAY_TITLE_GUIDANCE } }, ['task']), math_project: projectSchema, math_goal: goalSchema, math_goal_main: mainGoalSchema } : schemas;
    for (const [name, parameters] of Object.entries(registeredSchemas)) {
      const description = projects && name === 'math_assign'
        ? 'Only the bound main may assign a task. A project main may specify workerId; omission selects worker-1 only in a single-worker project. Multiple workers require workerId (PROJECT_WORKER_REQUIRED). Optional model {provider,id} and thinkingLevel replace the pending dispatch for this assignment; omission clears previous choices. Start overrides individual supplied fields and inherits the others. Explicit thinking must match the selected model support and requires a persistent hard grant. Assignment does not start research. ' + WORKER_DISPLAY_TITLE_GUIDANCE
        : descriptions[name] + (name === 'math_research' ? ' Without factId, result returns preview-only pages. Continue with nextCursor; never mix different asOf observations. Use factId for a complete proof.'
          : name === 'math_project' ? ' operator_read shows the shared local App profile and its six question fields. If it is empty, ask about the fields one at a time in ordinary conversation; do not infer answers. Use operator_save only for the user’s own explicit answers they have explicitly agreed to share across authorized conversations in this local App and with Main and Worker in future projects. Never save credentials, secrets or chat history. operator_save patches only supplied answers; null removes an answer. spendWarningUsd is a USD warning only, not a spending cap or stop. Neither action starts research. Future create snapshots those answers only when operatorProfile is omitted; existing projects are not changed. paper_verify_math is creator-only: select a completed paper-source, settled revision proposal (proposal.tex), settled reference-verification, or paper-chapter-tree by reportId, or a frozen stitched manuscript by planReportId and finalSectionReportId. Use paper_verify_math_status, paper_verify_math_result or paper_verify_math_stop with the child reportId. The result attaches only MATH_REVIEW.json. This is mathematical review evidence, not mechanical proof verification, citation verification, compilation or publication. paper_revise also supports mode="gap-fill" (closing must-fix findings from a wrong math review using only verified factIds, or returning needs_research when factIds is empty with missingBacking) and mode="compile-fix" (minimal LaTeX fixes from compileLog only). paper_deliver is creator-only: checks exact same-version binding between a manuscript and its settled MATH_REVIEW.json, blocks wrong verdicts unless override:{reason} is supplied (which injects a visible disclosure note on the delivered copy without mutating the archive), records ignorable findings, checks optional TeX compile evidence honestly (reporting compileStatus="not-run" when uncompiled; allowUncompiledTex:true stages TeX and manifest only), and never authorizes external push. paper_chapter_tree_stitch is creator-only: mechanically assembles a host manuscript and dependency-ordered chapter manuscripts with label namespacing, preamble/macro/hyperref checks, host pointer-proof replacement, cited-only bibliography filtering and optional operator-confirmed style rules into an immutable paper-chapter-tree report for downstream audit, revision, math review and delivery. Report reads may return historical failures without a tool error; check state, status and archiveError. Current validation and incomplete export remain tool errors.' : '');
      const registration = await sdk.tools.register({ name, description, parameters: structuredClone(parameters),
        ...(name === 'math_goal_main' ? { sessionPermission: structuredClone(MAIN_GOAL_PERMISSION) } : {}),
        async execute(args) { return execute(name, args); } });
      check(typeof registration === 'function', 'TOOL_REGISTRATION_INVALID'); registrations.push(registration);
    }
  } catch (cause) { try { await dispose(); } catch {} throw cause; }
  return { registrations, dispose };
}
