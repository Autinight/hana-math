"""Project-bound business services extracted from Danus gateway/server.py.

No CLI, MCP, environment configuration, HTTP or model implementation lives here.
The trusted adapter constructs one service per project/author/role. All six tool
methods, including direct Python calls, enforce the upstream role table.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import KW_ONLY, dataclass, field
from pathlib import Path
from typing import Any, Protocol

from danus.core import FactGraph, GlobalMemory
from danus.gateway.roles import ALL_TOOLS, tools_for

_LOG = logging.getLogger(__name__)


class Verifier(Protocol):
    """Synchronous trusted verifier injection; CP1 validates only dict/verdict."""

    def __call__(self, statement: str, proof: str) -> object: ...


class LiteratureSearch(Protocol):
    """Synchronous trusted provider; the service itself never uses the network."""

    def __call__(self, query: str, *, num_results: int = 10) -> dict[str, Any]: ...


@dataclass(frozen=True, slots=True)
class CoreService:
    """Fixed trusted context, not an OS sandbox or a Python security boundary.

    There are no per-tool project, author or role selectors. Frozen attributes
    prevent accidental rebinding; code with arbitrary Python/filesystem access
    remains trusted and can use the underlying core libraries directly.
    """

    project_dir: Path
    _: KW_ONLY
    author: str
    role: str
    verifier: Verifier | None = field(default=None, repr=False)
    literature_search: LiteratureSearch | None = field(default=None, repr=False)
    problem_id: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.author, str) or not isinstance(self.role, str):
            raise TypeError("author and role must be strings")
        if self.problem_id is not None and not isinstance(self.problem_id, str):
            raise TypeError("problem_id must be a string or None")
        if self.verifier is not None and not callable(self.verifier):
            raise TypeError("verifier must be callable or None")
        if self.literature_search is not None and not callable(self.literature_search):
            raise TypeError("literature_search must be callable or None")
        root = Path(self.project_dir).resolve()
        object.__setattr__(self, "project_dir", root)
        if self.problem_id is None:
            object.__setattr__(self, "problem_id", root.name)

    @property
    def available_tools(self) -> tuple[str, ...]:
        """An immutable snapshot; unknown roles retain verifier-only access."""
        return tuple(tools_for(self.role))

    def _require_tool(self, tool_name: str) -> None:
        if tool_name not in ALL_TOOLS:
            raise ValueError(f"unknown tool: {tool_name!r}")
        if tool_name not in tools_for(self.role):
            raise PermissionError(f"role {self.role!r} cannot call {tool_name!r}")

    def call(self, tool_name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
        """Dispatch only the six named tools, never arbitrary object attributes."""
        self._require_tool(tool_name)
        if not isinstance(arguments, Mapping):
            raise TypeError("arguments must be a mapping")
        return getattr(self, tool_name)(**dict(arguments))

    def gm_add(
        self,
        kind: str,
        claim: str,
        evidence: str = "",
        verifiable: bool | None = None,
        glossary: dict[str, str] | None = None,
        links: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Publish shared awareness; this never creates a fact."""
        self._require_tool("gm_add")
        entry_id = GlobalMemory(self.project_dir).append(
            kind, claim=claim, evidence=evidence, author=self.author,
            verifiable=verifiable, glossary=glossary, links=links,
        )
        return {"id": entry_id, "kind": kind}

    def gm_search(
        self, query: str, kinds: list[str] | None = None, limit_per_kind: int = 10,
    ) -> dict[str, Any]:
        self._require_tool("gm_search")
        return GlobalMemory(self.project_dir).search(
            query, kinds=kinds, limit_per_kind=limit_per_kind,
        )

    def fact_submit(
        self,
        statement: str,
        proof: str,
        predecessors: list[str] | None = None,
        glossary_introduces: dict[str, str] | None = None,
        intuition: str = "",
        source_id: str | None = None,
        external_refs: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Verify, conditionally add, then record the upstream verification trace.

        CP1 intentionally retains verdict-only acceptance and accepted=True with
        fact_id=None on write failure. Neither that envelope nor a trace is proof
        that a fact was persisted. Trace errors propagate even after fg.add.
        """
        self._require_tool("fact_submit")
        fg = FactGraph(self.project_dir)
        gm = GlobalMemory(self.project_dir)

        # Advisory, as upstream; unlike its bare catch, keep failures observable.
        try:
            undefined = fg.undefined_symbols(
                statement=statement, proof=proof, intuition=intuition,
                predecessors=predecessors, glossary_introduces=glossary_introduces,
            )
        except Exception:
            _LOG.warning("glossary coverage check failed; continuing advisory-only", exc_info=True)
            undefined = []

        try:
            if self.verifier is None:
                raise RuntimeError("verifier is not configured")
            result = self.verifier(statement, proof)
        except Exception as error:
            return {"accepted": False, "verdict": "error", "error": str(error),
                    "undefined_symbols": undefined}
        if not isinstance(result, dict):
            return {"accepted": False, "verdict": "error",
                    "error": f"verify service returned a non-dict body ({type(result).__name__})",
                    "undefined_symbols": undefined}
        verdict = result.get("verdict")
        accepted = verdict == "correct"

        fact_id = None
        write_error = None
        if accepted:
            try:
                fact_id = fg.add(
                    problem_id=self.problem_id, author=self.author,
                    statement=statement, proof=proof,
                    predecessors=predecessors, glossary_introduces=glossary_introduces,
                    intuition=intuition, external_refs=external_refs,
                )
            except Exception as error:
                write_error = str(error)

        # Match upstream even for a dict with a missing or unknown verdict.
        # Do not catch append failures: the adapter must reconcile partial writes.
        gm.append(
            "verification",
            claim=statement,
            evidence="verdict: correct" if accepted else (result.get("repair_hints") or "verdict: wrong"),
            author=self.author,
            verifiable=False,
            links={"source_id": source_id, "predecessors": predecessors or []},
            verdict=verdict,
            fact_id=fact_id,
            write_error=write_error,
            verification_report=result.get("verification_report"),
        )

        if not accepted:
            return {
                "accepted": False,
                "verdict": verdict,
                "repair_hints": result.get("repair_hints"),
                "verification_report": result.get("verification_report"),
                "undefined_symbols": undefined,
            }
        if write_error:
            return {"accepted": True, "fact_id": None, "write_error": write_error,
                    "undefined_symbols": undefined}
        return {"accepted": True, "fact_id": fact_id, "undefined_symbols": undefined}

    def fact_search(self, query: str, limit: int = 10) -> dict[str, Any]:
        self._require_tool("fact_search")
        return {"query": query, "results": FactGraph(self.project_dir).search(query, limit=limit)}

    def fact_revoke(self, fact_id: str, reason: str) -> dict[str, Any]:
        self._require_tool("fact_revoke")
        return {"revoked": FactGraph(self.project_dir).revoke(fact_id, reason=reason)}

    def search_arxiv_theorems(self, query: str, num_results: int = 10) -> dict[str, Any]:
        self._require_tool("search_arxiv_theorems")
        if self.literature_search is None:
            return {"query": query, "count": 0, "results": [],
                    "error": "literature_search is not configured"}
        # Provider failures are not suppressed; a provider may return its own
        # upstream-compatible error envelope. No fallback or network is implied.
        return self.literature_search(query, num_results=num_results)
