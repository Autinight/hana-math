import { exact, id, liveChannels } from './live-protocol.mjs';

const PREFIX = '/workspace-monitor';
const GENERATION = 'x-hana-math-monitor-generation';
export const WORKSPACE_POLL_INTERVAL_MS = 8000;
const LABEL = { idle: '当前没有正在推进的研究', unavailable: '研究状态暂不可用', unsupported: '当前版本无法连接实时研究看板',
  pending: '正在确认研究状态', active: '正在跟踪研究', snapshot: '只读快照', saved: '当前已保存结果（只读）' };
const TABS = { overview: '/api/overview', graph: '/api/factgraph', memory: '/api/channels' };
const channelNames = new Set(liveChannels);
const object = v => !!v && typeof v === 'object' && !Array.isArray(v) && !Object.hasOwn(v, 'error');
const readable = scope => scope.state === 'active' || scope.state === 'snapshot' || scope.state === 'saved';
const epochMs = value => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;
const same = (a, b) => !!a && !!b && a.state === b.state && a.projectId === b.projectId && a.generation === b.generation
  && (a.state !== 'snapshot' || a.endedAt === b.endedAt && a.projectName === b.projectName)
  && (a.state !== 'saved' || a.asOf === b.asOf);
const refusal = () => new Error('Workspace monitor unavailable');
const STAGE = { sdk: 'SDK 就绪', discovery: '发现 GET', business: '业务读取', verify: '最终代次复核' };
const SDK_NOT_READY = `${LABEL.unavailable} · SDK 未就绪，尚未发请求`;
const REASON = { missing: '未收到 HTTP 响应', invalid: '响应无法使用',
  unavailable: '服务返回不可用', deadline: '超过时限', other: '未完成', busy: '项目正忙，看板会自动重试' };
const httpCode = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
function failureText(stage, reason, code = null) {
  if (reason === 'sdk') return SDK_NOT_READY;
  const detail = reason === 'http' ? `HTTP ${code}${code === 403 ? '（请求被拒绝）' : code === 409 ? '（读取未获确认）' : ''}`
    : `${code === null ? '' : `HTTP ${code}：`}${REASON[reason]}`;
  return `${LABEL.unavailable} · ${STAGE[stage]}：${detail}`;
}
export const workspaceSdkUnavailable = Object.freeze({ state: 'unavailable', text: failureText('sdk', 'sdk') });
const comparable = value => JSON.stringify(value, (_, part) => object(part)
  ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]])) : part);

function discovery(value) {
  if (!object(value)) throw refusal();
  if (value.state === 'idle' || value.state === 'unavailable') return { state: value.state };
  if (!readable(value) || !id(value.projectId) || !id(value.generation)) throw refusal();
  const { state, projectId, generation } = value;
  if (state === 'active') return Object.freeze({ state, projectId, generation });
  if (state === 'saved') {
    if (!exact(value, ['state', 'projectId', 'generation', 'asOf']) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(projectId)
      || generation.includes(',') || !epochMs(value.asOf)) throw refusal();
    return Object.freeze({ state, projectId, generation, asOf: value.asOf });
  }
  const named = Object.hasOwn(value, 'projectName'), { endedAt, projectName } = value;
  if (!exact(value, ['state', 'projectId', 'generation', 'endedAt', ...(named ? ['projectName'] : [])])
    || !epochMs(endedAt) || (named && typeof projectName !== 'string')) throw refusal();
  return Object.freeze({ state, projectId, generation, endedAt, ...(named ? { projectName } : {}) });
}

function checked(tab, value) {
  if (!object(value)) throw refusal();
  if (tab === 'overview' && !['channel_counts', 'facts_by_author', 'verdicts'].every(key => object(value[key]))) throw refusal();
  if (tab === 'graph' && (!Array.isArray(value.nodes) || !Array.isArray(value.edges))) throw refusal();
  if (tab === 'memory' && (!Array.isArray(value.channels) || value.channels.some(c => !object(c) || !channelNames.has(c.kind))
    || new Set(value.channels.map(c => c.kind)).size !== value.channels.length)) throw refusal();
  if (tab === 'entries' && !Array.isArray(value.entries)) throw refusal();
  return value;
}

// The workspace surface supplies clear/render/status and invokes select on a
// tab or channel change. No project or session input is accepted from the view.
// A render is a synchronous commit; clear must remove *all* prior data and
// selection UI. Keep fact/entry selection on same-scope commits (sameScope is
// indicated by the absence of a preceding clear); unchanged panels aren't rendered.
// graphValidated is a non-rendering witness for the current graph read, even on a cache hit.
// The workspace entry supplies the Host's authenticated App route transport.
// This controller must not choose a different transport on its own.
export function createWorkspaceMonitor(transport, { clear, render, status, graphValidated }, {
  visibility = globalThis.document, lifecycle = globalThis.window, setTimer = setTimeout, clearTimer = clearTimeout,
  interval = WORKSPACE_POLL_INTERVAL_MS, deadline = 12000, initialTab = 'overview',
} = {}) {
  if (typeof transport?.ready !== 'function' || typeof transport?.fetch !== 'function') {
    clear();
    status({ state: 'unsupported', text: LABEL.unsupported });
    return Object.freeze({ select() {}, dispose() {} });
  }
  let stopped = false, pageVisible = true, life = null;
  let tab = Object.hasOwn(TABS, initialTab) ? initialTab : 'overview', channel = null, selection = 0;
  let scope = null, dataCache = new Map(), visibleData = null, lastStatus = null, firstFailure = null;

  function publish(state, detail, showFailure = true) {
    // Keep the first failure across retries, not just across promise races.
    if (state === 'idle' || readable({ state })) firstFailure = null;
    else firstFailure ??= detail ?? null;
    const text = (showFailure && firstFailure) || LABEL[state];
    if (lastStatus?.state === state && lastStatus.text === text) return;
    lastStatus = { state, text };
    status({ state, text });
  }
  function clearScope(state, detail, showFailure) {
    if (scope || visibleData) clear();
    scope = null;
    channel = null;
    dataCache = new Map();
    visibleData = null;
    publish(state, detail, showFailure);
  }

  function alive(l) { return life === l && !stopped && pageVisible && !visibility.hidden; }
  async function packet(l, signal, control, path, validate, generation) {
    if (!alive(l) || signal.aborted) throw refusal();
    let response;
    try {
      response = await transport.fetch(PREFIX + path, { method: 'GET', cache: 'no-store', signal,
        ...(generation === undefined ? {} : { headers: { [GENERATION]: generation } }) });
    } catch { throw control.fail('missing'); }
    if (!alive(l) || signal.aborted) throw refusal();
    const code = httpCode(response?.status);
    if (!response?.ok) {
      if (response?.ok === false && code === 409 && control.stage === 'business' && generation !== undefined) {
        let busy = false;
        try {
          const value = await response.json();
          busy = exact(value, ['state', 'reason']) && value.state === 'unavailable' && value.reason === 'project_busy';
        } catch { /* Untyped or unreadable conflict stays a generic 409. */ }
        // Parsing shares the existing deadline. A late body/rejection cannot
        // classify an expired or suspended read or schedule another poll.
        if (!alive(l) || signal.aborted) throw refusal();
        if (busy) { control.busy = true; throw control.fail('busy'); }
      }
      throw code === null ? control.fail('missing') : control.fail('http', code);
    }
    try {
      const result = await response.json();
      if (!alive(l) || signal.aborted) throw refusal();
      const checked = validate(result);
      // The identical 200 packet cannot distinguish bootstrap from selection.
      if (path === '/current' && checked.state === 'unavailable') control.note('unavailable', code);
      return checked;
    } catch { throw control.fail('invalid', code); }
  }
  function applyDiscovery(next, detail) {
    if (!readable(next)) { clearScope(next.state, next.state === 'unavailable' ? detail : undefined); return false; }
    if (!same(scope, next)) {
      clearScope('pending');
      scope = next;
    }
    return true;
  }

  async function read(l, signal, control) {
    if (!l.ready) {
      try { await transport.ready(); } catch { throw control.fail('sdk'); }
      if (!alive(l) || signal.aborted) return;
      l.ready = true;
    }
    const readCurrent = () => packet(l, signal, control, '/current', discovery);
    control.stage = 'discovery';
    const next = await readCurrent();
    if (!alive(l) || signal.aborted || !applyDiscovery(next, control.first)) return;
    const target = tab, requested = channel, stamp = selection;
    control.stage = 'business';
    const readTab = (url, view) => packet(l, signal, control, url, value => checked(view, value), next.generation);
    const data = await readTab(TABS[target], target);
    let selectedChannel = null, entries = null;
    if (target === 'memory' && stamp === selection) {
      selectedChannel = data.channels.find(row => row.kind === requested)?.kind ?? data.channels[0]?.kind ?? null;
      if (selectedChannel) entries = (await readTab(`/api/channel/${selectedChannel}`, 'entries')).entries;
    }
    // Buffer the payload. A response can have been valid when issued yet arrive
    // after a generation transition. Only commit after a fresh route witness.
    control.stage = 'verify';
    const latest = await readCurrent();
    if (!alive(l) || signal.aborted) return;
    if (!same(next, latest)) {
      // The backend selects active before terminal history. Recheck either kind
      // before delivery; do not keep or resurrect the outgoing tab's data.
      if (applyDiscovery(latest, control.first)) control.again = true;
      return;
    }
    if (stamp !== selection || !same(scope, next)) return;
    if (target === 'memory') channel = selectedChannel;
    const prior = dataCache.get(target);
    const fresh = { data: comparable(data), channel: selectedChannel, entries: comparable(entries) };
    const changes = { data: prior?.data !== fresh.data, channel: prior?.channel !== fresh.channel,
      entries: prior?.entries !== fresh.entries || prior?.channel !== fresh.channel };
    // Do not recreate a chart or text nodes merely because a poll completed.
    // A channel count can update without replacing the entry body being read.
    if (changes.data || changes.channel || changes.entries) {
      render({ scope: next, tab: target, data, channel: selectedChannel, entries, changes });
      dataCache.set(target, fresh);
      visibleData = true;
    }
    if (target === 'graph') graphValidated?.(next, data);
    publish(next.state);
  }

  function enqueue(l) {
    if (!alive(l)) return;
    if (l.poll !== undefined) { clearTimer(l.poll); l.poll = undefined; }
    if (l.running) { l.queued = true; return; }
    l.running = true;
    l.queued = false;
    const abort = l.abort = new AbortController();
    const control = { again: false, busy: false, stage: 'sdk', first: null,
      note(reason, code) { this.first ??= failureText(this.stage, reason, code); },
      fail(reason, code) { this.note(reason, code); return refusal(); } };
    // Latch the deadline before abort listeners can report a second cause.
    const timeout = new Promise((_, reject) => {
      l.limit = setTimer(() => {
        const error = control.fail('deadline'); abort.abort(); reject(error);
      }, deadline);
    });
    void Promise.race([read(l, abort.signal, control), timeout]).catch(() => {
      control.note('other');
      if (alive(l)) clearScope('unavailable', control.first);
    }).finally(() => {
      clearTimer(l.limit);
      l.limit = undefined;
      l.abort = undefined;
      l.running = false;
      if (!alive(l)) return;
      if (!control.busy && (l.queued || control.again)) enqueue(l);
      else l.poll = setTimer(() => { l.poll = undefined; enqueue(l); }, interval);
    });
  }
  function suspend() {
    const old = life;
    life = null;
    if (old) {
      clearTimer(old.poll);
      clearTimer(old.limit);
      old.abort?.abort();
    }
    // Lifecycle cancellation is not a failed read; late replies have no live UI.
    clearScope('pending', undefined, false);
  }
  function sync() {
    if (stopped || !pageVisible || visibility.hidden) { if (life) suspend(); return; }
    if (!life) { life = {}; publish('pending'); enqueue(life); }
  }
  function hide() { pageVisible = false; if (life) suspend(); }
  function show() { pageVisible = true; sync(); }
  visibility.addEventListener('visibilitychange', sync);
  lifecycle.addEventListener('pagehide', hide);
  lifecycle.addEventListener('pageshow', show);
  clear();
  sync();

  return Object.freeze({ select(next, nextChannel) {
    if (stopped || !Object.hasOwn(TABS, next)) return;
    if (nextChannel !== undefined && (next !== 'memory' || !channelNames.has(nextChannel))) return;
    if (tab === next && (nextChannel === undefined || nextChannel === channel)) return;
    tab = next;
    if (nextChannel !== undefined) channel = nextChannel;
    selection += 1;
    if (life) enqueue(life);
  }, dispose() {
    if (stopped) return;
    stopped = true;
    visibility.removeEventListener('visibilitychange', sync);
    lifecycle.removeEventListener('pagehide', hide);
    lifecycle.removeEventListener('pageshow', show);
    if (life) suspend();
  } });
}
