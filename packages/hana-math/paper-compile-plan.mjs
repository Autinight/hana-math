// Pure subset of wip/0.18.0-inherited (c30a17d) paper-compile.mjs.
// No attachment, runtime, resource authorization or App entrypoint is wired here.
import path from 'node:path';
import { createHash } from 'node:crypto';

const TEXT_MAX = 2 * 1024 * 1024, PDF_MAX = 64 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function requireCheck(ok, reason) {
  if (ok) return;
  const code = `PAPER_COMPILE_${reason}`;
  throw Object.assign(new Error(code), { code });
}
const canonical = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
  && path.normalize(value) === value && (value === path.parse(value).root || !value.endsWith(path.sep)) && !/[\x00-\x1f\x7f]/.test(value);
const contains = (root, child) => child === root || child.startsWith(root + path.sep);
const rootsValid = roots => Array.isArray(roots) && roots.length <= 64 && new Set(roots).size === roots.length
  && Array.from(roots).every(root => canonical(root) && root !== path.parse(root).root);
const bytesWithin = (value, max) => value instanceof Uint8Array && value.length > 0 && value.length <= max;
function decode(bytes) {
  requireCheck(bytesWithin(bytes, TEXT_MAX), 'DIAGNOSTIC_INVALID');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { requireCheck(false, 'DIAGNOSTIC_INVALID'); }
}

// The caller must bind a fresh job cwd and actually authorize executable and
// read roots through Host/ResourceIO. Lexical checks do not establish authority.
export function buildPaperCompilePlan({ sourceBytes, sourceSha256, cwd, command, readRoots, taskId }) {
  requireCheck(bytesWithin(sourceBytes, TEXT_MAX) && typeof sourceSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(sourceSha256) && sha(sourceBytes) === sourceSha256, 'SOURCE_INVALID');
  requireCheck(canonical(cwd) && cwd !== path.parse(cwd).root && canonical(command)
    && ['pdftex', 'pdflatex'].includes(path.basename(command)) && rootsValid(readRoots)
    && readRoots.some(root => contains(root, command)), 'PATH_INVALID');
  requireCheck(typeof taskId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(taskId), 'TASK_INVALID');
  return { runtime: 'command', profile: 'scoped', network: 'none', taskId, command, cwd, readRoots: [...readRoots],
    args: ['-fmt=pdflatex', '-progname=pdflatex', '-no-shell-escape', '-no-parse-first-line',
      '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-recorder',
      '-cnf-line=openin_any=p', '-cnf-line=openout_any=p',
      '-cnf-line=MKTEXFMT=0', '-cnf-line=MKTEXPK=0', '-cnf-line=MKTEXTFM=0', '-cnf-line=MKTEXTEX=0',
      '-no-mktex=tex', '-no-mktex=tfm', '-no-mktex=pk', 'main.tex'] };
}

// Retrospective lexical recorder check and PDF envelope only. Realpath checks,
// isolation, exit/timeout handling and PDF interpretation are not supplied here.
export function checkPaperCompileOutput({ logBytes, flsBytes, pdfBytes, cwd, readRoots, pass }) {
  requireCheck(canonical(cwd) && cwd !== path.parse(cwd).root && rootsValid(readRoots) && (pass === 1 || pass === 2), 'INPUT_INVALID');
  const log = decode(logBytes), fls = decode(flsBytes);
  requireCheck(/^This is pdfTeX[, ]/.test(log) && !log.includes('\0'), 'LOG_INVALID');
  requireCheck(!/(?:^|\n)\s*!|(?:LaTeX|Package\s+[^\r\n]+) Error:|Fatal error|Emergency stop|error occurred|^.+:\d+:.*(?:Error|Undefined control sequence)/im.test(log), 'TEX_ERROR');
  if (pass === 2) requireCheck(!/undefined|Rerun|re-run|Please\s+(?:\(re\))?run|Label\(s\) may have changed/i.test(log), 'REFERENCES_UNSETTLED');
  requireCheck(/Output written on main\.pdf\s*\(/.test(log), 'LOG_INVALID');
  requireCheck(bytesWithin(pdfBytes, PDF_MAX) && pdfBytes.length > 8
    && /^%PDF-(?:1\.[0-9]|2\.0)(?:\r|\n)/.test(Buffer.from(pdfBytes.subarray(0, 16)).toString('latin1'))
    && /%%EOF[\t\r\n ]*$/.test(Buffer.from(pdfBytes.subarray(-1024)).toString('latin1')), 'PDF_INVALID');
  const lines = fls.split(/\r?\n/), inputs = new Set();
  requireCheck(lines.length <= 32768, 'RECORDER_INVALID');
  let pwd = false, output = false;
  for (const line of lines) {
    if (!line) continue;
    const match = /^(PWD|INPUT|OUTPUT) (.+)$/.exec(line);
    requireCheck(match && !/[\x00-\x1f\x7f]/.test(match[2]), 'RECORDER_INVALID');
    const [, kind, name] = match, file = path.resolve(cwd, name);
    if (kind === 'PWD') { requireCheck(name === cwd, 'RECORDER_INVALID'); pwd = true; continue; }
    requireCheck(contains(cwd, file) || kind === 'INPUT' && readRoots.some(root => contains(root, file)), 'RECORDER_OUTSIDE_ROOTS');
    if (kind === 'INPUT') inputs.add(file);
    if (kind === 'OUTPUT' && file === path.join(cwd, 'main.pdf')) output = true;
  }
  requireCheck(pwd && output && inputs.has(path.join(cwd, 'main.tex')), 'RECORDER_INVALID');
  return { inputs: [...inputs], pdfSha256: sha(pdfBytes), pdfBytes: pdfBytes.length, logSha256: sha(logBytes), flsSha256: sha(flsBytes) };
}
