#!/usr/bin/env node
/**
 * Convert the hand-written HTML pages into Docusaurus markdown.
 *
 * The hard part is the 266 inline <svg> diagrams. Rather than rewriting them
 * into JSX (fragile: every stroke-width, xlink:href and class= has to change,
 * and a single miss fails the build), each <svg> is extracted to a standalone
 * .svg file under static/diagrams/ and referenced as an image. The page's own
 * CSS rules that the diagram actually depends on are inlined into that file,
 * because an SVG loaded via <img> cannot reach external stylesheets.
 *
 * Output is .md (CommonMark), not .mdx — see markdown.format in the config.
 * That means braces and stray < in the prose stay literal instead of being
 * parsed as JSX, which removes an entire class of build failures.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

const ROOT = path.resolve(__dirname, '..');
const TAX = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/taxonomy.json'), 'utf8'));
const DOCS = path.join(ROOT, 'docs');
const DIAGRAMS = path.join(ROOT, 'static/diagrams');

const stats = { pages: 0, svgs: 0, links: 0, images: 0, repointed: 0, aliased: 0, anchors: 0, unlinked: [], missingImages: [], skipped: [], warnings: [] };

// slug + route for every mapped page, used to rewrite internal links
const routeFor = {};
for (const [file, meta] of Object.entries(TAX.pages)) {
  const base = path.basename(file, '.html');
  routeFor[file] = `/docs/${meta.section}/${base}`;
  routeFor[base + '.html'] = `/docs/${meta.section}/${base}`;
}

/** CSS rules whose selector mentions a class/id that appears inside this SVG. */
function relevantCss(css, svgMarkup) {
  if (!css.trim()) return '';
  const names = new Set();
  for (const m of svgMarkup.matchAll(/(?:class|id)="([^"]+)"/g)) {
    m[1].split(/\s+/).forEach((n) => n && names.add(n));
  }
  if (!names.size) return '';
  const kept = [];
  // naive but adequate rule splitter: selector { body }
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (sel.startsWith('@')) continue;
    for (const n of names) {
      if (sel.includes(`.${n}`) || sel.includes(`#${n}`)) { kept.push(`${sel}{${m[2].trim()}}`); break; }
    }
  }
  // text/shape defaults the diagram may inherit from the page
  for (const m of css.matchAll(/(?:^|[},])\s*(svg|text|path|rect|circle|line|polygon)\s*\{([^{}]*)\}/g)) {
    kept.push(`${m[1]}{${m[2].trim()}}`);
  }
  return kept.join('\n');
}

/** Rightmost/bottommost extent of an svg's children, for a missing viewBox. */
function contentBounds(svg) {
  let maxX = 0, maxY = 0;
  const num = (el, a) => parseFloat(el.getAttribute(a) || '0') || 0;
  svg.querySelectorAll('*').forEach((el) => {
    switch (el.tagName.toLowerCase()) {
      case 'rect': case 'image': case 'foreignobject':
        maxX = Math.max(maxX, num(el, 'x') + num(el, 'width'));
        maxY = Math.max(maxY, num(el, 'y') + num(el, 'height'));
        break;
      case 'circle': case 'ellipse':
        maxX = Math.max(maxX, num(el, 'cx') + (num(el, 'r') || num(el, 'rx')));
        maxY = Math.max(maxY, num(el, 'cy') + (num(el, 'r') || num(el, 'ry')));
        break;
      case 'line':
        maxX = Math.max(maxX, num(el, 'x1'), num(el, 'x2'));
        maxY = Math.max(maxY, num(el, 'y1'), num(el, 'y2'));
        break;
      case 'text': case 'tspan':
        // approximate the run of text past its anchor
        maxX = Math.max(maxX, num(el, 'x') + (el.textContent || '').length * 7);
        maxY = Math.max(maxY, num(el, 'y'));
        break;
      case 'polygon': case 'polyline': case 'path': {
        const pts = (el.getAttribute('points') || el.getAttribute('d') || '')
          .match(/-?\d+(?:\.\d+)?/g) || [];
        for (let i = 0; i < pts.length - 1; i += 2) {
          maxX = Math.max(maxX, parseFloat(pts[i]));
          maxY = Math.max(maxY, parseFloat(pts[i + 1]));
        }
        break;
      }
    }
  });
  return { w: Math.ceil(maxX + 20) || 1000, h: Math.ceil(maxY + 20) || 600 };
}

function extractSvgs(doc, css, slug) {
  const svgs = [...doc.querySelectorAll('svg')];
  if (!svgs.length) return;
  const outDir = path.join(DIAGRAMS, slug);
  fs.mkdirSync(outDir, { recursive: true });

  svgs.forEach((svg, i) => {
    // an <svg> nested inside another is already captured by its parent
    if (svg.closest('svg') !== svg) return;

    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (svg.querySelector('[*|href]') || svg.innerHTML.includes('xlink:')) {
      svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    }
    // A diagram with no viewBox renders as 0x0 inside <img>. Careful: many of
    // these use width="100%", and parseFloat("100%") is 100 - which would
    // clip the drawing to a 100-unit-wide canvas. Measure the content instead.
    if (!svg.getAttribute('viewBox')) {
      const w = svg.getAttribute('width'), h = svg.getAttribute('height');
      const numeric = (v) => v && !String(v).includes('%') ? parseFloat(v) : null;
      const nw = numeric(w), nh = numeric(h);
      if (nw && nh) {
        svg.setAttribute('viewBox', `0 0 ${nw} ${nh}`);
      } else {
        const b = contentBounds(svg);
        svg.setAttribute('viewBox', `0 0 ${b.w} ${nh || b.h}`);
        if (!nw) svg.setAttribute('width', '100%');
      }
    }

    const markup = svg.outerHTML;
    const scoped = relevantCss(css, markup);
    let body = markup;
    if (scoped) {
      body = markup.replace(/^(<svg[^>]*>)/, `$1<style>${scoped}</style>`);
    }

    const name = `${i + 1}.svg`;
    fs.writeFileSync(path.join(outDir, name), `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`);
    stats.svgs++;

    // caption: nearest preceding heading, or the svg's own <title>
    const titleEl = svg.querySelector('title');
    const alt = (titleEl?.textContent || `${slug} diagram ${i + 1}`).trim().replace(/\s+/g, ' ');

    const img = doc.createElement('img');
    img.setAttribute('src', `/diagrams/${slug}/${name}`);
    img.setAttribute('alt', alt);
    img.setAttribute('class', 'doc-diagram');
    svg.replaceWith(img);
  });
}

/** Best-effort language tag so Prism highlights the block. */
function guessLang(text) {
  const t = text.slice(0, 600);
  if (/^\s*(def |class |import |from \w+ import|async def)/m.test(t)) return 'python';
  if (/^\s*(func |package |import \(|go func)/m.test(t)) return 'go';
  if (/^\s*(SELECT|INSERT|UPDATE|CREATE TABLE|WITH )\b/im.test(t)) return 'sql';
  if (/^\s*(apiVersion:|kind:|metadata:|spec:)/m.test(t)) return 'yaml';
  if (/^\s*[{[]["\s]/.test(t) && /[}\]]\s*$/.test(text.trim())) return 'json';
  if (/^\s*(\$|#|sudo |cat |grep |awk |kubectl |systemctl |ls |ps |top|dmesg|echo )/m.test(t)) return 'bash';
  if (/\b(function|const |let |=>|console\.log)\b/.test(t)) return 'javascript';
  if (/^\s*(#include|int main|void |struct \w+ \{)/m.test(t)) return 'c';
  return '';
}

function buildTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  td.use(gfm);

  // keep diagram images as raw HTML so the class survives for styling
  td.addRule('diagram', {
    filter: (node) => node.nodeName === 'IMG' && node.getAttribute('class') === 'doc-diagram',
    replacement: (_c, node) =>
      `\n\n<img src="${node.getAttribute('src')}" alt="${(node.getAttribute('alt') || '').replace(/"/g, '&quot;')}" class="doc-diagram" />\n\n`,
  });

  // These pages use bare <pre> with no <code> child. Turndown's fenced-code
  // rule only matches `pre > code`, so without this every one of the 452
  // code blocks on the site is silently dropped.
  td.addRule('barePre', {
    filter: (node) => node.nodeName === 'PRE' && !node.querySelector('code'),
    replacement: (_content, node) => {
      const text = (node.textContent || '').replace(/\n+$/, '').replace(/^\n+/, '');
      const lang = guessLang(text);
      return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    },
  });

  // drop chrome that Docusaurus provides itself
  td.addRule('strip', {
    filter: (node) =>
      ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.nodeName) ||
      (node.nodeName === 'A' && /^\s*(←|&larr;|back to)/i.test(node.textContent || '')),
    replacement: () => '',
  });

  return td;
}

function convert(file, meta) {
  const slug = path.basename(file, '.html');
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove());

  extractSvgs(doc, css, slug);

  // the page's own <h1> becomes the frontmatter title; drop it from the body
  const h1 = doc.querySelector('h1');
  const pageTitle = meta.title || (h1?.textContent || slug).trim();
  if (h1) h1.remove();
  doc.querySelectorAll('.footer, footer, .back, nav').forEach((n) => n.remove());

  // These pages navigate themselves: 516 in-page "#id" links across the site.
  // Turndown drops element ids, so every one of them would land nowhere.
  // Headings get Docusaurus's explicit-id syntax; other link targets get a
  // real anchor planted just before them. Placeholders survive turndown as
  // plain text and are swapped for markup afterwards.
  const referenced = new Set();
  doc.querySelectorAll('a[href^="#"]').forEach((a) => {
    const id = a.getAttribute('href').slice(1);
    if (id) referenced.add(id);
  });
  doc.querySelectorAll('[id]').forEach((el) => {
    const id = el.getAttribute('id');
    if (!referenced.has(id)) return;
    if (/^H[1-6]$/.test(el.nodeName)) {
      el.appendChild(doc.createTextNode(` @@HID:${id}@@`));
    } else {
      const marker = doc.createElement('p');
      marker.textContent = `@@ANCHOR:${id}@@`;
      el.parentNode.insertBefore(marker, el);
    }
    stats.anchors++;
  });

  const td = buildTurndown();
  let md = td.turndown(doc.body.innerHTML);

  // turndown escapes the placeholders' underscores; undo that, then emit
  md = md.replace(/@@HID:([A-Za-z0-9\\_-]+)@@/g, (m, id) => `{#${id.replace(/\\/g, '')}}`);
  md = md.replace(/@@ANCHOR:([A-Za-z0-9\\_-]+)@@/g, (m, id) => `<a id="${id.replace(/\\/g, '')}"></a>`);

  // rewrite internal links to Docusaurus routes
  md = md.replace(/\]\(\/?([a-z0-9-]+\.html)(#[^)]*)?\)/gi, (m, f, hash) => {
    if (routeFor[f]) { stats.links++; return `](${routeFor[f]}${hash || ''})`; }
    return m;
  });
  md = md.replace(/href="\/?([a-z0-9-]+\.html)(#[^"]*)?"/gi, (m, f, hash) => {
    if (routeFor[f]) { stats.links++; return `href="${routeFor[f]}${hash || ''}"`; }
    return m;
  });
  // Dead links inherited from the original site: repoint the ones we have a
  // sensible target for, and unlink the rest so a missing page can't fail the
  // build. Every unlinked target is reported at the end.
  const ALIAS = TAX.aliases || {};
  const resolveDead = (target) => {
    const clean = target.replace(/^\.{1,2}\//, '').replace(/^\//, '');
    return ALIAS[clean] || ALIAS[path.basename(clean)] || null;
  };
  md = md.replace(/\[([^\]]*)\]\((\.{0,2}\/?[A-Za-z0-9._/-]+\.html)(#[^)]*)?\)/g, (m, text, target, hash) => {
    const to = resolveDead(target);
    if (to) { stats.aliased++; return `[${text}](${to}${hash || ''})`; }
    stats.unlinked.push(`${file} -> ${target}`);
    return text;
  });
  md = md.replace(/<a href="(\.{0,2}\/?[A-Za-z0-9._/-]+\.html)(#[^"]*)?"[^>]*>(.*?)<\/a>/gis, (m, target, hash, text) => {
    const to = resolveDead(target);
    if (to) { stats.aliased++; return `<a href="${to}${hash || ''}">${text}</a>`; }
    stats.unlinked.push(`${file} -> ${target}`);
    return text;
  });

  // Extension-less directory links (e.g. /linux-systems-guide/) that the
  // .html-matching passes above don't catch.
  for (const [from, to] of Object.entries(ALIAS)) {
    if (from.endsWith('.html')) continue;
    const re = new RegExp(`\\]\\(/${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?\\)`, 'g');
    md = md.replace(re, () => { stats.aliased++; return `](${to})`; });
  }

  // images live in static/ now
  md = md.replace(/\((?:\.\/)?(images|linux-guide-images)\//g, (m, d) => { stats.images++; return `(/${d}/`; });
  md = md.replace(/src="(?:\.\/)?(images|linux-guide-images)\//g, (m, d) => { stats.images++; return `src="/${d}/`; });

  // Some pages point at images/<f> when the file actually lives in
  // linux-guide-images/<f> (already broken on the original site). Resolve
  // each reference against both directories and repoint it at the real file.
  md = md.replace(/(\]\(|src=")\/(images|linux-guide-images)\/([^)"'\s]+)/g, (m, pre, dir, file) => {
    const here = path.join(ROOT, 'static', dir, file);
    if (fs.existsSync(here)) return m;
    const other = dir === 'images' ? 'linux-guide-images' : 'images';
    if (fs.existsSync(path.join(ROOT, 'static', other, file))) {
      stats.repointed++;
      return `${pre}/${other}/${file}`;
    }
    stats.missingImages.push(`${dir}/${file}`);
    return m;
  });

  md = md.replace(/\n{4,}/g, '\n\n\n').trim();

  const fm = [
    '---',
    `title: ${JSON.stringify(pageTitle)}`,
    // Pin the route: without this Docusaurus collapses a doc whose name
    // repeats its folder (coding/coding) onto /docs/coding, colliding with
    // the section's own generated index.
    `slug: /${meta.section}/${slug}`,
    `sidebar_position: ${meta.position}`,
    `sidebar_label: ${JSON.stringify(pageTitle)}`,
    `description: ${JSON.stringify((doc.querySelector('meta[name="description"]')?.content || pageTitle).slice(0, 180))}`,
    '---',
    '',
  ].join('\n');

  const outDir = path.join(DOCS, meta.section);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${slug}.md`), fm + md + '\n');

  stats.pages++;
  if (md.length < 400) stats.warnings.push(`${file}: only ${md.length} chars of markdown`);
  return md.length;
}

// ---- run ----
// Two modes:
//   (default)  full migration - rebuilds every section from the original HTML
//   --ai-only  refresh just the AI System Design section from ai-system-design/
//
// The full run wipes docs/. After the one-time migration the markdown in
// docs/ is the source of truth, so a full run is refused unless the original
// HTML is still present (or --force is passed).
const AI_ONLY = process.argv.includes('--ai-only');
const FORCE = process.argv.includes('--force');

if (!AI_ONLY) {
  const sourcesPresent = Object.keys(TAX.pages)
    .filter((f) => fs.existsSync(path.join(ROOT, f))).length;
  if (sourcesPresent === 0 && !FORCE) {
    console.error(
      'Refusing to run: none of the original HTML sources are present, and a\n' +
      'full run deletes docs/. The migration is already done - docs/*.md is now\n' +
      'the source of truth. Use --ai-only to refresh the AI section, or --force\n' +
      'if you have restored the HTML sources and really mean to re-migrate.');
    process.exit(1);
  }
  fs.rmSync(DOCS, { recursive: true, force: true });
  fs.rmSync(DIAGRAMS, { recursive: true, force: true });
  fs.mkdirSync(DOCS, { recursive: true });
}

for (const s of AI_ONLY ? [] : TAX.sections) {
  const dir = path.join(DOCS, s.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_category_.json'), JSON.stringify({
    label: s.label,
    position: s.position,
    // Without an explicit slug these land on /docs/category/<label>, which is
    // not what the navbar and homepage cards link to.
    link: { type: 'generated-index', slug: `/${s.id}`, description: s.description },
  }, null, 2) + '\n');
}

const entries = Object.entries(TAX.pages).sort((a, b) =>
  a[1].section.localeCompare(b[1].section) || a[1].position - b[1].position);

for (const [file, meta] of (AI_ONLY ? [] : entries)) {
  if (!fs.existsSync(path.join(ROOT, file))) { stats.skipped.push(file); continue; }
  const n = convert(file, meta);
  console.log(`  ${String(n).padStart(7)} chars  ${meta.section}/${file}`);
}

// ---- the drop-a-file section -------------------------------------------
// Anything in ai-system-design/ becomes a page under the AI System Design
// section, ordered by an optional <meta name="order"> then by title.
// Files starting with "_" (templates, drafts) are skipped.
fs.mkdirSync(path.join(DOCS, 'ai-system-design'), { recursive: true });
const AI_DIR = path.join(ROOT, 'ai-system-design');
const aiPages = [];
if (fs.existsSync(AI_DIR)) {
  for (const name of fs.readdirSync(AI_DIR).sort()) {
    if (!name.endsWith('.html') || name.startsWith('_') || name === 'index.html') continue;
    const src = fs.readFileSync(path.join(AI_DIR, name), 'utf8');
    const meta = (n) => (src.match(new RegExp(`<meta\\s+name=["']${n}["']\\s+content=["'](.*?)["']`, 'i')) || [])[1] || '';
    const rawTitle = (src.match(/<title[^>]*>(.*?)<\/title>/is) || [])[1] || '';
    const title = meta('card-title') || rawTitle.split(/ [—–|-] /)[0].trim() ||
      name.replace(/\.html$/, '').replace(/[-_]/g, ' ');
    aiPages.push({ file: `ai-system-design/${name}`, title, order: parseInt(meta('order'), 10) });
  }
  aiPages.sort((a, b) =>
    (isNaN(a.order) ? 1e4 : a.order) - (isNaN(b.order) ? 1e4 : b.order) ||
    a.title.localeCompare(b.title));
}

// section overview always sits first
fs.writeFileSync(path.join(DOCS, 'ai-system-design', 'overview.md'), `---
title: "AI System Design"
sidebar_position: 1
sidebar_label: "Overview"
description: "Designing systems that train, serve, and scale machine learning."
---

Designing systems that train, serve, and scale machine learning — inference
architecture, vector search, retrieval pipelines, GPU scheduling, and the
reliability patterns that hold them together.

## How it works

<img src="/diagrams/overview/sequence.svg" alt="How it works — AI System Design" class="doc-diagram doc-diagram-seq" />

${aiPages.length
  ? `## Guides\n\n${aiPages.map((p) => `- [${p.title}](/docs/ai-system-design/${path.basename(p.file, '.html')})`).join('\n')}`
  : '## No guides yet\n\nDrop an `.html` file into `ai-system-design/` at the repo root, commit, and push — it becomes a page in this section automatically.'}

## Adding a guide

\`\`\`bash
cp ai-system-design/_template.html ai-system-design/llm-serving.html
# write it, then:
git add ai-system-design/llm-serving.html
git commit -m "Add LLM serving guide"
git push
\`\`\`

See \`ai-system-design/README.md\` for the metadata tags that control title,
description, tags and ordering.
`);

aiPages.forEach((p, i) => {
  routeFor[path.basename(p.file)] = `/docs/ai-system-design/${path.basename(p.file, '.html')}`;
  const n = convert(p.file, { section: 'ai-system-design', position: i + 2, title: p.title });
  console.log(`  ${String(n).padStart(7)} chars  ai-system-design/${path.basename(p.file)}`);
});

console.log(`\npages: ${stats.pages}   diagrams: ${stats.svgs}   links rewritten: ${stats.links}   image paths: ${stats.images}   repointed: ${stats.repointed}   aliased: ${stats.aliased}   anchors: ${stats.anchors}`);
if (stats.unlinked.length) {
  console.log(`\ndead links unlinked (${stats.unlinked.length}):`);
  [...new Set(stats.unlinked)].forEach((u) => console.log('  ' + u));
}
if (stats.missingImages.length) {
  const uniq = [...new Set(stats.missingImages)];
  console.log(`\nimages referenced but not on disk (${uniq.length}):`);
  uniq.forEach((m) => console.log('  ' + m));
}
if (stats.skipped.length) console.log('skipped (missing):', stats.skipped.join(', '));
if (stats.warnings.length) { console.log('\nWARNINGS:'); stats.warnings.forEach((w) => console.log('  ' + w)); }
