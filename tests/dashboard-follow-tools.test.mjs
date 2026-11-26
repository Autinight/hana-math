import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';

const projectId = 'project-fixture';
const context = Object.freeze({ sessionPath: '/fixture/original.jsonl', callToken: 'opaque-host-invocation' });
const actions = [
  ['dashboard_follow', 'dashboardFollow', 'PROJECT_DASHBOARD_FOLLOW_UNAVAILABLE'],
  ['dashboard_unfollow', 'dashboardUnfollow', 'PROJECT_DASHBOARD_UNFOLLOW_UNAVAILABLE'],
];

async function fixture(t) {
  const calls = [], definitions = new Map();
  const uncalled = () => assert.fail('must not route to another operation');
  const stubs = names => Object.fromEntries(names.map(name => [name, uncalled]));
  const research = stubs(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection']);
  const projects = stubs(['create', 'list', 'status', 'assign', 'start', 'stop', 'result', 'invoke', 'handles', 'goal', 'mainGoal']);
  for (const [action, method] of actions) projects[method] = async function (...args) {
    assert.equal(this, projects); assert.equal(args.length, 2);
    calls.push([method, args[0], args[1]]);
    return { projectId, state: action === 'dashboard_follow' ? 'following' : 'unfollowed' };
  };
  const sdk = { dataDir: '/unused-dashboard-follow-tool-fixture', tools: { async register(definition) {
    definitions.set(definition.name, definition);
    return () => definitions.delete(definition.name);
  } } };
  const registration = await registerMathResearch(sdk, research, projects);
  t.after(() => registration.dispose());
  return { tool: definitions.get('math_project'), projects, calls };
}

test('math_project follow actions have exact schemas and advertise explicit local consent', async t => {
  const { tool } = await fixture(t);
  const { parameters, description } = tool;
  for (const [action] of actions) {
    assert.ok(parameters.properties.action.enum.includes(action));
    const variants = parameters.oneOf.filter(row => row.properties.action.const === action);
    assert.equal(variants.length, 1);
    assert.deepEqual(variants[0], { type: 'object', additionalProperties: false,
      required: ['action', 'projectId'], properties: { action: { const: action }, projectId: parameters.properties.projectId } });
    assert.ok(description.includes(action));
  }
  assert.match(description, /explicit request in the original project-creation conversation/);
  assert.match(description, /local Σ.*across restarts/);
  assert.match(description, /Never infer consent or migrate an older project without it/);
  assert.match(description, /do not select an arbitrary dashboard target, start, stop or resume a Goal or worker, or change \.hanamathboard document permissions/);
  const readme = await readFile(new URL('../packages/hana-math/README.md', import.meta.url), 'utf8');
  for (const text of ['math_project dashboard_follow', 'dashboard_unfollow', '只传 `projectId`', '授权不启动、停止或恢复研究']) assert.ok(readme.includes(text));
});

test('follow and unfollow forward only projectId and the original Host context', async t => {
  const { tool, calls } = await fixture(t);
  for (const [action, method] of actions) {
    const result = await tool.execute({ action, projectId, context });
    assert.equal(result.isError, false);
    const expected = { projectId, state: action === 'dashboard_follow' ? 'following' : 'unfollowed' };
    assert.deepEqual(result.details, expected);
    assert.deepEqual(JSON.parse(result.content[0].text), expected);
    assert.equal(calls.at(-1)[0], method);
    assert.deepEqual(calls.at(-1)[1], { projectId });
    assert.equal(calls.at(-1)[2], context);
  }
  assert.equal(calls.length, 2);
});

test('invalid controls, missing services and creator denials cannot fall back', async t => {
  const { tool, projects, calls } = await fixture(t);
  for (const [action, method, unavailable] of actions) {
    for (const args of [{}, { projectId: '../other' }, { projectId: null }, { projectId: 'project-fixture\n' },
      ...Object.entries({ workerId: 'worker-1', runId: 'run-fixture', generation: 1, authorized: true, force: true, document: 'opaque', sessionPath: '/fixture/other' })
        .map(([key, value]) => ({ projectId, [key]: value }))]) {
      const refused = await tool.execute({ action, ...args, context });
      assert.equal(refused.isError, true);
      assert.equal(refused.details.error.code, 'RESEARCH_TOOL_INVALID_INPUT');
    }
    assert.equal((await tool.execute({ action, projectId })).details.error.code, 'HOST_CONTEXT_REQUIRED');
    projects[method] = async () => { throw Object.assign(new Error('opaque creator denial'), { code: 'PROJECT_OWNER_DENIED' }); };
    const denied = await tool.execute({ action, projectId, context });
    assert.equal(denied.isError, true); assert.equal(denied.details.error.code, 'PROJECT_OWNER_DENIED');
    delete projects[method];
    const missing = await tool.execute({ action, projectId, context });
    assert.equal(missing.isError, true); assert.equal(missing.details.error.code, unavailable);
  }
  assert.deepEqual(calls, []);
});
