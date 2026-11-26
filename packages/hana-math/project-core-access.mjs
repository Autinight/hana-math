// Short-lived App task authority for trusted project-main Core calls only.
// Task completion is resource accounting, never a mathematical verdict.
import { randomUUID, createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { runtimeFailureInfo, runtimeManagedIpcRefusal, takeProjectReadScratch, takeDashboardBusyFrame, takeDashboardGraphFallbackFrame, projectReadScratchOptions, projectDashboardFactgraphOptions,
  projectDashboardMemoryOptions, projectDashboardViewOptions, validProjectDashboardMemorySelection,
  validProjectDashboardReadArguments } from './runtime/research-runtime.mjs';
import { GRAPH_FACT_LIMIT, GRAPH_EDGE_LIMIT } from './project-graph.mjs';

const settledReadScratch = new WeakMap();
// Only this instance's exact returned (not persisted or copied) value can be consumed.
export function releaseValidatedProjectRead(access, value) {
  const proof = settledReadScratch.get(value);
  if (!proof || proof.access !== access || proof.view) return;
  settledReadScratch.delete(value);
  proof.release();
}
export function acceptDashboardViewRead(access, value) {
  const proof = settledReadScratch.get(value);
  if (!proof || proof.access !== access || !proof.view) return false;
  settledReadScratch.delete(value);
  return proof.release() === true;
}
// Unlike successful readbacks, these receipts carry no value. Only this exact
// durably failed operation can rearm the frame for a later authorized call.
const settledDashboardBusy = new WeakMap(), settledDashboardGraphFallback = new WeakMap();
export function acceptDashboardViewBusy(access, error) {
  const proof = settledDashboardBusy.get(error);
  if (!proof || proof.access !== access) return false;
  settledDashboardBusy.delete(error);
  return proof.release() === true;
}
export function acceptDashboardViewGraphFallback(access, error) {
  const proof = settledDashboardGraphFallback.get(error);
  if (!proof || proof.access !== access) return false;
  settledDashboardGraphFallback.delete(error);
  return proof.release() === true;
}
const reportedIpcRefusals = new WeakMap();
// Exact in-memory wrapper only; nothing is reconstructed from error fields or persisted state.
export function projectCoreManagedIpcRefusal(error) { return reportedIpcRefusals.get(error) ?? null; }

const APP = 'hana-math', CONTROL_MS = 5000, CALL_MS = 25000, CLEANUP_MS = 5000;
const MAX_JSON = 1 << 20;
const DASHBOARD_OPERATION = 'dashboard_factgraph', DASHBOARD_MEMORY = 'dashboard_memory';
// Canonical shape: nine JSON values per fact, four per dependency (reference
// and edge), plus fixed envelope/audit metadata. Byte budgets stay unchanged.
const DASHBOARD_JSON_NODES = 9 * GRAPH_FACT_LIMIT + 4 * GRAPH_EDGE_LIMIT + 256;
const OPS = new Set(['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'fact_list', 'fact_list_page', 'fact_get']);
const ACTIVE_TASKS = new Set(['pending', 'running']);
const TERMINAL_TASKS = new Set(['completed', 'failed', 'canceled', 'aborted']);
const TASK_STATES = new Set([...ACTIVE_TASKS, ...TERMINAL_TASKS, 'paused', 'blocked', 'recovering']);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/, AUTHOR = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const LOCAL_CODES = new Set(['PROJECT_CORE_INVALID_BINDING', 'PROJECT_CORE_INVALID_INPUT', 'PROJECT_CORE_FORBIDDEN_OPERATION', 'PROJECT_CORE_BUSY', 'PROJECT_CORE_DISPOSED',
  'PROJECT_CORE_TIMEOUT', 'PROJECT_CORE_PERSISTENCE_FAILED', 'PROJECT_CORE_TASK_CREATE_FAILED', 'PROJECT_CORE_TASK_RECEIPT_INVALID', 'PROJECT_CORE_TASK_INACTIVE',
  'PROJECT_CORE_FACTORY_FAILED', 'PROJECT_CORE_CALL_FAILED', 'PROJECT_CORE_CLEANUP_FAILED', 'PROJECT_CORE_SETTLEMENT_FAILED', 'PROJECT_CORE_INVALID_RESULT']);
const object = (value) => value !== null && typeof value === 'object' && !isProxy(value) && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const fail = (code, cause) => Object.assign(new Error(code, cause ? { cause } : undefined), { code });
function check(ok, code) { if (!ok) throw fail(code); }
function jsonCopy(value, maximum = MAX_JSON, nodeLimit = maximum > MAX_JSON ? 32768 : 16384) {
  const ancestors = new Set(); let count = 0, bytes = 0;
  function add(text) { check(text.length <= maximum, 'PROJECT_CORE_INVALID_INPUT'); bytes += Buffer.byteLength(text); check(bytes <= maximum, 'PROJECT_CORE_INVALID_INPUT'); }
  function visit(item, depth) {
    check(++count <= nodeLimit && depth <= (maximum > MAX_JSON ? 24 : 16), 'PROJECT_CORE_INVALID_INPUT');
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)) {
      if (typeof item === 'string') check(item.length <= maximum, 'PROJECT_CORE_INVALID_INPUT');
      add(JSON.stringify(item)); return;
    }
    check(!isProxy(item) && (object(item) || Array.isArray(item) && Object.getPrototypeOf(item) === Array.prototype) && !ancestors.has(item), 'PROJECT_CORE_INVALID_INPUT');
    add('{}');
    ancestors.add(item);
    const keys = Reflect.ownKeys(item).filter((key) => !(Array.isArray(item) && key === 'length'));
    if (Array.isArray(item)) check(keys.length === item.length, 'PROJECT_CORE_INVALID_INPUT');
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      check(typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'PROJECT_CORE_INVALID_INPUT');
      if (Array.isArray(item)) check(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < item.length, 'PROJECT_CORE_INVALID_INPUT');
      else { check(key.length <= maximum, 'PROJECT_CORE_INVALID_INPUT'); add(JSON.stringify(key)); }
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0); const encoded = JSON.stringify(value);
  check(Buffer.byteLength(encoded) <= maximum, 'PROJECT_CORE_INVALID_INPUT'); return JSON.parse(encoded);
}
// Shared bounded admission copy; call() still independently validates its input.
export function normalizeProjectCoreArguments(operation, args) {
  return argumentsOf(operation, args);
}
function argumentsOf(operation, args) {
  check(OPS.has(operation), 'PROJECT_CORE_FORBIDDEN_OPERATION');
  const value = jsonCopy(args); check(object(value), 'PROJECT_CORE_INVALID_INPUT');
  const spec = {
    gm_add: [['kind', 'claim', 'evidence', 'verifiable', 'glossary', 'links'], ['kind', 'claim']],
    gm_search: [['query', 'limit_per_kind', 'kinds'], ['query']], fact_search: [['query', 'limit'], ['query']],
    fact_revoke: [['fact_id', 'reason'], ['fact_id', 'reason']], fact_get: [['fact_id'], ['fact_id']], fact_list: [[], []], fact_list_page: [['cursor', 'limit'], []],
  }[operation];
  check(Object.keys(value).every((key) => spec[0].includes(key)) && spec[1].every((key) => Object.hasOwn(value, key)), 'PROJECT_CORE_INVALID_INPUT');
  // Python remains the authority for the original business schemas. This boundary
  // rejects identity/path selectors without reimplementing Core's mathematical data.
  return value;
}
function copyOperation(operation, value, maximum) {
  return jsonCopy(value, maximum, operation === DASHBOARD_OPERATION ? DASHBOARD_JSON_NODES : undefined);
}
function dashboardEnvelope(result, projectId, terminal, fields) {
  const expected = terminal ? [...fields, 'inventoryRevision'] : fields;
  check(object(result) && result.projectId === projectId
    && Object.keys(result).length === expected.length && expected.every(key => Object.hasOwn(result, key))
    && (!terminal || typeof result.inventoryRevision === 'string' && result.inventoryRevision.length === 64
      && /^[a-f0-9]{64}$/.test(result.inventoryRevision)), 'PROJECT_CORE_INVALID_RESULT');
}
function dashboardResult(value, projectId, terminal, input = {}) {
  const result = copyOperation(DASHBOARD_OPERATION, value);
  if (input?.mode === 'index') {
    const page = result?.page;
    dashboardEnvelope(result, projectId, terminal, ['asOf', 'page', 'projectId']);
    check(typeof result.asOf === 'string' && /^[a-f0-9]{64}$/.test(result.asOf)
      && object(page) && Object.keys(page).sort().join(',') === 'has_more,max_depth,next_offset,nodes,offset,returned,total_edges,total_nodes'
      && Array.isArray(page.nodes) && page.nodes.length === page.returned
      && Number.isSafeInteger(page.total_nodes) && page.total_nodes >= 0 && page.total_nodes <= GRAPH_FACT_LIMIT
      && Number.isSafeInteger(page.total_edges) && page.total_edges >= 0 && page.total_edges <= GRAPH_EDGE_LIMIT
      && Number.isSafeInteger(page.offset) && page.offset >= 0
      && Number.isSafeInteger(page.max_depth) && page.max_depth >= 0
      && typeof page.has_more === 'boolean'
      && (page.has_more ? Number.isSafeInteger(page.next_offset) && page.next_offset > page.offset : page.next_offset === null),
    'PROJECT_CORE_INVALID_RESULT');
    return result;
  }
  if (input?.mode === 'fact') {
    const detail = result?.fact;
    dashboardEnvelope(result, projectId, terminal, ['asOf', 'fact', 'projectId']);
    check(typeof result.asOf === 'string' && /^[a-f0-9]{64}$/.test(result.asOf)
      && object(detail) && Object.keys(detail).sort().join(',') === 'author,depth,id,intuition,predecessors,problem_id,proof,statement'
      && typeof detail.id === 'string' && /^[a-f0-9]{16}$/.test(detail.id)
      && typeof detail.statement === 'string' && typeof detail.proof === 'string'
      && Array.isArray(detail.predecessors), 'PROJECT_CORE_INVALID_RESULT');
    return result;
  }
  const graph = result?.graph;
  dashboardEnvelope(result, projectId, terminal, ['asOf', 'graph', 'projectId']);
  check(typeof result.asOf === 'string' && /^[a-f0-9]{64}$/.test(result.asOf)
    && object(graph) && Object.keys(graph).sort().join(',') === 'edges,max_depth,nodes'
    && Array.isArray(graph.nodes) && graph.nodes.length <= GRAPH_FACT_LIMIT
    && Array.isArray(graph.edges) && graph.edges.length <= GRAPH_EDGE_LIMIT
    && Number.isSafeInteger(graph.max_depth) && graph.max_depth >= 0, 'PROJECT_CORE_INVALID_RESULT');
  return result;
}
function dashboardMemoryResult(value, projectId, selection) {
  const result = jsonCopy(value), data = result?.data;
  const count = n => Number.isSafeInteger(n) && n >= 0;
  const keys = (v, expected) => object(v) && Object.keys(v).sort().join(',') === expected;
  dashboardEnvelope(result, projectId, Object.hasOwn(selection, 'terminal'), ['data', 'projectId']);
  if (selection.view === 'overview') {
    check(keys(data, 'channel_counts,facts,facts_by_author,facts_with_predecessors,project,updated_at,verdicts')
      && data.project === projectId && count(data.facts) && count(data.facts_with_predecessors)
      && data.facts_with_predecessors <= data.facts && Number.isFinite(data.updated_at)
      && [data.channel_counts, data.facts_by_author, data.verdicts].every(v => object(v) && Object.values(v).every(count))
      && Object.keys(data.channel_counts).length === 11
      && Object.keys(data.channel_counts).every(kind => validProjectDashboardMemorySelection({ view: 'channel', kind })), 'PROJECT_CORE_INVALID_RESULT');
  } else if (selection.view === 'channels') {
    check(keys(data, 'channels') && Array.isArray(data.channels) && data.channels.length === 11
      && new Set(data.channels.map(c => c?.kind)).size === 11
      && data.channels.every(c => keys(c, 'count,kind,role') && count(c.count) && typeof c.role === 'string'
        && validProjectDashboardMemorySelection({ view: 'channel', kind: c.kind })), 'PROJECT_CORE_INVALID_RESULT');
  } else {
    check(keys(data, 'count,entries,kind') && data.kind === selection.kind && Array.isArray(data.entries)
      && data.entries.every(object) && data.count === data.entries.length, 'PROJECT_CORE_INVALID_RESULT');
  }
  return result;
}
function diagnostic(cause, fallback) {
  const runtime = runtimeFailureInfo(cause);
  return { code: runtime.code || (LOCAL_CODES.has(cause?.code) ? cause.code : fallback), runtime };
}
function bounded(promise, ms, code = 'PROJECT_CORE_TIMEOUT') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail(code)), Math.max(1, ms)); })]).finally(() => clearTimeout(timer));
}

// onState receives a detached, bounded operation record (operationId + revision),
// not snapshot's instance wrapper. It must acknowledge durable persistence before
// task creation/Core execution. snapshot.current retains the last known result;
// pending includes unacknowledged resource/persistence work. No restart recovery.
// pending=false does not establish mutation/mathematical certainty; retain outcome.failure.runtime.indeterminate.
// Calls get 25s total for preparation/execution, then at most 5s for cleanup.
export function createProjectCoreAccess(sdk, { projectId, author, createCore, onState } = {}) {
  check(typeof projectId === 'string' && ID.test(projectId) && typeof author === 'string' && AUTHOR.test(author), 'PROJECT_CORE_INVALID_BINDING');
  check(typeof createCore === 'function' && typeof onState === 'function'
    && ['create', 'get', 'complete', 'fail'].every((key) => typeof sdk?.tasks?.[key] === 'function'), 'PROJECT_CORE_INVALID_BINDING');
  let disposed = false, active = null, last = null;
  function snapshot() { return stateFor(active || last); }
  function stateFor(s) {
    return copyOperation(s?.meta.operation, { projectId, author, disposed, busy: active !== null, pending: s ? unresolved(s) : false,
      current: s?.meta || null, persistencePending: !!s?.writing, persistenceError: s?.persistenceError || null }, 2 * MAX_JSON);
  }
  function touch(s) { s.meta.revision++; s.meta.updatedAt = Date.now(); }
  function update(s, phase) { s.meta.phase = phase; s.meta.pending = phase !== 'finished'; touch(s); }
  function publish(s) {
    if (s.writing) return s.writing.then(() => s.persisted === s.meta.revision ? undefined : publish(s));
    const revision = s.meta.revision, packet = copyOperation(s.meta.operation, s.meta, 2 * MAX_JSON);
    const job = Promise.resolve().then(() => onState(packet)).then((receipt) => {
      check(receipt !== false && receipt?.ok !== false && !receipt?.error, 'PROJECT_CORE_PERSISTENCE_FAILED'); s.persisted = revision; s.persistenceError = null;
    }).catch((cause) => { s.persistenceFailedOnce = true; s.persistenceError = diagnostic(cause, 'PROJECT_CORE_PERSISTENCE_FAILED'); throw fail('PROJECT_CORE_PERSISTENCE_FAILED', cause); });
    s.writing = job;
    job.finally(() => { if (s.writing === job) s.writing = null; }).catch(() => {});
    return job;
  }
  function track(s, promise) {
    s.pending.add(promise); promise.finally(() => s.pending.delete(promise)).catch(() => {}); return promise;
  }
  function cancel(s, code) {
    if (!s.cancelled) { s.cancelled = true; s.cancelCode = code; s.controller.abort(); s.halt(); }
  }
  function live(s) {
    check(!disposed && !s.cancelled, s.cancelCode || 'PROJECT_CORE_DISPOSED');
    check(Date.now() < s.deadlineAt, 'PROJECT_CORE_TIMEOUT');
  }
  async function step(s, action, limit = CONTROL_MS) {
    live(s);
    try {
      const result = await Promise.race([bounded(Promise.resolve().then(() => { live(s); return action(); }), Math.min(limit, s.deadlineAt - Date.now())),
        s.interrupted.then(() => { throw fail(s.cancelCode || 'PROJECT_CORE_DISPOSED'); })]);
      live(s); return result;
    } catch (e) { if (e?.code === 'PROJECT_CORE_TIMEOUT') cancel(s, e.code); throw e; }
  }
  function task(s, receipt) {
    check(receipt && receipt.ok !== false && typeof receipt.taskId === 'string' && TASK_ID.test(receipt.taskId)
      && (!s.meta.taskId || receipt.taskId === s.meta.taskId) && receipt.pluginId === APP && receipt.scope === 'app' && receipt.delivery === 'none'
      && receipt.parentSessionId === null && receipt.parentSessionPath === null
      && TASK_STATES.has(receipt.status) && receipt.metadata?.controlId === s.meta.operationId && receipt.metadata.projectId === projectId && receipt.metadata.operation === s.meta.operation,
    'PROJECT_CORE_TASK_RECEIPT_INVALID');
    return receipt;
  }
  function refreshFailure(s) {
    if (s.coreError) s.meta.outcome.failure = diagnostic(s.coreError, 'PROJECT_CORE_CALL_FAILED');
  }
  function unresolved(s) {
    refreshFailure(s);
    const runtime = s.meta.outcome.failure?.runtime;
    return !!(s.meta.phase !== 'finished' || s.pending.size || s.writing || s.persisted !== s.meta.revision || s.createAttempted && !s.meta.taskId
      || s.core && !s.meta.cleanup.confirmed || s.meta.taskId && !s.meta.settlement.confirmed
      || runtime?.startOutcome === 'unknown' || runtime?.cleanup?.confirmed === false);
  }
  function release(s) { if (active === s && !s.executing && !unresolved(s)) active = null; }
  function late(s) {
    if (!s.cancelled && !disposed && !s.finalizationRequested) return;
    Promise.resolve(s.finishing).catch(() => {}).then(() => {
      if (active === s && unresolved(s)) return finish(s);
    }).catch(() => {});
  }
  async function finish(s) {
    if (s.finishing) return s.finishing;
    s.finalizationRequested = true;
    const deadline = Date.now() + CLEANUP_MS;
    const wait = (action) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(fail('PROJECT_CORE_TIMEOUT'));
      return bounded(Promise.resolve().then(action), remaining);
    };
    const work = (async () => {
      try {
        // A late task/factory receipt may be cleaned, but can never start Core work.
        const creating = s.creating, factory = s.factory;
        if (creating) await wait(() => creating.catch(() => {}));
        if (factory) await wait(() => factory.catch(() => {}));
        if (!s.createAttempted) s.meta.taskCreation = 'not-attempted';
        if (s.core && !s.meta.cleanup.confirmed) {
          update(s, 'disposing');
          try { await wait(() => publish(s)); } catch {} // Still attempt release if persistence itself failed.
          if (!s.disposing) {
            const promise = track(s, Promise.resolve().then(() => s.core.dispose()).then((receipt) => {
              check(receipt !== false && receipt?.ok !== false && receipt?.confirmed !== false && receipt?.cleanupPending !== true, 'PROJECT_CORE_CLEANUP_FAILED');
              s.meta.cleanup = { confirmed: true, failure: null }; touch(s);
            }, (cause) => {
              s.meta.cleanup = { confirmed: false, failure: diagnostic(cause, 'PROJECT_CORE_CLEANUP_FAILED') }; touch(s); throw cause;
            }));
            s.disposing = promise;
            promise.finally(() => { if (s.disposing === promise) s.disposing = null; }).catch(() => {});
            promise.then(() => late(s), () => {});
          }
          const disposing = s.disposing;
          try { await wait(() => disposing); }
          catch (cause) { s.meta.cleanup = { confirmed: false, failure: diagnostic(cause, 'PROJECT_CORE_CLEANUP_FAILED') }; throw cause; }
        } else if (!s.core && !s.factory) s.meta.cleanup = { confirmed: !s.createAttempted || !!s.meta.taskId, failure: null };
        const calling = s.callPending;
        if (calling) await wait(() => calling.catch(() => {}));
        refreshFailure(s);
        const runtime = s.meta.outcome.failure?.runtime;
        check(!s.createAttempted || !!s.meta.taskId, 'PROJECT_CORE_TASK_CREATE_FAILED');
        check(!s.pending.size && s.meta.cleanup.confirmed && runtime?.startOutcome !== 'unknown' && runtime?.cleanup?.confirmed !== false, 'PROJECT_CORE_CLEANUP_FAILED');
        if (s.meta.taskId && !s.meta.settlement.confirmed) {
          const expected = s.meta.outcome.state === 'succeeded' ? 'completed' : 'failed';
          s.meta.settlement.expected = expected; s.meta.settlement.state = 'pending'; update(s, 'settling');
          try { await wait(() => publish(s)); } catch {} // Resource release must not depend on a healthy disk callback.
          const current = task(s, await wait(() => sdk.tasks.get(s.meta.taskId)));
          s.meta.taskStatus = current.status;
          if (TERMINAL_TASKS.has(current.status)) check(current.status === expected, 'PROJECT_CORE_SETTLEMENT_FAILED');
          else {
            s.settlementPayload ||= { controlId: s.meta.operationId, projectId, operation: s.meta.operation,
              coreOutcome: s.meta.outcome.state, resourcesDisposed: true, ...(s.meta.outcome.failure ? { failure: s.meta.outcome.failure } : {}) };
            if (!s.settling) {
              const promise = track(s, Promise.resolve().then(() => sdk.tasks[expected === 'completed' ? 'complete' : 'fail'](s.meta.taskId, s.settlementPayload)).then((value) => {
                const receipt = task(s, value); check(receipt.status === expected, 'PROJECT_CORE_SETTLEMENT_FAILED');
                s.meta.taskStatus = receipt.status; s.meta.settlement.state = 'confirmed'; s.meta.settlement.confirmed = true; touch(s); return receipt;
              }));
              s.settling = promise;
              promise.finally(() => { if (s.settling === promise) s.settling = null; }).catch(() => {});
              promise.then(() => late(s), () => {});
            }
            const settling = s.settling; await wait(() => settling);
          }
          s.meta.settlement.state = 'confirmed'; s.meta.settlement.confirmed = true;
        } else if (!s.meta.taskId) s.meta.settlement = { state: 'not-required', confirmed: true, expected: null, failure: null };
        update(s, 'finished');
      } catch (cause) {
        if (s.meta.phase === 'settling') s.meta.settlement.failure = diagnostic(cause, 'PROJECT_CORE_SETTLEMENT_FAILED');
        s.meta.error ||= diagnostic(cause, 'PROJECT_CORE_CLEANUP_FAILED'); update(s, 'unsettled');
      }
      const recording = publish(s);
      try { await wait(() => recording); } catch (cause) { if (!s.meta.error) { s.meta.error = diagnostic(cause, 'PROJECT_CORE_PERSISTENCE_FAILED'); touch(s); } }
      release(s);
    })();
    s.finishing = work; work.finally(() => { if (s.finishing === work) s.finishing = null; }).catch(() => {});
    return work;
  }
  function reported(s, cause) {
    const summary = s.meta.error || diagnostic(cause, 'PROJECT_CORE_CALL_FAILED');
    const error = fail(summary.code, cause); error.state = stateFor(s); error.runtime = summary.runtime;
    if (s.ipcRefusal?.summary === summary) reportedIpcRefusals.set(error, s.ipcRefusal.reason);
    return error;
  }
  function call(operation, args = {}) { return runCall(operation, args, false, arguments.length <= 2); }
  function callReadScratch(operation, args = {}) { return runCall(operation, args, true, arguments.length <= 2); }
  // Separate internal method: broad operation dispatch/normalization never
  // accepts this operation. A future Project caller must authorize first.
  function dashboardFactgraph(args = {}) { return runCall(DASHBOARD_OPERATION, args, false, arguments.length <= 1, true); }
  function dashboardMemory(args) { return runCall(DASHBOARD_MEMORY, args, false, arguments.length === 1, false, true); }
  function dashboardViewRead(operation, args, guard) {
    const graph = operation === DASHBOARD_OPERATION, memory = operation === DASHBOARD_MEMORY;
    return runCall(operation, args, true, arguments.length === 3 && (graph || memory) && typeof guard === 'function', graph, memory, guard);
  }
  async function runCall(operation, args, captureScratch, validArity, dashboard = false, memory = false, viewGuard) {
    let input;
    try {
      check(validArity, 'PROJECT_CORE_INVALID_INPUT');
      viewGuard?.();
      if (dashboard || memory) {
        input = jsonCopy(args);
        check(object(input) && validProjectDashboardReadArguments(operation, input, !!viewGuard), 'PROJECT_CORE_INVALID_INPUT');
      } else input = argumentsOf(operation, args);
      check(!disposed, 'PROJECT_CORE_DISPOSED'); if (active) release(active); check(!active, 'PROJECT_CORE_BUSY');
    } catch (cause) { cause.state = snapshot(); throw cause; }
    const operationId = `control-${randomUUID()}`;
    let halt;
    const s = { meta: { operationId, runId: operationId, projectId, author, role: 'main', operation, revision: 0,
      argumentsDigest: createHash('sha256').update(JSON.stringify(input)).digest('hex'), createdAt: Date.now(), updatedAt: Date.now(), phase: 'preparing', pending: true, taskId: null,
      taskCreation: 'not-attempted', taskStatus: null, outcome: { state: 'not-started' }, cleanup: { confirmed: true, failure: null },
      settlement: { state: 'not-required', confirmed: true, expected: null, failure: null }, error: null },
      pending: new Set(), persisted: -1, writing: null, controller: new AbortController(), interrupted: new Promise((resolve) => { halt = resolve; }),
      deadlineAt: Date.now() + CALL_MS, halt: () => halt(), cancelled: false, executing: true, core: null };
    active = last = s;
    let primary, coreAttempt, rawValue, transientValue, failedWhileLive = false;
    try {
      s.meta.taskCreation = 'pending'; update(s, 'creating'); await step(s, () => publish(s));
      await step(s, () => {
        const promise = track(s, Promise.resolve().then(() => {
          live(s); viewGuard?.(); s.createAttempted = true;
          return sdk.tasks.create({ scope: 'app', delivery: 'none', label: 'Math project Core operation', externalId: operationId,
            metadata: { controlId: operationId, projectId, operation } });
        }).then((receipt) => {
          const created = task(s, receipt); s.meta.taskId = created.taskId; s.meta.taskCreation = 'confirmed'; s.meta.taskStatus = created.status;
          s.meta.settlement = { state: 'not-started', confirmed: false, expected: null, failure: null }; touch(s); return created;
        }).catch((cause) => { s.meta.taskCreation = s.createAttempted ? 'unconfirmed' : 'not-attempted'; s.meta.error ||= diagnostic(cause, 'PROJECT_CORE_TASK_CREATE_FAILED'); touch(s); throw cause; }));
        s.creating = promise;
        promise.finally(() => { s.creating = null; late(s); }).catch(() => {}); return promise;
      });
      await step(s, () => publish(s));
      const current = task(s, await step(s, () => sdk.tasks.get(s.meta.taskId)));
      check(ACTIVE_TASKS.has(current.status), 'PROJECT_CORE_TASK_INACTIVE');
      s.meta.taskStatus = current.status; update(s, 'core-pending'); await step(s, () => publish(s));
      await step(s, () => {
        s.meta.cleanup = { confirmed: false, failure: null }; touch(s);
        const promise = track(s, Promise.resolve().then(() => { live(s); viewGuard?.(); return createCore({ taskId: s.meta.taskId }); }).then((core) => {
          check(core && typeof core.call === 'function' && typeof core.dispose === 'function', 'PROJECT_CORE_FACTORY_FAILED');
          s.core = core; s.meta.cleanup = { confirmed: false, failure: null }; touch(s); return core;
        }));
        s.factory = promise; promise.finally(() => { s.factory = null; late(s); }).catch(() => {}); return promise;
      });
      s.meta.outcome = { state: 'pending' }; update(s, 'calling'); await step(s, () => publish(s));
      await step(s, () => {
        const promise = track(s, Promise.resolve().then(() => {
          // View revocation stops admission/launch, not validation and settlement
          // of a command that has already been launched by the App.
          live(s); viewGuard?.();
          const options = viewGuard ? projectDashboardViewOptions(operation, s.controller.signal, viewGuard)
            : dashboard ? projectDashboardFactgraphOptions(s.controller.signal)
            : memory ? projectDashboardMemoryOptions(s.controller.signal)
            : captureScratch ? projectReadScratchOptions(s.controller.signal) : { signal: s.controller.signal };
          coreAttempt = s.core.call({ projectId, runId: operationId, role: 'main', author }, operation, input, undefined, options);
          return coreAttempt;
        }).then((value) => {
          let result; try {
            result = dashboard ? dashboardResult(value, projectId, Object.hasOwn(input, 'terminal'), input)
              : memory ? dashboardMemoryResult(value, projectId, input) : jsonCopy(value);
          } catch (cause) { throw fail('PROJECT_CORE_INVALID_RESULT', cause); }
          if (captureScratch) rawValue = value;
          // Shared prose is returned to the trusted caller, not persisted or exposed via Core operation state.
          if (memory || viewGuard) { transientValue = result; s.meta.outcome = { state: 'succeeded' }; }
          else s.meta.outcome = { state: 'succeeded', result };
          touch(s); return result;
        }).catch((cause) => { s.coreError = cause; s.meta.outcome = { state: 'failed', failure: diagnostic(cause, 'PROJECT_CORE_CALL_FAILED') }; touch(s); throw cause; }));
        s.callPending = promise; promise.finally(() => { s.callPending = null; late(s); }).catch(() => {}); return promise;
      }, CALL_MS);
    } catch (cause) {
      primary = cause;
      // Latch before cancel() seals the failed call for normal cleanup. A
      // timeout, disposal or guard failure is not the Core's busy receipt.
      failedWhileLive = !!viewGuard && !disposed && !s.cancelled && !s.meta.error && cause === s.coreError;
      if (!s.meta.error) {
        const summary = s.meta.error = diagnostic(cause, 'PROJECT_CORE_CALL_FAILED');
        if (summary.code === 'RESEARCH_RUNTIME_CAPACITY' && cause === s.coreError) {
          const reason = runtimeManagedIpcRefusal(s.core, coreAttempt, cause, operation);
          if (reason !== null) s.ipcRefusal = { summary, reason };
        }
      }
      cancel(s, LOCAL_CODES.has(cause?.code) ? cause.code : 'PROJECT_CORE_CALL_FAILED'); touch(s);
    }
    try { await finish(s); }
    catch (cause) { primary ||= cause; s.meta.error ||= diagnostic(cause, 'PROJECT_CORE_CLEANUP_FAILED'); update(s, 'unsettled'); }
    finally { s.executing = false; release(s); }
    if (!primary && !disposed && !s.cancelled && !unresolved(s) && s.meta.outcome.state === 'succeeded') {
      const value = copyOperation(operation, memory || viewGuard ? transientValue : s.meta.outcome.result);
      if (captureScratch && !s.meta.error && s.meta.settlement.confirmed && s.meta.taskStatus === 'completed' && s.meta.cleanup.confirmed && object(value)) {
        const retire = takeProjectReadScratch(s.core, coreAttempt, operation, rawValue);
        if (retire) settledReadScratch.set(value, { access, view: !!viewGuard, release: () => !disposed && !s.cancelled && retire() });
      }
      return value;
    }
    const error = reported(s, primary || fail(disposed ? 'PROJECT_CORE_DISPOSED' : 'PROJECT_CORE_CLEANUP_FAILED'));
    if (failedWhileLive && !disposed && !s.persistenceFailedOnce && !unresolved(s) && s.meta.outcome.state === 'failed'
      && s.meta.taskStatus === 'failed' && s.meta.settlement.expected === 'failed' && s.meta.settlement.confirmed && s.meta.cleanup.confirmed) {
      const release = takeDashboardBusyFrame(s.core, coreAttempt, operation, primary);
      if (release) settledDashboardBusy.set(error, { access, release });
      else {
        const graphRelease = takeDashboardGraphFallbackFrame(s.core, coreAttempt, operation, primary);
        if (graphRelease) settledDashboardGraphFallback.set(error, { access, release: graphRelease });
      }
    }
    throw error;
  }
  async function dispose() {
    disposed = true;
    const s = active;
    if (s) { cancel(s, 'PROJECT_CORE_DISPOSED'); await finish(s); }
    const state = snapshot();
    if (state.pending) { const error = fail('PROJECT_CORE_CLEANUP_FAILED'); error.state = state; throw error; }
    return state;
  }
  const access = Object.freeze({ call, callReadScratch, dashboardFactgraph, dashboardMemory, dashboardViewRead, snapshot, dispose });
  return access;
}
