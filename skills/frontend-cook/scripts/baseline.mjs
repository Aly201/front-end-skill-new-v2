#!/usr/bin/env node
// Step 0b of redesign mode: records the untouched site before any design work.
// Writes cook/baseline/: meta.json, stills (with --fold), motion recordings, slop.json,
// audit-<slug>.json, inventory.json, motion.json and checks.json.
// Refuses a dirty git tree in scope.src unless --allow-dirty is given (gate needs the user's words for that).
//
// Usage: node baseline.mjs [--allow-dirty]     (run from the project root, where cook/GATES.json is)
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve, relative, extname, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectRoot, readGates, loadPlaywright, launchBrowser, pageUrl, pageSlug, walk, motionHits, FRONTEND_EXT, STATE_DIR } from './_common.mjs';
import { inventoryOfUrl } from './_inventory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const allowDirty = argv.includes('--allow-dirty');

function die(code, msg) { console.error(`baseline: ${msg}`); process.exit(code); }

const root = projectRoot();
const gates = readGates(root);
if (!gates) die(2, `no ${STATE_DIR}/GATES.json here. Run gate.mjs init first.`);
const url = gates.build?.url;
if (!url) die(2, 'GATES.json has no build.url. Set the URL of the running build first.');
const scope = gates.scope?.src?.length ? gates.scope.src : (gates.build?.src ? [gates.build.src] : []);
if (!scope.length) die(2, 'GATES.json has no scope.src (or build.src) to baseline.');
const pages = gates.pages?.length ? gates.pages : ['/'];
const checksCmds = gates.checks || [];

const pw = loadPlaywright(root);
if (!pw) die(1, 'Playwright not found. Run the setup check: node preflight.mjs');

// Git: commit and dirty state of the scope.
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
const commit = git(['rev-parse', 'HEAD'])?.trim() || null;
const status = git(['status', '--porcelain', '--', ...scope]);
const dirty = Boolean(status && status.trim());
if (dirty && !allowDirty) {
  die(1, `scope has uncommitted changes:\n${status.trim()}\nCommit or stash them, or pass --allow-dirty (gate approve needs the user's words for that).`);
}

const baseDir = join(root, STATE_DIR, 'baseline');
const stillsDir = join(baseDir, 'stills');
mkdirSync(stillsDir, { recursive: true });

function runScript(script, args) {
  return spawnSync(process.execPath, [join(HERE, script), ...args], { cwd: root, encoding: 'utf8', timeout: 600000 });
}
const tailOf = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-3).join('\n');

// 1. Stills and motion recordings per page.
for (const page of pages) {
  const slug = pageSlug(page);
  const u = pageUrl(url, page);
  // Live recording of desktop: shoot names a single-viewport run <name>, so --name carries the viewport.
  // It goes to a scratch folder first so its unsettled still cannot replace the settled one.
  const scratch = join(baseDir, `.motion-${slug}`);
  const rec = runScript('shoot.mjs', [u, '--out', scratch, '--name', `${slug}-desktop`, '--live', '--video', '8', '--viewports', 'desktop']);
  if (rec.status !== 0) die(1, `shoot (recording) failed for ${page}:\n${tailOf(rec)}`);
  for (const f of [`${slug}-desktop-motion.webm`, `${slug}-desktop-motion-strip.jpg`]) {
    if (existsSync(join(scratch, f))) renameSync(join(scratch, f), join(stillsDir, f));
  }
  rmSync(scratch, { recursive: true, force: true });

  const shot = runScript('shoot.mjs', [u, '--out', stillsDir, '--name', slug, '--fold']);
  if (shot.status !== 0) die(1, `shoot failed for ${page}:\n${tailOf(shot)}`);
}

// 2. Slop report over scope.src. Exit 1 means findings exist; that is recorded, not a failure.
const slopOut = join(baseDir, 'slop.json');
runScript('slop_scan.mjs', [...scope, '--out', `${STATE_DIR}/baseline/slop.json`]);
if (!existsSync(slopOut)) die(1, 'slop_scan.mjs wrote no baseline/slop.json');

// 3. Audit per page. Exit 1 means audit errors; recorded, not a failure.
for (const page of pages) {
  const slug = pageSlug(page);
  runScript('audit.mjs', [pageUrl(url, page), '--out', `${STATE_DIR}/baseline/audit-${slug}.json`]);
  if (!existsSync(join(baseDir, `audit-${slug}.json`))) die(1, `audit.mjs wrote no audit-${slug}.json`);
}

// 4. Inventory per page from the rendered DOM.
const { browser } = await launchBrowser(pw);
const inventory = { pages: {} };
try {
  for (const page of pages) inventory.pages[page] = await inventoryOfUrl(browser, pageUrl(url, page), 'desktop');
} finally {
  await browser.close();
}

// 5. Every animation-code hit in scope.src, with a line hash for the motion_allow list.
const files = [];
for (const s of scope) {
  const abs = resolve(root, s);
  if (!existsSync(abs)) continue;
  if (statSync(abs).isDirectory()) files.push(...walk(abs, FRONTEND_EXT));
  else if (FRONTEND_EXT.includes(extname(abs).toLowerCase())) files.push(abs);
}
const motion = [];
for (const f of files) {
  const rel = relative(root, f).split(sep).join('/');
  for (const h of motionHits(readFileSync(f, 'utf8'), extname(f))) {
    motion.push({ file: rel, line: h.line, text: h.text, hash: h.hash });
  }
}

// 6. Each GATES.checks command on the untouched tree.
const checks = checksCmds.map((cmd) => {
  const r = spawnSync(cmd, { shell: true, cwd: root, timeout: 600000, encoding: 'utf8' });
  const outText = `${r.stdout || ''}${r.stderr || ''}`;
  return { cmd, code: r.status ?? 1, tail: outText.slice(-400) };
});

writeFileSync(join(baseDir, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
writeFileSync(join(baseDir, 'motion.json'), JSON.stringify(motion, null, 2) + '\n');
writeFileSync(join(baseDir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
const at = new Date().toISOString();
writeFileSync(join(baseDir, 'meta.json'), JSON.stringify({ commit, dirty, at, url, pages }, null, 2) + '\n');

console.log(`baseline written to ${STATE_DIR}/baseline/ (commit ${commit || 'none'}${dirty ? ', dirty' : ''})`);
console.log(`  pages: ${pages.join(', ')}`);
for (const page of pages) {
  const inv = inventory.pages[page];
  console.log(`  ${page}: ${inv.headings.length} headings, ${inv.links.length} links, ${inv.forms.length} forms, ${inv.ids.length} ids`);
}
console.log(`  motion hits: ${motion.length}`);
for (const c of checks) console.log(`  check exit ${c.code}: ${c.cmd}`);
process.exit(0);
