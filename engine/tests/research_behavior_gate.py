"""Replay with Python 3.12.14: python -I -S -B engine/tests/research_behavior_gate.py."""
import copy
import json
from pathlib import Path
import sys
import unittest

if sys.version_info[:3] != (3, 12, 14):
    raise SystemExit('The research behavior gate requires Python 3.12.14')

# Explicit local paths under -I; do not depend on platform shell syntax or installs.
tests = Path(__file__).resolve().parent
sys.path[:0] = [str(tests), str(tests.parent / 'src')]
from test_research import ResearchTests, r

CANDIDATE = {
    'statement': 'Opaque fixture: 平方标记',
    'proof': 'Opaque software fixture proof: 第一步 retains  two spaces.\n\n第二步保留换行 and exact tokens.',
}
FACT_ID = 'd0c583e400edd038'  # Fixed reference, not derived from the engine during the gate.
CONTROL = {'role': 'main', 'run': 'control-00000000-0000-4000-8000-000000000001'}
WORKER = {'worker': 'worker-1'}


class ProjectBehavior(ResearchTests):
    def test_same_project_result(self):
        def result(response):
            self.assertIs(response['ok'], True, response)
            return response['result']

        def overview():
            view = result(self.call('dashboard_memory', {'view': 'overview'}, **CONTROL))
            self.assertEqual(view['projectId'], 'project-a')
            self.assertEqual(view['data']['project'], 'project-a')
            return view['data']['facts']

        # A fresh, empty fixture project; no seeded fact or pre-existing dataDir.
        self.assertEqual(result(self.call('fact_list', **WORKER))['facts'], [])
        counts = [overview()]
        denied = self.call('fact_submit', CANDIDATE, **WORKER)
        self.assertIs(denied['ok'], False)
        self.assertEqual(denied['error']['code'], 'verification_required')
        counts.append(overview())
        verified = self.submission(CANDIDATE, **WORKER)  # Real precheck, synthetic verifier report.
        counts.append(overview())
        accepted = r.dispatch(self.data, verified)
        self.assertIs(result(accepted)['accepted'], True)
        self.assertEqual(result(accepted)['fact_id'], FACT_ID)
        counts.append(overview())

        # Same request replay, then a distinct request for the same verified content.
        self.assertEqual(r.dispatch(self.data, verified), accepted)
        duplicate = {**copy.deepcopy(verified), 'requestId': self.request('fact_submit')['requestId']}
        repeated = result(r.dispatch(self.data, duplicate))
        self.assertIs(repeated['accepted'], True)
        self.assertEqual(repeated['fact_id'], FACT_ID)
        counts.append(overview())
        self.assertEqual(counts, [0, 0, 0, 1, 1])

        fact = result(self.call('fact_get', {'fact_id': FACT_ID}, **WORKER))
        body = f"{CANDIDATE['statement']}\n\n## proof\n{CANDIDATE['proof']}\n"
        self.assertEqual(fact['fact_id'], FACT_ID)
        # Check the full Markdown body literally, including interior whitespace.
        self.assertEqual(fact['markdown'].partition('\n## statement\n')[2], body)
        self.assertEqual(result(self.call('fact_list', **WORKER))['facts'], [fact])
        view = result(self.call('dashboard_factgraph', **CONTROL))
        self.assertEqual(view['projectId'], 'project-a')
        self.assertEqual(len(view['graph']['nodes']), 1)
        node = view['graph']['nodes'][0]
        self.assertEqual({k: node[k] for k in ('id', 'statement', 'proof')}, {'id': FACT_ID, **CANDIDATE})
        # Deterministic comparison payload. Omit timestamps, paths and request UUIDs.
        self.receipt = {'projectId': view['projectId'], 'unverifiedError': denied['error']['code'],
                        'overviewFacts': counts, 'fact': {k: node[k] for k in ('id', 'statement', 'proof')},
                        'replay': 'same-receipt', 'duplicateFactId': repeated['fact_id']}


if __name__ == '__main__':
    case = ProjectBehavior('test_same_project_result')
    run = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([case]))
    if not run.wasSuccessful():
        raise SystemExit(1)
    print(json.dumps(case.receipt, sort_keys=True, ensure_ascii=True))
