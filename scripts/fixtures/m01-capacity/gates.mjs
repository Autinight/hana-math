// Pure fixture contracts. No Host, services, Runtime, driver, seed or Core imports.
import { markProjection, errorRecord, canonicalRequestId, publicRequestId } from './observations.mjs';
export { errorRecord } from './observations.mjs';
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {}); // Passive handler only: awaiting the original still rejects.
  return { promise, resolve, reject };
}
export function createBarrier(expected) {
  const ready = gate(), released = gate(); let arrivals = 0, failure = null, wasReleased = false;
  return {
    ready: ready.promise, released: released.promise,
    get failure() { return failure; },
    get isReleased() { return wasReleased; },
    arrive() {
      if (failure) return Promise.reject(failure);
      if (++arrivals === expected) ready.resolve();
      return ready.promise;
    },
    release() {
      if (failure) throw failure;
      if (arrivals !== expected) throw Object.assign(new Error('Fixture barrier not ready'), { code: 'M01_BARRIER_NOT_READY' });
      wasReleased = true; released.resolve();
    },
    fail(error) {
      if (!failure) { failure = error; ready.reject(error); released.reject(error); }
      return failure;
    },
  };
}
export function projectedFailure(projection, source, fallback = 'M01_ROOT_TASK_FAILED') {
  const value = projection?.error ?? projection;
  const code = typeof value?.code === 'string' ? value.code : fallback;
  const message = typeof value?.message === 'string' ? value.message : typeof value === 'string' ? value : code;
  return markProjection(Object.assign(new Error(message), { code, source, originalProjection: projection }), source, projection);
}
export function acceptDispatch(receipt, barrier) {
  if (receipt?.status === 'started') return receipt;
  const error = projectedFailure(receipt, 'dispatch-receipt', 'M01_DISPATCH_NOT_STARTED');
  error.receipt = receipt;
  barrier.fail(error); throw error;
}
export function createRunMonitor(barrier) {
  const roots = new Map(), started = new Set(), originals = new Map(), continuous = gate();
  let active = true, first = null;
  function emit(runId, error, source, association = null) {
    if (!first) {
      first = { runId, error, source, association };
      continuous.reject(error); // Separate from ready/released: remains live AFTER release.
      if (!barrier.isReleased) barrier.fail(error);
    }
    return first.error;
  }
  function linkedRuntime(runId, id) {
    if (!id) return null;
    const matches = (originals.get(runId) ?? []).filter(error => canonicalRequestId(error.requestId) === id && errorRecord(error).stackOrigin === 'original-runtime');
    return matches.length === 1 ? matches[0] : null;
  }
  const participating = runId => active && started.has(runId);
  return {
    participantFailure: continuous.promise,
    get firstFailure() { return first; },
    track(runId, rootTaskId) { roots.set(rootTaskId, runId); },
    capture(runId, error) {
      if (active && runId) {
        if (!originals.has(runId)) originals.set(runId, []);
        if (!originals.get(runId).includes(error)) originals.get(runId).push(error);
      }
      return error; // Recoverable observations NEVER emit fatal failure.
    },
    participantFailed(runId, error) {
      if (!participating(runId)) return null;
      const id = publicRequestId(error);
      const linked = linkedRuntime(runId, id);
      return emit(runId, linked ?? error, 'fatal-script-or-factory', linked ? { requestId: id, evidence: 'same-run unique original Runtime Error and independent public error UUID' } : null);
    },
    taskEvent(taskId, receipt) {
      const runId = roots.get(taskId);
      if (!participating(runId)) return null;
      if (receipt?.status === 'completed') {
        if (barrier.isReleased) return null;
        const error = projectedFailure(receipt, 'root-ended-before-barrier', 'M01_PARTICIPANT_ENDED_BEFORE_BARRIER');
        error.receipt = receipt;
        return emit(runId, error, 'root-completed-before-release');
      }
      if (!['failed', 'canceled', 'aborted'].includes(receipt?.status)) return null;
      const id = canonicalRequestId(receipt?.error?.runtime?.requestId);
      const linked = linkedRuntime(runId, id);
      return emit(runId, linked ?? projectedFailure(receipt, 'sanitized-root-task-receipt'), 'root-terminal-failure', linked ? { requestId: id, evidence: 'same-run unique original Runtime Error and independent root error UUID' } : null);
    },
    dispatch(receipt) {
      const value = acceptDispatch(receipt, barrier);
      if (active && [...roots.values()].includes(value.runId)) started.add(value.runId);
      return value;
    },
    stop() { active = false; },
  };
}
// Installs handlers immediately on both sides. Losing work is NOT canceled or
// forgotten: host.close must bound/reap script jobs and service operations.
export function raceParticipant(work, monitor, diagnostics = []) {
  const observed = Promise.resolve(work);
  observed.then(() => diagnostics.push({ kind: 'settlement-work-fulfilled' }), error => diagnostics.push({ kind: 'settlement-work-rejected', error: errorRecord(error) }));
  return Promise.race([observed, monitor.participantFailure]);
}
export function selectPrimaryFailure(monitor, explicit, secondary) {
  const fatal = monitor.firstFailure;
  if (!fatal) return explicit;
  if (explicit && explicit !== fatal.error) secondary.push({ kind: 'later-explicit-diagnostic', error: errorRecord(explicit) });
  return fatal.error;
}
