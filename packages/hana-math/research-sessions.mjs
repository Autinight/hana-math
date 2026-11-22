import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readResearchSessionInfo } from './research-session-info.mjs';
import { isNativeResearchTool, requestsNativeLiterature } from './native-literature.mjs';
import { AppSdkError } from './sdk/app-contract/sdk-error.js';
import { APP_SDK_BUS_METHODS } from './sdk/app-contract/bus-requests.js';
import { APP_GRANTABLE_CAPABILITIES } from './sdk/app-grantable-capabilities.js';
import { validateWorkerSelection } from './worker-selection.mjs';

const APP = 'hana-math';
const CONTROL_MS = 10000;
const ACTIVE = new Set(['preparing', 'running']);
const REFERENCE_VERIFIER_TOOLS = Object.freeze(['web_search', 'web_fetch']);
const UNSAFE_TOOLS = new Set(['write', 'edit', 'exec', 'exec_command', 'bash', 'shell', 'python', 'codemode', 'terminal', 'run_command']);
const copy = (value) => structuredClone(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
function failure(code) { return Object.assign(new Error(code), { code }); }
function check(condition, code) { if (!condition) throw failure(code); }
const safeCode = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
const member = (values, value) => typeof value === 'string' && values.has(value) ? value : null;
const SDK_KINDS = new Set(['permission', 'context', 'unavailable', 'unsupported', 'timeout', 'aborted', 'invalid', 'conflict', 'host']);
const SDK_OPERATIONS = new Set([
  ...Object.entries(APP_SDK_BUS_METHODS).flatMap(([domain, methods]) => Object.entries(methods).flatMap(([name, verb]) => [`${domain}.${name}`, verb])),
  'bus.subscribe', 'tools.list', 'resources.stage',
  ...['registerHandler', 'create', 'schedule', 'unschedule', 'get', 'list', 'listSchedules', 'complete', 'fail', 'getDelivery'].map((name) => `tasks.${name}`),
]);
const PHASES = new Set(['queued', 'model-catalog', 'tool-catalog', 'session-create', 'binding', 'tool-selection', 'subscribe', 'send', 'awaiting-agent-end', 'awaiting-feedback', 'finalizing', 'completed', 'failed', 'stopped', 'timed-out']);
const SEND_STATES = new Set(['not-sent', 'pending', 'accepted', 'rejected', 'unconfirmed']);
const STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted']);
function own(value, key) { return object(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; }
function codeOf(error) { return safeCode(own(error, 'code')) || 'HOST_OPERATION_FAILED'; }
// Diagnostics only, never an authorization decision. Unknown fields/values are
// omitted or null; do not inspect messages, causes, details or validation bodies.
export function researchSdkErrorInfo(value) {
  if (!object(value)) return null;
  return { code: safeCode(own(value, 'code')), operation: member(SDK_OPERATIONS, own(value, 'operation')),
    kind: member(SDK_KINDS, own(value, 'kind')), capability: member(APP_GRANTABLE_CAPABILITIES, own(value, 'capability')) };
}
export function researchSessionDiagnostics(value) {
  const agentId = own(value, 'agentId'), actual = own(value, 'actualModel');
  const modelPart = (v) => text(v, 256) && v.trim().length > 0 && v.isWellFormed()
    && !/[\x7f-\x9f\\]/.test(v) && !v.includes('://') && !/^(?:\/|\.\.?\/|[A-Za-z]:\/)/.test(v.trim());
  const provider = own(actual, 'provider'), id = own(actual, 'id');
  return { agentId: typeof agentId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(agentId) ? agentId : null,
    error: safeCode(own(value, 'error')), sendState: member(SEND_STATES, own(value, 'sendState')),
    modelStopReason: member(STOP_REASONS, own(value, 'modelStopReason')), phase: member(PHASES, own(value, 'phase')),
    failurePhase: member(PHASES, own(value, 'failurePhase')), sdkError: researchSdkErrorInfo(own(value, 'sdkError')),
    // A create receipt is not evidence that inference began or succeeded.
    actualModel: modelPart(provider) && modelPart(id) ? { provider, id } : null,
    ...(text(own(value, 'thinkingLevel')) ? { thinkingLevel: own(value, 'thinkingLevel') } : {}),
    ...(text(own(value, 'reportedThinkingLevel')) || own(value, 'reportedThinkingLevel') === null
      ? { reportedThinkingLevel: own(value, 'reportedThinkingLevel') } : {}),
    ...(object(value) && Object.hasOwn(value, 'modelTurn') ? { modelTurn: Number.isSafeInteger(own(value, 'modelTurn')) && own(value, 'modelTurn') > 0 ? own(value, 'modelTurn') : null } : {}),
    ...(object(value) && Object.hasOwn(value, 'turnEnded') ? { turnEnded: typeof own(value, 'turnEnded') === 'boolean' ? own(value, 'turnEnded') : null } : {}) };
}
function ok(value) { check(value && value.ok !== false && !value.error, 'HOST_OPERATION_FAILED'); return value; }
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function confirmTools(value, sessionId, requested, role) {
  ok(value);
  check(value.sessionId === sessionId && value.effective === 'current' && value.pendingToolNames === null && Array.isArray(value.toolNames)
    && value.toolNames.length === requested.length && new Set(value.toolNames).size === value.toolNames.length
    && requested.filter(isNativeResearchTool).every((name) => value.toolNames.includes(name))
    && value.toolNames.every((name) => text(name) && !UNSAFE_TOOLS.has(name.toLowerCase())), 'TOOL_SELECTION_UNCONFIRMED');
  // App tools may resolve to opaque Host names, but never to a local-read tool
  // in this online-only lane, even when both Host receipts repeat that name.
  if (role === 'reference-verifier') check(!value.toolNames.includes('read'), 'TOOL_SELECTION_UNCONFIRMED');
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('CONTROL_TIMEOUT')), CONTROL_MS); })]); }
  finally { clearTimeout(timer); }
}
/** Shared stop gate for live handles and crash recovery. Identity is re-read from
 * the host; an idle observation is never a receipt for an unknown/pending send. */
export async function confirmResearchSessionStop(sdk, record) {
  const sessionId = record.sessionId;
  check(text(sessionId), 'SESSION_ID_REQUIRED');
  let session;
  try { session = await readResearchSessionInfo(sdk, { sessionId }); }
  catch (error) {
    if (error?.code === 'SESSION_INFO_INVALID') throw failure('STOP_SESSION_MISMATCH');
    throw error;
  }
  check(session.lifecycle === 'active' && session.agentId === record.agentId && session.cwd === record.cwd
    && (record.kind === undefined || session.kind === record.kind), 'STOP_SESSION_MISMATCH');
  const receipt = ok(await bounded(Promise.resolve().then(() => sdk.sessions.abort({ sessionId, reason: 'Hana Math research round ended' }))));
  check(typeof receipt.aborted === 'boolean' && (!receipt.sessionId || receipt.sessionId === sessionId)
    && (!receipt.sessionRef || (receipt.sessionRef.sessionId === sessionId && receipt.sessionRef.sessionPath === session.path)), 'ABORT_UNCONFIRMED');
  if (record.sendPending) return { abortOutcome: 'awaiting-send-receipt', sessionPath: session.path };
  if (receipt.aborted) return { abortOutcome: 'aborted', sessionPath: session.path };
  const sendState = record.sendState ?? (record.state === 'completed' && record.modelStopReason === 'stop' ? 'accepted' : 'unconfirmed');
  check(['not-sent', 'rejected', 'accepted'].includes(sendState), 'SEND_UNCONFIRMED');
  const context = ok(await bounded(Promise.resolve().then(() => sdk.sessions.context({ sessionId }))));
  check(context.sessionId === sessionId && context.isStreaming === false && context.isCompacting === false
    && (context.pendingMessageCount === 0 || context.pendingMessageCount === null && context.systemPrompt === null && context.model === null), 'SESSION_NOT_IDLE');
  check(!record.sendPending && record.sendState !== 'unconfirmed', 'SEND_UNCONFIRMED');
  return { abortOutcome: 'idle-confirmed', sessionPath: session.path };
}
function validate(input) {
  check(object(input), 'INVALID_INPUT');
  check(['main', 'worker', 'verifier', 'report-writer', 'reference-auditor', 'reference-verifier', 'paper-reviser'].includes(input.role), 'INVALID_ROLE');
  check(input.turnMode === undefined || input.turnMode === 'controlled' && input.role === 'worker', 'INVALID_TURN_MODE');
  const selection = input.selection;
  check(object(selection) && text(selection.agentId, 128) && object(selection.model) && text(selection.model.provider) && text(selection.model.id), 'INVALID_SELECTION');
  check(!Object.hasOwn(selection, 'thinkingLevel') || text(selection.thinkingLevel) && selection.thinkingLevel.trim().length > 0 && selection.thinkingLevel !== 'auto', 'INVALID_THINKING_LEVEL');
  check(typeof input.cwd === 'string' && path.isAbsolute(input.cwd) && path.normalize(input.cwd) === input.cwd && !/[\x00-\x1f]/.test(input.cwd), 'INVALID_CWD');
  check(typeof input.prompt === 'string' && input.prompt.trim() && !input.prompt.includes('\0') && Buffer.byteLength(input.prompt) <= 512 * 1024, 'INVALID_PROMPT');
  check(Number.isSafeInteger(input.deadlineAt) && input.deadlineAt > 0, 'INVALID_DEADLINE');
  check(typeof input.onBound === 'function' && (input.onUpdate === undefined || typeof input.onUpdate === 'function'), 'INVALID_CALLBACK');
  check(input.kind === undefined || (text(input.kind, 128) && /^[A-Za-z0-9_.:-]+$/.test(input.kind)), 'INVALID_KIND');
  const names = input.toolNames;
  if (input.role === 'reference-verifier') {
    check(input.turnMode === undefined && input.toolless === undefined && Array.isArray(names)
      && names.length === REFERENCE_VERIFIER_TOOLS.length && REFERENCE_VERIFIER_TOOLS.every((name, index) => names[index] === name), 'INVALID_TOOL_SELECTION');
  } else {
    // Empty tools are permitted only for explicit isolated report writers.
    check(['report-writer', 'reference-auditor', 'paper-reviser'].includes(input.role) ? input.toolless === true && input.turnMode === undefined : input.toolless === undefined, 'INVALID_TOOL_SELECTION');
    if (input.toolless === true) check(Array.isArray(names) && names.length === 0, 'INVALID_TOOL_SELECTION');
    else check(Array.isArray(names) && names.length > 0 && names.length <= 32 && names.includes('read') && new Set(names).size === names.length
      && names.every((name) => text(name, 128) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) && !UNSAFE_TOOLS.has(name.toLowerCase())), 'INVALID_TOOL_SELECTION');
  }
  return { role: input.role, selection: { agentId: selection.agentId, model: { provider: selection.model.provider, id: selection.model.id },
    ...(Object.hasOwn(selection, 'thinkingLevel') ? { thinkingLevel: selection.thinkingLevel } : {}) }, cwd: input.cwd,
    toolNames: [...names], prompt: input.prompt, deadlineAt: input.deadlineAt, onBound: input.onBound, onUpdate: input.onUpdate, kind: input.kind ?? null, controlled: input.turnMode === 'controlled', toolless: input.toolless === true };
}
function assistant(message) {
  if (message?.role !== 'assistant') return null;
  const finalText = typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
  check(Buffer.byteLength(finalText) <= 512 * 1024, 'FINAL_TEXT_TOO_LARGE');
  return { text: finalText, stopReason: typeof message.stopReason === 'string' ? message.stopReason : null };
}

// The backend supplies an already validated saved-role selection and business-tool
// allowlist. Visibility/selection is not authorization: onBound must durably bind
// this fresh session in the caller's registry before any model turn can start.
export function createResearchSessions(sdk) {
  const runs = new Set(); let disposed = false;
  function error(run, operation, cause) {
    run.record.errors.push({ operation, code: codeOf(cause), at: Date.now(), ...(cause instanceof AppSdkError ? { sdkError: researchSdkErrorInfo(cause) } : {}) });
    run.record.errors = run.record.errors.slice(-32);
  }
  function refresh(run, currentUpdate = null) {
    run.record.cleanupPending = !ACTIVE.has(run.record.state) && (run.pending.size > 0 || run.record.sendPending || run.cleanupFailed || run.failedSubscriptions.size > 0
      || run.updates.size > (currentUpdate && run.updates.has(currentUpdate) ? 1 : 0)
      || (run.record.state !== 'completed' && Boolean(run.record.sessionId) && !['aborted', 'idle-confirmed'].includes(run.record.abortOutcome)));
  }
  function snapshot(run, currentUpdate = null) { refresh(run, currentUpdate); return copy(run.record); }
  function phase(run, name) { run.record.phase = name; run.record.phaseTimestamps[name] = Date.now(); }
  function ensure(run) {
    check(ACTIVE.has(run.record.state) && !disposed, 'STOPPED');
    check(Date.now() < run.input.deadlineAt, 'DEADLINE_EXCEEDED');
  }
  // Serialize callback invocations, not just their bounded waits. If a callback
  // resolves late, the next callback takes a fresh snapshot rather than overwriting
  // it with an old queued state. Callback errors never bypass abort/unsubscribe.
  async function notify(run) {
    if (!run.input.onUpdate) return true;
    const job = run.notifications.catch(() => {}).then(async () => {
      run.record.updateVersion += 1;
      // The write being performed is not another future cleanup job in its own
      // persisted snapshot; all other unfinished writes remain visible.
      const result = await run.input.onUpdate(snapshot(run, job));
      check(result !== false && result?.ok !== false, 'UPDATE_FAILED');
    });
    run.notifications = job; run.updates.add(job);
    job.finally(() => { run.updates.delete(job); refresh(run); }).catch(() => {});
    try { await bounded(job); return true; }
    catch (cause) { run.record.updateFailed = true; error(run, 'onUpdate', cause); return false; }
  }
  async function checkpoint(run, name) {
    ensure(run); phase(run, name);
    if (!await notify(run)) throw failure('UPDATE_FAILED');
    ensure(run);
  }
  function tracked(run, promise) {
    run.pending.add(promise);
    const cleanup = promise.then(() => {}, (cause) => { error(run, 'operation', cause); }).then(async () => {
      run.pending.delete(promise); refresh(run);
      if (!ACTIVE.has(run.record.state)) await notify(run);
    });
    run.followups.add(cleanup); cleanup.finally(() => run.followups.delete(cleanup)).catch(() => {});
    return promise;
  }
  async function step(run, fn, receive = (value) => value) {
    ensure(run);
    const promise = tracked(run, Promise.resolve().then(() => { ensure(run); return fn(); }).then(receive));
    const result = await Promise.race([promise, run.halt.promise.then(() => { throw failure('STOPPED'); })]);
    ensure(run); return result;
  }
  async function abort(run, force = false) {
    if (!run.record.sessionId) { run.record.abortOutcome = 'no-session'; return; }
    if (['aborted', 'idle-confirmed'].includes(run.record.abortOutcome) && !run.record.sendPending && !force) return;
    if (run.record.abortOutcome === 'awaiting-send-receipt' && run.record.sendPending && !force) return;
    const job = run.aborting.catch(() => {}).then(async () => {
      if (!force && ['aborted', 'idle-confirmed'].includes(run.record.abortOutcome) && !run.record.sendPending) return;
      const pendingAtRequest = run.record.sendPending;
      run.record.abortOutcome = force ? 'pending-late-send-abort' : 'pending';
      try {
        const receipt = await confirmResearchSessionStop(sdk, run.record);
        run.record.sessionPath = receipt.sessionPath;
        run.record.abortOutcome = pendingAtRequest || run.record.sendPending ? 'awaiting-send-receipt' : receipt.abortOutcome;
      } catch (cause) { run.record.abortOutcome = 'failed'; error(run, 'abort', cause); }
    });
    run.aborting = job; await job;
  }
  async function unsubscribe(run, handle) {
    if (!handle || run.closedSubscriptions.has(handle)) return;
    try {
      await bounded(Promise.resolve().then(() => typeof handle.disposeAsync === 'function' ? handle.disposeAsync() : handle()));
      run.closedSubscriptions.add(handle); run.failedSubscriptions.delete(handle);
    } catch (cause) { run.failedSubscriptions.add(handle); error(run, 'unsubscribe', cause); }
  }
  async function finish(run, state, cause = null) {
    if (run.finishing) return run.finishing;
    const initial = ACTIVE.has(run.record.state);
    if (!initial) { refresh(run); if (!run.record.cleanupPending) return; state = run.record.state; }
    else {
      // Capture once, before finalization overwrites phase. Cleanup/repeated stop
      // must not replace the primary failure with a later phase or SDK error.
      run.record.failurePhase = state === 'completed' ? null : member(PHASES, run.record.phase);
      run.record.sdkError = cause instanceof AppSdkError ? researchSdkErrorInfo(cause) : null;
      run.record.state = state; run.record.error = cause ? codeOf(cause) : null;
      if (cause) error(run, 'execution', cause);
    }
    run.record.finalizing = true; phase(run, 'finalizing'); clearTimeout(run.timer); run.halt.resolve();
    run.finishing = (async () => {
      try {
        if (state !== 'completed') await abort(run);
        await unsubscribe(run, run.subscription);
      } finally {
        run.record.finalizing = false; run.record.endedAt = Date.now(); phase(run, state); refresh(run);
        await notify(run);
        run.done.resolve(snapshot(run));
        run.turn.ended.resolve(snapshot(run));
      }
    })();
    const finishing = run.finishing;
    finishing.finally(() => { if (run.finishing === finishing) run.finishing = null; }).catch(() => {});
    return finishing;
  }
  function receiveSession(run, value) {
    const result = ok(value); const sessionId = result.sessionId || result.sessionRef?.sessionId;
    const matches = text(sessionId, 256) && text(result.sessionPath, 4096) && result.ownerPluginId === APP && result.visibility === 'plugin_private'
      && result.namespace === 'app' && result.agentId === run.input.selection.agentId && result.cwd === run.input.cwd
      && (!result.sessionRef || (result.sessionRef.sessionId === sessionId && result.sessionRef.sessionPath === result.sessionPath))
      && (!result.path || result.path === result.sessionPath);
    if (!matches) { run.cleanupFailed = true; throw failure('SESSION_BINDING_MISMATCH'); }
    run.record.sessionId = sessionId; run.record.sessionPath = result.sessionPath;
    run.record.actualModel = { provider: result.modelProvider, id: result.modelId };
    // Host configuration receipt only, not evidence of provider execution.
    if (Object.hasOwn(result, 'thinkingLevel')) run.record.reportedThinkingLevel = result.thinkingLevel;
    check(result.modelProvider === run.record.model.provider && result.modelId === run.record.model.id, 'SESSION_MODEL_MISMATCH');
    check(!Object.hasOwn(run.input.selection, 'thinkingLevel') || result.thinkingLevel === run.record.thinkingLevel, 'SESSION_THINKING_LEVEL_MISMATCH');
    check(run.input.kind === null || result.kind === run.input.kind, 'SESSION_KIND_MISMATCH');
    return result;
  }
  async function event(run, data, sourcePath, generation = run.turn) {
    if (!ACTIVE.has(run.record.state) || generation !== run.turn) return;
    if (!data || sourcePath !== run.record.sessionPath || (data.sessionId && data.sessionId !== run.record.sessionId)) return;
    if (data.type === 'turn_end' && data.aborted === true) {
      run.record.roundEnded = true; run.record.modelStopReason = 'aborted';
      await finish(run, 'stopped', failure('HOST_TURN_ABORTED')); return;
    }
    if (!run.sendInvoked) return;
    if (data.type === 'error') {
      // This is the host's asynchronous session:send completion channel, not
      // evidence carried by arbitrary error events or their raw payloads.
      if (!run.record.bound || data.source !== 'session:send'
        || (Object.hasOwn(data, 'sessionId') && data.sessionId !== run.record.sessionId)) return;
      await finish(run, 'failed', failure('SESSION_SEND_COMPLETION_FAILED')); return;
    }
    await Promise.race([generation.accepted.promise, run.halt.promise]);
    if (!ACTIVE.has(run.record.state) || generation !== run.turn || run.record.sendState !== 'accepted') return;
    if (data.type === 'message_end') { const value = assistant(data.message); if (value) run.lastAssistant = value; return; }
    if (data.type !== 'agent_end') return;
    if (data.willRetry === true) { run.record.retryEvents += 1; if (!await notify(run)) throw failure('UPDATE_FAILED'); return; }
    const messages = data.messages;
    const result = Array.isArray(messages) ? assistant(messages.filter((message) => message?.role === 'assistant').at(-1)) : run.lastAssistant;
    if (run.input.controlled) run.record.turnEnded = true;
    else run.record.roundEnded = true;
    run.record.finalText = result?.text ?? ''; run.record.modelStopReason = result?.stopReason ?? null;
    if (result?.stopReason === 'error') await finish(run, 'failed', failure('MODEL_TURN_FAILED'));
    else if (result?.stopReason === 'aborted') await finish(run, 'stopped', failure('HOST_TURN_ABORTED'));
    else if (!result?.text.trim()) await finish(run, 'failed', failure('FINAL_ASSISTANT_MISSING'));
    else if (run.input.controlled) {
      phase(run, 'awaiting-feedback');
      if (!await notify(run)) throw failure('UPDATE_FAILED');
      if (ACTIVE.has(run.record.state) && generation === run.turn) {
        generation.ready = true;
        generation.ended.resolve(snapshot(run));
      }
    } else await finish(run, 'completed');
  }
  function modelTurn(id) { return { id, accepted: deferred(), ended: deferred(), started: false, ending: false, ready: false }; }
  function paused(run) {
    ensure(run);
    check(!run.resuming, 'MODEL_TURN_BUSY');
    check(run.record.state === 'running' && run.turn.ready && !run.record.setupPending
      && !run.record.sendPending && run.record.sendState === 'accepted', 'MODEL_TURN_NOT_PAUSED');
  }
  async function send(run, prompt) {
    await step(run, () => {
      return Promise.resolve().then(() => {
        ensure(run); run.sendInvoked = true;
        return sdk.sessions.send({ sessionId: run.record.sessionId, text: prompt });
      }).then(async (receipt) => {
        run.record.sendPending = false;
        const accepted = receipt?.accepted === true && receipt.ok !== false && !receipt.error
          && receipt.sessionPath === run.record.sessionPath && (!receipt.sessionId || receipt.sessionId === run.record.sessionId)
          && (!receipt.sessionRef || (receipt.sessionRef.sessionId === run.record.sessionId && receipt.sessionRef.sessionPath === run.record.sessionPath));
        const rejected = receipt?.accepted === false && receipt.sessionPath === run.record.sessionPath
          && (!receipt.sessionId || receipt.sessionId === run.record.sessionId);
        run.record.sendState = accepted ? 'accepted' : rejected ? 'rejected' : 'unconfirmed';
        if (!ACTIVE.has(run.record.state) || disposed) { run.record.lateSendReceipt = true; await abort(run, true); }
        check(accepted, 'SEND_NOT_ACCEPTED'); return receipt;
      }, async (cause) => {
        run.record.sendPending = false; run.record.sendState = run.sendInvoked ? 'unconfirmed' : 'not-sent'; error(run, 'send-receipt', cause);
        if (run.sendInvoked && (!ACTIVE.has(run.record.state) || disposed)) { run.record.lateSendReceipt = true; await abort(run, true); }
        throw cause;
      });
    });
  }
  function resume(run, prompt) {
    paused(run);
    check(typeof prompt === 'string' && prompt.trim() && !prompt.includes('\0') && Buffer.byteLength(prompt) <= 512 * 1024, 'INVALID_PROMPT');
    // Reserve synchronously before any persistence/SDK await. Receipt-time event
    // envelopes retain the old generation even if their queue drains later.
    const generation = modelTurn(run.turn.id + 1);
    run.resuming = true; run.turn = generation; run.sendInvoked = false; run.lastAssistant = null;
    run.record.modelTurn = generation.id; run.record.turnEnded = false;
    run.record.finalText = ''; run.record.modelStopReason = null;
    run.record.sendState = 'pending'; run.record.sendPending = true;
    const job = (async () => {
      try {
        await checkpoint(run, 'send');
        await send(run, prompt); ensure(run);
        phase(run, 'awaiting-agent-end');
        if (!await notify(run)) throw failure('UPDATE_FAILED');
        ensure(run); run.resuming = false; generation.accepted.resolve();
        return { accepted: true, sessionId: run.record.sessionId, modelTurn: generation.id };
      } catch (cause) {
        if (ACTIVE.has(run.record.state)) await finish(run, cause.code === 'DEADLINE_EXCEEDED' ? 'timed-out' : 'failed', cause);
        else if (run.finishing) await run.finishing;
        throw cause;
      } finally {
        run.resuming = false;
        if (!run.sendInvoked) {
          run.record.sendPending = false; run.record.sendState = 'not-sent';
          if (run.record.abortOutcome === 'awaiting-send-receipt') await abort(run, true);
          await notify(run);
        }
        refresh(run);
      }
    })();
    run.followups.add(job); job.finally(() => run.followups.delete(job)).catch(() => {});
    return job;
  }
  async function setup(run) {
    try {
      await checkpoint(run, 'model-catalog');
      const catalog = await step(run, () => sdk.models.listAvailable());
      check(object(catalog) && catalog.ok !== false && !catalog.error && Array.isArray(catalog.models), 'MODEL_CATALOG_INVALID');
      if (Object.hasOwn(run.input.selection, 'thinkingLevel')) {
        validateWorkerSelection({ model: run.record.model, thinkingLevel: run.record.thinkingLevel }, catalog.models);
      } else {
        check(catalog.models.every((model) => object(model) && typeof model.provider === 'string' && model.provider.length > 0 && typeof model.id === 'string' && model.id.length > 0), 'MODEL_CATALOG_INVALID');
        check(catalog.models.some((model) => model.provider === run.record.model.provider && model.id === run.record.model.id), 'MODEL_NOT_AVAILABLE');
      }
      const researchTools = run.input.toolNames.filter((name) => !isNativeResearchTool(name));
      const nativeLiterature = requestsNativeLiterature(run.input.toolNames);
      if (researchTools.length) {
        await checkpoint(run, 'tool-catalog');
        const tools = await step(run, () => sdk.tools.list({ scope: 'own' }));
        check(Array.isArray(tools) && researchTools.every((name) => tools.some((tool) => tool.name === name && tool.source?.kind === 'app' && tool.source.appId === APP && tool.availability?.registered === true)), 'TOOL_NOT_AVAILABLE');
      }
      await checkpoint(run, 'session-create');
      await step(run, () => sdk.sessions.create({ agentId: run.record.agentId, cwd: run.input.cwd, namespace: 'app', memoryEnabled: false, model: copy(run.record.model),
        ...(Object.hasOwn(run.input.selection, 'thinkingLevel') ? { thinkingLevel: run.record.thinkingLevel } : {}), ...(run.input.kind ? { kind: run.input.kind } : {}) }), async (value) => {
        try { return receiveSession(run, value); }
        finally { if (!ACTIVE.has(run.record.state) && run.record.sessionId) await abort(run); }
      });
      await checkpoint(run, 'binding');
      await step(run, () => run.input.onBound({ sessionId: run.record.sessionId, sessionPath: run.record.sessionPath, agentId: run.record.agentId,
        role: run.record.role, model: copy(run.record.model), cwd: run.input.cwd, kind: run.input.kind,
        ...(Object.hasOwn(run.record, 'thinkingLevel') ? { thinkingLevel: run.record.thinkingLevel } : {}),
        ...(Object.hasOwn(run.record, 'reportedThinkingLevel') ? { reportedThinkingLevel: run.record.reportedThinkingLevel } : {}),
        sendState: run.record.sendState, sendPending: run.record.sendPending }), (receipt) => {
        check(receipt !== false && receipt?.ok !== false, 'BINDING_FAILED'); run.record.bound = true; return receipt;
      });
      await checkpoint(run, 'tool-selection');
      let selected = await step(run, () => sdk.sessions.setActiveTools({ sessionId: run.record.sessionId, toolNames: [...run.input.toolNames] }));
      confirmTools(selected, run.record.sessionId, run.input.toolNames, run.input.role);
      if (run.input.toolless) {
        const current = await step(run, () => sdk.sessions.getToolSelection({ sessionId: run.record.sessionId }));
        confirmTools(current, run.record.sessionId, []);
        check(current.toolNames.length === 0, 'TOOL_SELECTION_UNCONFIRMED');
        selected = current;
      } else if (nativeLiterature) {
        // New web-enabled sessions confirm the exact accepted set before sending.
        // Legacy read-only helper callers retain their existing SDK requirements.
        const current = await step(run, () => sdk.sessions.getToolSelection({ sessionId: run.record.sessionId }));
        confirmTools(current, run.record.sessionId, run.input.toolNames, run.input.role);
        check(current.toolNames.every((name) => selected.toolNames.includes(name)), 'TOOL_SELECTION_UNCONFIRMED');
        selected = current;
      }
      run.record.toolSelection = { requested: [...run.input.toolNames], resolved: [...selected.toolNames], effective: selected.effective, pendingToolNames: selected.pendingToolNames };
      await checkpoint(run, 'subscribe');
      await step(run, () => sdk.bus.subscribe((data, sourcePath) => {
        // Ignored errors must not replace the serial queue: a later ordinary
        // event still belongs behind any in-flight retry/update notification.
        if (data?.type === 'error' && (!ACTIVE.has(run.record.state) || !run.record.bound || !run.sendInvoked
          || sourcePath !== run.record.sessionPath || data.source !== 'session:send'
          || (Object.hasOwn(data, 'sessionId') && data.sessionId !== run.record.sessionId))) return;
        // Stamp receipt-time generation, not queue-drain time. Host events have
        // no turn token: this rejects old queued/paused ends, not arbitrary input
        // from another sender after the next start (there is no exclusive lease).
        const generation = run.turn;
        if (run.input.controlled) {
          if (!ACTIVE.has(run.record.state) || !data || sourcePath !== run.record.sessionPath
            || Object.hasOwn(data, 'sessionId') && data.sessionId !== run.record.sessionId) return;
          if (data.type === 'agent_start') {
            if (run.sendInvoked && !generation.ending) generation.started = true;
            return;
          }
          if (data.type !== 'error' && !(data.type === 'turn_end' && data.aborted === true)) {
            if (!run.sendInvoked || generation.ending || generation.id > 1 && !generation.started) return;
            if (data.type === 'agent_end' && data.willRetry !== true) generation.ending = true;
          }
        }
        const delivery = (data?.type === 'turn_end' && data.aborted === true) || data?.type === 'error'
          ? event(run, data, sourcePath, generation) : run.events.then(() => event(run, data, sourcePath, generation));
        run.events = delivery.catch(async (cause) => { if (ACTIVE.has(run.record.state)) await finish(run, 'failed', cause); });
      }, { sessionPath: run.record.sessionPath, types: [...(run.input.controlled ? ['agent_start'] : []), 'agent_end', 'message_end', 'turn_end', 'error'] }), async (handle) => {
        if (typeof handle !== 'function') { run.cleanupFailed = true; throw failure('SUBSCRIPTION_INVALID'); }
        run.subscription = handle;
        if (!ACTIVE.has(run.record.state)) await unsubscribe(run, handle);
        return handle;
      });
      await checkpoint(run, 'send');
      run.record.state = 'running'; run.record.sendState = 'pending'; run.record.sendPending = true;
      if (!await notify(run)) throw failure('UPDATE_FAILED');
      await send(run, run.input.prompt); ensure(run);
      phase(run, 'awaiting-agent-end'); run.turn.accepted.resolve();
    } catch (cause) {
      if (ACTIVE.has(run.record.state)) await finish(run, cause.code === 'DEADLINE_EXCEEDED' ? 'timed-out' : 'failed', cause);
      else if (run.finishing) await run.finishing;
    } finally {
      run.record.setupPending = false;
      if (!run.sendInvoked) {
        run.record.sendPending = false; run.record.sendState = 'not-sent';
        if (run.record.abortOutcome === 'awaiting-send-receipt') await abort(run, true);
      }
      refresh(run);
      if (!await notify(run) && ACTIVE.has(run.record.state)) await finish(run, 'failed', failure('UPDATE_FAILED'));
    }
  }
  function arm(run) {
    run.timer = setTimeout(() => {
      if (!ACTIVE.has(run.record.state)) return;
      if (Date.now() < run.input.deadlineAt) arm(run);
      else finish(run, 'timed-out', failure('DEADLINE_EXCEEDED')).catch(() => {});
    }, Math.max(0, Math.min(2147483647, run.input.deadlineAt - Date.now())));
  }
  function start(input) {
    check(!disposed, 'DISPOSED'); const value = validate(input); const now = Date.now();
    const run = { input: value, record: { executionId: randomUUID(), role: value.role, agentId: value.selection.agentId, model: copy(value.selection.model), actualModel: null,
      ...(Object.hasOwn(value.selection, 'thinkingLevel') ? { thinkingLevel: value.selection.thinkingLevel } : {}),
      cwd: value.cwd, kind: value.kind, sessionId: null, sessionPath: null, state: 'preparing', phase: 'queued', phaseTimestamps: { queued: now }, createdAt: now,
      deadlineAt: value.deadlineAt, setupPending: true, finalizing: false, cleanupPending: false, bound: false, requestedToolNames: [...value.toolNames], toolSelection: null,
      sendState: 'not-sent', sendPending: false, lateSendReceipt: false, abortOutcome: 'not-requested', roundEnded: false, finalText: '', modelStopReason: null,
      retryEvents: 0, updateVersion: 0, updateFailed: false, errors: [], error: null, failurePhase: null, sdkError: null,
      ...(value.controlled ? { modelTurn: 1, turnEnded: false } : {}) },
      pending: new Set(), updates: new Set(), followups: new Set(), closedSubscriptions: new Set(), failedSubscriptions: new Set(), notifications: Promise.resolve(), aborting: Promise.resolve(), events: Promise.resolve(),
      turn: modelTurn(1), resuming: false, halt: deferred(), done: deferred(), finishing: null, subscription: null, sendInvoked: false, cleanupFailed: false };
    runs.add(run); arm(run);
    run.background = Promise.resolve().then(() => setup(run));
    run.background.catch((cause) => finish(run, 'failed', cause)).catch(() => {});
    return { done: run.done.promise, snapshot: () => snapshot(run), stop: async () => { await finish(run, 'stopped', failure('EXPLICIT_STOP')); return snapshot(run); },
      ...(value.controlled ? {
        nextTurn: () => (ACTIVE.has(run.record.state) ? run.turn.ended.promise : run.done.promise).then(copy),
        resume: async (prompt) => resume(run, prompt),
        complete: async () => { paused(run); run.record.roundEnded = true; await finish(run, 'completed'); return snapshot(run); },
      } : {}) };
  }
  async function dispose() {
    disposed = true;
    await Promise.all([...runs].map((run) => finish(run, 'stopped', failure('DISPOSED'))));
    for (const run of runs) {
      try { await bounded(Promise.allSettled([run.background, run.events, run.aborting, run.notifications, ...run.pending, ...run.followups])); }
      catch (cause) { error(run, 'dispose', cause); }
    }
    const snapshots = [...runs].map(run => snapshot(run));
    const errors = snapshots.flatMap(record => record.errors
      .filter(item => ['abort', 'unsubscribe', 'dispose'].includes(item.operation))
      .map(item => ({ operation: item.operation, code: item.code })));
    return { disposed: true, errors, cleanupPending: errors.length > 0 || snapshots.some(record => record.cleanupPending) };
  }
  return { start, dispose };
}
