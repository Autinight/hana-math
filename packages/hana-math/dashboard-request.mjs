// Internal, closed translation from Danus paths to Project reader selections.
import { livePaths } from './ui/dashboard/live-protocol.mjs';

const routes = new Map(livePaths.map(route => [route, Object.freeze(route.startsWith('/api/channel/')
  ? { view: 'channel', kind: route.slice('/api/channel/'.length) }
  : { view: route.slice('/api/'.length) })]));
const FACT_ROUTE = /^\/api\/fact\/([0-9a-f]{16})$/;
export const dashboardSelection = route => {
  const fixed = routes.get(route);
  if (fixed) return fixed;
  const match = typeof route === 'string' ? FACT_ROUTE.exec(route) : null;
  return match ? Object.freeze({ view: 'fact', factId: match[1] }) : undefined;
};
export const dashboardHeaders = Object.freeze({ 'cache-control': 'no-store' });

export function createDashboardRequest(read) {
  if (typeof read !== 'function') throw new TypeError('A bound dashboard reader is required');
  return async function request(route, guard = () => {}) {
    const selection = dashboardSelection(route);
    if (!selection) return new Response(null, { status: 404, headers: dashboardHeaders });
    guard();
    const data = await read(selection, guard);
    guard();
    return Response.json(data, { headers: dashboardHeaders });
  };
}
