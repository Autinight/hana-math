// Pure pagination admission/projection. No authority, state, Core or diagnostics.
import { isProxy } from 'node:util/types';
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/, FID = /^[0-9a-f]{16}$/, SHA = /^[0-9a-f]{64}$/;
export const FACT_PAGE_BYTES = 16 * 1024, FACT_PAGE_ROWS = 64, FACT_PREVIEW_BYTES = 512;
export function isCanonicalFact(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [null, Object.prototype].includes(Object.getPrototypeOf(value)) && typeof value.fact_id === 'string' && /^[a-f0-9]{16}$/.test(value.fact_id)
    && Array.isArray(value.predecessors) && value.predecessors.every(id => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id));
}
const fail = code => { throw Object.assign(new Error(code), { code }); };
const require = (ok, code) => { if (!ok) fail(code); };
function fields(value, names, required, code) {
  require(value !== null && typeof value === 'object' && !isProxy(value) && !Array.isArray(value)
    && [null, Object.prototype].includes(Object.getPrototypeOf(value)), code);
  const keys = Reflect.ownKeys(value);
  require(keys.length <= names.length && keys.every(k => typeof k === 'string' && names.includes(k)) && required.every(k => keys.includes(k)), code);
  const out = {};
  for (const k of keys) { const d = Object.getOwnPropertyDescriptor(value, k); require(d.enumerable && Object.hasOwn(d, 'value'), code); out[k] = d.value; }
  return out;
}
function array(value, maximum, code) {
  require(!isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum, code);
  const keys = Reflect.ownKeys(value); require(keys.length === value.length + 1, code);
  const copy = [];
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); require(d && d.enumerable && Object.hasOwn(d, 'value'), code); copy.push(d.value); }
  return copy;
}
const matches = (re, v) => typeof v === 'string' && re.exec(v)?.[0] === v;
const integer = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
function cursor(token, projectId, code) {
  require(typeof token === 'string' && token.length >= 1 && token.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(token), code);
  const bytes = Buffer.from(token, 'base64url'); require(bytes.toString('base64url') === token, code);
  const text = bytes.toString('utf8'); require(Buffer.from(text).equals(bytes), code);
  let raw; try { raw = JSON.parse(text); } catch { fail(code); }
  const keys = ['v', 'projectId', 'asOf', 'offset', 'limit'];
  const value = fields(raw, keys, keys, code);
  require(value.v === 1 && matches(ID, value.projectId) && (projectId === undefined || value.projectId === projectId)
    && matches(SHA, value.asOf) && integer(value.offset, 0) && integer(value.limit, 1, FACT_PAGE_ROWS), code);
  // Restricted ASCII strings and safe integers share Python's canonical bytes.
  // Comparing the wire text also rejects duplicates hidden by JSON.parse.
  require(text === JSON.stringify({ asOf: value.asOf, limit: value.limit, offset: value.offset,
    projectId: value.projectId, v: value.v }), code);
  return value;
}
export function factPageOptions(options = {}, { factId, projectId, code = 'FACT_PAGE_INVALID_INPUT' } = {}) {
  const value = fields(options, ['cursor', 'limit'], [], code);
  require(factId === undefined || Object.keys(value).length === 0, code);
  if (Object.hasOwn(value, 'limit')) require(integer(value.limit, 1, FACT_PAGE_ROWS), code);
  if (Object.hasOwn(value, 'cursor')) {
    const decoded = cursor(value.cursor, projectId, code);
    require(!Object.hasOwn(value, 'limit') || value.limit === decoded.limit, code);
  }
  return value;
}
export function validateFactPage(input, projectId, options = {}, code = 'FACT_RESULT_INVALID') {
  require(matches(ID, projectId), code);
  const requested = factPageOptions(options, { projectId, code });
  const previous = requested.cursor === undefined ? null : cursor(requested.cursor, projectId, code);
  const value = fields(input, ['facts', 'page'], ['facts', 'page'], code);
  const keys = ['version', 'asOf', 'total', 'startIndex', 'returned', 'limit', 'nextCursor', 'hasMore', 'allFactsIncluded', 'previewOnly'];
  const p = fields(value.page, keys, keys, code);
  require(p.version === 1 && matches(SHA, p.asOf) && p.previewOnly === true
    && integer(p.total, 0) && integer(p.startIndex, 0, p.total)
    && integer(p.returned, 0, FACT_PAGE_ROWS) && integer(p.limit, 1, FACT_PAGE_ROWS)
    && p.limit === (requested.limit ?? previous?.limit ?? FACT_PAGE_ROWS)
    && p.startIndex === (previous?.offset ?? 0) && (!previous || p.asOf === previous.asOf), code);
  const facts = array(value.facts, FACT_PAGE_ROWS, code).map(item => {
    const keys = ['fact_id', 'predecessors', 'statementPreview', 'statementPreviewTruncated', 'canonicalBytes'];
    const f = fields(item, keys, keys, code);
    const predecessors = array(f.predecessors, 128, code);
    require(matches(FID, f.fact_id) && predecessors.every(v => matches(FID, v)) && new Set(predecessors).size === predecessors.length, code);
    require(typeof f.statementPreview === 'string' && f.statementPreview.isWellFormed() && !f.statementPreview.includes('\0')
      && Buffer.byteLength(f.statementPreview) <= FACT_PREVIEW_BYTES && typeof f.statementPreviewTruncated === 'boolean'
      && integer(f.canonicalBytes, 1, 1 << 20) && f.canonicalBytes >= Buffer.byteLength(f.statementPreview), code);
    return { ...f, predecessors };
  });
  require(facts.length === p.returned && p.returned <= p.limit && facts.every((f, i) => i === 0 || facts[i - 1].fact_id < f.fact_id), code);
  const end = p.startIndex + p.returned;
  require(Number.isSafeInteger(end) && end <= p.total && (p.total === 0 ? end === 0 && !previous : p.returned > 0 && p.startIndex < p.total)
    && p.hasMore === (end < p.total) && p.allFactsIncluded === (p.startIndex === 0 && end === p.total), code);
  if (p.hasMore) {
    const next = cursor(p.nextCursor, projectId, code);
    require(next.asOf === p.asOf && next.offset === end && next.limit === p.limit, code);
  } else require(p.nextCursor === null, code);
  const result = { facts, page: p };
  require(Buffer.byteLength(JSON.stringify(result)) <= FACT_PAGE_BYTES, code);
  return result;
}

export const FACT_PAGE_GUIDANCE = 'Without factId, result returns one bounded preview-only fact-index page (default/max limit 64, at most 16 KiB). Use nextCursor until hasMore=false; omit limit on continuation or keep it unchanged. Never mix different asOf observations: discard accumulated pages and restart from the first page after drift. allFactsIncluded describes this response only, not the last page of a traversal. statementPreview is a lossy single-line section projection (at most 512 UTF-8 bytes), not complete hypotheses or proof; use factId for complete canonical material. cursor/limit cannot accompany factId. fact_search is relevance search, not complete enumeration. Each page rescans the whole graph to compute asOf, so a full traversal costs roughly quadratic work and adds every page to the conversation: for routine review prefer fact_search plus factId reads, and use full paging only for an occasional complete inventory. No automatic aggregation, research restart or storage-capacity guarantee.';
