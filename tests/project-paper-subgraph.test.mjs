// Software fixtures only. The service reaches canonical text solely via the
// genuine creator result/Core FIFO; no writer/model or production injection API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, origin, defer, APP } from './helpers/project-service-fixture.mjs';

const A = '0000000000000001', B = '0000000000000002', C = '0000000000000003', D = '0000000000000004', E = '0000000000000005';
const make = (id, predecessors = []) => ({ fact_id: id, predecessors,
  markdown: `---\nfact_id: ${id}\npredecessors: [${predecessors.join(', ')}]\nglossary_introduces:\n  z: PRIVATE_DEFINITION\n  a: PRIVATE_DEFINITION\nexternal_refs: [{"title":"PRIVATE_REFERENCE"}]\n---\n## statement\nVisible ${id}.\nSecond line mentions a proof legitimately.\n## proof\nPROOF_SENTINEL\n## intuition\nINTUITION_SENTINEL\n` });
const allFacts = () => [make(E), make(D, [B, C]), make(C, [A]), make(B, [A]), make(A)];
const denied = (promise, code) => assert.rejects(promise, { code });

async function setup(t, { target = true } = {}) {
  const state = { beforeCore: null }; let canonical;
  const f = await fixture(t, { multiWorker: true, summaryWriter: { start() { assert.fail('no writer may start'); } },
    async coreCall(binding, operation, args) {
      await state.beforeCore?.(operation, args);
      const facts = JSON.parse(await fs.readFile(canonical, 'utf8'));
      if (operation === 'fact_list_page') return { facts };
      assert.equal(operation, 'fact_get'); const fact = facts.find(f => f.fact_id === args.fact_id);
      if (!fact) throw Object.assign(new Error('software missing fact'), { code: 'PROJECT_CORE_INVALID_RESULT' });
      return fact;
    } });
  const p = await f.create(); canonical = path.join(f.dataDir, 'fixture-canonical.json');
  await fs.writeFile(canonical, JSON.stringify(allFacts()));
  const record = target ? await f.service.finalize({ projectId: p.projectId, factIds: [D, C] }, origin) : null;
  // Observe the actual loaded wrapper/map; do not add a production mutation hook.
  const set = Map.prototype.set; let runtime, projects;
  const mock = t.mock.method(Map.prototype, 'set', function(key, value) {
    if (key === p.projectId && value?.meta?.creator && value?.targets instanceof Map) { runtime = value; projects = this; }
    return set.call(this, key, value);
  });
  try { await f.open(); } finally { mock.mock.restore(); }
  assert.ok(runtime);
  return { f, p, runtime, projects, state, canonical, target: record, args: { projectId: p.projectId } };
}
async function files(root) {
  const found = {};
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (name.includes(`${path.sep}core${path.sep}`) || entry.isDirectory() && entry.name === 'core') continue;
      if (entry.isDirectory()) await walk(name); else found[name] = await fs.readFile(path.join(root, name), 'utf8');
    }
  }
  await walk(); return found;
}
const controls = f => Object.fromEntries(['sessions', 'sends', 'starts', 'stops', 'schedules'].map(key => [key, f.calls[key].length]));

test('paper subgraph exact compact DTO uses the target closure, deep copies target and permits Core-only bookkeeping', async t => {
  const { f, p, args, target } = await setup(t), before = await files(f.dataDir), prior = controls(f), count = f.calls.core.length, tasks = f.calls.tasks.length;
  const result = await f.service.paperSubgraph(args, origin);
  assert.deepEqual(Object.keys(result), ['projectId', 'paperId', 'status', 'headline', 'headline_source', 'count', 'asOf', 'target', 'facts']);
  assert.equal(result.projectId, p.projectId); assert.equal(result.paperId, 'main'); assert.equal(result.status, 'ready');
  assert.deepEqual(result.headline, [D, C]); assert.equal(result.headline_source, 'target'); assert.equal(result.count, 4); assert.match(result.asOf, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.target, target); assert.deepEqual(Object.keys(result.target), ['schemaVersion', 'projectId', 'paperId', 'factIds', 'factDigests', 'finalizedBy', 'at']);
  assert.deepEqual(result.facts.map(f => f.id), [A, B, C, D]); assert.deepEqual(result.facts.map(f => f.dependents), [2, 1, 1, 0]);
  assert.ok(result.facts.every(f => f.statement.endsWith('Second line mentions a proof legitimately.')));
  assert.ok(result.facts.every(f => JSON.stringify(f.glossary_introduces) === '["a","z"]'));
  assert.doesNotMatch(JSON.stringify(result), /PROOF_SENTINEL|INTUITION_SENTINEL|PRIVATE_DEFINITION|PRIVATE_REFERENCE|sessionPath|callToken|authority/);
  const reads = f.calls.core.slice(count); assert.equal(reads.length, 6);
  assert.deepEqual(new Set(reads.filter(c => c.operation === 'fact_get').map(c => c.args.fact_id)), new Set([A, B, C, D]));
  assert.equal(reads.filter(c => c.operation === 'fact_get').length, 4); assert.ok(f.calls.tasks.length > tasks);
  assert.deepEqual(controls(f), prior); assert.deepEqual(await files(f.dataDir), before);
  assert.ok(f.calls.tasks.slice(tasks).every(task => !task.metadata?.reportId));
  result.target.factIds.push(E); result.target.factDigests[D] = '0'.repeat(64); result.facts[0].predecessors.push(E);
  const fresh = await f.service.paperSubgraph(args, origin); assert.deepEqual(fresh.target, target); assert.deepEqual(fresh.facts[0].predecessors, []);
  assert.deepEqual(await files(f.dataDir), before);
});

test('paper subgraph refuses an ancestor with assumptions outside its statement, without partial DTO or writer work', async t => {
  const { f, args, canonical } = await setup(t), facts = JSON.parse(await fs.readFile(canonical, 'utf8'));
  facts.find(fact => fact.fact_id === A).markdown = make(A).markdown.replace(/## statement[\s\S]*?## proof/,
    '## statement\nM has property P under following assumptions.\n## assumptions\ncompact and connected\n## proof');
  await fs.writeFile(canonical, JSON.stringify(facts));
  const before = await files(f.dataDir), prior = controls(f);
  await assert.rejects(f.service.paperSubgraph(args, origin), error => {
    assert.equal(error.code, 'PROJECT_PAPER_INVALID_STATEMENT'); assert.equal(error.facts, undefined); assert.equal(error.partial, undefined);
    assert.doesNotMatch(error.message, /M has property P|compact and connected|PROOF_SENTINEL/); return true;
  });
  assert.deepEqual(controls(f), prior); assert.deepEqual(await files(f.dataDir), before);
});

test('paper subgraph creator needs_target has no facts/asOf and starts no Core task; strict inputs reject editorial selection', async t => {
  const { f, args } = await setup(t, { target: false }), count = f.calls.core.length, tasks = f.calls.tasks.length;
  for (const extra of [{ brief: 'not accepted' }, { selection: [A] }, { supportFactIds: [A] }, { factIds: [A] }, { guard: true }, { force: true }, { [Symbol('extra')]: true }])
    await denied(f.service.paperSubgraph({ ...args, ...extra }, origin), 'PROJECT_INVALID_INPUT');
  for (const paperId of [null, '', '../main', 'Main', 1, undefined]) await denied(f.service.paperSubgraph({ ...args, paperId }, origin), 'PROJECT_INVALID_INPUT');
  await denied(f.service.paperSubgraph(Object.defineProperty({ ...args }, 'paperId', { enumerable: true, get() { assert.fail('no getter'); } }), origin), 'PROJECT_INVALID_INPUT');
  assert.deepEqual(await f.service.paperSubgraph(args, origin), { ...args, paperId: 'main', status: 'needs_target' });
  assert.deepEqual(await f.service.paperSubgraph({ ...args, paperId: 'other' }, origin), { ...args, paperId: 'other', status: 'needs_target' });
  assert.equal(f.calls.core.length, count); assert.equal(f.calls.tasks.length, tasks);
});

for (const role of ['main', 'moved-main', 'worker', 'other-creator']) test(`paper subgraph denies ${role} equally for existing and absent target before Core`, async t => {
  const { f, p, args } = await setup(t); let ctx = p.context;
  if (role === 'moved-main') {
    const row = f.host.get(ctx.sessionPath); f.host.delete(ctx.sessionPath); ctx = { ...ctx, sessionPath: '/fixture/moved-main.jsonl' };
    f.host.set(ctx.sessionPath, { ...row, path: ctx.sessionPath });
  } else if (role !== 'main') {
    ctx = { callToken: 'software-host-context', sessionPath: '/fixture/' + role };
    f.host.set(ctx.sessionPath, { sessionId: role, path: ctx.sessionPath, ownerPluginId: role === 'worker' ? APP : null,
      namespace: role === 'worker' ? 'app' : 'home', visibility: role === 'worker' ? 'plugin_private' : 'public', lifecycle: 'active' });
  }
  const count = f.calls.core.length, tasks = f.calls.tasks.length, before = await files(f.dataDir);
  for (const paperId of ['main', 'absent']) await denied(f.service.paperSubgraph({ ...args, paperId }, ctx), 'PROJECT_OWNER_DENIED');
  assert.equal(f.calls.core.length, count); assert.equal(f.calls.tasks.length, tasks); assert.deepEqual(await files(f.dataDir), before);
});

for (const admissionAt of [1, 2, 3]) test(`paper subgraph requires creator actor at authorization ${admissionAt}, not a later Host-confirmed main`, async t => {
  const { f, p, args, runtime } = await setup(t), list = f.sdk.sessions.list, mainPath = p.context.sessionPath;
  const main = f.host.get(mainPath), creator = f.host.get(origin.sessionPath), count = f.calls.core.length; let calls = 0;
  f.sdk.sessions.list = async input => {
    if (++calls === admissionAt) { f.host.delete(mainPath); f.host.set(origin.sessionPath, { ...main, path: origin.sessionPath }); }
    return list(input);
  };
  try {
    await denied(f.service.paperSubgraph(args, origin), 'PROJECT_OWNER_DENIED');
    assert.equal(f.calls.core.length, count); assert.equal(runtime.meta.main.sessionPath, mainPath, 'readOnly authorization must not migrate locator');
  } finally { f.sdk.sessions.list = list; f.host.set(mainPath, main); f.host.set(origin.sessionPath, creator); }
});

test('paper subgraph final creator authorization refuses a Host main move during the final Core return', async t => {
  const { f, p, args, state } = await setup(t), mainPath = p.context.sessionPath, main = f.host.get(mainPath), creator = f.host.get(origin.sessionPath);
  let pages = 0;
  state.beforeCore = async operation => {
    if (operation === 'fact_list_page' && ++pages === 2) { f.host.delete(mainPath); f.host.set(origin.sessionPath, { ...main, path: origin.sessionPath }); }
  };
  try { await denied(f.service.paperSubgraph(args, origin), 'PROJECT_OWNER_DENIED'); assert.equal(pages, 2); }
  finally { f.host.set(mainPath, main); f.host.set(origin.sessionPath, creator); }
});

test('paper subgraph source guard refuses initial creator drift even for needs_target', async t => {
  const { f, args, runtime } = await setup(t, { target: false }), list = f.sdk.sessions.list, count = f.calls.core.length;
  f.sdk.sessions.list = async input => { const result = await list(input); runtime.meta.creator = { ...runtime.meta.creator }; return result; };
  await denied(f.service.paperSubgraph(args, origin), 'PROJECT_PAPER_SUBGRAPH_CHANGED'); assert.equal(f.calls.core.length, count);
});

test('paper subgraph guards the actual Project wrapper identity across Core return', async t => {
  const { f, args, runtime, projects, state } = await setup(t), count = f.calls.core.length;
  state.beforeCore = async () => { projects.set(args.projectId, { ...runtime }); };
  try { await denied(f.service.paperSubgraph(args, origin), 'PROJECT_PAPER_SUBGRAPH_CHANGED'); assert.equal(f.calls.core.length - count, 1); }
  finally { projects.set(args.projectId, runtime); }
});

test('paper subgraph no retry or partial DTO on asOf or headline markdown digest drift', async t => {
  for (const drift of ['asOf', 'headline']) await t.test(drift, async t => {
    const { f, args, state, canonical } = await setup(t), count = f.calls.core.length; let changed = false;
    state.beforeCore = async operation => {
      if (operation !== 'fact_get' || changed) return; changed = true;
      const facts = JSON.parse(await fs.readFile(canonical, 'utf8'));
      if (drift === 'asOf') facts.push(make('0000000000000006'));
      else facts.find(f => f.fact_id === D).markdown += '\nChanged canonical proof bytes.\n';
      await fs.writeFile(canonical, JSON.stringify(facts));
    };
    await denied(f.service.paperSubgraph(args, origin), drift === 'asOf' ? 'PROJECT_SUMMARY_GRAPH_CHANGED' : 'PROJECT_TARGET_FACT_CHANGED');
    assert.equal(f.calls.core.slice(count).filter(c => c.operation === 'fact_list_page').length, drift === 'asOf' ? 2 : 1);
  });
});

for (const key of ['schemaVersion', 'projectId', 'paperId', 'factIds', 'factDigests', 'finalizedBy', 'at']) test(`paper subgraph guards target ${key} across collection`, async t => {
  const { f, args, state, runtime } = await setup(t); let changed = false;
  state.beforeCore = async operation => {
    if (operation !== 'fact_get' || changed) return; changed = true;
    const value = structuredClone(runtime.targets.get('main'));
    value[key] = key === 'factIds' ? [C] : key === 'factDigests' ? { [D]: '0'.repeat(64), [C]: '0'.repeat(64) }
      : key === 'at' || key === 'schemaVersion' ? value[key] + 1 : 'changed';
    runtime.targets.set('main', value);
  };
  await denied(f.service.paperSubgraph(args, origin), 'PROJECT_TARGET_CHANGED');
});

const mutations = {
  'creator-object': (r, ctx) => { r.meta.creator = { ...r.meta.creator }; },
  'creator-id': r => { r.meta.creator.sessionId = 'changed'; },
  'creator-path': r => { r.meta.creator.sessionPath = '/fixture/changed'; },
  'creator-rejected': r => { r.meta.creatorRejected = true; },
  'main-object': r => { r.meta.main = { ...r.meta.main }; },
  'main-id': r => { r.meta.main.sessionId = 'changed'; },
  'main-path-becomes-caller': (r, ctx) => { r.meta.main.sessionPath = ctx.sessionPath; },
  'meta-object': r => { r.meta = { ...r.meta }; },
  'caller-path': (r, ctx) => { ctx.sessionPath = '/fixture/changed'; },
};
for (const phase of ['FIFO waiting', 'Core return']) for (const [name, mutate] of Object.entries(mutations))
  test(`paper subgraph ${phase} refuses ${name} source drift before further dispatch/output`, async t => {
    const { f, args, state, runtime } = await setup(t), entered = defer(), release = defer(), queued = defer();
    t.after(() => release.resolve()); const ctx = { ...origin }, meta = runtime.meta, saved = structuredClone(meta), creator = meta.creator, main = meta.main;
    let blocked = false; state.beforeCore = async () => { if (!blocked) { blocked = true; entered.resolve(); await release.promise; } };
    const count = f.calls.core.length; let blocker;
    if (phase === 'FIFO waiting') { blocker = f.service.result({ ...args, factId: A }, origin); await entered.promise; }
    const push = runtime.coreQueue.push;
    runtime.coreQueue.push = function(slot) { const result = push.call(this, slot); if (slot.creatorAdmission) queued.resolve(); return result; };
    const request = f.service.paperSubgraph(args, ctx), refusal = denied(request, 'PROJECT_PAPER_SUBGRAPH_CHANGED');
    if (phase === 'FIFO waiting') await queued.promise; else await entered.promise;
    runtime.coreQueue.push = push;
    mutate(runtime, ctx); release.resolve();
    try { if (blocker) await blocker; await refusal; assert.equal(f.calls.core.length - count, 1); }
    finally { runtime.meta = meta; Object.assign(meta, saved); meta.creator = creator; Object.assign(creator, saved.creator); meta.main = main; Object.assign(main, saved.main); }
  });

for (const phase of ['FIFO waiting', 'Core return']) test(`paper subgraph disposal during ${phase} prevents later dispatch/output`, async t => {
  const { f, args, runtime, state } = await setup(t), entered = defer(), release = defer(), queued = defer(); t.after(() => release.resolve());
  let blocked = false; state.beforeCore = async () => { if (!blocked) { blocked = true; entered.resolve(); await release.promise; } };
  const count = f.calls.core.length; let blocker;
  if (phase === 'FIFO waiting') { blocker = f.service.result({ ...args, factId: A }, origin); blocker.catch(() => {}); await entered.promise; }
  const push = runtime.coreQueue.push;
  runtime.coreQueue.push = function(slot) { const n = push.call(this, slot); if (slot.creatorAdmission) queued.resolve(); return n; };
  const request = f.service.paperSubgraph(args, origin);
  const refusal = assert.rejects(request, error => ['PROJECT_CORE_QUEUE_CANCELLED', 'PROJECT_DISPOSED', 'PROJECT_CORE_DISPOSED'].includes(error.code));
  if (phase === 'FIFO waiting') await queued.promise; else await entered.promise;
  runtime.coreQueue.push = push; const disposing = f.service.dispose(); release.resolve();
  await Promise.all([refusal, disposing, blocker?.catch(() => {})]); assert.equal(f.calls.core.length - count, 1);
});
