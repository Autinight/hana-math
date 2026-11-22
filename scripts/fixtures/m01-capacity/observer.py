"""Software instrumentation, NOT a production entry or protocol extension.
Run with the relocated package's python -I -S -B. Calls original flock/close;
never changes the dispatcher's two-second deadline or 50ms retry sleep.
Metrics use stderr only; request/result files remain official entry protocol.
"""
import fcntl
import json
import os
from pathlib import Path
import runpy
import sys
import time

entry, request_file, result_file = sys.argv[1:]
request = json.loads(Path(request_file).read_text())
data = Path.cwd().parent.parent.parent
target = data / 'context/projects' / request['context']['projectId'] / 'research/control/project.lock'
original_open, original_flock, original_close = os.open, fcntl.flock, os.close
tracked = set()
metric = {'kind': 'm01-lock-observer', 'requestId': request['requestId'],
          'firstAttemptNs': None, 'acquiredNs': None, 'releasedNs': None,
          'wait_ms': None, 'hold_ms': None, 'unacquiredWaitUntilClose_ms': None, 'attempts': 0}

def observed_open(file, flags, *args, **kwargs):
    fd = original_open(file, flags, *args, **kwargs)
    if os.fspath(file) == str(target):
        tracked.add(fd)
    return fd

def observed_flock(fd, operation):
    selected = fd in tracked and operation & fcntl.LOCK_EX
    if selected:
        metric['attempts'] += 1
        if metric['firstAttemptNs'] is None:
            metric['firstAttemptNs'] = time.monotonic_ns()
    result = original_flock(fd, operation)
    if selected and metric['acquiredNs'] is None:
        metric['acquiredNs'] = time.monotonic_ns()
    return result

def observed_close(fd):
    selected = fd in tracked
    result = original_close(fd)  # The production dispatch finally releases by close, not LOCK_UN.
    if selected:
        tracked.remove(fd)
        metric['releasedNs'] = time.monotonic_ns()
    return result

os.open, fcntl.flock, os.close = observed_open, observed_flock, observed_close
sys.argv = [entry, request_file, result_file]
started = time.monotonic_ns()
try:
    runpy.run_path(entry, run_name='__main__')
finally:
    end = time.monotonic_ns()
    if metric['firstAttemptNs'] is not None and metric['acquiredNs'] is not None:
        metric['wait_ms'] = (metric['acquiredNs'] - metric['firstAttemptNs']) / 1e6
    if metric['acquiredNs'] is not None and metric['releasedNs'] is not None:
        metric['hold_ms'] = (metric['releasedNs'] - metric['acquiredNs']) / 1e6
    elif metric['firstAttemptNs'] is not None and metric['releasedNs'] is not None:
        # No acquisition: includes rejection wrapping up to close, a small extra
        # overhead. This is an observed upper span, NOT precise acquire wait.
        metric['unacquiredWaitUntilClose_ms'] = (metric['releasedNs'] - metric['firstAttemptNs']) / 1e6
    metric['entryCombined_ms'] = (end - started) / 1e6
    print('M01_METRIC ' + json.dumps(metric), file=sys.stderr, flush=True)
