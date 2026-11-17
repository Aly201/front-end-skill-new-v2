// Tests shoot.mjs --pages, --steps and --suffix on a tiny static site.
// Skipped when Playwright is not installed. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlaywright } from '../skills/frontend-cook/scripts/_common.mjs';

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
