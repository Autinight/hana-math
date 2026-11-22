// On-demand read-only orchestration. No lifecycle, bindings, Core or persistence APIs.
import { readResearchSessionInfo } from './research-session-info.mjs';
import { performance } from 'node:perf_hooks';
import { READ_EVIDENCE_LIMITS, data, plainEvidence, evidenceId, sha256, candidatePredecessors, readEvidenceDTO, parseVerificationReads, evidenceFailure, evidenceFailureInfo } from './verification-read-evidence.mjs';
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const agentId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v);
const failure = evidenceFailure;
function check(ok, reason = 'LINKAGE_UNAVAILABLE') { if (!ok) throw failure(reason); }
function sanitized(error, fallback) {
  const code = data(error, 'code');
  const safe = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : fallback;
  return Object.assign(new Error(safe), { code: safe });
}
const accessFailures = new WeakMap();
class AccessFailure extends Error { constructor(cause) { super('Verification read authorization failed'); accessFailures.set(this, cause); } }
/** One ten-second budget, not cancellation of Host materialization. Guards late continuations. */
export function verificationReadBudget() {
  const expires = performance.now() + 10000; let expired = false;
  const guard = () => { if (expired || performance.now() >= expires) { expired = true; throw failure('READ_TIMEOUT'); } };
  return { guard, async step(operation) {
    guard(); let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => { guard(); return operation(); }).then(value => { guard(); return value; }),
        new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(failure('READ_TIMEOUT')); }, Math.max(1, expires - performance.now())); })]);
    } finally { clearTimeout(timer); }
  } };
}
function selection(meta, role) {
  const value = meta.selections?.[role];
  check(plainEvidence(value) && value.role === role && value.source === 'saved-role' && agentId(value.agentId)
    && plainEvidence(value.model) && typeof value.model.id === 'string' && typeof value.model.provider === 'string');
  return { role, agentId: value.agentId, model: { id: value.model.id, provider: value.model.provider } };
}
/** Select only linkage fields. Never copy a run or read worker history/private memory. */
function linkage(meta, ids, absolute) {
  check(plainEvidence(meta) && meta.schemaVersion === 1 && meta.mode === 'project-worker'
    && meta.projectId === ids.projectId && meta.runId === ids.runId && meta.workerId === ids.workerId);
  check(Array.isArray(meta.submissions) && meta.submissions.length <= READ_EVIDENCE_LIMITS.entries
    && Array.isArray(meta.sessions) && meta.sessions.length <= READ_EVIDENCE_LIMITS.entries);
  const subs = meta.submissions.filter(s => s?.submissionId === ids.submissionId); check(subs.length === 1);
  const sub = subs[0], candidateFile = `research/runs/${ids.runId}/submissions/${ids.submissionId}/candidate.json`;
  check(sub.candidateFile === candidateFile && evidenceId(sub.workerSessionId), 'CANDIDATE_LINKAGE_INVALID');
  const worker = selection(meta, 'worker'), verifier = selection(meta, 'verifier');
  const matching = meta.sessions.filter(e => e?.role === 'verifier' && e.submissionId === ids.submissionId); check(matching.length === 1);
  const entry = matching[0], sid = entry.sessionId;
  const cwd = absolute(`context/projects/${ids.projectId}/research/${ids.runId}/verifiers/${ids.submissionId}`);
  check(evidenceId(sid) && meta.sessions.filter(e => e?.sessionId === sid).length === 1 && entry.agentId === verifier.agentId && entry.cwd === cwd
    && typeof entry.kind === 'string' && new RegExp(`^math-research:${ids.runId}:\\d+$`).test(entry.kind)
    && typeof entry.sessionPath === 'string' && entry.sessionPath.length > 0 && entry.sessionPath.length <= 4096);
  check(entry.state === 'completed' && entry.active === false && entry.cleanupPending === false && entry.finalizing === false
    && entry.setupPending === false && entry.sendPending === false && entry.sendState === 'accepted' && entry.modelStopReason === 'stop'
    && (entry.error == null) && entry.updateFailed !== true, 'VERIFIER_NOT_CLEAN_COMPLETED');
  function bound(e, role, selected, expectedCwd) {
    const b = e.binding;
    check(plainEvidence(b) && b.projectId === ids.projectId && b.runId === ids.runId && b.role === role && b.author === selected.agentId
      && b.agentId === selected.agentId && e.agentId === selected.agentId && b.sessionId === e.sessionId
      && b.sessionPath === e.sessionPath && b.cwd === expectedCwd && e.cwd === expectedCwd
      && (role === 'verifier' ? b.submissionId === ids.submissionId && !Object.hasOwn(b, 'workerId') : b.workerId === ids.workerId));
    return { role, agentId: b.agentId, author: b.author, sessionId: b.sessionId, sessionPath: b.sessionPath, cwd: b.cwd,
      ...(role === 'worker' ? { workerId: b.workerId } : { submissionId: b.submissionId }) };
  }
  const verifierBinding = bound(entry, 'verifier', verifier, cwd);
  const workers = meta.sessions.filter(e => e?.sessionId === sub.workerSessionId); check(workers.length === 1 && workers[0].role === 'worker');
  const workerBinding = bound(workers[0], 'worker', worker, absolute(`context/projects/${ids.projectId}/workers/${ids.workerId}`));
  const projection = { candidateFile, worker, verifier, workerBinding, verifierBinding, sid, cwd, kind: entry.kind };
  return { ...projection, token: JSON.stringify(projection), workerAgentId: worker.agentId };
}
export async function auditVerificationReads(sdk, { identity, getMeta, store, recheck, budget = verificationReadBudget() }) {
  if (!identity || !['projectId', 'runId', 'submissionId', 'workerId'].every(k => typeof identity[k] === 'string' && SAFE_ID.test(identity[k]))
    || typeof getMeta !== 'function' || typeof recheck !== 'function') throw new TypeError('Trusted verification-read inputs required');
  const ids = { projectId: identity.projectId, runId: identity.runId, submissionId: identity.submissionId, workerId: identity.workerId };
  let captured, candidateHash;
  function sameLink() {
    budget.guard(); const now = linkage(getMeta(), ids, store.absolute);
    if (captured) check(now.token === captured.token, 'LINKAGE_CHANGED');
    return now;
  }
  async function access() {
    budget.guard();
    try { await budget.step(recheck); } catch (error) { if (evidenceFailureInfo(error).reason === 'READ_TIMEOUT') throw error; throw new AccessFailure(error); }
    budget.guard();
  }
  async function identityInfo() {
    // Guard the helper's internal get -> list continuation too: a late get must
    // not start another SDK operation after the outer budget has ended.
    const guarded = { sessions: Object.fromEntries(['get', 'list'].map(name => [name, async ref => {
      sameLink(); const value = await budget.step(() => sdk.sessions[name](ref)); sameLink(); return value;
    }])) };
    const info = await budget.step(() => readResearchSessionInfo(guarded, { sessionId: captured.sid }));
    sameLink();
    check(info.sessionId === captured.sid && info.ownerPluginId === 'hana-math' && info.namespace === 'app'
      && info.visibility === 'plugin_private' && info.agentId === captured.verifier.agentId && info.cwd === captured.cwd && info.kind === captured.kind, 'SESSION_IDENTITY_UNAVAILABLE');
    return info;
  }
  async function candidate() {
    sameLink(); const bytes = await budget.step(() => store.read(captured.candidateFile)); sameLink();
    check(Buffer.isBuffer(bytes) && bytes.length <= READ_EVIDENCE_LIMITS.candidateBytes, 'CANDIDATE_LIMIT');
    const digest = sha256(bytes);
    if (candidateHash) check(digest === candidateHash, 'CANDIDATE_CHANGED');
    candidateHash = digest;
    return candidatePredecessors(bytes, { ...ids, workerAgentId: captured.workerAgentId });
  }
  try {
    await access(); captured = sameLink();
    const predecessors = await candidate(); await access(); sameLink();
    const before = await identityInfo(); await access(); sameLink();
    if (!predecessors.length) {
      await candidate(); await access(); sameLink();
      return readEvidenceDTO(ids, 'not-needed', [], [], captured.sid);
    }
    if (typeof sdk.sessions?.entries !== 'function') throw failure('ENTRIES_UNSUPPORTED');
    await candidate(); await access(); sameLink();
    const response = await budget.step(() => sdk.sessions.entries({ sessionId: captured.sid, scope: 'own' }));
    await access(); sameLink();
    const after = await identityInfo();
    check(['sessionId', 'ownerPluginId', 'namespace', 'visibility', 'agentId', 'cwd', 'kind', 'path', 'lifecycle'].every(k => before[k] === after[k]), 'SESSION_IDENTITY_CHANGED');
    await candidate(); await access(); sameLink();
    check(data(response, 'sessionId') === captured.sid, 'ENTRIES_SESSION_MISMATCH');
    const paths = predecessors.map(p => store.absolute(`context/projects/${ids.projectId}/shared/fact_graph/facts/${p.factId}.md`));
    const result = parseVerificationReads(response, ids, predecessors, captured.cwd, paths, captured.sid);
    budget.guard(); sameLink(); return result;
  } catch (error) {
    if (accessFailures.has(error)) throw sanitized(accessFailures.get(error), 'VERIFICATION_READ_AUTHORITY_UNAVAILABLE');
    const code = data(error, 'code');
    if (data(error, 'kind') === 'permission' || typeof code === 'string' && /(?:DENIED|FORBIDDEN|UNAUTHORIZED)$/.test(code)) throw sanitized(error, 'VERIFICATION_READ_DENIED');
    if (evidenceFailureInfo(error).reason === 'READ_TIMEOUT') {
      // No late recheck/SDK operation and no verifier identity or evidence escapes.
      return readEvidenceDTO(ids, 'unavailable', ['READ_TIMEOUT']);
    }
    // Even unavailable evidence is not a way to suppress a lost project permission.
    try { await access(); } catch (lost) {
      if (accessFailures.has(lost)) throw sanitized(accessFailures.get(lost), 'VERIFICATION_READ_AUTHORITY_UNAVAILABLE');
      return readEvidenceDTO(ids, 'unavailable', ['READ_TIMEOUT']);
    }
    return readEvidenceDTO(ids, 'unavailable', [evidenceFailureInfo(error, 'HOST_OR_RECORD_UNAVAILABLE').reason]);
  }
}
