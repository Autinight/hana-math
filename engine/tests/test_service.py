"""CP1 software-contract tests: all statement/proof strings are opaque fixtures.

No mathematical computation, real verifier, network, MCP or sibling repository.
Uses unittest so the suite also runs without pytest (and pytest can collect it).
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest.mock import Mock, patch

from danus.core import FactGraph, GlobalMemory
from danus.gateway.roles import ALL_TOOLS, tools_for
from hana_math_engine import CoreService

STATEMENT = "opaque fixture record"
PROOF = "opaque fixture payload"
CORRECT = {"verdict": "correct", "verification_report": {
    "summary": "software fixture only", "critical_errors": [], "gaps": [],
}, "repair_hints": ""}
WRONG = {"verdict": "wrong", "verification_report": {
    "summary": "software fixture rejection", "critical_errors": [],
    "gaps": [{"location": "fixture", "issue": "stub rejection"}],
}, "repair_hints": "replace the opaque payload"}
ROLE_EXPECTATIONS = {
    "worker": ("gm_add", "gm_search", "fact_submit", "fact_search", "search_arxiv_theorems"),
    "main": ("gm_add", "gm_search", "fact_search", "fact_revoke", "search_arxiv_theorems"),
    "verifier": ("search_arxiv_theorems",),
    "all": tuple(ALL_TOOLS),
    "unknown-role": ("search_arxiv_theorems",),
    "": ("search_arxiv_theorems",),
}


def correct(statement: str, proof: str) -> dict:
    return copy.deepcopy(CORRECT)


def literature(query: str, *, num_results: int = 10) -> dict:
    return {"query": query, "count": 1, "results": [{"title": "opaque catalogue fixture"}],
            "requested": num_results}


class CoreServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="hana-math-service-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.project = self.root / "fixture-project"

    def service(self, role="worker", **kwargs) -> CoreService:
        options = {"author": "fixture-author", "role": role, "verifier": correct,
                   "literature_search": literature}
        options.update(kwargs)
        return CoreService(self.project, **options)

    def arguments(self, tool: str, root: Path) -> dict:
        if tool == "gm_add":
            return {"kind": "plan", "claim": "opaque plan fixture"}
        if tool in {"gm_search", "fact_search", "search_arxiv_theorems"}:
            return {"query": "opaque"}
        if tool == "fact_submit":
            return {"statement": STATEMENT, "proof": PROOF}
        if tool == "fact_revoke":
            seed = CoreService(root, author="seed", role="worker", verifier=correct)
            fid = seed.fact_submit(STATEMENT, PROOF)["fact_id"]
            return {"fact_id": fid, "reason": "opaque retirement fixture"}
        self.fail(f"no fixture for tool {tool}")

    def test_role_table_and_every_direct_and_dispatched_entry(self) -> None:
        for role, allowed in ROLE_EXPECTATIONS.items():
            self.assertEqual(tuple(tools_for(role)), allowed)
            for tool in ALL_TOOLS:
                for dispatched in (False, True):
                    with self.subTest(role=role, tool=tool, dispatched=dispatched):
                        root = self.root / f"role-{role or 'empty'}-{tool}-{dispatched}"
                        verifier = Mock(side_effect=correct)
                        search = Mock(side_effect=literature)
                        service = CoreService(root, author="bound", role=role,
                                              verifier=verifier, literature_search=search)
                        self.assertEqual(service.available_tools, allowed)
                        if tool not in allowed:
                            # Complete arguments, without seeding anything for denied calls.
                            args = {"fact_id": "0123456789abcdef", "reason": "fixture"} if tool == "fact_revoke" else self.arguments(tool, root)
                            with self.assertRaises(PermissionError):
                                service.call(tool, args) if dispatched else getattr(service, tool)(**args)
                            self.assertFalse(root.exists())
                            verifier.assert_not_called()
                            search.assert_not_called()
                        else:
                            args = self.arguments(tool, root)
                            result = service.call(tool, args) if dispatched else getattr(service, tool)(**args)
                            self.assertIsInstance(result, dict)
                            if tool == "fact_submit":
                                self.assertTrue(FactGraph(root).exists(result["fact_id"]))
                            elif tool == "fact_revoke":
                                self.assertEqual(result, {"revoked": [args["fact_id"]]})
                            elif tool == "gm_add":
                                self.assertEqual(GlobalMemory(root).read("plan")[0]["author"], "bound")
                            elif tool == "search_arxiv_theorems":
                                search.assert_called_once_with("opaque", num_results=10)

    def test_dispatch_rejects_non_tools_and_non_mapping_arguments(self) -> None:
        service = self.service("all")
        for name in ("__init__", "_require_tool", "available_tools", "add", "call", "not-a-tool"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                service.call(name, {})
        for args in (None, [], "fixture"):
            with self.subTest(args=args), self.assertRaises(TypeError):
                service.call("gm_search", args)
        self.assertFalse(self.project.exists())

    def test_tool_arguments_cannot_override_trusted_context(self) -> None:
        service = self.service("all")
        for tool in ALL_TOOLS:
            args = {"fact_id": "0123456789abcdef", "reason": "fixture"} if tool == "fact_revoke" else self.arguments(tool, self.project)
            for field in ("project", "project_dir", "role", "author", "problem_id", "verifier", "literature_search"):
                for dispatched in (False, True):
                    with self.subTest(tool=tool, field=field, dispatched=dispatched), self.assertRaises(TypeError):
                        supplied = {**args, field: "untrusted-override"}
                        service.call(tool, supplied) if dispatched else getattr(service, tool)(**supplied)
        self.assertFalse(self.project.exists())

    def test_bindings_are_frozen_and_available_tools_is_a_snapshot(self) -> None:
        service = self.service()
        self.assertEqual(service.project_dir, self.project.resolve())
        self.assertEqual(service.problem_id, "fixture-project")
        for field, value in (("project_dir", self.root / "other"), ("author", "other"),
                             ("role", "all"), ("problem_id", "other"), ("verifier", None)):
            with self.subTest(field=field), self.assertRaises(FrozenInstanceError):
                setattr(service, field, value)
        names = list(service.available_tools)
        names.append("fact_revoke")
        self.assertNotIn("fact_revoke", service.available_tools)
        self.assertFalse(self.project.exists())

    def test_environment_cannot_supply_binding_or_verifier(self) -> None:
        with patch.dict(os.environ, {
            "DANUS_ROLE": "all", "DANUS_AUTHOR": "environment-author",
            "DANUS_PROJECT_DIR": str(self.root / "outside"),
            "DANUS_AGENTS_ROOT": str(self.root / "outside"),
            "DANUS_PROBLEM_ID": "environment-problem",
            "DANUS_VERIFY_URL": "https://invalid.example/never-called",
        }):
            service = self.service(verifier=None)
            service.gm_add("plan", "bound project fixture")
            result = service.fact_submit(STATEMENT, PROOF)
            self.assertEqual(result["verdict"], "error")
            self.assertEqual(result["error"], "verifier is not configured")
            self.assertEqual(service.problem_id, "fixture-project")
            self.assertEqual(GlobalMemory(self.project).read("plan")[0]["author"], "fixture-author")
            self.assertFalse((self.root / "outside").exists())

    def test_independent_project_roots_do_not_cross_read_write_or_revoke(self) -> None:
        first = self.service("all", problem_id="shared-fixture-id")
        second_root = self.root / "second-project"
        second = CoreService(second_root, author="second-author", role="all",
                             problem_id="shared-fixture-id", verifier=correct)
        first.gm_add("plan", "firstonly fixture")
        second.gm_add("plan", "secondonly fixture")
        self.assertEqual(first.gm_search("secondonly", kinds=["plan"])["results_by_kind"]["plan"]["count"], 0)
        self.assertEqual(second.gm_search("firstonly", kinds=["plan"])["results_by_kind"]["plan"]["count"], 0)
        fid = first.fact_submit(STATEMENT, PROOF)["fact_id"]
        self.assertEqual(second.fact_search("opaque"), {"query": "opaque", "results": []})
        self.assertEqual(second.fact_submit(STATEMENT, PROOF)["fact_id"], fid)
        first.fact_revoke(fid, "first project only")
        self.assertFalse(FactGraph(self.project).exists(fid))
        self.assertTrue(FactGraph(second_root).exists(fid))
        self.assertEqual(GlobalMemory(second_root).read("verification")[0]["author"], "second-author")

    def test_missing_verifier_fails_closed_without_trace_or_fact(self) -> None:
        result = self.service(verifier=None).fact_submit(STATEMENT, PROOF)
        self.assertEqual(result, {"accepted": False, "verdict": "error",
                                 "error": "verifier is not configured", "undefined_symbols": []})
        self.assertFalse(self.project.exists())

    def test_verifier_exception_returns_error_without_trace_or_fact(self) -> None:
        verifier = Mock(side_effect=RuntimeError("opaque verifier failure"))
        result = self.service(verifier=verifier).fact_submit(STATEMENT, PROOF)
        self.assertEqual(result, {"accepted": False, "verdict": "error",
                                 "error": "opaque verifier failure", "undefined_symbols": []})
        verifier.assert_called_once_with(STATEMENT, PROOF)
        self.assertFalse(self.project.exists())

    def test_non_dict_verifier_results_are_errors_without_trace(self) -> None:
        for body in (None, [], "correct", True, 17):
            with self.subTest(body=body):
                result = self.service(verifier=Mock(return_value=body)).fact_submit(STATEMENT, PROOF)
                self.assertEqual(result, {"accepted": False, "verdict": "error",
                                         "error": f"verify service returned a non-dict body ({type(body).__name__})",
                                         "undefined_symbols": []})
                self.assertFalse(self.project.exists())

    def test_rejection_preserves_upstream_envelope_and_trace(self) -> None:
        verdict = copy.deepcopy(WRONG)
        service = self.service(verifier=Mock(return_value=verdict))
        result = service.fact_submit(STATEMENT, PROOF, source_id="finding-fixture", predecessors=["0123456789abcdef"])
        self.assertEqual(result, {"accepted": False, **WRONG, "undefined_symbols": []})
        self.assertEqual(verdict, WRONG)
        self.assertEqual(FactGraph(self.project).list(), [])
        records = GlobalMemory(self.project).read("verification")
        self.assertEqual(len(records), 1)
        trace = records[0]
        self.assertEqual(trace["claim"], STATEMENT)
        self.assertEqual(trace["evidence"], WRONG["repair_hints"])
        self.assertEqual(trace["verification_report"], WRONG["verification_report"])
        self.assertEqual(trace["verdict"], "wrong")
        self.assertEqual(trace["author"], "fixture-author")
        self.assertEqual(trace["links"], {"source_id": "finding-fixture", "predecessors": ["0123456789abcdef"]})
        self.assertFalse(trace["verifiable"])
        self.assertIsNone(trace["fact_id"])
        self.assertIsNone(trace["write_error"])

    def test_dict_missing_unknown_and_error_verdicts_preserve_upstream_trace_behavior(self) -> None:
        # Upstream emits a trace for ANY dict, even when no usable verdict exists.
        for body in ({}, {"verdict": "error", "error": "provider envelope"},
                     {"verdict": "unknown"}, {"verdict": "Correct"}, {"verdict": None}):
            with self.subTest(body=body):
                result = self.service(verifier=Mock(return_value=body)).fact_submit(STATEMENT, PROOF)
                self.assertEqual(result, {"accepted": False, "verdict": body.get("verdict"),
                                         "repair_hints": None, "verification_report": None,
                                         "undefined_symbols": []})
                trace = GlobalMemory(self.project).read("verification")[-1]
                self.assertEqual(trace["verdict"], body.get("verdict"))
                self.assertEqual(trace["evidence"], "verdict: wrong")
        self.assertEqual(len(GlobalMemory(self.project).read("verification")), 5)
        self.assertEqual(FactGraph(self.project).list(), [])

    def test_accepted_content_hash_attribution_and_trace(self) -> None:
        service = self.service(problem_id="locked-fixture")
        result = service.fact_submit(STATEMENT, PROOF, intuition="opaque rationale", source_id="source-fixture")
        canonical = {"problem_id": "locked-fixture", "predecessors": [], "glossary_introduces": {},
                     "statement": STATEMENT, "proof": PROOF}
        expected = hashlib.sha256(json.dumps(canonical, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]
        self.assertEqual(result, {"accepted": True, "fact_id": expected, "undefined_symbols": []})
        raw = FactGraph(self.project).get_raw(expected)
        self.assertIn("problem_id: locked-fixture\nauthor: fixture-author\n", raw)
        self.assertIn("## intuition\nopaque rationale", raw)
        trace = GlobalMemory(self.project).read("verification")[0]
        self.assertEqual(trace["evidence"], "verdict: correct")
        self.assertEqual(trace["verdict"], "correct")
        self.assertEqual(trace["fact_id"], expected)
        self.assertEqual(trace["verification_report"], CORRECT["verification_report"])
        self.assertEqual(trace["links"], {"source_id": "source-fixture", "predecessors": []})
        self.assertIsNone(trace["write_error"])

    def test_cp1_accepts_correct_without_strict_report_validation(self) -> None:
        for body in ({"verdict": "correct"}, {"verdict": "correct", "verification_report": {
            "critical_errors": ["inconsistent software fixture"], "gaps": ["inconsistent fixture"],
        }}):
            with self.subTest(body=body):
                result = self.service(verifier=Mock(return_value=body)).fact_submit(STATEMENT, PROOF)
                self.assertTrue(result["accepted"])
                self.assertTrue(FactGraph(self.project).exists(result["fact_id"]))
        self.assertEqual(len(GlobalMemory(self.project).read("verification")), 2)

    def test_dedup_still_verifies_and_records_each_submission(self) -> None:
        verifier = Mock(side_effect=correct)
        service = self.service(verifier=verifier)
        first = service.fact_submit(STATEMENT, PROOF)
        second = service.fact_submit("  opaque   fixture record\n", PROOF)
        self.assertEqual(first, second)
        self.assertEqual(FactGraph(self.project).list(), [first["fact_id"]])
        self.assertEqual(verifier.call_count, 2)
        self.assertEqual(len(GlobalMemory(self.project).read("verification")), 2)

    def test_external_refs_remain_mutable_metadata_outside_the_hash(self) -> None:
        service = self.service()
        refs = [{"z-extra": "kept", "title": "opaque reference", "key": "fixture", "authors": ["Fixture"],
                 "year": 2026, "cited_for": "opaque location"}, "ignored non-dict fixture"]
        original = copy.deepcopy(refs)
        first = service.fact_submit(STATEMENT, PROOF, external_refs=refs)
        stored = FactGraph(self.project).external_refs(first["fact_id"])
        self.assertEqual(stored, [refs[0]])
        self.assertEqual(list(stored[0]), ["key", "authors", "title", "year", "cited_for", "z-extra"])
        self.assertEqual(refs, original)
        second_refs = [{"key": "replacement", "title": "replacement fixture"}]
        second = service.fact_submit(STATEMENT, PROOF, external_refs=second_refs)
        self.assertEqual(first["fact_id"], second["fact_id"])
        self.assertEqual(FactGraph(self.project).external_refs(first["fact_id"]), second_refs)

    def test_cascade_revocation_and_revoked_predecessor_write_error_trace(self) -> None:
        worker = self.service()
        first = worker.fact_submit("parent opaque fixture", PROOF)["fact_id"]
        second = worker.fact_submit("child opaque fixture", PROOF, predecessors=[first])["fact_id"]
        third = worker.fact_submit("leaf opaque fixture", PROOF, predecessors=[second])["fact_id"]
        revoked = self.service("main").fact_revoke(first, "opaque retirement")
        self.assertEqual(revoked, {"revoked": [first, second, third]})
        self.assertEqual(FactGraph(self.project).list(), [])
        records = [json.loads(line) for line in (self.project / "fact_graph/revocation_log.jsonl").read_text().splitlines()]
        self.assertEqual([record["reason"] for record in records], ["opaque retirement"] * 3)
        self.assertEqual(records[1]["revoked_as_dependent_of"], first)
        result = worker.fact_submit("late opaque fixture", PROOF, predecessors=[first], source_id="late-source")
        self.assertEqual(result, {"accepted": True, "fact_id": None,
                                 "write_error": f"predecessor_revoked: {first}", "undefined_symbols": []})
        trace = GlobalMemory(self.project).read("verification")[-1]
        self.assertEqual(trace["verdict"], "correct")
        self.assertIsNone(trace["fact_id"])
        self.assertEqual(trace["write_error"], result["write_error"])
        self.assertEqual(trace["links"], {"source_id": "late-source", "predecessors": [first]})
        self.assertEqual(FactGraph(self.project).list(), [])

    def test_add_io_failure_keeps_accepted_true_and_records_trace(self) -> None:
        with patch("hana_math_engine.service.FactGraph.add", side_effect=OSError("opaque disk failure")):
            result = self.service().fact_submit(STATEMENT, PROOF)
        self.assertEqual(result, {"accepted": True, "fact_id": None,
                                 "write_error": "opaque disk failure", "undefined_symbols": []})
        trace = GlobalMemory(self.project).read("verification")[0]
        self.assertEqual(trace["write_error"], "opaque disk failure")
        self.assertEqual(trace["verdict"], "correct")
        self.assertEqual(FactGraph(self.project).list(), [])

    def test_trace_failure_propagates_after_accept_without_rollback(self) -> None:
        with patch("hana_math_engine.service.GlobalMemory.append", side_effect=OSError("opaque trace failure")):
            with self.assertRaisesRegex(OSError, "opaque trace failure"):
                self.service().fact_submit(STATEMENT, PROOF)
        self.assertEqual(len(FactGraph(self.project).list()), 1)
        self.assertEqual(GlobalMemory(self.project).read("verification"), [])

    def test_trace_failure_propagates_for_reject_and_accept_write_failure(self) -> None:
        for verdict, fail_add in ((WRONG, False), (CORRECT, True)):
            with self.subTest(verdict=verdict["verdict"]):
                with patch("hana_math_engine.service.GlobalMemory.append", side_effect=OSError("trace unavailable")), \
                     patch("hana_math_engine.service.FactGraph.add", side_effect=OSError("disk unavailable")) as add:
                    with self.assertRaisesRegex(OSError, "trace unavailable"):
                        self.service(verifier=Mock(return_value=verdict)).fact_submit(STATEMENT, PROOF)
                    self.assertEqual(add.call_count, int(fail_add))
        self.assertFalse(self.project.exists())

    def test_advisory_undefined_symbols_are_forwarded_to_error_and_reject(self) -> None:
        for verifier in (None, Mock(return_value=WRONG)):
            with self.subTest(verifier=verifier):
                with patch("hana_math_engine.service.FactGraph.undefined_symbols", return_value=["opaque marker"]):
                    result = self.service(verifier=verifier).fact_submit(STATEMENT, PROOF)
                self.assertEqual(result["undefined_symbols"], ["opaque marker"])
                self.assertFalse(result["accepted"])

    def test_advisory_heuristic_exception_is_logged_not_silently_swallowed(self) -> None:
        with patch("hana_math_engine.service.FactGraph.undefined_symbols", side_effect=RuntimeError("heuristic fixture failure")):
            with self.assertLogs("hana_math_engine.service", level="WARNING") as logs:
                result = self.service().fact_submit(STATEMENT, PROOF)
        self.assertTrue(result["accepted"])
        self.assertEqual(result["undefined_symbols"], [])
        self.assertIn("heuristic fixture failure", "\n".join(logs.output))

    def test_gm_search_limits_kinds_status_and_evidence_contract(self) -> None:
        service = self.service("main")
        first = service.gm_add("plan", "catalogue fixture first", links={"fixture": "link"}, glossary={"label": "opaque"})
        service.gm_add("plan", "catalogue fixture second")
        service.gm_add("obstacle", "catalogue obstruction")
        with self.assertRaises(ValueError):
            service.gm_add("conclusion", "opaque claim without evidence")
        finding = service.gm_add("conclusion", "catalogue candidate", evidence="opaque evidence")
        GlobalMemory(self.project).set_status(first["id"], "supported")
        result = service.gm_search("catalogue", kinds=["plan"], limit_per_kind=1)
        self.assertEqual(result["query"], "catalogue")
        self.assertEqual(set(result["results_by_kind"]), {"plan"})
        self.assertEqual(result["results_by_kind"]["plan"]["count"], 1)
        first_match = service.gm_search("first", kinds=["plan"])
        entry = first_match["results_by_kind"]["plan"]["results"][0]["entry"]
        self.assertEqual(entry["id"], first["id"])
        self.assertEqual(entry["status"], "supported")
        self.assertEqual(entry["links"], {"fixture": "link"})
        self.assertEqual(entry["glossary"], {"label": "opaque"})
        self.assertEqual(GlobalMemory(self.project).read("conclusion")[0]["id"], finding["id"])
        self.assertEqual(FactGraph(self.project).list(), [])

    def test_gm_write_and_revoke_errors_propagate(self) -> None:
        with patch("hana_math_engine.service.GlobalMemory.append", side_effect=OSError("gm unavailable")):
            with self.assertRaisesRegex(OSError, "gm unavailable"):
                self.service().gm_add("plan", "opaque fixture")
        with self.assertRaisesRegex(ValueError, "unknown fact_id"):
            self.service("main").fact_revoke("0123456789abcdef", "opaque fixture")

    def test_fact_search_envelope_and_limit(self) -> None:
        service = self.service()
        service.fact_submit("catalogue parent", PROOF)
        service.fact_submit("catalogue child", PROOF)
        result = service.fact_search("catalogue", limit=1)
        self.assertEqual(result["query"], "catalogue")
        self.assertEqual(len(result["results"]), 1)
        self.assertEqual(set(result["results"][0]), {"fact_id", "score", "statement"})
        self.assertEqual(service.fact_search("unmatchedtoken"), {"query": "unmatchedtoken", "results": []})

    def test_missing_literature_provider_is_explicit_and_offline(self) -> None:
        service = self.service("verifier", literature_search=None)
        self.assertEqual(service.search_arxiv_theorems("opaque query"), {
            "query": "opaque query", "count": 0, "results": [], "error": "literature_search is not configured",
        })
        self.assertFalse(self.project.exists())

    def test_literature_passes_through_results_and_does_not_hide_exceptions(self) -> None:
        provider_result = {"query": "opaque", "count": 0, "results": [], "error": "provider fixture unavailable"}
        search = Mock(return_value=provider_result)
        service = self.service("verifier", literature_search=search)
        self.assertIs(service.call("search_arxiv_theorems", {"query": "opaque", "num_results": 3}), provider_result)
        search.assert_called_once_with("opaque", num_results=3)
        with self.assertRaisesRegex(RuntimeError, "provider raised"):
            self.service("verifier", literature_search=Mock(side_effect=RuntimeError("provider raised"))).search_arxiv_theorems("opaque")
        self.assertFalse(self.project.exists())


if __name__ == "__main__":
    unittest.main()
