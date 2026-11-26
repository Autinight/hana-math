// Tests for Math Settings TeX compiler path configuration, hardened two-pass compilation,
// paper_compile action, and paper_deliver compileReportId integration (including real local pdflatex when present).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  createPaperCompileService,
  normalizeTexCompilerPath,
  deriveTexReadRoots,
  registerTexSettings,
} from '../packages/hana-math/paper-compile-service.mjs';
import { createContextStore } from '../packages/hana-math/context-service.mjs';
import { createProjectReportService } from '../packages/hana-math/project-report-service.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';

const LOCAL_PDFLATEX = '/Library/TeX/texbin/pdflatex';
const hasRealPdflatex = existsSync(LOCAL_PDFLATEX);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function memoryStorage() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async set(key, value) { map.set(key, structuredClone(value)); },
  };
}

test('normalizeTexCompilerPath enforces absolute pdflatex/pdftex allowlist and supports auto-detect reset', () => {
  assert.equal(normalizeTexCompilerPath(null), null);
  assert.equal(normalizeTexCompilerPath(undefined), null);
  assert.equal(normalizeTexCompilerPath('   '), null);
  assert.equal(normalizeTexCompilerPath('/Library/TeX/texbin/pdflatex'), '/Library/TeX/texbin/pdflatex');
  assert.equal(normalizeTexCompilerPath('/usr/local/texlive/2026/bin/universal-darwin/pdftex'), '/usr/local/texlive/2026/bin/universal-darwin/pdftex');

  for (const bad of [
    123,
    'pdflatex',
    './pdflatex',
    '/bin/sh',
    '/usr/bin/python3',
    '/Library/TeX/texbin/',
    '/Library/TeX/texbin/pdflatex --shell-escape',
    '/Library/TeX/texbin/pdflatex\n',
    '/',
  ]) {
    assert.throws(() => normalizeTexCompilerPath(bad), { code: 'PAPER_COMPILE_PATH_INVALID' });
  }

  const roots = deriveTexReadRoots('/usr/local/texlive/2026/bin/universal-darwin/pdftex', '/Library/TeX/texbin/pdflatex');
  assert.ok(roots.includes('/usr/local/texlive/2026'));
  assert.ok(roots.includes('/Library/TeX'));
  assert.ok(!roots.includes('/'));
  assert.ok(!roots.includes('/usr/local'));
});

test('registerTexSettings exposes GET/POST /settings/tex and POST /settings/tex/test with permission-denied safety', async t => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-tex-routes-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const storage = memoryStorage();
  let denied = false;
  const sdk = {
    dataDir,
    storage: { global: storage },
    process: {
      async resolveExecutable({ candidates }) {
        if (denied) throw Object.assign(new Error('denied'), { code: 'APP_CAPABILITY_DENIED' });
        if (candidates.includes('/bad/pdflatex')) return null;
        if (candidates.includes('/evil/pdflatex')) return { path: '/bin/sh', mtimeMs: 1, size: 100 };
        return { path: '/usr/local/texlive/2026/bin/universal-darwin/pdftex', mtimeMs: 1, size: 100 };
      },
    },
  };
  const service = createPaperCompileService(sdk, {
    execCompiler: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'stub' }),
  });

  const handlers = new Map();
  registerTexSettings({
    get(route, fn) { handlers.set(`GET ${route}`, fn); },
    post(route, fn) { handlers.set(`POST ${route}`, fn); },
  }, service);

  const invoke = async (key, body) => {
    let status = 200, payload;
    await handlers.get(key)({
      req: {
        async json() { return JSON.parse(body); },
        async text() { return body ?? ''; },
      },
      json(data, code = 200) { status = code; payload = data; return data; },
    });
    return { status, payload };
  };

  // Auto-detect GET
  const initial = await invoke('GET /settings/tex');
  assert.equal(initial.status, 200);
  assert.equal(initial.payload.ok, true);
  assert.equal(initial.payload.tex.mode, 'auto');
  assert.equal(initial.payload.tex.available, true);
  assert.equal(initial.payload.tex.resolvedPath, '/usr/local/texlive/2026/bin/universal-darwin/pdftex');

  // Reject symlink resolving to /bin/sh
  const evil = await invoke('POST /settings/tex', JSON.stringify({ compilerPath: '/evil/pdflatex' }));
  assert.equal(evil.status, 200);
  assert.equal(evil.payload.tex.available, false);
  assert.equal(evil.payload.tex.error.code, 'PAPER_COMPILE_PATH_INVALID');

  // Reject invalid basename on save
  const bad = await invoke('POST /settings/tex', JSON.stringify({ compilerPath: '/bin/bash' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.payload.ok, false);
  assert.equal(bad.payload.error.code, 'PAPER_COMPILE_PATH_INVALID');

  // Save valid custom path & reset to auto
  const saved = await invoke('POST /settings/tex', JSON.stringify({ compilerPath: '/Library/TeX/texbin/pdflatex' }));
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.tex.mode, 'custom');
  assert.equal(saved.payload.tex.configuredPath, '/Library/TeX/texbin/pdflatex');
  assert.equal(saved.payload.tex.available, true);

  // Permission denial surfaces cleanly without crashing settings panel
  denied = true;
  const blocked = await invoke('GET /settings/tex');
  assert.equal(blocked.status, 200);
  assert.equal(blocked.payload.tex.available, false);
  assert.equal(blocked.payload.tex.error.code, 'PAPER_COMPILE_PERMISSION_DENIED');
});

test('real local pdflatex compiles valid paper, captures compile-fix log on error, and gates paper_deliver with compileReportId', { skip: !hasRealPdflatex }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-real-tex-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createContextStore(root);
  const creator = { sessionId: 'creator-tex', sessionPath: '/fixture/creator-tex.jsonl' };
  const ownerCtx = Object.freeze({ callToken: 'opaque-tex-token', sessionPath: creator.sessionPath });
  const p = { meta: { projectId: 'project-tex', creator } };
  const stagedFiles = [];
  const storage = memoryStorage();

  const sdk = {
    dataDir: root,
    storage: { global: storage },
    process: {
      async resolveExecutable({ candidates }) {
        for (const c of candidates) {
          if (path.isAbsolute(c) && existsSync(c)) {
            const real = realpathSync(c);
            const st = await fs.stat(real);
            return { path: real, mtimeMs: st.mtimeMs, size: st.size };
          }
        }
        return null;
      },
    },
    resources: {
      async stage(input) {
        stagedFiles.push(input);
        return { ok: true, resource: { kind: 'session-file', sessionId: creator.sessionId, fileId: `file-${stagedFiles.length}` } };
      },
    },
    tasks: {
      async registerHandler() { return () => {}; },
    },
  };

  const texCompiler = createPaperCompileService(sdk);
  // 1. Save custom path and run Settings "测试编译"
  const saved = await texCompiler.saveSettings({ compilerPath: LOCAL_PDFLATEX });
  assert.equal(saved.available, true);
  assert.equal(saved.mode, 'custom');
  const tested = await texCompiler.testCompiler();
  assert.equal(tested.ok, true);
  assert.ok(tested.pdfBytes > 1000);
  assert.match(tested.version, /^This is pdfTeX/);

  // 2. Wire ProjectReportService with real texCompiler
  const reports = await createProjectReportService({
    sdk, store, texCompiler,
    summaryWriter: { async dispose() { return { cleanupPending: false, errors: [] }; } },
    authorizeCreator: async (_p, ctx) => { if (ctx !== ownerCtx) throw Object.assign(new Error('denied'), { code: 'PROJECT_OWNER_DENIED' }); },
    projects: () => [p], getProject: () => p, assertLive() {}, track: (_p, job) => job,
    projectLocation: () => 'project',
    readInput: async () => ({ problem: 'Real TeX problem' }),
    assertPaperTarget: async () => {},
    gatherPaperFacts: async () => ({ facts: [], asOf: '0'.repeat(64) }),
    withPaperPublication: async (_id, _auth, _target, cb) => cb({ facts: [], asOf: '0'.repeat(64) }),
  });
  t.after(() => reports.dispose());

  // Seed a clean settled paper-source report + a broken paper-source report + a clean passing math review.
  const goodTex = Buffer.from([
    '\\documentclass{article}',
    '\\usepackage{amsmath}',
    '\\title{Real TeX Compile Verification}',
    '\\begin{document}',
    '\\maketitle',
    '\\section{Main Result}',
    'For every $n \\ge 1$, we have $n^2 \\ge n$. See \\cite{Alpha}.',
    '\\begin{thebibliography}{9}',
    '\\bibitem{Alpha} Opaque Author, \\emph{Verified Reference}, 2026.',
    '\\end{thebibliography}',
    '\\end{document}',
    '',
  ].join('\n'), 'utf8');
  const badTex = Buffer.from('\\documentclass{article}\n\\begin{document}\n\\totallyUndefinedMacro\n\\end{document}\n', 'utf8');
  const ledger = Buffer.from('# REFERENCE_LEDGER\n\n## Alpha\n- citation: Opaque Author (2026)\n- verified-by: verifier\n', 'utf8');

  async function seedSource(texBytes) {
    const reportId = `report-${randomUUID()}`;
    const dir = `project/reports/${reportId}`;
    await store.mkdir(dir, true);
    await store.write(`${dir}/main.tex`, texBytes);
    await store.write(`${dir}/REFERENCE_LEDGER.md`, ledger);
    await store.write(`${dir}/provenance.json`, Buffer.from('{}\n'));
    const fid = 'a'.repeat(16);
    const meta = {
      schemaVersion: 1, projectId: p.meta.projectId, reportId, kind: 'paper-source',
      paper: {
        paperId: 'main', brief: 'Real TeX brief', instructions: '',
        target: { schemaVersion: 1, projectId: p.meta.projectId, paperId: 'main', factIds: [fid], factDigests: { [fid]: sha('f') }, finalizedBy: 'creator', at: 1 },
      },
      sourceStatus: 'generated', state: 'completed', language: 'English',
      creator, createdAt: 1, completedAt: 2,
      taskId: null, taskCreating: false, scheduleId: null, scheduleCreating: false, scheduleCleaned: true,
      nonce: 'a'.repeat(48), writerStarting: false, writer: null,
      cleanupPending: false, stopRequested: false, taskSettlement: 'confirmed', delivery: null,
      sha256: sha(texBytes), bytes: texBytes.length,
      artifacts: {
        source: { name: 'main.tex', artifact: `${dir}/main.tex`, mime: 'application/x-tex', bytes: texBytes.length, sha256: sha(texBytes) },
        ledger: { name: 'REFERENCE_LEDGER.md', artifact: `${dir}/REFERENCE_LEDGER.md`, mime: 'text/markdown', bytes: ledger.length, sha256: sha(ledger) },
        provenance: { name: 'provenance.json', artifact: `${dir}/provenance.json`, mime: 'application/json', bytes: 3, sha256: sha(Buffer.from('{}\n')) },
      },
    };
    await store.write(`${dir}/metadata.json`, JSON.stringify(meta));
    return reportId;
  }

  const goodSourceId = await seedSource(goodTex);
  const badSourceId = await seedSource(badTex);

  // Seed matching passing MATH_REVIEW.json for goodSourceId
  const mathReportId = `report-${randomUUID()}`;
  const mathDir = `project/reports/${mathReportId}`;
  await store.mkdir(mathDir, true);
  const { PAPER_MATH_PINS } = await import('../packages/hana-math/paper-math-verification.mjs');
  const mathBinding = {
    sourceReportId: goodSourceId, mainSha256: sha(goodTex), ledgerSha256: sha(ledger),
    contractSha256: PAPER_MATH_PINS.contractSha256, verifierPromptSha256: PAPER_MATH_PINS.verifierPromptSha256,
    promptSha256: sha('p'),
  };
  const reviewObj = {
    schemaVersion: 1, kind: 'paper-math-verification', projectId: p.meta.projectId, reportId: mathReportId,
    binding: mathBinding, findings: [], report: 'All steps verified.', verdict: 'correct',
    limitations: ['lim-1', 'lim-2', 'lim-3'],
  };
  const reviewBytes = Buffer.from(JSON.stringify(reviewObj, null, 2) + '\n', 'utf8');
  const rawResponseBytes = Buffer.from(JSON.stringify({ findings: [], report: 'All steps verified.' }) + '\n', 'utf8');
  await store.write(`${mathDir}/MATH_REVIEW.json`, reviewBytes);
  await store.write(`${mathDir}/raw-response.txt`, rawResponseBytes);
  await store.write(`${mathDir}/metadata.json`, JSON.stringify({
    schemaVersion: 1, projectId: p.meta.projectId, reportId: mathReportId, kind: 'paper-math-verification',
    math: mathBinding,
    state: 'completed', mathVerdict: 'correct', mathTaskStatus: 'completed', language: 'English',
    creator, createdAt: 1, completedAt: 2,
    taskId: null, taskCreating: false, scheduleId: null, scheduleCreating: false, scheduleCleaned: true,
    nonce: 'b'.repeat(48), writerStarting: false,
    writer: { state: 'completed', modelStopReason: 'stop', cleanupPending: false },
    cleanupPending: false, stopRequested: false, taskSettlement: 'confirmed', delivery: null,
    sha256: sha(reviewBytes), bytes: reviewBytes.length,
    artifacts: {
      response: { name: 'raw-response.txt', artifact: `${mathDir}/raw-response.txt`, mime: 'text/plain', bytes: rawResponseBytes.length, sha256: sha(rawResponseBytes) },
      review: { name: 'MATH_REVIEW.json', artifact: `${mathDir}/MATH_REVIEW.json`, mime: 'application/json', bytes: reviewBytes.length, sha256: sha(reviewBytes) },
    },
  }));

  // Reload reports service so seeded reports are loaded cleanly from disk
  const reportsLoaded = await createProjectReportService({
    sdk, store, texCompiler,
    summaryWriter: { async dispose() { return { cleanupPending: false, errors: [] }; } },
    authorizeCreator: async (_p, ctx) => { if (ctx !== ownerCtx) throw Object.assign(new Error('denied'), { code: 'PROJECT_OWNER_DENIED' }); },
    projects: () => [p], getProject: () => p, assertLive() {}, track: (_p, job) => job,
    projectLocation: () => 'project',
    readInput: async () => ({ problem: 'Real TeX problem' }),
    assertPaperTarget: async () => {},
    gatherPaperFacts: async () => ({ facts: [], asOf: '0'.repeat(64) }),
    withPaperPublication: async (_id, _auth, _target, cb) => cb({ facts: [], asOf: '0'.repeat(64) }),
  });
  t.after(() => reportsLoaded.dispose());

  // 3. Compile valid manuscript -> passed + real main.pdf + COMPILE_LOG.txt
  const compiledOk = await reportsLoaded.compilePaper(p, { reportId: goodSourceId }, ownerCtx);
  assert.equal(compiledOk.kind, 'paper-compile');
  assert.equal(compiledOk.state, 'completed');
  assert.equal(compiledOk.compileStatus, 'passed');
  assert.ok(compiledOk.pdfBytes > 1000);
  assert.match(compiledOk.pdfSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(compiledOk.files.map(f => f.name), ['main.pdf', 'COMPILE_LOG.txt']);

  // 4. Compile broken manuscript -> failed + real logExcerpt for compile-fix
  const compiledBad = await reportsLoaded.compilePaper(p, { reportId: badSourceId }, ownerCtx);
  assert.equal(compiledBad.state, 'failed');
  assert.equal(compiledBad.compileStatus, 'failed');
  assert.equal(compiledBad.error, 'PAPER_COMPILE_TEX_ERROR');
  assert.match(compiledBad.logExcerpt, /totallyUndefinedMacro|Undefined control sequence/i);
  assert.deepEqual(compiledBad.files.map(f => f.name), ['COMPILE_LOG.txt']);

  // 5. Deliver with passed compileReportId -> deliverOk: true, pdfDelivered: true, main.pdf staged!
  const delivered = await reportsLoaded.deliver(p, {
    projectId: p.meta.projectId,
    reportId: goodSourceId,
    mathReviewReportId: mathReportId,
    compileReportId: compiledOk.reportId,
  }, ownerCtx);
  assert.equal(delivered.deliverOk, true);
  assert.equal(delivered.compileStatus, 'passed');
  assert.equal(delivered.pdfDelivered, true);
  assert.equal(delivered.compileSummary.pdfSha256, compiledOk.pdfSha256);
  assert.deepEqual(delivered.files.map(f => f.name), [
    'main.tex', 'REFERENCE_LEDGER.md', 'MATH_REVIEW.json', 'DELIVERY_MANIFEST.json', 'main.pdf',
  ]);

  // 6. Reject failed compileReportId on paper_deliver
  await assert.rejects(reportsLoaded.deliver(p, {
    projectId: p.meta.projectId,
    reportId: goodSourceId,
    mathReviewReportId: mathReportId,
    compileReportId: compiledBad.reportId,
  }, ownerCtx), { code: 'PROJECT_PAPER_DELIVERY_COMPILE_MISMATCH' });

  // 7. Verify math_project tool registration wires paper_compile & paper_deliver.compileReportId cleanly
  const registered = new Map();
  const noopResearch = { run() {}, status() {}, setupStatus() {}, setToolMode() {}, result() {}, stop() {}, invoke() {}, recordSubmissionInputRejection() {} };
  const reg = await registerMathResearch(
    { dataDir: root, tools: { async register(def) { registered.set(def.name, def); return () => registered.delete(def.name); } } },
    noopResearch,
    {
      create() {}, list() {}, status() {}, assign() {}, start() {}, stop() {}, result() {}, invoke() {}, handles() {}, goal() {}, mainGoal() {},
      paperCompile: async (args, ctx) => {
        assert.equal(ctx, ownerCtx);
        return compiledOk;
      },
      paperDeliver: async (args, ctx) => {
        assert.equal(args.compileReportId, compiledOk.reportId);
        assert.equal(ctx, ownerCtx);
        return delivered;
      },
    },
  );
  t.after(() => reg.dispose());
  const tool = registered.get('math_project');
  const compileOut = await tool.execute({ action: 'paper_compile', projectId: p.meta.projectId, reportId: goodSourceId, context: ownerCtx });
  assert.equal(compileOut.isError, false);
  assert.equal(compileOut.details.compileStatus, 'passed');
  const deliverOut = await tool.execute({
    action: 'paper_deliver', projectId: p.meta.projectId, reportId: goodSourceId,
    mathReviewReportId: mathReportId, compileReportId: compiledOk.reportId, context: ownerCtx,
  });
  assert.equal(deliverOut.isError, false);
  assert.equal(deliverOut.details.deliverOk, true);
  assert.equal(deliverOut.details.pdfDelivered, true);
});
