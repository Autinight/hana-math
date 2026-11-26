import { appUi, mountAppUi } from './app-ui.js';

const FALLBACK_AVATAR = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#e9e4dc"/><circle cx="48" cy="35" r="16" fill="#a49d91"/><path d="M16 94v-9a32 32 0 0 1 64 0v9" fill="#a49d91"/></svg>')}`;
const TEXT_FIELDS = ['name', 'latinName', 'identity', 'agentsMd'];
const FIELD_NAMES = { name: '名字', latinName: '罗马字名', model: '模型', identity: '身份简介', agentsMd: 'AGENTS.md', avatar: '头像', avatarDataUrl: '头像', agentId: '私有 Agent', instance: '私有 Agent 实例', binding: '角色绑定' };

export function defaultSelection(items, kind, previous) {
  if (items.some((item) => item.id === previous)) return previous;
  if (kind === 'role') return items.find((item) => item.id === 'main')?.id ?? items[0]?.id ?? null;
  return (items.find((item) => item.isPrimary === true) || items.find((item) => item.isCurrent === true) || items[0])?.id ?? null;
}

export function editorPath(kind, id) {
  if (!['assistant', 'role'].includes(kind) || typeof id !== 'string' || !id) throw new Error('无效的编辑对象');
  return `/editor/${kind}/${encodeURIComponent(id)}`;
}

export function draftFrom(editor) {
  return { ...Object.fromEntries(TEXT_FIELDS.map((key) => [key, editor[key]])), model: editor.model ? { provider: editor.model.provider, id: editor.model.id } : null };
}

export function isDirty(draft, editor) {
  return Boolean(draft.avatarDataUrl) || TEXT_FIELDS.some((key) => draft[key] !== editor[key]) || draft.model?.provider !== editor.model?.provider || draft.model?.id !== editor.model?.id;
}

export function savePayload(draft, editor) {
  return { revision: editor.revision, ...draftFrom(draft), ...(draft.avatarDataUrl ? { avatarDataUrl: draft.avatarDataUrl } : {}) };
}

const PROVIDER_LABELS = new Map([
  ['deepseek', 'DeepSeek'],
  ['openai-codex', 'OpenAI Codex (OAuth)'], ['openai-codex-oauth', 'OpenAI Codex (OAuth)'],
  ['xai-oauth', 'xAI Grok (OAuth)'], ['xai-grok-oauth', 'xAI Grok (OAuth)'],
]);

function providerLabel(provider) {
  if (PROVIDER_LABELS.has(provider)) return PROVIDER_LABELS.get(provider);
  return provider.split(/[-_.]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

export function modelOptions(models) {
  const groups = new Map();
  for (const model of models) {
    if (!groups.has(model.provider)) groups.set(model.provider, { provider: model.provider, label: providerLabel(model.provider), models: [] });
    groups.get(model.provider).models.push({ value: JSON.stringify([model.provider, model.id]), label: model.name || model.id });
  }
  return [...groups.values()];
}

export function saveErrorMessage(error = {}) {
  const message = typeof error.message === 'string' && error.message ? error.message : '保存失败，请重试。';
  const applied = Array.isArray(error.applied) ? error.applied.filter((key) => typeof key === 'string') : [];
  const parts = [message];
  if (applied.length) parts.push(`已保存：${applied.map((key) => FIELD_NAMES[key] || key).join('、')}；其余字段未确认保存。`);
  else if (error.code === 'PARTIAL_SAVE') parts.push('部分字段可能已保存，服务端未提供字段清单。');
  if (error.code === 'CONFLICT') parts.push('版本冲突：未自动覆盖。全部草稿已保留，请关闭并重新打开核对。');
  else if (error.code === 'PARTIAL_SAVE' || applied.length) parts.push('全部草稿已保留，请关闭并重新打开核对后再保存。');
  return parts.join(' ');
}

function validateEditor(editor, kind, id) {
  if (!editor || editor.kind !== kind || editor.id !== id || typeof editor.revision !== 'string' || !editor.revision || !Array.isArray(editor.models) || TEXT_FIELDS.some((key) => typeof editor[key] !== 'string')) throw new Error('编辑数据不完整，请重新打开核对。');
  if (editor.model !== null && (!editor.model || typeof editor.model.provider !== 'string' || typeof editor.model.id !== 'string')) throw new Error('模型数据不完整');
  if (editor.models.some((model) => !model || typeof model.provider !== 'string' || typeof model.id !== 'string')) throw new Error('模型目录不完整');
  return editor;
}

// Software image processing only: no host file access or avatar API is used.
export async function compressAvatar(file, document, signal) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  if (file.size > 8 * 1024 * 1024) throw new Error('请选择不超过 8 MB 的图片');
  const win = document.defaultView;
  const url = win.URL.createObjectURL(file);
  const image = new win.Image();
  let timer;
  let abort;
  try {
    await new Promise((resolve, reject) => {
      const fail = (message) => reject(new Error(message));
      abort = () => fail('头像处理已取消');
      image.onload = resolve;
      image.onerror = () => fail('无法读取这张图片，请重新选择');
      timer = win.setTimeout(() => fail('图片读取超时，请重新选择'), 10000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else image.src = url;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height || width * height > 32000000) throw new Error('图片尺寸过大或无效');
    const scale = Math.min(1, 256 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前环境无法处理头像图片');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/png');
    if (!data.startsWith('data:image/png;base64,') || data.length > 512 * 1024) throw new Error('压缩后头像超过 512 KB，请选择更小的图片');
    return data;
  } finally {
    win.clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    image.onload = null;
    image.onerror = null;
    win.URL.revokeObjectURL(url);
  }
}

export function mountMathPanel(root, { request }) {
  if (!root?.ownerDocument || typeof request !== 'function') throw new Error('需要挂载节点与 request');
  const document = root.ownerDocument;
  const win = document.defaultView;
  const handles = new Set();
  const controllers = new Set();
  const groups = new Map();
  const earlyPanelFailures = new WeakSet();
  let alive = true;
  let editorSession = null, cancelPanelRetry;
  root.setAttribute('data-hana-app-ui', '');

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function control(host, type, props) {
    const handle = mountAppUi(host, type, props);
    handles.add(handle);
    return handle;
  }
  function dispose(handle) { if (handle) { handle.destroy(); handles.delete(handle); } }
  function focusLater(getElement) {
    const apply = () => { if (alive) getElement()?.focus(); };
    if (win.requestAnimationFrame) win.requestAnimationFrame(apply);
    else queueMicrotask(apply);
  }
  async function call(path, init = {}, owner) {
    const controller = new AbortController(); controllers.add(controller); owner?.controllers.add(controller);
    try {
      const response = await request(path, { ...init, signal: controller.signal });
      let data;
      try { data = await response.json(); } catch {
        const error = new Error('服务器返回了无法读取的数据');
        if (path === '/panel' && response.status === 404) earlyPanelFailures.add(error);
        throw error;
      }
      if (!response.ok || data?.ok === false) {
        const error = new Error(data?.error?.message || '请求失败，请重试');
        error.detail = data?.error || {};
        if (path === '/panel' && (response.status === 404 || response.status === 503 && error.detail.code === 'MATH_BOOTSTRAP_PENDING')) {
          earlyPanelFailures.add(error);
        }
        throw error;
      }
      return data;
    } finally { controllers.delete(controller); owner?.controllers.delete(controller); }
  }
  function portrait(item, unavailable) {
    const image = node('img', 'avatar-image');
    image.alt = item.name;
    image.draggable = false;
    let failed = !item.avatarUrl;
    image.addEventListener('error', () => {
      if (failed) return;
      failed = true;
      image.src = FALLBACK_AVATAR;
      image.title = '图片不可用';
      unavailable();
    });
    image.src = item.avatarUrl || FALLBACK_AVATAR;
    if (failed) { image.title = '图片不可用'; unavailable(); }
    return image;
  }

  const shell = node('div', 'math-panel');
  const title = node('h1', 'math-title', 'Math'); title.tabIndex = -1;
  shell.appendChild(title); root.appendChild(shell);
  function makeGroup(kind, label) {
    const section = node(kind === 'role' ? 'fieldset' : 'section', `member-group ${kind === 'role' ? 'role-group' : 'assistant-group'}`);
    section.setAttribute('aria-label', label);
    const heading = node(kind === 'role' ? 'legend' : 'h2', 'group-heading', label);
    const cluster = node('div', 'member-cluster');
    const stage = node('div', 'avatar-stage');
    const list = node('ul', 'avatar-stack'); list.setAttribute('aria-label', label);
    const status = node('p', 'group-status', '正在读取…'); status.setAttribute('role', 'status');
    const editHost = node('div', 'edit-action'); editHost.hidden = true;
    stage.appendChild(list); cluster.append(stage, editHost, status); section.append(heading, cluster); shell.appendChild(section);
    const group = { kind, list, stage, editHost, status, items: [], selected: null, edit: null, unavailable: false };
    group.edit = control(editHost, 'Button', { size: 'sm', variant: 'secondary', children: '编辑', 'aria-label': kind === 'role' ? '编辑子代理' : '编辑助手', onClick: () => {
      const item = group.items.find((entry) => entry.id === group.selected);
      if (item) void openEditor(group, item);
    } });
    groups.set(kind, group);
    return group;
  }
  makeGroup('assistant', '助手'); makeGroup('role', '子代理 Agent');

  // LaTeX compiler path settings section (settings-only; models cannot mutate).
  const texSection = node('section', 'member-group tex-group');
  texSection.setAttribute('aria-label', 'LaTeX 编译');
  texSection.hidden = true;
  const texHeading = node('h2', 'group-heading', 'LaTeX 编译');
  const texDesc = node('p', 'tex-desc', '配置本机 pdflatex 或 pdftex 可执行文件位置，供论文编译与交付生成 PDF。留空时自动按系统常用路径查找。');
  const texRow = node('div', 'tex-row');
  const texInput = node('input', 'tex-input');
  texInput.type = 'text';
  texInput.autocomplete = 'off';
  texInput.spellcheck = false;
  texInput.setAttribute('aria-label', 'TeX 编译器路径');
  texInput.placeholder = '留空自动查找，例如 /Library/TeX/texbin/pdflatex';
  const texActions = node('div', 'tex-actions');
  const texSaveHost = node('div');
  const texTestHost = node('div');
  texActions.append(texSaveHost, texTestHost);
  texRow.append(texInput, texActions);
  const texStatus = node('p', 'tex-status'); texStatus.setAttribute('role', 'status');
  texSection.append(texHeading, texDesc, texRow, texStatus);
  shell.appendChild(texSection);

  let texBusy = false;
  function setTexStatus(text, isError = false) {
    texStatus.textContent = text;
    texStatus.className = isError ? 'tex-status is-error' : 'tex-status';
  }
  const texSaveBtn = control(texSaveHost, 'Button', { size: 'sm', variant: 'primary', children: '保存路径', onClick: () => void saveTex() });
  const texTestBtn = control(texTestHost, 'Button', { size: 'sm', variant: 'secondary', children: '测试编译', onClick: () => void testTex() });
  function syncTexButtons() {
    texInput.disabled = texBusy;
    texSaveBtn.update({ size: 'sm', variant: 'primary', children: '保存路径', disabled: texBusy, onClick: () => void saveTex() });
    texTestBtn.update({ size: 'sm', variant: 'secondary', children: '测试编译', disabled: texBusy, onClick: () => void testTex() });
  }
  function renderTexState(tex) {
    if (!tex) return;
    texSection.hidden = false;
    if (tex.defaultHint) texInput.placeholder = `留空自动查找，例如 ${tex.defaultHint}`;
    texInput.value = tex.configuredPath || '';
    if (tex.available && tex.resolvedPath) {
      setTexStatus(`${tex.mode === 'custom' ? '自定义路径可用' : '自动探测可用'}：${tex.resolvedPath}`, false);
    } else if (tex.error?.message) {
      setTexStatus(tex.error.message, true);
    } else {
      setTexStatus('尚未检测到可用的 pdflatex。', true);
    }
  }
  async function saveTex() {
    if (!alive || texBusy) return;
    texBusy = true; syncTexButtons(); setTexStatus('正在保存并检测…', false);
    try {
      const data = await call('/settings/tex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compilerPath: texInput.value.trim() || null }),
      });
      if (!alive) return;
      renderTexState(data.tex);
    } catch (error) {
      if (alive) setTexStatus(error.detail?.message || error.message || '保存失败，请检查路径后重试。', true);
    } finally { if (alive) { texBusy = false; syncTexButtons(); } }
  }
  async function testTex() {
    if (!alive || texBusy) return;
    texBusy = true; syncTexButtons(); setTexStatus('正在测试编译最小样例…', false);
    try {
      const data = await call('/settings/tex/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compilerPath: texInput.value.trim() || null }),
      });
      if (!alive) return;
      const r = data.result;
      if (r?.ok) {
        setTexStatus(`测试编译通过（${r.pdfBytes} 字节 PDF）\n编译器：${r.resolvedPath}${r.version ? `\n${r.version}` : ''}`, false);
      } else {
        const msg = r?.error?.message || '测试编译失败';
        setTexStatus(r?.logExcerpt ? `${msg}\n${r.logExcerpt.slice(0, 400)}` : msg, true);
      }
    } catch (error) {
      if (alive) setTexStatus(error.detail?.message || error.message || '测试编译失败。', true);
    } finally { if (alive) { texBusy = false; syncTexButtons(); } }
  }

  function renderGroup(group, section) {
    const version = group.version = (group.version || 0) + 1;
    group.unavailable = false;
    const rosterReady = section?.state === 'ready' && Array.isArray(section.items);
    group.items = rosterReady ? section.items : [];
    group.selected = defaultSelection(group.items, group.kind, group.selected);
    group.list.replaceChildren();
    group.status.textContent = !rosterReady ? `暂时无法读取${group.kind === 'role' ? '角色预设' : '助手'}` : !group.items.length ? `暂无可显示的${group.kind === 'role' ? '角色预设' : '助手'}` : '';
    group.editHost.hidden = !group.selected;
    function updateSelection(focus = false) {
      for (const button of group.list.querySelectorAll('button')) {
        const selected = button.dataset.memberId === group.selected;
        button.setAttribute('aria-pressed', String(selected)); button.tabIndex = selected ? 0 : -1;
        if (selected && focus) button.focus();
      }
    }
    group.items.forEach((item, index) => {
      const member = node('li', 'stack-member'); member.style.setProperty('--member-z', String(group.items.length - index));
      const button = node('button', 'avatar-button'); button.type = 'button'; button.dataset.memberId = item.id;
      const unavailable = group.kind === 'role' && item.id === 'explorer' && item.state === 'unavailable';
      button.setAttribute('aria-label', `选择${item.name}${unavailable ? '，暂不可用，初始化或配置未确认' : group.kind === 'role' && !item.agentId ? '，角色预设' : ''}`);
      const image = portrait(item, () => { if (alive && group.version === version) { group.unavailable = true; group.status.textContent = '头像图片不可用，已显示通用人像'; } });
      const dot = node('span', 'selection-dot'); dot.setAttribute('aria-hidden', 'true');
      const name = node('span', 'member-name', `${item.name}${unavailable ? '（暂不可用）' : ''}`);
      button.append(image, dot, name); member.appendChild(button); group.list.appendChild(member);
      button.addEventListener('click', () => { group.selected = item.id; updateSelection(); });
      button.addEventListener('keydown', (event) => {
        let next;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % group.items.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + group.items.length) % group.items.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = group.items.length - 1;
        if (next !== undefined) { event.preventDefault(); group.selected = group.items[next].id; updateSelection(true); }
      });
    });
    updateSelection();
  }

  async function loadPanel() {
    try {
      let data;
      try { data = await call('/panel', { method: 'GET' }); }
      catch (error) {
        // A mounted iframe can beat registration of this fixed route. Retry
        // the roster only, once; never retry editor requests or unknown errors.
        if (!alive || !earlyPanelFailures.has(error)) throw error;
        await new Promise(resolve => {
          const timer = win.setTimeout(() => { cancelPanelRetry = undefined; resolve(); }, 250);
          cancelPanelRetry = () => { win.clearTimeout(timer); resolve(); };
        });
        if (!alive) return;
        data = await call('/panel', { method: 'GET' });
      }
      if (!alive) return;
      renderGroup(groups.get('assistant'), data.assistants);
      renderGroup(groups.get('role'), data.roles);
      if (data?.tex) renderTexState(data.tex);
    } catch {
      if (alive) for (const group of groups.values()) renderGroup(group, null);
    }
  }

  async function openEditor(group, item) {
    if (!alive || editorSession) return;
    const dialog = node('dialog', 'math-editor'); dialog.tabIndex = -1;
    dialog.setAttribute('aria-label', `编辑${item.name}`); dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('data-hana-app-ui', '');
    shell.appendChild(dialog);
    const header = node('header', 'editor-header');
    const editorTitle = node('h2', '', item.name);
    const editorId = node('code', 'editor-id', item.id);
    header.append(editorTitle, editorId);
    const body = node('div', 'editor-body');
    const message = node('p', 'editor-message', '正在读取…'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const content = node('div', 'editor-content'); content.hidden = true;
    const confirmation = node('div', 'discard-confirmation'); confirmation.hidden = true;
    confirmation.setAttribute('role', 'alert');
    const confirmText = node('p', '', '有未保存的更改，确定放弃吗？');
    const confirmActions = node('div'); confirmation.append(confirmText, confirmActions);
    const footer = node('footer', 'editor-footer');
    const closeHost = node('div'); footer.appendChild(closeHost);
    body.append(content, message, confirmation); dialog.append(header, body, footer);
    let modelMenu = null;
    let closeModelMenu = () => {};
    const session = { dialog, handles: [], controllers: new Set(), snapshot: null, draft: null, pending: false, uploading: false, disposed: false, blocked: false, saveStatus: 'idle', updates: [], beforeConfirm: null };
    editorSession = session;
    function mount(host, type, props) { const handle = control(host, type, props); session.handles.push(handle); return handle; }
    function showMessage(text, error = false) { message.textContent = text; message.classList.toggle('is-error', error); message.setAttribute('role', error ? 'alert' : 'status'); }
    function update() { if (!session.disposed) { dialog.setAttribute('aria-busy', String(session.pending)); for (const refresh of session.updates) refresh(); } }
    function fieldChange(key, value) { session.draft[key] = value; session.saveStatus = 'idle'; update(); }
    function finish(restore = true) {
      if (session.disposed) return;
      session.disposed = true;
      for (const controller of session.controllers) controller.abort(); session.controllers.clear();
      document.removeEventListener('keydown', trap);
      document.removeEventListener('focusin', containFocus);
      for (const handle of session.handles) dispose(handle);
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      dialog.remove(); if (editorSession === session) editorSession = null;
      if (restore) focusLater(() => group.editHost.querySelector('button') || title);
    }
    session.finish = finish;
    function requestClose() {
      if (session.pending) return;
      if (session.uploading || (session.draft && isDirty(session.draft, session.snapshot))) {
        session.beforeConfirm = document.activeElement;
        confirmation.hidden = false;
        focusLater(() => confirmActions.querySelector('button'));
      } else finish();
    }
    const closeProps = () => ({ variant: 'secondary', children: '关闭', disabled: session.pending, onClick: requestClose });
    const close = mount(closeHost, 'Button', closeProps()); session.updates.push(() => close.update(closeProps()));
    mount(confirmActions, 'Inline', { gap: 'sm', children: [
      appUi('Button', { variant: 'danger', children: '放弃更改', onClick: () => { if (!session.pending) finish(); } }),
      appUi('Button', { variant: 'secondary', children: '继续编辑', onClick: () => { confirmation.hidden = true; session.beforeConfirm?.focus(); } }),
    ] });
    function expandedPopup() { return dialog.querySelector('[aria-expanded="true"]'); }
    function visibleFocusable() {
      return Array.from(dialog.querySelectorAll('button, input, textarea, select, [tabindex]')).filter((element) => !element.disabled && element.tabIndex !== -1 && !element.closest('[hidden]') && (!win.getComputedStyle || (win.getComputedStyle(element).display !== 'none' && win.getComputedStyle(element).visibility !== 'hidden')));
    }
    function trap(event) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (modelMenu && !modelMenu.hidden) { event.preventDefault(); closeModelMenu(true); return; }
        if (!expandedPopup()) { event.preventDefault(); requestClose(); }
      }
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const focusable = visibleFocusable(); const first = focusable[0]; const last = focusable.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement) || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement) || document.activeElement === dialog)) { event.preventDefault(); first.focus(); }
    }
    function containFocus(event) { if (!session.disposed && !dialog.contains(event.target)) dialog.focus(); }
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (modelMenu && !modelMenu.hidden) { closeModelMenu(true); return; } if (!expandedPopup()) requestClose(); });
    document.addEventListener('keydown', trap); document.addEventListener('focusin', containFocus);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else { dialog.setAttribute('open', ''); dialog.setAttribute('role', 'dialog'); }
    dialog.focus();

    try {
      const data = await call(editorPath(group.kind, item.id), { method: 'GET' }, session);
      if (session.disposed || !alive) return;
      if (data.ok !== true) throw new Error('编辑资料读取失败');
      session.snapshot = validateEditor(data.editor, group.kind, item.id);
      session.draft = draftFrom(session.snapshot);
      const snapshot = session.snapshot;
      editorTitle.textContent = snapshot.name; editorId.textContent = snapshot.agentId || snapshot.id;
      dialog.setAttribute('aria-label', `编辑${snapshot.name}`);
      const upper = node('div', 'editor-upper');
      const left = node('div', 'editor-left');
      upper.appendChild(left);
      content.appendChild(upper);
      const avatarSlot = node('div', 'editor-avatar');
      const avatarNote = node('p', 'avatar-availability');
      const fileInput = node('input'); fileInput.type = 'file'; fileInput.accept = 'image/png,image/jpeg,image/webp'; fileInput.hidden = true;
      const uploadHost = node('div', 'avatar-upload');
      left.append(avatarSlot, avatarNote, uploadHost, fileInput);
      function updateAvatar() {
        const version = session.avatarVersion = (session.avatarVersion || 0) + 1;
        avatarNote.textContent = '';
        avatarSlot.replaceChildren(portrait({ name: session.draft.name, avatarUrl: session.draft.avatarDataUrl || session.snapshot.avatarUrl }, () => { if (!session.disposed && session.avatarVersion === version) avatarNote.textContent = '图片不可用'; }));
      }
      updateAvatar();
      const uploadProps = () => ({ size: 'sm', variant: 'secondary', children: session.uploading ? '正在处理…' : '更换头像', disabled: session.pending || session.uploading, onClick: () => fileInput.click() });
      const upload = mount(uploadHost, 'Button', uploadProps());
      session.updates.push(() => { fileInput.disabled = session.pending || session.uploading; upload.update(uploadProps()); });
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0]; if (!file || !alive || session.disposed || session.pending || session.uploading) return;
        const controller = new AbortController(); controllers.add(controller); session.controllers.add(controller);
        session.uploading = true; update();
        try {
          const dataUrl = await compressAvatar(file, document, controller.signal);
          if (session.disposed || !alive) return;
          fieldChange('avatarDataUrl', dataUrl); updateAvatar(); showMessage('头像草稿已更新，保存后生效。');
        } catch (error) { if (!session.disposed && alive) showMessage(error.message || '头像处理失败', true); }
        finally { controllers.delete(controller); session.controllers.delete(controller); session.uploading = false; fileInput.value = ''; update(); }
      });
      function inputField(parent, key, label, type = 'TextInput', rows) {
        const wrapper = node('label', `editor-field field-${key}`);
        const labelText = node('span', 'field-label', label); const host = node('div', 'field-control');
        wrapper.append(labelText, host); parent.appendChild(wrapper);
        const props = () => ({ 'aria-label': label, value: session.draft[key], disabled: session.pending, ...(rows ? { rows } : {}), ...(key === 'name' ? { autoFocus: true } : {}), onChange: (event) => fieldChange(key, event.target.value) });
        const handle = mount(host, type, props());
        session.updates.push(() => handle.update(props()));
      }
      const modelsField = node('div', 'editor-field model-field'); modelsField.appendChild(node('span', 'field-label', 'Ta 的模型'));
      const modelPicker = node('div', 'model-picker');
      const modelTrigger = node('button', 'model-picker-trigger'); modelTrigger.setAttribute('type', 'button'); modelTrigger.setAttribute('aria-label', 'Ta 的模型'); modelTrigger.setAttribute('aria-haspopup', 'listbox'); modelTrigger.setAttribute('aria-expanded', 'false');
      const selectedName = node('span', 'model-picker-name');
      const modelChevron = node('span', 'model-picker-chevron'); modelChevron.setAttribute('aria-hidden', 'true');
      modelTrigger.append(selectedName, modelChevron); modelPicker.appendChild(modelTrigger); modelsField.appendChild(modelPicker);
      upper.appendChild(modelsField);
      modelMenu = node('div', 'model-picker-menu'); modelMenu.hidden = true; modelMenu.setAttribute('role', 'listbox'); modelMenu.setAttribute('aria-label', '可用模型'); dialog.appendChild(modelMenu);
      closeModelMenu = (restoreFocus = false) => {
        modelMenu.hidden = true; modelTrigger.setAttribute('aria-expanded', 'false'); modelChevron.className = 'model-picker-chevron';
        if (restoreFocus) modelTrigger.focus();
      };
      function placeModelMenu() {
        if (typeof modelTrigger.getBoundingClientRect !== 'function') return;
        const viewportWidth = Number.isFinite(win.innerWidth) ? win.innerWidth : 1100;
        const viewportHeight = Number.isFinite(win.innerHeight) ? win.innerHeight : 900;
        const rect = modelTrigger.getBoundingClientRect(); const width = Math.min(280, Math.max(220, Math.min(rect.width, viewportWidth - 32)));
        const left = Math.max(16, Math.min(rect.left, viewportWidth - width - 16));
        modelMenu.style.left = `${left}px`; modelMenu.style.width = `${width}px`;
        const height = Math.min(modelMenu.scrollHeight || 180, Math.min(180, viewportHeight - 32));
        const below = rect.bottom + 8; const top = below + height <= viewportHeight - 16 ? below : Math.max(16, rect.top - height - 8);
        modelMenu.style.top = `${top}px`;
      }
      function renderModelPicker() {
        const current = session.draft?.model || null;
        selectedName.textContent = current ? session.snapshot.models.find((model) => model.provider === current.provider && model.id === current.id)?.name || current.id : '未选择模型';
        modelTrigger.disabled = session.pending; modelTrigger.setAttribute('aria-expanded', String(!modelMenu.hidden));
        modelChevron.className = `model-picker-chevron${modelMenu.hidden ? '' : ' is-open'}`;
        const groups = modelOptions(session.snapshot.models).map((group) => ({ ...group, options: [...group.models] }));
        if (current && !groups.some((group) => group.options.some((option) => option.value === JSON.stringify([current.provider, current.id])))) {
          let group = groups.find((entry) => entry.provider === current.provider);
          if (!group) { group = { provider: current.provider, label: providerLabel(current.provider), options: [] }; groups.push(group); }
          group.options.unshift({ value: JSON.stringify([current.provider, current.id]), label: `${current.id}（当前不可用）`, disabled: true });
        }
        modelMenu.replaceChildren();
        if (!groups.length) modelMenu.appendChild(node('div', 'model-picker-empty', '当前没有可用模型'));
        for (const group of groups) {
          const section = node('section', 'model-provider-group'); section.setAttribute('role', 'group'); section.setAttribute('aria-label', group.label);
          const heading = node('div', 'model-provider-heading', group.label);
          section.appendChild(heading);
          for (const option of group.options) {
            const button = node('button', `model-picker-option${option.disabled ? ' is-unavailable' : ''}`, option.label);
            button.setAttribute('type', 'button'); button.setAttribute('role', 'option'); button.setAttribute('data-value', option.value); button.setAttribute('aria-selected', String(option.value === (current ? JSON.stringify([current.provider, current.id]) : '')));
            if (option.disabled) button.disabled = true;
            button.addEventListener('click', () => {
              if (!alive || session.disposed || session.pending || button.disabled) return;
              const model = session.snapshot.models.find((entry) => JSON.stringify([entry.provider, entry.id]) === option.value);
              if (!model) return;
              closeModelMenu(); fieldChange('model', { provider: model.provider, id: model.id }); modelTrigger.focus();
            });
            section.appendChild(button);
          }
          modelMenu.appendChild(section);
        }

      }
      modelTrigger.addEventListener('click', () => {
        if (session.pending) return;
        if (modelMenu.hidden) { renderModelPicker(); modelMenu.hidden = false; modelTrigger.setAttribute('aria-expanded', 'true'); modelChevron.className = 'model-picker-chevron is-open'; placeModelMenu(); }
        else closeModelMenu();
      });
      modelTrigger.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' && modelMenu.hidden) {
          event.preventDefault(); modelTrigger.click();
          [...modelMenu.querySelectorAll('[role="option"]')].find((option) => !option.disabled)?.focus();
        }
      });
      modelMenu.addEventListener('keydown', (event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const options = [...modelMenu.querySelectorAll('[role="option"]')].filter((option) => !option.disabled);
        if (!options.length) return;
        event.preventDefault(); const index = options.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next].focus();
      });
      dialog.addEventListener('click', (event) => { if (!modelPicker.contains(event.target) && !modelMenu.contains(event.target)) closeModelMenu(); });
      modelMenu.addEventListener('click', (event) => event.stopPropagation());
      session.updates.push(renderModelPicker); renderModelPicker();
      inputField(upper, 'name', '名字'); inputField(upper, 'latinName', '罗马字名');
      content.appendChild(node('hr', 'editor-divider'));
      inputField(content, 'identity', '身份简介', 'TextArea', 3);
      inputField(content, 'agentsMd', 'AGENTS.md', 'TextArea', 7);
      const saveRow = node('div', 'save-row');
      const saveHost = node('div'); saveRow.appendChild(saveHost); content.appendChild(saveRow);
      const saveProps = () => ({ status: session.saveStatus, labels: { idle: '保存', saving: '正在保存…', saved: '已保存' }, disabled: session.pending || session.uploading || session.blocked || !session.draft.model || (!session.snapshot.isPreset && !isDirty(session.draft, session.snapshot)), onSavedFeedbackEnd: () => { if (!session.disposed && session.saveStatus === 'saved') { session.saveStatus = 'idle'; update(); } }, onClick: () => void save() });
      const saveButton = mount(saveHost, 'SaveButton', saveProps());
      session.updates.push(() => saveButton.update(saveProps()));
      async function save() {
        if (!alive || session.disposed || session.pending || session.uploading || session.blocked || !session.draft.model || (!session.snapshot.isPreset && !isDirty(session.draft, session.snapshot))) return;
        closeModelMenu();
        session.pending = true; session.saveStatus = 'saving'; confirmation.hidden = true; showMessage('正在保存…'); update();
        try {
          const data = await call(editorPath(group.kind, item.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(savePayload(session.draft, session.snapshot)) }, session);
          if (session.disposed || !alive) return;
          const next = validateEditor(data.editor, group.kind, item.id);
          if (data.ok !== true) throw new Error('保存结果不完整，请重新打开核对');
          session.snapshot = next; session.draft = draftFrom(next); session.saveStatus = 'saved';
          editorTitle.textContent = next.name; editorId.textContent = next.agentId || next.id;
          dialog.setAttribute('aria-label', `编辑${next.name}`);
          Object.assign(item, { name: next.name, avatarUrl: next.avatarUrl, avatarSource: next.avatarSource, agentId: next.agentId });
          renderGroup(group, { state: 'ready', items: group.items });
          updateAvatar(); showMessage('已保存');
        } catch (error) {
          if (session.disposed || !alive) return;
          session.saveStatus = 'idle';
          const detail = error.detail || { message: error.message };
          session.blocked = detail.code === 'CONFLICT' || detail.code === 'PARTIAL_SAVE' || (Array.isArray(detail.applied) && detail.applied.length > 0);
          showMessage(saveErrorMessage(detail), true);
        } finally { session.pending = false; update(); }
      }
      content.hidden = false; showMessage(''); update();
    } catch (error) { if (!session.disposed && alive) showMessage(error.message || '暂时无法读取编辑资料', true); }
  }

  const ready = loadPanel();
  return { ready, destroy() {
    if (!alive) return;
    alive = false;
    cancelPanelRetry?.(); cancelPanelRetry = undefined;
    editorSession?.finish(false);
    for (const controller of controllers) controller.abort(); controllers.clear();
    for (const handle of handles) handle.destroy(); handles.clear();
    shell.remove();
  } };
}
