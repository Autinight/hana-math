// Own-data snapshots before authority awaits. No model, filesystem or Core access.
import { isProxy } from 'node:util/types';
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function snapshotPlanData(value, code = 'PROJECT_INVALID_INPUT', depth = 0) {
  if (typeof value === 'string' || typeof value === 'boolean' || value === null || Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== 'object' || isProxy(value) || depth > 10
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) fail(code);
  const array = Array.isArray(value), keys = Reflect.ownKeys(value).filter(key => !(array && key === 'length'));
  if (keys.length > 2048 || array && keys.length !== value.length) fail(code);
  const entries = keys.map((key, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || array && key !== String(index)) fail(code);
    return [key, snapshotPlanData(descriptor.value, code, depth + 1)];
  });
  return array ? entries.map(([, item]) => item) : Object.fromEntries(entries);
}
export function snapshotPaperPlanRequest(value, { tool = false, read = false, code = 'PROJECT_INVALID_INPUT' } = {}) {
  const input = snapshotPlanData(value, code);
  const allowed = ['projectId', ...(tool ? ['action'] : []), ...(read ? ['reportId'] : ['brief', 'instructions', 'paperId', 'factIds'])];
  const required = ['projectId', ...(tool ? ['action'] : []), read ? 'reportId' : 'brief'];
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(input, key)) || typeof input.projectId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.projectId)) fail(code);
  const text = v => typeof v === 'string' && v.isWellFormed() && !v.includes('\0') && Buffer.byteLength(v) <= 32768;
  if (read) {
    if (typeof input.reportId !== 'string' || !/^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.reportId)) fail(code);
  } else if (!text(input.brief) || !input.brief.trim() || Object.hasOwn(input, 'instructions') && !text(input.instructions)
    || Object.hasOwn(input, 'paperId') && (typeof input.paperId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.paperId))
    || Object.hasOwn(input, 'factIds') && (!Array.isArray(input.factIds) || input.factIds.length > 64
      || input.factIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) || new Set(input.factIds).size !== input.factIds.length)) fail(code);
  return input;
}
export function snapshotPaperPlanStart(value) {
  const input = snapshotPlanData(value);
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !['projectId', 'kind', 'language', 'plan'].includes(key))
    || input.kind !== 'paper-plan' || input.language !== 'English' || !Object.hasOwn(input, 'plan')) fail('PROJECT_INVALID_INPUT');
  return input;
}
