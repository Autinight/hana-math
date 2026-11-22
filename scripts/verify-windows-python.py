#!/usr/bin/env python3
"""Read-only input gate for CPython 3.12.14 Windows x64 PBS install-only archives.

Does not extract or execute anything. Honors a built-in upstream digest for known
assets; for other assets, obtain --archive-sha256 independently from a trusted
upstream release record, not from the candidate itself.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import tarfile
import unicodedata
import zlib

# PC/python_ver_rc.h: PYVERSION64 is major, minor, FIELD3, PYTHON_API_VERSION.
# PC/python_exe.rc uses it for both fixed versions (not the displayed PY_VERSION).
# FIELD3 is micro * 1000 + release_level * 10 + release_serial; the pinned
# 3.12.14 final header has level 0xF and serial 0, and modsupport.h gives API 1013.
VERSION = (3, 12, 14)
FIXED_PE_VERSION = (*VERSION[:2], VERSION[2] * 1000 + 0xF * 10, 1013)
TARGET = 'x86_64-pc-windows-msvc'
ASSET = re.compile(r'cpython-3\.12\.14\+[0-9]{8}-x86_64-pc-windows-msvc(?:-shared)?-install_only\.tar\.gz')
# Digests from astral-sh/python-build-standalone release asset metadata. These
# releases use the implicit shared spelling (without the optional -shared).
PINS = {
    'cpython-3.12.14+20260814-x86_64-pc-windows-msvc-install_only.tar.gz':
        '7330282b47cd43a66b702d39078d2e5a88e580cee351d82f95045f21f5ee042a',
    'cpython-3.12.14+20260901-x86_64-pc-windows-msvc-install_only.tar.gz':
        'e90c1b6419da3bd812dd73bb3de40287a21abf153438147639ec5e20375ea93f',
}
MIB = 1024 * 1024
BLOCK, CHUNK = 512, 64 * 1024
MAX_ARCHIVE, MAX_EXPANDED, MAX_MEMBER = 96 * MIB, 384 * MIB, 48 * MIB
MAX_HEADERS, MAX_NAMES, MAX_META = 24_000, 48_000, 16 * 1024
EXE, DLL = 'python/python.exe', 'python/python312.dll'
HEADERS = ('python/include/patchlevel.h', 'python/include/python3.12/patchlevel.h')
LICENSES = ('python/LICENSE.txt', 'python/LICENSE')
STDLIB = ('os.py', 'encodings/__init__.py', 'encodings/utf_8.py', 'importlib/__init__.py', 'json/__init__.py')
STDLIB = tuple('python/Lib/' + name for name in STDLIB)
CAPTURE = {EXE: 4 * MIB, DLL: 32 * MIB, **dict.fromkeys((*HEADERS, *LICENSES), 256 * 1024)}
DEVICES = re.compile(r'(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³])\Z')


class Invalid(ValueError):
    """The input is not approved by this gate."""


def require(ok, why):
    if not ok:
        raise Invalid(why)


def path_parts(name):
    parts = name.split('/')
    require(parts[0] == 'python' and len(name.encode('utf-16-le', 'surrogatepass')) <= 1024 and len(parts) <= 32,
            f'path outside python/ or too long: {name!r}')
    for part in parts:
        require(part not in ('', '.', '..') and not part.endswith((' ', '.')) and unicodedata.normalize('NFC', part) == part
                and len(part.encode('utf-16-le', 'surrogatepass')) <= 510
                and not any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF or c in '<>:"\\|?*' for c in part)
                and not DEVICES.fullmatch(part.split('.', 1)[0].rstrip(' ').upper()), f'unsafe Windows path: {name!r}')
    return parts


def path_key(part):
    # Conservative collision key, also folds Unicode case (not an NTFS emulator).
    return unicodedata.normalize('NFC', part.upper().casefold())


class BoundedTar:
    def __init__(self, stream):
        self.stream = stream
        self.expanded = 0
        self.headers = 0
        self.paths = {}

    def read(self, size, exact=True):
        require(size <= MAX_EXPANDED - self.expanded or not exact, 'expanded byte limit exceeded')
        data = self.stream.read(size if exact else min(size, MAX_EXPANDED - self.expanded + 1))
        self.expanded += len(data)
        require(self.expanded <= MAX_EXPANDED, 'expanded byte limit exceeded')
        require(not exact or len(data) == size, 'truncated tar stream')
        return data

    def register(self, name, is_dir):
        parts = path_parts(name)
        require(len(parts) > 1 or is_dir, 'python root must be a directory')
        key, prefix = (), []
        for i, part in enumerate(parts):
            key += (path_key(part),)
            prefix.append(part)
            spelling = '/'.join(prefix)
            leaf = i == len(parts) - 1
            prior = self.paths.get(key)
            if prior is not None:
                old_name, old_is_dir, explicit = prior
                require(old_name == spelling, f'Windows case/name collision: {old_name!r} vs {spelling!r}')
                require(not (leaf and explicit), f'duplicate tar member: {name!r}')
                require(old_is_dir and (not leaf or is_dir), f'file/directory conflict: {spelling!r}')
            if prior is None or leaf:
                self.paths[key] = (spelling, is_dir if leaf else True, leaf)
                require(len(self.paths) <= MAX_NAMES, 'archive path count limit exceeded')

    def members(self):
        pending = None
        while True:
            raw = self.read(BLOCK)
            if not any(raw):
                require(pending is None and not any(self.read(BLOCK)), 'missing tar end-of-archive marker')
                while tail := self.read(CHUNK, exact=False):
                    require(not any(tail), 'nonzero content after tar end-of-archive marker')
                return
            self.headers += 1
            require(self.headers <= MAX_HEADERS, 'archive member/header limit exceeded')
            info = tarfile.TarInfo.frombuf(raw, 'utf-8', 'strict')
            require(0 <= info.size <= MAX_MEMBER, f'member byte limit exceeded: {info.name!r}')
            if info.type in (tarfile.XHDTYPE, tarfile.GNUTYPE_LONGNAME):
                require(pending is None and 0 < info.size <= MAX_META, 'duplicate or oversized tar path header')
                content = self.read(info.size)
                self.padding(info.size)
                if info.type == tarfile.XHDTYPE:
                    pending = pax_path(content)
                else:
                    require(content.endswith(b'\0') and b'\0' not in content[:-1], 'invalid GNU long path')
                    pending = content[:-1].decode('utf-8')
                continue
            is_dir = info.type == tarfile.DIRTYPE
            require(is_dir or info.type in (tarfile.REGTYPE, tarfile.AREGTYPE), f'unsupported tar member type: {info.name!r}')
            require(not info.linkname and (not is_dir or info.size == 0), f'invalid file/directory header: {info.name!r}')
            # The effective path comes from bounded PAX/GNU metadata, if present.
            # Also reject unsafe fallback paths so different readers won't disagree on safety.
            raw_name = info.name.rstrip('/') if is_dir else info.name
            path_parts(raw_name)
            name = pending if pending else raw_name
            pending = None
            if is_dir and name.endswith('/'):
                name = name[:-1]
            self.register(name, is_dir)
            if not is_dir:
                yield name, info.size
            self.padding(info.size)

    def padding(self, size):
        require(not any(self.read(-size % BLOCK)), 'nonzero tar member padding')


def pax_path(data):
    fields = {}
    while data:
        head = re.match(rb'([1-9][0-9]{0,4}) ', data)
        require(head is not None, 'invalid PAX record length')
        end = int(head[1])
        require(head.end() + 2 < end <= len(data) and data[end - 1:end] == b'\n', 'truncated PAX record')
        key, sep, value = data[head.end():end - 1].partition(b'=')
        require(sep and key not in fields and b'\0' not in value, 'duplicate or invalid PAX attribute')
        require(key in {b'path', b'mtime', b'atime', b'ctime', b'uid', b'gid', b'uname', b'gname'}, f'unsupported PAX attribute: {key!r}')
        fields[key] = value
        data = data[end:]
    if b'path' in fields:
        require(fields[b'path'], 'empty PAX path')
        return fields[b'path'].decode('utf-8')
    return ''  # Track a pending header even when it only carries timestamps.


def pe_version(data, name, dll):
    def unpack(fmt, buf, at):
        require(0 <= at <= len(buf) - struct.calcsize('<' + fmt), f'{name}: truncated PE/version resource')
        return struct.unpack_from('<' + fmt, buf, at)

    def u16(buf, at):
        return unpack('H', buf, at)[0]

    def u32(buf, at):
        return unpack('I', buf, at)[0]

    require(data.startswith(b'MZ'), f'{name}: expected DOS/PE signature, not Mach-O or another format')
    pe = u32(data, 0x3C)
    require(64 <= pe <= MIB and data[pe:pe + 4] == b'PE\0\0', f'{name}: invalid PE signature')
    machine, nsects = unpack('HH', data, pe + 4)
    opt_size, flags = unpack('HH', data, pe + 20)
    opt = pe + 24
    require(machine == 0x8664 and u16(data, opt) == 0x20B, f'{name}: expected PE32+ AMD64')
    require(flags & 0x0002 and bool(flags & 0x2000) == dll, f'{name}: incorrect PE image kind')
    require(opt_size >= 136 and 1 <= nsects <= 96 and opt + opt_size + nsects * 40 <= len(data)
            and u32(data, opt + 108) >= 3, f'{name}: malformed PE section/resource header')
    sections = [unpack('4I', data, opt + opt_size + i * 40 + 8) for i in range(nsects)]

    def mapped(rva, size):
        offsets = []
        for virtual_size, address, raw_size, raw_offset in sections:
            delta = rva - address
            if 0 <= delta and delta + size <= min(virtual_size or raw_size, raw_size):
                offsets.append(raw_offset + delta)
        require(size > 0 and len(offsets) == 1 and offsets[0] >= opt + opt_size + nsects * 40
                and offsets[0] + size <= len(data), f'{name}: unmapped or ambiguous PE resource')
        return data[offsets[0]:offsets[0] + size]

    rva, resource_size = unpack('II', data, opt + 128)
    require(16 <= resource_size <= 4 * MIB, f'{name}: missing or oversized PE resources')
    resources = mapped(rva, resource_size)

    def directory(offset):
        named, ids = unpack('HH', resources, offset + 12)
        require(named + ids <= 256, f'{name}: too many PE resource entries')
        return [unpack('II', resources, offset + 16 + i * 8) for i in range(named + ids)]

    def children(offset):
        require(offset & 0x8000_0000, f'{name}: expected PE resource directory')
        rows = directory(offset & 0x7FFF_FFFF)
        require(0 < len(rows) <= 16 and len({key for key, _ in rows}) == len(rows), f'{name}: ambiguous version resources')
        return rows

    version_dirs = [offset for kind, offset in directory(0) if kind == 16]  # RT_VERSION
    require(len(version_dirs) == 1, f'{name}: missing or duplicate RT_VERSION')
    key = 'VS_VERSION_INFO\0'.encode('utf-16-le')
    for _, lang_dir in children(version_dirs[0]):
        for _, leaf in children(lang_dir):
            require(not leaf & 0x8000_0000, f'{name}: expected RT_VERSION data leaf')
            addr, size, _, _ = unpack('4I', resources, leaf)
            require(92 <= size <= 64 * 1024, f'{name}: invalid RT_VERSION size')
            block = mapped(addr, size)
            total, value_size, kind = unpack('3H', block, 0)
            fixed = (6 + len(key) + 3) & ~3
            require(fixed + 52 <= total <= size and value_size == 52 and kind == 0 and block[6:6 + len(key)] == key,
                    f'{name}: malformed VS_VERSION_INFO')
            signature, structure, file_ms, file_ls, prod_ms, prod_ls = unpack('6I', block, fixed)
            require((signature, structure) == (0xFEEF04BD, 0x10000), f'{name}: invalid VS_FIXEDFILEINFO')
            for field, ms, ls in (('file', file_ms, file_ls), ('product', prod_ms, prod_ls)):
                actual = (ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF)
                require(actual == FIXED_PE_VERSION,
                        f'{name}: incorrect PE {field} version {actual}; expected {FIXED_PE_VERSION} for CPython 3.12.14 final')
    return '.'.join(map(str, FIXED_PE_VERSION))


def patchlevel(data):
    expected = {b'PY_VERSION': b'"3.12.14"', b'PY_MAJOR_VERSION': b'3', b'PY_MINOR_VERSION': b'12', b'PY_MICRO_VERSION': b'14',
                b'PY_RELEASE_LEVEL': b'PY_RELEASE_LEVEL_FINAL', b'PY_RELEASE_SERIAL': b'0'}
    for macro, value in expected.items():
        values = re.findall(rb'(?m)^[ \t]*#[ \t]*define[ \t]+' + macro + rb'[ \t]+([^\s]+)', data)
        require(values == [value], f'patchlevel.h: incorrect or ambiguous {macro.decode()}')


def scan(compressed):
    records, captured = {}, {}
    with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode='rb') as stream:
        tar = BoundedTar(stream)
        for name, size in tar.members():
            if name in CAPTURE:
                require(0 < size <= CAPTURE[name], f'empty or oversized required file: {name}')
                data = captured[name] = tar.read(size)
                digest = hashlib.sha256(data)
            else:
                digest = hashlib.sha256()
                for offset in range(0, size, CHUNK):
                    digest.update(tar.read(min(CHUNK, size - offset)))
            records[name] = {'bytes': size, 'sha256': digest.hexdigest()}
    for name in (EXE, DLL, *STDLIB):
        require(name in records and records[name]['bytes'] > 0, f'missing or empty file: {name}')
    header_names, license_names = [n for n in HEADERS if n in captured], [n for n in LICENSES if n in captured]
    require(header_names, 'missing CPython include/patchlevel.h')
    require(license_names, 'missing CPython license')
    for name in header_names:
        patchlevel(captured[name])
    for name in license_names:
        require(b'PYTHON SOFTWARE FOUNDATION LICENSE' in captured[name].upper(), f'missing PSF license text: {name}')
    pe = {EXE: pe_version(captured[EXE], EXE, False), DLL: pe_version(captured[DLL], DLL, True)}
    inventory = [[name, records[name]['bytes'], records[name]['sha256']] for name in sorted(records)]
    return {'fileCount': len(records), 'tarHeaderCount': tar.headers, 'expandedBytes': tar.expanded,
            'canonicalFileInventorySha256': hashlib.sha256(json.dumps(inventory, ensure_ascii=True, separators=(',', ':')).encode('ascii')).hexdigest(),
            'evidenceFiles': {name: records[name] for name in (*pe, *header_names, *license_names, *STDLIB)},
            'peFileAndProductVersions': pe}


def verify(archive, supplied_pin=None):
    require(ASSET.fullmatch(archive.name), 'expected a CPython 3.12.14 Windows x64 shared install_only.tar.gz asset name')
    upstream_pin = PINS.get(archive.name)
    if supplied_pin is not None:
        require(re.fullmatch('[a-f0-9]{64}', supplied_pin), 'expected a 64-character lowercase SHA-256 pin')
        require(upstream_pin is None or supplied_pin == upstream_pin, 'cannot override a known upstream SHA-256 pin')
    pin = upstream_pin or supplied_pin
    require(pin is not None, 'no known pin for this asset; provide independently trusted --archive-sha256')
    # One immutable bounded byte snapshot supplies both the pin check and parser.
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_NOFOLLOW', 0)
    require(not archive.is_symlink(), 'archive must not be a symbolic link')
    with os.fdopen(os.open(archive, flags), 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= MAX_ARCHIVE, 'archive is not a bounded regular file')
        compressed = stream.read(MAX_ARCHIVE + 1)
    require(len(compressed) == info.st_size, 'archive size changed during read')
    actual = hashlib.sha256(compressed).hexdigest()
    require(actual == pin, f'archive SHA-256 mismatch: expected {pin}, got {actual}')
    return {'ok': True, 'scope': 'static-input-preflight-only', 'hostRuntimeVerified': False,
            'source': {'asset': archive.name, 'pinSource': 'built-in-upstream' if upstream_pin else 'operator-supplied',
                       'archiveSha256': actual, 'archiveBytes': len(compressed)},
            'inspected': {'target': TARGET, 'machine': 'PE32+ AMD64', 'pythonVersion': '3.12.14', **scan(compressed)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--archive-sha256', help='independent upstream pin for an unlisted asset')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.archive, args.archive_sha256), indent=2))
    except (Invalid, UnicodeError, OSError, EOFError, tarfile.TarError, zlib.error) as err:
        print(f'Windows Python input rejected: {str(err)!r}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
