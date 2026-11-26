// Pure & end-to-end tests for compile-fix revision and paper_deliver gate/override contract.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { evaluatePaperDelivery, applyOverrideDisclosure, snapshotPaperDeliveryRequest } from '../packages/hana-math/paper-delivery.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { fixture, origin } from './helpers/project-service-fixture.mjs';

const handler = 'math-project-report';
const factId = 'd'.repeat(16);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const brokenTex = `\\documentclass{amsart}
\\begin{document}
\\title{Synthetic Compile Manuscript}
\\author{Synthetic Author}
\\maketitle
\\section{Main}\\label{sec:main}
Consider $\\badmacro{x}$ by \\cite{Alpha}.
\\begin{thebibliography}{99}
\\bibitem{Alpha} Synthetic Author, Alpha (2020).
\\end{thebibliography}
\\end{document}
`;

const fixedTexFragment = 'Consider $x$ by \\cite{Alpha}.';
const patchFor = (find, replace, summary = 'Compile-fix patch.') =>
  `%%%PATCH%%%\n<<<<<<< FIND\n${find}\n=======\n${replace}\n>>>>>>> REPLACE\n%%%REVISION_SUMMARY%%%\n${summary}\n`;

function syntheticCompileEvidence(mainBytes) {
  const cwd = '/tmp/compile-run';
  const flsText = `PWD ${cwd}\nINPUT ${cwd}/main.tex\nOUTPUT ${cwd}/main.pdf\nOUTPUT ${cwd}/main.log\n`;
  const logText = 'This is pdfTeX, Version 3.141592653\nOutput written on main.pdf (1 page, 4096 bytes).\nTranscript written on main.log.\n';
  const pdfBytes = Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'utf8');
  return {
    sourceSha256: sha(mainBytes),
    cwd,
    readRoots: [cwd],
    pass: 2,
    logBytes: Buffer.from(logText, 'utf8'),
    flsBytes: Buffer.from(flsText, 'utf8'),
    pdfBytes,
  };
}

test('pure paper-delivery gate enforces exact hash binding, math verdict, override disclosure and compile evidence', () => {
  const mainBytes = Buffer.from(brokenTex, 'utf8');
  const ledgerBytes = Buffer.from('# REFERENCE_LEDGER\n\n## Alpha\n- verified-by: verifier\n', 'utf8');
  const manuscript = {
    selector: { sourceReportId: 'report-11111111-1111-4111-8111-111111111111' },
    mainBytes, ledgerBytes, mainSha256: sha(mainBytes), ledgerSha256: sha(ledgerBytes),
  };
  const wrongReview = {
    schemaVersion: 1, kind: 'paper-math-verification', projectId: 'project-1',
    reportId: 'report-22222222-2222-4222-8222-222222222222',
    verdict: 'wrong',
    binding: { sourceReportId: manuscript.selector.sourceReportId, mainSha256: manuscript.mainSha256, ledgerSha256: manuscript.ledgerSha256 },
    findings: [
      { location: 'Sec 1', issue: 'Unjustified lemma.', class: 'must-fix' },
      { location: 'Sec 1', issue: 'Minor typo.', class: 'ignorable' },
    ],
  };

  // Mismatched hash fails closed even with override
  assert.throws(() => evaluatePaperDelivery({
    projectId: 'project-1', manuscript,
    mathReview: { ...wrongReview, binding: { ...wrongReview.binding, mainSha256: '0'.repeat(64) } },
    override: { reason: 'Try bypass.' },
  }), err => err.code === 'PROJECT_PAPER_DELIVERY_REVIEW_MISMATCH');

  // Wrong without override -> blocked
  const blocked = evaluatePaperDelivery({ projectId: 'project-1', manuscript, mathReview: wrongReview, allowUncompiledTex: true });
  assert.equal(blocked.deliverOk, false);
  assert.equal(blocked.texDeliverable, false);
  assert.equal(blocked.mathGate, 'blocked');
  assert.ok(blocked.blockers.some(b => b.includes('math_verification_wrong')));

  // Wrong with override -> visible disclosure injected on copy, original untouched
  const overridden = evaluatePaperDelivery({
    projectId: 'project-1', manuscript, mathReview: wrongReview,
    override: { reason: 'Operator accepts draft for advisor review.' },
    allowUncompiledTex: true,
  });
  assert.equal(overridden.overrideApplied, true);
  assert.equal(overridden.mathGate, 'overridden');
  assert.equal(overridden.compileGate, 'not-run');
  assert.equal(overridden.deliverOk, false);
  assert.equal(overridden.texDeliverable, true);
  assert.equal(overridden.manifest.pushAuthorized, false);
  assert.equal(overridden.manifest.mustFixCount, 1);
  assert.equal(overridden.manifest.ignorableCount, 1);
  const deliveredTex = overridden.deliveredTexBytes.toString('utf8');
  assert.match(deliveredTex, /\\note\{\[math-override\].*Operator accepts draft for advisor review\.\}\n\\end\{document\}/);
  assert.notEqual(overridden.manifest.deliveredMainSha256, overridden.manifest.sourceMainSha256);

  // Correct + valid compileEvidence -> deliverOk: true, pdfDelivered: true
  const correctReview = {
    ...wrongReview, verdict: 'correct',
    findings: [{ location: 'Sec 1', issue: 'Routine algebra step.', class: 'ignorable' }],
  };
  const compiled = evaluatePaperDelivery({
    projectId: 'project-1', manuscript, mathReview: correctReview,
    compileEvidence: syntheticCompileEvidence(mainBytes),
  });
  assert.equal(compiled.deliverOk, true);
  assert.equal(compiled.texDeliverable, true);
  assert.equal(compiled.compileGate, 'passed');
  assert.equal(compiled.manifest.pdfDelivered, true);
  assert.equal(compiled.manifest.ignorableCount, 1);
  assert.equal(compiled.manifest.pushAuthorized, false);

  // Mismatched compileEvidence sourceSha256 fails closed
  assert.throws(() => evaluatePaperDelivery({
    projectId: 'project-1', manuscript, mathReview: correctReview,
    compileEvidence: { ...syntheticCompileEvidence(mainBytes), sourceSha256: 'f'.repeat(64) },
  }), err => err.code === 'PROJECT_PAPER_DELIVERY_COMPILE_MISMATCH');

  // applyOverrideDisclosure sanitizes LaTeX specials
  const patched = applyOverrideDisclosure(brokenTex, {
    reason: 'Check 100% of \\textbf{gaps} & $x_1$',
    mathReviewReportId: wrongReview.reportId,
    mustFixCount: 2,
  });
  assert.match(patched.disclosure, /\\note\{\[math-override\]/);
  assert.doesNotMatch(patched.disclosure.slice(6), /\\textbf|\$/);

  // snapshotPaperDeliveryRequest validates selectors strictly
  assert.throws(() => snapshotPaperDeliveryRequest({ projectId: 'project-1', mathReviewReportId: wrongReview.reportId }), err => err.code === 'PROJECT_INVALID_INPUT');
});

async function setupService(t) {
  const writers = [], stages = [];
  const fact = {
    fact_id: factId, predecessors: [],
    markdown: `---\nfact_id: ${factId}\npredecessors: []\nexternal_refs: [{"key":"Alpha","title":"Alpha","year":"2020"}]\n---\n## statement\nSynthetic claim.\n## proof\nSynthetic proof.\n`,
  };
  const outputs = {
    'paper-source': () => `${brokenTex}\n%%%PROVENANCE%%%\n${JSON.stringify({ 'sec:main': factId })}\n`,
    'paper-revision': () => patchFor('Consider $\\badmacro{x}$ by \\cite{Alpha}.', fixedTexFragment),
    'paper-math-verification': () => JSON.stringify({
      findings: [
        { location: 'Sec 1', issue: 'Unresolved proof step.', class: 'must-fix' },
        { location: 'Sec 1', issue: 'Minor notation note.', class: 'ignorable' },
      ],
      report: 'Must-fix proof step remains.',
    }),
  };
  const f = await fixture(t, {
    multiWorker: true,
    coreCall(_binding, op) {
      if (op === 'fact_list_page') return { facts: [fact] };
      return structuredClone(fact);
    },
    summaryWriter: {
      async start(input) {
        writers.push(input);
        const kind = input.kind;
        const spec = kind === 'paper-source'
          ? { role: 'report-writer', prefix: 'math-paper-source-writer', agentKind: 'math-paper-source-writer' }
          : kind === 'paper-revision'
          ? { role: 'paper-reviser', prefix: 'math-paper-reviser', agentKind: 'math-paper-reviser' }
          : { role: 'report-writer', prefix: 'paper-math-verifier', agentKind: 'paper-math-verifier' };
        const agentId = `${spec.prefix}-01234567-89ab-cdef-0123-456789abcdef`;
        const sessionId = `writer-${writers.length}`, sessionPath = `/fixture/${sessionId}.jsonl`;
        const binding = {
          role: spec.role, agentId, sessionId, sessionPath, cwd: input.cwd,
          kind: `math-${kind}:${input.projectId}:${input.reportId}`,
          sendState: 'not-sent', sendPending: false, model: null, toolSelection: null,
        };
        f.host.set(sessionPath, { ...binding, path: sessionPath, ownerPluginId: 'hana-math', namespace: 'app', visibility: 'plugin_private', lifecycle: 'active' });
        if (!f.agents.some(row => row.id === agentId)) {
          f.agents.push({ id: agentId, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private',
            plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: spec.agentKind } });
        }
        await input.onBound(binding);
        const out = outputs[kind](input);
        const terminal = { ...binding, sendState: 'accepted', state: 'completed', modelStopReason: 'stop', cleanupPending: false, finalText: out };
        return { done: Promise.resolve(terminal), stop: async () => terminal };
      },
      async dispose() { return { cleanupPending: false }; },
    },
  });
  f.sdk.resources = {
    async stage(input) {
      const bytes = await fs.readFile(input.path);
      stages.push({ ...input, bytes });
      return { resource: { kind: 'session-file', fileId: `file-${stages.length}`, sessionId: 'creator-stable' } };
    },
  };
  const p = await f.create(), projectId = p.projectId;
  const tools = new Map();
  f.sdk.tools = { async register(tool) { tools.set(tool.name, tool); return () => {}; } };
  const researchStub = {
    run() {}, status() {}, setupStatus() {}, setToolMode() {}, result() {}, stop() {}, invoke() {},
    async recordSubmissionInputRejection() {},
  };
  const reg = await registerMathResearch(f.sdk, researchStub, f.service);
  t.after(async () => { await reg.dispose(); });
  const callTool = async (args, ctx = origin) => tools.get('math_project').execute({ ...args, context: ctx });
  const runReport = async reportId => {
    const sch = [...f.schedules.values()].find(s => s.handlerKey === handler && s.payload?.reportId === reportId);
    assert.ok(sch, `missing schedule for ${reportId}`);
    return f.handlers.get(handler).run({ kind: 'schedule', scheduleId: sch.scheduleId, input: sch.payload });
  };
  const reportDir = reportId => path.join(f.dataDir, 'research/projects', projectId, 'reports', reportId);
  return { f, projectId, writers, stages, outputs, callTool, runReport, reportDir };
}

test('compile-fix revision and paper_deliver end-to-end through math_project tool and service', async t => {
  const env = await setupService(t);
  await env.callTool({ action: 'finalize', projectId: env.projectId, factIds: [factId] });
  const srcId = (await env.callTool({ action: 'paper', projectId: env.projectId, brief: 'Write paper.' })).details.reportId;
  await env.runReport(srcId);

  // Compile-fix on paper-source
  const cfStart = await env.callTool({
    action: 'paper_revise', projectId: env.projectId, reportId: srcId,
    mode: 'compile-fix', compileLog: '! Undefined control sequence.\nl.7 Consider $\\badmacro\n',
  });
  assert.equal(cfStart.isError, false);
  const cfId = cfStart.details.reportId;
  await env.runReport(cfId);
  assert.equal(env.writers.at(-1).revisionMode, 'compile-fix');
  assert.match(env.writers.at(-1).prompt, /^MODE: compile-fix\n/);

  const cfRes = await env.callTool({ action: 'paper_revision_result', projectId: env.projectId, reportId: cfId });
  assert.equal(cfRes.isError, false);
  assert.equal(cfRes.details.mode, 'compile-fix');
  assert.equal(cfRes.details.citationStatus, 'not-requested');
  assert.equal(cfRes.details.compileStatus, 'not-run');
  // COMPILE_LOG.txt is archived privately (not in staged files)
  assert.ok(!cfRes.details.files.some(f => f.name === 'COMPILE_LOG.txt'));
  const archivedLog = await fs.readFile(path.join(env.reportDir(cfId), 'COMPILE_LOG.txt'), 'utf8');
  assert.match(archivedLog, /Undefined control sequence/);
  const fixedBytes = await fs.readFile(path.join(env.reportDir(cfId), 'proposal.tex'));
  assert.match(fixedBytes.toString('utf8'), /Consider \$x\$ by \\cite\{Alpha\}\./);

  // Math review on fixed proposal -> wrong
  const wrongMathId = (await env.callTool({ action: 'paper_verify_math', projectId: env.projectId, reportId: cfId })).details.reportId;
  await env.runReport(wrongMathId);

  // Delivery with mismatched reportId (original srcId instead of cfId) fails closed
  const mismatch = await env.callTool({
    action: 'paper_deliver', projectId: env.projectId, reportId: srcId,
    mathReviewReportId: wrongMathId, allowUncompiledTex: true,
  });
  assert.equal(mismatch.isError, true);
  assert.equal(mismatch.details.error.code, 'PROJECT_PAPER_DELIVERY_REVIEW_MISMATCH');

  // Delivery of cfId with wrong verdict and no override -> blocked (isError: false, deliverOk: false, 0 files)
  const blocked = await env.callTool({
    action: 'paper_deliver', projectId: env.projectId, reportId: cfId,
    mathReviewReportId: wrongMathId, allowUncompiledTex: true,
  });
  assert.equal(blocked.isError, false);
  assert.equal(blocked.details.deliverOk, false);
  assert.equal(blocked.details.texDeliverable, false);
  assert.equal(blocked.details.mathGate, 'blocked');
  assert.deepEqual(blocked.details.files, []);

  // Delivery of cfId with explicit override + allowUncompiledTex: true -> stages 4 files with disclosure note
  const stagesBefore = env.stages.length;
  const overridden = await env.callTool({
    action: 'paper_deliver', projectId: env.projectId, reportId: cfId,
    mathReviewReportId: wrongMathId, override: { reason: 'Working draft for internal seminar.' },
    allowUncompiledTex: true,
  });
  assert.equal(overridden.isError, false);
  assert.equal(overridden.details.overrideApplied, true);
  assert.equal(overridden.details.texDeliverable, true);
  assert.equal(overridden.details.deliverOk, false);
  assert.equal(overridden.details.compileStatus, 'not-run');
  assert.equal(overridden.details.pushAuthorized, false);
  assert.deepEqual(overridden.details.files.map(f => f.name).sort(),
    ['DELIVERY_MANIFEST.json', 'MATH_REVIEW.json', 'REFERENCE_LEDGER.md', 'main.tex']);
  const stagedTex = env.stages.slice(stagesBefore).find(s => s.name === 'main.tex').bytes.toString('utf8');
  assert.match(stagedTex, /\\note\{\[math-override\].*Working draft for internal seminar\.\}/);
  // Archived proposal.tex was NOT mutated!
  assert.deepEqual(await fs.readFile(path.join(env.reportDir(cfId), 'proposal.tex')), fixedBytes);

  // Correct math review + synthetic compile evidence -> full PDF delivery (deliverOk: true)
  env.outputs['paper-math-verification'] = () => JSON.stringify({
    findings: [{ location: 'Sec 1', issue: 'Routine algebra step.', class: 'ignorable' }],
    report: 'Proof verified cleanly.',
  });
  const okMathId = (await env.callTool({ action: 'paper_verify_math', projectId: env.projectId, reportId: cfId })).details.reportId;
  await env.runReport(okMathId);
  const fullDelivered = await env.f.service.paperDeliver(
    { projectId: env.projectId, reportId: cfId, mathReviewReportId: okMathId },
    origin,
    { compileEvidence: syntheticCompileEvidence(fixedBytes) },
  );
  assert.equal(fullDelivered.deliverOk, true);
  assert.equal(fullDelivered.pdfDelivered, true);
  assert.equal(fullDelivered.compileStatus, 'passed');
  assert.deepEqual(fullDelivered.files.map(f => f.name).sort(),
    ['DELIVERY_MANIFEST.json', 'MATH_REVIEW.json', 'REFERENCE_LEDGER.md', 'main.pdf', 'main.tex']);
});
