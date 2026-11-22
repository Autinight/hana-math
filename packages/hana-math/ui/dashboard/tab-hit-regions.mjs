const TAB = '.header-nav > button.nav-link[data-tab]';
const MAX_COORDINATE = 1_000_000;

function measure(buttons, view) {
  const regions = [];
  for (const button of buttons) {
    if (!button.isConnected || button.disabled || button.hidden) continue;
    if (typeof button.checkVisibility === 'function') {
      if (!button.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
    } else {
      const style = view.getComputedStyle(button);
      if (style.visibility !== 'visible' || style.display === 'none' || style.opacity === '0') continue;
    }
    const { x, y, width, height } = button.getBoundingClientRect();
    if (![x, y, width, height].every(n => Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE)
        || width <= 0 || height <= 0 || x >= view.innerWidth || y >= view.innerHeight
        || x + width <= 0 || y + height <= 0) continue;
    // The Host clips these exact iframe-viewport bounds to its titlebar and visible window.
    regions.push({ x, y, width, height });
  }
  return regions;
}

function observeTabs(header, view, surface) {
  const doc = header.ownerDocument;
  const buttons = [...header.querySelectorAll(TAB)];
  let frame = null, pending = false, dirty = false, stopped = false;
  let applied = false, sentNonEmpty = false;
  let last = '[]';

  function schedule() {
    if (stopped) return;
    dirty = true;
    if (!pending && frame === null) frame = view.requestAnimationFrame(flush);
  }
  async function flush() {
    frame = null;
    if (stopped) return;
    dirty = false;
    const regions = measure(buttons, view);
    const key = JSON.stringify(regions);
    if (key === last) return;
    last = key;
    pending = true;
    sentNonEmpty = regions.length > 0;
    let receipt;
    try { receipt = await surface.setInteractiveRegions(regions); } catch { /* unavailable */ }
    pending = false;
    if (stopped) return;
    // On refusal, do not probe this surface again on each layout change.
    if (receipt?.applied !== true) { stop(); return; }
    applied = sentNonEmpty;
    if (dirty) schedule();
  }

  const resize = typeof view.ResizeObserver === 'function' && new view.ResizeObserver(schedule);
  for (const element of [header, ...buttons]) if (resize) resize.observe(element);
  const mutations = typeof view.MutationObserver === 'function' && new view.MutationObserver(schedule);
  if (mutations) {
    mutations.observe(header, { subtree: true, attributes: true, childList: true, characterData: true });
    for (const element of [doc.documentElement, doc.body]) {
      mutations.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
  }
  view.addEventListener('resize', schedule);
  view.addEventListener('scroll', schedule, true);
  doc.addEventListener('load', schedule, true); // Includes a late Host theme stylesheet.
  doc.fonts?.addEventListener('loadingdone', schedule);
  schedule();

  function stop() {
    if (stopped) return;
    stopped = true;
    if (frame !== null) view.cancelAnimationFrame(frame);
    if (resize) resize.disconnect();
    if (mutations) mutations.disconnect();
    view.removeEventListener('resize', schedule);
    view.removeEventListener('scroll', schedule, true);
    doc.removeEventListener('load', schedule, true);
    doc.fonts?.removeEventListener('loadingdone', schedule);
    if (applied || pending && sentNonEmpty) {
      // Best effort on pagehide, ordered after any request already handed to the SDK.
      // The Host also discards regions when this document goes away.
      try { void Promise.resolve(surface.setInteractiveRegions([])).catch(() => {}); } catch { /* unavailable */ }
    }
  }
  return stop;
}

// Both landing routes share the same three controls; Preview uses a different boot path.
export function installTabHitRegions(hana, header) {
  const view = header?.ownerDocument.defaultView;
  const surface = hana.surface;
  if (!view || typeof surface?.setInteractiveRegions !== 'function') return () => {};
  let generation = 0, stop;
  function suspend() {
    generation++;
    stop?.(); stop = undefined;
  }
  async function start() {
    const current = generation;
    // Theme startup swallows readiness errors; this capability needs its own SDK ready call.
    try { await hana.ready(); } catch { return; }
    if (current === generation) stop = observeTabs(header, view, surface);
  }
  function resume(event) {
    if (!event.persisted) return;
    suspend();
    void start();
  }
  view.addEventListener('pagehide', suspend);
  view.addEventListener('pageshow', resume);
  void start();
  return () => {
    suspend();
    view.removeEventListener('pagehide', suspend);
    view.removeEventListener('pageshow', resume);
  };
}
