// Real Node permission boundary; only the SDK/process receipts are fixtures.
// No Python, model, network or user-data operations are performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const sourceURL = new URL('../packages/hana-math/runtime/research-runtime.mjs', import.meta.url);
const metadata = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' };

const child = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const config = JSON.parse(process.argv[1]);
const { packageRoot, dataRoot, scenario } = config;
assert.ok(process.permission, 'The test must actually run with Node permissions');
assert.equal(process.permission.has('fs.read', path.dirname(packageRoot)), false);
assert.equal(process.permission.has('fs.write', packageRoot), false);
await assert.rejects(fs.lstat(path.dirname(packageRoot)), { code: 'ERR_ACCESS_DENIED' });
await assert.rejects(fs.writeFile(path.join(packageRoot, 'forbidden-write'), 'no'), { code: 'ERR_ACCESS_DENIED' });
const { createResearchRuntime } = await import(pathToFileURL(path.join(packageRoot, 'runtime/research-runtime.mjs')).href);
const binding = { projectId: 'fixture-project', runId: 'fixture-run', role: 'main', author: 'fixture' };
const calls = { start: [], get: [], watch: [], stop: [] }, states = new Map();
const sdk = { dataDir: config.dataRootOverride || dataRoot, runtime: {
  async start(input) {
    calls.start.push(input);
    assert.equal(input.command, config.executableTarget);
    assert.equal(input.runtime, 'command'); assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none');
    assert.deepEqual(input.args.slice(0, 4), ['-I', '-S', '-B', path.join(packageRoot, 'runtime/research_entry.py')]);
    if (['grant-denied', 'grant-denied-exact'].includes(scenario)) throw Object.assign(new Error('fixture runtime denied'), { code: 'APP_CAPABILITY_DENIED', ...(scenario === 'grant-denied-exact' ? { operation: 'runtime.start', capability: 'app/runtime.execute', kind: 'permission' } : {}) });
    const request = JSON.parse(await fs.readFile(input.args[4], 'utf8'));
    assert.deepEqual(request.context, binding); assert.equal(request.operation, 'fact_list');
    assert.equal(input.cwd, path.join(dataRoot, 'research/core-calls', request.requestId));
    assert.deepEqual(input.args.slice(4), [path.join(input.cwd, 'request.json'), path.join(input.cwd, 'result.json')]);
    assert.equal((await fs.stat(input.args[4])).mode & 0o777, 0o600);
    if (scenario === 'result-link') await fs.rename(path.join(dataRoot, 'link-template'), input.args[5]);
    else await fs.writeFile(input.args[5], JSON.stringify({ schemaVersion: 1, requestId: request.requestId, ok: true, result: { facts: [] } }), { mode: 0o600 });
    if (scenario === 'marker-link') await fs.rename(path.join(dataRoot, 'link-template'), path.join(input.cwd, '.complete'));
    const info = { runtimeId: request.requestId, runtime: 'command', profile: 'scoped', network: 'none', state: 'exited', exitCode: 0, signal: null };
    states.set(info.runtimeId, info); return info;
  },
  async get(id) { calls.get.push(id); return states.get(id); },
  async watch(id) { calls.watch.push(id); assert.fail('Fixture is already exited'); },
  async stop(id) { calls.stop.push(id); assert.fail('No process is running'); },
} };
const options = process.platform === 'darwin' && process.arch === 'arm64' ? {} : { platform: 'darwin', arch: 'arm64' };
if (config.packageRootOverride) options.packageRoot = config.packageRootOverride;
const bridge = Object.keys(options).length ? createResearchRuntime(sdk, options) : createResearchRuntime(sdk);
const results = [], markers = [];
let error, disposal;
try {
  // The second call scans an existing completed directory, not just an empty root.
  for (let index = 0; index < 2; index++) {
    results.push(await bridge.call(binding, 'fact_list'));
    const directory = calls.start.at(-1).cwd;
    const marker = await fs.lstat(path.join(directory, '.complete'));
    markers.push({ mode: marker.mode & 0o777, size: marker.size, regular: marker.isFile() });
    assert.equal((await fs.stat(path.join(directory, 'result.json'))).mode & 0o777, 0o600);
  }
} catch (e) {
  error = { code: e.code, causeCode: e.cause?.code, causeResource: e.cause?.resource, causeMessage: e.cause?.message, indeterminate: e.indeterminate, cleanup: e.cleanup?.confirmed, startOutcome: e.startOutcome, processTerminalConfirmed: e.processTerminalConfirmed };
}
try { await bridge.dispose(); } catch (e) { disposal = { code: e.code, indeterminate: e.indeterminate }; }
console.log(JSON.stringify({ permissions: true, defaultRoot: !Object.hasOwn(options, 'packageRoot'), results, markers, calls, error, disposal }));
`;

async function runFixture(t, scenario = 'normal') {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'research-node-permission-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const packageRoot = path.join(base, 'package'), dataRoot = path.join(base, 'data');
  await fs.mkdir(dataRoot);
  const source = await fs.readFile(sourceURL, 'utf8');
  for (const [name, text] of Object.entries({
    'runtime/research-runtime.mjs': source,
    'runtime/managed-read-owner.mjs': await fs.readFile(new URL('./managed-read-owner.mjs', sourceURL), 'utf8'),
    'runtime/python-launch.mjs': await fs.readFile(new URL('./python-launch.mjs', sourceURL), 'utf8'),
    'dependencies/runtime.json': JSON.stringify(metadata),
    [metadata.executable]: 'opaque software fixture; never executed',
    'runtime/research_entry.py': '# opaque entry fixture\n',
    'engine/src/hana_math_engine/research.py': '# opaque core fixture\n',
  })) {
    const target = path.join(packageRoot, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text);
  }
  const executable = path.join(packageRoot, metadata.executable);
  await fs.chmod(executable, 0o700);
  const config = { packageRoot, dataRoot, scenario, executableTarget: executable };
  if (scenario === 'result-link' || scenario === 'marker-link') {
    // Node deliberately disallows fs.symlink creation without global grants.
    // Prepare the hostile fixture before launch, then move it within dataDir;
    // never widen the child's permission set just to construct test data.
    const target = path.join(dataRoot, 'link-target'); await fs.writeFile(target, 'opaque target');
    await fs.symlink(target, path.join(dataRoot, 'link-template'));
  }
  if (scenario === 'python-internal-link') {
    config.executableTarget = executable + '-real'; await fs.rename(executable, config.executableTarget); await fs.symlink(path.basename(config.executableTarget), executable);
  } else if (scenario === 'python-escape') {
    const outside = path.join(base, 'outside-python'); await fs.writeFile(outside, 'opaque outside fixture'); await fs.chmod(outside, 0o700);
    await fs.unlink(executable); await fs.symlink(outside, executable);
  } else if (scenario === 'entry-link') {
    const alternate = path.join(packageRoot, 'alternate-entry.py'); await fs.writeFile(alternate, '# opaque entry');
    const entry = path.join(packageRoot, 'runtime/research_entry.py'); await fs.unlink(entry); await fs.symlink(alternate, entry);
  } else if (scenario === 'metadata-parent-link') {
    const original = path.join(packageRoot, 'dependencies'), alternate = path.join(packageRoot, 'alternate-dependencies');
    await fs.rename(original, alternate); await fs.symlink(alternate, original);
  } else if (scenario === 'ipc-parent-link') {
    const alternate = path.join(dataRoot, 'alternate'); await fs.mkdir(alternate); await fs.symlink(alternate, path.join(dataRoot, 'research'));
  } else if (scenario === 'package-root-link') {
    config.packageRootOverride = path.join(dataRoot, 'package-link'); await fs.symlink(packageRoot, config.packageRootOverride);
  } else if (scenario === 'package-ancestor-alias' || scenario === 'data-ancestor-alias') {
    const alias = path.join(dataRoot, 'alias'); await fs.symlink(base, alias);
    if (scenario === 'package-ancestor-alias') config.packageRootOverride = path.join(alias, 'package');
    else config.dataRootOverride = path.join(alias, 'data');
  } else if (scenario === 'overlap') config.dataRootOverride = packageRoot;
  else if (scenario === 'noncanonical-root') config.packageRootOverride = packageRoot + '/';
  const grants = ['--permission', `--allow-fs-read=${packageRoot}`, `--allow-fs-read=${dataRoot}`];
  if (scenario !== 'fs-write-denied') grants.push(`--allow-fs-write=${dataRoot}`);
  const { stdout } = await execute(process.execPath, [...grants, '--input-type=module', '-e', child, JSON.stringify(config)], { timeout: 20000, maxBuffer: 256 * 1024 });
  return { ...JSON.parse(stdout), packageRoot, dataRoot };
}

for (const scenario of ['normal', 'python-internal-link']) test(`Node --permission default factory succeeds with only package/data grants: ${scenario}`, async (t) => {
  const result = await runFixture(t, scenario);
  assert.equal(result.permissions, true); assert.equal(result.defaultRoot, true); assert.equal(result.error, undefined); assert.equal(result.disposal, undefined);
  assert.deepEqual(result.results, [{ facts: [] }, { facts: [] }]);
  assert.deepEqual(result.markers, [{ mode: 0o600, size: 0, regular: true }, { mode: 0o600, size: 0, regular: true }]);
  assert.equal(result.calls.start.length, 2); assert.equal(result.calls.get.length, 2); assert.deepEqual(result.calls.watch, []); assert.deepEqual(result.calls.stop, []);
});

for (const scenario of ['entry-link', 'metadata-parent-link', 'ipc-parent-link', 'package-root-link', 'package-ancestor-alias', 'data-ancestor-alias', 'overlap', 'noncanonical-root']) {
  test(`permission grants do not relax owned-root validation: ${scenario}`, async (t) => {
    const result = await runFixture(t, scenario);
    assert.equal(result.error.code, 'RESEARCH_RUNTIME_PATH_INVALID'); assert.deepEqual(result.calls.start, []); assert.deepEqual(result.results, []);
  });
}

test('an escaping Python symlink cannot trigger an out-of-package interpreter', async (t) => {
  const result = await runFixture(t, 'python-escape');
  assert.ok(['RESEARCH_RUNTIME_PATH_INVALID', 'RESEARCH_RUNTIME_DENIED'].includes(result.error.code)); assert.deepEqual(result.calls.start, []);
});

for (const [scenario, code] of [['result-link', 'RESEARCH_RUNTIME_PATH_INVALID'], ['marker-link', 'RESEARCH_RUNTIME_CLEANUP_FAILED']]) {
  test(`owned IPC file links are refused under real Node permissions: ${scenario}`, async (t) => {
    const result = await runFixture(t, scenario);
    assert.equal(result.error.code, code, JSON.stringify(result.error)); assert.equal(result.calls.start.length, 1); assert.deepEqual(result.results, []);
  });
}

test('real data-write denial never reaches runtime.start or expands grants', async (t) => {
  const result = await runFixture(t, 'fs-write-denied');
  assert.equal(result.error.code, 'RESEARCH_RUNTIME_DENIED'); assert.equal(result.error.causeCode, 'ERR_ACCESS_DENIED'); assert.deepEqual(result.calls.start, []);
});

test('exact pre-spawn denial settles even under the real Node package/data grants', async (t) => {
  const result = await runFixture(t, 'grant-denied-exact');
  assert.equal(result.defaultRoot, true); assert.equal(result.error.code, 'RESEARCH_RUNTIME_DENIED');
  assert.equal(result.error.startOutcome, 'rejected-before-spawn'); assert.equal(result.error.processTerminalConfirmed, false);
  assert.equal(result.error.cleanup, true); assert.equal(result.error.indeterminate, false); assert.equal(result.disposal, undefined);
  assert.equal(result.calls.start.length, 1); assert.deepEqual(result.calls.stop, []);
});

test('runtime permission denial uses no executable/profile fallback after root validation', async (t) => {
  const result = await runFixture(t, 'grant-denied');
  assert.equal(result.error.code, 'RESEARCH_RUNTIME_DENIED'); assert.equal(result.calls.start.length, 1); assert.equal(result.disposal.code, 'RESEARCH_RUNTIME_CLEANUP_FAILED');
  assert.equal(result.calls.start[0].profile, 'scoped'); assert.equal(result.calls.start[0].network, 'none');
});
