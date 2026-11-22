import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RESEARCH_ROLE_TOOLS, RESEARCH_IO_TOOLS } from '../packages/hana-math/research-bindings.mjs';
import { readExplorerContract } from '../packages/hana-math/explorer-profile.mjs';
const explorerCard = JSON.parse(readFileSync(new URL('../packages/hana-math/roles/explorer/card.json', import.meta.url)));
import { createProfileService, editorResponse, registerEditors, validateAvatar } from '../packages/hana-math/profile-service.mjs';
import { createAppSdk } from '../packages/hana-math/sdk/app-contract/server-client.js';
import { loadPanel } from '../packages/hana-math/panel-service.mjs';
import { createProjectMainSession } from '../packages/hana-math/project-main-session.mjs';

const clone = (value) => structuredClone(value);
const publicAgent = (id, extra = {}) => ({ id, name: id, state: 'active', deletedAt: null, visibility: 'public', ownerPluginId: null, plugin: { visibility: 'public', ownerPluginId: null }, ...extra });
const ownAgent = (id, roleId, extra = {}) => ({ ...publicAgent(id), visibility: 'plugin_private', ownerPluginId: 'hana-math', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'role', roleId }, ...extra });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMiwAAAAASUVORK5CYII=';
const draft = (editor, extra = {}) => ({ revision: editor.revision, name: editor.name, latinName: editor.latinName, model: editor.model || (editor.kind === 'role' ? { provider: 'p', id: 'm' } : null), identity: editor.identity, agentsMd: editor.agentsMd, ...extra });

// These fixtures follow the inspected public host implementation: ResourceIO read
// returns {content, version, metadata}; stat returns {exists, isDirectory, version};
// mutation returns {changeType, version}, or {ok:false, conflict:true, version}.
function fixture() {
  const calls = []; const store = new Map(); const agents = new Map(); const configs = new Map(); const files = new Map(); const profiles = new Map();
  const hooks = {}; let clock = 0;
  const models = [{ provider: 'p', id: 'm', name: 'Model', apiKey: 'DO_NOT_LEAK' }, { provider: 'q', id: 'n', name: 'Other' }];
  const roles = new Map(['main', 'worker', 'verifier'].map((id) => [id, { roleId: id, appId: 'hana-math', agent: { name: id }, prompts: { identity: `${id} identity`, agents: `${id} agents`, publicAgents: 'not editable' } }]));
  roles.set('explorer', { roleId: 'explorer', appId: 'hana-math', agent: explorerCard.agent,
    prompts: { ...explorerCard.prompts, agents: explorerCard.prompts.agents.trim(), identity: explorerCard.prompts.identity.trim() } });
  const fileKey = (ref) => `${ref.name}/${ref.path}`;
  function putFile(id, path, text) { files.set(`${id}/${path}`, { content: text, version: { mtimeMs: ++clock, size: Buffer.byteLength(text) } }); }
  function add(agent) {
    const { memoryPolicy = { enabled: true }, ...row } = agent;
    agents.set(agent.id, clone(row));
    profiles.set(agent.id, { id: agent.id, name: agent.name, yuan: agent.yuan || 'kong', ownerPluginId: agent.ownerPluginId, visibility: agent.visibility,
      identity: `${agent.id} identity`, description: '', memoryPolicy: clone(memoryPolicy), experiencePolicy: { enabled: false }, toolPolicy: { disabled: [] }, models: {} });
    configs.set(agent.id, { agent: { name: agent.name, latinName: 'Original', latinNameSource: 'user' }, models: { chat: { provider: 'p', id: 'm' }, utility: { provider: 'hidden', id: 'utility' } }, api: { api_key: 'MASKED_SECRET' }, unrelated: { keep: true } });
    putFile(agent.id, 'identity.md', `${agent.id} identity`); putFile(agent.id, 'AGENTS.md', `${agent.id} agents`);
  }
  function refCheck(ref) {
    assert.equal(ref.kind, 'agent'); assert.ok(['identity.md', 'AGENTS.md'].includes(ref.path));
    assert.deepEqual(Object.keys(ref), ['kind', 'name', 'path']);
  }
  async function invoke(verb, input) {
    calls.push([verb, clone(input)]);
    if (hooks[verb]) { const result = await hooks[verb](input); if (result !== undefined) return result; }
    if (verb === 'agent:list') return { agents: [...agents.values()].filter((agent) => (input?.scope === 'all' || agent.ownerPluginId === 'hana-math') && (input?.lifecycle === 'all' || agent.state === 'active')).map(clone) };
    if (verb === 'agent:profile') {
      assert.deepEqual(input, { agentId: input.agentId, scope: 'own' });
      return { profile: clone(profiles.get(input.agentId) ?? null) };
    }
    if (verb === 'agent:config') return configs.has(input.agentId) ? { config: clone(configs.get(input.agentId)) } : { error: 'agent_not_found' };
    if (verb === 'role:get') return { role: clone(roles.get(input.roleId)) };
    if (verb === 'role:list') return { roles: clone([...roles.values()]) };
    if (verb === 'model:list') return { models: clone(models) };
    if (verb === 'agent:create-from-role') {
      assert.deepEqual(Object.keys(input), ['roleId', 'id', 'importMemory']); assert.equal(input.importMemory, false);
      if (agents.has(input.id)) throw new Error('Agent already exists');
      add(ownAgent(input.id, input.roleId, { name: roles.get(input.roleId).agent.name, ...(input.roleId === 'explorer' ? { memoryPolicy: { enabled: true } } : {}) }));
      configs.get(input.id).agent.latinName = '';
      putFile(input.id, 'identity.md', roles.get(input.roleId).prompts.identity);
      putFile(input.id, 'AGENTS.md', roles.get(input.roleId).prompts.agents);
      return { agent: { id: input.id, ownerPluginId: 'hana-math', visibility: 'plugin_private', roleId: input.roleId } };
    }
    if (verb === 'agent:update') {
      if (input.memoryPolicy) {
        assert.deepEqual(Object.keys(input), ['agentId', 'memoryPolicy']); assert.equal(agents.get(input.agentId).plugin.roleId, 'explorer');
        profiles.get(input.agentId).memoryPolicy = clone(input.memoryPolicy); return { ok: true, agent: clone(profiles.get(input.agentId)) };
      }
      assert.deepEqual(Object.keys(input).sort(), (input.scope ? ['agentId', 'scope', 'name'] : ['agentId', 'name']).sort());
      configs.get(input.agentId).agent.name = input.name; agents.get(input.agentId).name = input.name;
      return { agent: { id: input.agentId, name: input.name } };
    }
    if (verb === 'agent:update-config') {
      const config = configs.get(input.agentId);
      if (Object.hasOwn(input.partial, 'tool_call_mode')) config.tool_call_mode = input.partial.tool_call_mode;
      if (input.partial.agent) for (const [key, value] of Object.entries(input.partial.agent)) { if (value === null) delete config.agent[key]; else config.agent[key] = value; }
      if (input.partial.models) { if (input.partial.models.chat === null) delete config.models.chat; else config.models.chat = clone(input.partial.models.chat); }
      return { config: clone(config) };
    }
    throw new Error(`Unexpected operation ${verb}`);
  }
  const context = {
    dataDir: '/unused/app-data', bus: { request: invoke }, models: {}, tools: {}, hooks: {}, media: {}, providers: {},
    storage: { global: {
      async get(key, fallback) { calls.push(['storage.get', key]); return clone(store.has(key) ? store.get(key) : fallback); },
      async set(key, value) { calls.push(['storage.set', key, clone(value)]); if (hooks['storage.set']) await hooks['storage.set'](key, value); store.set(key, clone(value)); },
    } },
    resources: {
      async stat(ref) {
        refCheck(ref); calls.push(['resources.stat', clone(ref)]);
        if (hooks.stat) await hooks.stat(ref);
        const file = files.get(fileKey(ref));
        return file ? { exists: true, isDirectory: false, version: clone(file.version) } : { exists: false, isDirectory: false };
      },
      async read(ref) {
        refCheck(ref); calls.push(['resources.read', clone(ref)]);
        if (hooks.read) { const result = await hooks.read(ref); if (result !== undefined) return result; }
        const file = files.get(fileKey(ref));
        return file ? { content: Buffer.from(file.content).toJSON(), version: clone(file.version), metadata: { fromTemplate: false } } : { content: Buffer.from('Host fallback'), metadata: { fromTemplate: true } };
      },
      async write(ref, content) {
        refCheck(ref); calls.push(['resources.write', clone(ref), content]);
        if (hooks.writeUnversioned) { const result = await hooks.writeUnversioned(ref, content); if (result !== undefined) return result; }
        const existed = files.has(fileKey(ref));
        putFile(ref.name, ref.path, content);
        return { changeType: existed ? 'modified' : 'created', version: clone(files.get(fileKey(ref)).version) };
      },
      async writeExpectedVersion(ref, content, expectedVersion) {
        refCheck(ref); calls.push(['resources.writeExpectedVersion', clone(ref), content, clone(expectedVersion)]);
        if (hooks.write) { const result = await hooks.write(ref, content, expectedVersion); if (result !== undefined) return result; }
        const file = files.get(fileKey(ref));
        if (JSON.stringify(file?.version) !== JSON.stringify(expectedVersion)) return { ok: false, conflict: true, version: clone(file?.version) };
        putFile(ref.name, ref.path, content);
        return { changeType: 'modified', version: clone(files.get(fileKey(ref)).version) };
      },
    },
  };
  // Use the unmodified official SDK, not invented app-domain wrappers.
  const sdk = createAppSdk(context);
  const service = createProfileService(sdk);
  add(publicAgent('shiraha')); add(publicAgent('second'));
  return { sdk, service, context, calls, store, agents, configs, files, profiles, models, roles, hooks, add, putFile };
}
test('derived explorer quotes pinned originals without changing original roles or granting business tools', async () => {
  const contract = await readExplorerContract();
  assert.equal(contract.binding.originals.length, 2); assert.equal(explorerCard.skills, undefined);
  assert.deepEqual(Object.keys(RESEARCH_ROLE_TOOLS), ['main', 'worker', 'verifier']); assert.deepEqual(Object.keys(RESEARCH_IO_TOOLS), ['main', 'worker', 'verifier']);
  for (const [file, pin] of [['roles/main/card.json', '34c08fe28c2d0771918e4d8fbf6df0e70917a224eea69ea1fc142e2af47dd072'], ['roles/worker/card.json', '1419ef74aa96e092e2fbd28b4daa6b7cc3362db7afb7d0f55fb2fd95238acf8b'], ['roles/verifier/card.json', '16ad1ca9cc77bf287157feb8a0d28fe9685e3254836a08ae046f5d79376dff19'], ['prompt-sources.json', 'ea6302bd128da92b84750a21e41630f97e06c461d912b1dab07b2d105642c53d'], ['reference-sources.json', '3a099ae45a74c42dac83b4c6268bfdc470f665b1fb20305807ebed6aaae72ee1']]) {
    assert.equal(createHash('sha256').update(readFileSync(new URL('../packages/hana-math/' + file, import.meta.url))).digest('hex'), pin);
  }
  assert.match(explorerCard.prompts.agents, /derived Hana role/); assert.match(explorerCard.prompts.agents, /not an upstream standalone explorer file/);
  assert.match(explorerCard.prompts.agents, /Subagents are speculative/); assert.match(explorerCard.prompts.agents, /Text-only mathematics is absolute/);
  const f = fixture(); f.add(ownAgent('hana-math-explorer', 'explorer', { memoryPolicy: { enabled: false } }));
  f.store.set('profile.role.explorer', { agentId: 'hana-math-explorer' });
  const status = await f.service.getRoleToolStatus('explorer'); assert.deepEqual(status.businessTools, []); assert.deepEqual(status.disabledTools, []);
  await assert.rejects(f.service.getRoleToolStatus('explorer', { additionalAppTools: ['gm_add'] }), { code: 'INVALID_INPUT' });
});
test('explorer first creation durably binds a distinct owned memory-off instance using saved main model only', async () => {
  const f = fixture();
  assert.notEqual(f.roles.get('explorer').prompts, explorerCard.prompts);
  assert.equal(f.roles.get('explorer').prompts.agents, explorerCard.prompts.agents.trim());
  assert.match(explorerCard.prompts.agents, /\n$/);
  assert.notEqual(f.roles.get('explorer').prompts.agents, explorerCard.prompts.agents);
  assert.equal(f.roles.get('explorer').prompts.identity, explorerCard.prompts.identity.trim());
  assert.equal(f.roles.get('explorer').prompts.identity, explorerCard.prompts.identity);
  f.add(ownAgent('hana-math-main', 'main')); f.store.set('profile.role.main', { agentId: 'hana-math-main' });
  f.configs.get('hana-math-main').models.chat = { provider: 'q', id: 'n' };
  f.add(ownAgent('hana-math-worker', 'worker')); f.add(ownAgent('hana-math-verifier', 'verifier'));
  const before = clone([...f.configs]);
  const selections = await Promise.all([f.service.getExplorerSelection(), f.service.getExplorerSelection()]);
  const e = selections[0]; assert.equal(e.state, 'available'); assert.notEqual(e.agentId, 'hana-math-main'); assert.deepEqual(e.model, { provider: 'q', id: 'n' });
  assert.equal(e.actualChildModel, 'unknown'); assert.equal(e.nativeLaunchSupport, 'unverified');
  const markerAt = f.calls.findIndex(c => c[0] === 'storage.set' && c[1] === 'profile.explorer.creation');
  const createAt = f.calls.findIndex(c => c[0] === 'agent:create-from-role'); assert.ok(markerAt >= 0 && markerAt < createAt);
  assert.equal(f.calls.filter(c => c[0] === 'agent:create-from-role').length, 1);
  assert.equal(f.profiles.get(e.agentId).memoryPolicy.enabled, false);
  assert.equal(Object.hasOwn(f.agents.get(e.agentId), 'memoryPolicy'), false);
  const bindAt = f.calls.findIndex(c => c[0] === 'storage.set' && c[1] === 'profile.role.explorer');
  const reads = f.calls.slice(createAt, bindAt).filter(c => c[0] === 'agent:profile'); assert.equal(reads.length, 2);
  for (const [, input] of reads) assert.deepEqual(input, { agentId: e.agentId, scope: 'own' }); assert.equal(f.agents.get(e.agentId).plugin.roleId, 'explorer');
  for (const [id, config] of before) assert.deepEqual(f.configs.get(id), config);
  const editor = await f.service.get('role', 'explorer');
  await f.service.save('role', 'explorer', draft(editor, { model: { provider: 'p', id: 'm' }, agentsMd: editor.agentsMd + '\nExplicit user note.\n' }));
  const writesBefore = writes(f).length, current = await f.service.getExplorerSelection();
  assert.deepEqual(current.model, { provider: 'p', id: 'm' }); assert.notEqual(current.contract.configuredContractSha256, current.contract.adapterContractSha256);
  assert.equal(writes(f).length, writesBefore); assert.equal(f.store.get('profile.explorer.creation').state, 'ready');
});
test('explorer loaded prompt body changes are rejected before creation marker or binding writes', async () => {
  for (const field of ['agents', 'identity']) {
    const f = fixture(); f.add(ownAgent('hana-math-main', 'main')); f.store.set('profile.role.main', { agentId: 'hana-math-main' });
    f.roles.get('explorer').prompts[field] += '\nAltered contract body.';
    await assert.rejects(f.service.getExplorerSelection(), { code: 'EXPLORER_CONTRACT_INVALID' });
    assert.equal(f.calls.some(c => c[0] === 'agent:create-from-role'), false);
    for (const key of ['profile.explorer.creation', 'profile.role.explorer']) {
      assert.equal(f.store.has(key), false);
      assert.equal(f.calls.some(c => c[0] === 'storage.set' && c[1] === key), false);
    }
  }
});
test('unknown explorer creation is never retried or duplicated, including after factory recreation', async () => {
  const f = fixture(); f.add(ownAgent('hana-math-main', 'main')); f.store.set('profile.role.main', { agentId: 'hana-math-main' });
  f.hooks['agent:create-from-role'] = input => { f.add(ownAgent(input.id, 'explorer', { memoryPolicy: { enabled: false } })); throw new Error('opaque lost creation receipt'); };
  await assert.rejects(f.service.getExplorerSelection());
  assert.equal(f.store.get('profile.explorer.creation').state, 'creating');
  await assert.rejects(f.service.getExplorerSelection(), { code: 'EXPLORER_CREATION_UNCONFIRMED' });
  await assert.rejects(createProfileService(f.sdk).getExplorerSelection(), { code: 'EXPLORER_CREATION_UNCONFIRMED' });
  assert.equal(f.calls.filter(c => c[0] === 'agent:create-from-role').length, 1);
});
test('explorer editor creates its own selected model without a configured main; initialization failure never retries', async () => {
  const f = fixture(), editor = await f.service.get('role', 'explorer');
  const saved = await f.service.save('role', 'explorer', draft(editor, { model: { provider: 'q', id: 'n' } }));
  assert.deepEqual(saved.model, { provider: 'q', id: 'n' }); assert.equal(f.profiles.get(saved.agentId).memoryPolicy.enabled, false);
  assert.equal(f.store.has('profile.role.main'), false);
  const g = fixture(); g.add(ownAgent('hana-math-main', 'main')); g.store.set('profile.role.main', { agentId: 'hana-math-main' });
  g.hooks['agent:update-config'] = () => { throw new Error('opaque initialization uncertainty'); };
  await assert.rejects(g.service.getExplorerSelection());
  await assert.rejects(createProfileService(g.sdk).getExplorerSelection(), { code: 'EXPLORER_CREATION_UNCONFIRMED' });
  assert.equal(g.calls.filter(c => c[0] === 'agent:create-from-role').length, 1); assert.equal(g.calls.filter(c => c[0] === 'agent:update-config').length, 1);
});
test('existing saved explorer is authoritative; missing retired bad model and unavailable main never trigger fallback', async () => {
  for (const state of ['active', 'retired', 'missing', 'bad-model']) {
    const f = fixture(), id = 'hana-math-explorer';
    if (state !== 'missing') f.add(ownAgent(id, 'explorer', { state: state === 'retired' ? 'retired' : 'active', memoryPolicy: { enabled: false } }));
    f.store.set('profile.role.explorer', { agentId: id });
    if (state === 'bad-model') delete f.configs.get(id).models.chat;
    if (state === 'active') { f.configs.get(id).models.chat = { provider: 'q', id: 'n' }; assert.deepEqual((await f.service.getExplorerSelection()).model, { provider: 'q', id: 'n' }); }
    else await assert.rejects(f.service.getExplorerSelection());
    assert.equal(writes(f).length, 0);
  }
  const f = fixture(); await assert.rejects(f.service.getExplorerSelection(), { code: 'ROLE_NOT_CONFIGURED' }); assert.equal(writes(f).length, 0);
});
function healthyBusinessRoles(f) {
  for (const role of ['main', 'worker', 'verifier']) {
    const id = `hana-math-${role}`; f.add(ownAgent(id, role)); f.store.set(`profile.role.${role}`, { agentId: id });
  }
}
for (const markerState of ['creating', 'unknown']) test(`panel retains healthy three roles with ${markerState} explorer marker; editor and selection stay fenced`, async () => {
  const f = fixture(); healthyBusinessRoles(f);
  const priorEditor = await f.service.get('role', 'explorer');
  f.store.set('profile.explorer.creation', { schemaVersion: 1, state: markerState, agentId: 'PRIVATE_PENDING_ID', error: 'PRIVATE_ERROR' });
  const before = clone({ store: f.store, configs: f.configs, profiles: f.profiles });
  const bindings = await f.service.roleBindings();
  assert.deepEqual(bindings.explorer, { agent: null, state: 'unavailable', errorCode: 'EXPLORER_CREATION_UNCONFIRMED' });
  const panel = await loadPanel(f.sdk); assert.equal(panel.roles.state, 'ready'); assert.equal(panel.roles.items.length, 4);
  for (const role of ['main', 'worker', 'verifier']) {
    const item = panel.roles.items.find(i => i.id === role); assert.equal(item.agentId, `hana-math-${role}`);
    assert.equal((await f.service.get('role', role)).agentId, item.agentId);
  }
  const item = panel.roles.items.find(i => i.id === 'explorer'); assert.equal(item.agentId, null); assert.equal(item.state, 'unavailable'); assert.equal(item.errorCode, 'EXPLORER_CREATION_UNCONFIRMED');
  assert.doesNotMatch(JSON.stringify(panel), /PRIVATE_PENDING_ID|PRIVATE_ERROR/);
  await assert.rejects(f.service.get('role', 'explorer'), { code: 'EXPLORER_CREATION_UNCONFIRMED' });
  await assert.rejects(f.service.save('role', 'explorer', draft(priorEditor)), { code: 'EXPLORER_CREATION_UNCONFIRMED' });
  await assert.rejects(f.service.getExplorerSelection(), { code: 'EXPLORER_CREATION_UNCONFIRMED' });
  assert.equal(writes(f).length, 0); assert.deepEqual({ store: f.store, configs: f.configs, profiles: f.profiles }, before);
});
test('panel remains available during in-flight explorer initialization without replaying creation', async () => {
  const f = fixture(); healthyBusinessRoles(f);
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.hooks['agent:create-from-role'] = async () => { entered(); await gate; };
  const selecting = f.service.getExplorerSelection();
  try {
    await started; const count = writes(f).length;
    const panel = await loadPanel(f.sdk); assert.equal(panel.roles.state, 'ready');
    assert.deepEqual(panel.roles.items.slice(0, 3).map(i => i.agentId), ['hana-math-main', 'hana-math-worker', 'hana-math-verifier']);
    assert.equal(panel.roles.items[3].state, 'unavailable'); assert.equal(panel.roles.items[3].agentId, null);
    await assert.rejects(createProfileService(f.sdk).getExplorerSelection(), { code: 'EXPLORER_CREATION_UNCONFIRMED' });
    await assert.rejects(f.service.get('role', 'explorer'), { code: 'EXPLORER_CREATION_UNCONFIRMED' });
    assert.equal(writes(f).length, count);
  } finally { release(); }
  const selected = await selecting; assert.equal(selected.state, 'available');
  assert.equal(f.calls.filter(c => c[0] === 'agent:create-from-role').length, 1);
  const panel = await loadPanel(f.sdk); assert.equal(panel.roles.items[3].agentId, selected.agentId); assert.notEqual(panel.roles.items[3].state, 'unavailable');
});
const invalidExplorerProfiles = [
  ['missing', () => null],
  ['wrong id', p => ({ ...p, id: 'another-explorer' })],
  ['foreign owner', p => ({ ...p, ownerPluginId: 'another-app' })],
  ['public', p => ({ ...p, visibility: 'public' })],
  ['missing memory', p => { delete p.memoryPolicy; return p; }],
  ['enabled memory', p => ({ ...p, memoryPolicy: { enabled: true } })],
  ['nonboolean memory', p => ({ ...p, memoryPolicy: { enabled: 'false' } })],
];
for (const [label, invalid] of invalidExplorerProfiles) {
  test(`saved explorer rejects ${label} own profile without changing any settings`, async () => {
    const f = fixture(), id = 'hana-math-explorer'; f.add(ownAgent(id, 'explorer', { memoryPolicy: { enabled: false } }));
    f.store.set('profile.role.explorer', { agentId: id });
    const before = clone({ configs: f.configs, profiles: f.profiles, files: f.files, store: f.store });
    f.hooks['agent:profile'] = input => { assert.deepEqual(input, { agentId: id, scope: 'own' }); return { profile: invalid(clone(f.profiles.get(id))) }; };
    await assert.rejects(f.service.getExplorerSelection());
    assert.equal(writes(f).length, 0); assert.deepEqual({ configs: f.configs, profiles: f.profiles, files: f.files, store: f.store }, before);
    const list = await f.sdk.agents.list({ lifecycle: 'all' }); for (const row of list.agents) assert.equal(Object.hasOwn(row, 'memoryPolicy'), false);
  });
  test(`first explorer creation with ${label} profile cannot publish binding or ready marker`, async () => {
    const f = fixture(); f.add(ownAgent('hana-math-main', 'main')); f.store.set('profile.role.main', { agentId: 'hana-math-main' });
    f.hooks['agent:profile'] = input => ({ profile: invalid(clone(f.profiles.get(input.agentId))) });
    await assert.rejects(f.service.getExplorerSelection());
    assert.equal(f.store.has('profile.role.explorer'), false); assert.equal(f.store.get('profile.explorer.creation').state, 'creating');
    await assert.rejects(createProfileService(f.sdk).getExplorerSelection(), { code: 'EXPLORER_CREATION_UNCONFIRMED' });
    assert.equal(f.calls.filter(c => c[0] === 'agent:create-from-role').length, 1);
  });
}
for (const point of ['persona', 'catalog', 'last-list']) test(`saved explorer rejects memory drift during ${point} readback without repair`, async () => {
  const f = fixture(), id = 'hana-math-explorer'; f.add(ownAgent(id, 'explorer', { memoryPolicy: { enabled: false } }));
  f.store.set('profile.role.explorer', { agentId: id }); let seenProfile = false;
  f.hooks['agent:profile'] = () => { seenProfile = true; };
  const drift = () => { if (seenProfile) f.profiles.get(id).memoryPolicy.enabled = true; };
  if (point === 'persona') f.hooks.read = drift;
  else if (point === 'catalog') f.hooks['model:list'] = drift;
  else { let lists = 0; f.hooks['agent:list'] = () => { if (seenProfile && ++lists === 2) drift(); }; }
  await assert.rejects(f.service.getExplorerSelection());
  assert.equal(f.profiles.get(id).memoryPolicy.enabled, true); assert.equal(writes(f).length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'agent:profile').length, 2);
});
test('first creation rechecks memory after model readback and keeps drifted initialization unconfirmed', async () => {
  const f = fixture(); f.add(ownAgent('hana-math-main', 'main')); f.store.set('profile.role.main', { agentId: 'hana-math-main' });
  let readMemory = false;
  f.hooks['agent:profile'] = () => { readMemory = true; };
  f.hooks['agent:config'] = input => { if (readMemory && input.agentId !== 'hana-math-main') f.profiles.get(input.agentId).memoryPolicy.enabled = true; };
  await assert.rejects(f.service.getExplorerSelection()); assert.equal(readMemory, true);
  assert.equal(f.store.has('profile.role.explorer'), false); assert.equal(f.store.get('profile.explorer.creation').state, 'creating');
  const marker = f.store.get('profile.explorer.creation'); assert.equal(f.profiles.get(marker.agentId).memoryPolicy.enabled, true);
  await assert.rejects(f.service.getExplorerSelection(), { code: 'EXPLORER_CREATION_UNCONFIRMED' });
  assert.equal(f.calls.filter(c => c[0] === 'agent:update').length, 1); assert.equal(f.calls.filter(c => c[0] === 'agent:create-from-role').length, 1);
});
const writes = (f) => f.calls.filter(([verb]) => ['agent:create-from-role', 'agent:update', 'agent:update-config', 'storage.set', 'resources.write', 'resources.writeExpectedVersion'].includes(verb));
const expectCode = async (promise, code, status) => assert.rejects(promise, (error) => error.code === code && (!status || error.status === status));

function assertRoleModelReadsOnly(f) {
  assert.deepEqual(writes(f), []);
  for (const [verb, input] of f.calls) {
    assert.ok(['agent:list', 'agent:config', 'storage.get'].includes(verb), `unexpected role-model operation: ${verb}`);
    if (verb === 'agent:list') assert.deepEqual(input, { lifecycle: 'all' });
    if (verb === 'agent:config') assert.deepEqual(Object.keys(input), ['agentId']);
    if (verb === 'storage.get') assert.match(input, /^profile\.role\.(main|worker|verifier)$/);
  }
}

test('tool status uses top-level mode and projects only fixed own App tool switches', async () => {
  const f = fixture(), id = 'hana-math-main'; f.add(ownAgent(id, 'main'));
  const config = f.configs.get(id);
  for (const [patch, expected, source] of [[{}, 'standard', 'default'], [{ lightweight_tools: true }, 'standard', 'legacy'], [{ lightweight_tools: false }, 'full', 'legacy'],
    ...['minimal', 'light', 'standard', 'full'].map((mode) => [{ tool_call_mode: mode }, mode, 'explicit']), [{ tool_call_mode: 'PRIVATE_BAD' }, null, 'invalid']]) {
    delete config.tool_call_mode; delete config.lightweight_tools; Object.assign(config, patch);
    config.tools = { mode: 'full' };
    config.extensions = { app: { 'hana-math': { enabled: true, tools: { gm_add: false, math_assign: false, math_project: false, read: false, web_search: false, web_fetch: false, wait_for_tasks: false, fact_search: 'false', privateSecret: false } } } };
    const status = await f.service.getRoleToolStatus('main');
    assert.equal(status.resolvedMode, expected); assert.equal(status.modeSource, source); assert.deepEqual(status.disabledTools, ['gm_add', 'math_assign']);
    assert.equal(status.appEnabled, true); assert.doesNotMatch(JSON.stringify(status), /PRIVATE|SECRET|privateSecret|models|identity|config/);
  }
  config.extensions.app['hana-math'].enabled = false; assert.equal((await f.service.getRoleToolStatus('main')).appEnabled, false);
  assert.deepEqual(writes(f), []);
  for (const [verb, input] of f.calls) if (verb === 'agent:config') assert.deepEqual(input, { agentId: id, scope: 'own' });
});

test('trusted extra App tools extend only the read projection; omitted options preserve every legacy role', async () => {
  for (const role of ['main', 'worker', 'verifier']) {
    const f = fixture(), id = `hana-math-${role}`; f.add(ownAgent(id, role));
    const config = f.configs.get(id), existing = role === 'verifier' ? 'search_arxiv_theorems' : 'gm_add';
    config.tool_call_mode = 'full';
    config.extensions = { app: { 'hana-math': { tools: { [existing]: false, math_project: false, read: false, web_search: false, web_fetch: false, wait_for_tasks: false } } } };
    const before = clone({ configs: f.configs, store: f.store, files: f.files });
    const legacy = await f.service.getRoleToolStatus(role);
    assert.deepEqual(legacy.disabledTools, [existing]);
    for (const options of [{}, { additionalAppTools: [] }, { additionalAppTools: undefined }]) {
      assert.deepEqual(await f.service.getRoleToolStatus(role, options), legacy);
    }
    const extended = await f.service.getRoleToolStatus(role, { additionalAppTools: ['math_project', existing] });
    assert.deepEqual(extended, { ...legacy, disabledTools: [existing, 'math_project'] });
    assert.deepEqual({ configs: f.configs, store: f.store, files: f.files }, before); assert.deepEqual(writes(f), []);
    for (const [verb, input] of f.calls) {
      assert.ok(['agent:list', 'agent:config', 'storage.get'].includes(verb));
      if (verb === 'agent:config') assert.deepEqual(input, { agentId: id, scope: 'own' });
    }
  }
});

for (const goalTool of ['math_goal', 'math_goal_main']) test(`${goalTool} status reads actual switches without granting permissions or changing the saved role`, async () => {
  const f = fixture(), id = 'hana-math-main'; f.add(ownAgent(id, 'main'));
  const config = f.configs.get(id); config.tool_call_mode = 'full';
  for (const enabled of [true, false]) for (const goalEnabled of [true, false]) {
    config.extensions = { app: { 'hana-math': { enabled, tools: { gm_add: false, math_project: false, [goalTool]: goalEnabled, unknown_app_tool: false } } } };
    const before = clone({ configs: f.configs, store: f.store, files: f.files });
    const legacy = await f.service.getRoleToolStatus('main'); assert.deepEqual(legacy.disabledTools, ['gm_add']);
    const extended = await f.service.getRoleToolStatus('main', { additionalAppTools: ['math_project', goalTool] });
    assert.equal(extended.agentId, id); assert.equal(extended.appEnabled, enabled); assert.equal(extended.resolvedMode, 'full');
    assert.deepEqual(extended.disabledTools, ['gm_add', 'math_project', ...(goalEnabled ? [] : [goalTool])]);
    assert.doesNotMatch(JSON.stringify(extended), /unknown_app_tool|SECRET|models|identity|config/);
    assert.deepEqual({ configs: f.configs, store: f.store, files: f.files }, before);
  }
  assert.deepEqual(writes(f), []);
  for (const [verb, input] of f.calls) {
    assert.ok(['agent:list', 'agent:config', 'storage.get'].includes(verb));
    if (verb === 'agent:config') assert.deepEqual(input, { agentId: id, scope: 'own' });
  }
});

for (const goalTool of ['math_goal', 'math_goal_main']) for (const verb of ['agent:list', 'agent:config']) test(`${goalTool} tool status still enforces ${verb} authorization`, async () => {
  const f = fixture(); f.add(ownAgent('hana-math-main', 'main'));
  const before = clone({ configs: f.configs, store: f.store, files: f.files });
  f.hooks[verb] = () => { throw Object.assign(new Error('PRIVATE permission denied'), { code: 'APP_CAPABILITY_DENIED' }); };
  await assert.rejects(f.service.getRoleToolStatus('main', { additionalAppTools: ['math_project', goalTool] }),
    error => error.code === 'FORBIDDEN' && error.status === 403 && !error.message.includes('PRIVATE'));
  assert.ok(f.calls.some(([operation]) => operation === verb)); assert.deepEqual(writes(f), []);
  assert.deepEqual({ configs: f.configs, store: f.store, files: f.files }, before);
});

for (const goalTool of ['math_goal', 'math_goal_main']) test(`${goalTool} tool status refuses a saved binding belonging to another role`, async () => {
  const f = fixture(); f.add(ownAgent('saved-other-role', 'worker')); f.store.set('profile.role.main', { agentId: 'saved-other-role' });
  await expectCode(f.service.getRoleToolStatus('main', { additionalAppTools: ['math_project', goalTool] }), 'FORBIDDEN', 403);
  assert.equal(f.calls.some(([verb]) => verb === 'agent:config'), false); assert.deepEqual(writes(f), []);
});

for (const [label, options] of [
  ['null', null], ['array', []], ['unknown field', { additionalAppTools: [], scope: 'all' }],
  ['symbol field', { [Symbol('scope')]: 'all' }], ['inherited options', Object.create({ additionalAppTools: ['math_project'] })],
  ['getter', { get additionalAppTools() { assert.fail('option getters must not execute'); } }],
  ['not an array', { additionalAppTools: 'math_project' }], ['null names', { additionalAppTools: null }],
  ['duplicates', { additionalAppTools: ['math_project', 'math_project'] }],
  ['duplicate Goal', { additionalAppTools: ['math_project', 'math_goal', 'math_goal'] }],
  ['duplicate main Goal', { additionalAppTools: ['math_goal_main', 'math_goal_main'] }],
  ['unknown alongside main Goal', { additionalAppTools: ['math_goal_main', 'unknown_app_tool'] }],
  ['unknown alongside Goal', { additionalAppTools: ['math_project', 'math_goal', 'unknown_app_tool'] }],
  ['too many', { additionalAppTools: Array(33).fill('math_project') }], ['sparse array', { additionalAppTools: Array(1) }],
  ...['read', 'web_search', 'web_fetch', 'wait_for_tasks', 'write', 'exec', 'exec_command', 'tool_call', 'other_app/tool', '../math_project', 'math_project\n',
    'unknown', '__proto__', 'constructor', '', null, 42, {}].map((name) => [JSON.stringify(name), { additionalAppTools: [name] }]),
]) test(`tool-status options reject ${label} before any host/config access`, async () => {
  const f = fixture();
  await expectCode(f.service.getRoleToolStatus('main', options), 'INVALID_INPUT', 400);
  assert.deepEqual(f.calls, []);
});

test('additional names are snapshotted before asynchronous binding/config reads', async () => {
  const f = fixture(), id = 'hana-math-main'; f.add(ownAgent(id, 'main'));
  f.configs.get(id).extensions = { app: { 'hana-math': { tools: { math_project: false } } } };
  const options = { additionalAppTools: ['math_project'] };
  f.hooks['agent:list'] = () => { options.additionalAppTools.length = 0; };
  assert.deepEqual((await f.service.getRoleToolStatus('main', options)).disabledTools, ['math_project']);
  assert.deepEqual(writes(f), []);
});

for (const [name, includeGoalTools] of [['math_project', false], ['math_project', true], ['math_goal_main', true]]) test(`project main (Goal=${includeGoalTools}) rejects disabled ${name} from the formal profile before creation`, async () => {
  const f = fixture(), id = 'hana-math-main'; f.add(ownAgent(id, 'main'));
  const config = f.configs.get(id); config.tool_call_mode = 'full';
  config.extensions = { app: { 'hana-math': { tools: { [name]: false } } } };
  const before = clone({ configs: f.configs, store: f.store, files: f.files });
  const states = [];
  await assert.rejects(createProjectMainSession(f.sdk, { profiles: f.service, cwd: '/fixture/project/main', includeGoalTools,
    onState(state) { states.push(state); } }), (error) => error.code === 'ROLE_TOOLS_DISABLED'
      && error.state.createState === 'not-attempted' && error.state.sessionId === null && error.state.sessionModel === null);
  assert.equal(states.at(-1).state, 'failed'); assert.equal(states.some((state) => state.state === 'ready'), false);
  assert.equal(f.calls.some(([verb]) => verb.startsWith('session:') || verb === 'model:list'), false);
  assert.deepEqual({ configs: f.configs, store: f.store, files: f.files }, before); assert.deepEqual(writes(f), []);
});

test('explicit tool-mode save is narrow, no-op aware and can restore a resolved enum', async () => {
  const f = fixture(), id = 'hana-math-main'; f.add(ownAgent(id, 'main'));
  const original = clone(f.configs.get(id)), files = clone(f.files);
  const saved = await f.service.setRoleToolMode('main', id, 'full');
  assert.equal(saved.saved, true); assert.equal(saved.previousMode, 'standard'); assert.equal(saved.sessionEffect, 'new-session-required');
  assert.deepEqual(writes(f).map(([verb, input]) => [verb, input]), [['agent:update-config', { agentId: id, scope: 'own', partial: { tool_call_mode: 'full' } }]]);
  assert.deepEqual(f.configs.get(id), { ...original, tool_call_mode: 'full' }); assert.deepEqual(f.files, files);
  assert.equal((await f.service.setRoleToolMode('main', id, 'full')).changed, false); assert.equal(writes(f).length, 1);
  await f.service.setRoleToolMode('main', id, saved.previousMode); assert.equal(f.configs.get(id).tool_call_mode, 'standard');
  for (const mode of [null, 'inherit', 'bad', {}, false]) await expectCode(f.service.setRoleToolMode('main', id, mode), 'INVALID_INPUT');
  await expectCode(f.service.setRoleToolMode('main', 'foreign', 'full'), 'CONFLICT'); assert.equal(writes(f).length, 2);
});

test('tool-mode host failures never retry or rollback and expose confirmed versus unknown effects', async () => {
  for (const applied of [false, true]) {
    const f = fixture(), id = 'hana-math-main'; f.add(ownAgent(id, 'main'));
    f.hooks['agent:update-config'] = () => { if (applied) f.configs.get(id).tool_call_mode = 'full'; throw Object.assign(new Error('PRIVATE_DENIED'), { code: 'APP_CAPABILITY_DENIED' }); };
    await assert.rejects(f.service.setRoleToolMode('main', id, 'full'), (e) => e.code === 'FORBIDDEN' && e.writeState === (applied ? 'confirmed' : 'unconfirmed') && e.applied.length === (applied ? 1 : 0));
    assert.equal(writes(f).length, 1);
  }
  const f = fixture(), id = 'hana-math-main'; f.add(ownAgent(id, 'main'));
  f.hooks['agent:update-config'] = () => ({ config: {} });
  await assert.rejects(f.service.setRoleToolMode('main', id, 'full'), (e) => e.code === 'SAVE_NOT_CONFIRMED' && e.writeState === 'unconfirmed');
  assert.equal(writes(f).length, 1);
});

test('tool-mode setter refuses a replacement binding and reports unknown post-write identity', async () => {
  const f = fixture(), id = 'hana-math-main', replacement = 'saved-new-main';
  f.add(ownAgent(id, 'main')); f.add(ownAgent(replacement, 'main'));
  f.store.set('profile.role.main', { agentId: replacement });
  await expectCode(f.service.setRoleToolMode('main', id, 'full'), 'CONFLICT'); assert.deepEqual(writes(f), []);
  f.store.set('profile.role.main', { agentId: id });
  f.hooks['agent:update-config'] = () => {
    f.configs.get(id).tool_call_mode = 'full'; f.store.set('profile.role.main', { agentId: replacement });
    return { config: clone(f.configs.get(id)) };
  };
  await assert.rejects(f.service.setRoleToolMode('main', id, 'full'), (e) => e.code === 'CONFLICT' && e.writeState === 'unconfirmed');
  assert.equal(writes(f).length, 1); assert.equal(f.configs.get(replacement).tool_call_mode, undefined);
});

test('tool status rejects a role replacement during config read without modifying it', async () => {
  const f = fixture(), id = 'hana-math-main'; f.add(ownAgent(id, 'main'));
  f.hooks['agent:config'] = () => { f.agents.get(id).state = 'retired'; return { config: { tool_call_mode: 'full' } }; };
  await expectCode(f.service.getRoleToolStatus('main'), 'CONFLICT'); assert.deepEqual(writes(f), []);
});

test('getRoleModel only projects saved provider/id for each bound role without persona or state access', async () => {
  for (const role of ['main', 'worker', 'verifier']) {
    const f = fixture(); const agentId = `hana-math-${role}`;
    f.add(ownAgent(agentId, role)); f.store.set(`profile.role.${role}`, { agentId });
    f.configs.get(agentId).models.chat = { provider: 'saved-provider', id: `saved-${role}`, apiKey: 'PRIVATE_MODEL_SECRET' };
    const before = clone({ store: f.store, configs: f.configs, files: f.files });
    const selected = await f.service.getRoleModel(role);
    assert.deepEqual(selected, { role, agentId, instanceState: 'active', model: { provider: 'saved-provider', id: `saved-${role}` }, source: 'saved-role' });
    assert.doesNotMatch(JSON.stringify(selected), /SECRET|identity|AGENTS|avatar|revision|config|utility|apiKey/);
    assert.deepEqual({ store: f.store, configs: f.configs, files: f.files }, before);
    assert.deepEqual(f.calls.map(([verb]) => verb), ['agent:list', 'storage.get', 'agent:config', 'agent:list', 'storage.get']);
    assertRoleModelReadsOnly(f);
  }
});

test('getRoleModel recovers one owned instance read-only and never persists its binding', async () => {
  const f = fixture(); f.add(ownAgent('hana-math-main', 'main'));
  assert.deepEqual(await f.service.getRoleModel('main'), {
    role: 'main', agentId: 'hana-math-main', instanceState: 'recovered', model: { provider: 'p', id: 'm' }, source: 'saved-role',
  });
  assert.equal(f.store.has('profile.role.main'), false);
  assertRoleModelReadsOnly(f);
});

test('getRoleModel rejects unknown roles, unsaved presets, missing and retired instances without configuration reads', async () => {
  for (const role of ['unknown', '../main', '', null]) {
    const f = fixture(); await expectCode(f.service.getRoleModel(role), 'NOT_FOUND', 404); assert.deepEqual(f.calls, []);
  }
  for (const [state, code, status] of [['preset', 'ROLE_NOT_CONFIGURED', 409], ['missing', 'ROLE_MISSING', 404], ['retired', 'ROLE_RETIRED', 409]]) {
    const f = fixture();
    if (state !== 'preset') f.store.set('profile.role.main', { agentId: 'hana-math-main' });
    if (state === 'retired') f.add(ownAgent('hana-math-main', 'main', { state: 'retired' }));
    await expectCode(f.service.getRoleModel('main'), code, status);
    assert.equal(f.calls.some(([verb]) => verb === 'agent:config'), false);
    assertRoleModelReadsOnly(f);
  }
});

test('getRoleModel never falls back to a utility/chat default when the saved model is absent or malformed', async () => {
  for (const model of [undefined, null, {}, { id: 'm' }, { provider: 'p' }, { provider: '', id: 'm' }, { provider: 'p', id: '' }]) {
    const f = fixture(); f.add(ownAgent('hana-math-worker', 'worker'));
    f.store.set('profile.role.worker', { agentId: 'hana-math-worker' });
    f.configs.get('hana-math-worker').models.chat = model;
    await expectCode(f.service.getRoleModel('worker'), 'MODEL_NOT_CONFIGURED', 409);
    assertRoleModelReadsOnly(f);
  }
});

test('getRoleModel rejects invalid, foreign and ambiguous bindings using the existing ownership rules', async () => {
  const invalid = fixture(); invalid.store.set('profile.role.main', { agentId: null });
  await expectCode(invalid.service.getRoleModel('main'), 'INVALID_BINDING', 409); assertRoleModelReadsOnly(invalid);
  const foreign = fixture();
  foreign.add(ownAgent('foreign-main', 'worker')); foreign.store.set('profile.role.main', { agentId: 'foreign-main' });
  await expectCode(foreign.service.getRoleModel('main'), 'FORBIDDEN', 403); assertRoleModelReadsOnly(foreign);
  const hidden = fixture(); hidden.add(ownAgent('foreign-owned', 'main', { ownerPluginId: 'other' })); hidden.store.set('profile.role.main', { agentId: 'foreign-owned' });
  await expectCode(hidden.service.getRoleModel('main'), 'ROLE_MISSING', 404); assertRoleModelReadsOnly(hidden);
  assert.equal(hidden.calls.some(([verb]) => verb === 'agent:config'), false);
  const ambiguous = fixture(); ambiguous.add(ownAgent('hana-math-main', 'main'));
  ambiguous.add(ownAgent('hana-math-main-12345678-1234-1234-1234-123456789012', 'main'));
  await expectCode(ambiguous.service.getRoleModel('main'), 'AMBIGUOUS_INSTANCE', 409); assertRoleModelReadsOnly(ambiguous);
});

test('getRoleModel preserves permission and missing-config failures without leaking host details', async () => {
  for (const verb of ['agent:list', 'agent:config']) {
    const f = fixture(); f.add(ownAgent('hana-math-main', 'main'));
    f.hooks[verb] = () => { throw Object.assign(new Error('SECRET permission denied'), { code: 'APP_CAPABILITY_DENIED' }); };
    await assert.rejects(f.service.getRoleModel('main'), (error) => error.code === 'FORBIDDEN' && error.status === 403 && !error.message.includes('SECRET'));
    assertRoleModelReadsOnly(f);
  }
  const f = fixture(); f.add(ownAgent('hana-math-main', 'main')); f.configs.delete('hana-math-main');
  await expectCode(f.service.getRoleModel('main'), 'NOT_FOUND', 404); assertRoleModelReadsOnly(f);
  f.configs.set('hana-math-main', null);
  await expectCode(f.service.getRoleModel('main'), 'HOST_ERROR', 502); assertRoleModelReadsOnly(f);
});

test('getRoleModel detects binding and lifecycle changes across its configuration read', async () => {
  for (const change of ['rebound', 'unmapped', 'retired', 'deleted']) {
    const f = fixture(); f.add(ownAgent('hana-math-main', 'main')); f.store.set('profile.role.main', { agentId: 'hana-math-main' });
    f.hooks['agent:config'] = () => {
      if (change === 'rebound') { f.add(ownAgent('replacement-main', 'main')); f.store.set('profile.role.main', { agentId: 'replacement-main' }); }
      if (change === 'unmapped') f.store.delete('profile.role.main');
      if (change === 'retired') f.agents.get('hana-math-main').state = 'retired';
      if (change === 'deleted') f.agents.delete('hana-math-main');
    };
    await expectCode(f.service.getRoleModel('main'), 'CONFLICT', 409); assertRoleModelReadsOnly(f);
  }
  const f = fixture(); f.add(ownAgent('hana-math-main', 'main'));
  f.hooks['agent:config'] = () => { f.add(ownAgent('hana-math-main-12345678-1234-1234-1234-123456789012', 'main')); };
  await expectCode(f.service.getRoleModel('main'), 'AMBIGUOUS_INSTANCE', 409); assertRoleModelReadsOnly(f);
});

test('getRoleModel does not issue or evict an editor revision and sees subsequent saved models', async () => {
  const f = fixture(); f.add(ownAgent('hana-math-main', 'main')); f.store.set('profile.role.main', { agentId: 'hana-math-main' });
  const service = createProfileService(f.sdk, { maxRevisions: 1 });
  const editor = await service.get('role', 'main');
  f.calls.length = 0;
  await service.getRoleModel('main'); await service.getRoleModel('main');
  assertRoleModelReadsOnly(f);
  const saved = await service.save('role', 'main', draft(editor, { model: { provider: 'q', id: 'n' } }));
  assert.deepEqual(saved.model, { provider: 'q', id: 'n' });
  f.calls.length = 0;
  assert.deepEqual((await service.getRoleModel('main')).model, { provider: 'q', id: 'n' });
  assertRoleModelReadsOnly(f);
});

test('GET template uses official role:get, returns a draft and never creates, maps or writes', async () => {
  const f = fixture(); const editor = await f.service.get('role', 'main');
  assert.equal(editor.agentId, null); assert.equal(editor.isPreset, true); assert.equal(editor.identity, 'main identity');
  assert.equal(editor.agentsMd, 'main agents'); assert.equal(editor.instanceState, 'preset');
  assert.deepEqual(editor.personaSources, { identity: 'template', agentsMd: 'template' });
  assert.deepEqual(f.calls.find(([verb]) => verb === 'role:get'), ['role:get', { roleId: 'main' }]);
  assert.deepEqual(writes(f), []);
  assert.doesNotMatch(JSON.stringify(editor), /MASKED_SECRET|DO_NOT_LEAK|unrelated|publicAgents|apiKey/);
  assert.deepEqual(editor.models, [{ provider: 'p', id: 'm', name: 'Model' }, { provider: 'q', id: 'n', name: 'Other' }]);
});

test('assistant snapshot uses scope all, fixed ResourceIO references and decoded UTF-8', async () => {
  const f = fixture(); f.putFile('shiraha', 'identity.md', '完整人格\n文字');
  const editor = await f.service.get('assistant', 'shiraha');
  assert.equal(editor.identity, '完整人格\n文字'); assert.equal(editor.agentId, 'shiraha'); assert.equal(editor.isPreset, false);
  assert.deepEqual(f.calls.find(([verb]) => verb === 'agent:config'), ['agent:config', { agentId: 'shiraha', scope: 'all' }]);
  assert.deepEqual(editor.model, { provider: 'p', id: 'm' }); assert.deepEqual(writes(f), []);
  assert.doesNotMatch(JSON.stringify(editor), /MASKED_SECRET|api_key|utility|unrelated/);
});

test('first explicit save creates once and persists the selected model and owned binding', async () => {
  const f = fixture(); let editor = await f.service.get('role', 'main');
  editor = await f.service.save('role', 'main', draft(editor, { name: 'Saved main', latinName: 'Main', identity: 'Saved identity', avatarDataUrl: PNG }));
  assert.equal(editor.agentId, 'hana-math-main'); assert.equal(editor.isPreset, false); assert.deepEqual(editor.model, { provider: 'p', id: 'm' });
  assert.equal(editor.name, 'Saved main'); assert.equal(editor.avatarSource, 'math');
  assert.deepEqual(f.store.get('profile.role.main'), { agentId: 'hana-math-main' });
  assert.deepEqual(f.configs.get(editor.agentId).models.chat, { provider: 'p', id: 'm' }, 'the chosen model is written explicitly');
  assert.deepEqual(f.calls.find(([verb]) => verb === 'agent:create-from-role'), ['agent:create-from-role', { roleId: 'main', id: 'hana-math-main', importMemory: false }]);
  assert.equal(f.calls.filter(([verb]) => verb === 'agent:create-from-role').length, 1);
  await f.service.save('role', 'main', draft(editor));
  assert.equal(f.calls.filter(([verb]) => verb === 'agent:create-from-role').length, 1);
  assert.ok(f.calls.filter(([verb]) => verb === 'agent:config').every(([, input]) => !input.scope));
  const restarted = createProfileService(f.sdk); assert.equal((await restarted.get('role', 'main')).identity, 'Saved identity');
  assert.equal((await restarted.get('role', 'main')).avatarUrl, PNG);
});

test('assistant save submits only changed editable patches, never full config, and retains unrelated host edits', async () => {
  const f = fixture(); const before = await f.service.get('assistant', 'shiraha');
  f.configs.get('shiraha').unrelated.changedElsewhere = true;
  f.configs.get('shiraha').agent.name = 'External name'; f.agents.get('shiraha').name = 'External name';
  const saved = await f.service.save('assistant', 'shiraha', draft(before, { latinName: 'New Name', model: { provider: 'q', id: 'n' }, agentsMd: 'Changed agents' }));
  assert.equal(saved.name, 'External name', 'unchanged stale draft field is neither conflict nor overwrite');
  assert.equal(f.calls.filter(([verb]) => verb === 'agent:update').length, 0);
  assert.deepEqual(f.calls.find(([verb]) => verb === 'agent:update-config'), ['agent:update-config', { agentId: 'shiraha', scope: 'all', partial: { agent: { latinName: 'New Name', latinNameSource: 'user' }, models: { chat: { provider: 'q', id: 'n' } } } }]);
  assert.equal(f.configs.get('shiraha').api.api_key, 'MASKED_SECRET');
  assert.equal(f.configs.get('shiraha').unrelated.changedElsewhere, true);
  assert.deepEqual(f.configs.get('shiraha').models.utility, { provider: 'hidden', id: 'utility' });
});

test('a profile cannot be saved without an explicit model selection', async () => {
  const f = fixture(); const assistant = await f.service.get('assistant', 'shiraha');
  await expectCode(f.service.save('assistant', 'shiraha', draft(assistant, { model: null, latinName: '' })), 'MODEL_REQUIRED', 400);
  const role = await f.service.get('role', 'worker');
  await expectCode(f.service.save('role', 'worker', draft(role, { model: null })), 'MODEL_REQUIRED', 400);
  assert.deepEqual(writes(f), []);
});

test('only directory models are selectable, but an unchanged unavailable current model is preserved', async () => {
  const f = fixture(); f.configs.get('shiraha').models.chat = { provider: 'offline', id: 'saved' };
  let editor = await f.service.get('assistant', 'shiraha');
  editor = await f.service.save('assistant', 'shiraha', draft(editor, { name: 'Rename' }));
  assert.deepEqual(editor.model, { provider: 'offline', id: 'saved' });
  assert.equal(f.calls.filter(([verb]) => verb === 'agent:update-config').length, 0);
  const count = writes(f).length;
  for (const model of [{ provider: 'fake', id: 'm' }, { provider: 'p', id: 'm', api_key: 'bad' }, { provider: '', id: 'm' }]) {
    await expectCode(f.service.save('assistant', 'shiraha', draft(editor, { name: 'Not saved', model })), 'INVALID_MODEL', 400);
    assert.equal(writes(f).length, count);
  }
  const role = await f.service.get('role', 'worker');
  await expectCode(f.service.save('role', 'worker', draft(role, { model: { provider: 'fake', id: 'x' } })), 'INVALID_MODEL');
  assert.equal(f.calls.filter(([verb]) => verb === 'agent:create-from-role').length, 0);
});

test('revision tokens bind target, expire and are bounded; successful consumed revisions cannot overwrite again', async () => {
  const f = fixture(); let time = 100;
  const service = createProfileService(f.sdk, { now: () => time, ttl: 20, maxRevisions: 2 });
  const first = await service.get('assistant', 'shiraha');
  await expectCode(service.save('assistant', 'second', draft(first)), 'CONFLICT', 409);
  const second = await service.get('assistant', 'shiraha'); await service.get('role', 'main');
  await expectCode(service.save('assistant', 'shiraha', draft(first)), 'CONFLICT', 409);
  time = 121; await expectCode(service.save('assistant', 'shiraha', draft(second)), 'CONFLICT', 409);
  const fresh = await service.get('assistant', 'shiraha'); await service.save('assistant', 'shiraha', draft(fresh));
  await expectCode(service.save('assistant', 'shiraha', draft(fresh, { name: 'Overwrite' })), 'CONFLICT', 409);
  assert.deepEqual(writes(f), []);
});

test('concurrent editors and same-target saves serialize, stale edited values conflict with zero extra writes', async () => {
  const f = fixture(); const a = await f.service.get('assistant', 'shiraha'); const b = await f.service.get('assistant', 'shiraha');
  const results = await Promise.allSettled([f.service.save('assistant', 'shiraha', draft(a, { name: 'A' })), f.service.save('assistant', 'shiraha', draft(b, { name: 'B' }))]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'CONFLICT');
  assert.equal(f.calls.filter(([verb]) => verb === 'agent:update').length, 1);
  const role = await f.service.get('role', 'main');
  const roles = await Promise.allSettled([f.service.save('role', 'main', draft(role)), f.service.save('role', 'main', draft(role))]);
  assert.equal(roles[0].status, 'fulfilled'); assert.equal(roles[1].reason.code, 'CONFLICT');
  assert.equal(f.calls.filter(([verb]) => verb === 'agent:create-from-role').length, 1);
});

test('all dirty fields are preflighted before the first write, including resource versions', async () => {
  const f = fixture(); const editor = await f.service.get('assistant', 'shiraha');
  f.putFile('shiraha', 'AGENTS.md', editor.agentsMd); // same text, a different host version
  await expectCode(f.service.save('assistant', 'shiraha', draft(editor, { name: 'Not renamed', agentsMd: 'new' })), 'CONFLICT', 409);
  assert.deepEqual(writes(f), []);
});

test('ResourceIO conditional-write conflicts remain 409, and multi-write failures report exact applied fields', async () => {
  const f = fixture(); const editor = await f.service.get('assistant', 'shiraha');
  f.hooks.write = () => ({ ok: false, conflict: true, version: { mtimeMs: 900, size: 2 } });
  await expectCode(f.service.save('assistant', 'shiraha', draft(editor, { identity: 'Conflicting' })), 'CONFLICT', 409);
  assert.equal(f.files.get('shiraha/identity.md').content, editor.identity);
  await assert.rejects(f.service.save('assistant', 'shiraha', draft(editor, { name: 'Renamed', identity: 'Conflicting' })), (error) => {
    assert.equal(error.code, 'PARTIAL_SAVE'); assert.equal(error.status, 409); assert.deepEqual(error.applied, ['name']); return true;
  });
  assert.equal(f.configs.get('shiraha').agent.name, 'Renamed');
  assert.equal(f.files.get('shiraha/identity.md').content, editor.identity);
});

test('an explicit CAS conflict never attributes another writer matching the draft to this save', async () => {
  const f = fixture(); const editor = await f.service.get('assistant', 'shiraha');
  f.hooks.write = (ref, text) => {
    f.putFile(ref.name, ref.path, text);
    return { ok: false, conflict: true, version: clone(f.files.get(`${ref.name}/${ref.path}`).version) };
  };
  await assert.rejects(f.service.save('assistant', 'shiraha', draft(editor, { identity: 'Concurrent matching draft' })), (error) => error.code === 'CONFLICT' && error.status === 409 && error.applied === undefined);
  assert.equal(f.calls.filter(([verb]) => verb === 'resources.write').length, 0);
});

test('permission failures and result.error envelopes are not swallowed, redacted or called success', async () => {
  const f = fixture(); let editor = await f.service.get('assistant', 'shiraha');
  f.hooks['agent:update'] = () => { const e = new Error('PRIVATE_HOST_DETAIL'); e.code = 'APP_CAPABILITY_DENIED'; throw e; };
  await expectCode(f.service.save('assistant', 'shiraha', draft(editor, { name: 'No' })), 'FORBIDDEN', 403);
  f.hooks['agent:update'] = undefined;
  f.hooks['agent:update-config'] = () => ({ error: 'agent_update_unavailable' });
  await assert.rejects(f.service.save('assistant', 'shiraha', draft(editor, { name: 'Yes', latinName: 'No' })), (error) => {
    assert.equal(error.code, 'PARTIAL_SAVE'); assert.deepEqual(error.applied, ['name']); assert.doesNotMatch(error.message, /PRIVATE_HOST_DETAIL/); return true;
  });
  f.hooks['agent:config'] = () => ({ error: 'agent_not_found' });
  await expectCode(f.service.get('assistant', 'shiraha'), 'NOT_FOUND', 404);
});

test('private/unknown/owned/retired assistant targets and browser-supplied arbitrary fields are rejected', async () => {
  const f = fixture();
  for (const [id, extra] of [['private', { visibility: 'private' }], ['unknown', { visibility: 'unknown' }], ['foreign', { ownerPluginId: 'other' }], ['nested', { plugin: { visibility: 'private', ownerPluginId: 'other' } }]]) {
    f.add(publicAgent(id, extra)); await expectCode(f.service.get('assistant', id), 'FORBIDDEN', 403);
  }
  f.add(publicAgent('retired', { state: 'retired' })); await expectCode(f.service.get('assistant', 'retired'), 'NOT_FOUND', 404);
  for (const id of ['../shiraha', 'config.yaml', '', 'a/b']) await expectCode(f.service.get('assistant', id), 'NOT_FOUND', 404);
  await expectCode(f.service.get('role', 'foreign'), 'NOT_FOUND', 404);
  const editor = await f.service.get('assistant', 'shiraha');
  for (const extra of [{ agentId: 'other' }, { config: { evil: true } }, { path: '/etc/passwd' }, { name: '' }, { latinName: '脚本' }, { identity: 'x'.repeat(128 * 1024 + 1) }]) await expectCode(f.service.save('assistant', 'shiraha', draft(editor, extra)), 'INVALID_INPUT', 400);
  assert.deepEqual(writes(f), []);
});

test('mapping failure leaves recoverable host metadata; GET recovery is read-only, next save reuses instance', async () => {
  const f = fixture(); const editor = await f.service.get('role', 'main');
  f.hooks['storage.set'] = (key) => { if (key.startsWith('profile.role')) throw new Error('Storage unavailable'); };
  await assert.rejects(f.service.save('role', 'main', draft(editor)), (error) => error.code === 'PARTIAL_SAVE' && JSON.stringify(error.applied) === '["instance"]');
  assert.equal(f.calls.filter(([verb]) => verb === 'agent:create-from-role').length, 1);
  const restarted = createProfileService(f.sdk); const count = writes(f).length;
  const recovered = await restarted.get('role', 'main');
  assert.equal(recovered.agentId, 'hana-math-main'); assert.equal(recovered.instanceState, 'recovered');
  assert.equal(writes(f).length, count);
  f.hooks['storage.set'] = undefined;
  await restarted.save('role', 'main', draft(recovered));
  assert.equal(f.calls.filter(([verb]) => verb === 'agent:create-from-role').length, 1);
  assert.deepEqual(f.store.get('profile.role.main'), { agentId: 'hana-math-main' });
});

test('retired or missing mapped instances are explicit drafts and recover only on explicit save', async () => {
  for (const state of ['retired', 'missing']) {
    const f = fixture();
    f.store.set('profile.role.worker', { agentId: 'hana-math-worker' });
    if (state === 'retired') f.add(ownAgent('hana-math-worker', 'worker', { state: 'retired' }));
    const editor = await f.service.get('role', 'worker');
    assert.equal(editor.instanceState, state); assert.equal(editor.agentId, null); assert.deepEqual(writes(f), []);
    const saved = await f.service.save('role', 'worker', draft(editor));
    assert.equal(saved.instanceState, 'active'); assert.ok(saved.agentId.startsWith('hana-math-worker'));
    if (state === 'retired') { assert.notEqual(saved.agentId, 'hana-math-worker'); assert.equal(f.agents.get('hana-math-worker').state, 'retired'); }
  }
});

test('foreign collision and forged/ambiguous binding do not take over external agents', async () => {
  const f = fixture(); f.add(publicAgent('hana-math-main'));
  const editor = await f.service.get('role', 'main');
  await expectCode(f.service.save('role', 'main', draft(editor)), 'CONFLICT', 409);
  assert.equal(f.configs.get('hana-math-main').agent.name, 'hana-math-main');
  assert.ok(writes(f).every(([verb]) => verb === 'agent:create-from-role'));
  const forged = fixture(); forged.add(ownAgent('foreign-owned', 'main', { ownerPluginId: 'other' })); forged.store.set('profile.role.main', { agentId: 'foreign-owned' });
  // Own-list filtering hides the foreign Agent, so the binding is shown missing;
  // it is never used for config/resource writes, and recovery chooses its own ID.
  const missing = await forged.service.get('role', 'main'); assert.equal(missing.agentId, null);
  await forged.service.save('role', 'main', draft(missing));
  assert.equal(forged.configs.get('foreign-owned').agent.name, 'foreign-owned');
  const ambiguous = fixture(); ambiguous.add(ownAgent('hana-math-main', 'main')); ambiguous.add(ownAgent('hana-math-main-12345678-1234-1234-1234-123456789012', 'main'));
  await expectCode(ambiguous.service.get('role', 'main'), 'AMBIGUOUS_INSTANCE', 409);
});

test('app avatars accept only canonical raster data, persist separately and never touch host Avatar', async () => {
  const f = fixture(); const editor = await f.service.get('assistant', 'shiraha');
  for (const value of ['https://example.com/x.png', '/tmp/avatar.png', 'data:image/svg+xml;base64,PHN2Zy8+', PNG.replace('image/png', 'image/jpeg'), 'data:image/png;base64,AAAA', `data:image/png;base64,${Buffer.alloc(512 * 1024 + 1).toString('base64')}`, PNG + '\n']) {
    await expectCode(f.service.save('assistant', 'shiraha', draft(editor, { avatarDataUrl: value })), 'INVALID_AVATAR', 400);
  }
  const saved = await f.service.save('assistant', 'shiraha', draft(editor, { avatarDataUrl: PNG }));
  assert.equal(saved.avatarSource, 'math'); assert.equal(saved.avatarUrl, PNG);
  assert.deepEqual(writes(f).map(([verb]) => verb), ['storage.set']);
  assert.equal(f.store.get('profile.avatar.assistant.shiraha'), PNG);
  const restarted = createProfileService(f.sdk); assert.equal((await restarted.get('assistant', 'shiraha')).avatarUrl, PNG);
  f.store.set('profile.avatar.role.main', PNG); assert.equal((await restarted.get('role', 'main')).avatarUrl, PNG);
  assert.ok(validateAvatar('data:image/jpeg;base64,/9j/2Q=='));
  assert.ok(validateAvatar('data:image/webp;base64,UklGRgAAAABXRUJQ'));
});

test('resource reads decode supported IPC shapes, enforce limits, and expose unversioned host template fallback honestly', async () => {
  for (const content of [Buffer.from('文字'), Uint8Array.from(Buffer.from('文字')), { 0: 65, 1: 66 }, Buffer.from('文字').toJSON()]) {
    const f = fixture(); f.hooks.read = (ref) => ({ content, version: f.files.get(`${ref.name}/${ref.path}`).version });
    assert.ok((await f.service.get('assistant', 'shiraha')).identity.length > 0);
  }
  const f = fixture(); f.files.delete('shiraha/identity.md');
  const editor = await f.service.get('assistant', 'shiraha');
  assert.equal(editor.identity, 'Host fallback'); assert.equal(editor.personaSources.identity, 'template');
  assert.deepEqual(writes(f), [], 'GET of a missing persona still performs no writes');
  const tooLarge = fixture(); tooLarge.putFile('shiraha', 'identity.md', 'x'.repeat(128 * 1024 + 1));
  await expectCode(tooLarge.service.get('assistant', 'shiraha'), 'RESOURCE_TOO_LARGE', 413);
  const malformed = fixture(); malformed.hooks.read = () => ({ content: { arbitrary: '/path' }, version: { mtimeMs: 1, size: 1 } });
  await expectCode(malformed.service.get('assistant', 'shiraha'), 'CONFLICT', 409);
});

test('missing host-template personas save via official write, then become versioned agent files', async () => {
  const f = fixture(); f.files.delete('shiraha/identity.md'); f.files.delete('shiraha/AGENTS.md');
  const editor = await f.service.get('assistant', 'shiraha');
  assert.deepEqual(editor.personaSources, { identity: 'template', agentsMd: 'template' });
  const saved = await f.service.save('assistant', 'shiraha', draft(editor, { identity: 'Custom identity', agentsMd: 'Custom agents' }));
  assert.deepEqual(saved.personaSources, { identity: 'agent', agentsMd: 'agent' });
  assert.deepEqual(f.calls.filter(([verb]) => verb === 'resources.write'), [
    ['resources.write', { kind: 'agent', name: 'shiraha', path: 'identity.md' }, 'Custom identity'],
    ['resources.write', { kind: 'agent', name: 'shiraha', path: 'AGENTS.md' }, 'Custom agents'],
  ]);
  assert.equal(f.calls.filter(([verb]) => verb === 'resources.writeExpectedVersion').length, 0);
  const readback = await f.service.get('assistant', 'shiraha');
  assert.equal(readback.identity, 'Custom identity'); assert.equal(readback.agentsMd, 'Custom agents');
  assert.deepEqual(readback.personaSources, { identity: 'agent', agentsMd: 'agent' });
  const version = clone(f.files.get('shiraha/identity.md').version);
  await f.service.save('assistant', 'shiraha', draft(readback, { identity: 'Next edit' }));
  assert.deepEqual(f.calls.find(([verb]) => verb === 'resources.writeExpectedVersion'), ['resources.writeExpectedVersion', { kind: 'agent', name: 'shiraha', path: 'identity.md' }, 'Next edit', version]);
  assert.equal(f.calls.filter(([verb]) => verb === 'resources.write').length, 2);
});

test('a file created after opening invalidates the template draft even when its text matches', async () => {
  const f = fixture(); f.files.delete('shiraha/identity.md');
  const editor = await f.service.get('assistant', 'shiraha');
  f.putFile('shiraha', 'identity.md', editor.identity);
  await expectCode(f.service.save('assistant', 'shiraha', draft(editor, { identity: 'Do not overwrite', name: 'Not saved' })), 'CONFLICT', 409);
  assert.equal(f.files.get('shiraha/identity.md').content, editor.identity);
  assert.deepEqual(writes(f), []);
});

test('the nearest template reread rejects files appearing before or during that check', async () => {
  for (const appearAt of [5, 6]) {
    const f = fixture(); f.files.delete('shiraha/identity.md');
    const editor = await f.service.get('assistant', 'shiraha'); let stats = 0;
    f.hooks.stat = (ref) => {
      if (ref.path === 'identity.md' && ++stats === appearAt) f.putFile(ref.name, ref.path, 'Other editor file');
    };
    await expectCode(f.service.save('assistant', 'shiraha', draft(editor, { identity: 'Do not overwrite' })), 'CONFLICT', 409);
    assert.ok(stats >= appearAt, 'reached the final persona reread, after both full snapshots');
    assert.equal(f.files.get('shiraha/identity.md').content, 'Other editor file'); assert.deepEqual(writes(f), []);
  }
});

test('the nearest template reread also rejects changed host-default content', async () => {
  const f = fixture(); f.files.delete('shiraha/identity.md');
  const editor = await f.service.get('assistant', 'shiraha'); let reads = 0;
  f.hooks.read = (ref) => {
    if (ref.path === 'identity.md' && ++reads === 3) return { content: Buffer.from('Changed host template'), metadata: { fromTemplate: true } };
  };
  await expectCode(f.service.save('assistant', 'shiraha', draft(editor, { identity: 'Stale default draft' })), 'CONFLICT', 409);
  assert.equal(reads, 3); assert.deepEqual(writes(f), []);
});

test('missing personas without confirmed template provenance and existing unversioned files stay unwritable', async () => {
  const f = fixture(); f.files.delete('shiraha/identity.md');
  f.hooks.read = (ref) => ref.path === 'identity.md' ? { content: Buffer.from('Unknown fallback'), metadata: { fromTemplate: false } } : undefined;
  const editor = await f.service.get('assistant', 'shiraha');
  await expectCode(f.service.save('assistant', 'shiraha', draft(editor, { identity: 'Not saved' })), 'VERSION_UNAVAILABLE', 409);
  assert.deepEqual(writes(f), []);
  const existing = fixture(); const before = await existing.service.get('assistant', 'shiraha');
  delete existing.files.get('shiraha/identity.md').version;
  await expectCode(existing.service.save('assistant', 'shiraha', draft(before, { identity: 'No unversioned overwrite' })), 'CONFLICT', 409);
  assert.deepEqual(writes(existing), []);
});

test('first-persona write failures and afterWrite errors report confirmed partial effects', async () => {
  for (const persist of [false, true]) {
    const f = fixture(); f.files.delete('shiraha/identity.md');
    const editor = await f.service.get('assistant', 'shiraha');
    f.hooks.writeUnversioned = (ref, text) => {
      if (persist) f.putFile(ref.name, ref.path, text);
      if (!persist) return { error: 'write failed' };
      throw new Error('After-write runtime refresh failed');
    };
    await assert.rejects(f.service.save('assistant', 'shiraha', draft(editor, { name: 'Saved name', identity: 'Custom identity' })), (error) => {
      assert.equal(error.code, 'PARTIAL_SAVE'); assert.equal(error.status, 502);
      assert.deepEqual(error.applied, persist ? ['name', 'identity'] : ['name']); return true;
    });
    assert.equal(f.files.has('shiraha/identity.md'), persist);
    if (persist) assert.equal((await f.service.get('assistant', 'shiraha')).identity, 'Custom identity');
    assert.equal(f.calls.filter(([verb]) => verb === 'resources.writeExpectedVersion').length, 0);
  }
  const f = fixture(); f.files.delete('shiraha/identity.md');
  const editor = await f.service.get('assistant', 'shiraha');
  f.hooks.writeUnversioned = () => { throw new Error('Failed before writing'); };
  await expectCode(f.service.save('assistant', 'shiraha', draft(editor, { identity: 'Not saved' })), 'HOST_ERROR', 502);
  assert.equal(f.files.has('shiraha/identity.md'), false);
});

test('first-persona save requires writeback confirmation and never claims mismatched content as success', async () => {
  const f = fixture(); f.files.delete('shiraha/identity.md');
  const editor = await f.service.get('assistant', 'shiraha');
  f.hooks.writeUnversioned = (ref) => {
    f.putFile(ref.name, ref.path, 'Unexpected host content');
    return { changeType: 'created', version: clone(f.files.get(`${ref.name}/${ref.path}`).version) };
  };
  await assert.rejects(f.service.save('assistant', 'shiraha', draft(editor, { identity: 'Desired content' })), (error) => error.code === 'PARTIAL_SAVE' && JSON.stringify(error.applied) === '["identity"]');
});

test('latinName matches the host NFC, whitespace, 32-codepoint and Latin-script constraints', async () => {
  const f = fixture(); let editor = await f.service.get('assistant', 'shiraha');
  editor = await f.service.save('assistant', 'shiraha', draft(editor, { latinName: '  Élodie\t O’Neil-- \n ' }));
  assert.equal(editor.latinName, 'Élodie O’Neil--');
  editor = await f.service.save('assistant', 'shiraha', draft(editor, { latinName: 'e\u0301'.repeat(32) }));
  assert.equal(editor.latinName, 'é'.repeat(32));
  const count = writes(f).length;
  for (const latinName of ['A'.repeat(33), 'Name 123', '---', '’', '李', 'A_B']) {
    await expectCode(f.service.save('assistant', 'shiraha', draft(editor, { latinName })), 'INVALID_INPUT', 400);
  }
  assert.equal(writes(f).length, count);
});

test('post-persistence host failures are reconciled honestly without rollback or false success', async () => {
  const f = fixture(); const editor = await f.service.get('assistant', 'shiraha');
  f.hooks['agent:update'] = (input) => {
    f.configs.get(input.agentId).agent.name = input.name; f.agents.get(input.agentId).name = input.name;
    throw new Error('Refresh failed after persistence');
  };
  await assert.rejects(f.service.save('assistant', 'shiraha', draft(editor, { name: 'Persisted' })), (error) => error.code === 'PARTIAL_SAVE' && JSON.stringify(error.applied) === '["name"]');
  f.hooks['agent:update'] = undefined;
  const next = await f.service.get('assistant', 'shiraha');
  f.hooks.write = (ref, text) => { f.putFile(ref.name, ref.path, text); throw new Error('After-write hook failed'); };
  await assert.rejects(f.service.save('assistant', 'shiraha', draft(next, { identity: 'Persisted identity' })), (error) => error.code === 'PARTIAL_SAVE' && JSON.stringify(error.applied) === '["identity"]');
  assert.equal(f.files.get('shiraha/identity.md').content, 'Persisted identity');
});

test('role template edits and newly private targets invalidate stale drafts before any mutation', async () => {
  const f = fixture(); const role = await f.service.get('role', 'main');
  f.roles.get('main').prompts.identity = 'Updated template';
  await expectCode(f.service.save('role', 'main', draft(role)), 'CONFLICT', 409);
  const assistant = await f.service.get('assistant', 'shiraha');
  f.agents.get('shiraha').visibility = 'private';
  await expectCode(f.service.save('assistant', 'shiraha', draft(assistant, { name: 'No takeover' })), 'FORBIDDEN', 403);
  assert.deepEqual(writes(f), []);
});

test('late resource permission denial returns PARTIAL_SAVE 403 with only confirmed fields', async () => {
  const f = fixture(); const editor = await f.service.get('assistant', 'shiraha');
  f.hooks.write = () => { const error = new Error('Permission revoked'); error.code = 'APP_CAPABILITY_DENIED'; throw error; };
  await assert.rejects(f.service.save('assistant', 'shiraha', draft(editor, { name: 'Saved name', identity: 'Denied text' })), (error) => error.code === 'PARTIAL_SAVE' && error.status === 403 && JSON.stringify(error.applied) === '["name"]');
  assert.equal(f.files.get('shiraha/identity.md').content, editor.identity);
});

test('all failures are non-2xx structured envelopes, malformed JSON is 400, oversized requests are rejected', async () => {
  const f = fixture(); const routes = [];
  registerEditors({ get(path, handler) { routes.push({ method: 'GET', path, handler }); }, post(path, handler) { routes.push({ method: 'POST', path, handler }); } }, f.service);
  const ctx = (id, text, length) => ({ req: { param: () => id, text: async () => text, header: () => length }, json: (body, status = 200) => ({ body, status }) });
  const get = routes.find((route) => route.method === 'GET' && route.path.includes('assistant'));
  const post = routes.find((route) => route.method === 'POST' && route.path.includes('assistant'));
  const result = await get.handler(ctx('shiraha')); assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  const bad = await post.handler(ctx('shiraha', '{')); assert.equal(bad.status, 400); assert.equal(bad.body.ok, false);
  assert.equal((await post.handler(ctx('shiraha', '{}', String(3 * 1024 * 1024)))).status, 413);
  const editor = result.body.editor;
  const success = await post.handler(ctx('shiraha', JSON.stringify(draft(editor, { name: 'Via route' })))); assert.equal(success.status, 200);
  const stale = await post.handler(ctx('shiraha', JSON.stringify(draft(editor, { name: 'Stale' })))); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'CONFLICT');
  const partial = await editorResponse(ctx('shiraha'), () => { const e = new Error('SECRET'); e.code = 'APP_CAPABILITY_DENIED'; throw e; });
  assert.equal(partial.status, 403); assert.doesNotMatch(JSON.stringify(partial), /SECRET/);
});
