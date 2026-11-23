import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { defaultSelection, editorPath, draftFrom, isDirty, savePayload, modelOptions, saveErrorMessage, compressAvatar } from '../packages/hana-math/ui/assets/math-view.mjs';

const uiSource = fs.readFileSync(new URL('../packages/hana-math/ui/assets/math-view.mjs', import.meta.url), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(setImmediate);
const response = (body, ok = true) => ({ ok, json: async () => clone(body) });
const panel = () => ({
  assistants: { state: 'ready', items: [
    { id: 'current', name: '当前助手', isCurrent: true, avatarUrl: '/fixtures/current.png', avatarSource: 'app-reference' },
    { id: 'primary', name: '主助手', isPrimary: true, avatarUrl: '/fixtures/primary.png', avatarSource: 'app-reference' },
  ] },
  roles: { state: 'ready', items: ['main', 'worker', 'verifier'].map((id) => ({ id, name: id, avatarUrl: '/fixtures/preset.png', avatarSource: 'app-reference', agentId: null })) },
});
const editor = (kind = 'assistant', id = 'primary') => ({
  kind, id, agentId: kind === 'role' ? null : id, name: id, latinName: 'Original', model: { provider: 'openai-codex', id: 'model-a' },
  identity: '身份草稿原文', agentsMd: '职责草稿原文', avatarUrl: '/fixtures/primary.png', avatarSource: 'app-reference', revision: 'r1', isPreset: kind === 'role',
  models: [{ provider: 'openai-codex', id: 'model-a', name: 'GPT-6.1 Sol' }, { provider: 'deepseek', id: 'model-b', name: 'DeepSeek Flash' }],
});

// A DOM/control wiring fixture, not a browser screenshot or host acceptance.
// Real app-ui exports are imported above; only this harness replaces rendering.
function environment() {
  const mounted = [];
  const listenerMap = new Map();
  const document = {
    activeElement: null,
    addEventListener(type, fn) { if (!listenerMap.has(type)) listenerMap.set(type, new Set()); listenerMap.get(type).add(fn); },
    removeEventListener(type, fn) { listenerMap.get(type)?.delete(fn); },
    dispatch(type, event = {}) { event.type = type; event.preventDefault ||= () => { event.defaultPrevented = true; }; for (const fn of [...listenerMap.get(type) || []]) fn(event); return event; },
    listenerCount: () => [...listenerMap.values()].reduce((sum, set) => sum + set.size, 0),
  };
  function matches(element, selector) {
    if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1));
    const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) return attr[2] === undefined ? element.attrs.has(attr[1]) : element.getAttribute(attr[1]) === attr[2];
    return element.tagName === selector.toUpperCase();
  }
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.attrs = new Map(); this.dataset = {}; this.listeners = new Map(); this.className = ''; this.disabled = false; this._text = ''; this._tabIndex = ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) ? 0 : -1;
      this.style = { setProperty() {} };
      this.classList = { toggle: (name, enabled) => { const set = new Set(this.className.split(/\s+/).filter(Boolean)); if (enabled) set.add(name); else set.delete(name); this.className = [...set].join(' '); } };
    }
    get hidden() { return this.attrs.has('hidden'); } set hidden(value) { if (value) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
    get tabIndex() { return this._tabIndex; } set tabIndex(value) { this._tabIndex = value; this.attrs.set('tabindex', String(value)); }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    setAttribute(key, value) { this.attrs.set(key, String(value)); if (key === 'open') this.open = true; }
    getAttribute(key) { return this.attrs.get(key) ?? null; }
    append(...elements) { for (const element of elements) this.appendChild(element); }
    appendChild(element) { element.remove(); element.parentElement = this; this.children.push(element); return element; }
    replaceChildren(...elements) { for (const child of this.children) child.parentElement = null; this.children = []; for (const element of elements) this.appendChild(element); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    emit(type, extra = {}) { const event = { target: this, ...extra, preventDefault() { this.defaultPrevented = true; } }; for (const fn of [...this.listeners.get(type) || []]) fn(event); return event; }
    click() { if (!this.disabled) { this.focus(); this.emit('click'); } }
    focus() { document.activeElement = this; document.dispatch('focusin', { target: this }); }
    contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
    closest(selector) { for (let element = this; element; element = element.parentElement) if (matches(element, selector)) return element; return null; }
    querySelectorAll(selectors) { const result = []; const parts = selectors.split(',').map((part) => part.trim()); const visit = (parent) => { for (const child of parent.children) { if (parts.some((part) => matches(child, part))) result.push(child); visit(child); } }; visit(this); return result; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    showModal() { this.open = true; this.setAttribute('open', ''); }
    close() { this.open = false; this.attrs.delete('open'); }
  }
  const revoked = []; const canvases = [];
  document.defaultView = {
    requestAnimationFrame: (fn) => queueMicrotask(fn), getComputedStyle: (element) => ({ display: element.closest('[hidden]') ? 'none' : 'block', visibility: 'visible' }),
    setTimeout, clearTimeout,
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: (url) => revoked.push(url) },
    Image: class { naturalWidth = 1024; naturalHeight = 512; set src(value) { queueMicrotask(() => this.onload?.()); } },
  };
  document.createElement = (tag) => {
    const element = new Element(tag);
    if (tag === 'canvas') { element.getContext = () => ({ drawImage() {} }); element.toDataURL = () => 'data:image/png;base64,ZmFrZQ=='; canvases.push(element); }
    return element;
  };
  document.body = document.createElement('body');
  const root = document.createElement('main'); document.body.appendChild(root);
  const appUi = (type, props) => ({ type, props });
  function mountAppUi(host, type, initial) {
    const optedIn = (element) => {
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) if (ancestor.attrs.has('data-hana-app-ui')) return true;
      return false;
    };
    assert.ok(optedIn(host), `Official ${type} mount requires a connected data-hana-app-ui ancestor`);
    const tag = type === 'TextInput' ? 'input' : type === 'TextArea' ? 'textarea' : type === 'Select' || type === 'Inline' ? 'div' : 'button';
    const element = document.createElement(tag); host.appendChild(element);
    const nested = [];
    const handle = { type, element: host, node: element, props: initial, destroyed: false,
      update(props) {
        this.props = props; element.disabled = Boolean(props.disabled); element.value = props.value;
        if (type === 'Button') element.textContent = props.children;
        if (type === 'SaveButton') element.textContent = props.labels[props.status];
        if (props['aria-label']) element.setAttribute('aria-label', props['aria-label']);
        if (type === 'Select') { element.setAttribute('role', 'combobox'); element.setAttribute('aria-expanded', 'false'); element.tabIndex = props.disabled ? -1 : 0; }
      }, destroy() { this.destroyed = true; for (const child of nested) child.destroy(); element.remove(); },
    };
    element.addEventListener('click', () => handle.props.onClick?.());
    element.addEventListener('change', (event) => handle.props.onChange?.(event));
    handle.update(initial);
    if (type === 'Inline') for (const child of initial.children) nested.push(mountAppUi(element, child.type, child.props));
    mounted.push(handle); return handle;
  }
  const context = { __controls: { appUi, mountAppUi }, AbortController, queueMicrotask };
  const source = uiSource.replace("import { appUi, mountAppUi } from './app-ui.js';", 'const { appUi, mountAppUi } = __controls;').replace(/^export /gm, '') + '\nglobalThis.mount = mountMathPanel;';
  vm.runInNewContext(source, context, { filename: 'math-view.mjs' });
  const control = (type, label) => mounted.findLast((handle) => !handle.destroyed && handle.type === type && (!label || handle.props['aria-label'] === label || handle.props.ariaLabel === label || handle.props.children === label));
  return { root, document, mount: context.mount, mounted, control, revoked, canvases };
}
async function setup(handler) {
  const f = environment(); const calls = [];
  f.view = f.mount(f.root, { request: async (path, init) => { calls.push({ path, init }); return path === '/panel' ? response(panel()) : handler(path, init); } });
  f.calls = calls; await f.view.ready; return f;
}
function edit(f, kind = 'assistant') {
  const section = f.root.querySelector(kind === 'role' ? '.role-group' : '.assistant-group');
  section.querySelector('.edit-action').querySelector('button').click();
}
function change(f, label, value) { const handle = f.control('TextInput', label) || f.control('TextArea', label); handle.props.onChange({ target: { value } }); }
function selectModel(f, provider, id) {
  f.root.querySelector('.model-picker-trigger').click();
  const value = JSON.stringify([provider, id]);
  const option = f.root.querySelectorAll('.model-picker-option').find((item) => item.getAttribute('data-value') === value);
  assert.ok(option && !option.disabled, `available model option ${value}`); option.click();
}

test('unconfirmed explorer displays unavailable, not fresh preset, while healthy role editors remain accessible', async () => {
  const f = environment(), payload = panel(), calls = [];
  payload.roles.items.forEach(item => { item.agentId = `saved-${item.id}`; });
  payload.roles.items.push({ id: 'explorer', name: 'math explorer', agentId: null, state: 'unavailable', errorCode: 'EXPLORER_CREATION_UNCONFIRMED', avatarUrl: '/fixtures/preset.png' });
  const view = f.mount(f.root, { request: async (path, init) => {
    calls.push({ path, init });
    return path === '/panel' ? response(payload) : response({ ok: true, editor: { ...editor('role', 'worker'), agentId: 'saved-worker', isPreset: false } });
  } });
  await view.ready;
  const group = f.root.querySelector('.role-group'), buttons = group.querySelectorAll('.avatar-button');
  assert.equal(buttons.length, 4);
  const unavailable = buttons.find(button => button.dataset.memberId === 'explorer');
  assert.match(unavailable.getAttribute('aria-label'), /暂不可用，初始化或配置未确认/);
  assert.doesNotMatch(unavailable.getAttribute('aria-label'), /角色预设/);
  assert.ok(group.querySelectorAll('.member-name').some(name => name.textContent === 'math explorer（暂不可用）'));
  buttons.find(button => button.dataset.memberId === 'worker').click(); edit(f, 'role'); await turn();
  assert.equal(calls.at(-1).path, '/editor/role/worker'); assert.ok(f.root.querySelector('dialog'));
  assert.equal(calls.some(call => call.init.method === 'POST'), false); view.destroy();
});

test('default selection is local: primary before current; roles prefer main; explicit choices persist', () => {
  const items = panel().assistants.items;
  assert.equal(defaultSelection(items, 'assistant'), 'primary');
  assert.equal(defaultSelection(items, 'assistant', 'current'), 'current');
  assert.equal(defaultSelection(items.slice(0, 1), 'assistant'), 'current');
  assert.equal(defaultSelection(panel().roles.items.slice().reverse(), 'role'), 'main');
  assert.equal(defaultSelection([], 'role'), null);
});

test('editor paths, allowlisted save payload, dirty checks and model options come only from server data', () => {
  const snapshot = editor(); const draft = draftFrom(snapshot);
  assert.equal(editorPath('assistant', 'id/with spaces'), '/editor/assistant/id%2Fwith%20spaces');
  assert.equal(isDirty(draft, snapshot), false);
  assert.equal(isDirty(draft, { ...snapshot, model: { id: snapshot.model.id, provider: snapshot.model.provider } }), false, 'property order is not a model change');
  draft.name = '修改名字';
  assert.equal(isDirty(draft, snapshot), true);
  draft.avatarDataUrl = 'data:image/png;base64,eA=='; draft.credentials = 'NOT_A_REAL_SECRET';
  assert.deepEqual(Object.keys(savePayload(draft, snapshot)).sort(), ['revision', 'name', 'latinName', 'model', 'identity', 'agentsMd', 'avatarDataUrl'].sort());
  assert.equal(savePayload(draft, snapshot).revision, 'r1');
  assert.equal(snapshot.name, 'primary');
  const groups = modelOptions(snapshot.models);
  assert.deepEqual(groups.map(({ provider, label }) => [provider, label]), [['openai-codex', 'OpenAI Codex (OAuth)'], ['deepseek', 'DeepSeek']]);
  assert.deepEqual(groups.flatMap((group) => group.models).map((option) => [JSON.parse(option.value), option.label]), [[['openai-codex', 'model-a'], 'GPT-6.1 Sol'], [['deepseek', 'model-b'], 'DeepSeek Flash']]);
  assert.ok(groups.every((group) => group.models.every((option) => !option.label.includes(group.provider))));
  assert.deepEqual(modelOptions([]), []);
});

test('partial and conflicting saves disclose field results and never claim complete success', () => {
  const partial = saveErrorMessage({ code: 'PARTIAL_SAVE', message: '一项写入失败', applied: ['name', 'model', 'instance', 'binding'] });
  assert.match(partial, /已保存：名字、模型、私有 Agent 实例、角色绑定/); assert.match(partial, /其余字段未确认/); assert.match(partial, /全部草稿已保留/);
  assert.match(saveErrorMessage({ code: 'PARTIAL_SAVE' }), /未提供字段清单/);
  assert.match(saveErrorMessage({ code: 'CONFLICT' }), /未自动覆盖/);
});

test('stacked image rosters select without requests; arrow keys work and failed images use a silhouette', async () => {
  const f = await setup(() => { throw new Error('Unexpected editor request'); });
  assert.equal(f.calls.length, 1); assert.equal(f.root.querySelectorAll('img').length, 5);
  const helpers = f.root.querySelector('.assistant-group').querySelectorAll('.avatar-button');
  assert.equal(helpers[1].getAttribute('aria-pressed'), 'true');
  helpers[0].click(); assert.equal(helpers[0].getAttribute('aria-pressed'), 'true'); assert.equal(f.calls.length, 1);
  helpers[0].emit('keydown', { key: 'ArrowRight' });
  assert.equal(f.document.activeElement, helpers[1]);
  const image = helpers[0].querySelector('img'); image.emit('error');
  assert.match(image.src, /^data:image\/svg\+xml/);
  assert.match(f.root.textContent, /头像图片不可用/);
  f.view.destroy(); f.view.destroy(); assert.equal(f.document.listenerCount(), 0);
  assert.ok(f.mounted.every((handle) => handle.destroyed));
});

test('GET opens preset editor without creation; only explicit save posts and pending prevents duplicate/close', async () => {
  let resolveSave;
  const f = await setup((path, init) => init.method === 'GET' ? response({ ok: true, editor: editor('role', 'main') }) : new Promise((resolve) => { resolveSave = resolve; }));
  edit(f, 'role'); await turn();
  assert.equal(f.calls.filter(({ init }) => init.method === 'POST').length, 0);
  assert.equal(f.root.querySelector('.preset-note'), null);
  assert.equal(f.root.querySelector('.field-hint'), null);
  const save = f.control('SaveButton'); assert.equal(save.props.disabled, false);
  save.props.onClick(); save.props.onClick(); await turn();
  assert.equal(f.calls.filter(({ init }) => init.method === 'POST').length, 1);
  assert.equal(f.control('Button', '关闭').props.disabled, true);
  f.document.dispatch('keydown', { key: 'Escape' }); assert.ok(f.root.querySelector('dialog'));
  assert.equal(f.control('TextInput', '名字').props.disabled, true);
  const next = { ...editor('role', 'main'), revision: 'r2', isPreset: false, agentId: 'private-fixture', model: { provider: 'new-directory', id: 'new' }, models: [{ provider: 'new-directory', id: 'new', name: '新目录条目' }] };
  resolveSave(response({ ok: true, editor: next })); await turn();
  assert.equal(save.props.status, 'saved'); assert.match(f.root.querySelector('.editor-id').textContent, /private-fixture/);
  assert.match(f.root.querySelector('.model-picker-trigger').textContent, /新目录条目/);
  assert.equal(f.root.querySelector('.preset-note'), null);
  const editButton = f.root.querySelector('.role-group').querySelector('.edit-action').querySelector('button');
  f.control('Button', '关闭').node.click(); await turn();
  assert.equal(f.root.querySelector('dialog'), null); assert.equal(f.document.activeElement, editButton);
  f.view.destroy();
});

test('model-picker Escape closes only the menu, restores trigger focus, then exits the editor on the next Escape', async () => {
  const snapshot = { ...editor(), model: { provider: 'removed-provider', id: 'retired-model' } };
  const f = await setup((path, init) => init.method === 'GET' ? response({ ok: true, editor: snapshot }) : response({ ok: true, editor: snapshot }));
  edit(f); await turn();
  const trigger = f.root.querySelector('.model-picker-trigger');
  trigger.emit('keydown', { key: 'ArrowDown' });
  const menu = f.root.querySelector('.model-picker-menu');
  const options = menu.querySelectorAll('[role="option"]');
  const unavailable = options.find((option) => option.getAttribute('data-value') === JSON.stringify(['removed-provider', 'retired-model']));
  assert.ok(unavailable?.disabled, 'unavailable current model is disabled');
  assert.equal(f.document.activeElement, options.find((option) => !option.disabled), 'ArrowDown focuses the first enabled model');
  assert.equal(menu.hidden, false);
  const escape = f.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(menu.hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(f.document.activeElement, trigger);
  assert.ok(f.root.querySelector('dialog'), 'first Escape leaves editor open');
  f.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(f.root.querySelector('dialog'), null, 'second Escape exits the editor');
  f.view.destroy();
});

test('native dialog cancel closes an expanded model menu first and returns focus to its trigger', async () => {
  const f = await setup((path, init) => init.method === 'GET' ? response({ ok: true, editor: editor() }) : response({ ok: true, editor: editor() }));
  edit(f); await turn();
  const dialog = f.root.querySelector('dialog'); const trigger = dialog.querySelector('.model-picker-trigger');
  trigger.click(); const menu = dialog.querySelector('.model-picker-menu');
  assert.equal(menu.hidden, false);
  const cancel = dialog.emit('cancel');
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(menu.hidden, true); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(f.document.activeElement, trigger);
  assert.ok(f.root.querySelector('dialog'), 'cancel while menu is open does not close the editor');
  f.view.destroy();
});

test('pending save closes model menu and ignores stale option clicks until completion and after destroy', async () => {
  let resolveSave;
  const f = await setup((path, init) => init.method === 'GET' ? response({ ok: true, editor: editor() }) : new Promise((resolve) => { resolveSave = resolve; }));
  edit(f); await turn();
  const trigger = f.root.querySelector('.model-picker-trigger'); trigger.click();
  const option = f.root.querySelectorAll('.model-picker-option').find((entry) => entry.getAttribute('data-value') === JSON.stringify(['deepseek', 'model-b']));
  assert.ok(option);
  change(f, '名字', '保存期间不允许切换');
  f.control('SaveButton').props.onClick(); await turn();
  const post = f.calls.find(({ init }) => init.method === 'POST');
  assert.equal(f.root.querySelector('.model-picker-menu').hidden, true);
  assert.equal(trigger.disabled, true);
  option.click();
  assert.deepEqual(JSON.parse(post.init.body).model, { provider: 'openai-codex', id: 'model-a' });
  resolveSave(response({ ok: true, editor: { ...editor(), name: '保存期间不允许切换', revision: 'r2' } })); await turn();
  assert.equal(trigger.textContent.includes('GPT-6.1 Sol'), true);
  f.view.destroy();
  option.click();
  assert.equal(f.calls.filter(({ init }) => init.method === 'POST').length, 1);
});

test('failed save preserves all text/model drafts; unsaved close uses inline decisions and focus is trapped', async () => {
  const f = await setup((path, init) => init.method === 'GET' ? response({ ok: true, editor: editor() }) : response({ ok: false, error: { code: 'SAVE_FAILED', message: '写入失败' } }, false));
  edit(f); await turn();
  change(f, '名字', '草稿名字'); change(f, '罗马字名', 'Draft'); change(f, '身份简介', '草稿简介'); change(f, 'AGENTS.md', '草稿职责');
  selectModel(f, 'deepseek', 'model-b');
  f.control('SaveButton').props.onClick(); await turn();
  assert.equal(f.control('TextInput', '名字').props.value, '草稿名字');
  assert.equal(f.control('TextArea', '身份简介').props.value, '草稿简介');
  assert.equal(f.control('TextArea', 'AGENTS.md').props.value, '草稿职责');
  assert.match(f.root.querySelector('.model-picker-trigger').textContent, /DeepSeek Flash/);
  assert.match(f.root.querySelector('.editor-message').textContent, /写入失败/);
  assert.equal(f.control('SaveButton').props.disabled, false);
  const post = f.calls.find(({ init }) => init.method === 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { revision: 'r1', name: '草稿名字', latinName: 'Draft', identity: '草稿简介', agentsMd: '草稿职责', model: { provider: 'deepseek', id: 'model-b' } });
  const close = f.control('Button', '关闭'); close.node.focus();
  const tab = f.document.dispatch('keydown', { key: 'Tab' }); assert.equal(tab.defaultPrevented, true); assert.notEqual(f.document.activeElement, close.node);
  f.document.dispatch('keydown', { key: 'Escape' }); await turn();
  assert.equal(f.root.querySelector('.discard-confirmation').hidden, false);
  f.control('Button', '继续编辑').node.click(); assert.equal(f.root.querySelector('.discard-confirmation').hidden, true);
  assert.equal(f.control('TextInput', '名字').props.value, '草稿名字');
  close.node.click(); f.control('Button', '放弃更改').node.click(); await turn();
  assert.equal(f.root.querySelector('dialog'), null); f.view.destroy();
});

for (const code of ['PARTIAL_SAVE', 'CONFLICT']) test(`${code}: drafts and old revision remain; no automatic retry/overwrite`, async () => {
  const f = await setup((path, init) => init.method === 'GET' ? response({ ok: true, editor: editor() }) : response({ ok: false, error: { code, message: '保存未完成', ...(code === 'PARTIAL_SAVE' ? { applied: ['name'] } : {}) } }, false));
  edit(f); await turn(); change(f, '名字', '保留草稿'); change(f, 'AGENTS.md', '未保存职责');
  const save = f.control('SaveButton'); save.props.onClick(); await turn();
  assert.equal(save.props.status, 'idle'); assert.equal(save.props.disabled, true);
  assert.equal(f.control('TextInput', '名字').props.value, '保留草稿');
  assert.equal(f.control('TextArea', 'AGENTS.md').props.value, '未保存职责');
  assert.match(f.root.querySelector('.editor-message').textContent, code === 'PARTIAL_SAVE' ? /已保存：名字/ : /未自动覆盖/);
  save.props.onClick(); await turn();
  assert.equal(f.calls.filter(({ init }) => init.method === 'POST').length, 1);
  assert.equal(JSON.parse(f.calls.at(-1).init.body).revision, 'r1'); f.view.destroy();
});

test('avatar compression accepts only image types, bounds dimensions/data, and always revokes object URLs', async () => {
  const f = environment();
  const data = await compressAvatar({ type: 'image/jpeg', size: 1000 }, f.document);
  assert.match(data, /^data:image\/png;base64,/); assert.equal(f.canvases[0].width, 256); assert.equal(f.canvases[0].height, 128);
  assert.deepEqual(f.revoked, ['blob:fixture']);
  await assert.rejects(compressAvatar({ type: 'image/svg+xml', size: 100 }, f.document), /PNG、JPEG 或 WebP/);
  await assert.rejects(compressAvatar({ type: 'image/png', size: 9 * 1024 * 1024 }, f.document), /8 MB/);
  const create = f.document.createElement;
  f.document.createElement = (tag) => { const element = create(tag); if (tag === 'canvas') element.toDataURL = () => `data:image/png;base64,${'a'.repeat(512 * 1024)}`; return element; };
  await assert.rejects(compressAvatar({ type: 'image/webp', size: 100 }, f.document), /512 KB/);
  assert.equal(f.revoked.length, 2);
});

test('uploaded image is only a draft until save and remains present after a failed save', async () => {
  const f = await setup((path, init) => init.method === 'GET' ? response({ ok: true, editor: editor() }) : response({ ok: false, error: { message: '请稍后重试' } }, false));
  edit(f); await turn();
  const file = f.root.querySelectorAll('input').find((element) => element.type === 'file');
  file.files = [{ type: 'image/png', size: 1000 }]; file.emit('change'); await turn();
  assert.equal(f.calls.filter(({ init }) => init.method === 'POST').length, 0);
  assert.match(f.root.querySelector('.editor-avatar').querySelector('img').src, /^data:image\/png/);
  f.control('SaveButton').props.onClick(); await turn();
  const body = JSON.parse(f.calls.find(({ init }) => init.method === 'POST').init.body);
  assert.match(body.avatarDataUrl, /^data:image\/png;base64,/);
  assert.match(f.root.querySelector('.editor-avatar').querySelector('img').src, /^data:image\/png/);
  f.view.destroy(); assert.equal(f.document.listenerCount(), 0);
});

test('only an early panel registration miss retries once; unknown errors remain visible', async () => {
  for (const miss of [() => new Response('Not Found', { status: 404 }),
    () => Response.json({ error: { code: 'MATH_BOOTSTRAP_PENDING' } }, { status: 503 })]) {
    const f = environment(), timers = [], calls = [];
    f.document.defaultView.setTimeout = (callback) => { timers.push(callback); return callback; };
    f.document.defaultView.clearTimeout = (callback) => { timers.splice(timers.indexOf(callback), 1); };
    const view = f.mount(f.root, { request: async (path, init) => {
      calls.push([path, init.method]); return calls.length === 1 ? miss() : response(panel());
    } });
    await turn();
    assert.deepEqual(calls, [['/panel', 'GET']]); assert.equal(timers.length, 1);
    timers.shift()(); await view.ready;
    assert.deepEqual(calls, [['/panel', 'GET'], ['/panel', 'GET']]);
    assert.ok(f.root.querySelectorAll('.member-name').some(node => node.textContent === '主助手'));
    assert.ok(f.root.querySelectorAll('.member-name').some(node => node.textContent === 'main'));
    view.destroy();
  }
  for (const miss of [() => Response.json({ error: { code: 'MATH_BOOTSTRAP_UNAVAILABLE' } }, { status: 503 }),
    () => Response.json({ error: { code: 'UNKNOWN' } }, { status: 503 }),
    () => { throw Object.assign(Error('unknown transport failure'), { status: 404 }); },
    () => Response.json({ assistants: { state: 'ready' }, roles: { state: 'ready' } })]) {
    const f = environment(); let calls = 0;
    f.document.defaultView.setTimeout = () => assert.fail('unknown or closed route must not retry');
    const view = f.mount(f.root, { request: async () => { calls++; return miss(); } });
    await view.ready; assert.equal(calls, 1);
    assert.match(f.root.textContent, /暂时无法读取助手/); assert.doesNotMatch(f.root.textContent, /暂无可显示的助手/);
    view.destroy();
  }
});

test('panel registration retry neither repeats indefinitely nor survives unmount', async () => {
  for (const destroy of [false, true]) {
    const f = environment(), timers = new Set(); let calls = 0;
    f.document.defaultView.setTimeout = callback => { timers.add(callback); return callback; };
    f.document.defaultView.clearTimeout = callback => timers.delete(callback);
    const view = f.mount(f.root, { request: async () => { calls++; return new Response('Not Found', { status: 404 }); } });
    await turn(); assert.equal(timers.size, 1);
    if (destroy) view.destroy();
    else { const [retry] = timers; timers.delete(retry); retry(); }
    await view.ready;
    assert.equal(calls, destroy ? 1 : 2); assert.equal(timers.size, 0);
    if (!destroy) { assert.match(f.root.textContent, /暂时无法读取助手/); view.destroy(); }
  }
});

test('empty and failed panels stay distinct; failed editor GET never exposes save or creates an Agent', async () => {
  for (const [payload, expected] of [
    [{ assistants: { state: 'ready', items: [] }, roles: { state: 'ready', items: [] } }, '暂无可显示的助手'],
    [{ assistants: { state: 'error', items: [] }, roles: { state: 'error', items: [] } }, '暂时无法读取助手'],
  ]) {
    const f = environment(); const view = f.mount(f.root, { request: async () => response(payload) });
    await view.ready; assert.match(f.root.textContent, new RegExp(expected)); assert.equal(f.root.querySelectorAll('img').length, 0); view.destroy();
  }
  const f = await setup(() => response({ ok: false, error: { code: 'FORBIDDEN', message: '没有编辑权限' } }, false));
  edit(f); await turn(); assert.match(f.root.querySelector('.editor-message').textContent, /没有编辑权限/);
  assert.equal(f.control('SaveButton'), undefined); assert.equal(f.calls.length, 2); f.view.destroy();
});

test('unavailable model remains unchanged; selections cannot invent a model outside the server directory', async () => {
  const snapshot = { ...editor(), model: { provider: 'unavailable', id: 'original' } };
  const f = await setup((path, init) => init.method === 'GET' ? response({ ok: true, editor: snapshot }) : response({ ok: false, error: { message: '测试失败' } }, false));
  edit(f); await turn(); const trigger = f.root.querySelector('.model-picker-trigger');
  const currentValue = JSON.stringify([snapshot.model.provider, snapshot.model.id]);
  assert.equal(trigger.textContent.includes('original'), true);
  trigger.click();
  const unavailable = f.root.querySelectorAll('.model-picker-option').find((option) => option.getAttribute('data-value') === currentValue);
  assert.equal(unavailable.textContent, 'original（当前不可用）');
  assert.equal(unavailable.disabled, true);
  assert.equal(f.root.querySelectorAll('.model-picker-option').some((option) => option.getAttribute('data-value') === JSON.stringify(['invented', 'not-in-directory'])), false);
  change(f, '名字', '修改名字'); f.control('SaveButton').props.onClick(); await turn();
  assert.deepEqual(JSON.parse(f.calls.at(-1).init.body).model, snapshot.model); f.view.destroy();
});

test('template-backed profile fields render without explanatory helper text', async () => {
  const snapshot = { ...editor(), personaSources: { identity: 'template', agentsMd: 'agent' } };
  const f = await setup((path, init) => init.method === 'GET' ? response({ ok: true, editor: snapshot }) : response({ ok: true, editor: { ...snapshot, identity: '自定义简介', revision: 'r2', personaSources: { identity: 'agent', agentsMd: 'agent' } } }));
  edit(f); await turn();
  assert.equal(f.root.querySelector('.field-hint'), null);
  change(f, '身份简介', '自定义简介');
  f.control('SaveButton').props.onClick(); await turn();
  assert.equal(f.root.querySelector('.field-hint'), null);
  f.view.destroy();
});

for (const [instanceState, label] of [['retired', '退役'], ['missing', '丢失']]) test(`${instanceState} preset explains replacement without claiming an original-instance mutation`, async () => {
  const f = await setup(() => response({ ok: true, editor: { ...editor('role', 'main'), instanceState } }));
  edit(f, 'role'); await turn();
  assert.equal(f.root.querySelector('.preset-note'), null);
  assert.equal(f.calls.filter(({ init }) => init.method === 'POST').length, 0);
  f.view.destroy();
});

test('recovered real instance does not display preset creation or replacement wording', async () => {
  const f = await setup(() => response({ ok: true, editor: { ...editor('role', 'main'), instanceState: 'recovered', isPreset: false, agentId: 'recovered-agent' } }));
  edit(f, 'role'); await turn();
  assert.equal(f.root.querySelector('.preset-note'), null); f.view.destroy();
});

test('model picker groups providers and requires an explicit model when no choice is configured', async () => {
  for (const kind of ['assistant', 'role']) {
    const snapshot = { ...editor(kind, kind === 'role' ? 'main' : 'primary'), model: null, models: [] };
    const f = await setup((path, init) => init.method === 'GET' ? response({ ok: true, editor: snapshot }) : response({ ok: true, editor: { ...snapshot, model: null, name: '修改名字', revision: 'r2' } }));
    edit(f, kind); await turn();
    const trigger = f.root.querySelector('.model-picker-trigger');
    assert.ok(trigger, f.root.querySelector('.editor-message')?.textContent || 'model picker was not rendered');
    assert.match(trigger.textContent, /未选择模型/);
    assert.equal(f.root.querySelector('.model-hint'), null);
    assert.equal(f.control('SaveButton').props.disabled, true);
    trigger.click();
    assert.match(f.root.querySelector('.model-picker-menu').textContent, /当前没有可用模型/);
    assert.doesNotMatch(f.root.textContent, /跟随默认模型/);
    change(f, '名字', '修改名字'); f.control('SaveButton').props.onClick(); await turn();
    assert.equal(f.calls.some(({ init }) => init.method === 'POST'), false);
    f.view.destroy();
  }
});

test('an explicit choice from the provider groups unlocks save for assistants and roles', async () => {
  for (const kind of ['assistant', 'role']) {
    const snapshot = { ...editor(kind, kind === 'role' ? 'main' : 'primary'), model: null };
    const chosen = { provider: 'deepseek', id: 'model-b' };
    const f = await setup((path, init) => init.method === 'GET' ? response({ ok: true, editor: snapshot }) : response({ ok: true, editor: { ...snapshot, model: chosen, name: '修改名字', revision: 'r2', isPreset: false, agentId: kind === 'role' ? 'private-role' : snapshot.agentId } }));
    edit(f, kind); await turn();
    assert.equal(f.control('SaveButton').props.disabled, true);
    selectModel(f, chosen.provider, chosen.id);
    assert.match(f.root.querySelector('.model-picker-trigger').textContent, /DeepSeek Flash/);
    assert.equal(f.root.querySelector('.model-hint'), null);
    change(f, '名字', '修改名字'); assert.equal(f.control('SaveButton').props.disabled, false);
    f.control('SaveButton').props.onClick(); await turn();
    assert.deepEqual(JSON.parse(f.calls.find(({ init }) => init.method === 'POST').init.body).model, chosen);
    f.view.destroy();
  }
});

test('closing a still-loading editor cancels its GET without creating or saving', async () => {
  let resolve;
  const f = await setup(() => new Promise((done) => { resolve = done; }));
  edit(f); await turn(); const signal = f.calls.at(-1).init.signal;
  f.control('Button', '关闭').node.click(); assert.equal(signal.aborted, true);
  resolve(response({ ok: true, editor: editor() })); await turn();
  assert.equal(f.root.querySelector('dialog'), null); assert.equal(f.calls.length, 2); f.view.destroy();
});

test('destroy aborts pending reads and detached callbacks cannot save', async () => {
  let resolve;
  const f = await setup(() => new Promise((done) => { resolve = done; }));
  edit(f); await turn(); const signal = f.calls.at(-1).init.signal;
  f.view.destroy(); assert.equal(signal.aborted, true); assert.equal(f.document.listenerCount(), 0);
  resolve(response({ ok: true, editor: editor() })); await turn(); assert.equal(f.root.children.length, 0);
  const live = await setup(() => response({ ok: true, editor: editor() }));
  edit(live); await turn(); change(live, '名字', '草稿'); const staleSave = live.control('SaveButton').props.onClick;
  live.view.destroy(); staleSave(); await turn(); assert.equal(live.calls.filter(({ init }) => init.method === 'POST').length, 0);
});
