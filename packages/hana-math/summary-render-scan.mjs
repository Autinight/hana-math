// SPDX-License-Identifier: Apache-2.0
// A rejection-only scan of the final MarkdownIt/KaTeX output, not an HTML sanitizer.
const blocked = new Set(['script', 'link', 'iframe', 'object', 'embed', 'base']);
const rawText = new Set(['style', 'title', 'textarea', 'xmp', 'noembed', 'noframes']);
const cssAttributes = new Set(['style', 'fill', 'stroke', 'filter', 'clip-path', 'mask', 'cursor', 'marker', 'marker-start', 'marker-mid', 'marker-end']);
const space = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const skipSpace = (text, i) => { while (space(text[i])) i++; return i; };
const reject = () => { throw Object.assign(new Error('Summary HTML is not self-contained.'), { code: 'SUMMARY_HTML_NOT_SELF_CONTAINED' }); };
const codePoint = n => String.fromCodePoint(n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? n : 0xfffd);

function attributeValue(raw, md) {
  // Numeric references can omit the semicolon in HTML attributes. Named ones
  // affecting the URL scheme, whitespace or srcset separators require it.
  return raw.replace(/&(?:#(x[\da-f]+|\d+);?|[a-z][a-z\d]*;)/gi, (entity, number) =>
    number === undefined ? md.utils.unescapeAll(entity)
      : codePoint(/^x/i.test(number) ? parseInt(number.slice(1), 16) : Number(number)));
}
const browserUrl = value => value.replace(/[\t\r\n]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
function requireData(value) { if (!/^data:/i.test(browserUrl(value))) reject(); }

function scanSrcset(value) {
  // The URL token ends in ASCII whitespace, not at the first comma. Trailing
  // commas end a candidate; an internal comma belongs to the URL (e.g. data:).
  let i = 0;
  while (i < value.length) {
    while (space(value[i]) || value[i] === ',') i++;
    const start = i;
    while (i < value.length && !space(value[i])) i++;
    if (start === i) break;
    const url = value.slice(start, i), trimmed = url.replace(/,+$/, '');
    requireData(trimmed);
    if (url !== trimmed) continue;
    let inParens = false;
    while (i < value.length) {
      const c = value[i++];
      if (c === ',' && !inParens) break;
      if (c === '(') inParens = true;
      if (c === ')') inParens = false;
    }
  }
}

const cssEscape = /\\(?:([\da-f]{1,6})[ \t\n]?|([^\n])|\n)/gi;
const decodeCss = text => text.replace(cssEscape, (_, hex, c) => hex ? codePoint(parseInt(hex, 16)) : c ?? '');
function scanCss(source) {
  const css = source.replace(/\r\n?|\f/g, '\n');
  const name = /(?:[\w\u0080-\uffff-]+|\\(?:[\da-f]{1,6}[ \t\n]?|[^\n]))+/iy;
  const escape = new RegExp(cssEscape.source, 'iy');
  const functions = [];
  function quotedEnd(start) {
    for (let i = start + 1; i < css.length; i++) {
      if (css[i] === css[start] || css[i] === '\n') return i;
      if (css[i] === '\\') i++;
    }
    return css.length;
  }
  for (let i = 0; i < css.length;) {
    const c = css[i];
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
    } else if (c === '"' || c === "'") {
      const end = quotedEnd(i);
      if (functions.at(-1) === 'image-set' || functions.at(-1) === '-webkit-image-set') requireData(decodeCss(css.slice(i + 1, end)));
      i = end + 1;
    } else if (c === ')' || c === '(') {
      if (c === ')') functions.pop(); else functions.push('');
      i++;
    } else {
      name.lastIndex = i + Number(c === '@');
      const token = name.exec(css);
      if (!token) { i++; continue; }
      const ident = decodeCss(token[0]).toLowerCase();
      i = name.lastIndex;
      // An import can in turn load other resources, even from a data sheet.
      if (c === '@' && ident === 'import') reject();
      if (c === '@' || css[i] !== '(') continue;
      if (ident !== 'url') { functions.push(ident); i++; continue; }
      const start = skipSpace(css, i + 1);
      let end = start;
      if (css[start] === '"' || css[start] === "'") {
        end = quotedEnd(start);
        requireData(decodeCss(css.slice(start + 1, end)));
        i = end + 1;
      } else {
        while (end < css.length && css[end] !== ')' && !space(css[end])) {
          escape.lastIndex = end;
          end = escape.test(css) ? escape.lastIndex : end + 1;
        }
        requireData(decodeCss(css.slice(start, end)));
        i = end;
      }
      // Leave closing paren handling to the ordinary function token path.
      functions.push('url');
    }
  }
}

export function assertOfflineOutput(html, md) {
  if (typeof html !== 'string') reject();
  const tag = /<(\/?)([a-z][^\t\n\r\f />]*)/iy;
  const attr = /[^\t\n\r\f />=]+/y;
  for (let i = 0; (i = html.indexOf('<', i)) !== -1;) {
    if (html.startsWith('<!--', i)) {
      const tail = /^(?:-?>)|--!?>/g;
      const end = tail.exec(html.slice(i + 4));
      if (!end) break;
      i += 4 + end.index + end[0].length;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    tag.lastIndex = i++;
    const match = tag.exec(html);
    if (!match) continue;
    const [, close, rawName] = match, name = rawName.toLowerCase();
    i = tag.lastIndex;
    const attrs = [];
    while ((i = skipSpace(html, i)) < html.length && html[i] !== '>') {
      attr.lastIndex = i;
      const field = attr.exec(html);
      if (!field) { i++; continue; }
      i = skipSpace(html, attr.lastIndex);
      let value = '';
      if (html[i] === '=') {
        i = skipSpace(html, i + 1);
        if (html[i] === '"' || html[i] === "'") {
          const end = html.indexOf(html[i], i + 1);
          if (end < 0) { i = html.length; break; }
          value = html.slice(i + 1, end); i = end + 1;
        } else {
          const start = i;
          while (i < html.length && html[i] !== '>' && !space(html[i])) i++;
          value = html.slice(start, i);
        }
      }
      attrs.push([field[0].toLowerCase(), value]);
    }
    if (i++ >= html.length) break;
    if (close) continue;
    if (blocked.has(name)) reject();
    for (const [key, raw] of attrs) {
      if (key.startsWith('on') || name === 'meta' && key === 'http-equiv') reject();
      if (key === 'href') {
        const url = browserUrl(attributeValue(raw, md));
        if (name === 'a') { if (!md.validateLink(url)) reject(); }
        else if (!url.startsWith('#')) requireData(url);
      } else if (['src', 'poster', 'xlink:href', 'background'].includes(key)) requireData(attributeValue(raw, md));
      else if (key === 'srcset') scanSrcset(attributeValue(raw, md));
      else if (cssAttributes.has(key)) scanCss(attributeValue(raw, md));
    }
    if (rawText.has(name)) {
      const endTag = new RegExp(`</${name}(?=[\\t\\n\\r\\f />])`, 'gi');
      endTag.lastIndex = i;
      const end = endTag.exec(html);
      if (name === 'style') scanCss(html.slice(i, end?.index));
      if (!end) break;
      i = end.index;
    }
  }
}
