"""One-shot fixed-slot transport for packaged, read-only research dispatch.

Internal protocol. The trusted App owner must pin its fresh slot/ancestors
and three original files for their entire lifetime.
All participants must honor the exclusive nonblocking flock on state.frame;
permissions, a matching inode, flock and a published state do not grant reuse.
Only the original owner may prepare a strictly higher generation, after exact
process terminal + business validation + durable audit + confirmed task settlement.
Unknown/failed/fenced slot or lost ownership (including reload) must NOT be rearmed.

Invoke release Python -I -S -B with this fixed entry and cwd of
<data>/research/core-calls/<slot UUID>. Arguments, all canonical ASCII metadata:
  generation request-UUID data-id research-id core-calls-id slot-id state-id
  request-id result-id
Here each file/directory id is decimal dev:ino from original owner opens (the two
frame identities in the last line are NOT request UUIDs). The v4 request UUID is
also the nonce, distinct from the slot UUID. No caller paths or bodies in argv.

request.frame and result.frame are each exactly 1 MiB, state.frame is 101 bytes.
State = big-endian >8sBQ16sI32s, followed by SHA256 of those 69 bytes. Magic
HMRFRM01; phase 1=prepared, 2=consumed, 3=published; positive safe-integer gen,
UUID bytes, payload length, SHA256 of the selected frame prefix. Phases 1/2
point at request.frame, phase 3 at result.frame. Tail bytes are not payload.
The owner supplies phase 1; this command syncs phase 2 before dispatch and
syncs the entire result frame before phase 3. It never resets or releases a slot.
The owner still needs a checked terminal receipt and exact output, not phase 3
alone. A torn/unknown state is not a recovery protocol or a power-loss promise.
"""
from contextlib import ExitStack
from hashlib import sha256
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import uuid

MAX_JSON = 1 << 20
MAX_GENERATION = (1 << 53) - 1
STATE = struct.Struct('>8sBQ16sI32s')
STATE_BYTES = STATE.size + 32
MAGIC = b'HMRFRM01'
PREPARED, CONSUMED, PUBLISHED = 1, 2, 3
OPS = ('fact_get', 'fact_list_page', 'dashboard_factgraph', 'dashboard_memory')
FILES = ('state.frame', 'request.frame', 'result.frame')


class Refusal(Exception):
    pass


def need(ok, code):
    if not ok:
        raise Refusal(code)


def canonical_uuid(text, code):
    try:
        value = uuid.UUID(text)
    except ValueError:
        raise Refusal(code) from None
    need(str(value) == text and value.version == 4, code)
    return value


def args_of(args):
    need(len(args) == 9, 'ARGUMENTS')
    number, nonce, *ids = args
    need(re.fullmatch(r'[1-9][0-9]{0,15}', number), 'ARGUMENTS')
    generation = int(number)
    need(generation <= MAX_GENERATION, 'ARGUMENTS')
    need(all(re.fullmatch(r'(?:0|[1-9][0-9]{0,19}):[1-9][0-9]{0,19}', i) for i in ids), 'ARGUMENTS')
    identities = [tuple(map(int, i.split(':'))) for i in ids]
    need(all(0 <= n < 1 << 64 for pair in identities for n in pair), 'ARGUMENTS')
    return generation, canonical_uuid(nonce, 'ARGUMENTS'), identities


def open_fd(stack, path, flags, dir_fd=None):
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dir_fd)
    stack.callback(os.close, fd)
    return fd


def exact_read(fd, length):
    buf = bytearray()
    while len(buf) < length:
        block = os.pread(fd, length - len(buf), len(buf))
        need(block, 'SHORT_READ')
        buf.extend(block)
    return bytes(buf)


def write_full(fd, payload, length):
    need(len(payload) == length, 'FRAME_LENGTH')
    view = memoryview(payload)
    offset = 0
    while offset < length:
        n = os.pwrite(fd, view[offset:], offset)
        need(n > 0, 'SHORT_WRITE')
        offset += n
    os.fsync(fd)


def frame_state(fd):
    data = exact_read(fd, STATE_BYTES)
    header, checksum = data[:STATE.size], data[STATE.size:]
    magic, phase, generation, nonce, length, digest = STATE.unpack(header)
    need(magic == MAGIC and sha256(header).digest() == checksum
         and phase in (PREPARED, CONSUMED, PUBLISHED) and 0 < generation <= MAX_GENERATION
         and 0 < length <= MAX_JSON, 'STATE_INVALID')
    return phase, generation, nonce, length, digest


def write_state(fd, phase, generation, nonce, length, digest):
    header = STATE.pack(MAGIC, phase, generation, nonce, length, digest)
    write_full(fd, header + sha256(header).digest(), STATE_BYTES)


def dispatcher(source, plain):
    # Same package-only source check as the legacy entry, not an import fallback.
    plain(source, directory=True)
    for name in ('danus', 'hana_math_engine'):
        tree = plain(source / name, directory=True)
        for parent, directories, files in os.walk(tree, followlinks=False):
            for child in directories:
                plain(Path(parent) / child, directory=True)
            for child in files:
                plain(Path(parent) / child)
    module_path = plain(source / 'hana_math_engine' / 'research.py')
    sys.path.insert(0, str(source))
    from hana_math_engine import research
    need(Path(research.__file__).resolve() == module_path, 'PACKAGE_INVALID')
    return research


def run(args):
    need(sys.version_info[:2] == (3, 12) and sys.flags.isolated
         and sys.flags.no_site and sys.dont_write_bytecode, 'PYTHON_FLAGS')
    generation, nonce, ids = args_of(args)
    directory = Path.cwd()
    need(directory.parent.name == 'core-calls' and directory.parent.parent.name == 'research', 'SLOT_PATH')
    slot_nonce = canonical_uuid(directory.name, 'SLOT_PATH')
    need(slot_nonce != nonce, 'ARGUMENTS')
    data = directory.parents[2]
    # -I excludes the entry's directory from sys.path. Load only the fixed
    # shipped sibling so its path and strict JSON checks stay identical.
    entry = Path(__file__).absolute()
    sibling = entry.with_name('research_entry.py')
    need(sibling.resolve() == sibling and stat.S_ISREG(sibling.lstat().st_mode)
         and sibling.lstat().st_nlink == 1, 'PACKAGE_INVALID')
    spec = importlib.util.spec_from_file_location('_research_entry_support', sibling)
    support = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(support)
    support.plain(entry)
    support.plain(directory, directory=True)
    dirs = (data, directory.parent.parent, directory.parent, directory)
    sizes = (STATE_BYTES, MAX_JSON, MAX_JSON)

    def verify_dirs():
        for pathname, identity in zip(dirs, ids[:4]):
            st = pathname.lstat()
            need(stat.S_ISDIR(st.st_mode) and (st.st_dev, st.st_ino) == identity, 'IDENTITY')

    def verify_file(fd, name, size, identity):
        for st in (os.fstat(fd), os.stat(name, dir_fd=slot, follow_symlinks=False)):
            need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_size == size
                 and st.st_uid == os.geteuid() and stat.S_IMODE(st.st_mode) == 0o600
                 and (st.st_dev, st.st_ino) == identity, 'IDENTITY')

    with ExitStack() as stack:
        verify_dirs()
        slot = open_fd(stack, '.', os.O_RDONLY | os.O_DIRECTORY)
        slot_stat = os.fstat(slot)
        need((slot_stat.st_dev, slot_stat.st_ino) == ids[3], 'IDENTITY')
        control = open_fd(stack, FILES[0], os.O_RDWR, slot)
        verify_file(control, FILES[0], sizes[0], ids[4])
        try:
            fcntl.flock(control, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refusal('LOCK_BUSY') from None
        request = open_fd(stack, FILES[1], os.O_RDONLY, slot)
        result = open_fd(stack, FILES[2], os.O_RDWR, slot)
        fds = (control, request, result)

        def verify():
            verify_dirs()
            for fd, name, size, identity in zip(fds, FILES, sizes, ids[4:]):
                verify_file(fd, name, size, identity)

        verify()
        original = frame_state(control)
        phase, found_generation, found_nonce, length, digest = original
        need((phase, found_generation, found_nonce) == (PREPARED, generation, nonce.bytes), 'STATE_MISMATCH')
        payload = exact_read(request, length)
        need(sha256(payload).digest() == digest, 'REQUEST_DIGEST')
        value = json.loads(payload.decode('utf-8'), object_pairs_hook=support.strict_object)
        need(isinstance(value, dict) and value.get('requestId') == str(nonce), 'REQUEST_NONCE')
        context = value.get('context')
        need(value.get('operation') in OPS and isinstance(context, dict) and context.get('role') == 'main', 'READ_ONLY')
        need(set(value) == {'schemaVersion', 'requestId', 'operation', 'context', 'arguments'}
             and type(value['schemaVersion']) is int and value['schemaVersion'] == 1
             and isinstance(value['arguments'], dict), 'REQUEST_SHAPE')
        research = dispatcher(entry.parent.parent / 'engine' / 'src', support.plain)
        verify()
        need(frame_state(control) == original, 'STATE_MISMATCH')
        write_state(control, CONSUMED, generation, nonce.bytes, length, digest)
        response = research.dispatch(data, value)
        need(isinstance(response, dict) and response.get('schemaVersion') == 1
             and response.get('requestId') == str(nonce) and type(response.get('ok')) is bool, 'RESPONSE_IDENTITY')
        body = research.encoded(response)
        need(0 < len(body) <= MAX_JSON, 'RESPONSE_LENGTH')
        verify()
        need(frame_state(control) == (CONSUMED, generation, nonce.bytes, length, digest), 'STATE_MISMATCH')
        write_full(result, body.ljust(MAX_JSON, b'\0'), MAX_JSON)
        verify()
        write_state(control, PUBLISHED, generation, nonce.bytes, len(body), sha256(body).digest())


def main():
    try:
        run(sys.argv[1:])
    except Refusal as error:
        print(f'RESEARCH_READ_FRAME_REFUSED:{error}', file=sys.stderr)
        return 1
    except Exception:
        # Never return path, payload, result or private exception text on stderr.
        print('RESEARCH_READ_FRAME_FAILED', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
