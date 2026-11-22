// M05 opaque pure-module fixtures only. No SDK, App, research or model API.
// Parser/repair expectations: Danus 839c471 paper_chunked.py:140-284;
// numeric guardrails: docs/design/m05-paper-plan.md (Hana, not upstream).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { capturePlanMaterial, validPlanMaterial, assertPlanMaterial, assertPlanBrief, readPlanResources, buildPlanPrompt, planInput, validPlan, splitPlannerOutput, parsePlanSections, normalizePlanCoverage, planBinding, planDocuments } from '../packages/hana-math/paper-plan.mjs';
import { paperStatement } from '../packages/hana-math/paper-source.mjs';
import { collectPaperFacts } from '../packages/hana-math/paper-facts.mjs';
const id = n => n.toString(16).padStart(16, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (run, code) => assert.throws(run, { code });
const badOutput = run => fail(run, 'PROJECT_PAPER_PLAN_OUTPUT_INVALID');
const fact = (n, predecessors = [], statement = `StatementSentinel_${n}`) => ({ fact_id: id(n), predecessors: [...predecessors],
  markdown: `---\nfact_id: ${id(n)}\npredecessors: [${predecessors.join(', ')}]\nexternal_refs: [{"key":"REF${n}","title":"Reference ${n}","cited_for":"Use ${n}"}]\n---\n## statement\n${statement}\n## proof\nProofSentinel_${n}\n## intuition\nIntuitionSentinel_${n}\n` });
const chain = n => Array.from({ length: n }, (_, i) => fact(i + 1, i ? [id(i)] : []));
const projectId = 'fixture-project';
function setup(facts = chain(3), roots = [facts.at(-1).fact_id], factIds) {
  const target = { schemaVersion: 1, projectId, paperId: 'plan', factIds: [...roots],
    factDigests: Object.fromEntries(roots.map(key => [key, hash(facts.find(f => f.fact_id === key).markdown)])), finalizedBy: 'creator', at: 1 };
  const gathered = { facts, asOf: 'admission-snapshot' };
  const parts = capturePlanMaterial({ ...gathered, target, factIds });
  const plan = { paperId: 'plan', target, brief: 'Opaque planning brief.', instructions: '', ...(factIds?.length ? { factIds: [...factIds] } : {}), material: parts.material };
  return { gathered, plan, parts };
}
const resources = { contract: 'Contract\n', plannerPrompt: 'Planner\n', style: 'Style\n', structure: 'Structure\n', acknowledgement: 'Acknowledgement\n' };
const output = (sections, preamble = 'PREAMBLE\n', frontmatter = 'FRONTMATTER\n', bibliography = 'BIBLIOGRAPHY\n') =>
  `%%%PREAMBLE%%%\n${preamble}%%%FRONTMATTER%%%\n${frontmatter}%%%SECTIONS%%%\n${typeof sections === 'string' ? sections : JSON.stringify(sections)}\n%%%BIBLIOGRAPHY%%%\n${bibliography}`;
const section = (label, fact_ids = [], title = label) => ({ title, label, fact_ids });
const fileNames = { contract: 'roles/AGENTS.md', plannerPrompt: 'roles/PAPER_PLANNER_PROMPT.md', style: 'style/STYLE_GUIDE.md', structure: 'style/PAPER_STRUCTURE.md', acknowledgement: 'boilerplate/acknowledgement.md' };
const pins = { contract: 'a488190965c1495a82e44db27474e330cdaff475b2daf054ef1ff3404e0de596', plannerPrompt: '7e63847af5393928536e677589f4f0f3ff11f0eb09e2af302eb19e918ed44e24', style: '9dfd559f95104d3297250584a86adfab40f5412d09abf718355b50cb8e485750', structure: '61d377ae07a94e41c55d3476c99e6809fd784395f9ea474f239620c2decd3314', acknowledgement: '32c280a4538453af0010f1f8c709253538223f755485b60c7b11c724fd42f69c' };

test('M05 plan: ten independent finalized headlines allow default, empty and explicit full coverage', () => {
  const facts = Array.from({ length: 10 }, (_, i) => fact(i + 1)), roots = facts.map(f => f.fact_id);
  const a = setup(facts, roots), b = setup(facts, roots, []), c = setup(facts, roots, [...roots].reverse());
  assert.deepEqual(a.parts, b.parts); assert.equal(a.plan.material.mode, 'target-closure'); assert.equal(Object.hasOwn(b.plan, 'factIds'), false);
  assert.deepEqual(a.plan.material.coverageFactIds, roots); assert.deepEqual(c.plan.material.coverageFactIds, roots); assert.equal(c.plan.material.mode, 'selected');
  for (const item of [a, b, c]) { assert.ok(validPlanMaterial(item.plan.material, item.plan.target, item.plan.factIds)); assert.ok(validPlan(item.plan, projectId, false)); }
});

test('M05 plan: selected coverage is exact while validation is the shared ancestor union with outside warning', () => {
  const facts = [fact(1, [], 'AncestorStatement'), fact(2, [id(1)]), fact(3), fact(4, [id(1)])];
  const { parts, plan } = setup(facts, [id(2)], [id(4), id(2)]), before = structuredClone(facts);
  assert.deepEqual(parts.coverageFacts.map(f => f.fact_id), [id(2), id(4)]);
  assert.deepEqual(parts.validationFacts.map(f => f.fact_id), [id(1), id(2), id(4)]);
  assert.deepEqual(plan.material.outsideTargetFactIds, [id(4)]); assert.deepEqual(plan.material.warnings, ['PROJECT_PAPER_SELECTION_OUTSIDE_TARGET']);
  assert.doesNotMatch(JSON.stringify(plan.material), /AncestorStatement|ProofSentinel|markdown|predecessors/);
  assert.deepEqual(facts, before); assert.ok(validPlanMaterial(plan.material, plan.target, plan.factIds));
});

test('M05 plan: an outside-only ancestor enters validation and ledger, never selected coverage or statement supply', () => {
  const facts = [fact(1, [], 'AncestorStatement'), fact(2, [id(1)]), fact(3, [id(1)], 'OutsideAncestorStatement'), fact(4, [id(3)]), fact(5)];
  const { gathered, plan, parts } = setup(facts, [id(2)], [id(2), id(4)]);
  assert.deepEqual(plan.material.coverageFactIds, [id(2), id(4)]); assert.deepEqual(plan.material.validationFactIds, [id(1), id(2), id(3), id(4)]);
  assert.equal(parts.validationFacts.filter(f => f.fact_id === id(1)).length, 1);
  assert.deepEqual(plan.material.outsideTargetFactIds, [id(4)]);
  const input = buildPlanPrompt({ ...gathered, plan, resources });
  assert.match(input.ledger, /Reference 3/); assert.doesNotMatch(input.ledger, /Reference 5/);
  assert.doesNotMatch(input.prompt, /AncestorStatement|OutsideAncestorStatement|ProofSentinel|IntuitionSentinel/);
  for (const n of [3, 4]) {
    const changed = structuredClone(gathered); changed.facts[n - 1].markdown += 'outside canonical drift';
    fail(() => assertPlanMaterial(changed, plan), 'PROJECT_SUMMARY_FACT_REVOKED');
  }
});

test('M05 plan: material IDs use sorted-pass topology, not caller selection order', () => {
  const facts = [fact(1, [id(2)]), fact(2), fact(3)];
  const a = setup(facts, [id(1)], [id(1), id(3)]), b = setup([...facts].reverse(), [id(1)], [id(3), id(1)]);
  assert.deepEqual(a.plan.material.validationFactIds, [id(2), id(3), id(1)]);
  assert.deepEqual(a.plan.material.coverageFactIds, [id(3), id(1)]); assert.deepEqual(a.plan.material, b.plan.material);
});

test('M05 plan: headline omission, unknown/revoked selection, duplicates and more than 64 are refused', () => {
  const facts = Array.from({ length: 65 }, (_, i) => fact(i + 1)), target = { factIds: [id(1), id(2)] };
  fail(() => capturePlanMaterial({ facts, target, factIds: [id(1)], asOf: 's' }), 'PROJECT_PAPER_HEADLINE_NOT_SELECTED');
  fail(() => capturePlanMaterial({ facts, target, factIds: [id(1), id(2), id(99)], asOf: 's' }), 'PROJECT_PAPER_INVALID_FACT');
  for (const factIds of [[id(1), id(2), id(2)], facts.map(f => f.fact_id)]) fail(() => capturePlanMaterial({ facts, target, factIds, asOf: 's' }), 'PROJECT_INVALID_INPUT');
  const selection = facts.slice(0, 64).map(f => f.fact_id); assert.equal(capturePlanMaterial({ facts, target, factIds: selection, asOf: 's' }).coverageFacts.length, 64);
  const live = setup(chain(3), [id(3)], [id(3)]);
  fail(() => assertPlanMaterial({ ...live.gathered, facts: live.gathered.facts.filter(f => f.fact_id !== id(1)) }, live.plan), 'PROJECT_PAPER_INVALID_FACT');
});

test('M05 plan: digest independently binds full canonical markdown and ordered predecessor data, but not asOf', () => {
  const facts = [fact(1), fact(2), fact(3, [id(1), id(2)])], { gathered, plan } = setup(facts, [id(3)], [id(3)]);
  const canonical = facts.map(f => ({ fact_id: f.fact_id, predecessors: [...f.predecessors], markdown: f.markdown })).sort((a, b) => a.fact_id < b.fact_id ? -1 : 1);
  assert.equal(plan.material.sha256, hash(JSON.stringify(canonical)));
  assert.doesNotThrow(() => assertPlanMaterial({ facts: [...facts, fact(99)], asOf: 'unrelated-advance' }, plan));
  for (const index of [0, 2]) {
    const changed = structuredClone(facts); changed[index].markdown += 'proof/footer bytes changed';
    fail(() => assertPlanMaterial({ ...gathered, facts: changed }, plan), 'PROJECT_SUMMARY_FACT_REVOKED');
  }
  const reordered = structuredClone(facts); reordered[2].predecessors.reverse();
  assert.equal(reordered[2].markdown, facts[2].markdown);
  fail(() => assertPlanMaterial({ ...gathered, facts: reordered }, plan), 'PROJECT_SUMMARY_FACT_REVOKED');
  const captured = capturePlanMaterial({ ...gathered, target: plan.target, factIds: plan.factIds });
  captured.coverageFacts[0].predecessors.push(id(99)); assert.deepEqual(facts[2].predecessors, [id(1), id(2)]);
});

test('M05 plan: persisted material validates exact schema, coverage, mode, SHA and outside warnings', () => {
  const { plan } = setup([fact(1), fact(2), fact(3, [id(1)])], [id(3)], [id(2), id(3)]), m = plan.material;
  for (const patch of [{ extra: true }, { schemaVersion: 2 }, { mode: 'legacy' }, { coverageFactIds: [] }, { coverageFactIds: [id(3), id(3)] },
    { validationFactIds: [id(3)] }, { sha256: 'bad' }, { admissionAsOf: '' }, { warnings: [] }, { outsideTargetFactIds: [id(1)] }])
    assert.equal(validPlanMaterial({ ...m, ...patch }, plan.target, plan.factIds), false, JSON.stringify(patch));
  assert.equal(validPlanMaterial(null, plan.target, plan.factIds), false);
  const defaultPlan = setup().plan; assert.equal(validPlanMaterial({ ...defaultPlan.material, coverageFactIds: [id(3)] }, defaultPlan.target), false);
});

test('M05 plan: validPlan requires a finalized matching target and complete bound hashes without schema extras', async () => {
  const { gathered, plan } = setup(), input = await planInput(gathered, plan), bound = { ...plan, ...input.hashes };
  assert.ok(validPlan(plan, projectId, false)); assert.equal(validPlan(plan, projectId), false); assert.ok(validPlan(bound, projectId));
  for (const patch of [{ extra: true }, { paperId: 'other' }, { brief: '' }, { instructions: '\ud800' }, { promptSha256: 'bad' }, { ledgerSha256: 'bad' }, { resources: {} }]) assert.equal(validPlan({ ...bound, ...patch }, projectId), false);
  for (const patch of [{ projectId: 'other' }, { finalizedBy: 'worker' }, { factDigests: {} }, { factIds: [] }, { at: -1 }, { extra: true }])
    assert.equal(validPlan({ ...bound, target: { ...bound.target, ...patch } }, projectId), false);
  assert.equal(validPlan(bound, 'other'), false); assert.equal(validPlan(null, projectId), false);
});

test('M05 plan: brief accepts matching/placeholder fields and refuses conflicting/repeated headlines or exemplars', () => {
  const target = { factIds: [id(1), id(2)] };
  for (const brief of ['Opaque prose', 'headline_fact_ids: <fill later>\nstructural_exemplar: <none>', 'headline_fact_ids:\nstructural_exemplar:', `Headline_fact_ids: ["${id(1)}", "${id(2)}"]`]) assert.doesNotThrow(() => assertPlanBrief(brief, target));
  for (const brief of [`headline_fact_ids: ${id(2)}, ${id(1)}`, `headline_fact_ids: ${id(1)}`, 'headline_fact_ids: invalid', 'headline_fact_ids:\nheadline_fact_ids:', 'structural_exemplar:\nstructural_exemplar:'])
    fail(() => assertPlanBrief(brief, target), 'PROJECT_PAPER_BRIEF_TARGET_CONFLICT');
  for (const brief of ['structural_exemplar: paper.tex', 'structural_exemplar: https://example.invalid/paper']) fail(() => assertPlanBrief(brief, target), 'PROJECT_PAPER_EXEMPLAR_UNAVAILABLE');
});

test('M05 plan: validation union retains the shared 2048-fact boundary, independent of headline or selection size', async () => {
  const gather = async facts => {
    const target = { factIds: [facts.at(-1).fact_id], factDigests: { [facts.at(-1).fact_id]: hash(facts.at(-1).markdown) } };
    const map = new Map(facts.map(f => [f.fact_id, f])); let fetched = 0;
    const result = await collectPaperFacts({ target, fetchPage: async () => ({ page: { asOf: 's' } }), fetchFact: async key => { fetched++; return { fact: map.get(key) }; }, assertTarget: async () => {}, verifySnapshot: async s => assert.equal(s, 's') });
    return { result, fetched, target };
  };
  const allowed = await gather(chain(2048)); assert.equal(allowed.fetched, 2048);
  const material = capturePlanMaterial({ ...allowed.result, target: allowed.target }).material;
  assert.equal(material.coverageFactIds.length, 2048); assert.ok(validPlanMaterial(material, allowed.target));
  await assert.rejects(gather(chain(2049)), { code: 'PROJECT_PAPER_CLOSURE_TOO_LARGE' });
});

test('M05 plan: shared collection enforces exactly 1 MiB canonical JSON bytes including Unicode and escaping', async () => {
  const base = fact(1), bytes = Buffer.byteLength(JSON.stringify(base)), padding = 1024 * 1024 - bytes;
  const exact = { ...base, markdown: base.markdown + '汉'.repeat(Math.floor(padding / 3)) + 'x'.repeat(padding % 3) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 1024 * 1024);
  async function collect(f) {
    const target = { factIds: [id(1)], factDigests: { [id(1)]: hash(f.markdown) } };
    return collectPaperFacts({ target, fetchPage: async () => ({ page: { asOf: 's' } }), fetchFact: async () => ({ fact: f }), assertTarget: async () => {}, verifySnapshot: async () => {} });
  }
  assert.equal((await collect(exact)).facts.length, 1);
  await assert.rejects(collect({ ...exact, markdown: exact.markdown + 'x' }), { code: 'PROJECT_PAPER_CLOSURE_TOO_LARGE' });
});

test('M05 plan: target and outside validation share one deduplicated 2048-fact budget, not per-root budgets', async () => {
  async function collect(size) {
    const facts = Array.from({ length: size }, (_, i) => fact(i + 1, i === 0 ? [] : [id(i + 1 === 1026 ? 1 : i)]));
    const map = new Map(facts.map(f => [f.fact_id, f])), target = { factIds: [id(1025)], factDigests: { [id(1025)]: hash(facts[1024].markdown) } };
    const counts = new Map();
    const gathered = await collectPaperFacts({ target, selectedFactIds: [id(size)], fetchPage: async () => ({ page: { asOf: 's' } }),
      fetchFact: async key => { counts.set(key, (counts.get(key) ?? 0) + 1); return { fact: map.get(key) }; }, assertTarget: async () => {}, verifySnapshot: async () => {} });
    return { gathered, target, counts };
  }
  const at = await collect(2048); assert.equal(at.counts.size, 2048); assert.equal(at.counts.get(id(1)), 1);
  const capture = capturePlanMaterial({ ...at.gathered, target: at.target, factIds: [id(1025), id(2048)] });
  assert.equal(capture.coverageFacts.length, 2); assert.equal(capture.validationFacts.length, 2048);
  await assert.rejects(collect(2049), { code: 'PROJECT_PAPER_CLOSURE_TOO_LARGE' });
});

test('M05 plan: target and outside roots share the single 1 MiB canonical byte budget', async () => {
  const grow = (n, bytes) => { const f = fact(n); f.markdown += 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(f))); return f; };
  async function collect(extra) {
    const facts = [grow(1, 512 * 1024), grow(2, 512 * 1024 + extra)], target = { factIds: [id(1)], factDigests: { [id(1)]: hash(facts[0].markdown) } };
    return collectPaperFacts({ target, selectedFactIds: [id(2)], fetchPage: async () => ({ page: { asOf: 's' } }), fetchFact: async key => ({ fact: facts.find(f => f.fact_id === key) }), assertTarget: async () => {}, verifySnapshot: async () => {} });
  }
  assert.equal((await collect(0)).facts.length, 2);
  await assert.rejects(collect(1), { code: 'PROJECT_PAPER_CLOSURE_TOO_LARGE' });
});

test('M05 plan: five bundled resources are byte-verbatim and independently pinned to original resource hashes', async () => {
  const actual = await readPlanResources(), root = new URL('../packages/hana-math/references/danus/agents/skills/write-paper/', import.meta.url);
  assert.deepEqual(Object.keys(actual), Object.keys(fileNames));
  for (const [key, relative] of Object.entries(fileNames)) {
    const original = await fs.readFile(new URL(relative, root)); assert.equal(hash(original), pins[key]); assert.ok(Buffer.from(actual[key]).equals(original));
  }
});

test('M05 plan: missing or altered resource yields an honest error without editing original files', async t => {
  const read = fs.readFile;
  try {
    t.mock.method(fs, 'readFile', async (url, ...args) => { if (String(url).endsWith('/boilerplate/acknowledgement.md')) throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' }); return read(url, ...args); });
    await assert.rejects(readPlanResources(), { code: 'PROJECT_PAPER_RESOURCE_MISSING' });
  } finally { t.mock.restoreAll(); }
  try {
    t.mock.method(fs, 'readFile', async (url, ...args) => { const text = await read(url, ...args); return String(url).endsWith('/roles/PAPER_PLANNER_PROMPT.md') ? text + '\nfixture drift' : text; });
    await assert.rejects(readPlanResources(), { code: 'PROJECT_PAPER_PLAN_RESOURCE_INVALID' });
  } finally { t.mock.restoreAll(); }
});

test('M05 plan: prompt uses coverage statements only, union ledger, five verbatim resources and explicit preview limits', async () => {
  const facts = [fact(1, [], 'AncestorStatement'), fact(2, [id(1)]), fact(3), fact(4, [id(1)])], { gathered, plan } = setup(facts, [id(2)], [id(4), id(2)]);
  plan.instructions = '  Opaque direction  '; const original = structuredClone({ facts, plan });
  const fixed = await readPlanResources(), result = buildPlanPrompt({ ...gathered, plan, resources: fixed });
  for (const text of Object.values(fixed)) assert.ok(result.prompt.includes(text));
  assert.match(result.prompt, /StatementSentinel_2/); assert.match(result.prompt, /StatementSentinel_4/);
  assert.doesNotMatch(result.prompt, /AncestorStatement|StatementSentinel_3|ProofSentinel|IntuitionSentinel/);
  assert.match(result.prompt, /Reference 1/); assert.match(result.prompt, /Reference 4/); assert.doesNotMatch(result.ledger, /Reference 3/);
  assert.match(result.prompt, new RegExp(`predecessors \\(DAG\\): ${id(1)}`)); assert.match(result.prompt, /BEGIN CLOSURE_STATEMENTS/);
  assert.match(result.prompt, /BEGIN MAIN_AGENT_INSTRUCTIONS =====\nOpaque direction/); assert.match(result.ledger, /verified-by: unverified/);
  for (const word of ['phase 1 preview', '800000', '512 KiB', '2 MiB', 'Hana adaptation']) assert.ok(result.prompt.includes(word));
  assert.equal(result.hashes.promptSha256, hash(result.prompt)); assert.equal(result.hashes.ledgerSha256, hash(result.ledger));
  assert.deepEqual(result.hashes.resources, pins); assert.deepEqual({ facts, plan }, original);
});

test('M05 plan: statement extraction is canonical and refuses interposed assumptions or proof scavenging', () => {
  const f = fact(1, [], '  First line.\r\n\r\n Second line.  '); assert.equal(paperStatement(f), 'First line. Second line.');
  for (const body of ['## proof\nProofSentinel\n## statement\nLate\n', '## statement\nVisible\n## assumptions\nHidden condition\n## proof\nProofSentinel\n', '## statement\nVisible\n', '## statement\n```md\nOops\n```\n## proof\nProofSentinel\n']) {
    const markdown = fact(1).markdown.split('## statement')[0] + body;
    fail(() => paperStatement({ ...fact(1), markdown }), 'PROJECT_PAPER_INVALID_STATEMENT');
  }
});

test('M05 plan: prompt byte cap is independently inclusive at 512 KiB', () => {
  const { gathered, plan } = setup([fact(1)]), start = buildPlanPrompt({ ...gathered, plan, resources });
  const padding = 512 * 1024 - Buffer.byteLength(start.prompt), expanded = { ...resources, contract: resources.contract + '汉'.repeat(Math.floor(padding / 3)) + 'x'.repeat(padding % 3) };
  const at = buildPlanPrompt({ ...gathered, plan, resources: expanded }); assert.equal(Buffer.byteLength(at.prompt), 512 * 1024);
  fail(() => buildPlanPrompt({ ...gathered, plan, resources: { ...expanded, contract: expanded.contract + 'x' } }), 'PROJECT_SUMMARY_INPUT_TOO_LARGE');
});

test('M05 plan: planInput captures hashes once and refuses bound resource/prompt/ledger or canonical drift', async () => {
  const { gathered, plan } = setup(), input = await planInput(gathered, plan), bound = { ...plan, ...input.hashes };
  assert.deepEqual(await planInput(gathered, bound), input);
  for (const patch of [{ instructions: 'different instructions' }, { resources: { ...bound.resources, style: '0'.repeat(64) } }, { promptSha256: '0'.repeat(64) }, { ledgerSha256: '0'.repeat(64) }])
    await assert.rejects(planInput(gathered, { ...bound, ...patch }), { code: 'PROJECT_PAPER_PLAN_BINDING_CHANGED' });
  const changed = structuredClone(gathered); changed.facts[0].markdown += 'Drift';
  await assert.rejects(planInput(changed, bound), { code: 'PROJECT_SUMMARY_FACT_REVOKED' });
});

test('M05 plan: splitter uses first-find separators, discards marker-line remainder and preserves raw block bytes', () => {
  const raw = 'comment ```latex\n%%%PREAMBLE%%%discard\r\n  PRE\r\n%%%PREAMBLE%%%second marker\n%%%FRONTMATTER%%%discard\nFRONT\n%%%SECTIONS%%%discard\n[]\n%%%BIBLIOGRAPHY%%%discard\nBIB\n```\n';
  assert.deepEqual(splitPlannerOutput(raw), { preamble: '  PRE\r\n%%%PREAMBLE%%%second marker\n', frontmatter: 'FRONT\n', sections: '[]\n', bibliography: 'BIB\n```\n' });
  assert.deepEqual(splitPlannerOutput('%%%PREAMBLE%%%%%%FRONTMATTER%%%%%%SECTIONS%%%%%%BIBLIOGRAPHY%%%'), { preamble: '', frontmatter: '', sections: '', bibliography: '' });
  const sameLine = output('[{"title":"T","label":"L"}]').replace('%%%SECTIONS%%%\n', '%%%SECTIONS%%%');
  assert.equal(splitPlannerOutput(sameLine).sections, ''); badOutput(() => parsePlanSections(splitPlannerOutput(sameLine).sections));
  const noNewline = output([section('s')]).replace('%%%BIBLIOGRAPHY%%%\nBIBLIOGRAPHY\n', '%%%BIBLIOGRAPHY%%%discard');
  assert.equal(splitPlannerOutput(noNewline).bibliography, '');
});

test('M05 plan: missing, out-of-order and early stray markers fail rather than searching for a later good set', () => {
  const raw = output([section('s')]);
  for (const marker of ['%%%PREAMBLE%%%', '%%%FRONTMATTER%%%', '%%%SECTIONS%%%', '%%%BIBLIOGRAPHY%%%']) badOutput(() => splitPlannerOutput(raw.replace(marker, 'missing')));
  badOutput(() => splitPlannerOutput('%%%SECTIONS%%%early\n' + raw));
  badOutput(() => splitPlannerOutput(raw.replace('%%%PREAMBLE%%%', '%%%FRONTMATTER%%%').replace('%%%FRONTMATTER%%%\nFRONTMATTER', '%%%PREAMBLE%%%\nFRONTMATTER')));
  for (const value of [null, {}, '\ud800']) badOutput(() => splitPlannerOutput(value));
});

test('M05 plan: sections parser follows upstream permissive fences, missing fact_ids and discarded extras', () => {
  const raw = [{ title: '  Title  ', label: ' label ', extra: { ignore: true } }, { title: 'Other', label: 'other', fact_ids: ['not-hex-is-repaired-later', id(1)], unused: 3 }];
  const expected = [{ title: '  Title  ', label: ' label ', fact_ids: [] }, { title: 'Other', label: 'other', fact_ids: ['not-hex-is-repaired-later', id(1)] }];
  for (const text of [JSON.stringify(raw), '```json\n' + JSON.stringify(raw) + '\n```', '```anything\n' + JSON.stringify(raw), '```\n' + JSON.stringify(raw) + '\n```trailing-description']) assert.deepEqual(parsePlanSections(text), expected);
  assert.deepEqual(parsePlanSections('[{"title":"T","label":"s","extra":NaN,"another":Infinity,"last":-Infinity}]'), [section('s', [], 'T')]);
  assert.equal(parsePlanSections('[{"title":"NaN Infinity","label":"s"}]')[0].title, 'NaN Infinity');
});

test('M05 plan: Python whitespace/splitlines semantics are preserved without treating BOM as whitespace', () => {
  const json = '[{"title":"T","label":"s"}]';
  for (const separator of ['\r', '\r\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029'])
    assert.deepEqual(parsePlanSections('\x85```json' + separator + json + separator + '```\x1f'), [section('s', [], 'T')]);
  badOutput(() => parsePlanSections('\ufeff' + json));
  badOutput(() => parsePlanSections('[{"title":"\\u0085","label":"s"}]'));
});

test('M05 plan: parser rejects malformed/empty/wrong shapes, invalid field types and exact duplicate labels', () => {
  for (const text of ['', 'not json', '{}', '[]', '[null]', '[1]', '[[]]', '[{}]', '[{"title":"T"}]', '[{"title":"","label":"s"}]', '[{"title":"T","label":" "}]',
    '[{"title":1,"label":"s"}]', '[{"title":"T","label":"s","fact_ids":null}]', '[{"title":"T","label":"s","fact_ids":[1]}]', '[{"title":"T","label":"s"},{"title":"U","label":"s"}]']) badOutput(() => parsePlanSections(text));
  // Upstream compares labels exactly, not trimmed/case-folded or slug-normalized.
  assert.equal(parsePlanSections(JSON.stringify([section('s'), section(' s '), section('S')])).length, 3);
});

test('M05 plan: title and label have inclusive 4096 UTF-8-byte limits and reject NUL/lone surrogates', () => {
  for (const field of ['title', 'label']) {
    for (const value of ['x'.repeat(4096), '😀'.repeat(1024), '汉'.repeat(1365) + 'x']) {
      assert.equal(Buffer.byteLength(value), 4096); assert.equal(parsePlanSections(JSON.stringify([{ ...section('s'), [field]: value }]))[0][field], value);
      badOutput(() => parsePlanSections(JSON.stringify([{ ...section('s'), [field]: value + 'x' }])));
    }
    for (const value of ['x\0y', '\ud800', '\udfff']) badOutput(() => parsePlanSections(JSON.stringify([{ ...section('s'), [field]: value }])));
  }
});

test('M05 plan: repair keeps first occurrence, drops outside IDs and appends missing IDs with a collision-free label', () => {
  const sections = [section('sec:additional', [id(2), id(2), 'outside']), section('sec:additional-2', [id(2), id(1), id(99)]), section('sec:additional-3')];
  const coverage = [id(1), id(2), id(3), id(4)], before = structuredClone(sections), repaired = normalizePlanCoverage(sections, coverage);
  assert.deepEqual(repaired.normalized, [section('sec:additional', [id(2)]), section('sec:additional-2', [id(1)]), section('sec:additional-3'), section('sec:additional-4', [id(3), id(4)], 'Additional results')]);
  assert.deepEqual(repaired.repairLog, ['deduped 2 fact(s) assigned to >1 section (kept first)', 'dropped 2 assigned id(s) not in the closure', "swept 2 unassigned closure fact(s) into 'sec:additional-4'"]);
  assert.deepEqual(sections, before); assert.deepEqual(coverage, [id(1), id(2), id(3), id(4)]);
  const again = normalizePlanCoverage(repaired.normalized, coverage); assert.deepEqual(again.normalized, repaired.normalized); assert.deepEqual(again.repairLog, []);
  repaired.normalized[0].fact_ids.push('mutation'); assert.deepEqual(sections, before);
});

test('M05 plan: a clean reverse-reading assignment is retained and never represented as topological validation', () => {
  const { plan } = setup(chain(2)), sections = [section('later', [id(2)]), section('earlier', [id(1)])];
  const result = planDocuments(output(sections), plan);
  assert.deepEqual(result.document.normalizedSections, sections); assert.deepEqual(result.document.repairLog, []);
  assert.equal(result.document.sectionOrdering, 'not-checked'); assert.match(result.document.limitations.join(' '), /No topology/);
});

test('M05 plan: 128 raw sections are legal, repair may add one, but 129 raw sections are rejected', () => {
  const { plan } = setup([fact(1)]), sections = Array.from({ length: 128 }, (_, i) => section(`s${i}`));
  assert.equal(parsePlanSections(JSON.stringify(sections)).length, 128);
  const result = planDocuments(output(sections), plan); assert.equal(result.document.sections.length, 128); assert.equal(result.document.normalizedSections.length, 129);
  assert.deepEqual(result.document.normalizedSections.at(-1), section('sec:additional', [id(1)], 'Additional results'));
  badOutput(() => parsePlanSections(JSON.stringify([...sections, section('s128')])));
});

test('M05 plan: raw output gate counts UTF-8 bytes inclusively at 2 MiB, not JS string length', () => {
  const { plan } = setup([fact(1)]), base = output([section('s', [id(1)])]), padding = 2 * 1024 * 1024 - Buffer.byteLength(base);
  const at = '😀'.repeat(Math.floor(padding / 4)) + 'x'.repeat(padding % 4) + base;
  assert.equal(Buffer.byteLength(at), 2 * 1024 * 1024); assert.ok(at.length < Buffer.byteLength(at));
  assert.deepEqual(splitPlannerOutput(at), splitPlannerOutput(base)); assert.equal(planDocuments(at, plan).document.coverage.status, 'exact-once');
  badOutput(() => splitPlannerOutput(at + 'x')); badOutput(() => planDocuments(at + 'x', plan));
});

test('M05 plan: documents retain exact four raw blocks, parsed originals, normalized repairs, binding and honest limits', () => {
  const { plan } = setup(chain(2)); plan.resources = { ...pins }; plan.promptSha256 = 'a'.repeat(64); plan.ledgerSha256 = 'b'.repeat(64);
  const rawSections = [{ ...section('s', [id(2), id(2), 'outside']), extra: 'raw-only' }], raw = output('```json\n' + JSON.stringify(rawSections) + '\n```', '\\documentclass{article}\n', '  FRONT\r\n', '\\bibliography{opaque}\n');
  const result = planDocuments(raw, plan), doc = result.document;
  assert.deepEqual(result.blocks, splitPlannerOutput(raw)); assert.ok(result.blocks.sections.includes('raw-only')); assert.ok(result.blocks.sections.includes('```json'));
  assert.deepEqual(doc.sections, [section('s', [id(2), id(2), 'outside'])]); assert.deepEqual(doc.normalizedSections, [section('s', [id(2)]), section('sec:additional', [id(1)], 'Additional results')]);
  assert.deepEqual(doc.binding, planBinding(plan)); assert.deepEqual(Object.keys(doc.binding), ['paperId', 'target', 'material', 'resources', 'promptSha256', 'ledgerSha256']);
  assert.deepEqual(doc.coverage, { status: 'exact-once', factIds: [id(1), id(2)] });
  assert.equal(doc.kind, 'paper-plan'); assert.equal(doc.publicationStatus, 'reviewable-plan'); assert.equal(doc.sectionOrdering, 'not-checked');
  assert.equal(doc.citationStatus, 'not-requested'); assert.equal(doc.mathematicsStatus, 'unreviewed'); assert.equal(doc.compileStatus, 'not-run');
  assert.match(doc.limitations.join(' '), /Phase 1 preview/); assert.match(doc.limitations.join(' '), /section writers and stitch have not run/);
  for (const key of ['mainTex', 'proposal', 'provenance', 'rawResponse']) assert.equal(Object.hasOwn(result, key), false);
  badOutput(() => planDocuments(output('[]'), plan));
});
