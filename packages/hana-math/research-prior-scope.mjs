import { contextId } from './context-service.mjs';

const MAX_HISTORY = 4096;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unconfirmed = () => Object.assign(new Error('PROJECT_HISTORY_UNCONFIRMED'), { code: 'PROJECT_HISTORY_UNCONFIRMED' });
function requireProof(value) { if (!value) throw unconfirmed(); }

// Corroborate the authorized Project reference set with its persisted start
// records and the independent worker locator. No global history enumeration.
export async function readPriorProjectScope(store, projectId, expected, guard) {
  requireProof(Array.isArray(expected) && expected.length <= MAX_HISTORY);
  const supplied = new Map();
  for (const ref of expected) {
    requireProof(record(ref) && Object.keys(ref).length === 2 && Object.hasOwn(ref, 'workerId') && Object.hasOwn(ref, 'runId'));
    contextId(ref.workerId); contextId(ref.runId);
    requireProof(!supplied.has(ref.runId)); supplied.set(ref.runId, ref.workerId);
  }
  const location = `research/projects/${projectId}/project.json`;
  const project = await store.readJson(location); guard();
  requireProof(project?.schemaVersion === 1 && project.projectId === projectId
    && (project.extraWorkers === undefined || Array.isArray(project.extraWorkers) && project.extraWorkers.length <= 3));
  const refs = new Map();
  for (const [i, worker] of [project.worker, ...(project.extraWorkers ?? [])].entries()) {
    const workerId = `worker-${i + 1}`;
    requireProof(worker?.workerId === workerId && record(worker.start) && Array.isArray(worker.runs)
      && refs.size + worker.runs.length <= MAX_HISTORY);
    if (worker.runs.length === 0) {
      requireProof(worker.lastRun === null && worker.start.state === 'idle' && worker.start.runId == null);
    } else {
      requireProof(['started', 'settled'].includes(worker.start.state) && worker.start.runId === worker.lastRun
        && worker.runs.at(-1) === worker.lastRun);
    }
    for (const runId of worker.runs) {
      contextId(runId); requireProof(!refs.has(runId)); refs.set(runId, workerId);
    }
    let locator;
    try { locator = await store.readJson(`context/projects/${projectId}/workers/${workerId}/run-ref.json`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    guard();
    requireProof(worker.lastRun === null ? locator === undefined : record(locator) && Object.keys(locator).length === 4
      && locator.schemaVersion === 1 && locator.projectId === projectId && locator.workerId === workerId && locator.runId === worker.lastRun);
  }
  requireProof(supplied.size === refs.size && [...refs].every(([runId, workerId]) => supplied.get(runId) === workerId));
  return refs;
}
