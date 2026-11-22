// Standard suite: isolated fixtures only. Measurements use real directory metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
import { reportReadoutTool } from './helpers/report-readout-tool-fixture.mjs';
import { pairingFixture } from './helpers/managed-ipc-pairing-fixture.mjs';
import { CORE_CALLS_MAX_DIRECTORIES, CORE_CALLS_MAX_BYTES, CORE_CALL_RESERVATION_BYTES } from '../packages/hana-math/runtime/research-runtime.mjs';

const privatePart = 'must-not-disclose-entry';
const err = code => Object.assign(new Error(privatePart), { code });
const absent = async p => assert.rejects(fs.lstat(p), { code: 'ENOENT' });
const jsonTool = reply => JSON.parse(reply.content.find(x => x.type === 'text').text);
async function setup(t) {
  const f = await fixture(t), { projectId, context: main } = await f.create();
  const base = path.join(f.dataDir, 'research/core-calls');
  const args = { projectId }, action = { action: 'ipc_usage', ...args };
  const measure = (ctx = origin) => f.service.ipcUsage(args, ctx);
  const before = f.calls.tasks.length;
  const noRuntime = () => {
    assert.equal(f.calls.tasks.length, before); assert.deepEqual(f.calls.factories, []);
    assert.deepEqual(f.calls.core, []); assert.deepEqual(f.calls.starts, []);
  };
  return { f, base, args, action, main, measure, noRuntime };
}
const item = (used, limit) => ({ used, limit, remaining: limit - used });

for (const style of ['absent', 'empty']) test(`ipc_usage: ${style} safe root is zero; no mutation or body read`, async t => {
  const g = await setup(t);
  // The FakeSDK task callback can resolve before Project's final setup save.
  // Drain and reopen first so the traps cover only the diagnostic, not setup.
  assert.deepEqual((await g.f.service.dispose()).errors, []);
  await g.f.open();
  if (style === 'empty') await fs.mkdir(g.base, { recursive: true });
  const trapped = ['readFile', 'open', 'writeFile', 'mkdir', 'unlink', 'rmdir', 'rename'].map(n => t.mock.method(fs, n, () => assert.fail(`read-only diagnostic invoked ${n}`)));
  syncBuiltinESMExports();
  try {
    const u = await g.measure();
    assert.deepEqual(u, { scope: 'app-global-managed-ipc', atomic: false,
      countScope: { directories: 'exchange-directories-and-descendant-directories', entries: 'descendants-of-exchange-directories',
        logicalBytes: 'sum-of-regular-file-lengths', chargedBytes: 'logical-bytes-per-exchange-with-reservation-floor-when-marker-absent', attribution: 'none-project-history-read-write-not-classified' },
      directories: item(0, CORE_CALLS_MAX_DIRECTORIES), entries: item(0, 16384), logicalBytes: 0,
      chargedBytes: item(0, CORE_CALLS_MAX_BYTES), incompleteReservationBytes: CORE_CALL_RESERVATION_BYTES,
      totalReservationOverheadBytes: 0, nearLimit: false, nearLimitThresholds: { directoryRemaining: 1000, entryOrChargedPercent: 80 } });
  } finally { trapped.forEach(m => m.mock.restore()); syncBuiltinESMExports(); }
  if (style === 'absent') await absent(g.base); else assert.deepEqual(await fs.readdir(g.base), []);
  g.noRuntime();
});

test('ipc_usage: tool rejects paths, unbound, non-creator and hostile lookup before traversal; only creator reads', async t => {
  const g = await setup(t), tool = await reportReadoutTool(t, { ipcUsage: g.f.service.ipcUsage });
  const s = tool.parameters;
  const variant = s.oneOf.find(v => v.properties.action.const === 'ipc_usage');
  assert.deepEqual(variant.required, ['action', 'projectId']); assert.equal(variant.additionalProperties, false);
  assert.deepEqual(Object.keys(variant.properties).sort(), ['action', 'projectId']);
  const readdir = fs.readdir, visited = [];
  const hook = t.mock.method(fs, 'readdir', async (p, ...a) => { visited.push(p); return readdir(p, ...a); });
  try {
    for (const [input, ctx] of [[{ ...g.action, path: '/fixture/denied' }, origin], [{ action: 'ipc_usage' }, origin], [g.action, g.main],
      [g.action, { ...origin, sessionPath: '/fixture/stranger.jsonl' }], [g.action, {}], [{ ...g.action, projectId: 'project-unknown' }, origin]]) {
      const r = await tool.execute({ ...input, context: ctx }); assert.equal(r.isError, true);
      assert.match(JSON.stringify(jsonTool(r)), /RESEARCH_TOOL_INVALID_INPUT|PROJECT_OWNER_DENIED|CALLER_UNBOUND|PROJECT_NOT_FOUND/);
    }
    assert.deepEqual(visited, []);
    assert.equal((await tool.execute({ ...g.action, context: origin })).isError, false);
  } finally { hook.mock.restore(); }
  g.noRuntime();
});

test('ipc_usage: measures nested real file lengths and unfinished reservation floor across the App', async t => {
  const g = await setup(t), settled = path.join(g.base, 'closed'), pending = path.join(g.base, 'open'), nested = path.join(pending, 'another-level');
  await fs.mkdir(settled, { recursive: true }); await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(settled, '.complete'), '', { mode: 0o600 });
  await fs.writeFile(path.join(settled, privatePart), Buffer.alloc(7));
  await fs.writeFile(path.join(nested, '.complete'), Buffer.alloc(19)); // not a top-level completion marker
  await fs.writeFile(path.join(pending, 'sparse-size'), '', { mode: 0o600 });
  await fs.truncate(path.join(pending, 'sparse-size'), CORE_CALLS_MAX_BYTES * 13 / 16);
  const u = await g.measure(); assert.equal(u.logicalBytes, CORE_CALLS_MAX_BYTES * 13 / 16 + 26);
  assert.deepEqual(u.directories, item(3, CORE_CALLS_MAX_DIRECTORIES)); assert.deepEqual(u.entries, item(5, 16384));
  assert.deepEqual(u.chargedBytes, item(u.logicalBytes, CORE_CALLS_MAX_BYTES)); assert.equal(u.nearLimit, true);
  assert.equal(u.incompleteReservationBytes, CORE_CALL_RESERVATION_BYTES); assert.equal(u.totalReservationOverheadBytes, 0);
  await fs.truncate(path.join(pending, 'sparse-size'), 0);
  const small = await g.measure(); assert.equal(small.logicalBytes, 26);
  assert.deepEqual(small.chargedBytes, item(7 + CORE_CALL_RESERVATION_BYTES, CORE_CALLS_MAX_BYTES));
  assert.equal(small.incompleteReservationBytes, CORE_CALL_RESERVATION_BYTES);
  assert.equal(small.totalReservationOverheadBytes, CORE_CALL_RESERVATION_BYTES - 19);
  assert.equal(small.totalReservationOverheadBytes, small.chargedBytes.used - small.logicalBytes);
  assert.equal(small.nearLimit, false); assert.doesNotMatch(JSON.stringify(small), new RegExp(privatePart)); g.noRuntime();
});

for (const style of ['symlink-child', 'symlink-root', 'hardlink', 'marker', 'io', 'gone', 'abort', 'over-cap'])
  test(`ipc_usage: ${style} rejects entire observation, no count or name disclosure`, async t => {
    const g = await setup(t), tool = await reportReadoutTool(t, { ipcUsage: g.f.service.ipcUsage });
    const dir = path.join(g.base, 'exchange'), file = path.join(dir, privatePart), original = fs.lstat;
    let hook;
    if (style === 'symlink-root') await fs.symlink(g.f.dataDir, g.base);
    else {
      await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'counted-first'), 'never any partial count');
      if (style === 'symlink-child') await fs.symlink(g.f.dataDir, file);
      else if (style === 'hardlink') await fs.link(path.join(dir, 'counted-first'), file);
      else if (style === 'marker') await fs.writeFile(path.join(dir, '.complete'), 'bad', { mode: 0o600 });
      else {
        await fs.writeFile(file, 'fiction');
        if (style === 'over-cap') await fs.truncate(file, CORE_CALLS_MAX_BYTES + 1);
        else {
          const fault = { io: 'EIO', gone: 'ENOENT', abort: 'ABORT_ERR' }[style];
          hook = t.mock.method(fs, 'lstat', async (p, ...a) => { if (p === file) throw err(fault); return original(p, ...a); });
        }
      }
    }
    try {
      const r = await tool.execute({ ...g.action, context: origin }); assert.equal(r.isError, true); const text = JSON.stringify(r);
      assert.match(text, /PROJECT_IPC_USAGE_UNAVAILABLE/);
      assert.doesNotMatch(text, /must-not-disclose-entry|chargedBytes|logicalBytes|totalReservationOverheadBytes|directory-limit|byte-limit|managedIpcRefusal/);
      assert.ok(!text.includes(g.f.dataDir));
    } finally { hook?.mock.restore(); }
    g.noRuntime();
  });

test('ipc_usage: creator revocation during scan never discloses captured aggregate', async t => {
  const g = await setup(t), dir = path.join(g.base, 'exchange'); await fs.mkdir(dir, { recursive: true });
  const reached = defer(), release = defer(), old = fs.readdir;
  const hook = t.mock.method(fs, 'readdir', async (p, ...a) => { if (p === dir) { reached.resolve(); await release.promise; } return old(p, ...a); });
  try {
    const reading = g.measure(); await reached.promise;
    g.f.behavior.ownListResponse = { sessions: [{ sessionId: 'creator-stable', path: origin.sessionPath, ownerPluginId: 'hana-math', lifecycle: 'active', visibility: 'public' }] };
    release.resolve(); await assert.rejects(reading, { code: 'PROJECT_OWNER_DENIED' });
  } finally { release.resolve(); hook.mock.restore(); }
  g.noRuntime();
});

test('ipc_usage: equal-length write and read history are indistinguishable publicly', async t => {
  const g = await setup(t), tool = await reportReadoutTool(t, { ipcUsage: g.f.service.ipcUsage });
  const id = 'private-exchange-id', pendingId = 'private-unconfirmed-exchange';
  const closed = path.join(g.base, id), pending = path.join(g.base, pendingId);
  await fs.mkdir(closed, { recursive: true }); await fs.mkdir(pending);
  await fs.writeFile(path.join(closed, '.complete'), '', { mode: 0o600 });
  await fs.writeFile(path.join(closed, 'result.json'), '{"ok":true}');
  await fs.writeFile(path.join(pending, 'request.json'), Buffer.alloc(17));
  // Names and semantics never participate in accounting; hold both lengths constant.
  const request = path.join(closed, 'request.json'), run = () => tool.execute({ ...g.action, context: origin });
  async function observe(operation, requestId) {
    await fs.writeFile(request, JSON.stringify({ operation, requestId }).padEnd(128, ' '));
    const r = await run(); assert.equal(r.isError, false);
    const text = JSON.stringify(r);
    for (const secret of [g.f.dataDir, g.base, id, pendingId, requestId, operation, g.args.projectId]) assert.ok(!text.includes(secret), 'unexpected attribution');
    return jsonTool(r);
  }
  const write = await observe('fact_submit', 'private-write-request-id');
  const read = await observe('fact_list_page', 'private-read-request-id');
  assert.deepEqual(write, read);
  assert.equal(write.countScope.attribution, 'none-project-history-read-write-not-classified');
  assert.equal(write.totalReservationOverheadBytes, CORE_CALL_RESERVATION_BYTES - 17);
  assert.equal(write.incompleteReservationBytes, CORE_CALL_RESERVATION_BYTES);
  g.noRuntime();
});

test('ipc_usage: 1001 to 1000 remaining is an advisory crossing; normal bridge reads still succeed', { timeout: 60000 }, async t => {
  const g = await pairingFixture(t), root = path.join(g.f.dataDir, 'research/core-calls');
  // One synthetic root. Descendant directories use the same production counter,
  // without creating thousands of otherwise unnecessary request/result files.
  const history = path.join(root, 'retained-fixture');
  for (const [name, content] of [['request.json', '{}'], ['result.json', '{}'], ['.complete', '']])
    await fs.writeFile(path.join(history, name), content, { mode: 0o600, flag: 'wx' });
  const count = CORE_CALLS_MAX_DIRECTORIES - 1001 - (await fs.readdir(root)).length;
  for (let base = 0; base < count; base += 16) {
    await Promise.all(Array.from({ length: Math.min(16, count - base) }, (_, i) =>
      fs.mkdir(path.join(history, `fixture-dir-${base + i}`), { mode: 0o700 })));
  }
  const observe = async (remaining, nearLimit) => {
    const counts = await g.counts(), reply = await g.execute({ action: 'ipc_usage', projectId: g.projectId });
    assert.equal(reply.isError, false); const u = jsonTool(reply);
    assert.equal(u.directories.remaining, remaining); assert.equal(u.nearLimit, nearLimit);
    assert.equal(u.totalReservationOverheadBytes, 0);
    for (const row of [u.entries, u.chargedBytes]) assert.ok(row.used * 100 < row.limit * 80);
    assert.deepEqual(await g.counts(), counts); return u;
  };
  const read = async () => {
    const at = g.reads.length, result = await g.execute({ action: 'result', projectId: g.projectId, limit: 1 });
    assert.equal(result.isError, false); assert.equal(jsonTool(result).page.returned, 1);
    assert.deepEqual(g.reads.slice(at).map(r => r.operation), ['fact_list_page']);
  };
  const one = await observe(1001, false); await read();
  const two = await observe(1000, true); await read();
  const three = await observe(999, true);
  assert.equal(two.directories.used, one.directories.used + 1); assert.equal(three.directories.used, two.directories.used + 1);
  t.diagnostic(JSON.stringify({ remaining: [1001, 1000, 999], nearLimit: [false, true, true], acceptedBridgeReads: 2 }));
});
