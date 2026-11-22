"""Real two-process lock fixture: python -I -S -B engine/tests/test_project_lock.py."""
import os
from pathlib import Path
from queue import Empty, Queue
import subprocess
import sys
import tempfile
from threading import Thread
import time
import unittest

if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from hana_math_engine.project_lock import ProjectLockBusy, lock_project


def child(mode, path):
    # The fixture owns a private, existing regular file. This is not the
    # production path/open boundary; hand the adapter an already open fd.
    fd = os.open(path, os.O_RDWR)
    try:
        if mode == 'hold':
            lock_project(fd)
            print('locked', flush=True)
            if sys.stdin.readline() != 'close\n':
                raise RuntimeError('expected close command')
        elif mode == 'contend':
            try:
                lock_project(fd)
            except ProjectLockBusy:
                print('busy', flush=True)
            else:
                raise RuntimeError('entered while the owner still held the lock')
            if sys.stdin.readline() != 'retry\n':
                raise RuntimeError('expected retry command')
            # Windows may finish close-triggered unlock asynchronously.
            deadline = time.monotonic() + 2.0
            while True:
                try:
                    lock_project(fd)
                    break
                except ProjectLockBusy:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.01)
            print('entered', flush=True)
        else:
            raise RuntimeError('unexpected child mode')
    finally:
        os.close(fd)


class ProjectLockTests(unittest.TestCase):
    def test_nonblocking_contention_then_release_on_close(self):
        def forward(source, output):
            for line in source:
                output.put(line.strip())

        def start(mode, lock_path):
            process = subprocess.Popen(
                [sys.executable, '-I', '-S', '-B', str(Path(__file__).resolve()), '--child', mode, str(lock_path)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.addCleanup(reap, process)
            output = Queue()
            Thread(target=forward, args=(process.stdout, output), daemon=True).start()
            return process, output

        def reap(process):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

        def receive(process, output, expected):
            try:
                actual = output.get(timeout=5)
            except Empty:
                detail = process.stderr.read() if process.poll() is not None else 'child did not reply'
                self.fail(f'expected {expected}: {detail}')
            self.assertEqual(actual, expected)

        def send(process, message):
            process.stdin.write(message + '\n')
            process.stdin.flush()

        def assert_success(process):
            self.assertEqual(process.wait(timeout=5), 0, process.stderr.read())

        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        lock_path = Path(directory.name) / 'project.lock'
        lock_path.touch()
        owner, owner_output = start('hold', lock_path)
        receive(owner, owner_output, 'locked')
        contender, contender_output = start('contend', lock_path)
        receive(contender, contender_output, 'busy')
        self.assertIsNone(owner.poll(), 'owner must still be holding the lock')
        send(owner, 'close')
        assert_success(owner)
        send(contender, 'retry')
        receive(contender, contender_output, 'entered')
        assert_success(contender)
        self.assertEqual(lock_path.stat().st_size, 0)
        print(f'{sys.platform}: A locked; B busy; A closed; B entered; lock file unchanged', flush=True)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--child':
        child(sys.argv[2], sys.argv[3])
    else:
        unittest.main(verbosity=2)
