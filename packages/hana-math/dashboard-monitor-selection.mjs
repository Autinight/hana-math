import { validSnapshotName } from './terminal-dashboard-read.mjs';
// Internal lifecycle evidence only. No I/O, creator context, or content capability.
const unknown = Object.freeze({ lifecycle: 'unknown' });
const idle = Object.freeze({ lifecycle: 'idle' });
const unavailable = Object.freeze({ status: 'unavailable' });
const inactive = Object.freeze({ status: 'idle' });
const rank = value => Number.isSafeInteger(value?.order) && value.order > 0 ? value.order : null;
const active = (source, activation) => ({ lifecycle: 'active', source, activation: rank(activation) === null ? null : { order: activation.order } });

const time = value => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
export const validMonitorTerminal = value => rank(value) !== null && time(value.startedAt)
  && time(value.endedAt) && value.endedAt >= value.startedAt;
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);

export function observeProjectLifecycle({ reliable, goal, workers }) {
  if (reliable !== true) return unknown;
  if (goal?.state === 'paused' || goal?.state === 'completed') return { lifecycle: goal.state };
  if (goal?.state === 'stopped') return idle;
  if (goal !== null && goal?.state !== 'active') return unknown;
  if (!Array.isArray(workers) || workers.some(w => !['active', 'idle'].includes(w?.state))) return unknown;
  if (goal) return active('goal', goal.activation); // Waiting for a worker is still a running Goal.
  const running = workers.filter(w => w.state === 'active');
  if (!running.length) return idle;
  if (running.some(w => rank(w.activation) === null)) return active('legacy-worker', null);
  return active('legacy-worker', { order: Math.max(...running.map(w => w.activation.order)) });
}

// Snapshot eligibility is an additional observation, never an upgrade to the
// legacy monitor's active-only contract. On a Goal project only Goal completion
// can qualify, even when one of its workers has independently finished.
export function observeProjectSnapshot(goal, workers) {
  if (goal?.snapshotUnconfirmed === true || workers.some(w => !['active', 'idle'].includes(w.state) || w.snapshotUnconfirmed === true)) return unknown;
  if (workers.some(w => w.state === 'active')) return unknown;
  const candidates = goal?.state === 'completed' ? [goal.terminal].filter(x => x !== undefined)
    : goal === null ? workers.filter(w => w.terminal !== undefined).map(w => w.terminal) : [];
  let terminal;
  for (const evidence of candidates) {
    if (!validMonitorTerminal(evidence)) return unknown;
    if (!terminal || evidence.endedAt > terminal.endedAt) terminal = evidence;
  }
  return terminal ? { lifecycle: 'snapshot', source: goal ? 'goal' : 'legacy-worker',
    activation: { order: terminal.order }, endedAt: terminal.endedAt } : idle;
}

export function createWorkspaceDashboardSelection(observe, activationEpoch, lookupGrant) {
  return createSelection(() => {
    const rows = observe(), eligible = [];
    for (const row of rows) {
      const grant = row.project && lookupGrant(row.project);
      if (grant && typeof grant === 'object' && grant.projectId === row.projectId) eligible.push({ ...row, grant });
    }
    // Keep legacy authorized-active selection unchanged. Only the snapshot
    // fallback examines every project, including non-granted competitors.
    if (eligible.some(row => row.lifecycle === 'active' || row.lifecycle === 'unknown')) return eligible;
    if (rows.some(row => row.lifecycle === 'active' || row.lifecycle === 'unknown' || row.snapshot?.lifecycle === 'unknown')) return [unknown];
    const grants = new Map(eligible.map(row => [row.project, row.grant]));
    return rows.filter(row => row.snapshot?.lifecycle === 'snapshot')
      .map(row => ({ ...row, ...row.snapshot, grant: grants.get(row.project) }));
  }, activationEpoch, true);
}

export function createWorkspaceMonitorSelection(observe, activationEpoch) {
  return createSelection(observe, activationEpoch, false);
}

function createSelection(observe, activationEpoch, allowSnapshots) {
  let issued;
  function refresh() {
    function withoutTicket(result) { issued = undefined; return result; }
    let winner, epoch;
    try {
      epoch = activationEpoch();
      if (!Number.isSafeInteger(epoch) || epoch < 0) return withoutTicket(unavailable);
      const candidates = [], snapshots = [];
      for (const row of observe()) {
        if (row.lifecycle === 'active') candidates.push(row);
        else if (allowSnapshots && row.lifecycle === 'snapshot') snapshots.push(row);
        else if (!['idle', 'paused', 'completed'].includes(row.lifecycle)) return withoutTicket(unavailable);
      }
      if (!candidates.length) {
        if (!snapshots.length) return withoutTicket(inactive);
        const orders = new Set(), ids = new Set();
        let tied = false;
        for (const row of snapshots) {
          const order = rank(row.activation);
          if (!identifier(row.projectId) || !['goal', 'legacy-worker'].includes(row.source) || !time(row.endedAt)
            || order === null || order > epoch || orders.has(order) || ids.has(row.projectId)) return withoutTicket(unavailable);
          orders.add(order); ids.add(row.projectId);
          if (!winner || row.endedAt > winner.endedAt) { winner = row; tied = false; }
          else if (row.endedAt === winner.endedAt) tied = true;
        }
        // Never pass over a revoked latest candidate to try an older snapshot.
        if (tied || !winner.grant) return withoutTicket(unavailable);
      } else if (candidates.length === 1) winner = candidates[0];
      else {
        const orders = new Set();
        for (const row of candidates) {
          const order = rank(row.activation);
          if (order === null || order > epoch || orders.has(order)) return withoutTicket(unavailable);
          orders.add(order);
          if (!winner || order > rank(winner.activation)) winner = row;
        }
      }
      if (rank(winner.activation) > epoch) return withoutTicket(unavailable);
    } catch { return withoutTicket(unavailable); }
    const { project, projectId, source, lifecycle, grant } = winner, order = rank(winner.activation);
    const endedAt = lifecycle === 'snapshot' ? winner.endedAt : undefined;
    const projectName = lifecycle === 'snapshot' && validSnapshotName(winner.projectName) ? winner.projectName : projectId;
    if (!issued || issued.project !== project || issued.projectId !== projectId || issued.source !== source
      || issued.lifecycle !== lifecycle || issued.endedAt !== endedAt || issued.projectName !== projectName || issued.grant !== grant
      || issued.order !== order || issued.epoch !== epoch) {
      issued = { project, projectId, source, lifecycle, endedAt, projectName, grant, order, epoch, ticket: Object.freeze({
        status: 'selected', selection: Object.freeze({}), generation: Symbol('workspace-monitor-generation'),
      }) };
    }
    return issued;
  }
  function current() { const result = refresh(); return result.ticket ?? result; }
  function read(selection, generation, guard) {
    const selected = refresh();
    if (!selected.ticket || selected.ticket.selection !== selection || selected.ticket.generation !== generation || typeof guard !== 'function') return unavailable;
    try {
      const allowed = guard();
      if (allowed !== true) {
        // No asynchronous guard can authorize this read; absorb its eventual rejection.
        if (allowed instanceof Promise) void allowed.catch(() => {});
        return unavailable;
      }
    } catch { return unavailable; }
    if (refresh() !== selected) return unavailable;
    if (selected.lifecycle === 'snapshot') return { status: 'ok', lifecycle: 'snapshot', projectId: selected.projectId,
      endedAt: selected.endedAt, projectName: selected.projectName };
    return { status: 'ok', projectId: selected.projectId, lifecycle: 'active', source: selected.source };
  }
  return Object.freeze({ current, read });
}
