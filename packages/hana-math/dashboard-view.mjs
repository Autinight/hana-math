import { createDashboardRequest, dashboardHeaders } from './dashboard-request.mjs';
import { LIVE_APP, LIVE_PROVIDER, LIVE_TTL, LIVE_CHECK, LIVE_PREPARE, LIVE_COMMIT, LIVE_ROUTE, LIVE_ACTIVATE,
  EPOCH_HEADER, SEQUENCE_HEADER, livePaths, liveStamp, sameLiveStamp, exact, epochId, id, uint } from './ui/dashboard/live-protocol.mjs';

const descriptor = ['documentId', 'clientId', 'viewId', 'expectedRevision'];
const params = ['action', 'projectId', ...descriptor];
const CAP = 64;
const tokenSchema = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[!-~]+$' };
const project = value => typeof value === 'string' && /^project-[a-z0-9][a-z0-9-]{0,59}$/.test(value);
const fail = code => Object.assign(new Error(code), { code });
const reply = (details, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details, isError });
const deny = (code, status) => Response.json({ error: { code } }, { status, headers: dashboardHeaders });
const headers = ['content-length', 'transfer-encoding', 'content-type'];

export function createDashboardView(sdk, projects, { now = () => performance.now() } = {}) {
  // Only public stamp, bounded per-page freshness and the scoped Project reader
  // survive execute(). The original caller and opaque access are never saved.
  const leases = new Map(), observations = new Map();
  let sequence = 0, disposed = false;
  const supported = typeof sdk.documents?.requestView === 'function' && typeof sdk.documents?.read === 'function';

  function invalidate(lease) {
    const { viewId } = lease.stamp;
    if (leases.get(viewId) === lease) {
      leases.delete(viewId);
      changed(viewId);
    }
    clearTimeout(lease.timer);
    lease.finish(false);
    lease.read = null;
    lease.phase = 'invalid';
  }
  function changed(viewId) {
    const observation = observations.get(viewId);
    if (observation) observation.revision++;
  }
  // Per-view observers live only while authorization is in flight. This also
  // catches an absent -> bound -> absent transition without keeping tombstones.
  function observe(viewId) {
    let mark = observations.get(viewId);
    if (!mark) { mark = { revision: 0, waiting: 0 }; observations.set(viewId, mark); }
    mark.waiting++;
    const revision = mark.revision, previous = leases.get(viewId);
    const wasLive = previous && now() < previous.deadline;
    return { previous, check() {
      if (disposed || mark.revision !== revision || leases.get(viewId) !== previous || (wasLive && now() >= previous.deadline))
        throw fail('DASHBOARD_VIEW_REPLACED');
    }, close() { if (--mark.waiting === 0) observations.delete(viewId); } };
  }
  function requireLease(lease) {
    if (disposed || leases.get(lease.stamp.viewId) !== lease) throw fail('DASHBOARD_VIEW_REPLACED');
    if (now() >= lease.deadline) { invalidate(lease); throw fail('DASHBOARD_VIEW_EXPIRED'); }
  }
  function createLease(stamp, projectId) {
    for (const row of leases.values()) if (now() >= row.deadline) invalidate(row);
    const prior = leases.get(stamp.viewId);
    if (prior) invalidate(prior);
    if (leases.size >= CAP || !uint(sequence + 1) || disposed) throw fail('DASHBOARD_VIEW_UNAVAILABLE');
    let finish;
    const activated = new Promise(resolve => { finish = resolve; });
    const lease = { stamp, projectId, seq: ++sequence, deadline: now() + LIVE_TTL, activated, finish, phase: 'preparing', read: null };
    lease.timer = setTimeout(() => invalidate(lease), LIVE_TTL);
    lease.timer.unref?.();
    leases.set(stamp.viewId, lease);
    changed(stamp.viewId);
    return lease;
  }

  async function execute(input) {
    let lease, observation;
    try {
      if (!exact(input, [...params, 'context']) || !['bind', 'unbind'].includes(input.action) || !project(input.projectId)
        || ![input.documentId, input.clientId, input.viewId].every(id) || !uint(input.expectedRevision)) throw fail('DASHBOARD_VIEW_INVALID_INPUT');
      const originalCtx = input.context;
      const document = originalCtx?.document, stamp = liveStamp(document?.context);
      if (!stamp || !document.access || stamp.documentId !== input.documentId || stamp.viewId !== input.viewId) throw fail('DASHBOARD_VIEW_HOST_DENIED');
      if (!supported || typeof projects?.authorizeDashboardView !== 'function') throw fail('DASHBOARD_VIEW_UNAVAILABLE');
      observation = observe(stamp.viewId);
      const scopedRead = await projects.authorizeDashboardView({ projectId: input.projectId }, originalCtx);
      if (typeof scopedRead !== 'function') throw fail('DASHBOARD_VIEW_PROJECT_DENIED');
      observation.check();
      async function ask(method, payload) {
        const result = await sdk.documents.requestView(document.access, { method, payload, expectedRevision: input.expectedRevision });
        if (lease) requireLease(lease); else observation.check();
        if (result?.revision !== input.expectedRevision || !exact(result.data, ['epoch']) || !epochId(result.data.epoch)
          || (result.images !== undefined && (!Array.isArray(result.images) || result.images.length))) throw fail('DASHBOARD_VIEW_BAD_HANDSHAKE');
        return result.data.epoch;
      }
      // Checking the currently visible page does not change it. A failed Host
      // check or a denied Project call cannot replace the existing live lease.
      const epoch = await ask(LIVE_CHECK, undefined);
      const prev = observation.previous;
      if (prev && sameLiveStamp(prev.stamp, stamp) && prev.epoch === epoch && now() < prev.deadline
        && prev.projectId !== input.projectId) throw fail('DASHBOARD_VIEW_UNBIND_REQUIRED');
      observation.check();
      lease = createLease(stamp, input.projectId);
      lease.epoch = epoch;
      if (await ask(LIVE_PREPARE, { seq: lease.seq, action: input.action, epoch }) !== epoch) throw fail('DASHBOARD_VIEW_BAD_HANDSHAKE');
      if (input.action === 'unbind') {
        invalidate(lease);
        return reply({ state: 'unbound' });
      }
      lease.phase = 'offered';
      const done = await ask(LIVE_COMMIT, { seq: lease.seq, epoch,
        remainingMs: Math.max(0, Math.floor(lease.deadline - now())) });
      if (done !== epoch) throw fail('DASHBOARD_VIEW_BAD_HANDSHAKE');
      lease.read = createDashboardRequest(scopedRead);
      lease.phase = 'active';
      lease.finish(true);
      return reply({ state: 'bound', projectId: input.projectId, expiresInMs: Math.max(0, Math.floor(lease.deadline - now())) });
    } catch (error) {
      if (lease) invalidate(lease);
      const errorCode = typeof error?.code === 'string' && /^DASHBOARD_VIEW_[A-Z_]+$/.test(error.code) ? error.code : 'DASHBOARD_VIEW_DENIED';
      return reply({ error: { code: errorCode } }, true);
    } finally { observation?.close(); }
  }

  function route(path, source) {
    return async c => {
      let lease, eligible = false;
      try {
        const req = c.req.raw, url = new URL(req.url);
        if (req.method !== 'GET' || url.pathname !== path || url.search || url.hash || req.body !== null
          || headers.some(name => req.headers.has(name))) return deny('DASHBOARD_VIEW_INVALID_INPUT', 400);
        const ctx = c.get('appRequestContext'), doc = ctx?.document, stamp = liveStamp(doc?.context);
        const epoch = req.headers.get(EPOCH_HEADER), seq = req.headers.get(SEQUENCE_HEADER);
        if (!supported || ctx?.appId !== LIVE_APP || ctx.agentId != null || !stamp || !doc.access || !epochId(epoch)) return deny('DASHBOARD_VIEW_HOST_DENIED', 403);
        lease = leases.get(stamp.viewId);
        if (!lease || !sameLiveStamp(stamp, lease.stamp) || epoch !== lease.epoch || seq !== String(lease.seq))
          return deny('DASHBOARD_VIEW_UNBOUND', 403);
        const activation = path === LIVE_ACTIVATE;
        if (lease.phase !== 'active' && !(activation && lease.phase === 'offered')) return deny('DASHBOARD_VIEW_UNBOUND', 403);
        eligible = true;
        const guard = () => {
          requireLease(lease);
          const stamped = c.get('appRequestContext');
          if (stamped !== ctx || stamped.appId !== LIVE_APP || stamped.agentId != null || req.signal.aborted
            || !sameLiveStamp(liveStamp(stamped.document?.context), lease.stamp)) throw fail('DASHBOARD_VIEW_HOST_DENIED');
        };
        async function hostStillBound() {
          guard();
          // requestView is tool-only. Re-resolve this route's *own* short-lived
          // access through documented read(); discard the marker bytes. This
          // never accepts a path or obtains an access handle from the browser.
          const receipt = await sdk.documents.read(doc.access);
          if (receipt == null || receipt.ok === false || receipt.isError === true || receipt.error) throw fail('DASHBOARD_VIEW_HOST_DENIED');
          guard();
        }
        guard();
        // Only the data-free activation ack can await an offered lease. Every
        // data route refuses it immediately, before touching Project or Host IO.
        if (activation && !await lease.activated) throw fail('DASHBOARD_VIEW_UNBOUND');
        await hostStillBound();
        if (activation) return new Response(null, { status: 204, headers: dashboardHeaders });
        const result = await lease.read(source, guard);
        await hostStillBound();
        guard();
        return result;
      } catch {
        if (eligible) invalidate(lease);
        return deny('DASHBOARD_VIEW_INVALIDATED', 403);
      }
    };
  }

  return Object.freeze({ supported, registerRoutes(app) {
    app.get(LIVE_ACTIVATE, route(LIVE_ACTIVATE));
    for (const source of livePaths) app.get(`${LIVE_ROUTE}${source}`, route(`${LIVE_ROUTE}${source}`, source));
  }, async registerTool() {
    if (!supported) return;
    return sdk.tools.register({ name: 'math_dashboard_view', documentAccess: 'read', view: { providerId: LIVE_PROVIDER },
      description: 'Bind or unbind one visible Hana Math .hanamathboard Preview to a project for up to 15 minutes. Supply documentId, clientId, viewId and expectedRevision from the same current ui_inspect descriptor. Does not run research, return graph data, or authorize another page.',
      parameters: { type: 'object', additionalProperties: false, required: [...params], properties: {
        action: { type: 'string', enum: ['bind', 'unbind'] }, projectId: { type: 'string', pattern: '^project-[a-z0-9][a-z0-9-]{0,59}$' },
        documentId: tokenSchema, clientId: tokenSchema, viewId: tokenSchema, expectedRevision: { type: 'integer', minimum: 0 },
      } }, execute });
  }, dispose() {
    disposed = true;
    for (const lease of leases.values()) invalidate(lease);
  } });
}
