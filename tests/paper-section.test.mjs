// Pure opaque software fixtures. No lifecycle, API, Python, model or compilation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { capturePlanMaterial, normalizePlanCoverage } from '../packages/hana-math/paper-plan.mjs';
import { paperLedger, paperFactBody, paperTextFindings, buildPaperPrompt, splitPaperOutput } from '../packages/hana-math/paper-source.mjs';
import { captureSectionMaterial, buildSectionPrompt, readSectionResources, splitSectionOutput } from '../packages/hana-math/paper-section.mjs';
const id = n => n.toString(16).padStart(16, '0');
const hash = x => createHash('sha256').update(x).digest('hex');
const fact = (n, predecessors = [], body = `## statement\nStatementSentinel_${n}\n## proof\nProofSentinel_${n}\n## intuition\nIntuitionSentinel_${n}\n`) => ({ fact_id: id(n), predecessors: [...predecessors],
  markdown: `---\nfact_id: ${id(n)}\nauthor: PRIVATE_AUTHOR\npredecessors: [${predecessors.join(', ')}]\nexternal_refs: [{"key":"K${n}","title":"Reference ${n}"}]\n---\n\n${body}` });
const chain = n => Array.from({ length: n }, (_, i) => fact(i + 1, i ? [id(i)] : []));
const sec = (label, fact_ids = [], title = label) => ({ title, label, fact_ids: [...fact_ids] });
const resources = await readSectionResources();
function setup(facts = chain(4), roots = [facts.at(-1).fact_id], factIds) {
  const target = { schemaVersion: 1, projectId: 'opaque', paperId: 'opaque', factIds: [...roots], finalizedBy: 'creator', at: 1, factDigests: Object.fromEntries(roots.map(fid => [fid, hash(facts.find(f => f.fact_id === fid).markdown)])) };
  const material = capturePlanMaterial({ facts, target, factIds, asOf: 'original-admission' }).material;
  // Deliberately differs from a newly seeded ledger: it MUST survive unchanged.
  const ledger = paperLedger(facts.filter(f => material.validationFactIds.includes(f.fact_id))) + '\nARCHIVED_LEDGER_ANNOTATION\r\n';
  const parentPlan = { paperId: 'opaque', target, material, brief: 'Opaque parent brief.', instructions: 'MUST_NOT_EMBED_INSTRUCTIONS', ...(factIds ? { factIds } : {}), ledgerSha256: hash(ledger) };
  return { resources, facts, asOf: 'current-snapshot', parentPlan, normalizedSections: [sec('sec:support', material.coverageFactIds.slice(0, -1)), sec('sec:current', material.coverageFactIds.slice(-1))], sectionIndex: 1,
    blocks: { preamble: 'FIXED_PREAMBLE\n\n', frontmatter: 'FIXED_FRONTMATTER\n\n', sections: 'RAW_PLANNER_SECTIONS_MUST_NOT_EMBED', bibliography: 'BIBLIOGRAPHY_BODY_MUST_NOT_EMBED' }, ledger };
}
const badInput = run => assert.throws(run, { code: 'PROJECT_PAPER_SECTION_INVALID_INPUT' });
const badOutput = run => assert.throws(run, { code: 'PROJECT_PAPER_SECTION_INVALID_OUTPUT' });
const body = '\\section{Opaque}\\label{sec:x}\n\\label{thm:x}\nOpaque bytes.\n';
const response = (tex = body, provenance = { 'thm:x': id(4) }) => tex + '%%%PROVENANCE%%%\n' + JSON.stringify(provenance);
const idsOf = facts => facts.map(f => f.fact_id);

test('section empty assigned is legal, has both upstream sentinels and no local material', () => {
  const a = setup(); a.normalizedSections.unshift(sec('sec:editorial')); a.sectionIndex = 0;
  const before = structuredClone(a), captured = captureSectionMaterial(a), built = buildSectionPrompt(a);
  assert.deepEqual(captured.writerFacts, []); assert.deepEqual(captured.referenceFacts, []); assert.deepEqual(captured.localClosureFacts, []);
  assert.deepEqual(captured.material.factIds, []); assert.deepEqual(captured.material.localClosureFactIds, []);
  assert.ok(built.prompt.includes('_(this section has no assigned facts — write only its prose)_\n'));
  assert.ok(built.prompt.includes('_(no other closure facts)_\n')); assert.doesNotMatch(built.prompt, /StatementSentinel|ProofSentinel|IntuitionSentinel/);
  assert.match(built.prompt, /editorial prose only: do not invent mathematics or citations/); assert.deepEqual(a, before);
});

test('section assigned independent fact has empty reference sentinel, not empty full-body sentinel', () => {
  const a = setup([fact(1)]); const built = buildSectionPrompt(a), c = captureSectionMaterial(a);
  assert.deepEqual(idsOf(c.writerFacts), [id(1)]); assert.deepEqual(idsOf(c.localClosureFacts), [id(1)]); assert.deepEqual(c.referenceFacts, []);
  assert.match(built.prompt, /ProofSentinel_1/); assert.ok(built.prompt.includes('_(no other closure facts)_\n'));
  assert.ok(!built.prompt.includes('_(this section has no assigned facts'));
});

test('section local full-closure policy allows independent 9 but refuses independent 10 without editing plan', () => {
  for (const count of [9, 10]) {
    const facts = Array.from({ length: count }, (_, i) => fact(i + 1)); const a = setup(facts, idsOf(facts));
    a.normalizedSections = [sec('sec:all', idsOf(facts))]; a.sectionIndex = 0; const before = structuredClone(a);
    if (count === 9) assert.equal(captureSectionMaterial(a).localClosureFacts.length, 9);
    else assert.throws(() => captureSectionMaterial(a), { code: 'PROJECT_PAPER_SECTION_REPLAN_REQUIRED' });
    assert.deepEqual(a, before);
  }
});

test('section large global closure is not a local rejection and sections need not contain global headlines', () => {
  const a = setup(chain(18)); a.normalizedSections = [sec('sec:first', a.parentPlan.material.coverageFactIds.slice(0, 9)), sec('sec:second', a.parentPlan.material.coverageFactIds.slice(9))];
  a.sectionIndex = 0; assert.equal(captureSectionMaterial(a).writerFacts.length, 9);
  assert.ok(!captureSectionMaterial(a).material.factIds.includes(a.parentPlan.target.factIds[0]));
  a.sectionIndex = 1; const c = captureSectionMaterial(a); assert.equal(c.writerFacts.length, 9); assert.equal(c.localClosureFacts.length, 18);
  assert.deepEqual(idsOf(c.referenceFacts), [id(9)]); buildSectionPrompt(a);
});

test('section 64 assigned budget is inclusive, 65 is refused even when closure policy would allow it', () => {
  const a = setup(chain(66));
  for (const n of [64, 65]) {
    const coverage = a.parentPlan.material.coverageFactIds;
    a.normalizedSections = [sec('sec:other', coverage.slice(0, -n)), sec('sec:current', coverage.slice(-n))];
    if (n === 64) assert.equal(captureSectionMaterial(a).writerFacts.length, 64); else badInput(() => captureSectionMaterial(a));
  }
});

test('section assigned order is exact, full bodies keep line endings and never expand to ancestor bodies', () => {
  const a = setup(chain(5)); a.normalizedSections = [sec('sec:other', [id(1), id(3), id(4)]), sec('sec:current', [id(5), id(2)])];
  const before = structuredClone(a), c = captureSectionMaterial(a), built = buildSectionPrompt(a);
  assert.deepEqual(idsOf(c.writerFacts), [id(5), id(2)]); assert.deepEqual(c.material.factIds, [id(5), id(2)]);
  assert.ok(built.prompt.indexOf('ProofSentinel_5') < built.prompt.indexOf('ProofSentinel_2'));
  for (const n of [1, 3, 4]) assert.ok(!built.prompt.includes(`ProofSentinel_${n}`));
  const f = fact(1, [], '## statement\r\nOpaque.\r\n\r\n## proof\r\n  exact tail.  \r\n\r\n');
  f.markdown = f.markdown.slice(0, f.markdown.indexOf('## statement')).replace(/\n/g, '\r\n') + paperFactBody(f);
  const b = setup([f]); assert.ok(buildSectionPrompt(b).prompt.includes(paperFactBody(f)));
  assert.doesNotMatch(built.prompt, /PRIVATE_AUTHOR|author: PRIVATE/); assert.deepEqual(a, before);
});

test('section direct refs exclude grandparent and unrelated statements, proofs and intuition', () => {
  const a = setup([...chain(4), fact(5)], [id(4)]); const c = captureSectionMaterial(a), built = buildSectionPrompt(a);
  assert.deepEqual(idsOf(c.referenceFacts), [id(3)]); assert.deepEqual(idsOf(c.localClosureFacts), [id(1), id(2), id(3), id(4)]);
  assert.match(built.prompt, /StatementSentinel_3/); assert.match(built.prompt, /ProofSentinel_4/);
  assert.doesNotMatch(built.prompt, /StatementSentinel_[125]|ProofSentinel_[1235]|IntuitionSentinel_[1235]/);
  const self = setup(chain(2)); self.normalizedSections = [sec('sec:all', [id(2), id(1)])]; self.sectionIndex = 0;
  assert.deepEqual(captureSectionMaterial(self).referenceFacts, []);
});

test('section direct refs order is parent coverage followed by coverage external direct predecessors', () => {
  const facts = [fact(1, [id(2)]), fact(2), fact(3), fact(4, [id(6), id(1), id(2), id(3)]), fact(6, [id(7)]), fact(7)];
  const a = setup(facts, [id(4)], [id(4), id(3), id(1)]);
  a.normalizedSections = [sec('sec:other', [id(1), id(3)]), sec('sec:current', [id(4)])];
  assert.deepEqual(a.parentPlan.material.coverageFactIds, [id(3), id(1), id(4)]);
  assert.deepEqual(idsOf(captureSectionMaterial(a).referenceFacts), [id(3), id(1), id(2), id(6)]);
  const p = buildSectionPrompt(a).prompt;
  assert.doesNotMatch(p, /StatementSentinel_7|ProofSentinel_[12367]/);
});

test('section external direct refs use parent validation sorted-pass topology, not numeric/predecessor order', () => {
  const a = setup([fact(1, [id(6)]), fact(3), fact(4, [id(1), id(3)]), fact(6)], [id(4)], [id(4)]);
  assert.deepEqual(a.parentPlan.material.validationFactIds, [id(3), id(6), id(1), id(4)]);
  assert.deepEqual(idsOf(captureSectionMaterial(a).referenceFacts), [id(3), id(1)]);
  assert.doesNotMatch(buildSectionPrompt(a).prompt, /StatementSentinel_6|ProofSentinel_[136]/);
});

test('section normalized coverage is exact-once globally: no repair, extras, duplicates or omitted facts', () => {
  const a = setup();
  for (const sections of [[sec('s', [id(1), id(2), id(4)])], [sec('s', [id(1), id(2), id(3), id(4), id(5)])],
    [sec('s', [id(1), id(2), id(3), id(4), id(4)])], [sec('s', [id(1), id(2)]), sec('t', [id(2), id(3), id(4)])]]) badInput(() => captureSectionMaterial({ ...a, normalizedSections: sections }));
  const b = setup([fact(1), fact(2, [id(1)])], [id(2)], [id(2)]);
  badInput(() => captureSectionMaterial({ ...b, normalizedSections: [sec('s', [id(1), id(2)])], sectionIndex: 0 }));
});

test('section normalized structure, label uniqueness, safe index and 4096 UTF8 fields are guarded', () => {
  const a = setup([fact(1)]), valid = [sec('s', [id(1)])];
  for (const sectionIndex of [-1, 1, 0.5, NaN, Infinity, '0', null, 2 ** 53]) badInput(() => captureSectionMaterial({ ...a, normalizedSections: valid, sectionIndex }));
  for (const s of [null, { title: 'x', label: 's' }, { ...valid[0], extra: true }, { ...valid[0], fact_ids: null }, { ...valid[0], title: '' }, { ...valid[0], label: '\x85' }, { ...valid[0], title: '\ud800' }, { ...valid[0], label: 's\0' }, { ...valid[0], title: '中'.repeat(1366) }]) badInput(() => captureSectionMaterial({ ...a, normalizedSections: [s], sectionIndex: 0 }));
  badInput(() => captureSectionMaterial({ ...a, normalizedSections: [valid[0], sec('s')], sectionIndex: 0 }));
  assert.equal(captureSectionMaterial({ ...a, normalizedSections: [sec('l'.repeat(4096), [id(1)], '中'.repeat(1365) + 'x')], sectionIndex: 0 }).writerFacts.length, 1);
  badInput(() => captureSectionMaterial({ ...a, normalizedSections: [sec('l'.repeat(4097), [id(1)])], sectionIndex: 0 }));
});

test('section accepts actual 128-plus-one coverage repair, rejects zero or 130 normalized sections', () => {
  const a = setup([fact(1)]), repaired = normalizePlanCoverage(Array.from({ length: 128 }, (_, i) => sec(`s:${i}`)), [id(1)]).normalized;
  assert.equal(repaired.length, 129); a.normalizedSections = repaired; a.sectionIndex = 128;
  assert.deepEqual(captureSectionMaterial(a).material.factIds, [id(1)]);
  badInput(() => captureSectionMaterial({ ...a, normalizedSections: [] }));
  badInput(() => captureSectionMaterial({ ...a, normalizedSections: [...repaired, sec('s:extra')] }));
  badInput(() => captureSectionMaterial({ ...a, sectionIndex: 129 }));
});

test('section parent capture drift includes unused ancestor proofs; current asOf never overwrites admission', () => {
  const a = setup(), before = structuredClone(a.parentPlan), first = captureSectionMaterial(a);
  const next = captureSectionMaterial({ ...a, asOf: 'later-snapshot', facts: [...a.facts].reverse() });
  assert.deepEqual(next, first); assert.equal(a.parentPlan.material.admissionAsOf, 'original-admission'); assert.deepEqual(a.parentPlan, before);
  const drift = structuredClone(a); drift.facts[0].markdown += 'PROOF_DRIFT';
  assert.throws(() => captureSectionMaterial(drift), { code: 'PROJECT_SUMMARY_FACT_REVOKED' });
  const parentDrift = structuredClone(a); parentDrift.parentPlan.material.sha256 = 'f'.repeat(64);
  assert.throws(() => captureSectionMaterial(parentDrift), { code: 'PROJECT_SUMMARY_FACT_REVOKED' });
  const side = setup([...chain(4), fact(5)], [id(4)]); side.facts.at(-1).markdown += 'UNRELATED_CHANGE'; captureSectionMaterial(side);
});

test('section deterministic material hash binds index/title/label/assigned order/local refs/parent capture', () => {
  const a = setup(), c = captureSectionMaterial(a), { sha256, ...payload } = c.material;
  assert.equal(sha256, hash(JSON.stringify(payload))); assert.equal(payload.parentMaterialSha256, a.parentPlan.material.sha256);
  assert.equal(captureSectionMaterial(a).material.sha256, sha256); assert.doesNotMatch(JSON.stringify(c.material), /markdown|ProofSentinel/);
  const b = structuredClone(a); b.normalizedSections[1].title += ' changed'; assert.notEqual(captureSectionMaterial(b).material.sha256, sha256);
  const d = structuredClone(a); d.facts[0].markdown += 'CHANGED_PARENT_CAPTURE'; d.parentPlan.material = capturePlanMaterial({ facts: d.facts, target: d.parentPlan.target, asOf: 'new-admission' }).material;
  assert.notEqual(captureSectionMaterial(d).material.sha256, sha256);
});

test('section four original bundled resources match fixed pins, are verbatim and do not include ack', async () => {
  const files = { contract: ['roles/AGENTS.md', 'a488190965c1495a82e44db27474e330cdaff475b2daf054ef1ff3404e0de596'], sectionWriterPrompt: ['roles/PAPER_SECTION_WRITER_PROMPT.md', 'cc59e6106754fc9147cf98a950010efef85f45b4aac062dbf403b7820772d5d6'], style: ['style/STYLE_GUIDE.md', '9dfd559f95104d3297250584a86adfab40f5412d09abf718355b50cb8e485750'], structure: ['style/PAPER_STRUCTURE.md', '61d377ae07a94e41c55d3476c99e6809fd784395f9ea474f239620c2decd3314'] };
  assert.deepEqual(Object.keys(resources), Object.keys(files));
  for (const [k, [p, sha]] of Object.entries(files)) { assert.equal(resources[k], await fs.readFile(new URL('../packages/hana-math/references/danus/agents/skills/write-paper/' + p, import.meta.url), 'utf8')); assert.equal(hash(resources[k]), sha); }
  assert.deepEqual(await readSectionResources(), resources);
});

test('section missing/modified resources refuse without editing originals or using fallbacks', async t => {
  const original = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (...args) => { if (String(args[0]).endsWith('/roles/PAPER_SECTION_WRITER_PROMPT.md')) throw Object.assign(Error('fixture missing'), { code: 'ENOENT' }); return original(...args); });
  await assert.rejects(readSectionResources(), { code: 'PROJECT_PAPER_RESOURCE_MISSING' });
  t.mock.restoreAll();
  t.mock.method(fs, 'readFile', async (...args) => String(args[0]).endsWith('/roles/PAPER_SECTION_WRITER_PROMPT.md') ? 'MUTATED' : original(...args));
  await assert.rejects(readSectionResources(), { code: 'PROJECT_PAPER_SECTION_RESOURCE_INVALID' });
});

test('section prompt pins every supplied resource too and refuses missing/extra/altered inputs', () => {
  for (const key of Object.keys(resources)) {
    const a = setup(); a.resources = { ...resources, [key]: resources[key] + 'CHANGED' };
    assert.throws(() => buildSectionPrompt(a), { code: 'PROJECT_PAPER_SECTION_RESOURCE_INVALID' });
  }
  for (const r of [{}, { ...resources, acknowledgement: 'NO' }]) assert.throws(() => buildSectionPrompt({ ...setup(), resources: r }), { code: 'PROJECT_PAPER_SECTION_RESOURCE_INVALID' });
});

test('section prompt binds archived ledger, fixed blocks, ordered normalized titles/labels and exact hashes', () => {
  const a = setup(); const before = structuredClone(a), p = buildSectionPrompt(a);
  assert.equal(p.ledger, a.ledger); assert.ok(p.prompt.includes(a.ledger)); assert.match(p.prompt, /ARCHIVED_LEDGER_ANNOTATION/);
  for (const value of Object.values(resources)) assert.ok(p.prompt.includes(value));
  assert.ok(p.prompt.includes('FIXED_PREAMBLE\n\nFIXED_FRONTMATTER\n'));
  assert.ok(p.prompt.includes('1. \\section{sec:support}  ->  \\label{sec:support}\n2. \\section{sec:current}  ->  \\label{sec:current}'));
  assert.ok(p.prompt.includes('Write \\section{sec:current}\\label{sec:current} and its body.'));
  assert.doesNotMatch(p.prompt, /BEGIN (?:PROBLEM|MAIN_AGENT_INSTRUCTIONS|FINALIZED_HEADLINE_FACT_IDS|ACKNOWLEDGEMENT)|MUST_NOT_EMBED_INSTRUCTIONS|BIBLIOGRAPHY_BODY_MUST_NOT_EMBED|RAW_PLANNER_SECTIONS_MUST_NOT_EMBED/);
  assert.equal(p.hashes.promptSha256, hash(p.prompt)); assert.equal(p.hashes.ledgerSha256, a.parentPlan.ledgerSha256);
  assert.deepEqual(p.hashes.resources, Object.fromEntries(Object.entries(resources).map(([k, v]) => [k, hash(v)])));
  assert.deepEqual(p.material, captureSectionMaterial(a).material); assert.deepEqual(a, before);
  for (const change of [{ ledger: a.ledger + ' changed' }, { parentPlan: { ...a.parentPlan, ledgerSha256: 'bad' } }]) assert.throws(() => buildSectionPrompt({ ...a, ...change }), { code: 'PROJECT_PAPER_SECTION_BINDING_CHANGED' });
});

test('section prompt says explicit phase2, truthful independent resource limits and no automatic-trigger claim', () => {
  const p = buildSectionPrompt(setup()).prompt;
  assert.match(p, /explicitly requested phase 2 single-section call/); assert.match(p, /NOT evidence.*800000-character automatic chunk trigger/);
  assert.match(p, /prompt at 512 KiB/); assert.match(p, /finalText limit is 512 KiB; oversized finalText is rejected, not truncated/);
  assert.match(p, /separate parser\/artifact guard is 2 MiB, not a usable session output allowance/);
  assert.match(p, /does not certify semantic fidelity/);
});

test('section prompt 512 KiB UTF8 cap is inclusive and independent of the output parser cap', () => {
  const a = setup(), base = buildSectionPrompt(a).prompt;
  a.ledger += 'x'.repeat(512 * 1024 - Buffer.byteLength(base)); a.parentPlan.ledgerSha256 = hash(a.ledger);
  assert.equal(Buffer.byteLength(buildSectionPrompt(a).prompt), 512 * 1024);
  a.ledger += 'x'; a.parentPlan.ledgerSha256 = hash(a.ledger);
  assert.throws(() => buildSectionPrompt(a), { code: 'PROJECT_SUMMARY_INPUT_TOO_LARGE' });
});

test('section malformed Unicode/NUL inputs are explicit Hana guards', () => {
  for (const bad of ['bad\0text', 'bad\ud800text']) {
    const a = setup(); a.parentPlan.brief = bad; badInput(() => buildSectionPrompt(a));
    const b = setup(); b.blocks.frontmatter = bad; badInput(() => buildSectionPrompt(b));
    const c = setup(); c.facts[3].markdown += bad; c.parentPlan.material = capturePlanMaterial({ facts: c.facts, asOf: c.asOf, target: c.parentPlan.target }).material; badInput(() => captureSectionMaterial(c));
    const d = setup(); d.ledger = bad; d.parentPlan.ledgerSha256 = hash(bad); badInput(() => buildSectionPrompt(d));
  }
});

test('section output uses first provenance marker, preserves body, and is not a document checker', () => {
  const p = splitSectionOutput(response(), [id(4)]); assert.equal(p.tex, body); assert.deepEqual(p.provenance, { 'thm:x': id(4) }); assert.deepEqual(p.findings, { leaks: [], blockers: [], warnings: [] });
  const two = splitSectionOutput(response() + '\n%%%PROVENANCE%%%\n{}', [id(4)]); assert.equal(two.tex, body); assert.equal(two.provenance, null);
  const inline = splitSectionOutput('RAW%%%PROVENANCE%%%{}', []); assert.equal(inline.tex, 'RAW'); assert.deepEqual(inline.provenance, {}); assert.deepEqual(inline.findings.warnings, []);
  const noStructure = splitSectionOutput(response('no section label, not a document', {}), []); assert.deepEqual(noStructure.findings.warnings, []);
});

test('section strips fence from tex ONLY after splitting, unlike original whole-output paper parser', () => {
  const p = splitSectionOutput('```tex\n' + body + '```\n%%%PROVENANCE%%%\n{"thm:x":"' + id(4) + '"}', [id(4)]);
  assert.equal(p.tex, body); assert.deepEqual(p.provenance, { 'thm:x': id(4) });
  const whole = '```tex\n' + response() + '\n```';
  assert.equal(splitSectionOutput(whole, [id(4)]).provenance, null);
  assert.deepEqual(splitPaperOutput(whole, [id(4)]).provenance, { 'thm:x': id(4) });
});

test('section upstream fence exact regex/LF/Python rstrip details are preserved', () => {
  const cases = [['\nRAW \r\n', '\nRAW \r\n'], ['\n```tex\nBODY \t\n```\t \n', 'BODY \t\n'], ['```tex\r\nB\r\n```', '```tex\r\nB\r\n```'], ['```tex foo\nB\n```', '```tex foo\nB\n```'], ['```tex+\t\nB\r\n```', 'B\r\n'], ['```tex\nBODY\n\n', 'BODY\n'], ['```tex\n', '```tex\n'], ['```tex\nBODY\n```\x85', 'BODY\n'], ['```tex\nBODY\n```\ufeff', 'BODY\n```\ufeff\n'], ['```\nBODY\n```', 'BODY\n']];
  for (const [raw, expected] of cases) assert.equal(splitSectionOutput(raw, []).tex, expected, JSON.stringify(raw));
});

test('section missing/malformed/non-object provenance is null with warning and body remains available', () => {
  for (const tail of ['', 'not JSON', '[]', 'null', '1', '"string"', '{broken}']) {
    const p = splitSectionOutput(body + '%%%PROVENANCE%%%' + tail, [id(4)]); assert.equal(p.tex, body); assert.equal(p.provenance, null); assert.match(p.findings.warnings.join(' '), /malformed, or not an object/);
  }
  const missing = splitSectionOutput(body, [id(4)]); assert.equal(missing.tex, body); assert.equal(missing.provenance, null); assert.deepEqual(missing.findings.warnings, ['provenance marker missing; output retained as tex']);
  assert.deepEqual(splitSectionOutput(body + '%%%PROVENANCE%%%\x85{}\x1f', []).provenance, {});
  assert.equal(splitSectionOutput(body + '%%%PROVENANCE%%%\ufeff{}', []).provenance, null);
});

test('section provenance accepts only actual uncommented body labels and assigned IDs, with omission warnings', () => {
  const tex = body + '% \\label{commented}\n\\label{other}\n';
  const p = splitSectionOutput(response(tex, { 'thm:x': id(4), other: id(3), commented: id(4), absent: id(4), 'sec:x': 'bad' }), [id(4)]);
  assert.deepEqual(p.provenance, { 'thm:x': id(4) }); assert.equal(p.findings.warnings.length, 4);
  const special = splitSectionOutput(response('\\label{__proto__}', JSON.parse('{"__proto__":"' + id(4) + '"}')), [id(4)]);
  assert.deepEqual(Object.keys(special.provenance), ['__proto__']); assert.equal(Object.getPrototypeOf(special.provenance), Object.prototype);
  const percents = '\\% \\label{visible}\n\\\\% \\label{hidden}\n';
  const q = splitSectionOutput(response(percents, { visible: id(4), hidden: id(4) }), [id(4)]); assert.deepEqual(q.provenance, { visible: id(4) });
});

test('section Python JSON last-duplicate semantics/nonfinite values do not bypass allowed mapping gates', () => {
  const p = splitSectionOutput(body + '%%%PROVENANCE%%%{"thm:x":"bad","thm:x":"' + id(4) + '","ignored":NaN}', [id(4)]);
  assert.deepEqual(p.provenance, { 'thm:x': id(4) }); assert.equal(p.findings.warnings.length, 1);
});

test('section shared five leak gates and uncommented blocker/GAP scan match old paper text findings', () => {
  const dirty = body + id(1) + '\nfact_fixture fact_submit master_guidance\nauthor: private\n% \\note{[math/blocker] hidden}\n\\note{[cite/blocker] visible}\n[GAP: visible]\n% [GAP: hidden]\n';
  const p = splitSectionOutput(response(dirty, {}), []), shared = paperTextFindings(dirty);
  assert.equal(p.findings.leaks.length, 5); assert.deepEqual(p.findings.leaks, shared.leaks); assert.deepEqual(p.findings.blockers, shared.blockers);
  assert.deepEqual(p.findings.blockers, ['cite/blocker visible', '[GAP: visible]']); assert.deepEqual(p.findings.warnings, []);
  assert.deepEqual(paperTextFindings('The Danus system. A worker/verifier uses predecessors.\n'), { leaks: [], blockers: [] });
  assert.deepEqual(paperTextFindings(dirty), shared, 'global regex state cannot leak between calls');
});

test('section output 2 MiB byte cap/NUL/Unicode/allowlist guards are App-only, not a session allowance', () => {
  const exact = 'x'.repeat(2 * 1024 * 1024); assert.equal(splitSectionOutput(exact, []).tex.length, exact.length);
  for (const value of [exact + 'x', '\0', '\ud800', '中'.repeat(700000), null]) badOutput(() => splitSectionOutput(value, []));
  for (const allowed of [[id(1), id(1)], ['bad'], null, Array.from({ length: 65 }, (_, i) => id(i))]) badOutput(() => splitSectionOutput(body, allowed));
});

test('legacy paper prompts remain byte-identical to pre-extraction default/selected/CRLF snapshots', () => {
  const oldFact = (n, pred = [], eol = '\n') => ({ fact_id: id(n), predecessors: pred, markdown: ['---', 'fact_id: ' + id(n), 'predecessors: [' + pred.join(', ') + ']', 'external_refs: []', '---', '', '## statement', 'OPAQUE_' + n, '', '## proof', '  Proof bytes.  ', '', ''].join(eol) });
  const r = { contract: 'Contract\n', writerPrompt: 'Writer\n', style: 'Style\n', structure: 'Structure\n', acknowledgement: 'Acknowledgement\n' };
  const a = { resources: r, facts: [oldFact(1), oldFact(2, [id(1)]), oldFact(3)], problem: 'Opaque problem', brief: 'Opaque brief', instructions: '  Opaque direction  ', headlineFactIds: [id(2)] };
  assert.equal(hash(buildPaperPrompt(a)), 'fcd1fab86816253921d41bad8905bf482863357876a52b5154fac379e9e5f2f3');
  assert.equal(hash(buildPaperPrompt({ ...a, factIds: [id(2)] })), 'd45ff71887916a4f53525c11bc4f6e8e5e82f25459cba0f21ef3b6942d6cb9fc');
  assert.equal(hash(buildPaperPrompt({ ...a, facts: [oldFact(1, [], '\r\n'), oldFact(2, [id(1)], '\r\n')], instructions: '' })), '25e0f031f6d86e1d10cc3617c91fd4245c52a9ccdddf2ae5e199aa4135d7f184');
  for (const eol of ['\n', '\r\n', '\r']) {
    const f = oldFact(1, [], eol); const expected = ['## statement', 'OPAQUE_1', '', '## proof', '  Proof bytes.  ', '', ''].join(eol);
    assert.equal(paperFactBody(f), expected);
  }
});

test('legacy output normalization and complete-document warnings are unchanged by shared finding extraction', () => {
  const tex = '\\documentclass{amsart}\n\\begin{document}\n\\label{thm:x}\nOpaque.\n\\end{document}\n';
  const p = splitPaperOutput('```tex\n' + tex + '%%%PROVENANCE%%%\n{"thm:x":"' + id(4) + '"}\n```', [id(4)]);
  assert.equal(p.tex, tex); assert.deepEqual(p.provenance, { 'thm:x': id(4) }); assert.deepEqual(p.findings, { leaks: [], blockers: [], warnings: [] });
  const duplicate = splitPaperOutput(tex + '%%%PROVENANCE%%%{"thm:x":"' + id(4) + '","thm:x":"' + id(4) + '"}', [id(4)]);
  assert.equal(duplicate.provenance, null); assert.match(duplicate.findings.warnings[0], /malformed/);
  assert.match(splitPaperOutput(body, [id(4)]).findings.warnings.join(' '), /lacks a complete raw LaTeX document/);
});
