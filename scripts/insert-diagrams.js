#!/usr/bin/env node
/**
 * Place each rendered diagram into its page, under a "How it works" heading
 * directly after the frontmatter.
 *
 * The block is delimited by HTML comments so the script is idempotent: a
 * re-run replaces the block rather than stacking another copy.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SRC = path.join(ROOT, 'diagrams-src');
const START = '<!-- DIAGRAM:START -->';
const END = '<!-- DIAGRAM:END -->';

/** page slug -> its .md path */
const pageFor = {};
for (const section of fs.readdirSync(DOCS)) {
  const dir = path.join(DOCS, section);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.md')) pageFor[f.replace(/\.md$/, '')] = path.join(dir, f);
  }
}

const CAPTION = {
  sequence: 'How it works',
};

let inserted = 0, skipped = [];
for (const slug of fs.readdirSync(SRC)) {
  const dir = path.join(SRC, slug);
  if (!fs.statSync(dir).isDirectory()) continue;
  const md = pageFor[slug];
  if (!md) { skipped.push(`${slug}: no matching page`); continue; }

  const diagrams = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.mmd'))
    .map((f) => f.replace(/\.mmd$/, ''))
    .filter((name) => fs.existsSync(path.join(ROOT, 'static/diagrams', slug, `${name}.svg`)))
    .sort();
  if (!diagrams.length) { skipped.push(`${slug}: nothing rendered`); continue; }

  const body = diagrams.map((name) => {
    const heading = CAPTION[name] || name.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
    return `## ${heading}\n\n<img src="/diagrams/${slug}/${name}.svg" alt="${heading} — ${slug}" class="doc-diagram doc-diagram-seq" />`;
  }).join('\n\n');

  const block = `${START}\n\n${body}\n\n${END}`;
  let text = fs.readFileSync(md, 'utf8');

  if (text.includes(START)) {
    text = text.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
  } else {
    const fm = text.match(/^---\n[\s\S]*?\n---\n/);
    if (!fm) { skipped.push(`${slug}: no frontmatter`); continue; }
    text = fm[0] + '\n' + block + '\n' + text.slice(fm[0].length);
  }
  fs.writeFileSync(md, text);
  inserted++;
  console.log(`  ${slug}  (${diagrams.length})`);
}

console.log(`\ninserted into ${inserted} page(s)`);
if (skipped.length) { console.log('skipped:'); skipped.forEach((s) => console.log('  ' + s)); }
