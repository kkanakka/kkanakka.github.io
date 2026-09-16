#!/usr/bin/env node
/**
 * Write a redirect stub into static/ for every pre-Docusaurus URL.
 *
 * The client-redirects plugin derives the output filename from `from`, and
 * with trailingSlash:false a `from` of "/coding.html" lands at
 * "coding.html.html". These pages were served at exact .html paths, so the
 * stub is written directly to static/<old>.html instead - Docusaurus copies
 * static/ verbatim, so the old URL keeps working byte-for-byte.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TAX = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/taxonomy.json'), 'utf8'));
const OUT = path.join(ROOT, 'static');

const map = new Map();
for (const [file, meta] of Object.entries(TAX.pages)) {
  const base = path.basename(file, '.html');
  const to = `/docs/${meta.section}/${base}`;
  map.set(`${base}.html`, to);
  if (file.includes('/')) map.set(file, to);
}
// hub pages the Docusaurus sections replaced
map.set('ai-index.html', '/docs/ai-system-design');
map.set('linux-systems-guide/index.html', '/docs/linux');

const stub = (to, title) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Moved — ${title}</title>
<link rel="canonical" href="https://kkanakka.github.io${to}">
<meta http-equiv="refresh" content="0; url=${to}">
<meta name="robots" content="noindex">
<script>window.location.replace(${JSON.stringify(to)} + window.location.hash);</script>
<style>body{font-family:system-ui,-apple-system,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1rem;line-height:1.6;color:#37352f}a{color:#2383e2}</style>
</head>
<body>
<p>This page has moved.</p>
<p><a href="${to}">Continue to its new home &rarr;</a></p>
</body>
</html>
`;

let n = 0;
for (const [from, to] of map) {
  const dest = path.join(OUT, from);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, stub(to, path.basename(from, '.html')));
  n++;
}
console.log(`wrote ${n} redirect stubs into static/`);
