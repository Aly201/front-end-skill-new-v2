#!/usr/bin/env node
// Regression proof for redesign rounds. Compares the current build with cook/baseline/:
//   - the page inventory per GATES.pages (lost links, nav items, forms, fields, headings, ids, title)
//     unless the item is waived by a line of KEEP.md "## Dropped" or "## Copy changes"
//   - every probe in cook/baseline/probes.json (fail = error)
//   - every GATES.checks command: an error only when it exits non-zero and exited 0 on the baseline
// Writes the report to --out (default cook/reports/regress.json) and exits 0 only when ok.
//
// Usage: node regress.mjs --out cook/reports/regress-r01.json   (from the project root)
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot, readGates, readJson, loadPlaywright, launchBrowser, pageUrl, STATE_DIR } from './_common.mjs';
import { diffInventory, inventoryOfUrl, VIEWPORTS } from './_inventory.mjs';
import { runSteps, checkExpect } from './_steps.mjs';

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

function die(code, msg) { console.error(`regress: ${msg}`); process.exit(code); }

const root = projectRoot();
const gates = readGates(root);
if (!gates) die(2, `no ${STATE_DIR}/GATES.json here. Run gate.mjs init first.`);
const url = gates.build?.url;
if (!url) die(2, 'GATES.json has no build.url.');
const pages = gates.pages?.length ? gates.pages : ['/'];
const checksCmds = gates.checks || [];

const baseDir = join(root, STATE_DIR, 'baseline');
const baseInv = readJson(join(baseDir, 'inventory.json'), null);
if (!baseInv) die(2, `no ${STATE_DIR}/baseline/inventory.json. Run node baseline.mjs first.`);
const baseChecks = readJson(join(baseDir, 'checks.json'), []);
const probes = readJson(join(baseDir, 'probes.json'), []);
const waived = readWaived(join(baseDir, 'KEEP.md'));

const pw = loadPlaywright(root);
if (!pw) die(1, 'Playwright not found. Run the setup check: node preflight.mjs');

// Lines of KEEP.md under "## Dropped" and "## Copy changes", the only places a loss can be waived.
function readWaived(path) {
  if (!existsSync(path)) return [];
  const out = [];
  let section = '';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const h = /^##\s+(.*?)\s*$/.exec(line);
    if (h) { section = h[1].toLowerCase(); continue; }
    if (!line.trim()) continue;
    if (section === 'dropped' || section === 'copy changes') out.push(line);
  }
  return out;
}

// One probe in a fresh context. Returns the failure strings (empty = passed).
async function runProbe(browser, base, probe) {
  const vp = VIEWPORTS[probe.viewport || 'desktop'];
  if (!vp) return [`unknown viewport ${probe.viewport}`];
  const { width, height, ...rest } = vp;
  const ctx = await browser.newContext({ viewport: { width, height }, ...rest });
  const fails = [];
  try {
    const page = await ctx.newPage();
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(pageUrl(base, probe.page || '/'), { waitUntil: 'load', timeout: 45000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* busy pages */ }
    try { await runSteps(page, probe.steps || []); }
    catch (e) { fails.push(`steps: ${String(e.message).split('\n')[0]}`); }
    fails.push(...await checkExpect(page, probe.expect || [], requests));
  } catch (e) {
    fails.push(`load: ${String(e.message).split('\n')[0]}`);
  } finally {
    await ctx.close();
  }
  return fails;
}

const findings = [];
const probeResults = [];
const checkResults = [];

const { browser } = await launchBrowser(pw);
try {
  for (const page of pages) {
    const bp = baseInv.pages?.[page];
    if (!bp) {
      findings.push({ severity: 'error', check: 'inventory', page, message: 'no baseline inventory for this page: rerun node baseline.mjs' });
      continue;
    }
    const now = await inventoryOfUrl(browser, pageUrl(url, page), 'desktop');
    for (const f of diffInventory(bp, now, waived)) {
      findings.push({ severity: f.severity, check: 'inventory', page, message: f.message });
    }
  }
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    const name = p.name || `probe ${i + 1}`;
    const fails = await runProbe(browser, url, p);
    probeResults.push({ name, ok: fails.length === 0, fails });
    for (const f of fails) {
      findings.push({ severity: 'error', check: 'probe', page: p.page || '/', message: `probe "${name}": ${f}` });
    }
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
    findings.push({ severity: 'error', check: 'checks', page: null, message: `"${cmd}" exits ${code}; it passed on the baseline` });
  } else {
    findings.push({ severity: 'warning', check: 'checks', page: null, message: `"${cmd}" exits ${code}; it did not pass on the baseline either` });
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
