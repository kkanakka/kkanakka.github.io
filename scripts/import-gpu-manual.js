#!/usr/bin/env node
/**
 * Import the GPU / LLM / Kubernetes manual as its own section.
 *
 * The file has no <section> wrappers - chapters are delimited by <h2>, each
 * carrying a kicker span ("Chapter 7 · Part A — Silicon") plus the title.
 * Content is split at those boundaries into one page per chapter, grouped
 * into a sub-category per Part.
 *
 * As with System Design Notes the markup is kept verbatim: 10 of the 32
 * diagrams are HTML/CSS flow charts rather than <svg>, and flattening to
 * markdown would destroy them. Headings below h2 are emitted as markdown so
 * Docusaurus can build a table of contents.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.argv[2] || path.join(process.env.HOME, 'Downloads/gpu-llm-kubernetes-manual.html');
const SECTION = 'gpu-llm-kubernetes';
const OUT = path.join(ROOT, 'docs', SECTION);

const html = fs.readFileSync(SRC, 'utf8');
const doc = new JSDOM(html).window.document;
const pageCss = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
doc.querySelectorAll('script, style, nav').forEach((n) => n.remove());

// This file styles its diagrams with names like .box, .flow and .note, and
// System Design Notes already uses .box 299 times with different meaning.
// Porting the CSS unprefixed would restyle those pages, so every class from
// this manual is namespaced on the way in, and its CSS is rewritten to match.
const PREFIX = 'gm-';
const classNames = new Set();
doc.querySelectorAll('[class]').forEach((el) => {
  const next = el.getAttribute('class').split(/\s+/).filter(Boolean).map((c) => {
    classNames.add(c);
    return PREFIX + c;
  });
  el.setAttribute('class', next.join(' '));
});

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

fs.writeFileSync(path.join(OUT, '_category_.json'), JSON.stringify({
  label: 'GPU, LLM & Kubernetes',
  position: 10,
  link: {
    type: 'generated-index',
    slug: `/${SECTION}`,
    description: 'From silicon to the chat window: how a GPU works, how a language model runs on it, how a chat product is built around that, and how all of it is operated on Kubernetes.',
  },
}, null, 2) + '\n');

const slugify = (s) => s.toLowerCase()
  .replace(/[‐-―·]/g, '-')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 55);

const LEVEL = { H3: '##', H4: '###', H5: '####', H6: '#####' };

// group chapters by the Part named in their kicker
const parts = new Map();
const chapters = [];

for (const h2 of doc.querySelectorAll('h2')) {
  const kicker = h2.querySelector(`.${PREFIX}chap`);
  const kickerText = (kicker?.textContent || '').trim();
  if (kicker) kicker.remove();
  const title = h2.textContent.trim().replace(/\s+/g, ' ');

  // "Chapter 7 · Part A — Silicon"  |  "Appendix A"
  const pm = kickerText.match(/Part\s+([A-Z0-9.]+)\s*[—–-]\s*(.+)$/);
  const partKey = pm ? `Part ${pm[1]} — ${pm[2].trim()}` : (kickerText.trim() || 'Appendix');
  const cm = kickerText.match(/Chapter\s+([\d.]+)/);
  const chapterNo = cm ? cm[1] : null;

  // everything until the next h2
  const body = [];
  let n = h2.nextSibling;
  while (n && !(n.nodeType === 1 && n.nodeName === 'H2')) { body.push(n); n = n.nextSibling; }

  chapters.push({ title, partKey, chapterNo, kickerText, nodes: body, id: h2.id });
  if (!parts.has(partKey)) parts.set(partKey, []);
  parts.get(partKey).push(chapters.length - 1);
}

let pageCount = 0, figCount = 0, svgCount = 0;
let partPos = 0;

for (const [partKey, idxs] of parts) {
  partPos++;
  const partDir = path.join(OUT, slugify(partKey));
  fs.mkdirSync(partDir, { recursive: true });
  fs.writeFileSync(path.join(partDir, '_category_.json'), JSON.stringify({
    label: partKey,
    position: partPos,
    link: { type: 'generated-index', slug: `/${SECTION}/${slugify(partKey)}` },
  }, null, 2) + '\n');

  idxs.forEach((ci, order) => {
    const ch = chapters[ci];
    const slug = ch.id || slugify(ch.title);

    // markdown headings for h3+, raw HTML for everything else
    const parts2 = [];
    let buf = [];
    const flush = () => { const c = buf.join('\n').trim(); if (c) parts2.push(c); buf = []; };
    for (const node of ch.nodes) {
      const md = node.nodeType === 1 ? LEVEL[node.nodeName] : null;
      if (md) {
        flush();
        const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
        parts2.push(`${md} ${text}${node.id ? ` {#${node.id}}` : ''}`);
      } else if (node.nodeType === 1) {
        buf.push(node.outerHTML);
        figCount += (node.outerHTML.match(/<figure/g) || []).length;
        svgCount += (node.outerHTML.match(/<svg/g) || []).length;
      } else if (node.nodeType === 3 && node.textContent.trim()) {
        buf.push(node.textContent.trim());
      }
    }
    flush();

    const fm = [
      '---',
      `title: ${JSON.stringify(ch.title)}`,
      `slug: /${SECTION}/${slug}`,
      `sidebar_position: ${order + 1}`,
      `sidebar_label: ${JSON.stringify((ch.chapterNo ? `${ch.chapterNo}. ` : '') + (ch.title.length > 38 ? ch.title.slice(0, 36) + '…' : ch.title))}`,
      `description: ${JSON.stringify(ch.kickerText || ch.title)}`,
      '---',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(partDir, `${slug}.md`), fm + parts2.join('\n\n') + '\n');
    pageCount++;
  });
  console.log(`  ${String(idxs.length).padStart(2)} chapters  ${partKey}`);
}

// rewrite the page's own CSS against the prefixed names
const cssOut = [];
for (const m of pageCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1].trim(), body = m[2].trim();
  if (!body || sel.startsWith('@')) continue;
  // only rules that mention a class this document actually uses
  const names = [...sel.matchAll(/\.([A-Za-z][\w-]*)/g)].map((x) => x[1]);
  if (!names.length || !names.some((n) => classNames.has(n))) continue;
  const scoped = sel.split(',').map((one) =>
    one.trim().replace(/\.([A-Za-z][\w-]*)/g, (full, n) => classNames.has(n) ? `.${PREFIX}${n}` : full)
  ).join(', ');
  cssOut.push(`${scoped} { ${body} }`);
}
// The rules reference the source page's own variables (--line, --ink-3 and
// friends). A stylesheet lifted out of that page has no :root defining them,
// so every one would resolve to nothing and the diagrams would render
// unstyled - the same failure that made 49 extracted diagrams invisible
// earlier in this migration. Emit the variable table alongside the rules.
const vars = {};
for (const m of pageCss.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;}]+)[;}]/g)) {
  if (!(m[1] in vars)) vars[m[1]] = m[2].trim();
}
const needed = new Set([...cssOut.join('\n').matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)].map((m) => m[1]));
const varBlock = [...needed].filter((n) => vars[n]).map((n) => `  ${n}: ${vars[n]};`).join('\n');
cssOut.unshift(`:root {\n${varBlock}\n}`);
const missing = [...needed].filter((n) => !vars[n]);
if (missing.length) console.log('  ! variables with no definition:', missing.join(', '));

const cssPath = path.join(ROOT, 'src/css/gpu-manual.css');
fs.writeFileSync(cssPath,
  '/* Generated by scripts/import-gpu-manual.js - do not edit by hand.\n' +
  '   The manual\'s own diagram CSS, with every class namespaced to gm- so it\n' +
  '   cannot collide with .box / .flow / .note used elsewhere on the site. */\n' +
  cssOut.join('\n') + '\n');
console.log(`css    : ${cssOut.length} rules -> src/css/gpu-manual.css`);

console.log(`\n${pageCount} pages across ${parts.size} parts`);
console.log(`figures: ${figCount} (source ${(html.match(/<figure/g) || []).length})`);
console.log(`svg    : ${svgCount} (source ${(html.match(/<svg/g) || []).length})`);
