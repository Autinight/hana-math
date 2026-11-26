import { workspaceProjectBusy } from './dashboard-monitor-transport.mjs';
import { dashboardHeaders, dashboardSelection } from './dashboard-request.mjs';
import { validTerminalEnd, validSnapshotName } from './terminal-dashboard-read.mjs';
import { id, livePaths, LIVE_APP } from './ui/dashboard/live-protocol.mjs';

const PREFIX = '/workspace-monitor';
const GENERATION = 'x-hana-math-monitor-generation';
const unavailable = Object.freeze({ state: 'unavailable' });
const busy = Object.freeze({ state: 'unavailable', reason: 'project_busy' });
const packet = (value = unavailable, status = 200) => Response.json(value, { status, headers: dashboardHeaders });
const generationId = value => id(value) && !value.includes(',');
const projectId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'error');

function scopedUi(stamp) {
  const principal = stamp?.principal;
  // Read only Host middleware's stamp. These literals are minted by
  // app surface authentication in the shipped Host, not caller headers.
  // This proves a same-App surface session on Host-classified local ingress,
  // not a physical connection, exact card ID, or still-mounted page.
  return stamp?.appId === LIVE_APP && stamp.agentId === null && stamp.document === null
    && principal?.kind === 'app' && principal.appId === LIVE_APP
    && principal.credentialKind === 'app_surface_session' && principal.connectionKind === 'local'
    && typeof principal.credentialId === 'string' && principal.credentialId.length > 0;
}

function currentPacket(result) {
  if (result?.state === 'idle' || result?.state === 'unavailable') return packet({ state: result.state });
  // Same epoch-ms bounds as endedAt, but a saved read is not terminal evidence.
  if (result?.state === 'saved' && projectId(result.projectId) && generationId(result.generation) && validTerminalEnd(result.asOf)) {
    return packet({ state: 'saved', projectId: result.projectId, generation: result.generation, asOf: result.asOf });
  }
  if ((result?.state === 'active' || result?.state === 'snapshot' && validTerminalEnd(result.endedAt))
    && projectId(result.projectId) && generationId(result.generation)) {
    return packet({ state: result.state, projectId: result.projectId, generation: result.generation,
      ...(result.state === 'snapshot' && { endedAt: result.endedAt, ...(validSnapshotName(result.projectName) && { projectName: result.projectName }) }) });
  }
  return packet(unavailable, 503);
}

function matchesSelection(selection, data) {
  if (!record(data)) return false;
  switch (selection.view) {
    case 'overview': return ['channel_counts', 'facts_by_author', 'verdicts'].every(key => record(data[key]));
    case 'factgraph': return Array.isArray(data.nodes) && Array.isArray(data.edges);
    case 'fact': return typeof data.id === 'string' && data.id === selection.factId
      && typeof data.statement === 'string' && typeof data.proof === 'string' && Array.isArray(data.predecessors);
    case 'channels': return Array.isArray(data.channels);
    case 'channel': return Array.isArray(data.entries);
    default: return false;
  }
}

export function registerWorkspaceDashboardRoutes(app, dashboard) {
  const FACT_PATH = new RegExp(`^${PREFIX}/api/fact/([0-9a-f]{16})$`);
  function register(path, selection) {
    app.get(path, async c => {
      const request = c.req.raw, signal = request.signal;
      const stamp = c.get('appRequestContext');
      // No session/agent or generation supplied by the browser can grant
      // a reader. The Project service checks generation and grant again at
      // its own admission, dequeue and delivery gates using this guard.
      const guard = () => signal?.aborted === false && c.get('appRequestContext') === stamp && scopedUi(stamp);
      if (!guard()) return packet(unavailable, 403);
      const url = new URL(request.url);
      if (request.method !== 'GET') return packet(unavailable, 405);
      let resolvedSelection = selection;
      if (path === `${PREFIX}/api/fact/:factId`) {
        const match = FACT_PATH.exec(url.pathname);
        if (!match || url.search || request.body !== null) return packet(unavailable, 400);
        resolvedSelection = Object.freeze({ view: 'fact', factId: match[1] });
      } else if (url.pathname !== path || url.search || request.body !== null) {
        return packet(unavailable, 400);
      }
      const generation = request.headers.get(GENERATION);
      if (resolvedSelection ? !generationId(generation) : generation !== null) return packet(unavailable, 400);
      if (typeof dashboard?.current !== 'function' || typeof dashboard?.read !== 'function') return packet(unavailable, 503);
      try {
        const result = resolvedSelection ? await dashboard.read(resolvedSelection, generation, guard) : await dashboard.current(guard);
        if (!guard()) return packet(unavailable, 403);
        if (!resolvedSelection) return currentPacket(result);
        if (result === workspaceProjectBusy) return packet(busy, 409);
        if (result?.state === 'unavailable') return packet(unavailable, 409);
        return matchesSelection(resolvedSelection, result) ? packet(result) : packet(unavailable, 503);
      } catch {
        // Do not serialize reader exceptions, recover data, or fall back to
        // an unbound Project/creator read after a failed guard.
        return packet(unavailable, 409);
      }
    });
  }
  register(`${PREFIX}/current`, null);
  for (const path of livePaths) register(`${PREFIX}${path}`, dashboardSelection(path));
  register(`${PREFIX}/api/fact/:factId`, null);
}
