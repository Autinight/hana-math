// Durable report tasks. Only the public methods accept a real creator context;
// scheduled execution uses the exact Host task receipt, never a saved token.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { isAbsolute } from 'node:path';
import { confirmResearchSessionStop, researchSessionDiagnostics, researchSdkErrorInfo } from './research-sessions.mjs';
import { buildPrompt, readWriterPrompt, leakFindings } from './human-summary.mjs';
import { REPORT_ID, reportKindSpec, validReportStart, validReportPayload, reportTaskFields, matchesReportTaskFields } from './project-report-kinds.mjs';
import { readResearchSessionInfo } from './research-session-info.mjs';
import { validPaperMaterial, assertPaperMaterial } from './paper-source.mjs';
import { validOperatorNotes, snapshotPaperRevisionRequest, snapshotPaperRevisionStart } from './paper-revision-input.mjs';
import { snapshotPaperPlanStart } from './paper-plan-input.mjs';
import { assertPlanMaterial, planInput, planDocuments, paperStitchText } from './paper-plan.mjs';
import { snapshotPaperSectionStart } from './paper-section-input.mjs';
import { readSectionResources, buildSectionPrompt } from './paper-section.mjs';
import { validSectionBinding, sectionDocuments } from './paper-section-binding.mjs';
import { snapshotPaperMathSelector, validPaperMathBinding } from './paper-math-service-binding.mjs';
import { PAPER_MATH_PINS, readPaperMathResources, buildPaperMathPrompt, parsePaperMathReport } from './paper-math-verification.mjs';

const APP = 'hana-math', HANDLER = 'math-project-report';
const TERMINAL = new Set(['completed', 'leak', 'failed', 'stopped', 'interrupted']);
const CONFIRMED_RECOVERY_STOPS = new Set(['aborted', 'idle-confirmed']);
const ACTIVE_WRITER_STATES = new Set(['preparing', 'running']);
const RECOVERY_STOP_OUTCOMES = new Set([...CONFIRMED_RECOVERY_STOPS, 'awaiting-send-receipt']);
const PAPER_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const SUMMARY_HTML_INPUT_MAX_BYTES = 512 * 1024, SUMMARY_HTML_MAX_BYTES = 2 * 1024 * 1024;
const failure = code => Object.assign(new Error(code), { code });
const check = (ok, code) => { if (!ok) throw failure(code); };
const copy = value => structuredClone(value);
const linearKind = kind => kind === 'paper-plan' || kind === 'paper-section';
const MANAGED_IPC_REFUSAL_CATEGORIES = new Set(['entry-limit', 'unsafe-entry', 'invalid-completion-marker', 'directory-limit', 'byte-limit']);
function setReportError(meta, primaryCode, category = null) {
  meta.error = primaryCode;
  if (!linearKind(meta.kind)) return;
  // A new primary selection never inherits a category, even on a same-code write.
  if (primaryCode === 'RESEARCH_RUNTIME_CAPACITY' && MANAGED_IPC_REFUSAL_CATEGORIES.has(category)) meta.managedIpcRefusal = { version: 1, category };
  else delete meta.managedIpcRefusal;
}
function selectLinearError(error, refusalFor) {
  const primaryCode = code(error);
  const category = primaryCode === 'RESEARCH_RUNTIME_CAPACITY' ? refusalFor?.(error) : null;
  return { code: primaryCode, category: MANAGED_IPC_REFUSAL_CATEGORIES.has(category) ? category : null };
}
function setLinearRunError(r, error, refusalFor) {
  const selected = r.planStartError ?? selectLinearError(error, refusalFor);
  setReportError(r.meta, selected.code, selected.category);
}
function projectRecordedIpcRefusal(dto, meta) {
  if (!linearKind(dto.kind) || dto.error !== 'RESEARCH_RUNTIME_CAPACITY') return dto;
  const field = Object.getOwnPropertyDescriptor(meta, 'managedIpcRefusal');
  const record = field?.value;
  if (!field?.enumerable || !record || typeof record !== 'object' || isProxy(record)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(record)) || Reflect.ownKeys(record).length !== 2) return dto;
  const version = Object.getOwnPropertyDescriptor(record, 'version'), category = Object.getOwnPropertyDescriptor(record, 'category');
  return version?.enumerable && version.value === 1 && category?.enumerable && MANAGED_IPC_REFUSAL_CATEGORIES.has(category.value)
    ? { ...dto, managedIpcRefusal: { source: 'recorded', category: category.value } } : dto;
}
const freezeData = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freezeData); Object.freeze(value); } return value; };
const planWriterEvidence = snapshot => {
  const evidence = { ...snapshot }; delete evidence.finalText; return copy(evidence);
};
const code = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,96}$/.test(error.code) ? error.code : 'PROJECT_REPORT_FAILED';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function paperValid(paper, projectId) {
  if (!object(paper) || Object.keys(paper).some(k => !['paperId', 'target', 'brief', 'instructions', 'factIds', 'material'].includes(k))
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(paper.paperId) || typeof paper.brief !== 'string' || !paper.brief.trim()
    || !paper.brief.isWellFormed() || paper.brief.includes('\0') || Buffer.byteLength(paper.brief) > 32 * 1024
    || typeof paper.instructions !== 'string' || !paper.instructions.isWellFormed() || paper.instructions.includes('\0')
    || Buffer.byteLength(paper.instructions) > 32 * 1024) return false;
  const t = paper.target, keys = ['schemaVersion', 'projectId', 'paperId', 'factIds', 'factDigests', 'finalizedBy', 'at'];
  return object(t) && Object.keys(t).length === keys.length && keys.every(k => Object.hasOwn(t, k))
    && t.schemaVersion === 1 && t.projectId === projectId && t.paperId === paper.paperId && t.finalizedBy === 'creator'
    && Number.isSafeInteger(t.at) && t.at >= 0 && Array.isArray(t.factIds) && t.factIds.length >= 1 && t.factIds.length <= 64
    && t.factIds.every(id => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)) && new Set(t.factIds).size === t.factIds.length
    && object(t.factDigests) && Object.keys(t.factDigests).length === t.factIds.length
    && t.factIds.every(id => typeof t.factDigests[id] === 'string' && /^[a-f0-9]{64}$/.test(t.factDigests[id]))
    && (Object.hasOwn(paper, 'material') ? validPaperMaterial(paper.material, t, paper.factIds) : !Object.hasOwn(paper, 'factIds'));
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('PROJECT_REPORT_CONTROL_TIMEOUT')), 10000); })]); }
  finally { clearTimeout(timer); }
}

export async function createProjectReportService({ sdk, store, summaryWriter, authorizeCreator, projects, getProject,
  assertLive, gatherFacts, withReportPublication, gatherPaperFacts, withPaperPublication, paperRunnerIpcScope, assertPaperTarget, readInput, track, projectLocation, literature,
  deferHistoricalWork = false, isFreshProject = () => false }) {
  const records = new Map(), active = new Map(), damaged = new Set(), admitting = new Set();
  const deferredByProject = new Map(), historyPreparation = new WeakMap(), mathReviewChecks = new WeakMap();
  let disposed = false, registration;
  const directory = (p, id) => `${projectLocation(p)}/reports/${id}`;
  const statePath = (p, id) => `${directory(p, id)}/metadata.json`;
  const key = (p, id) => `${p.meta.projectId}/${id}`;
  function wrap(meta) { return { meta, writes: Promise.resolve(), control: Promise.resolve(), failedSave: false, handle: null, job: null, jobSettled: false, schedulePromise: null, settlementPromise: null }; }
  async function prepareHistory(p, authorize) {
    const projectId = p.meta.projectId;
    const assertProject = () => check(!disposed && p.meta.projectId === projectId && getProject(projectId) === p, 'PROJECT_DISPOSED');
    assertProject();
    let preparation = historyPreparation.get(p);
    if (preparation?.ready) return;
    if (!preparation) {
      preparation = { ready: false };
      historyPreparation.set(p, preparation);
      preparation.job = (async () => {
        let names = [], invalid = false;
        try { names = await store.list(`${projectLocation(p)}/reports`); }
        catch (error) { invalid = error.code !== 'ENOENT'; }
        const loaded = [], blockers = new Set();
        for (const id of names.filter(name => REPORT_ID.test(name))) {
          assertProject();
          try {
            const meta = await store.readJson(statePath(p, id)); checkRecord(p, meta, id);
            const r = wrap(meta);
            r.historical = true;
            loaded.push(r);
            if (reportNeedsRecovery(meta)) blockers.add(r);
          } catch { invalid = true; }
        }
        assertProject();
        // Publish admission and lineage together. No artifact reads or Host work.
        for (const r of loaded) records.set(key(p, r.meta.reportId), r);
        if (blockers.size) deferredByProject.set(projectId, blockers);
        if (invalid) damaged.add(projectId);
        preparation.ready = true;
      })();
    }
    await preparation.job;
    // Each caller supplies its own authority after the shared disk wait.
    await authorize();
    assertProject();
  }
  function exclusive(r, action) {
    const job = r.control.catch(() => {}).then(action);
    r.control = job;
    job.catch(() => {});
    return job;
  }
  async function save(p, r) {
    const bytes = JSON.stringify(r.meta) + '\n';
    const writing = r.writes.catch(() => {}).then(() => store.write(statePath(p, r.meta.reportId), bytes, true));
    r.writes = writing;
    try { await writing; } catch (error) { r.failedSave = true; throw error; }
  }
  function checkRecord(p, meta, id) {
    check(validReportPayload(meta, p.meta.projectId, paperValid), 'PROJECT_REPORT_RECORD_INVALID');
    if (meta.kind === 'paper-math-verification') check(validPaperMathBinding(meta.math), 'PROJECT_REPORT_RECORD_INVALID');
    check(meta?.schemaVersion === 1 && meta.projectId === p.meta.projectId && meta.reportId === id && REPORT_ID.test(id)
      && ['queued', 'running', ...TERMINAL].includes(meta.state) && typeof meta.cleanupPending === 'boolean'
      && typeof meta.stopRequested === 'boolean' && typeof meta.taskCreating === 'boolean' && typeof meta.scheduleCreating === 'boolean'
      && typeof meta.writerStarting === 'boolean' && typeof meta.language === 'string'
      && (!Object.hasOwn(meta, 'recoveryStop') || RECOVERY_STOP_OUTCOMES.has(meta.recoveryStop))
      && (!Object.hasOwn(meta, 'recoveryError') || typeof meta.recoveryError === 'string' && /^[A-Z0-9_]{1,96}$/.test(meta.recoveryError))
      && meta.creator?.sessionId === p.meta.creator?.sessionId && meta.creator?.sessionPath === p.meta.creator?.sessionPath,
    'PROJECT_REPORT_RECORD_INVALID');
    if (linearKind(meta.kind)) {
      const section = meta.kind === 'paper-section';
      if (section && Object.hasOwn(meta, 'findings')) check(object(meta.findings) && Object.keys(meta.findings).length === 3
        && Object.entries({ leaks: 5, blockers: 32, warnings: 32 }).every(([k, limit]) => Array.isArray(meta.findings[k]) && meta.findings[k].length <= limit
          && meta.findings[k].every(s => typeof s === 'string' && s.isWellFormed() && Buffer.byteLength(s) <= 1024))
        && typeof meta.findingsTruncated === 'boolean', 'PROJECT_REPORT_RECORD_INVALID');
      const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
        && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
      const w = meta.writer;
      check((meta.taskId === null || identity(meta.taskId)) && (meta.scheduleId === null || identity(meta.scheduleId))
        && ['pending', 'unknown', 'confirmed'].includes(meta.taskSettlement) && typeof meta.scheduleCleaned === 'boolean'
        && typeof meta.nonce === 'string' && /^[a-f0-9]{48}$/.test(meta.nonce)
        && (!Object.hasOwn(meta, 'archiveError') || meta.archiveError === 'PROJECT_REPORT_ARTIFACT_INVALID')
        && (w === null || object(w) && w.role === 'report-writer'
          && typeof w.agentId === 'string' && (section ? /^math-paper-section-writer-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ : /^math-paper-planner-[0-9a-f-]{36}$/).test(w.agentId)
          && (!section || !Object.hasOwn(w, 'finalText'))
          && w.cwd === store.absolute(directory(p, id)) && w.kind === `${section ? 'math-paper-section' : 'math-paper-plan'}:${p.meta.projectId}:${id}`
          && (w.sessionId === null || identity(w.sessionId)) && (w.sessionPath === null || identity(w.sessionPath) && isAbsolute(w.sessionPath))
          && ['preparing', 'running', 'completed', 'failed', 'stopped', 'timed-out'].includes(w.state) && typeof w.cleanupPending === 'boolean'
          && (w.sendPending === undefined || typeof w.sendPending === 'boolean')
          && (w.sendState === undefined || ['not-sent', 'pending', 'accepted', 'rejected', 'unconfirmed'].includes(w.sendState))),
      'PROJECT_REPORT_RECORD_INVALID');
    }
  }
  function current(p, r) {
    assertLive(p); check(!disposed, 'PROJECT_DISPOSED');
    check(records.get(key(p, r.meta.reportId)) === r && getProject(r.meta.projectId) === p && !r.failedSave, 'PROJECT_REPORT_RECORD_INVALID');
    check(!r.meta.stopRequested && r.meta.state === 'running', 'PROJECT_SUMMARY_STOPPED');
  }
  async function taskReceipt(p, r) {
    const meta = r.meta;
    check(typeof meta.taskId === 'string', 'PROJECT_REPORT_TASK_UNCONFIRMED');
    const task = await bounded(sdk.tasks.get(meta.taskId));
    check(task?.taskId === meta.taskId && task.pluginId === APP && task.scope === 'session' && task.handlerKey === HANDLER
      && task.delivery === 'next-step' && matchesReportTaskFields(meta, task.metadata)
      && task.parentSessionId === meta.creator.sessionId && task.parentSessionPath === meta.creator.sessionPath
      && meta.creator.sessionId === p.meta.creator?.sessionId && meta.creator.sessionPath === p.meta.creator?.sessionPath,
    'PROJECT_REPORT_TASK_UNCONFIRMED');
    return task;
  }
  async function readGuard(p, r) {
    current(p, r); const task = await taskReceipt(p, r); current(p, r);
    check(['pending', 'running'].includes(task.status), 'PROJECT_REPORT_TASK_INACTIVE');
  }
  function completedRevisionNoOp(r) {
    const m = r.meta;
    return m.kind === 'paper-revision' && m.state === 'completed' && m.revisionOutcome?.status === 'no_edits_applied'
      && !m.cleanupPending && !r.failedSave && !m.stopRequested && !m.error;
  }
  function writerCleanupPending(m) {
    return m.writer?.sendPending === true || ['pending', 'unconfirmed'].includes(m.writer?.sendState)
      || m.recoveryStop === 'awaiting-send-receipt' || (!CONFIRMED_RECOVERY_STOPS.has(m.recoveryStop)
        && (m.writer?.cleanupPending === true || ACTIVE_WRITER_STATES.has(m.writer?.state)));
  }
  function planCleanupPending(m) {
    return m.cleanupPending || m.taskCreating || m.scheduleCreating || m.writerStarting || Boolean(m.scheduleId)
      || m.writer?.cleanupPending === true || ACTIVE_WRITER_STATES.has(m.writer?.state) || m.writer?.sendPending === true
      || ['pending', 'unconfirmed'].includes(m.writer?.sendState) || m.recoveryStop === 'awaiting-send-receipt';
  }
  function reportNeedsRecovery(m) {
    return !TERMINAL.has(m.state) || m.taskSettlement !== 'confirmed' || m.cleanupPending || m.taskCreating
      || m.scheduleCreating || m.writerStarting || Boolean(m.scheduleId) || writerCleanupPending(m);
  }
  function planView(r, settled = true) {
    const m = r.meta, clean = m.state === 'completed' && !m.error && !m.archiveError && !m.stopRequested && !r.failedSave
      && !planCleanupPending(m) && (!settled || m.taskSettlement === 'confirmed');
    return { kind: 'paper-plan', paperId: m.plan.paperId, publicationStatus: clean ? 'reviewable-plan' : 'not-ready',
      ...(m.archiveError ? { archiveError: m.archiveError } : {}),
      selection: copy(m.plan.material), coverageStatus: clean ? 'exact-once' : 'not-established',
      ...(clean ? { coverage: { status: 'exact-once', factIds: [...m.plan.material.coverageFactIds] } } : {}),
      sectionOrdering: 'not-checked', citationStatus: 'not-requested', mathematicsStatus: 'unreviewed', compileStatus: 'not-run' };
  }
  function sectionView(r, settled = true) {
    const m = r.meta, b = m.section, clean = m.state === 'completed' && !m.error && !m.archiveError && !m.stopRequested && !r.failedSave
      && m.writer?.state === 'completed' && m.writer?.modelStopReason === 'stop' && m.writer?.cleanupPending === false
      && !planCleanupPending(m) && (!settled || m.taskSettlement === 'confirmed' && (!r.job || r.jobSettled));
    return { kind: 'paper-section', paperId: b.source.paperId, planReportId: b.source.planReportId,
      previousSectionReportId: b.lineage.previousSectionReportId, chainRootReportId: b.lineage.chainRootReportId,
      sectionIndex: b.material.sectionIndex, sectionCount: b.sectionCount, title: b.material.title, label: b.material.label,
      source: copy(b.source), lineage: copy(b.lineage), material: copy(b.material), resources: copy(b.resources), promptSha256: b.promptSha256,
      sourceStatus: m.sourceStatus ?? 'pending', publicationStatus: clean ? 'reviewable-section' : 'not-ready',
      provenanceStatus: m.provenanceStatus ?? 'missing', findings: copy(m.findings ?? { leaks: [], blockers: [], warnings: [] }), findingsTruncated: m.findingsTruncated === true,
      ...(m.archiveError ? { archiveError: m.archiveError } : {}), sectionOrdering: 'not-checked', citationStatus: 'not-requested', mathematicsStatus: 'unreviewed', compileStatus: 'not-run',
      limitations: ['Frozen section fragment only; no current complete-chain, body-coverage, section-label, macro, mathematical, citation, assembly or compilation validation.'] };
  }
  function mathCompletionCandidate(r) {
    const m = r.meta;
    return m.kind === 'paper-math-verification' && m.state === 'completed' && !r.failedSave
      && !m.error && !m.stopRequested && !planCleanupPending(m) && !writerCleanupPending(m)
      && m.writer?.state === 'completed' && m.writer.modelStopReason === 'stop'
      && m.writer.cleanupPending === false && ['correct', 'wrong'].includes(m.mathVerdict);
  }
  // Settlement and artifact verification are independent. Readers must use
  // this gate as well as checking the exact archived review bytes.
  function cleanMathCompletion(r) {
    return mathCompletionCandidate(r) && !r.mathSettlementWriting && r.meta.taskSettlement === 'confirmed'
      && r.meta.mathTaskStatus === 'completed' && !r.meta.taskError;
  }
  async function settledMathView(p, r) {
    if (cleanMathCompletion(r) && !mathReviewChecks.has(r)) {
      // A concurrent status check may have cleared the producer's cache.
      // Restore only from the exact archived review, not its verdict field.
      try { await readPaperMathReview(p, r); } catch {}
    }
    return view(r);
  }
  function clearMathCompletion(r) {
    const m = r.meta;
    mathReviewChecks.delete(r);
    delete m.mathVerdict;
    m.completedAt = null; m.sha256 = null; m.bytes = null;
  }
  function view(r) {
    const m = r.meta, mathCheck = mathReviewChecks.get(r);
    const mathVerdict = cleanMathCompletion(r) && mathCheck && mathCheck.binding === JSON.stringify(m.math)
      && mathCheck.sha256 === m.artifacts?.review?.sha256 && mathCheck.verdict === m.mathVerdict ? m.mathVerdict : null;
    return copy({ projectId: m.projectId, reportId: m.reportId, taskId: m.taskId, state: m.state, language: m.language,
      createdAt: m.createdAt, completedAt: m.completedAt ?? null, snapshotCapturedAt: m.snapshotCapturedAt ?? null,
      asOf: m.asOf ?? null, bytes: m.bytes ?? null,
      sha256: m.sha256 ?? null, error: m.error ?? null, cleanupPending: m.cleanupPending || r.failedSave,
      ...(r.historical && reportNeedsRecovery(m) ? { recoveryPending: true } : {}),
      stopRequested: m.stopRequested, taskSettlement: r.mathSettlementWriting && m.taskSettlement === 'confirmed' ? 'pending' : m.taskSettlement, delivery: m.delivery,
      snapshotAdvancedDuringWriting: m.snapshotAdvancedDuringWriting === true,
      sessionStop: m.recoveryStop || m.recoveryError ? { outcome: m.recoveryStop ?? null,
        confirmed: CONFIRMED_RECOVERY_STOPS.has(m.recoveryStop), error: m.recoveryError ?? null } : null,
      ...(m.kind === 'paper-plan' ? planView(r) : m.kind === 'paper-section' ? sectionView(r) : {}),
      ...(m.kind === 'paper-revision' ? { kind: m.kind, ...copy(m.revision),
        ...(Object.hasOwn(m, 'revisionOutcome') ? { revisionOutcome: copy(m.revisionOutcome) } : {}),
        ...(completedRevisionNoOp(r) ? { proposalProduced: false } : {}),
        proposalOnly: true, publicationStatus: completedRevisionNoOp(r) ? 'no_edits_applied' : 'reviewable-proposal', sourceStatus: m.sourceStatus ?? 'pending',
        ...(m.revision.mode === 'operator-notes' ? { citationStatus: 'not-requested' }
          : { citationStatus: 'inherited-verification-source-judgment', inheritedCitationStatus: m.revision.citationStatus }),
        provenance: { sourceReportId: m.revision.sourceReportId, sha256: m.revision.provenanceSha256, status: 'inherited-not-revalidated' },
        mathematicsStatus: 'unreviewed', reviewStatus: 'unreviewed', compileStatus: 'not-run' } : {}),
      ...(m.kind === 'reference-audit' ? { kind: m.kind, sourceReportId: m.audit.sourceReportId, paperId: m.audit.paperId,
        sourceMainSha256: m.audit.mainSha256, sourceLedgerSha256: m.audit.ledgerSha256,
        contractSha256: m.audit.contractSha256, auditorPromptSha256: m.audit.auditorPromptSha256,
        promptSha256: m.audit.promptSha256, auditMode: 'offline', citationStatus: 'unverified' } : {}),
      ...(m.kind === 'paper-math-verification' ? { kind: m.kind, ...copy(m.math),
        ...(mathVerdict ? { mathVerdict } : {}),
        ...(!r.mathSettlementWriting && m.taskSettlement === 'confirmed' && m.mathTaskStatus ? { mathTaskStatus: m.mathTaskStatus } : {}),
        ...(m.taskError ? { taskError: m.taskError } : {}),
        paperMathGate: mathVerdict === 'correct' ? 'passed' : mathVerdict === 'wrong' ? 'failed' : 'not-assessed',
        publicationStatus: 'not-assessed', compileStatus: 'not-run' } : {}),
      ...(m.kind === 'reference-verification' ? { kind: m.kind, auditReportId: m.verification.auditReportId,
        sourceReportId: m.verification.sourceReportId, paperId: m.verification.paperId,
        sourceMainSha256: m.verification.mainSha256, sourceLedgerSha256: m.verification.ledgerSha256,
        auditSha256: m.verification.auditSha256, contractSha256: m.verification.contractSha256,
        verifierPromptSha256: m.verification.verifierPromptSha256, promptSha256: m.verification.promptSha256,
        citationStatus: m.state === 'completed' ? m.verification.citationStatus ?? 'unverified' : 'unverified',
        mathematicsStatus: 'unreviewed', reviewStatus: 'unreviewed', compileStatus: 'not-run', verificationMode: 'online' } : {}),
      ...(m.kind === 'paper-source' ? { kind: m.kind, paperId: m.paper.paperId, headlineFactIds: m.paper.target.factIds,
        ...(m.paper.material ? { selection: { mode: m.paper.material.mode, factIds: m.paper.factIds ?? [],
          writerFactCount: m.paper.material.writerFactIds.length, validationFactCount: m.paper.material.validationFactIds.length,
          outsideTargetFactIds: m.paper.material.outsideTargetFactIds, warnings: m.paper.material.warnings } } : {}),
        sourceStatus: m.sourceStatus === 'flagged' ? 'flagged' : m.state === 'completed' ? 'generated' : TERMINAL.has(m.state) ? 'invalid' : 'pending',
        reviewStatus: 'unreviewed', compileStatus: 'not-run', citationStatus: 'unverified', mathematicsStatus: 'unreviewed',
        findings: m.findings ? { blockers: m.findings.blockers?.length ?? 0, leaks: m.findings.leaks?.length ?? 0, warnings: m.findings.warnings?.length ?? 0 } : null } : {}),
      leakFindings: m.kind === 'paper-source' ? (m.leakFindings ?? []).map(f => f.split(':')[0]) : m.leakFindings ?? [], writer: m.writer ? {
        sessionId: m.writer.sessionId, agentId: m.writer.agentId,
        state: CONFIRMED_RECOVERY_STOPS.has(m.recoveryStop) && ACTIVE_WRITER_STATES.has(m.writer.state) ? 'stopped' : m.writer.state,
        ...researchSessionDiagnostics(m.writer),
        ...(m.recoveryStop && RECOVERY_STOP_OUTCOMES.has(m.recoveryStop) ? { stopEvidence: m.recoveryStop } : {}),
        toolSelection: m.writer.toolSelection ?? null, model: m.writer.model ?? null,
        cleanupPending: CONFIRMED_RECOVERY_STOPS.has(m.recoveryStop) && ACTIVE_WRITER_STATES.has(m.writer.state) ? false : m.writer.cleanupPending,
      } : null });
  }
  // Only creator-authorized status/result paths use this projection. Take the
  // DTO and its paired metadata in the same synchronous read.
  const readView = r => projectRecordedIpcRefusal(view(r), r.meta);
  async function settle(p, r) {
    if (!r.meta.taskId || r.meta.taskCreating) return;
    if (!r.settlementPromise) {
      const job = (async () => {
        const m = r.meta, math = m.kind === 'paper-math-verification';
        const noteMathSaveFailure = error => {
          if (m.state === 'completed') { m.state = 'failed'; setReportError(m, code(error)); }
          clearMathCompletion(r); m.cleanupPending = true;
          m.taskSettlement = 'unknown'; m.taskError = code(error); delete m.mathTaskStatus;
        };
        if (math) r.mathSettlementWriting = true;
        try {
          const task = await taskReceipt(p, r), good = math ? mathCompletionCandidate(r) : ['completed', 'leak'].includes(m.state);
          let terminal = task;
          if (['pending', 'running'].includes(task.status)) {
            const result = { projectId: r.meta.projectId, reportId: r.meta.reportId, status: r.meta.state,
              sha256: r.meta.sha256 ?? null, bytes: r.meta.bytes ?? null, cleanupPending: r.meta.cleanupPending,
              asOf: r.meta.asOf ?? null, snapshotCapturedAt: r.meta.snapshotCapturedAt ?? null,
              snapshotAdvancedDuringWriting: r.meta.snapshotAdvancedDuringWriting === true,
              ...(r.meta.kind === 'paper-plan' ? planView(r, false) : r.meta.kind === 'paper-section' ? sectionView(r, false) : {}),
              ...(r.meta.kind === 'paper-revision' && Object.hasOwn(r.meta, 'revisionOutcome')
                ? { revisionOutcome: copy(r.meta.revisionOutcome), ...(completedRevisionNoOp(r) ? { proposalProduced: false } : {}) } : {}) };
            terminal = good ? await bounded(sdk.tasks.complete(r.meta.taskId, result))
              : await bounded(sdk.tasks.fail(r.meta.taskId, r.meta.error ?? 'PROJECT_REPORT_STOPPED'));
          }
          check(terminal?.taskId === task.taskId && ['completed', 'failed', 'canceled', 'aborted'].includes(terminal.status), 'PROJECT_REPORT_TASK_UNCONFIRMED');
          if (math) {
            check(terminal.pluginId === APP && terminal.scope === 'session' && terminal.handlerKey === HANDLER && terminal.delivery === 'next-step'
              && terminal.parentSessionId === m.creator.sessionId && terminal.parentSessionPath === m.creator.sessionPath
              && m.creator.sessionId === p.meta.creator?.sessionId && m.creator.sessionPath === p.meta.creator?.sessionPath
              && matchesReportTaskFields(m, terminal.metadata), 'PROJECT_REPORT_TASK_UNCONFIRMED');
            m.mathTaskStatus = terminal.status;
            const stopped = terminal.status === 'canceled' || terminal.status === 'aborted';
            if (stopped || m.state === 'completed' && (terminal.status !== 'completed' || !mathCompletionCandidate(r))) {
              m.state = stopped ? 'stopped' : 'failed';
              if (stopped) m.stopRequested = true;
              setReportError(m, stopped ? `PROJECT_REPORT_TASK_${terminal.status.toUpperCase()}`
                : terminal.status === 'failed' ? 'PROJECT_REPORT_TASK_FAILED' : m.error ?? 'PROJECT_REPORT_NOT_READY');
              clearMathCompletion(r);
            }
          }
          // Commit a math completion only once, after the delivery observation.
          // A failed final write must not leave an earlier clean witness on disk.
          if (!math) { m.taskSettlement = 'confirmed'; m.taskError = null; await save(p, r); }
        } catch (error) {
          m.taskSettlement = 'unknown'; m.taskError = code(error);
          if (math) {
            delete m.mathTaskStatus;
            if (r.failedSave) noteMathSaveFailure(error);
          }
          try { await save(p, r); }
          catch (saveError) {
            if (!math) throw saveError;
            noteMathSaveFailure(saveError); await save(p, r);
          } finally { if (math) r.mathSettlementWriting = false; }
          return;
        }
        try {
          const delivery = await bounded(sdk.tasks.getDelivery(r.meta.taskId));
          r.meta.delivery = { state: delivery?.state ?? 'unknown', delivered: delivery?.delivered === true };
          r.meta.deliveryError = null;
        } catch (error) {
          r.meta.delivery = { state: 'unknown', delivered: false };
          r.meta.deliveryError = code(error);
        }
        if (!math) { await save(p, r); return; }
        // Queue a snapshot on the same write tail as save(). Readers must
        // not observe confirmed while this final metadata write is pending.
        const bytes = JSON.stringify({ ...m, taskSettlement: 'confirmed', taskError: null }) + '\n';
        const writing = r.writes.catch(() => {}).then(() => store.write(statePath(p, m.reportId), bytes, true));
        r.writes = writing;
        try {
          await writing;
          m.taskSettlement = 'confirmed'; m.taskError = null;
        } catch (error) {
          r.failedSave = true;
          noteMathSaveFailure(error); await save(p, r);
        } finally { r.mathSettlementWriting = false; }
      })();
      r.settlementPromise = job;
      job.finally(() => { if (r.settlementPromise === job) r.settlementPromise = null; }).catch(() => {});
    }
    return r.settlementPromise;
  }
  async function unschedule(p, r) {
    if (!r.meta.scheduleId) return;
    if (!r.schedulePromise) {
      const job = (async () => {
        const id = r.meta.scheduleId, receipt = await bounded(sdk.tasks.unschedule(id));
        check(receipt?.ok === true, 'PROJECT_REPORT_SCHEDULE_UNCONFIRMED');
        r.meta.scheduleId = null; r.meta.scheduleCleaned = true; await save(p, r);
      })();
      r.schedulePromise = job;
      job.catch(() => { if (r.schedulePromise === job) r.schedulePromise = null; });
    }
    return r.schedulePromise;
  }
  function get(p, id) {
    check(typeof id === 'string' && REPORT_ID.test(id), 'PROJECT_INVALID_INPUT');
    const r = records.get(key(p, id)); check(r, 'PROJECT_REPORT_NOT_FOUND'); return r;
  }
  async function preserveAlternate(p, r, alternate) {
    const old = `${projectLocation(p)}/report/${alternate}`;
    let bytes;
    try { bytes = await store.read(old); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await store.write(`${directory(p, r.meta.reportId)}/previous-${alternate}`, bytes);
    await store.remove(old);
  }
  async function paperArtifact(p, r, role, bytes, mime) {
    check(bytes.length <= PAPER_ARTIFACT_MAX_BYTES, 'PROJECT_PAPER_OUTPUT_TOO_LARGE');
    const name = reportKindSpec(r.meta.kind).artifactNames[role];
    const artifact = `${directory(p, r.meta.reportId)}/${name}`;
    check(!r.meta.artifacts?.[role], 'PROJECT_REPORT_ARTIFACT_INVALID');
    await store.write(artifact, bytes);
    r.meta.artifacts ??= {};
    r.meta.artifacts[role] = { artifact, name, mime, bytes: bytes.length, sha256: hash(bytes) };
    await save(p, r);
  }
  async function publishPaper(p, r, { source, gathered, ledger, guard, assertActive, text }) {
    const materials = assertPaperMaterial(gathered, r.meta.paper);
    const split = source.splitPaperOutput(text, materials.material.writerFactIds);
    check(object(split.findings) && ['blockers', 'leaks', 'warnings'].every(k => Array.isArray(split.findings[k])
      && split.findings[k].every(f => typeof f === 'string')), 'PROJECT_PAPER_OUTPUT_INVALID');
    const { blockers, leaks, warnings } = split.findings;
    const invalidFormat = warnings.some(w => w.startsWith('output lacks a complete raw LaTeX document'));
    r.meta.findings = copy(split.findings);
    r.meta.outputProcessing = { outerFenceRemoved: /^\n*```[^\n]*\n/.test(text), provenanceAccepted: split.provenance !== null };
    if (invalidFormat) r.meta.sourceStatus = 'invalid';
    else if (blockers.length || leaks.length) r.meta.sourceStatus = 'flagged';
    r.meta.leakFindings = leaks;
    await save(p, r);
    check(typeof split.tex === 'string' && split.tex.trim(), 'PROJECT_PAPER_OUTPUT_INVALID');
    const diagnosticRole = leaks.length ? 'quarantinedSource' : invalidFormat ? 'invalidSource' : 'source';
    await paperArtifact(p, r, diagnosticRole, Buffer.from(split.tex), 'application/x-tex');
    await paperArtifact(p, r, 'provenance', Buffer.from(JSON.stringify(split.provenance, null, 2) + '\n'), 'application/json');
    await paperArtifact(p, r, 'ledger', Buffer.from(ledger), 'text/markdown');
    check(!invalidFormat, 'PROJECT_PAPER_OUTPUT_INVALID');
    check(!leaks.length, 'PROJECT_PAPER_OUTPUT_LEAK');
    r.meta.snapshotCheckedAt = Date.now();
    await withPaperPublication(p.meta.projectId, { guard, assertActive, reportId: r.meta.reportId }, copy(r.meta.paper.target), async latest => {
      assertPaperMaterial(latest, r.meta.paper);
      r.meta.snapshotAdvancedDuringWriting = latest.asOf !== gathered.asOf || gathered.asOf !== r.meta.paper.material.admissionAsOf;
      await exclusive(r, async () => {
        current(p, r);
        r.meta.sourceStatus = blockers.length ? 'flagged' : 'generated';
        r.meta.state = 'completed'; r.meta.completedAt = Date.now(); r.meta.cleanupPending = false;
        await save(p, r);
      });
    }, r.meta.paper.factIds ?? []);
  }
  async function paperMathSource(p, selector, guard, authorize) {
    const identity = r => {
      const m = r.meta;
      check(m.projectId === p.meta.projectId && m.reportId === r.meta.reportId && m.creator?.sessionId === p.meta.creator?.sessionId
        && m.creator?.sessionPath === p.meta.creator?.sessionPath && m.state === 'completed' && !m.cleanupPending
        && !m.stopRequested && !m.taskCreating && !m.scheduleCreating && !m.writerStarting
        && m.taskSettlement === 'confirmed' && !m.error && !r.failedSave, 'PROJECT_PAPER_MATH_SOURCE_INVALID');
      return JSON.stringify([m.kind, m.projectId, m.reportId, m.state, m.cleanupPending, m.stopRequested, m.taskCreating,
        m.scheduleCreating, m.writerStarting, m.taskSettlement, m.error, m.sourceStatus, m.leakFindings,
        m.math, m.section, m.artifacts]);
    };
    let mainTexBytes, ledgerBytes, sourceReports = [], singleSource = null, stitchedSource = null;
    if (selector.sourceReportId) {
      const source = get(p, selector.sourceReportId), m = source.meta, before = identity(source);
      check(m.kind === 'paper-source' && ['generated', 'flagged'].includes(m.sourceStatus) && !m.leakFindings?.length
        && !m.artifacts?.quarantinedSource && !m.artifacts?.invalidSource && !m.findings?.leaks?.length,
      'PROJECT_PAPER_MATH_SOURCE_INVALID');
      const artifact = (role, name) => {
        const value = m.artifacts?.[role];
        check(value?.name === name && value.artifact === `${directory(p, m.reportId)}/${name}`
          && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= PAPER_ARTIFACT_MAX_BYTES
          && /^[a-f0-9]{64}$/.test(value.sha256), 'PROJECT_PAPER_MATH_SOURCE_INVALID');
        return copy(value);
      };
      const mainArtifact = artifact('source', 'main.tex'), savedLedger = artifact('ledger', 'REFERENCE_LEDGER.md');
      [mainTexBytes, ledgerBytes] = await Promise.all([store.read(mainArtifact.artifact), store.read(savedLedger.artifact)]);
      guard();
      check(identity(source) === before && JSON.stringify(m.artifacts.source) === JSON.stringify(mainArtifact)
        && JSON.stringify(m.artifacts.ledger) === JSON.stringify(savedLedger)
        && mainTexBytes.length === mainArtifact.bytes && hash(mainTexBytes) === mainArtifact.sha256
        && ledgerBytes.length === savedLedger.bytes && hash(ledgerBytes) === savedLedger.sha256,
      'PROJECT_PAPER_MATH_SOURCE_CHANGED');
      sourceReports = [{ report: source, identity: hash(JSON.stringify(source.meta)) }];
      singleSource = { report: source, identity: hash(JSON.stringify(source.meta)), mainArtifact, ledgerArtifact: savedLedger };
    } else {
      stitchedSource = await stitchInternal(p, selector, authorize, guard);
      mainTexBytes = stitchedSource.bytes; ledgerBytes = Buffer.from(stitchedSource.ledger, 'utf8');
    }
    const mainTex = strictText(mainTexBytes), ledger = strictText(ledgerBytes);
    const resources = await readPaperMathResources();
    const prompt = buildPaperMathPrompt({ mainTex, ledger, ...resources });
    const binding = { ...selector,
      mainSha256: hash(mainTexBytes), ledgerSha256: hash(ledgerBytes),
      contractSha256: hash(Buffer.from(resources.contract)), verifierPromptSha256: hash(Buffer.from(resources.verifierPrompt)),
      promptSha256: hash(Buffer.from(prompt)) };
    check(binding.contractSha256 === PAPER_MATH_PINS.contractSha256
      && binding.verifierPromptSha256 === PAPER_MATH_PINS.verifierPromptSha256, 'PROJECT_PAPER_MATH_RESOURCE_INVALID');
    const assertSource = async () => {
      await authorize(); guard();
      for (const entry of sourceReports) check(hash(JSON.stringify(entry.report.meta)) === entry.identity, 'PROJECT_PAPER_MATH_SOURCE_CHANGED');
      if (stitchedSource) {
        await stitchedSource.checkDelivery();
        check(hash(stitchedSource.bytes) === binding.mainSha256
          && hash(Buffer.from(stitchedSource.ledger, 'utf8')) === binding.ledgerSha256, 'PROJECT_PAPER_MATH_SOURCE_CHANGED');
      } else {
        check(singleSource && hash(JSON.stringify(singleSource.report.meta)) === singleSource.identity
          && JSON.stringify(singleSource.report.meta.artifacts?.source) === JSON.stringify(singleSource.mainArtifact)
          && JSON.stringify(singleSource.report.meta.artifacts?.ledger) === JSON.stringify(singleSource.ledgerArtifact),
        'PROJECT_PAPER_MATH_SOURCE_CHANGED');
        const [latestMain, latestLedger] = await Promise.all([store.read(singleSource.mainArtifact.artifact), store.read(singleSource.ledgerArtifact.artifact)]);
        guard();
        check(latestMain.length === singleSource.mainArtifact.bytes && hash(latestMain) === binding.mainSha256
          && latestLedger.length === singleSource.ledgerArtifact.bytes && hash(latestLedger) === binding.ledgerSha256,
        'PROJECT_PAPER_MATH_SOURCE_CHANGED');
      }
      const latest = await readPaperMathResources();
      check(hash(Buffer.from(latest.contract)) === binding.contractSha256
        && hash(Buffer.from(latest.verifierPrompt)) === binding.verifierPromptSha256
        && hash(Buffer.from(buildPaperMathPrompt({ mainTex, ledger, ...latest }))) === binding.promptSha256,
      'PROJECT_PAPER_MATH_RESOURCE_INVALID');
      guard();
    };
    return { binding, prompt, assertSource };
  }
  async function auditSource(p, audit) {
    const source = get(p, audit.sourceReportId), meta = source.meta;
    check(meta.kind === 'paper-source' && meta.projectId === p.meta.projectId && meta.paper.paperId === audit.paperId
      && meta.state === 'completed' && meta.sourceStatus !== 'invalid' && !meta.leakFindings?.length
      && !meta.artifacts?.quarantinedSource && !meta.artifacts?.invalidSource, 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
    const outputs = {};
    for (const [role, name] of [['source', 'main.tex'], ['ledger', 'REFERENCE_LEDGER.md']]) {
      const artifact = meta.artifacts?.[role];
      check(artifact?.name === name && artifact.artifact === `${directory(p, meta.reportId)}/${name}`
        && Number.isSafeInteger(artifact.bytes) && artifact.bytes <= PAPER_ARTIFACT_MAX_BYTES
        && /^[a-f0-9]{64}$/.test(artifact.sha256), 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
      const bytes = await store.read(artifact.artifact);
      check(bytes.length === artifact.bytes && hash(bytes) === artifact.sha256, 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
      outputs[role] = bytes;
    }
    check(!meta.cleanupPending && !source.failedSave, 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
    if (audit.mainSha256) check(meta.artifacts.source.sha256 === audit.mainSha256
      && meta.artifacts.ledger.sha256 === audit.ledgerSha256, 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
    return { source, outputs };
  }
  const strictText = bytes => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    check(Buffer.from(text, 'utf8').equals(bytes), 'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID');
    return text;
  };
  async function verificationSource(p, verification) {
    // Capture all source identities/descriptors before the first asynchronous read.
    const expected = copy(verification), audit = get(p, expected.auditReportId), a = audit.meta;
    const auditState = () => JSON.stringify([a.kind, a.projectId, a.reportId, a.state, a.cleanupPending, a.stopRequested,
      a.taskCreating, a.scheduleCreating, a.writerStarting, a.taskSettlement, a.error, a.audit, a.artifacts?.audit]);
    check(a.kind === 'reference-audit' && a.state === 'completed' && a.audit?.paperId === expected.paperId
      && !a.cleanupPending && !a.stopRequested && !a.taskCreating && !a.scheduleCreating && !a.writerStarting
      && a.taskSettlement === 'confirmed' && !a.error && !audit.failedSave, 'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID');
    const auditBinding = auditState(), auditPayload = copy(a.audit), artifact = copy(a.artifacts?.audit);
    const source = get(p, auditPayload.sourceReportId), s = source.meta;
    const sourceState = () => JSON.stringify([s.kind, s.projectId, s.reportId, s.state, s.cleanupPending, s.stopRequested,
      s.paper?.paperId, s.sourceStatus, s.leakFindings, s.artifacts?.source, s.artifacts?.ledger, s.artifacts?.quarantinedSource, s.artifacts?.invalidSource]);
    const sourceBinding = sourceState();
    check((expected.sourceReportId === undefined || expected.sourceReportId === auditPayload.sourceReportId)
      && auditPayload.boundContractSha256 === auditPayload.contractSha256
      && auditPayload.boundAuditorPromptSha256 === auditPayload.auditorPromptSha256
      && auditPayload.boundPromptSha256 === auditPayload.promptSha256,
    'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID');
    check(artifact?.name === 'REFERENCE_AUDIT.md' && artifact.artifact === `${directory(p, a.reportId)}/REFERENCE_AUDIT.md`
      && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && artifact.bytes <= PAPER_ARTIFACT_MAX_BYTES
      && typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256), 'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID');
    const checked = await auditSource(p, auditPayload);
    const findings = await store.read(artifact.artifact);
    check(audit.meta === a && source.meta === s && checked.source === source && auditState() === auditBinding
      && sourceState() === sourceBinding && !audit.failedSave && !source.failedSave
      && findings.length === artifact.bytes && hash(findings) === artifact.sha256,
    'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID');
    check(auditPayload.mainSha256 === s.artifacts.source.sha256 && auditPayload.ledgerSha256 === s.artifacts.ledger.sha256
      && (!expected.mainSha256 || expected.mainSha256 === auditPayload.mainSha256)
      && (!expected.ledgerSha256 || expected.ledgerSha256 === auditPayload.ledgerSha256)
      && (!expected.auditSha256 || expected.auditSha256 === artifact.sha256), 'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID');
    return { sourceReportId: s.reportId, mainSha256: auditPayload.mainSha256, ledgerSha256: auditPayload.ledgerSha256,
      auditSha256: artifact.sha256, mainTex: strictText(checked.outputs.source), ledger: strictText(checked.outputs.ledger), findings: strictText(findings) };
  }
  async function verificationMaterial(p, verification) {
    const [source, module] = await Promise.all([verificationSource(p, verification), import('./reference-verification.mjs')]);
    const resources = await module.readReferenceVerificationResources();
    check(['contract', 'verifierPrompt'].every(k => typeof resources[k] === 'string' && resources[k].isWellFormed()), 'PROJECT_REFERENCE_VERIFY_RESOURCE_INVALID');
    const keys = module.referenceVerificationKeys(source.ledger);
    check(keys.length > 0, 'PROJECT_REFERENCE_VERIFY_NO_TARGETS');
    const prompt = module.buildReferenceVerificationPrompt({ mainTex: source.mainTex, ledger: source.ledger, findings: source.findings, ...resources });
    check(Buffer.byteLength(prompt) <= 512 * 1024, 'PROJECT_SUMMARY_INPUT_TOO_LARGE');
    const hashes = { contractSha256: hash(Buffer.from(resources.contract)), verifierPromptSha256: hash(Buffer.from(resources.verifierPrompt)), promptSha256: hash(Buffer.from(prompt)) };
    if (verification.promptSha256) {
      check(hashes.contractSha256 === verification.boundContractSha256 && hashes.verifierPromptSha256 === verification.boundVerifierPromptSha256,
        'PROJECT_REFERENCE_VERIFY_RESOURCE_INVALID');
      check(hashes.promptSha256 === verification.boundPromptSha256 && JSON.stringify(keys) === JSON.stringify(verification.keys), 'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID');
    }
    return { ...source, ...hashes, keys, prompt, module };
  }
  async function readOperatorNotes(p, r) {
    const binding = copy(r.meta.revision), a = copy(r.meta.artifacts?.notes);
    check(binding.mode === 'operator-notes' && a && Object.keys(a).length === 5
      && a.name === 'OPERATOR_NOTES.md' && a.mime === 'text/markdown'
      && a.artifact === `${directory(p, r.meta.reportId)}/OPERATOR_NOTES.md`
      && a.bytes === binding.notesBytes && a.sha256 === binding.notesSha256, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    const bytes = await store.read(a.artifact);
    check(bytes.length === a.bytes && hash(bytes) === a.sha256 && JSON.stringify(r.meta.artifacts?.notes) === JSON.stringify(a)
      && JSON.stringify(r.meta.revision) === JSON.stringify(binding), 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    // A leading U+FEFF is valid operator text, not an encoding directive to strip.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    check(Buffer.from(text, 'utf8').equals(bytes) && validOperatorNotes(text), 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    return text;
  }
  async function notesRevisionMaterial(p, selector, report, admissionNotes) {
    const expected = copy(selector), source = get(p, expected.sourceReportId), s = source.meta;
    const cleanParent = () => s.kind === 'paper-source' && s.projectId === p.meta.projectId && s.reportId === expected.sourceReportId
      && s.paper?.paperId === expected.paperId && s.state === 'completed' && ['generated', 'flagged'].includes(s.sourceStatus)
      && !s.cleanupPending && !s.stopRequested && !s.taskCreating && !s.scheduleCreating && !s.writerStarting && !s.scheduleId
      && s.taskSettlement === 'confirmed' && !s.error && !source.failedSave && !s.leakFindings?.length
      && !s.artifacts?.quarantinedSource && !s.artifacts?.invalidSource
      && s.creator?.sessionId === p.meta.creator.sessionId && s.creator?.sessionPath === p.meta.creator.sessionPath;
    check(cleanParent(), 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    const captured = JSON.stringify(s);
    const read = async (role, name) => {
      const a = copy(s.artifacts?.[role]);
      check(a?.name === name && a.artifact === `${directory(p, s.reportId)}/${name}`
        && Number.isSafeInteger(a.bytes) && a.bytes >= 0 && a.bytes <= PAPER_ARTIFACT_MAX_BYTES
        && typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256), 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
      const bytes = await store.read(a.artifact);
      check(bytes.length === a.bytes && hash(bytes) === a.sha256, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
      strictText(bytes); return bytes;
    };
    const [main, ledger, provenance, revisionModule] = await Promise.all([
      read('source', 'main.tex'), read('ledger', 'REFERENCE_LEDGER.md'), read('provenance', 'provenance.json'), import('./paper-revision.mjs')]);
    const notes = report ? await readOperatorNotes(p, report) : admissionNotes;
    check(validOperatorNotes(notes), 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    const resources = await revisionModule.readPaperRevisionResources();
    const prompt = revisionModule.buildPaperNotesRevisionPrompt({ mainTex: strictText(main), ledger: strictText(ledger), notes, resources });
    check(Buffer.byteLength(prompt) <= 512 * 1024, 'PROJECT_SUMMARY_INPUT_TOO_LARGE');
    const hashes = { mode: 'operator-notes', sourceReportId: s.reportId, paperId: s.paper.paperId, sourceStatus: s.sourceStatus,
      mainSha256: hash(main), ledgerSha256: hash(ledger), provenanceSha256: hash(provenance), notesSha256: hash(Buffer.from(notes)), notesBytes: Buffer.byteLength(notes),
      contractSha256: hash(Buffer.from(resources.contract)), reviserPromptSha256: hash(Buffer.from(resources.reviserPrompt)),
      styleSha256: hash(Buffer.from(resources.style)), promptSha256: hash(Buffer.from(prompt)) };
    if (report) check(await readOperatorNotes(p, report) === notes, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    check(source.meta === s && JSON.stringify(s) === captured && cleanParent(), 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    for (const [key, value] of Object.entries(hashes)) check(expected[key] === undefined || expected[key] === value, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    return { hashes, prompt, mainTex: strictText(main), ledger, provenance, module: revisionModule };
  }
  async function revisionMaterial(p, selector, report = null, admissionNotes) {
    if (selector.mode === 'operator-notes') return notesRevisionMaterial(p, selector, report, admissionNotes);
    const expected = copy(selector), parent = get(p, expected.verificationReportId), v = parent.meta;
    const cleanParent = r => r.meta.state === 'completed' && !r.meta.cleanupPending && !r.meta.stopRequested
      && !r.meta.taskCreating && !r.meta.scheduleCreating && !r.meta.writerStarting
      && r.meta.taskSettlement === 'confirmed' && !r.meta.error && !r.failedSave
      && r.meta.creator?.sessionId === p.meta.creator.sessionId && r.meta.creator?.sessionPath === p.meta.creator.sessionPath;
    check(v.kind === 'reference-verification' && v.verification?.paperId === expected.paperId && cleanParent(parent), 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    const parentSnapshot = JSON.stringify(v), binding = copy(v.verification);
    const source = get(p, binding.sourceReportId), s = source.meta;
    check(s.kind === 'paper-source' && ['generated', 'flagged'].includes(s.sourceStatus) && cleanParent(source), 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    const sourceSnapshot = JSON.stringify(s);
    const original = await verificationSource(p, binding);
    const readArtifact = async (record, role, name) => {
      const a = copy(record.meta.artifacts?.[role]);
      check(a?.name === name && a.artifact === `${directory(p, record.meta.reportId)}/${name}`
        && Number.isSafeInteger(a.bytes) && a.bytes >= 0 && a.bytes <= PAPER_ARTIFACT_MAX_BYTES
        && typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256), 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
      const bytes = await store.read(a.artifact);
      check(bytes.length === a.bytes && hash(bytes) === a.sha256, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
      return bytes;
    };
    const [rawVerdicts, ledger, provenance, module, revisionModule] = await Promise.all([
      readArtifact(parent, 'verdicts', 'REFERENCE_VERDICTS.json'), readArtifact(parent, 'ledger', 'REFERENCE_LEDGER.md'),
      readArtifact(source, 'provenance', 'provenance.json'), import('./reference-verification.mjs'), import('./paper-revision.mjs')]);
    // Never trust normalized child JSON: validate again against the original, pre-verification ledger.
    const verdicts = module.parseReferenceVerdicts(strictText(rawVerdicts), original.ledger);
    check(module.applyReferenceVerdicts(original.ledger, verdicts) === strictText(ledger), 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    const promotions = verdicts.filter(row => ['verified', 'corrected'].includes(row.verdict)).length;
    const citationStatus = promotions === verdicts.length ? 'verified' : promotions ? 'partial' : 'unverified';
    check(binding.citationStatus === citationStatus, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    const resources = await revisionModule.readPaperRevisionResources();
    const prompt = revisionModule.buildPaperRevisionPrompt({ mainTex: original.mainTex, verdicts, resources });
    check(Buffer.byteLength(prompt) <= 512 * 1024, 'PROJECT_SUMMARY_INPUT_TOO_LARGE');
    const hashes = { sourceReportId: binding.sourceReportId, paperId: binding.paperId, mainSha256: original.mainSha256,
      verdictsSha256: hash(rawVerdicts), ledgerSha256: hash(ledger), originalLedgerSha256: original.ledgerSha256,
      provenanceSha256: hash(provenance), citationStatus, sourceStatus: s.sourceStatus, contractSha256: hash(Buffer.from(resources.contract)),
      reviserPromptSha256: hash(Buffer.from(resources.reviserPrompt)), styleSha256: hash(Buffer.from(resources.style)), promptSha256: hash(Buffer.from(prompt)) };
    check(parent.meta === v && source.meta === s && JSON.stringify(v) === parentSnapshot && JSON.stringify(s) === sourceSnapshot
      && cleanParent(parent) && cleanParent(source), 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    for (const [key, value] of Object.entries(hashes)) check(expected[key] === undefined || expected[key] === value, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
    return { hashes, prompt, mainTex: original.mainTex, ledger, provenance, module: revisionModule };
  }
  async function runRevision(p, r, guard, assertActive) {
    const binding = copy(r.meta.revision), encoded = JSON.stringify(binding);
    const recheck = async () => {
      assertActive(); check(JSON.stringify(r.meta.revision) === encoded, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
      const material = await revisionMaterial(p, binding, r);
      assertActive(); check(JSON.stringify(r.meta.revision) === encoded, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
      await guard();
      if (binding.mode === 'operator-notes') {
        // Authority reads await the Host: collect archived inputs again afterwards, not from the call text.
        const latest = await revisionMaterial(p, binding, r);
        assertActive(); check(JSON.stringify(r.meta.revision) === encoded, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
        return latest;
      }
      return material;
    };
    const input = await recheck(), cwd = await store.mkdir(directory(p, r.meta.reportId));
    await recheck(); r.meta.writerStarting = true; r.meta.cleanupPending = true; await save(p, r); assertActive();
    const handle = await summaryWriter.start({ projectId: r.meta.projectId, reportId: r.meta.reportId, kind: 'paper-revision',
      ...(binding.mode === 'operator-notes' ? { revisionMode: 'operator-notes' } : {}), prompt: input.prompt, cwd, deadlineAt: Date.now() + 30 * 60 * 1000, assertActive,
      onBound: async writer => {
        r.meta.writer = { ...copy(writer), state: 'preparing', cleanupPending: true }; await save(p, r);
        await recheck(); return { ok: true };
      },
      onUpdate: async snapshot => { r.meta.writer = copy(snapshot); await save(p, r); return { ok: true }; } });
    r.handle = handle; r.meta.writerStarting = false; await save(p, r);
    const terminal = await handle.done;
    r.meta.writer = copy(terminal); r.meta.cleanupPending = terminal?.cleanupPending !== false; await save(p, r);
    if (binding.mode === 'operator-notes') await recheck();
    if (typeof terminal?.finalText === 'string') {
      check(terminal.finalText.isWellFormed(), 'PROJECT_PAPER_REVISION_PATCH_INVALID');
      await paperArtifact(p, r, 'response', Buffer.from(terminal.finalText), 'text/plain');
      r.meta.sha256 = r.meta.artifacts.response.sha256; r.meta.bytes = r.meta.artifacts.response.bytes; await save(p, r);
    }
    assertActive(); check(terminal?.state === 'completed' && terminal.modelStopReason === 'stop' && terminal.cleanupPending === false
      && typeof terminal.finalText === 'string' && terminal.finalText.trim(), 'PROJECT_SUMMARY_WRITER_FAILED');
    if (binding.mode === 'operator-notes') await recheck();
    const applied = input.module.applyPaperRevision(input.mainTex, terminal.finalText);
    r.meta.revisionOutcome = copy(applied.outcome);
    // Even a no-op must reject malformed inherited provenance, never bypass its gate.
    const provenanceReconciliation = input.module.reconcilePaperRevisionProvenance(strictText(input.provenance));
    if (applied.outcome.status === 'no_edits_applied') {
      await recheck();
      await exclusive(r, async () => {
        await recheck(); current(p, r);
        r.meta.sourceStatus = 'not-produced'; r.meta.sha256 = null; r.meta.bytes = null;
        r.meta.state = 'completed'; r.meta.completedAt = Date.now(); r.meta.cleanupPending = false;
        await save(p, r);
      });
      return;
    }
    const citationKeyCheck = input.module.checkPaperRevisionCitationKeys(applied.tex, strictText(input.ledger));
    const provenanceWarning = 'All provenance for edited TeX is unresolved; the inherited mapping is a historical-only archive, not reusable validation.';
    if (!applied.findings.warnings.includes(provenanceWarning)) applied.findings.warnings.push(provenanceWarning);
    const citationBlocker = 'Revision literal citation-key check is flagged or incomplete; inspect the proposal diagnostics. This is a syntactic-only check, not citation verification.';
    if (citationKeyCheck.status !== 'no-literal-key-issues' && !applied.findings.blockers.includes(citationBlocker)) applied.findings.blockers.push(citationBlocker);
    await recheck();
    const proposal = { schemaVersion: 1, kind: 'paper-revision', proposalOnly: true, publicationStatus: 'reviewable-proposal',
      binding, revisionOutcome: copy(applied.outcome),
      sourceStatus: binding.sourceStatus === 'flagged' || applied.findings.blockers.length ? 'flagged' : 'generated', findings: applied.findings,
      provenanceReconciliation, citationKeyCheck,
      ...(binding.mode === 'operator-notes' ? { citationStatus: 'not-requested' }
        : { citationStatus: 'inherited-verification-source-judgment', inheritedCitationStatus: binding.citationStatus }),
      provenance: { sourceReportId: binding.sourceReportId, sha256: binding.provenanceSha256, status: 'inherited-not-revalidated' },
      mathematicsStatus: 'unreviewed', reviewStatus: 'unreviewed', compileStatus: 'not-run',
      scope: binding.mode === 'operator-notes'
        ? 'Operator-notes proposal; notes authenticate neither identities nor mathematics. Mechanical editorial-only scope and preservation of mathematics have not been established.'
        : 'Citation-targeted proposal; mechanical citation-only scope and preservation of mathematics have not been established.' };
    for (const [role, bytes, mime] of [
      ['source', Buffer.from(applied.tex), 'application/x-tex'], ['summary', Buffer.from(applied.summary), 'text/markdown'],
      ['proposal', Buffer.from(JSON.stringify(proposal, null, 2) + '\n'), 'application/json'],
      ['ledger', input.ledger, 'text/markdown'], ['provenance', input.provenance, 'application/json']]) {
      await recheck(); await paperArtifact(p, r, role, bytes, mime);
    }
    await recheck();
    await exclusive(r, async () => {
      if (binding.mode === 'operator-notes') await recheck();
      current(p, r); r.meta.findings = copy(applied.findings); r.meta.sourceStatus = proposal.sourceStatus;
      r.meta.sha256 = r.meta.artifacts.source.sha256; r.meta.bytes = r.meta.artifacts.source.bytes;
      r.meta.state = 'completed'; r.meta.completedAt = Date.now(); r.meta.cleanupPending = false; await save(p, r);
    });
  }
  function paperMathWriterRecord(p, r, snapshot, cwd, allowPrepared = false) {
    const field = name => {
      const descriptor = snapshot && Object.getOwnPropertyDescriptor(snapshot, name);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    };
    const expectedKind = `math-paper-math-verification:${r.meta.projectId}:${r.meta.reportId}`;
    const agentId = field('agentId'), sessionId = field('sessionId'), sessionPath = field('sessionPath');
    const sendState = field('sendState'), sendPending = field('sendPending') === true;
    const unbound = sessionId == null && sessionPath == null;
    check(field('role') === 'report-writer' && typeof agentId === 'string'
      && /^paper-math-verifier-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(agentId)
      && field('kind') === expectedKind && field('cwd') === cwd
      && (unbound ? allowPrepared && field('state') === 'preparing' && sendPending === false && sendState === 'not-sent'
        : typeof sessionId === 'string' && sessionId.length > 0 && typeof sessionPath === 'string' && sessionPath.length > 0),
    'PROJECT_PAPER_MATH_WRITER_IDENTITY_INVALID');
    const state = field('state');
    // Keep the public writer projection valid JSON without publishing arbitrary
    // Host fields or reporting empty tools before the sender actually saw them.
    const tools = field('toolSelection');
    const empty = a => Array.isArray(a) && a.length === 0;
    const toolSelection = tools?.effective === 'current' && tools.pendingToolNames === null
      && empty(tools.requested) && empty(tools.resolved)
      ? { requested: [], resolved: [], effective: 'current', pendingToolNames: null } : null;
    const model = researchSessionDiagnostics({ actualModel: field('model') }).actualModel;
    return { role: 'report-writer', agentId, model, toolSelection, sessionId: unbound ? null : sessionId, sessionPath: unbound ? null : sessionPath,
      cwd, kind: expectedKind,
      state: ['preparing', 'running', 'completed', 'failed', 'stopped', 'timed-out'].includes(state) ? state : 'preparing',
      cleanupPending: field('cleanupPending') === true, sendPending,
      sendState: ['not-sent', 'pending', 'accepted', 'rejected', 'unconfirmed'].includes(sendState) ? sendState : 'unconfirmed',
      ...researchSessionDiagnostics(snapshot) };
  }
  function stoppedWriterEvidence(p, r, snapshot) {
    if (r.meta.kind === 'paper-math-verification') {
      // A model/configuration failure can stop the sender before a Host
      // session exists. There is no new binding to record in that case.
      if (snapshot?.sessionId == null && snapshot?.sessionPath == null) return r.meta.writer;
      return paperMathWriterRecord(p, r, snapshot, store.absolute(directory(p, r.meta.reportId)));
    }
    return linearKind(r.meta.kind) ? planWriterEvidence(snapshot) : copy(snapshot);
  }
  async function runPaperMathVerification(p, r, guard, assertActive) {
    const binding = copy(r.meta.math), selector = Object.fromEntries(Object.entries(binding)
      .filter(([key]) => key === 'sourceReportId' || key === 'planReportId' || key === 'finalSectionReportId'));
    const recheck = async () => {
      assertActive(); check(JSON.stringify(r.meta.math) === JSON.stringify(binding), 'PROJECT_PAPER_MATH_SOURCE_CHANGED');
      const material = await paperMathSource(p, selector, assertActive, async () => { await guard(); });
      check(JSON.stringify(material.binding) === JSON.stringify(binding), 'PROJECT_PAPER_MATH_SOURCE_CHANGED');
      await material.assertSource(); assertActive(); await guard();
      return material;
    };
    let input = await recheck();
    const cwd = await store.mkdir(directory(p, r.meta.reportId)); await recheck();
    r.meta.writerStarting = true; r.meta.cleanupPending = true; await save(p, r); assertActive();
    const handle = await summaryWriter.start({ projectId: r.meta.projectId, reportId: r.meta.reportId,
      kind: 'paper-math-verification', prompt: input.prompt, cwd, deadlineAt: Date.now() + 30 * 60 * 1000, assertActive,
      onBound: async writer => {
        r.meta.writer = { ...paperMathWriterRecord(p, r, writer, cwd), state: 'preparing', cleanupPending: true };
        await save(p, r); await recheck(); return { ok: true };
      },
      onUpdate: async snapshot => {
        const next = paperMathWriterRecord(p, r, snapshot, cwd, true);
        const prior = r.meta.writer;
        // The sender reports prepared snapshots before session creation. After
        // binding, keep the real stable identity; never persist finalText.
        if (prior?.sessionId) check(next.agentId === prior.agentId && next.sessionId === prior.sessionId
          && next.sessionPath === prior.sessionPath && next.kind === prior.kind, 'PROJECT_PAPER_MATH_WRITER_IDENTITY_INVALID');
        r.meta.writer = next; await save(p, r);
        if (next.sendPending && ['pending', 'running'].includes(next.sendState)) await recheck();
        else { assertActive(); await guard(); }
        return { ok: true };
      } });
    r.handle = handle; r.meta.writerStarting = false; await save(p, r);
    const terminal = await handle.done;
    r.meta.writer = paperMathWriterRecord(p, r, terminal, cwd); r.meta.cleanupPending = terminal?.cleanupPending !== false; await save(p, r);
    if (typeof terminal?.finalText === 'string') {
      check(Buffer.byteLength(terminal.finalText) <= PAPER_ARTIFACT_MAX_BYTES, 'PROJECT_PAPER_OUTPUT_TOO_LARGE');
      await paperArtifact(p, r, 'response', Buffer.from(terminal.finalText), 'text/plain');
    }
    assertActive(); check(terminal?.state === 'completed' && terminal.modelStopReason === 'stop'
      && terminal.cleanupPending === false && typeof terminal.finalText === 'string' && terminal.finalText.trim(), 'PROJECT_SUMMARY_WRITER_FAILED');
    const parsed = parsePaperMathReport(terminal.finalText);
    await recheck();
    const limitations = ['Whole supplied manuscript and ledger text only; no fact graph was queried.',
      'References were not independently verified; citation applicability is not certified.',
      'No executable mathematics, formal verification, compilation or publication review was performed.'];
    const review = { schemaVersion: 1, kind: 'paper-math-verification', projectId: r.meta.projectId, reportId: r.meta.reportId,
      binding: copy(binding), findings: copy(parsed.findings), report: parsed.report, verdict: parsed.verdict, limitations };
    await paperArtifact(p, r, 'review', Buffer.from(JSON.stringify(review, null, 2) + '\n'), 'application/json');
    await recheck();
    await exclusive(r, async () => {
      current(p, r); check(JSON.stringify(r.meta.math) === JSON.stringify(binding), 'PROJECT_PAPER_MATH_SOURCE_CHANGED');
      r.meta.mathVerdict = parsed.verdict; r.meta.sha256 = r.meta.artifacts.review.sha256;
      r.meta.bytes = r.meta.artifacts.review.bytes; r.meta.state = 'completed'; r.meta.completedAt = Date.now();
      r.meta.cleanupPending = false;
      mathReviewChecks.set(r, { binding: JSON.stringify(binding), sha256: r.meta.artifacts.review.sha256, verdict: parsed.verdict });
      await save(p, r);
    });
  }
  async function runVerification(p, r, guard, assertActive) {
    const binding = copy(r.meta.verification), encodedBinding = JSON.stringify(binding);
    const recheck = async () => {
      assertActive(); check(JSON.stringify(r.meta.verification) === encodedBinding, 'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID');
      const value = await verificationMaterial(p, binding);
      assertActive(); check(JSON.stringify(r.meta.verification) === encodedBinding, 'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID');
      await guard(); return value;
    };
    const input = await recheck(), cwd = await store.mkdir(directory(p, r.meta.reportId));
    await recheck();
    r.meta.writerStarting = true; r.meta.cleanupPending = true; await save(p, r); assertActive();
    const handle = await summaryWriter.start({ projectId: r.meta.projectId, reportId: r.meta.reportId, kind: 'reference-verification',
      prompt: input.prompt, cwd, deadlineAt: Date.now() + 30 * 60 * 1000, assertActive,
      onBound: async writer => {
        // Retain actual late identity for cleanup, but never authorize a late send.
        r.meta.writer = { ...copy(writer), state: 'preparing', cleanupPending: true }; await save(p, r);
        await recheck(); return { ok: true };
      },
      onUpdate: async snapshot => { r.meta.writer = copy(snapshot); await save(p, r); return { ok: true }; } });
    r.handle = handle; r.meta.writerStarting = false; await save(p, r);
    const terminal = await handle.done; r.meta.writer = copy(terminal); r.meta.cleanupPending = terminal?.cleanupPending !== false; await save(p, r);
    if (typeof terminal?.finalText === 'string') {
      check(terminal.finalText.isWellFormed(), 'PROJECT_REFERENCE_VERIFY_OUTPUT_INVALID');
      await paperArtifact(p, r, 'response', Buffer.from(terminal.finalText), 'text/plain');
      r.meta.sha256 = r.meta.artifacts.response.sha256; r.meta.bytes = r.meta.artifacts.response.bytes; await save(p, r);
    }
    assertActive(); check(terminal?.state === 'completed' && terminal.modelStopReason === 'stop' && terminal.cleanupPending === false
      && typeof terminal.finalText === 'string' && terminal.finalText.trim(), 'PROJECT_SUMMARY_WRITER_FAILED');
    const verdicts = input.module.parseReferenceVerdicts(terminal.finalText, input.ledger);
    const ledger = input.module.applyReferenceVerdicts(input.ledger, verdicts);
    await recheck();
    await paperArtifact(p, r, 'verdicts', Buffer.from(JSON.stringify(verdicts, null, 2) + '\n'), 'application/json');
    await recheck();
    await paperArtifact(p, r, 'ledger', Buffer.from(ledger), 'text/markdown');
    await recheck();
    await exclusive(r, async () => {
      current(p, r);
      const promotions = verdicts.filter(v => ['verified', 'corrected'].includes(v.verdict)).length;
      r.meta.verification.citationStatus = promotions === binding.keys.length ? 'verified' : promotions > 0 ? 'partial' : 'unverified';
      r.meta.sha256 = r.meta.artifacts.verdicts.sha256; r.meta.bytes = r.meta.artifacts.verdicts.bytes;
      r.meta.state = 'completed'; r.meta.completedAt = Date.now(); r.meta.cleanupPending = false; await save(p, r);
    });
  }
  async function runAudit(p, r, guard, assertActive) {
    const { buildReferenceAuditPrompt, readReferenceAuditResources } = await import('./paper-source.mjs');
    let checked = await auditSource(p, r.meta.audit);
    const resources = await readReferenceAuditResources();
    const decode = bytes => {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      check(Buffer.from(value, 'utf8').equals(bytes), 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
      return value;
    };
    const prompt = buildReferenceAuditPrompt({ mainTex: decode(checked.outputs.source), ledger: decode(checked.outputs.ledger), ...resources });
    check(Buffer.byteLength(prompt) <= 512 * 1024, 'PROJECT_SUMMARY_INPUT_TOO_LARGE');
    check(hash(Buffer.from(resources.contract)) === r.meta.audit.boundContractSha256
      && hash(Buffer.from(resources.auditorPrompt)) === r.meta.audit.boundAuditorPromptSha256,
    'PROJECT_REFERENCE_AUDIT_RESOURCE_INVALID');
    checked = await auditSource(p, r.meta.audit); assertActive(); await guard();
    check(hash(Buffer.from(prompt)) === r.meta.audit.boundPromptSha256, 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
    await save(p, r);
    const cwd = await store.mkdir(directory(p, r.meta.reportId));
    r.meta.writerStarting = true; r.meta.cleanupPending = true; await save(p, r);
    const handle = await summaryWriter.start({ projectId: r.meta.projectId, reportId: r.meta.reportId, prompt, cwd,
      kind: 'reference-audit', deadlineAt: Date.now() + 30 * 60 * 1000, assertActive,
      onBound: async binding => {
        const latest = await auditSource(p, r.meta.audit);
        check(latest.source.meta.artifacts.source.sha256 === r.meta.audit.mainSha256
          && latest.source.meta.artifacts.ledger.sha256 === r.meta.audit.ledgerSha256, 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
        const latestResources = await readReferenceAuditResources();
        check(hash(Buffer.from(latestResources.contract)) === r.meta.audit.boundContractSha256
          && hash(Buffer.from(latestResources.auditorPrompt)) === r.meta.audit.boundAuditorPromptSha256,
        'PROJECT_REFERENCE_AUDIT_RESOURCE_INVALID');
        r.meta.writer = { ...copy(binding), state: 'preparing', cleanupPending: true }; await save(p, r); assertActive(); return { ok: true };
      },
      onUpdate: async snapshot => { r.meta.writer = copy(snapshot); await save(p, r); return { ok: true }; } });
    r.handle = handle; r.meta.writerStarting = false; await save(p, r);
    const terminal = await handle.done; r.meta.writer = copy(terminal); r.meta.cleanupPending = terminal?.cleanupPending !== false; await save(p, r);
    if (typeof terminal?.finalText === 'string') {
      check(Buffer.byteLength(terminal.finalText) <= PAPER_ARTIFACT_MAX_BYTES, 'PROJECT_PAPER_OUTPUT_TOO_LARGE');
      await paperArtifact(p, r, 'response', Buffer.from(terminal.finalText), 'text/plain');
    }
    assertActive(); check(terminal?.state === 'completed' && terminal.modelStopReason === 'stop'
      && terminal.cleanupPending === false && typeof terminal.finalText === 'string' && terminal.finalText.trim(), 'PROJECT_SUMMARY_WRITER_FAILED');
    const report = Buffer.from(terminal.finalText, 'utf8');
    await paperArtifact(p, r, 'audit', report, 'text/markdown');
    r.meta.sha256 = r.meta.artifacts.audit.sha256; r.meta.bytes = report.length;
    await exclusive(r, async () => {
      current(p, r); r.meta.state = 'completed'; r.meta.completedAt = Date.now(); r.meta.cleanupPending = false;
      r.meta.audit.citationStatus = 'unverified'; await save(p, r);
    });
  }
  async function readSavedPlan(p, r, read = name => store.read(name)) {
    const binding = copy(r.meta.plan), encoded = JSON.stringify(binding), artifacts = copy(r.meta.artifacts), spec = reportKindSpec('paper-plan'), bytes = {};
    check(artifacts && Object.keys(artifacts).length === 4, 'PROJECT_REPORT_ARTIFACT_INVALID');
    for (const [role, name] of Object.entries(spec.artifactNames)) {
      const a = artifacts[role], mime = role === 'response' ? 'text/plain' : role === 'ledger' ? 'text/markdown' : 'application/json';
      check(a && Object.keys(a).length === 5 && a.name === name && a.mime === mime && a.artifact === `${directory(p, r.meta.reportId)}/${name}`
        && Number.isSafeInteger(a.bytes) && a.bytes >= 0 && a.bytes <= PAPER_ARTIFACT_MAX_BYTES && /^[a-f0-9]{64}$/.test(a.sha256), 'PROJECT_REPORT_ARTIFACT_INVALID');
      bytes[role] = await read(a.artifact);
      check(bytes[role].length === a.bytes && hash(bytes[role]) === a.sha256, 'PROJECT_REPORT_ARTIFACT_INVALID');
    }
    const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const expected = planDocuments(decode(bytes.response), binding);
    check(JSON.stringify(JSON.parse(decode(bytes.blocks))) === JSON.stringify(expected.blocks)
      && JSON.stringify(JSON.parse(decode(bytes.plan))) === JSON.stringify(expected.document)
      && hash(bytes.ledger) === r.meta.plan.ledgerSha256 && r.meta.sha256 === artifacts.plan.sha256 && r.meta.bytes === artifacts.plan.bytes
      && JSON.stringify(r.meta.plan) === encoded && JSON.stringify(r.meta.artifacts) === JSON.stringify(artifacts), 'PROJECT_REPORT_ARTIFACT_INVALID');
    return freezeData({ binding, blocks: expected.blocks, document: expected.document, ledger: decode(bytes.ledger),
      artifacts: Object.fromEntries(Object.entries(artifacts).map(([role, a]) => [role, { sha256: a.sha256, bytes: a.bytes }])) });
  }
  async function readSavedSection(p, r, read = name => store.read(name)) {
    try {
      checkRecord(p, r.meta, r.meta.reportId);
      check(r.meta.writer?.sessionId && r.meta.writer?.sessionPath && r.meta.writer.state === 'completed'
        && r.meta.writer.modelStopReason === 'stop', 'PROJECT_REPORT_ARTIFACT_INVALID');
      const binding = copy(r.meta.section), encoded = JSON.stringify(binding), artifacts = copy(r.meta.artifacts), bytes = {};
      check(validSectionBinding(binding, p.meta.projectId, r.meta.reportId) && artifacts && Object.keys(artifacts).length === 5, 'PROJECT_REPORT_ARTIFACT_INVALID');
      for (const [role, name] of Object.entries(reportKindSpec('paper-section').artifactNames)) {
        const a = artifacts[role], mime = role === 'source' ? 'text/x-tex' : role === 'response' ? 'text/plain' : role === 'ledger' ? 'text/markdown' : 'application/json';
        check(a && Object.keys(a).length === 5 && a.name === name && a.mime === mime && a.artifact === `${directory(p, r.meta.reportId)}/${name}`
          && Number.isSafeInteger(a.bytes) && a.bytes >= 0 && a.bytes <= PAPER_ARTIFACT_MAX_BYTES && /^[a-f0-9]{64}$/.test(a.sha256), 'PROJECT_REPORT_ARTIFACT_INVALID');
        bytes[role] = await read(a.artifact);
        check(bytes[role].length === a.bytes && hash(bytes[role]) === a.sha256, 'PROJECT_REPORT_ARTIFACT_INVALID');
      }
      const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const expected = sectionDocuments(decode(bytes.response), binding);
      check(expected.document.publicationStatus === 'reviewable-section' && decode(bytes.source) === expected.tex
        && JSON.stringify(JSON.parse(decode(bytes.provenance))) === JSON.stringify(expected.provenance)
        && JSON.stringify(JSON.parse(decode(bytes.section))) === JSON.stringify(expected.document)
        && bytes.ledger.length === binding.source.artifacts.ledger.bytes && hash(bytes.ledger) === binding.source.artifacts.ledger.sha256
        && r.meta.sha256 === artifacts.source.sha256 && r.meta.bytes === artifacts.source.bytes && r.meta.sourceStatus === expected.document.sourceStatus
        && r.meta.provenanceStatus === expected.document.provenanceStatus && r.meta.findingsTruncated === expected.document.findingsTruncated
        && JSON.stringify(r.meta.findings) === JSON.stringify(expected.document.findings)
        && JSON.stringify(r.meta.section) === encoded && JSON.stringify(r.meta.artifacts) === JSON.stringify(artifacts), 'PROJECT_REPORT_ARTIFACT_INVALID');
      return freezeData({ binding, tex: expected.tex, document: expected.document, ledger: decode(bytes.ledger), artifacts: Object.fromEntries(Object.entries(artifacts).map(([role, a]) => [role, { sha256: a.sha256, bytes: a.bytes }])) });
    } catch { throw failure('PROJECT_REPORT_ARTIFACT_INVALID'); }
  }
  async function inspectSavedSection(p, r, statusRead = false) {
    try { return await readSavedSection(p, r); }
    catch (error) {
      // A concurrent reader may resume after both the downgrade and task settlement.
      // It must not rewrite or quarantine that already-interrupted record.
      if (r.meta.state === 'interrupted' && r.meta.archiveError === 'PROJECT_REPORT_ARTIFACT_INVALID') {
        if (statusRead) return null;
        throw error;
      }
      if (planCleanupPending(r.meta) || r.meta.taskSettlement !== 'confirmed' || r.failedSave || r.job && !r.jobSettled) {
        const converted = r.meta.state === 'completed';
        r.meta.archiveError = 'PROJECT_REPORT_ARTIFACT_INVALID'; setReportError(r.meta, r.meta.archiveError);
        r.meta.state = 'interrupted'; r.meta.cleanupPending ||= planCleanupPending(r.meta) || r.failedSave;
        await save(p, r).catch(() => {});
        if (statusRead && converted) return { readError: { code: 'PROJECT_REPORT_ARTIFACT_INVALID', phase: 'archive-validation' } };
      } else { records.delete(key(p, r.meta.reportId)); damaged.add(p.meta.projectId); }
      throw error;
    }
  }
  // Strictly read-only on the report archives: don't use inspectSavedSection,
  // which may quarantine a record or write an interrupted state on corruption.
  async function stitchInternal(p, { planReportId, finalSectionReportId }, authorize, guard) {
    const unavailable = 'PROJECT_PAPER_STITCH_NOT_READY', invalid = 'PROJECT_PAPER_STITCH_CHAIN_INVALID';
    const corrupted = 'PROJECT_REPORT_ARTIFACT_INVALID', witnessed = new Map(), selected = [], warnings = [];
    const sessionId = p.meta.creator.sessionId, projectId = p.meta.projectId;
    const alive = () => { guard(); check(!disposed && getProject(projectId) === p, 'PROJECT_DISPOSED'); };
    const clean = r => (r.meta.kind === 'paper-plan' ? planView(r).publicationStatus === 'reviewable-plan'
      : sectionView(r).publicationStatus === 'reviewable-section') && (!r.job || r.jobSettled)
      && r.meta.creator.sessionId === sessionId && r.meta.creator.sessionPath === p.meta.creator.sessionPath;
    const read = async name => {
      try {
        const { bytes, identity } = await store.readWitness(name);
        witnessed.set(name, identity); return bytes;
      } catch { throw failure(corrupted); }
    };
    const remember = async r => {
      alive(); check(clean(r), unavailable);
      const id = r.meta.reportId, signature = hash(JSON.stringify(r.meta));
      try {
        checkRecord(p, r.meta, id);
        check(hash(JSON.stringify(JSON.parse(await read(statePath(p, id))))) === signature, corrupted);
      } catch { throw failure(corrupted); }
      selected.push({ id, r, signature });
    };
    const assertSelected = () => {
      alive();
      for (const { id, r, signature } of selected) {
        check(records.get(key(p, id)) === r && clean(r) && hash(JSON.stringify(r.meta)) === signature, unavailable);
      }
    };
    await authorize(); alive();
    if (deferHistoricalWork === true) { await prepareHistory(p, authorize); alive(); }
    const parent = getKind(p, planReportId, { kind: 'paper-plan' }); await remember(parent);
    let saved;
    try { saved = await readSavedPlan(p, parent, read); } catch { throw failure(corrupted); }
    const source = { projectId, planReportId, paperId: saved.binding.paperId,
      planBindingSha256: hash(JSON.stringify(saved.binding)), artifacts: saved.artifacts };
    const sections = saved.document.normalizedSections, count = sections.length, seen = new Set();
    const assembly = paperStitchText(saved.blocks, PAPER_ARTIFACT_MAX_BYTES);
    let id = finalSectionReportId, rootId, nextLineage, warningBytes = 0;
    for (let i = count - 1; i >= 0; i--) {
      check(typeof id === 'string' && !seen.has(id), invalid); seen.add(id);
      const r = getKind(p, id, { kind: 'paper-section' }), material = r.meta.section.material, planned = sections[i];
      check(material.sectionIndex === i, invalid);
      const bytes = r.meta.artifacts?.source?.bytes;
      if (Number.isSafeInteger(bytes) && bytes >= 0) assembly.checkNext(bytes);
      await remember(r);
      const own = await readSavedSection(p, r, read), b = own.binding, m = b.material, l = b.lineage;
      rootId ??= l.chainRootReportId;
      check(JSON.stringify(b.source) === JSON.stringify(source) && b.sectionCount === count
        && m.sectionIndex === i && m.title === planned.title && m.label === planned.label && JSON.stringify(m.factIds) === JSON.stringify(planned.fact_ids)
        && m.parentMaterialSha256 === saved.binding.material.sha256 && l.chainRootReportId === rootId && own.ledger === saved.ledger
        && (!nextLineage || nextLineage.previousSectionReportId === id && nextLineage.previousSourceSha256 === own.artifacts.source.sha256
          && nextLineage.previousResultSha256 === own.artifacts.section.sha256), invalid);
      if (i === 0) check(id === rootId && l.previousSectionReportId === null, invalid);
      assembly.addPrevious(own.tex);
      const d = own.document;
      const details = { reportId: id, sectionIndex: i, provenanceStatus: d.provenanceStatus, sourceStatus: d.sourceStatus,
        warnings: d.findings.warnings, blockers: d.findings.blockers, findingsTruncated: d.findingsTruncated };
      warningBytes += Buffer.byteLength(JSON.stringify(details)) + 1;
      check(warningBytes <= PAPER_ARTIFACT_MAX_BYTES, 'PROJECT_PAPER_STITCH_TOO_LARGE');
      warnings.push(details);
      id = l.previousSectionReportId; nextLineage = l;
    }
    check(count > 0 && id === null, invalid); assertSelected();
    const { bytes, bibliographyStatus } = assembly.finish();
    const checkDelivery = async () => {
      assertSelected();
      // Revisit identities after export I/O, using the already verified bytes;
      // do not reread bodies or claim a filesystem transaction with Host stage.
      for (const [name, identity] of witnessed) {
        try { check(await store.fileIdentity(name) === identity, corrupted); }
        catch { throw failure(corrupted); }
      }
      await authorize(); assertSelected();
    };
    return { bytes, ledger: saved.ledger, sessionId, checkDelivery, selectedReports: selected.map(({ r, signature }) => ({ report: r, identity: signature })),
      summary: { projectId, paperId: source.paperId, planReportId, finalSectionReportId,
      chainRootReportId: rootId, sectionCount: count, sections: warnings.reverse(), bibliographyStatus, mathematicsStatus: 'unreviewed',
      citationStatus: 'not-checked', compileStatus: 'not-run', limitations: ['Frozen plan and selected archived chain only; current facts were not checked.',
        'Reviewable TeX text only: no TeX execution, macro safety, mathematical, citation, or compilation validation.'] } };
  }
  async function stitch(p, selector, authorize, guard) {
    const result = await stitchInternal(p, selector, authorize, guard);
    const { ledger, selectedReports, ...publicResult } = result;
    return publicResult;
  }
  async function sectionContext(p, selector, expectedSource = null) {
    const parent = getKind(p, selector.planReportId, { kind: 'paper-plan' });
    check(planView(parent).publicationStatus === 'reviewable-plan', 'PROJECT_PAPER_SECTION_PLAN_NOT_READY');
    const saved = await readSavedPlan(p, parent);
    const source = { projectId: p.meta.projectId, planReportId: parent.meta.reportId, paperId: saved.binding.paperId,
      planBindingSha256: hash(JSON.stringify(saved.binding)), artifacts: copy(saved.artifacts) };
    if (expectedSource) check(JSON.stringify(source) === JSON.stringify(expectedSource), 'PROJECT_PAPER_SECTION_SOURCE_CHANGED');
    const sections = saved.document.normalizedSections;
    const checkPredecessor = async (report, root = false) => {
      check(sectionView(report).publicationStatus === 'reviewable-section', root ? 'PROJECT_PAPER_SECTION_ROOT_INVALID' : 'PROJECT_PAPER_SECTION_PREVIOUS_NOT_READY');
      const own = await inspectSavedSection(p, report), b = own.binding, s = sections[b.material.sectionIndex];
      check(JSON.stringify(b.source) === JSON.stringify(source) && b.sectionCount === sections.length && s
        && s.title === b.material.title && s.label === b.material.label && JSON.stringify(s.fact_ids) === JSON.stringify(b.material.factIds)
        && b.material.parentMaterialSha256 === saved.binding.material.sha256, 'PROJECT_PAPER_SECTION_SOURCE_CHANGED');
      if (root) check(b.material.sectionIndex === 0 && b.lineage.chainRootReportId === report.meta.reportId, 'PROJECT_PAPER_SECTION_ROOT_INVALID');
      return own;
    };
    let previous = null, chainRootReportId = null;
    if (selector.previousSectionReportId) {
      const r = getKind(p, selector.previousSectionReportId, { kind: 'paper-section' }); previous = await checkPredecessor(r);
      chainRootReportId = previous.binding.lineage.chainRootReportId;
      const root = getKind(p, chainRootReportId, { kind: 'paper-section' }); await checkPredecessor(root, true);
    }
    // Ensure async archive reads did not admit a newly dirty/replaced producer.
    check(planView(parent).publicationStatus === 'reviewable-plan', 'PROJECT_PAPER_SECTION_PLAN_NOT_READY');
    if (previous) check(sectionView(get(p, selector.previousSectionReportId)).publicationStatus === 'reviewable-section'
      && sectionView(get(p, chainRootReportId)).publicationStatus === 'reviewable-section', 'PROJECT_PAPER_SECTION_PREVIOUS_NOT_READY');
    return { saved, source, previous, chainRootReportId, sectionIndex: previous ? previous.binding.material.sectionIndex + 1 : 0, sectionCount: sections.length };
  }
  async function sectionInput(p, selector, gathered, expected = null, context = null) {
    const parent = await sectionContext(p, selector, context?.source ?? expected?.source);
    if (context) check(parent.sectionIndex === context.sectionIndex && parent.chainRootReportId === context.chainRootReportId
      && JSON.stringify(parent.previous?.artifacts ?? null) === JSON.stringify(context.previous?.artifacts ?? null), 'PROJECT_PAPER_SECTION_SOURCE_CHANGED');
    const resources = await readSectionResources();
    const input = buildSectionPrompt({ ...gathered, resources, parentPlan: parent.saved.binding, normalizedSections: parent.saved.document.normalizedSections,
      sectionIndex: parent.sectionIndex, blocks: parent.saved.blocks, ledger: parent.saved.ledger });
    if (expected) check(input.hashes.promptSha256 === expected.promptSha256 && JSON.stringify(input.hashes.resources) === JSON.stringify(expected.resources)
      && JSON.stringify(input.material) === JSON.stringify(expected.material)
      && (parent.previous ? parent.previous.artifacts.source.sha256 === expected.lineage.previousSourceSha256
        && parent.previous.artifacts.section.sha256 === expected.lineage.previousResultSha256 && parent.chainRootReportId === expected.lineage.chainRootReportId
        : expected.lineage.previousSectionReportId === null), 'PROJECT_PAPER_SECTION_BINDING_CHANGED');
    return { input, context: parent };
  }
  async function runPlan(p, r, guard, assertActive) {
    let writerStartAttempted = false;
    const binding = copy(r.meta.plan), encoded = JSON.stringify(binding);
    const bound = () => { assertActive(); check(JSON.stringify(r.meta.plan) === encoded, 'PROJECT_PAPER_PLAN_BINDING_CHANGED'); };
    const originalAuthority = { guard, assertActive: bound, reportId: r.meta.reportId };
    const ipc = paperRunnerIpcScope?.(originalAuthority), authority = ipc?.authority ?? originalAuthority;
    const recheck = async () => {
      bound(); await guard();
      const gathered = await gatherPaperFacts(p.meta.projectId, authority, copy(binding.target), binding.factIds ?? []);
      bound(); const input = await planInput(gathered, binding);
      await guard(); await assertPaperTarget(p.meta.projectId, copy(binding.target)); bound(); return { input, gathered };
    };
    const recordWriter = async snapshot => {
      r.meta.writer = { ...planWriterEvidence(r.meta.writer), ...planWriterEvidence(snapshot) }; await save(p, r);
    };
    const recordTerminal = async terminal => {
      r.meta.cleanupPending = terminal?.cleanupPending !== false; await recordWriter(terminal);
    };
    let responseAttempted = false;
    const archiveResponse = async terminal => {
      if (responseAttempted || r.meta.artifacts?.response || typeof terminal?.finalText !== 'string') return;
      responseAttempted = true; let writing = false;
      try {
        check(terminal.finalText.isWellFormed(), 'PROJECT_PAPER_PLAN_OUTPUT_INVALID');
        const bytes = Buffer.from(terminal.finalText); check(bytes.length <= PAPER_ARTIFACT_MAX_BYTES, 'PROJECT_PAPER_OUTPUT_TOO_LARGE');
        writing = true; await paperArtifact(p, r, 'response', bytes, 'text/plain');
      } catch (error) {
        r.meta.responseError = code(error); if (writing) r.failedSave = true;
        throw error;
      }
    };
    try {
      const first = await recheck(); r.meta.asOf = first.gathered.asOf; r.meta.snapshotCapturedAt = Date.now(); await save(p, r);
      const cwd = await store.mkdir(directory(p, r.meta.reportId)); await recheck();
      r.meta.writerStarting = true; r.meta.cleanupPending = true; await save(p, r); await recheck();
      // No target lock spans start/onBound. onBound may perform its own fresh Core FIFO reads.
      writerStartAttempted = true;
      const handle = await summaryWriter.start({ projectId: r.meta.projectId, reportId: r.meta.reportId, kind: 'paper-plan',
        prompt: first.input.prompt, cwd, deadlineAt: Date.now() + 30 * 60 * 1000, assertActive: bound,
        onBound: async writer => {
          await recordWriter({ ...writer, state: 'preparing', cleanupPending: true });
          await recheck(); return { ok: true };
        }, onUpdate: async snapshot => { await recordWriter(snapshot); return { ok: true }; } });
      r.handle = handle; r.meta.writerStarting = false; await save(p, r);
      await recheck();
      const terminal = await handle.done; await recordTerminal(terminal); await archiveResponse(terminal);
      await recheck();
      check(terminal?.state === 'completed' && terminal.modelStopReason === 'stop' && terminal.cleanupPending === false
        && typeof terminal.finalText === 'string' && terminal.finalText.trim(), 'PROJECT_SUMMARY_WRITER_FAILED');
      const documents = planDocuments(terminal.finalText, binding);
      const publish = async action => {
        const target = copy(binding.target);
        bound(); await guard(); await assertPaperTarget(p.meta.projectId, target); bound();
        // Publication already gathers a fresh closure before taking the target lock.
        // Keep the former preflight's hard refusal on the first snapshot drift.
        await withPaperPublication(p.meta.projectId, authority, target, async latest => {
          assertPlanMaterial(latest, binding); await planInput(latest, binding); await guard(); bound();
          r.meta.snapshotAdvancedDuringWriting = latest.asOf !== first.gathered.asOf || first.gathered.asOf !== binding.material.admissionAsOf;
          await action();
        }, binding.factIds ?? [], { retryGraphChanged: false });
      };
      for (const [role, bytes, mime] of [['blocks', Buffer.from(JSON.stringify(documents.blocks, null, 2) + '\n'), 'application/json'],
        ['plan', Buffer.from(JSON.stringify(documents.document, null, 2) + '\n'), 'application/json'], ['ledger', Buffer.from(first.input.ledger), 'text/markdown']]) {
        await publish(async () => { bound(); await paperArtifact(p, r, role, bytes, mime); bound(); });
      }
      await publish(() => exclusive(r, async () => {
        await guard(); bound(); r.meta.sha256 = r.meta.artifacts.plan.sha256; r.meta.bytes = r.meta.artifacts.plan.bytes;
        await readSavedPlan(p, r); bound(); r.meta.state = 'completed'; r.meta.completedAt = Date.now(); r.meta.cleanupPending = false; await save(p, r);
      }));
    } catch (error) {
      r.meta.state = r.meta.stopRequested || disposed ? 'stopped' : 'failed'; setLinearRunError(r, error, ipc?.refusalFor);
      if (!r.handle && !r.meta.writer && (!writerStartAttempted || (typeof summaryWriter.planPreparationFailedBeforeCreation === 'function'
        && summaryWriter.planPreparationFailedBeforeCreation(error, { projectId: r.meta.projectId, reportId: r.meta.reportId }) === true))) {
        r.meta.writerStarting = false;
        r.meta.cleanupPending = r.meta.taskCreating || r.meta.scheduleCreating || Boolean(r.meta.scheduleId)
          || r.meta.taskSettlement === 'unknown' || r.failedSave;
      }
      if (r.handle) {
        let stopped, recorded = false;
        try { stopped = await r.handle.stop(); await recordTerminal(stopped); recorded = true; }
        catch { r.meta.cleanupPending = true; }
        // Archive/content errors do not negate an independently saved clean
        // stop acknowledgement. A failed write remains sticky via failedSave.
        if (recorded) { try { await archiveResponse(stopped); } catch {} }
      }
      // Unacknowledged creation is evidence, not proof that no Host resource exists.
      r.meta.cleanupPending ||= r.meta.writerStarting || r.meta.taskCreating || r.meta.scheduleCreating || Boolean(r.meta.scheduleId) || r.failedSave;
      await save(p, r).catch(() => {});
    }
  }
  async function runSection(p, r, guard, assertActive) {
    let writerStartAttempted = false;
    const binding = copy(r.meta.section), encoded = JSON.stringify(binding), selector = { planReportId: binding.source.planReportId,
      ...(binding.lineage.previousSectionReportId ? { previousSectionReportId: binding.lineage.previousSectionReportId } : {}) };
    const bound = () => { assertActive(); check(JSON.stringify(r.meta.section) === encoded, 'PROJECT_PAPER_SECTION_BINDING_CHANGED'); };
    const originalAuthority = { guard, assertActive: bound, reportId: r.meta.reportId };
    const ipc = paperRunnerIpcScope?.(originalAuthority), authority = ipc?.authority ?? originalAuthority;
    const recheck = async () => {
      bound(); await guard(); const parent = await sectionContext(p, selector, binding.source); bound();
      const gathered = await gatherPaperFacts(p.meta.projectId, authority, copy(parent.saved.binding.target), parent.saved.binding.factIds ?? []);
      bound(); const prepared = await sectionInput(p, selector, gathered, binding); await guard();
      await assertPaperTarget(p.meta.projectId, copy(parent.saved.binding.target)); bound(); return { ...prepared, gathered };
    };
    const recordWriter = async snapshot => { r.meta.writer = { ...planWriterEvidence(r.meta.writer), ...planWriterEvidence(snapshot) }; await save(p, r); };
    const recordTerminal = async terminal => { r.meta.cleanupPending = terminal?.cleanupPending !== false; await recordWriter(terminal); };
    const artifact = async (role, bytes, mime) => { try { await paperArtifact(p, r, role, bytes, mime); } catch (error) { r.failedSave = true; throw error; } };
    let responseAttempted = false;
    const archiveResponse = async terminal => {
      if (responseAttempted || r.meta.artifacts?.response || typeof terminal?.finalText !== 'string') return;
      responseAttempted = true;
      try {
        check(terminal.finalText.isWellFormed(), 'PROJECT_PAPER_SECTION_INVALID_OUTPUT');
        const bytes = Buffer.from(terminal.finalText); check(bytes.length <= PAPER_ARTIFACT_MAX_BYTES, 'PROJECT_PAPER_OUTPUT_TOO_LARGE');
        await artifact('response', bytes, 'text/plain');
      } catch (error) { r.meta.responseError = code(error); throw error; }
    };
    try {
      const first = await recheck(); r.meta.asOf = first.gathered.asOf; r.meta.snapshotCapturedAt = Date.now(); await save(p, r);
      const cwd = await store.mkdir(directory(p, r.meta.reportId)); await recheck();
      r.meta.writerStarting = true; r.meta.cleanupPending = true; await save(p, r); await recheck();
      writerStartAttempted = true;
      const handle = await summaryWriter.start({ projectId: r.meta.projectId, reportId: r.meta.reportId, kind: 'paper-section', prompt: first.input.prompt, cwd,
        deadlineAt: Date.now() + 30 * 60 * 1000, assertActive: bound,
        onBound: async writer => { await recordWriter({ ...writer, state: 'preparing', cleanupPending: true }); await recheck(); return { ok: true }; },
        onUpdate: async snapshot => { await recordWriter(snapshot); return { ok: true }; } });
      r.handle = handle; r.meta.writerStarting = false; await save(p, r); await recheck();
      const terminal = await handle.done; await recordTerminal(terminal); await archiveResponse(terminal); await recheck();
      check(terminal?.state === 'completed' && terminal.modelStopReason === 'stop' && terminal.cleanupPending === false && typeof terminal.finalText === 'string', 'PROJECT_SUMMARY_WRITER_FAILED');
      const documents = sectionDocuments(terminal.finalText, binding), d = documents.document;
      r.meta.findings = copy(d.findings); r.meta.findingsTruncated = d.findingsTruncated; r.meta.sourceStatus = d.sourceStatus; r.meta.provenanceStatus = d.provenanceStatus; await save(p, r);
      check(d.sourceStatus !== 'leaked', 'PROJECT_PAPER_SECTION_LEAK');
      const publish = async action => {
        const target = copy(first.context.saved.binding.target);
        bound(); await guard(); await sectionContext(p, selector, binding.source); bound();
        await guard(); await assertPaperTarget(p.meta.projectId, target); bound();
        await withPaperPublication(p.meta.projectId, authority, target, async latest => {
          // Target lock is already held: use this snapshot, never gather/re-enter.
          await sectionInput(p, selector, latest, binding); await guard(); bound();
          r.meta.snapshotAdvancedDuringWriting = latest.asOf !== first.gathered.asOf || first.gathered.asOf !== first.context.saved.binding.material.admissionAsOf;
          await action();
        }, first.context.saved.binding.factIds ?? [], { retryGraphChanged: false });
      };
      for (const [role, bytes, mime] of [['source', Buffer.from(documents.tex), 'text/x-tex'],
        ['provenance', Buffer.from(JSON.stringify(documents.provenance, null, 2) + '\n'), 'application/json'],
        ['ledger', Buffer.from(first.input.ledger), 'text/markdown'], ['section', Buffer.from(JSON.stringify(d, null, 2) + '\n'), 'application/json']]) {
        await publish(async () => { bound(); await artifact(role, bytes, mime); bound(); });
      }
      await publish(() => exclusive(r, async () => {
        await guard(); bound(); r.meta.sha256 = r.meta.artifacts.source.sha256; r.meta.bytes = r.meta.artifacts.source.bytes;
        await readSavedSection(p, r); await sectionInput(p, selector, first.gathered, binding); bound();
        r.meta.state = 'completed'; r.meta.completedAt = Date.now(); r.meta.cleanupPending = false; await save(p, r);
      }));
    } catch (error) {
      r.meta.state = r.meta.stopRequested || disposed ? 'stopped' : 'failed'; setLinearRunError(r, error, ipc?.refusalFor);
      if (!r.handle && !r.meta.writer && (!writerStartAttempted || (typeof summaryWriter.sectionPreparationFailedBeforeCreation === 'function'
        && summaryWriter.sectionPreparationFailedBeforeCreation(error, { projectId: r.meta.projectId, reportId: r.meta.reportId }) === true))) {
        r.meta.writerStarting = false; r.meta.cleanupPending = r.meta.taskCreating || r.meta.scheduleCreating || Boolean(r.meta.scheduleId) || r.meta.taskSettlement === 'unknown' || r.failedSave;
      }
      if (r.handle) {
        let stopped, recorded = false;
        try { stopped = await r.handle.stop(); await recordTerminal(stopped); recorded = true; } catch { r.meta.cleanupPending = true; }
        if (recorded) { try { await archiveResponse(stopped); } catch {} }
      }
      r.meta.cleanupPending ||= r.meta.writerStarting || r.meta.taskCreating || r.meta.scheduleCreating || Boolean(r.meta.scheduleId) || r.failedSave;
      await save(p, r).catch(() => {});
    }
  }
  async function readPaperMathReview(p, r) {
    const m = r.meta, descriptor = copy(m.artifacts?.review);
    check(m.kind === 'paper-math-verification' && m.state === 'completed' && !m.cleanupPending && !m.stopRequested
      && !r.failedSave && !r.mathSettlementWriting && cleanMathCompletion(r)
      && m.taskSettlement === 'confirmed' && !m.error && validPaperMathBinding(m.math)
      && object(m.artifacts) && Object.keys(m.artifacts).length === 2 && object(m.artifacts.response)
      && Object.keys(m.artifacts.response).length === 5 && m.artifacts.response.name === 'raw-response.txt'
      && m.artifacts.response.mime === 'text/plain' && m.artifacts.response.artifact === `${directory(p, m.reportId)}/raw-response.txt`
      && Number.isSafeInteger(m.artifacts.response.bytes) && m.artifacts.response.bytes > 0
      && m.artifacts.response.bytes <= PAPER_ARTIFACT_MAX_BYTES && /^[a-f0-9]{64}$/.test(m.artifacts.response.sha256)
      && descriptor && Object.keys(descriptor).length === 5 && descriptor.name === 'MATH_REVIEW.json'
      && descriptor.mime === 'application/json' && descriptor.artifact === `${directory(p, m.reportId)}/MATH_REVIEW.json`
      && Number.isSafeInteger(descriptor.bytes) && descriptor.bytes > 0 && descriptor.bytes <= PAPER_ARTIFACT_MAX_BYTES
      && /^[a-f0-9]{64}$/.test(descriptor.sha256) && descriptor.sha256 === m.sha256 && descriptor.bytes === m.bytes,
    'PROJECT_PAPER_MATH_REVIEW_INVALID');
    const { bytes, identity: fileIdentity } = await store.readWitness(descriptor.artifact);
    check(bytes.length === descriptor.bytes && hash(bytes) === descriptor.sha256, 'PROJECT_PAPER_MATH_REVIEW_INVALID');
    const raw = strictText(bytes);
    const responseBytes = await store.read(m.artifacts.response.artifact);
    check(responseBytes.length === m.artifacts.response.bytes && hash(responseBytes) === m.artifacts.response.sha256,
      'PROJECT_PAPER_MATH_REVIEW_INVALID');
    const responseText = strictText(responseBytes);
    let responseParsed;
    try { responseParsed = parsePaperMathReport(responseText); } catch { throw failure('PROJECT_PAPER_MATH_REVIEW_INVALID'); }
    let saved;
    try { saved = JSON.parse(raw); } catch { throw failure('PROJECT_PAPER_MATH_REVIEW_INVALID'); }
    check(object(saved) && Object.keys(saved).length === 9 && ['schemaVersion', 'kind', 'projectId', 'reportId', 'binding', 'findings', 'report', 'verdict', 'limitations']
      .every(key => Object.hasOwn(saved, key)) && raw === `${JSON.stringify(saved, null, 2)}\n`
      && saved.schemaVersion === 1 && saved.kind === 'paper-math-verification'
      && saved.projectId === m.projectId && saved.reportId === m.reportId
      && JSON.stringify(saved.binding) === JSON.stringify(m.math)
      && Array.isArray(saved.limitations) && saved.limitations.length === 3
      && saved.limitations.every(value => typeof value === 'string' && value.length <= 256), 'PROJECT_PAPER_MATH_REVIEW_INVALID');
    const parsed = parsePaperMathReport(JSON.stringify({ findings: saved.findings, report: saved.report }));
    check(JSON.stringify(responseParsed.findings) === JSON.stringify(parsed.findings) && responseParsed.report === parsed.report
      && responseParsed.verdict === parsed.verdict && parsed.verdict === saved.verdict && parsed.verdict === m.mathVerdict
      && await store.fileIdentity(descriptor.artifact) === fileIdentity, 'PROJECT_PAPER_MATH_REVIEW_INVALID');
    mathReviewChecks.set(r, { binding: JSON.stringify(m.math), sha256: descriptor.sha256, verdict: parsed.verdict });
    return { descriptor, bytes, review: { ...saved, verdict: parsed.verdict }, fileIdentity };
  }
  async function paperResult(p, r) {
    const m = r.meta;
    check(TERMINAL.has(m.state) && !r.failedSave, 'PROJECT_REPORT_NOT_READY');
    if (m.state !== 'completed') return { ...readView(r), saved: true,
      status: m.sourceStatus === 'flagged' ? 'flagged' : 'failed', files: [],
      diagnosis: m.kind === 'paper-section'
        ? { responseSaved: Boolean(m.artifacts?.response), sourceSaved: Boolean(m.artifacts?.source), sectionSaved: Boolean(m.artifacts?.section), ledgerSaved: Boolean(m.artifacts?.ledger), error: m.error ?? null,
          ...(m.responseError ? { responseError: m.responseError } : {}), ...(m.archiveError ? { archiveError: m.archiveError } : {}) }
        : m.kind === 'paper-plan'
        ? { responseSaved: Boolean(m.artifacts?.response), blocksSaved: Boolean(m.artifacts?.blocks), planSaved: Boolean(m.artifacts?.plan),
          ledgerSaved: Boolean(m.artifacts?.ledger), error: m.error ?? null,
          ...(m.responseError ? { responseError: m.responseError } : {}), ...(m.archiveError ? { archiveError: m.archiveError } : {}) }
        : m.kind === 'reference-verification'
        ? { responseSaved: Boolean(m.artifacts?.response), verdictsSaved: Boolean(m.artifacts?.verdicts), ledgerSaved: Boolean(m.artifacts?.ledger), error: m.error ?? null }
        : m.kind === 'reference-audit'
        ? { responseSaved: Boolean(m.artifacts?.response), auditSaved: Boolean(m.artifacts?.audit), error: m.error ?? null }
        : { responseSaved: Boolean(m.artifacts?.response), sourceSaved: Boolean(m.artifacts?.source), error: m.error ?? null } };
    check(!m.cleanupPending, 'PROJECT_REPORT_NOT_READY');
    if (m.kind === 'paper-plan') {
      check(planView(r).coverageStatus === 'exact-once', 'PROJECT_REPORT_NOT_READY'); await readSavedPlan(p, r);
    }
    if (m.kind === 'paper-section') {
      check(sectionView(r).publicationStatus === 'reviewable-section', 'PROJECT_REPORT_NOT_READY');
      await (r.historical ? readSavedSection(p, r) : inspectSavedSection(p, r));
    }
    if (m.kind === 'paper-revision' && m.revision.mode === 'operator-notes') await readOperatorNotes(p, r);
    let checkedMathReview = null;
    if (m.kind === 'paper-math-verification') checkedMathReview = await readPaperMathReview(p, r);
    if (completedRevisionNoOp(r)) return { ...view(r), saved: true, status: 'no_edits_applied', files: [],
      diagnosis: { responseSaved: Boolean(m.artifacts?.response) } };
    const files = [];
    const spec = reportKindSpec(m.kind), roles = spec.deliveredRoles;
    let failed = false;
    for (const role of roles) {
      const a = m.artifacts[role];
      try {
        check(a && a.artifact === `${directory(p, m.reportId)}/${a.name}`
          && spec.artifactNames[role] === a.name,
        'PROJECT_REPORT_ARTIFACT_INVALID');
        const bytes = await store.read(a.artifact);
        check(bytes.length === a.bytes && hash(bytes) === a.sha256, 'PROJECT_REPORT_ARTIFACT_INVALID');
        if (role === 'review' && checkedMathReview) {
          const beforeStage = await store.readWitness(a.artifact);
          check(beforeStage.identity === checkedMathReview.fileIdentity && beforeStage.bytes.equals(checkedMathReview.bytes),
            'PROJECT_PAPER_MATH_REVIEW_INVALID');
        }
        const receipt = await sdk.resources.stage({ path: store.absolute(a.artifact), name: a.name, mime: a.mime, deliverAs: 'attachment' });
        if (role === 'review' && checkedMathReview) {
          const after = await store.readWitness(a.artifact);
          check(after.identity === checkedMathReview.fileIdentity && after.bytes.equals(checkedMathReview.bytes)
            && after.bytes.length === a.bytes && hash(after.bytes) === a.sha256, 'PROJECT_PAPER_MATH_REVIEW_INVALID');
        }
        const resource = receipt?.resource;
        check(receipt?.ok !== false && !receipt?.error && resource?.kind === 'session-file'
          && typeof resource.fileId === 'string' && resource.fileId && typeof m.creator.sessionId === 'string'
          && resource.sessionId === m.creator.sessionId, 'PROJECT_REPORT_STAGE_INVALID');
        files.push({ role, name: a.name, bytes: a.bytes, sha256: a.sha256,
          resource: { kind: 'session-file', fileId: resource.fileId, sessionId: resource.sessionId } });
      } catch (error) { failed = true; files.push({ role, name: a?.name, error: code(error) }); }
    }
    m.delivery = { state: failed ? 'failed' : 'staged', delivered: false, files: copy(files) }; await save(p, r);
    const result = { ...readView(r), saved: true, status: failed ? 'delivery-failed' : m.sourceStatus === 'flagged' ? 'flagged' : 'ok', files,
      ...(checkedMathReview && !failed ? { verdict: checkedMathReview.review.verdict, mathVerdict: checkedMathReview.review.verdict } : {}),
      ...(failed ? { readError: { code: 'PROJECT_REPORT_EXPORT_FAILED', phase: 'delivery' } } : {}) };
    if (failed && checkedMathReview) {
      delete result.verdict; delete result.mathVerdict; result.paperMathGate = 'not-assessed';
      mathReviewChecks.delete(r);
    }
    return result;
  }
  async function run(p, r) {
    let terminal, settledHere = false;
    try {
      await readGuard(p, r);
      try { await unschedule(p, r); } catch (error) { r.meta.cleanupPending = true; throw error; }
      current(p, r);
      const guard = () => readGuard(p, r), assertActive = () => current(p, r);
      const paper = r.meta.kind === 'paper-source', audit = r.meta.kind === 'reference-audit';
      if (r.meta.kind === 'paper-section') { await runSection(p, r, guard, assertActive); return view(r); }
      if (r.meta.kind === 'paper-plan') { await runPlan(p, r, guard, assertActive); return view(r); }
      if (r.meta.kind === 'paper-revision') { await runRevision(p, r, guard, assertActive); return view(r); }
      if (r.meta.kind === 'reference-verification') { await runVerification(p, r, guard, assertActive); return view(r); }
      if (r.meta.kind === 'paper-math-verification') {
        await runPaperMathVerification(p, r, guard, assertActive);
        settledHere = true;
        await settle(p, r).catch(() => {});
        return settledMathView(p, r);
      }
      if (audit) { await runAudit(p, r, guard, assertActive); return view(r); }
      if (paper) await assertPaperTarget(p.meta.projectId, copy(r.meta.paper.target));
      const source = paper ? await import('./paper-source.mjs') : null;
      let gathered;
      for (let attempt = 0; ; attempt++) {
        try { gathered = paper
          ? await gatherPaperFacts(p.meta.projectId, { guard, assertActive, reportId: r.meta.reportId }, copy(r.meta.paper.target), r.meta.paper.factIds ?? [])
          : await gatherFacts(p.meta.projectId, { guard, assertActive }); break; }
        catch (error) { if (error.code !== 'PROJECT_SUMMARY_GRAPH_CHANGED' || attempt >= 1) throw error; }
      }
      if (paper) assertPaperMaterial(gathered, r.meta.paper);
      current(p, r); r.meta.asOf = gathered.asOf; r.meta.snapshotCapturedAt = Date.now(); await save(p, r);
      const input = await readInput(p);
      check(typeof input?.problem === 'string', 'PROJECT_RECORD_INVALID');
      const materials = paper ? assertPaperMaterial(gathered, r.meta.paper) : null;
      const ledger = paper ? source.paperLedger(materials.validationFacts) : null;
      const prompt = paper ? source.buildPaperPrompt({ resources: await source.readPaperResources(), problem: input.problem,
        brief: r.meta.paper.brief, instructions: r.meta.paper.instructions, facts: gathered.facts,
        headlineFactIds: r.meta.paper.target.factIds, factIds: r.meta.paper.factIds })
        : buildPrompt({ writerPrompt: await readWriterPrompt(), problem: input.problem, facts: gathered.facts, language: r.meta.language });
      check(Buffer.byteLength(prompt) <= 512 * 1024, 'PROJECT_SUMMARY_INPUT_TOO_LARGE');
      const cwd = await store.mkdir(directory(p, r.meta.reportId)); current(p, r);
      let handle;
      const startWriter = async () => {
        r.meta.writerStarting = true; r.meta.cleanupPending = true; await save(p, r);
        handle = await summaryWriter.start({ projectId: r.meta.projectId, reportId: r.meta.reportId, prompt, cwd,
          ...(paper ? { kind: 'paper-source' } : {}),
          deadlineAt: Date.now() + 30 * 60 * 1000, assertActive,
          onBound: async binding => {
            // Preserve a late real identity even after stop; it is cleanup evidence,
            // never permission to start or publish a cancelled report.
            r.meta.writer = { ...(r.meta.writer ?? {}), ...copy(binding), state: 'preparing', cleanupPending: true };
            await save(p, r); current(p, r); return { ok: true };
          },
          onUpdate: async snapshot => {
            r.meta.writer = copy(snapshot); await save(p, r); return { ok: true };
          } });
        r.handle = handle; r.meta.writerStarting = false; await save(p, r);
      };
      if (paper) await withPaperPublication(p.meta.projectId, { guard, assertActive, reportId: r.meta.reportId }, copy(r.meta.paper.target), async latest => {
        assertPaperMaterial(latest, r.meta.paper);
        current(p, r);
        await startWriter();
      }, r.meta.paper.factIds ?? []);
      else await startWriter();
      terminal = await handle.done;
      r.meta.writer = copy(terminal); r.meta.cleanupPending = terminal?.cleanupPending !== false; await save(p, r);
      // A valid final response is evidence even if stop or target revocation wins publication.
      if (paper && typeof terminal?.finalText === 'string' && terminal.finalText.trim()) {
        check(Buffer.byteLength(terminal.finalText) <= PAPER_ARTIFACT_MAX_BYTES, 'PROJECT_PAPER_OUTPUT_TOO_LARGE');
        await paperArtifact(p, r, 'response', Buffer.from(terminal.finalText), 'text/plain');
        r.meta.sha256 = r.meta.artifacts.response.sha256; r.meta.bytes = r.meta.artifacts.response.bytes;
        await save(p, r);
      }
      current(p, r);
      check(terminal?.state === 'completed' && terminal.modelStopReason === 'stop' && terminal.cleanupPending === false
        && typeof terminal.finalText === 'string' && terminal.finalText.trim(), 'PROJECT_SUMMARY_WRITER_FAILED');
      if (paper) {
        await publishPaper(p, r, { source, gathered, ledger, guard, assertActive, text: terminal.finalText });
      } else {
      const bytes = Buffer.from(terminal.finalText, 'utf8'), leaks = leakFindings(terminal.finalText);
      const basename = leaks.length ? 'report.leaky.md' : 'report.md';
      // Every produced text survives even if the graph changed or publication
      // later fails. The unique artifact is never overwritten on retry.
      const artifact = `${directory(p, r.meta.reportId)}/${basename}`;
      await store.write(artifact, bytes);
      r.meta.artifact = artifact; r.meta.sha256 = hash(bytes); r.meta.bytes = bytes.length; r.meta.leakFindings = leaks;
      await save(p, r); current(p, r);
      r.meta.snapshotCheckedAt = Date.now();
      await withReportPublication(p.meta.projectId, { guard, assertActive, reportId: r.meta.reportId }, async latest => {
        const latestById = new Map(latest.facts.map(fact => [fact.fact_id, fact]));
        const changed = gathered.facts.some(fact => {
          const currentFact = latestById.get(fact.fact_id);
          return !currentFact || currentFact.markdown !== fact.markdown
            || JSON.stringify(currentFact.predecessors) !== JSON.stringify(fact.predecessors);
        });
        check(!changed, 'PROJECT_SUMMARY_FACT_REVOKED');
        r.meta.snapshotAdvancedDuringWriting = latest.asOf !== gathered.asOf;
        current(p, r);
        await exclusive(r, async () => {
          current(p, r);
          r.meta.publishedArtifact = artifact;
          r.meta.publishedSha256 = hash(bytes); r.meta.publishedBytes = bytes.length;
          await save(p, r);
          const alternate = leaks.length ? 'report.md' : 'report.leaky.md';
          await preserveAlternate(p, r, alternate); current(p, r);
          await store.write(`${projectLocation(p)}/report/${basename}`, bytes, true); current(p, r);
          r.meta.state = leaks.length ? 'leak' : 'completed'; r.meta.completedAt = Date.now();
          r.meta.cleanupPending = false; await save(p, r);
        });
      });
      }
    } catch (error) {
      r.meta.state = r.meta.stopRequested || disposed ? 'stopped' : 'failed';
      const math = r.meta.kind === 'paper-math-verification';
      if (math) clearMathCompletion(r);
      if (linearKind(r.meta.kind)) setLinearRunError(r, error);
      else setReportError(r.meta, code(error));
      if (r.handle) {
        try {
          terminal = await r.handle.stop(); r.meta.writer = stoppedWriterEvidence(p, r, terminal);
          r.meta.cleanupPending = terminal?.cleanupPending !== false;
        } catch { r.meta.cleanupPending = true; }
      } else if (linearKind(r.meta.kind)) {
        r.meta.cleanupPending ||= planCleanupPending(r.meta) || r.failedSave;
      } else {
        r.meta.writerStarting = false;
        r.meta.cleanupPending = Boolean(r.meta.writer?.sessionId) || Boolean(r.meta.scheduleId) || r.meta.scheduleCreating;
      }
      if (linearKind(r.meta.kind) || math) r.meta.cleanupPending ||= r.meta.taskCreating || r.meta.scheduleCreating
        || r.meta.writerStarting || Boolean(r.meta.scheduleId) || r.failedSave;
      await save(p, r).catch(() => {});
    } finally {
      if (!settledHere) await settle(p, r).catch(() => {});
    }
    return view(r);
  }
  async function failStartedLinear(p, r, error, refusalFor) {
    let stop = false;
    await exclusive(r, async () => {
      // Protect producer completion even while its original job still awaits task settlement.
      if (r.meta.kind === 'paper-plan' ? planView(r, false).coverageStatus === 'exact-once' : sectionView(r, false).publicationStatus === 'reviewable-section') return;
      r.planStartError ??= selectLinearError(error, refusalFor);
      setReportError(r.meta, r.planStartError.code, r.planStartError.category); r.meta.state = 'failed'; r.meta.stopRequested = true;
      r.meta.cleanupPending ||= planCleanupPending(r.meta) || r.failedSave;
      await save(p, r).catch(() => {}); stop = true;
    });
    // Signal/stop the original owner, never await its possibly held gather/send job.
    // stopInternal and handle retain the slot until both job and Host cleanup settle.
    if (stop) {
      try { await bounded(stopInternal(p, r)); }
      catch { r.meta.cleanupPending = true; await save(p, r).catch(() => {}); }
    }
  }
  async function start(p, args, ctx, admission = null) {
    check(!isProxy(args), 'PROJECT_INVALID_INPUT');
    if (Object.getOwnPropertyDescriptor(args ?? {}, 'kind')?.value === 'paper-math-verification') {
      const selector = snapshotPaperMathSelector(Object.getOwnPropertyDescriptor(args, 'math')?.value);
      check(selector && Object.getOwnPropertyDescriptor(args, 'language')?.value === 'English'
        && Object.keys(args).every(key => ['kind', 'language', 'math', 'projectId'].includes(key))
        && (args.projectId === undefined || args.projectId === p.meta.projectId), 'PROJECT_INVALID_INPUT');
      args = { kind: 'paper-math-verification', language: 'English', math: selector };
    }
    if (args && (Object.getOwnPropertyDescriptor(args, 'kind')?.value === 'paper-revision' || Object.hasOwn(args, 'revision'))) args = snapshotPaperRevisionStart(args);
    if (Object.getOwnPropertyDescriptor(args ?? {}, 'kind')?.value === 'paper-plan') args = snapshotPaperPlanStart(args);
    if (Object.getOwnPropertyDescriptor(args ?? {}, 'kind')?.value === 'paper-section') args = snapshotPaperSectionStart(args);
    const plan = args?.kind === 'paper-plan', section = args?.kind === 'paper-section', linear = plan || section;
    const sectionSelector = section ? copy(args.section) : null;
    const planBase = plan ? copy(args.plan) : null;
    const revisionSelector = args?.kind === 'paper-revision' ? copy(args.revision) : null;
    const verificationSelector = args?.kind === 'reference-verification' ? copy(args.verification) : null;
    const mathSelector = args?.kind === 'paper-math-verification' ? copy(args.math) : null;
    if (admission) {
      check((args?.kind === 'paper-source' || linear) && typeof admission.authorize === 'function' && typeof admission.guard === 'function', 'PROJECT_INVALID_INPUT');
      await admission.authorize(); admission.guard();
    } else await authorizeCreator(p, ctx);
    assertLive(p); check(!disposed, 'PROJECT_DISPOSED');
    if (revisionSelector) check(args.kind === 'paper-revision' && JSON.stringify(args.revision) === JSON.stringify(revisionSelector), 'PROJECT_INVALID_INPUT');
    if (verificationSelector) check(args.kind === 'reference-verification' && JSON.stringify(args.verification) === JSON.stringify(verificationSelector), 'PROJECT_INVALID_INPUT');
    if (mathSelector) check(args.kind === 'paper-math-verification' && JSON.stringify(args.math) === JSON.stringify(mathSelector), 'PROJECT_INVALID_INPUT');
    if (!section) check(typeof summaryWriter?.start === 'function', 'PROJECT_SUMMARY_UNAVAILABLE');
    check(validReportStart(args, p.meta.projectId, paperValid), 'PROJECT_INVALID_INPUT');
    if (deferHistoricalWork === true) {
      await prepareHistory(p, () => admission ? admission.authorize() : authorizeCreator(p, ctx));
      admission?.guard(); assertLive(p); check(!disposed, 'PROJECT_DISPOSED');
    }
    let sectionRecord = null, sectionReport = null, sectionParent = null;
    const admissionSectionCheck = async () => {
      await admission.authorize(); admission.guard(); assertLive(p); check(!disposed, 'PROJECT_DISPOSED');
      if (sectionReport) check(!sectionReport.meta.stopRequested && JSON.stringify(sectionReport.meta.section) === JSON.stringify(sectionRecord), 'PROJECT_PAPER_SECTION_BINDING_CHANGED');
      const gathered = await admission.gather(copy(sectionParent.saved.binding.target), sectionParent.saved.binding.factIds ?? []);
      admission.guard();
      const prepared = await sectionInput(p, sectionSelector, gathered, sectionRecord, sectionParent);
      await admission.authorize(); admission.guard(); return prepared.input;
    };
    if (section) {
      sectionParent = await sectionContext(p, sectionSelector);
      if (admission) { await admission.authorize(); admission.guard(); } else await authorizeCreator(p, ctx);
      if (sectionParent.sectionIndex === sectionParent.sectionCount) return { projectId: p.meta.projectId, status: 'no_next_section', kind: 'paper-section',
        planReportId: sectionSelector.planReportId, previousSectionReportId: sectionSelector.previousSectionReportId,
        chainRootReportId: sectionParent.chainRootReportId, nextSectionIndex: sectionParent.sectionIndex, sectionCount: sectionParent.sectionCount,
        paperId: sectionParent.source.paperId, assembled: false, limitations: ['No next section; fragments are not assembled, compiled or mathematically verified.'] };
      check(typeof summaryWriter?.start === 'function', 'PROJECT_SUMMARY_UNAVAILABLE');
      check(admission && typeof admission.gather === 'function' && typeof gatherPaperFacts === 'function'
        && typeof withPaperPublication === 'function' && typeof assertPaperTarget === 'function', 'PROJECT_PAPER_UNAVAILABLE');
      const input = await admissionSectionCheck();
      sectionRecord = { schemaVersion: 1, source: copy(sectionParent.source), lineage: { chainRootReportId: sectionParent.chainRootReportId,
        previousSectionReportId: sectionSelector.previousSectionReportId ?? null,
        previousSourceSha256: sectionParent.previous?.artifacts.source.sha256 ?? null, previousResultSha256: sectionParent.previous?.artifacts.section.sha256 ?? null },
        sectionCount: sectionParent.sectionCount, material: copy(input.material), resources: copy(input.hashes.resources), promptSha256: input.hashes.promptSha256 };
    }
    const spec = reportKindSpec(args.kind), paper = args.kind === 'paper-source', audit = args.kind === 'reference-audit';
    const paperRecord = paper ? copy(args.paper) : null;
    if (paper) check(validPaperMaterial(paperRecord.material, paperRecord.target, paperRecord.factIds), 'PROJECT_INVALID_INPUT');
    let planRecord = null, planReport = null;
    const admissionPlanGuard = () => {
      admission.guard(); assertLive(p); check(!disposed, 'PROJECT_DISPOSED');
      if (planReport) {
        check(!planReport.meta.stopRequested, 'PROJECT_SUMMARY_STOPPED');
        check(JSON.stringify(planReport.meta.plan) === JSON.stringify(planRecord), 'PROJECT_PAPER_PLAN_BINDING_CHANGED');
      }
    };
    const admissionPlanCheck = async () => {
      await admission.authorize(); admissionPlanGuard();
      const gathered = await admission.gather(); admissionPlanGuard();
      const input = await planInput(gathered, planRecord ?? planBase);
      await admission.authorize(); admissionPlanGuard(); return input;
    };
    if (plan) {
      check(admission && typeof admission.gather === 'function', 'PROJECT_INVALID_INPUT');
      const input = await admissionPlanCheck(); planRecord = { ...planBase, ...input.hashes };
      await admissionPlanCheck();
    }
    const auditRecord = audit ? { ...copy(args.audit), mainSha256: '', ledgerSha256: '', contractSha256: '', boundContractSha256: '',
      auditorPromptSha256: '', boundAuditorPromptSha256: '', promptSha256: '', boundPromptSha256: '' } : null;
    if (audit) {
      const checked = await auditSource(p, auditRecord);
      const resources = await (await import('./paper-source.mjs')).readReferenceAuditResources();
      auditRecord.mainSha256 = checked.source.meta.artifacts.source.sha256; auditRecord.ledgerSha256 = checked.source.meta.artifacts.ledger.sha256;
      auditRecord.contractSha256 = hash(Buffer.from(resources.contract)); auditRecord.boundContractSha256 = auditRecord.contractSha256;
      auditRecord.auditorPromptSha256 = hash(Buffer.from(resources.auditorPrompt));
      auditRecord.boundAuditorPromptSha256 = auditRecord.auditorPromptSha256;
      const decode = bytes => {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        check(Buffer.from(value, 'utf8').equals(bytes), 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
        return value;
      };
      const prompt = (await import('./paper-source.mjs')).buildReferenceAuditPrompt({
        mainTex: decode(checked.outputs.source), ledger: decode(checked.outputs.ledger), ...resources });
      check(Buffer.byteLength(prompt) <= 512 * 1024, 'PROJECT_SUMMARY_INPUT_TOO_LARGE');
      auditRecord.promptSha256 = hash(Buffer.from(prompt)); auditRecord.boundPromptSha256 = auditRecord.promptSha256;
    }
    let revisionRecord = null;
    if (args.kind === 'paper-revision') {
      const material = await revisionMaterial(p, revisionSelector, null, args.notes);
      revisionRecord = { ...revisionSelector, ...material.hashes };
      await revisionMaterial(p, revisionRecord, null, args.notes);
      await authorizeCreator(p, ctx); assertLive(p); check(!disposed, 'PROJECT_DISPOSED');
    }
    let mathBinding = null, mathMaterial = null;
    if (args.kind === 'paper-math-verification') {
      const sourceSelector = { ...mathSelector };
      const authorize = () => authorizeCreator(p, ctx);
      mathMaterial = await paperMathSource(p, sourceSelector,
        () => { assertLive(p); check(!disposed, 'PROJECT_DISPOSED'); }, authorize);
      mathBinding = mathMaterial.binding;
      check(validPaperMathBinding(mathBinding), 'PROJECT_INVALID_INPUT');
      await mathMaterial.assertSource();
    }
    let verificationRecord = null;
    if (args.kind === 'reference-verification') {
      const material = await verificationMaterial(p, verificationSelector);
      verificationRecord = { ...verificationSelector, sourceReportId: material.sourceReportId,
        mainSha256: material.mainSha256, ledgerSha256: material.ledgerSha256, auditSha256: material.auditSha256,
        contractSha256: material.contractSha256, boundContractSha256: material.contractSha256,
        verifierPromptSha256: material.verifierPromptSha256, boundVerifierPromptSha256: material.verifierPromptSha256,
        promptSha256: material.promptSha256, boundPromptSha256: material.promptSha256, keys: [...material.keys] };
      await verificationMaterial(p, verificationRecord);
      await authorizeCreator(p, ctx); assertLive(p); check(!disposed, 'PROJECT_DISPOSED');
    }
    if (paper) {
      check(typeof gatherPaperFacts === 'function' && typeof withPaperPublication === 'function' && typeof assertPaperTarget === 'function', 'PROJECT_PAPER_UNAVAILABLE');
      await assertPaperTarget(p.meta.projectId, copy(paperRecord.target));
      if (admission) { await admission.authorize(); admission.guard(); }
    }
    if (deferHistoricalWork === true) { admission?.guard(); assertLive(p); check(!disposed, 'PROJECT_DISPOSED'); }
    const blocker = active.get(p.meta.projectId) ?? deferredByProject.get(p.meta.projectId)?.values().next().value;
    check(!damaged.has(p.meta.projectId) && !admitting.has(p.meta.projectId), 'PROJECT_SUMMARY_BUSY');
    if (blocker) throw Object.assign(failure('PROJECT_SUMMARY_BUSY'), { reportId: blocker.meta.reportId, projectId: p.meta.projectId });
    const reportId = `report-${randomUUID()}`;
    if (section) { sectionRecord.lineage.chainRootReportId ??= reportId; check(validSectionBinding(sectionRecord, p.meta.projectId, reportId), 'PROJECT_PAPER_SECTION_BINDING_INVALID'); }
    const r = wrap({ schemaVersion: 1, projectId: p.meta.projectId, reportId, state: 'queued',
      ...spec.recordFields(sectionRecord ?? planRecord ?? revisionRecord ?? verificationRecord ?? mathBinding ?? (paper ? paperRecord : auditRecord)),
      language: args.language, creator: copy(p.meta.creator), createdAt: Date.now(), taskId: null, taskCreating: false,
      scheduleId: null, scheduleCreating: false, scheduleCleaned: false, nonce: randomBytes(24).toString('hex'),
      writerStarting: false, writer: null, cleanupPending: false, stopRequested: false, taskSettlement: 'pending', delivery: null });
    admitting.add(p.meta.projectId); records.set(key(p, reportId), r); active.set(p.meta.projectId, r);
    if (plan) planReport = r;
    if (section) sectionReport = r;
    const admissionLinearCheck = section ? admissionSectionCheck : admissionPlanCheck;
    try {
      await store.mkdir(directory(p, reportId), true); await save(p, r);
      if (mathMaterial) await mathMaterial.assertSource();
      if (revisionRecord?.mode === 'operator-notes') {
        await revisionMaterial(p, revisionRecord, null, args.notes);
        await paperArtifact(p, r, 'notes', Buffer.from(args.notes), 'text/markdown');
        // Once archived, only the report input is authoritative; never fall back to the call text.
        await revisionMaterial(p, revisionRecord, r);
        await authorizeCreator(p, ctx); assertLive(p); check(!disposed && !r.meta.stopRequested, 'PROJECT_SUMMARY_STOPPED');
      }
      if (linear) await admissionLinearCheck();
      r.meta.taskCreating = true; await save(p, r);
      const task = await bounded(sdk.tasks.create({ scope: 'session', callToken: ctx.callToken, delivery: 'next-step', handlerKey: HANDLER,
        label: spec.label, metadata: reportTaskFields(r.meta) }));
      check(task?.pluginId === APP && task.scope === 'session' && task.handlerKey === HANDLER && task.delivery === 'next-step'
        && task.parentSessionId === p.meta.creator.sessionId && task.parentSessionPath === ctx.sessionPath
        && matchesReportTaskFields(r.meta, task.metadata) && typeof task.taskId === 'string', 'PROJECT_REPORT_TASK_UNCONFIRMED');
      r.meta.taskId = task.taskId; r.meta.taskCreating = false; await save(p, r);
      if (mathMaterial) await mathMaterial.assertSource();
      if (linear) { const receipt = await taskReceipt(p, r); check(['pending', 'running'].includes(receipt.status), 'PROJECT_REPORT_TASK_INACTIVE'); await admissionLinearCheck(); }
      if (revisionRecord?.mode === 'operator-notes') {
        await revisionMaterial(p, revisionRecord, r);
        await authorizeCreator(p, ctx);
        const checkedTask = await taskReceipt(p, r);
        check(['pending', 'running'].includes(checkedTask.status), 'PROJECT_REPORT_TASK_INACTIVE');
        await revisionMaterial(p, revisionRecord, r);
      }
      check(!disposed, 'PROJECT_DISPOSED'); check(!r.meta.stopRequested, 'PROJECT_SUMMARY_STOPPED');
      if (mathMaterial) await mathMaterial.assertSource();
      r.meta.scheduleCreating = true; await save(p, r);
      const schedule = await bounded(sdk.tasks.schedule({ scope: 'app', handlerKey: HANDLER, runAt: Date.now(), label: 'Write Math report once',
        payload: { projectId: p.meta.projectId, reportId, nonce: r.meta.nonce } }));
      check(schedule?.pluginId === APP && schedule.scope === 'app' && schedule.handlerKey === HANDLER && typeof schedule.scheduleId === 'string', 'PROJECT_REPORT_SCHEDULE_UNCONFIRMED');
      // An immediate handler can run before the schedule receipt. Never restore
      // a schedule that the handler already confirmed removed.
      if (!r.meta.scheduleCleaned) r.meta.scheduleId = schedule.scheduleId;
      r.meta.scheduleCreating = false; await save(p, r);
      if (linear && r.meta.state === 'queued') { const receipt = await taskReceipt(p, r); check(['pending', 'running'].includes(receipt.status), 'PROJECT_REPORT_TASK_INACTIVE'); await admissionLinearCheck(); }
      check(!disposed, 'PROJECT_DISPOSED'); check(!r.meta.stopRequested, 'PROJECT_SUMMARY_STOPPED');
      return { state: 'queued', projectId: p.meta.projectId, reportId, taskId: r.meta.taskId };
    } catch (error) {
      if (linear && (r.job || r.meta.state === 'completed')) {
        await failStartedLinear(p, r, error, admission?.ipcRefusalFor);
        throw Object.assign(error, { reportId, projectId: p.meta.projectId });
      }
      if (linear) setLinearRunError(r, error, admission?.ipcRefusalFor);
      else setReportError(r.meta, code(error));
      r.meta.state = r.meta.stopRequested || disposed ? 'stopped' : 'failed';
      let scheduleUnconfirmed = false;
      try { await unschedule(p, r); } catch { scheduleUnconfirmed = true; }
      r.meta.cleanupPending = r.meta.taskCreating || r.meta.scheduleCreating || r.meta.writerStarting
        || r.meta.writer?.cleanupPending === true || r.failedSave || scheduleUnconfirmed;
      await save(p, r).catch(() => {});
      if (!r.meta.cleanupPending) {
        if (!r.meta.taskId && !r.meta.taskCreating) r.meta.taskSettlement = 'confirmed';
        else await settle(p, r).catch(() => {});
        if (r.meta.taskSettlement !== 'confirmed' && active.get(p.meta.projectId) === r) setReportError(r.meta, 'PROJECT_SUMMARY_BUSY');
        if (r.meta.taskSettlement === 'confirmed' && active.get(p.meta.projectId) === r) active.delete(p.meta.projectId);
      }
      throw Object.assign(error, { reportId, projectId: p.meta.projectId });
    } finally { admitting.delete(p.meta.projectId); }
  }
  async function handle(event) {
    if (disposed || event?.kind !== 'schedule') return { status: 'ignored' };
    let p;
    try { p = getProject(event.input?.projectId); } catch { return { status: 'ignored' }; }
    const r = records.get(key(p, event.input?.reportId));
    if (!r || r.historical || active.get(p.meta.projectId) !== r || r.meta.state !== 'queued'
      || r.meta.nonce !== event.input?.nonce || r.meta.stopRequested) return { status: 'ignored' };
    r.meta.state = 'running'; // one dispatch owner, before the first await
    if (event.scheduleId) { r.meta.scheduleId = event.scheduleId; r.meta.scheduleCleaned = true; }
    r.job = track(p, (async () => { await save(p, r); return run(p, r); })());
    const result = await r.job;
    r.jobSettled = true;
    if (!r.meta.cleanupPending && r.meta.taskSettlement === 'confirmed' && !r.failedSave
      && active.get(p.meta.projectId) === r) active.delete(p.meta.projectId);
    return result;
  }
  function getKind(p, id, options) {
    const expected = options?.kind ?? 'summary';
    check(['summary', 'paper-source', 'reference-audit', 'reference-verification', 'paper-revision', 'paper-plan', 'paper-section', 'paper-math-verification'].includes(expected), 'PROJECT_INVALID_INPUT');
    const r = get(p, id);
    check((r.meta.kind ?? 'summary') === expected, 'PROJECT_REPORT_KIND_MISMATCH');
    return r;
  }
  async function toolAvailabilityReadback(p, r) {
    const identity = copy({ projectId: r.meta.projectId, reportId: r.meta.reportId, writer: Object.fromEntries(
      ['role', 'sessionId', 'sessionPath', 'agentId', 'cwd', 'kind'].map(k => [k, r.meta.writer[k]])) });
    const binding = identity.writer;
    const result = { status: 'unconfirmed', snapshotKind: 'current-session-tool-names-not-live-availability',
      configuredToolNames: null, requestedToolPresence: null, selection: null, disabledToolNames: null, verifierConfig: null, errors: [] };
    const safeError = (error, operation) => researchSdkErrorInfo({ code: code(error), operation,
      kind: researchSdkErrorInfo(error)?.kind, capability: researchSdkErrorInfo(error)?.capability });
    const names = value => {
      check(Array.isArray(value) && value.length <= 256 && value.every(v => typeof v === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(v)) && new Set(value).size === value.length, 'PROJECT_REPORT_TOOL_READBACK_INVALID');
      return [...value];
    };
    const assertBinding = () => check(r.meta.projectId === identity.projectId && r.meta.reportId === identity.reportId
      && TERMINAL.has(r.meta.state) && r.meta.kind === 'reference-verification'
      && Object.keys(binding).every(k => r.meta.writer?.[k] === binding[k])
      && binding.role === 'reference-verifier' && typeof binding.sessionId === 'string' && binding.sessionId.length > 0
      && typeof binding.agentId === 'string' && /^math-reference-verifier-[0-9a-f-]{36}$/.test(binding.agentId)
      && binding.cwd === store.absolute(directory(p, identity.reportId))
      && binding.kind === `math-reference-verification:${identity.projectId}:${identity.reportId}`, 'PROJECT_REPORT_TOOL_READBACK_IDENTITY_INVALID');
    try {
      assertBinding();
      const info = await readResearchSessionInfo(sdk, { sessionId: binding.sessionId }, { namespace: 'app' });
      assertBinding();
      check(info.sessionId === binding.sessionId && info.agentId === binding.agentId && info.path === binding.sessionPath
        && info.cwd === binding.cwd && info.kind === binding.kind, 'PROJECT_REPORT_TOOL_READBACK_IDENTITY_INVALID');
    } catch (error) { result.errors.push(safeError(error, 'sessions.get')); return result; }
    const read = async (owner, method, input, accept, operation) => {
      if (typeof owner?.[method] !== 'function') { result.errors.push({ code: 'UNSUPPORTED', operation, kind: 'unsupported', capability: null }); return; }
      try {
        assertBinding(); const value = await bounded(owner[method](input)); assertBinding();
        check(value && value.ok !== false && !value.error, 'PROJECT_REPORT_TOOL_READBACK_INVALID');
        accept(value);
      } catch (error) { result.errors.push(safeError(error, operation)); }
    };
    await read(sdk.sessions, 'tools', { sessionId: binding.sessionId }, value => {
      check((value.sessionId === undefined || value.sessionId === binding.sessionId)
        && (value.sessionRef === undefined || value.sessionRef?.sessionId === binding.sessionId
          && value.sessionRef?.sessionPath === binding.sessionPath), 'PROJECT_REPORT_TOOL_READBACK_IDENTITY_INVALID');
      result.configuredToolNames = names(value.toolNames);
      result.requestedToolPresence = Object.fromEntries(['web_search', 'web_fetch'].map(name => [name, result.configuredToolNames.includes(name)]));
    }, 'sessions.tools');
    await read(sdk.sessions, 'getToolSelection', { sessionId: binding.sessionId }, value => {
      check(value.sessionId === binding.sessionId && ['current', 'next-turn'].includes(value.effective), 'PROJECT_REPORT_TOOL_READBACK_INVALID');
      const selection = { toolNames: names(value.toolNames), effective: value.effective,
        pendingToolNames: value.pendingToolNames === null ? null : names(value.pendingToolNames) };
      result.selection = selection;
    }, 'sessions.getToolSelection');
    await read(sdk.agents, 'profile', { agentId: binding.agentId, scope: 'own' }, value => {
      check(value.profile?.id === binding.agentId && value.profile.ownerPluginId === APP
        && ['private', 'plugin_private'].includes(value.profile.visibility), 'PROJECT_REPORT_TOOL_READBACK_IDENTITY_INVALID');
      result.disabledToolNames = names(value.profile.toolPolicy?.disabled);
    }, 'agents.profile');
    await read(sdk.agents, 'config', { agentId: binding.agentId, scope: 'own' }, value => {
      check(object(value.config), 'PROJECT_REPORT_TOOL_READBACK_INVALID');
      const config = value.config, hasMode = Object.hasOwn(config, 'tool_call_mode'), hasLegacy = Object.hasOwn(config, 'lightweight_tools');
      const mode = config.tool_call_mode, legacy = config.lightweight_tools, app = config.extensions?.app?.[APP];
      check((!hasMode || ['full', 'standard', 'light', 'minimal'].includes(mode))
        && (!hasLegacy || typeof legacy === 'boolean')
        && (app === undefined || object(app))
        && (app?.enabled === undefined || typeof app.enabled === 'boolean')
        && (app?.tools === undefined || object(app.tools)),
      'PROJECT_REPORT_TOOL_READBACK_INVALID');
      result.verifierConfig = { mode: hasMode ? mode : legacy === false ? 'full' : 'standard',
        modeSource: hasMode ? 'explicit' : hasLegacy ? 'legacy' : 'default', appEnabled: app?.enabled !== false,
        disabledNames: result.disabledToolNames };
    }, 'agents.config');
    result.status = result.errors.length ? (result.errors.every(e => e.code === 'UNSUPPORTED') ? 'unsupported' : 'unconfirmed') : 'confirmed';
    return result;
  }
  async function status(p, args, ctx, options) {
    await authorizeCreator(p, ctx);
    if (deferHistoricalWork === true) await prepareHistory(p, () => authorizeCreator(p, ctx));
    const r = getKind(p, args.reportId, options);
    if (r.meta.kind === 'paper-plan' && r.meta.state === 'completed') await readSavedPlan(p, r);
    const inspection = r.meta.kind === 'paper-section' && r.meta.state === 'completed'
      ? await (r.historical ? readSavedSection(p, r) : inspectSavedSection(p, r, true)) : null;
    if (r.historical && r.meta.kind === 'paper-revision' && r.meta.revision.mode === 'operator-notes' && r.meta.state === 'completed') {
      await readOperatorNotes(p, r);
    }
    let mathReviewError = null;
    if (r.meta.kind === 'paper-math-verification') {
      mathReviewChecks.delete(r);
      // A producer-completed record can be observed while its Host task receipt
      // is still pending. Do not parse/project a verdict until settlement is clean.
      if (cleanMathCompletion(r)) {
        try { await readPaperMathReview(p, r); }
        catch { mathReviewChecks.delete(r); mathReviewError = { code: 'PROJECT_PAPER_MATH_REVIEW_INVALID', phase: 'archive-validation' }; }
      }
    }
    const result = readView(r);
    if (inspection?.readError) result.readError = inspection.readError;
    if (mathReviewError) result.readError = mathReviewError;
    if (r.meta.kind === 'reference-verification' && TERMINAL.has(r.meta.state) && r.meta.writer?.sessionId) {
      result.writer.toolAvailabilityReadback = await toolAvailabilityReadback(p, r);
    }
    return result;
  }
  async function stageSummaryHtml(p, r, ctx, creator, artifact, input, inputSha256) {
    const m = r.meta, dir = directory(p, m.reportId);
    const unavailable = reason => ({ status: 'not-staged', reason });
    function clean() {
      try { assertLive(p); } catch { return false; }
      return !disposed && !r.failedSave && records.get(key(p, m.reportId)) === r
        && (m.kind ?? 'summary') === 'summary' && m.state === 'completed' && m.taskSettlement === 'confirmed'
        && !m.stopRequested && !planCleanupPending(m) && (!r.job || r.jobSettled)
        && !m.error && !m.archiveError && !m.taskError && !m.recoveryError
        && !m.flagged && !['flagged', 'invalid'].includes(m.sourceStatus)
        && Object.hasOwn(m, 'leakFindings') && Array.isArray(m.leakFindings) && m.leakFindings.length === 0
        && typeof creator.sessionId === 'string' && creator.sessionId && typeof creator.sessionPath === 'string'
        && creator.sessionPath === ctx.sessionPath && creator.sessionPath === m.creator?.sessionPath
        && creator.sessionPath === p.meta.creator?.sessionPath && creator.sessionId === m.creator?.sessionId
        && creator.sessionId === p.meta.creator?.sessionId
        && artifact === `${dir}/report.md` && artifact === (m.publishedArtifact ?? m.artifact)
        && inputSha256 === (m.publishedArtifact ? m.publishedSha256 : m.sha256)
        && input.length === (m.publishedArtifact ? m.publishedBytes : m.bytes);
    }
    if (!clean()) return unavailable('SUMMARY_HTML_NOT_CLEAN');
    if (input.length > SUMMARY_HTML_INPUT_MAX_BYTES) return unavailable('SUMMARY_HTML_SIZE_LIMIT');
    let markdown;
    try { markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
    catch { return unavailable('SUMMARY_HTML_NOT_CLEAN'); }
    if (!markdown.trim() || leakFindings(markdown).length) return unavailable('SUMMARY_HTML_NOT_CLEAN');

    let output;
    try {
      const { renderSummaryHtml } = await import('./summary-render.mjs');
      const rendered = await renderSummaryHtml(markdown);
      if (Buffer.byteLength(rendered, 'utf8') > SUMMARY_HTML_MAX_BYTES) return unavailable('SUMMARY_HTML_SIZE_LIMIT');
      output = Buffer.from(rendered, 'utf8');
    } catch (error) {
      return unavailable(error?.code === 'SUMMARY_HTML_NOT_SELF_CONTAINED' ? error.code : 'SUMMARY_HTML_RENDER_FAILED');
    }

    // Serialize only local derivative storage. The original Markdown and its
    // delivery metadata remain authoritative; no HTML receipt is cached there.
    const name = `${dir}/report.html`;
    let witness;
    try {
      witness = await exclusive(r, async () => {
        if (!clean()) return null;
        let saved;
        try { saved = await store.readWitness(name); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        if (!saved?.bytes.equals(output)) {
          if (!clean()) return null;
          await store.write(name, output, true);
          saved = await store.readWitness(name);
          check(saved.bytes.equals(output), 'SUMMARY_HTML_STORAGE_FAILED');
        }
        return saved.identity;
      });
    } catch { return unavailable('SUMMARY_HTML_STORAGE_FAILED'); }
    if (witness === null || !clean()) return unavailable('SUMMARY_HTML_NOT_CLEAN');

    try { await authorizeCreator(p, ctx); } catch { return unavailable('SUMMARY_HTML_CREATOR_DENIED'); }
    try {
      if (await store.fileIdentity(name) !== witness) return unavailable('SUMMARY_HTML_STORAGE_FAILED');
    } catch { return unavailable('SUMMARY_HTML_STORAGE_FAILED'); }
    if (!clean()) return unavailable('SUMMARY_HTML_NOT_CLEAN');
    let receipt;
    try {
      receipt = await bounded(sdk.resources.stage({ path: store.absolute(name), name: 'math-progress-report.html', mime: 'text/html', deliverAs: 'attachment' }));
    } catch { return unavailable('SUMMARY_HTML_STAGE_FAILED'); }
    if (receipt?.ok === false || receipt?.error) return unavailable('SUMMARY_HTML_STAGE_FAILED');
    const resource = receipt?.resource;
    if (resource?.kind !== 'session-file' || typeof resource.fileId !== 'string' || !resource.fileId
      || resource.sessionId !== creator.sessionId) return unavailable('SUMMARY_HTML_STAGE_INVALID');
    if (!clean()) return unavailable('SUMMARY_HTML_NOT_CLEAN');
    return { status: 'staged', resource: { kind: 'session-file', fileId: resource.fileId, sessionId: resource.sessionId },
      sha256: hash(output), bytes: output.length };
  }
  async function result(p, args, ctx, options) {
    await authorizeCreator(p, ctx);
    if (deferHistoricalWork === true) await prepareHistory(p, () => authorizeCreator(p, ctx));
    const r = getKind(p, args.reportId, options), m = r.meta;
    if (m.kind === 'paper-source' || m.kind === 'reference-audit' || m.kind === 'reference-verification' || m.kind === 'paper-revision'
      || m.kind === 'paper-plan' || m.kind === 'paper-section' || m.kind === 'paper-math-verification') return paperResult(p, r);
    check(['completed', 'leak'].includes(m.state) && !m.cleanupPending && !r.failedSave, 'PROJECT_REPORT_NOT_READY');
    if (m.state === 'leak') return { ...view(r), saved: true, status: 'leak' };
    const { sessionId, sessionPath } = p.meta.creator ?? {};
    const artifact = m.publishedArtifact ?? m.artifact;
    check(artifact === `${directory(p, m.reportId)}/report.md`, 'PROJECT_REPORT_ARTIFACT_INVALID');
    const expectedBytes = m.publishedArtifact ? m.publishedBytes : m.bytes;
    const expectedHash = m.publishedArtifact ? m.publishedSha256 : m.sha256;
    const bytes = await store.read(artifact);
    check(bytes.length === expectedBytes && hash(bytes) === expectedHash, 'PROJECT_REPORT_ARTIFACT_INVALID');
    let markdownResult;
    try {
      const receipt = await sdk.resources.stage({ path: store.absolute(artifact), name: 'math-progress-report.md', mime: 'text/markdown', deliverAs: 'attachment' });
      const resource = receipt?.resource;
      check(receipt?.ok !== false && !receipt?.error && resource?.kind === 'session-file'
        && typeof resource.fileId === 'string' && resource.fileId && typeof sessionId === 'string' && resource.sessionId === sessionId,
      'PROJECT_REPORT_STAGE_INVALID');
      m.delivery = { state: 'staged', delivered: false, fileId: resource.fileId }; await save(p, r);
      markdownResult = { ...view(r), saved: true, status: 'ok', fileId: resource.fileId, resource: { kind: 'session-file', fileId: resource.fileId, sessionId: resource.sessionId },
        fullTextInFile: true, ...(bytes.length <= 16384 ? { report: bytes.toString('utf8') } : {}) };
    } catch (error) {
      m.delivery = { state: 'failed', delivered: false, error: code(error) }; await save(p, r);
      return { ...view(r), saved: true, status: 'delivery-failed', error: { code: 'PROJECT_REPORT_EXPORT_FAILED', cause: code(error) } };
    }
    return { ...markdownResult, html: await stageSummaryHtml(p, r, ctx, { sessionId, sessionPath }, artifact, bytes, expectedHash) };
  }
  async function stopInternal(p, r) {
    return exclusive(r, async () => {
      const math = r.meta.kind === 'paper-math-verification';
      if (math && (mathCompletionCandidate(r) || r.settlementPromise && TERMINAL.has(r.meta.state))) {
        // Join the producer's terminal settlement, including a rejection that
        // is still being saved. A stop cannot rewrite an already clean review.
        if (r.settlementPromise || !cleanMathCompletion(r)) await settle(p, r);
        if (!reportNeedsRecovery(r.meta) && !r.failedSave && (!r.job || r.jobSettled)
          && active.get(p.meta.projectId) === r) active.delete(p.meta.projectId);
        return settledMathView(p, r);
      }
      if (math && r.meta.state === 'completed') {
        r.meta.state = r.failedSave ? 'failed' : 'stopped'; r.meta.stopRequested = true;
        setReportError(r.meta, r.meta.error ?? (r.failedSave ? 'PROJECT_REPORT_PERSISTENCE_FAILED' : 'PROJECT_REPORT_STOPPED'));
        clearMathCompletion(r);
        await save(p, r);
      }
      if (linearKind(r.meta.kind)) r.meta.cleanupPending ||= r.meta.taskCreating || r.meta.scheduleCreating
        || r.meta.writerStarting || r.failedSave;
      if (TERMINAL.has(r.meta.state) && !r.meta.cleanupPending && r.meta.taskSettlement === 'confirmed'
        && !(linearKind(r.meta.kind) && r.meta.scheduleId)) return view(r);
      const terminalState = r.meta.state;
      r.meta.stopRequested = true; if (!TERMINAL.has(terminalState)) r.meta.state = 'stopped';
      r.meta.cleanupPending ||= r.meta.taskCreating || r.meta.scheduleCreating || r.meta.writerStarting;
      await save(p, r);
      try { await unschedule(p, r); } catch { r.meta.cleanupPending = true; }
      if (r.handle) {
        delete r.meta.recoveryStop; delete r.meta.recoveryError;
        try { const stopped = await r.handle.stop(); r.meta.writer = stoppedWriterEvidence(p, r, stopped); r.meta.cleanupPending = stopped?.cleanupPending !== false; }
        catch { r.meta.cleanupPending = true; }
      } else if (r.meta.writer?.sessionId) {
        delete r.meta.recoveryStop; delete r.meta.recoveryError;
        try {
          const stopped = await confirmResearchSessionStop(sdk, r.meta.writer);
          r.meta.recoveryStop = stopped.abortOutcome;
          r.meta.cleanupPending = !CONFIRMED_RECOVERY_STOPS.has(stopped.abortOutcome);
        } catch (error) { r.meta.recoveryError = code(error); r.meta.cleanupPending = true; }
      } else if (r.meta.writerStarting) r.meta.cleanupPending = true;
      else if (r.meta.kind === 'paper-revision' && r.meta.revision.mode === 'operator-notes' && !r.failedSave
        && !r.meta.taskId && !r.meta.taskCreating && !r.meta.scheduleId && !r.meta.scheduleCreating) {
        // A recovered pre-task archive failure has no Host resources. Never clear uncertain creation markers.
        r.meta.cleanupPending = false; r.meta.taskSettlement = 'confirmed';
      }
      if (linearKind(r.meta.kind) || math) r.meta.cleanupPending ||= r.meta.taskCreating || r.meta.scheduleCreating
        || r.meta.writerStarting || Boolean(r.meta.scheduleId) || r.failedSave;
      await save(p, r); await settle(p, r);
      if (!r.meta.cleanupPending && r.meta.taskSettlement === 'confirmed' && (!r.job || r.jobSettled)
        && active.get(p.meta.projectId) === r) active.delete(p.meta.projectId);
      return view(r);
    });
  }
  async function stopHistorical(p, r) {
    return exclusive(r, async () => {
      assertLive(p); check(!disposed, 'PROJECT_DISPOSED');
      const m = r.meta;
      if (!reportNeedsRecovery(m)) return view(r);
      const unfinished = !TERMINAL.has(m.state);
      let pending = m.taskCreating || m.scheduleCreating || m.writerStarting || r.failedSave;
      if (unfinished) m.stopRequested = true;
      // Make the unresolved stop durable before Host side effects. Keep the recorded
      // state until cleanup and task settlement actually succeed.
      const stopWriter = !CONFIRMED_RECOVERY_STOPS.has(m.recoveryStop)
        && (unfinished || m.cleanupPending || writerCleanupPending(m));
      m.cleanupPending = true;
      await save(p, r);
      if (m.scheduleId) {
        try {
          const id = m.scheduleId, schedule = await bounded(sdk.tasks.getSchedule(id));
          if (schedule === null) {
            m.scheduleId = null; m.scheduleCleaned = true;
          } else {
            check(schedule?.scheduleId === id && schedule.pluginId === APP && schedule.scope === 'app' && schedule.handlerKey === HANDLER
              && schedule.payload?.projectId === m.projectId && schedule.payload.reportId === m.reportId
              && schedule.payload.nonce === m.nonce, 'PROJECT_REPORT_SCHEDULE_UNCONFIRMED');
            await unschedule(p, r);
          }
        } catch { pending = true; }
      }
      if (stopWriter && m.writer?.sessionId) {
        delete m.recoveryStop; delete m.recoveryError;
        try {
          const prefix = (m.kind ?? 'summary') === 'summary' ? 'math-summary' : `math-${m.kind}`;
          check(m.writer.kind === `${prefix}:${m.projectId}:${m.reportId}`
            && m.writer.cwd === store.absolute(directory(p, m.reportId)), 'PROJECT_REPORT_WRITER_UNCONFIRMED');
          const stopped = await confirmResearchSessionStop(sdk, m.writer);
          m.recoveryStop = stopped.abortOutcome;
        } catch (error) { pending = true; m.recoveryError = code(error); }
      }
      m.cleanupPending = pending || writerCleanupPending(m);
      if (!m.cleanupPending && m.taskSettlement !== 'confirmed') {
        if (!m.taskId && !m.taskCreating) m.taskSettlement = 'confirmed';
        else await settle(p, r);
      }
      if (unfinished && !m.cleanupPending && m.taskSettlement === 'confirmed') {
        m.state = 'stopped'; setReportError(m, 'PROJECT_REPORT_STOPPED');
      }
      await save(p, r);
      if (!reportNeedsRecovery(m)) {
        const blockers = deferredByProject.get(m.projectId);
        blockers?.delete(r);
        if (!blockers?.size) deferredByProject.delete(m.projectId);
      }
      return view(r);
    });
  }
  async function stop(p, args, ctx, options) {
    await authorizeCreator(p, ctx);
    if (deferHistoricalWork === true) await prepareHistory(p, () => authorizeCreator(p, ctx));
    const r = getKind(p, args.reportId, options);
    return r.historical ? stopHistorical(p, r) : stopInternal(p, r);
  }
  async function revise(p, args, ctx) {
    args = snapshotPaperRevisionRequest(args);
    await authorizeCreator(p, ctx);
    if (deferHistoricalWork === true) await prepareHistory(p, () => authorizeCreator(p, ctx));
    // Select the lane before reading a parent; never fall back from citation failure.
    if (args.mode === 'operator-notes') {
      const parent = getKind(p, args.reportId, { kind: 'paper-source' });
      return start(p, { kind: 'paper-revision', language: 'English', revision: {
        mode: 'operator-notes', sourceReportId: parent.meta.reportId, paperId: parent.meta.paper.paperId }, notes: args.notes }, ctx);
    }
    // Read only the selector, not status(): verifier status may persist live tool diagnostics.
    const parent = getKind(p, args.reportId, { kind: 'reference-verification' });
    return start(p, { kind: 'paper-revision', language: 'English', revision: {
      verificationReportId: parent.meta.reportId, paperId: parent.meta.verification.paperId } }, ctx);
  }
  const verifierIdentityKeys = ['role', 'agentId', 'sessionId', 'sessionPath', 'cwd', 'kind'];
  const verifierRecords = () => [...records.values()].filter(r => r.meta.kind === 'reference-verification' && r.meta.writer);
  async function literatureRoutes(ctx) {
    if (typeof ctx?.sessionPath !== 'string' || !ctx.sessionPath) return [];
    const known = verifierRecords(), direct = known.filter(r => r.meta.writer.sessionPath === ctx.sessionPath);
    if (direct.length) return direct;
    if (!known.some(r => r.meta.writer.sessionId)) return [];
    const result = await bounded(sdk.sessions.list({ scope: 'own', lifecycle: 'all', ownerPluginId: APP }));
    check(result?.ok !== false && !result?.error && Array.isArray(result?.sessions), 'PROJECT_REFERENCE_VERIFY_DENIED');
    const matches = result.sessions.filter(row => row.path === ctx.sessionPath);
    check(matches.length <= 1, 'PROJECT_REFERENCE_VERIFY_DENIED');
    return known.filter(r => matches.some(row => row.sessionId && row.sessionId === r.meta.writer.sessionId));
  }
  async function handlesLiterature(ctx) {
    if (typeof ctx?.sessionPath !== 'string' || !ctx.sessionPath) return false;
    const candidates = await literatureRoutes(ctx);
    // Route the dedicated verifier so an unexpected App-tool invocation is
    // denied here instead of falling through to the legacy/main authority.
    return candidates.length > 0;
  }
  async function invokeLiterature(name, args, ctx) {
    check(name === 'search_arxiv_theorems' && object(ctx) && typeof ctx.callToken === 'string' && ctx.callToken.length > 0
      && typeof ctx.sessionPath === 'string' && ctx.sessionPath.length > 0, 'PROJECT_REFERENCE_VERIFY_DENIED');
    check(object(args) && Object.keys(args).every(k => ['query', 'num_results'].includes(k))
      && typeof args.query === 'string' && args.query.isWellFormed() && !args.query.includes('\0') && args.query.trim()
      && Buffer.byteLength(args.query) <= 16384 && (args.num_results === undefined
        || Number.isInteger(args.num_results) && args.num_results >= 1 && args.num_results <= 100), 'PROJECT_INVALID_INPUT');
    const query = args.query, numResults = args.num_results ?? 10, token = ctx.callToken, callerPath = ctx.sessionPath;
    const captured = verifierRecords().map(r => ({ r, binding: Object.fromEntries(verifierIdentityKeys.map(k => [k, r.meta.writer[k]])),
      verification: JSON.stringify(r.meta.verification), taskId: r.meta.taskId }));
    const candidates = await literatureRoutes(ctx);
    check(candidates.length === 1, 'PROJECT_REFERENCE_VERIFY_DENIED');
    const r = candidates[0], p = getProject(r.meta.projectId), saved = captured.find(c => c.r === r);
    check(saved && r.meta.writer?.role !== 'reference-verifier', 'PROJECT_REFERENCE_VERIFY_DENIED');
    const { binding, verification, taskId } = saved;
    const assertBinding = () => {
      current(p, r);
      check(active.get(p.meta.projectId) === r && ctx.callToken === token && ctx.sessionPath === callerPath && r.meta.taskId === taskId
        && JSON.stringify(r.meta.verification) === verification && r.meta.kind === 'reference-verification'
        && verifierIdentityKeys.every(k => r.meta.writer?.[k] === binding[k])
        && binding.role === 'reference-verifier' && binding.sessionPath === callerPath
        && typeof binding.agentId === 'string' && /^math-reference-verifier-[0-9a-f-]{36}$/.test(binding.agentId)
        && typeof binding.sessionId === 'string' && binding.sessionId.length > 0
        && binding.cwd === store.absolute(directory(p, r.meta.reportId))
        && binding.kind === `math-reference-verification:${p.meta.projectId}:${r.meta.reportId}`
        && ['preparing', 'running'].includes(r.meta.writer?.state), 'PROJECT_REFERENCE_VERIFY_DENIED');
    };
    const checkHost = async () => {
      assertBinding();
      const info = await readResearchSessionInfo(sdk, { sessionPath: callerPath }); assertBinding();
      check(info.sessionId === binding.sessionId && info.path === binding.sessionPath && info.agentId === binding.agentId
        && info.cwd === binding.cwd && info.kind === binding.kind && info.lifecycle === 'active', 'PROJECT_REFERENCE_VERIFY_DENIED');
      const agents = await bounded(sdk.agents.list({ scope: 'own', lifecycle: 'all' })); assertBinding();
      const matches = agents?.ok !== false && !agents?.error && Array.isArray(agents?.agents)
        ? agents.agents.filter(a => a.id === binding.agentId) : [];
      check(matches.length === 1 && matches[0].state === 'active' && matches[0].deletedAt == null
        && matches[0].ownerPluginId === APP && ['private', 'plugin_private'].includes(matches[0].visibility)
        && matches[0].plugin?.ownerPluginId === APP && ['private', 'plugin_private'].includes(matches[0].plugin?.visibility)
        && matches[0].plugin?.kind === 'math-reference-verifier' && !matches[0].plugin?.roleId, 'PROJECT_REFERENCE_VERIFY_DENIED');
    };
    await checkHost(); await readGuard(p, r); assertBinding();
    await checkHost(); await readGuard(p, r); assertBinding();
    check(typeof literature?.search === 'function', 'PROJECT_REFERENCE_VERIFY_LITERATURE_UNAVAILABLE');
    return literature.search(query, numResults);
  }
  // Default recovery never starts an Agent, a session or a model send.
  if (deferHistoricalWork !== true) for (const p of projects()) {
    let names;
    try { names = await store.list(`${projectLocation(p)}/reports`); }
    catch (error) { if (error.code === 'ENOENT') continue; damaged.add(p.meta.projectId); continue; }
    for (const id of names.filter(name => REPORT_ID.test(name))) {
      try {
        const meta = await store.readJson(statePath(p, id)); checkRecord(p, meta, id);
        const r = wrap(meta);
        if (linearKind(meta.kind) && meta.state === 'completed') {
          const cleanupPending = planCleanupPending(meta);
          try { if (meta.kind === 'paper-section') await readSavedSection(p, r); else await readSavedPlan(p, r); }
          catch (error) {
            // Invalid output must not hide valid ownership of unresolved Host resources.
            // Clean, settled archives remain quarantined; never rewrite their bytes.
            if (!cleanupPending && meta.taskSettlement === 'confirmed') throw error;
            meta.archiveError = 'PROJECT_REPORT_ARTIFACT_INVALID';
            meta.state = 'interrupted'; setReportError(meta, meta.archiveError);
            meta.cleanupPending = cleanupPending;
            await save(p, r);
          }
          // A live schedule/writer is independent evidence even without the report bit.
          meta.cleanupPending ||= cleanupPending;
        }
        if (meta.kind === 'paper-revision' && meta.revision.mode === 'operator-notes' && meta.state === 'completed') await readOperatorNotes(p, r);
        records.set(key(p, id), r);
        if (['completed', 'leak'].includes(meta.state) && !meta.cleanupPending
          && !meta.taskCreating && !meta.scheduleCreating && !meta.writerStarting) {
          if (meta.taskSettlement !== 'confirmed') await settle(p, r);
          if (meta.taskSettlement !== 'confirmed') {
            if (active.has(p.meta.projectId)) damaged.add(p.meta.projectId);
            else active.set(p.meta.projectId, r);
          }
          continue;
        }
        if (!TERMINAL.has(meta.state) || meta.cleanupPending || meta.taskCreating || meta.scheduleCreating || meta.writerStarting) {
          meta.state = 'interrupted'; setReportError(meta, 'PROJECT_REPORT_INTERRUPTED');
          meta.cleanupPending = meta.cleanupPending || meta.taskCreating || meta.scheduleCreating || meta.writerStarting;
          if (meta.writer?.sessionId) {
            delete meta.recoveryStop; delete meta.recoveryError;
            try {
              const stopped = await confirmResearchSessionStop(sdk, meta.writer);
              meta.cleanupPending = meta.cleanupPending || !CONFIRMED_RECOVERY_STOPS.has(stopped.abortOutcome);
              meta.recoveryStop = stopped.abortOutcome;
            } catch (error) { meta.cleanupPending = true; meta.recoveryError = code(error); }
          }
          try { await unschedule(p, r); } catch { meta.cleanupPending = true; }
          await save(p, r);
        }
        if (meta.taskSettlement !== 'confirmed') await settle(p, r);
        if (meta.cleanupPending || meta.taskSettlement !== 'confirmed') {
          if (active.has(p.meta.projectId)) damaged.add(p.meta.projectId);
          else active.set(p.meta.projectId, r);
        }
      } catch { damaged.add(p.meta.projectId); }
    }
  }
  if (sdk.tasks?.registerHandler) {
    registration = await bounded(sdk.tasks.registerHandler(HANDLER, { run: handle, abort: async taskId => {
      if (disposed) return { status: 'ignored' };
      for (const r of records.values()) if (!r.historical && r.meta.taskId === taskId) return stopInternal(getProject(r.meta.projectId), r);
      return { status: 'ignored' };
    } }));
    if (registration?.ready) await bounded(registration.ready);
  }
  async function dispose() {
    disposed = true;
    const errors = [];
    for (const r of active.values()) {
      try { await stopInternal(getProject(r.meta.projectId), r); } catch (error) { errors.push({ code: code(error) }); }
    }
    let writer = { cleanupPending: false, errors: [] };
    if (summaryWriter?.dispose) { try { writer = await summaryWriter.dispose(); } catch (error) { writer = { cleanupPending: true, errors: [{ code: code(error) }] }; } }
    if (registration?.disposeAsync) await registration.disposeAsync(); else if (typeof registration === 'function') registration();
    return { cleanupPending: damaged.size > 0 || active.size > 0 || deferredByProject.size > 0 || hasUnopenedHistory()
        || writer?.cleanupPending !== false || errors.length > 0,
      errors: [...errors, ...(writer?.errors ?? [])] };
  }
  function hasUnopenedHistory() {
    // Only this process's exclusive Project creation rules out prior reports.
    // Do not list or load old metadata to make a shutdown claim.
    if (deferHistoricalWork === true) for (const p of projects()) {
      if (!historyPreparation.get(p)?.ready && isFreshProject(p) !== true) return true;
    }
    return false;
  }
  function dashboardShutdownIdle() {
    return !disposed && active.size === 0 && deferredByProject.size === 0 && damaged.size === 0 && !hasUnopenedHistory();
  }
  return Object.freeze({ start, status, result, stop, revise, stitch, handlesLiterature, invokeLiterature, dispose, dashboardShutdownIdle });
}
