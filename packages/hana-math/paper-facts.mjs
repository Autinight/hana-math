// Bounded closure collection only. Injected readers/guards carry their own
// authority; this module has no SDK, invocation context or private-file access.
import { createHash } from 'node:crypto';
import { paperClosure } from './paper-source.mjs';

const MAX_FACTS = 2048, MAX_BYTES = 1024 * 1024;
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };

export async function collectPaperFacts({ target, selectedFactIds = [], fetchPage, fetchFact, assertTarget, verifySnapshot }) {
  await assertTarget();
  const first = await fetchPage({ limit: 1 }), asOf = first.page.asOf;
  const found = new Map(), visiting = new Set(), visited = new Set(); let bytes = 0;
  const visit = async id => {
    if (visited.has(id)) return;
    check(!visiting.has(id), 'PROJECT_PAPER_CLOSURE_INVALID');
    check(found.size < MAX_FACTS, 'PROJECT_PAPER_CLOSURE_TOO_LARGE');
    visiting.add(id);
    const { fact } = await fetchFact(id);
    const canonical = { fact_id: fact.fact_id, predecessors: [...fact.predecessors], markdown: fact.markdown };
    bytes += Buffer.byteLength(JSON.stringify(canonical));
    check(bytes <= MAX_BYTES, 'PROJECT_PAPER_CLOSURE_TOO_LARGE');
    found.set(id, canonical);
    for (const predecessor of canonical.predecessors) await visit(predecessor);
    visiting.delete(id); visited.add(id);
  };
  const roots = [...new Set([...target.factIds, ...selectedFactIds])];
  for (const id of roots) await visit(id);
  for (const id of target.factIds) {
    const fact = found.get(id);
    check(fact && createHash('sha256').update(Buffer.from(fact.markdown, 'utf8')).digest('hex') === target.factDigests[id], 'PROJECT_TARGET_FACT_CHANGED');
  }
  const facts = paperClosure([...found.values()], roots);
  await verifySnapshot(asOf);
  await assertTarget();
  return { facts, asOf };
}
