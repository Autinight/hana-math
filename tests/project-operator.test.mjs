import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerMathResearch } from '../packages/hana-math/research-tools.mjs';
import { fixture, origin, defer, APP } from './helpers/project-service-fixture.mjs';

const other = { callToken: 'fixture-second-caller', sessionPath: '/fixture/other.jsonl' };
const fields = ['name', 'language', 'timezone', 'notifications', 'spendWarningUsd', 'workerRoster'];
const problem = 'Synthetic independent problem.\r\n';
const fallback = 'Hana Math project.';
const profilePath = 'research/operator-profile.json';
const sideEffects = ['tasks', 'schedules', 'unschedules', 'sessions', 'sends', 'starts', 'stops', 'factories', 'core', 'literature'];

async function app(t) {
  const f = await fixture(t, { multiWorker: true });
  f.host.set(other.sessionPath, { ...f.host.get(origin.sessionPath), path: other.sessionPath, sessionId: 'other-stable' });
  const create = f.sdk.tasks.create;
  const unexpected = [];
  const forbidden = name => () => { unexpected.push(name); throw new Error(`unexpected ${name}`); };
  f.sdk.models.stream = forbidden('models.stream');
  f.sdk.models.utility = forbidden('models.utility');
  // Preferences must not use tasks, even for identity. Only the existing create
  // path is allowed to obtain a synthetic Host setup receipt, including for B.
  f.sdk.tasks.create = async input => {
    if (input.scope !== 'session' || input.delivery !== 'next-step' || input.handlerKey !== 'math-project-setup') {
      return forbidden('non-setup tasks.create')();
    }
    if (input.callToken === origin.callToken) return create(input);
    f.calls.tasks.push(input);
    if (input.callToken !== other.callToken) throw Object.assign(new Error('fixture token rejected'), { code: 'APP_CALL_TOKEN_INVALID' });
    assert.equal(Object.hasOwn(input, 'parentSessionPath'), false);
    assert.equal(Object.hasOwn(input, 'parentSessionId'), false);
    const row = { ...input, pluginId: APP, taskId: `task-${f.tasks.size + 1}`, status: 'pending',
      parentSessionId: 'other-stable', parentSessionPath: other.sessionPath };
    f.tasks.set(row.taskId, row);
    return structuredClone(row);
  };
  const unusedResearch = Object.fromEntries(['run', 'status', 'setupStatus', 'setToolMode', 'result', 'stop', 'invoke', 'recordSubmissionInputRejection']
    .map(key => [key, forbidden(`research.${key}`)]));
  let registration, tool;
  async function register() {
    registration = await registerMathResearch({ ...f.sdk, tools: { async register(value) {
      if (value.name === 'math_project') tool = value;
      return () => {};
    } } }, unusedResearch, f.service);
  }
  await register();
  t.after(async () => registration.dispose());
  async function reopen() {
    await registration.dispose();
    await f.service.dispose();
    await f.open();
    await register();
  }
  // Pass a single Host-shaped invocation to the actual registered tool. No
  // real model, transcript, Host task, or app session is started by this fixture.
  const execute = (input, context = origin) => tool.execute({ ...input, context });
  async function ok(input, context = origin) {
    const result = await execute(input, context);
    assert.equal(result.isError, false, JSON.stringify(result.details));
    return result.details;
  }
  async function refused(input, code, context = origin) {
    const result = await execute(input, context);
    assert.equal(result.isError, true, JSON.stringify(result.details));
    assert.equal(result.details.error.code, code);
    return result.details.error;
  }
  const read = ctx => ok({ action: 'operator_read' }, ctx);
  const save = (answers, ctx) => ok({ action: 'operator_save', answers }, ctx);
  const createInput = { action: 'create', problem };
  const queue = (input, ctx) => ok({ ...createInput, ...input }, ctx);
  async function dispatch(projectId, ctx = origin) {
    const done = defer();
    f.completions.set(projectId, done);
    const schedule = [...f.schedules.values()].find(row => row.payload.projectId === projectId);
    assert.ok(schedule);
    assert.equal((await f.handlers.get(schedule.handlerKey).run({ kind: 'schedule', scheduleId: schedule.scheduleId, input: schedule.payload })).status, 'started');
    await done.promise;
    assert.equal((await f.service.status(projectId, ctx)).state, 'ready');
  }
  const counts = () => Object.fromEntries(sideEffects.map(key => [key, f.calls[key].length]));
  const assertQuiet = before => { assert.deepEqual(counts(), before); assert.deepEqual(unexpected, []); };
  const profile = path.join(f.dataDir, profilePath);
  return { f, tool: () => tool, refused, read, save, queue, dispatch, createInput, reopen, counts, assertQuiet, profile };
}

async function assertFiles(dataDir, projectId, expected, roles = ['main', 'workers/worker-1']) {
  for (const role of roles) {
    const dir = path.join(dataDir, 'context/projects', projectId, role);
    assert.deepEqual(await fs.readFile(path.join(dir, 'OPERATOR.md')), Buffer.from(expected), role);
    assert.deepEqual(await fs.readFile(path.join(dir, 'PROBLEM.md')), Buffer.from(problem), role);
  }
}

async function seedLegacy(dataDir) {
  const dir = path.join(dataDir, 'research/operator-profiles');
  await fs.mkdir(dir, { recursive: true });
  const entries = await Promise.all(['creator-stable', 'other-stable'].map(async (id, i) => {
    const file = path.join(dir, `${createHash('sha256').update(id).digest('hex')}.json`);
    const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, answers: { name: `LEGACY_ONLY_${i}` } }, null, 2)}\n`);
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const stat = await fs.stat(file, { bigint: true });
    return { file, bytes, stat };
  }));
  return async () => {
    assert.deepEqual((await fs.readdir(dir)).sort(), entries.map(row => path.basename(row.file)).sort());
    for (const { file, bytes, stat } of entries) {
      const now = await fs.stat(file, { bigint: true });
      for (const key of ['ino', 'mode', 'mtimeNs', 'ctimeNs']) assert.equal(now[key], stat[key], key);
      assert.deepEqual(await fs.readFile(file), bytes);
    }
  };
}

test('operator schemas reject invalid patches; A and B share the single App record, not either legacy archive', async t => {
  const a = await app(t);
  const assertLegacyUnchanged = await seedLegacy(a.f.dataDir);
  const before = a.counts();
  const schema = action => a.tool().parameters.oneOf.find(row => row.properties.action.const === action);
  assert.deepEqual(Object.keys(schema('operator_read').properties), ['action']);
  assert.deepEqual(schema('operator_read').required, ['action']);
  assert.deepEqual(schema('operator_save').required, ['action', 'answers']);
  assert.equal(schema('operator_save').properties.answers.additionalProperties, false);
  assert.deepEqual(Object.keys(schema('operator_save').properties.answers.properties), fields);
  const empty = await a.read();
  assert.equal(empty.scope, 'app');
  assert.deepEqual(empty.fields, fields);
  assert.deepEqual(empty.answers, {});
  assert.equal(empty.operatorProfile, null);
  assert.deepEqual(await a.read(other), empty);
  await fs.access(a.profile).then(() => assert.fail('empty read created a profile'), error => assert.equal(error.code, 'ENOENT'));
  const saved = await a.save({ name: 'Address me as A', language: 'English', spendWarningUsd: 12 });
  assert.match(saved.operatorProfile, /warning only; not a hard stop/);
  assert.deepEqual(await a.read(other), saved);
  const patched = await a.save({ timezone: 'UTC', name: null, spendWarningUsd: 0 }, other);
  assert.deepEqual(patched.answers, { language: 'English', spendWarningUsd: 0, timezone: 'UTC' });
  assert.deepEqual(await a.read(), patched);
  const bytes = await fs.readFile(a.profile);
  for (const input of [
    { action: 'operator_read', owner: 'other' }, { action: 'operator_read', sessionPath: other.sessionPath },
    { action: 'operator_read', callToken: other.callToken }, { action: 'operator_save' },
    ...[{}, null, [], { owner: 'other' }, { language: 'line\nbreak' }, { timezone: ' ' },
      { notifications: true }, { spendWarningUsd: -1 }, { spendWarningUsd: '1' }].map(answers => ({ action: 'operator_save', answers })),
  ]) await a.refused(input, 'RESEARCH_TOOL_INVALID_INPUT');
  assert.deepEqual(await fs.readFile(a.profile), bytes);
  assert.equal((await fs.stat(a.profile)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(bytes), { schemaVersion: 1, answers: patched.answers });
  assert.deepEqual((await fs.readdir(path.dirname(a.profile))).filter(name => name.startsWith('operator-profile')).sort(),
    ['operator-profile.json', 'operator-profiles']);
  await a.reopen();
  assert.deepEqual(await a.read(other), patched);
  const cleared = await a.save({ language: null, spendWarningUsd: null, timezone: null }, other);
  assert.deepEqual(cleared.answers, {});
  assert.equal(cleared.operatorProfile, null);
  assert.deepEqual(await a.read(), cleared);
  await assertLegacyUnchanged();
  a.assertQuiet(before);
});

test('operator read and save require trusted tool context and reject App-owned sessions without task or model activity', async t => {
  const a = await app(t);
  const before = a.counts();
  const saved = await a.save({ name: 'PRIVATE_PROFILE_SENTINEL' });
  for (const input of [{ action: 'operator_read' }, { action: 'operator_save', answers: { name: 'unauthorized' } }]) {
    await a.refused(input, 'HOST_CONTEXT_REQUIRED', null);
    await a.refused(input, 'CALLER_UNBOUND', { sessionPath: origin.sessionPath });
    await a.refused(input, 'CALLER_UNBOUND', { callToken: origin.callToken });
  }
  for (const [role, namespace, lifecycle] of [
    ['main', 'home', 'active'], ['worker', 'app', 'active'], ['verifier', 'app', 'active'], ['report-writer', 'app', 'archived'],
  ]) {
    const ctx = { callToken: `fixture-${role}`, sessionPath: `/fixture/${role}.jsonl` };
    a.f.host.set(ctx.sessionPath, { sessionId: `fixture-${role}`, path: ctx.sessionPath, namespace, ownerPluginId: APP,
      lifecycle, visibility: namespace === 'home' ? 'public' : 'plugin_private' });
    for (const input of [{ action: 'operator_read' }, { action: 'operator_save', answers: { name: 'unauthorized' } }]) {
      const error = await a.refused(input, 'PROJECT_OPERATOR_DENIED', ctx);
      assert.deepEqual(Object.keys(error).sort(), ['code', 'message']);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_PROFILE_SENTINEL|callToken|\/fixture\//);
    }
    await a.refused(a.createInput, 'PROJECT_CREATOR_DENIED', ctx);
  }
  assert.deepEqual(await a.read(other), saved);
  a.assertQuiet(before);
});

test('concurrent cross-conversation patches do not lose fields or escape their App data directory', async t => {
  const a = await app(t), isolated = await app(t);
  const before = a.counts(), isolatedBefore = isolated.counts();
  const expected = { name: 'Synthetic operator', language: '中文', timezone: 'UTC', notifications: 'quiet', spendWarningUsd: 12, workerRoster: 'Ask later' };
  const writes = Object.entries(expected).map(([key, value], i) => a.save({ [key]: value }, i % 2 ? other : origin));
  await Promise.all([...writes, isolated.save({ name: 'Isolated profile' }, other)]);
  assert.deepEqual((await a.read(other)).answers, expected);
  assert.deepEqual((await isolated.read()).answers, { name: 'Isolated profile' });
  await a.reopen();
  assert.deepEqual((await a.read()).answers, expected);
  assert.deepEqual(JSON.parse(await fs.readFile(a.profile)), { schemaVersion: 1, answers: expected });
  a.assertQuiet(before);
  isolated.assertQuiet(isolatedBefore);
});

test('create inherits the App profile after existing admission, snapshots at enqueue, and leaves older projects untouched', { timeout: 15000 }, async t => {
  const a = await app(t), { f } = a;
  const assertLegacyUnchanged = await seedLegacy(f.dataDir);
  const old = await a.queue(undefined, other);
  await a.dispatch(old.projectId, other);
  await assertFiles(f.dataDir, old.projectId, fallback);

  const quiet = a.counts();
  const v1 = await a.save({ language: 'English', spendWarningUsd: 12 });
  a.assertQuiet(quiet);
  const newer = await a.queue({ workers: 2 }, other);
  const queued = a.counts();
  const v2 = await a.save({ language: '简体中文', spendWarningUsd: 27 }, other);
  a.assertQuiet(queued);
  const newest = await a.queue(undefined, origin);
  const explicitText = '  Opaque explicit\r\n';
  const explicit = await a.queue({ operatorProfile: explicitText }, other);
  await a.dispatch(newer.projectId, other);
  await a.dispatch(newest.projectId, origin);
  await a.dispatch(explicit.projectId, other);
  await assertFiles(f.dataDir, newer.projectId, v1.operatorProfile, ['main', 'workers/worker-1', 'workers/worker-2']);
  await assertFiles(f.dataDir, newest.projectId, v2.operatorProfile);
  await assertFiles(f.dataDir, explicit.projectId, explicitText);
  await assertFiles(f.dataDir, old.projectId, fallback);
  await assertLegacyUnchanged();
  assert.equal(f.calls.sends.length, 4, 'only original synthetic create/setup sends');
  assert.equal(f.calls.tasks.length, 4);
  assert.ok(f.calls.tasks.every(row => row.scope === 'session' && row.delivery === 'next-step' && row.handlerKey === 'math-project-setup'));
  assert.deepEqual(f.calls.starts, []);
});

test('a mismatched Host create receipt cannot enqueue setup even with a saved or explicit profile', async t => {
  const a = await app(t), { f } = a;
  await a.save({ name: 'PRIVATE_PROFILE_SENTINEL' });
  const bytes = await fs.readFile(a.profile);
  const mismatch = { ...origin, callToken: other.callToken };
  for (const input of [a.createInput, { ...a.createInput, operatorProfile: 'Explicit must not bypass admission' }]) {
    const error = await a.refused(input, 'PROJECT_CREATOR_UNCONFIRMED', mismatch);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_PROFILE_SENTINEL/);
  }
  assert.equal(f.calls.tasks.length, 2, 'unchanged create still asks for its Host receipt');
  for (const key of ['schedules', 'sessions', 'sends', 'starts', 'factories', 'core']) assert.deepEqual(f.calls[key], [], key);
  assert.deepEqual(await fs.readFile(a.profile), bytes);
});
