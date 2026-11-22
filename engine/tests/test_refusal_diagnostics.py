"""Isolated software byte/count/layout checks; no mathematical candidates."""
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch
from hana_math_engine import research as r


class RefusalDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name).resolve()
        self.project = self.data / 'context/projects/fixture'
        self.shared = self.project / 'shared'; self.shared.mkdir(parents=True)

    def request(self, operation='fact_list', arguments=None, role='main'):
        return {'schemaVersion': 1, 'requestId': str(uuid.uuid4()), 'operation': operation,
                'context': {'projectId': 'fixture', 'runId': 'run-fixture', 'role': role, 'author': 'fixture'}, 'arguments': arguments or {}}

    def caught(self, call):
        with self.assertRaises(r.Rejected) as error: call()
        return error.exception

    def check(self, value, reason, observed=None, lower=None, limit=None, reserve=None):
        self.assertEqual(value, {'version': 1, 'reason': reason, 'observed': observed,
                                'observedLowerBound': lower, 'limit': limit, 'reserve': reserve})
        self.assertLessEqual(len(r.encoded(value)), 2048)

    def test_file_categories_follow_logical_shared_scope_not_physical_parent(self):
        layouts = [('fact_graph/facts/' + 'a'*16 + '.md', 'shared-fact-bytes'),
                   ('fact_graph/glossary.json', 'shared-glossary-bytes'), ('global_memory/verification.jsonl', 'shared-verification-bytes'),
                   ('fact_graph/_revoked/' + 'a'*16 + '.md', 'shared-other-file-bytes'),
                   ('global_memory/plan.jsonl', 'shared-other-file-bytes'), ('glossary.json', 'shared-other-file-bytes'),
                   ('fact_graph/facts/NOT-A-FACT.md', 'shared-other-file-bytes')]
        for index, (relative, reason) in enumerate(layouts):
            root = self.data / f'control/core-fixture-{index}'
            file = root / relative; file.parent.mkdir(parents=True); file.write_bytes(b'x' * 1000)
            with patch.object(r, 'MAX_JSON', 32):
                error = self.caught(lambda: r.inventory(root, _shared=True))
                self.check(error.diagnostic, reason, 33, True, 32, 0)
                private = self.caught(lambda: r.inventory(root))
                self.check(private.diagnostic, 'other-file-bytes', 33, True, 32, 0)
            self.assertNotIn(str(root), json.dumps(error.diagnostic))

    def test_read_lower_bound_and_atomic_buffer_measurements(self):
        file = self.data / 'opaque'; file.write_bytes(b'x' * 1000)
        with patch.object(r, 'MAX_JSON', 32):
            self.check(self.caught(lambda: r.read_bytes(file)).diagnostic, 'other-file-bytes', 33, True, 32, 0)
            self.check(self.caught(lambda: r.atomic_write(self.data / 'not-created', b'x' * 100)).diagnostic,
                       'other-file-bytes', 100, False, 32, 0)
        self.assertFalse((self.data / 'not-created').exists())
        self.assertEqual(file.read_bytes(), b'x' * 1000)

    def test_canonical_fact_direct_read_has_shared_category(self):
        fid = 'a'*16; file = self.shared / 'fact_graph/facts' / (fid + '.md'); file.parent.mkdir(parents=True)
        file.write_bytes(b'x' * 1000)
        with patch.object(r, 'MAX_JSON', 32):
            self.check(self.caught(lambda: r.fact(self.shared, fid)).diagnostic, 'shared-fact-bytes', 33, True, 32, 0)

    def test_shared_tree_dimensions_and_current_uninserted_file(self):
        for name in ['a', 'b']: (self.shared / name).write_bytes(b'xxx')
        with patch.object(r, 'MAX_TREE_FILES', 1):
            self.check(self.caught(lambda: r.inventory(self.shared, _shared=True)).diagnostic, 'shared-tree-files', 2, True, 1, 0)
            self.assertIsNone(self.caught(lambda: r.inventory(self.shared)).diagnostic)
        with patch.object(r, 'MAX_TREE_BYTES', 4):
            self.check(self.caught(lambda: r.inventory(self.shared, _shared=True)).diagnostic, 'shared-tree-bytes', 6, True, 4, 0)
            self.assertIsNone(self.caught(lambda: r.inventory(self.shared)).diagnostic)
        with patch.object(r, 'MAX_TREE_ENTRIES', 1):
            self.check(self.caught(lambda: r.inventory(self.shared, _shared=True)).diagnostic, 'shared-tree-entries', 2, True, 1, 0)
            self.assertIsNone(self.caught(lambda: r.inventory(self.shared)).diagnostic)

    def test_private_inventory_aggregate_refusal_has_no_shared_diagnostic(self):
        private = self.project / 'research/run-fixture/worker/local_memory'; private.mkdir(parents=True)
        for name in ['notes.jsonl', 'events.jsonl']: (private / name).write_bytes(b'xxx')
        with patch.object(r, 'MAX_TREE_FILES', 1), patch.object(r, 'execute') as execute:
            response = r.dispatch(self.data, self.request('local_memory_read', role='worker'))
            self.assertFalse(response['ok']); self.assertEqual(response['error']['code'], 'size_limit')
            self.assertNotIn('diagnostic', response); execute.assert_not_called()

    def test_control_early_counts_are_lower_bounds_without_reserve(self):
        control = self.data / 'control'; control.mkdir(); (control / 'a').write_bytes(b'x'*20); (control / 'b').write_bytes(b'x'*20)
        with patch.object(r, 'MAX_CONTROL_BYTES', 10):
            self.check(self.caught(lambda: r.check_control_capacity(control, 'gm_add')).diagnostic, 'control-bytes', 20, True, 10, 0)
        with patch.object(r, 'MAX_CONTROL_ENTRIES', 1):
            self.check(self.caught(lambda: r.check_control_capacity(control, 'fact_list')).diagnostic, 'control-entries', 2, True, 1, 0)

    def test_control_completed_base_and_operation_reserves_separate(self):
        control = self.data / 'control'; control.mkdir(); (control / 'a').write_bytes(b'x'*20)
        for operation, reserve_bytes, reserve_entries in [('gm_add', r.CONTROL_SNAPSHOT_RESERVE_BYTES, r.CONTROL_SNAPSHOT_RESERVE_ENTRIES),
                                                         ('local_memory_append', 2*r.MAX_JSON, 4)]:
            with patch.object(r, 'MAX_CONTROL_BYTES', 21):
                self.check(self.caught(lambda: r.check_control_capacity(control, operation)).diagnostic, 'control-bytes', 20, False, 21, reserve_bytes)
                r.check_control_capacity(control, 'fact_list')
            with patch.object(r, 'MAX_CONTROL_ENTRIES', 2):
                self.check(self.caught(lambda: r.check_control_capacity(control, operation)).diagnostic, 'control-entries', 1, False, 2, reserve_entries)
                r.check_control_capacity(control, 'fact_get')

    def test_local_append_timestamp_estimate_is_reserve_not_occupancy(self):
        private = self.data / 'private'; private.mkdir(); (private / 'notes.jsonl').write_bytes(b'{}\n')
        record = {'requestId': 'opaque', 'author': 'fixture', 'text': 'x' * 90}
        reserve = len((json.dumps({'timestamp_utc': '0'*32, 'channel': 'notes', 'record': record}, ensure_ascii=False) + '\n').encode())
        with patch.object(r, 'MAX_JSON', 128):
            self.check(self.caught(lambda: r.check_local_files(private, record)).diagnostic, 'other-file-bytes', 3, False, 128, reserve)
        self.assertEqual((private / 'notes.jsonl').read_bytes(), b'{}\n'); self.assertFalse((private / 'events.jsonl').exists())

    def test_response_measurement_exact_and_error_shape_unchanged(self):
        request = self.request(); payload = {'opaque': 'x' * r.MAX_JSON}
        expected = len(r.encoded({'schemaVersion': 1, 'requestId': request['requestId'], 'ok': True, 'result': payload}))
        with patch.object(r, 'execute', return_value=payload): response = r.dispatch(self.data, request)
        self.assertEqual(response['error'], {'code': 'size_limit', 'message': 'result exceeds 1 MiB; not truncated'})
        self.assertNotIn('result', response); self.check(response['diagnostic'], 'response-bytes', expected, False, r.MAX_JSON, 0)

    def test_pagination_diagnostics_and_page_budget(self):
        invalid = r.dispatch(self.data, self.request('fact_list_page', {'cursor': '!'}))
        self.check(invalid['diagnostic'], 'invalid-cursor')
        facts = self.shared / 'fact_graph/facts'; facts.mkdir(parents=True)
        for index in range(2):
            fid = f'{index:016x}'; (facts / (fid + '.md')).write_text(f'---\nfact_id: {fid}\npredecessors: []\n---\n## statement\nopaque\n## proof\nopaque\n')
        first = r.dispatch(self.data, self.request('fact_list_page', {'limit': 1}))['result']
        (facts / ('0'*16 + '.md')).write_bytes((facts / ('0'*16 + '.md')).read_bytes() + b'\nopaque metadata')
        changed = r.dispatch(self.data, self.request('fact_list_page', {'cursor': first['page']['nextCursor']}))
        self.check(changed['diagnostic'], 'fact-page-changed'); self.assertNotIn('result', changed)
        with patch.object(r, 'FACT_PAGE_BYTES', 80):
            response = r.dispatch(self.data, self.request('fact_list_page'))
        self.assertEqual(response['error']['code'], 'size_limit'); d = response['diagnostic']
        self.assertEqual(d['reason'], 'fact-page-bytes'); self.assertGreater(d['observed'], 80)
        self.assertEqual((d['observedLowerBound'], d['limit'], d['reserve']), (False, 80, 0))

    def test_prepublication_and_started_classification_unchanged(self):
        request = self.request('gm_add', {'kind': 'plan', 'claim': 'opaque fixture'})
        original = r.execute
        def overflow(root, private, req):
            value = original(root, private, req); (root / 'opaque').write_bytes(b'x' * (r.MAX_JSON + 10)); return value
        with patch.object(r, 'execute', overflow): response = r.dispatch(self.data, request)
        self.assertNotIn('mutationState', response['error']); self.check(response['diagnostic'], 'shared-other-file-bytes', r.MAX_JSON + 1, True, r.MAX_JSON, 0)
        journal = self.project / 'research/control' / (request['requestId'] + '.json')
        self.assertEqual(json.loads(journal.read_bytes())['state'], 'ended')
        self.assertEqual(r.dispatch(self.data, request), response)  # at-refusal replay, not a new usage measurement.
        second = self.request('gm_add', {'kind': 'plan', 'claim': 'opaque second'})
        def partial(root, private, req): overflow(root, private, req); raise OSError('opaque error')
        with patch.object(r, 'execute', partial): failed = r.dispatch(self.data, second)
        self.assertEqual(failed['error']['mutationState'], 'indeterminate')
        self.assertEqual(failed['diagnostic']['reason'], 'shared-other-file-bytes')
        self.assertEqual(json.loads((journal.parent / (second['requestId'] + '.json')).read_bytes())['state'], 'started')

    def test_unavailable_measurements_and_nonresource_refusals(self):
        self.check(r.refusal_diagnostic('other-file-bytes', 1 << 60, True, float('inf'), -1), 'other-file-bytes')
        self.check(r.refusal_diagnostic('other-file-bytes', 12, None), 'other-file-bytes')
        with patch.object(r, 'execute', side_effect=r.Rejected('busy', 'opaque')):
            response = r.dispatch(self.data, self.request())
        self.assertEqual(response['error'], {'code': 'busy', 'message': 'opaque'}); self.assertNotIn('diagnostic', response)


if __name__ == '__main__': unittest.main()
