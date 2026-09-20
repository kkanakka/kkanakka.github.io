#!/usr/bin/env node
/**
 * Import the hand-written SRE prep HTML into docs/coding/arcoding/.
 *
 * The page is a flat sequence of <h2> sections with cards, admonitions and
 * code blocks. Each <h2> becomes one page, keeping the HTML verbatim — the
 * docs are .md parsed as CommonMark (see markdown.format), so raw HTML passes
 * straight through and none of the braces or stray '<' in the code samples
 * need escaping.
 *
 * The page chrome (navbar, sidebar, mobile nav) is dropped; Docusaurus
 * supplies its own. The classes the content actually uses are styled in
 * src/css/arcoding.css rather than by inlining the original 8 KB stylesheet.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.argv[2];
const OUT = path.join(ROOT, 'docs/coding/arcoding');

if (!SRC || !fs.existsSync(SRC)) {
  console.error('usage: node scripts/import-arcoding.js <source.html>');
  process.exit(1);
}

let html = fs.readFileSync(SRC, 'utf8');

// strip page chrome and head — Docusaurus provides its own
html = html
  .replace(/<head[\s\S]*?<\/head>/i, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<nav class="navbar"[\s\S]*?<\/nav>/i, '')
  .replace(/<aside class="sidebar"[\s\S]*?<\/aside>/i, '')
  .replace(/<details[\s\S]*?class="mobilenav"[\s\S]*?<\/details>/i, '')
  .replace(/<details>[\s\S]*?<\/details>/i, '');   // the mobile nav accordion

const body = html.slice(html.indexOf('<h1'));
const parts = body.split(/(?=<h2\b)/);

const intro = parts.shift();                       // <h1> + lede
const title = (intro.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, 'Overview'])[1]
  .replace(/<[^>]+>/g, '').trim();

const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/**
 * Two things break CommonMark here:
 *  - a blank line inside an HTML block ends it, so markdown resumes and code
 *    like OPS[op](im) is parsed as a link. Fenced blocks avoid that entirely
 *    and pick up Prism highlighting as a bonus.
 *  - blank lines inside cards/admonitions do the same, so they are collapsed.
 */
function toMarkdown(html) {
  const fences = [];
  html = html.replace(
    /<pre[^>]*>\s*<code(?:[^>]*class="language-([\w-]+)")?[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_, lang, code) => {
      const body = decode(code).replace(/\s+$/, '');
      fences.push('```' + (lang || '') + '\n' + body + '\n```');
      return `\n\n@@FENCE${fences.length - 1}@@\n\n`;
    }
  );
  html = html.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    fences.push('```\n' + decode(code).replace(/\s+$/, '') + '\n```');
    return `\n\n@@FENCE${fences.length - 1}@@\n\n`;
  });
  // collapse blank lines in the surviving HTML so blocks stay intact
  html = html.split('\n').filter((l) => l.trim() !== '').join('\n');
  return html.replace(/@@FENCE(\d+)@@/g, (_, i) => '\n' + fences[+i] + '\n');
}

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
const slugify = (s) =>
  s.toLowerCase().replace(/&[a-z]+;/g, ' ').replace(/[^a-z0-9]+/g, '-')
   .replace(/^-|-$/g, '').slice(0, 60);

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.md')) fs.unlinkSync(path.join(OUT, f));

fs.writeFileSync(
  path.join(OUT, '_category_.json'),
  JSON.stringify({
    label: 'ARCODING',
    position: 4,
    link: {
      type: 'generated-index',
      slug: '/coding/arcoding',
      description:
        'Level-by-level Python solutions to the reported Anthropic coding question families, with a Python-basics session first, plus inference system design, SRE incident scenarios and the values round.',
    },
  }, null, 2) + '\n'
);

const pages = [];
const idToSlug = new Map();
const written = [];
parts.forEach((chunk, i) => {
  const h = chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
  const oldId = (chunk.match(/<h2[^>]*\sid="([^"]+)"/) || [, null])[1];
  if (!h) return;
  const heading = strip(h[1]);
  // "S1 · In-memory key-value store ... Medium→Hard" -> trim the trailing badge text
  const clean = heading.replace(/\s*(Medium|Hard|Easy)(\s*(→|->)\s*(Medium|Hard))?(\s*\(as leveled\))?\s*$/i, '').trim();
  const slug = slugify(clean) || `section-${i + 1}`;
  const rest = chunk.slice(h.index + h[0].length);

  const fm = [
    '---',
    `title: "${clean.replace(/"/g, "'")}"`,
    `slug: /coding/arcoding/${slug}`,
    `sidebar_position: ${i + 2}`,
    `sidebar_label: "${clean.length > 44 ? clean.slice(0, 43) + '…' : clean}"`,
    `description: "${clean.replace(/"/g, "'")}"`,
    '---',
    '',
    `<div class="arcoding">`,
    '',
    `## ${clean}`,
    '',
    toMarkdown(rest).trim(),
    '',
    '</div>',
    '',
  ].join('\n');

  written.push([slug, fm]);
  pages.push(slug);
  if (oldId) idToSlug.set(oldId, slug);
});

// Section anchors in the original were intra-page (#s1, #py-heapq). After the
// split, ones that name another section must become cross-page links; the rest
// (the python sub-lessons) stay as in-page anchors on their own page.
const fixLinks = (text) =>
  text.replace(/href="#([a-z0-9-]+)"/g, (m, id) =>
    idToSlug.has(id) ? `href="/docs/coding/arcoding/${idToSlug.get(id)}"` : m);

for (const [slug, fm] of written) {
  fs.writeFileSync(path.join(OUT, `${slug}.md`), fixLinks(fm));
}

// overview page carrying the original h1 lede and a contents list
const links = pages.map((s) => `  <li><a href="/docs/coding/arcoding/${s}">${s.replace(/-/g, ' ')}</a></li>`).join('\n');
fs.writeFileSync(
  path.join(OUT, 'overview.md'),
  fixLinks(`---
title: "${title}"
slug: /coding/arcoding/overview
sidebar_position: 1
sidebar_label: "Overview"
description: "${title}"
---

<div class="arcoding">

${toMarkdown(intro.replace(/<h1[\s\S]*?<\/h1>/, '')).trim()}

<h3>Contents</h3>
<ul>
${links}
</ul>

</div>
`)
);

console.log(`wrote ${pages.length + 1} pages into docs/coding/arcoding/`);
