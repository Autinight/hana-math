const WORKSPACE_DRAG = 'application/x-hana-file-drag';
const OK = '已交给 Hana 打开。';
const REFUSED = '没有打开文件。请拖入一个工作区 .hanamathboard 文件，或在工作区直接打开。';
const CARD_ONLY = '请从卡片中心打开「研究看板」，或在工作区直接打开文件。';
const LIVE_PROVIDER = 'app:hana-math/live-dashboard';
// The exact 54 bytes of examples/live-dashboard.hanamathboard, including LF.
const EMPTY_BOARD = 'eyJraW5kIjoiaGFuYS1tYXRoLmxpdmUtZGFzaGJvYXJkIiwic2NoZW1hVmVyc2lvbiI6MX0K';

function savedBoard(resource) {
  if (!resource || ![Object.prototype, null].includes(Object.getPrototypeOf(resource))) return false;
  const kind = Object.getOwnPropertyDescriptor(resource, 'kind')?.value;
  const path = Object.getOwnPropertyDescriptor(resource, 'path')?.value;
  // UX check only. The Host still resolves and authorizes this very resource.
  return kind === 'local-file' && typeof path === 'string' && !/[\x00-\x1f\x7f]/.test(path)
    && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) && /[^\\/]\.hanamathboard$/i.test(path);
}

export function installDashboardDrop(host, zone, status, button) {
  let closed = false, pending = false;
  const cardId = surface => surface?.appId === 'hana-math' && surface.slot === 'card'
    && typeof surface.cardInstanceId === 'string' && surface.cardInstanceId.length > 0 ? surface.cardInstanceId : null;
  const card = () => cardId(host.surface.getContext());
  const saveSupported = !!button && typeof host.surface.onContextChanged === 'function'
    && typeof host.resources?.saveFile === 'function' && typeof host.document?.open === 'function';
  let lastCard = card(), surfaceGeneration = 0;
  const syncButton = () => { if (button) button.disabled = closed || pending || !saveSupported || !card(); };
  const stopObserving = saveSupported ? host.surface.onContextChanged(surface => {
    const current = cardId(surface);
    // A native save dialog can blur the iframe. Only a real surface change or
    // disposal invalidates this attempt, not focus loss on its own.
    if (current !== lastCard) { lastCard = current; surfaceGeneration++; }
    syncButton();
  }) : undefined;
  const dragKind = event => {
    if (!event.isTrusted) return null;
    const types = Array.from(event.dataTransfer?.types ?? []);
    return types.includes(WORKSPACE_DRAG) ? 'workspace' : types.includes('Files') ? 'file' : null;
  };
  const say = text => { if (!closed) status.textContent = text; };
  function dragover(event) {
    if (closed || event.defaultPrevented || !dragKind(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = card() && !pending ? 'copy' : 'none';
  }
  async function drop(event) {
    const kind = dragKind(event);
    if (closed || event.defaultPrevented || !kind) return;
    if (!card() || typeof host.document?.openDrop !== 'function') {
      event.preventDefault(); say(CARD_ONLY); return;
    }
    if (pending || kind === 'file' && event.dataTransfer.files?.length !== 1) {
      event.preventDefault(); if (!pending) say(REFUSED); return;
    }
    pending = true; syncButton();
    try {
      // openDrop consumes the native interaction synchronously. Do not cancel
      // it beforehand, infer a pathname, or pass a provider override. Hana
      // resolves the selected file and matches the existing preview selector.
      const opened = host.document.openDrop(event);
      event.preventDefault(); // Prevent fallback browser navigation.
      say('正在打开…');
      say((await opened)?.opened === true ? OK : REFUSED);
    } catch {
      if (!event.defaultPrevented) event.preventDefault();
      say(REFUSED);
    } finally { pending = false; syncButton(); }
  }
  async function save(event) {
    if (!event.isTrusted || event.defaultPrevented || closed || pending || !saveSupported) return;
    const initialCard = card(), initialGeneration = surfaceGeneration;
    if (!initialCard) return;
    const current = () => !closed && initialGeneration === surfaceGeneration && card() === initialCard;
    pending = true; syncButton();
    let saved = false;
    try {
      // No await or document read before handing this user gesture to Hana.
      const receipt = await host.resources.saveFile({ suggestedName: 'research.hanamathboard',
        mimeType: 'application/json', contentBase64: EMPTY_BOARD });
      if (!current()) return;
      if (receipt?.kind === 'canceled') { say('已取消，没有打开看板。'); return; }
      if (receipt?.kind === 'conflict') {
        say('保存发生冲突。文件可能已写入，请在工作区检查；不会自动重试或打开。'); return;
      }
      if (receipt?.kind === 'download-started') { say('已开始下载；没有打开看板。可在工作区打开下载好的文件。'); return; }
      if (receipt?.kind !== 'saved') { say('未能确认保存；没有打开看板。'); return; }
      saved = true;
      const resource = receipt.resource;
      if (!savedBoard(resource)) { say('文件已保存，但未打开。请确认文件名以 .hanamathboard 结尾，再从工作区打开。'); return; }
      if (!current()) return;
      const opened = await host.document.open({ providerId: LIVE_PROVIDER, resource });
      if (current()) say(opened?.opened === true ? OK : '文件已保存，但未打开。请从工作区直接打开。');
    } catch {
      if (current()) say(saved ? '文件已保存，但未打开。请从工作区直接打开。' : '未能确认保存。请在工作区检查；不会自动重试。');
    } finally { pending = false; syncButton(); }
  }
  button?.addEventListener('click', save);
  syncButton();
  zone.addEventListener('dragover', dragover);
  zone.addEventListener('drop', drop); // Bubble, so a prior cancel is respected.
  return () => {
    closed = true; syncButton(); stopObserving?.();
    button?.removeEventListener('click', save);
    zone.removeEventListener('dragover', dragover);
    zone.removeEventListener('drop', drop);
  };
}
