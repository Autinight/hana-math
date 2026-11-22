"""Windows one-shot read frame codec. Not a launchable entry point.

This module does not touch paths, allocate IPC space or dispatch the engine.
A future Host-backed entry must supply a pinned input and write the publication
exactly once, after an exclusive claim, under real Windows confinement.
"""
from hashlib import sha256
import json
import re
import struct
import uuid

FRAME = 1 << 20
HEADER = struct.Struct('>8sQ16sI32s')
MAGIC = b'HMRWIN01'
MAX_GENERATION = (1 << 53) - 1
OPS = frozenset(('fact_get', 'fact_list_page', 'dashboard_factgraph', 'dashboard_memory'))


class InvalidWindowsFrame(ValueError):
    pass


def need(condition, message):
    if not condition:
        raise InvalidWindowsFrame(message)


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def json_object(payload):
    def invalid_constant(_):
        raise InvalidWindowsFrame('invalid JSON constant')

    try:
        value = json.loads(payload.decode('utf-8'), object_pairs_hook=strict_object, parse_constant=invalid_constant)
    except (UnicodeError, ValueError, RecursionError):
        raise InvalidWindowsFrame('invalid frame JSON') from None
    need(isinstance(value, dict), 'expected frame object')
    return value


def schema_ok(value):
    return type(value.get('schemaVersion')) is int and value['schemaVersion'] == 1


def open_request(frame, length, request_digest, generation, nonce, project_id):
    need(type(generation) is int and 0 < generation <= MAX_GENERATION, 'invalid generation')
    need(isinstance(nonce, str) and re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', nonce),
         'invalid nonce')
    need(isinstance(project_id, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', project_id), 'invalid project')
    need(type(frame) is bytes and len(frame) == FRAME and type(length) is int and 0 < length <= FRAME,
         'invalid request frame length')
    need(type(request_digest) is bytes and len(request_digest) == 32 and sha256(frame).digest() == request_digest,
         'request frame digest mismatch')
    need(not any(frame[length:]), 'nonzero request padding')
    request = json_object(frame[:length])
    need(set(request) == {'schemaVersion', 'requestId', 'operation', 'context', 'arguments'}
         and schema_ok(request) and request['requestId'] == nonce and isinstance(request['arguments'], dict), 'invalid request identity/shape')
    context = request['context']
    need(isinstance(request['operation'], str) and request['operation'] in OPS and isinstance(context, dict)
         and context.get('role') == 'main' and context.get('projectId') == project_id, 'invalid read operation or scope')
    return request


def publication(frame, length, request_digest, generation, nonce, project_id, response):
    """Construct bytes to publish last, after writing the padded result frame.

    The existing byte limit still applies to both JSON bodies, independent of
    framing. The receipt binds the full request and full result (padding too).
    Returning bytes does not itself authorize publication or imply process exit.
    """
    open_request(frame, length, request_digest, generation, nonce, project_id)
    need(type(response) is bytes and 0 < len(response) <= FRAME, 'invalid result length')
    result = json_object(response)
    need(schema_ok(result) and result.get('requestId') == nonce and type(result.get('ok')) is bool
         and (not result['ok'] or 'result' in result), 'invalid response identity/shape')
    padded = response.ljust(FRAME, b'\0')
    digest = sha256(request_digest + padded).digest()
    header = HEADER.pack(MAGIC, generation, uuid.UUID(nonce).bytes, len(response), digest)
    return padded, header + sha256(header).digest()
