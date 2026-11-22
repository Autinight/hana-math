"""Relocated isolated entry tests, using only opaque software strings."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid


class ResearchEntryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        repository = Path(__file__).resolve().parents[2]
        self.package = self.root / 'relocated-app'
        (self.package / 'runtime').mkdir(parents=True)
        self.entry = self.package / 'runtime/research_entry.py'
        shutil.copyfile(repository / 'packages/hana-math/runtime/research_entry.py', self.entry)
        shutil.copytree(repository / 'engine/src', self.package / 'engine/src',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        self.data = self.root / 'app-data'
        self.directory = self.data / 'research/core-calls' / str(uuid.uuid4())
        self.directory.mkdir(parents=True)
        self.request = self.directory / 'request.json'
        self.result = self.directory / 'result.json'
        self.document = {'schemaVersion': 1, 'requestId': self.directory.name,
                         'operation': 'local_memory_append',
                         'context': {'projectId': 'fixture', 'runId': 'fixture-run',
                                     'role': 'worker', 'author': 'fixture'},
                         'arguments': {'text': 'opaque software fixture only'}}
        self.save()

    def save(self):
        self.request.write_text(json.dumps(self.document))

    def invoke(self, flags=('-I', '-S', '-B'), args=None):
        env = dict(os.environ, PYTHONPATH=str(self.root / 'untrusted-source'))
        return subprocess.run([sys.executable, *flags, str(self.entry),
                               *(args if args is not None else [str(self.request), str(self.result)])],
                              cwd=self.directory, env=env, text=True, capture_output=True, timeout=15)

    def test_packaged_isolated_round_trip_and_envelope(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(self.result.read_text())
        self.assertTrue(response['ok'], response)
        self.assertEqual(response['requestId'], self.directory.name)
        self.assertEqual(response['result']['entries'][0]['text'], self.document['arguments']['text'])
        local = self.data / 'context/projects/fixture/research/fixture-run/worker/local_memory'
        self.assertTrue((local / 'notes.jsonl').is_file())
        self.assertTrue((local / 'events.jsonl').is_file())
        self.assertFalse((local / 'memory.json').exists())
        self.assertFalse((self.data / 'context/projects/fixture/shared/fact_graph').exists())

    def test_packaged_worker_id_retains_opaque_notes_across_execution_runs(self):
        self.document['context']['workerId'] = 'logical-worker'
        self.save()
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        first = json.loads(self.result.read_text())
        self.assertTrue(first['ok'], first)
        private = self.data / 'context/projects/fixture/workers/logical-worker/local_memory'
        before = (private / 'notes.jsonl').read_bytes()
        self.assertTrue((private / 'events.jsonl').is_file())
        self.assertFalse((self.data / 'context/projects/fixture/research/fixture-run/worker').exists())
        self.directory = self.data / 'research/core-calls' / str(uuid.uuid4())
        self.directory.mkdir()
        self.request, self.result = self.directory / 'request.json', self.directory / 'result.json'
        self.document['requestId'] = self.directory.name
        self.document['context']['runId'] = 'other-run'
        self.document['operation'] = 'local_memory_read'
        self.document['arguments'] = {}
        self.save()
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        second = json.loads(self.result.read_text())
        self.assertTrue(second['ok'], second)
        self.assertEqual(second['result'], first['result'])
        self.assertEqual((private / 'notes.jsonl').read_bytes(), before)

    def test_dispatch_failure_is_result_not_process_success_claim(self):
        self.document['context']['role'] = 'main'
        self.save()
        self.assertEqual(self.invoke().returncode, 0)
        response = json.loads(self.result.read_text())
        self.assertFalse(response['ok'])
        self.assertEqual(response['error']['code'], 'forbidden')

    def test_flags_argv_fixed_names(self):
        for flags in (('-B',), ('-I', '-B'), ('-I', '-S')):
            self.assertNotEqual(self.invoke(flags=flags).returncode, 0)
        self.assertNotEqual(self.invoke(args=['request.json', str(self.result)]).returncode, 0)
        self.assertNotEqual(self.invoke(args=[str(self.request), str(self.root / 'escape.json')]).returncode, 0)
        self.assertFalse(self.result.exists())

    def test_no_development_fallback(self):
        shutil.rmtree(self.package / 'engine')
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertFalse(self.result.exists())

    def test_packaged_source_symlink(self):
        source = self.package / 'engine/src/hana_math_engine/research.py'
        target = self.root / 'outside.py'
        source.rename(target)
        source.symlink_to(target)
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertFalse((self.data / 'context').exists())

    def test_request_links_and_result_overwrite(self):
        other = self.directory / 'other.json'
        self.request.rename(other)
        self.request.symlink_to(other)
        self.assertNotEqual(self.invoke().returncode, 0)
        self.request.unlink()
        os.link(other, self.request)
        self.assertNotEqual(self.invoke().returncode, 0)
        self.request.unlink()
        other.rename(self.request)
        self.result.write_text('opaque sentinel')
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual(self.result.read_text(), 'opaque sentinel')

    def test_request_size_duplicate_keys_and_id_mismatch(self):
        self.request.write_text('x' * ((1 << 20) + 1))
        self.assertNotEqual(self.invoke().returncode, 0)
        self.request.write_text('{"requestId":"x","requestId":"y"}')
        self.assertNotEqual(self.invoke().returncode, 0)
        self.document['requestId'] = str(uuid.uuid4())
        self.save()
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertFalse(self.result.exists())


if __name__ == '__main__':
    unittest.main()
