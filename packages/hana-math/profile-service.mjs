import { randomUUID } from 'node:crypto';
import { researchAppToolNames } from './research-bindings.mjs';
import { EXPLORER_CREATION_KEY, readExplorerContract, createExplorerInstance, explorerPersonaBinding, readExplorerMemoryProfile } from './explorer-profile.mjs';

export const ROLE_TOOL_MODES = Object.freeze(['minimal', 'light', 'standard', 'full']);

export const ROLE_IDS = ['main', 'worker', 'verifier', 'explorer'];
const ROLE_STATUS_APP_TOOLS = new Set([...['main', 'worker', 'verifier'].flatMap((role) => researchAppToolNames(role)), 'math_project', 'math_goal', 'math_goal_main']);
const APP_ID = 'hana-math';
const TEXT_LIMIT = 128 * 1024;
const AVATAR_LIMIT = 512 * 1024;
const FIELDS = ['name', 'latinName', 'model', 'identity', 'agentsMd'];
const FILES = { identity: 'identity.md', agentsMd: 'AGENTS.md' };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const active = (agent) => agent?.state === 'active' && agent.deletedAt == null;
const bindingKey = (id) => `profile.role.${id}`;
const avatarKey = (kind, id) => `profile.avatar.${kind}.${id}`;

export class ProfileError extends Error {
  constructor(code, message, status = 400, applied) {
    super(message); this.code = code; this.status = status; this.applied = applied;
  }
}
const fail = (code, message, status) => { throw new ProfileError(code, message, status); };

export function publicAssistant(agent) {
  return active(agent) && agent.visibility === 'public' && agent.ownerPluginId === null
    && (!agent.plugin || (agent.plugin.visibility === 'public' && agent.plugin.ownerPluginId === null));
}
function ownRole(agent, id) {
  return agent?.ownerPluginId === APP_ID && ['plugin_private', 'private'].includes(agent.visibility)
    && agent.plugin?.ownerPluginId === APP_ID && ['plugin_private', 'private'].includes(agent.plugin.visibility)
    && agent.plugin.kind === 'role' && agent.plugin.roleId === id;
}
function recoverable(agent, id) {
  const base = `hana-math-${id}`;
  return ownRole(agent, id) && active(agent) && (agent.id === base || new RegExp(`^${base}-[a-f0-9-]{36}$`).test(agent.id));
}
function hostError(error) {
  if (error instanceof ProfileError) return error;
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  if (/DENIED|FORBIDDEN|ACCESS|PERMISSION/i.test(code) || error?.status === 403 || error?.kind === 'permission'
    || /permission|capability|does not belong|not authori[sz]ed|access denied/i.test(message)) {
    return new ProfileError('FORBIDDEN', 'Hana 未授权此读取或保存操作，请检查 Math 应用权限。', 403);
  }
  if (/conflict|already exists|already in use/i.test(`${code} ${message}`)) return new ProfileError('CONFLICT', '目标已存在或已发生变化，请重新打开编辑器。', 409);
  if (/not_found|not found/i.test(`${code} ${message}`)) return new ProfileError('NOT_FOUND', '目标不存在，请重新打开编辑器。', 404);
  return new ProfileError('HOST_ERROR', 'Hana 操作失败，未确认的字段不会被报告为已保存。', 502);
}
function checked(result) {
  if (!result || result.error || result.ok === false) throw result?.error || new Error('Invalid host result');
  return result;
}
function rows(result, key) {
  checked(result);
  if (!Array.isArray(result[key])) throw new Error(`Invalid ${key} list`);
  return result[key];
}
function modelRef(value) {
  return record(value) && typeof value.provider === 'string' && value.provider && typeof value.id === 'string' && value.id
    ? { provider: value.provider, id: value.id } : null;
}
function versionOf(value) {
  if (!record(value) || !Object.keys(value).length) return null;
  const result = {};
  for (const key of ['mtimeMs', 'size', 'sha256', 'etag', 'sequence']) if (Object.hasOwn(value, key)) result[key] = value[key];
  return Object.keys(result).length ? result : null;
}
function decodeText(content) {
  let bytes;
  if (typeof content === 'string') bytes = Buffer.from(content, 'utf8');
  else if (content instanceof Uint8Array) bytes = Buffer.from(content);
  else if (content instanceof ArrayBuffer) bytes = Buffer.from(content);
  else if (content?.type === 'Buffer' && Array.isArray(content.data) && content.data.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) bytes = Buffer.from(content.data);
  else if (record(content) && Object.keys(content).every((key, i) => key === String(i)) && Object.values(content).every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) bytes = Buffer.from(Object.values(content));
  else throw new Error('Unsupported ResourceIO content');
  if (bytes.length > TEXT_LIMIT) fail('RESOURCE_TOO_LARGE', '人格文件超过 128 KiB，不能在此编辑。', 413);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export function validateAvatar(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(AVATAR_LIMIT / 3) * 4 + 40) fail('INVALID_AVATAR', '头像须为不超过 512 KiB 的 PNG、JPEG 或 WebP。', 400);
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) fail('INVALID_AVATAR', '头像只接受 PNG、JPEG 或 WebP base64 数据。', 400);
  const bytes = Buffer.from(match[2], 'base64');
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!bytes.length || bytes.length > AVATAR_LIMIT || bytes.toString('base64') !== match[2] || !valid) fail('INVALID_AVATAR', '头像类型、编码或大小无效。', 400);
  return value;
}
function validateInput(input) {
  const allowed = ['revision', ...FIELDS, 'avatarDataUrl'];
  if (!record(input) || Object.keys(input).some((key) => !allowed.includes(key))) fail('INVALID_INPUT', '请求含不支持的字段。', 400);
  if (typeof input.revision !== 'string' || !input.revision) fail('INVALID_INPUT', '缺少编辑版本，请重新打开编辑器。', 400);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 128 || /[\x00-\x1f\x7f]/.test(input.name)) fail('INVALID_INPUT', '名称不能为空，且须不超过 128 个字符。', 400);
  if (typeof input.latinName !== 'string') fail('INVALID_INPUT', '英文名称必须是文本。', 400);
  const latinName = input.latinName.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (Array.from(latinName).length > 32 || (latinName && (!/^[\p{Script=Latin} '’-]+$/u.test(latinName) || !/\p{Script=Latin}/u.test(latinName)))) fail('INVALID_INPUT', '英文名称须为最多 32 个拉丁字母、空格、连字符或撇号。', 400);
  for (const field of ['identity', 'agentsMd']) if (typeof input[field] !== 'string' || Buffer.byteLength(input[field], 'utf8') > TEXT_LIMIT) fail('INVALID_INPUT', '每个人格字段须为不超过 128 KiB 的文本。', 400);
  if (input.model !== null && (!record(input.model) || Object.keys(input.model).some((key) => !['provider', 'id'].includes(key)) || !modelRef(input.model))) fail('INVALID_MODEL', '模型须为目录中的 provider/id。', 400);
  if (Object.hasOwn(input, 'avatarDataUrl')) validateAvatar(input.avatarDataUrl);
  return { ...input, name: input.name.trim(), latinName, model: modelRef(input.model) };
}

export function createProfileService(sdk, { now = Date.now, maxRevisions = 128, ttl = 20 * 60 * 1000 } = {}) {
  const revisions = new Map();
  const locks = new Map();
  function target(kind, id) {
    if (!['assistant', 'role'].includes(kind) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/[A-Za-z0-9]/.test(id) || (kind === 'role' && !ROLE_IDS.includes(id))) fail('NOT_FOUND', '未知成员。', 404);
    return `${kind}:${id}`;
  }
  function prune() {
    for (const [token, entry] of revisions) if (entry.expires <= now()) revisions.delete(token);
    while (revisions.size >= maxRevisions) revisions.delete(revisions.keys().next().value);
  }
  async function serial(key, action) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    locks.set(key, pending);
    await previous;
    try { return await action(); }
    finally { release(); if (locks.get(key) === pending) locks.delete(key); }
  }
  async function avatar(kind, id) {
    const value = await sdk.storage.global.get(avatarKey(kind, id), null);
    if (value !== null) return { avatarUrl: validateAvatar(value), avatarSource: 'math' };
    if (kind === 'role') return { avatarUrl: './assets/avatars/preset.png', avatarSource: 'reference' };
    if (['shiraha', 'xiaojingyu'].includes(id)) return { avatarUrl: `./assets/avatars/${id}.png`, avatarSource: 'reference' };
    return { avatarUrl: './assets/avatars/default.svg', avatarSource: 'default' };
  }
  async function roleBindings() {
    const agents = rows(await sdk.agents.list({ lifecycle: 'all' }), 'agents');
    const bindings = {};
    for (const id of ROLE_IDS) {
      try { bindings[id] = await resolveRole(id, agents); }
      catch (error) {
        if (id !== 'explorer') throw error;
        bindings[id] = { agent: null, state: 'unavailable', errorCode: hostError(error).code };
      }
    }
    return bindings;
  }
  async function resolveRole(id, givenAgents) {
    const agents = givenAgents || rows(await sdk.agents.list({ lifecycle: 'all' }), 'agents');
    const binding = await sdk.storage.global.get(bindingKey(id), null);
    if (id === 'explorer') {
      const marker = await sdk.storage.global.get(EXPLORER_CREATION_KEY, null);
      if (marker !== null && (marker?.schemaVersion !== 1 || marker.state !== 'ready' || marker.agentId !== binding?.agentId)) fail('EXPLORER_CREATION_UNCONFIRMED', 'Explorer creation is unconfirmed; no automatic replacement is permitted.', 409);
    }
    if (binding !== null) {
      if (!record(binding) || typeof binding.agentId !== 'string') fail('INVALID_BINDING', 'Math 成员绑定无效，未接管任何 Agent。', 409);
      const row = agents.find((agent) => agent?.id === binding.agentId);
      if (row && !ownRole(row, id)) fail('FORBIDDEN', '绑定不属于此 Math 角色，拒绝编辑。', 403);
      if (row && active(row)) return { agent: row, state: 'active', mapped: true };
      return { agent: null, state: row ? 'retired' : 'missing', mapped: true, previousId: binding.agentId };
    }
    const candidates = agents.filter((agent) => recoverable(agent, id));
    if (candidates.length > 1) fail('AMBIGUOUS_INSTANCE', '存在多个未绑定实例，未自动选择。', 409);
    return { agent: candidates[0] || null, state: candidates.length ? 'recovered' : 'preset', mapped: false };
  }
  async function getRoleModel(role) {
    try {
      target('role', role);
      const binding = await resolveRole(role);
      if (!binding.agent) {
        if (binding.state === 'retired') fail('ROLE_RETIRED', 'Math 角色实例已退役，请先在 Math 中保存有效角色配置。', 409);
        if (binding.state === 'missing') fail('ROLE_MISSING', 'Math 已保存的角色实例不存在，请先在 Math 中保存有效角色配置。', 404);
        fail('ROLE_NOT_CONFIGURED', 'Math 角色尚未保存为实例，请先在 Math 中选择模型并保存。', 409);
      }
      const agentId = binding.agent.id;
      const { config } = checked(await sdk.agents.config({ agentId }));
      if (!record(config)) throw new Error('Invalid config');
      const model = modelRef(config.models?.chat);
      if (!model) fail('MODEL_NOT_CONFIGURED', 'Math 角色未保存聊天模型，请先在 Math 中选择模型并保存。', 409);
      const latest = await resolveRole(role);
      if (latest.agent?.id !== agentId || latest.state !== binding.state || latest.mapped !== binding.mapped) {
        fail('CONFLICT', 'Math 角色绑定或实例在读取模型时改变，请重新查询。', 409);
      }
      return { role, agentId, instanceState: latest.state, model, source: 'saved-role' };
    } catch (error) { throw hostError(error); }
  }
  // Additional App names are for trusted backend checks only, never model input
  // or permission grants. Builtins are not App configuration switches.
  async function getRoleToolStatus(role, options = {}) {
    try {
      target('role', role);
      if (!record(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
        || Reflect.ownKeys(options).some((key) => key !== 'additionalAppTools')
        || (Object.hasOwn(options, 'additionalAppTools') && !Object.hasOwn(Object.getOwnPropertyDescriptor(options, 'additionalAppTools'), 'value'))) {
        fail('INVALID_INPUT', 'Tool-status options contain unsupported fields.', 400);
      }
      const { additionalAppTools = [] } = options;
      if (!Array.isArray(additionalAppTools) || additionalAppTools.length > ROLE_STATUS_APP_TOOLS.size
        || new Set(additionalAppTools).size !== additionalAppTools.length
        || ![...additionalAppTools].every((name) => typeof name === 'string' && ROLE_STATUS_APP_TOOLS.has(name))) {
        fail('INVALID_INPUT', 'Additional tools must be a bounded, unique list of this App\'s tool names.', 400);
      }
      if (role === 'explorer' && additionalAppTools.length) fail('INVALID_INPUT', 'Explorer has no App business tools.', 400);
      const toolNames = role === 'explorer' ? [] : [...new Set([...researchAppToolNames(role), ...additionalAppTools])];
      const binding = await resolveRole(role);
      if (!binding.agent) fail('ROLE_NOT_CONFIGURED', '角色没有活跃的已保存实例。', 409);
      const agentId = binding.agent.id;
      const { config } = checked(await sdk.agents.config({ agentId, scope: 'own' }));
      if (!record(config)) throw new Error('Invalid config');
      const latest = await resolveRole(role);
      if (latest.agent?.id !== agentId || latest.state !== binding.state || latest.mapped !== binding.mapped) conflict();
      const explicit = Object.hasOwn(config, 'tool_call_mode');
      const explicitMode = ROLE_TOOL_MODES.includes(config.tool_call_mode) ? config.tool_call_mode : null;
      const legacyLightweightTools = typeof config.lightweight_tools === 'boolean' ? config.lightweight_tools : null;
      const app = config.extensions?.app?.[APP_ID];
      return { role, agentId, resolvedMode: explicit ? explicitMode : legacyLightweightTools === false ? 'full' : 'standard',
        modeSource: explicit ? explicitMode ? 'explicit' : 'invalid' : legacyLightweightTools === null ? 'default' : 'legacy',
        explicitMode: explicit ? explicitMode : null, legacyLightweightTools,
        appEnabled: typeof app?.enabled === 'boolean' ? app.enabled : true,
        ...(role === 'explorer' ? { businessTools: [] } : {}),
        disabledTools: toolNames.filter((name) => app?.tools?.[name] === false) };
    } catch (error) { throw hostError(error); }
  }
  async function setRoleToolMode(role, expectedAgentId, toolMode) {
    const key = target('role', role);
    if (typeof expectedAgentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(expectedAgentId)
      || !ROLE_TOOL_MODES.includes(toolMode)) fail('INVALID_INPUT', '需要角色实例及明确工具模式。', 400);
    return serial(key, async () => {
      let attempted = false, applied = false;
      try {
        const before = await getRoleToolStatus(role);
        if (before.agentId !== expectedAgentId) conflict();
        if (before.resolvedMode === toolMode) return { saved: true, changed: false, sessionEffect: 'new-session-required', previousMode: before.resolvedMode, status: before };
        // A narrow host write, not a config replacement. Never clone or repair a binding.
        attempted = true;
        checked(await sdk.agents.updateConfig({ agentId: expectedAgentId, scope: 'own', partial: { tool_call_mode: toolMode } }));
        const after = await getRoleToolStatus(role);
        if (after.agentId !== expectedAgentId) conflict();
        if (after.explicitMode !== toolMode) fail('SAVE_NOT_CONFIRMED', '工具模式写后未确认。', 502);
        applied = true;
        return { saved: true, changed: true, sessionEffect: 'new-session-required', previousMode: before.resolvedMode, status: after };
      } catch (error) {
        // Host errors can follow persistence. Observe once, without retry or rollback.
        if (attempted && !applied) {
          try { const after = await getRoleToolStatus(role); applied = after.agentId === expectedAgentId && after.explicitMode === toolMode; } catch { /* unknown */ }
        }
        const result = hostError(error);
        result.applied = applied ? ['tool_call_mode'] : [];
        result.writeState = attempted ? applied ? 'confirmed' : 'unconfirmed' : 'not-attempted';
        throw result;
      }
    });
  }
  async function template(id) {
    const { role } = checked(await sdk.roles.get({ roleId: id }));
    if (role?.appId !== APP_ID || role.roleId !== id || typeof role.agent?.name !== 'string' || typeof role.prompts?.identity !== 'string' || typeof role.prompts?.agents !== 'string') throw new Error('Invalid role template');
    return { name: role.agent.name, latinName: '', model: null, identity: decodeText(role.prompts.identity), agentsMd: decodeText(role.prompts.agents) };
  }
  async function persona(agentId, field) {
    const ref = { kind: 'agent', name: agentId, path: FILES[field] };
    const before = checked(await sdk.resources.stat(ref));
    if (typeof before.exists !== 'boolean' || before.isDirectory) throw new Error('Invalid resource stat');
    if (before.version?.size > TEXT_LIMIT) fail('RESOURCE_TOO_LARGE', '人格文件超过 128 KiB。', 413);
    const result = checked(await sdk.resources.read(ref));
    const after = checked(await sdk.resources.stat(ref));
    const version = versionOf(result.version);
    if (before.exists !== after.exists || !equal(versionOf(before.version), versionOf(after.version)) || (after.exists && (!version || !equal(version, versionOf(after.version))))) fail('CONFLICT', '人格文件在读取期间改变，请重新打开。', 409);
    return { text: decodeText(result.content), version, exists: after.exists, source: result.metadata?.fromTemplate === true ? 'template' : 'agent' };
  }
  async function agentSnapshot(kind, id, agent) {
    const input = { agentId: agent.id, ...(kind === 'assistant' ? { scope: 'all' } : {}) };
    const { config } = checked(await sdk.agents.config(input));
    if (!record(config)) throw new Error('Invalid config');
    const docs = {};
    for (const field of Object.keys(FILES)) docs[field] = await persona(agent.id, field);
    return {
      agentId: agent.id, name: typeof config.agent?.name === 'string' ? config.agent.name : agent.name,
      latinName: typeof config.agent?.latinName === 'string' ? config.agent.latinName : '', model: modelRef(config.models?.chat),
      identity: docs.identity.text, agentsMd: docs.agentsMd.text, docs,
    };
  }
  async function snapshot(kind, id) {
    target(kind, id);
    let state; let data;
    if (kind === 'assistant') {
      const agents = rows(await sdk.agents.list({ scope: 'all', lifecycle: 'active' }), 'agents');
      const matches = agents.filter((agent) => agent?.id === id);
      if (!matches.length) fail('NOT_FOUND', '助手不存在或已退役。', 404);
      if (matches.length !== 1 || !publicAssistant(matches[0])) fail('FORBIDDEN', '只能编辑公开的活跃用户助手。', 403);
      data = await agentSnapshot(kind, id, matches[0]);
      state = 'active';
    } else {
      const binding = await resolveRole(id); state = binding.state;
      data = binding.agent ? await agentSnapshot(kind, id, binding.agent) : { ...await template(id), agentId: null, docs: {} };
    }
    const models = rows(await sdk.models.listAvailable(), 'models').filter((model) => modelRef(model)).map((model) => ({ ...modelRef(model), name: typeof model.name === 'string' ? model.name : model.id }));
    const image = await avatar(kind, id);
    return { kind, id, ...data, ...image, models, isPreset: data.agentId === null, instanceState: state };
  }
  function issue(data) {
    prune();
    const revision = randomUUID();
    revisions.set(revision, { key: target(data.kind, data.id), data: structuredClone(data), expires: now() + ttl });
    const { docs, ...editor } = data;
    return { ...editor, revision, personaSources: Object.fromEntries(Object.keys(FILES).map((field) => [field, docs[field]?.source || 'template'])) };
  }
  async function get(kind, id) {
    try { return issue(await snapshot(kind, id)); } catch (error) { throw hostError(error); }
  }
  function conflict() { fail('CONFLICT', '此字段或成员绑定已在别处改变，请重新打开编辑器后再保存。', 409); }
  function checkPersonaWrite(doc) {
    if (doc.exists ? !doc.version : doc.source !== 'template') fail('VERSION_UNAVAILABLE', '人格文件缺少版本或未确认来自宿主模板。', 409);
  }
  function preflight(base, latest, fields, imageChanged) {
    if (base.agentId !== latest.agentId || base.instanceState !== latest.instanceState) conflict();
    for (const field of fields) {
      if (!equal(base[field], latest[field])) conflict();
      if (FILES[field] && base.agentId !== null) {
        if (!equal(base.docs[field], latest.docs[field])) conflict();
        checkPersonaWrite(latest.docs[field]);
      }
    }
    if (imageChanged && !equal([base.avatarUrl, base.avatarSource], [latest.avatarUrl, latest.avatarSource])) conflict();
  }
  async function mutate(applied, operation, observe) {
    try { return await operation(); }
    catch (error) {
      // A host hook/IPC failure can follow persistence. Re-read narrowly to report
      // confirmed effects, but never turn an error into success or roll back.
      try {
        const confirmed = await observe();
        for (const field of confirmed) if (!applied.includes(field)) applied.push(field);
      } catch { /* Read permission/transport may also be unavailable: effects remain unconfirmed. */ }
      throw error;
    }
  }
  async function ensureInstance(id, applied, initialModel) {
    if (id === 'explorer') {
      const binding = await resolveRole(id);
      if (binding.agent) return binding.agent;
      if (binding.state !== 'preset') fail('EXPLORER_UNAVAILABLE', 'Explorer saved instance is missing or retired; no replacement.', 409);
      const contract = await readExplorerContract();
      const role = checked(await sdk.roles.get({ roleId: id })).role;
      if (role?.appId !== APP_ID || role.roleId !== id
        || typeof role.prompts?.agents !== 'string' || typeof role.prompts?.identity !== 'string'
        || role.prompts.agents.trim() !== contract.card.prompts.agents.trim()
        || role.prompts.identity.trim() !== contract.card.prompts.identity.trim()) fail('EXPLORER_CONTRACT_INVALID', 'Explorer role template is not confirmed.', 409);
      const row = await createExplorerInstance(sdk, { initialModel, contract: contract.binding });
      applied.push('instance', 'binding'); return row;
    }
    let binding = await resolveRole(id);
    if (!binding.agent && ['retired', 'missing'].includes(binding.state)) {
      const candidates = rows(await sdk.agents.list({ lifecycle: 'all' }), 'agents').filter((agent) => recoverable(agent, id));
      if (candidates.length > 1) fail('AMBIGUOUS_INSTANCE', '存在多个可恢复实例，未自动选择。', 409);
      if (candidates.length) binding = { agent: candidates[0], mapped: false };
    }
    if (!binding.agent) {
      const own = rows(await sdk.agents.list({ lifecycle: 'all' }), 'agents');
      const baseId = `hana-math-${id}`;
      const occupied = own.find((agent) => agent?.id === baseId);
      if (occupied && !ownRole(occupied, id)) fail('CONFLICT', '实例 ID 已被其他 Agent 占用，未修改它。', 409);
      const agentId = occupied ? `${baseId}-${randomUUID()}` : baseId;
      const result = await mutate(applied,
        async () => checked(await sdk.agents.createFromRole({ roleId: id, id: agentId, importMemory: false })),
        async () => rows(await sdk.agents.list({ lifecycle: 'all' }), 'agents').some((agent) => agent.id === agentId && recoverable(agent, id)) ? ['instance'] : []);
      applied.push('instance');
      if (result.agent?.id !== agentId) throw new Error('Unexpected created agent ID');
      const verify = rows(await sdk.agents.list({ lifecycle: 'all' }), 'agents').find((agent) => agent?.id === agentId);
      if (!ownRole(verify, id) || !active(verify)) throw new Error('Created agent ownership not verified');
      binding = { agent: verify, mapped: false };
    }
    if (!binding.mapped) {
      const value = { agentId: binding.agent.id };
      await mutate(applied, () => sdk.storage.global.set(bindingKey(id), value),
        async () => equal(await sdk.storage.global.get(bindingKey(id), null), value) ? ['binding'] : []);
      applied.push('binding');
    }
    return binding.agent;
  }
  async function save(kind, id, raw) {
    const key = target(kind, id);
    const input = validateInput(raw);
    return serial(key, async () => {
      const applied = [];
      try {
        if (!input.model) fail('MODEL_REQUIRED', '请明确选择一个当前可用模型。', 400);
        const entry = revisions.get(input.revision);
        if (!entry || entry.expires <= now() || entry.key !== key) conflict();
        const base = entry.data;
        const fields = FIELDS.filter((field) => !equal(input[field], base[field]));
        const imageChanged = Object.hasOwn(input, 'avatarDataUrl') && input.avatarDataUrl !== base.avatarUrl;
        let latest = await snapshot(kind, id);
        preflight(base, latest, base.agentId === null ? FIELDS : fields, imageChanged);
        if (fields.includes('model') && input.model !== null && !latest.models.some((model) => equal(modelRef(model), input.model))) fail('INVALID_MODEL', '所选模型不在当前 Hana 可用目录中。', 400);
        if (kind === 'role' && (latest.agentId === null || latest.instanceState === 'recovered')) {
          const agent = await ensureInstance(id, applied, input.model);
          latest = { ...latest, ...await agentSnapshot(kind, id, agent), instanceState: 'active' };
        }
        // New role instances must persist the selected model explicitly, even if the host
        // supplied the same value while creating the instance.
        const dirty = (base.agentId === null ? FIELDS : fields).filter((field) => !equal(input[field], latest[field]));
        if (kind === 'role' && base.agentId === null && !dirty.includes('model')) dirty.push('model');
        for (const field of dirty) {
          if (FILES[field]) checkPersonaWrite(latest.docs[field]);
        }
        const scope = kind === 'assistant' ? { scope: 'all' } : {};
        const agentInput = { agentId: latest.agentId, ...scope };
        if (dirty.includes('name')) {
          const current = await snapshot(kind, id);
          if (current.agentId !== latest.agentId || current.name !== latest.name) conflict();
          await mutate(applied, async () => checked(await sdk.agents.update({ ...agentInput, name: input.name })), async () => {
            const { config } = checked(await sdk.agents.config(agentInput));
            return config?.agent?.name === input.name ? ['name'] : [];
          });
          applied.push('name');
        }
        const configFields = dirty.filter((field) => ['latinName', 'model'].includes(field));
        if (configFields.length) {
          const current = await snapshot(kind, id);
          if (current.agentId !== latest.agentId || configFields.some((field) => !equal(current[field], latest[field]))) conflict();
          if (configFields.includes('model') && input.model !== null && !current.models.some((model) => equal(modelRef(model), input.model))) fail('INVALID_MODEL', '所选模型已不在 Hana 可用目录中。', 400);
          const partial = {};
          if (configFields.includes('latinName')) partial.agent = { latinName: input.latinName || null, latinNameSource: input.latinName ? 'user' : null };
          // Host saveConfig/deepMerge removes keys on null (bundle ZMe / Wo).
          if (configFields.includes('model')) partial.models = { chat: input.model };
          await mutate(applied, async () => checked(await sdk.agents.updateConfig({ ...agentInput, partial })), async () => {
            const { config } = checked(await sdk.agents.config(agentInput));
            const values = { latinName: config?.agent?.latinName || '', model: modelRef(config?.models?.chat) };
            return configFields.filter((field) => equal(values[field], input[field]));
          });
          applied.push(...configFields);
        }
        for (const field of Object.keys(FILES).filter((field) => dirty.includes(field))) {
          const current = await snapshot(kind, id);
          if (current.agentId !== latest.agentId || !equal(current.docs[field], latest.docs[field])) conflict();
          const doc = latest.docs[field];
          const ref = { kind: 'agent', name: latest.agentId, path: FILES[field] };
          if (!doc.exists && !equal(await persona(latest.agentId, field), doc)) conflict();
          // ResourceIO has no create-if-absent. Template materialization uses the
          // nearest absence/content check plus write/readback, not an atomic CAS.
          const result = await mutate(applied, async () => {
            const written = doc.exists
              ? await sdk.resources.writeExpectedVersion(ref, input[field], doc.version)
              : await sdk.resources.write(ref, input[field]);
            if (written?.conflict) return written;
            return checked(written);
          }, async () => {
            const observed = await persona(latest.agentId, field);
            return observed.exists && observed.source === 'agent' && observed.text === input[field] ? [field] : [];
          });
          if (result?.conflict) conflict();
          applied.push(field);
          if (!versionOf(result.version)) throw new Error('Missing resource write version');
        }
        if (imageChanged) {
          const current = await avatar(kind, id);
          if (!equal(current, { avatarUrl: latest.avatarUrl, avatarSource: latest.avatarSource })) conflict();
          await mutate(applied, () => sdk.storage.global.set(avatarKey(kind, id), input.avatarDataUrl),
            async () => (await avatar(kind, id)).avatarUrl === input.avatarDataUrl ? ['avatar'] : []);
          applied.push('avatar');
        }
        const saved = await snapshot(kind, id);
        if (dirty.some((field) => !equal(saved[field], input[field])) || (imageChanged && saved.avatarUrl !== input.avatarDataUrl)) fail('SAVE_NOT_CONFIRMED', '宿主保存后的值与草稿不一致，请重新读取。', 502);
        revisions.delete(input.revision);
        return issue(saved);
      } catch (error) {
        const failure = hostError(error);
        if (applied.length) {
          revisions.delete(input.revision);
          throw new ProfileError('PARTIAL_SAVE', `部分字段已保存；${failure.message}`, failure.status === 403 ? 403 : failure.status === 409 ? 409 : 502, applied);
        }
        throw failure;
      }
    });
  }
  async function getExplorerSelection() {
    return serial('role:explorer', async () => {
      try {
        const contract = await readExplorerContract();
        let before = await resolveRole('explorer');
        if (!before.agent) {
          if (before.state !== 'preset') fail('EXPLORER_UNAVAILABLE', 'Explorer binding is unavailable; no repair.', 409);
          const main = await getRoleModel('main');
          await ensureInstance('explorer', [], main.model);
          before = await resolveRole('explorer');
        }
        const selected = await getRoleModel('explorer'), row = before.agent;
        if (!ownRole(row, 'explorer')) fail('EXPLORER_UNAVAILABLE', 'Explorer ownership is not confirmed.', 409);
        const memory = await readExplorerMemoryProfile(sdk, row.id);
        const docs = await agentSnapshot('role', 'explorer', row);
        const latest = await getRoleModel('explorer');
        if (selected.agentId !== row.id || latest.agentId !== selected.agentId || !equal(selected.model, latest.model) || !equal(docs.model, selected.model)) conflict();
        const catalog = rows(await sdk.models.listAvailable(), 'models');
        if (!catalog.some(m => equal(modelRef(m), selected.model))) fail('MODEL_NOT_AVAILABLE', 'Explorer saved model is unavailable.', 409);
        const confirmedDocs = await agentSnapshot('role', 'explorer', row);
        if (!equal(confirmedDocs, docs)) conflict();
        const current = await resolveRole('explorer');
        if (current.agent?.id !== row.id || !equal(await readExplorerMemoryProfile(sdk, row.id), memory)) conflict();
        return { schemaVersion: 1, state: 'available', role: 'explorer', agentId: selected.agentId, model: selected.model,
          contract: { ...contract.binding, ...explorerPersonaBinding(docs.identity, docs.agentsMd) },
          selectionEvidence: 'saved-role-config-and-persona-readback', actualChildModel: 'unknown', nativeLaunchSupport: 'unverified' };
      } catch (error) { throw hostError(error); }
    });
  }
  return { get, save, avatar, roleBindings, getRoleModel, getRoleToolStatus, setRoleToolMode, getExplorerSelection };
}

const services = new WeakMap();
export function profileService(sdk) {
  if (!services.has(sdk)) services.set(sdk, createProfileService(sdk));
  return services.get(sdk);
}
export async function editorResponse(context, action) {
  try { return context.json({ ok: true, editor: await action() }); }
  catch (error) {
    const failure = hostError(error);
    return context.json({ ok: false, error: { code: failure.code, message: failure.message, ...(failure.applied ? { applied: failure.applied } : {}) } }, failure.status);
  }
}
export function registerEditors(app, service) {
  for (const kind of ['assistant', 'role']) {
    app.get(`/editor/${kind}/:id`, (context) => editorResponse(context, () => service.get(kind, context.req.param('id'))));
    app.post(`/editor/${kind}/:id`, (context) => editorResponse(context, async () => {
      const contentLength = Number(context.req.header?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) fail('INVALID_INPUT', '保存请求过大。', 413);
      let input;
      try {
        const text = await context.req.text();
        if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) fail('INVALID_INPUT', '保存请求过大。', 413);
        input = JSON.parse(text);
      } catch (error) {
        if (error instanceof ProfileError) throw error;
        fail('INVALID_INPUT', '保存请求必须是 JSON。', 400);
      }
      return service.save(kind, context.req.param('id'), input);
    }));
  }
}
