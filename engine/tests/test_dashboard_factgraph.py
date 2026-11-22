"""Synthetic observations only. Set HANA_TEST_DANUS_REPO to check the Git oracle."""
import ast
import fcntl
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any, Dict, List, Optional
import unittest
from unittest.mock import patch
import uuid

from danus.core.factgraph import FactGraph
from hana_math_engine import dashboard_factgraph as graph
from hana_math_engine import research

_PIN = '6d92e8d415933ca2ef52fd1a4da73fdfcd418f1c'
_BLOB = '38fcb4acf56520c62958fe7ebbaff6afd5402245'
_SOURCE = 'danus/observability/app.py'
_IDS = [f'{i:016x}' for i in range(1, 5)]


def git_oracle(repo):
    """Load only the unchanged pure functions and their filesystem test helpers.

    No FastAPI, service initialization, or current Danus checkout contents.
    """
    def git(*args):
        return subprocess.run(['git', *args], cwd=repo, check=True, capture_output=True,
                              text=True, encoding='utf-8', timeout=10).stdout

    name = f'{_PIN}:{_SOURCE}'
    if git('rev-parse', '--verify', name).strip() != _BLOB:
        raise AssertionError('wrong upstream source blob')
    tree = ast.parse(git('show', name), filename=name)
    selected = {'_facts_dir', '_parse_fact', '_load_facts', '_depths', 'build_factgraph'}
    items = [x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name in selected
             or isinstance(x, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '_FM' for t in x.targets)]
    if {x.name for x in items if isinstance(x, ast.FunctionDef)} != selected or len(items) != len(selected) + 1:
        raise AssertionError('upstream oracle definitions changed')
    namespace = {'Path': Path, 're': re, 'Any': Any, 'Dict': Dict, 'List': List, 'Optional': Optional}
    exec(compile(ast.Module(body=items, type_ignores=[]), name, 'exec'), namespace)
    return namespace['build_factgraph']


class DashboardFactgraphTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        upstream = os.environ.get('HANA_TEST_DANUS_REPO')
        cls.oracle = staticmethod(git_oracle(upstream)) if upstream else None

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        # The real Core reader rejects ancestor aliases (e.g. macOS /var).
        self.data = Path(tmp.name).resolve()
        self.root = self.data / 'context/projects/project-dashboard/shared'
        self.facts = self.root / 'fact_graph/facts'
        self.facts.mkdir(parents=True)

    def put(self, fid, predecessors=(), author='fixture', statement='Base', proof='Proof', intuition=''):
        raw = (f'---\nfact_id: {fid}\nproblem_id: fixture-problem\nauthor: {author}\n'
               f'predecessors: [{", ".join(predecessors)}]\nexternal_refs: []\n---\n\n'
               f'## statement\n{statement}\n\n## proof\n{proof}\n')
        if intuition:
            raw += f'\n## intuition\n{intuition}\n'
        (self.facts / f'{fid}.md').write_bytes(raw.encode('utf-8'))
        return research.fact(self.root, fid)[0]

    def compare(self, records, expected):
        actual = graph.build_factgraph(records)
        self.assertEqual(actual, expected)
        if self.oracle is not None:
            self.assertEqual(actual, self.oracle(self.root))

    def test_empty_observation_matches_danus(self):
        self.compare(iter(()), {'nodes': [], 'edges': [], 'max_depth': 0})

    def test_real_reader_full_text_and_fork_match_danus(self):
        a, b, c, d = _IDS
        statement = r'设 $x\in\mathbb R$。' + '\n\n' + 'Retain this second paragraph ' + 'x' * 540
        proof = '证明：第一步。\n\n' + r'\[x^2\ge 0.\]' + '\n第二步∶不用省略。'
        intuition = '直观：平方非负。\n另看边界。'
        records = [self.put(d, [a], 'fork'), self.put(b, [a]), self.put(a),
                   self.put(c, [b, a], '研究者', statement, proof, intuition)]
        def node(fid, preds=(), depth=0, author='fixture', stmt='Base', prf='Proof', hint=''):
            return {'id': fid, 'author': author, 'problem_id': 'fixture-problem', 'statement': stmt,
                    'proof': prf, 'intuition': hint, 'predecessors': list(preds), 'depth': depth}
        self.compare(iter(records), {'nodes': [node(a), node(b, [a], 1),
            node(c, [b, a], 2, '研究者', statement, proof, intuition), node(d, [a], 1, 'fork')],
            'edges': [{'source': a, 'target': b}, {'source': b, 'target': c},
                      {'source': a, 'target': c}, {'source': a, 'target': d}], 'max_depth': 2})

    def test_incomplete_or_inconsistent_input_fails_closed(self):
        a, b, c, _ = _IDS
        pa, pb, pc = self.put(a), self.put(b), self.put(c, [b, a])
        for record in ({'fact_id': a, 'predecessors': [], 'statementPreview': 'not full text'},
                       dict(pa, fact_id=b), dict(pc, predecessors=[a, b]),
                       dict(pa, markdown=pa['markdown'].replace('predecessors: []\n', '')),
                       dict(pa, markdown=pa['markdown'].replace('predecessors: []', 'predecessors:')),
                       dict(pa, markdown=pa['markdown'].replace('author: fixture', 'author: first\nauthor: fixture')),
                       dict(pa, markdown=pa['markdown'].split('## proof')[0])):
            with self.subTest(keys=record.keys()), self.assertRaises(ValueError):
                graph.build_factgraph([record])
        with self.assertRaisesRegex(ValueError, 'missing a predecessor'):
            graph.build_factgraph([pa, pc])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            graph.build_factgraph([pa, pa])
        self.assertEqual(graph.build_factgraph([pc, pb, pa])['max_depth'], 1)

    def test_file_and_result_byte_limits_are_not_relaxed(self):
        a, b, *_ = _IDS
        pa, pb = (self.put(fid, proof='数' * (research.MAX_JSON // 5)) for fid in (a, b))
        with self.assertRaisesRegex(ValueError, 'file byte budget'):
            graph.build_factgraph([dict(pa, markdown=pa['markdown'] + 'x' * research.MAX_JSON)])
        with self.assertRaisesRegex(ValueError, 'result byte budget'):
            graph.build_factgraph([pa, pb])

    def request(self, *, role='main', args=None, project_id='project-dashboard', run_id=None):
        return {'schemaVersion': 1, 'requestId': str(uuid.uuid4()), 'operation': 'dashboard_factgraph',
                'context': {'projectId': project_id, 'runId': run_id or f'control-{uuid.uuid4()}',
                            'role': role, 'author': 'fixture-main'},
                'arguments': {} if args is None else args}

    def test_core_dispatch_uses_one_locked_inventory_and_real_serialized_facts(self):
        project_id = 'project-dashboard'
        f = FactGraph(self.root)
        a = f.add(problem_id=project_id, author='fixture-main', statement=r'$x^2\ge 0$', proof='由平方非负。')
        b = f.add(problem_id=project_id, author='fixture-writer', statement='推论', proof='代入上式。',
                  predecessors=[a], intuition='观察符号。')
        other = self.data / 'context/projects/project-other/shared'
        c = FactGraph(other).add(problem_id='project-other', author='fixture-other', statement='隔离', proof='fixture proof')
        workspace = self.root.parent / 'research/control'
        watched = [self.facts / (name + '.md') for name in (a, b)] + [other / 'fact_graph/facts' / (c + '.md')]
        before = [(p.read_bytes(), p.stat().st_mtime_ns) for p in watched]
        calls = []
        read_bytes = research.read_bytes

        def check_locked(file, **kwargs):
            self.assertEqual(file.parent, self.facts)
            with (workspace / 'project.lock').open('rb') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            calls.append(file.stem)
            return read_bytes(file, **kwargs)

        request = self.request()
        with patch.object(research, 'read_bytes', side_effect=check_locked), patch.object(research, 'fact', wraps=research.fact) as canonical:
            reply = research.dispatch(self.data, request)
        self.assertTrue(reply['ok'], reply)
        self.assertEqual(reply['requestId'], request['requestId'])
        self.assertEqual(sorted(calls), sorted([a, b]))
        self.assertEqual([call.args[1] for call in canonical.call_args_list], sorted([a, b]))
        result = reply['result']
        self.assertEqual(set(result), {'projectId', 'asOf', 'graph'})
        self.assertEqual(result['projectId'], project_id)
        hashes = [[fid, hashlib.sha256((self.facts / (fid + '.md')).read_bytes()).hexdigest()] for fid in sorted([a, b])]
        self.assertEqual(result['asOf'], research.fact_index_as_of(project_id, hashes))
        self.assertEqual(result['asOf'], research.fact_list_page(self.root, project_id, {'limit': 1})['page']['asOf'])
        expected = graph.build_factgraph(research.fact(self.root, fid)[0] for fid in (b, a))
        self.assertEqual(result['graph'], expected)
        if self.oracle is not None:
            self.assertEqual(result['graph'], self.oracle(self.root))
        self.assertEqual(result['graph']['edges'], [{'source': a, 'target': b}])
        self.assertEqual(result['graph']['max_depth'], 1)
        self.assertEqual([(p.read_bytes(), p.stat().st_mtime_ns) for p in watched], before)
        self.assertEqual(sorted(p.name for p in workspace.iterdir()), ['project.lock'])
        self.assertFalse((other.parent / 'research').exists())

    def test_core_rejects_worker_verifier_extra_args_and_nonproject_main(self):
        requests = [(self.request(role=role), 'forbidden') for role in ('worker', 'verifier')]
        requests += [(self.request(args={'projectId': 'project-other'}), 'invalid_request'),
                     (self.request(args={'path': '/no/such/path'}), 'invalid_request'),
                     (self.request(args=[]), 'invalid_request'),
                     (self.request(run_id='run-dashboard'), 'forbidden')]
        with patch.object(research, 'safe_path', side_effect=AssertionError('premature storage access')) as path_check:
            for req, code in requests:
                reply = research.dispatch(self.data, req)
                self.assertFalse(reply['ok'], reply)
                self.assertEqual(reply['error']['code'], code)
                self.assertNotIn('result', reply)
            path_check.assert_not_called()
        reply = research.dispatch(self.data, self.request(project_id='project-missing'))
        self.assertFalse(reply['ok'])
        self.assertFalse((self.root.parent.parent / 'project-missing').exists())

    def test_core_rejects_full_envelope_and_graph_limits_without_partial_result(self):
        # This creates a graph that fits alone, but does not fit together with
        # project ID, asOf, request ID and the existing protocol envelope.
        a, b, *_ = _IDS
        pad = 'x' * (research.MAX_JSON // 2 - 4096)
        rows = [self.put(a, proof=pad), self.put(b, proof=pad)]
        length = len(research.encoded(graph.build_factgraph(rows)))
        rows[1] = self.put(b, proof=pad + 'x' * (research.MAX_JSON - length))
        self.assertEqual(len(research.encoded(graph.build_factgraph(rows))), research.MAX_JSON)
        reply = research.dispatch(self.data, self.request())
        self.assertFalse(reply['ok']); self.assertEqual(reply['error']['code'], 'size_limit')
        self.assertEqual(reply['diagnostic']['reason'], 'response-bytes')
        self.assertNotIn('result', reply)

        with patch.object(FactGraph, 'list', return_value=[f'{i:016x}' for i in range(2049)]), patch.object(research, 'fact') as canonical:
            reply = research.dispatch(self.data, self.request())
        self.assertFalse(reply['ok']); self.assertEqual(reply['error']['code'], 'size_limit')
        self.assertIn('2048', reply['error']['message']); self.assertNotIn('result', reply)
        canonical.assert_not_called()

    def test_core_rejects_edge_count_before_producing_graph(self):
        parents = [f'{i:016x}' for i in range(128)]
        for id_ in parents:
            self.put(id_)
        for index in range(128, 128 + 257):  # 32896 edges
            self.put(f'{index:016x}', predecessors=parents)
        reply = research.dispatch(self.data, self.request())
        self.assertFalse(reply['ok']); self.assertEqual(reply['error']['code'], 'size_limit')
        self.assertIn('32768', reply['error']['message']); self.assertNotIn('result', reply)


if __name__ == '__main__':
    unittest.main()
