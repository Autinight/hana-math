// Danus 839c471: OPERATOR.md, sections “Operator” and “Standing preferences”.
// Keep project-visible answers only. No account setup, project problem, inferred
// defaults, or run-control settings belong in this snapshot.
import { isProxy } from 'node:util/types';

export const operatorFields = Object.freeze(['name', 'language', 'timezone', 'notifications', 'spendWarningUsd', 'workerRoster']);
const labels = Object.freeze(['Name / how to address', 'Language', 'Timezone', 'Notifications', 'Spend ceiling (paid backend API)', 'worker roster']);
const invalid = () => { throw Object.assign(new Error('PROJECT_OPERATOR_PROFILE_INVALID'), { code: 'PROJECT_OPERATOR_PROFILE_INVALID' }); };

function readAnswers(value, allowRemoval) {
  if (value === null || typeof value !== 'object' || isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!operatorFields.includes(key) || !d.enumerable || !Object.hasOwn(d, 'value')) invalid();
    const v = d.value;
    if (v === null && allowRemoval) { result[key] = null; continue; }
    if (key === 'spendWarningUsd') {
      if (!Number.isFinite(v) || v < 0) invalid();
    } else if (typeof v !== 'string' || !v.isWellFormed() || !v.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(v) || Buffer.byteLength(v) > 1024) invalid();
    result[key] = v;
  }
  return result;
}

// Missing leaves an answer intact; null explicitly forgets it for future projects.
export function updateOperatorAnswers(current, patch) {
  const next = readAnswers(current, false);
  for (const [key, value] of Object.entries(readAnswers(patch, true))) {
    if (value === null) delete next[key]; else next[key] = value;
  }
  return next;
}

export function renderOperatorProfile(answers) {
  const values = readAnswers(answers, false);
  if (!Object.keys(values).length) return null;
  const lines = ['# OPERATOR.md — durable operator profile & standing preferences'];
  for (const [heading, fields] of [['Operator', operatorFields.slice(0, 3)], ['Standing preferences', operatorFields.slice(3)]]) {
    const included = fields.filter(key => Object.hasOwn(values, key));
    if (!included.length) continue;
    lines.push('', `## ${heading}`);
    for (const key of included) {
      const text = key === 'spendWarningUsd' ? `USD ${values[key]} (warning only; not a hard stop)` : values[key];
      lines.push(`- **${labels[operatorFields.indexOf(key)]}:** ${text}`);
    }
  }
  return lines.join('\n') + '\n';
}
