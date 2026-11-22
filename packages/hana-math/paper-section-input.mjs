// Own-data snapshots before authority awaits; section selectors only, no paths.
import { snapshotPlanData } from './paper-plan-input.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const project = v => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
const report = v => typeof v === 'string' && /^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
function selector(input, code) {
  if (!object(input) || !Object.hasOwn(input, 'planReportId') || !report(input.planReportId)
    || Object.keys(input).some(k => !['planReportId', 'previousSectionReportId'].includes(k))
    || Object.hasOwn(input, 'previousSectionReportId') && !report(input.previousSectionReportId)) fail(code);
}
export function snapshotPaperSectionRequest(value, { tool = false, read = false, code = 'PROJECT_INVALID_INPUT' } = {}) {
  const input = snapshotPlanData(value, code);
  const allowed = ['projectId', ...(tool ? ['action'] : []), ...(read ? ['reportId'] : ['planReportId', 'previousSectionReportId'])];
  if (!object(input) || !Object.hasOwn(input, 'projectId') || !project(input.projectId)
    || Object.keys(input).some(k => !allowed.includes(k)) || tool && (!Object.hasOwn(input, 'action') || typeof input.action !== 'string' || !input.action)) fail(code);
  // Action dispatch belongs to the tool boundary; this snapshot does not invent
  // or authorize public status/result/stop action names.
  if (read) { if (!Object.hasOwn(input, 'reportId') || !report(input.reportId)) fail(code); }
  else selector(Object.fromEntries(Object.entries(input).filter(([k]) => !['projectId', 'action'].includes(k))), code);
  return input;
}
export function snapshotPaperStitchRequest(value, { tool = false, code = 'PROJECT_INVALID_INPUT' } = {}) {
  const input = snapshotPlanData(value, code), keys = ['projectId', 'planReportId', 'finalSectionReportId', ...(tool ? ['action'] : [])];
  if (!object(input) || Object.keys(input).length !== keys.length || !keys.every(k => Object.hasOwn(input, k))
    || !project(input.projectId) || !report(input.planReportId) || !report(input.finalSectionReportId)
    || tool && input.action !== 'paper_stitch') fail(code);
  return input;
}
export function snapshotPaperSectionStart(value) {
  const code = 'PROJECT_INVALID_INPUT', input = snapshotPlanData(value, code);
  if (!object(input) || Object.keys(input).some(k => !['projectId', 'kind', 'language', 'section'].includes(k))
    || input.kind !== 'paper-section' || input.language !== 'English' || !Object.hasOwn(input, 'section')
    || Object.hasOwn(input, 'projectId') && !project(input.projectId)) fail(code);
  selector(input.section, code); return input;
}
