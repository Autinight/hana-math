import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as archiveModule from '../packages/hana-math/workspace-snapshot-archive.mjs';
import { createContextStore } from '../packages/hana-math/context-service.mjs';
import { liveChannels, livePaths } from '../packages/hana-math/ui/dashboard/live-protocol.mjs';

const role = ['result', 'result', 'result', 'result', 'judgment', 'judgment', 'deadend', 'deadend', 'verify', 'strategy', 'strategy'];
const projectId = 'fixture-project', endedAt = 1760000000123, scopeSeal = 'c'.repeat(64);
const inventoryRevision = 'b'.repeat(64), a = '0123456789000001', b = '0123456789000002';
const overview = { view: 'overview' }, graph = { view: 'factgraph' }, verification = { view: 'channel', kind: 'verification' };
const identity = { projectId, endedAt, scopeSeal }, allow = () => {};
function publishable(meta = identity) {
  const panels = {};
  const verify = { id: 'd'.repeat(16), kind: 'verification', author: 'worker-1', timestamp_utc: '2026-01-01T00:00:00+00:00', claim: 'Claim',
    evidence: 'verdict: wrong', verifiable: false, status: 'open', fact_id: null, links: { source_id: null, predecessors: [a] }, glossary: {},
    verdict: 'wrong', write_error: null, verification_report: { summary: 'Not proven', gaps: [{ location: 'Lemma', issue: 'Gap' }], critical_errors: [] } };
  const annotation = { id: 'f'.repeat(16), kind: 'conclusion', links: { fact_ids: ['abc123'] } };
  const channel_counts = Object.fromEntries(liveChannels.map(k => [k, Number(k === 'verification' || k === 'conclusion')]));
  const node = (id, predecessors, depth) => ({ id, predecessors, depth, author: 'fixture', problem_id: 'p', statement: 'Claim', proof: 'Proof', intuition: '' });
  panels['/api/overview'] = { project: meta.projectId, updated_at: meta.endedAt / 1000, facts: 2, facts_with_predecessors: 1,
    facts_by_author: { fixture: 2 }, verdicts: { wrong: 1 }, channel_counts };
  panels['/api/factgraph'] = { nodes: [node(a, [], 0), node(b, [a], 1)], edges: [{ source: a, target: b }], max_depth: 1 };
  panels['/api/channels'] = { channels: liveChannels.map((kind, i) => ({ kind, role: role[i], count: channel_counts[kind] })) };
  for (const kind of liveChannels) panels[`/api/channel/${kind}`] = { kind, count: channel_counts[kind],
    entries: kind === 'verification' ? [verify] : kind === 'conclusion' ? [annotation] : [] };
  return { ...meta, inventoryRevision, panels };
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-archive-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createContextStore(root), paths = { reads: new Set(), writes: new Set() };
  const audited = { ...store, readWitness(name) { paths.reads.add(name); return store.readWitness(name); },
    write(name, bytes, ...options) {
      assert.ok(Buffer.byteLength(bytes) <= 2 * 1024 * 1024, 'each write must be readable by createContextStore');
      paths.writes.add(name); return store.write(name, bytes, ...options);
    } };
  const newArchive = (storage = audited) => archiveModule.createWorkspaceSnapshotArchive(storage);
  return { root, store, audited, paths, newArchive, archive: newArchive() };
}

test('restores one immutable ticket and deep copies all fourteen canonical fixed views', async t => {
  const f = await fixture(t), x = f.archive, packet = publishable();
  assert.equal(await x.load(), null);
  await x.begin(identity, allow);
  assert.equal(x.latest(), null);
  const ticket = await x.publish(packet, allow);
  assert.equal(x.latest(), ticket);
  assert.ok(Object.isFrozen(ticket));
  assert.deepEqual(ticket, { ...identity, inventoryRevision });
  assert.throws(() => x.read({ ...ticket }, overview));
  assert.throws(() => x.read(ticket, { view: 'overview', updated_at: 1 }));
  assert.throws(() => x.read(ticket, { view: 'channel', kind: '../../project.json' }));
  x.read(ticket, graph).nodes[0].proof = 'changed';
  packet.panels['/api/overview'].facts = 99;
  assert.equal(x.read(ticket, overview).facts, 2);
  assert.equal(x.read(ticket, graph).nodes[0].proof, 'Proof');
  const readBack = f.newArchive(), loaded = await readBack.load();
  assert.equal(await readBack.load(), loaded);
  assert.notEqual(loaded, ticket);
  assert.deepEqual(loaded, ticket);
  assert.throws(() => readBack.read(ticket, overview));
  for (const route of livePaths) {
    const selection = route.startsWith('/api/channel/') ? { view: 'channel', kind: route.split('/').at(-1) } : { view: route.slice(5) };
    assert.deepEqual(readBack.read(loaded, selection), publishable().panels[route]);
  }
  assert.equal(readBack.read(loaded, verification).entries[0].fact_id, null);
  assert.equal((await fs.stat(f.store.absolute([...f.paths.reads][0]))).mode & 0o777, 0o600);
});

test('pending high-water survives reopen; stale and tied identities cannot publish', async t => {
  const f = await fixture(t), x = f.archive;
  const previous = await x.publish(publishable(), allow);
  const later = { ...identity, endedAt: endedAt + 100, projectId: 'next-project' };
  // Queue a newer begin before an old publish. Older work cannot replace it.
  const pending = x.begin(later, allow), old = x.publish(publishable(), allow);
  await pending;
  await assert.rejects(old, { code: 'WORKSPACE_SNAPSHOT_STALE' });
  assert.equal(x.latest(), null);
  assert.throws(() => x.read(previous, overview));
  const reopened = f.newArchive();
  assert.equal(await reopened.load(), null);
  const malformed = publishable(later); delete malformed.panels['/api/channels'];
  await assert.rejects(reopened.publish(malformed, allow), { code: 'WORKSPACE_SNAPSHOT_INVALID' });
  const recovered = await reopened.publish(publishable(later), allow);
  assert.equal(recovered.projectId, later.projectId);
  const duplicate = publishable(later);
  duplicate.panels = Object.fromEntries(Object.entries(duplicate.panels).reverse());
  duplicate.panels['/api/factgraph'].nodes[0] = Object.fromEntries(Object.entries(duplicate.panels['/api/factgraph'].nodes[0]).reverse());
  assert.equal(await reopened.publish(duplicate, allow), recovered, 'same content checksum ignores insertion order');
  await assert.rejects(reopened.begin({ ...later, scopeSeal: 'f'.repeat(64) }, allow), { code: 'WORKSPACE_SNAPSHOT_CONFLICT' });
  assert.equal(reopened.latest(), null);
  const afterTie = f.newArchive(); assert.equal(await afterTie.load(), null);
  await assert.rejects(afterTie.publish(publishable(later), allow), { code: 'WORKSPACE_SNAPSHOT_CONFLICT' });
  const newest = { ...later, endedAt: later.endedAt + 1 };
  assert.equal((await afterTie.publish(publishable(newest), allow)).endedAt, newest.endedAt);
});

test('guard loss during staging cannot commit; denied and malformed identities cannot create high-water', async t => {
  const f = await fixture(t), x = f.archive;
  const previous = await x.publish(publishable(), allow), later = { ...identity, endedAt: endedAt + 100 };
  await assert.rejects(x.begin(later, () => false), { code: 'WORKSPACE_SNAPSHOT_GUARD' });
  await assert.rejects(x.begin({ ...later, endedAt: false }, allow), { code: 'WORKSPACE_SNAPSHOT_INVALID' });
  await assert.rejects(x.begin({ ...later, scopeSeal: 'non-seal' }, allow), { code: 'WORKSPACE_SNAPSHOT_INVALID' });
  assert.equal(x.latest(), previous);
  await x.begin(later, allow);
  let allowed = true, writes = 0;
  const reopening = f.newArchive({ ...f.audited, async write(...args) {
    await f.audited.write(...args);
    if (++writes === livePaths.length + 1) allowed = false;
  } });
  assert.equal(await reopening.load(), null);
  await assert.rejects(reopening.publish(publishable(later), () => allowed), { code: 'WORKSPACE_SNAPSHOT_GUARD' });
  assert.equal(writes, livePaths.length + 1, 'guard revokes while writing the staged commit manifest');
  const afterLoss = f.newArchive(); assert.equal(await afterLoss.load(), null);
  assert.equal((await afterLoss.publish(publishable(later), allow)).endedAt, later.endedAt);
});

test('a partial filesystem write or failed manifest stage stays pending and permits retry of the same identity', async t => {
  const f = await fixture(t), later = { ...identity, endedAt: endedAt + 100 };
  await f.archive.publish(publishable(), allow);
  await f.archive.begin(later, allow);
  let writes = 0, failAt = 5;
  const x = f.newArchive({ ...f.audited, async write(...args) {
    if (++writes === failAt) throw Object.assign(new Error('fixture I/O failure'), { code: 'EIO' });
    await f.audited.write(...args);
  } });
  await assert.rejects(x.publish(publishable(later), allow), { code: 'WORKSPACE_SNAPSHOT_STORAGE' });
  assert.equal(x.latest(), null);
  assert.equal(await f.newArchive().load(), null);
  failAt = writes + livePaths.length + 1;
  await assert.rejects(x.publish(publishable(later), allow), { code: 'WORKSPACE_SNAPSHOT_STORAGE' });
  assert.equal(await f.newArchive().load(), null);
  const { inventoryRevision: ignored, ...packet } = publishable(later);
  const ticket = await x.publish(packet, allow);
  assert.deepEqual(ticket, later);
  assert.deepEqual(await f.newArchive().load(), later);
});

test('rejects mixed-reader DTOs, fabricated time, incomplete IDs, edges and private extras', async t => {
  const f = await fixture(t), x = f.archive;
  const cases = [
    p => { p['/api/overview'].project = 'other'; },
    p => { p['/api/overview'].updated_at = 0; },
    p => { p['/api/overview'].endedAt = false; },
    p => { p['/api/overview'].channel_counts.verification = 0; },
    p => { p['/api/channels'].channels[8].count = 0; },
    p => { p['/api/channel/verification'].count = 0; },
    p => { p['/api/overview'].facts = 1; },
    p => { p['/api/overview'].verdicts = { correct: 1 }; },
    p => { p['/api/factgraph'].nodes[0].id = a.slice(0, 10); },
    p => { p['/api/factgraph'].nodes[1].predecessors = [a, a]; },
    p => { p['/api/factgraph'].edges[0].source = b; },
    p => { p['/api/factgraph'].max_depth = 7; },
    p => { p['/api/channel/verification'].entries[0].fact_id = a.slice(0, 10); },
    p => { p['/api/channel/verification'].entries[0].sessionPath = '/private/fixture'; },
    p => { p['/api/channel/verification'].entries[0].links.fact_ids = [false]; },
    p => { p['/api/channel/verification'].entries[0].verification_report.gaps[0].extra = true; },
  ];
  for (const change of cases) {
    const packet = publishable(); change(packet.panels);
    await assert.rejects(x.publish(packet, allow), { code: 'WORKSPACE_SNAPSHOT_INVALID' });
    assert.equal(x.latest(), null);
  }
  const clean = await x.publish(publishable(), allow);
  const mismatch = publishable(); mismatch.panels['/api/factgraph'].nodes[0].proof = 'different proof';
  await assert.rejects(x.publish(mismatch, allow), { code: 'WORKSPACE_SNAPSHOT_CONFLICT' });
  assert.equal(x.latest(), null);
  assert.throws(() => x.read(clean, graph));
  assert.equal(await f.newArchive().load(), null);
});

test('stores >2 MiB in bounded files, refuses oversized panels, and reads no project record or orphaned package', async t => {
  const f = await fixture(t), x = f.archive, packet = publishable();
  const huge = 'p'.repeat(800 * 1024);
  for (const kind of liveChannels.slice(0, 3)) {
    packet.panels[`/api/channel/${kind}`] = { kind, count: 1, entries: [{ kind, claim: huge }] };
    packet.panels['/api/channels'].channels.find(c => c.kind === kind).count = 1;
    packet.panels['/api/overview'].channel_counts[kind] = 1;
  }
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) > 2 * 1024 * 1024);
  let ticket = await x.publish(packet, allow);
  const restored = f.newArchive(); ticket = await restored.load();
  assert.equal(restored.read(ticket, { view: 'channel', kind: 'conclusion' }).entries[0].claim.length, huge.length);
  const later = { ...identity, endedAt: endedAt + 1 }, tooLarge = publishable(later);
  tooLarge.panels['/api/factgraph'].nodes[0].proof = 'p'.repeat(1024 * 1024 + 1);
  await assert.rejects(restored.publish(tooLarge, allow), { code: 'WORKSPACE_SNAPSHOT_LIMIT' });
  assert.equal(restored.latest(), null);
  assert.equal(await f.newArchive().load(), null);
  // Neither leftover panel chunks nor a plausible project JSON can generate an archive.
  const manifest = [...f.paths.reads][0];
  await f.store.remove(manifest);
  await f.store.write(`context/projects/${projectId}/project.json`, JSON.stringify(packet.panels['/api/overview']));
  f.paths.reads.clear();
  assert.equal(await f.newArchive().load(), null);
  assert.deepEqual([...f.paths.reads], [manifest]);
});

test('barrier exposes only the watermark and state, including restart with known or unknown damage', async t => {
  const f = await fixture(t), x = f.archive;
  await x.load(); assert.equal(x.barrier(), null);
  await x.begin(identity, allow);
  const pending = f.newArchive(); await pending.load();
  assert.deepEqual(pending.barrier(), { endedAt, state: 'pending' });
  assert.ok(Object.isFrozen(pending.barrier()));
  await x.publish(publishable(), allow);
  assert.deepEqual(x.barrier(), { endedAt, state: 'published' });
  const [manifest] = f.paths.reads;
  f.paths.reads.clear();
  assert.ok(await f.newArchive().load());
  const [, overviewFile] = f.paths.reads, original = await f.store.read(overviewFile);
  await f.store.write(overviewFile, 'invalid payload', true);
  const damaged = f.newArchive(); await damaged.load();
  assert.equal(damaged.latest(), null);
  assert.deepEqual(damaged.barrier(), { endedAt, state: 'corrupt' });
  await f.store.write(overviewFile, original, true);
  await assert.rejects(x.begin({ ...identity, projectId: 'another-project' }, allow), { code: 'WORKSPACE_SNAPSHOT_CONFLICT' });
  const tied = f.newArchive(); await tied.load();
  assert.deepEqual(tied.barrier(), { endedAt, state: 'conflict' });
  await f.store.write(manifest, 'invalid manifest', true);
  const unknown = f.newArchive(); await unknown.load();
  assert.deepEqual(unknown.barrier(), { endedAt: null, state: 'corrupt' });
});

test('bad checksums and symlinks fail closed, never inspect a symlink target or use an earlier package', async t => {
  const f = await fixture(t);
  await f.archive.publish(publishable(), allow);
  f.paths.reads.clear();
  assert.ok(await f.newArchive().load());
  const [manifest, panel] = f.paths.reads;
  const bytes = await f.store.read(panel);
  await f.store.write(panel, bytes.toString().replace(projectId, 'bogus-project'), true);
  const broken = f.newArchive(); assert.equal(await broken.load(), null);
  await assert.rejects(broken.publish(publishable(), allow), { code: 'WORKSPACE_SNAPSHOT_STORAGE' });
  await f.store.write(panel, bytes, true);
  assert.ok(await f.newArchive().load());
  const external = f.store.absolute('decoy.json');
  await fs.copyFile(f.store.absolute(manifest), external);
  await f.store.remove(manifest);
  await fs.symlink(external, f.store.absolute(manifest));
  f.paths.reads.clear();
  const refused = f.newArchive(); assert.equal(await refused.load(), null);
  assert.deepEqual([...f.paths.reads], [manifest]);
  await assert.rejects(refused.begin({ ...identity, endedAt: endedAt + 1 }, allow), { code: 'WORKSPACE_SNAPSHOT_STORAGE' });
  assert.equal((await fs.lstat(f.store.absolute(manifest))).isSymbolicLink(), true);
});
