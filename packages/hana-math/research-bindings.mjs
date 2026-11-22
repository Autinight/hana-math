// Research authority comes from host session metadata and a backend-owned binding.
// Model arguments never select a role, author, project, or filesystem root.
import { readResearchSessionInfo } from './research-session-info.mjs';
import { NATIVE_RESEARCH_TOOLS } from './native-literature.mjs';

export const RESEARCH_ROLE_TOOLS = Object.freeze({
  main: Object.freeze(['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems']),
  worker: Object.freeze(['gm_add', 'gm_search', 'fact_submit', 'fact_search', 'search_arxiv_theorems']),
  verifier: Object.freeze(['search_arxiv_theorems']),
});
export const RESEARCH_IO_TOOLS = Object.freeze({
  main: Object.freeze(['math_assign']),
  worker: Object.freeze(['math_local_memory']),
  verifier: Object.freeze(['math_verification_report']),
});
const APP_ID = 'hana-math';
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AGENT_ID = /^(?=.*[A-Za-z0-9])[A-Za-z0-9_-]{1,128}$/;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const copy = (value) => JSON.parse(JSON.stringify(value));
// CWD is supplied by the backend, not a tool argument. Accept a local absolute
// drive path as well as POSIX paths; never fold case or normalize the value later
// compared with both Host session projections. A rooted Windows path without a
// drive, a drive-relative path, and a UNC/device path are not local drive paths.
function localCwd(value) {
  if (typeof value !== 'string' || /[\x00-\x1f]/.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  if (!/^[A-Za-z]:[\\/]/.test(value)) return false;
  return value.slice(3).split(/[\\/]/).every(part => part && part !== '.' && part !== '..' && !/[<>:"|?*]/.test(part));
}
export class ResearchBindingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new ResearchBindingError(code, message); }
export function researchAppToolNames(role, { assign = true } = {}) {
  if (typeof role !== 'string' || !Object.hasOwn(RESEARCH_ROLE_TOOLS, role)) fail('ROLE_INVALID', 'Unknown research role.');
  return [...RESEARCH_ROLE_TOOLS[role], ...RESEARCH_IO_TOOLS[role].filter((name) => assign || name !== 'math_assign')];
}
export function researchToolNames(role, options) {
  return [...NATIVE_RESEARCH_TOOLS, ...researchAppToolNames(role, options)];
}
function invocation(context) {
  if (!plain(context) || typeof context.callToken !== 'string' || !context.callToken
    || typeof context.sessionPath !== 'string' || !context.sessionPath) {
    fail('CALLER_UNBOUND', 'Research actions require a host-authorized model invocation.');
  }
  return context.sessionPath;
}
function ownedRole(agent, role) {
  return agent?.state === 'active' && agent.deletedAt == null && agent.ownerPluginId === APP_ID
    && ['plugin_private', 'private'].includes(agent.visibility) && agent.plugin?.ownerPluginId === APP_ID
    && ['plugin_private', 'private'].includes(agent.plugin.visibility) && agent.plugin.kind === 'role' && agent.plugin.roleId === role;
}
async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ResearchBindingError('AUTHORITY_TIMEOUT', 'Host identity lookup timed out.')), 10000);
    })]);
  } finally { clearTimeout(timer); }
}
/** Backend-only construction. isRunActive must fail closed during recovery. */
export function createResearchBindings(sdk, { isRunActive, onLocatorChanged = async () => {} } = {}) {
  if (typeof isRunActive !== 'function') throw new TypeError('isRunActive is required');
  const sessions = new Map();
  function register(binding) {
    if (!plain(binding) || typeof binding.runId !== 'string' || !SAFE_ID.test(binding.runId)
      || typeof binding.projectId !== 'string' || !SAFE_ID.test(binding.projectId)
      || typeof binding.role !== 'string' || !Object.hasOwn(RESEARCH_ROLE_TOOLS, binding.role)
      || typeof binding.agentId !== 'string' || !AGENT_ID.test(binding.agentId)
      || typeof binding.sessionId !== 'string' || !binding.sessionId || typeof binding.sessionPath !== 'string' || !binding.sessionPath
      || !localCwd(binding.cwd) || binding.author !== binding.agentId
      || (Object.hasOwn(binding, 'workerId') && (binding.role !== 'worker' || typeof binding.workerId !== 'string' || !SAFE_ID.test(binding.workerId)))
      || (binding.submissionId !== undefined && (typeof binding.submissionId !== 'string' || !SAFE_ID.test(binding.submissionId)))) fail('BINDING_INVALID', 'Invalid backend research binding.');
    if (sessions.has(binding.sessionId)) fail('BINDING_CONFLICT', 'Session is already bound.');
    const value = { runId: binding.runId, projectId: binding.projectId, role: binding.role,
      agentId: binding.agentId, author: binding.author, sessionId: binding.sessionId,
      sessionPath: binding.sessionPath, cwd: binding.cwd, active: binding.active !== false,
      ...(binding.submissionId === undefined ? {} : { submissionId: binding.submissionId }),
      ...(Object.hasOwn(binding, 'workerId') ? { workerId: binding.workerId } : {}) };
    sessions.set(value.sessionId, value);
    return copy(value);
  }
  function close(sessionId) { const binding = sessions.get(sessionId); if (binding) binding.active = false; }
  function closeRun(runId) { for (const binding of sessions.values()) if (binding.runId === runId) binding.active = false; }
  function snapshot(runId) { return [...sessions.values()].filter((binding) => runId === undefined || binding.runId === runId).map(copy); }
  async function authorize(toolName, context) {
    const sessionPath = invocation(context);
    let session;
    try { session = await readResearchSessionInfo(sdk, { sessionPath }); }
    catch (error) {
      if (error?.code === 'SESSION_INFO_INVALID') fail('CALLER_UNBOUND', error.message);
      throw error;
    }
    if (session.lifecycle !== 'active') fail('CALLER_UNBOUND', 'Caller is not an active Math research session.');
    const binding = sessions.get(session.sessionId);
    if (!binding || !binding.active || isRunActive(binding.runId) !== true || binding.agentId !== session.agentId || binding.cwd !== session.cwd) {
      fail('CALLER_UNBOUND', 'Caller does not match a live backend research binding.');
    }
    const allowed = [...RESEARCH_ROLE_TOOLS[binding.role], ...RESEARCH_IO_TOOLS[binding.role]];
    if (!allowed.includes(toolName)) fail('ROLE_DENIED', `The ${binding.role} role cannot call ${toolName}.`);
    const listed = await bounded(() => sdk.agents.list({ lifecycle: 'all' }));
    if (listed?.ok === false || !Array.isArray(listed?.agents)) fail('AUTHORITY_UNAVAILABLE', 'Agent ownership could not be checked.');
    const matches = listed.agents.filter((agent) => agent?.id === binding.agentId);
    if (matches.length !== 1 || !ownedRole(matches[0], binding.role)) fail('ROLE_DENIED', 'The configured role is no longer an active owned role.');
    // Re-check after every asynchronous authority lookup; stop may have happened meanwhile.
    if (!binding.active || isRunActive(binding.runId) !== true) fail('RUN_INACTIVE', 'The research run is no longer active.');
    if (typeof session.path !== 'string' || !session.path) fail('AUTHORITY_UNAVAILABLE', 'Host did not return a current session locator.');
    if (session.path !== binding.sessionPath) {
      const changed = { ...binding, sessionPath: session.path };
      await onLocatorChanged(copy(changed));
      if (!binding.active || isRunActive(binding.runId) !== true) fail('RUN_INACTIVE', 'The research run stopped during identity persistence.');
      binding.sessionPath = session.path;
    }
    return copy(binding);
  }
  return { register, close, closeRun, snapshot, authorize };
}
/** Control access is tied to the exact host-stamped originating conversation.
 * It deliberately does not grant cross-conversation access or decode callToken.
 * A moved origin locator is refused until an explicitly designed rebind exists.
 */
export function assertResearchOwner(run, context) {
  const sessionPath = invocation(context);
  if (!plain(run?.owner) || typeof run.owner.sessionId !== 'string' || !run.owner.sessionId
    || run.owner.sessionPath !== sessionPath) fail('OWNER_DENIED', 'Use the originating conversation to control this research run.');
}
