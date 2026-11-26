import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPanel, projectAssistants, projectRoles, registerPanel } from '../packages/hana-math/panel-service.mjs';
import { adaptContract, CONTRACT_REPLACEMENTS } from '../packages/hana-math/contract-adaptation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'packages', 'hana-math');
const read = (file) => fs.readFileSync(path.join(app, file), 'utf8');
const cards = ['main', 'worker', 'verifier', 'explorer'].map((id) => ({ id, card: JSON.parse(read(`roles/${id}/card.json`)) }));
const roleRows = () => cards.map(({ id, card }) => ({ roleId: id, appId: 'hana-math', agent: card.agent, prompts: card.prompts }));
const publicAgent = (id, extra = {}) => ({ id, name: id, yuan: 'kong', visibility: 'public', ownerPluginId: null, plugin: { visibility: 'public', ownerPluginId: null }, state: 'active', deletedAt: null, ...extra });
function fakeSdk(agents = []) {
  const calls = [];
  return {
    calls,
    agents: { async list(input) { calls.push(['agents.list', input]); return { agents: input.scope === 'all' ? agents : [] }; } },
    roles: { async list() { calls.push(['roles.list']); return { roles: roleRows() }; } },
    storage: { global: { async get() { return null; } } },
  };
}

test('public active assistants only; primary precedes current; private/unknown metadata never escapes', () => {
  const input = [
    publicAgent('ordinary'), publicAgent('current', { isCurrent: true }), publicAgent('primary', { isPrimary: true }),
    publicAgent('retired', { state: 'retired' }), publicAgent('deleted', { deletedAt: 'fixture-date' }),
    publicAgent('private', { visibility: 'plugin_private' }), publicAgent('legacy-private', { visibility: 'private' }),
    publicAgent('owned', { ownerPluginId: 'other-app' }), publicAgent('nested-private', { plugin: { visibility: 'plugin_private', ownerPluginId: 'other-app' } }),
    publicAgent('unknown', { visibility: 'unknown' }), publicAgent('unknown-owner', { ownerPluginId: undefined }),
    publicAgent('unknown-nested', { plugin: {} }), null, publicAgent(''), publicAgent('ordinary'),
  ];
  const result = projectAssistants({ agents: input });
  assert.deepEqual(result.map(({ id }) => id), ['primary', 'current', 'ordinary']);
  assert.equal(result[1].isCurrent, true);
  assert.equal(Object.hasOwn(result[2], 'isCurrent'), false);
});

test('list projection never includes identity/config/models/prompts or untrusted avatar paths', () => {
  const rows = projectAssistants({ agents: [publicAgent('safe', { name: '<unsafe-name>', identity: 'PRIVATE_IDENTITY', models: { secret: 'PRIVATE_MODEL' }, config: { token: 'PRIVATE_CONFIG' }, avatar: '/untrusted', isCurrent: true, isPrimary: 'not-a-boolean' })] });
  assert.deepEqual(rows, [{ id: 'safe', name: '<unsafe-name>', yuan: 'kong', isCurrent: true }]);
  const roles = projectRoles({ roles: roleRows() });
  assert.deepEqual(roles.map(({ id, name }) => [id, name]), [['main', 'main'], ['worker', 'worker'], ['verifier', 'verifier'], ['explorer', 'math explorer']]);
  assert.doesNotMatch(JSON.stringify({ rows, roles }), /PRIVATE_|prompts|identity|models|config|untrusted/);
});

test('panel uses documented partition, app avatars, own verified instances and fixed role ordering', async () => {
  const sdk = fakeSdk([publicAgent('shiraha'), publicAgent('unknown')]);
  const data = await loadPanel(sdk);
  assert.deepEqual(sdk.calls, [['agents.list', { scope: 'all', lifecycle: 'active' }], ['roles.list'], ['agents.list', { lifecycle: 'all' }]]);
  assert.equal(data.assistants.state, 'ready');
  assert.equal(data.assistants.items[0].avatarSource, 'reference');
  assert.equal(data.assistants.items[0].avatarUrl, './assets/avatars/shiraha.png');
  assert.equal(data.assistants.items[1].avatarSource, 'default');
  assert.deepEqual(data.roles.items.map((item) => [item.id, item.agentId]), [['main', null], ['worker', null], ['verifier', null], ['explorer', null]]);
  assert.ok(data.roles.items.every((item) => item.avatarUrl === './assets/avatars/preset.png'));
});

test('genuine empty list differs from old-host, permission, transport and malformed-list failures', async () => {
  assert.deepEqual((await loadPanel(fakeSdk())).assistants, { state: 'ready', items: [] });
  for (const failure of [() => { throw new Error('PRIVATE_HOST_ERROR'); }, () => ({ agents: null }), () => ({ error: 'unsupported' }),
    () => ({ ok: false, agents: [] }), () => ({ agents: [], error: 'PRIVATE_HOST_ERROR' })]) {
    const sdk = fakeSdk();
    const original = sdk.agents.list;
    sdk.agents.list = async (input) => input.scope === 'all' ? failure() : original(input);
    const result = await loadPanel(sdk);
    assert.deepEqual(result.assistants, { state: 'error', items: [] });
    assert.equal(result.roles.items.length, 4);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_HOST_ERROR/);
  }
  const sdk = fakeSdk([publicAgent('available')]);
  const roles = await sdk.roles.list();
  for (const failure of [() => { throw new Error('OLD_HOST'); }, () => ({ ...roles, ok: false })]) {
    sdk.roles.list = async () => failure();
    const result = await loadPanel(sdk);
    assert.equal(result.assistants.items.length, 1);
    assert.deepEqual(result.roles, { state: 'error', items: [] });
  }
});

test('invalid/foreign/duplicate role templates and forged private bindings fail closed', async () => {
  for (const roles of [[], roleRows().slice(1), [...roleRows(), roleRows()[0]], roleRows().map((row) => ({ ...row, appId: 'other-app' }))]) {
    const sdk = fakeSdk([publicAgent('available')]); sdk.roles.list = async () => ({ roles });
    const data = await loadPanel(sdk);
    assert.deepEqual(data.roles, { state: 'error', items: [] }); assert.equal(data.assistants.items.length, 1);
  }
  const sdk = fakeSdk([publicAgent('available')]);
  sdk.storage.global.get = async (key) => key === 'profile.role.main' ? { agentId: 'foreign' } : null;
  const list = sdk.agents.list;
  sdk.agents.list = async (input) => input.scope === 'all' ? list(input) : { agents: [publicAgent('foreign', { ownerPluginId: 'other' })] };
  assert.deepEqual((await loadPanel(sdk)).roles, { state: 'error', items: [] });
});

test('persisted active role instance supplies the edited name without leaking private config', async () => {
  const sdk = fakeSdk();
  sdk.storage.global.get = async (key) => key === 'profile.role.main' ? { agentId: 'hana-math-main' } : null;
  sdk.agents.list = async (input) => ({ agents: input.scope === 'all' ? [] : [{ id: 'hana-math-main', name: 'Saved Main', state: 'active', ownerPluginId: 'hana-math', visibility: 'plugin_private', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'role', roleId: 'main' }, config: { secret: 'SECRET' } }] });
  const result = await loadPanel(sdk);
  assert.equal(result.roles.items[0].name, 'Saved Main'); assert.equal(result.roles.items[0].agentId, 'hana-math-main');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|config|plugin_private/);
});

test('three read-only CharacterCards pin verbatim Danus static contracts and first paragraphs without a runtime source dependency', () => {
  // These hashes lock decoded UTF-8 prompt bytes; this test never reads a sibling repository.
  const locked = {
    main: ['AGENTS.md', '2a6ba2b3fd4e267e587e90bcc63c45d0f8c73bf16e403b3ba0e18a56673ae975'],
    worker: ['agents/contracts/worker.md', '44576585a4975f4417f0adf78e6ec1bb71be316fde7e4ab182020d831ef8ab19'],
    verifier: ['agents/contracts/verifier.md', '256229a5ee9f95c4d03ec2d1258eb3bb75f78df6e36ac193e870bea4ef32c563'],
  };
  // The upstream hashes above pin the originals. Cards carry the registered
  // environment adaptation (parity D-03), so the byte equality is against it.
  const provenance = JSON.parse(read('prompt-sources.json'));
  assert.equal(provenance.schemaVersion, 1); assert.equal(provenance.sourceRepository, 'Danus');
  assert.deepEqual(Object.keys(provenance.roles).sort(), ['main', 'verifier', 'worker']);
  assert.deepEqual(fs.readdirSync(path.join(app, 'roles')).sort(), ['explorer', 'main', 'verifier', 'worker']);
  // Explorer is separately derived/pinned; it is not inserted into the original verbatim map.
  for (const { id, card } of cards.filter(row => row.id !== 'explorer')) {
    assert.equal(card.kind, 'CharacterCard'); assert.equal(card.schemaVersion, 1);
    assert.equal(card.package.name, `Hana Math · ${id}`);
    assert.deepEqual(card.agent, { id: `math-${id}`, name: id, yuan: 'kong' });
    const [sourcePath, sha256] = locked[id];
    const upstream = readFileSync(path.join(app, 'references/danus', sourcePath), 'utf8');
    assert.equal(createHash('sha256').update(upstream, 'utf8').digest('hex'), sha256, `${id} upstream source is unchanged`);
    assert.deepEqual(provenance.roles[id], { sourcePath, sha256, adaptedSha256: createHash('sha256').update(card.prompts.agents, 'utf8').digest('hex'),
      sourceGitHead: '839c471d0560b9b5308afc6cbb59a138819fe16c', sourceLocallyModified: false,
      adaptation: { module: 'contract-adaptation.mjs', replacements: CONTRACT_REPLACEMENTS[id].filter((r) => r.from !== r.to).length } });
    assert.equal(card.prompts.agents, adaptContract(id, upstream), `${id} is upstream plus the registered replacements only`);
    const firstParagraph = card.prompts.agents.match(/^# [^\n]+\n\n([\s\S]*?)(?:\n\n|$)/)?.[1];
    assert.ok(firstParagraph, `${id} has a complete body paragraph after its title`);
    assert.equal(card.prompts.identity, firstParagraph, `${id} identity is verbatim, not an authored summary`);
    assert.equal(card.prompts.publicAgents, firstParagraph, `${id} publicAgents is the same original paragraph`);
    assert.ok(card.prompts.agents.endsWith('\n'));
    assert.match(card.prompts.agents, /text-only/i);
    assert.equal(Object.hasOwn(card, 'memory'), false); assert.equal(Object.hasOwn(card, 'identity'), false);
    assert.doesNotMatch(JSON.stringify(card), /\/Users\//);
  }
  const verifier = cards.find(({ id }) => id === 'verifier').card.prompts.agents;
  const verdictContract = verifier.match(/- `verdict` \(([^)\n]+)\)/)?.[1];
  assert.ok(verdictContract);
  assert.deepEqual([...verdictContract.matchAll(/"([^"]+)"/g)].map((match) => match[1]), ['correct', 'wrong']);
  assert.ok(verifier.includes('- Return `"correct"` if and only if both `critical_errors` and `gaps` are empty.'));
  assert.ok(verifier.includes('- Otherwise return `"wrong"`.'));
});

test('registration is awaited and exposes only panel plus explicit editor GET/POST routes', async () => {
  const sdk = fakeSdk([publicAgent('available')]); const routes = []; let registered = false;
  sdk.routes = { async register(registrar) {
    registrar({ get(route, handler) { routes.push({ method: 'GET', route, handler }); }, post(route, handler) { routes.push({ method: 'POST', route, handler }); } });
    await Promise.resolve(); registered = true;
  } };
  await registerPanel(sdk);
  assert.equal(registered, true);
  assert.deepEqual(routes.map(({ method, route }) => [method, route]), [['GET', '/panel'], ['GET', '/editor/assistant/:id'], ['POST', '/editor/assistant/:id'], ['GET', '/editor/role/:id'], ['POST', '/editor/role/:id']]);
  const result = await routes[0].handler({ json: (body) => body }); assert.equal(result.assistants.items[0].id, 'available');
});

test('manifest contributes Math settings and exactly one primary dashboard page for Card Center and site navigation', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version); assert.equal(manifest.id, 'hana-math'); assert.equal(manifest.manifestVersion, 2);
  assert.deepEqual(manifest.network, { allowedHosts: ['leansearch.net'], methods: ['POST'], allowLocalhost: false, defaultTimeoutMs: 20000, maxResponseBytes: 1048576 });
  assert.deepEqual(manifest.capabilities, ['app/agents.read', 'app/agents.manage', 'app/resources.read', 'app/resources.write', 'app/runtime.execute', 'app/runtime.native', 'app/runtime.network', 'app/process.spawn', 'app/tools.expose-to-model', 'app/tasks.manage', 'app/session.start-turn', 'app/session.switch-model', 'app/session.thinking-level', 'app/session.tools.configure', 'app/session.stage-file', 'app/sessions.home']);
  assert.deepEqual(Object.keys(manifest.contributes), ['settings', 'cards', 'previewers', 'cliFlags']);
  assert.deepEqual(manifest.contributes.cards, [{
    id: 'research-dashboard-page', title: '研究看板', face: { image: 'assets/cover.svg' },
    route: '/dashboard/workspace.html', realization: 'page', siteNavEntry: true, pageIcon: 'assets/dashboard-nav.svg',
    cardForm: 'edge-to-edge', titleMode: 'hide',
  }]);
  assert.deepEqual(manifest.contributes.previewers, [{
    id: 'factgraph-snapshot', title: 'Hana Math Fact Graph',
    selectors: [{ extensions: ['hanamathgraph'] }], route: '/dashboard/index.html', mode: 'read',
  }, {
    id: 'live-dashboard', title: 'Hana Math Research Dashboard',
    selectors: [{ extensions: ['hanamathboard'] }], route: '/dashboard/live.html', mode: 'read',
  }]);
  assert.deepEqual(manifest.contributes.cliFlags, [{ name: 'core-self-test', type: 'boolean', description: 'Run one offline managed-core diagnostic during explicit validation startup', default: false }]);
  assert.equal(manifest.contributes.settings.ui.route, '/panel.html');
  assert.equal(read('assets/icon.svg').trim(), fs.readFileSync(path.join(root, 'assets/icon.svg'), 'utf8').trim());
  assert.equal(read('ui/assets/cover.svg').trim(), read('assets/icon.svg').trim());
  assert.equal(fs.existsSync(path.join(app, 'tests')), false);
  const entry = read('index.js');
  // Allow only the entry's task-domain copy with the bootstrap handler binding.
  const adapter = /^[ \t]*const runtimeSdk = \{ \.\.\.sdk, tasks: \{ \.\.\.sdk\.tasks, registerHandler: boot\.attachHandler \} \};[ \t]*$/gm;
  assert.equal([...entry.matchAll(adapter)].length, 1, 'entry must wire exactly one bootstrap task adapter');
  const backend = [entry.replace(adapter, ''), read('panel-service.mjs'), read('profile-service.mjs')].join('\n');
  assert.doesNotMatch(backend, /\btasks\b/, 'no other task-domain access, including through runtimeSdk');
  assert.doesNotMatch(backend, /sdk\.(?:tools|tasks|sessions|config|bus)|\/api\/agents|app\/models\.infer|fetch\(|node:fs|setInterval/);
  assert.doesNotMatch(backend, /resources\.(?:materialize|edit|delete)\(/);
  // Agent resource refs and writes are checked behaviorally in profile.test.mjs.
});
