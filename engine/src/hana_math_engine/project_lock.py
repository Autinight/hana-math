"""Exclusive nonblocking project lock on a caller-owned, synchronous file descriptor."""
import sys


class ProjectLockBusy(BlockingIOError):
    """Only actual contention is retryable by the project lock wait loop."""


if sys.platform == 'win32':
    import ctypes
    from ctypes import wintypes
    import errno
    import msvcrt

    class _Offset(ctypes.Structure):
        _fields_ = [('Offset', wintypes.DWORD), ('OffsetHigh', wintypes.DWORD)]

    class _Position(ctypes.Union):
        _fields_ = [('offset', _Offset), ('Pointer', ctypes.c_void_p)]

    class _Overlapped(ctypes.Structure):
        _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                    ('position', _Position), ('hEvent', wintypes.HANDLE)]

    _lock_file_ex = ctypes.WinDLL('kernel32.dll', use_last_error=True).LockFileEx
    _lock_file_ex.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                             wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(_Overlapped))
    _lock_file_ex.restype = wintypes.BOOL
    _LOCKFILE_EXCLUSIVE_LOCK = 0x00000002
    _LOCKFILE_FAIL_IMMEDIATELY = 0x00000001
    _ERROR_LOCK_VIOLATION = 33
    _RANGE_DWORD = 0xFFFFFFFF

    def lock_project(fd):
        # Borrow the CRT handle; only the caller closes the fd. Lock from byte
        # zero for UINT64_MAX bytes, including past EOF, without sizing the file.
        handle = msvcrt.get_osfhandle(fd)
        overlapped = _Overlapped()
        if not _lock_file_ex(handle, _LOCKFILE_EXCLUSIVE_LOCK | _LOCKFILE_FAIL_IMMEDIATELY,
                             0, _RANGE_DWORD, _RANGE_DWORD, ctypes.byref(overlapped)):
            code = ctypes.get_last_error()
            error = ctypes.WinError(code)
            if code == _ERROR_LOCK_VIOLATION:
                raise ProjectLockBusy(errno.EAGAIN, error.strerror) from error
            raise error
else:
    import fcntl

    def lock_project(fd):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ProjectLockBusy(*error.args) from error
