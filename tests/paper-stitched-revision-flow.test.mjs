// End-to-end synthetic full-chain test through real math_project tool,
// ProjectService, ProjectReportService, artifact store and schedule handler.
// Host calls, canonical fact replies and model outputs are synthetic fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { createProjectService } from '../packages/hana-math/project-service.mjs';
import { fixture, origin } from './helpers/project-service-fixture.mjs';

const handler = 'math-project-report';
const factId = 'a'.repeat(16);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const preamble = '\\documentclass{amsart}\n\\newcommand{\\sample}{S}\n';
const frontmatter = '\\begin{document}\n\\title{Synthetic Short Manuscript}\n\\author{Synthetic Author}\n\\maketitle\n';
const bib = '\\begin{thebibliography}{99}\n\\bibitem{Alpha} Opaque Alpha (2020).\n\\bibitem{Beta} Opaque Beta (2021).\n\\end{thebibliography}';
const sectionsSpec = [
  { title: 'Main Result', label: 'sec:main', fact_ids: [factId] },
  { title: 'Remarks', label: 'sec:remarks', fact_ids: [] },
];
const plannerText = `%%%PREAMBLE%%%\n${preamble}%%%FRONTMATTER%%%\n${frontmatter}%%%SECTIONS%%%\n${JSON.stringify(sectionsSpec)}\n%%%BIBLIOGRAPHY%%%\n${bib}\n`;
const section0Text = `\\section{Main Result}\\label{sec:main}\nBy \\cite{Alpha} and \\cite{Beta}, the synthetic claim for \\sample holds.\n%%%PROVENANCE%%%\n${JSON.stringify({ 'sec:main': factId })}\n`;
const section1Text = '\\section{Remarks}\\label{sec:remarks}\nClosing synthetic remarks.\n';

const verdictRow = (key, result = 'verified', suggestion = `Update \\bibitem{${key}} with confirmed metadata.`) => ({
  key, verdict: result,
  confirmed_metadata: ['verified', 'corrected'].includes(result)
    ? { authors: 'Synthetic Author', title: `Confirmed ${key}`, year: '2020', venue: 'Synthetic Journal' } : null,
  source_url: ['verified', 'corrected'].includes(result) ? `https://example.org/${key.toLowerCase()}` : null,
  note: result === 'unverifiable' ? 'Synthetic source unavailable.' : 'Synthetic authoritative check.',
  replacement_suggestion: suggestion,
});

const patchFor = (find, replace, summary = 'Targeted synthetic revision.') =>
  `%%%PATCH%%%\n<<<<<<< FIND\n${find}\n=======\n${replace}\n>>>>>>> REPLACE\n%%%REVISION_SUMMARY%%%\n${summary}\n`;
const emptyPatch = '%%%PATCH%%%\n%%%REVISION_SUMMARY%%%\nNo edits needed.\n';

async function setup(t) {
  const writers = [], stages = [];
  let coreForbidden = false;
  const outputs = {
    'paper-plan': () => plannerText,
    'paper-section': input => (writers.filter(w => w.kind === 'paper-section').length === 1 ? section0Text : section1Text),
    'reference-audit': () => 'Offline audit: Alpha and Beta require online verification.\n',
    'reference-verification': () => JSON.stringify([verdictRow('Alpha', 'verified'), verdictRow('Beta', 'unverifiable', 'Keep Beta flagged.')]),
    'paper-revision': () => patchFor('\\bibitem{Alpha} Opaque Alpha (2020).', '\\bibitem{Alpha} Synthetic Author, Confirmed Alpha, Synthetic Journal (2020).'),
    'paper-math-verification': () => JSON.stringify({
      findings: [
        { location: 'Section 1, Main Result', issue: 'Missing boundary hypothesis.', class: 'must-fix' },
        { location: 'Section 2, Remarks', issue: 'Routine algebra step omitted.', class: 'ignorable' },
      ],
      report: 'Substantive gap in Section 1; routine step in Section 2.',
    }),
  };
  const externalRefs = [
    { key: 'Alpha', authors: ['Synthetic Author'], title: 'Opaque Alpha', year: '2020', venue: 'Fixture' },
    { key: 'Beta', authors: ['Synthetic Author'], title: 'Opaque Beta', year: '2021', venue: 'Fixture' },
  ];
  const fact = {
    fact_id: factId, predecessors: [],
    markdown: `---\nfact_id: ${factId}\npredecessors: []\nexternal_refs: ${JSON.stringify(externalRefs)}\n---\n## statement\nSynthetic claim.\n## proof\nSynthetic proof citing Alpha and Beta.\n`,
  };
  const f = await fixture(t, {
    multiWorker: true,
    coreCall(_binding, op, args) {
      assert.equal(coreForbidden, false, `unexpected Core call after freezing chain: ${op}`);
      if (op === 'fact_list_page') return { facts: [fact] };
      assert.equal(op, 'fact_get'); assert.equal(args.fact_id, factId);
      return structuredClone(fact);
    },
    summaryWriter: {
      async start(input) {
        writers.push(input);
        const kind = input.kind;
        const spec = kind === 'paper-plan'
          ? { role: 'report-writer', prefix: 'math-paper-planner', agentKind: 'math-report-writer' }
          : kind === 'paper-section'
          ? { role: 'report-writer', prefix: 'math-paper-section-writer', agentKind: 'math-report-writer' }
          : kind === 'reference-audit'
          ? { role: 'report-writer', prefix: 'math-reference-auditor', agentKind: 'math-reference-auditor' }
          : kind === 'reference-verification'
          ? { role: 'reference-verifier', prefix: 'math-reference-verifier', agentKind: 'math-reference-verifier' }
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
        const terminal = typeof out === 'object' && out !== null && Object.hasOwn(out, 'terminal')
          ? { ...binding, ...out.terminal }
          : { ...binding, sendState: 'accepted', state: 'completed', modelStopReason: 'stop', cleanupPending: false, finalText: out };
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
  const unused = async () => assert.fail('unexpected legacy Research call');
  const legacyResearch = Object.fromEntries(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection'].map(k => [k, unused]));
  const registration = await registerMathResearch(f.sdk, legacyResearch, f.service);
  t.after(() => registration.dispose());

  const call = (action, args = {}, ctx = origin) => tools.get('math_project').execute({ action, projectId, ...args, context: ctx });
  const good = async (action, args = {}, ctx = origin) => {
    const reply = await call(action, args, ctx);
    assert.equal(reply.isError, false, `${action}: ${JSON.stringify(reply.details)}`);
    return reply.details;
  };
  const dispatch = async reportId => {
    const scheduled = [...f.schedules.values()].find(row => row.handlerKey === handler && row.payload.reportId === reportId);
    assert.ok(scheduled, `missing schedule for ${reportId}`);
    return f.handlers.get(handler).run({ kind: 'schedule', scheduleId: scheduled.scheduleId, input: scheduled.payload });
  };
  const reportFile = (reportId, name) => path.join(f.dataDir, 'research', 'projects', projectId, 'reports', reportId, name);
  const readReport = (reportId, name) => fs.readFile(reportFile(reportId, name));

  // Build frozen stitched manuscript: finalize -> plan -> section 0 -> section 1.
  await good('finalize', { factIds: [factId] });
  const plan = await good('paper_plan', { brief: 'Synthetic short paper brief.' });
  await dispatch(plan.reportId);
  const sec0 = await good('paper_section', { planReportId: plan.reportId });
  await dispatch(sec0.reportId);
  const sec1 = await good('paper_section', { planReportId: plan.reportId, previousSectionReportId: sec0.reportId });
  await dispatch(sec1.reportId);
  const chain = { planReportId: plan.reportId, finalSectionReportId: sec1.reportId };
  const stitched = await good('paper_stitch', chain);
  const stitchedBytes = stages.at(-1).bytes;
  assert.equal(stitched.sha256, sha(stitchedBytes));
  const originalLedger = await readReport(plan.reportId, 'REFERENCE_LEDGER.md');
  coreForbidden = true;

  return { f, p, projectId, plan, sec0, sec1, chain, stitchedBytes, originalLedger, writers, stages, outputs, call, good, dispatch, reportFile, readReport };
}

test('full chain: stitched manuscript -> audit -> verify -> revise (citation & notes) -> re-audit -> re-verify -> math review, preserving originals', { timeout: 30000 }, async t => {
  const g = await setup(t);
  const coreBefore = g.f.calls.core.length;
  const chainSnapshot = () => Promise.all([
    g.readReport(g.plan.reportId, 'metadata.json'),
    g.readReport(g.plan.reportId, 'REFERENCE_LEDGER.md'),
    g.readReport(g.sec0.reportId, 'section.tex'),
    g.readReport(g.sec1.reportId, 'section.tex'),
  ]);
  const originalChainFiles = await chainSnapshot();

  // 0. Original stitched math review (wrong: must-fix + ignorable).
  const math0 = await g.good('paper_verify_math', g.chain);
  await g.dispatch(math0.reportId);
  const math0Result = await g.good('paper_verify_math_result', { reportId: math0.reportId });
  assert.equal(math0Result.mathVerdict, 'wrong');
  const math0Review = JSON.parse(g.stages.at(-1).bytes);
  assert.equal(math0Review.binding.planReportId, g.plan.reportId);
  assert.equal(math0Review.binding.finalSectionReportId, g.sec1.reportId);
  assert.equal(math0Review.binding.mainSha256, sha(g.stitchedBytes));
  assert.equal(math0Review.binding.ledgerSha256, sha(g.originalLedger));
  assert.equal(math0Review.findings.filter(x => x.class === 'must-fix').length, 1);
  assert.equal(math0Review.findings.filter(x => x.class === 'ignorable').length, 1);

  // 1. Offline audit on stitched manuscript.
  const audit1 = await g.good('paper_audit', g.chain);
  await g.dispatch(audit1.reportId);
  const audit1Status = await g.good('paper_audit_status', { reportId: audit1.reportId });
  assert.equal(audit1Status.state, 'completed');
  assert.equal(audit1Status.planReportId, g.plan.reportId);
  assert.equal(audit1Status.finalSectionReportId, g.sec1.reportId);
  assert.equal(audit1Status.sourceMainSha256, sha(g.stitchedBytes));
  assert.equal(audit1Status.sourceLedgerSha256, sha(g.originalLedger));
  const audit1Prompt = g.writers.at(-1).prompt;
  const audit1Env = JSON.parse(audit1Prompt.slice(audit1Prompt.lastIndexOf('\n{') + 1, -1));
  assert.equal(audit1Env.mainTex, g.stitchedBytes.toString('utf8'));
  assert.equal(audit1Env.ledger, g.originalLedger.toString('utf8'));
  const audit1Result = await g.good('paper_audit_result', { reportId: audit1.reportId });
  assert.equal(audit1Result.status, 'ok');

  // 2. Online verify on audit1 -> Alpha verified, Beta stays unverified (unverifiable).
  const verify1 = await g.good('paper_verify', { reportId: audit1.reportId });
  await g.dispatch(verify1.reportId);
  const verify1Status = await g.good('paper_verify_status', { reportId: verify1.reportId });
  assert.equal(verify1Status.state, 'completed');
  assert.equal(verify1Status.citationStatus, 'partial');
  assert.equal(verify1Status.planReportId, g.plan.reportId);
  assert.equal(verify1Status.finalSectionReportId, g.sec1.reportId);
  assert.equal(verify1Status.sourceMainSha256, sha(g.stitchedBytes));
  assert.equal(verify1Status.sourceLedgerSha256, sha(g.originalLedger));
  const ledgerV1 = await g.readReport(verify1.reportId, 'REFERENCE_LEDGER.md');
  assert.match(ledgerV1.toString('utf8'), /## Alpha[\s\S]*verified-by: verifier/);
  assert.match(ledgerV1.toString('utf8'), /## Beta[\s\S]*verified-by: unverified \(unverifiable\)/);
  assert.notEqual(sha(ledgerV1), sha(g.originalLedger));

  // 3a. Citation-targeted revision on verify1 -> inherits verified ledger v1 and produces proposal.tex v1.
  const rev1 = await g.good('paper_revise', { reportId: verify1.reportId });
  await g.dispatch(rev1.reportId);
  const rev1Result = await g.good('paper_revision_result', { reportId: rev1.reportId });
  assert.equal(rev1Result.state, 'completed');
  assert.equal(rev1Result.proposalOnly, true);
  assert.equal(rev1Result.publicationStatus, 'reviewable-proposal');
  assert.equal(rev1Result.planReportId, g.plan.reportId);
  assert.equal(rev1Result.finalSectionReportId, g.sec1.reportId);
  assert.equal(rev1Result.inheritedCitationStatus, 'partial');
  assert.deepEqual(rev1Result.files.map(x => x.name), ['proposal.tex', 'REVISION_SUMMARY.md', 'REVISION_PROPOSAL.json', 'INHERITED_REFERENCE_LEDGER.md']);
  const proposalV1 = await g.readReport(rev1.reportId, 'proposal.tex');
  const inheritedLedgerV1 = await g.readReport(rev1.reportId, 'INHERITED_REFERENCE_LEDGER.md');
  const inheritedProvV1 = await g.readReport(rev1.reportId, 'INHERITED_PROVENANCE.json');
  assert.match(proposalV1.toString('utf8'), /Confirmed Alpha/);
  assert.notEqual(sha(proposalV1), sha(g.stitchedBytes));
  assert.deepEqual(inheritedLedgerV1, ledgerV1, 'citation revision inherits the verified ledger, not the original seeded ledger');
  assert.deepEqual(JSON.parse(inheritedProvV1.toString('utf8')), { 'sec:main': factId });

  // 3b. Operator-notes revision directly on the stitched manuscript (keeps original ledger v0).
  g.outputs['paper-revision'] = () => patchFor('Closing synthetic remarks.', 'Clarified synthetic remarks.');
  const revNotes = await g.good('paper_revise', { ...g.chain, mode: 'operator-notes', notes: 'Clarify closing remarks.' });
  await g.dispatch(revNotes.reportId);
  const revNotesResult = await g.good('paper_revision_result', { reportId: revNotes.reportId });
  assert.equal(revNotesResult.state, 'completed');
  assert.equal(revNotesResult.citationStatus, 'not-requested');
  assert.equal(revNotesResult.planReportId, g.plan.reportId);
  assert.equal(revNotesResult.finalSectionReportId, g.sec1.reportId);
  assert.deepEqual(await g.readReport(revNotes.reportId, 'INHERITED_REFERENCE_LEDGER.md'), g.originalLedger);
  assert.equal(revNotesResult.files.some(x => x.name === 'OPERATOR_NOTES.md'), false);

  // 3c. No-op revision produces no proposal and cannot be audited or math-reviewed.
  g.outputs['paper-revision'] = () => emptyPatch;
  const revNoOp = await g.good('paper_revise', { reportId: verify1.reportId });
  await g.dispatch(revNoOp.reportId);
  const revNoOpResult = await g.good('paper_revision_result', { reportId: revNoOp.reportId });
  assert.equal(revNoOpResult.status, 'no_edits_applied');
  assert.equal(revNoOpResult.proposalProduced, false);
  assert.deepEqual(revNoOpResult.files, []);
  assert.equal((await g.call('paper_audit', { reportId: revNoOp.reportId })).details.error.code, 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
  assert.equal((await g.call('paper_verify_math', { reportId: revNoOp.reportId })).details.error.code, 'PROJECT_PAPER_MATH_SOURCE_INVALID');

  // 4. Re-audit & re-verify the settled revision proposal (rev1):
  //    Only still-unverified Beta is targeted; Alpha remains verified.
  const audit2 = await g.good('paper_audit', { reportId: rev1.reportId });
  await g.dispatch(audit2.reportId);
  const audit2Status = await g.good('paper_audit_status', { reportId: audit2.reportId });
  assert.equal(audit2Status.state, 'completed');
  assert.equal(audit2Status.revisionReportId, rev1.reportId);
  assert.equal(audit2Status.sourceMainSha256, sha(proposalV1));
  assert.equal(audit2Status.sourceLedgerSha256, sha(ledgerV1));

  // 4a. Re-verify where Beta remains unverifiable -> stays marked unverified.
  g.outputs['reference-verification'] = () => JSON.stringify([verdictRow('Beta', 'unverifiable', 'Still unverifiable.')]);
  const verify2Unresolved = await g.good('paper_verify', { reportId: audit2.reportId });
  await g.dispatch(verify2Unresolved.reportId);
  const v2uStatus = await g.good('paper_verify_status', { reportId: verify2Unresolved.reportId });
  assert.equal(v2uStatus.state, 'completed');
  assert.equal(v2uStatus.revisionReportId, rev1.reportId);
  assert.equal(v2uStatus.citationStatus, 'unverified');
  assert.match((await g.readReport(verify2Unresolved.reportId, 'REFERENCE_LEDGER.md')).toString('utf8'), /## Beta[\s\S]*verified-by: unverified \(unverifiable\)/);

  // 4b. Re-verify where Beta is now confirmed -> produces ledger v2 while proposal.tex v1 is unchanged.
  g.outputs['reference-verification'] = () => JSON.stringify([verdictRow('Beta', 'verified')]);
  const verify2Resolved = await g.good('paper_verify', { reportId: audit2.reportId });
  await g.dispatch(verify2Resolved.reportId);
  const v2rStatus = await g.good('paper_verify_status', { reportId: verify2Resolved.reportId });
  assert.equal(v2rStatus.state, 'completed');
  assert.equal(v2rStatus.revisionReportId, rev1.reportId);
  assert.equal(v2rStatus.citationStatus, 'verified');
  const ledgerV2 = await g.readReport(verify2Resolved.reportId, 'REFERENCE_LEDGER.md');
  assert.match(ledgerV2.toString('utf8'), /## Alpha[\s\S]*verified-by: verifier/);
  assert.match(ledgerV2.toString('utf8'), /## Beta[\s\S]*verified-by: verifier/);
  assert.notEqual(sha(ledgerV2), sha(ledgerV1));

  // 5a. Math review directly on rev1 (proposal.tex v1 + inherited ledger v1) with only ignorable findings -> correct.
  g.outputs['paper-math-verification'] = () => JSON.stringify({
    findings: [{ location: 'Section 2, Remarks', issue: 'Routine algebra step omitted.', class: 'ignorable' }],
    report: 'All substantive steps verified; only one ignorable routine step remains.',
  });
  const mathRev1 = await g.good('paper_verify_math', { reportId: rev1.reportId });
  await g.dispatch(mathRev1.reportId);
  const mathRev1Result = await g.good('paper_verify_math_result', { reportId: mathRev1.reportId });
  assert.equal(mathRev1Result.mathVerdict, 'correct');
  assert.equal(mathRev1Result.paperMathGate, 'passed');
  const mathRev1Json = JSON.parse(g.stages.at(-1).bytes);
  assert.equal(mathRev1Json.binding.revisionReportId, rev1.reportId);
  assert.equal(mathRev1Json.binding.mainSha256, sha(proposalV1));
  assert.equal(mathRev1Json.binding.ledgerSha256, sha(ledgerV1));
  assert.deepEqual(mathRev1Json.findings, [{ location: 'Section 2, Remarks', issue: 'Routine algebra step omitted.', class: 'ignorable' }]);

  // 5b. Math review after ledger-only update (same proposal.tex v1, new ledger v2 via verify2Resolved):
  //     Produces a distinct MATH_REVIEW.json bound to verificationReportId and ledger v2.
  const mathLedgerV2 = await g.good('paper_verify_math', { reportId: verify2Resolved.reportId });
  await g.dispatch(mathLedgerV2.reportId);
  const mathLedgerV2Result = await g.good('paper_verify_math_result', { reportId: mathLedgerV2.reportId });
  assert.equal(mathLedgerV2Result.mathVerdict, 'correct');
  const mathLedgerV2Json = JSON.parse(g.stages.at(-1).bytes);
  assert.equal(mathLedgerV2Json.binding.verificationReportId, verify2Resolved.reportId);
  assert.equal(mathLedgerV2Json.binding.mainSha256, sha(proposalV1));
  assert.equal(mathLedgerV2Json.binding.ledgerSha256, sha(ledgerV2));
  assert.notEqual(mathLedgerV2Json.binding.ledgerSha256, mathRev1Json.binding.ledgerSha256);

  // 5c. Citation revision after all entries are verified -> re-audit works, re-verify reports NO_TARGETS (never false verified).
  g.outputs['paper-revision'] = () => patchFor('\\bibitem{Beta} Opaque Beta (2021).', '\\bibitem{Beta} Synthetic Author, Confirmed Beta, Synthetic Journal (2020).');
  const rev2 = await g.good('paper_revise', { reportId: verify2Resolved.reportId });
  await g.dispatch(rev2.reportId);
  const audit3 = await g.good('paper_audit', { reportId: rev2.reportId });
  await g.dispatch(audit3.reportId);
  const noTargets = await g.call('paper_verify', { reportId: audit3.reportId });
  assert.equal(noTargets.isError, true);
  assert.equal(noTargets.details.error.code, 'PROJECT_REFERENCE_VERIFY_NO_TARGETS');

  // 6. Original stitched manuscript, original ledger, and prior results are untouched and still readable.
  assert.deepEqual(await chainSnapshot(), originalChainFiles);
  const reStitched = await g.good('paper_stitch', g.chain);
  assert.equal(reStitched.sha256, sha(g.stitchedBytes));
  const reMath0 = await g.good('paper_verify_math_result', { reportId: math0.reportId });
  assert.equal(reMath0.mathVerdict, 'wrong');
  const reRev1 = await g.good('paper_revision_result', { reportId: rev1.reportId });
  assert.equal(reRev1.files[0].sha256, sha(proposalV1));
  assert.equal(g.f.calls.core.length, coreBefore, 'post-freeze chain never re-read Core');
});

test('negative matrix: wrong version, unauthorized caller, damaged archive, unsettled task and execution failure', { timeout: 30000 }, async t => {
  const g = await setup(t);

  // Produce audit1 -> verify1 -> rev1 on stitched chain.
  const audit1 = await g.good('paper_audit', g.chain);
  await g.dispatch(audit1.reportId);
  const verify1 = await g.good('paper_verify', { reportId: audit1.reportId });
  await g.dispatch(verify1.reportId);
  const rev1 = await g.good('paper_revise', { reportId: verify1.reportId });
  await g.dispatch(rev1.reportId);

  // 1. Unauthorized caller (main session & foreign session) denied across all new paths.
  for (const ctx of [g.p.context, { ...origin, sessionPath: '/fixture/foreign.jsonl' }]) {
    for (const [action, args] of [
      ['paper_audit', g.chain],
      ['paper_audit', { reportId: rev1.reportId }],
      ['paper_revise', { ...g.chain, mode: 'operator-notes', notes: 'Unauthorized edit.' }],
      ['paper_verify_math', { reportId: rev1.reportId }],
      ['paper_verify_math', { reportId: verify1.reportId }],
    ]) {
      const denied = await g.call(action, args, ctx);
      assert.equal(denied.isError, true, `${action} must deny unauthorized caller`);
      assert.ok(['PROJECT_SUMMARY_DENIED', 'PROJECT_OWNER_DENIED'].includes(denied.details.error.code), denied.details.error.code);
    }
  }

  // 2. Wrong version / incomplete chain / wrong kind.
  const incomplete = { planReportId: g.plan.reportId, finalSectionReportId: g.sec0.reportId };
  assert.equal((await g.call('paper_audit', incomplete)).details.error.code, 'PROJECT_PAPER_STITCH_CHAIN_INVALID');
  assert.equal((await g.call('paper_revise', { ...incomplete, mode: 'operator-notes', notes: 'Edit incomplete.' })).details.error.code, 'PROJECT_PAPER_STITCH_CHAIN_INVALID');
  assert.equal((await g.call('paper_audit', { reportId: g.plan.reportId })).details.error.code, 'PROJECT_REPORT_KIND_MISMATCH');
  assert.equal((await g.call('paper_audit', { reportId: audit1.reportId })).details.error.code, 'PROJECT_REPORT_KIND_MISMATCH');
  assert.equal((await g.call('paper_verify_math', { reportId: audit1.reportId })).details.error.code, 'PROJECT_PAPER_MATH_SOURCE_INVALID');
  assert.equal((await g.call('paper_verify_math', { reportId: g.plan.reportId })).details.error.code, 'PROJECT_PAPER_MATH_SOURCE_INVALID');

  // 3. Execution failure on revision math review keeps error and exposes no mathVerdict.
  g.outputs['paper-math-verification'] = () => 'not valid json at all';
  const badMath = await g.good('paper_verify_math', { reportId: rev1.reportId });
  await g.dispatch(badMath.reportId);
  const badMathStatus = await g.good('paper_verify_math_status', { reportId: badMath.reportId });
  assert.equal(badMathStatus.state, 'failed');
  assert.equal(badMathStatus.error, 'PROJECT_PAPER_MATH_OUTPUT_INVALID');
  assert.equal(Object.hasOwn(badMathStatus, 'mathVerdict'), false);
  assert.equal(badMathStatus.paperMathGate, 'not-assessed');
  const badMathResult = await g.good('paper_verify_math_result', { reportId: badMath.reportId });
  assert.equal(badMathResult.status, 'failed');
  assert.deepEqual(badMathResult.files, []);
  assert.equal(Object.hasOwn(badMathResult, 'mathVerdict'), false);

  // 4. Unsettled revision / verification task rejected before writer launch (verified via deferred reload).
  const rev1MetaPath = g.reportFile(rev1.reportId, 'metadata.json');
  const rev1MetaOriginal = await fs.readFile(rev1MetaPath);
  const rev1Unsettled = { ...JSON.parse(rev1MetaOriginal), taskSettlement: 'pending' };
  await fs.writeFile(rev1MetaPath, JSON.stringify(rev1Unsettled));
  const verify1MetaPath = g.reportFile(verify1.reportId, 'metadata.json');
  const verify1MetaOriginal = await fs.readFile(verify1MetaPath);
  const verify1Unsettled = { ...JSON.parse(verify1MetaOriginal), taskSettlement: 'pending' };
  await fs.writeFile(verify1MetaPath, JSON.stringify(verify1Unsettled));
  const reopenedUnsettled = await createProjectService(g.f.sdk, {
    contexts: g.f.contexts, profiles: g.f.profiles, research: g.f.research,
    summaryWriter: { start() { assert.fail('unsettled source must not start writer'); }, dispose: async () => ({ cleanupPending: false }) },
    createCore() { assert.fail('unexpected Core call'); }, literature: { search() { assert.fail('unexpected search'); } },
    deferHistoricalWork: true,
  });
  t.after(() => reopenedUnsettled.dispose());
  await assert.rejects(reopenedUnsettled.paperAudit({ projectId: g.projectId, reportId: rev1.reportId }, origin), { code: 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID' });
  await assert.rejects(reopenedUnsettled.paperVerifyMath({ projectId: g.projectId, reportId: rev1.reportId }, origin), { code: 'PROJECT_PAPER_MATH_SOURCE_INVALID' });
  await assert.rejects(reopenedUnsettled.paperVerifyMath({ projectId: g.projectId, reportId: verify1.reportId }, origin), { code: 'PROJECT_PAPER_MATH_SOURCE_INVALID' });
  await assert.rejects(reopenedUnsettled.paperRevise({ projectId: g.projectId, reportId: verify1.reportId }, origin), { code: 'PROJECT_PAPER_REVISION_SOURCE_INVALID' });
  await fs.writeFile(rev1MetaPath, rev1MetaOriginal);
  await fs.writeFile(verify1MetaPath, verify1MetaOriginal);

  // 5. Damaged revision archive (proposal.tex / INHERITED_REFERENCE_LEDGER.md / REVISION_PROPOSAL.json).
  const proposalPath = g.reportFile(rev1.reportId, 'proposal.tex');
  const proposalOriginal = await fs.readFile(proposalPath);
  await fs.writeFile(proposalPath, 'tampered proposal bytes');
  assert.equal((await g.call('paper_audit', { reportId: rev1.reportId })).details.error.code, 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
  assert.equal((await g.call('paper_verify_math', { reportId: rev1.reportId })).details.error.code, 'PROJECT_PAPER_MATH_SOURCE_CHANGED');
  await fs.writeFile(proposalPath, proposalOriginal);

  const ledgerPath = g.reportFile(rev1.reportId, 'INHERITED_REFERENCE_LEDGER.md');
  const ledgerOriginal = await fs.readFile(ledgerPath);
  await fs.writeFile(ledgerPath, 'tampered ledger bytes');
  assert.equal((await g.call('paper_audit', { reportId: rev1.reportId })).details.error.code, 'PROJECT_REFERENCE_AUDIT_SOURCE_INVALID');
  assert.equal((await g.call('paper_verify_math', { reportId: rev1.reportId })).details.error.code, 'PROJECT_PAPER_MATH_SOURCE_CHANGED');
  await fs.writeFile(ledgerPath, ledgerOriginal);

  // 6. Damaged verification ledger blocks paper_verify_math(verificationReportId) and citation paper_revise.
  const verifyLedgerPath = g.reportFile(verify1.reportId, 'REFERENCE_LEDGER.md');
  const verifyLedgerOriginal = await fs.readFile(verifyLedgerPath);
  await fs.writeFile(verifyLedgerPath, 'tampered verified ledger');
  assert.equal((await g.call('paper_verify_math', { reportId: verify1.reportId })).details.error.code, 'PROJECT_PAPER_MATH_SOURCE_CHANGED');
  assert.equal((await g.call('paper_revise', { reportId: verify1.reportId })).details.error.code, 'PROJECT_PAPER_REVISION_SOURCE_INVALID');
  await fs.writeFile(verifyLedgerPath, verifyLedgerOriginal);

  // 7. Damaged stitched section blocks stitched audit, operator-notes revise, and citation revise on verify1.
  const sec0Path = g.reportFile(g.sec0.reportId, 'section.tex');
  const sec0Original = await fs.readFile(sec0Path);
  await fs.writeFile(sec0Path, 'tampered stitched section');
  assert.equal((await g.call('paper_audit', g.chain)).details.error.code, 'PROJECT_REPORT_ARTIFACT_INVALID');
  assert.equal((await g.call('paper_revise', { ...g.chain, mode: 'operator-notes', notes: 'Edit tampered.' })).details.error.code, 'PROJECT_REPORT_ARTIFACT_INVALID');
  assert.equal((await g.call('paper_revise', { reportId: verify1.reportId })).details.error.code, 'PROJECT_REPORT_ARTIFACT_INVALID');
  await fs.writeFile(sec0Path, sec0Original);
});
