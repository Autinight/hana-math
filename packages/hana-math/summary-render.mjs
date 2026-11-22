// SPDX-License-Identifier: Apache-2.0
// Rendering order, document shell and document style are from Danus
// 6d92e8d415933ca2ef52fd1a4da73fdfcd418f1c:.agents/skills/human-summary/md2html.js.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import MarkdownIt from './summary-vendor/markdown-it.cjs';
import katex from './summary-vendor/katex.cjs';
import { assertOfflineOutput } from './summary-render-scan.mjs';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const fontSheet = new URL('./summary-vendor/katex-inline.css', import.meta.url);
const sheetSha256 = '50c11df8a5873e2d95c71bd89313c94ae26964f89d05b76705d2cdc2d790ccd3';
let sheet;

export function assertSummaryHtmlOffline(html) {
  assertOfflineOutput(html, md);
}

const css = `
body{font-family:"Noto Serif CJK SC","Songti SC",serif;font-size:11.5pt;line-height:1.7;color:#1a202c;max-width:760px;margin:0 auto;padding:24px 8px;}
h1{font-size:20pt;border-bottom:2px solid #e2e8f0;padding-bottom:8px;margin:0 0 14px;}
h2{font-size:15pt;margin:22px 0 8px;color:#1e293b;border-bottom:1px solid #eef2f7;padding-bottom:4px;}
h3{font-size:12.5pt;margin:16px 0 6px;color:#334155;} h4{font-size:11.5pt;margin:12px 0 4px;color:#475569;}
p{margin:0 0 9px;page-break-inside:avoid;break-inside:avoid-page;} ul,ol{margin:5px 0 9px;padding-left:22px;} li{margin:3px 0;}
h1,h2,h3,h4{page-break-after:avoid;break-after:avoid-page;}
code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:.9em;}
pre{background:#f8fafc;border:1px solid #e2e8f0;padding:10px 12px;border-radius:6px;overflow-x:auto;}
blockquote{border-left:3px solid #cbd5e1;margin:9px 0;padding:2px 14px;color:#475569;}
table{border-collapse:collapse;margin:10px 0;font-size:10.5pt;} tr{page-break-inside:avoid;break-inside:avoid-page;} th,td{border:1px solid #cbd5e1;padding:5px 10px;text-align:left;vertical-align:top;} th{background:#f1f5f9;}
.katex{font-size:1.04em;} .katex-display{margin:10px 0;overflow-x:auto;overflow-y:hidden;page-break-inside:avoid;break-inside:avoid-page;}
@page{margin:18mm 16mm;}`;

export async function renderSummaryHtml(markdown) {
  let text = markdown;
  const store = [];
  const stash = (tex, disp) => { store.push({ tex, disp }); return `@@MATH${store.length - 1}@@`; };
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, x) => stash(x, true));
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, x) => stash(x, true));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, x) => stash(x, false));
  text = text.replace(/\$([^\n$]+?)\$/g, (_, x) => stash(x, false));
  let body = md.render(text);
  body = body.replace(/@@MATH(\d+)@@/g, (_, i) => {
    const { tex, disp } = store[i];
    try { return katex.renderToString(tex, { displayMode: disp, throwOnError: false }); }
    catch (e) { return tex; }
  });
  sheet ??= readFile(fontSheet).then(bytes => {
    if (createHash('sha256').update(bytes).digest('hex') !== sheetSha256) {
      throw Object.assign(new Error('Invalid packaged KaTeX stylesheet.'), { code: 'SUMMARY_HTML_ASSETS_INVALID' });
    }
    return bytes.toString('utf8');
  });
  const inline = await sheet;
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${inline}</style>
<title></title><style>${css}</style></head><body class="md">${body}</body></html>`;
  assertSummaryHtmlOffline(html);
  return html;
}
