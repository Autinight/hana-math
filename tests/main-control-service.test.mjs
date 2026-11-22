import test from 'node:test';
import { readExplorerContract } from '../packages/hana-math/explorer-profile.mjs';
import assert from 'node:assert/strict';
import { createMainControlService, MAIN_CONTROL_INTERVAL_MS as BEAT, MAIN_CONTROL_AUDIT_MS as AUDIT } from '../packages/hana-math/main-control-service.mjs';

const PROJECT = 'project-opaque', APP = 'hana-math', HANDLER = 'math-project-main-control', BASE = 'research/main-controls';
const BINDING = { sessionId: 'opaque-main', sessionPath: '/fixture/main.jsonl', agentId: 'saved-main', cwd: '/fixture/project/main', kind: 'math-main', identityConfirmed: true };
const turn = () => new Promise(setImmediate);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(predicate) { for (let i = 0; i < 2000; i++) { if (await predicate()) return; await turn(); } assert.fail('Opaque fixture did not settle'); }
async function flush() { for (let i = 0; i < 12; i++) await turn(); }
function fakeClock(at = 1000000) {
  let value = at, id = 0; const timers = new Map();
  return { now: () => value, setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: value + ms }); return key; }, clearTimeout(key) { timers.delete(key); },
    jump(at) { value = at; }, tick(ms) { value += ms; for (const [key, timer] of [...timers]) if (timer.at <= value && timers.has(key)) { timers.delete(key); timer.fn(); } }, timers };
}
async function fixture(t, behavior = {}, seed = {}) {
  const clock = fakeClock(seed.now), files = new Map(seed.files || []), schedules = new Map(seed.schedules || []), calls = [], callbacks = [], writes = [], releases = [];
  const creator = Object.freeze({ callToken: 'opaque-creator-token', sessionPath: '/fixture/creator.jsonl' });
  const main = Object.freeze({ callToken: 'opaque-main-token', sessionPath: BINDING.sessionPath });
  let listener = null, handler = null, nextSchedule = schedules.size, service;
  const call = (name, input) => { calls.push({ name, input: input === undefined ? undefined : structuredClone(input) }); };
  const store = { async mkdir(name) { assert.equal(name, BASE); }, async list(name) { assert.equal(name, BASE); return [...files.keys()].filter(k => k.startsWith(BASE + '/')).map(k => k.slice(BASE.length + 1)); },
    async readJson(name) { assert.ok(files.has(name)); const record = JSON.parse(files.get(name)); behavior.read?.(record, name); return record; },
    async write(name, packet, replace) { assert.equal(replace, true); const record = JSON.parse(packet); if (behavior.write) await behavior.write(record, name); files.set(name, packet); writes.push(structuredClone(record)); } };
  const row = { ...BINDING, path: BINDING.sessionPath, ownerPluginId: APP, visibility: 'public', namespace: 'home', lifecycle: 'active' };
  const unexpected = name => () => assert.fail('Unexpected live/privileged operation: ' + name);
  const sdk = { dataDir: '/fixture/unused-data',
    sessions: {
      async get(ref) { call('get', ref); assert.equal(ref.sessionId, BINDING.sessionId); if (behavior.get) return behavior.get(ref); return { session: { ...row } }; },
      async list(input) { call('list', input); assert.equal(input.scope, 'own'); return { sessions: [{ ...row }] }; },
      async send(input) { call('send', input); if (behavior.send) return behavior.send(input, calls.filter(c => c.name === 'send').length); return { accepted: true, sessionId: BINDING.sessionId, sessionPath: BINDING.sessionPath }; },
      create: unexpected('sessions.create'), abort: unexpected('sessions.abort'), context: unexpected('sessions.context'), setActiveTools: unexpected('sessions.setActiveTools'),
    },
    tasks: {
      async registerHandler(key, value) { call('registerHandler', { key }); assert.equal(key, HANDLER); handler = value; const dispose = () => call('disposeHandler');
        dispose.ready = Promise.resolve(); dispose.disposeAsync = async () => { await behavior.disposeHandler?.(); dispose(); }; return dispose; },
      async schedule(input) { call('schedule', input); assert.equal(input.scope, 'app'); assert.equal(Object.hasOwn(input, 'callToken'), false); assert.equal(Object.hasOwn(input, 'delivery'), false);
        const record = { ...structuredClone(input), scheduleId: 'alarm-' + (++nextSchedule), pluginId: APP, enabled: true, intervalMs: null };
        schedules.set(record.scheduleId, record); if (behavior.schedule) await behavior.schedule(record); return structuredClone(record); },
      async getSchedule(id) { call('getSchedule', { id }); if (behavior.getSchedule) await behavior.getSchedule(id); return schedules.has(id) ? structuredClone(schedules.get(id)) : null; },
      async unschedule(id) { call('unschedule', { id }); if (behavior.unschedule) await behavior.unschedule(id);
        if (!schedules.delete(id)) throw Object.assign(new Error('Host delete is not idempotent'), { code: 'APP_HOST_ERROR' }); return { ok: true }; },
      create: unexpected('tasks.create'), complete: unexpected('tasks.complete'), fail: unexpected('tasks.fail'),
    },
    bus: { async subscribe(callback, filter) { call('subscribe', filter); assert.equal(filter.sessionPath, BINDING.sessionPath); listener = callback;
      if (behavior.subscribe) await behavior.subscribe(callback, filter);
      const dispose = () => { call('unsubscribe'); listener = null; }; dispose.ready = Promise.resolve(); return dispose; } },
  };
  const dependencies = { store, clock,
    captureWorkerStopScope(input) {
      callbacks.push({ name: 'captureWorkerStopScope', input });
      return behavior.capture ? behavior.capture(input) : { targets: [{ workerId: 'worker-1', runId: null, complete: true }] };
    },
    observeWorkerStopScope(input) {
      callbacks.push({ name: 'observeWorkerStopScope', input });
      if (behavior.observe) return behavior.observe(input);
      return { projectId: input.projectId, targets: input.scope.targets.map(target => ({ ...target, state: 'settled', reasons: [] })) };
    },
    async recoveryReadiness(input) {
      assert.deepEqual(Object.keys(input).sort(), ['main', 'projectId']);
      callbacks.push({ name: 'recoveryReadiness', input: structuredClone(input) });
      if (behavior.recoveryReadiness) return behavior.recoveryReadiness(input);
      return { ready: true };
    },
    async authorize(ctx, input) { callbacks.push({ name: 'authorize', ctx, input }); assert.equal(Object.hasOwn(input, 'actor'), false);
      if (behavior.authorize) await behavior.authorize(ctx, input); return ctx === creator ? 'creator' : ctx === main ? 'main' : 'outsider'; },
    async getMainBinding(ctx, input) { callbacks.push({ name: 'binding', ctx, input }); assert.strictEqual(ctx, creator);
      if (behavior.getMainBinding) await behavior.getMainBinding(input); return { ...BINDING, ...(behavior.binding || {}), toolSelection: behavior.toolSelection ?? {
        requested: ['subagent', 'subagent_reply', 'subagent_message', 'subagent_close'], exploration: { state: 'available' } } }; },
    async verifyCompletion(ctx, input) { callbacks.push({ name: 'verify', ctx, input }); assert.strictEqual(ctx, main); return behavior.verify ? behavior.verify(input) : { verified: true, projectId: input.projectId, factIds: [...input.factIds] }; },
    async stopWorkers(ctx, input) { callbacks.push({ name: 'stopWorkers', ctx, input }); assert.ok(ctx === creator || ctx === main); return behavior.stopWorkers ? behavior.stopWorkers(input) : { requested: true, cleanupPending: false }; },
  };
  service = await createMainControlService(sdk, dependencies);
  t.after(async () => { for (const release of releases) release(); await flush(); await service.dispose(); });
  const f = { service, sdk, store, files, schedules, calls, callbacks, writes, clock, creator, main,
    gate() { const gate = deferred(); releases.push(() => gate.resolve()); return gate; },
    status: () => service.status({ projectId: PROJECT }, creator),
    args: s => ({ projectId: PROJECT, goalId: s.goalId, generation: s.generation }),
    count: name => calls.filter(c => c.name === name).length,
    emit(data, source = BINDING.sessionPath) { return listener?.(data, source); },
    end(patch = {}) { const message = { role: 'assistant', stopReason: 'stop' }; Object.defineProperty(message, 'content', { get() { assert.fail('Do not read private message content'); } });
      return listener?.({ type: 'agent_end', messages: [message], ...patch }, BINDING.sessionPath); },
    fire(id, patch = {}) { const record = schedules.get(id); assert.ok(record); return handler.run({ kind: 'schedule', scheduleId: id, input: structuredClone(record.payload), ...patch }); },
    rawHandler: event => handler.run(event),
    async settled() { await until(async () => { const s = await f.status(); return !s.sendInFlight && s.send?.state === 'accepted'; }); await flush(); return f.status(); },
    async start(options = {}) { await service.start({ projectId: PROJECT, authorized: true, ...options }, creator); return f.settled(); },
    async ack() { const s = await f.status(), args = f.args(s); for (const k of ['control', 'audit']) if (s.due[k]) args[k + 'At'] = s.due[k].at; return service.acknowledge(args, main); },
  };
  return f;
}

test('explicit creator authorization; real ctx only; public actor/SID/token overrides are rejected without writes', async t => {
  const f = await fixture(t); const valid = { projectId: PROJECT, authorized: true };
  await assert.rejects(f.service.start(valid, f.main), { code: 'MAIN_CONTROL_FORBIDDEN' });
  await assert.rejects(f.service.start(valid, { ...f.creator }), { code: 'MAIN_CONTROL_FORBIDDEN' });
  await assert.rejects(f.service.start({ ...valid, authorized: false }, f.creator), { code: 'MAIN_CONTROL_AUTHORIZATION_REQUIRED' });
  for (const key of ['actor', 'sessionId', 'main', 'context', 'callToken', 'rootTask']) await assert.rejects(f.service.start({ ...valid, [key]: 'forged' }, f.creator), { code: 'MAIN_CONTROL_INVALID_INPUT' });
  assert.equal(f.files.size, 0); assert.equal(f.count('schedule'), 0); assert.equal(f.count('send'), 0);
  const state = await f.start(); assert.equal(state.state, 'active');
  const binding = f.callbacks.find(c => c.name === 'binding'); assert.strictEqual(binding.ctx, f.creator);
  const packet = [...f.files.values()].join(''); assert.doesNotMatch(packet, /opaque-creator-token|opaque-main-token|callToken/);
  await assert.rejects(f.service.start(valid, f.creator), { code: 'MAIN_CONTROL_ALREADY_EXISTS' });
});

test('start immediately delivers both reviews to the saved SID, using steer but no task-delivery semantics', async t => {
  const f = await fixture(t), n = f.clock.now(); const s = await f.start();
  assert.equal(s.due.control.at, n); assert.equal(s.due.audit.at, n); assert.equal(s.ack.control, null); assert.equal(s.lastAuditAt, null);
  assert.equal(s.nextControlAt, n + BEAT); assert.equal(s.nextAuditAt, n + AUDIT);
  assert.equal(s.send.state, 'accepted'); assert.equal(f.count('send'), 1);
  const sent = f.calls.find(c => c.name === 'send').input;
  assert.deepEqual(Object.keys(sent).sort(), ['deliverAs', 'sessionId', 'text']); assert.equal(sent.deliverAs, 'steer'); assert.equal(sent.sessionId, BINDING.sessionId);
  assert.match(sent.text, /Exploratory subagents are for speculative text-only mathematics/);
  assert.equal(f.count('subscribe'), 1); assert.equal(f.count('schedule'), 1);
  assert.equal(f.calls.find(c => c.name === 'schedule').input.runAt, n + BEAT);
});

test('Goal continuation binds explicit explorer config; legacy children are not reassigned on resume', async t => {
  const contract = await readExplorerContract(), explorer = { schemaVersion: 1, state: 'available', role: 'explorer', agentId: 'hana-math-explorer', model: { provider: 'fixture', id: 'explorer-model' }, contract: { ...contract.binding, configuredIdentitySha256: 'a'.repeat(64), configuredContractSha256: 'b'.repeat(64) } };
  const f = await fixture(t, { binding: { explorer } }); await f.start(); await f.settled();
  const prompt = f.calls.find(c => c.name === 'send').input.text;
  assert.match(prompt, /"agent":"hana-math-explorer"/); assert.match(prompt, /"model":"fixture\/explorer-model"/); assert.match(prompt, /actual child.model evidence|actual child model remain unverified/);
  assert.match(prompt, /never relabel, replace or replay/i); assert.doesNotMatch(prompt, /omit agent\/model overrides/);
  const old = await fixture(t, { binding: { explorer: undefined } }); await old.start(); await old.settled();
  assert.match(old.calls.find(c => c.name === 'send').input.text, /Explorer persona\/model has not been confirmed/);
  assert.equal(old.count('send'), 1);
});
for (const state of ['available', 'unavailable', 'unknown']) test(`native exploration ${state} prompt survives Goal recovery without claiming extra capability`, async t => {
  const selection = state === 'unknown' ? {} : { requested: state === 'available'
    ? ['subagent', 'subagent_reply', 'subagent_message', 'subagent_close'] : [],
    exploration: { state, errorCode: state === 'unavailable' ? 'APP_HOST_ERROR' : null } };
  const f = await fixture(t, { toolSelection: selection }); await f.start(); await f.ack();
  const firstText = f.calls.find(c => c.name === 'send').input.text;
  assert.match(firstText, state === 'available' ? /Exploratory subagents are for speculative/ : state === 'unavailable'
    ? /Native exploratory subagents are unavailable/ : /availability has not been confirmed/);
  const disk = JSON.parse(f.files.get(BASE + '/' + PROJECT + '.json'));
  assert.equal(disk.main.exploration, state); assert.equal(Object.hasOwn(disk.main, 'toolSelection'), false);
  const seed = { files: new Map(f.files), schedules: new Map(f.schedules), now: f.clock.now() };
  await f.service.dispose();
  const g = await fixture(t, { toolSelection: selection }, seed);
  const recovered = await g.status(); assert.equal(recovered.main.exploration, state);
  assert.equal(recovered.state, 'blocked'); assert.equal(g.count('send'), 0);
  await g.service.resume({ projectId: PROJECT }, g.creator); await g.settled();
  assert.equal(g.count('send'), 1);
  assert.match(g.calls.find(c => c.name === 'send').input.text, state === 'available' ? /Exploratory subagents are for speculative/
    : state === 'unavailable' ? /Native exploratory subagents are unavailable/ : /availability has not been confirmed/);
});

test('30m/4h deadlines stay anchored; missed periods coalesce once, not across every future boundary', async t => {
  const f = await fixture(t), n = f.clock.now(); await f.start(); await f.ack();
  f.emit({ type: 'agent_start' }); await flush(); // Busy main: still the same SID, not a new instance.
  const before = await f.status(); f.clock.jump(n + 2 * AUDIT + 1);
  assert.equal(f.fire(before.alarm.id).status, 'accepted');
  await until(() => f.count('send') === 2); const s = await f.settled();
  assert.equal(s.nextControlAt, n + 2 * AUDIT + BEAT); assert.equal(s.nextAuditAt, n + 3 * AUDIT);
  assert.equal(s.due.control.at, n + 2 * AUDIT); assert.equal(s.due.audit.at, n + 2 * AUDIT);
  assert.equal(f.count('unschedule'), 1);
  const current = await f.status(); f.clock.jump(current.nextControlAt + BEAT);
  assert.equal(f.fire(current.alarm.id).status, 'accepted'); assert.equal(f.fire(current.alarm.id).status, 'ignored');
  await until(() => f.count('unschedule') === 2); await flush();
  assert.equal(f.count('send'), 3, 'A new wall-clock boundary renews the review; the same event does not duplicate it');
  const renewed = await f.settled(); assert.equal(renewed.due.control.at, n + 2 * AUDIT + 2 * BEAT);
  assert.equal(renewed.due.audit.at, n + 2 * AUDIT);
  const anchoredAudit = (await f.status()).nextAuditAt; await f.ack();
  assert.equal((await f.status()).nextAuditAt, anchoredAudit); assert.equal((await f.status()).lastAuditAt, f.clock.now());
});

function pendingReview(f, state) {
  return { ...f.args(state), controlAt: state.due.control?.at ?? null, auditAt: state.due.audit?.at ?? null };
}

test('unacknowledged wait is refused; each next boundary produces one review, never duplicates the same event', async t => {
  const f = await fixture(t), initial = await f.start();
  await assert.rejects(f.service.wait(f.args(initial), f.main), error => {
    assert.equal(error.code, 'MAIN_CONTROL_DUE_UNACKNOWLEDGED'); assert.deepEqual(error.pendingReview, pendingReview(f, initial));
    assert.match(error.message, /substantive.*acknowledge/); return true;
  });
  assert.equal((await f.status()).waiting, false); assert.equal(f.count('send'), 1);
  for (let step = 1; step <= 2; step++) {
    const before = await f.status(), event = { kind: 'schedule', scheduleId: before.alarm.id, input: structuredClone(f.schedules.get(before.alarm.id).payload) };
    f.clock.jump(initial.nextControlAt + (step - 1) * BEAT);
    assert.equal(f.rawHandler(event).status, 'accepted'); assert.equal(f.rawHandler(event).status, 'ignored');
    await until(async () => (await f.status()).nextControlAt > f.clock.now()); await flush();
    assert.equal(f.count('send'), step + 1); const after = await f.settled();
    assert.equal(after.due.control.at, f.clock.now()); assert.equal(after.due.audit.at, initial.due.audit.at);
    assert.equal(after.send.kind, 'review'); assert.equal(f.rawHandler(event).status, 'ignored'); await flush();
    assert.equal(f.count('send'), step + 1);
  }
});

test('wait refuses unnotified pending review too, without cancelling or acknowledging its send', async t => {
  const behavior = {}, f = await fixture(t, behavior), gate = f.gate();
  behavior.send = async () => { await gate.promise; return { accepted: true, sessionPath: BINDING.sessionPath }; };
  await f.service.start({ projectId: PROJECT, authorized: true }, f.creator); await until(() => f.count('send') === 1);
  const before = await f.status(); assert.equal(before.due.control.notified, false);
  await assert.rejects(f.service.wait(f.args(before), f.main), error => {
    assert.equal(error.code, 'MAIN_CONTROL_DUE_UNACKNOWLEDGED'); assert.deepEqual(error.pendingReview, pendingReview(f, before)); return true;
  });
  assert.equal((await f.status()).waiting, false); assert.equal((await f.status()).ack.control, null);
  gate.resolve(); await f.settled(); assert.equal(f.count('send'), 1);
});

test('stale ack refreshes and persists an undelivered wall-clock boundary before rejecting it', async t => {
  const f = await fixture(t), initial = await f.start(); f.clock.jump(initial.nextControlAt + 2 * BEAT + 7);
  await assert.rejects(f.service.acknowledge({ ...f.args(initial), controlAt: initial.due.control.at }, f.main), { code: 'MAIN_CONTROL_ACK_MISMATCH' });
  const after = await f.status(), disk = JSON.parse(f.files.get(BASE + '/' + PROJECT + '.json'));
  assert.equal(after.due.control.at, initial.nextControlAt + 2 * BEAT); assert.equal(after.due.control.notified, false);
  assert.equal(after.nextControlAt, initial.nextControlAt + 3 * BEAT); assert.equal(after.ack.control, null);
  assert.deepEqual(disk.due, after.due); assert.equal(disk.nextControlAt, after.nextControlAt);
  await f.ack(); assert.equal((await f.service.wait(f.args(after), f.main)).waiting, true);
  assert.equal((await f.service.continue_work(f.args(after), f.main)).waiting, false);
});

for (const action of ['acknowledge', 'wait']) test(`${action} authorization crossing a boundary cannot clear or sleep through the new review`, async t => {
  const behavior = {}, f = await fixture(t, behavior), initial = await f.start();
  if (action === 'wait') await f.ack();
  const entered = f.gate(), release = f.gate(); behavior.authorize = async (_ctx, input) => { if (input.action === action) { entered.resolve(); await release.promise; } };
  const args = { ...f.args(initial), ...(action === 'acknowledge' ? { controlAt: initial.due.control.at } : {}) };
  const outcome = f.service[action](args, f.main).then(value => ({ value }), error => ({ error }));
  await entered.promise; f.clock.jump(initial.nextControlAt + BEAT + 3); release.resolve(); const result = await outcome;
  assert.equal(result.error?.code, action === 'wait' ? 'MAIN_CONTROL_DUE_UNACKNOWLEDGED' : 'MAIN_CONTROL_ACK_MISMATCH');
  const state = await f.status(), disk = JSON.parse(f.files.get(BASE + '/' + PROJECT + '.json'));
  assert.equal(state.due.control.at, initial.nextControlAt + BEAT); assert.deepEqual(disk.due, state.due); assert.equal(state.waiting, false);
  if (action === 'wait') assert.deepEqual(result.error.pendingReview, pendingReview(f, state));
});

for (const action of ['acknowledge', 'wait']) test(`${action} rechecks the epoch after refreshed-due persistence, retaining new due across pause`, async t => {
  const behavior = {}, f = await fixture(t, behavior), initial = await f.start(); f.clock.jump(initial.nextControlAt);
  const entered = f.gate(), release = f.gate(); let first = true;
  behavior.write = async () => { if (first) { first = false; entered.resolve(); await release.promise; } };
  const args = { ...f.args(initial), ...(action === 'acknowledge' ? { controlAt: initial.due.control.at } : {}) };
  const outcome = f.service[action](args, f.main).then(value => ({ value }), error => ({ error }));
  await entered.promise; const pausing = f.service.pause({ projectId: PROJECT }, f.creator);
  await until(async () => (await f.status()).state === 'paused'); release.resolve(); const result = await outcome; await pausing;
  assert.equal(result.error?.code, 'MAIN_CONTROL_STALE'); const after = await f.status();
  assert.equal(after.state, 'paused'); assert.equal(after.due.control.at, initial.nextControlAt); assert.equal(after.ack.control, null); assert.equal(f.count('send'), 1);
});

test('wait refreshes again when another boundary passes while the first refresh write is held', async t => {
  const behavior = {}, f = await fixture(t, behavior), initial = await f.start(); f.clock.jump(initial.nextControlAt);
  const entered = f.gate(), release = f.gate(); let first = true;
  behavior.write = async () => { if (first) { first = false; entered.resolve(); await release.promise; } };
  const outcome = f.service.wait(f.args(initial), f.main).then(value => ({ value }), error => ({ error }));
  await entered.promise; f.clock.jump(initial.nextControlAt + 2 * BEAT); release.resolve(); const result = await outcome;
  assert.equal(result.error?.code, 'MAIN_CONTROL_DUE_UNACKNOWLEDGED'); const after = await f.status();
  assert.equal(result.error.pendingReview.controlAt, f.clock.now()); assert.equal(after.nextControlAt, f.clock.now() + BEAT);
  assert.deepEqual(JSON.parse(f.files.get(BASE + '/' + PROJECT + '.json')).due, after.due); assert.equal(after.waiting, false);
});

for (const delivery of ['before-refresh-release', 'after-ack-rejection']) test(`ACK(B) held in refresh persistence rejects C in the same epoch; alarm delivery ${delivery}`, async t => {
  const behavior = {}, f = await fixture(t, behavior), initial = await f.start(); await f.ack();
  const B = initial.nextControlAt, C = B + BEAT, entered = f.gate(), release = f.gate(); let refreshing;
  behavior.write = async record => {
    if (!refreshing && record.due.control?.at === B) { refreshing = record; entered.resolve(); await release.promise; }
  };
  f.clock.jump(B);
  const acknowledgement = f.service.acknowledge({ ...f.args(initial), controlAt: B }, f.main).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  const duringB = await f.status(); assert.equal(duringB.generation, initial.generation); assert.equal(duringB.due.control.at, B);
  assert.equal(duringB.ack.control.at, initial.due.control.at); assert.equal(f.count('send'), 1);
  const event = { kind: 'schedule', scheduleId: initial.alarm.id, input: structuredClone(f.schedules.get(initial.alarm.id).payload) };
  f.clock.jump(C);
  if (delivery === 'before-refresh-release') {
    const reads = f.count('getSchedule'); assert.equal(f.rawHandler(event).status, 'accepted');
    assert.equal(f.rawHandler(event).status, 'ignored'); await until(() => f.count('getSchedule') > reads); await flush();
    // The handler has arrived, but shares the blocked write queue. C can be
    // refreshed after release by either continuation; ACK(B) must not win it.
    assert.equal((await f.status()).due.control.at, B); assert.equal(f.count('send'), 1);
  }
  release.resolve(); const result = await acknowledgement;
  assert.equal(result.error?.code, 'MAIN_CONTROL_ACK_MISMATCH');
  const rejected = await f.status(); assert.equal(rejected.generation, initial.generation); assert.equal(rejected.due.control.at, C);
  assert.equal(rejected.ack.control.at, initial.due.control.at);
  if (delivery === 'after-ack-rejection') {
    const disk = JSON.parse(f.files.get(BASE + '/' + PROJECT + '.json'));
    assert.equal(disk.due.control.at, C); assert.equal(disk.nextControlAt, C + BEAT);
    assert.equal(f.rawHandler(event).status, 'accepted'); assert.equal(f.rawHandler(event).status, 'ignored');
  }
  await until(() => f.count('send') >= 2); const settled = await f.settled();
  const disk = JSON.parse(f.files.get(BASE + '/' + PROJECT + '.json'));
  assert.equal(settled.generation, initial.generation); assert.equal(settled.state, 'active');
  assert.equal(settled.due.control.at, C); assert.equal(settled.due.control.notified, true); assert.equal(settled.nextControlAt, C + BEAT);
  assert.deepEqual(disk.due, settled.due); assert.deepEqual(disk.ack, settled.ack);
  assert.equal(settled.send.points.control, C); assert.equal(settled.send.points.audit, null); assert.equal(f.count('send'), 2);
  assert.equal(f.writes.some(record => record.ack.control?.at === B), false, 'The stale B acknowledgement never committed');
  assert.equal(f.rawHandler(event).status, 'ignored'); await flush(); assert.equal(f.count('send'), 2);
});

test('ACK(B) final persistence may overlap the C alarm, but its old continuation cannot clear C', async t => {
  const behavior = {}, f = await fixture(t, behavior), initial = await f.start(); await f.ack();
  const B = initial.nextControlAt, C = B + BEAT;
  f.clock.jump(B); assert.equal(f.fire(initial.alarm.id).status, 'accepted');
  await until(() => f.count('send') === 2); const atB = await f.settled();
  const entered = f.gate(), release = f.gate(); let finalWrite;
  behavior.write = async record => {
    if (!finalWrite && record.ack.control?.at === B && record.due.control === null) { finalWrite = record; entered.resolve(); await release.promise; }
  };
  const acknowledgement = f.service.acknowledge({ ...f.args(atB), controlAt: B }, f.main).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  const cleared = await f.status(); assert.equal(cleared.due.control, null); assert.equal(cleared.ack.control.at, B);
  assert.equal(cleared.generation, atB.generation); assert.equal(finalWrite.nextControlAt, C);
  const event = { kind: 'schedule', scheduleId: atB.alarm.id, input: structuredClone(f.schedules.get(atB.alarm.id).payload) };
  const reads = f.count('getSchedule'); f.clock.jump(C);
  assert.equal(f.rawHandler(event).status, 'accepted'); assert.equal(f.rawHandler(event).status, 'ignored');
  await until(() => f.count('getSchedule') > reads); await flush(); assert.equal(f.count('send'), 2);
  release.resolve(); const result = await acknowledgement;
  assert.equal(result.error, undefined); assert.equal(result.value.ack.control.at, B);
  // The returned view may already include C. Only the synchronous compare/clear
  // acknowledged B; no assertion promises an empty due at asynchronous return.
  await until(() => f.count('send') >= 3); const after = await f.settled(); await flush();
  const disk = JSON.parse(f.files.get(BASE + '/' + PROJECT + '.json'));
  assert.equal(after.generation, initial.generation); assert.equal(after.state, 'active');
  assert.equal(after.ack.control.at, B); assert.equal(after.due.control.at, C); assert.equal(after.due.control.notified, true);
  assert.equal(after.send.points.control, C); assert.equal(after.nextControlAt, C + BEAT);
  assert.deepEqual(disk.due, after.due); assert.deepEqual(disk.ack, after.ack); assert.equal(f.count('send'), 3);
  assert.equal(f.rawHandler(event).status, 'ignored'); await flush(); assert.equal(f.count('send'), 3);
});

test('no-due wait linearizes before its final save: crossing C before return still leaves the original alarm effective', async t => {
  const behavior = {}, f = await fixture(t, behavior), initial = await f.start(); await f.ack();
  const C = initial.nextControlAt, entered = f.gate(), release = f.gate(); let waitingWrite;
  behavior.write = async record => {
    if (!waitingWrite && record.waiting && record.waitReason === 'main-wait') { waitingWrite = record; entered.resolve(); await release.promise; }
  };
  const waiting = f.service.wait(f.args(initial), f.main).then(value => ({ value }), error => ({ error }));
  await entered.promise; const linearized = await f.status();
  assert.equal(linearized.waiting, true); assert.deepEqual(linearized.due, { control: null, audit: null });
  assert.deepEqual(waitingWrite.due, linearized.due); const reads = f.count('getSchedule');
  f.clock.jump(C + 1); await flush(); assert.equal(f.count('getSchedule'), reads); assert.equal(f.count('send'), 1);
  release.resolve(); const result = await waiting; assert.equal(result.error, undefined);
  const returned = result.value; assert.equal(returned.waiting, true); assert.equal(returned.waitReason, 'main-wait');
  assert.equal(returned.generation, initial.generation); assert.equal(returned.nextControlAt, C);
  assert.ok(f.clock.now() > returned.nextControlAt, 'Success is not a claim that no deadline has passed by return time');
  assert.equal(returned.alarm.id, initial.alarm.id); assert.deepEqual(returned.due, { control: null, audit: null });
  const waitingDisk = JSON.parse(f.files.get(BASE + '/' + PROJECT + '.json'));
  assert.equal(waitingDisk.waiting, true); assert.equal(waitingDisk.nextControlAt, C);
  assert.equal(f.fire(initial.alarm.id).status, 'accepted'); assert.equal(f.fire(initial.alarm.id).status, 'ignored');
  await until(() => f.count('send') >= 2); const reviewed = await f.settled();
  assert.equal(reviewed.waiting, false); assert.equal(reviewed.send.kind, 'review'); assert.equal(reviewed.send.points.control, C);
  assert.equal(reviewed.due.control.at, C); assert.equal(reviewed.due.control.notified, true); assert.equal(reviewed.nextControlAt, C + BEAT);
  assert.equal(reviewed.ack.control.at, initial.due.control.at); assert.equal(f.count('send'), 2);
  assert.deepEqual(JSON.parse(f.files.get(BASE + '/' + PROJECT + '.json')).due, reviewed.due);
});

test('current unnotified points can be acknowledged; a delayed accepted send does not recreate due or rewrite ack', async t => {
  const behavior = {}, f = await fixture(t, behavior), receipt = f.gate();
  behavior.send = async () => { await receipt.promise; return { accepted: true, sessionPath: BINDING.sessionPath }; };
  await f.service.start({ projectId: PROJECT, authorized: true }, f.creator); await until(() => f.count('send') === 1);
  const pending = await f.status(); assert.equal(pending.send.state, 'pending');
  assert.equal(pending.due.control.notified, false); assert.equal(pending.due.audit.notified, false);
  const acknowledged = await f.service.acknowledge({ ...f.args(pending), controlAt: pending.due.control.at, auditAt: pending.due.audit.at }, f.main);
  const ack = structuredClone(acknowledged.ack); assert.deepEqual(acknowledged.due, { control: null, audit: null });
  assert.equal(ack.control.at, pending.due.control.at); assert.equal(ack.audit.at, pending.due.audit.at);
  assert.deepEqual(JSON.parse(f.files.get(BASE + '/' + PROJECT + '.json')).ack, ack);
  assert.equal((await f.service.wait(f.args(pending), f.main)).waiting, true);
  f.clock.jump(f.clock.now() + 1); receipt.resolve(); const after = await f.settled();
  assert.equal(after.send.state, 'accepted'); assert.ok(after.send.settledAt > ack.control.acknowledgedAt);
  assert.equal(after.generation, pending.generation); assert.equal(after.waiting, true); assert.deepEqual(after.ack, ack);
  assert.deepEqual(after.due, { control: null, audit: null }); assert.equal(after.nextControlAt, pending.nextControlAt);
  const disk = JSON.parse(f.files.get(BASE + '/' + PROJECT + '.json')); assert.deepEqual(disk.ack, ack); assert.deepEqual(disk.due, after.due);
  f.end(); await flush(); assert.equal(f.count('send'), 1); assert.equal(f.count('schedule'), 1);
});

test('late acceptance of an old review cannot mark a newer control point notified', async t => {
  const behavior = {}, f = await fixture(t, behavior), first = f.gate(), second = f.gate(), secondEntered = f.gate();
  behavior.send = async (_input, number) => { if (number === 1) await first.promise; if (number === 2) { secondEntered.resolve(); await second.promise; }
    return { accepted: true, sessionPath: BINDING.sessionPath }; };
  await f.service.start({ projectId: PROJECT, authorized: true }, f.creator); await until(() => f.count('send') === 1); const initial = await f.status();
  f.clock.jump(initial.nextControlAt); f.fire(initial.alarm.id); await until(async () => (await f.status()).nextControlAt > f.clock.now()); await flush();
  assert.equal((await f.status()).due.control.at, initial.nextControlAt); assert.equal((await f.status()).due.control.notified, false);
  first.resolve(); await secondEntered.promise; const during = await f.status();
  assert.equal(during.due.control.notified, false); assert.equal(during.due.audit.notified, true);
  assert.equal(during.send.points.control, initial.nextControlAt); assert.equal(during.send.points.audit, null);
  second.resolve(); await f.settled(); assert.equal(f.count('send'), 2);
});

test('exhausted budget wait still receives each new unacknowledged review without refilling', async t => {
  const f = await fixture(t), initial = await f.start({ maxAutomaticContinues: 1 }); await f.ack(); await automaticContinue(f);
  for (const at of [initial.nextControlAt, initial.nextControlAt + BEAT, initial.nextAuditAt]) {
    const before = await f.status(), sends = f.count('send'); f.clock.jump(at); f.fire(before.alarm.id);
    await until(async () => (await f.status()).nextControlAt > at); await flush(); assert.equal(f.count('send'), sends + 1);
    const review = await f.settled(); assert.equal(review.due.control.at, at); assert.equal(review.waitReason, 'continuation-budget');
    assert.deepEqual(review.continuationBudget, { limit: 1, reserved: 1 });
    await assert.rejects(f.service.wait(f.args(review), f.main), { code: 'MAIN_CONTROL_DUE_UNACKNOWLEDGED' });
    await assert.rejects(f.service.continue_work(f.args(review), f.main), { code: 'MAIN_CONTROL_CONTINUATION_BUDGET_EXHAUSTED' });
  }
  await f.ack(); assert.equal((await f.service.wait(f.args(await f.status()), f.main)).waiting, true);
  assert.equal(f.count('send'), 5); assert.equal(f.callbacks.filter(c => c.name === 'stopWorkers').length, 0);
});

test('legacy records remain unconfigured and regain new-boundary reviews only after explicit creator resume', async t => {
  const f = await fixture(t); await f.start(); const files = new Map(f.files), key = BASE + '/' + PROJECT + '.json';
  const legacy = JSON.parse(files.get(key)); delete legacy.waitReason; legacy.waiting = true; files.set(key, JSON.stringify(legacy));
  const g = await fixture(t, {}, { files, schedules: new Map(f.schedules), now: f.clock.now() });
  assert.equal((await g.status()).state, 'blocked'); assert.equal(g.count('send'), 0);
  await g.service.resume({ projectId: PROJECT }, g.creator); const resumed = await g.settled();
  await assert.rejects(g.service.wait(g.args(resumed), g.main), { code: 'MAIN_CONTROL_DUE_UNACKNOWLEDGED' });
  g.clock.jump(resumed.nextControlAt); g.fire(resumed.alarm.id); await until(async () => (await g.status()).nextControlAt > g.clock.now()); await flush();
  assert.equal(g.count('send'), 2); assert.ok(g.writes.every(record => !Object.hasOwn(record, 'continuationBudget')));
});

for (const mode of ['pause', 'stop', 'unknown']) test(`new-boundary refresh cannot bypass ${mode}`, async t => {
  const f = await fixture(t), initial = await f.start(), event = { kind: 'schedule', scheduleId: initial.alarm.id, input: structuredClone(f.schedules.get(initial.alarm.id).payload) };
  if (mode === 'unknown') { f.emit({ type: 'error', source: 'session:send' }); await flush(); }
  else await f.service[mode]({ projectId: PROJECT }, f.creator);
  const inactive = await f.status(); f.clock.jump(initial.nextAuditAt + AUDIT); f.rawHandler(event); await flush();
  await assert.rejects(f.service.wait(f.args(inactive), f.main), { code: 'MAIN_CONTROL_INACTIVE' });
  assert.equal(f.count('send'), 1); assert.equal((await f.status()).nextControlAt, inactive.nextControlAt);
  if (mode === 'unknown') await assert.rejects(f.service.resume({ projectId: PROJECT }, f.creator), { code: 'MAIN_CONTROL_SEND_UNSETTLED' });
});

for (const action of ['acknowledge', 'wait']) test(`${action} refresh persistence failure cannot acknowledge or report successful wait`, async t => {
  const behavior = {}, f = await fixture(t, behavior), initial = await f.start(); f.clock.jump(initial.nextControlAt);
  behavior.write = async () => { throw Object.assign(new Error('OPAQUE_WRITE'), { code: 'EIO' }); };
  const args = { ...f.args(initial), ...(action === 'acknowledge' ? { controlAt: initial.due.control.at } : {}) };
  await assert.rejects(f.service[action](args, f.main), { code: 'EIO' }); const after = await f.status();
  assert.equal(after.persistenceFailed, true); assert.equal(after.ack.control, null); assert.equal(after.waiting, false);
  assert.equal(after.due.control.at, initial.nextControlAt); assert.throws(() => f.service.admit(PROJECT), { code: 'MAIN_CONTROL_WORK_DENIED' });
  assert.equal(f.count('send'), 1); behavior.write = null;
});

test('accepted send and normal agent_end do not acknowledge a beat; duplicate/retry/foreign ends do not multiply continuation', async t => {
  const f = await fixture(t); const first = await f.start();
  f.end({ willRetry: true }); f.end({ sessionId: 'foreign' }); f.emit({ type: 'agent_end', messages: [] }, '/foreign'); await flush(); assert.equal(f.count('send'), 1);
  assert.equal(f.end(), undefined); f.end(); await until(() => f.count('send') === 2); await f.settled();
  assert.equal((await f.status()).due.control.at, first.due.control.at); assert.equal((await f.status()).ack.control, null);
  f.end(); await flush(); assert.equal(f.count('send'), 2);
  f.emit({ type: 'agent_start' }); f.end(); await until(() => f.count('send') === 3); await f.settled();
});

test('acknowledgement requires bound main plus exact Goal, generation and due point', async t => {
  const f = await fixture(t), s = await f.start(), args = { ...f.args(s), controlAt: s.due.control.at };
  await assert.rejects(f.service.acknowledge(args, f.creator), { code: 'MAIN_CONTROL_FORBIDDEN' });
  for (const patch of [{ goalId: 'other' }, { generation: s.generation + 1 }]) await assert.rejects(f.service.acknowledge({ ...args, ...patch }, f.main), { code: 'MAIN_CONTROL_STALE' });
  await assert.rejects(f.service.acknowledge({ ...args, controlAt: args.controlAt + 1 }, f.main), { code: 'MAIN_CONTROL_ACK_MISMATCH' });
  const next = await f.service.acknowledge(args, f.main); assert.equal(next.due.control, null); assert.ok(next.due.audit);
  assert.equal(next.nextControlAt, s.nextControlAt); assert.equal(next.nextAuditAt, s.nextAuditAt);
});

test('wait -> same-agent followUp without agent_start -> continue_work -> normal end continues; deadlines do not move', async t => {
  const f = await fixture(t), s = await f.start(); await f.ack();
  await f.service.wait(f.args(s), f.main); f.end(); await flush(); assert.equal(f.count('send'), 1);
  const resumed = await f.service.continue_work(f.args(s), f.main);
  assert.equal(resumed.waiting, false); assert.equal(resumed.nextControlAt, s.nextControlAt); assert.equal(resumed.nextAuditAt, s.nextAuditAt);
  assert.equal(f.count('send'), 1, 'Explicit work signal itself must not inject a message');
  f.end(); await until(() => f.count('send') === 2); const after = await f.settled();
  assert.equal(after.nextControlAt, s.nextControlAt); assert.equal(after.nextAuditAt, s.nextAuditAt);
});

test('native main result while waiting does not reserve or continue; duplicate ends stay idle at exhausted budget', async t => {
  const f = await fixture(t), initial = await f.start({ maxAutomaticContinues: 1 }); await f.ack();
  await f.service.wait(f.args(initial), f.main);
  const before = await f.status(); assert.equal(before.waiting, true); assert.deepEqual(before.continuationBudget, { limit: 1, reserved: 0 });
  f.emit({ type: 'agent_start' }, BINDING.sessionPath); await flush();
  const running = await f.status(); assert.equal(running.continuationBudget.reserved, 0); assert.equal(f.count('send'), 1);
  await f.service.wait(f.args(running), f.main);
  f.end({ actor: 'foreign' }); f.end({ actor: 'foreign' }); await flush();
  const idle = await f.status(); assert.equal(idle.waiting, true); assert.equal(idle.continuationBudget.reserved, 0); assert.equal(f.count('send'), 1);

  const capped = await fixture(t), goal = await capped.start({ maxAutomaticContinues: 1 }); await capped.ack();
  await automaticContinue(capped);
  const exhausted = await capped.status(); assert.equal(exhausted.waiting, true);
  assert.deepEqual(exhausted.continuationBudget, { limit: 1, reserved: 1 });
  capped.emit({ type: 'agent_start' }, BINDING.sessionPath); await flush(); capped.end({ actor: 'foreign' }); await flush();
  const after = await capped.status(); assert.equal(after.continuationBudget.reserved, 1); assert.equal(capped.count('send'), 2);
});

test('continue_work is main-only and cannot resume a paused Goal or cross an inactive epoch', async t => {
  const f = await fixture(t), s = await f.start();
  await assert.rejects(f.service.continue_work(f.args(s), f.creator), { code: 'MAIN_CONTROL_FORBIDDEN' });
  const paused = await f.service.pause({ projectId: PROJECT }, f.creator);
  await assert.rejects(f.service.continue_work(f.args(s), f.main), { code: 'MAIN_CONTROL_STALE' });
  await assert.rejects(f.service.continue_work(f.args(paused), f.main), { code: 'MAIN_CONTROL_INACTIVE' });
  assert.equal(f.count('send'), 1); assert.equal((await f.status()).state, 'paused');
});

test('wait keeps a deadline alarm; a due review wakes it without short polling', async t => {
  const f = await fixture(t), s = await f.start(); await f.ack(); await f.service.wait(f.args(s), f.main);
  f.clock.jump(s.nextControlAt - 1); await flush(); assert.equal(f.count('send'), 1); assert.equal(f.count('schedule'), 1);
  f.clock.jump(s.nextControlAt); f.fire(s.alarm.id); await until(() => f.count('send') === 2); const result = await f.settled();
  assert.equal(result.waiting, false); assert.equal(result.nextControlAt, s.nextControlAt + BEAT); assert.equal(result.nextAuditAt, s.nextAuditAt);
});

test('new agent input clears wait without changing deadline; stale queued ends cannot cross pause/resume', async t => {
  const f = await fixture(t), s = await f.start(); await f.ack(); await f.service.wait(f.args(s), f.main);
  f.emit({ type: 'agent_start' }); await flush(); assert.equal((await f.status()).waiting, false);
  const paused = await f.service.pause({ projectId: PROJECT }, f.main); f.end();
  f.clock.jump(f.clock.now() + 1000); await f.service.resume({ projectId: PROJECT }, f.creator); const resumed = await f.settled();
  assert.ok(resumed.generation > paused.generation); assert.equal(resumed.nextControlAt, s.nextControlAt); assert.equal(resumed.nextAuditAt, s.nextAuditAt);
  assert.equal(resumed.due.audit, null); assert.equal(f.count('send'), 2);
});

for (const action of ['pause', 'stop']) for (const outcome of ['accepted', 'unknown']) test(`${action} during send preserves late ${outcome}, never replays or aborts main`, async t => {
  const behavior = {}, f = await fixture(t, behavior), gate = f.gate();
  behavior.send = async () => { await gate.promise; return outcome === 'accepted' ? { accepted: true, sessionPath: BINDING.sessionPath, sessionId: BINDING.sessionId } : {}; };
  await f.service.start({ projectId: PROJECT, authorized: true }, f.creator); await until(() => f.count('send') === 1);
  const state = await f.service[action]({ projectId: PROJECT }, f.creator);
  assert.equal(state.state, action === 'stop' ? 'stopped' : 'paused'); assert.equal(state.goalCleanupPending, true);
  const cleanup = f.calls.find(c => c.name === 'unschedule'); assert.ok(cleanup);
  const inactive = f.writes.find(m => m.state === (action === 'stop' ? 'stopping' : 'paused')); assert.ok(inactive);
  assert.ok(inactive.generation > 1); assert.equal(f.count('unschedule'), 1);
  gate.resolve(); await until(async () => !(await f.status()).sendInFlight); await flush();
  const late = await f.status(); assert.equal(late.lateDelivery.state, outcome); assert.equal(late.send.late, true); assert.equal(f.count('send'), 1);
  f.end(); await flush(); assert.equal(f.count('send'), 1);
  if (outcome === 'unknown') await assert.rejects(f.service.resume({ projectId: PROJECT }, f.creator), { code: 'MAIN_CONTROL_SEND_UNSETTLED' });
  if (action === 'stop') assert.strictEqual(f.callbacks.find(c => c.name === 'stopWorkers').ctx, f.creator);
});

for (const action of ['stop', 'complete']) test(`${action} reserves worker stop in memory and its first inactive write`, async t => {
  const behavior = {}, f = await fixture(t, behavior), s = await f.start();
  const writing = f.gate(), releaseWrite = f.gate(); let first;
  behavior.write = async record => { if (!first) { first = record; writing.resolve(); await releaseWrite.promise; } };
  const operation = action === 'stop' ? f.service.stop({ projectId: PROJECT }, f.creator)
    : f.service.complete({ ...f.args(s), factIds: ['cccccccccccccccc'] }, f.main);
  await writing.promise; const during = await f.status(), callbacksBeforeSave = f.callbacks.filter(c => c.name === 'stopWorkers').length;
  releaseWrite.resolve(); await operation;
  assert.equal(during.workerStop.state, 'pending'); assert.equal(first.workerStop.state, 'pending');
  assert.equal(first.workerStop.generation, first.generation); assert.equal(callbacksBeforeSave, 0);
  assert.equal(f.callbacks.filter(c => c.name === 'stopWorkers').length, 1); assert.equal(f.count('send'), 1);
});

test('stop first-write -> pause -> resume binding window cannot activate while worker stop is pending', async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start();
  const writing = f.gate(), releaseWrite = f.gate(), bindingEntered = f.gate(), releaseBinding = f.gate(), stopping = f.gate(), releaseStop = f.gate(); let first;
  behavior.write = async record => { if (!first) { first = record; writing.resolve(); await releaseWrite.promise; } };
  behavior.getMainBinding = async () => { bindingEntered.resolve(); await releaseBinding.promise; };
  behavior.stopWorkers = async () => { stopping.resolve(); await releaseStop.promise; return { requested: true, cleanupPending: true }; };
  const stop = f.service.stop({ projectId: PROJECT }, f.creator); await writing.promise;
  const pause = f.service.pause({ projectId: PROJECT }, f.creator); await until(async () => (await f.status()).state === 'paused');
  const resume = f.service.resume({ projectId: PROJECT }, f.creator).then(value => ({ value }), error => ({ error }));
  await Promise.race([bindingEntered.promise, resume]); // Old code enters binding; fixed code rejects before it.
  releaseWrite.resolve(); await stopping.promise; await pause;
  const pending = await f.status(); releaseBinding.resolve(); const result = await resume; await flush();
  const after = await f.status(); releaseStop.resolve(); await stop;
  assert.equal(pending.workerStop.state, 'pending'); assert.equal(after.state, 'paused');
  assert.equal(result.error?.code, 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED');
  assert.equal(after.workerStop.generation, first.generation); assert.equal(f.count('send'), 1); assert.equal(f.count('schedule'), 1);
  assert.equal(f.callbacks.filter(c => c.name === 'stopWorkers').length, 1);
});

test('resume waiting for binding rechecks its epoch after a concurrent stop and pause', async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start(); await f.service.pause({ projectId: PROJECT }, f.creator);
  const bindingEntered = f.gate(), releaseBinding = f.gate(), stopping = f.gate(), releaseStop = f.gate();
  behavior.getMainBinding = async () => { bindingEntered.resolve(); await releaseBinding.promise; };
  behavior.stopWorkers = async () => { stopping.resolve(); await releaseStop.promise; return { requested: true, cleanupPending: false }; };
  const resume = assert.rejects(f.service.resume({ projectId: PROJECT }, f.creator), { code: 'MAIN_CONTROL_STALE' });
  await bindingEntered.promise; const stop = f.service.stop({ projectId: PROJECT }, f.creator); await stopping.promise;
  const paused = await f.service.pause({ projectId: PROJECT }, f.creator); releaseBinding.resolve(); await resume;
  assert.equal(paused.workerStop.state, 'pending'); assert.equal((await f.status()).generation, paused.generation);
  releaseStop.resolve(); await stop; assert.equal((await f.status()).state, 'paused');
  assert.equal(f.count('send'), 1); assert.equal(f.count('schedule'), 1);
});

for (const window of ['binding', 'reconcile']) test(`resume rechecks send uncertainty after its ${window} await without an epoch change`, async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start();
  const entered = f.gate(), release = f.gate(), cleaning = f.gate(), releaseCleanup = f.gate();
  if (window === 'reconcile') behavior.unschedule = async () => { cleaning.resolve(); await releaseCleanup.promise; };
  const pause = f.service.pause({ projectId: PROJECT }, f.creator);
  if (window === 'reconcile') { await cleaning.promise; behavior.getSchedule = async () => { entered.resolve(); await release.promise; }; }
  else { await pause; behavior.getMainBinding = async () => { entered.resolve(); await release.promise; }; }
  const before = await f.status();
  const resume = assert.rejects(f.service.resume({ projectId: PROJECT }, f.creator), { code: 'MAIN_CONTROL_SEND_UNSETTLED' });
  await entered.promise; f.emit({ type: 'error', source: 'session:send' });
  assert.equal((await f.status()).generation, before.generation);
  releaseCleanup.resolve(); await pause; release.resolve(); await resume; await flush();
  const after = await f.status(); assert.equal(after.state, 'paused'); assert.equal(after.send.state, 'unknown');
  assert.equal(after.generation, before.generation); assert.equal(f.count('send'), 1); assert.equal(f.count('schedule'), 1);
});

test('a second stop cannot replace a pending stop across pause or issue another callback', async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start();
  const stopping = f.gate(), releaseStop = f.gate(); let calls = 0;
  behavior.stopWorkers = async () => { if (++calls === 1) { stopping.resolve(); await releaseStop.promise; } return { requested: true, cleanupPending: false }; };
  const stop = f.service.stop({ projectId: PROJECT }, f.creator); await stopping.promise;
  const paused = await f.service.pause({ projectId: PROJECT }, f.creator);
  await assert.rejects(f.service.stop({ projectId: PROJECT, force: true }, f.creator), { code: 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED' });
  assert.deepEqual((await f.status()).workerStop, paused.workerStop); assert.equal((await f.status()).generation, paused.generation);
  releaseStop.resolve(); await stop;
  assert.equal(calls, 1); assert.equal((await f.status()).state, 'paused'); assert.equal(f.count('send'), 1);
});

for (const outcome of ['throw', 'timeout']) test(`unknown worker stop (${outcome}) survives pause and refuses resume or stop replay`, async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start();
  const stopping = f.gate(), releaseStop = f.gate(); let calls = 0;
  behavior.stopWorkers = async () => {
    calls++; stopping.resolve(); await releaseStop.promise;
    if (outcome === 'throw') throw Object.assign(new Error('OPAQUE_STOP'), { code: 'OPAQUE_STOP_ERROR' });
    return { requested: true, cleanupPending: false };
  };
  const stop = f.service.stop({ projectId: PROJECT }, f.creator); await stopping.promise;
  await f.service.pause({ projectId: PROJECT }, f.creator);
  if (outcome === 'throw') releaseStop.resolve(); else f.clock.tick(10000);
  await stop; const unknown = await f.status(); assert.equal(unknown.workerStop.state, 'unknown');
  assert.equal(unknown.workerStop.error, outcome === 'throw' ? 'OPAQUE_STOP_ERROR' : 'MAIN_CONTROL_TIMEOUT');
  releaseStop.resolve(); await flush(); // A late successful return is not a known/retryable stop.
  await f.service.pause({ projectId: PROJECT }, f.creator); assert.deepEqual((await f.status()).workerStop, unknown.workerStop);
  await assert.rejects(f.service.resume({ projectId: PROJECT }, f.creator), { code: 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED' });
  await assert.rejects(f.service.stop({ projectId: PROJECT }, f.creator), { code: 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED' });
  f.end(); await flush(); assert.equal(calls, 1); assert.equal(f.count('send'), 1); assert.equal(f.count('schedule'), 1);
});

for (const cleanupPending of [false, true]) test(`returned stop with cleanupPending=${cleanupPending} permits explicit resume, not automatic replay`, async t => {
  const behavior = {}, f = await fixture(t, behavior); const initial = await f.start();
  const stopping = f.gate(), releaseStop = f.gate();
  behavior.stopWorkers = async () => { stopping.resolve(); await releaseStop.promise; return { requested: true, cleanupPending }; };
  const stop = f.service.stop({ projectId: PROJECT }, f.creator); await stopping.promise;
  const paused = await f.service.pause({ projectId: PROJECT }, f.creator);
  await assert.rejects(f.service.resume({ projectId: PROJECT }, f.creator), { code: 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED' });
  releaseStop.resolve(); await stop; await flush(); const returned = await f.status();
  assert.equal(returned.state, 'paused'); assert.equal(returned.workerStop.state, 'requested');
  assert.equal(returned.workerStop.generation, paused.workerStop.generation); assert.equal(returned.workerStop.cleanupPending, cleanupPending);
  assert.equal(f.count('send'), 1); await f.service.resume({ projectId: PROJECT }, f.creator); const resumed = await f.settled();
  assert.equal(resumed.state, 'active'); assert.equal(resumed.goalId, initial.goalId); assert.equal(resumed.generation, paused.generation + 1);
  assert.equal(resumed.nextControlAt, initial.nextControlAt); assert.equal(resumed.nextAuditAt, initial.nextAuditAt);
  assert.equal(f.count('send'), 2); assert.equal(f.count('schedule'), 2); assert.equal(f.callbacks.filter(c => c.name === 'stopWorkers').length, 1);
});

test('ordinary pause and resume never reserve a worker stop or add extra sends', async t => {
  const f = await fixture(t); const initial = await f.start(), paused = await f.service.pause({ projectId: PROJECT }, f.creator);
  assert.equal(paused.workerStop.state, 'not-requested');
  await f.service.resume({ projectId: PROJECT }, f.creator); const resumed = await f.settled();
  assert.equal(resumed.workerStop.state, 'not-requested'); assert.equal(resumed.goalId, initial.goalId);
  assert.equal(resumed.generation, paused.generation + 1); assert.equal(f.count('send'), 2); assert.equal(f.count('schedule'), 2);
  assert.equal(f.callbacks.filter(c => c.name === 'stopWorkers').length, 0);
});

async function automaticContinue(f) {
  const sends = f.count('send'); f.emit({ type: 'agent_start' }); f.end();
  await until(() => f.count('send') === sends + 1);
  const receipt = f.calls.filter(c => c.name === 'send').at(-1).input;
  assert.match(receipt.text, /Exploratory subagents are for speculative text-only mathematics/);
  return f.settled();
}

for (const options of [{}, { maxAutomaticContinues: 0 }]) test(`continuation budget ${JSON.stringify(options)} stays unlimited without a growing counter`, async t => {
  const f = await fixture(t); await f.start(options);
  for (let i = 0; i < 3; i++) await automaticContinue(f);
  const state = await f.status(); assert.equal(f.count('send'), 4); assert.equal(state.waiting, false);
  if (Object.hasOwn(options, 'maxAutomaticContinues')) assert.deepEqual(state.continuationBudget, { limit: 0, reserved: 0 });
  else assert.equal(Object.hasOwn(state, 'continuationBudget'), false);
});

for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '1', false]) test(`invalid explicit continuation budget ${JSON.stringify(value)} fails without writes`, async t => {
  const f = await fixture(t);
  await assert.rejects(f.start({ maxAutomaticContinues: value }), { code: 'MAIN_CONTROL_INVALID_INPUT' });
  assert.equal(f.files.size, 0); assert.equal(f.count('send'), 0);
  await f.start(); await f.service.pause({ projectId: PROJECT }, f.creator); const before = await f.status();
  await assert.rejects(f.service.resume({ projectId: PROJECT, maxAutomaticContinues: value }, f.creator), { code: 'MAIN_CONTROL_INVALID_INPUT' });
  assert.deepEqual(await f.status(), before);
});

test('last finite reservation is sent once, budget wait cannot be cleared or refilled by main activity', async t => {
  const f = await fixture(t), initial = await f.start({ maxAutomaticContinues: 2 });
  assert.deepEqual(initial.continuationBudget, { limit: 2, reserved: 0 }); assert.equal(initial.send.kind, 'review');
  const first = await automaticContinue(f); assert.deepEqual(first.continuationBudget, { limit: 2, reserved: 1 }); assert.equal(first.waiting, false);
  const last = await automaticContinue(f); assert.equal(f.count('send'), 3); assert.equal(last.send.kind, 'continue');
  assert.deepEqual(last.continuationBudget, { limit: 2, reserved: 2 }); assert.equal(last.state, 'active');
  assert.equal(last.waiting, true); assert.equal(last.waitReason, 'continuation-budget');
  for (let i = 0; i < 3; i++) {
    f.emit({ type: 'agent_start' }); f.end(); f.emit({ type: 'tool_execution_end', toolName: 'gm_add' });
    await assert.rejects(f.service.continue_work(f.args(last), f.main), { code: 'MAIN_CONTROL_CONTINUATION_BUDGET_EXHAUSTED' });
    await assert.rejects(f.service.wait(f.args(last), f.main), { code: 'MAIN_CONTROL_DUE_UNACKNOWLEDGED' }); await flush();
  }
  await f.ack(); await f.service.wait(f.args(last), f.main); const after = await f.status();
  assert.deepEqual(after.continuationBudget, last.continuationBudget); assert.equal(after.waitReason, 'continuation-budget');
  assert.equal(after.waiting, true); assert.equal(f.count('send'), 3); assert.equal(f.count('schedule'), 1);
  assert.equal(after.nextControlAt, initial.nextControlAt); assert.equal(after.nextAuditAt, initial.nextAuditAt);
  assert.equal(f.callbacks.filter(c => c.name === 'stopWorkers').length, 0);
});

test('budget wait retains anchored control/audit reviews and exact acknowledgements without new continues', async t => {
  const f = await fixture(t), initial = await f.start({ maxAutomaticContinues: 1 }); await f.ack();
  await automaticContinue(f);
  for (const at of [initial.nextControlAt, initial.nextAuditAt]) {
    const before = await f.status(), sends = f.count('send'); f.clock.jump(at); f.fire(before.alarm.id);
    await until(() => f.count('send') === sends + 1); const review = await f.settled();
    assert.equal(review.send.kind, 'review'); assert.equal(review.waiting, true); assert.equal(review.waitReason, 'continuation-budget');
    assert.deepEqual(review.continuationBudget, { limit: 1, reserved: 1 });
    await assert.rejects(f.service.acknowledge({ ...f.args(review), controlAt: review.due.control.at + 1 }, f.main), { code: 'MAIN_CONTROL_ACK_MISMATCH' });
    if (at === initial.nextAuditAt) assert.ok(review.due.audit);
    await f.ack(); await assert.rejects(f.service.continue_work(f.args(review), f.main), { code: 'MAIN_CONTROL_CONTINUATION_BUDGET_EXHAUSTED' });
    f.emit({ type: 'agent_start' }); f.end(); await flush(); assert.equal(f.count('send'), sends + 1);
  }
  const after = await f.status(); assert.equal(after.nextControlAt, initial.nextAuditAt + BEAT);
  assert.equal(after.nextAuditAt, initial.nextAuditAt + AUDIT); assert.equal(f.count('send'), 4);
  assert.equal(f.callbacks.filter(c => c.name === 'stopWorkers').length, 0);
});

test('normal wait and continue_work consume no reservation; creator alone resets the inactive epoch budget', async t => {
  const f = await fixture(t), initial = await f.start({ maxAutomaticContinues: 2 }); await f.ack();
  await f.service.wait(f.args(initial), f.main); await f.service.continue_work(f.args(initial), f.main);
  assert.deepEqual((await f.status()).continuationBudget, { limit: 2, reserved: 0 });
  await automaticContinue(f); const active = await f.status();
  await assert.rejects(f.service.resume({ projectId: PROJECT, maxAutomaticContinues: 5 }, f.creator), { code: 'MAIN_CONTROL_NOT_RESUMABLE' });
  assert.deepEqual((await f.status()).continuationBudget, active.continuationBudget);
  await f.service.pause({ projectId: PROJECT }, f.main);
  await assert.rejects(f.service.resume({ projectId: PROJECT, maxAutomaticContinues: 5 }, f.main), { code: 'MAIN_CONTROL_FORBIDDEN' });
  await assert.rejects(f.service.start({ projectId: 'project-other', authorized: true, maxAutomaticContinues: 5 }, f.main), { code: 'MAIN_CONTROL_FORBIDDEN' });
  await f.service.resume({ projectId: PROJECT }, f.creator); let resumed = await f.settled();
  assert.deepEqual(resumed.continuationBudget, { limit: 2, reserved: 0 }); assert.equal(resumed.goalId, initial.goalId);
  assert.ok(resumed.generation > initial.generation); assert.equal(resumed.waitReason, null);
  await assert.rejects(f.service.continue_work(f.args(initial), f.main), { code: 'MAIN_CONTROL_STALE' });
  for (const limit of [3, 0, Number.MAX_SAFE_INTEGER]) {
    await f.service.pause({ projectId: PROJECT }, f.creator);
    await f.service.resume({ projectId: PROJECT, maxAutomaticContinues: limit }, f.creator); resumed = await f.settled();
    assert.deepEqual(resumed.continuationBudget, { limit, reserved: 0 });
  }
  assert.equal(resumed.nextControlAt, initial.nextControlAt); assert.equal(resumed.nextAuditAt, initial.nextAuditAt);
});

for (const action of ['wait', 'stop']) test(`a persisted no-send continuation cancelled by ${action} never refunds its reservation`, async t => {
  const behavior = {}, f = await fixture(t, behavior), initial = await f.start({ maxAutomaticContinues: 1 }); await f.ack();
  const entered = f.gate(), release = f.gate(); let reserved;
  behavior.write = async record => { if (!reserved && record.send?.kind === 'continue' && record.send.state === 'pending') { reserved = record; entered.resolve(); await release.promise; } };
  f.end(); await entered.promise;
  const operation = action === 'wait' ? f.service.wait(f.args(initial), f.main) : f.service.stop({ projectId: PROJECT }, f.creator);
  await until(async () => action === 'wait' ? (await f.status()).waiting : (await f.status()).state === 'stopping');
  release.resolve(); await operation; await until(async () => !(await f.status()).sendInFlight); await flush();
  const after = await f.status(); assert.deepEqual(reserved.continuationBudget, { limit: 1, reserved: 1 });
  assert.deepEqual(after.continuationBudget, reserved.continuationBudget); assert.equal(after.send.notSent, true);
  assert.equal(after.send.invoked, false); assert.equal(after.send.state, 'rejected'); assert.equal(f.count('send'), 1);
  assert.equal(after.state, action === 'wait' ? 'active' : 'stopped');
  if (action === 'wait') { assert.equal(after.waitReason, 'continuation-budget'); await assert.rejects(f.service.continue_work(f.args(after), f.main), { code: 'MAIN_CONTROL_CONTINUATION_BUDGET_EXHAUSTED' }); }
});

for (const outcome of ['rejected', 'unknown']) test(`finite continuation ${outcome} retains its charge and never replays`, async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start({ maxAutomaticContinues: 1 });
  behavior.send = async () => outcome === 'rejected' ? { accepted: false, sessionPath: BINDING.sessionPath } : {};
  f.end(); await until(async () => (await f.status()).state === 'blocked'); await until(async () => !(await f.status()).sendInFlight); await flush();
  const state = await f.status(); assert.deepEqual(state.continuationBudget, { limit: 1, reserved: 1 }); assert.equal(state.send.state, outcome);
  f.emit({ type: 'agent_start' }); f.end(); await flush(); assert.equal(f.count('send'), 2);
  if (outcome === 'unknown') {
    await f.service.pause({ projectId: PROJECT }, f.creator);
    await assert.rejects(f.service.resume({ projectId: PROJECT, maxAutomaticContinues: 0 }, f.creator), { code: 'MAIN_CONTROL_SEND_UNSETTLED' });
    assert.deepEqual((await f.status()).continuationBudget, state.continuationBudget);
  }
});

test('stale resume cannot reset a budget while awaiting binding', async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start({ maxAutomaticContinues: 1 }); await automaticContinue(f);
  await f.service.pause({ projectId: PROJECT }, f.creator);
  const entered = f.gate(), release = f.gate(); behavior.getMainBinding = async () => { entered.resolve(); await release.promise; };
  const resume = assert.rejects(f.service.resume({ projectId: PROJECT, maxAutomaticContinues: 9 }, f.creator), { code: 'MAIN_CONTROL_STALE' });
  await entered.promise; await f.service.stop({ projectId: PROJECT }, f.creator); release.resolve(); await resume;
  assert.deepEqual((await f.status()).continuationBudget, { limit: 1, reserved: 1 }); assert.equal(f.count('send'), 2);
});

for (const phase of ['reservation', 'budget-wait']) test(`budget ${phase} persistence failure closes admission without another send`, async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start({ maxAutomaticContinues: 1 });
  behavior.write = async record => {
    if (record.continuationBudget?.reserved === 1 && (phase === 'reservation' ? record.send?.state === 'pending' : record.waitReason === 'continuation-budget')) {
      throw Object.assign(new Error('OPAQUE_WRITE'), { code: 'EIO' });
    }
  };
  f.end(); await until(async () => (await f.status()).persistenceFailed); await flush(); const failed = await f.status();
  assert.deepEqual(failed.continuationBudget, { limit: 1, reserved: 1 }); assert.throws(() => f.service.admit(PROJECT), { code: 'MAIN_CONTROL_WORK_DENIED' });
  assert.equal(f.count('send'), phase === 'reservation' ? 1 : 2);
  await assert.rejects(f.service.resume({ projectId: PROJECT, maxAutomaticContinues: 9 }, f.creator), { code: 'MAIN_CONTROL_NOT_RESUMABLE' });
  behavior.write = null;
});

test('old records recover without a budget backfill; explicit creator resume can opt in', async t => {
  const f = await fixture(t); await f.start();
  const g = await fixture(t, {}, { files: new Map(f.files), schedules: new Map(f.schedules), now: f.clock.now() });
  assert.equal((await g.status()).state, 'blocked'); assert.equal(Object.hasOwn(await g.status(), 'continuationBudget'), false);
  await g.service.resume({ projectId: PROJECT }, g.creator); await g.settled(); await automaticContinue(g);
  assert.equal(Object.hasOwn(await g.status(), 'continuationBudget'), false);
  assert.ok(g.writes.every(record => !Object.hasOwn(record, 'continuationBudget')));
  await g.service.pause({ projectId: PROJECT }, g.creator);
  await g.service.resume({ projectId: PROJECT, maxAutomaticContinues: 1 }, g.creator); await g.settled();
  assert.deepEqual((await g.status()).continuationBudget, { limit: 1, reserved: 0 });
});

test('restart preserves a reserved pending continuation as unknown and cannot reset through resume', async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start({ maxAutomaticContinues: 1 });
  const entered = f.gate(), release = f.gate(); behavior.send = async () => { entered.resolve(); await release.promise; return { accepted: true, sessionPath: BINDING.sessionPath }; };
  f.end(); await entered.promise;
  const g = await fixture(t, {}, { files: new Map(f.files), schedules: new Map(f.schedules), now: f.clock.now() });
  const recovered = await g.status(); assert.equal(recovered.state, 'blocked'); assert.equal(recovered.send.state, 'unknown');
  assert.deepEqual(recovered.continuationBudget, { limit: 1, reserved: 1 });
  await assert.rejects(g.service.resume({ projectId: PROJECT, maxAutomaticContinues: 7 }, g.creator), { code: 'MAIN_CONTROL_SEND_UNSETTLED' });
  assert.equal(g.count('send'), 0); release.resolve();
});

test('malformed explicit budget records fail closed instead of becoming unlimited', async t => {
  const f = await fixture(t); await f.start(); const file = BASE + '/' + PROJECT + '.json';
  for (const budget of [null, {}, { limit: 1 }, { limit: -1, reserved: 0 }, { limit: 1, reserved: -1 }, { limit: 1, reserved: 2 },
    { limit: 0, reserved: 1 }, { limit: 1.5, reserved: 0 }, { limit: Number.MAX_SAFE_INTEGER + 1, reserved: 0 }, { limit: 1, reserved: 0, used: 0 }]) {
    const record = JSON.parse(f.files.get(file)); record.continuationBudget = budget;
    const g = await fixture(t, {}, { files: new Map([[file, JSON.stringify(record)]]) });
    await assert.rejects(g.status(), { code: 'MAIN_CONTROL_RECORD_INVALID' }); assert.throws(() => g.service.admit(PROJECT), { code: 'MAIN_CONTROL_RECORD_INVALID' });
    assert.equal(g.writes.length, 0); assert.equal(g.count('send'), 0);
  }
});

test('completed projection distinguishes bound-main decision, fact existence and unobserved operator finalize', async t => {
  const f = await fixture(t), state = await f.start({ maxAutomaticContinues: 1 });
  const done = await f.service.complete({ ...f.args(state), factIds: ['dddddddddddddddd'] }, f.main);
  assert.deepEqual(done.completionSemantics, { decisionBy: 'bound-main', appCheck: 'canonical-fact-existence',
    targetCoverage: 'not-checked-by-app', operatorFinalize: { performedByThisAction: false, observedState: 'unknown' } });
  assert.deepEqual(done.continuationBudget, { limit: 1, reserved: 0 });
  const g = await fixture(t, {}, { files: new Map(f.files), schedules: new Map(f.schedules), now: f.clock.now() });
  assert.deepEqual((await g.status()).completionSemantics, done.completionSemantics);
});

test('send control timeout stays 10s; a late accepted receipt is recorded without automatic restart', async t => {
  const behavior = {}, f = await fixture(t, behavior), gate = f.gate();
  behavior.send = async () => { await gate.promise; return { accepted: true, sessionPath: BINDING.sessionPath }; };
  await f.service.start({ projectId: PROJECT, authorized: true }, f.creator); await until(() => f.count('send') === 1);
  f.clock.tick(10000); await until(async () => (await f.status()).state === 'blocked');
  const blocked = await f.status(); assert.equal(blocked.error, 'MAIN_CONTROL_TIMEOUT'); assert.equal(blocked.send.state, 'unknown');
  await assert.rejects(f.service.resume({ projectId: PROJECT }, f.creator), { code: 'MAIN_CONTROL_SEND_UNSETTLED' });
  gate.resolve(); await until(async () => (await f.status()).send.state === 'accepted'); await flush();
  assert.equal((await f.status()).state, 'blocked'); assert.equal((await f.status()).send.late, true); assert.equal(f.count('send'), 1);
});

for (const type of ['turn_end', 'agent_end']) test(`${type} abort without another end fences work immediately, without attributing a user or aborting main`, async t => {
  const f = await fixture(t); await f.start(); const ticket = f.service.admit(PROJECT);
  const event = type === 'turn_end' ? { type, aborted: true, willRetry: true, reason: 'not-an-authority' }
    : { type, messages: [{ role: 'assistant', stopReason: 'aborted' }] };
  assert.equal(f.emit(event), undefined); assert.throws(() => f.service.assertAdmission(ticket), { code: 'MAIN_CONTROL_WORK_DENIED' });
  await until(async () => (await f.status()).state === 'blocked'); await flush(); const state = await f.status();
  assert.equal(state.lastInterruption.actorKnown, false); assert.equal(state.lastInterruption.source, type);
  assert.equal(f.count('send'), 1); assert.equal(f.callbacks.filter(c => c.name === 'stopWorkers').length, 0);
});

test('turn_end.aborted is handled during preparation before first send; unstable session_status is not a Stop proof', async t => {
  const f = await fixture(t, { subscribe: async callback => callback({ type: 'turn_end', aborted: true }, BINDING.sessionPath) });
  const result = await f.service.start({ projectId: PROJECT, authorized: true }, f.creator); await flush();
  assert.equal(result.state, 'blocked'); assert.equal(f.count('send'), 0); assert.equal(f.count('schedule'), 0);
  const g = await fixture(t, { subscribe: async callback => callback({ type: 'session_status', status: 'stopped' }, BINDING.sessionPath) });
  const unsupported = await g.start(); assert.equal(unsupported.state, 'active');
  assert.equal(g.calls.find(c => c.name === 'subscribe').input.types.includes('session_status'), false);
});

test('normal early/end/error classification consumes no content; wrong SID cannot stop the Goal', async t => {
  const f = await fixture(t, { subscribe: async callback => callback({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] }, BINDING.sessionPath) });
  await f.start(); assert.equal(f.count('send'), 1);
  for (const sessionId of ['foreign', null, '']) f.emit({ type: 'turn_end', aborted: true, sessionId });
  await flush(); assert.equal((await f.status()).state, 'active');
  f.end({ messages: [{ role: 'assistant', stopReason: 'error' }] }); await until(async () => (await f.status()).state === 'blocked');
  assert.equal(f.count('send'), 1);
});

test('duplicate schedule delivery and late schedule receipt share exactly one cleanup attempt, not an idempotency assumption', async t => {
  const behavior = {}, f = await fixture(t, behavior), gate = f.gate(); let first;
  behavior.schedule = async record => { if (first) return; first = record; await gate.promise; };
  const starting = f.service.start({ projectId: PROJECT, authorized: true }, f.creator);
  await until(() => first); f.clock.jump(first.runAt); // Exercise delivery-before-ack, without firing control timeout callbacks.
  assert.equal(f.fire(first.scheduleId).status, 'accepted'); assert.equal(f.fire(first.scheduleId).status, 'ignored');
  await until(() => f.count('unschedule') === 1); gate.resolve(); await starting;
  await until(async () => { const s = await f.status(); return s.alarm.id && s.alarm.id !== first.scheduleId; }); await f.settled();
  assert.equal(f.calls.filter(c => c.name === 'unschedule' && c.input.id === first.scheduleId).length, 1);
  assert.equal(f.schedules.has(first.scheduleId), false); assert.notEqual((await f.status()).alarm.id, first.scheduleId);
});

test('early callback before creation receipt keeps one deadline wait when the late creation receipt resolves', async t => {
  const behavior = {}, f = await fixture(t, behavior), receipt = f.gate(); let first;
  behavior.schedule = async record => { if (!first) { first = structuredClone(record); await receipt.promise; } };
  const starting = f.service.start({ projectId: PROJECT, authorized: true }, f.creator);
  await until(() => first);
  assert.equal(f.fire(first.scheduleId).status, 'accepted'); assert.equal(f.fire(first.scheduleId).status, 'ignored'); await flush();
  assert.equal(f.count('send'), 0); assert.equal(f.count('unschedule'), 0); assert.equal(f.count('schedule'), 1);
  assert.equal([...f.clock.timers.values()].filter(timer => timer.at === first.runAt).length, 1);
  receipt.resolve(); await starting; const s = await f.settled(); await f.ack();
  assert.equal(s.alarm.id, first.scheduleId); assert.equal(s.nextControlAt, first.runAt);
  assert.equal(f.clock.timers.size, 1); assert.equal(f.count('send'), 1); assert.equal(f.count('unschedule'), 0);
  f.clock.tick(first.runAt - f.clock.now()); await until(() => f.count('send') === 2); await flush();
  const after = await f.status(); assert.equal(after.nextControlAt, s.nextControlAt + BEAT); assert.equal(after.nextAuditAt, s.nextAuditAt);
  assert.equal(f.count('unschedule'), 1); assert.equal(f.count('schedule'), 2); assert.equal(f.count('getSchedule'), 1); assert.equal(f.clock.timers.size, 0);
});

test('backwards clock during awaited cleanup enters a cancellable second wait without advancing anchored due points', async t => {
  const behavior = {}, f = await fixture(t, behavior), s = await f.start(); await f.ack();
  const cleaning = f.gate(), release = f.gate();
  behavior.unschedule = async () => { cleaning.resolve(); await release.promise; };
  f.clock.jump(s.alarm.runAt); assert.equal(f.fire(s.alarm.id).status, 'accepted'); await cleaning.promise;
  f.clock.jump(s.alarm.runAt - 100); release.resolve();
  await until(() => [...f.clock.timers.values()].some(timer => timer.at === s.alarm.runAt)); await flush();
  const waiting = await f.status(); assert.equal(waiting.alarm.cleanup.removed, true);
  assert.equal(f.clock.timers.size, 1); assert.equal(f.count('send'), 1); assert.equal(f.count('schedule'), 1);
  assert.equal(waiting.nextControlAt, s.nextControlAt); assert.equal(waiting.nextAuditAt, s.nextAuditAt); assert.deepEqual(waiting.due, { control: null, audit: null });
  await f.service.pause({ projectId: PROJECT }, f.creator); await flush(); assert.equal(f.clock.timers.size, 0);
  f.clock.tick(100); await flush(); const after = await f.status();
  assert.equal(after.state, 'paused'); assert.equal(after.nextControlAt, s.nextControlAt); assert.equal(after.nextAuditAt, s.nextAuditAt);
  assert.equal(f.count('send'), 1); assert.equal(f.count('unschedule'), 1); assert.equal(f.count('getSchedule'), 1);
  const disposed = await f.service.dispose(); assert.equal(disposed.cleanupPending, false); assert.deepEqual(disposed.errors, []);
});

test('first schedule cleanup failure is retained, never swallowed or retried on another pause', async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start();
  behavior.unschedule = async () => { throw Object.assign(new Error('PRIVATE_CLEANUP'), { code: 'APP_HOST_ERROR' }); };
  let result = await f.service.pause({ projectId: PROJECT }, f.creator); assert.equal(result.alarm.cleanup.state, 'failed'); assert.equal(result.goalCleanupPending, true);
  result = await f.service.pause({ projectId: PROJECT }, f.creator); assert.equal(f.count('unschedule'), 1);
  await assert.rejects(f.service.resume({ projectId: PROJECT }, f.creator), { code: 'APP_HOST_ERROR' });
  assert.equal(f.count('unschedule'), 1); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CLEANUP/);
});

test('early alarm coalesces locally until its original deadline without moving control/audit anchors', async t => {
  const f = await fixture(t), s = await f.start(); await f.ack();
  assert.equal(f.rawHandler({ kind: 'schedule', scheduleId: s.alarm.id, input: { projectId: PROJECT, goalId: s.goalId, generation: s.generation, token: 'foreign' } }).status, 'ignored');
  assert.equal(f.fire(s.alarm.id).status, 'accepted'); assert.equal(f.fire(s.alarm.id).status, 'ignored'); await flush();
  assert.equal(f.clock.timers.size, 1); assert.equal(f.count('send'), 1); assert.equal(f.count('schedule'), 1);
  const early = await f.status(); assert.equal(early.state, 'active'); assert.equal(early.nextControlAt, s.nextControlAt); assert.equal(early.nextAuditAt, s.nextAuditAt);
  f.clock.tick(BEAT - 1); await flush(); assert.equal(f.count('send'), 1); assert.equal(f.count('unschedule'), 0);
  f.clock.tick(1); await until(() => f.count('send') === 2); await flush();
  const due = await f.status(); assert.equal(due.nextControlAt, s.nextControlAt + BEAT); assert.equal(due.nextAuditAt, s.nextAuditAt);
  assert.equal(f.count('getSchedule'), 1); assert.equal(f.count('unschedule'), 1); assert.equal(f.count('schedule'), 2); assert.equal(f.clock.timers.size, 0);
});

for (const mutation of ['deadline', 'interval', 'id']) test(`alarm rejects wrong ${mutation} receipt before a local wait`, async t => {
  const f = await fixture(t), s = await f.start(), row = f.schedules.get(s.alarm.id);
  if (mutation === 'deadline') row.runAt++;
  if (mutation === 'interval') row.intervalMs = BEAT;
  if (mutation === 'id') row.scheduleId = 'foreign-schedule';
  f.fire(s.alarm.id); await until(async () => (await f.status()).state === 'blocked'); await flush();
  assert.equal((await f.status()).error, 'MAIN_CONTROL_SCHEDULE_UNCONFIRMED'); assert.equal(f.count('send'), 1); assert.equal(f.clock.timers.size, 0);
});

for (const phase of ['receipt', 'wait']) for (const action of ['pause', 'stop', 'resume', 'block', 'dispose'])
test(`${action} cancels an early alarm during ${phase}; late old failures cannot block a new epoch`, async t => {
  const behavior = {}, f = await fixture(t, behavior), s = await f.start(); await f.ack();
  const entered = f.gate(), release = f.gate();
  if (phase === 'receipt') behavior.getSchedule = async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('late old failure'), { code: 'APP_HOST_ERROR' }); };
  f.fire(s.alarm.id);
  if (phase === 'receipt') await entered.promise; else { await flush(); assert.equal(f.clock.timers.size, 1); }
  if (action === 'dispose') {
    const result = await f.service.dispose(); assert.equal(result.cleanupPending, false); assert.deepEqual(result.errors, []);
  } else if (action === 'block') {
    f.emit({ type: 'turn_end', aborted: true }); await until(async () => (await f.status()).state === 'blocked');
  } else {
    await f.service[action === 'resume' ? 'pause' : action]({ projectId: PROJECT }, f.creator);
    if (action === 'resume') { behavior.getSchedule = null; await f.service.resume({ projectId: PROJECT }, f.creator); await f.settled(); }
  }
  await flush(); assert.equal(f.clock.timers.size, 0);
  const sends = f.count('send'); release.resolve(); await flush(); f.clock.tick(BEAT); await flush();
  assert.equal(f.count('send'), sends);
  if (action === 'resume') { const fresh = await f.status(); assert.equal(fresh.state, 'active'); assert.equal(fresh.error, null); assert.equal(fresh.nextControlAt, s.nextControlAt); assert.equal(fresh.nextAuditAt, s.nextAuditAt); }
});

test('early alarm waits beyond native timer range in bounded chunks without changing the anchored deadline', async t => {
  const f = await fixture(t, {}, { now: 3000000000 }), s = await f.start(); await f.ack();
  f.clock.jump(0); f.fire(s.alarm.id); await flush();
  assert.equal(f.clock.timers.size, 1); assert.equal([...f.clock.timers.values()][0].at, 2147483647);
  f.clock.tick(2147483647); await flush();
  assert.equal(f.clock.timers.size, 1); assert.equal([...f.clock.timers.values()][0].at, s.alarm.runAt);
  assert.equal(f.count('send'), 1); assert.equal(f.count('getSchedule'), 1); assert.equal(f.count('schedule'), 1);
  f.clock.tick(s.alarm.runAt - f.clock.now()); await until(() => f.count('send') === 2); await flush();
  assert.equal(f.clock.timers.size, 0); const after = await f.status();
  assert.equal(after.nextControlAt, s.nextControlAt + BEAT); assert.equal(after.nextAuditAt, s.nextAuditAt);
});

test('event schedule ID must agree with its exact receipt even when the receipt itself names the original alarm', async t => {
  const f = await fixture(t), s = await f.start();
  f.schedules.set('foreign-event', structuredClone(f.schedules.get(s.alarm.id)));
  f.rawHandler({ kind: 'schedule', scheduleId: 'foreign-event', input: structuredClone(f.schedules.get(s.alarm.id).payload) });
  await until(async () => (await f.status()).state === 'blocked'); await flush();
  assert.equal((await f.status()).error, 'MAIN_CONTROL_SCHEDULE_UNCONFIRMED'); assert.equal(f.count('send'), 1); assert.equal(f.clock.timers.size, 0);
});

test('long early waits recheck a backwards wallclock and retain the same deadline without status polling', async t => {
  const f = await fixture(t), s = await f.start(); await f.ack(); f.fire(s.alarm.id); await flush();
  const first = [...f.clock.timers.entries()][0]; assert.equal(first[1].at, s.alarm.runAt);
  f.clock.jump(s.alarm.runAt - 100); f.clock.timers.delete(first[0]); first[1].fn(); await flush();
  assert.equal(f.clock.timers.size, 1); assert.equal([...f.clock.timers.values()][0].at, s.alarm.runAt);
  assert.equal(f.count('send'), 1); assert.equal(f.count('getSchedule'), 1); assert.equal(f.count('schedule'), 1);
  f.clock.tick(100); await until(() => f.count('send') === 2); await flush(); assert.equal(f.clock.timers.size, 0);
});

test('legacy work admission stays open; opaque tickets are invalidated by Goal creation or epoch changes', async t => {
  const f = await fixture(t); assert.equal((await f.status()).managed, false);
  const legacy = f.service.admit(PROJECT); assert.equal(f.service.assertAdmission(legacy), true);
  await f.start(); assert.throws(() => f.service.assertAdmission(legacy), { code: 'MAIN_CONTROL_WORK_DENIED' });
  const ticket = f.service.admit(PROJECT); assert.equal(f.service.assertAdmission(ticket), true);
  assert.throws(() => f.service.assertAdmission({ ...ticket }), { code: 'MAIN_CONTROL_WORK_DENIED' });
  await f.service.pause({ projectId: PROJECT }, f.main); assert.throws(() => f.service.assertAdmission(ticket), { code: 'MAIN_CONTROL_WORK_DENIED' });
  assert.throws(() => f.service.admit(PROJECT), { code: 'MAIN_CONTROL_WORK_DENIED' });
});

test('workerStop completion requires bound-main canonical fact receipts and stops workers using that same real ctx', async t => {
  const behavior = {}, f = await fixture(t, behavior), s = await f.start(), args = { ...f.args(s), factIds: ['aaaaaaaaaaaaaaaa'] };
  await assert.rejects(f.service.complete(args, f.creator), { code: 'MAIN_CONTROL_FORBIDDEN' });
  behavior.verify = async input => ({ verified: false, ...input });
  await assert.rejects(f.service.complete(args, f.main), { code: 'MAIN_CONTROL_COMPLETION_UNVERIFIED' }); assert.equal((await f.status()).state, 'active');
  behavior.verify = async input => ({ verified: true, ...input }); behavior.stopWorkers = async () => ({ requested: true, cleanupPending: true });
  const result = await f.service.complete(args, f.main); assert.equal(result.state, 'completed'); assert.deepEqual(result.completion.factIds, args.factIds);
  assert.equal(result.workerStop.cleanupPending, true); assert.equal(result.workerCleanupKnown, true);
  assert.equal(result.workerStopScope.generation, result.workerStop.generation);
  assert.deepEqual(result.workerStopScope.targets, [{ workerId: 'worker-1', runId: null, complete: true }]);
  assert.strictEqual(f.callbacks.find(c => c.name === 'stopWorkers').ctx, f.main); assert.equal(f.count('send'), 1);
  await assert.rejects(f.service.resume({ projectId: PROJECT }, f.creator), { code: 'MAIN_CONTROL_NOT_RESUMABLE' });
});

test('completion rechecks its captured epoch after await, even if caller mutates original args', async t => {
  const behavior = {}, f = await fixture(t, behavior), gate = f.gate(), s = await f.start();
  behavior.verify = async input => { await gate.promise; return { verified: true, ...input }; };
  const args = { ...f.args(s), factIds: ['bbbbbbbbbbbbbbbb'] }; const completing = assert.rejects(f.service.complete(args, f.main), { code: 'MAIN_CONTROL_STALE' });
  await until(() => f.callbacks.some(c => c.name === 'verify')); const paused = await f.service.pause({ projectId: PROJECT }, f.creator);
  args.generation = paused.generation; gate.resolve(); await completing;
  assert.equal((await f.status()).state, 'paused'); assert.equal(f.callbacks.filter(c => c.name === 'stopWorkers').length, 0);
});

test('recovery uses formal schedule receipts and blocks pending/unknown sends rather than replaying them', async t => {
  const f = await fixture(t); await f.start(); const files = new Map(f.files), schedules = new Map(f.schedules);
  const key = BASE + '/' + PROJECT + '.json', record = JSON.parse(files.get(key)); record.send.state = 'pending'; files.set(key, JSON.stringify(record));
  const g = await fixture(t, {}, { files, schedules, now: f.clock.now() }); const state = await g.status();
  assert.equal(state.state, 'blocked'); assert.equal(state.send.state, 'unknown'); assert.equal(g.count('send'), 0);
  assert.equal(g.count('getSchedule'), 1); assert.equal(g.count('unschedule'), 1);
  await assert.rejects(g.service.resume({ projectId: PROJECT }, g.creator), { code: 'MAIN_CONTROL_SEND_UNSETTLED' });
});

test('recovery of a known accepted send still needs creator resume; past boundaries are not reset', async t => {
  const f = await fixture(t), original = await f.start(); await f.ack();
  const g = await fixture(t, {}, { files: new Map(f.files), schedules: new Map(f.schedules), now: f.clock.now() + BEAT + 5 });
  const blocked = await g.status(); assert.equal(blocked.state, 'blocked'); assert.equal(g.count('send'), 0);
  await assert.rejects(g.service.resume({ projectId: PROJECT }, g.main), { code: 'MAIN_CONTROL_FORBIDDEN' });
  await g.service.resume({ projectId: PROJECT }, g.creator); const resumed = await g.settled();
  assert.equal(resumed.nextControlAt, original.nextControlAt + BEAT); assert.equal(resumed.nextAuditAt, original.nextAuditAt);
  assert.equal(resumed.due.audit, null); assert.equal(g.count('send'), 1);
});

test('M04 diagnostic is a synchronous memory-only whitelist with no caller authorization or I/O', async t => {
  const f = await fixture(t); assert.equal(f.service.diagnostic(PROJECT), null);
  await f.start({ restartAuthorization: { resume: 'preserve-budget' }, maxAutomaticContinues: 2 });
  const files = new Map(f.files), calls = f.calls.length, callbacks = f.callbacks.length;
  const result = f.service.diagnostic(PROJECT);
  assert.equal(result.state, 'active'); assert.equal(result.budgetExhausted, false);
  assert.equal(result.restartAuthorization, 'preserve-budget'); assert.equal(result.priorActive, 'unknown');
  assert.equal(result.sendState, 'accepted'); assert.equal(result.cleanupPending, false);
  assert.equal(f.calls.length, calls); assert.equal(f.callbacks.length, callbacks); assert.deepEqual(f.files, files);
  assert.doesNotMatch(JSON.stringify(result), /opaque-|sessionPath|agentId|model|prompt|callToken/);
  const invalid = await fixture(t, {}, { files: new Map([[`${BASE}/${PROJECT}.json`, '{}']]) });
  assert.deepEqual(invalid.service.diagnostic(PROJECT), { state: 'invalid', error: { code: 'MAIN_CONTROL_RECORD_INVALID' } });
});

test('D04 restart authorization is start-only, strict and absent from legacy records', async t => {
  const f = await fixture(t);
  for (const restartAuthorization of [null, {}, { resume: 'auto' }, { resume: 'preserve-budget', extra: true }]) {
    await assert.rejects(f.service.start({ projectId: PROJECT, authorized: true, restartAuthorization }, f.creator), { code: 'MAIN_CONTROL_INVALID_INPUT' });
  }
  await f.start(); assert.equal(Object.hasOwn(await f.status(), 'restartAuthorization'), false);
  await f.service.pause({ projectId: PROJECT }, f.creator);
  await assert.rejects(f.service.resume({ projectId: PROJECT, restartAuthorization: { resume: 'preserve-budget' } }, f.creator), { code: 'MAIN_CONTROL_INVALID_INPUT' });
});

test('D04 authorized crash recovery is deferred, shared once, preserves budget and anchored reviews', async t => {
  const f = await fixture(t), original = await f.start({ restartAuthorization: { resume: 'preserve-budget' }, maxAutomaticContinues: 3 });
  const files = new Map(f.files), key = `${BASE}/${PROJECT}.json`, saved = JSON.parse(files.get(key));
  saved.continuationBudget.reserved = 1; files.set(key, JSON.stringify(saved));
  const g = await fixture(t, {}, { files, schedules: new Map(f.schedules), now: f.clock.now() });
  assert.equal(g.count('send'), 0); assert.equal((await g.status()).state, 'blocked');
  const first = g.service.activateRestarts(); assert.strictEqual(g.service.activateRestarts(), first); await first;
  const result = await g.settled(); assert.equal(result.state, 'active'); assert.ok(result.generation > original.generation);
  assert.deepEqual(result.continuationBudget, { limit: 3, reserved: 1 });
  assert.equal(result.nextControlAt, original.nextControlAt); assert.equal(result.nextAuditAt, original.nextAuditAt);
  assert.equal(g.callbacks.filter(c => c.name === 'recoveryReadiness').length, 2);
  assert.equal(g.callbacks.filter(c => c.name === 'binding').length, 0);
  assert.equal(g.count('send'), 1); assert.match(g.calls.find(c => c.name === 'send').input.text, /first read math_project status/);
  assert.equal(result.due.control.generation, result.generation);
});

test('D04 normal dispose writes only a clean three-field intent, consumed exactly once', async t => {
  const f = await fixture(t); await f.start({ restartAuthorization: { resume: 'preserve-budget' } });
  assert.equal((await f.service.dispose()).cleanupPending, false);
  const meta = JSON.parse(f.files.get(`${BASE}/${PROJECT}.json`));
  assert.deepEqual(meta.restartIntent, { goalId: meta.goalId, generation: meta.generation, priorActive: true });
  const g = await fixture(t, { recoveryReadiness: async () => { throw Object.assign(new Error('fixture'), { code: 'PROJECT_WORKER_UNSETTLED' }); } },
    { files: new Map(f.files), schedules: new Map(f.schedules), now: f.clock.now() });
  assert.equal(g.count('send'), 0); await g.service.activateRestarts();
  assert.equal((await g.status()).error, 'PROJECT_WORKER_UNSETTLED');
  assert.equal(Object.hasOwn(await g.status(), 'restartIntent'), false);
  const h = await fixture(t, {}, { files: new Map(g.files), schedules: new Map(g.schedules), now: g.clock.now() });
  await h.service.activateRestarts(); assert.equal(h.callbacks.filter(c => c.name === 'recoveryReadiness').length, 0); assert.equal(h.count('send'), 0);
});

for (const gate of ['budget', 'send', 'worker-cleanup', 'marker', 'marker-generation']) test(`D04 restart gate ${gate} stays blocked without arming or sending`, async t => {
  const f = await fixture(t); await f.start({ restartAuthorization: { resume: 'preserve-budget' }, maxAutomaticContinues: 1 });
  const files = new Map(f.files), key = `${BASE}/${PROJECT}.json`, meta = JSON.parse(files.get(key));
  if (gate === 'budget') meta.continuationBudget.reserved = 1;
  if (gate === 'send') meta.send.state = 'pending';
  if (gate === 'worker-cleanup') meta.workerStop = { state: 'requested', cleanupPending: null };
  if (gate === 'marker' || gate === 'marker-generation') {
    meta.state = 'blocked'; meta.error = 'MAIN_CONTROL_DISPOSED';
    meta.restartIntent = { goalId: gate === 'marker' ? 'goal-foreign' : meta.goalId,
      generation: meta.generation + (gate === 'marker-generation' ? 1 : 0), priorActive: true };
  }
  files.set(key, JSON.stringify(meta));
  const g = await fixture(t, {}, { files, schedules: new Map(f.schedules), now: f.clock.now() }); await g.service.activateRestarts();
  const result = await g.status(); assert.equal(result.state, 'blocked'); assert.equal(g.count('schedule'), 0); assert.equal(g.count('send'), 0);
  assert.equal(g.callbacks.filter(c => c.name === 'recoveryReadiness').length, 0);
  assert.deepEqual(result.continuationBudget, meta.continuationBudget);
  if (gate === 'budget') { assert.equal(result.waitReason, 'continuation-budget'); assert.equal(result.waiting, true); }
  if (gate === 'send') assert.equal(result.send.state, 'unknown');
});

test('D04 queued restart candidate keeps its load epoch when another candidate delays activation', async t => {
  const f = await fixture(t); await f.start({ restartAuthorization: { resume: 'preserve-budget' } });
  const secondId = 'project-second', files = new Map(f.files), second = JSON.parse(files.get(`${BASE}/${PROJECT}.json`));
  // Two opaque Goal records share the fixture SID only for this controller
  // race; this is not evidence of a valid multi-project Host binding.
  Object.assign(second, { projectId: secondId, goalId: 'goal-second', alarm: null });
  files.set(`${BASE}/${secondId}.json`, JSON.stringify(second));
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const g = await fixture(t, { recoveryReadiness: async ({ projectId }) => {
    assert.equal(projectId, PROJECT, 'Creator-changed second candidate must not reach restart readiness');
    entered.resolve(); await release.promise; return { ready: true };
  }, send: async (_input, count) => ({ accepted: count !== 1, sessionId: BINDING.sessionId, sessionPath: BINDING.sessionPath }) },
  { files, schedules: new Map(f.schedules), now: f.clock.now() });
  const loaded = await g.service.status({ projectId: secondId }, g.creator);
  const activation = g.service.activateRestarts(); await entered.promise;
  await g.service.resume({ projectId: secondId }, g.creator);
  await until(async () => { const s = await g.service.status({ projectId: secondId }, g.creator); return s.state === 'blocked' && !s.sendInFlight; });
  const changed = await g.service.status({ projectId: secondId }, g.creator);
  assert.ok(changed.generation > loaded.generation); assert.equal(changed.error, 'MAIN_CONTROL_SEND_REJECTED');
  const schedules = g.calls.filter(c => c.name === 'schedule' && c.input.payload.projectId === secondId).length;
  release.resolve(); await activation; await g.settled();
  const result = await g.service.status({ projectId: secondId }, g.creator);
  assert.equal(result.state, 'blocked'); assert.equal(result.generation, changed.generation); assert.equal(result.error, changed.error);
  assert.deepEqual(result.send, changed.send);
  assert.equal(g.callbacks.filter(c => c.name === 'recoveryReadiness' && c.input.projectId === secondId).length, 0);
  assert.equal(g.calls.filter(c => c.name === 'schedule' && c.input.payload.projectId === secondId).length, schedules);
  assert.equal(g.count('send'), 2); // One rejected explicit send; one first-candidate restart send.
});

test('D04 late readiness failure cannot block a newer explicit creator epoch', async t => {
  const f = await fixture(t); await f.start({ restartAuthorization: { resume: 'preserve-budget' } });
  const entered = deferred(), release = deferred();
  const g = await fixture(t, { recoveryReadiness: async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('fixture'), { code: 'PROJECT_MAIN_DENIED' }); } },
    { files: new Map(f.files), schedules: new Map(f.schedules), now: f.clock.now() });
  const activation = g.service.activateRestarts(); await entered.promise;
  await g.service.resume({ projectId: PROJECT }, g.creator); const newer = await g.settled();
  release.resolve(); await activation;
  const result = await g.status(); assert.equal(result.state, 'active'); assert.equal(result.generation, newer.generation); assert.equal(result.error, null);
});

test('D04 failed dispose cleanup and invalid persisted authorization cannot authorize a restart', async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start({ restartAuthorization: { resume: 'preserve-budget' } });
  behavior.unschedule = async () => { throw Object.assign(new Error('fixture'), { code: 'APP_HOST_ERROR' }); };
  assert.equal((await f.service.dispose()).cleanupPending, true);
  const files = new Map(f.files), key = `${BASE}/${PROJECT}.json`, meta = JSON.parse(files.get(key));
  assert.equal(Object.hasOwn(meta, 'restartIntent'), false);
  meta.restartAuthorization = { resume: 'auto' }; files.set(key, JSON.stringify(meta));
  const g = await fixture(t, {}, { files, now: f.clock.now() }); await g.service.activateRestarts();
  await assert.rejects(g.status(), { code: 'MAIN_CONTROL_RECORD_INVALID' }); assert.equal(g.count('send'), 0);
});

test('D04 second idle observation can refuse before pending send, without retrying', async t => {
  const f = await fixture(t); await f.start({ restartAuthorization: { resume: 'preserve-budget' } });
  let reads = 0;
  const g = await fixture(t, { recoveryReadiness: async () => {
    if (++reads === 2) throw Object.assign(new Error('fixture'), { code: 'MAIN_CONTROL_MAIN_NOT_IDLE' }); return { ready: true };
  } }, { files: new Map(f.files), schedules: new Map(f.schedules), now: f.clock.now() });
  const send = (await g.status()).send; await g.service.activateRestarts();
  const result = await g.status(); assert.equal(result.state, 'blocked'); assert.equal(result.error, 'MAIN_CONTROL_MAIN_NOT_IDLE');
  assert.deepEqual(result.send, send); assert.equal(g.count('send'), 0); assert.equal(g.count('schedule'), 0);
  await g.service.activateRestarts(); assert.equal(reads, 2);
});

for (const state of ['none', 'paused', 'stopped', 'completed']) test(`D04 ${state} dispose cannot produce a restart intent`, async t => {
  const f = await fixture(t); const active = await f.start(state === 'none' ? {} : { restartAuthorization: { resume: 'preserve-budget' } });
  if (state === 'paused') await f.service.pause({ projectId: PROJECT }, f.creator);
  if (state === 'stopped') await f.service.stop({ projectId: PROJECT }, f.creator);
  if (state === 'completed') await f.service.complete({ ...f.args(active), factIds: ['a'.repeat(16)] }, f.main);
  await f.service.dispose(); assert.equal(Object.hasOwn(JSON.parse(f.files.get(`${BASE}/${PROJECT}.json`)), 'restartIntent'), false);
});

test('damaged partial Goal never becomes an unrestricted legacy project', async t => {
  const files = new Map([[BASE + '/' + PROJECT + '.json', JSON.stringify({ schemaVersion: 1, projectId: PROJECT })]]);
  const f = await fixture(t, {}, { files });
  await assert.rejects(f.status(), { code: 'MAIN_CONTROL_RECORD_INVALID' }); assert.throws(() => f.service.admit(PROJECT), { code: 'MAIN_CONTROL_RECORD_INVALID' });
  assert.equal(f.count('send'), 0); assert.equal(f.count('schedule'), 0);
});

test('persistence failure closes admission and prevents sends; tokens and raw errors are never recorded', async t => {
  const behavior = {}, f = await fixture(t, behavior); behavior.write = async () => { throw Object.assign(new Error('PRIVATE_WRITE'), { code: 'EIO' }); };
  await assert.rejects(f.service.start({ projectId: PROJECT, authorized: true }, f.creator), { code: 'EIO' });
  assert.equal(f.count('send'), 0); assert.equal(f.count('schedule'), 0); assert.throws(() => f.service.admit(PROJECT), { code: 'MAIN_CONTROL_WORK_DENIED' });
  const status = await f.status(); assert.equal(status.persistenceFailed, true); assert.doesNotMatch(JSON.stringify(status), /PRIVATE_WRITE|opaque-creator-token/);
  behavior.write = null;
});

test('wait fences older queued agent_start/end callbacks, not just already processed events', async t => {
  const behavior = {}, f = await fixture(t, behavior); const s = await f.start(); await f.ack();
  const gate = f.gate(); let entered = false;
  behavior.write = async () => { if (!entered) { entered = true; await gate.promise; } };
  f.emit({ type: 'agent_start' }); await until(() => entered);
  f.emit({ type: 'agent_start' }); f.end();
  const waiting = f.service.wait(f.args(s), f.main);
  await until(() => f.callbacks.some(c => c.name === 'authorize' && c.input.action === 'wait'));
  await flush(); gate.resolve(); await waiting; await flush();
  assert.equal((await f.status()).waiting, true); assert.equal(f.count('send'), 1);
});

for (const pending of [false, true]) test(`formal asynchronous send error ${pending ? 'before' : 'after'} acceptance is retained without reading raw payload`, async t => {
  const behavior = {}, f = await fixture(t, behavior), gate = f.gate();
  if (pending) behavior.send = async () => { await gate.promise; return { accepted: true, sessionPath: BINDING.sessionPath }; };
  await f.service.start({ projectId: PROJECT, authorized: true }, f.creator); await until(() => f.count('send') === 1);
  if (!pending) await f.settled();
  for (const change of [{ source: 'foreign' }, { sessionId: 'foreign' }, { sessionId: null }]) f.emit({ type: 'error', source: 'session:send', ...change });
  await flush(); assert.equal((await f.status()).state, 'active');
  const event = { type: 'error', source: 'session:send' }; Object.defineProperty(event, 'error', { get() { assert.fail('Private error payload'); } });
  f.emit(event); assert.throws(() => f.service.admit(PROJECT), { code: 'MAIN_CONTROL_WORK_DENIED' });
  await until(async () => (await f.status()).state === 'blocked'); gate.resolve();
  await until(async () => !(await f.status()).sendInFlight); await flush();
  const result = await f.status(); assert.equal(result.send.state, 'unknown'); assert.equal(result.send.acceptance, 'accepted');
  assert.equal(result.send.completionError, 'MAIN_CONTROL_SEND_COMPLETION_FAILED'); assert.equal(f.count('send'), 1);
  await assert.rejects(f.service.resume({ projectId: PROJECT }, f.creator), { code: 'MAIN_CONTROL_SEND_UNSETTLED' });
});

test('asynchronous send error after pause preserves a late unknown instead of claiming withdrawal', async t => {
  const f = await fixture(t); await f.start(); await f.service.pause({ projectId: PROJECT }, f.creator);
  f.emit({ type: 'error', source: 'session:send' }); await flush(); const result = await f.status();
  assert.equal(result.state, 'paused'); assert.equal(result.send.state, 'unknown'); assert.equal(result.lateDelivery.state, 'unknown');
  assert.equal(result.goalCleanupPending, true); assert.equal(f.count('send'), 1);
});

test('pause before schedule acknowledgement cleans its late receipt once and sends nothing', async t => {
  const behavior = {}, f = await fixture(t, behavior), gate = f.gate(); let scheduled;
  behavior.schedule = async record => { scheduled = record; await gate.promise; };
  const starting = f.service.start({ projectId: PROJECT, authorized: true }, f.creator);
  await until(() => scheduled); const paused = await f.service.pause({ projectId: PROJECT }, f.creator);
  assert.equal(paused.goalCleanupPending, true); assert.equal(f.count('unschedule'), 0);
  gate.resolve(); await starting; await flush(); const result = await f.status();
  assert.equal(result.state, 'paused'); assert.equal(result.alarm.id, null); assert.equal(result.alarm.cleanup.removed, true);
  assert.equal(f.count('unschedule'), 1); assert.equal(f.count('send'), 0);
});

for (const outcome of ['rejected', 'foreign', 'throw']) test(`send ${outcome} blocks without a second automatic attempt`, async t => {
  const behavior = { send: async () => {
    if (outcome === 'throw') throw Object.assign(new Error('PRIVATE_TRANSPORT'), { code: 'OPAQUE_TRANSPORT_ERROR' });
    return outcome === 'rejected' ? { accepted: false, sessionPath: BINDING.sessionPath } : { accepted: true, sessionPath: '/foreign' };
  } };
  const f = await fixture(t, behavior); await f.service.start({ projectId: PROJECT, authorized: true }, f.creator);
  await until(async () => (await f.status()).state === 'blocked'); await flush(); const result = await f.status();
  assert.equal(result.send.state, outcome === 'rejected' ? 'rejected' : 'unknown'); assert.equal(f.count('send'), 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TRANSPORT/);
});

test('workerStop scope capture is synchronous, immutable and persisted with intent before stop cleanup', async t => {
  const source = { targets: [{ workerId: 'worker-1', runId: 'run-original', complete: true }] }, behavior = { capture: () => source };
  const f = await fixture(t, behavior); await f.start(); const writing = f.gate(), release = f.gate(); let first;
  behavior.write = async record => { if (!first && record.workerStop.state === 'pending') { first = record; writing.resolve(); await release.promise; } };
  const stopping = f.service.stop({ projectId: PROJECT }, f.creator); await writing.promise;
  assert.equal(f.callbacks.filter(row => row.name === 'captureWorkerStopScope').length, 1);
  assert.equal(f.callbacks.filter(row => row.name === 'stopWorkers').length, 0);
  assert.equal((await f.status()).workerStopReconciliation.state, 'unknown', 'Pending receipt is not settlement proof');
  assert.equal(first.workerStopScope.generation, first.workerStop.generation); assert.equal(first.workerStopScope.targets[0].runId, 'run-original');
  source.targets[0].runId = 'run-later'; release.resolve();
  const result = await stopping; assert.equal(result.workerStopScope.targets[0].runId, 'run-original');
  assert.equal(result.workerStop.state, 'requested'); assert.equal(result.workerStopReconciliation.state, 'settled');
});

for (const capture of [() => { throw new Error('PRIVATE_CAPTURE'); }, () => Promise.resolve({ targets: [] }), () => ({ targets: [] })])
  test('workerStop failed, async or malformed capture preserves stop success and labels settled receipt-only proof', async t => {
    const f = await fixture(t, { capture }); await f.start();
    const result = await f.service.stop({ projectId: PROJECT }, f.creator);
    assert.equal(result.state, 'stopped'); assert.deepEqual(result.workerStop, { state: 'requested', generation: result.generation, cleanupPending: false });
    assert.equal(result.workerStopScope, null); assert.equal(result.workerStopReconciliation.state, 'settled');
    assert.equal(result.workerStopReconciliation.source, 'receipt'); assert.equal(result.workerStopReconciliation.targets, null);
    assert.equal(f.callbacks.filter(row => row.name === 'observeWorkerStopScope').length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CAPTURE/);
  });

test('workerStop synchronous observer exceptions, async and malformed outputs stay unknown without writes', async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start(); await f.service.stop({ projectId: PROJECT }, f.creator);
  const files = new Map(f.files), writes = f.writes.length, stops = f.callbacks.filter(row => row.name === 'stopWorkers').length;
  for (const observe of [() => { throw new Error('PRIVATE_OBSERVER'); }, () => Promise.resolve({}), () => ({ projectId: PROJECT, targets: [{}] })]) {
    behavior.observe = observe; const result = await f.status();
    assert.equal(result.workerStopReconciliation.state, 'unknown'); assert.equal(result.workerStopReconciliation.source, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OBSERVER/);
  }
  assert.deepEqual(f.files, files); assert.equal(f.writes.length, writes); assert.equal(f.callbacks.filter(row => row.name === 'stopWorkers').length, stops);
});

test('workerStop an old cleanup completion cannot overwrite the newer stop scope', async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start(); const entered = f.gate(), release = f.gate();
  behavior.capture = () => ({ targets: [{ workerId: 'worker-1', runId: 'run-original', complete: true }] });
  behavior.unschedule = async () => { entered.resolve(); await release.promise; };
  const first = f.service.stop({ projectId: PROJECT }, f.creator); await entered.promise;
  await until(async () => (await f.status()).workerStop.state === 'requested');
  const old = await f.status(); behavior.capture = () => ({ targets: [{ workerId: 'worker-1', runId: 'run-next', complete: true }] });
  const second = f.service.stop({ projectId: PROJECT }, f.creator);
  await until(() => f.callbacks.filter(row => row.name === 'stopWorkers').length === 2); release.resolve();
  const [late, current] = await Promise.all([first, second]);
  assert.ok(current.workerStopScope.generation > old.workerStopScope.generation);
  assert.equal(current.workerStopScope.targets[0].runId, 'run-next'); assert.deepEqual(late.workerStopScope, current.workerStopScope);
});

test('workerStop observer cannot attach a prior epoch result after synchronous disposal', async t => {
  const behavior = {}, f = await fixture(t, behavior); await f.start(); await f.service.stop({ projectId: PROJECT }, f.creator);
  behavior.observe = input => { void f.service.dispose(); return { projectId: PROJECT, targets: input.scope.targets.map(target => ({ ...target, state: 'settled', reasons: [] })) }; };
  const result = await f.status(); assert.equal(result.workerStopReconciliation.state, 'unknown');
  assert.deepEqual(result.workerStopReconciliation.reasons, ['WORKER_STOP_OBSERVATION_CHANGED']);
});

async function workerStopRestartFixture(t, behavior = {}) {
  const f = await fixture(t, { stopWorkers: async () => ({ requested: true, cleanupPending: true }),
    capture: () => ({ targets: [{ workerId: 'worker-1', runId: 'run-old', complete: true }] }), ...behavior });
  await f.start({ restartAuthorization: { resume: 'preserve-budget' }, maxAutomaticContinues: 3 });
  const stopped = await f.service.stop({ projectId: PROJECT }, f.creator);
  await f.service.resume({ projectId: PROJECT }, f.creator); await f.settled(); await f.ack();
  await f.service.wait(f.args(await f.status()), f.main);
  return { f, stopped };
}

test('workerStop recovery resumes the former stale-receipt dead end after clean dispose or a crash without changing history or budget', async t => {
  const { f, stopped } = await workerStopRestartFixture(t);
  await f.service.continue_work(f.args(await f.status()), f.main); await automaticContinue(f);
  await f.service.wait(f.args(await f.status()), f.main);
  const original = await f.status(); assert.equal(original.continuationBudget.reserved, 1);
  assert.equal(original.workerStop.cleanupPending, true); assert.equal(original.workerStopReconciliation.state, 'settled');
  const crashFiles = new Map(f.files), crashSchedules = new Map(f.schedules), stopCount = f.callbacks.filter(row => row.name === 'stopWorkers').length;
  await f.service.dispose(); const saved = JSON.parse(f.files.get(`${BASE}/${PROJECT}.json`));
  assert.deepEqual(saved.restartIntent, { goalId: saved.goalId, generation: saved.generation, priorActive: true });
  assert.deepEqual(saved.workerStop, stopped.workerStop); assert.deepEqual(saved.workerStopScope, stopped.workerStopScope);
  assert.deepEqual(saved.continuationBudget, original.continuationBudget);
  assert.equal(f.callbacks.filter(row => row.name === 'stopWorkers').length, stopCount);
  const observations = f.callbacks.filter(row => row.name === 'observeWorkerStopScope');
  assert.equal(observations.filter(row => row.input.disposeCheck === true).length, 2, 'Eligibility and post-unregister checks are fresh');
  assert.equal(f.service.diagnostic(PROJECT).workerStopReconciliation.state, 'unknown');
  assert.equal(f.callbacks.filter(row => row.name === 'observeWorkerStopScope').length, observations.length, 'Ordinary disposed diagnostics cannot use the private check');
  await assert.rejects(f.status(), { code: 'MAIN_CONTROL_DISPOSED' });
  for (const seed of [{ files: new Map(f.files), schedules: new Map(f.schedules) }, { files: crashFiles, schedules: crashSchedules }]) {
    const reopened = await fixture(t, {}, { ...seed, now: f.clock.now() });
    const activation = reopened.service.activateRestarts(); assert.strictEqual(reopened.service.activateRestarts(), activation); await activation;
    const current = await reopened.settled(); assert.equal(current.state, 'active'); assert.equal(reopened.count('send'), 1);
    assert.deepEqual(current.workerStop, stopped.workerStop); assert.deepEqual(current.workerStopScope, stopped.workerStopScope);
    assert.deepEqual(current.continuationBudget, original.continuationBudget);
    assert.equal(reopened.callbacks.filter(row => row.name === 'recoveryReadiness').length, 2);
    assert.equal(reopened.callbacks.filter(row => row.name === 'stopWorkers').length, 0);
  }
});

for (const changed of ['epoch', 'goal', 'scope-identity', 'scope-bytes', 'receipt', 'main']) test(`workerStop restart dispose rejects ${changed} changes across handler unregistration`, async t => {
  const { f } = await workerStopRestartFixture(t), entered = deferred(), release = deferred(); t.after(() => release.resolve()); let meta;
  const behavior = { read: record => { meta = record; }, disposeHandler: async () => { entered.resolve(); await release.promise; } };
  const g = await fixture(t, behavior, { files: new Map(f.files), schedules: new Map(f.schedules), now: f.clock.now() });
  await g.service.resume({ projectId: PROJECT }, g.creator); await g.settled();
  const closing = g.service.dispose(); await entered.promise;
  if (changed === 'epoch') meta.generation++;
  if (changed === 'goal') meta.goalId = 'goal-newer';
  if (changed === 'scope-identity') meta.workerStopScope = structuredClone(meta.workerStopScope);
  if (changed === 'scope-bytes') meta.workerStopScope.targets[0].complete = false;
  if (changed === 'receipt') meta.workerStop = { ...meta.workerStop };
  if (changed === 'main') meta.main = { ...meta.main };
  release.resolve(); await closing;
  assert.equal(Object.hasOwn(JSON.parse(g.files.get(`${BASE}/${PROJECT}.json`)), 'restartIntent'), false);
});

for (const gate of ['budget', 'readiness-unknown', 'second-idle', 'scope-after-readiness', 'scope-before-send']) test(`workerStop restart settled scope does not bypass ${gate}`, async t => {
  const { f } = await workerStopRestartFixture(t), files = new Map(f.files), key = `${BASE}/${PROJECT}.json`, meta = JSON.parse(files.get(key));
  if (gate === 'budget') { meta.continuationBudget.reserved = meta.continuationBudget.limit; files.set(key, JSON.stringify(meta)); }
  let reads = 0, state = 'settled';
  const behavior = { observe: input => ({ projectId: input.projectId, targets: input.scope.targets.map(target => ({ ...target, state,
    reasons: state === 'settled' ? [] : ['WORKER_STOP_RUN_PENDING'] })) }), recoveryReadiness: async () => {
    reads++;
    if (gate === 'readiness-unknown') return { ready: 'unknown' };
    if (gate === 'second-idle' && reads === 2) throw Object.assign(new Error('fixture idle changed'), { code: 'MAIN_CONTROL_MAIN_NOT_IDLE' });
    if (gate === 'scope-after-readiness' || gate === 'scope-before-send' && reads === 2) state = 'pending';
    return { ready: true };
  } };
  const g = await fixture(t, behavior, { files, schedules: new Map(f.schedules), now: f.clock.now() });
  await g.service.activateRestarts(); const current = await g.status();
  assert.equal(current.state, 'blocked'); assert.equal(g.count('send'), 0);
  assert.deepEqual(current.continuationBudget, meta.continuationBudget); assert.deepEqual(current.workerStop, meta.workerStop);
  assert.equal(current.error, gate === 'budget' ? 'MAIN_CONTROL_CONTINUATION_BUDGET_EXHAUSTED'
    : gate === 'readiness-unknown' ? 'MAIN_CONTROL_RECOVERY_NOT_READY' : gate === 'second-idle' ? 'MAIN_CONTROL_MAIN_NOT_IDLE' : 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED');
  const count = reads; await g.service.activateRestarts(); assert.equal(reads, count, 'Startup candidates are consumed once');
});

for (const receiptState of ['pending', 'unknown']) test(`workerStop restart cannot use scope proof with a ${receiptState} receipt`, async t => {
  const { f } = await workerStopRestartFixture(t), files = new Map(f.files), key = `${BASE}/${PROJECT}.json`, meta = JSON.parse(files.get(key));
  meta.workerStop.state = receiptState; files.set(key, JSON.stringify(meta));
  const g = await fixture(t, {}, { files, schedules: new Map(f.schedules), now: f.clock.now() });
  await g.service.activateRestarts(); assert.equal((await g.status()).error, 'MAIN_CONTROL_WORKER_STOP_UNCONFIRMED'); assert.equal(g.count('send'), 0);
});
