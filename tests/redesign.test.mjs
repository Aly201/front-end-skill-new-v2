// Redesign-mode scripts: baseline.mjs, regress.mjs, pair.mjs and the inventory diff.
// Browser tests are skipped when Playwright is not installed; pair tests need ffmpeg.
// Run: node --test tests/redesign.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { loadPlaywright, imageSize } from '../skills/frontend-cook/scripts/_common.mjs';
import { diffInventory } from '../skills/frontend-cook/scripts/_inventory.mjs';

const SCRIPTS = resolve(import.meta.dirname, '..', 'skills', 'frontend-cook', 'scripts');
const pw = loadPlaywright();
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const LONG = 300000;

// Async, not spawnSync: the test process serves the fixture site, so it must keep its event loop running.
function script(name, args, cwd) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [join(SCRIPTS, name), ...args], { cwd });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => p.kill(), LONG);
    p.on('close', (status) => { clearTimeout(timer); ok({ status, stdout, stderr }); });
  });
}

// ---------- inventory diff (no browser) ----------

const BASE = {
  title: 'Acme',
  meta_description: '',
  headings: [{ level: 1, text: 'Welcome' }],
  links: [{ href: 'http://x/pricing.html', text: 'Pricing' }],
  nav: ['Pricing'],
  forms: [{
    id: 'contact', name: 'contact', action: 'http://x/api/contact', submit: 'Send',
    fields: [
      { name: 'name', type: 'text', label: 'Name', required: false },
      { name: 'email', type: 'email', label: 'Email', required: true },
    ],
  }],
  buttons: ['Send'],
  images: [],
  ids: ['contact', 'email'],
  console_errors: [],
};

describe('diffInventory', () => {
  test('identical inventories have no losses', () => {
    assert.deepEqual(diffInventory(BASE, structuredClone(BASE), []), []);
  });

  test('a removed form field and its id are errors', () => {
    const now = structuredClone(BASE);
    now.forms[0].fields = now.forms[0].fields.slice(0, 1);
    now.ids = ['contact'];
    const errs = diffInventory(BASE, now, []);
    assert.ok(errs.some((e) => e.kind === 'form-field' && e.severity === 'error' && e.message.includes('"email"')));
    assert.ok(errs.some((e) => e.kind === 'id' && e.message.includes('email')));
    assert.ok(!errs.some((e) => e.kind === 'form-field' && e.message.includes('"name"')));
  });

  test('a Dropped line waives the lost field', () => {
    const now = structuredClone(BASE);
    now.forms[0].fields = now.forms[0].fields.slice(0, 1);
    now.ids = ['contact'];
    const waived = ['## Dropped', '- email field (name "email"): the user said "drop the email box"'];
    assert.deepEqual(diffInventory(BASE, now, waived), []);
  });

  test('a lost link, heading, form and title change are reported', () => {
    const now = { ...structuredClone(BASE), links: [], headings: [], forms: [], title: 'Other' };
    const kinds = diffInventory(BASE, now, []).map((e) => e.kind);
    for (const k of ['form', 'heading', 'link', 'title']) assert.ok(kinds.includes(k), `missing ${k}`);
  });

  test('headings match regardless of case and whitespace', () => {
    const now = structuredClone(BASE);
    now.headings = [{ level: 2, text: '  WELCOME ' }];
    assert.deepEqual(diffInventory(BASE, now, []).filter((e) => e.kind === 'heading'), []);
  });
});

// ---------- browser tests: baseline and regress on a small static site ----------

const CHECK_PASS = 'node -e "process.exit(0)"';
const CHECK_FLAG = `node -e "process.exit(require('fs').existsSync('flag.txt')?1:0)"`;
const CHECK_ALWAYS_FAIL = 'node -e "process.exit(1)"';

function indexHtml({ email = true, wired = true }) {
  const emailField = email ? '<label for="email">Email</label> <input id="email" name="email" type="email">' : '';
  const script = wired
    ? `<script>
document.getElementById('contact').addEventListener('submit', function (e) {
  e.preventDefault();
  document.getElementById('thanks').textContent = 'Thanks';
  document.getElementById('thanks').hidden = false;
});
</script>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Acme</title>
<meta name="description" content="Acme makes things"></head>
<body>
<header><nav><a href="/">Home</a> <a href="/pricing.html">Pricing</a></nav></header>
<main>
<h1>Welcome to Acme</h1>
<form id="contact" name="contact" action="/api/contact" method="post">
<label for="name">Name</label> <input id="name" name="name" type="text">
${emailField}
<button type="submit">Send</button>
</form>
<p id="thanks" hidden></p>
</main>
${script}
</body></html>
`;
}

const PRICING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pricing</title></head>
<body>
<header><nav><a href="/">Home</a> <a href="/pricing.html">Pricing</a></nav></header>
<main><h1>Pricing</h1><p>Plans from 9 dollars.</p></main>
</body></html>
`;

function writeSite(root, opts) {
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(join(root, 'site', 'index.html'), indexHtml(opts));
  writeFileSync(join(root, 'site', 'pricing.html'), PRICING_HTML);
}

function serve(dir) {
  return new Promise((ok) => {
    const srv = createServer((req, res) => {
      const p = new URL(req.url, 'http://local').pathname;
      const file = join(dir, p === '/' ? 'index.html' : p);
      try {
        const body = readFileSync(file);
        res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    srv.listen(0, '127.0.0.1', () => ok(srv));
  });
}

const KEEP_EMPTY = '# Keep\n\n## Keep\n\n## Dropped\n\n## Copy changes\n\n## Motion\n\n| file:line | hash | functional/decorative | keep/replace/remove |\n|---|---|---|---|\n';
const KEEP_DROP_EMAIL = '# Keep\n\n## Keep\n\n## Dropped\n- email field (name "email"): the user said "drop the email box"\n\n## Copy changes\n\n## Motion\n\n';

const PROBES = [{
  name: 'contact form shows thanks',
  page: '/',
  viewport: 'desktop',
  steps: [
    { fill: { label: 'Email', value: 'a@b.co' } },
    { click: { role: 'button', name: 'Send' } },
  ],
  expect: [{ text: 'Thanks' }],
}];

describe('redesign baseline and regress', { skip: pw ? false : 'Playwright not installed' }, () => {
  let root;
  let srv;
  let base;
  const report = (name) => JSON.parse(readFileSync(join(root, 'cook', 'reports', name), 'utf8'));

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'redesign-test-'));
    writeSite(root, { email: true, wired: true });
    srv = await serve(join(root, 'site'));
    base = `http://127.0.0.1:${srv.address().port}`;
    mkdirSync(join(root, 'cook', 'baseline'), { recursive: true });
    writeFileSync(join(root, 'cook', 'GATES.json'), JSON.stringify({
      mode: 'redesign',
      build: { src: 'site', url: base },
      scope: { src: ['site'], exclude: [] },
      pages: ['/', '/pricing.html'],
      checks: [CHECK_PASS, CHECK_FLAG, CHECK_ALWAYS_FAIL],
      steps: {},
    }, null, 2));
    writeFileSync(join(root, 'cook', 'baseline', 'KEEP.md'), KEEP_EMPTY);
    writeFileSync(join(root, 'cook', 'baseline', 'probes.json'), JSON.stringify(PROBES, null, 2));
  });

  after(() => {
    srv?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('baseline.mjs writes the baseline files and the inventory', { timeout: LONG }, async () => {
    const r = await script('baseline.mjs', ['--allow-dirty'], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const dir = join(root, 'cook', 'baseline');
    for (const f of ['meta.json', 'inventory.json', 'motion.json', 'checks.json', 'slop.json', 'audit-home.json', 'audit-pricing-html.json']) {
      assert.ok(existsSync(join(dir, f)), `missing ${f}`);
    }
    for (const f of ['home-desktop.png', 'home-mobile.png', 'home-desktop-fold.png', 'home-mobile-fold.png', 'home-desktop-motion.webm']) {
      assert.ok(existsSync(join(dir, 'stills', f)), `missing stills/${f}`);
    }
    const inv = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8')).pages['/'];
    assert.ok(inv.headings.some((h) => h.level === 1 && h.text === 'Welcome to Acme'));
    assert.ok(inv.forms.some((f) => f.fields.some((x) => x.name === 'email')));
    assert.ok(inv.forms.some((f) => f.fields.some((x) => x.name === 'name')));
    const checks = JSON.parse(readFileSync(join(dir, 'checks.json'), 'utf8'));
    assert.deepEqual(checks.map((c) => c.code), [0, 0, 1]);
  });

  test('regress on the unchanged site is ok', { timeout: LONG }, async () => {
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-r01.json'], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const rep = report('regress-r01.json');
    assert.equal(rep.ok, true);
    assert.equal(rep.errors, 0);
    assert.equal(rep.probes[0].ok, true);
    // The check that already failed on the baseline is a warning, not an error.
    assert.ok(rep.findings.some((f) => f.severity === 'warning' && f.message.includes(CHECK_ALWAYS_FAIL)));
  });

  test('a removed form field is a lost form field error', { timeout: LONG }, async () => {
    writeSite(root, { email: false, wired: true });
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-r02.json'], root);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    const rep = report('regress-r02.json');
    assert.equal(rep.ok, false);
    assert.ok(rep.findings.some((f) => f.severity === 'error' && f.check === 'inventory' && /lost form field "email"/.test(f.message)));
  });

  test('a Dropped line in KEEP.md waives the lost field', { timeout: LONG }, async () => {
    writeFileSync(join(root, 'cook', 'baseline', 'KEEP.md'), KEEP_DROP_EMAIL);
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-r03.json'], root);
    // The probe still fills the removed email box, so the run still fails; the inventory must not.
    const rep = report('regress-r03.json');
    assert.equal(r.status, 1);
    assert.equal(rep.findings.filter((f) => f.check === 'inventory' && f.severity === 'error').length, 0);
    assert.ok(rep.findings.some((f) => f.check === 'probe' && f.severity === 'error'));
  });

  test('breaking the submit script fails the probe', { timeout: LONG }, async () => {
    writeSite(root, { email: true, wired: false });
    writeFileSync(join(root, 'cook', 'baseline', 'KEEP.md'), KEEP_EMPTY);
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-r04.json'], root);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    const rep = report('regress-r04.json');
    assert.equal(rep.probes[0].ok, false);
    assert.ok(rep.findings.some((f) => f.check === 'probe' && f.severity === 'error'));
  });

  test('a check that passed on the baseline and fails now is an error; one that already failed is not', { timeout: LONG }, async () => {
    writeSite(root, { email: true, wired: true });
    writeFileSync(join(root, 'flag.txt'), 'x');
    try {
      const r = await script('regress.mjs', ['--out', 'cook/reports/regress-r05.json'], root);
      assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
      const rep = report('regress-r05.json');
      const errs = rep.findings.filter((f) => f.severity === 'error' && f.check === 'checks');
      assert.equal(errs.length, 1);
      assert.ok(errs[0].message.includes(CHECK_FLAG));
      assert.ok(!rep.findings.some((f) => f.severity === 'error' && f.message.includes(CHECK_ALWAYS_FAIL)));
      assert.equal(rep.probes[0].ok, true);
    } finally {
      rmSync(join(root, 'flag.txt'), { force: true });
    }
  });
});

// ---------- pair.mjs: blind A/B pairs from fake fold stills ----------

describe('pair.mjs', { skip: hasFfmpeg ? false : 'ffmpeg not installed' }, () => {
  test('writes one pair per page and viewport with a key that names the new side', { timeout: LONG }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'redesign-pair-'));
    try {
      mkdirSync(join(root, 'cook'), { recursive: true });
      writeFileSync(join(root, 'cook', 'GATES.json'), JSON.stringify({ pages: ['/', '/pricing.html'] }));
      const old = join(root, 'cook', 'baseline', 'stills');
      const round = join(root, 'cook', 'stills', 'r01');
      mkdirSync(old, { recursive: true });
      mkdirSync(round, { recursive: true });
      for (const slug of ['home', 'pricing-html']) {
        for (const vp of ['desktop', 'mobile']) {
          const size = vp === 'desktop' ? '1440x900' : '390x844';
          const make = (file, color) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', file]);
          assert.equal(make(join(old, `${slug}-${vp}-fold.png`), 'red').status, 0);
          assert.equal(make(join(round, `${slug}-${vp}-fold.png`), 'blue').status, 0);
        }
      }
      const r = await script('pair.mjs', ['--round', 'r01'], root);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.ok(!r.stdout.includes('"new"'), 'the key must not be printed');

      const key = JSON.parse(readFileSync(join(root, 'cook', 'judge', 'r01', '.abkey.json'), 'utf8'));
      assert.equal(key.length, 4);
      for (const k of key) {
        assert.match(k.pair, /^ab-\d+$/);
        assert.ok(['left', 'right'].includes(k.new));
        const jpg = join(root, 'cook', 'compare', 'r01', `${k.pair}.jpg`);
        assert.ok(existsSync(jpg), `missing ${k.pair}.jpg`);
        assert.ok(statSync(jpg).size > 0);
      }
      const ab1 = join(root, 'cook', 'compare', 'r01', 'ab-1.jpg');
      assert.equal(imageSize(ab1)?.height, 900);
      assert.ok(readdirSync(join(root, 'cook', 'compare', 'r01')).every((f) => f.endsWith('.jpg')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
