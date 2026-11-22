// Pure kind contract fixtures only. No lifecycle, Host or model operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reportKindSpec, validReportStart, validReportPayload, reportTaskFields, matchesReportTaskFields } from '../packages/hana-math/project-report-kinds.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
const projectId = 'fixture-project', reportId = 'report-00000000-0000-0000-0000-000000000010', planReportId = 'report-00000000-0000-0000-0000-000000000001';
function fixture() {
  const material = { schemaVersion: 1, sectionIndex: 0, title: 'Opaque', label: 'sec:x', factIds: [], referenceFactIds: [], localClosureFactIds: [], parentMaterialSha256: 'a'.repeat(64) };
  material.sha256 = hash(JSON.stringify(material));
  return { schemaVersion: 1, source: { projectId, planReportId, paperId: 'main', planBindingSha256: 'b'.repeat(64), artifacts: Object.fromEntries(['response', 'blocks', 'plan', 'ledger'].map(k => [k, { sha256: 'c'.repeat(64), bytes: 1 }])) },
    lineage: { chainRootReportId: reportId, previousSectionReportId: null, previousSourceSha256: null, previousResultSha256: null }, sectionCount: 1, material,
    resources: Object.fromEntries(['contract', 'sectionWriterPrompt', 'style', 'structure'].map(k => [k, 'd'.repeat(64)])), promptSha256: 'e'.repeat(64) };
}
const spec = reportKindSpec('paper-section');

test('B1 section contract strict selector admission is distinct from the persisted binding', () => {
  const start = { kind: 'paper-section', language: 'English', section: { planReportId } };
  assert.equal(validReportStart(start, projectId), true); assert.equal(validReportStart({ ...start, projectId }, projectId), true);
  assert.equal(validReportStart({ ...start, projectId: 'foreign' }, projectId), false);
  for (const patch of [{ language: 'Chinese' }, { source: {} }, { section: fixture() }, { section: { planReportId, extra: 1 } }]) assert.equal(validReportStart({ ...start, ...patch }, projectId), false);
  let reads = 0; const getter = { ...start, section: {} }; Object.defineProperty(getter.section, 'planReportId', { enumerable: true, get() { reads++; return planReportId; } });
  assert.equal(validReportStart(getter, projectId), false); assert.equal(reads, 0);
});

test('B1 section contract valid dirty ownership remains loadable without parent files/current pins', () => {
  const section = fixture(), meta = { kind: 'paper-section', language: 'English', projectId, reportId, section };
  for (const state of ['queued', 'running', 'failed', 'interrupted', 'completed']) for (const cleanupPending of [true, false]) assert.equal(validReportPayload({ ...meta, state, cleanupPending, error: 'ARCHIVE_NOT_SAVED', artifacts: {} }, projectId), true);
  assert.equal(validReportPayload({ ...meta, projectId: 'foreign' }, projectId), false);
  assert.equal(validReportPayload(meta, 'foreign'), false); assert.equal(validReportPayload({ ...meta, reportId: planReportId }, projectId), false);
  assert.equal(validReportPayload({ ...meta, language: 'Chinese' }, projectId), false);
  assert.equal(validReportStart(meta, projectId), false, 'a persisted binding is never a selector');
});

test('B1 section contract record owns binding; task fingerprint binds all source/material/lineage/resource bytes', () => {
  const section = fixture(), meta = { projectId, reportId, language: 'English', ...spec.recordFields(section) }, fields = reportTaskFields(meta);
  assert.deepEqual(fields, { projectId, reportId, kind: 'paper-section', planReportId, sectionIndex: 0, chainRootReportId: reportId, sectionBindingSha256: hash(JSON.stringify(meta.section)) });
  assert.equal(matchesReportTaskFields(meta, fields), true); assert.equal(matchesReportTaskFields(meta, { ...fields, hostExtra: true }), true);
  for (const key of Object.keys(fields)) { assert.equal(matchesReportTaskFields(meta, { ...fields, [key]: 'foreign' }), false); const absent = { ...fields }; delete absent[key]; assert.equal(matchesReportTaskFields(meta, absent), false); }
  for (const mutate of [s => { s.source.artifacts.ledger.bytes++; }, s => { s.resources.style = 'f'.repeat(64); }, s => { s.material.title += ' changed'; }, s => { s.lineage.chainRootReportId = planReportId; }, s => { s.promptSha256 = 'f'.repeat(64); }]) { const changed = structuredClone(meta); mutate(changed.section); assert.equal(matchesReportTaskFields(changed, fields), false); }
  section.material.title = 'mutated caller'; assert.equal(meta.section.material.title, 'Opaque'); assert.doesNotMatch(JSON.stringify(fields), /"title"|"resources"|"artifacts"|Opaque/);
});

test('B1 section contract has exactly three default deliveries and fragment artifact identities', () => {
  assert.deepEqual(spec.artifactNames, { response: 'raw-response.txt', source: 'section.tex', provenance: 'PROVENANCE.json', ledger: 'REFERENCE_LEDGER.md', section: 'SECTION_RESULT.json' });
  assert.deepEqual(spec.deliveredRoles, ['source', 'section', 'ledger']); assert.equal(Object.isFrozen(spec.deliveredRoles), true);
  assert.equal(reportKindSpec('paper-source').artifactNames.source, 'main.tex'); assert.equal(reportKindSpec('paper-plan').artifactNames.plan, 'SECTION_PLAN.json');
  assert.deepEqual(reportKindSpec('paper-plan').deliveredRoles, ['blocks', 'plan', 'ledger']); assert.deepEqual(reportKindSpec().deliveredRoles, []);
});
