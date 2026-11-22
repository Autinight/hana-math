#!/usr/bin/env node
/** Offline CP2A staging only. Never installs, launches Python/models, or packs Hana. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'dependencies/python/';
const EXCLUDED = new Set(['.git', 'node_modules', '__pycache__', '.pytest_cache', 'tests', 'test', 'testing', 'site-packages', 'pip', 'ensurepip', 'setuptools', 'wheel', 'Codex', 'codex']);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const inside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const relativeSafe = (value) => typeof value === 'string' && value && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') && value.split('/').every((p) => p && p !== '.' && p !== '..');
const skip = (rel) => rel.split('/').some((p) => EXCLUDED.has(p) || p === '.env' || p.startsWith('.env.') || p === 'auth.json' || p === 'monitor-auth-token') || /\.(?:pyc|pyo|pth|egg-link|whl)$/.test(rel);

export function pythonAllowed(rel) {
  if (!relativeSafe(rel) || skip(rel)) return false;
  if (rel === 'BUILD') return true;
  if (rel === 'bin') return true;
  if (rel.startsWith('bin/')) return /^bin\/python(?:3(?:\.12)?)?$/.test(rel);
  if (rel === 'lib' || rel.startsWith('lib/')) return true;
  return /^(?:LICENSE(?:\.txt)?|COPYING|NOTICE)$/.test(rel) || rel === 'licenses' || rel.startsWith('licenses/');
}

/** Resolve internal links only; materialize plain files, preserving ordinary modes. */
export async function collectFiles(root, allowed = (rel) => !skip(rel)) {
  root = await fs.realpath(root);
  const files = [];
  async function visit(logical, rel, ancestors) {
    if (rel && !allowed(rel)) return;
    const actual = await fs.realpath(logical);
    if (!inside(root, actual)) throw new Error('source symlink escapes allowed root');
    const stat = await fs.stat(actual);
    if (stat.isDirectory()) {
      if (ancestors.has(actual)) throw new Error('cyclic source directory');
      const next = new Set([...ancestors, actual]);
      for (const name of (await fs.readdir(actual)).sort()) await visit(path.join(actual, name), rel ? rel + '/' + name : name, next);
    } else if (stat.isFile()) {
      const mode = stat.mode & 0o7777;
      if (mode & 0o7000) throw new Error('special permission bits refused');
      files.push({ source: actual, relative: rel, mode, size: stat.size });
    } else throw new Error('nonregular source file refused');
  }
  await visit(root, '', new Set());
  return files;
}

async function absent(target) {
  try { await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('output already exists; refusing overwrite');
}
async function checkParents(root, target) {
  let current = root;
  for (const part of path.relative(root, path.dirname(target)).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe output parent');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function assertNoSourcePaths(data, sources) {
  for (const source of sources) if (data.includes(Buffer.from(source))) throw new Error('absolute development/source path in staged bytes');
}

export async function buildStage({ pythonSource, pythonInventory, out, repoRoot = REPO }) {
  if (!pythonSource || !pythonInventory || !out) throw new Error('--python-source, --python-inventory and --out are required');
  repoRoot = await fs.realpath(repoRoot);
  const output = path.resolve(out);
  const relOut = path.relative(repoRoot, output).split(path.sep).join('/');
  if (!/^dist\/staging\/[A-Za-z0-9][A-Za-z0-9._-]*\/hana-math$/.test(relOut)) throw new Error('output must be dist/staging/<buildid>/hana-math inside this repository');
  await absent(output);
  await checkParents(repoRoot, output);
  const pythonRoot = await fs.realpath(pythonSource);
  const inventoryBytes = await fs.readFile(pythonInventory);
  const inventory = JSON.parse(inventoryBytes);
  if (inventory.architecture !== 'darwin-arm64' || !Array.isArray(inventory.files)) throw new Error('only a darwin-arm64 Python inventory is supported');
  const sourceEntries = new Map();
  for (const entry of inventory.files) {
    if (!relativeSafe(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^0o[0-7]{3,4}$/.test(entry.mode)) throw new Error('invalid source inventory entry');
    if (sourceEntries.has(entry.path)) throw new Error('duplicate source inventory path');
    sourceEntries.set(entry.path, entry);
  }
  const pythonFiles = await collectFiles(pythonRoot, pythonAllowed);
  const present = new Set(pythonFiles.map((f) => f.relative));
  for (const key of sourceEntries.keys()) {
    if (key.startsWith(PREFIX) && pythonAllowed(key.slice(PREFIX.length)) && !present.has(key.slice(PREFIX.length))) throw new Error('inventory Python file is missing');
  }
  for (const needed of ['BUILD', 'bin/python3', 'lib/python3.12/os.py', 'lib/python3.12/LICENSE.txt']) if (!present.has(needed)) throw new Error('required Python runtime/legal file missing: ' + needed);
  // Version is evidenced by a hash-checked upstream header, not guessed from PATH.
  const headerRel = 'include/python3.12/patchlevel.h';
  const headerPath = await fs.realpath(path.join(pythonRoot, headerRel));
  if (!inside(pythonRoot, headerPath)) throw new Error('version header escapes Python root');
  const header = await fs.readFile(headerPath);
  if (hash(header) !== sourceEntries.get(PREFIX + headerRel)?.sha256 || !/#define\s+PY_VERSION\s+"3\.12\.14"/.test(header.toString('utf8'))) throw new Error('unverified or unsupported Python version');
  const sourcePaths = [repoRoot, pythonRoot];
  const plans = [];
  for (const file of pythonFiles) {
    const bytes = await fs.readFile(file.source);
    const entry = sourceEntries.get(PREFIX + file.relative);
    if (!entry || hash(bytes) !== entry.sha256 || file.mode !== Number.parseInt(entry.mode.slice(2), 8)) throw new Error('Python inventory hash/mode mismatch: ' + file.relative);
    assertNoSourcePaths(bytes, sourcePaths);
    if (file.relative === 'bin/python3') {
      if (!(file.mode & 0o111) || bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) throw new Error('Python executable is not executable Mach-O arm64');
    }
    plans.push({ ...file, target: PREFIX + file.relative, sha256: entry.sha256 });
  }
  for (const [root, prefix] of [[path.join(repoRoot, 'packages/hana-math'), ''], [path.join(repoRoot, 'engine/src'), 'engine/src/']]) {
    for (const file of await collectFiles(root)) {
      if (!prefix && /^(?:dependencies|engine)(?:\/|$)/.test(file.relative)) throw new Error('App source overlaps generated runtime subtree');
      const bytes = await fs.readFile(file.source);
      assertNoSourcePaths(bytes, sourcePaths);
      plans.push({ ...file, target: prefix + file.relative, sha256: hash(bytes) });
    }
  }
  // Retain the core's license/provenance in addition to the Python legal files.
  for (const name of ['LICENSE', 'UPSTREAM.json', 'RESEARCH_UPSTREAM.json']) {
    const source = path.join(repoRoot, 'engine', name);
    const bytes = await fs.readFile(source);
    assertNoSourcePaths(bytes, sourcePaths);
    plans.push({ source, target: 'engine/' + name, mode: 0o644, sha256: hash(bytes), size: bytes.length });
  }
  assertNoSourcePaths(inventoryBytes, sourcePaths);
  if (new Set(plans.map((f) => f.target)).size !== plans.length) throw new Error('duplicate staged target');
  const pythonFileInventory = {
    schemaVersion: 1, platform: 'darwin', arch: 'arm64',
    files: plans.filter((f) => f.target.startsWith(PREFIX)).map((f) => ({ path: f.target, sha256: f.sha256, mode: '0o' + f.mode.toString(8), size: f.size })),
  };
  const pythonInventoryBytes = Buffer.from(JSON.stringify(pythonFileInventory, null, 2) + '\n');
  const runtime = {
    schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3',
    sourceDescription: 'Local Danus 0.2.6 staging Python tree, checked against its supplied build inventory; not an original-download provenance claim.',
    sourceInventory: 'dependencies/python-source-inventory.json', sourceInventorySha256: hash(inventoryBytes),
    originalDownload: { url: null, sha256: null },
    provenanceLimitations: ['Original Python download URL and archive checksum were not found.', 'PSF LICENSE.txt retained; completeness of third-party notices for the standalone build (including Tcl/Tk and linked libraries) is not established.'],
    versionEvidence: { path: headerRel, sha256: hash(header) },
    pythonInventory: { path: 'dependencies/python-inventory.json', sha256: hash(pythonInventoryBytes) },
  };
  // The runtime bridge reads only this bounded descriptor, not the file list.
  const runtimeBytes = Buffer.from(JSON.stringify(runtime, null, 2) + '\n');
  if (runtimeBytes.length >= 16384) throw new Error('runtime descriptor exceeds the bridge JSON budget');
  // All selected inputs have passed verification before any output is created.
  await fs.mkdir(path.dirname(output), { recursive: true });
  await checkParents(repoRoot, output);
  await fs.mkdir(output); // no recursive overwrite at the package boundary
  try {
    for (const file of plans) {
      const bytes = await fs.readFile(file.source);
      if (hash(bytes) !== file.sha256) throw new Error('source changed during staging');
      const target = path.join(output, file.target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: file.mode });
      await fs.chmod(target, file.mode);
    }
    await fs.writeFile(path.join(output, 'dependencies/python-source-inventory.json'), inventoryBytes, { flag: 'wx', mode: 0o644 });
    await fs.writeFile(path.join(output, 'dependencies/python-inventory.json'), pythonInventoryBytes, { flag: 'wx', mode: 0o644 });
    await fs.writeFile(path.join(output, 'dependencies/runtime.json'), runtimeBytes, { flag: 'wx', mode: 0o644 });
    const files = [];
    for (const file of await collectFiles(output, () => true)) files.push({ path: file.relative, size: file.size, mode: '0o' + file.mode.toString(8), sha256: hash(await fs.readFile(file.source)) });
    await fs.writeFile(path.join(output, 'build-inventory.json'), JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', files }, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    return { output, pythonFiles: pythonFileInventory.files.length, files: files.length + 1 };
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true });
    throw error;
  }
}

export function parseArgs(args) {
  const keys = { '--python-source': 'pythonSource', '--python-inventory': 'pythonInventory', '--out': 'out' };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!keys[args[i]] || !args[i + 1] || args[i + 1].startsWith('--') || keys[args[i]] in options) throw new Error('expected unique --python-source, --python-inventory and --out values');
    options[keys[args[i]]] = args[i + 1];
  }
  if (Object.keys(options).length !== 3) throw new Error('--python-source, --python-inventory and --out are required');
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildStage(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error('CP2A staging failed: ' + error.message); process.exitCode = 1; }
}
