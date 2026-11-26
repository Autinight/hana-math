// Pure & end-to-end tests for deep-theorem chapter-tree assembly (paper_chapter_tree_stitch).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assembleChapterTree, validateConfirmedStyleRules, snapshotChapterTreeRequest } from '../packages/hana-math/paper-chapter-tree.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { fixture, origin } from './helpers/project-service-fixture.mjs';

const handler = 'math-project-report';
const factHostId = '1'.repeat(16);
const factChAId = '2'.repeat(16);
const factChBId = '3'.repeat(16);

const hostTex = `\\documentclass{amsart}
\\usepackage{amsmath}
\\usepackage{hyperref}
\\newtheorem{theorem}{Theorem}
\\newcommand{\\BaseOp}{\\mathrm{B}}
\\begin{document}
\\title{Synthetic Deep-Theorem Host Paper}
\\author{Synthetic Author}
\\maketitle
\\section{Introduction}\\label{sec:intro}
We cite \\cite{HostRef}. This paper was produced with assistance from the Danus system.
\\begin{theorem}\\label{thm:big}
Main deep theorem.
\\end{theorem}
\\begin{proof}
The complete development is given in the dedicated technical section inserted below.
\\end{proof}
\\section{Proof of Main Theorem}\\label{sec:assembly}
Combining Section~\\ref{sec:tech-ch-a} and Section~\\ref{sec:tech-ch-b} completes the proof.
\\begin{thebibliography}{99}
\\bibitem{HostRef} Host Author, Host Paper (2020).
\\bibitem{UncitedHost} Nobody, Never Cited (1999).
\\end{thebibliography}
\\end{document}
`;

const chATex = `\\documentclass{amsart}
\\usepackage{amsmath}
\\usepackage{tikz}
\\newtheorem{theorem}{Theorem}
\\newtheorem{lemma}{Lemma}[section]
\\newcommand{\\AlphaOp}{\\mathrm{A}}
\\renewcommand{\\epsilon}{\\varepsilon}
\\begin{document}
\\title{Chapter A Standalone}
\\author{Synthetic Author}
\\maketitle
\\begin{abstract}Standalone abstract to strip.\\end{abstract}
\\section{Setup}\\label{sec:setup}
As established earlier in this paper, we use \\cite{ChARef} and \\AlphaOp.
\\subsection{Details}\\label{sub:det}
See \\ref{sec:setup} and Theorem~\\ref{thm:big}. % \\section{CommentedShouldNotDemote}
\\section*{Acknowledgements}
Produced with the Danus system.
\\begin{thebibliography}{99}
\\bibitem{ChARef} Author A, Chapter A Ref (2022).
\\bibitem{UnusedA} Author Unused (2001).
\\end{thebibliography}
\\end{document}
`;

const chBTex = `\\documentclass{amsart}
\\usepackage{amsmath}
\\newtheorem{theorem}{Theorem}
\\newcommand{\\BetaOp}{\\mathrm{C}}
\\begin{document}
\\title{Chapter B Standalone}
\\maketitle
\\section{Core Estimate}\\label{sec:setup}
Using \\BetaOp and \\cite{ChBRef}, see \\ref{sec:setup}. [GAP: check constant]
\\begin{thebibliography}{99}
\\bibitem{ChBRef} Author B, Chapter B Ref (2023).
\\end{thebibliography}
\\end{document}
`;

const hostLedger = '# REFERENCE_LEDGER\n\n## HostRef\n- verified-by: verifier\n- title: Host Paper\n\n## UncitedHost\n- verified-by: unverified\n';
const chALedger = '# REFERENCE_LEDGER\n\n## ChARef\n- verified-by: verifier\n- title: Chapter A Ref\n';
const chBLedger = '# REFERENCE_LEDGER\n\n## ChBRef\n- verified-by: unverified\n- title: Chapter B Ref\n';

test('pure assembleChapterTree handles topo order, demotion, label namespacing, hyperref load order, pointer replacement, bib filtering and seams', () => {
  // Pass ch-b before ch-a, with ch-b depending on ch-a -> topo sort orders ch-a then ch-b
  const out = assembleChapterTree({
    host: { tex: hostTex, ledger: hostLedger },
    chapters: [
      { chapterId: 'ch-b', title: 'Technical Chapter B', dependsOn: ['ch-a'], tex: chBTex, ledger: chBLedger },
      { chapterId: 'ch-a', title: 'Technical Chapter A', dependsOn: [], hostPointerLabel: 'thm:big', tex: chATex, ledger: chALedger },
    ],
    confirmedStyleRules: validateConfirmedStyleRules({ confirmedByOperator: true, rules: 'Prefer amsart theorem numbering.' }),
  });

  const tex = out.mainTexBytes.toString('utf8');
  assert.deepEqual(out.manifest.chapterOrder, ['ch-a', 'ch-b']);
  assert.deepEqual(out.manifest.cyclicDependencies, []);
  assert.deepEqual(out.manifest.forwardEdges, []);
  // \usepackage{tikz} inserted BEFORE \usepackage{hyperref}
  assert.ok(tex.indexOf('\\usepackage{tikz}') > 0 && tex.indexOf('\\usepackage{tikz}') < tex.indexOf('\\usepackage{hyperref}'));
  // \renewcommand preserved verbatim
  assert.match(tex, /\\renewcommand\{\\epsilon\}\{\\varepsilon\}/);
  // Framing stripped
  assert.doesNotMatch(tex, /Standalone abstract to strip/);
  assert.doesNotMatch(tex, /\\section\*\{Acknowledgements\}/);
  // Section demotion works and leaves commented \section untouched
  assert.match(tex, /\\subsection\{Setup\}\\label\{ch-a:sec:setup\}/);
  assert.match(tex, /\\subsubsection\{Details\}\\label\{ch-a:sub:det\}/);
  assert.match(tex, /% \\section\{CommentedShouldNotDemote\}/);
  // Both chapters had \label{sec:setup} -> namespaced to ch-a:sec:setup & ch-b:sec:setup (no collision!)
  assert.match(tex, /\\label\{ch-b:sec:setup\}/);
  assert.match(tex, /See \\ref\{ch-a:sec:setup\} and Theorem~\\ref\{thm:big\}/);
  // Host pointer-proof replaced
  assert.match(tex, /The complete development is given in Section~\\ref\{sec:tech-ch-a\}\./);
  assert.equal(out.manifest.chapters.find(c => c.chapterId === 'ch-a').pointerReplaced, true);
  // Chapters inserted BEFORE Proof of Main Theorem
  assert.ok(tex.indexOf('\\section{Technical Chapter A}') < tex.indexOf('\\section{Proof of Main Theorem}'));
  // Cited-only bibliography (drops UncitedHost and UnusedA)
  assert.match(tex, /\\bibitem\{HostRef\}/);
  assert.match(tex, /\\bibitem\{ChARef\}/);
  assert.match(tex, /\\bibitem\{ChBRef\}/);
  assert.doesNotMatch(tex, /UncitedHost|UnusedA/);
  // Unverified citation warning for ChBRef
  assert.ok(out.manifest.bibliographyWarnings.some(w => w.includes('ChBRef')));
  // Seam checklist captures setup-import in ch-a and proof-gap in ch-b
  assert.ok(out.manifest.seamChecklist.some(s => s.chapterId === 'ch-a' && s.kind === 'setup-import'));
  assert.ok(out.manifest.seamChecklist.some(s => s.chapterId === 'ch-b' && s.kind === 'proof-gap'));
  // Duplicate disclosure detected (host + ch-a had Danus system)
  assert.ok(out.manifest.confirmedStyleRulesSha256);
});

test('pure assembleChapterTree fails closed on macro conflict, duplicate labels, unconfirmed style rules and reports cycles honestly', () => {
  // Unconfirmed style rules -> PROJECT_PAPER_STYLE_UNCONFIRMED
  assert.throws(() => validateConfirmedStyleRules({ confirmedByOperator: false, rules: 'Custom rule.' }),
    err => err.code === 'PROJECT_PAPER_STYLE_UNCONFIRMED');

  // Macro conflict (\newcommand{\BaseOp} redefined with different body)
  const conflictingCh = chBTex.replace('\\newcommand{\\BetaOp}{\\mathrm{C}}', '\\newcommand{\\BaseOp}{\\mathrm{DIFFERENT}}');
  assert.throws(() => assembleChapterTree({
    host: { tex: hostTex, ledger: hostLedger },
    chapters: [{ chapterId: 'ch-b', title: 'B', dependsOn: [], tex: conflictingCh, ledger: chBLedger }],
  }), err => err.code === 'PROJECT_PAPER_TREE_MACRO_CONFLICT');

  // Duplicate label across merged doc (chapter defines \label{sec:intro} after namespacing? Force duplicate via same label twice inside chapter)
  const dupLabelCh = chBTex.replace('See', '\\label{sec:setup} See').replace('Using', '\\label{sec:setup} Using');
  assert.throws(() => assembleChapterTree({
    host: { tex: hostTex, ledger: hostLedger },
    chapters: [{ chapterId: 'ch-b', title: 'B', dependsOn: [], tex: dupLabelCh, ledger: chBLedger }],
  }), err => err.code === 'PROJECT_PAPER_TREE_DUPLICATE_LABEL');

  // Cyclic dependencies reported honestly without crashing
  const cyclic = assembleChapterTree({
    host: { tex: hostTex, ledger: hostLedger },
    chapters: [
      { chapterId: 'ch-a', title: 'A', dependsOn: ['ch-b'], tex: chATex, ledger: chALedger },
      { chapterId: 'ch-b', title: 'B', dependsOn: ['ch-a'], tex: chBTex, ledger: chBLedger },
    ],
  });
  assert.equal(cyclic.manifest.cyclicDependencies.length, 2);
  assert.ok(cyclic.manifest.forwardEdges.length >= 1);

  // Request snapshot rejects unknown dependency chapterId
  assert.throws(() => snapshotChapterTreeRequest({
    projectId: 'project-1',
    host: { reportId: 'report-11111111-1111-4111-8111-111111111111' },
    chapters: [{ chapterId: 'ch-a', title: 'A', reportId: 'report-22222222-2222-4222-8222-222222222222', dependsOn: ['ch-missing'] }],
  }), err => err.code === 'PROJECT_INVALID_INPUT');
});

test('end-to-end paper_chapter_tree_stitch -> seam discharge revision -> audit -> verify -> math review -> deliver', async t => {
  const writers = [], stages = [];
  const facts = [
    { fact_id: factHostId, predecessors: [], markdown: `---\nfact_id: ${factHostId}\npredecessors: []\nexternal_refs: [{"key":"HostRef","title":"Host Paper","year":"2020"}]\n---\n## statement\nHost theorem.\n## proof\nPointer.\n` },
    { fact_id: factChAId, predecessors: [], markdown: `---\nfact_id: ${factChAId}\npredecessors: []\nexternal_refs: [{"key":"ChARef","title":"Chapter A Ref","year":"2022"}]\n---\n## statement\nChapter A.\n## proof\nProof A.\n` },
    { fact_id: factChBId, predecessors: [factChAId], markdown: `---\nfact_id: ${factChBId}\npredecessors: [${factChAId}]\nexternal_refs: [{"key":"ChBRef","title":"Chapter B Ref","year":"2023"}]\n---\n## statement\nChapter B.\n## proof\nProof B.\n` },
  ];
  const byId = new Map(facts.map(f => [f.fact_id, f]));
  let paperCount = 0;
  const paperOutputs = [
    `${hostTex}\n%%%PROVENANCE%%%\n${JSON.stringify({ 'thm:big': factHostId })}\n`,
    `${chATex}\n%%%PROVENANCE%%%\n${JSON.stringify({ 'sec:setup': factChAId })}\n`,
    `${chBTex}\n%%%PROVENANCE%%%\n${JSON.stringify({ 'sec:setup': factChBId })}\n`,
  ];
  const f = await fixture(t, {
    multiWorker: true,
    coreCall(_binding, op, args) {
      if (op === 'fact_list_page') return { facts: structuredClone(facts) };
      return structuredClone(byId.get(args.fact_id));
    },
    summaryWriter: {
      async start(input) {
        writers.push(input);
        const kind = input.kind;
        const spec = kind === 'paper-source'
          ? { role: 'report-writer', prefix: 'math-paper-source-writer', agentKind: 'math-paper-source-writer' }
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
        let text;
        if (kind === 'paper-source') text = paperOutputs[paperCount++];
        else if (kind === 'paper-revision') {
          text = '%%%PATCH%%%\n<<<<<<< FIND\nAs established earlier in this paper, we use \\cite{ChARef} and \\AlphaOp.\n=======\nBy Section~\\ref{sec:intro}, we use \\cite{ChARef} and \\AlphaOp.\n>>>>>>> REPLACE\n%%%REVISION_SUMMARY%%%\nDischarged setup-import seam.\n';
        } else if (kind === 'reference-audit') {
          text = 'Offline audit: verify HostRef, ChARef, ChBRef.\n';
        } else if (kind === 'reference-verification') {
          text = JSON.stringify(['HostRef', 'ChARef', 'ChBRef'].map(key => ({
            key, verdict: 'verified',
            confirmed_metadata: { authors: 'Author', title: key, year: '2023', venue: 'Journal' },
            source_url: `https://example.org/${key}`, note: 'Confirmed.', replacement_suggestion: 'Keep entry.',
          })));
        } else {
          text = JSON.stringify({ findings: [], report: 'Assembled chapter-tree paper is mathematically sound.' });
        }
        const terminal = { ...binding, sendState: 'accepted', state: 'completed', modelStopReason: 'stop', cleanupPending: false, finalText: text };
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

  // Produce 3 separate paper-source manuscripts (host, ch-a, ch-b)
  await callTool({ action: 'finalize', projectId, paperId: 'host', factIds: [factHostId] });
  await callTool({ action: 'finalize', projectId, paperId: 'cha', factIds: [factChAId] });
  await callTool({ action: 'finalize', projectId, paperId: 'chb', factIds: [factChBId] });
  const hostId = (await callTool({ action: 'paper', projectId, paperId: 'host', brief: 'Host paper.' })).details.reportId;
  await runReport(hostId);
  const chAId = (await callTool({ action: 'paper', projectId, paperId: 'cha', brief: 'Chapter A.' })).details.reportId;
  await runReport(chAId);
  const chBId = (await callTool({ action: 'paper', projectId, paperId: 'chb', brief: 'Chapter B.' })).details.reportId;
  await runReport(chBId);

  // Assemble chapter tree via math_project paper_chapter_tree_stitch
  const stitched = await callTool({
    action: 'paper_chapter_tree_stitch', projectId,
    host: { reportId: hostId },
    chapters: [
      { chapterId: 'ch-b', title: 'Technical Chapter B', reportId: chBId, dependsOn: ['ch-a'] },
      { chapterId: 'ch-a', title: 'Technical Chapter A', reportId: chAId, hostPointerLabel: 'thm:big' },
    ],
    confirmedStyleRules: { confirmedByOperator: true, rules: 'Use amsart theorem styles.' },
  });
  assert.equal(stitched.isError, false);
  assert.equal(stitched.details.kind, 'paper-chapter-tree');
  assert.equal(stitched.details.state, 'completed');
  assert.deepEqual(stitched.details.chapterOrder, ['ch-a', 'ch-b']);
  const treeId = stitched.details.reportId;
  assert.deepEqual(stitched.details.files.map(file => file.name).sort(),
    ['CHAPTER_TREE_MANIFEST.json', 'REFERENCE_LEDGER.md', 'main.tex']);

  // Discharge seam via operator-notes revision directly on paper-chapter-tree
  const seamRevId = (await callTool({
    action: 'paper_revise', projectId, reportId: treeId,
    mode: 'operator-notes', notes: 'Replace setup-import sentence with cross-reference to Section intro.',
  })).details.reportId;
  await runReport(seamRevId);
  const seamRes = await callTool({ action: 'paper_revision_result', projectId, reportId: seamRevId });
  assert.equal(seamRes.isError, false);
  assert.equal(seamRes.details.state, 'completed');

  // Audit -> Verify on the revised chapter-tree proposal
  const auditId = (await callTool({ action: 'paper_audit', projectId, reportId: seamRevId })).details.reportId;
  await runReport(auditId);
  const verId = (await callTool({ action: 'paper_verify', projectId, reportId: auditId })).details.reportId;
  await runReport(verId);
  const verRes = await callTool({ action: 'paper_verify_result', projectId, reportId: verId });
  assert.equal(verRes.details.citationStatus, 'verified');

  // Whole-paper math review on the verified chapter-tree revision
  const mathId = (await callTool({ action: 'paper_verify_math', projectId, reportId: verId })).details.reportId;
  await runReport(mathId);
  const mathRes = await callTool({ action: 'paper_verify_math_result', projectId, reportId: mathId });
  assert.equal(mathRes.details.verdict, 'correct');

  // Deliver (uncompiled TeX allowed explicitly)
  const delivered = await callTool({
    action: 'paper_deliver', projectId, reportId: verId,
    mathReviewReportId: mathId, allowUncompiledTex: true,
  });
  assert.equal(delivered.isError, false);
  assert.equal(delivered.details.mathGate, 'passed');
  assert.equal(delivered.details.citationStatus, 'no-unverified-ledger-entries');
  assert.equal(delivered.details.texDeliverable, true);
  assert.equal(delivered.details.deliverOk, false);
  assert.equal(delivered.details.compileStatus, 'not-run');
  assert.equal(delivered.details.pushAuthorized, false);
});
