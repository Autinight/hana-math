// Own-data selector fixtures only; no API/writer/model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPaperSectionRequest as request, snapshotPaperSectionStart as start } from '../packages/hana-math/paper-section-input.mjs';
const projectId = 'project-opaque', planReportId = 'report-00000000-0000-0000-0000-000000000001', previousSectionReportId = 'report-00000000-0000-0000-0000-000000000002';
const selector = () => ({ planReportId, previousSectionReportId });
const envelope = () => ({ kind: 'paper-section', language: 'English', section: selector() });
const bad = run => assert.throws(run, { code: 'PROJECT_INVALID_INPUT' });

test('B1 section input admits only start selectors and independent read/tool envelopes', () => {
  assert.deepEqual(request({ projectId, planReportId }), { projectId, planReportId });
  assert.deepEqual(request({ projectId, ...selector() }), { projectId, ...selector() });
  const read = { projectId, reportId: previousSectionReportId };
  assert.deepEqual(request(read, { read: true }), read);
  for (const action of ['paper_section_status', 'paper_section_result', 'paper_section_stop']) assert.deepEqual(request({ ...read, action }, { read: true, tool: true }), { ...read, action });
  assert.deepEqual(request({ projectId, planReportId, action: 'paper_section' }, { tool: true }), { projectId, planReportId, action: 'paper_section' });
  for (const extra of ['paperId', 'brief', 'instructions', 'resources', 'cwd', 'sectionIndex', 'factIds', 'source', 'reportId']) bad(() => request({ projectId, planReportId, [extra]: 'forged' }));
  bad(() => request({ ...read, planReportId }, { read: true })); bad(() => request({ ...read, previousSectionReportId }, { read: true }));
  bad(() => request({ projectId, planReportId, action: 'paper_section' })); bad(() => request({ projectId, planReportId }, { tool: true }));
  for (const action of [null, 1, {}, '']) bad(() => request({ projectId, planReportId, action }, { tool: true }));
});

test('B1 section input uses strict UUID reports, project regex, required own keys and no explicit undefined', () => {
  for (const key of ['planReportId', 'previousSectionReportId']) for (const value of [null, undefined, '', 'report-short', planReportId.toUpperCase(), 'report-00000000-0000-0000-0000-000000000001/../x']) bad(() => request({ projectId, planReportId, [key]: value }));
  for (const project of ['', 'Upper', '-leading', 'with space', 'a'.repeat(65), null, undefined]) bad(() => request({ projectId: project, planReportId }));
  assert.equal(request({ projectId: 'a'.repeat(64), planReportId }).projectId.length, 64);
  for (const value of [null, [], {}, '', undefined, { projectId }, { planReportId }]) bad(() => request(value));
  bad(() => request({ projectId, reportId: planReportId.toUpperCase() }, { read: true }));
  assert.throws(() => request({ projectId, planReportId, extra: true }, { code: 'RESEARCH_TOOL_INVALID_INPUT' }), { code: 'RESEARCH_TOOL_INVALID_INPUT' });
});

test('B1 section input rejects getters at root and nested selector without invoking them', () => {
  let reads = 0;
  for (const key of ['projectId', 'planReportId']) { const raw = { projectId, planReportId }; Object.defineProperty(raw, key, { enumerable: true, get() { reads++; return 'forged'; } }); bad(() => request(raw)); }
  const raw = envelope(); Object.defineProperty(raw.section, 'planReportId', { enumerable: true, get() { reads++; return planReportId; } }); bad(() => start(raw));
  const kind = envelope(); Object.defineProperty(kind, 'kind', { enumerable: true, get() { reads++; return 'paper-section'; } }); bad(() => start(kind));
  assert.equal(reads, 0);
});

test('B1 section input rejects proxies/revoked proxies without traps and forged prototypes/data', () => {
  let traps = 0; const handler = Object.fromEntries(['get', 'ownKeys', 'getPrototypeOf', 'getOwnPropertyDescriptor'].map(k => [k, () => { traps++; throw Error('trap'); }]));
  bad(() => request(new Proxy({ projectId, planReportId }, handler)));
  bad(() => start({ ...envelope(), section: new Proxy(selector(), handler) }));
  const revoked = Proxy.revocable(selector(), handler); revoked.revoke(); bad(() => start({ ...envelope(), section: revoked.proxy })); assert.equal(traps, 0);
  const raw = { projectId, planReportId }; for (const key of ['hidden', Symbol('symbol')]) { const copy = { ...raw }; Object.defineProperty(copy, key, { value: true, enumerable: typeof key === 'symbol' }); bad(() => request(copy)); }
  bad(() => request(Object.assign(Object.create({}), raw)));
  for (const value of [new Date(), new Map(), new Set(), 1n, Symbol('x'), undefined, NaN, () => {}]) bad(() => start({ ...envelope(), section: value }));
  for (const value of [new Array(1), [planReportId, , previousSectionReportId], Object.setPrototypeOf([planReportId], Object.create(Array.prototype))]) bad(() => start({ ...envelope(), section: value }));
});

test('B1 section input internal start is exact English/section selector, never a bound binding or other kind', () => {
  assert.deepEqual(start(envelope()), envelope()); assert.deepEqual(start({ ...envelope(), projectId }), { ...envelope(), projectId });
  for (const patch of [{ kind: 'paper-plan' }, { language: 'Chinese' }, { projectId: 'Bad' }, { reportId: planReportId }, { resources: {} }, { section: {} }, { section: { ...selector(), material: {} } }, { section: { planReportId, previousSectionReportId: null } }]) bad(() => start({ ...envelope(), ...patch }));
  bad(() => start({ kind: 'paper-section', language: 'English' }));
});

test('B1 section input null-prototype own data is detached before the first authority await', async () => {
  const raw = Object.assign(Object.create(null), { projectId, planReportId }); assert.deepEqual(request(raw), { projectId, planReportId });
  const input = envelope(); let release; const barrier = new Promise(resolve => { release = resolve; });
  const prepare = async value => { const copy = start(value); await barrier; return copy; };
  const pending = prepare(input); input.section.planReportId = previousSectionReportId; input.language = 'Changed'; release(); const copy = await pending;
  assert.equal(copy.section.planReportId, planReportId); assert.equal(copy.language, 'English'); copy.section.previousSectionReportId = planReportId; assert.equal(input.section.previousSectionReportId, previousSectionReportId);
  const cycle = envelope(); cycle.section.self = cycle; bad(() => start(cycle));
});
