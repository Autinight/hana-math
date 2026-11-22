"""Trusted offline research facade: dispatch(data_dir, request) -> envelope.

Request: {schemaVersion:1, requestId:UUID, operation, context:{projectId,
runId,role,author,workerId?}, arguments:{...}, verification?:{candidateDigest,
predecessorDigests:{fact_id:sha256},verifierSessionId,report}}.
Response: {schemaVersion:1,requestId,ok:true,result} or ok:false,error:{code,message}.
The Node backend owns context AND verification; this is NOT an authentication
boundary against arbitrary local Python callers. No model/network provider lives
here. A receipt is a context/candidate binding, not a cryptographic attestation.
Prechecks inherit process VERIFY_* environment at import (upstream defaults);
Node must sanitize its inherited environment. Requests cannot change it.

All calls take an exclusive project lock with bounded nonblocking acquisition. Mutations journal start/end; duplicate
completed requests return the saved envelope, unsettled requests are indeterminate.
Shared Core writes run in a private snapshot and are published with per-file
atomic replacement, including partial Core writes on exception. LocalMemory uses
upstream append-only notes.jsonl and its events.jsonl mirror, NOT atomic file
replacement: either append can fail after partial persistence. No multi-file transaction
or exactly-once guarantee; a crash during publication requires reconciliation.
Owned data directories must not be concurrently modified by untrusted OS users.
"""
from __future__ import annotations

import base64
from contextlib import ExitStack, nullcontext
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import uuid

from .project_lock import ProjectLockBusy, lock_project
from danus.core.factgraph import FactGraph, parse_frontmatter, statement_of
from danus.core.global_memory import GlobalMemory
from danus.core.local_memory import LocalMemory
from danus.core.schema import GLOBAL_KINDS, compute_fact_id
from .service import CoreService
from .vendor.verify_prechecks import run_prechecks

if sys.platform == 'win32':
    from . import windows_io as _win
    from danus.core._util import utc_now
else:
    _win = None

MAX_JSON = 1 << 20
MAX_TEXT = 256 << 10
MAX_SMALL_TEXT = 4096
MAX_ITEMS = 128
MAX_DEPTH = 6
MAX_TREE_FILES = 4096
MAX_TREE_ENTRIES = 2 * MAX_TREE_FILES
MAX_TREE_BYTES = 64 << 20
# Refusal-only control storage cap (journals + crash-left snapshots). No GC.
MAX_CONTROL_BYTES = 512 << 20
MAX_CONTROL_ENTRIES = 16384
# A cascade can append one escaped reason per fact before post-write inventory
# rejects a too-large log. Account for that transient growth, not just success.
CONTROL_SNAPSHOT_RESERVE_BYTES = (MAX_TREE_BYTES + 8 * MAX_JSON
                                  + MAX_TREE_FILES * (6 * MAX_SMALL_TEXT + 1024))
CONTROL_SNAPSHOT_RESERVE_ENTRIES = MAX_TREE_ENTRIES + 32
ID = re.compile(r'[a-z0-9][a-z0-9-]{0,63}')
AUTHOR = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')
FID = re.compile(r'[0-9a-f]{16}')
SHA = re.compile(r'[0-9a-f]{64}')
MUTATIONS = {'gm_add', 'fact_submit', 'fact_revoke', 'local_memory_append'}
CANDIDATE_FIELDS = {'statement', 'proof', 'predecessors', 'glossary_introduces',
                    'intuition', 'source_id', 'external_refs'}


class Rejected(Exception):
    def __init__(self, code, message, diagnostic=None):
        super().__init__(message)
        self.code = code
        self.diagnostic = diagnostic


def require(ok, code='invalid_request', message='invalid request', *, diagnostic=None):
    if not ok:
        raise Rejected(code, message, diagnostic)


def refusal_diagnostic(reason, observed=None, lower=None, limit=None, reserve=None):
    # Measurements describe this refusal, not current disk usage or settlement.
    safe = lambda value, minimum: type(value) is int and minimum <= value <= (1 << 53) - 1
    observed = observed if safe(observed, 0) and type(lower) is bool else None
    return {'version': 1, 'reason': reason, 'observed': observed,
            'observedLowerBound': lower if observed is not None and type(lower) is bool else None,
            'limit': limit if safe(limit, 1) else None, 'reserve': reserve if safe(reserve, 0) else None}


def shared_file_reason(relative):
    parts = Path(relative).parts
    if len(parts) == 3 and parts[:2] == ('fact_graph', 'facts') and re.fullmatch(r'[0-9a-f]{16}\.md', parts[2]):
        return 'shared-fact-bytes'
    if parts == ('fact_graph', 'glossary.json'):
        return 'shared-glossary-bytes'
    if parts == ('global_memory', 'verification.jsonl'):
        return 'shared-verification-bytes'
    return 'shared-other-file-bytes'


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def bounded(value, depth=0):
    require(depth <= MAX_DEPTH, message='object nesting limit')
    if isinstance(value, str):
        require(len(value.encode('utf-8')) <= MAX_TEXT and '\x00' not in value,
                message='text limit or NUL')
    elif isinstance(value, dict):
        require(len(value) <= MAX_ITEMS, message='dictionary limit')
        for key, item in value.items():
            text(key, MAX_SMALL_TEXT)
            bounded(item, depth + 1)
    elif isinstance(value, list):
        require(len(value) <= MAX_ITEMS, message='list limit')
        for item in value:
            bounded(item, depth + 1)
    else:
        require(value is None or type(value) in (bool, int), message='unsupported JSON value')


def text(value, maximum=MAX_TEXT, nonempty=False):
    require(isinstance(value, str) and len(value.encode('utf-8')) <= maximum
            and '\x00' not in value and (not nonempty or bool(value.strip())),
            message='invalid text')


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def fields(value, allowed, required=()):
    require(isinstance(value, dict) and set(required) <= value.keys()
            and value.keys() <= set(allowed), message='missing or unexpected fields')


def safe_path(path, *, directory=False, create=False):
    """Check every ancestor, not just the last component; reject hardlinks too."""
    path = Path(path)
    if _win:
        if directory:
            with _win.pinned_directory(path, create=create):
                pass
        else:
            _win.inspect(path, False, missing=True)
        return path
    require(path.is_absolute() and '..' not in path.parts, 'unsafe_path', 'absolute canonical path required')
    current = Path(path.anchor)
    for index, part in enumerate(path.parts[1:]):
        current /= part
        last = index == len(path.parts) - 2
        want_dir = not last or directory
        try:
            info = current.lstat()
        except FileNotFoundError:
            if create and want_dir:
                current.mkdir(mode=0o700)
                info = current.lstat()
            elif last and not directory:
                return path
            else:
                raise
        require(not stat.S_ISLNK(info.st_mode) and
                (stat.S_ISDIR(info.st_mode) if want_dir else
                 stat.S_ISREG(info.st_mode) and info.st_nlink == 1),
                'unsafe_path', 'symlink, hardlink or nonregular path')
    return path


def read_bytes(path, *, _reason='other-file-bytes'):
    if _win:
        fd = _win.open_read(path)
    else:
        safe_path(path)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as handle:
        if not _win:
            info = os.fstat(handle.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe_path', 'not a regular file')
        data = handle.read(MAX_JSON + 1)
    require(len(data) <= MAX_JSON, 'size_limit', 'file exceeds 1 MiB',
            diagnostic=refusal_diagnostic(_reason, len(data), True, MAX_JSON, 0))
    return data


def atomic_write(path, data, *, _reason='other-file-bytes'):
    require(len(data) <= MAX_JSON, 'size_limit', 'file exceeds 1 MiB',
            diagnostic=refusal_diagnostic(_reason, len(data), False, MAX_JSON, 0))
    safe_path(path.parent, directory=True, create=True)
    if _win:
        _win.atomic_write(path, data)
        return
    safe_path(path)
    fd, temporary = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def inventory(root, *, _shared=False, _windows_before=None):
    safe_path(root, directory=True)
    result = {}
    total = entries = 0

    def count(n):
        nonlocal entries
        entries += n
        require(entries <= MAX_TREE_ENTRIES, 'size_limit', 'project directory/file entry limit',
                diagnostic=refusal_diagnostic('shared-tree-entries', entries, True, MAX_TREE_ENTRIES, 0) if _shared else None)

    def collect(path):
        nonlocal total
        relative = path.relative_to(root)
        reason = shared_file_reason(relative) if _shared else 'other-file-bytes'
        if _windows_before is None:
            data = read_bytes(path, _reason=reason)
        else:
            # A lone LF can consume two bytes in upstream's temporary Windows
            # text output. Inspect a bounded raw prefix, then charge the same
            # canonical file/tree limits as POSIX rather than charging CRLF twice.
            with os.fdopen(_win.open_read(path), 'rb') as stream:
                raw = stream.read(2 * MAX_JSON + 1)
            data = _canonical_core_bytes(relative, raw, _windows_before.get(relative))
            require(len(data) <= MAX_JSON, 'size_limit', 'file exceeds 1 MiB',
                    diagnostic=refusal_diagnostic(reason, MAX_JSON + 1, True, MAX_JSON, 0))
        total += len(data)
        require(len(result) < MAX_TREE_FILES and total <= MAX_TREE_BYTES,
                'size_limit', 'project storage limit', diagnostic=(refusal_diagnostic('shared-tree-files', len(result) + 1, True, MAX_TREE_FILES, 0)
                if len(result) >= MAX_TREE_FILES else refusal_diagnostic('shared-tree-bytes', total, True, MAX_TREE_BYTES, 0)) if _shared else None)
        result[relative] = data

    if _win:
        seen = set()
        for path, directory, _ in _win.walk(root):
            count(1)
            require(path not in seen, 'unsafe_path', 'case-colliding filesystem entries')
            seen.add(path)
            if not directory:
                collect(path)
    else:
        for parent, directories, files in os.walk(root, followlinks=False):
            count(len(directories) + len(files))
            for name in directories:
                safe_path(Path(parent) / name, directory=True)
            for name in files:
                collect(Path(parent) / name)
    return result


def glossary(value):
    if value is None:
        return
    require(isinstance(value, dict), message='glossary must be an object')
    for key, val in value.items():
        text(key, 128, True)
        text(val, MAX_SMALL_TEXT, True)
        # Upstream emits unquoted frontmatter: restrict keys, reject YAML syntax
        # and all line/control separators in values, rather than quote upstream.
        require(re.fullmatch(r'[A-Za-z0-9_\\{}^().+-]+', key) is not None,
                message='unsafe glossary key')
        require(not any(ord(c) < 32 or c in '\x7f\x85\u2028\u2029' for c in val)
                and val == val.strip() and not val.startswith(tuple('-?:,[]{}#&*!|>\'"%@`'))
                and ': ' not in val and ' #' not in val, message='unsafe glossary value')


def candidate(args):
    fields(args, CANDIDATE_FIELDS, {'statement', 'proof'})
    for key in ('statement', 'proof'):
        text(args[key], nonempty=True)
    text(args.get('intuition', ''))
    if args.get('source_id') is not None:
        text(args['source_id'], MAX_SMALL_TEXT)
    preds = args.get('predecessors') or []
    require(isinstance(preds, list) and all(matches(FID, p) for p in preds)
            and len(preds) == len(set(preds)), message='predecessors must be unique 16hex IDs')
    require(args.get('predecessors') is None or isinstance(args['predecessors'], list))
    glossary(args.get('glossary_introduces'))
    refs = args.get('external_refs')
    require(refs is None or isinstance(refs, list) and all(isinstance(r, dict) for r in refs),
            message='external_refs must be a list of objects')


def fact(root, fid, *, _inventory=None):
    require(matches(FID, fid), message='invalid fact ID')
    relative = Path('fact_graph') / 'facts' / (fid + '.md')
    revoked = Path('fact_graph') / '_revoked' / (fid + '.md')
    if _inventory is None:
        path = root / relative
        require(path.exists(), 'not_found', 'fact not found')
        require(not (root / revoked).exists(), 'revoked', 'fact is revoked')
        data = read_bytes(path, _reason='shared-fact-bytes')
    else:
        if _win:
            require(relative in _inventory, 'not_found', 'fact not found')
        # Internal only: bytes already safety-checked and charged by the
        # inventory of this shared root while the same project lock is held.
        require(relative in _inventory, 'invalid_fact', 'fact absent from project observation')
        require(revoked not in _inventory, 'revoked', 'fact is revoked')
        data = _inventory[relative]
    raw = data.decode('utf-8')
    require(raw.startswith('---\nfact_id: ' + fid + '\n'), 'invalid_fact', 'noncanonical fact')
    return {'fact_id': fid, 'markdown': raw,
            'predecessors': parse_frontmatter(raw)['predecessors']}, hashlib.sha256(data).hexdigest()


FACT_PAGE_BYTES = 16 << 10
FACT_PAGE_ROWS = 64
FACT_PREVIEW_BYTES = 512
MAX_SAFE_INTEGER = (1 << 53) - 1


def fact_page_cursor(project_id, as_of, offset, limit):
    return base64.urlsafe_b64encode(encoded({'v': 1, 'projectId': project_id,
        'asOf': as_of, 'offset': offset, 'limit': limit})).decode('ascii').rstrip('=')


def fact_page_options(args, project_id=None):
    fields(args, {'cursor', 'limit'})
    cursor = None
    code = 'invalid_cursor' if 'cursor' in args else 'invalid_request'
    if 'limit' in args:
        require(type(args['limit']) is int and 1 <= args['limit'] <= FACT_PAGE_ROWS,
                code, 'invalid page limit')
    if 'cursor' in args:
        token = args['cursor']
        require(isinstance(token, str) and 1 <= len(token) <= 1024
                and re.fullmatch(r'[A-Za-z0-9_-]+', token) is not None,
                'invalid_cursor', 'invalid fact page cursor')
        def unique_pairs(pairs):
            result = {}
            for key, value in pairs:
                require(key not in result, 'invalid_cursor', 'duplicate cursor key')
                result[key] = value
            return result
        try:
            raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))
            require(base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=') == token,
                    'invalid_cursor', 'noncanonical cursor encoding')
            cursor = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_pairs)
        except (ValueError, UnicodeError) as error:
            raise Rejected('invalid_cursor', 'invalid fact page cursor') from error
        require(isinstance(cursor, dict) and set(cursor) == {'v', 'projectId', 'asOf', 'offset', 'limit'}
                and type(cursor['v']) is int and cursor['v'] == 1
                and matches(ID, cursor['projectId']) and matches(SHA, cursor['asOf'])
                and type(cursor['offset']) is int and 0 <= cursor['offset'] <= MAX_SAFE_INTEGER
                and type(cursor['limit']) is int and 1 <= cursor['limit'] <= FACT_PAGE_ROWS
                and (project_id is None or cursor['projectId'] == project_id)
                and ('limit' not in args or args['limit'] == cursor['limit']),
                'invalid_cursor', 'invalid fact page cursor')
        require(raw == encoded(cursor), 'invalid_cursor', 'noncanonical cursor JSON')
    return cursor, args.get('limit', cursor['limit'] if cursor else FACT_PAGE_ROWS)


def fact_index_as_of(project_id, hashes):
    return hashlib.sha256(encoded({'kind': 'hana-math-fact-index', 'version': 1,
        'projectId': project_id, 'facts': hashes})).hexdigest()


def fact_list_page(root, project_id, args, *, _inventory=None):
    # Syntax/project/scalars precede observation; drift precedes offset vs total.
    cursor, limit = fact_page_options(args, project_id)
    ids = _fact_ids(root, _inventory)
    hashes = [[fid, fact(root, fid, _inventory=_inventory)[1]] for fid in ids]
    as_of = fact_index_as_of(project_id, hashes)
    start = cursor['offset'] if cursor else 0
    if cursor:
        require(cursor['asOf'] == as_of, 'fact_page_changed', 'fact page observation changed')
        require(start < len(ids), 'invalid_cursor', 'cursor offset outside observation')
    rows = []
    # Retain at most limit projections, never all complete Markdown bodies.
    for fid in ids[start:start + limit]:
        value, _ = fact(root, fid, _inventory=_inventory)
        preds = value['predecessors']
        require(len(preds) <= MAX_ITEMS and len(set(preds)) == len(preds)
                and all(matches(FID, p) for p in preds), 'invalid_fact', 'invalid predecessors')
        projection = statement_of(value['markdown']).encode('utf-8')
        preview = projection[:FACT_PREVIEW_BYTES].decode('utf-8', errors='ignore')
        require('\x00' not in preview, 'invalid_fact', 'invalid preview text')
        rows.append({'fact_id': fid, 'predecessors': preds, 'statementPreview': preview,
                     'statementPreviewTruncated': len(projection) > FACT_PREVIEW_BYTES,
                     'canonicalBytes': len(value['markdown'].encode('utf-8'))})
    while True:
        end = start + len(rows)
        more = end < len(ids)
        page = {'version': 1, 'asOf': as_of, 'total': len(ids), 'startIndex': start,
                'returned': len(rows), 'limit': limit,
                'nextCursor': fact_page_cursor(project_id, as_of, end, limit) if more else None,
                'hasMore': more, 'allFactsIncluded': start == 0 and end == len(ids), 'previewOnly': True}
        result = {'facts': rows, 'page': page}
        page_bytes = len(encoded(result))
        if page_bytes <= FACT_PAGE_BYTES:
            require(rows or not ids, 'size_limit', 'fact page row exceeds response budget',
                    diagnostic=refusal_diagnostic('fact-page-bytes', page_bytes, False, FACT_PAGE_BYTES, 0))
            return result
        require(len(rows) > 1, 'size_limit', 'fact page row exceeds response budget',
                diagnostic=refusal_diagnostic('fact-page-bytes', page_bytes, False, FACT_PAGE_BYTES, 0))
        rows.pop()


def _dashboard_factgraph(root, project_id, shared_files):
    # Deferred import: the pure adapter already shares this module's budgets.
    from .dashboard_factgraph import FactgraphSizeLimit, build_factgraph

    ids = _fact_ids(root, shared_files if _win else None)
    require(len(ids) <= 2048, 'size_limit', 'dashboard fact index exceeds 2048 facts')
    visible = sorted(p.stem for p in shared_files
                     if p.parent == Path('fact_graph/facts') and p.suffix == '.md')
    require(ids == visible, 'invalid_fact', 'fact index differs from project observation')
    hashes = []

    def records():
        edges = 0
        for fid in ids:
            value, digest = fact(root, fid, _inventory=shared_files)
            edges += len(value['predecessors'])
            require(edges <= 32768, 'size_limit', 'dashboard fact index exceeds 32768 edges')
            hashes.append([fid, digest])
            yield value

    try:
        graph = build_factgraph(records())
    except FactgraphSizeLimit as error:
        raise Rejected('size_limit', str(error)) from None
    except ValueError:
        raise Rejected('invalid_fact', 'canonical dashboard graph input is inconsistent') from None
    return {'projectId': project_id, 'asOf': fact_index_as_of(project_id, hashes), 'graph': graph}


def snapshot(root, args, observed=None):
    return {p: fact(root, p, _inventory=observed)[1] for p in (args.get('predecessors') or [])}


def report(value):
    fields(value, {'verification_report', 'verdict', 'repair_hints'},
           {'verification_report', 'verdict', 'repair_hints'})
    body = value['verification_report']
    fields(body, {'summary', 'critical_errors', 'gaps'}, {'summary', 'critical_errors', 'gaps'})
    text(body['summary'])
    for key in ('critical_errors', 'gaps'):
        require(isinstance(body[key], list), message='report issues must be lists')
        for issue in body[key]:
            fields(issue, {'location', 'issue'}, {'location', 'issue'})
            text(issue['location'], MAX_SMALL_TEXT, True)
            text(issue['issue'], nonempty=True)
    text(value['repair_hints'])
    issues = bool(body['critical_errors'] or body['gaps'])
    require((value['verdict'] == 'correct' and not issues and value['repair_hints'] == '')
            or (value['verdict'] == 'wrong' and issues and bool(value['repair_hints'].strip())),
            'invalid_report', 'verdict/report contradiction')


def validate_operation(op, args, role):
    if op in ('dashboard_factgraph', 'dashboard_memory'):
        require(role == 'main', 'forbidden', 'project-main-only operation')
        if 'terminal' in args:
            require(args['terminal'] is True, message='terminal must be true')
            args = {key: value for key, value in args.items() if key != 'terminal'}
        if op == 'dashboard_factgraph':
            fields(args, set())
        else:
            from .dashboard_memory import valid_selection
            require(valid_selection(args), message='invalid shared dashboard selection')
        return
    if op in ('prepare_submission', 'fact_submit', 'local_memory_append', 'local_memory_read'):
        require(role == 'worker', 'forbidden', 'worker-only operation')
    elif op not in ('fact_get', 'fact_list', 'fact_list_page'):
        require(op in CoreService(Path('/'), author='validation', role=role).available_tools,
                'forbidden', 'operation not allowed for role')
    if op in ('prepare_submission', 'fact_submit'):
        candidate(args)
    elif op == 'gm_add':
        fields(args, {'kind', 'claim', 'evidence', 'verifiable', 'glossary', 'links'}, {'kind', 'claim'})
        require(args['kind'] in GLOBAL_KINDS)
        text(args['claim'], nonempty=True)
        text(args.get('evidence', ''))
        require(args.get('verifiable') is None or type(args['verifiable']) is bool)
        glossary(args.get('glossary'))
        require(args.get('links') is None or isinstance(args['links'], dict))
    elif op in ('gm_search', 'fact_search'):
        key = 'limit_per_kind' if op == 'gm_search' else 'limit'
        fields(args, {'query', key, 'kinds'} if op == 'gm_search' else {'query', key}, {'query'})
        text(args['query'], MAX_SMALL_TEXT)
        limit = args.get(key, 10)
        require(type(limit) is int and 1 <= limit <= MAX_ITEMS)
        if 'kinds' in args and args['kinds'] is not None:
            require(isinstance(args['kinds'], list) and all(isinstance(k, str) and k in GLOBAL_KINDS for k in args['kinds']))
    elif op in ('fact_get', 'fact_revoke'):
        fields(args, {'fact_id', 'reason'} if op == 'fact_revoke' else {'fact_id'},
               {'fact_id', 'reason'} if op == 'fact_revoke' else {'fact_id'})
        require(matches(FID, args['fact_id']))
        if op == 'fact_revoke':
            text(args['reason'], MAX_SMALL_TEXT, True)
    elif op == 'fact_list_page':
        fact_page_options(args)
    elif op == 'fact_list' or op == 'local_memory_read':
        fields(args, set())
    elif op == 'local_memory_append':
        fields(args, {'text'}, {'text'})
        text(args['text'], nonempty=True)
    else:
        raise Rejected('unsupported_operation', 'network retrieval belongs to Node')


def check_control_capacity(control, operation):
    """Under the project flock, stat only managed control files, never follow links.

    Reserve a full bounded working snapshot plus publication/journal temporaries
    before mutation. Completed/unfinished historical records are never deleted.
    """
    def posix_entries():
        for parent, directories, files in os.walk(control, followlinks=False):
            for name in directories + files:
                path = Path(parent) / name
                info = path.lstat()
                require(not stat.S_ISLNK(info.st_mode) and
                        (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1),
                        'unsafe_path', 'unsafe control storage entry')
                yield path, stat.S_ISDIR(info.st_mode), info.st_size

    total = count = 0
    for _, directory, size in (_win.walk(control) if _win else posix_entries()):
        count += 1
        if not directory:
            total += size
        require(count <= MAX_CONTROL_ENTRIES and total <= MAX_CONTROL_BYTES,
                'capacity_exceeded', 'managed control storage is full; reconcile without automatic deletion',
                diagnostic=refusal_diagnostic('control-entries', count, True, MAX_CONTROL_ENTRIES, 0) if count > MAX_CONTROL_ENTRIES
                else refusal_diagnostic('control-bytes', total, True, MAX_CONTROL_BYTES, 0))
    reserve_bytes = reserve_entries = 0
    if operation in MUTATIONS:
        if operation.startswith('local_memory_'):
            reserve_bytes, reserve_entries = 2 * MAX_JSON, 4
        else:
            reserve_bytes = CONTROL_SNAPSHOT_RESERVE_BYTES
            reserve_entries = CONTROL_SNAPSHOT_RESERVE_ENTRIES
    require(total + reserve_bytes <= MAX_CONTROL_BYTES and count + reserve_entries <= MAX_CONTROL_ENTRIES,
            'capacity_exceeded', 'insufficient managed control capacity for this operation',
            diagnostic=refusal_diagnostic('control-bytes', total, False, MAX_CONTROL_BYTES, reserve_bytes) if total + reserve_bytes > MAX_CONTROL_BYTES
            else refusal_diagnostic('control-entries', count, False, MAX_CONTROL_ENTRIES, reserve_entries))


def local_record(request):
    return {'requestId': request['requestId'], 'author': request['context']['author'],
            'text': request['arguments']['text']}


def check_local_files(private, record=None):
    """Validate both fixed channels before ANY append, including projected size.

    Match upstream json.dumps(..., ensure_ascii=False) + newline. utc_now's
    ISO UTC timestamp has at most 32 ASCII characters; reserve that maximum so
    neither append can exceed MAX_JSON even when both files start near the cap.
    This is a size bound, not a replacement serialization or storage format.
    """
    safe_path(private, directory=True)
    projected = {
        'notes': {'timestamp_utc': '0' * 32, 'channel': 'notes', 'record': record},
        'events': {'timestamp_utc': '0' * 32, 'event_type': 'local_append', 'channel': 'notes'},
    }
    for channel in ('notes', 'events'):
        path = safe_path(private / (channel + '.jsonl'))
        size = len(_read_optional(path)) if _win else len(read_bytes(path)) if path.exists() else 0
        observed, reserve = size, 0
        if record is not None:
            reserve = len((json.dumps(projected[channel], ensure_ascii=False) + '\n').encode('utf-8'))
            size += reserve
        require(size <= MAX_JSON, 'size_limit', 'local memory channel exceeds 1 MiB',
                diagnostic=refusal_diagnostic('other-file-bytes', observed, False, MAX_JSON, reserve))


def _read_optional(path):
    try:
        return read_bytes(path)
    except FileNotFoundError:
        return b''


def _local_windows(private, request):
    def size_check(observed, reserve):
        require(observed + reserve <= MAX_JSON, 'size_limit', 'local memory channel exceeds 1 MiB',
                diagnostic=refusal_diagnostic('other-file-bytes', observed, False, MAX_JSON, reserve))

    if request['operation'] == 'local_memory_append':
        # Same record/timestamp ordering and partial-append behavior as LocalMemory.
        for channel, fields in [('notes', {'channel': 'notes', 'record': local_record(request)}),
                                ('events', {'event_type': 'local_append', 'channel': 'notes'})]:
            line = json.dumps({'timestamp_utc': utc_now(), **fields}, ensure_ascii=False) + '\n'
            _win.append(private / (channel + '.jsonl'), line.encode('utf-8'), size_check)
    check_local_files(private)
    entries = []
    for line in io.StringIO(_read_optional(private / 'notes.jsonl').decode('utf-8'), newline=None):
        try:
            item = json.loads(line.strip())
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            entries.append(item['record'])
    return {'entries': entries}


class _ObservedPath:
    """Read-only view for upstream text readers, never a filesystem path."""
    def __init__(self, files, relative, *, directory=False):
        self.files, self.relative, self.directory = files, relative, directory

    def __truediv__(self, name):
        return _ObservedPath(self.files, self.relative / name)

    def exists(self):
        return self.directory or self.relative in self.files

    def open(self, mode, *, encoding):
        assert mode == 'r' and encoding == 'utf-8'
        return io.StringIO(self.files[self.relative].decode(encoding), newline=None)

    def read_text(self, *, encoding):
        with self.open('r', encoding=encoding) as stream:
            return stream.read()

    def glob(self, pattern):
        assert pattern == '*.md'
        return (p for p in self.files if p.parent == self.relative and p.suffix.lower() == '.md')


def _fact_ids(root, observed):
    if observed is None:
        return FactGraph(root).list()
    return sorted(p.stem for p in _ObservedPath(observed, Path('fact_graph/facts')).glob('*.md'))


def _search_windows(root, observed, operation, args):
    # Reuse the upstream BM25/search implementation over verified inventory bytes.
    if operation == 'gm_search':
        memory = GlobalMemory(root)
        memory.dir = _ObservedPath(observed, Path('global_memory'))
        return memory.search(**args)
    graph = FactGraph(root)
    graph.facts_dir = _ObservedPath(observed, Path('fact_graph/facts'), directory=True)
    return {'query': args['query'], 'results': graph.search(**args)}


def execute(root, private, request, *, _inventory=None):
    op, args, ctx = request['operation'], request['arguments'], request['context']
    verification = request.get('verification')
    provider = None
    if op in ('prepare_submission', 'fact_submit'):
        candidate_id = compute_fact_id(problem_id=ctx['projectId'],
            predecessors=args.get('predecessors') or [],
            glossary_introduces=args.get('glossary_introduces') or {},
            statement=args['statement'], proof=args['proof'])
        revoked_name = Path('fact_graph') / '_revoked' / (candidate_id + '.md')
        revoked = (root / revoked_name).exists() if _inventory is None else revoked_name in _inventory
        require(not revoked,
                'revoked_candidate', 'candidate content ID is revoked; submit corrected content instead')
        digest = hashlib.sha256(encoded({'context': ctx, 'arguments': args})).hexdigest()
        if op == 'fact_submit':
            require(verification is not None, 'verification_required', 'trusted verification envelope required')
            fields(verification, {'candidateDigest', 'predecessorDigests', 'verifierSessionId', 'report'},
                   {'candidateDigest', 'predecessorDigests', 'verifierSessionId', 'report'})
            require(matches(SHA, verification['candidateDigest']) and verification['candidateDigest'] == digest,
                    'digest_mismatch', 'candidate/context digest mismatch')
            require(matches(AUTHOR, verification['verifierSessionId']), message='invalid verifier session ID')
            require(isinstance(verification['predecessorDigests'], dict) and
                    all(matches(FID, k) and matches(SHA, v) for k, v in verification['predecessorDigests'].items()))
            report(verification['report'])
        try:
            predecessors = snapshot(root, args, _inventory)
        except Rejected as error:
            if op == 'fact_submit' and error.code in ('not_found', 'revoked'):
                raise Rejected('stale_verification', 'predecessor missing or revoked') from error
            raise
        if op == 'fact_submit':
            require(verification['predecessorDigests'] == predecessors,
                    'stale_verification', 'predecessor snapshot changed')
        check = run_prechecks(args['statement'], args['proof'])
        if op == 'prepare_submission':
            return {'candidateDigest': digest, 'predecessorDigests': predecessors,
                    'precheck': {'passed': check is None, 'status': check[0] if check else None,
                                 'detail': check[1] if check else None}}
        require(check is None, 'precheck_rejected', check[1] if check else '')
        # Only the already validated trusted report is injected, never a default
        # accepting provider or a fallback on verifier failure.
        provider = lambda statement, proof: verification['report']
    if op == 'fact_get':
        return fact(root, args['fact_id'], _inventory=_inventory)[0]
    if op == 'fact_list':
        return {'facts': [fact(root, fid, _inventory=_inventory)[0] for fid in _fact_ids(root, _inventory)]}
    if op == 'fact_list_page':
        return fact_list_page(root, ctx['projectId'], args, _inventory=_inventory)
    if op.startswith('local_memory_'):
        if _win:
            return _local_windows(private, request)
        memory = LocalMemory(private.parent)
        if op == 'local_memory_append':
            # Preserve upstream notes + events mirror and partial-append errors.
            # Do not expose LocalMemory.append's absolute-path return value.
            memory.append('notes', local_record(request))
        check_local_files(private)
        # Return note.record, without timestamps/channel wrappers or events.
        # Facade-created records are exactly {requestId, author, text}; existing
        # upstream notes retain their original record object. No memory.json
        # fallback, migration, or alternate format is created/read here.
        return {'entries': [note['record'] for note in memory.read('notes')]}
    if _inventory is not None and op in ('gm_search', 'fact_search'):
        return _search_windows(root, _inventory, op, args)
    service = CoreService(root, author=ctx['author'], role=ctx['role'],
                          problem_id=ctx['projectId'], verifier=provider)
    return service.call(op, args)


def _canonical_core_bytes(relative, data, before):
    # Core writes native text in the private snapshot. Undo just that write's
    # newline translation, preserving existing bytes and raw verification digests.
    if data == before:
        return data
    if (relative.parent == Path('fact_graph/_revoked') and relative.suffix == '.md'):
        return data  # revocation moves the original file rather than rewriting it
    if relative.suffix == '.jsonl' and data.startswith(before or b''):
        prefix = before or b''
        return prefix + data[len(prefix):].replace(b'\r\n', b'\n')
    if relative == Path('fact_graph/glossary.json') or (
        relative.parent == Path('fact_graph/facts') and relative.suffix == '.md'
    ):
        return data.replace(b'\r\n', b'\n')
    return data


def dispatch(data_dir, request):
    """Only exported dispatcher. Catch errors into a bounded protocol envelope."""
    rid = request.get('requestId') if isinstance(request, dict) else None
    base = {'schemaVersion': 1, 'requestId': rid if isinstance(rid, str) and len(rid) <= 36 else None}
    started = False
    lock = None
    journal = None
    pins = ExitStack()
    try:
        fields(request, {'schemaVersion', 'requestId', 'operation', 'context', 'arguments', 'verification'},
               {'schemaVersion', 'requestId', 'operation', 'context', 'arguments'})
        require(type(request['schemaVersion']) is int and request['schemaVersion'] == 1)
        require(isinstance(rid, str) and str(uuid.UUID(rid)) == rid, message='canonical UUID required')
        require(len(encoded(request)) <= MAX_JSON, 'size_limit', 'request exceeds 1 MiB')
        bounded(request)
        ctx = request['context']
        fields(ctx, {'projectId', 'runId', 'role', 'author', 'workerId'}, {'projectId', 'runId', 'role', 'author'})
        require(matches(ID, ctx['projectId']) and matches(ID, ctx['runId']) and matches(AUTHOR, ctx['author']))
        require(ctx['role'] in ('main', 'worker', 'verifier'), 'forbidden', 'invalid role')
        if 'workerId' in ctx:
            require(ctx['role'] == 'worker', 'forbidden', 'workerId is worker-only')
            require(matches(ID, ctx['workerId']), message='invalid workerId')
        op = request['operation']
        require(isinstance(op, str) and isinstance(request['arguments'], dict))
        require('verification' not in request or op == 'fact_submit', message='unexpected verification')
        validate_operation(op, request['arguments'], ctx['role'])
        dashboard = op in ('dashboard_factgraph', 'dashboard_memory')
        terminal = dashboard and request['arguments'].get('terminal') is True
        if dashboard:
            require(re.fullmatch(r'control-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', ctx['runId']),
                    'forbidden', 'project control binding required')
        data_dir = safe_path(Path(data_dir), directory=True)
        project = safe_path(data_dir / 'context' / 'projects' / ctx['projectId'], directory=True, create=not dashboard)
        control = safe_path(project / 'research' / 'control', directory=True, create=True)
        if _win:
            pins.enter_context(_win.pinned_directory(control))
            lock = _win.open_lock(control / 'project.lock')
        else:
            lock_path = safe_path(control / 'project.lock')
            lock = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        deadline = time.monotonic() + 2.0
        while True:
            try:
                lock_project(lock)
                break
            except ProjectLockBusy as error:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise Rejected('busy', 'project is busy') from error
                time.sleep(min(0.05, remaining))
                if time.monotonic() >= deadline:
                    raise Rejected('busy', 'project is busy') from error
        root = safe_path(project / 'shared', directory=True, create=not dashboard)
        if _win:
            pins.enter_context(_win.pinned_directory(root))
        private = project / 'research' / ctx['runId'] / 'worker' / 'local_memory'
        if 'workerId' in ctx:
            private = project / 'workers' / ctx['workerId'] / 'local_memory'
        fingerprint = hashlib.sha256(encoded(request)).hexdigest()
        if op in MUTATIONS:
            journal = control / (rid + '.json')
            exists = _win.inspect(journal, False, missing=True) is not None if _win else journal.exists()
            if exists:
                previous = json.loads(read_bytes(journal))
                require(previous['fingerprint'] == fingerprint, 'request_conflict', 'request ID already used')
                require(previous['state'] == 'ended', 'indeterminate', 'unsettled request; reconcile before retry')
                return previous['response']
        check_control_capacity(control, op)
        if dashboard or _win:
            shared_files = inventory(root, _shared=True)
        else:
            inventory(root, _shared=True)
        if op.startswith('local_memory_'):
            safe_path(private, directory=True, create=True)
            if _win:
                pins.enter_context(_win.pinned_directory(private))
            inventory(private)
            check_local_files(private, local_record(request) if op == 'local_memory_append' else None)
        if op in MUTATIONS:
            atomic_write(journal, encoded({'state': 'started', 'fingerprint': fingerprint}))
            started = True
        if op in MUTATIONS and not op.startswith('local_memory_'):
            before = inventory(root, _shared=True)
            core_returned = False
            prepublication_refusal = None
            with tempfile.TemporaryDirectory(prefix='core-', dir=control) as temporary:
                working = Path(temporary)
                for relative, data in before.items():
                    atomic_write(working / relative, data, _reason=shared_file_reason(relative))
                try:
                    with _win.pinned_directory(working) if _win else nullcontext():
                        result = execute(working, private, request)
                    core_returned = True
                finally:
                    # Core errors still publish valid partial writes. Only this
                    # exact inventory refusal after normal return proves that
                    # no shared publication has even been attempted.
                    try:
                        after = (inventory(working, _shared=True, _windows_before=before) if _win
                                 else inventory(working, _shared=True))
                    except Rejected as error:
                        if not core_returned or error.code != 'size_limit':
                            raise
                        prepublication_refusal = error
                    else:
                        for relative, data in after.items():
                            if before.get(relative) != data:
                                atomic_write(root / relative, data, _reason=shared_file_reason(relative))
                        for relative in before.keys() - after.keys():
                            if _win:
                                _win.unlink(root / relative)
                            else:
                                safe_path(root / relative).unlink()
            if prepublication_refusal is not None:
                # Cleanup above and this failure journal must both complete
                # under the original lock. Any failure keeps the outer started
                # classification, including a post-replace directory fsync error.
                response = {**base, 'ok': False, 'error': {
                    'code': prepublication_refusal.code,
                    'message': str(prepublication_refusal)[:4096]}}
                if prepublication_refusal.diagnostic is not None:
                    response['diagnostic'] = prepublication_refusal.diagnostic
                response_bytes = len(encoded(response))
                require(response_bytes <= MAX_JSON, 'size_limit', 'result exceeds 1 MiB; not truncated',
                        diagnostic=refusal_diagnostic('response-bytes', response_bytes, False, MAX_JSON, 0))
                atomic_write(journal, encoded({'state': 'ended', 'fingerprint': fingerprint, 'response': response}))
                return response
        elif op == 'dashboard_factgraph':
            result = _dashboard_factgraph(root, ctx['projectId'], shared_files)
        elif op == 'dashboard_memory':
            from .dashboard_memory import build_dashboard_memory
            selection = request['arguments']
            if terminal:
                selection = {key: value for key, value in selection.items() if key != 'terminal'}
            result = {'projectId': ctx['projectId'], 'data': build_dashboard_memory(
                ctx['projectId'], shared_files, selection, updated_at=time.time())}
        elif _win:
            result = execute(root, private, request, _inventory=shared_files)
        else:
            result = execute(root, private, request)
        if terminal:
            # Use the same in-memory bytes as the selected result, before unlocking.
            from .dashboard_memory import inventory_revision
            result['inventoryRevision'] = inventory_revision(ctx['projectId'], shared_files)
        response = {**base, 'ok': True, 'result': result}
        if op == 'fact_submit' and result.get('accepted') is True and result.get('fact_id') is None and 'write_error' in result:
            # Core may already have written the fact before glossary/trace work.
            # Preserve its exact result, but never settle/replay this as success.
            response.update(ok=False, error={'code': 'fact_write_failed',
                'mutationState': 'indeterminate', 'message': str(result['write_error'])[:4096]})
            response_bytes = len(encoded(response))
            require(response_bytes <= MAX_JSON, 'size_limit', 'result exceeds 1 MiB; not truncated',
                    diagnostic=refusal_diagnostic('response-bytes', response_bytes, False, MAX_JSON, 0))
            return response
        response_bytes = len(encoded(response))
        require(response_bytes <= MAX_JSON, 'size_limit', 'result exceeds 1 MiB; not truncated',
                diagnostic=refusal_diagnostic('response-bytes', response_bytes, False, MAX_JSON, 0))
        if started:
            atomic_write(journal, encoded({'state': 'ended', 'fingerprint': fingerprint, 'response': response}))
        return response
    except Exception as error:
        if _win and isinstance(error, _win.UnsafePath):
            error = Rejected('unsafe_path', str(error))
        code = error.code if isinstance(error, Rejected) else 'io_error' if isinstance(error, OSError) else 'invalid_request' if isinstance(error, (ValueError, TypeError)) else 'internal_error'
        # A failed precondition cannot have mutated Core, but an exception after
        # start is conservatively unsettled (including publication/trace errors).
        # Do not carry OS paths or malformed file details into the dashboard DTO.
        message = ('shared dashboard observation failed' if not isinstance(error, Rejected)
                   and isinstance(request, dict) and request.get('operation') == 'dashboard_memory' else str(error)[:4096])
        response = {**base, 'ok': False, 'error': {'code': code, 'message': message}}
        if started:
            response['error']['mutationState'] = 'indeterminate'
        elif code == 'capacity_exceeded':
            response['error']['indeterminate'] = False
        diagnostic = error.diagnostic if isinstance(error, Rejected) else None
        if code in ('fact_page_changed', 'invalid_cursor') and request.get('operation') == 'fact_list_page':
            diagnostic = refusal_diagnostic('fact-page-changed' if code == 'fact_page_changed' else 'invalid-cursor')
        if diagnostic is not None:
            response['diagnostic'] = diagnostic
        return response
    finally:
        try:
            if lock is not None:
                os.close(lock)
        finally:
            pins.close()
