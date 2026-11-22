import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { paperStitchText } from '../packages/hana-math/paper-plan.mjs';
import { pairingFixture } from './helpers/managed-ipc-pairing-fixture.mjs';
import { origin } from './helpers/project-service-fixture.mjs';

const options = { timeout: 90000 }, fact = 'a'.repeat(16);
const preamble = '\\documentclass{article}\n', frontmatter = '\\begin{document}\n\\title{Frozen}\n\\maketitle\n';
const bib = '\\begin{thebibliography}{9}\n\\bibitem{k} Frozen citation.\n\\end{thebibliography}';
const empty = '\\begin{thebibliography}{9}\n\\end{thebibliography}';
const sha = b => createHash('sha256').update(b).digest('hex');
const fragment = (i, suffix = '') => `\\section{Part ${i}}\\label{sec:p${i}}\nFrozen  ${i}${suffix}.\n\n`;
async function setup(t, count = 1, bibliography = empty, { frame = frontmatter } = {}) {
  let output;
  const sections = Array.from({ length: count }, (_, i) => ({ title: `Part ${i}`, label: `sec:p${i}`, fact_ids: i ? [] : [fact] }));
  const g = await pairingFixture(t, { plannerOutput: `%%%PREAMBLE%%%\n${preamble}%%%FRONTMATTER%%%\n${frame}%%%SECTIONS%%%\n${JSON.stringify(sections)}\n%%%BIBLIOGRAPHY%%%\n${bibliography}`, sectionOutput: () => output });
  const plan = await g.parent(), sent = [], stageState = { fail: false, malformed: false, wrongOwner: false };
  const unused = async () => assert.fail('Unexpected worker call');
  const research = Object.fromEntries(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection'].map(k => [k, unused]));
  let tool;
  const registration = await registerMathResearch({ ...g.f.sdk, tools: { async register(value) { if (value.name === 'math_project') tool = value; return () => {}; } }, resources: { async stage(input) {
    if (stageState.fail) throw Error('Host export failed');
    if (stageState.malformed) return { ok: true, resource: { kind: 'session-file' } };
    if (stageState.wrongOwner) return { ok: true, resource: { kind: 'session-file', sessionId: 'foreign', fileId: 'not-ours' } };
    sent.push({ input, bytes: await fs.readFile(input.path) });
    return { ok: true, resource: { kind: 'session-file', sessionId: 'creator-stable', fileId: 'stitch-' + sent.length } };
  } } }, research, g.f.service);
  t.after(() => registration.dispose());
  const section = async (i, previous = null, raw = fragment(i)) => {
    output = raw; const q = await g.f.service.paperSection({ projectId: g.projectId, planReportId: plan.reportId, ...(previous ? { previousSectionReportId: previous.reportId } : {}) }, origin);
    await g.dispatch(q.reportId);
    assert.equal((await g.f.service.paperSectionStatus(g.request(q), origin)).publicationStatus, 'reviewable-section');
    return q;
  };
  const call = (end, args = {}, context = origin) => tool.execute({ action: 'paper_stitch', projectId: g.projectId, planReportId: plan.reportId, finalSectionReportId: end.reportId, ...args, context });
  return { ...g, plan, section, call, sent, stageState, tool };
}
const rejected = (reply, code) => {
  assert.equal(reply.isError, true); if (code) assert.equal(reply.details.error.code, code);
  assert.ok(!reply.details.resource);
};

async function assertStitch(g, end, n) {
  const before = await g.counts(), response = await g.call(end);
  assert.equal(response.isError, false, JSON.stringify(response.details));
  const dto = response.details, sent = g.sent.at(-1);
  assert.deepEqual(JSON.parse(response.content[0].text), dto);
  assert.equal(dto.planReportId, g.plan.reportId); assert.equal(dto.finalSectionReportId, end.reportId); assert.equal(dto.sectionCount, n);
  assert.equal(dto.fileName, 'main.tex'); assert.equal(sent.input.name, 'main.tex'); assert.equal(sent.input.mime, 'text/x-tex');
  assert.equal(sent.input.deliverAs, 'attachment'); assert.equal(dto.resource.fileId, 'stitch-' + g.sent.length);
  assert.equal(dto.sha256, sha(sent.bytes)); assert.equal(dto.bytes, sent.bytes.length);
  assert.equal(dto.compileStatus, 'not-run'); assert.equal(dto.mathematicsStatus, 'unreviewed');
  assert.deepEqual(await g.counts(), before);
  return { dto, text: sent.bytes.toString(), artifact: sent.input.path };
}

test('stitch UTF-8 budget includes all framing and finish preserves order across calls', () => {
  const first = '序章 é\n', last = '结语 🧮', blocks = { preamble, frontmatter, bibliography: bib };
  const expected = Buffer.from(`${preamble}\n${frontmatter}\n${first}\n${last}\n\n${bib}\n\n\\end{document}\n`);
  const make = max => {
    const assembly = paperStitchText(blocks, max);
    for (const part of [last, first]) { assembly.checkNext(Buffer.byteLength(part)); assembly.addPrevious(part); }
    return assembly;
  };
  const exact = make(expected.length);
  assert.deepEqual(exact.finish().bytes, expected);
  assert.deepEqual(exact.finish().bytes, expected);
  assert.throws(() => make(expected.length - 1), { code: 'PROJECT_PAPER_STITCH_TOO_LARGE' });
});

test('public one-section stitch stages only main.tex, retaining original warnings and deterministic bytes', options, async t => {
  const g = await setup(t), s = await g.section(0);
  const originals = await Promise.all([g.plan, s].map(x => g.metadata(x.reportId)));
  const a = await assertStitch(g, s, 1), b = await assertStitch(g, s, 1);
  assert.equal(a.dto.chainRootReportId, s.reportId); assert.equal(a.dto.sha256, b.dto.sha256); assert.equal(a.artifact, b.artifact);
  assert.equal(a.dto.bibliographyStatus, 'empty-omitted');
  const archived = await fs.readFile(path.join(g.reports, s.reportId, 'section.tex'));
  assert.notEqual(Buffer.from(a.text).indexOf(archived), -1, 'assembled bytes contain the exact saved TeX fragment');
  assert.ok(!a.text.includes('thebibliography'));
  assert.equal(a.text.match(/\\section\b/g).length, 1); assert.equal(a.text.match(/\\begin\{document\}/g).length, 1); assert.equal(a.text.match(/\\end\{document\}/g).length, 1);
  assert.equal(a.dto.sections[0].provenanceStatus, 'missing'); assert.ok(a.dto.sections[0].warnings.some(w => /provenance/i.test(w)));
  assert.deepEqual(await Promise.all([g.plan, s].map(x => g.metadata(x.reportId))), originals);
  rejected(await g.call(s, { tex: 'client text' }), 'RESEARCH_TOOL_INVALID_INPUT');
  rejected(await g.call(s, { artifacts: [] }), 'RESEARCH_TOOL_INVALID_INPUT');
  rejected(await g.call(s, { finalSectionReportId: undefined }), 'RESEARCH_TOOL_INVALID_INPUT');
  rejected(await g.call(s, {}, { ...origin, sessionPath: '/fixture/foreign.jsonl' }));
  const current = await g.f.service.status(g.projectId, origin);
  rejected(await g.call(s, {}, { callToken: 'opaque-main-token', sessionPath: current.main.sessionPath }), 'PROJECT_SUMMARY_DENIED');
  assert.equal(g.sent.length, 2);
});

test('explicit terminal branch picks exact parents and keeps nonempty bibliography; incomplete and corrupt chains fail', options, async t => {
  const g = await setup(t, 2, bib), root = await g.section(0), a = await g.section(1, root), b = await g.section(1, root, fragment(1, ' alternate'));
  const left = await assertStitch(g, a, 2), right = await assertStitch(g, b, 2);
  assert.equal(left.dto.chainRootReportId, root.reportId); assert.equal(right.dto.chainRootReportId, root.reportId);
  assert.deepEqual(left.dto.sections.map(s => s.reportId), [root.reportId, a.reportId]);
  assert.ok(left.text.includes(bib) && right.text.includes(bib)); assert.ok(!left.text.includes('alternate') && right.text.includes('alternate'));
  assert.ok(left.text.indexOf('Frozen  0') < left.text.indexOf('Frozen  1')); assert.notEqual(left.dto.sha256, right.dto.sha256);
  const unrelatedPlan = await g.parent();
  const sent = g.sent.length, before = await g.counts();
  rejected(await g.call(a, { planReportId: unrelatedPlan.reportId }), 'PROJECT_PAPER_STITCH_CHAIN_INVALID');
  rejected(await g.call(root), 'PROJECT_PAPER_STITCH_CHAIN_INVALID');
  const src = path.join(g.reports, root.reportId, 'section.tex'); await fs.appendFile(src, 'corrupt');
  rejected(await g.call(a), 'PROJECT_REPORT_ARTIFACT_INVALID');
  assert.equal(g.sent.length, sent); assert.deepEqual(await g.counts(), before);
});

test('late filesystem drift or creator denial, and failed/malformed exports never report successful delivery', options, async t => {
  const g = await setup(t), s = await g.section(0), before = await g.counts();
  const src = path.join(g.reports, s.reportId, 'section.tex'), original = await fs.readFile(src), open = fs.open;
  async function duringExport(effect, expected) {
    let hit = false;
    const hook = t.mock.method(fs, 'open', async (p, ...args) => {
      if (!hit && typeof p === 'string' && p.includes('/paper-stitch/')) { hit = true; await effect(); }
      return open(p, ...args);
    }); syncBuiltinESMExports();
    try { rejected(await g.call(s), expected); assert.equal(hit, true); }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
  }
  await duringExport(() => fs.appendFile(src, 'late bytes'), 'PROJECT_REPORT_ARTIFACT_INVALID');
  await fs.writeFile(src, original);
  const list = g.f.sdk.sessions.list;
  try { await duringExport(async () => { g.f.sdk.sessions.list = async () => { throw Object.assign(Error('revoked'), { code: 'PERMISSION_DENIED' }); }; }, 'PERMISSION_DENIED'); }
  finally { g.f.sdk.sessions.list = list; }
  g.stageState.fail = true; rejected(await g.call(s), 'PROJECT_PAPER_STITCH_EXPORT_FAILED'); g.stageState.fail = false;
  g.stageState.malformed = true; rejected(await g.call(s), 'PROJECT_PAPER_STITCH_EXPORT_FAILED'); g.stageState.malformed = false;
  g.stageState.wrongOwner = true; rejected(await g.call(s), 'PROJECT_PAPER_STITCH_EXPORT_FAILED');
  assert.equal(g.sent.length, 0); assert.deepEqual(await g.counts(), before);
});

test('stitch opens archives and exports nonblocking, and rejects a growing regular export after a bounded read', options, async t => {
  const g = await setup(t), s = await g.section(0), first = await assertStitch(g, s, 1), before = await g.counts();
  const size = first.dto.bytes, source = path.join(g.reports, s.reportId, 'section.tex'), open = fs.open;
  const flagsSeen = [], ranges = []; let grew = false, unboundedReads = 0;
  const hook = t.mock.method(fs, 'open', async (file, flags, ...args) => {
    const fd = await open(file, flags, ...args);
    if (file === source || file === first.artifact) flagsSeen.push({ file, flags });
    if (file !== first.artifact) return fd;
    const stat = fd.stat.bind(fd), read = fd.read.bind(fd), readFile = fd.readFile.bind(fd);
    fd.stat = async (...a) => {
      const result = await stat(...a);
      if (!grew) { grew = true; await fs.appendFile(file, 'unexpected extra bytes'); }
      return result;
    };
    fd.readFile = async (...a) => { unboundedReads++; return readFile(...a); };
    fd.read = async (buffer, offset, length, position) => {
      ranges.push({ offset, length, position, capacity: buffer.length });
      return read(buffer, offset, length, position);
    };
    return fd;
  }); syncBuiltinESMExports();
  try { rejected(await g.call(s), 'PROJECT_PAPER_STITCH_EXPORT_FAILED'); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(grew, true); assert.equal(unboundedReads, 0); assert.ok(ranges.length > 0);
  assert.ok(ranges.every(r => r.capacity <= size + 1 && r.position + r.length <= size + 1));
  const mask = constants.O_NOFOLLOW | constants.O_NONBLOCK;
  for (const file of [source, first.artifact]) {
    const observed = flagsSeen.filter(x => x.file === file);
    assert.ok(observed.length); assert.ok(observed.every(x => (x.flags & mask) === mask));
  }
  assert.equal(g.sent.length, 1); assert.deepEqual(await g.counts(), before);
});

test('literal outer TeX framing ambiguity is refused, not rewritten', options, async t => {
  const g = await setup(t), s = await g.section(0, null, fragment(0) + '\\end{document}');
  rejected(await g.call(s), 'PROJECT_PAPER_STITCH_TEX_UNSUPPORTED'); assert.equal(g.sent.length, 0);
});
