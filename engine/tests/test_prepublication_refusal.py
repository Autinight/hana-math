"""Opaque storage boundary fixtures; no mathematical computation."""
import copy
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import uuid

from hana_math_engine import research as r
from danus.core import local_memory


class PrepublicationRefusalTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data = Path(tmp.name).resolve()
        self.root = self.data / 'context/projects/refusal/shared'
        self.control = self.root.parent / 'research/control'
        self.private = self.root.parent / 'research/run-fixture/worker/local_memory'
        self.req = {'schemaVersion': 1, 'requestId': str(uuid.uuid4()), 'operation': 'gm_add',
                    'context': {'projectId': 'refusal', 'runId': 'run-fixture', 'role': 'worker', 'author': 'opaque-fixture'},
                    'arguments': {'kind': 'plan', 'claim': 'opaque bounded storage fixture'}}

    def journal(self, req=None):
        return self.control / ((req or self.req)['requestId'] + '.json')

    def state(self):
        return json.loads(self.journal().read_bytes())

    def shared(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()} if self.root.exists() else {}

    def overflowing(self, core_error=None):
        original = r.execute
        def execute(root, private, req):
            result = original(root, private, req)
            (root / 'opaque-overflow.bin').write_bytes(b'x' * (r.MAX_JSON + 1))
            if core_error:
                raise core_error
            return result
        return execute

    def assert_unknown(self, response, code):
        self.assertFalse(response['ok'])
        self.assertEqual(response['error']['code'], code)
        self.assertEqual(response['error']['mutationState'], 'indeterminate')

    def test_natural_gm_refusal_closes_failure_after_cleanup_under_original_lock(self):
        for i in range(17):
            req = copy.deepcopy(self.req)
            req['requestId'] = str(uuid.uuid4())
            req['arguments'] = {'kind': 'dead_end', 'claim': 'opaque' + 'x' * 59994}
            self.assertTrue(r.dispatch(self.data, req)['ok'])
        self.req['arguments'] = {'kind': 'dead_end', 'claim': 'opaque eighteenth' + 'x' * 59983}
        before = self.shared()
        original, closed = r.atomic_write, []
        def write(path, data, **kwargs):
            packet = json.loads(data) if path == self.journal() else {}
            if packet.get('state') == 'ended':
                self.assertEqual(list(self.control.glob('core-*')), [])
                with (self.control / 'project.lock').open('rb') as handle:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertFalse(packet['response']['ok'])
                self.assertNotIn('mutationState', packet['response']['error'])
                closed.append(True)
            return original(path, data, **kwargs)
        with patch.object(r, 'atomic_write', write):
            response = r.dispatch(self.data, self.req)
        self.assertEqual(response, {'schemaVersion': 1, 'requestId': self.req['requestId'], 'ok': False,
                                   'error': {'code': 'size_limit', 'message': 'file exceeds 1 MiB'},
                                   'diagnostic': {'version': 1, 'reason': 'shared-other-file-bytes', 'observed': r.MAX_JSON + 1,
                                                  'observedLowerBound': True, 'limit': r.MAX_JSON, 'reserve': 0}})
        self.assertEqual(closed, [True])
        self.assertEqual(before, self.shared())
        self.assertEqual(self.state(), {'state': 'ended', 'fingerprint': hashlib.sha256(r.encoded(self.req)).hexdigest(), 'response': response})
        for operation, arguments in [('gm_search', {'query': 'opaque', 'limit_per_kind': 1}), ('fact_list', {}),
                                     ('gm_add', {'kind': 'plan', 'claim': 'opaque follow-up'})]:
            req = copy.deepcopy(self.req); req.update(requestId=str(uuid.uuid4()), operation=operation, arguments=arguments)
            self.assertTrue(r.dispatch(self.data, req)['ok'])
        req = copy.deepcopy(self.req); req['requestId'] = str(uuid.uuid4())
        again = r.dispatch(self.data, req)
        self.assertFalse(again['ok']); self.assertNotIn('mutationState', again['error'])
        self.assertEqual(json.loads(self.journal(req).read_bytes())['state'], 'ended')

    def test_confirmed_failure_replay_does_not_execute_and_conflict_is_rejected(self):
        with patch.object(r, 'execute', self.overflowing()):
            response = r.dispatch(self.data, self.req)
        self.assertNotIn('mutationState', response['error'])
        journal = self.journal().read_bytes()
        with patch.object(r, 'execute', side_effect=AssertionError('must not reexecute')) as execute:
            self.assertEqual(r.dispatch(self.data, self.req), response)
            conflict = copy.deepcopy(self.req); conflict['arguments']['claim'] = 'different opaque request'
            self.assertEqual(r.dispatch(self.data, conflict)['error']['code'], 'request_conflict')
            execute.assert_not_called()
        self.assertEqual(self.journal().read_bytes(), journal)

    def test_core_exception_preserves_original_partial_publication(self):
        original = r.execute
        def execute(root, private, req):
            original(root, private, req)
            raise OSError(errno.EIO, 'opaque Core failure after write')
        with patch.object(r, 'execute', execute):
            self.assert_unknown(r.dispatch(self.data, self.req), 'io_error')
        self.assertIn('global_memory/plan.jsonl', self.shared())
        self.assertEqual(self.state()['state'], 'started')

    def test_old_started_journal_remains_unchanged_and_is_not_recovered(self):
        with patch.object(r, 'execute', side_effect=OSError(errno.EIO, 'opaque old request failure')):
            self.assert_unknown(r.dispatch(self.data, self.req), 'io_error')
        before = self.journal().read_bytes()
        with patch.object(r, 'execute', side_effect=AssertionError('no historical replay')) as execute:
            self.assertEqual(r.dispatch(self.data, self.req)['error']['code'], 'indeterminate')
            execute.assert_not_called()
        self.assertEqual(self.journal().read_bytes(), before)
        self.assertEqual(self.state()['state'], 'started')

    def test_core_exception_plus_snapshot_limit_remains_indeterminate(self):
        with patch.object(r, 'execute', self.overflowing(OSError(errno.EIO, 'opaque Core error'))):
            self.assert_unknown(r.dispatch(self.data, self.req), 'size_limit')
        self.assertEqual(self.shared(), {})
        self.assertEqual(self.state()['state'], 'started')

    def test_private_inventory_non_size_refusal_is_not_reclassified(self):
        original = r.inventory
        def inventory(root, **kwargs):
            if root.name.startswith('core-'):
                raise r.Rejected('unsafe_path', 'opaque private inventory failure')
            return original(root, **kwargs)
        with patch.object(r, 'inventory', inventory):
            self.assert_unknown(r.dispatch(self.data, self.req), 'unsafe_path')
        self.assertEqual(self.shared(), {})
        self.assertEqual(self.state()['state'], 'started')

    def test_temporary_cleanup_failure_stays_indeterminate(self):
        original = r.tempfile.TemporaryDirectory
        class CleanupFailure(original):
            def __exit__(self, *args):
                super().__exit__(*args)
                raise OSError(errno.EIO, 'opaque temporary cleanup failure')
        with patch.object(r, 'execute', self.overflowing()), patch.object(r.tempfile, 'TemporaryDirectory', CleanupFailure):
            self.assert_unknown(r.dispatch(self.data, self.req), 'io_error')
        self.assertEqual(self.shared(), {})
        self.assertEqual(self.state()['state'], 'started')

    def test_failure_journal_write_failure_stays_indeterminate(self):
        original, hit = r.atomic_write, []
        def write(path, data, **kwargs):
            if path == self.journal() and json.loads(data).get('state') == 'ended':
                self.assertFalse(json.loads(data)['response']['ok'])
                hit.append(True)
                raise OSError(errno.EIO, 'opaque failure-journal write error')
            return original(path, data, **kwargs)
        with patch.object(r, 'execute', self.overflowing()), patch.object(r, 'atomic_write', write):
            self.assert_unknown(r.dispatch(self.data, self.req), 'io_error')
        self.assertEqual(hit, [True]); self.assertEqual(self.shared(), {})
        self.assertEqual(self.state()['state'], 'started')

    def test_failure_journal_post_replace_fsync_failure_is_not_confirmed(self):
        write_original, fsync_original, ending, hit = r.atomic_write, r.os.fsync, [False], []
        def write(path, data, **kwargs):
            ending[0] = path == self.journal() and json.loads(data).get('state') == 'ended'
            try:
                return write_original(path, data, **kwargs)
            finally:
                ending[0] = False
        def fsync(fd):
            if ending[0] and stat.S_ISDIR(os.fstat(fd).st_mode):
                hit.append(True)
                raise OSError(errno.EIO, 'opaque failure-journal directory fsync error')
            return fsync_original(fd)
        with patch.object(r, 'execute', self.overflowing()), patch.object(r, 'atomic_write', write), patch.object(r.os, 'fsync', fsync):
            self.assert_unknown(r.dispatch(self.data, self.req), 'io_error')
        self.assertEqual(hit, [True]); self.assertEqual(self.shared(), {})
        self.assertEqual(self.state()['state'], 'ended')
        self.assertFalse(self.state()['response']['ok'])

    def test_partial_publication_io_failure_remains_indeterminate(self):
        execute_original, write_original, published = r.execute, r.atomic_write, []
        def execute(root, private, req):
            result = execute_original(root, private, req)
            (root / 'opaque-extra.txt').write_text('opaque extra file')
            return result
        def write(path, data, **kwargs):
            if path.is_relative_to(self.root):
                if published:
                    raise OSError(errno.EIO, 'opaque second publication failure')
                result = write_original(path, data, **kwargs); published.append(path); return result
            return write_original(path, data, **kwargs)
        with patch.object(r, 'execute', execute), patch.object(r, 'atomic_write', write):
            self.assert_unknown(r.dispatch(self.data, self.req), 'io_error')
        self.assertEqual(len(published), 1); self.assertTrue(self.shared())
        self.assertEqual(self.state()['state'], 'started')

    def test_post_publication_response_limit_is_not_reclassified(self):
        original = r.execute
        def execute(root, private, req):
            original(root, private, req)
            return {'opaque': 'x' * r.MAX_JSON}
        with patch.object(r, 'execute', execute):
            self.assert_unknown(r.dispatch(self.data, self.req), 'size_limit')
        self.assertTrue(self.shared()); self.assertEqual(self.state()['state'], 'started')

    def test_oversized_success_journal_is_not_a_prepublication_refusal(self):
        original = r.execute
        def execute(root, private, req):
            original(root, private, req)
            base = {'schemaVersion': 1, 'requestId': req['requestId'], 'ok': True, 'result': {'opaque': ''}}
            return {'opaque': 'x' * (r.MAX_JSON - len(r.encoded(base)) - 16)}
        with patch.object(r, 'execute', execute):
            self.assert_unknown(r.dispatch(self.data, self.req), 'size_limit')
        self.assertTrue(self.shared()); self.assertEqual(self.state()['state'], 'started')

    def test_local_partial_append_is_not_reclassified(self):
        self.req.update(operation='local_memory_append', arguments={'text': 'opaque local note'})
        original = local_memory.append_jsonl
        def append(path, value):
            if path.name == 'events.jsonl':
                raise OSError(errno.EIO, 'opaque events mirror error')
            return original(path, value)
        with patch.object(local_memory, 'append_jsonl', append):
            self.assert_unknown(r.dispatch(self.data, self.req), 'io_error')
        self.assertTrue((self.private / 'notes.jsonl').exists())
        self.assertFalse((self.private / 'events.jsonl').exists())
        self.assertEqual(self.state()['state'], 'started')
