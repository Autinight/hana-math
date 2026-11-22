// Independent opaque software regressions only. No App/model/research or test-module imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { capturePlanMaterial } from '../packages/hana-math/paper-plan.mjs';
import { paperLedger, splitPaperOutput } from '../packages/hana-math/paper-source.mjs';
import { captureSectionMaterial, buildSectionPrompt, readSectionResources, splitSectionOutput } from '../packages/hana-math/paper-section.mjs';

const id = n => n.toString(16).padStart(16, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const node = (n, predecessors = []) => ({ fact_id: id(n), predecessors: [...predecessors],
  markdown: `---\nfact_id: ${id(n)}\npredecessors: [${predecessors.join(', ')}]\nexternal_refs: []\n---\n\n## statement\nINDEPENDENT_STATEMENT_${n}_END\n## proof\nINDEPENDENT_PROOF_${n}_END\n## intuition\nINDEPENDENT_INTUITION_${n}_END\n` });
const sec = (label, fact_ids = []) => ({ title: `Opaque ${label}`, label, fact_ids: [...fact_ids] });
const chain = length => Array.from({ length }, (_, i) => node(i + 1, i ? [id(i)] : []));
const resources = await readSectionResources();
function fixture(facts, roots, normalizedSections, sectionIndex, selected) {
  // Explicit roots avoid accidentally promoting an unrelated appended fact to target.
  const target = { schemaVersion: 1, projectId: 'independent-opaque-project', paperId: 'opaque-note', factIds: [...roots],
    factDigests: Object.fromEntries(roots.map(fid => [fid, hash(facts.find(f => f.fact_id === fid).markdown)])), finalizedBy: 'creator', at: 1 };
  const captured = capturePlanMaterial({ facts, target, factIds: selected, asOf: 'independent-original-admission' });
  const ledger = paperLedger(captured.validationFacts) + '\nOPAQUE_ARCHIVED_LEDGER_TAIL\n';
  return { resources, facts, asOf: 'independent-current-observation', normalizedSections, sectionIndex, ledger,
    parentPlan: { paperId: target.paperId, target, material: captured.material, ...(selected ? { factIds: [...selected] } : {}),
      brief: 'Opaque software section fixture, not a mathematical result.', ledgerSha256: hash(ledger) },
    blocks: { preamble: 'OPAQUE_FIXED_PREAMBLE\n', frontmatter: 'OPAQUE_FIXED_FRONTMATTER\n' } };
}
const idsOf = facts => facts.map(fact => fact.fact_id);
const fullBlock = prompt => prompt.split('===== BEGIN THIS_SECTION_FACTS (full bodies — render these) =====\n')[1].split('\n===== END THIS_SECTION_FACTS')[0];
const refBlock = prompt => prompt.split('===== BEGIN OTHER_CLOSURE_FACTS (STATEMENTS ONLY — \\ref these, never re-prove) =====\n')[1].split('\n===== END OTHER_CLOSURE_FACTS')[0];
const body = '\\section{Opaque}\\label{kept}\nOpaque software bytes.\n';
const marker = '%%%PROVENANCE%%%';

test('independent section: local complete ten is REPLAN even when it is only a proper subset of globally allowed full selection', () => {
  const facts = Array.from({ length: 11 }, (_, i) => node(i + 1));
  const roots = facts.map(f => f.fact_id);
  const a = fixture(facts, roots, [sec('local-ten', roots.slice(0, 10)), sec('remaining-one', [id(11)])], 0, roots);
  assert.equal(a.parentPlan.material.mode, 'selected');
  assert.equal(a.parentPlan.material.coverageFactIds.length, 11);
  const before = structuredClone(a);
  for (const fn of [captureSectionMaterial, buildSectionPrompt]) assert.throws(() => fn(a), { code: 'PROJECT_PAPER_SECTION_REPLAN_REQUIRED' });
  assert.deepEqual(a, before, 'local refusal cannot delete coverage or mutate the accepted global capture');
});

test('independent section: local closure ten with nine assigned is allowed and does not import the other global headline', () => {
  const a = fixture(chain(11), [id(11)], [sec('outside-local', [id(1), id(11)]), sec('nine-descendants', [id(10), id(9), id(8), id(7), id(6), id(5), id(4), id(3), id(2)])], 1);
  const captured = captureSectionMaterial(a), built = buildSectionPrompt(a);
  assert.deepEqual(captured.material.factIds, [id(10), id(9), id(8), id(7), id(6), id(5), id(4), id(3), id(2)]);
  assert.deepEqual(captured.material.localClosureFactIds, [id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8), id(9), id(10)]);
  assert.deepEqual(idsOf(captured.writerFacts), [id(10), id(9), id(8), id(7), id(6), id(5), id(4), id(3), id(2)]);
  for (const n of [10, 9, 8, 7, 6, 5, 4, 3, 2]) assert.ok(fullBlock(built.prompt).includes(`INDEPENDENT_PROOF_${n}_END`), 'no assigned body omitted: ' + n);
  assert.deepEqual(idsOf(captured.referenceFacts), [id(1)]);
  assert.match(refBlock(built.prompt), /INDEPENDENT_STATEMENT_1_END/);
  assert.doesNotMatch(built.prompt, /INDEPENDENT_PROOF_1_END|INDEPENDENT_(?:STATEMENT|PROOF|INTUITION)_11_END/);
});

function branched() {
  return fixture([node(7), node(6, [id(5)]), node(5, [id(2), id(4)]), node(4, [id(2), id(3)]), node(3, [id(1)]), node(2, [id(1)]), node(1)],
    [id(6)], [sec('global-headline', [id(6)]), sec('assigned', [id(5), id(4)])], 1, [id(6), id(5), id(4)]);
}
test('independent section: shared direct predecessors appear once, assigned predecessors stay bodies, grandparent never expands', () => {
  const a = branched(), c = captureSectionMaterial(a), p = buildSectionPrompt(a).prompt;
  assert.deepEqual(idsOf(c.writerFacts), [id(5), id(4)]);
  assert.deepEqual(idsOf(c.referenceFacts), [id(2), id(3)]);
  assert.deepEqual(c.material.localClosureFactIds, [id(1), id(2), id(3), id(4), id(5)]);
  for (const n of [5, 4]) assert.ok(fullBlock(p).includes(`## statement\nINDEPENDENT_STATEMENT_${n}_END\n## proof\nINDEPENDENT_PROOF_${n}_END\n## intuition\nINDEPENDENT_INTUITION_${n}_END\n`), 'entire assigned body retained: ' + n);
  assert.ok(fullBlock(p).indexOf('INDEPENDENT_PROOF_5_END') < fullBlock(p).indexOf('INDEPENDENT_PROOF_4_END'));
  assert.equal(refBlock(p).split('INDEPENDENT_STATEMENT_2_END').length - 1, 1);
  assert.match(refBlock(p), /INDEPENDENT_STATEMENT_3_END/);
  assert.doesNotMatch(refBlock(p), /INDEPENDENT_(?:PROOF|INTUITION)_|INDEPENDENT_STATEMENT_[14567]_END/);
  assert.doesNotMatch(p, /INDEPENDENT_(?:STATEMENT|PROOF|INTUITION)_[167]_END/);
});

test('independent section: reversing only assigned order changes local hash/body order, not original parent hash or shared-ref order', () => {
  const a = branched(), original = structuredClone(a.parentPlan), first = captureSectionMaterial(a);
  const reversed = { ...a, normalizedSections: [a.normalizedSections[0], sec('assigned', [id(4), id(5)])] };
  const second = captureSectionMaterial(reversed), firstPrompt = buildSectionPrompt(a), secondPrompt = buildSectionPrompt(reversed);
  assert.deepEqual(second.material.factIds, [id(4), id(5)]);
  assert.deepEqual(first.material.referenceFactIds, [id(2), id(3)]); assert.deepEqual(second.material.referenceFactIds, [id(2), id(3)]);
  assert.notEqual(first.material.sha256, second.material.sha256);
  assert.notEqual(firstPrompt.hashes.promptSha256, secondPrompt.hashes.promptSha256);
  assert.equal(first.material.parentMaterialSha256, second.material.parentMaterialSha256);
  assert.ok(fullBlock(secondPrompt.prompt).indexOf('INDEPENDENT_PROOF_4_END') < fullBlock(secondPrompt.prompt).indexOf('INDEPENDENT_PROOF_5_END'));
  assert.deepEqual(a.parentPlan, original);
});

test('independent section: empty editorial fact blocks coexist with shared abstract math and are not a no-mathematics certificate', () => {
  const a = fixture([node(1)], [id(1)], [sec('editorial'), sec('result', [id(1)])], 0);
  a.blocks.frontmatter = 'SHARED_ABSTRACT_MATH_SENTINEL \\(\\mathcal{Q}_{\\mathrm{opaque}}\\) is a placeholder, not a result.\n';
  const built = buildSectionPrompt(a), c = captureSectionMaterial(a);
  assert.deepEqual(c.writerFacts, []); assert.deepEqual(c.referenceFacts, []); assert.deepEqual(c.localClosureFacts, []);
  assert.equal(fullBlock(built.prompt), '_(this section has no assigned facts — write only its prose)_\n');
  assert.equal(refBlock(built.prompt), '_(no other closure facts)_\n');
  assert.match(built.prompt, /SHARED_ABSTRACT_MATH_SENTINEL/); assert.doesNotMatch(built.prompt, /INDEPENDENT_(?:STATEMENT|PROOF|INTUITION)_/);
  assert.match(built.prompt, /does not certify semantic fidelity/);
  const mathBytes = 'Opaque editorial \\(Q_{\\mathrm{opaque}}\\).\n';
  const parsed = splitSectionOutput(mathBytes + marker + '{}', []);
  assert.equal(parsed.tex, mathBytes); assert.deepEqual(parsed.provenance, {});
  assert.deepEqual(parsed.findings, { leaks: [], blockers: [], warnings: [] }, 'text diagnostics are not a semantic math detector');
});

test('independent section: first literal marker inside a TeX comment wins before fence stripping and a later good marker cannot recover mapping', () => {
  const source = '```tex\n\\label{kept}\n% left: ' + marker + 'broken\n```\n' + marker + '{"kept":"' + id(1) + '"}';
  const parsed = splitSectionOutput(source, [id(1)]);
  assert.equal(parsed.tex, '\\label{kept}\n% left: \n');
  assert.equal(parsed.provenance, null);
  assert.deepEqual(parsed.findings.warnings, ['provenance JSON missing, malformed, or not an object; no mapping accepted']);
});

test('independent section: long odd/even slash runs and later percent comments match no-fence single-paper label/blocker behavior', () => {
  // Literal expected visibility, not a second implementation of the slash scanner.
  const rows = [[0, false], [1, true], [2, false], [3, true], [4, false], [7, true], [8, false], [15, true], [16, false], [63, true], [64, false], [255, true], [256, false]];
  for (const [slashes, visible] of rows) {
    const tex = '\\documentclass{amsart}\n\\begin{document}\n' + '\\'.repeat(slashes) + '% \\label{after}\\note{[fixture/blocker] parity}\r\n\\label{kept}\n\\% \\label{escaped} % \\label{later-hidden}\n\\end{document}\n';
    const source = tex + marker + JSON.stringify({ after: id(1), kept: id(1), escaped: id(1), 'later-hidden': id(1) });
    const section = splitSectionOutput(source, [id(1)]), paper = splitPaperOutput(source, [id(1)]);
    const expected = visible ? { after: id(1), kept: id(1), escaped: id(1) } : { kept: id(1), escaped: id(1) };
    assert.equal(section.tex, tex, 'slash run ' + slashes); assert.equal(paper.tex, tex);
    assert.deepEqual(section.provenance, expected, 'slash run ' + slashes); assert.deepEqual(paper.provenance, expected);
    assert.deepEqual(section.findings, paper.findings, 'no legacy finding drift at slash run ' + slashes);
    assert.deepEqual(section.findings.blockers, visible ? ['fixture/blocker parity'] : []);
  }
});

test('independent section: Python edge whitespace, escaped duplicate keys and quoted/nonfinite tokens retain last-key tolerant semantics', () => {
  const pythonEdges = '\x1c\x1d\x1e\x1f\x85\u2007\u202f\u3000';
  const tex = '\\label{kept}\n\\label{NaN}\nOpaque bytes.\n';
  const raw = '{"kept":"bad","k\\u0065pt":"' + id(1) + '","NaN":"' + id(1) + '","nan":NaN,"inf":Infinity,"negative":-Infinity,"quoted":"NaN","nested":{"number":NaN}}';
  const parsed = splitSectionOutput(tex + marker + pythonEdges + raw + pythonEdges, [id(1)]);
  assert.equal(parsed.tex, tex); assert.deepEqual(parsed.provenance, { kept: id(1), NaN: id(1) });
  assert.equal(parsed.findings.warnings.length, 5);
  const lastInvalid = splitSectionOutput(tex + marker + '{"kept":"' + id(1) + '","k\\u0065pt":Infinity}', [id(1)]);
  assert.equal(lastInvalid.tex, tex); assert.deepEqual(lastInvalid.provenance, {});
  assert.deepEqual(lastInvalid.findings.warnings, ['invalid provenance entry omitted: "kept"']);
});

test('independent section: interior Python-only whitespace, BOM, fenced or multi-marker provenance fails only mapping, never retained body/blockers', () => {
  const tex = body + '\\note{[fixture/blocker] remain}\n[GAP: unchanged]\n';
  const tails = ['{"kept":\x85"' + id(1) + '"}', '\ufeff{}', '```json\n{}\n```', '{"kept":"' + id(1) + '"}' + marker + '{}', '{"kept":NaN,}', '[{}]', 'true'];
  for (const tail of tails) {
    const parsed = splitSectionOutput(tex + marker + tail, [id(1)]);
    assert.equal(parsed.tex, tex, JSON.stringify(tail)); assert.equal(parsed.provenance, null, JSON.stringify(tail));
    assert.deepEqual(parsed.findings.blockers, ['fixture/blocker remain', '[GAP: unchanged]']);
    assert.deepEqual(parsed.findings.warnings, ['provenance JSON missing, malformed, or not an object; no mapping accepted']);
  }
});

test('independent section: unrelated valid descendant/side graph changes and asOf advance leave original capture/local hash/prompt unchanged', () => {
  const a = fixture(chain(4), [id(4)], [sec('support', [id(1), id(2), id(3)]), sec('current', [id(4)])], 1);
  const originalParent = structuredClone(a.parentPlan), original = captureSectionMaterial(a), prompt = buildSectionPrompt(a);
  const advanced = { ...a, asOf: 'later-unrelated-graph-observation', facts: [...a.facts, node(20, [id(4)]), node(21, [id(20)]), node(22)].reverse() };
  assert.deepEqual(captureSectionMaterial(advanced), original);
  assert.deepEqual(buildSectionPrompt(advanced), prompt);
  advanced.facts = [...a.facts, node(20, [id(22)]), node(21, [id(20), id(4)]), node(22)].reverse();
  assert.deepEqual(captureSectionMaterial(advanced), original);
  assert.deepEqual(buildSectionPrompt(advanced), prompt);
  assert.equal(a.parentPlan.material.admissionAsOf, 'independent-original-admission'); assert.deepEqual(a.parentPlan, originalParent);
});

test('independent section: validation-only grandparent proof drift still rejects an empty local section without resampling or overwriting admission', () => {
  const a = fixture(chain(4), [id(4)], [sec('editorial'), sec('only-covered-result', [id(4)])], 0, [id(4)]);
  assert.deepEqual(a.parentPlan.material.coverageFactIds, [id(4)]);
  const original = structuredClone(a.parentPlan), capture = captureSectionMaterial(a);
  assert.deepEqual(capture.material.factIds, []); assert.deepEqual(capture.material.localClosureFactIds, []);
  for (const asOf of [a.asOf, 'later-after-drift']) {
    const facts = structuredClone(a.facts); facts[0].markdown += 'OPAQUE_VALIDATION_ONLY_PROOF_DRIFT\n';
    const changed = { ...a, facts, asOf };
    for (const fn of [captureSectionMaterial, buildSectionPrompt]) assert.throws(() => fn(changed), { code: 'PROJECT_SUMMARY_FACT_REVOKED' });
    assert.deepEqual(a.parentPlan, original, 'rejected drift must not become a new accepted capture');
  }
  assert.deepEqual(captureSectionMaterial(a), capture, 'unmodified original still works after refused observations');
});
