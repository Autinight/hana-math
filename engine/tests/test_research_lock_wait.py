"""Bounded flock software fixtures only; no mathematical experimentation."""
from concurrent.futures import ThreadPoolExecutor
import fcntl
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from hana_math_engine import research as r


class LockWaitTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data = Path(tmp.name).resolve()
        self.project = self.data / 'context/projects/project-lock'
        self.control = self.project / 'research/control'
        self.request = {'schemaVersion': 1, 'requestId': str(uuid.uuid4()),
                        'operation': 'gm_add',
                        'context': {'projectId': 'project-lock', 'runId': 'run-lock',
                                    'role': 'worker', 'author': 'fixture-worker'},
                        'arguments': {'kind': 'plan', 'claim': 'opaque lock fixture'}}

    def untouched(self):
        self.assertFalse((self.project / 'shared').exists())
        self.assertFalse((self.control / (self.request['requestId'] + '.json')).exists())

    def closed(self, fd):
        with self.assertRaises(OSError):
            os.fstat(fd)

    def busy(self, response):
        self.assertEqual(response, {'schemaVersion': 1, 'requestId': self.request['requestId'],
                                   'ok': False, 'error': {'code': 'busy', 'message': 'project is busy'}})

    def test_immediate_first_success_no_sleep(self):
        calls = []
        def acquire(fd, flags):
            self.untouched()
            calls.append(fd)
            self.assertEqual(flags, fcntl.LOCK_EX | fcntl.LOCK_NB)
        clock = SimpleNamespace(monotonic=lambda: 10, sleep=lambda _: self.fail('unexpected sleep'))
        with patch.object(r, 'time', clock, create=True), patch.object(fcntl, 'flock', acquire):
            response = r.dispatch(self.data, self.request)
        self.assertTrue(response['ok'], response)
        self.assertEqual(len(calls), 1)
        self.closed(calls[0])

    def test_monotonic_total_budget_includes_attempt_time_and_caps_sleep(self):
        now, attempts, sleeps = [0.0], [], []
        def acquire(fd, flags):
            self.untouched()
            attempts.append((now[0], fd))
            if len(attempts) == 1:
                now[0] += 0.63
            raise BlockingIOError('opaque contention')
        def sleep(delay):
            self.untouched()
            self.assertGreater(delay, 0)
            self.assertLessEqual(delay, 0.05)
            self.assertLessEqual(delay, 2.0 - now[0])
            sleeps.append(delay)
            now[0] += delay
        clock = SimpleNamespace(monotonic=lambda: now[0], sleep=sleep)
        with patch.object(r, 'time', clock, create=True), patch.object(fcntl, 'flock', acquire), patch.object(r, 'execute') as execute, patch.object(r, 'inventory') as inventory:
            self.busy(r.dispatch(self.data, self.request))
        self.assertAlmostEqual(now[0], 2.0)
        self.assertAlmostEqual(sum(sleeps), 1.37)
        self.assertGreater(len(attempts), 1)
        self.assertEqual(attempts[0][0], 0)
        self.assertTrue(all(at < 2.0 for at, _ in attempts))
        execute.assert_not_called()
        inventory.assert_not_called()
        self.closed(attempts[0][1])

    def test_oversleep_does_not_attempt_after_deadline(self):
        now, attempts = [0.0], []
        def acquire(fd, flags):
            attempts.append(fd)
            raise BlockingIOError('opaque contention')
        def sleep(delay):
            now[0] = 2.5
        clock = SimpleNamespace(monotonic=lambda: now[0], sleep=sleep)
        with patch.object(r, 'time', clock, create=True), patch.object(fcntl, 'flock', acquire):
            self.busy(r.dispatch(self.data, self.request))
        self.assertEqual(now[0], 2.5)
        self.assertEqual(len(attempts), 1)
        self.untouched()
        self.closed(attempts[0])

    def test_non_contention_error_is_not_retried_or_busy(self):
        calls = []
        def acquire(fd, flags):
            calls.append(fd)
            raise PermissionError('opaque denied')
        with patch.object(fcntl, 'flock', acquire):
            response = r.dispatch(self.data, self.request)
        self.assertEqual(response['error'], {'code': 'io_error', 'message': 'opaque denied'})
        self.assertEqual(len(calls), 1)
        self.untouched()
        self.closed(calls[0])

    def test_interrupt_during_wait_propagates_and_closes_fd(self):
        calls = []
        def acquire(fd, flags):
            calls.append(fd)
            raise BlockingIOError('opaque contention')
        def sleep(delay):
            raise KeyboardInterrupt('opaque cancellation')
        clock = SimpleNamespace(monotonic=lambda: 0, sleep=sleep)
        with patch.object(r, 'time', clock, create=True), patch.object(fcntl, 'flock', acquire):
            with self.assertRaises(KeyboardInterrupt):
                r.dispatch(self.data, self.request)
        self.assertEqual(len(calls), 1)
        self.untouched()
        self.closed(calls[0])

    def test_success_after_contention_dispatches_and_journals_once(self):
        now, attempts = [0.0], []
        def acquire(fd, flags):
            self.untouched()
            attempts.append(fd)
            if len(attempts) < 3:
                raise BlockingIOError('opaque contention')
        def sleep(delay):
            now[0] += delay
        clock = SimpleNamespace(monotonic=lambda: now[0], sleep=sleep)
        with patch.object(r, 'time', clock, create=True), patch.object(fcntl, 'flock', acquire), patch.object(r, 'execute', wraps=r.execute) as execute, patch.object(r, 'atomic_write', wraps=r.atomic_write) as write:
            response = r.dispatch(self.data, self.request)
        self.assertTrue(response['ok'], response)
        self.assertEqual(len(attempts), 3)
        execute.assert_called_once()
        journal = self.control / (self.request['requestId'] + '.json')
        self.assertEqual(sum(c.args[0] == journal for c in write.call_args_list), 2)
        self.closed(attempts[0])

    def real_contention(self, release):
        self.control.mkdir(parents=True)
        lock_path = self.control / 'project.lock'
        code = ('import fcntl,sys; f=open(sys.argv[1],"a+"); '
                'fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); '
                'print("locked",flush=True); sys.stdin.readline(); f.close()')
        holder = subprocess.Popen([sys.executable, '-I', '-B', '-c', code, str(lock_path)],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True)
        seen, attempts = threading.Event(), []
        flock = fcntl.flock
        def acquire(fd, flags):
            attempts.append(fd)
            try:
                return flock(fd, flags)
            except BlockingIOError:
                seen.set()
                raise
        try:
            self.assertTrue(select.select([holder.stdout], [], [], 3)[0], 'holder did not become ready')
            self.assertEqual(holder.stdout.readline().strip(), 'locked')
            with patch.object(fcntl, 'flock', acquire), patch.object(r, 'execute', wraps=r.execute) as execute:
                with ThreadPoolExecutor(max_workers=1) as pool:
                    started = time.monotonic()
                    future = pool.submit(r.dispatch, self.data, self.request)
                    self.assertTrue(seen.wait(1), 'no actual lock contention observed')
                    self.untouched()
                    execute.assert_not_called()
                    if release:
                        holder.stdin.write('release\n')
                        holder.stdin.flush()
                        holder.wait(timeout=3)
                    response = future.result(timeout=5)
                    elapsed = time.monotonic() - started
                if release:
                    self.assertTrue(response['ok'], response)
                    self.assertGreaterEqual(len(attempts), 2)
                    execute.assert_called_once()
                else:
                    self.busy(response)
                    self.assertGreaterEqual(elapsed, 2.0)
                    self.untouched()
                    execute.assert_not_called()
                self.closed(attempts[0])
        finally:
            if holder.poll() is None:
                holder.kill()
            holder.communicate(timeout=3)
        # A subsequent genuine lock must be available after every completion path.
        with lock_path.open('a+') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_real_flock_release_within_window(self):
        self.real_contention(True)

    def test_real_flock_held_through_window(self):
        self.real_contention(False)
