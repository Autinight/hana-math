import { readResearchExecutionPolicy } from './worker-policy.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const failure = (code, message = code) => Object.assign(new Error(message), { code });
function check(value, code) { if (!value) throw failure(code); }

export function submissionProjection(value, executionPolicy = undefined) {
  const unavailable = history => ({ available: false, history, recordingComplete: false,
    hostPreCallbackRejectionsCovered: false, zeroAttemptsProvesNoModelCall: false });
  let maxRound = 3;
  if (executionPolicy !== undefined) {
    try { maxRound = readResearchExecutionPolicy(executionPolicy).workerPolicy.maxRounds || Number.MAX_SAFE_INTEGER; }
    catch { return unavailable('invalid'); }
  }
  if (value === undefined) return unavailable('unknown');
  if (object(value) && value.available === false && ['unknown', 'invalid'].includes(value.history) && value.recordingComplete === false
    && value.hostPreCallbackRejectionsCovered === false && value.zeroAttemptsProvesNoModelCall === false
    && !Object.hasOwn(value, 'total') && !Object.hasOwn(value, 'omitted') && !Object.hasOwn(value, 'attempts')) return unavailable(value.history);
  const uint = n => Number.isSafeInteger(n) && n >= 0;
  const identifier = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(s);
  const uuid = (s, prefix) => typeof s === 'string' && new RegExp(`^${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(s);
  const safeCode = s => typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(s);
  try {
    check(object(value) && value.available === true && value.coverage === 'authorized-app-callbacks'
      && ['complete', 'since-instrumentation'].includes(value.history) && typeof value.recordingComplete === 'boolean'
      && value.hostPreCallbackRejectionsCovered === false && value.zeroAttemptsProvesNoModelCall === false
      && uint(value.total) && uint(value.omitted) && Array.isArray(value.attempts)
      && value.attempts.length === Math.min(256, value.total) && value.omitted === value.total - value.attempts.length, 'SUBMISSION_DIAGNOSTICS_INVALID');
    const attempts = value.attempts.map(a => {
      check(object(a) && uuid(a.attemptId, 'attempt') && uint(a.at) && Number.isSafeInteger(a.round) && a.round >= 1 && a.round <= maxRound
        && identifier(a.workerSessionId) && ['backend', 'tool-validation'].includes(a.source)
        && ['processing', 'input-rejected', 'slot-rejected', 'precheck-rejected', 'prepare-error', 'registered'].includes(a.outcome)
        && safeCode(a.code) && (a.source !== 'tool-validation' || a.outcome === 'input-rejected'), 'SUBMISSION_DIAGNOSTICS_INVALID');
      const row = { attemptId: a.attemptId, at: a.at, round: a.round, workerSessionId: a.workerSessionId, source: a.source, outcome: a.outcome, code: a.code };
      if (a.outcome === 'registered' || Object.hasOwn(a, 'submissionId')) {
        check(a.outcome === 'registered' && uuid(a.submissionId, 'submission'), 'SUBMISSION_DIAGNOSTICS_INVALID'); row.submissionId = a.submissionId;
      }
      if (Object.hasOwn(a, 'coreCode')) {
        check(a.outcome === 'prepare-error' && ['revoked', 'revoked_candidate'].includes(a.coreCode), 'SUBMISSION_DIAGNOSTICS_INVALID'); row.coreCode = a.coreCode;
      }
      if (a.outcome === 'precheck-rejected' || Object.hasOwn(a, 'precheck')) {
        const p = a.precheck;
        check(a.outcome === 'precheck-rejected' && object(p) && ['P1', 'P3', 'P5', 'vacuous', 'unknown'].includes(p.rule)
          && (p.rule === 'unknown' ? p.target === 'unknown' : ['proof', 'statement'].includes(p.target))
          && (p.status === 'unknown' || Number.isInteger(p.status) && p.status >= 100 && p.status <= 599), 'SUBMISSION_DIAGNOSTICS_INVALID');
        row.precheck = { rule: p.rule, target: p.target, status: p.status };
      }
      return row;
    });
    check(new Set(attempts.map(a => a.attemptId)).size === attempts.length, 'SUBMISSION_DIAGNOSTICS_INVALID');
    return { available: true, coverage: value.coverage, history: value.history, recordingComplete: value.recordingComplete,
      hostPreCallbackRejectionsCovered: false, zeroAttemptsProvesNoModelCall: false, total: value.total, omitted: value.omitted, attempts };
  } catch { return unavailable('invalid'); }
}
