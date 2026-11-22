// Opaque configuration fixtures only: no model, SDK, storage or mathematics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TIMER_SECONDS, RESEARCH_WORKER_POLICY_DEFAULTS, LEGACY_WORKER_POLICY_DEFAULTS,
  normalizeResearchWorkerPolicy, createLegacyWorkerPolicy, isLegacyWorkerPolicy, readResearchExecutionPolicy,
} from '../packages/hana-math/worker-policy.mjs';

const defaults = { maxRounds: 0, roundTimeoutSeconds: 14400, roundDelaySeconds: 5, maxConsecutiveFailures: 5 };
const invalidNumbers = [true, false, '5', null, undefined, NaN, Infinity, -Infinity, [], {}, new Number(5)];

test('only an explicit research object gets Danus defaults; no implicit upgrade', () => {
  assert.deepEqual(normalizeResearchWorkerPolicy({}), defaults);
  assert.throws(() => normalizeResearchWorkerPolicy(), { code: 'WORKER_POLICY_INVALID_INPUT' });
  assert.throws(() => normalizeResearchWorkerPolicy(createLegacyWorkerPolicy()), { code: 'WORKER_POLICY_INVALID_INPUT' });
  assert.equal(isLegacyWorkerPolicy(normalizeResearchWorkerPolicy({})), false);
});

test('missing fields default independently, while explicit zero retains its meaning', () => {
  for (const [key, value] of Object.entries({ maxRounds: 7, roundTimeoutSeconds: 1, roundDelaySeconds: 0.25, maxConsecutiveFailures: 0 })) {
    assert.deepEqual(normalizeResearchWorkerPolicy({ [key]: value }), { ...defaults, [key]: value });
  }
  assert.deepEqual(normalizeResearchWorkerPolicy({ maxRounds: 0, roundDelaySeconds: 0, maxConsecutiveFailures: 0 }),
    { ...defaults, roundDelaySeconds: 0, maxConsecutiveFailures: 0 });
  assert.deepEqual(normalizeResearchWorkerPolicy({ maxRounds: -0, roundDelaySeconds: -0, maxConsecutiveFailures: -0 }),
    { ...defaults, roundDelaySeconds: 0, maxConsecutiveFailures: 0 });
});

test('defaults and results are independent readonly numeric snapshots', () => {
  const input = { roundDelaySeconds: 0.5 }, a = normalizeResearchWorkerPolicy(input), b = normalizeResearchWorkerPolicy(input);
  assert.notEqual(a, input); assert.notEqual(a, b); assert.notEqual(a, RESEARCH_WORKER_POLICY_DEFAULTS);
  input.roundDelaySeconds = 999;
  assert.equal(a.roundDelaySeconds, 0.5); assert.equal(b.roundDelaySeconds, 0.5);
  for (const snapshot of [a, b, RESEARCH_WORKER_POLICY_DEFAULTS, LEGACY_WORKER_POLICY_DEFAULTS, createLegacyWorkerPolicy()]) {
    assert.equal(Object.isFrozen(snapshot), true);
    assert.throws(() => { snapshot.maxRounds = 123; }, TypeError);
    assert.throws(() => { snapshot.extra = true; }, TypeError);
  }
  assert.deepEqual(RESEARCH_WORKER_POLICY_DEFAULTS, defaults);
  assert.deepEqual(normalizeResearchWorkerPolicy({}), defaults);
  assert.deepEqual(createLegacyWorkerPolicy(), LEGACY_WORKER_POLICY_DEFAULTS);
});

test('reject non-record inputs, unknown fields including hidden/symbol fields, and accessors', () => {
  for (const input of [undefined, null, true, false, 'policy', 5, NaN, Infinity, [], new Date(0), new Map(), () => {}, new (class Policy {})()]) {
    assert.throws(() => normalizeResearchWorkerPolicy(input), { code: 'WORKER_POLICY_INVALID_INPUT' });
  }
  for (const key of ['maxRound', 'timeoutSeconds', 'totalTimeoutSeconds', 'mode', '__proto__', Symbol('extra')]) {
    const input = Object.defineProperty({}, key, { value: 5 });
    assert.throws(() => normalizeResearchWorkerPolicy(input), { code: 'WORKER_POLICY_INVALID_INPUT' });
  }
  let reads = 0;
  const accessor = { get maxRounds() { reads++; return 3; } };
  assert.throws(() => normalizeResearchWorkerPolicy(accessor), { code: 'WORKER_POLICY_INVALID_INPUT' });
  assert.equal(reads, 0);
  assert.throws(() => normalizeResearchWorkerPolicy(Object.create({ maxRounds: 3 })), { code: 'WORKER_POLICY_INVALID_INPUT' });
  assert.deepEqual(normalizeResearchWorkerPolicy(Object.assign(Object.create(null), { maxRounds: 3 })), { ...defaults, maxRounds: 3 });
  assert.deepEqual(normalizeResearchWorkerPolicy(Object.freeze({})), defaults);
});

for (const key of Object.keys(defaults)) test(`${key} rejects non-numbers and explicit undefined rather than defaulting`, () => {
  for (const value of invalidNumbers) {
    assert.throws(() => normalizeResearchWorkerPolicy({ [key]: value }), { code: 'WORKER_POLICY_INVALID_FIELD' });
  }
});

for (const key of ['maxRounds', 'maxConsecutiveFailures']) test(`${key} accepts all nonnegative safe integers, not timer bounds`, () => {
  for (const value of [0, 1, 3, MAX_TIMER_SECONDS + 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(normalizeResearchWorkerPolicy({ [key]: value })[key], value);
  }
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE]) {
    assert.throws(() => normalizeResearchWorkerPolicy({ [key]: value }), { code: 'WORKER_POLICY_INVALID_FIELD' });
  }
});

test('per-round timeout is a positive integer, independently of the legacy whole-run cap', () => {
  for (const value of [1, 60, 900, 901, 14400, MAX_TIMER_SECONDS]) {
    assert.equal(normalizeResearchWorkerPolicy({ roundTimeoutSeconds: value }).roundTimeoutSeconds, value);
  }
  for (const value of [0, -0, -1, 1.5]) {
    assert.throws(() => normalizeResearchWorkerPolicy({ roundTimeoutSeconds: value }), { code: 'WORKER_POLICY_INVALID_FIELD' });
  }
  assert.equal(Object.hasOwn(normalizeResearchWorkerPolicy({}), 'totalTimeoutSeconds'), false);
});

test('beat allows finite nonnegative fractions, including zero and sub-millisecond values', () => {
  for (const value of [0, Number.MIN_VALUE, 0.0005, 0.25, 5.5, MAX_TIMER_SECONDS - 0.25, MAX_TIMER_SECONDS]) {
    assert.equal(normalizeResearchWorkerPolicy({ roundDelaySeconds: value }).roundDelaySeconds, value);
  }
  for (const value of [-1, -0.25]) {
    assert.throws(() => normalizeResearchWorkerPolicy({ roundDelaySeconds: value }), { code: 'WORKER_POLICY_INVALID_FIELD' });
  }
});

test('seconds ceiling is the explicit Node single-timer technical limit for both durations', () => {
  assert.equal(MAX_TIMER_SECONDS, 2147483);
  assert.ok(MAX_TIMER_SECONDS * 1000 <= 2147483647);
  assert.ok((MAX_TIMER_SECONDS + 1) * 1000 > 2147483647);
  for (const key of ['roundTimeoutSeconds', 'roundDelaySeconds']) {
    for (const value of [MAX_TIMER_SECONDS + 1, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
      assert.throws(() => normalizeResearchWorkerPolicy({ [key]: value }), { code: 'WORKER_POLICY_TIMER_LIMIT' });
    }
  }
  assert.throws(() => normalizeResearchWorkerPolicy({ roundDelaySeconds: MAX_TIMER_SECONDS + 0.1 }), { code: 'WORKER_POLICY_TIMER_LIMIT' });
});

test('legacy construction keeps three rounds and a 60..900 second whole-run budget', () => {
  assert.deepEqual(createLegacyWorkerPolicy(), { mode: 'legacy-bounded', maxRounds: 3, totalTimeoutSeconds: 900 });
  for (const value of [60, 61, 899, 900]) {
    const snapshot = createLegacyWorkerPolicy(value);
    assert.deepEqual(snapshot, { mode: 'legacy-bounded', maxRounds: 3, totalTimeoutSeconds: value });
    assert.equal(Object.isFrozen(snapshot), true); assert.equal(isLegacyWorkerPolicy(snapshot), true);
    assert.equal(Object.hasOwn(snapshot, 'roundTimeoutSeconds'), false);
    assert.equal(isLegacyWorkerPolicy(JSON.parse(JSON.stringify(snapshot))), true);
  }
  assert.notEqual(createLegacyWorkerPolicy(), createLegacyWorkerPolicy());
  for (const value of [...invalidNumbers.filter(value => value !== undefined), 0, 59, 60.5, 901, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createLegacyWorkerPolicy(value), { code: 'LEGACY_WORKER_POLICY_INVALID_TIMEOUT' });
  }
});

test('persisted research execution policy is complete, independent and never defaults damaged history', () => {
  const input = { mode: 'research-rounds', workerPolicy: { ...defaults }, totalTimeoutSeconds: null };
  const output = readResearchExecutionPolicy(input);
  assert.deepEqual(output, input); assert.notEqual(output, input); assert.notEqual(output.workerPolicy, input.workerPolicy);
  assert.equal(Object.isFrozen(output), true); assert.equal(Object.isFrozen(output.workerPolicy), true);
  for (const totalTimeoutSeconds of [null, 60, 900]) assert.equal(readResearchExecutionPolicy({ ...input, totalTimeoutSeconds }).totalTimeoutSeconds, totalTimeoutSeconds);
  for (const key of Object.keys(input)) { const bad = { ...input }; delete bad[key]; assert.throws(() => readResearchExecutionPolicy(bad)); }
  for (const key of Object.keys(defaults)) { const workerPolicy = { ...defaults }; delete workerPolicy[key]; assert.throws(() => readResearchExecutionPolicy({ ...input, workerPolicy })); }
  for (const workerPolicy of [null, [], {}, { ...defaults, maxRounds: -1 }, { ...defaults, roundTimeoutSeconds: 0 }, { ...defaults, unknown: 1 }]) {
    assert.throws(() => readResearchExecutionPolicy({ ...input, workerPolicy }));
  }
  for (const totalTimeoutSeconds of [undefined, false, '900', 0, 59, 901, 60.5, Infinity]) assert.throws(() => readResearchExecutionPolicy({ ...input, totalTimeoutSeconds }));
  for (const bad of [undefined, null, [], createLegacyWorkerPolicy(), { ...input, mode: 'unknown' }, { ...input, extra: true }]) assert.throws(() => readResearchExecutionPolicy(bad));
  input.workerPolicy.maxRounds = 4; assert.equal(output.workerPolicy.maxRounds, 0);
});

test('legacy recognition requires the exact tagged shape and never fills in missing history', () => {
  const legacy = createLegacyWorkerPolicy();
  for (const value of [undefined, null, [], true, 'legacy-bounded', {}, defaults,
    { maxRounds: 3, timeoutSeconds: 900 }, { ...legacy, maxRounds: 0 }, { ...legacy, maxRounds: '3' },
    { ...legacy, mode: 'research' }, { ...legacy, totalTimeoutSeconds: null }, { ...legacy, totalTimeoutSeconds: 901 },
    { ...legacy, totalTimeoutSeconds: '900' }, { ...legacy, totalTimeoutSeconds: 60.5 },
    { ...legacy, roundTimeoutSeconds: 900 }, { ...legacy, extra: true }]) {
    assert.equal(isLegacyWorkerPolicy(value), false);
  }
  for (const key of Object.keys(legacy)) {
    const partial = { ...legacy }; delete partial[key]; assert.equal(isLegacyWorkerPolicy(partial), false);
  }
  const hidden = Object.defineProperty({ ...legacy }, Symbol('unknown'), { value: true });
  assert.equal(isLegacyWorkerPolicy(hidden), false);
  let reads = 0;
  assert.equal(isLegacyWorkerPolicy({ ...legacy, get mode() { reads++; return 'legacy-bounded'; } }), false);
  assert.equal(reads, 0);
  assert.equal(isLegacyWorkerPolicy(Object.assign(Object.create(null), legacy)), true);
});
