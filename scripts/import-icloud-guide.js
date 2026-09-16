#!/usr/bin/env node
/**
 * Import chapters from the iCloud SRE study guide.
 *
 * Only the chapters the site does not already cover are pulled in. Linux,
 * SRE, Python and the practice lab are already represented by existing
 * sections, so they are deliberately skipped - see SKIP below.
 *
 * Each chapter becomes a section, split into one page per <h2> topic.
 * Markup is kept verbatim (probes, tables, pre blocks) with markdown
 * headings emitted so Docusaurus builds a table of contents, matching how
 * the other imported manuals are handled. Classes are namespaced to ic- so
 * the ported CSS cannot collide with .note/.code used elsewhere.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.argv[2] || path.join(process.env.HOME, 'Downloads/icloud-sre-study-guide.html');

// chapter id -> { slug, label, position, blurb }
const WANT = {
  db: {
    slug: 'databases', label: 'Databases & Analytics', position: 5,
    blurb: 'Databases from an operator\'s seat: why replication lags, how failover avoids split brain, what a tombstone costs a read, and the Kafka and analytics half of the pipeline.',
  },
  svc: {
    slug: 'service-management', label: 'Service Management', position: 3,
    blurb: 'Keeping a process alive, healthy and replaceable: systemd units and dependencies, journald, graceful lifecycle, and the deployment strategies that avoid dropping traffic.',
  },
  k8s: {
    slug: 'kubernetes', label: 'Kubernetes', position: 7,
    blurb: 'The reconciliation machine and how it fails: control plane, workload objects, pod lifecycle and probes, scheduling, networking, storage, and the debugging playbook.',
  },
};
// already covered by existing sections
const SKIP = { start: 'guide intro', lnx: 'linux section', sre: 'sre section', py: 'coding section', lab: 'sre debugging + nalsd scenarios' };

const html = fs.readFileSync(SRC, 'utf8');
const doc = new JSDOM(html).window.document;
const pageCss = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
doc.querySelectorAll('script, style, nav.toc, .toc').forEach((n) => n.remove());

const PREFIX = 'ic-';
const classNames = new Set();
doc.querySelectorAll('[class]').forEach((el) => {
  el.setAttribute('class', el.getAttribute('class').split(/\s+/).filter(Boolean)
    .map((c) => { classNames.add(c); return PREFIX + c; }).join(' '));
});

const LEVEL = { H3: '##', H4: '###', H5: '####', H6: '#####' };
const slugify = (s) => s.toLowerCase().replace(/[‐-―]/g, '-')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 55);

let totalPages = 0;

for (const [id, meta] of Object.entries(WANT)) {
  const sec = doc.querySelector(`section#${id}`);
  if (!sec) { console.log(`  ! chapter #${id} not found`); continue; }

  const out = path.join(ROOT, 'docs', meta.slug);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, '_category_.json'), JSON.stringify({
    label: meta.label, position: meta.position,
    link: { type: 'generated-index', slug: `/${meta.slug}`, description: meta.blurb },
  }, null, 2) + '\n');

  const lede = sec.querySelector('header p')?.textContent.trim().replace(/\s+/g, ' ') || meta.blurb;

  // split at h2
  const topics = [];
  let cur = null;
  for (const node of [...sec.childNodes]) {
    if (node.nodeType === 1 && node.nodeName === 'HEADER') continue;
    if (node.nodeType === 1 && node.nodeName === 'H2') {
      cur = { title: node.textContent.trim().replace(/\s+/g, ' '), id: node.id, nodes: [] };
      topics.push(cur);
    } else if (cur) cur.nodes.push(node);
  }

  topics.forEach((t, i) => {
    const parts = [];
    let buf = [];
    const flush = () => { const c = buf.join('\n').trim(); if (c) parts.push(c); buf = []; };
    for (const node of t.nodes) {
      const md = node.nodeType === 1 ? LEVEL[node.nodeName] : null;
      if (md) {
        flush();
        parts.push(`${md} ${(node.textContent || '').trim().replace(/\s+/g, ' ')}${node.id ? ` {#${node.id}}` : ''}`);
      } else if (node.nodeType === 1) buf.push(node.outerHTML);
      else if (node.nodeType === 3 && node.textContent.trim()) buf.push(node.textContent.trim());
    }
    flush();

    const slug = t.id || slugify(t.title);
    const fm = ['---', `title: ${JSON.stringify(t.title)}`, `slug: /${meta.slug}/${slug}`,
      `sidebar_position: ${i + 1}`, `sidebar_label: ${JSON.stringify(t.title)}`,
      `description: ${JSON.stringify((i === 0 ? lede : t.title).slice(0, 180))}`, '---', ''].join('\n');
    fs.writeFileSync(path.join(out, `${slug}.md`), fm + parts.join('\n\n') + '\n');
    totalPages++;
  });
  console.log(`  ${String(topics.length).padStart(2)} pages  ${meta.label}`);
}

for (const [id, why] of Object.entries(SKIP)) console.log(`  skipped #${id} — already covered by the ${why}`);

// namespaced CSS with the variable table it depends on
const cssOut = [];
for (const m of pageCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1].trim(), body = m[2].trim();
  if (!body || sel.startsWith('@')) continue;
  const names = [...sel.matchAll(/\.([A-Za-z][\w-]*)/g)].map((x) => x[1]);
  if (!names.length || !names.some((n) => classNames.has(n))) continue;
  cssOut.push(`${sel.split(',').map((o) => o.trim()
    .replace(/\.([A-Za-z][\w-]*)/g, (f, n) => classNames.has(n) ? `.${PREFIX}${n}` : f)).join(', ')} { ${body} }`);
}
const vars = {};
for (const m of pageCss.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;}]+)[;}]/g)) if (!(m[1] in vars)) vars[m[1]] = m[2].trim();
const needed = new Set([...cssOut.join('\n').matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)].map((m) => m[1]));
const varBlock = [...needed].filter((n) => vars[n]).map((n) => `  ${n}: ${vars[n]};`).join('\n');
if (varBlock) cssOut.unshift(`:root {\n${varBlock}\n}`);
fs.writeFileSync(path.join(ROOT, 'src/css/icloud-guide.css'),
  '/* Generated by scripts/import-icloud-guide.js - do not edit by hand.\n' +
  '   Namespaced to ic- so .note/.code cannot collide with other sections. */\n' + cssOut.join('\n') + '\n');

console.log(`\n${totalPages} pages, ${cssOut.length} css rules`);
