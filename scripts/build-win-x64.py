#!/usr/bin/env python3
"""Offline Hana Math Windows x64 staging and optional local installation ZIP.

Run with a build-machine Python 3.9+ from the main checkout. The target Python
is input bytes only. No downloading, installing, runtime smoke or publication.
"""
import argparse
import gzip
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import zipfile

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SPEC = importlib.util.spec_from_file_location('win_python_input', HERE / 'verify-windows-python.py')
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)

TAG = '20260901'
RELEASE = f'https://github.com/astral-sh/python-build-standalone/releases/download/{TAG}/'
ASSET = f'cpython-3.12.14+{TAG}-{gate.TARGET}-install_only.tar.gz'
FULL = f'cpython-3.12.14+{TAG}-{gate.TARGET}-pgo-full.tar.zst'
FULL_SHA = 'b7cf8be5cd5222d1e456fbf71257efe558d84fe092757b6892c16584e5df01c2'
PREFIX = 'dependencies/python/'
EXE = PREFIX + 'python.exe'
HEADER = 'include/patchlevel.h'
SOURCE_INV = 'dependencies/python-source-inventory.json'
PYTHON_INV = 'dependencies/python-inventory.json'
BUILD_INV = 'build-inventory.json'
PACK_ROOT = Path('dist/validation/windows-x64-001/pack')
APP = 'packages/hana-math/'
ENGINE_LEGAL = ('engine/LICENSE', 'engine/UPSTREAM.json', 'engine/RESEARCH_UPSTREAM.json')
SOURCE_TREES = (APP.rstrip('/'), 'engine/src', *ENGINE_LEGAL)
PLATFORM = {'schemaVersion': 1, 'platform': 'win32', 'arch': 'x64'}
REDIST_URL = 'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist'
NOTICE = f'''# Windows x64 prerequisite

Before using this local test package, install the current supported Microsoft
Visual C++ v14 **x64** Redistributable from Microsoft's official page:
{REDIST_URL}

The App ZIP does not redistribute Microsoft VC runtime DLLs or the installer.
The App uses its bundled CPython 3.12.14, not your system Python. The App does
not install the Redistributable or download a replacement Python at runtime.

安装本地测试包前，请从上述微软官方页面安装 Visual C++ v14 x64 可再发行组件。
本包不包含该安装器或 Microsoft VC 运行库；无需另装 Python。

通过 Windows 版 Hana 的应用管理器导入这个 ZIP，不要运行压缩包里的 python.exe。
首次使用原生运行模式时，按 Hana 自己的提示初始化 Windows 原生运行环境，并审核原生执行与联网权限。
如 Hana 报原生环境尚未就绪，请修复 Hana 的原生环境；不要关闭系统防护或改用系统 Python。
'''.encode('utf-8')

# Windows DLLs owned by Microsoft are external prerequisites, never payload.
VC = re.compile(r'(?:vcruntime|msvcp|msvcr|concrt|vccorlib|vcamp|vcomp|ucrtbase|api-ms-win-crt-).*\.dll$', re.I)
MACHO = {bytes.fromhex(s) for s in ('feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca')}
PRIVATE = re.compile(r'^(?:\.git|\.hana|\.hanako|\.ssh|\.aws|\.ds_store|node_modules|__pycache__|\.env(?:\..*)?|auth\.json|credentials\.json|monitor-auth-token|app-data|research-runs)$', re.I)
REQUIRED_PY = {'python.exe', 'python312.dll', 'python3.dll', 'LICENSE.txt', HEADER,
               'Lib/os.py', 'Lib/encodings/__init__.py', 'Lib/encodings/utf_8.py', 'Lib/importlib/__init__.py',
               'Lib/json/__init__.py', 'Lib/sqlite3/__init__.py', 'Lib/ssl.py', 'Lib/hashlib.py', 'Lib/ctypes/__init__.py',
               'DLLs/_sqlite3.pyd', 'DLLs/sqlite3.dll', 'DLLs/_ssl.pyd', 'DLLs/libcrypto-3-x64.dll',
               'DLLs/libssl-3-x64.dll', 'DLLs/_hashlib.pyd', 'DLLs/_bz2.pyd', 'DLLs/_lzma.pyd', 'DLLs/_ctypes.pyd',
               'DLLs/libffi-8.dll', 'DLLs/_socket.pyd', 'DLLs/select.pyd', 'DLLs/pyexpat.pyd'}
REQUIRED_LICENSES = {'LICENSE.cpython.txt', 'LICENSE.sqlite.txt', 'LICENSE.openssl-3.txt', 'LICENSE.libffi.txt',
                     'LICENSE.bzip2.txt', 'LICENSE.liblzma.txt', 'LICENSE.tcl.txt', 'LICENSE.tix.txt',
                     'LICENSE.expat.txt', 'LICENSE.zlib.txt'}
COPY_MATCH = ('python.exe', 'python312.dll', 'DLLs/_sqlite3.pyd', 'DLLs/sqlite3.dll', 'DLLs/_ssl.pyd',
              'DLLs/libssl-3-x64.dll', 'LICENSE.txt', HEADER)


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2) + '\n').encode('ascii')


def row(name, data, mode=0o644):
    return {'path': name, 'size': len(data), 'sha256': sha(data), 'mode': f'0o{mode:o}'}


def verify_regular(file, limit, digest):
    # Recheck the exact immutable bytes used after the verifier, not merely the pathname.
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    require(not file.is_symlink(), f'symlink archive refused: {file.name}')
    with os.fdopen(os.open(file, flags), 'rb') as f:
        info = os.fstat(f.fileno())
        require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= limit, f'expected bounded regular archive: {file.name}')
        data = f.read(limit + 1)
    require(len(data) == info.st_size and sha(data) == digest, f'archive SHA-256 mismatch: {file.name}')
    return data


def python_allowed(name):
    parts = name.split('/')
    leaf = parts[-1]
    if VC.fullmatch(leaf) or leaf.lower().endswith(('.pyc', '.pyo', '.pdb', '.whl', '.pth')) or any(PRIVATE.fullmatch(p) for p in parts):
        return False
    if name in ('python.exe', 'python312.dll', 'python3.dll', 'LICENSE.txt', HEADER):
        return True
    if parts[0] == 'DLLs' and len(parts) == 2:
        return leaf.endswith(('.dll', '.pyd')) and not leaf.startswith(('_test', '_ctypes_test'))
    if parts[0] == 'Lib':
        excluded = {'site-packages', 'test', 'tests', 'ensurepip', 'idlelib', 'turtledemo'}
        return not any(p.lower() in excluded for p in parts[1:]) and not leaf.lower().endswith(('.dll', '.exe', '.pyd', '.so', '.dylib'))
    # Preserve Tcl/Tk data for its bundled extension; do not ship development libraries.
    return parts[0] == 'tcl' and not any(p in {'demos', 'tix8.4.3'} for p in parts) and not leaf.lower().endswith(('.lib', '.dll', '.exe', '.pyd'))


def check_payload(name, data, source=False):
    require(data[:4] not in MACHO, f'Mach-O payload refused: {name}')
    require(not any(PRIVATE.fullmatch(p) for p in name.split('/')), f'private path refused: {name}')
    require(not VC.fullmatch(name.split('/')[-1]), f'Microsoft runtime redistributable refused: {name}')
    if source:
        require(not data.startswith(b'MZ'), f'unreviewed PE image in source tree: {name}')
    elif Path(name).suffix.lower() in {'.exe', '.dll', '.pyd'}:
        require(data[:2] == b'MZ' and len(data) >= 64, f'not PE: {name}')
        off, = struct.unpack_from('<I', data, 60)
        require(64 <= off <= len(data) - 26 and data[off:off + 6] == b'PE\0\0\x64\x86'
                and data[off + 24:off + 26] == b'\x0b\x02', f'not PE32+ AMD64: {name}')


def load_python(archive):
    require(archive.name == ASSET, f'expected paired pinned asset {ASSET}')
    audited = gate.verify(archive)
    data = verify_regular(archive, gate.MAX_ARCHIVE, gate.PINS[ASSET])
    payload = {}
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as f:
        tar = gate.BoundedTar(f)
        for upstream, size in tar.members():
            name = upstream.removeprefix('python/')
            if python_allowed(name):
                content = tar.read(size)
                check_payload(name, content)
                payload[name] = content
            else:
                for start in range(0, size, gate.CHUNK):
                    tar.read(min(gate.CHUNK, size - start))
    require(not (REQUIRED_PY - payload.keys()), f'missing runtime files: {sorted(REQUIRED_PY - payload.keys())}')
    require(all(payload[name] for name in REQUIRED_PY), 'empty required runtime file')
    return payload, audited


def load_licenses(archive, runtime):
    require(archive.name == FULL, f'expected paired pinned legal source {FULL}')
    data = verify_regular(archive, gate.MAX_ARCHIVE, FULL_SHA)

    def tar(*args):
        # bsdtar reads the pinned zstd archive from stdin, only lists or emits
        # named members to stdout. The build never extracts links or runs them.
        result = subprocess.run(['/usr/bin/tar', *args], input=data, capture_output=True, timeout=25, check=True)
        return result.stdout

    names = tar('-tf', '-').decode('utf-8').splitlines()
    meta_name = 'python/PYTHON.json'
    paths = sorted(name for name in names if re.fullmatch(r'python/licenses/LICENSE\.[a-zA-Z0-9._-]+\.txt', name))
    selected = [meta_name, *paths, *('python/install/' + name for name in COPY_MATCH)]
    require(all(names.count(name) == 1 for name in selected), 'missing or duplicate legal/identity member')
    require(REQUIRED_LICENSES <= {Path(name).name for name in paths}, 'missing required same-release notices')
    meta = json.loads(tar('-xOf', '-', meta_name))
    require((meta.get('python_version'), meta.get('target_triple'), meta.get('libpython_link_mode'), meta.get('python_platform_tag'))
            == ('3.12.14', gate.TARGET, 'shared', 'win-amd64'), 'full archive has inconsistent target metadata')
    for name in COPY_MATCH:
        require(tar('-xOf', '-', 'python/install/' + name) == runtime[name], f'full/installed assets differ at {name}')
    result = {name.removeprefix('python/'): tar('-xOf', '-', name) for name in paths}
    require(all(value and len(value) <= 256 * 1024 for value in result.values()), 'invalid license size')
    return result


def git(*args, input=None):
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_NO_REPLACE_OBJECTS='1', GIT_OPTIONAL_LOCKS='0')
    return subprocess.run(['git', *args], cwd=ROOT, env=env, input=input, capture_output=True, timeout=30, check=True).stdout


def frozen_source(commit):
    require(re.fullmatch(r'[a-f0-9]{40}', commit), 'pass the entire frozen source commit SHA')
    require(git('rev-parse', '--verify', f'{commit}^{{commit}}').decode().strip() == commit, 'invalid source commit')
    git('merge-base', '--is-ancestor', commit, 'refs/heads/main')
    rows = []
    for record in git('ls-tree', '-rz', '--full-tree', commit, '--', *SOURCE_TREES).split(b'\0'):
        if not record:
            continue
        header, name = record.split(b'\t', 1)
        mode, kind, oid = header.decode('ascii').split()
        require(kind == 'blob' and mode in {'100644', '100755'}, f'nonregular source member: {name!r}')
        source = name.decode('utf-8')
        target = source.removeprefix(APP)
        if source.startswith(APP):
            require(target.split('/')[0] not in {'dependencies', 'engine', BUILD_INV,
                    'source-package-inventory.json', 'WINDOWS-PREREQUISITES.md'}, f'source overlaps generated path: {source}')
        rows.append((source, target, oid, int(mode[-3:], 8)))
    raw = io.BytesIO(git('cat-file', '--batch', input=''.join(f'{oid}\n' for _, _, oid, _ in rows).encode('ascii')))
    files, inventory = {}, []
    for source, target, oid, mode in rows:
        blob, kind, size = raw.readline().decode('ascii').strip().split()
        data = raw.read(int(size))
        require(blob == oid and kind == 'blob' and len(data) == int(size) and raw.read(1) == b'\n', f'invalid Git blob: {source}')
        require(target not in files, f'duplicate source target: {target}')
        check_payload(target, data, source=True)
        require(str(ROOT).encode() not in data, f'checkout path leaked in tracked source: {source}')
        files[target] = (data, mode)
        inventory.append({**row(target, data, mode), 'sourcePath': source, 'gitBlob': oid})
    require(not raw.read(1), 'trailing git batch output')
    return files, sorted(inventory, key=lambda item: item['path'])


def plan(commit, archive, full_archive):
    files, source = frozen_source(commit)
    manifest = json.loads(files['manifest.json'][0])
    require(manifest['id'] == 'hana-math' and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', manifest['version']), 'invalid source manifest')
    skills = sorted(name for name in files if re.fullmatch(r'roles/[^/]+/skills/[^/]+/SKILL\.md', name))
    require(len(skills) == 13, f'expected 13 role Skills; found {len(skills)}')
    require(set(ENGINE_LEGAL) <= files.keys() and {'index.js', 'ui/dashboard/workspace.html', 'engine/src/hana_math_engine/research.py'} <= files.keys(),
            'missing required App, workspace or engine source')
    runtime, audited = load_python(archive)
    licenses = load_licenses(full_archive, runtime)
    python_sources = []
    for payload, upstream in ((runtime, 'python/'), (licenses, 'python/')):
        for name, data in sorted(payload.items()):
            target = PREFIX + name
            require(target not in files, f'overlapping Python/legal source: {name}')
            mode = 0o755 if target == EXE else 0o644
            files[target] = (data, mode)
            python_sources.append({**row(target, data, mode), 'archive': ASSET if payload is runtime else FULL,
                                   'member': upstream + name})
    py_source = json_bytes({**PLATFORM, 'architecture': 'win32-x64', 'release': TAG, 'verification': audited,
                            'archives': {ASSET: {'url': RELEASE + ASSET.replace('+', '%2B'), 'sha256': gate.PINS[ASSET]},
                                         FULL: {'url': RELEASE + FULL.replace('+', '%2B'), 'sha256': FULL_SHA}},
                            'files': sorted(python_sources, key=lambda item: item['path'])})
    py_files = json_bytes({**PLATFORM, 'files': [row(name, *files[name]) for name in sorted(files) if name.startswith(PREFIX)]})
    descriptor = json_bytes({**PLATFORM, 'pythonVersion': '3.12.14', 'executable': EXE,
                             'sourceInventory': SOURCE_INV, 'sourceInventorySha256': sha(py_source),
                             'pythonInventory': {'path': PYTHON_INV, 'sha256': sha(py_files)},
                             'versionEvidence': {'path': HEADER, 'sha256': sha(runtime[HEADER])},
                             'originalDownload': {'url': RELEASE + ASSET.replace('+', '%2B'), 'sha256': gate.PINS[ASSET]},
                             'prerequisites': {'microsoftVisualCppRedistributable': {'architecture': 'x64', 'url': REDIST_URL}}})
    require(len(descriptor) < 16384, 'runtime descriptor exceeds bridge budget')
    files.update({SOURCE_INV: (py_source, 0o644), PYTHON_INV: (py_files, 0o644), 'dependencies/runtime.json': (descriptor, 0o644),
                  'WINDOWS-PREREQUISITES.md': (NOTICE, 0o644),
                  'source-package-inventory.json': (json_bytes({'schemaVersion': 1, 'sourceCommit': commit, 'files': source}), 0o644)})
    files[BUILD_INV] = (json_bytes({**PLATFORM, 'sourceCommit': commit,
                                   'files': [row(name, *files[name]) for name in sorted(files)]}), 0o644)
    names = gate.BoundedTar(None)
    for name, (data, _) in files.items():
        names.register('python/' + name, False)  # reuse Windows path/collision validation for the whole package
        check_payload(name, data)
    return files, manifest['version'], len(skills)


def materialize(stage, files):
    for name, (data, mode) in sorted(files.items()):
        file = stage / name
        file.parent.mkdir(parents=True, exist_ok=True)
        with file.open('xb') as f:
            f.write(data)
        file.chmod(mode)


def zip_stage(stage, archive, files):
    # Read back the on-disk stage; refuse unexpected files, links and drift.
    observed = set()
    for path in stage.rglob('*'):
        require(not path.is_symlink(), f'stage symlink refused: {path.name}')
        if not path.is_dir():
            require(path.is_file(), f'nonregular stage member: {path.name}')
            observed.add(path.relative_to(stage).as_posix())
    require(observed == files.keys(), 'stage member list drift')
    with zipfile.ZipFile(archive, 'x', allowZip64=False) as z:
        for name, (expected, mode) in sorted(files.items()):
            path = stage / name
            require(not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) == mode and path.read_bytes() == expected,
                    f'stage drift: {name}')
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | mode) << 16
            z.writestr(info, expected, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(archive) as z:
        require(z.namelist() == sorted(files), 'ZIP member list drift')
        for info in z.infolist():
            data, mode = files[info.filename]
            require((info.external_attr >> 16) == (stat.S_IFREG | mode) and z.read(info) == data,
                    f'ZIP mode/bytes drift: {info.filename}')


def safe_output(run):
    require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}', run), 'invalid fresh --run name')
    expected = PACK_ROOT / run
    git('check-ignore', '--', expected.as_posix())
    current = ROOT
    for part in PACK_ROOT.parts:
        current /= part
        require(not current.is_symlink(), f'output parent is a symlink: {current.name}')
        current.mkdir(exist_ok=True)
        require(current.is_dir(), f'output parent is not a directory: {current.name}')
    output = ROOT / expected
    require(not output.exists() and not output.is_symlink(), 'output already exists; no overwrites')
    return output


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--commit', required=True, help='full ancestor SHA on local main; only its Git blobs are staged')
    p.add_argument('--archive', required=True, type=Path, help=f'pinned {ASSET}')
    p.add_argument('--full-archive', required=True, type=Path, help=f'pinned {FULL}, for upstream notices')
    p.add_argument('--run', required=True, help='fresh directory name under ' + PACK_ROOT.as_posix())
    p.add_argument('--pack', action='store_true', help='also create an unsigned local ZIP from this explicitly frozen input')
    p.add_argument('--expected-version', help='required with --pack; must match the source manifest')
    args = p.parse_args(argv)
    try:
        require(Path.cwd().resolve() == ROOT and git('rev-parse', '--show-toplevel').decode().strip() == str(ROOT)
                and git('symbolic-ref', 'HEAD').decode().strip() == 'refs/heads/main', 'run in the primary main checkout')
        require(not args.pack or args.expected_version, '--pack requires --expected-version')
        output = safe_output(args.run)
        files, version, skills = plan(args.commit, args.archive, args.full_archive)
        require(args.expected_version is None or args.expected_version == version, 'frozen source manifest version mismatch')
        output.mkdir()  # exclusive reservation; never replace an existing run
        try:
            stage = output / 'hana-math'
            materialize(stage, files)
            archive = output / f'app-hana-math-{version}-windows-x64-local.zip' if args.pack else None
            if archive:
                zip_stage(stage, archive, files)
            result = {**PLATFORM, 'sourceCommit': args.commit, 'version': version, 'stage': stage.name,
                      'manifestSha256': sha(files['manifest.json'][0]), 'files': len(files), 'roleSkills': skills,
                      'zip': None if not archive else {'name': archive.name, 'size': archive.stat().st_size, 'sha256': sha(archive.read_bytes())},
                      'windowsRuntimeTested': False, 'published': False, 'installed': False}
            (output / 'receipt.json').write_bytes(json_bytes(result))
            print(json_bytes(result).decode(), end='')
        except Exception:
            # This run was created exclusively above (never remove another run).
            shutil.rmtree(output)
            raise
        return 0
    except (ValueError, OSError, EOFError, KeyError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        detail = error.stderr.decode('utf-8', 'replace').strip() if isinstance(error, subprocess.CalledProcessError) and error.stderr else str(error)
        print(f'Windows build rejected: {detail}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
