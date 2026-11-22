/* Danus dashboard client. Overview / Fact Graph (echarts DAG) / Global Memory
   (per-channel). Read-only; data must be supplied to this view by its embedding. */
'use strict';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const textOf = (s) => (s == null ? '' : String(s));

let current;
async function api(binding, path) {
  const r = await binding.request(path);
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return r.json();
}
function connError(on) {
  const b = $('#conn-banner');
  b.hidden = !on;
  if (on) b.textContent = current ? 'Dashboard data is unavailable.' : 'Dashboard is not bound to a project.';
}

// ---- markdown + math ----------------------------------------------------- //
// Recognize math in the Markdown parser itself, not by rewriting user text
// into placeholder strings. Code spans, links and fenced blocks keep their own rules.
const DISPLAY_MATH = ['$$', '\\['];
let markdown;
function md() {
  if (!window.markdownit) return null;
  if (markdown) return markdown;
  const m = window.markdownit({ html: false, linkify: true, breaks: false });
  m.inline.ruler.before('escape', 'danus_math', (state, silent) => {
    const { src, pos, posMax } = state;
    const pair = src.slice(pos, pos + 2);
    const [open, close] = pair === '$$' ? ['$$', '$$'] : pair === '\\[' ? ['\\[', '\\]']
      : pair === '\\(' ? ['\\(', '\\)'] : src[pos] === '$' ? ['$', '$'] : [];
    if (!open) return false;
    const from = pos + open.length;
    const end = src.indexOf(close, from);
    if (end <= from || end + close.length > posMax) return false;
    const tex = src.slice(from, end);
    if (open === '$' && tex.includes('\n')) return false;
    if (!silent) {
      const token = state.push('danus_math', '', 0);
      token.content = tex;
      token.meta = { displayMode: DISPLAY_MATH.includes(open), raw: src.slice(pos, end + close.length) };
    }
    state.pos = end + close.length;
    return true;
  });
  // Standalone display math can cross paragraph boundaries.
  m.block.ruler.before('paragraph', 'danus_math', (state, start, end, silent) => {
    const line = i => state.src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]);
    const open = line(start).trimEnd();
    if (!DISPLAY_MATH.includes(open)) return false;
    const close = open === '$$' ? '$$' : '\\]';
    let i = start + 1;
    for (; i < end && line(i).trimEnd() !== close; i++) {
      if (state.sCount[i] < state.blkIndent && !state.isEmpty(i)) return false;
    }
    if (i === end) return false;
    if (!silent) {
      const token = state.push('danus_math', '', 0);
      token.content = state.getLines(start + 1, i, state.blkIndent, false);
      token.meta = { displayMode: true, raw: state.getLines(start, i + 1, state.blkIndent, false) };
      state.line = i + 1;
    }
    return true;
  }, { alt: ['paragraph'] });
  m.renderer.rules.danus_math = (tokens, i) => {
    const { content, meta } = tokens[i];
    try {
      if (window.katex) return window.katex.renderToString(content, { displayMode: meta.displayMode, trust: false, throwOnError: true });
    } catch { /* Keep the original formula on a parse failure. */ }
    return m.utils.escapeHtml(meta.raw);
  };
  // Never turn a Markdown image (even a relative path) into a resource request.
  m.renderer.rules.image = (tokens, i, options, env, self) =>
    m.utils.escapeHtml(self.renderInlineAsText(tokens[i].children, options, env) || '[image omitted]');
  return markdown = m;
}
export function renderMarkdownMath(node, value) {
  const text = textOf(value);
  node.classList.add('md');
  try {
    const parser = md();
    if (parser) {
      // Only markup emitted by the local renderers: Markdown HTML is disabled
      // and custom renderers return escaped text or KaTeX with trust disabled.
      node.innerHTML = parser.render(text);
      return;
    }
  } catch { /* A failed Markdown render falls back to the original text. */ }
  node.replaceChildren();
  for (const [i, line] of text.split('\n').entries()) {
    if (i) node.append(el('br'));
    node.append(line);
  }
}

// ---- tabs ---------------------------------------------------------------- //
function switchTab(name, proofJump) {
  document.querySelectorAll('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  const binding = current;
  if (!binding) return;
  if (binding.snapshot || binding.workspace) {
    if (binding.workspace && binding.tab !== name) {
      binding.tab = name;
      binding.proofJump = proofJump;
      binding.graphClick = null; // Retire chart events from the previous visit.
    }
    if (name === 'graph') binding.chart?.resize();
    binding.workspace?.(name);
    return;
  }
  if (name === 'overview') void loadOverview(binding);
  if (name === 'graph') { binding.chart?.resize(); void loadGraph(binding); }
  if (name === 'memory') void loadMemory(binding);
}

// ---- overview ------------------------------------------------------------ //
function bars(container, obj, colorFn) {
  container.replaceChildren();
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  for (const [k, v] of entries) {
    const row = el('div', 'bar-row');
    row.appendChild(el('div', 'bar-label', k));
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = (v / max * 100).toFixed(1) + '%';
    if (colorFn) fill.style.background = colorFn(k);
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('div', 'bar-val', String(v)));
    container.appendChild(row);
  }
}
async function loadOverview(binding) {
  try {
    const d = await api(binding, '/api/overview');
    if (current !== binding) return;
    connError(false);
    renderOverview(d, d.project || '');
  } catch { if (current === binding) connError(true); }
}
function renderOverview(d, project) {
    $('#project-badge').textContent = project;
    $('#refresh-note').textContent = 'updated ' + new Date(d.updated_at * 1000).toLocaleTimeString();
    const cards = [
      ['Verified facts', d.facts, `${d.facts_with_predecessors} with predecessors`],
      ['Global-memory entries', Object.values(d.channel_counts).reduce((a, b) => a + b, 0), `${Object.keys(d.channel_counts).length} channels`],
      ['Verifier verdicts', (d.verdicts.correct || 0) + (d.verdicts.wrong || 0), `${d.verdicts.correct || 0} correct · ${d.verdicts.wrong || 0} wrong`],
    ];
    const c = $('#ov-cards'); c.replaceChildren();
    for (const [k, v, sub] of cards) {
      const card = el('div', 'card');
      card.appendChild(el('div', 'k', k));
      card.appendChild(el('div', 'v', String(v)));
      card.appendChild(el('div', 'sub', sub));
      c.appendChild(card);
    }
    bars($('#ov-channels'), d.channel_counts);
    bars($('#ov-authors'), d.facts_by_author);
    const vd = $('#ov-verdicts'); vd.replaceChildren();
    const chips = el('div', 'chips');
    const vmap = { correct: 'var(--green)', wrong: 'var(--red)', error: 'var(--orange)' };
    for (const [k, v] of Object.entries(d.verdicts)) {
      const chip = el('div', 'chip');
      const dot = el('span', 'dot'); dot.style.background = vmap[k] || 'var(--text-muted)';
      chip.appendChild(dot); chip.appendChild(document.createTextNode(`${k}: ${v}`));
      chips.appendChild(chip);
    }
    vd.appendChild(chips);
}

// ---- fact graph (echarts) ------------------------------------------------ //
// importance = dependency depth (longest path from an axiom/leaf up to a fact).
// Use the same endpoints as the legend. Normalize resolved CSS colors for
// ECharts' canvas (its palette does not resolve CSS variables itself).
function graphPalette() {
  const css = getComputedStyle(document.body);
  const pixel = document.createElement('canvas').getContext('2d');
  const rgb = key => {
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = css.getPropertyValue(key).trim();
    pixel.fillRect(0, 0, 1, 1);
    return [...pixel.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  return {
    shallow: rgb('--dash-depth-shallow'), deep: rgb('--dash-depth-deep'),
    edge: `rgb(${rgb('--border-strong').join(',')})`,
    tooltip: { backgroundColor: `rgb(${rgb('--bg-primary').join(',')})`, borderColor: `rgb(${rgb('--border').join(',')})`,
      textStyle: { color: `rgb(${rgb('--text-primary').join(',')})` } },
  };
}
function depthColor(depth, maxDepth, { shallow, deep }) {
  const t = maxDepth > 0 ? Math.min(1, depth / maxDepth) : 0;
  return `rgb(${shallow.map((x, i) => Math.round(x + t * (deep[i] - x))).join(',')})`;
}
export function repaintDashboardTheme() {
  const graphChart = current?.chart;
  if (!graphChart) return;
  const palette = graphPalette(), nodes = graphChart.getOption().series[0].data;
  const maxDepth = Math.max(1, ...nodes.map(n => n.depth));
  graphChart.setOption({ tooltip: palette.tooltip, series: [{ lineStyle: { color: palette.edge },
    data: nodes.map(n => ({ ...n, itemStyle: { color: depthColor(n.depth, maxDepth, palette) } })) }] });
}
export function factTooltip(data, statement) {
  const tip = el('div');
  tip.append(el('b', null, textOf(data.id).slice(0, 10)), ` · by ${textOf(data.author)}`, el('br'),
    `dependency depth: ${textOf(data.depth)} layer(s)`, el('br'), `${textOf(statement).slice(0, 100)}…`);
  return tip;
}
async function loadGraph(binding) {
  try {
    const d = await api(binding, '/api/factgraph');
    if (current !== binding) return;
    connError(false);
    renderGraph(binding, d);
  } catch { if (current === binding) connError(true); }
}
function renderGraph(binding, d) {
    binding.facts = new Map(d.nodes.map(n => [n.id, n]));
    const maxD = d.max_depth || 1, palette = graphPalette();
    const nodes = d.nodes.map((n) => {
      const dp = n.depth || 0;
      return {
        id: n.id, name: n.id.slice(0, 7),
        symbolSize: 6 + Math.min(16, dp * 2.5),        // bigger = deeper, but capped small so circles don't overlap when zoomed out
        itemStyle: { color: depthColor(dp, maxD, palette) },
        depth: dp, author: n.author,                   // no per-node label (would clutter)
      };
    });
    const links = d.edges.map((e) => ({ source: e.source, target: e.target }));
    const graphChart = binding.chart ??= echarts.init($('#graph'));
    if (binding.workspace) binding.graphClick = null;
    graphChart.setOption({
      tooltip: {
        ...palette.tooltip, renderMode: 'html',
        // ECharts accepts an HTMLElement here. Research text is never HTML.
        formatter: (p) => current === binding && p.dataType === 'node'
          ? factTooltip(p.data, binding.facts.get(p.data.id)?.statement) : '',
      },
      series: [{
        type: 'graph', layout: 'force', roam: true, draggable: true,
        force: { repulsion: 160, edgeLength: 80, gravity: 0.06 },
        label: { show: false }, emphasis: { focus: 'adjacency', label: { show: false } },
        lineStyle: { color: palette.edge, width: 1, opacity: 0.55, curveness: 0.05 },
        edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 5,
        data: nodes, links: links,
      }],
    });
    if (!binding.workspace) {
      graphChart.off('click');
      graphChart.on('click', (p) => { if (p.dataType === 'node') showFact(binding, p.data.id); });
    }
    $('#graph-stat').textContent = `${d.nodes.length} facts · ${d.edges.length} edges · max depth ${d.max_depth}`;
    graphChart.resize();
}
function canPickWorkspaceFact(binding) {
  return current === binding && binding.tab === 'graph' && !document.hidden && binding.graphClick && !binding.proofJump;
}
function showFact(binding, id) {
  if (current !== binding) return;
  const f = binding.facts?.get(id); if (!f) return;
  if (binding.workspace) binding.selectedFact = id;
  const d = $('#fact-detail'); d.replaceChildren();
  d.appendChild(el('div', 'fid', f.id));
  if (f.author || f.problem_id) d.appendChild(el('div', 'muted', `${f.author || '?'} · ${f.problem_id || ''}`));
  const addSec = (h, txt) => { if (!txt) return; d.appendChild(el('div', 'sec-h', h)); const m = el('div', 'math'); renderMarkdownMath(m, txt); d.appendChild(m); };
  addSec('Statement', f.statement);
  addSec('Proof', f.proof);
  addSec('Intuition', f.intuition);
  if (f.predecessors.length) {
    d.appendChild(el('div', 'sec-h', `Predecessors (${f.predecessors.length})`));
    const wrap = el('div');
    f.predecessors.forEach((p) => {
      const a = el('span', 'pred-link', p.slice(0, 10));
      a.onclick = () => {
        if (!binding.workspace || (canPickWorkspaceFact(binding) && d.contains(a))) showFact(binding, p);
      };
      wrap.appendChild(a);
    });
    d.appendChild(wrap);
  }
}

// ---- global memory ------------------------------------------------------- //
// channels whose entries are long markdown (summary/strategy) — render full, no clamp.
const LONGFORM = new Set(['elaboration', 'master_guidance', 'verification']);
async function loadMemory(binding) {
  if (binding.memInit) return;
  binding.memInit = true;
  try {
    const d = await api(binding, '/api/channels');
    if (current !== binding) return;
    connError(false);
    const st = $('#mem-subtabs'); st.replaceChildren();
    d.channels.forEach((ch, i) => {
      const b = el('div', 'subtab' + (i === 0 ? ' active' : ''));
      b.appendChild(document.createTextNode(ch.kind));
      b.appendChild(el('span', 'cnt', String(ch.count)));
      b.onclick = () => {
        if (current !== binding) return;
        st.querySelectorAll('.subtab').forEach((x) => x.classList.remove('active'));
        b.classList.add('active'); void loadChannel(binding, ch.kind);
      };
      st.appendChild(b);
    });
    if (d.channels.length) void loadChannel(binding, d.channels[0].kind);
  } catch { if (current === binding) { connError(true); binding.memInit = false; } }
}
async function loadChannel(binding, kind) {
  const selection = binding.selection = {};
  const selected = () => current === binding && binding.selection === selection;
  const list = $('#mem-list'); list.replaceChildren(el('div', 'empty', 'loading…'));
  const longform = LONGFORM.has(kind);
  try {
    const d = await api(binding, '/api/channel/' + encodeURIComponent(kind));
    if (!selected()) return;
    list.replaceChildren();
    if (!d.entries.length) { list.append(el('div', 'empty', 'no entries in this channel')); return; }
    for (const e of d.entries) list.appendChild(renderEntry(e, longform));
  } catch { if (selected()) list.replaceChildren(el('div', 'empty', 'failed to load')); }
}
function renderEntry(e, longform, expanded = false, openProof) {
      const card = el('div', 'entry' + (longform ? ' longform' : ''));
      const head = el('div', 'entry-head');
      head.appendChild(el('span', 'entry-author', e.author || '?'));
      if (e.verdict) head.appendChild(el('span', 'tag ' + (e.verdict === 'correct' ? 'correct' : e.verdict === 'wrong' ? 'wrong' : ''), e.verdict));
      if (e.fact_id) {
        const label = String(e.fact_id).slice(0, 10), tag = el(openProof ? 'button' : 'span', 'tag fid', label);
        if (openProof) {
          tag.type = 'button';
          tag.setAttribute('aria-label', `查看证明 ${label}`);
          tag.onclick = () => openProof(card);
        }
        head.appendChild(tag);
      }
      if (e.cost_usd != null) head.appendChild(el('span', 'tag cost', '$' + e.cost_usd));
      if (e.status) head.appendChild(el('span', 'tag', e.status));
      head.appendChild(el('span', 'entry-ts', (e.timestamp_utc || '').slice(0, 19).replace('T', ' ')));
      card.appendChild(head);
      const claim = el('div', 'entry-claim'); renderMarkdownMath(claim, e.claim); card.appendChild(claim);
      if (e.evidence) {
        const ev = el('div', 'entry-evidence' + (longform ? '' : expanded ? ' clamp open' : ' clamp'));
        renderMarkdownMath(ev, e.evidence); card.appendChild(ev);
        if (!longform) {
          const more = el('div', 'more', expanded ? 'show less ▴' : 'show more ▾');
          more.onclick = () => { const open = ev.classList.toggle('open'); more.textContent = open ? 'show less ▴' : 'show more ▾'; };
          card.appendChild(more);
        }
      }
      return card;
}

// ---- init + polling ------------------------------------------------------ //
function unmountDashboard(binding) {
  if (current !== binding) return;
  current = undefined; // Invalidate pending work before disposing its visible state.
  clearInterval(binding.timer);
  binding.chart?.dispose();
  binding.chart = undefined;
  binding.facts?.clear();
  for (const selector of ['#project-badge', '#refresh-note', '#ov-cards', '#ov-channels', '#ov-authors',
    '#ov-verdicts', '#graph', '#graph-stat', '#mem-subtabs', '#mem-list']) $(selector).replaceChildren();
  clearFactDetail();
  if (binding.workspace) delete document.body.dataset.hasSnapshot;
  connError(true);
}
function clearFactDetail() {
  $('#fact-detail').replaceChildren(el('div', 'muted', 'Click a node to inspect its statement, proof, and predecessors.'));
}
const workspaceTabs = new Set(['overview', 'graph', 'memory']);
const canonicalFactId = value => typeof value === 'string' && value.length === 16 && /^[0-9a-f]{16}$/.test(value);
const sameWorkspaceScope = (a, b) => !!a && a.state === b.state && a.projectId === b.projectId && a.generation === b.generation;
const graphLayout = d => JSON.stringify([d.max_depth, d.nodes.map(n => [n.id, n.depth, n.author]), d.edges.map(e => [e.source, e.target])]);
const factDetail = f => JSON.stringify([f.author, f.problem_id, f.statement, f.proof, f.intuition, f.predecessors]);
const entryContent = e => JSON.stringify([e.author, e.verdict, e.fact_id, e.cost_usd, e.status, e.timestamp_utc, e.claim, e.evidence]);

function arrange(container, nodes) {
  const keep = new Set(nodes);
  for (const child of [...container.children]) if (!keep.has(child)) child.remove();
  for (const [i, child] of nodes.entries()) {
    const at = container.children[i];
    if (child !== at) container.insertBefore(child, at ?? null);
  }
}

function workspaceGraph(binding, data) {
  const selected = binding.selectedFact;
  const old = selected && binding.facts?.get(selected);
  const layout = graphLayout(data);
  if (layout !== binding.layout) {
    renderGraph(binding, data);
    binding.layout = layout;
  } else binding.facts = new Map(data.nodes.map(n => [n.id, n]));
  // The existing stylesheet uses this flag to reveal populated graph detail.
  // In this opt-in adapter it says nothing about the origin of the data.
  document.body.dataset.hasSnapshot = '';
  if (!selected) return;
  const updated = binding.facts.get(selected);
  if (!updated) { binding.selectedFact = null; clearFactDetail(); }
  else if (!old || factDetail(old) !== factDetail(updated)) {
    const detail = $('#fact-detail'), scroll = detail.scrollTop;
    showFact(binding, selected);
    detail.scrollTop = scroll;
  }
}

function workspaceMemory(binding, data, channel, entries, changes) {
  const subtabs = $('#mem-subtabs'), list = $('#mem-list');
  if (changes.data || changes.channel) {
    const next = new Map();
    for (const item of data.channels) {
      let row = binding.channels.get(item.kind);
      if (!row) {
        const button = el('div', 'subtab'), count = el('span', 'cnt');
        button.append(document.createTextNode(item.kind), count);
        button.onclick = () => { if (current === binding) binding.workspace('memory', item.kind); };
        row = { button, count };
      }
      row.button.classList.toggle('active', item.kind === channel);
      const count = String(item.count);
      if (row.count.textContent !== count) row.count.textContent = count;
      next.set(item.kind, row);
    }
    arrange(subtabs, [...next.values()].map(row => row.button));
    binding.channels = next;
  }
  if (!changes.entries) return;
  const longform = LONGFORM.has(channel);
  const previous = channel === binding.channel ? binding.entries.slice() : [];
  binding.channel = channel;
  const byId = new Map();
  for (const item of previous) {
    const seen = byId.get(item.id) ?? [];
    seen.push(item); byId.set(item.id, seen);
  }
  binding.entries = (entries ?? []).map(entry => {
    const content = entryContent(entry), id = entry.id ?? content;
    const old = byId.get(id)?.shift();
    if (old?.content === content) return old;
    const expanded = Boolean(old?.node.querySelector('.entry-evidence.open'));
    const factId = entry.fact_id;
    const openProof = channel === 'verification' && canonicalFactId(factId) ? card => {
      if (current !== binding || document.hidden || binding.tab !== 'memory' || binding.channel !== 'verification'
          || card.parentNode !== list || !binding.scope) return;
      binding.selectedFact = null;
      clearFactDetail();
      switchTab('graph', { scope: binding.scope, factId });
    } : undefined;
    return { id, content, node: renderEntry(entry, longform, expanded, openProof) };
  });
  arrange(list, binding.entries.length ? binding.entries.map(row => row.node) : channel ? [el('div', 'empty', 'no entries in this channel')] : []);
}

// Explicitly mounted by the workspace page; the old card and both document
// Previews continue to use mountDashboard's independent modes.
export function mountWorkspaceDashboard(onSelect) {
  if (typeof onSelect !== 'function') throw new TypeError('Workspace dashboard requires a selection sink');
  if (current) unmountDashboard(current);
  const links = [...document.querySelectorAll('.nav-link')];
  const saved = links.map(link => link.onclick);
  const handlers = links.map(link => () => switchTab(link.dataset.tab));
  links.forEach((link, i) => { link.onclick = handlers[i]; });
  let binding;
  const getTab = () => $('.nav-link.active')?.dataset.tab ?? 'overview';
  const newBinding = () => ({ workspace: onSelect, tab: getTab(), channels: new Map(), entries: [] });
  binding = current = newBinding();
  function clear() {
    if (current !== binding) return;
    unmountDashboard(binding);
    binding = current = newBinding();
  }
  return Object.freeze({ clear, render({ scope, tab, data, channel, entries, changes }) {
    if (current !== binding || !workspaceTabs.has(tab)) return;
    if (binding.scope && !sameWorkspaceScope(binding.scope, scope)) clear();
    binding.scope = scope;
    const snapshot = scope.state === 'snapshot';
    const project = snapshot && scope.projectName?.trim() && scope.projectName !== scope.projectId
      ? `${scope.projectName} · ${scope.projectId}` : scope.projectId;
    $('#project-badge').textContent = project;
    if (tab === 'overview') renderOverview(data, project);
    if (tab === 'graph') workspaceGraph(binding, data);
    if (tab === 'memory') workspaceMemory(binding, data, channel, entries, changes);
    if (snapshot) $('#refresh-note').textContent = `结束时间 ${new Date(scope.endedAt).toISOString()}`;
    connError(false);
  }, graphValidated(scope, data) {
    const target = binding;
    if (current !== target || target.tab !== 'graph' || document.hidden || !sameWorkspaceScope(target.scope, scope)) return;
    const jump = target.proofJump;
    target.proofJump = null;
    if (jump && sameWorkspaceScope(jump.scope, scope) && data.nodes.some(node => node.id === jump.factId)) showFact(target, jump.factId);
    // Re-arm only on a confirmed graph after a tab or chart change, not on each poll.
    if (!target.graphClick && target.chart) {
      const click = target.graphClick = p => {
        if (target.graphClick === click && canPickWorkspaceFact(target) && p.dataType === 'node') showFact(target, p.data.id);
      };
      target.chart.off('click');
      target.chart.on('click', click);
    }
  }, status({ state, text }) {
    if (current !== binding) return;
    const notice = $('#landing-state');
    notice.dataset.monitorState = state;
    notice.textContent = text;
  }, select(tab) {
    if (current === binding && workspaceTabs.has(tab)) switchTab(tab);
  }, getTab, dispose() {
    if (current !== binding) return;
    unmountDashboard(binding);
    links.forEach((link, i) => { if (link.onclick === handlers[i]) link.onclick = saved[i]; });
    const notice = $('#landing-state');
    delete notice.dataset.monitorState;
    notice.textContent = '尚未连接项目';
  } });
}

export function mountDashboard({ request, snapshot, notice } = {}) {
  // Only a trusted embedding module can supply data for this view. The page
  // never derives authority, an endpoint, or a project from the URL or a message.
  if (current) unmountDashboard(current);
  document.querySelectorAll('.nav-link').forEach(a => { a.onclick = () => switchTab(a.dataset.tab); });
  if (snapshot) {
    const binding = current = { snapshot: true };
    try {
      connError(false);
      $('#project-badge').textContent = snapshot.projectId;
      $('#refresh-note').textContent = `快照 · 取样时间 ${new Date(snapshot.capturedAt).toISOString()}`;
      $('#ov-cards').append(el('div', 'empty', '此快照未包含 Overview 数据。'));
      $('#mem-list').append(el('div', 'empty', '此快照未包含 Global Memory 数据。'));
      switchTab('graph');
      renderGraph(binding, snapshot.graph);
      return () => unmountDashboard(binding);
    } catch (error) {
      unmountDashboard(binding);
      throw error;
    }
  }
  if (!request) {
    connError(true);
    if (notice) $('#conn-banner').textContent = notice;
    return () => {};
  }
  const binding = current = { request };
  connError(false);
  void loadOverview(binding);
  const tab = $('.nav-link.active')?.dataset.tab;
  if (tab && tab !== 'overview') switchTab(tab);
  binding.timer = setInterval(() => {
    if (current === binding && $('.nav-link.active')?.dataset.tab === 'overview') void loadOverview(binding);
  }, 15000);
  return () => unmountDashboard(binding);
}
