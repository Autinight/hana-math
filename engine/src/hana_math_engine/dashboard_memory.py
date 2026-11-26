# SPDX-License-Identifier: Apache-2.0
# Count/ordering semantics: Danus 6d92e8d415933ca2ef52fd1a4da73fdfcd418f1c,
# danus/observability/app.py:137–161,241–261,280–292.
"""Pure Overview/Global Memory read model over an already checked shared inventory."""
from collections import Counter
from hashlib import sha256
import json
import math
from pathlib import Path

from .dashboard_factgraph import _parse_fact
from .research import FID, matches, require

CHANNELS = (
    ('conclusion', 'result'), ('example', 'result'), ('counterexample', 'result'),
    ('proof_attempt', 'result'), ('plan', 'judgment'), ('direction', 'judgment'),
    ('obstacle', 'deadend'), ('dead_end', 'deadend'), ('verification', 'verify'),
    ('elaboration', 'strategy'), ('master_guidance', 'strategy'),
)
_CHANNEL_FILES = {kind: Path('global_memory') / (kind + '.jsonl') for kind, _ in CHANNELS}
_PUBLIC_FILES = frozenset((*_CHANNEL_FILES.values(), Path('fact_graph/revocation_log.jsonl')))
_FACT_DIRS = {Path('fact_graph/facts'), Path('fact_graph/_revoked')}
_ENTRY = ('id', 'timestamp_utc', 'author', 'kind', 'claim', 'evidence', 'verifiable',
          'status', 'fact_id', 'links', 'glossary')


def valid_selection(args):
    if type(args) is not dict or type(args.get('view')) is not str:
        return False
    if args['view'] in ('overview', 'channels'):
        return args.keys() == {'view'}
    return (args['view'] == 'channel' and args.keys() == {'view', 'kind'}
            and type(args['kind']) is str and args['kind'] in _CHANNEL_FILES)


def inventory_revision(project_id, inventory):
    """One content witness for all dashboard selections, over checked shared bytes only."""
    digest = sha256(b'hana-math-dashboard-inventory-v1\0')

    def frame(value):
        digest.update(len(value).to_bytes(8, 'big'))
        digest.update(value)

    frame(project_id.encode('utf-8'))
    visible = (p for p in inventory if p in _PUBLIC_FILES or
               (p.parent in _FACT_DIRS and p.suffix == '.md' and matches(FID, p.stem)))
    for p in sorted(visible, key=lambda p: p.as_posix()):
        frame(p.as_posix().encode('utf-8'))
        frame(inventory[p])
    return digest.hexdigest()


def _rows(inventory, kind):
    try:
        text = inventory.get(_CHANNEL_FILES[kind], b'').decode('utf-8')
    except UnicodeError:
        raise ValueError('invalid UTF-8 in shared channel') from None
    # Same skip rules as Danus; no status-folding and no BM25.
    for line in text.splitlines():
        try:
            row = json.loads(line.strip())
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            yield row


def _entry(kind, row):
    # Keep established shared display fields, not arbitrary **extra diagnostics.
    public = {key: row[key] for key in _ENTRY if key in row}
    if kind == 'verification':
        for key in ('verdict', 'verification_report'):
            if key in row:
                public[key] = row[key]
        if 'write_error' in row:
            # Core may embed an absolute filesystem path in the exception text.
            public['write_error'] = None if row['write_error'] is None else 'fact write failed'
    if kind == 'master_guidance':
        for key in ('input_tokens', 'cost_usd'):
            if key in row:
                public[key] = row[key]
    # Only typed display fields cross the boundary; unrelated structured metadata does not.
    valid = lambda ok: require(ok, message='invalid shared channel entry')
    for key in ('id', 'author', 'kind', 'claim', 'evidence', 'status', 'timestamp_utc'):
        valid(key not in public or type(public[key]) is str)
    for key in ('fact_id', 'verdict'):
        valid(public.get(key) is None or type(public[key]) is str)
    valid('verifiable' not in public or type(public['verifiable']) is bool)
    if 'input_tokens' in public:
        valid(type(public['input_tokens']) is int and 0 <= public['input_tokens'] < (1 << 53))
    if 'cost_usd' in public:
        cost = public['cost_usd']
        valid(type(cost) in (float, int) and 0 <= cost < (1 << 53) and math.isfinite(cost))
    if 'glossary' in public:
        glossary = public['glossary']
        valid(type(glossary) is dict and all(type(v) is str for v in glossary.values()))
    if 'links' in public:
        links = public['links']
        valid(type(links) is dict)
        public['links'] = {k: v for k, v in links.items() if k in ('source_id', 'subgoal', 'predecessors', 'fact_ids')}
        for key, value in public['links'].items():
            valid(value is None or (type(value) is list and all(type(p) is str for p in value)
                  if key in ('predecessors', 'fact_ids') else type(value) is str))
    if (report := public.get('verification_report')) is not None:
        valid(type(report) is dict)
        public['verification_report'] = {k: report[k] for k in ('summary', 'critical_errors', 'gaps') if k in report}
        valid('summary' not in report or type(report['summary']) is str)
        for key in ('critical_errors', 'gaps'):
            if key in report:
                valid(type(report[key]) is list and all(type(i) is dict for i in report[key]))
                items = [{k: i[k] for k in ('location', 'issue') if k in i} for i in report[key]]
                valid(all(type(v) is str for item in items for v in item.values()))
                public['verification_report'][key] = items
    return public


def _timestamp(row):
    value = row.get('timestamp_utc', '')
    require(type(value) is str, 'invalid_request', 'invalid shared channel timestamp')
    return value


def build_dashboard_memory(project_id, inventory, args, *, updated_at):
    require(valid_selection(args), message='invalid shared dashboard selection')
    if args['view'] == 'channel':
        kind = args['kind']
        rows = sorted(_rows(inventory, kind), key=_timestamp, reverse=True)
        return {'kind': kind, 'count': len(rows), 'entries': [_entry(kind, row) for row in rows]}
    counts = {}
    verdicts = Counter()
    for kind, _ in CHANNELS:
        count = 0
        for row in _rows(inventory, kind):
            count += 1
            if args['view'] == 'overview' and kind == 'verification':
                verdict = row.get('verdict', '?')
                # Danus returns JSON object keys; None serializes as 'null'.
                require(verdict is None or type(verdict) is str, message='invalid shared verification verdict')
                verdicts[verdict if verdict is not None else 'null'] += 1
        counts[kind] = count
    if args['view'] == 'channels':
        return {'channels': [{'kind': kind, 'role': role, 'count': counts[kind]} for kind, role in CHANNELS]}

    paths = sorted(p for p in inventory if p.parent == Path('fact_graph/facts') and p.suffix == '.md')
    from .research import MAX_TREE_FILES
    require(len(paths) <= MAX_TREE_FILES, 'size_limit', f'dashboard fact index exceeds {MAX_TREE_FILES} facts')
    by_author = Counter()
    with_predecessors = 0
    for p in paths:
        require(matches(FID, p.stem) and Path('fact_graph/_revoked') / p.name not in inventory,
                'invalid_fact', 'invalid active fact in dashboard inventory')
        try:
            fact = _parse_fact(inventory[p].decode('utf-8'))
        except UnicodeError:
            raise ValueError('invalid UTF-8 in shared fact') from None
        require(fact['fact_id'] == p.stem and type(fact['author']) is str and type(fact['predecessors']) is list,
                'invalid_fact', 'invalid dashboard fact metadata')
        by_author[fact['author']] += 1
        with_predecessors += bool(fact['predecessors'])
    return {'project': project_id, 'facts': len(paths), 'facts_with_predecessors': with_predecessors,
            'facts_by_author': dict(by_author), 'channel_counts': counts, 'verdicts': dict(verdicts), 'updated_at': updated_at}
