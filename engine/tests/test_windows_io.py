"""Native Windows-only filesystem and relocated-entry fixtures; no Host or network.

From the repository root: py -3.12-64 -I -S -B engine/tests/test_windows_io.py -v
Use a writable fixed NTFS drive; junction creation does not need Developer Mode.
"""

from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / 'engine' / 'src'
sys.path.insert(0, str(SOURCE))
if sys.platform == 'win32':
    from hana_math_engine import research as research
    from hana_math_engine import windows_io as win
    from hana_math_engine.project_lock import ProjectLockBusy, lock_project


def holder(path):
    fd = win.open_lock(path)
    try:
        lock_project(fd)
        print('locked', flush=True)
        sys.stdin.readline()
    finally:
        os.close(fd)


@unittest.skipUnless(sys.platform == 'win32', 'requires real Windows APIs and NTFS')
class WindowsIO(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='hana Windows 测试-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.data = self.root / '数据'
        self.data.mkdir()
        self.project = self.data / 'context/projects/project-a'
        self.shared = self.project / 'shared'
        self.control = self.project / 'research/control'

    def junction(self, path, target):
        subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(path), str(target)],
                       check=True, capture_output=True, timeout=10)
        self.addCleanup(path.rmdir)
        self.assertTrue(path.is_junction())

    def request(self, operation, arguments, **extra):
        return {'schemaVersion': 1, 'requestId': str(uuid.uuid4()), 'operation': operation,
                'arguments': arguments, 'context': {'projectId': 'project-a', 'runId': 'run-a',
                    'author': 'worker-a', 'role': 'worker'}, **extra}

    def result(self, document):
        response = research.dispatch(self.data, document)
        self.assertTrue(response['ok'], response)
        return response['result']

    def test_read_write_hardlinks_junctions_and_native_names(self):
        target = self.data / '文件-é.jsonl'
        win.atomic_write(target, b'old\r\n', replace=False)
        with self.assertRaises(FileExistsError):
            win.atomic_write(target, b'conflict', replace=False)
        self.assertEqual(target.read_bytes(), b'old\r\n')
        win.atomic_write(target, '行\n'.encode('utf-8'))
        self.assertEqual(research.read_bytes(target), '行\n'.encode('utf-8'))
        self.assertEqual(list(self.data.glob('.write-*')), [])

        alias = target.with_name('alias')
        alias.hardlink_to(target)
        for use in (win.open_read, win.open_lock, win.unlink, lambda p: win.atomic_write(p, b'no')):
            with self.subTest(use=use), self.assertRaises(win.UnsafePath):
                use(alias)
        self.assertEqual(target.read_bytes(), '行\n'.encode('utf-8'))
        for suffix in (':hidden', '.', ' '):
            with self.assertRaises(win.UnsafePath):
                win.open_read(Path(str(target) + suffix))

        linked = self.root / 'junction'
        self.junction(linked, self.data)
        with self.assertRaises(win.UnsafePath):
            win.open_read(linked / target.name)
        with self.assertRaises(win.UnsafePath):
            win.atomic_write(linked / 'must-not-exist', b'oops')
        self.assertFalse((self.data / 'must-not-exist').exists())
        with self.assertRaises(win.UnsafePath):
            list(win.walk(self.root))

    def test_atomic_flush_failure_is_propagated_before_and_after_publication(self):
        target = self.data / 'record'
        win.atomic_write(target, b'before')
        real_flush = win._flush
        for failed_call in (1, 2):
            calls = 0
            def fail_once(handle):
                nonlocal calls
                calls += 1
                if calls == failed_call:
                    raise OSError('fixture flush failure')
                return real_flush(handle)
            with patch.object(win, '_flush', side_effect=fail_once):
                with self.assertRaisesRegex(OSError, 'fixture flush failure'):
                    win.atomic_write(target, b'after')
            self.assertEqual(target.read_bytes(), b'before' if failed_call == 1 else b'after')
            self.assertEqual(list(self.data.glob('.write-*')), [])

    def test_real_lock_contention_and_retry_with_safe_handles(self):
        self.control.mkdir(parents=True)
        path = self.control / 'project.lock'
        child = subprocess.Popen([sys.executable, '-I', '-S', '-B', __file__, '--holder', str(path)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            response = None
            # Synchronize on the real child before attempting the independent fd.
            self.assertEqual(child.stdout.readline().strip(), 'locked')
            fd = win.open_lock(path)
            try:
                with self.assertRaises(ProjectLockBusy):
                    lock_project(fd)
                response = research.dispatch(self.data, self.request('fact_list', {}))
                self.assertEqual(response['error']['code'], 'busy', response)
                _, error = child.communicate('\n', timeout=10)
                self.assertEqual(child.returncode, 0, error)
                lock_project(fd)
            finally:
                os.close(fd)
            self.assertEqual(self.result(self.request('fact_list', {})), {'facts': []})
            self.assertEqual(path.stat().st_size, 0)
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)

    def test_research_journal_verification_and_canonical_text(self):
        args = {'statement': 'Opaque 测试 marker', 'proof': 'Opaque software fixture.\n\n第二行.'}
        prepared = self.result(self.request('prepare_submission', args))
        verification = {'candidateDigest': prepared['candidateDigest'], 'predecessorDigests': {},
                        'verifierSessionId': 'fixture', 'report': {'verdict': 'correct', 'repair_hints': '',
                        'verification_report': {'summary': 'fixture only', 'critical_errors': [], 'gaps': []}}}
        request = self.request('fact_submit', args, verification=verification)
        first = self.result(request)
        self.assertEqual(self.result(request), first)
        fact_id = first['fact_id']
        fact = self.shared / f'fact_graph/facts/{fact_id}.md'
        raw = fact.read_bytes()
        self.assertNotIn(b'\r\n', raw)
        self.assertEqual(self.result(self.request('fact_get', {'fact_id': fact_id}))['markdown'].encode('utf-8'), raw)
        self.assertEqual(self.result(self.request('prepare_submission', {**args, 'predecessors': [fact_id]}))
                         ['predecessorDigests'], {fact_id: hashlib.sha256(raw).hexdigest()})
        self.assertTrue(self.result(self.request('fact_search', {'query': 'opaque'}))['results'])
        self.assertEqual(json.loads((self.control / (request['requestId'] + '.json')).read_bytes())['state'], 'ended')
        published = self.request('gm_add', {'kind': 'plan', 'claim': 'marker 是', 'evidence': 'fixture'})
        self.result(published)
        self.assertTrue(self.result(self.request('gm_search', {'query': 'marker', 'kinds': ['plan']}))
                        ['results_by_kind']['plan']['results'])
        memory = self.request('local_memory_append', {'text': 'UTF-8 测试\nline'})
        private = self.project / 'research/run-a/worker/local_memory'
        private.mkdir(parents=True)
        old = b'{"record":{"text":"legacy"}}\r\n'
        (private / 'notes.jsonl').write_bytes(old)
        self.result(memory)
        notes = (private / 'notes.jsonl').read_bytes()
        self.assertTrue(notes.startswith(old))
        self.assertNotIn(b'\r\n', notes[len(old):])
        self.assertEqual(self.result(self.request('local_memory_read', {}))['entries'][-1]['text'], memory['arguments']['text'])

    def test_control_walk_refuses_junction_and_hardlink_before_journal(self):
        self.control.mkdir(parents=True)
        self.shared.mkdir(parents=True)
        outside = self.root / 'outside'
        outside.mkdir()
        self.junction(self.control / 'legacy-core', outside)
        request = self.request('gm_add', {'kind': 'plan', 'claim': 'fixture'})
        response = research.dispatch(self.data, request)
        self.assertEqual(response['error']['code'], 'unsafe_path', response)
        self.assertFalse((self.control / (request['requestId'] + '.json')).exists())
        self.assertEqual(list(outside.iterdir()), [])

    def test_relocated_fixed_entries_and_untrusted_request(self):
        package = self.root / 'relocated 应用'
        runtime = package / 'runtime'
        runtime.mkdir(parents=True)
        shutil.copytree(SOURCE, package / 'engine/src', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        for entry in ('core_entry.py', 'research_entry.py'):
            shutil.copyfile(REPO / 'packages/hana-math/runtime' / entry, runtime / entry)
        for entry in ('core_entry.py', 'research_entry.py'):
            with self.subTest(entry=entry):
                rid = str(uuid.uuid4())
                diagnostic = entry == 'core_entry.py'
                parent = self.data / ('core-checks' if diagnostic else 'research/core-calls')
                cwd = parent / rid
                cwd.mkdir(parents=True)
                request, result = cwd / 'request.json', cwd / 'result.json'
                document = ({'schemaVersion': 1, 'requestId': rid, 'operation': 'core-diagnostic'} if diagnostic else
                            {**self.request('fact_list', {}), 'requestId': rid})
                content = json.dumps(document, ensure_ascii=False, indent=2).replace('\n', '\r\n').encode('utf-8')
                outside = cwd / 'other.json'
                outside.write_bytes(content)
                request.hardlink_to(outside)
                command = [sys.executable, '-I', '-S', '-B', str(runtime / entry)]
                args = (['--request', str(request), '--result', str(result)] if diagnostic else [str(request), str(result)])

                def invoke(argv=args):
                    return subprocess.run(command + argv, cwd=cwd, capture_output=True, timeout=20)

                self.assertNotEqual(invoke().returncode, 0)
                self.assertFalse(result.exists())
                request.unlink()
                request.write_bytes(content)
                self.assertNotEqual(invoke([*args[:-1], str(outside)]).returncode, 0)
                receipt = invoke()
                self.assertEqual(receipt.returncode, 0, receipt.stderr)
                original = result.read_bytes()
                self.assertTrue(json.loads(original)['ok'], original)
                self.assertNotEqual(invoke().returncode, 0)
                self.assertEqual(result.read_bytes(), original)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--holder':
        holder(Path(sys.argv[2]))
    else:
        unittest.main()
