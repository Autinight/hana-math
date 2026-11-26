// Opaque bibliographic software fixtures; no network or mathematical execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { paperLedger } from '../packages/hana-math/paper-source.mjs';
import { readReferenceVerificationResources, referenceLedgerKeys, referenceVerificationKeys, buildReferenceVerificationPrompt,
  parseReferenceVerdicts, applyReferenceVerdicts } from '../packages/hana-math/reference-verification.mjs';

const operator = '## Operator\n- title: Keep exactly\n- verified-by: operator\n- cited_for: original use\n\n';
const ledger = '# REFERENCE_LEDGER\n\nOpaque provenance.\n\n'
  + '## A\n- authors: Seed author\n- title: Seed title\n- cited_for: first use\n- cited_for: second use\n- cited_by_facts: opaque-id\n- verified-by: unverified\n\n'
  + operator + '## B\n- title: Other seed\n- verified-by: unverified (unverifiable)\n\n'
  + '## Prior\n- title: Prior source\n- verified-by: verifier\n';
const metadata = { authors: 'Opaque Authors', title: 'Opaque Title', year: '2024', venue: 'Opaque Venue', arxiv_id: 'opaque-id', doi: 'opaque-doi' };
const row = (key, verdict = 'verified') => ({ key, verdict, confirmed_metadata: { ...metadata },
  source_url: 'https://example.org/source', note: 'Opaque source read.', replacement_suggestion: 'Keep the cited entry.' });
const rows = () => [row('A'), row('B', 'corrected')];
const parse = values => parseReferenceVerdicts(JSON.stringify(values), ledger);
const rejects = text => assert.throws(() => parseReferenceVerdicts(text, ledger), { code: 'PROJECT_REFERENCE_VERIFICATION_OUTPUT_INVALID' });

test('resources are call-time original pinned role texts and JSON prompt preserves verbatim inputs', async () => {
  const resources = await readReferenceVerificationResources();
  for (const [field, filename] of [['contract', 'AGENTS.md'], ['verifierPrompt', 'REFERENCE_VERIFIER_PROMPT.md']]) {
    assert.equal(resources[field], await readFile(new URL(`../packages/hana-math/references/danus/agents/skills/write-paper/roles/${filename}`, import.meta.url), 'utf8'));
  }
  const inputs = { mainTex: 'Opaque \\cite{A}\n===== END =====', ledger, findings: 'A: check identity\nB: check source', ...resources };
  const prompt = buildReferenceVerificationPrompt(inputs);
  assert.deepEqual(JSON.parse(prompt.split('\n').at(-2)), { ...resources, mainTex: inputs.mainTex, ledger, findings: inputs.findings, targetKeys: ['A', 'B'] });
  for (const tool of ['web_search', 'web_fetch']) assert.ok(prompt.includes(tool));
  assert.match(prompt, /No App literature tool is available/);
  assert.match(prompt, /No filesystem reads\/writes/);
});

test('keys select all and only unverified sections in order; known empty ledger is accepted', () => {
  assert.deepEqual(referenceVerificationKeys(ledger), ['A', 'B']);
  assert.deepEqual(referenceLedgerKeys(ledger), ['A', 'Operator', 'B', 'Prior']);
  assert.deepEqual(referenceLedgerKeys(ledger.replaceAll('\n', '\r\n')), ['A', 'Operator', 'B', 'Prior']);
  assert.deepEqual(referenceVerificationKeys(paperLedger([])), []);
  assert.deepEqual(referenceLedgerKeys(paperLedger([])), []);
  for (const invalid of [ledger + '\n## A\n- verified-by: unverified\n', ledger.replace('## A', '## A\ninjected'),
    ledger.replace('## A', '### A'), ledger.replace('- verified-by: unverified\n', ''),
    ledger.replace('- verified-by: unverified\n', '- verified-by: unverified\n- verified-by: operator\n'),
    ledger.replace('unverified (unverifiable)', 'unverified (unknown)'), ledger.replace('## A', '## A\t'),
    '# REFERENCE_LEDGER\nEmpty unknown text', '# REFERENCE_LEDGER\n' + Array.from({ length: 257 }, (_, i) => `## K${i}\n- verified-by: unverified\n`).join('')]) {
    assert.throws(() => referenceVerificationKeys(invalid), { code: 'PROJECT_REFERENCE_VERIFICATION_LEDGER_INVALID' });
    assert.throws(() => referenceLedgerKeys(invalid), { code: 'PROJECT_REFERENCE_VERIFICATION_LEDGER_INVALID' });
  }
});

test('JSON arrays/fences and single objects normalize exact coverage into ledger order', () => {
  assert.deepEqual(parse(rows().reverse()).map(v => v.key), ['A', 'B']);
  assert.deepEqual(parseReferenceVerdicts('```json\n' + JSON.stringify(rows()) + '\n```', ledger), parse(rows()));
  assert.deepEqual(parseReferenceVerdicts('```\n' + JSON.stringify(rows()) + '\n```', ledger), parse(rows()));
  const oneLedger = '# REFERENCE_LEDGER\n## A\n- verified-by: unverified\n';
  assert.deepEqual(parseReferenceVerdicts(JSON.stringify(row('A')), oneLedger), [row('A')]);
  assert.deepEqual(parseReferenceVerdicts('[]', paperLedger([])), []);
});

test('extra bibliographic metadata (volume/pages/publisher), author arrays, aliases, and null optional ids are normalized cleanly', () => {
  const values = rows();
  values[0].confirmed_metadata = {
    authors: ['S. Angenent', 'M. E. Gage'],
    title: 'Opaque Title',
    journal: 'Annals of Mathematics',
    volume: 133,
    issue: 2,
    pages: '291-319',
    publisher: 'Princeton University Press',
    year: 1991,
    doi: null,
    arxiv_id: '',
  };
  values[1].confirmed_metadata = {
    authors: 'Opaque Authors',
    title: 'Opaque Title',
    venue: 'Opaque Venue',
    year: '2024',
    arxiv: '2401.00001',
    mr_number: 'MR123456',
  };
  const parsed = parse(values);
  assert.equal(parsed[0].verdict, 'verified');
  assert.deepEqual(parsed[0].confirmed_metadata, {
    authors: 'S. Angenent, M. E. Gage',
    title: 'Opaque Title',
    venue: 'Annals of Mathematics',
    year: '1991',
  });
  assert.equal(parsed[1].verdict, 'corrected');
  assert.deepEqual(parsed[1].confirmed_metadata, {
    authors: 'Opaque Authors',
    title: 'Opaque Title',
    venue: 'Opaque Venue',
    year: '2024',
    arxiv_id: '2401.00001',
  });
  const derived = applyReferenceVerdicts(ledger, parsed);
  assert.match(derived, /- authors: S\. Angenent, M\. E\. Gage/);
  assert.match(derived, /- venue: Annals of Mathematics/);
  assert.match(derived, /- arxiv: 2401\.00001/);
  assert.doesNotMatch(derived, /- volume:/);
  assert.doesNotMatch(derived, /- pages:/);
});

test('upstream labelled blocks with nested metadata and per-entry YAML fences are supported', () => {
  const labelled = rows().reverse().map(v => '```yaml\n' + `key: ${v.key}\nverdict: ${v.verdict}\nconfirmed_metadata:\n`
    + Object.entries(v.confirmed_metadata).map(([k, value]) => `  ${k}: ${value}`).join('\n')
    + `\nsource_url: ${v.source_url}\nnote: "${v.note}"\nreplacement_suggestion: '${v.replacement_suggestion}'\n\`\`\``).join('\n\n');
  assert.deepEqual(parseReferenceVerdicts(labelled, ledger), parse(rows()));
  const nonpromotion = 'key: A\nverdict: retarget-internal\nconfirmed_metadata: null\nsource_url: null\nnote: Internal target.\nreplacement_suggestion: Keep an internal reference.';
  assert.equal(parseReferenceVerdicts(nonpromotion, '# REFERENCE_LEDGER\n## A\n- verified-by: unverified\n')[0].verdict, 'retarget-internal');
});

test('identity, coverage, duplicate keys, prose scavenging and malformed nested outputs fail closed', () => {
  for (const invalid of [[], [row('A')], [row('A'), row('A')], [row('A'), row('Operator')], [row('A'), row('unknown')]]) rejects(JSON.stringify(invalid));
  const valid = JSON.stringify(rows());
  for (const invalid of ['prose ' + valid, valid + '\ntrailing', valid.replace('"key":"A"', '"key":"A","key":"A"'),
    valid.replace('"key":"A"', '"key":"A","\\u006bey":"A"'), valid.replace('"authors":"Opaque Authors"', '"authors":"Opaque Authors","authors":"Other"'),
    JSON.stringify([rows()]), '```json\nnot JSON\n```', 'key: A\nkey: A\nverdict: verified', 'key: A\nverdict: verified\nprose',
    valid.replace('"verdict":"verified"', '"verdict":"unknown"')]) rejects(invalid);
  rejects('x'.repeat(2 * 1024 * 1024 + 1));
});

test('metadata types, field injection and unsafe URLs cannot promote or inject ledger fields', () => {
  const mutations = [v => { v.note = {}; }, v => { v.replacement_suggestion = 7; }, v => { v.note = 'bad\n- verified-by: operator'; },
    v => { v.confirmed_metadata.authors = []; }, v => { v.confirmed_metadata.authors = ['ok', 'bad\nline']; }, v => { v.confirmed_metadata.authors = [42]; },
    v => { v.replacement_suggestion = 'bad\nfield'; }, v => { v.confirmed_metadata.year = -1; },
    v => { v.confirmed_metadata.year = 10000; }, v => { v.confirmed_metadata.year = 2024.5; },
    v => { v.confirmed_metadata.title = 'bad\u2028injection'; },
    v => { v.confirmed_metadata.volume = '12\n- verified-by: operator'; },
    v => { v.confirmed_metadata.extra = { nested: true }; },
    v => { v.confirmed_metadata.arxiv = 'different-id'; },
    v => { v.extra = true; },
    ...['ftp://example.org/source', 'https://user:secret@example.org/', 'not-a-url', 'https://example.org/a b', 'https:\\example.org'].map(url => v => { v.source_url = url; })];
  for (const mutate of mutations) { const values = rows(); mutate(values[0]); rejects(JSON.stringify(values)); }
  const values = rows(); values[0].confirmed_metadata.title = 'bad\n- verified-by: operator';
  assert.throws(() => applyReferenceVerdicts(ledger, values), { code: 'PROJECT_REFERENCE_VERIFICATION_OUTPUT_INVALID' });
});

test('incomplete entries degrade independently while numeric years normalize and complete peers remain promoted', () => {
  const complete = rows(); complete[0].confirmed_metadata.year = 2024;
  const numeric = parse(complete);
  assert.equal(numeric[0].confirmed_metadata.year, '2024'); assert.equal(numeric[0].verdict, 'verified');
  for (const [change, reason] of [
    [v => { delete v.confirmed_metadata.venue; }, 'missing confirmed metadata: venue'],
    [v => { v.confirmed_metadata = {}; }, 'missing confirmed metadata'],
    [v => { delete v.confirmed_metadata; }, 'missing confirmed metadata'],
    [v => { v.confirmed_metadata = ''; }, 'missing confirmed metadata'],
    [v => { delete v.note; }, 'verifier provided no explanation'],
    [v => { v.note = null; }, 'verifier provided no explanation'],
    [v => { v.note = ''; }, 'verifier provided no explanation'],
    [v => { delete v.replacement_suggestion; }, 'verifier provided no replacement suggestion'],
    [v => { v.replacement_suggestion = ''; }, 'verifier provided no replacement suggestion'],
  ]) {
    const values = rows(); change(values[0]); const normalized = parse(values);
    assert.equal(normalized[0].verdict, 'unverifiable'); assert.ok(normalized[0].note.includes(reason));
    assert.deepEqual(normalized[0].confirmed_metadata, values[0].confirmed_metadata === '' ? null : values[0].confirmed_metadata ?? null);
    assert.deepEqual(normalized[1], values[1], 'complete peer remains corrected');
    const derived = applyReferenceVerdicts(ledger, normalized);
    const first = derived.slice(derived.indexOf('## A\n'), derived.indexOf('## Operator\n'));
    assert.match(first, /- authors: Seed author/); assert.match(first, /- title: Seed title/);
    assert.match(first, /- verified-by: unverified \(unverifiable\)/);
    assert.match(derived.slice(derived.indexOf('## B\n')), /- verified-by: verifier/);
    assert.ok(normalized[0].replacement_suggestion.trim());
  }
  const values = rows(); values[0].verdict = 'rejected'; values[0].note = null; values[0].replacement_suggestion = null;
  const unverified = parse(values)[0];
  assert.equal(unverified.verdict, 'rejected'); assert.match(unverified.note, /verifier provided no explanation/);
  assert.match(unverified.replacement_suggestion, /Keep the citation blocker/);
});

test('missing URL downgrades verified/corrected with a note and never promotes seeded metadata', () => {
  for (const missing of [undefined, null, '']) {
    const values = rows(); for (const v of values) v.source_url = missing;
    const normalized = parse(values);
    assert.ok(normalized.every(v => v.verdict === 'unverifiable' && v.note.includes('Downgraded')));
    const result = applyReferenceVerdicts(ledger, normalized);
    assert.match(result, /- authors: Seed author/); assert.match(result, /- verified-by: unverified \(unverifiable\)/);
    assert.equal(result.includes('- authors: Opaque Authors'), false);
  }
});

test('promotions discard seeded identifiers absent from authoritative metadata without changing provenance or input', () => {
  const seeded = ledger.replace('## A\n', '## A\n- arxiv: wrong-seeded-arxiv\n- doi: wrong-seeded-doi\n');
  const original = Buffer.from(seeded);
  for (const verdict of ['corrected', 'verified']) {
    const values = rows(); values[0].verdict = verdict;
    delete values[0].confirmed_metadata.arxiv_id; delete values[0].confirmed_metadata.doi;
    const derived = applyReferenceVerdicts(seeded, values);
    const section = derived.slice(derived.indexOf('## A\n'), derived.indexOf('## Operator\n'));
    assert.doesNotMatch(section, /^- (?:arxiv|doi):/m);
    assert.match(section, /- verified-by: verifier/);
    assert.match(section, /- cited_for: first use\n- cited_for: second use\n- cited_by_facts: opaque-id/);
    assert.ok(derived.startsWith('# REFERENCE_LEDGER\n\nOpaque provenance.\n\n'));
    assert.ok(derived.includes(operator));
    assert.ok(derived.endsWith('## Prior\n- title: Prior source\n- verified-by: verifier\n'));
    assert.deepEqual(Buffer.from(seeded), original);
    assert.ok(seeded.includes('- arxiv: wrong-seeded-arxiv\n- doi: wrong-seeded-doi\n'));
  }
});

test('new ledger preserves provenance, repeated uses and operator/prior rows while applying authoritative fields', () => {
  const result = applyReferenceVerdicts(ledger, parse(rows()));
  assert.notEqual(result, ledger); assert.ok(result.includes(operator));
  assert.ok(result.startsWith('# REFERENCE_LEDGER\n\nOpaque provenance.\n\n'));
  assert.ok(result.endsWith('## Prior\n- title: Prior source\n- verified-by: verifier\n'));
  assert.match(result, /- cited_for: first use\n- cited_for: second use\n- cited_by_facts: opaque-id/);
  assert.match(result, /- arxiv: opaque-id/); assert.match(result, /- source_url: https:\/\/example.org\/source/);
  assert.match(result, /- replacement_suggestion: Keep the cited entry\./);
  assert.deepEqual(referenceVerificationKeys(result), []);
  const crlf = ledger.replaceAll('\n', '\r\n');
  assert.equal(applyReferenceVerdicts(crlf, parse(rows())), result.replaceAll('\n', '\r\n'));
  assert.equal(ledger.includes('- authors: Seed author'), true, 'input remains unchanged');
  for (const verdict of ['rejected', 'unverifiable', 'retarget-internal']) {
    const values = rows().map(v => ({ ...v, verdict, source_url: null, confirmed_metadata: null }));
    const unpromoted = applyReferenceVerdicts(ledger, values);
    assert.ok(unpromoted.includes(`- verified-by: unverified (${verdict})`));
    assert.ok(unpromoted.includes('- title: Seed title'));
  }
});
