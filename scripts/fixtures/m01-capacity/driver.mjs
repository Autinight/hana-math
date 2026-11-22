#!/usr/bin/env node
// M01 SOFTWARE rehearsal ONLY. No real Host, models, network or mathematical evidence.
// Protocol/Host helper structure is derived from the joint integration fixture;
// production queueCore/coreCall/Runtime imports stay unmodified and execute for real.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createFixture, deadline, good, sleep } from './host.mjs';
import { createBarrier, createRunMonitor, errorRecord, projectedFailure, raceParticipant, selectPrimaryFailure } from './gates.mjs';
import { publicRequestId, correlateRequests, windowCounts, combineOutcome } from './observations.mjs';
import { telemetry, summaries, ipcSample, actorOf, classification, hasBusyCode, waitAfter,
  PROTOCOL_REVISION, PRIMARY_BRIDGE_DESCRIPTION, primaryBridgeMetric, validatePrimaryBridgeMetric, mainApiCompanions } from './metrics.mjs';

const execute = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const output = path.join(repo, 'dist/validation/m01-capacity-rehearsal-004');
const stage = path.join(repo, 'dist/staging/release-0.18.1-001/hana-math');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function parse(args) {
  const result = { facts: 1000, workers: 4, cadence: 'normal' }; let rehearsal = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]; assert.ok(!seen.has(key), `duplicate flag ${key}`); seen.add(key);
    if (key === '--rehearsal') rehearsal = true;
    else if (['--facts', '--workers', '--cadence'].includes(key)) {
      const value = args[++i]; assert.ok(value && !value.startsWith('--'), `missing ${key}`);
      result[key.slice(2)] = key === '--cadence' ? value : Number(value);
    } else throw new Error(`Only --rehearsal [--facts 1000 --workers 4 --cadence normal] is permitted; rejected ${key}`);
  }
  assert.ok(rehearsal, '--rehearsal is mandatory; no benchmark/full mode');
  assert.deepEqual(result, { facts: 1000, workers: 4, cadence: 'normal' }, 'only 1000 facts / 4 workers / normal cadence authorized');
  assert.equal(Number(process.versions.node.split('.')[0]), 26, 'explicit Node 26 required');
  return result;
}
const config = parse(process.argv.slice(2)); // No fixture or output exists before authorization/shape checks.
const startedAt = new Date().toISOString();
await fs.mkdir(output, { recursive: false }); // Evidence is single-use: never overwrite an earlier rehearsal.
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'm01-capacity-opaque-')));
const dataDir = path.join(scratch, 'measurement-data'), warmupDataDir = path.join(scratch, 'warmup-data'), packageRoot = path.join(scratch, 'package');
const env = { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch, LANG: 'en_US.UTF-8' };
const manifest = {
  schemaVersion: 1, protocolRevision: PROTOCOL_REVISION, phase: 'rehearsal', evidenceEligible: false, capacityDecision: 'not-evaluated', config,
  primaryMetricDescription: PRIMARY_BRIDGE_DESCRIPTION,
  startedAt, endedAt: null,
  authorization: { attempt: '004', priorEvidence: ['dist/validation/m01-capacity-rehearsal-001', 'dist/validation/m01-capacity-rehearsal-002', 'dist/validation/m01-capacity-rehearsal-003'],
    reason: 'Explicit single fourth rehearsal authorization under m01-bridge-v2 after observation-only fixes and Core-free contracts; 1000/4/normal once; primary Runtime.call boundary revised by approved preregistration, no capacity decision' },
  serviceBoundary_p95: null,
  serviceBoundaryStatus: 'not obtained: private queueCore/coreCall entry-to-receipt spans have no exact exposed timing hook; bridge excludes upstream queue and API-e2e is a wider boundary; candidate-pending is not backend settlement',
  environment: { node: { version: process.version, executable: process.execPath }, python: null,
    os: { platform: os.platform(), version: os.version(), release: os.release(), arch: os.arch() },
    cpu: { models: [...new Set(os.cpus().map(cpu => cpu.model))], logicalCores: os.cpus().length },
    memory: { totalBytes: os.totalmem(), freeBytesAtStart: os.freemem() }, filesystems: null },
  cacheState: 'OS caches were not cleared; seed/package copying warms caches; only application warmup is excluded, not an OS cold-cache claim',
  scope: 'opaque software fixture; fake Host/session/scripted model, real services/queues/runtime/file IPC/Core',
  logicalParticipants: 5, workerRuns: 4, main: 1,
  verifierAuthority: 'report only; four logical verifier sessions, not additional Core callers',
  seed: '1000 content-addressed FactGraph.add records; canonical UTF-8 6144 bytes each; bypasses verifier and is not mathematical evidence',
  cadence: 'at least 1000ms after previous completion both for scripted caller operations and actual Core bridge lane; bridge pacing shared across instances',
  plan: { warmup: 'independent dataRoot/project/fakeSDK with 1000 same-shape seed facts; one fact_search per worker and main; cold five-party barrier; close all warmup services before creating measured project; all warmup excluded',
    workerMeasured: ['fact_search limit 1', 'gm_add plan', 'prepare_submission', 'independent scripted verifier report (no Core)', 'fact_submit', 'canonical fact_get readback'],
    mainMeasured: ['fact_search limit 1', 'gm_add plan concurrently with workers', 'after worker settlement: full stable pagination limit 64', 'four canonical candidate reads'],
    retries: 0, mutationSamples: { workerGm: 4, mainGm: 1, candidates: 4 },
    expectedCoreMeasured: { fact_search: 5, gm_add: 5, prepare_submission: 4, fact_submit: 4, fact_get: 8, fact_list_page: 16 },
    note: 'exact observed samples separately reported; setup and cleanup operations excluded; expected counts checked, not assumed',
  },
  timingLimitations: ['bridge-call timing excludes upstream Node queue residence; tool-e2e timing includes queues but is not pure Core time',
    'fork/startup/import/entry validation/file IPC and observer overhead are not independently separated',
    'process wall duration is a combined process+entry+IPC observation, never lock hold',
    'lock hold is measured only after successful flock EX until successful os.close of that target descriptor',
    'IPC peaks are periodic logical-byte and reconstructed reservation samples, not true high-water or Host reservation measurements'],
  hostRuntimeGlobalReservedBytes: null, hostReservationStatus: 'not obtained: no real Host/runtimeGlobal API in software fixture',
};
let fixture, phase = 'setup', closing = false, sampler, sampling = Promise.resolve(), samplerError;
let project, seed, failure, originalFailure, cleanup, window, warmupInfo, measurementBaseline;
let normalPathComplete = false;
const orchestrationSecondary = [], observationJobs = [];
let observationStopped = false;
const measurementBarrier = createBarrier(5), measurementMonitor = createRunMonitor(measurementBarrier);
const measurementDiagnostics = {};
const arriveCold = () => deadline(measurementBarrier.arrive(), 'five measured participants ready');
const { samples, wrapCore } = telemetry(() => phase);
const locks = [], processes = [], verifierEvents = [], toolSamples = [], ipc = [], pages = [], runs = [], candidateReadbacks = [];
const lastToolEnd = new Map();
const record = async (actor, operation, fn) => {
  const previousEnd = lastToolEnd.get(actor);
  await waitAfter(previousEnd);
  if (closing) throw projectedFailure({ code: 'M01_OBSERVATION_STOPPED' }, 'fixture-no-new-call-fence');
  const row = { layer: 'tool-e2e', classificationSource: 'api-call-not-ended', actor, operation, phase, requestId: null, started_ms: performance.now(), category: 'unknown' }; toolSamples.push(row);
  try { const reply = await fn(); row.category = 'success'; row.classificationSource = 'api-return-no-request-id'; return reply; }
  catch (error) {
    row.category = classification(error); row.classificationSource = 'api-public-error-fields-only';
    row.requestId = publicRequestId(error); row.busyTagged = hasBusyCode(error); row.code = error.code ?? null;
    row.error = errorRecord(error); throw error;
  }
  finally { row.ended_ms = performance.now(); row.duration_ms = row.ended_ms - row.started_ms; lastToolEnd.set(actor, row.ended_ms); }
};
async function sampleIpc(root = dataDir) { ipc.push({ phase, dataRoot: root, at_ms: performance.now(), ...await ipcSample(root) }); }
function startSampling(root) {
  assert.equal(sampler, undefined);
  sampler = setInterval(() => { sampling = sampling.then(() => sampleIpc(root)).catch(error => { samplerError ??= error; }); }, 50);
}
async function stopSampling() {
  if (sampler) clearInterval(sampler);
  sampler = undefined;
  await sampling;
}
async function graphFingerprint() {
  const directory = path.join(dataDir, 'context/projects', project.projectId, 'shared/fact_graph/facts');
  return Promise.all((await fs.readdir(directory)).sort().map(async name => [name, hash(await fs.readFile(path.join(directory, name)))]));
}
async function settled(runId, service = fixture.research, projectId = project.projectId, isStopped = () => observationStopped) {
  const end = performance.now() + 180000;
  while (performance.now() < end) {
    if (isStopped()) throw projectedFailure({ code: 'M01_SETTLEMENT_OBSERVER_STOPPED' }, 'fixture-status-observer-only');
    const status = await service.projectWorkerStatus(projectId, runId);
    if (status.coordinatorActive === false) {
      for (const key of ['cleanupPending', 'runtimeCleanupPending', 'indeterminate', 'finalizing', 'coreTaskCreatePending', 'coreTaskSettlementPending', 'recoveryUnsettled']) assert.equal(status[key], false, key);
      assert.equal(status.candidateSettlement, null); assert.equal(status.state, 'finished');
      return status;
    }
    await sleep(25);
  }
  throw new Error('coordinator settlement deadline');
}
async function admitRuns(target, p) {
  const jobs = [];
  // Project control admission is intentionally serialized, not the Core load.
  // All four runs are admitted before ANY scheduled worker is dispatched.
  for (let i = 1; i <= 4; i++) jobs.push(good(await target.tool('math_project', {
    action: 'start', projectId: p.projectId, workerId: `worker-${i}`, timeoutSeconds: 120,
  }, p.ctx)));
  await target.watchRuns(jobs); // Register exact session-root task IDs and check existing terminal states BEFORE dispatch.
  return jobs;
}
async function seedProject(python, root, projectId) {
  const result = await execute(python, ['-I', '-S', '-B', path.join(here, 'seed.py'), packageRoot, root, projectId], { cwd: scratch, env, timeout: 120000, maxBuffer: 2 << 20 });
  const value = JSON.parse(result.stdout);
  assert.equal(value.count, 1000); assert.equal(value.canonicalUTF8Bytes, 6144000); assert.equal(value.verified, false);
  return value;
}
async function runWarmup(python, runtimeStart) {
  const barrier = createBarrier(5), monitor = createRunMonitor(barrier);
  let target, warmupClosing = false, warmupFailure;
  const settlementDiagnostics = [], secondary = [];
  warmupInfo = { dataRoot: warmupDataDir, projectId: null, startedAt: new Date().toISOString(), endedAt: null, window: null, cleanup: null, diagnostics: {} };
  const arrive = () => deadline(barrier.arrive(), 'five isolated warmup participants');
  try {
    phase = 'warmup-setup'; await fs.mkdir(warmupDataDir);
    target = await createFixture({ dataDir: warmupDataDir, packageRoot, runtimeStart, wrapCore, monitor, diagnostics: warmupInfo.diagnostics,
      verifierEvent: () => assert.fail('warmup must not create a verifier'),
      workerTurn: async (session, invoke) => {
        if (session.turn !== 1 || warmupClosing || session.aborted) return;
        const workerId = session.cwd.match(/\/workers\/(worker-[1-4])(?:\/|$)/)?.[1]; assert.ok(workerId);
        await arrive(); await deadline(barrier.released, 'warmup measurement release');
        if (warmupClosing || session.aborted) return;
        await record(`worker:${workerId}`, 'fact_search', async () => good(await invoke('fact_search', { query: 'opaque software seed', limit: 1 }, session.context)));
      },
    });
    const p = await target.create(); warmupInfo.projectId = p.projectId;
    warmupInfo.seed = await seedProject(python, warmupDataDir, p.projectId);
    startSampling(warmupDataDir);
    const jobs = await admitRuns(target, p);
    for (const job of jobs) await target.dispatch(row => row.payload?.runId === job.runId);
    await target.snapshotRuns('before-warmup-ready-barrier');
    await arrive(); phase = 'warmup'; warmupInfo.window = { start_ms: performance.now(), end_ms: null }; barrier.release();
    const activeTarget = target;
    const work = (async () => {
      await record('main:saved-main', 'fact_search', async () => good(await activeTarget.tool('fact_search', { query: 'opaque software seed', limit: 1 }, p.ctx)));
      const watchers = jobs.map(job => settled(job.runId, activeTarget.research, p.projectId, () => warmupClosing));
      observationJobs.push(...watchers);
      await Promise.all(watchers);
    })();
    observationJobs.push(work);
    await raceParticipant(work, monitor, settlementDiagnostics);
    warmupInfo.window.end_ms = performance.now(); phase = 'warmup-cleanup';
    warmupInfo.cleanup = await target.close();
    const warmupTarget = target; target = undefined;
    if (!combineOutcome(null, [warmupInfo.cleanup]).completed) throw warmupTarget.errors[0]
      ?? projectedFailure(warmupInfo.cleanup, 'warmup-disposal', 'M01_DISPOSAL_INCOMPLETE');
    warmupInfo.finalIpc = await ipcSample(warmupDataDir);
    assert.equal(warmupInfo.finalIpc.incompleteCalls, 0);
    const observed = samples.filter(s => s.binding.projectId === p.projectId && s.phase === 'warmup');
    assert.equal(observed.length, 5); assert.ok(observed.every(s => s.operation === 'fact_search' && s.category === 'success'));
    warmupInfo.coreCalls = observed.length; warmupInfo.actors = [...new Set(observed.map(s => s.actor))];
    warmupInfo.actorCount = warmupInfo.actors.length;
    warmupInfo.observerRecords = locks.filter(row => row.phase === 'warmup').length;
    assert.equal(warmupInfo.actorCount, 5);
  } catch (error) {
    warmupFailure = selectPrimaryFailure(monitor, error, secondary);
    warmupClosing = true; closing = true;
    barrier.fail(warmupFailure); warmupInfo.failure = errorRecord(warmupFailure);
    warmupInfo.participantFailure = monitor.firstFailure ? { ...monitor.firstFailure, error: errorRecord(monitor.firstFailure.error) } : null;
    if (target) await target.snapshotRuns('warmup-catch-before-dispose');
    warmupFailure = selectPrimaryFailure(monitor, warmupFailure, secondary);
    warmupInfo.failure = errorRecord(warmupFailure);
    throw warmupFailure;
  } finally {
    warmupInfo.settlementDiagnostics = settlementDiagnostics; warmupInfo.secondary = secondary;
    warmupClosing = true; phase = 'warmup-cleanup'; monitor.stop();
    // Abort any remaining waiter. Never resolve a failed gate during cleanup.
    barrier.fail(warmupFailure ?? projectedFailure({ code: 'M01_CLEANUP_ABORT' }, 'warmup-cleanup-only'));
    try {
      if (target) warmupInfo.cleanup = await target.close();
      await stopSampling(); await sampleIpc(warmupDataDir);
    } catch (error) {
      (warmupInfo.diagnostics.cleanupErrors ??= []).push(errorRecord(error));
      if (!warmupFailure) throw error; // Preserve the original failure otherwise.
    } finally { warmupInfo.endedAt = new Date().toISOString(); }
  }
}
try {
  const sourceFiles = ['packages/hana-math/project-service.mjs', 'packages/hana-math/research-service.mjs',
    'packages/hana-math/project-core-access.mjs', 'packages/hana-math/research-sessions.mjs',
    'packages/hana-math/context-service.mjs', 'packages/hana-math/research-bindings.mjs',
    'packages/hana-math/runtime/research-runtime.mjs', 'packages/hana-math/runtime/research_entry.py',
    'engine/src/hana_math_engine/research.py', 'engine/src/danus/core/factgraph.py', 'engine/src/danus/core/schema.py',
    ...['driver.mjs', 'host.mjs', 'metrics.mjs', 'gates.mjs', 'observations.mjs', 'contract-check.mjs', 'observer.py', 'seed.py'].map(name => `scripts/fixtures/m01-capacity/${name}`)];
  manifest.sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await fs.readFile(path.join(repo, file)))])));
  manifest.gitHead = (await execute('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo, env })).stdout.trim();
  manifest.environment.filesystems = await Promise.all([repo, scratch].map(async directory => {
    const raw = await fs.statfs(directory, { bigint: true });
    return { path: directory, raw: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)])),
      typeInterpretation: 'raw statfs numeric type only; no filesystem name inferred' };
  }));
  // Copy packaged standalone Python + its descriptors only. Use current, official
  // app references/entry and engine in a relocated package, not modified engines.
  await fs.cp(path.join(repo, 'packages/hana-math'), packageRoot, { recursive: true, dereference: true });
  await fs.cp(path.join(stage, 'dependencies'), path.join(packageRoot, 'dependencies'), { recursive: true, dereference: true });
  await fs.cp(path.join(repo, 'engine/src'), path.join(packageRoot, 'engine/src'), { recursive: true, filter: file => !file.includes('__pycache__') && !file.endsWith('.pyc') });
  const python = path.join(packageRoot, 'dependencies/python/bin/python3');
  const pythonVersion = await execute(python, ['--version'], { cwd: scratch, env, timeout: 10000, maxBuffer: 65536 });
  manifest.environment.python = { executable: python, versionQuery: '--version', stdout: pythonVersion.stdout.trim(), stderr: pythonVersion.stderr.trim() };
  const runtimeStart = async (input, request) => {
    assert.notEqual(request.context.role, 'verifier', 'verifier has no Core authority in this rehearsal');
    const sample = samples.findLast(s => s.ended_ms === undefined && s.operation === request.operation && s.binding.runId === request.context.runId && s.actor === actorOf(request.context));
    assert.ok(sample, 'every actual runtime request must trace to the real bridge call'); sample.requestId = request.requestId;
    const started = performance.now(); let stderr = '';
    try {
      const result = await execute(input.command, ['-I', '-S', '-B', path.join(here, 'observer.py'), ...input.args.slice(3)], { cwd: input.cwd, env, timeout: 20000, maxBuffer: 4 << 20 });
      stderr = result.stderr;
    } catch (error) { stderr = error.stderr ?? ''; throw error; }
    finally {
      const lines = stderr.split('\n').filter(Boolean), metricLines = lines.filter(line => line.startsWith('M01_METRIC '));
      for (const line of metricLines) locks.push({ ...JSON.parse(line.slice(11)), actor: sample.actor, operation: request.operation, phase: sample.phase });
      processes.push({ requestId: request.requestId, actor: sample.actor, operation: request.operation, phase: sample.phase,
        processEntryIpcCombined_ms: performance.now() - started, fork_ms: null, import_ms: null, ipc_ms: null,
        instrumentation: 'runpy official relocated entry; original fcntl.flock and os.close called', stderr: lines.filter(line => !line.startsWith('M01_METRIC ')) });
    }
  };
  await runWarmup(python, runtimeStart);
  if (samplerError) throw samplerError;
  assert.equal(warmupInfo.cleanup.disposed, true);
  assert.notEqual(warmupDataDir, dataDir);
  phase = 'measurement-setup';
  await fs.mkdir(dataDir);
  manifest.measurement = { dataRoot: dataDir, projectId: null, setupStartedAt: new Date().toISOString(), setupStartedAfterWarmupClosed: true };
  fixture = await createFixture({ dataDir, packageRoot, runtimeStart, wrapCore, monitor: measurementMonitor, diagnostics: measurementDiagnostics,
    verifierEvent: row => verifierEvents.push({ ...row, phase }),
    workerTurn: async (session, invoke) => {
      if (session.turn !== 1 || closing || session.aborted) return;
      const workerId = session.cwd.match(/\/workers\/(worker-[1-4])(?:\/|$)/)?.[1]; assert.ok(workerId, 'actual assigned workspace must name the worker');
      const actor = `worker:${workerId}`;
      await arriveCold(); await deadline(measurementBarrier.released, 'measurement release after IPC baseline');
      if (closing || session.aborted) return;
      await record(actor, 'fact_search', async () => good(await invoke('fact_search', { query: 'opaque software seed', limit: 1 }, session.context)));
      await record(actor, 'gm_add', async () => good(await invoke('gm_add', { kind: 'plan', claim: `opaque software rehearsal ${workerId}; not mathematical evidence` }, session.context)));
      const reply = await record(actor, 'candidate-submit-pending', async () => good(await invoke('fact_submit', {
        statement: `opaque software candidate from ${workerId}`, proof: 'opaque software proof payload with several distinct tokens only, not mathematical evidence', predecessors: [], glossary_introduces: {},
      }, session.context)));
      assert.equal(reply.pending, true); assert.equal(reply.accepted, false);
    },
  });
  project = await fixture.create(); assert.notEqual(project.projectId, warmupInfo.projectId);
  manifest.measurement.projectId = project.projectId;
  seed = await seedProject(python, dataDir, project.projectId);
  startSampling(dataDir);
  const jobs = await admitRuns(fixture, project);
  for (const job of jobs) await fixture.dispatch(row => row.payload?.runId === job.runId);
  await fixture.snapshotRuns('before-measurement-ready-barrier');
  await arriveCold();
  // Actual observation BEFORE the measurement window/release. No warmup shares
  // this root, and no measured IPC files are deleted to lower the baseline.
  measurementBaseline = { dataRoot: dataDir, at_ms: performance.now(), ...await ipcSample(dataDir) };
  phase = 'measurement'; window = { start_ms: performance.now(), end_ms: null }; measurementBarrier.release();
  const activeFixture = fixture;
  const work = (async () => {
    await record('main:saved-main', 'fact_search', async () => good(await activeFixture.tool('fact_search', { query: 'opaque software seed', limit: 1 }, project.ctx)));
    await record('main:saved-main', 'gm_add', async () => good(await activeFixture.tool('gm_add', { kind: 'plan', claim: 'opaque software main rehearsal note' }, project.ctx)));
    const watchers = jobs.map(job => settled(job.runId, activeFixture.research, project.projectId));
    observationJobs.push(...watchers);
    const statuses = await Promise.all(watchers);
    runs.push(...statuses);
  })();
  observationJobs.push(work);
  await raceParticipant(work, measurementMonitor, orchestrationSecondary);
  assert.equal(verifierEvents.length, 4);
  const accepted = runs.flatMap(run => run.verifiedFactIds); assert.equal(accepted.length, 4); assert.equal(new Set(accepted).size, 4);
  const fingerprint = await graphFingerprint(); assert.equal(fingerprint.length, 1004);
  // No candidate writes after settlement: now paginate ONE stable graph observation.
  let cursor, asOf, start = 0; const ids = [];
  do {
    const response = await record('main:saved-main', 'fact_list_page', async () => good(await fixture.tool('math_project', { action: 'result', projectId: project.projectId, limit: 64, ...(cursor ? { cursor } : {}) }, project.ctx)));
    const page = response.page;
    assert.equal(page.startIndex, start); assert.equal(page.total, 1004);
    asOf ??= page.asOf; assert.equal(page.asOf, asOf);
    pages.push({ cursor: cursor ?? null, nextCursor: page.nextCursor, startIndex: page.startIndex, asOf: page.asOf, returned: page.returned });
    ids.push(...response.facts.map(row => row.fact_id)); start += page.returned;
    assert.equal(page.returned, response.facts.length);
    if (page.hasMore) { assert.ok(page.nextCursor); assert.notEqual(page.nextCursor, cursor); }
    else assert.equal(page.nextCursor, null);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 1004); assert.equal(new Set(ids).size, 1004); assert.deepEqual(await graphFingerprint(), fingerprint);
  for (const factId of accepted) {
    // Use the public service result API with the bound main context: still the
    // real ProjectService queueCore path, without a fake Host attachment export.
    const result = await record('main:saved-main', 'fact_get', () => fixture.project.result({ projectId: project.projectId, factId }, project.ctx));
    const canonical = result.fact;
    assert.equal(canonical.fact_id, factId); assert.equal(typeof canonical.markdown, 'string');
    candidateReadbacks.push({ fact_id: factId, canonicalBytes: Buffer.byteLength(canonical.markdown), sha256: hash(canonical.markdown) });
  }
  for (const run of runs) {
    const calls = fixture.calls.core.filter(row => row.request.context.runId === run.runId);
    for (const operation of ['prepare_submission', 'fact_submit', 'fact_get']) assert.equal(calls.filter(row => row.request.operation === operation).length, 1, `${operation}: no automatic candidate replay`);
  }
  window.end_ms = performance.now(); phase = 'cleanup'; closing = true;
  const beforeStop = fixture.calls.core.length;
  good(await fixture.tool('math_project', { action: 'stop', projectId: project.projectId, force: true }, project.ctx));
  cleanup = await fixture.close();
  const measuredTarget = fixture; fixture = undefined;
  if (!combineOutcome(null, [cleanup]).completed) throw measuredTarget.errors[0]
    ?? projectedFailure(cleanup, 'measurement-disposal', 'M01_DISPOSAL_INCOMPLETE');
  assert.equal(samples.filter(row => row.phase === 'cleanup').length, 0, 'stop/dispose must not dispatch new Core writes or reads');
  assert.deepEqual(await graphFingerprint(), fingerprint);
  cleanup.coreCallsBeforeStop = beforeStop; cleanup.graphUnchanged = true;
  cleanup.finalIpc = await ipcSample(dataDir);
  assert.equal(cleanup.finalIpc.incompleteCalls, 0, 'normal-path runtime disposal must leave completed IPC accounting markers');
  const observed = Object.fromEntries(Object.keys(manifest.plan.expectedCoreMeasured).map(operation => [operation, samples.filter(s => s.phase === 'measurement' && s.operation === operation).length]));
  assert.deepEqual(observed, manifest.plan.expectedCoreMeasured, 'observed sample counts must equal the explicit plan');
  manifest.observedCoreMeasured = observed;
  assert.equal(new Set(samples.map(s => s.actor)).size, 5, 'four worker lanes + main, never nine independent Core callers');
  for (const actor of new Set(samples.map(s => s.actor))) {
    const lane = samples.filter(s => s.actor === actor);
    for (let i = 1; i < lane.length; i++) assert.ok(lane[i].started_ms - lane[i - 1].ended_ms >= 1000, 'completion-based normal Core cadence');
  }
  for (const actor of new Set(toolSamples.map(s => s.actor))) {
    const lane = toolSamples.filter(s => s.actor === actor);
    for (let i = 1; i < lane.length; i++) assert.ok(lane[i].started_ms - lane[i - 1].ended_ms >= 1000, 'completion-based caller cadence');
  }
  assert.equal(locks.length, processes.length, 'every Python runtime request must emit one observer record');
  for (const metric of locks) {
    assert.notEqual(metric.firstAttemptNs, null);
    assert.notEqual(metric.acquiredNs, null, 'normal-path success needs actual acquisition, not a fabricated zero hold');
    assert.notEqual(metric.releasedNs, null);
  }
  normalPathComplete = true;
} catch (error) {
  originalFailure = selectPrimaryFailure(measurementMonitor, error, orchestrationSecondary);
  observationStopped = true; closing = true;
  measurementBarrier.fail(originalFailure); failure = errorRecord(originalFailure);
  if (fixture) await fixture.snapshotRuns('measurement-catch-before-dispose');
  process.exitCode = 1;
} finally {
  const measurementRightCensored = Boolean(window && window.end_ms === null);
  const observedWindow = window ? { start_ms: window.start_ms, end_ms: window.end_ms ?? performance.now() } : null;
  // A fatal may arrive while the catch snapshot is awaited. Resolve identity/
  // stage priority once more BEFORE disabling participant notifications.
  if (measurementMonitor.firstFailure) originalFailure = selectPrimaryFailure(measurementMonitor, originalFailure, orchestrationSecondary);
  observationStopped = true; closing = true; phase = 'cleanup'; measurementMonitor.stop();
  measurementBarrier.fail(originalFailure ?? projectedFailure({ code: 'M01_CLEANUP_ABORT' }, 'measurement-cleanup-only'));
  const closingServices = fixture?.close(); // Admission closes; aborting gates cannot manufacture success.
  if (closingServices) try { cleanup = await closingServices; } catch (error) {
    cleanup = { error: error.message }; (measurementDiagnostics.cleanupErrors ??= []).push(errorRecord(error));
    originalFailure ??= error; failure ??= errorRecord(error); process.exitCode = 1;
  }
  // Reap every abandoned orchestration promise after disposal. Only status/script
  // observers stop; already-started Runtime/Core calls keep their production cleanup.
  let observationReap;
  try {
    const results = await deadline(Promise.allSettled(observationJobs), 'settlement observers reaped', 30000);
    observationReap = { completed: true, total: results.length, fulfilled: results.filter(row => row.status === 'fulfilled').length,
      rejected: results.filter(row => row.status === 'rejected').map(row => errorRecord(row.reason)) };
  } catch (error) { observationReap = { completed: false, error: errorRecord(error) }; process.exitCode = 1; }
  await stopSampling();
  try { await sampleIpc(); } catch (error) { samplerError ??= error; }
  if (samplerError) { originalFailure ??= samplerError; failure ??= errorRecord(samplerError); process.exitCode = 1; }
  try { manifest.gitHeadAtEnd = (await execute('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo, env })).stdout.trim(); }
  catch (error) { originalFailure ??= error; failure ??= errorRecord(error); process.exitCode = 1; }
  manifest.endedAt = new Date().toISOString();
  manifest.warmup = warmupInfo ?? null;
  if (manifest.measurement) manifest.measurement.window = observedWindow;
  const measuredIpcSamples = ipc.filter(s => s.phase === 'measurement' && s.dataRoot === dataDir);
  const logicalPeak = measuredIpcSamples.length ? Math.max(...measuredIpcSamples.map(s => s.logicalBytes)) : null;
  const reconstructedPeak = measuredIpcSamples.length ? Math.max(...measuredIpcSamples.map(s => s.reconstructedBytes)) : null;
  const allMeasured = samples.filter(row => row.phase === 'measurement' && Number.isFinite(row.ended_ms)
    && observedWindow && row.ended_ms <= observedWindow.end_ms);
  const triggered = Object.fromEntries(['busy', 'known-refusal', 'unknown'].map(category => [category, allMeasured.filter(s => s.category === category).length]));
  const operationSummary = observedWindow ? summaries(samples, locks, observedWindow) : [];
  const actorSummary = observedWindow ? summaries(samples, locks, observedWindow, 'actor') : [];
  const toolEndToEndOperationSummary = observedWindow ? summaries(toolSamples, [], observedWindow) : [];
  const toolEndToEndActorSummary = observedWindow ? summaries(toolSamples, [], observedWindow, 'actor') : [];
  const primaryMetric = primaryBridgeMetric(samples, observedWindow, { rightCensored: measurementRightCensored });
  const expectedActors = [`main:${project?.main?.agentId ?? 'saved-main'}`, ...[1, 2, 3, 4].map(i => `worker:worker-${i}`)];
  const validationFailures = validatePrimaryBridgeMetric(primaryMetric, expectedActors);
  manifest.primaryBridgeMetric = primaryMetric;
  manifest.primaryBridgeValidation = { expectedActors, failures: validationFailures };
  const outcome = combineOutcome(originalFailure ?? null, [warmupInfo?.cleanup, cleanup].filter(Boolean), normalPathComplete);
  // Additional observation gates never replace the original primary Error.
  const completed = outcome.completed && validationFailures.length === 0;
  if (!completed || !observationReap.completed) process.exitCode = 1;
  outcome.cleanup.secondary.push(...orchestrationSecondary.filter(row => row.kind !== 'settlement-work-fulfilled'));
  if (!observationReap.completed) outcome.cleanup.secondary.push({ kind: 'observer-reap-failure', observationReap });
  const result = { manifest, protocolRevision: PROTOCOL_REVISION, primaryBridgeMetric: primaryMetric, validationFailures,
    mainApiCompanions: mainApiCompanions(operationSummary, toolEndToEndOperationSummary),
    completed: completed && observationReap.completed, failure: outcome.failure, cleanup: outcome.cleanup,
    observationReap, participantFailure: measurementMonitor.firstFailure ? { ...measurementMonitor.firstFailure, error: errorRecord(measurementMonitor.firstFailure.error) } : null,
    layerCounts: { bridge: windowCounts(samples, observedWindow), api: windowCounts(toolSamples, observedWindow) },
    requestAssociations: correlateRequests(samples, toolSamples),
    seed, warmup: warmupInfo ?? null, diagnostics: measurementDiagnostics, window: observedWindow, serviceBoundary_p95: null,
    serviceBoundaryStatus: manifest.serviceBoundaryStatus,
    samples, toolSamples, lockMetrics: locks, processes, verifierEvents, pages,
    candidateReadbacks, workerRunStatuses: runs,
    lockObservationCoverage: { runtimeRequests: processes.length, observerRecords: locks.length,
      missingRequestIds: processes.filter(p => !locks.some(m => m.requestId === p.requestId)).map(p => p.requestId) },
    actorSummary, operationSummary, summary: operationSummary,
    toolEndToEndActorSummary, toolEndToEndOperationSummary, toolEndToEndSummary: toolEndToEndOperationSummary,
    actualCoreCallers: [...new Set(samples.filter(s => s.phase === 'measurement').map(s => s.actor))],
    actualCoreBindings: samples.filter(s => s.phase === 'measurement').map(s => s.binding),
    dynamicClassifications: triggered, dynamicClassificationsScope: 'bridge calls ended within window only; layerCounts separately includes after-window outcomes',
    untriggeredWithinWindow: Object.entries(triggered).filter(([, n]) => n === 0).map(([key]) => key),
    untriggered: [...['busy', 'known-refusal', 'unknown'].filter(kind => !samples.some(row => row.phase === 'measurement' && Number.isFinite(row.ended_ms) && row.category === kind)), 'cancellation fault injection'],
    hardGatesFullyExercised: false,
    ipc: { sampleInterval_ms: 50, samples: ipc, warmupDataRoot: warmupDataDir, measurementDataRoot: dataDir,
      measurementBaseline: measurementBaseline ?? null, measurementSamples: measuredIpcSamples.length,
      logicalBytesSampledPeak: logicalPeak, reconstructedAccountingBytesSampledPeak: reconstructedPeak,
      logicalBytesSampledPeakDelta: logicalPeak !== null && measurementBaseline ? logicalPeak - measurementBaseline.logicalBytes : null,
      reconstructedAccountingBytesSampledPeakDelta: reconstructedPeak !== null && measurementBaseline ? reconstructedPeak - measurementBaseline.reconstructedBytes : null,
      deltaDefinition: 'sampled absolute peak minus observed pre-release baseline; signed difference, null without baseline/measurement samples; no files removed to reset accounting',
      hostRuntimeGlobalReservedBytes: null, hostReservedStatus: 'not obtained', measurement: 'measurement-root samples only for peaks; incomplete directory charged max(actual, 2MiB), valid .complete charged actual' },
  };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  await fs.rm(scratch, { recursive: true, force: true });
  console.log(JSON.stringify({ output, completed: result.completed, evidenceEligible: false, capacityDecision: 'not-evaluated', failure: result.failure }));
}
