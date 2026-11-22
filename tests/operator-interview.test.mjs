import assert from 'node:assert/strict';
import test from 'node:test';
import { operatorFields, updateOperatorAnswers, renderOperatorProfile } from '../packages/hana-math/operator-interview.mjs';

test('operator interview renders only supplied standing preferences, separate from the research problem', () => {
  assert.equal(renderOperatorProfile({}), null);
  const a = updateOperatorAnswers({}, { language: '中文', name: '示例研究者', spendWarningUsd: 0 });
  const expected = '# OPERATOR.md — durable operator profile & standing preferences\n\n## Operator\n- **Name / how to address:** 示例研究者\n- **Language:** 中文\n\n## Standing preferences\n- **Spend ceiling (paid backend API):** USD 0 (warning only; not a hard stop)\n';
  assert.equal(renderOperatorProfile(a), expected);
  const b = updateOperatorAnswers(a, { language: 'English', spendWarningUsd: null, notifications: 'Only when a proof needs review.' });
  assert.equal(renderOperatorProfile(a), expected, 'patch must not mutate the source');
  assert.match(renderOperatorProfile(b), /Language:\*\* English/);
  assert.doesNotMatch(renderOperatorProfile(b), /Spend ceiling|Timezone|worker roster|PROBLEM/);
  assert.match(renderOperatorProfile(b), /Notifications:\*\* Only when a proof needs review\./);
});

test('interview validates both saved answers and patches; no implicit authority, deadlines or configuration', () => {
  const code = { code: 'PROJECT_OPERATOR_PROFILE_INVALID' };
  for (const bad of [{ projectId: 'x' }, { deadline: 'today' }, { apiKey: 'do-not-save' }, { owner: 'operator' },
    { language: 'English\n## Problem' }, { timezone: '  ' }, { notifications: 'x'.repeat(1025) }, { name: '\ud800' },
    { spendWarningUsd: -5 }, { spendWarningUsd: Infinity }, { spendWarningUsd: '5' }, { workerRoster: {} }, [], null]) {
    assert.throws(() => updateOperatorAnswers({}, bad), code);
  }
  let accessed = false;
  const getter = Object.defineProperty({}, 'language', { enumerable: true, get() { accessed = true; } });
  assert.throws(() => renderOperatorProfile(getter), code);
  assert.throws(() => updateOperatorAnswers({ unknown: 'legacy field' }, {}), code);
  assert.equal(accessed, false);
  const all = Object.fromEntries(operatorFields.map(key => [key, key === 'spendWarningUsd' ? 15.5 : 'sample']));
  assert.equal(renderOperatorProfile(all).split('\n').filter(line => line.startsWith('- **')).length, 6);
  assert.equal(renderOperatorProfile(updateOperatorAnswers(all, Object.fromEntries(operatorFields.map(key => [key, null])))), null);
});
