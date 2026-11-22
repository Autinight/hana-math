import { hana } from '../assets/sdk.js';
import { installDashboardDrop } from '../assets/dashboard-launcher.mjs';
import { mountDashboard } from './app.js';
import { decodeSnapshotFile } from './snapshot.mjs';
import { startDashboard } from './theme.js';
import { installTabHitRegions } from './tab-hit-regions.mjs';

// Only the legacy route opts into native document handoff; it is not a catalog entry.
// Neither URL input nor a selected file supplies a live-project identity.
const entry = document.body.dataset.dashboardEntry;
const ordinary = entry === 'card', workspaceMonitor = entry === 'page';
const EMPTY = '尚未连接项目';

document.body.innerHTML = `
  <div id="conn-banner" hidden></div>
  <header class="header">
    <h1>研究看板</h1>
    <span class="badge badge-version">Danus</span>
    <span id="project-badge" class="badge badge-project"></span>
    <nav class="header-nav" aria-label="看板视图">
      <button type="button" class="nav-link active" data-tab="overview" aria-controls="tab-overview">总览</button>
      <button type="button" class="nav-link" data-tab="graph" aria-controls="tab-graph">事实图</button>
      <button type="button" class="nav-link" data-tab="memory" aria-controls="tab-memory">共享记忆</button>
    </nav>
    <span id="refresh-note" class="refresh-note"></span>
  </header>
  <div class="landing-tools">
    <span id="landing-state" role="status">${workspaceMonitor ? '正在确认研究状态' : EMPTY}</span>
    ${ordinary ? '<label class="landing-action">导入只读快照 <input id="snapshot-file" type="file" accept=".hanamathgraph"></label><button class="landing-action" id="new-dashboard" type="button" disabled>新建空白看板文件…</button><span class="landing-hint">也可拖入 .hanamathboard，然后在创建项目的对话中绑定。</span>' : ''}
    <span id="landing-status" role="status"></span>
  </div>
  <main class="main">
    <!-- Overview -->
    <section id="tab-overview" class="tab active">
      <div id="ov-cards" class="cards"></div>
      <div class="ov-grid">
        <div class="panel"><div class="panel-h">Global-memory channels</div><div id="ov-channels" class="bars"></div></div>
        <div class="panel"><div class="panel-h">Verifier verdicts</div><div id="ov-verdicts"></div></div>
        <div class="panel"><div class="panel-h">Facts by author</div><div id="ov-authors" class="bars"></div></div>
      </div>
    </section>

    <!-- Fact Graph -->
    <section id="tab-graph" class="tab">
      <div class="graph-wrap">
        <div class="graph-toolbar">
          <span class="muted">size + shade = dependency depth:</span>
          <span class="legend">axiom</span>
          <span style="width:130px;height:11px;border-radius:6px;display:inline-block;background:linear-gradient(90deg,var(--dash-depth-shallow),var(--dash-depth-deep))"></span>
          <span class="legend">deep result</span>
          <span id="graph-stat" class="muted"></span>
        </div>
        <div id="graph" class="graph"></div>
        <aside id="fact-detail" class="fact-detail">
          <div class="muted">Click a node to inspect its statement, proof, and predecessors.</div>
        </aside>
      </div>
    </section>

    <!-- Global Memory -->
    <section id="tab-memory" class="tab">
      <div id="mem-subtabs" class="subtabs"></div>
      <div id="mem-list" class="mem-list"></div>
    </section>
  </main>
`;

const input = document.querySelector('#snapshot-file');
const state = document.querySelector('#landing-state');
const status = document.querySelector('#landing-status');
let generation = 0, importing = 0, stopSnapshot, stopDrop;
const dashboardReady = startDashboard(hana, { workspaceMonitor });
installTabHitRegions(hana, document.querySelector('.dashboard-landing > .header'));

function clearSnapshot() {
  stopSnapshot?.(); stopSnapshot = undefined;
  delete document.body.dataset.hasSnapshot;
  state.textContent = EMPTY;
}
input?.addEventListener('change', async () => {
  const file = input.files?.length === 1 ? input.files[0] : null;
  input.value = '';
  if (!file) return;
  const turn = ++importing, lifetime = generation;
  const current = () => lifetime === generation && turn === importing;
  clearSnapshot(); status.textContent = '';
  try {
    const snapshot = await decodeSnapshotFile(file);
    if (!current()) return;
    document.body.dataset.hasSnapshot = '';
    stopSnapshot = mountDashboard({ snapshot });
    state.textContent = '本地只读快照 · 不自动刷新';
  } catch {
    if (!current()) return;
    clearSnapshot(); status.textContent = '无法导入：请选择有效的 .hanamathgraph 快照（不超过 1 MiB）。';
  }
});

async function armCard(ready) {
  if (!ordinary) return;
  const lifetime = generation;
  try {
    await ready;
    if (lifetime !== generation) return;
    stopDrop = installDashboardDrop(hana, document.body, status, document.querySelector('#new-dashboard'));
  } catch { /* The local snapshot importer remains available without the Host. */ }
}
if (ordinary) {
  window.addEventListener('pagehide', () => { generation++; clearSnapshot(); status.textContent = ''; stopDrop?.(); stopDrop = undefined; });
  window.addEventListener('pageshow', e => { if (e.persisted) void armCard(hana.ready()); });
  void armCard(dashboardReady);
}
