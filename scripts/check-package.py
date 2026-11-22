"""Check a release archive against source and its build inventory; no extraction."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

repo = Path(__file__).resolve().parent.parent
archive = Path(sys.argv[1]).resolve()
expected_version = json.loads((repo / 'packages/hana-math/manifest.json').read_text())['version']
with zipfile.ZipFile(archive) as package:
    members = package.namelist()
    assert len(members) == len(set(members)), 'duplicate ZIP members'
    assert all(not name.startswith('/') and '..' not in Path(name).parts for name in members), 'unsafe ZIP path'
    inventory = json.loads(package.read('build-inventory.json'))
    checked_inventory = 0
    for entry in inventory['files']:
        content = package.read(entry['path'])
        assert len(content) == entry['size'], f"size drift: {entry['path']}"
        assert hashlib.sha256(content).hexdigest() == entry['sha256'], f"inventory drift: {entry['path']}"
        checked_inventory += 1
    compared = []
    for root, prefix in [(repo / 'packages/hana-math', ''), (repo / 'engine/src', 'engine/src/')]:
        for source in sorted(root.rglob('*')):
            if not source.is_file() or '__pycache__' in source.parts or source.suffix in ('.pyc', '.pyo'):
                continue
            relative = prefix + source.relative_to(root).as_posix()
            assert package.read(relative) == source.read_bytes(), f'source mismatch: {relative}'
            compared.append(relative)
    for name in ('LICENSE', 'UPSTREAM.json', 'RESEARCH_UPSTREAM.json'):
        assert package.read('engine/' + name) == (repo / 'engine' / name).read_bytes(), name
    manifest = json.loads(package.read('manifest.json'))
    assert manifest['version'] == expected_version, manifest['version']
    result = {'archive': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
              'files': sum(not name.endswith('/') for name in members), 'version': manifest['version'],
              'inventoryFilesVerified': checked_inventory, 'sourceFilesVerified': len(compared),
              'sourcePaths': compared, 'mismatches': 0}
print(json.dumps(result, ensure_ascii=False, indent=2))
