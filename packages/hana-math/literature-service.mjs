// App-owned Matlas index search; native web tools use separate Host authorization.
// The host additionally enforces this App's unchanged network declaration.
const ENDPOINT = 'https://leansearch.net/thm/search';
const TASK = 'Given a math statement, retrieve useful references, such as theorems, lemmas, and definitions, that are useful for solving the given problem.';
const MAX_BYTES = 1 << 20;
const FIELDS = ['title', 'theorem', 'arxiv_id', 'theorem_id'];
export function createLiteratureService(sdk) {
  async function search(query, numResults = 10, { signal } = {}) {
    const q = typeof query === 'string' ? query.trim() : '';
    const failure = (error) => ({ query: q, count: 0, results: [], endpoint: ENDPOINT, error });
    if (!q || Buffer.byteLength(query) > 16384) return failure('invalid query: expected 1–16384 UTF-8 bytes');
    if (!Number.isInteger(numResults) || numResults < 1 || numResults > 100) return failure('invalid numResults: expected integer 1–100');
    if (signal !== undefined && !(signal instanceof AbortSignal)) return failure('invalid host signal');
    if (signal?.aborted) return failure('cancelled');
    const controller = new AbortController();
    let reject, reader, timer;
    const interrupted = new Promise((_, no) => { reject = no; });
    interrupted.catch(() => {});
    const cancel = (message) => { controller.abort(); reject(new Error(message)); };
    const abort = () => cancel('cancelled');
    const race = (p) => Promise.race([p, interrupted]);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => cancel('literature timeout'), 20000);
    try {
      if (typeof sdk?.network?.fetch !== 'function') throw new Error('network capability unavailable');
      const pending = Promise.resolve().then(() => sdk.network.fetch(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        timeoutMs: 20000, maxResponseBytes: MAX_BYTES,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'danus/1.0 (+https://frenzymath.com)' },
        body: JSON.stringify({ query: q, task: TASK, num_results: numResults }),
      })).then((response) => {
        if (controller.signal.aborted) { Promise.resolve(response?.body?.cancel()).catch(() => {}); throw new Error('cancelled'); }
        return response;
      });
      const response = await race(pending);
      if (response?.body?.getReader) reader = response.body.getReader();
      if (!response?.ok) throw new Error(`http ${response?.status ?? 'invalid response'}`);
      if (response.redirected || (response.url && response.url !== ENDPOINT)) throw new Error('unexpected response endpoint');
      if (!reader) throw new Error('invalid response body');
      const length = response.headers?.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new Error('response exceeds 1 MiB');
      let total = 0, text = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      while (true) {
        const { done, value } = await race(reader.read());
        if (value) { total += value.byteLength; if (total > MAX_BYTES) throw new Error('response exceeds 1 MiB'); text += decoder.decode(value, { stream: true }); }
        if (done) { text += decoder.decode(); break; }
      }
      const data = JSON.parse(text);
      if (!Array.isArray(data) || data.length > numResults || data.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || FIELDS.some((key) => Object.hasOwn(item, key) && typeof item[key] !== 'string'))) throw new Error('invalid theorem response schema');
      const results = data.map((item) => Object.fromEntries(FIELDS.map((key) => [key, item[key] ?? ''])));
      return { query: q, count: results.length, results, endpoint: ENDPOINT };
    } catch (error) { return failure(`${error?.code ? error.code + ': ' : ''}${error?.message || 'literature request failed'}`); }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // Never let a broken host stream prevent bounded cancellation/return.
      if (reader) Promise.resolve().then(() => reader.cancel()).catch(() => {}).finally(() => { try { reader.releaseLock(); } catch {} });
    }
  }
  return Object.freeze({ search });
}
