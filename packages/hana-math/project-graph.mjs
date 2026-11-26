import { validateFactPage } from './fact-page.mjs';

export const GRAPH_FACT_LIMIT = 4096, GRAPH_EDGE_LIMIT = 32768, GRAPH_PAGE_LIMIT = 256;
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Reads through the caller's authorized ProjectService.result, never raw stores.
// A single restart is allowed for drift; no partial observation is published.
export async function collectProjectGraph({ projectId, readPage, changed, now = Date.now }) {
  for (let attempt = 0; ; attempt++) {
    try {
      const facts = []; let options = {}, asOf = null, total = null, edges = 0, pages = 0;
      for (;;) {
        if (++pages > GRAPH_PAGE_LIMIT) fail('PROJECT_GRAPH_SIZE_LIMIT');
        const value = await readPage(options);
        if (value?.projectId !== projectId) fail('PROJECT_GRAPH_INVALID_RESULT');
        const page = validateFactPage({ facts: value.facts, page: value.page }, projectId, options, 'PROJECT_GRAPH_INVALID_RESULT');
        asOf ??= page.page.asOf; total ??= page.page.total;
        if (page.page.asOf !== asOf || page.page.total !== total || page.page.startIndex !== facts.length) fail('PROJECT_GRAPH_CHANGED');
        if (total > GRAPH_FACT_LIMIT) fail('PROJECT_GRAPH_SIZE_LIMIT');
        for (const fact of page.facts) {
          if (facts.length && facts.at(-1).fact_id >= fact.fact_id) fail('PROJECT_GRAPH_INVALID_RESULT');
          edges += fact.predecessors.length;
          if (edges > GRAPH_EDGE_LIMIT) fail('PROJECT_GRAPH_SIZE_LIMIT');
          facts.push(fact);
        }
        if (!page.page.hasMore) break;
        options = { cursor: page.page.nextCursor };
      }
      const final = await readPage({ limit: 1 });
      if (final?.projectId !== projectId) fail('PROJECT_GRAPH_INVALID_RESULT');
      const latest = validateFactPage({ facts: final.facts, page: final.page }, projectId, { limit: 1 }, 'PROJECT_GRAPH_INVALID_RESULT');
      if (latest.page.asOf !== asOf || latest.page.total !== total) fail('PROJECT_GRAPH_CHANGED');
      const capturedAt = now();
      if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) fail('PROJECT_GRAPH_INVALID_RESULT');
      return { projectId, asOf, capturedAt, facts };
    } catch (error) {
      const drift = error.code === 'PROJECT_GRAPH_CHANGED' || changed(error);
      if (drift && attempt === 0) continue;
      if (drift) fail('PROJECT_GRAPH_CHANGED');
      throw error;
    }
  }
}
