import { LIVE_TTL, LIVE_CHECK, LIVE_PREPARE, LIVE_COMMIT, LIVE_ROUTE, LIVE_ACTIVATE, EPOCH_HEADER, SEQUENCE_HEADER,
  livePaths, liveStamp, sameLiveStamp, exact, epochId, id, uint } from './live-protocol.mjs';

const CONNECT = '请回到创建项目的对话，让助手把该项目连到当前看板。';
const UNBOUND = `未绑定项目。${CONNECT}`;
const EXPIRED = `项目绑定已失效或到期。${CONNECT}`;
const UNAVAILABLE = 'Hana 未提供此只读看板所需的文档接口。';
const READY = { revision: 0, dirty: false, canUndo: false, canRedo: false };
const createEpoch = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
const refused = () => new Error('Dashboard view is no longer bound.');

export function createLivePage(hana, show, { epoch = createEpoch(), now = () => performance.now(),
  timer = setTimeout, cancel = clearTimeout } = {}) {
  let disposed = false, stamp = null, sequence = 0, pending, unsubscribe;

  function clear(notice = UNBOUND) {
    const old = pending;
    pending = undefined;
    if (old) { old.abort.abort(); cancel(old.timer); }
    show({ notice });
  }
  async function same() { return sameLiveStamp(stamp, liveStamp(await hana.document.getContext())); }
  function active(entry) { return !disposed && pending === entry && now() < entry.deadline && !entry.abort.signal.aborted; }
  async function current(entry) {
    if (!active(entry) || !await same() || !active(entry)) throw refused();
  }
  function fetchPath(path, entry) {
    return hana.api.fetch(path, { method: 'GET', cache: 'no-store',
      headers: { [EPOCH_HEADER]: epoch, [SEQUENCE_HEADER]: String(entry.seq) }, signal: entry.abort.signal });
  }
  async function request(entry, path) {
    if (!livePaths.includes(path) && !/^\/api\/fact\/[0-9a-f]{16}$/.test(path)) throw refused();
    try {
      await current(entry);
      const response = await fetchPath(`${LIVE_ROUTE}${path}`, entry);
      if (!response.ok) throw refused();
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.hasOwn(data, 'error')) throw refused();
      await current(entry);
      // Only the checked data enters the upstream renderer. It keeps its own
      // mount generation check before applying it to DOM.
      return { ok: true, json: () => { if (!active(entry)) throw refused(); return data; } };
    } catch (error) {
      if (pending === entry) clear(EXPIRED);
      throw error;
    }
  }
  async function activate(entry) {
    try {
      await current(entry);
      if ((await fetchPath(LIVE_ACTIVATE, entry)).status !== 204) throw refused();
      await current(entry);
      show({ request: path => request(entry, path) });
    } catch {
      if (pending === entry) clear(EXPIRED);
    }
  }
  async function onViewRequest(message) {
    const { documentId, viewId, revision, method, payload } = message;
    if (disposed || !stamp || documentId !== stamp.documentId || viewId !== stamp.viewId || revision !== READY.revision) throw refused();
    if (method === LIVE_CHECK) {
      // A Host probe reports the current mount only; it does not clear,
      // extend or otherwise touch the active page or its timer.
      if (payload !== undefined || !await same() || disposed) throw refused();
      return { revision, data: { epoch } };
    }
    if (method === LIVE_PREPARE) {
      if (!exact(payload, ['seq', 'action', 'epoch']) || payload.epoch !== epoch
        || !uint(payload.seq) || payload.seq <= sequence || !['bind', 'unbind'].includes(payload.action)) throw refused();
      const { seq, action } = payload;
      sequence = seq;
      clear();
      const entry = { seq, action, abort: new AbortController(), deadline: now() + LIVE_TTL, committed: false };
      pending = entry;
      entry.timer = timer(() => { if (pending === entry) clear(EXPIRED); }, LIVE_TTL);
      try { await current(entry); } catch (error) { if (pending === entry) clear(EXPIRED); throw error; }
      if (action === 'unbind') clear();
      return { revision, data: { epoch } };
    }
    const entry = pending;
    if (method !== LIVE_COMMIT || !exact(payload, ['seq', 'epoch', 'remainingMs']) || !entry
      || entry.action !== 'bind' || entry.committed || payload.seq !== entry.seq || payload.epoch !== epoch
      || !uint(payload.remainingMs) || payload.remainingMs === 0 || payload.remainingMs > LIVE_TTL) throw refused();
    entry.committed = true;
    entry.deadline = Math.min(entry.deadline, now() + payload.remainingMs);
    cancel(entry.timer);
    entry.timer = timer(() => { if (pending === entry) clear(EXPIRED); }, Math.max(0, entry.deadline - now()));
    try { await current(entry); } catch (error) { if (pending === entry) clear(EXPIRED); throw error; }
    void activate(entry);
    return { revision, data: { epoch } };
  }

  return Object.freeze({ async start() {
    if (disposed) return false;
    clear();
    if (!epochId(epoch) || typeof hana.document?.getContext !== 'function' || typeof hana.document?.onViewRequest !== 'function'
      || typeof hana.document?.reportStatus !== 'function' || typeof hana.api?.fetch !== 'function') { clear(UNAVAILABLE); return false; }
    try {
      stamp = liveStamp(await hana.document.getContext());
      if (disposed || !stamp || !id(stamp.viewId)) return false;
      await hana.document.reportStatus(READY);
      if (disposed || !await same() || disposed) return false;
      unsubscribe = hana.document.onViewRequest(onViewRequest);
      return true;
    } catch { if (!disposed) clear(UNAVAILABLE); return false; }
  }, check() {
    const entry = pending;
    if (entry) void current(entry).catch(() => { if (pending === entry) clear(EXPIRED); });
  }, dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    clear();
  } });
}
