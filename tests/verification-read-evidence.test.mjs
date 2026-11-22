// Opaque software evidence only; hashes test byte/protocol handling, never mathematics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatePredecessors, parseVerificationReads, readEvidenceDTO, READ_EVIDENCE_LIMITS as L, sha256 } from '../packages/hana-math/verification-read-evidence.mjs';
const ids = { projectId: 'project-fixture', runId: 'run-fixture', submissionId: 'submission-fixture', workerId: 'worker-1' };
const fid = 'a'.repeat(16), cwd = '/fixture/app/context/projects/project-fixture/research/run-fixture/verifiers/submission-fixture';
const canonical = '/fixture/app/context/projects/project-fixture/shared/fact_graph/facts/' + fid + '.md';
const raw = '---\nfact_id: ' + fid + '\n---\nopaque 原样 UTF-8\r\n';
const pred = [{ factId: fid, expectedSHA: sha256(Buffer.from(raw)) }];
const message = (id, parentId, body) => ({ id, parentId, type: 'message', message: body });
const call = (id = 'call-1', args = { path: canonical }) => ({ type: 'toolCall', id, name: 'read', arguments: args });
const result = (id = 'call-1', text = raw) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', isError: false, content: [{ type: 'text', text }], details: { truncation: { truncated: false } } });
const pair = (args, text) => [message('a', null, { role: 'assistant', content: [call('call-1', args)] }), message('b', 'a', result('call-1', text))];
const parse = (entries, leafId = 'b', predecessors = pred, paths = [canonical]) => parseVerificationReads({ entries, leafId }, ids, predecessors, cwd, paths, 'verifier-sid');
function quiet(dto) {
  const s = JSON.stringify(dto); assert.ok(Buffer.byteLength(s) <= L.outputBytes);
  assert.doesNotMatch(s, /fixture\/app|SECRET|opaque 原样|thinking body|proof body/);
  assert.equal(dto.verdictTiming, 'not-established'); assert.equal(dto.hostMaterializationBounded, false);
  assert.equal(dto.currentGraphValidity, 'not-queried'); assert.equal(dto.coverageScope, 'returned-active-branch');
}
test('active ancestors, not array order/time or off-branch decoys; exact unmodified UTF8 bytes', () => {
  const entries = pair(); entries[0].timestamp = 900; entries[1].timestamp = 1;
  entries.push(message('decoy', 'a', result('call-1', 'SECRET off branch')));
  const dto = parse([entries[2], entries[1], entries[0]]); quiet(dto);
  assert.equal(dto.coverage, 'complete'); const row = dto.predecessors[0];
  assert.deepEqual([row.invocationCount, row.successfulResultCount, row.exactMatchCount, row.ambiguousCount], [1, 1, 1, 0]);
  assert.equal(row.firstExactMatch.bytes, Buffer.byteLength(raw)); assert.equal(row.firstExactMatch.sha256, pred[0].expectedSHA);
});
for (const text of [raw.trimEnd(), raw.replace(/\r\n/g, '\n'), raw + '\n', 'different']) test('no trimming, newline normalization or tail stripping: ' + JSON.stringify(text.slice(-12)), () => {
  const dto = parse(pair(undefined, text)); assert.equal(dto.predecessors[0].exactMatchCount, 0); quiet(dto);
});
for (const args of [{ path: '../../../../shared/fact_graph/facts/' + fid + '.md', offset: 1, limit: 10 }, { resource: { kind: 'local-file', path: canonical }, offset: 2, limit: 1 }]) test('strict local targets retain requested range and honest lexical basis', () => {
  // Four lexical parents reach the project; this is not a physical path assertion.
  const dto = parse(pair(args)); const row = dto.predecessors[0];
  assert.equal(row.exactMatchCount, 1); assert.deepEqual(row.firstCall.range, { offset: args.offset, limit: args.limit });
  assert.match(row.firstCall.matchBasis, args.resource ? /^absolute/ : /verified-cwd-lexical/); quiet(dto);
});
test('Windows verifier paths match the exact drive-local predecessor, without interpreting URLs or drive-relative paths', () => {
  const winCwd = 'D:' + cwd.replaceAll('/', '\\'), winFile = 'D:' + canonical.replaceAll('/', '\\');
  const observe = file => parseVerificationReads({ entries: pair({ path: file }), leafId: 'b' }, ids, pred, winCwd, [winFile], 'verifier-sid');
  for (const file of [winFile, `..\\..\\..\\..\\shared\\fact_graph\\facts\\${fid}.md`]) {
    const dto = observe(file); assert.equal(dto.coverage, 'complete'); assert.equal(dto.predecessors[0].exactMatchCount, 1);
  }
  for (const file of ['D:relative', '\\root-relative', '\\\\server\\share', 'https://example.invalid', winFile + ':stream']) {
    const dto = observe(file); assert.equal(dto.coverage, 'limited'); assert.equal(dto.predecessors[0].invocationCount, 0);
  }
  assert.equal(observe(winFile.replace('D:', 'C:')).predecessors[0].invocationCount, 0);
});
for (const resource of [false, true]) for (const padded of [' ' + canonical, canonical + ' ', '\u00a0' + canonical + '\u00a0']) test(`padded ${resource ? 'local-file resource' : 'direct'} path is unknown, not complete unrelated-zero`, () => {
  const args = resource ? { resource: { kind: 'local-file', path: padded } } : { path: padded };
  const entries = pair(args); Object.defineProperty(entries[1].message, 'content', { get() { assert.fail('Do not inspect an unattributed padded-path result'); } });
  const dto = parse(entries); assert.equal(dto.coverage, 'limited'); assert.ok(dto.reasons.includes('READ_TARGET_UNKNOWN'));
  assert.equal(dto.predecessors[0].invocationCount, 0); assert.equal(dto.predecessors[0].exactMatchCount, 0); quiet(dto);
});
for (const extra of [{ fileId: 'SECRET' }, { url: 'https://example.invalid' }, { node: 'SECRET' }, { sessionId: 'SECRET' }, { resource: { kind: 'local-file', path: canonical } }]) test('conflicting target selectors cannot attribute path: ' + Object.keys(extra)[0], () => {
  const entries = pair({ path: canonical, ...extra }); Object.defineProperty(entries[1].message, 'content', { get() { assert.fail('Unattributed result body read'); } });
  const dto = parse(entries); assert.equal(dto.coverage, 'limited'); assert.equal(dto.predecessors[0].invocationCount, 0); quiet(dto);
});
for (const args of [{ resource: { kind: 'url', path: canonical } }, { resource: { kind: 'local-file', path: canonical, node: 'other' } }, { resource: { kind: 'session-file', fileId: 'opaque' } }, { path: 'https://example.invalid' }, { path: canonical, offset: -1 }]) test('unsupported resource/range stays unknown', () => {
  const dto = parse(pair(args)); assert.equal(dto.coverage, 'limited'); assert.equal(dto.predecessors[0].exactMatchCount, 0); quiet(dto);
});
for (const change of [
  e => { e.push({ ...e[1] }); }, e => { e[0].parentId = 'missing'; }, e => { delete e[0].parentId; },
  e => { e[0].parentId = 'b'; }, e => { e.push(message('x', 'y', {}), message('y', 'x', {})); },
]) test('malformed global tree discards provisional counts', () => {
  const entries = pair(); change(entries); const dto = parse(entries);
  assert.equal(dto.coverage, 'unavailable'); assert.equal(dto.predecessors[0].exactMatchCount, 0); quiet(dto);
});
for (const leaf of [null, undefined, 'missing', 5]) test('missing/ambiguous leaf ' + String(leaf), () => {
  const dto = parseVerificationReads({ entries: pair(), leafId: leaf }, ids, pred, cwd, [canonical], 'verifier-sid');
  assert.equal(dto.coverage, 'unavailable'); quiet(dto);
});
test('empty returned active branch means not observed here, not never read', () => {
  const dto = parse([], null); assert.equal(dto.coverage, 'complete'); assert.equal(dto.predecessors[0].invocationCount, 0); quiet(dto);
});
for (const conflict of ['duplicate-call', 'nonread-reused-call', 'duplicate-result', 'wrong-name', 'before-call', 'missing-result']) test('correlation conflict never chooses a convenient match: ' + conflict, () => {
  const entries = pair();
  if (conflict === 'duplicate-call') entries[0].message.content.push(call());
  if (conflict === 'nonread-reused-call') entries[0].message.content.push({ type: 'toolCall', id: 'call-1', name: 'web_fetch', get arguments() { assert.fail('nonread args'); } });
  if (conflict === 'duplicate-result') entries.push(message('c', 'b', result()));
  if (conflict === 'wrong-name') entries[1].message.toolName = 'other';
  if (conflict === 'before-call') { entries[1].parentId = null; entries[0].parentId = 'b'; }
  if (conflict === 'missing-result') entries.pop();
  const dto = parse(entries, conflict === 'duplicate-result' ? 'c' : ['missing-result', 'before-call'].includes(conflict) ? 'a' : 'b');
  assert.equal(dto.coverage, 'limited'); assert.equal(dto.predecessors[0].exactMatchCount, 0); assert.ok(dto.predecessors[0].ambiguousCount > 0); quiet(dto);
});
test('unmatched read result remains unknown without looking at its body', () => {
  const r = result('missing-call'); Object.defineProperty(r, 'content', { get() { assert.fail('unmatched body'); } });
  const dto = parse([message('b', null, r)]); assert.equal(dto.coverage, 'limited'); quiet(dto);
});
test('never consumes thinking/text/user/custom/unrelated args or result body getters', () => {
  const forbidden = () => assert.fail('unrelated getter executed');
  const entries = [message('u', null, { role: 'user', get content() { forbidden(); } }),
    { id: 'custom', parentId: 'u', type: 'custom', get message() { forbidden(); } },
    message('a', 'custom', { role: 'assistant', content: [{ type: 'thinking', get thinking() { forbidden(); } }, { type: 'text', get text() { forbidden(); } },
      { type: 'toolCall', id: 'other', name: 'web_fetch', get arguments() { forbidden(); } }, call()] }),
    message('unrelated', 'a', { role: 'toolResult', toolCallId: 'other', toolName: 'web_fetch', get content() { forbidden(); }, get details() { forbidden(); } }),
    message('b', 'unrelated', result())];
  const dto = parse(entries); assert.equal(dto.predecessors[0].exactMatchCount, 1); quiet(dto);
});
for (const status of [true, undefined, null]) test('failed or unknown status cannot hash a read body: ' + String(status), () => {
  const entries = pair(); entries[1].message.isError = status; Object.defineProperty(entries[1].message, 'content', { get() { assert.fail('failed body'); } });
  const dto = parse(entries); assert.equal(dto.predecessors[0].successfulResultCount, 0); assert.equal(dto.predecessors[0].exactMatchCount, 0); quiet(dto);
});
for (const content of [[{ type: 'image', get data() { assert.fail('image data'); } }], [{ type: 'text', text: raw.slice(0, 5) }, { type: 'text', text: raw.slice(5) }], [{ type: 'text', text: '\ud800' }]]) test('unsupported/nontext/split output is not reassembled', () => {
  const entries = pair(); entries[1].message.content = content; const dto = parse(entries);
  assert.equal(dto.predecessors[0].successfulResultCount, 1); assert.equal(dto.predecessors[0].exactMatchCount, 0); assert.equal(dto.coverage, 'limited'); quiet(dto);
});
test('missing truncation metadata does not prove completeness; explicit flags remain independent of exact bytes', () => {
  const entries = pair(); delete entries[1].message.details;
  const absent = parse(entries); assert.equal(absent.coverage, 'complete'); assert.deepEqual(absent.reasons, []); assert.equal(absent.predecessors[0].exactMatchCount, 1); assert.deepEqual(absent.predecessors[0].firstExactMatch.truncation, { known: false });
  entries[1].message.details = { truncation: { truncated: true, truncatedBy: 'bytes', outputBytes: 8, totalBytes: 99, SECRET: 'hidden' }, get private() { assert.fail('private detail'); } };
  const explicit = parse(entries); assert.equal(explicit.predecessors[0].exactMatchCount, 1); assert.equal(explicit.predecessors[0].firstExactMatch.truncation.truncated, true); quiet(explicit);
});
test('entry and content/call-record ceilings produce no provisional positive evidence', () => {
  const tooMany = Array(L.entries + 1).fill(null); assert.deepEqual(parse(tooMany).reasons, ['ENTRY_LIMIT']);
  const entries = pair(); entries[0].message.content = [...Array(L.records).fill({ type: 'text' }), call()];
  const dto = parse(entries); assert.deepEqual(dto.reasons, ['RECORD_LIMIT']); assert.equal(dto.predecessors[0].exactMatchCount, 0);
});
test('per-result and total text budgets stay bounded and explicit', () => {
  const over = parse(pair(undefined, 'x'.repeat(L.resultBytes + 1))); assert.ok(over.reasons.includes('RESULT_TEXT_LIMIT')); assert.equal(over.predecessors[0].exactMatchCount, 0);
  const entries = []; let parent = null;
  for (let i = 0; i < 9; i++) { entries.push(message('a' + i, parent, { role: 'assistant', content: [call('c' + i)] }), message('b' + i, 'a' + i, result('c' + i, 'x'.repeat(L.resultBytes)))); parent = 'b' + i; }
  const dto = parse(entries, parent); assert.deepEqual(dto.reasons, ['RESULT_TOTAL_LIMIT']); assert.equal(dto.predecessors[0].successfulResultCount, 0); quiet(dto);
});
test('DTO reasons and coverage are fixed bounded codes, not serializable error properties', () => {
  const privateObject = { toJSON() { assert.fail('No raw error serialization'); } };
  const dto = readEvidenceDTO(ids, privateObject, ['SECRET'.repeat(100000), privateObject, ...Array(20000).fill('SECRET')]);
  assert.equal(dto.coverage, 'unavailable'); assert.deepEqual(dto.reasons, ['EVIDENCE_UNAVAILABLE']);
  assert.ok(Buffer.byteLength(JSON.stringify(dto)) < L.outputBytes); quiet(dto);
});
test('128 summaries and 256KiB output cap bound sampling without changing observed counts', () => {
  const preds = [], paths = [], entries = []; let parent = null;
  for (let i = 0; i < 128; i++) {
    const factId = i.toString(16).padStart(16, '0'), file = '/facts/' + factId + '.md'; preds.push({ factId, expectedSHA: sha256('x') }); paths.push(file);
    const a = 'a' + i + '-'.repeat(245), b = 'b' + i + '-'.repeat(245), c = 'c' + i + '-'.repeat(245);
    entries.push(message(a, parent, { role: 'assistant', content: [call(c, { path: file, offset: 1, limit: 1 })] }), message(b, a, result(c, 'x'))); parent = b;
  }
  const dto = parse(entries, parent, preds, paths); quiet(dto); assert.equal(dto.predecessors.length, 128);
  assert.ok(dto.reasons.includes('OUTPUT_LIMIT')); assert.ok(dto.predecessors.every(p => p.exactMatchCount === 1 && p.firstExactMatch === null));
  assert.deepEqual(parse([], null, [...preds, preds[0]], paths).reasons, ['PREDECESSOR_LIMIT']);
});
function candidate() { return { binding: { ...ids, role: 'worker', author: 'saved-worker' }, arguments: { statement: 'opaque', proof: 'opaque', predecessors: [fid], source_id: '', external_refs: [{ arbitrary: 'preserved' }] }, prepared: { candidateDigest: 'b'.repeat(64), predecessorDigests: { [fid]: pred[0].expectedSHA }, precheck: { passed: true } } }; }
function candidateBytes(value) { const c = value ?? candidate(); delete c.binding.submissionId; return Buffer.from(JSON.stringify(c)); }
const candidateIdentity = { ...ids, workerAgentId: 'saved-worker' };
test('candidate keeps legitimate optional/null metadata semantics and exact digest-map correspondence', () => {
  assert.deepEqual(candidatePredecessors(candidateBytes(), candidateIdentity), pred);
  const c = candidate(); c.arguments.predecessors = null; c.arguments.source_id = null; c.arguments.glossary_introduces = null; c.prepared.predecessorDigests = {};
  assert.deepEqual(candidatePredecessors(candidateBytes(c), candidateIdentity), []);
});
for (const change of [c => { c.binding.projectId = 'other'; }, c => { c.binding.workerId = 'other'; }, c => { c.binding.author = 'other'; }, c => { c.binding.role = 'main'; },
  c => { c.prepared.predecessorDigests = {}; }, c => { c.prepared.predecessorDigests['c'.repeat(16)] = 'd'.repeat(64); }, c => { c.prepared.predecessorDigests[fid] = '../SECRET'; },
  c => { c.arguments.predecessors.push(fid); }, c => { c.arguments.unknown = 'field'; }]) test('poisoned candidate linkage/schema/map is unavailable', () => {
  const c = candidate(); change(c); assert.throws(() => candidatePredecessors(candidateBytes(c), candidateIdentity));
});
test('candidate byte, depth, node and predecessor ceilings', () => {
  assert.throws(() => candidatePredecessors(Buffer.alloc(L.candidateBytes + 1), candidateIdentity), { evidenceReason: 'CANDIDATE_LIMIT' });
  const deep = candidate(); let nested = {}; deep.prepared.precheck.extra = nested; for (let i = 0; i < 17; i++) { nested.next = {}; nested = nested.next; }
  assert.throws(() => candidatePredecessors(candidateBytes(deep), candidateIdentity), { evidenceReason: 'CANDIDATE_LIMIT' });
  const wide = candidate(); wide.prepared.precheck.extra = Array(L.nodes).fill(0);
  assert.throws(() => candidatePredecessors(candidateBytes(wide), candidateIdentity), { evidenceReason: 'CANDIDATE_LIMIT' });
  const count = candidate(); count.arguments.predecessors = Array.from({ length: 129 }, (_, i) => i.toString(16).padStart(16, '0'));
  assert.throws(() => candidatePredecessors(candidateBytes(count), candidateIdentity), { evidenceReason: 'PREDECESSOR_LIMIT' });
});
