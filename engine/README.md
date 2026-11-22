# Hana Math Engine — CP1 core

> Status (2026-11-12): the App consumes this engine through its runtime entry;
> several behavioural notes below are still written for the standalone CP1 layer.
> Current project state is in the repository root `dev-state.md`.

An independent Python distribution (`hana-math-engine`, Python >=3.10), not a
Hana App package. CP1 preserves Danus's pure file-backed fact graph, local/global
memory data structures, glossary and role table without changing their semantics.
It is not connected to Hana yet and does not launch a model, Codex, worker,
verifier or network service. Data-structure tests use temporary software fixtures;
they are not mathematical proofs or real verifier-accepted results.

## Scope and provenance

`src/danus` is a **trimmed compatibility namespace**, not the complete Danus
runtime. Its original package initializer (including its upstream version and
docstring) is retained byte-for-byte; that version is not the Hana App version.
The new `danus.gateway` initializer contains only a package docstring: it does
not import an MCP server. The independently developed `hana_math_engine` service
namespace can be discovered by the same src-layout package configuration.

Upstream project: [Danus](https://github.com/frenzymath/Danus), authored by
**Bin Wu** as recorded in its `pyproject.toml`.
The 17 byte-identical source copies and their SHA256 hashes are recorded in
`UPSTREAM.json`, from Danus Git commit
`839c471d0560b9b5308afc6cbb59a138819fe16c`. Each copied file was clean in the source
working tree. The full upstream Apache-2.0 `LICENSE` is retained unchanged.
Upstream has no root `NOTICE`; none was invented. Original core documentation and
tests are preserved, including references to components outside this subset.
This README and the local package/test scaffold are migration additions.

The CLI, MCP server, HTTP verification launcher, orchestration/execution layer,
historical projects and credentials are deliberately **not** migrated. Core
imports and package resources do not depend on a sibling Danus checkout. The
unmodified role table is permission data, not an authorization server or verifier.
`FactGraph.add` itself stores supplied data: verification remains the caller's
responsibility and is not performed by importing this package.

## Local installation and tests

The primary test command needs only Python 3.12's standard library: no pytest,
installation, model invocation or network access. From the repository root:

```sh
cd engine
PYTHONPATH=src python3.12 -B -m unittest discover -s tests -v
```

`tests/test_upstream.py` exposes all 15 unchanged, zero-argument upstream tests as
`FunctionTestCase` instances, so unittest discovery includes them along with the
service and provenance tests. The original `tests/upstream/test_core.py` is not
modified.

Use a dedicated Python environment; there are no runtime dependencies. With
setuptools/build tooling already available, an offline editable installation is:

```sh
cd engine
python3.12 -m pip install --no-index --no-build-isolation --no-deps -e .
```

Do not install this compatibility namespace alongside the full Danus package in
the same environment. `pytest` is an optional `dev` extra, not a runtime
requirement; provision it separately from an approved offline wheel source if
needed. With pytest already available, run only the migration-owned checks:

```sh
python3.12 -m pytest tests/upstream/test_core.py tests/test_vendored_source.py -q
```

For focused diagnosis, the original upstream standalone entrypoint and our
standard-library provenance/import tests also run directly:

```sh
PYTHONPATH=src python3.12 -B tests/upstream/test_core.py
python3.12 -B tests/test_vendored_source.py -v
```

The provenance suite checks the fixed copied-file manifest, SHA256 hashes,
package contract, and core/service imports plus resources from a relocated copy
of the entire `src` tree under an isolated interpreter. It rejects runtime/model
dependencies and network/process activity inside that import probe.

Wheel build/installation has **not been validated**: the available Python 3.12
environment has no build/setuptools, and no dependencies were installed. No wheel
or Hana package build, installation or model invocation is part of this check.
