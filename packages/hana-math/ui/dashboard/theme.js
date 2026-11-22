import { mountDashboard, mountWorkspaceDashboard, repaintDashboardTheme } from './app.js';
import { decodeSnapshot, isReadOnlyPreview, samePreview } from './snapshot.mjs';
import { createLivePage } from './live-page.mjs';
import { createWorkspaceMonitor, WORKSPACE_POLL_INTERVAL_MS, workspaceSdkUnavailable } from './workspace-monitor.mjs';

const PREVIEW_PENDING = '正在读取 Hana 绑定的快照…';
const PREVIEW_UNBOUND = '请在 Hana 中打开 .hanamathgraph 附件。此视图未绑定文档。';
const PREVIEW_UNREADABLE = '无法读取此快照。';
const PREVIEW_INVALID = '快照格式无效或超过 1 MiB，无法显示。';
const CLEAN = { revision: 0, dirty: false, canUndo: false, canRedo: false };

// The ordinary embedding seam never grants a preview binding. The live
// preview acquires its adapter only through the Host-bound page handshake.
let stopSurface;
export function startDashboard(hana, { request, documentPreview = false, livePreview = false, workspaceMonitor = false } = {}) {
  stopSurface?.();
  let generation = 0, unsubscribe, stopData, livePage, currentLink, themeUrl;
  const workspaceOnly = workspaceMonitor && !documentPreview && !livePreview;
  let workspacePageHidden = false;
  function followTheme(snapshot) {
    const root = document.documentElement;
    if (snapshot?.appearance === 'light' || snapshot?.appearance === 'dark') root.style.colorScheme = snapshot.appearance;
    else root.style.removeProperty('color-scheme');
    const next = snapshot?.cssUrl;
    if (typeof next !== 'string' || !next.trim() || themeUrl === next) return;
    themeUrl = next;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = next;
    link.onload = () => { if (link === currentLink) repaintDashboardTheme(); };
    link.onerror = () => { if (link === currentLink) { link.remove(); currentLink = null; themeUrl = null; repaintDashboardTheme(); } };
    currentLink?.remove();
    currentLink = link; document.head.appendChild(link);
  }
  function suspend() {
    generation++;
    unsubscribe?.(); unsubscribe = undefined;
    livePage?.dispose(); livePage = undefined;
    stopData?.(); stopData = undefined;
  }
  async function openSnapshot(id) {
    const active = () => id === generation;
    const notice = text => { if (active()) mountDashboard({ notice: text }); };
    let context;
    try { context = await hana.document.getContext(); }
    catch { notice(PREVIEW_UNREADABLE); return; }
    if (!active()) return;
    if (!isReadOnlyPreview(context)) { notice(PREVIEW_UNBOUND); return; }
    let snapshot, error, readResult;
    try { readResult = await hana.document.read(); }
    catch { error = PREVIEW_UNREADABLE; }
    if (!active()) return;
    if (!error) {
      try { snapshot = decodeSnapshot(readResult); }
      catch { error = PREVIEW_INVALID; }
    }
    try {
      // The identifiers are only a same-view witness; never inputs to read().
      if (!samePreview(context, await hana.document.getContext())) { notice(PREVIEW_UNBOUND); return; }
      if (!active()) return;
      await hana.document.reportStatus(error ? { ...CLEAN, error: {
        code: error === PREVIEW_INVALID ? 'MATH_SNAPSHOT_INVALID' : 'MATH_SNAPSHOT_UNREADABLE', message: error,
      } } : CLEAN);
      if (!active()) return;
      if (error) { notice(error); return; }
      stopData = mountDashboard({ snapshot });
    } catch { notice(PREVIEW_UNREADABLE); }
  }
  function followWorkspaceTheme(id) {
    let snapshot, subscribing = true, readable = false;
    try { snapshot = hana.theme.getSnapshot(); readable = true; } catch { /* Use the default appearance. */ }
    try {
      unsubscribe = hana.theme.subscribe(next => {
        if (id !== generation) return;
        // The SDK can replay the initial theme from inside subscribe(). Keep
        // the default if the initial read failed; later changes still apply.
        if (!subscribing) followTheme(next);
        else if (readable) snapshot = next;
      });
    } catch { /* The theme subscription is optional on this page. */ }
    subscribing = false;
    if (id !== generation) return;
    // Keep renderer errors outside the optional theme SDK error boundaries.
    if (!readable) { currentLink?.remove(); currentLink = null; themeUrl = null; }
    followTheme(snapshot);
  }
  function startWorkspace(id) {
    let monitor, retryTimer, retry = false, wasHidden = document.hidden;
    const workspace = mountWorkspaceDashboard((tab, channel) => monitor?.select(tab, channel));
    workspace.status({ state: 'pending', text: '正在确认研究状态' });
    function cancelRetry() {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    function onVisibility() {
      const hidden = document.hidden, becameVisible = wasHidden && !hidden;
      wasHidden = hidden;
      if (hidden) cancelRetry();
      else if (becameVisible && retry && id === generation) void initialize();
    }
    const stopWatching = () => { cancelRetry(); document.removeEventListener('visibilitychange', onVisibility); };
    document.addEventListener('visibilitychange', onVisibility);
    stopData = () => { stopWatching(); monitor?.dispose(); workspace.dispose(); };
    async function initialize() {
      // Only a settled failure may arm the next attempt. Keep its diagnostic
      // visible until the existing monitor takes over.
      retry = false;
      cancelRetry();
      let ready;
      try { ready = Promise.resolve(hana.ready()); await ready; }
      catch {
        if (id !== generation) return;
        workspace.status(workspaceSdkUnavailable);
        retry = typeof hana.ready === 'function' && typeof hana.api?.fetch === 'function';
        if (retry && !document.hidden) {
          const timer = setTimeout(() => {
            if (retryTimer !== timer) return;
            retryTimer = undefined;
            if (retry && id === generation && !document.hidden) void initialize();
          }, WORKSPACE_POLL_INTERVAL_MS);
          retryTimer = timer;
        }
        return;
      }
      if (id !== generation) return;
      stopWatching(); // The monitor now owns any further visibility changes.
      followWorkspaceTheme(id);
      // The Host's existing App-surface gate authorizes same-origin reads;
      // neither this adapter nor the monitor header grants permission.
      const transport = typeof hana.api?.fetch === 'function' ? {
        ready: () => ready,
        fetch: (path, init) => hana.api.fetch(path, init),
      } : null;
      monitor = createWorkspaceMonitor(transport, workspace, { initialTab: workspace.getTab() });
    }
    return initialize();
  }
  async function start() {
    suspend();
    const id = generation;
    if (workspaceOnly) return startWorkspace(id);
    mountDashboard(documentPreview ? { notice: PREVIEW_PENDING } : undefined);
    try { await Promise.resolve(hana.ready()); }
    catch {
      if (id === generation && documentPreview) mountDashboard({ notice: PREVIEW_UNREADABLE });
      return;
    }
    if (id !== generation) return;
    followTheme(hana.theme.getSnapshot());
    unsubscribe = hana.theme.subscribe(snapshot => { if (id === generation) followTheme(snapshot); });
    if (documentPreview) await openSnapshot(id);
    else if (livePreview) {
      livePage = createLivePage(hana, options => { if (id === generation) stopData = mountDashboard(options); });
      await livePage.start();
    } else if (request) stopData = mountDashboard({ request });
  }
  function hideSurface() { workspacePageHidden = true; suspend(); }
  function resume(event) {
    if (!event.persisted || (workspaceOnly && !workspacePageHidden)) return;
    workspacePageHidden = false;
    void start();
  }
  function checkVisible() { if (!document.hidden) livePage?.check(); }
  window.addEventListener('pagehide', hideSurface);
  window.addEventListener('pageshow', resume);
  if (livePreview) {
    window.addEventListener('focus', checkVisible);
    document.addEventListener('visibilitychange', checkVisible);
  }
  stopSurface = () => {
    suspend();
    window.removeEventListener('pagehide', hideSurface);
    window.removeEventListener('pageshow', resume);
    if (livePreview) {
      window.removeEventListener('focus', checkVisible);
      document.removeEventListener('visibilitychange', checkVisible);
    }
    currentLink?.remove(); currentLink = null;
    document.documentElement.style.removeProperty('color-scheme');
  };
  return start();
}
