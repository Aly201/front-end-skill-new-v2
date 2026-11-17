#!/usr/bin/env node
// Regression proof for redesign rounds. Compares the current build with cook/baseline/:
//   - the page inventory for every page in the union of GATES.pages and the baseline pages (lost links,
//     nav items, forms, fields, headings, ids, title), unless the item is waived by a line of KEEP.md
//     "## Dropped" or "## Copy changes". A baseline page missing from GATES.pages, or returning HTTP >= 400,
//     is an error unless a "## Dropped" line names its path. A GATES page with no baseline is a warning.
//   - every probe in cook/baseline/probes.json (fail = error). A request expectation that became a full-page
//     navigation since the baseline (its JS handler did not run) fails the probe, as does a probe whose main
//     frame ends on a mocked URL the baseline did not reach. Both use the baseline snapshot: GATES
//     g.baseline.probes (request_nav) and cook/baseline/probecheck.json (ends_on_mock).
//   - every GATES.checks command: an error only when it exits non-zero and exited 0 on the baseline
// Desktop only: the inventory and probes run at the desktop viewport. Mobile is not regressed; say so in the round.
// The report carries probes_sha1 (sha1 of cook/baseline/probes.json), which gate.mjs checks.
// Writes the report to --out (default cook/reports/regress.json) and exits 0 only when ok.
//
// Usage: node regress.mjs --out cook/reports/regress-r01.json   (from the project root)
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { projectRoot, readGates, readJson, loadPlaywright, launchBrowser, pageUrl, STATE_DIR } from './_common.mjs';
import { diffInventory, inventoryOfUrl, isWaivedBy, VIEWPORTS } from './_inventory.mjs';
import { runSteps, checkExpect, applyMocks, recordRequests, requestNavEach, endsOnMock } from './_steps.mjs';

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

function die(code, msg) { console.error(`regress: ${msg}`); process.exit(code); }

const root = projectRoot();
const gates = readGates(root);
if (!gates) die(2, `no ${STATE_DIR}/GATES.json here. Run gate.mjs init first.`);
const url = gates.build?.url;
if (!url) die(2, 'GATES.json has no build.url.');
const gatesPages = gates.pages?.length ? gates.pages : ['/'];
const checksCmds = gates.checks || [];

const baseDir = join(root, STATE_DIR, 'baseline');
const baseInv = readJson(join(baseDir, 'inventory.json'), null);
if (!baseInv) die(2, `no ${STATE_DIR}/baseline/inventory.json. Run node baseline.mjs first.`);
const baseChecks = readJson(join(baseDir, 'checks.json'), []);
const probesPath = join(baseDir, 'probes.json');
const probes = readJson(probesPath, []);
const probesSha1 = existsSync(probesPath) ? createHash('sha1').update(readFileSync(probesPath)).digest('hex') : null;
const probeRows = readJson(join(baseDir, 'probecheck.json'), null);
// GATES g.baseline.probes (written when 0b passes); missing on older projects, then navigation is not compared.
const snapshot = Array.isArray(gates.baseline?.probes) ? gates.baseline.probes : null;
const waived = readWaived(join(baseDir, 'KEEP.md'));

// Baseline pages and GATES pages: a page in either is checked.
const pages = [...new Set([...gatesPages, ...Object.keys(baseInv.pages || {})])];

const pw = loadPlaywright(root);
if (!pw) die(1, 'Playwright not found. Run the setup check: node preflight.mjs');

// Lines of KEEP.md under "## Dropped" and "## Copy changes", the only places a loss can be waived.
// Returned separately: removals are waived only by Dropped lines (see diffInventory).
function readWaived(path) {
  const out = { dropped: [], copy: [] };
  if (!existsSync(path)) return out;
  let section = '';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const h = /^##\s+(.*?)\s*$/.exec(line);
    if (h) { section = h[1].toLowerCase(); continue; }
    if (!line.trim()) continue;
    if (section === 'dropped') out.dropped.push(line);
    else if (section === 'copy changes') out.copy.push(line);
  }
  return out;
}

// One probe in a fresh context. Returns { fails, nav, mocked, finalUrl }: the failure strings (empty = passed),
// request_nav per expectation (see requestNavEach) and whether the main frame ended on a mocked URL.
async function runProbe(browser, base, probe) {
  const out = { fails: [], nav: [], mocked: false, finalUrl: null };
  const vp = VIEWPORTS[probe.viewport || 'desktop'];
  if (!vp) { out.fails.push(`unknown viewport ${probe.viewport}`); return out; }
  const { width, height, ...rest } = vp;
  const ctx = await browser.newContext({ viewport: { width, height }, ...rest });
  try {
    const page = await ctx.newPage();
    const requests = recordRequests(page);
    await applyMocks(page, probe.mock);
    await page.goto(pageUrl(base, probe.page || '/'), { waitUntil: 'load', timeout: 45000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* busy pages */ }
    const startUrl = page.url();
    requests.length = 0; // only what the steps cause counts, not the page's own load
    try { await runSteps(page, probe.steps || []); }
    catch (e) { out.fails.push(`steps: ${String(e.message).split('\n')[0]}`); }
    const expect = Array.isArray(probe.expect) ? probe.expect : [];
    out.fails.push(...await checkExpect(page, expect, requests));
    out.nav = requestNavEach(expect, requests);
    out.finalUrl = page.url();
    out.mocked = endsOnMock(out.finalUrl, startUrl, probe.mock);
  } catch (e) {
    out.fails.push(`load: ${String(e.message).split('\n')[0]}`);
  } finally {
    await ctx.close();
  }
  return out;
}

const findings = [];
const probeResults = [];
const checkResults = [];
const add = (severity, check, page, message) => findings.push({ severity, check, page, message });

if (probes.length && !snapshot) {
  add('warning', 'probe', null, 'GATES.json has no baseline probe snapshot (g.baseline.probes): request navigation is not compared (an older project: rerun 0b to record it)');
}
if (probes.length && !probeRows) {
  add('warning', 'probe', null, `no ${STATE_DIR}/baseline/probecheck.json: the mocked-URL check is not compared`);
}

const { browser } = await launchBrowser(pw);
try {
  for (const page of pages) {
    if (!gatesPages.includes(page)) {
      if (isWaivedBy(waived.dropped, page, 'href')) add('warning', 'inventory', page, 'baseline page is not in GATES pages; waived by a KEEP.md "## Dropped" line');
      else add('error', 'inventory', page, 'baseline page is missing from GATES pages: add it back, or waive it with a KEEP.md "## Dropped" line that names its path');
      continue;
    }
    const bp = baseInv.pages?.[page];
    if (!bp) {
      add('warning', 'inventory', page, 'added after the baseline: there is no baseline inventory to compare');
      continue;
    }
    const { inventory: now, status } = await inventoryOfUrl(browser, pageUrl(url, page), 'desktop');
    if (status >= 400) {
      if (isWaivedBy(waived.dropped, page, 'href')) add('warning', 'inventory', page, `returns HTTP ${status}; waived by a KEEP.md "## Dropped" line`);
      else add('error', 'inventory', page, `returns HTTP ${status}: the baseline page is gone or broken (waive it with a KEEP.md "## Dropped" line if it was removed on purpose)`);
      continue;
    }
    for (const f of diffInventory(bp, now, waived)) add(f.severity, 'inventory', page, f.message);
  }

  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    const name = p.name || `probe ${i + 1}`;
    const r = await runProbe(browser, url, p);
    const fails = [...r.fails];
    const expect = Array.isArray(p.expect) ? p.expect : [];
    const snap = snapshot ? snapshot.find((s) => s?.name === name) : null;
    if (snapshot && !snap) {
      add('warning', 'probe', p.page || '/', `probe "${name}" has no entry in the baseline snapshot: request navigation is not compared`);
    } else if (snap) {
      const snapExpect = Array.isArray(snap.expect) ? snap.expect : [];
      expect.forEach((e, idx) => {
        if (!e?.request) return;
        const j = snapExpect.findIndex((x) => JSON.stringify(x) === JSON.stringify(e));
        const was = j >= 0 ? snap.request_nav?.[j] : undefined;
        const now = r.nav[idx];
        if (was === false && now === true) {
          fails.push(`request to ${e.request} became a full-page navigation (the JS handler did not run)`);
        } else if (was === true && now === false) {
          add('warning', 'probe', p.page || '/', `probe "${name}": request to ${e.request} is no longer a full-page navigation`);
        }
      });
    }
    if (probeRows) {
      const row = probeRows.find((x) => x?.name === name);
      if (!row) add('warning', 'probe', p.page || '/', `probe "${name}" has no row in probecheck.json: the mocked-URL check is not compared`);
      else if (r.mocked && row.ends_on_mock === false) {
        fails.push(`the main frame ended on the mocked URL ${r.finalUrl}, which the baseline did not reach (the JS handler did not run)`);
      }
    }
    probeResults.push({ name, ok: fails.length === 0, fails });
    for (const f of fails) add('error', 'probe', p.page || '/', `probe "${name}": ${f}`);
  }
} finally {
  await browser.close();
}

for (const cmd of checksCmds) {
  const r = spawnSync(cmd, { shell: true, cwd: root, timeout: 600000, encoding: 'utf8' });
  const code = r.status ?? 1;
  const baselineCode = baseChecks.find((c) => c.cmd === cmd)?.code ?? null;
  checkResults.push({ cmd, code, baseline_code: baselineCode });
  if (code === 0) continue;
  if (baselineCode === 0) {
    add('error', 'checks', null, `"${cmd}" exits ${code}; it passed on the baseline`);
  } else {
    add('warning', 'checks', null, `"${cmd}" exits ${code}; it did not pass on the baseline either`);
  }
}

const errors = findings.filter((f) => f.severity === 'error').length;
const warnings = findings.filter((f) => f.severity === 'warning').length;
const report = {
  ok: errors === 0,
  errors,
  warnings,
  url,
  pages,
  probes_sha1: probesSha1,
  findings,
  probes: probeResults,
  checks: checkResults,
  at: new Date().toISOString(),
};

const outPath = resolve(root, opt('--out', `${STATE_DIR}/reports/regress.json`));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

console.log(`regress: ${report.ok ? 'ok' : 'FAIL'} (${errors} errors, ${warnings} warnings) -> ${outPath}`);
for (const f of findings) console.log(`  ${f.severity} [${f.check}${f.page ? ` ${f.page}` : ''}] ${f.message}`);
for (const p of probeResults) console.log(`  probe ${p.ok ? 'ok  ' : 'FAIL'} ${p.name}`);
process.exit(report.ok ? 0 : 1);
