// Opaque software DTO producer for Host/Core stubs; not production or a proof gate.
import { createHash } from 'node:crypto';
export function fixtureFactPage(input = [], options = {}, projectId = 'fixture-project') {
  const facts = [...input].sort((a, b) => String(a.fact_id) < String(b.fact_id) ? -1 : String(a.fact_id) > String(b.fact_id) ? 1 : 0);
  const asOf = createHash('sha256').update(JSON.stringify({ projectId, facts })).digest('hex');
  const previous = options.cursor ? JSON.parse(Buffer.from(options.cursor, 'base64url')) : null;
  const limit = options.limit ?? previous?.limit ?? 64, startIndex = previous?.offset ?? 0;
  if (previous && previous.asOf !== asOf) throw Object.assign(new Error('opaque runtime refusal'), { code: 'RESEARCH_RUNTIME_REJECTED' });
  const rows = facts.slice(startIndex, startIndex + limit).map(f => ({ fact_id: f.fact_id, predecessors: f.predecessors,
    statementPreview: 'opaque', statementPreviewTruncated: false, canonicalBytes: Buffer.byteLength(f.markdown ?? 'opaque') }));
  for (;;) {
    const end = startIndex + rows.length, hasMore = end < facts.length;
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ asOf, limit, offset: end, projectId, v: 1 })).toString('base64url') : null;
    const result = { facts: [...rows], page: { version: 1, asOf, total: facts.length, startIndex, returned: rows.length, limit,
      nextCursor, hasMore, allFactsIncluded: startIndex === 0 && end === facts.length, previewOnly: true } };
    if (Buffer.byteLength(JSON.stringify(result)) <= 16384) return result;
    if (rows.length <= 1) throw new Error('opaque software row exceeds budget');
    rows.pop();
  }
}
