// Own-data/software fixtures, never real operator details or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPaperRevisionRequest, snapshotPaperRevisionStart, validOperatorNotes } from '../packages/hana-math/paper-revision-input.mjs';
import { buildPaperNotesRevisionPrompt } from '../packages/hana-math/paper-revision.mjs';
const reportId = 'report-01234567-89ab-cdef-0123-456789abcdef';
const request = { reportId, mode: 'operator-notes', notes: '  Opaque 编辑🙂\r\nPreserve spacing.\r\n ' };
const start = { kind: 'paper-revision', language: 'English', revision: { mode: 'operator-notes', sourceReportId: reportId, paperId: 'main' }, notes: request.notes };

test('operator-notes request/start snapshots preserve exact Unicode CRLF and reject mixed or unknown selectors', () => {
  assert.deepEqual(snapshotPaperRevisionRequest(request), request);
  assert.deepEqual(snapshotPaperRevisionRequest({ reportId }), { reportId });
  assert.deepEqual(snapshotPaperRevisionRequest({ reportId, mode: 'citation' }), { reportId, mode: 'citation' });
  const original = structuredClone(start), snap = snapshotPaperRevisionStart(original);
  original.notes = 'changed'; original.revision.mode = 'citation'; original.revision.sourceReportId = 'foreign';
  assert.deepEqual(snap, start);
  for (const mode of [undefined, null, '', 'targeted-notes', 'style', 'compile', 'gap-fill', {}, 1]) {
    assert.throws(() => snapshotPaperRevisionRequest({ reportId, mode, notes: 'x' }), { code: 'PROJECT_INVALID_INPUT' });
  }
  for (const notes of ['', ' \r\n\t', null, undefined, false, 1, '\0', 'x\0y', '\ud800', '\udfff', 'x'.repeat(32769), '界'.repeat(10923)]) {
    assert.equal(validOperatorNotes(notes), false);
    assert.throws(() => snapshotPaperRevisionRequest({ ...request, notes }), { code: 'PROJECT_INVALID_INPUT' });
    assert.throws(() => snapshotPaperRevisionStart({ ...start, notes }), { code: 'PROJECT_INVALID_INPUT' });
  }
  for (const mode of [undefined, 'citation']) for (const notes of ['', null, undefined, 'x']) {
    assert.throws(() => snapshotPaperRevisionRequest({ reportId, ...(mode ? { mode } : {}), notes }), { code: 'PROJECT_INVALID_INPUT' });
  }
  for (const extra of [{ paperId: 'main' }, { verificationReportId: reportId }, { sourceReportId: reportId }, { unknown: true }]) {
    assert.throws(() => snapshotPaperRevisionRequest({ ...request, ...extra }), { code: 'PROJECT_INVALID_INPUT' });
  }
  for (const revision of [{ ...start.revision, verificationReportId: reportId }, { ...start.revision, notes: 'x' },
    { ...start.revision, mode: 'citation' }, { ...start.revision, sourceReportId: '../file' }, { ...start.revision, paperId: 'Main' }]) {
    assert.throws(() => snapshotPaperRevisionStart({ ...start, revision }), { code: 'PROJECT_INVALID_INPUT' });
  }
});

test('operator-notes exact 32 KiB is a byte bound, without trimming or normalization', () => {
  for (const notes of ['x'.repeat(32768), '界'.repeat(10922) + 'ab', '🙂'.repeat(8192)]) {
    assert.equal(Buffer.byteLength(notes), 32768); assert.equal(validOperatorNotes(notes), true);
    assert.equal(snapshotPaperRevisionRequest({ ...request, notes }).notes, notes);
    assert.equal(snapshotPaperRevisionStart({ ...start, notes }).notes, notes);
    assert.equal(validOperatorNotes(notes + 'x'), false);
  }
});

test('operator-notes own-data snapshots reject accessors, symbols, nonenumerables, proxies and extra selector properties without execution', () => {
  let reads = 0;
  for (const key of ['reportId', 'mode', 'notes']) {
    const value = { ...request }; Object.defineProperty(value, key, { enumerable: true, get() { reads++; return request[key]; } });
    assert.throws(() => snapshotPaperRevisionRequest(value), { code: 'PROJECT_INVALID_INPUT' });
  }
  for (const value of [new Proxy(request, {}), Object.assign(Object.create({ mode: 'operator-notes' }), request),
    Object.defineProperty({ ...request }, 'hidden', { value: 'x' }), { ...request, [Symbol('x')]: true }]) {
    assert.throws(() => snapshotPaperRevisionRequest(value), { code: 'PROJECT_INVALID_INPUT' });
  }
  for (const key of ['mode', 'sourceReportId', 'paperId']) {
    const revision = { ...start.revision }; Object.defineProperty(revision, key, { enumerable: true, get() { reads++; return start.revision[key]; } });
    assert.throws(() => snapshotPaperRevisionStart({ ...start, revision }), { code: 'PROJECT_INVALID_INPUT' });
  }
  const value = { ...start }; Object.defineProperty(value, 'notes', { enumerable: true, get() { reads++; return request.notes; } });
  assert.throws(() => snapshotPaperRevisionStart(value), { code: 'PROJECT_INVALID_INPUT' }); assert.equal(reads, 0);
});

test('operator-notes request/start snapshots support stitched selectors and reject mixed/citation stitched shapes', () => {
  const planReportId = 'report-11234567-89ab-cdef-0123-456789abcdef';
  const finalSectionReportId = 'report-21234567-89ab-cdef-0123-456789abcdef';
  const stitchedReq = { planReportId, finalSectionReportId, mode: 'operator-notes', notes: request.notes };
  const stitchedStart = { kind: 'paper-revision', language: 'English',
    revision: { mode: 'operator-notes', planReportId, finalSectionReportId, paperId: 'main' }, notes: request.notes };
  assert.deepEqual(snapshotPaperRevisionRequest(stitchedReq), stitchedReq);
  assert.deepEqual(snapshotPaperRevisionStart(stitchedStart), stitchedStart);
  for (const bad of [
    { ...stitchedReq, reportId }, { planReportId, finalSectionReportId },
    { planReportId, finalSectionReportId, mode: 'citation' },
    { planReportId, mode: 'operator-notes', notes: 'x' },
    { finalSectionReportId, mode: 'operator-notes', notes: 'x' },
  ]) assert.throws(() => snapshotPaperRevisionRequest(bad), { code: 'PROJECT_INVALID_INPUT' });
  for (const badRev of [
    { mode: 'operator-notes', sourceReportId: reportId, planReportId, finalSectionReportId, paperId: 'main' },
    { mode: 'operator-notes', planReportId, paperId: 'main' },
    { planReportId, finalSectionReportId, paperId: 'main' },
  ]) assert.throws(() => snapshotPaperRevisionStart({ ...stitchedStart, revision: badRev }), { code: 'PROJECT_INVALID_INPUT' });
});

test('operator-notes prompt is a distinct targeted-notes data field, not fake citation fixes or a verification claim', () => {
  const input = { mainTex: 'Opaque main\r\n', ledger: 'Opaque ledger\r\n', notes: request.notes,
    resources: { contract: 'contract', reviserPrompt: 'reviser', style: 'style' } };
  const prompt = buildPaperNotesRevisionPrompt(input), envelope = JSON.parse(prompt.trimEnd().split('\n').at(-1));
  assert.equal(envelope.mode, 'targeted-notes'); assert.equal(envelope.operator_notes, request.notes);
  assert.equal(envelope.mainTex, input.mainTex); assert.equal(envelope.ledger, input.ledger); assert.equal(Object.hasOwn(envelope, 'citation_fixes'), false);
  for (const phrase of ['necessary adjacent repairs', 'global style pass', 'gap-fill', 'infer identities', 'verification claims',
    'no files, tools, network', '%%%PATCH%%%', '%%%REVISION_SUMMARY%%%', 'mechanically enforced']) assert.ok(prompt.includes(phrase), phrase);
  for (const changed of [{ ...input, notes: '' }, { ...input, verdicts: [] }, { ...input, resources: {} }]) assert.throws(() => buildPaperNotesRevisionPrompt(changed));
});
