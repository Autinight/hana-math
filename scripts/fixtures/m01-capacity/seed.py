"""Opaque SOFTWARE graph seed, bypasses verifier; not mathematical facts.
Uses official FactGraph.add -> serialize_fact and content-addressed IDs.
Only invoked explicitly by the rehearsal driver against its fresh scratch.
"""
import json
from pathlib import Path
import sys

package, data, project_id = sys.argv[1:]
sys.path.insert(0, str(Path(package) / 'engine/src'))
from danus.core.factgraph import FactGraph, serialize_fact
from danus.core.schema import Fact, compute_fact_id

graph = FactGraph(Path(data) / 'context/projects' / project_id / 'shared')
assert not graph.list(), 'refuse nonempty graph seed'
rows = []
for index in range(1000):
    statement = f'opaque software seed record {index:04d}; not verified mathematics'
    proof = ('opaque payload token ' * 80).strip()
    kwargs = dict(problem_id=project_id, author='opaque-software-seed', statement=statement,
                  proof=proof, predecessors=[], glossary_introduces={})
    probe_id = compute_fact_id(problem_id=project_id, predecessors=[], glossary_introduces={},
                               statement=statement, proof=proof)
    canonical = serialize_fact(Fact(fact_id=probe_id, **kwargs))
    difference = 6144 - len(canonical.encode('utf-8'))
    assert difference > 0
    # Pure sizing with the official serializer: only the final content-addressed
    # record is written. No random IDs, temporary fact files or duplicate adds.
    kwargs['proof'] = proof + ('x' * difference)
    fact_id = graph.add(**kwargs)
    size = len(graph.get_raw(fact_id).encode('utf-8'))
    assert size == 6144, (index, size)
    rows.append({'fact_id': fact_id, 'canonicalBytes': size})
assert len(graph.list()) == 1000
print(json.dumps({'kind': 'opaque-software-seed', 'verified': False, 'count': len(rows),
                  'canonicalUTF8Bytes': sum(row['canonicalBytes'] for row in rows), 'facts': rows}))
