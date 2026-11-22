// Opaque contract fixtures only; no Host, storage, model or mathematical execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePlanMaterial } from '../packages/hana-math/paper-plan.mjs';
import { resolveReportKind, reportKindSpec, validReportStart, validReportPayload,
  reportTaskFields, matchesReportTaskFields } from '../packages/hana-math/project-report-kinds.mjs';

const projectId = 'project-fixture', reportId = 'report-01234567-89ab-cdef-0123-456789abcdef';
const paper = { paperId: 'main', target: { opaque: true }, brief: 'Opaque fixture', instructions: '' };
const audit = { sourceReportId: reportId, paperId: 'main', mainSha256: 'a'.repeat(64), ledgerSha256: 'b'.repeat(64),
  contractSha256: 'c'.repeat(64), boundContractSha256: 'c'.repeat(64), auditorPromptSha256: 'd'.repeat(64),
  boundAuditorPromptSha256: 'd'.repeat(64), promptSha256: 'e'.repeat(64), boundPromptSha256: 'e'.repeat(64) };
const paperValid = (value, id) => value?.paperId === 'main' && value?.target?.opaque === true && id === projectId;
const revision = { verificationReportId: 'report-11234567-89ab-cdef-0123-456789abcdef', sourceReportId: reportId, paperId: 'main',
  citationStatus: 'partial', sourceStatus: 'generated', mainSha256: 'a'.repeat(64), verdictsSha256: 'b'.repeat(64), ledgerSha256: 'c'.repeat(64),
  originalLedgerSha256: 'd'.repeat(64), provenanceSha256: 'e'.repeat(64), contractSha256: 'f'.repeat(64),
  reviserPromptSha256: '1'.repeat(64), styleSha256: '2'.repeat(64), promptSha256: '3'.repeat(64) };
const verification = { auditReportId: 'report-11234567-89ab-cdef-0123-456789abcdef', sourceReportId: reportId, paperId: 'main',
  mainSha256: 'a'.repeat(64), ledgerSha256: 'b'.repeat(64), auditSha256: 'f'.repeat(64), contractSha256: 'c'.repeat(64), boundContractSha256: 'c'.repeat(64),
  verifierPromptSha256: 'd'.repeat(64), boundVerifierPromptSha256: 'd'.repeat(64), promptSha256: 'e'.repeat(64), boundPromptSha256: 'e'.repeat(64), keys: ['Alpha', 'Beta'] };
const metaFor = kind => ({ projectId, reportId, ...reportKindSpec(kind).recordFields(kind === 'paper-source' ? paper : kind === 'reference-verification' ? verification : audit) });

test('M05 integration plan kind has explicit admission, persisted hash binding and three-role delivery independent of summary', () => {
  const factId = 'a'.repeat(16), target = { schemaVersion: 1, projectId, paperId: 'main', factIds: [factId], factDigests: { [factId]: 'a'.repeat(64) }, finalizedBy: 'creator', at: 1 };
  const facts = [{ fact_id: factId, predecessors: [], markdown: `---\nfact_id: ${factId}\npredecessors: []\n---\n## statement\nFixture\n## proof\nPrivate\n` }];
  const plan = { paperId: 'main', target, brief: 'Opaque planning brief', instructions: '', material: capturePlanMaterial({ facts, target, asOf: 'one' }).material };
  const spec = reportKindSpec('paper-plan'); assert.equal(resolveReportKind('paper-plan'), 'paper-plan'); assert.notEqual(spec, reportKindSpec());
  assert.equal(validReportStart({ kind: 'paper-plan', language: 'English', plan }, projectId), true);
  assert.equal(validReportStart({ kind: 'paper-plan', language: 'Chinese', plan }, projectId), false);
  assert.equal(validReportPayload({ kind: 'paper-plan', language: 'English', plan }, projectId), false);
  const bound = { ...plan, resources: Object.fromEntries(['contract', 'plannerPrompt', 'style', 'structure', 'acknowledgement'].map(key => [key, 'b'.repeat(64)])), promptSha256: 'c'.repeat(64), ledgerSha256: 'd'.repeat(64) };
  const meta = { projectId, reportId, language: 'English', ...spec.recordFields(bound) }; assert.equal(meta.kind, 'paper-plan');
  assert.equal(validReportPayload(meta, projectId), true); assert.equal(validReportStart(meta, projectId), false);
  const fields = reportTaskFields(meta); assert.equal(fields.kind, 'paper-plan'); assert.equal(matchesReportTaskFields(meta, fields), true);
  assert.doesNotMatch(JSON.stringify(fields), /Opaque planning brief|Private|"prompt":|"markdown":/);
  for (const key of Object.keys(fields)) { assert.equal(matchesReportTaskFields(meta, { ...fields, [key]: 'foreign' }), false, key); }
  const changed = structuredClone(meta); changed.plan.brief += 'changed'; assert.equal(matchesReportTaskFields(changed, fields), false);
  bound.target.factIds.push('b'.repeat(16)); assert.deepEqual(meta.plan.target.factIds, [factId], 'record owns its nested snapshot');
  assert.deepEqual(spec.artifactNames, { response: 'raw-response.txt', blocks: 'PLANNER_BLOCKS.json', plan: 'SECTION_PLAN.json', ledger: 'REFERENCE_LEDGER.md' });
  assert.deepEqual(spec.deliveredRoles, ['blocks', 'plan', 'ledger']); assert.deepEqual(reportKindSpec().recordFields(bound), {});
});

test('kind resolution defaults only omission and accepts explicit summary', () => {
  assert.equal(resolveReportKind(), 'summary');
  assert.equal(resolveReportKind('summary'), 'summary');
  assert.equal(reportKindSpec(), reportKindSpec('summary'));
  for (const kind of [null, '', 'unknown', 'toString', '__proto__', 0, false, {}, []]) {
    assert.throws(() => resolveReportKind(kind), { code: 'PROJECT_INVALID_INPUT', message: 'PROJECT_INVALID_INPUT' });
    assert.equal(validReportStart({ kind }, projectId, paperValid), false);
    assert.equal(validReportPayload({ kind }, projectId, paperValid), false);
  }
});

test('summary admission and legacy persisted payload rules remain distinct', () => {
  for (const kind of [undefined, 'summary']) {
    assert.equal(validReportStart({ kind, language: 'English' }, projectId, paperValid), true);
    assert.equal(validReportPayload({ kind }, projectId, paperValid), true);
    assert.equal(validReportStart({ kind, paper }, projectId, paperValid), false);
    assert.equal(validReportStart({ kind, audit }, projectId, paperValid), false);
    assert.equal(validReportPayload({ kind, paper }, projectId, paperValid), false);
    assert.equal(validReportPayload({ kind, audit }, projectId, paperValid), true, 'legacy persisted summary does not validate audit');
  }
  assert.equal(validReportStart(null, projectId, paperValid), false);
  assert.equal(validReportPayload(null, projectId, paperValid), false);
});

test('paper validation, summary persistence and task fields preserve their contracts', () => {
  assert.equal(validReportStart({ kind: 'paper-source', language: 'English', paper }, projectId, paperValid), true);
  assert.equal(validReportPayload({ kind: 'paper-source', language: 'English', paper }, projectId, paperValid), true);
  assert.equal(validReportStart({ kind: 'paper-source', language: 'English', paper }, 'foreign', paperValid), false);
  assert.equal(validReportStart({ kind: 'paper-source', language: 'Chinese', paper }, projectId, paperValid), false);
  assert.equal(validReportStart({ kind: 'paper-source', language: 'English', paper: {} }, projectId, paperValid), false);
  for (const kind of [undefined, 'summary']) {
    assert.deepEqual(reportKindSpec(kind).recordFields(paper), {});
    assert.equal(reportKindSpec(kind).label, 'Math progress report');
    const meta = { projectId, reportId, kind }, fields = reportTaskFields(meta);
    assert.deepEqual(fields, { projectId, reportId });
    assert.equal(Object.hasOwn(fields, 'kind'), false);
    assert.equal(matchesReportTaskFields(meta, fields), true);
    assert.equal(matchesReportTaskFields(meta, { ...fields, kind: 'summary' }), false);
  }
});

test('audit start accepts only its two-field selector, not bound persisted payload', () => {
  const selector = { sourceReportId: reportId, paperId: 'main' };
  assert.equal(validReportStart({ kind: 'reference-audit', audit: selector }, projectId), true);
  for (const invalid of [null, [], {}, { ...selector, extra: true }, { ...selector, sourceReportId: 'foreign' },
    { ...selector, paperId: 'INVALID' }, audit]) {
    assert.equal(validReportStart({ kind: 'reference-audit', audit: invalid }, projectId), false);
  }
  assert.equal(validReportPayload({ kind: 'reference-audit', audit: selector }, projectId), false);
});

test('audit persisted payload requires every bound hash and retains optional unverified citation status', () => {
  const valid = value => validReportPayload({ kind: 'reference-audit', audit: value }, projectId);
  assert.equal(valid(audit), true);
  assert.equal(valid({ ...audit, citationStatus: 'unverified' }), true);
  assert.equal(valid({ ...audit, citationStatus: 'verified' }), false);
  assert.equal(valid({ ...audit, extra: true }), false);
  for (const key of Object.keys(audit)) {
    const missing = { ...audit }; delete missing[key];
    assert.equal(valid(missing), false, `missing ${key}`);
    assert.equal(valid({ ...audit, [key]: 'INVALID' }), false, `invalid ${key}`);
  }
  for (const paperId of [undefined, null, 0, {}, []]) assert.equal(valid({ ...audit, paperId }), false);
});

test('task matcher binds required fields for immutable artifact kinds', () => {
  for (const kind of ['paper-source', 'reference-audit', 'reference-verification']) {
    const meta = metaFor(kind), fields = reportTaskFields(meta);
    assert.equal(matchesReportTaskFields(meta, fields), true);
    assert.equal(matchesReportTaskFields(meta, { ...fields, hostTrace: 'opaque' }), true);
    for (const key of Object.keys(fields)) {
      assert.equal(matchesReportTaskFields(meta, { ...fields, [key]: 'foreign' }), false, `changed ${key}`);
      const missing = { ...fields }; delete missing[key];
      assert.equal(matchesReportTaskFields(meta, missing), false, `missing ${key}`);
    }
  }
  assert.equal(matchesReportTaskFields(metaFor('reference-audit'), null), false);
});

test('revision selector binds parent citation and source statuses plus every byte digest', () => {
  const selector = { verificationReportId: revision.verificationReportId, paperId: 'main' };
  assert.equal(validReportStart({ kind: 'paper-revision', language: 'English', revision: selector }), true);
  assert.equal(validReportStart({ kind: 'paper-revision', language: 'English', revision }), false);
  assert.equal(validReportPayload({ kind: 'paper-revision', language: 'English', revision }), true);
  for (const status of ['generated', 'flagged']) assert.equal(validReportPayload({ kind: 'paper-revision', language: 'English', revision: { ...revision, sourceStatus: status } }), true);
  for (const invalid of [{ sourceStatus: 'pending' }, { citationStatus: 'invalid' }, { extra: true }, { promptSha256: 'bad' }]) {
    assert.equal(validReportPayload({ kind: 'paper-revision', language: 'English', revision: { ...revision, ...invalid } }), false);
  }
  for (const key of Object.keys(revision)) {
    const missing = { ...revision }; delete missing[key];
    assert.equal(validReportPayload({ kind: 'paper-revision', language: 'English', revision: missing }), false, key);
  }
  const meta = { projectId, reportId, kind: 'paper-revision', language: 'English', revision }, fields = reportTaskFields(meta);
  assert.equal(matchesReportTaskFields(meta, fields), true);
  assert.equal(matchesReportTaskFields(meta, { ...fields, sourceStatus: 'flagged' }), false);
  assert.deepEqual(reportKindSpec('paper-revision').deliveredRoles, ['source', 'summary', 'proposal', 'ledger']);
});

test('verification selector, bound hashes and exact keys have their own kind contract', () => {
  const selector = { auditReportId: verification.auditReportId, paperId: 'main' };
  assert.equal(validReportStart({ kind: 'reference-verification', verification: selector }), true);
  assert.equal(validReportStart({ kind: 'reference-verification', verification }), false);
  assert.equal(validReportStart({ verification: selector }), false);
  assert.equal(validReportPayload({ kind: 'reference-verification', verification }), true);
  for (const status of ['verified', 'partial', 'unverified']) assert.equal(validReportPayload({ kind: 'reference-verification', verification: { ...verification, citationStatus: status } }), true);
  for (const key of Object.keys(verification)) {
    const missing = { ...verification }; delete missing[key];
    assert.equal(validReportPayload({ kind: 'reference-verification', verification: missing }), false, key);
  }
  for (const invalid of [{ keys: [] }, { keys: ['Alpha','Alpha'] }, { keys: [null] }, { auditReportId: reportId.toUpperCase() },
    { boundVerifierPromptSha256: '0'.repeat(64) }, { boundPromptSha256: '0'.repeat(64) }, { citationStatus: 'complete' }, { extra: true }]) {
    assert.equal(validReportPayload({ kind: 'reference-verification', verification: { ...verification, ...invalid } }), false);
  }
  assert.deepEqual(reportKindSpec('reference-verification').artifactNames, { response: 'raw-response.txt', verdicts: 'REFERENCE_VERDICTS.json', ledger: 'REFERENCE_LEDGER.md' });
  assert.deepEqual(reportKindSpec('reference-verification').deliveredRoles, ['verdicts','ledger']);
});

test('immutable report specs map generated and delivered artifact roles', () => {
  const paperSpec = reportKindSpec('paper-source'), auditSpec = reportKindSpec('reference-audit');
  assert.equal(paperSpec.artifactNames.source, 'main.tex');
  assert.equal(paperSpec.artifactNames.quarantinedSource, 'main.leaky.tex');
  assert.equal(paperSpec.artifactNames.invalidSource, 'main.invalid.tex');
  assert.equal(paperSpec.artifactNames.provenance, 'provenance.json');
  assert.equal(paperSpec.artifactNames.ledger, 'REFERENCE_LEDGER.md');
  assert.deepEqual(paperSpec.deliveredRoles, ['source', 'ledger']);
  assert.deepEqual(auditSpec.artifactNames, { response: 'raw-response.txt', audit: 'REFERENCE_AUDIT.md' });
  assert.deepEqual(auditSpec.deliveredRoles, ['audit']);
  assert.deepEqual(reportKindSpec().deliveredRoles, [], 'summary uses its legacy export path');
});

test('operator-notes has an exact flat binding, private input role and cleanup-safe partial admission records', () => {
  const selector = { mode: 'operator-notes', sourceReportId: reportId, paperId: 'main' };
  const bound = { ...selector, sourceStatus: 'flagged', notesBytes: 3,
    ...Object.fromEntries(['mainSha256', 'ledgerSha256', 'provenanceSha256', 'notesSha256', 'contractSha256', 'reviserPromptSha256', 'styleSha256', 'promptSha256'].map(key => [key, 'a'.repeat(64)])) };
  const meta = { kind: 'paper-revision', language: 'English', projectId, reportId, revision: bound, state: 'queued' };
  assert.equal(validReportStart({ kind: meta.kind, language: 'English', revision: selector, notes: 'x' }), true);
  assert.equal(validReportStart({ kind: meta.kind, language: 'English', revision: selector }), false);
  assert.equal(validReportPayload(meta), true);
  for (const state of ['queued', 'failed', 'running', 'interrupted']) assert.equal(validReportPayload({ ...meta, state }), true, 'partial input remains cleanup-loadable');
  assert.equal(validReportPayload({ ...meta, state: 'completed' }), false);
  for (const change of [{ notes: 'raw text' }, { verificationReportId: reportId }, { verdictsSha256: 'a'.repeat(64) },
    { originalLedgerSha256: 'a'.repeat(64) }, { citationStatus: 'verified' }, { notesBytes: 32769 }, { mode: 'citation' }]) {
    assert.equal(validReportPayload({ ...meta, revision: { ...bound, ...change } }), false);
  }
  for (const key of Object.keys(bound)) { const missing = { ...bound }; delete missing[key]; assert.equal(validReportPayload({ ...meta, revision: missing }), false, key); }
  const fields = reportTaskFields(meta); assert.equal(matchesReportTaskFields(meta, fields), true);
  assert.ok(Object.values(fields).every(value => typeof value === 'string' || typeof value === 'number'));
  assert.equal(Object.hasOwn(fields, 'notes'), false); assert.equal(matchesReportTaskFields(meta, { ...fields, notesBytes: 4 }), false);
  const noop = { ...meta, state: 'completed', sourceStatus: 'not-produced', sha256: null, bytes: null,
    completedAt: 1, cleanupPending: false, stopRequested: false, writerStarting: false, taskCreating: false, scheduleCreating: false,
    artifacts: { response: {}, notes: { name: 'OPERATOR_NOTES.md', sha256: bound.notesSha256, bytes: 3 } },
    revisionOutcome: { schemaVersion: 1, status: 'no_edits_applied', reason: 'EMPTY_PATCH', parsedCount: 0, appliedCount: 0, skipped: [] } };
  assert.equal(validReportPayload(noop), true);
  const missingOutcome = { ...noop }; delete missingOutcome.revisionOutcome;
  assert.equal(validReportPayload(missingOutcome), false, 'new notes completions are never legacy');
  assert.equal(validReportPayload({ ...noop, artifacts: { ...noop.artifacts, source: {} } }), false);
  assert.equal(validReportPayload({ ...noop, revision }), false, 'citation no-op still rejects notes artifacts');
});

test('revision outcomes validate bounded counts, ordered skip reasons and exact status/reason relationships', () => {
  const valid = outcome => validReportPayload({ kind: 'paper-revision', language: 'English', revision, revisionOutcome: outcome,
    state: 'running', artifacts: { response: {} } });
  const proposal = { schemaVersion: 1, status: 'proposal', reason: null, parsedCount: 3, appliedCount: 1,
    skipped: [{ edit: 1, reason: 'EMPTY_FIND' }, { edit: 3, reason: 'NO_CHANGE' }] };
  assert.equal(valid(proposal), true);
  const noop = (reason, skipped, appliedCount = 0) => ({ schemaVersion: 1, status: 'no_edits_applied', reason,
    parsedCount: skipped.length + appliedCount, appliedCount, skipped });
  for (const value of [noop('EMPTY_PATCH', []), noop('ALL_NO_CHANGE', [{ edit: 1, reason: 'NO_CHANGE' }]),
    noop('ALL_INVALID', [{ edit: 1, reason: 'FIND_NOT_FOUND' }]),
    noop('MIXED_SKIPS', [{ edit: 1, reason: 'NO_CHANGE' }, { edit: 2, reason: 'OVERLAPPING_EDIT' }]),
    noop('NET_NO_CHANGE', [], 2)]) assert.equal(valid(value), true);
  for (const value of [null, {}, [], { ...proposal, extra: true }, { ...proposal, schemaVersion: 2 },
    { ...proposal, parsedCount: 129 }, { ...proposal, parsedCount: 2 }, { ...proposal, appliedCount: -1 },
    { ...proposal, appliedCount: 0 }, { ...proposal, parsedCount: 2.5 }, { ...proposal, reason: 'NET_NO_CHANGE' },
    { ...proposal, status: 'completed' }, { ...proposal, skipped: [proposal.skipped[1], proposal.skipped[0]] },
    { ...proposal, skipped: [proposal.skipped[0], proposal.skipped[0]] },
    ...[0, 4, 1.5, '1'].map(edit => ({ ...proposal, skipped: [{ edit, reason: 'EMPTY_FIND' }, proposal.skipped[1]] })),
    { ...proposal, skipped: [{ edit: 1, reason: 'MALFORMED_PATCH' }, proposal.skipped[1]] },
    { ...proposal, skipped: [{ edit: 1, reason: 'EMPTY_FIND', find: 'must not leak' }, proposal.skipped[1]] },
    noop('ALL_INVALID', []), noop('EMPTY_PATCH', [{ edit: 1, reason: 'NO_CHANGE' }]),
    noop('ALL_NO_CHANGE', [{ edit: 1, reason: 'EMPTY_FIND' }]), noop('ALL_INVALID', [{ edit: 1, reason: 'NO_CHANGE' }]),
    noop('MIXED_SKIPS', [{ edit: 1, reason: 'NO_CHANGE' }]), noop('NET_NO_CHANGE', [])]) {
    assert.equal(valid(value), false, JSON.stringify(value));
  }
});

test('completed no-op metadata has no derived artifacts; absence alone preserves legacy compatibility', () => {
  const meta = { kind: 'paper-revision', language: 'English', revision, state: 'completed',
    revisionOutcome: { schemaVersion: 1, status: 'no_edits_applied', reason: 'EMPTY_PATCH', parsedCount: 0, appliedCount: 0, skipped: [] },
    artifacts: { response: {} }, sourceStatus: 'not-produced', sha256: null, bytes: null, completedAt: 1,
    cleanupPending: false, stopRequested: false, writerStarting: false, taskCreating: false, scheduleCreating: false };
  assert.equal(validReportPayload(meta), true);
  for (const field of ['sourceStatus', 'sha256', 'bytes', 'completedAt', 'cleanupPending', 'stopRequested', 'writerStarting', 'taskCreating', 'scheduleCreating']) {
    const changed = { ...meta }; delete changed[field]; assert.equal(validReportPayload(changed), false, field);
  }
  for (const role of ['source', 'proposal', 'ledger', 'provenance', 'summary', 'quarantinedSource']) {
    assert.equal(validReportPayload({ ...meta, artifacts: { ...meta.artifacts, [role]: {} } }), false, role);
  }
  for (const field of ['artifact', 'publishedArtifact', 'publishedSha256', 'publishedBytes']) {
    assert.equal(validReportPayload({ ...meta, [field]: 'forbidden' }), false);
  }
  assert.equal(validReportPayload({ ...meta, revisionOutcome: null }), false);
  assert.equal(validReportPayload({ ...meta, sha256: 'a'.repeat(64) }), false);
  assert.equal(validReportPayload({ ...meta, error: 'FAILED' }), false);
  for (const state of ['running', 'failed', 'interrupted']) assert.equal(validReportPayload({ ...meta, state, error: 'FAILED' }), true);
  const produced = { ...meta, revisionOutcome: { schemaVersion: 1, status: 'proposal', reason: null, parsedCount: 1, appliedCount: 1, skipped: [] },
    sourceStatus: 'generated', sha256: 'a'.repeat(64), bytes: 1,
    artifacts: { response: {}, source: { sha256: 'a'.repeat(64), bytes: 1 }, proposal: {} } };
  assert.equal(validReportPayload(produced), true);
  for (const changed of [{ sourceStatus: 'not-produced' }, { bytes: 0 }, { sha256: null }, { artifacts: { response: {} } }]) {
    assert.equal(validReportPayload({ ...produced, ...changed }), false);
  }
  const legacy = { ...meta }; delete legacy.revisionOutcome;
  assert.equal(validReportPayload(legacy), true);
  const fields = reportTaskFields(meta);
  assert.equal(Object.hasOwn(fields, 'revisionOutcome'), false); assert.equal(matchesReportTaskFields(meta, fields), true);
});
