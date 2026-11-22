// Pure, bounded projection of one returned active branch. Never reads files or invokes tools.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
export const READ_EVIDENCE_LIMITS = Object.freeze({ predecessors: 128, candidateBytes: 1 << 20, depth: 16, nodes: 16384,
  entries: 16384, records: 16384, resultBytes: 1 << 20, totalResultBytes: 8 << 20, outputBytes: 256 << 10 });
export const data = (value, key) => value !== null && typeof value === 'object' && !isProxy(value)
  ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
export const plainEvidence = v => v !== null && typeof v === 'object' && !isProxy(v) && !Array.isArray(v) && [null, Object.prototype].includes(Object.getPrototypeOf(v));
export const evidenceId = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f/\\]/.test(v);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const FID = /^[a-f0-9]{16}$/, SHA = /^[a-f0-9]{64}$/;
const REASONS = new Set(['EVIDENCE_UNAVAILABLE', 'CANDIDATE_INVALID', 'CANDIDATE_LIMIT', 'CANDIDATE_BINDING_INVALID', 'PREDECESSOR_LIMIT', 'PREDECESSOR_DIGEST_INVALID',
  'LINKAGE_UNAVAILABLE', 'LINKAGE_CHANGED', 'CANDIDATE_LINKAGE_INVALID', 'VERIFIER_NOT_CLEAN_COMPLETED', 'SESSION_IDENTITY_UNAVAILABLE', 'SESSION_IDENTITY_CHANGED',
  'ENTRIES_UNSUPPORTED', 'ENTRIES_SESSION_MISMATCH', 'CANDIDATE_CHANGED', 'READ_TIMEOUT', 'HOST_OR_RECORD_UNAVAILABLE', 'PARSER_UNAVAILABLE',
  'TREE_INVALID', 'LEAF_INVALID', 'ENTRY_LIMIT', 'ANCESTOR_LIMIT', 'RECORD_LIMIT', 'ASSISTANT_CONTENT_UNKNOWN', 'CALL_ID_INVALID', 'READ_TARGET_UNKNOWN',
  'RESULT_ID_INVALID', 'READ_CORRELATION_UNKNOWN', 'RESULT_STATUS_UNKNOWN', 'RESULT_TEXT_UNSUPPORTED', 'RESULT_TEXT_LIMIT', 'RESULT_TOTAL_LIMIT', 'OUTPUT_LIMIT']);
const failures = new WeakMap();
export function evidenceFailure(reason, coverage = 'unavailable') {
  const safe = { reason: REASONS.has(reason) ? reason : 'EVIDENCE_UNAVAILABLE', coverage: coverage === 'limited' ? 'limited' : 'unavailable' };
  const error = Object.assign(new Error(safe.reason), { evidenceReason: safe.reason, coverage: safe.coverage });
  failures.set(error, Object.freeze(safe)); return error;
}
export function evidenceFailureInfo(error, fallback = 'EVIDENCE_UNAVAILABLE') {
  return failures.get(error) || { reason: REASONS.has(fallback) ? fallback : 'EVIDENCE_UNAVAILABLE', coverage: 'unavailable' };
}
const problem = evidenceFailure;
function check(condition, reason = 'CANDIDATE_INVALID') { if (!condition) throw problem(reason); }
function keys(value, allowed, required = allowed) {
  check(plainEvidence(value) && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k)));
}
function text(value, max, nonempty = false) {
  check(typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && Buffer.byteLength(value) <= max && (!nonempty || value.trim().length > 0));
}
/** Candidate bytes only, not mathematical validation or a reimplementation of Core hashing. */
export function candidatePredecessors(bytes, identity) {
  check(Buffer.isBuffer(bytes) && bytes.length <= READ_EVIDENCE_LIMITS.candidateBytes, 'CANDIDATE_LIMIT');
  let candidate;
  try { candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw problem('CANDIDATE_INVALID'); }
  let nodes = 0;
  function visit(v, depth) {
    check(++nodes <= READ_EVIDENCE_LIMITS.nodes && depth <= READ_EVIDENCE_LIMITS.depth, 'CANDIDATE_LIMIT');
    if (typeof v === 'string') { check(v.isWellFormed() && !v.includes('\0')); return; }
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return;
    check(plainEvidence(v) || Array.isArray(v));
    for (const value of Object.values(v)) visit(value, depth + 1);
  }
  visit(candidate, 0);
  keys(candidate, ['binding', 'arguments', 'prepared']);
  const b = candidate.binding, a = candidate.arguments, p = candidate.prepared;
  keys(b, ['projectId', 'runId', 'workerId', 'role', 'author']);
  check(b.projectId === identity.projectId && b.runId === identity.runId && b.workerId === identity.workerId
    && b.role === 'worker' && b.author === identity.workerAgentId, 'CANDIDATE_BINDING_INVALID');
  keys(a, ['statement', 'proof', 'predecessors', 'glossary_introduces', 'intuition', 'source_id', 'external_refs'], ['statement', 'proof']);
  text(a.statement, 256 << 10, true); text(a.proof, 256 << 10, true);
  if (Object.hasOwn(a, 'intuition')) text(a.intuition, 256 << 10);
  if (a.source_id != null) text(a.source_id, 4096);
  if (a.glossary_introduces != null) {
    check(plainEvidence(a.glossary_introduces) && Object.keys(a.glossary_introduces).length <= 128);
    for (const [key, value] of Object.entries(a.glossary_introduces)) { text(key, 128, true); text(value, 4096, true); }
  }
  if (a.external_refs != null) check(Array.isArray(a.external_refs) && a.external_refs.length <= 128 && a.external_refs.every(plainEvidence));
  const predecessors = a.predecessors ?? [];
  check(Array.isArray(predecessors) && predecessors.length <= READ_EVIDENCE_LIMITS.predecessors, 'PREDECESSOR_LIMIT');
  check(predecessors.every(id => typeof id === 'string' && FID.test(id)) && new Set(predecessors).size === predecessors.length);
  check(plainEvidence(p) && typeof p.candidateDigest === 'string' && SHA.test(p.candidateDigest)
    && plainEvidence(p.precheck) && typeof p.precheck.passed === 'boolean' && plainEvidence(p.predecessorDigests));
  check(Object.keys(p.predecessorDigests).length === predecessors.length && Object.keys(p.predecessorDigests).every(id => predecessors.includes(id))
    && predecessors.every(id => typeof p.predecessorDigests[id] === 'string' && SHA.test(p.predecessorDigests[id])), 'PREDECESSOR_DIGEST_INVALID');
  return predecessors.map(factId => ({ factId, expectedSHA: p.predecessorDigests[factId] }));
}
export function readEvidenceDTO(identity, coverage = 'unavailable', reasons = [], predecessors = [], verifierSessionId = null) {
  const safeReasons = new Set();
  if (Array.isArray(reasons) && !isProxy(reasons)) for (let i = 0; i < Math.min(reasons.length, 16); i++) {
    const reason = data(reasons, String(i)); safeReasons.add(REASONS.has(reason) ? reason : 'EVIDENCE_UNAVAILABLE');
  }
  else safeReasons.add('EVIDENCE_UNAVAILABLE');
  coverage = ['complete', 'limited', 'unavailable', 'not-needed'].includes(coverage) ? coverage : 'unavailable';
  return { schemaVersion: 1, action: 'verification_reads', kind: 'verification_reads', projectId: identity.projectId, runId: identity.runId,
    submissionId: identity.submissionId, verifierSessionId, source: 'host-session-entries', coverage, coverageScope: 'returned-active-branch',
    verdictTiming: 'not-established', currentGraphValidity: 'not-queried', hostMaterializationBounded: false,
    interpretation: 'Recorded whole-content matches only; not physical reads, model delivery/cognition, verdict timing or current graph validity. Zero observed counts concern only the returned active branch.',
    reasons: [...safeReasons], predecessors: predecessors.slice(0, READ_EVIDENCE_LIMITS.predecessors).map(p => ({ factId: p.factId, expectedSHA: p.expectedSHA,
      invocationCount: 0, successfulResultCount: 0, exactMatchCount: 0, ambiguousCount: 0, firstCall: null, firstExactMatch: null })) };
}
function target(args, cwd, canonical) {
  if (!plainEvidence(args)) return { unknown: true };
  const names = Reflect.ownKeys(args);
  if (names.some(k => !['path', 'resource', 'offset', 'limit'].includes(k)) || names.some(k => !Object.hasOwn(Object.getOwnPropertyDescriptor(args, k), 'value'))) return { unknown: true };
  const direct = names.includes('path'), resource = names.includes('resource');
  if (direct === resource) return { unknown: true };
  let file = data(args, 'path');
  if (resource) {
    const r = data(args, 'resource');
    if (!plainEvidence(r) || Reflect.ownKeys(r).length !== 2 || !Reflect.ownKeys(r).every(k => ['kind', 'path'].includes(k)) || data(r, 'kind') !== 'local-file') return { unknown: true };
    file = data(r, 'path');
  }
  if (typeof file !== 'string' || !file || file !== file.trim() || file.length > 4096 || /[\x00-\x1f]/.test(file) || file.startsWith('~')) return { unknown: true };
  // Use only the verified session cwd to select the lexical convention. Keep
  // exact case and never resolve a drive-relative name using the App's own cwd.
  const windows = /^[A-Za-z]:[\\/]/.test(cwd);
  const paths = windows ? path.win32 : path.posix;
  if (windows) {
    const driveAbsolute = /^[A-Za-z]:[\\/]/.test(file);
    if ((!driveAbsolute && /^[\\/]/.test(file)) || /[<>:"|?*]/.test(driveAbsolute ? file.slice(2) : file)) return { unknown: true };
  } else if (file.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(file)) return { unknown: true };
  const row = canonical.get(paths.resolve(cwd, file));
  if (!row) return { unrelated: true };
  const range = {};
  for (const key of ['offset', 'limit']) {
    const value = data(args, key);
    if (Object.hasOwn(args, key) && (!Number.isSafeInteger(value) || value < 1)) return { row, unknown: true };
    range[key] = value ?? null;
  }
  return { row, range, matchBasis: paths.isAbsolute(file) ? 'absolute-lexical-path' : 'verified-cwd-lexical-relative-path' };
}
function truncation(message) {
  const value = data(data(message, 'details'), 'truncation');
  const result = { known: typeof data(value, 'truncated') === 'boolean' };
  if (!result.known) return result;
  result.truncated = data(value, 'truncated');
  if (['lines', 'bytes'].includes(data(value, 'truncatedBy'))) result.truncatedBy = data(value, 'truncatedBy');
  for (const key of ['totalLines', 'outputLines', 'totalBytes', 'outputBytes']) {
    const n = data(value, key); if (Number.isSafeInteger(n) && n >= 0) result[key] = n;
  }
  if (typeof data(value, 'firstLineExceedsLimit') === 'boolean') result.firstLineExceedsLimit = data(value, 'firstLineExceedsLimit');
  return result;
}
/** Host payload already materialized. Never touch unrelated text, thinking, args or result bodies. */
export function parseVerificationReads(response, identity, predecessors, cwd, canonicalPaths, verifierSessionId) {
  if (predecessors.length > READ_EVIDENCE_LIMITS.predecessors) return readEvidenceDTO(identity, 'limited', ['PREDECESSOR_LIMIT'], predecessors.slice(0, READ_EVIDENCE_LIMITS.predecessors), verifierSessionId);
  let dto = readEvidenceDTO(identity, 'complete', [], predecessors, verifierSessionId);
  const reasons = new Set();
  const limited = reason => { reasons.add(reason); dto.coverage = 'limited'; };
  const cap = (condition, reason) => { if (!condition) throw problem(reason, 'limited'); };
  let work = 0, resultBytes = 0;
  const consume = n => { work += n; cap(work <= READ_EVIDENCE_LIMITS.records, 'RECORD_LIMIT'); };
  try {
    cap(predecessors.length <= READ_EVIDENCE_LIMITS.predecessors, 'PREDECESSOR_LIMIT');
    const entries = data(response, 'entries'), leaf = data(response, 'leafId');
    if (!Array.isArray(entries) || isProxy(entries)) throw problem('TREE_INVALID');
    cap(entries.length <= READ_EVIDENCE_LIMITS.entries, 'ENTRY_LIMIT');
    const map = new Map();
    for (let i = 0; i < entries.length; i++) {
      const e = data(entries, String(i)), id = data(e, 'id'), parent = data(e, 'parentId');
      if (!evidenceId(id) || !(parent === null || evidenceId(parent)) || map.has(id)) throw problem('TREE_INVALID');
      map.set(id, { id, parent, entry: e });
    }
    for (const node of map.values()) if (node.parent !== null && !map.has(node.parent)) throw problem('TREE_INVALID');
    const visited = new Set();
    for (const node of map.values()) {
      const trail = new Set(); let at = node;
      while (at && !visited.has(at.id)) {
        if (trail.has(at.id)) throw problem('TREE_INVALID');
        trail.add(at.id); at = map.get(at.parent);
      }
      for (const id of trail) visited.add(id);
    }
    if (leaf === null && !entries.length) return dto;
    if (!evidenceId(leaf) || !map.has(leaf)) throw problem('LEAF_INVALID');
    const chain = []; let node = map.get(leaf);
    while (node) { cap(chain.length < entries.length, 'ANCESTOR_LIMIT'); chain.push(node); node = map.get(node.parent); }
    chain.reverse();
    const canonical = new Map(predecessors.map((p, i) => [canonicalPaths[i], dto.predecessors[i]]));
    const calls = new Map(), results = new Map();
    function append(map, id, value) { const list = map.get(id) || []; list.push(value); map.set(id, list); }
    for (const [order, node] of chain.entries()) {
      if (data(node.entry, 'type') !== 'message') continue;
      const message = data(node.entry, 'message'), role = data(message, 'role');
      if (role === 'assistant') {
        const content = data(message, 'content');
        if (!Array.isArray(content) || isProxy(content)) { limited('ASSISTANT_CONTENT_UNKNOWN'); continue; }
        consume(content.length);
        for (let i = 0; i < content.length; i++) {
          const block = data(content, String(i)); if (data(block, 'type') !== 'toolCall') continue;
          consume(1);
          const id = data(block, 'id'), name = data(block, 'name');
          if (!evidenceId(id)) { limited('CALL_ID_INVALID'); continue; }
          const call = { id, name, order, entryId: node.id };
          if (name === 'read') {
            Object.assign(call, target(data(block, 'arguments'), cwd, canonical));
            if (call.unknown) limited('READ_TARGET_UNKNOWN');
            if (call.row) {
              call.row.invocationCount++;
              if (!call.unknown && !call.row.firstCall) call.row.firstCall = { entryId: node.id, callId: id, matchBasis: call.matchBasis, range: call.range };
            }
          }
          append(calls, id, call);
        }
      } else if (role === 'toolResult') {
        consume(1);
        const id = data(message, 'toolCallId');
        if (!evidenceId(id)) { limited('RESULT_ID_INVALID'); continue; }
        append(results, id, { entryId: node.id, name: data(message, 'toolName'), message, order });
      }
    }
    for (const [id, group] of results) if (!calls.has(id) && group.some(result => result.name === 'read')) limited('READ_CORRELATION_UNKNOWN');
    for (const [id, group] of calls) for (const call of group) {
      if (!call.row) continue;
      const row = call.row, matches = results.get(id) || [];
      if (call.unknown || group.length !== 1 || matches.length !== 1 || matches[0].name !== 'read' || matches[0].order <= call.order) {
        row.ambiguousCount++; limited('READ_CORRELATION_UNKNOWN'); continue;
      }
      const result = matches[0], error = data(result.message, 'isError');
      if (error !== false) { if (error !== true) { row.ambiguousCount++; limited('RESULT_STATUS_UNKNOWN'); } continue; }
      row.successfulResultCount++;
      const content = data(result.message, 'content'); let text;
      if (typeof content === 'string') { consume(1); text = content; }
      else if (Array.isArray(content) && !isProxy(content)) {
        consume(content.length);
        if (content.length === 1 && data(data(content, '0'), 'type') === 'text') text = data(data(content, '0'), 'text');
      }
      if (typeof text !== 'string' || !text.isWellFormed()) { row.ambiguousCount++; limited('RESULT_TEXT_UNSUPPORTED'); continue; }
      if (text.length > READ_EVIDENCE_LIMITS.resultBytes || Buffer.byteLength(text) > READ_EVIDENCE_LIMITS.resultBytes) {
        row.ambiguousCount++; limited('RESULT_TEXT_LIMIT'); continue;
      }
      const bytes = Buffer.byteLength(text); resultBytes += bytes;
      cap(resultBytes <= READ_EVIDENCE_LIMITS.totalResultBytes, 'RESULT_TOTAL_LIMIT');
      const metadata = { entryId: call.entryId, resultEntryId: result.entryId, callId: id, bytes, sha256: sha256(Buffer.from(text, 'utf8')),
        matchBasis: call.matchBasis, range: call.range, truncation: truncation(result.message) };
      // Branch coverage is independent of optional read-completeness metadata.
      // known:false remains explicit; only exact recorded bytes support a match.
      if (row.firstCall?.callId === id) row.firstCall = metadata;
      if (metadata.sha256 === row.expectedSHA) { row.exactMatchCount++; row.firstExactMatch ??= metadata; }
    }
    dto.reasons = [...reasons];
    if (Buffer.byteLength(JSON.stringify(dto)) > READ_EVIDENCE_LIMITS.outputBytes) {
      dto.coverage = 'limited'; dto.reasons = [...reasons, 'OUTPUT_LIMIT'];
      for (const row of dto.predecessors) { row.firstCall = null; row.firstExactMatch = null; }
    }
    return dto;
  } catch (error) {
    // A capped or malformed scan never exposes provisional positive counts.
    const failure = evidenceFailureInfo(error, 'PARSER_UNAVAILABLE');
    return readEvidenceDTO(identity, failure.coverage, [failure.reason],
      predecessors.slice(0, READ_EVIDENCE_LIMITS.predecessors), verifierSessionId);
  }
}
