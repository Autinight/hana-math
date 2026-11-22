"""Packaged offline research entry. Trusted Node supplies both JSON and context.

Invoke python3.12 -I -S -B research_entry.py /absolute/request.json
/absolute/result.json with cwd <dataDir>/research/core-calls/<canonical UUID>.
No development-tree fallback, model, network or environment mutation.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import stat
import sys
import uuid

MAX_JSON = 1 << 20


def require(condition, message):
    if not condition:
        raise ValueError(message)


def plain(path, directory=False):
    require(path.is_absolute() and '..' not in path.parts, 'noncanonical path')
    current = Path(path.anchor)
    for index, part in enumerate(path.parts[1:]):
        current /= part
        info = current.lstat()
        want_dir = index < len(path.parts) - 2 or directory
        require(stat.S_ISDIR(info.st_mode) if want_dir else
                stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                'symlink or nonregular path')
    return path


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def windows_bootstrap(entry, stack):
    # This is the only import before the adapter can verify the package tree.
    # Read the fixed module from a no-follow handle with pinned ancestors.
    import ctypes as c
    from ctypes import wintypes as w
    import msvcrt
    from types import ModuleType

    kernel = c.WinDLL('kernel32.dll', use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = (w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE)
    create.restype = w.HANDLE
    inspect = kernel.GetFileInformationByHandleEx
    inspect.argtypes = (w.HANDLE, c.c_int, c.c_void_p, w.DWORD)
    inspect.restype = w.BOOL
    close = kernel.CloseHandle
    close.argtypes, close.restype = (w.HANDLE,), w.BOOL
    drive_type = kernel.GetDriveTypeW
    drive_type.argtypes, drive_type.restype = (w.LPCWSTR,), w.UINT

    def close_checked(handle):
        if not close(handle):
            raise c.WinError(c.get_last_error())

    def pin(path, directory, owner):
        handle = create('\\\\?\\' + str(path), 0x80000000, 1, None, 3, 0x02200000, None)
        if handle == w.HANDLE(-1).value:
            raise c.WinError(c.get_last_error())
        owner.callback(close_checked, handle)
        attributes = (w.DWORD * 2)()
        if not inspect(handle, 9, c.byref(attributes), c.sizeof(attributes)):  # FileAttributeTagInfo
            raise c.WinError(c.get_last_error())
        require(not attributes[0] & 0x400 and bool(attributes[0] & 0x10) == directory,
                'reparse point or wrong type in packaged source')
        return handle

    require(len(entry.anchor) == 3 and entry.anchor[1:] == ':\\' and drive_type(entry.anchor) == 3,
            'fixed local package drive required')
    source = entry.parent.parent / 'engine' / 'src'
    adapter = source / 'hana_math_engine' / 'windows_io.py'
    for parent in reversed(adapter.parents):
        pin(parent, True, stack)
    pin(entry.parent, True, stack)
    pin(entry, False, stack)
    with ExitStack() as ownership:
        handle = pin(adapter, False, ownership)
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY | os.O_NOINHERIT)
        ownership.pop_all()
    stream = stack.enter_context(os.fdopen(fd, 'rb'))
    info = os.fstat(stream.fileno())
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'adapter must be a single-link regular file')
    module = ModuleType('_hana_math_windows_io')
    exec(compile(stream.read(), str(adapter), 'exec'), module.__dict__)
    return module, source


def run_windows(request_arg, result_arg):
    directory = Path.cwd()
    require(directory.parent.name == 'core-calls' and directory.parent.parent.name == 'research',
            'fixed research/core-calls cwd required')
    require(str(uuid.UUID(directory.name)) == directory.name, 'canonical UUID required')
    request, result = directory / 'request.json', directory / 'result.json'
    require(request_arg == str(request) and result_arg == str(result), 'fixed absolute request/result required')
    with ExitStack() as stack:
        win, source = windows_bootstrap(Path(__file__).absolute(), stack)
        stack.enter_context(win.pinned_directory(directory))
        require(win.inspect(result, False, missing=True) is None, 'result already exists')
        with os.fdopen(win.open_read(request), 'rb') as stream:
            content = stream.read(MAX_JSON + 1)
        require(len(content) <= MAX_JSON, 'request exceeds 1 MiB')
        document = json.loads(content.decode('utf-8'), object_pairs_hook=strict_object)
        require(isinstance(document, dict) and document.get('requestId') == directory.name,
                'request ID must match cwd')
        stack.enter_context(win.pinned_source(source))
        sys.path.insert(0, str(source))
        try:
            from hana_math_engine import research
            require(Path(research.__file__).resolve(strict=True).is_relative_to(source.resolve(strict=True)),
                    'import escaped packaged source')
            output = research.dispatch(directory.parent.parent.parent, document)
            win.atomic_write(result, research.encoded(output), replace=False)
            return output
        finally:
            sys.path.pop(0)


def run(request_arg, result_arg):
    require(sys.version_info[:2] == (3, 12), 'Python 3.12 required')
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode,
            '-I -S -B required')
    if sys.platform == 'win32':
        return run_windows(request_arg, result_arg)
    directory = plain(Path.cwd(), directory=True)
    require(directory.parent.name == 'core-calls' and directory.parent.parent.name == 'research',
            'fixed research/core-calls cwd required')
    require(str(uuid.UUID(directory.name)) == directory.name, 'canonical UUID required')
    request, result = directory / 'request.json', directory / 'result.json'
    require(request_arg == str(request) and result_arg == str(result), 'fixed absolute request/result required')
    plain(request)
    require(not os.path.lexists(result), 'result already exists')
    fd = os.open(request, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'invalid request file')
        content = handle.read(MAX_JSON + 1)
    require(len(content) <= MAX_JSON, 'request exceeds 1 MiB')
    document = json.loads(content, object_pairs_hook=strict_object)
    require(isinstance(document, dict) and document.get('requestId') == directory.name,
            'request ID must match cwd')
    entry = plain(Path(__file__).absolute())
    source = plain(entry.parent.parent / 'engine' / 'src', directory=True)
    for name in ('danus', 'hana_math_engine'):
        tree = plain(source / name, directory=True)
        for parent, directories, files in os.walk(tree, followlinks=False):
            for name in directories:
                plain(Path(parent) / name, directory=True)
            for name in files:
                plain(Path(parent) / name)
    plain(source / 'hana_math_engine' / 'research.py')
    sys.path.insert(0, str(source))
    from hana_math_engine import research
    require(Path(research.__file__).resolve().is_relative_to(source), 'import escaped packaged source')
    output = research.dispatch(directory.parent.parent.parent, document)
    research.atomic_write(result, research.encoded(output))
    return output


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('request')
    parser.add_argument('result')
    args = parser.parse_args()
    try:
        run(args.request, args.result)
    except Exception as error:
        print(f'RESEARCH_ENTRY_FAILED: {type(error).__name__}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
