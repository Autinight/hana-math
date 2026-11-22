// Rendering only: collection, admission limits and export ownership stay with the caller.
import { readFileSync } from 'node:fs';

const asset = name => readFileSync(new URL(`./graph/${name}`, import.meta.url), 'utf8');
const template = asset('snapshot.html');
const style = asset('snapshot.css');
const script = asset('snapshot.js');
const fid = /^[0-9a-f]{16}$/;

/** Return one portable, offline HTML document containing only the verified-fact index. */
export function renderProjectGraph(snapshot) {
  if (!snapshot || typeof snapshot.projectId !== 'string'
      || typeof snapshot.asOf !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.asOf)
      || !Number.isSafeInteger(snapshot.capturedAt) || Math.abs(snapshot.capturedAt) > 8640000000000000
      || !Array.isArray(snapshot.facts)) throw new TypeError('Invalid project graph snapshot');
  const seen = new Set();
  const facts = snapshot.facts.map(fact => {
    if (!fact || typeof fact.fact_id !== 'string' || !fid.test(fact.fact_id) || seen.has(fact.fact_id)
        || !Array.isArray(fact.predecessors) || !fact.predecessors.every(id => typeof id === 'string' && fid.test(id))
        || typeof fact.statementPreview !== 'string' || typeof fact.statementPreviewTruncated !== 'boolean'
        || !Number.isSafeInteger(fact.canonicalBytes) || fact.canonicalBytes <= 0) {
      throw new TypeError('Invalid project graph fact');
    }
    seen.add(fact.fact_id);
    // Explicit projection prevents caller extras (including proof bodies) entering the document.
    return { fact_id: fact.fact_id, predecessors: [...new Set(fact.predecessors)].sort(),
      statementPreview: fact.statementPreview, statementPreviewTruncated: fact.statementPreviewTruncated,
      canonicalBytes: fact.canonicalBytes };
  }).sort((a, b) => a.fact_id.localeCompare(b.fact_id));
  const data = JSON.stringify({ projectId: snapshot.projectId, asOf: snapshot.asOf,
    capturedAt: snapshot.capturedAt, facts }).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const replacements = { STYLE: style, SCRIPT: script, DATA: data };
  return template.replace(/@@(STYLE|SCRIPT|DATA)@@/g, (_, key) => replacements[key]);
}
