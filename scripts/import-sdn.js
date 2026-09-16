#!/usr/bin/env node
/**
 * Import "System Design Notes" as its own section, one page per problem.
 *
 * Unlike the original migration, this keeps the source markup verbatim. The
 * content pages are .md parsed as CommonMark, and CommonMark passes raw HTML
 * blocks straight through - verified with a probe - so the compact layout
 * (requirement boards, note callouts, tag lines) and all 77 inline diagrams
 * survive exactly as authored. The page's CSS is ported into custom.css.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.argv[2] || path.join(process.env.HOME, 'Downloads/system-design-notes (1).html');
const SECTION = 'system-design-notes';
const OUT = path.join(ROOT, 'docs', SECTION);

const html = fs.readFileSync(SRC, 'utf8');
const doc = new JSDOM(html).window.document;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

fs.writeFileSync(path.join(OUT, '_category_.json'), JSON.stringify({
  label: 'System Design Notes',
  position: 4,
  link: {
    type: 'generated-index',
    slug: `/${SECTION}`,
    description: 'Interview-shaped system design notes: a reference checklist, then one page per problem — requirements, entities and API, the design, and the deep dives the interviewer is waiting for.',
  },
}, null, 2) + '\n');

const slugify = (s) => s.toLowerCase()
  .replace(/[‐-―]/g, '-')       // unicode dashes
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 60);

const used = new Set();
const sections = [...doc.querySelectorAll('section.problem')]
  .filter((s) => !s.parentElement.closest('section.problem'));   // top level only

let svgTotal = 0, pages = 0;
sections.forEach((sec, i) => {
  const header = sec.querySelector(':scope > header');
  const h2 = header?.querySelector('h2') || sec.querySelector('h2');
  const title = (h2?.textContent || `Section ${i + 1}`).trim().replace(/\s+/g, ' ');
  const tag = header?.querySelector('.tag')?.textContent.trim().replace(/\s+/g, ' ') || '';

  let slug = sec.id || slugify(title);
  while (used.has(slug)) slug = `${slug}-${i}`;
  used.add(slug);

  // the h2 becomes the page title; the tag becomes a subtitle under it
  if (h2) h2.remove();
  const svgs = sec.querySelectorAll('svg').length;
  svgTotal += svgs;

  // Headings have to be real markdown or Docusaurus builds no table of
  // contents - raw <h2> in a CommonMark page is passed through as opaque
  // HTML and never reaches the TOC. So the section is emitted as a sequence
  // of markdown headings interleaved with raw HTML for everything else,
  // which keeps the layout while restoring on-page navigation.
  // h3 -> ##, h4 -> ###, so the page's own title stays the only h1.
  const LEVEL = { H3: '##', H4: '###', H5: '####', H6: '#####' };
  const parts = [];
  let buffer = [];
  const flush = () => {
    const chunk = buffer.join('\n').trim();
    if (chunk) parts.push(chunk);
    buffer = [];
  };

  for (const node of [...sec.childNodes]) {
    const md = node.nodeType === 1 ? LEVEL[node.nodeName] : null;
    if (md) {
      flush();
      const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
      const id = node.getAttribute('id');
      parts.push(`${md} ${text}${id ? ` {#${id}}` : ''}`);
    } else if (node.nodeType === 1) {
      buffer.push(node.outerHTML);
    } else if (node.nodeType === 3 && node.textContent.trim()) {
      buffer.push(node.textContent.trim());
    }
  }
  flush();

  const body = parts.join('\n\n');
  const fm = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `slug: /${SECTION}/${slug}`,
    `sidebar_position: ${i + 1}`,
    `sidebar_label: ${JSON.stringify(title.length > 42 ? title.slice(0, 40) + '…' : title)}`,
    `description: ${JSON.stringify((tag || title).slice(0, 180))}`,
    '---',
    '',
  ].join('\n');

  // wrapper class scopes the ported CSS to these pages
  // the wrapper cannot enclose markdown headings (CommonMark stops parsing
  // markdown inside a raw HTML block), so the class goes on the body via
  // a per-page marker that the theme picks up from frontmatter instead
  const page = `${fm}${body}\n`;
  fs.writeFileSync(path.join(OUT, `${slug}.md`), page);
  pages++;
  console.log(`  ${String(svgs).padStart(3)} svg  ${slug}${tag ? '  · ' + tag.slice(0, 44) : ''}`);
});

console.log(`\n${pages} pages, ${svgTotal} inline diagrams preserved`);
console.log(`source had ${(html.match(/<svg/g) || []).length} <svg> tags in total`);
