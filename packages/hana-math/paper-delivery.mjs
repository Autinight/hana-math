// Pure delivery gate and explicit override disclosure contract.
// No Host SDK, storage, model, TeX execution or outward push authority.
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { referenceVerificationKeys } from './reference-verification.mjs';
import { checkPaperCompileOutput } from './paper-compile-plan.mjs';

const REPORT_ID = /^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function plainData(value, allowed, required, code) {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const keys = Reflect.ownKeys(value);
  if (!keys.every(key => typeof key === 'string' && allowed.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
    || !required.every(key => keys.includes(key))) fail(code);
  return Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(value, key).value]));
}

export const validOverrideReason = value => typeof value === 'string' && value.isWellFormed()
  && !value.includes('\0') && value.trim().length > 0 && Buffer.byteLength(value) <= 2048;

export function snapshotPaperDeliveryRequest(input, { tool = false, code = 'PROJECT_INVALID_INPUT' } = {}) {
  const base = ['projectId', ...(tool ? ['action'] : []), 'mathReviewReportId'];
  const result = plainData(input, [...base, 'reportId', 'planReportId', 'finalSectionReportId', 'override', 'allowUncompiledTex'], base, code);
  if (tool && result.action !== 'paper_deliver') fail(code);
  if (typeof result.projectId !== 'string' || !PROJECT_ID.test(result.projectId)
    || typeof result.mathReviewReportId !== 'string' || !REPORT_ID.test(result.mathReviewReportId)) fail(code);
  if (Object.hasOwn(result, 'reportId')) {
    if (Object.hasOwn(result, 'planReportId') || Object.hasOwn(result, 'finalSectionReportId')
      || typeof result.reportId !== 'string' || !REPORT_ID.test(result.reportId)) fail(code);
  } else {
    if (!Object.hasOwn(result, 'planReportId') || !Object.hasOwn(result, 'finalSectionReportId')
      || typeof result.planReportId !== 'string' || !REPORT_ID.test(result.planReportId)
      || typeof result.finalSectionReportId !== 'string' || !REPORT_ID.test(result.finalSectionReportId)) fail(code);
  }
  if (Object.hasOwn(result, 'allowUncompiledTex') && typeof result.allowUncompiledTex !== 'boolean') fail(code);
  if (Object.hasOwn(result, 'override')) {
    const ov = plainData(result.override, ['reason'], ['reason'], code);
    if (!validOverrideReason(ov.reason)) fail(code);
    result.override = ov;
  }
  return result;
}

const sanitizeLatexInline = text => text.replace(/[\r\n]+/g, ' ').replace(/[\\{}%#$&_^~]/g, c => ({
  '\\': ' ', '{': '(', '}': ')', '%': ' percent ', '#': ' ', '$': ' USD ', '&': ' and ', '_': '-', '^': ' ', '~': ' ',
}[c] ?? ' ')).replace(/\s+/g, ' ').trim();

/** Inject a visible disclosure line into a delivered copy without mutating archived source. */
export function applyOverrideDisclosure(mainTex, { reason, mathReviewReportId, mustFixCount }) {
  check(typeof mainTex === 'string' && mainTex.isWellFormed() && !mainTex.includes('\0') && mainTex.length > 0, 'PROJECT_PAPER_DELIVERY_INVALID');
  check(validOverrideReason(reason) && REPORT_ID.test(mathReviewReportId) && Number.isSafeInteger(mustFixCount) && mustFixCount > 0, 'PROJECT_PAPER_DELIVERY_INVALID');
  const endMarker = '\\end{document}';
  const index = mainTex.lastIndexOf(endMarker);
  check(index >= 0, 'PROJECT_PAPER_DELIVERY_INVALID');
  const safeReason = sanitizeLatexInline(reason);
  const disclosure = `\\note{[math-override] Delivered by explicit operator override with ${mustFixCount} unresolved must-fix finding(s) from ${mathReviewReportId}: ${safeReason}}`;
  const prefix = mainTex.slice(0, index);
  const separator = prefix.endsWith('\n') ? '' : '\n';
  return { tex: `${prefix}${separator}${disclosure}\n${mainTex.slice(index)}`, disclosure };
}

/**
 * Deterministic delivery gate:
 * - Normal delivery (`deliverOk: true`) requires BOTH exact-bound math review passing (or explicit operator override) AND verified TeX compilation on the exact same `mainSha256`.
 * - A stale or mismatched math review (`mainSha256` or `ledgerSha256` differs) ALWAYS fails closed, even with `override`.
 * - An explicit `override` on `wrong` produces a visible disclosure line and records every unresolved `must-fix` finding in the manifest.
 * - `ignorable` findings are always attached verbatim for operator visibility.
 */
export function evaluatePaperDelivery({
  projectId,
  manuscript,
  mathReview,
  compileEvidence = null,
  override = null,
  allowUncompiledTex = false,
}) {
  check(typeof projectId === 'string' && PROJECT_ID.test(projectId), 'PROJECT_PAPER_DELIVERY_INVALID');
  check(manuscript && manuscript.mainBytes instanceof Uint8Array && manuscript.ledgerBytes instanceof Uint8Array
    && SHA256.test(manuscript.mainSha256) && SHA256.test(manuscript.ledgerSha256)
    && sha(manuscript.mainBytes) === manuscript.mainSha256 && sha(manuscript.ledgerBytes) === manuscript.ledgerSha256,
  'PROJECT_PAPER_DELIVERY_INVALID');
  check(mathReview && mathReview.schemaVersion === 1 && mathReview.kind === 'paper-math-verification'
    && mathReview.projectId === projectId && REPORT_ID.test(mathReview.reportId)
    && ['correct', 'wrong'].includes(mathReview.verdict) && Array.isArray(mathReview.findings)
    && mathReview.binding && SHA256.test(mathReview.binding.mainSha256) && SHA256.test(mathReview.binding.ledgerSha256),
  'PROJECT_PAPER_DELIVERY_REVIEW_INVALID');
  check(mathReview.binding.mainSha256 === manuscript.mainSha256
    && mathReview.binding.ledgerSha256 === manuscript.ledgerSha256,
  'PROJECT_PAPER_DELIVERY_REVIEW_MISMATCH');

  const mustFixFindings = mathReview.findings.filter(f => f.class === 'must-fix');
  const ignorableFindings = mathReview.findings.filter(f => f.class === 'ignorable');
  check((mathReview.verdict === 'wrong') === (mustFixFindings.length > 0), 'PROJECT_PAPER_DELIVERY_REVIEW_INVALID');

  if (override !== null) {
    check(typeof override === 'object' && validOverrideReason(override.reason), 'PROJECT_INVALID_INPUT');
  }

  let mathGate = 'passed';
  let overrideApplied = false;
  let overrideDisclosure = null;
  let deliveredTexBytes = Buffer.from(manuscript.mainBytes);
  const blockers = [];

  if (mathReview.verdict === 'wrong') {
    if (override) {
      mathGate = 'overridden';
      overrideApplied = true;
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(manuscript.mainBytes);
      const patched = applyOverrideDisclosure(decoded, {
        reason: override.reason, mathReviewReportId: mathReview.reportId, mustFixCount: mustFixFindings.length,
      });
      deliveredTexBytes = Buffer.from(patched.tex, 'utf8');
      overrideDisclosure = patched.disclosure;
    } else {
      mathGate = 'blocked';
      blockers.push(`math_verification_wrong: ${mustFixFindings.length} unresolved must-fix finding(s)`);
    }
  }

  let compileGate = 'not-run';
  let compileSummary = null;
  if (compileEvidence !== null) {
    check(compileEvidence && typeof compileEvidence === 'object'
      && compileEvidence.sourceSha256 === manuscript.mainSha256, 'PROJECT_PAPER_DELIVERY_COMPILE_MISMATCH');
    const checked = checkPaperCompileOutput({
      logBytes: compileEvidence.logBytes, flsBytes: compileEvidence.flsBytes, pdfBytes: compileEvidence.pdfBytes,
      cwd: compileEvidence.cwd, readRoots: compileEvidence.readRoots, pass: compileEvidence.pass ?? 2,
    });
    compileGate = 'passed';
    compileSummary = { ...checked, sourceSha256: manuscript.mainSha256, pass: compileEvidence.pass ?? 2 };
  } else {
    blockers.push('compile_not_run: managed TeX compilation has not been verified for this manuscript version');
  }

  const ledgerText = new TextDecoder('utf-8', { fatal: true }).decode(manuscript.ledgerBytes);
  const unverifiedCitationKeys = referenceVerificationKeys(ledgerText);
  const citationGate = unverifiedCitationKeys.length === 0 ? 'no-unverified-ledger-entries' : 'has-unverified-citations';

  const mathCleared = mathGate === 'passed' || mathGate === 'overridden';
  const deliverOk = mathCleared && compileGate === 'passed';
  const texDeliverable = mathCleared && (compileGate === 'passed' || allowUncompiledTex === true);

  const manifest = {
    schemaVersion: 1,
    kind: 'paper-delivery',
    projectId,
    manuscriptSelector: { ...manuscript.selector },
    sourceMainSha256: manuscript.mainSha256,
    deliveredMainSha256: sha(deliveredTexBytes),
    ledgerSha256: manuscript.ledgerSha256,
    mathReviewReportId: mathReview.reportId,
    mathVerdict: mathReview.verdict,
    mathGate,
    overrideApplied,
    overrideReason: overrideApplied ? override.reason : null,
    overrideDisclosure,
    mustFixCount: mustFixFindings.length,
    mustFixFindings,
    ignorableCount: ignorableFindings.length,
    ignorableFindings,
    compileStatus: compileGate,
    compileSummary,
    citationStatus: citationGate,
    unverifiedCitationKeys,
    deliverOk,
    texDeliverable,
    pdfDelivered: deliverOk,
    pushAuthorized: false,
    blockers,
    limitations: [
      'Delivery checks exact same-version binding between manuscript, ledger, math review and optional TeX compile receipt.',
      'Unverified citation keys remain flagged; push to arXiv or external LaTeX git repositories requires separate authorization.',
    ],
  };
  return {
    deliverOk, texDeliverable, mathGate, compileGate, citationGate, unverifiedCitationKeys,
    blockers, overrideApplied, overrideDisclosure, ignorableFindings, mustFixFindings,
    deliveredTexBytes, compileSummary, manifest,
  };
}
