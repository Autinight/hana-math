import { REPORT_ID } from './project-report-kinds.mjs';
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const plain = value => object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const dataOnly = value => Reflect.ownKeys(value).every(key => typeof key === 'string'
  && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
  && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));

const SELECTOR_KEYS = ['sourceReportId', 'planReportId', 'finalSectionReportId', 'revisionReportId', 'verificationReportId', 'chapterTreeReportId'];

export function snapshotPaperMathSelector(selector) {
  if (!plain(selector) || !dataOnly(selector)) return null;
  const keys = Reflect.ownKeys(selector);
  if (keys.length === 1 && ['sourceReportId', 'revisionReportId', 'verificationReportId', 'chapterTreeReportId'].includes(keys[0])
    && REPORT_ID.test(selector[keys[0]])) {
    return Object.freeze({ [keys[0]]: selector[keys[0]] });
  }
  if (keys.length === 2 && keys.includes('planReportId') && keys.includes('finalSectionReportId')
    && REPORT_ID.test(selector.planReportId) && REPORT_ID.test(selector.finalSectionReportId)) {
    return Object.freeze({ planReportId: selector.planReportId, finalSectionReportId: selector.finalSectionReportId });
  }
  return null;
}

export function validPaperMathBinding(binding) {
  if (!plain(binding) || !dataOnly(binding)) return false;
  const keys = Reflect.ownKeys(binding);
  if (keys.some(key => typeof key !== 'string')) return false;
  const selectorKeys = keys.filter(key => SELECTOR_KEYS.includes(key));
  const selector = snapshotPaperMathSelector(Object.fromEntries(selectorKeys.map(key => [key, binding[key]])));
  return Boolean(selector) && keys.length === Object.keys(selector).length + 5
    && [...Object.keys(selector), 'mainSha256', 'ledgerSha256', 'contractSha256', 'verifierPromptSha256', 'promptSha256']
      .every(key => keys.includes(key))
    && ['mainSha256', 'ledgerSha256', 'contractSha256', 'verifierPromptSha256', 'promptSha256']
      .every(key => HASH.test(binding[key]));
}
