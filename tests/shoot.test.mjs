// Tests shoot.mjs --pages, --steps and --suffix on a tiny static site.
// Skipped when Playwright is not installed. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlaywright, launchBrowser } from '../skills/frontend-cook/scripts/_common.mjs';

const SHOOT = resolve(import.meta.dirname, '..', 'skills', 'frontend-cook', 'scripts', 'shoot.mjs');
const pw = loadPlaywright();

const INDEX = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Home</title>
<style>
  body { font-family: Georgia, serif; margin: 0; padding: 16px; background: #ffffff; color: #111111; }
  h1 { font-size: 32px; margin: 0 0 12px; }
  nav { background: #eeeeee; padding: 12px; }
  nav[hidden] { display: none; }
</style>
</head>
<body>
<header>
  <h1>Home page</h1>
  <button aria-label="Menu" type="button" id="menu">Menu</button>
</header>
<nav id="site-nav" hidden><a href="about.html">About</a></nav>
<main><p>Welcome.</p></main>
<script>
  document.getElementById('menu').addEventListener('click', () => {
    const nav = document.getElementById('site-nav');
    nav.hidden = !nav.hidden;
  });
</script>
</body>
</html>
`;

const ABOUT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>About</title>
</head>
<body style="font-family: Georgia, serif; padding: 16px;">
<h1>About page</h1>
<p>Who we are.</p>
</body>
</html>
`;

function site() {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-site-'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'about.html'), ABOUT);
  return dir;
}

function shoot(args) {
  return spawnSync(process.execPath, [SHOOT, ...args], { encoding: 'utf8', timeout: 180000 });
}

// Async variant: the child runs while this process keeps answering HTTP requests.
function shootAsync(args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SHOOT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

// A folder site: index.html, pricing/index.html (a real page, not blank) and about.html.
function folderSite() {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-folder-'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  mkdirSync(join(dir, 'pricing'));
  writeFileSync(join(dir, 'pricing', 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pricing</title></head>
<body style="font-family: Georgia, serif; padding: 16px; background: #ffffff;">
<h1 style="font-size: 48px; color: #b00020;">Pricing</h1>
<p>Plans from 9 dollars a month.</p>
</body></html>
`);
  writeFileSync(join(dir, 'about.html'), ABOUT);
  return dir;
}

const skip = pw ? false : 'Playwright not installed';

test('--pages writes one file per page and viewport', { skip, timeout: 240000 }, () => {
  const dir = site();
  const outDir = mkdtempSync(join(tmpdir(), 'shoot-out-'));
  const r = shoot([dir, '--out', outDir, '--pages', '/,/about.html', '--viewports', 'desktop,mobile', '--wait', '100']);
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(outDir).sort();
  assert.deepEqual(files, ['about-html-desktop.png', 'about-html-mobile.png', 'home-desktop.png', 'home-mobile.png']);
});

test('--steps with --suffix names the state shot after the viewport', { skip, timeout: 180000 }, () => {
  const dir = site();
  const outDir = mkdtempSync(join(tmpdir(), 'shoot-out-'));
  const steps = JSON.stringify([{ click: { role: 'button', name: 'Menu' } }]);
  const r = shoot([dir, '--out', outDir, '--pages', '/', '--steps', steps, '--suffix', 'menu', '--viewports', 'mobile', '--wait', '100']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(outDir, 'home-mobile-menu.png')), `files: ${readdirSync(outDir)}`);
});

test('--steps without --suffix exits 2', { skip }, () => {
  const dir = site();
  const outDir = mkdtempSync(join(tmpdir(), 'shoot-out-'));
  const r = shoot([dir, '--out', outDir, '--steps', '[{"wait":10}]', '--viewports', 'mobile']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--suffix/);
});

test('--pages on a folder site writes three stills that are not a blank page', { skip, timeout: 240000 }, async () => {
  const dir = folderSite();
  const outDir = mkdtempSync(join(tmpdir(), 'shoot-out-'));
  const r = shoot([dir, '--out', outDir, '--pages', '/,/pricing,/about', '--viewports', 'desktop', '--wait', '100']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(outDir).sort(), ['about-desktop.png', 'home-desktop.png', 'pricing-desktop.png']);
  // A plain white page at the same viewport: each shot must be a different PNG (its size differs).
  const { browser } = await launchBrowser(pw);
  let blank;
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.setContent('<!doctype html><html><body style="margin:0;background:#ffffff"></body></html>');
    blank = await page.screenshot({ fullPage: true });
  } finally { await browser.close(); }
  for (const f of ['home-desktop.png', 'pricing-desktop.png', 'about-desktop.png']) {
    const size = statSync(join(outDir, f)).size;
    assert.notEqual(size, blank.length, `${f} is the same size as a blank white page (${size} bytes)`);
  }
});

test('--pages fails with exit 1 when a page answers 404', { skip, timeout: 180000 }, async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'shoot-out-'));
  const server = createServer((req, res) => {
    if (req.url === '/nope' || req.url.startsWith('/nope?')) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<h1>Not found</h1>');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(INDEX);
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  try {
    const r = await shootAsync([`http://127.0.0.1:${port}/`, '--out', outDir, '--pages', '/,/nope', '--viewports', 'desktop', '--wait', '100']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`shoot: page http://127\\.0\\.0\\.1:${port}/nope returned 404`));
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('--pages fails with exit 1 when a file: page does not exist', { skip, timeout: 60000 }, () => {
  const dir = folderSite();
  const outDir = mkdtempSync(join(tmpdir(), 'shoot-out-'));
  const r = shoot([dir, '--out', outDir, '--pages', '/,/missing', '--viewports', 'desktop']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /shoot: page \/missing not found under file:/);
  assert.deepEqual(readdirSync(outDir), []);
});

test('--pages rejects two pages that write the same file', { skip, timeout: 60000 }, () => {
  const dir = folderSite();
  const outDir = mkdtempSync(join(tmpdir(), 'shoot-out-'));
  const r = shoot([dir, '--out', outDir, '--pages', '/pricing,/pricing/', '--viewports', 'desktop']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /\/pricing and \/pricing\//);
  assert.deepEqual(readdirSync(outDir), []);
});
