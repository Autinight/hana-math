// Software-only Host/worker/Core fixtures. No real model, network or private data.
import test from 'node:test';
import { fixtureFactPage } from './fact-page-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { createResearchService } from '../packages/hana-math/research-service.mjs';
import { RESEARCH_WORKER_POLICY_DEFAULTS, MAX_TIMER_SECONDS } from '../packages/hana-math/worker-policy.mjs';
import { APP, defer, fixture, origin } from './helpers/project-service-fixture.mjs';
const taskBody = '  opaque assigned B\r\n\t';

async function fileSnapshot(root) {
  const result = {};
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), key = path.relative(root, file);
      result[key] = entry.isDirectory() ? 'directory' : (await fs.readFile(file)).toString('base64');
      if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(root); return result;
}

async function doctorFixture(t, { goal = false, exhausted = false, corePending = false, startState = 'settled' } = {}) {
  const f = await fixture(t), p = await f.create();
  if (goal) { await f.service.goal('start', { projectId: p.projectId, authorized: true, maxAutomaticContinues: 1, restartAuthorization: { resume: 'preserve-budget' } }, origin); await admissionsTurn(); }
  await f.service.dispose();
  const projectFile = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), meta = JSON.parse(await fs.readFile(projectFile));
  meta.worker.runs = ['run-clean', 'run-unavailable']; meta.worker.lastRun = 'run-last'; meta.worker.start = { state: startState, runId: 'run-start' };
  meta.assignmentHistory = { available: true, coverage: 'complete', total: 1, omitted: 0, assignments: [{ sha256: 'a'.repeat(64), at: 1, lastRun: 'run-history', workerId: 'worker-1' }] };
  await fs.writeFile(projectFile, JSON.stringify(meta));
  const clean = runId => ({ projectId: p.projectId, workerId: 'worker-1', runId, mode: 'project-worker', state: 'finished',
    cleanupPending: false, runtimeCleanupPending: false, indeterminate: false, coreTaskCreatePending: false, coreTaskSettlementPending: false,
    resourceBlocked: false, taskCreatePending: false, taskSettlementPending: false, schedulePending: false,
    coordinatorActive: false, finalizing: false, recoveryUnsettled: false, pendingMutations: [], unsettledMutation: false, recoveryWarnings: [] });
  for (const runId of ['run-clean', 'run-unavailable', 'run-last', 'run-start', 'run-history']) f.jobs.set(runId, clean(runId));
  const runFile = path.join(f.dataDir, 'research/runs/run-clean/run.json'); await fs.mkdir(path.dirname(runFile), { recursive: true });
  await fs.writeFile(runFile, JSON.stringify({ privateText: 'PRIVATE_RUN_BODY' }));
  const files = [projectFile, runFile];
  if (goal) {
    const file = path.join(f.dataDir, 'research/main-controls', `${p.projectId}.json`), saved = JSON.parse(await fs.readFile(file));
    if (exhausted) saved.continuationBudget.reserved = saved.continuationBudget.limit;
    await fs.writeFile(file, JSON.stringify(saved)); files.push(file);
  }
  if (corePending) {
    const file = path.join(f.dataDir, 'research/projects', p.projectId, 'core/operation-fixture.json'); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ operationId: 'operation-fixture', projectId: p.projectId, author: 'saved-main', role: 'main', revision: 1,
      pending: true, phase: 'running', operation: 'gm_add', outcome: { state: 'pending' } })); files.push(file);
  }
  await f.open(); return { f, p, files };
}

test('M04 healthy doctor is main-only, memory-based and byte-identical with no Goal readiness', async t => {
  const f = await fixture(t), p = await f.create(), file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json');
  await f.service.dispose(); await f.open(); // Settled loaded fixture, not setup's still-draining completion receipt.
  const before = await fs.readFile(file), calls = Object.fromEntries(Object.entries(f.calls).map(([key, value]) => [key, value.length]));
  await assert.rejects(f.service.doctor({ projectId: p.projectId }, origin), { code: 'PROJECT_OWNER_DENIED' });
  await assert.rejects(f.service.doctor({ projectId: p.projectId }, { callToken: 'opaque-worker', sessionPath: '/fixture/worker.jsonl' }), { code: 'PROJECT_OWNER_DENIED' });
  const result = await f.service.doctor({ projectId: p.projectId }, p.context);
  assert.equal(result.ready, true, JSON.stringify(result)); assert.equal(result.persistenceFailed, false); assert.deepEqual(result.readiness, []); assert.deepEqual(result.runs, []);
  assert.equal(result.goal, null); assert.deepEqual(result.core, { unsettled: false, operationCount: 0, unsettledOperationCount: 0 });
  assert.deepEqual(await fs.readFile(file), before);
  for (const key of ['tasks', 'schedules', 'unschedules', 'sessions', 'sends', 'starts', 'stops', 'core', 'factories']) assert.equal(f.calls[key].length, calls[key]);
  assert.doesNotMatch(JSON.stringify(result), /sessionPath|provider|agentId|TASK|token|opaque|model/);
});

test('M04 doctor isolates missing, unknown and malformed runs and reads the full reference union without writes', async t => {
  const { f, p, files } = await doctorFixture(t, { goal: true });
  const bytes = await Promise.all(files.map(file => fs.readFile(file))), queried = [], original = f.research.projectWorkerDiagnostic;
  f.research.projectWorkerDiagnostic = async (projectId, runId) => {
    queried.push(runId);
    if (runId === 'run-unavailable') throw Object.assign(new Error('PRIVATE_HOST_MESSAGE'), { code: 'RUN_NOT_FOUND' });
    if (runId === 'run-last') return { state: 'missing' };
    if (runId === 'run-start') return { state: 'unknown' };
    if (runId === 'run-history') return { state: 'unexpected', private: 'PRIVATE_UNEXPECTED_STATE' };
    const result = await original(projectId, runId);
    result.recoveryWarnings = [{ runId, error: { code: 'STOP_UNCONFIRMED', message: 'PRIVATE_WARNING' } }, { runId: 'run-other', error: { code: 'PRIVATE_OTHER_RUN' } }];
    result.model = { provider: 'PRIVATE_PROVIDER' }; result.finalText = 'PRIVATE_RESPONSE';
    result.cleanupPending = 'PRIVATE_BAD_BOOLEAN'; delete result.pendingMutations; delete result.pendingMutationCount; return result;
  };
  const forbidden = () => assert.fail('Doctor must not mutate or sample recovery readiness');
  const directoryBefore = await fileSnapshot(f.dataDir);
  const originalOpen = fs.open, authCalls = { sessions: 0, agents: 0 };
  const sessionInfo = f.sdk.sessions.get, agentsList = f.sdk.agents.list;
  f.sdk.sessions.get = (...args) => { authCalls.sessions++; return sessionInfo(...args); };
  f.sdk.agents.list = (...args) => { authCalls.agents++; return agentsList(...args); };
  const methods = ['writeFile', 'rename', 'mkdir', 'unlink'].map(name => t.mock.method(fs, name, forbidden));
  methods.push(t.mock.method(fs, 'open', (file, flags = 'r', ...args) => {
    const write = typeof flags === 'number' ? (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_APPEND)) !== 0
      : /[wa+]/.test(flags);
    assert.equal(write, false, 'Doctor must not open files for writing');
    return originalOpen(file, flags, ...args);
  })); syncBuiltinESMExports();
  const models = f.sdk.models.listAvailable, context = f.sdk.sessions.context, tools = f.sdk.tools, capabilities = f.sdk.capabilities;
  f.sdk.models.listAvailable = forbidden; f.sdk.sessions.context = forbidden;
  f.sdk.tools = new Proxy({}, { get: forbidden }); f.sdk.capabilities = new Proxy({}, { get: forbidden });
  let result;
  try { result = await f.service.doctor({ projectId: p.projectId }, p.context); }
  finally { methods.forEach(mock => mock.mock.restore()); syncBuiltinESMExports(); f.sdk.models.listAvailable = models; f.sdk.sessions.context = context;
    f.sdk.sessions.get = sessionInfo; f.sdk.agents.list = agentsList; f.sdk.tools = tools; f.sdk.capabilities = capabilities; }
  assert.ok(authCalls.sessions >= 2); assert.ok(authCalls.agents >= 2);
  assert.deepEqual(await fileSnapshot(f.dataDir), directoryBefore);
  assert.deepEqual(queried.sort(), ['run-clean', 'run-history', 'run-last', 'run-start', 'run-unavailable']);
  assert.equal(result.runs.find(row => row.runId === 'run-last').state, 'missing');
  assert.equal(result.runs.find(row => row.runId === 'run-history').error.code, 'PROJECT_DOCTOR_RUN_STATUS_INVALID');
  assert.equal(result.runs.find(row => row.runId === 'run-unavailable').error.code, 'RUN_NOT_FOUND');
  assert.deepEqual(result.runs.find(row => row.runId === 'run-clean').recoveryWarnings, [{ code: 'STOP_UNCONFIRMED' }]);
  assert.equal(result.runs.find(row => row.runId === 'run-start').indeterminate, 'unknown');
  assert.equal(result.runs.find(row => row.runId === 'run-clean').cleanupPending, 'unknown');
  assert.equal(result.runs.find(row => row.runId === 'run-clean').pendingMutationCount, 'unknown');
  assert.equal(result.ready, 'unknown'); assert.equal(result.readiness.length, 9);
  assert.equal(result.readiness.find(row => row.condition === 'mainHostIdentityAndIdleAndTools').value, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|sessionPath|provider|TASK|finalText|model|callToken/);
  for (let i = 0; i < files.length; i++) assert.deepEqual(await fs.readFile(files[i]), bytes[i]);
});

test('M04 doctor reports known cleanup, mutations, Core and exhausted Goal blockers without repairing them', async t => {
  const { f, p, files } = await doctorFixture(t, { goal: true, exhausted: true, corePending: true });
  Object.assign(f.jobs.get('run-clean'), { cleanupPending: true, indeterminate: true, coreTaskSettlementPending: true, pendingMutations: [{ private: 'PRIVATE_MUTATION' }], unsettledMutation: true });
  const bytes = await Promise.all(files.map(file => fs.readFile(file)));
  const result = await f.service.doctor({ projectId: p.projectId }, p.context), row = result.runs.find(row => row.runId === 'run-clean');
  assert.equal(row.cleanupPending, true); assert.equal(row.indeterminate, true); assert.equal(row.pendingMutationCount, 1); assert.equal(row.unsettledMutation, true);
  assert.equal(result.core.unsettled, true); assert.equal(result.core.unsettledOperationCount, 1);
  assert.equal(result.goal.budgetExhausted, true); assert.equal(result.ready, false);
  assert.equal(result.readiness.find(row => row.condition === 'budgetNotExhausted').value, false);
  assert.ok(result.issues.some(issue => issue.runId === 'run-clean' && issue.field === 'pendingMutationCount'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|pendingMutations/);
  for (let i = 0; i < files.length; i++) assert.deepEqual(await fs.readFile(files[i]), bytes[i]);
});

test('M04 actual Research doctor diagnostic reads real mutation fields and scopes recovery warnings without I/O', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.dispose();
  const sdk = { ...f.sdk, tasks: { ...f.sdk.tasks, async list() { return [...f.tasks.values()]; },
    async listSchedules() { return [...f.schedules.values()]; }, async getDelivery() { return { state: 'staged', delivered: false }; } } };
  const forbidden = () => assert.fail('No Core or model execution in diagnostic fixture');
  const open = () => createResearchService(sdk, { contexts: f.contexts, profiles: {
    async getRoleModel(role) { return { role, source: 'saved-role', agentId: `saved-${role}`, model: { provider: 'fixture-provider', id: 'fixture-model' } }; },
  }, createCore: forbidden, sessions: { start: forbidden }, literature: { search: forbidden } });
  let research = await open(), queued;
  try {
    queued = await research.startWorkerRun({ projectId: p.projectId, workerId: 'worker-1' }, origin);
    const diagnostic = research.projectWorkerDiagnostic(p.projectId, queued.runId);
    assert.equal(diagnostic instanceof Promise, false); assert.equal(diagnostic.pendingMutationCount, 0); assert.equal(diagnostic.unsettledMutation, false);
    for (const key of ['resourceBlocked', 'taskCreatePending', 'taskSettlementPending', 'schedulePending']) assert.equal(diagnostic[key], false, key);
    const ordinary = await research.projectWorkerStatus(p.projectId, queued.runId);
    for (const key of ['pendingMutationCount', 'resourceBlocked', 'taskCreatePending', 'taskSettlementPending', 'schedulePending']) assert.equal(Object.hasOwn(ordinary, key), false, key);
    assert.throws(() => research.projectWorkerDiagnostic('project-foreign', queued.runId), { code: 'PROJECT_WORKER_MISMATCH' });
    await research.stopProjectWorker(p.projectId, queued.runId, { force: true });
  } finally { await research.dispose(); }
  const file = path.join(f.dataDir, 'research/runs', queued.runId, 'run.json'), meta = JSON.parse(await fs.readFile(file));
  meta.pendingMutations = [{ callTag: 'mutation-fixture', operation: 'gm_add', createdAt: 1,
    requestFile: `research/runs/${queued.runId}/mutations/mutation-fixture/request.json`, receiptFile: `research/runs/${queued.runId}/mutations/mutation-fixture/receipt.json` }];
  await fs.writeFile(file, JSON.stringify(meta));
  const other = path.join(f.dataDir, 'research/runs/run-other/run.json'); await fs.mkdir(path.dirname(other), { recursive: true }); await fs.writeFile(other, 'PRIVATE_DAMAGED_RUN');
  const get = sdk.tasks.get; sdk.tasks.get = async id => { if (id === meta.taskId) throw Object.assign(new Error('PRIVATE_RECOVERY_ERROR'), { code: 'RPC_TIMEOUT' }); return get(id); };
  let loaded;
  const parse = JSON.parse, decoder = t.mock.method(JSON, 'parse', (...args) => {
    const value = parse(...args); if (!loaded && value?.schemaVersion === 1 && value.runId === queued.runId && value.mode === 'project-worker') loaded = value; return value;
  });
  try { research = await open(); } finally { decoder.mock.restore(); }
  try {
    assert.ok(loaded, 'Retain only this fixture run decoder object, never a production record');
    const bytes = await fs.readFile(file), methods = ['readFile', 'writeFile', 'rename', 'mkdir', 'unlink'].map(name => t.mock.method(fs, name, forbidden)); syncBuiltinESMExports();
    let diagnostic;
    try { diagnostic = research.projectWorkerDiagnostic(p.projectId, queued.runId); }
    finally { methods.forEach(mock => mock.mock.restore()); syncBuiltinESMExports(); }
    assert.equal(diagnostic.pendingMutationCount, 1); assert.equal(diagnostic.unsettledMutation, true); assert.equal(diagnostic.indeterminate, true);
    assert.ok(diagnostic.recoveryWarnings.length > 0); assert.ok(diagnostic.recoveryWarnings.every(row => row.runId === queued.runId));
    assert.deepEqual(diagnostic.recoveryWarnings.map(row => row.error), [{ code: 'RECOVERY_CLEANUP_PENDING' }]);
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_|requestFile|receiptFile|provider|model|sessionPath|callToken/);
    for (const [key, value, expected] of [['resourceBlocked', undefined, false], ['resourceBlocked', { code: 'RESEARCH_RESOURCE_BLOCKED', detail: 'PRIVATE_RESOURCE' }, true],
      ['resourceBlocked', 'PRIVATE_BAD_RESOURCE', 'unknown'], ['taskSettlementPending', undefined, false],
      ['taskCreatePending', undefined, 'unknown'], ['schedulePending', undefined, 'unknown']]) {
      const descriptor = Object.getOwnPropertyDescriptor(loaded, key);
      try {
        if (value === undefined) delete loaded[key]; else loaded[key] = value;
        const scalar = research.projectWorkerDiagnostic(p.projectId, queued.runId);
        assert.equal(scalar[key], expected, key); assert.doesNotMatch(JSON.stringify(scalar), /PRIVATE_RESOURCE|PRIVATE_BAD_RESOURCE/);
        if (value === undefined) assert.equal(Object.hasOwn(loaded, key), false, 'The getter must not initialize absent metadata');
      } finally { if (descriptor) Object.defineProperty(loaded, key, descriptor); else delete loaded[key]; }
    }
    assert.deepEqual(await fs.readFile(file), bytes);
  } finally { sdk.tasks.get = get; await research.dispose(); }
});

test('M04 healthy diagnostic counts are known and stale started state follows the associated run', async t => {
  const { f, p } = await doctorFixture(t, { goal: true, startState: 'started' });
  f.research.projectWorkerStatus = () => assert.fail('Doctor must use the dedicated diagnostic, not status');
  const result = await f.service.doctor({ projectId: p.projectId }, p.context);
  assert.ok(result.runs.every(row => row.pendingMutationCount === 0 && row.unsettledMutation === false));
  const conditions = Object.fromEntries(result.readiness.map(row => [row.condition, row]));
  assert.deepEqual(Object.keys(conditions), ['restartAuthorization', 'priorActive', 'noPendingOrUnknownSend', 'noPendingCleanupOrIndeterminateMutation',
    'allRunsSettled', 'mainHostIdentityAndIdleAndTools', 'noWorkersOrCoreUnsettled', 'explicitDispatchStillAvailable', 'budgetNotExhausted']);
  assert.equal(conditions.noPendingCleanupOrIndeterminateMutation.value, true); assert.equal(conditions.allRunsSettled.value, true);
  assert.equal(conditions.noWorkersOrCoreUnsettled.value, true); assert.equal(conditions.mainHostIdentityAndIdleAndTools.source, 'unknown');
  assert.equal(conditions.priorActive.source, 'doctor-observed');
  f.jobs.get('run-start').state = 'unknown';
  const unknown = await f.service.doctor({ projectId: p.projectId }, p.context);
  assert.equal(unknown.readiness.find(row => row.condition === 'noWorkersOrCoreUnsettled').value, 'unknown');
  assert.equal(unknown.ready, 'unknown');
});

test('M04 invalid history references cannot be omitted from readiness or leak their bytes', async t => {
  const f = await fixture(t), p = await f.create();
  await f.service.goal('start', { projectId: p.projectId, authorized: true, restartAuthorization: { resume: 'preserve-budget' } }, origin);
  await admissionsTurn(); await f.service.dispose();
  const file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), meta = JSON.parse(await fs.readFile(file));
  meta.assignmentHistory.assignments = [{ lastRun: 'PRIVATE_INVALID_REFERENCE' }]; await fs.writeFile(file, JSON.stringify(meta)); await f.open();
  const result = await f.service.doctor({ projectId: p.projectId }, p.context);
  assert.equal(result.ready, 'unknown'); assert.ok(result.issues.some(row => row.code === 'PROJECT_DOCTOR_RUN_REFERENCE_INVALID'));
  assert.equal(result.runs.length, 0);
  for (const condition of ['allRunsSettled', 'noWorkersOrCoreUnsettled', 'noPendingCleanupOrIndeterminateMutation'])
    assert.deepEqual(result.readiness.find(row => row.condition === condition), { condition, value: 'unknown', source: 'unknown' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INVALID_REFERENCE/);
});

test('M04 project task, startup and schedule evidence is projected and aggregated without promoting unknown', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.dispose();
  const file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), clean = JSON.parse(await fs.readFile(file));
  const cases = [
    ['taskCreation', { taskCreation: 'pending' }, false], ['taskSettlement', { taskSettlement: 'unknown' }, 'unknown'],
    ['startup', { startup: { state: 'unknown', private: 'PRIVATE_STARTUP' } }, 'unknown'],
    ['scheduleCleanup', { scheduleCleanup: { state: 'pending', removed: false } }, false],
    ['scheduleCleanup', { scheduleCleanup: { state: 'unknown', removed: 'PRIVATE_FLAG' } }, 'unknown'],
  ];
  for (const [field, patch, expected] of cases) {
    await fs.writeFile(file, JSON.stringify({ ...clean, ...patch })); await f.open();
    const before = await fileSnapshot(f.dataDir), result = await f.service.doctor({ projectId: p.projectId }, p.context);
    assert.equal(result.ready, expected, JSON.stringify(result));
    assert.ok(result.issues.some(issue => issue.field === field && !Object.hasOwn(issue, 'runId')
      && issue.code === (expected === false ? 'PROJECT_DOCTOR_PROJECT_UNSETTLED' : 'PROJECT_DOCTOR_PROJECT_UNKNOWN')));
    assert.equal(result.project.taskCreation, patch.taskCreation ?? clean.taskCreation);
    assert.equal(result.project.taskSettlement, patch.taskSettlement ?? clean.taskSettlement);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
    assert.deepEqual(await fileSnapshot(f.dataDir), before);
    await f.service.dispose();
  }
});

test('M04 worker pending and unknown states expose only stable worker/field issues', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.dispose();
  const file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), clean = JSON.parse(await fs.readFile(file));
  for (const field of ['assignment', 'start']) for (const state of ['pending', 'unknown', 'PRIVATE_BAD_STATE']) {
    const meta = structuredClone(clean); meta.worker[field].state = state;
    meta.worker[field].private = 'PRIVATE_TASK_OR_MODEL';
    await fs.writeFile(file, JSON.stringify(meta)); await f.open();
    const before = await fileSnapshot(f.dataDir), result = await f.service.doctor({ projectId: p.projectId }, p.context);
    assert.equal(result.ready, state === 'pending' ? false : 'unknown');
    assert.ok(result.issues.some(issue => issue.workerId === 'worker-1' && issue.field === field
      && issue.code === (state === 'pending' ? 'PROJECT_DOCTOR_WORKER_UNSETTLED' : 'PROJECT_DOCTOR_WORKER_UNKNOWN')));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|provider|TASK|model/);
    assert.deepEqual(await fileSnapshot(f.dataDir), before); await f.service.dispose();
  }
});

test('M04 valid worker with genuinely empty history has settled run and mutation readiness', async t => {
  const f = await fixture(t), p = await f.create();
  await f.service.goal('start', { projectId: p.projectId, authorized: true, restartAuthorization: { resume: 'preserve-budget' } }, origin);
  await admissionsTurn(); await f.service.dispose(); await f.open();
  const result = await f.service.doctor({ projectId: p.projectId }, p.context);
  assert.deepEqual(result.runs, []);
  for (const condition of ['allRunsSettled', 'noWorkersOrCoreUnsettled', 'noPendingCleanupOrIndeterminateMutation'])
    assert.equal(result.readiness.find(row => row.condition === condition).value, true);
});

test('M04 doctor rejects a Host main identity change during run reads instead of returning diagnostics', async t => {
  const { f, p } = await doctorFixture(t), original = f.research.projectWorkerDiagnostic;
  f.research.projectWorkerDiagnostic = async (...args) => { const result = await original(...args); f.host.get(p.context.sessionPath).agentId = 'foreign-main'; return result; };
  await assert.rejects(f.service.doctor({ projectId: p.projectId }, p.context), { code: 'PROJECT_MAIN_DENIED' });
});

test('M04 doctor exposes an existing persistence failure without attempting to save it again', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.dispose(); await f.open();
  const open = t.mock.method(fs, 'open', async () => { throw Object.assign(new Error('PRIVATE_WRITE_ERROR'), { code: 'EIO' }); }); syncBuiltinESMExports();
  try { await assert.rejects(f.service.assign({ task: 'opaque failed assignment' }, p.context), { code: 'EIO' }); }
  finally { open.mock.restore(); syncBuiltinESMExports(); }
  const result = await f.service.doctor({ projectId: p.projectId }, p.context);
  assert.equal(result.persistenceFailed, true); assert.equal(result.ready, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_WRITE_ERROR|failed assignment/);
});

test('M04 damaged project doctor returns a fixed code while a separate valid project remains queryable', async t => {
  const f = await fixture(t), damaged = await f.create(), healthy = await f.create(); await f.service.dispose();
  const file = path.join(f.dataDir, 'research/projects', damaged.projectId, 'project.json'); await fs.writeFile(file, 'PRIVATE_BROKEN_JSON'); await f.open();
  assert.deepEqual(await f.service.doctor({ projectId: damaged.projectId }, damaged.context), { projectId: damaged.projectId, state: 'invalid', error: { code: 'PROJECT_RECORD_INVALID' } });
  assert.equal((await f.service.doctor({ projectId: healthy.projectId }, healthy.context)).ready, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'PRIVATE_BROKEN_JSON');
});

test('D04 Project readiness preserves dispatch and all run history, and never starts an old worker', async t => {
  const f = await fixture(t, { recoveryIdle: true }), p = await f.create(), validations = [];
  f.research.validateWorkerDispatch = async input => { validations.push(structuredClone(input)); return structuredClone(input); };
  const dispatch = { model: { provider: 'fixture-provider', id: 'fixture-model' }, thinkingLevel: 'high' };
  await f.service.assign({ task: 'opaque recovery task', ...dispatch }, p.context);
  await f.service.goal('start', { projectId: p.projectId, authorized: true, restartAuthorization: { resume: 'preserve-budget' } }, origin);
  await admissionsTurn(); assert.equal((await f.service.dispose()).cleanupPending, false);
  const projectFile = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), before = await fs.readFile(projectFile);
  const counts = { sends: f.calls.sends.length, creates: f.calls.sessions.length, starts: f.calls.starts.length };
  await f.open(); assert.equal(f.calls.sends.length, counts.sends);
  const first = f.service.activateRestarts(); await Promise.all([first, f.service.activateRestarts()]);
  assert.equal((await f.service.goal('status', { projectId: p.projectId }, origin)).state, 'active');
  assert.equal(f.calls.sends.length, counts.sends + 1); assert.equal(f.calls.sessions.length, counts.creates); assert.equal(f.calls.starts.length, counts.starts);
  assert.deepEqual(await fs.readFile(projectFile), before); assert.deepEqual(validations.at(-1), dispatch);
});

for (const gate of ['historical-run', 'missing-run', 'unknown-run', 'core', 'agent', 'busy', 'dispatch', 'project-state', 'worker-state']) test(`D04 Project recovery gate ${gate} blocks without replacing main or replaying workers`, async t => {
  const f = await fixture(t, { recoveryIdle: true }), p = await f.create();
  f.research.validateWorkerDispatch = async input => structuredClone(input);
  await f.service.assign({ task: 'opaque recovery gate', ...(gate === 'dispatch' ? { model: { provider: 'fixture-provider', id: 'fixture-model' } } : {}) }, p.context);
  let first;
  if (['historical-run', 'missing-run', 'unknown-run'].includes(gate)) {
    first = await f.service.start({ projectId: p.projectId }, p.context); await f.service.stop({ projectId: p.projectId }, p.context);
    await f.service.start({ projectId: p.projectId }, p.context); await f.service.stop({ projectId: p.projectId }, p.context);
  }
  await f.service.goal('start', { projectId: p.projectId, authorized: true, restartAuthorization: { resume: 'preserve-budget' } }, origin);
  await admissionsTurn(); await f.service.dispose();
  if (gate === 'historical-run') f.jobs.get(first.runId).indeterminate = true;
  if (gate === 'missing-run' || gate === 'unknown-run') {
    const original = f.research.projectWorkerStatus;
    f.research.projectWorkerStatus = (projectId, runId) => runId === first.runId ? { state: gate === 'missing-run' ? 'missing' : 'unknown' } : original(projectId, runId);
  }
  if (gate === 'project-state' || gate === 'worker-state') {
    const file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), meta = JSON.parse(await fs.readFile(file));
    if (gate === 'project-state') meta.startup.state = 'unknown'; else meta.worker.start.state = 'unknown';
    await fs.writeFile(file, JSON.stringify(meta));
  }
  if (gate === 'agent') f.agents[0].ownerPluginId = 'foreign';
  if (gate === 'busy') { const context = f.sdk.sessions.context; f.sdk.sessions.context = async input => ({ ...await context(input), isStreaming: true }); }
  if (gate === 'dispatch') f.research.validateWorkerDispatch = async () => { throw Object.assign(new Error('fixture'), { code: 'MODEL_NOT_AVAILABLE' }); };
  if (gate === 'core') {
    const root = path.join(f.dataDir, 'research/projects', p.projectId, 'core'); await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'damaged.json'), '{}');
  }
  const counts = { sends: f.calls.sends.length, sessions: f.calls.sessions.length, starts: f.calls.starts.length };
  await f.open(); await f.service.activateRestarts();
  const result = await f.service.goal('status', { projectId: p.projectId }, origin);
  assert.equal(result.state, 'blocked'); assert.equal(f.calls.sends.length, counts.sends); assert.equal(f.calls.sessions.length, counts.sessions); assert.equal(f.calls.starts.length, counts.starts);
  assert.equal(result.error, { 'historical-run': 'PROJECT_WORKER_UNSETTLED', 'missing-run': 'PROJECT_RECOVERY_RUN_UNKNOWN', 'unknown-run': 'PROJECT_RECOVERY_RUN_UNKNOWN', core: 'PROJECT_CORE_UNSETTLED', agent: 'PROJECT_MAIN_DENIED', busy: 'MAIN_CONTROL_MAIN_NOT_IDLE', dispatch: 'MODEL_NOT_AVAILABLE', 'project-state': 'PROJECT_RECOVERY_UNSETTLED', 'worker-state': 'PROJECT_WORKER_UNSETTLED' }[gate]);
});

async function createReadyProject(f) {
  const p = await f.create();
  assert.equal(p.status.state, 'ready', `fixture setup did not reach ready: ${p.status.error ?? 'no setup error'}`);
  assert.ok(p.context, 'ready fixture must have a bound main');
  return p;
}

for (const caller of ['creator', 'main', 'moved-main']) test(`verification_reads ${caller} is authorized with zero writes, locator mutation or lifecycle calls`, async t => {
  const f = await fixture(t), p = await f.create(); await f.service.assign({ task: 'opaque read-audit fixture' }, p.context);
  const run = await f.service.start({ projectId: p.projectId }, p.context);
  const file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json');
  await admissionsTurn(); const before = await fs.readFile(file), oldPath = p.status.main.sessionPath;
  let ctx = caller === 'creator' ? origin : p.context;
  if (caller === 'moved-main') {
    const row = f.host.get(oldPath); f.host.delete(oldPath); const moved = '/fixture/read-audit-moved.jsonl';
    f.host.set(moved, { ...row, path: moved }); ctx = { ...p.context, sessionPath: moved };
  }
  const counts = Object.fromEntries(['tasks', 'schedules', 'unschedules', 'sessions', 'sends', 'starts', 'stops', 'core', 'factories'].map(k => [k, f.calls[k].length]));
  const status = f.research.projectWorkerStatus, stop = f.research.stopProjectWorker;
  f.research.projectWorkerStatus = () => assert.fail('No status/refresh'); f.research.stopProjectWorker = () => assert.fail('No stop');
  const open = fs.open;
  t.mock.method(fs, 'open', async (file, flags, ...rest) => { assert.equal(flags & 3, 0, 'No writable open'); return open(file, flags, ...rest); });
  for (const name of ['writeFile', 'rename', 'mkdir', 'unlink']) t.mock.method(fs, name, () => assert.fail('Read action must not write: ' + name));
  try {
    const dto = await f.service.verificationReads({ projectId: p.projectId, runId: run.runId, submissionId: 'submission-fixture' }, ctx);
    assert.equal(dto.coverage, 'not-needed'); assert.equal(dto.workerId, 'worker-1');
    assert.deepEqual(f.calls.readAudits, [{ projectId: p.projectId, runId: run.runId, workerId: 'worker-1', submissionId: 'submission-fixture' }]);
    assert.deepEqual(await fs.readFile(file), before);
    for (const [key, count] of Object.entries(counts)) assert.equal(f.calls[key].length, count, key);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.research.projectWorkerStatus = status; f.research.stopProjectWorker = stop; }
  // Read the ordinary projection only after the zero-write window. It sees the old
  // in-memory locator, proving the diagnostic did not just avoid a disk save.
  assert.equal((await f.service.status(p.projectId, origin)).main.sessionPath, oldPath);
  if (caller === 'moved-main') assert.equal((await f.service.status(p.projectId, ctx)).main.sessionPath, ctx.sessionPath, 'Ordinary authorization retains locator migration');
});
for (const [key, value] of [['sessionId', 'other-main-sid'], ['agentId', 'other-saved-main'], ['cwd', '/fixture/other-cwd'], ['kind', 'math-project:other:main'],
  ['sessionPath', '/fixture/other-locator.jsonl'], ['namespace', 'app'], ['visibility', 'plugin_private'], ['ownerPluginId', 'other-app']]) {
  test(`read-only main authorization rejects in-place ${key} change during final agents.list`, async t => {
    const f = await fixture(t), p = await createReadyProject(f); await f.service.assign({ task: 'opaque' }, p.context);
    const run = await f.service.start({ projectId: p.projectId }, p.context);
    // Capture the actual object supplied by the fixture's persisted-record decoder,
    // not a status projection/copy. No production test hook or config write is added.
    const parse = JSON.parse; let record;
    const decode = t.mock.method(JSON, 'parse', (...args) => {
      const value = parse(...args); if (value?.projectId === p.projectId && value.main?.sessionId === p.status.main.sessionId && Array.isArray(value.worker?.runs)) record = value;
      return value;
    });
    try { await f.open(); } finally { decode.mock.restore(); }
    assert.ok(record); const binding = record.main, before = structuredClone(binding);
    const file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), bytes = await fs.readFile(file);
    const original = f.sdk.agents.list; let changed = false;
    f.sdk.agents.list = async input => {
      const reply = await original(input); binding[key] = value; changed = true;
      assert.equal(record.main, binding); assert.equal(binding.state, 'ready'); assert.equal(binding.identityConfirmed, true);
      // In the agentId case the reply is another fully valid owned-main, so role
      // validation alone would succeed against the mutated field.
      if (key === 'agentId') reply.agents = [{ ...reply.agents[0], id: value }];
      return reply;
    };
    try {
      await assert.rejects(f.service.verificationReads({ projectId: p.projectId, runId: run.runId, submissionId: 'submission-fixture' }, p.context), { code: 'PROJECT_MAIN_DENIED' });
      assert.equal(changed, true); assert.equal(f.calls.readAudits, undefined, 'No Research evidence work after changed main identity');
      assert.deepEqual(await fs.readFile(file), bytes, 'No locator/state persistence by read-only authorization');
    } finally { Object.assign(binding, before); f.sdk.agents.list = original; }
  });
}

for (const caller of ['worker', 'verifier', 'foreign']) test(`verification_reads denies ${caller} before Research disclosure`, async t => {
  const f = await fixture(t), p = await createReadyProject(f), sessionPath = '/fixture/audit-' + caller;
  f.host.set(sessionPath, { sessionId: 'audit-' + caller, path: sessionPath, ownerPluginId: caller === 'foreign' ? 'other-app' : APP,
    namespace: 'app', visibility: 'plugin_private', lifecycle: 'active', agentId: 'saved-' + caller, cwd: '/fixture/private', kind: 'opaque' });
  await assert.rejects(f.service.verificationReads({ projectId: p.projectId, runId: 'run-foreign', submissionId: 'submission-fixture' }, { callToken: 'host-fixture', sessionPath }), { code: 'PROJECT_OWNER_DENIED' });
  assert.equal(f.calls.readAudits, undefined);
});
// A project persisted before 0.18.0 has no workerPolicy and keeps the legacy bridge.
// New projects cannot be created that way, so tests reproduce the persisted record.
async function persistLegacy(f, id) {
  const file = path.join(f.dataDir, 'research/projects', id, 'project.json');
  const meta = JSON.parse(await fs.readFile(file)); delete meta.workerPolicy; await fs.writeFile(file, JSON.stringify(meta));
}

test('verification_reads requires recorded run membership and exact identity-only input', async t => {
  const f = await fixture(t), p = await f.create();
  const args = { projectId: p.projectId, runId: 'run-foreign', submissionId: 'submission-fixture' };
  await assert.rejects(f.service.verificationReads(args, origin), { code: 'PROJECT_WORKER_MISMATCH' });
  for (const field of ['sessionId', 'sessionPath', 'role', 'author', 'workerId', 'readOnly']) await assert.rejects(f.service.verificationReads({ ...args, [field]: 'opaque' }, origin), { code: 'PROJECT_INVALID_INPUT' });
  assert.equal(f.calls.readAudits, undefined);
});
test('read-only permission is rechecked after Research awaits; errors are not evidence DTOs', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.assign({ task: 'opaque' }, p.context);
  const run = await f.service.start({ projectId: p.projectId }, p.context);
  f.behavior.auditHook = () => { f.agents[0].state = 'archived'; };
  await assert.rejects(f.service.verificationReads({ projectId: p.projectId, runId: run.runId, submissionId: 'submission-fixture' }, p.context), { code: 'PROJECT_MAIN_DENIED' });
  assert.equal(f.calls.readAudits.length, 1);
});

for (const firstTool of ['math_project', 'fact_search']) test(`registered main Core calls wait for the preceding ${firstTool} settlement`, async t => {
  const entered = defer(), release = defer();
  const f = await fixture(t, { async coreCall(_binding, operation) {
    if (operation === (firstTool === 'math_project' ? 'fact_list_page' : 'fact_search')) { entered.resolve(); await release.promise; return { facts: [] }; }
    return { entries: [] };
  } }), p = await createReadyProject(f), tools = new Map();
  f.sdk.tools.register = async tool => { tools.set(tool.name, tool); return () => {}; };
  const unused = () => assert.fail('unexpected legacy operation');
  const legacy = Object.fromEntries(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'recordSubmissionInputRejection', 'invoke'].map(name => [name, unused]));
  const registration = await registerMathResearch(f.sdk, legacy, f.service); t.after(() => registration.dispose());
  const first = tools.get(firstTool).execute(firstTool === 'math_project' ? { action: 'result', projectId: p.projectId, context: p.context } : { query: 'opaque first', context: p.context });
  let second;
  try {
    await Promise.race([entered.promise, first.then(reply => assert.fail(`first Core call settled before reaching the fixture gate: ${JSON.stringify(reply.details)}`))]);
    second = tools.get('gm_search').execute({ query: 'opaque query', context: p.context });
    await new Promise(resolve => setTimeout(resolve, 30)); release.resolve();
    assert.equal((await first).isError, false); const next = await second; assert.equal(next.isError, false, JSON.stringify(next.details));
    assert.deepEqual(f.calls.core.map(call => call.operation), [firstTool === 'math_project' ? 'fact_list_page' : 'fact_search', 'gm_search']);
    assert.equal(f.calls.factories.length, 2);
  } finally { release.resolve(); await Promise.allSettled([first, second]); }
});

// Fixture authorization consists solely of resolved SDK promises; one event-loop turn
// drains that microtask chain, without shortening any production deadline.
const admissionsTurn = () => new Promise(resolve => setImmediate(resolve));

test('main Core FIFO snapshots nested input and does not lock another project', async t => {
  const entered = defer(), release = defer(); let blockedProject;
  const f = await fixture(t, { async coreCall(binding, operation) {
    if (binding.projectId === blockedProject && operation === 'fact_list_page') { entered.resolve(); await release.promise; }
    return operation === 'fact_list_page' ? { facts: [] } : { entries: [] };
  } }), p = await f.create(), other = await f.create(); blockedProject = p.projectId;
  const first = f.service.result({ projectId: p.projectId }, origin), waiting = [];
  try {
    await entered.promise;
    const args = { query: 'opaque original', kinds: ['opaque-kind'] };
    waiting.push(f.service.invoke('gm_search', args, p.context)); await admissionsTurn();
    args.query = 'changed'; args.kinds.push('changed');
    waiting.push(f.service.invoke('fact_search', { query: 'opaque next' }, p.context)); await admissionsTurn();
    assert.deepEqual(await f.service.result({ projectId: other.projectId }, origin), { projectId: other.projectId, ...fixtureFactPage([], {}, other.projectId) });
    assert.equal(f.calls.core.filter(c => c.binding.projectId === p.projectId).length, 1);
    release.resolve(); await first; await Promise.all(waiting);
    const own = f.calls.core.filter(c => c.binding.projectId === p.projectId);
    assert.deepEqual(own.map(c => c.operation), ['fact_list_page', 'gm_search', 'fact_search']);
    assert.deepEqual(own[1].args, { query: 'opaque original', kinds: ['opaque-kind'] });
  } finally { release.resolve(); await Promise.allSettled([first, ...waiting]); }
});

for (const uncertain of [false, true]) test(`main Core queue retains prior ${uncertain ? 'unknown mutation fence' : 'clean failure semantics'}`, async t => {
  const entered = defer(), release = defer();
  const f = await fixture(t, { async coreCall(_binding, operation) {
    if (operation === 'gm_add') { entered.resolve(); await release.promise; throw Object.assign(new Error('opaque failure'), { indeterminate: uncertain, cleanup: { confirmed: true } }); }
    return { facts: [] };
  } }), p = await f.create();
  const first = assert.rejects(f.service.invoke('gm_add', { kind: 'opaque', claim: 'opaque' }, p.context)); let next;
  try {
    await entered.promise; next = f.service.result({ projectId: p.projectId }, origin);
    const outcome = uncertain ? assert.rejects(next, { code: 'PROJECT_CORE_UNSETTLED' }) : next;
    await admissionsTurn(); release.resolve(); await first; await outcome;
    assert.equal(f.calls.core.length, uncertain ? 1 : 2);
    if (uncertain) {
      const directory = path.join(f.dataDir, 'research/projects', p.projectId, 'core');
      const [file] = await fs.readdir(directory); assert.equal(JSON.parse(await fs.readFile(path.join(directory, file))).mathematicalUnsettled, true);
    }
  } finally { release.resolve(); await Promise.allSettled([first, next]); }
});

test('Goal complete uses the same main Core admission queue for canonical fact_get', async t => {
  const entered = defer(), release = defer(), factId = 'a'.repeat(16);
  const f = await fixture(t, { async coreCall(_binding, operation, args) {
    if (operation === 'fact_list_page') { entered.resolve(); await release.promise; return { facts: [] }; }
    assert.equal(operation, 'fact_get'); return { fact_id: args.fact_id, predecessors: [], markdown: 'opaque canonical bytes' };
  } }), p = await f.create();
  const goal = await f.service.goal('start', { projectId: p.projectId, authorized: true }, origin);
  const first = f.service.result({ projectId: p.projectId }, origin); let complete;
  try {
    await entered.promise;
    complete = f.service.goal('complete', { projectId: p.projectId, goalId: goal.goalId, generation: goal.generation, factIds: [factId] }, p.context);
    await admissionsTurn(); assert.equal(f.calls.factories.length, 1);
    release.resolve(); await first; assert.equal((await complete).state, 'completed');
    assert.deepEqual(f.calls.core.map(c => c.operation), ['fact_list_page', 'fact_get']);
  } finally { release.resolve(); await Promise.allSettled([first, complete]); }
});

test('main Core admission rejects forbidden selectors, oversized arguments and foreign actors without work', async t => {
  const f = await fixture(t), p = await f.create();
  for (const args of [{ query: 'opaque', actor: 'main' }, { query: 'opaque', sessionId: 'main' }, { query: 'opaque', context: origin }, { query: 'x'.repeat((1 << 20) + 1) }]) {
    await assert.rejects(f.service.invoke('gm_search', args, p.context), { code: 'PROJECT_CORE_INVALID_INPUT' });
  }
  await assert.rejects(f.service.invoke('gm_search', { query: 'opaque' }, origin), { code: 'PROJECT_MAIN_DENIED' });
  await assert.rejects(f.service.result({ projectId: p.projectId }, { callToken: 'opaque-foreign', sessionPath: '/fixture/foreign.jsonl' }), { code: 'PROJECT_OWNER_DENIED' });
  assert.equal(f.calls.factories.length, 0);
});

test('main Core queue reauthorizes identity before dispatch', async t => {
  const entered = defer(), release = defer();
  const f = await fixture(t, { async coreCall() { entered.resolve(); await release.promise; return { facts: [] }; } }), p = await f.create();
  const first = f.service.result({ projectId: p.projectId }, origin); let next;
  try {
    await entered.promise; next = assert.rejects(f.service.invoke('gm_search', { query: 'opaque' }, p.context), { code: 'PROJECT_MAIN_DENIED' });
    await admissionsTurn(); f.host.get(p.context.sessionPath).agentId = 'changed-identity';
    release.resolve(); await first; await next; assert.equal(f.calls.factories.length, 1);
  } finally { release.resolve(); await Promise.allSettled([first, next]); }
});

test('main Core queue caps waiting at sixteen and expired slots never dispatch or fence mathematics', async t => {
  const entered = defer(), release = defer();
  const f = await fixture(t, { async coreCall() { entered.resolve(); await release.promise; return { facts: [] }; } }), p = await f.create();
  const first = f.service.result({ projectId: p.projectId }, origin), waiting = [];
  try {
    await entered.promise;
    for (let i = 0; i < 16; i++) waiting.push(assert.rejects(f.service.invoke('gm_add', { kind: 'opaque', claim: String(i) }, p.context), { code: 'PROJECT_CORE_QUEUE_TIMEOUT' }));
    await admissionsTurn();
    await assert.rejects(f.service.result({ projectId: p.projectId }, origin), { code: 'PROJECT_CORE_QUEUE_FULL' });
    await Promise.all(waiting); release.resolve(); await first; await admissionsTurn();
    assert.equal(f.calls.factories.length, 1);
    const directory = path.join(f.dataDir, 'research/projects', p.projectId, 'core'), files = await fs.readdir(directory);
    assert.equal(files.length, 1); assert.equal(JSON.parse(await fs.readFile(path.join(directory, files[0]))).mathematicalUnsettled, false);
    await f.service.result({ projectId: p.projectId }, origin); assert.equal(f.calls.factories.length, 2);
  } finally { release.resolve(); await Promise.allSettled([first, ...waiting]); }
});

for (const cancellation of ['timeout', 'dispose']) test(`main Core ${cancellation} during dequeue authorization cannot dispatch late`, async t => {
  const entered = defer(), release = defer(), authorizing = defer(), authorizationRelease = defer();
  const f = await fixture(t, { async coreCall() { entered.resolve(); await release.promise; return { facts: [] }; } }), p = await f.create();
  const first = f.service.result({ projectId: p.projectId }, origin); let next, disposing, block = false;
  const list = f.sdk.sessions.list;
  f.sdk.sessions.list = async input => { if (block) { authorizing.resolve(); await authorizationRelease.promise; } return list(input); };
  try {
    await entered.promise;
    next = assert.rejects(f.service.result({ projectId: p.projectId }, origin), { code: cancellation === 'timeout' ? 'PROJECT_CORE_QUEUE_TIMEOUT' : 'PROJECT_CORE_QUEUE_CANCELLED' });
    await admissionsTurn(); block = true; release.resolve(); await first; await authorizing.promise;
    if (cancellation === 'dispose') disposing = f.service.dispose();
    await next; block = false; authorizationRelease.resolve(); await disposing; await admissionsTurn();
    assert.equal(f.calls.factories.length, 1);
    if (cancellation === 'dispose') await assert.rejects(f.service.result({ projectId: p.projectId }, origin), { code: 'PROJECT_DISPOSED' });
  } finally { block = false; release.resolve(); authorizationRelease.resolve(); await Promise.allSettled([first, next, disposing]); }
});

test('dispose cancels queued Core work and rejects admission already awaiting its initial authorization', async t => {
  const entered = defer(), release = defer(), authorizing = defer(), authorizationRelease = defer();
  const f = await fixture(t, { async coreCall() { entered.resolve(); await release.promise; return { facts: [] }; } }), p = await f.create();
  const first = f.service.result({ projectId: p.projectId }, origin); first.catch(() => {}); let next, racing, disposing;
  const list = f.sdk.sessions.list;
  try {
    await entered.promise;
    next = assert.rejects(f.service.result({ projectId: p.projectId }, origin), { code: 'PROJECT_CORE_QUEUE_CANCELLED' }); await admissionsTurn();
    f.sdk.sessions.list = async input => { authorizing.resolve(); await authorizationRelease.promise; return list(input); };
    racing = assert.rejects(f.service.result({ projectId: p.projectId }, origin), { code: 'PROJECT_DISPOSED' });
    await authorizing.promise; disposing = f.service.dispose(); await next;
    authorizationRelease.resolve(); release.resolve(); await racing; await disposing; await Promise.allSettled([first]);
    assert.equal(f.calls.factories.length, 1);
  } finally { release.resolve(); authorizationRelease.resolve(); f.sdk.sessions.list = list; await Promise.allSettled([first, next, racing, disposing]); }
});

test('project worker admission consumes the durable candidate settlement projection', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.assign({ task: 'opaque settlement consumer' }, p.context);
  const job = await f.service.start({ projectId: p.projectId }, p.context), row = f.jobs.get(job.runId);
  Object.assign(row, { state: 'failed', coordinatorActive: false, candidateSettlement: { pending: true, valid: true, submissionId: 'submission-fixture', stage: 'canonical-readback' } });
  for (const projection of [row.candidateSettlement, { pending: true, valid: false }, {}]) {
    row.candidateSettlement = projection;
    await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'PROJECT_WORKER_UNSETTLED' });
  }
  assert.equal(f.calls.starts.length, 1);
  row.candidateSettlement = null; await f.service.start({ projectId: p.projectId }, p.context); assert.equal(f.calls.starts.length, 2);
});

test('registered math_goal_main enforces bound-main identity and drives the actual Goal controller', async t => {
  const f = await fixture(t), tools = new Map();
  f.sdk.tools.register = async tool => { tools.set(tool.name, tool); return () => {}; };
  const unused = () => assert.fail('unexpected legacy operation');
  const legacy = Object.fromEntries(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'recordSubmissionInputRejection', 'invoke'].map(name => [name, unused]));
  const registration = await registerMathResearch(f.sdk, legacy, f.service); t.after(() => registration.dispose());
  const p = await f.create(), other = await f.create(), mainTool = tools.get('math_goal_main'), creatorTool = tools.get('math_goal');
  assert.equal(Object.hasOwn(creatorTool, 'sessionPermission'), false);
  for (const [name, tool] of tools) if (name !== 'math_goal_main') assert.equal(Object.hasOwn(tool, 'sessionPermission'), false);
  const permission = mainTool.sessionPermission;
  assert.deepEqual(structuredClone(permission), JSON.parse(JSON.stringify(permission)));
  assert.equal(permission.auto, 'allow'); assert.equal(Object.hasOwn(permission, 'readOnly'), false);
  assert.deepEqual(permission.sideEffect, { updatesGoalState: true, mayStopProjectWorkers: true, startsNewGoal: false, replenishesContinuationAllowance: false });
  assert.match(permission.description, /Ask mode/); assert.doesNotMatch(JSON.stringify(permission.sideEffect), /actor|server|session/i);
  assert.deepEqual(mainTool.parameters.properties.action.enum, ['status', 'acknowledge', 'wait', 'continue_work', 'pause', 'stop', 'complete']);
  assert.equal(mainTool.parameters.oneOf.length, 7); assert.equal(mainTool.parameters.additionalProperties, false);
  const started = await creatorTool.execute({ action: 'start', projectId: p.projectId, authorized: true, context: origin });
  assert.equal(started.isError, false); const goal = started.details;
  const identity = { projectId: p.projectId, goalId: goal.goalId, generation: goal.generation };
  const requests = [
    { action: 'status', projectId: p.projectId }, { action: 'acknowledge', ...identity, controlAt: goal.due.control.at, auditAt: goal.due.audit.at },
    { action: 'wait', ...identity }, { action: 'continue_work', ...identity }, { action: 'pause', projectId: p.projectId },
    { action: 'stop', projectId: p.projectId, force: true }, { action: 'complete', ...identity, factIds: ['a'.repeat(16)] },
  ];
  const callers = [origin, other.context];
  for (const role of ['worker', 'verifier', 'foreign']) {
    const sessionPath = `/fixture/main-control-${role}.jsonl`;
    f.host.set(sessionPath, { ...f.host.get(p.context.sessionPath), path: sessionPath, sessionId: `opaque-${role}`, namespace: role === 'foreign' ? 'home' : 'app', visibility: role === 'foreign' ? 'public' : 'plugin_private' });
    callers.push({ callToken: `opaque-${role}-token`, sessionPath });
  }
  for (const context of callers) for (const request of requests) {
    const response = await mainTool.execute({ ...request, context });
    assert.equal(response.isError, true); assert.equal(response.details.error.code, 'PROJECT_MAIN_DENIED');
  }
  for (const request of [{ action: 'start', projectId: p.projectId, authorized: true }, { action: 'resume', projectId: p.projectId },
    ...['authorized', 'maxAutomaticContinues', 'actor', 'sessionId', 'role'].map(key => ({ action: 'status', projectId: p.projectId, [key]: true }))]) {
    assert.equal((await mainTool.execute({ ...request, context: p.context })).details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
  }
  for (const action of ['start', 'resume']) await assert.rejects(f.service.mainGoal(action, { projectId: p.projectId }, p.context), { code: 'PROJECT_TOOL_DENIED' });
  const pending = await mainTool.execute({ action: 'wait', ...identity, context: p.context });
  assert.equal(pending.details.error.code, 'MAIN_CONTROL_DUE_UNACKNOWLEDGED'); assert.match(pending.details.error.message, /math_goal_main acknowledge/);
  const execute = request => mainTool.execute({ ...request, context: p.context });
  assert.equal((await execute(requests[0])).isError, false);
  assert.equal((await execute(requests[1])).isError, false);
  assert.equal((await execute(requests[2])).details.waiting, true);
  assert.equal((await execute(requests[3])).details.waiting, false);
  await f.service.assign({ task: 'opaque internal tool worker' }, p.context); await f.service.start({ projectId: p.projectId }, p.context);
  assert.equal((await execute(requests[4])).details.state, 'paused'); assert.equal(f.calls.stops.length, 0);
  assert.equal((await execute(requests[5])).details.state, 'stopped'); assert.deepEqual(f.calls.stops.at(-1).options, { force: true });
  const resumed = await creatorTool.execute({ action: 'resume', projectId: p.projectId, context: origin }); assert.equal(resumed.isError, false);
  const complete = await execute({ action: 'complete', ...identity, generation: resumed.details.generation, factIds: ['a'.repeat(16)] });
  assert.equal(complete.details.state, 'completed'); assert.equal(f.calls.core.at(-1).operation, 'fact_get');
  assert.ok(f.calls.sends.some(call => call.message?.includes('math_goal_main') || call.prompt?.includes('math_goal_main')) || JSON.stringify(f.calls.sends).includes('math_goal_main'));
});

test('real ProjectService/MainControl honors tools readiness, authority, wait and pause semantics', async t => {
  const f = await fixture(t, { roundBoundaryStop: true }), p = await f.create({ problem: 'opaque goal', workerPolicy: {} }), other = await f.create();
  assert.equal((await f.service.goal('status', { projectId: p.projectId }, origin)).managed, false);
  await assert.rejects(f.service.goal('start', { projectId: p.projectId, authorized: true }, p.context), { code: 'MAIN_CONTROL_FORBIDDEN' });
  f.behavior.goalToolsPending = true;
  await assert.rejects(f.service.goal('start', { projectId: p.projectId, authorized: true }, origin), { code: 'MAIN_CONTROL_TOOLS_PENDING' });
  assert.equal((await f.service.goal('status', { projectId: p.projectId }, origin)).managed, false);
  assert.equal((await f.service.status(p.projectId, origin)).state, 'ready'); assert.equal(f.calls.sessions.length, 2);
  f.behavior.goalToolsPending = false;
  const goal = await f.service.goal('start', { projectId: p.projectId, authorized: true }, origin);
  const identity = { projectId: p.projectId, goalId: goal.goalId, generation: goal.generation };
  await assert.rejects(f.service.goal('wait', identity, other.context), { code: 'PROJECT_OWNER_DENIED' });
  await assert.rejects(f.service.goal('wait', identity, origin), { code: 'MAIN_CONTROL_FORBIDDEN' });
  const workerPath = '/fixture/goal-worker.jsonl'; f.host.set(workerPath, { ...f.host.get(p.context.sessionPath), sessionId: 'goal-worker', path: workerPath, namespace: 'app', visibility: 'plugin_private' });
  await assert.rejects(f.service.goal('status', { projectId: p.projectId }, { sessionPath: workerPath, callToken: 'opaque-worker' }), { code: 'PROJECT_OWNER_DENIED' });
  await f.service.goal('acknowledge', { ...identity, controlAt: goal.due.control.at, auditAt: goal.due.audit.at }, p.context);
  assert.equal((await f.service.goal('wait', identity, p.context)).waiting, true);
  assert.equal((await f.service.goal('continue_work', identity, p.context)).waiting, false);
  await f.service.assign({ task: 'opaque goal task' }, p.context);
  await f.service.start({ projectId: p.projectId }, p.context); assert.equal(f.calls.starts.at(-1).context, p.context);
  await f.service.goal('pause', { projectId: p.projectId }, origin); assert.equal(f.calls.stops.length, 0);
  await assert.rejects(f.service.assign({ task: 'opaque denied' }, p.context), { code: 'MAIN_CONTROL_WORK_DENIED' });
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'MAIN_CONTROL_WORK_DENIED' });
  const stopped = await f.service.goal('stop', { projectId: p.projectId }, origin);
  assert.equal(stopped.workerStop.state, 'requested'); assert.equal(stopped.workerStop.cleanupPending, true);
  assert.deepEqual(f.calls.stops.at(-1).options, { force: false });
  await f.service.dispose(); assert.deepEqual(f.calls.stops.at(-1).options, { force: true });
});

test('Goal pause during real TASK validation prevents any preparing receipt or TASK replacement', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.assign({ task: 'opaque prior task' }, p.context);
  await f.service.goal('start', { projectId: p.projectId, authorized: true }, origin);
  const taskFile = path.join(f.dataDir, 'context/projects', p.projectId, 'workers/worker-1/TASK.md'), receiptFile = path.join(path.dirname(taskFile), 'project-workspace.json');
  const beforeTask = await fs.readFile(taskFile), beforeReceipt = await fs.readFile(receiptFile);
  const entered = defer(), release = defer(); t.after(() => release.resolve()); const open = fs.open; let intercepted = false, timer;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (!intercepted && args[0] === taskFile) {
      intercepted = true; const read = handle.readFile.bind(handle);
      handle.readFile = async (...readArgs) => { const bytes = await read(...readArgs); entered.resolve(); await release.promise; return bytes; };
    }
    return handle;
  }); syncBuiltinESMExports();
  const assigning = f.service.assign({ task: 'opaque late task' }, p.context);
  try {
    await Promise.race([entered.promise, assigning.then(() => assert.fail('unexpected early assignment')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TASK barrier timeout')), 10000); })]);
    clearTimeout(timer); await f.service.goal('pause', { projectId: p.projectId }, origin); release.resolve();
    await assert.rejects(assigning, { code: 'MAIN_CONTROL_WORK_DENIED' });
  } finally { clearTimeout(timer); release.resolve(); await assigning.catch(() => {}); mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(await fs.readFile(taskFile), beforeTask); assert.deepEqual(await fs.readFile(receiptFile), beforeReceipt);
  const status = await f.service.status(p.projectId, origin); assert.equal(status.worker.assignment.state, 'assigned'); assert.equal(status.assignmentHistory.total, 1);
});

test('TASK commit already issued before Goal pause finishes its receipt rather than leaving preparing state', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.assign({ task: 'opaque prior task' }, p.context);
  await f.service.goal('start', { projectId: p.projectId, authorized: true }, origin);
  const receiptFile = path.join(f.dataDir, 'context/projects', p.projectId, 'workers/worker-1/project-workspace.json'), rename = fs.rename; let paused = false;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (!paused && to === receiptFile && JSON.parse(await fs.readFile(from)).state === 'preparing') {
      paused = true; await f.service.goal('pause', { projectId: p.projectId }, origin);
    }
    return rename(from, to);
  }); syncBuiltinESMExports();
  try { assert.equal((await f.service.assign({ task: 'opaque issued task' }, p.context)).assigned, true); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(paused, true); assert.equal(JSON.parse(await fs.readFile(receiptFile)).state, 'ready');
  assert.equal(await fs.readFile(path.join(path.dirname(receiptFile), 'TASK.md'), 'utf8'), 'opaque issued task\n');
  assert.equal((await f.service.status(p.projectId, origin)).assignmentHistory.total, 2);
});

for (const action of ['pause', 'stop']) test(`Goal ${action} denies a late asynchronous worker admission without starting a worker`, async t => {
  const admitted = defer(), release = defer(); t.after(() => release.resolve());
  const f = await fixture(t, { admissionGate: release, onAdmission: () => admitted.resolve(), checkLateAdmission: true }), p = await f.create();
  await f.service.assign({ task: 'opaque goal worker' }, p.context); await f.service.goal('start', { projectId: p.projectId, authorized: true }, origin);
  const starting = f.service.start({ projectId: p.projectId }, p.context); let timer;
  try {
    await Promise.race([admitted.promise, starting.then(() => assert.fail('unexpected early start')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('start barrier timeout')), 10000); })]);
    clearTimeout(timer); const stopped = await f.service.goal(action, { projectId: p.projectId }, origin);
    if (action === 'stop') assert.equal(stopped.workerStop.cleanupPending, true);
    else { assert.equal(stopped.state, 'paused'); assert.equal(f.calls.stops.length, 0); }
    release.resolve();
    await assert.rejects(starting, { code: 'MAIN_CONTROL_WORK_DENIED' });
  } finally { clearTimeout(timer); release.resolve(); await starting.catch(() => {}); }
  assert.equal(f.jobs.size, 0); assert.equal(f.calls.starts.length, 1);
  assert.equal((await f.service.status(p.projectId, origin)).worker.start.state, 'idle');
});

test('Goal stop reports unknown worker admission as unresolved rather than clean', async t => {
  const f = await fixture(t, { startError: true, knownRun: false }), p = await f.create();
  await f.service.assign({ task: 'opaque unknown admission' }, p.context);
  await f.service.goal('start', { projectId: p.projectId, authorized: true }, origin);
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'START_UNKNOWN' });
  const stopped = await f.service.goal('stop', { projectId: p.projectId }, origin);
  assert.equal(stopped.workerStop.state, 'requested'); assert.equal(stopped.workerStop.cleanupPending, true);
  assert.equal(f.calls.stops.length, 0); assert.equal(f.calls.starts.length, 1);
});

test('Goal completion reads the real Python Core for canonical, revoked and missing opaque facts, and rechecks pause', async t => {
  // Actual engine dispatcher, opaque software facts in a temporary App-data root.
  // python3.12 is only this test transport, never a production runtime fallback.
  const execute = promisify(execFile), engine = fileURLToPath(new URL('../engine/src', import.meta.url));
  const envelopes = [], entered = defer(), release = defer(); t.after(() => release.resolve()); let delayRead = false;
  const f = await fixture(t, { coreCall: async (binding, operation, args, dataDir) => {
    assert.equal(operation, 'fact_get');
    const request = { schemaVersion: 1, requestId: randomUUID(), operation, context: binding, arguments: args };
    const script = 'import sys,json; sys.path.insert(0,sys.argv[1]); from hana_math_engine.research import dispatch; print(json.dumps(dispatch(sys.argv[2],json.loads(sys.argv[3]))))';
    const { stdout } = await execute('python3.12', ['-B', '-c', script, engine, dataDir, JSON.stringify(request)], { timeout: 15000, maxBuffer: 2 << 20 });
    const envelope = JSON.parse(stdout); envelopes.push(envelope);
    if (!envelope.ok) throw Object.assign(new Error('opaque Core refusal'), { code: 'CORE_FIXTURE_REJECTED', coreError: envelope.error });
    if (delayRead) { entered.resolve(); await release.promise; }
    return envelope.result;
  } });
  const p = await f.create(), graph = path.join(f.dataDir, 'context/projects', p.projectId, 'shared/fact_graph'), accepted = 'a'.repeat(16), revoked = 'b'.repeat(16), missing = 'c'.repeat(16);
  await fs.mkdir(path.join(graph, 'facts'), { recursive: true }); await fs.mkdir(path.join(graph, '_revoked'), { recursive: true });
  for (const id of [accepted, revoked]) await fs.writeFile(path.join(graph, 'facts', `${id}.md`), `---\nfact_id: ${id}\npredecessors: []\n---\nOpaque stored software fixture, not a mathematical assertion.\n`);
  await fs.writeFile(path.join(graph, '_revoked', `${revoked}.md`), 'opaque revocation fixture');
  const goal = await f.service.goal('start', { projectId: p.projectId, authorized: true }, origin), identity = { projectId: p.projectId, goalId: goal.goalId, generation: goal.generation };
  for (const id of [missing, revoked]) {
    await assert.rejects(f.service.goal('complete', { ...identity, factIds: [id] }, p.context));
    assert.equal((await f.service.goal('status', { projectId: p.projectId }, origin)).state, 'active');
  }
  assert.deepEqual(envelopes.map(e => e.error.code), ['not_found', 'revoked']);
  delayRead = true; const completing = f.service.goal('complete', { ...identity, factIds: [accepted] }, p.context); let timer;
  try {
    await Promise.race([entered.promise, completing.then(() => assert.fail('unexpected early completion')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Core read barrier timeout')), 10000); })]);
    clearTimeout(timer); await f.service.goal('pause', { projectId: p.projectId }, origin); release.resolve();
    await assert.rejects(completing, { code: 'MAIN_CONTROL_STALE' });
  } finally { clearTimeout(timer); release.resolve(); await completing.catch(() => {}); }
  assert.equal(envelopes.at(-1).result.fact_id, accepted); assert.equal(f.calls.stops.length, 0);
  const paused = await f.service.goal('status', { projectId: p.projectId }, origin); assert.equal(paused.state, 'paused'); assert.equal(paused.completion, null);
  delayRead = false;
  const resumed = await f.service.goal('resume', { projectId: p.projectId }, origin);
  const complete = await f.service.goal('complete', { projectId: p.projectId, goalId: resumed.goalId, generation: resumed.generation, factIds: [accepted] }, p.context);
  assert.equal(complete.state, 'completed'); assert.deepEqual(complete.completion.factIds, [accepted]);
  assert.deepEqual(complete.completionSemantics, { decisionBy: 'bound-main', appCheck: 'canonical-fact-existence',
    targetCoverage: 'not-checked-by-app', operatorFinalize: { performedByThisAction: false, observedState: 'unknown' } });
});

test('worker policy is explicit, persisted completely, and forwarded with the genuine main context', async t => {
  const f = await fixture(t, { roundBoundaryStop: true });
  const input = { problem: '  opaque configured\r\n', operatorProfile: 'opaque operator\t', workerPolicy: {} };
  const p = await f.create(input), omitted = await f.create(), legacy = await f.create();
  assert.deepEqual(p.status.workerPolicy, RESEARCH_WORKER_POLICY_DEFAULTS); assert.equal(p.status.workerBridge, 'configured-research-rounds');
  assert.deepEqual(omitted.status.workerPolicy, RESEARCH_WORKER_POLICY_DEFAULTS); assert.equal(omitted.status.workerBridge, 'configured-research-rounds');
  await f.service.dispose(); await persistLegacy(f, legacy.projectId); await f.open();
  const legacyStatus = await f.service.status(legacy.projectId, origin);
  assert.equal(Object.hasOwn(legacyStatus, 'workerPolicy'), false); assert.equal(legacyStatus.workerBridge, 'bounded-three-mathematical-rounds');
  const base = path.join(f.dataDir, 'research/projects', p.projectId);
  const meta = JSON.parse(await fs.readFile(path.join(base, 'project.json')));
  assert.deepEqual(meta.workerPolicy, RESEARCH_WORKER_POLICY_DEFAULTS);
  const storedInput = JSON.parse(await fs.readFile(path.join(base, 'input.json'))); assert.equal(storedInput.problem, input.problem); assert.equal(storedInput.operatorProfile, input.operatorProfile);
  const cwd = path.join(f.dataDir, 'context/projects', p.projectId, 'main');
  assert.equal(await fs.readFile(path.join(cwd, 'PROBLEM.md'), 'utf8'), input.problem); assert.equal(await fs.readFile(path.join(cwd, 'OPERATOR.md'), 'utf8'), input.operatorProfile);
  const prompt = f.calls.sends[0].text;
  for (const text of ['maxRounds=0 (unlimited mathematical rounds)', 'roundTimeoutSeconds=14400 per mathematical round', 'roundDelaySeconds=5', 'maxConsecutiveFailures=5', 'no total run time cap', 'whole run, not each round', 'round boundary', 'force=true', 'danus assign -> math_assign']) assert.ok(prompt.includes(text), text);
  assert.doesNotMatch(prompt, /at most three mathematical rounds/);
  await assert.rejects(f.service.start({ projectId: p.projectId }, origin), { code: 'PROJECT_OWNER_DENIED' });
  await f.service.assign({ task: 'opaque task' }, p.context);
  await f.service.start({ projectId: p.projectId }, p.context);
  assert.equal(f.calls.starts[0].context, p.context); assert.deepEqual(f.calls.starts[0].input.workerPolicy, RESEARCH_WORKER_POLICY_DEFAULTS);
  assert.equal(Object.hasOwn(f.calls.starts[0].input, 'timeoutSeconds'), false);
  const requested = await f.service.stop({ projectId: p.projectId }, origin);
  assert.equal(requested.worker.status.state, 'running'); assert.deepEqual(f.calls.stops.at(-1).options, { force: false });
  const forced = await f.service.stop({ projectId: p.projectId, force: true }, origin);
  assert.equal(forced.worker.status.state, 'stopped'); assert.deepEqual(f.calls.stops.at(-1).options, { force: true });
  await f.service.start({ projectId: p.projectId, timeoutSeconds: 60 }, p.context);
  assert.equal(f.calls.starts.at(-1).input.timeoutSeconds, 60); assert.equal(f.calls.starts.at(-1).input.workerPolicy.roundTimeoutSeconds, 14400);
  await f.service.stop({ projectId: p.projectId, force: true }, origin);
  await f.service.assign({ task: 'opaque legacy task' }, legacy.context); await f.service.start({ projectId: legacy.projectId }, legacy.context);
  assert.equal(Object.hasOwn(f.calls.starts.at(-1).input, 'workerPolicy'), false); assert.equal(Object.hasOwn(f.calls.starts.at(-1).input, 'timeoutSeconds'), false);
  assert.equal((await f.service.stop({ projectId: legacy.projectId }, origin)).worker.status.state, 'stopped');
});

test('dispose forces the configured owned worker without forging a user force request or touching main', async t => {
  // Parameter/state fixture, not an acceptance test of actual runtime cleanup.
  const f = await fixture(t, { roundBoundaryStop: true }), p = await f.create({ problem: 'opaque disposal', workerPolicy: {} });
  await f.service.assign({ task: 'opaque task' }, p.context);
  const job = await f.service.start({ projectId: p.projectId }, p.context);
  const requested = await f.service.stop({ projectId: p.projectId }, origin);
  assert.equal(requested.worker.status.state, 'running'); assert.equal(requested.worker.stopForce, false);
  assert.deepEqual(f.calls.stops.at(-1).options, { force: false });
  const disposed = await f.service.dispose();
  assert.deepEqual(f.calls.stops.at(-1), { projectId: p.projectId, runId: job.runId, options: { force: true } });
  assert.equal(f.jobs.get(job.runId).state, 'stopped'); assert.equal(disposed.mainSessionsAborted, false);
  const meta = JSON.parse(await fs.readFile(path.join(f.dataDir, 'research/projects', p.projectId, 'project.json')));
  assert.equal(meta.worker.stopForce, false); assert.equal(meta.worker.stopRequested, true);
  assert.equal(meta.main.sessionId, p.status.main.sessionId); assert.equal(f.calls.sessions.length, 1);
  // The fixture's sessions.abort/delete methods assert.fail if disposal touches main.
});

for (const outcome of ['success', 'run-rejection', 'pre-admission-rejection']) test(`dispose forces late ${outcome} compensation without replay or a fake user stop request`, async t => {
  // Event-gated bridge parameter/state fixture; no actual runtime cleanup claim.
  const admitted = defer(), gate = defer(); t.after(() => gate.resolve());
  const behavior = { roundBoundaryStop: true }, f = await fixture(t, behavior);
  const p = await f.create({ problem: 'opaque late disposal', workerPolicy: {} });
  await f.service.assign({ task: 'opaque task' }, p.context);
  let expectedRunId = 'run-1';
  if (outcome === 'pre-admission-rejection') {
    const prior = await f.service.start({ projectId: p.projectId }, p.context); expectedRunId = prior.runId;
    f.jobs.get(prior.runId).state = 'finished'; f.jobs.get(prior.runId).coordinatorActive = false;
    behavior.admissionGate = gate; behavior.admissionError = 'WORKER_BUSY';
  } else {
    behavior.startGate = gate;
    if (outcome === 'run-rejection') { behavior.startError = true; behavior.knownRun = true; }
  }
  behavior.onAdmission = () => admitted.resolve();
  const starting = f.service.start({ projectId: p.projectId }, p.context);
  let timer, disposal;
  try {
    await Promise.race([admitted.promise, starting.then(() => assert.fail('unexpected early admission completion')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('admission fixture timeout')), 10000); })]);
    clearTimeout(timer);
    disposal = f.service.dispose(); // Sets disposed synchronously, before releasing the admitted bridge call.
    gate.resolve();
    if (outcome === 'success') assert.equal((await starting).state, 'stopped');
    else await assert.rejects(starting, { code: outcome === 'run-rejection' ? 'START_UNKNOWN' : 'WORKER_BUSY' });
    assert.equal((await disposal).mainSessionsAborted, false);
    assert.ok(f.calls.stops.length > 0);
    for (const stop of f.calls.stops) assert.deepEqual(stop, { projectId: p.projectId, runId: expectedRunId, options: { force: true } });
    assert.equal(f.jobs.get(expectedRunId).state, 'stopped'); assert.equal(f.jobs.size, 1);
    const starts = outcome === 'pre-admission-rejection' ? 2 : 1;
    assert.equal(f.calls.starts.length, starts);
    await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'PROJECT_DISPOSED' });
    assert.equal(f.calls.starts.length, starts);
    const meta = JSON.parse(await fs.readFile(path.join(f.dataDir, 'research/projects', p.projectId, 'project.json')));
    assert.equal(meta.worker.lastRun, expectedRunId); assert.equal(meta.worker.stopForce, false); assert.equal(meta.worker.stopRequested, false);
    assert.equal(meta.main.sessionId, p.status.main.sessionId); assert.equal(f.calls.sessions.length, 1);
  } finally {
    clearTimeout(timer); gate.resolve(); await starting.catch(() => {}); if (disposal) await disposal;
  }
});

test('partial explicit policy normalizes but neither start nor invalid stop can override policy', async t => {
  const f = await fixture(t), p = await f.create({ problem: 'opaque finite policy', workerPolicy: { maxRounds: 7, roundTimeoutSeconds: 120, roundDelaySeconds: 0.5, maxConsecutiveFailures: 0 } });
  assert.deepEqual(p.status.workerPolicy, { maxRounds: 7, roundTimeoutSeconds: 120, roundDelaySeconds: 0.5, maxConsecutiveFailures: 0 });
  assert.match(f.calls.sends[0].text, /maxRounds=7/); assert.match(f.calls.sends[0].text, /failure cutoff disabled/);
  await assert.rejects(f.service.start({ projectId: p.projectId, workerPolicy: {} }, p.context), { code: 'PROJECT_INVALID_INPUT' });
  for (const force of [null, 'true', 1, undefined]) await assert.rejects(f.service.stop({ projectId: p.projectId, force }, origin), { code: 'PROJECT_INVALID_INPUT' });
  const partial = await f.create({ problem: 'opaque partial policy', workerPolicy: { maxRounds: 2 } });
  assert.deepEqual(partial.status.workerPolicy, { ...RESEARCH_WORKER_POLICY_DEFAULTS, maxRounds: 2 });
});

test('invalid explicit worker policy fails before any main or setup task is created', async t => {
  const f = await fixture(t);
  for (const workerPolicy of [undefined, null, [], true, { maxRounds: -1 }, { maxRounds: 1.5 }, { maxRounds: Number.MAX_SAFE_INTEGER + 1 },
    { roundTimeoutSeconds: 0 }, { roundTimeoutSeconds: 14400.5 }, { roundDelaySeconds: -1 }, { roundDelaySeconds: Infinity },
    { roundTimeoutSeconds: MAX_TIMER_SECONDS + 1 }, { maxConsecutiveFailures: -1 }, { unknown: 1 }]) {
    await assert.rejects(f.service.create({ problem: 'opaque invalid policy', workerPolicy }, origin), error => error.code.startsWith('WORKER_POLICY_'));
  }
  assert.equal(f.calls.tasks.length, 0); assert.equal(f.calls.sessions.length, 0); assert.equal(f.calls.sends.length, 0);
});

test('policy recovery preserves legacy bytes and locally rejects incomplete or invalid opt-in records', async t => {
  const f = await fixture(t), legacy = await f.create(), configured = await f.create({ problem: 'opaque configured restore', workerPolicy: {} }); await f.service.dispose();
  await persistLegacy(f, legacy.projectId);
  const file = id => path.join(f.dataDir, 'research/projects', id, 'project.json');
  const legacyBytes = await fs.readFile(file(legacy.projectId)), goodBytes = await fs.readFile(file(configured.projectId));
  await f.open(); assert.equal(Object.hasOwn(await f.service.status(legacy.projectId, origin), 'workerPolicy'), false);
  assert.deepEqual((await f.service.status(configured.projectId, origin)).workerPolicy, RESEARCH_WORKER_POLICY_DEFAULTS);
  assert.deepEqual(await fs.readFile(file(legacy.projectId)), legacyBytes); assert.deepEqual(await fs.readFile(file(configured.projectId)), goodBytes); await f.service.dispose();
  for (const workerPolicy of [{}, null, { ...RESEARCH_WORKER_POLICY_DEFAULTS, maxRounds: -1 }, { ...RESEARCH_WORKER_POLICY_DEFAULTS, extra: 'SENTINEL' }]) {
    const meta = JSON.parse(goodBytes); meta.workerPolicy = workerPolicy; await fs.writeFile(file(configured.projectId), JSON.stringify(meta)); const before = await fs.readFile(file(configured.projectId));
    await f.open(); await assert.rejects(f.service.status(configured.projectId, origin), { code: 'PROJECT_RECORD_INVALID' });
    assert.equal((await f.service.status(legacy.projectId, origin)).state, 'ready');
    assert.deepEqual(await fs.readFile(file(configured.projectId)), before); assert.deepEqual(await fs.readFile(file(legacy.projectId)), legacyBytes);
    await f.service.dispose();
  }
});

test('force stop requested during policy admission is carried to the late confirmed run', async t => {
  const admitted = defer(), gate = defer(); t.after(() => gate.resolve());
  const f = await fixture(t, { startGate: gate, onAdmission: () => admitted.resolve(), roundBoundaryStop: true });
  const p = await f.create({ problem: 'opaque late admission', workerPolicy: {} }); await f.service.assign({ task: 'opaque' }, p.context);
  const starting = f.service.start({ projectId: p.projectId }, p.context); let timer;
  try {
    await Promise.race([admitted.promise, starting.then(() => assert.fail('unexpected early completion')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('admission fixture timeout')), 10000); })]);
    clearTimeout(timer); await f.service.stop({ projectId: p.projectId, force: true }, origin);
    gate.resolve(); assert.equal((await starting).state, 'stopped'); assert.deepEqual(f.calls.stops.at(-1).options, { force: true });
  } finally { clearTimeout(timer); gate.resolve(); await starting.catch(() => {}); }
});

test('restored assignment metadata projects only known fields and rejects corrupt append locally', async t => {
  const f = await fixture(t), p = await f.create(), healthy = await f.create();
  await f.service.assign({ task: 'opaque existing assignment' }, p.context); await f.service.dispose();
  const file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), base = JSON.parse(await fs.readFile(file));
  const extra = structuredClone(base); extra.assignmentHistory.privateText = 'SENTINEL_PRIVATE'; extra.assignmentHistory.assignments[0].task = 'SENTINEL_PRIVATE';
  extra.worker.status = { submissionDiagnostics: { privateText: 'SENTINEL_PRIVATE' } }; // Stale cached run metadata must also be projected.
  await fs.writeFile(file, JSON.stringify(extra)); const before = await fs.readFile(file); await f.open();
  const clean = await f.service.status(p.projectId, origin);
  assert.equal(clean.assignmentHistory.available, true); assert.equal(clean.assignmentHistory.total, 1);
  assert.doesNotMatch(JSON.stringify(clean), /SENTINEL_PRIVATE/); assert.equal(clean.worker.status.submissionDiagnostics.history, 'invalid');
  assert.deepEqual(await fs.readFile(file), before); await f.service.dispose();
  const variants = [h => { h.total = -1; }, h => { h.omitted = 1; }, h => { h.assignments = 'SENTINEL_PRIVATE'; },
    h => { h.assignments[0].sha256 = 'SENTINEL_PRIVATE'; }, h => { h.assignments[0].at = 'SENTINEL_PRIVATE'; },
    h => { h.assignments[0].lastRun = 'SENTINEL private text'; },
    h => { h.assignments = Array(129).fill(h.assignments[0]); h.total = 129; }, h => { h.coverage = 'SENTINEL_PRIVATE'; }];
  for (const mutate of variants) {
    const meta = structuredClone(base); mutate(meta.assignmentHistory); await fs.writeFile(file, JSON.stringify(meta)); const bytes = await fs.readFile(file); await f.open();
    const status = await f.service.status(p.projectId, origin);
    assert.equal(status.assignmentHistory.available, false); assert.equal(status.assignmentHistory.history, 'invalid');
    assert.equal(status.assignmentHistory.recordingComplete, false); assert.equal(Object.hasOwn(status.assignmentHistory, 'total'), false);
    assert.doesNotMatch(JSON.stringify(status.assignmentHistory), /SENTINEL/);
    await assert.rejects(f.service.assign({ task: 'opaque rejected append' }, p.context), { code: 'PROJECT_ASSIGNMENT_HISTORY_INVALID' });
    assert.deepEqual(await fs.readFile(file), bytes);
    await f.service.assign({ task: 'opaque independent assignment' }, healthy.context);
    assert.equal((await f.service.status(healthy.projectId, origin)).assignmentHistory.available, true);
    await f.service.dispose();
  }
});

test('assignment history records only confirmed assignment metadata, including reassignment during a job', async t => {
  const f = await fixture(t), p = await f.create();
  assert.equal(p.status.assignmentHistory.available, true); assert.equal(p.status.assignmentHistory.total, 0);
  const first = await f.service.assign({ task: 'SENTINEL_TASK_A' }, p.context);
  const job = await f.service.start({ projectId: p.projectId }, p.context);
  const second = await f.service.assign({ task: 'SENTINEL_TASK_B' }, p.context);
  let history = (await f.service.status(p.projectId, origin)).assignmentHistory;
  assert.equal(history.total, 2); assert.equal(history.omitted, 0); assert.equal(history.coverage, 'complete');
  assert.deepEqual(history.assignments.map(a => a.sha256), [first.sha256, second.sha256]); assert.notEqual(first.sha256, second.sha256);
  assert.deepEqual(history.assignments.map(a => a.lastRun), [null, job.runId]);
  for (const a of history.assignments) { assert.deepEqual(Object.keys(a).sort(), ['at', 'lastRun', 'sha256']); assert.ok(Number.isSafeInteger(a.at)); }
  assert.doesNotMatch(JSON.stringify(history), /SENTINEL_TASK/);
  f.jobs.get(job.runId).state = 'finished'; f.jobs.get(job.runId).coordinatorActive = false;
  await f.service.start({ projectId: p.projectId }, p.context);
  assert.equal((await f.service.status(p.projectId, origin)).assignmentHistory.total, 2);
  await assert.rejects(f.service.assign({ task: '' }, p.context));
  f.contexts.assignWorkerTask = async () => ({ state: 'unconfirmed' });
  await assert.rejects(f.service.assign({ task: 'SENTINEL_TASK_C' }, p.context), { code: 'PROJECT_ASSIGNMENT_UNCONFIRMED' });
  history = (await f.service.status(p.projectId, origin)).assignmentHistory; assert.equal(history.total, 2);
});

test('assignment history truncates explicitly without imposing an assignment quota', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.dispose();
  const file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json');
  const meta = JSON.parse(await fs.readFile(file));
  // Seed only the historical receipts; exercise every boundary step with a real fixture assignment.
  const seeded = Array.from({ length: 127 }, (_, i) => ({ sha256: (i + 1).toString(16).padStart(64, '0'), at: i + 1, lastRun: null }));
  meta.assignmentHistory = { available: true, coverage: 'complete', total: 127, omitted: 0, assignments: seeded };
  await fs.writeFile(file, JSON.stringify(meta)); await f.open();

  const readHistory = async (total, omitted, length) => {
    const h = (await f.service.status(p.projectId, origin)).assignmentHistory;
    assert.equal(h.available, true); assert.equal(h.coverage, 'complete'); assert.equal(h.recordingComplete, true);
    assert.equal(h.total, total); assert.equal(h.omitted, omitted); assert.equal(h.assignments.length, length);
    return h.assignments;
  };
  assert.deepEqual(await readHistory(127, 0, 127), seeded);
  const seedHashes = seeded.map(a => a.sha256);

  const task = 'opaque repeated assignment';
  const first = await f.service.assign({ task }, p.context);
  assert.equal(first.assigned, true);
  assert.deepEqual((await readHistory(128, 0, 128)).map(a => a.sha256), [...seedHashes, first.sha256]);

  const second = await f.service.assign({ task }, p.context);
  assert.equal(second.assigned, true); assert.equal(second.sha256, first.sha256);
  assert.deepEqual((await readHistory(129, 1, 128)).map(a => a.sha256), [...seedHashes.slice(1), first.sha256, second.sha256]);

  const third = await f.service.assign({ task: 'opaque latest assignment' }, p.context);
  assert.equal(third.assigned, true); assert.notEqual(third.sha256, second.sha256);
  assert.deepEqual((await readHistory(130, 2, 128)).map(a => a.sha256), [...seedHashes.slice(2), first.sha256, second.sha256, third.sha256]);
});

test('old project assignment history remains unknown until explicit since-instrumentation assignments', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.assign({ task: 'opaque historical task' }, p.context); await f.service.dispose();
  const file = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json');
  const meta = JSON.parse(await fs.readFile(file)); delete meta.assignmentHistory; await fs.writeFile(file, JSON.stringify(meta)); await f.open();
  const old = (await f.service.status(p.projectId, origin)).assignmentHistory;
  assert.equal(old.available, false); assert.equal(old.coverage, 'unknown'); assert.equal(Object.hasOwn(old, 'total'), false);
  await f.service.assign({ task: 'opaque new task' }, p.context);
  const current = (await f.service.status(p.projectId, origin)).assignmentHistory;
  assert.equal(current.coverage, 'since-instrumentation'); assert.equal(current.total, 1);
});

test('failed assignment metadata persistence neither appends a confirmed assignment nor claims completeness', async t => {
  const f = await fixture(t), p = await f.create();
  const destination = path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), rename = fs.rename;
  let injected = false;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === destination && !injected) {
      const packet = JSON.parse(await fs.readFile(from));
      if (packet.worker.assignment.state === 'assigned') { injected = true; throw Object.assign(new Error('opaque persistence error'), { code: 'EIO' }); }
    }
    return rename(from, to);
  }); syncBuiltinESMExports();
  try { await assert.rejects(f.service.assign({ task: 'opaque failed metadata' }, p.context), { code: 'EIO' }); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  const status = await f.service.status(p.projectId, origin);
  assert.equal(injected, true); assert.equal(status.persistenceFailed, true); assert.equal(status.worker.assignment.state, 'unknown');
  assert.equal(status.assignmentHistory.total, 0); assert.equal(status.assignmentHistory.recordingComplete, false);
});

test('fixture cleanup drains an in-flight context write after the setup deadline', { timeout: 15000 }, async t => {
  const entered = defer(), resume = defer(), disposed = defer();
  const mkdir = fs.mkdir, rm = fs.rm;
  let dataDir, preparing, deleting = false;
  t.mock.method(fs, 'mkdir', async (dir, ...args) => {
    if (dataDir && String(dir).startsWith(path.join(dataDir, 'context/projects') + path.sep)) {
      entered.resolve(); await resume.promise;
    }
    return mkdir(dir, ...args);
  });
  t.mock.method(fs, 'rm', (dir, ...args) => {
    if (dir === dataDir) deleting = true;
    return rm(dir, ...args);
  });
  syncBuiltinESMExports();
  const child = t.test('synthetic setup times out while preparing its own directory', async st => {
    const f = await fixture(st, { disposeHandler(key) { if (key === 'math-project-setup') disposed.resolve(); } });
    dataDir = f.dataDir;
    const prepare = f.contexts.prepare;
    f.contexts.prepare = (...args) => (preparing = prepare(...args));
    st.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const created = f.create();
      await Promise.race([entered.promise, created.then(() => assert.fail('setup returned before entering context preparation'))]);
      st.mock.timers.tick(10001);
      const p = await created;
      assert.equal(p.status.error, 'PROJECT_CONTROL_TIMEOUT'); assert.equal(p.context, null);
    } finally { st.mock.timers.reset(); }
  });
  let premature;
  try {
    await Promise.race([disposed.promise, child]);
    await admissionsTurn();
    premature = deleting;
  } finally {
    resume.resolve();
    await Promise.allSettled([child, preparing]);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
  assert.equal(premature, false, 'fixture removed its directory while context preparation was still writing');
  assert.equal(deleting, true);
});

const setupHandler = f => f.handlers.get('math-project-setup');
const setupFile = (f, q) => path.join(f.dataDir, 'research/projects', q.projectId, 'project.json');
const setupRecord = (f, q) => fs.readFile(setupFile(f, q));
function gateSetupSave(t, f, q, match) {
  const entered = defer(), resume = defer(), rename = fs.rename;
  let gated = false;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (to !== setupFile(f, q) || gated || !match(JSON.parse(await fs.readFile(from)))) return rename(from, to);
    gated = true; await rename(from, to); entered.resolve(); await resume.promise;
  });
  syncBuiltinESMExports();
  return { entered: entered.promise, resume: resume.resolve, restore() { mock.mock.restore(); syncBuiltinESMExports(); } };
}
const queueSetup = f => f.service.create({ problem: 'Opaque setup abort fixture.' }, origin);
function dispatchSetup(f, q) {
  const schedule = [...f.schedules.values()].find(row => row.payload.projectId === q.projectId);
  return setupHandler(f).run({ kind: 'schedule', scheduleId: schedule.scheduleId, input: schedule.payload });
}
function observeSetupSettlementAfterAbort(f, q) {
  const reached = defer(), get = f.sdk.tasks.get;
  let reads = 0;
  f.sdk.tasks.get = (...args) => {
    if (args[0] === q.taskId && ++reads === 2) reached.resolve(); // Abort reads first; settlement reads second.
    return get(...args);
  };
  return reached.promise;
}
async function ignoreSetupAbort(f, q, handler = setupHandler(f)) {
  const before = await setupRecord(f, q), task = structuredClone(f.tasks.get(q.taskId));
  const result = await handler.abort(q.taskId);
  assert.deepEqual(await setupRecord(f, q), before, 'ignored abort rewrote project bytes or revision');
  assert.deepEqual(f.tasks.get(q.taskId), task, 'ignored abort changed Host task');
  assert.deepEqual(result, { status: 'ignored' });
}

test('Project setup abort ignores archived ready and queued records, even with a live-looking Host task', async t => {
  const f = await fixture(t), { queued: q } = await f.create(), pending = await queueSetup(f);
  const pendingBytes = await setupRecord(f, pending);
  const handler = setupHandler(f);
  await f.service.dispose();
  // Model a prior process that expired before clearing its queued record. Keep
  // the real ready history and its settled data as a separate negative control.
  await fs.writeFile(setupFile(f, pending), pendingBytes);
  f.tasks.get(pending.taskId).status = 'pending';
  await f.open();
  const current = await queueSetup(f), before = await fileSnapshot(f.dataDir), currentTask = structuredClone(f.tasks.get(current.taskId));
  await ignoreSetupAbort(f, q);
  await ignoreSetupAbort(f, pending);
  await ignoreSetupAbort(f, q, handler);
  assert.deepEqual(await setupHandler(f).abort('unknown-task'), { status: 'ignored' });
  assert.deepEqual(await fileSnapshot(f.dataDir), before);
  assert.deepEqual(f.tasks.get(current.taskId), currentTask);
  assert.deepEqual(f.calls.starts, []); assert.deepEqual(f.calls.core, []);
});

test('Project setup abort cancels one live queued setup and ignores duplicate and stale schedule delivery', async t => {
  const f = await fixture(t), q = await queueSetup(f), before = JSON.parse(await setupRecord(f, q));
  const results = await Promise.all([setupHandler(f).abort(q.taskId), setupHandler(f).abort(q.taskId)]);
  assert.equal(results.filter(row => row.status === 'stopping-setup-only').length, 1);
  assert.equal(results.filter(row => row.status === 'ignored').length, 1);
  const after = JSON.parse(await setupRecord(f, q));
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.state, 'unconfirmed'); assert.equal(after.error, 'PROJECT_SETUP_CANCELLED');
  await ignoreSetupAbort(f, q);
  assert.deepEqual(await dispatchSetup(f, q), { status: 'ignored' });
  assert.deepEqual(f.calls.sessions, []); assert.deepEqual(f.calls.sends, []);
});

test('Project setup abort cancels a still-preparing setup without starting main or double-writing on repeated abort', async t => {
  const f = await fixture(t), q = await queueSetup(f);
  const entered = defer(), resume = defer(), finished = defer(), prepare = f.contexts.prepare;
  f.completions.set(q.projectId, finished);
  f.contexts.prepare = async (...args) => { entered.resolve(); await resume.promise; return prepare(...args); };
  assert.equal((await dispatchSetup(f, q)).status, 'started');
  try {
    await entered.promise;
    const before = JSON.parse(await setupRecord(f, q)); assert.equal(before.state, 'preparing');
    assert.deepEqual(await setupHandler(f).abort(q.taskId), { status: 'stopping-setup-only' });
    assert.equal(JSON.parse(await setupRecord(f, q)).revision, before.revision + 1);
    await ignoreSetupAbort(f, q);
  } finally { resume.resolve(); await finished.promise; await f.service.dispose(); }
  const after = JSON.parse(await setupRecord(f, q));
  assert.equal(after.state, 'unconfirmed'); assert.equal(after.error, 'PROJECT_SETUP_CANCELLED');
  assert.equal(after.taskSettlement, 'confirmed');
  assert.deepEqual(f.calls.sessions, []); assert.deepEqual(f.calls.sends, []);
});

test('Project setup abort ignores completed and failed Host tasks while the local record is still preparing', async t => {
  const f = await fixture(t), q = await queueSetup(f);
  const entered = defer(), resume = defer(), finished = defer(), prepare = f.contexts.prepare;
  f.completions.set(q.projectId, finished);
  f.contexts.prepare = async (...args) => { entered.resolve(); await resume.promise; return prepare(...args); };
  assert.equal((await dispatchSetup(f, q)).status, 'started');
  try {
    await entered.promise;
    assert.equal(JSON.parse(await setupRecord(f, q)).state, 'preparing');
    for (const status of ['completed', 'failed']) {
      f.tasks.get(q.taskId).status = status;
      await ignoreSetupAbort(f, q);
    }
  } finally { f.tasks.get(q.taskId).status = 'pending'; resume.resolve(); await finished.promise; }
});

for (const status of ['canceled', 'aborted']) test(`Project setup abort honors Host-first ${status} before contexts.prepare`, { timeout: 5000 }, async t => {
  const f = await fixture(t), q = await queueSetup(f);
  const gate = gateSetupSave(t, f, q, meta => meta.state === 'preparing');
  const prepare = f.contexts.prepare;
  let prepares = 0;
  f.contexts.prepare = (...args) => { prepares++; return prepare(...args); };
  try {
    assert.equal((await dispatchSetup(f, q)).status, 'started');
    await gate.entered;
    f.tasks.get(q.taskId).status = status;
    const settling = observeSetupSettlementAfterAbort(f, q);
    const abort = setupHandler(f).abort(q.taskId);
    // Cancel and its write queue must be able to advance after releasing the save.
    gate.resume();
    assert.deepEqual(await abort, { status: 'stopping-setup-only' });
    await settling;
  } finally { gate.resume(); try { await f.service.dispose(); } finally { gate.restore(); } }
  const meta = JSON.parse(await setupRecord(f, q));
  assert.equal(prepares, 0); assert.deepEqual(f.calls.sessions, []); assert.deepEqual(f.calls.sends, []);
  assert.equal(meta.state, 'unconfirmed'); assert.equal(meta.error, 'PROJECT_SETUP_CANCELLED');
  assert.equal(f.tasks.get(q.taskId).status, status);
});

test('Project setup abort blocks new session mutations after an in-flight main readback', { timeout: 5000 }, async t => {
  const f = await fixture(t), q = await queueSetup(f);
  const reading = defer(), reply = defer(), context = f.sdk.sessions.context, select = f.sdk.sessions.setActiveTools;
  let selections = 0;
  f.sdk.sessions.context = async (...args) => { reading.resolve(); await reply.promise; return context(...args); };
  f.sdk.sessions.setActiveTools = (...args) => { selections++; return select(...args); };
  try {
    assert.equal((await dispatchSetup(f, q)).status, 'started');
    await reading.promise;
    assert.equal(f.calls.sessions.length, 1);
    f.tasks.get(q.taskId).status = 'aborted';
    const settling = observeSetupSettlementAfterAbort(f, q);
    assert.deepEqual(await setupHandler(f).abort(q.taskId), { status: 'stopping-setup-only' });
    reply.resolve(); await settling;
    assert.equal(selections, 0);
  } finally { reply.resolve(); await f.service.dispose(); }
  const meta = JSON.parse(await setupRecord(f, q));
  assert.equal(meta.main.sessionId, 'main-1'); assert.equal(meta.error, 'PROJECT_SETUP_CANCELLED');
  assert.deepEqual(f.calls.sends, []);
});

test('Project setup abort fences startup dispatch while a Host receipt is pending on a ready project', { timeout: 5000 }, async t => {
  const f = await fixture(t), q = await queueSetup(f);
  const gate = gateSetupSave(t, f, q, meta => meta.state === 'ready' && meta.startup.state === 'pending');
  const requested = defer(), reply = defer(), get = f.sdk.tasks.get;
  try {
    assert.equal((await dispatchSetup(f, q)).status, 'started');
    await gate.entered;
    assert.equal(f.calls.sessions.length, 1);
    f.tasks.get(q.taskId).status = 'aborted';
    f.sdk.tasks.get = async (...args) => { requested.resolve(); await reply.promise; return get(...args); };
    const abort = setupHandler(f).abort(q.taskId);
    assert.equal(await Promise.race([requested.promise.then(() => 'requested'), abort.then(() => 'finished')]), 'requested');
    gate.resume(); await admissionsTurn();
    assert.deepEqual(f.calls.sends, [], 'startup must not pass an in-flight abort check');
    reply.resolve();
    assert.deepEqual(await abort, { status: 'stopping-setup-only' });
  } finally { reply.resolve(); gate.resume(); try { await f.service.dispose(); } finally { gate.restore(); } }
  const meta = JSON.parse(await setupRecord(f, q));
  assert.equal(meta.state, 'ready'); assert.equal(meta.startup.state, 'not-sent');
  assert.equal(meta.error, 'PROJECT_SETUP_CANCELLED'); assert.equal(f.tasks.get(q.taskId).status, 'aborted');
  assert.deepEqual(f.calls.sends, []);
});

test('Project setup abort does not rewrite ready history after startup dispatch or during settlement', async t => {
  const f = await fixture(t), q = await queueSetup(f);
  const sending = defer(), sent = defer(), settling = defer(), settled = defer(), finished = defer();
  const send = f.sdk.sessions.send, complete = f.sdk.tasks.complete;
  f.completions.set(q.projectId, finished);
  f.sdk.sessions.send = async (...args) => { sending.resolve(); await sent.promise; return send(...args); };
  f.sdk.tasks.complete = async (...args) => { settling.resolve(); await settled.promise; return complete(...args); };
  assert.equal((await dispatchSetup(f, q)).status, 'started');
  try {
    await sending.promise;
    assert.equal(JSON.parse(await setupRecord(f, q)).state, 'ready');
    await ignoreSetupAbort(f, q);
    sent.resolve(); await settling.promise;
    assert.equal(JSON.parse(await setupRecord(f, q)).startup.state, 'accepted');
    await ignoreSetupAbort(f, q);
  } finally { sent.resolve(); settled.resolve(); await finished.promise; await f.service.dispose(); }
  const meta = JSON.parse(await setupRecord(f, q));
  assert.equal(meta.error, null); assert.equal(meta.taskSettlement, 'confirmed');
  assert.equal(f.calls.sends.length, 1); assert.equal(f.tasks.get(q.taskId).status, 'completed');
});

test('Project setup abort stops trusting a pending task read when disposal starts', async t => {
  const f = await fixture(t), q = await queueSetup(f), handler = setupHandler(f);
  const requested = defer(), reply = defer(), get = f.sdk.tasks.get;
  f.sdk.tasks.get = async (...args) => {
    const pending = await get(...args);
    if (args[0] === q.taskId) { requested.resolve(); await reply.promise; }
    return pending;
  };
  const before = await setupRecord(f, q);
  const abort = handler.abort(q.taskId);
  try {
    // The abort must be waiting on a Host receipt, not already writing.
    assert.equal(await Promise.race([requested.promise.then(() => 'requested'), abort.then(() => 'finished')]), 'requested');
    assert.deepEqual(await setupRecord(f, q), before);
    const disposing = f.service.dispose();
    reply.resolve();
    assert.deepEqual(await abort, { status: 'ignored' });
    await disposing;
    await ignoreSetupAbort(f, q, handler);
    assert.notEqual(JSON.parse(await setupRecord(f, q)).error, 'PROJECT_SETUP_CANCELLED');
  } finally { reply.resolve(); await abort.catch(() => {}); }
});

test('default helper confirms configured model through context despite empty disk model projections', async t => {
  const f = await fixture(t), p = await f.create(), sessionId = p.status.main.sessionId;
  assert.equal(p.status.state, 'ready'); assert.equal(p.status.startup.state, 'accepted');
  assert.deepEqual(f.calls.contexts, [{ sessionId }]); assert.equal(f.calls.sends.length, 1);
  assert.equal(p.status.main.modelReadback.source, 'sessions.context');
  assert.equal(p.status.main.modelReadback.configurationConfirmed, true);
  assert.deepEqual(p.status.main.modelReadback.model, { id: 'fixture-model', provider: 'fixture-provider' });
  const get = (await f.sdk.sessions.get({ sessionId })).session;
  const list = (await f.sdk.sessions.list({ scope: 'own', lifecycle: 'all', ownerPluginId: APP })).sessions.find(row => row.sessionId === sessionId);
  for (const row of [get, list]) { assert.equal(row.modelId, null); assert.equal(Object.hasOwn(row, 'modelProvider'), false); }
  for (const side of ['get', 'list']) {
    assert.equal(p.status.main.modelProjection[side].modelId.state, 'null');
    assert.equal(p.status.main.modelProjection[side].modelProvider.state, 'missing');
  }
  for (const id of ['unknown-session', 'creator-stable']) await assert.rejects(f.sdk.sessions.context({ sessionId: id }), { code: 'SESSION_ACCESS_DENIED' });
});

test('context readback failure keeps setup failed with readable code and no startup send', async t => {
  const f = await fixture(t, { contextError: true }), p = await f.create();
  assert.equal(p.status.state, 'unconfirmed'); assert.equal(p.status.main.state, 'unconfirmed');
  assert.equal(p.status.main.failurePhase, 'model-readback'); assert.equal(p.status.main.modelReadback.state, 'failed');
  assert.equal(p.status.error, 'HOST_CONTEXT_FAILED'); assert.equal(p.status.startup.state, 'not-sent');
  assert.equal(f.calls.contexts.length, 1); assert.equal(f.calls.sends.length, 0);
  assert.equal(f.tasks.get(p.queued.taskId).error, 'Project setup failed: HOST_CONTEXT_FAILED.');
});

for (const missingNative of ['read', 'web_search', 'web_fetch', 'subagent', 'subagent_reply', 'subagent_message', 'subagent_close']) test(`missing target ${missingNative} ${['subagent', 'subagent_reply', 'subagent_message', 'subagent_close'].includes(missingNative) ? 'falls back to worker/verifier lane' : 'retains one unsent main'}`, async t => {
  const f = await fixture(t, { missingNative }), p = await f.create();
  assert.equal(f.calls.sessions.length, 1);
  if (['subagent', 'subagent_reply', 'subagent_message', 'subagent_close'].includes(missingNative)) {
    assert.equal(p.status.state, 'ready'); assert.equal(p.status.startup.state, 'accepted');
    assert.deepEqual(p.status.main.toolSelection.exploration, { state: 'unavailable', errorCode: 'APP_HOST_ERROR' });
    assert.equal(f.calls.sends.length, 1); assert.match(f.calls.sends[0].text, /Native exploratory subagents are unavailable/);
    assert.doesNotMatch(f.calls.sends[0].text, /Exploratory subagents are for speculative/);
    assert.match(f.calls.sends[0].text, /worker then verifier/);
  } else {
    assert.equal(p.status.state, 'unconfirmed'); assert.equal(p.status.main.state, 'unconfirmed'); assert.equal(p.status.main.createState, 'confirmed');
    assert.equal(p.status.main.failurePhase, 'tool-selection'); assert.equal(p.status.error, 'APP_HOST_ERROR'); assert.equal(p.status.startup.state, 'not-sent');
    assert.equal(p.status.main.sessionId, 'main-1'); assert.equal(f.calls.sends.length, 0); assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.core.length, 0);
    assert.equal(f.tasks.get(p.queued.taskId).status, 'failed'); assert.equal(p.status.scheduleCleanup.state, 'confirmed');
  }
});

test('startup adapter names actual tools and bounded capabilities without adding per-job approval', async t => {
  const f = await fixture(t), p = await f.create();
  assert.equal(f.calls.sends.length, 1);
  const message = f.calls.sends[0].text;
  for (const fragment of ['Matlas theorem index', 'web_search', 'web_fetch', 'startChar/maxLength', 'isError=false', 'precise theorem, hypotheses', 'No executable mathematics', 'separate Host authorization']) assert.ok(message.includes(fragment), fragment);
  for (const fragment of ['Read PROBLEM.md, OPERATOR.md, PATHS.json and CONTEXT.md', 'not CLI execution',
    'danus assign -> math_assign', 'danus start/status/stop -> math_project with the corresponding action',
    'full canonical fact reads -> math_project result', 'gm_add, gm_search, fact_search, fact_revoke and search_arxiv_theorems',
    'clock.curr_time -> current_status with key="time"', 'create_goal and clock.sleep have no direct entry',
    'Only the operator starts /loop', 'loop_control only manages an already active loop', 'Do not assume automatic timed control beats',
    'Exploratory subagents are for speculative text-only mathematics', 'access:"read"', 'current_status subagents', 'only one logical worker, worker-1', 'maxRounds=0 (unlimited mathematical rounds)', 'roundTimeoutSeconds=14400 per mathematical round',
    'same worker session receives verifier feedback', 'only one candidate may be pending at a time', 'may repeatedly assign and start jobs without per-job approval']) assert.ok(message.includes(fragment), fragment);
  assert.match(message, /^[\x20-\x7e\n]+$/);
  assert.doesNotMatch(message, /at most three turns|one pending candidate per turn|at most three mathematical rounds/);
  const task = f.tasks.get(p.queued.taskId);
  assert.equal(task.status, 'completed'); assert.equal(typeof task.result, 'object'); assert.equal(task.result.projectId, p.projectId);
});

test('failed home setup keeps diagnostic identity, never deletes or aborts, and displays a readable failure code', async t => {
  const f = await fixture(t, { toolSelectionError: true }), p = await f.create();
  assert.equal(p.status.main.sessionId, 'main-1'); assert.equal(p.status.main.state, 'unconfirmed');
  assert.equal(p.status.main.failurePhase, 'tool-selection'); assert.equal(p.status.state, 'unconfirmed');
  const task = f.tasks.get(p.queued.taskId);
  assert.equal(task.status, 'failed'); assert.equal(task.error, 'Project setup failed: HOST_TOOL_SELECTION_FAILED.');
  assert.ok(!task.error.includes('[object Object]')); assert.ok(!task.error.includes('private fixture text'));
  assert.equal(f.calls.sends.length, 0);
  await f.service.dispose(); f.host.delete(p.status.main.sessionPath); await f.open();
  const recorded = await f.service.status(p.projectId, origin);
  assert.equal(recorded.main.sessionId, 'main-1'); assert.equal(recorded.main.state, 'unconfirmed');
  assert.equal(recorded.main.failurePhase, 'tool-selection'); // A recorded locator is not evidence of continued liveness.
  assert.equal(f.calls.sessions.length, 1); assert.equal(f.calls.sends.length, 0);
});

test('failure settlement with no recorded setup error uses the stable English fallback', async t => {
  const f = await fixture(t, { completeUnconfirmed: true }), p = await f.create();
  assert.equal(p.status.error, null); assert.equal(f.tasks.get(p.queued.taskId).status, 'pending');
  await f.service.dispose();
  assert.equal(f.tasks.get(p.queued.taskId).error, 'Project setup failed: PROJECT_SETUP_FAILED.');
});

test('real project routing preserves lookup failures after a main locator moves, without legacy fallback', async t => {
  const f = await fixture(t), tools = new Map(), legacyCalls = [];
  f.sdk.tools.register = async tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name); };
  const unused = () => assert.fail('unexpected legacy control operation');
  const legacy = { run: unused, status: unused, setupStatus: unused, setToolMode: unused, result: unused, stop: unused, recordSubmissionInputRejection: unused,
    async invoke(...args) { legacyCalls.push(args); return { legacy: true }; } };
  const registration = await registerMathResearch(f.sdk, legacy, f.service); t.after(() => registration.dispose());
  const invoke = context => tools.get('gm_search').execute({ query: 'opaque fixture', context });
  const lookupError = Object.assign(new Error('opaque Host inventory failure'), { code: 'OWN_LOOKUP_FAILED' });
  f.behavior.ownListError = lookupError;
  const before = f.calls.lists.length;
  assert.equal((await invoke(origin)).details.legacy, true); // No project binding: no lookup dependency.
  assert.equal(f.calls.lists.length, before); assert.equal(legacyCalls.length, 1);
  delete f.behavior.ownListError;
  const p = await f.create(), moved = { ...p.context, sessionPath: '/fixture/moved-main.jsonl' };
  const row = f.host.get(p.context.sessionPath); f.host.delete(p.context.sessionPath);
  f.host.set(moved.sessionPath, { ...row, path: moved.sessionPath });
  f.behavior.ownListError = lookupError;
  await assert.rejects(f.service.handles(moved), error => error === lookupError);
  const failed = await invoke(moved);
  assert.equal(failed.isError, true); assert.equal(failed.details.error.code, 'OWN_LOOKUP_FAILED');
  assert.equal(legacyCalls.length, 1); assert.equal(f.calls.core.length, 0);
  assert.equal(await f.service.handles(p.context), true); // Cached routing never grants business authority.
  const cached = await invoke(p.context);
  assert.equal(cached.isError, true); assert.equal(cached.details.error.code, 'OWN_LOOKUP_FAILED');
  assert.equal(legacyCalls.length, 1);
  delete f.behavior.ownListError;
  f.behavior.coreReply = { results: [] }; // Read results are not fact-acceptance receipts.
  const routed = await invoke(moved);
  assert.equal(routed.isError, false); assert.deepEqual(routed.details, { results: [] }); assert.equal(legacyCalls.length, 1);
  assert.equal((await f.service.status(p.projectId, origin)).main.sessionPath, moved.sessionPath);
  assert.equal((await invoke(origin)).details.legacy, true);
  const workerPath = '/fixture/private-legacy-worker.jsonl';
  f.host.set(workerPath, { ...row, sessionId: 'legacy-worker', path: workerPath, namespace: 'app', visibility: 'plugin_private' });
  assert.equal((await invoke({ callToken: 'opaque-worker', sessionPath: workerPath })).details.legacy, true);
  assert.equal(legacyCalls.length, 3);
});

test('visible saved main controls two fresh jobs with one TASK and survives a new service instance', async t => {
  const f = await fixture(t), p = await f.create();
  assert.equal(p.status.state, 'ready'); assert.equal(p.status.startup.state, 'accepted'); assert.equal(f.calls.sessions.length, 1);
  assert.equal(p.status.main.sessionModel.id, 'fixture-model'); assert.equal(p.status.theoremEstablished, false);
  assert.equal(p.status.workerBridge, 'configured-research-rounds');
  const mainDir = path.join(f.dataDir, 'context/projects', p.projectId, 'main');
  assert.equal(await fs.readFile(path.join(mainDir, 'PROBLEM.md'), 'utf8'), '  opaque 用户输入\r\n');
  assert.equal(await fs.readFile(path.join(mainDir, 'OPERATOR.md'), 'utf8'), 'opaque 操作者\t');
  await assert.rejects(fs.lstat(path.join(mainDir, 'TASK.md')), { code: 'ENOENT' });
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'PROJECT_TASK_UNASSIGNED' });
  await f.service.assign({ task: taskBody }, p.context);
  const taskFile = path.join(f.dataDir, 'context/projects', p.projectId, 'workers/worker-1/TASK.md');
  assert.equal(await fs.readFile(taskFile, 'utf8'), taskBody + '\n');
  const first = await f.service.start({ projectId: p.projectId, timeoutSeconds: 60 }, p.context);
  assert.equal(f.calls.starts[0].context, p.context); assert.equal(first.workerId, 'worker-1');
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'PROJECT_WORKER_UNSETTLED' });
  f.jobs.get(first.runId).state = 'finished'; f.jobs.get(first.runId).coordinatorActive = false;
  await f.service.dispose(); await f.open();
  assert.equal(f.calls.sessions.length, 1); assert.equal(f.calls.sends.length, 1);
  const second = await f.service.start({ projectId: p.projectId }, p.context);
  assert.notEqual(second.runId, first.runId); assert.equal(second.projectId, first.projectId);
  assert.equal(await fs.readFile(taskFile, 'utf8'), taskBody + '\n');
  const current = await f.service.status(p.projectId, p.context);
  assert.equal(current.worker.runs.length, 2);
  assert.equal(current.workerBridge, 'configured-research-rounds');
  await f.service.stop({ projectId: p.projectId, force: true }, origin);
  assert.equal((await f.service.list(origin)).projects.length, 1);
});

for (const namespace of ['code', 'bridge', 'phone']) test(`${namespace} creator uses only Host parent stamp and own metadata, never external get`, async t => {
  const f = await fixture(t, { creatorNamespace: namespace }), p = await f.create();
  assert.equal(p.status.state, 'ready');
  const before = f.calls.gets.length;
  await f.service.status(p.projectId, origin); await f.service.list(origin);
  await f.service.result({ projectId: p.projectId }, origin); await f.service.stop({ projectId: p.projectId }, origin);
  assert.equal(f.calls.gets.length, before);
  assert.ok(f.calls.gets.every(ref => ref.sessionPath !== origin.sessionPath && ref.sessionId !== 'creator-stable'));
  const shifted = { ...origin, sessionPath: '/fixture/moved-creator.jsonl' };
  await assert.rejects(f.service.status(p.projectId, shifted), { code: 'PROJECT_OWNER_DENIED' });
  await assert.rejects(f.service.status(p.projectId, { sessionPath: origin.sessionPath }), { code: 'CALLER_UNBOUND' });
  assert.equal(await f.service.handles(origin), false); assert.equal(f.calls.gets.length, before);
});

test('App-owned roles cannot create a creator entry, including receipt ID collisions', async t => {
  const f = await fixture(t), p = await f.create();
  const before = f.calls.tasks.length;
  await assert.rejects(f.service.create({ problem: 'opaque forbidden main create' }, p.context), { code: 'PROJECT_CREATOR_DENIED' });
  const worker = { sessionId: 'owned-worker', path: '/fixture/private-worker.jsonl', agentId: 'saved-worker', cwd: '/fixture/worker', namespace: 'app', visibility: 'plugin_private', ownerPluginId: APP, lifecycle: 'active' };
  f.host.set(worker.path, worker);
  await assert.rejects(f.service.create({ problem: 'opaque forbidden worker create' }, { callToken: 'opaque', sessionPath: worker.path }), { code: 'PROJECT_CREATOR_DENIED' });
  assert.equal(f.calls.tasks.length, before);
  f.host.set('/fixture/owned-id-collision.jsonl', { ...worker, path: '/fixture/owned-id-collision.jsonl', sessionId: 'creator-stable' });
  await assert.rejects(f.service.create({ problem: 'opaque receipt id collision' }, origin), { code: 'PROJECT_CREATOR_DENIED' });
  assert.equal(f.calls.sessions.length, 1);
  const deniedTask = [...f.tasks.values()].at(-1); assert.equal(deniedTask.status, 'failed');
  await assert.rejects(f.service.status(p.projectId, origin), { code: 'PROJECT_OWNER_DENIED' });
});

for (const ownListResponse of [{ ok: false, sessions: [] }, {}, { sessions: [null] }, { sessions: [{ sessionId: 'incomplete', path: '/fixture' }] }])
  test('invalid own identity inventory fails closed before creator task creation', async t => {
    const f = await fixture(t, { ownListResponse });
    await assert.rejects(f.service.create({ problem: 'opaque' }, origin), { code: 'PROJECT_SESSION_LIST_INVALID' });
    assert.equal(f.calls.tasks.length, 0); assert.equal(f.calls.sessions.length, 0); assert.equal(f.calls.gets.length, 0);
  });

test('valid historical own rows need no agent/cwd and null IDs cannot become routing identities', async t => {
  const f = await fixture(t, { createError: true });
  const legacy = { sessionId: null, path: '/fixture/legacy-one', ownerPluginId: APP, visibility: 'plugin_private', lifecycle: 'archived' };
  f.host.set(legacy.path, legacy);
  f.host.set('/fixture/legacy-two', { ...legacy, path: '/fixture/legacy-two', agentId: null, cwd: null });
  f.host.set('/fixture/legacy-stable', { ...legacy, path: '/fixture/legacy-stable', sessionId: 'legacy-stable' });
  const p = await f.create(); // Session creation fails by fixture, not the legal historical inventory.
  assert.equal(p.status.error, 'HOST_CREATE_UNKNOWN'); assert.equal(f.calls.sessions.length, 1);
  assert.equal(await f.service.handles({ sessionPath: legacy.path }), false);
  await assert.rejects(f.service.assign({ task: 'opaque' }, { callToken: 'opaque', sessionPath: legacy.path }), { code: 'PROJECT_MAIN_DENIED' });
  const count = f.calls.tasks.length;
  await assert.rejects(f.service.create({ problem: 'opaque owned path' }, { callToken: 'opaque', sessionPath: legacy.path }), { code: 'PROJECT_CREATOR_DENIED' });
  assert.equal(f.calls.tasks.length, count);
  f.behavior.createError = false;
  const ready = await f.create({ problem: 'opaque fresh project beside historical rows' }); assert.equal(ready.status.state, 'ready');
  await f.service.assign({ task: 'opaque assignment' }, ready.context);
});

for (const invalid of ['duplicate-id', 'duplicate-path', 'foreign-owner']) test(`own inventory still rejects ${invalid}`, async t => {
  const row = { sessionId: 'own-one', path: '/fixture/one', ownerPluginId: APP, visibility: 'public', lifecycle: 'active' };
  const other = { ...row, sessionId: 'own-two', path: '/fixture/two' };
  if (invalid === 'duplicate-id') other.sessionId = row.sessionId;
  if (invalid === 'duplicate-path') other.path = row.path;
  if (invalid === 'foreign-owner') other.ownerPluginId = 'foreign-app';
  const f = await fixture(t, { ownListResponse: { sessions: [row, other] } });
  await assert.rejects(f.service.create({ problem: 'opaque' }, origin), { code: 'PROJECT_SESSION_LIST_INVALID' });
  assert.equal(f.calls.tasks.length, 0);
});

for (const rejection of ['WORKER_BUSY', 'RUN_BUSY', 'CONFIGURATION_BUSY', 'RECOVERY_BLOCKED', 'LEGACY_PROJECT_FORBIDDEN', 'DEPENDENCY_MISSING'])
  test(`confirmed ${rejection} restores the prior worker locator without replay`, async t => {
    const behavior = {}, f = await fixture(t, behavior), p = await f.create();
    await f.service.assign({ task: 'opaque B' }, p.context);
    const first = await f.service.start({ projectId: p.projectId }, p.context);
    f.jobs.get(first.runId).state = 'finished'; f.jobs.get(first.runId).coordinatorActive = false;
    behavior.admissionError = rejection;
    await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: rejection });
    const status = await f.service.status(p.projectId, origin);
    assert.equal(status.worker.lastRun, first.runId); assert.equal(status.worker.start.state, 'settled');
    assert.equal(status.worker.start.error, rejection); assert.deepEqual(status.worker.runs, [first.runId]);
    assert.equal(f.calls.starts.length, 2); assert.equal(f.jobs.size, 1);
    await f.service.stop({ projectId: p.projectId }, origin);
    assert.equal(f.calls.stops.at(-1).runId, first.runId);
    delete behavior.admissionError;
    const second = await f.service.start({ projectId: p.projectId }, p.context);
    assert.notEqual(second.runId, first.runId); assert.equal(f.calls.starts.length, 3);
  });

test('a busy-shaped rejection with runId retains the actual admitted job', async t => {
  const f = await fixture(t, { startError: true, knownRun: true, startErrorCode: 'WORKER_BUSY' }), p = await f.create();
  await f.service.assign({ task: 'opaque B' }, p.context);
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'WORKER_BUSY' });
  const status = await f.service.status(p.projectId, origin);
  assert.equal(status.worker.start.state, 'unknown'); assert.equal(status.worker.lastRun, 'run-1');
  assert.deepEqual(status.worker.runs, ['run-1']);
  await f.service.stop({ projectId: p.projectId }, origin); assert.equal(f.calls.stops.at(-1).runId, 'run-1');
});

test('local bounded timeout remains unknown even when the backend later reports an explicit busy refusal', async t => {
  const gate = defer(), entered = defer(), behavior = { admissionGate: gate, admissionError: 'WORKER_BUSY', onAdmission: () => entered.resolve() };
  const f = await fixture(t, behavior), p = await f.create();
  await f.service.assign({ task: 'opaque B' }, p.context);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const attempt = f.service.start({ projectId: p.projectId }, p.context);
  const rejected = assert.rejects(attempt, { code: 'PROJECT_CONTROL_TIMEOUT' });
  await entered.promise; t.mock.timers.tick(10001); await rejected;
  gate.resolve(); await new Promise(resolve => setImmediate(resolve)); t.mock.timers.reset();
  assert.equal((await f.service.status(p.projectId, origin)).worker.start.state, 'unknown');
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'PROJECT_WORKER_UNSETTLED' });
  assert.equal(f.calls.starts.length, 1);
});

for (const cleanupFails of [false, true]) test(cleanupFails
  ? 'late first cleanup failure remains visible without rolling back dispatched setup or failing its root task'
  : 'late schedule receipt shares handler cleanup after root admission without failing an accepted main', async t => {
  const entered = defer(), mainGate = defer(), receiptGate = defer(), settling = defer();
  const f = await fixture(t, { autoDispatch: true, scheduleReceiptGate: receiptGate,
    handlerWithoutScheduleId: cleanupFails, unscheduleError: cleanupFails });
  t.after(() => { mainGate.resolve(); receiptGate.resolve(); });
  const createMain = f.sdk.sessions.create;
  f.sdk.sessions.create = async input => { entered.resolve(); await mainGate.promise; return createMain(input); };
  const getTask = f.sdk.tasks.get;
  f.sdk.tasks.get = async id => {
    const row = await getTask(id);
    const meta = JSON.parse(await fs.readFile(path.join(f.dataDir, 'research/projects', row.metadata.projectId, 'project.json')));
    if (meta.startup.state === 'accepted') settling.resolve();
    return row;
  };
  const creating = f.service.create({ problem: 'opaque deterministic unschedule race' }, origin).then(value => ({ value }), error => ({ error }));
  await entered.promise; // setup already passed root-task active check; main is not ready yet.
  receiptGate.resolve(); const receipt = await creating;
  mainGate.resolve(); await settling.promise;
  const scheduleInput = f.calls.schedules[0];
  assert.equal((await f.handlers.get(scheduleInput.handlerKey).run({ kind: 'schedule', scheduleId: 'schedule-1', input: scheduleInput.payload })).status, 'ignored');
  const disposed = await f.service.dispose();
  const projectId = receipt.value?.projectId || receipt.error.projectId;
  const status = await f.service.status(projectId, origin), root = [...f.tasks.values()][0];
  t.diagnostic(JSON.stringify({ createError: receipt.error?.code || null, state: status.state, startup: status.startup.state,
    rootTask: root.status, unscheduleCalls: f.calls.unschedules.length, mainStarts: f.calls.sends.length }));
  if (cleanupFails) { assert.equal(receipt.error.code, 'APP_HOST_ERROR'); assert.equal(status.scheduleCleanup.state, 'failed'); assert.equal(status.scheduleCleanup.error, 'APP_HOST_ERROR'); }
  else { assert.equal(receipt.error, undefined); assert.equal(receipt.value.state, 'queued'); assert.equal(status.scheduleCleanup.state, 'confirmed'); }
  assert.equal(disposed.cleanupPending, cleanupFails);
  assert.equal(status.state, 'ready'); assert.equal(status.startup.state, 'accepted');
  assert.equal(root.status, 'completed'); assert.equal(f.calls.unschedules.length, 1);
  assert.equal(f.calls.sessions.length, 1); assert.equal(f.calls.sends.length, 1);
  const meta = JSON.parse(await fs.readFile(path.join(f.dataDir, 'research/projects', projectId, 'project.json')));
  assert.equal(meta.scheduleId, cleanupFails ? 'schedule-1' : null); assert.equal(meta.taskSettlement, 'confirmed');
});

test('first handler cleanup rejection is shared and visible, with no setup replay or false completion', async t => {
  const done = defer(); let f;
  f = await fixture(t, { autoDispatch: true, unscheduleError: true,
    onSchedule: row => f.completions.set(row.payload.projectId, done) });
  const error = await f.service.create({ problem: 'opaque cleanup rejection' }, origin).then(() => assert.fail('must reject'), error => error);
  assert.equal(error.code, 'APP_HOST_ERROR'); await done.promise;
  const disposed = await f.service.dispose(), status = await f.service.status(error.projectId, origin);
  assert.equal(status.state, 'unconfirmed'); assert.equal(status.error, 'APP_HOST_ERROR');
  assert.equal(status.scheduleCleanup.state, 'failed'); assert.equal(status.scheduleCleanup.removed, false);
  assert.equal(f.tasks.get(error.taskId).status, 'failed'); assert.equal(disposed.cleanupPending, true);
  f.behavior.unscheduleError = false; // A later caller must not silently retry or turn the failed receipt into success.
  assert.equal((await f.service.dispose()).cleanupPending, true);
  assert.equal(f.calls.unschedules.length, 1); assert.equal(f.calls.sessions.length, 0); assert.equal(f.calls.sends.length, 0);
  assert.equal(f.schedules.size, 1);
});

test('dispose and a late schedule acknowledgement remove once without starting main or retaining the deleted ID', async t => {
  const scheduled = defer(), receiptGate = defer();
  const f = await fixture(t, { onSchedule: scheduled.resolve, scheduleReceiptGate: receiptGate });
  t.after(() => receiptGate.resolve());
  const creating = f.service.create({ problem: 'opaque late schedule disposal' }, origin).catch(error => error);
  await scheduled.promise;
  const stopping = f.service.dispose(); receiptGate.resolve();
  const [error, disposed] = await Promise.all([creating, stopping]);
  assert.equal(error.code, 'PROJECT_DISPOSED'); assert.equal(disposed.cleanupPending, false);
  assert.equal(f.calls.unschedules.length, 1); assert.equal(f.schedules.size, 0);
  assert.equal(f.calls.sessions.length, 0); assert.equal(f.calls.sends.length, 0);
  const meta = JSON.parse(await fs.readFile(path.join(f.dataDir, 'research/projects', error.projectId, 'project.json')));
  assert.equal(meta.scheduleId, null); assert.equal(meta.scheduleCleanup.state, 'confirmed');
  assert.equal(f.tasks.get(error.taskId).status, 'failed');
});

test('concurrent dispose callers share one in-flight schedule deletion', async t => {
  const entered = defer(), gate = defer();
  const f = await fixture(t, { onUnschedule: entered.resolve, unscheduleGate: gate });
  t.after(() => gate.resolve());
  const queued = await f.service.create({ problem: 'opaque concurrent disposal' }, origin);
  const first = f.service.dispose(); await entered.promise;
  const second = f.service.dispose(); gate.resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => !result.cleanupPending)); assert.equal(f.calls.unschedules.length, 1);
  assert.equal(f.schedules.size, 0); assert.equal(f.tasks.get(queued.taskId).status, 'failed');
  assert.equal(f.calls.sessions.length, 0); assert.equal(f.calls.sends.length, 0);
});

test('create acknowledges queued even when the App schedule starts immediately, without waiting for main creation', async t => {
  const f = await fixture(t, { autoDispatch: true }), entered = defer(), gate = defer(); t.after(() => gate.resolve());
  const original = f.sdk.sessions.create;
  f.sdk.sessions.create = async input => { entered.resolve(); await gate.promise; return original(input); };
  const queued = await f.service.create({ problem: 'opaque immediate schedule' }, origin);
  assert.deepEqual(Object.keys(queued).sort(), ['projectId', 'state', 'taskId']); assert.equal(queued.state, 'queued');
  const done = defer(); f.completions.set(queued.projectId, done); await entered.promise;
  assert.equal(f.calls.sends.length, 0); gate.resolve(); await done.promise;
  assert.equal((await f.service.status(queued.projectId, origin)).startup.state, 'accepted');
});

test('creator, foreign same-agent and worker cannot act as bound main; handles never authorizes', async t => {
  const f = await fixture(t), p = await f.create(), q = await f.create({ problem: 'opaque other project' });
  await assert.rejects(f.service.assign({ task: 'opaque' }, origin), { code: 'PROJECT_MAIN_DENIED' });
  await assert.rejects(f.service.start({ projectId: p.projectId }, origin), { code: 'PROJECT_OWNER_DENIED' });
  await assert.rejects(f.service.status(p.projectId, q.context), { code: 'PROJECT_OWNER_DENIED' });
  const foreign = { ...f.host.get(p.context.sessionPath), sessionId: 'foreign-main', path: '/fixture/foreign.jsonl' }; f.host.set(foreign.path, foreign);
  await assert.rejects(f.service.assign({ task: 'opaque' }, { callToken: 'opaque', sessionPath: foreign.path }), { code: 'PROJECT_MAIN_DENIED' });
  const worker = { ...foreign, sessionId: 'private-worker', path: '/fixture/worker.jsonl', agentId: 'saved-worker', namespace: 'app', visibility: 'plugin_private' }; f.host.set(worker.path, worker);
  await assert.rejects(f.service.stop({ projectId: p.projectId }, { callToken: 'opaque-worker', sessionPath: worker.path }), { code: 'PROJECT_OWNER_DENIED' });
  assert.equal(await f.service.handles({ sessionPath: p.context.sessionPath }), true);
  await assert.rejects(f.service.assign({ task: 'opaque' }, { sessionPath: p.context.sessionPath }), { code: 'CALLER_UNBOUND' });
  f.agents[0].state = 'deleted';
  await assert.rejects(f.service.assign({ task: 'opaque' }, p.context), { code: 'PROJECT_MAIN_DENIED' });
  assert.equal((await f.service.status(p.projectId, origin)).projectId, p.projectId);
  assert.equal(f.calls.starts.length, 0);
});

test('main route follows verified stable identity after locator move, not an Agent name', async t => {
  const f = await fixture(t), p = await f.create(); const row = f.host.get(p.context.sessionPath); f.host.delete(row.path);
  row.path = '/fixture/moved.jsonl'; f.host.set(row.path, row); const ctx = { ...p.context, sessionPath: row.path };
  assert.equal(await f.service.handles(ctx), true);
  assert.equal((await f.service.assign({ task: 'opaque moved task' }, ctx)).assigned, true);
  assert.equal((await f.service.status(p.projectId, ctx)).main.sessionPath, row.path);
});

test('Core operations retain separate full records, canonical results and mathematical uncertainty across restart', async t => {
  const behavior = {}, f = await fixture(t, behavior), p = await f.create();
  await f.service.invoke('gm_add', { kind: 'observation', claim: 'opaque fixture' }, p.context);
  await f.service.invoke('gm_search', { query: 'opaque fixture' }, p.context);
  const canonical = await f.service.result({ projectId: p.projectId, factId: 'a'.repeat(16) }, origin);
  assert.deepEqual(canonical, { projectId: p.projectId, fact: { fact_id: 'a'.repeat(16), markdown: 'opaque canonical full fixture', predecessors: [] } });
  const coreDir = path.join(f.dataDir, 'research/projects', p.projectId, 'core');
  assert.equal((await fs.readdir(coreDir)).length, 3);
  const records = await Promise.all((await fs.readdir(coreDir)).map(file => fs.readFile(path.join(coreDir, file), 'utf8').then(JSON.parse)));
  assert.ok(records.every(r => r.revision > 0 && r.role === 'main' && r.author === 'saved-main' && r.pending === false && r.argumentsDigest && r.outcome.result));
  assert.deepEqual(records.map(r => r.operation).sort(), ['fact_get', 'gm_add', 'gm_search']);
  behavior.coreUncertain = true;
  await assert.rejects(f.service.invoke('gm_add', { kind: 'observation', claim: 'opaque uncertain fixture' }, p.context));
  const state = await f.service.status(p.projectId, origin); assert.equal(state.coreUnsettled, true);
  const unknown = state.coreOperations.find(r => r.indeterminate); assert.ok(unknown); assert.equal(unknown.pending, false);
  await f.service.dispose(); behavior.coreUncertain = false;
  const uncertainFile = path.join(coreDir, unknown.operationId + '.json');
  const persisted = JSON.parse(await fs.readFile(uncertainFile)); assert.equal(persisted.mathematicalUnsettled, true);
  persisted.outcome.failure.runtime.indeterminate = false; // A later resource observation cannot erase the separate mathematical fence.
  await fs.writeFile(uncertainFile, JSON.stringify(persisted));
  await f.open();
  const before = f.calls.factories.length;
  await assert.rejects(f.service.invoke('gm_search', { query: 'opaque' }, p.context), { code: 'PROJECT_CORE_UNSETTLED' });
  assert.equal(f.calls.factories.length, before);
  await f.service.stop({ projectId: p.projectId }, origin);
  const other = await f.create({ problem: 'opaque independent fixture' });
  await f.service.invoke('gm_search', { query: 'opaque independent' }, other.context);
});

for (const operation of ['fact_get', 'fact_list_page', 'fact_search', 'gm_search']) test(`cleaned ${operation} result loss is not a shared-write fence`, async t => {
  const behavior = { coreUncertain: true }, f = await fixture(t, behavior), p = await f.create();
  const call = () => operation === 'fact_get' ? f.service.result({ projectId: p.projectId, factId: 'a'.repeat(16) }, origin)
    : operation === 'fact_list_page' ? f.service.result({ projectId: p.projectId }, origin)
      : f.service.invoke(operation, { query: 'opaque read' }, p.context);
  await assert.rejects(call());
  const status = await f.service.status(p.projectId, origin);
  assert.equal(status.coreUnsettled, false); assert.equal(status.coreOperations[0].pending, false);
  assert.equal(status.coreOperations[0].indeterminate, true); assert.equal(status.coreOperations[0].mathematicalUnsettled, false);
  const dir = path.join(f.dataDir, 'research/projects', p.projectId, 'core');
  const record = JSON.parse(await fs.readFile(path.join(dir, (await fs.readdir(dir))[0])));
  assert.equal(record.mathematicalUnsettled, false); assert.equal(record.outcome.failure.runtime.indeterminate, true);
  behavior.coreUncertain = false; await call();
  const stopped = await f.service.dispose(); assert.equal(stopped.mathematicalUnsettled, false);
  await f.open(); await call();
});

test('fact_revoke uncertainty remains a project-local mutation fence after confirmed resource cleanup', async t => {
  const behavior = { coreUncertain: true }, f = await fixture(t, behavior), p = await f.create();
  await assert.rejects(f.service.invoke('fact_revoke', { fact_id: 'a'.repeat(16), reason: 'opaque fixture' }, p.context));
  const status = await f.service.status(p.projectId, origin); assert.equal(status.coreUnsettled, true);
  assert.equal(status.coreOperations[0].pending, false); assert.equal(status.coreOperations[0].mathematicalUnsettled, true);
  await f.service.dispose(); behavior.coreUncertain = false; await f.open();
  await assert.rejects(f.service.result({ projectId: p.projectId }, origin), { code: 'PROJECT_CORE_UNSETTLED' });
  const other = await f.create({ problem: 'opaque independent project' });
  assert.ok((await f.service.result({ projectId: other.projectId }, origin)).facts);
});

for (const mutation of [false, true]) test(`persisted outcome and resource uncertainty are separate (mutation=${mutation})`, async t => {
  const f = await fixture(t), p = await f.create();
  await f.service.invoke(mutation ? 'gm_add' : 'gm_search', mutation ? { kind: 'observation', claim: 'opaque' } : { query: 'opaque' }, p.context);
  await f.service.dispose();
  const dir = path.join(f.dataDir, 'research/projects', p.projectId, 'core'), file = path.join(dir, (await fs.readdir(dir))[0]);
  const record = JSON.parse(await fs.readFile(file)); record.outcome = { state: 'pending' }; record.pending = false;
  await fs.writeFile(file, JSON.stringify(record)); await f.open();
  if (mutation) await assert.rejects(f.service.result({ projectId: p.projectId }, origin), { code: 'PROJECT_CORE_UNSETTLED' });
  else assert.ok((await f.service.result({ projectId: p.projectId }, origin)).facts);
  await f.service.dispose(); record.pending = true; record.phase = 'unsettled'; record.cleanup.confirmed = false;
  await fs.writeFile(file, JSON.stringify(record)); await f.open();
  await assert.rejects(f.service.result({ projectId: p.projectId }, origin), { code: 'PROJECT_CORE_UNSETTLED' });
});

test('native public pages traverse a >1MiB opaque graph and coexist with full export', { timeout: 45000 }, async t => {
  const execute = promisify(execFile), engine = fileURLToPath(new URL('../engine/src', import.meta.url)), envelopes = [];
  const f = await fixture(t, { coreCall: async (binding, operation, args, dataDir) => {
    const request = { schemaVersion: 1, requestId: randomUUID(), operation, context: binding, arguments: args };
    const script = 'import sys,json; sys.path.insert(0,sys.argv[1]); from hana_math_engine.research import dispatch; print(json.dumps(dispatch(sys.argv[2],json.loads(sys.argv[3]))))';
    const { stdout } = await execute(process.env.PYTHON312 || 'python3.12', ['-B', '-c', script, engine, dataDir, JSON.stringify(request)], { timeout: 15000, maxBuffer: 2 << 20 });
    const envelope = JSON.parse(stdout); envelopes.push(envelope);
    if (!envelope.ok) throw Object.assign(new Error('private fixture path must not escape'), { code: 'RESEARCH_RUNTIME_REJECTED', coreError: envelope.error });
    return envelope.result;
  } }), p = await f.create(), tools = new Map(), staged = [];
  const directory = path.join(f.dataDir, 'context/projects', p.projectId, 'shared/fact_graph/facts'); await fs.mkdir(directory, { recursive: true });
  const ids = Array.from({ length: 80 }, (_, i) => i.toString(16).padStart(16, '0'));
  for (const id of ids) await fs.writeFile(path.join(directory, `${id}.md`), `---\nfact_id: ${id}\npredecessors: []\n---\n## statement\nopaque ${id}\n## proof\n${'x'.repeat(18000)}\n`);
  f.sdk.tools.register = async tool => { tools.set(tool.name, tool); return () => {}; };
  f.sdk.resources = { stage: async input => { staged.push(await fs.readFile(input.path)); return { resource: { kind: 'session-file', fileId: 'fixture-export', sessionId: 'creator-stable' } }; } };
  const unused = () => assert.fail('legacy path must not be used');
  const registration = await registerMathResearch(f.sdk, Object.fromEntries(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection'].map(k => [k, unused])), f.service);
  t.after(() => registration.dispose());
  const call = options => tools.get('math_project').execute({ action: 'result', projectId: p.projectId, ...options, context: origin });
  let options = { limit: 13 }, seen = [], first;
  for (;;) {
    const reply = await call(options); assert.equal(reply.isError, false, JSON.stringify(reply.details)); const value = reply.details;
    first ??= value; assert.equal(value.page.startIndex, seen.length); assert.equal(value.page.asOf, first.page.asOf);
    assert.ok(Buffer.byteLength(JSON.stringify({ facts: value.facts, page: value.page })) <= 16384);
    assert.equal(value.page.allFactsIncluded, false); seen.push(...value.facts.map(row => row.fact_id));
    if (!value.page.hasMore) break; options = { cursor: value.page.nextCursor };
  }
  assert.deepEqual(seen, ids);
  const exported = await call({ factId: ids[0] }); assert.equal(exported.isError, false, JSON.stringify(exported.details));
  assert.equal(exported.details.fullTextInFile, true); assert.deepEqual(staged[0], await fs.readFile(path.join(directory, `${ids[0]}.md`)));
  const before = f.calls.core.length;
  for (const invalid of [{ factId: ids[0], limit: 1 }, { cursor: first.page.nextCursor, limit: 2 }, { limit: 65 }]) assert.equal((await call(invalid)).isError, true);
  await assert.rejects(f.service.result({ projectId: p.projectId, cursor: first.page.nextCursor }, { sessionPath: '/fixture/foreign', callToken: 'fixture' }), { code: 'PROJECT_OWNER_DENIED' });
  assert.equal(f.calls.core.length, before);
  await fs.appendFile(path.join(directory, `${ids[0]}.md`), '\n## intuition\nopaque byte change');
  const stale = await call({ cursor: first.page.nextCursor }); assert.equal(stale.isError, true); assert.equal(stale.details.facts, undefined);
  assert.equal(envelopes.at(-1).error.code, 'fact_page_changed'); assert.ok(!JSON.stringify(stale).includes('private fixture path'));
  assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.sends.length, 1);
});

test('graph uses authorized index reads only and preserves existing project/Goal/worker behavior', async t => {
  const f = await fixture(t), p = await f.create();
  for (const ctx of [origin, p.context]) {
    const snapshot = await f.service.graph({ projectId: p.projectId }, ctx);
    assert.equal(snapshot.projectId, p.projectId); assert.equal(snapshot.facts.length, 1);
    assert.match(snapshot.asOf, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(snapshot.capturedAt));
  }
  assert.ok(f.calls.core.every(c => c.operation === 'fact_list_page'));
  assert.equal(f.calls.core.length, 4); const before = f.calls.core.length;
  await assert.rejects(f.service.graph({ projectId: p.projectId }, { sessionPath: '/fixture/foreign', callToken: 'opaque' }), { code: 'PROJECT_OWNER_DENIED' });
  for (const extra of [{ factId: 'a'.repeat(16) }, { cursor: 'opaque' }, { limit: 1 }, { context: origin }]) {
    await assert.rejects(f.service.graph({ projectId: p.projectId, ...extra }, origin), { code: 'PROJECT_INVALID_INPUT' });
  }
  assert.equal(f.calls.core.length, before); assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.stops.length, 0);
  assert.equal(f.calls.sends.length, 1); assert.deepEqual(await f.service.goal('status', { projectId: p.projectId }, origin), { projectId: p.projectId, managed: false });
});

test('result envelope preserves full canonical Markdown, projects listings, and rejects invalid Core receipts', async t => {
  const behavior = {}, f = await fixture(t, behavior), p = await f.create(), id = 'a'.repeat(16), predecessor = 'b'.repeat(16);
  const markdown = 'opaque full tail\r\n\t'.repeat(3000);
  behavior.coreReply = fixtureFactPage([{ fact_id: id, predecessors: [predecessor], markdown }], {}, p.projectId);
  assert.deepEqual(await f.service.result({ projectId: p.projectId }, origin), { projectId: p.projectId, ...behavior.coreReply });
  assert.equal(Object.hasOwn(behavior.coreReply.facts[0], 'markdown'), false);
  behavior.coreReply = { fact_id: id, predecessors: [predecessor], markdown };
  assert.deepEqual(await f.service.result({ projectId: p.projectId, factId: id }, origin), { projectId: p.projectId, fact: behavior.coreReply });
  for (const bad of [null, { facts: null }, { facts: [{ fact_id: 'invalid', predecessors: [] }] },
    fixtureFactPage([{ fact_id: id, predecessors: ['invalid'] }], {}, p.projectId), fixtureFactPage([{ fact_id: id, predecessors: [] }, { fact_id: id, predecessors: [] }], {}, p.projectId)]) {
    behavior.coreReply = bad; await assert.rejects(f.service.result({ projectId: p.projectId }, origin), { code: 'PROJECT_CORE_INVALID_RESULT' });
  }
  for (const bad of [{ fact_id: predecessor, predecessors: [], markdown }, { fact_id: id, predecessors: [] },
    { fact_id: id, predecessors: 'invalid', markdown }, { fact_id: id, predecessors: [], markdown: '' }]) {
    behavior.coreReply = bad; await assert.rejects(f.service.result({ projectId: p.projectId, factId: id }, origin), { code: 'PROJECT_CORE_INVALID_RESULT' });
  }
});

test('pending mutation outcome blocks after restart even with resource pending false', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.invoke('gm_add', { kind: 'observation', claim: 'opaque' }, p.context); await f.service.dispose();
  const dir = path.join(f.dataDir, 'research/projects', p.projectId, 'core'), file = path.join(dir, (await fs.readdir(dir))[0]);
  const record = JSON.parse(await fs.readFile(file)); record.outcome = { state: 'pending' }; record.pending = false; await fs.writeFile(file, JSON.stringify(record));
  await f.open(); await assert.rejects(f.service.result({ projectId: p.projectId }, origin), { code: 'PROJECT_CORE_UNSETTLED' });
});

for (const stage of ['createError', 'sendError']) test(`unknown ${stage} is retained and never retried/replaced on startup`, async t => {
  const behavior = { [stage]: true }, f = await fixture(t, behavior), p = await f.create();
  assert.equal(p.status.error, stage === 'createError' ? 'HOST_CREATE_UNKNOWN' : 'HOST_SEND_UNKNOWN');
  if (stage === 'sendError') assert.equal(p.status.startup.state, 'unknown');
  const creates = f.calls.sessions.length, sends = f.calls.sends.length;
  await f.service.dispose(); behavior[stage] = false; await f.open();
  await f.service.status(p.projectId, origin);
  assert.equal(f.calls.sessions.length, creates); assert.equal(f.calls.sends.length, sends);
});

test('pending worker admission is persisted before bridge call; unknown failure is not replayed', async t => {
  const gate = defer(), admitted = defer(); t.after(() => gate.resolve());
  const behavior = { startGate: gate, startError: true, knownRun: true, onAdmission: () => admitted.resolve() };
  const f = await fixture(t, behavior), p = await f.create();
  await f.service.assign({ task: 'opaque B' }, p.context);
  const pending = f.service.start({ projectId: p.projectId }, p.context);
  let timer;
  try {
    await Promise.race([admitted.promise, pending.then(() => assert.fail('Worker start completed before admission')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture admission barrier timed out')), 10000); })]);
    clearTimeout(timer);
    assert.equal(f.calls.starts.length, 1);
    await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'PROJECT_CONTROL_BUSY' });
    gate.resolve(); await assert.rejects(pending, { code: 'START_UNKNOWN' });
    assert.equal((await f.service.status(p.projectId, origin)).worker.lastRun, 'run-1');
    await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'PROJECT_WORKER_UNSETTLED' });
    assert.equal(f.calls.starts.length, 1);
  } finally {
    clearTimeout(timer); gate.resolve(); await pending.catch(() => {});
  }
});

test('unknown worker start without a run locator stays fenced across restart', async t => {
  const behavior = { startError: true, knownRun: false }, f = await fixture(t, behavior), p = await f.create();
  await f.service.assign({ task: 'opaque B' }, p.context);
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'START_UNKNOWN' });
  await f.service.dispose(); behavior.startError = false; await f.open();
  await f.service.stop({ projectId: p.projectId }, origin);
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'PROJECT_WORKER_UNSETTLED' });
  assert.equal(f.calls.starts.length, 1);
});

test('explicit stop during pending admission stops a late confirmed worker without touching visible main', async t => {
  const gate = defer(), admitted = defer(); t.after(() => gate.resolve());
  const f = await fixture(t, { startGate: gate, onAdmission: () => admitted.resolve() }), p = await f.create();
  await f.service.assign({ task: 'opaque B' }, p.context);
  const starting = f.service.start({ projectId: p.projectId }, p.context);
  let timer;
  try {
    await Promise.race([admitted.promise, starting.then(() => assert.fail('Worker start completed before admission')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture admission barrier timed out')), 10000); })]);
    clearTimeout(timer);
    assert.equal(f.calls.starts.length, 1);
    const status = await f.service.stop({ projectId: p.projectId }, origin); assert.equal(status.worker.start.state, 'pending');
    gate.resolve(); assert.equal((await starting).state, 'stopped'); assert.equal(f.calls.stops.length, 1);
  } finally {
    clearTimeout(timer); gate.resolve(); await starting.catch(() => {});
  }
});

test('assignment failure never reports assigned or starts a worker', async t => {
  const f = await fixture(t), p = await f.create();
  f.contexts.assignWorkerTask = async () => { throw Object.assign(new Error('opaque write failure'), { code: 'EIO' }); };
  await assert.rejects(f.service.assign({ task: 'opaque B' }, p.context), { code: 'EIO' });
  assert.equal((await f.service.status(p.projectId, origin)).worker.assignment.state, 'unknown');
  await assert.rejects(f.service.start({ projectId: p.projectId }, p.context), { code: 'PROJECT_TASK_UNASSIGNED' });
  assert.equal(f.calls.starts.length, 0);
});

test('corrupt project metadata does not recreate its main or freeze a new independent project', async t => {
  const f = await fixture(t), p = await f.create(); await f.service.dispose();
  await fs.writeFile(path.join(f.dataDir, 'research/projects', p.projectId, 'project.json'), '{opaque corruption');
  await f.open(); await assert.rejects(f.service.status(p.projectId, origin), { code: 'PROJECT_RECORD_INVALID' });
  assert.equal(f.calls.sessions.length, 1);
  const next = await f.create({ problem: 'opaque independent project' }); assert.equal(next.status.state, 'ready');
  assert.equal(f.calls.sessions.length, 2);
});

test('create/input and tool selectors cannot override identity; literature uses the existing adapter', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.create({ problem: 'opaque', workerTask: 'forbidden' }, origin), { code: 'PROJECT_INVALID_INPUT' });
  await assert.rejects(f.service.create({ problem: 'opaque', projectId: 'project-import' }, origin), { code: 'PROJECT_INVALID_INPUT' });
  const p = await f.create();
  await assert.rejects(f.service.invoke('fact_submit', {}, p.context), { code: 'PROJECT_TOOL_DENIED' });
  await assert.rejects(f.service.invoke('gm_search', { query: 'opaque', projectId: 'project-other' }, p.context));
  await f.service.invoke('search_arxiv_theorems', { query: 'opaque literature' }, p.context);
  assert.deepEqual(f.calls.literature, [['opaque literature', 10]]);
});
