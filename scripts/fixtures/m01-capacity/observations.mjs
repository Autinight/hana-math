// Pure observation helpers: no production, Host, driver, process or filesystem use.
const origins = new WeakMap();
export function markRuntimeError(error, source) {
  if (error && typeof error === 'object' && !origins.has(error)) origins.set(error, { kind: 'original-runtime', source });
  return error; // Never mutate/replace a Runtime Error, including a frozen one.
}
export function markWrapper(error, source, projection = null) {
  if (error && typeof error === 'object' && !origins.has(error)) origins.set(error, { kind: 'wrapper', source, projection });
  return error;
}
export function markProjection(error, source, projection) {
  origins.set(error, { kind: 'sanitized-projection', source, projection }); return error;
}
export function toolFailure(projection) {
  const error = new Error(typeof projection?.message === 'string' ? projection.message : JSON.stringify(projection));
  // Do not let a projected stack overwrite the stack of this newly made wrapper.
  for (const [key, value] of Object.entries(projection ?? {})) if (key !== 'stack') error[key] = value;
  return markWrapper(error, 'public-tool-error-wrapper', projection);
}
export function errorRecord(error) {
  const origin = error && typeof error === 'object' ? origins.get(error) : null;
  const kind = origin?.kind ?? 'wrapper', source = origin?.source ?? 'fixture-or-unregistered-error';
  return { code: error?.code ?? null, message: error?.message ?? String(error), source,
    stackOrigin: kind, stack: kind === 'original-runtime' ? error?.stack ?? null : null,
    wrapperStack: kind === 'wrapper' ? error?.stack ?? null : null,
    stackStatus: kind === 'original-runtime' ? 'captured-original-runtime' : kind === 'wrapper' ? 'wrapper-stack' : 'not-obtained',
    originalProjection: origin?.projection ?? error?.originalProjection ?? null,
    projectionLimitation: kind === 'sanitized-projection' ? 'sanitized backend/public projection; underlying stack not obtained' : null };
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const canonicalRequestId = value => typeof value === 'string' && UUID.test(value) ? value : null;
export function publicRequestId(error) {
  const origin = error && typeof error === 'object' ? origins.get(error) : null;
  // Only this API's retained public error projection, NEVER bridge telemetry.
  return origin?.source === 'public-tool-error-wrapper' ? canonicalRequestId(origin.projection?.runtime?.requestId) : null;
}
export function correlateRequests(bridge, api) {
  const index = rows => {
    const map = new Map(); rows.forEach((row, i) => { const id = canonicalRequestId(row.requestId); if (id) { if (!map.has(id)) map.set(id, []); map.get(id).push(i); } }); return map;
  };
  const left = index(bridge), right = index(api), links = [], unlinked = [];
  const reason = (row, own, other, opposite) => {
    const id = canonicalRequestId(row.requestId);
    if (!id) return 'missing-or-noncanonical-id';
    if ((own.get(id)?.length ?? 0) !== 1 || (other.get(id)?.length ?? 0) > 1) return 'duplicate-or-ambiguous-id';
    if (!other.has(id)) return 'no-same-id-counterpart';
    const peer = opposite[other.get(id)[0]];
    if (row.actor !== peer.actor || row.operation !== peer.operation || row.phase !== peer.phase) return 'conflicting-independent-metadata';
    return null;
  };
  bridge.forEach((row, i) => {
    const why = reason(row, left, right, api);
    if (why) unlinked.push({ layer: 'bridge-call', index: i, requestId: row.requestId ?? null, reason: why });
    else links.push({ requestId: row.requestId, bridgeIndex: i, apiIndex: right.get(row.requestId)[0], meaning: 'association only; classifications unchanged' });
  });
  api.forEach((row, i) => { const why = reason(row, right, left, bridge); if (why) unlinked.push({ layer: 'tool-e2e', index: i, requestId: row.requestId ?? null, reason: why }); });
  return { links, unlinked };
}
export function windowCounts(rows, window) {
  const measured = rows.filter(row => row.phase === 'measurement');
  const count = values => ({ samples: values.length, ...Object.fromEntries(['success', 'busy', 'known-refusal', 'unknown'].map(kind => [kind, values.filter(row => row.category === kind).length])) });
  return { withinWindow: window ? count(measured.filter(row => Number.isFinite(row.ended_ms) && row.ended_ms >= window.start_ms && row.ended_ms <= window.end_ms)) : null,
    afterWindow: window ? count(measured.filter(row => Number.isFinite(row.ended_ms) && row.ended_ms > window.end_ms)) : null,
    unfinished: measured.filter(row => !Number.isFinite(row.ended_ms)).length };
}
const unconfirmed = value => value === false || value?.confirmed === false || value?.cleanupPending === true || value?.runtimeCleanupPending === true || value?.indeterminate === true || value?.startOutcome === 'unknown' || value?.abortOutcome === 'unconfirmed';
export function disposalReport({ serviceResults, scriptResults, registryResult, scriptErrors = [], subscriptions, handlers, runSnapshots = [], cleanupErrors = [] }) {
  const services = Object.entries(serviceResults).map(([service, result]) => ({ service, state: result.status === 'rejected' ? 'failed' : unconfirmed(result.value) ? 'unconfirmed' : 'settled',
    receipt: result.status === 'fulfilled' ? result.value ?? null : null,
    confirmation: result.status === 'fulfilled' && result.value === undefined ? 'promise-fulfilled-no-structured-receipt' : 'settled-result',
    error: result.status === 'rejected' ? errorRecord(result.reason) : null }));
  services.push({ service: 'registration', state: registryResult.status === 'rejected' ? 'failed' : unconfirmed(registryResult.value) ? 'unconfirmed' : 'settled',
    error: registryResult.status === 'rejected' ? errorRecord(registryResult.reason) : null });
  const originals = [...new Set([...scriptErrors, ...scriptResults.filter(row => row.status === 'rejected').map(row => row.reason)])];
  const unknownUnsettled = runSnapshots.filter(row => !row.status || ['queued', 'running'].includes(row.status.state) || unconfirmed(row.status) || row.status.coordinatorActive === true || row.status.finalizing === true
    || row.status.coreTaskCreatePending === true || row.status.coreTaskSettlementPending === true || row.status.recoveryUnsettled === true || row.status.candidateSettlement?.pending === true);
  unknownUnsettled.push(...Object.entries(serviceResults)
    .filter(([, result]) => result.status === 'fulfilled' && result.value?.mathematicalUnsettled === true)
    .map(([service, result]) => ({ service, source: 'service-dispose-receipt', mathematicalUnsettled: true, receipt: result.value })));
  const errors = [...cleanupErrors.map(errorRecord), ...services.filter(row => row.state !== 'settled').map(row => ({ service: row.service, state: row.state, error: row.error }))];
  if (subscriptions !== 0 || handlers !== 0) errors.push({ source: 'registrations-not-released', subscriptions, handlers });
  return { disposed: errors.length === 0 && unknownUnsettled.length === 0, services,
    scripts: { total: scriptResults.length, fulfilled: scriptResults.filter(row => row.status === 'fulfilled').length, rejected: scriptResults.filter(row => row.status === 'rejected').length },
    scriptErrors: originals.map(errorRecord), cleanupErrors: errors, unknownUnsettled, subscriptions, handlers };
}
export function combineOutcome(primaryError, reports, normalPathComplete = true) {
  const secondary = reports.flatMap((report, index) => [
    ...(report.scriptErrors ?? []).map(error => ({ report: index, kind: 'script-error', error })),
    ...(report.cleanupErrors ?? []).map(error => ({ report: index, kind: 'cleanup-error', error })),
    ...(report.unknownUnsettled ?? []).map(status => ({ report: index, kind: 'unknown-unsettled', status })),
    ...(report.disposed !== true && !(report.cleanupErrors?.length || report.unknownUnsettled?.length) ? [{ report: index, kind: 'disposal-not-confirmed' }] : []),
  ]);
  return { primaryError, failure: primaryError ? errorRecord(primaryError) : null,
    cleanup: { reports, secondary }, completed: normalPathComplete && !primaryError && reports.length > 0 && secondary.length === 0 && reports.every(report => report.disposed === true) };
}
