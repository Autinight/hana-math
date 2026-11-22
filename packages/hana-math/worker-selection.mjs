// Pure validation for per-worker dispatch metadata. No storage, Agent, Host or session writes.
import { isProxy } from 'node:util/types';

// A public display label, never a title inferred from TASK.md or proof text.
export const DEFAULT_WORKER_DISPLAY_TITLE = '证明任务';
export const WORKER_DISPLAY_TITLE_GUIDANCE = 'Optional displayTitle is a separate public background-task title (for example, Catenoid curvature). Use one line of at most 24 Unicode code points: letters, numbers, combining marks, ordinary spaces or hyphens. Do not include private instructions, proofs, paths or links. Omitted or unsuitable titles use the generic label; reassignment never inherits a title.';

export function workerDisplayTitle(value) {
  if (typeof value !== 'string' || value.length > 48 || [...value].length > 24
    || !/[\p{L}\p{N}]/u.test(value) || /[^\p{L}\p{N}\p{M} -]|\p{Default_Ignorable_Code_Point}/u.test(value)) return undefined;
  return value.replace(/ +/g, ' ').trim();
}

const fail = code => { throw Object.assign(new Error(code), { code }); };
function dataObject(value, allowed, required) {
  return value !== null && typeof value === 'object' && !isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === 'string' && allowed.includes(key) && d.enumerable && Object.hasOwn(d, 'value');
    }) && required.every(key => Object.hasOwn(value, key));
}
export function validateWorkerModel(model) {
  if (!dataObject(model, ['provider', 'id'], ['provider', 'id'])
    || ![model.provider, model.id].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value))) fail('INVALID_MODEL');
  return { provider: model.provider, id: model.id };
}
function plainArray(value) {
  return Array.isArray(value) && !isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= 16384 && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i)))
      .every(d => d?.enumerable && Object.hasOwn(d, 'value'));
}
function supportedStrings(value) {
  if (!plainArray(value) || value.length > 128 || !value.every(v => typeof v === 'string' && v.trim().length > 0 && v.length <= 128 && !/[\x00-\x1f]/.test(v))) fail('INVALID_THINKING_LEVEL');
  return value;
}
export function normalizeWorkerDispatch(input) {
  if (!dataObject(input, ['model', 'thinkingLevel'], [])) fail('INVALID_INPUT');
  const output = {};
  if (Object.hasOwn(input, 'model')) output.model = validateWorkerModel(input.model);
  if (Object.hasOwn(input, 'thinkingLevel')) {
    if (typeof input.thinkingLevel !== 'string' || !input.thinkingLevel.trim() || input.thinkingLevel.length > 128 || /[\x00-\x1f]/.test(input.thinkingLevel) || input.thinkingLevel === 'auto') fail('INVALID_THINKING_LEVEL');
    output.thinkingLevel = input.thinkingLevel;
  }
  return output;
}
export function validateWorkerSelection(input, catalog) {
  normalizeWorkerDispatch(input);
  if (!Object.hasOwn(input, 'model')) fail('INVALID_MODEL');
  const model = validateWorkerModel(input.model);
  const explicitThinking = Object.hasOwn(input, 'thinkingLevel');
  if (!plainArray(catalog)) fail('INVALID_MODEL_CATALOG');
  const seen = new Set(); let selected;
  for (const row of catalog) {
    if (!row || typeof row !== 'object' || isProxy(row) || ![Object.prototype, null].includes(Object.getPrototypeOf(row))) fail('INVALID_MODEL_CATALOG');
    const read = key => {
      const d = Object.getOwnPropertyDescriptor(row, key);
      if (d && (!d.enumerable || !Object.hasOwn(d, 'value'))) fail('INVALID_MODEL_CATALOG');
      return d?.value;
    };
    const ref = validateWorkerModel({ provider: read('provider'), id: read('id') });
    const key = JSON.stringify([ref.provider, ref.id]);
    if (seen.has(key)) fail('INVALID_MODEL_CATALOG'); seen.add(key);
    if (ref.provider === model.provider && ref.id === model.id) selected = { read };
  }
  if (!selected) fail('MODEL_NOT_AVAILABLE');
  if (explicitThinking) {
    const levels = selected.read('thinkingLevels'), custom = selected.read('customThinkingLevels');
    const supported = [...(levels === undefined ? [] : supportedStrings(levels)), ...(custom === undefined ? [] : supportedStrings(custom))];
    if (!supported.includes(input.thinkingLevel)) fail('INVALID_THINKING_LEVEL');
  }
  // defaultThinkingLevel is deliberately not read, expanded or persisted.
  return { model, ...(explicitThinking ? { thinkingLevel: input.thinkingLevel } : {}) };
}
