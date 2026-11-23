// Tests journeys.mjs on a tiny local site: two viewports, a state screenshot, rtl, the journeys_sha1.
// Skipped when Playwright is not installed. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlaywright } from '../skills/frontend-cook/scripts/_common.mjs';

const JOURNEYS = resolve(import.meta.dirname, '..', 'skills', 'frontend-cook', 'scripts', 'journeys.mjs');
const pw = loadPlaywright();
const SKIP = pw ? false : 'Playwright not installed';
const LONG = 240000;

const MENU_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test</title></head>
<body>
<header><h1>Welcome</h1><button type="button" id="menu">Menu</button></header>
<nav id="nav" hidden><a href="#pricing">Pricing</a></nav>
<script>
  document.getElementById('menu').addEventListener('click', () => {
    const nav = document.getElementById('nav');
    nav.hidden = !nav.hidden;
  });
</script>
</body>
</html>
`;

// The same page with the button handler removed: the menu never opens.
const BROKEN_MENU_PAGE = MENU_PAGE.replace(/<script>[\s\S]*<\/script>/, '');

const RTL_PAGE = `<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test</title></head>
<body><h1>Welcome</h1></body>
</html>
`;

// Same content, no dir attribute: the layout is left-to-right.
const LTR_PAGE = RTL_PAGE.replace(' dir="rtl"', '');

function serve(html) {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => done({
      url: `http://127.0.0.1:${server.address().port}/`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function project(url, journeys) {
  const dir = mkdtempSync(join(tmpdir(), 'journeys-'));
  mkdirSync(join(dir, 'cook'), { recursive: true });
  writeFileSync(join(dir, 'cook', 'GATES.json'), JSON.stringify({ build: { url } }));
  if (journeys !== null) writeFileSync(join(dir, 'cook', 'JOURNEYS.json'), JSON.stringify(journeys, null, 2));
  return dir;
}

// Async spawn: the child runs while this process keeps answering HTTP requests.
function runAsync(dir, args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [JOURNEYS, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

const readReport = (dir, round = 'r01') => JSON.parse(readFileSync(join(dir, 'cook', 'reports', `journeys-${round}.json`), 'utf8'));

const MENU_JOURNEY = {
  name: 'Open the menu',
  page: '/',
  viewports: ['desktop', 'mobile'],
  rtl: false,
  steps: [{ click: { role: 'button', name: 'Menu' } }],
  expect: [{ visible: { role: 'link', name: 'Pricing' } }],
};

test('a two-viewport journey passes on a working page and fails when the button handler is removed', { skip: SKIP, timeout: LONG }, async () => {
  const good = await serve(MENU_PAGE);
  const bad = await serve(BROKEN_MENU_PAGE);
  try {
    const okDir = project(good.url, [MENU_JOURNEY]);
    const r1 = await runAsync(okDir, ['--round', 'r01']);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    const ok = readReport(okDir);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.journeys.map((j) => j.viewport), ['desktop', 'mobile'], 'one run per viewport');
    assert.ok(ok.journeys.every((j) => j.ok && j.fails.length === 0));

    const badDir = project(bad.url, [MENU_JOURNEY]);
    const r2 = await runAsync(badDir, ['--round', 'r01']);
    assert.equal(r2.status, 1, 'a broken button fails the run');
    const fail = readReport(badDir);
    assert.equal(fail.ok, false);
    assert.ok(fail.journeys.every((j) => !j.ok), 'both viewports fail');
    assert.match(fail.journeys[0].fails.join('\n'), /Pricing/, 'the failed expectation names the missing link');
  } finally {
    await good.close();
    await bad.close();
  }
});

test('a state screenshot is written and named after the journey, viewport and state', { skip: SKIP, timeout: LONG }, async () => {
  const site = await serve(MENU_PAGE);
  try {
    const dir = project(site.url, [{
      ...MENU_JOURNEY,
      viewports: ['desktop'],
      states: [{ name: 'menu open', steps: [{ click: { role: 'button', name: 'Menu' } }], expect: [{ visible: { role: 'link', name: 'Pricing' } }] }],
    }]);
    const r = await runAsync(dir, ['--round', 'r01']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const rep = readReport(dir);
    const state = rep.journeys[0].states[0];
    assert.equal(state.ok, true);
    assert.equal(state.still, 'cook/stills/r01/journey-open-the-menu-desktop-menu-open.png');
    const file = join(dir, state.still);
    assert.ok(existsSync(file), 'the state screenshot exists');
    assert.deepEqual([...readFileSync(file).subarray(1, 4)], [0x50, 0x4e, 0x47], 'and it is a PNG');
    assert.ok(existsSync(join(dir, rep.journeys[0].still)), 'so is the journey screenshot');
  } finally {
    await site.close();
  }
});

test('an rtl journey passes when the page sets dir=rtl and fails otherwise', { skip: SKIP, timeout: LONG }, async () => {
  const arabic = { name: 'Arabic layout', page: '/', viewports: ['desktop', 'mobile'], rtl: true, steps: [], expect: [{ text: 'Welcome' }] };
  const rtl = await serve(RTL_PAGE);
  const ltr = await serve(LTR_PAGE);
  try {
    const good = project(rtl.url, [arabic]);
    const r1 = await runAsync(good, ['--round', 'r01']);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    const rep = readReport(good);
    assert.ok(rep.journeys.every((j) => j.ok));
    assert.ok(existsSync(join(good, 'cook/stills/r01/journey-arabic-layout-mobile-rtl.png')), 'the rtl screenshot is written');

    const bad = project(ltr.url, [arabic]);
    const r2 = await runAsync(bad, ['--round', 'r01']);
    assert.equal(r2.status, 1);
    const badRep = readReport(bad);
    assert.ok(badRep.journeys.every((j) => !j.ok));
    assert.match(badRep.journeys[0].fails.join('\n'), /html dir is "" after the steps, expected "rtl"/);
  } finally {
    await rtl.close();
    await ltr.close();
  }
});

test('journeys_sha1 is the sha1 of cook/JOURNEYS.json', { skip: SKIP, timeout: LONG }, async () => {
  const site = await serve(MENU_PAGE);
  try {
    const dir = project(site.url, [{ ...MENU_JOURNEY, viewports: ['desktop'] }]);
    const r = await runAsync(dir, ['--round', 'r01']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const bytes = readFileSync(join(dir, 'cook', 'JOURNEYS.json'));
    assert.equal(readReport(dir).journeys_sha1, createHash('sha1').update(bytes).digest('hex'));
  } finally {
    await site.close();
  }
});

test('without cook/JOURNEYS.json the run stops with exit 2 and names the file', async () => {
  const dir = project('http://127.0.0.1:9/', null);
  const r = await runAsync(dir, ['--round', 'r01']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no cook\/JOURNEYS\.json/);
});

test('found in review: a journey with no steps or no expectations is refused (exit 2)', async () => {
  for (const [bad, why] of [
    [{ name: 'Nothing', page: '/', viewports: ['desktop', 'mobile'], steps: [], expect: [] }, /at least one step/],
    [{ name: 'Clicks only', page: '/', viewports: ['desktop', 'mobile'], steps: [{ click: { role: 'button', name: 'Menu' } }], expect: [] }, /at least one expectation/],
    [{ name: 'Empty state', page: '/', steps: [{ click: { text: 'x' } }], expect: [{ text: 'x' }], states: [{ name: 'empty', steps: [] }] }, /state "empty" needs at least one expectation/],
  ]) {
    const dir = project('http://127.0.0.1:9/', [bad]);
    const r = await runAsync(dir, ['--round', 'r01']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, why);
  }
});
