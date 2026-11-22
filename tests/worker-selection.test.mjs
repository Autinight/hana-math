import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkerDispatch, validateWorkerModel, validateWorkerSelection, workerDisplayTitle } from '../packages/hana-math/worker-selection.mjs';

test('public worker titles are short single-line labels; unsafe input is discarded rather than truncated', () => {
  assert.equal(workerDisplayTitle('  悬链面   曲率 '), '悬链面 曲率');
  assert.equal(workerDisplayTitle('𝑋'.repeat(24)), '𝑋'.repeat(24));
  for (const input of ['𝑋'.repeat(25), '换行\n内容', '私有/路径', 'https://example.org', 'worker\u202e1', 'x\u200dy']) {
    assert.equal(workerDisplayTitle(input), undefined);
  }
});
const model = { provider: 'p', id: 'm' };
const catalog = [{ ...model, thinkingLevels: ['low', 'high'], customThinkingLevels: ['xhigh'], defaultThinkingLevel: 'medium' }];
test('per-run selection validates exact model/support and preserves omission without reading default', () => {
  assert.deepEqual(validateWorkerSelection({ model }, catalog), { model });
  assert.deepEqual(normalizeWorkerDispatch({}), {});
  assert.deepEqual(validateWorkerSelection({ model, thinkingLevel: 'xhigh' }, catalog), { model, thinkingLevel: 'xhigh' });
  for (const thinkingLevel of [null, undefined, '', ' ', 'auto', 'medium', 'High', ' high ', 'x'.repeat(129), 'high\n']) {
    assert.throws(() => validateWorkerSelection({ model, thinkingLevel }, catalog), { code: 'INVALID_THINKING_LEVEL' });
  }
  assert.throws(() => validateWorkerSelection({ model: { provider: 'p', id: 'absent' } }, catalog), { code: 'MODEL_NOT_AVAILABLE' });
  assert.throws(() => validateWorkerSelection({ model }, [...catalog, ...catalog]), { code: 'INVALID_MODEL_CATALOG' });
  assert.throws(() => validateWorkerModel({ provider: ' ', id: 'm' }), { code: 'INVALID_MODEL' });
  const other = { provider: 'q', id: 'other', thinkingLevels: 12 };
  assert.deepEqual(validateWorkerSelection({ model }, [...catalog, other]), { model });
});
test('selection rejects non-JSON input without executing getters, proxies or toJSON', () => {
  const forbidden = () => assert.fail('must not execute untrusted accessor');
  for (const input of [Object.defineProperty({}, 'model', { enumerable: true, get: forbidden }),
    { model, toJSON: forbidden }, { model, [Symbol('hidden')]: true }, new Proxy({}, { ownKeys: forbidden })]) {
    assert.throws(() => normalizeWorkerDispatch(input), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => validateWorkerModel(Object.defineProperty({ provider: 'p' }, 'id', { enumerable: true, get: forbidden })), { code: 'INVALID_MODEL' });
  const bad = Object.defineProperty({ ...model }, 'thinkingLevels', { enumerable: true, get: forbidden });
  assert.deepEqual(validateWorkerSelection({ model }, [bad]), { model });
  assert.throws(() => validateWorkerSelection({ model, thinkingLevel: 'high' }, [bad]), { code: 'INVALID_MODEL_CATALOG' });
});
