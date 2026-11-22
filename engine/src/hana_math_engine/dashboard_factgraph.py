# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 FrenzyMath (Danus observability portions).
# From Danus 6d92e8d415933ca2ef52fd1a4da73fdfcd418f1c,
# danus/observability/app.py. _FM, _parse_fact and _depths are unchanged;
# build_factgraph's projection is adapted to checked Hana DTOs, not files.
"""Pure inner adapter for Danus's /api/factgraph response shape."""
from __future__ import annotations

from collections.abc import Iterable
import re
from typing import Any, Dict, List, Optional

from .research import MAX_ITEMS, MAX_JSON, MAX_TREE_BYTES, MAX_TREE_FILES, encoded


_FM = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


def _parse_fact(text: str) -> Dict[str, Any]:
    """fact md = YAML-ish frontmatter (fact_id / problem_id / author /
    predecessors) + ``## statement`` / ``## proof`` / ``## intuition`` sections."""
    m = _FM.match(text)
    fm: Dict[str, Any] = {}
    body = text
    if m:
        body = m.group(2)
        for line in m.group(1).splitlines():
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            k, v = k.strip(), v.strip()
            if v.startswith("[") and v.endswith("]"):
                inner = v[1:-1].strip()
                fm[k] = [x.strip().strip("'\"") for x in inner.split(",") if x.strip()] if inner else []
            else:
                fm[k] = v
    secs = {"statement": "", "proof": "", "intuition": ""}
    cur: Optional[str] = None
    for line in body.splitlines():
        h = re.match(r"^##\s+(\w+)", line)
        if h and h.group(1).lower() in secs:
            cur = h.group(1).lower()
            continue
        if cur:
            secs[cur] += line + "\n"
    return {
        "fact_id": fm.get("fact_id", ""),
        "problem_id": fm.get("problem_id", ""),
        "author": fm.get("author", ""),
        "predecessors": fm.get("predecessors", []) or [],
        "statement": secs["statement"].strip(),
        "proof": secs["proof"].strip(),
        "intuition": secs["intuition"].strip(),
    }


def _depths(deps: Dict[str, List[str]]) -> Dict[str, int]:
    """depth = longest path from a leaf (no-predecessor) node up to this one —
    how many dependency layers a fact is built on. Leaves = 0. Cycle-guarded (a
    content-addressed DAG shouldn't cycle, but the store may be mid-write)."""
    depth: Dict[str, int] = {}

    def get(fid: str, stack: frozenset) -> int:
        if fid in depth:
            return depth[fid]
        if fid in stack:  # cycle guard
            return 0
        ps = deps.get(fid, [])
        d = 0 if not ps else 1 + max(get(p, stack | {fid}) for p in ps)
        depth[fid] = d
        return d

    for fid in deps:
        get(fid, frozenset())
    return depth


_ID = re.compile(r'[0-9a-f]{16}')
_HEADER = ('fact_id', 'predecessors', 'author', 'problem_id')
_DTO = {'fact_id', 'predecessors', 'markdown'}


class FactgraphSizeLimit(ValueError):
    """A bounded observation cannot be represented without truncation."""


def _fact_id(value: object) -> bool:
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _checked_fact(record: dict) -> tuple[dict, int]:
    if not isinstance(record, dict) or set(record) != _DTO:
        raise ValueError('factgraph requires canonical fact DTOs')
    fid, preds, raw = record['fact_id'], record['predecessors'], record['markdown']
    if (not _fact_id(fid) or not isinstance(preds, list) or len(preds) > MAX_ITEMS
            or not all(_fact_id(p) for p in preds) or len(set(preds)) != len(preds)
            or not isinstance(raw, str) or not raw.startswith(f'---\nfact_id: {fid}\n')):
        raise ValueError('invalid canonical fact identity or ancestry')
    if len(raw) > MAX_JSON or (size := len(raw.encode('utf-8'))) > MAX_JSON:
        raise FactgraphSizeLimit('canonical fact exceeds file byte budget')
    match = _FM.match(raw)
    header = ([line.split(':', 1)[0].strip() for line in match.group(1).splitlines()
               if ':' in line] if match else [])
    if any(header.count(key) != 1 for key in _HEADER):
        raise ValueError('missing or ambiguous canonical frontmatter')
    # The original parser defaults missing fields and accepts an empty scalar as
    # []. Explicitly require the predecessor list syntax for this trusted path.
    pred_line = next(line for line in match.group(1).splitlines()
                     if line.split(':', 1)[0].strip() == 'predecessors' and ':' in line)
    if not re.fullmatch(r'\s*\[.*\]\s*', pred_line.split(':', 1)[1]):
        raise ValueError('canonical predecessors must be a list')
    fact = _parse_fact(raw)
    if (fact['fact_id'] != fid or fact['predecessors'] != preds
            or not all(isinstance(fact[k], str) and fact[k] for k in ('author', 'problem_id', 'statement', 'proof'))):
        raise ValueError('canonical fact disagrees with dashboard input or lacks full text')
    return fact, size


def build_factgraph(records: Iterable[dict]) -> dict:
    """Build from one complete, authorized canonical observation (no filesystem IO).

    Unlike the upstream file walker, reject missing dependency nodes rather
    than rendering an incomplete observation as a shallower graph.
    """
    facts, ids, total = [], set(), 0
    for record in records:
        if len(facts) >= MAX_TREE_FILES:
            raise FactgraphSizeLimit('factgraph exceeds tree file budget')
        fact, size = _checked_fact(record)
        total += size
        if total > MAX_TREE_BYTES:
            raise FactgraphSizeLimit('factgraph exceeds tree byte budget')
        if fact['fact_id'] in ids:
            raise ValueError('duplicate canonical fact ID')
        ids.add(fact['fact_id'])
        facts.append(fact)
    if any(p not in ids for f in facts for p in f['predecessors']):
        raise ValueError('factgraph observation is missing a predecessor')
    facts.sort(key=lambda f: f['fact_id'])
    deps = {f['fact_id']: f['predecessors'] for f in facts}
    try:
        depth = _depths(deps)
    except RecursionError:
        raise FactgraphSizeLimit('factgraph exceeds upstream depth computation') from None
    nodes = [{
        'id': f['fact_id'], 'author': f['author'], 'problem_id': f['problem_id'],
        'statement': f['statement'], 'proof': f['proof'], 'intuition': f['intuition'],
        'predecessors': deps[f['fact_id']], 'depth': depth.get(f['fact_id'], 0),
    } for f in facts]
    edges = [{'source': p, 'target': f['fact_id']} for f in facts for p in deps[f['fact_id']]]
    result = {'nodes': nodes, 'edges': edges, 'max_depth': max(depth.values(), default=0)}
    if len(encoded(result)) > MAX_JSON:
        raise FactgraphSizeLimit('factgraph exceeds result byte budget')
    return result
