# CP1: transport-free core service (not a production proof backend)

> Status (2026-11-12): this layer is consumed by the App through its runtime
> entry; the contract below is unchanged. Current project state is in the
> repository root `dev-state.md`.

This layer extracts the six business operations from Danus
`danus/gateway/server.py` over the separately copied `danus.core` and unchanged
`danus.gateway.roles`. It does not import that server, FastMCP, the literature
integration, CLI, HTTP verifier, environment configuration, or any model runtime.
All tests use opaque fixed software-fixture strings, never mathematical
experimentation. Permanent tests need only this checkout.

## Trusted construction and tool surface

```python
CoreService(project_dir: Path, *, author: str, role: str,
            verifier: Verifier | None = None,
            literature_search: LiteratureSearch | None = None,
            problem_id: str | None = None)
```

The trusted backend chooses the project root, author, role and providers. The
root is resolved once; `problem_id` defaults to its directory name. Construction
does not create directories. These attributes are frozen against accidental
rebinding. No environment variable supplies or overrides them. Tools accept no
`project`, `project_dir`, `author`, `role`, `problem_id` or provider override.
Unlike the upstream main gateway's per-call `project` selector, a service always
addresses one bound project; a trusted adapter constructs another service when
it intends another project.

`available_tools` is an immutable tuple from `tools_for(role)`. Both
`call(tool_name, arguments)` and each same-named method check that role table:

| Role | Tools |
| --- | --- |
| worker | gm_add, gm_search, fact_submit, fact_search, search_arxiv_theorems |
| main | gm_add, gm_search, fact_search, fact_revoke, search_arxiv_theorems |
| verifier / unknown role | search_arxiv_theorems |
| all | All six, retained as the upstream explicit trusted development role |

Denied calls raise `PermissionError` before store or provider access. Unknown
dispatch names raise `ValueError`; invalid/extra keyword arguments raise
`TypeError`. Dispatch is restricted to the upstream six names, not arbitrary
attributes. There is no unchecked fact-add method on this service. `gm_add`
creates awareness only; even a user-authored verification finding is not a fact.
The unchanged bottom-layer `FactGraph.add` is a trusted internal library API,
not a public tool and not a security boundary.

## Injected dependencies

- `Verifier(statement, proof) -> object` is synchronous. The trusted adapter
  must supply an actual verifier later. Missing configuration, a raised
  exception, or a non-dict response returns `accepted: false`, `verdict: error`,
  an `error` and advisory `undefined_symbols`, with no fact and no verification
  trace. This service has no HTTP/model fallback and reads no credentials.
- `LiteratureSearch(query, *, num_results=10) -> dict` is synchronous. No provider
  returns `{query, count: 0, results: [], error: "literature_search is not
  configured"}` without networking. A configured provider's result passes
  through, including its own error envelope; raised exceptions propagate. The
  service does not silently substitute an endpoint or fabricate search results.

## Preserved fact submission contract

1. Run glossary coverage as an advisory check. Like upstream, its failure does
   not prevent verification. Unlike upstream's silent catch, this layer logs a
   warning with exception information; it still returns an empty advisory list.
2. Call the injected verifier with the statement and proof only.
3. **Only `result.get("verdict") == "correct"` sets `accepted` true.** CP1 adds no
   report-consistency acceptance rules. Only that branch calls `FactGraph.add`
   with the bound `problem_id` and `author`, plus the unchanged content fields.
4. If add raises, retain `accepted: true`, `fact_id: null`, `write_error`. The
   verifier accepted; graph persistence did not complete successfully. This is
   **not** an ingraph-success receipt. There is no rollback, and partial writes
   may already exist when an exception is raised.
5. For every dict verifier response, append a `verification` finding, including
   accepted, rejected, and accepted-but-write-failed responses. Preserve source
   link, predecessors, verdict, fact id, write error and verification report.
   Upstream also records a trace for a dict with a missing/unknown verdict;
   that case stays rejected, with the upstream fallback evidence text.
6. Trace append errors propagate. They are not swallowed, converted to success,
   or presented as a verifier failure. A fact can already exist when its trace
   write fails. The future adapter must reconcile this outcome explicitly.

Content-addressed IDs, whitespace normalization, predecessor handling, glossary,
BM25 reads, cascade revocation and `external_refs` normalization remain in the
unchanged core. `external_refs` is mutable metadata excluded from the fact hash;
repeat submission verifies again, reuses the same content ID, may replace that
metadata, and appends another trace. Search response envelopes match upstream.

## Deliberate CP1 limits / future Hana adapter obligations

- **Not production-ready proof validation:** `correct` is accepted even with no
  report, or a report containing errors/gaps. The adapter must establish trusted
  verifier identity and a separately reviewed strict response contract before
  production use. CP1 tests explicitly lock this inherited risk rather than
  silently tightening it during migration.
- **No OS sandbox:** project binding prevents tool-argument selector overrides,
  not arbitrary Python access or filesystem escape. The upstream core's path
  identifiers, predecessor references and symlinks are not hardened here. A
  future untrusted-input adapter must validate these, impose authorized roots,
  enforce ownership and isolate processes as required. Frozen fields are not a
  defense against malicious Python code or an untrusted provider callable.
- **No transaction/concurrency guarantee:** fact, glossary, revocation and trace
  writes are separate operations without service locks, atomic cross-store
  commit or exactly-once delivery. There may be partial effects, races and
  repeated traces. Trace append failures (including after accept/write-error)
  must be surfaced and reconciled; retries must not assume no earlier write.
- No scheduling, cancellation, retry/recovery coordinator, persistent task
  delivery, transport serialization/error redaction, provider timeout, model
  permissions, or Hana installation is implemented. No actual Agent/session,
  research task or external service is created by this migration.

## Direct software checks

From `engine/`, when the copied core is present:

```sh
PYTHONPATH=src python3.12 -B -m unittest discover -s tests -p test_service.py -v
python3.12 -m py_compile src/hana_math_engine/__init__.py src/hana_math_engine/service.py tests/test_service.py
```

The same unittest cases are pytest-collectable when pytest is available via the
engine development environment. This service does not require installing it.
