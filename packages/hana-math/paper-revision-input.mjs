// Pure own-data admission snapshots. Raw operator notes never belong in a persisted binding.
import { isProxy } from 'node:util/types';
const reportId = /^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const paperId = /^[a-z0-9][a-z0-9-]{0,63}$/;
const factId = /^[0-9a-f]{16}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function data(input, allowed, required, code) {
  if (input === null || typeof input !== 'object' || isProxy(input) || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(code);
  const keys = Reflect.ownKeys(input);
  if (!keys.every(key => allowed.includes(key) && Object.getOwnPropertyDescriptor(input, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')) || !required.every(key => keys.includes(key))) fail(code);
  return Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(input, key).value]));
}
function ownArray(value, code) {
  if (!Array.isArray(value) || isProxy(value)) fail(code);
  const keys = Reflect.ownKeys(value).filter(k => k !== 'length');
  if (keys.length !== value.length) fail(code);
  return keys.map((key, index) => {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (key !== String(index) || !desc?.enumerable || !Object.hasOwn(desc, 'value')) fail(code);
    return desc.value;
  });
}
export const validOperatorNotes = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0')
  && value.trim().length > 0 && Buffer.byteLength(value) <= 32 * 1024;
export const validGapFillFactIds = (value, code = 'PROJECT_INVALID_INPUT') => {
  const items = ownArray(value, code);
  if (items.length > 16 || !items.every(id => typeof id === 'string' && factId.test(id)) || new Set(items).size !== items.length) fail(code);
  return items;
};
export const validMissingBacking = (value, code = 'PROJECT_INVALID_INPUT') => {
  const items = ownArray(value, code);
  if (items.length < 1 || items.length > 16
    || !items.every(s => typeof s === 'string' && s.isWellFormed() && !s.includes('\0') && s.trim().length > 0 && Buffer.byteLength(s) <= 1024)) fail(code);
  return items;
};
export function snapshotPaperRevisionRequest(input, { project = false, tool = false, code = 'PROJECT_INVALID_INPUT' } = {}) {
  const base = [...(project || tool ? ['projectId'] : []), ...(tool ? ['action'] : [])];
  const result = data(input, [...base, 'reportId', 'planReportId', 'finalSectionReportId', 'mode', 'notes', 'factIds', 'missingBacking', 'compileLog'], base, code);
  const mode = result.mode;
  if (mode === 'gap-fill') {
    if (!Object.hasOwn(result, 'reportId') || Object.hasOwn(result, 'planReportId') || Object.hasOwn(result, 'finalSectionReportId')
      || Object.hasOwn(result, 'compileLog') || typeof result.reportId !== 'string' || !reportId.test(result.reportId)
      || !Object.hasOwn(result, 'factIds') || !validOperatorNotes(result.notes)) fail(code);
    result.factIds = validGapFillFactIds(result.factIds, code);
    if (Object.hasOwn(result, 'missingBacking')) result.missingBacking = validMissingBacking(result.missingBacking, code);
    return result;
  }
  if (mode === 'compile-fix') {
    if (Object.hasOwn(result, 'notes') || Object.hasOwn(result, 'factIds') || Object.hasOwn(result, 'missingBacking')
      || !validOperatorNotes(result.compileLog)) fail(code);
    if (Object.hasOwn(result, 'reportId')) {
      if (Object.hasOwn(result, 'planReportId') || Object.hasOwn(result, 'finalSectionReportId')
        || typeof result.reportId !== 'string' || !reportId.test(result.reportId)) fail(code);
      return result;
    }
    if (!Object.hasOwn(result, 'planReportId') || !Object.hasOwn(result, 'finalSectionReportId')
      || typeof result.planReportId !== 'string' || !reportId.test(result.planReportId)
      || typeof result.finalSectionReportId !== 'string' || !reportId.test(result.finalSectionReportId)) fail(code);
    return result;
  }
  if (Object.hasOwn(result, 'factIds') || Object.hasOwn(result, 'missingBacking') || Object.hasOwn(result, 'compileLog')) fail(code);
  if (Object.hasOwn(result, 'reportId')) {
    if (Object.hasOwn(result, 'planReportId') || Object.hasOwn(result, 'finalSectionReportId')
      || typeof result.reportId !== 'string' || !reportId.test(result.reportId)
      || (Object.hasOwn(result, 'mode') && !['citation', 'operator-notes'].includes(result.mode))) fail(code);
    if (result.mode === 'operator-notes' ? !validOperatorNotes(result.notes) : Object.hasOwn(result, 'notes')) fail(code);
    return result;
  }
  if (!Object.hasOwn(result, 'planReportId') || !Object.hasOwn(result, 'finalSectionReportId')
    || typeof result.planReportId !== 'string' || !reportId.test(result.planReportId)
    || typeof result.finalSectionReportId !== 'string' || !reportId.test(result.finalSectionReportId)
    || result.mode !== 'operator-notes' || !validOperatorNotes(result.notes)) fail(code);
  return result;
}
export function snapshotPaperRevisionStart(input) {
  const code = 'PROJECT_INVALID_INPUT';
  const result = data(input, ['kind', 'language', 'revision', 'notes', 'compileLog'], ['kind', 'language', 'revision'], code);
  const revision = data(result.revision, ['mode', 'sourceReportId', 'revisionReportId', 'chapterTreeReportId',
    'planReportId', 'finalSectionReportId', 'verificationReportId', 'mathReviewReportId', 'paperId', 'factIds', 'missingBacking'], ['paperId'], code);
  if (result.kind !== 'paper-revision' || result.language !== 'English'
    || typeof revision.paperId !== 'string' || !paperId.test(revision.paperId)) fail(code);
  if (revision.mode === 'gap-fill') {
    if (Object.hasOwn(result, 'compileLog') || !validOperatorNotes(result.notes)
      || typeof revision.mathReviewReportId !== 'string' || !reportId.test(revision.mathReviewReportId)
      || !Object.hasOwn(revision, 'factIds')) fail(code);
    const allowed = ['mode', 'mathReviewReportId', 'paperId', 'factIds', ...(Object.hasOwn(revision, 'missingBacking') ? ['missingBacking'] : [])];
    if (Object.keys(revision).length !== allowed.length || !allowed.every(k => Object.hasOwn(revision, k))) fail(code);
    revision.factIds = validGapFillFactIds(revision.factIds, code);
    if (revision.factIds.length < 1) fail(code);
    if (Object.hasOwn(revision, 'missingBacking')) revision.missingBacking = validMissingBacking(revision.missingBacking, code);
    return { ...result, revision };
  }
  if (revision.mode === 'compile-fix') {
    if (Object.hasOwn(result, 'notes') || !validOperatorNotes(result.compileLog)) fail(code);
    const sel = Object.hasOwn(revision, 'planReportId') || Object.hasOwn(revision, 'finalSectionReportId')
      ? ['planReportId', 'finalSectionReportId']
      : Object.hasOwn(revision, 'revisionReportId') ? ['revisionReportId']
      : Object.hasOwn(revision, 'chapterTreeReportId') ? ['chapterTreeReportId']
      : ['sourceReportId'];
    const keys = ['mode', ...sel, 'paperId'];
    if (Object.keys(revision).length !== keys.length || !keys.every(k => Object.hasOwn(revision, k))
      || !sel.every(k => typeof revision[k] === 'string' && reportId.test(revision[k]))) fail(code);
    return { ...result, revision };
  }
  if (Object.hasOwn(result, 'compileLog')) fail(code);
  const notes = revision.mode === 'operator-notes';
  const sel = notes
    ? (Object.hasOwn(revision, 'planReportId') || Object.hasOwn(revision, 'finalSectionReportId')
      ? ['planReportId', 'finalSectionReportId']
      : Object.hasOwn(revision, 'chapterTreeReportId') ? ['chapterTreeReportId'] : ['sourceReportId'])
    : ['verificationReportId'];
  const keys = notes ? ['mode', ...sel, 'paperId'] : ['verificationReportId', 'paperId'];
  if (Object.keys(revision).length !== keys.length
    || !keys.every(key => Object.hasOwn(revision, key))
    || !sel.every(key => typeof revision[key] === 'string' && reportId.test(revision[key]))
    || (notes ? !validOperatorNotes(result.notes) : Object.hasOwn(result, 'notes'))) fail(code);
  return { ...result, revision };
}
