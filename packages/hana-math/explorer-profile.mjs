// Explorer-specific creation provenance. Managed mutations use only formal SDK APIs.
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
export const EXPLORER_CREATION_KEY = 'profile.explorer.creation';
const bindingKey = 'profile.role.explorer';
const sha = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code = 'EXPLORER_UNCONFIRMED') => { if (!ok) throw Object.assign(new Error(code), { code }); };
const pins = Object.freeze({ 'AGENTS.md': '2a6ba2b3fd4e267e587e90bcc63c45d0f8c73bf16e403b3ba0e18a56673ae975', 'agents/contracts/main_agent.md': '0d7e651aa9477f1ba9714eed712e553f75527ce8baa4b08fa0ef931244120477' });
export async function readExplorerContract() {
  const [raw, cardRaw] = await Promise.all([readFile(new URL('./explorer-contract-sources.json', import.meta.url)), readFile(new URL('./roles/explorer/card.json', import.meta.url))]);
  const sources = JSON.parse(raw), card = JSON.parse(cardRaw);
  need(sources.schemaVersion === 1 && sources.upstreamStandaloneExplorer === false && sources.sources.length === 2, 'EXPLORER_CONTRACT_INVALID');
  need(sources.adapterContractSha256 === '2735f99e733a5cb182b46d0b0150102b9dd1d06955006f4b9537435580d136ee'
    && sources.adapterIdentitySha256 === 'd9e90365ccddf5e59fde2099f17c47f63bc74c3a53548c1552a19dc64d012624', 'EXPLORER_CONTRACT_INVALID');
  need(sha(card.prompts.identity) === sources.adapterIdentitySha256 && sha(card.prompts.agents) === sources.adapterContractSha256 && !card.skills, 'EXPLORER_CONTRACT_INVALID');
  for (const source of sources.sources) {
    need(Object.hasOwn(pins, source.path) && source.sha256 === pins[source.path], 'EXPLORER_CONTRACT_INVALID');
    const text = await readFile(new URL('./references/danus/' + source.path, import.meta.url));
    need(sha(text) === source.sha256, 'EXPLORER_CONTRACT_INVALID');
    for (const quote of sources.quotes.filter(q => q.sourcePath === source.path)) need(text.toString('utf8').includes(quote.text) && card.prompts.agents.includes(quote.text), 'EXPLORER_CONTRACT_INVALID');
  }
  return { card, binding: { adapterContractSha256: sources.adapterContractSha256, adapterIdentitySha256: sources.adapterIdentitySha256,
    sourcesSha256: sha(raw), originals: sources.sources } };
}
const own = a => a?.ownerPluginId === 'hana-math' && ['private', 'plugin_private'].includes(a.visibility)
  && a.plugin?.ownerPluginId === 'hana-math' && ['private', 'plugin_private'].includes(a.plugin.visibility) && a.plugin.kind === 'role' && a.plugin.roleId === 'explorer'
  && a.state === 'active' && a.deletedAt == null;
const checked = r => { need(r && r.ok !== false && !r.error); return r; };
// agent:list intentionally omits memoryPolicy; only the formal own profile can attest it.
export async function readExplorerMemoryProfile(sdk, agentId) {
  const profile = checked(await sdk.agents.profile({ agentId, scope: 'own' })).profile;
  need(profile?.id === agentId && profile.ownerPluginId === 'hana-math'
    && ['private', 'plugin_private'].includes(profile.visibility) && profile.memoryPolicy?.enabled === false, 'EXPLORER_PROFILE_UNCONFIRMED');
  return { id: profile.id, ownerPluginId: profile.ownerPluginId, visibility: profile.visibility, memoryPolicy: { enabled: false } };
}
/** Caller holds the existing role:explorer profile lock. No retry/repair of unknown creation. */
export async function createExplorerInstance(sdk, { initialModel, contract }) {
  need(initialModel && typeof initialModel.provider === 'string' && initialModel.provider && typeof initialModel.id === 'string' && initialModel.id);
  need(await sdk.storage.global.get(EXPLORER_CREATION_KEY, null) === null, 'EXPLORER_CREATION_UNCONFIRMED');
  const agentId = 'hana-math-explorer-' + randomUUID();
  const marker = { schemaVersion: 1, state: 'creating', agentId, model: { ...initialModel }, adapterContractSha256: contract.adapterContractSha256 };
  await sdk.storage.global.set(EXPLORER_CREATION_KEY, marker);
  need(JSON.stringify(await sdk.storage.global.get(EXPLORER_CREATION_KEY, null)) === JSON.stringify(marker), 'EXPLORER_CREATION_UNCONFIRMED');
  const created = checked(await sdk.agents.createFromRole({ roleId: 'explorer', id: agentId, importMemory: false }));
  need(created.agent?.id === agentId && created.agent.roleId === 'explorer');
  const readOwn = async () => {
    const rows = checked(await sdk.agents.list({ lifecycle: 'all' })).agents;
    need(Array.isArray(rows)); const matches = rows.filter(a => a.id === agentId); need(matches.length === 1 && own(matches[0])); return matches[0];
  };
  await readOwn();
  // Only the newly created explorer is initialized. Existing role settings are never rewritten.
  checked(await sdk.agents.update({ agentId, memoryPolicy: { enabled: false } }));
  checked(await sdk.agents.updateConfig({ agentId, partial: { models: { chat: { ...initialModel } } } }));
  const memory = await readExplorerMemoryProfile(sdk, agentId);
  const config = checked(await sdk.agents.config({ agentId })).config, row = await readOwn();
  need(config?.models?.chat?.provider === initialModel.provider && config?.models?.chat?.id === initialModel.id);
  need(JSON.stringify(await readExplorerMemoryProfile(sdk, agentId)) === JSON.stringify(memory), 'EXPLORER_PROFILE_UNCONFIRMED');
  const binding = { agentId }; await sdk.storage.global.set(bindingKey, binding);
  need(JSON.stringify(await sdk.storage.global.get(bindingKey, null)) === JSON.stringify(binding));
  const ready = { ...marker, state: 'ready' };
  await sdk.storage.global.set(EXPLORER_CREATION_KEY, ready);
  need(JSON.stringify(await sdk.storage.global.get(EXPLORER_CREATION_KEY, null)) === JSON.stringify(ready));
  return row;
}
export function explorerPersonaBinding(identity, agents) {
  need(typeof identity === 'string' && identity.trim() && typeof agents === 'string' && agents.trim(), 'EXPLORER_PERSONA_UNCONFIRMED');
  return { configuredIdentitySha256: sha(identity), configuredContractSha256: sha(agents) };
}
