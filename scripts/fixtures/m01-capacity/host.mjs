// SOFTWARE Host/session adapter adapted from tests/main-goal-worker-integration.test.mjs
// fixture (not imported: importing a node:test file would execute its tests).
// Real ProjectService queueCore, ResearchService coreCall, Runtime and Python IPC.
// These are opaque fixture identities, NOT real Host Appctx or authorization tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { errorRecord } from './gates.mjs';
import { markRuntimeError, markWrapper, toolFailure, disposalReport } from './observations.mjs';
import { createProjectService } from '../../../packages/hana-math/project-service.mjs';
import { createResearchService } from '../../../packages/hana-math/research-service.mjs';
import { createResearchSessions } from '../../../packages/hana-math/research-sessions.mjs';
import { createContextService } from '../../../packages/hana-math/context-service.mjs';
import { createProfileService } from '../../../packages/hana-math/profile-service.mjs';
import { createResearchRuntime } from '../../../packages/hana-math/runtime/research-runtime.mjs';
import { registerMathResearch } from '../../../packages/hana-math/research-tools.mjs';

const clone = structuredClone, APP = 'hana-math';
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function deadline(promise, label, ms = 180000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`M01 deadline: ${label}`)), ms); })]).finally(() => clearTimeout(timer));
}
export function good(reply) {
  if (reply.isError) throw toolFailure(reply.details?.error ?? { code: 'OPAQUE_TOOL_FAILURE' });
  return reply.details;
}

export async function createFixture({ dataDir, packageRoot, runtimeStart, wrapCore, workerTurn, verifierEvent, monitor, diagnostics = {} }) {
  const scope = new AsyncLocalStorage(), tools = new Map(), handlers = new Map(), schedules = new Map(), tasks = new Map();
  const hosts = new Map(), contexts = new Map(), subscriptions = new Set(), processes = new Map(), events = new Map();
  const jobs = [], errors = [], calls = { core: [], tools: [], verifier: [] }, admitted = new Map();
  for (const key of ['starts', 'dispatches', 'progress', 'adapterErrors', 'taskFailures', 'snapshots', 'cleanupErrors']) diagnostics[key] ??= [];
  diagnostics.progressOmitted ??= 0;
  const progress = record => {
    if (diagnostics.progress.length < 256) diagnostics.progress.push({ at: Date.now(), runId: scope.getStore()?.runId ?? null, ...record });
    else diagnostics.progressOmitted++;
  };
  function caught(source, error) {
    const runId = scope.getStore()?.runId ?? null;
    if (source === 'core-facade' || source.startsWith('sdk.runtime.')) markRuntimeError(error, source);
    else markWrapper(error, source);
    diagnostics.adapterErrors.push({ at: Date.now(), runId, ...errorRecord(error), boundarySource: source });
    monitor?.capture(runId, error);
    // Only these confirmed fatal participant boundaries abort immediately.
    // Generic SDK/Core observations (including recoverable busy) remain capture-only.
    if (source === 'scripted-turn' || source === 'createCore') monitor?.participantFailed(runId, error);
    return error;
  }
  function adapter(source, action) {
    return function (...args) {
      progress({ source, stage: 'begin' });
      try {
        const result = Reflect.apply(action, this, args);
        if (result && typeof result.then === 'function') return result.then(value => { progress({ source, stage: 'returned' }); return value; }, error => { throw caught(source, error); });
        progress({ source, stage: 'returned' }); return result;
      } catch (error) { throw caught(source, error); }
    };
  }
  let research, project, registration;
  const event = key => { if (!events.has(key)) events.set(key, deferred()); return events.get(key); };
  const wait = key => deadline(event(key).promise, key);
  const roles = ['main', 'worker', 'verifier'];
  const agents = roles.map(role => ({ id: `saved-${role}`, state: 'active', deletedAt: null, ownerPluginId: APP, visibility: 'plugin_private', plugin: { ownerPluginId: APP, visibility: 'plugin_private', kind: 'role', roleId: role } }));
  const model = agentId => ({ provider: 'opaque-provider', id: `${agentId}-model` });
  function hostContext(session) {
    const context = Object.freeze({ callToken: `opaque-software-token-${session.sessionId}`, sessionPath: session.path });
    contexts.set(context.callToken, context); return context;
  }
  const creator = { sessionId: 'opaque-creator', path: path.join(dataDir, 'opaque-host/creator.jsonl'), agentId: 'ordinary-fixture-agent', namespace: 'home', visibility: 'public', ownerPluginId: null, lifecycle: 'active' };
  hosts.set(creator.sessionId, creator); const origin = hostContext(creator);
  async function tool(name, args, ctx = origin) {
    assert.equal(contexts.get(ctx.callToken), ctx); assert.equal(Object.hasOwn(args, 'context'), false); assert.ok(tools.has(name));
    return scope.run({ kind: 'model-tool', context: ctx, runId: scope.getStore()?.runId }, async () => {
      const result = await tools.get(name).execute({ ...clone(args), context: ctx });
      assert.deepEqual(JSON.parse(result.content[0].text), result.details);
      calls.tools.push({ name, sessionPath: ctx.sessionPath, isError: result.isError, details: clone(result.details) });
      if (name === 'math_project' && args.action === 'start') {
        diagnostics.starts.push({ at: Date.now(), projectId: args.projectId, workerId: args.workerId, receipt: clone(result.details), isError: result.isError });
        if (!result.isError && result.details.runId) admitted.set(result.details.runId, { projectId: args.projectId, taskId: result.details.taskId });
      }
      return result;
    });
  }
  const sessionRow = session => { const { context, turn, aborted, ...row } = session; return clone(row); };
  async function emit(session, data) {
    for (const item of [...subscriptions]) if (item.filter.sessionPath === session.path && item.filter.types.includes(data.type)) item.callback({ ...data, sessionId: session.sessionId }, session.path);
  }
  async function scriptedTurn(session) {
    await emit(session, { type: 'agent_start' }); let text = 'opaque software fixture turn completed';
    if (session.agentId === 'saved-worker') await workerTurn(session, tool);
    else if (session.agentId === 'saved-verifier') {
      // This verifier reports only. No Core call, fake worker binding or added tool.
      const report = { verification_report: { summary: 'opaque software verifier, not mathematical validation', critical_errors: [], gaps: [] }, verdict: 'correct', repair_hints: '' };
      const record = { kind: 'logical-verifier-report', sessionId: session.sessionId, at: Date.now(), coreAuthority: false };
      calls.verifier.push(record); verifierEvent(record);
      good(await tool('math_verification_report', report, session.context)); text = JSON.stringify(report);
    }
    if (session.aborted) return;
    session.streaming = false;
    await emit(session, { type: 'message_end', message: { role: 'assistant', content: text, stopReason: 'stop' } });
    await emit(session, { type: 'agent_end', messages: [{ role: 'assistant', content: text, stopReason: 'stop' }] });
    await emit(session, { type: 'turn_end', aborted: false });
  }
  const sdk = { dataDir,
    tools: {
      async register(def) { assert.ok(!tools.has(def.name)); tools.set(def.name, def); return () => tools.delete(def.name); },
      async list() { return [...tools.values()].map(def => ({ name: def.name, source: { kind: 'app', appId: APP }, availability: { registered: true } })); },
    },
    agents: {
      async list() { return { agents: clone(agents) }; },
      async config({ agentId }) { assert.ok(agents.some(a => a.id === agentId)); return { config: { tool_call_mode: 'full', agent: { name: agentId }, models: { chat: model(agentId) } } }; },
      async createFromRole() { assert.fail('no real roles or cloning'); }, async updateConfig() { assert.fail('no role edits'); },
    },
    models: { async listAvailable() { return { models: agents.map(a => model(a.id)) }; } },
    storage: { global: {
      async get(key, fallback) { const role = roles.find(r => key === `profile.role.${r}`); return role ? { agentId: `saved-${role}` } : fallback; },
      async set() { assert.fail('no saved role writes'); },
    } },
    sessions: {
      async create(input) {
        assert.equal(scope.getStore()?.kind, 'app'); assert.equal(input.memoryEnabled, false);
        const isMain = input.agentId === 'saved-main'; assert.equal(input.namespace, isMain ? 'home' : 'app'); assert.deepEqual(input.model, model(input.agentId));
        const sessionId = `opaque-session-${hosts.size}`;
        const session = { sessionId, path: path.join(dataDir, 'opaque-host', sessionId + '.jsonl'), agentId: input.agentId, cwd: input.cwd, kind: input.kind,
          ownerPluginId: APP, visibility: isMain ? 'public' : 'plugin_private', namespace: input.namespace, lifecycle: 'active', streaming: false, turn: 0 };
        session.context = hostContext(session); hosts.set(sessionId, session);
        return { ok: true, ...sessionRow(session), sessionPath: session.path, sessionRef: { sessionId, sessionPath: session.path }, modelId: input.model.id, modelProvider: input.model.provider };
      },
      async get({ sessionId, sessionPath }) { const value = sessionId ? hosts.get(sessionId) : [...hosts.values()].find(s => s.path === sessionPath); assert.equal(value?.ownerPluginId, APP); return { session: sessionRow(value) }; },
      async list(input) { return { sessions: [...hosts.values()].filter(s => s.ownerPluginId === APP && (!input?.agentId || s.agentId === input.agentId)).map(sessionRow) }; },
      async context({ sessionId }) { const s = hosts.get(sessionId); return { sessionId, model: model(s.agentId), isStreaming: s.streaming, isCompacting: false, pendingMessageCount: 0 }; },
      async setActiveTools({ sessionId, toolNames }) {
        const allowed = new Set(['read', 'web_search', 'web_fetch', 'subagent', 'subagent_reply', 'subagent_message', 'subagent_close', 'wait_for_tasks', 'current_status', 'loop_control', ...tools.keys()]);
        assert.equal(new Set(toolNames).size, toolNames.length); assert.ok(toolNames.every(n => allowed.has(n)));
        hosts.get(sessionId).toolNames = [...toolNames]; return { sessionId, toolNames: [...toolNames], effective: 'current', pendingToolNames: null };
      },
      async getToolSelection({ sessionId }) { return { sessionId, toolNames: [...hosts.get(sessionId).toolNames], effective: 'current', pendingToolNames: null }; },
      async send(input) {
        const s = hosts.get(input.sessionId); assert.equal(s.ownerPluginId, APP); s.turn++;
        if (s.agentId !== 'saved-main') {
          s.streaming = true;
          const job = new Promise(r => setImmediate(r)).then(() => scriptedTurn(s)).catch(async error => {
            errors.push(error); caught('scripted-turn', error); s.streaming = false;
            await emit(s, { type: 'agent_end', messages: [{ role: 'assistant', content: 'opaque fixture failure', stopReason: 'error' }] });
            throw error;
          });
          job.catch(() => {}); // passive observer; jobs retains the original rejection for allSettled/diagnosis
          jobs.push(job);
        }
        return { accepted: true, sessionId: s.sessionId, sessionPath: s.path, sessionRef: { sessionId: s.sessionId, sessionPath: s.path } };
      },
      async abort({ sessionId }) { const s = hosts.get(sessionId); assert.notEqual(s.agentId, 'saved-main'); s.aborted = true; s.streaming = false; return { ok: true, aborted: true, sessionId, sessionRef: { sessionId, sessionPath: s.path } }; },
    },
    bus: { async subscribe(callback, filter) { const item = { callback, filter }; subscriptions.add(item); return Object.assign(() => subscriptions.delete(item), { ready: Promise.resolve() }); } },
    tasks: {
      async registerHandler(key, handler) { assert.ok(!handlers.has(key)); handlers.set(key, handler); return Object.assign(() => handlers.delete(key), { ready: Promise.resolve() }); },
      async create(input) {
        assert.equal(Object.hasOwn(input, 'parentSessionId'), false); assert.equal(Object.hasOwn(input, 'parentSessionPath'), false);
        let parent = null;
        if (input.scope === 'session') { const ctx = scope.getStore()?.context; assert.equal(input.callToken, ctx?.callToken); assert.equal(contexts.get(input.callToken), ctx); parent = [...hosts.values()].find(s => s.path === ctx.sessionPath); assert.ok(parent); }
        else { assert.equal(input.scope, 'app'); assert.equal(input.delivery, 'none'); assert.equal(input.callToken, undefined); }
        const { callToken, ...definition } = input;
        const row = { ...clone(definition), handlerKey: input.handlerKey ?? null, taskId: `opaque-task-${tasks.size + 1}`, pluginId: APP, status: 'pending', parentSessionId: parent?.sessionId ?? null, parentSessionPath: parent?.path ?? null };
        tasks.set(row.taskId, row); return clone(row);
      },
      async get(id) { return clone(tasks.get(id)); }, async list() { return clone([...tasks.values()]); },
      async schedule(input) { assert.equal(input.scope, 'app'); assert.equal(input.callToken, undefined); const row = { ...clone(input), intervalMs: input.intervalMs ?? null, scheduleId: randomUUID(), pluginId: APP }; schedules.set(row.scheduleId, row); return clone(row); },
      async getSchedule(id) { return clone(schedules.get(id) ?? null); }, async listSchedules() { return clone([...schedules.values()]); },
      async unschedule(id) { assert.ok(schedules.delete(id)); return { ok: true }; },
      async complete(id, result) {
        const row = tasks.get(id); Object.assign(row, { status: 'completed', result });
        monitor?.taskEvent(id, row); // Tracked session root only; early completion before release is abnormal.
        event(`task:${id}`).resolve(clone(row)); return clone(row);
      },
      async fail(id, error) {
        const row = tasks.get(id); Object.assign(row, { status: 'failed', error });
        diagnostics.taskFailures.push({ at: Date.now(), taskId: id, scope: row.scope, receipt: clone(row), stackStatus: 'backend projection; original stack not obtained here' });
        monitor?.taskEvent(id, row); // Synchronous notification only; never await a barrier from tasks.fail.
        event(`task:${id}`).resolve(clone(row)); return clone(row);
      },
      async getDelivery() { return { state: 'staged', delivered: false }; },
    },
    runtime: {
      async start(input) {
        assert.equal(input.command, path.join(packageRoot, 'dependencies/python/bin/python3'));
        assert.deepEqual(input.args.slice(0, 4), ['-I', '-S', '-B', path.join(packageRoot, 'runtime/research_entry.py')]);
        assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none');
        const owner = tasks.get(input.taskId); assert.ok(owner); assert.equal(owner.scope, 'app'); assert.equal(owner.parentSessionId, null); assert.equal(input.callToken, undefined);
        const request = JSON.parse(await fs.readFile(input.args[4], 'utf8'));
        assert.equal(input.cwd, path.join(dataDir, 'research/core-calls', request.requestId));
        await runtimeStart(input, request);
        const envelope = JSON.parse(await fs.readFile(input.args[5], 'utf8')); assert.equal(envelope.requestId, request.requestId);
        calls.core.push({ request, envelope, taskId: input.taskId });
        const info = { runtimeId: randomUUID(), state: 'exited', exitCode: 0, signal: null, runtime: 'command', profile: 'scoped', network: 'none' };
        processes.set(info.runtimeId, info); return clone(info);
      },
      async get(id) { return clone(processes.get(id)); }, async stop(id) { return clone(processes.get(id)); }, async watch() { assert.fail('synchronous fixture runtime has already exited'); },
    },
    resources: { async stage() { assert.fail('opaque payload should not need attachment'); } },
  };
  for (const section of ['sessions', 'runtime', 'tasks']) for (const name of Object.keys(sdk[section])) sdk[section][name] = adapter(`sdk.${section}.${name}`, sdk[section][name]);
  const contextService = createContextService(sdk, { packageRoot }), profiles = createProfileService(sdk);
  const createCore = adapter('createCore', (options = {}) => wrapCore(createResearchRuntime(sdk, { packageRoot, platform: 'darwin', arch: 'arm64', timeoutMs: 20000, ...(options.taskId ? { taskId: options.taskId } : {}) }), error => caught('core-facade', error)));
  const literature = { async search() { assert.fail('network forbidden'); } };
  research = await createResearchService(sdk, { contexts: contextService, profiles, createCore, sessions: createResearchSessions(sdk), literature });
  project = await createProjectService(sdk, { contexts: contextService, profiles, research, createCore, literature });
  registration = await registerMathResearch(sdk, research, project);
  async function watchRuns(jobs) {
    for (const job of jobs) {
      const row = await sdk.tasks.get(job.taskId);
      assert.equal(row.scope, 'session', 'monitor only the admitted session-scope root task');
      monitor?.track(job.runId, job.taskId);
      monitor?.taskEvent(job.taskId, row); // Check terminal state before dispatch; no lost early failure.
    }
  }
  async function snapshotRuns(reason) {
    const rows = [];
    for (const [runId, value] of admitted) {
      try { rows.push({ runId, projectId: value.projectId, rootTaskId: value.taskId,
        status: await research.projectWorkerStatus(value.projectId, runId), stackStatus: 'sanitized backend status; original stack not obtained here' }); }
      catch (error) { rows.push({ runId, statusQueryError: errorRecord(error) }); }
    }
    const snapshot = { reason, at: Date.now(), rows }; diagnostics.snapshots.push(snapshot); return snapshot;
  }
  async function dispatch(predicate) {
    const row = [...schedules.values()].find(predicate); assert.ok(row, 'scheduled dispatch required');
    return scope.run({ kind: 'app', runId: row.payload?.runId ?? null }, async () => {
      try {
        const receipt = await handlers.get(row.handlerKey).run({ kind: 'schedule', scheduleId: row.scheduleId, input: clone(row.payload) });
        diagnostics.dispatches.push({ at: Date.now(), runId: row.payload?.runId ?? null, receipt: clone(receipt) });
        // Project setup is not a worker launch; the monitor applies only to run dispatch.
        if (row.payload?.runId) {
          monitor?.dispatch(receipt);
          const root = admitted.get(row.payload.runId);
          if (root) monitor?.taskEvent(root.taskId, tasks.get(root.taskId)); // Recheck any terminal event racing with started receipt.
        }
        return receipt;
      } catch (error) { throw caught('dispatch', error); }
    });
  }
  async function create() {
    const queued = good(await tool('math_project', { action: 'create', problem: 'opaque M01 software fixture, not mathematics', workers: 4,
      workerPolicy: { maxRounds: 1, roundTimeoutSeconds: 120, roundDelaySeconds: 1, maxConsecutiveFailures: 1 } }));
    await dispatch(s => s.payload?.projectId === queued.projectId); await wait(`task:${queued.taskId}`);
    const status = good(await tool('math_project', { action: 'status', projectId: queued.projectId })); assert.equal(status.state, 'ready');
    const main = hosts.get(status.main.sessionId); assert.ok(main);
    for (let i = 1; i <= 4; i++) good(await tool('math_assign', { task: `opaque lane ${i}, no mathematics`, workerId: `worker-${i}` }, main.context));
    return { projectId: queued.projectId, main, ctx: main.context };
  }
  async function close() {
    monitor?.stop(); // Intentional disposal must not manufacture a new root failure.
    const cleanupErrors = [], pending = Object.fromEntries(['project', 'research'].map(name => [name,
      Promise.resolve().then(() => name === 'project' ? project.dispose() : research.dispose())]));
    for (const value of Object.values(pending)) value.catch(() => {});
    const serviceResults = Object.fromEntries(await Promise.all(Object.entries(pending).map(async ([name, value]) => {
      try { return [name, { status: 'fulfilled', value: await deadline(value, `${name} disposal`, 30000) }]; }
      catch (error) { return [name, { status: 'rejected', reason: error }]; }
    })));
    let scriptResults = [];
    try { scriptResults = await deadline(Promise.allSettled(jobs), 'script barriers drained', 30000); }
    catch (error) { cleanupErrors.push(error); }
    let registryResult;
    try { registryResult = { status: 'fulfilled', value: await registration.dispose() }; }
    catch (error) { registryResult = { status: 'rejected', reason: error }; }
    const snapshot = await snapshotRuns('after-service-disposal');
    const report = disposalReport({ serviceResults, scriptResults, registryResult, scriptErrors: errors,
      subscriptions: subscriptions.size, handlers: handlers.size, runSnapshots: snapshot.rows, cleanupErrors });
    diagnostics.disposal = report;
    return report; // Script failures stay script failures, not cleanup AssertionErrors.
  }
  return { dataDir, sdk, research, project, calls, tool, create, dispatch, watchRuns, snapshotRuns, diagnostics, wait, close, origin, errors };
}
