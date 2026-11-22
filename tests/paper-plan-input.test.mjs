// M05 own-data boundary only; no App, research, writer or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPlanData, snapshotPaperPlanRequest, snapshotPaperPlanStart } from '../packages/hana-math/paper-plan-input.mjs';
const id = n => n.toString(16).padStart(16, '0');
const projectId = 'fixture-project', reportId = 'report-00000000-0000-0000-0000-000000000001';
const request = patch => ({ projectId, brief: 'Opaque planning brief.', ...patch });
const bad = (run, code = 'PROJECT_INVALID_INPUT') => assert.throws(run, { code });

test('M05 input: own JSON data is detached, including null-prototype objects and __proto__ data', () => {
  const raw = JSON.parse('{"__proto__":{"safe":true},"items":[null,true,0,-1,"text",{"x":1}]}');
  const cloned = snapshotPlanData(raw);
  assert.deepEqual(cloned, raw); assert.notEqual(cloned.items, raw.items); assert.equal(Object.getPrototypeOf(cloned), Object.prototype);
  assert.ok(Object.hasOwn(cloned, '__proto__')); assert.equal(Object.prototype.safe, undefined);
  const nullPrototype = Object.assign(Object.create(null), { projectId, brief: 'Opaque' });
  assert.deepEqual(snapshotPaperPlanRequest(nullPrototype), { projectId, brief: 'Opaque' });
  raw.items[5].x = 9; assert.equal(cloned.items[5].x, 1);
  cloned.items.push('changed'); assert.equal(raw.items.length, 6);
});

test('M05 input: accessors at root, nested object and array index are rejected without invoking them', () => {
  let reads = 0;
  const root = request(); Object.defineProperty(root, 'brief', { enumerable: true, get() { reads++; return 'Opaque'; } });
  const nested = { material: {} }; Object.defineProperty(nested.material, 'sha256', { enumerable: true, get() { reads++; return 'x'; } });
  const array = [id(1)]; Object.defineProperty(array, '0', { enumerable: true, get() { reads++; return id(1); } });
  for (const run of [() => snapshotPaperPlanRequest(root), () => snapshotPlanData(nested), () => snapshotPaperPlanRequest(request({ factIds: array }))]) bad(run);
  assert.equal(reads, 0);
});

test('M05 input: proxies and revoked proxies fail before any trap can run', () => {
  let traps = 0;
  const handler = Object.fromEntries(['get', 'ownKeys', 'getPrototypeOf', 'getOwnPropertyDescriptor'].map(key => [key, () => { traps++; throw new Error('must not execute trap'); }]));
  for (const target of [request(), [id(1)]]) {
    const proxy = new Proxy(target, handler);
    bad(() => snapshotPlanData(proxy));
    bad(() => snapshotPaperPlanRequest(request({ factIds: proxy })));
  }
  const revoked = Proxy.revocable(request(), handler); revoked.revoke(); bad(() => snapshotPlanData(revoked.proxy));
  assert.equal(traps, 0);
});

test('M05 input: inherited data, symbols and nonenumerable properties are not silently accepted', () => {
  let reads = 0;
  const inherited = Object.create({ get projectId() { reads++; return projectId; }, brief: 'Inherited' });
  bad(() => snapshotPaperPlanRequest(inherited)); assert.equal(reads, 0);
  for (const key of ['hidden', Symbol('hidden')]) {
    const raw = request(); Object.defineProperty(raw, key, { value: 'not a public field', enumerable: typeof key === 'symbol' });
    bad(() => snapshotPaperPlanRequest(raw));
  }
  for (const value of [new Date(), new Map(), new Set(), () => {}, undefined, 1.5, NaN, Infinity, 1n]) bad(() => snapshotPlanData(value));
});

test('M05 input: sparse, inherited-index and extra-property arrays are rejected', () => {
  const inherited = new Array(1); Object.setPrototypeOf(inherited, Object.create(Array.prototype, { 0: { value: id(1), enumerable: true } }));
  const extra = [id(1)]; extra.note = 'extra';
  const hidden = [id(1)]; Object.defineProperty(hidden, 'hidden', { value: true });
  const symbolic = [id(1)]; symbolic[Symbol('extra')] = true;
  for (const factIds of [new Array(1), [id(1), , id(2)], inherited, extra, hidden, symbolic]) bad(() => snapshotPaperPlanRequest(request({ factIds })));
});

test('M05 input: request rejects empty/root/extra fields and preserves custom error code', () => {
  for (const value of [undefined, null, {}, [], '', 0, true, { projectId }, { brief: 'Opaque' }, request({ brief: '' }), request({ brief: ' \t\r\n' }), request({ extra: true })])
    bad(() => snapshotPaperPlanRequest(value));
  bad(() => snapshotPaperPlanRequest(request({ extra: true }), { code: 'RESEARCH_TOOL_INVALID_INPUT' }), 'RESEARCH_TOOL_INVALID_INPUT');
  assert.deepEqual(snapshotPaperPlanRequest(request({ instructions: '' })), request({ instructions: '' }));
});

test('M05 input: brief and instructions use exact 32768 UTF-8-byte gates, not character counts', () => {
  for (const field of ['brief', 'instructions']) {
    for (const text of ['x'.repeat(32768), '😀'.repeat(8192), '汉'.repeat(10922) + 'ab']) {
      assert.equal(Buffer.byteLength(text), 32768); assert.equal(snapshotPaperPlanRequest(request({ [field]: text }))[field], text);
      bad(() => snapshotPaperPlanRequest(request({ [field]: text + 'x' })));
    }
    for (const text of ['NUL\0tail', '\ud800', '\udfff', 7, null]) bad(() => snapshotPaperPlanRequest(request({ [field]: text })));
  }
});

test('M05 input: IDs, 64 selections and omitted/empty selections retain their intended shapes', () => {
  const all = Array.from({ length: 64 }, (_, i) => id(i + 1));
  assert.deepEqual(snapshotPaperPlanRequest(request({ factIds: all })).factIds, all);
  assert.deepEqual(snapshotPaperPlanRequest(request({ factIds: [] })).factIds, []);
  assert.equal(Object.hasOwn(snapshotPaperPlanRequest(request()), 'factIds'), false);
  for (const factIds of [null, {}, '', [id(1), id(1)], ['F'.repeat(16)], ['short'], [1], [...all, id(65)]]) bad(() => snapshotPaperPlanRequest(request({ factIds })));
  for (const field of ['projectId', 'paperId']) {
    assert.equal(snapshotPaperPlanRequest(request({ [field]: 'a'.repeat(64) }))[field], 'a'.repeat(64));
    for (const value of ['', '-leading', 'Upper', 'with space', 'a'.repeat(65), null]) bad(() => snapshotPaperPlanRequest(request({ [field]: value })));
  }
});

test('M05 input: tool/read envelopes admit only their own fields and report identity shape', () => {
  assert.equal(snapshotPaperPlanRequest({ action: 'paper_plan', ...request() }, { tool: true }).action, 'paper_plan');
  bad(() => snapshotPaperPlanRequest({ action: 'paper_plan', ...request() }));
  bad(() => snapshotPaperPlanRequest(request(), { tool: true }));
  for (const action of ['paper_plan_status', 'paper_plan_result', 'paper_plan_stop']) {
    const input = { action, projectId, reportId };
    assert.deepEqual(snapshotPaperPlanRequest(input, { tool: true, read: true }), input);
    bad(() => snapshotPaperPlanRequest({ ...input, brief: 'not a read field' }, { tool: true, read: true }));
  }
  for (const value of [undefined, '', 'report-short', reportId.toUpperCase(), null]) bad(() => snapshotPaperPlanRequest({ projectId, reportId: value }, { read: true }));
  bad(() => snapshotPaperPlanRequest({ projectId, reportId, factIds: [] }, { read: true }));
});

test('M05 input: request and start snapshots resist later caller and receiver mutations', () => {
  const raw = request({ factIds: [id(1)], instructions: 'Original direction' }), saved = snapshotPaperPlanRequest(raw);
  raw.factIds[0] = id(2); raw.brief = 'Changed'; assert.deepEqual(saved.factIds, [id(1)]); assert.equal(saved.brief, 'Opaque planning brief.');
  saved.factIds.push(id(3)); assert.deepEqual(raw.factIds, [id(2)]);
  const start = { projectId, kind: 'paper-plan', language: 'English', plan: { target: { factIds: [id(1)] }, material: { warnings: [] } } };
  const copy = snapshotPaperPlanStart(start); start.plan.target.factIds.push(id(2)); start.plan.material.warnings.push('changed');
  assert.deepEqual(copy.plan.target.factIds, [id(1)]); assert.deepEqual(copy.plan.material.warnings, []);
  copy.plan.target.factIds.push(id(3)); assert.deepEqual(start.plan.target.factIds, [id(1), id(2)]);
});

test('M05 input: start envelope rejects accessors, unknown fields, wrong kind/language and cyclic data', () => {
  const valid = { projectId, kind: 'paper-plan', language: 'English', plan: {} };
  for (const patch of [{ kind: 'paper-source' }, { language: 'French' }, { extra: true }]) bad(() => snapshotPaperPlanStart({ ...valid, ...patch }));
  for (const value of [null, {}, [], { projectId, kind: 'paper-plan', language: 'English' }]) bad(() => snapshotPaperPlanStart(value));
  let reads = 0; const raw = { ...valid }; Object.defineProperty(raw, 'plan', { enumerable: true, get() { reads++; return {}; } });
  bad(() => snapshotPaperPlanStart(raw)); assert.equal(reads, 0);
  const cycle = {}; cycle.self = cycle; bad(() => snapshotPlanData(cycle));
});
