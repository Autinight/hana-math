// Rehearsal telemetry only, never a capacity decision or hard-gate proof.
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

export async function waitAfter(lastEnd) {
  if (lastEnd === undefined) return;
  const earliest = lastEnd + 1000;
  while (performance.now() < earliest) await sleep(Math.ceil(earliest - performance.now()));
}
export const actorOf = binding => binding.role === 'worker' ? `worker:${binding.workerId ?? binding.runId}` : `${binding.role}:${binding.author}`;
export function hasBusyCode(error) {
  return [error?.code, error?.coreError?.code, error?.runtime?.code, error?.runtime?.coreError?.code]
    .some(code => code === 'busy' || typeof code === 'string' && /CORE_BUSY$/.test(code));
}
export function classification(error) {
  const code = error?.coreError?.code ?? error?.runtime?.coreError?.code ?? error?.code ?? 'UNKNOWN';
  // Uncertainty wins even when the underlying refusal also has a busy label.
  if ([error, error?.runtime, error?.coreError, error?.runtime?.coreError].some(value => value?.indeterminate === true
    || value?.mutationState === 'indeterminate'
    || value?.startOutcome === 'unknown' || value?.cleanup?.confirmed === false
    || value?.cleanupPending === true || value?.runtimeCleanupPending === true
    || value?.abortOutcome === 'unconfirmed'
    || value?.processTerminalConfirmed === false && !['not-attempted', 'rejected-before-spawn'].includes(value?.startOutcome))) return 'unknown';
  if (hasBusyCode(error)) return 'busy';
  if (['invalid_input', 'forbidden', 'size_limit', 'capacity_exceeded', 'fact_page_changed', 'invalid_cursor', 'precheck_failed'].includes(code)) return 'known-refusal';
  return 'unknown'; // Never turn a transport failure or unrecognized code into success.
}
export function telemetry(getPhase) {
  const samples = [], lanes = new Map();
  function wrapCore(core, onError = () => {}) {
    const call = async (binding, operation, ...args) => {
        const actor = actorOf(binding), previous = lanes.get(actor) ?? Promise.resolve();
        let release; const completed = new Promise(r => { release = r; }); lanes.set(actor, completed);
        const queued = performance.now(); await previous;
        // Cadence gate only; the original production service queues are untouched.
        const last = lastEnd.get(actor);
        await waitAfter(last);
        const phase = getPhase();
        const sample = { layer: 'bridge-call', actor, binding: structuredClone(binding), operation, phase, warmup: phase === 'warmup',
          started_ms: null, cadenceWait_ms: null, duration_ms: null, category: 'unknown', classificationSource: 'bridge-call-not-ended', requestId: null };
        samples.push(sample);
        try {
          // Primary boundary: metadata preparation and artificial lane/cadence
          // waiting are already done. Only the ORIGINAL Runtime.call is timed.
          sample.started_ms = performance.now();
          const value = await core.call(binding, operation, ...args);
          sample.ended_ms = performance.now();
          sample.category = 'success'; sample.classificationSource = 'bridge-return'; return value;
        } catch (error) {
          sample.ended_ms = performance.now(); // Before classification/diagnostic callbacks.
          sample.category = classification(error); sample.classificationSource = 'bridge-runtime-error-fields'; sample.busyTagged = hasBusyCode(error); sample.code = error?.code ?? null; onError(error); throw error;
        } finally {
          sample.cadenceWait_ms = sample.started_ms - queued;
          sample.duration_ms = sample.ended_ms - sample.started_ms;
          lastEnd.set(actor, sample.ended_ms); release();
        }
    };
    // Plain stable facade: frozen target data descriptors remain completely intact.
    // dispose is deliberately NOT async: preserve the exact return/Promise object.
    const dispose = function (...args) {
      try {
        const value = Reflect.apply(core.dispose, core, args);
        if (value instanceof Promise) value.catch(error => { onError(error); }); // passive observation; return the ORIGINAL Promise
        return value;
      } catch (error) { onError(error); throw error; }
    };
    return { call, dispose };
  }
  const lastEnd = new Map();
  return { samples, wrapCore };
}
const distribution = values => {
  values = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
  return { samples: values.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: values.at(-1) ?? null };
};
export const PROTOCOL_REVISION = 'm01-bridge-v2';
export const PRIMARY_BRIDGE_DESCRIPTION = Object.freeze({
  protocolRevision: PROTOCOL_REVISION, unit: 'ms', quantiles: 'nearest-rank',
  population: 'all actors/operations; measurement bridge calls ended inside the observation window, including success/busy/known-refusal/unknown',
  boundary: 'immediately before original Runtime.call invocation through its awaited return/throw; not end-to-end',
  included: 'Runtime-internal IPC/reservation queues and original call execution/settlement, including software adapter/instrumentation costs inside that call',
  excluded: 'observation lane/artificial >=1000ms cadence wait, outer observation metadata preparation/classification, outer Node FIFO and ResearchService intent/receipt persistence',
  classificationSource: 'each bridge sample own runtime return/error fields; API categories are not copied',
});
export function primaryBridgeMetric(rows, window, { rightCensored = false } = {}) {
  const measured = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.layer === 'bridge-call' && row.phase === 'measurement');
  const windowValid = Boolean(window && Number.isFinite(window.start_ms) && Number.isFinite(window.end_ms) && window.end_ms >= window.start_ms);
  const ended = windowValid ? measured.filter(({ row }) => Number.isFinite(row.ended_ms) && row.ended_ms >= window.start_ms && row.ended_ms <= window.end_ms) : [];
  const invalidSamples = ended.filter(({ row }) => !Number.isFinite(row.duration_ms) || row.duration_ms < 0)
    .map(({ row, index }) => ({ index, actor: row.actor, operation: row.operation, rawDuration: String(row.duration_ms),
      reason: Number.isFinite(row.duration_ms) ? 'negative-duration' : 'non-finite-duration' }));
  // Never silently drop an invalid duration and publish a usable percentile.
  const stats = distribution(invalidSamples.length ? [] : ended.map(({ row }) => row.duration_ms));
  const endedSamplesByActor = {};
  for (const { row } of ended) endedSamplesByActor[row.actor] = (endedSamplesByActor[row.actor] ?? 0) + 1;
  return { ...PRIMARY_BRIDGE_DESCRIPTION, windowValid, samples: ended.length, validSamples: ended.length - invalidSamples.length,
    measuredBridgeCalls: measured.length, invalid: invalidSamples.length > 0, invalidSamples,
    p50_ms: stats.p50, p95_ms: stats.p95, p99_ms: stats.p99, max_ms: stats.max,
    endedSamplesByActor,
    categories: Object.fromEntries(['success', 'busy', 'known-refusal', 'unknown'].map(category => [category, ended.filter(({ row }) => row.category === category).length])),
    classificationSources: [...new Set(ended.map(({ row }) => row.classificationSource ?? null))],
    endedBeforeWindow: windowValid ? measured.filter(({ row }) => Number.isFinite(row.ended_ms) && row.ended_ms < window.start_ms).length : null,
    endedAfterWindow: windowValid ? measured.filter(({ row }) => Number.isFinite(row.ended_ms) && row.ended_ms > window.end_ms).length : null,
    unfinished: measured.filter(({ row }) => !Number.isFinite(row.ended_ms)).length,
    rightCensored, interpretation: rightCensored ? 'partial failure window, right-censored; descriptive p95 is not capacity-gate evidence' : 'descriptive rehearsal only; not a capacity decision',
    capacityDecision: 'not-evaluated' };
}
export function validatePrimaryBridgeMetric(metric, expectedActors) {
  const failures = [];
  if (!metric.windowValid) failures.push({ code: 'M01_PRIMARY_BRIDGE_NO_WINDOW' });
  if (metric.p95_ms === null) failures.push({ code: 'M01_PRIMARY_BRIDGE_NO_P95' });
  if (metric.invalid) failures.push({ code: 'M01_PRIMARY_BRIDGE_INVALID_DURATION', samples: metric.invalidSamples });
  for (const actor of expectedActors) if (!(metric.endedSamplesByActor[actor] > 0)) failures.push({ code: 'M01_PRIMARY_BRIDGE_ACTOR_ZERO', actor });
  return failures;
}
export function mainApiCompanions(bridgeSummary, apiSummary) {
  const main = rows => rows.filter(row => row.grouping === 'operation' && row.key.startsWith('main:') && row.key.includes('/'));
  const bridge = main(bridgeSummary), api = main(apiSummary);
  return bridge.filter(row => bridge.filter(peer => peer.key === row.key).length === 1 && api.filter(peer => peer.key === row.key).length === 1).map(row => {
    const peer = api.find(peer => peer.key === row.key), split = row.key.lastIndexOf('/');
    const values = value => ({ samples: value.latency_ms.samples, endedCalls: value.endedCalls, p95_ms: value.latency_ms.p95 });
    return { actor: row.key.slice(0, split), operation: row.key.slice(split + 1), bridge: values(row), api: values(peer),
      interpretation: 'independent same-actor/same-operation aggregates; not request-paired and not an upper bound for the all-configuration primary metric' };
  });
}
export function summaries(samples, locks, window, grouping = 'operation') {
  const groups = new Map();
  for (const row of samples.filter(s => s.phase === 'measurement')) {
    const key = grouping === 'actor' ? row.actor : row.actor + '/' + row.operation;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row);
  }
  return [...groups].map(([key, rows]) => {
    const ended = rows.filter(r => Number.isFinite(r.ended_ms) && r.ended_ms >= window.start_ms && r.ended_ms <= window.end_ms);
    const successes = ended.filter(r => r.category === 'success').sort((a, b) => a.ended_ms - b.ended_ms);
    const busy = ended.filter(r => r.category === 'busy').length;
    // Actor grouping merges ALL operations. Both variants retain censored window
    // edges (possibly intentional idle time); neither decides starvation/60s gates.
    const points = [window.start_ms, ...successes.map(r => r.ended_ms), window.end_ms];
    const requestIds = new Set(ended.map(r => r.requestId).filter(Boolean));
    const observed = locks.filter(r => requestIds.has(r.requestId));
    return { key, grouping, samples: rows.length, endedCalls: ended.length, unfinishedWithinWindow: rows.length - ended.length,
      success: successes.length, busy, busyRate: ended.length ? busy / ended.length : null,
      busyTaggedEndedCalls: ended.filter(r => r.busyTagged || r.category === 'busy').length,
      knownRefusal: ended.filter(r => r.category === 'known-refusal').length, unknown: ended.filter(r => r.category === 'unknown').length,
      latency_ms: distribution(ended.map(r => r.duration_ms)),
      longestNoSuccessObserved_ms: Math.max(...points.slice(1).map((v, i) => v - points[i])),
      noSuccessWindowIncludesCensoredEdges: true, starvationDecision: 'not-evaluated',
      lockWait_ms: distribution(observed.map(r => r.wait_ms)), lockHold_ms: distribution(observed.map(r => r.hold_ms)),
      busyWithoutAcquire: observed.filter(r => r.firstAttemptNs !== null && r.acquiredNs === null).length };
  });
}
export async function ipcSample(dataDir) {
  const root = path.join(dataDir, 'research/core-calls'); let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return { logicalBytes: 0, reconstructedBytes: 0, directories: 0, incompleteCalls: 0 }; throw e; }
  let logicalBytes = 0, reconstructedBytes = 0, directories = 0, incompleteCalls = 0;
  async function bytes(directory) {
    let total = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) { directories++; total += await bytes(name); }
      else { const info = await fs.lstat(name); if (!info.isFile()) throw new Error('unexpected IPC nonregular entry'); total += info.size; }
    }
    return total;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) throw new Error('unexpected IPC root entry');
    const directory = path.join(root, entry.name); directories++;
    try {
      const actual = await bytes(directory); let complete = false;
      try { const marker = await fs.lstat(path.join(directory, '.complete')); complete = marker.isFile() && marker.size === 0 && (marker.mode & 0o777) === 0o600; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      logicalBytes += actual; reconstructedBytes += complete ? actual : Math.max(2 << 20, actual);
      if (!complete) incompleteCalls++;
    } catch (e) { if (e.code !== 'ENOENT') throw e; } // sampled moving tree; never a high-water proof
  }
  return { logicalBytes, reconstructedBytes, directories, incompleteCalls };
}
