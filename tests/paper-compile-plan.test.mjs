// Pure fixtures: no fs, SDK, runtime, or TeX process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildPaperCompilePlan, checkPaperCompileOutput } from '../packages/hana-math/paper-compile-plan.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = Buffer.from('opaque text, never compiled\n'), cwd = '/fixture/app-data/job', tex = '/fixture/tex';
const fixture = { sourceBytes, sourceSha256: sha(sourceBytes), cwd, command: tex + '/bin/pdftex', readRoots: [tex], taskId: 'fixture-task' };
const fail = (fn, code) => assert.throws(fn, { code: `PAPER_COMPILE_${code}` });
const log = extra => Buffer.from(`This is pdfTeX, fixture only\n${extra}\nOutput written on main.pdf (1 page).\n`);
const pdf = Buffer.from('%PDF-1.7\nfixture, not a parseable PDF\n%%EOF\n');
const fls = extra => Buffer.from(`PWD ${cwd}\nINPUT main.tex\nINPUT ${tex}/format/pdflatex.fmt\nOUTPUT main.pdf\n${extra}`);
const output = { cwd, readRoots: [tex], pass: 2, logBytes: log(''), flsBytes: fls(''), pdfBytes: pdf };

test('pure plan pins scoped/network-none command, cwd, flags and one filename', () => {
  const p = buildPaperCompilePlan(fixture);
  assert.deepEqual(Object.keys(p).sort(), ['args','command','cwd','network','profile','readRoots','runtime','taskId']);
  assert.partialDeepStrictEqual(p, { profile: 'scoped', network: 'none', runtime: 'command', cwd, command: fixture.command, taskId: fixture.taskId });
  assert.deepEqual(p.readRoots, fixture.readRoots); assert.notEqual(p.readRoots, fixture.readRoots);
  assert.deepEqual(p.args, ['-fmt=pdflatex', '-progname=pdflatex', '-no-shell-escape', '-no-parse-first-line', '-interaction=nonstopmode',
    '-halt-on-error', '-file-line-error', '-recorder', '-cnf-line=openin_any=p', '-cnf-line=openout_any=p',
    '-cnf-line=MKTEXFMT=0', '-cnf-line=MKTEXPK=0', '-cnf-line=MKTEXTFM=0', '-cnf-line=MKTEXTEX=0', '-no-mktex=tex', '-no-mktex=tfm', '-no-mktex=pk', 'main.tex']);
});
test('pure plan refuses wrong source hash or absent task binding', () => {
  fail(() => buildPaperCompilePlan({ ...fixture, sourceSha256: '0'.repeat(64) }), 'SOURCE_INVALID');
  fail(() => buildPaperCompilePlan({ ...fixture, taskId: undefined }), 'TASK_INVALID');
});
test('pure plan rejects broad, sparse, duplicate roots and escaping or noncanonical paths', () => {
  for (const invalid of [{ cwd: '/' }, { cwd: cwd + '/../job' }, { readRoots: ['/'] }, { readRoots: [tex, ,] }, { readRoots: [tex, tex] },
    { command: '/fixture/tex-adjacent/bin/pdftex' }, { command: tex + '/bin/sh' }])
    fail(() => buildPaperCompilePlan({ ...fixture, ...invalid }), 'PATH_INVALID');
});
test('pass 1 may request a rerun and pass 2 must settle; record only a PDF envelope and digests', () => {
  const asks = log('LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.');
  const first = checkPaperCompileOutput({ ...output, logBytes: asks, pass: 1 });
  fail(() => checkPaperCompileOutput({ ...output, logBytes: asks }), 'REFERENCES_UNSETTLED');
  const second = checkPaperCompileOutput(output);
  assert.notEqual(first.logSha256, second.logSha256);
  assert.deepEqual(second, { inputs: [cwd + '/main.tex', tex + '/format/pdflatex.fmt'],
    pdfSha256: sha(pdf), pdfBytes: pdf.length, logSha256: sha(output.logBytes), flsSha256: sha(output.flsBytes) });
});
test('reject TeX failure even with success-looking PDF message, missing success log and invalid PDF envelope', () => {
  fail(() => checkPaperCompileOutput({ ...output, logBytes: log('! Undefined control sequence.'), pass: 1 }), 'TEX_ERROR');
  fail(() => checkPaperCompileOutput({ ...output, logBytes: Buffer.from('This is pdfTeX, fixture only\n') }), 'LOG_INVALID');
  fail(() => checkPaperCompileOutput({ ...output, pdfBytes: Buffer.from('%PDF-1.7\ntruncated\n') }), 'PDF_INVALID');
});
test('recorder refuses input beyond the roots, writes to read-only trees and missing job evidence', () => {
  fail(() => checkPaperCompileOutput({ ...output, flsBytes: fls('INPUT ../other-task/main.tex\n') }), 'RECORDER_OUTSIDE_ROOTS');
  fail(() => checkPaperCompileOutput({ ...output, flsBytes: fls(`INPUT ${tex}-other/file\n`) }), 'RECORDER_OUTSIDE_ROOTS');
  fail(() => checkPaperCompileOutput({ ...output, flsBytes: fls(`OUTPUT ${tex}/changed\n`) }), 'RECORDER_OUTSIDE_ROOTS');
  for (const value of [fls('ALIEN record\n'), Buffer.from(`PWD ${cwd}/wrong\nINPUT main.tex\nOUTPUT main.pdf\n`), Buffer.from(`PWD ${cwd}\nINPUT main.tex\nOUTPUT main.log\n`)])
    fail(() => checkPaperCompileOutput({ ...output, flsBytes: value }), 'RECORDER_INVALID');
});
