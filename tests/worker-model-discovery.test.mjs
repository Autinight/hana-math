// Main-only current directory reads; all Host interfaces are software fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, origin } from './helpers/project-service-fixture.mjs';
const model = { provider: 'p', id: 'a' };
const grant = { capabilities: [{ capability: 'app/session.thinking-level', status: 'always', enforcement: 'hard' }] };
function directory(f) {
  const reads = { models: 0, profiles: 0, capabilities: 0 };
  f.sdk.models.listAvailable = async () => { reads.models++; return { models: Array.from({ length: 70 }, (_, i) => ({ provider: 'p', id: String(i).padStart(3, '0'), thinkingLevels: ['high', 'low'], apiKey: 'PRIVATE', endpoint: 'PRIVATE', defaultThinkingLevel: 'PRIVATE' })) }; };
  f.profiles.getRoleModel = async role => { assert.equal(role, 'worker'); reads.profiles++; return { role, source: 'saved-role', agentId: 'saved-worker', model }; };
  f.sdk.capabilities = { get: async input => { assert.deepEqual(input, {}); reads.capabilities++; return grant; } };
  return reads;
}
async function files(root) {
  const result = {};
  for (const name of (await fs.readdir(root, { recursive: true })).sort()) {
    const file = path.join(root, name), stat = await fs.stat(file);
    if (stat.isFile()) result[name] = { mtime: stat.mtimeMs, bytes: (await fs.readFile(file)).toString('base64') };
  }
  return result;
}
test('worker_models rejects creator and worker before querying model/profile/capability directories', async t => {
  const f = await fixture(t), p = await f.create(), reads = directory(f);
  f.host.set('/fixture/worker.jsonl', { sessionId: 'worker-session', path: '/fixture/worker.jsonl', agentId: 'saved-worker', namespace: 'app', visibility: 'plugin_private', ownerPluginId: 'hana-math', lifecycle: 'active' });
  for (const ctx of [origin, { callToken: 'worker-token', sessionPath: '/fixture/worker.jsonl' }]) {
    await assert.rejects(f.service.workerModels({ projectId: p.projectId }, ctx), { code: 'PROJECT_OWNER_DENIED' });
  }
  assert.deepEqual(reads, { models: 0, profiles: 0, capabilities: 0 });
});
test('worker_models main reads paginated whitelisted metadata without tasks, persistent writes or locator migration', async t => {
  const f = await fixture(t), p = await f.create(), reads = directory(f);
  const row = f.host.get(p.context.sessionPath); f.host.delete(p.context.sessionPath);
  row.path = '/fixture/relocated-main.jsonl'; f.host.set(row.path, row);
  const ctx = { ...p.context, sessionPath: row.path };
  const before = await files(f.dataDir), counts = [f.calls.tasks.length, f.calls.schedules.length, f.calls.starts.length, f.calls.core.length];
  const first = await f.service.workerModels({ projectId: p.projectId }, ctx);
  assert.deepEqual(first.defaultModel, model); assert.equal(first.thinkingControl.available, true); assert.equal(first.thinkingControl.status, 'always');
  assert.equal(first.models.length, 32); assert.equal(first.offset, 0); assert.equal(first.nextOffset, 32); assert.equal(first.total, 70); assert.equal(first.catalogTiming, 'current-read');
  assert.deepEqual(first.models[0].supportedThinkingLevels, ['high', 'low']);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|apiKey|endpoint|defaultThinkingLevel|agentId/);
  const last = await f.service.workerModels({ projectId: p.projectId, offset: 64, limit: 64 }, ctx);
  assert.equal(last.models.length, 6); assert.equal(last.nextOffset, null);
  const past = await f.service.workerModels({ projectId: p.projectId, offset: 100, limit: 1 }, ctx);
  assert.deepEqual(past.models, []); assert.equal(past.nextOffset, null);
  assert.deepEqual(await files(f.dataDir), before);
  assert.deepEqual([f.calls.tasks.length, f.calls.schedules.length, f.calls.starts.length, f.calls.core.length], counts);
  assert.deepEqual(reads, { models: 3, profiles: 3, capabilities: 3 });
  assert.match(f.calls.sends[0].text, /worker_models/);
});
test('worker_models validates pagination before reads and reports unavailable permissions as unknown', async t => {
  const f = await fixture(t), p = await f.create(), reads = directory(f);
  for (const extra of [{ offset: -1 }, { offset: 0.5 }, { offset: null }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 65 }, { limit: null }, { cursor: 'spoof' }]) {
    await assert.rejects(f.service.workerModels({ projectId: p.projectId, ...extra }, p.context), { code: 'PROJECT_INVALID_INPUT' });
  }
  assert.equal(reads.models, 0);
  for (const capabilities of [undefined, { get: async () => { throw new Error('PRIVATE failed lookup'); } }]) {
    f.sdk.capabilities = capabilities;
    const result = await f.service.workerModels({ projectId: p.projectId, limit: 1 }, p.context);
    assert.equal(result.models.length, 1); assert.equal(result.thinkingControl.available, false); assert.equal(result.thinkingControl.status, 'unknown');
  }
  f.sdk.models.listAvailable = async () => ({ models: null });
  await assert.rejects(f.service.workerModels({ projectId: p.projectId }, p.context), { code: 'MODEL_CATALOG_INVALID' });
  f.sdk.models.listAvailable = async () => ({ models: [model] });
  f.profiles.getRoleModel = async () => ({ role: 'verifier', source: 'saved-role', model });
  await assert.rejects(f.service.workerModels({ projectId: p.projectId }, p.context), { code: 'SAVED_ROLE_INVALID' });
});
test('worker_models rechecks main identity after directory reads', async t => {
  const f = await fixture(t), p = await f.create(); directory(f);
  const row = f.host.get(p.context.sessionPath);
  f.sdk.capabilities.get = async () => { row.agentId = 'foreign-agent'; return grant; };
  await assert.rejects(f.service.workerModels({ projectId: p.projectId }, p.context), { code: 'PROJECT_MAIN_DENIED' });
});
