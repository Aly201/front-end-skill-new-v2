// Walks a throwaway project through all ten gates and checks that each one refuses
// until its proof exists. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = resolve(import.meta.dirname, '..', 'skills', 'frontend-cook', 'scripts');
const proj = mkdtempSync(join(tmpdir(), 'fecook-'));
const cook = (...p) => join(proj, 'cook', ...p);

function gate(...args) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'gate.mjs'), ...args], { cwd: proj, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
function write(path, text) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); }
// A file with a valid PNG header of the given size (the gate reads headers only).
function png(path, w, h) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, b);
}
function judges(round, overall, extra = {}) {
  const dims = { layout: overall, typography: overall, color: overall, components: overall, imagery: overall, responsive: overall, motion: overall };
  const gaps = [{ where: 'hero', what: 'x', fix: 'y' }, { where: 'nav', what: 'x', fix: 'y' }, { where: 'footer', what: 'x', fix: 'y' }];
  write(cook('judge', round, 'judge-a.json'), JSON.stringify({ judge: 'A', fresh: true, model: 'm1', scores: dims, overall, similarity: 80, gaps, ...extra }));
  write(cook('judge', round, 'judge-b.json'), JSON.stringify({ judge: 'B', fresh: true, model: 'm2', session: 'separate', scores: dims, overall: overall - 0.2, similarity: 78, gaps }));
}
function slop(target, out) {
  return spawnSync(process.execPath, [join(SCRIPTS, 'slop_scan.mjs'), target, '--out', out], { cwd: proj, encoding: 'utf8' }).status;
}
const later = (p) => { const t = new Date(Date.now() + 5000); utimesSync(p, t, t); };

test('gates refuse until proof exists, then pass in order', () => {
  write(cook('PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  assert.equal(gate('init', '--project', 'Test').code, 0);

  // Step 1: references
  assert.equal(gate('check', '1').code, 0);
  assert.equal(gate('verify', '1').code, 1, 'no references yet');
  assert.equal(gate('check', '2').code, 1, 'step 2 may not start before step 1');
  write(cook('BRIEF.md'), "# Brief\nTarget: a landing page for a rope maker. Stack: plain HTML.\nUser's words: \"make it feel like a workshop\"\n");
  const hosts = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com', 'h.com', 'i.com'];
  hosts.forEach((h, i) => png(cook('refs', `R0${i + 1}.png`), 1440, 900));
  write(cook('refs', 'SOURCES.md'), hosts.map((h, i) => `R0${i + 1} | ${i < 5 ? 'inspo' : 'awwwards'} | https://${h}/ | take: type`).join('\n'));
  write(cook('SHOTS.md'), hosts.map((h, i) => `| S0${i + 1} | R0${i + 1} | hero | desktop | spacing | - |`).join('\n'));
  png(cook('refs', 'R09.png'), 400, 300);
  assert.match(gate('verify', '1').out, /R09: 400x300/, 'thumbnail-sized reference is refused');
  png(cook('refs', 'R09.png'), 1440, 900);
  assert.equal(gate('verify', '1').code, 0, gate('verify', '1').out);

  // Step 2: mockup
  write(cook('mockup', 'index.html'), '<!doctype html><html><body><h1>Rope for boats that get used.</h1></body></html>');
  png(cook('stills', 'mockup', 'mockup-desktop.png'), 1440, 2000);
  png(cook('stills', 'mockup', 'mockup-mobile.png'), 780, 3000);
  write(cook('compare', 'mockup', 'all.jpg'), 'x');
  assert.equal(slop(cook('mockup'), cook('reports', 'slop-mockup.json')), 0);
  judges('mockup', 8.4);
  assert.equal(gate('score', 'mockup').code, 0);
  assert.equal(gate('verify', '2').code, 1, 'no approval yet');
  assert.equal(gate('approve', 'mockup', '--quote', 'ok').code, 2, 'approval without the user words is refused');
  assert.equal(gate('approve', 'mockup', '--quote', 'yes this mockup feels right').code, 0);
  assert.equal(gate('verify', '2').code, 0, gate('verify', '2').out);

  // Step 3: bar
  assert.equal(gate('set-bar', '--judge', '8').code, 2, 'lowering the bar needs the user words');
  assert.equal(gate('set-bar', '--judge', '9.2', '--floor', '8.5').code, 0);
  assert.equal(gate('verify', '3').code, 1, 'BRIEF has no Bar line yet');
  write(cook('BRIEF.md'), readFileSync(cook('BRIEF.md'), 'utf8') + 'Bar: overall 9.2/10, every dimension 8.5+, similarity 99%\nTime: floor 0h\nBans: defaults\n');
  assert.equal(gate('verify', '3').code, 0);

  // Step 4: time
  assert.equal(gate('verify', '4').code, 1);
  assert.equal(gate('set-time', '--floor', '0').code, 0);
  assert.equal(gate('verify', '4').code, 0);

  // Step 5: bans
  assert.equal(gate('verify', '5').code, 1);
  spawnSync(process.execPath, [join(SCRIPTS, 'slop_scan.mjs'), '--init'], { cwd: proj });
  assert.equal(gate('verify', '5').code, 0);

  // Step 6a: static build
  write(join(proj, 'site', 'index.html'), '<!doctype html><html><body><h1>Rope for boats that get used.</h1></body></html>');
  assert.equal(gate('set-build', '--src', 'site', '--url', 'site/index.html').code, 0);
  png(cook('stills', 'r01', 'S01-desktop.png'), 1440, 2000);
  png(cook('stills', 'r01', 'S01-mobile.png'), 780, 3000);
  write(cook('compare', 'r01', 'all.jpg'), 'x');
  assert.equal(slop(join(proj, 'site'), cook('reports', 'slop-r01.json')), 0);
  write(cook('reports', 'audit-r01.json'), JSON.stringify({ ok: true, errors: 0, warnings: 0 }));
  judges('r01', 8.9);
  gate('score', 'r01');
  gate('approve', 'static', '--quote', 'static looks good, go on');
  assert.match(gate('verify', '6a').out, /overall 8\.8\/10 calibrated \(bar 9\.2/, 'below the bar is refused');
  judges('r01', 9.6);
  gate('score', 'r01');
  assert.equal(gate('verify', '6a').code, 0, gate('verify', '6a').out);

  // A source change after the stills makes old proof stale.
  later(join(proj, 'site', 'index.html'));
  assert.match(gate('verify', '6a').out, /OLDER than the latest source change/);
  for (const p of [cook('stills', 'r01', 'S01-desktop.png'), cook('stills', 'r01', 'S01-mobile.png')]) later(p);
  slop(join(proj, 'site'), cook('reports', 'slop-r01.json')); later(cook('reports', 'slop-r01.json'));
  later(cook('reports', 'audit-r01.json'));
  gate('score', 'r01'); later(cook('judge', 'r01', 'summary.json'));

  // Step 6b: no motion, by the user's choice
  assert.equal(gate('set-motion', '--none').code, 2);
  assert.equal(gate('set-motion', '--none', '--quote', 'no animation on this one please').code, 0);
  assert.equal(gate('verify', '6b').code, 0, gate('verify', '6b').out);

  // Step 7: feedback
  write(cook('ROUNDS.md'), '# Ledger\n\n## User feedback inbox\n\n- 10:00 "hero type bigger" | round 1 | open\n\n---\n\n## Round 01\n');
  assert.equal(gate('verify', '7').code, 1, 'open feedback blocks step 7');
  write(cook('ROUNDS.md'), '# Ledger\n\n## User feedback inbox\n\n- 10:00 "hero type bigger" | round 1 | done, proof: cook/stills/r01/S01-desktop.png\n\n---\n\n## Round 01\n');
  write(cook('SECTIONS.md'), '1. Hero\n'); later(cook('SECTIONS.md'));
  assert.equal(gate('verify', '7').code, 0, gate('verify', '7').out);

  // Step 8: separate judge, calibration, final approval
  assert.equal(gate('verify', '8').code, 1, 'no final approval yet');
  gate('approve', 'final', '--quote', 'approved, ship it');
  assert.equal(gate('verify', '8').code, 0, gate('verify', '8').out);

  // The user's kinder estimate never raises scores; a harsher one lowers them.
  assert.match(gate('calibrate', '--user', '9.9').out, /Not applied/);
  gate('calibrate', '--user', '7');
  gate('score', 'r01'); later(cook('judge', 'r01', 'summary.json'));
  assert.equal(gate('verify', '8').code, 1, 'after a harsher user estimate the same work is below the bar');
});

test('override is logged with the unmet requirements and needs the user words', () => {
  assert.equal(gate('override', '0', '--quote', 'skip setup please', '--reason', 'x').code, 2, 'setup cannot be overridden');
  assert.equal(gate('override', '8', '--quote', 'ok', '--reason', 'x').code, 2);
  const r = gate('override', '8', '--quote', 'ship it anyway, I accept it', '--reason', 'deadline');
  assert.equal(r.code, 0);
  assert.match(r.out, /OVERRIDDEN/);
  const g = JSON.parse(readFileSync(cook('GATES.json'), 'utf8'));
  assert.ok(g.overrides['8'].unmet.length > 0);
});
