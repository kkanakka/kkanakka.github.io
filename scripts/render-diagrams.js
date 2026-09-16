#!/usr/bin/env node
/**
 * Render the Mermaid sources in diagrams-src/ to SVG under static/diagrams/.
 *
 * Why pre-render instead of using @docusaurus/theme-mermaid directly: the
 * content pages are .md parsed as CommonMark (see markdown.format in the
 * config, which keeps the migrated prose's braces and stray '<' literal).
 * The Mermaid theme turns a ```mermaid block into a JSX component, and a
 * CommonMark page cannot evaluate JSX - the diagram silently disappears.
 * Rendering to SVG here sidesteps that and matches how the other 270
 * diagrams on the site are served.
 *
 * Layout:  diagrams-src/<page-slug>/<name>.mmd
 *       -> static/diagrams/<page-slug>/<name>.svg
 *
 * Only sources newer than their SVG are re-rendered; pass --force for all.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'diagrams-src');
const OUT = path.join(ROOT, 'static/diagrams');
const THEME = path.join(ROOT, 'scripts/mermaid-theme.json');
const FORCE = process.argv.includes('--force');

if (!fs.existsSync(SRC)) { console.log('no diagrams-src/ yet'); process.exit(0); }

const jobs = [];
for (const page of fs.readdirSync(SRC)) {
  const dir = path.join(SRC, page);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mmd')) continue;
    const src = path.join(dir, f);
    const dest = path.join(OUT, page, f.replace(/\.mmd$/, '.svg'));
    if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) continue;
    jobs.push({ src, dest, label: `${page}/${f}` });
  }
}

if (!jobs.length) { console.log('all diagrams up to date'); process.exit(0); }
console.log(`rendering ${jobs.length} diagram(s)...`);

let ok = 0;
const failures = [];
for (const j of jobs) {
  fs.mkdirSync(path.dirname(j.dest), { recursive: true });
  try {
    execFileSync('npx', ['mmdc', '-i', j.src, '-o', j.dest, '-c', THEME,
      '-b', 'white', '--quiet'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    // mmdc emits width:100% + max-width; drop the cap so the diagram fills
    // the content column instead of sitting small and centered.
    let svg = fs.readFileSync(j.dest, 'utf8');
    svg = svg.replace(/style="max-width:\s*[\d.]+px;?\s*/, 'style="');
    fs.writeFileSync(j.dest, svg);
    ok++;
    console.log(`  ok  ${j.label}`);
  } catch (e) {
    failures.push(`${j.label}: ${String(e.stderr || e.message).split('\n').slice(0, 3).join(' ')}`);
    console.log(`  FAIL ${j.label}`);
  }
}
console.log(`\nrendered ${ok}/${jobs.length}`);
if (failures.length) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); process.exit(1); }
