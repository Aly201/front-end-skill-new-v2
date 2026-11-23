// Runs the page audit on a small accessible page with an off-screen skip link.
// The skip link must not fail the tap-target check. Skipped when Playwright is not installed.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlaywright } from '../skills/frontend-cook/scripts/_common.mjs';

const AUDIT = resolve(import.meta.dirname, '..', 'skills', 'frontend-cook', 'scripts', 'audit.mjs');
const pw = loadPlaywright();

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skip link check</title>
<style>
  body { font-family: "Georgia", serif; font-size: 18px; color: #111111; background: #ffffff; margin: 0; padding: 16px; }
  .skip { position: absolute; left: -9999px; }
  .skip:focus { left: 16px; top: 16px; }
  h1 { font-size: 32px; margin: 0 0 12px; }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header><h1>Readable page</h1></header>
<main id="main">
  <p>This paragraph has enough text to be measured by the audit. It uses a set font family, an eighteen pixel size and high contrast against a white background.</p>
</main>
</body>
</html>
`;

test('a standard off-screen skip link passes the audit', { skip: pw ? false : 'Playwright is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  const file = join(dir, 'index.html');
  writeFileSync(file, PAGE);
  const r = spawnSync(process.execPath, [AUDIT, file], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `audit exited ${r.status}\n${r.stdout}${r.stderr}`);
});

// Desktop only, JSON output: keeps the new checks' tests fast and easy to read.
function audit(html, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  const file = join(dir, 'index.html');
  writeFileSync(file, html);
  const r = spawnSync(process.execPath, [AUDIT, file, '--viewports', 'desktop', '--json', ...extra], { encoding: 'utf8', timeout: 120000 });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* left null; the assertion shows the output */ }
  return { status: r.status, report, raw: `${r.stdout}${r.stderr}` };
}

const findingsOf = (report, check, severity = null) => (report?.findings || [])
  .filter((f) => f.check === check && (severity === null || f.severity === severity));

function doc({ head = '', body = '', description = true, htmlAttrs = 'lang="en"' } = {}) {
  return `<!doctype html>
<html ${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audit fixture</title>
${description ? '<meta name="description" content="Fixture page for the audit tests.">' : ''}
<style>body { font-family: Georgia, serif; font-size: 18px; color: #111111; background: #ffffff; margin: 0; padding: 16px; }</style>
${head}
</head>
<body>
<h1>Fixture</h1>
${body}
</body>
</html>
`;
}

const SKIP = { skip: pw ? false : 'Playwright is not installed' };

test('a button with outline none and no other focus style fails keyboard', SKIP, () => {
  const r = audit(doc({ head: '<style>button { outline: none; }</style>', body: '<button type="button">Save</button>' }));
  assert.equal(r.status, 1, r.raw);
  const bad = findingsOf(r.report, 'keyboard', 'error');
  assert.ok(bad.length > 0, r.raw);
  assert.match(bad[0].message, /no visible focus indicator/);
});

test('a button with a visible focus style passes keyboard', SKIP, () => {
  const r = audit(doc({
    head: '<style>button:focus-visible { outline: 3px solid #005fcc; outline-offset: 2px; }</style>',
    body: '<button type="button">Save</button>',
  }));
  assert.deepEqual(findingsOf(r.report, 'keyboard'), [], r.raw);
  assert.ok(r.report.viewports.desktop.interaction.focus_checked >= 1);
});

test('an input with no label fails labels', SKIP, () => {
  const r = audit(doc({ body: '<input id="q" type="text">' }));
  assert.equal(r.status, 1, r.raw);
  assert.equal(findingsOf(r.report, 'labels', 'error').length, 1, r.raw);
});

test('an input with a <label> passes labels', SKIP, () => {
  const r = audit(doc({ body: '<label for="q">Search</label> <input id="q" type="text">' }));
  assert.deepEqual(findingsOf(r.report, 'labels'), [], r.raw);
});

// The script reveals the text only when motion is allowed, as many reveal animations do.
const REVEAL_SCRIPT = `<script>
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.querySelector('.reveal').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, fill: 'forwards' });
}
</script>`;

test('text a JS animation reveals, with no reduced-motion rule, fails reduced-motion', SKIP, () => {
  const r = audit(doc({
    head: '<style>.reveal { opacity: 0; }</style>',
    body: `<p class="reveal">This paragraph is revealed by a script when motion is allowed.</p>${REVEAL_SCRIPT}`,
  }));
  assert.equal(r.status, 1, r.raw);
  const bad = findingsOf(r.report, 'reduced-motion', 'error');
  assert.equal(bad.length, 1, r.raw);
  assert.match(bad[0].message, /stay hidden/);
});

test('text a reduced-motion stylesheet shows passes reduced-motion', SKIP, () => {
  const r = audit(doc({
    head: '<style>.reveal { opacity: 0; } @media (prefers-reduced-motion: reduce) { .reveal { opacity: 1; } }</style>',
    body: `<p class="reveal">This paragraph is revealed by a script when motion is allowed.</p>${REVEAL_SCRIPT}`,
  }));
  assert.deepEqual(findingsOf(r.report, 'reduced-motion', 'error'), [], r.raw);
});

test('a page missing a meta description gets an seo warning', SKIP, () => {
  const r = audit(doc({ description: false, body: '<p>Some text.</p>' }));
  const warn = findingsOf(r.report, 'seo', 'warn');
  assert.equal(warn.length, 1, r.raw);
  assert.match(warn[0].message, /description/);
});

test('a page with title, description, lang and one h1 has no seo findings', SKIP, () => {
  const r = audit(doc({ body: '<p>Some text.</p>' }));
  assert.deepEqual(findingsOf(r.report, 'seo'), [], r.raw);
});

const RTL_BUTTON = '<button type="button" onclick="document.documentElement.dir = \'rtl\'; document.documentElement.lang = \'ar\';">Switch to Arabic</button>';
const RTL_STEPS = JSON.stringify([{ click: { role: 'button', name: 'Switch to Arabic' } }]);

test('--rtl passes when a --steps click sets dir=rtl', SKIP, () => {
  const r = audit(doc({ body: RTL_BUTTON }), ['--rtl', '--steps', RTL_STEPS]);
  assert.deepEqual(findingsOf(r.report, 'rtl'), [], r.raw);
  assert.equal(r.status, 0, r.raw);
});

test('--rtl fails without the --steps that switch the direction', SKIP, () => {
  const r = audit(doc({ body: RTL_BUTTON }), ['--rtl']);
  assert.equal(r.status, 1, r.raw);
  assert.equal(findingsOf(r.report, 'rtl', 'error').length, 1, r.raw);
});

test('found on a real site: text hidden by design (a dock shown on scroll) is not a reduced-motion failure', SKIP, () => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T</title><meta name="description" content="d">
<style>body{font-family:Georgia,serif;font-size:18px;color:#111;background:#fff} .dock{position:fixed;bottom:0;opacity:0} .dock.on{opacity:1}</style></head>
<body><main><h1>Plans</h1><p>Weekly car care.</p></main><div class="dock"><span>Choose a Plan</span></div>
<script>addEventListener('scroll',()=>{ if (scrollY>800) document.querySelector('.dock').classList.add('on'); });</script></body></html>`;
  const r = audit(html);
  assert.equal(findingsOf(r.report, 'reduced-motion', 'error').length, 0);
});
