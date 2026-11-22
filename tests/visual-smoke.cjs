// Isolated software fixture only. No Hana SDK, host URLs, credentials or real Agents.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', 'visual');
const userData = path.join(output, `electron-user-data-${process.pid}`);
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.setAppLogsPath(path.join(userData, 'logs'));
const result = { suite: 'Hana Math isolated software fixture (not host acceptance)', electron: process.versions.electron, assertions: [], screenshots: {}, consoleErrors: [], blockedRequests: [] };
let window;
let server;
let phase = 'startup';
const layoutOnly = process.argv.includes('--layout-only');
const EXPECTED_ASSERTIONS = layoutOnly ? 4 : 31;
const rendererErrors = [];
const processErrors = [];
app.on('window-all-closed', (event) => event.preventDefault());
process.on('uncaughtExceptionMonitor', (error) => { processErrors.push(`${error.name}: ${error.message}`); });
process.on('unhandledRejection', (reason) => { processErrors.push(`unhandledRejection: ${reason?.stack || reason}`); });
const deadline = setTimeout(() => { console.error('VISUAL_FIXTURE_TIMEOUT'); server?.kill('SIGTERM'); app.exit(1); }, 120000);
deadline.unref();

function check(label, condition, details) {
  assert.ok(condition, `${label}${details ? `: ${JSON.stringify(details)}` : ''}`);
  result.assertions.push({ label, details });
  console.log(`PASS isolated software fixture: ${label}`);
}
async function evaluate(fn, ...args) {
  return window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
}
async function waitFor(predicate, label, ...args) {
  return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const predicate = (${predicate.toString()}); const args = ${JSON.stringify(args)};
    let frame; let observer; let timer;
    const finish = (error, value) => { clearTimeout(timer); cancelAnimationFrame(frame); observer?.disconnect(); error ? reject(error) : resolve(value); };
    const inspect = () => { try { const value = predicate(...args); if (value) { finish(null, value); return true; } } catch (error) { finish(error); return true; } return false; };
    const tick = () => { if (!inspect()) frame = requestAnimationFrame(tick); };
    timer = setTimeout(() => finish(new Error(${JSON.stringify(`Timed out: ${label}`)})), 7000);
    observer = new MutationObserver(inspect); observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    tick();
  })`);
}
async function screenshot(name) {
  const file = path.join(output, `${name}.png`);
  await evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const image = await window.webContents.capturePage();
  await fs.writeFile(file, image.toPNG());
  result.screenshots[name] = file;
  return file;
}
async function point(selector, text) {
  return evaluate((selector, text) => {
    const candidates = [...document.querySelectorAll(selector)];
    const element = text ? candidates.find((node) => node.textContent.includes(text)) : candidates[0];
    if (!element) throw new Error(`Missing element ${selector} ${text || ''}`);
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2); const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    const style = getComputedStyle(element);
    return {
      x, y, width: rect.width, height: rect.height,
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      ariaBusy: element.getAttribute('aria-busy'), blockedByBusyAncestor: Boolean(element.closest('[aria-busy="true"]')),
      visible: style.display !== 'none' && style.visibility !== 'hidden' && !element.closest('[hidden]'),
      hit: Boolean(hit && (hit === element || element.contains(hit))),
      target: element.outerHTML.slice(0, 1200), hitElement: hit?.outerHTML.slice(0, 1200), inModal: Boolean(element.closest('dialog:modal')),
    };
  }, selector, text);
}
async function click(selector, text) {
  const reveal = await evaluate((selector, text) => {
    const element = [...document.querySelectorAll(selector)].find((node) => !text || node.textContent.includes(text));
    const stage = element?.closest('.member-group')?.querySelector('.avatar-stage');
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }, selector, text);
  if (reveal) window.webContents.sendInputEvent({ type: 'mouseMove', x: reveal.x, y: reveal.y });
  await waitFor((selector, text) => {
    const element = [...document.querySelectorAll(selector)].find((node) => !text || node.textContent.includes(text));
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
    if (!(rect.width > 0 && rect.height > 0) || style.display === 'none' || style.visibility === 'hidden' || element.closest('[hidden]')) return false;
    if (element.disabled || element.getAttribute('aria-disabled') === 'true' || element.getAttribute('aria-busy') === 'true' || element.closest('[aria-busy="true"]')) return false;
    const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
    return Boolean(hit && (hit === element || element.contains(hit)));
  }, `visible, enabled, not busy and hit-testable: ${selector}`, selector, text);
  let target = await point(selector, text);
  assert.ok(target.visible && !target.disabled && target.ariaBusy !== 'true' && !target.blockedByBusyAncestor && target.hit, `Control became unavailable before real click: ${JSON.stringify(target)}`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y });
  await waitFor((selector, text) => {
    const element = [...document.querySelectorAll(selector)].find((node) => !text || node.textContent.includes(text));
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
    if (!(rect.width > 0 && rect.height > 0) || style.display === 'none' || style.visibility === 'hidden' || element.closest('[hidden]')) return false;
    if (element.disabled || element.getAttribute('aria-disabled') === 'true' || element.getAttribute('aria-busy') === 'true' || element.closest('[aria-busy="true"]')) return false;
    const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
    return Boolean(hit && (hit === element || element.contains(hit)));
  }, `interactive mouse target after hover: ${selector}`, selector, text);
  target = await point(selector, text);
  assert.ok(target.hit && target.visible && !target.disabled && target.ariaBusy !== 'true' && !target.blockedByBusyAncestor, `Real mouse target is not interactive (possible native-dialog inert portal): ${JSON.stringify(target)}`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  return target;
}
async function key(keyCode) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
}
async function fill(selector, value) {
  await click(selector);
  await waitFor((selector) => {
    const element = document.querySelector(selector);
    return element && document.activeElement === element;
  }, `focus before selecting ${selector}`, selector);
  await evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await evaluate((selector) => { const element = document.querySelector(selector); element.setSelectionRange(0, element.value.length); }, selector);
  let selection;
  try {
    selection = await waitFor((selector) => {
      const element = document.querySelector(selector);
      return element && document.activeElement === element && element.selectionStart === 0 && element.selectionEnd === element.value.length
        ? { focused: true, start: element.selectionStart, end: element.selectionEnd, valueLength: element.value.length }
        : false;
    }, `focus and full selection range for ${selector}`, selector);
  } catch (error) {
    const observed = await evaluate((selector) => {
      const element = document.querySelector(selector);
      return element && { focused: document.activeElement === element, selectionStart: element.selectionStart, selectionEnd: element.selectionEnd, valueLength: element.value.length, readOnly: element.readOnly, disabled: element.disabled, value: element.value };
    }, selector);
    throw new Error(`${error.message}; selection diagnostic: ${JSON.stringify(observed)}`);
  }
  assert.equal(selection.end, selection.valueLength, `Input must be fully selected before replacement: ${JSON.stringify(selection)}`);
  await window.webContents.insertText(value);
  await waitFor((selector, value) => document.querySelector(selector)?.value === value, `input retains ${selector}`, selector, value);
}
async function startPreview() {
  server = spawn('node', [path.join(__dirname, 'preview-server.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Preview startup timeout: ${stderr}`)); }, 10000);
    const cleanup = () => { clearTimeout(timer); server.removeListener('error', failed); server.removeListener('exit', exited); server.stdout.removeListener('data', ready); };
    const failed = (error) => { cleanup(); reject(error); };
    const exited = (code) => failed(new Error(`Own preview exited ${code}: ${stderr}`));
    const ready = (chunk) => {
      stdout += chunk;
      const match = /PREVIEW_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (match) { cleanup(); resolve(match[1]); }
    };
    server.on('error', failed); server.on('exit', exited); server.stdout.on('data', ready);
  });
}
const nameInput = 'dialog input[aria-label="名字"]';
const latinInput = 'dialog input[aria-label="罗马字名"]';
const identityInput = 'dialog textarea[aria-label="身份简介"]';
const agentsInput = 'dialog textarea[aria-label="AGENTS.md"]';
const modelTrigger = '.model-field [role="combobox"], .model-field button, .model-field [aria-expanded]';
const optionSelector = '[role="option"], [role="listbox"] [data-value], [role="menuitem"], .hana-select-option';
async function open(kind) {
  await click(`.${kind}-group .edit-action button`);
  await waitFor((selectors) => Boolean(document.querySelector('dialog:modal .editor-content:not([hidden])') && selectors.every((selector) => document.querySelector(selector))), `${kind} native modal and all official inputs`, [nameInput, latinInput, identityInput, agentsInput]);
  const controls = await evaluate((selectors) => selectors.map((selector) => {
    const element = document.querySelector(selector);
    return { selector, exists: Boolean(element), disabled: Boolean(element?.disabled) };
  }), [nameInput, latinInput, identityInput, agentsInput]);
  check(`${kind} editor uses native modal and official editable controls`, controls.every((control) => control.exists && !control.disabled), controls);
}
async function cleanClose(kind) {
  await key('Escape');
  await waitFor((kind) => !document.querySelector('dialog') && document.activeElement === document.querySelector(`.${kind}-group .edit-action button`), 'clean Escape restores edit focus', kind);
  check(`${kind} clean Escape closes and restores edit-button focus`, true);
}
async function fieldsMatch(values) {
  return evaluate((values) => Object.entries(values).every(([selector, value]) => document.querySelector(selector)?.value === value), values);
}

async function run() {
  await fs.mkdir(output, { recursive: true });
  for (const name of ['failure.png', 'select-portal-failure.png']) await fs.rm(path.join(output, name), { force: true });
  const origin = await startPreview();
  result.origin = origin;
  await app.whenReady();
  app.dock?.hide();
  window = new BrowserWindow({ show: false, width: 1100, height: 900, useContentSize: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, partition: `visual-fixture-${process.pid}` } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault(); });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(`${origin}/`) || /^(data|blob):/.test(details.url);
    if (!allowed) result.blockedRequests.push(details.url);
    callback({ cancel: !allowed });
  });
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') result.consoleErrors.push(`${details.sourceId}:${details.lineNumber} ${details.message}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(`${details.reason}: ${details.exitCode}`));
  window.webContents.on('unresponsive', () => rendererErrors.push('renderer became unresponsive'));
  await window.loadURL(`${origin}/`);
  if (layoutOnly) {
    phase = 'targeted compact editor and model menu check';
    await open('assistant');
    const dialogLayout = await evaluate(() => {
      const rect = document.querySelector('dialog').getBoundingClientRect(); const modelNode = document.querySelector('.model-picker-trigger'); const model = modelNode.getBoundingClientRect(); const peerNode = document.querySelector('.field-latinName input'); const peer = peerNode.getBoundingClientRect(); const chevron = document.querySelector('.model-picker-chevron').getBoundingClientRect(); const save = document.querySelector('.save-row button').getBoundingClientRect();
      return { viewport: { width: innerWidth, height: innerHeight }, dialog: { width: rect.width, height: rect.height }, model: { width: model.width, height: model.height, fontSize: getComputedStyle(modelNode).fontSize }, peer: { width: peer.width, height: peer.height, fontSize: getComputedStyle(peerNode).fontSize }, chevron: { width: chevron.width, height: chevron.height }, saveRightGap: rect.right - save.right };
    });
    check('outer editor leaves horizontal margins and follows near-full-height Code proportions', dialogLayout.dialog.width <= dialogLayout.viewport.width * 0.85 && dialogLayout.dialog.height <= dialogLayout.viewport.height * 0.97 && dialogLayout.dialog.height >= dialogLayout.viewport.height * 0.9, dialogLayout);
    check('model selector matches the adjacent input size and typography', Math.abs(dialogLayout.model.width - dialogLayout.peer.width) <= 1 && Math.abs(dialogLayout.model.height - dialogLayout.peer.height) <= 1 && dialogLayout.model.fontSize === dialogLayout.peer.fontSize && dialogLayout.chevron.width <= 9 && dialogLayout.chevron.height <= 9 && dialogLayout.saveRightGap >= 20 && dialogLayout.saveRightGap <= 30, dialogLayout);
    await screenshot('editor-compact');
    await click(modelTrigger);
    await waitFor((selector) => [...document.querySelectorAll(selector)].some((option) => option.textContent.includes('另一测试模型')), 'grouped model options appear', optionSelector);
    const modelLayout = await evaluate(() => {
      const menu = document.querySelector('.model-picker-menu'); const trigger = document.querySelector('.model-picker-trigger');
      return { width: menu.getBoundingClientRect().width, triggerWidth: trigger.getBoundingClientRect().width, height: menu.getBoundingClientRect().height, optionPaddingLeft: Number.parseFloat(getComputedStyle(menu.querySelector('.model-picker-option')).paddingLeft) };
    });
    check('model list is compact and has no empty icon gutter', modelLayout.width <= 280 && modelLayout.width <= modelLayout.triggerWidth + 1 && modelLayout.height <= 180 && modelLayout.optionPaddingLeft <= 8, modelLayout);
    await screenshot('model-picker-compact');
    result.ok = true;
    return;
  }
  phase = 'images and collapsed stacks';
  await waitFor(() => document.querySelectorAll('.avatar-button img').length === 5 && [...document.querySelectorAll('.avatar-button img')].every((image) => image.complete && image.naturalWidth > 0), 'five real portrait images');
  const images = await evaluate(() => [...document.querySelectorAll('.avatar-button img')].map((image) => ({ src: image.getAttribute('src'), width: image.naturalWidth, height: image.naturalHeight })));
  check('2 assistant and 3 role raster portraits load without fallback', images.length === 5 && images.every((image) => image.width > 0 && image.src.startsWith('./assets/avatars/') && image.src.endsWith('.png')), images);
  const stackMetrics = await evaluate(() => [...document.querySelectorAll('.member-group')].map((group) => ({ count: group.querySelectorAll('.avatar-button').length, widths: [...group.querySelectorAll('.avatar-button')].map((button) => button.getBoundingClientRect().width), step: group.querySelectorAll('.stack-member')[1].getBoundingClientRect().x - group.querySelectorAll('.stack-member')[0].getBoundingClientRect().x })));
  check('both collapsed stacks use 64px portraits with 24px overlapping step', stackMetrics.every((group) => group.widths.every((width) => Math.abs(width - 64) < 0.1) && Math.abs(group.step - 24) < 0.1), stackMetrics);
  await screenshot('desktop');

  phase = 'expanded stacks and selection';
  await click('.assistant-group [data-member-id="shiraha"]');
  const rolePoint = await point('.role-group .avatar-stage');
  window.webContents.sendInputEvent({ type: 'mouseMove', x: rolePoint.x, y: rolePoint.y });
  await waitFor(() => [...document.querySelectorAll('.member-group')].every((group) => parseFloat(getComputedStyle(group.querySelectorAll('.stack-member')[1]).marginInlineStart) > 17.5), 'focus and hover expand both stacks');
  check('focus/hover expands both 2/3-member stacks with visible labels', await evaluate(() => [...document.querySelectorAll('.member-name')].every((element) => getComputedStyle(element).visibility === 'visible')));
  await screenshot('expanded');
  await click('.assistant-group [data-member-id="xiaojingyu"]');
  await waitFor(() => document.querySelector('.assistant-group [data-member-id="xiaojingyu"]')?.getAttribute('aria-pressed') === 'true', 'assistant selection');
  const rings = await evaluate(() => [...document.querySelectorAll('.assistant-group .avatar-button')].map((button) => ({ selected: button.getAttribute('aria-pressed'), shadow: getComputedStyle(button).boxShadow, dot: getComputedStyle(button.querySelector('.selection-dot')).display })));
  check('real click updates one aria-pressed selection and visible ring/dot', rings.filter((ring) => ring.selected === 'true').length === 1 && rings[1].dot !== 'none' && rings[0].shadow !== rings[1].shadow, rings);
  await click('.assistant-group [data-member-id="shiraha"]');
  await click('.role-group [data-member-id="worker"]');
  await waitFor(() => document.querySelector('.role-group [data-member-id="worker"]')?.getAttribute('aria-pressed') === 'true', 'role selection');
  check('role avatar selection also updates aria-pressed', true);

  phase = 'assistant editor and native-modal Select hit-testing';
  await open('assistant');
  const initialEditorLayout = await evaluate(() => {
    const dialog = document.querySelector('dialog'); const rect = dialog.getBoundingClientRect();
    const upper = document.querySelector('.editor-upper'); const save = document.querySelector('.save-row button');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialog: { width: rect.width, height: rect.height, backdrop: getComputedStyle(dialog, '::backdrop').backgroundColor },
      areas: getComputedStyle(upper).gridTemplateAreas,
      fields: ['.editor-left', '.field-name', '.model-field', '.field-latinName'].map((selector) => getComputedStyle(document.querySelector(selector)).gridArea),
      save: { position: getComputedStyle(document.querySelector('.save-row')).position, top: save.getBoundingClientRect().top, bottom: save.getBoundingClientRect().bottom, visible: getComputedStyle(save).visibility !== 'hidden' },
    };
  });
  check('editor keeps clear horizontal margins, near-full-height Code layout, and reference grid', initialEditorLayout.dialog.width <= initialEditorLayout.viewport.width * 0.85 && initialEditorLayout.dialog.height <= initialEditorLayout.viewport.height * 0.97 && initialEditorLayout.dialog.height >= initialEditorLayout.viewport.height * 0.9 && initialEditorLayout.dialog.backdrop === 'rgba(0, 0, 0, 0)' && initialEditorLayout.fields.join(',') === 'avatar,name,model,latin', initialEditorLayout);
  check('save stays visible in the editor scroll area before scrolling long persona text', initialEditorLayout.save.position === 'sticky' && initialEditorLayout.save.visible && initialEditorLayout.save.top >= 0 && initialEditorLayout.save.bottom <= initialEditorLayout.viewport.height, initialEditorLayout.save);
  await screenshot('editor');
  const longAgents = '# 人格定义\n\n- 先确定本轮目标、假设、范围和交付标准。\n- 将问题拆成可验证的子目标，并说明每个子目标之间的依赖关系。\n- 区分已核实事实、推测和未验证内容，不把候选结果当成结论。\n- 先检查证据，再给出结论；证据不足时说明还缺少哪些信息。\n- 保留关键约束、停止条件、错误处理方式和明确交付要求。\n- 对复杂任务列出可执行步骤，并检查各步骤之间是否冲突。\n- 每次修改前确认目标文件和允许的改动范围。\n- 保存前逐项复核名称、模型、身份简介和完整指令。\n- 发生冲突、部分失败或权限拒绝时保留草稿并停止覆盖。\n- 只使用已经授权的接口和资源，不读取底层目录或凭据。\n- 不把预览数据、示例文字或测试结果写入真实配置。\n- 对不确定内容明确说明，并指出哪些部分尚未核验。\n- 要求与已有指令冲突时先停止并报告，不擅自扩大任务范围。\n- 交付前检查功能状态、键盘焦点、滚动区域和窄屏布局。\n- 保持回答准确、克制，删去证据无法支持的承诺。\n- 完成后记录验证命令、实际结果和仍然存在的限制。';
  const values = { [nameInput]: 'Shiraha Fixture Saved', [latinInput]: 'Shiraha Test', [identityInput]: 'Isolated software fixture identity.\n不是宿主 Agent 人格。', [agentsInput]: longAgents };
  for (const [selector, value] of Object.entries(values)) await fill(selector, value);
  await click(modelTrigger);
  await waitFor((selector) => [...document.querySelectorAll(selector)].some((option) => option.textContent.includes('另一测试模型')), 'grouped model options appear in the editor', optionSelector);
  const providerMenu = await evaluate(() => {
    const menu = document.querySelector('.model-picker-menu'); const trigger = document.querySelector('.model-picker-trigger');
    return { text: menu.textContent, selected: trigger.textContent, menuWidth: menu.getBoundingClientRect().width, triggerWidth: trigger.getBoundingClientRect().width, menuHeight: menu.getBoundingClientRect().height, scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight, optionPaddingLeft: Number.parseFloat(getComputedStyle(menu.querySelector('.model-picker-option')).paddingLeft) };
  });
  check('model picker groups providers and displays model names without a default entry', ['DeepSeek', 'OpenAI Codex (OAuth)', 'xAI Grok (OAuth)', 'Zivelian'].every((label) => providerMenu.text.includes(label)) && !providerMenu.text.includes('跟随默认模型') && !providerMenu.selected.includes('openai-codex'), providerMenu);
  check('model menu fits its trigger, caps at 180px, and has no empty icon gutter', providerMenu.menuWidth <= providerMenu.triggerWidth + 1 && providerMenu.menuHeight <= 180 && providerMenu.scrollHeight >= providerMenu.clientHeight && providerMenu.optionPaddingLeft <= 8, providerMenu);
  await screenshot('model-picker');
  const option = await point(optionSelector, '另一测试模型');
  result.selectHitTest = option;
  if (!option.hit) { await screenshot('editor'); await screenshot('model-picker-hit-test-failure'); }
  check('grouped provider option is hit-testable inside the editor dialog', option.hit, option);
  await click(optionSelector, '另一测试模型');
  await waitFor(() => document.querySelector('.model-field')?.textContent.includes('另一测试模型'), 'real mouse chooses other model');
  check('real mouse selects the model without losing text drafts', await fieldsMatch(values));
  await screenshot('editor');

  phase = 'failed save retains draft, then successful save updates list/title';
  await evaluate(() => { window.__mathPreview.failNext = true; });
  await click('dialog .save-row button');
  await waitFor(() => document.querySelector('.editor-message')?.textContent.includes('模拟保存失败') && document.querySelector('dialog')?.getAttribute('aria-busy') === 'false', 'fixture save failure');
  check('simulated save failure retains every input, textarea and model', await fieldsMatch(values) && await evaluate(() => document.querySelector('.model-field').textContent.includes('另一测试模型') && window.__mathPreview.saves === 0));
  await click('dialog .save-row button');
  await waitFor(() => window.__mathPreview.saves === 1 && document.querySelector('.editor-header h2')?.textContent === 'Shiraha Fixture Saved', 'save title updates');
  check('fixture save success updates title and assistant list', await evaluate(() => document.querySelector('.assistant-group [data-member-id="shiraha"] .member-name').textContent === 'Shiraha Fixture Saved') && await fieldsMatch(values));
  await cleanClose('assistant');
  await open('assistant');
  check('reopened editor retains saved text and model values', await fieldsMatch(values) && await evaluate(() => document.querySelector('.model-field').textContent.includes('另一测试模型')));
  await cleanClose('assistant');

  phase = 'role controls, save, dirty-close continue/discard';
  await click('.role-group [data-member-id="main"]');
  await open('role');
  check('preset editor has no explanatory helper text', await evaluate(() => !document.querySelector('.preset-note') && !document.querySelector('.field-hint')));
  await fill(nameInput, 'Main Fixture Saved'); await fill(latinInput, 'Main Test');
  await fill(identityInput, 'Isolated role identity draft'); await fill(agentsInput, 'Isolated role instructions draft');
  await click('dialog .save-row button');
  await waitFor(() => window.__mathPreview.saves === 2 && document.querySelector('.editor-header h2')?.textContent === 'Main Fixture Saved', 'role fixture save');
  check('role save updates its list/title without real Agent activity', await evaluate(() => document.querySelector('.role-group [data-member-id="main"] .member-name').textContent === 'Main Fixture Saved'));
  await fill(nameInput, 'Discard this role draft');
  await click('dialog .editor-footer button');
  await waitFor(() => !document.querySelector('.discard-confirmation').hidden, 'dirty-close confirmation');
  await click('.discard-confirmation button', '继续编辑');
  await waitFor(() => document.querySelector('.discard-confirmation').hidden, 'continue editing');
  check('dirty-close continue preserves draft', await evaluate((selector) => document.querySelector(selector).value === 'Discard this role draft', nameInput));
  await click('dialog .editor-footer button');
  await waitFor(() => !document.querySelector('.discard-confirmation').hidden, 'dirty-close confirmation again');
  await click('.discard-confirmation button', '放弃更改');
  await waitFor(() => !document.querySelector('dialog'), 'discard closes');
  check('discard closes without saving draft', await evaluate(() => window.__mathPreview.saves === 2 && document.querySelector('.role-group [data-member-id="main"] .member-name').textContent === 'Main Fixture Saved'));

  phase = 'real 360px content viewport';
  window.setContentSize(360, 800);
  await waitFor(() => innerWidth === 360, 'real viewport width is 360');
  check('360px page has no horizontal overflow', await evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth));
  await open('role');
  const narrow = await evaluate(() => {
    const dialog = document.querySelector('dialog'); const body = dialog.querySelector('.editor-body'); const rect = dialog.getBoundingClientRect();
    return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, dialogWidth: rect.width, dialogLeft: rect.left, dialogRight: rect.right, dialogScrollWidth: dialog.scrollWidth, dialogClientWidth: dialog.clientWidth, bodyScrollHeight: body.scrollHeight, bodyClientHeight: body.clientHeight, bodyOverflowY: getComputedStyle(body).overflowY };
  });
  check('360px modal stays in viewport with a vertically scrollable body', narrow.viewport === 360 && narrow.pageWidth <= 360 && narrow.dialogLeft >= 0 && narrow.dialogRight <= 360 && narrow.dialogScrollWidth <= narrow.dialogClientWidth && narrow.bodyScrollHeight > narrow.bodyClientHeight && narrow.bodyOverflowY === 'auto', narrow);
  await screenshot('narrow');
  await evaluate(() => { const body = document.querySelector('.editor-body'); body.scrollTop = body.scrollHeight; });
  await waitFor(() => document.querySelector('.editor-body').scrollTop > 0, 'modal body really scrolls');
  check('narrow modal scrolls and retains a reachable close button', (await point('dialog .editor-footer button')).hit);
  await cleanClose('role');
  check('all requests stayed in the isolated local fixture', result.blockedRequests.length === 0, result.blockedRequests);
  check('no browser console errors', result.consoleErrors.length === 0, result.consoleErrors);
  check('renderer and process reported no fatal errors', rendererErrors.length === 0 && processErrors.length === 0, { rendererErrors, processErrors });
  result.fixture = await evaluate(() => window.__mathPreview);
  result.ok = true;
}

(async () => {
  let exitCode = 0;
  try { await run(); }
  catch (error) {
    exitCode = 1; result.ok = false; result.failedPhase = phase; result.error = { message: error.message, stack: error.stack };
    console.error(`FAIL isolated software fixture [${phase}]: ${error.stack}`);
    if (window && !window.isDestroyed()) {
      try {
        await screenshot('failure');
        result.failureDom = await evaluate(() => ({ activeElement: document.activeElement?.outerHTML.slice(0, 1000), dialogs: [...document.querySelectorAll('dialog')].map((dialog) => dialog.outerHTML.slice(0, 20000)), options: [...document.querySelectorAll('[role="option"], [role="listbox"], [aria-expanded="true"]')].map((element) => element.outerHTML.slice(0, 10000)), viewport: { width: innerWidth, height: innerHeight } }));
      } catch (captureError) { result.captureError = captureError.message; }
    }
  } finally {
    await fs.mkdir(output, { recursive: true });
    result.rendererErrors = rendererErrors;
    result.processErrors = processErrors;
    window?.destroy();
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    clearTimeout(deadline);
    result.expectedAssertions = EXPECTED_ASSERTIONS;
    result.completedAssertions = result.assertions.length;
    result.ok = result.ok === true && result.completedAssertions === EXPECTED_ASSERTIONS
      && result.consoleErrors.length === 0 && rendererErrors.length === 0 && processErrors.length === 0;
    exitCode = result.ok ? 0 : 1;
    result.expectedExitCode = exitCode;
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
    console.log(`VISUAL_FIXTURE_RESULT ${path.join(output, 'results.json')}`);
    app.exit(exitCode);
  }
})();
