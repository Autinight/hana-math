// Isolated Electron coordinate test; synthetic compositor overlay, not Hana Host.
// Run with pinned Electron, from main: <electron> tests/dashboard-chrome-coordinates.cjs
//   baseline <frozen 0.32.3 ui directory> <new output directory>
//   candidate <frozen ECC ui directory> <new output directory> <baseline receipt.json>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, protocol, session } = require('electron');

const [mode, uiArg, outputArg, referenceArg, ...extra] = process.argv.slice(2);
assert.ok(!extra.length && ['baseline', 'candidate'].includes(mode) && uiArg && outputArg && (mode === 'candidate') === Boolean(referenceArg),
  'mode, frozen UI, new output directory, and (candidate only) baseline receipt required');
const reference = referenceArg && JSON.parse(fs.readFileSync(referenceArg, 'utf8'));
if (reference) assert.ok(reference.ok && reference.mode === 'baseline' && reference.ecc === 1, 'ECC baseline receipt required');
assert.equal(process.versions.electron, '45.2.1');
assert.equal(process.versions.chrome, '156.0.8078.75');
assert.equal(process.arch, 'arm64');
const ui = fs.realpathSync(uiArg);
const output = path.resolve(outputArg);
fs.mkdirSync(output);
const profile = path.join(output, 'profile');
fs.mkdirSync(profile);
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.setAppLogsPath(path.join(profile, 'logs'));
app.disableHardwareAcceleration();
const scheme = 'math-coordinates';
const origin = `${scheme}://fixture`;
protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const bandHeight = 44;
const wingWidth = 360;
const routes = ['/dashboard/workspace.html', '/dashboard-launcher.html'];
const viewports = [[1100, 680], [375, 380]];
const overlays = ['none', 'left', 'right', 'full', 'deep'];
const tallStressHeight = 64;
const frozenCss = '6f331fe44255ec628af1b6af7b392b225fad96593ea35aae8b16c034142b9b11';
const names = ['overview', 'graph', 'memory'];
const levels = ['upper', 'center', 'lower'];
const report = { ecc: 1, mode, ui, reference: referenceArg ?? null,
  scope: 'Real Chromium input and bundled SDK wire messages; synthetic parent/obstruction only. Not real Hana Host, native chrome, or pane placement.',
  origin, runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, arch: process.arch },
  overlayModel: { heightCssPx: bandHeight, wingWidthCssPx: wingWidth, left: 'top left wing', right: 'top right wing', full: 'top full width',
    deep: `full width ${tallStressHeight}px (narrow overlap stress)`, none: 'no overlay control' },
  inputs: {}, appearance: {}, wire: {}, cases: [], adjacent: [], screenshots: [], blockedRequests: [], pageErrors: [], failures: [] };
const sha = b => createHash('sha256').update(b).digest('hex');
for (const rel of [...routes.map(r => r.slice(1)), 'assets/dashboard-launcher.css', 'dashboard/style.css', 'dashboard/landing.js', 'assets/sdk.js']) {
  report.inputs[rel] = sha(fs.readFileSync(path.join(ui, rel)));
}
assert.equal(report.inputs['assets/dashboard-launcher.css'], frozenCss, 'shared CSS must equal the 0.32.3 bytes');
if (reference) {
  for (const file of [...routes.map(r => r.slice(1)), 'assets/dashboard-launcher.css', 'dashboard/style.css', 'assets/sdk.js']) {
    assert.equal(report.inputs[file], reference.inputs[file], `${file} must equal the baseline bytes`);
  }
}

function wrapper(route) {
  const style = `html,body{margin:0;overflow:hidden;width:100%;height:100%}
  iframe{display:block;width:100%;height:100%;border:0}
  #band{position:absolute;z-index:999;inset:0;pointer-events:none}
  .piece{position:absolute;background:transparent;pointer-events:auto;touch-action:none}
  #band[data-outline="true"] .piece{outline:1px dashed #c53675;outline-offset:-1px;background:#f21e7717}
  #model-label{pointer-events:none;position:absolute;right:0;bottom:0;z-index:9999;color:#fff;background:#303044;padding:4px 7px;font:11px system-ui}`;
  return `<!doctype html><meta charset="utf-8"><title>Synthetic Host model (not Hana Host)</title><style>${style}</style>
  <iframe title="Frozen dashboard"></iframe><div id="band" aria-hidden="true"></div>
  <div id="model-label" hidden></div><script>(${installModel})(${JSON.stringify({ route, bandHeight, wingWidth, tallStressHeight, origin })})</script>`;
}
// The synthetic parent never reads the child's DOM or selectors. Its only
// hole input is the exact rectangle array received from the actual SDK wire.
function installModel({ route, bandHeight, wingWidth, tallStressHeight, origin }) {
  const frame = document.querySelector('iframe');
  const band = document.querySelector('#band');
  const caption = document.querySelector('#model-label');
  const regionsType = 'hana.surface.set-interactive-regions';
  const envelope = { protocol: 'hana.plugin.ui', version: 1 };
  const model = window.fixtureModel = { shape: 'none', honor: true, regions: [], wire: [], bandRect: null, tiles: [] };
  function subtract(a, b) {
    const l = Math.max(a[0], b[0]), t = Math.max(a[1], b[1]);
    const r = Math.min(a[2], b[2]), d = Math.min(a[3], b[3]);
    if (l >= r || t >= d) return [a];
    return [[a[0], a[1], a[2], t], [a[0], d, a[2], a[3]], [a[0], t, l, d], [r, t, a[2], d]]
      .filter(([x,y,X,Y]) => X > x && Y > y);
  }
  function paint() {
    const w = model.shape === 'left' || model.shape === 'right' ? Math.min(wingWidth, innerWidth) : innerWidth;
    const x = model.shape === 'right' ? innerWidth - w : 0;
    const h = model.shape === 'deep' ? tallStressHeight : bandHeight;
    model.bandRect = model.shape === 'none' ? null : [x, 0, x + w, h];
    let tiles = model.bandRect ? [model.bandRect] : [];
    if (model.honor && tiles.length) {
      const f = frame.getBoundingClientRect();
      for (const {x, y, width, height} of model.regions) {
        const hole = [Math.max(f.left, f.left + x), Math.max(f.top, f.top + y),
          Math.min(f.right, f.left + x + width), Math.min(f.bottom, f.top + y + height)];
        if (hole[0] < hole[2] && hole[1] < hole[3]) tiles = tiles.flatMap(tile => subtract(tile, hole));
      }
    }
    model.tiles = tiles;
    band.replaceChildren(...tiles.map(([x,y,r,b]) => {
      const tile = document.createElement('div'); tile.className = 'piece';
      Object.assign(tile.style, { left: x+'px', top: y+'px', width: (r-x)+'px', height: (b-y)+'px' });
      return tile;
    }));
  }
  model.show = (shape, honor, outline) => {
    model.shape = shape; model.honor = honor; band.dataset.outline = String(outline);
    caption.hidden = !outline;
    caption.textContent = `SYNTHETIC HOST MODEL — NOT HANA DESKTOP | ${shape} | ${honor ? 'SDK holes enabled' : 'no registration applied'}`;
    paint();
  };
  window.addEventListener('resize', paint);
  let announced = false;
  // Null-origin serialization is allowed only in this isolated custom-protocol
  // fixture; source must still be the one frozen iframe.
  const send = fields => frame.contentWindow.postMessage({ ...envelope, ...fields }, '*');
  window.addEventListener('message', event => {
    const m = event.data;
    if (event.source !== frame.contentWindow || ![origin, 'null'].includes(event.origin) ||
        m?.protocol !== envelope.protocol || m.version !== envelope.version) return;
    if (m.kind === 'event' && m.type === 'hana.ready') {
      if (!announced) {
        announced = true;
        model.wire.push({ type: m.type, kind: m.kind, origin: event.origin });
        send({ kind: 'event', type: 'hana.surface.context', payload: { appId: 'hana-math', slot: 'card', cardInstanceId: 'synthetic-ecc-fixture' } });
      }
    } else if (m.kind === 'request' && m.type === regionsType && typeof m.id === 'string') {
      const rows = m.payload?.regions;
      const valid = announced && Object.keys(m.payload ?? {}).length === 1 && Array.isArray(rows) && rows.length <= 64 && rows.every(r =>
        Object.keys(r).length === 4 && ['x','y','width','height'].every(k => Number.isFinite(r[k]) && Math.abs(r[k]) <= 1e6) && r.width > 0 && r.height > 0);
      model.wire.push({ type: m.type, kind: m.kind, id: m.id, origin: event.origin, applied: valid, regions: rows });
      if (valid) {
        model.regions = rows;
        paint();
        send({ id: m.id, kind: 'response', type: m.type, payload: { applied: true } });
      } else send({ id: m.id, kind: 'error', type: m.type, error: { code: 'BAD_MESSAGE', message: 'Synthetic Host rejected invalid regions' } });
    }
  });
  frame.src = '/api/apps/hana-math/ui' + route;
}

const mime = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf' };

let win;
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
const frames = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function overlay(shape, honor = true, outline = false) {
  await evaluate((shape, honor, outline) => window.fixtureModel.show(shape, honor, outline), shape, honor, outline);
  await frames();
}
async function panel() {
  return evaluate(() => {
    const doc = document.querySelector('iframe').contentDocument;
    return { active: [...doc.querySelectorAll('.nav-link.active')].map(el => el.dataset.tab),
      visible: [...doc.querySelectorAll('main .tab')].filter(el => getComputedStyle(el).display !== 'none' && el.getClientRects().length).map(el => el.id),
      scrollY: doc.defaultView.scrollY };
  });
}
function selected(observed, name) {
  return observed.active.join() === name && observed.visible.join() === `tab-${name}`;
}
async function sample(name, level) {
  return evaluate((name, level) => {
    const frame = document.querySelector('iframe');
    const doc = frame.contentDocument;
    const tab = doc.querySelector(`[data-tab="${name}"]`);
    const rect = tab.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    // Sample horizontally centered, 2 CSS px inward from either edge, and center.
    const x = Math.round(frameRect.left + rect.left + rect.width / 2);
    const y = Math.round(frameRect.top + (level === 'upper' ? rect.top + 2 : level === 'lower' ? rect.bottom - 2 : rect.top + rect.height / 2));
    const outer = document.elementFromPoint(x, y);
    const inner = doc.elementFromPoint(x - frameRect.left, y - frameRect.top);
    const { bandRect, regions } = window.fixtureModel;
    return { x, y, rect: rect.toJSON(), viewport: [innerWidth, innerHeight], scrollY: frame.contentWindow.scrollY,
      outerHit: outer?.classList.contains('piece') ? 'model-band' : outer === frame ? 'app-iframe' : outer?.tagName,
      innerHit: inner?.closest('[data-tab]')?.dataset.tab ?? null,
      bandRect, withinBand: Boolean(bandRect && x >= bandRect[0] && x < bandRect[2] && y >= bandRect[1] && y < bandRect[3]),
      wireCovered: regions.some(r => x - frameRect.left >= r.x && x - frameRect.left < r.x + r.width &&
        y - frameRect.top >= r.y && y - frameRect.top < r.y + r.height) };
  }, name, level);
}
const dispatch = (type, fields) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...fields });
async function physicalClick({x, y}) {
  await evaluate(() => { window.fixtureClicks.length = 0; });
  await dispatch('mouseMoved', {x, y});
  await dispatch('mousePressed', {x, y, button: 'left', buttons: 1, clickCount: 1});
  await dispatch('mouseReleased', {x, y, button: 'left', buttons: 0, clickCount: 1});
  await frames();
  return evaluate(() => window.fixtureClicks);
}
async function seed(initial) {
  await overlay('none');
  await evaluate(() => document.querySelector('iframe').contentWindow.scrollTo(0, 0));
  await frames();
  if (selected(await panel(), initial)) return;
  const p = await sample(initial, 'center');
  const events = await physicalClick(p);
  assert.ok(events.some(e => e.target === initial && e.trusted === true), JSON.stringify({ initial, p, events }));
  assert.ok(selected(await panel(), initial), `neutral control could not seed ${initial}`);
}
async function wheel() {
  const [w, h] = await evaluate(() => [innerWidth, innerHeight]);
  await dispatch('mouseWheel', {x: Math.round(w * 0.5), y: h - 25, deltaX: 0, deltaY: 440});
  for (let i = 0; i < 20; i++) {
    if ((await panel()).scrollY > 0) { await frames(); return; }
    await delay(25);
  }
  assert.fail('narrow graph wheel never scrolled the iframe');
}
async function runCase(route, viewport, shape, tab, level, scroll = false, honor = true) {
  const initial = scroll ? 'graph' : tab === 'overview' ? 'memory' : 'overview';
  await seed(initial);
  if (scroll) await wheel();
  await overlay(shape, honor);
  const before = await panel();
  const point = await sample(tab, level);
  const events = await physicalClick(point);
  const after = await panel();
  const delivered = events.length === 1 && events[0].target === tab && events[0].trusted === true;
  const intercepted = events.length === 1 && events[0].target === 'model-band' && events[0].trusted === true;
  const switched = selected(after, tab);
  const caseId = `${route} ${viewport.join('x')} ${shape} ${honor ? 'honor' : 'ignore'} ${scroll ? 'scrolled' : 'top'} ${tab} ${level}`;
  report.cases.push({ id: caseId, route, viewport, shape, tab, level, scroll, honor, before, point, after, events, switched, intercepted });
  const expectBlock = point.withinBand && (mode === 'baseline' || !honor);
  if (!selected(before, initial) || (scroll && point.scrollY <= 0) || point.innerHit !== tab ||
      (expectBlock ? !(intercepted && point.outerHit === 'model-band' && selected(after, initial)) :
        !(switched && delivered && point.outerHit === 'app-iframe'))) report.failures.push(`Unexpected hit/result: ${caseId}`);
  if (mode === 'candidate' && honor && point.withinBand && !point.wireCovered) report.failures.push(`No live wire rectangle at: ${caseId}`);
}
const groupKey = (route, viewport) => `${route} ${viewport.join('x')}`;
const imageKey = (route, viewport) => `${route.includes('workspace') ? 'workspace' : 'legacy'}-${viewport.join('x')}`;
async function measure() {
  return evaluate(() => {
    const doc = document.querySelector('iframe').contentDocument;
    const box = e => { const { x, y, width, height } = e.getBoundingClientRect(); return {x, y, width, height}; };
    const header = doc.querySelector('.header');
    return { header: box(header), nav: box(doc.querySelector('.header-nav')), tabs: [...doc.querySelectorAll('.header-nav [data-tab]')].map(e => ({
      name: e.dataset.tab, text: e.textContent, box: box(e),
    })) };
  });
}
async function capture(route, viewport) {
  // Compare actual header pixels without model tint, focus or hover.
  await overlay('none');
  const geometry = await measure();
  const key = groupKey(route, viewport);
  const firstRows = Math.ceil(geometry.header.height);
  const image = await win.webContents.capturePage({x: 0, y: 0, width: viewport[0], height: firstRows});
  const header = `${imageKey(route, viewport)}-appearance.png`;
  fs.writeFileSync(path.join(output, header), image.toPNG());
  report.screenshots.push(header);
  report.appearance[key] = { geometry, pixels: { size: image.getSize(), sha256BGRA: sha(image.toBitmap()) } };
  if (reference) {
    const want = reference.appearance[key];
    assert.ok(want, `missing baseline geometry for ${key}`);
    if (JSON.stringify(geometry) !== JSON.stringify(want.geometry)) report.failures.push(`0.32.3 header and tab geometry changed: ${key}`);
    if (JSON.stringify(report.appearance[key].pixels) !== JSON.stringify(want.pixels)) report.failures.push(`0.32.3 header pixels changed: ${key}`);
  }
  // Tinted overlays are for screenshots only. All test points use transparent pieces.
  for (const honor of [false, true]) {
    await overlay('deep', honor, true);
    const file = `${imageKey(route, viewport)}-model-${honor ? 'wire' : 'disabled'}.png`;
    fs.writeFileSync(path.join(output, file), (await win.webContents.capturePage()).toPNG());
    report.screenshots.push(file);
  }
  await overlay('none');
}
async function adjacentControl(route, viewport) {
  await seed('overview');
  await overlay('deep');
  const before = await panel();
  // DOM geometry is used solely to choose this diagnostic point, never to create a hole.
  const point = await evaluate(() => {
    const doc = document.querySelector('iframe').contentDocument;
    const buttons = [...doc.querySelectorAll('.header-nav [data-tab]')];
    const rects = buttons.map(b => b.getBoundingClientRect());
    for (let i = 0; i < rects.length - 1; i++) {
      const a = rects[i], b = rects[i+1];
      if (b.left - a.right < 2) continue;
      const x = Math.round((a.right+b.left)/2), y = Math.ceil(Math.max(a.top, b.top))+2;
      const outer = document.elementFromPoint(x,y), inner = doc.elementFromPoint(x,y);
      const hit = inner?.closest('[data-tab]');
      const band = window.fixtureModel.bandRect;
      if (hit || !band || y >= band[3]) continue;
      return { x, y, band, innerTag: inner?.tagName, outerHit: outer?.classList.contains('piece') ? 'model-band' : 'app-iframe',
        rects: rects.map(r => r.toJSON()), regions: window.fixtureModel.regions };
    }
    return null;
  });
  assert.ok(point, 'no in-band blank gap immediately adjacent to buttons');
  const events = await physicalClick(point);
  const after = await panel();
  const intercepted = events.length === 1 && events[0].trusted && events[0].target === 'model-band';
  report.adjacent.push({ route, viewport, point, events, before, after, intercepted });
  if (!intercepted || point.outerHit !== 'model-band' || !selected(after, 'overview')) {
    report.failures.push(`Blank gap next to tabs was not intercepted: ${groupKey(route, viewport)}`);
  }
}

async function run() {
  app.dock?.hide();
  const isolated = session.fromPartition('math-coordinate-fixture');
  isolated.webRequest.onBeforeRequest((details, cb) => {
    const allowed = details.url.startsWith(origin + '/') || /^(data|blob):/.test(details.url);
    if (!allowed) report.blockedRequests.push(details.url);
    cb({ cancel: !allowed });
  });
  isolated.protocol.handle(scheme, request => {
    const u = new URL(request.url);
    assert.equal(u.host, 'fixture');
    if (u.pathname === '/_model') {
      const route = u.searchParams.get('route');
      assert.ok(routes.includes(route));
      return new Response(wrapper(route), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const prefix = '/api/apps/hana-math/ui';
    if (!u.pathname.startsWith(prefix + '/')) return new Response('', { status: 404 });
    const file = path.resolve(ui, '.' + decodeURIComponent(u.pathname.slice(prefix.length)));
    if (!file.startsWith(ui + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.realpathSync(file).startsWith(ui + path.sep)) return new Response('', { status: 404 });
    const type = mime[path.extname(file)] || 'application/octet-stream';
    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': type + (type.startsWith('text/') ? '; charset=utf-8' : '') } });
  });
  for (const route of routes) for (const viewport of viewports) {
    const [width, height] = viewport;
    win = new BrowserWindow({ show: false, width, height, useContentSize: true, frame: false,
      webPreferences: { session: isolated, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', evt => evt.preventDefault());
    win.webContents.on('console-message', details => { if (details.level === 'error') report.pageErrors.push(details.message); });
    win.webContents.debugger.attach('1.3');
    await win.loadURL(`${origin}/_model?route=${encodeURIComponent(route)}`);
    await evaluate(() => {
      const doc = document.querySelector('iframe').contentDocument;
      if (!doc.querySelector('.header-nav button[data-tab]')?.onclick) throw new Error('actual landing tab handler was not initialized');
      window.fixtureClicks = [];
      const trace = target => evt => window.fixtureClicks.push({ target, trusted: evt.isTrusted, x: evt.clientX, y: evt.clientY });
      document.querySelector('#band').addEventListener('click', trace('model-band')); // bubble from the remaining tiles
      for (const button of doc.querySelectorAll('.header-nav button[data-tab]')) button.addEventListener('click', trace(button.dataset.tab));
    });
    assert.deepEqual(await evaluate(() => [innerWidth, innerHeight]), viewport);
    const entry = await evaluate(() => document.querySelector('iframe').contentDocument.body.dataset.dashboardEntry);
    assert.equal(entry, route.includes('workspace') ? 'page' : 'card');
    let handshake = false;
    for (let n = 0; n < 40; n++) {
      const state = await evaluate(() => window.fixtureModel.wire);
      handshake = state.some(m => m.type === 'hana.ready');
      if (handshake && (mode === 'baseline' || state.some(m => m.applied && m.regions.length))) break;
      await delay(50);
    }
    assert.ok(handshake, 'Bundled SDK did not announce hana.ready to the synthetic parent');
    await capture(route, viewport);
    const firstGeometry = report.appearance[groupKey(route, viewport)].geometry;
    for (const shape of overlays) for (const name of names) for (const level of levels) await runCase(route, viewport, shape, name, level);
    for (const name of names) for (const level of levels) await runCase(route, viewport, 'deep', name, level, false, false);
    if (width < 540) for (const shape of ['none', 'deep']) for (const name of ['overview','memory']) for (const level of levels) await runCase(route, viewport, shape, name, level, true);
    await adjacentControl(route, viewport);
    const key = groupKey(route, viewport);
    const wire = report.wire[key] = await evaluate(() => window.fixtureModel.wire);
    const registrations = wire.filter(m => m.kind === 'request');
    if (mode === 'baseline' && registrations.length) report.failures.push(`Unexpected region request on baseline: ${key}`);
    if (mode === 'candidate') {
      const initial = registrations.find(m => m.applied && m.regions.length);
      const expected = firstGeometry.tabs.map(t => t.box);
      const equalRect = (r, b) => ['x', 'y', 'width', 'height'].every(k => Math.abs(r[k] - b[k]) < 0.05);
      if (!initial || initial.regions.length !== expected.length || !expected.every(box => initial.regions.some(r => equalRect(r, box)))) {
        report.failures.push(`First wire rectangles are not individual tab bounds: ${key}`);
      }
      if (registrations.some(m => !m.applied)) report.failures.push(`Rejected region payload: ${key}`);
      const matching = report.cases.filter(c => groupKey(c.route, c.viewport) === key && c.shape === 'deep' && !c.scroll);
      const covered = matching.filter(c => c.honor && c.point.withinBand);
      if (covered.length < 3 || covered.some(c => !matching.some(other => !other.honor && other.tab === c.tab && other.level === c.level &&
        other.point.x === c.point.x && other.point.y === c.point.y && other.intercepted))) {
        report.failures.push(`Could not reproduce baseline misses at the same candidate coordinates with wire holes disabled: ${key}`);
      }
    }
    win.destroy(); win = null;
  }
  if (mode === 'baseline') for (const route of routes) {
    if (!report.cases.some(row => row.route === route && row.intercepted)) report.failures.push(`Did not reproduce chrome interception: ${route}`);
  }
  if (report.blockedRequests.length || report.pageErrors.length) report.failures.push('Unexpected non-fixture requests or renderer errors');
}
function finish() {
  if (win && !win.isDestroyed()) win.destroy();
  report.totals = { points: report.cases.length, switched: report.cases.filter(row => row.switched).length,
    intercepted: report.cases.filter(row => row.intercepted).length, scrolled: report.cases.filter(row => row.scroll).length,
    wireProtected: report.cases.filter(row => row.honor && row.point.withinBand && row.switched && row.point.wireCovered).length,
    disabledControlBlocked: report.cases.filter(row => !row.honor && row.intercepted).length,
    adjacentBlankBlocked: report.adjacent.filter(row => row.intercepted).length };
  report.ok = report.failures.length === 0;
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ mode, ok: report.ok, totals: report.totals, failures: report.failures.slice(0, 6) }));
  app.exit(report.ok ? 0 : 1);
}
app.on('window-all-closed', event => event.preventDefault());
const timeout = setTimeout(() => { report.failures.push('Fixture timed out'); finish(); }, 90000);
app.whenReady().then(run).catch(error => { report.failures.push(error.stack); }).finally(() => { clearTimeout(timeout); finish(); });
