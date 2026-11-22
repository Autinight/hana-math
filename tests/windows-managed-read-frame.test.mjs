// Portable codec replay: uses real Python 3.12.14 and real file handles in a
// synthetic temp tree. It does not simulate Windows Host or run research.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createManagedReadOwner, managedReadOwnerFor, managedDashboardReadOwnerFor, sealWindowsReadFrame }
  from '../packages/hana-math/runtime/managed-read-owner.mjs';

const run = promisify(execFile), python = process.env.HANA_TEST_READ_FRAME_PYTHON ?? 'python3.12';
const helper = fileURLToPath(new URL('../packages/hana-math/runtime/research_read_windows_frame.py', import.meta.url));
const projectId = 'project-windows-frame', frameSize = 1 << 20;
const binding = { role: 'main', projectId, runId: 'run-fixture', author: 'fixture' };
const fixture = `
import importlib.util
import pathlib
import sys
assert sys.version_info[:3] == (3, 12, 14)
spec = importlib.util.spec_from_file_location('windows_frame_fixture', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
gen, nonce, project, length, digest, response = sys.argv[2:]
with open('request.frame', 'rb') as request:
    frame = request.read(module.FRAME + 1)
padded, receipt = module.publication(frame, int(length), bytes.fromhex(digest), int(gen), nonce, project, response.encode('utf-8'))
with open('result.frame', 'xb') as result:
    result.write(padded)
with open('published.frame', 'xb') as published:
    published.write(receipt)
`;
const frameDir = async (t, options = {}) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'windows-wire-fixture-')));
  const opened = [];
  t.after(async () => {
    try { await Promise.all(opened.map(fd => fd.close())); }
    finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  const open = async (file, flags) => { const fd = await fs.open(file, flags); opened.push(fd); return fd; };
  const names = { request: 'request.frame', result: 'result.frame', receipt: 'published.frame' };
  const requestId = options.requestId ?? randomUUID(), generation = options.generation ?? 1;
  const make = (request = {}, fields = {}) => sealWindowsReadFrame({ generation, requestId, projectId,
    request: JSON.stringify({ schemaVersion: 1, requestId, operation: 'dashboard_factgraph', context: binding,
      arguments: {}, ...request }), ...fields });
  const sealed = make();
  const file = key => path.join(dir, names[key]);
  const request = await open(file('request'), 'wx+');
  await request.writeFile(sealed.requestFrame);
  const value = { schemaVersion: 1, requestId, ok: true, result: { value: 'Σ\n完整证据', total: 0 } };
  const publish = (args = sealed.args, response = value) => run(python,
    ['-I', '-S', '-B', '-c', fixture, helper, ...args, JSON.stringify(response)], { cwd: dir, timeout: 8000 });
  const terminal = { runtimeId: 'fixture-run', info: { runtimeId: 'fixture-run', state: 'exited', exitCode: 0, signal: null } };
  const pins = async () => {
    const result = await open(file('result'), 'r'), receipt = await open(file('receipt'), 'r');
    const files = { request, result, receipt };
    const stamps = await Promise.all(Object.values(files).map(fd => fd.stat({ bigint: true })));
    const verifyPinned = async () => {
      for (const [i, key] of Object.keys(names).entries()) {
        const stat = await fs.lstat(file(key), { bigint: true });
        if (!stat.isFile() || stat.dev !== stamps[i].dev || stat.ino !== stamps[i].ino || stat.nlink !== 1n) return false;
      }
      return true;
    };
    return { files, verifyPinned, guard: () => {}, terminal };
  };
  return { make, file, publish, value, pins, sealed, requestId };
};

const fenced = { code: 'RESEARCH_RUNTIME_READ_SLOT_FENCED' };

test('Python and Node agree on full sealed request, response and receipt bytes; one use only', async t => {
  const f = await frameDir(t, { generation: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(await f.publish(), { stdout: '', stderr: '' });
  const p = await f.pins();
  assert.deepEqual(await f.sealed.takePublished(p), f.value);
  await assert.rejects(f.sealed.takePublished(p), fenced);
  // The exclusive write here belongs only to the fixture, not to the codec.
  await assert.rejects(f.publish(), { code: 1 });
});

test('a stopped/failed/nonzero/wrong-id receipt never yields a payload', async t => {
  const f = await frameDir(t);
  await f.publish();
  const { terminal, ...p } = await f.pins();
  for (const fields of [{ state: 'stopped' }, { state: 'ready' }, { exitCode: 7 }, { signal: 'SIGTERM' }, { runtimeId: 'different' }]) {
    await assert.rejects(f.make().takePublished({ ...p, terminal: { ...terminal, info: { ...terminal.info, ...fields } } }),
      { code: 'RESEARCH_RUNTIME_INVALID_RESULT' });
  }
});

test('reject stale generation or nonce, another sealed request, or a guard revoked during verification', async t => {
  const f = await frameDir(t);
  await f.publish();
  const p = await f.pins();
  await assert.rejects(f.make({}, { generation: 2 }).takePublished(p), fenced);
  const requestId = randomUUID();
  await assert.rejects(f.make({ requestId }, { requestId }).takePublished(p), fenced);
  await assert.rejects(f.make({ arguments: { changed: true } }).takePublished(p), fenced);
  let checks = 0, granted = true;
  const revoked = Object.assign(new Error('synthetic guard revoked'), { code: 'RESEARCH_RUNTIME_DENIED' });
  await assert.rejects(f.make().takePublished({ ...p, guard: () => { if (!granted) throw revoked; },
    async verifyPinned() { if (++checks === 2) granted = false; return p.verifyPinned(); } }), error => error === revoked);
});

test('refuse extra padding bytes, changed output inode or malformed publish record', async t => {
  const f = await frameDir(t);
  await f.publish();
  const p = await f.pins();
  const output = await fs.open(f.file('result'), 'r+');
  try { await output.write(Buffer.from([1]), 0, 1, frameSize - 1); } finally { await output.close(); }
  await assert.rejects(f.make().takePublished(p), fenced);
  await fs.truncate(f.file('receipt'), 99);
  await assert.rejects(f.make().takePublished(p), fenced);
  await fs.rename(f.file('result'), f.file('result') + '.old');
  await fs.copyFile(f.file('result') + '.old', f.file('result'));
  assert.equal(await p.verifyPinned(), false);
  await assert.rejects(f.make().takePublished(p), fenced);
});

test('Python refuses wrong project, altered request digest and response nonce without writing anything', async t => {
  const f = await frameDir(t);
  const args = f.sealed.args;
  await assert.rejects(f.publish([args[0], args[1], 'other-project', ...args.slice(3)]), { code: 1 });
  await assert.rejects(f.publish([...args.slice(0, 4), '0'.repeat(64)]), { code: 1 });
  await assert.rejects(f.publish(args, { ...f.value, requestId: randomUUID() }), { code: 1 });
  for (const key of ['result', 'receipt']) await assert.rejects(fs.lstat(f.file(key)), { code: 'ENOENT' });
});

test('reject writes, non-main/wrong project and over-limit inputs before admission', async t => {
  const f = await frameDir(t);
  for (const change of [{ operation: 'fact_submit' }, { context: { ...binding, role: 'worker' } },
    { context: { ...binding, projectId: 'wrong-project' } }, { arguments: { huge: 'x'.repeat(frameSize) } }]) {
    assert.throws(() => f.make(change), { code: 'RESEARCH_RUNTIME_INVALID_REQUEST' });
  }
});

if (process.platform === 'win32') {
  test('Windows production frame owner refuses both lanes before touching disk or budget', async () => {
    const sdk = { get dataDir() { assert.fail('unsupported lane touched data'); } };
    const owner = createManagedReadOwner(sdk);
    try {
      for (const get of [managedReadOwnerFor, managedDashboardReadOwnerFor]) {
        const prepare = get(owner, sdk);
        await assert.rejects(prepare({ reserve() { assert.fail('unsupported lane touched budget'); } }),
          { code: 'RESEARCH_RUNTIME_UNSUPPORTED' });
      }
    } finally { await owner.dispose(); }
  });
}
