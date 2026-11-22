// Public non-secret vocabulary only. Neither a page stamp nor an epoch grants access.
export const LIVE_APP = 'hana-math';
export const LIVE_PROVIDER = 'app:hana-math/live-dashboard';
export const LIVE_TTL = 15 * 60 * 1000;
export const LIVE_CHECK = 'hana-math.dashboard.check';
export const LIVE_PREPARE = 'hana-math.dashboard.prepare';
export const LIVE_COMMIT = 'hana-math.dashboard.commit';
export const LIVE_ROUTE = '/live-dashboard';
export const LIVE_ACTIVATE = `${LIVE_ROUTE}/activate`;
export const EPOCH_HEADER = 'x-hana-math-page-epoch';
export const SEQUENCE_HEADER = 'x-hana-math-view-sequence';
export const liveChannels = Object.freeze(['conclusion', 'example', 'counterexample', 'proof_attempt', 'plan',
  'direction', 'obstacle', 'dead_end', 'verification', 'elaboration', 'master_guidance']);
export const livePaths = Object.freeze(['/api/overview', '/api/factgraph', '/api/channels', ...liveChannels.map(k => `/api/channel/${k}`)]);
export const id = value => typeof value === 'string' && /^[!-~]{1,256}$/.test(value);
export const uint = value => Number.isSafeInteger(value) && value >= 0;
export const epochId = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
export function exact(value, keys) {
  return value !== null && typeof value === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(k => { const d = Object.getOwnPropertyDescriptor(value, k); return d?.enumerable && Object.hasOwn(d, 'value'); });
}
export function liveStamp(context) {
  if (context?.appId !== LIVE_APP || context.providerId !== LIVE_PROVIDER || !id(context.documentId) || !id(context.viewId)
    || !uint(context.generation) || context.generation === 0 || !Array.isArray(context.capabilities)
    || context.capabilities.length !== 1 || context.capabilities[0] !== 'read') return null;
  return Object.freeze({ appId: LIVE_APP, providerId: LIVE_PROVIDER, documentId: context.documentId,
    viewId: context.viewId, generation: context.generation, capabilities: Object.freeze(['read']) });
}
export const sameLiveStamp = (a, b) => !!a && !!b && a.appId === b.appId && a.providerId === b.providerId
  && a.documentId === b.documentId && a.viewId === b.viewId && a.generation === b.generation;
