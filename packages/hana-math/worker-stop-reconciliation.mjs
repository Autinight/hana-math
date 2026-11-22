// Pure, scalar-only settlement evidence shared by Goal stop diagnostics and doctor.
export const RUN_RESOURCE_FLAGS = Object.freeze(['resourceBlocked', 'taskCreatePending', 'taskSettlementPending', 'schedulePending',
  'cleanupPending', 'runtimeCleanupPending', 'indeterminate', 'finalizing', 'coreTaskCreatePending', 'coreTaskSettlementPending',
  'coordinatorActive', 'recoveryUnsettled']);
const terminal = new Set(['finished', 'failed', 'stopped', 'interrupted']);
const states = new Set(['settled', 'pending', 'unknown']);
const worker = /^worker-[1-4]$/, run = /^run-[a-z0-9][a-z0-9-]{0,59}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const exact = (value, keys) => object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));

export function resourceBlockedFlag(value) {
  if (value === undefined || value === false) return false;
  return object(value) && typeof own(value, 'code') === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(own(value, 'code')) ? true : 'unknown';
}
export function runSettlementState(value) {
  const state = own(value, 'state'), count = own(value, 'pendingMutationCount'), mutation = own(value, 'unsettledMutation');
  if (!terminal.has(state) && !['queued', 'running'].includes(state) || !Number.isSafeInteger(count) || count < 0
    || typeof mutation !== 'boolean' || RUN_RESOURCE_FLAGS.some(key => typeof own(value, key) !== 'boolean')) return 'unknown';
  return !terminal.has(state) || count > 0 || mutation || RUN_RESOURCE_FLAGS.some(key => own(value, key)) ? 'pending' : 'settled';
}
export function combineSettlement(values) {
  return !values.length || values.includes('unknown') ? 'unknown' : values.includes('pending') ? 'pending' : 'settled';
}
// Copy/freeze, never repair or migrate an incomplete or malformed scope.
export function stopScope(value, generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || !exact(value, ['generation', 'targets']) || own(value, 'generation') !== generation) return null;
  const targets = own(value, 'targets');
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 4 || !targets.every(target => exact(target, ['workerId', 'runId', 'complete'])
    && worker.test(own(target, 'workerId')) && (own(target, 'runId') === null || typeof own(target, 'runId') === 'string' && run.test(own(target, 'runId')))
    && typeof own(target, 'complete') === 'boolean') || new Set(targets.map(target => target.workerId)).size !== targets.length
    || new Set(targets.filter(target => target.runId !== null).map(target => target.runId)).size !== targets.filter(target => target.runId !== null).length) return null;
  return Object.freeze({ generation, targets: Object.freeze(targets.map(target => Object.freeze({ workerId: target.workerId, runId: target.runId, complete: target.complete }))) });
}
export function stopObservation(value, projectId, scope) {
  if (!object(value) || own(value, 'projectId') !== projectId) return null;
  const targets = own(value, 'targets');
  if (!Array.isArray(targets) || targets.length !== scope.targets.length) return null;
  const projected = [];
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i], bound = scope.targets[i], reasons = own(target, 'reasons');
    if (own(target, 'workerId') !== bound.workerId || own(target, 'runId') !== bound.runId || !states.has(own(target, 'state'))
      || !Array.isArray(reasons) || target.state !== 'settled' && reasons.length === 0
      || reasons.some(reason => typeof reason !== 'string' || !/^WORKER_STOP_[A-Z0-9_]{1,48}$/.test(reason))) return null;
    projected.push({ workerId: bound.workerId, runId: bound.runId, complete: bound.complete,
      state: bound.complete ? target.state : 'unknown', reasons: bound.complete ? [...reasons] : ['WORKER_STOP_SCOPE_INCOMPLETE'] });
  }
  return projected;
}
