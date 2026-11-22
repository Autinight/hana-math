// Pure immutable-binding/archive DTO fixtures; no storage or model operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validSectionBinding as valid, sectionDocuments } from '../packages/hana-math/paper-section-binding.mjs';
const hash = s => createHash('sha256').update(s).digest('hex'), id = n => n.toString(16).padStart(16, '0');
const rid = n => 'report-00000000-0000-0000-0000-' + n.toString(16).padStart(12, '0');
const project = 'fixture-project';
function rehash(m) { const { sha256, ...payload } = m; m.sha256 = hash(JSON.stringify(payload)); return m; }
function binding(index = 0) {
  return { schemaVersion: 1, source: { projectId: project, planReportId: rid(1), paperId: 'main', planBindingSha256: 'a'.repeat(64), artifacts: Object.fromEntries(['response', 'blocks', 'plan', 'ledger'].map(k => [k, { sha256: 'b'.repeat(64), bytes: 10 }])) },
    lineage: { chainRootReportId: rid(10), previousSectionReportId: index === 0 ? null : rid(index === 1 ? 10 : 11), previousSourceSha256: index === 0 ? null : 'c'.repeat(64), previousResultSha256: index === 0 ? null : 'd'.repeat(64) }, sectionCount: 3,
    material: rehash({ schemaVersion: 1, sectionIndex: index, title: 'Opaque title', label: 'sec:opaque', factIds: [id(2)], referenceFactIds: [id(1)], localClosureFactIds: [id(1), id(2)], parentMaterialSha256: 'e'.repeat(64) }),
    resources: Object.fromEntries(['contract', 'sectionWriterPrompt', 'style', 'structure'].map(k => [k, 'f'.repeat(64)])), promptSha256: '0'.repeat(64) };
}
const tex = '\\section{Unvalidated title}\\label{thm:x}\nOpaque.\n';
const response = (body = tex, mapping = { 'thm:x': id(2) }) => body + '%%%PROVENANCE%%%\n' + JSON.stringify(mapping);

test('B1 section binding first/retry/successor/explicit branch shapes preserve chain ownership', () => {
  assert.equal(valid(binding(), project, rid(10)), true); assert.equal(valid(binding(1), project, rid(11)), true); assert.equal(valid(binding(2), project, rid(12)), true);
  const retry = binding(); retry.lineage.chainRootReportId = rid(20); assert.equal(valid(retry, project, rid(20)), true); assert.equal(valid(retry, project, rid(10)), false);
  assert.equal(valid(binding(1), project, rid(20)), true, 'explicit branch keeps the old root');
  for (const current of [rid(10), rid(11)]) assert.equal(valid(binding(2), project, current), false);
});

test('B1 section binding rejects project/report/root/index/previous identity conflicts', () => {
  assert.equal(valid(binding(), 'other-project', rid(10)), false); assert.equal(valid(binding(), project, 'report-short'), false);
  for (const key of ['chainRootReportId', 'previousSectionReportId', 'previousSourceSha256', 'previousResultSha256']) {
    const b = binding(); b.lineage[key] = key.endsWith('Sha256') ? 'a'.repeat(64) : rid(99); assert.equal(valid(b, project, rid(10)), false, key);
  }
  const second = binding(1); second.lineage.previousSectionReportId = rid(99); assert.equal(valid(second, project, rid(11)), false);
  const third = binding(2); third.lineage.previousSectionReportId = rid(10); assert.equal(valid(third, project, rid(12)), false);
  for (const index of [-1, 3, 0.5, '0']) { const b = binding(); b.material.sectionIndex = index; rehash(b.material); assert.equal(valid(b, project, rid(10)), false); }
  for (const count of [0, 130, 1.5, '3']) { const b = binding(); b.sectionCount = count; assert.equal(valid(b, project, rid(10)), false); }
  const max = binding(); max.sectionCount = 129; assert.equal(valid(max, project, rid(10)), true);
});

test('B1 section binding exact nested keys and artifact/hash/slug shapes are enforced', () => {
  for (const mutate of [b => { b.extra = true; }, b => { delete b.promptSha256; }, b => { b.source.extra = 1; }, b => { b.source.paperId = 'Bad'; }, b => { b.source.projectId = 'Other'; }, b => { b.source.planReportId = 'report-short'; }, b => { b.source.planBindingSha256 = 'x'; }, b => { delete b.source.artifacts.ledger; }, b => { b.source.artifacts.response.name = '/caller/path'; }, b => { b.source.artifacts.blocks.bytes = -1; }, b => { b.source.artifacts.plan.bytes = 0.5; }, b => { b.source.artifacts.ledger.sha256 = 'A'.repeat(64); }, b => { b.resources.extra = 'a'.repeat(64); }, b => { b.resources.style = 'bad'; }, b => { b.lineage.extra = 1; }, b => { b.schemaVersion = 2; }]) {
    const b = binding(); mutate(b); assert.equal(valid(b, project, rid(10)), false);
  }
});

test('B1 section binding material IDs are unique/bounded/local and self-hash is recomputed', () => {
  const mutations = [m => { m.factIds = [id(2), id(2)]; }, m => { m.factIds = Array.from({ length: 65 }, (_, i) => id(i)); }, m => { m.referenceFactIds = [id(1), id(1)]; }, m => { m.localClosureFactIds = [id(1), id(1), id(2)]; }, m => { m.referenceFactIds = [id(2)]; }, m => { m.referenceFactIds = [id(3)]; }, m => { m.localClosureFactIds = [id(1)]; }, m => { m.factIds = []; }, m => { m.factIds = ['BAD']; }, m => { m.localClosureFactIds = Array.from({ length: 2049 }, (_, i) => id(i)); }, m => { m.extra = 1; }, m => { m.title = '中'.repeat(1366); }, m => { m.label = '\x85'; }, m => { m.title = '\ud800'; }, m => { m.label = 'bad\0label'; }];
  for (const mutate of mutations) { const b = binding(); mutate(b.material); rehash(b.material); assert.equal(valid(b, project, rid(10)), false); }
  const badHash = binding(); badHash.material.title += 'modified'; assert.equal(valid(badHash, project, rid(10)), false);
  const empty = binding(); empty.material.factIds = []; empty.material.referenceFactIds = []; empty.material.localClosureFactIds = []; rehash(empty.material); assert.equal(valid(empty, project, rid(10)), true);
  const b = binding(); b.material.title = '中'.repeat(1365) + 'x'; b.material.localClosureFactIds = Array.from({ length: 2048 }, (_, i) => id(i)); rehash(b.material); assert.equal(valid(b, project, rid(10)), true);
});

test('B1 section binding accepts historical resource hashes and reordered keys without checking files', () => {
  const b = binding(); assert.equal(valid(b, project, rid(10)), true, 'fake historical pins remain shape-valid');
  b.material = Object.fromEntries(Object.entries(b.material).reverse()); assert.equal(valid(b, project, rid(10)), true);
  b.source.artifacts.ledger.bytes = 0; assert.equal(valid(b, project, rid(10)), true, 'byte fingerprints describe bytes; fresh parent validation is B2');
});

test('B1 section binding refuses getter/proxy/undefined data without invoking external code', () => {
  let reads = 0; const b = binding(); Object.defineProperty(b.source, 'projectId', { enumerable: true, get() { reads++; return project; } });
  assert.equal(valid(b, project, rid(10)), false); assert.throws(() => sectionDocuments(response(), b), { code: 'PROJECT_PAPER_SECTION_BINDING_INVALID' });
  const proxy = new Proxy(binding(), { ownKeys() { reads++; throw Error('trap'); } }); assert.equal(valid(proxy, project, rid(10)), false);
  const undef = binding(); undef.resources.style = undefined; assert.equal(valid(undef, project, rid(10)), false); assert.equal(reads, 0);
});

test('B1 section documents are deterministic detached fragment DTOs with unverified statuses', () => {
  const b = binding(), first = sectionDocuments(response(), b), second = sectionDocuments(response(), b);
  assert.deepEqual(first, second); assert.equal(first.tex, tex); assert.deepEqual(first.provenance, { 'thm:x': id(2) });
  assert.equal(first.document.kind, 'paper-section'); assert.equal(first.document.publicationStatus, 'reviewable-section'); assert.equal(first.document.sourceStatus, 'generated'); assert.equal(first.document.provenanceStatus, 'available-unverified');
  assert.equal(first.document.sectionOrdering, 'not-checked'); assert.equal(first.document.citationStatus, 'not-requested'); assert.equal(first.document.mathematicsStatus, 'unreviewed'); assert.equal(first.document.compileStatus, 'not-run');
  assert.match(first.document.limitations.join(' '), /not verified body coverage/); assert.equal(Object.hasOwn(first.document, 'coverage'), false); assert.equal(Object.hasOwn(first, 'ledger'), false);
  b.source.paperId = 'changed'; b.material.factIds.push(id(9)); assert.equal(first.document.binding.source.paperId, 'main'); assert.deepEqual(first.document.binding.material.factIds, [id(2)]);
  first.document.binding.resources.style = 'mutated'; assert.notEqual(b.resources.style, 'mutated');
});

test('B1 section documents empty-fragment delivery guard is independent of A parser/structure', () => {
  for (const raw of ['', ' \t\r\n', '%%%PROVENANCE%%%{}', '```tex\n\n```\n%%%PROVENANCE%%%{}']) assert.throws(() => sectionDocuments(raw, binding()), { code: 'PROJECT_PAPER_SECTION_OUTPUT_EMPTY' });
  const notChecked = sectionDocuments('not a document or section label%%%PROVENANCE%%%{}', binding()); assert.equal(notChecked.document.publicationStatus, 'reviewable-section');
  assert.equal(sectionDocuments(tex, binding()).document.provenanceStatus, 'missing');
  assert.equal(sectionDocuments(tex + '%%%PROVENANCE%%%[]', binding()).document.provenanceStatus, 'missing');
});

test('B1 section documents leaked output is not-ready while blockers merely flag and raw remains untouched', () => {
  const dirty = response(tex + '% ' + id(1) + '\n\\note{[math/blocker] unresolved}\n'); const saved = dirty;
  const leaked = sectionDocuments(dirty, binding()); assert.equal(leaked.document.sourceStatus, 'leaked'); assert.equal(leaked.document.publicationStatus, 'not-ready'); assert.ok(leaked.document.findings.leaks.length); assert.equal(dirty, saved);
  const flagged = sectionDocuments(response(tex + '\\note{[math/blocker] unresolved}\n[GAP: missing]\n'), binding());
  assert.equal(flagged.document.sourceStatus, 'flagged'); assert.equal(flagged.document.publicationStatus, 'reviewable-section'); assert.equal(flagged.document.findings.blockers.length, 2);
  assert.equal(sectionDocuments(response(), binding()).document.findings.leaks.length, 0, 'IDs after provenance boundary are not tex leaks');
});

test('B1 section documents diagnostics are bounded with truncation disclosed, not silently certified', () => {
  const long = '中'.repeat(1000), notes = Array.from({ length: 40 }, () => '\\note{[math/blocker] ' + long + '}\n').join('');
  const mapping = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['missing-' + i + long, id(2)]));
  const dto = sectionDocuments(response(tex + notes, mapping), binding()).document;
  assert.equal(dto.findingsTruncated, true); assert.equal(dto.sourceStatus, 'flagged');
  assert.equal(dto.findings.blockers.length, 32); assert.equal(dto.findings.warnings.length, 32);
  for (const list of Object.values(dto.findings)) for (const item of list) { assert.ok(Buffer.byteLength(item) <= 1024); assert.equal(item.isWellFormed(), true); }
});
