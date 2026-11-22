// Pure report assembly and leak checks, mirroring Danus human_summary.
import { readFile } from 'node:fs/promises';

export const WRITER_PROMPT_REL = 'REPORT_WRITER_PROMPT.md';
const WRITER_PROMPT_URL = new URL('./references/danus/agents/skills/human-summary/REPORT_WRITER_PROMPT.md', import.meta.url);
export const DEFAULT_LANGUAGE = 'English';
// Only the language name crosses into the prompt: ASCII letters, spaces, hyphens.
export const LANGUAGE = /^[A-Za-z][A-Za-z -]{0,63}$/;
export const NO_RESULTS = '_(no verified results are available for this project yet)_\n';

const failure = code => Object.assign(new Error(code), { code });
function check(ok, code) { if (!ok) throw failure(code); }

// Danus server._LEAK_PATTERNS, same order and labels.
export const LEAK_PATTERNS = Object.freeze([
  [/\b[0-9a-f]{16}\b/, '16-hex id (fact_id / hash prefix)'],
  [/^\s*author:/im, "'author:' frontmatter line"],
  [/\bpredecessors\b/i, "'predecessors' (frontmatter / DAG vocabulary)"],
  [/\bfact_[a-z0-9_]+/i, "'fact_' slug / identifier"],
  [/\bmaster_guidance\b/i, "'master_guidance' (strategy-consult machinery)"],
  [/\bfact_submit\b/i, "'fact_submit' (pipeline verb)"],
  [/\bverifier\b/i, "'verifier' (system machinery)"],
  [/\bworker\b/i, "'worker' (swarm machinery)"],
  [/\bglobal memory\b/i, "'global memory' (system store)"],
]);

export function leakFindings(text) {
  const hits = [];
  for (const [pattern, label] of LEAK_PATTERNS) {
    const match = pattern.exec(text);
    if (match) hits.push(`${label}: matched ${JSON.stringify(match[0])}`);
  }
  return hits;
}

// authoring.common.body_sections: everything from the first `## ` heading on;
// the YAML frontmatter never reaches the writer.
export function bodySections(raw) {
  const lines = String(raw).split(/\r\n|\r|\n/);
  const start = lines.findIndex(line => line.trimStart().startsWith('## '));
  if (start >= 0) return lines.slice(start).join('\n').trimEnd() + '\n';
  if (lines.length && lines[0].trim() === '---') {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (close > 0) return lines.slice(close + 1).join('\n').trim() + '\n';
  }
  return String(raw).trim() + '\n';
}

// assemble._ordered_load_bearing: Kahn topological order; within the ready set
// prefer higher dependency depth, then higher in-degree, then smaller id.
export function orderFacts(facts) {
  const preds = new Map(facts.map(fact => [fact.fact_id, [...fact.predecessors]]));
  const ids = [...preds.keys()];
  if (!ids.length) return [];
  const depthCache = new Map();
  const depth = id => {
    if (depthCache.has(id)) return depthCache.get(id);
    depthCache.set(id, 0); // a back-edge counts as depth 0
    const list = preds.get(id) ?? [];
    const value = list.length ? 1 + Math.max(...list.map(depth)) : 0;
    depthCache.set(id, value); return value;
  };
  const depths = new Map(ids.map(id => [id, depth(id)]));
  const indeg = new Map(ids.map(id => [id, 0]));
  for (const id of ids) for (const p of preds.get(id)) if (indeg.has(p)) indeg.set(p, indeg.get(p) + 1);
  const inside = new Map(ids.map(id => [id, preds.get(id).filter(p => preds.has(p))]));
  const placed = new Set(), ordered = [], remaining = new Set(ids);
  const byId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  while (remaining.size) {
    let ready = [...remaining].filter(id => inside.get(id).every(p => placed.has(p)));
    if (!ready.length) ready = [...remaining].sort(byId); // cycle: deterministic fallback
    ready.sort((a, b) => depths.get(b) - depths.get(a) || indeg.get(b) - indeg.get(a) || byId(a, b));
    const chosen = ready[0];
    ordered.push(chosen); placed.add(chosen); remaining.delete(chosen);
  }
  return ordered;
}

// facts: [{ fact_id, predecessors, markdown }]. No id or frontmatter is emitted.
export function factBundle(facts) {
  const byId = new Map(facts.map(fact => [fact.fact_id, fact]));
  const ids = orderFacts(facts);
  if (!ids.length) return NO_RESULTS;
  const resultById = new Map(ids.map((id, index) => [id, `Result ${index + 1}`]));
  return ids.map((id, index) => {
    const original = bodySections(byId.get(id).markdown ?? '');
    const body = original.split(/(https?:\/\/[^\s<>`]+)/gi).map(part => {
      if (/^https?:\/\//i.test(part)) return part;
      let body = part;
      for (const [factId, result] of resultById) {
      // Replace whole locators before bare IDs; leave surrounding code/math
      // delimiters intact rather than independently consuming backticks.
      const pathLocator = new RegExp(`(?:runtime/projects/[A-Za-z0-9_.-]+/)?fact_graph/facts/(?:<${factId}>|${factId})\\.md`, 'gi');
      body = body.replace(pathLocator, result);
      const label = '(?:`fact_id`|`factId`|fact_id|factId)';
      body = body.replace(new RegExp(`${label}\\s*[:=]?\\s*(?:<${factId}>|\\x60${factId}\\x60|${factId})(?![A-Za-z0-9_])`, 'gi'), result);
      body = body.replace(new RegExp(`(?<![A-Za-z0-9_])${factId}(?![A-Za-z0-9_])`, 'gi'), result);
    }
      if (/\b[0-9a-f]{16}\b/i.test(body) || /\bfact_[a-z0-9_]+\b/i.test(body)
        || /\bfactId\b|fact_graph\/facts\//.test(body)) {
        throw failure('PROJECT_SUMMARY_UNRESOLVED_REFERENCE');
      }
      return body;
    }).join('');
    return `--- Result ${index + 1} ---\n${body}`;
  }).join('\n');
}

export function section(name, body) { return `\n\n===== BEGIN ${name} =====\n${body}\n===== END ${name} =====\n`; }

// assemble.build_prompt with the same opening text and section names.
export function buildPrompt({ writerPrompt, problem, facts, language = DEFAULT_LANGUAGE }) {
  check(typeof writerPrompt === 'string' && writerPrompt.length > 0 && typeof problem === 'string' && Array.isArray(facts)
    && typeof language === 'string' && LANGUAGE.test(language), 'PROJECT_INVALID_INPUT');
  return [
    'You are the REPORT WRITER. Everything you need is embedded below; you have '
      + 'no filesystem to read and no tools. Write the human-facing progress report '
      + 'per the rules, from ONLY the problem statement and the scrubbed results '
      + 'below. You have no identifiers, no author names, and no system vocabulary '
      + '— never invent or mention any.',
    `\n\nReport language: ${language}. Write the narrative in ${language}; keep `
      + 'ALL standard mathematical terminology in English regardless (never a '
      + 'native-language calque for an established term) — see the register rule in '
      + 'the writer prompt. The mathematics is identical in any language.',
    section(WRITER_PROMPT_REL, writerPrompt),
    section('PROBLEM.md (verbatim goal)', problem),
    section('VERIFIED_RESULTS (scrubbed, id-free)', factBundle(facts)),
  ].join('');
}

// Read at call time, verbatim and in full; a missing file fails loudly.
export async function readWriterPrompt() { return readFile(WRITER_PROMPT_URL, 'utf8'); }

export { createSummaryWriter } from './report-writer.mjs';
