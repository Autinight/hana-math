// Trusted backend service. Callers must pass the Host-injected tool context,
// never a model argument named context. handles() is routing, not authority.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { types } from 'node:util';
import { createContextStore, contextId } from './context-service.mjs';
import { createProjectCoreAccess, normalizeProjectCoreArguments, projectCoreManagedIpcRefusal, releaseValidatedProjectRead, acceptDashboardViewRead, acceptDashboardViewBusy, acceptDashboardViewGraphFallback } from './project-core-access.mjs';
import { createProjectMainSession } from './project-main-session.mjs';
import * as projectMainSession from './project-main-session.mjs';
import { createMainControlService } from './main-control-service.mjs';
import { readResearchSessionInfo } from './research-session-info.mjs';
import { submissionProjection } from './submission-diagnostics.mjs';
import { normalizeResearchWorkerPolicy, RESEARCH_WORKER_POLICY_DEFAULTS } from './worker-policy.mjs';
import { NATIVE_LITERATURE_GUIDANCE } from './native-literature.mjs';
import { nativeExplorationGuidance } from './native-exploration.mjs';
import { verificationReadBudget } from './verification-read-audit.mjs';
import { factPageOptions, validateFactPage, FACT_PAGE_GUIDANCE, isCanonicalFact } from './fact-page.mjs';
import { readManagedIpcUsage, runtimeRejectionInfo, supportsManagedDashboardReads, validProjectDashboardMemorySelection } from './runtime/research-runtime.mjs';
import { DEFAULT_LANGUAGE, LANGUAGE } from './human-summary.mjs';
import { createProjectReportService } from './project-report-service.mjs';
import { snapshotPaperRevisionRequest } from './paper-revision-input.mjs';
import { snapshotPaperDeliveryRequest } from './paper-delivery.mjs';
import { snapshotChapterTreeRequest } from './paper-chapter-tree.mjs';
import { collectProjectGraph, GRAPH_FACT_LIMIT, GRAPH_EDGE_LIMIT } from './project-graph.mjs';
import { normalizeWorkerDispatch, workerDisplayTitle, WORKER_DISPLAY_TITLE_GUIDANCE } from './worker-selection.mjs';
import { projectWorkerModels, workerModelPage } from './worker-model-options.mjs';
import { RUN_RESOURCE_FLAGS, runSettlementState } from './worker-stop-reconciliation.mjs';
import { collectPaperFacts } from './paper-facts.mjs';
import { capturePlanMaterial, assertPlanBrief } from './paper-plan.mjs';
import { snapshotPaperPlanRequest, snapshotPlanData } from './paper-plan-input.mjs';
import { snapshotPaperSectionRequest, snapshotPaperStitchRequest } from './paper-section-input.mjs';
import { paperSkeleton, normalizePaperSelection, capturePaperMaterial } from './paper-source.mjs';
import { operatorFields, updateOperatorAnswers, renderOperatorProfile } from './operator-interview.mjs';
import { observeProjectLifecycle, observeProjectSnapshot, createWorkspaceMonitorSelection, createWorkspaceDashboardSelection } from './dashboard-monitor-selection.mjs';
import { createWorkspaceDashboard, workspaceProjectBusy } from './dashboard-monitor-transport.mjs';
import { createTerminalReadFence, terminalWriteState } from './terminal-dashboard-read.mjs';
import { createWorkspaceSnapshotArchive } from './workspace-snapshot-archive.mjs';
import { createWorkspaceFollowConsent, workspaceFollowBinding } from './workspace-follow-consent.mjs';
import { createSnapshotPublisher, withPublishedWorkspaceDashboard } from './workspace-snapshot-publication.mjs';

// One queue per App data directory, shared by profile updates and creation snapshots.
const operatorQueues = new Map();
const OPERATOR_PATH = 'research/operator-profile.json';
const OPERATOR_SHARE = 'Save only your own answers you explicitly agree to share across authorized conversations in this local App and with Main and Worker in future projects. An explicit operatorProfile overrides the saved answers for that project. Existing projects are not changed. Do not include secrets or transcripts.';
const APP = 'hana-math', BASE = 'research/projects', HANDLER = 'math-project-setup', WORKER = 'worker-1';
const MAX_WORKERS = 4, WORKER_ID = /^worker-[1-4]$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const CORE_QUEUE_LIMIT = 16, CORE_QUEUE_WAIT_MS = 10000;
const CORE_MUTATIONS = new Set(['gm_add', 'fact_revoke']);
// These bridge errors occur before run allocation; post-admission failures carry runId.
const START_REJECTIONS = new Set(['WORKER_BUSY', 'RUN_BUSY', 'CONFIGURATION_BUSY', 'RECOVERY_BLOCKED', 'LEGACY_PROJECT_FORBIDDEN', 'DEPENDENCY_MISSING']);
const FACT_ID = /^[a-f0-9]{16}$/;
const DASHBOARD_MAIN_IDENTITY = ['sessionId','sessionPath','agentId','cwd','kind','namespace',
  'visibility','ownerPluginId','state','identityConfirmed','role','phase'];
const MAIN_TOOLS = new Set(['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems']);
const PAPER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/, SHA256 = /^[a-f0-9]{64}$/, MAX_TARGET_FACTS = 64;
const TARGET_KEYS = ['schemaVersion', 'projectId', 'paperId', 'factIds', 'factDigests', 'finalizedBy', 'at'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const copy = v => structuredClone(v);
const failure = code => Object.assign(new Error(code), { code });
function check(ok, code) { if (!ok) throw failure(code); }
function fields(v, allowed, required = allowed) {
  check(object(v) && Object.keys(v).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(v, k)), 'PROJECT_INVALID_INPUT');
}
function text(v) { check(typeof v === 'string' && v.trim() && !v.includes('\0') && Buffer.byteLength(v) <= 128 * 1024, 'PROJECT_INVALID_INPUT'); }
function json(v, limit = 2 * 1024 * 1024) { const s = JSON.stringify(v); check(typeof s === 'string' && Buffer.byteLength(s) <= limit, 'PROJECT_RECORD_TOO_LARGE'); return s + '\n'; }
function code(e) { return typeof e?.code === 'string' && /^[A-Za-z0-9_]{1,96}$/.test(e.code) ? e.code : 'PROJECT_OPERATION_FAILED'; }
// Facade refusal for a drifted fact-index observation. Checks the checked
// runtime projection first, then the own-data Core cause; never runs getters.
function factPageChanged(error) {
  const own = (value, key) => value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  if (runtimeRejectionInfo(own(error, 'runtime'))?.reason === 'fact-page-changed') return true;
  for (let cause = error, depth = 0; cause && depth < 4; cause = own(cause, 'cause'), depth++) {
    if (own(own(cause, 'coreError'), 'code') === 'fact_page_changed') return true;
  }
  return false;
}
function targetRecordValid(record, projectId, paperId) {
  if (!object(record) || Object.keys(record).length !== TARGET_KEYS.length || !TARGET_KEYS.every(key => Object.hasOwn(record, key))) return false;
  const ids = record.factIds;
  return record.schemaVersion === 1 && record.projectId === projectId && record.paperId === paperId && record.finalizedBy === 'creator'
    && Number.isSafeInteger(record.at) && record.at >= 0
    && Array.isArray(ids) && ids.length >= 1 && ids.length <= MAX_TARGET_FACTS && ids.every(id => typeof id === 'string' && FACT_ID.test(id)) && new Set(ids).size === ids.length
    && object(record.factDigests) && Object.keys(record.factDigests).length === ids.length
    && ids.every(id => Object.hasOwn(record.factDigests, id) && typeof record.factDigests[id] === 'string' && SHA256.test(record.factDigests[id]));
}
// meta.worker is worker-1; meta.extraWorkers (absent for N=1) holds worker-2..N with the same shape.
function workersOf(meta) { return [meta.worker, ...(Array.isArray(meta.extraWorkers) ? meta.extraWorkers : [])]; }
function workerRecordValid(worker, workerId) {
  return object(worker) && worker.workerId === workerId && object(worker.assignment) && object(worker.start) && Array.isArray(worker.runs);
}
function projectWorkerPolicy(meta) {
  if (!Object.hasOwn(meta, 'workerPolicy')) return undefined;
  check(object(meta.workerPolicy) && Object.keys(RESEARCH_WORKER_POLICY_DEFAULTS).every(key => Object.hasOwn(meta.workerPolicy, key)), 'PROJECT_WORKER_POLICY_INVALID');
  try { return normalizeResearchWorkerPolicy(meta.workerPolicy); }
  catch { throw failure('PROJECT_WORKER_POLICY_INVALID'); }
}
function workerPolicyPrompt(meta) {
  const policy = projectWorkerPolicy(meta);
  if (!policy) return 'Each job has at most three mathematical rounds and a 60-900 second timeout (default 900). For this legacy project, math_project stop is immediate.';
  return `Research worker policy: maxRounds=${policy.maxRounds} (${policy.maxRounds === 0 ? 'unlimited mathematical rounds' : 'maximum mathematical rounds'}), roundTimeoutSeconds=${policy.roundTimeoutSeconds} per mathematical round, roundDelaySeconds=${policy.roundDelaySeconds}, maxConsecutiveFailures=${policy.maxConsecutiveFailures} (${policy.maxConsecutiveFailures === 0 ? 'failure cutoff disabled' : 'consecutive-failure cutoff'}). Omitting start.timeoutSeconds sets no total run time cap; an explicit 60-900 seconds caps the whole run, not each round. math_project stop requests a stop at the mathematical round boundary; force=true requests immediate termination.`;
}
function invocation(ctx) { check(typeof ctx?.callToken === 'string' && ctx.callToken && typeof ctx.sessionPath === 'string' && ctx.sessionPath, 'CALLER_UNBOUND'); }
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('PROJECT_CONTROL_TIMEOUT')), 10000); })]).finally(() => clearTimeout(timer));
}
function mathematicalUnsettled(record) {
  return CORE_MUTATIONS.has(record.operation) && (record.mathematicalUnsettled === true
    || record.outcome?.state === 'pending' || record.outcome?.failure?.runtime?.indeterminate === true);
}
function resourceUnsettled(record) {
  return record.pending !== false || record.phase !== 'finished' || !record.cleanup?.confirmed || !record.settlement?.confirmed
    || !['succeeded', 'failed', 'not-started', 'pending'].includes(record.outcome?.state)
    || record.outcome?.failure?.runtime?.startOutcome === 'unknown' || record.outcome?.failure?.runtime?.cleanup?.confirmed === false;
}
function coreUnsettled(record) { return mathematicalUnsettled(record) || resourceUnsettled(record); }
function jobUnsettled(value) {
  return !['finished', 'failed', 'stopped', 'interrupted'].includes(value.state) || value.coordinatorActive !== false
    || value.cleanupPending !== false || value.runtimeCleanupPending !== false || value.indeterminate !== false
    || Object.hasOwn(value, 'candidateSettlement') && value.candidateSettlement !== null
    || value.finalizing !== false || value.coreTaskCreatePending !== false || value.coreTaskSettlementPending !== false || value.recoveryUnsettled === true;
}

export async function createProjectService(sdk, { contexts, profiles, research, createCore, literature, createMainSession = createProjectMainSession, summaryWriter, deferHistoricalWork = false } = {}) {
  check(contexts?.prepare && contexts?.prepareProjectWorkspace && contexts?.assignWorkerTask && profiles && research?.startWorkerRun
    && research?.projectWorkerStatus && research?.stopProjectWorker && typeof createCore === 'function' && literature?.search
    && typeof createMainSession === 'function', 'PROJECT_DEPENDENCY_MISSING');
  const { dataDir } = sdk;
  const store = createContextStore(dataDir), projects = new Map(), damaged = new Set();
  let closing = false, disposed = false, disposal, disposeComplete = false, disposeScopeObservation = false;
  let drainingPublication = false, goalActions = 0;
  const publicationGuards = new WeakSet();
  let monitorActivation = 0;
  const nextMonitorActivation = () => ++monitorActivation;
  const monitorWorkerStarts = new WeakMap();
  // Process-specific ownership. Restoring a Project journal never makes this
  // instance the owner of its setup task or of its previous worker's stop.
  const freshProjects = new WeakSet(), workerRunsStartedHere = new WeakMap();
  const dashboardSetupProofs = new WeakMap(), workspaceDashboardGrants = new WeakMap();
  let savedFollowChoice = null, savedFollowReader = null; // nomination is not a live grant or a terminal archive
  const archive = createWorkspaceSnapshotArchive(store);
  let archiveHealthy = true, publisher, offTerminal, offWorkerSettlement;
  try { await archive.load(); } catch { archiveHealthy = false; } // A damaged publication cannot prevent Research startup.
  const workspaceCoreWrites = new WeakMap(); // only App-managed shared mutations, not reads / polling
  // Only a confirmed create receipt in this process can own cancellation.
  // Restoring project metadata never restores a setup abort permit.
  const setupAbortOwners = new Map();
  function closeSetupAbort(p) {
    if (setupAbortOwners.get(p.meta.taskId)?.project === p) setupAbortOwners.delete(p.meta.taskId);
  }
  async function withSetupPermit(p, action) {
    // A claimed abort must resolve before we dispatch more setup work. Check
    // and invoke in the same turn so a new claim cannot slip past the fence.
    let owner;
    while ((owner = setupAbortOwners.get(p.meta.taskId))?.project === p && owner.checking) await owner.checking.catch(() => {});
    live(p); check(p.setupPermit, 'PROJECT_SETUP_INTERRUPTED');
    return action?.();
  }
  const location = (p, name = 'project.json') => `${BASE}/${p.meta.projectId}/${name}`;
  const wrap = meta => ({ meta, writes: Promise.resolve(), coreWrites: Promise.resolve(), records: new Map(), mathematicalFences: new Set(), core: null,
    coreQueue: [], coreWaiting: new Set(), coreDraining: false,
    control: false, coreBusy: false, persistenceFailed: false, coreBlocked: false, jobs: new Set(), scheduleCleanups: new Map(), nonce: null, setup: null, setupPermit: false,
    targets: new Map(), targetWrites: Promise.resolve(), targetControl: Promise.resolve() });
  function save(p, followUpdate, followGuard, followRecheck) {
    p.meta.revision++;
    const { workspaceFollow: _consent, ...snapshot } = p.meta, packet = json(snapshot);
    let admissionRefused = false;
    const guard = () => {
      try { followGuard(); } catch (error) { admissionRefused = true; throw error; }
    };
    const recheck = async () => {
      try { await followRecheck(); } catch (error) { admissionRefused = true; throw error; }
    };
    const writing = p.writes.catch(() => {}).then(async () => {
      // Snapshot regular metadata on admission, but select the confirmed policy
      // at the serialized write. Other saves neither copy a failed opt-in nor
      // overwrite an opt-in/revocation that settled ahead of them.
      if (followUpdate) guard();
      const follow = followUpdate ?? p.meta.workspaceFollow;
      const state = follow === undefined ? packet : `${packet.slice(0, -2)},"workspaceFollow":${JSON.stringify(follow)}}\n`;
      check(Buffer.byteLength(state) - 1 <= 2 * 1024 * 1024, 'PROJECT_RECORD_TOO_LARGE');
      if (followUpdate) {
        await store.writeGuarded(location(p), state, { guard, recheck });
        p.meta.workspaceFollow = followUpdate;
      } else await store.write(location(p), state, true);
    });
    p.writes = writing; writing.catch(() => { if (!admissionRefused) p.persistenceFailed = true; }); return writing;
  }
  const followConsent = createWorkspaceFollowConsent({
    binding: (p, enabled) => workspaceFollowBinding(p.meta, enabled ? DASHBOARD_MAIN_IDENTITY : []), authorize: authorizeDashboardFollow, save,
    changed: (p, enabled) => followPolicyChanged(p, enabled),
  });
  const getFollowState = followConsent.getState, getFollowStamp = followConsent.getStamp, getFollowArchiveStamp = followConsent.getArchiveStamp;
  function track(p, job) { p.jobs.add(job); job.finally(() => p.jobs.delete(job)).catch(() => {}); return job; }
  function targetExclusive(p, action) {
    const job = p.targetControl.catch(() => {}).then(action);
    p.targetControl = job; job.catch(() => {}); return job;
  }
  function unschedule(p, scheduleId) {
    const prior = p.scheduleCleanups.get(scheduleId);
    if (prior) return prior.promise;
    const cleanup = { removed: false, promise: null };
    // Register synchronously before any SDK call/await. Failure is shared too:
    // Host deletion is not idempotent, and APP_HOST_ERROR is not success proof.
    p.scheduleCleanups.set(scheduleId, cleanup);
    cleanup.promise = track(p, Promise.resolve().then(async () => {
      p.meta.scheduleId = scheduleId;
      p.meta.scheduleCleanup = { state: 'pending', error: null, removed: false }; await save(p);
      const receipt = await sdk.tasks.unschedule(scheduleId);
      check(receipt?.ok === true && !receipt.error, 'PROJECT_SCHEDULE_UNCONFIRMED');
      cleanup.removed = true;
      if (p.meta.scheduleId === scheduleId) p.meta.scheduleId = null;
      p.meta.scheduleCleanup = { state: 'confirmed', error: null, removed: true }; await save(p);
      return receipt;
    }).catch(async error => {
      p.meta.scheduleCleanup = { state: 'failed', error: code(error), removed: cleanup.removed };
      await save(p).catch(() => {}); throw error;
    }));
    return cleanup.promise;
  }
  function openForBusiness() { check(!closing, 'PROJECT_DISPOSED'); }
  function live(p, publication = false) {
    if (!(publication && drainingPublication && !disposed)) openForBusiness();
    check(!p.persistenceFailed, 'PROJECT_PERSISTENCE_FAILED');
  }
  function ready(p, publication = false) { live(p, publication); check(p.meta.state === 'ready' && p.meta.main?.state === 'ready' && p.meta.main.identityConfirmed === true, 'PROJECT_NOT_READY'); }
  function coreGate(p) { check(!p.detailsDeferred && !p.coreBlocked && ![...p.records.values()].some(coreUnsettled) && !p.core?.snapshot().pending, 'PROJECT_CORE_UNSETTLED'); }
  function get(id) { contextId(id); check(!damaged.has(id), 'PROJECT_RECORD_INVALID'); const p = projects.get(id); check(p, 'PROJECT_NOT_FOUND'); return p; }
  function assignmentProjection(value) {
    const unavailable = history => ({ available: false, history, coverage: history, recordingComplete: false });
    if (value === undefined) return unavailable('unknown');
    const uint = n => Number.isSafeInteger(n) && n >= 0;
    try {
      check(object(value) && value.available === true && ['complete', 'since-instrumentation'].includes(value.coverage)
        && (!Object.hasOwn(value, 'recordingComplete') || typeof value.recordingComplete === 'boolean')
        && uint(value.total) && uint(value.omitted) && Array.isArray(value.assignments)
        && value.assignments.length === Math.min(128, value.total) && value.omitted === value.total - value.assignments.length, 'PROJECT_ASSIGNMENT_HISTORY_INVALID');
      const assignments = value.assignments.map(a => {
        check(object(a) && typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256) && uint(a.at)
          && (a.lastRun === null || typeof a.lastRun === 'string' && /^run-[a-z0-9][a-z0-9-]{0,59}$/.test(a.lastRun)), 'PROJECT_ASSIGNMENT_HISTORY_INVALID');
        return { sha256: a.sha256, at: a.at, lastRun: a.lastRun, ...(typeof a.workerId === 'string' && WORKER_ID.test(a.workerId) ? { workerId: a.workerId } : {}),
          ...(Object.hasOwn(a, 'dispatch') ? { dispatch: normalizeWorkerDispatch(a.dispatch) } : {}) };
      });
      return { available: true, coverage: value.coverage, total: value.total, omitted: value.omitted, assignments, recordingComplete: value.recordingComplete !== false };
    } catch { return unavailable('invalid'); }
  }
  function view(p) {
    const policy = projectWorkerPolicy(p.meta);
    const assignmentHistory = assignmentProjection(p.meta.assignmentHistory);
    if (p.persistenceFailed) assignmentHistory.recordingComplete = false;
    const project = w => {
      const worker = { ...w };
      if (object(worker.status)) worker.status = { ...worker.status, submissionDiagnostics: submissionProjection(worker.status.submissionDiagnostics, worker.status.executionPolicy) };
      return worker;
    };
    const workers = workersOf(p.meta).map(project), worker = workers[0];
    return copy({ projectId: p.meta.projectId, taskId: p.meta.taskId, state: p.meta.state, error: p.meta.error,
      main: p.meta.main, startup: p.meta.startup, worker, workers, persistenceFailed: p.persistenceFailed,
      scheduleCleanup: p.meta.scheduleCleanup ? {
        state: ['pending', 'confirmed', 'failed'].includes(p.meta.scheduleCleanup.state) ? p.meta.scheduleCleanup.state : 'unknown',
        error: p.meta.scheduleCleanup.error ? code({ code: p.meta.scheduleCleanup.error }) : null,
        removed: p.meta.scheduleCleanup.removed === true,
      } : null,
      assignmentHistory,
      targets: [...p.targets.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, target]) => target),
      coreUnsettled: !!p.detailsDeferred || p.coreBlocked || [...p.records.values()].some(coreUnsettled) || !!p.core?.snapshot().pending,
      coreOperations: [...p.records.values()].map(r => ({ operationId: r.operationId, revision: r.revision, operation: r.operation,
        pending: r.pending, outcome: r.outcome?.state, indeterminate: mathematicalUnsettled(r) || r.outcome?.failure?.runtime?.indeterminate === true, mathematicalUnsettled: mathematicalUnsettled(r) })),
      ...(policy ? { workerPolicy: policy } : {}), workerBridge: policy ? 'configured-research-rounds' : 'bounded-three-mathematical-rounds', theoremEstablished: false });
  }
  async function ownSessions() {
    const result = await bounded(sdk.sessions.list({ scope: 'own', lifecycle: 'all', ownerPluginId: APP }));
    const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
    check(object(result) && result.ok !== false && !result.error && Array.isArray(result.sessions)
      && result.sessions.every(row => object(row) && row.ownerPluginId === APP && (row.sessionId === null || identity(row.sessionId)) && identity(row.path)
        && ['active', 'archived'].includes(row.lifecycle) && ['public', 'plugin_private'].includes(row.visibility))
      && new Set(result.sessions.filter(row => row.sessionId !== null).map(row => row.sessionId)).size === result.sessions.filter(row => row.sessionId !== null).length
      && new Set(result.sessions.map(row => row.path)).size === result.sessions.length, 'PROJECT_SESSION_LIST_INVALID');
    return result.sessions;
  }
  function orderedOperator(action) {
    const next = (operatorQueues.get(dataDir) ?? Promise.resolve()).catch(() => {}).then(() => {
      openForBusiness(); return action();
    });
    operatorQueues.set(dataDir, next);
    next.finally(() => { if (operatorQueues.get(dataDir) === next) operatorQueues.delete(dataDir); }).catch(() => {});
    return next;
  }
  async function readOperatorAnswers() {
    let record;
    try { record = await store.readJson(OPERATOR_PATH); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw failure('PROJECT_OPERATOR_PROFILE_UNAVAILABLE'); }
    fields(record, ['schemaVersion', 'answers']);
    check(record.schemaVersion === 1, 'PROJECT_OPERATOR_PROFILE_INVALID');
    return updateOperatorAnswers(record.answers, {});
  }
  function operatorView(answers) {
    return { scope: 'app', answers, fields: [...operatorFields], operatorProfile: renderOperatorProfile(answers), sharing: OPERATOR_SHARE };
  }
  function operatorSessionPath(ctx) {
    invocation(ctx);
    const { sessionPath } = ctx;
    check(sessionPath.length <= 4096 && !/[\x00-\x1f]/.test(sessionPath), 'CALLER_UNBOUND');
    return sessionPath;
  }
  async function assertExternalOperator(sessionPath) {
    // Use the Host-injected invocation and its exact path only to exclude
    // App-owned roles. Invalid or unavailable ownership listings deny access.
    const own = await ownSessions();
    check(!closing && !own.some(row => row.path === sessionPath), 'PROJECT_OPERATOR_DENIED');
  }
  async function operatorRead(ctx) {
    const sessionPath = operatorSessionPath(ctx);
    return orderedOperator(async () => {
      await assertExternalOperator(sessionPath);
      const answers = await readOperatorAnswers();
      openForBusiness();
      return operatorView(answers);
    });
  }
  async function operatorSave(args, ctx) {
    const sessionPath = operatorSessionPath(ctx);
    fields(args, ['answers']);
    const descriptor = Object.getOwnPropertyDescriptor(args, 'answers');
    check(Reflect.ownKeys(args).length === 1 && descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), 'PROJECT_INVALID_INPUT');
    const patch = descriptor.value;
    // Validate and detach before the queue waits; preserve null removals.
    const answers = updateOperatorAnswers({}, patch);
    const updates = Object.fromEntries(Reflect.ownKeys(patch).map(key => [key, Object.hasOwn(answers, key) ? answers[key] : null]));
    check(Object.keys(updates).length > 0, 'PROJECT_OPERATOR_PROFILE_INVALID');
    return orderedOperator(async () => {
      await assertExternalOperator(sessionPath);
      const next = updateOperatorAnswers(await readOperatorAnswers(), updates);
      openForBusiness();
      try { await store.write(OPERATOR_PATH, json({ schemaVersion: 1, answers: next }), true); }
      catch { throw failure('PROJECT_OPERATOR_PROFILE_UNAVAILABLE'); }
      return operatorView(next);
    });
  }
  async function authorize(p, ctx, mainOnly = false, admission = () => {}, { readOnly = false, finalStatus = false } = {}) {
    invocation(ctx);
    const assertAdmission = () => { admission(); if (!(readOnly && finalStatus && disposeComplete)) openForBusiness(); };
    assertAdmission();
    // Read-only evidence cannot authorize against an in-place changed binding.
    // Capture scalar values before even the initial asynchronous own-session list.
    const captured = readOnly ? p.meta.main : null, projectState = p.meta.state;
    const identityKeys = ['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind', 'namespace', 'visibility', 'ownerPluginId', 'state', 'identityConfirmed'];
    const before = captured ? Object.fromEntries(identityKeys.map(key => [key, captured[key]])) : null;
    const own = await ownSessions(); assertAdmission(); const binding = readOnly ? captured : p.meta.main;
    const mainRoute = binding?.sessionPath === ctx.sessionPath || own.some(row => row.path === ctx.sessionPath && row.sessionId !== null && row.sessionId === binding?.sessionId);
    if (p.meta.state === 'ready' && binding?.state === 'ready' && binding.identityConfirmed && mainRoute) {
      const identitySdk = readOnly ? { sessions: Object.fromEntries(['get', 'list'].map(name => [name, async ref => {
        assertAdmission(); const value = await sdk.sessions[name](ref); assertAdmission(); return value;
      }])) } : sdk;
      const info = await readResearchSessionInfo(identitySdk, { sessionPath: ctx.sessionPath }, { namespace: 'home' }); assertAdmission();
      check(info.sessionId === binding.sessionId && info.cwd === binding.cwd && info.agentId === binding.agentId
        && info.kind === binding.kind && info.lifecycle === 'active', 'PROJECT_MAIN_DENIED');
      const listed = await bounded(sdk.agents.list({ lifecycle: 'all' })); assertAdmission();
      const matches = listed?.ok !== false && !listed?.error && Array.isArray(listed?.agents) ? listed.agents.filter(a => a.id === binding.agentId) : [];
      check(matches.length === 1 && matches[0].state === 'active' && matches[0].deletedAt == null
        && matches[0].ownerPluginId === APP && ['private', 'plugin_private'].includes(matches[0].visibility)
        && matches[0].plugin?.ownerPluginId === APP && ['private', 'plugin_private'].includes(matches[0].plugin?.visibility)
        && matches[0].plugin?.kind === 'role' && matches[0].plugin?.roleId === 'main', 'PROJECT_MAIN_DENIED');
      if (readOnly) {
        check(before && p.meta.main === binding && projectState === 'ready' && p.meta.state === 'ready'
          && binding.state === 'ready' && binding.identityConfirmed === true
          && identityKeys.every(key => binding[key] === before[key])
          && ['sessionId', 'agentId', 'cwd', 'kind', 'namespace', 'visibility', 'ownerPluginId'].every(key => info[key] === before[key]), 'PROJECT_MAIN_DENIED');
        // Host-confirmed current locator may differ from the unchanged saved
        // locator; reading evidence neither migrates it in memory nor saves it.
      }
      if (!readOnly && binding.sessionPath !== info.path) { binding.sessionPath = info.path; await save(p); assertAdmission(); }
      if (p.detailsDeferred && !finalStatus) { await ensureProjectDetails(p); assertAdmission(); }
      return 'main';
    }
    // Like legacy owner checks, this uses the Host-stamped creator locator and
    // the genuine invocation context, without an out-of-scope session read.
    check(!mainOnly && !p.meta.creatorRejected && typeof p.meta.creator?.sessionId === 'string' && p.meta.creator.sessionId
      && p.meta.creator.sessionPath === ctx.sessionPath
      && !own.some(row => row.path === ctx.sessionPath || row.sessionId === p.meta.creator.sessionId), 'PROJECT_OWNER_DENIED');
    if (p.detailsDeferred && !finalStatus) { await ensureProjectDetails(p); assertAdmission(); }
    return 'creator';
  }
  async function boundMain(ctx, { readOnly = false } = {}) {
    invocation(ctx); const own = await ownSessions();
    const matches = [...projects.values()].filter(p => p.meta.main?.sessionPath === ctx.sessionPath
      || own.some(row => row.path === ctx.sessionPath && row.sessionId !== null && row.sessionId === p.meta.main?.sessionId));
    check(matches.length === 1, 'PROJECT_MAIN_DENIED');
    await authorize(matches[0], ctx, true, undefined, { readOnly }); return matches[0];
  }
  async function handles(ctx) {
    if (typeof ctx?.sessionPath !== 'string') return false;
    if (await reports.handlesLiterature(ctx)) return true;
    const bindings = [...projects.values()].map(p => p.meta.main).filter(binding => binding?.sessionPath || binding?.sessionId);
    if (bindings.some(binding => binding.sessionPath === ctx.sessionPath)) return true;
    if (!bindings.length) return false;
    const own = await ownSessions();
    return bindings.some(binding => own.some(row => row.path === ctx.sessionPath && row.sessionId !== null && row.sessionId === binding.sessionId));
  }
  function workerOf(args) { check(args.workerId === undefined || typeof args.workerId === 'string' && WORKER_ID.test(args.workerId), 'PROJECT_WORKER_DENIED'); }
  // Omission selects worker-1 only for single-worker projects; never guessed for N>1.
  function workerFor(p, args) {
    const all = workersOf(p.meta);
    if (args.workerId === undefined) { check(all.length === 1, 'PROJECT_WORKER_REQUIRED'); return all[0]; }
    const worker = all.find(w => w.workerId === args.workerId); check(worker, 'PROJECT_WORKER_DENIED'); return worker;
  }
  async function control(p, action) {
    ready(p); check(!p.control, 'PROJECT_CONTROL_BUSY'); p.control = true;
    try { return await action(); } finally { p.control = false; }
  }
  function jobStatus(p, worker, status, runId) {
    check(status?.mode === 'project-worker' && status.projectId === p.meta.projectId && status.workerId === worker.workerId && status.runId === runId,
      'PROJECT_WORKER_MISMATCH'); return copy(status);
  }
  async function refreshWorker(p, worker, stop = false, { force = worker.stopForce === true, guard } = {}) {
    if (['pending', 'unknown'].includes(worker.start.state) && !worker.start.runId) return null;
    if (!worker.lastRun) return null;
    const runId = worker.lastRun;
    const status = jobStatus(p, worker, await bounded(stop ? research.stopProjectWorker(p.meta.projectId, runId, { force }) : research.projectWorkerStatus(p.meta.projectId, runId)), runId);
    guard?.(); worker.status = status;
    if (!jobUnsettled(status)) worker.start.state = 'settled';
    await save(p); return status;
  }
  function taskReceipt(p, task) {
    check(task?.pluginId === APP && task.scope === 'session' && task.delivery === 'next-step' && task.metadata?.projectId === p.meta.projectId
      && typeof task.taskId === 'string' && TASK_ID.test(task.taskId) && (!p.meta.taskId || task.taskId === p.meta.taskId)
      && task.parentSessionId === p.meta.creator?.sessionId && task.parentSessionPath === p.meta.creator?.sessionPath, 'PROJECT_TASK_UNCONFIRMED');
    return task;
  }
  async function settle(p, success) {
    closeSetupAbort(p); // Settlement takes ownership before awaiting a Host receipt.
    if (!p.meta.taskId || !p.meta.creator) return;
    let setupCompleted = false;
    try {
      const current = taskReceipt(p, await bounded(sdk.tasks.get(p.meta.taskId)));
      const expected = success ? 'completed' : 'failed';
      const receipt = ['completed', 'failed', 'canceled', 'aborted'].includes(current.status) ? current
        : taskReceipt(p, await bounded(sdk.tasks[success ? 'complete' : 'fail'](p.meta.taskId,
          success ? { projectId: p.meta.projectId, mainIdentityReady: p.meta.main?.identityConfirmed === true, startup: p.meta.startup.state, theoremEstablished: false }
            : `Project setup failed: ${typeof p.meta.error === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(p.meta.error) ? p.meta.error : 'PROJECT_SETUP_FAILED'}.`)));
      check(receipt.status === expected || ['canceled', 'aborted'].includes(receipt.status), 'PROJECT_TASK_UNCONFIRMED');
      p.meta.taskSettlement = 'confirmed';
      setupCompleted = success && receipt.status === 'completed';
    } catch (error) { p.meta.taskSettlement = 'unknown'; p.meta.taskError = code(error); }
    await save(p);
    return setupCompleted;
  }
  async function setup(p) {
    try {
      live(p); check(p.meta.state === 'queued', 'PROJECT_SETUP_INTERRUPTED'); p.setupPermit = true;
      const root = taskReceipt(p, await bounded(sdk.tasks.get(p.meta.taskId)));
      check(['pending', 'running'].includes(root.status), 'PROJECT_TASK_INACTIVE');
      await withSetupPermit(p, () => { p.meta.state = 'preparing'; return save(p); });
      const input = await store.readJson(location(p, 'input.json'));
      const prepared = await withSetupPermit(p, () => bounded(contexts.prepare({ projectId: p.meta.projectId, problem: input.problem,
        operatorProfile: input.operatorProfile ?? 'Hana Math project.', workerTask: 'Await assignment by the saved project main.' })));
      check(prepared?.projectId === p.meta.projectId && prepared.state === 'ready' && prepared.reused !== true, 'PROJECT_NOT_FRESH');
      const main = await withSetupPermit(p, () => bounded(contexts.prepareProjectWorkspace({ projectId: p.meta.projectId, role: 'main' })));
      for (const worker of workersOf(p.meta)) await withSetupPermit(p, () => bounded(contexts.prepareProjectWorkspace({ projectId: p.meta.projectId, role: 'worker', workerId: worker.workerId })));
      const cwd = store.absolute(`context/projects/${p.meta.projectId}/main`), kind = `math-project:${p.meta.projectId}:main`;
      check(main?.state === 'ready' && main.cwd === cwd && main.scope === 'project-main' && main.localMemory === null, 'PROJECT_WORKSPACE_MISMATCH');
      // The main helper awaits readback between checkpoints. Fence its Host
      // mutations at dispatch too; an already returned locator stays recorded.
      const sessionMutation = name => (...args) => withSetupPermit(p, () => sdk.sessions[name](...args));
      const setupSdk = { ...sdk, sessions: { ...sdk.sessions, create: sessionMutation('create'), setActiveTools: sessionMutation('setActiveTools') } };
      const createMain = () => createMainSession(setupSdk, { profiles, cwd, kind, includeGoalTools: true, onState: async state => {
        p.meta.main = copy(state); await save(p);
        await withSetupPermit(p);
      } });
      const binding = await withSetupPermit(p, () => bounded(track(p, createMain())));
      check(binding?.state === 'ready' && binding.identityConfirmed === true && binding.cwd === cwd && binding.kind === kind
        && binding.namespace === 'home' && binding.visibility === 'public' && binding.ownerPluginId === APP && typeof binding.sessionId === 'string', 'PROJECT_MAIN_UNCONFIRMED');
      await withSetupPermit(p, () => { p.meta.main = copy(binding); p.meta.state = 'ready'; return save(p); });
      await withSetupPermit(p, () => { p.meta.startup = { state: 'pending' }; return save(p); });
      const workerIds = workersOf(p.meta).map(w => w.workerId);
      const sending = track(p, withSetupPermit(p, () => {
        closeSetupAbort(p); // Startup is being dispatched and cannot be unsent.
        return sdk.sessions.send({ sessionId: binding.sessionId, text: [
          `Hana Math project ${p.meta.projectId}; ${workerIds.length === 1 ? `logical worker ${WORKER}` : `logical workers ${workerIds.join(', ')}`}. Read PROBLEM.md, OPERATOR.md, PATHS.json and CONTEXT.md.`,
          'Use these Hana tool mappings, not CLI execution: danus assign -> math_assign for the current logical worker; danus start/status/stop -> math_project with the corresponding action; full canonical fact reads -> math_project result with factId.',
          'Query math_project worker_models with projectId and optional offset/limit for the current model directory, supported thinking levels and persistent permission status. Assign a logical worker optional model {provider,id} and thinkingLevel via math_assign; each assignment replaces all pending choices. math_project start overrides supplied fields and inherits the others. Omit choices for saved-role/model defaults; no role preset is changed.',
          WORKER_DISPLAY_TITLE_GUIDANCE,
          FACT_PAGE_GUIDANCE,
          'The five main Core tools remain gm_add, gm_search, fact_search, fact_revoke and search_arxiv_theorems. clock.curr_time -> current_status with key="time".',
          NATIVE_LITERATURE_GUIDANCE,
          nativeExplorationGuidance(binding.toolSelection, binding.explorer),
          'create_goal and clock.sleep have no direct entry here. Use the authorized App Goal adapter instead: math_goal start requires projectId and authorized:true from the creator after explicit operator authorization for long-term research. Only the creator may resume with projectId. Status uses projectId.',
          'Read math_goal_main status for goalId, generation and due.control.at/due.audit.at. As the bound main, acknowledge with projectId, goalId, generation and the exact controlAt and/or auditAt after substantive work; accepted delivery is not acknowledgement.',
          'While the Goal is active, keep reasoning, dispatching and synthesizing under the saved main contract. Perform the 30-minute control beat and four-hour macro audit; read canonical facts/global memory and write master_guidance. Busy delivery does not prove idle or instant preemption.',
          'When no immediate work remains, call math_goal_main wait with projectId, goalId and generation. When useful work resumes in an active Goal, call continue_work with those same identity fields; it does not resume a paused Goal.',
          'math_goal_main pause with projectId stops automatic main inputs, not existing workers. stop with projectId and optional force requests worker stopping too. complete requires projectId, goalId, generation and nonempty canonical factIds after you judge the whole dependency route closed; it requests worker stopping, not operator finalize.',
          'Only the operator starts /loop; loop_control only manages an already active loop. Do not assume automatic timed control beats before explicit Goal activation. ' + (workerIds.length === 1
            ? 'This session has only one logical worker, worker-1.'
            : `This session has ${workerIds.length} logical workers: ${workerIds.join(', ')}. Each has its own TASK and local memory; all share global memory and the fact graph. math_assign and math_project start require workerId; math_project stop without workerId stops all workers. All workers and main share one project lock: avoid back-to-back reads with no pause.`),
          workerPolicyPrompt(p.meta),
          'Within a mathematical round, the same worker session receives verifier feedback and may continue; only one candidate may be pending at a time. The authorized main may repeatedly assign and start jobs without per-job approval.',
        ].join('\n') });
      }));
      const sent = await bounded(sending);
      check(sent?.accepted === true && sent.ok !== false && !sent.error && sent.sessionPath === binding.sessionPath
        && (!sent.sessionId || sent.sessionId === binding.sessionId)
        && (!sent.sessionRef || sent.sessionRef.sessionId === binding.sessionId && sent.sessionRef.sessionPath === binding.sessionPath), 'PROJECT_STARTUP_UNCONFIRMED');
      p.meta.startup = { state: 'accepted' }; await save(p);
      if (await settle(p, true)) {
        const proof = dashboardSetupProofs.get(p), creator = p.meta.creator;
        if (p.setupPermit && proof?.creator === creator && proof.sessionId === creator.sessionId
          && proof.sessionPath === creator.sessionPath && proof.taskId === p.meta.taskId) grantWorkspaceDashboard(p);
      }
    } catch (error) {
      closeSetupAbort(p);
      p.setupPermit = false;
      if (error?.state?.role === 'main') p.meta.main = copy(error.state);
      if (p.meta.startup.state === 'pending') p.meta.startup = { state: 'unknown', error: code(error) };
      if (p.meta.state !== 'ready') p.meta.state = 'unconfirmed';
      if (p.meta.error !== 'PROJECT_SETUP_CANCELLED') p.meta.error = code(error);
      await save(p).catch(() => {}); await settle(p, false).catch(() => {});
    } finally { closeSetupAbort(p); p.setupPermit = false; dashboardSetupProofs.delete(p); }
  }
  async function create(input, ctx) {
    fields(input, ['problem', 'operatorProfile', 'workerPolicy', 'workers'], ['problem']); text(input.problem); if (input.operatorProfile !== undefined) text(input.operatorProfile);
    const workers = Object.hasOwn(input, 'workers') ? input.workers : 1;
    check(Number.isInteger(workers) && workers >= 1 && workers <= MAX_WORKERS, 'PROJECT_INVALID_INPUT');
    // New projects always use Danus research rounds; omission means the Danus defaults. Projects persisted
    // without workerPolicy keep their recorded legacy bridge and are never upgraded.
    const workerPolicy = normalizeResearchWorkerPolicy(Object.hasOwn(input, 'workerPolicy') ? input.workerPolicy : {});
    invocation(ctx); openForBusiness();
    const ownBefore = await ownSessions();
    check(!ownBefore.some(row => row.path === ctx.sessionPath), 'PROJECT_CREATOR_DENIED');
    const projectId = `project-${randomUUID()}`;
    const blank = workerId => ({ workerId, assignment: { state: 'unassigned' }, start: { state: 'idle' }, lastRun: null, runs: [], status: null });
    const p = wrap({ schemaVersion: 1, projectId, revision: 0, state: 'queued', creator: null, taskId: null, taskCreation: 'not-attempted',
      taskSettlement: 'pending', main: null, startup: { state: 'not-sent' }, error: null, workerPolicy,
      assignmentHistory: { available: true, coverage: 'complete', total: 0, omitted: 0, assignments: [] },
      worker: blank(WORKER), ...(workers > 1 ? { extraWorkers: Array.from({ length: workers - 1 }, (_, i) => blank(`worker-${i + 2}`)) } : {}) });
    projects.set(projectId, p);
    try {
      await store.mkdir(`${BASE}/${projectId}`, true); // exclusive creation, not a lookup of an older project
      freshProjects.add(p);
      await store.write(location(p, 'input.json'), json(input)); await save(p);
      p.meta.taskCreation = 'pending'; await save(p);
      const creating = track(p, Promise.resolve().then(() => {
        live(p); return sdk.tasks.create({ scope: 'session', callToken: ctx.callToken, delivery: 'next-step', handlerKey: HANDLER,
          label: 'Math project setup', metadata: { projectId } });
      }).then(async task => {
        check(task?.pluginId === APP && task.scope === 'session' && task.delivery === 'next-step' && task.metadata?.projectId === projectId
          && typeof task.taskId === 'string' && TASK_ID.test(task.taskId) && typeof task.parentSessionId === 'string' && task.parentSessionId
          && task.parentSessionPath === ctx.sessionPath, 'PROJECT_CREATOR_UNCONFIRMED');
        p.meta.creator = { sessionId: task.parentSessionId, sessionPath: task.parentSessionPath };
        p.meta.taskId = task.taskId; p.meta.taskCreation = 'confirmed';
        if (!closing && p.meta.state === 'queued') setupAbortOwners.set(task.taskId, { project: p, checking: null });
        await save(p);
        const ownAfter = await ownSessions();
        if ([...ownBefore, ...ownAfter].some(row => row.path === ctx.sessionPath || row.sessionId === task.parentSessionId)) {
          p.meta.creatorRejected = true; await save(p); throw failure('PROJECT_CREATOR_DENIED');
        }
        if (closing || p.meta.state !== 'queued') await settle(p, false);
        return task;
      }));
      const creatorReceipt = await bounded(creating); live(p); check(p.meta.state === 'queued', 'PROJECT_SETUP_INTERRUPTED');
      // The existing Host receipt plus the own-session exclusion above are
      // the only source of a fresh setup grant. Store no token or invocation.
      if (!p.meta.creatorRejected) dashboardSetupProofs.set(p, Object.freeze({ creator: p.meta.creator,
        sessionId: creatorReceipt.parentSessionId, sessionPath: creatorReceipt.parentSessionPath, taskId: creatorReceipt.taskId }));
      if (input.operatorProfile === undefined) await orderedOperator(async () => {
        // The existing setup task has verified the creator. Freeze the shared
        // profile in input.json before any setup handler can start.
        const profile = renderOperatorProfile(await readOperatorAnswers());
        live(p); check(p.meta.state === 'queued', 'PROJECT_SETUP_INTERRUPTED');
        if (profile !== null) await store.write(location(p, 'input.json'), json({ ...input, operatorProfile: profile }), true);
      });
      live(p); check(p.meta.state === 'queued', 'PROJECT_SETUP_INTERRUPTED');
      p.nonce = randomBytes(24).toString('hex');
      const scheduling = track(p, Promise.resolve().then(() => {
        live(p); check(p.meta.state === 'queued' && p.nonce, 'PROJECT_SETUP_INTERRUPTED'); return sdk.tasks.schedule({ scope: 'app', handlerKey: HANDLER, runAt: Date.now(), label: 'Math project setup once', payload: { projectId, nonce: p.nonce } });
      }).then(async schedule => {
        check(schedule?.pluginId === APP && schedule.scope === 'app' && schedule.handlerKey === HANDLER && typeof schedule.scheduleId === 'string' && schedule.scheduleId.length > 0, 'PROJECT_SCHEDULE_UNCONFIRMED');
        // A handler may already have removed it before schedule() acknowledged.
        if (!p.scheduleCleanups.get(schedule.scheduleId)?.removed) { p.meta.scheduleId = schedule.scheduleId; await save(p); }
        if (closing || p.setup || p.meta.state !== 'queued') await bounded(unschedule(p, schedule.scheduleId));
        return schedule;
      }));
      await bounded(scheduling); live(p); return { state: 'queued', projectId, taskId: p.meta.taskId };
    } catch (error) {
      p.nonce = null; p.meta.error ||= code(error);
      dashboardSetupProofs.delete(p);
      workspaceDashboardGrants.delete(p);
      // Once dispatched, setup owns business state and root-task settlement.
      // A late scheduling/cleanup error remains visible but cannot undo delivery.
      if (!p.setup) { closeSetupAbort(p); p.meta.state = 'unconfirmed'; }
      await save(p).catch(() => {});
      if (!p.setup) await settle(p, false).catch(() => {});
      throw Object.assign(error, { projectId, taskId: p.meta.taskId });
    }
  }
  const waitingForPublication = new WeakSet(), workerStopVersion = new WeakMap();
  function priorPublication(p, worker, ctx, assertAdmission) {
    const prior = publisher?.waitForProject(p.meta.projectId);
    if (!prior) return null;
    // Wait only for this Project's existing background read. Never wait out an
    // unrelated Core operation, blocked persistence, or historic unsettled record.
    const active = p.coreBusy && dashboardViewAdmissions.get(p.coreSlot?.creatorAdmission)?.publication === true
      ? p.core?.snapshot().current : null;
    if (!active || p.coreBlocked || [...p.records.values()].some(record => record.operationId !== active.operationId && coreUnsettled(record))) coreGate(p);
    const stopVersion = workerStopVersion.get(worker);
    let waiting = true;
    const recheck = () => {
      check(waiting, 'PROJECT_CONTROL_TIMEOUT');
      assertAdmission(); ready(p);
      check(workerStopVersion.get(worker) === stopVersion, 'PROJECT_WORKER_UNSETTLED');
    };
    waitingForPublication.add(p); // Existing captures can finish, new ones cannot join this wait.
    return bounded(prior.then(async () => {
      recheck(); await authorize(p, ctx, true, recheck, { readOnly: true }); recheck();
    })).finally(() => { waiting = false; waitingForPublication.delete(p); });
  }
  function historicalRunRefs(p) {
    return workersOf(p.meta).flatMap(w => w.runs.map(runId => ({workerId:w.workerId, runId})));
  }
  async function prepareWorkerAdmission(p, guard) {
    if (!deferHistoricalWork) return;
    const fresh = freshProjects.has(p);
    const checkScope = () => { live(p); guard(); check(projects.get(p.meta.projectId) === p, 'PROJECT_HISTORY_UNCONFIRMED'); return true; };
    checkScope();
    await research.confirmProjectAdmission(p.meta.projectId, historicalRunRefs(p), checkScope, {fresh});
    checkScope();
  }
  async function assign(args, ctx) {
    fields(args, ['task', 'workerId', 'model', 'thinkingLevel', 'displayTitle'], ['task']); text(args.task); workerOf(args);
    const hasDisplayTitle = Object.hasOwn(args, 'displayTitle');
    check(!hasDisplayTitle || typeof args.displayTitle === 'string', 'PROJECT_INVALID_INPUT');
    const displayTitle = hasDisplayTitle ? workerDisplayTitle(args.displayTitle) : undefined;
    const p = await boundMain(ctx); live(p); const worker = workerFor(p, args), workerId = worker.workerId, multi = workersOf(p.meta).length > 1;
    if (deferHistoricalWork) { await goals.prepareProject(p.meta.projectId); live(p); }
    const ticket = goals.admit(p.meta.projectId);
    let admissionError;
    const assertAdmission = () => { try { return goals.assertAdmission(ticket); } catch (error) { admissionError = error; throw error; } };
    return control(p, async () => {
      assertAdmission();
      const publication = priorPublication(p, worker, ctx, assertAdmission);
      if (publication) await publication;
      assertAdmission(); coreGate(p);
      await prepareWorkerAdmission(p, assertAdmission); assertAdmission(); coreGate(p);
      const requested = Object.fromEntries(['model', 'thinkingLevel'].filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]));
      const explicit = Object.keys(requested).length > 0;
      let dispatch;
      if (explicit) {
        check(typeof research.validateWorkerDispatch === 'function', 'DEPENDENCY_MISSING');
        dispatch = await research.validateWorkerDispatch(requested); assertAdmission();
      }
      const content = args.task.endsWith('\n') ? args.task : args.task + '\n';
      const sha256 = createHash('sha256').update(content).digest('hex');
      const projectedHistory = assignmentProjection(p.meta.assignmentHistory);
      check(p.meta.assignmentHistory === undefined || projectedHistory.available && projectedHistory.total < Number.MAX_SAFE_INTEGER, 'PROJECT_ASSIGNMENT_HISTORY_INVALID');
      const priorAssignment = copy(worker.assignment);
      worker.assignment = { state: 'pending', sha256 }; await save(p);
      const priorHistory = p.meta.assignmentHistory;
      try {
        live(p); assertAdmission();
        const receipt = await bounded(track(p, contexts.assignWorkerTask({ projectId: p.meta.projectId, workerId, task: args.task }, { assertAdmission })));
        check(receipt?.state === 'ready' && receipt.projectId === p.meta.projectId && receipt.workerId === workerId && receipt.sha256 === sha256
          && receipt.taskFile === `context/projects/${p.meta.projectId}/workers/${workerId}/TASK.md`, 'PROJECT_ASSIGNMENT_UNCONFIRMED');
        worker.assignment = { state: 'assigned', sha256, taskFile: receipt.taskFile, ...(explicit ? { dispatch: copy(dispatch) } : {}),
          ...(displayTitle !== undefined ? { displayTitle } : {}) };
        const history = copy(priorHistory ? projectedHistory : { available: true, coverage: 'since-instrumentation', total: 0, omitted: 0, assignments: [] });
        history.total++; history.assignments.push({ sha256, at: Date.now(), lastRun: worker.lastRun, ...(multi ? { workerId } : {}), ...(explicit ? { dispatch: copy(dispatch) } : {}) });
        if (history.assignments.length > 128) history.assignments.splice(0, history.assignments.length - 128);
        history.omitted = history.total - history.assignments.length; p.meta.assignmentHistory = history;
        await save(p);
        return { assigned: true, projectId: p.meta.projectId, workerId, sha256, dispatch: explicit ? copy(dispatch) : null,
          lastKnownRun: worker.lastRun ? { runId: worker.lastRun, observed: 'project-status-cache', selection: copy(worker.status?.selections?.worker ?? null) } : null };
      } catch (error) {
        if (priorHistory) p.meta.assignmentHistory = priorHistory; else delete p.meta.assignmentHistory;
        if (error === admissionError) worker.assignment = priorAssignment;
        else { worker.assignment.state = 'unknown'; worker.assignment.error = code(error); delete worker.assignment.displayTitle; }
        await save(p).catch(() => {}); throw error;
      }
    });
  }
  async function start(args, ctx) {
    fields(args, ['projectId', 'workerId', 'timeoutSeconds', 'model', 'thinkingLevel'], ['projectId']); workerOf(args);
    if (args.timeoutSeconds !== undefined) check(Number.isInteger(args.timeoutSeconds) && args.timeoutSeconds >= 60 && args.timeoutSeconds <= 900, 'INVALID_TIMEOUT');
    const p = get(args.projectId); await authorize(p, ctx, true); live(p); const worker = workerFor(p, args);
    if (deferHistoricalWork) { await goals.prepareProject(p.meta.projectId); live(p); }
    const ticket = goals.admit(p.meta.projectId); let admissionError;
    const assertAdmission = () => { try { return goals.assertAdmission(ticket); } catch (error) { admissionError = error; throw error; } };
    return control(p, async () => {
      assertAdmission();
      const publication = priorPublication(p, worker, ctx, assertAdmission);
      if (publication) await publication;
      assertAdmission(); coreGate(p); check(worker.assignment.state === 'assigned', 'PROJECT_TASK_UNASSIGNED');
      await prepareWorkerAdmission(p, assertAdmission); assertAdmission(); coreGate(p);
      const displayTitle = workerDisplayTitle(worker.assignment.displayTitle);
      const previous = await refreshWorker(p, worker); assertAdmission();
      check(!['pending', 'unknown'].includes(worker.start.state) && (!previous || !jobUnsettled(previous)), 'PROJECT_WORKER_UNSETTLED');
      const requested = { ...(worker.assignment.dispatch ?? {}), ...Object.fromEntries(['model', 'thinkingLevel'].filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]])) };
      let dispatch = {};
      if (Object.keys(requested).length) {
        check(typeof research.validateWorkerDispatch === 'function', 'DEPENDENCY_MISSING');
        dispatch = await research.validateWorkerDispatch(requested); assertAdmission();
      }
      const priorStart = copy(worker.start), priorStopRequested = worker.stopRequested, priorStopForce = worker.stopForce;
      const workerPolicy = projectWorkerPolicy(p.meta);
      let backendRejection;
      worker.stopRequested = false; worker.stopForce = false; worker.start = { state: 'pending', runId: null }; await save(p);
      try {
        live(p);
        const job = track(p, Promise.resolve().then(async () => {
          live(p);
          try { assertAdmission(); return await research.startWorkerRun({ projectId: p.meta.projectId, workerId: worker.workerId, ...dispatch, ...(workerPolicy ? { workerPolicy } : {}), ...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }) }, ctx,
            { assertAdmission, ...(displayTitle !== undefined ? { displayTitle } : {}) }); }
          catch (error) { backendRejection = error; throw error; }
        }).then(async result => {
          contextId(result?.runId); jobStatus(p, worker, result, result.runId);
          workerRunsStartedHere.set(worker, result.runId);
          worker.lastRun = result.runId; if (!worker.runs.includes(result.runId)) worker.runs.push(result.runId);
          worker.start.runId = result.runId; worker.status = copy(result); await save(p);
          if (closing || worker.stopRequested) return await refreshWorker(p, worker, true, closing ? { force: true } : undefined);
          return result;
        }));
        const result = await bounded(job); worker.start = { state: jobUnsettled(result) ? 'started' : 'settled', runId: result.runId }; await save(p);
        if (!closing && worker.start.runId === result.runId && admissionCanFollow(p, worker, result.runId)) {
          const goal = goals.monitorLifecycle(p.meta.projectId);
          if (goal === null) monitorWorkerStarts.set(worker, { runId: result.runId, order: nextMonitorActivation() });
          // A main/worker admission can activate existing explicit consent; it cannot create consent.
          // In particular a project row from a previous version is not a grant.
          if ((goal === null || goal?.state === 'active') && getFollowState(p) === 'enabled' && !lookupWorkspaceGrant(p)) {
            await renewFollowAfterStart(p, worker, result.runId, goal?.activation?.order ?? null);
          }
          if (goal === null) publisher?.notify(p.meta.projectId); // A very short run can settle before admission returns.
        }
        return copy(result);
      } catch (error) {
        if (error && typeof error === 'object' && !('runId' in error)
          && (error === admissionError || error === backendRejection && (START_REJECTIONS.has(error.code) || research.isWorkerAdmissionRejection?.(error) === true))) {
          worker.start = { ...priorStart, error: code(error) };
          worker.stopRequested = worker.stopRequested || priorStopRequested || false;
          worker.stopForce = worker.stopForce || priorStopForce || false;
          await save(p);
          if (worker.lastRun && (closing || worker.stopRequested)) await refreshWorker(p, worker, true, closing ? { force: true } : undefined).catch(() => {});
          throw error;
        }
        if (typeof error.runId === 'string') { contextId(error.runId); worker.lastRun = error.runId; worker.start.runId = error.runId; if (!worker.runs.includes(error.runId)) worker.runs.push(error.runId); }
        worker.start.state = 'unknown'; worker.start.error = code(error); await save(p).catch(() => {});
        if (worker.start.runId && (closing || worker.stopRequested)) await refreshWorker(p, worker, true, closing ? { force: true } : undefined).catch(() => {});
        throw error;
      }
    });
  }
  async function verificationReads(args, ctx) {
    fields(args, ['projectId', 'runId', 'submissionId']);
    const ids = Object.fromEntries(['projectId', 'runId', 'submissionId'].map(key => [key, contextId(args[key])]));
    const p = get(ids.projectId), budget = verificationReadBudget();
    const guard = () => { budget.guard(); openForBusiness(); check(get(ids.projectId) === p, 'PROJECT_NOT_FOUND'); };
    await budget.step(() => authorize(p, ctx, false, guard, { readOnly: true }));
    let workerId;
    const membership = () => {
      guard(); const all = workersOf(p.meta);
      const owners = all.filter(w => w && Array.isArray(w.runs)).flatMap(w => w.runs.filter(id => id === ids.runId).map(() => w.workerId));
      check(all.every(w => object(w) && WORKER_ID.test(w.workerId)) && owners.length === 1 && (workerId === undefined || workerId === owners[0]), 'PROJECT_WORKER_MISMATCH');
      workerId = owners[0];
    };
    membership();
    check(typeof research.projectVerificationReads === 'function', 'PROJECT_READ_AUDIT_UNAVAILABLE');
    const recheck = async () => {
      membership(); await authorize(p, ctx, false, membership, { readOnly: true }); membership();
    };
    // No status/refresh/result/Core/Goal or locator migration on this read-only route.
    return research.projectVerificationReads({ ...ids, workerId }, { recheck, budget });
  }
  async function recheck(args, ctx) {
    fields(args, ['projectId', 'workerId', 'runId']);
    check([Object.prototype, null].includes(Object.getPrototypeOf(args)) && Reflect.ownKeys(args).length === 3
      && ['projectId', 'workerId', 'runId'].every(key => Object.getOwnPropertyDescriptor(args, key)?.enumerable === true
        && Object.hasOwn(Object.getOwnPropertyDescriptor(args, key), 'value')), 'PROJECT_INVALID_INPUT');
    const ids = Object.fromEntries(['projectId', 'workerId', 'runId'].map(key => [key, contextId(args[key])]));
    const p = get(ids.projectId), meta = p.meta, creator = meta.creator;
    const creatorId = creator?.sessionId, creatorPath = creator?.sessionPath, rejected = meta.creatorRejected, callerPath = ctx?.sessionPath;
    let worker, members;
    const guard = () => {
      openForBusiness();
      check(projects.get(ids.projectId) === p && p.meta === meta && meta.projectId === ids.projectId
        && meta.creator === creator && creator?.sessionId === creatorId && creator?.sessionPath === creatorPath
        && meta.creatorRejected === rejected && ctx?.sessionPath === callerPath, 'PROJECT_RECHECK_CHANGED');
      if (!worker) return;
      const all = workersOf(meta), owners = all.flatMap(w => Array.isArray(w?.runs) ? w.runs.filter(id => id === ids.runId).map(() => w) : []);
      check((!Object.hasOwn(meta, 'extraWorkers') || Array.isArray(meta.extraWorkers)) && all.length === members.length && all.every((w, i) => w === members[i])
        && all.every(w => workerRecordValid(w, w?.workerId) && WORKER_ID.test(w.workerId)
          && w.runs.every(id => typeof id === 'string' && /^run-[a-z0-9][a-z0-9-]{0,59}$/.test(id)))
        && new Set(all.map(w => w.workerId)).size === all.length && all.filter(w => w === worker).length === 1
        && worker.workerId === ids.workerId && owners.length === 1 && owners[0] === worker, 'PROJECT_WORKER_MISMATCH');
    };
    // Authorization precedes any run/membership lookup. readOnly prevents locator
    // migration only: this creator-only action can mutate Host cleanup resources.
    const actor = await authorize(p, ctx, false, guard, { readOnly: true });
    check(actor === 'creator', 'PROJECT_OWNER_DENIED'); guard();
    members = workersOf(meta); worker = members.find(w => w?.workerId === ids.workerId);
    check(worker, 'PROJECT_WORKER_MISMATCH'); guard();
    check(typeof research.projectWorkerRecheck === 'function', 'PROJECT_RECHECK_UNAVAILABLE');
    return research.projectWorkerRecheck(ids, { guard });
  }
  async function ipcUsage(args, ctx) {
    fields(args, ['projectId']);
    const field = Object.getOwnPropertyDescriptor(args, 'projectId');
    check(Reflect.ownKeys(args).length === 1 && field?.enumerable && Object.hasOwn(field, 'value'), 'PROJECT_INVALID_INPUT');
    const p = get(contextId(field.value)), dataRoot = sdk.dataDir, budget = verificationReadBudget();
    const stable = paperCreatorGuard(p, ctx, 'PROJECT_IPC_USAGE_CHANGED');
    const guard = () => { budget.guard(); stable(); check(sdk.dataDir === dataRoot, 'PROJECT_IPC_USAGE_CHANGED'); };
    const recheck = () => budget.step(async () => {
      guard(); check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_OWNER_DENIED'); guard();
    });
    await recheck();
    let usage;
    try { usage = await budget.step(() => readManagedIpcUsage(dataRoot, guard)); }
    catch { guard(); await recheck(); throw failure('PROJECT_IPC_USAGE_UNAVAILABLE'); }
    await recheck(); guard();
    return usage;
  }
  async function status(projectId, ctx) {
    const p = get(projectId);
    if (disposeComplete) {
      // Preserve the closed service's authorized cleanup observation without
      // admitting live work, refreshing runs, or changing ownership records.
      await authorize(p, ctx, false, undefined, { readOnly: true, finalStatus: true });
      return view(p);
    }
    await authorize(p, ctx); openForBusiness();
    for (const worker of workersOf(p.meta)) {
      try { await refreshWorker(p, worker, false, { guard: openForBusiness }); }
      catch (error) { openForBusiness(); worker.statusError = code(error); }
      openForBusiness();
    }
    return view(p);
  }
  // Same all-worker set used by stop/complete; no Host reads or record writes.
  function captureWorkerStopScope({ projectId }) {
    const p = get(projectId), meta = p.meta, workers = workersOf(meta);
    const stamp = () => json({ meta: p.meta, control: p.control, jobs: p.jobs.size, failed: p.persistenceFailed });
    const before = stamp();
    check(!closing && p.meta.projectId === projectId && workers.length >= 1 && workers.length <= MAX_WORKERS
      && (!Object.hasOwn(p.meta, 'extraWorkers') || Array.isArray(p.meta.extraWorkers))
      && workers.every((worker, i) => workerRecordValid(worker, `worker-${i + 1}`)), 'PROJECT_STOP_SCOPE_INVALID');
    const runId = value => typeof value === 'string' && /^run-[a-z0-9][a-z0-9-]{0,59}$/.test(value);
    const allRuns = workers.flatMap(worker => worker.runs);
    const refsKnown = allRuns.every(runId) && new Set(allRuns).size === allRuns.length;
    const projectKnown = meta.state === 'ready' && meta.main?.state === 'ready' && meta.main.identityConfirmed === true;
    const targets = workers.map(worker => {
      const lastRun = runId(worker.lastRun) ? worker.lastRun : null, start = worker.start;
      const references = worker.lastRun === null ? worker.runs.length === 0 && start.state === 'idle' && (start.runId === null || !Object.hasOwn(start, 'runId'))
        : lastRun !== null && worker.runs.includes(lastRun) && start.runId === lastRun && ['started', 'settled'].includes(start.state);
      return { workerId: worker.workerId, runId: lastRun,
        // Shared jobs also include unrelated Core reads, not just worker starts.
        complete: projectKnown && refsKnown && references && !p.persistenceFailed && !p.control
          && ['unassigned', 'assigned'].includes(worker.assignment.state) };
    });
    check(get(projectId) === p && meta === p.meta && before === stamp(), 'PROJECT_STOP_SCOPE_CHANGED');
    return { targets };
  }
  function observeWorkerStopScope({ projectId, main, scope, disposeCheck = false }) {
    const p = get(projectId), meta = p.meta, binding = meta.main;
    const stamp = () => json({ meta: p.meta, control: p.control, jobs: p.jobs.size, failed: p.persistenceFailed });
    const before = stamp();
    const guard = () => check((!closing || disposeScopeObservation && disposeCheck === true) && !p.persistenceFailed && get(projectId) === p && p.meta === meta && meta.projectId === projectId
      && meta.main === binding && ['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind'].every(key => binding?.[key] === main?.[key])
      && before === stamp(), 'WORKER_STOP_PROJECT_CHANGED');
    guard();
    const workers = workersOf(meta), runId = value => typeof value === 'string' && /^run-[a-z0-9][a-z0-9-]{0,59}$/.test(value);
    const allRuns = workers.flatMap(worker => Array.isArray(worker?.runs) ? worker.runs : []);
    const refsValid = new Set(allRuns).size === allRuns.length && workers.length >= 1 && workers.length <= MAX_WORKERS && meta.state === 'ready' && binding?.state === 'ready' && binding.identityConfirmed === true
      && (!Object.hasOwn(meta, 'extraWorkers') || Array.isArray(meta.extraWorkers))
      && workers.every((worker, i) => workerRecordValid(worker, `worker-${i + 1}`) && worker.runs.every(runId)
        && new Set(worker.runs).size === worker.runs.length && (worker.lastRun === null || runId(worker.lastRun) && worker.runs.includes(worker.lastRun))
        && ['idle', 'pending', 'unknown', 'started', 'settled'].includes(worker.start.state)
        && (worker.start.runId === null || worker.start.state === 'idle' && !Object.hasOwn(worker.start, 'runId')
          || runId(worker.start.runId) && worker.runs.includes(worker.start.runId))
        && (!['started', 'settled'].includes(worker.start.state) || worker.start.runId !== null && worker.start.runId === worker.lastRun));
    const targets = scope.targets.map(target => {
      const row = (state, reason) => ({ workerId: target.workerId, runId: target.runId, state, reasons: reason ? [reason] : [] });
      if (!refsValid) return row('unknown', 'WORKER_STOP_PROJECT_INVALID');
      if (!target.complete) return row('unknown', 'WORKER_STOP_SCOPE_INCOMPLETE');
      const worker = workers.find(worker => worker.workerId === target.workerId);
      if (!worker) return row('unknown', 'WORKER_STOP_OWNER_MISMATCH');
      if (target.runId === null) return row('settled'); // No run existed at capture; never substitute a later start.
      if (workers.filter(worker => worker.runs.includes(target.runId)).length !== 1 || !worker.runs.includes(target.runId)) return row('unknown', 'WORKER_STOP_OWNER_MISMATCH');
      try {
        const status = research.projectWorkerDiagnostic(projectId, target.runId);
        if (status && typeof status.then === 'function') { Promise.resolve(status).catch(() => {}); return row('unknown', 'WORKER_STOP_DIAGNOSTIC_ASYNC'); }
        guard();
        if (status?.projectId !== projectId || status?.runId !== target.runId || status?.workerId !== target.workerId || status?.mode !== 'project-worker') return row('unknown', 'WORKER_STOP_RUN_INVALID');
        if (worker.start.runId === target.runId && ['pending', 'unknown'].includes(worker.start.state)) return row('unknown', 'WORKER_STOP_START_UNCONFIRMED');
        const state = runSettlementState(status);
        return row(state, state === 'unknown' ? 'WORKER_STOP_RUN_UNKNOWN' : state === 'pending' ? 'WORKER_STOP_RUN_PENDING' : null);
      } catch { return row('unknown', 'WORKER_STOP_DIAGNOSTIC_FAILED'); }
    });
    guard(); return { projectId, targets };
  }
  async function stop(args, ctx) {
    fields(args, ['projectId', 'workerId', 'force'], ['projectId']); workerOf(args);
    check(!Object.hasOwn(args, 'force') || typeof args.force === 'boolean', 'PROJECT_INVALID_INPUT');
    const p = get(args.projectId); await authorize(p, ctx); openForBusiness();
    // Omitted workerId stops every worker (Danus `stop <project>`); Goal stop/complete rely on this.
    const targets = args.workerId === undefined ? workersOf(p.meta) : [workerFor(p, args)];
    for (const worker of targets) {
      workerStopVersion.set(worker, {});
      worker.stopRequested = true;
      worker.stopForce = worker.stopForce === true || args.force === true;
    }
    try { await save(p); } catch (error) { for (const worker of targets) worker.statusError = code(error); }
    for (const worker of targets) { try { await refreshWorker(p, worker, true); } catch (error) { worker.statusError = code(error); } }
    return view(p);
  }
  // A prospective paper start owns its own observation, never an ambient caller or queue pump.
  const paperStartIpcRefusals = new WeakMap(), ipcReadObservers = new WeakMap(), runnerIpcObservers = new WeakMap();
  const dashboardAdmissions = new WeakSet(), dashboardMemoryAdmissions = new WeakSet(), dashboardViewAdmissions = new WeakMap();
  function observePaperStart(start, args, ctx) {
    const observed = new WeakMap();
    const pending = start(args, ctx, observed);
    paperStartIpcRefusals.set(pending, observed);
    return pending;
  }
  function paperStartIpcRefusal(pending, error) { return paperStartIpcRefusals.get(pending)?.get(error) ?? null; }
  // Volatile admission only. No retries, persisted requests or relaxation of Core fences.
  function creatorCoreAdmission(admission, ctx, mainOnly = false, reportAuthority = null) {
    if (!admission) return;
    check(!reportAuthority && !mainOnly && object(admission) && Reflect.ownKeys(admission).length === 2
      && Object.hasOwn(admission, 'requiredActor') && admission.requiredActor === 'creator'
      && Object.hasOwn(admission, 'guard') && typeof admission.guard === 'function', 'PROJECT_CORE_ADMISSION_DENIED');
    invocation(ctx); admission.guard();
  }
  function queueCore(p, operation, args, ctx, mainOnly, reportAuthority = null, creatorAdmission = null, releaseScratch = false) {
    const view = dashboardViewAdmissions.get(creatorAdmission);
    live(p, view?.publication === true);
    if (view) {
      check(ctx === null && !mainOnly && !reportAuthority && !releaseScratch && view.project === p && view.operation === operation,
        'PROJECT_CORE_ADMISSION_DENIED');
      view.guard();
    } else creatorCoreAdmission(creatorAdmission, ctx, mainOnly, reportAuthority);
    check(p.coreWaiting.size < CORE_QUEUE_LIMIT, 'PROJECT_CORE_QUEUE_FULL');
    if (reportAuthority) check(ctx === null && ['fact_get', 'fact_list_page'].includes(operation)
      && typeof reportAuthority.guard === 'function' && typeof reportAuthority.assertActive === 'function', 'PROJECT_REPORT_READ_DENIED');
    const dashboard = dashboardAdmissions.has(creatorAdmission), memory = dashboardMemoryAdmissions.has(creatorAdmission);
    if (!view) {
      check((operation === 'dashboard_factgraph') === dashboard && (operation === 'dashboard_memory') === memory
        && (!(dashboard || memory) || !releaseScratch), 'PROJECT_CORE_ADMISSION_DENIED');
      if (creatorAdmission && !dashboard && !memory) check(['fact_get', 'fact_list_page'].includes(operation), 'PROJECT_CORE_ADMISSION_DENIED');
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const slot = { valid: true, operation, args, ctx, mainOnly, reportAuthority, creatorAdmission, releaseScratch, resolve, reject, timer: null,
      ipcObserver: ipcReadObservers.get(creatorAdmission ?? reportAuthority), expiresAt: Date.now() + CORE_QUEUE_WAIT_MS,
      invalidate(error) {
        if (!slot.valid) return;
        slot.valid = false; clearTimeout(slot.timer); p.coreWaiting.delete(slot);
        const index = p.coreQueue.indexOf(slot); if (index >= 0) p.coreQueue.splice(index, 1);
        reject(error);
      } };
    slot.timer = setTimeout(() => slot.invalidate(failure('PROJECT_CORE_QUEUE_TIMEOUT')), CORE_QUEUE_WAIT_MS);
    p.coreWaiting.add(slot); p.coreQueue.push(slot);
    if (!p.coreDraining) {
      p.corePump = track(p, drainCore(p));
    }
    return promise;
  }
  async function drainCore(p) {
    p.coreDraining = true;
    try {
      while (p.coreQueue.length) {
        const slot = p.coreQueue.shift();
        p.coreSlot = slot;
        try {
          // Keep one tracked pump even if authorization outlives cancellation.
          // Caller timeout is immediate; no second authorization is started behind
          // an unresolved one, and the late return cannot dispatch Core work.
          const view = dashboardViewAdmissions.get(slot.creatorAdmission);
          const assertAdmission = () => {
            check(slot.valid, 'PROJECT_CORE_QUEUE_CANCELLED'); live(p, view?.publication === true);
            slot.reportAuthority?.assertActive();
            if (view) view.guard(); else slot.creatorAdmission?.guard();
            check(Date.now() < slot.expiresAt, 'PROJECT_CORE_QUEUE_TIMEOUT');
          };
          assertAdmission();
          if (view) await view.recheck(assertAdmission);
          else if (slot.reportAuthority) await slot.reportAuthority.guard();
          else if (slot.creatorAdmission) {
            const actor = await authorize(p, slot.ctx, slot.mainOnly, assertAdmission, { readOnly: true });
            check(actor === 'creator', 'PROJECT_OWNER_DENIED');
          } else await authorize(p, slot.ctx, slot.mainOnly, assertAdmission);
          assertAdmission();
          if (!slot.valid) continue;
          if (Date.now() >= slot.expiresAt) { slot.invalidate(failure('PROJECT_CORE_QUEUE_TIMEOUT')); continue; }
          ready(p, view?.publication === true); coreGate(p);
          // No await between final admission checks and CoreAccess.call inside coreCall.
          slot.valid = false; clearTimeout(slot.timer); p.coreWaiting.delete(slot);
          let value;
          try {
            value = await coreCall(p, slot.operation, slot.args, slot.ipcObserver, slot.releaseScratch,
              dashboardAdmissions.has(slot.creatorAdmission), dashboardMemoryAdmissions.has(slot.creatorAdmission), view);
          } catch (error) {
            if (view) {
              // Transport reuse, like the successful path below, conveys no
              // content authority. Never convert failed task accounting to success.
              view.assertProjectOwned();
              if (!p.coreBlocked && !p.persistenceFailed && acceptDashboardViewBusy(p.core, error) && view.workspace) {
                await view.recheck(); view.guard(); throw workspaceProjectBusy;
              }
              if (!p.coreBlocked && !p.persistenceFailed) acceptDashboardViewGraphFallback(p.core, error);
              view.guard();
            }
            throw error;
          }
          if (view) {
            // Accept only the exact validated, durably settled App operation.
            // Rearming transport does not grant the view delivery authority.
            view.assertProjectOwned();
            check(acceptDashboardViewRead(p.core, value), 'PROJECT_DASHBOARD_VIEW_FRAME_UNCONFIRMED');
            await view.recheck(); view.guard();
          } else slot.creatorAdmission?.guard();
          slot.resolve(value);
        } catch (error) {
          if (slot.valid) slot.invalidate(error); else slot.reject(error);
        } finally { p.coreSlot = null; }
      }
    } finally { p.coreDraining = false; }
  }
  async function coreCall(p, operation, args, ipcObserver, releaseScratch, dashboard = false, memory = false, view) {
    ready(p, view?.publication === true); coreGate(p); check(!p.coreBusy, 'PROJECT_CORE_BUSY'); p.coreBusy = true;
    const writesShared = CORE_MUTATIONS.has(operation);
    if (writesShared) workspaceCoreWrites.set(p, { pending:true, endedAt:0 });
    try {
      p.core ||= createProjectCoreAccess(sdk, { projectId: p.meta.projectId, author: p.meta.main.agentId, createCore, onState: record => {
        const writing = p.coreWrites.catch(() => {}).then(async () => {
          contextId(record.operationId);
          check(record.projectId === p.meta.projectId && record.author === p.meta.main.agentId && record.role === 'main'
            && Number.isSafeInteger(record.revision) && record.revision >= 0, 'PROJECT_CORE_RECORD_INVALID');
          const prior = p.records.get(record.operationId);
          const packet = { ...copy(record), mathematicalUnsettled: CORE_MUTATIONS.has(record.operation) && (p.mathematicalFences.has(record.operationId) || prior?.mathematicalUnsettled === true
            || prior?.outcome?.failure?.runtime?.indeterminate === true || record.outcome?.failure?.runtime?.indeterminate === true) };
          if (packet.mathematicalUnsettled) p.mathematicalFences.add(record.operationId);
          check(!prior || record.revision > prior.revision || record.revision === prior.revision && json(packet) === json(prior), 'PROJECT_CORE_REVISION_INVALID');
          await store.write(location(p, `core/${record.operationId}.json`), json(packet), true);
          p.records.set(record.operationId, packet);
        });
        p.coreWrites = writing; writing.catch(() => { p.coreBlocked = true; }); return writing;
      } });
      try { return await (view ? p.core.dashboardViewRead(operation, args, view.guard)
        : dashboard ? p.core.dashboardFactgraph(args) : memory ? p.core.dashboardMemory(args)
        : releaseScratch ? p.core.callReadScratch(operation, args) : p.core.call(operation, args)); }
      catch (error) {
        // Only this slot's direct CoreAccess rejection can confer current evidence.
        // Never adopt an error from queue authorization, a guard, or report/storage handling.
        const reason = ipcObserver && projectCoreManagedIpcRefusal(error);
        if (reason) ipcObserver.set(error, reason);
        throw error;
      }
    } finally {
      if (writesShared) workspaceCoreWrites.set(p, { pending:false, endedAt:Date.now() });
      p.coreBusy = false;
    }
  }
  function validatedRead(p, value, factId, options, releaseScratch) {
    check(object(value) && value.ok !== false && !value.error, 'PROJECT_CORE_INVALID_RESULT');
    const projectId = p.meta.projectId;
    let dto;
    if (factId === undefined) dto = { projectId, ...validateFactPage(value, projectId, options, 'PROJECT_CORE_INVALID_RESULT') };
    else {
      check(isCanonicalFact(value) && value.fact_id === factId && typeof value.markdown === 'string' && value.markdown.length > 0, 'PROJECT_CORE_INVALID_RESULT');
      dto = { projectId, fact: copy(value) };
    }
    // No new await between the original guard, validation, optional release and return.
    if (releaseScratch && !closing && !p.persistenceFailed && !p.coreBlocked && projects.get(projectId) === p) releaseValidatedProjectRead(p.core, value);
    return dto;
  }
  async function result(args, ctx, creatorAdmission = null, releaseScratch = false) {
    fields(args, ['projectId', 'factId', 'cursor', 'limit'], ['projectId']);
    const projectId = contextId(args.projectId), factId = args.factId;
    if (factId !== undefined) check(typeof factId === 'string' && FACT_ID.test(factId), 'PROJECT_INVALID_INPUT');
    const options = factPageOptions(Object.fromEntries(['cursor', 'limit'].filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]])),
      { projectId, factId, code: 'PROJECT_INVALID_INPUT' });
    args = { projectId, factId }; const p = get(projectId);
    const operation = factId === undefined ? 'fact_list_page' : 'fact_get';
    const input = normalizeProjectCoreArguments(operation, factId === undefined ? options : { fact_id: factId });
    if (creatorAdmission) {
      creatorCoreAdmission(creatorAdmission, ctx);
      const actor = await authorize(p, ctx, false, creatorAdmission.guard, { readOnly: true });
      check(actor === 'creator', 'PROJECT_OWNER_DENIED'); creatorAdmission.guard();
    } else await authorize(p, ctx);
    const value = await queueCore(p, operation, input, ctx, false, null, creatorAdmission, releaseScratch);
    creatorAdmission?.guard();
    return validatedRead(p, value, args.factId, options, releaseScratch);
  }
  async function workerModels(args, ctx) {
    fields(args, ['projectId', 'offset', 'limit'], ['projectId']);
    const projectId = contextId(args.projectId);
    if (Object.hasOwn(args, 'offset')) check(Number.isSafeInteger(args.offset) && args.offset >= 0, 'PROJECT_INVALID_INPUT');
    if (Object.hasOwn(args, 'limit')) check(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 64, 'PROJECT_INVALID_INPUT');
    const p = get(projectId), main = p.meta.main;
    const keys = ['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind', 'namespace', 'visibility', 'ownerPluginId', 'state', 'identityConfirmed'];
    const captured = Object.fromEntries(keys.map(key => [key, main?.[key]]));
    const guard = () => {
      live(p); check(get(projectId) === p && p.meta.projectId === projectId, 'PROJECT_NOT_FOUND'); ready(p);
      check(p.meta.main === main && keys.every(key => main?.[key] === captured[key]), 'PROJECT_MAIN_DENIED');
    };
    guard(); await bounded(authorize(p, ctx, true, guard, { readOnly: true })); guard();
    const catalog = await bounded(sdk.models.listAvailable()); guard();
    const saved = await bounded(profiles.getRoleModel('worker')); guard();
    let capabilities = null;
    if (typeof sdk.capabilities?.get === 'function') {
      try { capabilities = await bounded(sdk.capabilities.get({})); } catch { capabilities = null; }
    }
    guard();
    const options = projectWorkerModels(catalog, saved, capabilities);
    await bounded(authorize(p, ctx, true, guard, { readOnly: true })); guard();
    return { projectId, ...workerModelPage(options, args.offset, args.limit) };
  }
  async function doctor(args, ctx) {
    fields(args, ['projectId']); const projectId = contextId(args.projectId); invocation(ctx);
    if (damaged.has(projectId)) return { projectId, state: 'invalid', error: { code: 'PROJECT_RECORD_INVALID' } };
    const p = get(projectId), main = p.meta.main, core = p.core;
    const keys = ['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind', 'namespace', 'visibility', 'ownerPluginId', 'state', 'identityConfirmed'];
    const identity = Object.fromEntries(keys.map(key => [key, main?.[key]]));
    const memory = () => json({ meta: p.meta, records: [...p.records], persistenceFailed: p.persistenceFailed,
      coreBlocked: p.coreBlocked, control: p.control, coreBusy: p.coreBusy, jobs: p.jobs.size,
      coreWaiting: p.coreWaiting.size, coreQueue: p.coreQueue.length, coreDraining: p.coreDraining });
    const before = memory(), writes = [p.writes, p.coreWrites, p.targetWrites];
    const guard = () => {
      openForBusiness(); check(get(projectId) === p && p.meta.main === main && p.core === core
        && keys.every(key => main?.[key] === identity[key]), 'PROJECT_MAIN_DENIED');
      check(memory() === before && writes[0] === p.writes && writes[1] === p.coreWrites && writes[2] === p.targetWrites, 'PROJECT_DOCTOR_CHANGED');
    };
    guard(); await bounded(authorize(p, ctx, true, guard, { readOnly: true })); guard();
    const own = (value, key) => value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
    const flag = value => typeof value === 'boolean' ? value : 'unknown';
    const uint = value => Number.isSafeInteger(value) && value >= 0;
    const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
    const errorCode = value => safeCode(typeof value === 'string' ? value : own(value, 'code'));
    const clear = value => value === 'unknown' ? 'unknown' : !value;
    const all = values => values.includes(false) ? false : values.every(value => value === true) ? true : 'unknown';
    const issues = [], runs = [], owners = new Map();
    let runReferenceState = true;
    const workerCandidates = workersOf(p.meta);
    const workers = workerCandidates.filter(worker => object(worker) && WORKER_ID.test(worker.workerId) && workerRecordValid(worker, worker.workerId));
    const workerRecordsKnown = workers.length > 0 && workers.length === workerCandidates.length
      && (!Object.hasOwn(p.meta, 'extraWorkers') || Array.isArray(p.meta.extraWorkers));
    if (!workerRecordsKnown) runReferenceState = 'unknown';
    const issue = (code, runId, field, workerId) => issues.push({ code, ...(runId ? { runId } : {}), ...(field ? { field } : {}), ...(workerId ? { workerId } : {}) });
    const addRun = (runId, workerId) => {
      if (runId === null || runId === undefined) return;
      if (typeof runId !== 'string' || !/^run-[a-z0-9][a-z0-9-]{0,59}$/.test(runId) || !WORKER_ID.test(workerId)) { runReferenceState = 'unknown'; issue('PROJECT_DOCTOR_RUN_REFERENCE_INVALID', null, 'runs'); return; }
      if (!owners.has(runId)) owners.set(runId, new Set()); owners.get(runId).add(workerId);
    };
    if (!workerRecordsKnown) issue('PROJECT_DOCTOR_PROJECT_UNKNOWN', null, 'workers');
    for (const worker of workers) {
      for (const runId of worker.runs) addRun(runId, worker.workerId);
      addRun(worker.lastRun, worker.workerId); addRun(worker.start.runId, worker.workerId);
    }
    const history = p.meta.assignmentHistory?.assignments;
    if (Array.isArray(history)) for (const assignment of history) addRun(own(assignment, 'lastRun'), own(assignment, 'workerId') ?? WORKER);
    else if (p.meta.assignmentHistory !== undefined) { runReferenceState = 'unknown'; issue('PROJECT_DOCTOR_HISTORY_UNKNOWN', null, 'assignmentHistory'); }
    const runFlags = RUN_RESOURCE_FLAGS;
    for (const [runId, workerIds] of [...owners].sort(([a], [b]) => a.localeCompare(b))) {
      const workerId = workerIds.size === 1 ? [...workerIds][0] : null;
      const row = { runId, workerId, state: 'unknown', error: null,
        ...Object.fromEntries(runFlags.map(key => [key, 'unknown'])), pendingMutationCount: 'unknown', unsettledMutation: 'unknown', recoveryWarnings: [] };
      let status, reason = workerId ? null : 'PROJECT_DOCTOR_RUN_OWNER_AMBIGUOUS';
      if (workerId) try {
        check(typeof research.projectWorkerDiagnostic === 'function', 'PROJECT_DOCTOR_RUN_UNAVAILABLE');
        status = await bounded(research.projectWorkerDiagnostic(projectId, runId));
      }
      catch (error) { reason = ['RUN_NOT_FOUND', 'RUN_INVALID', 'RUN_RECORD_INVALID'].includes(errorCode(error)) ? errorCode(error) : 'PROJECT_DOCTOR_RUN_UNAVAILABLE'; }
      guard();
      const state = own(status, 'state');
      if (!reason && ['missing', 'unknown'].includes(state)) { row.state = state; reason = state === 'missing' ? 'RUN_NOT_FOUND' : 'PROJECT_DOCTOR_RUN_UNKNOWN'; }
      if (!reason && (!['queued', 'running', 'finished', 'failed', 'stopped', 'interrupted'].includes(state)
        || own(status, 'projectId') !== projectId || own(status, 'runId') !== runId || own(status, 'workerId') !== workerId
        || own(status, 'mode') !== 'project-worker')) reason = 'PROJECT_DOCTOR_RUN_STATUS_INVALID';
      if (reason) { runReferenceState = 'unknown'; row.error = { code: reason }; issue(reason, runId); }
      else {
        row.state = state; const failure = errorCode(own(status, 'error')); row.error = failure ? { code: failure } : null;
        for (const key of runFlags) row[key] = flag(own(status, key));
        const count = own(status, 'pendingMutationCount'), pending = own(status, 'pendingMutations');
        row.pendingMutationCount = uint(count) ? count : Array.isArray(pending) ? pending.length : 'unknown';
        row.unsettledMutation = flag(own(status, 'unsettledMutation'));
        if (typeof row.pendingMutationCount === 'number' && row.pendingMutationCount > 0 || own(status, 'candidateSettlement') != null) row.unsettledMutation = true;
        const warnings = own(status, 'recoveryWarnings');
        if (Array.isArray(warnings)) for (const warning of warnings) if (own(warning, 'runId') === runId) {
          row.recoveryWarnings.push({ code: errorCode(own(warning, 'error')) ?? 'RESEARCH_RECOVERY_UNKNOWN' });
        }
        for (const key of [...runFlags, 'unsettledMutation']) if (row[key] !== false) issue(row[key] === true ? 'PROJECT_DOCTOR_UNSETTLED' : 'PROJECT_DOCTOR_UNKNOWN', runId, key);
        if (row.pendingMutationCount !== 0) issue(row.pendingMutationCount === 'unknown' ? 'PROJECT_DOCTOR_UNKNOWN' : 'PROJECT_DOCTOR_UNSETTLED', runId, 'pendingMutationCount');
      }
      runs.push(row);
    }
    let corePending = false;
    try { if (core) corePending = flag(core.snapshot()?.pending); } catch { corePending = 'unknown'; }
    const unsettledOperationCount = [...p.records.values()].filter(coreUnsettled).length;
    const coreClear = all([!p.coreBlocked, unsettledOperationCount === 0, clear(corePending), !p.coreBusy, !p.coreDraining, p.coreQueue.length === 0, p.coreWaiting.size === 0]);
    const coreView = { unsettled: clear(coreClear), operationCount: p.records.size, unsettledOperationCount };
    if (coreClear !== true) issue(coreClear === false ? 'PROJECT_CORE_UNSETTLED' : 'PROJECT_DOCTOR_UNKNOWN', null, 'core');
    const goalMemory = goals.diagnostic(projectId), goalBefore = JSON.stringify(goalMemory);
    const goal = goalMemory === null ? null : { state: goalMemory.state, generation: goalMemory.generation ?? 'unknown',
      waitReason: goalMemory.waitReason ?? null, error: goalMemory.error ?? null, budgetExhausted: flag(goalMemory.budgetExhausted),
      restartAuthorization: ['none', 'preserve-budget'].includes(goalMemory.restartAuthorization) ? goalMemory.restartAuthorization : 'unknown',
      workerStopReconciliation: goalMemory.workerStopReconciliation ?? null };
    const runSettled = row => { const state = runSettlementState(row); return state === 'settled' ? true : state === 'pending' ? false : 'unknown'; };
    const runsSettled = all([runReferenceState, ...runs.map(runSettled)]);
    const workerClear = all([workerRecordsKnown ? true : 'unknown', ...workers.map(worker => {
      const assignment = ['unassigned', 'assigned'].includes(worker.assignment.state) ? true : worker.assignment.state === 'pending' ? false : 'unknown';
      const start = ['idle', 'settled'].includes(worker.start.state) ? true : worker.start.state === 'started'
        ? runSettled(runs.find(row => row.runId === worker.start.runId && row.workerId === worker.workerId))
        : worker.start.state === 'pending' ? false : 'unknown';
      for (const [field, value] of [['assignment', assignment], ['start', start]]) if (value !== true)
        issue(value === false ? 'PROJECT_DOCTOR_WORKER_UNSETTLED' : 'PROJECT_DOCTOR_WORKER_UNKNOWN', null, field, worker.workerId);
      return all([assignment, start]);
    })]);
    const scalar = (value, allowed) => allowed.includes(value) ? value : 'unknown';
    const projectView = {
      taskCreation: scalar(p.meta.taskCreation, ['not-attempted', 'pending', 'confirmed']),
      taskSettlement: scalar(p.meta.taskSettlement, ['pending', 'confirmed']),
      startup: { state: scalar(p.meta.startup?.state, ['not-sent', 'pending', 'accepted', 'rejected']) },
      scheduleCleanup: p.meta.scheduleCleanup == null ? null : {
        state: scalar(p.meta.scheduleCleanup.state, ['pending', 'confirmed', 'failed']), removed: flag(p.meta.scheduleCleanup.removed) },
      schedulePending: p.meta.scheduleId != null, jobsPending: p.jobs.size > 0, controlPending: flag(p.control),
    };
    const settledScalar = (value, expected) => value === 'unknown' ? 'unknown' : value === expected;
    const projectConditions = [
      ['taskCreation', settledScalar(projectView.taskCreation, 'confirmed')],
      ['taskSettlement', settledScalar(projectView.taskSettlement, 'confirmed')],
      ['startup', settledScalar(projectView.startup.state, 'accepted')],
      ['scheduleCleanup', all([!projectView.schedulePending, projectView.scheduleCleanup === null ? true
        : all([settledScalar(projectView.scheduleCleanup.state, 'confirmed'), projectView.scheduleCleanup.removed])])],
    ];
    for (const [field, value] of projectConditions) if (value !== true)
      issue(value === false ? 'PROJECT_DOCTOR_PROJECT_UNSETTLED' : 'PROJECT_DOCTOR_PROJECT_UNKNOWN', null, field);
    const projectClear = all([['ready', 'queued', 'unconfirmed'].includes(p.meta.state) ? p.meta.state === 'ready' : 'unknown',
      clear(flag(p.persistenceFailed)), !projectView.jobsPending, clear(projectView.controlPending), coreClear, ...projectConditions.map(([, value]) => value)]);
    const mutationsClear = all([runReferenceState, ...runs.map(row => all([clear(row.cleanupPending), clear(row.runtimeCleanupPending), clear(row.indeterminate),
      clear(row.unsettledMutation), row.pendingMutationCount === 'unknown' ? 'unknown' : row.pendingMutationCount === 0]))]);
    const readiness = goal?.restartAuthorization !== 'preserve-budget' ? [] : [
      ['restartAuthorization', true, 'persisted'], ['priorActive', goalMemory.priorActive, 'doctor-observed'],
      ['noPendingOrUnknownSend', goalMemory.sendState === 'unknown' ? 'unknown' : ['none', 'accepted', 'rejected'].includes(goalMemory.sendState), 'doctor-observed'],
      ['noPendingCleanupOrIndeterminateMutation', all([!p.persistenceFailed, !p.jobs.size, clear(flag(goalMemory.cleanupPending)), coreClear, mutationsClear]), 'doctor-observed'],
      ['allRunsSettled', runsSettled, 'doctor-observed'], ['mainHostIdentityAndIdleAndTools', 'unknown', 'unknown'],
      ['noWorkersOrCoreUnsettled', all([workerClear, coreClear, runsSettled]), 'doctor-observed'],
      ['explicitDispatchStillAvailable', !workerRecordsKnown || workers.some(worker => Object.hasOwn(worker.assignment, 'dispatch')) ? 'unknown' : true, 'persisted'],
      ['budgetNotExhausted', clear(goal.budgetExhausted), 'persisted'],
    ].map(([condition, value, source]) => ({ condition, value, source: value === 'unknown' ? 'unknown' : source }));
    const projectError = errorCode(p.meta.error);
    const goalSendClear = goalMemory === null ? true : goalMemory.sendState === 'unknown' ? 'unknown'
      : ['none', 'accepted', 'rejected'].includes(goalMemory.sendState);
    const goalClear = goal === null ? true : goal.state === 'invalid' ? false
      : all([clear(flag(goalMemory.cleanupPending)), goalSendClear, goal.restartAuthorization === 'preserve-budget' || goal.state === 'active']);
    for (const item of readiness) if (item.value !== true) issue(item.value === false ? 'PROJECT_DOCTOR_READINESS_BLOCKED' : 'PROJECT_DOCTOR_READINESS_UNKNOWN', null, item.condition);
    if (goalClear === false && goal?.state !== 'invalid') issue('PROJECT_DOCTOR_GOAL_UNSETTLED', null, 'goal');
    if (projectClear !== true) issue(projectClear === false ? 'PROJECT_DOCTOR_PROJECT_UNSETTLED' : 'PROJECT_DOCTOR_PROJECT_UNKNOWN', null, 'project');
    if (goal?.state === 'invalid') issue('MAIN_CONTROL_RECORD_INVALID', null, 'goal');
    const blockingIssues = new Set(['PROJECT_DOCTOR_UNSETTLED', 'PROJECT_CORE_UNSETTLED', 'PROJECT_DOCTOR_READINESS_BLOCKED',
      'MAIN_CONTROL_RECORD_INVALID', 'PROJECT_DOCTOR_PROJECT_UNSETTLED', 'PROJECT_DOCTOR_GOAL_UNSETTLED', 'PROJECT_DOCTOR_WORKER_UNSETTLED']);
    const issueHealth = all(issues.map(item => blockingIssues.has(item.code) ? false : 'unknown'));
    const result = { projectId, state: ['queued', 'ready', 'unconfirmed'].includes(p.meta.state) ? p.meta.state : 'unknown',
      error: projectError ? { code: projectError } : null, persistenceFailed: flag(p.persistenceFailed), project: projectView, core: coreView, goal, runs, issues, readiness,
      ready: all([projectClear, coreClear, workerClear, runsSettled, goalClear, issueHealth, ...readiness.map(item => item.value)]) };
    await bounded(authorize(p, ctx, true, guard, { readOnly: true })); guard();
    check(JSON.stringify(goals.diagnostic(projectId)) === goalBefore, 'PROJECT_DOCTOR_CHANGED');
    return result;
  }
  async function graph(args, ctx) {
    fields(args, ['projectId']);
    const projectId = contextId(args.projectId);
    return collectProjectGraph({ projectId, readPage: options => result({ projectId, ...options }, ctx), changed: factPageChanged });
  }
  // Operator finalize (design finalize-001). Creator only; never stops workers or touches Goal state.
  async function terminalFacts(projectId, ctx) {
    const facts = []; let options = {};
    for (;;) {
      const page = await result({ projectId, ...options }, ctx);
      facts.push(...page.facts);
      if (!page.page.hasMore) break;
      options = { cursor: page.page.nextCursor };
    }
    const predecessors = new Set(facts.flatMap(fact => fact.predecessors));
    return [...new Set(facts.map(fact => fact.fact_id))].filter(id => !predecessors.has(id)).sort();
  }
  async function finalize(args, ctx) {
    fields(args, ['projectId', 'paperId', 'factIds'], ['projectId']);
    const projectId = contextId(args.projectId), paperId = Object.hasOwn(args, 'paperId') ? args.paperId : 'main';
    check(typeof paperId === 'string' && PAPER_ID.test(paperId), 'PROJECT_INVALID_INPUT');
    let factIds;
    if (Object.hasOwn(args, 'factIds')) {
      check(Array.isArray(args.factIds) && args.factIds.length >= 1 && args.factIds.length <= MAX_TARGET_FACTS
        && args.factIds.every(id => typeof id === 'string' && FACT_ID.test(id)), 'PROJECT_INVALID_INPUT');
      factIds = [...new Set(args.factIds)];
    }
    const p = get(projectId);
    const creator = async () => { check(get(projectId) === p, 'PROJECT_NOT_FOUND'); check(await authorize(p, ctx) === 'creator', 'PROJECT_FINALIZE_DENIED'); };
    await creator();
    if (!factIds) {
      // Suggestion only: no record is written. One restart on observation drift.
      let suggested;
      try { suggested = await terminalFacts(projectId, ctx); }
      catch (error) { if (!factPageChanged(error)) throw error; suggested = await terminalFacts(projectId, ctx); }
      return { projectId, paperId, suggested };
    }
    const factDigests = {};
    for (const factId of factIds) {
      const { fact } = await result({ projectId, factId }, ctx);
      factDigests[factId] = createHash('sha256').update(Buffer.from(fact.markdown, 'utf8')).digest('hex');
    }
    await creator(); live(p);
    const record = { schemaVersion: 1, projectId, paperId, factIds, factDigests, finalizedBy: 'creator', at: Date.now() };
    const packet = json(record);
    const writing = targetExclusive(p, async () => {
      live(p);
      await store.write(location(p, `targets/${paperId}.json`), packet, true);
      p.targets.set(paperId, { ...copy(record), valid: true });
    });
    p.targetWrites = writing; await writing;
    return copy(record);
  }
  // Report reads share the Core FIFO, with a private durable-task authority.
  // No model argument or saved invocation token can select this path.
  async function reportResult(projectId, options, authority) {
    const p = get(projectId), factId = options.factId;
    authority.assertActive();
    const operation = factId === undefined ? 'fact_list_page' : 'fact_get';
    const args = factId === undefined ? factPageOptions(options, { projectId, code: 'PROJECT_INVALID_INPUT' }) : { fact_id: factId };
    // Only the private linear runner gather scope is entered in this map.
    const releaseScratch = ipcReadObservers.has(authority);
    const value = await queueCore(p, operation, normalizeProjectCoreArguments(operation, args), null, false, authority, null, releaseScratch);
    authority.assertActive();
    return validatedRead(p, value, factId, args, releaseScratch);
  }
  async function requireSnapshot(projectId, authority, asOf) {
    let page;
    try { page = await reportResult(projectId, { limit: 1 }, authority); }
    catch (error) { if (factPageChanged(error)) throw failure('PROJECT_SUMMARY_GRAPH_CHANGED'); throw error; }
    check(page.page.asOf === asOf, 'PROJECT_SUMMARY_GRAPH_CHANGED');
  }
  function assertPaperTargetRecord(p, target) {
    live(p); check(get(p.meta.projectId) === p, 'PROJECT_NOT_FOUND');
    check(targetRecordValid(target, p.meta.projectId, target?.paperId), 'PROJECT_TARGET_RECORD_INVALID');
    const current = p.targets.get(target.paperId);
    check(current?.valid === true && json(Object.fromEntries(TARGET_KEYS.map(key => [key, current[key]])))
      === json(Object.fromEntries(TARGET_KEYS.map(key => [key, target[key]]))), 'PROJECT_TARGET_CHANGED');
  }
  async function assertPaperTarget(projectId, target) {
    const p = get(projectId);
    return targetExclusive(p, () => assertPaperTargetRecord(p, target));
  }
  async function withPaperTarget(projectId, target, action) {
    const p = get(projectId);
    return targetExclusive(p, async () => {
      assertPaperTargetRecord(p, target);
      return action();
    });
  }
  function paperRunnerIpcScope(authority) {
    const scoped = { ...authority }, observed = new WeakMap();
    runnerIpcObservers.set(scoped, observed);
    return { authority: scoped, refusalFor: error => observed.get(error) ?? null };
  }
  async function gatherPaperFacts(projectId, authority, target, selectedFactIds = []) {
    const collect = scope => collectPaperFacts({ target, selectedFactIds,
      fetchPage: options => reportResult(projectId, options, scope),
      fetchFact: factId => reportResult(projectId, { factId }, scope),
      assertTarget: () => assertPaperTarget(projectId, target),
      verifySnapshot: asOf => requireSnapshot(projectId, scope, asOf) });
    const runner = runnerIpcObservers.get(authority);
    if (!runner) return collect(authority);
    // A publication retry also gets a fresh gather scope. The publication callback
    // itself is outside this read, so it cannot supply a category.
    const scope = { ...authority }, observed = new WeakMap();
    ipcReadObservers.set(scope, observed);
    try { return await collect(scope); }
    catch (error) {
      const category = observed.get(error);
      if (category) runner.set(error, category);
      throw error;
    }
  }
  async function paperSubgraph(args, ctx) {
    fields(args, ['projectId', 'paperId'], ['projectId']);
    check(Reflect.ownKeys(args).every(key => ['projectId', 'paperId'].includes(key)
      && Object.getOwnPropertyDescriptor(args, key)?.enumerable === true
      && Object.hasOwn(Object.getOwnPropertyDescriptor(args, key), 'value')), 'PROJECT_INVALID_INPUT');
    const projectId = contextId(args.projectId), paperId = Object.hasOwn(args, 'paperId') ? args.paperId : 'main';
    check(typeof paperId === 'string' && PAPER_ID.test(paperId), 'PROJECT_INVALID_INPUT');
    const p = get(projectId), guard = paperCreatorGuard(p, ctx, 'PROJECT_PAPER_SUBGRAPH_CHANGED');
    guard();
    check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_OWNER_DENIED'); guard();
    const target = await targetExclusive(p, () => {
      guard(); const current = p.targets.get(paperId);
      if (!current) return null;
      check(current.valid === true, 'PROJECT_TARGET_RECORD_INVALID');
      const clean = Object.fromEntries(TARGET_KEYS.map(key => [key, copy(current[key])]));
      assertPaperTargetRecord(p, clean); return clean;
    });
    guard();
    if (!target) return { projectId, paperId, status: 'needs_target' };
    const gathered = await readCreatorPaperFacts(p, ctx, guard, target);
    guard(); const facts = paperSkeleton(gathered.facts, target.factIds);
    check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_OWNER_DENIED'); guard();
    return targetExclusive(p, () => {
      guard(); assertPaperTargetRecord(p, target);
      return { projectId, paperId, status: 'ready', headline: [...target.factIds], headline_source: 'target', count: facts.length,
        asOf: gathered.asOf, target: Object.fromEntries(TARGET_KEYS.map(key => [key, copy(target[key])])), facts };
    });
  }
  function paperCreatorGuard(p, ctx, changedCode) {
    const meta = p.meta, projectId = meta.projectId, creator = meta.creator, main = meta.main, projectState = meta.state;
    const creatorId = creator?.sessionId, creatorPath = creator?.sessionPath, rejected = meta.creatorRejected;
    const callerPath = ctx?.sessionPath, callToken = ctx?.callToken;
    const keys = ['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind', 'namespace', 'visibility', 'ownerPluginId', 'state', 'identityConfirmed', 'role', 'phase'];
    const identity = Object.fromEntries(keys.map(key => [key, main?.[key]]));
    const guard = () => {
      live(p);
      check(projects.get(projectId) === p && p.meta === meta && meta.projectId === projectId && meta.state === projectState
        && meta.creator === creator && creator?.sessionId === creatorId && creator?.sessionPath === creatorPath && meta.creatorRejected === rejected
        && ctx?.sessionPath === callerPath && ctx?.callToken === callToken
        && meta.main === main && keys.every(key => main?.[key] === identity[key]), changedCode);
    };
    return guard;
  }
  function changeDashboardFollow(args, ctx, enabled) {
    const value = !types.isProxy(args) && object(args) && Reflect.ownKeys(args).length === 1
      ? Object.getOwnPropertyDescriptor(args, 'projectId') : null;
    check(value?.enumerable && Object.hasOwn(value, 'value'), 'PROJECT_INVALID_INPUT');
    const p = get(contextId(value.value));
    invocation(ctx); openForBusiness();
    check(ctx.sessionPath === p.meta.creator?.sessionPath && ctx.document == null && ctx.principal?.kind !== 'app', 'PROJECT_OWNER_DENIED');
    return track(p, followConsent.set(p, enabled, ctx));
  }
  async function dashboardFollow(args, ctx) { return changeDashboardFollow(args, ctx, true); }
  async function dashboardUnfollow(args, ctx) { return changeDashboardFollow(args, ctx, false); }
  async function authorizeDashboardFollow(p, ctx, enabled) {
    const meta = p.meta, { projectId, creator, taskId } = meta;
    const { sessionId, sessionPath, callToken } = ctx, creatorId = creator?.sessionId, creatorPath = creator?.sessionPath;
    const stable = enabled ? paperCreatorGuard(p, ctx, 'PROJECT_DASHBOARD_FOLLOW_CHANGED') : null;
    const guard = () => {
      live(p);
      check(projects.get(projectId) === p && p.meta === meta && meta.projectId === projectId && meta.creator === creator
        && creatorId && creator?.sessionId === creatorId && creator?.sessionPath === creatorPath && !meta.creatorRejected,
      'PROJECT_DASHBOARD_FOLLOW_CHANGED');
      check(typeof taskId === 'string' && TASK_ID.test(taskId) && meta.taskId === taskId && meta.taskCreation === 'confirmed'
        && meta.taskSettlement === 'confirmed' && !meta.taskError, 'PROJECT_DASHBOARD_FOLLOW_UNAVAILABLE');
      check(ctx.sessionId === sessionId && (sessionId === undefined || sessionId === creatorId) && ctx.sessionPath === sessionPath
        && sessionPath === creatorPath && ctx.callToken === callToken && ctx.document == null && ctx.principal?.kind !== 'app', 'PROJECT_OWNER_DENIED');
      if (enabled) {
        stable();
        check(dashboardProjectReliable(p), 'PROJECT_DASHBOARD_FOLLOW_UNAVAILABLE');
      }
    };
    const recheck = async () => {
      check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_OWNER_DENIED');
      if (enabled) await verifyPublicationOwner(p, guard);
      else {
        // Revocation needs the original creator/setup witness, not a still-
        // readable main session or role. It never grants display authority.
        const receipt = taskReceipt(p, await bounded(sdk.tasks.get(taskId))); guard();
        check(receipt.status === 'completed', 'PROJECT_OWNER_DENIED');
      }
      guard();
    };
    await recheck();
    return { guard, recheck };
  }
  async function readCreatorPaperFacts(p, ctx, guard, target, selectedFactIds = [], ipcObserver) {
    const projectId = p.meta.projectId, active = () => { guard(); assertPaperTargetRecord(p, target); };
    const admission = Object.freeze({ requiredActor: 'creator', guard: active });
    if (ipcObserver) ipcReadObservers.set(admission, ipcObserver);
    // The private observer is supplied only by plan/section creator admission.
    const read = options => result({ projectId, ...options }, ctx, admission, ipcReadObservers.has(admission));
    const assertTarget = () => targetExclusive(p, active);
    try {
      return await collectPaperFacts({ target, selectedFactIds, fetchPage: read, fetchFact: factId => read({ factId }), assertTarget,
        verifySnapshot: async asOf => { const page = await read({ limit: 1 }); check(page.page.asOf === asOf, 'PROJECT_SUMMARY_GRAPH_CHANGED'); } });
    } catch (error) { if (factPageChanged(error)) throw failure('PROJECT_SUMMARY_GRAPH_CHANGED'); throw error; }
  }
  async function withPaperPublication(projectId, authority, target, publish, selectedFactIds = [], { retryGraphChanged = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      let snapshot;
      try { snapshot = await gatherPaperFacts(projectId, authority, target, selectedFactIds); }
      catch (error) { if (error.code === 'PROJECT_SUMMARY_GRAPH_CHANGED' && attempt === 0 && retryGraphChanged) continue; throw error; }
      authority.assertActive();
      return withPaperTarget(projectId, target, async () => {
        authority.assertActive();
        return publish(snapshot);
      });
    }
  }
  async function withReportPublication(projectId, authority, publish) {
    for (let attempt = 0; ; attempt++) {
      let currentSnapshot;
      try { currentSnapshot = await gatherSummaryFacts(projectId, authority); }
      catch (error) { if (error.code === 'PROJECT_SUMMARY_GRAPH_CHANGED' && attempt === 0) continue; throw error; }
      authority.assertActive();
      return publish(currentSnapshot);
    }
  }
  async function gatherGapFillFacts(projectId, authority, factIds) {
    const present = new Set(), facts = [];
    let options = {}, asOf = null;
    try {
      for (;;) {
        const page = await reportResult(projectId, options, authority);
        asOf ??= page.page.asOf;
        check(page.page.asOf === asOf, 'PROJECT_SUMMARY_GRAPH_CHANGED');
        for (const row of page.facts) present.add(row.fact_id);
        if (!page.page.hasMore) break;
        options = { cursor: page.page.nextCursor };
      }
      for (const factId of factIds) {
        check(present.has(factId), 'PROJECT_PAPER_GAP_FILL_FACT_NOT_FOUND');
        const { fact } = await reportResult(projectId, { factId }, authority);
        check(fact && fact.fact_id === factId && Array.isArray(fact.predecessors) && typeof fact.markdown === 'string', 'PROJECT_PAPER_GAP_FILL_FACT_NOT_FOUND');
        facts.push({ fact_id: fact.fact_id, predecessors: [...fact.predecessors], markdown: fact.markdown });
      }
      await requireSnapshot(projectId, authority, asOf);
    } catch (error) { if (factPageChanged(error)) throw failure('PROJECT_SUMMARY_GRAPH_CHANGED'); throw error; }
    return { facts, asOf };
  }
  async function gatherSummaryFacts(projectId, authority) {
    const rows = [], facts = []; let options = {}, asOf = null;
    try {
      for (;;) {
        const page = await reportResult(projectId, options, authority);
        asOf ??= page.page.asOf;
        check(page.page.asOf === asOf, 'PROJECT_SUMMARY_GRAPH_CHANGED');
        rows.push(...page.facts);
        if (!page.page.hasMore) break;
        options = { cursor: page.page.nextCursor };
      }
      for (const factId of [...new Set(rows.map(row => row.fact_id))].sort()) {
        const { fact } = await reportResult(projectId, { factId }, authority);
        facts.push({ fact_id: fact.fact_id, predecessors: [...fact.predecessors], markdown: fact.markdown });
      }
      await requireSnapshot(projectId, authority, asOf);
    } catch (error) { if (factPageChanged(error)) throw failure('PROJECT_SUMMARY_GRAPH_CHANGED'); throw error; }
    return { facts, asOf };
  }
  let reports;
  async function summary(args, ctx) {
    fields(args, ['projectId', 'language'], ['projectId']);
    const projectId = contextId(args.projectId), language = Object.hasOwn(args, 'language') ? args.language : DEFAULT_LANGUAGE;
    check(typeof language === 'string' && LANGUAGE.test(language), 'PROJECT_INVALID_INPUT');
    const p = get(projectId);
    return reports.start(p, { projectId, language }, ctx);
  }
  async function summaryStatus(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.status(get(contextId(args.projectId)), args, ctx, { kind: 'summary' }); }
  async function summaryResult(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.result(get(contextId(args.projectId)), args, ctx, { kind: 'summary' }); }
  async function summaryStop(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.stop(get(contextId(args.projectId)), args, ctx, { kind: 'summary' }); }
  async function paper(args, ctx) {
    fields(args, ['projectId', 'paperId', 'brief', 'instructions', 'factIds'], ['projectId', 'brief']);
    check(Reflect.ownKeys(args).every(key => ['projectId', 'paperId', 'brief', 'instructions', 'factIds'].includes(key)
      && Object.getOwnPropertyDescriptor(args, key)?.enumerable === true
      && Object.hasOwn(Object.getOwnPropertyDescriptor(args, key), 'value')), 'PROJECT_INVALID_INPUT');
    const factIds = normalizePaperSelection(args.factIds);
    args = copy(args);
    const projectId = contextId(args.projectId), paperId = args.paperId ?? 'main';
    check(typeof paperId === 'string' && PAPER_ID.test(paperId), 'PROJECT_INVALID_INPUT');
    const wellFormedText = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && Buffer.byteLength(value) <= 32 * 1024;
    check(wellFormedText(args.brief) && args.brief.trim().length > 0
      && (args.instructions === undefined || wellFormedText(args.instructions)), 'PROJECT_INVALID_INPUT');
    const p = get(projectId), guard = paperCreatorGuard(p, ctx, 'PROJECT_PAPER_CHANGED');
    guard(); check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_SUMMARY_DENIED'); guard();
    const cleanTarget = await targetExclusive(p, () => {
      guard(); const target = p.targets.get(paperId);
      if (!target) return null;
      check(target.valid === true, 'PROJECT_TARGET_RECORD_INVALID');
      const clean = Object.fromEntries(TARGET_KEYS.map(key => [key, copy(target[key])]));
      assertPaperTargetRecord(p, clean); return clean;
    });
    guard(); if (!cleanTarget) return { projectId, paperId, status: 'needs_target' };
    const headlineField = /^\s*headline_fact_ids\s*:\s*(.*?)\s*$/i;
    const exemplarField = /^\s*structural_exemplar\s*:\s*(.*?)\s*$/i;
    const factTokens = /fact_[A-Za-z0-9_]+|\b[0-9a-f]{8,}\b/g;
    const lines = args.brief.split(/\r?\n/);
    const headlineValues = lines.map(line => headlineField.exec(line)).filter(Boolean).map(match => match[1].trim());
    const exemplarValues = lines.map(line => exemplarField.exec(line)).filter(Boolean).map(match => match[1].trim());
    check(headlineValues.length <= 1 && exemplarValues.length <= 1, 'PROJECT_PAPER_BRIEF_TARGET_CONFLICT');
    const headlineValue = headlineValues[0];
    const requestedHeadlines = headlineValue === undefined || !headlineValue || headlineValue.startsWith('<')
      ? null : headlineValue.match(factTokens) ?? [];
    const exemplarValue = exemplarValues[0];
    const exemplar = exemplarValue === undefined || !exemplarValue || exemplarValue.startsWith('<') ? null : exemplarValue;
    check(exemplar === null, 'PROJECT_PAPER_EXEMPLAR_UNAVAILABLE');
    const target = cleanTarget;
    if (headlineValue !== undefined && headlineValue.trim() && !headlineValue.trim().startsWith('<')) {
      check(requestedHeadlines?.length === target.factIds.length
        && requestedHeadlines.every((id, index) => id === target.factIds[index]), 'PROJECT_PAPER_BRIEF_TARGET_CONFLICT');
    }
    const gathered = await readCreatorPaperFacts(p, ctx, guard, cleanTarget, factIds ?? []);
    guard(); const { material } = capturePaperMaterial({ ...gathered, target: cleanTarget, factIds: factIds ?? undefined });
    const handoff = { guard: () => { guard(); assertPaperTargetRecord(p, cleanTarget); }, authorize: async () => {
      guard(); check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_SUMMARY_DENIED');
      guard(); assertPaperTargetRecord(p, cleanTarget);
    } };
    await handoff.authorize(); handoff.guard();
    return reports.start(p, { projectId, language: 'English', kind: 'paper-source', paper: { paperId, target: cleanTarget,
      brief: args.brief, instructions: args.instructions ?? '', ...(factIds ? { factIds } : {}), material } }, ctx, handoff);
  }
  function paperPlan(args, ctx) { return observePaperStart(startPaperPlan, args, ctx); }
  async function startPaperPlan(args, ctx, ipcObserver) {
    args = snapshotPaperPlanRequest(args);
    const projectId = contextId(args.projectId), paperId = args.paperId ?? 'main', p = get(projectId);
    const guard = paperCreatorGuard(p, ctx, 'PROJECT_PAPER_CHANGED');
    guard(); check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_SUMMARY_DENIED'); guard();
    const target = await targetExclusive(p, () => {
      guard(); const current = p.targets.get(paperId); if (!current) return null;
      check(current.valid === true, 'PROJECT_TARGET_RECORD_INVALID');
      const clean = Object.fromEntries(TARGET_KEYS.map(key => [key, copy(current[key])])); assertPaperTargetRecord(p, clean); return clean;
    });
    guard(); if (!target) return { projectId, paperId, status: 'needs_target' };
    assertPlanBrief(args.brief, target);
    const factIds = args.factIds?.length ? [...args.factIds] : null;
    const gather = () => readCreatorPaperFacts(p, ctx, guard, target, factIds ?? [], ipcObserver);
    const gathered = await gather(); guard();
    const { material } = capturePlanMaterial({ ...gathered, target, factIds: factIds ?? undefined });
    const handoff = { gather, ipcRefusalFor: error => ipcObserver.get(error) ?? null, guard: () => { guard(); assertPaperTargetRecord(p, target); }, authorize: async () => {
      guard(); check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_SUMMARY_DENIED');
      guard(); assertPaperTargetRecord(p, target);
    } };
    await handoff.authorize(); handoff.guard();
    return reports.start(p, { projectId, kind: 'paper-plan', language: 'English', plan: { paperId, target, brief: args.brief,
      instructions: args.instructions ?? '', ...(factIds ? { factIds } : {}), material } }, ctx, handoff);
  }
  function paperSection(args, ctx) { return observePaperStart(startPaperSection, args, ctx); }
  async function startPaperSection(args, ctx, ipcObserver) {
    args = snapshotPaperSectionRequest(args);
    const projectId = contextId(args.projectId), p = get(projectId), guard = paperCreatorGuard(p, ctx, 'PROJECT_PAPER_CHANGED');
    const handoff = { guard, ipcRefusalFor: error => ipcObserver.get(error) ?? null, authorize: async () => {
      guard(); check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_SUMMARY_DENIED'); guard();
    }, gather: (target, selected) => readCreatorPaperFacts(p, ctx, guard, target, selected, ipcObserver) };
    await handoff.authorize(); guard();
    return reports.start(p, { projectId, kind: 'paper-section', language: 'English', section: { planReportId: args.planReportId,
      ...(args.previousSectionReportId ? { previousSectionReportId: args.previousSectionReportId } : {}) } }, ctx, handoff);
  }
  async function dashboardSnapshot(args, ctx) {
    const input = snapshotPlanData(args, 'PROJECT_INVALID_INPUT');
    fields(input, ['projectId']);
    const projectId = contextId(input.projectId), p = get(projectId);
    const guard = paperCreatorGuard(p, ctx, 'PROJECT_DASHBOARD_SNAPSHOT_CHANGED');
    const checkDelivery = async () => {
      guard(); check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_OWNER_DENIED'); guard();
      ready(p);
    };
    await checkDelivery();
    const sessionId = p.meta.creator.sessionId;
    const admission = Object.freeze({ requiredActor: 'creator', guard });
    dashboardAdmissions.add(admission);
    const observed = await queueCore(p, 'dashboard_factgraph', {}, ctx, false, null, admission);
    guard();
    const { asOf, graph } = observed;
    check(observed.projectId === projectId && typeof asOf === 'string' && SHA256.test(asOf) && object(graph)
      && Array.isArray(graph.nodes) && graph.nodes.length <= GRAPH_FACT_LIMIT
      && Array.isArray(graph.edges) && graph.edges.length <= GRAPH_EDGE_LIMIT
      && Number.isSafeInteger(graph.max_depth) && graph.max_depth >= 0, 'PROJECT_DASHBOARD_SNAPSHOT_INVALID');
    // A point-in-time graph already settled by CoreAccess, not a live poll.
    const capturedAt = Date.now();
    check(Number.isSafeInteger(capturedAt) && capturedAt >= 0, 'PROJECT_DASHBOARD_SNAPSHOT_INVALID');
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'hana-math.factgraph-snapshot', projectId, asOf, capturedAt,
      graph: { nodes: graph.nodes, edges: graph.edges, max_depth: graph.max_depth } }), 'utf8');
    check(bytes.length <= (1 << 20), 'PROJECT_DASHBOARD_SNAPSHOT_TOO_LARGE');
    return { bytes, sessionId, checkDelivery, summary: { projectId, asOf, capturedAt, nodeCount: graph.nodes.length, edgeCount: graph.edges.length } };
  }
  // Trusted backend callers only. No surface or model supplies this selection.
  async function readDashboard(args, ctx) {
    const input = snapshotPlanData(args, 'PROJECT_INVALID_INPUT');
    fields(input, ['projectId', 'view', 'kind'], ['projectId', 'view']);
    const { projectId: id, ...selection } = input;
    check(validProjectDashboardMemorySelection(selection), 'PROJECT_INVALID_INPUT');
    invocation(ctx);
    const projectId = contextId(id), p = get(projectId);
    const guard = paperCreatorGuard(p, ctx, 'PROJECT_DASHBOARD_OVERVIEW_CHANGED');
    guard(); check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_OWNER_DENIED'); guard();
    ready(p);
    const admission = Object.freeze({ requiredActor: 'creator', guard });
    dashboardMemoryAdmissions.add(admission);
    const observed = await queueCore(p, 'dashboard_memory', selection, ctx, false, null, admission);
    guard();
    return observed.data;
  }
  async function dashboardOverview(args, ctx) {
    const input = snapshotPlanData(args, 'PROJECT_INVALID_INPUT');
    fields(input, ['projectId']);
    return readDashboard({ projectId: input.projectId, view: 'overview' }, ctx);
  }
  async function authorizeDashboardView(args, ctx) {
    const input = snapshotPlanData(args, 'PROJECT_INVALID_INPUT'); fields(input, ['projectId']);
    invocation(ctx);
    const p = get(contextId(input.projectId)), validate = paperCreatorGuard(p, ctx, 'PROJECT_DASHBOARD_VIEW_CHANGED');
    validate(); check(await authorize(p, ctx, false, validate, { readOnly: true }) === 'creator', 'PROJECT_OWNER_DENIED');
    validate(); ready(p);
    return makeDashboardViewReader(p);
  }
  // Separate lexical scope: no invocation, token, document binding or Host
  // access supplied at mint time can be retained or replayed by this reader.
  function makeDashboardViewReader(p, mode = 'document', recordRevision, followStamp = null) {
    const fence = mode === 'snapshot' && createTerminalReadFence(() => terminalWriteState(workspaceCoreWrites.get(p) ?? null,
      research.projectDashboardWriteState(p.meta.projectId)));
    const meta = p.meta, projectId = meta.projectId, creator = meta.creator, main = meta.main;
    const { sessionId: creatorId, sessionPath: creatorPath } = creator;
    const identity = Object.freeze(Object.fromEntries(DASHBOARD_MAIN_IDENTITY.map(k => [k, main[k]])));
    return Object.freeze(async (selection, viewGuard, endedAt) => {
      const publication = mode === 'snapshot' && publicationGuards.has(viewGuard);
      live(p, publication);
      const assertProjectOwned = () => {
        check(projects.get(projectId) === p && p.meta === meta && meta.projectId === projectId && meta.main === main
          && Object.entries(identity).every(([k,v]) => main[k] === v), 'PROJECT_DASHBOARD_VIEW_CHANGED');
        ready(p, publication);
      };
      const terminal = fence && fence.begin(endedAt);
      check(typeof viewGuard === 'function' && !types.isAsyncFunction(viewGuard), 'PROJECT_DASHBOARD_VIEW_GUARD_REQUIRED');
      const guard = () => {
        const allowed = viewGuard();
        if (types.isPromise(allowed)) Promise.prototype.then.call(allowed, undefined, () => {});
        check(allowed === undefined || allowed === true, 'PROJECT_DASHBOARD_VIEW_DENIED');
        assertProjectOwned();
        check(meta.creator === creator && creator.sessionId === creatorId && creator.sessionPath === creatorPath
          && !meta.creatorRejected, 'PROJECT_DASHBOARD_VIEW_CHANGED');
        if (terminal) fence.assert(terminal);
      };
      const input = snapshotPlanData(selection, 'PROJECT_INVALID_INPUT');
      const graph = input?.view === 'factgraph' && Reflect.ownKeys(input).length === 1;
      const factDetail = input?.view === 'fact' && Reflect.ownKeys(input).length === 2 && typeof input.factId === 'string' && FACT_ID.test(input.factId);
      check(graph || factDetail || object(input) && validProjectDashboardMemorySelection(input), 'PROJECT_INVALID_INPUT');
      const recheck = async (active = guard) => {
        active();
        if (followStamp !== null) {
          check(getFollowState(p) === 'enabled' && getFollowStamp(p) === followStamp, 'PROJECT_DASHBOARD_VIEW_DENIED');
          await verifyPublicationOwner(p, active); active(); return;
        }
        const own = await ownSessions();
        active();
        check(!own.some(row => row.path === creatorPath || row.sessionId === creatorId), 'PROJECT_OWNER_DENIED');
      };
      await recheck(); guard();
      const operation = graph || factDetail ? 'dashboard_factgraph' : 'dashboard_memory';
      const admission = Object.freeze({});
      dashboardViewAdmissions.set(admission, Object.freeze({ project: p, operation, guard, recheck, assertProjectOwned, publication, workspace: mode !== 'document' }));
      const args = graph ? {} : factDetail ? { mode: 'fact', factId: input.factId } : input;
      const isGraphSizeLimit = err => err?.coreError?.code === 'size_limit'
        || err?.runtime?.coreError?.code === 'size_limit'
        || err?.cause?.coreError?.code === 'size_limit'
        || err?.state?.current?.outcome?.failure?.runtime?.coreError?.code === 'size_limit';
      const isPageDrift = err => err?.coreError?.code === 'fact_page_changed'
        || err?.runtime?.coreError?.code === 'fact_page_changed'
        || err?.cause?.coreError?.code === 'fact_page_changed'
        || err?.state?.current?.outcome?.failure?.runtime?.coreError?.code === 'fact_page_changed';
      let result;
      try {
        result = await queueCore(p, operation, terminal ? { ...args, terminal: true } : args, null, false, null, admission);
      } catch (error) {
        if (!graph || !isGraphSizeLimit(error)) throw error;
        // Large fact graph (M-07): stream lightweight index pages within existing 1 MiB Core IPC cap.
        let assembled = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            let offset = 0, asOf, maxDepth = 0, totalNodes = null, lastRevision;
            const nodes = [], edges = [];
            for (let pageNo = 0; pageNo < 64; pageNo++) {
              guard();
              const pageArgs = { mode: 'index', offset, limit: 512, ...(asOf ? { asOf } : {}), ...(terminal ? { terminal: true } : {}) };
              const res = await queueCore(p, 'dashboard_factgraph', pageArgs, null, false, null, admission);
              guard();
              const page = res.page;
              asOf ??= res.asOf;
              totalNodes ??= page.total_nodes;
              check(res.asOf === asOf && page.total_nodes === totalNodes && page.offset === nodes.length, 'PROJECT_DASHBOARD_VIEW_CHANGED');
              maxDepth = page.max_depth;
              if (terminal) lastRevision = res.inventoryRevision;
              for (const n of page.nodes) {
                nodes.push({ id: n.id, author: n.author, depth: n.depth, statement: n.statement,
                  predecessors: [...n.predecessors], detailLoaded: false });
                for (const pred of n.predecessors) edges.push({ source: pred, target: n.id });
              }
              if (!page.has_more) break;
              offset = page.next_offset;
            }
            check(nodes.length === totalNodes && nodes.length <= GRAPH_FACT_LIMIT && edges.length <= GRAPH_EDGE_LIMIT, 'PROJECT_DASHBOARD_VIEW_CHANGED');
            assembled = { graph: { nodes, edges, max_depth: maxDepth, detailOnDemand: true }, asOf, ...(terminal ? { inventoryRevision: lastRevision } : {}) };
            break;
          } catch (pageErr) {
            if (isPageDrift(pageErr) && attempt === 0) continue;
            throw pageErr;
          }
        }
        result = assembled;
      }
      guard();
      if (terminal) {
        const data = fence.project(terminal, input, result);
        recordRevision?.(endedAt, result.inventoryRevision);
        return data;
      }
      return graph ? result.graph : factDetail ? result.fact : result.data;
    });
  }
  async function paperStitch(args, ctx) {
    args = snapshotPaperStitchRequest(args);
    const p = get(contextId(args.projectId)), guard = paperCreatorGuard(p, ctx, 'PROJECT_PAPER_STITCH_CHANGED');
    const authorizeStitch = async () => {
      guard(); check(await authorize(p, ctx, false, guard, { readOnly: true }) === 'creator', 'PROJECT_SUMMARY_DENIED'); guard();
    };
    const { bytes, summary, sessionId, checkDelivery } = await reports.stitch(p, args, authorizeStitch, guard);
    return { bytes, summary, sessionId, checkDelivery };
  }
  async function paperSectionStatus(args, ctx) { args = snapshotPaperSectionRequest(args, { read: true }); return reports.status(get(contextId(args.projectId)), args, ctx, { kind: 'paper-section' }); }
  async function paperSectionResult(args, ctx) { args = snapshotPaperSectionRequest(args, { read: true }); return reports.result(get(contextId(args.projectId)), args, ctx, { kind: 'paper-section' }); }
  async function paperSectionStop(args, ctx) { args = snapshotPaperSectionRequest(args, { read: true }); return reports.stop(get(contextId(args.projectId)), args, ctx, { kind: 'paper-section' }); }
  async function paperPlanStatus(args, ctx) { args = snapshotPaperPlanRequest(args, { read: true }); return reports.status(get(contextId(args.projectId)), args, ctx, { kind: 'paper-plan' }); }
  async function paperPlanResult(args, ctx) { args = snapshotPaperPlanRequest(args, { read: true }); return reports.result(get(contextId(args.projectId)), args, ctx, { kind: 'paper-plan' }); }
  async function paperPlanStop(args, ctx) { args = snapshotPaperPlanRequest(args, { read: true }); return reports.stop(get(contextId(args.projectId)), args, ctx, { kind: 'paper-plan' }); }
  async function paperStatus(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.status(get(contextId(args.projectId)), args, ctx, { kind: 'paper-source' }); }
  async function paperResult(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.result(get(contextId(args.projectId)), args, ctx, { kind: 'paper-source' }); }
  async function paperStop(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.stop(get(contextId(args.projectId)), args, ctx, { kind: 'paper-source' }); }
  async function paperAudit(args, ctx) {
    args = snapshotPlanData(args);
    const source = args && Object.hasOwn(args, 'reportId');
    args = source ? snapshotPaperSectionRequest(args, { read: true }) : snapshotPaperStitchRequest(args);
    const p = get(contextId(args.projectId));
    check(await authorize(p, ctx) === 'creator', 'PROJECT_SUMMARY_DENIED'); live(p);
    const selector = source ? { reportId: args.reportId }
      : { planReportId: args.planReportId, finalSectionReportId: args.finalSectionReportId };
    return reports.audit(p, selector, ctx);
  }
  async function paperAuditStatus(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.status(get(contextId(args.projectId)), args, ctx, { kind: 'reference-audit' }); }
  async function paperAuditResult(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.result(get(contextId(args.projectId)), args, ctx, { kind: 'reference-audit' }); }
  async function paperAuditStop(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.stop(get(contextId(args.projectId)), args, ctx, { kind: 'reference-audit' }); }
  async function paperRevise(args, ctx) {
    args = snapshotPaperRevisionRequest(args, { project: true });
    const { projectId, ...revision } = args, p = get(contextId(projectId));
    check(await authorize(p, ctx) === 'creator', 'PROJECT_SUMMARY_DENIED'); live(p);
    return reports.revise(p, revision, ctx);
  }
  async function paperRevisionStatus(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.status(get(contextId(args.projectId)), args, ctx, { kind: 'paper-revision' }); }
  async function paperRevisionResult(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.result(get(contextId(args.projectId)), args, ctx, { kind: 'paper-revision' }); }
  async function paperRevisionStop(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.stop(get(contextId(args.projectId)), args, ctx, { kind: 'paper-revision' }); }
  async function paperVerify(args, ctx) {
    fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']);
    const projectId = contextId(args.projectId), reportId = args.reportId, p = get(projectId);
    check(await authorize(p, ctx) === 'creator', 'PROJECT_SUMMARY_DENIED'); live(p);
    const audit = await reports.status(p, { reportId }, ctx, { kind: 'reference-audit' });
    check(audit.state === 'completed', 'PROJECT_REFERENCE_VERIFY_SOURCE_INVALID');
    return reports.start(p, { kind: 'reference-verification', language: 'English', verification: { auditReportId: reportId, paperId: audit.paperId } }, ctx);
  }
  async function paperVerifyStatus(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.status(get(contextId(args.projectId)), args, ctx, { kind: 'reference-verification' }); }
  async function paperVerifyResult(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.result(get(contextId(args.projectId)), args, ctx, { kind: 'reference-verification' }); }
  async function paperVerifyStop(args, ctx) { fields(args, ['projectId', 'reportId'], ['projectId', 'reportId']); return reports.stop(get(contextId(args.projectId)), args, ctx, { kind: 'reference-verification' }); }
  const paperMathKind = Object.freeze({ kind: 'paper-math-verification' });
  async function paperVerifyMath(args, ctx) {
    args = snapshotPlanData(args);
    const source = args && Object.hasOwn(args, 'reportId');
    args = source ? snapshotPaperSectionRequest(args, { read: true }) : snapshotPaperStitchRequest(args);
    const p = get(contextId(args.projectId));
    const math = source ? { sourceReportId: args.reportId }
      : { planReportId: args.planReportId, finalSectionReportId: args.finalSectionReportId };
    check(await authorize(p, ctx) === 'creator', 'PROJECT_SUMMARY_DENIED'); live(p);
    return reports.start(p, { ...paperMathKind, language: 'English', math }, ctx);
  }
  async function paperVerifyMathStatus(args, ctx) {
    args = snapshotPaperSectionRequest(args, { read: true });
    return reports.status(get(contextId(args.projectId)), args, ctx, paperMathKind);
  }
  async function paperVerifyMathResult(args, ctx) {
    args = snapshotPaperSectionRequest(args, { read: true });
    const p = get(contextId(args.projectId)), owner = p.meta.creator?.sessionId;
    const value = await reports.result(p, args, ctx, paperMathKind);
    check(value?.projectId === args.projectId && value.reportId === args.reportId && value.kind === paperMathKind.kind,
      'PROJECT_REPORT_ARTIFACT_INVALID');
    const files = value.files;
    check((files === undefined && value.readError || Array.isArray(files) && files.length <= 1), 'PROJECT_REPORT_ARTIFACT_INVALID');
    const file = files?.[0], resource = file?.resource;
    if (files?.length) {
      check(file?.role === 'review' && file.name === 'MATH_REVIEW.json', 'PROJECT_REPORT_ARTIFACT_INVALID');
      if (value.status === 'delivery-failed') {
        fields(file, ['role', 'name', 'error']);
      } else {
        fields(file, ['role', 'name', 'bytes', 'sha256', 'resource']);
        fields(resource, ['kind', 'fileId', 'sessionId']);
        check(value.state === 'completed' && Number.isSafeInteger(file.bytes) && file.bytes > 0 && typeof file.sha256 === 'string' && SHA256.test(file.sha256)
          && resource.kind === 'session-file' && typeof resource.fileId === 'string' && resource.fileId
          && typeof owner === 'string' && owner && p.meta.creator?.sessionId === owner && resource.sessionId === owner, 'PROJECT_REPORT_STAGE_INVALID');
      }
    }
    check(value.state !== 'completed' || value.readError || value.status === 'delivery-failed' || resource, 'PROJECT_REPORT_ARTIFACT_INVALID');
    return value;
  }
  async function paperVerifyMathStop(args, ctx) {
    args = snapshotPaperSectionRequest(args, { read: true });
    return reports.stop(get(contextId(args.projectId)), args, ctx, paperMathKind);
  }
  async function paperDeliver(args, ctx, options) {
    args = snapshotPaperDeliveryRequest(args);
    const p = get(contextId(args.projectId));
    check(await authorize(p, ctx) === 'creator', 'PROJECT_SUMMARY_DENIED'); live(p);
    return reports.deliver(p, args, ctx, options);
  }
  async function paperChapterTreeStitch(args, ctx) {
    args = snapshotChapterTreeRequest(args);
    const p = get(contextId(args.projectId));
    check(await authorize(p, ctx) === 'creator', 'PROJECT_SUMMARY_DENIED'); live(p);
    return reports.chapterTreeStitch(p, args, ctx);
  }
  async function invoke(name, args, ctx) {
    check(MAIN_TOOLS.has(name), 'PROJECT_TOOL_DENIED');
    if (await reports.handlesLiterature(ctx)) {
      openForBusiness(); check(name === 'search_arxiv_theorems', 'PROJECT_TOOL_DENIED');
      return reports.invokeLiterature(name, args, ctx);
    }
    if (name !== 'search_arxiv_theorems') args = normalizeProjectCoreArguments(name, args);
    const p = await boundMain(ctx); ready(p);
    if (name === 'search_arxiv_theorems') {
      fields(args, ['query', 'num_results'], ['query']); text(args.query);
      check(Buffer.byteLength(args.query) <= 16384, 'PROJECT_INVALID_INPUT');
      return literature.search(args.query, args.num_results ?? 10);
    }
    return queueCore(p, name, args, ctx, true);
  }
  async function list(ctx) {
    invocation(ctx); await ownSessions(); const result = [];
    for (const p of projects.values()) { try { await authorize(p, ctx); result.push(view(p)); } catch (error) { if (!['PROJECT_OWNER_DENIED', 'PROJECT_MAIN_DENIED'].includes(error.code)) throw error; } }
    return { projects: result };
  }
  // Load a project's Core journal and paper targets only when an authorized
  // caller actually requests this project. Empty maps before this read are
  // not evidence of a clean Core or an empty archive.
  async function loadProjectDetails(p) {
    const meta = p.meta, projectId = meta.projectId;
    try {
      let files; try { files = await store.list(location(p, 'core')); } catch (error) { if (error.code === 'ENOENT') files = []; else throw error; }
      for (const file of files) {
        check(file.endsWith('.json'), 'PROJECT_CORE_RECORD_INVALID'); const id = contextId(file.slice(0, -5));
        const record = await store.readJson(location(p, `core/${id}.json`));
        check(record?.operationId === id && record.projectId === projectId && record.author === meta.main?.agentId && record.role === 'main'
          && Number.isSafeInteger(record.revision), 'PROJECT_CORE_RECORD_INVALID'); p.records.set(id, record);
      }
    } catch { p.coreBlocked = true; }
    try {
      let files; try { files = await store.list(location(p, 'targets')); } catch (error) { if (error.code === 'ENOENT') files = []; else throw error; }
      for (const file of files) {
        if (file.endsWith('.tmp')) continue; // Leftover atomic-write temporary, never a record.
        const paperId = file.endsWith('.json') && PAPER_ID.test(file.slice(0, -5)) ? file.slice(0, -5) : null;
        let record = null;
        if (paperId) { try { record = await store.readJson(location(p, `targets/${paperId}.json`)); } catch { record = null; } }
        p.targets.set(paperId ?? file, paperId && targetRecordValid(record, projectId, paperId)
          ? { ...record, valid: true } : { paperId, valid: false, error: 'PROJECT_TARGET_RECORD_INVALID' });
      }
    } catch { p.targets.set('', { paperId: null, valid: false, error: 'PROJECT_TARGET_RECORD_INVALID' }); }
  }
  async function ensureProjectDetails(p) {
    if (!p.detailsDeferred) return;
    if (!p.detailsLoad) p.detailsLoad = loadProjectDetails(p).then(() => { p.detailsDeferred = false; });
    await p.detailsLoad;
  }
  await store.mkdir(BASE);
  for (const projectId of await store.list(BASE)) {
    try {
      contextId(projectId); const meta = await store.readJson(`${BASE}/${projectId}/project.json`);
      check(meta?.schemaVersion === 1 && meta.projectId === projectId && Number.isSafeInteger(meta.revision) && workerRecordValid(meta.worker, WORKER)
        && (!Object.hasOwn(meta, 'extraWorkers') || Array.isArray(meta.extraWorkers) && meta.extraWorkers.length >= 1 && meta.extraWorkers.length <= MAX_WORKERS - 1
          && meta.extraWorkers.every((w, i) => workerRecordValid(w, `worker-${i + 2}`))), 'PROJECT_RECORD_INVALID');
      projectWorkerPolicy(meta); // Persisted opt-in policy must be complete; never default damaged history.
      for (const { assignment } of workersOf(meta)) {
        if (Object.hasOwn(assignment, 'dispatch')) normalizeWorkerDispatch(assignment.dispatch);
        // Optional display metadata must neither invalidate a project nor restore an unconfirmed title.
        if (Object.hasOwn(assignment, 'displayTitle')) {
          const displayTitle = assignment.state === 'assigned' ? workerDisplayTitle(assignment.displayTitle) : undefined;
          if (displayTitle === undefined) delete assignment.displayTitle;
          else assignment.displayTitle = displayTitle;
        }
      }
      check(!Object.hasOwn(meta, 'workerPlan'), 'PROJECT_RECORD_INVALID'); // Unreleased named-tier records cannot enter the per-run selection path.
      if (meta.state === 'ready') check(meta.main?.state === 'ready' && meta.main.identityConfirmed === true
        && meta.main.namespace === 'home' && meta.main.visibility === 'public' && meta.main.ownerPluginId === APP
        && meta.main.cwd === store.absolute(`context/projects/${projectId}/main`) && meta.main.kind === `math-project:${projectId}:main`
        && typeof meta.main.sessionId === 'string' && typeof meta.main.agentId === 'string', 'PROJECT_RECORD_INVALID');
      else { meta.error ||= 'PROJECT_SETUP_INTERRUPTED'; }
      const p = wrap(meta); projects.set(projectId, p);
      p.detailsDeferred = deferHistoricalWork;
      if (!deferHistoricalWork) await loadProjectDetails(p);
    } catch { damaged.add(projectId); }
  }
  reports = await createProjectReportService({ sdk, store, summaryWriter, deferHistoricalWork,
    isFreshProject: p => freshProjects.has(p),
    authorizeCreator: async (p, ctx) => { check(await authorize(p, ctx) === 'creator', 'PROJECT_SUMMARY_DENIED'); },
    projects: () => projects.values(), getProject: get, assertLive: live, gatherFacts: gatherSummaryFacts, withReportPublication,
    gatherPaperFacts, gatherGapFillFacts, withPaperPublication, paperRunnerIpcScope, assertPaperTarget, withPaperTarget,
    readInput: p => store.readJson(location(p, 'input.json')), track, projectLocation: p => `${BASE}/${p.meta.projectId}`, literature });
  const registration = await bounded(sdk.tasks.registerHandler(HANDLER, { run: async event => {
    const p = projects.get(event?.input?.projectId);
    if (closing || event?.kind !== 'schedule' || !p || !p.nonce || p.nonce !== event.input.nonce || p.setup || p.meta.state !== 'queued') return { status: 'ignored' };
    p.nonce = null;
    p.setup = track(p, (async () => { try { if (event.scheduleId) await bounded(unschedule(p, event.scheduleId)); await setup(p); }
      catch (error) { p.meta.state = 'unconfirmed'; p.meta.error ||= code(error); await save(p).catch(() => {}); await settle(p, false).catch(() => {}); } })());
    p.setup.catch(() => {}); return { status: 'started', projectId: p.meta.projectId };
  }, abort: async taskId => {
    const ignored = { status: 'ignored' };
    const owner = setupAbortOwners.get(taskId), p = owner?.project;
    const cancellable = () => p && !closing && !p.persistenceFailed && setupAbortOwners.get(taskId) === owner
      && p.meta.taskId === taskId && p.meta.taskSettlement === 'pending'
      && (['queued', 'preparing'].includes(p.meta.state) || (p.meta.state === 'ready' && p.setupPermit));
    if (!cancellable() || owner.checking) return ignored;
    // Claim synchronously, before reading the Host. The callback may arrive
    // before or after the Host records cancellation for this still-owned setup.
    owner.checking = Promise.resolve().then(async () => {
      if (!cancellable()) return ignored;
      let task;
      try { task = taskReceipt(p, await bounded(sdk.tasks.get(taskId))); } catch { return ignored; }
      if (!cancellable() || !['pending', 'running', 'canceled', 'aborted'].includes(task.status)) return ignored;
      closeSetupAbort(p);
      p.setupPermit = false; p.nonce = null; p.meta.error = 'PROJECT_SETUP_CANCELLED';
      if (p.meta.state !== 'ready') p.meta.state = 'unconfirmed';
      if (p.meta.startup.state === 'pending') p.meta.startup = { state: 'not-sent' };
      await save(p);
      return { status: 'stopping-setup-only' };
    }).finally(() => { owner.checking = null; });
    return owner.checking;
  } }));
  if (registration?.ready) await bounded(registration.ready);
  function publicationSlot(slot) { return dashboardViewAdmissions.get(slot?.creatorAdmission)?.publication === true; }
  function canDrainPublication() {
    try {
      if (!archiveHealthy || !publisher || damaged.size || goalActions || operatorQueues.has(dataDir)
        || research.dashboardShutdownIdle?.() !== true || reports.dashboardShutdownIdle() !== true) return false;
      return [...projects.values()].every(p => {
        if (!dashboardProjectReliable(p) || p.control || p.meta.scheduleId || p.setupPermit || p.nonce
          || [...p.jobs].some(job => job !== p.corePump) || [...p.coreWaiting].some(slot => !publicationSlot(slot))
          || (p.coreDraining || p.coreBusy) && !publicationSlot(p.coreSlot)) return false;
        const goal = goals.monitorLifecycle(p.meta.projectId);
        return (goal === null || ['paused', 'stopped', 'completed'].includes(goal.state) && !goal.snapshotUnconfirmed)
          && workersOf(p.meta).every(worker => {
            const state = monitorWorker(p.meta.projectId, worker);
            return state.state === 'idle' && !state.snapshotUnconfirmed;
          });
      });
    } catch { return false; }
  }
  function dispose() {
    if (disposal) return disposal;
    // Close external admission in this same turn. Only an existing private
    // publisher read may keep its dependencies while the drain is bounded.
    closing = true;
    disposal = disposeInternal();
    return disposal;
  }
  async function disposeInternal() {
    offTerminal?.(); offWorkerSettlement?.();
    setupAbortOwners.clear();
    try {
      if (canDrainPublication()) {
        drainingPublication = true;
        // Do not rely on a settlement observer's deferred callback running
        // before shutdown. notify performs the original capture checks now.
        for (const p of projects.values()) publisher.notify(p.meta.projectId);
        if (publisher.pending) await bounded(publisher.drain());
      }
    } catch { /* Timed out or refused publication does not hold shutdown open. */ }
    finally { drainingPublication = false; disposed = true; publisher?.close(); }
    for (const p of projects.values()) for (const slot of p.coreWaiting) slot.invalidate(failure('PROJECT_CORE_QUEUE_CANCELLED'));
    const errors = []; let mainControlCleanupPending = true, summaryWriterCleanupPending = false;
    // This window authorizes only the trusted synchronous observer, and only
    // with MainControl's private dispose-check flag. No public live/auth bypass.
    disposeScopeObservation = true;
    try { const outcome = await goals.dispose(); mainControlCleanupPending = outcome.cleanupPending; errors.push(...outcome.errors); }
    catch (error) { errors.push({ code: code(error) }); }
    finally { disposeScopeObservation = false; }
    try {
      const outcome = await bounded(reports.dispose()); summaryWriterCleanupPending = outcome.cleanupPending;
      errors.push(...outcome.errors);
    } catch (error) { summaryWriterCleanupPending = true; errors.push({ code: code(error) }); }
    for (const p of projects.values()) {
      p.setupPermit = false; p.nonce = null;
      const ownsSetup = !deferHistoricalWork || freshProjects.has(p);
      if (ownsSetup && p.meta.state !== 'ready') { p.meta.state = 'unconfirmed'; p.meta.error ||= 'PROJECT_SETUP_INTERRUPTED'; }
      try { if (ownsSetup && p.meta.scheduleId) await bounded(unschedule(p, p.meta.scheduleId)); } catch (e) { errors.push({ projectId: p.meta.projectId, code: code(e) }); }
      try { if (p.core) await p.core.dispose(); } catch (e) { errors.push({ projectId: p.meta.projectId, code: code(e) }); }
      for (const worker of workersOf(p.meta)) {
        if (deferHistoricalWork && (!worker.lastRun || workerRunsStartedHere.get(worker) !== worker.lastRun)) continue;
        try { await refreshWorker(p, worker, true, { force: true }); } catch (e) { errors.push({ projectId: p.meta.projectId, code: code(e) }); }
      }
      try { await bounded(Promise.allSettled([...p.jobs])); await p.writes; await p.coreWrites; await p.targetWrites.catch(() => {});
        if (ownsSetup && p.meta.taskSettlement !== 'confirmed') await settle(p, false);
      } catch (e) { errors.push({ projectId: p.meta.projectId, code: code(e) }); }
    }
    if (registration?.disposeAsync) await registration.disposeAsync(); else if (typeof registration === 'function') registration();
    const pending = [...projects.values()];
    disposeComplete = true;
    return { disposed: true, errors, mainControlCleanupPending, summaryWriterCleanupPending,
      cleanupPending: mainControlCleanupPending || summaryWriterCleanupPending || errors.length > 0 || pending.some(p => p.jobs.size || p.coreBlocked || [...p.records.values()].some(resourceUnsettled) || p.core?.snapshot().pending
      || workersOf(p.meta).some(w => ['pending', 'unknown'].includes(w.start.state) || w.status && jobUnsettled(w.status))
      || p.meta.scheduleId || p.meta.scheduleCleanup?.state === 'failed'
      || p.meta.taskCreation === 'pending' || p.meta.taskId && p.meta.taskSettlement !== 'confirmed'),
      mathematicalUnsettled: pending.some(p => p.mathematicalFences.size > 0 || [...p.records.values()].some(mathematicalUnsettled)),
      mainSessionsAborted: false, theoremEstablished: false };
  }
  async function recoveryReadiness({ projectId, main }) {
    const p = get(projectId), captured = p.meta.main;
    const identityKeys = ['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind', 'namespace', 'visibility', 'ownerPluginId', 'state', 'identityConfirmed'];
    const identity = Object.fromEntries(identityKeys.map(key => [key, captured?.[key]]));
    const before = json(p.meta), writes = [p.writes, p.coreWrites, p.targetWrites];
    const unchanged = () => {
      ready(p);
      check(get(projectId) === p && p.meta.main === captured && json(p.meta) === before
        && identityKeys.every(key => captured[key] === identity[key]), 'PROJECT_RECOVERY_CHANGED');
      check(['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind'].every(key => main?.[key] === identity[key]), 'PROJECT_MAIN_DENIED');
      check(!p.control && !p.setup && !p.jobs.size && !p.coreBusy && !p.coreDraining && !p.coreQueue.length && !p.coreWaiting.size
        && !p.mathematicalFences.size && !p.meta.scheduleId
        && (!p.meta.scheduleCleanup || p.meta.scheduleCleanup.state === 'confirmed' && p.meta.scheduleCleanup.removed === true)
        && p.meta.taskCreation === 'confirmed' && p.meta.taskSettlement === 'confirmed' && p.meta.startup?.state === 'accepted'
        && !p.meta.cleanupPending && !p.meta.indeterminate, 'PROJECT_RECOVERY_UNSETTLED');
      coreGate(p);
      check(writes[0] === p.writes && writes[1] === p.coreWrites && writes[2] === p.targetWrites, 'PROJECT_RECOVERY_CHANGED');
    };
    unchanged(); await bounded(Promise.all(writes)); unchanged();
    const info = await bounded(readResearchSessionInfo(sdk, { sessionId: identity.sessionId }, { namespace: 'home' })); unchanged();
    check(info.lifecycle === 'active' && info.path === identity.sessionPath
      && ['sessionId', 'agentId', 'cwd', 'kind', 'namespace', 'visibility', 'ownerPluginId'].every(key => info[key] === identity[key]), 'PROJECT_MAIN_DENIED');
    const listed = await bounded(sdk.agents.list({ lifecycle: 'all' })); unchanged();
    const agents = listed?.ok !== false && !listed?.error && Array.isArray(listed?.agents) ? listed.agents.filter(a => a.id === identity.agentId) : [];
    check(agents.length === 1 && agents[0].state === 'active' && agents[0].deletedAt == null && agents[0].ownerPluginId === APP
      && ['private', 'plugin_private'].includes(agents[0].visibility) && agents[0].plugin?.ownerPluginId === APP
      && ['private', 'plugin_private'].includes(agents[0].plugin?.visibility) && agents[0].plugin?.kind === 'role'
      && agents[0].plugin?.roleId === 'main', 'PROJECT_MAIN_DENIED');
    for (const worker of workersOf(p.meta)) {
      check(['idle', 'started', 'settled'].includes(worker.start.state) && ['unassigned', 'assigned'].includes(worker.assignment.state)
        && (worker.start.state !== 'started' || typeof worker.start.runId === 'string'), 'PROJECT_WORKER_UNSETTLED');
      const ids = new Set([...worker.runs, ...(worker.lastRun ? [worker.lastRun] : []), ...(worker.start.runId ? [worker.start.runId] : [])]);
      for (const runId of ids) {
        const status = await bounded(research.projectWorkerStatus(projectId, runId)); unchanged();
        check(status && status.state !== 'missing' && status.state !== 'unknown', 'PROJECT_RECOVERY_RUN_UNKNOWN');
        jobStatus(p, worker, status, runId);
        check(!jobUnsettled(status) && !status.resourceBlocked && !status.cleanupErrors?.length
          && !status.submissions?.some(sub => ['pending', 'verifying', 'submitting'].includes(sub.state)), 'PROJECT_WORKER_UNSETTLED');
      }
      if (Object.hasOwn(worker.assignment, 'dispatch')) {
        check(typeof research.validateWorkerDispatch === 'function', 'PROJECT_DISPATCH_UNAVAILABLE');
        await bounded(research.validateWorkerDispatch(copy(worker.assignment.dispatch))); unchanged();
      }
    }
    await bounded(projectMainSession.readProjectMainRecoveryReadiness(sdk, { profiles, binding: captured })); unchanged();
    return { ready: true };
  }
  const goals = await createMainControlService(sdk, {
    deferHistoricalWork, nextMonitorActivation, recoveryReadiness, onDashboardTerminal: id => publisher?.notify(id),
    captureWorkerStopScope, observeWorkerStopScope,
    authorize: (ctx, { projectId, action }) => authorize(get(projectId), ctx, false, undefined, { readOnly: action === 'status' }),
    getMainBinding: async (ctx, { projectId }) => {
      const p = get(projectId); await authorize(p, ctx); ready(p);
      check(typeof projectMainSession.ensureProjectMainGoalTools === 'function', 'MAIN_CONTROL_DEPENDENCY_MISSING');
      const tools = await projectMainSession.ensureProjectMainGoalTools(sdk, { profiles, binding: p.meta.main });
      live(p); check(['ready', 'pending'].includes(tools?.state) && object(tools.selection), 'MAIN_CONTROL_TOOLS_UNCONFIRMED');
      p.meta.main.toolSelection = copy(tools.selection); p.meta.main.explorer = copy(tools.explorer); await save(p);
      await authorize(p, ctx); ready(p);
      check(tools?.state === 'ready', tools?.state === 'pending' ? 'MAIN_CONTROL_TOOLS_PENDING' : 'MAIN_CONTROL_TOOLS_UNCONFIRMED');
      live(p); return copy(p.meta.main);
    },
    verifyCompletion: async (ctx, { projectId, factIds }) => {
      const p = await boundMain(ctx); check(p.meta.projectId === projectId, 'PROJECT_MAIN_DENIED');
      for (const factId of factIds) await result({ projectId, factId }, ctx);
      return { verified: true, projectId, factIds: [...factIds] };
    },
    stopWorkers: async (ctx, { projectId, force }) => {
      const state = await stop({ projectId, force }, ctx), workers = state.workers;
      return { requested: workers.every(worker => worker.stopRequested === true), cleanupPending: Boolean(state.persistenceFailed || state.coreUnsettled
        || workers.some(worker => worker.statusError || ['pending', 'unknown'].includes(worker.start.state) || worker.lastRun && (!worker.status || jobUnsettled(worker.status)))) };
    },
  });
  // A Project stop flag, by itself, cannot tell whether a mathematical round
  // is still running. Only Research can witness that exact round and its exit.
  function admissionCanFollow(p, worker, runId) {
    if (!worker.stopRequested) return true;
    if (worker.stopForce !== false || worker.lastRun !== runId) return false;
    try {
      const obs = research.projectWorkerMonitor(p.meta.projectId, worker.workerId, runId);
      return obs.gracefulRound === true && (obs.state === 'active' || obs.state === 'idle' && obs.terminal?.runId === runId);
    } catch { return false; }
  }
  function monitorWorker(projectId, worker, forDashboard = false) {
    if (!worker.lastRun) return { state: worker.start.state === 'idle' && !worker.start.runId ? 'idle' : 'unknown' };
    if (!['started', 'settled'].includes(worker.start.state) || worker.start.runId !== worker.lastRun
      || worker.runs.filter(id => id === worker.lastRun).length !== 1) return { state: 'unknown' };
    try {
      const { state, terminal, snapshotUnconfirmed, gracefulRound } = research.projectWorkerMonitor(projectId, worker.workerId, worker.lastRun);
      const graceful = forDashboard && gracefulRound === true && worker.stopRequested === true && worker.stopForce === false;
      const stamp = monitorWorkerStarts.get(worker);
      const activation = stamp?.runId === worker.lastRun ? { order: stamp.order } : null;
      if (state === 'idle') {
        if (snapshotUnconfirmed === true) return { state, snapshotUnconfirmed: true };
        if ((worker.stopRequested && !graceful) || terminal === undefined) return { state };
        if (terminal?.runId !== worker.lastRun) return { state, snapshotUnconfirmed: true };
        // Same logical worker, exact lastRun, and a project admission stamped in
        // this process. Research independently witnessed normal completion or
        // the clean end of the exact in-flight round requested to stop.
        return activation ? { state, terminal: { ...activation, startedAt: terminal.startedAt, endedAt: terminal.endedAt },
          ...(graceful && { gracefulRound: true }) } : { state };
      }
      if (state !== 'active') return { state: 'unknown' };
      if (worker.stopRequested && !graceful) return { state: 'idle', snapshotUnconfirmed: true };
      if (worker.start.state !== 'started') return { state: 'unknown' };
      return { state, activation };
    } catch { return { state: 'unknown' }; }
  }
  function dashboardProjectReliable(p) {
    const m = p.meta;
    return !disposed && !damaged.has(m.projectId) && !p.persistenceFailed && !p.coreBlocked && p.mathematicalFences.size === 0
      && m.state === 'ready' && !m.error && !m.creatorRejected && m.main?.state === 'ready' && m.main.identityConfirmed === true
      && m.startup?.state === 'accepted' && m.taskSettlement === 'confirmed';
  }
  function observeWorkspaceProjects(forDashboard = false) {
    if (closing) return [{ lifecycle: 'unknown' }];
    const rows = [...projects].map(([projectId, p]) => {
      const reliable = dashboardProjectReliable(p);
      const goal = reliable ? goals.monitorLifecycle(projectId) : null;
      const workers = reliable ? workersOf(p.meta).map(worker => monitorWorker(projectId, worker, forDashboard)) : [];
      const lifecycle = observeProjectLifecycle({ reliable, goal, workers });
      return { project: p, projectId, ...lifecycle,
        snapshot: lifecycle.lifecycle === 'active' || lifecycle.lifecycle === 'unknown' ? undefined : observeProjectSnapshot(goal, workers) };
    });
    if (damaged.size) rows.push({ lifecycle: 'unknown' });
    return rows;
  }
  function grantWorkspaceDashboard(p, goalOrder = null) {
    // A fresh creator setup/Goal or a current creator opt-in can issue a reader.
    // Across boots a genuine new worker admission may reuse that exact scoped opt-in only.
    try {
      const policy = getFollowState(p);
      if (!dashboardProjectReliable(p) || !['absent','enabled'].includes(policy)) return;
      const followStamp = policy === 'enabled' ? getFollowStamp(p) : null;
      if (policy === 'enabled' && !followStamp) return;
      const { meta } = p, { creator, main, projectId } = meta;
      const creatorId = creator?.sessionId, creatorPath = creator?.sessionPath;
      if (typeof creatorId !== 'string' || !creatorId || typeof creatorPath !== 'string' || !creatorPath) return;
      const identity = DASHBOARD_MAIN_IDENTITY.map(k => main[k]);
      const sameIdentity = () => projects.get(projectId) === p && p.meta === meta && meta.projectId === projectId
        && meta.creator === creator && creator.sessionId === creatorId && creator.sessionPath === creatorPath && !meta.creatorRejected
        && meta.main === main && DASHBOARD_MAIN_IDENTITY.every((k, i) => main[k] === identity[i]);
      let witnessedAt, revision;
      const grant = Object.freeze({ projectId, read: makeDashboardViewReader(p, 'active', undefined, followStamp),
        readSnapshot: makeDashboardViewReader(p, 'snapshot', (at,rev)=>{ witnessedAt=at; revision=rev; }, followStamp),
        snapshotRevision: at => at === witnessedAt ? revision : null });
      workspaceDashboardGrants.set(p, { grant, sameIdentity, goalOrder, followStamp });
    } catch { /* no display grant on incomplete evidence */ }
  }
  function lookupWorkspaceGrant(p) {
    const record = workspaceDashboardGrants.get(p);
    if (!record) return;
    const policy = getFollowState(p);
    if (disposed || !record.sameIdentity() || !['absent','enabled'].includes(policy)
      || (policy === 'enabled' ? getFollowStamp(p) !== record.followStamp : record.followStamp !== null)) {
      workspaceDashboardGrants.delete(p); return;
    }
    if (record.goalOrder !== null) {
      const goal = goals.monitorLifecycle(record.grant.projectId);
      if (!(goal?.state === 'active' && goal.activation?.order === record.goalOrder
        || goal?.state === 'completed' && goal.terminal?.order === record.goalOrder)) return;
    }
    return record.grant;
  }
  async function renewFollowAfterStart(p, worker, runId, order) {
    // The worker already has its own admission. A denial/timeout during this
    // read-only check must neither fail that admission nor nominate a candidate.
    try {
      const stamp=getFollowStamp(p), meta=p.meta, main=meta.main, creator=meta.creator;
      const guard=()=>{
        live(p);
        const g=goals.monitorLifecycle(meta.projectId);
        check(dashboardProjectReliable(p) && projects.get(meta.projectId)===p && p.meta===meta && meta.main===main && meta.creator===creator
          && getFollowState(p)==='enabled' && getFollowStamp(p)===stamp && worker.start.runId===runId && worker.lastRun===runId && admissionCanFollow(p, worker, runId)
          && (order===null ? g===null : g?.state==='active' && g.activation?.order===order), 'PROJECT_DASHBOARD_VIEW_DENIED');
        return true;
      };
      await bounded(verifyPublicationOwner(p,guard)); guard();
      if (!lookupWorkspaceGrant(p)) grantWorkspaceDashboard(p,order);
    } catch { /* No display grant and no change to the accepted worker run. */ }
  }
  function followPolicyChanged(p, enabled) {
    if (!enabled || closing || getFollowState(p) !== 'enabled') {
      if (savedFollowChoice?.project === p) { savedFollowChoice = null; savedFollowReader = null; }
      workspaceDashboardGrants.delete(p); return; // Pending/revoked: retire before any regrant.
    }
    // Nominate the exact consent even if the worker is still stopping. Do not
    // capture a reading basis or infer quiescence from the follow receipt.
    const stamp = getFollowStamp(p);
    if (savedFollowChoice?.project !== p || savedFollowChoice.stamp !== stamp) {
      savedFollowChoice = { project: p, stamp }; savedFollowReader = null;
    }
    const goal = goals.monitorLifecycle(p.meta.projectId);
    if (goal !== null && !['active','completed'].includes(goal?.state)) return;
    const goalOrder = goal?.activation?.order ?? goal?.terminal?.order ?? null;
    if (goal && !Number.isSafeInteger(goalOrder)) return;
    if (!lookupWorkspaceGrant(p)) grantWorkspaceDashboard(p, goalOrder);
    publisher?.notify(p.meta.projectId); // May publish only an independently witnessed current-process terminal.
  }
  function restoreSavedFollowChoice() {
    let choice = null;
    for (const p of projects.values()) {
      if (getFollowState(p) !== 'enabled') continue;
      if (choice) return null; // Two affirmative consents are not a target selection.
      choice = { project: p, stamp: getFollowStamp(p) };
    }
    return choice;
  }
  function savedFollowScope(p) {
    const m = p.meta, id = m.projectId, workers = workersOf(m);
    if (p.detailsDeferred || projects.get(id) !== p || !dashboardProjectReliable(p) || m.taskCreation !== 'confirmed' || m.taskError
      || p.control || waitingForPublication.has(p)) return null;
    const goal = goals.monitorLifecycle(id);
    if (goal !== null && (goal.snapshotUnconfirmed || !['stopped', 'completed'].includes(goal.state))) return null;
    const goalState = goal === null ? null : goals.diagnostic(id);
    if (goal !== null && (goalState?.state !== goal.state || goalState.cleanupPending !== false || goalState.error)) return null;
    const completion = goal?.state === 'completed' ? goals.dashboardCompletionSeal(id) : null;
    if (goal?.state === 'completed' && (typeof completion !== 'string' || !SHA256.test(completion))) return null;
    for (const worker of workers) {
      const state = monitorWorker(id, worker);
      if (state.state !== 'idle' || state.snapshotUnconfirmed) return null;
    }
    const runIds = workers.flatMap(worker => worker.runs);
    if ((!runIds.length && !completion) || new Set(runIds).size !== runIds.length) return null;
    const history = research.projectDashboardHistorySeal?.(id, runIds);
    if (typeof history !== 'string' || !SHA256.test(history)) return null;
    const mutations = [...p.records.values()].filter(r => CORE_MUTATIONS.has(r.operation));
    if (mutations.some(coreUnsettled)) return null;
    return json([workers.map(w => [w.workerId, w.lastRun, w.runs]), history, completion,
      goalState && [goalState.state, goalState.generation],
      mutations.map(r => [r.operationId, r.revision, r.outcome.state]).sort((a,b) => a[0].localeCompare(b[0]))]);
  }
  function getSaved() {
    const choice = savedFollowChoice, clear = () => { savedFollowReader = null; return null; };
    if (!choice || !choice.stamp || closing) return clear();
    const { project: p, stamp } = choice, { projectId, creator, main } = p.meta;
    try {
      if (getFollowState(p) !== 'enabled' || getFollowStamp(p) !== stamp) return clear();
      const seal = savedFollowScope(p);
      if (seal === null) return clear();
      const writes = terminalWriteState(workspaceCoreWrites.get(p) ?? null, research.projectDashboardWriteState(projectId));
      if (writes.pending) return clear();
      if (savedFollowReader?.choice === choice && savedFollowReader.seal === seal && savedFollowReader.creator === creator
        && savedFollowReader.main === main && writes.endedAt < savedFollowReader.asOf) return savedFollowReader;
      const asOf = Date.now(); // Reading basis for current saved bytes; never a run's end time.
      if (!Number.isSafeInteger(asOf) || asOf <= writes.endedAt || asOf > 8640000000000000) return clear();
      savedFollowReader = Object.freeze({ choice, seal, creator, main, projectId, asOf,
        authorize: guard => verifyPublicationOwner(p, guard), read: makeDashboardViewReader(p, 'snapshot', undefined, stamp) });
      return savedFollowReader;
    } catch { return clear(); }
  }
  function historicalCleanupOnly(p) {
    const id = p.meta.projectId, goal = goals.monitorLifecycle(id);
    // Unknown Goal/start records are not historical Worker cleanup evidence.
    if (goal !== null) {
      if (!['stopped', 'completed'].includes(goal.state) || goal.snapshotUnconfirmed || goal.terminal) return false;
      const diagnostic = goals.diagnostic(id);
      if (diagnostic?.state !== goal.state || diagnostic.cleanupPending !== false || diagnostic.error) return false;
    }
    const expected = new Map();
    for (const worker of workersOf(p.meta)) {
      if (worker.lastRun ? !['started', 'settled'].includes(worker.start.state) || worker.start.runId !== worker.lastRun
        || !worker.runs.includes(worker.lastRun) : worker.start.state !== 'idle' || worker.start.runId || worker.runs.length) return false;
      for (const id of worker.runs) {
        if (expected.has(id)) return false;
        expected.set(id, worker.workerId);
      }
    }
    return research.projectDashboardHistoricalCleanup?.(id, expected) === true;
  }
  function historicalFollowChoice(ticket) {
    const choice = savedFollowChoice;
    if (!choice?.stamp || !archiveHealthy || closing || goalActions) return null;
    const p = choice.project;
    if (getFollowState(p) !== 'enabled' || getFollowStamp(p) !== choice.stamp
      || (ticket && ticket.projectId !== p.meta.projectId)) return null;
    let historical = false;
    for (const row of observeWorkspaceProjects(true)) {
      const p = row.project;
      if (!p || !dashboardProjectReliable(p) || p.control || waitingForPublication.has(p)
        || p.meta.taskCreation !== 'confirmed' || p.meta.taskError || workspaceCoreWrites.get(p)?.pending
        || [...p.records.values()].some(r => CORE_MUTATIONS.has(r.operation) && coreUnsettled(r))) return null;
      if (row.lifecycle === 'active') return null;
      if (row.snapshot?.lifecycle === 'snapshot') {
        // The only terminal this branch may select is A's existing exact
        // publication. After restart the archive scope is the durable witness.
        if (!ticket || p !== choice.project || row.snapshot.endedAt !== ticket.endedAt || !lookupWorkspaceGrant(p)) return null;
      } else if (row.lifecycle === 'unknown' || row.snapshot?.lifecycle === 'unknown') {
        if (p === choice.project || !historicalCleanupOnly(p)) return null;
        historical = true;
      } else if (row.snapshot?.lifecycle !== 'idle' || !['idle', 'paused', 'completed'].includes(row.lifecycle)
        || terminalWriteState(null, research.projectDashboardWriteState(row.projectId)).pending) return null;
    }
    return historical ? choice : null;
  }
  // A restored project with no current-process activity can remain parked.
  // This witnesses only the local deferral policy, never settlement of its old work.
  const parkedDashboardRevisions = new WeakMap();
  if (deferHistoricalWork) for (const p of projects.values()) parkedDashboardRevisions.set(p, p.meta.revision);
  function parkedForDashboard(p) {
    if (parkedDashboardRevisions.get(p) !== p.meta.revision || freshProjects.has(p) || p.control
      || waitingForPublication.has(p) || workspaceCoreWrites.has(p) || lookupWorkspaceGrant(p)
      || workersOf(p.meta).some(w => workerRunsStartedHere.has(w))) return false;
    const id = p.meta.projectId, goal = goals.monitorLifecycle(id);
    return goal === null || goal.state === 'unknown' && (goal.historicalDeferred === true
      || goals.diagnostic(id)?.error?.code === 'MAIN_CONTROL_HISTORY_DEFERRED');
  }
  function deferredDashboardNominee(ticket) {
    if (!archiveHealthy || closing || goalActions) return null;
    const follow = savedFollowChoice, barrier = archive.barrier();
    const p = ticket ? projects.get(ticket.projectId) : follow?.project;
    if (!p || !dashboardProjectReliable(p) || p.meta.taskCreation !== 'confirmed' || p.meta.taskError
      || p.control || waitingForPublication.has(p) || workspaceCoreWrites.get(p)?.pending
      || [...p.records.values()].some(r => CORE_MUTATIONS.has(r.operation) && coreUnsettled(r))) return null;
    const policy = getFollowState(p), stamp = getFollowStamp(p);
    if (ticket ? archive.latest() !== ticket || barrier?.state !== 'published' || barrier.endedAt !== ticket.endedAt
      || !(policy === 'absent' || policy === 'enabled' && stamp)
      : barrier || archive.latest() || !follow?.stamp || policy !== 'enabled' || stamp !== follow.stamp) return null;
    return p;
  }
  function deferredDashboardChoice(ticket) {
    const p = deferredDashboardNominee(ticket);
    if (!p) return null;
    // Use only synchronous, in-process observations of other projects. A live
    // competitor (including an ungranted one) is not parked legacy history.
    for (const row of observeWorkspaceProjects(true)) {
      if (row.lifecycle === 'active' || !row.project) return null;
      if (row.project === p) {
        if (row.snapshot?.lifecycle === 'snapshot' && (!ticket || row.snapshot.endedAt !== ticket.endedAt)) return null;
        continue;
      }
      if (parkedForDashboard(row.project)) continue;
      if (!['idle', 'paused', 'completed'].includes(row.lifecycle) || row.snapshot?.lifecycle !== 'idle') return null;
    }
    return p;
  }
  const getHistoricalSaved = () => (deferHistoricalWork ? deferredDashboardChoice() : historicalFollowChoice()) ? getSaved() : null;
  function getHistoricalPublication(ticket) {
    if (deferHistoricalWork) {
      const p = deferredDashboardChoice(ticket);
      return p && savedFollowScope(p) !== null ? ticket : null;
    }
    const choice = historicalFollowChoice(ticket);
    // In addition to the archive's scope/write checks, demand the followed
    // project's own clean lifecycle, exact history and settled mutations.
    return choice && savedFollowScope(choice.project) !== null ? choice : null;
  }
  const workspaceMonitor = createWorkspaceMonitorSelection(observeWorkspaceProjects, () => monitorActivation);
  const liveDashboard = createWorkspaceDashboard({
    workspaceMonitor: createWorkspaceDashboardSelection(() => observeWorkspaceProjects(true), () => monitorActivation, lookupWorkspaceGrant),
    lookupReader: id => lookupWorkspaceGrant(projects.get(id)),
  });
  // Negative witness only: persisted project/run rows alone never create an
  // archive, grant access to Core, or authorize retrospective publication.
  function archiveScope(p) {
    const m = p.meta, owner = m.creator, main = m.main;
    check(!p.detailsDeferred && dashboardProjectReliable(p) && m.taskCreation === 'confirmed' && owner?.sessionId && owner.sessionPath && m.taskId, 'PROJECT_DASHBOARD_VIEW_CHANGED');
    const goal = goals.monitorLifecycle(m.projectId);
    const workerSet = workersOf(m).map(w => [w.workerId,w.lastRun,w.runs]);
    const history=research.projectDashboardHistorySeal?.(m.projectId,workersOf(m).flatMap(w=>w.runs));
    const completion=goal === null ? null : goals.dashboardCompletionSeal(m.projectId);
    check(typeof history === 'string' && SHA256.test(history) && (goal === null || typeof completion === 'string' && SHA256.test(completion)), 'PROJECT_DASHBOARD_SNAPSHOT_CHANGED');
    const mutations = [...p.records.values()].filter(r=>CORE_MUTATIONS.has(r.operation)).map(r=>[r.operationId,r.revision,r.phase,r.outcome?.state]).sort((a,b)=>a[0].localeCompare(b[0]));
    const policy = getFollowState(p);
    check(policy === 'absent' || policy === 'enabled' && getFollowStamp(p), 'PROJECT_DASHBOARD_VIEW_DENIED');
    // Byte-identical pre-opt-in scope for 0.36.3 publications; once a project
    // opts in, its new consent epoch prevents resurrection after revocation.
    return createHash('sha256').update(JSON.stringify(['workspace-publication-v1',m.projectId,m.taskId,owner.sessionId,owner.sessionPath,
      DASHBOARD_MAIN_IDENTITY.map(k=>main[k]),workerSet,mutations,history,completion,
      ...(policy === 'enabled' && getFollowArchiveStamp(p) ? ['persistent-follow',getFollowArchiveStamp(p)] : [])])).digest('hex');
  }
  function terminalOf(p) {
    if (!p || !dashboardProjectReliable(p)) return null;
    const id=p.meta.projectId, goal=goals.monitorLifecycle(id), workers=workersOf(p.meta).map(w=>monitorWorker(id,w,true));
    const row=observeProjectSnapshot(goal,workers);
    return row.lifecycle === 'snapshot' ? row : null;
  }
  function capture(id) {
    if (!archiveHealthy || disposed || !supportsManagedDashboardReads(createCore)) return null;
    const p=projects.get(id);
    if (waitingForPublication.has(p)) return null;
    const terminal=terminalOf(p), grant=terminal && lookupWorkspaceGrant(p);
    if (!grant) return null;
    const {endedAt,source,activation}=terminal, scopeSeal=archiveScope(p);
    const guard=()=>{
      if (disposed || lookupWorkspaceGrant(p)!==grant || archiveScope(p)!==scopeSeal) return false;
      const latest=terminalOf(p);
      if (!latest || latest.endedAt!==endedAt || latest.source!==source || latest.activation.order!==activation.order) return false;
      const writes=terminalWriteState(workspaceCoreWrites.get(p) ?? null,research.projectDashboardWriteState(id));
      return !writes.pending && writes.endedAt < endedAt;
    };
    return {endedAt,scopeSeal,guard,authorize:check=>verifyPublicationOwner(p,check),
      getRevision:()=>grant.snapshotRevision(endedAt),read:grant.readSnapshot};
  }
  function publishedAllowed(ticket) {
    if (!archiveHealthy || disposed || archive.latest()!==ticket) return false;
    const p=projects.get(ticket.projectId);
    if (!p || archiveScope(p)!==ticket.scopeSeal) return false;
    const writes=terminalWriteState(workspaceCoreWrites.get(p) ?? null,research.projectDashboardWriteState(ticket.projectId));
    return !writes.pending && writes.endedAt < ticket.endedAt;
  }
  async function verifyPublicationOwner(p,guard) {
    guard();
    const {creator,main}=p.meta;
    const receipt=taskReceipt(p,await bounded(sdk.tasks.get(p.meta.taskId))); guard();
    check(receipt.status==='completed' && !(await ownSessions()).some(s=>s.sessionId===creator.sessionId || s.path===creator.sessionPath),'PROJECT_OWNER_DENIED'); guard();
    const info=await readResearchSessionInfo(sdk,{sessionId:main.sessionId},{namespace:'home'}); guard();
    check(info.lifecycle==='active' && info.path===main.sessionPath && ['sessionId','agentId','cwd','kind','namespace','visibility','ownerPluginId'].every(k=>info[k]===main[k]),'PROJECT_MAIN_DENIED');
    const roster=await bounded(sdk.agents.list({lifecycle:'all'})); guard();
    const roles=roster?.ok!==false && !roster?.error && Array.isArray(roster?.agents) ? roster.agents.filter(a=>a.id===main.agentId) : [];
    check(roles.length===1 && roles[0].deletedAt==null && roles[0].state==='active' && roles[0].ownerPluginId===APP && roles[0].plugin?.ownerPluginId===APP
      && ['private','plugin_private'].includes(roles[0].visibility) && ['private','plugin_private'].includes(roles[0].plugin?.visibility)
      && roles[0].plugin.kind==='role' && roles[0].plugin.roleId==='main','PROJECT_MAIN_DENIED');
  }
  const authorizePublished=(ticket,guard)=>verifyPublicationOwner(projects.get(ticket.projectId),guard);
  publisher=createSnapshotPublisher({archive,capture: id => {
    const candidate = capture(id);
    if (!candidate) return null;
    return { ...candidate,
      guard: () => (!closing || drainingPublication && !disposed && canDrainPublication()) && candidate.guard(),
      read(selection, guard, endedAt) {
        // Only the publisher can mark its read capability. A route, document or
        // stale caller can never present this guard to the Project Core queue.
        const internal = () => guard();
        publicationGuards.add(internal);
        return candidate.read(selection, internal, endedAt);
      } };
  }});
  if (archiveHealthy && typeof research.subscribeProjectDashboardTerminal==='function') offTerminal=research.subscribeProjectDashboardTerminal(publisher.notify);
  if (archiveHealthy && typeof research.subscribeProjectWorkerSettlement==='function') offWorkerSettlement=research.subscribeProjectWorkerSettlement(id=>{
    goals.refreshDashboardTerminal(id);
    // Stopping never emits a normal finished-run event. Only a witnessed,
    // clean round boundary can wake the unmanaged project's publisher here.
    const p = projects.get(id);
    if (p && dashboardProjectReliable(p) && goals.monitorLifecycle(id) === null
      && workersOf(p.meta).some(worker => monitorWorker(id, worker, true).gracefulRound === true)) publisher.notify(id);
  });
  savedFollowChoice = restoreSavedFollowChoice(); // No live grant or Core read on restore.
  const publishedDashboard=withPublishedWorkspaceDashboard({live:liveDashboard,archive,allowed:publishedAllowed,authorize:authorizePublished,epoch:()=>monitorActivation,
    getSaved, getHistoricalSaved, getHistoricalPublication,
    liveOwnerCheck(cur) {
      if (cur?.state !== 'active' && cur?.state !== 'snapshot') return null;
      const p = projects.get(cur.projectId), record = workspaceDashboardGrants.get(p);
      return record?.followStamp ? guard => verifyPublicationOwner(p, guard) : null;
    }});
  const dashboardHistoryPreparations = new WeakMap();
  async function prepareDashboardCurrent(guard) {
    if (guard() !== true) return;
    const ticket = archive.latest(), p = deferredDashboardChoice(ticket);
    if (!p || savedFollowScope(p) !== null) return;
    const { projectId } = p.meta, expected = historicalRunRefs(p), key = json(expected);
    const stamp = getFollowStamp(p), epoch = monitorActivation, revision = p.meta.revision;
    const exact = () => {
      check(guard() === true && monitorActivation === epoch && p.meta.revision === revision && getFollowStamp(p) === stamp
        && deferredDashboardNominee(ticket) === p && json(historicalRunRefs(p)) === key, 'PROJECT_DASHBOARD_VIEW_CHANGED');
      return true;
    };
    let entry = dashboardHistoryPreparations.get(p);
    if (entry?.key === key) { await entry.job; return; }
    await verifyPublicationOwner(p, exact); exact();
    entry = dashboardHistoryPreparations.get(p);
    if (entry?.key === key) { await entry.job; return; }
    if (entry?.pending) return; // A changed scope never joins or replaces an in-flight preparation.
    entry = { key, pending: true, job: null };
    dashboardHistoryPreparations.set(p, entry);
    entry.job = Promise.resolve().then(async () => {
      exact();
      await ensureProjectDetails(p);
      exact();
      await goals.prepareProject(projectId); // Local scoped load only; never runs alarm recovery.
      exact();
      await research.prepareProjectHistory(projectId, expected, exact, { fresh: freshProjects.has(p) });
      exact();
    }).catch(() => {
      // A stable denial is not work for every poll to repeat. A cancelled or
      // superseded request, on the other hand, cannot consume the new scope.
      try { exact(); } catch { dashboardHistoryPreparations.delete(p); }
    }).finally(() => { entry.pending = false; });
    await entry.job;
  }
  const workspaceDashboard = deferHistoricalWork ? Object.freeze({
    async current(guard) {
      try { await prepareDashboardCurrent(guard); }
      catch { return { state: 'unavailable' }; }
      return publishedDashboard.current(guard);
    },
    read: publishedDashboard.read, // A business request never loads absent historical scope.
  }) : publishedDashboard;
  async function runGoalAction(action) {
    openForBusiness(); goalActions++;
    try { return await action(); } finally { goalActions--; }
  }
  async function goal(action, args, ctx) {
    const result = await runGoalAction(() => goals.invoke(action, args, ctx));
    openForBusiness();
    // MainControl itself requires 'creator' for these two actions, including
    // the existing Project authorize and bound-main readiness checks. Never
    // infer a creator from worker start, restore, or a viewer request.
    if ((action === 'start' || action === 'resume') && result?.state === 'active') {
      try {
        const p = projects.get(result.projectId), activation = goals.monitorLifecycle(result.projectId)?.activation?.order;
        const current = goals.diagnostic(result.projectId);
        if (p && Number.isSafeInteger(activation) && activation > 0 && current?.generation === result.generation
          && ['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind'].every(k => p.meta.main?.[k] === result.main?.[k])
          && p.meta.creator?.sessionPath === ctx.sessionPath) grantWorkspaceDashboard(p, activation);
      } catch { /* the successful Goal result is independent of display */ }
    }
    return result;
  }
  async function mainGoal(action, args, ctx) {
    check(['status', 'acknowledge', 'wait', 'continue_work', 'pause', 'stop', 'complete'].includes(action), 'PROJECT_TOOL_DENIED');
    // Internal tool permission is not authority. The genuine caller must match
    // the full currently bound main identity, never the creator or a worker.
    const p = await boundMain(ctx, { readOnly: action === 'status' }); openForBusiness(); check(args?.projectId === p.meta.projectId, 'PROJECT_MAIN_DENIED');
    return runGoalAction(() => goals.invoke(action, args, ctx));
  }
  return Object.freeze({ create, operatorRead, operatorSave, list, status, ipcUsage, assign, start, stop, result: (args, ctx) => result(args, ctx, null, true), graph, dashboardSnapshot, workerModels, finalize, summary, summaryStatus, summaryResult, summaryStop, paperSubgraph, paper, paperStatus, paperResult, paperStop,
    paperAudit, paperAuditStatus, paperAuditResult, paperAuditStop, paperVerify, paperVerifyStatus, paperVerifyResult, paperVerifyStop,
    paperVerifyMath, paperVerifyMathStatus, paperVerifyMathResult, paperVerifyMathStop,
    paperDeliver, paperChapterTreeStitch,
    paperPlan, paperPlanStatus, paperPlanResult, paperPlanStop, paperSection, paperSectionStatus, paperSectionResult, paperSectionStop, paperStitch, paperStartIpcRefusal,
    paperRevise, paperRevisionStatus, paperRevisionResult, paperRevisionStop, dashboardOverview, readDashboard, authorizeDashboardView, dashboardFollow, dashboardUnfollow,
    verificationReads, recheck, doctor, invoke, handles, goal, mainGoal, workspaceMonitor, workspaceDashboard,
    activateRestarts: () => runGoalAction(() => goals.activateRestarts()), dispose });
}
