// Public scheduling metadata only. Never return raw provider or model configuration.
import { isProxy } from 'node:util/types';
import { validateWorkerModel } from './worker-selection.mjs';

const failure = code => Object.assign(new Error(code), { code });
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
function plain(value) {
  return value !== null && typeof value === 'object' && !isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function array(value, maximum) {
  return Array.isArray(value) && !isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
      .every(field => field?.enumerable && Object.hasOwn(field, 'value'));
}
function thinkingLevels(row) {
  const result = new Set();
  let declared = false;
  for (const key of ['thinkingLevels', 'customThinkingLevels']) {
    const field = Object.getOwnPropertyDescriptor(row, key);
    if (!field) continue;
    declared = true;
    if (!Object.hasOwn(field, 'value') || !field.enumerable || !array(field.value, 128)
      || !field.value.every(level => typeof level === 'string' && level.trim().length > 0
        && level.length <= 128 && !/[\x00-\x1f]/.test(level))) return null;
    for (const level of field.value) if (level !== 'auto') result.add(level);
  }
  return declared ? [...result].sort() : null;
}
export function workerModelPage(options, offset = 0, limit = 32) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64) throw failure('PROJECT_INVALID_INPUT');
  const models = [];
  let bytes = 0;
  for (const model of options.models.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(model));
    if (bytes + size > 256 * 1024) break;
    models.push(model); bytes += size;
  }
  const next = offset + models.length;
  return { defaultModel: options.defaultModel, thinkingControl: options.thinkingControl,
    models, offset, total: options.models.length, nextOffset: next < options.models.length ? next : null,
    catalogTiming: 'current-read' };
}
export function projectWorkerModels(catalog, saved, capabilities) {
  if (!plain(catalog) || own(catalog, 'ok') === false || own(catalog, 'error')
    || !array(own(catalog, 'models'), 16384)) throw failure('MODEL_CATALOG_INVALID');
  if (!plain(saved) || own(saved, 'role') !== 'worker' || own(saved, 'source') !== 'saved-role') throw failure('SAVED_ROLE_INVALID');
  const defaultModel = validateWorkerModel(own(saved, 'model'));
  const seen = new Set();
  const models = own(catalog, 'models').map(row => {
    if (!plain(row)) throw failure('MODEL_CATALOG_INVALID');
    const model = validateWorkerModel({ provider: own(row, 'provider'), id: own(row, 'id') });
    const key = JSON.stringify([model.provider, model.id]);
    if (seen.has(key)) throw failure('MODEL_CATALOG_INVALID');
    seen.add(key);
    return { ...model, supportedThinkingLevels: thinkingLevels(row) };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  const capability = 'app/session.thinking-level';
  const rows = plain(capabilities) && own(capabilities, 'ok') !== false && !own(capabilities, 'error')
    && array(own(capabilities, 'capabilities'), 256) ? own(capabilities, 'capabilities') : [];
  const matches = rows.filter(row => plain(row) && own(row, 'capability') === capability);
  const row = matches.length === 1 ? matches[0] : null;
  const status = row && ['always', 'session', 'denied', 'not_asked'].includes(own(row, 'status')) ? own(row, 'status') : 'unknown';
  const enforcement = row && ['hard', 'advisory'].includes(own(row, 'enforcement')) ? own(row, 'enforcement') : 'unknown';
  return { defaultModel, models, thinkingControl: { capability, status, enforcement,
    available: status === 'always' && enforcement === 'hard' } };
}
