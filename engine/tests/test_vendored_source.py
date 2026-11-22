"""Offline provenance/import-boundary tests; fixtures are software data only."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ENGINE = Path(__file__).resolve().parents[1]
HEAD = "839c471d0560b9b5308afc6cbb59a138819fe16c"
CORE_FILES = (
    "__init__.py", "_util.py", "bm25.py", "factgraph.py", "global_memory.py",
    "glossary.py", "local_memory.py", "schema.py", "glossary_global.json",
    "README.md", "DATA_MODEL.md", "INTERFACES.md",
)
EXPECTED = {
    "src/danus/__init__.py": "danus/__init__.py",
    **{f"src/danus/core/{name}": f"danus/core/{name}" for name in CORE_FILES},
    "src/danus/gateway/roles.py": "danus/gateway/roles.py",
    "tests/upstream/__init__.py": "danus/core/tests/__init__.py",
    "tests/upstream/test_core.py": "danus/core/tests/test_core.py",
    "LICENSE": "LICENSE",
}


class VendoredSourceTests(unittest.TestCase):
    def test_fixed_manifest_and_byte_hashes(self):
        manifest = json.loads((ENGINE / "UPSTREAM.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["gitHead"], HEAD)
        self.assertEqual(manifest["license"], "Apache-2.0")
        self.assertEqual(manifest["url"], "https://github.com/frenzymath/Danus")
        self.assertEqual(manifest["author"], "Bin Wu")
        self.assertIsNone(manifest["notice"])
        entries = manifest["files"]
        self.assertEqual(len(entries), len(EXPECTED))
        self.assertEqual({entry["target"]: entry["source"] for entry in entries}, EXPECTED)
        for entry in entries:
            with self.subTest(path=entry["target"]):
                self.assertEqual(entry["gitHead"], HEAD)
                self.assertIs(entry["localModified"], False)
                path = ENGINE / entry["target"]
                self.assertFalse(path.is_symlink())
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), entry["sha256"])
        core = ENGINE / "src/danus/core"
        self.assertEqual({p.name for p in core.iterdir() if p.name != "__pycache__"}, set(CORE_FILES))
        self.assertEqual({p.name for p in (ENGINE / "src/danus/gateway").iterdir() if p.name != "__pycache__"}, {"__init__.py", "roles.py"})
        self.assertEqual({p.name for p in (ENGINE / "src/danus").iterdir() if p.name != "__pycache__"}, {"__init__.py", "core", "gateway"})

    def test_package_contract(self):
        # Text checks keep this unittest runnable on Python 3.10 without tomllib.
        config = (ENGINE / "pyproject.toml").read_text(encoding="utf-8")
        for required in (
            'name = "hana-math-engine"', 'requires-python = ">=3.10"',
            'dependencies = []', 'build-backend = "setuptools.build_meta"',
            '[project.optional-dependencies]', 'dev = ["pytest>=7"]',
            'where = ["src"]', '"danus.*"', '"hana_math_engine.*"',
            '"danus.core" = ["glossary_global.json"',
            'pythonpath = ["src"]', 'testpaths = ["tests"]',
        ):
            self.assertIn(required, config)
        self.assertNotIn("../danus", config)
        initializer = (ENGINE / "src/danus/gateway/__init__.py").read_text(encoding="utf-8")
        import ast
        body = ast.parse(initializer).body
        self.assertEqual(len(body), 1)
        self.assertIsInstance(body[0], ast.Expr)
        self.assertIsInstance(body[0].value, ast.Constant)
        self.assertIsInstance(body[0].value.value, str)

    def test_relocated_imports_and_resources_without_external_runtime(self):
        # Only our relocated src tree is put on sys.path. -I -S removes ambient
        # PYTHONPATH/site-packages; unrelated source checkout is never needed.
        with tempfile.TemporaryDirectory(prefix="hana-core-import-") as temp:
            directory = Path(temp)
            shutil.copytree(ENGINE / "src", directory / "src",
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            program = r'''
import hashlib, importlib.abc, importlib.resources, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root / "src"))
blocked = {"codex", "fastapi", "mcp", "uvicorn", "httpx", "requests", "anthropic", "openai"}
class NoExternalRuntime(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in blocked or fullname in {"danus.codex", "danus.gateway.server", "danus.execution", "danus.verify"}:
            raise AssertionError("unexpected runtime import: " + fullname)
sys.meta_path.insert(0, NoExternalRuntime())
def deny_external_activity(event, args):
    if event.startswith("socket.") or event in {"subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn"}:
        raise AssertionError("unexpected external activity: " + event)
sys.addaudithook(deny_external_activity)
import danus
import danus.core
from danus.core import glossary
from danus.gateway import roles
import hana_math_engine
import hana_math_engine.service
assert hana_math_engine.CoreService is hana_math_engine.service.CoreService
assert pathlib.Path(hana_math_engine.__file__).is_relative_to(root)
assert pathlib.Path(hana_math_engine.service.__file__).is_relative_to(root)
assert pathlib.Path(danus.__file__).is_relative_to(root)
assert pathlib.Path(danus.core.__file__).is_relative_to(root)
resource = importlib.resources.files("danus.core").joinpath("glossary_global.json")
raw = resource.read_bytes()
assert hashlib.sha256(raw).hexdigest() == sys.argv[2]
assert glossary.global_glossary() == glossary.flatten(json.loads(raw))
assert roles.tools_for("unknown") == roles.tools_for("verifier")
assert "fact_submit" not in roles.tools_for("main")
assert "fact_submit" in roles.tools_for("worker")
assert not blocked.intersection(name.split(".")[0] for name in sys.modules)
print("isolated core/service imports, packaged resource and role table: OK")
'''
            expected_hash = hashlib.sha256((ENGINE / "src/danus/core/glossary_global.json").read_bytes()).hexdigest()
            result = subprocess.run(
                [sys.executable, "-I", "-S", "-B", "-c", program, str(directory), expected_hash],
                cwd=directory, capture_output=True, text=True, timeout=15, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("isolated core/service imports, packaged resource and role table: OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
