// Keep this document boundary independent of the live adapter and its routes.
const MAX_BYTES = 1 << 20;
// Same admission limits as the exporting Project/Core graph.
const MAX_NODES = 2048, MAX_EDGES = 32768, MAX_PREDECESSORS = 128;
const MAX_BASE64 = 4 * Math.ceil(MAX_BYTES / 3);
const FACT_ID = /^[0-9a-f]{16}$/;
const INVALID = 'Invalid fact graph snapshot';
const check = condition => { if (!condition) throw new Error(INVALID); };
const hasShape = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const matches = (value, re) => typeof value === 'string' && re.test(value);
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const boundedList = (value, max) => Array.isArray(value) && value.length <= max;

export function decodeSnapshot(readResult) {
  // The bound Preview read returns the byte payload as {content, encoding:"base64", ...metadata}.
  const content = readResult?.content;
  check(readResult?.encoding === 'base64' && typeof content === 'string' && content.length <= MAX_BASE64
    && content.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(content));
  const binary = atob(content);
  check(binary.length > 0 && binary.length <= MAX_BYTES);
  return decodeSnapshotBytes(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

export async function decodeSnapshotFile(file) {
  check(typeof file?.name === 'string' && /\.hanamathgraph$/i.test(file.name)
    && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_BYTES);
  const bytes = new Uint8Array(await file.arrayBuffer());
  check(bytes.byteLength === file.size);
  return decodeSnapshotBytes(bytes);
}

function decodeSnapshotBytes(bytes) {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  check(hasShape(value, ['schemaVersion', 'kind', 'projectId', 'asOf', 'capturedAt', 'graph'])
    && value.schemaVersion === 1 && value.kind === 'hana-math.factgraph-snapshot'
    && matches(value.projectId, /^[a-z0-9][a-z0-9-]{0,63}$/) && matches(value.asOf, /^[a-f0-9]{64}$/)
    && integer(value.capturedAt, 8.64e15));
  const g = value.graph;
  check(hasShape(g, ['nodes', 'edges', 'max_depth']) && boundedList(g.nodes, MAX_NODES)
    && boundedList(g.edges, MAX_EDGES) && integer(g.max_depth, Math.max(0, g.nodes.length - 1)));
  const nodes = new Map();
  for (const n of g.nodes) {
    check(hasShape(n, ['id', 'author', 'problem_id', 'statement', 'proof', 'intuition', 'predecessors', 'depth'])
      && matches(n.id, FACT_ID) && !nodes.has(n.id) && integer(n.depth, g.max_depth)
      && ['statement', 'proof'].every(key => typeof n[key] === 'string' && n[key].length > 0)
      && ['author', 'problem_id', 'intuition'].every(key => typeof n[key] === 'string')
      && boundedList(n.predecessors, MAX_PREDECESSORS));
    nodes.set(n.id, n);
  }
  let max = 0;
  const edges = new Set();
  for (const n of nodes.values()) {
    let depth = 0;
    for (const id of n.predecessors) {
      check(matches(id, FACT_ID) && nodes.has(id));
      const key = id + n.id;
      check(!edges.has(key) && edges.size < MAX_EDGES);
      edges.add(key);
      depth = Math.max(depth, nodes.get(id).depth + 1);
    }
    // Each predecessor must be shallower, which also rules out cycles.
    check(n.depth === depth);
    max = Math.max(max, depth);
  }
  check(g.max_depth === max && g.edges.length === edges.size);
  for (const edge of g.edges) {
    check(hasShape(edge, ['source', 'target']) && matches(edge.source, FACT_ID) && matches(edge.target, FACT_ID)
      && edges.delete(edge.source + edge.target));
  }
  return value;
}

export function isReadOnlyPreview(context) {
  return context?.appId === 'hana-math' && context.providerId === 'app:hana-math/factgraph-snapshot'
    && typeof context.documentId === 'string' && context.documentId.length > 0
    && typeof context.viewId === 'string' && context.viewId.length > 0
    && Number.isSafeInteger(context.generation) && context.generation > 0
    && Array.isArray(context.capabilities) && context.capabilities.length === 1 && context.capabilities[0] === 'read';
}

export function samePreview(a, b) {
  return isReadOnlyPreview(b) && a.documentId === b.documentId && a.viewId === b.viewId && a.generation === b.generation;
}
