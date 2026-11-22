// Pure, opaque software fixtures. No writer/model or mathematical verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { capturePaperMaterial, assertPaperMaterial, validPaperMaterial, normalizePaperSelection, buildPaperPrompt, splitPaperOutput } from '../packages/hana-math/paper-source.mjs';
const id = n => n.toString(16).padStart(16, '0');
const fact = (n, predecessors = []) => ({ fact_id: id(n), predecessors,
  markdown: `---\nfact_id: ${id(n)}\npredecessors: [${predecessors.join(', ')}]\nexternal_refs: [{"key":"K${n}","title":"Reference ${n}","cited_for":"Recorded use ${n}"}]\n---\n## statement\nSTATEMENT_${n}_SENTINEL\n## proof\nPROOF_${n}_SENTINEL\n` });
const chain = size => Array.from({ length: size }, (_, i) => fact(i + 1, i ? [id(i)] : []));
const resources = { contract: 'Contract\n', writerPrompt: 'Writer\n', style: 'Style\n', structure: 'Structure\n', acknowledgement: 'Acknowledgement\n' };
const input = size => ({ facts: chain(size), target: { factIds: [id(size)] }, asOf: 'admission' });
const error = (run, code) => assert.throws(run, { code });

test('paper selection threshold is the full target closure at 9/10, and empty is exactly legacy', () => {
  assert.equal(normalizePaperSelection(undefined), null); assert.equal(normalizePaperSelection([]), null);
  for (const size of [9, 10]) {
    const args = input(size);
    if (size === 9) {
      const legacy = capturePaperMaterial(args), empty = capturePaperMaterial({ ...args, factIds: [] });
      assert.deepEqual(legacy, empty); assert.equal(legacy.material.mode, 'legacy');
      assert.equal(capturePaperMaterial({ ...args, factIds: args.facts.map(f => f.fact_id) }).writerFacts.length, 9);
    } else for (const factIds of [undefined, []]) error(() => capturePaperMaterial({ ...args, factIds }), 'PROJECT_PAPER_SELECTION_REQUIRED');
  }
  const args = input(10), full = args.facts.map(f => f.fact_id);
  for (const factIds of [full, [...full, id(11)]]) error(() => capturePaperMaterial({ ...args, facts: [...args.facts, fact(11)], factIds }), 'PROJECT_PAPER_SELECTION_FULL_CLOSURE');
  error(() => capturePaperMaterial({ ...args, factIds: [id(9)] }), 'PROJECT_PAPER_HEADLINE_NOT_SELECTED');
  error(() => capturePaperMaterial({ ...args, target: { factIds: full }, factIds: full }), 'PROJECT_PAPER_SELECTION_FULL_CLOSURE');
});

test('paper selection normalizes only empty arrays and rejects duplicates, holes, invalid shapes and limits', () => {
  for (const ids of [null, 'x', {}, [id(1), id(1)], ['A'.repeat(16)], ['bad'], new Array(1), Array.from({ length: 65 }, (_, i) => id(i))])
    error(() => normalizePaperSelection(ids), 'PROJECT_INVALID_INPUT');
  let invoked = false; const ids = [id(1)]; Object.defineProperty(ids, '0', { get() { invoked = true; return id(1); } });
  error(() => normalizePaperSelection(ids), 'PROJECT_INVALID_INPUT'); assert.equal(invoked, false);
  const exact = Array.from({ length: 64 }, (_, i) => id(i)); assert.deepEqual(normalizePaperSelection(exact), exact);
});

test('paper selection material partitions only selected full text, all union validation/ledger, with stable bounded digest', () => {
  const args = { ...input(10), facts: [...chain(10), fact(11, [id(2)])], factIds: [id(11), id(10)] };
  const result = capturePaperMaterial(args), record = result.material;
  assert.deepEqual(record.writerFactIds, [id(10), id(11)]); assert.equal(record.validationFactIds.length, 11);
  assert.deepEqual(record.outsideTargetFactIds, [id(11)]); assert.deepEqual(record.warnings, ['PROJECT_PAPER_SELECTION_OUTSIDE_TARGET']);
  assert.ok(validPaperMaterial(record, args.target, args.factIds)); assert.doesNotMatch(JSON.stringify(record), /SENTINEL|markdown|predecessors/);
  assert.deepEqual(capturePaperMaterial({ ...args, facts: [...args.facts].reverse() }).material, record);
  const paper = { target: args.target, factIds: args.factIds, material: record };
  assert.doesNotThrow(() => assertPaperMaterial({ ...args, asOf: 'unrelated graph advancement', facts: [...args.facts, fact(12)] }, paper));
  for (const n of [1, 11]) {
    const facts = structuredClone(args.facts); facts.find(f => f.fact_id === id(n)).markdown += 'changed';
    error(() => assertPaperMaterial({ ...args, facts }, paper), 'PROJECT_SUMMARY_FACT_REVOKED');
  }
  for (const patch of [{ mode: 'legacy' }, { writerFactIds: [id(10)] }, { validationFactIds: [id(11)] }, { warnings: ['arbitrary'] },
    { outsideTargetFactIds: [id(1)] }, { sha256: 'bad' }, { schemaVersion: 2 }, { proof: 'not allowed' }])
    assert.equal(validPaperMaterial({ ...record, ...patch }, args.target, args.factIds), false);
});

test('paper persisted new legacy material cannot claim ten or more facts even when its IDs/mode are otherwise consistent', () => {
  const args = input(9), legacy = capturePaperMaterial(args).material, full = chain(10).map(f => f.fact_id);
  assert.ok(validPaperMaterial(legacy, args.target));
  assert.equal(validPaperMaterial({ ...legacy, writerFactIds: full, validationFactIds: full }, args.target), false);
});

test('paper selected prompt embeds selected full bodies and citation support, never unselected statements/proofs', () => {
  const args = input(10), facts = [...args.facts, fact(11, [id(2)])];
  const prompt = buildPaperPrompt({ resources, problem: 'Problem', brief: 'Brief', instructions: 'Direction', facts,
    headlineFactIds: args.target.factIds, factIds: [id(10), id(11)] });
  for (const n of [10, 11]) { assert.ok(prompt.includes(`STATEMENT_${n}_SENTINEL`)); assert.ok(prompt.includes(`PROOF_${n}_SENTINEL`)); }
  for (let n = 1; n < 10; n++) { assert.ok(!prompt.includes(`STATEMENT_${n}_SENTINEL`)); assert.ok(!prompt.includes(`PROOF_${n}_SENTINEL`)); }
  assert.match(prompt, /BEGIN SELECTED_FACTS/); assert.doesNotMatch(prompt, /BEGIN FACT_GRAPH_CONTENT/);
  assert.match(prompt, /Reference 2/); assert.match(prompt, /Recorded use 2/); assert.match(prompt, /not permission to use unselected/);
  assert.match(prompt, /verified-by: unverified/); assert.match(prompt, /FINALIZED_HEADLINE_FACT_IDS/);
  const tex = '\\documentclass{article}\n\\begin{document}\\label{selected}\\label{unselected}Opaque\\end{document}\n%%%PROVENANCE%%%\n' + JSON.stringify({ selected: id(11), unselected: id(2) });
  const split = splitPaperOutput(tex, [id(10), id(11)]);
  assert.deepEqual(split.provenance, { selected: id(11) }); assert.ok(split.findings.warnings.some(w => w.includes('unselected')));
  assert.deepEqual(split.findings.blockers, []); assert.deepEqual(split.findings.leaks, []); assert.match(split.tex, /documentclass/);
});

test('paper legacy small prompt is byte-identical for omitted/empty selection and to the pre-selection baseline', () => {
  const args = { resources, problem: 'Problem', brief: 'Brief', instructions: 'Direction', facts: chain(2), headlineFactIds: [id(2)] };
  const prompt = buildPaperPrompt(args); assert.equal(buildPaperPrompt({ ...args, factIds: [] }), prompt);
  assert.equal(createHash('sha256').update(prompt).digest('hex'), 'b5446119880fa36fe72f4eb4650d33185a4a184af180fcae954236c437f9cc88');
});
