import { readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const isNode26 = version => /^v?26\./.test(version.trim());

function newestHostFirst(a, b) {
  const version = name => (name.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1) ?? []).map(Number);
  const left = version(a.name), right = version(b.name);
  for (let i = 0; i < 3; i++) {
    const difference = (right[i] ?? -1) - (left[i] ?? -1);
    if (difference) return difference;
  }
  return b.name.localeCompare(a.name, 'en', { numeric: true });
}

export function selectNode({
  execPath = process.execPath,
  version = process.versions.node,
  serverRoot = path.join(os.homedir(), '.hanako/artifacts/server'),
  readDirectory = readdirSync,
  spawn = spawnSync,
} = {}) {
  if (isNode26(version)) return execPath;
  let entries;
  try { entries = readDirectory(serverRoot, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    entries = [];
  }
  for (const entry of entries.filter(entry => entry.isDirectory()).sort(newestHostFirst)) {
    const candidate = path.join(serverRoot, entry.name, 'node');
    const result = spawn(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0 && isNode26(result.stdout ?? '')) return candidate;
  }
  throw new Error(`Node 26 is required; current Node is ${version} and no usable Node 26 was found in ${serverRoot}`);
}

export function runTests(args = process.argv.slice(2), {
  select = selectNode, readDirectory = readdirSync, spawn = spawnSync,
} = {}) {
  const selected = select();
  const files = readDirectory(path.join(root, 'tests'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => path.join('tests', entry.name)).sort();
  if (!files.length) throw new Error('No tests/*.test.mjs files found');
  console.error(`[test] Node 26: ${selected}; ${files.length} test files`);
  // Opt-in hang diagnosis: npm test -- --test-timeout=120000 (per test, not a watchdog).
  // Node 26.12.1 can lose a trailing --test-timeout=0 in a file worker if a default is prepended.
  const result = spawn(selected, ['--test', ...args, ...files], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result;
}

function sameEntry(a, b) {
  try { return realpathSync(a) === realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
}

if (process.argv[1] && sameEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const result = runTests();
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(`[test] ${error.message}`);
    process.exitCode = 1;
  }
}
