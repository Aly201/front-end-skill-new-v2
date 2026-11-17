import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scan, isBeige, isPurple, isPurpleGrad, colorsIn } from '../skills/frontend-cook/scripts/slop_scan.mjs';

const fx = (n) => resolve(import.meta.dirname, 'fixtures', n);
const CLI = resolve(import.meta.dirname, '../skills/frontend-cook/scripts/slop_scan.mjs');

// Writes one file into a fresh temp folder and scans it. Returns the findings.
function one(name, text, bans = null) {
  const dir = mkdtempSync(join(tmpdir(), 'slop-'));
  const p = join(dir, name);
  writeFileSync(p, text);
  let bansPath = null;
  if (bans) { bansPath = join(dir, 'bans.json'); writeFileSync(bansPath, JSON.stringify(bans)); }
  return scan([p], bansPath).findings;
}
// Writes several files into one fresh temp folder and scans the folder.
function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), 'slop-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return scan([dir], null).findings;
}
const ids = (findings, id) => findings.filter((f) => f.id === id);

test('the sloppy fixture trips every planted ban', () => {
  const r = scan([fx('slop')], null);
  assert.equal(r.ok, false);
  const found = new Set(r.findings.map((f) => f.id));
  for (const id of ['beige', 'purple-gradient', 'em-dash', 'slop-copy', 'gradient-text', 'eyebrow-label', 'glow-orb', 'lorem-ipsum', 'placeholder-names', 'counter-01', 'reduced-motion', 'emoji-icon', 'default-typeface']) {
    assert.ok(found.has(id), `missing ${id}`);
  }
});

test('the clean fixture passes with no findings', () => {
  const r = scan([fx('clean')], null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('a ban switches off only with words the user really typed', () => {
  const proj = mkdtempSync(join(tmpdir(), 'bans-'));
  mkdirSync(join(proj, 'cook'), { recursive: true });
  writeFileSync(join(proj, 'cook', 'GATES.json'), '{}');
  const bans = join(proj, 'cook', 'bans.json');
  writeFileSync(bans, JSON.stringify({ allowed: [{ id: 'em-dash', quote: 'ok' }] }));
  assert.ok(scan([fx('slop')], bans).findings.some((f) => f.id === 'bans-file'), 'short quote is rejected');
  writeFileSync(bans, JSON.stringify({ allowed: [{ id: 'em-dash', quote: 'em dashes are part of our brand voice' }], extra: [{ id: 'no-ghost', pattern: '\\.ghost' }] }));
  assert.ok(scan([fx('slop')], bans).findings.some((f) => f.id === 'bans-file'), 'a quote the user never typed is rejected');
  writeFileSync(join(proj, 'cook', '.ledger.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'UserPrompt', prompt: 'Keep them: "Em dashes are part of our brand voice."' }) + '\n');
  const r = scan([fx('slop')], bans);
  assert.ok(!r.findings.some((f) => f.id === 'em-dash'), 'switched off with real user words');
  assert.ok(r.findings.some((f) => f.id === 'no-ghost'), 'user ban applies');
});

test('color classification', () => {
  assert.ok(isBeige(colorsIn('#f5efe3')[0].hsl));
  assert.ok(isBeige(colorsIn('rgb(245, 240, 225)')[0].hsl));
  assert.ok(!isBeige(colorsIn('#ffffff')[0].hsl));
  assert.ok(!isBeige(colorsIn('#f4f7f5')[0].hsl));
  assert.ok(isPurple(colorsIn('#7c3aed')[0].hsl));
  assert.ok(!isPurple(colorsIn('#1f6f4a')[0].hsl));
  assert.ok(!isPurple(colorsIn('#2563eb')[0].hsl), 'blue is not purple');
});

test('beige: the warm off-whites are flagged, the neutrals are not', () => {
  for (const hex of ['#F5F5DC', '#FAF7F2', '#FFF8E7', '#FFFDD0']) {
    assert.equal(ids(one('a.css', `body{background:${hex}}`), 'beige').length, 1, hex);
  }
  assert.equal(ids(one('a.css', 'body{background:beige}'), 'beige').length, 1, 'named beige');
  for (const hex of ['#ffffff', '#f4f7f5', '#fafafa', '#f8fafc', '#e5e7eb', '#f5f5f4']) {
    assert.equal(ids(one('a.css', `body{background:${hex}}`), 'beige').length, 0, hex);
    assert.equal(isBeige(colorsIn(hex)[0].hsl), false, `${hex} isBeige`);
  }
});

test('purple gradient: indigo and violet stops are flagged, blues are not', () => {
  assert.equal(ids(one('a.css', '.h{background:linear-gradient(135deg,#6366f1,#4f46e5)}'), 'purple-gradient').length, 1);
  for (const hex of ['#6366f1', '#4f46e5', '#7c3aed', '#d946ef']) {
    assert.ok(isPurpleGrad(colorsIn(hex)[0].hsl), `${hex} isPurpleGrad`);
    assert.equal(ids(one('a.css', `.h{background:linear-gradient(#fff,${hex})}`), 'purple-gradient').length, 1, hex);
  }
  for (const hex of ['#2563eb', '#3b82f6', '#1d4ed8']) {
    assert.ok(!isPurpleGrad(colorsIn(hex)[0].hsl), `${hex} is not purple`);
    assert.equal(ids(one('a.css', `.h{background:linear-gradient(#fff,${hex})}`), 'purple-gradient').length, 0, hex);
  }
  assert.ok(isPurple(colorsIn('#7c3aed')[0].hsl), 'isPurple is unchanged');
});

test('oklch: beige and purple gradient stops are read', () => {
  assert.equal(ids(one('a.css', '.x{background:oklch(0.96 0.03 85)}'), 'beige').length, 1);
  assert.equal(ids(one('a.css', '.x{background:oklch(96% 0.03 85)}'), 'beige').length, 1, 'percent lightness');
  assert.equal(ids(one('a.css', '.x{background:oklch(0.97 0 0)}'), 'beige').length, 0, 'white is not beige');
  assert.equal(ids(one('a.css', '.h{background:linear-gradient(oklch(0.6 0.25 290),oklch(0.5 0.2 300))}'), 'purple-gradient').length, 1);
  assert.equal(ids(one('a.css', '.h{background:linear-gradient(oklch(0.6 0.02 290),oklch(0.5 0.02 300))}'), 'purple-gradient').length, 0, 'low chroma');
});

test('custom properties: vars are expanded before the color and gradient tests', () => {
  const same = one('a.css', ':root{--a:#7c3aed;--b:#4f46e5}\n.h{background:linear-gradient(135deg,var(--a),var(--b))}');
  assert.equal(ids(same, 'purple-gradient').length, 1, 'one finding, not a line and a block');
  const split = one('a.css', '.h{background:linear-gradient(\n135deg,\n#7c3aed,\n#4f46e5)}');
  assert.equal(ids(split, 'purple-gradient').length, 1, 'gradient split over three lines');
  const chained = one('a.css', ':root{--a:var(--b);--b:#7c3aed}\n.h{background:linear-gradient(var(--a),#4f46e5)}');
  assert.equal(ids(chained, 'purple-gradient').length, 1, 'var chains resolve in up to 3 passes');
  const cross = folder({ 'tokens.css': ':root{--a:#7c3aed;--b:#4f46e5}', 'hero.css': '.h{background:linear-gradient(var(--a),var(--b))}' });
  assert.equal(ids(cross, 'purple-gradient').length, 1, 'vars declared in another file');
});

test('CSS-in-JS: eyebrow, gradient text and counters', () => {
  assert.ok(ids(one('a.jsx', 'const s = { textTransform: "uppercase", letterSpacing: "0.2em" };'), 'eyebrow-label').length >= 1, 'one line');
  assert.ok(ids(one('a.jsx', 'const s = {\n  textTransform: \'uppercase\',\n  fontSize: 12,\n  letterSpacing: \'.2em\',\n};'), 'eyebrow-label').length >= 1, 'within 3 lines');
  assert.equal(ids(one('a.tsx', 'const s = { WebkitBackgroundClip: "text" };'), 'gradient-text').length, 1);
  assert.equal(ids(one('a.jsx', "const s = { backgroundClip: 'text' };"), 'gradient-text').length, 1);
  assert.equal(ids(one('a.jsx', 'const label = `0${i + 1}`;'), 'counter-01').length, 1, 'template counter');
  assert.equal(ids(one('a.js', "const s = { listStyleType: 'decimal-leading-zero' };"), 'counter-01').length, 1, 'decimal-leading-zero');
  assert.equal(ids(one('a.js', "const n = String(i).padStart(2, '0');"), 'counter-01').length, 1, 'padStart alone');
});

test('counter-01: a lone <td>05</td> is table data, two counters are a finding', () => {
  assert.equal(ids(one('index.html', '<table><tr><td>05</td></tr></table>'), 'counter-01').length, 0);
  assert.equal(ids(one('index.html', '<span>01</span>\n<span>02</span>'), 'counter-01').length, 2);
});

test('markup: block rules read only <style> and each style attribute', () => {
  assert.equal(ids(one('index.html', '<p>text-transform: uppercase; letter-spacing: .2em</p>'), 'eyebrow-label').length, 0, 'body text is not CSS');
  assert.equal(ids(one('index.html', '<p style="text-transform:uppercase">A</p>\n<p style="letter-spacing:.05em">B</p>'), 'eyebrow-label').length, 0, 'two separate inline styles');
  assert.equal(ids(one('index.html', '<p style="text-transform:uppercase;letter-spacing:.2em">A</p>'), 'eyebrow-label').length, 1, 'one inline style');
  assert.equal(ids(one('index.html', '<style>.e{text-transform:uppercase;letter-spacing:.2em}</style>'), 'eyebrow-label').length, 1, 'style element');
});

test('default typeface: no font set at all is an error, and a quote switches it off', () => {
  const f = one('index.html', '<!doctype html><p>Hi</p>');
  const hit = f.find((x) => x.id === 'default-typeface');
  assert.ok(hit, 'fires with no font family');
  assert.equal(hit.severity, 'error');
  assert.equal(hit.text, 'no typeface set');
  const proj = mkdtempSync(join(tmpdir(), 'tf-'));
  mkdirSync(join(proj, 'cook'), { recursive: true });
  writeFileSync(join(proj, 'cook', 'GATES.json'), '{}');
  writeFileSync(join(proj, 'cook', '.ledger.jsonl'), JSON.stringify({ tool: 'UserPrompt', prompt: 'the client asked for system fonts' }) + '\n');
  writeFileSync(join(proj, 'cook', 'bans.json'), JSON.stringify({ allowed: [{ id: 'default-typeface', quote: 'the client asked for system fonts' }] }));
  writeFileSync(join(proj, 'index.html'), '<!doctype html><p>Hi</p>');
  assert.equal(ids(scan([join(proj, 'index.html')], join(proj, 'cook', 'bans.json')).findings, 'default-typeface').length, 0);
});

test('reduced motion: animate classes and transforming transitions count', () => {
  assert.ok(ids(one('index.html', '<div class="animate-bounce">x</div>'), 'reduced-motion').length === 1, 'animate class');
  assert.ok(ids(one('a.css', '.a{transition:transform .3s}'), 'reduced-motion').length === 1, 'transform transition');
  assert.equal(ids(one('a.css', '.a{transition:color .2s}'), 'reduced-motion').length, 0, 'color transition');
  assert.equal(ids(one('index.html', '<div class="animate-none">x</div>'), 'reduced-motion').length, 0, 'animate-none');
});

test('report targets are absolute paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-cli-'));
  mkdirSync(join(dir, 'site'));
  writeFileSync(join(dir, 'site', 'index.html'), '<!doctype html><style>body{font-family:"Fraunces",serif}</style>');
  const r = spawnSync(process.execPath, [CLI, 'site', '--out', 'rep/slop.json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(readFileSync(join(dir, 'rep', 'slop.json'), 'utf8'));
  assert.deepEqual(report.targets, [resolve(dir, 'site')]);
});

// ---------- baseline, exclude and novelty ----------
const BEIGE_FP = 'beige|src/legacy/old.css|#F5F5DC';
const PURPLE_LINE = '.hero{background:linear-gradient(135deg,#6366f1,#4f46e5)}\n';
function baselineProject() {
  const proj = mkdtempSync(join(tmpdir(), 'base-'));
  mkdirSync(join(proj, 'src', 'legacy'), { recursive: true });
  writeFileSync(join(proj, 'src', 'new.css'), '.card{color:#111;background:#fff}\n');
  writeFileSync(join(proj, 'src', 'legacy', 'old.css'), 'body{background:#F5F5DC}\n');
  return proj;
}

test('baseline and exclude: old slop in an excluded file passes, new slop fails', () => {
  const proj = baselineProject();
  const src = join(proj, 'src');
  const opts = { cwd: proj };
  const first = scan([src], null, opts);
  assert.equal(first.ok, false, 'beige fails with no baseline');
  assert.deepEqual(first.new, [BEIGE_FP]);
  assert.equal(first.findings.every((f) => f.is_new && f.in_scope), true);
  const baseline = first;

  const second = scan([src], null, { ...opts, baseline, exclude: ['src/legacy/**'] });
  assert.equal(second.ok, true, 'old beige in an excluded file does not fail');
  const beige = second.findings.find((f) => f.id === 'beige');
  assert.equal(beige.in_scope, false);
  assert.equal(beige.is_new, false);
  assert.deepEqual(second.remaining, [BEIGE_FP]);
  assert.deepEqual(second.new, []);
  assert.deepEqual(second.fixed, []);
  assert.deepEqual(second.exclude, ['src/legacy/**']);

  // New purple gradient in the excluded file is still scanned and fails.
  writeFileSync(join(src, 'legacy', 'old.css'), 'body{background:#F5F5DC}\n' + PURPLE_LINE);
  const third = scan([src], null, { ...opts, baseline, exclude: ['src/legacy/**'] });
  assert.equal(third.ok, false, 'new purple in an excluded file fails');
  const purple = third.findings.find((f) => f.id === 'purple-gradient');
  assert.ok(purple, 'purple found in the excluded file');
  assert.equal(purple.is_new, true);
  assert.equal(purple.in_scope, false);
  assert.deepEqual(third.new, [purple.fingerprint]);
  assert.equal(purple.fingerprint, 'purple-gradient|src/legacy/old.css|#6366f1');

  // Beige removed: its fingerprint is now fixed.
  writeFileSync(join(src, 'legacy', 'old.css'), PURPLE_LINE);
  const fourth = scan([src], null, { ...opts, baseline, exclude: ['src/legacy/**'] });
  assert.deepEqual(fourth.fixed, [BEIGE_FP]);
  assert.equal(fourth.ok, false, 'the purple is still new');
});

test('project-level findings are in scope even when an exclude glob matches everything', () => {
  const proj = baselineProject();
  writeFileSync(join(proj, 'src', 'legacy', 'anim.css'), '.a{transition:transform .3s}\n');
  const r = scan([join(proj, 'src')], null, { cwd: proj, exclude: ['**'] });
  const rm = r.findings.find((f) => f.id === 'reduced-motion');
  assert.ok(rm, 'reduced-motion fires');
  assert.equal(rm.file, '(project)');
  assert.equal(rm.fingerprint, 'reduced-motion|(project)|');
  assert.equal(rm.in_scope, true);
  assert.equal(r.ok, false);
});

test('scan without options keeps working and marks every finding new', () => {
  const r = scan([fx('slop')], null);
  assert.ok(r.findings.length > 0);
  assert.ok(r.findings.every((f) => f.is_new === true && f.in_scope === true));
  assert.deepEqual(r.fixed, []);
  assert.deepEqual(r.remaining, []);
  assert.equal(r.baseline, null);
  assert.deepEqual(r.exclude, []);
});

test('CLI: --baseline and --exclude write new, fixed and remaining into the report', () => {
  const proj = baselineProject();
  const run = (...args) => spawnSync(process.execPath, [CLI, 'src', ...args], { cwd: proj, encoding: 'utf8' });
  const r1 = run('--out', 'rep/base.json');
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /Baseline: 1 new, 0 fixed, 0 remaining/);

  const r2 = run('--baseline', 'rep/base.json', '--exclude', 'src/legacy/**', '--out', 'rep/now.json');
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /Baseline: 0 new, 0 fixed, 1 remaining/);
  const now = JSON.parse(readFileSync(join(proj, 'rep', 'now.json'), 'utf8'));
  assert.equal(now.ok, true);
  assert.equal(now.baseline, 'rep/base.json');
  assert.deepEqual(now.exclude, ['src/legacy/**']);
  assert.deepEqual(now.new, []);
  assert.deepEqual(now.fixed, []);
  assert.deepEqual(now.remaining, [BEIGE_FP]);

  writeFileSync(join(proj, 'src', 'legacy', 'old.css'), PURPLE_LINE);
  const r3 = run('--baseline', 'rep/base.json', '--exclude', 'src/legacy/**', '--exclude', 'other/**', '--out', 'rep/after.json');
  assert.equal(r3.status, 1, r3.stdout + r3.stderr);
  const after = JSON.parse(readFileSync(join(proj, 'rep', 'after.json'), 'utf8'));
  assert.deepEqual(after.exclude, ['src/legacy/**', 'other/**']);
  assert.deepEqual(after.fixed, [BEIGE_FP]);
  assert.deepEqual(after.remaining, []);
  assert.equal(after.new.length, 1);
  assert.match(after.new[0], /^purple-gradient\|src\/legacy\/old\.css\|/);
  assert.match(r3.stdout, /Baseline: 1 new, 1 fixed, 0 remaining/);
});

// ---------- counted novelty and folder excludes ----------
test('a fingerprint is counted: extra copies of a baseline finding in an excluded file are new', () => {
  const proj = baselineProject();
  const src = join(proj, 'src');
  writeFileSync(join(src, 'legacy', 'old.css'), 'body{background:#F5F5DC}\n' + PURPLE_LINE);
  const baseline = scan([src], null, { cwd: proj });
  assert.equal(baseline.findings.filter((f) => f.id === 'purple-gradient').length, 1);

  // The reported bypass: two more copies of the same purple rule, appended after the baseline.
  writeFileSync(join(src, 'legacy', 'old.css'), 'body{background:#F5F5DC}\n' + PURPLE_LINE + PURPLE_LINE + PURPLE_LINE);
  const r = scan([src], null, { cwd: proj, baseline, exclude: ['src/legacy/**'] });
  assert.equal(r.ok, false, 'appended purple rules fail the scan');
  const purple = r.findings.filter((f) => f.id === 'purple-gradient');
  assert.equal(purple.length, 3);
  assert.deepEqual(purple.map((f) => f.is_new), [false, true, true]);
  assert.ok(purple.every((f) => f.in_scope === false));
  assert.deepEqual(r.new, [purple[1].fingerprint, purple[2].fingerprint]);
  assert.deepEqual([...r.remaining].sort(), [BEIGE_FP, purple[0].fingerprint].sort());
  assert.deepEqual(r.fixed, []);
});

test('fixed counts baseline occurrences that disappeared', () => {
  const proj = baselineProject();
  const src = join(proj, 'src');
  writeFileSync(join(src, 'legacy', 'old.css'), 'body{background:#F5F5DC}\n' + PURPLE_LINE + PURPLE_LINE);
  const baseline = scan([src], null, { cwd: proj });
  writeFileSync(join(src, 'legacy', 'old.css'), 'body{background:#F5F5DC}\n' + PURPLE_LINE);
  const r = scan([src], null, { cwd: proj, baseline, exclude: ['src/legacy/**'] });
  assert.equal(r.ok, true, 'fewer findings than the baseline passes');
  assert.deepEqual(r.new, []);
  assert.deepEqual(r.fixed, ['purple-gradient|src/legacy/old.css|#6366f1']);
});

test('reformatting a legacy file adds nothing new', () => {
  const proj = baselineProject();
  const src = join(proj, 'src');
  writeFileSync(join(src, 'legacy', 'old.css'), 'body{background:#F5F5DC}\n' + PURPLE_LINE);
  const baseline = scan([src], null, { cwd: proj });
  const reformatted = [
    '',
    '',
    '  body {',
    '      background: #F5F5DC;',
    '  }',
    '',
    '  .hero {',
    '    background:',
    '      linear-gradient(',
    '        135deg,',
    '        #6366f1,',
    '        #4f46e5',
    '      );',
    '  }',
    '',
  ].join('\n');
  writeFileSync(join(src, 'legacy', 'old.css'), reformatted);
  const r = scan([src], null, { cwd: proj, baseline, exclude: ['src/legacy/**'] });
  assert.equal(r.findings.length, baseline.findings.length, 'same findings');
  assert.notDeepEqual(r.findings.map((f) => f.line), baseline.findings.map((f) => f.line), 'lines moved');
  assert.deepEqual(r.new, []);
  assert.deepEqual(r.fixed, []);
  assert.deepEqual(r.remaining, baseline.findings.map((f) => f.fingerprint));
  assert.equal(r.ok, true);
});

test('--exclude with a plain folder, a trailing slash or ./ marks findings out of scope', () => {
  const proj = baselineProject();
  const src = join(proj, 'src');
  for (const pattern of ['src/legacy', 'src/legacy/', './src/legacy']) {
    const r = scan([src], null, { cwd: proj, exclude: [pattern] });
    const beige = r.findings.find((f) => f.id === 'beige');
    assert.ok(beige, `beige found with ${pattern}`);
    assert.equal(beige.in_scope, false, `${pattern} excludes src/legacy`);
    const fresh = r.findings.filter((f) => f.file.endsWith('new.css'));
    assert.ok(fresh.every((f) => f.in_scope), `${pattern} keeps src/new.css in scope`);
  }
  const run = (...args) => spawnSync(process.execPath, [CLI, 'src', ...args], { cwd: proj, encoding: 'utf8' });
  const r1 = run('--out', 'rep/plain-base.json');
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  const r2 = run('--baseline', 'rep/plain-base.json', '--exclude', 'src/legacy', '--out', 'rep/plain-now.json');
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  const now = JSON.parse(readFileSync(join(proj, 'rep', 'plain-now.json'), 'utf8'));
  assert.deepEqual(now.exclude, ['src/legacy']);
  assert.equal(now.findings.find((f) => f.id === 'beige').in_scope, false);
});

test('the report records bans_sha1: the sha1 of the bans file it used, null with no bans file, and it changes with the bans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bansha-'));
  const bans = join(dir, 'bans.json');
  writeFileSync(bans, JSON.stringify({ allowed: [], extra: [] }));
  const sha = (p) => createHash('sha1').update(readFileSync(p)).digest('hex');
  assert.equal(scan([fx('clean')], bans).bans_sha1, sha(bans));
  assert.equal(scan([fx('clean')], null).bans_sha1, null, 'no bans file: null');
  assert.equal(scan([fx('clean')], join(dir, 'missing.json')).bans_sha1, null, 'a missing bans file: null');
  const before = scan([fx('clean')], bans).bans_sha1;
  writeFileSync(bans, JSON.stringify({ allowed: [], extra: [{ id: 'no-x', pattern: 'zz' }] }));
  assert.notEqual(scan([fx('clean')], bans).bans_sha1, before, 'a changed bans file has another sha1');
  assert.equal(scan([fx('clean')], bans).bans_sha1, sha(bans));
  // The CLI writes the same value into --out.
  const out = join(dir, 'report.json');
  spawnSync(process.execPath, [CLI, fx('clean'), '--bans', bans, '--out', out], { cwd: dir, encoding: 'utf8' });
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).bans_sha1, sha(bans));
});
