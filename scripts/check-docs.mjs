#!/usr/bin/env node
/** Docs gate: resolve relative links and repo paths in living docs, enforce size limits. Read-only. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = ['README.md', 'dev-state.md', 'CHANGELOG.md', 'docs/README.md', 'docs/danus-parity.md', 'docs/roadmap.md', 'docs/open-issues.md', 'docs/testing.md', 'docs/live-runs.md', 'docs/design/README.md', 'docs/reviews/README.md', 'packages/hana-math/README.md', 'engine/README.md', 'engine/CONTRACTS.md'];
const LIMITS = { 'README.md': 40, 'dev-state.md': 60, 'docs/roadmap.md': 60, 'docs/testing.md': 80 };
const MAX_REVIEWS = 4; // README + three reports
const CODE_ROOTS = ['tests/', 'scripts/', 'packages/', 'engine/'];
const errors = [];

const exists = (rel) => fs.existsSync(path.join(REPO, rel));
const lines = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n').length;

for (const rel of LIVE) {
  if (!exists(rel)) { errors.push(`${rel}: missing`); continue; }
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
  if (LIMITS[rel] && lines(rel) > LIMITS[rel]) errors.push(`${rel}: ${lines(rel)} lines, limit ${LIMITS[rel]}`);
  for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g)) {
    if (/^(?:https?:|mailto:)/.test(target)) continue;
    if (!exists(path.posix.normalize(path.posix.join(path.posix.dirname(rel), target)))) errors.push(`${rel}: broken link ${target}`);
  }
  for (const [, code] of text.matchAll(/`([^`\n]+)`/g)) {
    if (/[*?]/.test(code)) continue;
    const plain = code.replace(/:\d+(-\d+)?$/, '');
    const local = path.posix.normalize(path.posix.join(path.posix.dirname(rel), plain));
    if (!CODE_ROOTS.some((root) => plain.startsWith(root))) continue;
    if (!exists(plain) && !exists(local)) errors.push(`${rel}: path not found ${code}`);
  }
}

if (exists('docs/reviews')) {
  const reports = fs.readdirSync(path.join(REPO, 'docs/reviews')).filter((name) => name.endsWith('.md') && name !== 'README.md');
  if (reports.length > MAX_REVIEWS - 1) errors.push(`docs/reviews: ${reports.length} reports, keep at most ${MAX_REVIEWS - 1}`);
}

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`docs ok: ${LIVE.length} files`);
