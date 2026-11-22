// Project main Goal controller, wired through ProjectService and math_goal.
// Authority callbacks receive the original Host ctx. Timer/event callbacks never
// manufacture an actor, callToken or session context. No LoopManager/worker task.
import { randomUUID } from 'node:crypto';
import { createContextStore } from './context-service.mjs';
import { readResearchSessionInfo } from './research-session-info.mjs';
import { nativeExplorationGuidance, nativeExplorationState, explorerProjection } from './native-exploration.mjs';
import { stopScope, stopObservation, combineSettlement } from './worker-stop-reconciliation.mjs';

export const MAIN_CONTROL_INTERVAL_MS = 30 * 60 * 1000;
export const MAIN_CONTROL_AUDIT_MS = 4 * 60 * 60 * 1000;
const APP = 'hana-math', BASE = 'research/main-controls', HANDLER = 'math-project-main-control', CONTROL_MS = 10000;
const BUDGET_WAIT = 'continuation-budget';
const STATES = new Set(['active', 'paused', 'stopping', 'stopped', 'completed', 'blocked']);
const PROJECT = /^project-[a-z0-9][a-z0-9-]{0,59}$/, FACT = /^[a-f0-9]{16}$/;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f]/.test(v);
const time = v => Number.isSafeInteger(v) && v >= 0;
const copy = v => structuredClone(v);
const failure = code => Object.assign(new Error(code), { code });
function check(ok, code) { if (!ok) throw failure(code); }
function code(error) { const value = object(error) || error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null; return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'MAIN_CONTROL_OPERATION_FAILED'; }
function fields(value, allowed, required = ['projectId']) {
  check(object(value) && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k))
    && typeof value.projectId === 'string' && PROJECT.test(value.projectId), 'MAIN_CONTROL_INVALID_INPUT');
}
function binding(value) {
  check(object(value) && value.identityConfirmed === true && ['sessionId', 'sessionPath', 'agentId', 'cwd'].every(k => text(value[k]))
    && (value.kind === null || text(value.kind)), 'MAIN_CONTROL_BINDING_INVALID');
  const exploration = Object.hasOwn(value, 'exploration') ? value.exploration : nativeExplorationState(value.toolSelection);
  check(['available', 'unavailable', 'unknown'].includes(exploration), 'MAIN_CONTROL_BINDING_INVALID');
  return { sessionId: value.sessionId, sessionPath: value.sessionPath, agentId: value.agentId, cwd: value.cwd, kind: value.kind, identityConfirmed: true, exploration, explorer: explorerProjection(value.explorer, value.agentId) };
}
function validRestartAuthorization(value) {
  return object(value) && Reflect.ownKeys(value).length === 1
    && Object.getOwnPropertyDescriptor(value, 'resume')?.enumerable === true
    && ['none', 'preserve-budget'].includes(Object.getOwnPropertyDescriptor(value, 'resume')?.value);
}
function validateRecord(m, projectId) {
  check(object(m) && m.schemaVersion === 1 && m.projectId === projectId && text(m.goalId) && STATES.has(m.state)
    && Number.isSafeInteger(m.generation) && m.generation > 0 && m.authorization?.explicit === true && time(m.authorization.at)
    && time(m.nextControlAt) && time(m.nextAuditAt) && (m.lastAuditAt === null || time(m.lastAuditAt))
    && typeof m.waiting === 'boolean' && typeof m.continueRequested === 'boolean' && object(m.due) && object(m.ack)
    && object(m.workerStop), 'MAIN_CONTROL_RECORD_INVALID');
  binding(m.main);
  if (Object.hasOwn(m, 'restartAuthorization')) check(validRestartAuthorization(m.restartAuthorization), 'MAIN_CONTROL_RECORD_INVALID');
  if (Object.hasOwn(m, 'restartIntent')) {
    const intent = m.restartIntent;
    check(object(intent) && Object.keys(intent).length === 3 && text(intent.goalId) && time(intent.generation) && intent.generation > 0
      && intent.priorActive === true, 'MAIN_CONTROL_RECORD_INVALID');
  }
  if (Object.hasOwn(m, 'continuationBudget')) {
    const budget = m.continuationBudget;
    check(object(budget) && Object.keys(budget).length === 2 && Object.hasOwn(budget, 'limit') && Object.hasOwn(budget, 'reserved')
      && time(budget.limit) && time(budget.reserved) && (budget.limit === 0 ? budget.reserved === 0 : budget.reserved <= budget.limit), 'MAIN_CONTROL_RECORD_INVALID');
  }
  if (Object.hasOwn(m, 'waitReason')) {
    check([null, 'main-wait', BUDGET_WAIT].includes(m.waitReason), 'MAIN_CONTROL_RECORD_INVALID');
    if (m.waitReason === BUDGET_WAIT) check(m.waiting && m.continuationBudget?.limit > 0
      && m.continuationBudget.reserved === m.continuationBudget.limit, 'MAIN_CONTROL_RECORD_INVALID');
  }
  for (const kind of ['control', 'audit']) if (m.due[kind] !== null) check(object(m.due[kind]) && time(m.due[kind].at)
    && Number.isSafeInteger(m.due[kind].generation) && m.due[kind].generation > 0 && typeof m.due[kind].notified === 'boolean', 'MAIN_CONTROL_RECORD_INVALID');
  if (m.send !== null) check(object(m.send) && text(m.send.id) && Number.isSafeInteger(m.send.generation)
    && ['pending', 'accepted', 'rejected', 'unknown'].includes(m.send.state) && typeof m.send.late === 'boolean', 'MAIN_CONTROL_RECORD_INVALID');
  if (m.alarm !== null) check(object(m.alarm) && text(m.alarm.token) && (m.alarm.id === null || text(m.alarm.id)) && time(m.alarm.runAt)
    && Number.isSafeInteger(m.alarm.generation) && ['pending', 'confirmed', 'unknown'].includes(m.alarm.creation)
    && object(m.alarm.cleanup) && ['none', 'pending', 'confirmed', 'failed'].includes(m.alarm.cleanup.state)
    && typeof m.alarm.cleanup.removed === 'boolean', 'MAIN_CONTROL_RECORD_INVALID');
}

/** Dependencies are trusted backend adapters, not model-selected callbacks:
 * authorize(ctx, {projectId, action}) -> 'creator' | 'main'
 * getMainBinding(ctx, {projectId}) -> already verified saved main binding
 * verifyCompletion(ctx, {projectId, factIds}) -> {verified:true, projectId, factIds}
 * That adapter confirms canonical fact existence only, not coverage of the goal.
 * stopWorkers(ctx, {projectId, force}) -> {requested:true, cleanupPending:boolean}
 * captureWorkerStopScope({projectId}) -> {targets:[{workerId,runId,complete}]},
 * synchronous loaded-memory capture before the stop intent's first save.
 * observeWorkerStopScope({projectId, main, scope}) -> scalar target states,
 * synchronous loaded-memory observation only; neither callback receives ctx.
 * recoveryReadiness({projectId, main}) -> {ready:true}, readonly and ctx-free
 * No callback is invoked with a synthetic ctx. Optional store/clock are fixtures
 * or trusted infrastructure. This implementation does not create a root task.
 */
export async function createMainControlService(sdk, { authorize, getMainBinding, verifyCompletion, stopWorkers, recoveryReadiness,
  captureWorkerStopScope, observeWorkerStopScope, nextMonitorActivation,
  store = createContextStore(sdk.dataDir), clock = { now: () => Date.now(), setTimeout, clearTimeout } } = {}) {
  check([authorize, getMainBinding, verifyCompletion, stopWorkers].every(f => typeof f === 'function')
    && ['now', 'setTimeout', 'clearTimeout'].every(k => typeof clock[k] === 'function'), 'MAIN_CONTROL_DEPENDENCY_MISSING');
  const goals = new Map(), damaged = new Set(), tickets = new WeakMap(), restartCandidates = new Map();
  let disposed = false, restartActivation, disposal;
  const restartAllowed = p => p.meta.restartAuthorization?.resume === 'preserve-budget';
  const workerStopSettled = (p, options) => p.meta.workerStop.state === 'not-requested'
    || p.meta.workerStop.state === 'requested' && (p.meta.workerStop.cleanupPending === false
      || workerStopReconciliation(p, options)?.state === 'settled');
  const now = () => { const n = clock.now(); check(time(n), 'MAIN_CONTROL_CLOCK_INVALID'); return n; };
  const location = id => `${BASE}/${id}.json`;
  function bounded(promise) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = clock.setTimeout(() => reject(failure('MAIN_CONTROL_TIMEOUT')), CONTROL_MS); })])
      .finally(() => clock.clearTimeout(timer));
  }
  const wrap = meta => ({ meta, writes: Promise.resolve(), failed: false, ready: false, jobs: new Set(), sendJob: null,
    arming: null, subscription: null, subscriptionJob: null, events: Promise.resolve(), activity: 0, endConsumed: true,
    firstSend: true, alarm: meta.alarm ? { meta: meta.alarm, creating: false, cleaning: null, fired: false } : null });
  function save(p) {
    p.meta.revision++; const packet = JSON.stringify(p.meta);
    check(Buffer.byteLength(packet) <= 64 * 1024, 'MAIN_CONTROL_RECORD_TOO_LARGE');
    const job = p.writes.catch(() => {}).then(() => store.write(location(p.meta.projectId), packet + '\n', true));
    p.writes = job; job.catch(() => { p.failed = true; p.ready = false; });
    return bounded(job).catch(error => { p.failed = true; p.ready = false; throw error; });
  }
  function track(p, job) { p.jobs.add(job); job.finally(() => p.jobs.delete(job)).catch(() => {}); return job; }
  function active(p, generation = p.meta.generation) { return !disposed && !p.failed && p.ready && p.meta.state === 'active' && p.meta.generation === generation; }
  function markMonitorActivation(p, generation) {
    if (!active(p, generation)) return;
    // Observation is process-local, and cannot affect lifecycle on failure.
    try { p.monitorActivation = { generation, order: nextMonitorActivation?.(), startedAt: now() }; } catch { /* unavailable */ }
  }
  function workerStopReconciliation(p, { disposeCheck = false } = {}) {
    const receipt = p.meta.workerStop;
    if (receipt.state === 'not-requested') return null;
    const unknown = reason => ({ state: 'unknown', source: 'unknown', generation: p.meta.workerStop.generation ?? null, reasons: [reason] });
    if (disposed && !disposeCheck) return unknown('WORKER_STOP_OBSERVATION_CHANGED');
    if (receipt.state !== 'requested') return unknown('WORKER_STOP_RECEIPT_UNCONFIRMED');
    if (!Object.hasOwn(p.meta, 'workerStopScope') || p.meta.workerStopScope === null) return receipt.cleanupPending === false
      ? { state: 'settled', source: 'receipt', generation: receipt.generation ?? null, targets: null, reasons: [] }
      : unknown('WORKER_STOP_UNBOUND_SCOPE');
    const original = p.meta.workerStopScope, epoch = p.meta.generation, main = p.meta.main, projectId = p.meta.projectId, goalId = p.meta.goalId;
    let scope;
    try { scope = stopScope(original, receipt.generation); } catch { /* malformed loaded evidence stays unknown */ }
    if (!scope) return unknown('WORKER_STOP_UNBOUND_SCOPE');
    let stamp;
    try { stamp = JSON.stringify({ scope: original, main, receipt }); } catch { return unknown('WORKER_STOP_UNBOUND_SCOPE'); }
    const current = () => {
      try { return (!disposed || disposeCheck === true) && !p.failed && goals.get(projectId) === p && p.meta.projectId === projectId && p.meta.goalId === goalId && p.meta.generation === epoch
        && p.meta.workerStop === receipt && receipt.generation === scope.generation && p.meta.workerStopScope === original && p.meta.main === main
        && JSON.stringify({ scope: original, main, receipt }) === stamp; }
      catch { return false; }
    };
    if (!current()) return unknown('WORKER_STOP_OBSERVATION_CHANGED');
    if (typeof observeWorkerStopScope !== 'function') return unknown('WORKER_STOP_OBSERVER_UNAVAILABLE');
    try {
      const observation = observeWorkerStopScope({ projectId: p.meta.projectId, main: copy(main), scope,
        ...(disposeCheck === true ? { disposeCheck: true } : {}) });
      if (observation && typeof observation.then === 'function') {
        Promise.resolve(observation).catch(() => {}); return unknown('WORKER_STOP_OBSERVER_ASYNC');
      }
      if (!current()) return unknown('WORKER_STOP_OBSERVATION_CHANGED');
      const targets = stopObservation(observation, p.meta.projectId, scope);
      if (!current()) return unknown('WORKER_STOP_OBSERVATION_CHANGED');
      if (!targets) return unknown('WORKER_STOP_OBSERVATION_INVALID');
      return { state: combineSettlement(targets.map(target => target.state)), source: 'loaded-memory', generation: scope.generation,
        currentGeneration: epoch, targets, reasons: [...new Set(targets.flatMap(target => target.reasons))] };
    } catch { return unknown(current() ? 'WORKER_STOP_OBSERVATION_FAILED' : 'WORKER_STOP_OBSERVATION_CHANGED'); }
  }
  function view(p) {
    const reconciliation = workerStopReconciliation(p);
    return { managed: true, ...copy(p.meta), workerStopReconciliation: reconciliation, persistenceFailed: p.failed, sendInFlight: Boolean(p.sendJob),
      goalCleanupPending: p.meta.state !== 'active' && (Boolean(p.sendJob) || p.meta.send?.state === 'unknown' || Boolean(p.arming)
        || Boolean(p.alarm && (!p.alarm.meta.cleanup.removed || p.alarm.creating))),
      workerCleanupKnown: typeof p.meta.workerStop.cleanupPending === 'boolean',
      ...(p.meta.state === 'completed' ? { completionSemantics: {
        decisionBy: 'bound-main', appCheck: 'canonical-fact-existence', targetCoverage: 'not-checked-by-app',
        operatorFinalize: { performedByThisAction: false, observedState: 'unknown' },
      } } : {}) };
  }
  function get(id) { check(!damaged.has(id), 'MAIN_CONTROL_RECORD_INVALID'); const p = goals.get(id); check(p, 'MAIN_CONTROL_NOT_FOUND'); return p; }
  async function auth(action, args, ctx, allowed) {
    check(!disposed, 'MAIN_CONTROL_DISPOSED');
    check(object(ctx) && text(ctx.callToken) && text(ctx.sessionPath), 'MAIN_CONTROL_CALLER_UNBOUND');
    const actor = await bounded(Promise.resolve().then(() => authorize(ctx, { projectId: args.projectId, action })));
    check(allowed.includes(actor), 'MAIN_CONTROL_FORBIDDEN'); return actor;
  }
  async function block(p, error) {
    if (p.meta.state === 'active') { p.ready = false; p.meta.state = 'blocked'; p.meta.generation++; }
    cancelAlarmCallback(p.alarm);
    p.meta.error ||= code(error); await save(p).catch(() => {});
    await cleanupAlarm(p, p.alarm).catch(() => {});
  }
  function collectDue(p) {
    const n = now(); let fresh = false;
    for (const [kind, field, interval] of [['control', 'nextControlAt', MAIN_CONTROL_INTERVAL_MS], ['audit', 'nextAuditAt', MAIN_CONTROL_AUDIT_MS]]) {
      if (n < p.meta[field]) continue;
      // Coalesce missed periods into their latest anchored point, not all future
      // obligations into an older accepted-but-unacknowledged delivery.
      const at = p.meta[field] + Math.floor((n - p.meta[field]) / interval) * interval;
      const next = at + interval;
      check(time(at) && time(next), 'MAIN_CONTROL_CLOCK_INVALID');
      p.meta.due[kind] = { at, generation: p.meta.generation, notified: false };
      p.meta[field] = next;
      fresh = true;
    }
    return fresh;
  }
  function budgetExhausted(p) {
    const budget = p.meta.continuationBudget;
    return budget?.limit > 0 && budget.reserved >= budget.limit;
  }
  function enterBudgetWait(p) {
    p.meta.waiting = true;
    p.meta.waitReason = BUDGET_WAIT;
    p.meta.continueRequested = false;
  }
  function wanted(p) { return Object.values(p.meta.due).some(v => v && !v.notified) || p.meta.continueRequested && !p.meta.waiting; }
  function prompt(p, sending) {
    const points = ['control', 'audit'].filter(k => sending.points[k] !== null).map(k => `${k}=${sending.points[k]}`).join(', ');
    return `Hana Math project ${p.meta.projectId}, Goal ${p.meta.goalId}, generation ${sending.generation}. `
      + (points ? `A substantive review is due: ${points}. Read the problem, verified facts, global memory and worker status; perform the saved main contract's control beat/macro audit, not merely a status report. ` : 'Continue useful reasoning, dispatch or synthesis under the saved main contract. ')
      + (p.recoveryReview ? 'Restart review: first read math_project status to inspect the original worker assignments and dispatch selections, then decide whether to start new runs. Old runs are not replayed. ' : '')
      + 'Use math_goal_main to acknowledge exact due points with this Goal and generation; delivery acceptance is not an acknowledgement. '
      + 'Before waiting, complete and acknowledge every pending review, including any newer anchored point; wait refuses unacknowledged reviews even if not yet notified. When no immediate reasoning, dispatch or synthesis remains (including while awaiting real worker work), explicitly wait instead of inventing polling work. When real work resumes in an active Goal, use continue_work with the current Goal and generation; this does not resume a paused Goal. '
      + nativeExplorationGuidance(p.meta.main.exploration ?? 'unknown', p.meta.main.explorer) + ' '
      + 'An exhausted continuation budget cannot be cleared by main actions; deadline reviews remain available. Only creator pause/resume can refresh that budget. '
      + 'Bound main decides Goal completion. The App only checks that canonical fact IDs exist, not that they cover the target; complete does not execute operator finalize or observe its global state.';
  }
  async function checkBinding(p) {
    const info = await readResearchSessionInfo(sdk, { sessionId: p.meta.main.sessionId }, { namespace: 'home' });
    check(info.lifecycle === 'active' && info.sessionId === p.meta.main.sessionId && info.path === p.meta.main.sessionPath
      && info.agentId === p.meta.main.agentId && info.cwd === p.meta.main.cwd && info.kind === p.meta.main.kind, 'MAIN_CONTROL_BINDING_MISMATCH');
  }
  function kick(p) {
    if (!active(p) || p.sendJob || p.meta.send?.state === 'unknown' || !wanted(p)) return;
    const generation = p.meta.generation;
    const job = Promise.resolve().then(async () => {
      await bounded(checkBinding(p));
      if (!active(p, generation) || !wanted(p)) return;
      if (p.restartGuard === generation) {
        check(typeof recoveryReadiness === 'function', 'MAIN_CONTROL_RECOVERY_UNAVAILABLE');
        const readiness = await bounded(Promise.resolve().then(() => recoveryReadiness({ projectId: p.meta.projectId, main: copy(p.meta.main) })));
        if (!active(p, generation) || !wanted(p)) return;
        check(readiness?.ready === true, 'MAIN_CONTROL_RECOVERY_NOT_READY');
        check(workerStopSettled(p), 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED');
        if (!active(p, generation) || !wanted(p)) return;
        p.restartGuard = null;
      }
      const sending = { id: `send-${randomUUID()}`, generation, state: 'pending', invoked: false, at: now(), settledAt: null, late: false,
        points: Object.fromEntries(['control', 'audit'].map(k => [k, p.meta.due[k] && !p.meta.due[k].notified ? p.meta.due[k].at : null])) };
      sending.kind = Object.values(sending.points).some(v => v !== null) ? 'review' : 'continue';
      if (sending.kind === 'continue') {
        if (budgetExhausted(p)) {
          enterBudgetWait(p);
          await save(p);
          return;
        }
        // This is a durable reservation, not an actual model invocation count.
        // Cancellation, rejection and unknown delivery never refund it.
        if (p.meta.continuationBudget?.limit > 0) p.meta.continuationBudget.reserved++;
      } else if (budgetExhausted(p)) {
        enterBudgetWait(p);
      } else {
        p.meta.waiting = false;
        p.meta.waitReason = null;
      }
      p.meta.send = sending;
      p.meta.continueRequested = false;
      await save(p); // Reserve together with pending, before any SDK send.
      if (!active(p, generation) || sending.kind === 'continue' && p.meta.waiting) {
        sending.state = 'rejected';
        sending.notSent = true;
        await save(p);
        return;
      }
      if (p.firstSend) { p.firstSend = false; p.endConsumed = false; }
      const raw = track(p, Promise.resolve().then(() => {
        if (!active(p, generation) || sending.kind === 'continue' && p.meta.waiting) { sending.notSent = true; return { accepted: false, sessionId: p.meta.main.sessionId, sessionPath: p.meta.main.sessionPath }; }
        sending.invoked = true;
        return sdk.sessions.send({ sessionId: p.meta.main.sessionId, deliverAs: 'steer', text: prompt(p, sending) });
      }).then(async receipt => {
        const identity = receipt?.sessionPath === p.meta.main.sessionPath && (!receipt.sessionId || receipt.sessionId === p.meta.main.sessionId)
          && (!receipt.sessionRef || receipt.sessionRef.sessionId === p.meta.main.sessionId && receipt.sessionRef.sessionPath === p.meta.main.sessionPath);
        sending.state = identity && receipt.accepted === true && receipt.ok !== false && !receipt.error ? 'accepted'
          : identity && receipt.accepted === false ? 'rejected' : 'unknown';
        sending.acceptance = sending.state;
        if (sending.completionError) sending.state = 'unknown';
        sending.settledAt = now(); sending.late = !active(p, generation);
        if (sending.late) p.meta.lateDelivery = { id: sending.id, generation, state: sending.state, at: sending.settledAt };
        if (sending.state === 'accepted' && p.meta.generation === generation) p.recoveryReview = false;
        if (sending.state === 'accepted') for (const k of ['control', 'audit']) {
          if (p.meta.due[k]?.generation === generation && p.meta.due[k].at === sending.points[k]) p.meta.due[k].notified = true;
        }
        await save(p);
        check(sending.state === 'accepted' || sending.notSent, sending.state === 'rejected' ? 'MAIN_CONTROL_SEND_REJECTED' : 'MAIN_CONTROL_SEND_UNKNOWN');
      }, async error => {
        sending.state = 'unknown'; sending.settledAt = now(); sending.late = !active(p, generation); sending.error = code(error);
        if (sending.late) p.meta.lateDelivery = { id: sending.id, generation, state: 'unknown', at: sending.settledAt };
        await save(p); throw error;
      }));
      try { await bounded(raw); }
      catch (error) {
        if (sending.state === 'pending') { sending.state = 'unknown'; sending.error = code(error); await save(p).catch(() => {}); }
        if (active(p, generation)) await block(p, error);
      }
    }).finally(async () => {
      // Let the last already-reserved send settle (or be explicitly cancelled)
      // before latching wait, rather than cancelling it merely for using the last slot.
      if (active(p, generation) && budgetExhausted(p) && p.meta.waitReason !== BUDGET_WAIT) {
        enterBudgetWait(p);
        await save(p);
      }
    }).catch(error => { if (active(p, generation)) return block(p, error); });
    p.sendJob = job; track(p, job);
    job.finally(() => { if (p.sendJob === job) p.sendJob = null; if (active(p) && wanted(p)) kick(p); }).catch(() => {});
  }
  function cancelAlarmCallback(alarm) {
    alarm?.cancelCallback?.();
  }
  function waitAlarmDeadline(p, alarm, generation) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = () => { clock.clearTimeout(timer); alarm.cancelWait = null; resolve(); };
      alarm.cancelWait = finish;
      const wake = () => {
        try {
          if (p.alarm !== alarm || !active(p, generation)) return finish();
          const remaining = alarm.meta.runAt - now();
          if (remaining <= 0) return finish();
          // A long wait must not overflow the native timer or move the anchor.
          timer = clock.setTimeout(wake, Math.min(remaining, 2147483647));
        } catch (error) { clock.clearTimeout(timer); alarm.cancelWait = null; reject(error); }
      };
      wake();
    });
  }
  function scheduleReceipt(p, alarm, value) {
    check(value?.pluginId === APP && value.scope === 'app' && value.handlerKey === HANDLER && text(value.scheduleId)
      && value.runAt === alarm.meta.runAt && value.intervalMs === null
      && value.payload?.projectId === p.meta.projectId && value.payload.goalId === p.meta.goalId
      && value.payload.generation === alarm.meta.generation && value.payload.token === alarm.meta.token, 'MAIN_CONTROL_SCHEDULE_UNCONFIRMED');
    check((!alarm.meta.id || alarm.meta.id === value.scheduleId)
      && (!alarm.receivedId || alarm.receivedId === value.scheduleId), 'MAIN_CONTROL_SCHEDULE_UNCONFIRMED');
    alarm.receivedId = value.scheduleId; return value;
  }
  function cleanupAlarm(p, alarm) {
    cancelAlarmCallback(alarm);
    if (!alarm || alarm.meta.cleanup.removed) return Promise.resolve();
    if (alarm.cleaning) return alarm.cleaning;
    if (!alarm.meta.id) return Promise.resolve(); // Unknown creation remains visible; a late receipt performs cleanup.
    if (alarm.meta.cleanup.state === 'failed') return Promise.reject(failure('MAIN_CONTROL_CLEANUP_UNCONFIRMED'));
    const id = alarm.meta.id;
    const job = Promise.resolve().then(async () => {
      alarm.meta.cleanup = { state: 'pending', removed: false, scheduleId: id, error: null }; await save(p);
      const receipt = await bounded(Promise.resolve().then(() => sdk.tasks.unschedule(id)));
      check(receipt?.ok === true && !receipt.error, 'MAIN_CONTROL_UNSCHEDULE_UNCONFIRMED');
      alarm.meta.id = null; alarm.meta.cleanup = { state: 'confirmed', removed: true, scheduleId: id, error: null }; await save(p);
    }).catch(async error => { alarm.meta.cleanup.state = 'failed'; alarm.meta.cleanup.error = code(error); await save(p).catch(() => {}); throw error; });
    alarm.cleaning = track(p, job); return alarm.cleaning;
  }
  function arm(p) {
    if (!active(p) || p.arming) return p.arming || Promise.resolve();
    const runAt = Math.min(p.meta.nextControlAt, p.meta.nextAuditAt), generation = p.meta.generation;
    if (p.alarm && !p.alarm.meta.cleanup.removed && p.alarm.meta.runAt === runAt && p.alarm.meta.generation === generation) return Promise.resolve();
    const job = Promise.resolve().then(async () => {
      await cleanupAlarm(p, p.alarm);
      if (!active(p, generation)) return;
      check(!p.alarm?.creating && (!p.alarm || p.alarm.meta.cleanup.removed), 'MAIN_CONTROL_SCHEDULE_UNSETTLED');
      const meta = { token: randomUUID(), generation, id: null, runAt, creation: 'pending', cleanup: { state: 'none', removed: false, error: null } };
      const alarm = { meta, creating: true, cleaning: null, fired: false }; p.alarm = alarm; p.meta.alarm = meta; await save(p);
      if (!active(p, generation)) { alarm.creating = false; meta.creation = 'confirmed'; meta.cleanup = { state: 'confirmed', removed: true, error: null }; await save(p); return; }
      const raw = track(p, Promise.resolve().then(() => sdk.tasks.schedule({ scope: 'app', handlerKey: HANDLER, runAt,
        label: 'Math main control deadline', payload: { projectId: p.meta.projectId, goalId: p.meta.goalId, generation, token: meta.token } })).then(async value => {
        const receipt = scheduleReceipt(p, alarm, value); alarm.creating = false; meta.creation = 'confirmed';
        if (!meta.cleanup.removed) meta.id = receipt.scheduleId;
        await save(p);
        if (!active(p, generation) || alarm.fired && !alarm.callbackPending) await cleanupAlarm(p, alarm);
      }));
      try { await bounded(raw); }
      catch (error) {
        if (meta.creation === 'pending') meta.creation = 'unknown';
        if (p.alarm === alarm && p.meta.generation === generation) await block(p, error);
      }
    }).catch(error => { if (p.meta.generation === generation) return block(p, error); });
    p.arming = job; track(p, job);
    job.finally(() => { if (p.arming === job) p.arming = null;
      if (active(p) && p.alarm?.meta.cleanup.removed && !p.alarm.creating && !p.alarm.callbackPending) arm(p);
    }).catch(() => {});
    return job;
  }
  function activity(p, data, sourcePath) {
    if (disposed || p.failed || !data || sourcePath !== p.meta.main.sessionPath
      || Object.hasOwn(data, 'sessionId') && data.sessionId !== p.meta.main.sessionId) return;
    if (data.type === 'error') {
      const sending = p.meta.send;
      if (data.source !== 'session:send' || !sending?.invoked) return;
      sending.completionError = 'MAIN_CONTROL_SEND_COMPLETION_FAILED'; sending.state = 'unknown';
      sending.late = !active(p, sending.generation);
      if (sending.late) p.meta.lateDelivery = { id: sending.id, generation: sending.generation, state: 'unknown', at: now() };
      track(p, block(p, failure('MAIN_CONTROL_SEND_COMPLETION_FAILED'))); return;
    }
    if (p.meta.state !== 'active') return;
    const generation = p.meta.generation;
    // Native Stop may remove the Pi subscription before agent_end is forwarded.
    // Fence immediately on this stable event, including during preparation; do
    // not infer its initiator from reason. Preparation-only session_status is
    // not a stable Stop signal, so detection of every external Stop is NOT promised.
    if (data.type === 'turn_end' && data.aborted === true) {
      p.endConsumed = true;
      p.meta.lastInterruption = { generation, at: now(), source: 'turn_end', reason: 'aborted', actorKnown: false };
      track(p, block(p, failure('MAIN_CONTROL_MAIN_INTERRUPTED'))); return;
    }
    if (!active(p)) return;
    if (data.type === 'agent_start') {
      const activity = ++p.activity; p.endConsumed = false;
      p.events = p.events.then(async () => {
        if (!active(p, generation) || p.activity !== activity) return;
        if (!budgetExhausted(p)) {
          p.meta.waiting = false;
          p.meta.waitReason = null;
        }
        await save(p);
      }).catch(error => block(p, error));
      return;
    }
    if (data.type !== 'agent_end' || data.willRetry === true) return;
    // Only role/stopReason metadata is consumed, never message content or TASK.
    const message = Array.isArray(data.messages) ? data.messages.filter(m => m?.role === 'assistant').at(-1) : null;
    const reason = message?.stopReason;
    if (!['stop', 'toolUse', 'length', 'error', 'aborted'].includes(reason)) return;
    if (reason === 'error' || reason === 'aborted') {
      p.endConsumed = true;
      p.meta.lastInterruption = { generation, at: now(), source: 'agent_end', reason, actorKnown: false };
      track(p, block(p, failure('MAIN_CONTROL_MAIN_INTERRUPTED'))); return;
    }
    if (p.endConsumed) return; p.endConsumed = true;
    const activity = p.activity;
    p.events = p.events.then(async () => {
      if (!active(p, generation) || p.activity !== activity) return;
      if (!p.meta.waiting) p.meta.continueRequested = true;
      await save(p); kick(p);
    }).catch(error => block(p, error));
  }
  async function subscribe(p) {
    if (p.subscription) return;
    if (!p.subscriptionJob) p.subscriptionJob = track(p, Promise.resolve().then(() => sdk.bus.subscribe((data, sourcePath) => activity(p, data, sourcePath),
      { sessionPath: p.meta.main.sessionPath, types: ['agent_start', 'agent_end', 'turn_end', 'error'] })).then(async handle => {
      check(typeof handle === 'function', 'MAIN_CONTROL_SUBSCRIPTION_INVALID'); p.subscription = handle;
      if (handle.ready) await bounded(handle.ready);
      if (disposed) await bounded(Promise.resolve().then(() => handle.disposeAsync ? handle.disposeAsync() : handle()));
    }));
    await bounded(p.subscriptionJob);
  }
  async function start(args, ctx) {
    fields(args, ['projectId', 'authorized', 'maxAutomaticContinues', 'restartAuthorization'], ['projectId', 'authorized']);
    if (Object.hasOwn(args, 'restartAuthorization')) check(validRestartAuthorization(args.restartAuthorization), 'MAIN_CONTROL_INVALID_INPUT');
    check(args.authorized === true, 'MAIN_CONTROL_AUTHORIZATION_REQUIRED');
    if (Object.hasOwn(args, 'maxAutomaticContinues')) check(time(args.maxAutomaticContinues), 'MAIN_CONTROL_INVALID_INPUT');
    await auth('start', args, ctx, ['creator']);
    const mainBinding = await bounded(Promise.resolve().then(() => getMainBinding(ctx, { projectId: args.projectId })));
    const main = binding(mainBinding);
    check(!damaged.has(args.projectId), 'MAIN_CONTROL_RECORD_INVALID'); check(!goals.has(args.projectId), 'MAIN_CONTROL_ALREADY_EXISTS');
    const n = now(), p = wrap({ schemaVersion: 1, projectId: args.projectId, goalId: `goal-${randomUUID()}`, revision: 0, generation: 1,
      state: 'active', authorization: { explicit: true, at: n },
      ...(Object.hasOwn(args, 'restartAuthorization') ? { restartAuthorization: copy(args.restartAuthorization) } : {}), main, nextControlAt: n, nextAuditAt: n, lastAuditAt: null,
      due: { control: null, audit: null }, ack: { control: null, audit: null }, waiting: false, continueRequested: false,
      send: null, lateDelivery: null, alarm: null, workerStop: { state: 'not-requested', cleanupPending: null }, completion: null, error: null,
      ...(Object.hasOwn(args, 'maxAutomaticContinues') ? { continuationBudget: { limit: args.maxAutomaticContinues, reserved: 0 } } : {}) });
    goals.set(args.projectId, p); collectDue(p);
    const generation = p.meta.generation;
    try { await save(p); await subscribe(p); p.ready = true; await arm(p); kick(p); markMonitorActivation(p, generation); return view(p); }
    catch (error) { await block(p, error); throw error; }
  }
  function assertResumable(p) {
    check(!disposed, 'MAIN_CONTROL_DISPOSED');
    check(['paused', 'stopped', 'blocked'].includes(p.meta.state) && !p.failed, 'MAIN_CONTROL_NOT_RESUMABLE');
    check(!p.sendJob && !['pending', 'unknown'].includes(p.meta.send?.state) && !p.arming, 'MAIN_CONTROL_SEND_UNSETTLED');
    check(!['pending', 'unknown'].includes(p.meta.workerStop.state), 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED');
  }
  async function resume(args, ctx) {
    fields(args, ['projectId', 'maxAutomaticContinues']);
    if (Object.hasOwn(args, 'maxAutomaticContinues')) check(time(args.maxAutomaticContinues), 'MAIN_CONTROL_INVALID_INPUT');
    await auth('resume', args, ctx, ['creator']);
    const p = get(args.projectId);
    assertResumable(p);
    const generation = p.meta.generation;
    const mainBinding = await bounded(Promise.resolve().then(() => getMainBinding(ctx, { projectId: args.projectId })));
    const main = binding(mainBinding);
    check(['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind'].every(k => main[k] === p.meta.main[k]), 'MAIN_CONTROL_BINDING_MISMATCH');
    await reconcileAlarm(p); check(p.meta.generation === generation && !p.failed, 'MAIN_CONTROL_STALE');
    // Awaited adapters can change settlement without changing the inactive epoch.
    assertResumable(p);
    check(!p.alarm || p.alarm.meta.cleanup.removed && !p.alarm.creating, 'MAIN_CONTROL_CLEANUP_UNCONFIRMED');
    p.meta.main = main;
    delete p.meta.restartIntent; restartCandidates.delete(p); p.restartGuard = null; p.recoveryReview = false;
    p.meta.generation++;
    p.meta.state = 'active';
    p.meta.error = null;
    p.meta.waiting = false;
    p.meta.waitReason = null;
    p.meta.continueRequested = false;
    // Only this authorized new epoch resets reservations; legacy omission stays absent.
    if (Object.hasOwn(args, 'maxAutomaticContinues') || Object.hasOwn(p.meta, 'continuationBudget')) {
      p.meta.continuationBudget = { limit: args.maxAutomaticContinues ?? p.meta.continuationBudget.limit, reserved: 0 };
    }
    const n = now();
    if (!p.meta.due.control) p.meta.due.control = { at: n, generation: p.meta.generation, notified: false };
    if (!p.meta.due.audit && (p.meta.lastAuditAt === null || n - p.meta.lastAuditAt >= MAIN_CONTROL_AUDIT_MS)) p.meta.due.audit = { at: n, generation: p.meta.generation, notified: false };
    collectDue(p); for (const point of Object.values(p.meta.due)) if (point) { point.generation = p.meta.generation; point.notified = false; }
    p.endConsumed = true; p.firstSend = true;
    const epoch = p.meta.generation;
    try { await save(p); await subscribe(p); p.ready = true; await arm(p); kick(p); markMonitorActivation(p, epoch); return view(p); }
    catch (error) { await block(p, error); throw error; }
  }
  function exactGoal(p, args) { check(args.goalId === p.meta.goalId && args.generation === p.meta.generation, 'MAIN_CONTROL_STALE'); }
  function currentGoal(p, args) {
    exactGoal(p, args);
    check(active(p), 'MAIN_CONTROL_INACTIVE');
  }
  function refreshCurrentDue(p, args) {
    currentGoal(p, args);
    return collectDue(p);
  }
  async function acknowledge(args, ctx) {
    fields(args, ['projectId', 'goalId', 'generation', 'controlAt', 'auditAt'], ['projectId', 'goalId', 'generation']);
    check(Object.hasOwn(args, 'controlAt') || Object.hasOwn(args, 'auditAt'), 'MAIN_CONTROL_INVALID_INPUT');
    await auth('acknowledge', args, ctx, ['main']);
    const p = get(args.projectId);
    // Persist refreshed obligations even if this acknowledgement is stale. Each
    // write can cross another boundary or an inactive epoch, so recheck before use.
    while (refreshCurrentDue(p, args)) await save(p);
    for (const kind of ['control', 'audit']) if (Object.hasOwn(args, `${kind}At`)) check(time(args[`${kind}At`]) && p.meta.due[kind]?.generation === args.generation
      && p.meta.due[kind].at === args[`${kind}At`], 'MAIN_CONTROL_ACK_MISMATCH');
    for (const kind of ['control', 'audit']) if (Object.hasOwn(args, `${kind}At`)) {
      p.meta.ack[kind] = { generation: args.generation, at: args[`${kind}At`], acknowledgedAt: now() }; p.meta.due[kind] = null;
      if (kind === 'audit') p.meta.lastAuditAt = now();
    }
    await save(p);
    currentGoal(p, args);
    await arm(p);
    currentGoal(p, args);
    kick(p);
    return view(p);
  }
  async function wait(args, ctx) {
    fields(args, ['projectId', 'goalId', 'generation'], ['projectId', 'goalId', 'generation']);
    await auth('wait', args, ctx, ['main']);
    const p = get(args.projectId);
    while (refreshCurrentDue(p, args)) await save(p);
    if (p.meta.due.control || p.meta.due.audit) {
      throw Object.assign(failure('MAIN_CONTROL_DUE_UNACKNOWLEDGED'), {
        message: 'Perform the substantive pending reviews, then call math_goal_main acknowledge with the exact goalId, generation and non-null controlAt/auditAt below before retrying wait; do not acknowledge work not performed.',
        pendingReview: { projectId: p.meta.projectId, goalId: p.meta.goalId, generation: p.meta.generation,
          controlAt: p.meta.due.control?.at ?? null, auditAt: p.meta.due.audit?.at ?? null },
      });
    }
    p.activity++;
    p.endConsumed = true;
    p.meta.waiting = true;
    p.meta.waitReason = budgetExhausted(p) ? BUDGET_WAIT : 'main-wait';
    p.meta.continueRequested = false;
    await save(p);
    currentGoal(p, args);
    return view(p);
  }
  async function continue_work(args, ctx) {
    fields(args, ['projectId', 'goalId', 'generation'], ['projectId', 'goalId', 'generation']);
    await auth('continue_work', args, ctx, ['main']);
    const p = get(args.projectId);
    exactGoal(p, args);
    check(active(p), 'MAIN_CONTROL_INACTIVE');
    check(!budgetExhausted(p), 'MAIN_CONTROL_CONTINUATION_BUDGET_EXHAUSTED');
    // Follow-up input can continue inside the same agent run without agent_start.
    // This explicit business signal clears wait, not a paused/stopped Goal, and
    // authorizes observing the next normal end; it never sends another input here.
    p.activity++;
    p.endConsumed = false;
    p.meta.waiting = false;
    p.meta.waitReason = null;
    p.meta.continueRequested = false;
    await save(p);
    return view(p);
  }
  async function deactivate(p, state, ctx, force = false) {
    const stoppingWorkers = state === 'stopping' || state === 'completed';
    if (stoppingWorkers) check(!['pending', 'unknown'].includes(p.meta.workerStop.state), 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED');
    const activation = p.monitorActivation, endedAt = p.meta.completion?.at;
    const completing = state === 'completed' && activation?.generation === p.meta.generation
      && active(p) && !p.meta.error && !['unknown', 'rejected'].includes(p.meta.send?.state);
    if (state === 'completed') p.monitorCompletionAttempted = true;
    delete p.meta.restartIntent; restartCandidates.delete(p); p.restartGuard = null; p.recoveryReview = false;
    p.ready = false; p.meta.generation++; p.meta.state = state; p.meta.waiting = true; p.meta.continueRequested = false;
    const generation = p.meta.generation;
    // Reserve before any await; pause must preserve this stop's identity/status.
    if (stoppingWorkers) {
      p.meta.workerStop = { state: 'pending', generation, cleanupPending: true };
      // Admission is closed above. Capture before the first await, not after the
      // Project stop adapter's asynchronous authorization or a late start receipt.
      p.meta.workerStopScope = null;
      const receipt = p.meta.workerStop;
      try {
        const captured = captureWorkerStopScope?.({ projectId: p.meta.projectId });
        if (captured && typeof captured.then === 'function') Promise.resolve(captured).catch(() => {});
        else if (!disposed && p.meta.generation === generation && p.meta.workerStop === receipt
          && object(captured) && Reflect.ownKeys(captured).length === 1 && Object.hasOwn(captured, 'targets')) {
          const targets = Object.getOwnPropertyDescriptor(captured, 'targets');
          if (targets?.enumerable === true && Object.hasOwn(targets, 'value')) p.meta.workerStopScope = stopScope({ generation, targets: targets.value }, generation);
        }
      } catch { /* Failed capture never changes the original stop semantics. */ }
    }
    cancelAlarmCallback(p.alarm);
    await save(p); // Both the inactive epoch and stop intent precede external cleanup.
    const clean = cleanupAlarm(p, p.alarm).catch(error => { p.meta.error ||= code(error); });
    if (stoppingWorkers) {
      try {
        const result = await bounded(Promise.resolve().then(() => stopWorkers(ctx, { projectId: p.meta.projectId, force })));
        check(result?.requested === true && typeof result.cleanupPending === 'boolean', 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED');
        if (p.meta.workerStop.generation === generation) p.meta.workerStop = { state: 'requested', generation, cleanupPending: result.cleanupPending };
      } catch (error) { if (p.meta.workerStop.generation === generation) p.meta.workerStop = { state: 'unknown', generation, cleanupPending: true, error: code(error) }; }
      if (state === 'stopping' && p.meta.generation === generation && p.meta.state === 'stopping') p.meta.state = 'stopped';
    }
    await clean; await save(p);
    if (completing && !disposed && !p.failed && p.meta.state === 'completed' && p.meta.generation === generation) {
      p.monitorCompletion = { activation, generation, endedAt };
    }
    return view(p);
  }
  async function pause(args, ctx) { fields(args, ['projectId']); await auth('pause', args, ctx, ['creator', 'main']); const p = get(args.projectId);
    check(p.meta.state !== 'completed', 'MAIN_CONTROL_COMPLETED'); return deactivate(p, 'paused', ctx); }
  async function stop(args, ctx) { fields(args, ['projectId', 'force']); check(args.force === undefined || typeof args.force === 'boolean', 'MAIN_CONTROL_INVALID_INPUT');
    await auth('stop', args, ctx, ['creator', 'main']); const p = get(args.projectId); check(p.meta.state !== 'completed', 'MAIN_CONTROL_COMPLETED'); return deactivate(p, 'stopping', ctx, args.force === true); }
  async function complete(args, ctx) {
    fields(args, ['projectId', 'goalId', 'generation', 'factIds'], ['projectId', 'goalId', 'generation', 'factIds']);
    check(Array.isArray(args.factIds) && args.factIds.length > 0 && args.factIds.length <= 64 && args.factIds.every(id => typeof id === 'string' && FACT.test(id))
      && new Set(args.factIds).size === args.factIds.length, 'MAIN_CONTROL_INVALID_INPUT');
    await auth('complete', args, ctx, ['main']);
    const p = get(args.projectId);
    exactGoal(p, args);
    check(active(p), 'MAIN_CONTROL_INACTIVE');
    // Bound main owns the target decision; this adapter only reads canonical existence.
    const ids = [...args.factIds];
    const result = await bounded(Promise.resolve().then(() => verifyCompletion(ctx, { projectId: args.projectId, factIds: ids })));
    exactGoal(p, args);
    check(active(p), 'MAIN_CONTROL_INACTIVE');
    check(result?.verified === true && result.projectId === p.meta.projectId && Array.isArray(result.factIds)
      && result.factIds.length === ids.length && ids.every(id => result.factIds.includes(id)), 'MAIN_CONTROL_COMPLETION_UNVERIFIED');
    p.meta.completion = { at: now(), factIds: ids };
    return deactivate(p, 'completed', ctx);
  }
  async function status(args, ctx) { fields(args, ['projectId']); await auth('status', args, ctx, ['creator', 'main']);
    check(!damaged.has(args.projectId), 'MAIN_CONTROL_RECORD_INVALID'); return goals.has(args.projectId) ? view(get(args.projectId)) : { projectId: args.projectId, managed: false }; }
  function admit(projectId) {
    check(!disposed && typeof projectId === 'string' && PROJECT.test(projectId), 'MAIN_CONTROL_INVALID_INPUT');
    check(!damaged.has(projectId), 'MAIN_CONTROL_RECORD_INVALID'); const p = goals.get(projectId);
    check(!p || active(p), 'MAIN_CONTROL_WORK_DENIED'); const ticket = Object.freeze({ projectId, goalId: p?.meta.goalId ?? null, generation: p?.meta.generation ?? null });
    tickets.set(ticket, { p, generation: p?.meta.generation }); return ticket;
  }
  function assertAdmission(ticket) {
    const stamp = tickets.get(ticket); check(stamp && goals.get(ticket.projectId) === stamp.p && (!stamp.p || active(stamp.p, stamp.generation)), 'MAIN_CONTROL_WORK_DENIED');
    check(!disposed, 'MAIN_CONTROL_DISPOSED'); return true;
  }
  async function reconcileAlarm(p) {
    const alarm = p.alarm; cancelAlarmCallback(alarm); if (!alarm || alarm.meta.cleanup.removed) return;
    check(!alarm.creating && alarm.meta.id, 'MAIN_CONTROL_SCHEDULE_UNSETTLED');
    const receipt = await bounded(Promise.resolve().then(() => sdk.tasks.getSchedule(alarm.meta.id)));
    if (receipt === null) { alarm.meta.cleanup = { state: 'confirmed', removed: true, scheduleId: alarm.meta.id, error: null }; alarm.meta.id = null; alarm.meta.creation = 'confirmed'; await save(p); return; }
    scheduleReceipt(p, alarm, receipt); await cleanupAlarm(p, alarm);
  }
  await store.mkdir(BASE);
  for (const name of await store.list(BASE)) {
    if (!name.endsWith('.json') || !PROJECT.test(name.slice(0, -5))) continue;
    const projectId = name.slice(0, -5);
    let meta; try { meta = await store.readJson(location(projectId)); validateRecord(meta, projectId); } catch { damaged.add(projectId); continue; }
    const p = wrap(meta); goals.set(projectId, p);
    const intent = meta.restartIntent;
    const candidate = restartAllowed(p) && (meta.state === 'active' || meta.state === 'blocked'
      && meta.error === 'MAIN_CONTROL_DISPOSED' && intent?.priorActive === true && intent.goalId === meta.goalId && intent.generation === meta.generation);
    // Consume once on load. A crash or failed activation must not leave a retry
    // authorization hidden in a stale marker on the next process start.
    delete meta.restartIntent;
    if (meta.state === 'active' || meta.state === 'stopping') { meta.state = 'blocked'; meta.generation++; meta.error = 'MAIN_CONTROL_RESTARTED'; }
    if (candidate) restartCandidates.set(p, { goalId: meta.goalId, generation: meta.generation });
    if (meta.send?.state === 'pending') { meta.send.state = 'unknown'; meta.send.error = 'MAIN_CONTROL_RESTARTED'; }
    meta.waiting = true; meta.continueRequested = false;
    if (budgetExhausted(p)) enterBudgetWait(p);
    await save(p); try { await reconcileAlarm(p); } catch (error) { meta.error ||= code(error); await save(p); }
  }
  const registration = await bounded(sdk.tasks.registerHandler(HANDLER, { run: event => {
    const input = event?.input, p = goals.get(input?.projectId), alarm = p?.alarm;
    if (disposed || event.kind !== 'schedule' || !alarm || !text(event.scheduleId) || input.goalId !== p.meta.goalId
      || input.generation !== alarm.meta.generation || input.token !== alarm.meta.token || alarm.fired
      || !active(p, input.generation)) return { status: 'ignored' };
    // Reserve synchronously, including delivery before the creation receipt.
    alarm.fired = true; alarm.callbackPending = true;
    let cancelled = false, resolveCancelled;
    const cancellation = new Promise(resolve => { resolveCancelled = resolve; });
    alarm.cancelCallback = () => { cancelled = true; alarm.cancelWait?.(); resolveCancelled(); };
    const live = () => !cancelled && p.alarm === alarm && active(p, input.generation);
    const job = Promise.resolve().then(async () => {
      if (!live() || alarm.meta.cleanup.removed) return;
      const observed = await bounded(Promise.race([
        Promise.resolve().then(() => sdk.tasks.getSchedule(event.scheduleId)), cancellation,
      ]));
      if (!live()) return;
      const receipt = scheduleReceipt(p, alarm, observed);
      check(event.scheduleId === receipt.scheduleId, 'MAIN_CONTROL_SCHEDULE_UNCONFIRMED');
      if (!alarm.meta.cleanup.removed) alarm.meta.id = receipt.scheduleId;
      await waitAlarmDeadline(p, alarm, input.generation);
      if (!live()) return;
      await save(p);
      if (!live()) return;
      await cleanupAlarm(p, alarm);
      if (p.alarm !== alarm || !active(p, input.generation)) return;
      // Cleanup/persistence can also span a wallclock correction.
      await waitAlarmDeadline(p, alarm, input.generation);
      if (p.alarm !== alarm || !active(p, input.generation)) return;
      collectDue(p); await save(p);
      if (p.alarm !== alarm || !active(p, input.generation)) return;
      kick(p); await arm(p);
    }).catch(error => { if (p.alarm === alarm && p.meta.generation === input.generation) return block(p, error); }).finally(() => {
      alarm.callbackPending = false; alarm.cancelCallback = null; alarm.cancelWait?.();
      // A delivery can finish while its creation job still owns p.arming.
      if (p.alarm === alarm && active(p, input.generation) && alarm.meta.cleanup.removed && !alarm.creating) arm(p);
    });
    track(p, job); return { status: 'accepted', projectId: p.meta.projectId };
  } }));
  if (registration?.ready) await bounded(registration.ready);
  // No creator context is available here. Only startup candidates and the
  // trusted readonly adapter may authorize a new control epoch.
  function activateRestarts() {
    if (!restartActivation) restartActivation = (async () => {
      const candidates = [...restartCandidates]; restartCandidates.clear();
      for (const [p, { generation, goalId }] of candidates) {
        const current = () => !disposed && !p.failed && p.meta.state === 'blocked'
          && p.meta.generation === generation && p.meta.goalId === goalId;
        if (!current()) continue;
        try {
          check(restartAllowed(p), 'MAIN_CONTROL_RESTART_UNAUTHORIZED');
          check(!p.sendJob && !['pending', 'unknown'].includes(p.meta.send?.state), 'MAIN_CONTROL_SEND_UNSETTLED');
          check(workerStopSettled(p), 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED');
          if (!current()) continue;
          check(!p.arming && (!p.alarm || p.alarm.meta.cleanup.removed && !p.alarm.creating), 'MAIN_CONTROL_CLEANUP_UNCONFIRMED');
          if (budgetExhausted(p)) {
            enterBudgetWait(p); p.meta.error = 'MAIN_CONTROL_CONTINUATION_BUDGET_EXHAUSTED'; await save(p); continue;
          }
          check(typeof recoveryReadiness === 'function', 'MAIN_CONTROL_RECOVERY_UNAVAILABLE');
          const readiness = await bounded(Promise.resolve().then(() => recoveryReadiness({ projectId: p.meta.projectId, main: copy(p.meta.main) })));
          if (!current()) continue;
          check(readiness?.ready === true, 'MAIN_CONTROL_RECOVERY_NOT_READY');
          check(workerStopSettled(p), 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED');
          if (!current()) continue;
          p.meta.generation++; const epoch = p.meta.generation;
          p.meta.state = 'active'; p.meta.error = null; p.meta.waiting = false; p.meta.waitReason = null; p.meta.continueRequested = false;
          collectDue(p);
          if (!p.meta.due.control) p.meta.due.control = { at: now(), generation: epoch, notified: false };
          for (const point of Object.values(p.meta.due)) if (point) { point.generation = epoch; point.notified = false; }
          p.restartGuard = epoch; p.recoveryReview = true; p.endConsumed = true; p.firstSend = true;
          try {
            await save(p);
            if (disposed || p.meta.generation !== epoch || p.meta.state !== 'active') continue;
            await subscribe(p);
            if (disposed || p.meta.generation !== epoch || p.meta.state !== 'active') continue;
            p.ready = true; kick(p); if (p.sendJob) await p.sendJob;
            if (active(p, epoch)) await arm(p);
            markMonitorActivation(p, epoch);
          } catch (error) { if (!disposed && p.meta.generation === epoch && p.meta.state === 'active') await block(p, error); }
        } catch (error) {
          if (current()) { p.meta.error = code(error); await save(p).catch(() => {}); }
        }
      }
      return { activated: true };
    })();
    return restartActivation;
  }
  const actions = { start, resume, status, pause, stop, acknowledge, wait, continue_work, complete };
  function dispose() {
    if (disposal) return disposal;
    disposal = (async () => {
    disposed = true; const errors = [], eligible = [];
    for (const p of goals.values()) {
      cancelAlarmCallback(p.alarm);
      const priorActive = p.meta.state === 'active';
      delete p.meta.restartIntent; restartCandidates.delete(p); p.restartGuard = null;
      p.ready = false; if (priorActive) { p.meta.state = 'blocked'; p.meta.generation++; p.meta.error = 'MAIN_CONTROL_DISPOSED'; }
      let clean = true;
      try { await save(p); await cleanupAlarm(p, p.alarm); } catch (error) { clean = false; errors.push({ code: code(error) }); }
      try { if (p.subscription) await bounded(Promise.resolve().then(() => p.subscription.disposeAsync ? p.subscription.disposeAsync() : p.subscription())); }
      catch (error) { clean = false; errors.push({ code: code(error) }); }
      try { const settled = await bounded(Promise.allSettled([...p.jobs, p.events, p.writes])); clean &&= settled.every(result => result.status === 'fulfilled'); }
      catch (error) { clean = false; errors.push({ code: code(error) }); }
      if (priorActive && restartAllowed(p) && clean && !p.failed && !p.sendJob && !p.arming && !['pending', 'unknown'].includes(p.meta.send?.state)
        && (!p.alarm || p.alarm.meta.cleanup.removed && !p.alarm.creating) && workerStopSettled(p, { disposeCheck: true })) {
        eligible.push({ p, projectId: p.meta.projectId, goalId: p.meta.goalId, generation: p.meta.generation,
          receipt: p.meta.workerStop, scope: p.meta.workerStopScope, main: p.meta.main,
          stamp: JSON.stringify({ receipt: p.meta.workerStop, scope: p.meta.workerStopScope, main: p.meta.main }) });
      }
    }
    try { if (registration?.disposeAsync) await bounded(registration.disposeAsync()); else if (typeof registration === 'function') await bounded(registration()); } catch (error) { errors.push({ code: code(error) }); }
    if (!errors.length) for (const candidate of eligible) {
      const { p, projectId, goalId, generation, receipt, scope, main, stamp } = candidate;
      const current = () => {
        try { return disposed && goals.get(projectId) === p && p.meta.projectId === projectId && p.meta.goalId === goalId
          && p.meta.generation === generation && p.meta.state === 'blocked' && p.meta.error === 'MAIN_CONTROL_DISPOSED'
          && p.meta.workerStop === receipt && p.meta.workerStopScope === scope && p.meta.main === main
          && JSON.stringify({ receipt: p.meta.workerStop, scope: p.meta.workerStopScope, main: p.meta.main }) === stamp
          && restartAllowed(p) && !p.failed && !p.sendJob && !p.arming && !['pending', 'unknown'].includes(p.meta.send?.state)
          && (!p.alarm || p.alarm.meta.cleanup.removed && !p.alarm.creating); }
        catch { return false; }
      };
      // Handler unregistration was asynchronous: neither identity nor live
      // settlement may be borrowed from the earlier eligibility observation.
      if (!current() || !workerStopSettled(p, { disposeCheck: true }) || !current()) continue;
      p.meta.restartIntent = { goalId, generation, priorActive: true };
      try { await save(p); } catch (error) { errors.push({ code: code(error) }); }
    }
    return { disposed: true, errors, cleanupPending: errors.length > 0 || [...goals.values()].some(p => view(p).goalCleanupPending) };
    })();
    return disposal;
  }
  // Trusted backend projection only: no authorization or I/O. The optional
  // stop observer is synchronous, scalar-only and reads loaded memory only.
  function diagnostic(projectId) {
    if (damaged.has(projectId)) return { state: 'invalid', error: { code: 'MAIN_CONTROL_RECORD_INVALID' } };
    const p = goals.get(projectId); if (!p) return null;
    const reconciliation = workerStopReconciliation(p);
    const m = p.meta, candidate = restartCandidates.get(p), intent = m.restartIntent;
    const priorActive = candidate?.goalId === m.goalId && candidate.generation === m.generation
      || intent?.goalId === m.goalId && intent.generation === m.generation && intent.priorActive === true;
    return { state: m.state, generation: m.generation, waitReason: m.waitReason ?? null, workerStopReconciliation: reconciliation,
      error: m.error ? { code: code({ code: m.error }) } : null, budgetExhausted: budgetExhausted(p),
      restartAuthorization: m.restartAuthorization?.resume ?? 'none', priorActive: priorActive ? true : 'unknown',
      sendState: m.send === null ? 'none' : ['pending', 'unknown', 'accepted', 'rejected'].includes(m.send?.state) ? m.send.state : 'unknown',
      cleanupPending: p.failed || m.state !== 'active' && (Boolean(p.sendJob) || Boolean(p.arming)
        || Boolean(p.alarm && (!p.alarm.meta.cleanup.removed || p.alarm.creating))) };
  }
  function monitorLifecycle(projectId) {
    if (disposed || damaged.has(projectId)) return { state: 'unknown' };
    const p = goals.get(projectId);
    if (!p) return null;
    if (p.failed) return { state: 'unknown' };
    const { state, generation, error } = p.meta;
    if (state === 'completed') {
      const stamp = p.monitorCompletion;
      const activation = stamp?.activation;
      if (stamp?.generation === generation && activation === p.monitorActivation && activation.generation === generation - 1
        && !error && !p.sendJob && (p.meta.send === null || p.meta.send?.state === 'accepted')
        && !p.arming && (!p.alarm || p.alarm.meta.cleanup.removed && !p.alarm.creating)
        && workerStopSettled(p) && Number.isSafeInteger(activation.order) && activation.order > 0
        && time(activation.startedAt) && activation.startedAt > 0 && time(stamp.endedAt)
        && stamp.endedAt >= activation.startedAt && stamp.endedAt === p.meta.completion?.at) {
        return { state, terminal: { order: activation.order, startedAt: activation.startedAt, endedAt: stamp.endedAt } };
      }
      return p.monitorCompletionAttempted ? { state, snapshotUnconfirmed: true } : { state };
    }
    if (state === 'paused' || state === 'stopped') {
      const uncertain = error || p.sendJob || ['pending', 'unknown'].includes(p.meta.send?.state) || p.arming
        || p.alarm && (!p.alarm.meta.cleanup.removed || p.alarm.creating) || !workerStopSettled(p);
      return uncertain ? { state, snapshotUnconfirmed: true } : { state };
    }
    if (!active(p) || error || ['unknown', 'rejected'].includes(p.meta.send?.state)
      || p.monitorActivation?.generation !== generation) return { state: 'unknown' };
    return { state: 'active', activation: { order: p.monitorActivation.order } };
  }
  const api = Object.fromEntries(Object.entries(actions).map(([name, fn]) => [name, async (args, ctx) => {
    check(object(args), 'MAIN_CONTROL_INVALID_INPUT'); return fn(copy(args), ctx);
  }]));
  return { ...api, admit, assertAdmission, activateRestarts, diagnostic, monitorLifecycle, dispose,
    async invoke(action, args, ctx) { check(Object.hasOwn(api, action), 'MAIN_CONTROL_INVALID_ACTION'); return api[action](args, ctx); } };
}
