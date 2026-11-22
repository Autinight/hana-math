"""Local, synchronous Win32 I/O for the offline CPython adapter.

Keep each ancestor open without write/delete sharing while using a name below
it. Open each component as a reparse point, not through it. All actual I/O
uses the opened object (or, for directory enumeration, the pinned directory).
This is not a sandbox for code running as the workspace/package owner.
"""

from contextlib import ExitStack, contextmanager
import ctypes as C
from ctypes import wintypes as W
import msvcrt
import os
from pathlib import Path
import re
import uuid


class UnsafePath(ValueError):
    pass


class _FileInfo(C.Structure):
    _fields_ = [('attributes', W.DWORD), ('created', W.FILETIME),
                ('accessed', W.FILETIME), ('written', W.FILETIME),
                ('volume', W.DWORD), ('size_hi', W.DWORD), ('size_lo', W.DWORD),
                ('links', W.DWORD), ('index_hi', W.DWORD), ('index_lo', W.DWORD)]


class _FileId(C.Structure):
    _fields_ = [('volume', C.c_uint64), ('identifier', C.c_ubyte * 16)]


class _Rename(C.Structure):
    # The first field is a union of BOOLEAN ReplaceIfExists and DWORD Flags.
    _fields_ = [('replace', W.DWORD), ('root', W.HANDLE),
                ('length', W.DWORD), ('name', W.WCHAR * 1)]


_kernel = C.WinDLL('kernel32.dll', use_last_error=True)


def _bind(name, result, *args):
    function = getattr(_kernel, name)
    function.restype, function.argtypes = result, args
    return function


_create = _bind('CreateFileW', W.HANDLE, W.LPCWSTR, W.DWORD, W.DWORD, C.c_void_p,
                W.DWORD, W.DWORD, W.HANDLE)
_close = _bind('CloseHandle', W.BOOL, W.HANDLE)
_type = _bind('GetFileType', W.DWORD, W.HANDLE)
_info = _bind('GetFileInformationByHandle', W.BOOL, W.HANDLE, C.POINTER(_FileInfo))
_info_ex = _bind('GetFileInformationByHandleEx', W.BOOL, W.HANDLE, C.c_int, C.c_void_p, W.DWORD)
_set_info = _bind('SetFileInformationByHandle', W.BOOL, W.HANDLE, C.c_int, C.c_void_p, W.DWORD)
_final_path = _bind('GetFinalPathNameByHandleW', W.DWORD, W.HANDLE, W.LPWSTR, W.DWORD, W.DWORD)
_mkdir = _bind('CreateDirectoryW', W.BOOL, W.LPCWSTR, C.c_void_p)
_write = _bind('WriteFile', W.BOOL, W.HANDLE, C.c_char_p, W.DWORD, C.POINTER(W.DWORD), C.c_void_p)
_drive_type = _bind('GetDriveTypeW', W.UINT, W.LPCWSTR)
_flush = _bind('FlushFileBuffers', W.BOOL, W.HANDLE)

_INVALID = W.HANDLE(-1).value
_READ, _WRITE, _DELETE, _ATTR = 0x80000000, 0x40000000, 0x10000, 0x80
_SHARE_READ, _SHARE_WRITE, _SHARE_DELETE = 1, 2, 4
_CREATE_NEW, _OPEN_EXISTING, _OPEN_ALWAYS = 1, 3, 4
_NO_FOLLOW = 0x00200000 | 0x02000000  # OPEN_REPARSE_POINT | BACKUP_SEMANTICS
_WRITE_THROUGH = 0x80000000
_DIRECTORY, _REPARSE = 0x10, 0x400


def _check(result):
    if not result:
        raise C.WinError(C.get_last_error())
    return result


def _parts(path):
    path = Path(path)
    if not re.fullmatch(r'[A-Za-z]:\\', path.anchor) or any(
        p == '..' or p.endswith((' ', '.')) or any(ord(c) < 32 or c in ':<>"|?*' for c in p)
        or Path(p).is_reserved() for p in path.parts[1:]
    ):
        raise UnsafePath('absolute local drive path without aliases required')
    return path.parts


def _open(name, access, sharing, mode=_OPEN_EXISTING, flags=0):
    handle = _create(name, access, sharing, None, mode, _NO_FOLLOW | flags, None)
    if handle == _INVALID:
        raise C.WinError(C.get_last_error())
    return handle


def _inspect(handle, directory):
    info = _FileInfo()
    C.set_last_error(0)
    kind = _type(handle)
    if kind == 0 and C.get_last_error():
        raise C.WinError(C.get_last_error())
    if kind != 1:  # FILE_TYPE_DISK
        raise UnsafePath('not a disk file')
    _check(_info(handle, C.byref(info)))
    is_dir = bool(info.attributes & _DIRECTORY)
    if (info.attributes & _REPARSE or (directory is not None and directory != is_dir)
            or not is_dir and info.links != 1):
        raise UnsafePath('reparse point, unexpected type or non-single-link file')
    identity = _FileId()
    _check(_info_ex(handle, 18, C.byref(identity), C.sizeof(identity)))  # FileIdInfo
    return (identity.volume, bytes(identity.identifier)), is_dir, (info.size_hi << 32) | info.size_lo


def _verify_name(name, expected, directory):
    # A second no-follow open compares the volume and 128-bit file ID, not
    # a spelling, timestamp, or CRT stat fields (st_ino can be zero on Windows).
    handle = _open(name, _ATTR, _SHARE_READ | _SHARE_WRITE | _SHARE_DELETE)
    try:
        if _inspect(handle, directory)[0] != expected:
            raise UnsafePath('file identity changed')
    finally:
        _check(_close(handle))


def _volume_root(drive, stack):
    if _drive_type(drive) != 3:  # DRIVE_FIXED; no remote or removable fallback
        raise UnsafePath('fixed local drive required')
    root = _open('\\\\?\\' + drive, _READ, _SHARE_READ)
    stack.callback(_close_checked, root)
    identity = _inspect(root, True)[0]
    buffer = C.create_unicode_buffer(128)
    count = _check(_final_path(root, buffer, len(buffer), 1))  # VOLUME_NAME_GUID
    name = buffer.value
    if count >= len(buffer) or not re.fullmatch(r'\\\\\?\\Volume\{[0-9A-Fa-f-]{36}\}\\', name):
        raise UnsafePath('drive must identify a volume root (not a substituted directory)')
    _verify_name(name, identity, True)
    return name


def _close_checked(handle):
    _check(_close(handle))


@contextmanager
def _directories(parts, create=False):
    with ExitStack() as stack:
        name = _volume_root(parts[0], stack)
        for part in parts[1:]:
            name = name.rstrip('\\') + '\\' + part
            try:
                handle = _open(name, _READ, _SHARE_READ)
            except FileNotFoundError:
                if not create:
                    raise
                if not _mkdir(name, None) and C.get_last_error() != 183:  # ERROR_ALREADY_EXISTS
                    raise C.WinError(C.get_last_error())
                handle = _open(name, _READ, _SHARE_READ)
            stack.callback(_close_checked, handle)
            identity = _inspect(handle, True)[0]
            _verify_name(name, identity, True)
        yield name


@contextmanager
def pinned_directory(path, *, create=False):
    with _directories(_parts(path), create) as name:
        yield name


@contextmanager
def _location(path):
    parts = _parts(path)
    if len(parts) == 1:
        raise UnsafePath('a file name is required')
    with _directories(parts[:-1]) as parent:
        yield parent.rstrip('\\') + '\\' + parts[-1]


def _inspect_name(name, directory, missing):
    try:
        handle = _open(name, _ATTR, _SHARE_READ | _SHARE_WRITE)
    except FileNotFoundError:
        if missing:
            return None
        raise
    try:
        identity, is_dir, size = _inspect(handle, directory)
        _verify_name(name, identity, is_dir)
        return is_dir, size
    finally:
        _close_checked(handle)


def inspect(path, directory=None, *, missing=False):
    with _location(path) as name:
        return _inspect_name(name, directory, missing)


def _fd(path, access, mode, sharing, flags):
    with _location(path) as name:
        handle = _open(name, access, sharing, mode)
        try:
            identity = _inspect(handle, False)[0]
            _verify_name(name, identity, False)
            return msvcrt.open_osfhandle(handle, flags | os.O_BINARY | os.O_NOINHERIT)
        except BaseException:
            _close_checked(handle)
            raise


def open_read(path):
    return _fd(path, _READ, _OPEN_EXISTING, _SHARE_READ, os.O_RDONLY)


def open_lock(path):
    # Permit both contenders to get synchronous fds; only LockFileEx decides busy.
    return _fd(path, _READ | _WRITE, _OPEN_ALWAYS, _SHARE_READ | _SHARE_WRITE, os.O_RDWR)


def append(path, data, check_size):
    fd = _fd(path, _WRITE, _OPEN_ALWAYS, _SHARE_READ, os.O_WRONLY | os.O_APPEND)
    with os.fdopen(fd, 'ab') as stream:
        check_size(_inspect(msvcrt.get_osfhandle(fd), False)[2], len(data))
        stream.write(data)
        stream.flush()
        _check(_flush(msvcrt.get_osfhandle(stream.fileno())))


def walk(root):
    """Yield checked entries lazily, before following any directory."""
    def visit(directory, stable):
        with os.scandir(stable) as entries:
            for entry in entries:
                path = directory / entry.name
                _parts(path)
                name = stable.rstrip('\\') + '\\' + entry.name
                handle = _open(name, _READ, _SHARE_READ | _SHARE_WRITE)
                try:
                    identity, is_dir, size = _inspect(handle, None)
                    _verify_name(name, identity, is_dir)
                    yield path, is_dir, size
                    if is_dir:
                        # Reopen with no WRITE sharing for the directory descent.
                        pinned = _open(name, _READ, _SHARE_READ)
                        try:
                            if _inspect(pinned, True)[0] != identity:
                                raise UnsafePath('directory identity changed')
                            yield from visit(path, name)
                        finally:
                            _close_checked(pinned)
                finally:
                    _close_checked(handle)

    with pinned_directory(root) as stable:
        yield from visit(Path(root), stable)


@contextmanager
def pinned_source(source):
    """Pin the fixed package trees through import; do not add CWD to sys.path."""
    def pin_tree(stable, stack):
        with os.scandir(stable) as entries:
            for entry in entries:
                name = stable + '\\' + entry.name
                handle = _open(name, _READ, _SHARE_READ)
                stack.callback(_close_checked, handle)
                identity, is_dir, _ = _inspect(handle, None)
                _verify_name(name, identity, is_dir)
                if is_dir:
                    pin_tree(name, stack)

    with pinned_directory(source) as stable, ExitStack() as stack:
        for child in ('danus', 'hana_math_engine'):
            name = stable + '\\' + child
            handle = _open(name, _READ, _SHARE_READ)
            stack.callback(_close_checked, handle)
            _verify_name(name, _inspect(handle, True)[0], True)
            pin_tree(name, stack)
        yield


def _disposition(handle):
    # FILE_DISPOSITION_INFO.DeleteFile is a BOOLEAN, not a Win32 BOOL.
    delete = C.c_ubyte(1)
    _check(_set_info(handle, 4, C.byref(delete), C.sizeof(delete)))


def unlink(path):
    with _location(path) as name:
        handle = _open(name, _DELETE | _ATTR, _SHARE_READ)
        try:
            _verify_name(name, _inspect(handle, False)[0], False)
            _disposition(handle)
        finally:
            _close_checked(handle)


def _rename(handle, destination, replace):
    # FileRenameInfo selects the *open* source, so swapping the temp name
    # cannot publish some other object. The destination's parent is pinned.
    # This replaces the destination name, not its contents via a second open.
    value = destination.encode('utf-16-le', errors='surrogatepass')
    buffer = C.create_string_buffer(max(C.sizeof(_Rename), _Rename.name.offset + len(value) + 2))
    info = _Rename.from_buffer(buffer)
    info.replace, info.length = int(replace), len(value)
    C.memmove(C.addressof(buffer) + _Rename.name.offset, value, len(value))
    _check(_set_info(handle, 3, buffer, len(buffer)))


def atomic_write(path, data, *, replace=True):
    """Flush data, rename on the same volume, then flush the published handle.

    See Microsoft CreateFileW FILE_FLAG_WRITE_THROUGH, FlushFileBuffers, and
    SetFileInformationByHandle FileRenameInfo. This is not a directory fsync
    or a claim about power-loss behavior for every filesystem/controller.
    """
    with _location(path) as destination:
        if _inspect_name(destination, False, True) is not None and not replace:
            raise FileExistsError('result already exists')
        temporary = destination.rsplit('\\', 1)[0] + '\\.write-' + uuid.uuid4().hex
        handle = _open(temporary, _WRITE | _READ | _DELETE, _SHARE_READ, _CREATE_NEW, _WRITE_THROUGH)
        published = False
        try:
            identity = _inspect(handle, False)[0]
            _verify_name(temporary, identity, False)
            # Keep the original Win32 handle through the rename. DuplicateHandle
            # is unnecessary: WriteFile can use the same synchronous handle.
            written = W.DWORD()
            _check(_write(handle, data, len(data), C.byref(written), None))
            if written.value != len(data):
                raise OSError('short write')
            _check(_flush(handle))
            # Check again immediately before publication. If no destination
            # exists, don't enable replacement in the underlying rename.
            exists = _inspect_name(destination, False, True) is not None
            _rename(handle, destination, replace and exists)
            published = True
            _verify_name(destination, identity, False)
            _check(_flush(handle))
        finally:
            try:
                if not published:
                    _disposition(handle)
            finally:
                _close_checked(handle)
