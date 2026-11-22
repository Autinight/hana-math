// End-to-end SOFTWARE fixture: no Hana runtime, real model, network or mathematics.
// Only this test's fake runtime executes system Python, against a relocated copy
// of the real packaged entry/core. Production runtime has no such fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { createResearchService } from '../packages/hana-math/research-service.mjs';
import { createResearchSessions } from '../packages/hana-math/research-sessions.mjs';
import { createContextService } from '../packages/hana-math/context-service.mjs';
import { createProfileService } from '../packages/hana-math/profile-service.mjs';
import { createResearchRuntime } from '../packages/hana-math/runtime/research-runtime.mjs';

const executeFile = promisify(execFile);
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const clone = structuredClone;
const CANDIDATE = { statement: 'opaque software fixture statement',
  proof: 'opaque software fixture payload with several distinct tokens only',
  // Core's documented serializer strips outer whitespace; use a fixture with
  // no boundary whitespace so full-tail inclusion is an exact assertion.
  intuition: 'opaque complete export tail '.repeat(900).trim() };
const FIXTURE_REPORT = { verification_report: { summary: 'software fixture verifier only', critical_errors: [], gaps: [] },
  verdict: 'correct', repair_hints: '' };
const WRONG_REPORT = { verification_report: { summary: 'software fixture rejection only',
  critical_errors: [], gaps: [{ location: 'opaque fixture payload', issue: 'missing corrected opaque fixture token' }] },
  verdict: 'wrong', repair_hints: 'Append the exact opaque software fixture repair token: corrected-fixture-token.' };
const CORRECTED_CANDIDATE = { ...CANDIDATE, proof: `${CANDIDATE.proof} corrected-fixture-token` };
const roles = ['main', 'worker', 'verifier'];
const RESEARCH_INPUT = { problem: 'opaque-problem-sentinel-4db810a1', operatorProfile: 'opaque-operator-sentinel-5ec921b2', workerTask: 'opaque-task-sentinel-6fda32c3' };
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function deadline(promise, milliseconds = 20000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Software fixture deadline exceeded')), milliseconds); })]).finally(() => clearTimeout(timer));
}

async function integration(t, scenario) {
  const projectWorker = scenario === 'project-worker' || scenario.startsWith('controlled-');
  const repair = scenario === 'repair' || scenario === 'controlled-repair';
  const confirmedFailures = scenario === 'controlled-configured-model-failures';
  const confirmedModelErrors = scenario === 'controlled-configured-model-errors';
  const configured = scenario === 'controlled-configured-chain' || scenario === 'controlled-configured-unknown-write' || confirmedFailures || confirmedModelErrors;
  const chain = scenario === 'controlled-chain' || scenario === 'controlled-configured-chain';
  const mismatch = scenario === 'mismatch' || scenario === 'controlled-mismatch';
  const lateStop = scenario === 'controlled-late-send-stop';
  const reopenAfterFailure = scenario === 'controlled-resume-failure-reopen';
  const sendFailure = scenario === 'controlled-resume-failure' || reopenAfterFailure;
  const unknownWrite = scenario === 'controlled-unknown-write' || scenario === 'controlled-configured-unknown-write';
  const resumeEntered = deferred(), releaseSend = deferred(), abortObserved = deferred();
  let chainCandidate;
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'research-integration-')));
  const dataDir = path.join(base, 'data'), packageRoot = path.join(base, 'package');
  await fs.mkdir(dataDir); await fs.mkdir(packageRoot);
  let service, registration;
  const scriptJobs = [], scriptErrors = [];
  t.after(async () => {
    releaseSend.resolve();
    await registration?.dispose(); await service?.dispose();
    await Promise.allSettled(scriptJobs);
    await fs.rm(base, { recursive: true, force: true });
  });
  // Copy only project-owned package references and the frozen Python sources.
  const sourcePackage = path.join(repo, 'packages/hana-math');
  const manifest = JSON.parse(await fs.readFile(path.join(sourcePackage, 'reference-sources.json'), 'utf8'));
  for (const relative of ['reference-sources.json', ...manifest.files.map((entry) => entry.target), 'runtime/research_entry.py']) {
    const target = path.join(packageRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(sourcePackage, relative), target);
  }
  await fs.cp(path.join(repo, 'engine/src'), path.join(packageRoot, 'engine/src'), {
    recursive: true, filter: (source) => !source.includes('__pycache__') && !source.endsWith('.pyc'),
  });
  // This is an install receipt fixture, never an executable production fallback.
  await fs.mkdir(path.join(packageRoot, 'dependencies/python/bin'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'dependencies/python/bin/python3'), 'software runtime placeholder', { mode: 0o700 });
  await fs.writeFile(path.join(packageRoot, 'dependencies/runtime.json'), JSON.stringify({ schemaVersion: 1,
    platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' }));

  const scope = new AsyncLocalStorage(), tools = new Map(), handlers = new Map(), schedules = new Map(), tasks = new Map();
  const hostSessions = new Map(), subscriptions = new Set(), runtimeStates = new Map();
  const origin = { sessionPath: '/fixture-only/origin.jsonl', callToken: 'fixture-host-origin-token' };
  const models = roles.map((role) => ({ provider: `fixture-${role}-provider`, id: `${role}-saved-model` }));
  const agents = roles.map((role) => ({ id: `saved-${role}`, name: `Saved fixture ${role}`, state: 'active', deletedAt: null,
    ownerPluginId: 'hana-math', visibility: 'plugin_private',
    plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'role', roleId: role } }));
  const calls = { create: [], send: [], aborts: [], failedWrites: 0, python: [], stage: [], profile: [], writes: [], tools: [], tasks: [] };
  const ended = deferred(); let workerRounds = 0, verifierRounds = 0, pendingReceipt, rejectionObserved = false;
  let retainedNoteBytes;
  const reported = [];
  const hostContext = (session) => ({ callToken: `fixture-host-${session.sessionId}`, sessionPath: session.path });
  async function tool(name, arguments_, context = origin) {
    assert.ok(tools.has(name), `unregistered tool ${name}`);
    return scope.run({ kind: 'model-tool', context }, async () => {
      const response = await tools.get(name).execute({ ...clone(arguments_), context });
      assert.deepEqual(JSON.parse(response.content[0].text), response.details);
      calls.tools.push({ name, arguments: clone(arguments_), sessionPath: context.sessionPath, response: clone(response) });
      return response;
    });
  }
  function good(response) { assert.equal(response.isError, false, JSON.stringify(response.details)); return response.details; }
  async function emit(session, data) {
    for (const subscription of [...subscriptions]) if (subscription.filter.sessionPath === session.path && subscription.filter.types.includes(data.type)) {
      subscription.callback({ ...data, sessionId: session.sessionId }, session.path);
    }
  }
  async function scriptedTurn(session, prompt) {
    await emit(session, { type: 'agent_start' });
    let finalText;
    const ctx = hostContext(session);
    if ((confirmedFailures || confirmedModelErrors) && session.agentId === 'saved-worker') {
      finalText = confirmedFailures ? '' : 'opaque worker error'; // Host event supplies the termination class.
    } else if (session.agentId === 'saved-main') {
      if (session.toolNames.includes('math_assign')) {
        const forbidden = await tool('fact_submit', CANDIDATE, ctx);
        assert.equal(forbidden.isError, true); assert.equal(forbidden.details.error.code, 'ROLE_DENIED');
        good(await tool('math_assign', { task: 'opaque software fixture task; no mathematics or model inference' }, ctx));
        finalText = JSON.stringify({ assigned: true });
      } else {
        const found = good(await tool('fact_search', { query: 'opaque' }, ctx));
        assert.equal(found.results.length, 1); finalText = JSON.stringify({ fixtureSummaryOnly: true });
      }
    } else if (session.agentId === 'saved-worker') {
      workerRounds++;
      assert.equal(await fs.readFile(path.join(session.cwd, 'TASK.md'), 'utf8'), 'opaque software fixture task; no mathematics or model inference\n');
      assert.ok(!prompt.includes('opaque software fixture task; no mathematics or model inference'));
      const workspaceReceipt = JSON.parse(await fs.readFile(path.join(session.cwd, projectWorker ? 'project-workspace.json' : 'research-workspace.json'), 'utf8'));
      assert.equal(workspaceReceipt.state, 'ready');
      assert.equal(workspaceReceipt.files.find(file => file.path === 'TASK.md').sha256, sha(await fs.readFile(path.join(session.cwd, 'TASK.md'))));
      if (workerRounds === 1) {
        const note = good(await tool('math_local_memory', { action: 'append', text: 'opaque private SOFTWARE fixture note' }, ctx));
        assert.equal(note.entries.length, 1);
        retainedNoteBytes = await fs.readFile(path.join(session.cwd, 'local_memory/notes.jsonl'));
        pendingReceipt = good(await tool('fact_submit', CANDIDATE, ctx));
        assert.equal(pendingReceipt.pending, true); assert.equal(pendingReceipt.accepted, false);
        assert.equal(Object.hasOwn(pendingReceipt, 'fact_id'), false);
        assert.equal(calls.python.filter((call) => call.request.operation === 'fact_submit').length, 0);
        const paths = JSON.parse(await fs.readFile(path.join(session.cwd, 'PATHS.json'), 'utf8'));
        assert.deepEqual(await fs.readdir(path.join(paths.shared.factGraph, 'facts')), []);
        finalText = JSON.stringify(pendingReceipt);
      } else {
        const note = good(await tool('math_local_memory', { action: 'read' }, ctx));
        assert.equal(note.entries.length, 1);
        assert.equal(note.entries[0].text, 'opaque private SOFTWARE fixture note');
        assert.deepEqual(await fs.readFile(path.join(session.cwd, 'local_memory/notes.jsonl')), retainedNoteBytes);
        if (chain && workerRounds === 2) {
          const first = calls.python.filter(call => call.request.operation === 'fact_submit');
          assert.equal(first.length, 1); assert.equal(first[0].envelope.result.accepted, true);
          const parent = first[0].envelope.result.fact_id;
          assert.ok(prompt.includes(parent)); assert.match(prompt, /"accepted":true/);
          chainCandidate = { ...CORRECTED_CANDIDATE, predecessors: [parent] };
          const pending = good(await tool('fact_submit', chainCandidate, ctx)); assert.equal(pending.pending, true);
          const duplicate = await tool('fact_submit', chainCandidate, ctx);
          assert.equal(duplicate.isError, true); assert.equal(duplicate.details.error.code, 'SUBMISSION_ALREADY_PENDING');
          finalText = JSON.stringify(pending);
        } else if (repair && workerRounds === 2) {
          const workers = [...hostSessions.values()].filter((item) => item.agentId === 'saved-worker');
          assert.equal(workers.length, projectWorker ? 1 : 2);
          if (projectWorker) assert.equal(workers[0].sessionId, session.sessionId);
          else assert.notEqual(workers[0].sessionId, session.sessionId);
          assert.equal(workers[0].cwd, session.cwd);
          assert.match(prompt, /"accepted":false/); assert.match(prompt, /"verdict":"wrong"/);
          assert.ok(prompt.includes(WRONG_REPORT.repair_hints), 'second worker must receive the precise verifier repair hints');
          const submits = calls.python.filter((call) => call.request.operation === 'fact_submit');
          assert.equal(submits.length, 1);
          assert.equal(submits[0].envelope.ok, true);
          assert.equal(submits[0].envelope.result.accepted, false);
          assert.equal(submits[0].envelope.result.verdict, 'wrong');
          assert.equal(submits[0].envelope.result.repair_hints, WRONG_REPORT.repair_hints);
          const paths = JSON.parse(await fs.readFile(path.join(session.cwd, 'PATHS.json'), 'utf8'));
          assert.deepEqual(await fs.readdir(path.join(paths.shared.factGraph, 'facts')), [], 'wrong report must not create a fact');
          const trace = (await fs.readFile(path.join(paths.shared.globalMemory, 'verification.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
          assert.equal(trace.length, 1); assert.equal(trace[0].verdict, 'wrong'); assert.equal(trace[0].fact_id, null);
          assert.equal(trace[0].evidence, WRONG_REPORT.repair_hints);
          assert.deepEqual(trace[0].verification_report, WRONG_REPORT.verification_report);
          rejectionObserved = true;
          const repaired = good(await tool('fact_submit', CORRECTED_CANDIDATE, ctx));
          assert.equal(repaired.pending, true); assert.equal(repaired.accepted, false);
          assert.equal(calls.python.filter((call) => call.request.operation === 'fact_submit').length, 1);
          assert.deepEqual(await fs.readdir(path.join(paths.shared.factGraph, 'facts')), []);
          finalText = JSON.stringify(repaired);
        } else {
          assert.match(prompt, /"accepted":true/);
          finalText = JSON.stringify({ noNewCandidate: true });
        }
      }
    } else {
      assert.equal(session.agentId, 'saved-verifier'); verifierRounds++;
      for (const sentinel of [...Object.values(RESEARCH_INPUT), CANDIDATE.intuition]) assert.ok(!prompt.includes(sentinel));
      for (const file of ['PROBLEM.md', 'OPERATOR.md', 'TASK.md']) await assert.rejects(fs.lstat(path.join(session.cwd, file)), { code: 'ENOENT' });
      const verifierPaths = JSON.parse(await fs.readFile(path.join(session.cwd, 'PATHS.json'), 'utf8'));
      assert.deepEqual(Object.keys(verifierPaths.shared), ['factGraph']); assert.equal(verifierPaths.localMemory, null);
      assert.ok(Object.keys(verifierPaths.aliases).every(key => key.endsWith('fact_graph/')));
      assert.ok(verifierPaths.shared.factGraph.endsWith('/shared/fact_graph'));
      const index = await fs.readFile(path.join(session.cwd, 'research-workspace.json'), 'utf8');
      const references = JSON.parse(index).files.filter(file => file.kind !== 'dynamic');
      const allowed = ['agents/contracts/verifier.md', 'danus/core/glossary_global.json', 'LICENSE',
        ...['check-referenced-statements', 'synthesize-verification-report', 'verify-sequential-statements']
          .flatMap(skill => ['SKILL.md', 'agents/openai.yaml'].map(leaf => `agents/skills/verify/${skill}/${leaf}`))];
      assert.deepEqual(references.map(file => file.path).sort(), allowed.sort());
      for (const file of references) assert.deepEqual(await fs.readFile(path.join(session.cwd, file.path)), await fs.readFile(path.join(packageRoot, file.source)));
      for (const excluded of ['AGENTS.md', '.agents/skills', 'agents/contracts/main_agent.md', 'agents/contracts/worker.md', 'agents/skills/worker', 'references/danus/.agents/skills/write-paper'])
        await assert.rejects(fs.lstat(path.join(session.cwd, excluded)), { code: 'ENOENT' });
      for (const sentinel of Object.values(RESEARCH_INPUT)) assert.ok(!index.includes(sentinel));
      for (const file of ['PROBLEM.md', 'OPERATOR.md', 'TASK.md']) assert.ok(!index.includes(path.join(session.cwd, file)));
      const candidate = chain && verifierRounds === 2 ? chainCandidate : repair && verifierRounds === 2 ? CORRECTED_CANDIDATE : CANDIDATE;
      const report = repair && verifierRounds === 1 ? WRONG_REPORT : FIXTURE_REPORT;
      assert.equal(await fs.readFile(path.join(session.cwd, 'STATEMENT.md'), 'utf8'), candidate.statement);
      assert.equal(await fs.readFile(path.join(session.cwd, 'PROOF.md'), 'utf8'), candidate.proof);
      const receipt = good(await tool('math_verification_report', report, ctx));
      assert.equal(receipt.written, true);
      const results = path.join(session.cwd, 'results');
      const submissionDirs = await fs.readdir(results); assert.equal(submissionDirs.length, 1);
      const reportFile = path.join(results, submissionDirs[0], 'verification.json');
      assert.deepEqual(JSON.parse(await fs.readFile(reportFile, 'utf8')), report);
      reported.push({ reportFile, report: clone(report) });
      // Both objects remain independently valid reports. Their disagreement must
      // be rejected by the real orchestration comparison, not schema validation.
      finalText = JSON.stringify(mismatch
        ? { ...report, verification_report: { ...report.verification_report, summary: 'different opaque final JSON summary' } }
        : report);
    }
    session.streaming = false;
    const stopReason = confirmedModelErrors && session.agentId === 'saved-worker' ? 'error' : 'stop';
    await emit(session, { type: 'message_end', message: { role: 'assistant', content: finalText, stopReason } });
    await emit(session, { type: 'agent_end', messages: [{ role: 'assistant', content: finalText, stopReason }] });
    await emit(session, { type: 'turn_end', aborted: false });
  }
  const sdk = { dataDir,
    tools: {
      async register(definition) { assert.equal(tools.has(definition.name), false); tools.set(definition.name, definition); return () => tools.delete(definition.name); },
      async list(input) {
        assert.deepEqual(input, { scope: 'own' }); return [...tools.values()].map((definition) => ({ name: definition.name,
        description: definition.description, parameters: definition.parameters, source: { kind: 'app', appId: 'hana-math' }, availability: { registered: true } })); },
    },
    models: { async listAvailable() { return { models: clone(models) }; } },
    agents: {
      async list(input) { assert.deepEqual(input, { lifecycle: 'all' }); return { agents: clone(agents) }; },
      async config({ agentId }) {
        assert.equal(scope.getStore()?.kind, 'app'); calls.profile.push(agentId);
        const roleIndex = agents.findIndex((agent) => agent.id === agentId); assert.ok(roleIndex >= 0);
        return { config: { tool_call_mode: 'full', agent: { name: agentId }, models: { chat: clone(models[roleIndex]) } } };
      },
      async createFromRole() { calls.writes.push('clone'); assert.fail('must not clone saved roles'); },
      async updateConfig() { calls.writes.push('config'); assert.fail('must not update saved role configuration'); },
    },
    storage: { global: {
      async get(key, fallback) { const role = roles.find((role) => key === `profile.role.${role}`); return role ? { agentId: `saved-${role}` } : fallback; },
      async set() { calls.writes.push('storage'); assert.fail('saved role bindings must remain read-only'); },
    } },
    sessions: {
      async create(input) {
        assert.equal(scope.getStore()?.kind, 'app'); assert.equal(input.memoryEnabled, false); assert.equal(input.namespace, 'app');
        const role = roles.find((role) => input.agentId === `saved-${role}`); assert.ok(role);
        assert.deepEqual(input.model, models[roles.indexOf(role)]);
        const sessionId = `fixture-session-${hostSessions.size + 1}`, sessionPath = `/fixture-only/${sessionId}.jsonl`;
        const session = { sessionId, path: sessionPath, namespace: 'app', ownerPluginId: 'hana-math', visibility: 'plugin_private',
          lifecycle: 'active', archivedAt: null, agentId: input.agentId, cwd: input.cwd, kind: input.kind, streaming: false };
        hostSessions.set(sessionId, session); calls.create.push(clone(input));
        return { ok: true, ...session, sessionPath, sessionRef: { sessionId, sessionPath }, modelProvider: input.model.provider,
          modelId: input.model.id, workspaceFolders: [], authorizedFolders: [], thinkingLevel: null, permissionMode: null };
      },
      async setActiveTools({ sessionId, toolNames }) {
        // This fixture's getAllTools exposes local business names; target membership is still mandatory.
        assert.ok(hostSessions.has(sessionId)); const available = new Set(['read', 'web_search', 'web_fetch', ...tools.keys()]);
        assert.equal(new Set(toolNames).size, toolNames.length); assert.ok(toolNames.every(name => available.has(name)));
        hostSessions.get(sessionId).toolNames = [...toolNames];
        return { sessionId, toolNames: [...toolNames], effective: 'current', pendingToolNames: null };
      },
      async getToolSelection({ sessionId }) { return { sessionId, toolNames: [...hostSessions.get(sessionId).toolNames], effective: 'current', pendingToolNames: null }; },
      async get({ sessionId, sessionPath }) {
        const session = sessionId ? hostSessions.get(sessionId) : [...hostSessions.values()].find((session) => session.path === sessionPath);
        if (!session) return { session: null };
        const { kind, lifecycle, ...value } = clone(session);
        return { session: { ...value, sessionKind: kind } };
      },
      async list(input) {
        return { sessions: [...hostSessions.values()].filter((s) => !input?.agentId || s.agentId === input.agentId).map((s) => {
          const { namespace, ...value } = clone(s); return value;
        }) };
      },
      async context({ sessionId }) { const session = hostSessions.get(sessionId); return { sessionId, isStreaming: session.streaming,
        isCompacting: false, pendingMessageCount: 0, systemPrompt: 'opaque software fixture context', model: {} }; },
      async abort({ sessionId }) { calls.aborts.push(sessionId); abortObserved.resolve(); const session = hostSessions.get(sessionId); session.streaming = false;
        return { ok: true, aborted: true, sessionId, sessionRef: { sessionId, sessionPath: session.path } }; },
      async send({ sessionId, text }) {
        const session = hostSessions.get(sessionId); session.streaming = true; calls.send.push({ sessionId, text });
        const resuming = session.agentId === 'saved-worker' && calls.send.filter(call => call.sessionId === sessionId).length > 1;
        if (resuming && sendFailure) throw Object.assign(new Error('opaque resume transport failure'), { code: 'APP_HOST_ERROR' });
        if (resuming && lateStop) {
          resumeEntered.resolve(); await releaseSend.promise; session.streaming = true;
          return { accepted: true, sessionId, sessionPath: session.path, sessionRef: { sessionId, sessionPath: session.path } };
        }
        // A macrotask runs AFTER the accepted send receipt's microtasks. Never
        // emit model events synchronously from send or fabricate a round result.
        const job = new Promise((resolve) => setImmediate(resolve)).then(() => scriptedTurn(session, text)).catch(async (error) => {
          scriptErrors.push(error); session.streaming = false;
          await emit(session, { type: 'agent_end', messages: [{ role: 'assistant', content: error.message, stopReason: 'error' }] });
        });
        scriptJobs.push(job);
        return { accepted: true, sessionId, sessionPath: session.path, sessionRef: { sessionId, sessionPath: session.path } };
      },
    },
    bus: { async subscribe(callback, filter) { const item = { callback, filter }; subscriptions.add(item); return () => subscriptions.delete(item); } },
    tasks: {
      async registerHandler(key, handler) { handlers.set(key, handler); return () => handlers.delete(key); },
      async create(input) {
        const core = input.scope === 'app';
        if (core) { assert.equal(input.delivery, 'none'); assert.equal(input.callToken, undefined); assert.equal(input.handlerKey, undefined); assert.equal(input.metadata.researchTaskKind, 'core-execution'); }
        else { assert.equal(input.scope, 'session'); assert.equal(input.callToken, origin.callToken); }
        const task = { taskId: core ? 'fixture-core-task' : 'fixture-root-task', pluginId: 'hana-math', scope: input.scope, delivery: input.delivery,
          handlerKey: input.handlerKey ?? null, metadata: input.metadata, parentSessionId: core ? null : 'fixture-origin', parentSessionPath: core ? null : origin.sessionPath, status: 'pending' };
        tasks.set(task.taskId, task); calls.tasks.push(clone(input)); return clone(task);
      },
      async schedule(input) { assert.equal(input.scope, 'app'); assert.equal(input.callToken, undefined);
        const schedule = { ...clone(input), scheduleId: 'fixture-schedule', pluginId: 'hana-math' }; schedules.set(schedule.scheduleId, schedule); return clone(schedule); },
      async get(id) { return clone(tasks.get(id)); }, async list() { return clone([...tasks.values()]); },
      async listSchedules() { return clone([...schedules.values()]); }, async unschedule(id) { schedules.delete(id); return { ok: true }; },
      async complete(id, result) { const task = tasks.get(id); Object.assign(task, { status: 'completed', result }); if (task.scope === 'session') ended.resolve(clone(task)); return clone(task); },
      async fail(id, error) { const task = tasks.get(id); Object.assign(task, { status: 'failed', error }); if (task.scope === 'session') ended.resolve(clone(task)); return clone(task); },
      async getDelivery() { return { state: 'staged', delivered: false }; },
    },
    runtime: {
      async start(input) {
        assert.equal(input.command, path.join(packageRoot, 'dependencies/python/bin/python3'));
        assert.deepEqual(input.args.slice(0, 4), ['-I', '-S', '-B', path.join(packageRoot, 'runtime/research_entry.py')]);
        assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none'); // Requested contract only, NOT an OS sandbox claim.
        // Model the SDK auto-token branch and Host task-scope resolution, not an
        // actual Host authorization/sandbox claim. A taskId suppresses injection.
        const wire = { ...input };
        if (!wire.taskId && !wire.callToken && scope.getStore()?.context?.callToken) wire.callToken = scope.getStore().context.callToken;
        assert.equal(input.readRoots, undefined); assert.equal(input.writeRoots, undefined); assert.equal(input.scope, undefined);
        if (wire.taskId) {
          const task = tasks.get(wire.taskId);
          assert.equal(task.taskId, 'fixture-core-task'); assert.equal(task.scope, 'app'); assert.equal(task.parentSessionId, null);
          assert.equal(wire.callToken, undefined); assert.ok(!['completed', 'failed', 'aborted', 'canceled'].includes(task.status));
        } else assert.equal(wire.callToken, origin.callToken); // Historical result uses the invoking owner's scope.
        const request = JSON.parse(await fs.readFile(input.args[4], 'utf8'));
        assert.deepEqual(Object.keys(request.context).sort(), ['author', 'projectId', 'role', 'runId',
          ...(projectWorker && request.context.role === 'worker' ? ['workerId'] : [])]);
        assert.equal(request.context.workerId, projectWorker && request.context.role === 'worker' ? 'worker-native' : undefined);
        assert.match(request.requestId, /^[a-f0-9-]{36}$/);
        assert.equal(input.cwd, path.join(dataDir, 'research/core-calls', request.requestId));
        assert.equal(input.args[4], path.join(input.cwd, 'request.json')); assert.equal(input.args[5], path.join(input.cwd, 'result.json'));
        if (unknownWrite && request.operation === 'fact_submit') {
          calls.failedWrites++; throw Object.assign(new Error('opaque unknown start outcome'), { code: 'APP_HOST_ERROR' });
        }
        await executeFile('python3.12', input.args, { cwd: input.cwd, timeout: 15000, maxBuffer: 2 << 20 });
        const envelope = JSON.parse(await fs.readFile(input.args[5], 'utf8'));
        assert.equal(envelope.requestId, request.requestId); assert.equal(envelope.schemaVersion, 1);
        const meta = JSON.parse(await fs.readFile(path.join(dataDir, 'research/runs', request.context.runId, 'run.json'), 'utf8'));
        calls.python.push({ request, envelope, mathematicalRound: meta.round, taskId: wire.taskId ?? null, scopedSessionId: wire.taskId ? null : 'fixture-origin' });
        const info = { runtimeId: randomUUID(), state: 'exited', exitCode: 0, signal: null, runtime: 'command', profile: 'scoped', network: 'none' };
        runtimeStates.set(info.runtimeId, info); return clone(info);
      },
      async get(id) { return clone(runtimeStates.get(id)); },
      async watch() { assert.fail('fixture Python exits before runtime start receipt'); },
      async stop(id) { return clone(runtimeStates.get(id)); },
    },
    resources: { async stage(input) {
      const ctx = scope.getStore()?.context; assert.equal(ctx?.sessionPath, origin.sessionPath);
      assert.equal(input.mime, 'text/markdown'); assert.equal(input.deliverAs, 'attachment');
      const source = await fs.readFile(input.path), fileId = `fixture-file-${calls.stage.length + 1}`;
      const destination = path.join(base, 'staged', fileId); await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(input.path, destination);
      const copied = await fs.readFile(destination); assert.deepEqual(copied, source);
      calls.stage.push({ input, destination, fileId, sha256: sha(source), bytes: source.length });
      return { file: { id: fileId, size: source.length, sha256: sha(source) }, mediaItem: null,
        resource: { kind: 'session-file', fileId, sessionId: 'fixture-origin' } };
    } },
  };
  const contexts = createContextService(sdk, { packageRoot });
  const profiles = createProfileService(sdk);
  async function openService() {
    service = await createResearchService(sdk, { contexts, profiles, sessions: createResearchSessions(sdk),
      createCore: (options = {}) => createResearchRuntime(sdk, { packageRoot, platform: 'darwin', arch: 'arm64', timeoutMs: 20000, ...(options.taskId === undefined ? {} : { taskId: options.taskId }) }),
      literature: { async search() { assert.fail('no network or literature retrieval in this fixture'); } },
    });
    registration = await registerMathResearch(sdk, service);
  }
  await openService();
  const external = await tool('fact_submit', CANDIDATE);
  assert.equal(external.isError, true); assert.equal(external.details.error.code, 'CALLER_UNBOUND');
  let queued;
  if (projectWorker) {
    const projectId = 'project-native-fixture', workerId = 'worker-native';
    await contexts.prepare({ projectId, ...RESEARCH_INPUT });
    await contexts.prepareProjectWorkspace({ projectId, role: 'worker', workerId });
    await contexts.assignWorkerTask({ projectId, workerId, task: 'opaque software fixture task; no mathematics or model inference' });
    queued = await scope.run({ kind: 'model-tool', context: origin }, () => service.startWorkerRun({ projectId, workerId, timeoutSeconds: 60,
      ...(configured ? { workerPolicy: { maxRounds: 4, roundDelaySeconds: 0, ...((confirmedFailures || confirmedModelErrors) ? { maxConsecutiveFailures: 2 } : {}) } } : {}) }, origin));
  } else queued = good(await tool('math_research', { action: 'run', ...RESEARCH_INPUT, timeoutSeconds: 60 }));
  assert.equal(queued.state, 'queued'); assert.equal(calls.create.length, 0);
  const schedule = [...schedules.values()][0];
  const launch = await scope.run({ kind: 'app' }, () => handlers.get(schedule.handlerKey).run({ kind: 'schedule', scheduleId: schedule.scheduleId, input: clone(schedule.payload) }));
  assert.equal(launch.status, 'started');
  if (lateStop) {
    await deadline(resumeEntered.promise);
    const stopping = service.stopProjectWorker('project-native-fixture', queued.runId);
    await deadline(abortObserved.promise); releaseSend.resolve(); await deadline(stopping);
  }
  const completion = await deadline(ended.promise);
  await Promise.all(scriptJobs);
  assert.deepEqual(scriptErrors.map((error) => error.stack), [], 'scripted host tool calls must all succeed');
  const statusReply = await tool('math_research', { action: 'status', runId: queued.runId });
  if (confirmedFailures || confirmedModelErrors) {
    const status = good(statusReply);
    assert.equal(completion.status, 'failed'); assert.equal(status.state, 'failed');
    assert.equal(status.error.code, 'CONSECUTIVE_ROUND_FAILURES'); assert.equal(status.round, 2);
    assert.equal(status.consecutiveFailures, 2); assert.equal(status.cleanupPending, false);
    assert.equal(calls.create.length, 2); assert.equal(calls.python.length, 0); assert.equal(subscriptions.size, 0);
    assert.equal(status.lastRoundOutcome.code, 1);
    assert.equal(status.lastRoundOutcome.error.code, confirmedModelErrors ? 'MODEL_TURN_FAILED' : 'CONFIRMED_MODEL_ROUND_FAILURE');
    assert.ok(status.sessions.every(session => calls.aborts.includes(session.sessionId)));
    assert.ok(status.sessions.every(session => confirmedModelErrors
      ? session.error === 'MODEL_TURN_FAILED' && session.modelStopReason === 'error'
      : session.error === 'FINAL_ASSISTANT_MISSING' && session.modelStopReason === 'stop'));
    return;
  }
  if (lateStop || sendFailure || unknownWrite) {
    assert.equal(completion.status, 'failed'); const status = good(statusReply);
    assert.equal(status.state, lateStop ? 'stopped' : 'failed');
    assert.equal(calls.python.filter(call => call.request.operation === 'prepare_submission').length, 1);
    assert.equal(calls.python.filter(call => call.request.operation === 'fact_submit').length, unknownWrite ? 0 : 1);
    assert.equal(status.verifiedFactIds.length, unknownWrite ? 0 : 1);
    assert.equal([...hostSessions.values()].filter(session => session.agentId === 'saved-worker').length, 1);
    assert.equal(reported.length, 1);
    if (unknownWrite) {
      assert.equal(calls.failedWrites, 1); assert.equal(status.indeterminate, true); assert.equal(status.runtimeCleanupPending, true);
      const meta = JSON.parse(await fs.readFile(path.join(dataDir, 'research/runs', queued.runId, 'run.json'), 'utf8'));
      assert.equal(meta.pendingMutations.length, 1);
    } else {
      const worker = [...hostSessions.values()].find(session => session.agentId === 'saved-worker');
      assert.equal(calls.send.filter(call => call.sessionId === worker.sessionId).length, 2);
      if (lateStop) assert.ok(calls.aborts.filter(id => id === worker.sessionId).length >= 2, 'late accepted send must be aborted again');
      assert.equal(calls.python.find(call => call.request.operation === 'fact_submit').envelope.result.accepted, true);
    }
    if (reopenAfterFailure) {
      const [parent] = status.verifiedFactIds;
      const accepted = calls.python.find(call => call.request.operation === 'fact_submit');
      assert.equal(accepted.mathematicalRound, 1); assert.equal(accepted.envelope.result.fact_id, parent);
      const parentFile = path.join(dataDir, 'context/projects', status.projectId, 'shared/fact_graph/facts', `${parent}.md`);
      const canonicalBefore = await fs.readFile(parentFile);
      await registration.dispose();
      const closed = await service.dispose();
      assert.equal(closed.cleanupPending, false);
      const endedRun = closed.runs.find(run => run.runId === queued.runId);
      assert.equal(endedRun.state, 'failed'); assert.equal(endedRun.cleanupPending, false);
      assert.equal(endedRun.runtimeCleanupPending, false); assert.equal(endedRun.indeterminate, false);
      assert.equal(endedRun.coordinatorActive, false);
      const runFile = path.join(dataDir, 'research/runs', queued.runId, 'run.json');
      const runBefore = await fs.readFile(runFile);
      const counts = { create: calls.create.length, send: calls.send.length, tasks: calls.tasks.length, python: calls.python.length };
      const previous = service;
      await openService(); assert.notStrictEqual(service, previous); // Same dataDir, fresh controller/helper/bindings.
      const restored = good(await tool('math_research', { action: 'status', runId: queued.runId }));
      assert.equal(restored.state, 'failed'); assert.equal(restored.cleanupPending, false);
      assert.deepEqual(restored.verifiedFactIds, [parent]);
      const listed = good(await tool('math_research', { action: 'result', runId: queued.runId }));
      assert.deepEqual(listed.facts.map(({ fact_id, predecessors }) => ({ fact_id, predecessors })), [{ fact_id: parent, predecessors: [] }]);
      assert.equal(listed.page.allFactsIncluded, true); assert.equal(listed.page.previewOnly, true);
      assert.equal(listed.facts[0].canonicalBytes, canonicalBefore.length);
      const delivered = good(await tool('math_research', { action: 'result', runId: queued.runId, factId: parent }));
      assert.equal(delivered.fact_id, parent); assert.equal(delivered.fullTextInFile, true);
      assert.deepEqual(delivered.fact.predecessors, []);
      assert.equal(calls.stage.length, 1);
      assert.deepEqual(await fs.readFile(calls.stage[0].destination), canonicalBefore);
      assert.equal(delivered.sha256, sha(canonicalBefore));
      // Real Core fact_list_page/fact_get reject revoked facts; these are reads only.
      const reads = calls.python.slice(counts.python);
      assert.deepEqual(reads.map(call => call.request.operation), ['fact_list_page', 'fact_get']);
      assert.ok(reads.every(call => call.envelope.ok && call.request.context.role === 'main'
        && call.request.context.projectId === status.projectId && !Object.hasOwn(call.request, 'verification')));
      assert.equal(calls.create.length, counts.create); assert.equal(calls.send.length, counts.send);
      assert.equal(calls.tasks.length, counts.tasks); assert.equal(schedules.size, 0);
      assert.equal(calls.python.filter(call => call.request.operation === 'prepare_submission').length, 1);
      assert.equal(calls.python.filter(call => call.request.operation === 'fact_submit').length, 1);
      assert.deepEqual(await fs.readFile(parentFile), canonicalBefore);
      // result records its read/cleanup diagnostic; no other run state may change.
      assert.deepEqual(JSON.parse(await fs.readFile(runFile, 'utf8')),
        { ...JSON.parse(runBefore.toString('utf8')), lastResultError: null });
    }
    assert.deepEqual(calls.writes, []); return;
  }
  if (mismatch) {
    assert.equal(completion.status, 'failed', JSON.stringify(completion));
    assert.equal(statusReply.isError, false); // Query succeeded; the recorded research run failed.
    const status = statusReply.details;
    assert.equal(status.state, 'failed'); assert.equal(status.error.code, 'VERIFICATION_REPORT_MISMATCH');
    assert.equal(status.indeterminate, false); assert.deepEqual(status.verifiedFactIds, []);
    assert.equal(reported.length, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(reported[0].reportFile, 'utf8')), FIXTURE_REPORT);
    assert.equal(calls.python.filter((call) => call.request.operation === 'prepare_submission').length, 1);
    assert.equal(calls.python.filter((call) => call.request.operation === 'fact_submit').length, 0);
    const shared = path.join(dataDir, 'context/projects', status.projectId, 'shared');
    assert.deepEqual(await fs.readdir(path.join(shared, 'fact_graph/facts')), []);
    await assert.rejects(fs.stat(path.join(shared, 'global_memory/verification.jsonl')), { code: 'ENOENT' });
    const listed = good(await tool('math_research', { action: 'result', runId: queued.runId }));
    assert.deepEqual(listed.facts, []); assert.equal(calls.stage.length, 0);
    assert.equal(calls.create.length, projectWorker ? 2 : 3); assert.equal(subscriptions.size, 0);
    assert.deepEqual(calls.writes, []);
    return;
  }
  assert.equal(completion.status, 'completed', JSON.stringify(completion));
  const status = good(statusReply);
  assert.equal(status.state, 'finished', JSON.stringify(status)); assert.equal(status.theoremEstablished, false);
  assert.equal(status.verifiedFactIds.length, chain ? 2 : 1); assert.ok(pendingReceipt);
  const fid = status.verifiedFactIds.at(-1);
  const preparations = calls.python.filter((call) => call.request.operation === 'prepare_submission');
  const submissions = calls.python.filter((call) => call.request.operation === 'fact_submit');
  assert.equal(preparations.length, repair || chain ? 2 : 1);
  assert.equal(submissions.length, preparations.length);
  for (const [index, submission] of submissions.entries()) {
    assert.equal(submission.request.verification.candidateDigest, preparations[index].envelope.result.candidateDigest);
    assert.deepEqual(submission.request.verification.predecessorDigests, preparations[index].envelope.result.predecessorDigests);
    assert.deepEqual(submission.request.arguments, preparations[index].request.arguments);
  }
  const prepared = preparations.at(-1), submitted = submissions.at(-1);
  assert.ok(prepared && submitted);
  assert.equal(prepared.envelope.result.precheck.passed, true);
  assert.equal(submitted.request.verification.candidateDigest, prepared.envelope.result.candidateDigest);
  assert.deepEqual(submitted.request.verification.predecessorDigests, prepared.envelope.result.predecessorDigests);
  assert.deepEqual(submitted.request.verification.report, FIXTURE_REPORT);
  assert.equal(submitted.envelope.result.fact_id, fid);
  const listed = good(await tool('math_research', { action: 'result', runId: queued.runId }));
  const expectedFacts = chain ? [{ fact_id: status.verifiedFactIds[0], predecessors: [] }, { fact_id: fid, predecessors: [status.verifiedFactIds[0]] }] : [{ fact_id: fid, predecessors: [] }];
  assert.deepEqual(listed.facts.map(({ fact_id, predecessors }) => ({ fact_id, predecessors })).sort((a, b) => a.fact_id.localeCompare(b.fact_id)), expectedFacts.sort((a, b) => a.fact_id.localeCompare(b.fact_id)));
  assert.equal(listed.page.allFactsIncluded, true); assert.equal(listed.page.returned, listed.facts.length);
  for (const row of listed.facts) { assert.equal(Object.hasOwn(row, 'markdown'), false); assert.ok(Buffer.byteLength(row.statementPreview) <= 512); }
  const delivered = good(await tool('math_research', { action: 'result', runId: queued.runId, factId: fid }));
  assert.equal(delivered.fullTextInFile, true); assert.equal(delivered.fact_id, fid);
  assert.equal(delivered.fact.markdown, undefined, 'large Markdown must remain complete in attachment, not inline truncation');
  assert.equal(calls.stage.length, 1); const staged = calls.stage[0];
  assert.equal(delivered.fileId, staged.fileId); assert.equal(delivered.sha256, staged.sha256); assert.equal(delivered.bytes, staged.bytes);
  const canonical = await fs.readFile(path.join(dataDir, 'context/projects', status.projectId, 'shared/fact_graph/facts', `${fid}.md`));
  assert.deepEqual(await fs.readFile(staged.destination), canonical);
  assert.equal(sha(canonical), delivered.sha256); assert.ok(canonical.toString().includes(CANDIDATE.intuition));
  if (repair) {
    assert.equal(rejectionObserved, true);
    assert.notEqual(preparations[0].envelope.result.candidateDigest, prepared.envelope.result.candidateDigest);
    assert.deepEqual(submissions[0].request.verification.report, WRONG_REPORT);
    assert.equal(submitted.request.arguments.proof, CORRECTED_CANDIDATE.proof);
    assert.ok(canonical.toString().includes(CORRECTED_CANDIDATE.proof));
    const trace = (await fs.readFile(path.join(dataDir, 'context/projects', status.projectId,
      'shared/global_memory/verification.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(trace.map((entry) => entry.verdict), ['wrong', 'correct']);
    assert.equal(trace[0].fact_id, null); assert.equal(trace[1].fact_id, fid);
    assert.equal(reported.length, 2);
  }
  const workers = [...hostSessions.values()].filter((session) => session.agentId === 'saved-worker');
  assert.equal(workers.length, configured ? 4 : 3);
  if (configured) {
    assert.equal(status.round, 4); assert.equal(status.executionPolicy.totalTimeoutSeconds, 60);
    assert.equal(status.executionPolicy.workerPolicy.roundTimeoutSeconds, 14400);
    assert.equal(status.executionBridge, 'configured-mathematical-rounds-same-session-feedback');
  }
  assert.equal(new Set(workers.map((worker) => worker.sessionId)).size, workers.length);
  assert.equal(new Set(workers.map((worker) => worker.cwd)).size, 1);
  assert.equal((await fs.readFile(path.join(workers[0].cwd, 'local_memory/notes.jsonl'), 'utf8')).trim().split('\n').length, 1);
  assert.equal((await fs.readFile(path.join(workers[0].cwd, 'local_memory/events.jsonl'), 'utf8')).trim().split('\n').length, 1);
  assert.deepEqual(calls.profile, projectWorker ? ['saved-worker', 'saved-verifier', 'saved-worker', 'saved-verifier']
    : ['saved-main', 'saved-worker', 'saved-verifier', 'saved-main', 'saved-worker', 'saved-verifier']); assert.deepEqual(calls.writes, []);
  if (projectWorker) {
    assert.equal(status.mode, 'project-worker'); assert.equal(status.summaryFile, null);
    assert.deepEqual(Object.keys(status.selections).sort(), ['verifier', 'worker']);
    assert.ok([...hostSessions.values()].every(session => session.agentId !== 'saved-main'));
    for (const call of calls.python) assert.equal(call.request.context.workerId, call.request.context.role === 'worker' ? 'worker-native' : undefined);
    assert.equal(workers[0].cwd, path.join(dataDir, 'context/projects/project-native-fixture/workers/worker-native'));
  }
  if (scenario.startsWith('controlled-')) {
    assert.deepEqual(preparations.map(call => call.mathematicalRound), [1, 1]);
    assert.deepEqual(submissions.map(call => call.mathematicalRound), [1, 1]);
    const meta = JSON.parse(await fs.readFile(path.join(dataDir, 'research/runs', queued.runId, 'run.json'), 'utf8'));
    assert.equal(new Set(meta.submissions.map(sub => sub.workerSessionId)).size, 1);
    assert.notEqual(meta.submissions[0].submissionId, meta.submissions[1].submissionId);
    assert.notEqual(submissions[0].request.verification.verifierSessionId, submissions[1].request.verification.verifierSessionId);
    assert.equal(calls.send.filter(call => call.sessionId === workers[0].sessionId).length, 3);
    if (chain) {
      const parent = status.verifiedFactIds[0];
      const bytes = await fs.readFile(path.join(dataDir, 'context/projects', status.projectId, 'shared/fact_graph/facts', `${parent}.md`));
      assert.deepEqual(prepared.envelope.result.predecessorDigests, { [parent]: sha(bytes) });
      assert.deepEqual(submitted.request.arguments.predecessors, [parent]);
    }
  }
  assert.equal(calls.create.length, (projectWorker ? repair || chain ? 5 : 4 : repair ? 7 : 6) + (configured ? 1 : 0)); assert.equal(subscriptions.size, 0);
  if (scenario === 'positive') {
    // Extend only this isolated software graph; no additional model/candidate work.
    const graph = path.join(dataDir, 'context/projects', status.projectId, 'shared/fact_graph/facts');
    const createdBefore = calls.create.length, sentBefore = calls.send.length;
    const opaqueIds = Array.from({ length: 80 }, (_, i) => 'f0' + i.toString(16).padStart(14, '0'));
    for (const id of opaqueIds) await fs.writeFile(path.join(graph, `${id}.md`), `---\nfact_id: ${id}\npredecessors: []\n---\n## statement\nopaque transport fixture\n## proof\n${'x'.repeat(18000)}\n`);
    const expected = [...opaqueIds, fid].sort(), found = []; let options = { limit: 13 }, firstPage;
    for (;;) {
      const value = good(await tool('math_research', { action: 'result', runId: queued.runId, ...options }));
      firstPage ??= value.page; assert.equal(value.page.asOf, firstPage.asOf); assert.equal(value.page.startIndex, found.length);
      assert.ok(Buffer.byteLength(JSON.stringify({ facts: value.facts, page: value.page })) <= 16384);
      assert.equal(value.page.allFactsIncluded, false); found.push(...value.facts.map(row => row.fact_id));
      if (!value.page.hasMore) break; options = { cursor: value.page.nextCursor };
    }
    assert.deepEqual(found, expected);
    const exported = good(await tool('math_research', { action: 'result', runId: queued.runId, factId: opaqueIds[0] }));
    assert.equal(exported.fullTextInFile, true); assert.deepEqual(await fs.readFile(calls.stage.at(-1).destination), await fs.readFile(path.join(graph, `${opaqueIds[0]}.md`)));
    await fs.appendFile(path.join(graph, `${opaqueIds[0]}.md`), '\n## intuition\nopaque metadata change');
    const drift = await tool('math_research', { action: 'result', runId: queued.runId, cursor: firstPage.nextCursor });
    assert.equal(drift.isError, true); assert.equal(drift.details.facts, undefined);
    assert.equal(calls.python.at(-1).envelope.error.code, 'fact_page_changed');
    assert.equal(calls.create.length, createdBefore); assert.equal(calls.send.length, sentBefore);
  }
}

for (const [scenario, label] of [
  ['positive', 'registered tools -> real service/session/context/Python -> canonical fact and complete staged Markdown'],
  ['project-worker', 'project worker bridge -> real context/session/Core with logical memory and no private main'],
  ['repair', 'wrong fixture report writes only a trace; new worker repairs opaque proof with retained notes and exact hints'],
  ['controlled-repair', 'real controlled helper and Core reject then accept revised opaque payload in one worker SID/mathematical round'],
  ['controlled-chain', 'real controlled helper and Core accept opaque L then C with canonical predecessor digest in the same round'],
  ['controlled-configured-model-failures', 'configured real helper counts only confirmed empty normal model endings and stops at the failure threshold'],
  ['controlled-configured-model-errors', 'configured real helper counts confirmed MODEL_TURN_FAILED errors and stops at the failure threshold'],
  ['controlled-configured-chain', 'configured four-round real helper/Core preserves accepted opaque L/C and same-round cold verification'],
  ['controlled-configured-unknown-write', 'configured real helper/Core unknown write forbids another mathematical round'],
  ['controlled-mismatch', 'controlled bad verifier report never resumes or submits to real Core'],
  ['controlled-resume-failure', 'real helper resume failure retains accepted fact without replay'],
  ['controlled-resume-failure-reopen', 'accepted opaque predecessor survives resume failure and fresh service result reads without replay'],
  ['controlled-late-send-stop', 'real helper stop during resume aborts late accepted send without a new candidate'],
  ['controlled-unknown-write', 'unknown real runtime write start retains mutation and runtime uncertainty without resume'],
  ['mismatch', 'written verifier report and final JSON mismatch prevents Core submission and any fact'],
]) test(label, { timeout: 45000 }, (t) => integration(t, scenario));
