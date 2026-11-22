// Pure persisted shape and archive DTO. No kinds import, IO, parent lookup or
// current-resource pin checks: valid historical/dirty ownership must load.
import { snapshotPlanData } from './paper-plan-input.mjs';
import { planHash } from './paper-plan.mjs';
import { splitSectionOutput } from './paper-section.mjs';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const sha = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const slug = v => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
const report = v => typeof v === 'string' && /^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const ids = (v, max) => Array.isArray(v) && v.length <= max && v.every(id => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id)) && new Set(v).size === v.length;
const field = v => typeof v === 'string' && v.isWellFormed() && !v.includes('\0') && Buffer.byteLength(v) <= 4096
  && /[^\t-\r\x1c-\x20\x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(v);
const MATERIAL = ['schemaVersion', 'sectionIndex', 'title', 'label', 'factIds', 'referenceFactIds', 'localClosureFactIds', 'parentMaterialSha256', 'sha256'];
const RESOURCES = ['contract', 'sectionWriterPrompt', 'style', 'structure'];
function shape(b, projectId, reportId) {
  if (!exact(b, ['schemaVersion', 'source', 'lineage', 'sectionCount', 'material', 'resources', 'promptSha256']) || b.schemaVersion !== 1
    || !slug(projectId) || !Number.isSafeInteger(b.sectionCount) || b.sectionCount < 1 || b.sectionCount > 129 || !sha(b.promptSha256)
    || !exact(b.source, ['projectId', 'planReportId', 'paperId', 'planBindingSha256', 'artifacts']) || b.source.projectId !== projectId
    || !report(b.source.planReportId) || !slug(b.source.paperId) || !sha(b.source.planBindingSha256)
    || !exact(b.source.artifacts, ['response', 'blocks', 'plan', 'ledger'])
    || !Object.values(b.source.artifacts).every(a => exact(a, ['sha256', 'bytes']) && sha(a.sha256) && Number.isSafeInteger(a.bytes) && a.bytes >= 0)
    || !exact(b.resources, RESOURCES) || !Object.values(b.resources).every(sha)) return false;
  const m = b.material, l = b.lineage;
  if (!exact(m, MATERIAL) || m.schemaVersion !== 1 || !Number.isSafeInteger(m.sectionIndex) || m.sectionIndex < 0 || m.sectionIndex >= b.sectionCount
    || !field(m.title) || !field(m.label) || !ids(m.factIds, 64) || !ids(m.referenceFactIds, 2048) || !ids(m.localClosureFactIds, 2048)
    || !sha(m.parentMaterialSha256) || !sha(m.sha256)
    || m.factIds.length === 0 && (m.referenceFactIds.length !== 0 || m.localClosureFactIds.length !== 0)
    || !m.factIds.every(id => m.localClosureFactIds.includes(id))
    || !m.referenceFactIds.every(id => !m.factIds.includes(id) && m.localClosureFactIds.includes(id))) return false;
  // Reconstruct A's deterministic field order, not a caller's object-key order.
  const payload = Object.fromEntries(MATERIAL.filter(k => k !== 'sha256').map(k => [k, m[k]]));
  if (planHash(JSON.stringify(payload)) !== m.sha256
    || !exact(l, ['chainRootReportId', 'previousSectionReportId', 'previousSourceSha256', 'previousResultSha256']) || !report(l.chainRootReportId)) return false;
  if (m.sectionIndex === 0) return (reportId === undefined || l.chainRootReportId === reportId)
    && l.previousSectionReportId === null && l.previousSourceSha256 === null && l.previousResultSha256 === null;
  return report(l.previousSectionReportId) && sha(l.previousSourceSha256) && sha(l.previousResultSha256)
    && (reportId === undefined || l.chainRootReportId !== reportId && l.previousSectionReportId !== reportId)
    && (m.sectionIndex === 1 ? l.previousSectionReportId === l.chainRootReportId : l.previousSectionReportId !== l.chainRootReportId);
}
export function validSectionBinding(value, projectId, reportId) {
  if (!report(reportId)) return false;
  try { return shape(snapshotPlanData(value), projectId, reportId); } catch { return false; }
}
const invalid = code => { throw Object.assign(new Error(code), { code }); };
// Bounded diagnostics, with explicit truncation; never use these bounded arrays
// to decide readiness. Preserve the full raw response separately in B2.
function bounded(findings) {
  const clip = s => { let value = '', bytes = 0; for (const c of s) { const n = Buffer.byteLength(c); if (bytes + n > 1024) break; value += c; bytes += n; } return value; };
  const limits = { leaks: 5, blockers: 32, warnings: 32 };
  const value = Object.fromEntries(Object.entries(limits).map(([k, max]) => [k, findings[k].slice(0, max).map(clip)]));
  return { value, truncated: Object.keys(limits).some(k => value[k].length !== findings[k].length || value[k].some((v, i) => v !== findings[k][i])) };
}
export function sectionDocuments(raw, binding) {
  const copy = snapshotPlanData(binding, 'PROJECT_PAPER_SECTION_BINDING_INVALID');
  // Current report identity lives in outer metadata, so this DTO checks shape;
  // validSectionBinding(meta.section, meta.projectId, meta.reportId) checks self.
  if (!shape(copy, copy?.source?.projectId)) invalid('PROJECT_PAPER_SECTION_BINDING_INVALID');
  const { tex, provenance, findings } = splitSectionOutput(raw, copy.material.factIds);
  // Hana fragment delivery guard, NOT an upstream parser/section-label gate.
  if (!tex.trim()) invalid('PROJECT_PAPER_SECTION_OUTPUT_EMPTY');
  const leaks = findings.leaks.length > 0, blockers = findings.blockers.length > 0, limited = bounded(findings);
  return { tex, provenance, document: { schemaVersion: 1, kind: 'paper-section', binding: copy, findings: limited.value, findingsTruncated: limited.truncated,
    provenanceStatus: provenance === null ? 'missing' : 'available-unverified', sourceStatus: leaks ? 'leaked' : blockers ? 'flagged' : 'generated',
    publicationStatus: leaks ? 'not-ready' : 'reviewable-section', sectionOrdering: 'not-checked', citationStatus: 'not-requested', mathematicsStatus: 'unreviewed', compileStatus: 'not-run',
    limitations: ['One section fragment only; assigned IDs are input assignments, not verified body coverage.',
      'No section-label, macro, full-document, ordering, citation, mathematical or compilation validation.',
      'Provenance is optional unverified enrichment; raw output and inherited ledger remain separate artifacts.',
      'Leaks prevent delivery; blockers are flags, not repaired or certified.'] } };
}
