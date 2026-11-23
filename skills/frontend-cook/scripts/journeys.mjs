#!/usr/bin/env node
// Runs the main user journeys of the build (cook/JOURNEYS.json): a sign-up, a plan choice, a contact form,
// a language switch. A journey is a main user task, not a page.
//   - each journey x viewport (desktop, mobile) runs in a fresh browser context: mocks, the page load,
//     the steps, the expectations, then a screenshot cook/stills/<round>/journey-<slug>-<viewport>.png
//   - each state (loading, empty, error, success screen) runs from a fresh load with its own steps and
//     expectations, and gets a screenshot journey-<slug>-<viewport>-<state>.png
//   - rtl: true journeys also check that the page reads dir="rtl" after the steps, that nothing overflows
//     horizontally, and save journey-<slug>-<viewport>-rtl.png
// Input cook/JOURNEYS.json: [ { name, page, viewports, rtl, steps, expect, mock, states: [ { name, steps, expect, mock } ] } ]
// Steps, expectations and mocks are as in _steps.mjs.
//
// Usage: node journeys.mjs --round r01 [--out cook/reports/journeys-r01.json]   (from the project root)
// Writes the report and exits 0 only when every journey, viewport and state passed.
// The report carries journeys_sha1 (sha1 of cook/JOURNEYS.json bytes), which gate.mjs checks.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { projectRoot, readGates, loadPlaywright, launchBrowser, pageUrl, pageSlug, isMain, STATE_DIR } from './_common.mjs';
import { runSteps, checkExpect, applyMocks, recordRequests } from './_steps.mjs';

// Same sizes as the other scripts' desktop and mobile viewports.
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
};
const DEFAULT_VIEWPORTS = ['desktop', 'mobile'];
const NAV_TIMEOUT = 45000;

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

// Returns a problem string, or null when the journeys are well formed.
function problemIn(list) {
  if (!Array.isArray(list) || !list.length) return `${STATE_DIR}/JOURNEYS.json must be a non-empty array of journeys`;
  const slugs = new Set();
  for (let i = 0; i < list.length; i++) {
    const j = list[i];
    const where = `journey ${i + 1}`;
    if (!j || typeof j !== 'object') return `${where} is not an object`;
    if (typeof j.name !== 'string' || !j.name.trim()) return `${where} needs a name`;
    if (!/[a-z0-9]/i.test(j.name)) return `${where} "${j.name}": the name needs at least one letter or digit (it names the screenshots)`;
    const slug = pageSlug(j.name);
    if (slugs.has(slug)) return `${where} "${j.name}": another journey has the same screenshot name (${slug})`;
    slugs.add(slug);
    const vps = Array.isArray(j.viewports) ? j.viewports : DEFAULT_VIEWPORTS;
    const bad = vps.find((v) => !VIEWPORTS[v]);
    if (bad) return `${where} "${j.name}": unknown viewport ${JSON.stringify(bad)} (desktop or mobile)`;
    if (!Array.isArray(j.steps ?? [])) return `${where} "${j.name}": steps must be an array`;
    if (!Array.isArray(j.expect ?? [])) return `${where} "${j.name}": expect must be an array`;
    if (!Array.isArray(j.mock ?? [])) return `${where} "${j.name}": mock must be an array`;
    const states = j.states ?? [];
    if (!Array.isArray(states)) return `${where} "${j.name}": states must be an array`;
    const stateSlugs = new Set();
    for (const s of states) {
      if (!s || typeof s.name !== 'string' || !/[a-z0-9]/i.test(s.name)) return `${where} "${j.name}": every state needs a name`;
      const ss = pageSlug(s.name);
      if (stateSlugs.has(ss)) return `${where} "${j.name}": two states are named "${s.name}"`;
      stateSlugs.add(ss);
    }
  }
  return null;
}

// One browser context at one viewport: mocks, load, steps, expectations, optional rtl checks, screenshot.
async function runFlow(browser, base, j, vn, flow) {
  const fails = [];
  const { width, height, ...device } = VIEWPORTS[vn];
  const ctx = await browser.newContext({ viewport: { width, height }, ...device });
  try {
    const page = await ctx.newPage();
    const requests = recordRequests(page);
    await applyMocks(page, flow.mocks);
    await page.goto(pageUrl(base, j.page || '/'), { waitUntil: 'load', timeout: NAV_TIMEOUT });
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* busy pages */ }
    requests.length = 0; // only what the steps cause counts, not the page's own load
    try { await runSteps(page, flow.steps); }
    catch (e) { fails.push(`steps: ${firstLine(e)}`); }
    fails.push(...await checkExpect(page, flow.expect, requests));
    if (flow.rtl) {
      const dir = await page.evaluate(() => document.documentElement.dir);
      if (dir !== 'rtl') fails.push(`html dir is "${dir}" after the steps, expected "rtl"`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) fails.push(`horizontal overflow of ${overflow}px at ${vn}`);
    }
    await page.waitForTimeout(400); // let transitions that the steps started finish
    mkdirSync(dirname(flow.still), { recursive: true });
    await page.screenshot({ path: flow.still, fullPage: true });
    if (flow.rtlStill) await page.screenshot({ path: flow.rtlStill, fullPage: true });
  } catch (e) {
    fails.push(`load: ${firstLine(e)}`);
  } finally {
    await ctx.close();
  }
  return { ok: fails.length === 0, fails };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const die = (code, msg) => { console.error(`journeys: ${msg}`); process.exit(code); };

  const round = opt('--round');
  if (!round || !/^r\d{2,}$/.test(round)) die(2, 'usage: node journeys.mjs --round rNN [--out cook/reports/journeys-rNN.json]');

  const root = projectRoot();
  const gates = readGates(root);
  if (!gates) die(2, `no ${STATE_DIR}/GATES.json here. Run gate.mjs init first.`);
  const url = gates.build?.url;
  if (!url) die(2, 'GATES.json has no build.url.');

  const journeysPath = join(root, STATE_DIR, 'JOURNEYS.json');
  if (!existsSync(journeysPath)) die(2, `no ${STATE_DIR}/JOURNEYS.json. Write the main user journeys first (see templates/JOURNEYS.example.json).`);
  const raw = readFileSync(journeysPath);
  const journeysSha1 = createHash('sha1').update(raw).digest('hex');
  let list;
  try { list = JSON.parse(raw.toString('utf8')); } catch (e) { die(2, `${STATE_DIR}/JOURNEYS.json is not valid JSON: ${firstLine(e)}`); }
  const bad = problemIn(list);
  if (bad) die(2, bad);

  const pw = loadPlaywright(root);
  if (!pw) die(1, 'Playwright not found. Run the setup check: node preflight.mjs');

  const stillDir = join(root, STATE_DIR, 'stills', round);
  const rel = (p) => p.slice(root.length + 1).split('\\').join('/');
  const results = [];
  const { browser } = await launchBrowser(pw);
  try {
    for (const j of list) {
      const slug = pageSlug(j.name);
      const vps = Array.isArray(j.viewports) ? j.viewports : DEFAULT_VIEWPORTS;
      for (const vn of vps) {
        const still = join(stillDir, `journey-${slug}-${vn}.png`);
        const main = await runFlow(browser, url, j, vn, {
          mocks: j.mock,
          steps: j.steps,
          expect: j.expect,
          rtl: j.rtl === true,
          still,
          rtlStill: j.rtl === true ? join(stillDir, `journey-${slug}-${vn}-rtl.png`) : null,
        });
        const states = [];
        for (const s of j.states ?? []) {
          const sslug = pageSlug(s.name);
          const shot = join(stillDir, `journey-${slug}-${vn}-${sslug}.png`);
          const r = await runFlow(browser, url, j, vn, {
            mocks: [...(j.mock ?? []), ...(s.mock ?? [])],
            steps: s.steps,
            expect: s.expect,
            rtl: false,
            still: shot,
            rtlStill: null,
          });
          states.push({ name: s.name, ok: r.ok, fails: r.fails, still: rel(shot) });
        }
        const ok = main.ok && states.every((s) => s.ok);
        results.push({
          name: j.name,
          viewport: vn,
          ok,
          fails: main.fails,
          states,
          still: rel(still),
          ...(j.rtl === true ? { rtl_still: rel(join(stillDir, `journey-${slug}-${vn}-rtl.png`)) } : {}),
        });
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${j.name} (${vn})${main.fails.map((f) => `\n       ${f}`).join('')}`);
        for (const s of states) {
          console.log(`       ${s.ok ? 'ok  ' : 'FAIL'} state ${s.name}${s.fails.map((f) => `\n            ${f}`).join('')}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  const ok = results.every((r) => r.ok);
  const report = { ok, round, journeys: results, journeys_sha1: journeysSha1, at: new Date().toISOString() };
  const outPath = resolve(root, opt('--out', `${STATE_DIR}/reports/journeys-${round}.json`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`journeys: ${ok ? 'ok' : 'FAIL'} (${results.filter((r) => r.ok).length}/${results.length} journey runs passed) -> ${outPath}`);
  process.exit(ok ? 0 : 1);
}

if (isMain(import.meta.url)) await main();
