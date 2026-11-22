// Real module-relative default discovery in a disposable software-only package.
// The Python/entry files are opaque text. sdk.runtime never executes a process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceURL = new URL('../packages/hana-math/runtime/research-runtime.mjs', import.meta.url);
const binding = { projectId: 'fixture-project', runId: 'fixture-run', role: 'main', author: 'fixture-main' };
const metadata = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' };
// On the supported host this calls createResearchRuntime(sdk) with no options at
// all. Other test hosts only override platform identity, NEVER packageRoot.
const hostOptions = process.platform === 'darwin' && process.arch === 'arm64' ? undefined : { platform: 'darwin', arch: 'arm64' };

async function fixture(t, { denied = false } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'research-default-root-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const packageRoot = path.join(base, 'package'), dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir);
  const source = await fs.readFile(sourceURL, 'utf8');
  for (const [relative, content] of Object.entries({
    'runtime/research-runtime.mjs': source,
    'runtime/managed-read-owner.mjs': await fs.readFile(new URL('./managed-read-owner.mjs', sourceURL), 'utf8'),
    'runtime/python-launch.mjs': await fs.readFile(new URL('./python-launch.mjs', sourceURL), 'utf8'),
    'dependencies/runtime.json': JSON.stringify(metadata),
    [metadata.executable]: 'opaque Python fixture; never executed',
    'runtime/research_entry.py': '# opaque entry fixture; never executed\n',
    'engine/src/hana_math_engine/research.py': '# opaque facade fixture; never imported\n',
  })) {
    const target = path.join(packageRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content);
  }
  await fs.chmod(path.join(packageRoot, metadata.executable), 0o700);
  const calls = { start: [], get: [], watch: [], stop: [] }, states = new Map();
  const sdk = { dataDir, runtime: {
    async start(input) {
      calls.start.push(input);
      if (denied) throw Object.assign(new Error('fixture grant denied'), { code: 'APP_CAPABILITY_DENIED', ...(denied === 'exact' ? { operation: 'runtime.start', capability: 'app/runtime.execute', kind: 'permission' } : {}) });
      const request = JSON.parse(await fs.readFile(input.args[4], 'utf8'));
      const info = { runtimeId: request.requestId, runtime: 'command', state: 'exited', exitCode: 0, signal: null, profile: 'scoped', network: 'none' };
      states.set(info.runtimeId, info);
      await fs.writeFile(input.args[5], JSON.stringify({ schemaVersion: 1, requestId: request.requestId, ok: true, result: { facts: [] } }), { mode: 0o600 });
      return info;
    },
    async get(id) { calls.get.push(id); return states.get(id); },
    async watch(id) { calls.watch.push(id); assert.fail('An already-exited fixture must not need a watcher'); },
    async stop(id) { calls.stop.push(id); assert.fail('No fixture process is running'); },
  } };
  const { createResearchRuntime } = await import(pathToFileURL(path.join(packageRoot, 'runtime/research-runtime.mjs')).href);
  return { base, packageRoot, sdk, calls, create: (options = hostOptions) => createResearchRuntime(sdk, options) };
}

const pathInvalid = (promise) => assert.rejects(promise, (error) => {
  assert.equal(error.code, 'RESEARCH_RUNTIME_PATH_INVALID');
  assert.match(error.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(error.indeterminate, false); assert.equal(error.cleanup.confirmed, true);
  return true;
});

test('real default packageRoot resolves the copied module package and reaches only the fixed managed command', async (t) => {
  const f = await fixture(t); const bridge = f.create();
  assert.deepEqual(await bridge.call(binding, 'fact_list'), { facts: [] });
  assert.equal(f.calls.start.length, 1);
  const input = f.calls.start[0];
  assert.deepEqual(Object.keys(input).sort(), ['args', 'command', 'cwd', 'network', 'profile', 'runtime']);
  assert.equal(input.command, path.join(f.packageRoot, metadata.executable));
  assert.deepEqual(input.args.slice(0, 4), ['-I', '-S', '-B', path.join(f.packageRoot, 'runtime/research_entry.py')]);
  const request = JSON.parse(await fs.readFile(input.args[4], 'utf8'));
  assert.deepEqual(request, { schemaVersion: 1, requestId: request.requestId, operation: 'fact_list', context: binding, arguments: {} });
  assert.equal(input.cwd, path.join(f.sdk.dataDir, 'research/core-calls', request.requestId));
  assert.deepEqual(input.args.slice(4), [path.join(input.cwd, 'request.json'), path.join(input.cwd, 'result.json')]);
  assert.equal(input.runtime, 'command'); assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none');
  assert.equal((await fs.stat(input.args[4])).mode & 0o777, 0o600);
  assert.deepEqual(f.calls.get, [request.requestId]); assert.deepEqual(f.calls.watch, []);
  await bridge.dispose(); assert.deepEqual(f.calls.stop, []);
});

test('caller-supplied noncanonical paths and symlink roots are still rejected rather than normalized', async (t) => {
  const f = await fixture(t); const link = path.join(f.base, 'package-link'); await fs.symlink(f.packageRoot, link);
  for (const packageRoot of [f.packageRoot + '/', f.packageRoot + '/.', f.packageRoot + '/../package', 'package', link]) {
    const bridge = f.create({ platform: 'darwin', arch: 'arm64', packageRoot });
    await pathInvalid(bridge.call(binding, 'fact_list')); await bridge.dispose();
  }
  assert.deepEqual(f.calls.start, []);
});

test('default-root discovery still rejects data/install overlap and escaping interpreter targets', async (t) => {
  const overlap = await fixture(t); overlap.sdk.dataDir = overlap.packageRoot;
  const first = overlap.create(); await pathInvalid(first.call(binding, 'fact_list')); await first.dispose(); assert.deepEqual(overlap.calls.start, []);
  const escaped = await fixture(t); const outside = path.join(escaped.base, 'outside-python');
  await fs.writeFile(outside, 'opaque outside fixture'); await fs.chmod(outside, 0o700);
  await fs.unlink(path.join(escaped.packageRoot, metadata.executable)); await fs.symlink(outside, path.join(escaped.packageRoot, metadata.executable));
  const second = escaped.create(); await pathInvalid(second.call(binding, 'fact_list')); await second.dispose(); assert.deepEqual(escaped.calls.start, []);
});

test('default factory exact pre-spawn denial confirms cleanup without a runtime ID', async (t) => {
  const f = await fixture(t, { denied: 'exact' }); const bridge = f.create();
  await assert.rejects(bridge.call(binding, 'fact_list'), (error) => {
    assert.equal(error.code, 'RESEARCH_RUNTIME_DENIED'); assert.equal(error.startOutcome, 'rejected-before-spawn');
    assert.equal(error.processTerminalConfirmed, false); assert.equal(error.runtimeId, null);
    assert.equal(error.cleanup.confirmed, true); assert.equal(error.indeterminate, false); return true;
  });
  await bridge.dispose(); assert.equal(f.calls.start.length, 1); assert.deepEqual(f.calls.get, []); assert.deepEqual(f.calls.stop, []);
});

test('default-root grant refusal is explicit and never retries another executable or profile', async (t) => {
  const f = await fixture(t, { denied: true }); const bridge = f.create();
  await assert.rejects(bridge.call(binding, 'fact_list'), { code: 'RESEARCH_RUNTIME_DENIED' });
  assert.equal(f.calls.start.length, 1); assert.equal(f.calls.start[0].command, path.join(f.packageRoot, metadata.executable));
  assert.equal(f.calls.start[0].profile, 'scoped'); assert.equal(f.calls.start[0].network, 'none');
  await assert.rejects(bridge.dispose(), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED' });
  assert.deepEqual(f.calls.stop, []);
});
