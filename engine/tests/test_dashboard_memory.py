"""Compare against the unchanged, pinned Danus functions on the same Core bytes."""
import ast
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
import unittest
from unittest.mock import patch
import uuid

from danus.core.factgraph import FactGraph
from danus.core.global_memory import GlobalMemory
from hana_math_engine import dashboard_memory as memory, research

PIN = '6d92e8d415933ca2ef52fd1a4da73fdfcd418f1c:danus/observability/app.py'
BLOB = '38fcb4acf56520c62958fe7ebbaff6afd5402245'
CLOCK = 1795068000.25


def oracle(repo):
    def git(*args):
        return subprocess.run(['git', *args], cwd=repo, check=True, capture_output=True,
                              text=True, encoding='utf-8', timeout=10).stdout
    assert git('rev-parse', '--verify', PIN).strip() == BLOB
    names = {'_facts_dir', '_channel_file', '_parse_fact', '_load_facts', '_load_jsonl', '_load_channel',
             'build_overview', 'build_channels', 'build_channel'}
    constants = {'CHANNELS', '_CHANNEL_KINDS', '_FM'}
    tree = ast.parse(git('show', PIN), filename=PIN)
    selected = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names
                or isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in constants for t in n.targets)]
    assert len(selected) == len(names) + len(constants)
    namespace = {'Path': Path, 're': re, 'json': json, 'time': SimpleNamespace(time=lambda: CLOCK),
                 'Any': Any, 'Dict': Dict, 'List': List, 'Optional': Optional}
    exec(compile(ast.Module(body=selected, type_ignores=[]), PIN, 'exec'), namespace)
    return namespace


class DashboardMemoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.data = Path(temporary.name).resolve()
        self.a = self.shared('project-alpha')
        self.b = self.shared('project-beta')

    def shared(self, project_id):
        root = self.data / 'context/projects' / project_id / 'shared'
        root.mkdir(parents=True)
        return root

    def req(self, project, view, *, kind=None, role='main', control=True, op='dashboard_memory'):
        args = {'view': view} if view else {}
        if kind is not None:
            args['kind'] = kind
        return {'schemaVersion': 1, 'requestId': str(uuid.uuid4()), 'operation': op, 'arguments': args,
                'context': {'projectId': project, 'runId': f'control-{uuid.uuid4()}' if control else 'run-fixture',
                            'author': 'fixture', 'role': role}}

    def read_model(self, project, view, kind=None):
        with patch.object(research.time, 'time', return_value=CLOCK):
            reply = research.dispatch(self.data, self.req(project, view, kind=kind))
        self.assertTrue(reply['ok'], reply.get('error'))
        self.assertEqual(set(reply['result']), {'projectId', 'data'})
        self.assertEqual(reply['result']['projectId'], project)
        return reply['result']['data']

    def test_real_core_projects_match_unmodified_danus_fields_and_order(self):
        # Never silently count this test as parity without the pinned oracle.
        repo = os.environ.get('HANA_TEST_DANUS_REPO')
        if not repo:
            self.skipTest('HANA_TEST_DANUS_REPO not supplied')
        source = oracle(Path(repo))
        gm, fg = GlobalMemory(self.a), FactGraph(self.a)
        a = fg.add(problem_id='project-alpha', author='研究者', statement='平方非负', proof='见 $x^2$。')
        fg.add(problem_id='project-alpha', author='合作者', statement='展开', proof='由平方非负。', predecessors=[a])
        with patch('danus.core.global_memory.utc_now', side_effect=['2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z',
                   '2026-01-03T00:00:00Z', *(['2026-01-02T00:00:00Z'] * 6)]):
            first = gm.append('plan', '最新（同刻一）', '思路甲', '研究者', links={'predecessors': [a]})
            gm.append('plan', '旧计划', '', '研究者')
            gm.append('plan', '最新（同刻二）', '', '研究者')
            gm.append('verification', '通过', 'verdict: correct', '研究者', verdict='correct', fact_id=a,
                      write_error=None, verification_report={'summary': '成立', 'critical_errors': [], 'gaps': []})
            gm.append('verification', '拒绝', '证据不足', '研究者', verdict='wrong')
            gm.append('verification', '待定', '', '研究者', verdict='error')
            gm.append('verification', '缺 verdict', '', '研究者')
            gm.append('verification', '显式 null', '', '研究者', verdict=None)
            gm.append('master_guidance', '方向', '完整正文', '合作者', cost_usd=0.125, input_tokens=17)
        gm.set_status(first, 'verified', fact_id=a)  # Danus intentionally ignores this transition.
        with (self.a / 'global_memory/plan.jsonl').open('ab') as stream:
            stream.write(b'\nnot JSON\n[1]\n')
        GlobalMemory(self.b).append('conclusion', '乙项目独有', '乙证据', '乙')
        FactGraph(self.b).add(problem_id='project-beta', author='乙', statement='另一事实', proof='证明乙。')
        # Danus labels by project directory basename. Hana's shared root is named
        # 'shared'; the equivalent label on the wire is the bound project ID.
        for project, root in [('project-alpha', self.a), ('project-beta', self.b)]:
            expected = source['build_overview'](root)
            self.assertEqual(expected['project'], 'shared')
            expected['project'] = project
            expected = json.loads(json.dumps(expected, ensure_ascii=False))
            self.assertEqual(self.read_model(project, 'overview'), expected)
            self.assertEqual(self.read_model(project, 'channels'), source['build_channels'](root))
            for kind, _ in memory.CHANNELS:
                self.assertEqual(self.read_model(project, 'channel', kind), source['build_channel'](kind, root), kind)
        self.assertEqual([r['claim'] for r in self.read_model('project-alpha', 'channel', 'plan')['entries']],
                         ['最新（同刻一）', '最新（同刻二）', '旧计划'])
        self.assertEqual(self.read_model('project-alpha', 'overview')['verdicts'],
                         {'correct': 1, 'wrong': 1, 'error': 1, '?': 1, 'null': 1})
        self.assertEqual(self.read_model('project-beta', 'channel', 'plan')['entries'], [])

    def test_private_paths_and_status_are_not_projected_and_graph_contract_is_unchanged(self):
        marker = 'internal-path-marker'
        project = 'project-alpha'
        gm = GlobalMemory(self.a)
        gm.append('verification', '公开陈述', '公开证明', 'fixture', verdict='correct', write_error=f'/store/{marker}',
                  raw_path=f'/store/{marker}', links={'source_id': 'shared', 'path': f'/store/{marker}'},
                  verification_report={'summary': '公开', 'raw_path': marker, 'gaps': [{'location': 'p', 'issue': 'i', 'path': marker}]})
        gm.set_status('unrelated', 'verified')
        other = self.a / 'global_memory/foreign.jsonl'
        other.write_text(json.dumps({'claim': marker}), encoding='utf-8')
        private = self.a.parent / 'workers/w/local_memory/notes.jsonl'
        private.parent.mkdir(parents=True)
        private.write_text(marker, encoding='utf-8')
        data = self.read_model(project, 'channel', 'verification')
        self.assertNotIn(marker, json.dumps(data))
        self.assertEqual(data['entries'][0]['write_error'], 'fact write failed')
        self.assertEqual(data['entries'][0]['links'], {'source_id': 'shared'})
        self.assertEqual(len(self.read_model(project, 'channels')['channels']), 11)
        graph = research.dispatch(self.data, self.req(project, None, op='dashboard_factgraph'))
        self.assertTrue(graph['ok'], graph)
        self.assertEqual(set(graph['result']), {'projectId', 'asOf', 'graph'})
        self.assertEqual(graph['result']['graph'], {'nodes': [], 'edges': [], 'max_depth': 0})

    def test_terminal_witness_matches_all_views_and_changes_only_with_public_inventory(self):
        project = 'project-alpha'
        graph = FactGraph(self.a)
        fid = graph.add(problem_id=project, author='fixture', statement='Claim', proof='Proof.')
        memory_store = GlobalMemory(self.a)
        memory_store.append('plan', 'Plan', 'Evidence', 'fixture')

        def read(view, kind=None, project_id=project):
            op = 'dashboard_memory' if view else 'dashboard_factgraph'
            request = self.req(project_id, view, kind=kind, op=op)
            request['arguments']['terminal'] = True
            reply = research.dispatch(self.data, request)
            self.assertTrue(reply['ok'], reply)
            self.assertRegex(reply['result']['inventoryRevision'], r'\A[a-f0-9]{64}\Z')
            return reply['result']

        def verify_all(digest):
            for view in ('overview', 'channels'):
                self.assertEqual(read(view)['inventoryRevision'], digest)
            for kind, _ in memory.CHANNELS:
                self.assertEqual(read('channel', kind)['inventoryRevision'], digest)

        with patch.object(research, 'inventory', wraps=research.inventory) as observe:
            original = read(None)
            observe.assert_called_once_with(self.a, _shared=True)
        verify_all(original['inventoryRevision'])
        other_fact = self.b / 'fact_graph/facts' / (fid + '.md')
        other_fact.parent.mkdir(parents=True)
        other_fact.write_bytes((self.a / 'fact_graph/facts' / other_fact.name).read_bytes())
        for file in (self.a / 'global_memory').iterdir():
            if file.is_file():
                target = self.b / 'global_memory' / file.name
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(file.read_bytes())
        self.assertNotEqual(read(None, project_id='project-beta')['inventoryRevision'], original['inventoryRevision'])

        for relative in ('workers/w/local_memory/notes.jsonl', 'shared/local_memory/notes.jsonl',
                         'shared/global_memory/foreign.jsonl', 'shared/global_memory/_status.jsonl'):
            file = self.a.parent / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'not a public dashboard channel')
        self.assertEqual(read(None), original)
        inventory = research.inventory(self.a, _shared=True)
        with patch.object(research, 'inventory', return_value=dict(reversed(list(inventory.items())))):
            self.assertEqual(read(None), original)

        memory_store.append('verification', 'Checked', 'Evidence', 'fixture', verdict='correct')
        amended = read(None)
        self.assertEqual(amended['asOf'], original['asOf'])
        self.assertNotEqual(amended['inventoryRevision'], original['inventoryRevision'])
        verify_all(amended['inventoryRevision'])
        fact = self.a / 'fact_graph/facts' / (fid + '.md')
        fact.write_bytes(fact.read_bytes() + b'\nRevised proof.\n')
        updated = read(None)
        self.assertNotEqual(updated['inventoryRevision'], amended['inventoryRevision'])
        revoked = self.a / 'fact_graph/_revoked' / fact.name
        revoked.parent.mkdir(exist_ok=True)
        fact.rename(revoked)  # Same bytes moved to a different canonical path.
        after_move = read(None)['inventoryRevision']
        self.assertNotEqual(after_move, updated['inventoryRevision'])
        (self.a / 'fact_graph/revocation_log.jsonl').write_bytes(b'{"reason":"revoked"}\n')
        after_log = read(None)['inventoryRevision']
        self.assertNotEqual(after_log, after_move)
        verify_all(after_log)

    def test_terminal_flag_is_exact_and_scoped_to_internal_dashboard_reads(self):
        for op, view in [('dashboard_factgraph', None), ('dashboard_memory', 'channels')]:
            for value in [False, None, 1, 'true', {}]:
                request = self.req('project-alpha', view, op=op)
                request['arguments']['terminal'] = value
                self.assertEqual(research.dispatch(self.data, request)['error']['code'], 'invalid_request')
            for kw in [{'role': 'worker'}, {'control': False}]:
                request = self.req('project-alpha', view, op=op, **kw)
                request['arguments']['terminal'] = True
                self.assertEqual(research.dispatch(self.data, request)['error']['code'], 'forbidden')
            request = self.req('project-alpha', view, op=op)
            request['arguments'].update(terminal=True, projectId='project-beta')
            self.assertEqual(research.dispatch(self.data, request)['error']['code'], 'invalid_request')
        request = self.req('project-alpha', None, op='fact_list_page')
        request['arguments']['terminal'] = True
        self.assertEqual(research.dispatch(self.data, request)['error']['code'], 'invalid_request')

    def test_lock_budget_and_narrow_request(self):
        for req, code in [(self.req('project-alpha', 'overview', role='worker'), 'forbidden'),
                          (self.req('project-alpha', 'overview', control=False), 'forbidden'),
                          (self.req('project-alpha', 'channel', kind='_status'), 'invalid_request'),
                          (self.req('project-alpha', 'channel', kind='other-project'), 'invalid_request'),
                          (self.req('project-alpha', 'overview', kind='plan'), 'invalid_request')]:
            response = research.dispatch(self.data, req)
            self.assertFalse(response['ok']); self.assertEqual(response['error']['code'], code)
        # Reuse stock size and flock gates, not a second DataDir reader.
        directory = self.a / 'global_memory'
        directory.mkdir()
        f = directory / 'plan.jsonl'
        f.write_bytes(b'x' * (research.MAX_JSON + 1))
        response = research.dispatch(self.data, self.req('project-alpha', 'channels'))
        self.assertEqual(response['error']['code'], 'size_limit')
        self.assertNotIn('result', response)
        f.unlink()
        lock_path = self.a.parent / 'research/control/project.lock'
        with lock_path.open('rb') as fd:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            response = research.dispatch(self.data, self.req('project-alpha', 'channels'))
            self.assertEqual(response['error']['code'], 'busy')
            self.assertNotIn('result', response)
