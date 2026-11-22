import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkerModels, workerModelPage } from '../packages/hana-math/worker-model-options.mjs';

const model = { provider: 'fixture-provider', id: 'fixture-model' };
const saved = { role: 'worker', source: 'saved-role', agentId: 'saved-worker', model };
const capability = 'app/session.thinking-level';
const granted = { capabilities: [{ capability, status: 'always', enforcement: 'hard' }] };

test('worker model discovery projects only scheduling fields without reading provider configuration', () => {
  const forbidden = () => assert.fail('private configuration accessed');
  const row = { ...model, thinkingLevels: ['low', 'high'], customThinkingLevels: ['xhigh', 'auto'] };
  for (const key of ['apiKey', 'headers', 'endpoint', 'config', 'defaultThinkingLevel', 'toJSON']) {
    Object.defineProperty(row, key, { enumerable: true, get: forbidden });
  }
  const result = projectWorkerModels({ models: [row] }, saved, granted);
  assert.deepEqual(result, { defaultModel: model,
    models: [{ ...model, supportedThinkingLevels: ['high', 'low', 'xhigh'] }],
    thinkingControl: { capability, status: 'always', enforcement: 'hard', available: true } });
  result.defaultModel.id = 'changed'; assert.equal(saved.model.id, model.id);
  assert.doesNotMatch(JSON.stringify(result), /apiKey|headers|endpoint|config|defaultThinkingLevel|agentId/);
});

test('worker model discovery never elevates session grants or uncertain capability rows', () => {
  const catalog = { models: [{ ...model, thinkingLevels: ['high'] }] };
  const session = projectWorkerModels(catalog, saved, { capabilities: [{ capability, status: 'session', enforcement: 'hard' }] });
  assert.equal(session.thinkingControl.status, 'session'); assert.equal(session.thinkingControl.available, false);
  const duplicate = projectWorkerModels(catalog, saved, { capabilities: [...granted.capabilities, ...granted.capabilities] });
  assert.equal(duplicate.thinkingControl.status, 'unknown'); assert.equal(duplicate.thinkingControl.available, false);
  const unavailable = projectWorkerModels(catalog, saved, null);
  assert.equal(unavailable.thinkingControl.available, false); assert.equal(unavailable.models.length, 1);
});

test('worker model pagination defaults, bounds and byte budget preserve resumable offsets', () => {
  const options = projectWorkerModels({ models: Array.from({ length: 80 }, (_, i) => ({ provider: 'p', id: String(i).padStart(3, '0') })) }, saved, granted);
  const first = workerModelPage(options); assert.equal(first.models.length, 32); assert.equal(first.nextOffset, 32); assert.equal(first.total, 80);
  const last = workerModelPage(options, 64, 64); assert.equal(last.models.length, 16); assert.equal(last.nextOffset, null);
  assert.deepEqual(workerModelPage(options, 99).models, []);
  for (const [offset, limit] of [[-1, 32], [1.5, 32], [0, 0], [0, 65], [null, 32]]) assert.throws(() => workerModelPage(options, offset, limit), { code: 'PROJECT_INVALID_INPUT' });
  const large = { ...options, models: Array.from({ length: 64 }, (_, i) => ({ id: String(i), supportedThinkingLevels: Array.from({ length: 128 }, () => 'x'.repeat(128)) })) };
  const page = workerModelPage(large, 0, 64);
  assert.ok(page.models.length > 0 && page.models.length < 64); assert.equal(page.nextOffset, page.models.length);
  assert.ok(page.models.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)), 0) <= 256 * 1024);
});

test('worker model discovery preserves unknown thinking support and rejects untrusted model identity', () => {
  const result = projectWorkerModels({ models: [{ ...model, thinkingLevels: null, defaultThinkingLevel: 'high' }] }, saved, granted);
  assert.equal(result.models[0].supportedThinkingLevels, null);
  assert.equal(projectWorkerModels({ models: [model] }, saved, granted).models[0].supportedThinkingLevels, null);
  assert.deepEqual(projectWorkerModels({ models: [{ ...model, thinkingLevels: [] }] }, saved, granted).models[0].supportedThinkingLevels, []);
  const row = { id: model.id };
  Object.defineProperty(row, 'provider', { enumerable: true, get() { assert.fail('model identity getter accessed'); } });
  assert.throws(() => projectWorkerModels({ models: [row] }, saved, granted), { code: 'INVALID_MODEL' });
  assert.throws(() => projectWorkerModels({ models: [model, model] }, saved, granted), { code: 'MODEL_CATALOG_INVALID' });
});
