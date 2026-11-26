// End-to-end synthetic gap-fill proof revision tests through real math_project tool,
// ProjectService, ProjectReportService, artifact store and schedule handler.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { mergeLedgerWithFacts, buildPaperGapFillRevisionPrompt, readPaperRevisionResources } from '../packages/hana-math/paper-revision.mjs';
import { fixture, origin } from './helpers/project-service-fixture.mjs';

const handler = 'math-project-report';
const factAId = 'a'.repeat(16);
const factBId = 'b'.repeat(16);
const missingFactId = 'c'.repeat(16);

const paperTex = `\\documentclass{amsart}
\\begin{document}
\\title{Synthetic Gap-Fill Manuscript}
\\author{Synthetic Author}
\\maketitle
\\section{Main Result}\\label{sec:main}
By \\cite{Alpha}, the primary estimate holds.
\\begin{proof}
This step currently lacks the boundary estimate.
\\end{proof}
\\begin{thebibliography}{99}
\\bibitem{Alpha} Synthetic Author, Alpha (2020).
\\end{thebibliography}
\\end{document}
`;

const patchFor = (find, replace, summary = 'Gap-fill using verified fact.') =>
  `%%%PATCH%%%\n<<<<<<< FIND\n${find}\n=======\n${replace}\n>>>>>>> REPLACE\n%%%REVISION_SUMMARY%%%\n${summary}\n`;

async function setup(t) {
  const writers = [], stages = [];
  const externalRefsA = [{ key: 'Alpha', authors: ['Synthetic Author'], title: 'Alpha', year: '2020', venue: 'Fixture' }];
  const externalRefsB = [{ key: 'Gamma', authors: ['Synthetic Collaborator'], title: 'Boundary Estimate', year: '2024', venue: 'Journal' }];
  const facts = new Map([
    [factAId, {
      fact_id: factAId, predecessors: [],
      markdown: `---\nfact_id: ${factAId}\npredecessors: []\nexternal_refs: ${JSON.stringify(externalRefsA)}\n---\n## statement\nPrimary estimate holds.\n## proof\nUses Alpha.\n`,
    }],
    [factBId, {
      fact_id: factBId, predecessors: [factAId],
      markdown: `---\nfact_id: ${factBId}\npredecessors: [${factAId}]\nexternal_refs: ${JSON.stringify(externalRefsB)}\n---\n## statement\nBoundary estimate is bounded by $C_0$.\n## proof\nFollows from \\cite{Gamma} and compactness.\n`,
    }],
  ]);

  const outputs = {
    'paper-source': () => `${paperTex}\n%%%PROVENANCE%%%\n${JSON.stringify({ 'sec:main': factAId })}\n`,
    'paper-math-verification': () => JSON.stringify({
      findings: [
        { location: 'Section 1, Proof of Main Result', issue: 'Boundary estimate is unjustified.', class: 'must-fix' },
        { location: 'Section 1', issue: 'Minor notation polish.', class: 'ignorable' },
      ],
      report: 'Missing boundary estimate in proof of Main Result.',
    }),
    'paper-revision': () => patchFor(
      'This step currently lacks the boundary estimate.',
      'By the boundary estimate bounded by $C_0$ (via \\cite{Gamma}), the step closes completely.',
    ),
  };

  const f = await fixture(t, {
    multiWorker: true,
    coreCall(_binding, op, args) {
      if (op === 'fact_list_page') return { facts: [...facts.values()] };
      if (op === 'fact_get') {
        const found = facts.get(args.fact_id);
        if (!found) throw Object.assign(new Error('FACT_NOT_FOUND'), { code: 'FACT_NOT_FOUND' });
        return structuredClone(found);
      }
      throw new Error(`unexpected op ${op}`);
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
        const out = await outputs[kind](input);
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
  return { f, projectId, facts, writers, stages, outputs, callTool, runReport, reportDir };
}

test('mergeLedgerWithFacts appends only new external_refs keys as unverified without touching existing entries', () => {
  const base = '# REFERENCE_LEDGER\n\n## Alpha\n- verified-by: verifier\n- title: Alpha\n';
  const fact = {
    fact_id: factBId, predecessors: [],
    markdown: `---\nfact_id: ${factBId}\npredecessors: []\nexternal_refs: [{"key":"Alpha","title":"Dup"},{"key":"Gamma","title":"New Ref","year":"2024"}]\n---\n## statement\nS.\n## proof\nP.\n`,
  };
  const merged = mergeLedgerWithFacts(base, [fact]);
  assert.deepEqual(merged.addedKeys, ['Gamma']);
  assert.match(merged.ledger, /## Alpha\n- verified-by: verifier/);
  assert.match(merged.ledger, /## Gamma[\s\S]*verified-by:\s*unverified/);
  assert.equal(merged.ledger.match(/## Alpha/g).length, 1);
});

test('buildPaperGapFillRevisionPrompt enforces verified_facts, must-fix findings and embeds mode data', async () => {
  const resources = await readPaperRevisionResources();
  const prompt = buildPaperGapFillRevisionPrompt({
    mainTex: paperTex,
    ledger: '# REFERENCE_LEDGER\n\n## Alpha\n- verified-by: unverified\n',
    mustFixFindings: [{ location: 'Sec 1', issue: 'Gap.', class: 'must-fix' }],
    ignorableCount: 1,
    verifiedFacts: [{ fact_id: factBId, predecessors: [], markdown: `---\nfact_id: ${factBId}\npredecessors: []\n---\n## statement\nLemma B.\n## proof\nProof B.\n` }],
    notes: 'Use Lemma B.',
    missingBacking: [],
    resources,
  });
  assert.match(prompt, /^MODE: gap-fill\n/);
  const envelope = JSON.parse(prompt.trimEnd().split('\n').at(-1));
  assert.equal(envelope.mode, 'gap-fill');
  assert.equal(envelope.verified_facts.length, 1);
  assert.equal(envelope.must_fix_findings.length, 1);
  assert.equal(envelope.ignorable_count, 1);
});

test('gap-fill end-to-end: needs_research without model call, verified fact gap-fill with merged ledger, then clean re-review', async t => {
  const env = await setup(t);
  assert.equal((await env.callTool({ action: 'finalize', projectId: env.projectId, factIds: [factAId] })).isError, false);

  const srcStart = await env.callTool({ action: 'paper', projectId: env.projectId, brief: 'Write a short paper.' });
  assert.equal(srcStart.isError, false);
  const srcId = srcStart.details.reportId;
  await env.runReport(srcId);
  assert.equal((await env.callTool({ action: 'paper_result', projectId: env.projectId, reportId: srcId })).isError, false);
  const originalTex = await fs.readFile(path.join(env.reportDir(srcId), 'main.tex'));
  const originalLedger = await fs.readFile(path.join(env.reportDir(srcId), 'REFERENCE_LEDGER.md'));

  // Math review -> wrong
  const math1 = await env.callTool({ action: 'paper_verify_math', projectId: env.projectId, reportId: srcId });
  assert.equal(math1.isError, false);
  const math1Id = math1.details.reportId;
  await env.runReport(math1Id);
  const math1Res = await env.callTool({ action: 'paper_verify_math_result', projectId: env.projectId, reportId: math1Id });
  assert.equal(math1Res.isError, false);
  assert.equal(math1Res.details.verdict, 'wrong');

  // 1. Empty factIds + missingBacking -> deterministic needs_research, zero model calls
  const writersBefore = env.writers.length;
  const needsRes = await env.callTool({
    action: 'paper_revise', projectId: env.projectId, reportId: math1Id,
    mode: 'gap-fill', factIds: [], notes: 'Boundary lemma is still unproven.',
    missingBacking: ['Need verified compactness lemma for boundary term'],
  });
  assert.equal(needsRes.isError, false);
  assert.equal(needsRes.details.status, 'needs_research');
  assert.equal(needsRes.details.mustFixCount, 1);
  assert.deepEqual(needsRes.details.missingBacking, ['Need verified compactness lemma for boundary term']);
  assert.equal(env.writers.length, writersBefore);

  // 2. Empty factIds without missingBacking -> rejected
  const noFacts = await env.callTool({
    action: 'paper_revise', projectId: env.projectId, reportId: math1Id,
    mode: 'gap-fill', factIds: [], notes: 'Try without facts.',
  });
  assert.equal(noFacts.isError, true);
  assert.equal(noFacts.details.error.code, 'PROJECT_PAPER_GAP_FILL_FACTS_REQUIRED');

  // 3. Missing fact ID -> rejected
  const missingFact = await env.callTool({
    action: 'paper_revise', projectId: env.projectId, reportId: math1Id,
    mode: 'gap-fill', factIds: [missingFactId], notes: 'Use unknown fact.',
  });
  assert.equal(missingFact.isError, true);
  assert.equal(missingFact.details.error.code, 'PROJECT_PAPER_GAP_FILL_FACT_NOT_FOUND');

  // 4. Unauthorized caller -> rejected
  const unauth = await env.callTool({
    action: 'paper_revise', projectId: env.projectId, reportId: math1Id,
    mode: 'gap-fill', factIds: [factBId], notes: 'Unauthorized.',
  }, { ...origin, sessionPath: '/fixture/other.jsonl', callToken: 'other-token' });
  assert.equal(unauth.isError, true);
  assert.equal(unauth.details.error.code, 'PROJECT_OWNER_DENIED');

  // 5. Real gap-fill with verified factBId -> merges Gamma into ledger, applies patch
  const gfStart = await env.callTool({
    action: 'paper_revise', projectId: env.projectId, reportId: math1Id,
    mode: 'gap-fill', factIds: [factBId], notes: 'Insert boundary estimate from verified fact.',
  });
  assert.equal(gfStart.isError, false);
  const gfId = gfStart.details.reportId;
  await env.runReport(gfId);
  const gfWriter = env.writers.at(-1);
  assert.equal(gfWriter.revisionMode, 'gap-fill');
  assert.match(gfWriter.prompt, /^MODE: gap-fill\n/);

  const gfRes = await env.callTool({ action: 'paper_revision_result', projectId: env.projectId, reportId: gfId });
  assert.equal(gfRes.isError, false);
  assert.equal(gfRes.details.state, 'completed');
  assert.equal(gfRes.details.mode, 'gap-fill');
  assert.equal(gfRes.details.citationStatus, 'unverified');

  const revisedTex = await fs.readFile(path.join(env.reportDir(gfId), 'proposal.tex'), 'utf8');
  assert.match(revisedTex, /bounded by \$C_0\$/);
  assert.doesNotMatch(revisedTex, new RegExp(factBId));
  const revisedLedger = await fs.readFile(path.join(env.reportDir(gfId), 'INHERITED_REFERENCE_LEDGER.md'), 'utf8');
  assert.match(revisedLedger, /## Gamma[\s\S]*verified-by:\s*unverified/);

  // Original source untouched
  assert.deepEqual(await fs.readFile(path.join(env.reportDir(srcId), 'main.tex')), originalTex);
  assert.deepEqual(await fs.readFile(path.join(env.reportDir(srcId), 'REFERENCE_LEDGER.md')), originalLedger);

  // 6. Re-review on gap-filled proposal -> correct
  env.outputs['paper-math-verification'] = () => JSON.stringify({
    findings: [{ location: 'Section 1', issue: 'Routine algebra omitted.', class: 'ignorable' }],
    report: 'Boundary gap is closed; proof is sound.',
  });
  const math2 = await env.callTool({ action: 'paper_verify_math', projectId: env.projectId, reportId: gfId });
  assert.equal(math2.isError, false);
  const math2Id = math2.details.reportId;
  await env.runReport(math2Id);
  const math2Res = await env.callTool({ action: 'paper_verify_math_result', projectId: env.projectId, reportId: math2Id });
  assert.equal(math2Res.isError, false);
  assert.equal(math2Res.details.verdict, 'correct');

  // 7. Gap-fill on a 'correct' math review is refused
  const onCorrect = await env.callTool({
    action: 'paper_revise', projectId: env.projectId, reportId: math2Id,
    mode: 'gap-fill', factIds: [factBId], notes: 'Should refuse correct review.',
  });
  assert.equal(onCorrect.isError, true);
  assert.equal(onCorrect.details.error.code, 'PROJECT_PAPER_GAP_FILL_NO_MUST_FIX');
});

test('gap-fill fails closed on fact-ID leak in output and on fact revocation before run', async t => {
  const env = await setup(t);
  await env.callTool({ action: 'finalize', projectId: env.projectId, factIds: [factAId] });
  const srcId = (await env.callTool({ action: 'paper', projectId: env.projectId, brief: 'Brief.' })).details.reportId;
  await env.runReport(srcId);
  const mathId = (await env.callTool({ action: 'paper_verify_math', projectId: env.projectId, reportId: srcId })).details.reportId;
  await env.runReport(mathId);

  // Leak factBId into proposal -> PROJECT_PAPER_OUTPUT_LEAK
  env.outputs['paper-revision'] = () => patchFor(
    'This step currently lacks the boundary estimate.',
    `Filled using internal fact ${factBId}.`,
  );
  const leakId = (await env.callTool({
    action: 'paper_revise', projectId: env.projectId, reportId: mathId,
    mode: 'gap-fill', factIds: [factBId], notes: 'Close gap.',
  })).details.reportId;
  await env.runReport(leakId);
  const leakStatus = await env.callTool({ action: 'paper_revision_status', projectId: env.projectId, reportId: leakId });
  assert.equal(leakStatus.details.state, 'failed');
  assert.equal(leakStatus.details.error, 'PROJECT_PAPER_REVISION_PATCH_INVALID');
  await assert.rejects(fs.access(path.join(env.reportDir(leakId), 'proposal.tex')));

  // Fact revoked between admission and run -> PROJECT_SUMMARY_FACT_REVOKED
  env.outputs['paper-revision'] = () => patchFor('This step currently lacks the boundary estimate.', 'Clean fix.');
  const revId = (await env.callTool({
    action: 'paper_revise', projectId: env.projectId, reportId: mathId,
    mode: 'gap-fill', factIds: [factBId], notes: 'Close gap cleanly.',
  })).details.reportId;
  env.facts.delete(factBId);
  await env.runReport(revId);
  const revStatus = await env.callTool({ action: 'paper_revision_status', projectId: env.projectId, reportId: revId });
  assert.equal(revStatus.details.state, 'failed');
  assert.equal(revStatus.details.error, 'PROJECT_SUMMARY_FACT_REVOKED');
});
