#!/usr/bin/env node
/**
 * Place rendered diagrams into their pages.
 *
 * A source may declare where it belongs with a leading directive:
 *
 *     %% section: Deep dives
 *     %% caption: What happens when the leader pauses
 *
 * With a `section`, the diagram is inserted directly under that markdown
 * heading. Without one it goes at the top of the page, under "How it works".
 *
 * Each insertion is delimited by a comment carrying the diagram's name, so
 * re-running replaces that block instead of stacking duplicates.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SRC = path.join(ROOT, 'diagrams-src');

const pageFor = {};
for (const section of fs.readdirSync(DOCS)) {
  const dir = path.join(DOCS, section);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.md')) pageFor[f.replace(/\.md$/, '')] = path.join(dir, f);
  }
}

const titleCase = (s) => s.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());

function directives(file) {
  const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 6);
  const out = {};
  for (const line of head) {
    const m = line.match(/^\s*%%\s*(section|caption)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

let pages = 0, blocks = 0;
const skipped = [];

for (const slug of fs.readdirSync(SRC)) {
  const dir = path.join(SRC, slug);
  if (!fs.statSync(dir).isDirectory()) continue;
  const md = pageFor[slug];
  if (!md) { skipped.push(`${slug}: no matching page`); continue; }

  let text = fs.readFileSync(md, 'utf8');
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.mmd')).sort();
  let touched = false;

  for (const file of names) {
    const name = file.replace(/\.mmd$/, '');
    const svg = path.join(ROOT, 'static/diagrams', slug, `${name}.svg`);
    if (!fs.existsSync(svg)) { skipped.push(`${slug}/${name}: not rendered`); continue; }

    const d = directives(path.join(dir, file));
    const caption = d.caption || (name === 'sequence' ? 'How it works' : titleCase(name));
    const START = `<!-- DIAGRAM:${name}:START -->`;
    const END = `<!-- DIAGRAM:${name}:END -->`;
    const img = `<img src="/diagrams/${slug}/${name}.svg" alt="${caption.replace(/"/g, '&quot;')}" class="doc-diagram doc-diagram-seq" />`;

    // under a named section the heading already labels it, so no extra heading
    const block = d.section
      ? `${START}\n\n${img}\n\n${END}`
      : `${START}\n\n## ${caption}\n\n${img}\n\n${END}`;

    if (text.includes(START)) {
      text = text.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
    } else if (d.section) {
      // literal line match - heading text contains parens, plus signs and
      // colons, and getting the regex escaping wrong silently skips the page
      const lines = text.split('\n');
      // prefix match: the directive names the stable part of the heading,
      // which often carries a parenthetical the author may reword
      const i = lines.findIndex((l) => /^##+ /.test(l) &&
        l.replace(/^##+ /, '').replace(/\s*\{#.*$/, '').trim().startsWith(d.section));
      if (i === -1) { skipped.push(`${slug}/${name}: section "${d.section}" not found`); continue; }
      lines.splice(i + 1, 0, '', block);
      text = lines.join('\n');
    } else {
      const fm = text.match(/^---\n[\s\S]*?\n---\n/);
      if (!fm) { skipped.push(`${slug}/${name}: no frontmatter`); continue; }
      text = fm[0] + '\n' + block + '\n' + text.slice(fm[0].length);
    }
    blocks++;
    touched = true;
  }

  if (touched) { fs.writeFileSync(md, text); pages++; }
}

console.log(`${blocks} diagram block(s) across ${pages} page(s)`);
if (skipped.length) {
  console.log(`\nskipped (${skipped.length}):`);
  skipped.slice(0, 20).forEach((s) => console.log('  ' + s));
}
