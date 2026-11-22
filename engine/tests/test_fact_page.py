"""Opaque, isolated software fixtures only; no mathematical candidates/models."""
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch
from hana_math_engine import research as r


class FactPageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name).resolve()
        self.root = self.data / 'context/projects/project-page/shared'
        self.facts = self.root / 'fact_graph/facts'
        self.facts.mkdir(parents=True)

    def put(self, index, statement='opaque', proof='opaque payload', preds=()):
        fid = f'{index:016x}'
        raw = f'---\nfact_id: {fid}\nauthor: fixture\npredecessors: [{", ".join(preds)}]\nexternal_refs: []\n---\n## statement\n{statement}\n## proof\n{proof}\n'
        (self.facts / f'{fid}.md').write_text(raw, encoding='utf-8')
        return fid

    def call(self, args=None, operation='fact_list_page', role='main'):
        return r.dispatch(self.data, {'schemaVersion': 1, 'requestId': str(uuid.uuid4()),
            'operation': operation, 'context': {'projectId': 'project-page', 'runId': 'run-page',
            'role': role, 'author': 'fixture'}, 'arguments': args or {}})

    def page(self, args=None):
        reply = self.call(args)
        self.assertTrue(reply['ok'], reply)
        value = reply['result']
        self.assertLessEqual(len(r.encoded(value)), 16384)
        self.assertEqual(value['page']['returned'], len(value['facts']))
        return value

    def token(self, **changes):
        values = {'v': 1, 'projectId': 'project-page', 'asOf': self.page()['page']['asOf'], 'offset': 0, 'limit': 64}
        values.update(changes)
        return base64.urlsafe_b64encode(r.encoded(values)).decode().rstrip('=')

    def codec_variants(self):
        raw = r.encoded({'asOf': 'a' * 64, 'limit': 2, 'offset': 1, 'projectId': 'project-page', 'v': 1}).decode()
        values = [raw[:-1] + ',"\\u0076":1}', raw.replace('"v":1', '"\\u0076":1,"v":1'),
                  raw.replace('"v":1', '"\\u0076":1'), raw.replace('"projectId"', '"project\\u0049d"'),
                  raw.replace('project-page', 'project\\u002dpage'), raw.replace('"asOf":"a', '"asOf":"\\u0061'),
                  ' ' + raw, raw + '\n', raw.replace(',', ', '),
                  json.dumps({'v': 1, 'projectId': 'project-page', 'offset': 1, 'limit': 2, 'asOf': 'a' * 64}, separators=(',', ':'))]
        for key, original, value in [('v', 1, '1e0'), ('v', 1, '1.0'), ('limit', 2, '2e0'), ('limit', 2, '2.0'),
                                     ('offset', 1, '1e0'), ('offset', 1, '1.0'), ('offset', 1, '-0')]:
            values.append(raw.replace(f'"{key}":{original}', f'"{key}":{value}'))
        return [base64.urlsafe_b64encode(value.encode()).decode().rstrip('=') for value in values]

    def test_noncanonical_codec_rejected_before_fact_scan(self):
        with patch.object(r.FactGraph, 'list', side_effect=AssertionError('scan reached')) as scan:
            for token in self.codec_variants():
                with self.subTest(token=token):
                    with self.assertRaises(r.Rejected) as caught:
                        r.fact_list_page(self.root, 'project-page', {'cursor': token})
                    self.assertEqual(caught.exception.code, 'invalid_cursor')
                    scan.assert_not_called()

    def test_noncanonical_codec_dispatch_rejected_before_inventory(self):
        with patch.object(r, 'inventory', side_effect=AssertionError('inventory reached')) as inventory:
            for token in self.codec_variants():
                with self.subTest(token=token):
                    response = self.call({'cursor': token})
                    self.assertFalse(response['ok']); self.assertEqual(response['error']['code'], 'invalid_cursor')
                    self.assertNotIn('result', response); inventory.assert_not_called()

    def test_canonical_producer_scalar_bytes_and_real_continuation(self):
        for offset in [0, 1, r.MAX_SAFE_INTEGER]:
            for limit in [1, 64]:
                token = r.fact_page_cursor('project-page', 'a' * 64, offset, limit)
                raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))
                expected = {'asOf': 'a' * 64, 'limit': limit, 'offset': offset, 'projectId': 'project-page', 'v': 1}
                self.assertEqual(raw, json.dumps(expected, separators=(',', ':'), ensure_ascii=False).encode())
                self.assertEqual(r.fact_page_options({'cursor': token}, 'project-page'), (expected, limit))
        for index in range(3): self.put(index)
        first = self.page({'limit': 1}); token = first['page']['nextCursor']
        raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))
        self.assertEqual(raw, r.encoded(json.loads(raw)))
        second = self.page({'cursor': token})
        self.assertEqual(second['page']['asOf'], first['page']['asOf'])
        self.assertEqual(second['page']['startIndex'], 1); self.assertEqual(second['facts'][0]['fact_id'], f'{1:016x}')

    def test_large_stable_traversal_and_full_get_coexist(self):
        ids = [self.put(i, proof='opaque:' + 'x' * 18000) for i in range(90)]
        old = self.call(operation='fact_list')
        self.assertFalse(old['ok']); self.assertEqual(old['error']['code'], 'size_limit'); self.assertNotIn('result', old)
        found, args, observation = [], {'limit': 11}, None
        while True:
            value = self.page(args); p = value['page']
            self.assertEqual(p['startIndex'], len(found)); self.assertEqual(p['total'], len(ids))
            if observation is not None: self.assertEqual(observation, p['asOf'])
            observation = p['asOf']; found.extend(f['fact_id'] for f in value['facts'])
            self.assertFalse(p['allFactsIncluded']); self.assertTrue(p['previewOnly'])
            if not p['hasMore']: break
            self.assertLess(len(p['nextCursor']), 1024); args = {'cursor': p['nextCursor']}
        self.assertEqual(found, ids)
        full = self.call({'fact_id': ids[-1]}, 'fact_get')['result']
        self.assertEqual(full['markdown'].encode(), (self.facts / (ids[-1] + '.md')).read_bytes())
        self.assertFalse(list((self.data / 'context/projects/project-page/research/control').glob('*.json')))

    def test_empty_prepared_and_role_read_exception(self):
        for role in ['main', 'worker', 'verifier']:
            value = self.call(role=role)['result']
            self.assertEqual(value['facts'], []); self.assertTrue(value['page']['allFactsIncluded'])
            self.assertEqual(value['page']['total'], 0); self.assertIsNone(value['page']['nextCursor'])
        self.assertEqual(self.call({'cursor': self.token()})['error']['code'], 'invalid_cursor')

    def test_unicode_and_section_projection_not_lossless_statement(self):
        self.put(0, statement='  '+ '界😀' * 100 + '\n## nested\nnot part of projection')
        f = self.page()['facts'][0]
        self.assertTrue(f['statementPreviewTruncated']); self.assertLessEqual(len(f['statementPreview'].encode()), 512)
        self.assertNotIn('\ufffd', f['statementPreview']); self.assertNotIn('nested', f['statementPreview'])
        self.assertEqual(f['canonicalBytes'], (self.facts / ('0' * 16 + '.md')).stat().st_size)
        self.put(1, statement='a' * 512)
        self.assertFalse(self.page()['facts'][1]['statementPreviewTruncated'])

    def test_escaping_and_dense_predecessors_adapt_rows_and_real_cursor(self):
        preds = [f'{1000+i:016x}' for i in range(128)]
        for i in range(64): self.put(i, statement=('"\\\t' * 180), preds=preds)
        value = self.page(); p = value['page']
        self.assertLess(p['returned'], p['limit']); self.assertTrue(p['hasMore'])
        for row in value['facts']: self.assertEqual(row['predecessors'], preds)
        cursor = json.loads(base64.urlsafe_b64decode(p['nextCursor'] + '=' * (-len(p['nextCursor']) % 4)))
        self.assertEqual(cursor['offset'], p['returned'])
        found = [row['fact_id'] for row in value['facts']]
        while p['hasMore']:
            value = self.page({'cursor': p['nextCursor']}); p = value['page']; found += [row['fact_id'] for row in value['facts']]
        self.assertEqual(found, [f'{i:016x}' for i in range(64)]); self.assertFalse(p['allFactsIncluded'])

    def test_one_row_cannot_fit_is_explicit_refusal(self):
        self.put(0)
        with patch.object(r, 'FACT_PAGE_BYTES', 100):
            reply = self.call(); self.assertEqual(reply['error']['code'], 'size_limit'); self.assertNotIn('result', reply)

    def test_predecessors_invalid_never_clipped(self):
        for preds in [['bad'], ['a' * 16] * 2, [f'{i:016x}' for i in range(129)]]:
            self.put(0, preds=preds)
            self.assertEqual(self.call()['error']['code'], 'invalid_fact')

    def test_asof_exact_full_bytes_and_project_bound_protocol(self):
        for i in [2, 0, 1]: self.put(i)
        pairs = [[p.stem, hashlib.sha256(p.read_bytes()).hexdigest()] for p in sorted(self.facts.glob('*.md'))]
        expected = hashlib.sha256(json.dumps({'kind': 'hana-math-fact-index', 'version': 1,
            'projectId': 'project-page', 'facts': pairs}, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(self.page()['page']['asOf'], expected)

    def test_same_id_author_intuition_bibliography_whitespace_drift(self):
        self.put(0); self.put(1)
        target = self.facts / ('0' * 16 + '.md')
        mutations = [lambda s: s.replace('author: fixture', 'author: changed'),
                     lambda s: s + '\n## intuition\nopaque changed',
                     lambda s: s.replace('external_refs: []', 'external_refs: [{"key":"opaque"}]'),
                     lambda s: s + '  ']
        for mutate in mutations:
            cursor = self.page({'limit': 1})['page']['nextCursor']
            target.write_bytes(mutate(target.read_bytes().decode('utf-8')).encode('utf-8'))
            reply = self.call({'cursor': cursor}); self.assertEqual(reply['error']['code'], 'fact_page_changed'); self.assertNotIn('result', reply)

    def test_add_and_revoke_drift_before_new_total_offset_check(self):
        for i in range(4): self.put(i)
        old = self.page({'limit': 3})['page']['nextCursor']
        self.put(4); self.assertEqual(self.call({'cursor': old})['error']['code'], 'fact_page_changed')
        old = self.page({'limit': 4})['page']['nextCursor']
        for i in [4, 3, 2]:
            reply = self.call({'fact_id': f'{i:016x}', 'reason': 'opaque fixture removal'}, 'fact_revoke')
            self.assertTrue(reply['ok'], reply)
        self.assertEqual(self.call({'cursor': old})['error']['code'], 'fact_page_changed')

    def test_matching_asof_offset_equal_total_or_above_invalid(self):
        self.put(0); self.put(1)
        for offset in [2, 3]:
            self.assertEqual(self.call({'cursor': self.token(offset=offset)})['error']['code'], 'invalid_cursor')
        self.assertTrue(self.call({'cursor': self.token(offset=0)})['ok'])  # Cursor is not a credential.

    def test_syntax_project_scalars_checked_before_asof(self):
        self.put(0)
        tokens = ['!', 'A', 'a' * 1025, self.token(projectId='project-other'), self.token(extra='x'), self.token(offset=True),
                  self.token(offset=-1), self.token(offset=1 << 53), self.token(limit=0), self.token(v=True), self.token(asOf='g' * 64)]
        raw = '{"v":1,"v":1,"projectId":"project-page","asOf":"' + 'a'*64 + '","offset":0,"limit":64}'
        tokens.append(base64.urlsafe_b64encode(raw.encode()).decode().rstrip('='))
        mismatch = self.token(limit=3)
        with patch.object(r, 'fact', side_effect=AssertionError('asOf scan must not occur')):
            for token in tokens:
                with self.subTest(token=token): self.assertEqual(self.call({'cursor': token})['error']['code'], 'invalid_cursor')
            self.assertEqual(self.call({'cursor': mismatch, 'limit': 4})['error']['code'], 'invalid_cursor')

    def test_limit_options_and_whole_response_coverage(self):
        self.put(0); self.put(1)
        for limit in [None, True, 0, 65, 1.5, '1']:
            self.assertFalse(self.call({'limit': limit})['ok'])
        self.assertFalse(self.call({'path': '/opaque'})['ok'])
        self.assertTrue(self.page()['page']['allFactsIncluded'])
        one = self.page({'limit': 1}); two = self.page({'cursor': one['page']['nextCursor']})
        self.assertFalse(one['page']['allFactsIncluded']); self.assertFalse(two['page']['allFactsIncluded'])
        self.assertFalse(two['page']['hasMore']); self.assertEqual(two['page']['limit'], 1)


if __name__ == '__main__':
    unittest.main()
