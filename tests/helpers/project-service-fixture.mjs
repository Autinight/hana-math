// Software-only Host/worker/Core fixtures. No real model, network or private data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fixtureFactPage } from '../fact-page-fixture.mjs';
import { createContextService } from '../../packages/hana-math/context-service.mjs';
import { createProjectService } from '../../packages/hana-math/project-service.mjs';

export const APP = 'hana-math';
export const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
export const origin = { callToken: 'opaque-origin-token', sessionPath: '/fixture/creator.jsonl' };

export async function fixture(t, behavior = {}) {
  const multiWorker = behavior.multiWorker === true;
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'math-project-service-')));
  const tasks = new Map(), schedules = new Map(), handlers = new Map(), host = new Map(), selections = new Map(), completions = new Map(), configuredModels = new Map();
  const calls = { tasks: [], schedules: [], unschedules: [], sessions: [], sends: [], starts: [], stops: [], core: [], factories: [], literature: [], gets: [], lists: [], contexts: [] };
  const diskProjection = row => { const projected = structuredClone(row); projected.modelId = null; delete projected.modelProvider; return projected; };
  const agents = [{ id: 'saved-main', state: 'active', deletedAt: null, ownerPluginId: APP, visibility: 'plugin_private',
    plugin: { ownerPluginId: APP, visibility: 'plugin_private', kind: 'role', roleId: 'main' } }];
  host.set(origin.sessionPath, { sessionId: 'creator-stable', path: origin.sessionPath, agentId: 'ordinary-user-agent', namespace: behavior.creatorNamespace ?? 'home', visibility: 'public', ownerPluginId: null, lifecycle: 'active' });
  const profiles = { getRoleModel: async role => { assert.equal(role, 'main'); return { role, source: 'saved-role', instanceState: 'active', agentId: 'saved-main', model: { provider: 'fixture-provider', id: 'fixture-model' } }; },
    getRoleToolStatus: async (role, options) => { assert.equal(role, 'main'); assert.deepEqual(options, { additionalAppTools: ['math_project', 'math_goal_main'] }); return { role, agentId: 'saved-main', resolvedMode: 'full', appEnabled: true, disabledTools: [] }; } };
  const sdk = { dataDir,
    bus: { async subscribe(listener, options) {
      assert.ok(host.has(options.sessionPath)); assert.deepEqual(options.types, ['agent_start', 'agent_end', 'turn_end', 'error']);
      return Object.assign(() => {}, { ready: Promise.resolve() });
    } },
    agents: { list: async () => ({ agents: structuredClone(agents) }) },
    models: { listAvailable: async () => ({ models: [{ provider: 'fixture-provider', id: 'fixture-model' }] }) },
    tools: { list: async ({ scope }) => {
      assert.equal(scope, 'own'); return ['gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems', 'math_assign', 'math_project', 'math_goal', 'math_goal_main'].map(name => ({ name, source: { kind: 'app', appId: APP }, availability: { registered: true } }));
    } },
    sessions: {
      async get({ sessionId, sessionPath }) {
        calls.gets.push({ sessionId, sessionPath });
        const value = sessionPath ? host.get(sessionPath) : [...host.values()].find(s => s.sessionId === sessionId);
        if (value?.ownerPluginId !== APP) throw Object.assign(new Error('own access cannot read external sessions'), { code: 'SESSION_ACCESS_DENIED' });
        return { session: diskProjection(value) };
      },
      async context(input) {
        assert.deepEqual(Object.keys(input), ['sessionId']); calls.contexts.push(structuredClone(input));
        const row = [...host.values()].find(value => value.sessionId === input.sessionId);
        if (row?.ownerPluginId !== APP || !configuredModels.has(input.sessionId)) throw Object.assign(new Error('unknown or external configuration'), { code: 'SESSION_ACCESS_DENIED' });
        if (behavior.contextError) throw Object.assign(new Error('opaque private context failure'), { code: 'HOST_CONTEXT_FAILED' });
        return { sessionId: input.sessionId, model: structuredClone(configuredModels.get(input.sessionId)),
          ...(behavior.recoveryIdle ? { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } : {}) };
      },
      async list(input) {
        calls.lists.push(input); assert.equal(input.scope, 'own'); assert.equal(input.lifecycle, 'all'); assert.equal(input.ownerPluginId, APP);
        if (!input.agentId && behavior.ownListError) throw behavior.ownListError;
        if (!input.agentId && Object.hasOwn(behavior, 'ownListResponse')) return structuredClone(behavior.ownListResponse);
        return { sessions: [...host.values()].filter(s => s.ownerPluginId === APP && (!input.agentId || s.agentId === input.agentId)).map(diskProjection) };
      },
      async create(input) {
        calls.sessions.push(input); assert.equal(input.agentId, 'saved-main'); assert.equal(input.namespace, 'home'); assert.equal(input.memoryEnabled, false);
        if (behavior.createError) throw Object.assign(new Error('opaque create uncertainty'), { code: 'HOST_CREATE_UNKNOWN' });
        const sessionId = `main-${calls.sessions.length}`, sessionPath = `/fixture/${sessionId}.jsonl`;
        const row = { sessionId, path: sessionPath, agentId: input.agentId, cwd: input.cwd, namespace: 'home', visibility: 'public', ownerPluginId: APP,
          kind: input.kind, lifecycle: 'active', modelId: null };
        host.set(sessionPath, row); configuredModels.set(sessionId, structuredClone(input.model));
        return { ok: true, ...structuredClone(row), sessionPath, modelId: input.model.id, modelProvider: input.model.provider };
      },
      async setActiveTools({ sessionId, toolNames }) {
        assert.ok([...host.values()].some(s => s.sessionId === sessionId && s.ownerPluginId === APP));
        const available = new Set(['read', 'web_search', 'web_fetch', 'subagent', 'subagent_reply', 'subagent_message', 'subagent_close', 'wait_for_tasks', 'current_status', 'loop_control', 'gm_add', 'gm_search', 'fact_search', 'fact_revoke', 'search_arxiv_theorems', 'math_assign', 'math_project', 'math_goal_main']);
        if (behavior.missingNative) available.delete(behavior.missingNative);
        if (new Set(toolNames).size !== toolNames.length || toolNames.some(name => !available.has(name))) {
          const missing = toolNames.filter(name => !available.has(name));
          throw Object.assign(new Error(`setSessionActiveTools: requested tools are unavailable for this session: ${missing.join(', ')}`),
            { code: 'APP_HOST_ERROR', operation: 'session:set-active-tools' });
        }
        selections.set(sessionId, [...toolNames]); return { sessionId, toolNames: [...toolNames], effective: 'current', pendingToolNames: null };
      },
      async getToolSelection({ sessionId }) { if (behavior.toolSelectionError) throw Object.assign(new Error('private fixture text must not reach task display'), { code: 'HOST_TOOL_SELECTION_FAILED' });
        return behavior.goalToolsPending ? { sessionId, toolNames: [], effective: 'next-turn', pendingToolNames: selections.get(sessionId) }
          : { sessionId, toolNames: selections.get(sessionId), effective: 'current', pendingToolNames: null }; },
      async send(input) { calls.sends.push(input); if (behavior.sendError) throw Object.assign(new Error('opaque send uncertainty'), { code: 'HOST_SEND_UNKNOWN' });
        const row = [...host.values()].find(s => s.sessionId === input.sessionId); return { accepted: true, sessionId: row.sessionId, sessionPath: row.path }; },
      abort() { assert.fail('visible main must not be aborted'); }, delete() { assert.fail('visible main must not be deleted'); },
      subscribe() { assert.fail('main conversation must not be monitored'); },
    },
    tasks: {
      async registerHandler(key, value) { handlers.set(key, value); const dispose = Object.assign(() => handlers.delete(key), { ready: Promise.resolve() });
        if (behavior.disposeHandler) dispose.disposeAsync = async () => { await behavior.disposeHandler(key); dispose(); }; return dispose; },
      async create(input) {
        calls.tasks.push(input); assert.ok(!Object.hasOwn(input, 'parentSessionId')); assert.ok(!Object.hasOwn(input, 'parentSessionPath'));
        if (input.scope === 'session') assert.equal(input.callToken, origin.callToken);
        else { assert.equal(input.scope, 'app'); assert.equal(input.delivery, 'none'); assert.equal(input.callToken, undefined); }
        const taskId = `task-${tasks.size + 1}`, row = { ...input, taskId, pluginId: APP, status: 'pending',
          parentSessionId: input.scope === 'session' ? 'creator-stable' : null, parentSessionPath: input.scope === 'session' ? origin.sessionPath : null };
        tasks.set(taskId, row); return structuredClone(row);
      },
      async get(id) { return structuredClone(tasks.get(id)); },
      ...(multiWorker ? { async getDelivery() { return { state: 'published', delivered: false }; } } : {}),
      async schedule(input) { calls.schedules.push(input); const scheduleId = `schedule-${calls.schedules.length}`, row = { ...input, intervalMs: input.intervalMs ?? null, scheduleId, pluginId: APP }; schedules.set(scheduleId, row);
        behavior.onSchedule?.(row);
        if (behavior.autoDispatch) await handlers.get(input.handlerKey).run({ kind: 'schedule', ...(behavior.handlerWithoutScheduleId ? {} : { scheduleId }), input: input.payload });
        if (behavior.scheduleReceiptGate) await behavior.scheduleReceiptGate.promise;
        return structuredClone(row); },
      async getSchedule(id) { return structuredClone(schedules.get(id) ?? null); },
      async unschedule(id) {
        calls.unschedules.push(id); behavior.onUnschedule?.(id);
        if (behavior.unscheduleGate) await behavior.unscheduleGate.promise;
        if (behavior.unscheduleError || !schedules.has(id)) throw Object.assign(new Error('Host schedule deletion failed or schedule not found'), { code: 'APP_HOST_ERROR' });
        schedules.delete(id); return { ok: true };
      },
      async complete(id, result) { const row = tasks.get(id); row.status = row.scope === 'session' && behavior.completeUnconfirmed ? 'pending' : 'completed'; row.result = result; if (row.scope === 'session') completions.get(row.metadata.projectId)?.resolve(); return structuredClone(row); },
      async fail(id, error) { const row = tasks.get(id); row.status = 'failed'; if (row.scope === 'session') assert.equal(typeof error, 'string'); row.error = String(error); if (row.scope === 'session') completions.get(row.metadata.projectId)?.resolve(); return structuredClone(row); },
    },
  };
  const contexts = createContextService(sdk), jobs = new Map(), contextWrites = new Set();
  for (const name of ['prepare', 'prepareProjectWorkspace']) {
    const prepare = contexts[name];
    contexts[name] = (...args) => {
      const write = prepare(...args);
      contextWrites.add(write);
      write.finally(() => contextWrites.delete(write)).catch(() => {});
      return write;
    };
  }
  const statusOf = (projectId, runId) => { const value = jobs.get(runId); assert.equal(value.projectId, projectId); return structuredClone(value); };
  const research = {
    async startWorkerRun(input, ctx, options) {
      calls.starts.push({ input: structuredClone(input), context: ctx });
      assert.equal(typeof options.assertAdmission, 'function');
      const file = path.join(dataDir, 'research/projects', input.projectId, 'project.json');
      const meta = JSON.parse(await fs.readFile(file));
      const worker = multiWorker ? [meta.worker, ...(meta.extraWorkers ?? [])].find(value => value.workerId === input.workerId) : meta.worker;
      assert.equal(worker.start.state, 'pending');
      behavior.onAdmission?.();
      if (behavior.admissionGate) await behavior.admissionGate.promise;
      if (behavior.checkLateAdmission) options.assertAdmission();
      if (behavior.admissionError) throw Object.assign(new Error('opaque pre-admission refusal'), { code: behavior.admissionError });
      const runId = `run-${calls.starts.length}`, row = { ...input, runId, mode: 'project-worker', state: 'running', coordinatorActive: true,
        cleanupPending: false, runtimeCleanupPending: false, indeterminate: false, finalizing: false, coreTaskCreatePending: false, coreTaskSettlementPending: false,
        resourceBlocked: false, taskCreatePending: false, taskSettlementPending: false, schedulePending: false, recoveryUnsettled: false, theoremEstablished: false };
      jobs.set(runId, row);
      if (behavior.startGate) await behavior.startGate.promise;
      if (behavior.startError) throw Object.assign(new Error('opaque start uncertainty'), { code: behavior.startErrorCode ?? 'START_UNKNOWN', ...(behavior.knownRun ? { runId } : {}) });
      return structuredClone(row);
    },
    async projectWorkerStatus(projectId, runId) { return statusOf(projectId, runId); },
    projectWorkerDiagnostic(projectId, runId) {
      const value = statusOf(projectId, runId);
      assert.equal(value.runId, runId); assert.equal(value.mode, 'project-worker');
      return { ...value, pendingMutationCount: Object.hasOwn(value, 'pendingMutationCount') ? value.pendingMutationCount
        : Array.isArray(value.pendingMutations) ? value.pendingMutations.length : 0,
        unsettledMutation: Object.hasOwn(value, 'unsettledMutation') ? value.unsettledMutation : !!value.pendingMutations?.length,
        recoveryWarnings: (value.recoveryWarnings ?? []).filter(warning => warning.runId === runId)
          .map(warning => ({ runId, error: { code: warning.error.code } })) };
    },
    async projectWorkerRecheck(identity, { guard }) {
      calls.rechecks ??= []; calls.rechecks.push(structuredClone(identity)); guard();
      if (behavior.recheckHook) await behavior.recheckHook(identity);
      guard();
      return { ...identity, state: 'unknown', code: 'RECHECK_NOT_NEEDED', recoveryUnsettledBefore: false, recoveryUnsettledAfter: false,
        initiated: false, joined: false, recheckPending: false, mutationAttempts: { scheduleRemove: 0, sessionAbort: 0, taskFail: 0 } };
    },
    async projectVerificationReads(identity, options) {
      calls.readAudits ??= []; calls.readAudits.push(structuredClone(identity));
      await options.recheck(); if (behavior.auditHook) await behavior.auditHook(identity); await options.recheck();
      return { schemaVersion: 1, action: 'verification_reads', coverage: 'not-needed', ...identity };
    },
    async stopProjectWorker(projectId, runId, options) {
      calls.stops.push({ projectId, runId, options: structuredClone(options) }); const row = jobs.get(runId); assert.equal(row.projectId, projectId);
      // Software projection fixture only: not evidence of the research runtime's round-boundary implementation.
      if (behavior.roundBoundaryStop && row.workerPolicy && !options.force) { row.stopRequested = true; return statusOf(projectId, runId); }
      if (multiWorker && !options.force && behavior.stopIgnores?.has(row.workerId)) return statusOf(projectId, runId);
      row.state = 'stopped'; row.coordinatorActive = false; return statusOf(projectId, runId);
    },
  };
  const createCore = options => {
    calls.factories.push(options); assert.equal(tasks.get(options.taskId).scope, 'app');
    if (behavior.createCore) return behavior.createCore(options);
    return { async call(binding, operation, args) {
      calls.core.push({ binding, operation, args }); assert.equal(binding.role, 'main'); assert.equal(binding.author, 'saved-main');
      if (behavior.coreCall) {
        const value = await behavior.coreCall(binding, operation, args, dataDir);
        // Adapt row-only software behaviors to the new facade wire contract.
        // Explicit coreReply remains raw for malformed-receipt tests.
        return operation === 'fact_list_page' && Array.isArray(value?.facts) && !Object.hasOwn(value, 'page')
          ? fixtureFactPage(value.facts, args, binding.projectId) : value;
      }
      if (behavior.coreUncertain) throw Object.assign(new Error('opaque mutation uncertainty'), { code: 'OPAQUE_MUTATION_FAILED', indeterminate: true, cleanup: { confirmed: true } });
      if (Object.hasOwn(behavior, 'coreReply')) return structuredClone(behavior.coreReply);
      if (operation === 'fact_list_page') return fixtureFactPage([{ fact_id: 'a'.repeat(16), predecessors: [] }], args, binding.projectId);
      if (operation === 'fact_get') return { fact_id: args.fact_id, markdown: 'opaque canonical full fixture', predecessors: [] };
      return { opaque: operation, accepted: true };
    }, async dispose() { return { confirmed: true }; } };
  };
  const literature = { async search(...args) { calls.literature.push(args); return { query: args[0], results: [] }; } };
  let service;
  async function open() { service = await createProjectService(sdk, { contexts, profiles, research, createCore, literature,
    ...(multiWorker && behavior.summaryWriter ? { summaryWriter: behavior.summaryWriter } : {}) }); return service; }
  await open();
  t.after(async () => {
    await service.dispose();
    // A setup deadline settles the task, not the underlying filesystem writer.
    while (contextWrites.size) await Promise.allSettled([...contextWrites]);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  async function create(input = { problem: '  opaque 用户输入\r\n', operatorProfile: 'opaque 操作者\t' }) {
    const queued = await service.create(input, origin); assert.equal(queued.state, 'queued');
    const done = defer(); completions.set(queued.projectId, done);
    const schedule = [...schedules.values()].find(s => s.payload.projectId === queued.projectId);
    assert.equal((await handlers.get(schedule.handlerKey).run({ kind: 'schedule', scheduleId: schedule.scheduleId, input: schedule.payload })).status, 'started');
    await done.promise;
    const status = await service.status(queued.projectId, origin);
    const context = status.main?.sessionPath ? { callToken: 'opaque-main-token', sessionPath: status.main.sessionPath } : null;
    return { queued, status, context, projectId: queued.projectId };
  }
  return { get service() { return service; }, open, create, contexts, profiles, sdk, host, agents, tasks, schedules, handlers, calls, jobs, completions, dataDir, behavior, research };
}
