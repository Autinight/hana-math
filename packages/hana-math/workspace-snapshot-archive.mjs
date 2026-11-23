// One App-owned archive, not an authorization source or a project-file reader.
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, renameSync } from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';
import { dashboardSelection } from './dashboard-request.mjs';
import { validTerminalEnd } from './terminal-dashboard-read.mjs';
import { exact, liveChannels, livePaths } from './ui/dashboard/live-protocol.mjs';

const BASE = 'context/workspace-snapshot', MANIFEST = `${BASE}/latest.json`, STAGED = `${BASE}/ready.json`;
const VERSION = 1, PANEL_BYTES = 1 << 20, MANIFEST_BYTES = 4096;
const panelFile = i => `${BASE}/panel-${i}.json`;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/, SHA = /^[a-f0-9]{64}$/, FACT = /^[a-f0-9]{16}$/;
const META = ['projectId', 'endedAt', 'scopeSeal'];
const roles = ['result', 'result', 'result', 'result', 'judgment', 'judgment', 'deadend', 'deadend', 'verify', 'strategy', 'strategy'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = v => typeof v === 'string';
const match = (pattern, value) => text(value) && pattern.test(value);
const count = n => Number.isSafeInteger(n) && n >= 0;
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const fault = (code, cause) => Object.assign(new Error(`Workspace snapshot: ${code.toLowerCase()}`, { cause }), { code: `WORKSPACE_SNAPSHOT_${code}` });
function need(value, code = 'INVALID') { if (!value) throw fault(code); }
function record(value) {
  return value !== null && typeof value === 'object' && !types.isProxy(value)
    && [null, Object.prototype].includes(Object.getPrototypeOf(value));
}
function fields(value, keys) { return record(value) && exact(value, keys); }
function own(value, key) {
  const d = Object.getOwnPropertyDescriptor(value, key);
  need(d?.enumerable && Object.hasOwn(d, 'value'));
  return d.value;
}
function metadata(value) {
  const { projectId, endedAt, scopeSeal } = value;
  need(match(ID, projectId) && validTerminalEnd(endedAt) && match(SHA, scopeSeal));
  return { projectId, endedAt, scopeSeal };
}
function guarded(guard) {
  need(typeof guard === 'function' && !types.isAsyncFunction(guard), 'GUARD');
  const allowed = guard();
  if (types.isPromise(allowed)) Promise.prototype.then.call(allowed, undefined, () => {});
  need(allowed === undefined || allowed === true, 'GUARD');
}

// Compact, stable JSON with no getters, hidden fields, sparse arrays, NaN or
// toJSON. Each response has a 1 MiB Core limit; 14 fixed private files keep
// the aggregate within that budget without bumping ContextStore's 2 MiB read cap.
function panelBytes(value) {
  let budget = PANEL_BYTES, nodes = 0;
  function copy(v, depth) {
    need(depth <= 16 && ++nodes <= PANEL_BYTES, 'LIMIT');
    if (text(v)) {
      budget -= Buffer.byteLength(v); need(budget >= 0, 'LIMIT');
      return v;
    }
    if (v === null || typeof v === 'boolean' || Number.isFinite(v)) return v;
    need(v !== null && typeof v === 'object' && !types.isProxy(v));
    if (Array.isArray(v)) {
      need(Object.getPrototypeOf(v) === Array.prototype);
      need(v.length <= PANEL_BYTES, 'LIMIT');
      need(Reflect.ownKeys(v).length === v.length + 1);
      return Array.from({ length: v.length }, (_, i) => copy(own(v, String(i)), depth + 1));
    }
    need(record(v));
    const keys = Reflect.ownKeys(v), result = Object.create(null);
    need(keys.every(text));
    for (const key of keys.sort()) {
      budget -= Buffer.byteLength(key); need(budget >= 0, 'LIMIT');
      result[key] = copy(own(v, key), depth + 1);
    }
    return result;
  }
  const bytes = Buffer.from(JSON.stringify(copy(value, 0)));
  need(bytes.length <= PANEL_BYTES, 'LIMIT');
  return bytes;
}
function counts(value, expected) {
  return record(value) && Object.keys(value).length === expected.size
    && Object.entries(value).every(([k, n]) => count(n) && expected.get(k) === n);
}
const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
function validGraph(g) {
  need(fields(g, ['nodes', 'edges', 'max_depth']) && Array.isArray(g.nodes) && g.nodes.length <= 2048
    && Array.isArray(g.edges) && count(g.max_depth));
  const nodes = new Map(), outgoing = new Map(), remaining = new Map(), best = new Map(), authors = new Map();
  let withPredecessors = 0, edgeCount = 0;
  for (const n of g.nodes) {
    need(fields(n, ['id', 'author', 'problem_id', 'statement', 'proof', 'intuition', 'predecessors', 'depth'])
      && match(FACT, n.id) && !nodes.has(n.id) && [n.author, n.problem_id, n.statement, n.proof].every(s => text(s) && s.length)
      && text(n.intuition) && count(n.depth) && Array.isArray(n.predecessors) && n.predecessors.length <= 128
      && n.predecessors.every(p => match(FACT, p)) && new Set(n.predecessors).size === n.predecessors.length);
    nodes.set(n.id, n); outgoing.set(n.id, new Set()); increment(authors, n.author);
    remaining.set(n.id, n.predecessors.length); best.set(n.id, 0);
    if (n.predecessors.length) withPredecessors++;
    edgeCount += n.predecessors.length;
  }
  need(g.edges.length === edgeCount);
  for (const edge of g.edges) {
    need(fields(edge, ['source', 'target']) && nodes.has(edge.source) && nodes.has(edge.target)
      && nodes.get(edge.target).predecessors.includes(edge.source) && !outgoing.get(edge.source).has(edge.target));
    outgoing.get(edge.source).add(edge.target);
  }
  const queue = [...nodes.keys()].filter(id => remaining.get(id) === 0);
  let max = 0;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i], depth = best.get(id);
    need(nodes.get(id).depth === depth);
    max = Math.max(max, depth);
    for (const target of outgoing.get(id)) {
      best.set(target, Math.max(best.get(target), depth + 1));
      const next = remaining.get(target) - 1; remaining.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  need(queue.length === nodes.size && g.max_depth === max);
  return { authors, withPredecessors };
}
const rowText = ['timestamp_utc', 'author', 'kind', 'claim', 'evidence', 'status'];
const rowFields = new Set([...rowText, 'id', 'fact_id', 'verifiable', 'links', 'glossary']);
const reportFields = ['summary', 'critical_errors', 'gaps'];
function validEntry(row, kind) {
  need(record(row));
  const optional = kind === 'verification' ? ['verdict', 'verification_report', 'write_error']
    : kind === 'master_guidance' ? ['input_tokens', 'cost_usd'] : [];
  need(Object.keys(row).every(key => rowFields.has(key) || optional.includes(key)));
  // The production projection preserves missing display fields; present fields
  // must have the projected types. A failed verification has fact_id: null;
  // a historical full ID may refer to a revoked fact, not an active graph node.
  for (const key of rowText) if (Object.hasOwn(row, key)) need(text(row[key]));
  if (Object.hasOwn(row, 'kind')) need(row.kind === kind);
  if (Object.hasOwn(row, 'id')) need(match(FACT, row.id));
  if (Object.hasOwn(row, 'fact_id')) need(row.fact_id === null || match(FACT, row.fact_id));
  if (Object.hasOwn(row, 'verifiable')) need(typeof row.verifiable === 'boolean');
  if (Object.hasOwn(row, 'glossary')) need(record(row.glossary) && Object.values(row.glossary).every(text));
  if (Object.hasOwn(row, 'links')) {
    need(record(row.links));
    for (const [key, value] of Object.entries(row.links)) {
      if (key === 'source_id' || key === 'subgoal') need(value === null || text(value));
      // gm_add's links are display annotations, not graph adjacency or
      // proof-jump targets. Python permits string labels here (even short IDs).
      else need(['predecessors', 'fact_ids'].includes(key) && (value === null || Array.isArray(value) && value.every(text)));
    }
  }
  if (Object.hasOwn(row, 'verdict')) need(row.verdict === null || text(row.verdict));
  if (Object.hasOwn(row, 'write_error')) need(row.write_error === null || row.write_error === 'fact write failed');
  if (Object.hasOwn(row, 'input_tokens')) need(count(row.input_tokens));
  if (Object.hasOwn(row, 'cost_usd')) need(Number.isFinite(row.cost_usd) && row.cost_usd >= 0 && row.cost_usd < 2 ** 53);
  if (Object.hasOwn(row, 'verification_report') && row.verification_report !== null) {
    const report = row.verification_report;
    need(record(report) && Object.keys(report).every(key => reportFields.includes(key)));
    if (Object.hasOwn(report, 'summary')) need(text(report.summary));
    for (const key of ['critical_errors', 'gaps']) if (Object.hasOwn(report, key)) {
      need(Array.isArray(report[key]) && report[key].every(item => record(item)
        && Object.entries(item).every(([field, value]) => ['location', 'issue'].includes(field) && text(value))));
    }
  }
}
function validatePanels(panels, meta) {
  const o = panels['/api/overview'], g = panels['/api/factgraph'], c = panels['/api/channels'];
  const graph = validGraph(g);
  need(fields(o, ['project', 'facts', 'facts_with_predecessors', 'facts_by_author', 'channel_counts', 'verdicts', 'updated_at'])
    && o.project === meta.projectId && o.updated_at === meta.endedAt / 1000 && o.facts === g.nodes.length
    && o.facts_with_predecessors === graph.withPredecessors && counts(o.facts_by_author, graph.authors)
    && fields(o.channel_counts, liveChannels));
  need(fields(c, ['channels']) && Array.isArray(c.channels) && c.channels.length === liveChannels.length);
  const verdicts = new Map();
  for (const [i, kind] of liveChannels.entries()) {
    const row = c.channels[i], panel = panels[`/api/channel/${kind}`];
    need(fields(row, ['kind', 'role', 'count']) && row.kind === kind && row.role === roles[i] && count(row.count)
      && row.count === o.channel_counts[kind] && fields(panel, ['kind', 'count', 'entries'])
      && panel.kind === kind && panel.count === row.count && Array.isArray(panel.entries) && panel.entries.length === row.count);
    for (const entry of panel.entries) {
      validEntry(entry, kind);
      if (kind === 'verification') increment(verdicts, Object.hasOwn(entry, 'verdict') ? entry.verdict ?? 'null' : '?');
    }
  }
  need(counts(o.verdicts, verdicts));
}

const manifestPacket = body => Buffer.from(JSON.stringify({ body, checksum: sha(JSON.stringify(body)) }));
function decodeManifest(bytes) {
  need(bytes.length <= MANIFEST_BYTES, 'LIMIT');
  const packet = parse(bytes), m = packet?.body;
  need(fields(packet, ['body', 'checksum']) && record(m) && m.schemaVersion === VERSION
    && manifestPacket(m).equals(bytes) && validTerminalEnd(m.endedAt));
  const base = ['schemaVersion', 'state'];
  if (m.state === 'conflict') need(fields(m, [...base, 'endedAt']));
  else if (m.state === 'pending') need(fields(m, [...base, ...META]) && metadata(m));
  else {
    const optional = Object.hasOwn(m, 'inventoryRevision') ? ['inventoryRevision'] : [];
    need(m.state === 'published' && fields(m, [...base, ...META, ...optional, 'panels']) && metadata(m)
      && (!optional.length || match(SHA, m.inventoryRevision)) && Array.isArray(m.panels) && m.panels.length === livePaths.length
      && m.panels.every(p => fields(p, ['length', 'checksum']) && count(p.length) && p.length > 0 && p.length <= PANEL_BYTES && match(SHA, p.checksum)));
  }
  return m;
}
function fileIdentity(name) {
  let stat;
  try { stat = lstatSync(name, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  need(stat.isFile() && stat.nlink === 1n, 'STORAGE');
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

// Instantiate once per App context store. load() is memoized and also awaited
// by both mutation methods. Read access is exact-ticket + canonical selection.
export function createWorkspaceSnapshotArchive(store) {
  need(['absolute', 'readWitness', 'fileIdentity', 'write'].every(method => typeof store?.[method] === 'function'), 'STORAGE');
  let loading, manifest = null, identity = null, ticket = null, views = null, blocked = false;
  let tail = Promise.resolve();
  const latest = () => ticket;
  // Internal precedence only; unlike a ticket, this carries no project scope.
  function barrier() {
    if (blocked) return Object.freeze({ endedAt: null, state: 'corrupt' });
    if (!manifest) return null;
    const { endedAt, state } = manifest;
    return Object.freeze({ endedAt, state: state === 'published' && !ticket ? 'corrupt' : state });
  }
  function forget() { ticket = null; views = null; }
  function expose(m, panels) {
    ticket = Object.freeze({ ...metadata(m), ...(Object.hasOwn(m, 'inventoryRevision') ? { inventoryRevision: m.inventoryRevision } : {}) });
    views = panels;
    return ticket;
  }
  async function load() {
    await (loading ??= (async () => {
      let file;
      try { file = await store.readWitness(MANIFEST); }
      catch (e) { if (e?.code !== 'ENOENT') blocked = true; return null; }
      try { manifest = decodeManifest(file.bytes); identity = file.identity; }
      catch { blocked = true; return null; }
      if (manifest.state !== 'published') return null;
      try {
        const panels = Object.create(null);
        for (const [i, route] of livePaths.entries()) {
          const { bytes } = await store.readWitness(panelFile(i)), p = manifest.panels[i];
          need(bytes.length === p.length && sha(bytes) === p.checksum);
          panels[route] = parse(bytes);
        }
        validatePanels(panels, manifest);
        need(await store.fileIdentity(MANIFEST) === identity, 'STORAGE');
        return expose(manifest, panels);
      } catch { return null; } // high-water is still known; do not search for fallback data
    })());
    return ticket;
  }
  function serialized(action) {
    const next = tail.then(async () => { await load(); need(!blocked, 'STORAGE'); return action(); });
    tail = next.catch(() => {});
    return next;
  }
  async function transition(next, guard) {
    guarded(guard);
    const bytes = manifestPacket(next);
    let staged, target, source;
    try {
      // ContextStore checks the App-owned root/ancestors and writes privately.
      // Stage the tiny manifest asynchronously, then check its identity again.
      await store.write(STAGED, bytes, true);
      staged = await store.readWitness(STAGED);
      need(staged.bytes.equals(bytes), 'STORAGE');
    } catch (e) { forget(); throw fault('STORAGE', e); } // commit not attempted; pending can be retried
    try {
      target = store.absolute(MANIFEST); source = store.absolute(STAGED);
      const parent = path.dirname(target);
      need(parent === path.dirname(source) && realpathSync(parent) === parent
        && fileIdentity(target) === identity && fileIdentity(source) === staged.identity, 'STORAGE');
    } catch (e) { blocked = true; forget(); throw fault('STORAGE', e); }
    // No await from this final guard to the atomic rename: cancellation during
    // staging cannot leave a revoked publication committed across a restart.
    guarded(guard);
    try { renameSync(source, target); identity = fileIdentity(target); need(identity !== null, 'STORAGE'); }
    catch (e) { blocked = true; forget(); throw fault('STORAGE', e); }
    manifest = next; forget();
  }
  async function beginIdentity(meta, guard) {
    guarded(guard);
    if (manifest && meta.endedAt <= manifest.endedAt) {
      need(meta.endedAt === manifest.endedAt, 'STALE');
      need(manifest.state !== 'conflict', 'CONFLICT');
      if (manifest.projectId === meta.projectId && manifest.scopeSeal === meta.scopeSeal) return;
      await transition({ schemaVersion: VERSION, state: 'conflict', endedAt: meta.endedAt }, guard);
      throw fault('CONFLICT');
    }
    await transition({ schemaVersion: VERSION, state: 'pending', ...meta }, guard);
  }
  async function begin(value, guard) {
    need(fields(value, META));
    const meta = metadata(value);
    await serialized(() => beginIdentity(meta, guard));
  }
  async function publish(value, guard) {
    need(record(value));
    // Capture only data values before yielding to the queue; a caller cannot
    // change a queued packet. Valid identity advances high-water even when
    // its panels are missing/invalid. Invalid identity never claims a time.
    const meta = metadata(Object.fromEntries(META.map(key => [key, own(value, key)])));
    guarded(guard);
    const optional = Object.hasOwn(value, 'inventoryRevision') ? ['inventoryRevision'] : [];
    let batch, invalid;
    try {
      need(fields(value, [...META, ...optional, 'panels']) && (!optional.length || match(SHA, value.inventoryRevision)));
      const metadataWithRevision = { ...meta, ...(optional.length ? { inventoryRevision: value.inventoryRevision } : {}) };
      need(fields(value.panels, livePaths));
      const bytes = livePaths.map(route => panelBytes(value.panels[route]));
      const panels = Object.fromEntries(livePaths.map((route, i) => [route, parse(bytes[i])]));
      validatePanels(panels, meta);
      const next = { schemaVersion: VERSION, state: 'published', ...metadataWithRevision,
        panels: bytes.map(b => ({ length: b.length, checksum: sha(b) })) };
      batch = { bytes, panels, next };
    } catch (e) { invalid = e; }
    return serialized(async () => {
      await beginIdentity(meta, guard);
      if (invalid) throw invalid;
      if (manifest.state === 'published') {
        if (manifestPacket(manifest).equals(manifestPacket(batch.next))) {
          // Do not turn an already published, damaged archive back into a
          // pending identity that could accept different content at this time.
          need(ticket, 'STORAGE'); guarded(guard); return ticket;
        }
        await transition({ schemaVersion: VERSION, state: 'conflict', endedAt: meta.endedAt }, guard);
        throw fault('CONFLICT');
      }
      for (const [i, bytes] of batch.bytes.entries()) {
        guarded(guard);
        try {
          const file = panelFile(i);
          await store.write(file, bytes, true);
          const echo = await store.readWitness(file);
          need(echo.bytes.equals(bytes), 'STORAGE');
        } catch (e) { throw fault('STORAGE', e); }
      }
      await transition(batch.next, guard);
      return expose(batch.next, batch.panels);
    });
  }
  function read(candidate, selection) {
    need(ticket !== null && candidate === ticket, 'TICKET');
    need(record(selection));
    const route = livePaths.find(p => {
      const expected = dashboardSelection(p), keys = Object.keys(expected);
      return fields(selection, keys) && keys.every(key => selection[key] === expected[key]);
    });
    need(route);
    return structuredClone(views[route]);
  }
  return Object.freeze({ load, latest, barrier, read, begin, publish });
}
