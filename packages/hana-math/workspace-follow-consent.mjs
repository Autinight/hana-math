import { createHash, randomBytes } from 'node:crypto';
import { exact } from './ui/dashboard/live-protocol.mjs';

const FIELD = 'workspaceFollow', SCHEMA = 1;
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);

// Hash the original setup/creator and (for opt-in) the project-main binding.
// Neither the caller's Host token nor paths or model text enter the record.
export function workspaceFollowBinding(meta, mainIdentity) {
  return createHash('sha256').update(JSON.stringify(['hana-math:workspace-follow:v1', meta.projectId,
    meta.creator.sessionId, meta.creator.sessionPath, meta.taskId, ...mainIdentity.map(key => meta.main[key])])).digest('hex');
}

export function createWorkspaceFollowConsent({ binding, authorize, save, changed }) {
  const queues = new WeakMap(), unavailable = new WeakMap();
  function observe(p) {
    const pending = unavailable.get(p);
    if (pending) return { state: 'invalid', stamp: pending, archiveEpoch: pending };
    if (!Object.hasOwn(p.meta, FIELD)) return { state: 'absent', stamp: null, archiveEpoch: null };
    const record = p.meta[FIELD];
    if (exact(record, ['schemaVersion', 'enabled', 'binding', 'stamp', 'archiveEpoch']) && record.schemaVersion === SCHEMA
      && typeof record.enabled === 'boolean' && hex(record.binding, 64) && hex(record.stamp, 32)
      && (record.archiveEpoch === record.stamp || record.enabled && record.archiveEpoch === null)) {
      try {
        if (record.binding === binding(p, record.enabled) || !record.enabled && record.binding === binding(p, true)) {
          return { state: record.enabled ? 'enabled' : 'disabled', stamp: record.stamp, archiveEpoch: record.archiveEpoch };
        }
      } catch { /* a missing or replaced identity cannot confer consent */ }
    }
    return { state: 'invalid', stamp: 'invalid', archiveEpoch: 'invalid' };
  }
  function set(p, enabled, ctx) {
    const one = async () => {
      const { guard, recheck } = await authorize(p, ctx, enabled);
      guard();
      const result = Object.freeze({ projectId: p.meta.projectId, enabled });
      const { state } = observe(p);
      if (state === (enabled ? 'enabled' : 'disabled')) {
        if (enabled) changed(p, true); // Re-select with the same confirmed policy, without writing.
        return result;
      }
      // Non-secret generation tag. Only the first opt-in preserves an already
      // valid legacy archive; revocation/re-consent must never make it valid again.
      const stamp = randomBytes(16).toString('hex');
      const archiveEpoch = enabled && state === 'absent' ? null : stamp;
      const record = Object.freeze({ schemaVersion: SCHEMA, enabled, binding: binding(p, enabled), stamp, archiveEpoch });
      unavailable.set(p, stamp);
      changed(p, false); // Retire synchronously, before making any new policy observable.
      // The writer stores the new field only with a confirmed write. A refused
      // write or a changed identity leaves this instance invalid, never enabled.
      await save(p, record, guard, recheck);
      unavailable.delete(p);
      changed(p, enabled);
      return result;
    };
    const job = (queues.get(p) ?? Promise.resolve()).then(one, one);
    queues.set(p, job);
    job.finally(() => { if (queues.get(p) === job) queues.delete(p); }).catch(() => {});
    return job;
  }
  return Object.freeze({ set, getState: p => observe(p).state, getStamp: p => observe(p).stamp, getArchiveStamp: p => observe(p).archiveEpoch });
}
