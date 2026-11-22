import { randomUUID } from 'node:crypto';
import { validTerminalEnd, validSnapshotName } from './terminal-dashboard-read.mjs';
import { types } from 'node:util';
import { createDashboardRequest, dashboardHeaders, dashboardSelection } from './dashboard-request.mjs';
import { livePaths } from './ui/dashboard/live-protocol.mjs';

const PREFIX = '/workspace-monitor';
const GENERATION = 'x-hana-math-monitor-generation';
const routes = new Map(livePaths.map(path => [dashboardSelection(path), path]));
const unavailable = Object.freeze({ state: 'unavailable' });
const idle = Object.freeze({ state: 'idle' });
const refused = () => Object.assign(new Error('Workspace monitor unavailable'), { code: 'WORKSPACE_MONITOR_UNAVAILABLE' });
const response = (value, status = 200) => Response.json(value, { status, headers: dashboardHeaders });
const opaque = value => value !== null && typeof value === 'object' && !types.isPromise(value);
function synchronous(value) {
  if (!types.isPromise(value)) return value;
  Promise.prototype.then.call(value, undefined, () => {});
  throw refused();
}
function check(condition) { if (!condition) throw refused(); }

// Internal only; use one instance per trusted delivery channel. The App
// supplies an already-granted, project-bound reader; selection is never a grant. lookupReader must return the same grant object
// until revoked, and must not reissue an old object on regrant. No SDK caller
// context or public route is accepted or constructed here.
export function createWorkspaceDashboard({ workspaceMonitor, lookupReader } = {}) {
  let scope;
  function observe(guard) {
    const clear = state => { scope = undefined; return state; };
    try {
      check(typeof guard === 'function' && synchronous(guard()) === true && typeof lookupReader === 'function');
      const ticket = workspaceMonitor.current();
      if (ticket.status !== 'selected') return clear(ticket.status === 'idle' ? idle : unavailable);
      const selected = workspaceMonitor.read(ticket.selection, ticket.generation, guard);
      const snapshot = selected?.lifecycle === 'snapshot';
      check(selected?.status === 'ok' && (snapshot ? validTerminalEnd(selected.endedAt) : selected.lifecycle === 'active')
        && typeof selected.projectId === 'string');
      const grant = synchronous(lookupReader(selected.projectId));
      check(opaque(grant) && grant.projectId === selected.projectId);
      const reader = snapshot ? grant.readSnapshot : grant.read;
      check(typeof reader === 'function');
      const latest = workspaceMonitor.current();
      check(synchronous(guard()) === true && latest.status === 'selected'
        && latest.selection === ticket.selection && latest.generation === ticket.generation);
      const projectName = snapshot && validSnapshotName(selected.projectName) ? selected.projectName : undefined;
      if (scope?.ticket !== ticket || scope.grant !== grant || scope.reader !== reader || scope.summary.state !== selected.lifecycle
        || (snapshot && (scope.summary.endedAt !== selected.endedAt || scope.summary.projectName !== projectName))) {
        scope = { ticket, grant, reader, summary: Object.freeze({ state: selected.lifecycle, projectId: selected.projectId, generation: randomUUID(),
          ...(snapshot && { endedAt: selected.endedAt }), ...(projectName && { projectName }) }) };
      }
      return scope.summary;
    } catch { return clear(unavailable); }
  }
  async function read(selection, generation, guard) {
    // Only the canonical selection returned by dashboardSelection(path) is accepted.
    const path = routes.get(selection);
    if (!path) return unavailable;
    const current = observe(guard), selected = scope;
    if (!selected || generation !== current.generation) return unavailable;
    const recheck = () => {
      check(observe(guard) === current && scope === selected);
      return true;
    };
    try {
      // createDashboardRequest supplies the closed Danus selection and passes
      // this guard into the creator reader's own FIFO, launch and delivery gates.
      const reader = selected.reader;
      const packet = await createDashboardRequest(current.state === 'snapshot'
        ? (view, guard) => reader(view, guard, current.endedAt) : reader)(path, recheck);
      recheck();
      const data = await packet.json();
      recheck();
      return data;
    } catch { return unavailable; }
  }
  return Object.freeze({ current: observe, read });
}

// In-process integration seam for an eventual trusted host channel. Only the
// backend composition root can supply channel.current(); request data cannot.
// It must return an opaque current-binding object (null when unavailable),
// never reused across replacement/revocation. This is not a Hana API shim or
// proof that a normal App route has such a binding. There is no default channel.
export function createWorkspaceMonitorTransport(dashboard, channel) {
  let bound, disposed = false;
  function channelBinding() { return synchronous(channel?.current?.()); }
  function guard() { return !disposed && opaque(bound) && channelBinding() === bound; }
  return Object.freeze({
    async ready() {
      check(!disposed);
      const next = channelBinding();
      check(opaque(next) && (bound === undefined || bound === next));
      bound = next;
      check(guard());
    },
    async fetch(path, options) {
      try {
        if (!opaque(options) || Reflect.ownKeys(options).some(key => !['method', 'cache', 'signal', 'headers'].includes(key))) return response(unavailable, 400);
        const { method, signal, headers } = options;
        const active = () => !signal?.aborted && guard();
        check(active());
        if (method !== 'GET' || typeof path !== 'string' || !path.startsWith(PREFIX + '/')) return response(unavailable, 400);
        const route = path.slice(PREFIX.length), input = new Headers(headers);
        if (route === '/current') {
          if ([...input].length) return response(unavailable, 400);
          const current = dashboard.current(active);
          check(active());
          return response(current);
        }
        if ([...input].length !== 1 || !input.has(GENERATION)) return response(unavailable, 400);
        const selection = dashboardSelection(route);
        if (!selection) return response(unavailable, 404);
        const generation = input.get(GENERATION);
        const data = await dashboard.read(selection, generation, active);
        check(active() && data !== unavailable && dashboard.current(active).generation === generation);
        return response(data);
      } catch { return response(unavailable, 403); }
    },
    dispose() {
      if (disposed) return;
      disposed = true; bound = undefined;
      dashboard.current(() => false); // Retire the pending selection and release the captured grant.
    },
  });
}
