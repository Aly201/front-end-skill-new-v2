#!/usr/bin/env node
// Step 0b of redesign mode: records the untouched site before any design work.
// Writes cook/baseline/: meta.json (with dirty_files), stills (with --fold), motion recordings, slop.json,
// audit-<slug>.json, inventory.json, motion.json, checks.json and, when cook/baseline/probes.json exists,
// probecheck.json (each probe run once: expectations before the steps, after them, and whether one flipped).
// Refuses a dirty git tree in scope.src unless --allow-dirty is given (gate needs the user's words for that).
// Each page's inventory is read twice; anything that differs between the two loads is listed as "unstable"
// (regress skips it). Takes about 20 s per page: run it with a long timeout or in the background.
// Refuses to run once GATES steps 0b is passed (the baseline is approved); --probes-only still works.
//
// Usage: node baseline.mjs [--allow-dirty]     (run from the project root, where cook/GATES.json is)
//        node baseline.mjs --probes-only       (only rewrites probecheck.json; use after writing probes.json)
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve, relative, extname, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectRoot, readGates, readJson, loadPlaywright, launchBrowser, pageUrl, pageSlug, walk, motionHits, isExcluded, FRONTEND_EXT, STATE_DIR } from './_common.mjs';
import { inventoryOfUrl, VIEWPORTS } from './_inventory.mjs';
import { runSteps, checkExpectEach, expectNow, applyMocks, recordRequests, requestNavEach, endsOnMock } from './_steps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const allowDirty = argv.includes('--allow-dirty');
const probesOnly = argv.includes('--probes-only');

function die(code, msg) { console.error(`baseline: ${msg}`); process.exit(code); }

const root = projectRoot();
const gates = readGates(root);
if (!gates) die(2, `no ${STATE_DIR}/GATES.json here. Run gate.mjs init first.`);
if (!probesOnly && ['passed', 'overridden'].includes(gates.steps?.['0b']?.status)) {
  die(2, 'the baseline is already approved; reopen 0b to recapture (--probes-only still rewrites probecheck.json)');
}
const url = gates.build?.url;
if (!url) die(2, 'GATES.json has no build.url. Set the URL of the running build first.');
const scope = gates.scope?.src?.length ? gates.scope.src : (gates.build?.src ? [gates.build.src] : []);
if (!scope.length) die(2, 'GATES.json has no scope.src (or build.src) to baseline.');
const pages = gates.pages?.length ? gates.pages : ['/'];
const checksCmds = gates.checks || [];
// Excluded (legacy) files are not redesigned: not recorded for motion, not part of dirty_files.
const excludes = Array.isArray(gates.scope?.exclude) ? gates.scope.exclude : [];

const pw = loadPlaywright(root);
if (!pw) die(1, 'Playwright not found. Run the setup check: node preflight.mjs');

const baseDir = join(root, STATE_DIR, 'baseline');
const probesPath = join(baseDir, 'probes.json');

// One probe in a fresh context, run once with the flip check. Never throws: a failure is recorded in the row.
async function flipCheck(browser, base, probe, name) {
  // request_nav: per expectation, whether its request was a full-page navigation (null: not a request, or none).
  // ends_on_mock: whether the main frame ended on a mocked URL it did not start on.
  const row = { name, page: probe.page || '/', viewport: probe.viewport || 'desktop', before: [], after: [], proves: false, request_nav: [], ends_on_mock: false };
  const expect = Array.isArray(probe.expect) ? probe.expect : [];
  const failed = (msg) => {
    row.error = msg;
    row.before = expect.map(() => false);
    row.after = expect.map(() => false);
    row.request_nav = expect.map(() => null);
    row.ends_on_mock = null;
    return row;
  };
  const vp = VIEWPORTS[row.viewport];
  if (!vp) return failed(`unknown viewport ${probe.viewport}`);
  const { width, height, ...rest } = vp;
  const ctx = await browser.newContext({ viewport: { width, height }, ...rest });
  try {
    const page = await ctx.newPage();
    const requests = recordRequests(page);
    await applyMocks(page, probe.mock);
    await page.goto(pageUrl(base, row.page), { waitUntil: 'load', timeout: 45000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* busy pages */ }
    const startUrl = page.url();
    requests.length = 0; // only what the steps cause counts, not the page's own load
    row.before = await expectNow(page, expect);
    try { await runSteps(page, probe.steps || []); }
    catch (e) { row.error = `steps: ${String(e.message).split('\n')[0]}`; }
    row.after = await checkExpectEach(page, expect, requests);
    row.request_nav = requestNavEach(expect, requests);
    row.ends_on_mock = endsOnMock(page.url(), startUrl, probe.mock);
  } catch (e) {
    return failed(`load: ${String(e.message).split('\n')[0]}`);
  } finally {
    await ctx.close();
  }
  row.proves = expect.some((_, i) => !row.before[i] && row.after[i]);
  return row;
}

// Writes cook/baseline/probecheck.json from cook/baseline/probes.json. Returns the rows, or null when there are no probes.
async function writeProbeCheck() {
  const probes = readJson(probesPath, null);
  if (!Array.isArray(probes)) return null;
  const rows = [];
  const { browser } = await launchBrowser(pw);
  try {
    for (let i = 0; i < probes.length; i++) {
      rows.push(await flipCheck(browser, url, probes[i], probes[i].name || `probe ${i + 1}`));
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(baseDir, 'probecheck.json'), JSON.stringify(rows, null, 2) + '\n');
  return rows;
}

function reportProbeCheck(rows) {
  const proving = rows.filter((r) => r.proves).length;
  console.log(`  probe check: ${proving} of ${rows.length} probes prove something (${STATE_DIR}/baseline/probecheck.json)`);
  for (const r of rows) {
    if (!r.proves) console.log(`  probe proves nothing: "${r.name}"${r.error ? ` (${r.error})` : ''}`);
  }
}

if (probesOnly) {
  if (!existsSync(probesPath)) die(2, `no ${STATE_DIR}/baseline/probes.json to check.`);
  const rows = await writeProbeCheck();
  if (!rows) die(2, `${STATE_DIR}/baseline/probes.json is not a JSON array.`);
  reportProbeCheck(rows);
  process.exit(0);
}

// Git: commit and dirty state of the scope.
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
const commit = git(['rev-parse', 'HEAD'])?.trim() || null;
// core.quotePath=false: non-ASCII file names come out as they are, so they match the file system.
const status = git(['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all', '--', ...scope]);
const dirty = Boolean(status && status.trim());
if (dirty && !allowDirty) {
  die(1, `scope has uncommitted changes:\n${status.trim()}\nCommit or stash them, or pass --allow-dirty (gate approve needs the user's words for that).`);
}

// sha1 of each changed or new file under scope.src, so a later check can tell "already dirty at baseline" from "edited since".
// Paths from porcelain output are relative to the repository top; they are stored relative to the project root.
function dirtyFiles(statusText) {
  const out = {};
  const top = git(['rev-parse', '--show-toplevel'])?.trim();
  if (!statusText || !top) return out;
  for (const line of statusText.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    const rel = relative(root, resolve(top, p)).split(sep).join('/');
    if (!rel || rel.startsWith('..') || isExcluded(rel, excludes)) continue;
    const abs = resolve(root, rel);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue; // deleted files have no content to hash
    out[rel] = createHash('sha1').update(readFileSync(abs)).digest('hex');
  }
  return out;
}
const dirtyMap = dirty ? dirtyFiles(status) : {};

mkdirSync(join(baseDir, 'stills'), { recursive: true });
const stillsDir = join(baseDir, 'stills');

function runScript(script, args) {
  return spawnSync(process.execPath, [join(HERE, script), ...args], { cwd: root, encoding: 'utf8', timeout: 600000 });
}
const tailOf = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-3).join('\n');

// 1. Stills and motion recordings per page.
for (const page of pages) {
  const slug = pageSlug(page);
  const u = pageUrl(url, page);
  console.log(`  ${page}: recording and stills`);
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
  console.log(`  ${page}: audit`);
  runScript('audit.mjs', [pageUrl(url, page), '--out', `${STATE_DIR}/baseline/audit-${slug}.json`]);
  if (!existsSync(join(baseDir, `audit-${slug}.json`))) die(1, `audit.mjs wrote no audit-${slug}.json`);
}

// 4. Inventory per page from the rendered DOM, each page loaded twice. Items present in only one load
// (random ids, rotating links, nav that changes per visit) go to the page's "unstable" list, which regress skips.
// Page and console errors are the union of both loads.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const symmetric = (xs, ys) => {
  const x = new Set(xs);
  const y = new Set(ys);
  return [...new Set([...xs.filter((v) => !y.has(v)), ...ys.filter((v) => !x.has(v))])];
};
const union = (xs, ys) => [...new Set([...(xs || []), ...(ys || [])])];
function mergeLoads(a, b) {
  return {
    ...a,
    page_errors: union(a.page_errors, b.page_errors),
    console_errors: union(a.console_errors, b.console_errors),
    unstable: {
      ids: symmetric(a.ids || [], b.ids || []),
      links: symmetric((a.links || []).map((l) => l.href), (b.links || []).map((l) => l.href)),
      nav: symmetric((a.nav || []).map(norm), (b.nav || []).map(norm)),
    },
  };
}
const inventory = { pages: {} };
const { browser } = await launchBrowser(pw);
try {
  for (const page of pages) {
    const u = pageUrl(url, page);
    console.log(`  ${page}: inventory, load 1 of 2`);
    const first = await inventoryOfUrl(browser, u, 'desktop');
    console.log(`  ${page}: inventory, load 2 of 2`);
    const second = await inventoryOfUrl(browser, u, 'desktop');
    inventory.pages[page] = mergeLoads(first.inventory, second.inventory);
    const unstable = Object.values(inventory.pages[page].unstable).reduce((n, xs) => n + xs.length, 0);
    const status = first.status ?? second.status;
    if (status >= 400) console.log(`  warning: ${page} returned HTTP ${status} on the baseline`);
    console.log(`  ${page}: done (${unstable} unstable item(s))`);
  }
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
  if (isExcluded(rel, excludes)) continue;
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

// 7. Each probe once, with the flip check (only when probes.json exists yet).
const probeRows = await writeProbeCheck();

writeFileSync(join(baseDir, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
writeFileSync(join(baseDir, 'motion.json'), JSON.stringify(motion, null, 2) + '\n');
writeFileSync(join(baseDir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
const at = new Date().toISOString();
writeFileSync(join(baseDir, 'meta.json'), JSON.stringify({ commit, dirty, at, url, pages, dirty_files: dirtyMap }, null, 2) + '\n');

console.log(`baseline written to ${STATE_DIR}/baseline/ (commit ${commit || 'none'}${dirty ? ', dirty' : ''})`);
console.log(`  pages: ${pages.join(', ')}`);
for (const page of pages) {
  const inv = inventory.pages[page];
  console.log(`  ${page}: ${inv.headings.length} headings, ${inv.links.length} links, ${inv.forms.length} forms, ${inv.ids.length} ids`);
}
console.log(`  motion hits: ${motion.length}`);
for (const c of checks) console.log(`  check exit ${c.code}: ${c.cmd}`);
if (probeRows) reportProbeCheck(probeRows);
else console.log(`  no ${STATE_DIR}/baseline/probes.json yet: write probes, then run node baseline.mjs --probes-only`);
process.exit(0);
