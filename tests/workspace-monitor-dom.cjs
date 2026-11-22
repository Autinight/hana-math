// Hidden isolated software window. No Hana desktop, account, Host or real data.
// Electron 45.2.1: tests/workspace-monitor-dom.cjs <frozen ui> <exclusive evidence dir> [diagnostics|verification-proof|terminal-snapshot]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { app, BrowserWindow, protocol, session } = require('electron');

assert.equal(process.versions.electron, '45.2.1');
assert.equal(process.versions.chrome, '156.0.8078.75');
assert.equal(process.arch, 'arm64');
const [uiPath, outputPath, mode] = process.argv.slice(2);
const ui = fs.realpathSync(uiPath), out = path.resolve(outputPath);
fs.mkdirSync(out);
fs.mkdirSync(path.join(out, 'profile'));
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'profile'));
app.setAppLogsPath(path.join(out, 'profile', 'logs'));
app.disableHardwareAcceleration();
const scheme = 'workspace-test', origin = `${scheme}://isolated`;
protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const appRoute = '/api/apps/hana-math';
const fakeSession = 'synthetic-isolated-page-session';
const report = { ok: false, scope: 'Isolated Electron running the actual workspace entry and bundled SDK; only same-origin route replies are simulated. Not Host acceptance.',
  runtime: { electron: process.versions.electron, chromium: process.versions.chrome }, assertions: [], evidence: {}, requests: [], routeErrors: [], outsideRequests: [], consoleErrors: [] };
const data = { project: 'fixture-A', revision: 1, channelGrowth: false, unavailable: false };
let discoveryStatus, overviewStatus, rotateAfterOverview, holdOverview;
const proofIds = ['0123456789000001', '0123456789000002'];
const proofPrefix = proofIds[1].slice(0, 10);
let proofGeneration = 1, proofLabel = 'cached', proofReply, proofInitialSingle = true;
const proofFixture = mode === 'verification-proof' || mode === 'terminal-snapshot';
const finishedAt = Date.parse('2026-01-02T03:04:05.678Z');
let terminalSnapshot = false;
const activeGeneration = () => `test-${data.project}${proofFixture ? `-${proofGeneration}` : ''}`;
const graphRow = (id, project = data.project) => ({ id, statement: `${project} statement $x^2$`, proof: `${project} proof to keep.`, intuition: '',
  author: 'Opaque author', problem_id: `${project}-problem`, predecessors: [], depth: 0 });
let win, isolated;
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
const cdp = (type, args) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...args });
const frames = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function until(fn, label, timeout = 4000, ...args) {
  const until = performance.now() + timeout;
  while (performance.now() < until) { const value = await evaluate(fn, ...args); if (value) return value; await wait(40); }
  assert.fail(`fixture deadline: ${label}`);
}
function passed(label, data) { report.assertions.push(label); if (data !== undefined) report.evidence[label] = data; }
async function click({x, y}) {
  assert.ok(Number.isFinite(x) && Number.isFinite(y));
  await cdp('mouseMoved', { x, y });
  await cdp('mousePressed', { x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp('mouseReleased', { x, y, button: 'left', buttons: 0, clickCount: 1 });
  await frames();
}
async function clickSelector(selector) {
  await click(await evaluate(sel => {
    const el = document.querySelector(sel);
    el.scrollIntoView({block:'nearest'});
    const {x,y,width,height} = el.getBoundingClientRect();
    return {x: x + width/2, y: y + height/2};
  }, selector));
}
async function clickFact() {
  const point = await until(() => {
    const host = document.querySelector('#graph'), chart = echarts.getInstanceByDom(host);
    const item = chart?.getModel().getSeriesByIndex(0).getData().getItemGraphicEl(0);
    if (!item) return false;
    const r = item.getBoundingRect(), bounds = host.getBoundingClientRect();
    const [x, y] = item.transformCoordToGlobal(r.x + r.width/2, r.y + r.height/2);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return { x: x + bounds.x, y: y + bounds.y };
  }, 'graph contains a real interactive node');
  await click(point);
}
async function capture(name) {
  await frames();
  const dom = await evaluate(() => {
    const get = id => document.querySelector(id)?.textContent ?? null;
    return { badge: get('#project-badge'), state: get('#landing-state'), tab: document.querySelector('.nav-link.active')?.dataset.tab,
      overview: get('#ov-cards'), graph: get('#graph-stat'), proof: get('#fact-detail'), channels: get('#mem-subtabs'), memory: get('#mem-list') };
  });
  const file = `${name}.png`;
  fs.writeFileSync(path.join(out, file), (await win.webContents.capturePage()).toPNG(), { flag: 'wx' });
  report.evidence[name] = { screenshot: file, dom };
  return dom;
}

async function openWindow(route = '/dashboard/workspace.html') {
  win = new BrowserWindow({ show: false, width: 1120, height: 740, useContentSize: true, frame: false,
    webPreferences: { session: isolated, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('console-message', message => { if (message.level === 'error') report.consoleErrors.push(message.message); });
  win.webContents.debugger.attach('1.3');
  await win.loadURL(`${origin}${appRoute}/ui${route}?appSurfaceSession=${fakeSession}`);
}

function monitorResponse(request, url) {
  const sub = url.pathname.slice(`${appRoute}/routes/workspace-monitor`.length);
  const generation = request.headers.get('x-hana-math-monitor-generation');
  report.requests.push({ sub, generation, method: request.method, at: performance.now() });
  try {
    assert.equal(request.method, 'GET');
    assert.equal(request.body, null);
    assert.equal(url.search, '');
    assert.equal(request.headers.get('x-hana-app-surface-session'), fakeSession);
    assert.equal(request.headers.get('x-hana-document-binding'), null);
    if (proofFixture) {
      const appHeaders = [...request.headers.keys()].filter(key => key.startsWith('x-hana-') || ['authorization', 'cookie'].includes(key)).sort();
      assert.deepEqual(appHeaders, ['x-hana-app-surface-session', ...(sub === '/current' ? [] : ['x-hana-math-monitor-generation'])]);
    }
    if (sub === '/current') {
      assert.equal(generation, null);
      if (discoveryStatus) return Response.json({ private: 'not-for-the-status-bar' }, { status: discoveryStatus });
      if (data.unavailable) return Response.json({ state: 'unavailable' });
      if (!data.project) return Response.json({ state: 'idle' });
      const scope = { projectId: data.project, generation: activeGeneration() };
      return terminalSnapshot ? Response.json({ state:'snapshot', ...scope, endedAt:finishedAt, projectName:'Opaque terminal project' })
        : Response.json({ state:'active', ...scope });
    }
    assert.equal(generation, activeGeneration());
    if (proofFixture && sub === '/api/channels') return Response.json({ channels: [{ kind:'verification', count:2 }] });
    if (proofFixture && sub === '/api/channel/verification') return Response.json({ entries: [
      { id:'accepted-2', claim:'Checked second fact', verdict:'correct', fact_id:proofIds[1] },
      { id:'no-id', claim:'Record without a canonical fact ID', verdict:'wrong' },
    ] });
    if (proofFixture && sub === '/api/factgraph') {
      const plan = proofReply; proofReply = undefined;
      const label = plan?.label ?? proofLabel;
      const nodes = proofIds.slice(0, plan?.missing || proofInitialSingle ? 1 : 2).map((id, i) => ({ ...graphRow(id),
        statement: `${label} statement ${i + 1}`, proof: `${label} proof ${i + 1}` }));
      const answer = plan?.status ? Response.json({ state:'unavailable' }, { status:plan.status }) : Response.json({ nodes, edges:[], max_depth:0 });
      const row = report.requests.at(-1);
      Object.assign(row, { label, nodeIds:plan?.status ? [] : nodes.map(node => node.id), status:answer.status });
      if (plan) { plan.started(row); return plan.wait.then(() => answer); }
      return answer;
    }
    if (sub === '/api/overview' && overviewStatus) return Response.json({ state: 'unavailable' }, { status: overviewStatus });
    const count = data.channelGrowth ? 2 : 1;
    const plan = () => ({ id: 'plan-1', timestamp_utc: '2026-01-01T00:00:00Z', author: 'Opaque planner', claim: `${data.project} plan $x^2$`,
      evidence: (`${data.project} expandable evidence.\n\n`).repeat(12) });
    const payload = {
      '/api/overview': () => ({ project:data.project, facts:data.revision, facts_with_predecessors:0,
        facts_by_author:{ 'Opaque author':data.revision }, verdicts:{ correct:data.revision }, channel_counts:{ plan:count }, updated_at:1760000000 }),
      '/api/factgraph': () => ({ nodes:[graphRow(`${data.project}-fact`), ...(data.revision > 1 ? [graphRow(`${data.project}-second`)] : [])], edges:[], max_depth:0 }),
      '/api/channels': () => ({ channels:[{ kind:'direction', count:1 }, { kind:'plan', count }] }),
      '/api/channel/direction': () => ({ entries:[{ id:'direction-1', author:'Opaque author', claim:`${data.project} direction` }] }),
      '/api/channel/plan': () => ({ entries:[...(data.channelGrowth ? [{ id:'plan-2', author:'New author', claim:`${data.project} new plan` }] : []), plan()] }),
    }[sub];
    assert.ok(payload, `Unexpected fixture path ${sub}`);
    const answer = Response.json(payload());
    if (sub === '/api/overview') {
      if (terminalSnapshot && holdOverview) return holdOverview.then(() => answer);
      if (rotateAfterOverview) { data.project = rotateAfterOverview; rotateAfterOverview = null; }
      if (generation === 'test-fixture-B' && holdOverview) return holdOverview.then(() => answer);
    }
    return answer;
  } catch (error) {
    report.routeErrors.push(error.message);
    return Response.json({ state: 'unavailable' }, { status: 400 });
  }
}

async function verificationProof() {
  const tab = name => clickSelector(`[data-tab="${name}"]`);
  const detail = () => evaluate(() => {
    const el = document.querySelector('#fact-detail');
    return { id:el.querySelector('.fid')?.textContent ?? null, sections:[...el.querySelectorAll('.sec-h')].map(h => [h.textContent, h.nextElementSibling.textContent.trim()]),
      tab:document.querySelector('.nav-link.active').dataset.tab };
  });
  const noProof = async label => {
    const got = await detail();
    assert.equal(got.id, null, label); assert.deepEqual(got.sections, [], label);
  };
  async function memory() {
    await tab('memory');
    await until(() => document.querySelector('#tab-memory.active #mem-list .entry')?.textContent.includes('Checked second fact'), 'verification entries loaded');
  }
  async function openProof() {
    const point = await evaluate(prefix => {
      const el = [...document.querySelectorAll('#mem-list .entry-head *')].find(el => el.textContent.trim() === prefix && ![...el.children].some(child => child.textContent.trim() === prefix));
      if (!el) return null;
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x:x + width / 2, y:y + height / 2, text:el.textContent.trim(), tag:el.tagName, role:el.getAttribute('role') };
    }, proofPrefix);
    assert.ok(point, 'verification record exposes the colliding short ID');
    report.evidence.lastClickedShortId = point;
    await click(point);
  }
  function holdGraph(label, options = {}) {
    assert.equal(proofReply, undefined);
    let release, started;
    const arrival = new Promise(resolve => { started = resolve; });
    const waitForRelease = new Promise(resolve => { release = resolve; });
    proofReply = { label, ...options, started, wait:waitForRelease };
    return { release, async arrived() {
      const timer = new AbortController();
      try { return await Promise.race([arrival, wait(3000, null, { signal:timer.signal }).then(() => null)]); }
      finally { timer.abort(); }
    } };
  }
  async function observeProofWrites() {
    await evaluate(() => {
      window.proofWitness?.observer.disconnect();
      const target = document.querySelector('#fact-detail'), values = [];
      const observer = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const id = node.matches('.fid') ? node : node.querySelector('.fid');
            if (id) values.push(id.textContent);
          }
        }
      });
      observer.observe(target, { childList:true, subtree:true });
      window.proofWitness = { values, observer };
    });
  }
  async function observedProofIds() {
    await frames();
    return evaluate(() => window.proofWitness.values);
  }

  await openWindow();
  await until(() => document.querySelector('#ov-cards .v')?.textContent === '1', 'workspace startup');
  await tab('graph');
  await until(() => document.querySelector('#graph-stat').textContent.startsWith('1 facts'), 'initial node cached');
  // Prime the unrelated selection through the existing chart click event. The
  // moving force-layout symbol isn't pixel-stable in the hidden window. The
  // verification action below always uses an actual Electron pointer click.
  assert.ok(await evaluate(() => {
    const chart = echarts.getInstanceByDom(document.querySelector('#graph'));
    const item = chart.getModel().getSeriesByIndex(0).getData().getItemGraphicEl(0);
    if (!item) return false;
    const r = item.getBoundingRect();
    const [x, y] = item.transformCoordToGlobal(r.x + r.width / 2, r.y + r.height / 2);
    const handler = chart.getZr().handler, hit = handler.findHover(x, y);
    if (!hit.target) return false;
    handler.dispatchToElement(hit, 'click', { zrX:x, zrY:y });
    return true;
  }), 'prime the existing chart selection');
  await until(id => document.querySelector('#fact-detail .fid')?.textContent === id, 'unrelated cached proof is selected', 4000, proofIds[0]);
  // Select the old proof by a real pointer before the second force-layout
  // node appears; avoid targeting a moving or overlapping coordinate.
  proofInitialSingle = false;
  await tab('overview');
  await tab('graph');
  await until(() => document.querySelector('#graph-stat').textContent.startsWith('2 facts'), 'cache both nodes with colliding short IDs');
  assert.deepEqual((await detail()).sections, [['Statement', 'cached statement 1'], ['Proof', 'cached proof 1']]);
  await memory();
  const beforeNoId = report.requests.length;
  const noId = await evaluate(() => {
    const row = [...document.querySelectorAll('#mem-list .entry')].find(el => el.textContent.includes('Record without a canonical fact ID'));
    return { id:row.querySelector('.fid')?.textContent ?? null, controls:[...row.querySelectorAll('button,a,[role="button"],[role="link"]')].filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true').length };
  });
  assert.deepEqual(noId, { id:null, controls:0 });
  await clickSelector('#mem-list .entry:nth-child(2) .entry-claim');
  assert.equal((await detail()).tab, 'memory');
  assert.equal(report.requests.slice(beforeNoId).some(row => row.sub === '/api/factgraph'), false);
  passed('Verification record without a fact ID does not jump');
  await capture('before-short-id-click');
  const success = holdGraph('fresh');
  await observeProofWrites();
  try {
    await openProof();
    const request = await success.arrived();
    if (!request) await capture('first-short-id-no-fresh-read');
    assert.ok(request, 'clicking the verification short ID must request a fresh graph (old renderer is inert)');
    assert.equal(request.generation, activeGeneration());
    assert.deepEqual(request.nodeIds, proofIds);
    await noProof('a held graph must not show either cached proof');
    assert.deepEqual(await observedProofIds(), []);
    passed('Click opens no cached proof while the fresh graph is withheld');
  } finally { success.release(); }
  await until(id => document.querySelector('#tab-graph.active #fact-detail .fid')?.textContent === id, 'fresh graph opens the exact second ID', 4000, proofIds[1]);
  const fresh = await detail();
  assert.deepEqual(fresh, { tab:'graph', id:proofIds[1], sections:[['Statement', 'fresh statement 2'], ['Proof', 'fresh proof 2']] });
  assert.ok(await evaluate(() => {
    const proof = document.querySelector('#fact-detail .math:last-of-type');
    return proof.getClientRects().length > 0 && getComputedStyle(proof).visibility === 'visible';
  }));
  assert.deepEqual(new Set(await observedProofIds()), new Set([proofIds[1]]));
  passed('Fresh same-generation reply shows the exact complete ID, statement and proof', fresh);
  await capture('fresh-second-proof');

  async function negative(label, options, during, after) {
    await memory();
    const gate = holdGraph(label, options);
    await observeProofWrites();
    try {
      await openProof();
      const issued = await gate.arrived();
      assert.equal(issued?.generation, activeGeneration(), `${label}: fresh request captured in original scope`);
      await noProof(`${label}: no cached selection while pending`);
      assert.deepEqual(await observedProofIds(), [], label);
      await during?.();
    } finally { gate.release(); }
    await after();
    await noProof(`${label}: no stale or unintended proof`);
    assert.deepEqual(await observedProofIds(), [], `${label}: no transient proof commit`);
    passed(label, await detail());
  }
  async function graphReadAfter(start, generation) {
    const end = performance.now() + 4000;
    while (performance.now() < end) {
      const index = report.requests.findIndex((row, i) => i >= start && row.sub === '/api/factgraph' && row.generation === generation);
      if (index >= 0 && report.requests.slice(index + 1).some(row => row.sub === '/current')) {
        await frames();
        return report.requests[index];
      }
      await wait(25);
    }
    assert.fail(`no independently read and rechecked graph for ${generation}`);
  }
  const graphCount = count => until(count => document.querySelector('#tab-graph.active #graph-stat')?.textContent.startsWith(`${count} facts`), `graph with ${count} facts`, 5000, count);
  await negative('Revoked ID is missing even when the same prefix remains', { missing:true }, null, () => graphCount(1));
  await negative('Unreadable graph (HTTP 409) never opens cached data', { status:409 }, null,
    () => until(() => document.querySelector('#landing-state').dataset.monitorState === 'unavailable', 'unreadable graph signaled'));

  for (const change of ['different-project', 'same-project-new-generation']) {
    let start;
    await negative(change, {}, () => {
      start = report.requests.length;
      if (change === 'different-project') data.project = 'fixture-B';
      else proofGeneration++;
      proofLabel = change + '-fresh'; // Both IDs also exist in the independently loaded new graph.
    }, async () => {
      await until(project => document.querySelector('#project-badge').textContent === project, 'new scope visible', 5000, data.project);
      if ((await detail()).tab !== 'graph') await tab('graph');
      // On generation-only rotation the old badge and chart already look
      // identical. Wait for the *new* route witness before reading the DOM.
      const current = await graphReadAfter(start, activeGeneration());
      assert.deepEqual(current.nodeIds, proofIds, 'new scope has the same canonical IDs');
      await graphCount(2);
    });
  }

  let start;
  await negative('Quickly switch away and back: old click result is not restored', {}, async () => {
    start = report.requests.length;
    await tab('overview');
    await tab('graph');
    proofLabel = 'ordinary-return';
  }, async () => {
    await graphReadAfter(start, activeGeneration());
    await graphCount(2);
  });

  await memory();
  const unchanged = holdGraph(proofLabel); // Same payload as the last ordinary graph read.
  await observeProofWrites();
  try {
    const before = report.requests.length;
    await openProof();
    const request = await unchanged.arrived();
    assert.equal(request?.generation, activeGeneration());
    assert.deepEqual(report.requests.slice(before).map(row => row.sub), ['/current', '/api/factgraph']);
    await noProof('identical cached payload still requires a fresh reply');
    assert.deepEqual(await observedProofIds(), []);
  } finally { unchanged.release(); }
  await until(id => document.querySelector('#tab-graph.active #fact-detail .fid')?.textContent === id, 'fresh byte-identical graph still opens the selected proof', 4000, proofIds[1]);
  assert.deepEqual(await detail(), { tab:'graph', id:proofIds[1], sections:[['Statement', 'ordinary-return statement 2'], ['Proof', 'ordinary-return proof 2']] });
  passed('A freshly rechecked byte-identical graph still opens the requested proof');
  assert.deepEqual(report.outsideRequests, []);
  assert.deepEqual(report.routeErrors, []);
  assert.ok(report.consoleErrors.every(s => /^Failed to load resource: the server responded with a status of 409\b/.test(s)));
  passed('Only existing same-origin GET routes, surface session, and scoped generation were used');
}

async function terminalSnapshotFlow() {
  data.revision = 0;
  proofInitialSingle = false;
  proofLabel = 'terminal';
  const openTab = tab => clickSelector(`[data-tab="${tab}"]`);
  const facts = n => until(n => document.querySelector('#ov-cards .v')?.textContent === n, `visible fact count ${n}`, 4500, n);
  const state = value => until(value => document.querySelector('#landing-state').dataset.monitorState === value, `monitor ${value}`, 11500, value);
  const header = () => evaluate(() => ({ badge: document.querySelector('#project-badge').textContent,
    note: document.querySelector('#refresh-note').textContent, status: document.querySelector('#landing-state').textContent }));
  async function terminalHeader() {
    const shown = await header();
    assert.match(shown.badge, /Opaque terminal project/); assert.match(shown.badge, /fixture-A/);
    assert.match(shown.note, /结束时间.*2026-01-02T03:04:05\.678Z/);
    assert.equal(shown.status, '只读快照');
    return shown;
  }
  await openWindow(); await facts('0'); await state('active');
  await capture('last-active-zero');
  const previous = report.requests.length;
  terminalSnapshot = true; proofGeneration++; data.revision = 1;
  let release; holdOverview = new Promise(resolve => { release = resolve; });
  try {
    await state('pending');
    assert.equal(await evaluate(() => document.querySelector('#ov-cards').childElementCount), 0, 'the last active overview must not remain visible');
    const end = performance.now() + 1800;
    while (!report.requests.slice(previous).some(row => row.sub === '/api/overview' && row.generation === activeGeneration()) && performance.now() < end) await wait(30);
    assert.ok(report.requests.slice(previous).some(row => row.sub === '/api/overview' && row.generation === activeGeneration()), 'terminal overview issued under the new generation');
  } finally { release(); holdOverview = null; }
  await state('snapshot'); await facts('1');
  passed('Same visible page discards active zero and reads terminal one', await terminalHeader());
  await capture('terminal-one');

  win.destroy(); win = null;
  const reopened = report.requests.length;
  await openWindow(); await state('snapshot'); await facts('1'); await terminalHeader();
  assert.deepEqual(report.requests.slice(reopened).map(({ sub, generation }) => [sub, generation]), [
    ['/current', null], ['/api/overview', activeGeneration()], ['/current', null],
  ]);
  passed('Reopened page reads terminal one independently');
  await openTab('memory');
  await until(() => !!document.querySelector('#mem-list .entry .fid'), 'terminal verification log');
  await clickSelector('#mem-list .entry .fid');
  await until(id => document.querySelector('#tab-graph.active #fact-detail .fid')?.textContent === id, 'terminal full-ID proof jump', 4000, proofIds[1]);
  const detail = await capture('terminal-proof');
  assert.match(detail.proof, /terminal statement 2/); assert.match(detail.proof, /terminal proof 2/);
  await terminalHeader();
  passed('Terminal verification jump resolves the full ID and proof');

  const replacement = report.requests.length;
  terminalSnapshot = false; data.project = 'fixture-B'; proofGeneration++; proofLabel = 'active replacement';
  await until(() => document.querySelector('#landing-state').dataset.monitorState === 'active'
    && document.querySelector('#project-badge').textContent === 'fixture-B', 'active choice replaces terminal', 11500);
  const active = await capture('active-replacement');
  assert.equal(active.tab, 'graph'); assert.match(active.graph, /^2 facts/); assert.doesNotMatch(active.proof, /terminal|0123456789000002/);
  assert.equal((await header()).note, '');
  assert.ok(report.requests.slice(replacement).some(row => row.sub === '/api/factgraph' && row.generation === activeGeneration()));
  data.unavailable = true; await state('unavailable');
  const revoked = await capture('unavailable');
  assert.deepEqual([revoked.tab, revoked.badge, revoked.overview, revoked.graph, revoked.channels, revoked.memory], ['graph', '', '', '', '', '']);
  assert.doesNotMatch(revoked.proof, /terminal|active replacement|0123456789000002/);
  assert.equal((await header()).note, '');
  assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.outsideRequests, []); assert.deepEqual(report.consoleErrors, []);
  passed('Active replaces the terminal scope; unavailability clears the retained tab without private content');
}

async function run() {
  app.dock?.hide();
  isolated = session.fromPartition('workspace-dom-software-001');
  const mime = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.png':'image/png', '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf' };
  isolated.webRequest.onBeforeRequest((details, cb) => {
    const allowed = details.url.startsWith(origin + '/') || /^(data|blob):/.test(details.url);
    if (!allowed) report.outsideRequests.push(details.url); cb({ cancel: !allowed });
  });
  await isolated.protocol.handle(scheme, request => {
    const url = new URL(request.url);
    if (url.host !== 'isolated') return new Response('', { status:404 });
    if (url.pathname.startsWith(`${appRoute}/routes/workspace-monitor/`)) return monitorResponse(request, url);
    if (!url.pathname.startsWith(`${appRoute}/ui/`)) return new Response('', { status:404 });
    const p = path.resolve(ui, '.' + decodeURIComponent(url.pathname.slice(`${appRoute}/ui`.length)));
    if (!p.startsWith(ui + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile() || !fs.realpathSync(p).startsWith(ui + path.sep)) return new Response('', { status:404 });
    const type = mime[path.extname(p)] ?? 'application/octet-stream';
    return new Response(fs.readFileSync(p), { headers:{ 'content-type': type + (type.startsWith('text/') ? '; charset=utf-8' : '') } });
  });
  if (mode === 'verification-proof') return verificationProof();
  if (mode === 'terminal-snapshot') return terminalSnapshotFlow();
  if (mode === 'diagnostics') {
    const observed = (state, text) => until((state, text) => {
      const el = document.querySelector('#landing-state');
      if (el?.dataset.monitorState !== state || el.textContent !== text) return false;
      return { state: el.dataset.monitorState, text: el.textContent, badge: document.querySelector('#project-badge').textContent,
        count: document.querySelector('#ov-cards').children.length };
    }, text, 11500, state, text);
    async function refused(tail) {
      const text = `研究状态暂不可用 · ${tail}`;
      const result = await observed('unavailable', text);
      assert.equal(result.badge, ''); assert.equal(result.count, 0);
      passed(tail, result);
    }
    discoveryStatus = 403;
    await openWindow();
    await refused('发现 GET：HTTP 403（请求被拒绝）');
    assert.deepEqual(report.requests.map(row => row.sub), ['/current']);
    discoveryStatus = null; data.unavailable = true;
    const limit = performance.now() + 11500;
    while (report.requests.length < 2 && performance.now() < limit) await wait(40);
    assert.deepEqual(report.requests.map(row => row.sub), ['/current', '/current']);
    await frames();
    await refused('发现 GET：HTTP 403（请求被拒绝）');
    passed('下一轮 200 unavailable 未覆盖首错');
    data.unavailable = false; data.project = null;
    const idle = await observed('idle', '当前没有正在推进的研究');
    assert.equal(idle.badge, ''); assert.equal(idle.count, 0);
    passed('空闲恢复原文案并清除首错', idle);
    data.project = 'fixture-A'; overviewStatus = 409;
    await refused('业务读取：HTTP 409（读取未获确认）');
    assert.deepEqual(report.requests.map(row => row.sub), ['/current', '/current', '/current', '/current', '/api/overview']);
    overviewStatus = null;
    const result = await observed('active', '正在跟踪研究');
    assert.equal(result.badge, 'fixture-A'); assert.ok(result.count > 0);
    passed('正常响应自动恢复原文案和面板', result);
    const start = report.requests.length;
    rotateAfterOverview = 'fixture-B';
    let release; holdOverview = new Promise(resolve => { release = resolve; });
    try {
      const pending = await observed('pending', '正在确认研究状态');
      assert.equal(pending.badge, ''); assert.equal(pending.count, 0);
      passed('合法 A→B 最终复核清空旧内容并正常等待', pending);
    } finally { release(); holdOverview = null; }
    const b = await until(() => {
      const el = document.querySelector('#landing-state'), badge = document.querySelector('#project-badge').textContent;
      return badge === 'fixture-B' && { badge, state: el.dataset.monitorState, text: el.textContent };
    }, 'B automatically rendered after rotation');
    assert.deepEqual(b, { badge: 'fixture-B', state: 'active', text: '正在跟踪研究' });
    assert.deepEqual(report.requests.slice(start).map(({ sub, generation }) => [sub, generation]), [
      ['/current', null], ['/api/overview', 'test-fixture-A'], ['/current', null],
      ['/current', null], ['/api/overview', 'test-fixture-B'], ['/current', null],
    ]);
    passed('B 自动重读后正常跟踪', b);
    assert.deepEqual(report.outsideRequests, []);
    assert.deepEqual(report.routeErrors, []);
    // Chromium may report non-2xx resource loads; unrelated console errors still fail.
    assert.ok(report.consoleErrors.every(s => /^Failed to load resource: the server responded with a status of (403|409)\b/.test(s)));
    return;
  }
  await openWindow();
  await until(() => document.querySelector('#ov-cards .v')?.textContent === '1', 'default live overview populated');
  assert.equal((await capture('A-overview')).badge, 'fixture-A');
  assert.equal(await evaluate(() => !!document.querySelector('#snapshot-file, #new-dashboard')), false);
  assert.deepEqual(report.requests.map(row => row.sub), ['/current','/api/overview','/current']);
  passed('Opening the real workspace automatically reads the same-origin SDK route');
  const overviewUpdatedAt = performance.now(); data.revision = 2;
  await until(() => document.querySelector('#ov-cards .v')?.textContent === '2', 'same open page polls overview', 11500);
  passed('Overview refreshes on the normal production cadence without user action', { elapsedMs: performance.now() - overviewUpdatedAt });
  data.revision = 1;
  await clickSelector('[data-tab="graph"]');
  await until(() => document.querySelector('#graph-stat').textContent.startsWith('1 facts'), 'graph populated');
  await clickFact();
  await until(() => document.querySelector('#fact-detail').textContent.includes('fixture-A proof to keep'), 'graph pointer click displays proof');
  assert.ok(await evaluate(() => getComputedStyle(document.querySelector('#fact-detail .fid')).visibility === 'visible'));
  await capture('A-proof');
  await evaluate(() => { window.firstProof = document.querySelector('#fact-detail .math:last-of-type'); window.firstCanvas = document.querySelector('#graph canvas'); });
  data.revision = 2;
  await until(() => document.querySelector('#graph-stat').textContent.startsWith('2 facts'), 'same-project graph topology updates', 11500);
  assert.deepEqual(await evaluate(() => ({ proof: firstProof !== null && firstProof.isConnected, canvas: firstCanvas === document.querySelector('#graph canvas'),
    id: document.querySelector('#fact-detail .fid').textContent })), { proof:true, canvas:true, id:'fixture-A-fact' });
  passed('Graph topology refresh preserves the selected existing proof node and canvas');
  await clickSelector('[data-tab="memory"]');
  await until(() => document.querySelector('#mem-list').textContent.includes('fixture-A direction'), 'memory default channel populated');
  await clickSelector('#mem-subtabs .subtab:nth-child(2)');
  await until(() => document.querySelector('#mem-list .entry-claim')?.textContent.includes('fixture-A plan'), 'selection loads the plan channel');
  await clickSelector('.entry .more');
  await until(() => !!document.querySelector('.entry-evidence.open'), 'real click expands evidence');
  await capture('A-memory-expanded');
  await evaluate(() => { window.firstBody = document.querySelector('.entry-evidence.open'); });
  data.channelGrowth = true;
  await until(() => document.querySelector('#mem-list').textContent.includes('fixture-A new plan'), 'same channel receives appended data', 11500);
  assert.deepEqual(await evaluate(() => ({ same: firstBody === document.querySelector('.entry-evidence.open'),
    active: document.querySelector('#mem-subtabs .active').firstChild.textContent, math: !!firstBody.parentNode.querySelector('.katex') })), { same:true, active:'plan', math:true });
  passed('Channel refresh preserves selected subtab and expanded KaTeX entry DOM');

  Object.assign(data, { project:'fixture-B', revision:1, channelGrowth:false });
  await until(() => document.querySelector('#mem-list').textContent.includes('fixture-B direction'), 'B renders after clearing A', 11500);
  const b = await capture('B-memory');
  assert.equal(b.badge, 'fixture-B'); assert.equal(b.overview, ''); assert.equal(b.graph, ''); assert.doesNotMatch(JSON.stringify(b), /fixture-A/);
  assert.equal(await evaluate(() => echarts.getInstanceByDom(document.querySelector('#graph')) ?? null), null);
  await clickSelector('[data-tab="overview"]');
  await until(() => document.querySelector('#ov-cards .v')?.textContent === '1', 'B overview loaded');
  data.project = null;
  await until(() => document.querySelector('#landing-state').dataset.monitorState === 'idle', 'idle', 11500);
  const idle = await capture('idle');
  assert.deepEqual([idle.badge, idle.overview, idle.graph, idle.channels, idle.memory], ['', '', '', '', '']);
  assert.doesNotMatch(idle.proof, /fixture-[AB]/); assert.equal(idle.state, '当前没有正在推进的研究');
  passed('Rotation and idle clear DOM data from all three panels');
  win.destroy(); win = null;
  const beforeIdleOpen = report.requests.length;
  await openWindow();
  await until(() => document.querySelector('#landing-state').dataset.monitorState === 'idle', 'opening without a project immediately reports idle');
  assert.deepEqual(report.requests.slice(beforeIdleOpen).map(row => row.sub), ['/current']);
  data.project = 'fixture-B';
  await until(() => document.querySelector('#project-badge').textContent === 'fixture-B', 'idle-open page automatically sees B', 11500);
  await evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted:true })));
  assert.equal(await evaluate(() => document.querySelector('#project-badge').textContent), '');
  const beforeResume = report.requests.length;
  await evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted:true })));
  await until(() => document.querySelector('#project-badge').textContent === 'fixture-B', 'restored page refreshes immediately');
  const resumed = report.requests.slice(beforeResume).map(row => row.sub);
  assert.deepEqual(resumed, ['/current','/api/overview','/current']);
  passed('Actual close/reopen and persisted-page return do not duplicate monitor startup', resumed);
  win.destroy(); win = null;

  const count = report.requests.length, snapshotId = 'a'.repeat(16);
  await openWindow('/dashboard-launcher.html');
  assert.equal(await evaluate(() => !!document.querySelector('#snapshot-file, #new-dashboard')), true);
  const filename = path.join(out, 'isolated.hanamathgraph');
  fs.writeFileSync(filename, JSON.stringify({ kind:'hana-math.factgraph-snapshot', schemaVersion:1, projectId:'fixture-snapshot',
    asOf:'1'.repeat(64), capturedAt:1760000000000, graph:{ nodes:[graphRow(snapshotId, 'snapshot')], edges:[], max_depth:0 } }), { flag:'wx' });
  const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId:root.nodeId, selector:'#snapshot-file' });
  await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files:[filename] });
  await until(() => document.querySelector('#graph-stat').textContent.startsWith('1 facts'), 'legacy snapshot import chart');
  await clickFact();
  await until(() => document.querySelector('#fact-detail .fid')?.textContent === 'aaaaaaaaaaaaaaaa', 'legacy graph still accepts real pointer click');
  const theme = await evaluate(async () => {
    const { repaintDashboardTheme } = await import('./dashboard/app.js');
    const chart = echarts.getInstanceByDom(document.querySelector('#graph'));
    const color = () => chart.getOption().series[0].data[0].itemStyle.color;
    const before = color(); document.body.style.setProperty('--dash-depth-shallow', 'rgb(30, 80, 110)'); repaintDashboardTheme();
    return { before, after: color(), proof: document.querySelector('#fact-detail .fid').textContent };
  });
  assert.equal(theme.after, 'rgb(30,80,110)'); assert.notEqual(theme.before, theme.after); assert.equal(theme.proof, snapshotId);
  assert.equal(report.requests.length, count);
  passed('Legacy card keeps offline import, graph click and theme repaint without monitor requests', theme);
  assert.deepEqual(report.outsideRequests, []);
  assert.deepEqual(report.routeErrors, []);
  assert.deepEqual(report.consoleErrors, []);
}

app.on('window-all-closed', event => event.preventDefault());
function finish(error) {
  if (win && !win.isDestroyed()) win.destroy();
  report.ok = !error;
  if (error) report.error = error.stack;
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (error) console.error(error.stack);
  else console.log(`PASS isolated workspace DOM: ${report.assertions.length} checkpoints`);
  app.exit(error ? 1 : 0);
}
const deadline = setTimeout(() => finish(new Error('isolated runtime deadline')), 100000);
app.whenReady().then(run).then(() => { clearTimeout(deadline); finish(); }, error => { clearTimeout(deadline); finish(error); });
