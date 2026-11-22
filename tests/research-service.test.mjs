// Software-only fixtures. Never start a model, network request, Python or managed process.
import test from 'node:test';
import { fixtureFactPage } from './fact-page-fixture.mjs';
import { upstreamKickoff } from '../packages/hana-math/upstream-kickoff.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { createAppSdk } from '../packages/hana-math/sdk/app-contract/server-client.js';
import { createResearchService, submissionProjection } from '../packages/hana-math/research-service.mjs';
import { createResearchBindings } from '../packages/hana-math/research-bindings.mjs';
import { runSettlementState } from '../packages/hana-math/worker-stop-reconciliation.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { AppSdkError } from '../packages/hana-math/sdk/app-contract/sdk-error.js';
import { runtimeFailureInfo, runtimeRejectionInfo } from '../packages/hana-math/runtime/research-runtime.mjs';
import { refusalFixture } from './rejection-fixture.mjs';
import { fixture as projectFixture, origin as projectOrigin } from './helpers/project-service-fixture.mjs';
import { createContextStore, createContextService } from '../packages/hana-math/context-service.mjs';
const origin = { callToken: 'origin-short-lived-secret', sessionPath: '/host/original.jsonl' };
const GOOD = { verification_report: { summary: 'Software fixture report, not a mathematical proof', critical_errors: [], gaps: [] }, verdict: 'correct', repair_hints: '' };
const BAD = { verification_report: { summary: 'Fixture rejection', critical_errors: [{ location: 'fixture', issue: 'fixture gap' }], gaps: [] }, verdict: 'wrong', repair_hints: 'Repair the fixture gap.' };
const candidate = { statement: 'software fixture statement', proof: 'software fixture proof', predecessors: [], glossary_introduces: {} };
const fid = 'a'.repeat(16);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));
async function assertFreshRunAllowed(f, problem = 'new independent project') {
  await tick();
  const originals = new Map();
  for (const id of await f.store.list('research/runs')) {
    try { await f.waitIdle(id); } catch (error) { if (error.code !== 'RUN_NOT_FOUND' && error.code !== 'OWNER_DENIED') throw error; }
    try { originals.set(id, await f.store.read(`research/runs/${id}/run.json`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; originals.set(id, null); }
  }
  const fresh = await f.service.run({ problem }, origin);
  assert.equal(fresh.state, 'queued'); assert.equal(originals.has(fresh.runId), false);
  await f.service.stop(fresh.runId, origin);
  for (const [id, bytes] of originals) {
    if (bytes === null) await assert.rejects(f.store.read(`research/runs/${id}/run.json`), { code: 'ENOENT' });
    else assert.deepEqual(await f.store.read(`research/runs/${id}/run.json`), bytes);
  }
  return fresh;
}
async function fixture(t, behavior = {}, existing) {
  const dataDir = existing || await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'research-service-')));
  const store = createContextStore(dataDir), scope = new AsyncLocalStorage();
  const calls = { bus: [], starts: [], resumes: [], cores: [], core: [], profiles: [], contexts: [], workspaces: [], schedule: [], unschedule: [], abort: [], taskCreate: [], literature: [], lifecycle: [] };
  const tasks = behavior.tasks || new Map(), schedules = behavior.schedules || new Map(), hostSessions = behavior.hostSessions || new Map(), graphs = new Map(), preparedProjects = new Set(['fixture-project']);
  const finished = deferred(), taskCreated = deferred(), coreTaskCreated = deferred(), sessionStarted = deferred(), preparing = deferred(), sessionCreating = deferred();
  const handlers = new Map(); let service, sessionSequence = 0, coreSequence = 0, stopped = false;
  const roleRounds = new Map();
  const agents = ['main', 'worker', 'verifier'].map((role) => ({ id: `saved-${role}`, state: 'active', deletedAt: null, ownerPluginId: 'hana-math', visibility: 'plugin_private', plugin: { ownerPluginId: 'hana-math', visibility: 'plugin_private', kind: 'role', roleId: role } }));
  let sdk = { dataDir,
    agents: { list: async () => ({ agents }) },
    models: { listAvailable: async () => {
      if (behavior.modelError) throw behavior.modelError;
      return Object.hasOwn(behavior, 'catalog') ? structuredClone(behavior.catalog)
        : { models: ['main', 'worker', 'verifier'].map((role) => ({ provider: 'saved-provider', id: `${role}-model` })) };
    } },
    sessions: {
      get: async ({ sessionPath, sessionId }) => {
        const session = sessionId ? hostSessions.get(sessionId) : [...hostSessions.values()].find((s) => s.path === sessionPath);
        if (!session) return { session: null };
        const { kind, lifecycle, ...value } = structuredClone(session);
        return { session: { ...value, sessionKind: kind, ...behavior.getProjectionPatch } };
      },
      context: async ({ sessionId }) => ({ sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0, systemPrompt: 'fixture context', model: {}, ...behavior.sessionContext }),
      list: async (input) => {
        if (behavior.recoveryListError && !input?.agentId) throw new Error('discovery unavailable');
        if (behavior.sessionInfoListError) throw new Error('identity list unavailable');
        const rows = [...hostSessions.values()].filter((s) => !input?.agentId || s.agentId === input.agentId).map((s) => {
          const { namespace, ...value } = structuredClone(s); return { ...value, ...behavior.listProjectionPatch };
        });
        return { sessions: behavior.duplicateSessionRows ? [...rows, ...structuredClone(rows)] : rows };
      },
      abort: async ({ sessionId }) => { calls.abort.push(sessionId); return { ok: true, aborted: !behavior.abortUnconfirmed, sessionId }; },
    },
    tasks: {
      registerHandler: async (key, handler) => {
        handlers.set(key, handler); const dispose = () => { handlers.delete(key); };
        return Object.assign(dispose, { ready: Promise.resolve(), disposeAsync: async () => dispose() });
      },
      create: async (input) => {
        calls.taskCreate.push(input);
        const core = input.scope === 'app';
        if (core) assert.deepEqual(Object.keys(input).sort(), ['delivery', 'label', 'metadata', 'scope']);
        const task = { taskId: `task-${tasks.size + 1}`, pluginId: 'hana-math', scope: input.scope, delivery: input.delivery,
          parentSessionId: core ? null : 'owner-stable-id', parentSessionPath: core ? null : origin.sessionPath, status: 'pending', metadata: input.metadata, handlerKey: input.handlerKey ?? null };
        tasks.set(task.taskId, task); (core ? coreTaskCreated : taskCreated).resolve(task);
        if (core && behavior.coreTaskGate) await behavior.coreTaskGate.promise;
        if (!core && behavior.taskGate) await behavior.taskGate.promise;
        if (core && behavior.coreTaskCreateError) throw behavior.coreTaskCreateError;
        return core ? { ...task, ...(typeof behavior.coreTaskCreateReceipt === 'function'
          ? behavior.coreTaskCreateReceipt(task) : behavior.coreTaskCreateReceipt) } : task;
      },
      get: async (id) => { const task = tasks.get(id); return task?.scope === 'app' ? { ...task, ...behavior.coreTaskGetReceipt } : task; },
      list: async () => { if (behavior.taskListError) throw new Error('task list failed'); const rows = [...tasks.values()]; return behavior.taskRows ? behavior.taskRows(rows) : rows; },
      schedule: async (input) => {
        calls.schedule.push(input); const schedule = { ...input, scheduleId: `schedule-${calls.schedule.length}`, pluginId: 'hana-math' }; schedules.set(schedule.scheduleId, schedule);
        if (behavior.autoDispatch) await scope.run('app', () => handlers.get(input.handlerKey).run({ kind: 'schedule', scheduleId: schedule.scheduleId, input: input.payload }));
        if (behavior.scheduleGate) await behavior.scheduleGate.promise;
        return schedule;
      },
      listSchedules: async () => { if (behavior.scheduleListError) throw new Error('schedule list failed'); return [...schedules.values()]; },
      unschedule: async (id) => { calls.unschedule.push(id); if (behavior.unscheduleError) throw new Error('unschedule failed'); schedules.delete(id); return { ok: true }; },
      complete: async (id, result) => { calls.lifecycle.push(`complete:${id}`); const task = tasks.get(id); task.status = 'completed'; task.result = result;
        if (task.scope === 'session') finished.resolve(); return { ...task, ...(task.scope === 'app' ? behavior.coreTaskCompleteReceipt : behavior.completeReceipt) }; },
      fail: async (id, error) => {
        calls.lifecycle.push(`fail:${id}`);
        assert.equal(typeof error, 'string');
        assert.match(error, /^Hana Math: [A-Z][A-Z0-9_]*; role=(main|worker|verifier|unknown); child=([A-Z][A-Z0-9_]*|unknown); runId=run-[a-z0-9-]+$/);
        assert.ok(error.length < 300); assert.doesNotMatch(error, /\[object Object\]/);
        const task = tasks.get(id); if (task?.scope === 'app' && behavior.coreTaskFailError) throw behavior.coreTaskFailError;
        if (task) { task.status = 'failed'; task.error = error; } if (task?.scope === 'session') finished.resolve();
        return { ...task, ...(task?.scope === 'app' ? behavior.coreTaskFailReceipt : behavior.failReceipt) }; },
      getDelivery: async () => ({ state: 'staged', delivered: false }),
    },
  };
  sdk.capabilities = { get: async (input) => { assert.deepEqual(input, {}); behavior.capabilityReads = (behavior.capabilityReads ?? 0) + 1; if (behavior.capabilityError) throw behavior.capabilityError; return behavior.capabilities ?? { capabilities: [] }; } };
  if (behavior.officialSdk) {
    const host = sdk;
    // Standard fixed bus fixture, as in profile.test.mjs. The unmodified SDK,
    // not the fixture, maps listAvailable to model:list and returns its envelope.
    sdk = createAppSdk({ dataDir, models: {}, tools: {}, hooks: {}, media: {}, providers: {}, tasks: host.tasks,
      storage: { global: {}, agent: () => ({}) }, bus: { async request(verb, input) {
        calls.bus.push({ verb, input: structuredClone(input) });
        if (verb === 'model:list') { assert.equal(input, undefined); return host.models.listAvailable(); }
        if (verb === 'agent:list') return host.agents.list(input);
        if (verb === 'app:capabilities') return host.capabilities.get(input);
        const method = { 'session:get': 'get', 'session:list': 'list', 'session:context': 'context', 'session:abort': 'abort' }[verb];
        assert.ok(method, `Unexpected SDK request ${verb}`); return host.sessions[method](input);
      } },
    });
  }
  const profiles = { getRoleModel: async (role) => { assert.ok(scope.getStore() === 'app' || scope.getStore() === undefined); calls.profiles.push(role); if (behavior.profileError) throw behavior.profileError instanceof Error ? behavior.profileError : new Error('saved profile unavailable'); return { role, agentId: `saved-${role}`, model: { provider: 'saved-provider', id: `${role}-model` }, source: 'saved-role' }; } };
  profiles.getRoleToolStatus = async (role) => ({ role, agentId: `saved-${role}`, resolvedMode: 'full', modeSource: 'explicit', explicitMode: 'full', legacyLightweightTools: null, appEnabled: true, disabledTools: [], ...behavior.toolStatus?.[role] });
  profiles.setRoleToolMode = async (role, agentId, toolMode) => {
    behavior.onToolMode?.(role, agentId, toolMode);
    if (behavior.toolModeGate) await behavior.toolModeGate.promise;
    behavior.toolStatus ??= {}; behavior.toolStatus[role] = { resolvedMode: toolMode, explicitMode: toolMode };
    return { saved: true, changed: true, sessionEffect: 'new-session-required', status: await profiles.getRoleToolStatus(role) };
  };
  const realContexts = behavior.realContexts ? createContextService(sdk) : null;
  const contexts = {
    prepareProjectWorkspace: async (input) => {
      calls.workspaces.push(input); assert.ok(realContexts); behavior.onWorkerWorkspace?.();
      if (behavior.workerWorkspaceGate) await behavior.workerWorkspaceGate.promise;
      return realContexts.prepareProjectWorkspace(input);
    },
    assignResearchTask: async (input) => {
      behavior.onAssign?.(input);
      if (behavior.assignGate) await behavior.assignGate.promise;
      if (behavior.assignError) throw behavior.assignError;
      if (realContexts) return realContexts.assignResearchTask(input);
      const taskFile = `context/projects/${input.projectId}/research/${input.runId}/worker/TASK.md`;
      const bytes = Buffer.from(input.task.endsWith('\n') ? input.task : `${input.task}\n`);
      await store.write(taskFile, bytes, true);
      return { state: 'ready', projectId: input.projectId, runId: input.runId, taskFile, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
    prepare: async (input) => { assert.equal(scope.getStore(), 'app'); calls.contexts.push(input); preparing.resolve(); if (behavior.prepareGate) await behavior.prepareGate.promise;
      const prepared = realContexts ? await realContexts.prepare(input) : { state: 'ready', projectId: 'fixture-project', ...behavior.prepared };
      preparedProjects.add(prepared.projectId); return prepared; },
    prepareResearchWorkspace: async (input) => {
      calls.workspaces.push(input); if (realContexts) return realContexts.prepareResearchWorkspace(input); const relative = `context/projects/${input.projectId}/research/${input.runId}/${input.role === 'verifier' ? `verifiers/${input.verificationId}` : input.role}`;
      await store.mkdir(relative, true); if (input.role === 'worker') await store.mkdir(`${relative}/local_memory`);
      return { state: 'ready', ...input, cwd: store.absolute(relative) };
    },
  };
  const createCore = (options) => {
    if (options === undefined && behavior.resultCore) return behavior.resultCore();
    const record = { id: ++coreSequence, disposed: false, options: structuredClone(options) };  calls.cores.push(record);
    return {
      call: async (binding, operation, args, verification, options) => {
        calls.core.push({ core: record.id, binding, operation, args, verification });
        if (!graphs.has(binding.projectId)) graphs.set(binding.projectId, new Map());
        const graph = graphs.get(binding.projectId);
        if (operation !== 'fact_get' || !record.disposed) assert.equal(record.disposed, false);
        if (behavior.beforeCore) await behavior.beforeCore({ binding, operation, args });
        if (behavior.coreError?.operation === operation) throw behavior.coreError.error;
        if (operation === 'prepare_submission' && Object.hasOwn(behavior, 'prepareReply')) return structuredClone(behavior.prepareReply);
        if (operation === 'prepare_submission') return { candidateDigest: behavior.runDigests ? createHash('sha256').update(binding.runId).digest('hex') : 'b'.repeat(64), predecessorDigests: {}, precheck: { passed: !behavior.precheckReject, status: behavior.precheckStatus ?? 'fixture', detail: behavior.precheckDetail ?? 'fixture precheck' } };
        if (operation === 'fact_submit') {
          assert.equal(scope.getStore(), 'app'); assert.ok(verification.verifierSessionId);
          if (behavior.writeError) return { accepted: true, fact_id: null, write_error: 'fixture write failure' };
          if (verification.report.verdict === 'wrong') return { accepted: false, verdict: 'wrong', repair_hints: verification.report.repair_hints, verification_report: verification.report.verification_report };
          const factId = behavior.contentFacts ? createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16) : fid;
          graph.set(factId, { fact_id: factId, markdown: '---\nfact_id: ' + factId + '\n---\nFull fixture Markdown\n', predecessors: args.predecessors || [] }); return { accepted: true, fact_id: factId };
        }
        if (operation === 'fact_list_page') { assert.ok(preparedProjects.has(binding.projectId)); return fixtureFactPage(behavior.listFacts ?? [...graph.values()], args, binding.projectId); }
        if (operation === 'fact_get') { assert.ok(preparedProjects.has(binding.projectId)); if (Object.hasOwn(behavior, 'readReply')) return structuredClone(behavior.readReply); return graph.get(args.fact_id) || { fact_id: args.fact_id, markdown: 'existing fixture fact', predecessors: [] }; }
        if (operation === 'fact_revoke') return { revoked: [args.fact_id] };
        const memory = binding.workerId ? `context/projects/${binding.projectId}/workers/${binding.workerId}/local_memory` : `context/projects/${binding.projectId}/research/${binding.runId}/worker/local_memory`;
        if (operation === 'local_memory_append') { await store.write(`${memory}/note.txt`, args.text, true); return { appended: true }; }
        if (operation === 'local_memory_read') return { text: (await store.read(`${memory}/note.txt`)).toString() };
        return { results: [] };
      },
      dispose: async () => { calls.lifecycle.push(`dispose:${record.id}`); record.disposed = true;
        if (record.id > 1) { behavior.onReadDispose?.(); if (behavior.readDisposeError) throw behavior.readDisposeError; }
        if (behavior.coreDisposeError) throw Object.assign(new Error('fixture cleanup failed'), { indeterminate: true }); },
    };
  };
  const sessions = { start(input) {
    assert.equal(scope.getStore(), 'app'); calls.starts.push(input); sessionCreating.resolve(input);
    const done = deferred(); const id = `session-${++sessionSequence}`;
    const state = { state: 'preparing', finalText: '', cleanupPending: false, finalizing: false, setupPending: false, sendPending: false, roundEnded: false, sessionId: id, abortOutcome: 'not-requested' };
    const host = { sessionId: id, path: `/private/${id}.jsonl`, ownerPluginId: 'hana-math', visibility: 'plugin_private', namespace: 'app', lifecycle: 'active', agentId: input.selection.agentId, cwd: input.cwd, kind: input.kind };
    hostSessions.set(id, host);
    const caller = { callToken: `host-token-${id}`, sessionPath: host.path };
    const invoke = (name, args) => service.invoke(name, args, caller);
    const roundKey = `${input.kind.split(':')[1]}:${input.role}`;
    const roleRound = (roleRounds.get(roundKey) || 0) + 1; roleRounds.set(roundKey, roleRound);
    const workerIndex = input.role === 'worker' ? roleRound : 0;
    const verifierIndex = input.role === 'verifier' ? roleRound : 0;
    const handle = { done: done.promise, snapshot: () => ({ ...state }), stop: async () => {
      calls.lifecycle.push('session-stop'); behavior.onSessionStop?.(state);
      if (state.state !== 'completed') { state.state = 'stopped'; state.abortOutcome = 'aborted'; if (behavior.sessionCleanupPending) state.cleanupPending = true; done.resolve({ ...state }); }
      return { ...state };
    } };
    if (input.turnMode === 'controlled') {
      assert.equal(input.role, 'worker');
      let turn = deferred(); Object.assign(state, { modelTurn: 1, turnEnded: false, role: input.role, sessionPath: host.path,
        agentId: input.selection.agentId, cwd: input.cwd, kind: input.kind, bound: true });
      const stop = handle.stop;
      handle.stop = async () => { const result = await stop(); turn.resolve(result); return result; };
      handle.nextTurn = () => turn.promise;
      const perform = async prompt => {
        try {
          if (state.state === 'stopped') return;
          state.state = 'running'; state.sendState = 'accepted'; await input.onUpdate({ ...state });
          sessionStarted.resolve({ input, caller, invoke, handle });
          let finalText = 'opaque turn complete';
          if (behavior.turn) finalText = await behavior.turn({ input: { ...input, prompt }, caller, invoke, workerIndex, verifierIndex, modelTurn: state.modelTurn, service, host, handle });
          else if ((workerIndex === 1 || behavior.allRounds) && state.modelTurn === 1) {
            const pending = await invoke('fact_submit', candidate); behavior.onPending?.(pending, calls);
          }
          if (state.state === 'stopped') return;
          if (behavior.modelFailureRounds?.includes(workerIndex)) {
            Object.assign(state, { state: 'failed', error: behavior.modelFailureCode || 'FINAL_ASSISTANT_MISSING', modelStopReason: behavior.modelFailureStopReason || 'stop', failurePhase: 'awaiting-agent-end', sdkError: behavior.modelFailureSdkError || null, sendState: behavior.modelFailureSendState ?? 'accepted', cleanupPending: behavior.modelFailureCleanupPending ?? false, turnEnded: behavior.modelFailureTurnEnded ?? true,
              ...(behavior.modelFailureIdentityMismatch ? { agentId: 'foreign-worker' } : {}) });
            await input.onUpdate({ ...state }); turn.resolve({ ...state }); done.resolve({ ...state }); return;
          }
          Object.assign(state, { finalText: finalText || 'opaque turn complete', turnEnded: true, modelStopReason: 'stop' });
          await input.onUpdate({ ...state }); turn.resolve({ ...state });
        } catch (error) {
          if (state.state !== 'stopped') { state.state = 'failed'; state.error = error.code || error.message; await input.onUpdate({ ...state }).catch(() => {}); }
          turn.resolve({ ...state }); done.resolve({ ...state });
        }
      };
      handle.resume = async prompt => {
        assert.equal(state.state, 'running'); assert.equal(state.turnEnded, true);
        calls.resumes.push({ sessionId: id, modelTurn: state.modelTurn + 1, prompt });
        if (behavior.resumeGate) await behavior.resumeGate.promise;
        if (behavior.resumeError) throw behavior.resumeError;
        if (state.state === 'stopped') throw Object.assign(new Error('stopped fixture'), { code: 'SESSION_STOPPED' });
        state.modelTurn++; state.turnEnded = false; turn = deferred();
        Promise.resolve().then(() => perform(prompt)).catch(done.reject);
        return { accepted: true, sessionId: id, modelTurn: state.modelTurn };
      };
      handle.complete = async () => {
        assert.equal(state.state, 'running'); assert.equal(state.turnEnded, true);
        if (behavior.onComplete) await behavior.onComplete({ invoke, caller });
        state.state = 'completed'; state.roundEnded = true; await input.onUpdate({ ...state });
        const result = { ...state }; done.resolve(result); return result;
      };
      Promise.resolve().then(async () => {
        if (behavior.workerBoundGate) await behavior.workerBoundGate.promise;
        await input.onBound({ sessionId: id, sessionPath: host.path, agentId: input.selection.agentId, role: input.role, model: input.selection.model, cwd: input.cwd,
          ...(Object.hasOwn(input.selection, 'thinkingLevel') ? { thinkingLevel: input.selection.thinkingLevel, reportedThinkingLevel: input.selection.thinkingLevel } : {}) });
        await perform(input.prompt);
      }).catch(error => { state.state = 'failed'; state.error = error.code || error.message; turn.resolve({ ...state }); done.resolve({ ...state }); });
      return handle;
    }
    Promise.resolve().then(async () => {
      try {
        if (behavior.boundGate && input.role === 'main') await behavior.boundGate.promise;
        await input.onBound({ sessionId: id, sessionPath: host.path, agentId: input.selection.agentId, role: input.role, model: input.selection.model, cwd: input.cwd,
          ...(Object.hasOwn(input.selection, 'thinkingLevel') ? { thinkingLevel: input.selection.thinkingLevel, reportedThinkingLevel: input.selection.thinkingLevel } : {}) });
        if (state.state === 'stopped') return;
        state.state = 'running'; state.sendState = 'accepted'; await input.onUpdate({ ...state }); sessionStarted.resolve({ input, caller, invoke, handle });
        let finalText = 'fixture final';
        if (behavior.turn) finalText = await behavior.turn({ input, caller, invoke, workerIndex, verifierIndex, service, host, handle });
        else if (input.role === 'main' && input.toolNames.includes('math_assign')) { if (!behavior.noAssignment) await invoke('math_assign', { task: 'Bounded fixture task' }); }
        else if (input.role === 'worker' && (workerIndex === 1 || behavior.allRounds)) {
          const pending = await invoke('fact_submit', candidate); behavior.onPending?.(pending, calls);
          assert.equal(pending.accepted, false);
        } else if (input.role === 'main') behavior.onSummary?.();
        else if (input.role === 'verifier' && behavior.verifierModelFailure) {
          Object.assign(state, { state: 'failed', error: 'MODEL_TURN_FAILED', modelStopReason: 'error', failurePhase: 'awaiting-agent-end', turnEnded: true });
          await input.onUpdate({ ...state }); done.resolve({ ...state }); return;
        } else if (input.role === 'verifier') {
          const value = behavior.report || GOOD; await invoke('math_verification_report', value); finalText = JSON.stringify(behavior.finalReport || value);
        }
        if (state.state === 'stopped') return;
        state.finalText = finalText || 'fixture final'; state.state = 'completed'; state.roundEnded = true;
        state.modelStopReason = input.role === 'verifier' && Object.hasOwn(behavior, 'verifierStopReason') ? behavior.verifierStopReason : 'stop';
        await input.onUpdate({ ...state }); done.resolve({ ...state });
      } catch (e) {
        if (state.state !== 'stopped') { state.state = 'failed'; state.error = e.code || e.message; await input.onUpdate({ ...state }).catch(() => {}); done.resolve({ ...state }); }
      }
    }).catch(done.reject);
    return handle;
  } };
  const literature = { search: async (...args) => { calls.literature.push(args); return { query: args[0], count: 0, results: [] }; } };
  let bindings;
  if (behavior.wrapAuthorizedBinding) {
    bindings = createResearchBindings(sdk, { isRunActive: () => !stopped });
    const authorize = bindings.authorize;
    bindings.authorize = async (name, context) => behavior.wrapAuthorizedBinding(await authorize(name, context), name, service);
  }
  service = await (behavior.createService ?? createResearchService)(sdk, { contexts, profiles, createCore, sessions, literature, ...(bindings ? { bindings } : {}) });
  t.after(async () => { await service.dispose(); if (!existing) await fs.rm(dataDir, { recursive: true, force: true }); });
  const dispatch = async (payload) => {
    const found = payload ? calls.schedule.findIndex(call => call.payload.runId === payload.runId) : -1;
    const index = found >= 0 ? found : calls.schedule.length - 1;
    const input = calls.schedule[index], scheduleId = `schedule-${index + 1}`;
    return scope.run('app', () => handlers.get('math-research-once').run({ kind: 'schedule', scheduleId, input: payload || input.payload }));
  };
  const wait = async (id) => { await finished.promise; await tick(); return service.status(id, origin); };
  const waitIdle = async (id) => {
    for (let n = 0; n < 2000; n++) { const status = await service.status(id, origin); if (!status.coordinatorActive) return status;
      if (realContexts) await new Promise(resolve => setTimeout(resolve, 5)); else await tick(); }
    throw new Error('fixture coordinator did not end');
  };
  const prepareWorker = async (projectId, workerId, task = 'opaque logical assignment') => {
    assert.ok(realContexts); await realContexts.prepare({ projectId, problem: 'opaque project', operatorProfile: 'opaque operator', workerTask: 'opaque initial hint' });
    preparedProjects.add(projectId);
    await realContexts.prepareProjectWorkspace({ projectId, role: 'worker', workerId });
    return realContexts.assignWorkerTask({ projectId, workerId, task });
  };
  return { service, sdk, prepareWorker, waitIdle, calls, tasks, schedules, hostSessions, handlers, dispatch, wait, taskCreated, coreTaskCreated, sessionStarted, preparing, sessionCreating, dataDir, store, scope };
}

for (const action of ['hook', 'invoke']) test(`a deterministic stop between authorization and ${action} cannot record or execute`, async t => {
  const checked = deferred(); let stop, reads = 0;
  const f = await fixture(t, { wrapAuthorizedBinding(binding, name, service) {
    if (name !== 'fact_submit') return binding;
    return { ...binding, get projectId() {
      if (++reads === 1) queueMicrotask(() => { stop = service.stop(binding.runId, origin); });
      return binding.projectId;
    } };
  }, turn: async ({ input, caller, invoke, workerIndex, service }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque stop fixture' });
    if (input.role === 'worker' && workerIndex === 1) {
      try {
        if (action === 'hook') assert.equal(await service.recordSubmissionInputRejection(caller, 'INVALID_INPUT'), false);
        else await assert.rejects(invoke('fact_submit', candidate), { code: 'RUN_INACTIVE' });
        checked.resolve();
      } catch (error) { checked.reject(error); throw error; }
    }
    return 'opaque completion';
  } });
  const run = await f.service.run({ problem: 'opaque stop ordering' }, origin); await f.dispatch(); await checked.promise; await stop;
  const status = await f.service.status(run.runId, origin);
  assert.equal(reads, 1); assert.equal(status.submissionDiagnostics.total, 0);
  assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 0);
});

for (const [args, expected] of [[{ statement: 'opaque missing proof' }, 'INVALID_INPUT'],
  [{ ...candidate, external_refs: Array.from({ length: 3 }, () => ({ opaque: 'x'.repeat(180 * 1024) })) }, 'VERIFIER_INPUT_TOO_LARGE']])
  test(`diagnostic EIO preserves the original ${expected} submission error`, async t => {
    let f, injected = false, observed = false;
    f = await fixture(t, { turn: async ({ input, invoke, workerIndex }) => {
      if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque failure fixture' });
      if (input.role === 'worker' && workerIndex === 1) {
        const destination = f.store.absolute(`research/runs/${input.kind.split(':')[1]}/run.json`), rename = fs.rename;
        const mocked = t.mock.method(fs, 'rename', async (from, to) => {
          if (to === destination && !injected) { injected = true; throw Object.assign(new Error('SENTINEL_IO'), { code: 'EIO' }); }
          return rename(from, to);
        }); syncBuiltinESMExports();
        try { await assert.rejects(invoke('fact_submit', args), { code: expected }); observed = true; }
        finally { mocked.mock.restore(); syncBuiltinESMExports(); }
      }
      return 'opaque completion';
    } });
    const run = await f.service.run({ problem: 'opaque combined errors' }, origin); await f.dispatch(); const status = await f.wait(run.runId);
    assert.equal(observed, true); assert.equal(injected, true); assert.equal(status.state, 'failed');
    assert.equal(status.submissionDiagnostics.recordingComplete, false); assert.equal(status.submissionDiagnostics.attempts[0].code, expected);
    assert.equal(status.error.code, 'EIO');
  });

test('real tool registration and authorized hook retain input error through EIO and safe recovery projection', async t => {
  let f, injected = false, tools = new Map(), observed = false;
  f = await fixture(t, { turn: async ({ input, invoke, caller, workerIndex }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque combined tool fixture' });
    if (input.role === 'worker' && workerIndex === 1) {
      const destination = f.store.absolute(`research/runs/${input.kind.split(':')[1]}/run.json`), rename = fs.rename;
      const mocked = t.mock.method(fs, 'rename', async (from, to) => {
        if (to === destination && !injected) { injected = true; throw Object.assign(new Error('SENTINEL_IO'), { code: 'EIO' }); }
        return rename(from, to);
      }); syncBuiltinESMExports();
      try {
        const reply = await tools.get('fact_submit').execute({ statement: 'SENTINEL_BODY', proof: null, context: caller });
        assert.equal(reply.isError, true); assert.equal(reply.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT'); observed = true;
      } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
    }
    return 'opaque completion';
  } });
  f.sdk.tools = { async register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } };
  const registration = await registerMathResearch(f.sdk, f.service); t.after(() => registration.dispose());
  const run = await f.service.run({ problem: 'opaque combined real services' }, origin); await f.dispatch(); await f.wait(run.runId); await f.waitIdle(run.runId); await f.service.dispose();
  assert.equal(injected, true); assert.equal(observed, true); assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 0);
  const file = `research/runs/${run.runId}/run.json`, meta = await f.store.readJson(file);
  assert.equal(meta.submissionDiagnostics.recordingComplete, false);
  meta.submissionDiagnostics.extra = 'SENTINEL_STORED_PRIVATE'; meta.submissionDiagnostics.attempts[0].detail = 'SENTINEL_STORED_PRIVATE';
  await f.store.write(file, JSON.stringify(meta), true); const before = await f.store.read(file);
  const reopened = await fixture(t, { tasks: f.tasks, hostSessions: f.hostSessions }, f.dataDir), status = await reopened.service.status(run.runId, origin);
  assert.equal(status.submissionDiagnostics.available, true); assert.equal(status.submissionDiagnostics.recordingComplete, false);
  assert.equal(status.submissionDiagnostics.attempts[0].source, 'tool-validation');
  assert.equal(status.submissionDiagnostics.attempts[0].code, 'RESEARCH_TOOL_INVALID_INPUT');
  assert.doesNotMatch(JSON.stringify(status.submissionDiagnostics), /SENTINEL|detail|extra/);
  assert.deepEqual(await f.store.read(file), before);
});

test('restored malformed submission metadata fails closed per record without rewriting evidence', async t => {
  const f = await fixture(t), run = await f.service.run({ problem: 'opaque damaged diagnostics' }, origin); await f.dispatch(); await f.wait(run.runId); await f.waitIdle(run.runId); await f.service.dispose();
  const file = `research/runs/${run.runId}/run.json`, base = await f.store.readJson(file);
  const variants = [h => { h.total = -1; }, h => { h.omitted = 1; }, h => { h.attempts = 'SENTINEL_PRIVATE'; },
    h => { h.attempts[0].code = 'SENTINEL private body'; }, h => { h.attempts[0].workerSessionId = 'SENTINEL private body'; },
    h => { h.attempts[0].source = 'SENTINEL_PRIVATE'; }, h => { h.attempts[0].at = 'SENTINEL_PRIVATE'; },
    h => { h.attempts = Array(257).fill(h.attempts[0]); h.total = 257; },
    h => { const a = h.attempts[0]; a.outcome = 'precheck-rejected'; delete a.submissionId; a.precheck = { rule: 'P9', target: 'proof', status: 400 }; },
    h => { const a = h.attempts[0]; a.outcome = 'precheck-rejected'; delete a.submissionId; a.precheck = { rule: 'P1', target: 'proof', status: 'SENTINEL_PRIVATE' }; }];
  for (const mutate of variants) {
    const meta = structuredClone(base); mutate(meta.submissionDiagnostics); await f.store.write(file, JSON.stringify(meta), true); const before = await f.store.read(file);
    const reopened = await fixture(t, { tasks: f.tasks, hostSessions: f.hostSessions }, f.dataDir);
    const history = (await reopened.service.status(run.runId, origin)).submissionDiagnostics;
    assert.equal(history.available, false); assert.equal(history.history, 'invalid'); assert.equal(history.recordingComplete, false);
    assert.equal(Object.hasOwn(history, 'total'), false); assert.doesNotMatch(JSON.stringify(history), /SENTINEL/);
    assert.deepEqual(await f.store.read(file), before); await reopened.service.dispose();
  }
  const independent = await fixture(t, { tasks: f.tasks, hostSessions: f.hostSessions }, f.dataDir);
  const fresh = await independent.service.run({ problem: 'opaque independent project' }, origin);
  assert.equal(fresh.state, 'queued'); assert.equal((await independent.service.status(fresh.runId, origin)).submissionDiagnostics.available, true);
  await independent.service.stop(fresh.runId, origin);
});

test('authorized submission diagnostics preserve the synchronous slot and successful verifier pipeline', async t => {
  const preparing = deferred(), release = deferred(); t.after(() => release.resolve());
  let f;
  const behavior = { beforeCore: async ({ operation }) => { if (operation === 'prepare_submission') { preparing.resolve(); await release.promise; } },
    turn: async ({ input, caller, invoke, workerIndex, service, host }) => {
      if (input.role === 'main' && input.toolNames.includes('math_assign')) {
        assert.equal(await service.recordSubmissionInputRejection(caller, 'INVALID_INPUT'), false);
        await invoke('math_assign', { task: 'opaque diagnostic task' });
      } else if (input.role === 'worker' && workerIndex === 1) {
        const runId = input.kind.split(':')[1], file = `research/runs/${runId}/run.json`;
        const before = await f.store.read(file);
        assert.equal(await service.recordSubmissionInputRejection(origin, 'INVALID_INPUT'), false);
        assert.deepEqual(await f.store.read(file), before);
        const coreBefore = f.calls.core.length;
        assert.equal(await service.recordSubmissionInputRejection(caller, 'RESEARCH_TOOL_INVALID_INPUT'), true);
        assert.equal(f.calls.core.length, coreBefore);
        await assert.rejects(invoke('fact_submit', { statement: 'SENTINEL_BODY', proof: () => 'SENTINEL_BODY' }), { code: 'PLAIN_JSON_REQUIRED' });
        await assert.rejects(invoke('fact_submit', { statement: 'SENTINEL_BODY' }), { code: 'INVALID_INPUT' });
        const pending = invoke('fact_submit', { ...candidate, statement: 'SENTINEL_BODY' });
        await preparing.promise;
        const live = await service.status(runId, origin);
        assert.equal(live.submissionDiagnostics.attempts.at(-1).outcome, 'processing');
        await assert.rejects(invoke('fact_submit', candidate), { code: 'SUBMISSION_ALREADY_PENDING' });
        release.resolve(); const registered = await pending; assert.equal(registered.pending, true);
        const history = (await service.status(runId, origin)).submissionDiagnostics;
        assert.equal(history.total, 5); assert.equal(history.omitted, 0); assert.equal(history.available, true);
        assert.equal(history.coverage, 'authorized-app-callbacks'); assert.equal(history.hostPreCallbackRejectionsCovered, false);
        assert.equal(history.zeroAttemptsProvesNoModelCall, false);
        assert.deepEqual(history.attempts.map(a => a.outcome), ['input-rejected', 'input-rejected', 'input-rejected', 'registered', 'slot-rejected']);
        assert.equal(history.attempts[0].source, 'tool-validation'); assert.equal(history.attempts[3].submissionId, registered.submissionId);
        assert.equal(history.attempts[4].code, 'SUBMISSION_ALREADY_PENDING');
        assert.equal(new Set(history.attempts.map(a => a.attemptId)).size, 5);
        for (const attempt of history.attempts) { assert.equal(attempt.round, 1); assert.equal(attempt.workerSessionId, host.sessionId); assert.ok(Number.isSafeInteger(attempt.at)); }
        assert.doesNotMatch(JSON.stringify(history), /SENTINEL_BODY|statement|proof|arguments|detail/);
      } else if (input.role === 'verifier') { await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD); }
      return 'opaque completion';
    } };
  f = await fixture(t, behavior); const run = await f.service.run({ problem: 'opaque diagnostic fixture' }, origin); await f.dispatch();
  const done = await f.wait(run.runId); assert.equal(done.state, 'finished'); assert.deepEqual(done.verifiedFactIds, [fid]);
  assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 1);
});

for (const [prefix, rule, target] of [['[P1 on proof]', 'P1', 'proof'], ['[P3 on statement]', 'P3', 'statement'],
  ['[P5 on proof]', 'P5', 'proof'], ['vacuous proof:', 'vacuous', 'proof'], ['vacuous statement:', 'vacuous', 'statement'],
  ['not a rule [P1 on proof]', 'unknown', 'unknown']]) test(`precheck metadata allowlists only the prefix ${prefix}`, async t => {
  const f = await fixture(t, { precheckReject: true, precheckStatus: 400, precheckDetail: `${prefix} SENTINEL_PRECHECK_PRIVATE` });
  const run = await f.service.run({ problem: 'opaque precheck' }, origin); await f.dispatch(); const done = await f.wait(run.runId);
  assert.equal(done.state, 'finished'); assert.equal(done.submissions.length, 0);
  const history = done.submissionDiagnostics; assert.equal(history.total, 1);
  assert.equal(history.attempts[0].outcome, 'precheck-rejected'); assert.deepEqual(history.attempts[0].precheck, { rule, target, status: 400 });
  assert.doesNotMatch(JSON.stringify(history), /SENTINEL_PRECHECK_PRIVATE|detail|software fixture proof/);
  assert.match(f.calls.starts.filter(s => s.role === 'worker')[1].prompt, /SENTINEL_PRECHECK_PRIVATE/); // Original worker feedback is unchanged.
});

test('prepare rejection retains the revoked candidate code but no raw Core error', async t => {
  const error = Object.assign(new Error('SENTINEL_EXCEPTION'), { code: 'RESEARCH_RUNTIME_REJECTED', coreError: { code: 'revoked_candidate', message: 'SENTINEL_CORE_TEXT' } });
  const f = await fixture(t, { coreError: { operation: 'prepare_submission', error } });
  const run = await f.service.run({ problem: 'opaque revoked fixture' }, origin); await f.dispatch(); const done = await f.wait(run.runId);
  assert.equal(done.submissions.length, 0); const a = done.submissionDiagnostics.attempts[0];
  assert.equal(a.outcome, 'prepare-error'); assert.equal(a.code, 'RESEARCH_RUNTIME_REJECTED'); assert.equal(a.coreCode, 'revoked_candidate');
  assert.doesNotMatch(JSON.stringify(done.submissionDiagnostics), /SENTINEL|message|detail/);
});

test('diagnostics retain the latest 256 without turning truncation into a submission quota', async t => {
  const f = await fixture(t, { turn: async ({ input, caller, invoke, workerIndex, service }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque cap task' });
    if (input.role === 'worker' && workerIndex === 1) {
      for (let n = 0; n < 257; n++) assert.equal(await service.recordSubmissionInputRejection(caller, 'INVALID_INPUT'), true);
      assert.equal((await invoke('fact_submit', candidate)).pending, true);
    }
    if (input.role === 'verifier') { await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD); }
    return 'opaque completion';
  } });
  const run = await f.service.run({ problem: 'opaque cap' }, origin); await f.dispatch(); const done = await f.wait(run.runId);
  assert.equal(done.state, 'finished'); assert.deepEqual(done.verifiedFactIds, [fid]);
  assert.equal(done.submissionDiagnostics.total, 258); assert.equal(done.submissionDiagnostics.omitted, 2);
  assert.equal(done.submissionDiagnostics.attempts.length, 256); assert.equal(done.submissionDiagnostics.attempts.at(-1).outcome, 'registered');
});

test('historical runs without diagnostics remain unknown rather than fabricated zero-attempt histories', async t => {
  const f = await fixture(t), run = await f.service.run({ problem: 'opaque history' }, origin); await f.dispatch(); await f.wait(run.runId); await f.waitIdle(run.runId); await f.service.dispose();
  const file = `research/runs/${run.runId}/run.json`, meta = await f.store.readJson(file); delete meta.submissionDiagnostics; await f.store.write(file, JSON.stringify(meta), true);
  const reopened = await fixture(t, { tasks: f.tasks, hostSessions: f.hostSessions }, f.dataDir);
  const history = (await reopened.service.status(run.runId, origin)).submissionDiagnostics;
  assert.equal(history.available, false); assert.equal(history.history, 'unknown'); assert.equal(Object.hasOwn(history, 'total'), false);
});

test('input rejection hook propagates persistence failure and never claims complete recording', async t => {
  let f, injected = false;
  f = await fixture(t, { turn: async ({ input, caller, invoke, workerIndex, service }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque persistence task' });
    if (input.role === 'worker' && workerIndex === 1) {
      const runId = input.kind.split(':')[1], destination = f.store.absolute(`research/runs/${runId}/run.json`), rename = fs.rename;
      const mocked = t.mock.method(fs, 'rename', async (from, to) => { if (to === destination) { injected = true; throw Object.assign(new Error('SENTINEL_IO'), { code: 'EIO' }); } return rename(from, to); });
      syncBuiltinESMExports();
      try { await assert.rejects(service.recordSubmissionInputRejection(caller, 'INVALID_INPUT'), { code: 'EIO' }); }
      finally { mocked.mock.restore(); syncBuiltinESMExports(); }
      const status = await service.status(runId, origin); assert.equal(status.cleanupPending, true); assert.equal(status.submissionDiagnostics.recordingComplete, false);
    }
    return 'opaque completion';
  } });
  const run = await f.service.run({ problem: 'opaque persistence' }, origin); await f.dispatch(); await f.wait(run.runId); assert.equal(injected, true);
});

for (const filename of ['project-workspace.json', 'run-ref.json']) test(`admission ticket invalidated during real ${filename} preparation issues no task or schedule`, async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { realContexts: true, turn: async () => 'opaque' });
  await f.prepareWorker('ticket-preparation', 'worker-1');
  const target = path.join(f.dataDir, 'context/projects/ticket-preparation/workers/worker-1', filename);
  const lstat = fs.lstat; let intercepted = false, valid = true, checks = 0;
  t.mock.method(fs, 'lstat', async (...args) => {
    if (!intercepted && args[0] === target) { intercepted = true; entered.resolve(); await release.promise; }
    return lstat(...args);
  }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const ctxBefore = structuredClone(origin);
  const creating = f.service.startWorkerRun({ projectId: 'ticket-preparation', workerId: 'worker-1' }, origin, {
    assertAdmission: () => { checks++; if (!valid) throw Object.assign(new Error('opaque invalid ticket'), { code: 'GOAL_TICKET_INVALID' }); },
  }).catch(error => error);
  await entered.promise; valid = false; release.resolve(); const error = await creating;
  assert.equal(error.code, 'GOAL_TICKET_INVALID'); assert.equal(checks, 2);
  const closed = await f.service.dispose(), status = closed.runs.find(row => row.runId === error.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.cleanupPending, false);
  assert.equal(f.calls.taskCreate.length, 0); assert.equal(f.calls.schedule.length, 0); assert.equal(f.calls.starts.length, 0);
  const input = (await f.store.read(`research/runs/${error.runId}/input.json`)).toString();
  const meta = (await f.store.read(`research/runs/${error.runId}/run.json`)).toString();
  for (const bytes of [input, meta]) { assert.equal(bytes.includes('assertAdmission'), false); assert.equal(bytes.includes(origin.callToken), false); }
  assert.deepEqual(origin, ctxBefore);
});

for (const rejectAt of [3, 4, 6]) test(`admission guard rejection at checkpoint ${rejectAt} does not invent an unknown SDK operation`, async t => {
  const f = await fixture(t, { realContexts: true, turn: async () => 'opaque' });
  await f.prepareWorker('ticket-checkpoint', 'worker-1'); let checks = 0;
  const result = await f.service.startWorkerRun({ projectId: 'ticket-checkpoint', workerId: 'worker-1', workerPolicy: { maxRounds: 1, roundDelaySeconds: 0 } }, origin, {
    assertAdmission: () => { if (++checks === rejectAt) throw Object.assign(new Error('opaque ticket revoked'), { code: 'GOAL_TICKET_INVALID' }); },
  }).catch(error => error);
  if (rejectAt === 6) { await f.dispatch(); await f.wait(result.runId); }
  else assert.equal(result.code, 'GOAL_TICKET_INVALID');
  const closed = await f.service.dispose(), status = closed.runs.find(row => row.runId === result.runId);
  assert.equal(checks, rejectAt); assert.equal(status.state, 'failed'); assert.equal(status.error.code, 'GOAL_TICKET_INVALID');
  assert.equal(status.cleanupPending, false); assert.equal(status.indeterminate, false);
  assert.equal(f.calls.taskCreate.length, rejectAt === 3 ? 0 : rejectAt === 4 ? 1 : 2);
  assert.equal(f.calls.schedule.length, rejectAt === 6 ? 1 : 0); assert.equal(f.calls.starts.length, 0);
  const meta = await f.store.readJson(`research/runs/${result.runId}/run.json`);
  assert.equal(meta.taskCreatePending, false); assert.equal(meta.schedulePending, false);
  assert.equal(meta.coreTaskCreatePending, false); assert.deepEqual(meta.sessions, []);
});

test('admission invalidated in real pipeline workspace setup cannot create Core task or hand off a worker', async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve()); let valid = true;
  const f = await fixture(t, { realContexts: true, onWorkerWorkspace: entered.resolve, workerWorkspaceGate: release, turn: async () => 'opaque' });
  await f.prepareWorker('ticket-pipeline', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'ticket-pipeline', workerId: 'worker-1' }, origin, {
    assertAdmission: () => { if (!valid) throw Object.assign(new Error('opaque paused goal'), { code: 'GOAL_TICKET_INVALID' }); },
  });
  await f.dispatch(); await entered.promise; valid = false; release.resolve();
  await f.wait(job.runId); const closed = await f.service.dispose();
  const status = closed.runs.find(row => row.runId === job.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.error.code, 'GOAL_TICKET_INVALID'); assert.equal(status.cleanupPending, false);
  assert.equal(f.calls.taskCreate.length, 1); assert.equal(f.calls.schedule.length, 1); assert.equal(f.calls.starts.length, 0);
});

for (const stopAfterHandoff of [false, true]) test(`admission ticket retires at first helper handoff, including delayed initialization; stop=${stopAfterHandoff}`, async t => {
  const gate = deferred(); t.after(() => gate.resolve()); let valid = true, checks = 0;
  const f = await fixture(t, { realContexts: true, workerBoundGate: gate, turn: async () => 'opaque no candidate' });
  await f.prepareWorker('ticket-handoff', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'ticket-handoff', workerId: 'worker-1', workerPolicy: { maxRounds: 2, roundDelaySeconds: 0 } }, origin, {
    assertAdmission: () => { checks++; if (!valid) throw Object.assign(new Error('opaque paused goal'), { code: 'GOAL_TICKET_INVALID' }); },
  });
  await f.dispatch(); await f.sessionCreating.promise; assert.equal(checks, 6);
  valid = false;
  if (stopAfterHandoff) {
    const requested = await f.service.stopProjectWorker('ticket-handoff', job.runId);
    assert.equal(requested.state, 'running'); assert.equal(requested.stopping, true);
  }
  gate.resolve(); const status = await f.wait(job.runId);
  assert.equal(checks, 6); assert.equal(status.state, stopAfterHandoff ? 'stopped' : 'finished');
  assert.equal(f.calls.starts.length, stopAfterHandoff ? 1 : 2); assert.equal(f.calls.schedule.length, 1);
});

test('admission hook cannot clear uncertainty after an actually issued Core task creation', async t => {
  const f = await fixture(t, { realContexts: true, coreTaskCreateError: Object.assign(new Error('opaque unknown task receipt'), { code: 'APP_HOST_ERROR' }) });
  await f.prepareWorker('ticket-unknown', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'ticket-unknown', workerId: 'worker-1' }, origin, { assertAdmission: () => true });
  await f.dispatch(); await f.wait(job.runId); const closed = await f.service.dispose();
  const status = closed.runs.find(row => row.runId === job.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.coreTaskCreatePending, true);
  assert.equal(status.coreTaskSettlementPending, true); assert.equal(status.cleanupPending, true);
  assert.equal(f.calls.taskCreate.length, 2); assert.equal(f.calls.schedule.length, 1); assert.equal(f.calls.starts.length, 0);
  const meta = await f.store.readJson(`research/runs/${job.runId}/run.json`);
  assert.equal(meta.coreTaskCreatePending, true); assert.equal(meta.coreTaskSettlementPending, true);
});

test('admission hook is internal, synchronous and initially checked before run allocation', async t => {
  const f = await fixture(t, { realContexts: true }); await f.prepareWorker('ticket-contract', 'worker-1');
  const input = { projectId: 'ticket-contract', workerId: 'worker-1' };
  await assert.rejects(f.service.startWorkerRun({ ...input, assertAdmission: true }, origin), { code: 'INVALID_INPUT' });
  await assert.rejects(f.service.startWorkerRun(input, origin, { assertAdmission: true }), { code: 'INVALID_ADMISSION_GUARD' });
  await assert.rejects(f.service.startWorkerRun(input, origin, { assertAdmission: () => false }), { code: 'WORKER_ADMISSION_DENIED' });
  await assert.rejects(f.service.startWorkerRun(input, origin, { assertAdmission: async () => { throw new Error('opaque async guard'); } }), { code: 'WORKER_ADMISSION_GUARD_ASYNC' });
  assert.deepEqual(await f.store.list('research/runs'), []);
  assert.equal(f.calls.taskCreate.length, 0); assert.equal(f.calls.schedule.length, 0); assert.equal(f.calls.starts.length, 0);
});

test('configured four rounds keep an independent nullable run budget and strict persisted diagnostics', async t => {
  const f = await fixture(t, { realContexts: true, allRounds: true }); await f.prepareWorker('configured-four', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-four', workerId: 'worker-1', workerPolicy: { maxRounds: 4, roundDelaySeconds: 0 } }, origin);
  assert.equal(job.deadlineAt, null); assert.equal(job.executionPolicy.totalTimeoutSeconds, null);
  assert.equal(job.executionPolicy.workerPolicy.roundTimeoutSeconds, 14400);
  await f.dispatch(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'finished'); assert.equal(status.round, 4);
  assert.equal(status.executionBridge, 'configured-mathematical-rounds-same-session-feedback');
  assert.equal(f.calls.starts.filter(s => s.role === 'worker').length, 4);
  assert.equal(status.submissionDiagnostics.attempts.at(-1).round, 4);
  assert.equal(submissionProjection(status.submissionDiagnostics).history, 'invalid');
  assert.equal(submissionProjection(status.submissionDiagnostics, status.executionPolicy).available, true);
  assert.ok(status.verifiedFactIds.length > 0);
  await f.service.dispose();
  const before = await f.store.read(`research/runs/${job.runId}/run.json`);
  const reopened = await fixture(t, { realContexts: true, tasks: f.tasks, schedules: f.schedules, hostSessions: f.hostSessions }, f.dataDir);
  const restored = await reopened.service.projectWorkerStatus('configured-four', job.runId);
  assert.deepEqual(restored.executionPolicy, status.executionPolicy); assert.equal(restored.submissionDiagnostics.available, true);
  assert.deepEqual(await f.store.read(`research/runs/${job.runId}/run.json`), before);
  assert.equal(reopened.calls.starts.length, 0);
});

for (const [failures, cap, rounds, expectedState, expectedRound] of [
  [[1, 3], 2, 4, 'finished', 4], [[1, 2, 3], 2, 4, 'failed', 2], [[1, 2, 3, 4], 0, 4, 'finished', 4],
]) test(`configured confirmed model failures ${failures.join(',')} cutoff ${cap}`, async t => {
  const counts = []; let f;
  f = await fixture(t, { realContexts: true, modelFailureRounds: failures, turn: async ({ input }) => {
    if (input.role === 'worker') counts.push((await f.service.status(input.kind.split(':')[1], origin)).consecutiveFailures);
    return 'opaque no candidate';
  } });
  await f.prepareWorker('configured-failures', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-failures', workerId: 'worker-1',
    workerPolicy: { maxRounds: rounds, roundDelaySeconds: 0, maxConsecutiveFailures: cap } }, origin);
  await f.dispatch(); const status = await f.wait(job.runId);
  assert.equal(status.state, expectedState); assert.equal(status.round, expectedRound);
  assert.deepEqual(counts, cap === 2 && failures.length === 2 ? [0, 1, 0, 1] : Array.from({ length: expectedRound }, (_, i) => i));
  if (expectedState === 'failed') assert.equal(status.error.code, 'CONSECUTIVE_ROUND_FAILURES');
});

for (const configured of [false, true]) test(`normal empty worker ending configured=${configured} retains its original failure semantics`, async t => {
  const f = await fixture(t, { realContexts: true, modelFailureRounds: [1], turn: async () => 'opaque no candidate' });
  await f.prepareWorker('empty-mode-comparison', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'empty-mode-comparison', workerId: 'worker-1',
    ...(configured ? { workerPolicy: { maxRounds: 1, roundDelaySeconds: 0 } } : {}) }, origin);
  await f.dispatch(); const status = await f.wait(job.runId);
  assert.equal(status.sessions[0].error, 'FINAL_ASSISTANT_MISSING');
  assert.equal(f.calls.starts.length, 1);
  if (configured) {
    assert.equal(status.state, 'finished'); assert.equal(status.consecutiveFailures, 1);
    assert.equal(status.lastRoundOutcome.code, 1); assert.equal(status.lastRoundOutcome.error.code, 'CONFIRMED_MODEL_ROUND_FAILURE');
  } else {
    assert.equal(status.state, 'failed'); assert.equal(status.consecutiveFailures, undefined);
  }
});

test('configured MODEL_TURN_FAILED counts once, then a successful round resets the counter', async t => {
  const counts = []; let f;
  f = await fixture(t, { realContexts: true, modelFailureRounds: [1], modelFailureCode: 'MODEL_TURN_FAILED', modelFailureStopReason: 'error', turn: async ({ input }) => {
    counts.push((await f.service.status(input.kind.split(':')[1], origin)).consecutiveFailures); return 'opaque no candidate';
  } });
  await f.prepareWorker('configured-error-reset', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-error-reset', workerId: 'worker-1', workerPolicy: { maxRounds: 2, roundDelaySeconds: 0, maxConsecutiveFailures: 2 } }, origin);
  await f.dispatch(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'finished'); assert.equal(status.round, 2); assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.lastRoundOutcome.code, 0); assert.equal(f.calls.starts.length, 2); assert.deepEqual(counts, [0, 1]);
});

test('configured MODEL_TURN_FAILED with cap zero counts errors without terminating at a threshold', async t => {
  const f = await fixture(t, { realContexts: true, modelFailureRounds: [1, 2], modelFailureCode: 'MODEL_TURN_FAILED', modelFailureStopReason: 'error', turn: async () => 'opaque no candidate' });
  await f.prepareWorker('configured-error-cap-zero', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-error-cap-zero', workerId: 'worker-1', workerPolicy: { maxRounds: 2, roundDelaySeconds: 0, maxConsecutiveFailures: 0 } }, origin);
  await f.dispatch(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'finished'); assert.equal(status.round, 2); assert.equal(status.consecutiveFailures, 2); assert.equal(f.calls.starts.length, 2);
  assert.equal(status.lastRoundOutcome.code, 1);
});

for (const failure of ['MODEL_TURN_FAILED', 'SESSION_BINDING_MISMATCH', 'APP_PERMISSION_DENIED', 'FINAL_ASSISTANT_MISSING']) test(`configured ambiguous or permission failure ${failure} is not a retryable model result`, async t => {
  const f = await fixture(t, { realContexts: true, turn: async () => 'opaque', modelFailureRounds: [1], modelFailureCode: failure,
    ...(failure === 'MODEL_TURN_FAILED' ? { modelFailureTurnEnded: false } : {}),
    modelFailureStopReason: failure === 'FINAL_ASSISTANT_MISSING' ? 'stop' : 'error',
    ...(failure === 'FINAL_ASSISTANT_MISSING' ? { modelFailureSdkError: { kind: 'permission', api: 'sessions.send', code: 'APP_PERMISSION_DENIED' } } : {}) });
  await f.prepareWorker('configured-hard-failure', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-hard-failure', workerId: 'worker-1',
    workerPolicy: { maxRounds: 4, roundDelaySeconds: 0, maxConsecutiveFailures: 0 } }, origin);
  await f.dispatch(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.consecutiveFailures, 0); assert.equal(f.calls.starts.length, 1);
});

test('confirmed model error does not excuse same-handle abort cleanup error with the same code', async t => {
  const f = await fixture(t, { realContexts: true, turn: async () => 'opaque no candidate', modelFailureRounds: [1], modelFailureCode: 'MODEL_TURN_FAILED',
    modelFailureStopReason: 'error', onSessionStop: state => { state.errors = [{ operation: 'abort', code: 'MODEL_TURN_FAILED' }]; } });
  await f.prepareWorker('configured-cleanup-same-code', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-cleanup-same-code', workerId: 'worker-1',
    workerPolicy: { maxRounds: 2, roundDelaySeconds: 0, maxConsecutiveFailures: 0 } }, origin);
  await f.dispatch(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.error.code, 'MODEL_TURN_FAILED');
  assert.equal(status.consecutiveFailures, 0); assert.equal(f.calls.starts.length, 1);
  assert.ok(status.cleanupErrors.some(error => error.code === 'MODEL_TURN_FAILED'));
});

for (const [label, patch] of [
  ['SDK error', { modelFailureSdkError: { kind: 'host', code: 'APP_HOST_ERROR' } }],
  ['send unconfirmed', { modelFailureSendState: 'unconfirmed' }],
  ['cleanup pending', { modelFailureCleanupPending: true }],
  ['permission error', { modelFailureSdkError: { kind: 'permission', code: 'APP_PERMISSION_DENIED' } }],
  ['foreign worker identity', { modelFailureIdentityMismatch: true }],
]) test(`configured confirmed model error negative ${label} cannot start another round`, async t => {
  const f = await fixture(t, { realContexts: true, turn: async () => 'opaque no candidate', modelFailureRounds: [1], modelFailureCode: 'MODEL_TURN_FAILED', modelFailureStopReason: 'error', ...patch });
  const projectId = `configured-negative-${label.toLowerCase().replaceAll(' ', '-')}`;
  await f.prepareWorker(projectId, 'worker-1');
  const job = await f.service.startWorkerRun({ projectId, workerId: 'worker-1', workerPolicy: { maxRounds: 2, roundDelaySeconds: 0, maxConsecutiveFailures: 0 } }, origin);
  await f.dispatch(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.consecutiveFailures, 0); assert.equal(f.calls.starts.length, 1);
  assert.equal(status.sessions[0].error, 'MODEL_TURN_FAILED');
});

test('configured verifier MODEL_TURN_FAILED with worker-shaped fields cannot mint a worker retry proof', async t => {
  const f = await fixture(t, { realContexts: true, verifierModelFailure: true });
  await f.prepareWorker('configured-verifier-error', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-verifier-error', workerId: 'worker-1', workerPolicy: { maxRounds: 2, roundDelaySeconds: 0, maxConsecutiveFailures: 0 } }, origin);
  await f.dispatch(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.consecutiveFailures, 0); assert.equal(f.calls.starts.length, 2);
  assert.equal(status.error.code, 'MODEL_TURN_FAILED');
});

for (const force of [false, true]) test(`configured unlimited worker stop force=${force} respects the active mathematical round`, async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { realContexts: true, turn: async () => { entered.resolve(); await release.promise; return 'opaque no candidate'; } });
  await f.prepareWorker('configured-stop', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-stop', workerId: 'worker-1', workerPolicy: { roundDelaySeconds: 0 } }, origin);
  await f.dispatch(); await entered.promise;
  const stopping = await f.service.stopProjectWorker('configured-stop', job.runId, { force });
  if (!force) { assert.equal(stopping.state, 'running'); assert.equal(stopping.stopping, true); assert.equal(f.calls.lifecycle.includes('session-stop'), false); }
  release.resolve(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'stopped'); assert.equal(status.round, 1); assert.equal(f.calls.starts.length, 1);
});

test('configured timeout resets confirmed MODEL_TURN_FAILED consecutive failures, closes stale credentials and advances only after cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const timed = deferred(), release = deferred(), third = deferred(), releaseThird = deferred();
  t.after(() => { release.resolve(); releaseThird.resolve(); });
  let stale;
  const f = await fixture(t, { realContexts: true, modelFailureRounds: [1, 3], modelFailureCode: 'MODEL_TURN_FAILED', modelFailureStopReason: 'error', turn: async event => {
    if (event.workerIndex === 2) { stale = event; timed.resolve(); await release.promise; }
    if (event.workerIndex === 3) { third.resolve(); await releaseThird.promise; }
    return 'opaque no candidate';
  } });
  await f.prepareWorker('configured-timeout', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-timeout', workerId: 'worker-1',
    workerPolicy: { maxRounds: 4, roundTimeoutSeconds: 1, roundDelaySeconds: 0, maxConsecutiveFailures: 2 } }, origin);
  await f.dispatch(); await timed.promise;
  assert.equal((await f.service.status(job.runId, origin)).consecutiveFailures, 1);
  t.mock.timers.tick(1000);
  const advanced = await Promise.race([third.promise.then(() => ({ advanced: true })), f.wait(job.runId).then(status => ({ status }))]);
  assert.equal(advanced.advanced, true, JSON.stringify(advanced.status));
  const next = await f.service.status(job.runId, origin);
  assert.equal(next.consecutiveFailures, 0); assert.equal(next.lastRoundOutcome.code, 124);
  assert.equal(next.lastRoundOutcome.round, 2); assert.equal(next.deadlineAt, null);
  assert.equal(f.calls.starts[2].deadlineAt, Date.now() + 1000);
  await assert.rejects(stale.invoke('gm_search', {}), { code: 'CALLER_UNBOUND' });
  assert.equal(stale.handle.snapshot().abortOutcome, 'aborted');
  release.resolve(); releaseThird.resolve();
  const status = await f.wait(job.runId); assert.equal(status.state, 'finished'); assert.equal(status.round, 4);
  assert.equal(status.consecutiveFailures, 0); assert.equal(status.cleanupPending, false);
});

test('configured verifier timeout preserves accepted facts and closes both old role credentials', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const verifying = deferred(), nextRound = deferred(), release = deferred(), releaseNext = deferred();
  t.after(() => { release.resolve(); releaseNext.resolve(); });
  let oldWorker, oldVerifier;
  const f = await fixture(t, { realContexts: true, turn: async event => {
    if (event.input.role === 'worker') {
      if (event.workerIndex === 3) { nextRound.resolve(); await releaseNext.promise; }
      else if (event.modelTurn === 1) { if (event.workerIndex === 2) oldWorker = event; await event.invoke('fact_submit', candidate); }
      return 'opaque end of model turn';
    }
    if (event.verifierIndex === 2) { oldVerifier = event; verifying.resolve(); await release.promise; return JSON.stringify(GOOD); }
    await event.invoke('math_verification_report', GOOD); return JSON.stringify(GOOD);
  } });
  await f.prepareWorker('configured-verifier-timeout', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-verifier-timeout', workerId: 'worker-1',
    workerPolicy: { maxRounds: 3, roundTimeoutSeconds: 1, roundDelaySeconds: 0 } }, origin);
  await f.dispatch(); await verifying.promise; t.mock.timers.tick(1000);
  const advanced = await Promise.race([nextRound.promise.then(() => ({ advanced: true })), f.wait(job.runId).then(status => ({ status }))]);
  assert.equal(advanced.advanced, true, JSON.stringify(advanced.status));
  const current = await f.service.status(job.runId, origin);
  assert.deepEqual(current.verifiedFactIds, [fid]); assert.equal(current.lastRoundOutcome.code, 124);
  assert.equal(current.submissions[1].state, 'interrupted');
  await assert.rejects(oldWorker.invoke('fact_submit', candidate), { code: 'CALLER_UNBOUND' });
  await assert.rejects(oldVerifier.invoke('math_verification_report', GOOD), { code: 'CALLER_UNBOUND' });
  assert.equal(oldWorker.handle.snapshot().abortOutcome, 'aborted'); assert.equal(oldVerifier.handle.snapshot().abortOutcome, 'aborted');
  release.resolve(); releaseNext.resolve(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'finished'); assert.deepEqual(status.verifiedFactIds, [fid]);
  assert.equal(f.calls.core.filter(call => call.operation === 'fact_submit').length, 1);
});

test('configured timeout drains an already authorized Core read before admitting another round', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const reading = deferred(), release = deferred(), stopped = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { realContexts: true, onSessionStop: stopped.resolve,
    beforeCore: async ({ operation }) => { if (operation === 'gm_search') { reading.resolve(); await release.promise; } },
    turn: async ({ workerIndex, invoke }) => { if (workerIndex === 1) await invoke('gm_search', { query: 'opaque' }); return 'opaque'; },
  });
  await f.prepareWorker('configured-drain', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-drain', workerId: 'worker-1',
    workerPolicy: { maxRounds: 2, roundTimeoutSeconds: 1, roundDelaySeconds: 0 } }, origin);
  await f.dispatch(); await reading.promise; t.mock.timers.tick(1000); await stopped.promise;
  assert.equal(f.calls.starts.length, 1); assert.equal((await f.service.status(job.runId, origin)).round, 1);
  release.resolve(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'finished'); assert.equal(status.round, 2); assert.equal(f.calls.starts.length, 2);
  assert.equal(status.indeterminate, false); assert.equal(status.cleanupPending, false);
});

for (const code of ['MODEL_TURN_FAILED', 'APP_PERMISSION_DENIED']) test(`configured deadline cannot mask retained helper failure ${code}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { realContexts: true,
    onSessionStop: state => { state.errors = [{ operation: 'operation', code }]; },
    turn: async () => { entered.resolve(); await release.promise; return 'opaque'; },
  });
  await f.prepareWorker('configured-deadline-failure', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-deadline-failure', workerId: 'worker-1',
    workerPolicy: { maxRounds: 2, roundTimeoutSeconds: 1, roundDelaySeconds: 0 } }, origin);
  await f.dispatch(); await entered.promise; t.mock.timers.tick(1000); release.resolve();
  const status = await f.wait(job.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.error.code, code); assert.equal(f.calls.starts.length, 1);
  assert.equal(status.lastRoundOutcome, null); assert.equal(status.consecutiveFailures, 0);
});

test('configured timeout with unconfirmed private-session cleanup cannot start another round', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { realContexts: true, sessionCleanupPending: true,
    turn: async () => { entered.resolve(); await release.promise; return 'opaque'; } });
  await f.prepareWorker('configured-unclean', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-unclean', workerId: 'worker-1',
    workerPolicy: { roundTimeoutSeconds: 1, roundDelaySeconds: 0 } }, origin);
  await f.dispatch(); await entered.promise; t.mock.timers.tick(1000); release.resolve();
  const status = await f.wait(job.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.error.code, 'ROUND_CLEANUP_UNCONFIRMED');
  assert.equal(status.cleanupPending, true); assert.equal(f.calls.starts.length, 1);
});

for (const source of ['ipc', 'core']) test(`configured ${source} capacity is latched even when the worker catches the tool error`, async t => {
  const code = source === 'ipc' ? 'RESEARCH_RUNTIME_CAPACITY' : 'RESEARCH_RUNTIME_REJECTED';
  const error = Object.assign(new Error('opaque capacity fixture'), { code, indeterminate: false, cleanup: { confirmed: true },
    ...(source === 'core' ? { coreError: { code: 'capacity_exceeded', mutationState: 'none' } } : {}) });
  let caught = 0;
  const f = await fixture(t, { realContexts: true, coreError: { operation: 'gm_search', error }, turn: async ({ invoke }) => {
    try { await invoke('gm_search', { query: 'opaque' }); } catch (e) { assert.equal(e, error); caught++; }
    return 'opaque normal model ending after handled tool error';
  } });
  await f.prepareWorker('configured-capacity', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-capacity', workerId: 'worker-1', workerPolicy: { maxRounds: 4, roundDelaySeconds: 0 } }, origin);
  await f.dispatch(); await f.wait(job.runId); const closed = await f.service.dispose();
  const status = closed.runs.find(row => row.runId === job.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.error.code, code); assert.equal(caught, 1);
  assert.equal(status.indeterminate, false); assert.equal(status.cleanupPending, false);
  assert.deepEqual(status.resourceBlocked, { code, coreCode: source === 'core' ? 'capacity_exceeded' : null });
  assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.core.filter(call => call.operation === 'gm_search').length, 1);
  const file = `research/runs/${job.runId}/run.json`, bytes = await f.store.read(file);
  const reopened = await fixture(t, { realContexts: true, tasks: f.tasks, schedules: f.schedules, hostSessions: f.hostSessions }, f.dataDir);
  assert.deepEqual((await reopened.service.projectWorkerStatus('configured-capacity', job.runId)).resourceBlocked, status.resourceBlocked);
  await assert.rejects(reopened.service.startWorkerRun({ projectId: 'configured-capacity', workerId: 'worker-1', workerPolicy: {} }, origin), { code: 'WORKER_BUSY' });
  assert.equal(reopened.calls.starts.length, 0); assert.deepEqual(await f.store.read(file), bytes);
});

test('configured oversized read can be narrowed without a capacity latch or another run', async t => {
  const error = Object.assign(new Error('opaque query response limit'), { code: 'RESEARCH_RUNTIME_REJECTED', coreError: { code: 'size_limit', mutationState: 'none' }, indeterminate: false, cleanup: { confirmed: true } });
  const behavior = { realContexts: true, beforeCore: async ({ args }) => { behavior.coreError = args.query === 'wide' ? { operation: 'gm_search', error } : null; },
    turn: async ({ invoke, workerIndex }) => {
      if (workerIndex === 1) await assert.rejects(invoke('gm_search', { query: 'wide' }), e => e === error);
      assert.deepEqual(await invoke('gm_search', { query: 'narrow' }), { results: [] }); return 'opaque normal end';
    } };
  const f = await fixture(t, behavior); await f.prepareWorker('configured-read-limit', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-read-limit', workerId: 'worker-1', workerPolicy: { maxRounds: 2, roundDelaySeconds: 0 } }, origin);
  await f.dispatch(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'finished'); assert.equal(status.round, 2); assert.equal(status.resourceBlocked, undefined);
  assert.equal(status.indeterminate, false); assert.equal(f.calls.core.filter(call => call.operation === 'gm_search').length, 3);
});

for (const coreCode of ['size_limit', 'capacity_exceeded']) test(`configured post-mutation ${coreCode} keeps the indeterminate fence`, async t => {
  const error = Object.assign(new Error('opaque post-mutation failure'), { code: 'RESEARCH_RUNTIME_REJECTED', coreError: { code: coreCode, mutationState: 'indeterminate' }, indeterminate: true, cleanup: { confirmed: true } });
  const f = await fixture(t, { realContexts: true, coreError: { operation: 'gm_add', error }, turn: async ({ invoke }) => {
    await assert.rejects(invoke('gm_add', { kind: 'observation', claim: 'opaque' }), e => e === error); return 'opaque handled error';
  } });
  await f.prepareWorker('configured-mutation-limit', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-mutation-limit', workerId: 'worker-1', workerPolicy: { maxRounds: 4, roundDelaySeconds: 0 } }, origin);
  await f.dispatch(); await f.wait(job.runId); const closed = await f.service.dispose();
  const status = closed.runs.find(row => row.runId === job.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.indeterminate, true); assert.equal(f.calls.starts.length, 1);
  assert.equal(Boolean(status.resourceBlocked), coreCode === 'capacity_exceeded');
  const meta = await f.store.readJson(`research/runs/${job.runId}/run.json`);
  assert.equal(meta.pendingMutations.length, 1); assert.equal(meta.pendingMutations[0].operation, 'gm_add');
});

test('configured malformed persisted policy is rejected without defaults or journal rewriting', async t => {
  const f = await fixture(t, { realContexts: true, turn: async () => 'opaque no candidate' });
  await f.prepareWorker('configured-damaged', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-damaged', workerId: 'worker-1', workerPolicy: { maxRounds: 1, roundDelaySeconds: 0 } }, origin);
  await f.dispatch(); await f.wait(job.runId); await f.service.dispose();
  const file = `research/runs/${job.runId}/run.json`, damaged = await f.store.readJson(file);
  delete damaged.executionPolicy.workerPolicy.maxRounds;
  await f.store.write(file, JSON.stringify(damaged), true); const bytes = await f.store.read(file);
  const reopened = await fixture(t, { realContexts: true, tasks: f.tasks, schedules: f.schedules, hostSessions: f.hostSessions }, f.dataDir);
  await assert.rejects(reopened.service.projectWorkerStatus('configured-damaged', job.runId), { code: 'RUN_NOT_FOUND' });
  await assert.rejects(reopened.service.startWorkerRun({ projectId: 'configured-damaged', workerId: 'worker-1', workerPolicy: {} }, origin), { code: 'WORKER_BUSY' });
  assert.deepEqual(await f.store.read(file), bytes); assert.equal(reopened.calls.starts.length, 0);
});

test('configured unlimited rounds pass the old third-round boundary until graceful stop', async t => {
  const fifth = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { realContexts: true, turn: async ({ workerIndex }) => {
    if (workerIndex === 5) { fifth.resolve(); await release.promise; } return 'opaque no candidate';
  } });
  await f.prepareWorker('configured-unlimited', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-unlimited', workerId: 'worker-1', workerPolicy: { roundDelaySeconds: 0 } }, origin);
  await f.dispatch(); await fifth.promise;
  const requested = await f.service.stop(job.runId, origin);
  assert.equal(requested.state, 'running'); assert.equal(requested.round, 5); assert.equal(requested.stopRequested, true);
  release.resolve(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'stopped'); assert.equal(f.calls.starts.length, 5);
  assert.equal(new Set(status.sessions.map(row => row.sessionId)).size, 5);
});

test('configured inter-round delay is interrupted without advancing the fake clock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const delay = deferred(), schedule = setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => { const timer = schedule(fn, ms, ...args); if (ms === 5250) delay.resolve(); return timer; });
  const f = await fixture(t, { realContexts: true, turn: async () => 'opaque no candidate' });
  await f.prepareWorker('configured-delay', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-delay', workerId: 'worker-1', workerPolicy: { roundDelaySeconds: 5.25 } }, origin);
  await f.dispatch(); await delay.promise;
  assert.equal((await f.service.status(job.runId, origin)).phase, 'between-rounds');
  assert.equal(f.calls.starts[0].deadlineAt, 2000000000000 + 14400 * 1000);
  await f.service.stopProjectWorker('configured-delay', job.runId); const status = await f.wait(job.runId);
  assert.equal(status.state, 'stopped'); assert.equal(f.calls.starts.length, 1); assert.equal(Date.now(), 2000000000000);
});

for (const control of [false, true]) test(`configured ${control ? 'ten-second control bound' : 'explicit total deadline'} stays separate from four-hour round budget`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { realContexts: true, turn: async () => { entered.resolve(); await release.promise; return 'opaque'; } });
  if (control) { const catalog = f.sdk.models.listAvailable; f.sdk.models.listAvailable = async () => { entered.resolve(); await release.promise; return catalog(); }; }
  await f.prepareWorker('configured-total', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'configured-total', workerId: 'worker-1', workerPolicy: {}, ...(control ? {} : { timeoutSeconds: 60 }) }, origin);
  assert.equal(job.executionPolicy.totalTimeoutSeconds, control ? null : 60);
  await f.dispatch(); await entered.promise;
  if (!control) assert.equal(f.calls.starts[0].deadlineAt, job.deadlineAt);
  t.mock.timers.tick(control ? 10001 : 60000); release.resolve();
  const status = await f.wait(job.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.error.code, control ? 'CONTROL_TIMEOUT' : 'DEADLINE_EXCEEDED');
  assert.equal(f.calls.starts.length, control ? 0 : 1);
});

for (const scenario of ['reject-repair', 'accepted-predecessor']) test(`controlled worker same-round ${scenario} keeps one SID and cold verifiers`, async t => {
  let f; const workerSids = [], prepared = [];
  const behavior = { realContexts: true, contentFacts: true,
    beforeCore: async call => { if (call.operation === 'prepare_submission') prepared.push(structuredClone(call)); },
    turn: async ({ input, invoke, workerIndex, verifierIndex, modelTurn, host }) => {
      if (input.role === 'verifier') {
        assert.equal(input.turnMode, undefined);
        const value = scenario === 'reject-repair' && verifierIndex === 1 ? BAD : GOOD;
        await invoke('math_verification_report', value); return JSON.stringify(value);
      }
      assert.equal(input.turnMode, 'controlled'); assert.equal(input.toolNames.includes('wait_for_tasks'), false);
      if (workerIndex !== 1) return 'opaque later mathematical round without candidate';
      workerSids.push(host.sessionId);
      const runId = input.kind.split(':')[1], meta = await f.store.readJson(`research/runs/${runId}/run.json`);
      assert.equal(meta.round, 1); assert.equal(meta.phase, 'working'); assert.equal(meta.pendingMutations.length, 0);
      if (modelTurn === 1) assert.equal((await invoke('fact_submit', candidate)).pending, true);
      else if (modelTurn === 2) {
        const first = meta.submissions[0];
        assert.equal(first.state, scenario === 'reject-repair' ? 'rejected' : 'accepted');
        assert.ok(input.prompt.includes(scenario === 'reject-repair' ? BAD.repair_hints : first.factId));
        assert.ok(input.prompt.includes(first.submissionId));
        const args = { ...candidate, proof: 'opaque revised fixture proof', predecessors: scenario === 'accepted-predecessor' ? [first.factId] : [] };
        assert.equal((await invoke('fact_submit', args)).pending, true);
      } else {
        assert.equal(modelTurn, 3); assert.equal(meta.submissions[1].state, 'accepted');
        assert.ok(input.prompt.includes(meta.submissions[1].factId));
      }
      return 'opaque model turn complete';
    } };
  f = await fixture(t, behavior); await f.prepareWorker('controlled-project', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'controlled-project', workerId: 'worker-1' }, origin); await f.dispatch();
  const status = await f.waitIdle(job.runId); assert.equal(status.state, 'finished', JSON.stringify(status));
  assert.equal(new Set(workerSids).size, 1); assert.equal(workerSids.length, 3); assert.equal(f.calls.resumes.length, 2);
  const meta = await f.store.readJson(`research/runs/${job.runId}/run.json`);
  assert.equal(meta.round, 3); assert.equal(meta.sessions.filter(s => s.role === 'worker').length, 3);
  assert.equal(new Set(meta.sessions.filter(s => s.role === 'verifier').map(s => s.sessionId)).size, 2);
  assert.equal(meta.submissions.length, 2); assert.notEqual(meta.submissions[0].submissionId, meta.submissions[1].submissionId);
  assert.deepEqual(meta.submissions.map(s => s.workerSessionId), [workerSids[0], workerSids[0]]);
  assert.equal(prepared.length, 2); assert.equal(prepared[0].binding.runId, prepared[1].binding.runId);
  assert.equal(status.verifiedFactIds.length, scenario === 'reject-repair' ? 1 : 2);
  if (scenario === 'accepted-predecessor') assert.deepEqual(prepared[1].args.predecessors, [meta.submissions[0].factId]);
});

test('controlled precheck rejection retries in the same turn while concurrent pending submission stays single-slot', async t => {
  const preparing = deferred(), release = deferred(); let prepareCalls = 0;
  const behavior = { realContexts: true, precheckReject: true,
    beforeCore: async ({ operation }) => { if (operation === 'prepare_submission' && ++prepareCalls === 2) { preparing.resolve(); await release.promise; } },
    turn: async ({ input, invoke, workerIndex, modelTurn }) => {
      if (input.role === 'verifier') { await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD); }
      if (workerIndex === 1 && modelTurn === 1) {
        assert.equal((await invoke('fact_submit', candidate)).precheck.passed, false); behavior.precheckReject = false;
        const pending = invoke('fact_submit', { ...candidate, proof: 'opaque corrected precheck fixture' }); await preparing.promise;
        await assert.rejects(invoke('fact_submit', candidate), { code: 'SUBMISSION_ALREADY_PENDING' }); release.resolve();
        assert.equal((await pending).pending, true);
      }
      return 'opaque completion';
    } };
  t.after(() => release.resolve());
  const f = await fixture(t, behavior); await f.prepareWorker('controlled-precheck', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'controlled-precheck', workerId: 'worker-1' }, origin); await f.dispatch();
  const status = await f.waitIdle(job.runId); assert.equal(status.state, 'finished', JSON.stringify(status));
  assert.equal(prepareCalls, 2); assert.equal(f.calls.resumes.length, 1);
  assert.deepEqual(status.submissionDiagnostics.attempts.map(a => a.outcome), ['precheck-rejected', 'registered', 'slot-rejected']);
});

for (const configured of [false, true]) for (const scenario of ['bad-report', 'unknown-write', 'resume-failure']) test(`controlled ${scenario} configured=${configured} never replays or opens another candidate`, async t => {
  const behavior = { realContexts: true };
  if (scenario === 'bad-report') behavior.finalReport = BAD;
  if (scenario === 'unknown-write') behavior.coreError = { operation: 'fact_submit', error: Object.assign(new Error('opaque uncertain write'), { code: 'RESEARCH_RUNTIME_FAILED', indeterminate: true, cleanup: { confirmed: true } }) };
  if (scenario === 'resume-failure') behavior.resumeError = Object.assign(new Error('opaque send failure'), { code: 'APP_HOST_ERROR' });
  const f = await fixture(t, behavior); await f.prepareWorker('controlled-failure', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'controlled-failure', workerId: 'worker-1',
    ...(configured ? { workerPolicy: { maxRounds: 4, roundDelaySeconds: 0 } } : {}) }, origin); await f.dispatch();
  const status = await f.waitIdle(job.runId); assert.equal(status.state, 'failed');
  assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 1);
  assert.equal(f.calls.core.filter(c => c.operation === 'fact_submit').length, scenario === 'bad-report' ? 0 : 1);
  assert.equal(f.calls.resumes.length, scenario === 'resume-failure' ? 1 : 0);
  assert.equal(f.calls.starts.filter(input => input.role === 'worker').length, 1);
  if (scenario === 'unknown-write') {
    assert.equal(status.indeterminate, true);
    assert.equal((await f.store.readJson(`research/runs/${job.runId}/run.json`)).pendingMutations.length, 1);
  }
  if (scenario === 'resume-failure') assert.deepEqual(status.verifiedFactIds, [fid]);
});

test('controlled no-candidate completion closes tool admission before awaiting helper complete', async t => {
  let checked = 0;
  const f = await fixture(t, { realContexts: true, turn: async () => 'opaque empty mathematical round',
    onComplete: async ({ invoke }) => {
      await assert.rejects(invoke('gm_add', { kind: 'master_guidance', claim: 'opaque late write' }), { code: 'CALLER_UNBOUND' }); checked++;
    } });
  await f.prepareWorker('controlled-complete', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'controlled-complete', workerId: 'worker-1' }, origin); await f.dispatch();
  const status = await f.waitIdle(job.runId); assert.equal(status.state, 'finished', JSON.stringify(status));
  assert.equal(checked, 3); assert.equal(f.calls.core.some(call => call.operation === 'gm_add'), false);
});

test('stop during controlled verification denies worker tools and stops both held handles without resume', async t => {
  const verifying = deferred(), release = deferred(); let workerInvoke;
  const f = await fixture(t, { realContexts: true, turn: async ({ input, invoke }) => {
    if (input.role === 'worker') { workerInvoke = invoke; await invoke('fact_submit', candidate); }
    else { verifying.resolve(); await release.promise; }
    return 'opaque completion';
  } });
  t.after(() => release.resolve()); await f.prepareWorker('controlled-stop', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'controlled-stop', workerId: 'worker-1' }, origin); await f.dispatch(); await verifying.promise;
  await assert.rejects(workerInvoke('gm_search', { query: 'opaque' }), { code: 'CALLER_UNBOUND' });
  const stopped = await f.service.stopProjectWorker('controlled-stop', job.runId); release.resolve();
  assert.equal(stopped.state, 'stopped'); assert.equal(f.calls.resumes.length, 0);
  assert.ok(f.calls.lifecycle.filter(v => v === 'session-stop').length >= 2);
  assert.equal(f.calls.core.some(c => c.operation === 'fact_submit'), false);
});

test('logical worker executes fresh jobs on one assigned workspace without private main stages', async (t) => {
  const projectId = 'project-native', workerId = 'logical-one', seen = new Set();
  const f = await fixture(t, { realContexts: true, runDigests: true, turn: async ({ input, invoke, workerIndex, modelTurn }) => {
    const runId = input.kind.split(':')[1];
    assert.notEqual(input.role, 'main');
    if (input.role === 'worker') {
      assert.equal(input.cwd, f.store.absolute(`context/projects/${projectId}/workers/${workerId}`));
      assert.equal(await fs.readFile(path.join(input.cwd, 'TASK.md'), 'utf8'), 'opaque persistent B\n');
      assert.ok(!input.prompt.includes('opaque persistent B'));
      if (workerIndex === 1 && modelTurn === 1) {
        if (seen.size) assert.equal((await invoke('math_local_memory', { action: 'read' })).text, 'opaque persistent progress');
        else await invoke('math_local_memory', { action: 'append', text: 'opaque persistent progress' });
        const predecessors = seen.size ? [fid] : []; seen.add(runId);
        await invoke('fact_search', { query: 'opaque existing context' });
        const pending = await invoke('fact_submit', { ...candidate, predecessors });
        assert.equal(pending.pending, true);
        assert.equal(f.calls.starts.filter(call => call.role === 'verifier' && call.kind.split(':')[1] === runId).length, 0);
      }
    } else {
      assert.ok(input.cwd.includes(`/research/${runId}/verifiers/`));
      assert.ok(!input.prompt.includes(`/workers/${workerId}/local_memory`));
      const paths = JSON.parse(await fs.readFile(path.join(input.cwd, 'PATHS.json')));
      assert.equal(paths.localMemory, null); assert.deepEqual(Object.keys(paths.shared), ['factGraph']);
      await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD);
    }
    return 'opaque turn complete';
  } });
  await f.prepareWorker(projectId, workerId, 'opaque persistent B');
  const createTask = f.sdk.tasks.create;
  f.sdk.tasks.create = async input => {
    assert.deepEqual(await f.store.readJson(`context/projects/${projectId}/workers/${workerId}/run-ref.json`),
      { schemaVersion: 1, projectId, workerId, runId: input.metadata.researchRunId });
    return createTask(input);
  };
  const completed = [];
  for (let n = 0; n < 2; n++) {
    const job = await f.service.startWorkerRun({ projectId, workerId, timeoutSeconds: 60 }, origin); await f.dispatch();
    const status = await f.waitIdle(job.runId); assert.equal(status.state, 'finished', JSON.stringify(status.error));
    assert.equal(status.mode, 'project-worker'); assert.equal(status.theoremEstablished, false); assert.equal(status.summaryFile, null);
    assert.deepEqual(Object.keys(status.selections).sort(), ['verifier', 'worker']); assert.deepEqual(status.verifiedFactIds, [fid]);
    const meta = await f.store.readJson(`research/runs/${job.runId}/run.json`);
    assert.ok(!meta.assignmentFile); assert.equal(meta.sessions.filter(entry => entry.role === 'main').length, 0);
    for (const entry of meta.sessions) assert.equal(entry.binding.workerId, entry.role === 'worker' ? workerId : undefined);
    await assert.rejects(f.store.read(`research/runs/${job.runId}/assignment.json`), { code: 'ENOENT' });
    assert.deepEqual(await f.service.projectWorkerStatus(projectId, job.runId), status);
    completed.push({ job, meta });
  }
  assert.notEqual(completed[0].job.runId, completed[1].job.runId);
  assert.notEqual(completed[0].job.taskId, completed[1].job.taskId);
  assert.notEqual(completed[0].meta.coreTaskId, completed[1].meta.coreTaskId);
  assert.notEqual(completed[0].meta.submissions[0].reportFile, completed[1].meta.submissions[0].reportFile);
  assert.notEqual(completed[0].meta.submissions[0].submissionId, completed[1].meta.submissions[0].submissionId);
  assert.equal(f.calls.contexts.length, 0); assert.deepEqual(f.calls.profiles, ['worker', 'verifier', 'worker', 'verifier']);
  const submissions = f.calls.core.filter(call => call.operation === 'fact_submit'); assert.equal(submissions.length, 2);
  for (const call of f.calls.core) { assert.equal(call.binding.projectId, projectId); assert.equal(call.binding.workerId, workerId); }
  assert.notEqual(submissions[0].verification.candidateDigest, submissions[1].verification.candidateDigest);
  assert.notEqual(submissions[0].verification.verifierSessionId, submissions[1].verification.verifierSessionId);
  assert.deepEqual(f.calls.cores.map(core => core.options.taskId), completed.map(({ meta }) => meta.coreTaskId));
  for (const { job } of completed) await assert.rejects(f.service.status(job.runId, { ...origin, sessionPath: '/foreign' }), { code: 'OWNER_DENIED' });
});

test('project worker feedback label follows persisted creation mode, never promotes old runs on reload', async t => {
  const projectId = 'project-mode-history', f = await fixture(t, { realContexts: true });
  const jobs = [];
  for (const workerId of ['worker-current', 'worker-old']) {
    await f.prepareWorker(projectId, workerId);
    const job = await f.service.startWorkerRun({ projectId, workerId }, origin);
    assert.equal(job.executionBridge, 'bounded-three-mathematical-rounds-same-session-feedback');
    const file = `research/runs/${job.runId}/run.json`;
    assert.equal((await f.store.readJson(file)).workerFeedbackMode, 'same-session');
    await f.service.stopProjectWorker(projectId, job.runId);
    jobs.push({ job, file });
  }
  await f.service.dispose();
  const old = await f.store.readJson(jobs[1].file);
  delete old.workerFeedbackMode; // Historical terminal record predates controlled feedback.
  await f.store.write(jobs[1].file, JSON.stringify(old), true);
  const before = await Promise.all(jobs.map(({ file }) => f.store.read(file)));
  const reopened = await fixture(t, { realContexts: true, tasks: f.tasks, schedules: f.schedules, hostSessions: f.hostSessions }, f.dataDir);
  const current = await reopened.service.projectWorkerStatus(projectId, jobs[0].job.runId);
  const historical = await reopened.service.projectWorkerStatus(projectId, jobs[1].job.runId);
  assert.equal(current.executionBridge, 'bounded-three-mathematical-rounds-same-session-feedback');
  assert.equal(historical.executionBridge, 'bounded-three-turns-one-pending-per-turn');
  assert.equal(Object.hasOwn(await reopened.store.readJson(jobs[1].file), 'workerFeedbackMode'), false);
  assert.equal(reopened.calls.starts.length, 0); assert.equal(reopened.calls.core.length, 0);
  assert.equal(reopened.calls.schedule.length, 0);
  await reopened.service.dispose();
  for (const [index, { file }] of jobs.entries()) assert.deepEqual(await reopened.store.read(file), before[index]);
});

test('logical worker admission is per key, including pending task creation; internal controls reject legacy and wrong project', async (t) => {
  const gate = deferred(); t.after(() => gate.resolve());
  const f = await fixture(t, { realContexts: true, taskGate: gate });
  await f.prepareWorker('project-native', 'worker-one'); await f.prepareWorker('project-native', 'worker-two');
  const first = f.service.startWorkerRun({ projectId: 'project-native', workerId: 'worker-one' }, origin);
  await f.taskCreated.promise;
  await assert.rejects(f.service.startWorkerRun({ projectId: 'project-native', workerId: 'worker-one' }, origin), { code: 'WORKER_BUSY' });
  const second = f.service.startWorkerRun({ projectId: 'project-native', workerId: 'worker-two' }, origin);
  gate.resolve(); const jobs = await Promise.all([first, second]);
  await assert.rejects(f.service.run({ problem: 'opaque legacy' }, origin), { code: 'RUN_BUSY' });
  await assert.rejects(f.service.projectWorkerStatus('project-other', jobs[0].runId), { code: 'PROJECT_WORKER_MISMATCH' });
  await assert.rejects(f.service.stopProjectWorker('project-other', jobs[0].runId), { code: 'PROJECT_WORKER_MISMATCH' });
  for (const job of jobs) await f.dispatch(f.calls.schedule.find(call => call.payload.runId === job.runId).payload);
  for (const job of jobs) assert.equal((await f.waitIdle(job.runId)).state, 'finished');
  const legacy = await f.service.run({ problem: 'opaque legacy' }, origin); await f.dispatch();
  const legacyStatus = await f.waitIdle(legacy.runId); assert.equal(legacyStatus.state, 'finished');
  assert.equal(Object.hasOwn(await f.store.readJson(`research/runs/${legacy.runId}/run.json`), 'workerFeedbackMode'), false);
  assert.equal(Object.hasOwn(legacyStatus, 'executionBridge'), false);
  await assert.rejects(f.service.projectWorkerStatus(legacyStatus.projectId, legacy.runId), { code: 'PROJECT_WORKER_MISMATCH' });
  await assert.rejects(f.service.stopProjectWorker(legacyStatus.projectId, legacy.runId), { code: 'PROJECT_WORKER_MISMATCH' });
  await assert.rejects(f.service.startWorkerRun({ projectId: legacyStatus.projectId, workerId: 'worker-one' }, origin), { code: 'LEGACY_PROJECT_FORBIDDEN' });
});

test('unknown cleanup blocks only the same logical worker; trusted stop uses no fabricated owner context', async (t) => {
  const behavior = { realContexts: true, coreDisposeError: true };
  const f = await fixture(t, behavior); await f.prepareWorker('project-uncertain', 'worker-one');
  const old = await f.service.startWorkerRun({ projectId: 'project-uncertain', workerId: 'worker-one' }, origin); await f.dispatch();
  const oldStatus = await f.waitIdle(old.runId); assert.equal(oldStatus.runtimeCleanupPending, true);
  await assert.rejects(f.service.startWorkerRun({ projectId: 'project-uncertain', workerId: 'worker-one' }, origin), { code: 'WORKER_BUSY' });
  behavior.coreDisposeError = false;
  await f.prepareWorker('project-independent', 'worker-one');
  const fresh = await f.service.startWorkerRun({ projectId: 'project-independent', workerId: 'worker-one' }, origin);
  const stopped = await f.service.stopProjectWorker('project-independent', fresh.runId); assert.equal(stopped.state, 'stopped');
  assert.equal(f.calls.starts.some(call => call.kind.split(':')[1] === fresh.runId), false);
  assert.equal((await f.service.projectWorkerStatus('project-uncertain', old.runId)).runtimeCleanupPending, true);
});

test('historical legacy cleanup uncertainty does not freeze an independent project worker job', async (t) => {
  const behavior = { realContexts: true, coreDisposeError: true }, f = await fixture(t, behavior);
  const legacy = await f.service.run({ problem: 'opaque old legacy fixture' }, origin); await f.dispatch();
  assert.equal((await f.waitIdle(legacy.runId)).runtimeCleanupPending, true);
  const before = await f.store.read(`research/runs/${legacy.runId}/run.json`);
  behavior.coreDisposeError = false; await f.prepareWorker('project-after-legacy', 'worker-one');
  const job = await f.service.startWorkerRun({ projectId: 'project-after-legacy', workerId: 'worker-one' }, origin); await f.dispatch();
  assert.equal((await f.waitIdle(job.runId)).state, 'finished');
  assert.deepEqual(await f.store.read(`research/runs/${legacy.runId}/run.json`), before);
  assert.ok(f.calls.starts.filter(call => call.kind.split(':')[1] === job.runId).every(call => call.role !== 'main'));
});

for (const damaged of [false, true]) test(`project worker recovery uncertainty remains scoped to its worker (damaged=${damaged})`, async (t) => {
  const f = await fixture(t, { realContexts: true }); await f.prepareWorker('project-recover', 'worker-one');
  const run = await f.service.startWorkerRun({ projectId: 'project-recover', workerId: 'worker-one' }, origin);
  await f.service.stopProjectWorker('project-recover', run.runId); await f.service.dispose();
  const location = `research/runs/${run.runId}/run.json`, meta = await f.store.readJson(location);
  if (damaged) { meta.submissions = null; await f.store.write(location, JSON.stringify(meta), true); }
  const before = await f.store.read(location);
  const g = await fixture(t, { realContexts: true, tasks: f.tasks, schedules: f.schedules, hostSessions: f.hostSessions, taskListError: !damaged }, f.dataDir);
  if (!damaged) assert.equal((await g.service.projectWorkerStatus('project-recover', run.runId)).recoveryUnsettled, true);
  await assert.rejects(g.service.startWorkerRun({ projectId: 'project-recover', workerId: 'worker-one' }, origin), { code: 'WORKER_BUSY' });
  await g.prepareWorker('project-clean', 'worker-one');
  const fresh = await g.service.startWorkerRun({ projectId: 'project-clean', workerId: 'worker-one' }, origin);
  assert.equal((await g.service.stopProjectWorker('project-clean', fresh.runId)).state, 'stopped');
  assert.deepEqual(await g.store.read(location), before);
});

for (const externalStatus of [null, 'completed', 'canceled']) test(`worker snapshot evidence requires real same-run work and a confirmed local terminal receipt (pre-settled=${externalStatus})`, async t => {
  const projectId = 'project-monitor', workerId = 'worker-one';
  const f = await fixture(t, { realContexts:true });
  await f.prepareWorker(projectId,workerId);
  const stopped = await f.service.startWorkerRun({ projectId, workerId },origin);
  assert.deepEqual(f.service.projectWorkerMonitor(projectId,workerId,stopped.runId),{ state:'idle', snapshotUnconfirmed:true });
  await f.service.stopProjectWorker(projectId,stopped.runId);
  assert.deepEqual(f.service.projectWorkerMonitor(projectId,workerId,stopped.runId),{ state:'idle' });
  const run = await f.service.startWorkerRun({ projectId, workerId },origin);
  if (externalStatus) {
    const get = f.sdk.tasks.get;
    f.sdk.tasks.get = async id => {
      const task = await get(id);
      const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`);
      return task?.metadata?.researchRunId === run.runId && task.scope === 'session' && meta.phase === 'finished'
        ? { ...task, status:externalStatus } : task;
    };
  }
  // No monitor/UI polling while the new run is doing its work.
  await f.dispatch();
  assert.equal((await f.waitIdle(run.runId)).state,'finished');
  const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`);
  const observed = f.service.projectWorkerMonitor(projectId,workerId,run.runId);
  if (externalStatus) assert.deepEqual(observed,{ state:'idle', snapshotUnconfirmed:true });
  else {
    assert.ok(Number.isSafeInteger(observed.terminal.startedAt) && observed.terminal.startedAt >= meta.createdAt);
    assert.deepEqual(observed,{ state:'idle', terminal:{ runId:run.runId, startedAt:observed.terminal.startedAt, endedAt:meta.endedAt } });
    await f.service.dispose();
    const reopened = await fixture(t, { realContexts:true, tasks:f.tasks, schedules:f.schedules, hostSessions:f.hostSessions }, f.dataDir);
    assert.deepEqual(reopened.service.projectWorkerMonitor(projectId,workerId,run.runId),{ state:'idle' });
  }
  for (const key of ['monitorStartedAt','monitorEndedAt']) assert.equal(Object.hasOwn(meta,key),false);
});

test('project worker admission rejects forged selectors and requires a real invocation context', async (t) => {
  const f = await fixture(t, { realContexts: true });
  const input = { projectId: 'project-native', workerId: 'worker-one' };
  for (const args of [{ ...input, workerId: '../other' }, { ...input, projectId: '/outside' }, { ...input, role: 'main' },
    { ...input, runId: 'run-reused' }, { ...input, task: 'opaque override' }, { ...input, timeoutSeconds: 59 }, { ...input, timeoutSeconds: 901 }])
    await assert.rejects(f.service.startWorkerRun(args, origin));
  await assert.rejects(f.service.startWorkerRun(input, {}), { code: 'CALLER_UNBOUND' });
  assert.equal(f.calls.taskCreate.length, 0); assert.equal(f.calls.starts.length, 0);
});

async function recheckFixture(t, { completed = false, fenced = true, extra = {}, projectId = 'project-active-recheck', workerId = 'worker-one' } = {}) {
  const f = await fixture(t, { realContexts: true });
  await f.prepareWorker(projectId, workerId);
  const run = await f.service.startWorkerRun({ projectId, workerId }, origin);
  if (completed) { await f.dispatch(); assert.equal((await f.waitIdle(run.runId)).state, 'finished'); }
  else await f.service.stopProjectWorker(projectId, run.runId);
  await f.service.dispose();
  const loc = `research/runs/${run.runId}/run.json`, bytes = await f.store.read(loc);
  const behavior = { realContexts: true, tasks: f.tasks, schedules: f.schedules, hostSessions: f.hostSessions, taskListError: fenced, ...extra };
  // Observe the actual loaded runtime without a production test hook, not a DTO.
  const set = Map.prototype.set; let runtime;
  const capture = t.mock.method(Map.prototype, 'set', function(key, value) {
    if (key === run.runId && value?.meta?.runId === run.runId) runtime = value;
    return set.call(this, key, value);
  });
  let g; try { g = await fixture(t, behavior, f.dataDir); } finally { capture.mock.restore(); }
  assert.ok(runtime); assert.equal(runtime.recoveryUnsettled === true, fenced); behavior.taskListError = false;
  return { g, behavior, r: runtime, ids: { projectId, workerId, runId: run.runId }, loc, bytes };
}
const recheckOptions = { guard: () => {} };
const recheckCounts = g => ({ scheduleRemove: g.calls.unschedule.length, sessionAbort: g.calls.abort.length, taskFail: g.calls.lifecycle.filter(x => x.startsWith('fail:')).length });

for (const fenced of [false, true]) test(`recheck terminal transient fence only; safe DTO, byte-identical journal, no replay (fenced=${fenced})`, async t => {
  const { g, r, ids, loc, bytes } = await recheckFixture(t, { fenced });
  assert.equal(runSettlementState(g.service.projectWorkerDiagnostic(ids.projectId, ids.runId)), fenced ? 'pending' : 'settled');
  const starts = g.calls.starts.length, creates = g.calls.taskCreate.length;
  const dto = await g.service.projectWorkerRecheck(ids, recheckOptions);
  assert.deepEqual(dto, { ...ids, state: fenced ? 'settled' : 'unknown', code: fenced ? 'RECHECK_SETTLED' : 'RECHECK_NOT_NEEDED',
    recoveryUnsettledBefore: fenced, recoveryUnsettledAfter: false, initiated: fenced, joined: false, recheckPending: false,
    mutationAttempts: { scheduleRemove: 0, sessionAbort: 0, taskFail: 0 } });
  assert.equal(runSettlementState(g.service.projectWorkerDiagnostic(ids.projectId, ids.runId)), 'settled');
  assert.equal(r.recoveryCheck ?? null, null); assert.equal(g.calls.starts.length, starts); assert.equal(g.calls.taskCreate.length, creates);
  assert.deepEqual(await g.store.read(loc), bytes); assert.doesNotMatch(JSON.stringify(dto), /sessionPath|callToken|provider|private|statement|proof/);
  const again = await g.service.projectWorkerRecheck(ids, recheckOptions);
  assert.equal(again.code, 'RECHECK_NOT_NEEDED'); assert.equal(again.initiated, false); assert.equal(again.joined, false); assert.equal(again.recheckPending, false);
  assert.deepEqual(again.mutationAttempts, { scheduleRemove: 0, sessionAbort: 0, taskFail: 0 });
});

test('recheck refuses unloaded, mismatched, active and dirty runs before any Host mutation or cleanup slot', async t => {
  const { g, r, ids, loc, bytes } = await recheckFixture(t), before = recheckCounts(g);
  const cases = [
    [{ ...ids, runId: 'run-unloaded' }, null, 'RECHECK_RUN_NOT_LOADED'],
    [{ ...ids, workerId: 'worker-other' }, null, 'RECHECK_RUN_MISMATCH'],
    [{ ...ids, projectId: 'project-other' }, null, 'RECHECK_RUN_MISMATCH'],
    [ids, ['state', 'running'], 'RECHECK_RUN_ACTIVE'],
    ...['cleanupPending', 'indeterminate', 'runtimeCleanupPending', 'taskCreatePending', 'taskSettlementPending', 'coreTaskSettlementPending', 'schedulePending']
      .map(key => [ids, [key, true], 'RECHECK_RUN_DIRTY']),
  ];
  for (const [identity, patch, code] of cases) {
    const old = patch && r.meta[patch[0]]; if (patch) r.meta[patch[0]] = patch[1];
    try { await assert.rejects(g.service.projectWorkerRecheck(identity, recheckOptions), { code }); }
    finally { if (patch) r.meta[patch[0]] = old; }
    assert.equal(r.recoveryCheck, undefined); assert.deepEqual(recheckCounts(g), before); assert.deepEqual(await g.store.read(loc), bytes);
  }
  for (const key of ['all', 'force', 'sessionPath', 'callToken']) await assert.rejects(g.service.projectWorkerRecheck({ ...ids, [key]: true }, recheckOptions), { code: 'INVALID_INPUT' });
  for (const identity of [{ ...ids, [Symbol('extra')]: true }, Object.assign(Object.create({ all: true }), ids),
    Object.defineProperty({ ...ids }, 'runId', { enumerable: true, get() { assert.fail('no identity getter'); } })])
    await assert.rejects(g.service.projectWorkerRecheck(identity, recheckOptions), { code: 'INVALID_INPUT' });
  assert.equal(r.recoveryCheck, undefined);
});

test('recheck shares one job and cumulative mutation attempts; joiner cannot replace the first guard', async t => {
  const { g, r, ids, loc, bytes } = await recheckFixture(t);
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const list = g.sdk.tasks.listSchedules; let listings = 0, valid = true;
  g.sdk.tasks.listSchedules = async () => { listings++; entered.resolve(); await release.promise; return list(); };
  const first = g.service.projectWorkerRecheck(ids, { guard: () => valid }); await entered.promise;
  const job = r.recoveryCheck, second = g.service.projectWorkerRecheck(ids, { guard: () => true });
  assert.equal(r.recoveryCheck, job); valid = false; release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(listings, 1); assert.equal(a.initiated, true); assert.equal(a.joined, false); assert.equal(b.initiated, false); assert.equal(b.joined, true);
  for (const dto of [a, b]) { assert.equal(dto.state, 'unknown'); assert.equal(dto.code, 'RECHECK_GUARD_INVALID'); assert.equal(dto.recoveryUnsettledAfter, true);
    assert.deepEqual(dto.mutationAttempts, { scheduleRemove: 0, sessionAbort: 0, taskFail: 0 }); }
  assert.deepEqual(await g.store.read(loc), bytes);
});

test('recheck joiner-only return guard failure cannot revoke a completed valid shared proof or resurrect warnings', async t => {
  const { g, r, ids, loc, bytes } = await recheckFixture(t), entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const list = g.sdk.tasks.listSchedules; let valid = true;
  g.sdk.tasks.listSchedules = async () => { entered.resolve(); await release.promise; return list(); };
  const first = g.service.projectWorkerRecheck(ids, recheckOptions); await entered.promise;
  const job = r.recoveryCheck.recheck, second = g.service.projectWorkerRecheck(ids, { guard: () => valid }); valid = false; release.resolve();
  const [started, joined] = await Promise.all([first, second]);
  assert.equal(started.state, 'settled'); assert.equal(started.recoveryUnsettledAfter, false);
  assert.equal(joined.state, 'unknown'); assert.equal(joined.code, 'RECHECK_GUARD_INVALID');
  assert.equal(joined.initiated, false); assert.equal(joined.joined, true); assert.equal(joined.recoveryUnsettledAfter, false);
  assert.equal(job.done, true); assert.equal(job.state, 'settled'); assert.equal(job.invalid, false); assert.equal(r.recoveryUnsettled, false);
  assert.equal(g.service.projectWorkerDiagnostic(ids.projectId, ids.runId).recoveryWarnings.some(w => w.error.code === 'RECOVERY_CLEANUP_PENDING'), false);
  assert.deepEqual(await g.store.read(loc), bytes);
});

test('recheck completion barrier seals shared results even if its first guard fails only in a late request tail', async t => {
  const { g, r, ids, loc, bytes } = await recheckFixture(t); let valid = true;
  const request = g.service.projectWorkerRecheck(ids, { guard: () => valid }), checking = r.recoveryCheck, job = checking.recheck;
  // A real Promise completion reaction, before the bounded request tail resumes.
  checking.then(() => { assert.equal(job.done, true); valid = false; });
  const dto = await request;
  assert.equal(dto.state, 'unknown'); assert.equal(dto.code, 'RECHECK_GUARD_INVALID'); assert.equal(dto.recoveryUnsettledAfter, false);
  assert.equal(job.state, 'settled'); assert.equal(job.code, 'RECHECK_SETTLED'); assert.equal(job.invalid, false);
  assert.equal(r.recoveryUnsettled, false);
  assert.equal(g.service.projectWorkerDiagnostic(ids.projectId, ids.runId).recoveryWarnings.some(w => w.error.code === 'RECOVERY_CLEANUP_PENDING'), false);
  assert.deepEqual(await g.store.read(loc), bytes);
});

test('recheck old request DTO belongs to its completed job while the runtime slot holds a real next job', async t => {
  const { g, r, ids, behavior, loc, bytes } = await recheckFixture(t), nextEntered = deferred(), nextRelease = deferred(); t.after(() => nextRelease.resolve());
  const list = g.sdk.tasks.listSchedules; let listings = 0, next;
  behavior.taskListError = true;
  g.sdk.tasks.listSchedules = async () => { if (++listings === 2) { nextEntered.resolve(); await nextRelease.promise; } return list(); };
  const first = g.service.projectWorkerRecheck(ids, recheckOptions), oldChecking = r.recoveryCheck;
  const transition = oldChecking.then(() => {
    assert.equal(oldChecking.recheck.done, true); assert.equal(r.recoveryUnsettled, true);
    behavior.taskListError = false;
    g.schedules.set('next-schedule', { scheduleId: 'next-schedule', pluginId: 'hana-math', scope: 'app', handlerKey: 'math-research-once', payload: { runId: ids.runId } });
    next = g.service.projectWorkerRecheck(ids, recheckOptions);
  });
  await transition; await nextEntered.promise;
  const nextChecking = r.recoveryCheck, dto = await first;
  assert.notEqual(nextChecking, oldChecking); assert.equal(nextChecking.recheck.done, false);
  assert.equal(dto.state, 'unknown'); assert.equal(dto.initiated, true); assert.equal(dto.joined, false); assert.equal(dto.recheckPending, false);
  assert.deepEqual(dto.mutationAttempts, { scheduleRemove: 0, sessionAbort: 0, taskFail: 0 });
  nextRelease.resolve(); const fresh = await next;
  assert.equal(fresh.state, 'settled'); assert.equal(fresh.initiated, true); assert.equal(fresh.joined, false); assert.equal(fresh.recheckPending, false);
  assert.equal(fresh.mutationAttempts.scheduleRemove, 1); assert.equal(dto.mutationAttempts.scheduleRemove, 0);
  assert.deepEqual(await g.store.read(loc), bytes);
});

test('recheck successful singleflight reports actual attempted task/schedule/session mutations, never new starts', async t => {
  const { g, r, ids, loc, bytes } = await recheckFixture(t, { completed: true });
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const list = g.sdk.tasks.listSchedules; let listings = 0;
  g.schedules.set('late-schedule', { scheduleId: 'late-schedule', pluginId: 'hana-math', scope: 'app', handlerKey: 'math-research-once', payload: { runId: ids.runId } });
  g.tasks.get(r.meta.taskId).status = 'pending'; g.tasks.get(r.meta.coreTaskId).status = 'pending';
  g.sdk.tasks.listSchedules = async () => { listings++; entered.resolve(); await release.promise; return list(); };
  const before = recheckCounts(g), first = g.service.projectWorkerRecheck(ids, recheckOptions); await entered.promise;
  const second = g.service.projectWorkerRecheck(ids, recheckOptions); release.resolve();
  const [a, b] = await Promise.all([first, second]); assert.equal(listings, 1);
  assert.equal(a.initiated, true); assert.equal(b.joined, true); assert.equal(b.initiated, false);
  for (const dto of [a, b]) { assert.equal(dto.state, 'settled'); assert.equal(dto.recheckPending, false);
    assert.deepEqual(dto.mutationAttempts, { scheduleRemove: 1, sessionAbort: r.meta.sessions.length, taskFail: 2 }); }
  const after = recheckCounts(g); for (const key of Object.keys(before)) assert.equal(after[key] - before[key], a.mutationAttempts[key]);
  assert.equal(g.calls.starts.length, 0); assert.equal(g.calls.taskCreate.length, 0); assert.deepEqual(await g.store.read(loc), bytes);
});

for (const change of ['meta-identity', 'projectId', 'workerId', 'runId', 'taskId', 'coreTaskId', 'task-owner', 'session-target', 'schedule-target',
  'new-pending', 'new-operation', 'new-read-core', 'new-disposal', 'new-owner', 'dirty'])
  test(`recheck rejects changed ${change} after awaited discovery, keeps fence and stops further Host mutations`, async t => {
    const { g, r, ids, loc, bytes } = await recheckFixture(t, { completed: true });
    const meta = r.meta, original = structuredClone(meta), entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const list = g.sdk.tasks.listSchedules, before = recheckCounts(g);
    g.sdk.tasks.listSchedules = async () => { entered.resolve(); await release.promise; return list(); };
    const pending = g.service.projectWorkerRecheck(ids, recheckOptions); await entered.promise;
    if (change === 'meta-identity') r.meta = structuredClone(meta);
    else if (change === 'task-owner') meta.owner.sessionPath = '/fixture/changed-owner.jsonl';
    else if (change === 'session-target') meta.sessions[0].sessionId = 'different-session';
    else if (change === 'schedule-target') meta.scheduleIds.push('different-schedule');
    else if (change.startsWith('new-')) r[({ 'new-pending': 'pending', 'new-operation': 'operations', 'new-read-core': 'readCores', 'new-disposal': 'runtimeDisposals', 'new-owner': 'runtimeCleanupOwners' })[change]].add({});
    else if (change === 'dirty') meta.indeterminate = true;
    else meta[change] = 'different-target';
    release.resolve();
    try {
      const dto = await pending; assert.equal(dto.state, 'unknown'); assert.equal(dto.code, 'RECHECK_GUARD_INVALID'); assert.equal(dto.recoveryUnsettledAfter, true);
      assert.deepEqual(recheckCounts(g), before); assert.deepEqual(await g.store.read(loc), bytes);
    } finally { r.meta = meta; Object.assign(meta, original); for (const key of ['pending', 'operations', 'readCores', 'runtimeDisposals', 'runtimeCleanupOwners']) r[key].clear(); }
  });

for (const owner of ['pending', 'operations', 'readCores', 'runtimeDisposals', 'runtimeCleanupOwners'])
  test(`recheck cannot discharge a preexisting ${owner} owner; recheckPending is not recoveryUnsettled`, async t => {
    const { g, r, ids, loc, bytes } = await recheckFixture(t); const marker = {}; r[owner].add(marker);
    try {
      const dto = await g.service.projectWorkerRecheck(ids, recheckOptions);
      assert.equal(dto.state, 'pending'); assert.equal(dto.recoveryUnsettledAfter, true); assert.equal(dto.initiated, true);
      assert.equal(dto.recheckPending, false); assert.deepEqual(dto.mutationAttempts, { scheduleRemove: 0, sessionAbort: 0, taskFail: 0 });
      assert.deepEqual(await g.store.read(loc), bytes);
    } finally { r[owner].delete(marker); }
  });

test('recheck counts an already-issued abort but invalidation prevents subsequent aborts/task failures and fence clear', async t => {
  const { g, ids, loc, bytes } = await recheckFixture(t, { completed: true }); let valid = true;
  const abort = g.sdk.sessions.abort, before = recheckCounts(g);
  g.sdk.sessions.abort = async input => { const receipt = await abort(input); valid = false; return receipt; };
  const dto = await g.service.projectWorkerRecheck(ids, { guard: () => valid });
  assert.equal(dto.state, 'unknown'); assert.equal(dto.recoveryUnsettledAfter, true);
  assert.deepEqual(dto.mutationAttempts, { scheduleRemove: 0, sessionAbort: 1, taskFail: 0 });
  assert.equal(g.calls.abort.length - before.sessionAbort, 1); assert.deepEqual(await g.store.read(loc), bytes);
});

test('recheck failed Host mutation is counted as an attempt, not claimed as success', async t => {
  const { g, r, ids, behavior, loc, bytes } = await recheckFixture(t, { completed: true });
  g.tasks.get(r.meta.coreTaskId).status = 'pending'; behavior.coreTaskFailError = new Error('opaque private provider/body/path');
  const dto = await g.service.projectWorkerRecheck(ids, recheckOptions);
  assert.equal(dto.state, 'unknown'); assert.equal(dto.code, 'RECHECK_UNCONFIRMED'); assert.equal(dto.recoveryUnsettledAfter, true);
  assert.equal(dto.mutationAttempts.taskFail, 1); assert.equal(dto.recheckPending, false);
  assert.doesNotMatch(JSON.stringify(dto), /opaque|private|provider|body|path/); assert.deepEqual(await g.store.read(loc), bytes);
});

for (const boundary of ['session-get', 'core-task-get']) test(`recheck checks the original resource targets after nested ${boundary} read, before mutation`, async t => {
  const { g, r, ids, loc, bytes } = await recheckFixture(t, { completed: true }), original = structuredClone(r.meta);
  if (boundary === 'session-get') {
    const get = g.sdk.sessions.get;
    g.sdk.sessions.get = async ref => { const value = await get(ref); r.meta.sessions[0].sessionId = 'changed-target'; return value; };
  } else {
    g.tasks.get(r.meta.coreTaskId).status = 'pending'; const get = g.sdk.tasks.get;
    g.sdk.tasks.get = async id => { const value = await get(id); if (id === r.meta.coreTaskId) r.meta.coreTaskId = 'task-changed-target'; return value; };
  }
  try {
    const dto = await g.service.projectWorkerRecheck(ids, recheckOptions);
    assert.equal(dto.code, 'RECHECK_GUARD_INVALID'); assert.equal(dto.recoveryUnsettledAfter, true); assert.equal(dto.mutationAttempts.taskFail, 0);
    if (boundary === 'session-get') assert.equal(dto.mutationAttempts.sessionAbort, 0);
    assert.deepEqual(await g.store.read(loc), bytes);
  } finally { Object.assign(r.meta, original); }
});

test('recheck through real Project/Research improves doctor and scoped workerStop projection without changing Goal/gen/budget/restart markers', async t => {
  const pf = await projectFixture(t), p = await pf.create();
  const { g, ids, loc, bytes } = await recheckFixture(t, { projectId: p.projectId, workerId: 'worker-1' });
  // Bind a historical run in the software Project fixture. No Host resources or
  // mathematical evidence are fabricated; the cleanup/diagnostic service is real.
  const parse = JSON.parse; let record;
  const capture = t.mock.method(JSON, 'parse', (...args) => { const value = parse(...args);
    if (value?.projectId === p.projectId && value.creator && value.worker?.runs) record = value; return value; });
  try { await pf.open(); } finally { capture.mock.restore(); } assert.ok(record);
  record.worker.runs = [ids.runId]; record.worker.lastRun = ids.runId; record.worker.start = { state: 'settled', runId: ids.runId };
  pf.jobs.set(ids.runId, await g.service.projectWorkerStatus(ids.projectId, ids.runId));
  pf.research.projectWorkerDiagnostic = g.service.projectWorkerDiagnostic;
  pf.research.projectWorkerRecheck = g.service.projectWorkerRecheck;
  await pf.service.goal('start', { projectId: p.projectId, authorized: true, maxAutomaticContinues: 1 }, projectOrigin);
  for (let n = 0; n < 8; n++) await tick();
  const stopped = await pf.service.goal('stop', { projectId: p.projectId }, projectOrigin);
  assert.equal(stopped.workerStop.state, 'requested'); assert.equal(stopped.workerStop.cleanupPending, true);
  assert.equal(stopped.workerStopReconciliation.state, 'pending');
  const beforeDoctor = await pf.service.doctor({ projectId: p.projectId }, p.context);
  assert.equal(beforeDoctor.runs.find(row => row.runId === ids.runId).recoveryUnsettled, true);
  assert.equal(beforeDoctor.goal.workerStopReconciliation.state, 'pending');
  const goalFile = path.join(pf.dataDir, 'research/main-controls', `${p.projectId}.json`);
  const goalBytes = await fs.readFile(goalFile);
  const projectFile = path.join(pf.dataDir, 'research/projects', p.projectId, 'project.json'), projectBytes = await fs.readFile(projectFile);
  const beforeCalls = Object.fromEntries(Object.entries(pf.calls).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
  const dto = await pf.service.recheck(ids, projectOrigin); assert.equal(dto.state, 'settled');
  const current = await pf.service.goal('status', { projectId: p.projectId }, projectOrigin), afterDoctor = await pf.service.doctor({ projectId: p.projectId }, p.context);
  assert.equal(current.workerStopReconciliation.state, 'settled'); assert.equal(afterDoctor.goal.workerStopReconciliation.state, 'settled');
  assert.equal(afterDoctor.runs.find(row => row.runId === ids.runId).recoveryUnsettled, false);
  assert.deepEqual(current.workerStop, stopped.workerStop); assert.deepEqual(current.workerStopScope, stopped.workerStopScope);
  assert.equal(current.generation, stopped.generation); assert.deepEqual(current.continuationBudget, stopped.continuationBudget);
  assert.deepEqual(await fs.readFile(goalFile), goalBytes); assert.deepEqual(await fs.readFile(projectFile), projectBytes); assert.deepEqual(await g.store.read(loc), bytes);
  for (const key of ['tasks', 'schedules', 'unschedules', 'sessions', 'sends', 'starts', 'stops', 'core', 'factories']) assert.equal(pf.calls[key].length, beforeCalls[key], key);
  assert.equal(g.calls.starts.length, 0); assert.equal(g.calls.taskCreate.length, 0);
});

test('recheck extraction preserves legacy trusted stop cleanup after Research disposal, while new entry refuses', async t => {
  const { g, ids, loc, bytes } = await recheckFixture(t); await g.service.dispose();
  await assert.rejects(g.service.projectWorkerRecheck(ids, recheckOptions), { code: 'RESEARCH_DISPOSED' });
  const stopped = await g.service.stopProjectWorker(ids.projectId, ids.runId);
  assert.equal(stopped.recoveryUnsettled, false); assert.deepEqual(await g.store.read(loc), bytes);
});

test('recheck joiner refuses Research disposal during a legacy-owned shared job without replacing its first guard', async t => {
  const { g, ids, loc, bytes } = await recheckFixture(t), entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const list = g.sdk.tasks.listSchedules;
  g.sdk.tasks.listSchedules = async () => { entered.resolve(); await release.promise; return list(); };
  const old = g.service.stopProjectWorker(ids.projectId, ids.runId); await entered.promise;
  const joining = g.service.projectWorkerRecheck(ids, recheckOptions); await g.service.dispose(); release.resolve();
  const [legacy, dto] = await Promise.all([old, joining]);
  assert.equal(legacy.recoveryUnsettled, false);
  assert.equal(dto.initiated, false); assert.equal(dto.joined, true); assert.equal(dto.state, 'unknown'); assert.equal(dto.code, 'RECHECK_GUARD_INVALID');
  assert.equal(dto.recoveryUnsettledAfter, false);
  assert.equal(g.service.projectWorkerDiagnostic(ids.projectId, ids.runId).recoveryWarnings.some(w => w.error.code === 'RECOVERY_CLEANUP_PENDING'), false);
  assert.deepEqual(await g.store.read(loc), bytes);
});

test('recheck cumulative budget timeout leaves the same job running to later strict success and no-fence no-op', async t => {
  const { g, r, ids, loc, bytes } = await recheckFixture(t), schedulesEntered = deferred(), tasksEntered = deferred();
  const schedules = g.sdk.tasks.listSchedules, tasks = g.sdk.tasks.list; let listings = 0;
  g.sdk.tasks.listSchedules = async () => { listings++; schedulesEntered.resolve(); await new Promise(resolve => setTimeout(resolve, 6000)); return schedules(); };
  g.sdk.tasks.list = async () => { tasksEntered.resolve(); await new Promise(resolve => setTimeout(resolve, 6000)); return tasks(); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const first = g.service.projectWorkerRecheck(ids, recheckOptions); await schedulesEntered.promise; const checking = r.recoveryCheck;
    t.mock.timers.tick(6000); await tasksEntered.promise;
    t.mock.timers.tick(4000); const dto = await first;
    assert.equal(dto.code, 'RECHECK_TIMEOUT'); assert.equal(dto.state, 'unknown'); assert.equal(dto.recheckPending, true); assert.equal(dto.recoveryUnsettledAfter, true);
    assert.equal(r.recoveryCheck, checking); assert.equal(checking.recheck.done, false); assert.equal(listings, 1);
    t.mock.timers.tick(2000); await checking;
    assert.equal(checking.recheck.done, true); assert.equal(checking.recheck.state, 'settled'); assert.equal(r.recoveryUnsettled, false); assert.equal(r.recoveryCheck, null);
    const before = recheckCounts(g), noop = await g.service.projectWorkerRecheck(ids, recheckOptions);
    assert.equal(noop.code, 'RECHECK_NOT_NEEDED'); assert.equal(noop.recheckPending, false); assert.equal(noop.recoveryUnsettledAfter, false);
    assert.equal(noop.initiated, false); assert.equal(noop.joined, false);
    assert.deepEqual(noop.mutationAttempts, { scheduleRemove: 0, sessionAbort: 0, taskFail: 0 }); assert.deepEqual(recheckCounts(g), before);
    assert.equal(listings, 1); assert.deepEqual(await g.store.read(loc), bytes);
  } finally { t.mock.timers.reset(); }
});

test('recheck legacy stop tolerates a real result reader releasing during discovery; a subsequent recheck succeeds', async t => {
  const readEntered = deferred(), readRelease = deferred(), discoveryEntered = deferred(), discoveryRelease = deferred();
  t.after(() => { readRelease.resolve(); discoveryRelease.resolve(); });
  const { g, r, ids, loc } = await recheckFixture(t, { projectId: 'fixture-project', extra: {
    beforeCore: async ({ operation }) => { if (operation === 'fact_list_page') { readEntered.resolve(); await readRelease.promise; } },
  } });
  const reading = g.service.result(ids.runId, undefined, origin); await readEntered.promise; assert.ok(r.readCores.size > 0);
  const list = g.sdk.tasks.listSchedules;
  g.sdk.tasks.listSchedules = async () => { discoveryEntered.resolve(); await discoveryRelease.promise; return list(); };
  const stopping = g.service.stopProjectWorker(ids.projectId, ids.runId); await discoveryEntered.promise;
  readRelease.resolve(); await reading; assert.equal(r.readCores.size, 0); const bytes = await g.store.read(loc);
  discoveryRelease.resolve(); const stopped = await stopping; assert.equal(stopped.recoveryUnsettled, true);
  const dto = await g.service.projectWorkerRecheck(ids, recheckOptions); assert.equal(dto.state, 'settled'); assert.equal(dto.recoveryUnsettledAfter, false);
  assert.deepEqual(await g.store.read(loc), bytes);
});

test('recheck timeout retains the original in-flight promise; later request joins without a second job', async t => {
  const { g, r, ids, loc, bytes } = await recheckFixture(t);
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const list = g.sdk.tasks.listSchedules; let listings = 0;
  g.sdk.tasks.listSchedules = async () => { listings++; entered.resolve(); await release.promise; return list(); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const first = g.service.projectWorkerRecheck(ids, recheckOptions); await entered.promise; const job = r.recoveryCheck;
    t.mock.timers.tick(10000); const timed = await first;
    assert.equal(timed.code, 'RECHECK_TIMEOUT'); assert.equal(timed.state, 'unknown'); assert.equal(timed.recheckPending, true); assert.equal(timed.recoveryUnsettledAfter, true);
    const second = g.service.projectWorkerRecheck(ids, recheckOptions); assert.equal(r.recoveryCheck, job); assert.equal(listings, 1);
    release.resolve(); const joined = await second;
    assert.equal(joined.initiated, false); assert.equal(joined.joined, true); assert.equal(joined.state, 'unknown'); assert.equal(joined.recoveryUnsettledAfter, true);
    assert.equal(joined.recheckPending, false); assert.equal(listings, 1); assert.deepEqual(await g.store.read(loc), bytes);
  } finally { release.resolve(); t.mock.timers.reset(); }
});

for (const uncertain of [false, true]) test(`explicit project stop rechecks transient recovery only (real uncertainty=${uncertain})`, async (t) => {
  const projectId = 'project-recheck', workerId = 'worker-one', f = await fixture(t, { realContexts: true });
  await f.prepareWorker(projectId, workerId);
  const run = await f.service.startWorkerRun({ projectId, workerId }, origin);
  await f.service.stopProjectWorker(projectId, run.runId); await f.service.dispose();
  const loc = `research/runs/${run.runId}/run.json`;
  if (uncertain) { const meta = await f.store.readJson(loc); meta.indeterminate = true; meta.pendingMutations = [{ callTag: 'opaque-unsettled-mutation' }]; await f.store.write(loc, JSON.stringify(meta), true); }
  const before = await f.store.read(loc);
  const behavior = { realContexts: true, tasks: f.tasks, schedules: f.schedules, hostSessions: f.hostSessions, taskListError: true };
  const g = await fixture(t, behavior, f.dataDir);
  assert.equal((await g.service.projectWorkerStatus(projectId, run.runId)).recoveryUnsettled, true);
  await g.service.stopProjectWorker(projectId, run.runId);
  assert.equal((await g.service.projectWorkerStatus(projectId, run.runId)).recoveryUnsettled, true);
  behavior.taskListError = false;
  await assert.rejects(g.service.startWorkerRun({ projectId, workerId }, origin), { code: 'WORKER_BUSY' });
  const status = await g.service.stopProjectWorker(projectId, run.runId);
  assert.equal(status.recoveryUnsettled, uncertain); assert.equal(status.indeterminate, uncertain);
  assert.equal(status.recoveryWarnings.some(w => w.runId === run.runId && w.error.code === 'RECOVERY_CLEANUP_PENDING'), uncertain);
  assert.deepEqual(await g.store.read(loc), before);
  if (uncertain) await assert.rejects(g.service.startWorkerRun({ projectId, workerId }, origin), { code: 'WORKER_BUSY' });
  else {
    const next = await g.service.startWorkerRun({ projectId, workerId }, origin);
    assert.notEqual(next.runId, run.runId); await g.service.stopProjectWorker(projectId, next.runId);
    assert.deepEqual(await g.store.read(loc), before);
  }
});

test('explicit recovery recheck cannot clear while a current result reader still owns resources', async (t) => {
  const projectId = 'fixture-project', workerId = 'worker-one', f = await fixture(t, { realContexts: true });
  await f.prepareWorker(projectId, workerId);
  const run = await f.service.startWorkerRun({ projectId, workerId }, origin);
  await f.service.stopProjectWorker(projectId, run.runId); await f.service.dispose();
  const entered = deferred(), gate = deferred(); t.after(() => gate.resolve());
  const behavior = { realContexts: true, tasks: f.tasks, schedules: f.schedules, hostSessions: f.hostSessions, taskListError: true,
    beforeCore: async ({ operation }) => { if (operation === 'fact_list_page') { entered.resolve(); await gate.promise; } } };
  const g = await fixture(t, behavior, f.dataDir); behavior.taskListError = false;
  const reading = g.service.result(run.runId, undefined, origin); await entered.promise;
  const loc = `research/runs/${run.runId}/run.json`, before = await g.store.read(loc);
  try { assert.equal((await g.service.stopProjectWorker(projectId, run.runId)).recoveryUnsettled, true); assert.deepEqual(await g.store.read(loc), before); }
  finally { gate.resolve(); }
  await reading;
  const afterRead = await g.store.read(loc);
  assert.equal((await g.service.stopProjectWorker(projectId, run.runId)).recoveryUnsettled, false);
  assert.deepEqual(await g.store.read(loc), afterRead);
});

test('durable worker reference blocks bad JSON when host session discovery also fails, without a global block', async (t) => {
  const projectId = 'project-ref', workerId = 'worker-one', f = await fixture(t, { realContexts: true });
  await f.prepareWorker(projectId, workerId);
  const run = await f.service.startWorkerRun({ projectId, workerId }, origin); await f.dispatch();
  assert.equal((await f.waitIdle(run.runId)).state, 'finished'); await f.service.dispose();
  const refFile = `context/projects/${projectId}/workers/${workerId}/run-ref.json`;
  assert.deepEqual(await f.store.readJson(refFile), { schemaVersion: 1, projectId, workerId, runId: run.runId });
  const loc = `research/runs/${run.runId}/run.json`; await f.store.write(loc, '{opaque bad JSON', true);
  const g = await fixture(t, { realContexts: true, tasks: f.tasks, schedules: f.schedules, hostSessions: f.hostSessions, recoveryListError: true }, f.dataDir);
  await assert.rejects(g.service.startWorkerRun({ projectId, workerId }, origin), SyntaxError);
  assert.equal(g.calls.taskCreate.length, 0); assert.equal(g.calls.starts.length, 0);
  assert.equal((await g.store.read(loc)).toString(), '{opaque bad JSON');
  assert.equal((await g.store.readJson(refFile)).runId, run.runId);
  for (const [project, worker] of [[projectId, 'worker-two'], ['project-ref-independent', 'worker-one']]) {
    await g.prepareWorker(project, worker);
    const next = await g.service.startWorkerRun({ projectId: project, workerId: worker }, origin);
    assert.equal((await g.service.stopProjectWorker(project, next.runId)).state, 'stopped');
  }
});

for (const mismatch of ['missing-target', 'wrong-project', 'wrong-worker', 'wrong-mode', 'extra-field']) test(`worker run reference rejects ${mismatch} before external work`, async (t) => {
  const f = await fixture(t, { realContexts: true }), projectId = 'project-invalid-ref', workerId = 'worker-one';
  await f.prepareWorker(projectId, workerId);
  const old = await f.service.startWorkerRun({ projectId, workerId }, origin); await f.service.stopProjectWorker(projectId, old.runId);
  const refFile = `context/projects/${projectId}/workers/${workerId}/run-ref.json`, ref = await f.store.readJson(refFile);
  if (mismatch === 'missing-target') ref.runId = 'run-absent';
  else if (mismatch === 'wrong-project') ref.projectId = 'project-other';
  else if (mismatch === 'extra-field') ref.state = 'finished';
  else { const loc = `research/runs/${old.runId}/run.json`, meta = await f.store.readJson(loc);
    if (mismatch === 'wrong-worker') meta.workerId = 'worker-other'; else delete meta.mode;
    await f.store.write(loc, JSON.stringify(meta), true);
  }
  await f.store.write(refFile, JSON.stringify(ref), true);
  const tasks = f.calls.taskCreate.length;
  await assert.rejects(f.service.startWorkerRun({ projectId, workerId }, origin));
  assert.equal(f.calls.taskCreate.length, tasks); assert.equal(f.calls.starts.length, 0);
  assert.deepEqual(await f.store.readJson(refFile), ref);
});

test('worker reference atomic write failure cannot start a root task, Core task, schedule or session', async (t) => {
  const f = await fixture(t, { realContexts: true }), projectId = 'project-ref-write', workerId = 'worker-one';
  await f.prepareWorker(projectId, workerId);
  const destination = f.store.absolute(`context/projects/${projectId}/workers/${workerId}/run-ref.json`), rename = fs.rename;
  let injected = 0;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === destination) { injected++; throw Object.assign(new Error('opaque ref write failure'), { code: 'EIO' }); }
    return rename(from, to);
  });
  syncBuiltinESMExports(); const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); }; t.after(restore);
  await assert.rejects(f.service.startWorkerRun({ projectId, workerId }, origin), { code: 'EIO' }); restore();
  assert.equal(injected, 1); assert.equal(f.calls.taskCreate.length, 0); assert.equal(f.calls.schedule.length, 0); assert.equal(f.calls.starts.length, 0);
  await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
});

test('queued source task, one-shot App dispatcher, saved roles and real accepted graph', async (t) => {
  let pendingSeen = false;
  const f = await fixture(t, { onPending(value, calls) { assert.equal(value.pending, true); assert.equal(calls.starts.filter((s) => s.role === 'verifier').length, 0); pendingSeen = true; } });
  const queued = await f.service.run({ problem: 'fixture problem' }, origin);
  assert.equal(queued.state, 'queued'); assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.profiles.length, 0);
  assert.equal(f.calls.taskCreate[0].callToken, origin.callToken); assert.equal(f.calls.taskCreate[0].delivery, 'next-step');
  assert.equal(f.calls.schedule[0].scope, 'app'); assert.equal(f.calls.schedule[0].callToken, undefined);
  const launch = await f.dispatch(); assert.equal(launch.status, 'started');
  const result = await f.wait(queued.runId);
  assert.equal(result.state, 'finished', JSON.stringify(result.error)); assert.equal(result.theoremEstablished, false); assert.deepEqual(result.verifiedFactIds, [fid]); assert.ok(pendingSeen);
  assert.deepEqual(f.calls.profiles, ['main', 'worker', 'verifier']);
  for (const start of f.calls.starts) { assert.equal(start.selection.agentId, `saved-${start.role}`); assert.equal(start.selection.model.id, `${start.role}-model`); assert.ok(!start.toolNames.includes('exec')); assert.ok(!start.toolNames.includes('write')); }
  assert.equal(f.calls.workspaces.filter((w) => w.role === 'worker').length, 1);
  const workers = f.calls.starts.filter((s) => s.role === 'worker'); assert.equal(workers.length, 3); assert.ok(workers.every(worker => worker.cwd === workers[0].cwd));
  assert.ok(f.calls.cores[0].disposed); assert.ok(f.calls.unschedule.length);
  assert.equal((await f.dispatch()).status, 'ignored');
  const metadata = await f.store.readJson(`research/runs/${queued.runId}/run.json`);
  assert.equal(metadata.owner.sessionId, 'owner-stable-id'); assert.ok(!JSON.stringify(metadata).includes(origin.callToken)); assert.ok(!JSON.stringify(metadata).includes(candidate.proof));
  assert.equal(metadata.submissions.length, 1); assert.ok(metadata.submissions[0].candidateFile); assert.ok(metadata.submissions[0].reportFile);
  assert.equal(result.delivery.delivered, false);
  const full = await f.service.result(queued.runId, fid, origin);
  assert.deepEqual(full, { runId: queued.runId, projectId: 'fixture-project', fact: { fact_id: fid, markdown: '---\nfact_id: ' + fid + '\n---\nFull fixture Markdown\n', predecessors: [] } });
  assert.equal(f.calls.cores.length, 2); assert.ok(f.calls.cores[1].disposed);
  assert.deepEqual(await f.service.result(queued.runId, undefined, origin), { runId: queued.runId, projectId: 'fixture-project', ...fixtureFactPage([full.fact]) });
  assert.equal(f.calls.cores.length, 3); assert.ok(f.calls.cores[2].disposed);
  assert.equal(f.calls.core.at(-1).operation, 'fact_list_page');
});

test('generated bounded-run prompts and defaults are English; supplied input stays verbatim', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'opaque software fixture' }, origin);
  await f.dispatch(); await f.wait(run.runId); await f.service.stop(run.runId, origin);
  for (const input of f.calls.starts) {
    assert.doesNotMatch(input.prompt, /\p{Script=Han}/u);
    assert.match(input.prompt, /Hana bounded-run adapter \(not the original Danus contract\)/);
    assert.ok(input.prompt.split('\n')[0].length < 200);
    assert.match(input.prompt, /Mathematics is text-only/);
    assert.doesNotMatch(input.prompt, /you are the user-saved Math role instance|Only actual accepted entries in the shared fact graph|You are the independent verifier for this candidate/);
  }
  assert.doesNotMatch(f.calls.contexts[0].operatorProfile + f.calls.contexts[0].workerTask, /\p{Script=Han}/u);
  assert.ok(f.calls.starts.some((s) => s.role === 'verifier'));
  const g = await fixture(t);
  const supplied = { problem: '用户题面原文', operatorProfile: '用户说明原文', workerTask: '用户任务原文' };
  const other = await g.service.run(supplied, origin); await g.dispatch(); await g.wait(other.runId); await g.service.stop(other.runId, origin);
  assert.deepEqual(g.calls.contexts[0], supplied);
});

test('terminal unknown and pending mutation stay byte-exact while a fresh UUID project completes independently', async (t) => {
  const behavior = { realContexts: true, coreDisposeError: true, coreError: { operation: 'fact_submit', error: Object.assign(new Error('opaque failure'), {
    code: 'RESEARCH_RUNTIME_FAILED', phase: 'start', requestId: '12345678-1234-1234-1234-123456789abc', startOutcome: 'unknown', indeterminate: true, cleanup: { confirmed: false, errors: [] },
  }) } };
  const f = await fixture(t, behavior);
  const old = await f.service.run({ problem: 'opaque old project' }, origin); await f.dispatch(); await f.wait(old.runId); await f.waitIdle(old.runId);
  const before = await f.store.read(`research/runs/${old.runId}/run.json`), oldMeta = JSON.parse(before);
  assert.equal(oldMeta.runtimeCleanupPending, true); assert.equal(oldMeta.indeterminate, true); assert.equal(oldMeta.pendingMutations.length, 1);
  const oldActor = (await f.sessionStarted.promise).caller;
  behavior.coreError = null; behavior.coreDisposeError = false;
  const fresh = await f.service.run({ problem: 'opaque new project' }, origin);
  await assert.rejects(f.service.run({ problem: 'concurrent admission' }, origin), { code: 'RUN_BUSY' });
  await f.dispatch(); const completed = await f.waitIdle(fresh.runId);
  assert.equal(completed.state, 'finished'); assert.deepEqual(completed.verifiedFactIds, [fid]);
  assert.match(completed.projectId, /^project-[a-f0-9-]{36}$/); assert.notEqual(completed.projectId, oldMeta.projectId);
  assert.notEqual(fresh.runId, old.runId); assert.equal(f.calls.contexts.every(c => !Object.hasOwn(c, 'projectId')), true);
  const newMeta = await f.store.readJson(`research/runs/${fresh.runId}/run.json`);
  assert.deepEqual(newMeta.pendingMutations, []); assert.equal(newMeta.indeterminate, false); assert.equal(newMeta.runtimeCleanupPending, false);
  for (const session of newMeta.sessions) {
    assert.ok(session.cwd.includes(`/context/projects/${completed.projectId}/research/${fresh.runId}/`));
    assert.ok(!oldMeta.sessions.some(s => s.cwd === session.cwd));
  }
  const paths = JSON.parse(await fs.readFile(path.join(newMeta.sessions[0].cwd, 'PATHS.json')));
  assert.ok(paths.shared.root.endsWith(`/context/projects/${completed.projectId}/shared`));
  assert.ok(!paths.shared.root.includes(oldMeta.projectId));
  assert.equal((await f.service.result(fresh.runId, fid, origin)).fact.fact_id, fid);
  await assert.rejects(f.service.result(old.runId, undefined, origin), { code: 'RUN_UNSETTLED' });
  await assert.rejects(f.service.invoke('gm_add', { kind: 'master_guidance', claim: 'opaque' }, oldActor), { code: 'CALLER_UNBOUND' });
  assert.deepEqual(await f.store.read(`research/runs/${old.runId}/run.json`), before);
});

test('simultaneous fresh admissions reserve exactly one current coordinator', async (t) => {
  const f = await fixture(t);
  const replies = await Promise.allSettled([f.service.run({ problem: 'opaque one' }, origin), f.service.run({ problem: 'opaque two' }, origin)]);
  assert.equal(replies.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(replies.find(r => r.status === 'rejected').reason.code, 'RUN_BUSY');
  assert.equal(f.calls.taskCreate.length, 1); assert.equal(f.calls.starts.length, 0);
  await f.service.stop(replies.find(r => r.status === 'fulfilled').value.runId, origin);
});

test('a stopped metadata state does not release an unfinished current pipeline', async (t) => {
  const entered = deferred(), gate = deferred(); t.after(() => gate.resolve());
  const f = await fixture(t, { realContexts: true, beforeCore: async ({ operation }) => {
    if (operation === 'fact_submit') { entered.resolve(); await gate.promise; }
  } });
  const old = await f.service.run({ problem: 'opaque pending pipeline' }, origin); await f.dispatch(); await entered.promise;
  const stopped = await f.service.stop(old.runId, origin);
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.finalizing, false); assert.equal(stopped.coordinatorActive, true);
  await assert.rejects(f.service.run({ problem: 'too early' }, origin), { code: 'RUN_BUSY' });
  gate.resolve(); await f.waitIdle(old.runId);
  await assertFreshRunAllowed(f);
});

test('terminal recovery preserves original bytes and uncertainty while permitting independent admission', async (t) => {
  const f = await fixture(t); const old = await f.service.run({ problem: 'opaque' }, origin); await f.service.stop(old.runId, origin);
  const loc = `research/runs/${old.runId}/run.json`, meta = await f.store.readJson(loc);
  Object.assign(meta, { state: 'failed', phase: 'failed', cleanupPending: true, indeterminate: true,
    runtimeCleanupPending: true, runtimeCleanupError: { code: 'RESEARCH_FAILED', message: 'RESEARCH_FAILED', indeterminate: true },
    pendingMutations: [{ callTag: 'opaque-write', operation: 'gm_add' }], taskCreatePending: true, coreTaskCreatePending: true, coreTaskSettlementPending: true });
  await f.store.write(loc, JSON.stringify(meta), true); const bytes = await f.store.read(loc);
  const g = await fixture(t, { tasks: f.tasks, schedules: f.schedules }, f.dataDir);
  assert.deepEqual(await g.store.read(loc), bytes); const status = await g.service.status(old.runId, origin);
  assert.equal(status.state, 'failed'); assert.equal(status.runtimeCleanupPending, true); assert.equal(status.coreTaskCreatePending, true);
  await assertFreshRunAllowed(g); assert.deepEqual(await g.store.read(loc), bytes);
  await assert.rejects(g.service.result(old.runId, undefined, origin), { code: 'RUN_UNSETTLED' });
});

test('unavailable data root rejects admission before tasks or model messages', async (t) => {
  const f = await fixture(t), displaced = f.dataDir + '-saved';
  await fs.rename(f.dataDir, displaced); await fs.writeFile(f.dataDir, 'opaque not-a-directory');
  try {
    const g = await fixture(t, {}, f.dataDir);
    await assert.rejects(g.service.run({ problem: 'must not start' }, origin), { code: 'RECOVERY_BLOCKED' });
    assert.equal(g.calls.taskCreate.length, 0); assert.equal(g.calls.starts.length, 0);
  } finally { await fs.unlink(f.dataDir); await fs.rename(displaced, f.dataDir); }
});

test('a reused project result is refused before Core or model creation', async (t) => {
  const f = await fixture(t, { prepared: { reused: true } });
  const run = await f.service.run({ problem: 'opaque' }, origin); await f.dispatch(); const result = await f.waitIdle(run.runId);
  assert.equal(result.error.code, 'PROJECT_NOT_FRESH'); assert.equal(f.calls.cores.length, 0); assert.equal(f.calls.starts.length, 0);
});

test('Core authorization is one separate App task; historical results retain the original owner scope', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId); await f.service.stop(run.runId, origin);
  const status = await f.service.status(run.runId, origin), meta = await f.store.readJson(`research/runs/${run.runId}/run.json`);
  assert.notEqual(status.coreTaskId, status.taskId); assert.equal(status.coreTaskCreatePending, false); assert.equal(status.coreTaskSettlementPending, false);
  assert.equal(f.calls.taskCreate.length, 2);
  assert.deepEqual(f.calls.taskCreate[1], { scope: 'app', delivery: 'none', label: 'Math Core execution', metadata: { researchRunId: run.runId, researchTaskKind: 'core-execution' } });
  assert.deepEqual(f.calls.cores[0].options, { taskId: status.coreTaskId });
  assert.equal(f.tasks.get(status.coreTaskId).status, 'completed'); assert.equal(f.tasks.get(status.coreTaskId).parentSessionId, null);
  assert.equal(f.tasks.get(status.taskId).scope, 'session'); assert.equal(meta.owner.sessionPath, origin.sessionPath);
  assert.ok(f.calls.lifecycle.indexOf('session-stop') < f.calls.lifecycle.indexOf('dispose:1'));
  assert.ok(f.calls.lifecycle.indexOf('dispose:1') < f.calls.lifecycle.indexOf(`complete:${status.coreTaskId}`));
  assert.ok(f.calls.lifecycle.indexOf(`complete:${status.coreTaskId}`) < f.calls.lifecycle.indexOf(`complete:${status.taskId}`));
  await f.service.result(run.runId, undefined, origin); assert.equal(f.calls.cores.at(-1).options, undefined);
  assert.equal(f.calls.taskCreate.length, 2);
});

for (const patch of [
  { scope: 'session' }, { delivery: 'next-step' }, { pluginId: 'foreign' }, { parentSessionId: 'worker' }, { parentSessionPath: '/worker' },
  { handlerKey: 'unexpected-handler' }, { metadata: { researchRunId: 'foreign', researchTaskKind: 'core-execution' } },
  function wrongResearchTaskKind(task) { return { metadata: { ...task.metadata, researchTaskKind: 'other-purpose' } }; },
  { status: 'failed' }, { taskId: 'task-1' },
]) test(`Core create receipt mismatch ${typeof patch === 'function' ? patch.name : JSON.stringify(patch)} cannot authorize execution or be retried`, async (t) => {
  const f = await fixture(t, { coreTaskCreateReceipt: patch }); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId);
  const status = await f.service.stop(run.runId, origin);
  assert.equal(status.coreTaskId, null); assert.equal(status.coreTaskCreatePending, true); assert.equal(status.coreTaskSettlementPending, true);
  assert.equal(status.cleanupPending, true); assert.equal(f.calls.cores.length, 0); assert.equal(f.calls.starts.length, 0);
  assert.equal(f.calls.taskCreate.length, 2);
  await assertFreshRunAllowed(f);
  await assert.rejects(f.service.setToolMode(run.runId, 'main', 'full', origin), { code: 'RESEARCH_UNSETTLED' });
});

test('Core get identity mismatch after creation cannot start Core or role sessions', async (t) => {
  const f = await fixture(t, { coreTaskGetReceipt: { parentSessionId: 'foreign' } });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId); const status = await f.service.stop(run.runId, origin);
  assert.equal(status.coreTaskCreatePending, false); assert.equal(status.coreTaskSettlementPending, true); assert.equal(status.cleanupPending, true);
  assert.equal(f.calls.cores.length, 0); assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.taskCreate.length, 2);
});

test('late Core create receipt after cancellation is settled without constructing a runtime', async (t) => {
  const gate = deferred(); const f = await fixture(t, { coreTaskGate: gate });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); const task = await f.coreTaskCreated.promise;
  const stopping = f.service.stop(run.runId, origin); await tick();
  assert.equal((await f.service.status(run.runId, origin)).coreTaskCreatePending, true); assert.equal(f.calls.cores.length, 0);
  gate.resolve(); await stopping;
  assert.equal(task.status, 'failed'); assert.equal(f.calls.cores.length, 0); assert.equal(f.calls.starts.length, 0);
  const status = await f.service.status(run.runId, origin); assert.equal(status.coreTaskId, task.taskId);
  assert.equal(status.coreTaskCreatePending, false); assert.equal(status.coreTaskSettlementPending, false); assert.equal(status.cleanupPending, false);
});

test('a Core receipt arriving after control timeouts is compensated without another create', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const gate = deferred(); t.after(() => gate.resolve());
  const f = await fixture(t, { coreTaskGate: gate }); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  const task = await f.coreTaskCreated.promise;
  t.mock.timers.tick(10001);
  let persisted;
  for (let n = 0; n < 1000; n++) {
    persisted = await f.store.readJson(`research/runs/${run.runId}/run.json`);
    if (persisted.phase === 'finalizing') break;
    await tick();
  }
  assert.equal(persisted.phase, 'finalizing'); await tick();
  t.mock.timers.tick(10001);
  const timedOut = await f.wait(run.runId);
  assert.equal(timedOut.coreTaskCreatePending, true); assert.equal(timedOut.cleanupPending, true); assert.equal(f.calls.cores.length, 0);
  const settled = deferred(), fail = f.sdk.tasks.fail;
  f.sdk.tasks.fail = async (id, error) => { const value = await fail(id, error); if (id === task.taskId) settled.resolve(); return value; };
  gate.resolve(); await settled.promise;
  const final = await f.service.stop(run.runId, origin);
  assert.equal(final.coreTaskCreatePending, false); assert.equal(final.coreTaskSettlementPending, false); assert.equal(final.cleanupPending, false);
  assert.equal(f.calls.taskCreate.length, 2); assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.cores.length, 0);
});

test('unknown Core creation is never inferred from a unique listed task on recovery', async (t) => {
  const f = await fixture(t, { coreTaskCreateError: new Error('fixture unknown create') });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId); await f.service.stop(run.runId, origin); await f.service.dispose();
  const g = await fixture(t, { tasks: f.tasks, schedules: f.schedules }, f.dataDir);
  const status = await g.service.status(run.runId, origin), meta = await g.store.readJson(`research/runs/${run.runId}/run.json`);
  assert.equal(status.coreTaskId, null); assert.equal(status.coreTaskCreatePending, true); assert.equal(status.coreTaskSettlementPending, true); assert.equal(status.cleanupPending, true);
  assert.equal(status.taskId, run.taskId); assert.equal(meta.owner.sessionPath, origin.sessionPath);
  assert.equal([...g.tasks.values()].find((task) => task.scope === 'app').status, 'failed');
  assert.equal(g.calls.taskCreate.length, 0); assert.equal(g.calls.starts.length, 0);
  await assertFreshRunAllowed(g);
});

for (const behavior of [{ coreTaskFailError: new Error('fixture settlement unavailable'), noAssignment: true }, { coreTaskCompleteReceipt: { taskId: 'foreign' } }]) test('Core terminal settlement failure retains an independent control fence', async (t) => {
  const f = await fixture(t, behavior); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId); const status = await f.service.stop(run.runId, origin);
  assert.equal(status.coreTaskSettlementPending, true); assert.equal(status.cleanupPending, true);
  assert.equal(status.coreTaskCreatePending, false); assert.notEqual(status.coreTaskId, status.taskId);
  assert.ok(f.calls.lifecycle.indexOf('dispose:1') < f.calls.lifecycle.findIndex((event) => event.endsWith(`:${status.coreTaskId}`)));
});

test('official SDK model:list envelope admits all three saved role models without overrides', async (t) => {
  const f = await fixture(t, { officialSdk: true });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  const status = await f.wait(run.runId); assert.equal(status.state, 'finished', JSON.stringify(status.error));
  assert.deepEqual(f.calls.bus.filter((c) => c.verb === 'model:list'), [{ verb: 'model:list', input: undefined }]);
  assert.deepEqual(f.calls.profiles, ['main', 'worker', 'verifier']);
  for (const session of f.calls.starts) assert.deepEqual(session.selection.model, { provider: 'saved-provider', id: `${session.role}-model` });
});

// Full catalog-shape matrix lives in research-sessions.test.mjs; these cover this service's own check and pairing.
for (const [name, catalog, code] of [
  ['missing verifier', { models: ['main', 'worker'].map((role) => ({ provider: 'saved-provider', id: `${role}-model` })) }, 'MODEL_NOT_AVAILABLE'],
  ['cross-paired identity', { models: ['main', 'worker', 'verifier'].flatMap((role) => [{ provider: 'other-provider', id: `${role}-model` }, { provider: 'saved-provider', id: `${role}-other` }]) }, 'MODEL_NOT_AVAILABLE'],
  ['bare array', [], 'MODEL_CATALOG_INVALID'], ['invalid provider', { models: [{ provider: 7, id: 'main-model' }] }, 'MODEL_CATALOG_INVALID'],
]) test(`research service rejects official model catalog ${name} before project/session setup`, async (t) => {
  const f = await fixture(t, { officialSdk: true, catalog }); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  const status = await f.wait(run.runId); assert.equal(status.state, 'failed'); assert.equal(status.error.code, code);
  assert.equal(status.projectId, null); assert.deepEqual(status.sessions, []); assert.deepEqual(status.verifiedFactIds, []);
  assert.equal(status.cleanupPending, false); assert.equal(f.calls.contexts.length, 0); assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.cores.length, 0);
});

for (const code of ['APP_CAPABILITY_DENIED', 'RPC_TIMEOUT']) test(`research service preserves catalog SDK error ${code} without fallback`, async (t) => {
  const f = await fixture(t, { officialSdk: true, modelError: Object.assign(new Error('fixture catalog failure'), { code }) });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); const status = await f.wait(run.runId);
  assert.equal(status.error.code, code); assert.equal(status.state, 'failed'); assert.equal(status.projectId, null);
  assert.equal(f.calls.bus.filter((c) => c.verb === 'model:list').length, 1); assert.equal(f.calls.starts.length, 0);
});

test('control ownership, strict user boundary and single active run', async (t) => {
  const f = await fixture(t);
  for (const input of [{ problem: 'x', role: 'worker' }, { problem: 'x', model: 'other' }, { problem: 'x', timeoutSeconds: 59 }, { problem: 'x', timeoutSeconds: 901 }]) await assert.rejects(f.service.run(input, origin));
  const run = await f.service.run({ problem: 'fixture' }, origin);
  await assert.rejects(f.service.run({ problem: 'another' }, origin), { code: 'RUN_BUSY' });
  for (const method of [() => f.service.status(run.runId, { ...origin, sessionPath: '/other' }), () => f.service.result(run.runId, fid, { ...origin, sessionPath: '/other' }), () => f.service.stop(run.runId, { ...origin, sessionPath: '/other' })]) await assert.rejects(method(), { code: 'OWNER_DENIED' });
  await assert.rejects(f.service.invoke('gm_add', {}, origin), { code: 'CALLER_UNBOUND' });
  const stopped = await f.service.stop(run.runId, origin); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.cleanupPending, false);
  assert.equal((await f.dispatch()).status, 'ignored'); assert.equal(f.calls.starts.length, 0);
});

test('binding is durable before first tool; main assignment is one bounded idempotent action', async (t) => {
  const f = await fixture(t, { turn: async ({ input, invoke, caller }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) {
      const runId = input.kind.split(':')[1], meta = await f.store.readJson(`research/runs/${runId}/run.json`);
      assert.ok(meta.sessions[0].binding); assert.equal(meta.sessions[0].sessionPath, caller.sessionPath);
      await invoke('math_assign', { task: 'one' }); await invoke('math_assign', { task: 'one' });
      await assert.rejects(invoke('math_assign', { task: 'two' }), { code: 'ASSIGNMENT_CONFLICT' });
      await assert.rejects(invoke('fact_submit', candidate), { code: 'ROLE_DENIED' });
    } else if (input.role === 'main') await assert.rejects(invoke('math_assign', { task: 'late' }), { code: 'PHASE_DENIED' });
    else if (input.role === 'worker') {
      await assert.rejects(invoke('fact_revoke', { fact_id: fid, reason: 'forbidden' }), { code: 'ROLE_DENIED' });
      await invoke('math_local_memory', { action: 'append', text: 'private fixture note' });
      assert.equal((await invoke('math_local_memory', { action: 'read' })).text, 'private fixture note');
      await assert.rejects(invoke('math_local_memory', { action: 'read', path: '/other' }));
      await invoke('search_arxiv_theorems', { query: 'fixture query' });
    }
    return 'fixture done';
  } });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); assert.equal((await f.wait(run.runId)).state, 'finished');
  assert.equal(f.calls.literature.length, 3); assert.deepEqual(f.calls.literature.map(call => call.slice(0, 2)), Array.from({ length: 3 }, () => ['fixture query', 10]));
});

test('real TASK is authoritative across progress-only and candidate turns; no duplicate task payload', async (t) => {
  const task = 'opaque assigned B-9f843', progress = 'opaque dead-end progress-29c70';
  const f = await fixture(t, { realContexts: true, turn: async ({ input, invoke, workerIndex }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task });
    if (input.role === 'worker') {
      assert.equal(await fs.readFile(path.join(input.cwd, 'TASK.md'), 'utf8'), task + '\n');
      assert.ok(!input.prompt.includes(task)); assert.ok(!input.prompt.includes('opaque initial A-82dda'));
      assert.match(input.prompt, /Read TASK\.md — your current assignment/);
      for (const sentence of [
        'Resume from state: gm_search relevant findings + dead ends, read the fact graph and the latest master_guidance — DO NOT restart from zero; build on what is already there.',
        'Keep going: assess -> pick skills adaptively -> act -> persist, repeatedly. An open problem is not a reason to stop. Do NOT finalize prematurely.',
      ]) assert.equal(input.prompt.split(sentence).length, 2);
      assert.ok(!input.prompt.includes('Continue your current assignment using prior progress in this run cwd'));
      assert.ok(!input.prompt.includes('Follow AGENTS.md'));
      assert.ok(input.prompt.includes(`Worker turn ${workerIndex}/3.`));
      assert.ok(input.prompt.includes('Use math_local_memory for this run private notes.'));
      assert.ok(input.prompt.includes('After an explicit precheck rejection, revise and resubmit within this turn. At most one candidate may be pending. On pending, end this turn immediately and wait for verification; pending is not accepted. The coordinator verifies after the turn ends.'));
      if (workerIndex === 3) { assert.match(input.prompt, /Latest actual feedback/); assert.match(input.prompt, /"accepted":true/); }
      const receipt = JSON.parse(await fs.readFile(path.join(input.cwd, 'research-workspace.json')));
      assert.equal(receipt.state, 'ready'); assert.equal(receipt.files.find(file => file.path === 'TASK.md').sha256, createHash('sha256').update(task + '\n').digest('hex'));
      if (workerIndex === 1) await invoke('math_local_memory', { action: 'append', text: progress });
      else { assert.equal((await invoke('math_local_memory', { action: 'read' })).text, progress); if (workerIndex === 2) await invoke('fact_submit', candidate); }
    }
    if (input.role === 'verifier') { await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD); }
    return 'opaque turn complete';
  } });
  const run = await f.service.run({ problem: 'opaque fixture', workerTask: 'opaque initial A-82dda' }, origin); await f.dispatch();
  assert.equal((await f.wait(run.runId)).state, 'finished');
  const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`);
  assert.equal(meta.assignmentFile, `context/projects/${meta.projectId}/research/${run.runId}/worker/TASK.md`);
  await assert.rejects(f.store.read(`research/runs/${run.runId}/assignment.json`), { code: 'ENOENT' });
  assert.equal(f.calls.starts.filter(call => call.role === 'worker').length, 3);
  assert.equal(f.calls.starts.filter(call => call.role === 'verifier').length, 1);
});

test('same concurrent assignment waits for the one write promise', async (t) => {
  const gate = deferred(), entered = deferred(); let writes = 0, replies = 0;
  const f = await fixture(t, { realContexts: true, assignGate: gate, onAssign() { writes++; entered.resolve(); }, turn: async ({ input, invoke }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) {
      const first = invoke('math_assign', { task: 'opaque B' }).then(result => { replies++; assert.equal(result.assigned, true); });
      const second = invoke('math_assign', { task: 'opaque B' }).then(result => { replies++; assert.equal(result.assigned, true); });
      await Promise.all([first, second]);
    }
    return 'opaque no candidate';
  } });
  const run = await f.service.run({ problem: 'opaque fixture' }, origin); await f.dispatch(); await entered.promise; await tick();
  try { assert.equal(writes, 1); assert.equal(replies, 0); assert.equal(f.calls.starts.filter(call => call.role === 'worker').length, 0); }
  finally { gate.resolve(); }
  assert.equal((await f.wait(run.runId)).state, 'finished'); assert.equal(replies, 2);
  assert.equal(f.calls.starts.filter(call => call.role === 'worker').length, 3);
  assert.equal(f.calls.starts.filter(call => call.role === 'verifier').length, 0);
});

for (const failurePoint of ['preparing', 'task', 'ready']) test(`assignment ${failurePoint} write failure never starts a worker or reports assigned`, async (t) => {
  let rejected = 0, injected = false, assigning = false;
  const f = await fixture(t, { realContexts: true, onAssign() { assigning = true; }, turn: async ({ input, invoke }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) {
      const first = invoke('math_assign', { task: 'opaque replacement B' });
      const second = invoke('math_assign', { task: 'opaque replacement B' });
      await Promise.all([first, second].map(promise => assert.rejects(promise, { code: 'EIO' }))); rejected += 2;
    }
    return 'opaque turn complete';
  } });
  const original = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (assigning && !injected && to.startsWith(f.dataDir) && to.includes('/worker/')) {
      const receipt = to.endsWith('/research-workspace.json') ? JSON.parse(await fs.readFile(from)) : null;
      if (failurePoint === 'task' && to.endsWith('/TASK.md') || receipt?.state === failurePoint) { injected = true; throw Object.assign(new Error('opaque write failure'), { code: 'EIO' }); }
    }
    return original(from, to);
  });
  syncBuiltinESMExports(); const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); }; t.after(restore);
  const run = await f.service.run({ problem: 'opaque fixture', workerTask: 'opaque initial A' }, origin); await f.dispatch();
  const status = await f.wait(run.runId); restore(); assert.equal(status.state, 'failed'); assert.equal(injected, true); assert.equal(rejected, 2);
  assert.equal(f.calls.starts.filter(call => call.role === 'worker').length, 0);
  const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`); assert.ok(!meta.assignmentFile);
  const base = `context/projects/${meta.projectId}/research/${run.runId}/worker`;
  const receipt = await f.store.readJson(`${base}/research-workspace.json`);
  if (failurePoint !== 'preparing') assert.equal(receipt.state, 'preparing');
  else assert.equal(createHash('sha256').update(await f.store.read(`${base}/TASK.md`)).digest('hex'), receipt.files.find(file => file.path === 'TASK.md').sha256);
});

for (const boundary of ['stop', 'deadline']) test(`progress-only turn cannot dispatch another worker after ${boundary}`, async (t) => {
  const entered = deferred(), gate = deferred(); t.after(() => gate.resolve());
  const f = await fixture(t, { turn: async ({ input, invoke }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque bounded task' });
    if (input.role === 'worker') { await invoke('math_local_memory', { action: 'append', text: 'opaque progress' }); entered.resolve(); await gate.promise; }
    return 'opaque no candidate';
  } });
  const run = await f.service.run({ problem: 'opaque fixture', timeoutSeconds: 60 }, origin); await f.dispatch(); await entered.promise;
  if (boundary === 'stop') await f.service.stop(run.runId, origin);
  else { const now = Date.now(); t.mock.method(Date, 'now', () => now + 61000); }
  gate.resolve(); const status = await f.wait(run.runId);
  assert.equal(status.state, boundary === 'stop' ? 'stopped' : 'failed');
  assert.equal(f.calls.starts.filter(call => call.role === 'worker').length, 1);
  assert.equal(f.calls.starts.filter(call => call.role === 'verifier').length, 0);
});

for (const damage of ['missing', 'empty']) test(`next worker turn rereads TASK and refuses a ${damage} file`, async (t) => {
  const f = await fixture(t, { realContexts: true, turn: async ({ input, invoke }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque B' });
    if (input.role === 'worker') {
      if (damage === 'missing') await fs.unlink(path.join(input.cwd, 'TASK.md'));
      else await fs.writeFile(path.join(input.cwd, 'TASK.md'), ' \n\t');
    }
    return 'opaque no candidate';
  } });
  const run = await f.service.run({ problem: 'opaque fixture' }, origin); await f.dispatch();
  const status = await f.wait(run.runId); assert.equal(status.state, 'failed');
  assert.equal(status.error.code, damage === 'missing' ? 'ENOENT' : 'MAIN_ASSIGNMENT_MISSING');
  assert.equal(f.calls.starts.filter(call => call.role === 'worker').length, 1);
  assert.equal(f.calls.starts.filter(call => call.role === 'verifier').length, 0);
});

test('rejected verifier feedback reaches new worker sessions, bounded at three', async (t) => {
  const f = await fixture(t, { report: BAD, allRounds: true }); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  const result = await f.wait(run.runId); assert.equal(result.state, 'finished'); assert.deepEqual(result.verifiedFactIds, []);
  assert.equal(f.calls.starts.filter((s) => s.role === 'worker').length, 3); assert.equal(f.calls.starts.filter((s) => s.role === 'verifier').length, 3);
  assert.match(f.calls.starts.filter((s) => s.role === 'worker')[1].prompt, /Repair the fixture gap/);
  assert.equal(f.calls.core.filter((c) => c.operation === 'fact_submit').length, 3);
  assert.equal(new Set(f.calls.starts.filter((s) => s.role === 'verifier').map((s) => s.cwd)).size, 3);
});

// Fault injection observes private controller objects without adding production hooks.
// All business logic is the actual source; only observer calls are inserted.
async function observeSettlement(t, observe, { omitJobIdentity = false } = {}) {
  const key = `opaque-settlement-${randomUUID()}`, symbol = Symbol.for(key);
  globalThis[symbol] = observe; t.after(() => { delete globalThis[symbol]; });
  const url = new URL('../packages/hana-math/research-service.mjs', import.meta.url);
  let source = await fs.readFile(url, 'utf8');
  if (omitJobIdentity) {
    // Isolated negative control only: never edit the production file or weaken assertions.
    const guarded = 'jobs[index] === job && operationalFailure(r, scope, job, outcome.reason)';
    assert.equal(source.split(guarded).length, 2);
    source = source.replace(guarded, 'operationalFailure(r, scope, job, outcome.reason)');
    t.diagnostic(`negative-control pre-observer source SHA256: ${createHash('sha256').update(source).digest('hex')}`);
  }
  for (const [needle, injection] of [
    ['r.assertAdmission = assertAdmission;', `globalThis[Symbol.for(${JSON.stringify(key)})]('run', r); `],
    ['operationalFailures.set(rejected, owner);', `globalThis[Symbol.for(${JSON.stringify(key)})]('failure', { rejected, owner }); `],
  ]) { assert.equal(source.split(needle).length, 2); source = source.replace(needle, injection + needle); }
  const returning = 'return feedback;\n  }\n  async function pipeline';
  assert.equal(source.split(returning).length, 2);
  source = source.replace(returning, `globalThis[Symbol.for(${JSON.stringify(key)})]('feedback', owner); ${returning}`);
  source = source.replace(/from '\.\/([^']+)'/g, (_, file) => `from '${new URL(file, url).href}'`);
  source += '\n//# sourceURL=opaque-settlement-observer.mjs\n';
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).createResearchService;
}

for (const replacement of [false, true]) test(`captured canonical scope cannot be detached or replaced, replacement=${replacement}`, async t => {
  let current, changed = false, reads = 0;
  const createService = await observeSettlement(t, (event, value) => { if (event === 'run') current = value; });
  const busy = prepareBusy(); busy.operation = 'fact_get'; const schedule = globalThis.setTimeout;
  const mock = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    const timer = schedule(fn, ms, ...args);
    if (ms === 1000 && reads === 1 && !changed) { changed = true; current.roundScope = replacement ? { ...current.roundScope, controller: new AbortController() } : null; }
    return timer;
  });
  try {
    const f = await fixture(t, { realContexts: true, createService, beforeCore: ({ operation }) => { if (operation === 'fact_get' && ++reads === 1) throw busy; } });
    await f.prepareWorker('scope-replaced', 'worker-1'); const run = await f.service.startWorkerRun({ projectId: 'scope-replaced', workerId: 'worker-1',
      workerPolicy: { maxRounds: 2, roundTimeoutSeconds: 10, roundDelaySeconds: 0, maxConsecutiveFailures: 2 } }, origin);
    await f.dispatch(); const status = await f.wait(run.runId);
    assert.equal(changed, true); assert.equal(status.state, 'failed'); assert.equal(reads, 1); assert.equal(status.candidateSettlement.pending, true);
    assert.deepEqual(status.verifiedFactIds, []); assert.equal(f.calls.core.filter(call => call.operation === 'fact_submit').length, 1);
    assert.equal(f.calls.starts.filter(call => call.role === 'worker').length, 1);
    assert.equal(f.calls.resumes.length, 0, 'invalid original scope must not resume the same worker SID');
  } finally { mock.mock.restore(); }
});

for (const replacement of [false, true]) test(`confirmed closure cannot resume a detached/replaced worker scope, replacement=${replacement}`, async t => {
  let changed = false;
  const createService = await observeSettlement(t, (event, owner) => {
    if (event !== 'feedback') return; changed = true;
    owner.r.roundScope = replacement ? { ...owner.r.roundScope, controller: new AbortController() } : null;
  });
  const f = await fixture(t, { realContexts: true, createService }); await f.prepareWorker('scope-after-close', 'worker-1');
  const run = await f.service.startWorkerRun({ projectId: 'scope-after-close', workerId: 'worker-1', workerPolicy: { maxRounds: 2, roundTimeoutSeconds: 10, roundDelaySeconds: 0, maxConsecutiveFailures: 2 } }, origin);
  await f.dispatch(); const status = await f.wait(run.runId);
  assert.equal(changed, true); assert.equal(status.state, 'failed'); assert.equal(status.candidateSettlement, null);
  assert.deepEqual(status.verifiedFactIds, [fid]); assert.equal(status.indeterminate, false); assert.equal(f.calls.resumes.length, 0);
  assert.equal(f.calls.starts.filter(call => call.role === 'worker').length, 1);
});

test('candidate settlement post-closure other fence prevents worker resume without losing confirmed facts', async t => {
  const createService = await observeSettlement(t, (event, owner) => { if (event === 'feedback') owner.r.meta.indeterminate = true; });
  const f = await fixture(t, { realContexts: true, createService }); await f.prepareWorker('closure-other-fence', 'worker-1');
  const run = await f.service.startWorkerRun({ projectId: 'closure-other-fence', workerId: 'worker-1', workerPolicy: { maxRounds: 2, roundTimeoutSeconds: 10, roundDelaySeconds: 0, maxConsecutiveFailures: 2 } }, origin);
  await f.dispatch(); const status = await f.wait(run.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.indeterminate, true); assert.equal(status.candidateSettlement, null);
  assert.deepEqual(status.verifiedFactIds, [fid]); assert.equal(f.calls.resumes.length, 0);
});

for (const sameError of [false, true]) test(`operational attestation excludes unrelated rejected jobs even with shared error=${sameError}`, async t => {
  let injected, current;
  const createService = await observeSettlement(t, (event, value) => {
    if (event === 'run') current = value;
    else { injected = Promise.reject(sameError ? value.rejected : Object.assign(new Error('opaque forged operation'), { code: 'CANDIDATE_CORE_BUSY' }));
      assert.notEqual(injected, value.owner.job, 'the rejected operation is not the controller Promise');
      injected.catch(() => {}); current.operations.add(injected); }
  }, { omitJobIdentity: process.env.SETTLEMENT_NEGATIVE_JOB_IDENTITY === '1' });
  const error = prepareBusy(); error.operation = 'fact_submit';
  const f = await fixture(t, { realContexts: true, createService, coreError: { operation: 'fact_submit', error } }); await f.prepareWorker('job-attestation', 'worker-1');
  const run = await f.service.startWorkerRun({ projectId: 'job-attestation', workerId: 'worker-1', workerPolicy: { maxRounds: 2, roundTimeoutSeconds: 10, roundDelaySeconds: 0, maxConsecutiveFailures: 2 } }, origin);
  try {
    await f.dispatch(); const status = await f.wait(run.runId);
    assert.ok(injected); assert.equal(status.state, 'failed'); assert.equal(status.cleanupPending, true); assert.equal(status.lastRoundOutcome, null);
    const persisted = await f.store.readJson(`research/runs/${run.runId}/run.json`);
    for (const [source, errors] of [['status', status.cleanupErrors], ['persisted', persisted.cleanupErrors]]) {
      const codes = errors.map(error => error.code);
      assert.ok(codes.includes('CANDIDATE_CORE_BUSY'), `${source}: foreign rejected-job origin must survive; observed ${JSON.stringify(codes)}`);
      assert.equal(codes.includes('ROUND_UNSETTLED'), false, `${source}: the outstanding-set fence must not substitute for the exact-job rejection`);
    }
    assert.equal(f.calls.starts.filter(call => call.role === 'worker').length, 1); assert.equal(status.submissions[0].state, 'not-recorded');
  } finally { if (injected) current.operations.delete(injected); }
});

test('candidate settlement fence is durable before final Core submission', async t => {
  let f, checked = false;
  f = await fixture(t, { beforeCore: async ({ binding, operation }) => {
    if (operation !== 'fact_submit') return;
    const meta = await f.store.readJson(`research/runs/${binding.runId}/run.json`);
    t.diagnostic(`candidate settlement before submit: ${JSON.stringify(meta.candidateSettlement)}`);
    assert.equal(meta.candidateSettlement?.schemaVersion, 1); assert.equal(meta.candidateSettlement.stage, 'submitting');
    assert.equal(meta.candidateSettlement.submissionId, meta.submissions[0].submissionId); checked = true;
  } });
  const run = await f.service.run({ problem: 'opaque durable settlement' }, origin); await f.dispatch();
  assert.equal((await f.wait(run.runId)).state, 'finished'); assert.equal(checked, true);
  assert.equal((await f.store.readJson(`research/runs/${run.runId}/run.json`)).candidateSettlement, null);
});

test('production candidate metadata crash cuts stay fenced on restart without verifier/write/read replay', async t => {
  let f, acceptedReceipt = false; const cuts = new Map(), rename = fs.rename, open = fs.open;
  const opening = t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (typeof file === 'string' && /\/(receipt|result)\.json$/.test(file)) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => {
        const result = await write(...values);
        if (file.endsWith('/receipt.json')) { const packet = JSON.parse(values[0]); if (packet.ok && packet.result?.accepted) acceptedReceipt = true; }
        if (file.endsWith('/result.json') && file.includes('/submissions/')) cuts.set('result-file', JSON.parse(await fs.readFile(file.slice(0, file.indexOf('/submissions/')) + '/run.json')));
        return result;
      };
    }
    return handle;
  });
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    const result = await rename(from, to);
    if (!f || !to.startsWith(f.dataDir)) return result;
    if (to.endsWith('/run.json')) {
      const meta = JSON.parse(await fs.readFile(to)), marker = meta.candidateSettlement;
      if (marker?.stage === 'submitting' && !meta.pendingMutations.length) cuts.set(acceptedReceipt ? 'receipt-cleared' : 'fence', structuredClone(meta));
      if (marker?.stage === 'canonical-readback') cuts.set('readback-stage', structuredClone(meta));
      if (marker === null && meta.submissions.some(sub => sub.state === 'accepted') && !cuts.has('closed')) cuts.set('closed', structuredClone(meta));
    }
    return result;
  }); syncBuiltinESMExports();
  let run;
  try { f = await fixture(t, { realContexts: true }); await f.prepareWorker('settlement-cuts', 'worker-1');
    run = await f.service.startWorkerRun({ projectId: 'settlement-cuts', workerId: 'worker-1' }, origin); await f.dispatch(); await f.wait(run.runId); await f.service.dispose();
  } finally { mocked.mock.restore(); opening.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual([...cuts.keys()].sort(), ['closed', 'fence', 'readback-stage', 'receipt-cleared', 'result-file'].sort());
  const resultFile = cuts.get('closed').submissions[0].resultFile, resultBytes = await f.store.read(resultFile);
  for (const [label, meta] of cuts) {
    if (['fence', 'receipt-cleared'].includes(label)) await fs.rm(f.store.absolute(resultFile), { force: true }); else await f.store.write(resultFile, resultBytes, true);
    await f.store.write(`research/runs/${run.runId}/run.json`, JSON.stringify(meta), true);
    const reopened = await fixture(t, { realContexts: true, tasks: f.tasks, schedules: f.schedules, hostSessions: f.hostSessions }, f.dataDir);
    const status = await reopened.service.projectWorkerStatus('settlement-cuts', run.runId);
    assert.equal(status.candidateSettlement === null, label === 'closed');
    assert.deepEqual(status.verifiedFactIds, label === 'closed' ? [fid] : []);
    if (label !== 'closed') {
      await assert.rejects(reopened.service.startWorkerRun({ projectId: 'settlement-cuts', workerId: 'worker-1' }, origin), { code: 'WORKER_BUSY' });
      await assert.rejects(reopened.service.result(run.runId, fid, origin), { code: 'RUN_UNSETTLED' });
    }
    assert.equal(reopened.calls.core.length, 0); assert.equal(reopened.calls.starts.length, 0); await reopened.service.dispose();
  }
});

for (const kind of ['pending', 'canonical', 'malformed', 'inconsistent', 'absent', 'null']) test(`candidate settlement recovery preserves terminal bytes and isolates worker admission: ${kind}`, async t => {
  const f = await fixture(t, { realContexts: true }); await f.prepareWorker('settlement-recovery', 'worker-1');
  const run = await f.service.startWorkerRun({ projectId: 'settlement-recovery', workerId: 'worker-1' }, origin); await f.dispatch(); await f.wait(run.runId); await f.service.dispose();
  const file = `research/runs/${run.runId}/run.json`, meta = await f.store.readJson(file), sub = meta.submissions[0];
  if (kind === 'absent') delete meta.candidateSettlement;
  else if (kind === 'null') meta.candidateSettlement = null;
  else {
    sub.state = 'verifying'; meta.candidateSettlement = { schemaVersion: 1, submissionId: sub.submissionId, stage: 'submitting', round: meta.round };
    if (kind === 'canonical') Object.assign(meta.candidateSettlement, { stage: 'canonical-readback', factId: fid, resultFile: sub.resultFile });
    if (kind === 'malformed') meta.candidateSettlement = { schemaVersion: 1, private: '/PRIVATE/fixture' };
    if (kind === 'inconsistent') meta.candidateSettlement.submissionId = 'submission-missing';
  }
  await f.store.write(file, JSON.stringify(meta), true); const bytes = await f.store.read(file);
  const restored = await fixture(t, { realContexts: true, tasks: f.tasks, schedules: f.schedules, hostSessions: f.hostSessions }, f.dataDir);
  const status = await restored.service.projectWorkerStatus('settlement-recovery', run.runId);
  if (!['absent', 'null'].includes(kind)) {
    assert.equal(status.candidateSettlement.pending, true); assert.equal(status.candidateSettlement.valid, !['malformed', 'inconsistent'].includes(kind));
    assert.doesNotMatch(JSON.stringify(status.candidateSettlement), /PRIVATE|resultFile/);
    await assert.rejects(restored.service.result(run.runId, fid, origin), { code: 'RUN_UNSETTLED' });
    await assert.rejects(restored.service.setToolMode(run.runId, 'worker', 'full', origin), { code: 'RESEARCH_UNSETTLED' });
    await assert.rejects(restored.service.startWorkerRun({ projectId: 'settlement-recovery', workerId: 'worker-1' }, origin), { code: 'WORKER_BUSY' });
    await restored.service.stopProjectWorker('settlement-recovery', run.runId);
  } else {
    assert.equal(kind === 'absent' ? Object.hasOwn(status, 'candidateSettlement') : status.candidateSettlement, kind === 'absent' ? false : null);
  }
  assert.deepEqual(await f.store.read(file), bytes); assert.equal(restored.calls.core.length, 0); assert.equal(restored.calls.starts.length, 0);
  await restored.prepareWorker('settlement-other', 'worker-1');
  const other = await restored.service.startWorkerRun({ projectId: 'settlement-other', workerId: 'worker-1' }, origin); assert.ok(other.runId);
  await restored.service.dispose();
});

// Mirrors Runtime.stamp and the raw 002 prepare busy envelope, not its public DTO.
const prepareBusy = () => Object.assign(new Error('opaque Core busy'), { code: 'RESEARCH_RUNTIME_REJECTED',
  coreError: { code: 'busy', message: 'project is busy' }, operation: 'prepare_submission',
  requestId: 'a9ce7831-83e1-45af-8a5f-3fe37dd72af8', runtimeId: '46cb1cae-86e1-42f3-9bc4-323708c7a481',
  phase: 'result', runtimeState: 'exited', exitCode: 0, signal: null, startOutcome: 'acknowledged',
  processTerminalConfirmed: true, indeterminate: false, cleanup: { confirmed: true, errors: [] } });

test('accepted canonical busy retries only the read once under the same candidate', async t => {
  let reads = 0;
  const error = prepareBusy(); error.operation = 'fact_get';
  const f = await fixture(t, { beforeCore: ({ operation }) => { if (operation === 'fact_get' && ++reads === 1) throw error; } });
  const run = await f.service.run({ problem: 'opaque canonical read retry' }, origin); await f.dispatch(); const status = await f.wait(run.runId);
  assert.equal(status.state, 'finished'); assert.equal(status.candidateSettlement, null); assert.deepEqual(status.verifiedFactIds, [fid]);
  assert.equal(reads, 2); assert.equal(f.calls.core.filter(c => c.operation === 'fact_submit').length, 1);
  assert.equal(f.calls.starts.filter(s => s.role === 'verifier').length, 1);
});

for (const mode of ['second-busy', 'nonbusy', 'missing', 'revoked', 'malformed', 'wrong-id']) test(`canonical retry retains accepted evidence on ${mode}`, async t => {
  let reads = 0;
  const busy = prepareBusy(); busy.operation = 'fact_get';
  const behavior = { beforeCore: ({ operation }) => {
    if (operation !== 'fact_get') return;
    if (++reads === 1) throw busy;
    if (mode === 'second-busy') throw busy;
    if (['nonbusy', 'missing', 'revoked'].includes(mode)) { const error = prepareBusy(); error.operation = 'fact_get'; error.coreError.code = mode; throw error; }
    behavior.readReply = mode === 'malformed' ? { fact_id: fid, markdown: null } : { fact_id: 'f'.repeat(16), markdown: 'opaque wrong ID' };
  } };
  const f = await fixture(t, behavior), run = await f.service.run({ problem: 'opaque canonical failure' }, origin); await f.dispatch(); const status = await f.wait(run.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.candidateSettlement.pending, true); assert.equal(status.candidateSettlement.stage, 'canonical-readback');
  assert.equal(status.candidateSettlement.readbackRetryReserved, true); assert.deepEqual(status.verifiedFactIds, []); assert.equal(reads, 2);
  const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`); assert.equal((await f.store.readJson(meta.submissions[0].resultFile)).accepted, true);
  assert.equal(f.calls.core.filter(c => c.operation === 'fact_submit').length, 1); assert.equal(f.calls.starts.filter(s => s.role === 'verifier').length, 1);
});

for (const boundary of ['result-file', 'readback-stage']) test(`accepted evidence remains fenced after ${boundary} EIO`, async t => {
  let injected = false; const open = fs.open, rename = fs.rename;
  const opening = t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (boundary === 'result-file' && typeof file === 'string' && file.endsWith('/result.json') && file.includes('/submissions/')) {
      handle.writeFile = async () => { injected = true; throw Object.assign(new Error('opaque result file'), { code: 'EIO' }); };
    }
    return handle;
  });
  const renaming = t.mock.method(fs, 'rename', async (from, to) => {
    if (boundary === 'readback-stage' && !injected && to.endsWith('/run.json') && JSON.parse(await fs.readFile(from)).candidateSettlement?.stage === 'canonical-readback') {
      injected = true; throw Object.assign(new Error('opaque readback stage'), { code: 'EIO' });
    }
    return rename(from, to);
  }); syncBuiltinESMExports();
  try {
    const f = await fixture(t), run = await f.service.run({ problem: 'opaque result evidence' }, origin); await f.dispatch(); const status = await f.wait(run.runId);
    assert.equal(injected, true); assert.equal(status.state, 'failed'); assert.equal(status.candidateSettlement.pending, true); assert.deepEqual(status.verifiedFactIds, []);
    const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`), tags = await f.store.list(meta.mutationReceipts);
    const receipts = await Promise.all(tags.map(tag => f.store.readJson(`${meta.mutationReceipts}/${tag}/receipt.json`)));
    assert.ok(receipts.some(receipt => receipt.ok && receipt.operation === 'fact_submit' && receipt.result.accepted && receipt.result.fact_id === fid));
    assert.equal(f.calls.core.filter(call => call.operation === 'fact_submit').length, 1); assert.equal(f.calls.core.filter(call => call.operation === 'fact_get').length, 0);
  } finally { opening.mock.restore(); renaming.mock.restore(); syncBuiltinESMExports(); }
});

for (const stage of ['delay', 'read', 'commit']) for (const action of ['force', 'graceful', 'total-deadline', 'round-deadline', ...(stage === 'commit' ? ['EIO', 'rename-then-EIO'] : [])]) test(`canonical settlement ${action} during ${stage}`, async t => {
  let f, run, reads = 0, acted = false, stopping, clock;
  const busy = prepareBusy(); busy.operation = 'fact_get'; const rename = fs.rename, schedule = globalThis.setTimeout;
  async function act() {
    if (acted) return; acted = true;
    const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`);
    if (action === 'force' || action === 'graceful') stopping = f.service.stopProjectWorker(meta.projectId, run.runId, { force: action === 'force' });
    else if (action.endsWith('deadline')) clock = t.mock.method(Date, 'now', () => (action === 'total-deadline' ? meta.deadlineAt : meta.roundDeadlineAt) + 1);
  }
  const timerMock = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    const timer = schedule(fn, ms, ...args);
    if (stage === 'delay' && ms === 1000 && reads === 1 && !acted) void act();
    return timer;
  });
  const renameMock = t.mock.method(fs, 'rename', async (from, to) => {
    if (stage === 'commit' && !acted && to.endsWith('/run.json') && reads === 2) {
      const packet = JSON.parse(await fs.readFile(from));
      if (packet.candidateSettlement === null && packet.submissions.some(sub => sub.state === 'accepted')) {
        await act();
        if (action === 'rename-then-EIO') await rename(from, to);
        if (action.includes('EIO')) throw Object.assign(new Error('opaque final publication'), { code: 'EIO' });
      }
    }
    return rename(from, to);
  }); syncBuiltinESMExports();
  try {
    f = await fixture(t, { realContexts: true, beforeCore: async ({ operation }) => {
      if (operation !== 'fact_get') return;
      if (++reads === 1) throw busy;
      if (stage === 'read') await act();
    } });
    await f.prepareWorker('settlement-cancel', 'worker-1');
    run = await f.service.startWorkerRun({ projectId: 'settlement-cancel', workerId: 'worker-1', timeoutSeconds: 60,
      workerPolicy: { maxRounds: 1, roundTimeoutSeconds: 10, roundDelaySeconds: 0, maxConsecutiveFailures: 1 } }, origin);
    await f.dispatch(); const status = await f.wait(run.runId); if (stopping) await stopping;
    assert.equal(acted, true); assert.equal(f.calls.core.filter(c => c.operation === 'fact_submit').length, 1);
    assert.equal(status.state, ['force', 'graceful'].includes(action) ? 'stopped' : 'failed');
    assert.equal(f.calls.resumes.length, action === 'graceful' ? 1 : 0);
    const workerSid = status.sessions.find(session => session.role === 'worker').sessionId;
    for (const resumed of f.calls.resumes) assert.equal(resumed.sessionId, workerSid, 'graceful completion may resume only this active worker SID');
    assert.equal(status.round, 1, 'cancellation must not start another mathematical round');
    assert.equal(f.calls.starts.filter(s => s.role === 'verifier').length, 1); assert.equal(f.calls.starts.filter(s => s.role === 'worker').length, 1);
    const closed = action === 'graceful' || stage === 'commit' && !action.includes('EIO');
    assert.deepEqual(status.verifiedFactIds, closed ? [fid] : []);
    if (closed) { assert.equal(status.candidateSettlement, null); assert.equal(status.indeterminate, false); }
    else assert.equal(status.candidateSettlement.pending, true);
    assert.equal(reads, stage === 'delay' && action !== 'graceful' ? 1 : 2);
    const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`);
    assert.equal((await f.store.readJson(meta.submissions[0].resultFile)).accepted, true);
  } finally { clock?.mock.restore(); timerMock.mock.restore(); renameMock.mock.restore(); syncBuiltinESMExports(); }
});

for (const mode of ['forged-code', 'wrong-operation', 'unknown-cleanup', 'closure-EIO', 'receipt-EIO', 'marker-removal-EIO', 'other-fence']) test(`submit settlement refuses ${mode}`, async t => {
  let f, injected = false, receiptWritten = false, current;
  const createService = mode === 'other-fence' ? await observeSettlement(t, (event, value) => { if (event === 'run') current = value; }) : createResearchService;
  const error = prepareBusy(); error.operation = mode === 'wrong-operation' ? 'prepare_submission' : 'fact_submit';
  if (mode === 'forged-code') error.code = 'CANDIDATE_CORE_BUSY';
  if (mode === 'unknown-cleanup') error.cleanup.confirmed = false;
  const rename = fs.rename, open = fs.open;
  const opening = t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (typeof file === 'string' && file.endsWith('/receipt.json')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => {
        const packet = JSON.parse(values[0]);
        if (packet.operation === 'fact_submit' && mode === 'receipt-EIO') { injected = true; throw Object.assign(new Error('opaque receipt'), { code: 'EIO' }); }
        const result = await write(...values); if (packet.operation === 'fact_submit') receiptWritten = true; return result;
      };
    }
    return handle;
  });
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (mode === 'marker-removal-EIO' && receiptWritten && to.endsWith('/run.json')) {
      const packet = JSON.parse(await fs.readFile(from));
      if (!packet.pendingMutations.length && packet.candidateSettlement?.stage === 'submitting') { injected = true; throw Object.assign(new Error('opaque mutation removal'), { code: 'EIO' }); }
    }
    if (mode === 'closure-EIO' && to.endsWith('/run.json')) {
      const packet = JSON.parse(await fs.readFile(from));
      if (packet.candidateSettlement === null && packet.submissions.some(s => s.state === 'not-recorded')) { injected = true; throw Object.assign(new Error('opaque closure'), { code: 'EIO' }); }
    }
    return rename(from, to);
  }); syncBuiltinESMExports();
  try {
    f = await fixture(t, { realContexts: true, createService, coreError: { operation: 'fact_submit', error },
      beforeCore: ({ operation }) => { if (mode === 'other-fence' && operation === 'fact_submit') { current.meta.indeterminate = true; injected = true; } } }); await f.prepareWorker('settlement-denied', 'worker-1');
    const run = await f.service.startWorkerRun({ projectId: 'settlement-denied', workerId: 'worker-1', workerPolicy: { maxRounds: 2, roundTimeoutSeconds: 60, roundDelaySeconds: 0, maxConsecutiveFailures: 2 } }, origin);
    await f.dispatch(); const status = await f.wait(run.runId);
    assert.equal(status.state, 'failed'); assert.equal(status.candidateSettlement.pending, true); assert.notEqual(status.submissions[0].state, 'not-recorded');
    assert.deepEqual(status.verifiedFactIds, []); assert.equal(f.calls.starts.filter(s => s.role === 'worker').length, 1);
    assert.equal(f.calls.core.filter(c => c.operation === 'fact_submit').length, 1); if (mode.includes('EIO') || mode === 'other-fence') assert.equal(injected, true);
  } finally { mocked.mock.restore(); opening.mock.restore(); syncBuiltinESMExports(); }
});

for (const configured of [false, true]) for (const verdict of [GOOD, BAD]) test(`submit busy settles operationally without changing ${verdict.verdict}, configured=${configured}`, async t => {
  const error = prepareBusy(); error.operation = 'fact_submit'; const times = [];
  const f = await fixture(t, { realContexts: configured, allRounds: true, report: verdict,
    coreError: { operation: 'fact_submit', error }, beforeCore: ({ operation }) => { if (operation === 'fact_submit') times.push(Date.now()); } });
  let run;
  if (configured) { await f.prepareWorker('settlement-operational', 'worker-1'); run = await f.service.startWorkerRun({ projectId: 'settlement-operational', workerId: 'worker-1', workerPolicy: { maxRounds: 3, roundTimeoutSeconds: 60, roundDelaySeconds: 1, maxConsecutiveFailures: 2 } }, origin); }
  else run = await f.service.run({ problem: 'opaque operational closure' }, origin);
  await f.dispatch(); const status = await f.wait(run.runId);
  assert.equal(status.state, 'failed'); assert.equal(status.indeterminate, false); assert.equal(status.cleanupPending, false);
  assert.equal(status.candidateSettlement, null); assert.deepEqual(status.verifiedFactIds, []);
  assert.equal(status.submissions.length, configured ? 2 : 1);
  for (const sub of status.submissions) {
    assert.equal(sub.state, 'not-recorded'); assert.equal(sub.operationalFailure.verification_verdict, verdict.verdict);
    const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`), own = meta.submissions.find(s => s.submissionId === sub.submissionId);
    assert.deepEqual(await f.store.readJson(own.reportFile), verdict); assert.equal(Object.hasOwn(own, 'resultFile'), false);
  }
  assert.equal(f.calls.core.filter(c => c.operation === 'fact_submit').length, configured ? 2 : 1);
  assert.equal(f.calls.starts.filter(s => s.role === 'verifier').length, configured ? 2 : 1);
  if (configured) {
    assert.equal(status.lastRoundOutcome.code, 1); assert.equal(status.consecutiveFailures, 2); assert.equal(status.error.code, 'CONSECUTIVE_ROUND_FAILURES');
    assert.ok(times[1] - times[0] >= 1000);
    const prompt = f.calls.starts.filter(s => s.role === 'worker')[1].prompt;
    const feedback = JSON.parse(prompt.split('Latest actual feedback (not proof of the entire problem):\n')[1].split('\n')[0]);
    assert.equal(Object.hasOwn(feedback, 'verdict'), false);
    assert.equal(feedback.kind, 'operational_failure');
    assert.equal(feedback.code, 'CANDIDATE_CORE_BUSY');
    assert.equal(feedback.accepted, false);
    assert.equal(feedback.verification_verdict, verdict.verdict);
    assert.match(prompt, /operational_failure/);
    assert.match(prompt, /No canonical fact was registered/);
    assert.match(prompt, /does not provide or recover candidate text/);
    if (verdict.verdict === 'correct') {
      assert.match(prompt, /independent verifier passed this candidate/);
      assert.match(prompt, /not a mathematical rejection or a reusable fact/);
      assert.match(prompt, /legitimately retain or can reconstruct the candidate text/);
      assert.match(prompt, /recheck current predecessor facts/);
      assert.match(prompt, /explicit normal submission through the original precheck and verifier gates/);
      assert.doesNotMatch(prompt, /prior verification did not pass/);
    } else {
      assert.match(prompt, /prior verification did not pass/);
      assert.match(prompt, /does not overturn that wrong verdict/);
      assert.match(prompt, /Revise using available feedback or propose a new candidate/);
      assert.match(prompt, /do not resubmit it unchanged/);
      assert.doesNotMatch(prompt, /independent verifier passed this candidate|not a mathematical rejection/);
    }
  } else { assert.equal(status.error.code, 'CANDIDATE_CORE_BUSY'); await assertFreshRunAllowed(f); }
});

test('configured research rounds send the upstream Danus kickoff verbatim before any Hana mapping', async t => {
  const f = await fixture(t, { realContexts: true, allRounds: true, report: GOOD });
  await f.prepareWorker('kickoff-fidelity', 'worker-1');
  const run = await f.service.startWorkerRun({ projectId: 'kickoff-fidelity', workerId: 'worker-1', workerPolicy: { maxRounds: 1, roundTimeoutSeconds: 60, roundDelaySeconds: 0, maxConsecutiveFailures: 0 } }, origin);
  await f.dispatch(); await f.wait(run.runId);
  const prompt = f.calls.starts.filter(s => s.role === 'worker')[0].prompt;
  const expected = upstreamKickoff('kickoff-fidelity', 'worker-1');
  assert.ok(prompt.startsWith(expected), prompt.slice(0, 400));
  // Every one of the five upstream items appears in order, before any Hana mapping.
  const items = expected.split('\n').slice(1);
  assert.equal(items.length, 5);
  let cursor = 0;
  for (const item of items) { const at = prompt.indexOf(item, cursor); assert.ok(at > -1, item); cursor = at + item.length; }
  assert.doesNotMatch(prompt.slice(0, cursor), /math_local_memory|Hana configured/);
  assert.doesNotMatch(prompt, /Hana configured research-rounds adapter|Hana bounded-run adapter/);
  // The adapted contract carries the environment; the research verifier prompt adds no mapping preamble.
  for (const start of f.calls.starts.filter(s => s.role === 'verifier')) {
    assert.ok(start.prompt.startsWith('Verification turn.'), start.prompt.slice(0, 120));
    assert.doesNotMatch(start.prompt, /Hana configured research-rounds adapter|Hana bounded-run adapter/);
  }
});

for (const verdict of [GOOD, BAD]) test(`normal configured ${verdict.verdict} feedback has no operational resubmission guidance`, async t => {
  const f = await fixture(t, { realContexts: true, allRounds: true, report: verdict });
  await f.prepareWorker('normal-feedback', 'worker-1');
  const run = await f.service.startWorkerRun({ projectId: 'normal-feedback', workerId: 'worker-1', workerPolicy: { maxRounds: 2, roundTimeoutSeconds: 60, roundDelaySeconds: 0, maxConsecutiveFailures: 0 } }, origin);
  await f.dispatch(); await f.wait(run.runId);
  const prompt = f.calls.starts.filter(s => s.role === 'worker')[1].prompt;
  const feedback = JSON.parse(prompt.split('Latest actual feedback (not proof of the entire problem):\n')[1].split('\n')[0]);
  assert.equal(feedback.verdict, verdict.verdict);
  assert.equal(feedback.accepted, verdict.verdict === 'correct');
  assert.doesNotMatch(prompt, /No canonical fact was registered|independent verifier passed this candidate|prior verification did not pass|does not provide or recover candidate text/);
  assert.equal(prompt.slice(prompt.indexOf('\nAfter an explicit precheck rejection')), '\nAfter an explicit precheck rejection, revise and resubmit. Only one candidate may be pending. Pending is not accepted: end the Hana model turn and await actual verifier feedback in this same session. After feedback, continue or repair. End without a new candidate to finish the mathematical round; a new round uses a fresh worker session.');
});

test('confirmed prepare busy permits only explicit same-SID same-round retry', async t => {
  let f, checked = false;
  const behavior = { coreError: { operation: 'prepare_submission', error: prepareBusy() }, turn: async ({ input, invoke, workerIndex, service, host }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque busy retry' });
    if (input.role === 'worker' && workerIndex === 1) {
      await assert.rejects(invoke('fact_submit', candidate), error => { t.diagnostic(`prepare busy code: ${error.code}`); assert.equal(error.code, 'SUBMISSION_CORE_BUSY'); return true; });
      await tick(); assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 1);
      assert.equal(f.calls.starts.some(s => s.role === 'verifier'), false);
      delete behavior.coreError;
      assert.equal((await invoke('fact_submit', candidate)).pending, true);
      const status = await service.status(input.kind.split(':')[1], origin);
      assert.deepEqual(status.submissionDiagnostics.attempts.map(a => a.outcome), ['prepare-error', 'registered']);
      for (const a of status.submissionDiagnostics.attempts) { assert.equal(a.round, 1); assert.equal(a.workerSessionId, host.sessionId); }
      checked = true;
    }
    if (input.role === 'verifier') { await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD); }
    return 'opaque completion';
  } };
  f = await fixture(t, behavior); const run = await f.service.run({ problem: 'opaque busy' }, origin); await f.dispatch();
  assert.equal((await f.wait(run.runId)).state, 'finished'); assert.equal(checked, true);
  assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 2);
  assert.equal(f.calls.core.filter(c => c.operation === 'fact_submit').length, 1);
});

for (const [label, change] of [
  ['public DTO', e => Object.assign(new Error('opaque DTO'), runtimeFailureInfo(e))],
  ['plain object', e => ({ ...e })], ['foreign operation', e => { e.operation = 'fact_submit'; return e; }],
  ['missing request', e => { delete e.requestId; return e; }], ['invalid request', e => { e.requestId = 'unstamped'; return e; }],
  ['missing terminal', e => { delete e.processTerminalConfirmed; return e; }], ['start unknown', e => { e.startOutcome = 'unknown'; return e; }],
  ['phase get', e => { e.phase = 'get'; return e; }], ['wrong exit', e => { e.exitCode = 1; return e; }],
  ['permission', e => { e.code = 'RESEARCH_RUNTIME_DENIED'; return e; }],
  ['missing cleanup', e => { delete e.cleanup; return e; }], ['unknown cleanup', e => { e.cleanup.confirmed = false; return e; }],
  ['cleanup error', e => { e.cleanup.errors.push({ code: 'EIO' }); return e; }],
  ['partial result', e => { e.coreResult = { write_error: 'opaque' }; return e; }],
  ['partial mutation', e => { e.coreError.mutationState = 'indeterminate'; return e; }],
  ['noisy core', e => { e.coreError.extra = true; return e; }], ['noisy error', e => { e.unrecognized = true; return e; }],
  ['historical DTO', e => { e.runtime = runtimeFailureInfo(e); return e; }],
  ['noisy enforcement', e => { e.enforcement = 'unconfirmed'; return e; }],
  ['backend proxy', e => { e.backend = new Proxy({}, {}); return e; }],
  ['cleanup errors proxy', e => { e.cleanup.errors = new Proxy([], {}); return e; }],
  ['core message getter', e => { Object.defineProperty(e.coreError, 'message', { get() { assert.fail('busy predicate must not execute Core message getters'); } }); return e; }],
  ['proxy', e => new Proxy(e, {})], ['core proxy', e => { e.coreError = new Proxy(e.coreError, {}); return e; }],
  ['getter operation', e => { Object.defineProperty(e, 'operation', { get() { assert.fail('busy predicate must not execute operation getters'); } }); return e; }],
]) test(`untrusted prepare busy evidence keeps admission closed: ${label}`, async t => {
  let f, checked = false;
  const behavior = { coreError: { operation: 'prepare_submission', error: change(prepareBusy()) }, turn: async ({ input, invoke, workerIndex }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque fail closed' });
    if (input.role === 'worker' && workerIndex === 1) {
      await assert.rejects(invoke('fact_submit', candidate), e => e.code !== 'SUBMISSION_CORE_BUSY');
      delete behavior.coreError;
      await assert.rejects(invoke('fact_submit', candidate), e => ['SUBMISSION_ALREADY_PENDING', 'CALLER_UNBOUND', 'RUN_INACTIVE', 'RUNTIME_CLEANUP_PENDING'].includes(e.code)); checked = true;
    }
    return 'opaque completion';
  } };
  f = await fixture(t, behavior); const run = await f.service.run({ problem: 'opaque evidence' }, origin); await f.dispatch(); await f.wait(run.runId);
  assert.equal(checked, true); assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 1);
  assert.equal(f.calls.starts.some(s => s.role === 'verifier'), false);
});

for (const mode of ['EIO', 'stop', 'deadline', 'identity']) test(`prepare busy cannot reopen across diagnostic ${mode}`, async t => {
  let f, injected = false, checked = false, stopping;
  const behavior = { coreError: { operation: 'prepare_submission', error: prepareBusy() }, turn: async ({ input, invoke, workerIndex, service, host }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque busy diagnostic' });
    if (input.role === 'worker' && workerIndex === 1) {
      const runId = input.kind.split(':')[1], destination = f.store.absolute(`research/runs/${runId}/run.json`), rename = fs.rename, agentId = host.agentId;
      let clock;
      const mocked = t.mock.method(fs, 'rename', async (from, to) => {
        if (!injected && to === destination) {
          const packet = JSON.parse(await fs.readFile(from));
          if (packet.submissionDiagnostics?.attempts.at(-1)?.outcome === 'prepare-error') {
            injected = true;
            if (mode === 'EIO') throw Object.assign(new Error('opaque diagnostics'), { code: 'EIO' });
            if (mode === 'stop') stopping = service.stop(runId, origin);
            if (mode === 'deadline') clock = t.mock.method(Date, 'now', () => packet.deadlineAt + 1);
            if (mode === 'identity') host.agentId = 'changed-saved-worker';
          }
        }
        return rename(from, to);
      }); syncBuiltinESMExports();
      try { await assert.rejects(invoke('fact_submit', candidate), e => ['EIO', 'RUN_INACTIVE', 'DEADLINE_EXCEEDED', 'CALLER_UNBOUND'].includes(e.code)); }
      finally { mocked.mock.restore(); clock?.mock.restore(); host.agentId = agentId; syncBuiltinESMExports(); }
      delete behavior.coreError;
      await assert.rejects(invoke('fact_submit', candidate), e => ['SUBMISSION_ALREADY_PENDING', 'CALLER_UNBOUND', 'RUN_INACTIVE', 'RESEARCH_PERSISTENCE_FAILED'].includes(e.code)); checked = true;
    }
    return 'opaque completion';
  } };
  f = await fixture(t, behavior); const run = await f.service.run({ problem: 'opaque race' }, origin); await f.dispatch(); const status = await f.wait(run.runId); if (stopping) await stopping;
  assert.equal(injected, true); assert.equal(checked, true); assert.equal(status.submissions.length, 0);
  assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 1);
});

for (const kind of ['busy', 'precheck']) for (const secondWriteFails of [false, true]) test(`${kind} release waits for a concurrent slot-rejection diagnostic, EIO=${secondWriteFails}`, async t => {
  let f, checked = false;
  const firstEntered = deferred(), firstRelease = deferred(), secondEntered = deferred(), secondRelease = deferred();
  const behavior = { ...(kind === 'busy' ? { coreError: { operation: 'prepare_submission', error: prepareBusy() } } : { precheckReject: true }), turn: async ({ input, invoke, workerIndex }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque concurrent diagnostics' });
    if (input.role === 'worker' && workerIndex === 1) {
      const destination = f.store.absolute(`research/runs/${input.kind.split(':')[1]}/run.json`), rename = fs.rename;
      let firstHeld = false, secondHeld = false, settled = false;
      const mocked = t.mock.method(fs, 'rename', async (from, to) => {
        if (to === destination) {
          const attempts = JSON.parse(await fs.readFile(from)).submissionDiagnostics?.attempts || [];
          if (!firstHeld && attempts.at(-1)?.outcome === (kind === 'busy' ? 'prepare-error' : 'precheck-rejected')) { firstHeld = true; firstEntered.resolve(); await firstRelease.promise; }
          else if (!secondHeld && attempts.at(-1)?.outcome === 'slot-rejected') {
            secondHeld = true; secondEntered.resolve(); await secondRelease.promise;
            if (secondWriteFails) throw Object.assign(new Error('opaque concurrent diagnostic EIO'), { code: 'EIO' });
          }
        }
        return rename(from, to);
      }); syncBuiltinESMExports(); let first, second;
      try {
        first = invoke('fact_submit', candidate).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
        await firstEntered.promise;
        second = assert.rejects(invoke('fact_submit', candidate), { code: 'SUBMISSION_ALREADY_PENDING' }); await tick(); firstRelease.resolve();
        await secondEntered.promise; await tick(); assert.equal(settled, false);
        assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 1);
        secondRelease.resolve(); const outcome = await first; await second;
        if (secondWriteFails) { assert.equal(outcome.error.code, 'EIO'); await assert.rejects(invoke('fact_submit', candidate)); }
        else { if (kind === 'busy') assert.equal(outcome.error.code, 'SUBMISSION_CORE_BUSY'); else assert.equal(outcome.value.precheck.passed, false);
          delete behavior.coreError; behavior.precheckReject = false; assert.equal((await invoke('fact_submit', candidate)).pending, true); }
        checked = true;
      } finally { firstRelease.resolve(); secondRelease.resolve(); await Promise.allSettled([first, second]); mocked.mock.restore(); syncBuiltinESMExports(); }
    }
    if (input.role === 'verifier') { await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD); }
    return 'opaque completion';
  } };
  f = await fixture(t, behavior); const run = await f.service.run({ problem: 'opaque concurrent release' }, origin); await f.dispatch(); await f.wait(run.runId); assert.equal(checked, true);
});

test('confirmed precheck rejection permits revision in the same worker session and round', async t => {
  let f, revised = false;
  const behavior = { precheckReject: true, precheckStatus: 400, precheckDetail: '[P5 on proof] opaque fixture rejection',
    turn: async ({ input, invoke, workerIndex, service, host }) => {
      if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque revision fixture' });
      if (input.role === 'worker' && workerIndex === 1) {
        const rejected = await invoke('fact_submit', { ...candidate, proof: 'opaque rejected draft' });
        assert.equal(rejected.pending, false); assert.equal(rejected.precheck.passed, false);
        behavior.precheckReject = false;
        const pending = await invoke('fact_submit', { ...candidate, proof: 'opaque revised draft' }); assert.equal(pending.pending, true);
        const status = await service.status(input.kind.split(':')[1], origin), history = status.submissionDiagnostics;
        assert.equal(history.total, 2); assert.deepEqual(history.attempts.map(a => a.outcome), ['precheck-rejected', 'registered']);
        for (const a of history.attempts) { assert.equal(a.round, 1); assert.equal(a.workerSessionId, host.sessionId); }
        assert.equal(status.submissions.length, 1); assert.equal(status.submissions[0].submissionId, pending.submissionId);
        assert.equal(f.calls.starts.filter(s => s.role === 'verifier').length, 0); revised = true;
      }
      if (input.role === 'verifier') { await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD); }
      return 'opaque completion';
    } };
  f = await fixture(t, behavior); const run = await f.service.run({ problem: 'opaque same-round revision' }, origin); await f.dispatch(); const status = await f.wait(run.runId);
  assert.equal(revised, true); assert.equal(status.state, 'finished'); assert.deepEqual(status.verifiedFactIds, [fid]);
  assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 2);
  const committed = f.calls.core.filter(c => c.operation === 'fact_submit'); assert.equal(committed.length, 1); assert.equal(committed[0].args.proof, 'opaque revised draft');
  assert.equal(f.calls.starts.filter(s => s.role === 'verifier').length, 1);
});

for (const mode of ['prepare-error', 'unknown-result', 'invalid-rejection', 'registered']) test(`${mode} does not reopen the same-round submission slot`, async t => {
  let f, checked = false;
  const behavior = { turn: async ({ input, invoke, workerIndex }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque locked slot' });
    if (input.role === 'worker' && workerIndex === 1) {
      if (mode === 'registered') assert.equal((await invoke('fact_submit', candidate)).pending, true);
      else await assert.rejects(invoke('fact_submit', candidate), { code: mode === 'prepare-error' ? 'PREPARE_FIXTURE_FAILED' : 'PREPARATION_INVALID' });
      delete behavior.coreError; delete behavior.prepareReply;
      await assert.rejects(invoke('fact_submit', candidate), { code: 'SUBMISSION_ALREADY_PENDING' }); checked = true;
    }
    if (input.role === 'verifier') { await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD); }
    return 'opaque completion';
  } };
  if (mode === 'prepare-error') behavior.coreError = { operation: 'prepare_submission', error: Object.assign(new Error('opaque prepare failure'), { code: 'PREPARE_FIXTURE_FAILED' }) };
  if (mode === 'unknown-result') behavior.prepareReply = { candidateDigest: 'b'.repeat(64), predecessorDigests: {}, precheck: { passed: 'false' } };
  if (mode === 'invalid-rejection') behavior.prepareReply = { candidateDigest: 'invalid', predecessorDigests: {}, precheck: { passed: false } };
  f = await fixture(t, behavior); const run = await f.service.run({ problem: 'opaque occupied slot' }, origin); await f.dispatch(); const status = await f.wait(run.runId);
  assert.equal(checked, true); assert.equal(status.state, 'finished'); assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 1);
  assert.equal(status.submissionDiagnostics.attempts.at(-1).outcome, 'slot-rejected');
});

for (const mode of ['EIO', 'stop']) test(`precheck rejection cannot reopen the slot across diagnostic ${mode}`, async t => {
  let f, injected = false, checked = false, stopping;
  f = await fixture(t, { precheckReject: true, turn: async ({ input, invoke, workerIndex, service }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'opaque rejection persistence' });
    if (input.role === 'worker' && workerIndex === 1) {
      const runId = input.kind.split(':')[1], destination = f.store.absolute(`research/runs/${runId}/run.json`), rename = fs.rename;
      const mocked = t.mock.method(fs, 'rename', async (from, to) => {
        if (!injected && to === destination) {
          const packet = JSON.parse(await fs.readFile(from));
          if (packet.submissionDiagnostics?.attempts.at(-1)?.outcome === 'precheck-rejected') {
            injected = true;
            if (mode === 'EIO') throw Object.assign(new Error('opaque diagnostic failure'), { code: 'EIO' });
            stopping = service.stop(runId, origin);
          }
        }
        return rename(from, to);
      }); syncBuiltinESMExports();
      try { await assert.rejects(invoke('fact_submit', candidate), { code: mode === 'EIO' ? 'EIO' : 'RUN_INACTIVE' }); }
      finally { mocked.mock.restore(); syncBuiltinESMExports(); }
      await assert.rejects(invoke('fact_submit', candidate), error => ['CALLER_UNBOUND', 'RUN_INACTIVE', 'RESEARCH_PERSISTENCE_FAILED'].includes(error.code));
      checked = true;
    }
    return 'opaque completion';
  } });
  const run = await f.service.run({ problem: 'opaque rejection race' }, origin); await f.dispatch(); const status = await f.wait(run.runId); if (stopping) await stopping;
  assert.equal(injected, true); assert.equal(checked, true); assert.equal(status.submissions.length, 0);
  assert.equal(f.calls.core.filter(c => c.operation === 'prepare_submission').length, 1); assert.equal(f.calls.starts.filter(s => s.role === 'verifier').length, 0);
  if (mode === 'EIO') assert.equal(status.submissionDiagnostics.recordingComplete, false);
});

test('precheck rejects without a verifier and returns bounded feedback', async (t) => {
  const f = await fixture(t, { precheckReject: true, allRounds: true }); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  assert.equal((await f.wait(run.runId)).state, 'finished'); assert.equal(f.calls.starts.filter((s) => s.role === 'worker').length, 3);
  assert.equal(f.calls.starts.filter((s) => s.role === 'verifier').length, 0); assert.equal(f.calls.core.filter((c) => c.operation === 'fact_submit').length, 0);
});

test('missing assignment, contradictory or mismatched report fail closed', async (t) => {
  for (const behavior of [{ noAssignment: true }, { report: { ...GOOD, repair_hints: 'contradiction' } }, { finalReport: BAD }]) {
    const f = await fixture(t, behavior); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); const result = await f.wait(run.runId);
    assert.equal(result.state, 'failed'); assert.deepEqual(result.verifiedFactIds, []); assert.equal(f.calls.core.filter((c) => c.operation === 'fact_submit').length, 0);
  }
});

test('uncertain writes prevent same-run retries but not a fresh run after the coordinator ends', async (t) => {
  for (const behavior of [ { writeError: true }, { coreError: { operation: 'fact_submit', error: Object.assign(new Error('trace failed'), { code: 'RESEARCH_RUNTIME_REJECTED', requestId: 'fixture-request', indeterminate: true, cleanup: { confirmed: true, errors: [] } }) } } ]) {
    const f = await fixture(t, behavior); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); const result = await f.wait(run.runId);
    assert.equal(result.state, 'failed'); assert.equal(result.indeterminate, true); assert.deepEqual(result.verifiedFactIds, []);
    assert.equal(f.calls.starts.filter((s) => s.role === 'worker').length, 1);
    await assertFreshRunAllowed(f);
    if (behavior.coreError) assert.equal(result.error.requestId, 'fixture-request');
  }
});

test('main revocation removes recorded IDs, and model arguments cannot cross project binding', async (t) => {
  const f = await fixture(t, { turn: async ({ input, invoke, workerIndex, host }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'fixture' });
    else if (input.role === 'main') await invoke('fact_revoke', { fact_id: fid, reason: 'fixture revoke' });
    else if (input.role === 'worker' && workerIndex === 1) {
      await assert.rejects(invoke('fact_submit', { ...candidate, projectId: 'other-project' }), { code: 'INVALID_INPUT' });
      const cwd = host.cwd; host.cwd = '/different-project';
      await assert.rejects(invoke('gm_search', { query: 'x' }), { code: 'CALLER_UNBOUND' }); host.cwd = cwd;
      await invoke('fact_submit', candidate);
      await assert.rejects(invoke('fact_submit', candidate), { code: 'SUBMISSION_ALREADY_PENDING' });
    } else if (input.role === 'verifier') {
      await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD);
    }
    return 'done';
  } });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); const result = await f.wait(run.runId); assert.equal(result.state, 'finished'); assert.deepEqual(result.verifiedFactIds, []);
  assert.ok(f.calls.core.every((c) => c.binding.projectId === 'fixture-project'));
});

test('stop during pending setup does not start a model after late receipt', async (t) => {
  const gate = deferred(); const f = await fixture(t, { prepareGate: gate }); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  // Await the explicit preparation call rather than polling.
  await f.preparing.promise; const stopped = f.service.stop(run.runId, origin); gate.resolve();
  const result = await stopped; assert.equal(result.state, 'stopped'); assert.equal(f.calls.starts.length, 0); assert.ok(f.calls.cores.every((c) => c.disposed));
});

test('late task creation is failed with a readable string and no model work', async (t) => {
  const gate = deferred(); const f = await fixture(t, { taskGate: gate });
  const running = f.service.run({ problem: 'fixture' }, origin);
  const rejected = assert.rejects(running, { code: 'RUN_INACTIVE' });
  const task = await f.taskCreated.promise;
  // Owner is not yet bound until create resolves; shutdown, not owner control,
  // exercises compensation of this genuinely late receipt.
  const stopping = f.service.dispose();
  gate.resolve(); await rejected; await stopping;
  assert.equal(task.status, 'failed'); assert.equal(typeof task.error, 'string');
  assert.match(task.error, /role=unknown; child=unknown; runId=run-/);
  assert.equal(f.calls.starts.length, 0);
});

test('root handler cancellation and late binding cannot send new inference', async (t) => {
  const gate = deferred(); const f = await fixture(t, { boundGate: gate }); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  await f.sessionCreating.promise;
  const reply = await f.handlers.get('math-research-once').abort(run.taskId); assert.equal(reply.status, 'stopping'); gate.resolve();
  const result = await f.wait(run.runId); assert.equal(result.state, 'stopped'); assert.equal(f.calls.starts.filter((s) => s.role === 'worker').length, 0);
});

test('restart reconciles owned sessions without replay; stale nonce cannot run', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin);
  const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`);
  const session = { sessionId: 'recover-session', path: '/private/recovery', ownerPluginId: 'hana-math', visibility: 'plugin_private', namespace: 'app', lifecycle: 'active', agentId: 'saved-worker', cwd: '/owned-fixture', kind: `math-research:${run.runId}:0` };
  meta.state = 'running'; meta.sessions.push({ role: 'worker', agentId: session.agentId, cwd: session.cwd, kind: session.kind, state: 'creating', sessionId: null });
  await f.store.write(`research/runs/${run.runId}/run.json`, JSON.stringify(meta), true);
  const g = await fixture(t, { tasks: f.tasks, schedules: f.schedules, hostSessions: new Map([[session.sessionId, session]]) }, f.dataDir);
  const recovered = await g.service.status(run.runId, origin); assert.equal(recovered.state, 'interrupted'); assert.equal(recovered.cleanupPending, false); assert.deepEqual(g.calls.abort, ['recover-session']);
  const stale = await g.handlers.get('math-research-once').run({ kind: 'schedule', input: f.calls.schedule[0].payload }); assert.equal(stale.status, 'ignored'); assert.equal(g.calls.starts.length, 0);
});

test('legacy failed run status exposes persisted child code without inference or rewriting task history', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin);
  await f.service.stop(run.runId, origin); await f.service.dispose();
  const location = `research/runs/${run.runId}/run.json`;
  const meta = await f.store.readJson(location);
  Object.assign(meta, { state: 'failed', phase: 'failed', error: { code: 'SESSION_NOT_COMPLETED', message: 'PRIVATE_MESSAGE', details: 'PRIVATE_DETAIL' },
    cleanupPending: false, finalizing: false, taskSettlementPending: false,
    lastResultError: { primary: { code: 'RESEARCH_RUNTIME_FAILED', runtime: { code: 'RESEARCH_RUNTIME_FAILED', phase: 'start',
      requestId: '12345678-1234-1234-1234-123456789abc', runtimeId: 'legacy-runtime',
      sdk: { code: 'APP_CAPABILITY_DENIED', operation: 'runtime.start', kind: 'permission', capability: 'app/runtime.execute', message: 'PRIVATE_SDK' },
      requests: Array.from({ length: 60 }, () => ({ primary: { code: 'RESEARCH_RUNTIME_FAILED', phase: 'watch', message: 'PRIVATE_REQUEST' } })),
      cleanup: { confirmed: false, errors: Array.from({ length: 50 }, () => ({ code: 'RPC_TIMEOUT', phase: 'cleanup-stop', message: 'PRIVATE_CLEANUP' })) },
      argv: ['PRIVATE_ARGV'], details: 'PRIVATE_DETAILS' } }, cleanup: { confirmed: true, error: null, message: 'PRIVATE_FINAL' } },
    cleanupErrors: [{ code: 'PRIVATE invalid code', message: 'PRIVATE_MESSAGE' }],
    selections: Object.fromEntries(['main', 'worker', 'verifier'].map((role) => [role, { agentId: `saved-${role}` }])),
    sessions: [{ role: 'main', sessionId: 'legacy-main', agentId: 'saved-main', state: 'failed', abortOutcome: 'idle-confirmed',
      error: 'MODEL_TURN_FAILED', sendState: 'accepted', modelStopReason: 'error', sessionPath: '/PRIVATE_PATH',
      prompt: 'PRIVATE_PROMPT', config: { secret: 'PRIVATE_CONFIG' }, transcript: 'PRIVATE_TRANSCRIPT', reasoning: 'PRIVATE_REASONING' },
    { role: 'worker', sessionId: 'legacy-empty', state: 'failed' }] });
  delete meta.runtimeCleanupPending; delete meta.runtimeCleanupError; // Actual legacy records predate the independent latch.
  await f.store.write(location, JSON.stringify(meta), true);
  const taskBefore = structuredClone(f.tasks.get(run.taskId));
  const g = await fixture(t, { tasks: f.tasks, schedules: f.schedules }, f.dataDir);
  const status = await g.service.status(run.runId, origin);
  assert.equal(status.error.code, 'SESSION_NOT_COMPLETED');
  assert.equal(status.error.message, 'SESSION_NOT_COMPLETED');
  assert.equal(status.lastResultError.primary.runtime.requests.length, 32);
  assert.equal(status.lastResultError.primary.runtime.cleanup.errors.length, 16);
  assert.equal(status.lastResultError.primary.runtime.sdk.operation, 'runtime.start');
  assert.equal(status.lastResultError.cleanup.confirmed, true);
  assert.equal(status.runtimeCleanupPending, false); assert.equal(status.runtimeCleanupError, null);
  assert.equal(status.cleanupErrors[0].code, 'RESEARCH_FAILED');
  assert.equal(status.cleanupErrors[0].message, 'RESEARCH_FAILED');
  assert.deepEqual(status.sessions[0], { role: 'main', sessionId: 'legacy-main', agentId: 'saved-main', state: 'failed',
    cleanupPending: false, abortOutcome: 'idle-confirmed', error: 'MODEL_TURN_FAILED', sendState: 'accepted', modelStopReason: 'error',
    phase: null, failurePhase: null, sdkError: null, actualModel: null });
  for (const key of ['agentId', 'error', 'sendState', 'modelStopReason', 'phase', 'failurePhase']) assert.equal(status.sessions[1][key], null);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|sessionPath|transcript|reasoning|prompt|config|details/);
  await assert.rejects(g.service.status(run.runId, { ...origin, sessionPath: '/foreign.jsonl' }), { code: 'OWNER_DENIED' });
  const setup = await g.service.setupStatus(run.runId, origin);
  assert.deepEqual(setup.roles.map((role) => role.agentId), ['saved-main', 'saved-worker', 'saved-verifier']);
  assert.deepEqual(g.tasks.get(run.taskId), taskBefore); assert.equal(g.calls.starts.length, 0);
  assert.equal(g.calls.cores.length, 0); assert.equal(g.calls.profiles.length, 0); assert.equal(g.calls.abort.length, 0);
});

test('normal child failure keeps structured run error and readable task root/role/child code', async (t) => {
  const f = await fixture(t, { turn: async () => { throw Object.assign(new Error('PRIVATE_MESSAGE'), { code: 'MODEL_TURN_FAILED' }); } });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  const status = await f.wait(run.runId);
  assert.equal(status.error.code, 'SESSION_NOT_COMPLETED'); assert.equal(status.error.message, status.error.code);
  assert.equal(status.sessions[0].error, 'MODEL_TURN_FAILED');
  assert.equal(f.tasks.get(run.taskId).error, `Hana Math: SESSION_NOT_COMPLETED; role=main; child=MODEL_TURN_FAILED; runId=${run.runId}`);
  assert.equal((await f.store.readJson(`research/runs/${run.runId}/run.json`)).error.code, 'SESSION_NOT_COMPLETED');
});

for (const [patch, code] of [
  [{ resolvedMode: 'standard' }, 'ROLE_TOOLS_REQUIRE_FULL'], [{ resolvedMode: null }, 'ROLE_TOOLS_REQUIRE_FULL'],
  [{ appEnabled: false }, 'ROLE_TOOLS_DISABLED'], [{ disabledTools: ['gm_add'] }, 'ROLE_TOOLS_DISABLED'],
]) test(`run refuses tool setup ${JSON.stringify(patch)} without config writes or model work`, async (t) => {
  let writes = 0; const f = await fixture(t, { toolStatus: { main: patch }, onToolMode: () => writes++ });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  const status = await f.wait(run.runId); assert.equal(status.error.code, code);
  assert.equal(writes, 0); assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.cores.length, 0);
  assert.equal(status.selections.main.agentId, 'saved-main');
});

test('setup reports capability session and unknown states and never replays a failed run', async (t) => {
  const behavior = { officialSdk: true, toolStatus: { main: { resolvedMode: 'standard' } }, capabilities: { capabilities: [
    { capability: 'app/agents.read', status: 'session', enforcement: 'hard', secret: 'PRIVATE_CAP' },
    { capability: 'app/agents.manage', status: 'always', enforcement: 'hard' },
    { capability: 'app/agents.manage', status: 'always', enforcement: 'hard' },
    { capability: 'app/resources.read', status: 'PRIVATE_STATUS', enforcement: 'hard' },
    { capability: 'private/secret', status: 'always', enforcement: 'hard' },
    { capability: 'app/runtime.execute', status: 'not_asked', enforcement: 'advisory' },
    { capability: 'app/tasks.manage', status: 'denied', enforcement: 'hard' },
  ] } };
  const f = await fixture(t, behavior); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId);
  await f.service.stop(run.runId, origin);
  const taskBefore = structuredClone(f.tasks.get(run.taskId));
  const status = await f.service.setupStatus(run.runId, origin);
  assert.equal(status.roles[0].resolvedMode, 'standard'); assert.equal(status.capabilities.length, 11);
  assert.deepEqual(status.capabilities[0], { capability: 'app/agents.read', status: 'session', enforcement: 'hard' });
  for (const item of status.capabilities.slice(1)) assert.equal(item.status, item.capability === 'app/runtime.execute' ? 'not_asked' : item.capability === 'app/tasks.manage' ? 'denied' : 'unknown');
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE|private\/secret|"config"|apiKey/);
  assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.cores.length, 0); assert.deepEqual(f.tasks.get(run.taskId), taskBefore);
  for (const action of [() => f.service.setupStatus(run.runId, { ...origin, sessionPath: '/foreign' }), () => f.service.setToolMode(run.runId, 'main', 'full', { ...origin, sessionPath: '/foreign' })]) await assert.rejects(action(), { code: 'OWNER_DENIED' });
  behavior.toolStatus.main.agentId = 'replacement';
  assert.equal((await f.service.setupStatus(run.runId, origin)).roles[0].error.code, 'ROLE_SELECTION_CONFLICT');
  assert.equal((await f.service.setToolMode(run.runId, 'main', 'full', origin)).error.code, 'ROLE_SELECTION_CONFLICT');
});

test('malformed capability envelopes stay unknown without starting or granting anything', async (t) => {
  const behavior = {}; const f = await fixture(t, behavior);
  const run = await f.service.run({ problem: 'fixture' }, origin);
  for (const value of [[], {}, { capabilities: 'PRIVATE_BAD' }, { error: { message: 'PRIVATE_ERROR' } },
    { capabilities: [{ capability: 'app/agents.read', status: 'always', enforcement: 'PRIVATE_BAD' }] }]) {
    behavior.capabilities = value;
    const result = await f.service.setupStatus(run.runId, origin);
    assert.ok(result.capabilities.every((item) => item.status === 'unknown'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.cores.length, 0);
});

test('explicit tool-mode mutation fences new run, result reads and concurrent setters until actual completion', async (t) => {
  const gate = deferred(); let entered = false;
  const f = await fixture(t, { toolStatus: { main: { resolvedMode: 'standard' } }, toolModeGate: gate, onToolMode: (role, id, mode) => {
    assert.equal(role, 'main'); assert.equal(id, 'saved-main'); assert.equal(mode, 'full'); entered = true;
  } });
  const run = await f.service.run({ problem: 'fixture' }, origin);
  await assert.rejects(f.service.setToolMode(run.runId, 'main', 'full', origin), { code: 'RESEARCH_UNSETTLED' });
  await f.dispatch(); await f.wait(run.runId); await f.service.stop(run.runId, origin);
  await f.waitIdle(run.runId);
  const writing = f.service.setToolMode(run.runId, 'main', 'full', origin);
  for (let n = 0; n < 100 && !entered; n++) await tick(); assert.equal(entered, true);
  try {
    await assert.rejects(f.service.run({ problem: 'new' }, origin), { code: 'CONFIGURATION_BUSY' });
    await assert.rejects(f.service.result(run.runId, undefined, origin), { code: 'CONFIGURATION_BUSY' });
    await assert.rejects(f.service.setToolMode(run.runId, 'worker', 'full', origin), { code: 'CONFIGURATION_BUSY' });
    assert.equal((await f.service.setupStatus(run.runId, origin)).roles[0].resolvedMode, 'standard');
  } finally { gate.resolve(); }
  assert.equal((await writing).saved, true);
  assert.equal((await f.service.setupStatus(run.runId, origin)).roles[0].resolvedMode, 'full');
  assert.equal(f.calls.starts.length, 0);
});

test('setup remains read-only while indeterminate cleanup blocks mutation', async (t) => {
  const f = await fixture(t, { coreDisposeError: true });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId);
  const before = structuredClone(f.calls.starts.length), aborts = f.calls.abort.length;
  assert.equal((await f.service.setupStatus(run.runId, origin)).roles.length, 3);
  assert.equal(f.calls.starts.length, before); assert.equal(f.calls.abort.length, aborts);
  await assert.rejects(f.service.setToolMode(run.runId, 'main', 'full', origin), { code: 'RESEARCH_UNSETTLED' });
});

for (const uncertain of [false, true]) test(`legacy actual Runtime result provenance survives frozen primary projection; cleanup unknown=${uncertain}`, async t => {
  const behavior = { turn: async () => { throw Object.assign(new Error('opaque stopped setup'), { code: 'MODEL_TURN_FAILED' }); } };
  const f = await fixture(t, behavior), run = await f.service.run({ problem: 'opaque software refusal fixture' }, origin);
  await f.dispatch(); await f.wait(run.runId); await f.waitIdle(run.runId); await f.service.stop(run.runId, origin);
  const originalError = (await f.store.readJson(`research/runs/${run.runId}/run.json`)).error;
  assert.equal(originalError.code, 'SESSION_NOT_COMPLETED');
  const real = await refusalFixture(t, { dataDir: f.dataDir }), reads = [];
  behavior.resultCore = () => { const bridge = real.create(); reads.push(bridge); return bridge; };
  const tools = new Map(); f.sdk.tools = { register: async tool => { tools.set(tool.name, tool); return () => {}; } };
  const registration = await registerMathResearch(f.sdk, f.service); t.after(() => registration.dispose());
  const open = fs.open;
  if (uncertain) { fs.open = async (...args) => { if (String(args[0]).endsWith('/.complete')) throw Object.assign(new Error('PRIVATE marker'), { code: 'EACCES' }); return open(...args); }; syncBuiltinESMExports(); }
  try {
    const reply = await tools.get('math_research').execute({ action: 'result', runId: run.runId, context: origin });
    assert.equal(reply.isError, true); assert.equal(reply.details.error.code, 'RESEARCH_RUNTIME_REJECTED');
    assert.equal(reply.details.error.rejection.reason, 'response-bytes'); assert.equal(reply.details.error.rejection.observation, 'at-refusal');
    assert.equal(reply.details.error.resultCleanup.confirmed, !uncertain); assert.equal(reply.details.error.runtime.cleanup.confirmed, !uncertain);
    assert.ok(!JSON.stringify(reply).includes('PRIVATE')); assert.equal(real.requests.length, 1); assert.equal(real.requests[0].operation, 'fact_list_page');
    const persisted = await f.store.readJson(`research/runs/${run.runId}/run.json`);
    assert.equal(runtimeRejectionInfo(persisted.lastResultError.primary.runtime), null);
    assert.ok(!JSON.stringify(persisted).includes('checked-facade-result'));
    assert.deepEqual(persisted.error, originalError);
  } finally { fs.open = open; syncBuiltinESMExports(); await Promise.all(reads.map(b => b.dispose())); await f.service.dispose(); }
});

for (const failRead of [true, false]) for (const failDispose of [true, false]) test(`result primary=${failRead} cleanup=${failDispose} preserves independent diagnostics and root error`, async (t) => {
  const primary = Object.assign(new Error('PRIVATE_PRIMARY'), { code: 'RESEARCH_RUNTIME_FAILED', phase: 'watch', operation: 'fact_list_page',
    requestId: '12345678-1234-1234-1234-123456789abc', runtimeId: 'runtime-fixture', startOutcome: 'acknowledged', processTerminalConfirmed: false,
    indeterminate: true, cleanup: { confirmed: false, errors: [] }, coreError: { secret: 'PRIVATE_CORE' },
    cause: { code: 'APP_HOST_ERROR', operation: 'runtime.watch', kind: 'host', capability: 'app/runtime.execute', message: 'PRIVATE_SDK' } });
  const secondary = Object.assign(new Error('PRIVATE_DISPOSE'), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED', phase: 'dispose', indeterminate: true,
    cleanup: { confirmed: false, errors: [{ code: 'RPC_TIMEOUT', phase: 'cleanup-stop' }] }, errors: [{ primary }] });
  const behavior = { turn: async () => { throw Object.assign(new Error('fixture'), { code: 'MODEL_TURN_FAILED' }); },
    ...(failRead ? { coreError: { operation: 'fact_list_page', error: primary } } : {}), ...(failDispose ? { readDisposeError: secondary } : {}),
    onReadDispose: () => { if (!failDispose) primary.cleanup.confirmed = true; } };
  const f = await fixture(t, behavior); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId); await f.service.stop(run.runId, origin);
  const before = await f.service.status(run.runId, origin), taskBefore = structuredClone(f.tasks.get(run.taskId));
  if (failRead || failDispose) await assert.rejects(f.service.result(run.runId, undefined, origin), (e) => e === (failRead ? primary : secondary));
  else assert.deepEqual((await f.service.result(run.runId, undefined, origin)).facts, []);
  const after = await f.service.status(run.runId, origin);
  assert.deepEqual(after.error, before.error); assert.deepEqual(f.tasks.get(run.taskId), taskBefore);
  assert.equal(after.cleanupPending, failDispose); assert.equal(after.indeterminate, before.indeterminate);
  assert.equal(after.runtimeCleanupPending, failDispose);
  if (!failDispose) assert.equal(after.runtimeCleanupError, null);
  assert.doesNotMatch(JSON.stringify(after), /PRIVATE|coreError|coreResult|argv/);
  if (failRead || failDispose) {
    assert.equal(after.lastResultError.cleanup.confirmed, !failDispose);
    assert.equal(after.lastResultError.primary?.runtime.runtimeId ?? null, failRead ? 'runtime-fixture' : null);
    if (failRead) {
      assert.equal(after.lastResultError.primary.runtime.cleanup.confirmed, false);
      assert.equal(after.lastResultError.primary.runtime.sdk.operation, 'runtime.watch');
      assert.equal(primary.resultCleanup.confirmed, !failDispose);
    }
    if (failDispose) {
      assert.equal(after.lastResultError.cleanup.error.runtime.phase, 'dispose');
      await assert.rejects(f.service.result(run.runId, undefined, origin), { code: 'RUN_UNSETTLED' });
    } else {
      behavior.coreError = null;
      await f.service.result(run.runId, undefined, origin);
      assert.equal((await f.service.status(run.runId, origin)).lastResultError, null);
    }
  } else assert.equal(after.lastResultError, null);
  await assert.rejects(f.service.result(run.runId, undefined, { ...origin, sessionPath: '/foreign' }), { code: 'OWNER_DENIED' });
});

test('SDK runtime stable codes survive service persistence, status and tool error DTO reprojection', async (t) => {
  const sdkError = new AppSdkError({ code: 'APP_RUNTIME_SANDBOX_UNAVAILABLE', operation: 'runtime.start', kind: 'unavailable',
    capability: 'app/runtime.execute', message: 'PRIVATE_SDK_MESSAGE', details: { path: 'PRIVATE_PATH' } });
  const cleanupFailure = { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED', phase: 'cleanup-start', cause: sdkError };
  const primary = Object.assign(new Error('PRIVATE_PRIMARY'), { code: 'RESEARCH_RUNTIME_FAILED', phase: 'start', operation: 'fact_list_page',
    requestId: '12345678-1234-1234-1234-123456789abc', runtimeId: null, startOutcome: 'unknown', processTerminalConfirmed: false,
    indeterminate: true, cause: sdkError, cleanup: { confirmed: false, errors: [cleanupFailure] },
    runtime: { code: 'APP_RUNTIME_SANDBOX_UNAVAILABLE', private: 'PRIVATE_NOT_A_MODULE_DTO' } });
  const secondary = Object.assign(new Error('PRIVATE_DISPOSE'), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED', phase: 'dispose',
    cleanup: { confirmed: false, errors: [cleanupFailure] }, errors: [{ primary }] });
  const expectedPrimary = runtimeFailureInfo(primary), expectedCleanup = runtimeFailureInfo(secondary);
  const f = await fixture(t, { coreError: { operation: 'fact_list_page', error: primary }, readDisposeError: secondary });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId); await f.service.stop(run.runId, origin);
  await assert.rejects(f.service.result(run.runId, undefined, origin), (error) => error === primary);
  const persisted = await f.store.readJson(`research/runs/${run.runId}/run.json`);
  const status = await f.service.status(run.runId, origin);
  assert.deepEqual(status.lastResultError, persisted.lastResultError);
  assert.deepEqual(status.lastResultError.primary.runtime, expectedPrimary);
  assert.deepEqual(status.lastResultError.cleanup.error.runtime, expectedCleanup);
  assert.equal(expectedPrimary.sdk.code, 'APP_RUNTIME_SANDBOX_UNAVAILABLE');
  assert.equal(expectedPrimary.cleanup.errors[0].sdk.code, 'APP_RUNTIME_SANDBOX_UNAVAILABLE');
  assert.equal(expectedCleanup.requests[0].primary.cleanup.errors[0].sdk.code, 'APP_RUNTIME_SANDBOX_UNAVAILABLE');
  assert.equal(expectedPrimary.startOutcome, 'unknown'); assert.equal(status.cleanupPending, true);
  const tools = new Map();
  const registration = await registerMathResearch({ dataDir: f.dataDir, tools: { register: async (tool) => { tools.set(tool.name, tool); return () => {}; } } },
    { ...f.service, result: async () => { throw { ...status.lastResultError.primary, resultCleanup: status.lastResultError.cleanup }; } });
  t.after(() => registration.dispose());
  const response = await tools.get('math_research').execute({ action: 'result', runId: run.runId, context: origin });
  assert.equal(response.isError, true);
  assert.deepEqual(response.details.error.runtime, expectedPrimary);
  assert.deepEqual(response.details.error.resultCleanup.error.runtime, expectedCleanup);
  assert.equal(response.details.error.resultCleanup.confirmed, false);
  assert.doesNotMatch(JSON.stringify([persisted.lastResultError, status.lastResultError, response]), /PRIVATE|coreError|coreResult|argv/);
});

test('a later successful result clears only lastResultError, never another read cleanup fence', async (t) => {
  const gate = deferred(); let reads = 0;
  const primary = Object.assign(new Error('fixture read'), { code: 'RESEARCH_RUNTIME_FAILED' });
  const secondary = Object.assign(new Error('fixture cleanup'), { code: 'RESEARCH_RUNTIME_CLEANUP_FAILED' });
  const behavior = { coreError: { operation: 'fact_list_page', error: primary }, readDisposeError: secondary,
    beforeCore: async ({ operation }) => { if (operation === 'fact_list_page' && ++reads === 2) await gate.promise; } };
  const f = await fixture(t, behavior); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId); await f.service.stop(run.runId, origin);
  const first = f.service.result(run.runId, undefined, origin);
  const rejected = assert.rejects(first, (error) => error === primary);
  const second = f.service.result(run.runId, undefined, origin);
  await rejected;
  assert.equal((await f.service.status(run.runId, origin)).cleanupPending, true);
  behavior.coreError = null; behavior.readDisposeError = null; gate.resolve(); await second;
  const status = await f.service.status(run.runId, origin);
  assert.equal(status.lastResultError, null); assert.equal(status.cleanupPending, true); assert.equal(status.runtimeCleanupPending, true);
  assert.equal(status.runtimeCleanupError.code, 'RESEARCH_RUNTIME_CLEANUP_FAILED');
  await assert.rejects(f.service.result(run.runId, undefined, origin), { code: 'RUN_UNSETTLED' });
  const confirmed = await f.service.stop(run.runId, origin);
  assert.equal(confirmed.runtimeCleanupPending, false); assert.equal(confirmed.runtimeCleanupError, null);
  assert.equal(confirmed.cleanupPending, false); assert.equal(confirmed.abortOutcome, 'confirmed');
});

test('in-flight result Core read blocks config mutation even for a finished run', async (t) => {
  const gate = deferred(); let entered = false;
  const f = await fixture(t, { beforeCore: async ({ operation }) => {
    if (operation === 'fact_list_page') { entered = true; await gate.promise; }
  } });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId); await f.service.stop(run.runId, origin);
  const reading = f.service.result(run.runId, undefined, origin);
  for (let n = 0; n < 100 && !entered; n++) await tick(); assert.equal(entered, true);
  try { await assert.rejects(f.service.setToolMode(run.runId, 'main', 'full', origin), { code: 'RESEARCH_UNSETTLED' }); }
  finally { gate.resolve(); }
  await reading;
});

test('uncertain restart cleanup blocks new runs', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin);
  const g = await fixture(t, { tasks: f.tasks, schedules: f.schedules, recoveryListError: true }, f.dataDir);
  assert.equal((await g.service.status(run.runId, origin)).cleanupPending, true);
  await assertFreshRunAllowed(g); assert.equal(g.calls.starts.length, 0);
});

test('completed verifier with valid matching JSON requires the normal stop reason', async (t) => {
  for (const verifierStopReason of ['length', 'toolUse', 'error', 'aborted', 'unknown', null, undefined]) {
    const f = await fixture(t, { verifierStopReason });
    const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
    const status = await f.wait(run.runId);
    assert.equal(status.state, 'failed', String(verifierStopReason));
    assert.equal(status.error.code, 'VERIFIER_NOT_NORMALLY_COMPLETED');
    assert.deepEqual(status.verifiedFactIds, []);
    assert.equal(f.calls.core.filter((c) => c.operation === 'fact_submit').length, 0);
    const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`);
    assert.deepEqual(await f.store.readJson(meta.submissions[0].reportFile), GOOD);
  }
});

test('result listing contains current graph metadata only, never proof bodies or a chosen final fact', async (t) => {
  const other = 'c'.repeat(16);
  const f = await fixture(t, { listFacts: [{ fact_id: other, predecessors: [fid], markdown: 'private full proof body', proof: 'extra body' }] });
  const run = await f.service.run({ problem: 'fixture' }, origin);
  assert.deepEqual(await f.service.result(run.runId, undefined, origin), { runId: run.runId, projectId: null, facts: [], page: null });
  assert.deepEqual(await f.service.result(run.runId, null, origin, { limit: 1 }), { runId: run.runId, projectId: null, facts: [], page: null });
  const cursor = Buffer.from(JSON.stringify({ asOf: 'a'.repeat(64), limit: 64, offset: 0, projectId: 'fixture-project', v: 1 })).toString('base64url');
  await assert.rejects(f.service.result(run.runId, null, origin, { cursor }), { code: 'FACT_PAGE_UNPREPARED' });
  assert.equal(f.calls.core.length, 0);
  await f.dispatch(); await f.wait(run.runId);
  const listed = await f.service.result(run.runId, null, origin, { limit: 2 });
  assert.deepEqual(listed, { runId: run.runId, projectId: 'fixture-project', ...fixtureFactPage([{ fact_id: other, predecessors: [fid], markdown: 'private full proof body', proof: 'extra body' }], { limit: 2 }) });
  const before = f.calls.core.length;
  await assert.rejects(f.service.result(run.runId, fid, origin, { limit: 1 }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.service.result(run.runId, null, { ...origin, sessionPath: '/foreign' }, { limit: 1 }), { code: 'OWNER_DENIED' });
  assert.equal(f.calls.core.length, before);
  assert.ok(!JSON.stringify(listed).includes('body'));
  assert.equal(f.calls.core.at(-1).operation, 'fact_list_page'); assert.ok(f.calls.cores.at(-1).disposed);
});

test('missing report and abnormal verifier completion never submit', async (t) => {
  for (const abnormal of [false, true]) {
    const f = await fixture(t, { turn: async ({ input, invoke, workerIndex }) => {
      if (input.role === 'main') await invoke('math_assign', { task: 'fixture' });
      if (input.role === 'worker' && workerIndex === 1) await invoke('fact_submit', candidate);
      if (input.role === 'verifier' && abnormal) { await invoke('math_verification_report', GOOD); throw new Error('fixture abnormal terminal'); }
      return JSON.stringify(GOOD);
    } });
    const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
    const status = await f.wait(run.runId); assert.equal(status.state, 'failed'); assert.deepEqual(status.verifiedFactIds, []);
    assert.equal(f.calls.core.filter((c) => c.operation === 'fact_submit').length, 0);
  }
});

test('saved-profile setup failure and expired queued permit cannot start a model', async (t) => {
  const f = await fixture(t, { profileError: true }); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  assert.equal((await f.wait(run.runId)).state, 'failed'); assert.equal(f.calls.starts.length, 0);
  const g = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const queued = await g.service.run({ problem: 'fixture', timeoutSeconds: 60 }, origin);
  t.mock.timers.tick(60000);
  assert.equal((await g.dispatch()).status, 'ignored');
  assert.equal((await g.wait(queued.runId)).state, 'failed'); assert.equal(g.calls.starts.length, 0);
});

test('unconfirmed session and core cleanup remain visible and block another run', async (t) => {
  const turn = deferred();
  const f = await fixture(t, { sessionCleanupPending: true, turn: async () => turn.promise });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.sessionStarted.promise;
  const status = await f.service.stop(run.runId, origin); turn.resolve('late ignored');
  assert.equal(status.cleanupPending, true); assert.equal(status.abortOutcome, 'unconfirmed');
  await assertFreshRunAllowed(f);
  const g = await fixture(t, { coreDisposeError: true }); const other = await g.service.run({ problem: 'fixture' }, origin); await g.dispatch();
  const final = await g.wait(other.runId); assert.equal(final.cleanupPending, true); assert.equal(final.indeterminate, true);
  assert.equal((await g.service.dispose()).cleanupPending, true);
});

test('new worker sessions retain the same run-private notes', async (t) => {
  let reread = false;
  const f = await fixture(t, { turn: async ({ input, invoke, workerIndex }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'fixture' });
    else if (input.role === 'worker' && workerIndex === 1) {
      await invoke('math_local_memory', { action: 'append', text: 'retained fixture note' }); await invoke('fact_submit', candidate);
    } else if (input.role === 'worker') { assert.equal((await invoke('math_local_memory', { action: 'read' })).text, 'retained fixture note'); reread = true; }
    else if (input.role === 'verifier') { await invoke('math_verification_report', BAD); return JSON.stringify(BAD); }
    return 'unverified worker wording is not truth';
  } });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); assert.equal((await f.wait(run.runId)).state, 'finished'); assert.equal(reread, true);
  assert.equal(f.calls.workspaces.filter((w) => w.role === 'worker').length, 1);
  assert.ok(!f.calls.starts.at(-1).prompt.includes('unverified worker wording is not truth'));
});

test('denied formal App handler registration has no alternative execution channel', async (t) => {
  const f = await fixture(t);
  f.sdk.tasks.registerHandler = async () => { throw Object.assign(new Error('not granted'), { code: 'APP_CAPABILITY_DENIED' }); };
  await assert.rejects(createResearchService(f.sdk, {
    contexts: { prepare() {}, prepareResearchWorkspace() {} }, profiles: { getRoleModel() {} },
    createCore() { throw new Error('must not create core'); }, sessions: { start() { throw new Error('must not create session'); } }, literature: { search() {} },
  }), { code: 'APP_CAPABILITY_DENIED' });
  assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.schedule.length, 0);
});

async function recoveredFixture(t, f, runId, patch = {}, behavior = {}) {
  const destination = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'research-crash-snapshot-')));
  await fs.cp(f.dataDir, destination, { recursive: true });
  const store = createContextStore(destination);
  const meta = { ...await store.readJson(`research/runs/${runId}/run.json`), ...patch };
  await store.write(`research/runs/${runId}/run.json`, JSON.stringify(meta), true);
  const cloneMap = (values) => new Map([...values].map(([id, value]) => [id, structuredClone(value)]));
  const g = await fixture(t, { tasks: cloneMap(f.tasks), schedules: cloneMap(f.schedules), hostSessions: cloneMap(f.hostSessions), ...behavior }, destination);
  t.after(() => fs.rm(destination, { recursive: true, force: true }));
  return g;
}

for (const operation of ['gm_add', 'fact_submit', 'fact_revoke', 'local_memory_append']) test(`durable in-flight ${operation} survives a crash and forbids replay`, async (t) => {
  const entered = deferred(), gate = deferred(); t.after(() => gate.resolve());
  const f = await fixture(t, {
    beforeCore: async (call) => { if (call.operation === operation) { entered.resolve(call); await gate.promise; } },
    turn: async ({ input, invoke, workerIndex }) => {
      if (input.role === 'main' && input.toolNames.includes('math_assign')) {
        if (operation === 'gm_add') await invoke('gm_add', { kind: 'observation', claim: 'fixture', evidence: 'fixture' });
        if (operation === 'fact_revoke') await invoke('fact_revoke', { fact_id: fid, reason: 'fixture' });
        await invoke('math_assign', { task: 'fixture' });
      } else if (input.role === 'worker' && workerIndex === 1) {
        if (operation === 'local_memory_append') await invoke('math_local_memory', { action: 'append', text: 'new fixture note' });
        else if (operation === 'fact_submit') await invoke('fact_submit', candidate);
      } else if (input.role === 'verifier') { await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD); }
      return 'done';
    },
  });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await entered.promise;
  const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`);
  assert.equal(meta.pendingMutations.length, 1); const marker = meta.pendingMutations[0]; assert.equal(marker.operation, operation);
  assert.match(marker.callTag, /^mutation-/); assert.equal((await f.store.readJson(marker.requestFile)).operation, operation);
  const g = await recoveredFixture(t, f, run.runId, { phase: 'overwritten-phase' });
  const recovered = await g.service.status(run.runId, origin); assert.equal(recovered.indeterminate, true);
  assert.equal(g.calls.starts.length, 0); assert.equal(g.calls.core.length, 0);
  await assertFreshRunAllowed(g);
  assert.equal((await g.store.readJson(`research/runs/${run.runId}/run.json`)).pendingMutations[0].callTag, marker.callTag);
  const stopping = f.service.stop(run.runId, origin); gate.resolve(); await stopping;
});

test('full facade error receipt is independent of metadata; definite rejection alone may settle a mutation', async (t) => {
  const coreResult = { accepted: true, fact_id: null, write_error: 'original write error' }, coreError = { code: 'write_error', mutationState: 'indeterminate' };
  const failure = Object.assign(new Error('facade rejected'), { code: 'RESEARCH_RUNTIME_REJECTED', requestId: 'original-core-request', indeterminate: true, coreError, coreResult, cleanup: { confirmed: true, errors: [] } });
  const f = await fixture(t, { coreError: { operation: 'fact_submit', error: failure } });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId);
  const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`); assert.equal(meta.pendingMutations.length, 1);
  const receipt = await f.store.readJson(meta.pendingMutations[0].receiptFile);
  assert.deepEqual(receipt.coreResult, coreResult); assert.deepEqual(receipt.coreError, coreError); assert.equal(receipt.error.requestId, failure.requestId);
  assert.ok(!JSON.stringify(meta).includes('original write error')); assert.equal(meta.indeterminate, true);
  const rejected = Object.assign(new Error('definite rejection'), { code: 'RESEARCH_RUNTIME_REJECTED', indeterminate: false, cleanup: { confirmed: true, errors: [] }, coreError: { code: 'forbidden' } });
  const g = await fixture(t, { coreError: { operation: 'gm_add', error: rejected }, turn: async ({ input, invoke }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) { await assert.rejects(invoke('gm_add', { kind: 'observation', claim: 'fixture', evidence: 'fixture' })); await invoke('math_assign', { task: 'fixture' }); }
    return 'done';
  } });
  const other = await g.service.run({ problem: 'fixture' }, origin); await g.dispatch(); assert.equal((await g.wait(other.runId)).state, 'finished');
  const settled = await g.store.readJson(`research/runs/${other.runId}/run.json`); assert.deepEqual(settled.pendingMutations, []); assert.equal(settled.indeterminate, false);
  const tags = await g.store.list(settled.mutationReceipts); assert.equal(tags.length, 1);
  assert.deepEqual((await g.store.readJson(`${settled.mutationReceipts}/${tags[0]}/receipt.json`)).coreError, { code: 'forbidden' });
});

for (const terminal of ['complete', 'fail']) test(`${terminal} checks task ID, owner and terminal status without rejecting business error fields`, async (t) => {
  for (const patch of [{ taskId: 'foreign' }, { pluginId: 'foreign' }, { status: 'running' }]) {
    const f = await fixture(t, { ...(terminal === 'fail' ? { noAssignment: true, failReceipt: patch } : { completeReceipt: patch }) });
    const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); const result = await f.wait(run.runId);
    assert.equal(result.cleanupPending, true); assert.equal(result.delivery.delivered, false); assert.equal(result.delivery.error.code, 'TASK_RECEIPT_MISMATCH');
  }
  if (terminal === 'fail') {
    const f = await fixture(t, { noAssignment: true }); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
    const result = await f.wait(run.runId); assert.equal(result.state, 'failed'); assert.equal(result.cleanupPending, false); assert.equal(result.delivery.state, 'staged');
  }
});

function recoverySession(f, runId) {
  const session = { sessionId: 'recover-known', path: '/private/recover-known', ownerPluginId: 'hana-math', visibility: 'plugin_private', namespace: 'app', lifecycle: 'active',
    agentId: 'saved-worker', cwd: `${f.dataDir}/context/projects/fixture-project/research/${runId}/worker`, kind: `math-research:${runId}:0` };
  f.hostSessions.set(session.sessionId, session);
  return { ...session, role: 'worker', state: 'completed', sendState: 'accepted', sendPending: false, modelStopReason: 'stop' };
}

function recoveredCoreTask(runId) {
  return { taskId: 'fixture-recovered-core', pluginId: 'hana-math', scope: 'app', delivery: 'none', parentSessionId: null, parentSessionPath: null,
    handlerKey: null, status: 'pending', metadata: { researchRunId: runId, researchTaskKind: 'core-execution' } };
}

test('recovery distinguishes a listed-first Core task from the legacy session root and never replays', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin), core = recoveredCoreTask(run.runId);
  f.tasks.set(core.taskId, core);
  const g = await recoveredFixture(t, f, run.runId, { state: 'running', coreTaskId: core.taskId, coreTaskSettlementPending: true }, { taskRows: (rows) => rows.reverse() });
  const status = await g.service.status(run.runId, origin), meta = await g.store.readJson(`research/runs/${run.runId}/run.json`);
  assert.equal(status.taskId, run.taskId); assert.equal(status.coreTaskId, core.taskId); assert.equal(meta.owner.sessionId, 'owner-stable-id');
  assert.equal(meta.owner.sessionPath, origin.sessionPath); assert.equal(status.coreTaskSettlementPending, false); assert.equal(status.cleanupPending, false);
  assert.equal(g.tasks.get(core.taskId).status, 'failed'); assert.equal(g.tasks.get(run.taskId).status, 'failed');
  assert.equal(g.calls.taskCreate.length, 0); assert.equal(g.calls.starts.length, 0); assert.equal(g.calls.cores.length, 0);
});

for (const behavior of [
  { taskRows: (rows) => rows.filter((task) => task.scope !== 'app') },
  { taskRows: (rows) => [...rows, rows.find((task) => task.scope === 'app')] },
  { taskListError: true }, { coreTaskGetReceipt: { scope: 'session' } },
]) test('missing, duplicate, failed or conflicting Core discovery retains recovery gates', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin), core = recoveredCoreTask(run.runId); f.tasks.set(core.taskId, core);
  const g = await recoveredFixture(t, f, run.runId, { state: 'running', coreTaskId: core.taskId, coreTaskSettlementPending: true }, behavior);
  const status = await g.service.status(run.runId, origin);
  assert.equal(status.taskId, run.taskId); assert.equal(status.coreTaskId, core.taskId); assert.equal(status.coreTaskSettlementPending, true); assert.equal(status.cleanupPending, true);
  await assertFreshRunAllowed(g);
  await assert.rejects(g.service.setToolMode(run.runId, 'main', 'full', origin), { code: 'RESEARCH_UNSETTLED' });
  assert.equal(g.calls.taskCreate.length, 1); assert.equal(g.calls.taskCreate[0].scope, 'session'); assert.equal(g.calls.cores.length, 0);
});

test('an orphan App Core task never supplies missing root task or originating owner identity', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin), core = recoveredCoreTask(run.runId); f.tasks.set(core.taskId, core);
  const g = await recoveredFixture(t, f, run.runId, { state: 'running', taskId: null, owner: null, taskCreatePending: true,
    coreTaskId: null, coreTaskCreatePending: true, coreTaskSettlementPending: true }, { taskRows: (rows) => rows.filter((task) => task.scope === 'app') });
  const meta = await g.store.readJson(`research/runs/${run.runId}/run.json`);
  assert.equal(meta.taskId, null); assert.equal(meta.owner, null); assert.equal(meta.coreTaskId, null);
  assert.equal(meta.taskCreatePending, true); assert.equal(meta.coreTaskCreatePending, true); assert.equal(meta.cleanupPending, true);
  assert.equal(g.tasks.get(core.taskId).status, 'failed'); assert.equal(g.tasks.get(run.taskId).status, 'pending');
  await assert.rejects(g.service.status(run.runId, origin), { code: 'OWNER_DENIED' });
  await assertFreshRunAllowed(g);
});

test('terminal Core authorization cannot clear persisted unknown runtime or mathematical mutation fences', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin), core = recoveredCoreTask(run.runId);
  core.status = 'failed'; f.tasks.set(core.taskId, core);
  const pendingMutations = [{ callTag: 'opaque-pending-mutation', operation: 'fact_submit' }];
  const unknown = { code: 'RESEARCH_RUNTIME_FAILED', runtime: { code: 'RESEARCH_RUNTIME_FAILED', phase: 'start', operation: 'fact_search',
    startOutcome: 'unknown', runtimeId: null, processTerminalConfirmed: false, indeterminate: true, cleanup: { confirmed: false, errors: [] }, requests: [] } };
  const g = await recoveredFixture(t, f, run.runId, { state: 'failed', coreTaskId: core.taskId, coreTaskSettlementPending: true,
    cleanupPending: true, indeterminate: true, error: unknown, pendingMutations, runtimeCleanupPending: undefined, runtimeCleanupError: undefined });
  const status = await g.service.status(run.runId, origin);
  assert.equal(status.coreTaskSettlementPending, true); assert.equal(status.cleanupPending, true); assert.equal(status.indeterminate, true);
  assert.equal(status.error.runtime.startOutcome, 'unknown'); assert.equal(status.runtimeCleanupPending, true);
  const stopped = await g.service.stop(run.runId, origin);
  assert.equal(stopped.cleanupPending, true); assert.equal(stopped.runtimeCleanupPending, true); assert.equal(stopped.abortOutcome, 'unconfirmed');
  assert.deepEqual(stopped.error, status.error); assert.equal(stopped.runtimeCleanupError.runtime.startOutcome, 'unknown');
  const meta = await g.store.readJson(`research/runs/${run.runId}/run.json`); assert.deepEqual(meta.pendingMutations, pendingMutations);
  const h = await recoveredFixture(t, g, run.runId);
  const again = await h.service.stop(run.runId, origin);
  assert.equal(again.runtimeCleanupPending, true); assert.equal(again.cleanupPending, true); assert.equal(again.abortOutcome, 'unconfirmed');
  assert.deepEqual(again.error, status.error); assert.equal(again.runtimeCleanupError.runtime.startOutcome, 'unknown');
  assert.equal(h.calls.cores.length, 0); assert.equal(h.calls.starts.length, 0);
  await assert.rejects(h.service.result(run.runId, undefined, origin), { code: 'RUN_UNSETTLED' });
  await assert.rejects(h.service.setToolMode(run.runId, 'main', 'full', origin), { code: 'RESEARCH_UNSETTLED' });
  await assertFreshRunAllowed(g);
  await assertFreshRunAllowed(h);
});

test('legacy cleanupErrors uncertainty survives truncation, repeated stop and another restart', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin);
  const unknown = { code: 'RESEARCH_RUNTIME_FAILED', runtime: { code: 'RESEARCH_RUNTIME_FAILED', phase: 'start', operation: 'gm_search',
    requestId: '12345678-1234-1234-1234-123456789abc', startOutcome: 'unknown', runtimeId: null, cleanup: { confirmed: false, errors: [] }, requests: [] } };
  const g = await recoveredFixture(t, f, run.runId, { state: 'failed', cleanupPending: true, indeterminate: true,
    error: { code: 'SESSION_NOT_COMPLETED' }, cleanupErrors: [unknown], runtimeCleanupPending: undefined, runtimeCleanupError: undefined }, { unscheduleError: true });
  for (let n = 0; n < 40; n++) {
    const status = await g.service.stop(run.runId, origin);
    assert.equal(status.runtimeCleanupPending, true); assert.equal(status.abortOutcome, 'unconfirmed');
    assert.equal(status.error.code, 'SESSION_NOT_COMPLETED');
  }
  const status = await g.service.status(run.runId, origin);
  assert.equal(status.cleanupErrors.length, 32); assert.equal(status.cleanupErrors.some((error) => error.runtime), false);
  assert.equal(status.runtimeCleanupError.runtime.requestId, unknown.runtime.requestId);
  assert.equal(status.runtimeCleanupError.runtime.startOutcome, 'unknown');
  const h = await recoveredFixture(t, g, run.runId, {}, { unscheduleError: false });
  const stopped = await h.service.stop(run.runId, origin);
  assert.equal(stopped.runtimeCleanupPending, true); assert.equal(stopped.cleanupPending, true); assert.equal(stopped.abortOutcome, 'unconfirmed');
  assert.equal(stopped.error.code, 'SESSION_NOT_COMPLETED'); assert.equal(stopped.runtimeCleanupError.runtime.startOutcome, 'unknown');
  assert.equal(h.calls.cores.length, 0);
});

test('a late runtime failure ORs indeterminate without replacing the first stop cause', async (t) => {
  const entered = deferred(), gate = deferred(); t.after(() => gate.resolve());
  const unknown = Object.assign(new Error('PRIVATE_LATE'), { code: 'RESEARCH_RUNTIME_FAILED', phase: 'start', startOutcome: 'unknown',
    indeterminate: true, cleanup: { confirmed: false, errors: [] } });
  const f = await fixture(t, { turn: async ({ invoke }) => { await invoke('gm_search', { query: 'fixture' }); },
    beforeCore: async ({ operation }) => { if (operation === 'gm_search') { entered.resolve(); await gate.promise; } },
    coreError: { operation: 'gm_search', error: unknown }, coreDisposeError: true });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await entered.promise;
  const stopping = f.service.stop(run.runId, origin);
  assert.equal((await f.service.status(run.runId, origin)).error.code, 'EXPLICIT_STOP');
  gate.resolve(); const result = await stopping;
  assert.equal(result.error.code, 'EXPLICIT_STOP'); assert.equal(result.indeterminate, true);
  assert.equal(result.runtimeCleanupPending, true); assert.equal(result.runtimeCleanupError.runtime.startOutcome, 'unknown');
  assert.equal(result.abortOutcome, 'unconfirmed'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_LATE/);
});

test('legacy final read-dispose failure without runtime metadata seeds a conservative latch', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin);
  const g = await recoveredFixture(t, f, run.runId, { state: 'failed', cleanupPending: true,
    runtimeCleanupPending: undefined, runtimeCleanupError: undefined,
    lastResultError: { primary: null, cleanup: { confirmed: false, error: { code: 'CONTROL_TIMEOUT' } } } });
  const status = await g.service.stop(run.runId, origin);
  assert.equal(status.runtimeCleanupPending, true); assert.equal(status.runtimeCleanupError.code, 'CONTROL_TIMEOUT');
  assert.equal(status.cleanupPending, true); assert.equal(status.abortOutcome, 'unconfirmed'); assert.equal(g.calls.cores.length, 0);
});

test('same-generation actual Core dispose can clear only runtime uncertainty, never mathematical pending markers', async (t) => {
  const failure = Object.assign(new Error('PRIVATE_RUNTIME'), { code: 'RESEARCH_RUNTIME_FAILED', phase: 'start', startOutcome: 'unknown',
    indeterminate: true, cleanup: { confirmed: false, errors: [] } });
  const behavior = { coreError: { operation: 'fact_submit', error: failure }, coreDisposeError: true };
  const f = await fixture(t, behavior); const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch(); await f.wait(run.runId);
  const failed = await f.service.stop(run.runId, origin);
  assert.equal(failed.runtimeCleanupPending, true); assert.equal(failed.cleanupPending, true); assert.equal(failed.abortOutcome, 'unconfirmed');
  const before = await f.store.readJson(`research/runs/${run.runId}/run.json`); assert.equal(before.pendingMutations.length, 1);
  behavior.coreDisposeError = false;
  const stopped = await f.service.stop(run.runId, origin);
  assert.equal(f.calls.cores.length, 1); assert.equal(stopped.runtimeCleanupPending, false); assert.equal(stopped.runtimeCleanupError, null);
  assert.equal(stopped.cleanupPending, false); assert.equal(stopped.abortOutcome, 'confirmed'); assert.equal(stopped.indeterminate, true);
  assert.deepEqual(stopped.error, failed.error); assert.doesNotMatch(JSON.stringify(stopped), /PRIVATE_RUNTIME/);
  const after = await f.store.readJson(`research/runs/${run.runId}/run.json`); assert.deepEqual(after.pendingMutations, before.pendingMutations);
  const g = await recoveredFixture(t, f, run.runId);
  assert.equal((await g.service.status(run.runId, origin)).runtimeCleanupPending, false);
  assert.equal((await g.service.status(run.runId, origin)).indeterminate, true);
  await assertFreshRunAllowed(g);
});

for (const fields of [
  { runtimeCleanupPending: 'true', runtimeCleanupError: null },
  { runtimeCleanupPending: true, runtimeCleanupError: null },
  { runtimeCleanupPending: false, runtimeCleanupError: { code: 'RESEARCH_FAILED' } },
  { runtimeCleanupPending: true, runtimeCleanupError: { code: 'PRIVATE/INVALID', message: 'PRIVATE' } },
  { runtimeCleanupPending: true, runtimeCleanupError: { code: 'RESEARCH_FAILED', message: 'RESEARCH_FAILED', indeterminate: false, path: 'PRIVATE' } },
]) test(`invalid persisted runtime latch is rejected: ${JSON.stringify(fields)}`, async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin);
  const g = await recoveredFixture(t, f, run.runId, fields);
  await assert.rejects(g.service.status(run.runId, origin), { code: 'RUN_NOT_FOUND' });
  const fresh = await assertFreshRunAllowed(g);
  assert.equal(fresh.recoveryWarnings[0].error.code, 'RECOVERY_RECORD_INVALID');
  assert.doesNotMatch(JSON.stringify(fresh.recoveryWarnings), /PRIVATE/);
  const stored = await g.store.readJson(`research/runs/${run.runId}/run.json`);
  for (const [key, value] of Object.entries(fields)) assert.deepEqual(stored[key], value);
});

test('recovery uses idle evidence and repeats unconfirmed stops, without clearing indeterminate', async (t) => {
  const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin); const entry = recoverySession(f, run.runId);
  const g = await recoveredFixture(t, f, run.runId, { state: 'running', sessions: [entry] }, { abortUnconfirmed: true });
  assert.equal((await g.service.status(run.runId, origin)).cleanupPending, false);
  assert.equal((await g.store.readJson(`research/runs/${run.runId}/run.json`)).sessions[0].abortOutcome, 'idle-confirmed');
  const h = await recoveredFixture(t, f, run.runId, { state: 'running', sessions: [entry], indeterminate: true }, { abortUnconfirmed: true, sessionContext: { isStreaming: true } });
  assert.equal((await h.service.status(run.runId, origin)).cleanupPending, true);
  h.sdk.sessions.context = async ({ sessionId }) => ({ sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: null, systemPrompt: null, model: null });
  const stopped = await h.service.stop(run.runId, origin); assert.equal(stopped.cleanupPending, false); assert.equal(stopped.indeterminate, true);
  await assertFreshRunAllowed(h);
  const unknown = await recoveredFixture(t, f, run.runId, { state: 'running', sessions: [{ ...entry, sendState: 'unconfirmed' }] }, { abortUnconfirmed: true });
  assert.equal((await unknown.service.status(run.runId, origin)).cleanupPending, true);
});

test('recovery candidate discovery never substitutes for get/list namespace and identity proof', async (t) => {
  for (const behavior of [
    { getProjectionPatch: { namespace: undefined } }, { getProjectionPatch: { namespace: 'home' } },
    { getProjectionPatch: { kind: 'conflicting-public-kind' } }, { listProjectionPatch: { namespace: 'home' } },
    { listProjectionPatch: { lifecycle: 'archived' } }, { duplicateSessionRows: true }, { sessionInfoListError: true },
  ]) {
    const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin); const entry = recoverySession(f, run.runId);
    const g = await recoveredFixture(t, f, run.runId, { state: 'running', sessions: [{ ...entry, sessionId: null }] }, { officialSdk: true, ...behavior });
    assert.equal((await g.service.status(run.runId, origin)).cleanupPending, true);
    assert.deepEqual(g.calls.abort, []); assert.equal(g.calls.starts.length, 0);
    if (behavior.listProjectionPatch?.namespace === 'home') assert.equal(g.calls.bus.some((c) => c.verb === 'session:get'), false);
    await assertFreshRunAllowed(g);
  }
});

test('damaged-run discovery with namespace omitted still requires get to prove App ownership', async (t) => {
  const f = await fixture(t); const runId = 'run-damaged-projection';
  await f.store.mkdir(`research/runs/${runId}`); await f.store.write(`research/runs/${runId}/run.json`, '{broken');
  recoverySession(f, runId);
  const g = await fixture(t, { officialSdk: true, hostSessions: f.hostSessions, getProjectionPatch: { namespace: 'home' } }, f.dataDir);
  assert.equal(g.calls.bus.some((c) => c.verb === 'session:get'), true);
  assert.deepEqual(g.calls.abort, []); assert.equal(g.calls.starts.length, 0);
  await assertFreshRunAllowed(g);
  assert.equal((await f.store.read(`research/runs/${runId}/run.json`)).toString(), '{broken');
});

test('cold recovery progress counts terminal and damaged-record queries only, without affecting cleanup', async t => {
  const samples = [], order = [];
  const createService = (sdk, options) => {
    const register = sdk.tasks.registerHandler;
    sdk.tasks.registerHandler = (...args) => { order.push('register'); return register(...args); };
    return createResearchService(sdk, { ...options, onRecoveryProgress(sample) {
      order.push('progress'); samples.push(sample);
      if (sample.reconciledRuns === 0) throw new Error('fixture observer threw');
      return Promise.reject(new Error('fixture observer rejected'));
    } });
  };
  const f = await fixture(t, { createService });
  const counts = ({ reconciledRuns, listQueries, getQueries, deliveryQueries, historicalSessionAbortAttempts }) =>
    [reconciledRuns, listQueries, getQueries, deliveryQueries, historicalSessionAbortAttempts];
  assert.deepEqual(samples.map(counts), [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]);
  assert.deepEqual(order, ['progress', 'progress', 'register']);
  const run = await f.service.run({ problem: 'opaque progress fixture' }, origin);
  await f.service.stop(run.runId, origin); await f.service.dispose();
  const terminal = `research/runs/${run.runId}/run.json`, before = await f.store.read(terminal);
  const damagedId = 'run-progress-damaged', damaged = `research/runs/${damagedId}/run.json`;
  await f.store.write(damaged, '{broken');
  const child = recoverySession(f, damagedId);
  const task = { taskId: 'damaged-progress-task', pluginId: 'hana-math', status: 'running', scope: 'session', delivery: 'next-step',
    parentSessionId: 'owner-stable-id', parentSessionPath: origin.sessionPath, metadata: { researchRunId: damagedId } };
  f.tasks.set(task.taskId, task);
  samples.length = 0; order.length = 0;
  const g = await fixture(t, { createService, tasks: f.tasks, hostSessions: f.hostSessions }, f.dataDir);
  assert.deepEqual(samples.map(sample => sample.reconciledRuns), [0, 1, 2]);
  // Terminal: 3 discovery lists + get/delivery. Damaged: 4 discovery lists,
  // one identity list, a session get, a task get and an abort attempt. The task fail isn't counted.
  assert.deepEqual(counts(samples.at(-1)), [2, 8, 3, 1, 1]);
  assert.deepEqual(order, ['progress', 'progress', 'progress', 'register']);
  for (const [i, sample] of samples.entries()) {
    assert.ok(Object.isFrozen(sample));
    assert.deepEqual(Object.keys(sample).sort(), ['deliveryQueries', 'elapsedMs', 'getQueries', 'historicalSessionAbortAttempts', 'listQueries', 'reconciledRuns']);
    assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= (samples[i - 1]?.elapsedMs ?? 0));
  }
  assert.deepEqual(g.calls.abort, [child.sessionId]);
  assert.deepEqual(g.calls.lifecycle, [`fail:${task.taskId}`]);
  assert.equal(task.status, 'failed');
  const status = await g.service.stop(run.runId, origin);
  assert.ok(status.recoveryWarnings.some(w => w.runId === damagedId));
  assert.equal(samples.length, 3); // Explicit stop is outside cold recovery.
  assert.deepEqual(await f.store.read(terminal), before);
  assert.equal((await f.store.read(damaged)).toString(), '{broken');
});

test('recovery task failures still abort known owned sessions and never claim delivery', async (t) => {
  for (const behavior of [{ taskListError: true, scheduleListError: true, recoveryListError: true }, { failReceipt: { taskId: 'foreign' } }, { failReceipt: { status: 'running' } }]) {
    const f = await fixture(t); const run = await f.service.run({ problem: 'fixture' }, origin); const entry = recoverySession(f, run.runId);
    const g = await recoveredFixture(t, f, run.runId, { state: 'running', sessions: [entry] }, behavior);
    const recovered = await g.service.status(run.runId, origin); assert.equal(recovered.cleanupPending, true); assert.equal(recovered.delivery.delivered, false);
    assert.deepEqual(g.calls.abort, [entry.sessionId]); assert.equal(g.calls.starts.length, 0);
  }
});

test('incomplete and corrupt historical run metadata warn without blocking a fresh run or overwriting evidence', async (t) => {
  for (const corrupt of [null, '{bad json', '{}']) {
    const f = await fixture(t); const runId = 'run-corrupt';
    await f.store.mkdir(`research/runs/${runId}`);
    if (corrupt !== null) await f.store.write(`research/runs/${runId}/run.json`, corrupt);
    const session = recoverySession(f, runId);
    const task = { taskId: 'damaged-task', pluginId: 'hana-math', status: 'running', scope: 'session', delivery: 'next-step', parentSessionId: 'owner-stable-id', parentSessionPath: origin.sessionPath, metadata: { researchRunId: runId } };
    const core = recoveredCoreTask(runId);
    const g = await fixture(t, { hostSessions: f.hostSessions, tasks: new Map([[core.taskId, core], [task.taskId, task]]) }, f.dataDir);
    assert.equal(core.status, 'failed'); assert.equal(task.status, 'failed');
    assert.equal(task.error, `Hana Math: RECOVERY_RECORD_INVALID; role=unknown; child=unknown; runId=${runId}`);
    const fresh = await assertFreshRunAllowed(g); assert.equal(fresh.recoveryWarnings.length, 1);
    assert.deepEqual(g.calls.abort, [session.sessionId]); assert.equal(g.calls.starts.length, 0);
    const errors = await f.store.readJson('research/recovery-errors.json'); assert.equal(errors.blocked, false); assert.equal(errors.errors[0].runId, runId);
    if (corrupt !== null) assert.equal((await f.store.read(`research/runs/${runId}/run.json`)).toString(), corrupt);
    else await assert.rejects(f.store.read(`research/runs/${runId}/run.json`), { code: 'ENOENT' });
  }
});

test('verifier receives complete bodies and predecessor locators, while metadata stays with candidate storage and Core', async (t) => {
  const submitted = { ...candidate, statement: ' \r\n  原样 fixture statement \t\n', proof: ' \t' + '原样-proof-'.repeat(12000) + '  ',
    predecessors: [fid], glossary_introduces: { fixture_symbol: 'opaque-glossary-7b01819e' }, external_refs: [{ arxiv_id: 'opaque-reference-8c12920f', theorem_id: 'fixture-id' }], intuition: 'opaque-intuition-9d23a310', source_id: 'opaque-source-ae34b421' };
  assert.ok(Buffer.byteLength(submitted.proof) > 32768); let sawFullBody = false;
  const f = await fixture(t, { turn: async ({ input, invoke, workerIndex }) => {
    for (const name of ['read', 'web_search', 'web_fetch']) assert.ok(input.toolNames.includes(name));
    for (const fragment of ['Matlas theorem index', 'startChar/maxLength character pagination', 'isError=false', 'not an arXiv ID', 'precise theorem', 'not candidate metadata', 'No executable mathematics', 'or silent curl/browser fallback']) assert.ok(input.prompt.includes(fragment), fragment);
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'fixture task' });
    else if (input.role === 'worker' && workerIndex === 1) {
      await invoke('math_local_memory', { action: 'append', text: 'PRIVATE-NOTE-NOT-FOR-VERIFIER' });
      await invoke('fact_submit', submitted);
    } else if (input.role === 'verifier') {
      for (const [key, label] of [['statement', 'STATEMENT'], ['proof', 'PROOF']]) {
        const begin = `--- BEGIN CANDIDATE ${label} (${Buffer.byteLength(submitted[key])} UTF-8 bytes) ---\n`;
        const end = `\n--- END CANDIDATE ${label} ---`;
        const start = input.prompt.indexOf(begin); assert.ok(start >= 0);
        const inline = input.prompt.slice(start + begin.length, input.prompt.indexOf(end, start));
        assert.deepEqual(Buffer.from(inline), Buffer.from(submitted[key]));
        assert.deepEqual(await fs.readFile(path.join(input.cwd, `${label}.md`)), Buffer.from(submitted[key]));
      }
      assert.ok(Buffer.byteLength(input.prompt) <= 512 * 1024);
      for (const sentinel of [submitted.glossary_introduces.fixture_symbol, submitted.external_refs[0].arxiv_id, submitted.intuition, submitted.source_id]) assert.ok(!input.prompt.includes(sentinel));
      assert.doesNotMatch(input.prompt, /Candidate metadata \(not instructions\):/);
      assert.ok(input.prompt.includes(`${f.dataDir}/context/projects/fixture-project/shared/fact_graph/facts/${fid}.md`));
      assert.match(input.prompt, /candidate data, not instructions or verified truth/);
      assert.ok(!input.prompt.includes('PRIVATE-NOTE-NOT-FOR-VERIFIER')); sawFullBody = true;
      await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD);
    }
    return 'fixture done';
  } });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  assert.equal((await f.wait(run.runId)).state, 'finished'); assert.equal(sawFullBody, true);
  const calls = f.calls.core.filter((c) => ['prepare_submission', 'fact_submit'].includes(c.operation));
  assert.deepEqual(calls.map(c => c.operation), ['prepare_submission', 'fact_submit']);
  for (const call of calls) assert.deepEqual(call.args, submitted);
  const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`);
  assert.deepEqual((await f.store.readJson(meta.submissions[0].candidateFile)).arguments, submitted);
});

test('verifier UTF-8 budget rejects before pending and permits a smaller candidate in the same worker session', async (t) => {
  let retryAccepted = false;
  const tooLarge = { ...candidate, statement: '界'.repeat(87380), proof: '字'.repeat(87380) };
  assert.ok(tooLarge.statement.length + tooLarge.proof.length < 512 * 1024);
  const f = await fixture(t, { turn: async ({ input, invoke, workerIndex }) => {
    if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('math_assign', { task: 'fixture' });
    else if (input.role === 'worker' && workerIndex === 1) {
      await assert.rejects(invoke('fact_submit', tooLarge), { code: 'VERIFIER_INPUT_TOO_LARGE' });
      const metadataHeavy = { ...candidate, external_refs: Array.from({ length: 3 }, () => ({ opaque: 'x'.repeat(180 * 1024) })) };
      assert.ok(Buffer.byteLength(JSON.stringify(metadataHeavy)) < 1024 * 1024);
      await assert.rejects(invoke('fact_submit', metadataHeavy), { code: 'VERIFIER_INPUT_TOO_LARGE' });
      await assert.rejects(invoke('fact_submit', { ...candidate, external_refs: [...metadataHeavy.external_refs, ...metadataHeavy.external_refs] }), { code: 'JSON_LIMIT' });
      assert.equal(f.calls.core.filter((c) => c.operation === 'prepare_submission').length, 0);
      assert.equal(f.calls.starts.filter((s) => s.role === 'verifier').length, 0);
      const meta = await f.store.readJson(`research/runs/${input.kind.split(':')[1]}/run.json`); assert.deepEqual(meta.submissions, []);
      const pending = await invoke('fact_submit', candidate); assert.equal(pending.pending, true); retryAccepted = true;
    } else if (input.role === 'verifier') { await invoke('math_verification_report', GOOD); return JSON.stringify(GOOD); }
    return 'fixture done';
  } });
  const run = await f.service.run({ problem: 'fixture' }, origin); await f.dispatch();
  assert.equal((await f.wait(run.runId)).state, 'finished'); assert.equal(retryAccepted, true);
  assert.equal(f.calls.starts.filter((s) => s.role === 'verifier').length, 1);
  const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`); assert.equal(meta.submissions.length, 1);
});

test('successful mutation receipt cannot clear its durable fence when the clearing metadata rename fails', async (t) => {
  let marker, injected = 0, seenReceipt;
  const f = await fixture(t, {
    beforeCore: async ({ binding, operation }) => {
      if (operation === 'gm_add') marker = (await f.store.readJson(`research/runs/${binding.runId}/run.json`)).pendingMutations[0];
    },
    turn: async ({ input, invoke }) => {
      if (input.role === 'main' && input.toolNames.includes('math_assign')) await invoke('gm_add', { kind: 'observation', claim: 'fixture', evidence: 'fixture' });
      return 'done';
    },
  });
  const run = await f.service.run({ problem: 'fixture' }, origin);
  const originalRename = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (source, destination) => {
    if (marker && injected === 0 && destination === path.join(f.dataDir, `research/runs/${run.runId}/run.json`)) {
      const saving = JSON.parse(await fs.readFile(source, 'utf8'));
      if (saving.pendingMutations.length === 0) {
        seenReceipt = await f.store.readJson(marker.receiptFile);
        assert.equal(seenReceipt.ok, true); assert.equal(seenReceipt.operation, 'gm_add');
        injected++;
        throw Object.assign(new Error('fixture clearing metadata rename failed'), { code: 'EIO' });
      }
    }
    return originalRename(source, destination);
  });
  syncBuiltinESMExports();
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); }; t.after(restore);
  await f.dispatch(); const status = await f.wait(run.runId); restore();
  assert.equal(injected, 1); assert.deepEqual(seenReceipt.result, { results: [] });
  assert.equal(status.state, 'failed'); assert.equal(status.indeterminate, true);
  const meta = await f.store.readJson(`research/runs/${run.runId}/run.json`);
  assert.equal(meta.pendingMutations.length, 1); assert.equal(meta.pendingMutations[0].callTag, marker.callTag);
  assert.equal(meta.indeterminate, true); assert.deepEqual(await f.store.readJson(marker.receiptFile), seenReceipt);
  const g = await recoveredFixture(t, f, run.runId);
  assert.equal((await g.service.status(run.runId, origin)).indeterminate, true);
  await assertFreshRunAllowed(g);
  assert.equal(g.calls.starts.length, 0); assert.equal(g.calls.core.length, 0);
});

const dispatchModel = { provider: 'saved-provider', id: 'override-model' };
const dispatchCatalog = { models: ['main', 'worker', 'verifier'].map(role => ({ provider: 'saved-provider', id: `${role}-model`, thinkingLevels: ['high'] })).concat([{ ...dispatchModel, thinkingLevels: ['high'], customThinkingLevels: ['xhigh'] }]) };
const thinkingGrant = { capability: 'app/session.thinking-level', status: 'always', enforcement: 'hard' };

test('worker dispatch preflight is read-only, model-only skips capabilities and explicit thinking fails closed', async t => {
  const behavior = { realContexts: true, catalog: dispatchCatalog }, f = await fixture(t, behavior);
  await f.prepareWorker('dispatch-preflight', 'worker-1');
  assert.deepEqual(await f.service.validateWorkerDispatch({ model: dispatchModel }), { model: dispatchModel });
  assert.equal(behavior.capabilityReads, undefined);
  for (const [capabilities, code] of [
    [[], 'CAPABILITY_STATUS_INVALID'],
    [[thinkingGrant, thinkingGrant], 'CAPABILITY_STATUS_INVALID'],
    [[{ ...thinkingGrant, status: 'unknown' }], 'CAPABILITY_STATUS_INVALID'],
    [[{ ...thinkingGrant, status: 'session' }], 'THINKING_LEVEL_NOT_GRANTED'],
    [[{ ...thinkingGrant, enforcement: 'advisory' }], 'THINKING_LEVEL_NOT_GRANTED'],
  ]) {
    behavior.capabilities = { capabilities };
    let rejected;
    await assert.rejects(f.service.startWorkerRun({ projectId: 'dispatch-preflight', workerId: 'worker-1', model: dispatchModel, thinkingLevel: 'high' }, origin), error => { rejected = error; return error.code === code; });
    assert.equal(f.service.isWorkerAdmissionRejection(rejected), true);
    assert.equal(f.service.isWorkerAdmissionRejection(new Error(code)), false);
  }
  behavior.capabilityError = new Error('ordinary SDK failure');
  await assert.rejects(f.service.validateWorkerDispatch({ thinkingLevel: 'high' }), { code: 'CAPABILITY_STATUS_UNAVAILABLE' });
  assert.equal(f.calls.taskCreate.length, 0); assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.schedule.length, 0);
});

for (const code of ['ROLE_MISSING', 'CONTROL_TIMEOUT']) test(`worker dispatch second preflight marks only its original ${code} error without allocating a run`, async t => {
  const behavior = { realContexts: true, catalog: dispatchCatalog }, f = await fixture(t, behavior);
  await f.prepareWorker('dispatch-recheck', 'worker-1');
  await f.service.validateWorkerDispatch({ model: dispatchModel });
  const error = Object.assign(new Error(code), { code }); behavior.profileError = error;
  await assert.rejects(f.service.startWorkerRun({ projectId: 'dispatch-recheck', workerId: 'worker-1', model: dispatchModel }, origin), actual => actual === error);
  assert.equal(f.service.isWorkerAdmissionRejection(error), true);
  assert.equal(f.service.isWorkerAdmissionRejection(Object.assign(new Error(code), { code })), false);
  assert.equal(f.calls.taskCreate.length, 0); assert.equal(f.calls.schedule.length, 0);
  const allocated = await fs.readdir(path.join(f.dataDir, 'research/runs')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  assert.deepEqual(allocated, []);
  delete behavior.profileError;
  const job = await f.service.startWorkerRun({ projectId: 'dispatch-recheck', workerId: 'worker-1', model: dispatchModel }, origin);
  assert.deepEqual(job.selections.worker.model, dispatchModel);
});

test('worker dispatch actual research runs isolate two workers and model-only never reads a thinking grant', async t => {
  const behavior = { realContexts: true, catalog: dispatchCatalog, capabilities: { capabilities: [thinkingGrant] } }, f = await fixture(t, behavior);
  await f.prepareWorker('dispatch-independent', 'worker-1'); await f.prepareWorker('dispatch-independent', 'worker-2');
  const workerPolicy = { maxRounds: 1, roundDelaySeconds: 0 };
  const first = await f.service.startWorkerRun({ projectId: 'dispatch-independent', workerId: 'worker-1', model: dispatchModel, thinkingLevel: 'high', workerPolicy }, origin);
  const reads = behavior.capabilityReads; behavior.capabilityError = new Error('model-only must not query capability');
  const secondModel = { provider: 'saved-provider', id: 'worker-model' };
  const second = await f.service.startWorkerRun({ projectId: 'dispatch-independent', workerId: 'worker-2', model: secondModel, workerPolicy }, origin);
  assert.equal(behavior.capabilityReads, reads);
  for (const job of [first, second]) await f.dispatch(f.calls.schedule.find(call => call.payload.runId === job.runId).payload);
  const statuses = await Promise.all([f.waitIdle(first.runId), f.waitIdle(second.runId)]);
  for (const status of statuses) assert.equal(status.state, 'finished');
  assert.deepEqual(statuses[0].selections.worker.model, dispatchModel); assert.equal(statuses[0].selections.worker.thinkingLevel, 'high');
  assert.deepEqual(statuses[1].selections.worker.model, secondModel); assert.equal(Object.hasOwn(statuses[1].selections.worker, 'thinkingLevel'), false);
  const workers = f.calls.starts.filter(s => s.role === 'worker');
  assert.equal(workers.length, 2); assert.ok(workers.some(s => s.selection.thinkingLevel === 'high' && s.selection.model.id === dispatchModel.id));
  assert.ok(workers.some(s => s.selection.model.id === secondModel.id && !Object.hasOwn(s.selection, 'thinkingLevel')));
});

test('worker dispatch snapshots survive later catalog changes and verifier keeps its saved model', async t => {
  const behavior = { realContexts: true, catalog: dispatchCatalog, capabilities: { capabilities: [thinkingGrant] } }, f = await fixture(t, behavior);
  await f.prepareWorker('dispatch-snapshot', 'worker-1');
  const job = await f.service.startWorkerRun({ projectId: 'dispatch-snapshot', workerId: 'worker-1', model: dispatchModel, thinkingLevel: 'xhigh', workerPolicy: { maxRounds: 1, roundDelaySeconds: 0 } }, origin);
  assert.deepEqual(job.selections.worker.model, dispatchModel); assert.equal(job.selections.worker.thinkingLevel, 'xhigh');
  await f.dispatch(); const status = await f.wait(job.runId);
  assert.equal(status.state, 'finished');
  const worker = f.calls.starts.find(s => s.role === 'worker'), verifier = f.calls.starts.find(s => s.role === 'verifier');
  assert.deepEqual(worker.selection.model, dispatchModel); assert.equal(worker.selection.thinkingLevel, 'xhigh');
  assert.deepEqual(verifier.selection.model, { provider: 'saved-provider', id: 'verifier-model' }); assert.equal(Object.hasOwn(verifier.selection, 'thinkingLevel'), false);
  assert.equal(status.sessions.find(s => s.role === 'worker').reportedThinkingLevel, 'xhigh');
  assert.equal(Object.hasOwn(status.sessions.find(s => s.role === 'verifier'), 'thinkingLevel'), false);
  behavior.catalog = { models: [] };
  assert.deepEqual((await f.service.projectWorkerStatus('dispatch-snapshot', job.runId)).selections.worker, job.selections.worker);
});

test('late schedule acknowledgement is cleaned and duplicate dispatcher cannot replay', async (t) => {
  const gate = deferred(), summarized = deferred(); const f = await fixture(t, { autoDispatch: true, scheduleGate: gate, onSummary: () => summarized.resolve() });
  const pending = f.service.run({ problem: 'fixture' }, origin); pending.catch(() => {}); await f.taskCreated.promise;
  // Model work may finish before schedule RPC acknowledges; cleanup waits for the receipt.
  await summarized.promise; gate.resolve(); const run = await pending; await f.wait(run.runId);
  assert.ok(f.calls.unschedule.length >= 1); assert.equal((await f.dispatch()).status, 'ignored');
  assert.equal(f.calls.starts.filter((s) => s.role === 'verifier').length, 1);
  await f.service.stop(run.runId, origin);
});
