// Joint SOFTWARE acceptance only. Real services/helpers/Core, opaque Host/model
// events and identities. No real App, model, research data or mathematics.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { createProjectService } from '../packages/hana-math/project-service.mjs';
import { createResearchService } from '../packages/hana-math/research-service.mjs';
import { createResearchSessions } from '../packages/hana-math/research-sessions.mjs';
import { createContextService } from '../packages/hana-math/context-service.mjs';
import { createProfileService } from '../packages/hana-math/profile-service.mjs';
import { createResearchRuntime } from '../packages/hana-math/runtime/research-runtime.mjs';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';

const APP = 'hana-math', repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile), clone = structuredClone;
// Software lock contention only: separate Core child, real LOCK_NB rejection.
const lockedCore = `import fcntl, os, subprocess, sys
from pathlib import Path
p = Path(sys.argv[1]); p.parent.mkdir(parents=True, exist_ok=True)
fd = os.open(p, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    result = subprocess.run([sys.executable, *sys.argv[2:]], close_fds=True, timeout=10, check=False)
    raise SystemExit(result.returncode)
finally:
    fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)
`;
// Fault injection only: real Core normal return, then oversized private snapshot.
const overflowSnapshot = `import runpy, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / 'engine/src'))
from hana_math_engine import research
original = research.execute
def execute(root, private, request):
    result = original(root, private, request)
    if request['operation'] == 'fact_submit':
        (root / 'opaque-overflow.bin').write_bytes(b'x' * (research.MAX_JSON + 1))
    return result
research.execute = execute
sys.argv = sys.argv[2:]
runpy.run_path(sys.argv[0], run_name='__main__')
`;
const REPORT = { verification_report: { summary: 'opaque software verifier fixture', critical_errors: [], gaps: [] }, verdict: 'correct', repair_hints: '' };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function deadline(promise, label, ms = 15000) {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Fixture deadline: ${label}`)), ms); })]).finally(() => clearTimeout(timer));
}
function good(reply) { assert.equal(reply.isError, false, JSON.stringify(reply.details)); return reply.details; }

async function fixture(t, behavior = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'joint-main-worker-')));
  const dataDir = path.join(base, 'data'), packageRoot = path.join(base, 'package');
  const scope = new AsyncLocalStorage(), tools = new Map(), handlers = new Map(), schedules = new Map(), tasks = new Map();
  const hosts = new Map(), contextsByToken = new Map(), subscriptions = new Set(), processes = new Map(), events = new Map();
  const jobs = [], errors = [], gates = [];
  const calls = { create: [], send: [], abort: [], schedule: [], tasks: [], core: [], tools: [] };
  let research, project, registration, workerIndex = 0, prepareLockHeld = false;
  const event = key => { if (!events.has(key)) events.set(key, deferred()); return events.get(key); };
  const gate = () => { const value = deferred(); gates.push(value); return value; };
  const wait = key => deadline(event(key).promise, key);
  async function close() {
    // Both controllers stop accepting work before scripted model barriers open.
    const closingProject = project?.dispose(), closingResearch = research?.dispose();
    for (const item of gates) item.resolve();
    let outcomes;
    try {
      outcomes = await deadline(Promise.allSettled([closingProject, closingResearch]), 'service cleanup', 25000);
      await deadline(Promise.allSettled(jobs), 'script cleanup');
    } finally { await registration?.dispose(); }
    for (const outcome of outcomes) assert.equal(outcome.status, 'fulfilled', outcome.reason?.stack);
    assert.equal(subscriptions.size, 0); assert.equal(handlers.size, 0);
  }
  t.after(async () => { try { await close(); assert.deepEqual(errors.map(e => e.stack), []); } finally { await fs.rm(base, { recursive: true, force: true }); } });
  await fs.mkdir(dataDir); await fs.mkdir(packageRoot);
  // Same relocated packaged-entry protocol as research-integration.test.mjs.
  const source = path.join(repo, 'packages/hana-math');
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'reference-sources.json'), 'utf8'));
  for (const name of ['reference-sources.json', ...manifest.files.map(row => row.target), 'runtime/research_entry.py']) {
    await fs.mkdir(path.dirname(path.join(packageRoot, name)), { recursive: true }); await fs.copyFile(path.join(source, name), path.join(packageRoot, name));
  }
  await fs.cp(path.join(repo, 'engine/src'), path.join(packageRoot, 'engine/src'), { recursive: true, filter: name => !name.includes('__pycache__') && !name.endsWith('.pyc') });
  await fs.mkdir(path.join(packageRoot, 'dependencies/python/bin'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'dependencies/python/bin/python3'), 'opaque runtime placeholder', { mode: 0o700 });
  await fs.writeFile(path.join(packageRoot, 'dependencies/runtime.json'), JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', pythonVersion: '3.12.14', executable: 'dependencies/python/bin/python3' }));
  const roles = ['main', 'worker', 'verifier'];
  const agents = roles.map(role => ({ id: `saved-${role}`, state: 'active', deletedAt: null, ownerPluginId: APP, visibility: 'plugin_private', plugin: { ownerPluginId: APP, visibility: 'plugin_private', kind: 'role', roleId: role } }));
  const model = agentId => ({ provider: 'opaque-provider', id: `${agentId}-model` });
  function hostContext(session) {
    const context = Object.freeze({ callToken: `opaque-host-token-${session.sessionId}`, sessionPath: session.path });
    contextsByToken.set(context.callToken, context); return context;
  }
  const creator = { sessionId: 'opaque-creator', path: '/opaque-host/creator.jsonl', agentId: 'ordinary-user-agent', namespace: 'home', visibility: 'public', ownerPluginId: null, lifecycle: 'active' };
  hosts.set(creator.sessionId, creator); const origin = hostContext(creator);
  async function tool(name, args, ctx = origin) {
    assert.equal(contextsByToken.get(ctx.callToken), ctx, 'only Host-issued contexts may enter registered tools');
    assert.equal(Object.hasOwn(args, 'context'), false); assert.ok(tools.has(name));
    const caller = [...hosts.values()].find(session => session.path === ctx.sessionPath);
    if (caller?.agentId === 'saved-main' && ['math_goal', 'math_goal_main'].includes(name)) {
      assert.ok(caller.toolNames.includes(name), 'main Goal tool must be selected by the Host fixture');
    }
    return scope.run({ kind: 'model-tool', context: ctx }, async () => {
      const result = await tools.get(name).execute({ ...clone(args), context: ctx });
      assert.deepEqual(JSON.parse(result.content[0].text), result.details);
      calls.tools.push({ name, args: clone(args), sessionPath: ctx.sessionPath, result: clone(result) }); return result;
    });
  }
  function sessionRow(session) {
    const { context, workerIndex, turn, aborted, ...row } = session;
    return clone(row); // Host context/token and script bookkeeping are not API rows.
  }
  async function emit(session, data) {
    for (const item of [...subscriptions]) if (item.filter.sessionPath === session.path && item.filter.types.includes(data.type)) item.callback({ ...data, sessionId: session.sessionId }, session.path);
  }
  async function scriptedTurn(session) {
    await emit(session, { type: 'agent_start' });
    let text = 'opaque completed model turn';
    if (session.agentId === 'saved-worker') {
      event('worker-send').resolve(session);
      if (behavior.holdWorker) await behavior.holdWorker.promise;
      if (session.aborted) return;
      if (behavior.workerTurn) await behavior.workerTurn(session, tool);
      if (behavior.facts && session.turn === 1) {
        const receipt = good(await tool('fact_submit', { statement: `opaque software fixture statement ${session.workerIndex}`,
          proof: 'opaque software fixture payload with several distinct tokens only', predecessors: [], glossary_introduces: {} }, session.context));
        assert.equal(receipt.pending, true); assert.equal(receipt.accepted, false);
      }
    } else if (session.agentId === 'saved-verifier') {
      const report = behavior.report ?? REPORT;
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
      async register(def) { assert.equal(tools.has(def.name), false); tools.set(def.name, def); return () => tools.delete(def.name); },
      async list({ scope }) {
        assert.equal(scope, 'own'); return [...tools.values()].map(def => ({ name: def.name, source: { kind: 'app', appId: APP }, availability: { registered: true } }));
      },
    },
    agents: {
      async list() { return { agents: clone(agents) }; },
      async config({ agentId }) { assert.ok(agents.some(agent => agent.id === agentId)); return { config: { tool_call_mode: 'full', agent: { name: agentId }, models: { chat: model(agentId) } } }; },
      async createFromRole() { assert.fail('no role cloning'); }, async updateConfig() { assert.fail('no role edits'); },
    },
    models: { async listAvailable() { return { models: agents.map(agent => model(agent.id)) }; } },
    storage: { global: { async get(key, fallback) { const role = roles.find(role => key === `profile.role.${role}`); return role ? { agentId: `saved-${role}` } : fallback; }, async set() { assert.fail('no saved-role writes'); } } },
    sessions: {
      async create(input) {
        assert.equal(scope.getStore()?.kind, 'app'); assert.equal(input.memoryEnabled, false);
        const isMain = input.agentId === 'saved-main'; assert.equal(input.namespace, isMain ? 'home' : 'app'); assert.deepEqual(input.model, model(input.agentId));
        const sessionId = `joint-session-${hosts.size}`;
        const session = { sessionId, path: `/opaque-host/${sessionId}.jsonl`, agentId: input.agentId, cwd: input.cwd, kind: input.kind,
          ownerPluginId: APP, visibility: isMain ? 'public' : 'plugin_private', namespace: input.namespace, lifecycle: 'active', streaming: false, turn: 0 };
        if (input.agentId === 'saved-worker') session.workerIndex = ++workerIndex;
        session.context = hostContext(session); hosts.set(sessionId, session); calls.create.push(clone(input));
        if (input.agentId === 'saved-worker') { event('worker-create').resolve(session); if (behavior.holdWorkerCreate) await behavior.holdWorkerCreate.promise; }
        return { ok: true, ...sessionRow(session), sessionPath: session.path, sessionRef: { sessionId, sessionPath: session.path }, modelId: input.model.id, modelProvider: input.model.provider };
      },
      async get({ sessionId, sessionPath }) {
        const value = sessionId ? hosts.get(sessionId) : [...hosts.values()].find(row => row.path === sessionPath);
        assert.ok(value?.ownerPluginId === APP, 'App session lookup must stay own'); return { session: sessionRow(value) };
      },
      async list(input) { return { sessions: [...hosts.values()].filter(row => row.ownerPluginId === APP && (!input?.agentId || row.agentId === input.agentId)).map(row => sessionRow(row)) }; },
      async context({ sessionId }) { const row = hosts.get(sessionId); assert.equal(row.ownerPluginId, APP); return { sessionId, model: model(row.agentId), isStreaming: row.streaming, isCompacting: false, pendingMessageCount: 0 }; },
      async setActiveTools({ sessionId, toolNames }) {
        assert.ok(hosts.has(sessionId)); const available = new Set(['read', 'web_search', 'web_fetch', 'subagent', 'subagent_reply', 'subagent_message', 'subagent_close', 'wait_for_tasks', 'current_status', 'loop_control', ...tools.keys()]);
        assert.equal(new Set(toolNames).size, toolNames.length); assert.ok(toolNames.every(name => available.has(name)));
        hosts.get(sessionId).toolNames = [...toolNames]; return { sessionId, toolNames: [...toolNames], effective: 'current', pendingToolNames: null };
      },
      async getToolSelection({ sessionId }) { return { sessionId, toolNames: [...hosts.get(sessionId).toolNames], effective: 'current', pendingToolNames: null }; },
      async send(input) {
        const row = hosts.get(input.sessionId); assert.equal(row.ownerPluginId, APP); calls.send.push(clone(input)); row.turn++;
        if (row.agentId !== 'saved-main') {
          row.streaming = true;
          const job = new Promise(resolve => setImmediate(resolve)).then(() => scriptedTurn(row)).catch(async error => {
            errors.push(error); row.streaming = false; await emit(row, { type: 'agent_end', messages: [{ role: 'assistant', content: 'opaque fixture error', stopReason: 'error' }] });
          }); jobs.push(job);
        }
        return { accepted: true, sessionId: row.sessionId, sessionPath: row.path, sessionRef: { sessionId: row.sessionId, sessionPath: row.path } };
      },
      async abort({ sessionId }) { const row = hosts.get(sessionId); assert.notEqual(row.agentId, 'saved-main'); row.aborted = true; row.streaming = false; calls.abort.push(sessionId); return { ok: true, aborted: true, sessionId, sessionRef: { sessionId, sessionPath: row.path } }; },
    },
    bus: { async subscribe(callback, filter) { const item = { callback, filter }; subscriptions.add(item); return Object.assign(() => subscriptions.delete(item), { ready: Promise.resolve() }); } },
    tasks: {
      async registerHandler(key, handler) { assert.equal(handlers.has(key), false); handlers.set(key, handler); return Object.assign(() => handlers.delete(key), { ready: Promise.resolve() }); },
      async create(input) {
        assert.equal(Object.hasOwn(input, 'parentSessionId'), false); assert.equal(Object.hasOwn(input, 'parentSessionPath'), false);
        let parent = null;
        if (input.scope === 'session') {
          const ctx = scope.getStore()?.context; assert.equal(input.callToken, ctx?.callToken);
          assert.equal(contextsByToken.get(input.callToken), ctx); parent = [...hosts.values()].find(row => row.path === ctx.sessionPath); assert.ok(parent);
        } else { assert.equal(input.scope, 'app'); assert.equal(input.delivery, 'none'); assert.equal(input.callToken, undefined); }
        const { callToken, ...definition } = input;
        const row = { ...clone(definition), handlerKey: input.handlerKey ?? null, taskId: `joint-task-${tasks.size + 1}`, pluginId: APP, status: 'pending', parentSessionId: parent?.sessionId ?? null, parentSessionPath: parent?.path ?? null };
        tasks.set(row.taskId, row); calls.tasks.push(clone(row)); return clone(row);
      },
      async get(id) { return clone(tasks.get(id)); }, async list() { return clone([...tasks.values()]); },
      async schedule(input) { assert.equal(input.scope, 'app'); assert.equal(input.callToken, undefined); const row = { ...clone(input), intervalMs: input.intervalMs ?? null, scheduleId: `joint-schedule-${calls.schedule.length + 1}`, pluginId: APP }; schedules.set(row.scheduleId, row); calls.schedule.push(clone(row)); return clone(row); },
      async getSchedule(id) { return clone(schedules.get(id) ?? null); }, async listSchedules() { return clone([...schedules.values()]); },
      async unschedule(id) { if (!schedules.delete(id)) throw Object.assign(new Error('opaque schedule absent'), { code: 'APP_HOST_ERROR' }); return { ok: true }; },
      async complete(id, result) { const row = tasks.get(id); Object.assign(row, { status: 'completed', result }); event(`task:${id}`).resolve(clone(row)); return clone(row); },
      async fail(id, error) { const row = tasks.get(id); Object.assign(row, { status: 'failed', error }); event(`task:${id}`).resolve(clone(row)); return clone(row); },
      async getDelivery() { return { state: 'staged', delivered: false }; },
    },
    runtime: {
      async start(input) {
        assert.equal(input.command, path.join(packageRoot, 'dependencies/python/bin/python3'));
        assert.deepEqual(input.args.slice(0, 4), ['-I', '-S', '-B', path.join(packageRoot, 'runtime/research_entry.py')]);
        assert.equal(input.profile, 'scoped'); assert.equal(input.network, 'none'); // Requested API contract, not a real Host sandbox claim.
        const owner = tasks.get(input.taskId); assert.ok(owner); assert.equal(owner.scope, 'app'); assert.equal(owner.parentSessionId, null);
        assert.equal(input.callToken, undefined); assert.ok(['pending', 'running'].includes(owner.status));
        const request = JSON.parse(await fs.readFile(input.args[4], 'utf8'));
        assert.equal(input.cwd, path.join(dataDir, 'research/core-calls', request.requestId));
        if (behavior.beforeCore) await behavior.beforeCore(request);
        if (behavior.unknownWrite && request.operation === 'fact_submit') { event('unknown-write').resolve(request); throw Object.assign(new Error('opaque unknown runtime start'), { code: 'APP_HOST_ERROR' }); }
        if ((behavior.prepareBusyOnce || behavior.busyOperation) && !prepareLockHeld && request.operation === (behavior.busyOperation ?? 'prepare_submission')) {
          prepareLockHeld = true;
          const lock = path.join(dataDir, 'context/projects', request.context.projectId, 'research/control/project.lock');
          await execute('python3.12', ['-I', '-S', '-B', '-c', lockedCore, lock, ...input.args], { cwd: input.cwd, timeout: 15000, maxBuffer: 2 << 20 });
        } else if (behavior.snapshotOverflow && request.operation === 'fact_submit') {
          await execute(process.env.PYTHON312 || 'python3.12', ['-I', '-S', '-B', '-c', overflowSnapshot, packageRoot, ...input.args.slice(3)], { cwd: input.cwd, timeout: 15000, maxBuffer: 2 << 20 });
        } else await execute('python3.12', input.args, { cwd: input.cwd, timeout: 15000, maxBuffer: 2 << 20 });
        const envelope = JSON.parse(await fs.readFile(input.args[5], 'utf8')); assert.equal(envelope.requestId, request.requestId);
        calls.core.push({ request, envelope, taskId: owner.taskId });
        const result = { runtimeId: randomUUID(), state: 'exited', exitCode: 0, signal: null, runtime: 'command', profile: 'scoped', network: 'none' };
        processes.set(result.runtimeId, result); return clone(result);
      },
      async get(id) { return clone(processes.get(id)); }, async stop(id) { return clone(processes.get(id)); }, async watch() { assert.fail('fixture process already exited'); },
    },
    resources: { async stage() { assert.fail('small opaque facts should not require staging'); } },
  };
  const contexts = createContextService(sdk, { packageRoot }), profiles = createProfileService(sdk);
  const createCore = (options = {}) => createResearchRuntime(sdk, { packageRoot, platform: 'darwin', arch: 'arm64', timeoutMs: 20000, ...(options.taskId ? { taskId: options.taskId } : {}) });
  const literature = { async search() { assert.fail('no literature/network'); } };
  research = await createResearchService(sdk, { contexts, profiles, createCore, sessions: createResearchSessions(sdk), literature });
  project = await createProjectService(sdk, { contexts, profiles, research, createCore, literature });
  registration = await registerMathResearch(sdk, research, project);
  async function dispatch(predicate) {
    const row = [...schedules.values()].find(predicate); assert.ok(row, 'expected scheduled action');
    return scope.run({ kind: 'app' }, () => handlers.get(row.handlerKey).run({ kind: 'schedule', scheduleId: row.scheduleId, input: clone(row.payload) }));
  }
  async function create(workerPolicy = { maxRounds: 4, roundDelaySeconds: 0 }) {
    const queued = good(await tool('math_project', { action: 'create', problem: 'opaque joint problem fixture', ...(workerPolicy ? { workerPolicy } : {}) }));
    await dispatch(row => row.payload?.projectId === queued.projectId); await wait(`task:${queued.taskId}`);
    const status = good(await tool('math_project', { action: 'status', projectId: queued.projectId })); assert.equal(status.state, 'ready');
    const main = hosts.get(status.main.sessionId); assert.ok(main); assert.ok(main.toolNames.includes('math_goal_main'));
    assert.equal(main.toolNames.includes('math_goal'), false);
    good(await tool('math_assign', { task: 'opaque joint assignment, no mathematical computation' }, main.context));
    return { projectId: queued.projectId, main, ctx: main.context };
  }
  async function goal(p) {
    const started = good(await tool('math_goal', { action: 'start', projectId: p.projectId, authorized: true }));
    return { projectId: p.projectId, goalId: started.goalId, generation: started.generation, started };
  }
  return { dataDir, sdk, research, project, calls, hosts, origin, tool, create, goal, dispatch, wait, event, gate, close, behavior };
}

function pauseBarrier(t, f, p, point) {
  const entered = deferred(), release = f.gate(); let hit = false;
  const original = point === 'handoff' ? fs.rename : fs.lstat;
  const method = point === 'handoff' ? 'rename' : 'lstat';
  const target = path.join(f.dataDir, 'context/projects', p.projectId, 'workers/worker-1', point === 'workspace' ? 'project-workspace.json' : 'run-ref.json');
  t.mock.method(fs, method, async (...args) => {
    let match = !hit && (point === 'handoff' ? String(args[1]).startsWith(path.join(f.dataDir, 'research/runs') + path.sep) && String(args[1]).endsWith('/run.json') : args[0] === target);
    if (match && point === 'handoff') { const meta = JSON.parse(await fs.readFile(args[0], 'utf8')); match = meta.sessions?.some(row => row.role === 'worker' && row.state === 'creating' && row.sessionId === null); }
    if (match) { hit = true; entered.resolve(); await release.promise; }
    return original(...args);
  }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { entered: deadline(entered.promise, `pause ${point}`), release };
}

const options = { timeout: 60000 };

test('project worker root labels: bound main assignment controls only the next task label, not identity or delivery', options, async t => {
  const f = await fixture(t);
  const setup = good(await f.tool('math_project', { action: 'create', problem: 'Opaque two-worker label fixture', workers: 2,
    workerPolicy: { maxRounds: 1, roundDelaySeconds: 0 } }));
  await f.dispatch(row => row.payload?.projectId === setup.projectId);
  assert.equal((await f.wait(`task:${setup.taskId}`)).status, 'completed');
  const { projectId, main } = good(await f.tool('math_project', { action: 'status', projectId: setup.projectId }));
  const bound = f.hosts.get(main.sessionId);
  assert.ok(bound?.toolNames.includes('math_assign'));
  const inputs = [], create = f.sdk.tasks.create;
  f.sdk.tasks.create = async input => { inputs.push(clone(input)); return create(input); };
  const assign = (workerId, task, title = {}) => f.tool('math_assign', { workerId, task, ...title }, bound.context).then(good);
  const roots = [];
  async function start(workerId, label) {
    const before = f.calls.tasks.length;
    const run = good(await f.tool('math_project', { action: 'start', projectId, workerId }, bound.context));
    assert.equal(run.state, 'queued'); assert.equal(run.workerId, workerId);
    assert.equal(f.calls.tasks.length, before + 1);
    const root = f.calls.tasks.at(-1);
    assert.deepEqual(inputs.at(-1), { scope: 'session', callToken: bound.context.callToken, handlerKey: 'math-research-once',
      label, delivery: 'next-step', metadata: { researchRunId: run.runId } });
    assert.deepEqual(root, { scope: 'session', handlerKey: 'math-research-once', delivery: 'next-step', label,
      metadata: { researchRunId: run.runId }, parentSessionId: bound.sessionId, parentSessionPath: bound.path,
      taskId: run.taskId, pluginId: APP, status: 'pending' });
    roots.push(run.taskId);
    return run;
  }
  async function stop(workerId, run) {
    await f.tool('math_project', { action: 'stop', projectId, workerId, force: true }, bound.context);
    const current = await f.research.projectWorkerStatus(projectId, run.runId);
    assert.equal(current.state, 'stopped'); assert.equal(current.coordinatorActive, false);
    const root = await f.sdk.tasks.get(run.taskId);
    assert.equal(root.status, 'failed'); assert.equal(root.delivery, 'next-step');
  }
  await assign('worker-1', 'Private one', { displayTitle: '悬链面曲率' });
  await assign('worker-2', 'Private two');
  assert.equal(inputs.length, 0, 'assignment does not create a root');
  const first = await start('worker-1', 'worker-1 · 悬链面曲率');
  const second = await start('worker-2', 'worker-2 · 证明任务');
  await stop('worker-1', first); await stop('worker-2', second);

  await assign('worker-1', 'Private short');
  await stop('worker-1', await start('worker-1', 'worker-1 · 证明任务'));
  await assign('worker-1', 'Private title', { displayTitle: 'Old visible title' });
  await stop('worker-1', await start('worker-1', 'worker-1 · Old visible title'));
  await assign('worker-1', 'Private tiny', { displayTitle: ' \t ' });
  await stop('worker-1', await start('worker-1', 'worker-1 · 证明任务'));
  assert.deepEqual(f.calls.tasks.slice(1).map(row => row.taskId), roots);
  assert.equal(new Set(roots).size, 5);

  const legacy = good(await f.tool('math_research', { action: 'run', problem: 'Opaque legacy label fixture' }));
  const creator = [...f.hosts.values()].find(row => row.path === f.origin.sessionPath);
  assert.deepEqual(inputs.at(-1), { scope: 'session', callToken: f.origin.callToken, handlerKey: 'math-research-once',
    label: 'Math bounded research', delivery: 'next-step', metadata: { researchRunId: legacy.runId } });
  assert.deepEqual(f.calls.tasks.at(-1), { scope: 'session', handlerKey: 'math-research-once', delivery: 'next-step', label: 'Math bounded research',
    metadata: { researchRunId: legacy.runId }, parentSessionId: creator.sessionId, parentSessionPath: creator.path,
    taskId: legacy.taskId, pluginId: APP, status: 'pending' });
  assert.equal(inputs.length, 6); assert.equal(f.calls.tasks.length, 7, 'one setup task and one root per accepted start only');
  assert.deepEqual(f.calls.create.map(row => row.agentId), ['saved-main']);
  assert.deepEqual(f.calls.core, [], 'no worker schedule dispatched and no Python or model needed');
  t.diagnostic(JSON.stringify({ labels: inputs.map(row => row.label), roots: inputs.length, delivery: 'next-step', researchSchedulesDispatched: 0 }));
});

test('registered verification_reads follows real Project/Research candidate linkage without any write/Core/lifecycle work', options, async t => {
  const f = await fixture(t, { facts: true }), p = await f.create({ maxRounds: 1, roundTimeoutSeconds: 60, roundDelaySeconds: 0 });
  async function settled(runId) {
    // A Host task receipt precedes pipeline-finally settlement. Use the existing
    // bounded software-fixture wait pattern, never weaken the production fence.
    for (let n = 0; n < 2000; n++) {
      const status = await f.research.projectWorkerStatus(p.projectId, runId);
      if (n === 0) t.diagnostic(JSON.stringify({ fixtureSettlement: runId, coordinatorActive: status.coordinatorActive, finalizing: status.finalizing }));
      if (status.coordinatorActive === false) {
        for (const key of ['cleanupPending', 'runtimeCleanupPending', 'indeterminate', 'finalizing', 'coreTaskCreatePending', 'coreTaskSettlementPending', 'recoveryUnsettled']) assert.equal(status[key], false, key);
        assert.equal(status.candidateSettlement, null); return status;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Fixture coordinator did not settle');
  }
  const first = good(await f.tool('math_project', { action: 'start', projectId: p.projectId, timeoutSeconds: 60 }, p.ctx));
  await f.dispatch(row => row.payload?.runId === first.runId); await f.wait(`task:${first.taskId}`);
  const prior = await settled(first.runId); assert.equal(prior.state, 'finished');
  const predecessor = prior.verifiedFactIds[0]; assert.ok(predecessor);
  const canonicalFile = path.join(f.dataDir, 'context/projects', p.projectId, 'shared/fact_graph/facts', predecessor + '.md');
  const markdown = await fs.readFile(canonicalFile, 'utf8'); // Fixture construction only, before the observed read-only window.
  f.behavior.facts = false;
  f.behavior.report = { verification_report: { summary: 'Opaque rejection fixture', critical_errors: [{ location: 'opaque', issue: 'opaque issue' }], gaps: [] }, verdict: 'wrong', repair_hints: 'opaque repair' };
  f.behavior.workerTurn = async (session, invoke) => { if (session.turn === 1) good(await invoke('fact_submit', {
    statement: 'opaque later candidate', proof: 'opaque fixture proof with several distinct tokens', predecessors: [predecessor], glossary_introduces: {},
  }, session.context)); };
  const job = good(await f.tool('math_project', { action: 'start', projectId: p.projectId, timeoutSeconds: 60 }, p.ctx));
  await f.dispatch(row => row.payload?.runId === job.runId); await f.wait(`task:${job.taskId}`);
  assert.equal((await settled(job.runId)).state, 'finished');
  const metaFile = path.join(f.dataDir, 'research/runs', job.runId, 'run.json'), projectFile = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json');
  const meta = JSON.parse(await fs.readFile(metaFile)), sub = meta.submissions[0], verifier = meta.sessions.find(row => row.role === 'verifier');
  assert.ok(sub && verifier); assert.notEqual(sub.state, 'accepted');
  const candidateFile = path.join(f.dataDir, sub.candidateFile), before = await Promise.all([metaFile, projectFile, candidateFile].map(file => fs.readFile(file)));
  const counts = Object.fromEntries(['create', 'send', 'abort', 'schedule', 'tasks', 'core'].map(k => [k, f.calls[k].length]));
  let entries = 0;
  f.sdk.sessions.entries = async ref => {
    entries++; assert.deepEqual(ref, { sessionId: verifier.sessionId, scope: 'own' });
    return { sessionId: verifier.sessionId, leafId: 'result', entries: [
      { id: 'call', parentId: null, type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-id', name: 'read', arguments: { path: canonicalFile } }] } },
      { id: 'result', parentId: 'call', type: 'message', message: { role: 'toolResult', toolCallId: 'read-id', toolName: 'read', isError: false, content: [{ type: 'text', text: markdown }], details: { truncation: { truncated: false } } } },
    ] };
  };
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (file, flags, ...rest) => { assert.equal(flags & 3, 0); assert.equal(file, candidateFile, 'Only derived candidate file may be opened during audit'); return originalOpen(file, flags, ...rest); });
  for (const name of ['writeFile', 'rename', 'mkdir', 'unlink']) t.mock.method(fs, name, () => assert.fail('Audit write: ' + name));
  syncBuiltinESMExports();
  try {
    for (const ctx of [f.origin, p.ctx]) {
      const dto = good(await f.tool('math_project', { action: 'verification_reads', projectId: p.projectId, runId: job.runId, submissionId: sub.submissionId }, ctx));
      assert.equal(dto.coverage, 'complete'); assert.equal(dto.verifierSessionId, verifier.sessionId); assert.equal(dto.predecessors[0].exactMatchCount, 1);
      assert.equal(dto.verdictTiming, 'not-established'); assert.equal(dto.hostMaterializationBounded, false);
      assert.ok(!JSON.stringify(dto).includes(markdown)); assert.ok(!JSON.stringify(dto).includes(f.dataDir));
    }
    assert.equal(entries, 2);
    const worker = [...f.hosts.values()].find(row => row.agentId === 'saved-worker');
    const denied = await f.tool('math_project', { action: 'verification_reads', projectId: p.projectId, runId: job.runId, submissionId: sub.submissionId }, worker.context);
    assert.equal(denied.isError, true); assert.equal(entries, 2);
    for (const [key, count] of Object.entries(counts)) assert.equal(f.calls[key].length, count, key);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(await Promise.all([metaFile, projectFile, candidateFile].map(file => fs.readFile(file))), before);
});
for (const concurrent of [false, true]) test(`joint prepublication GM refusal preserves service lifecycle, concurrent=${concurrent}`, options, async t => {
  let f, p, job, checked = false, followup = false, workerSid, during;
  const held = deferred(), release = deferred();
  f = await fixture(t, {
    async beforeCore(request) {
      if (concurrent && request.operation === 'gm_add' && request.arguments.claim === 'opaque held other mutation') { held.resolve(); await release.promise; }
    },
    async workerTurn(session, tool) {
      if (session.turn !== 1) return;
      workerSid = session.sessionId;
      const metaFile = path.join(f.dataDir, 'research/runs', job.runId, 'run.json');
      let other, retained = [];
      try {
        if (concurrent) {
          other = tool('gm_add', { kind: 'plan', claim: 'opaque held other mutation' }, session.context);
          await deadline(held.promise, 'other mutation admitted');
          retained = JSON.parse(await fs.readFile(metaFile, 'utf8')).pendingMutations;
          assert.equal(retained.length, 1);
        }
        const refused = await tool('gm_add', { kind: 'dead_end', claim: 'opaque eighteenth ' + 'x'.repeat(59982) }, session.context);
        assert.equal(refused.isError, true); assert.equal(refused.details.error.code, 'RESEARCH_RUNTIME_REJECTED');
        const own = f.calls.core.find(c => c.request.operation === 'gm_add' && c.request.arguments.kind === 'dead_end');
        assert.equal(own.envelope.ok, false); assert.equal(own.envelope.error.code, 'size_limit');
        assert.equal(Object.hasOwn(own.envelope.error, 'mutationState'), false);
        const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
        assert.equal(meta.indeterminate, false); assert.deepEqual(meta.pendingMutations, retained);
        const receiptNames = await fs.readdir(path.join(f.dataDir, 'research/runs', job.runId, 'mutations'));
        const receipts = await Promise.all(receiptNames.map(async name => {
          try { return JSON.parse(await fs.readFile(path.join(f.dataDir, 'research/runs', job.runId, 'mutations', name, 'receipt.json'), 'utf8')); }
          catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        }));
        const failure = receipts.find(r => r?.ok === false && r.operation === 'gm_add');
        assert.ok(failure); assert.equal(failure.coreError.code, 'size_limit');
        const journal = JSON.parse(await fs.readFile(path.join(f.dataDir, 'context/projects', p.projectId, 'research/control', own.request.requestId + '.json'), 'utf8'));
        assert.equal(journal.state, 'ended'); assert.deepEqual(journal.response, own.envelope);
        during = { rawEnvelope: own.envelope, indeterminate: meta.indeterminate, retainedPendingMutations: meta.pendingMutations, failureReceipt: failure, journal };
        good(await tool('fact_search', { query: 'opaque' }, session.context)); followup = true; checked = true;
      } catch (error) { t.diagnostic(error.stack); throw error; }
      finally { release.resolve(); if (other) good(await other); }
    },
  });
  p = await f.create({ maxRounds: 1, roundTimeoutSeconds: 60, roundDelaySeconds: 0, maxConsecutiveFailures: 1 }); await f.goal(p);
  const seed = `import sys,uuid\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom hana_math_engine.research import dispatch\nfor i in range(17):\n r=dispatch(Path(sys.argv[2]),{'schemaVersion':1,'requestId':str(uuid.uuid4()),'operation':'gm_add','context':{'projectId':sys.argv[3],'runId':'run-seed','role':'worker','author':'opaque-fixture'},'arguments':{'kind':'dead_end','claim':'opaque'+'x'*59994}})\n assert r['ok'],r\n`;
  await execute(process.env.PYTHON312 || 'python3.12', ['-I', '-S', '-B', '-c', seed, path.join(repo, 'engine/src'), f.dataDir, p.projectId], { cwd: repo, timeout: 15000, maxBuffer: 2 << 20 });
  const gmFile = path.join(f.dataDir, 'context/projects', p.projectId, 'shared/global_memory/dead_end.jsonl'), before = await fs.readFile(gmFile);
  job = good(await f.tool('math_project', { action: 'start', projectId: p.projectId, timeoutSeconds: 60 }, p.ctx));
  await f.dispatch(row => row.payload?.runId === job.runId); await f.wait(`task:${job.taskId}`);
  const status = await f.research.projectWorkerStatus(p.projectId, job.runId), meta = JSON.parse(await fs.readFile(path.join(f.dataDir, 'research/runs', job.runId, 'run.json'), 'utf8'));
  assert.equal(checked, true); assert.equal(followup, true); assert.equal(status.state, 'finished');
  assert.equal(status.indeterminate, false); assert.equal(status.cleanupPending, false); assert.equal(status.candidateSettlement, null);
  assert.deepEqual(meta.pendingMutations, []); assert.deepEqual(await fs.readFile(gmFile), before);
  assert.equal(f.calls.create.filter(c => c.agentId === 'saved-worker').length, 1);
  assert.ok(f.calls.tools.filter(c => c.name === 'gm_add' || c.name === 'fact_search').every(c => c.sessionPath === `/opaque-host/${workerSid}.jsonl`));
  t.diagnostic(JSON.stringify({ scope: 'fake Host/model; real ResearchService/Runtime/Python', concurrent, during, final: { state: status.state, indeterminate: status.indeterminate, cleanupPending: status.cleanupPending, pendingMutations: meta.pendingMutations }, workerSid, followup }));
});

test('joint prepublication non-GM refusal retains candidate fence and verifier report', options, async t => {
  const f = await fixture(t, { facts: true, snapshotOverflow: true });
  const p = await f.create({ maxRounds: 1, roundTimeoutSeconds: 60, roundDelaySeconds: 0, maxConsecutiveFailures: 1 }); await f.goal(p);
  const job = good(await f.tool('math_project', { action: 'start', projectId: p.projectId, timeoutSeconds: 60 }, p.ctx));
  await f.dispatch(row => row.payload?.runId === job.runId); await f.wait(`task:${job.taskId}`);
  const status = await f.research.projectWorkerStatus(p.projectId, job.runId), meta = JSON.parse(await fs.readFile(path.join(f.dataDir, 'research/runs', job.runId, 'run.json'), 'utf8'));
  const call = f.calls.core.find(c => c.request.operation === 'fact_submit');
  assert.equal(call.envelope.ok, false); assert.equal(call.envelope.error.code, 'size_limit');
  assert.equal(Object.hasOwn(call.envelope.error, 'mutationState'), false); assert.equal(Object.hasOwn(call.envelope, 'result'), false);
  assert.equal(status.state, 'failed'); assert.equal(status.candidateSettlement.pending, true); assert.equal(status.indeterminate, true);
  assert.deepEqual(status.verifiedFactIds, []); assert.deepEqual(meta.pendingMutations, []);
  assert.notEqual(status.submissions[0].state, 'accepted'); assert.notEqual(status.submissions[0].state, 'not-recorded');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dataDir, meta.submissions[0].reportFile), 'utf8')), REPORT);
  const facts = await fs.readdir(path.join(f.dataDir, 'context/projects', p.projectId, 'shared/fact_graph/facts')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.deepEqual(facts, []); assert.equal(f.calls.core.filter(c => c.request.operation === 'fact_submit').length, 1);
  t.diagnostic(JSON.stringify({ scope: 'fake Host/model; real service/Runtime/Core with private snapshot overflow injection', envelope: call.envelope, state: status.state, candidateSettlement: status.candidateSettlement, indeterminate: status.indeterminate, pendingMutations: meta.pendingMutations, verifiedFactIds: status.verifiedFactIds, reportVerdict: REPORT.verdict }));
});
for (const [stage, report] of [['fact_submit', REPORT], ['fact_get', REPORT], ['fact_submit', {
  verification_report: { summary: 'opaque rejection', critical_errors: [{ location: 'opaque', issue: 'opaque' }], gaps: [] }, verdict: 'wrong', repair_hints: 'opaque repair',
}]]) test(`joint real flock ${stage}/${report.verdict} settles without verifier or submission replay`, options, async t => {
  const f = await fixture(t, { facts: true, busyOperation: stage, report });
  const p = await f.create({ maxRounds: 1, roundTimeoutSeconds: 60, roundDelaySeconds: 0, maxConsecutiveFailures: 1 }); await f.goal(p);
  const job = good(await f.tool('math_project', { action: 'start', projectId: p.projectId, timeoutSeconds: 60 }, p.ctx));
  await f.dispatch(row => row.payload?.runId === job.runId); await f.wait(`task:${job.taskId}`);
  const status = await f.research.projectWorkerStatus(p.projectId, job.runId);
  assert.equal(status.candidateSettlement, null); assert.equal(status.indeterminate, false);
  assert.equal(f.calls.create.filter(call => call.agentId === 'saved-verifier').length, 1);
  assert.equal(f.calls.core.filter(call => call.request.operation === 'fact_submit').length, 1);
  const busy = f.calls.core.find(call => call.request.operation === stage && call.envelope.ok === false);
  assert.equal(busy.envelope.error.code, 'busy'); assert.equal(busy.envelope.requestId, busy.request.requestId);
  if (stage === 'fact_submit') {
    assert.equal(status.state, 'failed'); assert.equal(status.lastRoundOutcome.code, 1);
    assert.equal(status.submissions[0].state, 'not-recorded'); assert.deepEqual(status.verifiedFactIds, []);
    assert.equal(status.submissions[0].operationalFailure.verification_verdict, report.verdict);
    assert.equal(f.calls.core.filter(call => call.request.operation === 'fact_get').length, 0);
  } else {
    assert.equal(status.state, 'finished'); assert.equal(status.verifiedFactIds.length, 1); assert.equal(status.submissions[0].state, 'accepted');
    assert.equal(f.calls.core.filter(call => call.request.operation === 'fact_get').length, 2);
  }
});

test('joint actual Core prepare lock busy allows one explicit same-worker retry and no automatic replay', options, async t => {
  let f, checked = false, workerSid;
  f = await fixture(t, { prepareBusyOnce: true, async workerTurn(session, tool) {
    if (session.workerIndex !== 1 || session.turn !== 1) return;
    workerSid = session.sessionId;
    const candidate = { statement: 'opaque software lock fixture statement', proof: 'opaque software fixture payload with several distinct tokens only', predecessors: [], glossary_introduces: {} };
    const refused = await tool('fact_submit', candidate, session.context);
    assert.equal(refused.isError, true); assert.equal(refused.details.error.code, 'SUBMISSION_CORE_BUSY');
    assert.equal(refused.details.error.runtime.operation, 'prepare_submission'); assert.equal(refused.details.error.runtime.phase, 'result');
    assert.equal(refused.details.error.runtime.startOutcome, 'acknowledged'); assert.equal(refused.details.error.runtime.processTerminalConfirmed, true);
    assert.equal(refused.details.error.runtime.indeterminate, false); assert.equal(refused.details.error.runtime.cleanup.confirmed, true);
    assert.doesNotMatch(JSON.stringify(refused), /coreError|callToken|\/opaque-host\/|project is busy/);
    assert.match(refused.details.error.message, /No automatic replay/);
    assert.equal(f.calls.core.filter(call => call.request.operation === 'prepare_submission').length, 1);
    assert.equal(f.calls.core.some(call => call.request.operation === 'fact_submit'), false);
    assert.equal(good(await tool('fact_submit', candidate, session.context)).pending, true); checked = true;
  } });
  const p = await f.create({ maxRounds: 1, roundTimeoutSeconds: 60, roundDelaySeconds: 0, maxConsecutiveFailures: 5 }); await f.goal(p);
  const job = good(await f.tool('math_project', { action: 'start', projectId: p.projectId, timeoutSeconds: 60 }, p.ctx));
  await f.dispatch(row => row.payload?.runId === job.runId); await f.wait(`task:${job.taskId}`);
  const status = await f.research.projectWorkerStatus(p.projectId, job.runId);
  assert.equal(checked, true); assert.equal(status.state, 'finished'); assert.equal(status.verifiedFactIds.length, 1);
  assert.deepEqual(status.submissionDiagnostics.attempts.map(attempt => attempt.outcome), ['prepare-error', 'registered']);
  for (const attempt of status.submissionDiagnostics.attempts) { assert.equal(attempt.round, 1); assert.equal(attempt.workerSessionId, workerSid); }
  const preparations = f.calls.core.filter(call => call.request.operation === 'prepare_submission'); assert.equal(preparations.length, 2);
  assert.equal(preparations[0].envelope.ok, false); assert.equal(preparations[0].envelope.error.code, 'busy');
  assert.equal(preparations[0].envelope.requestId, preparations[0].request.requestId);
  assert.equal(f.calls.core.filter(call => call.request.operation === 'fact_submit').length, 1);
});

test('joint Goal registered start/ack/wait/continue -> four real worker rounds -> canonical completion', options, async t => {
  const f = await fixture(t, { facts: true }), p = await f.create(), g = await f.goal(p);
  const identity = { projectId: p.projectId, goalId: g.goalId, generation: g.generation };
  assert.match(f.calls.send[0].text, /Exploratory subagents are for speculative text-only mathematics/);
  const beforeGuard = f.calls.tools.length;
  await assert.rejects(f.tool('math_goal', { action: 'status', projectId: p.projectId }, p.ctx),
    { code: 'ERR_ASSERTION', message: 'main Goal tool must be selected by the Host fixture' });
  assert.equal(f.calls.tools.length, beforeGuard, 'unselected Goal tool must not enter its registered implementation');
  const refused = await f.tool('math_goal_main', { action: 'wait', ...identity }, p.ctx);
  assert.equal(refused.isError, true); assert.equal(refused.details.error.code, 'MAIN_CONTROL_DUE_UNACKNOWLEDGED');
  assert.deepEqual(refused.details.error.pendingReview, { ...identity, controlAt: g.started.due.control.at, auditAt: g.started.due.audit.at });
  assert.match(refused.details.error.message, /substantive.*acknowledge/);
  const ack = good(await f.tool('math_goal_main', { action: 'acknowledge', ...identity, controlAt: g.started.due.control.at, auditAt: g.started.due.audit.at }, p.ctx));
  assert.equal(ack.due.control, null); assert.equal(ack.due.audit, null);
  assert.equal(good(await f.tool('math_goal_main', { action: 'wait', ...identity }, p.ctx)).waiting, true);
  assert.equal(good(await f.tool('math_goal_main', { action: 'continue_work', ...identity }, p.ctx)).waiting, false);
  const job = good(await f.tool('math_project', { action: 'start', projectId: p.projectId, timeoutSeconds: 60 }, p.ctx));
  await f.dispatch(row => row.payload?.runId === job.runId); await f.wait(`task:${job.taskId}`);
  const worker = await f.research.projectWorkerStatus(p.projectId, job.runId);
  const status = good(await f.tool('math_project', { action: 'status', projectId: p.projectId }, p.ctx));
  assert.equal(worker.state, 'finished', JSON.stringify(worker)); assert.equal(worker.round, 4);
  assert.deepEqual(status.worker.status.executionPolicy, worker.executionPolicy);
  assert.deepEqual(status.worker.status.submissionDiagnostics, worker.submissionDiagnostics);
  assert.equal(status.worker.status.submissionDiagnostics.attempts.at(-1).round, 4);
  assert.equal(worker.verifiedFactIds.length, 4);
  assert.equal(f.calls.create.filter(row => row.agentId === 'saved-worker').length, 4);
  assert.equal(f.calls.core.filter(row => row.request.operation === 'fact_submit' && row.envelope.result?.accepted).length, 4);
  const before = f.calls.core.length;
  const complete = good(await f.tool('math_goal_main', { action: 'complete', ...identity, factIds: worker.verifiedFactIds }, p.ctx));
  assert.equal(complete.state, 'completed'); assert.deepEqual(complete.completion.factIds, worker.verifiedFactIds);
  assert.equal(complete.workerStop.state, 'requested');
  const reads = f.calls.core.slice(before); assert.equal(reads.length, 4);
  assert.ok(reads.every(row => row.request.operation === 'fact_get' && row.request.context.role === 'main' && row.envelope.ok));
  assert.equal(f.calls.abort.includes(p.main.sessionId), false);
});

for (const point of ['workspace', 'ref', 'handoff']) test(`joint Goal pause at real ${point} boundary prevents worker model send`, options, async t => {
  const f = await fixture(t), p = await f.create(); await f.goal(p);
  const barrier = pauseBarrier(t, f, p, point);
  const starting = f.tool('math_project', { action: 'start', projectId: p.projectId }, p.ctx);
  let queued;
  if (point === 'handoff') { queued = good(await starting); await f.dispatch(row => row.payload?.runId === queued.runId); }
  await barrier.entered;
  const schedules = f.calls.schedule.length;
  assert.equal(good(await f.tool('math_goal', { action: 'pause', projectId: p.projectId })).state, 'paused');
  barrier.release.resolve(); const reply = await starting;
  if (point === 'handoff') await f.wait(`task:${queued.taskId}`);
  else { assert.equal(reply.isError, true); assert.equal(reply.details.error.code, 'MAIN_CONTROL_WORK_DENIED'); }
  const status = good(await f.tool('math_project', { action: 'status', projectId: p.projectId }, p.ctx));
  assert.equal(status.worker.status.state, 'failed'); assert.equal(status.worker.status.error.code, 'MAIN_CONTROL_WORK_DENIED');
  assert.equal(f.calls.create.filter(row => row.agentId === 'saved-worker').length, 0);
  assert.equal(f.calls.send.filter(row => f.hosts.get(row.sessionId).agentId === 'saved-worker').length, 0);
  assert.equal(f.calls.schedule.length, schedules);
});

for (const force of [false, true]) test(`joint Goal issued helper work survives pause; stop force=${force} reports actual worker cleanup`, options, async t => {
  const f = await fixture(t), init = f.gate(), turn = f.gate(); f.behavior.holdWorkerCreate = init; f.behavior.holdWorker = turn;
  const p = await f.create({ roundDelaySeconds: 0 }); await f.goal(p);
  const job = good(await f.tool('math_project', { action: 'start', projectId: p.projectId }, p.ctx));
  await f.dispatch(row => row.payload?.runId === job.runId); await f.wait('worker-create');
  good(await f.tool('math_goal', { action: 'pause', projectId: p.projectId })); init.resolve();
  const active = await f.wait('worker-send'); assert.equal(active.agentId, 'saved-worker');
  const stopped = good(await deadline(f.tool('math_goal', { action: 'stop', projectId: p.projectId, force }), 'Goal stop response', 5000));
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.workerStop.state, 'requested');
  const beforeRelease = good(await f.tool('math_project', { action: 'status', projectId: p.projectId }, p.ctx)).worker.status;
  if (!force) { assert.equal(beforeRelease.state, 'running'); assert.equal(beforeRelease.stopping, true); assert.equal(stopped.workerStop.cleanupPending, true); assert.equal(f.calls.abort.length, 0); }
  else { assert.equal(beforeRelease.state, 'stopped'); assert.ok(f.calls.abort.includes(active.sessionId)); }
  turn.resolve(); await f.wait(`task:${job.taskId}`);
  const final = good(await f.tool('math_project', { action: 'status', projectId: p.projectId }, p.ctx)).worker.status;
  assert.equal(final.state, 'stopped'); assert.equal(final.cleanupPending, false); assert.equal(final.indeterminate, false);
  assert.equal(f.calls.create.filter(row => row.agentId === 'saved-worker').length, 1);
});

test('joint Goal force stop never clears real-runtime unknown mutation evidence', options, async t => {
  const f = await fixture(t, { facts: true, unknownWrite: true }), p = await f.create(); await f.goal(p);
  const job = good(await f.tool('math_project', { action: 'start', projectId: p.projectId }, p.ctx));
  await f.dispatch(row => row.payload?.runId === job.runId); await f.wait('unknown-write'); await f.wait(`task:${job.taskId}`);
  const file = path.join(f.dataDir, 'research/runs', job.runId, 'run.json');
  const before = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(before.pendingMutations.length, 1);
  const stop = good(await f.tool('math_goal', { action: 'stop', projectId: p.projectId, force: true }));
  assert.equal(stop.workerStop.cleanupPending, true);
  const state = good(await f.tool('math_project', { action: 'status', projectId: p.projectId }, p.ctx)).worker.status;
  assert.equal(state.indeterminate, true); assert.equal(state.runtimeCleanupPending, true);
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after.pendingMutations, before.pendingMutations); assert.equal(after.indeterminate, true);
  assert.equal(f.calls.create.filter(row => row.agentId === 'saved-worker').length, 1);
});

test('joint Goal absence leaves Goal unmanaged; omitted policy uses Danus research rounds', options, async t => {
  const f = await fixture(t), p = await f.create(null);
  assert.equal(good(await f.tool('math_goal', { action: 'status', projectId: p.projectId })).managed, false);
  const status = good(await f.tool('math_project', { action: 'status', projectId: p.projectId }, p.ctx));
  assert.equal(status.workerBridge, 'configured-research-rounds');
  assert.deepEqual(status.workerPolicy, { maxRounds: 0, roundTimeoutSeconds: 14400, roundDelaySeconds: 5, maxConsecutiveFailures: 5 });
  assert.equal(good(await f.tool('math_goal', { action: 'status', projectId: p.projectId })).managed, false);
});
