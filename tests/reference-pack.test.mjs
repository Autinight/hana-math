import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { adaptContract, CONTRACT_REPLACEMENTS } from '../packages/hana-math/contract-adaptation.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/hana-math');
const read = (p) => fs.readFile(path.join(root, p), 'utf8');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const safe = (p) => typeof p === 'string' && !p.includes('\\') && !p.startsWith('/') && p.split('/').every((x) => x && x !== '.' && x !== '..');
async function files(dir) {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = dir + '/' + entry.name;
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) result.push(...await files(relative)); else result.push(relative);
  }
  return result;
}

test('all original static references and role skills have exact pinned hashes and no executable archives', async () => {
  const map = JSON.parse(await read('reference-sources.json'));
  assert.equal(map.schemaVersion, 1);
  assert.deepEqual(map.source, { gitHead: '839c471d0560b9b5308afc6cbb59a138819fe16c', url: 'https://github.com/frenzymath/Danus' });
  assert.equal(map.files.length, 80);
  assert.equal(new Set(map.files.map((f) => f.target)).size, map.files.length);
  const actual = [...await files('references/danus')];
  for (const role of ['main', 'worker', 'verifier']) actual.push(...await files('roles/' + role + '/skills'));
  assert.deepEqual(actual.sort(), map.files.map((f) => f.target).sort());
  for (const file of map.files) {
    assert.ok(safe(file.source) && safe(file.target));
    assert.equal(sha(await fs.readFile(path.join(root, file.target))), file.sha256, file.target);
    assert.ok(!/(?:^|\/)(?:anchors|examples|driver|local_memory|fact_graph)(?:\/|$)/.test(file.target));
    assert.ok(!/\.(?:py|sh|js|mjs|tex)$/.test(file.target));
  }
});

test('the original glossary is byte-identical to CP1 and explicitly mapped for every role', async () => {
  const map = JSON.parse(await read('reference-sources.json'));
  const source = 'danus/core/glossary_global.json';
  const target = 'references/danus/' + source;
  const expectedHash = 'c2eda900107ccaa7b80eb14cb88c13034799984d270783bc76b2837a9cd41ed2';
  assert.deepEqual(map.files.filter((file) => file.target === target), [{ source, target, sha256: expectedHash }]);
  const bytes = await fs.readFile(path.join(root, target));
  assert.equal(sha(bytes), expectedHash);
  const cp1 = await fs.readFile(path.resolve(root, '../../engine/src/danus/core/glossary_global.json'));
  assert.deepEqual(bytes, cp1);
  for (const role of ['main', 'worker', 'verifier']) {
    assert.deepEqual(map.workspaces[role].filter((item) => item.to === source), [{ from: target, to: source }]);
  }
});

test('role cards register only 1/9/3 original skills and preserve the original prompts', async () => {
  const map = JSON.parse(await read('reference-sources.json'));
  const promptSources = JSON.parse(await read('prompt-sources.json'));
  for (const [role, count] of Object.entries({ main: 1, worker: 9, verifier: 3 })) {
    const card = JSON.parse(await read('roles/' + role + '/card.json'));
    const contract = await read(map.roles[role].contract);
    // D-03: the card carries the upstream contract plus a registered list of
    // environment replacements; nothing else may differ.
    assert.equal(card.prompts.agents, adaptContract(role, contract));
    assert.equal(sha(contract), promptSources.roles[role].sha256);
    assert.equal(sha(card.prompts.agents), promptSources.roles[role].adaptedSha256);
    assert.equal(promptSources.roles[role].adaptation.replacements,
      CONTRACT_REPLACEMENTS[role].filter((r) => r.from !== r.to).length);
    assert.ok(promptSources.roles[role].adaptation.replacements > 0);
    assert.equal(card.prompts.identity, card.prompts.publicAgents);
    // identity is the card's own first body paragraph, which may contain adapted wording.
    assert.ok(card.prompts.agents.startsWith(`# `));
    assert.ok(card.prompts.agents.includes(card.prompts.identity));
    assert.equal(card.skills.bundles.length, 1);
    assert.equal(card.skills.bundles[0].name, 'Danus original skills');
    assert.equal(map.roles[role].skills.length, count);
    assert.deepEqual(card.skills.bundles[0].skills, map.roles[role].skills.map((s) => 'skills/' + s.name));
    for (const skill of map.roles[role].skills) {
      assert.equal(skill.path, `roles/${role}/skills/${skill.name}`);
      assert.ok(!['initialize', 'write-paper', 'human-summary'].includes(skill.name));
      assert.ok((await read(skill.path + '/SKILL.md')).startsWith('---'));
      if (role !== 'main') assert.ok((await read(skill.path + '/agents/openai.yaml')).includes('interface:'));
    }
  }
});

test('workspace maps contain only static snapshots with role-specific AGENTS and canonical-state exclusions', async () => {
  const map = JSON.parse(await read('reference-sources.json'));
  const known = new Set(map.files.map((file) => file.target));
  for (const role of ['main', 'worker', 'verifier']) {
    const items = map.workspaces[role];
    assert.equal(new Set(items.map((m) => m.to)).size, items.length);
    assert.deepEqual(items.find((m) => m.to === 'AGENTS.md'), { from: map.roles[role].contract, to: 'AGENTS.md' });
    for (const { from, to } of items) {
      assert.ok(known.has(from) && safe(to));
      assert.ok(!/^(?:OPERATOR\.md|PROBLEM\.md|TASK\.md|global_memory|fact_graph|local_memory)(?:\/|$)/.test(to));
      if (to.startsWith('.agents/skills/')) assert.ok(map.roles[role].skills.some((s) => to.startsWith('.agents/skills/' + s.name + '/')));
    }
    for (const skill of map.roles[role].skills) assert.ok(items.some((m) => m.from === skill.path + '/SKILL.md' && m.to === `.agents/skills/${skill.name}/SKILL.md`));
  }
  assert.ok(map.unavailableCapabilities.some((s) => s.startsWith('initialize:')));
  assert.ok(map.unavailableCapabilities.some((s) => s.startsWith('human-summary:')));
  assert.ok(map.unavailableCapabilities.some((s) => s.startsWith('write-paper:')));
  assert.match(map.snapshotPolicy, /not user-customization storage/);
});
