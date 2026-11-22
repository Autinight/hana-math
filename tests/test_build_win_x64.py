"""Targeted tests for the offline Windows staging/ZIP tool (no target execution)."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('build_win_x64', ROOT / 'scripts/build-win-x64.py')
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)
PACK = ROOT / build.PACK_ROOT


class Packaging(unittest.TestCase):
    def test_runtime_selection_refuses_optional_and_microsoft_payload(self):
        for path in build.REQUIRED_PY | {'tcl/tk8.6/license.terms'}:
            self.assertTrue(build.python_allowed(path), path)
        for path in ('pythonw.exe', 'python.pdb', 'vcruntime140.dll', 'vcruntime140_1.dll', 'DLLs/MSVCP140.dll',
                     'DLLs/_testcapi.pyd', 'Lib/site-packages/pip/_vendor/distlib/t32.exe', 'Lib/site-packages/pip/a.py',
                     'Lib/ensurepip/_bundled/pip.whl', 'Lib/test/test_os.py', 'libs/python312.lib', 'Lib/.env.local',
                     'Lib/__pycache__/x.pyc', 'tcl/tcl86t.lib'):
            self.assertFalse(build.python_allowed(path), path)

    def test_binary_and_private_guards_are_independent(self):
        for magic in build.MACHO:
            with self.assertRaisesRegex(ValueError, 'Mach-O'):
                build.check_payload('asset.bin', magic)
        with self.assertRaisesRegex(ValueError, 'private path'):
            build.check_payload('ui/assets/.env', b'not data')
        with self.assertRaisesRegex(ValueError, 'Microsoft runtime'):
            build.check_payload('DLLs/VCRUNTIME140_1.DLL', b'MZ')
        raw = bytearray(100)
        raw[:2] = b'MZ'
        struct.pack_into('<I', raw, 60, 64)
        raw[64:70] = b'PE\0\0\x64\x86'
        raw[88:90] = b'\x0b\x02'
        build.check_payload('python.exe', bytes(raw))
        with self.assertRaisesRegex(ValueError, 'unreviewed PE'):
            build.check_payload('ui/file.dat', bytes(raw), source=True)
        raw[68:70] = b'\x64\xaa'
        with self.assertRaisesRegex(ValueError, 'AMD64'):
            build.check_payload('python.exe', bytes(raw))

    def test_archive_pin_is_checked_before_notices_are_read(self):
        with tempfile.TemporaryDirectory(dir=PACK) as here:
            full = Path(here) / build.FULL
            full.write_bytes(b'unverified input')
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                build.load_licenses(full, {})
            bad = Path(here) / build.ASSET
            bad.symlink_to(full)
            with self.assertRaisesRegex(ValueError, 'symbolic link'):
                build.load_python(bad)

    def test_zip_exactness_reproducibility_and_tamper_detection(self):
        with tempfile.TemporaryDirectory(dir=PACK) as here:
            run = Path(here)
            files = {'manifest.json': (b'{"id":"hana-math"}\n', 0o644), 'dependencies/python/python.exe': (b'fixture', 0o755)}
            stage = run / 'hana-math'
            build.materialize(stage, files)
            a, b = run / 'a.zip', run / 'b.zip'
            build.zip_stage(stage, a, files)
            build.zip_stage(stage, b, files)
            self.assertEqual(hashlib.sha256(a.read_bytes()).digest(), hashlib.sha256(b.read_bytes()).digest())
            with zipfile.ZipFile(a) as z:
                self.assertEqual(z.namelist(), sorted(files))
                self.assertEqual(z.getinfo(build.EXE).external_attr >> 16, stat.S_IFREG | 0o755)
            extras = stage / 'extra'
            extras.write_bytes(b'opaque')
            with self.assertRaisesRegex(ValueError, 'member list drift'):
                build.zip_stage(stage, run / 'c.zip', files)
            extras.unlink()
            (stage / build.EXE).write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'stage drift'):
                build.zip_stage(stage, run / 'd.zip', files)

    def test_frozen_git_source_uses_blob_members_and_refuses_unpinned_sha(self):
        with self.assertRaisesRegex(ValueError, 'entire frozen'):
            build.frozen_source('HEAD')
        manifest = b'{\n "id": "hana-math"\n}\n'
        git_id = 'a' * 40
        tree = f'100644 blob {git_id}\tpackages/hana-math/manifest.json\0'.encode()
        blob = f'{git_id} blob {len(manifest)}\n'.encode() + manifest + b'\n'
        with patch.object(build, 'git', side_effect=[git_id.encode()+b'\n', b'', tree, blob]):
            files, entries = build.frozen_source(git_id)
        self.assertEqual(files, {'manifest.json': (manifest, 0o644)})
        self.assertEqual(entries, [{**build.row('manifest.json', manifest), 'sourcePath': 'packages/hana-math/manifest.json', 'gitBlob': git_id}])
        unsafe = f'120000 blob {git_id}\tpackages/hana-math/link\0'.encode()
        with patch.object(build, 'git', side_effect=[git_id.encode()+b'\n', b'', unsafe]):
            with self.assertRaisesRegex(ValueError, 'nonregular source'):
                build.frozen_source(git_id)

    @unittest.skipUnless(os.environ.get('HANA_WIN_STAGE_EVIDENCE'), 'set HANA_WIN_STAGE_EVIDENCE to check a real stage')
    def test_real_stage_cross_checks_all_inventories(self):
        stage = Path(os.environ['HANA_WIN_STAGE_EVIDENCE']).resolve()
        self.assertTrue(stage.is_relative_to(PACK))
        read = lambda key: json.loads((stage / key).read_bytes())
        runtime = read('dependencies/runtime.json')
        for key, value in {**build.PLATFORM, 'pythonVersion': '3.12.14', 'executable': build.EXE}.items():
            self.assertEqual(runtime[key], value)
        self.assertEqual(runtime['sourceInventorySha256'], build.sha((stage / build.SOURCE_INV).read_bytes()))
        self.assertEqual(runtime['pythonInventory']['sha256'], build.sha((stage / build.PYTHON_INV).read_bytes()))
        inv = read(build.BUILD_INV)
        staged = {p.relative_to(stage).as_posix() for p in stage.rglob('*') if p.is_file()}
        self.assertEqual(set(r['path'] for r in inv['files']) | {build.BUILD_INV}, staged)
        self.assertEqual(len(inv['files']) + 1, len(staged))
        for r in inv['files']:
            p = stage / r['path']
            self.assertEqual(r, build.row(r['path'], p.read_bytes(), stat.S_IMODE(p.stat().st_mode)))
            self.assertFalse(build.VC.fullmatch(p.name))
            self.assertNotIn('/site-packages/', '/' + r['path'])
        git_files, source = build.frozen_source(inv['sourceCommit'])
        self.assertEqual(read('source-package-inventory.json')['files'], source)
        for name, (data, _) in git_files.items():
            self.assertEqual((stage / name).read_bytes(), data)
        expected_python = set(r['path'] for r in read(build.PYTHON_INV)['files'])
        self.assertEqual(expected_python, {p for p in staged if p.startswith(build.PREFIX)})
        src = read(build.SOURCE_INV)
        self.assertEqual(src['archives'][build.FULL]['sha256'], build.FULL_SHA)
        self.assertEqual(expected_python, {entry['path'] for entry in src['files']})
        self.assertTrue(all((stage / build.PREFIX / 'licenses' / p).is_file() for p in build.REQUIRED_LICENSES))


if __name__ == '__main__':
    unittest.main()
