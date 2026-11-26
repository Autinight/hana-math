// Pure deep-theorem chapter-tree assembly, macro/label/bib safety checks,
// seam diagnostics, and operator-confirmed style rules validation.
// Faithfully implements Danus write-paper §2b pitfalls without Host/FS IO.
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { referenceLedgerKeys, referenceVerificationKeys } from './reference-verification.mjs';

const REPORT_ID = /^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHAPTER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_CHAPTERS = 32, MAX_BYTES = 2 * 1024 * 1024;
const POINTER_SENTENCE = 'The complete development is given in the dedicated technical section inserted below.';
const fail = (code, details) => { throw Object.assign(new Error(details ? `${code}: ${details}` : code), { code, ...(details ? { details } : {}) }); };
const check = (ok, code, details) => { if (!ok) fail(code, details); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function plainData(value, allowed, required, code) {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const keys = Reflect.ownKeys(value);
  if (!keys.every(key => typeof key === 'string' && allowed.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
    || !required.every(key => keys.includes(key))) fail(code);
  return Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(value, key).value]));
}

function validNodeSelector(node, allowedExtra, requiredExtra, code) {
  const allowed = ['reportId', 'planReportId', 'finalSectionReportId', ...allowedExtra];
  const data = plainData(node, allowed, requiredExtra, code);
  if (Object.hasOwn(data, 'reportId')) {
    if (Object.hasOwn(data, 'planReportId') || Object.hasOwn(data, 'finalSectionReportId')
      || typeof data.reportId !== 'string' || !REPORT_ID.test(data.reportId)) fail(code);
  } else {
    if (!Object.hasOwn(data, 'planReportId') || !Object.hasOwn(data, 'finalSectionReportId')
      || typeof data.planReportId !== 'string' || !REPORT_ID.test(data.planReportId)
      || typeof data.finalSectionReportId !== 'string' || !REPORT_ID.test(data.finalSectionReportId)) fail(code);
  }
  return data;
}

const cleanLine = (value, max = 4096) => typeof value === 'string' && value.isWellFormed()
  && !value.includes('\0') && value.trim().length > 0 && Buffer.byteLength(value) <= max;

/** Enforce explicit operator confirmation before adopting any custom author style rules. */
export function validateConfirmedStyleRules(rules, code = 'PROJECT_PAPER_STYLE_UNCONFIRMED') {
  const data = plainData(rules, ['confirmedByOperator', 'rules', 'sha256'], ['confirmedByOperator', 'rules'], code);
  if (data.confirmedByOperator !== true) fail(code, 'Operator must explicitly confirm author style rules');
  if (!cleanLine(data.rules, 16 * 1024)) fail('PROJECT_INVALID_INPUT');
  const digest = sha(Buffer.from(data.rules, 'utf8'));
  if (Object.hasOwn(data, 'sha256') && data.sha256 !== digest) fail('PROJECT_INVALID_INPUT');
  return Object.freeze({ confirmedByOperator: true, rules: data.rules, sha256: digest });
}

export function snapshotChapterTreeRequest(input, { tool = false, code = 'PROJECT_INVALID_INPUT' } = {}) {
  const base = ['projectId', ...(tool ? ['action'] : []), 'host', 'chapters'];
  const result = plainData(input, [...base, 'confirmedStyleRules'], base, code);
  if (tool && result.action !== 'paper_chapter_tree_stitch') fail(code);
  if (typeof result.projectId !== 'string' || !PROJECT_ID.test(result.projectId)) fail(code);
  const host = validNodeSelector(result.host, ['assemblyAnchor'], [], code);
  if (Object.hasOwn(host, 'assemblyAnchor') && !cleanLine(host.assemblyAnchor, 1024)) fail(code);
  if (!Array.isArray(result.chapters) || result.chapters.length < 1 || result.chapters.length > MAX_CHAPTERS) fail(code);
  const seen = new Set();
  const chapters = result.chapters.map(raw => {
    const ch = validNodeSelector(raw, ['chapterId', 'title', 'dependsOn', 'hostPointerLabel'], ['chapterId', 'title'], code);
    if (typeof ch.chapterId !== 'string' || !CHAPTER_ID.test(ch.chapterId) || seen.has(ch.chapterId)) fail(code);
    seen.add(ch.chapterId);
    if (!cleanLine(ch.title, 1024)) fail(code);
    if (Object.hasOwn(ch, 'hostPointerLabel') && !cleanLine(ch.hostPointerLabel, 256)) fail(code);
    if (Object.hasOwn(ch, 'dependsOn')) {
      if (!Array.isArray(ch.dependsOn) || ch.dependsOn.length > MAX_CHAPTERS
        || !ch.dependsOn.every(id => typeof id === 'string' && CHAPTER_ID.test(id) && id !== ch.chapterId)
        || new Set(ch.dependsOn).size !== ch.dependsOn.length) fail(code);
      ch.dependsOn = [...ch.dependsOn];
    } else ch.dependsOn = [];
    return ch;
  });
  for (const ch of chapters) for (const dep of ch.dependsOn) if (!seen.has(dep)) fail(code);
  const out = { ...result, host, chapters };
  if (Object.hasOwn(result, 'confirmedStyleRules')) {
    out.confirmedStyleRules = validateConfirmedStyleRules(result.confirmedStyleRules);
  }
  return out;
}

// Mask unescaped TeX comments with spaces of equal length so offsets stay exact.
const maskComments = tex => tex.replace(/\\(?:[A-Za-z]+|[\s\S])|%[^\r\n]*/g,
  token => token.startsWith('%') ? ' '.repeat(token.length) : token);

function splitDocument(tex) {
  const masked = maskComments(tex);
  const beginDoc = masked.indexOf('\\begin{document}');
  const endDoc = masked.lastIndexOf('\\end{document}');
  check(beginDoc >= 0 && endDoc > beginDoc, 'PROJECT_PAPER_TREE_TEX_INVALID', 'Missing \\begin{document} or \\end{document}');
  const preamble = tex.slice(0, beginDoc);
  const body = tex.slice(beginDoc + '\\begin{document}'.length, endDoc);
  const tail = tex.slice(endDoc);
  return { preamble, body, tail };
}

function extractBibliography(body) {
  const masked = maskComments(body);
  const start = masked.indexOf('\\begin{thebibliography}');
  if (start < 0) return { content: body, bibitems: new Map(), hasBib: false };
  const endTag = '\\end{thebibliography}';
  const end = masked.indexOf(endTag, start);
  check(end >= 0, 'PROJECT_PAPER_TREE_TEX_INVALID', 'Unclosed thebibliography environment');
  const bibBlock = body.slice(start, end + endTag.length);
  const content = (body.slice(0, start) + body.slice(end + endTag.length)).trim();
  const bibitems = new Map();
  const innerStart = bibBlock.indexOf('\n');
  const innerEnd = bibBlock.lastIndexOf(endTag);
  const inner = innerStart >= 0 && innerEnd > innerStart ? bibBlock.slice(innerStart + 1, innerEnd) : '';
  const re = /\\bibitem(?:\[[^\]]*\])?\{([^{}\s]+)\}/g;
  const matches = [...inner.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1];
    const from = matches[i].index;
    const to = i + 1 < matches.length ? matches[i + 1].index : inner.length;
    if (!bibitems.has(key)) bibitems.set(key, inner.slice(from, to).trim());
  }
  return { content, bibitems, hasBib: true };
}

function extractChapterBody(tex) {
  const { preamble, body } = splitDocument(tex);
  const { content, bibitems } = extractBibliography(body);
  let stripped = content;
  // Drop chapter-level abstract, acknowledgements, title/author/address/email/maketitle.
  stripped = stripped.replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}\s*/g, '');
  stripped = stripped.replace(/\\section\*?\{Acknowledgements?\}[\s\S]*?(?=\\section|\s*$)/gi, '');
  stripped = stripped.replace(/^[ \t]*\\(?:title|author|address|email|thanks|date|subjclass|keywords)(?:\[[^\]]*\])?\{[^{}]*\}[ \t]*\r?\n?/gm, '');
  stripped = stripped.replace(/^[ \t]*\\maketitle[ \t]*\r?\n?/gm, '');
  stripped = stripped.trim();
  check(stripped.length > 0, 'PROJECT_PAPER_TREE_TEX_INVALID', 'Empty chapter body after stripping framing');
  return { preamble, body: stripped, bibitems };
}

function demoteSectioning(body) {
  // Replace outside comments in reverse hierarchy order so \section is never double-demoted.
  const lines = body.split('\n');
  return lines.map(line => {
    // Process only the non-comment prefix of each line.
    let splitAt = line.length;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] === '%') { splitAt = i; break; }
    }
    const code = line.slice(0, splitAt), comment = line.slice(splitAt);
    const demoted = code
      .replace(/\\subsubsection(\*?)\s*\{/g, '\\paragraph$1{')
      .replace(/\\subsection(\*?)\s*\{/g, '\\subsubsection$1{')
      .replace(/\\section(\*?)\s*\{/g, '\\subsection$1{');
    return demoted + comment;
  }).join('\n');
}

function findLabels(tex) {
  const masked = maskComments(tex), labels = [];
  for (const match of masked.matchAll(/\\label\s*\{([^{}]+)\}/g)) labels.push(match[1].trim());
  return labels;
}

function namespaceChapterLabels(body, chapterId) {
  const localLabels = new Set(findLabels(body));
  const prefix = `${chapterId}:`;
  const lines = body.split('\n');
  const namespaced = lines.map(line => {
    let splitAt = line.length;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] === '%') { splitAt = i; break; }
    }
    const code = line.slice(0, splitAt), comment = line.slice(splitAt);
    const updated = code
      .replace(/\\label\s*\{([^{}]+)\}/g, (_, l) => `\\label{${prefix}${l.trim()}}`)
      .replace(/\\(eq|page)?ref\s*\{([^{}]+)\}/g, (full, kind = '', l) => {
        const key = l.trim();
        return localLabels.has(key) ? `\\${kind}ref{${prefix}${key}}` : full;
      });
    return updated + comment;
  }).join('\n');
  return { tex: namespaced, localLabels: [...localLabels] };
}

function parsePreambleDeclarations(preamble) {
  const packages = [], macros = new Map(), renewMacros = new Map(), theorems = new Map();
  for (const rawLine of preamble.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%')) continue;
    if (/^\\usepackage\b/.test(line)) {
      packages.push(line);
      continue;
    }
    const renew = /^\\renewcommand\*?\s*\{?(\\[A-Za-z]+)\}?(.*)$/.exec(line);
    if (renew) {
      const name = renew[1], body = renew[2].replace(/\s+/g, ' ').trim();
      renewMacros.set(name, { line, body });
      continue;
    }
    const macro = /^\\(?:newcommand|providecommand|DeclareMathOperator)\*?\s*\{?(\\[A-Za-z]+)\}?(.*)$/.exec(line);
    if (macro) {
      const name = macro[1], body = macro[2].replace(/\s+/g, ' ').trim();
      macros.set(name, { line, body });
      continue;
    }
    const thm = /^\\newtheorem\*?\s*\{([A-Za-z0-9_*-]+)\}(.*)$/.exec(line);
    if (thm) {
      theorems.set(thm[1], { line, body: thm[2].replace(/\s+/g, ' ').trim() });
    }
  }
  return { packages, macros, renewMacros, theorems };
}

function topologicalOrder(chapters) {
  const byId = new Map(chapters.map((c, idx) => [c.chapterId, { ...c, index: idx }]));
  const inDegree = new Map(chapters.map(c => [c.chapterId, c.dependsOn.length]));
  const dependents = new Map(chapters.map(c => [c.chapterId, []]));
  for (const c of chapters) for (const dep of c.dependsOn) dependents.get(dep).push(c.chapterId);
  const queue = chapters.filter(c => inDegree.get(c.chapterId) === 0).map(c => c.chapterId);
  const ordered = [];
  while (queue.length) {
    queue.sort((a, b) => byId.get(a).index - byId.get(b).index);
    const id = queue.shift();
    ordered.push(id);
    for (const next of dependents.get(id)) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  const cyclic = chapters.filter(c => !ordered.includes(c.chapterId)).map(c => c.chapterId);
  const fullOrder = [...ordered, ...cyclic];
  const position = new Map(fullOrder.map((id, i) => [id, i]));
  const forwardEdges = [];
  for (const id of fullOrder) {
    for (const dep of byId.get(id).dependsOn) {
      if (position.get(dep) > position.get(id)) forwardEdges.push({ from: id, dependsOn: dep });
    }
  }
  return { orderedIds: fullOrder, cyclicDependencies: cyclic, forwardEdges };
}

/** Merge multiple REFERENCE_LEDGER.md texts, keeping confirmed rows and flagging unverified/conflicting rows. */
export function mergeReferenceLedgers(ledgers) {
  check(Array.isArray(ledgers) && ledgers.length > 0, 'PROJECT_PAPER_TREE_LEDGER_INVALID');
  const header = "# REFERENCE_LEDGER\n\nSeeded from the project's verified facts' `external_refs`. Each row is a\npublished result some proof cited. `verified-by: unverified` rows still\nneed an independent check by the reference auditor (authors / title /\nvenue / year / arXiv id). Do not fabricate; flag what cannot be verified.\n\n";
  const byKey = new Map();
  for (const ledger of ledgers) {
    // Validate each input ledger with referenceLedgerKeys.
    referenceLedgerKeys(ledger);
    const lines = ledger.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('## ')) continue;
      const key = lines[i].slice(3);
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) if (lines[j].startsWith('## ')) { end = j; break; }
      const chunkLines = lines.slice(i, end);
      while (chunkLines.length && chunkLines.at(-1) === '') chunkLines.pop();
      const verifiedLine = chunkLines.find(l => l.startsWith('- verified-by: ')) ?? '';
      const verified = verifiedLine === '- verified-by: verifier' || verifiedLine === '- verified-by: operator';
      const existing = byKey.get(key);
      if (!existing) byKey.set(key, { lines: chunkLines, verified });
      else if (verified && !existing.verified) byKey.set(key, { lines: chunkLines, verified: true });
      // Keep first verified or first unverified deterministically.
    }
  }
  if (!byKey.size) return `${header}_(no external references captured on any fact yet)_\n`;
  const blocks = [...byKey.keys()].sort().map(key => byKey.get(key).lines.join('\n'));
  return `${header}${blocks.join('\n\n')}\n`;
}

function collectCitedKeys(tex) {
  const masked = maskComments(tex), cited = new Set();
  for (const match of masked.matchAll(/\\cite\*?(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      const key = part.trim();
      if (key) cited.add(key);
    }
  }
  return cited;
}

/**
 * Assemble a host paper and ordered technical chapters into one merged LaTeX paper.
 * Fails closed on semantic macro conflicts, conflicting \renewcommand, or duplicate \label{...}.
 */
export function assembleChapterTree({ host, chapters, confirmedStyleRules = null, maxBytes = MAX_BYTES }) {
  check(host && typeof host.tex === 'string' && typeof host.ledger === 'string', 'PROJECT_PAPER_TREE_INVALID_INPUT');
  check(Array.isArray(chapters) && chapters.length >= 1 && chapters.length <= MAX_CHAPTERS, 'PROJECT_PAPER_TREE_INVALID_INPUT');
  if (confirmedStyleRules !== null) validateConfirmedStyleRules(confirmedStyleRules);

  const { orderedIds, cyclicDependencies, forwardEdges } = topologicalOrder(chapters);
  const byId = new Map(chapters.map(c => [c.chapterId, c]));

  const hostDoc = splitDocument(host.tex);
  const hostBib = extractBibliography(hostDoc.body);
  const hostDecls = parsePreambleDeclarations(hostDoc.preamble);

  const mergedPackages = new Set(hostDecls.packages);
  const addedPackages = [];
  const mergedMacros = new Map(hostDecls.macros);
  const addedMacros = [];
  const mergedRenews = new Map(hostDecls.renewMacros);
  const addedRenews = [];
  const mergedTheorems = new Map(hostDecls.theorems);
  const addedTheorems = [];
  const theoremWarnings = [];
  const allBibitems = new Map(hostBib.bibitems);
  const seamChecklist = [];
  const chapterResults = [];
  let disclosureCount = (hostDoc.body.match(/Danus system/gi) ?? []).length;

  const renderedChapters = [];
  for (const id of orderedIds) {
    const ch = byId.get(id);
    const extracted = extractChapterBody(ch.tex);
    const decls = parsePreambleDeclarations(extracted.preamble);

    for (const pkg of decls.packages) {
      if (!mergedPackages.has(pkg)) { mergedPackages.add(pkg); addedPackages.push(pkg); }
    }
    for (const [name, info] of decls.macros) {
      const existing = mergedMacros.get(name);
      if (!existing) { mergedMacros.set(name, info); addedMacros.push(info.line); }
      else if (existing.body !== info.body) {
        fail('PROJECT_PAPER_TREE_MACRO_CONFLICT', `Conflicting macro ${name} in chapter ${id}`);
      }
    }
    for (const [name, info] of decls.renewMacros) {
      const existing = mergedRenews.get(name);
      if (!existing) { mergedRenews.set(name, info); addedRenews.push(info.line); }
      else if (existing.body !== info.body) {
        fail('PROJECT_PAPER_TREE_MACRO_CONFLICT', `Conflicting \\renewcommand ${name} in chapter ${id}`);
      }
    }
    for (const [env, info] of decls.theorems) {
      const existing = mergedTheorems.get(env);
      if (!existing) { mergedTheorems.set(env, info); addedTheorems.push(info.line); }
      else if (existing.body !== info.body) {
        theoremWarnings.push(`Chapter ${id} uses variant \\newtheorem{${env}}; kept host definition.`);
      }
    }
    for (const [key, item] of extracted.bibitems) {
      if (!allBibitems.has(key)) allBibitems.set(key, item);
    }

    const demoted = demoteSectioning(extracted.body);
    const { tex: namespaced, localLabels } = namespaceChapterLabels(demoted, id);
    const sectionLabel = `sec:tech-${id}`;
    renderedChapters.push(`\\section{${ch.title}}\\label{${sectionLabel}}\n${namespaced}`);

    disclosureCount += (extracted.body.match(/Danus system/gi) ?? []).length;
    for (const [pattern, kind] of [
      [/established earlier in this paper/gi, 'setup-import'],
      [/\[cite\/blocker\]/gi, 'cite-blocker'],
      [/\[GAP:/gi, 'proof-gap'],
    ]) {
      if (pattern.test(namespaced)) seamChecklist.push({ chapterId: id, sectionLabel, kind });
    }
    chapterResults.push({ chapterId: id, title: ch.title, sectionLabel, dependsOn: [...ch.dependsOn],
      localLabelCount: localLabels.length, hostPointerLabel: ch.hostPointerLabel ?? null, pointerReplaced: false });
  }

  // Merge new packages BEFORE \usepackage{hyperref} (load-order pitfall).
  let finalPreamble = hostDoc.preamble;
  if (addedPackages.length) {
    const pkgBlock = addedPackages.join('\n') + '\n';
    const hyperrefMatch = /^[ \t]*\\usepackage(?:\[[^\]]*\])?\{hyperref\}/m.exec(finalPreamble);
    if (hyperrefMatch) {
      finalPreamble = finalPreamble.slice(0, hyperrefMatch.index) + pkgBlock + finalPreamble.slice(hyperrefMatch.index);
    } else {
      finalPreamble = finalPreamble.replace(/\s*$/, '\n') + pkgBlock;
    }
  }
  const extraDecls = [...addedTheorems, ...addedMacros, ...addedRenews];
  if (extraDecls.length) {
    finalPreamble = finalPreamble.replace(/\s*$/, '\n') + extraDecls.join('\n') + '\n';
  }

  // Replace host pointer-proof sentences using explicit hostPointerLabel entries.
  let hostBody = hostBib.content;
  const pointerWarnings = [];
  for (const ch of chapterResults) {
    if (!ch.hostPointerLabel) continue;
    const labelToken = `\\label{${ch.hostPointerLabel}}`;
    const labelIdx = hostBody.indexOf(labelToken);
    if (labelIdx < 0) {
      pointerWarnings.push(`Host label ${ch.hostPointerLabel} for chapter ${ch.chapterId} not found.`);
      continue;
    }
    const ptrIdx = hostBody.indexOf(POINTER_SENTENCE, labelIdx);
    const nextSection = hostBody.indexOf('\\section', labelIdx + labelToken.length);
    if (ptrIdx >= 0 && (nextSection < 0 || ptrIdx < nextSection)) {
      const replacement = `The complete development is given in Section~\\ref{${ch.sectionLabel}}.`;
      hostBody = hostBody.slice(0, ptrIdx) + replacement + hostBody.slice(ptrIdx + POINTER_SENTENCE.length);
      ch.pointerReplaced = true;
    } else {
      pointerWarnings.push(`Pointer proof sentence for ${ch.hostPointerLabel} (${ch.chapterId}) not found.`);
    }
  }

  // Insert chapters before host's assembly section (or anchor, or end of host body).
  const chaptersBlock = renderedChapters.join('\n\n');
  let insertAt = -1;
  if (host.assemblyAnchor) {
    insertAt = hostBody.indexOf(host.assemblyAnchor);
    check(insertAt >= 0, 'PROJECT_PAPER_TREE_ANCHOR_NOT_FOUND', `Assembly anchor not found: ${host.assemblyAnchor}`);
  } else {
    const match = /\\section\*?\{(?:Proof of |Assembly)/i.exec(hostBody);
    insertAt = match ? match.index : hostBody.length;
  }
  const mergedBody = insertAt < hostBody.length
    ? `${hostBody.slice(0, insertAt).replace(/\s*$/, '')}\n\n${chaptersBlock}\n\n${hostBody.slice(insertAt).replace(/^\s*/, '')}`
    : `${hostBody.replace(/\s*$/, '')}\n\n${chaptersBlock}`;

  // Merge reference ledgers & filter bibliography to actually cited keys.
  const mergedLedger = mergeReferenceLedgers([host.ledger, ...orderedIds.map(id => byId.get(id).ledger)]);
  const unverifiedKeys = new Set(referenceVerificationKeys(mergedLedger));
  const allLedgerKeys = new Set(referenceLedgerKeys(mergedLedger));
  const citedKeys = collectCitedKeys(mergedBody);
  const bibliographyWarnings = [];
  const keptBibitems = [];
  for (const key of [...citedKeys].sort()) {
    if (allBibitems.has(key)) keptBibitems.push(allBibitems.get(key));
    else bibliographyWarnings.push(`Cited key '${key}' has no \\bibitem in host or chapters.`);
    if (!allLedgerKeys.has(key)) bibliographyWarnings.push(`Cited key '${key}' is absent from the merged REFERENCE_LEDGER.md.`);
    else if (unverifiedKeys.has(key)) bibliographyWarnings.push(`Cited key '${key}' remains unverified in the merged REFERENCE_LEDGER.md.`);
  }
  const bibSection = keptBibitems.length
    ? `\n\n\\begin{thebibliography}{99}\n${keptBibitems.join('\n')}\n\\end{thebibliography}` : '';
  const mergedTex = `${finalPreamble.replace(/\s*$/, '')}\n\\begin{document}\n${mergedBody}${bibSection}\n\n\\end{document}\n`;

  // Fail closed on multiply-defined \label{...} across the merged document.
  const seenLabels = new Set(), duplicateLabels = new Set();
  for (const label of findLabels(mergedTex)) {
    if (seenLabels.has(label)) duplicateLabels.add(label);
    seenLabels.add(label);
  }
  check(duplicateLabels.size === 0, 'PROJECT_PAPER_TREE_DUPLICATE_LABEL', [...duplicateLabels].sort().join(', '));

  const mainTexBytes = Buffer.from(mergedTex, 'utf8');
  check(mainTexBytes.length <= maxBytes, 'PROJECT_PAPER_STITCH_TOO_LARGE');
  const ledgerBytes = Buffer.from(mergedLedger, 'utf8');
  const provenanceBytes = Buffer.from('null\n');

  const manifest = {
    schemaVersion: 1,
    kind: 'paper-chapter-tree',
    chapterOrder: orderedIds,
    chapters: chapterResults,
    cyclicDependencies,
    forwardEdges,
    seamChecklist,
    duplicateDisclosureCount: Math.max(0, disclosureCount - 1),
    theoremWarnings,
    pointerWarnings,
    bibliographyWarnings,
    citedKeys: [...citedKeys].sort(),
    includedBibitemCount: keptBibitems.length,
    confirmedStyleRulesSha256: confirmedStyleRules?.sha256 ?? null,
    mainSha256: sha(mainTexBytes),
    ledgerSha256: sha(ledgerBytes),
    mathematicsStatus: 'unreviewed',
    citationStatus: unverifiedKeys.size > 0 ? 'unverified' : 'not-checked',
    compileStatus: 'not-run',
    limitations: [
      'Mechanical chapter-tree assembly only; discharge residual seams via paper_revise, then run paper_audit/paper_verify and whole-paper paper_verify_math.',
      'No TeX compilation, citation verification or mathematical verification was performed during assembly.',
    ],
  };
  return { mainTexBytes, ledgerBytes, provenanceBytes, manifest };
}
