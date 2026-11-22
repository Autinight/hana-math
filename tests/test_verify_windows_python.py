"""Synthetic offline tests; these PE-shaped bytes are not executable CPython."""

import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/verify-windows-python.py'
EVIDENCE = ROOT / 'dist/validation/windows-x64-001/preflight'
NAME = 'cpython-3.12.14+20000101-x86_64-pc-windows-msvc-shared-install_only.tar.gz'
SPEC = importlib.util.spec_from_file_location('verify_windows_python', SCRIPT)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)


# Independent known-good VS_FIXEDFILEINFO values from the official asset.
def pe(*, dll=False, machine=0x8664, magic=0x20B, file_version=(3, 12, 14150, 1013), product_version=(3, 12, 14150, 1013)):
    image = bytearray(0x600)
    put = lambda fmt, at, *values: struct.pack_into('<' + fmt, image, at, *values)
    image[:2], image[0x80:0x84] = b'MZ', b'PE\0\0'
    put('I', 0x3C, 0x80)
    put('HHIIIHH', 0x84, machine, 1, 0, 0, 0, 0xF0, 0x0002 | (0x2000 if dll else 0))
    opt = 0x98
    put('H', opt, magic)
    put('I', opt + 108, 16)
    put('II', opt + 128, 0x1000, 0x400)
    image[opt + 0xF0:opt + 0xF8] = b'.rsrc\0\0\0'
    put('4I', opt + 0xF0 + 8, 0x400, 0x1000, 0x400, 0x200)
    for offset, ident, child in ((0, 16, 0x80000018), (24, 1, 0x80000030), (48, 1033, 72)):
        put('HHII', 0x200 + offset + 12, 0, 1, ident, child)
    put('4I', 0x248, 0x1080, 92, 0, 0)
    put('3H', 0x280, 92, 52, 0)
    image[0x286:0x2A6] = 'VS_VERSION_INFO\0'.encode('utf-16-le')
    file_ms, file_ls = (file_version[i] << 16 | file_version[i + 1] for i in (0, 2))
    prod_ms, prod_ls = (product_version[i] << 16 | product_version[i + 1] for i in (0, 2))
    put('13I', 0x2A8, 0xFEEF04BD, 0x10000, file_ms, file_ls,
        prod_ms, prod_ls, 0, 0, 0x40004, 2 if dll else 1, 0, 0, 0)
    return bytes(image)


PATCH = b'''#define PY_MAJOR_VERSION 3
#define PY_MINOR_VERSION 12
#define PY_MICRO_VERSION 14
#define PY_RELEASE_LEVEL PY_RELEASE_LEVEL_FINAL
#define PY_RELEASE_SERIAL 0
#define PY_VERSION "3.12.14"
'''


def fixture(exe=None, dll=None, header=PATCH, license=b'PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2\nsynthetic\n'):
    return {verify.EXE: pe() if exe is None else exe, verify.DLL: pe(dll=True) if dll is None else dll,
            verify.HEADERS[0]: header, verify.LICENSES[0]: license,
            **dict.fromkeys(verify.STDLIB, b'# synthetic Python fixture\n')}


def tar_bytes(members, extra=(), style=tarfile.PAX_FORMAT):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:', format=style) as tar:
        for name, data in members.items():
            item = tarfile.TarInfo(name)
            item.size = len(data)
            tar.addfile(item, io.BytesIO(data))
        for item, data in extra:
            item.size = len(data)
            tar.addfile(item, io.BytesIO(data))
    return stream.getvalue()


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Preflight(unittest.TestCase):
    def setUp(self):
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        tmp = tempfile.TemporaryDirectory(dir=EVIDENCE)
        self.addCleanup(tmp.cleanup)
        self.asset = Path(tmp.name) / NAME

    def archive(self, members=None, extra=(), *, raw=None, style=tarfile.PAX_FORMAT):
        payload = tar_bytes(fixture() if members is None else members, extra, style) if raw is None else raw
        compressed = gzip.compress(payload, mtime=0)
        self.asset.write_bytes(compressed)
        return sha(compressed)

    def refused(self, message, members=None, extra=(), **kwargs):
        pin = self.archive(members, extra, **kwargs)
        with self.assertRaisesRegex(verify.Invalid, message):
            verify.verify(self.asset, pin)

    def test_cli_success_keeps_archive_and_member_digests_separate(self):
        pin = self.archive()
        before = set(self.asset.parent.iterdir())
        r = subprocess.run([sys.executable, '-I', '-S', '-B', str(SCRIPT), str(self.asset), '--archive-sha256', pin],
                           capture_output=True, text=True, check=True)
        data = json.loads(r.stdout)
        self.assertEqual(data['source']['archiveSha256'], pin)
        self.assertEqual(data['inspected']['evidenceFiles'][verify.DLL]['sha256'], sha(pe(dll=True)))
        self.assertEqual(data['inspected']['pythonVersion'], '3.12.14')
        self.assertEqual(data['inspected']['peFileAndProductVersions'], {verify.EXE: '3.12.14150.1013', verify.DLL: '3.12.14150.1013'})
        self.assertNotEqual(data['inspected']['canonicalFileInventorySha256'], pin)
        self.assertEqual(data['scope'], 'static-input-preflight-only')
        self.assertFalse(data['hostRuntimeVerified'])
        self.assertEqual(set(self.asset.parent.iterdir()), before)  # no extraction

    def test_official_pin_uses_both_asset_name_and_digest(self):
        pin = self.archive()
        known = self.asset.with_name(next(iter(verify.PINS)))
        self.asset.rename(known)
        with self.assertRaisesRegex(verify.Invalid, 'cannot override'):
            verify.verify(known, pin)
        with self.assertRaisesRegex(verify.Invalid, 'SHA-256 mismatch'):
            verify.verify(known)

    def test_pin_required_and_wrong_digest_fails_before_parsing(self):
        self.asset.write_bytes(b'not even a gzip')
        with self.assertRaisesRegex(verify.Invalid, 'no known pin'):
            verify.verify(self.asset)
        with self.assertRaisesRegex(verify.Invalid, 'SHA-256 mismatch'):
            verify.verify(self.asset, '0' * 64)
        p = subprocess.run([sys.executable, '-I', '-S', '-B', str(SCRIPT), str(self.asset), '--archive-sha256', '0' * 64],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(p.stdout, '')
        self.assertIn('SHA-256 mismatch', p.stderr)

    def test_windows_target_filename(self):
        for target in ('aarch64-pc-windows-msvc', 'i686-pc-windows-msvc', 'aarch64-apple-darwin'):
            with self.subTest(target=target), self.assertRaisesRegex(verify.Invalid, 'asset name'):
                verify.verify(self.asset.with_name(NAME.replace(verify.TARGET, target)), '0' * 64)

    def test_wrong_pe_architecture_or_format_for_either_binary(self):
        for data in (b'\xcf\xfa\xed\xfe' + bytes(512), pe(machine=0x14C, magic=0x10B), pe(machine=0xAA64)):
            with self.subTest(format=data[:2]):
                self.refused('expected .*PE', fixture(exe=data))
        self.refused('PE32\\+ AMD64', fixture(dll=pe(dll=True, machine=0xAA64)))
        self.refused('image kind', fixture(dll=pe()))
        self.refused('truncated PE', fixture(exe=b'MZ'))

    def test_wrong_pe_file_and_product_versions_despite_correct_header(self):
        for wrong in ((3, 12, 14, 0), (3, 12, 13150, 1013), (3, 12, 14149, 1013), (3, 12, 14151, 1013),
                      (3, 12, 14150, 1012), (3, 12, 14150, 1014)):
            with self.subTest(fixed_version=wrong):
                self.refused('python/python.exe: incorrect PE file version', fixture(exe=pe(file_version=wrong)))
                self.refused('python/python312.dll: incorrect PE product version', fixture(dll=pe(dll=True, product_version=wrong)))
        fake = bytearray(pe())
        struct.pack_into('<I', fake, 0x98 + 128, 0)
        self.refused('unmapped or ambiguous PE resource', fixture(exe=bytes(fake)))

    def test_wrong_or_ambiguous_header_despite_correct_binaries(self):
        for header in (PATCH.replace(b'"3.12.14"', b'"3.12.14rc1"'), PATCH + b'#define PY_VERSION "3.12.14"\n',
                       PATCH.replace(b'PY_MICRO_VERSION 14', b'PY_MICRO_VERSION 13')):
            with self.subTest(header=header):
                self.refused('patchlevel.h:', fixture(header=header))

    def test_missing_or_empty_required_members_and_bad_license(self):
        for name in (verify.DLL, verify.EXE, verify.STDLIB[1], verify.HEADERS[0], verify.LICENSES[0]):
            with self.subTest(name=name):
                members = fixture()
                del members[name]
                self.refused('missing', members)
        self.refused('missing or empty', {**fixture(), verify.STDLIB[0]: b''})
        self.refused('missing PSF license text', fixture(license=b'claim only'))

    def test_unsafe_paths_and_windows_conflicts(self):
        for name in ('/python/x', 'python/../x', 'python/Lib/./x', 'python/Lib//x', 'other/x',
                     'python/Lib/bad\\x', 'python/Lib/C:x', 'python/Lib/os.py:payload', 'python/Lib/a. ',
                     'python/Lib/NUL.txt', 'python/Lib/COM¹.py', 'python/Lib/CON .x'):
            with self.subTest(name=name):
                # USTAR keeps the actual name instead of a GNU/PAX placeholder.
                self.refused('path', {**fixture(), name: b'x'}, style=tarfile.PAX_FORMAT if '¹' in name else tarfile.USTAR_FORMAT)
        self.refused('case/name collision', {**fixture(), 'python/lib/other.py': b'x'})
        self.refused('case/name collision', {**fixture(), 'python/Lib/OS.py': b'x'})
        self.refused('file/directory conflict', {**fixture(), 'python/Lib/os.py/sub.py': b'x'})
        self.refused('duplicate tar member', extra=((tarfile.TarInfo(verify.DLL), pe(dll=True)),))

    def test_links_special_members_and_pax_override(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.GNUTYPE_SPARSE):
            with self.subTest(kind=kind):
                item = tarfile.TarInfo('python/Lib/evil')
                item.type, item.linkname = kind, '/other'
                self.refused('unsupported tar member type', extra=((item, b''),))
        item = tarfile.TarInfo('python/Lib/safe.py')
        item.pax_headers = {'path': 'python/../../outside'}
        self.refused('unsafe Windows path', extra=((item, b'x'),))
        item.pax_headers = {'linkpath': '/outside'}
        self.refused('unsupported PAX attribute', extra=((item, b'x'),))

    def test_invalid_utf8_pax_is_declined_without_a_traceback(self):
        item = tarfile.TarInfo('python/Lib/pax')
        item.type = tarfile.XHDTYPE
        pin = self.archive(extra=((item, b'10 path=\xff\n'), (tarfile.TarInfo('python/Lib/next'), b'x')))
        p = subprocess.run([sys.executable, '-I', '-S', '-B', str(SCRIPT), str(self.asset), '--archive-sha256', pin],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(p.stdout, '')
        self.assertIn('Windows Python input rejected:', p.stderr)
        self.assertIn('utf-8', p.stderr)
        self.assertNotIn('Traceback', p.stderr)

    def test_valid_bounded_long_paths_and_directory_records(self):
        for style in (tarfile.PAX_FORMAT, tarfile.GNU_FORMAT):
            item = tarfile.TarInfo('python/Lib'); item.type = tarfile.DIRTYPE
            pin = self.archive({**fixture(), 'python/Lib/' + 'a' * 180 + '.py': b'x'}, extra=((item, b''),), style=style)
            self.assertEqual(verify.verify(self.asset, pin)['inspected']['fileCount'], 10)

    def test_size_limits_and_truncated_or_hidden_tar_data(self):
        pin = self.archive()
        for field, bound, expected in (('MAX_ARCHIVE', 8, 'bounded regular file'), ('MAX_EXPANDED', 700, 'expanded byte limit'),
                                       ('MAX_MEMBER', 1024, 'member byte limit'), ('MAX_HEADERS', 1, 'header limit'),
                                       ('MAX_NAMES', 1, 'path count limit')):
            with self.subTest(field=field), patch.object(verify, field, bound), self.assertRaisesRegex(verify.Invalid, expected):
                verify.verify(self.asset, pin)
        self.refused('truncated tar', raw=tar_bytes(fixture())[:550])
        self.refused('nonzero content after', raw=tar_bytes(fixture()) + b'\x01')
        self.asset.write_bytes(self.asset.read_bytes()[:-5])
        with self.assertRaises(EOFError):
            verify.verify(self.asset, sha(self.asset.read_bytes()))

    def test_many_members_and_high_expansion_remain_bounded(self):
        members = {**fixture(), **{f'python/Lib/many/file{i:04}.py': b'x' * 4096 for i in range(2048)}}
        tar = tar_bytes(members)
        pin = self.archive(raw=tar)
        with patch.object(verify, 'MAX_EXPANDED', len(tar)), patch.object(verify, 'MAX_HEADERS', len(members)):
            self.assertEqual(verify.verify(self.asset, pin)['inspected']['fileCount'], len(members))
        with patch.object(verify, 'MAX_EXPANDED', len(tar) - 1), self.assertRaisesRegex(verify.Invalid, 'expanded byte limit'):
            verify.verify(self.asset, pin)
        with patch.object(verify, 'MAX_HEADERS', len(members) - 1), self.assertRaisesRegex(verify.Invalid, 'header limit'):
            verify.verify(self.asset, pin)

    def test_keep_synthetic_positive_and_negative_evidence_on_request(self):
        if '--keep-fixtures' not in sys.orig_argv:
            return
        for label, content in [('positive', fixture()), ('negative-mach-o', fixture(exe=b'\xcf\xfa\xed\xfe' + bytes(512))),
                               ('negative-wrong-version', fixture(dll=pe(dll=True, product_version=(3, 12, 14150, 1012)))),
                               ('negative-traversal', {**fixture(), 'python/../outside': b'x'})]:
            with self.subTest(label=label):
                folder = EVIDENCE / label
                folder.mkdir(exist_ok=True)
                def retain(path, data):
                    if path.exists():
                        self.assertEqual(path.read_bytes(), data)
                    else:
                        with path.open('xb') as stream:
                            stream.write(data)

                archive = folder / NAME
                packed = gzip.compress(tar_bytes(content), mtime=0)
                retain(archive, packed)
                pin = sha(packed)
                result = subprocess.run([sys.executable, '-I', '-S', '-B', str(SCRIPT), str(archive), '--archive-sha256', pin],
                                        capture_output=True, text=True)
                receipt = {'synthetic': True, 'archiveSha256': pin, 'exit': result.returncode,
                           'stdout': json.loads(result.stdout) if result.stdout else None, 'stderr': result.stderr}
                retain(folder / 'receipt.json', (json.dumps(receipt, indent=2) + '\n').encode('utf-8'))
                self.assertEqual(result.returncode, int(label != 'positive'))


if __name__ == '__main__':
    if '--keep-fixtures' in sys.argv:
        sys.argv.remove('--keep-fixtures')
    unittest.main()
