// Runtime only: isolated temp roots, real Darwin frame owner, recorded SDK.
// The contention test runs the release Python entry; the rest synthesize SDK
// receipts or frames to exercise failures independently of Project settlement.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import * as runtime from '../packages/hana-math/runtime/research-runtime.mjs';

const run = promisify(execFile), source = new URL('../', import.meta.url), FRAME = 1 << 20;
const interpreter = process.env.HANA_TEST_READ_FRAME_PYTHON ?? 'python3.12';
const memory = 'dashboard_memory', graph = 'dashboard_factgraph';
const binding = { projectId: 'fixture-project', runId: 'control-00000000-0000-4000-8000-000000000000', role: 'main', author: 'fixture' };
const overview = { view: 'overview' }, busy = requestId => ({ schemaVersion: 1, requestId, ok: false, error: { code: 'busy', message: 'project is busy' } });
const take = (...args) => runtime.takeDashboardBusyFrame?.(...args) ?? null;
const childOptions = { timeout: 6000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } };
const darwin = { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 15000 };
async function rejection(attempt, code = 'REJECTED') {
  let failure;
  await assert.rejects(attempt, e => { failure = e; assert.equal(e.code, `RESEARCH_RUNTIME_${code}`, e.message); return true; });
  return failure;
}

async function setup(t, behavior = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-busy-frame-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const pkg = path.join(base, 'package'), dataDir = path.join(base, 'data'), executable = 'dependencies/python/bin/python3';
  await fs.mkdir(path.join(pkg, path.dirname(executable)), { recursive: true });
  await fs.mkdir(path.join(pkg, 'runtime'));
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.writeFile(path.join(pkg, executable), 'SDK command fixture', { mode: 0o700 });
  await fs.writeFile(path.join(pkg, 'dependencies/runtime.json'), JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable }));
  const project = path.join(dataDir, 'context/projects', binding.projectId), control = path.join(project, 'research/control');
  let python;
  if (behavior.real) {
    const { stdout } = await run(interpreter, ['-I', '-S', '-B', '-c', 'import os, sys; print(os.path.realpath(sys.executable))'], { timeout: 4000 });
    python = stdout.trim(); assert.ok(path.isAbsolute(python));
    await fs.mkdir(path.join(project, 'shared'), { recursive: true });
    await fs.mkdir(control, { recursive: true });
    for (const file of ['research_entry.py', 'research_read_frame.py'])
      await fs.copyFile(new URL(`packages/hana-math/runtime/${file}`, source), path.join(pkg, 'runtime', file));
    await fs.cp(new URL('engine/src', source), path.join(pkg, 'engine/src'), { recursive: true, filter: f => !f.includes('__pycache__') });
  } else {
    for (const file of ['runtime/research_entry.py', 'runtime/research_read_frame.py', 'engine/src/hana_math_engine/research.py']) {
      await fs.mkdir(path.dirname(path.join(pkg, file)), { recursive: true });
      await fs.writeFile(path.join(pkg, file), '# fixture');
    }
  }
  const starts = [], receipts = new Map();
  const sdk = { dataDir, runtime: {
    async start(input) {
      const framed = input.args[3].endsWith('/research_read_frame.py');
      const stateFile = path.join(input.cwd, 'state.frame');
      const state = framed ? await fs.readFile(stateFile) : null;
      const request = JSON.parse(await (state
        ? fs.readFile(path.join(input.cwd, 'request.frame')).then(frame => frame.subarray(0, state.readUInt32BE(33)))
        : fs.readFile(input.args[4])));
      const { requestId } = request;
      starts.push({ directory: input.cwd, generation: framed ? Number(input.args[4]) : null, requestId });
      if (behavior.real) {
        assert.deepEqual(await run(python, input.args, { ...childOptions, cwd: input.cwd }), { stdout: '', stderr: '' });
      } else {
        const payload = Buffer.from(JSON.stringify(behavior.envelope ? behavior.envelope(busy(requestId)) : busy(requestId)));
        if (state) {
          const frame = Buffer.alloc(FRAME); payload.copy(frame);
          state[8] = 3; state.writeUInt32BE(payload.length, 33);
          if (!behavior.badDigest) createHash('sha256').update(payload).digest().copy(state, 37);
          createHash('sha256').update(state.subarray(0, 69)).digest().copy(state, 69);
          await fs.writeFile(path.join(input.cwd, 'result.frame'), frame);
          await fs.writeFile(stateFile, state);
        } else await fs.writeFile(input.args[5], payload, { mode: 0o600 });
      }
      const info = { runtimeId: requestId, state: 'exited', exitCode: 0, runtime: 'command', profile: 'scoped', network: 'none' };
      receipts.set(requestId, info);
      behavior.afterPublish?.();
      return behavior.watch ? { ...info, state: 'ready', exitCode: null } : info;
    },
    async get(id) {
      if (behavior.delayGet) await delay(behavior.delayGet);
      return { ...receipts.get(id), ...behavior.get };
    },
    watch(id) {
      assert.ok(behavior.watch);
      return new Response(new ReadableStream({
        start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'state', runtime: receipts.get(id) }) + '\n')); },
        cancel() { throw new Error('synthetic watch cleanup refusal'); },
      }));
    },
    stop() { assert.fail('already exited'); },
  } };
  const owner = runtime.createAppResearchCore(sdk, { packageRoot: pkg, ...behavior.timeouts });
  const bridge = owner.createCore({ taskId: 'fixture-task' });
  t.after(async () => { try { await bridge.dispose(); } finally { await owner.dispose(); } });
  const call = (operation = memory, args = overview, signal) => bridge.call(binding, operation, args, undefined,
    runtime.projectDashboardViewOptions(operation, signal, () => {}));
  return { owner, bridge, control, starts, call, python };
}

async function holdProjectLock(t, python, file) {
  const holder = spawn(python, ['-I', '-S', '-B', '-c',
    'import fcntl, os, select, sys; fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600); fcntl.flock(fd, fcntl.LOCK_EX); print("locked", flush=True); select.select([sys.stdin], [], [], 10)', file],
  { env: childOptions.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = once(holder, 'close');
  t.after(async () => { holder.stdin.end(); await closed; });
  const ready = await Promise.race([once(holder.stdout, 'data').then(([chunk]) => String(chunk).trim()), closed.then(() => 'exited early')]);
  assert.equal(ready, 'locked');
  return async () => { holder.stdin.end(); assert.deepEqual(await closed, [0, null]); };
}

// The exported rearm is not a retry, result, or authorization. The original
// failed promise and exact original Error must survive normal task cleanup.
test('real Python busy frame stays failed and rearms its slot once after bridge cleanup', darwin, async t => {
  const f = await setup(t, { real: true }), release = await holdProjectLock(t, f.python, path.join(f.control, 'project.lock'));
  const signal = new AbortController(), attempt = f.call(memory, { ...overview, terminal: true }, signal.signal);
  assert.equal(take(f.bridge, attempt, memory, new Error('project is busy')), null);
  const error = await rejection(attempt);
  assert.deepEqual(error.coreError, { code: 'busy', message: 'project is busy' });
  assert.equal(error.indeterminate, false);
  assert.equal(error.startOutcome, 'acknowledged');
  assert.equal(error.processTerminalConfirmed, true);
  assert.equal(error.cleanup.confirmed, true);
  const first = f.starts[0], directory = first.directory;
  const state = await fs.readFile(path.join(directory, 'state.frame'));
  assert.deepEqual(JSON.parse((await fs.readFile(path.join(directory, 'result.frame'))).subarray(0, state.readUInt32BE(33))), busy(first.requestId));
  signal.abort(); // CoreAccess does this only after receiving the original rejection.
  await f.bridge.dispose();
  const next = f.owner.createCore({ taskId: 'fixture-next-task' });
  t.after(() => next.dispose());
  assert.equal(take(next, attempt, memory, error), null);
  assert.equal(take(f.bridge, Promise.resolve(), memory, error), null);
  assert.equal(take(f.bridge, attempt, graph, error), null);
  assert.equal(take(f.bridge, attempt, memory, Object.assign(new Error(error.message), error)), null);
  assert.equal(runtime.takeProjectReadScratch(f.bridge, attempt, memory, error), null);
  const rearm = take(f.bridge, attempt, memory, error);
  assert.equal(typeof rearm, 'function');
  assert.equal(take(f.bridge, attempt, memory, error), null);
  const read = () => next.call(binding, graph, {}, undefined, runtime.projectDashboardViewOptions(graph, undefined, () => {}));
  await release();
  await rejection(read(), 'READ_SLOT_FENCED'); // taking alone leaves waiting-for-validation
  assert.deepEqual(f.starts, [first]);
  assert.equal(rearm(), true);
  assert.equal(rearm(), false);
  assert.ok(await read());
  assert.equal(f.starts[1].directory, directory);
  assert.equal(f.starts[1].generation, first.generation + 1);
  assert.notEqual(f.starts[1].requestId, first.requestId);
});

test('busy evidence is exclusive to branded graph/overview/memory frames, not success, fact or JSON lanes', darwin, async t => {
  for (const [name, operation, args, options, eligible] of [
    ['graph', graph, {}, () => runtime.projectDashboardViewOptions(graph, undefined, () => {}), true],
    ['memory', memory, { view: 'channel', kind: 'plan' }, () => runtime.projectDashboardViewOptions(memory, undefined, () => {}), true],
    ['fact read', 'fact_get', { id: 'a'.repeat(16) }, () => runtime.projectReadScratchOptions(), false],
    ['legacy dashboard', memory, overview, () => runtime.projectDashboardMemoryOptions(), false],
    ['mutation', 'gm_add', {}, () => ({}), false],
  ]) await t.test(name, async st => {
    const f = await setup(st), attempt = f.bridge.call(binding, operation, args, undefined, options());
    const error = await rejection(attempt), rearm = take(f.bridge, attempt, operation, error);
    assert.equal(typeof rearm === 'function', eligible);
    if (!eligible) assert.equal(rearm, null);
    assert.equal(f.starts[0].generation, name === 'legacy dashboard' || name === 'mutation' ? null : 1);
  });
  await t.test('success keeps its own receipt only', async st => {
    const f = await setup(st, { envelope: ({ requestId }) => ({ schemaVersion: 1, requestId, ok: true, result: { fixture: 1 } }) });
    const attempt = f.call(), result = await attempt;
    assert.equal(take(f.bridge, attempt, memory, result), null);
    assert.equal(runtime.takeProjectReadScratch(f.bridge, attempt, memory, result)(), true);
  });
});

test('lookalike, damaged, unconfirmed, timed-out, and cancelled frames do not rearm', darwin, async t => {
  for (const [name, behavior, code] of [
    ['wrong core code', { envelope: e => ({ ...e, error: { ...e.error, code: 'forbidden' } }) }],
    ['wrong message', { envelope: e => ({ ...e, error: { ...e.error, message: 'project is busy ' } }) }],
    ['result present', { envelope: e => ({ ...e, result: null }) }],
    ['extra envelope field', { envelope: e => ({ ...e, diagnostic: null }) }],
    ['mutation state', { envelope: e => ({ ...e, error: { ...e.error, mutationState: 'indeterminate' } }) }],
    ['extra error field', { envelope: e => ({ ...e, error: { ...e.error, indeterminate: false } }) }],
    ['wrong nonce in envelope', { envelope: e => ({ ...e, requestId: 'not-the-attempt' }) }, 'INVALID_RESULT'],
    ['bad frame digest', { badDigest: true }, 'READ_SLOT_FENCED'],
    ['stale final GET', { get: { state: 'ready', exitCode: null } }],
    ['conflicting final exit', { get: { exitCode: 7 } }],
    ['final signal', { get: { signal: 'SIGTERM' } }],
    ['watch cleanup refusal', { watch: true }],
    ['GET beyond deadline', { delayGet: 750, timeouts: { timeoutMs: 450, cleanupTimeoutMs: 1500 } }, 'TIMEOUT'],
    ['abort during launch', {}, 'CANCELLED'],
  ]) await t.test(name, async st => {
    const abort = new AbortController();
    if (name === 'abort during launch') behavior.afterPublish = () => abort.abort();
    const f = await setup(st, behavior), attempt = f.call(memory, overview, abort.signal);
    const error = await rejection(attempt, code);
    assert.equal(take(f.bridge, attempt, memory, error), null);
    if (behavior.watch) assert.equal(error.cleanup.confirmed, false);
    const next = f.owner.createCore({ taskId: 'fixture-next-task' });
    st.after(() => next.dispose());
    await rejection(next.call(binding, memory, overview, undefined, runtime.projectDashboardViewOptions(memory, undefined, () => {})), 'READ_SLOT_FENCED');
    assert.equal(f.starts.length, 1);
  });
  await t.test('pre-cancelled call never launches', async st => {
    const f = await setup(st), attempt = f.call(memory, overview, AbortSignal.abort());
    assert.equal(take(f.bridge, attempt, memory, await rejection(attempt, 'CANCELLED')), null);
    assert.equal(f.starts.length, 0);
  });
});
