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
import { createHash } from 'node:crypto';
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
    // Not a git repo: nothing is dirty. The probe check ran because probes.json exists.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).dirty_files, {});
    assert.equal(JSON.parse(readFileSync(join(dir, 'probecheck.json'), 'utf8')).length, 1);
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

// ---------- probe check: flip, mocks, --probes-only, regress mocks, dirty_files ----------

const TEMPLATE_PROBES = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'skills', 'frontend-cook', 'templates', 'probes.example.json'), 'utf8'));
// Only a link named exactly "Pricing" in the nav: the "exact" flag must reach locate().
const EXACT_LINK_PROBE = {
  name: 'exact pricing link probe',
  page: '/',
  viewport: 'mobile',
  steps: [{ click: { role: 'button', name: 'Menu' } }],
  expect: [{ visible: { role: 'link', name: 'Pricing', exact: true } }],
};
const PROBE_PROBES = [...TEMPLATE_PROBES, EXACT_LINK_PROBE];
const CONTACT_PROBE = (probes) => probes.find((p) => p.name.startsWith('contact form'));

// A "Menu" button that either opens the nav (menuWorks) or does nothing. The hero has a "See pricing" link.
function probeSite({ menuWorks, formWired = true }) {
  const formScript = formWired ? `<script>
document.getElementById('contact').addEventListener('submit', function (e) {
  e.preventDefault();
  fetch('/api/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(function () { document.getElementById('thanks').hidden = false; });
});
</script>` : '';
  const menuScript = menuWorks
    ? `<script>document.getElementById('menu').addEventListener('click', function () { document.getElementById('nav').hidden = false; });</script>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Acme</title></head>
<body>
<header>
<button type="button" id="menu">Menu</button>
<nav id="nav" hidden><a href="/">Home</a> <a href="/pricing.html">Pricing</a></nav>
</header>
<main>
<h1>Welcome to Acme</h1>
<a href="/pricing.html">See pricing</a>
<form id="contact" action="/api/contact" method="post">
<label for="name">Name</label> <input id="name" name="name" type="text">
<label for="email">Email</label> <input id="email" name="email" type="email">
<label for="message">Message</label> <textarea id="message" name="message"></textarea>
<button type="submit">Send</button>
</form>
<p id="thanks" hidden>Thanks for writing</p>
</main>
${formScript}
${menuScript}
</body></html>
`;
}

// Serves the site folder and records every POST path, so a test can tell whether a probe reached the real endpoint.
function serveSite(dir, posts) {
  return new Promise((ok) => {
    const srv = createServer((req, res) => {
      const p = new URL(req.url, 'http://local').pathname;
      if (req.method === 'POST') {
        posts.push(p);
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        });
        return;
      }
      try {
        let file = join(dir, p === '/' ? 'index.html' : p);
        if (!existsSync(file) && existsSync(`${file}.html`)) file += '.html'; // /contact serves contact.html
        const body = readFileSync(file); // read before the header: a missing file must give a 404, not a second header
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

describe('probe check, mocks, --probes-only and dirty_files', { skip: pw ? false : 'Playwright not installed' }, () => {
  let root;
  let srv;
  let base;
  const posts = [];
  const cookJson = (rel) => JSON.parse(readFileSync(join(root, 'cook', rel), 'utf8'));
  const rowOf = (rows, text) => rows.find((r) => r.name.includes(text));
  const writeSiteFile = (menuWorks) => writeFileSync(join(root, 'site', 'index.html'), probeSite({ menuWorks }));

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'redesign-probe-'));
    mkdirSync(join(root, 'site'), { recursive: true });
    writeSiteFile(false);
    srv = await serveSite(join(root, 'site'), posts);
    base = `http://127.0.0.1:${srv.address().port}`;
    mkdirSync(join(root, 'cook', 'baseline'), { recursive: true });
    writeFileSync(join(root, 'cook', 'GATES.json'), JSON.stringify({
      mode: 'redesign',
      build: { src: 'site', url: base },
      scope: { src: ['site'], exclude: [] },
      pages: ['/'],
      checks: [],
      steps: {},
    }, null, 2));
    writeFileSync(join(root, 'cook', 'baseline', 'KEEP.md'), KEEP_EMPTY);
    writeFileSync(join(root, 'cook', 'baseline', 'probes.json'), JSON.stringify(PROBE_PROBES, null, 2));
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    git('add', 'site');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'site');
  });

  after(() => {
    srv?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('a broken menu proves nothing; the form probe with a mock never posts to the endpoint', { timeout: LONG }, async () => {
    const r = await script('baseline.mjs', [], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(cookJson('baseline/meta.json').dirty_files, {});
    const rows = cookJson('baseline/probecheck.json');
    assert.equal(rows.length, 3);
    assert.equal(rowOf(rows, 'menu').proves, false);
    assert.equal(rowOf(rows, 'exact pricing').proves, false);
    assert.equal(CONTACT_PROBE(rows).proves, true);
    assert.deepEqual(posts, [], 'the mocked form probe reached the real endpoint');
  });

  test('without a mock the form probe does reach the endpoint (control for the test above)', { timeout: LONG }, async () => {
    const noMock = PROBE_PROBES.map((p) => (p.mock ? { ...p, mock: undefined } : p));
    writeFileSync(join(root, 'cook', 'baseline', 'probes.json'), JSON.stringify(noMock, null, 2));
    try {
      const r = await script('baseline.mjs', ['--probes-only'], root);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.ok(posts.includes('/api/contact'));
    } finally {
      writeFileSync(join(root, 'cook', 'baseline', 'probes.json'), JSON.stringify(PROBE_PROBES, null, 2));
      posts.length = 0;
    }
  });

  test('--probes-only rewrites probecheck.json after the menu is fixed, and does not recapture', { timeout: LONG }, async () => {
    const before = cookJson('baseline/meta.json').at;
    writeSiteFile(true);
    const r = await script('baseline.mjs', ['--probes-only'], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const rows = cookJson('baseline/probecheck.json');
    assert.equal(rowOf(rows, 'menu').proves, true);
    assert.equal(rowOf(rows, 'exact pricing').proves, true);
    assert.equal(cookJson('baseline/meta.json').at, before, 'meta.json was rewritten: a full baseline ran');
    assert.deepEqual(posts, []);
  });

  test('regress applies the mocks as well', { timeout: LONG }, async () => {
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-probe.json'], root);
    const rep = cookJson('reports/regress-probe.json');
    assert.equal(rep.probes.length, 3, `${r.stdout}\n${r.stderr}`);
    assert.ok(rep.probes.every((p) => p.ok), JSON.stringify(rep.probes));
    assert.deepEqual(posts, []);
  });

  test('dirty_files records a modified tracked file and a new file with their sha1', { timeout: LONG }, async () => {
    const indexPath = join(root, 'site', 'index.html');
    writeFileSync(indexPath, `${readFileSync(indexPath, 'utf8')}<!-- edited -->\n`);
    writeFileSync(join(root, 'site', 'new.html'), '<!doctype html><title>new</title>\n');
    const r = await script('baseline.mjs', ['--allow-dirty'], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const meta = cookJson('baseline/meta.json');
    assert.equal(meta.dirty, true);
    const sha1 = (p) => createHash('sha1').update(readFileSync(join(root, p))).digest('hex');
    assert.deepEqual(meta.dirty_files, {
      'site/index.html': sha1('site/index.html'),
      'site/new.html': sha1('site/new.html'),
    });
  });
});

test('a copy change quoted loosely (3+ words) waives the reworded heading, nothing else', async () => {
  const { diffInventory } = await import('../skills/frontend-cook/scripts/_inventory.mjs');
  const base = { headings: [{ level: 1, text: 'Unlock the power of rope - seamlessly' }], links: [], forms: [{ id: 'contact', fields: [{ name: 'email' }] }] };
  const now = { headings: [{ level: 1, text: 'Rope for boats that get used.' }], links: [], forms: [{ id: 'contact', fields: [] }] };
  const msgs = (w) => diffInventory(base, now, w).map((x) => x.message);
  assert.deepEqual(msgs(['h1 "Unlock the power of rope" becomes a real headline']), ['lost form field "email" in form "contact"']);
  assert.equal(msgs(['"Unlock the" changed']).length, 2, 'two words are too loose to waive');
  assert.equal(msgs(['the logo is bigger']).length, 2);
});

// ---------- request navigation, mocked main frames, bare request expectations, probes_sha1 ----------

const sha1File = (p) => createHash('sha1').update(readFileSync(p)).digest('hex');
// The form posts to /api/contact. Its mock body is HTML with the expected text, so a native submit (no JS handler)
// shows the text too: only the navigation check can fail it.
const NAV_PROBE = {
  name: 'contact form posts',
  page: '/',
  viewport: 'desktop',
  mock: [{ url: '/api/contact', contentType: 'text/html', body: '<h1>Thanks for writing</h1>' }],
  steps: [
    { fill: { label: 'Email', value: 'a@b.co' } },
    { click: { role: 'button', name: 'Send' } },
  ],
  expect: [{ request: '/api/contact' }, { text: 'Thanks' }],
};
// Page /contact makes no request, but its own document load URL contains "/contact": it must not prove anything (N3).
const BARE_REQUEST_PROBE = { name: 'bare contact request', page: '/contact', viewport: 'desktop', expect: [{ request: '/contact' }] };

describe('request navigation, mocked main frames, bare request expectations and probes_sha1', { skip: pw ? false : 'Playwright not installed' }, () => {
  let root;
  let srv;
  let base;
  let snapshot;
  const cookJson = (rel) => JSON.parse(readFileSync(join(root, 'cook', rel), 'utf8'));
  const writeProbes = (probes) => writeFileSync(join(root, 'cook', 'baseline', 'probes.json'), JSON.stringify(probes, null, 2));
  const writeSiteFile = (opts) => writeFileSync(join(root, 'site', 'index.html'), probeSite(opts));
  const writeGates = (extra = {}) => writeFileSync(join(root, 'cook', 'GATES.json'), JSON.stringify({
    mode: 'redesign',
    build: { src: 'site', url: base },
    scope: { src: ['site'], exclude: [] },
    pages: ['/'],
    checks: [],
    steps: {},
    ...extra,
  }, null, 2));

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'redesign-nav-'));
    mkdirSync(join(root, 'site'), { recursive: true });
    writeSiteFile({ menuWorks: true, formWired: true });
    writeFileSync(join(root, 'site', 'contact.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Contact</title></head><body><main><h1>Contact</h1></main></body></html>\n');
    srv = await serveSite(join(root, 'site'), []);
    base = `http://127.0.0.1:${srv.address().port}`;
    mkdirSync(join(root, 'cook', 'baseline'), { recursive: true });
    writeFileSync(join(root, 'cook', 'baseline', 'KEEP.md'), KEEP_EMPTY);
    writeGates();
  });

  after(() => {
    srv?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('baseline: the bare request expectation proves nothing (N3); the form probe records its request as a fetch', { timeout: LONG }, async () => {
    writeProbes([NAV_PROBE, BARE_REQUEST_PROBE]);
    const r = await script('baseline.mjs', [], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const rows = cookJson('baseline/probecheck.json');
    const bare = rows.find((x) => x.name === BARE_REQUEST_PROBE.name);
    const nav = rows.find((x) => x.name === NAV_PROBE.name);
    assert.equal(bare.proves, false, 'the page\'s own document load matched the request expectation');
    assert.equal(nav.proves, true);
    assert.deepEqual(nav.request_nav, [false, null]);
    assert.equal(nav.ends_on_mock, false);
  });

  test('the GATES snapshot holds each probe with its request_nav; regress on the unchanged site is ok and writes probes_sha1', { timeout: LONG }, async () => {
    writeProbes([NAV_PROBE]);
    const rows = cookJson('baseline/probecheck.json');
    snapshot = [NAV_PROBE].map((p) => ({
      name: p.name,
      page: p.page,
      viewport: p.viewport,
      expect: p.expect,
      request_nav: rows.find((x) => x.name === p.name).request_nav,
    }));
    writeGates({ baseline: { probes: snapshot } });
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-nav.json'], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const rep = cookJson('reports/regress-nav.json');
    assert.equal(rep.probes_sha1, sha1File(join(root, 'cook', 'baseline', 'probes.json')));
    assert.equal(rep.probes[0].ok, true);
  });

  test('a form whose submit script is removed fails with the navigation message, though the mock body has the text', { timeout: LONG }, async () => {
    writeSiteFile({ menuWorks: true, formWired: false });
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-nav2.json'], root);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    const fails = cookJson('reports/regress-nav2.json').probes[0].fails;
    assert.ok(fails.some((f) => f.includes('request to /api/contact became a full-page navigation (the JS handler did not run)')), JSON.stringify(fails));
    assert.ok(!fails.some((f) => f.includes('"text"')), `the text expectation should hold on the mock page: ${JSON.stringify(fails)}`);
    assert.ok(fails.some((f) => f.includes('ended on the mocked URL')), JSON.stringify(fails));
  });

  test('without the GATES snapshot the navigation is not compared, and a warning says so', { timeout: LONG }, async () => {
    writeSiteFile({ menuWorks: true, formWired: false });
    writeGates();
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-nav3.json'], root);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    const rep = cookJson('reports/regress-nav3.json');
    assert.ok(rep.findings.some((f) => f.severity === 'warning' && f.message.includes('no baseline probe snapshot')));
    assert.ok(!rep.probes[0].fails.some((f) => f.includes('became a full-page navigation')));
  });

  test('a restored submit script passes again', { timeout: LONG }, async () => {
    writeSiteFile({ menuWorks: true, formWired: true });
    writeGates({ baseline: { probes: snapshot } });
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-nav4.json'], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  });
});

// ---------- unstable inventory items: a random id is listed as unstable and does not fail regress ----------

describe('unstable inventory items', { skip: pw ? false : 'Playwright not installed' }, () => {
  let root;
  let srv;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'redesign-unstable-'));
    mkdirSync(join(root, 'site'), { recursive: true });
    writeFileSync(join(root, 'site', 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Acme</title></head>
<body>
<header><nav><a href="/">Home</a></nav></header>
<main><h1>Welcome</h1><div id="x"></div></main>
<script>document.getElementById('x').id = 'w-' + Math.random();</script>
</body></html>
`);
    srv = await serveSite(join(root, 'site'), []);
    const base = `http://127.0.0.1:${srv.address().port}`;
    mkdirSync(join(root, 'cook', 'baseline'), { recursive: true });
    writeFileSync(join(root, 'cook', 'baseline', 'KEEP.md'), KEEP_EMPTY);
    writeFileSync(join(root, 'cook', 'GATES.json'), JSON.stringify({
      mode: 'redesign',
      build: { src: 'site', url: base },
      scope: { src: ['site'], exclude: [] },
      pages: ['/'],
      checks: [],
      steps: {},
    }, null, 2));
  });

  after(() => {
    srv?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('the random id is listed as unstable in the baseline, and regress on the unchanged site is ok', { timeout: LONG }, async () => {
    const r = await script('baseline.mjs', [], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /inventory, load 2 of 2/, 'the page is loaded twice');
    const inv = JSON.parse(readFileSync(join(root, 'cook', 'baseline', 'inventory.json'), 'utf8')).pages['/'];
    assert.ok(inv.unstable.ids.some((id) => id.startsWith('w-')), JSON.stringify(inv.unstable));
    const reg = await script('regress.mjs', ['--out', 'cook/reports/regress-unstable.json'], root);
    assert.equal(reg.status, 0, `${reg.stdout}\n${reg.stderr}`);
    const rep = JSON.parse(readFileSync(join(root, 'cook', 'reports', 'regress-unstable.json'), 'utf8'));
    assert.equal(rep.ok, true);
    assert.equal(rep.errors, 0);
  });
});

// ---------- pages: union with the baseline, waivers, added pages, approved baseline ----------

describe('regress pages: baseline union, waivers, added pages and the approved baseline', { skip: pw ? false : 'Playwright not installed' }, () => {
  let root;
  let srv;
  let base;
  const writeGates = (pages, extra = {}) => writeFileSync(join(root, 'cook', 'GATES.json'), JSON.stringify({
    mode: 'redesign',
    build: { src: 'site', url: base },
    scope: { src: ['site'], exclude: [] },
    pages,
    checks: [],
    steps: {},
    ...extra,
  }, null, 2));
  const keep = (dropped = []) => writeFileSync(join(root, 'cook', 'baseline', 'KEEP.md'),
    `# Keep\n\n## Keep\n\n## Dropped\n${dropped.join('\n')}\n\n## Copy changes\n\n## Motion\n\n`);
  const reportOf = (name) => JSON.parse(readFileSync(join(root, 'cook', 'reports', name), 'utf8'));
  const siteFile = (rel) => join(root, 'site', rel);

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'redesign-pages-'));
    mkdirSync(join(root, 'site'), { recursive: true });
    writeFileSync(siteFile('index.html'), indexHtml({ email: true, wired: true }));
    writeFileSync(siteFile('pricing.html'), PRICING_HTML);
    srv = await serveSite(join(root, 'site'), []);
    base = `http://127.0.0.1:${srv.address().port}`;
    mkdirSync(join(root, 'cook', 'baseline'), { recursive: true });
    writeFileSync(join(root, 'cook', 'baseline', 'probes.json'), '[]');
    keep();
    writeGates(['/', '/pricing.html']);
  });

  after(() => {
    srv?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('baseline and regress on the unchanged site: both pages are checked', { timeout: LONG }, async () => {
    const b = await script('baseline.mjs', [], root);
    assert.equal(b.status, 0, `${b.stdout}\n${b.stderr}`);
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-pages.json'], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(reportOf('regress-pages.json').pages, ['/', '/pricing.html']);
  });

  test('a page added after the baseline is a warning, not an error', { timeout: LONG }, async () => {
    writeFileSync(siteFile('about.html'), PRICING_HTML.replace('<title>Pricing</title>', '<title>About</title>'));
    writeGates(['/', '/pricing.html', '/about.html']);
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-added.json'], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const rep = reportOf('regress-added.json');
    assert.ok(rep.findings.some((f) => f.severity === 'warning' && f.page === '/about.html' && f.message.includes('added after the baseline')));
    writeGates(['/', '/pricing.html']);
    rmSync(siteFile('about.html'));
  });

  test('a baseline page deleted and dropped from GATES pages is an error', { timeout: LONG }, async () => {
    rmSync(siteFile('pricing.html'));
    writeGates(['/']);
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-gone.json'], root);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    const rep = reportOf('regress-gone.json');
    assert.ok(rep.findings.some((f) => f.severity === 'error' && f.page === '/pricing.html' && f.message.includes('missing from GATES pages')));
  });

  test('a Dropped line naming the path waives the deleted page and the links and nav that pointed to it', { timeout: LONG }, async () => {
    keep(['- /pricing.html ("Pricing"): the user said "drop the pricing page"']);
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-waived.json'], root);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(reportOf('regress-waived.json').errors, 0);
  });

  test('a GATES page that returns HTTP 404 is an error unless a Dropped line names its path', { timeout: LONG }, async () => {
    writeGates(['/', '/pricing.html']);
    keep();
    const r = await script('regress.mjs', ['--out', 'cook/reports/regress-404.json'], root);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.ok(reportOf('regress-404.json').findings.some((f) => f.severity === 'error' && f.page === '/pricing.html' && f.message.includes('HTTP 404')));
    keep(['- /pricing.html ("Pricing"): the user said "drop the pricing page"']);
    const w = await script('regress.mjs', ['--out', 'cook/reports/regress-404-waived.json'], root);
    assert.equal(w.status, 0, `${w.stdout}\n${w.stderr}`);
  });

  test('an approved baseline (0b passed) refuses to recapture with exit 2; --probes-only still runs', { timeout: LONG }, async () => {
    writeGates(['/', '/pricing.html'], { steps: { '0b': { status: 'passed' } } });
    const refused = await script('baseline.mjs', [], root);
    assert.equal(refused.status, 2, `${refused.stdout}\n${refused.stderr}`);
    assert.ok(refused.stderr.includes('already approved'), refused.stderr);
    const probesOnly = await script('baseline.mjs', ['--probes-only'], root);
    assert.equal(probesOnly.status, 0, `${probesOnly.stdout}\n${probesOnly.stderr}`);
  });
});

// ---------- pair.mjs: stale pairs and missing round stills ----------

describe('pair.mjs: missing round stills and stale pairs', { skip: hasFfmpeg ? false : 'ffmpeg not installed' }, () => {
  const fold = (dir, slug, vp, color) => {
    const size = vp === 'desktop' ? '1440x900' : '390x844';
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', join(dir, `${slug}-${vp}-fold.png`)]);
    assert.equal(r.status, 0);
  };

  test('exits 1 listing the baseline pages without round stills, and removes the stale pairs and key first', { timeout: LONG }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'redesign-pair-missing-'));
    try {
      mkdirSync(join(root, 'cook'), { recursive: true });
      writeFileSync(join(root, 'cook', 'GATES.json'), JSON.stringify({ pages: ['/', '/pricing.html'] }));
      const old = join(root, 'cook', 'baseline', 'stills');
      const round = join(root, 'cook', 'stills', 'r02');
      const compare = join(root, 'cook', 'compare', 'r02');
      const judge = join(root, 'cook', 'judge', 'r02');
      for (const d of [old, round, compare, judge]) mkdirSync(d, { recursive: true });
      for (const slug of ['home', 'pricing-html']) for (const vp of ['desktop', 'mobile']) fold(old, slug, vp, 'red');
      for (const vp of ['desktop', 'mobile']) fold(round, 'home', vp, 'blue');
      writeFileSync(join(compare, 'ab-1.jpg'), 'stale');
      writeFileSync(join(compare, 'ab-7.jpg'), 'stale');
      writeFileSync(join(judge, '.abkey.json'), '[]');

      const r = await script('pair.mjs', ['--round', 'r02'], root);
      assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
      assert.ok(r.stderr.includes('/pricing.html desktop') && r.stderr.includes('/pricing.html mobile'), r.stderr);
      assert.deepEqual(readdirSync(compare), [], 'stale pairs were not removed');
      assert.equal(existsSync(join(judge, '.abkey.json')), false, 'the stale key was not removed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a page with no baseline still is skipped with a note, not an error', { timeout: LONG }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'redesign-pair-skip-'));
    try {
      mkdirSync(join(root, 'cook'), { recursive: true });
      writeFileSync(join(root, 'cook', 'GATES.json'), JSON.stringify({ pages: ['/', '/new'] }));
      const old = join(root, 'cook', 'baseline', 'stills');
      const round = join(root, 'cook', 'stills', 'r03');
      for (const d of [old, round]) mkdirSync(d, { recursive: true });
      for (const vp of ['desktop', 'mobile']) {
        fold(old, 'home', vp, 'red');
        fold(round, 'home', vp, 'blue');
        fold(round, 'new', vp, 'blue');
      }
      const r = await script('pair.mjs', ['--round', 'r03'], root);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.ok(r.stdout.includes('skipped (no baseline fold still') && r.stdout.includes('/new desktop'), r.stdout);
      const key = JSON.parse(readFileSync(join(root, 'cook', 'judge', 'r03', '.abkey.json'), 'utf8'));
      assert.equal(key.length, 2);
      assert.ok(key.every((k) => k.page === '/'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
