import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildStage, collectFiles, parseArgs } from '../scripts/build-cp2a.mjs';
const sha = (data) => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cp2a-build-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), python = path.join(root, 'python');
  async function put(base, rel, data, mode = 0o644) {
    const file = path.join(base, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    await fs.chmod(file, mode);
    return file;
  }
  // Software fixture only: this is a header, never an executable Python runtime.
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x0100000c, 4);
  await put(python, 'bin/python3', binary, 0o755);
  await put(python, 'BUILD', 'simulated-build\n');
  await put(python, 'lib/python3.12/os.py', '# simulated stdlib\n');
  await put(python, 'lib/python3.12/LICENSE.txt', 'simulated PSF license fixture\n');
  await put(python, 'include/python3.12/patchlevel.h', '#define PY_VERSION "3.12.14"\n');
  await put(python, 'site-packages/mcp/server.py', 'exclude');
  await put(python, 'lib/python3.12/site-packages/fastapi/__init__.py', 'exclude');
  await put(python, 'lib/python3.12/tests/test_fixture.py', 'exclude');
  await put(python, 'lib/python3.12/__pycache__/cache.pyc', 'exclude');
  await put(python, 'bin/pip3', 'exclude', 0o755);
  await put(python, 'lib/python3.12/ensurepip/_bundled/pip-fixture.whl', 'exclude installer payload');
  await put(repo, 'packages/hana-math/manifest.json', '{"id":"hana-math"}\n');
  await put(repo, 'packages/hana-math/index.js', '// simulated App, no runtime implementation required\n');
  await put(repo, 'packages/hana-math/sdk/data.txt', 'package resource');
  await put(repo, 'engine/src/danus/core/glossary_global.json', '{}\n');
  await put(repo, 'engine/src/hana_math_engine/__init__.py', '"""simulated core"""\n');
  await put(repo, 'engine/LICENSE', 'simulated Apache license fixture');
  await put(repo, 'engine/UPSTREAM.json', '{}\n');
  await put(repo, 'engine/RESEARCH_UPSTREAM.json', '{"schemaVersion":1}\n');
  const inventory = path.join(root, 'inventory.json');
  async function lock() {
    const files = [];
    for (const f of await collectFiles(python, () => true)) files.push({ path: 'dependencies/python/' + f.relative, sha256: sha(await fs.readFile(f.source)), mode: '0o' + f.mode.toString(8), size: f.size });
    await fs.writeFile(inventory, JSON.stringify({ architecture: 'darwin-arm64', files }));
  }
  await lock();
  const out = path.join(repo, 'dist/staging/fixture/hana-math');
  return { root, repo, python, inventory, out, lock, put, options: { repoRoot: repo, pythonSource: python, pythonInventory: inventory, out } };
}

test('requires explicit inputs, rejects duplicate/unknown flags and never discovers system Python', () => {
  assert.throws(() => parseArgs([]), /required/);
  assert.throws(() => parseArgs(['--python-source', 'x', '--python-source', 'y']), /unique/);
  assert.throws(() => parseArgs(['--system-python', 'python3']), /unique/);
  assert.deepEqual(parseArgs(['--python-source', 'p', '--python-inventory', 'i', '--out', 'o']), { pythonSource: 'p', pythonInventory: 'i', out: 'o' });
});

test('stages only allowed runtime files with modes, legal files and honest local inventory', async (t) => {
  const f = await fixture(t);
  const result = await buildStage(f.options);
  assert.equal(result.output, f.out);
  const runtime = JSON.parse(await fs.readFile(path.join(f.out, 'dependencies/runtime.json')));
  assert.equal(runtime.platform, 'darwin'); assert.equal(runtime.arch, 'arm64');
  assert.equal(runtime.pythonVersion, '3.12.14');
  assert.equal(runtime.executable, 'dependencies/python/bin/python3');
  assert.equal('files' in runtime, false);
  assert.equal(runtime.pythonInventory.path, 'dependencies/python-inventory.json');
  const pythonInventoryBytes = await fs.readFile(path.join(f.out, runtime.pythonInventory.path));
  assert.equal(sha(pythonInventoryBytes), runtime.pythonInventory.sha256);
  const pythonInventory = JSON.parse(pythonInventoryBytes);
  assert.equal(pythonInventory.schemaVersion, 1);
  assert.equal(pythonInventory.platform, 'darwin');
  assert.equal(pythonInventory.arch, 'arm64');
  assert.equal(result.pythonFiles, pythonInventory.files.length);
  assert.deepEqual(runtime.originalDownload, { url: null, sha256: null });
  assert.ok(runtime.provenanceLimitations.some((s) => s.includes('third-party')));
  assert.equal((await fs.stat(path.join(f.out, runtime.executable))).mode & 0o777, 0o755);
  assert.equal(await fs.readFile(path.join(f.out, 'dependencies/python-source-inventory.json'), 'utf8'), await fs.readFile(f.inventory, 'utf8'));
  const files = await collectFiles(f.out, () => true);
  assert.ok(files.some((s) => s.relative === 'engine/src/hana_math_engine/__init__.py'));
  assert.ok(files.some((s) => s.relative === 'engine/LICENSE'));
  assert.equal(await fs.readFile(path.join(f.out, 'engine/RESEARCH_UPSTREAM.json'), 'utf8'), '{"schemaVersion":1}\n');
  assert.ok(files.some((s) => s.relative.endsWith('LICENSE.txt')));
  assert.ok(!files.some((s) => /site-packages|__pycache__|ensurepip|\.whl$|bin\/pip|\/tests\/|Codex/.test(s.relative)));
  for (const file of files) assert.ok(!(await fs.readFile(file.source)).includes(Buffer.from(f.root)));
  const inventory = JSON.parse(await fs.readFile(path.join(f.out, 'build-inventory.json')));
  for (const file of inventory.files) assert.equal(sha(await fs.readFile(path.join(f.out, file.path))), file.sha256);
  await assert.rejects(buildStage(f.options), /already exists/);
});

test('a thousand-file Python inventory keeps the bridge descriptor below 16 KiB with a verified reference', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 1000; i++) await f.put(f.python, `lib/python3.12/fixture/file-${i}.py`, '# opaque software fixture\n');
  await f.lock();
  const result = await buildStage(f.options);
  const descriptorBytes = await fs.readFile(path.join(f.out, 'dependencies/runtime.json'));
  assert.ok(descriptorBytes.length < 16384, `descriptor is ${descriptorBytes.length} bytes`);
  const descriptor = JSON.parse(descriptorBytes);
  assert.equal('files' in descriptor, false);
  assert.equal(descriptor.pythonInventory.path, 'dependencies/python-inventory.json');
  const bytes = await fs.readFile(path.join(f.out, descriptor.pythonInventory.path));
  assert.equal(sha(bytes), descriptor.pythonInventory.sha256);
  const inventory = JSON.parse(bytes);
  assert.deepEqual(Object.keys(inventory).sort(), ['arch', 'files', 'platform', 'schemaVersion']);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.platform, 'darwin');
  assert.equal(inventory.arch, 'arm64');
  assert.ok(inventory.files.length >= 1000);
  assert.equal(result.pythonFiles, inventory.files.length);
  for (const file of inventory.files) {
    const target = path.join(f.out, file.path);
    assert.equal(sha(await fs.readFile(target)), file.sha256);
    assert.equal((await fs.stat(target)).mode & 0o777, Number.parseInt(file.mode.slice(2), 8));
  }
  assert.equal(descriptor.sourceInventorySha256, sha(await fs.readFile(f.inventory)));
  const full = JSON.parse(await fs.readFile(path.join(f.out, 'build-inventory.json')));
  assert.equal(full.files.find((file) => file.path === descriptor.pythonInventory.path).sha256, sha(bytes));
  assert.equal(full.files.find((file) => file.path === 'dependencies/runtime.json').sha256, sha(descriptorBytes));
});

for (const kind of ['hash', 'mode', 'missing', 'unlisted', 'version', 'architecture', 'executable', 'source-path']) {
  test('fails before staging on invalid input: ' + kind, async (t) => {
    const f = await fixture(t);
    const osFile = path.join(f.python, 'lib/python3.12/os.py');
    if (kind === 'hash') await fs.appendFile(osFile, 'tampered');
    if (kind === 'mode') await fs.chmod(osFile, 0o755);
    if (kind === 'missing') await fs.rm(osFile);
    if (kind === 'unlisted') await f.put(f.python, 'lib/new.py', '# unlisted');
    if (kind === 'version') { await f.put(f.python, 'include/python3.12/patchlevel.h', '#define PY_VERSION "3.13.0"'); await f.lock(); }
    if (kind === 'architecture') { const inv = JSON.parse(await fs.readFile(f.inventory)); inv.architecture = 'linux-x64'; await fs.writeFile(f.inventory, JSON.stringify(inv)); }
    if (kind === 'executable') { await f.put(f.python, 'bin/python3', '# not a native runtime', 0o755); await f.lock(); }
    if (kind === 'source-path') { await f.put(f.python, 'lib/python3.12/config.py', 'prefix=' + f.python); await f.lock(); }
    await assert.rejects(buildStage(f.options));
    await assert.rejects(fs.stat(f.out), { code: 'ENOENT' });
  });
}

test('internal symlinks are verified and materialized while escapes and cycles fail closed', async (t) => {
  const f = await fixture(t);
  await fs.symlink('python3', path.join(f.python, 'bin/python'));
  await f.lock();
  await buildStage(f.options);
  assert.equal((await fs.lstat(path.join(f.out, 'dependencies/python/bin/python'))).isSymbolicLink(), false);
  const g = await fixture(t);
  await fs.symlink(g.root, path.join(g.python, 'lib/escape'));
  await assert.rejects(buildStage(g.options), /escapes/);
  await fs.unlink(path.join(g.python, 'lib/escape'));
  await fs.symlink('.', path.join(g.python, 'lib/cycle'));
  await assert.rejects(buildStage(g.options), /cyclic/);
});

test('App symlink escape and output traversal/symlink cannot write outside staging', async (t) => {
  const f = await fixture(t);
  await assert.rejects(buildStage({ ...f.options, out: path.join(f.root, 'outside') }), /output must/);
  await fs.symlink(f.python, path.join(f.repo, 'packages/hana-math/escape'));
  await assert.rejects(buildStage(f.options), /escapes/);
  await fs.unlink(path.join(f.repo, 'packages/hana-math/escape'));
  await fs.mkdir(path.join(f.repo, 'dist'), { recursive: true });
  await fs.symlink(f.root, path.join(f.repo, 'dist/staging'));
  await assert.rejects(buildStage(f.options), /unsafe output/);
});

test('inventories with traversal, duplicate entries or missing legal files are refused', async (t) => {
  for (const kind of ['traversal', 'duplicate', 'license']) {
    const f = await fixture(t);
    const inv = JSON.parse(await fs.readFile(f.inventory));
    if (kind === 'traversal') inv.files[0].path = '../escape';
    if (kind === 'duplicate') inv.files.push(inv.files[0]);
    if (kind === 'license') { await fs.rm(path.join(f.python, 'lib/python3.12/LICENSE.txt')); inv.files = inv.files.filter((file) => !file.path.endsWith('LICENSE.txt')); }
    await fs.writeFile(f.inventory, JSON.stringify(inv));
    await assert.rejects(buildStage(f.options));
    await assert.rejects(fs.stat(f.out), { code: 'ENOENT' });
  }
});
