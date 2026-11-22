// Pure kind contracts only. Authorization, binding, bytes and lifecycle stay in the service.
import { validPaperRevisionOutcome } from './paper-revision.mjs';
import { snapshotPaperRevisionStart } from './paper-revision-input.mjs';
import { validPlan, planHash } from './paper-plan.mjs';
import { snapshotPaperSectionStart } from './paper-section-input.mjs';
import { validSectionBinding } from './paper-section-binding.mjs';
import { snapshotPlanData } from './paper-plan-input.mjs';
export const REPORT_ID = /^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const paperId = v => /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
const sha256 = v => /^[a-f0-9]{64}$/.test(v);
const auditKeys = ['sourceReportId', 'paperId', 'mainSha256', 'ledgerSha256', 'contractSha256', 'boundContractSha256',
  'auditorPromptSha256', 'boundAuditorPromptSha256', 'promptSha256', 'boundPromptSha256', 'citationStatus'];
const verificationKeys = ['auditReportId', 'sourceReportId', 'paperId', 'mainSha256', 'ledgerSha256', 'auditSha256',
  'contractSha256', 'boundContractSha256', 'verifierPromptSha256', 'boundVerifierPromptSha256', 'promptSha256', 'boundPromptSha256', 'keys', 'citationStatus'];
const revisionHashes = ['mainSha256', 'verdictsSha256', 'ledgerSha256', 'originalLedgerSha256', 'provenanceSha256',
  'contractSha256', 'reviserPromptSha256', 'styleSha256', 'promptSha256'];
const revisionKeys = ['verificationReportId', 'sourceReportId', 'paperId', 'citationStatus', 'sourceStatus', ...revisionHashes];
const notesHashes = ['mainSha256', 'ledgerSha256', 'provenanceSha256', 'notesSha256', 'contractSha256', 'reviserPromptSha256', 'styleSha256', 'promptSha256'];
const notesKeys = ['mode', 'sourceReportId', 'paperId', 'sourceStatus', 'notesBytes', ...notesHashes];
function validNotesRevision(meta) {
  const r = meta.revision;
  return Object.keys(r).length === notesKeys.length && notesKeys.every(key => Object.hasOwn(r, key))
    && r.mode === 'operator-notes' && typeof r.sourceReportId === 'string' && REPORT_ID.test(r.sourceReportId)
    && typeof r.paperId === 'string' && paperId(r.paperId) && ['generated', 'flagged'].includes(r.sourceStatus)
    && notesHashes.every(key => typeof r[key] === 'string' && sha256(r[key]))
    && Number.isSafeInteger(r.notesBytes) && r.notesBytes > 0 && r.notesBytes <= 32 * 1024
    // Partial archive/admission failures must remain loadable for cleanup; run checks bytes before any model.
    && (meta.state !== 'completed' || (Object.hasOwn(meta, 'revisionOutcome') && object(meta.artifacts?.notes) && meta.artifacts.notes.name === 'OPERATOR_NOTES.md'
      && meta.artifacts.notes.bytes === r.notesBytes && meta.artifacts.notes.sha256 === r.notesSha256));
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
  const allowed = meta.revision?.mode === 'operator-notes' ? ['response', 'notes'] : ['response'];
  if (!object(meta.artifacts) || !object(meta.artifacts.response) || Object.keys(meta.artifacts).some(key => !allowed.includes(key))
    || ['artifact', 'publishedArtifact', 'publishedSha256', 'publishedBytes'].some(key => Object.hasOwn(meta, key))) return false;
  // Computed diagnostics may survive interruption/failure; only a clean completed record is a successful no-op.
  return meta.state !== 'completed' || (meta.sourceStatus === 'not-produced' && meta.sha256 === null && meta.bytes === null
    && Number.isSafeInteger(meta.completedAt) && meta.completedAt >= 0 && !meta.error
    && meta.cleanupPending === false && meta.stopRequested === false && meta.writerStarting === false
    && meta.taskCreating === false && meta.scheduleCreating === false);
}
const specs = Object.freeze({
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
  'paper-revision': Object.freeze({
    label: 'Math paper revision proposal',
    startValid: args => Boolean(snapshotPaperRevisionStart(args)),
    persistedValid: meta => meta.language === 'English' && object(meta.revision)
      && (meta.revision.mode === 'operator-notes' ? validNotesRevision(meta) : (Object.keys(meta.revision).every(k => revisionKeys.includes(k))
      && typeof meta.revision.verificationReportId === 'string' && REPORT_ID.test(meta.revision.verificationReportId)
      && typeof meta.revision.sourceReportId === 'string' && REPORT_ID.test(meta.revision.sourceReportId)
      && typeof meta.revision.paperId === 'string' && paperId(meta.revision.paperId) && revisionHashes.every(k => typeof meta.revision[k] === 'string' && sha256(meta.revision[k]))
      && ['unverified', 'partial', 'verified'].includes(meta.revision.citationStatus) && ['generated', 'flagged'].includes(meta.revision.sourceStatus)))
      && validRevisionOutcomeRecord(meta),
    recordFields: payload => ({ kind: 'paper-revision', revision: structuredClone(payload) }),
    taskFields: meta => ({ kind: 'paper-revision', ...meta.revision }),
    artifactNames: Object.freeze({ notes: 'OPERATOR_NOTES.md', response: 'raw-response.txt', source: 'proposal.tex', ledger: 'INHERITED_REFERENCE_LEDGER.md',
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
    persistedValid: meta => object(meta.verification) && Object.keys(meta.verification).every(k => verificationKeys.includes(k))
      && typeof meta.verification.auditReportId === 'string' && REPORT_ID.test(meta.verification.auditReportId)
      && typeof meta.verification.sourceReportId === 'string' && REPORT_ID.test(meta.verification.sourceReportId)
      && typeof meta.verification.paperId === 'string' && paperId(meta.verification.paperId)
      && ['mainSha256', 'ledgerSha256', 'auditSha256', 'contractSha256', 'verifierPromptSha256', 'promptSha256']
        .every(k => typeof meta.verification[k] === 'string' && sha256(meta.verification[k]))
      && meta.verification.boundContractSha256 === meta.verification.contractSha256
      && meta.verification.boundVerifierPromptSha256 === meta.verification.verifierPromptSha256
      && meta.verification.boundPromptSha256 === meta.verification.promptSha256
      && Array.isArray(meta.verification.keys) && meta.verification.keys.length > 0
      && meta.verification.keys.every(k => typeof k === 'string' && k.length > 0 && k.isWellFormed() && !/[\x00-\x1f]/.test(k))
      && new Set(meta.verification.keys).size === meta.verification.keys.length
      && (meta.verification.citationStatus === undefined || ['unverified', 'partial', 'verified'].includes(meta.verification.citationStatus)),
    recordFields: payload => ({ kind: 'reference-verification', verification: structuredClone(payload) }),
    taskFields: meta => ({ kind: 'reference-verification', auditReportId: meta.verification.auditReportId,
      sourceReportId: meta.verification.sourceReportId, paperId: meta.verification.paperId,
      mainSha256: meta.verification.mainSha256, ledgerSha256: meta.verification.ledgerSha256,
      auditSha256: meta.verification.auditSha256, promptSha256: meta.verification.promptSha256 }),
    artifactNames: Object.freeze({ response: 'raw-response.txt', verdicts: 'REFERENCE_VERDICTS.json', ledger: 'REFERENCE_LEDGER.md' }),
    deliveredRoles: Object.freeze(['verdicts', 'ledger']),
  }),
  'reference-audit': Object.freeze({
    label: 'Math reference audit',
    startValid: args => object(args.audit) && Object.keys(args.audit).length === 2 && typeof args.audit.sourceReportId === 'string'
      && REPORT_ID.test(args.audit.sourceReportId) && typeof args.audit.paperId === 'string' && paperId(args.audit.paperId),
    persistedValid: meta => object(meta.audit) && Object.keys(meta.audit).every(k => auditKeys.includes(k))
      && REPORT_ID.test(meta.audit.sourceReportId) && typeof meta.audit.paperId === 'string' && paperId(meta.audit.paperId)
      && sha256(meta.audit.mainSha256)
      && sha256(meta.audit.ledgerSha256) && sha256(meta.audit.contractSha256)
      && sha256(meta.audit.auditorPromptSha256) && sha256(meta.audit.promptSha256)
      && meta.audit.boundPromptSha256 === meta.audit.promptSha256
      && meta.audit.boundContractSha256 === meta.audit.contractSha256
      && meta.audit.boundAuditorPromptSha256 === meta.audit.auditorPromptSha256
      && (meta.audit.citationStatus === undefined || meta.audit.citationStatus === 'unverified'),
    recordFields: payload => ({ kind: 'reference-audit', audit: structuredClone(payload) }),
    taskFields: meta => ({ kind: 'reference-audit', sourceReportId: meta.audit.sourceReportId, paperId: meta.audit.paperId,
      mainSha256: meta.audit.mainSha256, ledgerSha256: meta.audit.ledgerSha256, promptSha256: meta.audit.promptSha256 }),
    artifactNames: Object.freeze({ response: 'raw-response.txt', audit: 'REFERENCE_AUDIT.md' }),
    deliveredRoles: Object.freeze(['audit']),
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
