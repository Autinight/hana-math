// Opaque software fixtures only: no model, network or mathematical computation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createContextService } from '../packages/hana-math/context-service.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const input = { projectId: 'project-fixture', problem: 'opaque problem', operatorProfile: 'opaque operator', workerTask: 'opaque initial A' };
const worker = { projectId: input.projectId, role: 'worker', workerId: 'worker-one' };
async function fixture(t) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-project-workspace-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const reopen = () => createContextService({ dataDir });
  const service = reopen(); await service.prepare(input);
  return { dataDir, service, reopen };
}
const readReceipt = async cwd => JSON.parse(await fs.readFile(path.join(cwd, 'project-workspace.json'), 'utf8'));

test('trusted admission guard is not public input and rejects before any TASK receipt write', async t => {
  const f = await fixture(t), receipt = await f.service.prepareProjectWorkspace(worker), args = { projectId: input.projectId, workerId: worker.workerId, task: 'opaque guarded task' };
  const task = await fs.readFile(path.join(receipt.cwd, 'TASK.md')), before = await fs.readFile(path.join(receipt.cwd, 'project-workspace.json'));
  let calls = 0; const denied = Object.assign(new Error('opaque denial'), { code: 'MAIN_CONTROL_WORK_DENIED' });
  await assert.rejects(f.service.assignWorkerTask(args, { assertAdmission() { calls++; throw denied; } }), error => error === denied);
  assert.equal(calls, 1); assert.deepEqual(await fs.readFile(path.join(receipt.cwd, 'TASK.md')), task); assert.deepEqual(await fs.readFile(path.join(receipt.cwd, 'project-workspace.json')), before);
  await assert.rejects(f.service.assignWorkerTask({ ...args, assertAdmission: () => true }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.service.assignWorkerTask(args, { assertAdmission: async () => true }), { code: 'INVALID_INPUT' });
  assert.deepEqual(await fs.readFile(path.join(receipt.cwd, 'project-workspace.json')), before);
});

test('admission options survive waiting for the workspace lock and are checked against the latest committed TASK', async t => {
  const f = await fixture(t), receipt = await f.service.prepareProjectWorkspace(worker), target = path.join(receipt.cwd, 'project-workspace.json');
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  t.after(() => release()); const rename = fs.rename; let intercepted = false, guardCalls = 0;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (!intercepted && to === target && JSON.parse(await fs.readFile(from)).state === 'preparing') { intercepted = true; entered(); await gate; }
    return rename(from, to);
  }); syncBuiltinESMExports(); let second, timer;
  const args = { projectId: input.projectId, workerId: worker.workerId };
  const first = f.service.assignWorkerTask({ ...args, task: 'opaque first' });
  try {
    await Promise.race([reached, first.then(() => assert.fail('missing lock barrier')), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('workspace barrier timeout')), 10000); })]);
    clearTimeout(timer);
    second = f.service.assignWorkerTask({ ...args, task: 'opaque second' }, { assertAdmission() { guardCalls++; throw Object.assign(new Error('opaque revoked admission'), { code: 'MAIN_CONTROL_WORK_DENIED' }); } });
    const rejected = assert.rejects(second, { code: 'MAIN_CONTROL_WORK_DENIED' });
    assert.equal(guardCalls, 0); release(); await first; await rejected; assert.equal(guardCalls, 1);
    assert.equal(await fs.readFile(path.join(receipt.cwd, 'TASK.md'), 'utf8'), 'opaque first\n'); assert.equal((await readReceipt(receipt.cwd)).state, 'ready');
  } finally { clearTimeout(timer); release(); await Promise.allSettled([first, second]); mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('logical worker reopens with assigned TASK and opaque notes intact; siblings share only project stores', async t => {
  const f = await fixture(t), one = await f.service.prepareProjectWorkspace(worker);
  assert.equal(one.scope, 'logical-worker'); assert.equal(one.verificationId, null); assert.equal(Object.hasOwn(one, 'runId'), false);
  assert.equal(one.cwd, path.join(f.dataDir, 'context/projects/project-fixture/workers/worker-one'));
  assert.equal(one.localMemory, path.join(one.cwd, 'local_memory'));
  const notes = path.join(one.localMemory, 'opaque-note.txt'); await fs.writeFile(notes, 'opaque retained progress');
  const args = { projectId: input.projectId, workerId: worker.workerId, task: '  opaque B\r\n\t' };
  const assigned = await f.service.assignWorkerTask(args);
  assert.deepEqual(assigned, { state: 'ready', projectId: input.projectId, workerId: worker.workerId,
    taskFile: 'context/projects/project-fixture/workers/worker-one/TASK.md', sha256: sha(args.task + '\n') });
  const before = await fs.readFile(path.join(one.cwd, 'project-workspace.json'));
  const reopened = await f.reopen().prepareProjectWorkspace(worker);
  assert.deepEqual(reopened, JSON.parse(before)); assert.deepEqual(await fs.readFile(path.join(one.cwd, 'project-workspace.json')), before);
  assert.equal(await fs.readFile(path.join(one.cwd, 'TASK.md'), 'utf8'), args.task + '\n');
  assert.equal(await fs.readFile(notes, 'utf8'), 'opaque retained progress');
  assert.deepEqual(reopened.files.filter(file => file.path !== 'TASK.md'), one.files.filter(file => file.path !== 'TASK.md'));
  const two = await f.service.prepareProjectWorkspace({ ...worker, workerId: 'worker-two' });
  assert.deepEqual(two.shared, one.shared); assert.notEqual(two.localMemory, one.localMemory);
  assert.equal(await fs.readFile(path.join(two.cwd, 'TASK.md'), 'utf8'), input.workerTask);
  assert.deepEqual(await fs.readdir(two.localMemory), []);
  const paths = JSON.parse(await fs.readFile(path.join(one.cwd, 'PATHS.json')));
  assert.equal(paths.workerId, worker.workerId); assert.equal(paths.localMemory, one.localMemory); assert.equal(Object.hasOwn(paths, 'runId'), false);
  assert.equal(paths.shared.factGraph, path.join(f.dataDir, 'context/projects/project-fixture/shared/fact_graph'));
});

test('project main has no TASK, private memory or worker identity; no automatic persona/Skills injection', async t => {
  const f = await fixture(t), main = await f.service.prepareProjectWorkspace({ projectId: input.projectId, role: 'main' });
  assert.equal(main.scope, 'project-main'); assert.equal(main.localMemory, null); assert.equal(Object.hasOwn(main, 'workerId'), false);
  assert.equal(main.cwd, path.join(f.dataDir, 'context/projects/project-fixture/main'));
  for (const name of ['TASK.md', 'local_memory', 'AGENTS.md', '.agents/skills']) await assert.rejects(fs.lstat(path.join(main.cwd, name)), { code: 'ENOENT' });
  const paths = JSON.parse(await fs.readFile(path.join(main.cwd, 'PATHS.json')));
  assert.equal(paths.localMemory, null); assert.equal(Object.hasOwn(paths, 'workerId'), false); assert.equal(Object.hasOwn(paths, 'runId'), false);
  const context = await fs.readFile(path.join(main.cwd, 'CONTEXT.md'), 'utf8');
  assert.doesNotMatch(context, /\p{Script=Han}|math_assign|math_start|math_stop/u);
  assert.deepEqual(await f.reopen().prepareProjectWorkspace({ projectId: input.projectId, role: 'main' }), main);
  assert.equal(await fs.readFile(path.join(main.cwd, 'PROBLEM.md'), 'utf8'), input.problem);
});

test('persistent workspace APIs reject invalid identities, unknown fields and role/path overrides', async t => {
  const f = await fixture(t);
  for (const args of [undefined, null, {}, { ...worker, workerId: '' }, { ...worker, workerId: '../other' }, { ...worker, projectId: '/outside' },
    { ...worker, role: 'verifier' }, { ...worker, role: 'main' }, { ...worker, runId: 'run-other' }, { ...worker, path: '/other' },
    { projectId: input.projectId, role: 'main', workerId: undefined }]) await assert.rejects(f.service.prepareProjectWorkspace(args));
  const args = { projectId: input.projectId, workerId: worker.workerId, task: 'opaque B' };
  for (const bad of [null, {}, { ...args, workerId: '' }, { ...args, workerId: '../../main' }, { ...args, task: ' ' }, { ...args, task: '\0' },
    { ...args, task: 'x'.repeat(128 * 1024 + 1) }, { ...args, role: 'main' }, { ...args, path: 'TASK.md' }, { ...args, runId: 'run-other' }])
    await assert.rejects(f.service.assignWorkerTask(bad));
  await assert.rejects(f.service.assignWorkerTask(args), { code: 'ENOENT' });
});

test('parallel prepare/assign serialize and leave the final TASK and receipt hash consistent', async t => {
  const f = await fixture(t);
  const [one, two] = await Promise.all([f.service.prepareProjectWorkspace(worker), f.service.prepareProjectWorkspace(worker)]);
  assert.deepEqual(one, two);
  const args = { projectId: input.projectId, workerId: worker.workerId };
  const first = f.service.assignWorkerTask({ ...args, task: 'opaque B' });
  const second = f.service.assignWorkerTask({ ...args, task: 'opaque C\n' });
  const reopened = f.service.prepareProjectWorkspace(worker);
  const [b, c, ready] = await Promise.all([first, second, reopened]);
  assert.equal(b.sha256, sha('opaque B\n')); assert.equal(c.sha256, sha('opaque C\n'));
  assert.equal(ready.state, 'ready'); assert.equal(await fs.readFile(path.join(one.cwd, 'TASK.md'), 'utf8'), 'opaque C\n');
  assert.equal((await readReceipt(one.cwd)).files.find(file => file.path === 'TASK.md').sha256, c.sha256);
});

for (const damage of ['preparing', 'identity', 'manifest', 'task', 'reference', 'missing']) test(`existing ${damage} workspace is rejected, not reinitialized`, async t => {
  const f = await fixture(t), ready = await f.service.prepareProjectWorkspace(worker), receipt = await readReceipt(ready.cwd);
  const loc = path.join(ready.cwd, 'project-workspace.json');
  if (damage === 'preparing') receipt.state = 'preparing';
  if (damage === 'identity') receipt.workerId = 'worker-other';
  if (damage === 'manifest') receipt.referenceSha256 = '0'.repeat(64);
  if (['preparing', 'identity', 'manifest'].includes(damage)) await fs.writeFile(loc, JSON.stringify(receipt));
  if (damage === 'task') await fs.writeFile(path.join(ready.cwd, 'TASK.md'), 'opaque corruption');
  if (damage === 'reference') { const file = ready.files.find(file => file.kind === 'static'); await fs.chmod(path.join(ready.cwd, file.path), 0o600); await fs.writeFile(path.join(ready.cwd, file.path), 'opaque corruption'); }
  if (damage === 'missing') await fs.unlink(path.join(ready.cwd, 'TASK.md'));
  const before = await fs.readFile(loc);
  await assert.rejects(f.reopen().prepareProjectWorkspace(worker));
  await assert.rejects(f.service.assignWorkerTask({ projectId: input.projectId, workerId: worker.workerId, task: 'opaque replacement' }));
  assert.deepEqual(await fs.readFile(loc), before);
});

for (const failurePoint of ['task', 'ready']) test(`assignment ${failurePoint} write failure leaves non-ready receipt`, async t => {
  const f = await fixture(t), ready = await f.service.prepareProjectWorkspace(worker);
  const original = fs.rename; let injected = false;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (!injected && to.startsWith(ready.cwd + path.sep)) {
      const isReady = to.endsWith('/project-workspace.json') && JSON.parse(await fs.readFile(from)).state === 'ready';
      if (failurePoint === 'task' && to.endsWith('/TASK.md') || failurePoint === 'ready' && isReady) {
        injected = true; throw Object.assign(new Error('opaque filesystem failure'), { code: 'EIO' });
      }
    }
    return original(from, to);
  });
  syncBuiltinESMExports(); const restore = () => { mock.mock.restore(); syncBuiltinESMExports(); }; t.after(restore);
  await assert.rejects(f.service.assignWorkerTask({ projectId: input.projectId, workerId: worker.workerId, task: 'opaque B' }), { code: 'EIO' });
  restore(); assert.equal(injected, true); assert.equal((await readReceipt(ready.cwd)).state, 'preparing');
  await assert.rejects(f.reopen().prepareProjectWorkspace(worker));
});

test('symlink workspace and newly injected automatic contracts/Skills are rejected', async t => {
  const f = await fixture(t), one = await f.service.prepareProjectWorkspace(worker);
  const other = path.join(f.dataDir, 'context/projects/project-fixture/workers/worker-alias'); await fs.symlink(one.cwd, other);
  await assert.rejects(f.service.prepareProjectWorkspace({ ...worker, workerId: 'worker-alias' }), { code: 'SYMLINK_REFUSED' });
  await fs.writeFile(path.join(one.cwd, 'AGENTS.md'), 'opaque injection');
  await assert.rejects(f.service.prepareProjectWorkspace(worker)); await fs.unlink(path.join(one.cwd, 'AGENTS.md'));
  await fs.mkdir(path.join(f.dataDir, '.agents/skills'), { recursive: true });
  await assert.rejects(f.service.prepareProjectWorkspace(worker), { code: 'INHERITED_SKILLS' });
});
