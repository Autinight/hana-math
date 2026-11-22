import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertSummaryHtmlOffline, renderSummaryHtml } from '../packages/hana-math/summary-render.mjs';
import MarkdownIt from '../packages/hana-math/summary-vendor/markdown-it.cjs';

// Captured once from the real Danus CLI with title "" and the pinned local
// dependencies. Tests consume only repository-local inputs, never the CLI.
const fixture = name => new URL(`./fixtures/summary-render-parity/${name}`, import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const attrs = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const dataUri = /^data:[^,]*,/i;
const auditDir = process.env.HANA_SUMMARY_PARITY_AUDIT_DIR;
const upstreamBodyPath = process.env.HANA_SUMMARY_PARITY_UPSTREAM_BODY;
// The gated acceptance run stops at the first failed assertion. Day-to-day
// runs require only the checked-in fixture and keep independent tests.
let auditCanProceed = true;
function parityTest(name, run) {
  test(name, async t => {
    if (auditDir && !auditCanProceed) return t.skip('earlier audit gate failed');
    if (auditDir) auditCanProceed = false;
    await run(t);
    if (auditDir) auditCanProceed = true;
  });
}

function checkCss(css) {
  assert.doesNotMatch(css, /@import\b/i);
  const urls = [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi)].map(([, a, b, c]) => a ?? b ?? c);
  assert.equal(urls.length, (css.match(/\burl\s*\(/gi) ?? []).length, 'every CSS url() must be inspected');
  for (const url of urls) assert.match(url, dataUri, `non-embedded CSS resource: ${url}`);
  return urls;
}

function inspectDocument(html) {
  assert.equal(typeof html, 'string');
  const document = /^<!doctype html><html><head>([\s\S]*?)<\/head><body class="md">([\s\S]*?)<\/body><\/html>\s*$/i.exec(html);
  assert.ok(document, 'expected a complete HTML document with the Danus envelope');
  const [, head, body] = document;
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  for (const [, tag, raw] of html.matchAll(/<([a-z][\w:-]*)((?:[^'">]|"[^"]*"|'[^']*')*)>/gi)) {
    const name = tag.toLowerCase();
    assert.ok(!['script', 'link', 'iframe', 'object', 'embed', 'base'].includes(name), `forbidden element: ${name}`);
    for (const [, attr, a, b, c] of raw.matchAll(attrs)) {
      const key = attr.toLowerCase(), value = a ?? b ?? c ?? '';
      assert.ok(!key.startsWith('on'), `event-handler attribute: ${key}`);
      if (key === 'style') checkCss(value);
      if (name === 'img' && key === 'src') assert.match(value, dataUri);
      if (name === 'img' && key === 'srcset') assert.fail('unexpected image srcset');
      // Ordinary <a href> links require a click; xmlns declares a namespace,
      // even if its spelling looks like a network URL. Neither is a load.
    }
  }
  for (const [, css] of styles) checkCss(css);
  const faces = styles.flatMap(([, css]) => [...css.matchAll(/@font-face\s*\{([^}]*)\}/gi)].map(match => match[1]));
  assert.ok(faces.length > 0, 'missing embedded KaTeX font-face declarations');
  const fontUrls = faces.flatMap(face => {
    const urls = checkCss(face);
    assert.ok(urls.length > 0, 'font-face declaration has no embedded font reference');
    return urls;
  });
  assert.equal(fontUrls.length, 60, 'all 60 distributed KaTeX font URLs must be embedded');
  for (const uri of fontUrls) {
    assert.match(uri, /^data:(?:font\/|application\/(?:font-|x-font-|octet-stream))/i);
    const match = /^data:[^,]+;base64,([a-z0-9+/]+=*)$/i.exec(uri);
    assert.ok(match, 'expected a base64-encoded font payload');
    const signature = Buffer.from(match[1], 'base64').subarray(0, 4).toString('hex');
    assert.ok(['774f4632', '774f4646', '00010000', '4f54544f', '74727565'].includes(signature), `invalid font signature ${signature}`);
  }
  return { head, body, styles };
}

parityTest('offline summary rendering preserves the official Danus body and print head with embedded KaTeX fonts', async () => {
  const [markdown, expectedText] = await Promise.all([readFile(fixture('report.md')), readFile(fixture('expected.json'), 'utf8')]);
  const expected = JSON.parse(expectedText);
  assert.equal(sha256(markdown), expected.markdownSha256);
  assert.equal(Boolean(auditDir), Boolean(upstreamBodyPath), 'audit requires an output directory and a fixed body reference');
  if (auditDir) assert.ok(path.isAbsolute(auditDir) && path.isAbsolute(upstreamBodyPath));
  const html = await renderSummaryHtml(markdown.toString('utf8'));
  if (auditDir) await writeFile(path.join(auditDir, 'candidate-report.html'), html, { flag: 'wx' });
  const { head, body, styles } = inspectDocument(html);
  const bodyBytes = Buffer.from(body, 'utf8');
  assert.equal(bodyBytes.length, 33446, 'unexpected Danus body byte length');
  assert.equal(sha256(bodyBytes), expected.bodySha256, 'Danus body differs');
  assert.equal([...body.matchAll(/<mspace\b[^>]*\/\s*>/g)].length, 2, 'official body must contain exactly two self-closing MathML spaces');
  if (auditDir) {
    const upstreamBody = await readFile(upstreamBodyPath);
    assert.equal(upstreamBody.length, 33446);
    assert.ok(bodyBytes.equals(upstreamBody), 'candidate and upstream body Buffers differ');
  }
  const replacements = styles.filter(([, css]) => /@font-face\b/i.test(css));
  assert.equal(replacements.length, 1, 'expected a single KaTeX replacement stylesheet');
  const [embedded] = replacements[0];
  assert.ok(head.includes(embedded), 'embedded stylesheet belongs in the head');
  assert.equal(head.replace(embedded, ''), expected.normalizedHead, 'Danus head must be byte-identical outside the replacement stylesheet');
});

parityTest('KaTeX renders \\quad as a self-closing MathML space', async () => {
  const { body } = inspectDocument(await renderSummaryHtml(String.raw`$a\quad b$`));
  assert.match(body, /<math\b[^>]*>[\s\S]*?<mspace width="1em"\/>[\s\S]*?<\/math>/);
});

parityTest('ordinary citation links and MathML namespaces remain, without treating text as resource references', async () => {
  const markdown = [
    'Bare: https://example.invalid/bare',
    '[Paper](https://example.invalid/citation "Auxiliary result")',
    '$x^2$',
    '`src="https://example.invalid/text-only"` and `url(../not-a-css-value)`',
  ].join('\n\n');
  const { body } = inspectDocument(await renderSummaryHtml(markdown));
  assert.match(body, /<a href="https:\/\/example\.invalid\/bare">https:\/\/example\.invalid\/bare<\/a>/);
  assert.match(body, /<a href="https:\/\/example\.invalid\/citation" title="Auxiliary result">Paper<\/a>/);
  assert.match(body, /<math\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/);
  assert.match(body, /url\(\.\.\/not-a-css-value\)/);
});

for (const [kind, src] of [['remote', 'https://example.invalid/figure.png'], ['relative', './figures/figure.png']]) {
  parityTest(`${kind} Markdown images are rejected instead of fetching or returning HTML`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('renderer attempted fetch'));
    const markdown = `# Original report\n\n![Figure](${src})\n`;
    await assert.rejects(async () => renderSummaryHtml(markdown), { code: 'SUMMARY_HTML_NOT_SELF_CONTAINED' });
    assert.equal(fetch.mock.callCount(), 0);
  });
}

// These inputs are inert strings passed only to the synchronous verifier;
// no document, navigation, script evaluation or resource load is attempted.
const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const fixtureUrl = 'https://example.invalid/opaque.png';
const envelope = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title></title>${head}</head><body class="md">${body}</body></html>`;
const offlineError = { code: 'SUMMARY_HTML_NOT_SELF_CONTAINED' };
function accept(html) {
  const result = assertSummaryHtmlOffline(html);
  assert.notEqual(typeof result?.then, 'function', 'offline assertion must be synchronous');
}

parityTest('offline assertion synchronously rejects prohibited elements and meta http-equiv', () => {
  for (const [name, html] of [
    ['script', envelope('<script type="application/json">{}</script>')],
    ['link', envelope('', '<link rel="stylesheet" href="./opaque.css">')],
    ['iframe', envelope('<iframe></iframe>')],
    ['object', envelope('<object></object>')],
    ['embed', envelope('<embed>')],
    ['base', envelope('', '<base href="./">')],
    ['meta http-equiv', envelope('', '<meta http-equiv="Content-Language" content="en">')],
  ]) assert.throws(() => assertSummaryHtmlOffline(html), offlineError, name);
});

parityTest('offline assertion rejects on* attributes and non-inline resource references', () => {
  for (const [name, body] of [
    ['onclick', '<p onclick="">text</p>'],
    ['ONLOAD', `<img src="${gif}" ONLOAD="">`],
    ['onerror', `<img src="${gif}" onerror="">`],
    ['onpointerenter', '<p onpointerenter="">text</p>'],
    ['remote src', `<img src="${fixtureUrl}">`],
    ['relative src', '<img src="./opaque.png">'],
    ['remote second srcset candidate', `<img src="${gif}" srcset="${gif} 1x, ${fixtureUrl} 2x">`],
    ['relative first srcset candidate', `<img src="${gif}" srcset="./opaque.png 1x, ${gif} 2x">`],
    ['external poster', `<video poster="${fixtureUrl}"></video>`],
    ['external xlink:href', `<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="${fixtureUrl}"></use></svg>`],
    ['external inline CSS url', `<p style="background-image:url('${fixtureUrl}')">text</p>`],
  ]) assert.throws(() => assertSummaryHtmlOffline(envelope(body)), offlineError, name);
  assert.throws(() => assertSummaryHtmlOffline(envelope('<p>text</p>', '<style>p{background-image:url(./opaque.png)}</style>')), offlineError, 'relative stylesheet CSS url');
});

parityTest('offline assertion accepts embedded references and does not inspect ordinary text as markup', () => {
  const body = `<p>onload= &lt;script&gt; src="${fixtureUrl}" url(./text-only)</p><img src="${gif}" alt="text">`
    + '<math xmlns="http://www.w3.org/1998/Math/MathML"><mspace width="1em"/></math>';
  accept(envelope(body, `<style>p{background-image:url('${gif}')}</style>`));
});

parityTest('offline assertion treats a href according to the pinned markdown-it link policy', () => {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  for (const href of [fixtureUrl, './paper.html', '#proof', 'mailto:fixture@example.invalid', gif,
    'javascript:opaque', 'vbscript:opaque', 'file:///opaque.txt', 'data:text/plain,opaque']) {
    const html = envelope(`<p><a href="${href}">citation</a></p>`);
    if (md.validateLink(href)) accept(html);
    else assert.throws(() => assertSummaryHtmlOffline(html), offlineError, href);
  }
});
