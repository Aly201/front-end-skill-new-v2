// Walks a throwaway project through all ten gates and checks that each one refuses
// until its proof exists. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = resolve(import.meta.dirname, '..', 'skills', 'frontend-cook', 'scripts');
const GATE = join(SCRIPTS, 'gate.mjs');
const proj = mkdtempSync(join(tmpdir(), 'fecook-'));
const cook = (...p) => join(proj, 'cook', ...p);

function runGate(dir, args) {
  const r = spawnSync(process.execPath, [GATE, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const gate = (...args) => runGate(proj, args);
function write(path, text) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); }
// A file with a valid PNG header of the given size (the gate reads headers only).
function png(path, w, h) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
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

  // Step 6a: static build
  write(join(proj, 'site', 'index.html'), page('<h1>Rope for boats that get used.</h1>'));
  built('site/index.html');
  assert.equal(gate('set-build', '--src', 'site', '--url', 'site/index.html').code, 0);
  png(cook('stills', 'r01', 'S01-desktop.png'), 1440, 2000);
  png(cook('stills', 'r01', 'S01-mobile.png'), 780, 3000);
  write(cook('compare', 'r01', 'all.jpg'), 'x');
  assert.equal(slop(join(proj, 'site'), cook('reports', 'slop-r01.json')), 0);
  write(cook('reports', 'audit-r01.json'), JSON.stringify({ ok: true, errors: 0, warnings: 0 }));
  judges('r01', 8.9);
  gate('score', 'r01');
  // Animation code in the static build is refused.
  write(join(proj, 'site', 'anim.css'), 'h1 { animation: rise 1s; }');
  built('site/anim.css');
  assert.match(gate('verify', '6a').out, /animation code in the static build/);
  write(join(proj, 'site', 'anim.css'), 'a { transition: color .2s; }');
  for (const p of ['S01-desktop.png', 'S01-mobile.png']) later(cook('stills', 'r01', p));
  slop(join(proj, 'site'), cook('reports', 'slop-r01.json')); later(cook('reports', 'slop-r01.json')); later(cook('reports', 'audit-r01.json'));
  assert.match(gate('verify', '6a').out, /overall 8\.8\/10 calibrated \(bar 9\.2/, 'below the bar is refused');
  rejudge('r01', 9.6);
  rescore('r01');
  // The user approves the static design after the final stills exist, then the gate passes.
  say('static looks good, go on');
  assert.equal(gate('approve', 'static', '--quote', 'static looks good, go on').code, 0);
  assert.equal(gate('verify', '6a').code, 0, gate('verify', '6a').out);

  // A source change after the stills makes old proof stale. Stills, reports and judges are redone.
  later(join(proj, 'site', 'index.html'));
  assert.match(gate('verify', '6a').out, /OLDER than the latest source change/);
  for (const p of [cook('stills', 'r01', 'S01-desktop.png'), cook('stills', 'r01', 'S01-mobile.png')]) later(p);
  slop(join(proj, 'site'), cook('reports', 'slop-r01.json')); later(cook('reports', 'slop-r01.json'));
  later(cook('reports', 'audit-r01.json'));
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

test('motion must come from references, with saved evidence from any tool', () => {
  const p2 = mkdtempSync(join(tmpdir(), 'fecook-m-'));
  const g2 = (...a) => { const r = spawnSync(process.execPath, [GATE, ...a], { cwd: p2, encoding: 'utf8' }); return r.stdout + r.stderr; };
  const c2 = (...p) => join(p2, 'cook', ...p);
  write(c2('PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  g2('init', '--project', 'M');
  const row = (ref, how) => `| ${ref} | 0:02 | hero lines | ${how} | reads in order | S1 |`;
  const head = '| Ref | Time | What moves | How | Why | Use in |\n|---|---|---|---|---|---|\n';
  write(c2('MOTION.md'), head + [1, 2, 3, 4, 5].map(() => row('V01', 'fades in nicely')).join('\n'));
  let out = g2('verify', '6b');
  assert.match(out, /without a measured duration and easing/);
  assert.match(out, /from 1 reference/);
  assert.match(out, /V01: no motion evidence/);
  write(c2('MOTION.md'), head + ['V01', 'V01', 'R03', 'R03', 'R03'].map((r) => row(r, '700ms, cubic-bezier(.2,.7,.2,1), 24px up')).join('\n'));
  write(c2('refs', 'V01.mp4'), 'x');                                // the user's own video
  write(c2('refs', 'motion', 'R03-motion-dna.json'), '{}');         // any tool's extraction output
  out = g2('verify', '6b');
  assert.match(out, /PASS {2}every effect has a duration and an easing/);
  assert.match(out, /PASS {2}V01: motion evidence V01\.mp4/);
  assert.match(out, /PASS {2}R03: motion evidence R03-motion-dna\.json/);
  assert.match(out, /PASS {2}effects taken from 2 reference/);
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
