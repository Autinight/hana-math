// Phase-1 split/parse/repair ported from Danus 839c471 paper_chunked.py:140-284.
// Also provides pure text stitching; no section writer, compiler or publication.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { paperClosure, paperLedger, paperStatement } from './paper-source.mjs';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const ids = (v, max) => Array.isArray(v) && v.length <= max && v.every(id) && new Set(v).size === v.length;
const need = (ok, code = 'PROJECT_PAPER_PLAN_INVALID') => { if (!ok) throw Object.assign(new Error(code), { code }); };
export const planHash = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const MATERIAL = ['schemaVersion', 'mode', 'coverageFactIds', 'validationFactIds', 'sha256', 'admissionAsOf', 'outsideTargetFactIds', 'warnings'];
export function capturePlanMaterial({ facts, target, factIds, asOf }) {
  const selected = factIds?.length ? factIds : null;
  need(!selected || ids(selected, 64), 'PROJECT_INVALID_INPUT');
  if (selected) need(target.factIds.every(id => selected.includes(id)), 'PROJECT_PAPER_HEADLINE_NOT_SELECTED');
  const validationFacts = paperClosure(facts, [...new Set([...target.factIds, ...(selected ?? [])])]);
  const targetFacts = paperClosure(validationFacts, target.factIds), targetIds = new Set(targetFacts.map(f => f.fact_id));
  const coverageFacts = selected ? validationFacts.filter(f => selected.includes(f.fact_id)) : targetFacts;
  const outside = coverageFacts.filter(f => !targetIds.has(f.fact_id)).map(f => f.fact_id);
  const canonical = validationFacts.map(f => ({ fact_id: f.fact_id, predecessors: [...f.predecessors], markdown: f.markdown })).sort((a, b) => a.fact_id.localeCompare(b.fact_id));
  return { validationFacts, coverageFacts, material: { schemaVersion: 1, mode: selected ? 'selected' : 'target-closure',
    coverageFactIds: coverageFacts.map(f => f.fact_id), validationFactIds: validationFacts.map(f => f.fact_id), sha256: planHash(JSON.stringify(canonical)),
    admissionAsOf: asOf, outsideTargetFactIds: outside, warnings: outside.length ? ['PROJECT_PAPER_SELECTION_OUTSIDE_TARGET'] : [] } };
}
export function validPlanMaterial(m, target, factIds) {
  const selected = factIds !== undefined;
  return exact(m, MATERIAL) && m.schemaVersion === 1 && m.mode === (selected ? 'selected' : 'target-closure')
    && (!selected || ids(factIds, 64) && factIds.length > 0) && ids(m.coverageFactIds, selected ? 64 : 2048) && m.coverageFactIds.length > 0
    && ids(m.validationFactIds, 2048) && m.validationFactIds.length > 0 && m.coverageFactIds.every(id => m.validationFactIds.includes(id))
    && target.factIds.every(id => m.coverageFactIds.includes(id)) && (!selected || factIds.length === m.coverageFactIds.length && factIds.every(id => m.coverageFactIds.includes(id)))
    && sha(m.sha256) && typeof m.admissionAsOf === 'string' && m.admissionAsOf.length > 0 && m.admissionAsOf.length <= 256
    && ids(m.outsideTargetFactIds, 64) && m.outsideTargetFactIds.every(id => m.coverageFactIds.includes(id))
    && (selected || m.outsideTargetFactIds.length === 0 && equal(m.coverageFactIds, m.validationFactIds))
    && equal(m.warnings, m.outsideTargetFactIds.length ? ['PROJECT_PAPER_SELECTION_OUTSIDE_TARGET'] : []);
}
export function assertPlanMaterial(gathered, plan) {
  const parts = capturePlanMaterial({ ...gathered, target: plan.target, factIds: plan.factIds });
  need(validPlanMaterial(plan.material, plan.target, plan.factIds) && MATERIAL.filter(k => k !== 'admissionAsOf').every(k => equal(parts.material[k], plan.material[k])), 'PROJECT_SUMMARY_FACT_REVOKED');
  return parts;
}
export function assertPlanBrief(brief, target) {
  const values = pattern => brief.split(/\r?\n/).map(line => pattern.exec(line)).filter(Boolean).map(match => match[1].trim());
  const headlines = values(/^\s*headline_fact_ids\s*:\s*(.*?)\s*$/i), exemplars = values(/^\s*structural_exemplar\s*:\s*(.*?)\s*$/i);
  need(headlines.length <= 1 && exemplars.length <= 1, 'PROJECT_PAPER_BRIEF_TARGET_CONFLICT');
  if (exemplars[0] && !exemplars[0].startsWith('<')) need(false, 'PROJECT_PAPER_EXEMPLAR_UNAVAILABLE');
  if (headlines[0] && !headlines[0].startsWith('<')) need(equal(headlines[0].match(/fact_[A-Za-z0-9_]+|\b[0-9a-f]{8,}\b/g) ?? [], target.factIds), 'PROJECT_PAPER_BRIEF_TARGET_CONFLICT');
}
const FILES = { contract: 'roles/AGENTS.md', plannerPrompt: 'roles/PAPER_PLANNER_PROMPT.md', style: 'style/STYLE_GUIDE.md', structure: 'style/PAPER_STRUCTURE.md', acknowledgement: 'boilerplate/acknowledgement.md' };
const PINS = { contract: 'a488190965c1495a82e44db27474e330cdaff475b2daf054ef1ff3404e0de596', plannerPrompt: '7e63847af5393928536e677589f4f0f3ff11f0eb09e2af302eb19e918ed44e24', style: '9dfd559f95104d3297250584a86adfab40f5412d09abf718355b50cb8e485750', structure: '61d377ae07a94e41c55d3476c99e6809fd784395f9ea474f239620c2decd3314', acknowledgement: '32c280a4538453af0010f1f8c709253538223f755485b60c7b11c724fd42f69c' };
export async function readPlanResources() {
  const entries = await Promise.all(Object.entries(FILES).map(async ([key, relative]) => {
    let text;
    try { text = await fs.readFile(new URL('./references/danus/agents/skills/write-paper/' + relative, import.meta.url), 'utf8'); }
    catch { need(false, 'PROJECT_PAPER_RESOURCE_MISSING'); }
    need(planHash(text) === PINS[key], 'PROJECT_PAPER_PLAN_RESOURCE_INVALID'); return [key, text];
  }));
  return Object.fromEntries(entries);
}
const section = (name, body) => `\n\n===== BEGIN ${name} =====\n${body}\n===== END ${name} =====\n`;
export function buildPlanPrompt({ resources, plan, facts, asOf }) {
  const parts = assertPlanMaterial({ facts, asOf }, plan);
  const names = ['AGENTS.md', 'PAPER_PLANNER_PROMPT.md', 'STYLE_GUIDE.md', 'PAPER_STRUCTURE.md', 'ACKNOWLEDGEMENT_BOILERPLATE.md'];
  need(Object.keys(FILES).every(k => typeof resources[k] === 'string' && resources[k].length > 0));
  const text = ['You are the PAPER PLANNER. This is an explicitly requested phase 1 preview only, not evidence that the upstream 800000-character automatic chunk trigger was reached. Everything is embedded; no filesystem, tools or memory. Emit the four original planner blocks. Do not invoke section writers, stitch, compilation or PDF. Hana uses a 512 KiB prompt cap. The effective shared research-session finalText limit is 512 KiB; oversized finalText is rejected, not truncated. The planner parser/artifact guard is separately 2 MiB, not a usable session output allowance. These are independent resource guardrails, not upstream trigger thresholds. The ledger is seeded from the validation union as a Hana adaptation; only CLOSURE_STATEMENTS supplies internal statements. No proof or intuition is supplied. This preview certifies no section ordering, citation correctness or mathematics.'];
  Object.keys(FILES).forEach((key, i) => text.push(section(names[i], resources[key])));
  text.push(section('PROJECT_BRIEF.md', plan.brief));
  if (plan.instructions.trim()) text.push(section('MAIN_AGENT_INSTRUCTIONS', plan.instructions.trim()));
  const ledger = paperLedger(parts.validationFacts);
  text.push(section('REFERENCE_LEDGER.md', ledger), section('CLOSURE_STATEMENTS', parts.coverageFacts.map(f => `[source_fact: ${f.fact_id}]\npredecessors (DAG): ${f.predecessors.join(', ') || '(none)'}\n## statement\n${paperStatement(f)}\n`).join('\n')));
  const prompt = text.join(''); need(Buffer.byteLength(prompt) <= 512 * 1024, 'PROJECT_SUMMARY_INPUT_TOO_LARGE');
  return { prompt, ledger, hashes: { resources: Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, planHash(value)])), promptSha256: planHash(prompt), ledgerSha256: planHash(ledger) } };
}
export async function planInput(gathered, plan) {
  const input = buildPlanPrompt({ ...gathered, plan, resources: await readPlanResources() });
  if (plan.resources) need(equal(input.hashes.resources, plan.resources) && input.hashes.promptSha256 === plan.promptSha256 && input.hashes.ledgerSha256 === plan.ledgerSha256, 'PROJECT_PAPER_PLAN_BINDING_CHANGED');
  return input;
}
export function validPlan(plan, projectId, bound = true) {
  if (!object(plan)) return false;
  const keys = ['paperId', 'target', 'brief', 'instructions', 'material', ...(Object.hasOwn(plan, 'factIds') ? ['factIds'] : []), ...(bound ? ['resources', 'promptSha256', 'ledgerSha256'] : [])];
  const t = plan.target, targetKeys = ['schemaVersion', 'projectId', 'paperId', 'factIds', 'factDigests', 'finalizedBy', 'at'];
  const text = v => typeof v === 'string' && v.isWellFormed() && !v.includes('\0') && Buffer.byteLength(v) <= 32768;
  return exact(plan, keys) && typeof plan.paperId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.paperId)
    && text(plan.brief) && plan.brief.trim().length > 0 && text(plan.instructions) && exact(t, targetKeys) && t.schemaVersion === 1
    && t.projectId === projectId && t.paperId === plan.paperId && t.finalizedBy === 'creator' && Number.isSafeInteger(t.at) && t.at >= 0
    && ids(t.factIds, 64) && t.factIds.length > 0 && exact(t.factDigests, t.factIds) && t.factIds.every(id => sha(t.factDigests[id]))
    && validPlanMaterial(plan.material, t, plan.factIds) && (!bound || exact(plan.resources, Object.keys(FILES)) && Object.values(plan.resources).every(sha) && sha(plan.promptSha256) && sha(plan.ledgerSha256));
}
// Match upstream .find separators and discard the remainder of each separator's
// line. Do not add strict whole-line/TeX/outer-fence rules to this parser.
export function splitPlannerOutput(text) {
  need(typeof text === 'string' && text.isWellFormed() && Buffer.byteLength(text) <= 2 * 1024 * 1024, 'PROJECT_PAPER_PLAN_OUTPUT_INVALID');
  const names = ['preamble', 'frontmatter', 'sections', 'bibliography'];
  const separators = ['%%%PREAMBLE%%%', '%%%FRONTMATTER%%%', '%%%SECTIONS%%%', '%%%BIBLIOGRAPHY%%%'];
  const positions = separators.map(s => text.indexOf(s));
  need(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), 'PROJECT_PAPER_PLAN_OUTPUT_INVALID');
  return Object.fromEntries(names.map((name, i) => {
    const body = text.slice(positions[i] + separators[i].length, positions[i + 1] ?? text.length), newline = body.indexOf('\n');
    return [name, newline < 0 ? '' : body.slice(newline + 1)];
  }));
}
// Python str.strip/splitlines semantics: BOM is not whitespace, but U+0085
// and U+001C..1F are. Keep the actual upstream fence/parser behavior.
const pythonStrip = text => text.replace(/^[\t-\r\x1c-\x20\x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
export function parsePlanSections(block) {
  let text = pythonStrip(block);
  if (text.startsWith('```')) {
    const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
    if (pythonStrip(lines[0] ?? '').startsWith('```')) lines.shift();
    if (pythonStrip(lines.at(-1) ?? '').startsWith('```')) lines.pop(); text = pythonStrip(lines.join('\n'));
  }
  // Python json.loads accepts nonfinite constants. They cannot be title/label
  // or fact_ids; normalize them to null outside strings before discarding extras.
  const json = text.replace(/"(?:\\.|[^"\\])*"|(?<![\w])(?:-Infinity|Infinity|NaN)(?![\w])/g, token => token.startsWith('"') ? token : 'null');
  let sections; try { sections = JSON.parse(json); } catch { need(false, 'PROJECT_PAPER_PLAN_OUTPUT_INVALID'); }
  // 128 sections and 4096 UTF-8 bytes per title/label are explicit App guardrails.
  need(Array.isArray(sections) && sections.length > 0 && sections.length <= 128, 'PROJECT_PAPER_PLAN_OUTPUT_INVALID');
  const seen = new Set(), field = v => typeof v === 'string' && pythonStrip(v).length > 0 && v.isWellFormed() && !v.includes('\0') && Buffer.byteLength(v) <= 4096;
  return sections.map(s => {
    need(object(s) && field(s.title) && field(s.label) && !seen.has(s.label), 'PROJECT_PAPER_PLAN_OUTPUT_INVALID');
    seen.add(s.label); const fact_ids = Object.hasOwn(s, 'fact_ids') ? s.fact_ids : [];
    need(Array.isArray(fact_ids) && fact_ids.every(id => typeof id === 'string'), 'PROJECT_PAPER_PLAN_OUTPUT_INVALID');
    return { title: s.title, label: s.label, fact_ids: [...fact_ids] };
  });
}
export function normalizePlanCoverage(sections, coverage) {
  const wanted = new Set(coverage), seen = new Set(); let dup = 0, extra = 0;
  const normalized = sections.map(s => ({ ...s, fact_ids: s.fact_ids.filter(id => { if (!wanted.has(id)) { extra++; return false; } if (seen.has(id)) { dup++; return false; } seen.add(id); return true; }) }));
  const missing = coverage.filter(id => !seen.has(id)), repairLog = [];
  if (dup) repairLog.push(`deduped ${dup} fact(s) assigned to >1 section (kept first)`);
  if (extra) repairLog.push(`dropped ${extra} assigned id(s) not in the closure`);
  if (missing.length) {
    const labels = new Set(normalized.map(s => s.label)); let label = 'sec:additional', i = 1;
    while (labels.has(label)) label = `sec:additional-${++i}`;
    normalized.push({ title: 'Additional results', label, fact_ids: missing }); repairLog.push(`swept ${missing.length} unassigned closure fact(s) into '${label}'`);
  }
  const assigned = normalized.flatMap(s => s.fact_ids);
  need(assigned.length === coverage.length && new Set(assigned).size === assigned.length && assigned.every(id => wanted.has(id)), 'PROJECT_PAPER_PLAN_OUTPUT_INVALID');
  return { normalized, repairLog };
}
export const planBinding = p => ({ paperId: p.paperId, target: p.target, material: p.material, resources: p.resources, promptSha256: p.promptSha256, ledgerSha256: p.ledgerSha256 });
// Literal outer framing only. This neither interprets nor makes TeX safe to execute.
export function paperStitchText(blocks, maxBytes) {
  const reject = code => { throw Object.assign(new Error(code), { code }); };
  const unsupported = () => reject('PROJECT_PAPER_STITCH_TEX_UNSUPPORTED');
  const outside = /\\(?:begin|end)\s*\{\s*document\s*\}|\\documentclass\b/;
  const document = /\\(?:begin|end)\s*\{\s*document\s*\}/g;
  const classLine = /^[ \t]*\\documentclass[ \t]*(?:\[[^\]\r\n]*\][ \t]*)?\{[^\s{}\\]+\}[ \t]*(?:%[^\r\n]*)?\r?$/m;
  const { preamble, frontmatter, bibliography } = blocks;
  if (!classLine.test(preamble) || (preamble.match(/\\documentclass\b/g) ?? []).length !== 1 || /\\(?:begin|end)\s*\{\s*document\s*\}/.test(preamble)
    || (frontmatter.match(/\\documentclass\b/g) ?? []).length || !/^\s*\\begin\{document\}[ \t]*\r?\n/.test(frontmatter)
    || (frontmatter.match(document) ?? []).length !== 1 || outside.test(bibliography)) unsupported();
  const emptyBib = /^\s*$/.test(bibliography)
    || /^\s*\\begin\{thebibliography\}\{[^{}\r\n]*\}\s*\\end\{thebibliography\}\s*$/.test(bibliography);
  if (Buffer.byteLength(preamble) + Buffer.byteLength(frontmatter) + (emptyBib ? 0 : Buffer.byteLength(bibliography)) > maxBytes)
    reject('PROJECT_PAPER_STITCH_TOO_LARGE');
  const header = preamble + '\n' + frontmatter, closer = '\\end{document}\n';
  const framed = text => text.endsWith('\n') ? text : text + '\n';
  const withoutSections = [framed(header), ...(emptyBib ? [] : [framed(bibliography)]), closer];
  let used = withoutSections.reduce((sum, part) => sum + Buffer.byteLength(part), withoutSections.length - 1);
  const reversed = [];
  const budget = bytes => { if (used + bytes > maxBytes) reject('PROJECT_PAPER_STITCH_TOO_LARGE'); };
  budget(0);
  return {
    // Fail before loading a fragment whose saved byte count cannot fit.
    checkNext: bytes => budget(bytes + 1),
    addPrevious(tex) {
      if (outside.test(tex)) unsupported();
      const part = framed(tex), n = Buffer.byteLength(part) + 1;
      budget(n); used += n; reversed.push(part);
    },
    finish() {
      return { bytes: Buffer.from([withoutSections[0], ...reversed.toReversed(), ...withoutSections.slice(1)].join('\n')),
        bibliographyStatus: emptyBib ? 'empty-omitted' : 'included' };
    },
  };
}

export function planDocuments(text, plan) {
  const blocks = splitPlannerOutput(text), sections = parsePlanSections(blocks.sections), repaired = normalizePlanCoverage(sections, plan.material.coverageFactIds);
  return { blocks, document: { schemaVersion: 1, kind: 'paper-plan', publicationStatus: 'reviewable-plan', binding: planBinding(plan), sections, normalizedSections: repaired.normalized,
    coverage: { status: 'exact-once', factIds: plan.material.coverageFactIds }, repairLog: repaired.repairLog, sectionOrdering: 'not-checked', citationStatus: 'not-requested', mathematicsStatus: 'unreviewed', compileStatus: 'not-run',
    limitations: ['Phase 1 preview only; section writers and stitch have not run.', 'No topology, citation, mathematical, style or compilation validation.'] } };
}
