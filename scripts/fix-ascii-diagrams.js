#!/usr/bin/env node
/**
 * Recover ASCII diagrams that the migration flattened into prose.
 *
 * The source pages drew box-diagrams inside <div class="diagram"> (and a few
 * similar wrappers) that relied on white-space:pre. Turndown treats those as
 * ordinary block elements, so every newline collapsed to a space and the
 * diagram became one unreadable paragraph.
 *
 * The original HTML is still in git history. Each diagram's text is pulled
 * from there, matched against the markdown by whitespace-normalised content,
 * and put back as a fenced code block.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const SRC_REF = process.env.SRC_REF || 'deb8fd2~1';
const SELECTOR = process.env.SELECTOR || 'div.diagram, div.ascii, div.art, pre.diagram';

// Turndown escapes markdown punctuation (sys\_fork, \*, \#) and HTML
// entities differ, so normalise both sides before comparing.
const norm = (s) => s
  .replace(/\\([\\\\`*_{}\[\]()#+\-.!~|<>])/g, '$1')
  .replace(/\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function sourceFor(slug) {
  for (const cand of [`${slug}.html`, `linux-systems-guide/${slug}.html`]) {
    try {
      return execSync(`git show ${SRC_REF}:"${cand}"`,
        { cwd: ROOT, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch { /* next */ }
  }
  return null;
}

let fixedTotal = 0, pagesTouched = 0;
const unmatched = [];

for (const file of process.argv.slice(2)) {
  const mdPath = path.join(ROOT, file);
  const slug = path.basename(file, '.md');
  const html = sourceFor(slug);
  if (!html) { console.log(`  ! no source in git for ${slug}`); continue; }

  const doc = new JSDOM(html).window.document;
  // Any element whose own text is multi-line box art, not just the classes
  // we knew about. Leaf-most wins so an outer wrapper does not swallow two
  // separate diagrams into one block.
  const candidates = [...doc.querySelectorAll('div, pre, p, td, section, article')]
    .filter((el) => {
      const t = el.textContent || '';
      return t.includes('\n') && (t.match(/[\u2500-\u257f]/g) || []).length >= 4;
    });
  const blocks = candidates
    .filter((el) => !candidates.some((o) => o !== el && el.contains(o)))
    .map((el) => el.textContent.replace(/^\n+|\s+$/g, ''))
    .filter((t) => t.includes('\n'));
  if (!blocks.length) continue;

  let md = fs.readFileSync(mdPath, 'utf8');
  let fixed = 0;

  for (const block of blocks) {
    const flat = norm(block);
    if (!flat) continue;
    // the collapsed form sits on its own line in the markdown
    const lines = md.split('\n');
    const idx = lines.findIndex((l) => !l.startsWith('```') && norm(l) === flat);
    if (idx === -1) { unmatched.push(`${slug}: ${flat.slice(0, 48)}…`); continue; }
    lines[idx] = '```text\n' + block.replace(/\s+$/, '') + '\n```';
    md = lines.join('\n');
    fixed++;
  }

  if (fixed) {
    fs.writeFileSync(mdPath, md);
    pagesTouched++; fixedTotal += fixed;
    console.log(`  ${String(fixed).padStart(3)} recovered  ${file.replace('docs/', '')}`);
  }
}

console.log(`\n${fixedTotal} ASCII diagram(s) restored across ${pagesTouched} page(s)`);
if (unmatched.length) {
  console.log(`\ncould not match ${unmatched.length}:`);
  unmatched.slice(0, 8).forEach((u) => console.log('  ' + u));
}
