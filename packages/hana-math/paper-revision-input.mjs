// Pure own-data admission snapshots. Raw operator notes never belong in a persisted binding.
import { isProxy } from 'node:util/types';
const reportId = /^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const paperId = /^[a-z0-9][a-z0-9-]{0,63}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function data(input, allowed, required, code) {
  if (input === null || typeof input !== 'object' || isProxy(input) || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(code);
  const keys = Reflect.ownKeys(input);
  if (!keys.every(key => allowed.includes(key) && Object.getOwnPropertyDescriptor(input, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')) || !required.every(key => keys.includes(key))) fail(code);
  return Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(input, key).value]));
}
export const validOperatorNotes = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0')
  && value.trim().length > 0 && Buffer.byteLength(value) <= 32 * 1024;
export function snapshotPaperRevisionRequest(input, { project = false, tool = false, code = 'PROJECT_INVALID_INPUT' } = {}) {
  const base = [...(project || tool ? ['projectId'] : []), ...(tool ? ['action'] : []), 'reportId'];
  const result = data(input, [...base, 'mode', 'notes'], base, code);
  if (typeof result.reportId !== 'string' || !reportId.test(result.reportId)
    || (Object.hasOwn(result, 'mode') && !['citation', 'operator-notes'].includes(result.mode))) fail(code);
  if (result.mode === 'operator-notes' ? !validOperatorNotes(result.notes) : Object.hasOwn(result, 'notes')) fail(code);
  return result;
}
export function snapshotPaperRevisionStart(input) {
  const code = 'PROJECT_INVALID_INPUT';
  const result = data(input, ['kind', 'language', 'revision', 'notes'], ['kind', 'language', 'revision'], code);
  const revision = data(result.revision, ['mode', 'sourceReportId', 'verificationReportId', 'paperId'], ['paperId'], code);
  const notes = revision.mode === 'operator-notes';
  const keys = notes ? ['mode', 'sourceReportId', 'paperId'] : ['verificationReportId', 'paperId'];
  if (result.kind !== 'paper-revision' || result.language !== 'English' || Object.keys(revision).length !== keys.length
    || !keys.every(key => Object.hasOwn(revision, key)) || typeof revision.paperId !== 'string' || !paperId.test(revision.paperId)
    || typeof revision[notes ? 'sourceReportId' : 'verificationReportId'] !== 'string'
    || !reportId.test(revision[notes ? 'sourceReportId' : 'verificationReportId'])
    || (notes ? !validOperatorNotes(result.notes) : Object.hasOwn(result, 'notes'))) fail(code);
  return { ...result, revision };
}
