#!/usr/bin/env node
// CORE-FREE executable self-check. Never import host/driver/production or create
// SDKs/projects/seeds. Frozen tiny substitutes only. JSON on stdout; no file writes.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';

const allowed = new Set(['metrics.mjs', 'gates.mjs', 'observations.mjs'].map(name => new URL(name, import.meta.url).href));
const loaded = new Set(), builtins = new Set();
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('node:')) { builtins.add(specifier); return next(specifier, context); }
    const resolved = next(specifier, context);
    assert.ok(allowed.has(resolved.url), `Core-free check disallows dependency ${resolved.url}`);
    return resolved;
  },
  load(url, context, next) {
    if (!url.startsWith('node:')) { assert.ok(allowed.has(url), `Core-free check disallows loading ${url}`); loaded.add(url); }
    return next(url, context);
  },
});
const { telemetry, classification, primaryBridgeMetric, validatePrimaryBridgeMetric, mainApiCompanions, PROTOCOL_REVISION } = await import('./metrics.mjs');
const { createBarrier, acceptDispatch, createRunMonitor, errorRecord, projectedFailure, raceParticipant, selectPrimaryFailure } = await import('./gates.mjs');
const { markRuntimeError, markWrapper, toolFailure, publicRequestId, correlateRequests, windowCounts, disposalReport, combineOutcome } = await import('./observations.mjs');
const cases = []; let assertions = 0;
const eq = (...args) => { assertions++; assert.strictEqual(...args); };
const deep = (...args) => { assertions++; assert.deepStrictEqual(...args); };
const ok = (...args) => { assertions++; assert.ok(...args); };
const throws = (...args) => { assertions++; assert.throws(...args); };
async function sameRejection(promise, error) {
  let timer;
  try {
    const caught = await Promise.race([promise.then(() => { throw new Error('unexpected fulfillment'); }, value => value),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('pure rejection did not propagate promptly')), 1000); })]);
    eq(caught, error);
  } finally { clearTimeout(timer); }
}
async function check(name, body) {
  const started = performance.now(), before = assertions;
  try { await body(); cases.push({ name, passed: true, assertions: assertions - before, duration_ms: performance.now() - started }); }
  catch (error) { cases.push({ name, passed: false, assertions: assertions - before, error: { message: error.message, stack: error.stack } }); }
}
const unhandled = [];
process.on('unhandledRejection', error => unhandled.push(String(error)));
const startedAt = new Date().toISOString();
eq(Number(process.versions.node.split('.')[0]), 26);

await check('RED control: old Proxy violates both frozen call/dispose data descriptors', () => {
  const target = Object.freeze({ call() {}, dispose() {} });
  const before = Object.getOwnPropertyDescriptors(target);
  const old = new Proxy(target, { get(object, property) {
    if (property !== 'call') { const value = Reflect.get(object, property); return typeof value === 'function' ? value.bind(object) : value; }
    return async (...args) => object.call(...args);
  } });
  throws(() => old.call, TypeError); throws(() => old.dispose, TypeError);
  deep(Object.getOwnPropertyDescriptors(target), before); ok(Object.isFrozen(target));
});
await check('GREEN facade: stable functions, original receiver, all argument references and result identity', async () => {
  const binding = { role: 'worker', workerId: 'opaque-worker', runId: 'opaque-run' };
  const args = {}, verification = {}, options = {}, result = {};
  const target = Object.freeze({ async call(...values) {
    eq(this, target); eq(values[0], binding); eq(values[1], 'opaque-operation');
    eq(values[2], args); eq(values[3], verification); eq(values[4], options); return result;
  }, dispose() {} });
  const before = Object.getOwnPropertyDescriptors(target);
  const { wrapCore, samples } = telemetry(() => 'measurement'); const facade = wrapCore(target);
  eq(Object.getPrototypeOf(facade), Object.prototype);
  eq(facade.call, facade.call); eq(facade.dispose, facade.dispose);
  eq(await facade.call(binding, 'opaque-operation', args, verification, options), result);
  eq(samples.length, 1); eq(samples[0].category, 'success');
  deep(Object.getOwnPropertyDescriptors(target), before); ok(Object.isFrozen(target));
});
await check('call synchronous throw and rejected Promise retain the exact Error object', async () => {
  for (const asynchronous of [false, true]) {
    const original = new Error('opaque original call error'); let observed;
    const target = Object.freeze({ call() { if (asynchronous) return Promise.reject(original); throw original; }, dispose() {} });
    const before = Object.getOwnPropertyDescriptors(target);
    const facade = telemetry(() => 'measurement').wrapCore(target, error => { observed = error; });
    await sameRejection(facade.call({ role: 'main', author: 'opaque' }, 'opaque'), original);
    eq(observed, original); deep(Object.getOwnPropertyDescriptors(target), before);
  }
});
await check('dispose preserves receiver/argument references, return/Promise identity and sync/async Error identity', async () => {
  for (const kind of ['value', 'promise', 'throw', 'reject']) {
    const original = new Error('opaque dispose error'), arg = {}, result = {};
    const value = kind === 'promise' ? Promise.resolve(result) : kind === 'reject' ? Promise.reject(original) : result;
    let observed;
    const target = Object.freeze({ call() {}, dispose(...values) {
      eq(this, target); eq(values[0], arg); eq(values[1], original);
      if (kind === 'throw') throw original; return value;
    } });
    const before = Object.getOwnPropertyDescriptors(target);
    const facade = telemetry(() => 'measurement').wrapCore(target, error => { observed = error; });
    if (kind === 'throw') {
      throws(() => facade.dispose(arg, original), error => error === original); eq(observed, original);
    } else {
      const returned = facade.dispose(arg, original); eq(returned, value);
      if (kind === 'reject') { await sameRejection(returned, original); eq(observed, original); }
      else eq(await returned, result);
    }
    deep(Object.getOwnPropertyDescriptors(target), before); ok(Object.isFrozen(target));
  }
});
await check('incomplete barrier: fail immediately rejects ready/release with first original Error; cleanup cannot resolve it', async () => {
  const barrier = createBarrier(5), original = new Error('opaque barrier abort');
  const arrival = barrier.arrive(); eq(barrier.fail(original), original);
  eq(barrier.fail(new Error('later cleanup error')), original);
  await sameRejection(arrival, original); await sameRejection(barrier.ready, original); await sameRejection(barrier.released, original);
  throws(() => barrier.release(), error => error === original);
});
await check('normal barrier: readiness waits for all arrivals, release is separate', async () => {
  const barrier = createBarrier(2); let ready = false, released = false;
  barrier.ready.then(() => { ready = true; }); barrier.released.then(() => { released = true; });
  const one = barrier.arrive(); await Promise.resolve(); eq(ready, false); eq(released, false);
  const two = barrier.arrive(); await Promise.all([one, two]); eq(ready, true); eq(released, false);
  barrier.release(); await barrier.released; eq(released, true); eq(barrier.failure, null);
});
await check('ignored dispatch stays ignored and aborts both gates with code and original receipt', async () => {
  const receipt = { status: 'ignored', runId: 'opaque-run' }, barrier = createBarrier(5);
  let failure; try { acceptDispatch(receipt, barrier); } catch (error) { failure = error; }
  ok(failure); eq(failure.code, 'M01_DISPATCH_NOT_STARTED'); eq(failure.receipt, receipt);
  eq(failure.originalProjection, receipt); eq(receipt.status, 'ignored');
  eq(errorRecord(failure).stack, null); eq(errorRecord(failure).stackStatus, 'not-obtained');
  await sameRejection(barrier.ready, failure); await sameRejection(barrier.released, failure);
});
await check('root task event uses captured same-run original; App Core task failure is not a root failure', async () => {
  const barrier = createBarrier(5), monitor = createRunMonitor(barrier);
  const id = '11111111-1111-1111-1111-111111111111';
  const original = markRuntimeError(Object.assign(new TypeError('opaque factory error'), { requestId: id }), 'core-facade');
  monitor.track('opaque-run', 'root-task'); monitor.dispatch({ status: 'started', runId: 'opaque-run' }); monitor.capture('opaque-run', original);
  monitor.capture('opaque-run', new Error('later error must not replace original'));
  eq(monitor.taskEvent('app-core-task', { status: 'failed', metadata: { researchRunId: 'opaque-run' } }), null);
  eq(barrier.failure, null);
  eq(monitor.taskEvent('root-task', { status: 'failed', error: { runtime: { requestId: id } } }), original);
  eq(errorRecord(original).stack, original.stack);
  await sameRejection(barrier.ready, original); await sameRejection(barrier.released, original);
});
await check('existing failed root receipt aborts promptly; sanitized fallback does not invent underlying stack', async () => {
  const barrier = createBarrier(5), monitor = createRunMonitor(barrier);
  const receipt = { status: 'failed', error: { code: 'OPAQUE_BACKEND_CODE', message: 'OPAQUE_BACKEND_CODE' } };
  monitor.track('opaque-run', 'root-task'); monitor.dispatch({ status: 'started', runId: 'opaque-run' }); const error = monitor.taskEvent('root-task', receipt);
  eq(error.code, 'OPAQUE_BACKEND_CODE'); eq(error.originalProjection, receipt); eq(error.source, 'sanitized-root-task-receipt');
  eq(errorRecord(error).stack, null); eq(errorRecord(error).stackStatus, 'not-obtained');
  ok(errorRecord(error).projectionLimitation.includes('sanitized'));
  await sameRejection(barrier.ready, error); await sameRejection(barrier.released, error);
});
await check('cleanup disables root monitor without overwriting an earlier barrier failure', async () => {
  const barrier = createBarrier(5), monitor = createRunMonitor(barrier), original = new Error('original');
  monitor.track('opaque-run', 'root-task'); monitor.dispatch({ status: 'started', runId: 'opaque-run' });
  monitor.participantFailed('opaque-run', original); monitor.stop();
  eq(monitor.taskEvent('root-task', { status: 'failed', error: 'cleanup failure' }), null);
  eq(barrier.failure, original); await sameRejection(barrier.released, original);
});
await check('tracked fatal participant error aborts both gates before any root terminal event, preserving first failure', async () => {
  const barrier = createBarrier(5), monitor = createRunMonitor(barrier);
  const original = new Error('opaque fatal scripted turn before arrive');
  monitor.track('opaque-run', 'root-task'); monitor.dispatch({ status: 'started', runId: 'opaque-run' });
  eq(monitor.participantFailed('opaque-run', original), original);
  eq(monitor.participantFailed('opaque-run', new Error('later fatal error')), original);
  eq(errorRecord(original).wrapperStack, original.stack);
  await sameRejection(barrier.ready, original); await sameRejection(barrier.released, original);
});
await check('untracked participant errors and ordinary captures do not abort the barrier', async () => {
  const barrier = createBarrier(1), monitor = createRunMonitor(barrier);
  monitor.track('tracked-run', 'root-task'); monitor.dispatch({ status: 'started', runId: 'tracked-run' });
  eq(monitor.participantFailed('untracked-run', new Error('unrelated')), null);
  monitor.capture('tracked-run', new Error('ordinary recoverable observation'));
  eq(barrier.failure, null); eq(barrier.isReleased, false);
  await barrier.arrive(); barrier.release(); await barrier.released; eq(barrier.failure, null);
});
await check('tracked root completed before release rejects both gates and preserves the original receipt', async () => {
  const barrier = createBarrier(2), monitor = createRunMonitor(barrier);
  const receipt = { status: 'completed', result: { opaque: true } };
  monitor.track('opaque-run', 'root-task'); monitor.dispatch({ status: 'started', runId: 'opaque-run' }); const arrival = barrier.arrive();
  const error = monitor.taskEvent('root-task', receipt);
  eq(error.code, 'M01_PARTICIPANT_ENDED_BEFORE_BARRIER'); eq(error.receipt, receipt);
  eq(error.originalProjection, receipt); eq(error.source, 'root-ended-before-barrier');
  eq(errorRecord(error).stack, null); eq(barrier.isReleased, false);
  await sameRejection(arrival, error); await sameRejection(barrier.ready, error); await sameRejection(barrier.released, error);
});
await check('read-only released state allows normal root completion after release', async () => {
  const barrier = createBarrier(1), monitor = createRunMonitor(barrier);
  monitor.track('opaque-run', 'root-task'); monitor.dispatch({ status: 'started', runId: 'opaque-run' }); eq(barrier.isReleased, false);
  eq(Object.getOwnPropertyDescriptor(barrier, 'isReleased').set, undefined);
  throws(() => { barrier.isReleased = true; }, TypeError);
  await barrier.arrive(); barrier.release(); await barrier.released; eq(barrier.isReleased, true);
  eq(monitor.taskEvent('root-task', { status: 'completed', result: 'normal' }), null); eq(barrier.failure, null);
});
await check('cleanup disables fatal participant and early root completion paths', async () => {
  const barrier = createBarrier(1), monitor = createRunMonitor(barrier);
  monitor.track('opaque-run', 'root-task'); monitor.dispatch({ status: 'started', runId: 'opaque-run' }); monitor.stop();
  eq(monitor.participantFailed('opaque-run', new Error('intentional cleanup')), null);
  eq(monitor.taskEvent('root-task', { status: 'completed' }), null);
  eq(monitor.taskEvent('root-task', { status: 'failed' }), null); eq(barrier.failure, null);
  await barrier.arrive(); barrier.release(); await barrier.released; eq(barrier.isReleased, true);
});
await check('independent same UUID links bridge busy with API unknown without changing either classification', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const bridgeError = Object.assign(new Error('opaque'), { code: 'RESEARCH_RUNTIME_REJECTED', coreError: { code: 'busy' } });
  const projection = { code: 'RESEARCH_RUNTIME_REJECTED', runtime: { requestId: id } };
  const apiError = toolFailure(projection);
  const bridge = [{ layer: 'bridge-call', classificationSource: 'bridge-runtime-error-fields', requestId: id, actor: 'main', operation: 'gm_add', phase: 'measurement', category: classification(bridgeError) }];
  const api = [{ layer: 'tool-e2e', classificationSource: 'api-public-error-fields-only', requestId: publicRequestId(apiError), actor: 'main', operation: 'gm_add', phase: 'measurement', category: classification(apiError) }];
  const before = structuredClone({ bridge, api }); const related = correlateRequests(bridge, api);
  eq(bridge[0].category, 'busy'); eq(api[0].category, 'unknown'); eq(publicRequestId(apiError), id);
  eq(related.links.length, 1); eq(related.unlinked.length, 0); deep({ bridge, api }, before);
  eq(errorRecord(apiError).originalProjection, projection);
});
await check('missing, duplicated, mismatched, noncanonical or conflicting IDs stay unlinked', () => {
  const id = '11111111-1111-1111-1111-111111111111', other = '22222222-2222-2222-2222-222222222222';
  const row = { actor: 'main', operation: 'gm_add', phase: 'measurement', requestId: id, category: 'unknown' };
  for (const [bridge, api] of [
    [[row], [{ ...row, requestId: null }]], [[row, row], [row]], [[row], [row, row]],
    [[row], [{ ...row, requestId: other }]], [[row], [{ ...row, actor: 'worker' }]],
    [[row], [{ ...row, requestId: id + 'x' }]],
  ]) {
    const before = structuredClone({ bridge, api }); const result = correlateRequests(bridge, api);
    eq(result.links.length, 0); eq(result.unlinked.length, bridge.length + api.length); deep({ bridge, api }, before);
  }
  eq(publicRequestId(new Error('success/no public error receipt')), null);
});
await check('REJECTED without coreError is unknown even when a message says busy', () => {
  const error = Object.assign(new Error('project is busy'), { code: 'RESEARCH_RUNTIME_REJECTED' });
  eq(classification(error), 'unknown'); eq(classification(toolFailure({ code: error.code, message: error.message })), 'unknown');
});
await check('runtime/wrapper/sanitized origins are distinct, immutable by observation and cannot upgrade API wrappers', () => {
  const original = Object.freeze(Object.assign(new Error('opaque runtime original'), { code: 'RESEARCH_RUNTIME_REJECTED' }));
  const before = Object.getOwnPropertyDescriptors(original);
  eq(markRuntimeError(original, 'core-facade'), original); markWrapper(original, 'later-generic-caught');
  const runtime = errorRecord(original); eq(runtime.stackOrigin, 'original-runtime'); eq(runtime.stack, original.stack); eq(runtime.source, 'core-facade');
  deep(Object.getOwnPropertyDescriptors(original), before); eq(classification(original), 'unknown');
  const projection = { code: 'RESEARCH_RUNTIME_REJECTED', message: 'sanitized' }, wrapper = toolFailure(projection);
  markRuntimeError(wrapper, 'core-facade'); markWrapper(wrapper, 'later-generic-caught');
  const wrapped = errorRecord(wrapper); eq(wrapped.stackOrigin, 'wrapper'); eq(wrapped.stack, null);
  eq(wrapped.wrapperStack, wrapper.stack); eq(wrapped.originalProjection, projection);
  const sanitized = projectedFailure(projection, 'public-backend-fallback'); markRuntimeError(sanitized, 'later-core-caught');
  eq(errorRecord(sanitized).stackOrigin, 'sanitized-projection'); eq(errorRecord(sanitized).stack, null);
  eq(errorRecord(sanitized).wrapperStack, null);
  eq(errorRecord(new Error('unregistered fixture error')).stackOrigin, 'wrapper');
});
await check('primary failure remains the original object while script/cleanup errors remain separate secondary records', () => {
  const primary = markRuntimeError(Object.assign(new Error('opaque busy'), { code: 'RESEARCH_RUNTIME_REJECTED', coreError: { code: 'busy' } }), 'core-facade');
  const script = markWrapper(new Error('script error'), 'scripted-turn'), cleanupError = new Error('real disposal error');
  const report = disposalReport({ serviceResults: { project: { status: 'fulfilled' }, research: { status: 'rejected', reason: cleanupError } },
    scriptResults: [{ status: 'rejected', reason: script }], registryResult: { status: 'fulfilled' }, scriptErrors: [script], subscriptions: 0, handlers: 0 });
  const result = combineOutcome(primary, [report]);
  eq(result.primaryError, primary); eq(result.failure.message, primary.message); eq(result.failure.stackOrigin, 'original-runtime');
  eq(report.scriptErrors.length, 1); eq(report.scripts.rejected, 1); eq(report.cleanupErrors.length, 1);
  eq(result.cleanup.secondary.filter(row => row.kind === 'script-error').length, 1);
  eq(result.cleanup.secondary.filter(row => row.kind === 'cleanup-error').length, 1); eq(result.completed, false);
});
await check('unconfirmed disposal, unknown unsettled state or script-only failure never counts as completed', () => {
  const clean = { serviceResults: { project: { status: 'fulfilled' }, research: { status: 'fulfilled' } },
    registryResult: { status: 'fulfilled' }, scriptResults: [{ status: 'fulfilled' }], subscriptions: 0, handlers: 0 };
  const confirmed = disposalReport(clean); eq(combineOutcome(null, [confirmed]).completed, true);
  const unconfirmed = disposalReport({ ...clean, serviceResults: { ...clean.serviceResults, research: { status: 'fulfilled', value: { confirmed: false } } } });
  eq(unconfirmed.disposed, false); eq(combineOutcome(null, [unconfirmed]).completed, false);
  const unknown = disposalReport({ ...clean, runSnapshots: [{ runId: 'opaque', status: { state: 'stopped', indeterminate: true } }] });
  eq(unknown.unknownUnsettled.length, 1); eq(combineOutcome(null, [unknown]).completed, false);
  const scripted = disposalReport({ ...clean, scriptErrors: [new Error('script failure without resource failure')] });
  eq(scripted.disposed, true); eq(scripted.cleanupErrors.length, 0); eq(combineOutcome(null, [scripted]).completed, false);
  eq(combineOutcome(null, [confirmed], false).completed, false);
});
await check('project mathematicalUnsettled receipt blocks completion independently of resource cleanup and worker snapshots', () => {
  const receipt = { disposed: true, cleanupPending: false, mathematicalUnsettled: true };
  const input = { serviceResults: { project: { status: 'fulfilled', value: receipt }, research: { status: 'fulfilled' } },
    registryResult: { status: 'fulfilled' }, scriptResults: [{ status: 'fulfilled' }], subscriptions: 0, handlers: 0, runSnapshots: [] };
  const report = disposalReport(input), unknown = report.unknownUnsettled[0];
  eq(report.unknownUnsettled.length, 1); eq(unknown.service, 'project'); eq(unknown.source, 'service-dispose-receipt');
  eq(unknown.receipt, receipt); eq(unknown.mathematicalUnsettled, true);
  eq(report.services[0].state, 'settled'); eq(report.services[0].receipt, receipt);
  eq(report.cleanupErrors.length, 0); eq(report.scriptErrors.length, 0); eq(combineOutcome(null, [report]).completed, false);
  const primary = markRuntimeError(new Error('original primary'), 'core-facade'), outcome = combineOutcome(primary, [report]);
  eq(outcome.primaryError, primary); eq(outcome.failure.message, primary.message);
  eq(outcome.cleanup.secondary.filter(row => row.kind === 'unknown-unsettled').length, 1);
  const settledReceipt = { ...receipt, mathematicalUnsettled: false };
  const settled = disposalReport({ ...input, serviceResults: { ...input.serviceResults, project: { status: 'fulfilled', value: settledReceipt } } });
  eq(settled.unknownUnsettled.length, 0); eq(settled.services[0].state, 'settled'); eq(combineOutcome(null, [settled]).completed, true);
  eq(receipt.mathematicalUnsettled, true);
});
await check('within-window and post-window classifications are counted separately without dropping unknown cleanup outcomes', () => {
  const rows = [{ phase: 'measurement', category: 'busy', ended_ms: 10 },
    ...[21, 22, 23].map(ended_ms => ({ phase: 'measurement', category: 'unknown', ended_ms })),
    { phase: 'measurement', category: 'unknown' }];
  const result = windowCounts(rows, { start_ms: 0, end_ms: 20 });
  eq(result.withinWindow.unknown, 0); eq(result.withinWindow.busy, 1); eq(result.afterWindow.unknown, 3); eq(result.unfinished, 1);
});
await check('bridge-v2 all-operation primary population uses nearest-rank over all ended outcome categories', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ layer: 'bridge-call', phase: 'measurement',
    actor: i % 5 === 4 ? 'main:opaque' : `worker:worker-${i % 5 + 1}`, operation: i % 2 ? 'gm_add' : 'fact_search',
    classificationSource: 'bridge-runtime-error-fields', duration_ms: i + 1, ended_ms: 30 + i,
    category: i === 19 ? 'busy' : i === 18 ? 'unknown' : i === 17 ? 'known-refusal' : 'success' }));
  const metric = primaryBridgeMetric(rows, { start_ms: 0, end_ms: 100 });
  eq(metric.protocolRevision, 'm01-bridge-v2'); eq(PROTOCOL_REVISION, metric.protocolRevision); eq(metric.unit, 'ms');
  eq(metric.samples, 20); eq(metric.p50_ms, 10); eq(metric.p95_ms, 19); eq(metric.p99_ms, 20); eq(metric.max_ms, 20);
  deep(metric.categories, { success: 17, busy: 1, 'known-refusal': 1, unknown: 1 });
  deep(validatePrimaryBridgeMetric(metric, ['main:opaque', 'worker:worker-1', 'worker:worker-2', 'worker:worker-3', 'worker:worker-4']), []);
});
await check('primary excludes warmup/outside/unfinished/API rows and artificial cadence wait, with explicit right censoring', () => {
  const row = { layer: 'bridge-call', phase: 'measurement', actor: 'main:opaque', operation: 'gm_add', category: 'success', duration_ms: 7, ended_ms: 10, cadenceWait_ms: 999999 };
  const metric = primaryBridgeMetric([row, { ...row, phase: 'warmup', duration_ms: 10000 },
    { ...row, ended_ms: 101, duration_ms: 20000 }, { ...row, ended_ms: undefined, duration_ms: 30000 },
    { ...row, ended_ms: -1, duration_ms: 40000 }, { ...row, layer: 'tool-e2e', duration_ms: 50000 }], { start_ms: 0, end_ms: 100 }, { rightCensored: true });
  eq(metric.samples, 1); eq(metric.p95_ms, 7); eq(metric.measuredBridgeCalls, 4);
  eq(metric.endedBeforeWindow, 1); eq(metric.endedAfterWindow, 1); eq(metric.unfinished, 1);
  eq(metric.rightCensored, true); ok(metric.interpretation.includes('partial failure window')); eq(metric.capacityDecision, 'not-evaluated');
  const missing = validatePrimaryBridgeMetric(metric, ['main:opaque', 'worker:worker-1']);
  eq(missing.length, 1); eq(missing[0].code, 'M01_PRIMARY_BRIDGE_ACTOR_ZERO'); eq(missing[0].actor, 'worker:worker-1');
});
await check('primary missing window/empty samples stay null and invalid durations invalidate rather than silently shrink population', () => {
  const row = { layer: 'bridge-call', phase: 'measurement', actor: 'main:opaque', operation: 'gm_add', category: 'unknown', duration_ms: 1, ended_ms: 10 };
  const noWindow = primaryBridgeMetric([row], null), empty = primaryBridgeMetric([], { start_ms: 0, end_ms: 100 });
  eq(noWindow.p95_ms, null); eq(noWindow.windowValid, false); eq(noWindow.measuredBridgeCalls, 1); eq(noWindow.endedAfterWindow, null);
  eq(empty.p95_ms, null); eq(empty.samples, 0);
  ok(validatePrimaryBridgeMetric(noWindow, []).some(row => row.code === 'M01_PRIMARY_BRIDGE_NO_WINDOW'));
  ok(validatePrimaryBridgeMetric(empty, []).some(row => row.code === 'M01_PRIMARY_BRIDGE_NO_P95'));
  for (const duration_ms of [NaN, Infinity, -1]) {
    const metric = primaryBridgeMetric([row, { ...row, duration_ms }], { start_ms: 0, end_ms: 100 });
    eq(metric.samples, 2); eq(metric.validSamples, 1); eq(metric.invalid, true); eq(metric.invalidSamples.length, 1);
    eq(metric.p95_ms, null); eq(metric.p50_ms, null); eq(metric.max_ms, null);
    ok(validatePrimaryBridgeMetric(metric, []).some(row => row.code === 'M01_PRIMARY_BRIDGE_INVALID_DURATION'));
  }
});
await check('main API companion compares only identical actor/operation groups, not request pairs or a configuration-wide upper bound', () => {
  const row = (key, p95, samples) => ({ key, grouping: 'operation', endedCalls: samples, latency_ms: { samples, p95 } });
  const bridge = [row('main:opaque/gm_add', 10, 3), row('main:opaque/fact_search', 100, 4), row('worker:worker-1/gm_add', 200, 1), row('main:other/gm_add', 300, 2)];
  const api = [row('main:opaque/gm_add', 15, 2), row('main:opaque/prepare_submission', 20, 1), row('worker:worker-1/gm_add', 500, 1), row('main:different/fact_search', 600, 1)];
  const before = structuredClone({ bridge, api }), companion = mainApiCompanions(bridge, api);
  eq(companion.length, 1); eq(companion[0].actor, 'main:opaque'); eq(companion[0].operation, 'gm_add');
  deep(companion[0].bridge, { samples: 3, endedCalls: 3, p95_ms: 10 }); deep(companion[0].api, { samples: 2, endedCalls: 2, p95_ms: 15 });
  ok(companion[0].interpretation.includes('not request-paired')); ok(companion[0].interpretation.includes('not an upper bound'));
  deep({ bridge, api }, before);
});
await check('after-release fatal rejects continuous signal immediately with the same Error, independent of startup gates', async () => {
  const barrier = createBarrier(1), monitor = createRunMonitor(barrier), original = new Error('released script fatal');
  monitor.track('run', 'root'); monitor.dispatch({ status: 'started', runId: 'run' });
  await barrier.arrive(); barrier.release(); await barrier.released;
  eq(monitor.participantFailed('run', original), original);
  await sameRejection(monitor.participantFailure, original);
  eq(barrier.failure, null); eq(barrier.isReleased, true); eq(monitor.firstFailure.error, original);
});
await check('multiple dispatched runs finish normally after release without fatal signal', async () => {
  const barrier = createBarrier(1), monitor = createRunMonitor(barrier);
  for (const run of ['a', 'b']) { monitor.track(run, `root-${run}`); monitor.dispatch({ status: 'started', runId: run }); }
  await barrier.arrive(); barrier.release();
  eq(monitor.taskEvent('root-a', { status: 'completed' }), null); eq(monitor.taskEvent('root-b', { status: 'completed' }), null);
  const diagnostic = []; eq(await raceParticipant(Promise.resolve('both finished'), monitor, diagnostic), 'both finished');
  eq(monitor.firstFailure, null); eq(diagnostic[0].kind, 'settlement-work-fulfilled');
});
await check('confirmed fatal wins over later settled Assertion and cleanup regardless of secondary arrival order', async () => {
  const barrier = createBarrier(1), monitor = createRunMonitor(barrier), fatal = new Error('fatal original');
  monitor.track('run', 'root'); monitor.dispatch({ status: 'started', runId: 'run' });
  await barrier.arrive(); barrier.release(); monitor.participantFailed('run', fatal);
  const later = new assert.AssertionError({ message: 'later settled assertion' }), secondary = [];
  eq(selectPrimaryFailure(monitor, later, secondary), fatal); eq(secondary.length, 1); eq(secondary[0].kind, 'later-explicit-diagnostic');
  monitor.stop(); eq(monitor.participantFailed('run', new Error('cleanup')), null);
  eq(monitor.taskEvent('root', { status: 'aborted' }), null);
  eq(selectPrimaryFailure(monitor, fatal, secondary), fatal); eq(secondary.length, 1);
  const noFatal = createRunMonitor(createBarrier(1)); eq(selectPrimaryFailure(noFatal, later, []), later);
});
await check('after-release root failure fallback remains sanitized and never borrows unrelated earlier adapter errors', async () => {
  const barrier = createBarrier(1), monitor = createRunMonitor(barrier);
  const runtime = markRuntimeError(Object.assign(new Error('earlier runtime'), { requestId: '11111111-1111-1111-1111-111111111111' }), 'core-facade');
  monitor.track('run', 'root'); monitor.dispatch({ status: 'started', runId: 'run' }); monitor.capture('run', runtime);
  await barrier.arrive(); barrier.release(); const receipt = { status: 'failed', error: { code: 'MODEL_TURN_FAILED' } };
  const failure = monitor.taskEvent('root', receipt);
  ok(failure !== runtime); eq(errorRecord(failure).stackOrigin, 'sanitized-projection'); eq(errorRecord(failure).stack, null);
  eq(errorRecord(failure).originalProjection, receipt); await sameRejection(monitor.participantFailure, failure);
});
await check('only unique same-run independent request evidence can promote an original Runtime Error to fatal primary', async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const runtime = markRuntimeError(Object.assign(new Error('runtime'), { requestId: id, code: 'RESEARCH_RUNTIME_REJECTED', coreError: { code: 'busy' } }), 'core-facade');
  for (const variant of ['unique', 'duplicate', 'other-run', 'missing-public-id']) {
    const barrier = createBarrier(1), monitor = createRunMonitor(barrier);
    monitor.track('run', 'root'); monitor.dispatch({ status: 'started', runId: 'run' }); await barrier.arrive(); barrier.release();
    monitor.capture(variant === 'other-run' ? 'elsewhere' : 'run', runtime);
    if (variant === 'duplicate') monitor.capture('run', markRuntimeError(Object.assign(new Error('second'), { requestId: id }), 'core-facade'));
    const wrapper = toolFailure({ code: 'RESEARCH_RUNTIME_REJECTED', runtime: { requestId: variant === 'missing-public-id' ? null : id } });
    const failure = monitor.participantFailed('run', wrapper);
    eq(failure, variant === 'unique' ? runtime : wrapper); await sameRejection(monitor.participantFailure, failure);
    eq(Boolean(monitor.firstFailure.association), variant === 'unique');
  }
});
await check('admitted but not started, ignored dispatch and recoverable captures never join the persistent participant channel', async () => {
  const barrier = createBarrier(1), monitor = createRunMonitor(barrier), error = new Error('not dispatched');
  monitor.track('run', 'root'); eq(monitor.participantFailed('run', error), null);
  eq(monitor.taskEvent('root', { status: 'failed' }), null);
  monitor.capture('run', error); eq(monitor.firstFailure, null);
  const receipt = { status: 'ignored', runId: 'run' }; throws(() => monitor.dispatch(receipt), e => e.code === 'M01_DISPATCH_NOT_STARTED');
  eq(monitor.firstFailure, null);
  const normalBarrier = createBarrier(1), normal = createRunMonitor(normalBarrier);
  normal.track('run', 'root'); normal.dispatch({ status: 'started', runId: 'run' });
  normal.capture('run', error); eq(normal.firstFailure, null);
});
await check('failure race observes hanging losing work, then explicit bounded cleanup reaps its rejection without unhandled promises', async () => {
  const barrier = createBarrier(1), monitor = createRunMonitor(barrier), fatal = new Error('original fatal');
  monitor.track('run', 'root'); monitor.dispatch({ status: 'started', runId: 'run' }); await barrier.arrive(); barrier.release();
  let rejectWork; const work = new Promise((_, reject) => { rejectWork = reject; }), diagnostics = [];
  const raced = raceParticipant(work, monitor, diagnostics); monitor.participantFailed('run', fatal);
  await sameRejection(raced, fatal); eq(diagnostics.length, 0);
  const late = new Error('losing work ended during cleanup'); rejectWork(late);
  const reaped = await Promise.allSettled([work]); eq(reaped[0].status, 'rejected'); eq(reaped[0].reason, late);
  await Promise.resolve(); eq(diagnostics[0].kind, 'settlement-work-rejected'); eq(monitor.firstFailure.error, fatal);
});
await new Promise(resolve => setImmediate(resolve));
await check('loading boundary and passive catches: no production/host/driver dependencies, no unhandled rejection', () => {
  deep([...loaded].sort(), [...allowed].sort()); deep(unhandled, []);
});
const fail = cases.filter(row => !row.passed).length;
console.log(JSON.stringify({ node: process.version, startedAt, endedAt: new Date().toISOString(),
  kind: 'Core-free fixture contract validation; not rehearsal/capacity evidence',
  coreInstantiated: false, sdkOrProjectsCreated: false, seedExecuted: false, driverImported: false,
  loadedLocalModules: [...loaded], builtinDependencies: [...builtins], cases, pass: cases.length - fail, fail,
  assertions, originalObjectAssertionsExecuted: true, unhandledRejections: unhandled }, null, 2));
process.exitCode = fail ? 1 : 0;
