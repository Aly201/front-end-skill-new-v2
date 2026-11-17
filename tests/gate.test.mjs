// Walks a throwaway project through all ten gates and checks that each one refuses
// until its proof exists. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, readFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { lineHash, pageUrl } from '../skills/frontend-cook/scripts/_common.mjs';

const SCRIPTS = resolve(import.meta.dirname, '..', 'skills', 'frontend-cook', 'scripts');
const GATE = join(SCRIPTS, 'gate.mjs');
const proj = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-')));
const cook = (...p) => join(proj, 'cook', ...p);

function runGate(dir, args) {
  const r = spawnSync(process.execPath, [GATE, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const gate = (...args) => runGate(proj, args);
function write(path, text) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); }
// A file with a valid PNG header of the given size (the gate reads headers only). The bytes are
// random after the header, so two files of the same size are still different images.
function png(path, w, h) {
  const b = Buffer.alloc(41);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  randomBytes(8).copy(b, 33);
  mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, b);
}
// Every HTML page the tests write sets a typeface (the slop scan flags a page with none).
const page = (body) => `<!doctype html><html><head><style>body{font-family:"Fraunces",serif}</style></head><body>${body}</body></html>`;
function slop(target, out) {
  return spawnSync(process.execPath, [join(SCRIPTS, 'slop_scan.mjs'), target, '--out', out], { cwd: proj, encoding: 'utf8' }).status;
}
const later = (p) => { const t = new Date(Date.now() + 5000); utimesSync(p, t, t); };

// ---- the ledger the guard hook writes (the tests write the same lines by hand) ----
function logLine(dir, entry) {
  mkdirSync(join(dir, 'cook'), { recursive: true });
  appendFileSync(join(dir, 'cook', '.ledger.jsonl'), JSON.stringify(entry) + '\n');
}
// The user typed these words in this project.
function say(text, dir = proj) {
  logLine(dir, { at: new Date().toISOString(), session_id: 'user-session', tool: 'UserPrompt', file: null, prompt: text });
}
// The build (or the mockup) was written by the builder session.
function built(file, dir = proj) {
  logLine(dir, { at: new Date().toISOString(), session_id: 'builder', tool: 'Write', file, agent: null });
}
// An MCP tool call (the guard hook logs it with the MCP tool name).
function mcpCall(dir, tool) {
  logLine(dir, { at: new Date().toISOString(), session_id: 'builder', tool, file: null, agent: null });
}
const DIMS = ['layout', 'typography', 'color', 'components', 'imagery', 'responsive', 'motion'];
function judgeDoc(name, overall, model) {
  const scores = Object.fromEntries(DIMS.map((d) => [d, overall]));
  const gaps = [{ where: 'hero', what: 'x', fix: 'y' }, { where: 'nav', what: 'x', fix: 'y' }, { where: 'footer', what: 'x', fix: 'y' }];
  return { judge: name, fresh: true, model, scores, overall, similarity: 80, gaps };
}
// A judge file, and the ledger line that proves who wrote it.
function writeJudge(dir, round, name, doc, session, agent) {
  write(join(dir, 'cook', 'judge', round, name), JSON.stringify(doc));
  logLine(dir, { at: new Date().toISOString(), session_id: session, tool: 'Write', file: `cook/judge/${round}/${name}`, agent });
}
// Two judges: a builder subagent (session builder, agent sub-1) and a separate judge session.
function judges(round, overall, dir = proj) {
  writeJudge(dir, round, 'judge-a.json', judgeDoc('A', overall, 'm1'), 'builder', 'sub-1');
  writeJudge(dir, round, 'judge-b.json', { ...judgeDoc('B', overall - 0.2, 'm2'), session: 'separate' }, 'judge-session', null);
}
// Judge the current build again: the new files are made newer than the sources they judge.
function rejudge(round, overall) {
  judges(round, overall);
  for (const f of ['judge-a.json', 'judge-b.json']) later(cook('judge', round, f));
}
// Score again; the summary is stamped after the judge files it summarises.
function rescore(round) {
  gate('score', round);
  later(cook('judge', round, 'summary.json'));
}

// A fresh project with a passing preflight and step 0 done.
function newProject() {
  const d = mkdtempSync(join(tmpdir(), 'fecook-p-'));
  write(join(d, 'cook', 'PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  assert.equal(runGate(d, ['init', '--project', 'P']).code, 0);
  return d;
}
// A project with nine references (five inspo, four awwwards), SOURCES.md and SHOTS.md, step 0 done.
function refsProject(checks = {}) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-refs-')));
  write(join(d, 'cook', 'PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks }));
  assert.equal(runGate(d, ['init', '--project', 'Refs']).code, 0);
  write(join(d, 'cook', 'BRIEF.md'), "# Brief\nTarget: a landing page for a rope maker.\nUser's words: \"make it feel like a workshop\"\n");
  const hosts = 'abcdefghi'.split('').map((c) => `${c}.com`);
  hosts.forEach((h, i) => png(join(d, 'cook', 'refs', `R0${i + 1}.png`), 1440, 900));
  write(join(d, 'cook', 'refs', 'SOURCES.md'), hosts.map((h, i) => `R0${i + 1} | ${i < 5 ? 'inspo' : 'awwwards'} | https://${h}/ | take: type`).join('\n'));
  write(join(d, 'cook', 'SHOTS.md'), hosts.map((h, i) => `| S0${i + 1} | R0${i + 1} | hero | desktop | spacing | - |`).join('\n'));
  return d;
}

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
  // Inspo and Awwwards supplied references, so their tools must have been called, not just named.
  assert.match(gate('verify', '1').out, /libraries were not used/, 'naming the libraries in SOURCES.md is not enough');
  mcpCall(proj, 'mcp__inspo__recommend');
  mcpCall(proj, 'mcp__awwwards__search_sites');
  assert.equal(gate('verify', '1').code, 0, gate('verify', '1').out);
  // Two references that are the same image are one reference.
  const r08 = readFileSync(cook('refs', 'R08.png'));
  write(cook('refs', 'R09.png'), r08);
  assert.match(gate('verify', '1').out, /R0[89] and R0[89] are the same image/);
  png(cook('refs', 'R09.png'), 1440, 900);
  assert.equal(gate('verify', '1').code, 0, gate('verify', '1').out);

  // Step 2: mockup. The builder writes it; two judges score it; the user approves it in their words.
  write(cook('mockup', 'index.html'), page('<h1>Rope for boats that get used.</h1>'));
  built('cook/mockup/index.html');
  png(cook('stills', 'mockup', 'mockup-desktop.png'), 1440, 2000);
  png(cook('stills', 'mockup', 'mockup-mobile.png'), 780, 3000);
  write(cook('compare', 'mockup', 'all.jpg'), 'x');
  assert.equal(slop(cook('mockup'), cook('reports', 'slop-mockup.json')), 0);
  judges('mockup', 8.4);
  assert.equal(gate('score', 'mockup').code, 0);
  assert.equal(gate('verify', '2').code, 1, 'no approval yet');
  assert.equal(gate('approve', 'mockup', '--quote', 'ok').code, 2, 'approval without the user words is refused');
  assert.equal(gate('approve', 'mockup', '--quote', 'yes this mockup feels right').code, 2, 'words the user never typed are refused');
  say('yes this mockup feels right');
  assert.equal(gate('approve', 'mockup', '--quote', 'yes this mockup feels right').code, 0);
  assert.equal(gate('verify', '2').code, 0, gate('verify', '2').out);

  // Step 3: bar
  assert.equal(gate('set-bar', '--judge', '8').code, 2, 'lowering the bar needs the user words');
  assert.equal(gate('set-bar', '--judge', '9.2', '--floor', '0').code, 2, 'a floor of 0 needs the user words');
  assert.equal(gate('set-bar', '--judge', '9.2', '--mockup', '5').code, 2, 'a mockup bar of 5 needs the user words');
  assert.equal(gate('set-bar', '--judge', '11').code, 2, 'a bar above 10 is refused');
  assert.equal(gate('set-bar', '--judge', '9.2', '--floor', '-1').code, 2, 'a negative floor is refused');
  assert.equal(gate('set-bar', '--judge', '9.2', '--floor', '8.5').code, 0);
  assert.equal(gate('verify', '3').code, 1, 'BRIEF has no Bar line yet');
  write(cook('BRIEF.md'), readFileSync(cook('BRIEF.md'), 'utf8') + 'Bar: overall 9.2/10, every dimension 8.5+, similarity 99%\nTime: floor 0h\nBans: defaults\n');
  assert.equal(gate('verify', '3').code, 0, gate('verify', '3').out);

  // Step 4: time
  assert.equal(gate('verify', '4').code, 1);
  assert.equal(gate('set-time', '--floor', '0').code, 2, 'zero hours is refused');
  assert.equal(gate('set-time', '--cap', '2h').code, 2, 'a cap needs the user words');
  say('cap the time at two hours');
  assert.equal(gate('set-time', '--cap', '2h', '--quote', 'cap the time at two hours').code, 0);
  assert.equal(gate('verify', '4').code, 0, gate('verify', '4').out);

  // Step 5: bans. A ban can be switched off only with words the user typed.
  assert.equal(gate('verify', '5').code, 1);
  write(cook('bans.json'), JSON.stringify({ allowed: [{ id: 'em-dash', quote: 'em dashes are fine in the blog copy' }] }));
  assert.match(gate('verify', '5').out, /switched off without the user's own words/);
  say('em dashes are fine in the blog copy');
  assert.equal(gate('verify', '5').code, 0, gate('verify', '5').out);

  // Step 6a: static build. The audit must have run on this build's URL.
  write(join(proj, 'site', 'index.html'), page('<h1>Rope for boats that get used.</h1>'));
  built('site/index.html');
  assert.equal(gate('set-build', '--src', 'site', '--url', 'site/index.html').code, 0);
  png(cook('stills', 'r01', 'S01-desktop.png'), 1440, 2000);
  png(cook('stills', 'r01', 'S01-mobile.png'), 780, 3000);
  write(cook('compare', 'r01', 'all.jpg'), 'x');
  assert.equal(slop(join(proj, 'site'), cook('reports', 'slop-r01.json')), 0);
  const siteUrl = pathToFileURL(join(proj, 'site', 'index.html')).href;
  write(cook('reports', 'audit-r01.json'), JSON.stringify({ ok: true, url: siteUrl, errors: 0, warnings: 0 }));
  judges('r01', 8.9);
  gate('score', 'r01');
  // Animation code in the static build is refused.
  write(join(proj, 'site', 'anim.css'), 'h1 { animation: rise 1s; }');
  built('site/anim.css');
  assert.match(gate('verify', '6a').out, /animation code in the static build/);
  // An audit of some other URL does not prove this build.
  write(cook('reports', 'audit-r01.json'), JSON.stringify({ ok: true, url: 'https://other.example/', errors: 0, warnings: 0 }));
  assert.match(gate('verify', '6a').out, /the audit ran on https:\/\/other\.example\/, not the build/);
  write(cook('reports', 'audit-r01.json'), JSON.stringify({ ok: true, url: siteUrl, errors: 0, warnings: 0 }));
  write(join(proj, 'site', 'anim.css'), 'a { transition: color .2s; }');
  // The side-by-side must be at least as new as the newest source: an old one is refused.
  write(cook('compare', 'r01', 'all.jpg'), 'x');
  const hourAgo = new Date(Date.now() - 3600000);
  utimesSync(cook('compare', 'r01', 'all.jpg'), hourAgo, hourAgo);
  assert.match(gate('verify', '6a').out, /side-by-side is older than the latest source change: rebuild it from the new stills/);
  write(cook('compare', 'r01', 'all.jpg'), 'x');
  // A slop report of some other folder does not prove this build.
  slop(cook('mockup'), cook('reports', 'slop-r01.json'));
  assert.match(gate('verify', '6a').out, /the slop report scanned cook\/mockup, not the build folder/);
  for (const p of ['S01-desktop.png', 'S01-mobile.png']) later(cook('stills', 'r01', p));
  slop(join(proj, 'site'), cook('reports', 'slop-r01.json')); later(cook('reports', 'slop-r01.json')); later(cook('reports', 'audit-r01.json'));
  assert.match(gate('verify', '6a').out, /overall 8\.8\/10 calibrated \(bar 9\.2/, 'below the bar is refused');
  rejudge('r01', 9.6);
  rescore('r01');
  // The user approves the static design after the final stills exist, then the gate passes.
  say('static looks good, go on');
  assert.equal(gate('approve', 'static', '--quote', 'static looks good, go on').code, 0);
  assert.equal(gate('verify', '6a').code, 0, gate('verify', '6a').out);

  // A source change after the stills makes old proof stale. Stills, reports, the side-by-side and judges are redone.
  later(join(proj, 'site', 'index.html'));
  assert.match(gate('verify', '6a').out, /OLDER than the latest source change/);
  for (const p of [cook('stills', 'r01', 'S01-desktop.png'), cook('stills', 'r01', 'S01-mobile.png')]) later(p);
  slop(join(proj, 'site'), cook('reports', 'slop-r01.json')); later(cook('reports', 'slop-r01.json'));
  later(cook('reports', 'audit-r01.json'));
  write(cook('compare', 'r01', 'all.jpg'), 'x'); later(cook('compare', 'r01', 'all.jpg'));
  rejudge('r01', 9.6);
  rescore('r01');

  // Step 6b: no motion, by the user's choice
  assert.equal(gate('set-motion', '--none').code, 2, 'no motion needs the user words');
  say('no animation on this one please');
  assert.equal(gate('set-motion', '--none', '--quote', 'no animation on this one please').code, 0);
  assert.equal(gate('verify', '6b').code, 0, gate('verify', '6b').out);

  // Step 7: feedback
  write(cook('SECTIONS.md'), '## S1 Hero\nBuilt: 96px headline.\n'); later(cook('SECTIONS.md'));
  write(cook('ROUNDS.md'), '# Ledger\n\n## User feedback inbox\n\n---\n\n## Round 01\n');
  assert.match(gate('verify', '7').out, /no feedback recorded/, 'zero feedback needs the user words');
  assert.equal(gate('no-feedback', '--quote', 'no changes at all, it is fine').code, 2, 'no-feedback needs words the user typed');
  say('no changes at all, it is fine');
  assert.equal(gate('no-feedback', '--quote', 'no changes at all, it is fine').code, 0);
  write(cook('ROUNDS.md'), '# Ledger\n\n## User feedback inbox\n\n- 10:00 "hero type bigger" | S1: 72px -> 96px | round 1 | open\n\n---\n\n## Round 01\n');
  assert.equal(gate('verify', '7').code, 1, 'open feedback blocks step 7');
  write(cook('ROUNDS.md'), '# Ledger\n\n## User feedback inbox\n\n- 10:00 "hero type bigger" | headline bigger | round 1 | done, proof: cook/stills/r01/S01-desktop.png\n\n---\n\n## Round 01\n');
  assert.match(gate('verify', '7').out, /not pinned to a section/, 'feedback must name a section');
  write(cook('ROUNDS.md'), '# Ledger\n\n## User feedback inbox\n\n- 10:00 "hero type bigger" | S1: 72px -> 96px | round 1 | done, proof: cook/stills/r01/S01-desktop.png\n\n---\n\n## Round 01\n');
  assert.equal(gate('verify', '7').code, 0, gate('verify', '7').out);

  // Step 8: separate judge (judge-session wrote judge-b; the builder never judged itself), calibration, final approval
  assert.equal(gate('verify', '8').code, 1, 'no final approval yet');
  say('approved, ship it');
  assert.equal(gate('approve', 'final', '--quote', 'approved, ship it').code, 0);
  assert.equal(gate('verify', '8').code, 0, gate('verify', '8').out);

  // The user's estimate lowers the offset; a kinder one on the same round does not raise it.
  say('I rate it 7 out of 10');
  assert.match(gate('calibrate', '--user', '7', '--quote', 'I rate it 7 out of 10').out, /calibration offset now -2\.5/);
  say('I rate it 9.9 out of 10');
  assert.match(gate('calibrate', '--user', '9.9', '--quote', 'I rate it 9.9 out of 10').out, /Not applied/);
  rescore('r01');
  assert.equal(gate('verify', '8').code, 1, 'after a harsher user estimate the same work is below the bar');
});

test('override is logged with the unmet requirements and needs the user words', () => {
  assert.equal(gate('override', '0', '--quote', 'skip setup please', '--reason', 'x').code, 2, 'setup cannot be overridden');
  assert.equal(gate('override', '8', '--quote', 'ok', '--reason', 'x').code, 2);
  assert.equal(gate('override', '8', '--quote', 'ship it anyway, I accept it', '--reason', 'deadline').code, 2, 'words not typed are refused');
  say('ship it anyway, I accept it');
  const r = gate('override', '8', '--quote', 'ship it anyway, I accept it', '--reason', 'deadline');
  assert.equal(r.code, 0);
  assert.match(r.out, /OVERRIDDEN/);
  const g = JSON.parse(readFileSync(cook('GATES.json'), 'utf8'));
  assert.ok(g.overrides['8'].unmet.length > 0);
});

test('motion must come from references, real animation code and real evidence from any tool', () => {
  const p2 = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-m-')));
  const g2 = (...a) => runGate(p2, a).out;
  const c2 = (...p) => join(p2, 'cook', ...p);
  write(c2('PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  g2('init', '--project', 'M');
  // The build has animation code; the motion comes from references (set-motion --refs).
  write(join(p2, 'site', 'index.html'), page('<style>@keyframes rise{from{opacity:0}} h1{animation:rise 1s ease}</style><h1>x</h1>'));
  assert.equal(runGate(p2, ['set-build', '--src', 'site', '--url', 'site/index.html']).code, 0);
  assert.match(g2('check', '6b'), /say where motion comes from: gate\.mjs set-motion --refs/);
  g2('set-motion', '--refs');
  assert.match(g2('check', '6b'), /PASS {2}motion source: set-motion --refs/);

  const row = (ref, how) => `| ${ref} | 0:02 | hero lines | ${how} | reads in order | S1 |`;
  const head = '| Ref | Time | What moves | How | Why | Use in |\n|---|---|---|---|---|---|\n';
  write(c2('MOTION.md'), head + [1, 2, 3, 4, 5].map(() => row('V01', 'fades in nicely')).join('\n'));
  let out = g2('verify', '6b');
  assert.match(out, /without a measured duration and easing/);
  assert.match(out, /from 1 reference/);
  assert.match(out, /V01: no motion evidence/);

  write(c2('MOTION.md'), head + ['V01', 'V01', 'R03', 'R03', 'R03'].map((r) => row(r, '700ms, cubic-bezier(.2,.7,.2,1), 24px up')).join('\n'));
  write(c2('refs', 'V01.mp4'), 'x');                                // the user's own video
  write(c2('refs', 'motion', 'R03-notes.md'), '');                  // a zero-byte note is not evidence
  write(c2('refs', 'motion', 'R030-other.json'), '{}');             // R030 is not evidence for R03
  out = g2('verify', '6b');
  assert.match(out, /PASS {2}every effect has a duration and an easing/);
  assert.match(out, /PASS {2}V01: motion evidence V01\.mp4/);
  assert.match(out, /FAIL {2}R03: no motion evidence/);
  assert.match(out, /PASS {2}effects taken from 2 reference/);
  write(c2('refs', 'motion', 'R03-motion-dna.json'), '{}');         // any tool's extraction output
  out = g2('verify', '6b');
  assert.match(out, /PASS {2}R03: motion evidence R03-motion-dna\.json/);
  assert.match(out, /PASS {2}animation code in the build/);

  // A build with no animation code yet is refused for motion.
  write(join(p2, 'site', 'index.html'), page('<h1>x</h1>'));
  assert.match(g2('verify', '6b'), /FAIL {2}the build has no animation code yet/);
});

test('approval needs the user words typed in this project and stills to show', () => {
  const d = newProject();
  write(join(d, 'cook', 'mockup', 'index.html'), page('<h1>x</h1>'));
  assert.equal(runGate(d, ['approve', 'mockup', '--quote', 'yes this mockup feels right']).code, 2);
  assert.match(runGate(d, ['approve', 'mockup', '--quote', 'yes this mockup feels right']).out, /not logging prompts/);
  say('something else entirely', d);
  assert.match(runGate(d, ['approve', 'mockup', '--quote', 'yes this mockup feels right']).out, /not in any message the user typed/);
  say('yes this mockup feels right', d);
  assert.match(runGate(d, ['approve', 'mockup', '--quote', 'yes this mockup feels right']).out, /no stills to approve/);
  png(join(d, 'cook', 'stills', 'mockup', 'mockup-desktop.png'), 1440, 2000);
  png(join(d, 'cook', 'stills', 'mockup', 'mockup-mobile.png'), 780, 3000);
  assert.equal(runGate(d, ['approve', 'mockup', '--quote', 'yes this mockup feels right']).code, 0);
  // Stills changed after the approval: it no longer counts.
  later(join(d, 'cook', 'stills', 'mockup', 'mockup-desktop.png'));
  assert.match(runGate(d, ['verify', '2']).out, /stills changed after the approval: show the new ones and ask again/);
  // A no-feedback answer needs the user's words too.
  assert.equal(runGate(d, ['no-feedback', '--quote', 'no changes at all, it is fine']).code, 2);
});

test('judges: spread, freshness, provenance', () => {
  const d = newProject();
  write(join(d, 'cook', 'mockup', 'index.html'), page('<h1>x</h1>'));
  logLine(d, { at: new Date().toISOString(), session_id: 'builder', tool: 'Write', file: 'cook/mockup/index.html', agent: null });
  const v = () => runGate(d, ['verify', '2']).out;
  // Three judges: 9.6, 9.6 and 4.0. The median is fine but the lowest judge is far under it.
  writeJudge(d, 'mockup', 'judge-a.json', judgeDoc('A', 9.6, 'm1'), 'builder', 'sub-1');
  writeJudge(d, 'mockup', 'judge-b.json', judgeDoc('B', 9.6, 'm2'), 'judge-session', null);
  writeJudge(d, 'mockup', 'judge-c.json', judgeDoc('C', 4.0, 'm3'), 'judge-two', 'sub-2');
  assert.equal(runGate(d, ['score', 'mockup']).code, 0);
  assert.match(v(), /the lowest judge \(4\) is more than 1\.0 under the median/);
  // A judge file with no ledger Write entry, and one the builder wrote itself.
  write(join(d, 'cook', 'judge', 'mockup', 'judge-d.json'), JSON.stringify(judgeDoc('D', 9.6, 'm4')));
  assert.match(v(), /no ledger Write entry for judge-d\.json/);
  writeJudge(d, 'mockup', 'judge-e.json', judgeDoc('E', 9.6, 'm5'), 'builder', null);
  assert.match(v(), /judge-e\.json written by the builder itself/);
  // A judge file older than the build it judged.
  later(join(d, 'cook', 'mockup', 'index.html'));
  assert.match(v(), /older than the latest source change/);
});

test('the separate judge must be a session that never built, and must meet the bar alone', () => {
  // Negative: the separate judge scores 5.0 while the builder's two judges say 9.6.
  const d = newProject();
  built('site/index.html', d);
  write(join(d, 'site', 'index.html'), page('<h1>x</h1>'));
  writeJudge(d, 'r01', 'judge-a.json', judgeDoc('A', 9.6, 'm1'), 'builder', 'sub-1');
  writeJudge(d, 'r01', 'judge-b.json', judgeDoc('B', 9.6, 'm2'), 'builder', 'sub-1');
  writeJudge(d, 'r01', 'judge-c.json', judgeDoc('C', 5.0, 'm3'), 'judge-session', null);
  assert.equal(runGate(d, ['score', 'r01']).code, 0);
  assert.match(runGate(d, ['verify', '8']).out, /the separate judge scored 5 calibrated: it must meet the bar on its own/);

  // Ledger where the judge session also wrote cook/BRIEF.md: that session built, so it is not separate.
  const d2 = newProject();
  built('site/index.html', d2);
  writeJudge(d2, 'r01', 'judge-a.json', judgeDoc('A', 9.6, 'm1'), 'builder', 'sub-1');
  writeJudge(d2, 'r01', 'judge-b.json', judgeDoc('B', 9.4, 'm2'), 'judge-session', null);
  logLine(d2, { at: new Date().toISOString(), session_id: 'judge-session', tool: 'Write', file: 'cook/BRIEF.md', agent: null });
  assert.equal(runGate(d2, ['score', 'r01']).code, 0);
  assert.match(runGate(d2, ['verify', '8']).out, /no judge file in r01 was written from a separate session/);

  // No ledger at all: the hook is not installed.
  const d3 = newProject();
  write(join(d3, 'cook', 'judge', 'r01', 'judge-a.json'), JSON.stringify(judgeDoc('A', 9.6, 'm1')));
  assert.match(runGate(d3, ['verify', '8']).out, /no ledger: the guard hook is not installed/);
});

test('set-time: a floor under 2h or a cap needs the user words, and verify 4 checks them', () => {
  const d = newProject();
  assert.equal(runGate(d, ['set-time', '--floor', '4h']).code, 0, 'a floor of 2h or more needs no words');
  assert.equal(runGate(d, ['set-time', '--floor', '3h']).code, 2, 'lowering an existing floor needs the words');
  say('three hours is enough', d);
  assert.equal(runGate(d, ['set-time', '--floor', '3h', '--quote', 'three hours is enough']).code, 0);
  assert.equal(runGate(d, ['set-time', '--floor', '1h']).code, 2, 'a floor under 2h needs the words');
  // The stored time has a cap without the words (hand-written): verify 4 says so.
  const g = JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8'));
  g.time = { mode: 'cap', hours: 2, started: new Date().toISOString() };
  write(join(d, 'cook', 'GATES.json'), JSON.stringify(g));
  assert.match(runGate(d, ['verify', '4']).out, /cap of 2h needs the user's words/);
});

test('bar: the Bar line must hold the numbers as numbers, and the step 8 round count needs 2+ judges', () => {
  const d = newProject();
  write(join(d, 'cook', 'BRIEF.md'), 'Target: x\nBar: overall 99%, every dimension 8.5+\n');
  assert.equal(runGate(d, ['set-bar', '--judge', '9', '--floor', '8.5']).code, 2, 'lowering from 9.2 to 9 needs the words');
  say('nine is the bar', d);
  assert.equal(runGate(d, ['set-bar', '--judge', '9', '--floor', '8.5', '--quote', 'nine is the bar']).code, 0);
  assert.match(runGate(d, ['verify', '3']).out, /FAIL {2}BRIEF\.md Bar line must show 9 and 8\.5 as numbers/, '99% is not 9');
  write(join(d, 'cook', 'BRIEF.md'), 'Target: x\nBar: overall 9/10, every dimension 8.5+\n');
  assert.match(runGate(d, ['verify', '3']).out, /PASS {2}BRIEF\.md Bar: overall 9\/10/);

  // Floor mode: only rounds with 2+ judges count toward the 3 rounds.
  assert.equal(runGate(d, ['set-time', '--floor', '3h']).code, 0);
  judges('r01', 9.0, d); judges('r02', 9.0, d);
  writeJudge(d, 'r03', 'judge-a.json', judgeDoc('A', 9.0, 'm1'), 'builder', 'sub-1');
  for (const r of ['r01', 'r02', 'r03']) runGate(d, ['score', r]);
  assert.match(runGate(d, ['verify', '8']).out, /2 judged round\(s\) with 2\+ judges/);
});

test('calibrate: verified words with the number, re-based on newer rounds, offset never above 0', () => {
  const d = newProject();
  judges('r01', 9.0, d);
  assert.equal(runGate(d, ['score', 'r01']).code, 0); // raw 8.9
  const offset = () => JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8')).calibration.offset;

  assert.equal(runGate(d, ['calibrate', '--user', '6']).code, 2, 'calibrate needs the user words');
  say('it feels harsh to me', d);
  assert.equal(runGate(d, ['calibrate', '--user', '6', '--quote', 'it feels harsh to me']).code, 2, 'the words must contain the number');
  say('I rate it 6 out of 10', d);
  const first = runGate(d, ['calibrate', '--user', '6', '--quote', 'I rate it 6 out of 10']);
  assert.equal(first.code, 0);
  assert.match(first.out, /WARNING: with this offset the bar cannot be reached/, '10 - 2.9 is under the 9.2 bar');
  assert.equal(offset(), -2.9);

  // A newer round rated kindly re-bases the offset (never above 0).
  judges('r02', 9.5, d); assert.equal(runGate(d, ['score', 'r02']).code, 0); // raw 9.4
  say('I rate it 9.5 out of 10', d);
  assert.match(runGate(d, ['calibrate', '--user', '9.5', '--round', 'r02', '--quote', 'I rate it 9.5 out of 10']).out, /re-based on r02/);
  assert.equal(offset(), 0);
});

test('the Inspo and Awwwards calls count under the server names in PREFLIGHT; the same image twice is refused', () => {
  const d = refsProject({ mcp_inspo: { ok: true, name: 'myinspo' }, mcp_awwwards: { ok: true, name: 'myaw' } });
  // Calls to servers with other names do not count.
  mcpCall(d, 'mcp__inspo__recommend');
  mcpCall(d, 'mcp__aw__search_sites');
  assert.match(runGate(d, ['verify', '1']).out, /no Inspo\/Awwwards tool call is logged: the libraries were not used/);
  mcpCall(d, 'mcp__myinspo__recommend');
  mcpCall(d, 'mcp__myaw__search_sites');
  const ok = runGate(d, ['verify', '1']);
  assert.equal(ok.code, 0, ok.out);
  // Two reference files with the same bytes are one reference.
  write(join(d, 'cook', 'refs', 'R02.png'), readFileSync(join(d, 'cook', 'refs', 'R01.png')));
  assert.match(runGate(d, ['verify', '1']).out, /R0[12] and R0[12] are the same image/);
});

test('the mobile still is matched by its file name, not by the folder the project sits in', () => {
  // The project folder name contains "desktop": only a desktop still exists, so the mobile check must fail.
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-desktop-')));
  write(join(d, 'cook', 'PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  assert.equal(runGate(d, ['init', '--project', 'D']).code, 0);
  write(join(d, 'cook', 'mockup', 'index.html'), page('<h1>x</h1>'));
  png(join(d, 'cook', 'stills', 'mockup', 'mockup-desktop.png'), 1440, 2000);
  const out = runGate(d, ['verify', '2']).out;
  assert.match(out, /PASS {2}mockup desktop still is newer/);
  assert.match(out, /FAIL {2}mockup mobile still missing/);
});

test('the mockup is a single file', () => {
  const d = newProject();
  write(join(d, 'cook', 'mockup', 'index.html'), page('<h1>x</h1>'));
  assert.match(runGate(d, ['verify', '2']).out, /PASS {2}mockup is a single file/);
  write(join(d, 'cook', 'mockup', 'style.css'), 'h1 { color: #111; }');
  assert.match(runGate(d, ['verify', '2']).out, /FAIL {2}the mockup must be a single file/);
});

// ---- redesign mode: an existing site, the baseline first (step 0b) ----
const HIT_LINE = '@keyframes spin { to { transform: rotate(360deg); } }';
const HIT_HASH = lineHash(HIT_LINE);
const DIRS = ['/', '/pricing'];
const slugOf = (p) => (p === '/' ? 'home' : p.slice(1));
// A redesign project: a site folder with one animation line, init done, step 0 passed.
function redesignProject() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-redesign-')));
  write(join(d, 'cook', 'PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  write(join(d, 'site', 'index.html'), page('<h1>Rope for boats</h1><form><label>Email <input name="email"></label><button>Send</button></form>'));
  write(join(d, 'site', 'app.css'), `${HIT_LINE}\nh1 { color: #111; }\n`);
  assert.equal(runGate(d, ['init', '--project', 'R', '--mode', 'redesign', '--src', 'site', '--exclude', 'site/legacy/**', '--url', 'http://localhost:5173', '--pages', '/,/pricing']).code, 0);
  return d;
}
// sha1 of a project file (regress.mjs writes probes_sha1 this way), or null.
function sha1Of(d, rel) {
  try { return createHash('sha1').update(readFileSync(join(d, rel))).digest('hex'); } catch { return null; }
}
// The baseline files the scripts write (baseline.mjs), for every page, except the named stills.
function baselineCapture(d, skip = []) {
  const B = (...p) => join(d, 'cook', 'baseline', ...p);
  write(B('meta.json'), JSON.stringify({ commit: 'abc1234def', dirty: false, at: new Date().toISOString(), url: 'http://localhost:5173', pages: DIRS }));
  const home = { title: 'Rope', meta_description: '', headings: [{ level: 1, text: 'Rope for boats' }], links: [], nav: [],
    forms: [{ id: '', name: '', action: '', fields: [{ name: 'email', type: 'email', label: 'Email', required: true }], submit: 'Send' }],
    buttons: ['Send'], images: [], ids: [], console_errors: [] };
  const pricing = { title: 'Pricing', meta_description: '', headings: [{ level: 2, text: 'Plans' }], links: [], nav: [], forms: [], buttons: [], images: [], ids: [], console_errors: [] };
  write(B('inventory.json'), JSON.stringify({ pages: { '/': home, '/pricing': pricing } }));
  write(B('motion.json'), JSON.stringify([{ file: 'site/app.css', line: 1, text: HIT_LINE, hash: HIT_HASH }]));
  write(B('checks.json'), '[]');
  write(B('slop.json'), JSON.stringify({ ok: true, errors: 0 }));
  for (const p of DIRS) write(B(`audit-${slugOf(p)}.json`), JSON.stringify({ ok: true, url: 'http://localhost:5173/', errors: 0 }));
  for (const p of DIRS) for (const vp of ['desktop', 'mobile']) for (const fold of ['', '-fold']) {
    const name = `${slugOf(p)}-${vp}${fold}.png`;
    if (!skip.includes(name)) png(B('stills', name), vp === 'desktop' ? 1440 : 780, 900);
  }
}
const KEEP = (motionRows = '', dropped = '- none', copy = '- none') =>
  `## Keep\n- Contact form: "the contact form must still send"\n\n## Dropped\n${dropped}\n\n## Copy changes\n${copy}\n\n## Motion\n| file:line | hash | functional/decorative | keep/replace/remove |\n|---|---|---|---|\n${motionRows}\n`;
const FORM_PROBE = (page) => [{ name: 'contact form submits', page, viewport: 'desktop',
  steps: [{ fill: { label: 'Email', value: 'a@b.co' } }, { click: { role: 'button', name: 'Send' } }], expect: [{ text: 'Thanks' }] }];
// What baseline.mjs --probes-only writes for FORM_PROBE: its expectation is false before the steps and true after.
const PROBE_ROWS = [{ name: 'contact form submits', page: '/', viewport: 'desktop', before: [false], after: [true], proves: true }];
// A whole step 0b pass: the baseline files, the keep list, the probes and the user's approval. Verified.
function passBaseline(d, probes = FORM_PROBE('/'), rows = PROBE_ROWS) {
  baselineCapture(d);
  write(join(d, 'cook', 'baseline', 'KEEP.md'), KEEP(`| site/app.css:1 | ${HIT_HASH} | decorative | remove |`));
  write(join(d, 'cook', 'baseline', 'probes.json'), JSON.stringify(probes));
  write(join(d, 'cook', 'baseline', 'probecheck.json'), JSON.stringify(rows));
  say('approved the keep list and the stills', d);
  assert.equal(runGate(d, ['approve', 'baseline', '--quote', 'approved the keep list and the stills']).code, 0);
  const r = runGate(d, ['verify', '0b']);
  assert.equal(r.code, 0, r.out);
}

test('redesign: init needs --src and --url, status lists step 0b, a new project has no 0b', () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-init-')));
  write(join(d, 'cook', 'PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  write(join(d, 'site', 'index.html'), page('<h1>x</h1>'));
  assert.equal(runGate(d, ['init', '--project', 'R', '--mode', 'redesign', '--src', 'site']).code, 2, 'needs --url');
  assert.equal(runGate(d, ['init', '--project', 'R', '--mode', 'redesign', '--url', 'http://x']).code, 2, 'needs --src');
  assert.equal(runGate(d, ['init', '--project', 'R', '--mode', 'redesign', '--src', 'nope', '--url', 'http://x']).code, 2, 'the src folder must exist');
  assert.equal(runGate(d, ['init', '--project', 'R', '--mode', 'bogus']).code, 2);
  assert.equal(existsSync(join(d, 'cook', 'GATES.json')), false, 'a refused init writes nothing');
  assert.equal(runGate(d, ['init', '--project', 'R', '--mode', 'redesign', '--src', 'site', '--exclude', 'site/legacy/**', '--url', 'http://localhost:5173', '--pages', '/,/pricing']).code, 0);
  const G = JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8'));
  assert.equal(G.mode, 'redesign');
  assert.deepEqual(G.scope, { src: ['site'], exclude: ['site/legacy/**'] });
  assert.deepEqual(G.pages, ['/', '/pricing']);
  assert.deepEqual(G.build, { src: 'site', url: 'http://localhost:5173' });
  assert.match(runGate(d, ['status']).out, /^\s+0b\s+PENDING\s+Baseline: capture, keep list and probes$/m);

  const n = newProject();
  const G2 = JSON.parse(readFileSync(join(n, 'cook', 'GATES.json'), 'utf8'));
  assert.deepEqual(G2.pages, ['/']);
  assert.equal(G2.steps['0b'], undefined, 'a new project has no baseline step');
  assert.doesNotMatch(runGate(n, ['status']).out, /^\s+0b\s/m);
  assert.equal(runGate(n, ['init', '--project', 'X', '--src', 'site']).code, 2, '--src is for redesign mode');
});

test('redesign: step 0b refuses each missing piece of the baseline, then passes', () => {
  const d = redesignProject();
  const v = () => runGate(d, ['verify', '0b']);
  const B = (...p) => join(d, 'cook', 'baseline', ...p);
  // Step 1 waits for step 0b; step 0b itself may start.
  const one = runGate(d, ['verify', '1']);
  assert.equal(one.code, 1);
  assert.match(one.out, /step 0b \(Baseline[^)]*\) is pending/);
  assert.equal(runGate(d, ['check', '0b']).code, 0);

  // A missing fold still.
  baselineCapture(d, ['pricing-mobile-fold.png']);
  let r = v();
  assert.equal(r.code, 1);
  assert.match(r.out, /baseline stills missing: .*pricing-mobile-fold\.png/);
  png(B('stills', 'pricing-mobile-fold.png'), 780, 900);

  // No KEEP.md yet; then a motion hit that is not classified; then a classified one.
  assert.match(v().out, /cook\/baseline\/KEEP\.md missing/);
  write(B('KEEP.md'), KEEP(''));
  assert.match(v().out, /motion hits not classified in KEEP\.md/);
  write(B('KEEP.md'), KEEP(`| site/app.css:1 | ${HIT_HASH} | decorative | remove |`));
  assert.match(v().out, /PASS {2}every motion hit \(1\) is classified/);

  // A form with no probe; a probe on the wrong page; then a probe on the form's page.
  assert.match(v().out, /PASS {2}KEEP\.md has the four headings/);
  assert.match(v().out, /probes\.json missing or not a JSON array/);
  write(B('probes.json'), '[]');
  assert.match(v().out, /0 probe\(s\) that fill or click, for 1 form\(s\)/);
  write(B('probes.json'), JSON.stringify(FORM_PROBE('/pricing')));
  assert.match(v().out, /no probe on \/ for its 1 form\(s\)/);
  write(B('probes.json'), JSON.stringify(FORM_PROBE('/')));
  assert.match(v().out, /PASS {2}a probe covers the form\(s\) on \//);
  assert.match(v().out, /probecheck\.json missing: run node baseline\.mjs --probes-only/);
  write(B('probecheck.json'), JSON.stringify(PROBE_ROWS));

  // No approval; words not typed are refused; then the approval counts.
  assert.match(v().out, /user has not approved the baseline yet/);
  assert.equal(runGate(d, ['approve', 'baseline', '--quote', 'approved the keep list and the stills']).code, 2, 'words not typed are refused');
  say('approved the keep list and the stills', d);
  assert.equal(runGate(d, ['approve', 'baseline', '--quote', 'approved the keep list and the stills']).code, 0);

  // A dirty tree needs the user's words.
  const meta = JSON.parse(readFileSync(B('meta.json'), 'utf8'));
  write(B('meta.json'), JSON.stringify({ ...meta, dirty: true }));
  assert.match(v().out, /dirty tree without the user's words/);
  say('take the baseline on the dirty tree', d);
  assert.equal(runGate(d, ['allow-dirty', '--quote', 'take the baseline on the dirty tree']).code, 0);

  r = v();
  assert.equal(r.code, 0, r.out);
  const G = JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8'));
  assert.equal(G.steps['0b'].status, 'passed');
  assert.deepEqual(G.baseline, { commit: 'abc1234def', dirty: true, at: meta.at, dirty_files: {},
    probes: [{ name: 'contact form submits', page: '/', viewport: 'desktop', expect: [{ text: 'Thanks' }], request_nav: null }] });
  assert.equal(runGate(d, ['check', '1']).code, 0, 'step 1 may start after step 0b');

  // Stills changed after the approval: it no longer counts.
  later(B('stills', 'home-desktop.png'));
  assert.match(v().out, /stills changed after the approval/);
});

test('redesign: motion-allow needs a real hash, a reason and the user words; set-strategy --rebuild and allow-dirty need the user words', () => {
  const d = redesignProject();
  const G = () => JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8'));
  assert.equal(runGate(d, ['motion-allow', 'site/app.css', '000000000000', '--reason', 'spinner']).code, 2, 'a hash not in the file is refused');
  assert.equal(runGate(d, ['motion-allow', 'site/app.css', HIT_HASH]).code, 2, 'a reason is required');
  assert.equal(runGate(d, ['motion-allow', 'site/missing.css', HIT_HASH, '--reason', 'x']).code, 2, 'the file must exist');
  assert.equal(runGate(d, ['motion-allow', 'site/app.css', HIT_HASH, '--reason', 'loading spinner']).code, 2, 'the user words are required');
  assert.equal(runGate(d, ['motion-allow', 'site/app.css', HIT_HASH, '--reason', 'loading spinner', '--quote', 'the spinner must stay forever']).code, 2, 'words not typed are refused');
  say('the spinner must stay forever', d);
  assert.equal(runGate(d, ['motion-allow', 'site/app.css', HIT_HASH, '--reason', 'loading spinner', '--quote', 'the spinner must stay forever']).code, 0);
  assert.deepEqual(G().motion_allow, [{ file: 'site/app.css', hash: HIT_HASH, reason: 'loading spinner', quote: 'the spinner must stay forever' }]);

  assert.equal(runGate(d, ['set-strategy', '--rebuild']).code, 2, 'rebuild needs the user words');
  assert.equal(runGate(d, ['set-strategy', '--rebuild', '--quote', 'rewrite it from scratch']).code, 2, 'words not typed are refused');
  say('rewrite it from scratch', d);
  assert.equal(runGate(d, ['set-strategy', '--rebuild', '--quote', 'rewrite it from scratch']).code, 0);
  assert.equal(G().strategy, 'rebuild');
  assert.equal(G().strategy_quote, 'rewrite it from scratch');
  assert.equal(runGate(d, ['set-strategy', '--in-place']).code, 0);
  assert.equal(G().strategy, 'in-place');

  assert.equal(runGate(d, ['allow-dirty', '--quote', 'take the dirty tree']).code, 2, 'allow-dirty needs words the user typed');

  assert.equal(runGate(d, ['set-checks', '--cmd', 'npm test', '--cmd', 'npm run build']).code, 0);
  assert.deepEqual(G().checks, ['npm test', 'npm run build']);
  assert.equal(runGate(d, ['set-checks', '--cmd', 'npm run lint']).code, 0);
  assert.deepEqual(G().checks, ['npm run lint'], 'set-checks replaces the list');
  assert.equal(runGate(d, ['set-checks']).code, 2);

  assert.equal(runGate(d, ['set-pages', '/,pricing']).code, 2, 'pages start with /');
  assert.equal(runGate(d, ['set-pages', '/,/about']).code, 0);
  assert.deepEqual(G().pages, ['/', '/about']);
});

test('redesign: calibrate re-bases from a later round; a rating of the baseline is recorded and never moves the offset', () => {
  const d = redesignProject();
  const G = () => JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8'));
  const offset = () => G().calibration.offset;
  judges('baseline', 9.0, d);                                  // raw 8.9
  assert.equal(runGate(d, ['score', 'baseline']).code, 0);
  say('I rate it 6 out of 10', d);
  assert.match(runGate(d, ['calibrate', '--user', '6', '--round', 'baseline', '--quote', 'I rate it 6 out of 10']).out, /recorded: you rate the old site 6/);
  assert.equal(offset(), 0, 'the baseline does not calibrate');
  assert.equal(G().calibration.baseline_user.user, 6);
  judges('r03', 9.5, d);                                       // raw 9.4
  assert.equal(runGate(d, ['score', 'r03']).code, 0);
  say('I rate it 6 out of 10 for the round', d);
  assert.equal(runGate(d, ['calibrate', '--user', '6', '--round', 'r03', '--quote', 'I rate it 6 out of 10 for the round']).code, 0);
  assert.equal(offset(), -3.4);
  judges('r04', 9.5, d);                                       // raw 9.4
  assert.equal(runGate(d, ['score', 'r04']).code, 0);
  say('I rate it 9.5 out of 10', d);
  assert.match(runGate(d, ['calibrate', '--user', '9.5', '--round', 'r04', '--quote', 'I rate it 9.5 out of 10']).out, /re-based on r04/);
  assert.equal(offset(), 0);
});

test('redesign: calibrate on the baseline records the user\'s rating for the report, and the report says it is not applied', () => {
  const d = redesignProject();
  judges('baseline', 9.0, d);
  assert.equal(runGate(d, ['score', 'baseline']).code, 0);
  say('I rate it 6 out of 10', d);
  assert.equal(runGate(d, ['calibrate', '--user', '6', '--round', 'baseline', '--quote', 'I rate it 6 out of 10']).code, 0);
  const G = JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8'));
  assert.equal(G.calibration.offset, 0);
  assert.deepEqual(G.calibration.baseline_user, { user: 6, judges: 8.9, at: G.calibration.baseline_user.at, quote: 'I rate it 6 out of 10' });
  assert.equal(runGate(d, ['report']).code, 0);
  assert.match(readFileSync(join(d, 'cook', 'REPORT.md'), 'utf8'), /The user rated the old site 6 \(the judges 8\.9\)\. Recorded, not applied: the offset is 0\./);
});

test('redesign: verify 2 needs the old h1s and form fields in the mockup, and a three-way sheet', () => {
  const d = redesignProject();
  baselineCapture(d);
  write(join(d, 'cook', 'baseline', 'KEEP.md'), KEEP(`| site/app.css:1 | ${HIT_HASH} | decorative | remove |`));
  write(join(d, 'cook', 'mockup', 'index.html'), page('<h1>Something else</h1>'));
  const v2 = () => runGate(d, ['verify', '2']).out;
  assert.match(v2(), /FAIL {2}mockup does not cover the baseline.*Rope for boats/);
  assert.match(v2(), /FAIL {2}no three-way sheet in cook\/compare\/mockup/);

  // Present in the mockup: the h1 and the field name.
  write(join(d, 'cook', 'mockup', 'index.html'), page('<h1>Rope for boats</h1><input name="email">'));
  assert.match(v2(), /PASS {2}mockup covers the baseline on \/: 2 h1, nav and form field\(s\)/);
  png(join(d, 'cook', 'compare', 'mockup', 'three-way.png'), 1800, 900);
  assert.match(v2(), /PASS {2}three-way sheet: three-way\.png/);

  // Gone from the mockup but listed under Dropped and Copy changes: waived.
  write(join(d, 'cook', 'mockup', 'index.html'), page('<h1>Something else</h1>'));
  write(join(d, 'cook', 'baseline', 'KEEP.md'), KEEP(`| site/app.css:1 | ${HIT_HASH} | decorative | remove |`,
    '- Hero headline "Rope for boats" is dropped: the user said "the new hero says it"',
    '- Field "email" becomes "Work email": the user said "rename the email field"'));
  assert.match(v2(), /PASS {2}mockup covers the baseline/);
});

test('redesign: set-bar stores the baseline rule, and verify 3 reports it once the baseline is scored', () => {
  const d = redesignProject();
  assert.equal(runGate(d, ['set-bar']).code, 0);
  assert.equal(JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8')).target.delta, true);
  write(join(d, 'cook', 'BRIEF.md'), 'Target: a rope maker\nBar: overall 9.2/10, every dimension 8.5+\n');
  assert.match(runGate(d, ['verify', '3']).out, /FAIL {2}no dimension may end below the baseline: cook\/judge\/baseline\/summary\.json missing/);
  judges('baseline', 9.0, d);
  assert.equal(runGate(d, ['score', 'baseline']).code, 0);
  assert.match(runGate(d, ['verify', '3']).out, /PASS {2}no dimension may end below the baseline \(baseline overall 8\.9/);
});

// ---- redesign mode: verify 5, 6a, 6b, per-page evidence, verify 8 and the final report ----
const git = (d, ...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: d, encoding: 'utf8' });
// A git repo with a design folder (src), committed as the baseline, then a redesign project on it.
function gitRedesign() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-git-')));
  write(join(d, 'cook', 'PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  write(join(d, 'src', 'App.jsx'), 'export default function App() { return <h1>Rope</h1>; }\n');
  write(join(d, 'src', 'lib', 'x.js'), 'export const x = 1;\n');
  write(join(d, 'src', 'App.test.jsx'), "test('app', () => {});\n");
  git(d, 'init', '-q');
  git(d, 'add', '-A');
  git(d, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline');
  const commit = git(d, 'rev-parse', 'HEAD').stdout.trim();
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(runGate(d, ['init', '--project', 'G', '--mode', 'redesign', '--src', 'src', '--url', 'http://localhost:5173']).code, 0);
  const G = join(d, 'cook', 'GATES.json');
  const g = JSON.parse(readFileSync(G, 'utf8'));
  g.baseline = { commit, dirty: false, at: new Date().toISOString() };
  write(G, JSON.stringify(g));
  return d;
}
function slopRun(d, args) {
  return spawnSync(process.execPath, [join(SCRIPTS, 'slop_scan.mjs'), ...args], { cwd: d, encoding: 'utf8' }).status;
}
// A round r for DIRS: stills, a side-by-side, the slop scan run the redesign way, one audit per page and
// (optionally) a regress report. Judges and the A/B key are written by the tests that need them.
function redesignRound(d, r, { regress = true } = {}) {
  mkdirSync(join(d, 'cook', 'judge', r), { recursive: true }); // a round exists once its judge folder does (pair.mjs makes it)
  for (const p of DIRS) for (const vp of ['desktop', 'mobile']) png(join(d, 'cook', 'stills', r, `${slugOf(p)}-${vp}.png`), vp === 'desktop' ? 1440 : 780, 900);
  write(join(d, 'cook', 'compare', r, 'all.jpg'), 'x');
  // The step 5 record is what every round's slop scan is measured from (made once, the first time a round runs).
  if (!existsSync(join(d, 'cook', 'reports', 'slop-step5.json'))) {
    slopRun(d, ['site', '--baseline', 'cook/baseline/slop.json', '--exclude', 'site/legacy/**', '--out', 'cook/reports/slop-step5.json']);
  }
  slopRun(d, ['site', '--baseline', 'cook/reports/slop-step5.json', '--exclude', 'site/legacy/**', '--out', `cook/reports/slop-${r}.json`]);
  for (const p of DIRS) write(join(d, 'cook', 'reports', `audit-${r}-${slugOf(p)}.json`), JSON.stringify({ ok: true, url: pageUrl('http://localhost:5173', p), errors: 0 }));
  if (regress) write(join(d, 'cook', 'reports', `regress-${r}.json`), JSON.stringify({ ok: true, errors: 0, warnings: 0, url: 'http://localhost:5173', pages: DIRS, findings: [], probes: [], checks: [], probes_sha1: sha1Of(d, 'cook/baseline/probes.json'), at: new Date().toISOString() }));
}
const NEW_SIDE = (k) => k.new;
const OLD_SIDE = (k) => (k.new === 'left' ? 'right' : 'left');
// The A/B key covers each baseline page on desktop and mobile (pair.mjs names the pairs ab-N, one per page and viewport).
const AB_KEY = [
  { pair: 'ab-1', page: '/', viewport: 'desktop', new: 'right' },
  { pair: 'ab-2', page: '/', viewport: 'mobile', new: 'left' },
  { pair: 'ab-3', page: '/pricing', viewport: 'desktop', new: 'right' },
  { pair: 'ab-4', page: '/pricing', viewport: 'mobile', new: 'left' },
];
const pickAll = (pick, keys = AB_KEY) => keys.map((k) => ({ pair: k.pair, better: pick(k), why: 'the new side reads better' }));
// The key and its pairs as pair.mjs writes them: the side-by-side images, then the key (so the key is not older).
function writeKey(d, r, key = AB_KEY) {
  for (const k of key) write(join(d, 'cook', 'compare', r, `${k.pair}.jpg`), 'x');
  write(join(d, 'cook', 'judge', r, '.abkey.json'), JSON.stringify(key));
}
// Two judges, each with an ab list: judge-a is a builder subagent, judge-b a separate session.
function judgesAB(d, r, overall, abA, abB = abA) {
  writeJudge(d, r, 'judge-a.json', { ...judgeDoc('A', overall, 'm1'), ab: abA }, 'builder', 'sub-1');
  writeJudge(d, r, 'judge-b.json', { ...judgeDoc('B', overall - 0.2, 'm2'), session: 'separate', ab: abB }, 'judge-session', null);
}
const lineWith = (out, re) => out.split('\n').find((l) => re.test(l)) || '';

test('redesign: motion-allow needs the user words; an allowed line is no longer animation; comment lines do not count', () => {
  const d = redesignProject();
  write(join(d, 'site', 'notes.js'), '// animation: spin 1s linear infinite\nexport const n = 1;\n');
  const anim = () => lineWith(runGate(d, ['verify', '6b']).out, /animation code in the build|the build has no animation code yet/);
  assert.match(anim(), /PASS {2}animation code in the build: site\/app\.css:1$/);
  assert.doesNotMatch(anim(), /notes\.js/, 'a comment line is not animation code');
  say('the spinner must stay forever', d);
  assert.equal(runGate(d, ['motion-allow', 'site/app.css', HIT_HASH, '--reason', 'loading spinner', '--quote', 'the spinner must stay forever']).code, 0);
  assert.match(anim(), /FAIL {2}the build has no animation code yet/, 'an allowed line does not count');
});

test('redesign: verify 5 refuses design file changes after the baseline commit, and ignores logic and test files', () => {
  assert.match(runGate(redesignProject(), ['verify', '5']).out, /PASS {2}design files vs the baseline commit: not measured: not a git repo/);
  const d = gitRedesign();
  const line = () => lineWith(runGate(d, ['verify', '5']).out, /design files/);
  assert.match(line(), /PASS {2}design files vs the baseline commit: none changed \(0 file\(s\)/);
  write(join(d, 'src', 'lib', 'x.js'), 'export const x = 2;\n');
  write(join(d, 'src', 'App.test.jsx'), "test('app', () => { expect(1).toBe(1); });\n");
  assert.match(line(), /PASS {2}design files vs the baseline commit: none changed \(2 file\(s\) in scope changed, none of them design\)/);
  write(join(d, 'src', 'App.jsx'), 'export default function App() { return <h1>Rope for boats</h1>; }\n');
  assert.match(line(), /FAIL {2}design files changed before the mockup passed: src\/App\.jsx$/);
  write(join(d, 'src', 'Hero.jsx'), 'export const Hero = () => null;\n');
  assert.match(line(), /design files changed before the mockup passed: src\/App\.jsx, src\/Hero\.jsx$/, 'an untracked design file counts');
});

test('redesign: motion-allow --text allows a line before it is written; its hash stops counting once the line is written', () => {
  const d = redesignProject();
  const TEXT = '@keyframes fade { to { opacity: 1; } }';
  const G = () => JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8'));
  const allow = (...extra) => runGate(d, ['motion-allow', 'site/new.css', '--text', TEXT, '--reason', 'fade in', ...extra]);
  assert.equal(allow().code, 2, 'the user words are required');
  assert.equal(allow('--quote', 'the fade must stay').code, 2, 'words not typed are refused');
  say('the fade must stay', d);
  assert.equal(allow('--quote', 'the fade must stay').code, 0);
  assert.deepEqual(G().motion_allow, [{ file: 'site/new.css', hash: lineHash(TEXT), reason: 'fade in', quote: 'the fade must stay', text: TEXT }]);
  assert.equal(runGate(d, ['motion-allow', 'site/new.css', lineHash(TEXT), '--text', TEXT, '--reason', 'x', '--quote', 'the fade must stay']).code, 2, 'a hash and --text together are refused');
  assert.equal(runGate(d, ['motion-allow', 'site/new.css', '--reason', 'x', '--quote', 'the fade must stay']).code, 2, 'a hash or --text is required');

  const anim = () => lineWith(runGate(d, ['verify', '6b']).out, /animation code in the build|the build has no animation code yet/);
  write(join(d, 'site', 'new.css'), `  ${TEXT}\n`);      // indented: the hash is of the trimmed line
  write(join(d, 'site', 'other.css'), `${TEXT}\n`);     // the same line, not allowed
  assert.match(anim(), /other\.css:1/, 'a line that is not allowed still counts');
  assert.doesNotMatch(anim(), /new\.css/, 'the allowed line no longer counts once it is written');
});

test('redesign: verify 0b needs probecheck.json with a row per probe, at least as new as probes.json, and every row proving something', () => {
  const d = redesignProject();
  baselineCapture(d);
  write(join(d, 'cook', 'baseline', 'KEEP.md'), KEEP(`| site/app.css:1 | ${HIT_HASH} | decorative | remove |`));
  const B = (...p) => join(d, 'cook', 'baseline', ...p);
  const out = () => runGate(d, ['verify', '0b']).out;
  const line = (re) => lineWith(out(), re);
  // Both files written; probecheck is newer unless the test makes probes.json newer.
  const state = (probes, rows, older = false) => {
    write(B('probes.json'), JSON.stringify(probes));
    write(B('probecheck.json'), JSON.stringify(rows));
    if (older) later(B('probes.json')); else later(B('probecheck.json'));
  };
  const SECOND = { name: 'menu opens', page: '/', viewport: 'desktop', steps: [{ click: { role: 'button', name: 'Menu' } }], expect: [{ visible: { role: 'navigation' } }] };

  state(FORM_PROBE('/'), [{ ...PROBE_ROWS[0], before: [true], proves: false }]);
  assert.match(line(/probe contact form submits/), /FAIL {2}probe contact form submits proves nothing: its expectation already holds before the steps\. Fix the probe and run baseline\.mjs --probes-only$/);

  state(FORM_PROBE('/'), [{ ...PROBE_ROWS[0], before: [false], after: [false], proves: false, error: 'steps: timeout waiting for Send' }]);
  assert.match(line(/probe contact form submits/), /FAIL {2}probe contact form submits proves nothing: its expectation already holds before the steps \(or it errored: steps: timeout waiting for Send\)\. Fix the probe/);

  state(FORM_PROBE('/'), PROBE_ROWS, true);
  assert.match(line(/probecheck\.json/), /FAIL {2}cook\/baseline\/probecheck\.json is older than probes\.json: run node baseline\.mjs --probes-only$/);

  state([...FORM_PROBE('/'), SECOND], PROBE_ROWS);
  assert.match(line(/probecheck\.json/), /FAIL {2}probecheck\.json has no row for: menu opens: run node baseline\.mjs --probes-only$/);

  state([...FORM_PROBE('/'), SECOND], [...PROBE_ROWS, { ...PROBE_ROWS[0], name: 'menu opens' }]);
  assert.match(out(), /PASS {2}probecheck\.json: all 2 probe\(s\) prove something/);
  assert.doesNotMatch(out(), /FAIL {2}probe /);

  rmSync(B('probecheck.json'));
  assert.match(line(/probecheck/), /FAIL {2}cook\/baseline\/probecheck\.json missing: run node baseline\.mjs --probes-only$/);
});

test('redesign: verify 5 ignores a design file that was already dirty at the baseline, until its content changes again', () => {
  const d = gitRedesign();
  const hash = (f) => createHash('sha1').update(readFileSync(join(d, f))).digest('hex');
  const line = () => lineWith(runGate(d, ['verify', '5']).out, /design files/);
  const PASS = /PASS {2}design files vs the baseline commit: none changed \(1 file\(s\) in scope changed, 1 already dirty at the baseline and unchanged since, the rest not design\)/;
  const FAIL = /FAIL {2}design files changed before the mockup passed: src\/App\.jsx$/;

  write(join(d, 'src', 'App.jsx'), 'export default function App() { return <h1>Rope, dirty</h1>; }\n');
  assert.match(line(), FAIL);
  // Recorded at the baseline in cook/baseline/meta.json (g.baseline has no entry for the file yet).
  write(join(d, 'cook', 'baseline', 'meta.json'), JSON.stringify({ dirty: true, dirty_files: { 'src/App.jsx': hash('src/App.jsx') } }));
  assert.match(line(), PASS);
  write(join(d, 'src', 'App.jsx'), 'export default function App() { return <h1>Rope, edited</h1>; }\n');
  assert.match(line(), FAIL, 'a change after the baseline counts again');

  // Copied into g.baseline (verify 0b does this); the current content is the recorded one.
  const G = join(d, 'cook', 'GATES.json');
  const g = JSON.parse(readFileSync(G, 'utf8'));
  g.baseline.dirty_files = { 'src/App.jsx': hash('src/App.jsx') };
  write(G, JSON.stringify(g));
  assert.match(line(), PASS);
  write(join(d, 'src', 'App.jsx'), 'export default function App() { return <h1>Rope, again</h1>; }\n');
  assert.match(line(), FAIL);
});

test('redesign: init --exclude stores each pattern without a leading ./ or a trailing /', () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-excl-')));
  write(join(d, 'cook', 'PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  write(join(d, 'src', 'index.html'), page('<h1>x</h1>'));
  const init = (...ex) => runGate(d, ['init', '--project', 'E', '--mode', 'redesign', '--src', 'src', ...ex, '--url', 'http://localhost:5173']);
  assert.equal(init('--exclude', './').code, 2, 'an empty pattern is refused');
  assert.equal(existsSync(join(d, 'cook', 'GATES.json')), false);
  assert.equal(init('--exclude', './src/legacy/', '--exclude', 'src/vendor/**').code, 0);
  const G = JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8'));
  assert.deepEqual(G.scope.exclude, ['src/legacy', 'src/vendor/**']);
});

test('redesign: the step 5 slop scan and every round need the baseline and the excludes, over every source folder', () => {
  const d = redesignProject();
  baselineCapture(d);
  const v5 = () => runGate(d, ['verify', '5']).out;
  slopRun(d, ['site', '--out', 'cook/reports/slop-step5.json']);
  assert.match(v5(), /FAIL {2}slop scan of the source folders \(step 5\): run slop_scan\.mjs with --baseline cook\/baseline\/slop\.json/, 'no --baseline is refused');
  slopRun(d, ['site', '--baseline', 'cook/baseline/slop.json', '--out', 'cook/reports/slop-step5.json']);
  assert.match(v5(), /FAIL {2}slop scan of the source folders \(step 5\): run slop_scan\.mjs with --exclude site\/legacy\/\*\*/, 'the exclude globs are required');
  slopRun(d, ['site/index.html', '--baseline', 'cook/baseline/slop.json', '--exclude', 'site/legacy/**', '--out', 'cook/reports/slop-step5.json']);
  assert.match(v5(), /FAIL {2}slop scan of the source folders \(step 5\): the slop report does not scan every source folder \(missing site/, 'one file is not the folder');
  slopRun(d, ['site', '--baseline', 'cook/baseline/slop.json', '--exclude', 'site/legacy/**', '--out', 'cook/reports/slop-step5.json']);
  assert.doesNotMatch(v5(), /slop scan of the source folders \(step 5\): run slop_scan/);
  assert.match(v5(), /PASS {2}slop scan of the source folders \(step 5\): recorded/);

  // Every round is held to the same rule: measured from the step 5 record.
  redesignRound(d, 'r01');
  assert.doesNotMatch(runGate(d, ['verify', '6a']).out, /r01 slop scan: run slop_scan/);
  slopRun(d, ['site', '--out', 'cook/reports/slop-r01.json']);
  assert.match(runGate(d, ['verify', '6a']).out, /FAIL {2}r01 slop scan: run slop_scan\.mjs with --baseline cook\/reports\/slop-step5\.json/);
});

test('redesign: 6a needs a strategy, a passing regress report, and no decorative motion left in the code', () => {
  const d = redesignProject();
  baselineCapture(d);
  write(join(d, 'cook', 'baseline', 'KEEP.md'), KEEP(`| site/app.css:1 | ${HIT_HASH} | decorative | remove |`));
  redesignRound(d, 'r01', { regress: false });
  judges('r01', 9.6, d);
  assert.equal(runGate(d, ['score', 'r01']).code, 0);
  const v6a = () => runGate(d, ['verify', '6a']).out;
  assert.match(v6a(), /FAIL {2}strategy not set/);
  assert.equal(runGate(d, ['set-strategy', '--in-place']).code, 0);
  assert.match(v6a(), /FAIL {2}r01 regress report missing \(cook\/reports\/regress-r01\.json\)/);
  const regress = (ok, errors) => write(join(d, 'cook', 'reports', 'regress-r01.json'), JSON.stringify({ ok, errors, warnings: 0, url: 'http://localhost:5173', pages: DIRS, findings: [], probes: [], checks: [], probes_sha1: sha1Of(d, 'cook/baseline/probes.json'), at: new Date().toISOString() }));
  regress(false, 2);
  assert.match(v6a(), /FAIL {2}r01 regress: 2 errors/);
  regress(true, 0);
  assert.match(v6a(), /PASS {2}r01 regress: clean/);
  assert.match(v6a(), /FAIL {2}decorative motion still in the code.*site\/app\.css:1/, 'the decorative line must go');
  write(join(d, 'site', 'app.css'), 'h1 { color: #111; }\n');
  assert.match(v6a(), /PASS {2}no decorative motion left in the code/);
});

test('redesign: every page needs its own stills and audit; a trailing slash in an audit URL is the same URL', () => {
  const d = redesignProject();
  baselineCapture(d);
  redesignRound(d, 'r01');
  const v6a = () => runGate(d, ['verify', '6a']).out;
  assert.match(v6a(), /PASS {2}r01 \/pricing audit: clean/);
  rmSync(join(d, 'cook', 'stills', 'r01', 'pricing-desktop.png'));
  assert.match(v6a(), /FAIL {2}r01 \/pricing desktop still missing \(cook\/stills\/r01\/pricing-desktop\.png\)/);
  png(join(d, 'cook', 'stills', 'r01', 'pricing-desktop.png'), 1440, 900);
  assert.match(v6a(), /PASS {2}r01 \/pricing desktop still is newer/);
  write(join(d, 'cook', 'reports', 'audit-r01-pricing.json'), JSON.stringify({ ok: true, url: 'http://localhost:5173/pricing/', errors: 0 }));
  assert.match(v6a(), /PASS {2}r01 \/pricing audit: clean/, 'the trailing slash is not a different page');
  write(join(d, 'cook', 'reports', 'audit-r01-pricing.json'), JSON.stringify({ ok: true, url: 'http://localhost:5173/', errors: 0 }));
  assert.match(v6a(), /FAIL {2}r01 \/pricing audit: the audit ran on http:\/\/localhost:5173\/, not the build/);
  rmSync(join(d, 'cook', 'reports', 'audit-r01-home.json'));
  assert.match(v6a(), /FAIL {2}r01 \/ audit report missing \(cook\/reports\/audit-r01-home\.json\)/);
});

test('redesign: verify 8 old against new: a key, a choice on the new side in every judge, and no dimension below the baseline', () => {
  const d = redesignProject();
  baselineCapture(d);
  judges('baseline', 9.0, d);
  assert.equal(runGate(d, ['score', 'baseline']).code, 0);
  redesignRound(d, 'r01');
  const v8 = () => runGate(d, ['verify', '8']).out;
  judgesAB(d, 'r01', 9.6, pickAll(NEW_SIDE));
  assert.equal(runGate(d, ['score', 'r01']).code, 0);
  assert.match(v8(), /FAIL {2}no A\/B key for r01: run pair\.mjs --round r01/);

  writeKey(d, 'r01');
  // judge-a prefers the old side in ab-1; judge-b leaves ab-2 out.
  judgesAB(d, 'r01', 9.6, pickAll((k) => (k.pair === 'ab-1' ? OLD_SIDE(k) : NEW_SIDE(k))), pickAll(NEW_SIDE, AB_KEY.slice(0, 1)));
  assert.equal(runGate(d, ['score', 'r01']).code, 0);
  let out = v8();
  assert.match(out, /FAIL {2}judge-a\.json: prefers the old site in ab-1 \(\/ desktop\)/);
  assert.match(out, /FAIL {2}judge-b\.json: no ab entry for ab-2 \(\/ mobile\)/);
  assert.doesNotMatch(out, /abkey/, 'the key is not a judge file');

  judgesAB(d, 'r01', 9.6, pickAll(NEW_SIDE));
  assert.equal(runGate(d, ['score', 'r01']).code, 0);
  out = v8();
  assert.match(out, /PASS {2}judge-a\.json: every A\/B pair \(4\) chooses the new side/);
  assert.match(out, /PASS {2}judge-b\.json: every A\/B pair \(4\) chooses the new side/);
  assert.match(out, /PASS {2}A\/B key covers every baseline page on desktop and mobile \(2 page\(s\)\)/);
  assert.match(out, /PASS {2}no dimension below the baseline/);
  assert.doesNotMatch(out, /abkey/);
});

test('redesign: verify 8 refuses a round where a dimension ends below the baseline', () => {
  const d = redesignProject();
  baselineCapture(d);
  judges('baseline', 9.0, d);
  assert.equal(runGate(d, ['score', 'baseline']).code, 0);
  redesignRound(d, 'r01');
  writeKey(d, 'r01');
  judgesAB(d, 'r01', 8.0, pickAll(NEW_SIDE));
  assert.equal(runGate(d, ['score', 'r01']).code, 0);
  assert.match(runGate(d, ['verify', '8']).out, /FAIL {2}below the baseline in cook\/judge\/r01\/summary\.json: layout 7\.9 \(baseline 8\.9\)/);
});

test('redesign: report writes cook/REPORT.md with the before and after table, Dropped lines and motion allowances', () => {
  const d = redesignProject();
  baselineCapture(d);
  write(join(d, 'cook', 'baseline', 'KEEP.md'), KEEP(`| site/app.css:1 | ${HIT_HASH} | functional | keep |`, '- Hero video: the user said "drop the hero video"'));
  say('the spinner must stay forever', d);
  assert.equal(runGate(d, ['motion-allow', 'site/app.css', HIT_HASH, '--reason', 'loading spinner', '--quote', 'the spinner must stay forever']).code, 0);
  judges('baseline', 9.0, d);
  assert.equal(runGate(d, ['score', 'baseline']).code, 0);
  redesignRound(d, 'r01');
  judges('r01', 9.6, d);
  assert.equal(runGate(d, ['score', 'r01']).code, 0);
  const r = runGate(d, ['report']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Written to cook\/REPORT\.md/);
  const md = readFileSync(join(d, 'cook', 'REPORT.md'), 'utf8');
  assert.match(md, /\| Dimension \| Baseline \| r01 \| Change \|/);
  assert.match(md, /\| color \| 8\.9 \| 9\.5 \| \+0\.6 \|/);
  assert.match(md, /## Slop/);
  assert.match(md, /\| Page \| Baseline \| r01 \|/);
  assert.match(md, /- Hero video: the user said "drop the hero video"/);
  assert.match(md, /site\/app\.css [0-9a-f]{12}: loading spinner\. The user said: "the spinner must stay forever"/);

  const n = newProject();
  assert.equal(runGate(n, ['report']).code, 0);
  const mdNew = readFileSync(join(n, 'cook', 'REPORT.md'), 'utf8');
  assert.match(mdNew, /## Steps/);
  assert.doesNotMatch(mdNew, /Before and after/);
});

// ---- review round 2: the step 5 record, KEEP words, the probes approved at 0b, the mockup's pages, plain excludes,
// raw medians, the A/B key and the design check's file text ----

test('redesign: verify 5 records the scan: old in-scope slop and a ban added at step 5 still pass; a stale record and a round on the old baseline fail', () => {
  const d = redesignProject();
  write(join(d, 'site', 'app.css'), `${HIT_LINE}\nbody { background: #F5F5DC; }\nh1 { color: #111; }\n`);
  baselineCapture(d);
  slopRun(d, ['site', '--out', 'cook/baseline/slop.json']);
  assert.ok(JSON.parse(readFileSync(join(d, 'cook', 'baseline', 'slop.json'), 'utf8')).errors > 0, 'the old site has in-scope slop');
  const slopLine = () => lineWith(runGate(d, ['verify', '5']).out, /slop scan of the source folders/);
  const step5 = () => slopRun(d, ['site', '--baseline', 'cook/baseline/slop.json', '--exclude', 'site/legacy/**', '--out', 'cook/reports/slop-step5.json']);

  // Step 5: the user adds a ban the untouched old site breaks. The record is made and passes.
  write(join(d, 'cook', 'bans.json'), JSON.stringify({ allowed: [], extra: [{ id: 'no-rope', pattern: 'Rope' }] }));
  step5();
  assert.ok(JSON.parse(readFileSync(join(d, 'cook', 'reports', 'slop-step5.json'), 'utf8')).new.length > 0, 'the new ban hits the old site');
  assert.match(slopLine(), /PASS {2}slop scan of the source folders \(step 5\): recorded/);

  // A ban changed after the record: the record no longer matches the bans.
  write(join(d, 'cook', 'bans.json'), JSON.stringify({ allowed: [], extra: [{ id: 'no-rope', pattern: 'Rope' }, { id: 'no-zz', pattern: 'zz' }] }));
  assert.match(slopLine(), /FAIL {2}slop scan of the source folders \(step 5\): the report was made with other bans than cook\/bans.json/);
  step5();
  assert.match(slopLine(), /PASS {2}slop scan of the source folders \(step 5\): recorded/);

  // Every round is measured from the record. A round scanned against the old site's baseline fails.
  redesignRound(d, 'r01');
  slopRun(d, ['site', '--baseline', 'cook/baseline/slop.json', '--exclude', 'site/legacy/**', '--out', 'cook/reports/slop-r01.json']);
  assert.match(runGate(d, ['verify', '6a']).out, /FAIL {2}r01 slop scan: run slop_scan\.mjs with --baseline cook\/reports\/slop-step5\.json/);
});

test('redesign: a bullet in Dropped or Copy changes quotes the user\'s own words, checked by verify 6a', () => {
  const d = redesignProject();
  baselineCapture(d);
  const B = (...p) => join(d, 'cook', 'baseline', ...p);
  write(B('KEEP.md'), KEEP(`| site/app.css:1 | ${HIT_HASH} | decorative | remove |`,
    '- Hero video: the user said "drop the hero video"',
    '- Field "email" becomes "Work email": the user said "rename the email field"'));
  redesignRound(d, 'r01');
  const line = () => lineWith(runGate(d, ['verify', '6a']).out, /Dropped and Copy changes|every Dropped and Copy changes line/);
  assert.match(line(), /FAIL {2}Dropped and Copy changes lines need the user's exact words .*Hero video/, 'no typed words');
  say('drop the hero video', d);
  assert.match(line(), /FAIL {2}Dropped and Copy changes lines need .*Field "email"/, 'one line is still without the words');
  say('rename the email field', d);
  assert.match(line(), /PASS {2}every Dropped and Copy changes line \(2\) quotes the user's own words/);
  write(B('KEEP.md'), KEEP(`| site/app.css:1 | ${HIT_HASH} | decorative | remove |`));
  assert.match(line(), /PASS {2}every Dropped and Copy changes line \(0\)/, 'a line that says none is no entry');
});

test('redesign: the probes the user approved at 0b are the probes the rounds run on: a relabelled step passes, a weakened probe fails 6a', () => {
  const d = redesignProject();
  passBaseline(d);
  const G = () => JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8'));
  assert.deepEqual(G().baseline.probes, [{ name: 'contact form submits', page: '/', viewport: 'desktop', expect: [{ text: 'Thanks' }], request_nav: null }]);
  redesignRound(d, 'r01');
  const probes = join(d, 'cook', 'baseline', 'probes.json');
  const probeLine = () => lineWith(runGate(d, ['verify', '6a']).out, /probe "contact form submits"/);
  assert.match(probeLine(), /PASS {2}probe "contact form submits" is as the user approved it at step 0b \(page, viewport, request expectations, 1 expectation/);

  // A step's selector may change: the probe still checks the same thing.
  const relabel = FORM_PROBE('/');
  relabel[0].steps[0] = { fill: { label: 'Work email', value: 'a@b.co' } };
  write(probes, JSON.stringify(relabel));
  assert.match(probeLine(), /PASS {2}probe "contact form submits" is as the user approved it/);

  // A cut expectation: the probe proves less than it did at 0b.
  const cut = FORM_PROBE('/');
  cut[0].expect = [];
  write(probes, JSON.stringify(cut));
  assert.match(probeLine(), /FAIL {2}probe "contact form submits" weakened since step 0b: it has 0 expectation\(s\), it had 1 at step 0b\. Restore/);

  write(probes, '[]');
  assert.match(probeLine(), /FAIL {2}probe "contact form submits" was removed since step 0b/);
});

test('redesign: a probe\'s request expectations are fixed at 0b, and the snapshot keeps whether each request was a navigation', () => {
  const d = redesignProject();
  const withRequest = [{ name: 'contact form submits', page: '/', viewport: 'desktop',
    steps: [{ fill: { label: 'Email', value: 'a@b.co' } }, { click: { role: 'button', name: 'Send' } }],
    expect: [{ request: '/api/contact' }, { text: 'Thanks' }] }];
  passBaseline(d, withRequest, [{ ...PROBE_ROWS[0], request_nav: [false] }]);
  const G = JSON.parse(readFileSync(join(d, 'cook', 'GATES.json'), 'utf8'));
  assert.deepEqual(G.baseline.probes, [{ name: 'contact form submits', page: '/', viewport: 'desktop', expect: withRequest[0].expect, request_nav: [false] }]);
  redesignRound(d, 'r01');
  const probeLine = () => lineWith(runGate(d, ['verify', '6a']).out, /probe "contact form submits"/);
  assert.match(probeLine(), /PASS {2}probe "contact form submits" is as the user approved it/);
  write(join(d, 'cook', 'baseline', 'probes.json'), JSON.stringify([{ ...withRequest[0], expect: [{ text: 'Thanks' }] }]));
  assert.match(probeLine(), /FAIL {2}probe "contact form submits" weakened since step 0b: its request expectations changed; it has 1 expectation\(s\), it had 2/);
});

test('redesign: regress must have run on the current probes.json (probes_sha1): 6a refuses a regress report made from other probes', () => {
  const d = redesignProject();
  passBaseline(d);
  redesignRound(d, 'r01');
  const reg = join(d, 'cook', 'reports', 'regress-r01.json');
  const line = () => lineWith(runGate(d, ['verify', '6a']).out, /regress ran on the current|regress was not run on the current/);
  assert.match(line(), /PASS {2}r01 regress ran on the current probes\.json/);
  const rj = JSON.parse(readFileSync(reg, 'utf8'));
  write(reg, JSON.stringify({ ...rj, probes_sha1: 'f'.repeat(40) }));
  assert.match(line(), /FAIL {2}r01 regress was not run on the current probes\.json \(probes_sha1 ffff/);
  const { probes_sha1: _drop, ...noSha } = rj;
  write(reg, JSON.stringify(noSha));
  assert.match(line(), /FAIL {2}r01 regress was not run on the current probes\.json \(probes_sha1 missing/);
  write(reg, JSON.stringify(rj));
  assert.match(line(), /PASS {2}r01 regress ran on the current probes\.json/);
  write(join(d, 'cook', 'baseline', 'probes.json'), JSON.stringify(FORM_PROBE('/').map((p) => ({ ...p, viewport: 'mobile' }))));
  assert.match(line(), /FAIL {2}r01 regress was not run on the current probes\.json/, 'a probe edited after the regress run');
});

test('redesign: verify 2 checks the pages the mockup covers (the first page by default); a field is found by its label or its name', () => {
  const d = redesignProject();
  baselineCapture(d);
  const B = (...p) => join(d, 'cook', 'baseline', ...p);
  write(B('KEEP.md'), KEEP(`| site/app.css:1 | ${HIT_HASH} | decorative | remove |`));
  const inv = JSON.parse(readFileSync(B('inventory.json'), 'utf8'));
  inv.pages['/pricing'].headings = [{ level: 1, text: 'Simple, Transparent Pricing' }];
  inv.pages['/'].forms[0].fields = [{ name: 'contact_email', type: 'email', label: 'Your email address', required: true }];
  write(B('inventory.json'), JSON.stringify(inv));
  const mockup = join(d, 'cook', 'mockup', 'index.html');
  const v2 = () => lineWith(runGate(d, ['verify', '2']).out, /mockup covers the baseline|mockup does not cover/);

  // A home-only mockup: the pricing h1 is not needed. The field passes by its label.
  write(mockup, page('<h1>Rope for boats</h1><label>Your email address <input></label>'));
  assert.match(v2(), /PASS {2}mockup covers the baseline on \/: 2 h1, nav and form field\(s\)/);
  write(mockup, page('<h1>Rope for boats</h1><input name="contact_email">'));
  assert.match(v2(), /PASS {2}mockup covers the baseline on \//, 'the field passes by its name');
  write(mockup, page('<h1>Rope for boats</h1>'));
  assert.match(v2(), /FAIL {2}mockup does not cover the baseline: missing "Your email address" \(\/\)/);

  // Covering the pricing page: its h1 is needed, unless it is waived.
  write(join(d, 'cook', 'BRIEF.md'), 'Mockup covers: /,/pricing\n');
  write(mockup, page('<h1>Rope for boats</h1><label>Your email address <input></label>'));
  assert.match(v2(), /FAIL {2}mockup does not cover the baseline: missing "Simple, Transparent Pricing" \(\/pricing\)/);
  write(B('KEEP.md'), KEEP(`| site/app.css:1 | ${HIT_HASH} | decorative | remove |`,
    '- Pricing heading "Simple, Transparent Pricing" is dropped: the user said "drop the pricing heading"'));
  say('drop the pricing heading', d);
  assert.match(v2(), /PASS {2}mockup covers the baseline on \/, \/pricing/, 'waived by the Dropped line');

  write(join(d, 'cook', 'BRIEF.md'), 'Mockup covers: /,/nope\n');
  const out2 = runGate(d, ['verify', '2']).out;
  assert.match(out2, /FAIL {2}"Mockup covers" names \/nope, which the baseline inventory does not have/);
  assert.match(out2, /PASS {2}mockup covers the baseline on \/: 2 h1, nav and form field\(s\)/, 'only the known page is checked');
});

test('redesign: --exclude with a plain folder takes its files out of the 6a animation check, as the glob does', () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-plain-')));
  write(join(d, 'cook', 'PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  write(join(d, 'site', 'index.html'), page('<h1>x</h1>'));
  write(join(d, 'site', 'legacy', 'old.css'), `${HIT_LINE}\n`);
  assert.equal(runGate(d, ['init', '--project', 'P', '--mode', 'redesign', '--src', 'site', '--exclude', 'site/legacy/', '--url', 'http://localhost:5173']).code, 0);
  mkdirSync(join(d, 'cook', 'judge', 'r01'), { recursive: true }); // 6a reports the animation line once a round exists
  const anim = () => lineWith(runGate(d, ['verify', '6a']).out, /animation code/);
  assert.match(anim(), /PASS {2}no animation code in the static build/, 'legacy keyframes are out of scope');
  write(join(d, 'site', 'app.css'), `${HIT_LINE}\n`);
  assert.match(anim(), /FAIL {2}animation code in the static build \(motion waits for step 6b\): site\/app\.css:1/);
});

test('redesign: verify 8 compares raw judge medians: a calibration offset does not fail a round against the baseline', () => {
  const d = redesignProject();
  baselineCapture(d);
  judges('baseline', 8.9, d);                    // raw colour 8.8, at offset 0
  assert.equal(runGate(d, ['score', 'baseline']).code, 0);
  redesignRound(d, 'r01');
  writeKey(d, 'r01');
  judgesAB(d, 'r01', 9.3, pickAll(NEW_SIDE));    // raw 9.2 in every dimension
  assert.equal(runGate(d, ['score', 'r01']).code, 0);
  say('I rate it 8.7 out of 10', d);
  assert.equal(runGate(d, ['calibrate', '--user', '8.7', '--round', 'r01', '--quote', 'I rate it 8.7 out of 10']).code, 0);
  assert.equal(runGate(d, ['score', 'r01']).code, 0);
  const sum = JSON.parse(readFileSync(join(d, 'cook', 'judge', 'r01', 'summary.json'), 'utf8'));
  assert.equal(sum.offset, -0.5);
  assert.equal(sum.calibrated.dims.color, 8.7, 'calibrated, the colour is below the baseline');
  assert.equal(sum.raw.dims.color, 9.2);
  assert.match(runGate(d, ['verify', '8']).out, /PASS {2}no dimension below the baseline \(raw judge medians/);
});

test('redesign: the A/B key covers every baseline page on desktop and mobile; the key and pairs are newer than the fold stills; ab-N.jpg is not the side-by-side', () => {
  const d = redesignProject();
  baselineCapture(d);
  judges('baseline', 9.0, d);
  assert.equal(runGate(d, ['score', 'baseline']).code, 0);
  redesignRound(d, 'r01');
  judgesAB(d, 'r01', 9.6, pickAll(NEW_SIDE));
  assert.equal(runGate(d, ['score', 'r01']).code, 0);
  const v8 = (re) => lineWith(runGate(d, ['verify', '8']).out, re);
  const compare = (f) => join(d, 'cook', 'compare', 'r01', f);

  writeKey(d, 'r01', AB_KEY.slice(0, 2));
  assert.match(v8(/A\/B key/), /FAIL {2}A\/B key has no pair for \/pricing desktop, \/pricing mobile/);
  writeKey(d, 'r01');
  assert.match(v8(/A\/B key covers/), /PASS {2}A\/B key covers every baseline page on desktop and mobile \(2 page\(s\)\)/);
  assert.match(v8(/A\/B key and pairs|are newer than/), /PASS {2}the A\/B key and pairs are newer/);

  // A fold still of the round made after the pairs: the pairs and the key are stale.
  png(join(d, 'cook', 'stills', 'r01', 'home-desktop-fold.png'), 1440, 900);
  later(join(d, 'cook', 'stills', 'r01', 'home-desktop-fold.png'));
  assert.match(v8(/older than the round's fold stills/), /FAIL {2}\.abkey\.json, ab-1\.jpg, ab-2\.jpg, ab-3\.jpg, ab-4\.jpg older than the round's fold stills or the latest source change/);
  // The pairs and the key are written again after the fold still: they are newer than it now.
  writeKey(d, 'r01');
  for (const k of AB_KEY) later(join(d, 'cook', 'compare', 'r01', `${k.pair}.jpg`));
  later(join(d, 'cook', 'judge', 'r01', '.abkey.json'));
  assert.match(v8(/are newer than/), /PASS {2}the A\/B key and pairs are newer/);

  // The A/B pairs never satisfy the side-by-side with the references.
  rmSync(compare('all.jpg'));
  assert.match(lineWith(runGate(d, ['verify', '6a']).out, /side-by-side/), /FAIL {2}r01 side-by-side missing \(cook\/compare\/r01\/\)/);
  rmSync(compare('ab-3.jpg'));
  assert.match(v8(/A\/B side-by-side missing/), /FAIL {2}A\/B side-by-side missing: ab-3\.jpg/);
});

test('redesign: verify 5 reads the text of a .js file: an untracked component with JSX is a design file', () => {
  const d = gitRedesign();
  const line = () => lineWith(runGate(d, ['verify', '5']).out, /design files/);
  write(join(d, 'src', 'components', 'util.js'), 'export const add = (a, b) => a + b;\n');
  assert.match(line(), /PASS {2}design files vs the baseline commit: none changed \(1 file\(s\) in scope changed, none of them design\)/, 'plain logic is not design');
  write(join(d, 'src', 'components', 'Hero.js'), 'export const Hero = () => <div className="hero">Rope</div>;\n');
  assert.match(line(), /FAIL {2}design files changed before the mockup passed: src\/components\/Hero\.js$/);
});
