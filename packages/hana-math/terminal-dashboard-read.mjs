// One in-memory fence per creator grant. No project history is an authorization
// source. Keep a digest (never proof text) across surface hide/reopen and tabs.
export const validTerminalEnd = at => Number.isSafeInteger(at) && at > 0 && at <= 8640000000000000;
export const validSnapshotName = value => typeof value === 'string' && value.length <= 128 && value.isWellFormed()
  && value.trim() === value && value.length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const changed = () => { throw Object.assign(new Error('Terminal dashboard changed'), {code:'PROJECT_DASHBOARD_SNAPSHOT_CHANGED'}); };
// Both Project's main/creator and Research's concurrent workers can publish
// shared data. An absent observer is not evidence of an unchanged project.
export function terminalWriteState(main, workers) {
  // Project's null means no main mutation observed in this process; Research
  // returns a positive zero-counter receipt for a clean project and null for
  // disposed, damaged or unconfirmed ownership. Never conflate these.
  const states = main === null ? [workers] : [main, workers];
  if (states.some(x => !x || typeof x.pending !== 'boolean' || !Number.isSafeInteger(x.endedAt) || x.endedAt < 0)) changed();
  return {pending:states.some(x => x.pending), endedAt:Math.max(0, ...states.map(x => x.endedAt))};
}
export function createTerminalReadFence(writeState) {
  let latest;
  function assert(token) {
    if (!token || token !== latest || token.changed) changed();
    const write = writeState();
    if (write && (write.pending || !Number.isSafeInteger(write.endedAt) || write.endedAt >= token.endedAt)) changed();
  }
  return Object.freeze({
    begin(endedAt) {
      if (!validTerminalEnd(endedAt) || latest && endedAt < latest.endedAt) changed();
      if (latest?.endedAt !== endedAt) latest = { endedAt, revision:null, changed:false };
      assert(latest); return latest;
    },
    assert,
    project(token, selection, result) {
      assert(token);
      const revision = result?.inventoryRevision;
      if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)) changed();
      if (token.revision !== null && token.revision !== revision) { token.changed = true; changed(); }
      token.revision = revision;
      if (selection.view === 'factgraph') return result.graph;
      // Live overview carries its read time; a terminal overview must not look
      // as if the research finished again on every background refresh.
      return selection.view === 'overview' ? {...result.data, updated_at:token.endedAt / 1000} : result.data;
    },
  });
}
