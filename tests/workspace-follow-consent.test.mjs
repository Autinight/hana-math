import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import filesystem from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fixture, origin, defer } from './helpers/project-service-fixture.mjs';
import { createWorkspaceFollowConsent, workspaceFollowBinding } from '../packages/hana-math/workspace-follow-consent.mjs';

const storedPath = (f, projectId) => path.join(f.dataDir, 'research/projects', projectId, 'project.json');
const metadata = async (f, projectId) => JSON.parse(await fs.readFile(storedPath(f, projectId)));
const calls = f => Object.fromEntries(['tasks', 'schedules', 'sessions', 'sends', 'starts', 'stops', 'core', 'factories'].map(k => [k, f.calls[k].length]));
async function settled(f, projectId) {
  for (let i = 0; i < 100; i++) {
    if ((await metadata(f, projectId)).taskSettlement === 'confirmed') return;
    await delay(5);
  }
  assert.fail('setup receipt did not persist');
}

test('policy readers see invalid before durable commit; callbacks cannot enable pending/failed state', async () => {
  const p = { meta: { projectId: 'fixture-project', creator: { sessionId: 'fixture-creator', sessionPath: '/opaque/creator' },
    taskId: 'fixture-task', main: { sessionId: 'fixture-main' } } };
  const events = [], entered = defer(), release = defer(); let writes = 0;
  const policy = createWorkspaceFollowConsent({
    binding: p => workspaceFollowBinding(p.meta, ['sessionId']), authorize: async () => ({ guard() {} }),
    async save(p, record, guard) {
      guard(); writes++;
      if (writes === 1) { entered.resolve(); await release.promise; }
      if (writes === 3) throw new Error('fixture persistence failed');
      p.meta.workspaceFollow = record;
    },
    changed(p, enabled) { events.push([enabled, policy.getState(p), policy.getStamp(p)]); },
  });
  assert.equal(policy.getState(p), 'absent'); assert.equal(policy.getStamp(p), null); assert.equal(policy.getArchiveStamp(p), null);
  const first = policy.set(p, true); await entered.promise;
  const pending = policy.getStamp(p);
  assert.equal(policy.getState(p), 'invalid'); assert.match(pending, /^[a-f0-9]{32}$/);
  assert.equal(policy.getArchiveStamp(p), pending);
  assert.deepEqual(events, [[false, 'invalid', pending]]);
  release.resolve(); await first;
  assert.equal(policy.getStamp(p), pending); assert.equal(policy.getArchiveStamp(p), null);
  await policy.set(p, true);
  assert.equal(writes, 1);
  assert.deepEqual(events.slice(1), [[true, 'enabled', pending], [true, 'enabled', pending]]);
  p.meta.main.sessionId = 'replacement-main';
  assert.equal(policy.getState(p), 'invalid');
  p.meta.main.sessionId = 'fixture-main';
  await policy.set(p, false);
  const revoked = policy.getArchiveStamp(p);
  assert.match(revoked, /^[a-f0-9]{32}$/); assert.notEqual(revoked, pending);
  await assert.rejects(policy.set(p, true), /fixture persistence failed/);
  assert.equal(policy.getState(p), 'invalid'); assert.equal(events.at(-1)[0], false);
  assert.equal(p.meta.workspaceFollow.enabled, false);
});

test('explicit creator consent and tombstone persist only for the selected project; no business work', async t => {
  const f = await fixture(t), { projectId } = await f.create(), other = (await f.create()).projectId;
  const args = { projectId }, before = calls(f);
  assert.equal((await metadata(f, projectId)).workspaceFollow, undefined);
  await f.service.dispose(); await f.open(); // No setup grant from this instance.
  assert.deepEqual(await f.service.dashboardFollow(args, origin), { projectId, enabled: true });
  const enabled = (await metadata(f, projectId)).workspaceFollow;
  assert.deepEqual(Object.keys(enabled).sort(), ['archiveEpoch', 'binding', 'enabled', 'schemaVersion', 'stamp']);
  assert.equal(enabled.archiveEpoch, null);
  assert.equal(enabled.enabled, true); assert.match(enabled.binding, /^[a-f0-9]{64}$/);
  assert.match(enabled.stamp, /^[a-f0-9]{32}$/);
  assert.equal((await metadata(f, other)).workspaceFollow, undefined);
  const file = storedPath(f, projectId), initial = await fs.readFile(file);
  await f.service.dispose(); await f.open();
  assert.deepEqual(await f.service.dashboardFollow(args, origin), { projectId, enabled: true });
  assert.deepEqual(await fs.readFile(file), initial, 'duplicate request is idempotent even after restart');
  assert.deepEqual(await f.service.dashboardUnfollow(args, origin), { projectId, enabled: false });
  const disabled = (await metadata(f, projectId)).workspaceFollow;
  assert.equal(disabled.enabled, false); assert.notEqual(disabled.stamp, enabled.stamp);
  assert.equal(disabled.archiveEpoch, disabled.stamp);
  const tombstone = await fs.readFile(file);
  await f.service.dispose(); await f.open();
  assert.deepEqual(await f.service.dashboardUnfollow(args, origin), { projectId, enabled: false });
  assert.deepEqual(await fs.readFile(file), tombstone);
  await f.service.dashboardFollow(args, origin);
  const reenabled = (await metadata(f, projectId)).workspaceFollow;
  assert.equal(reenabled.enabled, true); assert.notEqual(reenabled.stamp, enabled.stamp);
  assert.notEqual(reenabled.stamp, disabled.stamp); assert.equal(reenabled.binding, enabled.binding);
  assert.equal(reenabled.archiveEpoch, reenabled.stamp);
  assert.equal((await metadata(f, other)).workspaceFollow, undefined);
  assert.deepEqual(calls(f), before);
});

test('main, worker, external conversation, page and arguments carrying extra authority cannot enroll or revoke', async t => {
  const f = await fixture(t), { projectId, context } = await f.create();
  const args = { projectId }, file = storedPath(f, projectId), before = await fs.readFile(file);
  const worker = { sessionPath: '/fixture/worker.jsonl', callToken: 'worker-token' };
  f.host.set(worker.sessionPath, { sessionId: 'worker-fixture-id', path: worker.sessionPath, agentId: 'worker', namespace: 'app', ownerPluginId: 'hana-math', lifecycle: 'active' });
  for (const method of ['dashboardFollow', 'dashboardUnfollow']) {
    for (const ctx of [context, worker, { sessionPath: '/fixture/foreign.jsonl', callToken: 'foreign-token' }]) {
      await assert.rejects(f.service[method](args, ctx), { code: 'PROJECT_OWNER_DENIED' });
    }
    await assert.rejects(f.service[method](args, { principal: { kind: 'app', appId: 'hana-math' } }), { code: 'CALLER_UNBOUND' });
    await assert.rejects(f.service[method](args, { ...origin, document: { id: 'doc' } }), { code: 'PROJECT_OWNER_DENIED' });
    await assert.rejects(f.service[method](args, { ...origin, sessionId: 'not-original-session' }), { code: 'PROJECT_OWNER_DENIED' });
    await assert.rejects(f.service[method]({ ...args, creator: origin.sessionPath }, origin), { code: 'PROJECT_INVALID_INPUT' });
    const hidden = Object.defineProperty({ ...args }, 'enabled', { value: true });
    await assert.rejects(f.service[method](hidden, origin), { code: 'PROJECT_INVALID_INPUT' });
    let accessed = false;
    await assert.rejects(f.service[method]({ get projectId() { accessed = true; return projectId; } }, origin), { code: 'PROJECT_INVALID_INPUT' });
    assert.equal(accessed, false);
  }
  assert.deepEqual(await fs.readFile(file), before);
});

test('creator path alone is insufficient when the Host setup receipt, creator isolation or main identity fails', async t => {
  const f = await fixture(t), { projectId, queued, status } = await f.create();
  const before = await fs.readFile(storedPath(f, projectId));
  const setup = f.tasks.get(queued.taskId), main = f.host.get(status.main.sessionPath), role = f.agents[0];
  const creator = f.host.get(origin.sessionPath), failures = [
    [setup, 'parentSessionId', 'other-creator', 'PROJECT_TASK_UNCONFIRMED'],
    [setup, 'status', 'failed', 'PROJECT_OWNER_DENIED'],
    [creator, 'ownerPluginId', 'hana-math', 'PROJECT_OWNER_DENIED'],
    [main, 'lifecycle', 'archived', 'PROJECT_MAIN_DENIED'],
    [role, 'deletedAt', 1, 'PROJECT_MAIN_DENIED'],
  ];
  for (const [row, key, value, code] of failures) {
    const previous = row[key]; row[key] = value;
    try { await assert.rejects(f.service.dashboardFollow({ projectId }, origin), { code }); }
    finally { row[key] = previous; }
  }
  assert.deepEqual(await fs.readFile(storedPath(f, projectId)), before);
  assert.deepEqual(await f.service.dashboardFollow({ projectId }, origin), { projectId, enabled: true });
});

test('original creator can revoke with an archived main and unavailable roster, but cannot follow', async t => {
  const f = await fixture(t), { projectId, queued, status, context } = await f.create(), args = { projectId };
  await settled(f, projectId);
  await f.service.dashboardFollow(args, origin);
  f.host.get(status.main.sessionPath).lifecycle = 'archived';
  let rosterReads = 0;
  f.sdk.agents.list = async () => { rosterReads++; throw new Error('fixture roster unavailable'); };
  const original = await fs.readFile(storedPath(f, projectId));
  const setup = f.tasks.get(queued.taskId);
  setup.status = 'failed';
  await assert.rejects(f.service.dashboardUnfollow(args, origin), { code: 'PROJECT_OWNER_DENIED' });
  setup.status = 'completed';
  await assert.rejects(f.service.dashboardUnfollow(args, context), { code: 'PROJECT_OWNER_DENIED' });
  assert.deepEqual(await fs.readFile(storedPath(f, projectId)), original);
  assert.deepEqual(await f.service.dashboardUnfollow(args, origin), { projectId, enabled: false });
  assert.equal(rosterReads, 0, 'revocation does not consult the main roster');
  const tombstone = await fs.readFile(storedPath(f, projectId));
  assert.equal(JSON.parse(tombstone).workspaceFollow.enabled, false);
  await f.service.dispose(); await f.open();
  await assert.rejects(f.service.dashboardFollow(args, origin), { code: 'PROJECT_MAIN_DENIED' });
  f.host.get(status.main.sessionPath).lifecycle = 'active';
  await assert.rejects(f.service.dashboardFollow(args, origin), /fixture roster unavailable/);
  assert.equal(rosterReads, 1);
  assert.deepEqual(await f.service.dashboardUnfollow(args, origin), { projectId, enabled: false });
  assert.equal(rosterReads, 1);
  assert.deepEqual(await fs.readFile(storedPath(f, projectId)), tombstone);
});

async function stagedEnable(file) {
  const parent = path.dirname(file);
  for (const tmp of (await fs.readdir(parent)).filter(n => n.startsWith('project.json.') && n.endsWith('.tmp'))) {
    const packet = await fs.readFile(path.join(parent, tmp), 'utf8');
    if (packet && JSON.parse(packet).workspaceFollow?.enabled === true) return true;
  }
  return false;
}

for (const change of ['caller identity', 'Host setup receipt', 'Host main roster']) {
  test(`cold reload keeps the previous policy when ${change} changes after staging`, async t => {
    const f = await fixture(t), { projectId, queued } = await f.create(), args = { projectId }, ctx = { ...origin };
    await settled(f, projectId);
    await f.service.dashboardUnfollow(args, origin);
    const file = storedPath(f, projectId), prior = await fs.readFile(file), lstat = fs.lstat;
    const setup = f.tasks.get(queued.taskId);
    let changed = false;
    const mock = t.mock.method(fs, 'lstat', async (name, ...options) => {
      if (name === file && !changed && await stagedEnable(file)) {
        changed = true;
        if (change === 'caller identity') ctx.sessionId = 'changed-caller';
        if (change === 'Host setup receipt') setup.status = 'pending';
        if (change === 'Host main roster') f.agents[0].deletedAt = 1;
      }
      return lstat(name, ...options);
    }); syncBuiltinESMExports();
    try {
      await assert.rejects(f.service.dashboardFollow(args, ctx), {
        code: change === 'Host main roster' ? 'PROJECT_MAIN_DENIED' : 'PROJECT_OWNER_DENIED',
      });
      assert.equal(changed, true, 'the new opt-in was fully staged');
      assert.ok((await fs.readFile(file)).equals(prior), 'the rename never replaced any previous bytes');
      assert.equal((await fs.readdir(path.dirname(file))).some(n => n.endsWith('.tmp')), false);
    } finally {
      mock.mock.restore(); syncBuiltinESMExports();
      setup.status = 'completed'; f.agents[0].deletedAt = null;
    }
    await f.service.dispose(); await f.open();
    assert.equal((await metadata(f, projectId)).workspaceFollow.enabled, false);
    assert.deepEqual(await f.service.dashboardUnfollow(args, origin), { projectId, enabled: false });
    assert.deepEqual(await fs.readFile(file), prior, 'cold reload uses the same tombstone and nonce');
  });
}

test('final synchronous commit guard still refuses identity drift after the late Host checks', async t => {
  const f = await fixture(t), { projectId } = await f.create(), args = { projectId }, ctx = { ...origin };
  await settled(f, projectId);
  const file = storedPath(f, projectId), prior = await fs.readFile(file), stat = filesystem.lstatSync;
  let staged = false, drifted = false;
  const observed = t.mock.method(filesystem, 'lstatSync', (name, ...options) => {
    const result = stat(name, ...options);
    if (typeof name === 'string' && name.startsWith(`${file}.`) && name.endsWith('.tmp')) {
      staged = true;
      if (!drifted) { drifted = true; ctx.sessionId = 'no-longer-the-original-caller'; }
    }
    return result;
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(f.service.dashboardFollow(args, ctx), { code: 'PROJECT_OWNER_DENIED' });
    assert.ok(staged && drifted, 'changed identity during the final staged-file identity check');
    assert.ok((await fs.readFile(file)).equals(prior));
  } finally { observed.mock.restore(); syncBuiltinESMExports(); }
  await f.service.dispose(); await f.open();
  assert.equal((await metadata(f, projectId)).workspaceFollow, undefined);
  assert.ok((await fs.readFile(file)).equals(prior));
});

test('serialized revoke during an enabling write leaves a durable tombstone', async t => {
  const f = await fixture(t), { projectId } = await f.create(), args = { projectId };
  await settled(f, projectId);
  const file = storedPath(f, projectId), lstat = fs.lstat, entered = defer(), release = defer();
  const mock = t.mock.method(fs, 'lstat', async (name, ...options) => {
    if (name === file && await stagedEnable(file)) {
      entered.resolve(); await release.promise;
    }
    return lstat(name, ...options);
  }); syncBuiltinESMExports();
  try {
    const enable = f.service.dashboardFollow(args, origin); enable.catch(() => {});
    await Promise.race([entered.promise, enable.then(() => assert.fail('enable skipped its durable write'))]);
    const disable = f.service.dashboardUnfollow(args, origin); disable.catch(() => {});
    assert.equal((await metadata(f, projectId)).workspaceFollow, undefined);
    release.resolve();
    assert.deepEqual(await enable, { projectId, enabled: true });
    assert.deepEqual(await disable, { projectId, enabled: false });
    assert.equal((await metadata(f, projectId)).workspaceFollow.enabled, false);
  } finally { release.resolve(); mock.mock.restore(); syncBuiltinESMExports(); }
});

test('failed persistence reports no consent and keeps the previous disk state', async t => {
  const f = await fixture(t), { projectId } = await f.create();
  await settled(f, projectId);
  const file = storedPath(f, projectId), rename = filesystem.renameSync;
  const mock = t.mock.method(filesystem, 'renameSync', (from, to) => {
    if (to === file) throw Object.assign(new Error('synthetic persist failure'), { code: 'EIO' });
    return rename(from, to);
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(f.service.dashboardFollow({ projectId }, origin), { code: 'EIO' });
    assert.equal((await metadata(f, projectId)).workspaceFollow, undefined);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  const health = await f.service.status(projectId, origin);
  assert.equal(health.persistenceFailed, true);
  await assert.rejects(f.service.dashboardFollow({ projectId }, origin), { code: 'PROJECT_PERSISTENCE_FAILED' });
});

test('malformed legacy extension does not invalidate ordinary status or authorize absent an explicit creator request', async t => {
  const f = await fixture(t), { projectId } = await f.create();
  await settled(f, projectId);
  await f.service.dispose();
  const saved = await metadata(f, projectId); saved.workspaceFollow = { enabled: true };
  await fs.writeFile(storedPath(f, projectId), JSON.stringify(saved));
  await f.open();
  assert.equal((await f.service.status(projectId, origin)).state, 'ready');
  assert.deepEqual((await metadata(f, projectId)).workspaceFollow, { enabled: true });
  assert.deepEqual(await f.service.dashboardFollow({ projectId }, origin), { projectId, enabled: true });
  assert.match((await metadata(f, projectId)).workspaceFollow.binding, /^[a-f0-9]{64}$/);
});
