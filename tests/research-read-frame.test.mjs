// Real one-shot Python commands, synthetic package/data only. Default test
// interpreter is python3.12 on PATH; an explicit package test can pin a binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile), python = process.env.HANA_TEST_READ_FRAME_PYTHON ?? 'python3.12';
const MAX = 1 << 20, HEAD = 69, CONTROL = 101, factId = 'a'.repeat(16);
const names = ['state.frame', 'request.frame', 'result.frame'];
const binding = { projectId: 'project-frame', runId: 'run-frame', role: 'main', author: 'fixture' };
const rawFact = `---\nfact_id: ${factId}\npredecessors: []\nexternal_refs: []\n---\n## statement\nSynthetic nonempty statement.\n## proof\nSynthetic proof.\n`;
const sha = bytes => createHash('sha256').update(bytes).digest();
const identity = async f => { const st = await fs.lstat(f, { bigint: true }); return `${st.dev}:${st.ino}`; };
const nonceBytes = id => Buffer.from(id.replaceAll('-', ''), 'hex');
const envelope = (operation = 'fact_get', args = { fact_id: factId }, context = binding) => ({ schemaVersion: 1, requestId: randomUUID(), operation, context, arguments: args });
function state(phase, generation, id, payload) {
  const b = Buffer.alloc(CONTROL);
  b.write('HMRFRM01'); b[8] = phase;
  b.writeBigUInt64BE(BigInt(generation), 9);
  nonceBytes(id).copy(b, 17); b.writeUInt32BE(payload.length, 33); sha(payload).copy(b, 37);
  sha(b.subarray(0, HEAD)).copy(b, HEAD);
  return b;
}
async function overwrite(file, bytes, expected) {
  assert.equal(bytes.length, expected);
  const fd = await fs.open(file, 'r+');
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await fd.write(bytes, offset, bytes.length - offset, offset);
      assert.ok(bytesWritten > 0); offset += bytesWritten;
    }
    await fd.sync();
  } finally { await fd.close(); }
}
async function setup(t, { fact = true } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-read-frame-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const packageRoot = path.join(base, 'package'), runtime = path.join(packageRoot, 'runtime');
  const data = path.join(base, 'data'), research = path.join(data, 'research'), ipc = path.join(research, 'core-calls'), slot = path.join(ipc, randomUUID());
  await fs.mkdir(slot, { recursive: true, mode: 0o700 });
  await fs.mkdir(runtime, { recursive: true });
  await fs.cp(path.join(repo, 'engine/src'), path.join(packageRoot, 'engine/src'), { recursive: true,
    filter: f => !f.includes('__pycache__') && !f.endsWith('.pyc') });
  for (const n of ['research_entry.py', 'research_read_frame.py'])
    await fs.copyFile(path.join(repo, 'packages/hana-math/runtime', n), path.join(runtime, n));
  const [control, req, result] = names.map(n => path.join(slot, n));
  for (const [filename, size] of [[control, CONTROL], [req, MAX], [result, MAX]]) {
    const fd = await fs.open(filename, 'wx', 0o600);
    try { await fd.truncate(size); } finally { await fd.close(); }
  }
  const project = path.join(data, 'context/projects', binding.projectId);
  if (fact) {
    const facts = path.join(project, 'shared/fact_graph/facts');
    await fs.mkdir(facts, { recursive: true }); await fs.writeFile(path.join(facts, factId + '.md'), rawFact);
  }
  const ids = await Promise.all([data, research, ipc, slot, control, req, result].map(identity));
  const frameArgs = (g, id, expected = ids) => ['-I', '-S', '-B', path.join(runtime, 'research_read_frame.py'), String(g), id, ...expected];
  const exec = (args, cwd = slot) => run(python, args, { cwd, timeout: 8000, maxBuffer: 8192 });
  const invoke = (g, id, expected) => exec(frameArgs(g, id, expected));
  const prepare = async (g, request, phase = 1) => {
    const payload = Buffer.from(JSON.stringify(request));
    const frame = Buffer.alloc(MAX);
    payload.copy(frame);
    await overwrite(req, frame, MAX);
    await overwrite(control, state(phase, g, request.requestId, payload), CONTROL);
  };
  const snapshot = async () => Promise.all([control, req, result].map(f => fs.readFile(f)));
  const entries = async () => Promise.all((await fs.readdir(slot)).sort().map(async name => {
    const filename = path.join(slot, name), s = await fs.lstat(filename);
    return { name, length: s.size, id: await identity(filename) };
  }));
  const published = async (g, r) => {
    const wrapper = await fs.readFile(control), body = await fs.readFile(result);
    const length = wrapper.readUInt32BE(33), bytes = body.subarray(0, length);
    assert.ok(length > 0 && length <= MAX); assert.equal(body.length, MAX);
    assert.deepEqual(wrapper, state(3, g, r.requestId, bytes));
    assert.deepEqual(body.subarray(length), Buffer.alloc(MAX - length));
    const value = JSON.parse(bytes); assert.equal(value.requestId, r.requestId); assert.equal(value.schemaVersion, 1);
    return value;
  };
  return { data, project, runtime, slot, ipc, control, req, result, ids, frameArgs, invoke, exec, prepare, snapshot, entries, published };
}
const silent = async task => assert.deepEqual(await task, { stdout: '', stderr: '' });
function refusal(task, reason) {
  return assert.rejects(task, e => { assert.equal(e.code, 1); assert.equal(e.stdout, '');
    assert.equal(e.stderr, `RESEARCH_READ_FRAME_REFUSED:${reason}\n`); return true; });
}

test('managed read frame: two real prepared generations, stale replay cannot change result', async t => {
  const f = await setup(t), first = envelope(), second = envelope('fact_list_page', { limit: 1 });
  assert.notEqual(first.requestId, second.requestId);
  const files = await f.entries();
  assert.deepEqual(files.map(x => [x.name, x.length]), [['request.frame', MAX], ['result.frame', MAX], ['state.frame', CONTROL]]);
  await f.prepare(1, first); await silent(f.invoke(1, first.requestId));
  assert.deepEqual(await f.published(1, first), { schemaVersion: 1, requestId: first.requestId, ok: true,
    result: { fact_id: factId, markdown: rawFact, predecessors: [] } });
  const done1 = await f.snapshot(); await refusal(f.invoke(1, first.requestId), 'STATE_MISMATCH'); assert.deepEqual(await f.snapshot(), done1);
  // This preparation is an explicit TRUSTED fixture step, not an assertion
  // that a terminal child/output alone grants reuse to a future Node caller.
  await f.prepare(2, second);
  const next = await f.snapshot(); assert.deepEqual(next[2], done1[2]);
  await refusal(f.invoke(1, first.requestId), 'STATE_MISMATCH'); assert.deepEqual(await f.snapshot(), next);
  await silent(f.invoke(2, second.requestId));
  const result = await f.published(2, second);
  assert.equal(result.ok, true); assert.equal(result.result.page.total, 1); assert.equal(result.result.page.previewOnly, true);
  assert.deepEqual(result.result.facts.map(x => x.fact_id), [factId]);
  assert.match(result.result.facts[0].statementPreview, /Synthetic nonempty statement/);
  assert.deepEqual(await f.entries(), files);
});

test('managed read frame: writes and non-main reads are rejected before dispatch', async t => {
  const f = await setup(t, { fact: false });
  const disallowed = [envelope('gm_add', { kind: 'plan', claim: 'must not execute' }), envelope('fact_get', { fact_id: factId }, { ...binding, role: 'worker' })];
  for (const [i, r] of disallowed.entries()) {
    await f.prepare(i + 1, r); const before = await f.snapshot();
    await refusal(f.invoke(i + 1, r.requestId), 'READ_ONLY'); assert.deepEqual(await f.snapshot(), before);
    // A real facade dispatch (even a missing-fact read) creates project/control.
    await assert.rejects(fs.lstat(f.project), { code: 'ENOENT' });
  }
});

test('managed read frame: exact owner identities, content digest and consumed/unknown state fail closed', async t => {
  const f = await setup(t, { fact: false }), r = envelope();
  await f.prepare(1, r);
  for (const index of [0, 1, 2, 3, 4, 5, 6]) {
    const stale = f.ids.slice(); stale[index] = '0:1';
    const before = await f.snapshot(); await refusal(f.invoke(1, r.requestId, stale), 'IDENTITY'); assert.deepEqual(await f.snapshot(), before);
  }
  const other = envelope(), valid = await fs.readFile(f.req), wrong = Buffer.alloc(MAX);
  Buffer.from(JSON.stringify(other)).copy(wrong);
  await overwrite(f.req, wrong, MAX);
  const wrongDigest = await f.snapshot(); await refusal(f.invoke(1, r.requestId), 'REQUEST_DIGEST'); assert.deepEqual(await f.snapshot(), wrongDigest);
  await overwrite(f.req, valid, MAX);
  await f.prepare(1, r, 2);
  const consumed = await f.snapshot(); await refusal(f.invoke(1, r.requestId), 'STATE_MISMATCH'); assert.deepEqual(await f.snapshot(), consumed);
  const broken = Buffer.from(consumed[0]); broken[HEAD] ^= 1; await overwrite(f.control, broken, CONTROL);
  const unknown = await f.snapshot(); await refusal(f.invoke(1, r.requestId), 'STATE_INVALID'); assert.deepEqual(await f.snapshot(), unknown);
  await assert.rejects(fs.lstat(f.project), { code: 'ENOENT' });
});

test('managed read frame: linked or replaced frame never truncates the original', async t => {
  const f = await setup(t, { fact: false }), r = envelope();
  await f.prepare(1, r);
  const outside = path.join(f.data, 'original-result'); await fs.link(f.result, outside);
  const prior = await fs.readFile(outside); await refusal(f.invoke(1, r.requestId), 'IDENTITY');
  await fs.unlink(f.result); await fs.symlink(outside, f.result);
  await assert.rejects(f.invoke(1, r.requestId), e => e.code === 1 && e.stdout === '' && e.stderr === 'RESEARCH_READ_FRAME_FAILED\n');
  assert.deepEqual(await fs.readFile(outside), prior); await assert.rejects(fs.lstat(f.project), { code: 'ENOENT' });
});

test('managed read frame: a separate process holding Darwin flock fences launch', async t => {
  const f = await setup(t, { fact: false }), r = envelope(); await f.prepare(1, r);
  const before = await f.snapshot();
  const holder = 'import fcntl, os, subprocess, sys\n'
    + 'with open("state.frame", "r+b") as fd:\n'
    + ' fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n'
    + ' outcome = subprocess.run([sys.executable, *sys.argv[1:]], timeout=4, stdin=subprocess.DEVNULL)\n'
    + ' sys.exit(outcome.returncode)\n';
  await refusal(f.exec(['-I', '-S', '-B', '-c', holder, ...f.frameArgs(1, r.requestId)]), 'LOCK_BUSY');
  assert.deepEqual(await f.snapshot(), before); await assert.rejects(fs.lstat(f.project), { code: 'ENOENT' });
});

test('legacy research entry still does its original one-request/one-new-result exchange', async t => {
  const f = await setup(t), r = envelope(), cwd = path.join(f.ipc, r.requestId);
  await fs.mkdir(cwd);
  const req = path.join(cwd, 'request.json'), result = path.join(cwd, 'result.json');
  await fs.writeFile(req, JSON.stringify(r), { mode: 0o600 });
  const args = ['-I', '-S', '-B', path.join(f.runtime, 'research_entry.py'), req, result];
  await silent(f.exec(args, cwd));
  const before = await fs.readFile(result);
  assert.deepEqual(JSON.parse(before), { schemaVersion: 1, requestId: r.requestId, ok: true,
    result: { fact_id: factId, markdown: rawFact, predecessors: [] } });
  await assert.rejects(f.exec(args, cwd), /result already exists/);
  assert.deepEqual(await fs.readFile(result), before);
});
