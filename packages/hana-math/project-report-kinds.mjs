// Pure kind contracts only. Authorization, binding, bytes and lifecycle stay in the service.
import { validPaperRevisionOutcome } from './paper-revision.mjs';
import { snapshotPaperRevisionStart } from './paper-revision-input.mjs';
import { validPlan, planHash } from './paper-plan.mjs';
import { snapshotPaperSectionStart } from './paper-section-input.mjs';
import { validSectionBinding } from './paper-section-binding.mjs';
import { snapshotPlanData } from './paper-plan-input.mjs';
import { PAPER_MATH_PINS } from './paper-math-verification.mjs';
export const REPORT_ID = /^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const paperId = v => /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
const sha256 = v => /^[a-f0-9]{64}$/.test(v);
const allSelectorKeys = ['sourceReportId', 'revisionReportId', 'verificationReportId', 'chapterTreeReportId', 'planReportId', 'finalSectionReportId'];
const manuscriptSelectors = [['sourceReportId'], ['revisionReportId'], ['chapterTreeReportId'], ['planReportId', 'finalSectionReportId']];
const notesSelectors = [['sourceReportId'], ['chapterTreeReportId'], ['planReportId', 'finalSectionReportId']];
const compileFixSelectors = [['sourceReportId'], ['revisionReportId'], ['chapterTreeReportId'], ['planReportId', 'finalSectionReportId']];
function matchSelector(value, allowed, ignore = []) {
  if (!object(value)) return null;
  const present = allSelectorKeys.filter(key => !ignore.includes(key) && Object.hasOwn(value, key));
  return allowed.find(fields => present.length === fields.length
    && fields.every(key => typeof value[key] === 'string' && REPORT_ID.test(value[key]))) ?? null;
}
function pickSelector(value, allowed, ignore = []) {
  const fields = matchSelector(value, allowed, ignore);
  return fields ? Object.fromEntries(fields.map(key => [key, value[key]])) : {};
}
const auditBaseKeys = ['paperId', 'mainSha256', 'ledgerSha256', 'contractSha256', 'boundContractSha256',
  'auditorPromptSha256', 'boundAuditorPromptSha256', 'promptSha256', 'boundPromptSha256'];
const verificationBaseKeys = ['auditReportId', 'paperId', 'mainSha256', 'ledgerSha256', 'auditSha256',
  'contractSha256', 'boundContractSha256', 'verifierPromptSha256', 'boundVerifierPromptSha256', 'promptSha256', 'boundPromptSha256', 'keys'];
const revisionHashes = ['mainSha256', 'verdictsSha256', 'ledgerSha256', 'originalLedgerSha256', 'provenanceSha256',
  'contractSha256', 'reviserPromptSha256', 'styleSha256', 'promptSha256'];
const revisionBaseKeys = ['verificationReportId', 'paperId', 'citationStatus', 'sourceStatus', ...revisionHashes];
const notesHashes = ['mainSha256', 'ledgerSha256', 'provenanceSha256', 'notesSha256', 'contractSha256', 'reviserPromptSha256', 'styleSha256', 'promptSha256'];
const notesBaseKeys = ['mode', 'paperId', 'sourceStatus', 'notesBytes', ...notesHashes];
const gapFillHashes = ['mainSha256', 'ledgerSha256', 'originalLedgerSha256', 'provenanceSha256', 'notesSha256', 'factsSha256', 'mathReviewSha256',
  'contractSha256', 'reviserPromptSha256', 'styleSha256', 'promptSha256'];
const gapFillBaseKeys = ['mode', 'mathReviewReportId', 'paperId', 'sourceStatus', 'notesBytes', 'factIds', 'missingBacking', ...gapFillHashes];
const compileFixHashes = ['mainSha256', 'ledgerSha256', 'provenanceSha256', 'compileLogSha256', 'contractSha256', 'reviserPromptSha256', 'styleSha256', 'promptSha256'];
const compileFixBaseKeys = ['mode', 'paperId', 'sourceStatus', 'compileLogBytes', ...compileFixHashes];
const mathSelectors = [['sourceReportId'], ['planReportId', 'finalSectionReportId'], ['revisionReportId'], ['verificationReportId'], ['chapterTreeReportId']];
const mathHashes = ['mainSha256', 'ledgerSha256', 'contractSha256', 'verifierPromptSha256', 'promptSha256'];
function mathShape(value, bound = false) {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  return mathSelectors.map(selector => bound ? [...selector, ...mathHashes] : selector).find(fields => keys.length === fields.length
    && fields.every(key => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field?.enumerable === true && typeof field.value === 'string'
        && (mathHashes.includes(key) ? sha256(field.value) : REPORT_ID.test(field.value));
    })) ?? null;
}
function mathBinding(value) {
  const fields = mathShape(value, true);
  return fields && value.contractSha256 === PAPER_MATH_PINS.contractSha256
    && value.verifierPromptSha256 === PAPER_MATH_PINS.verifierPromptSha256 ? fields : null;
}
function copyMathBinding(value) {
  const fields = mathBinding(value);
  if (!fields) throw Object.assign(new Error('PROJECT_INVALID_INPUT'), { code: 'PROJECT_INVALID_INPUT' });
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}
function validNotesRevision(meta) {
  const r = meta.revision, sel = matchSelector(r, notesSelectors);
  const expected = sel ? [...sel, ...notesBaseKeys] : null;
  return Boolean(expected) && Object.keys(r).length === expected.length && expected.every(key => Object.hasOwn(r, key))
    && r.mode === 'operator-notes'
    && typeof r.paperId === 'string' && paperId(r.paperId) && ['generated', 'flagged'].includes(r.sourceStatus)
    && notesHashes.every(key => typeof r[key] === 'string' && sha256(r[key]))
    && Number.isSafeInteger(r.notesBytes) && r.notesBytes > 0 && r.notesBytes <= 32 * 1024
    // Partial archive/admission failures must remain loadable for cleanup; run checks bytes before any model.
    && (meta.state !== 'completed' || (Object.hasOwn(meta, 'revisionOutcome') && object(meta.artifacts?.notes) && meta.artifacts.notes.name === 'OPERATOR_NOTES.md'
      && meta.artifacts.notes.bytes === r.notesBytes && meta.artifacts.notes.sha256 === r.notesSha256));
}
function validGapFillRevision(meta) {
  const r = meta.revision, sel = matchSelector(r, mathSelectors);
  const expected = sel ? [...sel, ...gapFillBaseKeys] : null;
  return Boolean(expected) && Object.keys(r).length === expected.length && expected.every(key => Object.hasOwn(r, key))
    && r.mode === 'gap-fill' && typeof r.mathReviewReportId === 'string' && REPORT_ID.test(r.mathReviewReportId)
    && typeof r.paperId === 'string' && paperId(r.paperId) && ['generated', 'flagged'].includes(r.sourceStatus)
    && gapFillHashes.every(key => typeof r[key] === 'string' && sha256(r[key]))
    && Number.isSafeInteger(r.notesBytes) && r.notesBytes > 0 && r.notesBytes <= 32 * 1024
    && Array.isArray(r.factIds) && r.factIds.length >= 1 && r.factIds.length <= 16
    && r.factIds.every(id => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id)) && new Set(r.factIds).size === r.factIds.length
    && Array.isArray(r.missingBacking) && r.missingBacking.length <= 16
    && r.missingBacking.every(s => typeof s === 'string' && s.isWellFormed() && !s.includes('\0') && s.trim().length > 0 && Buffer.byteLength(s) <= 1024)
    && (meta.state !== 'completed' || (Object.hasOwn(meta, 'revisionOutcome') && object(meta.artifacts?.notes) && meta.artifacts.notes.name === 'OPERATOR_NOTES.md'
      && meta.artifacts.notes.bytes === r.notesBytes && meta.artifacts.notes.sha256 === r.notesSha256));
}
function validCompileFixRevision(meta) {
  const r = meta.revision, sel = matchSelector(r, compileFixSelectors);
  const expected = sel ? [...sel, ...compileFixBaseKeys] : null;
  return Boolean(expected) && Object.keys(r).length === expected.length && expected.every(key => Object.hasOwn(r, key))
    && r.mode === 'compile-fix'
    && typeof r.paperId === 'string' && paperId(r.paperId) && ['generated', 'flagged'].includes(r.sourceStatus)
    && compileFixHashes.every(key => typeof r[key] === 'string' && sha256(r[key]))
    && Number.isSafeInteger(r.compileLogBytes) && r.compileLogBytes > 0 && r.compileLogBytes <= 32 * 1024
    && (meta.state !== 'completed' || (Object.hasOwn(meta, 'revisionOutcome') && object(meta.artifacts?.compileLog) && meta.artifacts.compileLog.name === 'COMPILE_LOG.txt'
      && meta.artifacts.compileLog.bytes === r.compileLogBytes && meta.artifacts.compileLog.sha256 === r.compileLogSha256));
}
function validCitationRevision(meta) {
  const r = meta.revision, sel = matchSelector(r, manuscriptSelectors, ['verificationReportId']);
  const expected = sel ? [...sel, ...revisionBaseKeys] : null;
  return Boolean(expected) && Object.keys(r).length === expected.length && expected.every(key => Object.hasOwn(r, key))
    && typeof r.verificationReportId === 'string' && REPORT_ID.test(r.verificationReportId)
    && typeof r.paperId === 'string' && paperId(r.paperId) && revisionHashes.every(key => typeof r[key] === 'string' && sha256(r[key]))
    && ['unverified', 'partial', 'verified'].includes(r.citationStatus) && ['generated', 'flagged'].includes(r.sourceStatus);
}
function validRevisionOutcomeRecord(meta) {
  // Absence is legacy, never synthesized. Explicit null or malformed data is not legacy.
  if (!Object.hasOwn(meta, 'revisionOutcome')) return true;
  const outcome = meta.revisionOutcome;
  if (!validPaperRevisionOutcome(outcome)) return false;
  if (outcome.status === 'proposal') return meta.state !== 'completed' || (['generated', 'flagged'].includes(meta.sourceStatus)
    && object(meta.artifacts) && object(meta.artifacts.source) && object(meta.artifacts.proposal)
    && typeof meta.sha256 === 'string' && sha256(meta.sha256) && Number.isSafeInteger(meta.bytes) && meta.bytes > 0
    && meta.artifacts.source.sha256 === meta.sha256 && meta.artifacts.source.bytes === meta.bytes);
  const allowed = ['operator-notes', 'gap-fill'].includes(meta.revision?.mode) ? ['response', 'notes']
    : meta.revision?.mode === 'compile-fix' ? ['response', 'compileLog'] : ['response'];
  if (!object(meta.artifacts) || !object(meta.artifacts.response) || Object.keys(meta.artifacts).some(key => !allowed.includes(key))
    || ['artifact', 'publishedArtifact', 'publishedSha256', 'publishedBytes'].some(key => Object.hasOwn(meta, key))) return false;
  // Computed diagnostics may survive interruption/failure; only a clean completed record is a successful no-op.
  return meta.state !== 'completed' || (meta.sourceStatus === 'not-produced' && meta.sha256 === null && meta.bytes === null
    && Number.isSafeInteger(meta.completedAt) && meta.completedAt >= 0 && !meta.error
    && meta.cleanupPending === false && meta.stopRequested === false && meta.writerStarting === false
    && meta.taskCreating === false && meta.scheduleCreating === false);
}
const specs = Object.freeze({
  'paper-math-verification': Object.freeze({
    label: 'Whole-paper mathematical review',
    startValid: args => args.language === 'English' && Object.hasOwn(args, 'math')
      && Reflect.ownKeys(args).every(key => ['kind', 'projectId', 'language', 'math'].includes(key)) && Boolean(mathShape(args.math)),
    persistedValid: (meta, projectId) => meta.language === 'English' && meta.projectId === projectId && Boolean(mathBinding(meta.math))
      && (meta.state === 'completed' ? ['correct', 'wrong'].includes(meta.mathVerdict)
        : !Object.hasOwn(meta, 'mathVerdict') || meta.mathVerdict === null),
    recordFields: binding => ({ kind: 'paper-math-verification', math: copyMathBinding(binding) }),
    taskFields: meta => ({ kind: 'paper-math-verification', ...copyMathBinding(meta.math) }),
    artifactNames: Object.freeze({ response: 'raw-response.txt', review: 'MATH_REVIEW.json' }),
    deliveredRoles: Object.freeze(['review']),
  }),
  'paper-section': Object.freeze({
    label: 'Math paper section fragment',
    startValid: (args, projectId) => { const input = snapshotPaperSectionStart(args); return input.projectId === undefined || input.projectId === projectId; },
    persistedValid: (meta, projectId) => meta.language === 'English' && meta.projectId === projectId && validSectionBinding(meta.section, projectId, meta.reportId),
    recordFields: payload => ({ kind: 'paper-section', section: snapshotPlanData(payload) }),
    taskFields: meta => ({ kind: 'paper-section', planReportId: meta.section.source.planReportId, sectionIndex: meta.section.material.sectionIndex,
      chainRootReportId: meta.section.lineage.chainRootReportId, sectionBindingSha256: planHash(JSON.stringify(meta.section)) }),
    artifactNames: Object.freeze({ response: 'raw-response.txt', source: 'section.tex', provenance: 'PROVENANCE.json', ledger: 'REFERENCE_LEDGER.md', section: 'SECTION_RESULT.json' }),
    deliveredRoles: Object.freeze(['source', 'section', 'ledger']),
  }),
  'paper-plan': Object.freeze({
    label: 'Math linear section plan preview',
    startValid: (args, projectId) => args.language === 'English' && validPlan(args.plan, projectId, false),
    persistedValid: (meta, projectId) => meta.language === 'English' && validPlan(meta.plan, projectId),
    recordFields: payload => ({ kind: 'paper-plan', plan: structuredClone(payload) }),
    taskFields: meta => ({ kind: 'paper-plan', paperId: meta.plan.paperId, materialSha256: meta.plan.material.sha256,
      promptSha256: meta.plan.promptSha256, planSha256: planHash(JSON.stringify(meta.plan)) }),
    artifactNames: Object.freeze({ response: 'raw-response.txt', blocks: 'PLANNER_BLOCKS.json', plan: 'SECTION_PLAN.json', ledger: 'REFERENCE_LEDGER.md' }),
    deliveredRoles: Object.freeze(['blocks', 'plan', 'ledger']),
  }),
  'paper-chapter-tree': Object.freeze({
    label: 'Math paper chapter-tree assembly',
    startValid: () => false,
    persistedValid: (meta, projectId) => meta.language === 'English' && meta.projectId === projectId && object(meta.chapterTree)
      && typeof meta.chapterTree.paperId === 'string' && paperId(meta.chapterTree.paperId)
      && sha256(meta.chapterTree.mainSha256) && sha256(meta.chapterTree.ledgerSha256)
      && sha256(meta.chapterTree.manifestSha256) && Array.isArray(meta.chapterTree.chapterOrder)
      && meta.chapterTree.chapterOrder.length >= 1 && meta.chapterTree.chapterOrder.length <= 32,
    recordFields: payload => ({ kind: 'paper-chapter-tree', chapterTree: structuredClone(payload) }),
    taskFields: meta => ({ kind: 'paper-chapter-tree', paperId: meta.chapterTree.paperId,
      mainSha256: meta.chapterTree.mainSha256, ledgerSha256: meta.chapterTree.ledgerSha256,
      manifestSha256: meta.chapterTree.manifestSha256 }),
    artifactNames: Object.freeze({ source: 'main.tex', ledger: 'REFERENCE_LEDGER.md', provenance: 'PROVENANCE.json', manifest: 'CHAPTER_TREE_MANIFEST.json' }),
    deliveredRoles: Object.freeze(['source', 'manifest', 'ledger']),
  }),
  'paper-revision': Object.freeze({
    label: 'Math paper revision proposal',
    startValid: args => Boolean(snapshotPaperRevisionStart(args)),
    persistedValid: meta => meta.language === 'English' && object(meta.revision)
      && (meta.revision.mode === 'operator-notes' ? validNotesRevision(meta)
        : meta.revision.mode === 'gap-fill' ? validGapFillRevision(meta)
        : meta.revision.mode === 'compile-fix' ? validCompileFixRevision(meta)
        : validCitationRevision(meta))
      && validRevisionOutcomeRecord(meta),
    recordFields: payload => ({ kind: 'paper-revision', revision: structuredClone(payload) }),
    taskFields: meta => {
      const scalars = Object.fromEntries(Object.entries(meta.revision).filter(([, v]) => typeof v === 'string' || typeof v === 'number'));
      return { kind: 'paper-revision', ...scalars };
    },
    artifactNames: Object.freeze({ notes: 'OPERATOR_NOTES.md', compileLog: 'COMPILE_LOG.txt', response: 'raw-response.txt', source: 'proposal.tex', ledger: 'INHERITED_REFERENCE_LEDGER.md',
      provenance: 'INHERITED_PROVENANCE.json', proposal: 'REVISION_PROPOSAL.json', summary: 'REVISION_SUMMARY.md' }),
    deliveredRoles: Object.freeze(['source', 'summary', 'proposal', 'ledger']),
  }),
  summary: Object.freeze({
    label: 'Math progress report',
    startValid: args => args.paper === undefined && args.audit === undefined && args.verification === undefined && args.revision === undefined,
    // Persisted validation intentionally differs from admission (legacy records).
    persistedValid: meta => meta.paper === undefined,
    recordFields: () => ({}),
    taskFields: () => ({}),
    artifactNames: Object.freeze({}),
    deliveredRoles: Object.freeze([]), // Summary retains its separate legacy export path.
  }),
  'paper-source': Object.freeze({
    label: 'Math paper source',
    startValid: (args, projectId, paperValid) => args.language === 'English' && paperValid(args.paper, projectId),
    persistedValid: (meta, projectId, paperValid) => paperValid(meta.paper, projectId) && meta.language === 'English',
    recordFields: payload => ({ kind: 'paper-source', paper: structuredClone(payload) }),
    taskFields: meta => ({ kind: 'paper-source', paperId: meta.paper.paperId }),
    artifactNames: Object.freeze({ response: 'raw-response.txt', source: 'main.tex', quarantinedSource: 'main.leaky.tex',
      invalidSource: 'main.invalid.tex', provenance: 'provenance.json', ledger: 'REFERENCE_LEDGER.md' }),
    deliveredRoles: Object.freeze(['source', 'ledger']),
  }),
  'reference-verification': Object.freeze({
    label: 'Math reference verification',
    startValid: args => object(args.verification) && Object.keys(args.verification).length === 2
      && typeof args.verification.auditReportId === 'string' && REPORT_ID.test(args.verification.auditReportId)
      && typeof args.verification.paperId === 'string' && paperId(args.verification.paperId),
    persistedValid: meta => {
      const v = meta.verification, sel = matchSelector(v, manuscriptSelectors);
      if (!sel) return false;
      const required = [...sel, ...verificationBaseKeys], allowed = [...required, 'citationStatus'];
      return Object.keys(v).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(v, k))
        && typeof v.auditReportId === 'string' && REPORT_ID.test(v.auditReportId)
        && typeof v.paperId === 'string' && paperId(v.paperId)
        && ['mainSha256', 'ledgerSha256', 'auditSha256', 'contractSha256', 'verifierPromptSha256', 'promptSha256']
          .every(k => typeof v[k] === 'string' && sha256(v[k]))
        && v.boundContractSha256 === v.contractSha256
        && v.boundVerifierPromptSha256 === v.verifierPromptSha256
        && v.boundPromptSha256 === v.promptSha256
        && Array.isArray(v.keys) && v.keys.length > 0
        && v.keys.every(k => typeof k === 'string' && k.length > 0 && k.isWellFormed() && !/[\x00-\x1f]/.test(k))
        && new Set(v.keys).size === v.keys.length
        && (v.citationStatus === undefined || ['unverified', 'partial', 'verified'].includes(v.citationStatus));
    },
    recordFields: payload => ({ kind: 'reference-verification', verification: structuredClone(payload) }),
    taskFields: meta => ({ kind: 'reference-verification', auditReportId: meta.verification.auditReportId,
      ...pickSelector(meta.verification, manuscriptSelectors), paperId: meta.verification.paperId,
      mainSha256: meta.verification.mainSha256, ledgerSha256: meta.verification.ledgerSha256,
      auditSha256: meta.verification.auditSha256, promptSha256: meta.verification.promptSha256 }),
    artifactNames: Object.freeze({ response: 'raw-response.txt', verdicts: 'REFERENCE_VERDICTS.json', ledger: 'REFERENCE_LEDGER.md' }),
    deliveredRoles: Object.freeze(['verdicts', 'ledger']),
  }),
  'reference-audit': Object.freeze({
    label: 'Math reference audit',
    startValid: args => {
      const a = args.audit, sel = matchSelector(a, manuscriptSelectors);
      return Boolean(sel) && Object.keys(a).length === sel.length + 1
        && typeof a.paperId === 'string' && paperId(a.paperId);
    },
    persistedValid: meta => {
      const a = meta.audit, sel = matchSelector(a, manuscriptSelectors);
      if (!sel) return false;
      const required = [...sel, ...auditBaseKeys], allowed = [...required, 'citationStatus'];
      return Object.keys(a).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(a, k))
        && typeof a.paperId === 'string' && paperId(a.paperId)
        && sha256(a.mainSha256)
        && sha256(a.ledgerSha256) && sha256(a.contractSha256)
        && sha256(a.auditorPromptSha256) && sha256(a.promptSha256)
        && a.boundPromptSha256 === a.promptSha256
        && a.boundContractSha256 === a.contractSha256
        && a.boundAuditorPromptSha256 === a.auditorPromptSha256
        && (a.citationStatus === undefined || a.citationStatus === 'unverified');
    },
    recordFields: payload => ({ kind: 'reference-audit', audit: structuredClone(payload) }),
    taskFields: meta => ({ kind: 'reference-audit', ...pickSelector(meta.audit, manuscriptSelectors), paperId: meta.audit.paperId,
      mainSha256: meta.audit.mainSha256, ledgerSha256: meta.audit.ledgerSha256, promptSha256: meta.audit.promptSha256 }),
    artifactNames: Object.freeze({ response: 'raw-response.txt', audit: 'REFERENCE_AUDIT.md' }),
    deliveredRoles: Object.freeze(['audit']),
  }),
  'paper-compile': Object.freeze({
    label: 'Math paper TeX compilation',
    startValid: () => false,
    persistedValid: meta => {
      const c = meta.compile;
      return object(c) && typeof c.paperId === 'string' && paperId(c.paperId)
        && ['passed', 'failed'].includes(c.compileStatus)
        && typeof c.mainSha256 === 'string' && sha256(c.mainSha256)
        && typeof c.ledgerSha256 === 'string' && sha256(c.ledgerSha256)
        && typeof c.receiptSha256 === 'string' && sha256(c.receiptSha256)
        && typeof c.logSha256 === 'string' && sha256(c.logSha256)
        && (c.compileStatus !== 'passed' || (typeof c.pdfSha256 === 'string' && sha256(c.pdfSha256) && typeof c.flsSha256 === 'string' && sha256(c.flsSha256)));
    },
    recordFields: payload => ({ kind: 'paper-compile', compile: structuredClone(payload) }),
    taskFields: meta => ({ kind: 'paper-compile', paperId: meta.compile.paperId, mainSha256: meta.compile.mainSha256, compileStatus: meta.compile.compileStatus }),
    artifactNames: Object.freeze({ pdf: 'main.pdf', log: 'COMPILE_LOG.txt', fls: 'main.fls', receipt: 'COMPILE_RECEIPT.json' }),
    deliveredRoles: Object.freeze(['pdf', 'log']),
  }),
});
export function resolveReportKind(kind) {
  if (kind === undefined) return 'summary';
  if (typeof kind === 'string' && Object.hasOwn(specs, kind)) return kind;
  throw Object.assign(new Error('PROJECT_INVALID_INPUT'), { code: 'PROJECT_INVALID_INPUT' });
}
export const reportKindSpec = kind => specs[resolveReportKind(kind)];
export function validReportStart(args, projectId, paperValid) {
  if (!args) return false;
  try { return reportKindSpec(args.kind).startValid(args, projectId, paperValid); }
  catch (error) { if (error.code === 'PROJECT_INVALID_INPUT') return false; throw error; }
}
export function validReportPayload(meta, projectId, paperValid) {
  if (!meta) return false;
  try { return reportKindSpec(meta.kind).persistedValid(meta, projectId, paperValid); }
  catch (error) { if (error.code === 'PROJECT_INVALID_INPUT') return false; throw error; }
}
export function reportTaskFields(meta) {
  return { projectId: meta.projectId, reportId: meta.reportId, ...reportKindSpec(meta.kind).taskFields(meta) };
}
// Host metadata may carry extra fields; only the required receipt fields bind authority.
export function matchesReportTaskFields(meta, metadata) {
  const expected = reportTaskFields(meta);
  return metadata != null && Object.entries(expected).every(([key, value]) => metadata[key] === value)
    && (resolveReportKind(meta.kind) !== 'summary' || metadata.kind === undefined);
}
