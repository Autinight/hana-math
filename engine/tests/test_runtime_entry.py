"""Real Python software tests, NOT evidence of Hana managed scoped execution.

Only fixed opaque fixture strings; no mathematical computation or network.
"""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

REPO = Path(__file__).resolve().parents[2]
ENTRY = REPO / "packages/hana-math/runtime/core_entry.py"


class RuntimeEntryTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="math-entry-software-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.package = self.base / "relocated-install"
        (self.package / "runtime").mkdir(parents=True)
        shutil.copyfile(ENTRY, self.package / "runtime/core_entry.py")
        for name in ("danus", "hana_math_engine"):
            shutil.copytree(REPO / "engine/src" / name, self.package / "engine/src" / name,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        self.request_id = str(uuid.uuid4())
        self.directory = self.base / "data/core-checks" / self.request_id
        self.directory.mkdir(parents=True)
        self.request = self.directory / "request.json"
        self.result = self.directory / "result.json"
        self.document = {"schemaVersion": 1, "requestId": self.request_id, "operation": "core-diagnostic"}
        self.request.write_text(json.dumps(self.document), encoding="utf-8")

    def invoke(self, *, request=None, result=None, flags=None, extra=()) -> subprocess.CompletedProcess:
        self.assertEqual(sys.version_info[:2], (3, 12), "entry integration test requires the explicit Python 3.12 test interpreter")
        return subprocess.run(
            [sys.executable, *(flags if flags is not None else ["-I", "-S", "-B"]),
             str(self.package / "runtime/core_entry.py"), "--request", str(request or self.request),
             "--result", str(result or self.result), *extra],
            cwd=self.directory, capture_output=True, text=True, timeout=15,
        )

    def assert_failed(self, completed) -> None:
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("CORE_DIAGNOSTIC_FAILED", completed.stderr)
        self.assertFalse(self.result.exists())
        self.assertFalse((self.directory / "project/fact_graph").exists())

    def test_relocated_package_diagnostic_is_offline_and_cannot_write_a_fact(self) -> None:
        completed = self.invoke()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, "")
        output = json.loads(self.result.read_text(encoding="utf-8"))
        self.assertEqual(output, {
            **self.document, "ok": True,
            "pythonVersion": ".".join(str(part) for part in sys.version_info[:3]),
            "checks": {"imports": True, "glossary": True, "globalMemory": True,
                       "verifierRequired": True, "noFacts": True},
        })
        entries = [json.loads(line) for line in (self.directory / "project/global_memory/plan.jsonl").read_text().splitlines()]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["claim"], "opaque diagnostic marker")
        self.assertEqual(entries[0]["author"], "core-diagnostic")
        self.assertFalse((self.directory / "project/fact_graph").exists())
        self.assertFalse((self.directory / "project/global_memory/verification.jsonl").exists())
        self.assertEqual(list(self.package.rglob("__pycache__")), [])
        self.assertEqual({item.name for item in self.directory.iterdir()}, {"request.json", "result.json", "project"})

    def test_request_id_schema_operation_and_extra_parameters_are_rejected(self) -> None:
        for patch in ({"requestId": str(uuid.uuid4())}, {"schemaVersion": 2}, {"schemaVersion": True},
                      {"operation": "fact_submit"}, {"project": str(self.base / "outside")}, {"code": "not executable"}):
            with self.subTest(patch=patch):
                self.request.write_text(json.dumps({**self.document, **patch}), encoding="utf-8")
                self.assert_failed(self.invoke())
                self.assertFalse((self.directory / "project").exists())

    def test_request_size_type_and_invalid_json_are_rejected(self) -> None:
        for text in ('not json', '[]', 'x' * 16385):
            with self.subTest(text=text[:20]):
                self.request.write_text(text, encoding="utf-8")
                self.assert_failed(self.invoke())

    def test_input_and_output_cannot_escape_fixed_directory_or_names(self) -> None:
        outside = self.base / "outside.json"
        for request, result in ((self.request, outside), (outside, self.result),
                                (self.request, self.directory / "different.json"),
                                (self.directory / ".." / self.request_id / "request.json", self.result)):
            with self.subTest(request=request, result=result):
                self.assert_failed(self.invoke(request=request, result=result))
        self.assertFalse(outside.exists())
        self.assertFalse((self.directory / "project").exists())

    def test_request_symlink_and_hardlink_are_rejected(self) -> None:
        original = self.base / "external-request.json"
        original.write_text(json.dumps(self.document), encoding="utf-8")
        for link in ("symlink", "hardlink"):
            with self.subTest(link=link):
                self.request.unlink()
                if link == "symlink":
                    self.request.symlink_to(original)
                else:
                    self.request.hardlink_to(original)
                self.assert_failed(self.invoke())
        self.assertFalse((self.directory / "project").exists())

    def test_existing_or_symlink_result_is_never_overwritten(self) -> None:
        external = self.base / "external-result.json"
        external.write_text("untouched fixture", encoding="utf-8")
        self.result.symlink_to(external)
        completed = self.invoke()
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(external.read_text(), "untouched fixture")
        self.result.unlink()
        self.result.write_text("keep existing result", encoding="utf-8")
        completed = self.invoke()
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(self.result.read_text(), "keep existing result")
        self.assertFalse((self.directory / "project").exists())

    def test_existing_project_and_project_symlink_are_not_reused(self) -> None:
        outside = self.base / "outside-project"
        outside.mkdir()
        project = self.directory / "project"
        project.symlink_to(outside, target_is_directory=True)
        self.assert_failed(self.invoke())
        self.assertEqual(list(outside.iterdir()), [])
        project.unlink()
        project.mkdir()
        self.assert_failed(self.invoke())
        self.assertEqual(list(project.iterdir()), [])

    def test_missing_bundled_core_does_not_fall_back_to_development_checkout(self) -> None:
        (self.package / "engine/src/hana_math_engine/service.py").unlink()
        self.assert_failed(self.invoke())
        self.assertFalse((self.directory / "project").exists())

    def test_empty_glossary_or_symlink_source_fails_before_project_creation(self) -> None:
        glossary = self.package / "engine/src/danus/core/glossary_global.json"
        glossary.write_text("{}", encoding="utf-8")
        self.assert_failed(self.invoke())
        glossary.unlink()
        external = self.base / "external-glossary.json"
        external.write_text('{"fixture": "opaque"}', encoding="utf-8")
        glossary.symlink_to(external)
        self.assert_failed(self.invoke())
        self.assertFalse((self.directory / "project").exists())

    def test_isolation_flags_are_required_and_arbitrary_cli_arguments_are_refused(self) -> None:
        self.assert_failed(self.invoke(flags=["-I", "-B"]))
        completed = self.invoke(extra=["--code", "opaque"])
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(self.result.exists())
        self.assertFalse((self.directory / "project").exists())

    def test_repeating_a_request_does_not_overwrite_or_reexecute_it(self) -> None:
        first = self.invoke()
        self.assertEqual(first.returncode, 0, first.stderr)
        result_before = self.result.read_bytes()
        memory = self.directory / "project/global_memory/plan.jsonl"
        memory_before = memory.read_bytes()
        second = self.invoke()
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual(self.result.read_bytes(), result_before)
        self.assertEqual(memory.read_bytes(), memory_before)


if __name__ == "__main__":
    unittest.main()
