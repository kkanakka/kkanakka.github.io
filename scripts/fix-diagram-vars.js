#!/usr/bin/env node
/**
 * Resolve CSS custom properties inside the extracted diagrams.
 *
 * Each diagram was lifted out of a page whose :root defined --accent,
 * --border and friends. A standalone .svg loaded through <img> has no access
 * to that :root, so every var(--x) resolved to nothing and the shape rendered
 * unfilled - invisible against the page.
 *
 * The original HTML still exists in git history (it was removed in the
 * Docusaurus migration commit), so the variable table is read from there and
 * substituted into each diagram literally.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIAGRAMS = path.join(ROOT, 'static/diagrams');
// the commit that removed the sources; its parent still has them
const SRC_REF = process.env.SRC_REF || 'deb8fd2~1';

function sourceCss(slug) {
  for (const candidate of [`${slug}.html`, `linux-systems-guide/${slug}.html`]) {
    try {
      const html = execSync(`git show ${SRC_REF}:"${candidate}"`,
        { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
    } catch { /* try next */ }
  }
  return '';
}

/** Every --name: value pair declared anywhere in the page's CSS. */
function varTable(css) {
  const vars = {};
  for (const m of css.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;}]+)[;}]/g)) {
    const name = m[1], value = m[2].trim();
    if (!(name in vars) && value) vars[name] = value;   // first wins (:root is declared first)
  }
  return vars;
}

/** Replace var(--x) / var(--x, fallback) with a literal, recursively. */
function resolve(value, vars, depth = 0) {
  if (depth > 8) return value;
  return value.replace(/var\(\s*(--[A-Za-z0-9-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (m, name, fallback) => {
      const v = vars[name] !== undefined ? vars[name] : (fallback !== undefined ? fallback.trim() : null);
      return v === null ? m : resolve(v, vars, depth + 1);
    });
}

let touched = 0, unresolved = new Set(), perPage = {};
for (const dir of fs.readdirSync(DIAGRAMS)) {
  const dirPath = path.join(DIAGRAMS, dir);
  if (!fs.statSync(dirPath).isDirectory()) continue;
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.svg'));
  const needs = files.filter((f) => fs.readFileSync(path.join(dirPath, f), 'utf8').includes('var(--'));
  if (!needs.length) continue;

  const vars = varTable(sourceCss(dir));
  if (!Object.keys(vars).length) { console.log(`  ! no CSS recovered for ${dir}`); continue; }

  for (const f of needs) {
    const p = path.join(dirPath, f);
    const before = fs.readFileSync(p, 'utf8');
    const after = resolve(before, vars);
    for (const m of after.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) unresolved.add(`${dir}: ${m[1]}`);
    if (after !== before) {
      fs.writeFileSync(p, after);
      touched++;
      perPage[dir] = (perPage[dir] || 0) + 1;
    }
  }
}

console.log(`\nresolved variables in ${touched} diagram(s) across ${Object.keys(perPage).length} page(s)`);
for (const [k, v] of Object.entries(perPage).sort()) console.log(`  ${String(v).padStart(3)}  ${k}`);
if (unresolved.size) {
  console.log(`\nstill unresolved (${unresolved.size}):`);
  [...unresolved].slice(0, 20).forEach((u) => console.log('  ' + u));
}
