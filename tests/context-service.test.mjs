import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createContextService, createContextStore } from '../packages/hana-math/context-service.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const roles = ['main', 'worker', 'verifier'];
const input = { projectId: 'test-project', problem: '# Software fixture\nNo mathematics.', operatorProfile: 'Fixture operator only', workerTask: 'Read these files; never execute them.' };
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-context-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package'); const dataDir = path.join(root, 'data');
  await fs.mkdir(packageRoot); await fs.mkdir(dataDir);
  const manifest = { schemaVersion: 1, files: [], roles: {}, workspaces: {}, unavailableCapabilities: ['research', 'MCP'] };
  const add = async (target, text) => {
    await fs.mkdir(path.dirname(path.join(packageRoot, target)), { recursive: true });
    await fs.writeFile(path.join(packageRoot, target), text);
    manifest.files.push({ source: `canonical/${target}`, target, sha256: sha(text) });
  };
  await add('references/common.md', '# Common reference\r\nOriginal ${PLACEHOLDER} and $other-skill stay unchanged.\r\n');
  await add('references/glossary_global.json', '{"softwareFixture":true}\n');
  for (const role of roles) {
    await add(`references/${role}.md`, `# ${role} fixture contract\nDo not compute mathematics.\n`);
    await add(`roles/${role}/skills/read-only/SKILL.md`, `---\nname: read-only\ndescription: Software fixture\n---\nRead ../references and ${role} notes.\n`);
    manifest.roles[role] = { contract: `references/${role}.md`, skills: [{ name: 'read-only', path: `roles/${role}/skills/read-only` }] };
    manifest.workspaces[role] = [
      { from: `references/${role}.md`, to: 'AGENTS.md' },
      { from: 'references/common.md', to: 'references/common.md' },
      { from: 'references/glossary_global.json', to: 'danus/core/glossary_global.json' },
      { from: `roles/${role}/skills/read-only/SKILL.md`, to: 'agents/skills/read-only/SKILL.md' },
    ];
  }
  const commit = () => fs.writeFile(path.join(packageRoot, 'reference-sources.json'), JSON.stringify(manifest));
  await commit();
  const service = createContextService({ dataDir }, { packageRoot });
  return { root, packageRoot, dataDir, manifest, add, commit, service, project: path.join(dataDir, 'context/projects/test-project') };
}

test('prepares sibling role workspaces with original static bytes, dynamic archive and one canonical shared root', async (t) => {
  const f = await fixture(t); const prepared = await f.service.prepare(input);
  assert.equal(prepared.state, 'ready'); assert.equal(prepared.reused, false);
  assert.deepEqual(prepared.unavailableCapabilities, ['research', 'MCP']);
  const sharedRoots = [];
  for (const role of roles) {
    const cwd = prepared.roles[role].cwd;
    assert.equal(path.dirname(cwd), path.join(f.project, 'roles'));
    assert.equal(await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8'), `# ${role} fixture contract\nDo not compute mathematics.\n`);
    assert.deepEqual(await fs.readFile(path.join(cwd, 'references/common.md')), await fs.readFile(path.join(f.packageRoot, 'references/common.md')));
    const paths = JSON.parse(await fs.readFile(path.join(cwd, 'PATHS.json'), 'utf8'));
    if (role === 'worker') {
      assert.equal(paths.localMemory, path.join(cwd, 'local_memory'));
      assert.deepEqual(await fs.readdir(paths.localMemory), []);
    } else { assert.equal(paths.localMemory, null); await assert.rejects(fs.lstat(path.join(cwd, 'local_memory')), { code: 'ENOENT' }); }
    sharedRoots.push(paths.shared.root); assert.equal(paths.aliases['fact_graph/'], path.join(f.project, 'shared/fact_graph'));
    await assert.rejects(fs.stat(path.join(cwd, 'fact_graph')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(cwd, 'PROBLEM.md'), 'utf8'), input.problem);
  }
  assert.equal(new Set(sharedRoots).size, 1);
  assert.deepEqual(await fs.readdir(path.join(f.project, 'shared/fact_graph/facts')), []);
  assert.equal((await f.service.inspect(input.projectId)).state, 'ready');
});

test('identical and concurrent requests reuse; different inputs never overwrite an existing project', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.service.prepare(input), f.service.prepare(input)]);
  assert.deepEqual(results.map((result) => result.reused), [false, true]);
  await assert.rejects(f.service.prepare({ ...input, workerTask: 'different' }), { code: 'PROJECT_CONFLICT' });
  assert.equal((await f.service.prepare(input)).reused, true);
});

test('inspect rechecks missing/damaged documents, dynamic input archive and packaged hashes', async (t) => {
  const f = await fixture(t); await f.service.prepare(input);
  const doc = path.join(f.project, 'roles/worker/TASK.md'); await fs.writeFile(doc, 'corrupt');
  const broken = await f.service.inspect(input.projectId);
  assert.equal(broken.state, 'invalid'); assert.ok(broken.issues.some((issue) => issue.path === 'TASK.md' && issue.code === 'FILE_HASH_MISMATCH'));
  await assert.rejects(f.service.prepare(input), { code: 'INCOMPLETE' });
  await fs.writeFile(doc, input.workerTask); await fs.unlink(path.join(f.project, 'roles/main/PROBLEM.md'));
  assert.ok((await f.service.inspect(input.projectId)).issues.some((issue) => issue.code === 'ENOENT'));
  await fs.writeFile(path.join(f.project, 'request.json'), JSON.stringify({ ...input, problem: 'tampered' }));
  assert.equal((await f.service.inspect(input.projectId)).state, 'invalid');
  await fs.writeFile(path.join(f.packageRoot, 'references/common.md'), 'tampered source');
  await assert.rejects(f.service.prepare({ ...input, projectId: 'other-project' }), { code: 'SOURCE_HASH_MISMATCH' });
});

test('unfinished project markers and abandoned directories are never reported ready or silently rebuilt', async (t) => {
  const f = await fixture(t); await f.service.prepare(input);
  const metaPath = path.join(f.project, 'project.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')); meta.state = 'preparing';
  await fs.writeFile(metaPath, JSON.stringify(meta));
  assert.equal((await f.service.inspect(input.projectId)).state, 'incomplete');
  await assert.rejects(f.service.prepare(input), { code: 'INCOMPLETE' });
  await fs.unlink(metaPath); await assert.rejects(f.service.prepare(input), { code: 'INCOMPLETE' });
});

test('probe uses a fresh leaf cwd, file-only nonce and ten required reads including mappings and glossary', async (t) => {
  const f = await fixture(t); await f.service.prepare(input);
  const a = await f.service.prepareProbe({ projectId: input.projectId, role: 'worker' });
  const b = await f.service.prepareProbe({ projectId: input.projectId, role: 'worker' });
  assert.notEqual(a.probeId, b.probeId); assert.notEqual(a.cwd, b.cwd); assert.notEqual(a.expectedNonce, b.expectedNonce);
  assert.equal(a.requiredReadPaths.length, 10);
  for (const name of ['OPERATOR.md', 'CONTEXT.md', 'PATHS.json', 'danus/core/glossary_global.json']) assert.ok(a.requiredReadPaths.includes(path.join(a.cwd, name)));
  assert.deepEqual(await fs.readdir(path.join(a.cwd, 'local_memory')), []);
  assert.deepEqual(await fs.readdir(path.join(b.cwd, 'local_memory')), []);
  assert.ok(a.requiredReadPaths.some((name) => name.endsWith('SKILL.md')));
  assert.ok(a.requiredReadPaths.some((name) => name.endsWith('references/common.md')));
  for (const file of a.files) {
    const text = await fs.readFile(file.path);
    assert.equal(sha(text), file.sha256);
    assert.equal(text.toString().includes(a.expectedNonce), file.kind === 'nonce');
  }
  const paths = JSON.parse(await fs.readFile(path.join(a.cwd, 'PATHS.json')));
  assert.equal(paths.cwd, a.cwd); assert.equal(paths.shared.root, path.join(f.project, 'shared'));
  assert.equal(paths.localMemory, path.join(a.cwd, 'local_memory'));
  assert.deepEqual(Object.keys(a.contractMarkers), roles);
});

test('inspect checks the worker private directory without reading or copying its contents', async (t) => {
  const f = await fixture(t); await f.service.prepare(input);
  const local = path.join(f.project, 'roles/worker/local_memory');
  await fs.writeFile(path.join(local, 'note.txt'), 'private software fixture');
  assert.equal((await f.service.inspect(input.projectId)).state, 'ready');
  const probe = await f.service.prepareProbe({ projectId: input.projectId, role: 'worker' });
  assert.deepEqual(await fs.readdir(path.join(probe.cwd, 'local_memory')), []);
  await fs.rm(local, { recursive: true });
  assert.equal((await f.service.inspect(input.projectId)).state, 'invalid');
  await fs.symlink(path.join(f.project, 'shared'), local);
  assert.ok((await f.service.inspect(input.projectId)).issues.some((issue) => issue.code === 'SYMLINK_REFUSED'));
});

test('rejects invalid inputs, path traversal and canonical-ID ambiguity', async (t) => {
  const f = await fixture(t);
  for (const projectId of ['../escape', '/tmp/no', 'MixedCase', ' a ', 'a/b', 'a\\b', '', 'x'.repeat(65)]) await assert.rejects(f.service.prepare({ ...input, projectId }), { code: 'INVALID_ID' });
  for (const change of [{ problem: '' }, { problem: 'x'.repeat(128 * 1024 + 1) }, { operatorProfile: null }, { extra: true }]) await assert.rejects(f.service.prepare({ ...input, ...change }), { code: 'INVALID_INPUT' });
  assert.equal((await f.service.inspect('unknown')).state, 'missing');
  await assert.rejects(f.service.prepareProbe({ projectId: input.projectId, role: 'main' }), { code: 'PROJECT_NOT_READY' });
});

test('static mappings cannot shadow dynamic keys, shared state or collide by case/prefix', async (t) => {
  const f = await fixture(t); const original = structuredClone(f.manifest.workspaces.main);
  for (const to of ['PROBLEM.md', 'paths.JSON', 'shared/fake', '../outside', 'AGENTS.md/child', 'references/common.md/child']) {
    f.manifest.workspaces.main = [...original, { from: 'references/common.md', to }]; await f.commit();
    await assert.rejects(f.service.prepare(input), (error) => ['TARGET_CONFLICT', 'UNSAFE_PATH'].includes(error.code));
  }
  f.manifest.workspaces.main = [...original, { from: 'references/common.md', to: 'foo' }, { from: 'references/common.md', to: 'foo-bar' }, { from: 'references/common.md', to: 'foo/child' }];
  await f.commit(); await assert.rejects(f.service.prepare(input), { code: 'TARGET_CONFLICT' });
});

test('current packaged reference manifest assembles all three roles in disposable App data', async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-real-references-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const packageRoot = fileURLToPath(new URL('../packages/hana-math/', import.meta.url));
  const service = createContextService({ dataDir }, { packageRoot });
  assert.equal((await service.prepare(input)).state, 'ready');
  for (const role of roles) {
    const probe = await service.prepareProbe({ projectId: input.projectId, role });
    assert.equal(probe.requiredReadPaths.length, 10);
    assert.ok(probe.requiredReadPaths.includes(path.join(probe.cwd, 'danus/core/glossary_global.json')));
    const paths = JSON.parse(await fs.readFile(path.join(probe.cwd, 'PATHS.json'), 'utf8'));
    if (role === 'worker') { assert.equal(paths.localMemory, path.join(probe.cwd, 'local_memory')); assert.deepEqual(await fs.readdir(paths.localMemory), []); }
    else { assert.equal(paths.localMemory, null); await assert.rejects(fs.lstat(path.join(probe.cwd, 'local_memory')), { code: 'ENOENT' }); }
    assert.ok(probe.requiredReadPaths.includes(path.join(probe.cwd, 'ARCHITECTURE.md')));
    assert.equal(await fs.readFile(path.join(probe.cwd, 'READ-PROBE-NONCE.txt'), 'utf8'), probe.expectedNonce);
  }
});

test('assembly works with Node read grants limited to the package/data roots, without parent-directory access', async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL('../packages/hana-math/context-service.mjs', import.meta.url);
  const source = `import {createContextService} from ${JSON.stringify(moduleUrl.href)}; const service = createContextService({dataDir:${JSON.stringify(f.dataDir)}},{packageRoot:${JSON.stringify(f.packageRoot)}}); await service.prepare(${JSON.stringify(input)}); console.log(JSON.stringify(await service.prepareResearchWorkspace({projectId:'test-project',runId:'permission-fixture',role:'worker'})));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--permission', `--allow-fs-read=${fileURLToPath(moduleUrl)}`, `--allow-fs-read=${f.packageRoot}`, `--allow-fs-read=${f.dataDir}`, `--allow-fs-write=${f.dataDir}`, '--input-type=module', '-e', source], { timeout: 20000 });
  assert.equal(JSON.parse(stdout).state, 'ready');
});

test('research workspaces omit injected contracts/automatic Skills, preserve reference bytes and start private notes empty', async (t) => {
  const f = await fixture(t);
  for (const role of roles) f.manifest.workspaces[role].push(
    { from: `roles/${role}/skills/read-only/SKILL.md`, to: '.agents/skills/read-only/SKILL.md' },
    { from: `references/${role}.md`, to: `references/contracts/${role}.md` },
  );
  await f.commit(); await f.service.prepare(input);
  const oldNote = path.join(f.project, 'roles/worker/local_memory/private.txt');
  await fs.writeFile(oldNote, 'Old fixture notes must not be copied', { mode: 0o000 });
  const worker = await f.service.prepareResearchWorkspace({ projectId: input.projectId, runId: 'run-a', role: 'worker' });
  const verifier = await f.service.prepareResearchWorkspace({ projectId: input.projectId, runId: 'run-a', role: 'verifier', verificationId: 'verify-a' });
  const main = await f.service.prepareResearchWorkspace({ projectId: input.projectId, runId: 'run-a', role: 'main' });
  assert.equal(worker.cwd, path.join(f.project, 'research/run-a/worker'));
  assert.equal(verifier.cwd, path.join(f.project, 'research/run-a/verifiers/verify-a'));
  assert.equal(main.cwd, path.join(f.project, 'research/run-a/main')); assert.equal(main.localMemory, null);
  assert.equal(main.verificationId, null); assert.deepEqual(main.shared, worker.shared);
  assert.deepEqual(await fs.readdir(worker.localMemory), []); assert.equal(verifier.localMemory, null);
  assert.deepEqual(verifier.shared, { factGraph: worker.shared.factGraph }); assert.equal(worker.shared.root, path.join(f.project, 'shared'));
  for (const result of [worker, verifier, main]) {
    await assert.rejects(fs.lstat(path.join(result.cwd, 'AGENTS.md')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(result.cwd, '.agents/skills')), { code: 'ENOENT' });
    assert.deepEqual(result.excludedPaths.sort(), ['.agents/skills/read-only/SKILL.md', 'AGENTS.md', ...(result.role === 'verifier' ? ['PROBLEM.md', 'OPERATOR.md', 'TASK.md', 'references/common.md', 'agents/skills/read-only/SKILL.md'] : [])].sort());
    for (const file of result.files) {
      const bytes = await fs.readFile(path.join(result.cwd, file.path)); assert.equal(sha(bytes), file.sha256);
      if (file.source) {
        assert.deepEqual(bytes, await fs.readFile(path.join(f.packageRoot, file.source)));
        assert.equal((await fs.stat(path.join(result.cwd, file.path))).mode & 0o222, 0);
      }
    }
    const paths = JSON.parse(await fs.readFile(path.join(result.cwd, 'PATHS.json')));
    assert.equal(paths.localMemory, result.localMemory); assert.equal(paths.runId, 'run-a'); assert.deepEqual(paths.shared, result.shared);
    for (const [file, key] of [['PROBLEM.md', 'problem'], ['OPERATOR.md', 'operatorProfile'], ['TASK.md', 'workerTask']]) {
      if (result.role === 'verifier') await assert.rejects(fs.lstat(path.join(result.cwd, file)), { code: 'ENOENT' });
      else assert.deepEqual(await fs.readFile(path.join(result.cwd, file)), Buffer.from(input[key]));
    }
    const context = await fs.readFile(path.join(result.cwd, 'CONTEXT.md'), 'utf8');
    assert.match(context, /CP2B/); assert.match(context, /PATHS.json/); assert.match(context, /Mathematics is text-only/); assert.doesNotMatch(context, /\p{Script=Han}/u); assert.match(context, /Hana bounded-run adapter/); assert.doesNotMatch(context, /CP2A|only diagnoses material reading/);
  }
  for (const result of [verifier, main]) await assert.rejects(fs.lstat(path.join(result.cwd, 'local_memory')), { code: 'ENOENT' });
  const mainContext = await fs.readFile(path.join(main.cwd, 'CONTEXT.md'), 'utf8');
  assert.match(mainContext, /No private-notes directory is assigned to main/); assert.match(mainContext, /One planning turn uses math_assign/); assert.match(mainContext, /one result-summary turn/);
  assert.doesNotMatch(mainContext, /The registry bound to the stable sessionId|Mathematics uses text and symbolic reasoning/);
  await fs.writeFile(path.join(main.cwd, 'TASK.md'), 'Keep main dispatch artifacts for caller-started summary');
  await assert.rejects(f.service.prepareResearchWorkspace({ projectId: input.projectId, runId: 'run-a', role: 'main' }), { code: 'RESEARCH_WORKSPACE_CONFLICT' });
  assert.equal(await fs.readFile(path.join(main.cwd, 'TASK.md'), 'utf8'), 'Keep main dispatch artifacts for caller-started summary');
  assert.equal((await f.service.inspect(input.projectId)).state, 'ready');
});

test('assignResearchTask atomically replaces only this run TASK and its receipt hash', async (t) => {
  const f = await fixture(t); await f.service.prepare({ ...input, workerTask: 'opaque initial A' });
  const workspace = await f.service.prepareResearchWorkspace({ projectId: input.projectId, runId: 'run-assign', role: 'worker' });
  const task = '  opaque assigned B\r\n尾部\t';
  const args = { projectId: input.projectId, runId: 'run-assign', task };
  const before = await fs.readFile(path.join(workspace.cwd, 'research-workspace.json'), 'utf8');
  const [one, two] = await Promise.all([f.service.assignResearchTask(args), f.service.assignResearchTask(args)]);
  assert.deepEqual(one, two); assert.equal(one.state, 'ready');
  assert.equal(one.taskFile, 'context/projects/test-project/research/run-assign/worker/TASK.md');
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, one.taskFile)), Buffer.from(task + '\n'));
  const expected = JSON.parse(before); expected.files.find(file => file.path === 'TASK.md').sha256 = sha(task + '\n');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspace.cwd, 'research-workspace.json'))), expected);
  for (const file of expected.files) assert.equal(sha(await fs.readFile(path.join(workspace.cwd, file.path))), file.sha256);
  const next = await f.service.assignResearchTask({ ...args, task: 'opaque C\n' });
  assert.equal(next.sha256, sha('opaque C\n')); assert.equal(await fs.readFile(path.join(workspace.cwd, 'TASK.md'), 'utf8'), 'opaque C\n');
  for (const invalid of [{ ...args, task: '  ' }, { ...args, role: 'main' }, { ...args, path: '/other' }])
    await assert.rejects(f.service.assignResearchTask(invalid), { code: 'INVALID_INPUT' });
  await assert.rejects(f.service.assignResearchTask({ ...args, runId: 'other-run' }), { code: 'ENOENT' });
});

test('research verifier omits dynamic research inputs and memory pointers; main, worker and CP2A stay unchanged', async (t) => {
  const f = await fixture(t);
  const sentinels = { ...input, problem: 'opaque-problem-58cbd3e9\n', operatorProfile: 'opaque-operator-69dce4fa\n', workerTask: 'opaque-task-70edf50b\n' };
  await f.service.prepare(sentinels);
  const verifier = await f.service.prepareResearchWorkspace({ projectId: input.projectId, runId: 'run-input', role: 'verifier', verificationId: 'verify-input' });
  const paths = JSON.parse(await fs.readFile(path.join(verifier.cwd, 'PATHS.json')));
  const factGraph = path.join(f.project, 'shared/fact_graph');
  assert.deepEqual(Object.keys(paths).sort(), ['schemaVersion', 'projectId', 'role', 'cwd', 'shared', 'aliases', 'localMemory', 'runId', 'verificationId'].sort());
  assert.deepEqual(paths.shared, { factGraph }); assert.equal(paths.localMemory, null);
  assert.deepEqual(paths.aliases, { 'fact_graph/': factGraph, 'runtime/projects/<p>/fact_graph/': factGraph });
  assert.deepEqual(verifier.shared, { factGraph }); assert.equal(verifier.localMemory, null);
  const materials = [JSON.stringify(verifier)];
  async function collect(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) await collect(path.join(dir, e.name)); else materials.push(await fs.readFile(path.join(dir, e.name), 'utf8'));
  } }
  await collect(verifier.cwd);
  for (const value of materials) {
    for (const key of ['problem', 'operatorProfile', 'workerTask']) assert.ok(!value.includes(sentinels[key].trim()));
    for (const name of ['PROBLEM.md', 'OPERATOR.md', 'TASK.md']) assert.ok(!value.includes(path.join(verifier.cwd, name)));
  }
  for (const name of ['PROBLEM.md', 'OPERATOR.md', 'TASK.md']) await assert.rejects(fs.lstat(path.join(verifier.cwd, name)), { code: 'ENOENT' });
  const context = await fs.readFile(path.join(verifier.cwd, 'CONTEXT.md'), 'utf8');
  assert.doesNotMatch(context, /PROBLEM\.md|OPERATOR\.md|TASK\.md|global_memory|globalMemory|global-memory/);
  assert.match(context, /Statement\/Proof/); assert.match(context, /math_verification_report/);
  for (const role of ['main', 'worker']) {
    const workspace = await f.service.prepareResearchWorkspace({ projectId: input.projectId, runId: 'run-input', role });
    for (const [name, key] of [['PROBLEM.md', 'problem'], ['OPERATOR.md', 'operatorProfile'], ['TASK.md', 'workerTask']])
      assert.deepEqual(await fs.readFile(path.join(workspace.cwd, name)), Buffer.from(sentinels[key]));
    assert.equal(workspace.shared.globalMemory, path.join(f.project, 'shared/global_memory'));
  }
  const probe = await f.service.prepareProbe({ projectId: input.projectId, role: 'verifier' });
  for (const [name, key] of [['PROBLEM.md', 'problem'], ['OPERATOR.md', 'operatorProfile'], ['TASK.md', 'workerTask']])
    assert.deepEqual(await fs.readFile(path.join(probe.cwd, name)), Buffer.from(sentinels[key]));
  const legacy = path.join(verifier.cwd, 'PROBLEM.md');
  await fs.writeFile(legacy, 'opaque existing workspace input');
  await assert.rejects(f.service.prepareResearchWorkspace({ projectId: input.projectId, runId: 'run-input', role: 'verifier', verificationId: 'verify-input' }), { code: 'RESEARCH_WORKSPACE_CONFLICT' });
  assert.equal(await fs.readFile(legacy, 'utf8'), 'opaque existing workspace input');
});

test('research verifier keeps only its contract, three verify skill references, glossary and license', async (t) => {
  const f = await fixture(t), keep = new Map([
    ['agents/contracts/verifier.md', 'references/verifier.md'],
    ['danus/core/glossary_global.json', 'references/glossary_global.json'],
    ['LICENSE', 'references/danus/LICENSE'],
  ]);
  await f.add('references/danus/LICENSE', 'opaque license fixture\n');
  for (const skill of ['check-referenced-statements', 'synthesize-verification-report', 'verify-sequential-statements']) {
    for (const leaf of ['SKILL.md', 'agents/openai.yaml']) {
      const target = `agents/skills/verify/${skill}/${leaf}`, source = `references/danus/${target}`;
      await f.add(source, `opaque verification reference ${skill} ${leaf}\n`); keep.set(target, source);
    }
  }
  for (const [to, from] of keep) if (to !== 'danus/core/glossary_global.json') f.manifest.workspaces.verifier.push({ from, to });
  for (const [to, from] of [['agents/contracts/main_agent.md', 'references/main.md'], ['agents/contracts/worker.md', 'references/worker.md'],
    ['agents/skills/worker/read-only/SKILL.md', 'roles/worker/skills/read-only/SKILL.md'], ['references/write-paper/README.md', 'references/common.md']])
    f.manifest.workspaces.verifier.push({ from, to });
  await f.commit(); await f.service.prepare(input);
  const v = await f.service.prepareResearchWorkspace({ projectId: input.projectId, runId: 'run-static', role: 'verifier', verificationId: 'verify-static' });
  assert.deepEqual(v.files.filter(f => f.kind !== 'dynamic').map(f => f.path).sort(), [...keep.keys()].sort());
  for (const [to, from] of keep) assert.deepEqual(await fs.readFile(path.join(v.cwd, to)), await fs.readFile(path.join(f.packageRoot, from)));
  for (const excluded of ['AGENTS.md', '.agents/skills', 'agents/contracts/main_agent.md', 'agents/contracts/worker.md',
    'agents/skills/worker/read-only/SKILL.md', 'references/write-paper/README.md', 'references/common.md'])
    await assert.rejects(fs.lstat(path.join(v.cwd, excluded)), { code: 'ENOENT' });
  const probe = await f.service.prepareProbe({ projectId: input.projectId, role: 'verifier' });
  assert.deepEqual(await fs.readFile(path.join(probe.cwd, 'agents/contracts/worker.md')), await fs.readFile(path.join(f.packageRoot, 'references/worker.md')));
});

test('workspace generators emit English adapter context and preserve multilingual user input bytes', async (t) => {
  const f = await fixture(t);
  const supplied = { ...input, problem: '题面原文\n保留换行\n', operatorProfile: '操作者原文', workerTask: '任务原文' };
  const prepared = await f.service.prepare(supplied);
  assert.equal(prepared.state, 'ready');
  const probe = await f.service.prepareProbe({ projectId: supplied.projectId, role: 'worker' });
  const research = await f.service.prepareResearchWorkspace({ projectId: supplied.projectId, runId: 'run-language', role: 'worker' });
  for (const workspace of [probe, research]) {
    for (const [file, key] of [['PROBLEM.md', 'problem'], ['OPERATOR.md', 'operatorProfile'], ['TASK.md', 'workerTask']])
      assert.deepEqual(await fs.readFile(path.join(workspace.cwd, file)), Buffer.from(supplied[key]));
    const context = await fs.readFile(path.join(workspace.cwd, 'CONTEXT.md'), 'utf8');
    assert.doesNotMatch(context, /\p{Script=Han}/u); assert.match(context, /Hana .*adapter/);
  }
});

test('research workspace IDs are bounded and existing or concurrent destinations are never overwritten', async (t) => {
  const f = await fixture(t); await f.service.prepare(input);
  const request = { projectId: input.projectId, runId: 'run-a', role: 'worker' };
  const results = await Promise.allSettled([f.service.prepareResearchWorkspace(request), f.service.prepareResearchWorkspace(request)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'RESEARCH_WORKSPACE_CONFLICT');
  const result = results.find((result) => result.status === 'fulfilled').value;
  await fs.writeFile(path.join(result.cwd, 'TASK.md'), 'Keep previous run contents');
  await assert.rejects(f.service.prepareResearchWorkspace(request), { code: 'RESEARCH_WORKSPACE_CONFLICT' });
  assert.equal(await fs.readFile(path.join(result.cwd, 'TASK.md'), 'utf8'), 'Keep previous run contents');
  for (const change of [{ runId: '../outside' }, { runId: 'Uppercase' }, { role: 'verifier', verificationId: '../outside' }, { role: 'verifier' }, { role: 'observer' }, { role: 'main', verificationId: 'unexpected' }, { verificationId: 'unexpected' }, { cwd: '/arbitrary' }]) {
    await assert.rejects(f.service.prepareResearchWorkspace({ ...request, ...change }), (error) => ['INVALID_INPUT', 'INVALID_ID', 'INVALID_ROLE'].includes(error.code));
  }
});

test('research rejects inherited contracts/auto Skills, symlink parents and changed source/project integrity', async (t) => {
  const f = await fixture(t); await f.service.prepare(input);
  const request = { projectId: input.projectId, runId: 'run-a', role: 'worker' };
  const researchRoot = path.join(f.project, 'research'); await fs.mkdir(researchRoot);
  await fs.writeFile(path.join(researchRoot, 'AGENTS.md'), '# Unexpected inherited contract');
  await assert.rejects(f.service.prepareResearchWorkspace(request), { code: 'INHERITED_CONTRACT' });
  await fs.unlink(path.join(researchRoot, 'AGENTS.md'));
  await fs.mkdir(path.join(researchRoot, '.agents/skills'), { recursive: true });
  await assert.rejects(f.service.prepareResearchWorkspace(request), { code: 'INHERITED_SKILLS' });
  await fs.rm(path.join(researchRoot, '.agents'), { recursive: true });
  await fs.symlink(f.root, path.join(researchRoot, '.agents'));
  await assert.rejects(f.service.prepareResearchWorkspace(request), { code: 'SYMLINK_REFUSED' });
  await fs.unlink(path.join(researchRoot, '.agents'));
  await fs.symlink(f.root, path.join(researchRoot, 'outside'));
  await assert.rejects(f.service.prepareResearchWorkspace({ ...request, runId: 'outside' }), { code: 'SYMLINK_REFUSED' });
  await fs.writeFile(path.join(f.project, 'roles/worker/TASK.md'), 'corrupt');
  await assert.rejects(f.service.prepareResearchWorkspace(request), { code: 'PROJECT_NOT_READY' });
  await fs.writeFile(path.join(f.project, 'roles/worker/TASK.md'), input.workerTask);
  await fs.writeFile(path.join(f.packageRoot, 'references/common.md'), 'source changed');
  await assert.rejects(f.service.prepareResearchWorkspace(request), { code: 'PROJECT_NOT_READY' });
});

test('packaged main/worker keep all non-automatic references and verifier keeps exactly its nine original reference files', async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-research-references-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const packageRoot = fileURLToPath(new URL('../packages/hana-math/', import.meta.url));
  const service = createContextService({ dataDir }, { packageRoot }); await service.prepare(input);
  const inventory = JSON.parse(await fs.readFile(path.join(packageRoot, 'reference-sources.json')));
  for (const role of roles) {
    const result = await service.prepareResearchWorkspace({ projectId: input.projectId, runId: 'real-material-fixture', role, ...(role === 'verifier' ? { verificationId: 'verify-a' } : {}) });
    const verifierPaths = ['agents/contracts/verifier.md', 'danus/core/glossary_global.json', 'LICENSE',
      ...['check-referenced-statements', 'synthesize-verification-report', 'verify-sequential-statements']
        .flatMap(skill => ['SKILL.md', 'agents/openai.yaml'].map(leaf => `agents/skills/verify/${skill}/${leaf}`))];
    const expected = inventory.workspaces[role].filter((entry) => role === 'verifier' ? verifierPaths.includes(entry.to)
      : entry.to !== 'AGENTS.md' && !entry.to.startsWith('.agents/skills/'));
    if (role === 'verifier') assert.equal(expected.length, 9);
    assert.deepEqual(result.files.filter((file) => file.source).map(file => file.path).sort(), expected.map(entry => entry.to).sort());
    for (const entry of expected) assert.equal(sha(await fs.readFile(path.join(result.cwd, entry.to))), inventory.files.find((file) => file.target === entry.from).sha256);
  }
});

test('context-store remove validates parent paths, removes only files and tolerates missing files', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-context-store-remove-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), outside = path.join(root, 'outside');
  await fs.mkdir(dataDir); await fs.mkdir(outside);
  const store = createContextStore(dataDir);
  await store.write('reports/clean.md', 'opaque report');
  await store.remove('reports/clean.md');
  await store.remove('reports/missing.md');
  await assert.rejects(fs.lstat(path.join(dataDir, 'reports/clean.md')), { code: 'ENOENT' });
  await fs.writeFile(path.join(outside, 'private.txt'), 'must remain untouched');
  await fs.symlink(outside, path.join(dataDir, 'reports/link-parent'));
  await assert.rejects(store.remove('reports/link-parent/private.txt'), { code: 'SYMLINK_REFUSED' });
  assert.equal(await fs.readFile(path.join(outside, 'private.txt'), 'utf8'), 'must remain untouched');
  await fs.mkdir(path.join(dataDir, 'reports/directory'));
  await assert.rejects(store.remove('reports/directory'), { code: 'INVALID_FILE' });
});

test('package and data symlinks are refused; ancestor AGENTS invalidates a prepared workspace', async (t) => {
  const f = await fixture(t); const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  const source = path.join(f.packageRoot, 'references/common.md');
  await fs.rename(source, path.join(outside, 'common.md')); await fs.symlink(path.join(outside, 'common.md'), source);
  await assert.rejects(f.service.prepare(input), { code: 'SYMLINK_REFUSED' });
  await fs.unlink(source); await fs.rename(path.join(outside, 'common.md'), source);
  await fs.rename(f.dataDir, path.join(f.root, 'original-data')); await fs.symlink(outside, f.dataDir);
  await assert.rejects(f.service.prepare(input), { code: 'SYMLINK_REFUSED' });
  await fs.unlink(f.dataDir); await fs.rename(path.join(f.root, 'original-data'), f.dataDir);
  await f.service.prepare(input);
  await fs.writeFile(path.join(f.project, 'roles/AGENTS.md'), '# unexpected main parent');
  assert.equal((await f.service.inspect(input.projectId)).state, 'invalid');
  await fs.unlink(path.join(f.project, 'roles/AGENTS.md'));
  const task = path.join(f.project, 'roles/worker/TASK.md'); await fs.unlink(task); await fs.symlink(source, task);
  assert.ok((await f.service.inspect(input.projectId)).issues.some((issue) => issue.code === 'SYMLINK_REFUSED'));
});
