"""Opaque software fixtures only; fixture receipts assert no mathematical facts."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from hana_math_engine import research as r
from danus.core.factgraph import FactGraph
from danus.core.global_memory import GlobalMemory
from danus.core import local_memory

CANDIDATE = {'statement': 'opaque software fixture statement',
             'proof': 'opaque software fixture payload with several distinct tokens only'}
FIXTURE_REPORT = {'verification_report': {'summary': 'software fixture verifier only',
                                         'critical_errors': [], 'gaps': []},
                  'verdict': 'correct', 'repair_hints': ''}


class ResearchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name).resolve()

    def request(self, op, args=None, role='worker', run='run-a', project='project-a', worker=None):
        context = {'projectId': project, 'runId': run, 'role': role, 'author': 'fixture-worker'}
        if worker is not None:
            context['workerId'] = worker
        return {'schemaVersion': 1, 'requestId': str(uuid.uuid4()), 'operation': op,
                'context': context, 'arguments': copy.deepcopy(args or {})}

    def call(self, op, args=None, **kw):
        return r.dispatch(self.data, self.request(op, args, **kw))

    def submission(self, args=None, **context):
        args = copy.deepcopy(args or CANDIDATE)
        request = self.request('fact_submit', args, **context)
        prep = copy.deepcopy(request)
        prep['operation'] = 'prepare_submission'
        prep['requestId'] = str(uuid.uuid4())
        receipt = r.dispatch(self.data, prep)
        self.assertTrue(receipt['ok'], receipt)
        result = receipt['result']
        request['verification'] = {'candidateDigest': result['candidateDigest'],
                                   'predecessorDigests': result['predecessorDigests'],
                                   'verifierSessionId': 'fixture-verifier',
                                   'report': copy.deepcopy(FIXTURE_REPORT)}
        return request

    def add(self, args=None):
        response = r.dispatch(self.data, self.submission(args))
        self.assertTrue(response['ok'], response)
        self.assertTrue(response['result']['accepted'])
        return response['result']['fact_id']

    @property
    def shared(self):
        return self.data / 'context/projects/project-a/shared'

    def test_prepare_does_not_write_fact(self):
        response = self.call('prepare_submission', CANDIDATE)
        self.assertTrue(response['result']['precheck']['passed'])
        self.assertEqual(response['result']['predecessorDigests'], {})
        self.assertFalse((self.shared / 'fact_graph').exists())

    def test_complete_markdown_result_and_project_isolation(self):
        fid = self.add({**CANDIDATE, 'intuition': 'opaque trailing fixture content'})
        result = self.call('fact_get', {'fact_id': fid}, role='verifier')['result']
        self.assertEqual(result['markdown'], (self.shared / f'fact_graph/facts/{fid}.md').read_text())
        self.assertIn('opaque trailing fixture content', result['markdown'])
        self.assertEqual(self.call('fact_list')['result']['facts'], [result])
        self.assertEqual(self.call('fact_get', {'fact_id': fid}, project='other')['error']['code'], 'not_found')

    def test_missing_verification_and_precheck(self):
        self.assertEqual(self.call('fact_submit', CANDIDATE)['error']['code'], 'verification_required')
        prep = self.call('prepare_submission', {**CANDIDATE, 'proof': 'opaque'})
        self.assertFalse(prep['result']['precheck']['passed'])
        req = self.submission({**CANDIDATE, 'proof': 'opaque'})
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'precheck_rejected')

    def test_wrong_report_is_not_accepted(self):
        req = self.submission()
        req['verification']['report'] = {'verification_report': {'summary': 'fixture rejected',
            'critical_errors': [], 'gaps': [{'location': 'fixture', 'issue': 'opaque missing token'}]},
            'verdict': 'wrong', 'repair_hints': 'replace opaque fixture token'}
        result = r.dispatch(self.data, req)
        self.assertTrue(result['ok'], result)
        self.assertFalse(result['result']['accepted'])
        self.assertEqual(result['result']['verdict'], 'wrong')
        self.assertFalse((self.shared / 'fact_graph').exists())

    def test_report_contradictions_and_extra_fields(self):
        cases = []
        for changes in ({'verdict': 'wrong'}, {'repair_hints': 'unexpected'}, {'extra': True}):
            report = copy.deepcopy(FIXTURE_REPORT)
            report.update(changes)
            cases.append(report)
        report = copy.deepcopy(FIXTURE_REPORT)
        report['verification_report']['critical_errors'] = [{'location': 'fixture', 'issue': 'error'}]
        cases.append(report)
        report = copy.deepcopy(FIXTURE_REPORT)
        report['verification_report']['gaps'] = ['not an issue object']
        cases.append(report)
        for report in cases:
            with self.subTest(report=report):
                req = self.submission()
                req['verification']['report'] = report
                self.assertFalse(r.dispatch(self.data, req)['ok'])

    def test_digest_binds_all_args_and_context(self):
        for field, value in [('proof', 'different opaque software fixture proof payload words'),
                             ('intuition', 'opaque'), ('source_id', 'https://invalid.invalid/data'),
                             ('external_refs', [{'url': 'file:///not-read'}])]:
            req = self.submission()
            req['arguments'][field] = value
            self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'digest_mismatch')
        req = self.submission()
        req['context']['runId'] = 'different-run'
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'digest_mismatch')

    def test_predecessors_missing_duplicates_changed_and_revoked(self):
        missing = {**CANDIDATE, 'predecessors': ['0' * 16]}
        self.assertEqual(self.call('prepare_submission', missing)['error']['code'], 'not_found')
        fid = self.add()
        args = {**CANDIDATE, 'predecessors': [fid, fid]}
        self.assertFalse(self.call('prepare_submission', args)['ok'])
        args['predecessors'] = [fid]
        req = self.submission(args)
        path = self.shared / f'fact_graph/facts/{fid}.md'
        path.write_text(path.read_text() + '\nopaque metadata change\n')
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'stale_verification')
        req = self.submission(args)
        self.assertTrue(self.call('fact_revoke', {'fact_id': fid, 'reason': 'fixture'}, role='main')['ok'])
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'stale_verification')

    def test_receipt_snapshot_and_child(self):
        fid = self.add()
        req = self.submission({**CANDIDATE, 'predecessors': [fid]})
        expected = hashlib.sha256((self.shared / f'fact_graph/facts/{fid}.md').read_bytes()).hexdigest()
        self.assertEqual(req['verification']['predecessorDigests'], {fid: expected})
        result = r.dispatch(self.data, req)
        self.assertTrue(result['ok'], result)
        child = result['result']['fact_id']
        self.assertEqual(self.call('fact_get', {'fact_id': child})['result']['predecessors'], [fid])

    def test_role_enforcement(self):
        for role in ('main', 'verifier', 'all', 'unknown'):
            for op in ('prepare_submission', 'fact_submit', 'local_memory_read', 'local_memory_append'):
                with self.subTest(role=role, op=op):
                    self.assertEqual(self.call(op, CANDIDATE, role=role)['error']['code'], 'forbidden')
        self.assertEqual(self.call('fact_revoke', {'fact_id': '0'*16, 'reason': 'fixture'})['error']['code'], 'forbidden')
        self.assertEqual(self.call('gm_search', {'query': 'opaque'}, role='verifier')['error']['code'], 'forbidden')

    def test_no_extra_candidate_selectors(self):
        for key in ('path', 'root', 'author', 'role', 'project', 'verification', 'VERIFY_MIN_PROOF_CHARS'):
            self.assertFalse(self.call('prepare_submission', {**CANDIDATE, key: 'opaque'})['ok'])

    def test_context_and_id_path_rejection(self):
        for key in ('projectId', 'runId', 'author'):
            for value in ('../escape', '/absolute', 'bad\nfield', '', 'x' * 129):
                req = self.request('fact_list')
                req['context'][key] = value
                self.assertFalse(r.dispatch(self.data, req)['ok'])
        self.assertFalse(self.call('fact_get', {'fact_id': '../anything'})['ok'])
        self.assertFalse(self.call('gm_search', {'query': 'opaque', 'kinds': ['../../elsewhere']})['ok'])

    def test_glossary_and_field_limits(self):
        for gloss in ({'key\nspoof': 'value'}, {'key: spoof': 'value'}, {'key': 'value\nspoof: yes'},
                      {'key': '---\n'}, {'key': '# comment'}, {'key': 'value\u2028new'}):
            self.assertFalse(self.call('prepare_submission', {**CANDIDATE, 'glossary_introduces': gloss})['ok'])
        self.assertTrue(self.call('prepare_submission', {**CANDIDATE, 'glossary_introduces': {'token': 'opaque label'}})['ok'])
        self.assertFalse(self.call('prepare_submission', {**CANDIDATE, 'proof': 'x'*(r.MAX_TEXT+1)})['ok'])
        self.assertFalse(self.call('prepare_submission', {**CANDIDATE, 'external_refs': [{}]*129})['ok'])

    def test_symlink_and_nonregular(self):
        self.call('fact_list')
        (self.shared / 'linked').symlink_to(self.data)
        self.assertEqual(self.call('fact_list')['error']['code'], 'unsafe_path')
        (self.shared / 'linked').unlink()
        os.mkfifo(self.shared / 'pipe')
        self.assertEqual(self.call('fact_list')['error']['code'], 'unsafe_path')

    def test_ancestor_symlink(self):
        (self.data / 'context').symlink_to(self.data, target_is_directory=True)
        self.assertEqual(self.call('fact_list')['error']['code'], 'unsafe_path')

    def test_logical_worker_memory_survives_runs_with_upstream_format(self):
        first = self.request('local_memory_append', {'text': 'opaque first note'}, worker='worker-a')
        one = r.dispatch(self.data, first)
        self.assertTrue(one['ok'], one)
        private = self.data / 'context/projects/project-a/workers/worker-a/local_memory'
        original_notes = (private / 'notes.jsonl').read_bytes()
        control = self.data / 'context/projects/project-a/research/control'
        journal = control / (first['requestId'] + '.json')
        original_journal = journal.read_bytes()
        self.assertEqual(self.call('local_memory_read', run='run-b', worker='worker-a')['result'], one['result'])
        self.assertEqual((private / 'notes.jsonl').read_bytes(), original_notes)
        second = self.request('local_memory_append', {'text': 'opaque second note'}, run='run-b', worker='worker-a')
        two = r.dispatch(self.data, second)
        self.assertTrue(two['ok'], two)
        expected = [{'requestId': request['requestId'], 'author': 'fixture-worker', 'text': request['arguments']['text']}
                    for request in (first, second)]
        self.assertEqual(two['result'], {'entries': expected})
        self.assertTrue((private / 'notes.jsonl').read_bytes().startswith(original_notes))
        memory = local_memory.LocalMemory(private.parent)
        notes, events = memory.read('notes'), memory.read('events')
        self.assertEqual([note['record'] for note in notes], expected)
        self.assertTrue(all(set(note) == {'timestamp_utc', 'channel', 'record'} for note in notes))
        self.assertEqual([event['event_type'] for event in events], ['local_append', 'local_append'])
        self.assertEqual({p.name for p in private.iterdir()}, {'notes.jsonl', 'events.jsonl'})
        self.assertEqual(journal.read_bytes(), original_journal)
        self.assertTrue((control / (second['requestId'] + '.json')).is_file())
        self.assertFalse((self.data / 'context/projects/project-a/research/run-a/worker').exists())
        self.assertFalse((self.data / 'context/projects/project-a/research/run-b/worker').exists())
        self.assertEqual(r.dispatch(self.data, first), one)
        self.assertEqual(memory.read('notes'), notes)
        self.assertEqual(memory.read('events'), events)

    def test_logical_worker_project_and_legacy_memory_are_isolated(self):
        persistent = self.call('local_memory_append', {'text': 'opaque persistent note'}, worker='worker-a')
        self.assertTrue(persistent['ok'], persistent)
        for context in ({'worker': 'worker-b'}, {'worker': 'worker-a', 'project': 'project-b'}, {}):
            with self.subTest(context=context):
                self.assertEqual(self.call('local_memory_read', **context)['result'], {'entries': []})
        legacy = self.call('local_memory_append', {'text': 'opaque legacy note'})
        self.assertTrue(legacy['ok'], legacy)
        legacy_path = self.data / 'context/projects/project-a/research/run-a/worker/local_memory/notes.jsonl'
        legacy_bytes = legacy_path.read_bytes()
        self.assertEqual(self.call('local_memory_read', run='run-b', worker='worker-a')['result'], persistent['result'])
        self.assertEqual(self.call('local_memory_read', run='run-b')['result'], {'entries': []})
        self.assertEqual(self.call('local_memory_read')['result'], legacy['result'])
        self.assertEqual(legacy_path.read_bytes(), legacy_bytes)

    def test_worker_id_is_worker_only_and_not_a_path_selector(self):
        for role in ('main', 'verifier'):
            for operation in ('fact_list', 'local_memory_read', 'local_memory_append'):
                with self.subTest(role=role, operation=operation):
                    response = self.call(operation, role=role, worker='worker-a')
                    self.assertEqual(response['error']['code'], 'forbidden')
        for value in (None, True, 7, {}, [], '', '.', '..', '../outside', '/absolute',
                      'worker/id', 'worker\\id', 'worker_id', 'Worker', 'é', 'worker\n', 'a\x00b', 'x' * 65):
            with self.subTest(workerId=value):
                req = self.request('local_memory_read')
                req['context']['workerId'] = value
                self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'invalid_request')
        for key in ('path', 'privateDir', 'root'):
            req = self.request('local_memory_read', worker='worker-a')
            req['context'][key] = '/opaque/not-read'
            self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'invalid_request')
        self.assertFalse((self.data / 'context').exists())
        for value in ('0', 'a' * 64):
            self.assertTrue(self.call('local_memory_read', worker=value)['ok'])
        for args in ({'workerId': 'other'}, {'privateDir': '/opaque/not-read'}):
            self.assertFalse(self.call('local_memory_read', args, worker='worker-a')['ok'])

    def test_logical_worker_fresh_run_accepts_project_shared_predecessor(self):
        # Opaque protocol fixtures: the trusted fake report is not mathematical evidence.
        first = self.submission(run='run-a', worker='worker-1')
        accepted_parent = r.dispatch(self.data, first)
        self.assertTrue(accepted_parent['ok'], accepted_parent)
        self.assertTrue(accepted_parent['result']['accepted'])
        parent = accepted_parent['result']['fact_id']
        parent_path = self.shared / f'fact_graph/facts/{parent}.md'
        parent_bytes = parent_path.read_bytes()
        note = self.call('local_memory_append', {'text': 'opaque run-a fixture note'},
                         run='run-a', worker='worker-1')
        self.assertTrue(note['ok'], note)
        private = self.data / 'context/projects/project-a/workers/worker-1/local_memory'
        notes_before = (private / 'notes.jsonl').read_bytes()

        args = {**CANDIDATE, 'statement': 'opaque software fixture child statement',
                'predecessors': [parent]}
        # submission calls the real dispatcher prepare in the fresh run-b context.
        second = self.submission(args, run='run-b', worker='worker-1')
        self.assertNotEqual(first['requestId'], second['requestId'])
        self.assertEqual(first['context'], {'projectId': 'project-a', 'runId': 'run-a',
                         'role': 'worker', 'author': 'fixture-worker', 'workerId': 'worker-1'})
        self.assertEqual(second['context'], {**first['context'], 'runId': 'run-b'})
        receipt = second['verification']
        self.assertTrue(receipt['predecessorDigests'])
        self.assertEqual(receipt['predecessorDigests'],
                         {parent: hashlib.sha256(parent_bytes).hexdigest()})
        self.assertEqual(receipt['candidateDigest'], hashlib.sha256(r.encoded({
            'context': second['context'], 'arguments': args})).hexdigest())
        self.assertNotEqual(receipt['candidateDigest'], hashlib.sha256(r.encoded({
            'context': first['context'], 'arguments': args})).hexdigest())

        accepted_child = r.dispatch(self.data, second)
        self.assertTrue(accepted_child['ok'], accepted_child)
        self.assertTrue(accepted_child['result']['accepted'])
        child = accepted_child['result']['fact_id']
        self.assertNotEqual(child, parent)
        fetched = self.call('fact_get', {'fact_id': child}, run='run-b', worker='worker-1')
        self.assertTrue(fetched['ok'], fetched)
        self.assertEqual(fetched['result']['predecessors'], [parent])
        self.assertEqual(fetched['result']['markdown'],
                         (self.shared / f'fact_graph/facts/{child}.md').read_text())
        self.assertIn(parent, fetched['result']['markdown'])
        self.assertEqual(parent_path.read_bytes(), parent_bytes)
        self.assertEqual((private / 'notes.jsonl').read_bytes(), notes_before)
        self.assertEqual(self.call('local_memory_read', run='run-b', worker='worker-1')['result'], note['result'])
        second_note = self.call('local_memory_append', {'text': 'opaque run-b fixture note'},
                                run='run-b', worker='worker-1')
        self.assertTrue(second_note['ok'], second_note)
        self.assertEqual(len(second_note['result']['entries']), 2)
        self.assertEqual(self.call('local_memory_read', run='run-a', worker='worker-1')['result'],
                         second_note['result'])
        self.assertFalse((self.data / 'context/projects/project-a/research/run-a/worker').exists())
        self.assertFalse((self.data / 'context/projects/project-a/research/run-b/worker').exists())

    def test_logical_worker_receipt_binds_full_context_and_predecessor_snapshot(self):
        parent = self.add()
        args = {**CANDIDATE, 'predecessors': [parent]}
        request = self.submission(args, worker='worker-a')
        receipt = request['verification']
        self.assertEqual(receipt['candidateDigest'], hashlib.sha256(r.encoded({
            'context': request['context'], 'arguments': args})).hexdigest())
        parent_path = self.shared / f'fact_graph/facts/{parent}.md'
        self.assertEqual(receipt['predecessorDigests'], {parent: hashlib.sha256(parent_path.read_bytes()).hexdigest()})
        for change in ({'runId': 'run-b'}, {'workerId': 'worker-b'}, {'workerId': None}):
            req = copy.deepcopy(request)
            req['requestId'] = str(uuid.uuid4())
            if change.get('workerId', '') is None:
                del req['context']['workerId']
            else:
                req['context'].update(change)
            self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'digest_mismatch')
        legacy = self.submission(args)
        legacy['context']['workerId'] = 'worker-a'
        self.assertEqual(r.dispatch(self.data, legacy)['error']['code'], 'digest_mismatch')
        accepted = r.dispatch(self.data, request)
        self.assertTrue(accepted['ok'], accepted)
        self.assertTrue(accepted['result']['accepted'])
        stale = self.submission(args, worker='worker-a', run='run-b')
        parent_path.write_bytes(parent_path.read_bytes() + b'\nopaque changed predecessor metadata\n')
        self.assertEqual(r.dispatch(self.data, stale)['error']['code'], 'stale_verification')

    def test_logical_worker_journal_rejects_cross_run_worker_and_legacy_reuse(self):
        request = self.request('local_memory_append', {'text': 'opaque journal fixture'}, worker='worker-a')
        response = r.dispatch(self.data, request)
        self.assertTrue(response['ok'], response)
        journal = self.data / 'context/projects/project-a/research/control' / (request['requestId'] + '.json')
        original = journal.read_bytes()
        self.assertEqual(r.dispatch(self.data, request), response)
        for changed in ('run', 'worker', 'legacy'):
            req = copy.deepcopy(request)
            if changed == 'run':
                req['context']['runId'] = 'run-b'
            elif changed == 'worker':
                req['context']['workerId'] = 'worker-b'
            else:
                del req['context']['workerId']
            self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'request_conflict')
            self.assertEqual(journal.read_bytes(), original)
        self.assertEqual(len(self.call('local_memory_read', run='run-b', worker='worker-a')['result']['entries']), 1)
        self.assertFalse((self.data / 'context/projects/project-a/workers/worker-b').exists())
        other_project = copy.deepcopy(request)
        other_project['context']['projectId'] = 'project-b'
        self.assertTrue(r.dispatch(self.data, other_project)['ok'])
        self.assertTrue((self.data / 'context/projects/project-b/research/control' / (request['requestId'] + '.json')).is_file())
        self.assertEqual(journal.read_bytes(), original)

    def test_logical_worker_memory_rejects_symlink_ancestors(self):
        for index, suffix in enumerate(('workers', 'workers/worker-a', 'workers/worker-a/local_memory')):
            project = f'linked-{index}'
            root = self.data / 'context/projects' / project
            link = root / suffix
            link.parent.mkdir(parents=True)
            outside = self.data / f'opaque-outside-{index}'
            outside.mkdir()
            link.symlink_to(outside, target_is_directory=True)
            for operation in ('local_memory_read', 'local_memory_append'):
                response = self.call(operation, {'text': 'opaque'} if operation.endswith('append') else {},
                                     project=project, worker='worker-a')
                self.assertEqual(response['error']['code'], 'unsafe_path')
            self.assertEqual(list(outside.iterdir()), [])

    def test_private_memory_and_private_symlink(self):
        args = {'text': 'opaque private fixture'}
        self.assertTrue(self.call('local_memory_append', args)['ok'])
        self.assertEqual(len(self.call('local_memory_read')['result']['entries']), 1)
        self.assertEqual(self.call('local_memory_read', run='run-b')['result']['entries'], [])
        self.assertEqual(self.call('local_memory_read', project='project-b')['result']['entries'], [])
        self.assertFalse(self.call('local_memory_read', {'runId': 'run-a'}, run='run-b')['ok'])
        path = self.data / 'context/projects/project-a/research/run-a/worker/local_memory/notes.jsonl'
        path.unlink()
        path.symlink_to(self.data / 'outside')
        self.assertEqual(self.call('local_memory_read')['error']['code'], 'unsafe_path')

    @property
    def private(self):
        return self.data / 'context/projects/project-a/research/run-a/worker/local_memory'

    def test_local_upstream_jsonl_and_events_mirror(self):
        req = self.request('local_memory_append', {'text': 'opaque fixture\nsecond opaque line'})
        response = r.dispatch(self.data, req)
        self.assertTrue(response['ok'], response)
        expected = {'requestId': req['requestId'], 'author': req['context']['author'],
                    'text': req['arguments']['text']}
        self.assertEqual(response['result'], {'entries': [expected]})
        self.assertEqual({p.name for p in self.private.iterdir()}, {'notes.jsonl', 'events.jsonl'})
        notes = (self.private / 'notes.jsonl').read_text().splitlines()
        events = (self.private / 'events.jsonl').read_text().splitlines()
        self.assertEqual(len(notes), 1)
        self.assertEqual(len(events), 1)
        note, event = json.loads(notes[0]), json.loads(events[0])
        self.assertEqual(set(note), {'timestamp_utc', 'channel', 'record'})
        self.assertEqual(note['channel'], 'notes')
        self.assertEqual(note['record'], expected)
        self.assertEqual(set(event), {'timestamp_utc', 'event_type', 'channel'})
        self.assertEqual(event['channel'], 'notes')
        self.assertEqual(event['event_type'], 'local_append')
        memory = local_memory.LocalMemory(self.private.parent)
        self.assertEqual(memory.read('notes'), [note])
        self.assertEqual(memory.read('events'), [event])
        self.assertEqual(self.call('local_memory_read')['result'], {'entries': [expected]})
        # A completed replay adds neither a note nor another audit breadcrumb.
        self.assertEqual(r.dispatch(self.data, req), response)
        self.assertEqual(memory.read('notes'), [note])
        self.assertEqual(memory.read('events'), [event])

    def test_local_reads_original_notes_not_memory_json(self):
        self.private.mkdir(parents=True)
        original = {'text': 'opaque original upstream fixture', 'custom': 'opaque field'}
        local_memory.LocalMemory(self.private.parent).append('notes', original)
        self.assertFalse((self.private / 'memory.json').exists())
        # An old, noncanonical file is not a data source or migration trigger.
        obsolete = self.private / 'memory.json'
        obsolete.write_text('[{"text":"opaque obsolete format"}]')
        before = obsolete.read_bytes()
        self.assertEqual(self.call('local_memory_read')['result'], {'entries': [original]})
        self.assertTrue(self.call('local_memory_append', {'text': 'opaque new note'})['ok'])
        self.assertEqual(obsolete.read_bytes(), before)
        self.assertEqual(len(local_memory.LocalMemory(self.private.parent).read('events')), 2)

    def test_local_events_failure_is_partial_and_indeterminate(self):
        req = self.request('local_memory_append', {'text': 'opaque partial append fixture'})
        append = local_memory.append_jsonl
        def fail_events(path, payload):
            if path.name == 'events.jsonl':
                raise OSError('fixture events append failure')
            return append(path, payload)
        with patch.object(local_memory, 'append_jsonl', side_effect=fail_events):
            response = r.dispatch(self.data, req)
        self.assertEqual(response['error']['code'], 'io_error')
        self.assertEqual(response['error']['mutationState'], 'indeterminate')
        notes = (self.private / 'notes.jsonl').read_bytes()
        self.assertEqual(len(notes.splitlines()), 1)
        self.assertFalse((self.private / 'events.jsonl').exists())
        self.assertFalse((self.private / 'memory.json').exists())
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'indeterminate')
        self.assertEqual((self.private / 'notes.jsonl').read_bytes(), notes)
        self.assertFalse((self.private / 'events.jsonl').exists())
        self.assertEqual(len(self.call('local_memory_read')['result']['entries']), 1)

    def test_local_fixed_channels_preflight(self):
        for channel in ('notes', 'events'):
            for mode in ('symlink', 'directory', 'oversize', 'near_limit'):
                with self.subTest(channel=channel, mode=mode):
                    run = channel + '-' + mode.replace('_', '-')
                    private = self.private.parents[2] / run / 'worker/local_memory'
                    private.mkdir(parents=True)
                    path = private / (channel + '.jsonl')
                    if mode == 'symlink':
                        path.symlink_to(self.data / 'absent-fixture')
                    elif mode == 'directory':
                        path.mkdir()
                    else:
                        path.write_bytes(b' ' * (r.MAX_JSON + 1 if mode == 'oversize' else r.MAX_JSON - 1))
                    with patch.object(local_memory.LocalMemory, 'append') as append:
                        response = self.call('local_memory_append', {'text': 'opaque fixture'}, run=run)
                    self.assertFalse(response['ok'], response)
                    self.assertEqual(response['error']['code'], 'unsafe_path' if mode in ('symlink', 'directory') else 'size_limit')
                    append.assert_not_called()
                    other = 'events' if channel == 'notes' else 'notes'
                    self.assertFalse((private / (other + '.jsonl')).exists())
                    self.assertNotIn('mutationState', response['error'])

    def test_completed_replay_and_conflict(self):
        req = self.request('local_memory_append', {'text': 'opaque marker'})
        first = r.dispatch(self.data, req)
        self.assertEqual(r.dispatch(self.data, req), first)
        self.assertEqual(len(self.call('local_memory_read')['result']['entries']), 1)
        req['arguments']['text'] = 'different opaque marker'
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'request_conflict')

    def test_unsettled_retry(self):
        req = self.submission()
        with patch.object(GlobalMemory, 'append', side_effect=OSError('fixture trace failure')):
            first = r.dispatch(self.data, req)
        self.assertEqual(first['error']['code'], 'io_error')
        self.assertEqual(first['error']['mutationState'], 'indeterminate')
        self.assertEqual(len(self.call('fact_list')['result']['facts']), 1)
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'indeterminate')

    def test_upstream_write_error_not_fake_success(self):
        req = self.submission()
        with patch.object(FactGraph, 'add', side_effect=OSError('fixture fact write failure')):
            response = r.dispatch(self.data, req)
        self.assertFalse(response['ok'], response)
        self.assertEqual(response['error']['code'], 'fact_write_failed')
        self.assertEqual(response['error']['mutationState'], 'indeterminate')
        self.assertTrue(response['result']['accepted'])
        self.assertIsNone(response['result']['fact_id'])
        self.assertEqual(response['result']['write_error'], 'fixture fact write failure')
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'indeterminate')

    @property
    def control(self):
        return self.data / 'context/projects/project-a/research/control'

    def test_fact_written_before_glossary_failure_remains_unsettled(self):
        req = self.submission({**CANDIDATE, 'glossary_introduces': {'opaque': 'fixture token'}})
        with patch.object(FactGraph, '_merge_glossary', side_effect=OSError('fixture glossary write failure')):
            response = r.dispatch(self.data, req)
        self.assertFalse(response['ok'])
        self.assertEqual(response['error'], {'code': 'fact_write_failed', 'mutationState': 'indeterminate',
                                             'message': 'fixture glossary write failure'})
        self.assertEqual(set(response['result']), {'accepted', 'fact_id', 'write_error', 'undefined_symbols'})
        self.assertTrue(response['result']['accepted'])
        self.assertIsNone(response['result']['fact_id'])
        self.assertEqual(response['result']['write_error'], 'fixture glossary write failure')
        facts = list((self.shared / 'fact_graph/facts').glob('*.md'))
        self.assertEqual(len(facts), 1)
        self.assertIn(CANDIDATE['proof'], facts[0].read_text())
        journal = self.control / (req['requestId'] + '.json')
        before = journal.read_bytes()
        self.assertEqual(json.loads(before)['state'], 'started')
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'indeterminate')
        self.assertEqual(journal.read_bytes(), before)
        self.assertEqual(len(self.call('fact_list')['result']['facts']), 1)

    def test_revoked_candidate_cannot_resurrect_but_corrected_content_can(self):
        req = self.submission()
        fid = r.dispatch(self.data, req)['result']['fact_id']
        self.assertTrue(self.call('fact_revoke', {'fact_id': fid, 'reason': 'opaque fixture'}, role='main')['ok'])
        archive = self.shared / f'fact_graph/_revoked/{fid}.md'
        original = archive.read_bytes()
        self.assertEqual(self.call('prepare_submission', CANDIDATE)['error']['code'], 'revoked_candidate')
        req['requestId'] = str(uuid.uuid4())
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'revoked_candidate')
        self.assertEqual(self.call('fact_list')['result']['facts'], [])
        self.assertFalse((self.shared / f'fact_graph/facts/{fid}.md').exists())
        self.assertEqual(archive.read_bytes(), original)
        corrected = self.add({**CANDIDATE, 'proof': CANDIDATE['proof'] + ' corrected opaque fixture token'})
        self.assertNotEqual(corrected, fid)
        self.assertEqual([item['fact_id'] for item in self.call('fact_list')['result']['facts']], [corrected])
        self.assertTrue(self.call('fact_get', {'fact_id': corrected})['ok'])

    def test_control_capacity_counts_journals_and_crash_snapshot_before_mutation(self):
        self.call('fact_list')
        leftover = self.control / 'core-crash-fixture'
        leftover.mkdir()
        (leftover / 'opaque').write_bytes(b'x' * 1024)
        journal = self.control / 'retained.json'
        journal.write_text('{"state":"started"}')
        req = self.request('gm_add', {'kind': 'plan', 'claim': 'opaque marker'})
        used = sum(p.stat().st_size for p in self.control.rglob('*') if p.is_file())
        with patch.object(r, 'MAX_CONTROL_BYTES', used + r.CONTROL_SNAPSHOT_RESERVE_BYTES - 1):
            with patch.object(r.CoreService, 'gm_add') as mutation:
                result = r.dispatch(self.data, req)
            mutation.assert_not_called()
        self.assertEqual(result['error']['code'], 'capacity_exceeded')
        self.assertIs(result['error']['indeterminate'], False)
        self.assertFalse((self.control / (req['requestId'] + '.json')).exists())
        self.assertTrue(journal.exists())
        self.assertEqual((leftover / 'opaque').stat().st_size, 1024)
        with patch.object(r, 'MAX_CONTROL_ENTRIES', r.CONTROL_SNAPSHOT_RESERVE_ENTRIES + 3):
            self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'capacity_exceeded')
        # Enough space permits the same never-started request and repeated small calls.
        self.assertTrue(r.dispatch(self.data, req)['ok'])
        self.assertTrue(self.call('gm_add', {'kind': 'plan', 'claim': 'second opaque marker'})['ok'])

    def test_control_capacity_rejects_symlink_in_crash_snapshot(self):
        self.call('fact_list')
        leftover = self.control / 'core-crash-fixture'
        leftover.mkdir()
        (leftover / 'linked').symlink_to(self.data / 'outside-fixture')
        result = self.call('local_memory_append', {'text': 'opaque'})
        self.assertEqual(result['error']['code'], 'unsafe_path')
        self.assertFalse((self.private / 'notes.jsonl').exists())

    def test_busy(self):
        import fcntl  # This direct lock probe is not part of the portable behavior gate.

        self.call('fact_list')
        lock = self.data / 'context/projects/project-a/research/control/project.lock'
        with lock.open('rb') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.call('fact_list')['error']['code'], 'busy')

    def test_search_and_gm_delegate(self):
        self.assertTrue(self.call('gm_add', {'kind': 'plan', 'claim': 'opaque fixture marker'})['ok'])
        self.assertTrue(self.call('gm_search', {'query': 'opaque'})['result']['results_by_kind']['plan']['results'])
        self.add()
        self.assertTrue(self.call('fact_search', {'query': 'opaque'})['result']['results'])

    def test_output_limit_no_truncation(self):
        for index in range(5):
            self.add({**CANDIDATE, 'statement': 'opaque fixture ' + str(index), 'intuition': 'x' * (250 << 10)})
        response = self.call('fact_list')
        self.assertEqual(response['error']['code'], 'size_limit')
        self.assertNotIn('result', response)

    def test_no_network_operation(self):
        self.assertEqual(self.call('search_arxiv_theorems', {'query': 'opaque'})['error']['code'], 'unsupported_operation')

    def test_receipt_missing_snapshot_and_snapshot_key_mismatch(self):
        req = self.submission()
        del req['verification']['predecessorDigests']
        self.assertFalse(r.dispatch(self.data, req)['ok'])
        req = self.submission()
        req['verification']['predecessorDigests'] = {'0'*16: '0'*64}
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'stale_verification')

    def test_publication_failure_is_unsettled_not_success(self):
        req = self.submission()
        original = r.atomic_write
        def fail_publish(path, data, **kwargs):
            if path.is_relative_to(self.shared):
                raise OSError('fixture publication failure')
            return original(path, data, **kwargs)
        with patch.object(r, 'atomic_write', side_effect=fail_publish):
            response = r.dispatch(self.data, req)
        self.assertEqual(response['error']['code'], 'io_error')
        self.assertEqual(response['error']['mutationState'], 'indeterminate')
        self.assertEqual(r.dispatch(self.data, req)['error']['code'], 'indeterminate')

    def test_hardlink_storage_and_oversize_file(self):
        self.call('fact_list')
        outside = self.data / 'opaque'
        outside.write_text('opaque')
        os.link(outside, self.shared / 'linked')
        self.assertEqual(self.call('fact_list')['error']['code'], 'unsafe_path')
        (self.shared / 'linked').unlink()
        (self.shared / 'large').write_bytes(b'x' * (r.MAX_JSON + 1))
        self.assertEqual(self.call('fact_list')['error']['code'], 'size_limit')

    def test_manifest_hash(self):
        engine = Path(__file__).resolve().parents[1]
        manifest = json.loads((engine / 'RESEARCH_UPSTREAM.json').read_text())
        for item in manifest['files']:
            self.assertEqual(hashlib.sha256((engine / item['destination']).read_bytes()).hexdigest(), item['sha256'])


if __name__ == '__main__':
    unittest.main()
