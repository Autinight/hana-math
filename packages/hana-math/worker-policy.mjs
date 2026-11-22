// Pure configuration snapshots; no scheduling, storage or implicit policy upgrade.
// This is a Node single-timer technical limit, not a mathematical/run budget.
export const MAX_TIMER_SECONDS = Math.floor(2147483647 / 1000);
export const RESEARCH_WORKER_POLICY_DEFAULTS = Object.freeze({
  maxRounds: 0,
  roundTimeoutSeconds: 14400,
  roundDelaySeconds: 5,
  maxConsecutiveFailures: 5,
});
export const LEGACY_WORKER_POLICY_DEFAULTS = Object.freeze({
  mode: 'legacy-bounded',
  maxRounds: 3,
  totalTimeoutSeconds: 900,
});
const RESEARCH_FIELDS = Object.keys(RESEARCH_WORKER_POLICY_DEFAULTS);
const LEGACY_FIELDS = Object.keys(LEGACY_WORKER_POLICY_DEFAULTS);
const failure = (code, message) => Object.assign(new TypeError(message), { code });
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const legacyTimeout = value => Number.isInteger(value) && value >= 60 && value <= 900;

function record(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => fields.includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

// Call only for an explicitly provided policy. Missing policy is NOT {}.
// Zero maxRounds means unlimited; zero maxConsecutiveFailures disables that cutoff.
// An optional whole-run budget belongs elsewhere, never in these four fields.
export function normalizeResearchWorkerPolicy(input) {
  if (!record(input, RESEARCH_FIELDS)) throw failure('WORKER_POLICY_INVALID_INPUT',
    'Expected an explicit research worker policy object with only supported data fields.');
  const result = {};
  for (const key of RESEARCH_FIELDS) {
    const value = Object.hasOwn(input, key) ? input[key] : RESEARCH_WORKER_POLICY_DEFAULTS[key];
    const valid = key === 'roundTimeoutSeconds' ? Number.isInteger(value) && value > 0
      : key === 'roundDelaySeconds' ? typeof value === 'number' && Number.isFinite(value) && value >= 0
        : nonnegativeInteger(value);
    if (!valid) throw failure('WORKER_POLICY_INVALID_FIELD', `Invalid worker policy field: ${key}.`);
    if ((key === 'roundTimeoutSeconds' || key === 'roundDelaySeconds') && value > MAX_TIMER_SECONDS) {
      throw failure('WORKER_POLICY_TIMER_LIMIT', 'Worker policy seconds exceed the Node single-timer technical limit.');
    }
    result[key] = value === 0 ? 0 : value;
  }
  return Object.freeze(result);
}

// Persisted opt-in records must be complete: never default damaged history into
// unlimited execution. Whole-run budget is independent from the round timeout.
export function readResearchExecutionPolicy(input) {
  const fields = ['mode', 'workerPolicy', 'totalTimeoutSeconds'];
  if (!record(input, fields) || !fields.every(key => Object.hasOwn(input, key))
    || input.mode !== 'research-rounds' || !record(input.workerPolicy, RESEARCH_FIELDS)
    || !RESEARCH_FIELDS.every(key => Object.hasOwn(input.workerPolicy, key))
    || !(input.totalTimeoutSeconds === null || legacyTimeout(input.totalTimeoutSeconds))) {
    throw failure('WORKER_EXECUTION_POLICY_INVALID', 'Invalid persisted research execution policy.');
  }
  return Object.freeze({ mode: 'research-rounds', workerPolicy: normalizeResearchWorkerPolicy(input.workerPolicy),
    totalTimeoutSeconds: input.totalTimeoutSeconds });
}

// Compatibility snapshot: timeout is for the WHOLE run, not for each round.
export function createLegacyWorkerPolicy(totalTimeoutSeconds = 900) {
  if (!legacyTimeout(totalTimeoutSeconds)) throw failure('LEGACY_WORKER_POLICY_INVALID_TIMEOUT',
    'Legacy total timeout must be an integer from 60 to 900 seconds.');
  return Object.freeze({ ...LEGACY_WORKER_POLICY_DEFAULTS, totalTimeoutSeconds });
}

// Recognizes exact persisted/JSON shapes as well as freshly frozen snapshots.
// Missing or malformed snapshots are not silently reclassified or upgraded.
export function isLegacyWorkerPolicy(value) {
  return record(value, LEGACY_FIELDS) && LEGACY_FIELDS.every(key => Object.hasOwn(value, key))
    && value.mode === 'legacy-bounded' && value.maxRounds === 3 && legacyTimeout(value.totalTimeoutSeconds);
}
