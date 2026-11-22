"""Fixed offline software diagnostic for Hana's managed command runtime.

Run only with -I -S -B. No tool dispatcher, model/verifier implementation,
network, arbitrary project parameter or mathematical computation is exposed.
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

MAX_JSON = 16384
OPERATION = "core-diagnostic"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def plain_path(root: Path, relative: str, *, directory: bool = False) -> Path:
    target = root
    parts = relative.split("/")
    for index, part in enumerate(parts):
        require(part not in ("", ".", "..") and "\\" not in part, "invalid relative path")
        target = target / part
        info = target.lstat()
        require(not stat.S_ISLNK(info.st_mode), "symlink is not allowed")
        is_directory = index < len(parts) - 1 or directory
        require(stat.S_ISDIR(info.st_mode) if is_directory else stat.S_ISREG(info.st_mode), "unexpected path type")
    require(target.resolve(strict=True) == target, "path is not canonical")
    return target


def read_request(request: Path, win=None) -> dict:
    descriptor = win.open_read(request) if win else os.open(request, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as handle:
        if not win:
            info = os.fstat(handle.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "request must be a single-link regular file")
        content = handle.read(MAX_JSON + 1)
    require(len(content) <= MAX_JSON, "request too large")
    document = json.loads(content.decode("utf-8"))
    require(isinstance(document, dict), "request must be an object")
    require(set(document) == {"schemaVersion", "requestId", "operation"}, "unexpected request fields")
    require(type(document["schemaVersion"]) is int and document["schemaVersion"] == 1, "unsupported schema")
    require(document["operation"] == OPERATION, "unsupported diagnostic operation")
    return document


def windows_bootstrap(entry, stack):
    # Same fixed-package bootstrap as research_entry.py: load only the Windows
    # I/O module, from a no-follow handle and with all ancestors pinned.
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


def run(request_arg: str, result_arg: str) -> dict:
    require(sys.version_info[:2] == (3, 12), "Python 3.12 is required")
    require(sys.flags.isolated == 1 and sys.flags.no_site == 1 and sys.dont_write_bytecode, "isolated -I -S -B flags are required")
    with ExitStack() as stack:
        return _run(request_arg, result_arg, stack)


def _run(request_arg: str, result_arg: str, stack) -> dict:
    directory = Path.cwd()
    windows = sys.platform == 'win32'
    if not windows:
        require(directory.resolve(strict=True) == directory, "diagnostic cwd must be canonical")
    require(directory.parent.name == "core-checks", "diagnostic cwd must be under core-checks")
    require(str(uuid.UUID(directory.name)) == directory.name, "diagnostic directory must use a canonical UUID")
    if not windows:
        require(not directory.is_symlink() and not directory.parent.is_symlink(), "diagnostic directory cannot be a symlink")
    request = directory / "request.json"
    result = directory / "result.json"
    # Exact absolute names prevent alternate parents, traversal and output aliases.
    require(request_arg == str(request) and result_arg == str(result), "request/result must use the fixed diagnostic directory")
    entry = Path(__file__).absolute()
    win = None
    if windows:
        win, source = windows_bootstrap(entry, stack)
        stack.enter_context(win.pinned_directory(directory))
        require(win.inspect(result, False, missing=True) is None, "result already exists")
    else:
        plain_path(directory, "request.json")
        require(not os.path.lexists(result), "result already exists")
    document = read_request(request, win)
    require(document["requestId"] == directory.name, "request ID does not match its directory")

    if win:
        stack.enter_context(win.pinned_source(source))
        win.inspect(source / 'danus/core/glossary_global.json', False)
        win.inspect(source / 'hana_math_engine/service.py', False)
    else:
        require(not entry.is_symlink() and entry.resolve(strict=True) == entry, "entry must be canonical")
        package = entry.parent.parent
        source = plain_path(package, "engine/src", directory=True)
        plain_path(source, "danus/core/glossary_global.json")
        # Refuse source-tree symlinks before executing any package module.
        for name in ("danus", "hana_math_engine"):
            tree = plain_path(source, name, directory=True)
            for parent, directories, files in os.walk(tree, followlinks=False):
                for child in [*directories, *files]:
                    require(not (Path(parent) / child).is_symlink(), "symlink in packaged core source")
        plain_path(source, "hana_math_engine/service.py")
    sys.path.insert(0, str(source))

    # Imports are fixed and originate in the relocated package, not the CWD or
    # development checkout. -I/-S exclude user/site and PYTHONPATH injection.
    import danus.core as core
    import hana_math_engine as engine
    from danus.core.glossary import global_glossary

    for module in (core, engine):
        location = Path(module.__file__).resolve(strict=True)
        require(location.is_relative_to(source.resolve(strict=True) if win else source), "core import escaped the packaged source")
    if win:
        with os.fdopen(win.open_read(source / 'danus/core/glossary_global.json'), 'rb') as handle:
            glossary_document = json.loads(handle.read().decode('utf-8'))
    else:
        glossary_file = plain_path(source, "danus/core/glossary_global.json")
        glossary_document = json.loads(glossary_file.read_text(encoding="utf-8"))
    require(isinstance(glossary_document, dict) and bool(global_glossary()), "bundled glossary is missing or empty")

    # Always a fresh owned subdirectory. Never accept a caller's project path or
    # use a fake accepting verifier to write a fact in this production diagnostic.
    project = directory / "project"
    project.mkdir(mode=0o700)
    if win:
        stack.enter_context(win.pinned_directory(project))
    else:
        plain_path(directory, "project", directory=True)
    service = engine.CoreService(project, author="core-diagnostic", role="worker", verifier=None)
    finding = service.gm_add("plan", "opaque diagnostic marker", evidence="software fixture only")
    searched = service.gm_search("opaque diagnostic marker", kinds=["plan"])
    matches = searched["results_by_kind"]["plan"]["results"]
    require(any(item["entry"]["id"] == finding["id"] and item["entry"]["author"] == "core-diagnostic" for item in matches), "global memory round trip failed")
    refused = service.fact_submit("opaque diagnostic record", "opaque diagnostic payload")
    require(refused.get("accepted") is False and refused.get("verdict") == "error"
            and refused.get("error") == "verifier is not configured", "missing verifier did not fail closed")
    require(core.FactGraph(project).list() == [], "diagnostic unexpectedly produced facts")
    require(not (project / "fact_graph").exists(), "diagnostic unexpectedly wrote the fact graph")

    output = {
        "schemaVersion": 1, "requestId": document["requestId"], "operation": OPERATION,
        "ok": True, "pythonVersion": ".".join(str(part) for part in sys.version_info[:3]),
        "checks": {"imports": True, "glossary": True, "globalMemory": True,
                   "verifierRequired": True, "noFacts": True},
    }
    # Exclusive no-follow creation prevents overwriting an existing result or
    # symlink. The parent only reads after a confirmed successful process exit.
    if win:
        win.atomic_write(result, (json.dumps(output, ensure_ascii=False) + '\n').encode('utf-8'), replace=False)
        return output
    descriptor = os.open(result, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False)
        handle.write("\n")
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description="Fixed Hana Math software diagnostic", allow_abbrev=False)
    parser.add_argument("--request", required=True)
    parser.add_argument("--result", required=True)
    args = parser.parse_args()
    try:
        run(args.request, args.result)
    except Exception as error:
        print(f"CORE_DIAGNOSTIC_FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
