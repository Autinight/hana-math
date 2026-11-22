// Internal, closed translation from Danus paths to Project reader selections.
import { livePaths } from './ui/dashboard/live-protocol.mjs';

const routes = new Map(livePaths.map(route => [route, Object.freeze(route.startsWith('/api/channel/')
  ? { view: 'channel', kind: route.slice('/api/channel/'.length) }
  : { view: route.slice('/api/'.length) })]));
export const dashboardSelection = route => routes.get(route);
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
