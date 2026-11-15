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
