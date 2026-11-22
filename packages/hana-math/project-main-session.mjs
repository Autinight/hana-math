import path from 'node:path';
import { readResearchSessionInfo } from './research-session-info.mjs';
import { NATIVE_RESEARCH_TOOLS } from './native-literature.mjs';
import { NATIVE_EXPLORATION_TOOLS, resolveNativeExplorer } from './native-exploration.mjs';

const APP = 'hana-math';
const BASE_BUILTIN_TOOLS = Object.freeze([...NATIVE_RESEARCH_TOOLS, 'wait_for_tasks', 'current_status', 'loop_control']);
const BUILTIN_TOOLS = Object.freeze([...NATIVE_RESEARCH_TOOLS, ...NATIVE_EXPLORATION_TOOLS, 'wait_for_tasks', 'current_status', 'loop_control']);
const APP_TOOLS = Object.freeze(['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems', 'math_assign', 'math_project']);
const BASE_TOOL_NAMES = Object.freeze([...BASE_BUILTIN_TOOLS, ...APP_TOOLS]);
const TOOL_NAMES = Object.freeze([...BUILTIN_TOOLS, ...APP_TOOLS]);
const GOAL_APP_TOOLS = Object.freeze([...APP_TOOLS, 'math_goal_main']);
const BASE_GOAL_TOOL_NAMES = Object.freeze([...BASE_TOOL_NAMES, 'math_goal_main']);
const GOAL_TOOL_NAMES = Object.freeze([...TOOL_NAMES, 'math_goal_main']);
// Host-resolved names only, scoped to this SDK and exact saved binding. Retaining
// the returned selection on binding.toolSelection also preserves this evidence
// across helper/process recreation. This cache grants no authority or readiness.
const goalSelections = new WeakMap();
const UNSAFE_TOOLS = new Set(['write', 'edit', 'exec', 'exec_command', 'bash', 'shell', 'python', 'codemode', 'terminal', 'run_command', 'tool_call']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
const copy = (value) => structuredClone(value);
function failure(code) { return Object.assign(new Error(code), { code }); }
function check(condition, code) { if (!condition) throw failure(code); }
function ok(value) { return object(value) && value.ok !== false && !value.error; }
function codeOf(error) { return typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(error.code) ? error.code : 'HOST_OPERATION_FAILED'; }
function model(value) { return object(value) && text(value.provider, 256) && text(value.id, 256) ? { provider: value.provider, id: value.id } : null; }

function projectionInfo(value) {
  if (!object(value)) return null;
  const result = {};
  for (const side of ['get', 'list']) {
    if (!object(value[side])) return null;
    result[side] = {};
    for (const key of ['modelId', 'modelProvider']) {
      const field = value[side][key];
      if (!object(field) || !['missing', 'null', 'value', 'invalid'].includes(field.state)) return null;
      if (field.state === 'value' && !text(field.value, 256) || field.state === 'null' && field.value !== null) return null;
      result[side][key] = { state: field.state, ...(['value', 'null'].includes(field.state) ? { value: field.value } : {}) };
    }
  }
  return result;
}

function creationInfo(value) {
  if (!object(value)) return null;
  const result = {};
  for (const key of ['sessionId', 'sessionPath', 'path', 'agentId', 'cwd', 'namespace', 'visibility', 'ownerPluginId', 'kind', 'modelId', 'modelProvider']) {
    if (text(value[key])) result[key] = value[key];
    else if (value[key] === null) result[key] = null;
  }
  if (object(value.sessionRef)) result.sessionRef = {
    sessionId: text(value.sessionRef.sessionId) ? value.sessionRef.sessionId : null,
    sessionPath: text(value.sessionRef.sessionPath) ? value.sessionRef.sessionPath : null,
  };
  return result;
}
function selectionInfo(value, requested = TOOL_NAMES, explorationErrorCode = null) {
  if (!object(value)) return null;
  const explorationAvailable = NATIVE_EXPLORATION_TOOLS.every(name => requested.includes(name));
  return { sessionId: text(value.sessionId) ? value.sessionId : null, requested: [...requested],
    resolved: Array.isArray(value.toolNames) && value.toolNames.every((name) => text(name, 256)) ? [...value.toolNames] : null,
    effective: ['current', 'next-turn'].includes(value.effective) ? value.effective : null,
    pendingToolNames: value.pendingToolNames === null ? null
      : Array.isArray(value.pendingToolNames) && value.pendingToolNames.every((name) => text(name, 256)) ? [...value.pendingToolNames] : undefined,
    exploration: { state: explorationAvailable ? 'available' : 'unavailable', errorCode: explorationAvailable ? null : explorationErrorCode } };
}
function toolNames(value) { return Array.isArray(value) && value.every((name) => text(name, 256)) && new Set(value).size === value.length; }
function sameTools(left, right) { return toolNames(left) && toolNames(right) && left.length === right.length && left.every((name) => right.includes(name)); }
function confirmTarget(names, requested) {
  const required = requested.includes(NATIVE_EXPLORATION_TOOLS[0]) ? BUILTIN_TOOLS : BASE_BUILTIN_TOOLS;
  check(toolNames(names) && names.length === requested.length && required.every((name) => names.includes(name))
    && names.every((name) => !UNSAFE_TOOLS.has(name.toLowerCase())), 'TOOL_SELECTION_UNCONFIRMED');
}
function unavailableToolSelection(error) {
  if (error?.code !== 'APP_HOST_ERROR' || error.operation !== 'session:set-active-tools' || typeof error.message !== 'string') return false;
  // These exact Host preflight errors precede persistence. All other failures
  // retain their uncertainty; a rejected receipt never enters this branch.
  if (error.message === 'session tool selection names tools that are not configured for this session') return true;
  const listed = /^(?:session tool selection contains unavailable tool names|setSessionActiveTools: requested tools are unavailable for this session): ([a-z_]+(?:, [a-z_]+){0,3})$/.exec(error.message);
  return !!listed && listed[1].split(', ').every(name => NATIVE_EXPLORATION_TOOLS.includes(name));
}
function confirmSelection(value, sessionId) {
  check(ok(value) && value.sessionId === sessionId && ['current', 'next-turn'].includes(value.effective)
    && toolNames(value.toolNames) && (value.pendingToolNames === null || toolNames(value.pendingToolNames)), 'TOOL_SELECTION_UNCONFIRMED');
}
function selectedTarget(value) { return value.pendingToolNames === null ? value.toolNames : value.pendingToolNames; }
function confirmTools(value, sessionId, requested = TOOL_NAMES) {
  confirmSelection(value, sessionId);
  check(value.effective === 'current' && value.pendingToolNames === null, 'TOOL_SELECTION_UNCONFIRMED');
  confirmTarget(value.toolNames, requested);
}
function confirmRole(selected) {
  check(ok(selected) && selected.role === 'main' && selected.source === 'saved-role'
    && ['active', 'recovered'].includes(selected.instanceState) && text(selected.agentId, 128) && model(selected.model), 'ROLE_SELECTION_INVALID');
}
function confirmRoleTools(status, agentId, appTools) {
  check(ok(status) && status.role === 'main' && status.agentId === agentId, 'ROLE_SELECTION_CONFLICT');
  check(status.resolvedMode === 'full', 'ROLE_TOOLS_REQUIRE_FULL');
  check(status.appEnabled === true && Array.isArray(status.disabledTools) && status.disabledTools.every((name) => typeof name === 'string')
    && !status.disabledTools.some((name) => appTools.includes(name)), 'ROLE_TOOLS_DISABLED');
}
function confirmModelCatalog(catalog, selected) {
  check(ok(catalog) && Array.isArray(catalog.models) && catalog.models.every((row) => model(row)), 'MODEL_CATALOG_INVALID');
  check(catalog.models.some((row) => row.provider === selected.provider && row.id === selected.id), 'MODEL_NOT_AVAILABLE');
}
function confirmToolCatalog(tools, appTools) {
  // Registration is not session availability; the Host still gates setActiveTools.
  check(Array.isArray(tools) && appTools.every((name) => {
    const matches = tools.filter((tool) => tool?.name === name);
    return matches.length === 1 && matches[0].source?.kind === 'app' && matches[0].source.appId === APP
      && matches[0].availability?.registered === true && matches[0].availability.modelExposureAllowed !== false;
  }), 'TOOL_NOT_AVAILABLE');
}
async function confirmIdentity(sdk, state) {
  let info;
  try { info = await readResearchSessionInfo(sdk, { sessionId: state.sessionId }, { namespace: 'home' }); }
  catch (error) {
    if (error?.code === 'SESSION_INFO_INVALID') state.modelProjection = projectionInfo(error.modelProjection);
    throw error;
  }
  state.modelProjection = projectionInfo(info.modelProjection);
  check(info.path === state.sessionPath && info.agentId === state.agentId && info.cwd === state.cwd && info.kind === state.kind
    && info.lifecycle === 'active', 'SESSION_BINDING_MISMATCH');
  check(state.modelProjection, 'SESSION_MODEL_READBACK_INVALID');
  for (const side of ['get', 'list']) for (const [key, expected] of [['modelId', state.model.id], ['modelProvider', state.model.provider]]) {
    const field = state.modelProjection[side][key];
    check(field.state !== 'value' || field.value === expected, 'SESSION_MODEL_MISMATCH');
  }
  return info;
}
async function confirmModelContext(sdk, state) {
  try {
    const context = await sdk.sessions.context({ sessionId: state.sessionId });
    // Only configuration fields: never spread/serialize context or read prompt/usage.
    const sessionId = object(context) ? context.sessionId : null;
    const configuration = object(context) ? context.model : null;
    const id = object(configuration) ? configuration.id : undefined;
    const provider = object(configuration) ? configuration.provider : undefined;
    state.modelReadback.sessionId = text(sessionId) ? sessionId : null;
    state.modelReadback.model = model({ id, provider });
    check(state.modelReadback.sessionId === state.sessionId, 'SESSION_BINDING_MISMATCH');
    check(state.modelReadback.model, 'SESSION_MODEL_READBACK_INVALID');
    check(id === state.model.id && provider === state.model.provider
      && id === state.sessionModel.id && provider === state.sessionModel.provider, 'SESSION_MODEL_MISMATCH');
    state.modelReadback.state = 'confirmed'; state.modelReadback.configurationConfirmed = true;
  } catch (error) {
    state.modelReadback.state = 'failed'; state.modelReadback.error = codeOf(error); throw error;
  }
}

/** Trusted ProjectService backend only. onState(snapshot) must durably save each
 * checkpoint (undefined is success; false/{ok:false}/{error} or a rejection fails).
 * Success returns the ready snapshot; failures throw with the latest snapshot in
 * error.state, including any unverified create locators. Never retry create from
 * an unconfirmed record. The caller serializes/idempotently gates project setup.
 * sessionModel and modelReadback are configuration evidence, never inference.
 * Only sessionId and model.id/provider may be read from sessions.context.
 * No Agent writes, messages, subscriptions, /loop, or session cleanup occur here.
 * Tool selection is not authority; ProjectService must authorize every operation.
 */
export async function createProjectMainSession(sdk, input) {
  check(object(input) && Object.keys(input).every((key) => ['profiles', 'cwd', 'kind', 'onState', 'includeGoalTools'].includes(key)), 'INVALID_INPUT');
  const { profiles, cwd, onState, includeGoalTools = false } = input, kind = input.kind ?? null;
  check(typeof includeGoalTools === 'boolean', 'INVALID_INPUT');
  const requested = includeGoalTools ? GOAL_TOOL_NAMES : TOOL_NAMES, appTools = includeGoalTools ? GOAL_APP_TOOLS : APP_TOOLS;
  check(typeof profiles?.getRoleModel === 'function' && typeof profiles?.getRoleToolStatus === 'function', 'ROLE_PROFILE_UNAVAILABLE');
  check(text(cwd) && path.isAbsolute(cwd) && path.normalize(cwd) === cwd, 'INVALID_CWD');
  check(kind === null || (text(kind, 128) && /^[A-Za-z0-9_.:-]+$/.test(kind)), 'INVALID_KIND');
  check(typeof onState === 'function', 'INVALID_CALLBACK');
  const state = { state: 'pending', phase: 'saved-role', role: 'main', selection: null, agentId: null, model: null, cwd, kind,
    sessionId: null, sessionPath: null, namespace: null, visibility: null, ownerPluginId: null, lifecycle: null,
    createState: 'not-attempted', creation: null, sessionModel: null, modelProjection: null, modelReadback: null,
    identityConfirmed: false, toolSelection: null, explorer: null,
    error: null, failurePhase: null, persistenceFailed: false };
  let createAttempted = false;
  async function persist() {
    try {
      const result = await onState(copy(state));
      check(result !== false && result?.ok !== false && !result?.error, 'PROJECT_MAIN_STATE_SAVE_FAILED');
    } catch {
      state.persistenceFailed = true;
      throw failure('PROJECT_MAIN_STATE_SAVE_FAILED');
    }
  }
  try {
    const selected = await profiles.getRoleModel('main');
    confirmRole(selected);
    state.agentId = selected.agentId; state.model = model(selected.model);
    state.selection = { role: 'main', agentId: state.agentId, model: copy(state.model), source: 'saved-role', instanceState: selected.instanceState };
    state.phase = 'role-tools';
    const status = await profiles.getRoleToolStatus('main', { additionalAppTools: includeGoalTools ? ['math_project', 'math_goal_main'] : ['math_project'] });
    confirmRoleTools(status, state.agentId, appTools);
    state.phase = 'model-catalog';
    confirmModelCatalog(await sdk.models.listAvailable(), state.model);
    state.phase = 'tool-catalog';
    confirmToolCatalog(await sdk.tools.list({ scope: 'own' }), appTools);
    state.explorer = await resolveNativeExplorer(profiles, state.agentId);

    state.phase = 'session-create'; state.createState = 'pending';
    await persist(); // Failure here must not create a visible session.
    createAttempted = true;
    const created = await sdk.sessions.create({ agentId: state.agentId, cwd, namespace: 'home', memoryEnabled: false,
      model: copy(state.model), ...(kind === null ? {} : { kind }) });
    state.creation = creationInfo(created);
    state.sessionId = state.creation?.sessionId ?? state.creation?.sessionRef?.sessionId ?? null;
    state.sessionPath = state.creation?.sessionPath ?? state.creation?.sessionRef?.sessionPath ?? state.creation?.path ?? null;
    state.sessionModel = model({ provider: state.creation?.modelProvider, id: state.creation?.modelId });
    state.namespace = state.creation?.namespace ?? null; state.visibility = state.creation?.visibility ?? null;
    state.ownerPluginId = state.creation?.ownerPluginId ?? null;
    state.createState = 'returned'; state.state = 'created'; state.phase = 'identity';
    await persist(); // Save even mismatched/unverified locators before further SDK operations.
    check(ok(created) && created.ok === true && text(state.sessionId) && text(state.sessionPath)
      && created.sessionPath === state.sessionPath && created.path === state.sessionPath
      && (!Object.hasOwn(created, 'sessionId') || created.sessionId === state.sessionId)
      && (!Object.hasOwn(created, 'sessionRef') || (created.sessionRef?.sessionId === state.sessionId && created.sessionRef.sessionPath === state.sessionPath))
      && created.namespace === 'home' && created.visibility === 'public' && created.ownerPluginId === APP
      && created.agentId === state.agentId && created.cwd === cwd && created.kind === kind, 'SESSION_BINDING_MISMATCH');
    check(state.sessionModel?.provider === state.model.provider && state.sessionModel?.id === state.model.id, 'SESSION_MODEL_MISMATCH');
    const info = await confirmIdentity(sdk, state);
    state.phase = 'model-readback';
    state.modelReadback = { source: 'sessions.context', state: 'pending', sessionId: null, model: null, configurationConfirmed: false, error: null };
    await persist(); // Preserve optional disk diagnostics before the independent readback.
    await confirmModelContext(sdk, state);
    state.identityConfirmed = true; state.lifecycle = info.lifecycle; state.createState = 'confirmed';
    state.phase = 'tool-selection';
    let activeRequested = requested, explorationErrorCode = null, selection;
    try { selection = await sdk.sessions.setActiveTools({ sessionId: state.sessionId, toolNames: [...activeRequested] }); }
    catch (error) {
      if (!NATIVE_EXPLORATION_TOOLS.every(name => requested.includes(name)) || !unavailableToolSelection(error)) throw error;
      explorationErrorCode = codeOf(error);
      activeRequested = includeGoalTools ? BASE_GOAL_TOOL_NAMES : BASE_TOOL_NAMES;
      selection = await sdk.sessions.setActiveTools({ sessionId: state.sessionId, toolNames: [...activeRequested] });
    }
    state.toolSelection = selectionInfo(selection, activeRequested, explorationErrorCode);
    confirmTools(selection, state.sessionId, activeRequested);
    // App model-facing names are host-resolved and opaque. Do not fabricate them
    // from local names; confirm the exact accepted set through the public read API.
    const current = await sdk.sessions.getToolSelection({ sessionId: state.sessionId });
    confirmTools(current, state.sessionId, activeRequested);
    check(sameTools(current.toolNames, selection.toolNames), 'TOOL_SELECTION_UNCONFIRMED');
    state.toolSelection = selectionInfo(current, activeRequested, explorationErrorCode);
    state.state = 'ready'; state.phase = 'ready';
    await persist();
    return copy(state);
  } catch (error) {
    state.failurePhase = state.phase; state.error = codeOf(error);
    if (!createAttempted) state.createState = 'not-attempted';
    else if (state.createState === 'pending') state.createState = 'unconfirmed';
    state.state = createAttempted ? 'unconfirmed' : 'failed';
    // A failed persistence callback is not retried: even if its write happened,
    // durability is unconfirmed. The thrown snapshot must not be treated as ready.
    if (!state.persistenceFailed) {
      try { await persist(); }
      catch { /* Preserve the original operation error and mark persistenceFailed. */ }
    }
    throw Object.assign(failure(state.error), { state: copy(state) });
  }
}

// Restart observation only: never repairs selection, resolves Explorer or creates
// resources. A current Host receipt must match the saved opaque resolution.
export async function readProjectMainRecoveryReadiness(sdk, { profiles, binding } = {}) {
  check(object(binding) && binding.identityConfirmed === true && binding.namespace === 'home'
    && binding.visibility === 'public' && binding.ownerPluginId === APP
    && ['sessionId', 'sessionPath', 'agentId', 'cwd'].every(key => text(binding[key]))
    && (binding.kind === null || text(binding.kind, 128)) && model(binding.model), 'SESSION_BINDING_MISMATCH');
  const state = Object.fromEntries(['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind'].map(key => [key, binding[key]]));
  state.model = model(binding.model); state.sessionModel = Object.hasOwn(binding, 'sessionModel') ? model(binding.sessionModel) : model(binding.model);
  check(state.sessionModel, 'SESSION_MODEL_READBACK_INVALID');
  const saved = binding.toolSelection;
  check(object(saved) && (sameTools(saved.requested, GOAL_TOOL_NAMES)
    || saved.exploration?.state === 'unavailable' && saved.exploration.errorCode === 'APP_HOST_ERROR'
      && sameTools(saved.requested, BASE_GOAL_TOOL_NAMES)), 'TOOL_SELECTION_UNCONFIRMED');
  const requested = [...saved.requested], target = Array.isArray(saved.resolved) ? [...saved.resolved] : null;
  confirmTools({ sessionId: saved.sessionId, toolNames: target, effective: saved.effective, pendingToolNames: saved.pendingToolNames }, state.sessionId, requested);
  const selected = await profiles.getRoleModel('main'); confirmRole(selected);
  check(selected.agentId === state.agentId, 'ROLE_SELECTION_CONFLICT');
  check(selected.model.id === state.model.id && selected.model.provider === state.model.provider, 'SESSION_MODEL_MISMATCH');
  confirmRoleTools(await profiles.getRoleToolStatus('main', { additionalAppTools: ['math_project', 'math_goal_main'] }), state.agentId, GOAL_APP_TOOLS);
  confirmModelCatalog(await sdk.models.listAvailable(), state.model);
  confirmToolCatalog(await sdk.tools.list({ scope: 'own' }), GOAL_APP_TOOLS);
  await confirmIdentity(sdk, state);
  const current = await sdk.sessions.getToolSelection({ sessionId: state.sessionId });
  confirmTools(current, state.sessionId, requested);
  check(sameTools(current.toolNames, target), 'TOOL_SELECTION_UNCONFIRMED');
  const context = await sdk.sessions.context({ sessionId: state.sessionId });
  check(ok(context) && context.sessionId === state.sessionId, 'SESSION_BINDING_MISMATCH');
  const configured = model(context.model);
  check(configured && configured.provider === state.model.provider && configured.id === state.model.id
    && configured.provider === state.sessionModel.provider && configured.id === state.sessionModel.id, 'SESSION_MODEL_MISMATCH');
  check(context.isStreaming === false && context.isCompacting === false && context.pendingMessageCount === 0, 'MAIN_CONTROL_MAIN_NOT_IDLE');
  return { ready: true };
}

/** Trusted backend only, after caller authorization. binding is the existing
 * identity-confirmed main snapshot; never create/clone/abort or repair it here.
 * A current receipt confirms configuration, not per-call tool authority. Pending
 * is a successful deferred selection, NOT permission to activate a Goal. There
 * are no polling loops, idle observers or turns; a later explicit call reads again.
 * Persist result.selection as binding.toolSelection to retain Host-resolved names
 * across restarts. Without that evidence, matching opaque names cannot be guessed.
 */
export async function ensureProjectMainGoalTools(sdk, input) {
  check(object(input) && Object.keys(input).every((key) => ['profiles', 'binding'].includes(key)), 'INVALID_INPUT');
  const { profiles, binding } = input;
  check(typeof profiles?.getRoleModel === 'function' && typeof profiles?.getRoleToolStatus === 'function', 'ROLE_PROFILE_UNAVAILABLE');
  check(object(binding) && binding.identityConfirmed === true && binding.namespace === 'home'
    && binding.visibility === 'public' && binding.ownerPluginId === APP
    && ['sessionId', 'sessionPath', 'agentId', 'cwd'].every((key) => text(binding[key]))
    && path.isAbsolute(binding.cwd) && path.normalize(binding.cwd) === binding.cwd
    && (binding.kind === null || text(binding.kind, 128)) && model(binding.model), 'SESSION_BINDING_MISMATCH');
  // Snapshot only known configuration; callers may mutate their record during awaits.
  const state = Object.fromEntries(['sessionId', 'sessionPath', 'agentId', 'cwd', 'kind'].map((key) => [key, binding[key]]));
  state.model = model(binding.model); state.sessionModel = Object.hasOwn(binding, 'sessionModel') ? model(binding.sessionModel) : model(binding.model);
  check(state.sessionModel, 'SESSION_MODEL_READBACK_INVALID');
  let savedTarget = null, savedRequested = null, savedExplorationError = null;
  const saved = binding.toolSelection;
  const savedExplorationUnavailable = object(saved?.exploration) && saved.exploration.state === 'unavailable'
    && saved.exploration.errorCode === 'APP_HOST_ERROR';
  if (object(saved) && (sameTools(saved.requested, GOAL_TOOL_NAMES)
    || savedExplorationUnavailable && sameTools(saved.requested, BASE_GOAL_TOOL_NAMES))) {
    const receipt = { sessionId: saved.sessionId, toolNames: saved.resolved, pendingToolNames: saved.pendingToolNames, effective: saved.effective };
    savedRequested = [...saved.requested];
    confirmSelection(receipt, state.sessionId); confirmTarget(selectedTarget(receipt), savedRequested);
    if (savedExplorationUnavailable) savedExplorationError = saved.exploration.errorCode;
    savedTarget = [...selectedTarget(receipt)];
  }
  try {
    const selected = await profiles.getRoleModel('main'); confirmRole(selected);
    check(selected.agentId === state.agentId, 'ROLE_SELECTION_CONFLICT');
    check(selected.model.id === state.model.id && selected.model.provider === state.model.provider, 'SESSION_MODEL_MISMATCH');
    confirmRoleTools(await profiles.getRoleToolStatus('main', { additionalAppTools: ['math_project', 'math_goal_main'] }), state.agentId, GOAL_APP_TOOLS);
    confirmModelCatalog(await sdk.models.listAvailable(), state.model);
    confirmToolCatalog(await sdk.tools.list({ scope: 'own' }), GOAL_APP_TOOLS);
    await confirmIdentity(sdk, state);
    state.modelReadback = { source: 'sessions.context', state: 'pending', sessionId: null, model: null, configurationConfirmed: false, error: null };
    await confirmModelContext(sdk, state);

    let selections = goalSelections.get(sdk);
    if (!selections) { selections = new Map(); goalSelections.set(sdk, selections); }
    const key = JSON.stringify([state.sessionId, state.sessionPath, state.agentId, state.cwd, state.kind, state.model]);
    const cached = selections.get(key);
    let requested = cached?.requested || savedRequested || GOAL_TOOL_NAMES;
    let explorationErrorCode = cached?.explorationErrorCode ?? savedExplorationError;
    let target = cached?.target || savedTarget;
    let current = await sdk.sessions.getToolSelection({ sessionId: state.sessionId });
    confirmSelection(current, state.sessionId);
    if (!target || !sameTools(selectedTarget(current), target)) {
      let accepted;
      try { accepted = await sdk.sessions.setActiveTools({ sessionId: state.sessionId, toolNames: [...requested] }); }
      catch (error) {
        if (!sameTools(requested, GOAL_TOOL_NAMES) || !unavailableToolSelection(error)) throw error;
        explorationErrorCode = codeOf(error); requested = BASE_GOAL_TOOL_NAMES;
        accepted = await sdk.sessions.setActiveTools({ sessionId: state.sessionId, toolNames: [...requested] });
      }
      confirmSelection(accepted, state.sessionId); confirmTarget(selectedTarget(accepted), requested);
      target = [...selectedTarget(accepted)];
      // Remember an accepted resolution even if independent readback fails. A
      // subsequent explicit call reads first; it does not repeat set as a query.
      selections.set(key, { target, requested: [...requested], explorationErrorCode });
      current = await sdk.sessions.getToolSelection({ sessionId: state.sessionId });
      confirmSelection(current, state.sessionId);
    }
    check(sameTools(selectedTarget(current), target), 'TOOL_SELECTION_UNCONFIRMED');
    confirmTarget(selectedTarget(current), requested);
    selections.set(key, { target: [...target], requested: [...requested], explorationErrorCode });
    return { state: current.effective === 'current' && current.pendingToolNames === null ? 'ready' : 'pending',
      selection: selectionInfo(current, requested, explorationErrorCode), explorer: await resolveNativeExplorer(profiles, state.agentId) };
  } catch (error) { throw failure(codeOf(error)); }
}
