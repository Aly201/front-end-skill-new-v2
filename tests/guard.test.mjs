// The guard hook, fed the same JSON Claude Code sends it on stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { userSaid, lineHash } from '../skills/frontend-cook/scripts/_common.mjs';

const GUARD = resolve(import.meta.dirname, '..', 'skills', 'frontend-cook', 'scripts', 'guard.mjs');
const proj = mkdtempSync(join(tmpdir(), 'guard-'));
mkdirSync(join(proj, 'cook'), { recursive: true });
const setSteps = (passed, extra = {}) => writeFileSync(join(proj, 'cook', 'GATES.json'), JSON.stringify({
  steps: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6a', '6b', '7', '8'].map((s) => [s, { status: passed.includes(s) ? 'passed' : 'pending' }])), ...extra,
}));
const run = (payload) => {
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: proj, session_id: 's1', hook_event_name: 'PreToolUse', ...payload }), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const write = (file, content) => run({ tool_name: 'Write', tool_input: { file_path: file, content } });
const bash = (command) => run({ tool_name: 'Bash', tool_input: { command } });
const ledgerText = () => readFileSync(join(proj, 'cook', '.ledger.jsonl'), 'utf8');

test('does nothing in projects without frontend-cook', () => {
  const other = mkdtempSync(join(tmpdir(), 'other-'));
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: other, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(other, 'a.js'), content: '@keyframes x{}' } }), encoding: 'utf8' });
  assert.equal(r.status, 0);
});

test('mockup first, then the bar, time and bans, then static first, then motion', () => {
  setSteps(['0', '1']);
  assert.equal(write(join(proj, 'src/index.html'), '<h1>x</h1>').code, 2, 'build blocked before the mockup');
  assert.equal(write(join(proj, 'cook/site/index.html'), '<h1>x</h1>').code, 2, 'build under cook/ is build too');
  assert.equal(write(join(proj, 'package.json'), '{}').code, 0, 'non-frontend files are fine');
  assert.equal(write('cook/mockup/index.html', '<h1>x</h1>').code, 0, 'static mockup allowed (relative path)');
  assert.equal(write('cook/mockup/index.html', '<style>@keyframes a{}</style>').code, 2, 'animated mockup blocked');
  setSteps(['0', '1', '2']);
  const early = write(join(proj, 'src/index.html'), '<h1>x</h1>');
  assert.equal(early.code, 2, 'build blocked until steps 2 to 5 passed');
  assert.match(early.err, /steps 2 to 5 \(mockup, bar, time, bans\) must pass before build code/);
  setSteps(['0', '1', '2', '3', '4']);
  assert.equal(write(join(proj, 'src/index.html'), '<h1>x</h1>').code, 2, 'build blocked until step 5 (bans) passed');
  setSteps(['0', '1', '2', '3', '4', '5']);
  assert.equal(write(join(proj, 'src/index.html'), '<h1>x</h1>').code, 0, 'build allowed after steps 2 to 5 passed');
  const e = run({ tool_name: 'Edit', tool_input: { file_path: join(proj, 'src/app.jsx'), old_string: 'a', new_string: "import { motion } from 'framer-motion'" } });
  assert.equal(e.code, 2, 'animation in an Edit blocked during static');
  assert.match(e.err, /static first/);
  assert.equal(write(join(proj, 'src/a.css'), 'a { transition: color .2s }').code, 0, 'hover transitions allowed in static');
  setSteps(['0', '1', '2', '3', '4', '5', '6a']);
  assert.equal(write(join(proj, 'src/a.css'), '@keyframes rise {}').code, 0, 'motion allowed after 6a');
  setSteps(['0', '1', '2', '3', '4', '5', '6a'], { motion: 'none', motion_quote: 'no animation please' });
  assert.match(write(join(proj, 'src/a.css'), '@keyframes rise {}').err, /chose no motion/);
});

test('the motion check covers every frontend file, references excepted', () => {
  setSteps(['0', '1', '2', '3', '4', '5']);
  const motion = [
    ['cook/mockup/index.html', '<script>const o = new IntersectionObserver(cb)</script>'],
    ['src/index.html', '<img data-aos="fade-up">'],
    ['src/index.html', '<marquee>hi</marquee>'],
    ['src/a.css', 'a { transition: transform .8s }'],
    ['src/a.css', 'a { transition-duration: 600ms }'],
    ['src/b.js', 'requestAnimationFrame(tick)'],
    ['src/c.jsx', 'import anime from "animejs"'],
    ['src/d.jsx', '<motion.div whileInView={{ opacity: 1 }} />'],
  ];
  for (const [file, content] of motion) {
    assert.equal(write(file.startsWith('src/') ? join(proj, file) : file, content).code, 2, `static blocks motion in ${file}: ${content}`);
  }
  assert.equal(write(join(proj, 'cook/refs/ref.html'), '@keyframes spin {}').code, 0, 'references are exempt');
  assert.equal(write(join(proj, 'src/a.css'), 'a { transition: color .2s }').code, 0, 'a short color transition is fine');
});

test('a judge file is written once', () => {
  setSteps(['0']);
  mkdirSync(join(proj, 'cook/judge/r02'), { recursive: true });
  writeFileSync(join(proj, 'cook/judge/r02/judge-a.json'), '{"overall":9}');
  const again = write('cook/judge/r02/judge-a.json', '{"overall":10}');
  assert.equal(again.code, 2, 'a second write to an existing judge file is blocked');
  assert.match(again.err, /written once/);
  assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: join(proj, 'cook/judge/r02/judge-a.json'), old_string: '9', new_string: '10' } }).code, 2, 'an edit is blocked too');
  assert.equal(bash('rm cook/judge/r02/judge-a.json').code, 2, 'rm of a judge file is blocked');
  assert.equal(bash('mv cook/judge/r02/judge-a.json /tmp/x.json').code, 2, 'mv of a judge file is blocked');
  assert.equal(write('cook/judge/r02/judge-b.json', '{}').code, 0, 'a new judge file is fine');
});

test('script-written files are protected, case-insensitively, and bypasses are blocked', () => {
  setSteps(['0']);
  assert.equal(write('cook/GATES.json', '{}').code, 2);
  assert.equal(write('cook/gates.json', '{}').code, 2, 'protected names ignore case');
  assert.equal(write('cook/judge/r01/summary.json', '{}').code, 2);
  assert.equal(write('cook/reports/audit-r01.json', '{}').code, 2);
  assert.equal(bash("echo '{}' > cook/GATES.json").code, 2);
  assert.equal(bash('cd cook && echo x > GATES.json').code, 2, 'a cd in front does not hide the write');
  assert.equal(bash("node -e \"require('fs').writeFileSync('cook/GATES.json','{}')\"").code, 2, 'node -e writes are blocked');
  assert.equal(bash('touch cook/stills/r01/S01-desktop.png').code, 2, 'touch under cook/ is blocked');
  assert.equal(bash('node slop_scan.mjs src --out cook/reports/slop-r01.json').code, 0, 'the scripts themselves may write reports');
  assert.equal(bash('node x/gate.mjs score r01 2>&1').code, 0, 'stderr redirects are not file writes');
  assert.equal(bash('cat cook/GATES.json').code, 0, 'reading a protected file is fine');
  assert.equal(write('cook/judge/r01/judge-a.json', '{}').code, 0, 'judges write their own files');
  assert.match(ledgerText(), /"session_id":"s1","tool":"Write","file":"cook\/judge\/r01\/judge-a.json"/);
});

test('every call is logged with its command and the agent that made it', () => {
  setSteps(['0']);
  assert.equal(bash('ls cook').code, 0);
  assert.match(ledgerText(), /"tool":"Bash","file":null,"agent":null,"cmd":"ls cook"/);
  const sub = run({ agent_id: 'sub-7', tool_name: 'Write', tool_input: { file_path: 'cook/BRIEF.md', content: '# brief' } });
  assert.equal(sub.code, 0);
  assert.match(ledgerText(), /"agent":"sub-7"/);
});

test('every prompt gets the current step and is logged', () => {
  setSteps(['0', '1']);
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: proj, hook_event_name: 'UserPromptSubmit', prompt: 'make it calmer' }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Current step: 2 \(mockup\)/);
  assert.match(ledgerText(), /"tool":"UserPrompt","file":null,"agent":null,"prompt":"make it calmer"/);
});

test('MCP tool calls are logged and allowed', () => {
  setSteps(['0']);
  const r = run({ tool_name: 'mcp__inspo__recommend', tool_input: { query: 'saas hero' } });
  assert.equal(r.code, 0);
  assert.match(ledgerText(), /"tool":"mcp__inspo__recommend","file":null/);
});

test('agent-browser is blocked in Bash and as a tool', () => {
  setSteps(['0']);
  const b = bash('npx agent-browser open http://localhost:3000');
  assert.equal(b.code, 2);
  assert.match(b.err, /agent-browser is not used by this skill/);
  assert.equal(run({ tool_name: 'mcp__agent-browser__open', tool_input: {} }).code, 2);
  assert.equal(run({ tool_name: 'agent_browser_open', tool_input: {} }).code, 2);
});

test('userSaid finds only words the user typed, ignoring case, quotes and spacing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'said-'));
  mkdirSync(join(dir, 'cook'), { recursive: true });
  writeFileSync(join(dir, 'cook', '.ledger.jsonl'),
    JSON.stringify({ tool: 'UserPrompt', file: null, prompt: 'Ship it, it’s  GREAT.' }) + '\n'
    + JSON.stringify({ tool: 'Write', file: 'a.html', prompt: 'looks good to me' }) + '\n');
  assert.equal(userSaid(dir, 'ship it, it’s great.'), true);
  assert.equal(userSaid(dir, 'ship it'), true);
  assert.equal(userSaid(dir, 'looks good to me'), false, 'only UserPrompt lines count');
  assert.equal(userSaid(dir, 'never said'), false);
});

// ---------- redesign mode and the motion rules ----------
const STEP_IDS = ['0', '0b', '1', '2', '3', '4', '5', '6a', '6b', '7', '8'];
const stepsObj = (passedList) => Object.fromEntries(STEP_IDS.map((s) => [s, { status: passedList.includes(s) ? 'passed' : 'pending' }]));
const makeProj = (gates, dir = mkdtempSync(join(tmpdir(), 'redesign-'))) => {
  mkdirSync(join(dir, 'cook'), { recursive: true });
  writeFileSync(join(dir, 'cook', 'GATES.json'), JSON.stringify(gates));
  return dir;
};
const runIn = (dir, payload) => {
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: dir, session_id: 's2', hook_event_name: 'PreToolUse', ...payload }), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const redesignGates = (passedList, extra = {}) => ({
  mode: 'redesign', scope: { src: ['src'], exclude: ['src/legacy/**'] }, motion_allow: [], steps: stepsObj(passedList), ...extra,
});
const wr = (dir, file, content) => runIn(dir, { tool_name: 'Write', tool_input: { file_path: file, content } });
const ed = (dir, file, oldS, newS) => runIn(dir, { tool_name: 'Edit', tool_input: { file_path: file, old_string: oldS, new_string: newS } });

test('redesign: before step 5 only design files in scope are blocked', () => {
  const dir = makeProj(redesignGates(['0', '1', '2', '3', '4']));
  assert.equal(wr(dir, 'src/lib/validate.js', 'export const ok = (x) => !!x').code, 0, 'logic file is allowed');
  assert.equal(wr(dir, 'src/App.test.jsx', 'test("a", () => {})').code, 0, 'test file is allowed');
  assert.equal(wr(dir, 'src/__tests__/app.jsx', 'x').code, 0, '__tests__ is allowed');
  assert.equal(wr(dir, 'vite.config.js', 'export default {}').code, 0, 'config is allowed');
  assert.equal(wr(dir, 'server/api/contact.ts', 'export {}').code, 0, 'server and api folders are allowed');
  assert.equal(wr(dir, 'src/legacy/Old.jsx', '<h1>x</h1>').code, 0, 'excluded glob is allowed');
  assert.equal(wr(dir, 'cook/mockup/index.html', '<h1>x</h1>').code, 0, 'mockup is free');
  const app = wr(dir, 'src/App.jsx', '<h1>x</h1>');
  assert.equal(app.code, 2, 'a design file in scope is blocked before step 5');
  assert.match(app.err, /steps 2 to 5 \(mockup, bar, time, bans\) must pass before build code/);
  assert.match(app.err, /src\/App\.jsx/);
  const done = makeProj(redesignGates(['0', '1', '2', '3', '4', '5']));
  assert.equal(wr(done, 'src/App.jsx', '<h1>x</h1>').code, 0, 'allowed after step 5');
});

test('redesign: the root comes from file_path when cook/ sits in a sub-project', () => {
  const mono = mkdtempSync(join(tmpdir(), 'mono-'));
  const app = join(mono, 'apps', 'web');
  makeProj(redesignGates(['0', '1', '2', '3', '4']), app);
  const blocked = wr(mono, 'apps/web/src/App.jsx', '<h1>x</h1>');
  assert.equal(blocked.code, 2, 'the sub-project GATES.json is found from file_path');
  assert.match(blocked.err, /steps 2 to 5/);
  assert.equal(wr(mono, 'apps/web/cook/baseline/inventory.json', '{}').code, 2, 'protected file in the sub-project');
  assert.equal(wr(mono, 'apps/web/cook/baseline/KEEP.md', '## Keep').code, 0, 'KEEP.md stays editable');
  assert.equal(runIn(mono, { tool_name: 'Bash', tool_input: { command: 'ls' } }).code, 0, 'no GATES at the monorepo root: nothing to guard');
  assert.match(readFileSync(join(app, 'cook', '.ledger.jsonl'), 'utf8'), /"file":"cook\/baseline\/KEEP.md"/);
});

test('redesign: baseline files the scripts write are protected, KEEP.md and probes.json are not', () => {
  const dir = makeProj(redesignGates(['0']));
  for (const f of ['cook/baseline/inventory.json', 'cook/baseline/meta.json', 'cook/baseline/motion.json', 'cook/baseline/checks.json',
    'cook/baseline/slop.json', 'cook/baseline/audit-home.json', 'cook/baseline/stills/home-desktop.png', 'cook/judge/r01/.abkey.json',
    'cook/Baseline/Meta.json', 'COOK/JUDGE/R01/.ABKEY.JSON']) {
    assert.equal(wr(dir, f, '{}').code, 2, `${f} is blocked`);
  }
  assert.equal(wr(dir, 'cook/baseline/KEEP.md', '## Keep').code, 0, 'KEEP.md is allowed');
  assert.equal(wr(dir, 'cook/baseline/probes.json', '[]').code, 0, 'probes.json is allowed');
});

test('redesign: Bash reads of protected files are allowed, writes are not', () => {
  const dir = makeProj(redesignGates(['0']));
  const b = (command) => runIn(dir, { tool_name: 'Bash', tool_input: { command } });
  assert.equal(b('diff cook/reports/slop-baseline.json cook/reports/slop-r01.json').code, 0);
  assert.equal(b('cmp cook/baseline/inventory.json cook/baseline/stills/x.png').code, 0);
  assert.equal(b('cp cook/reports/a.json /tmp/x.json').code, 0, 'copy out is a read');
  assert.equal(b('cp cook/baseline/inventory.json ./backup.json').code, 0, 'copy out of the baseline is a read');
  assert.equal(b('cp /tmp/x.json cook/reports/a.json').code, 2, 'copy into cook/ is a write');
  assert.equal(b('cp /tmp/x.json cook/baseline/inventory.json').code, 2, 'copy into the baseline is a write');
  assert.equal(b('node /x/regress.mjs --out cook/reports/regress-r01.json').code, 0);
  assert.equal(b('node /x/baseline.mjs').code, 0);
  assert.equal(b('sed -i s/a/b/ cook/baseline/meta.json').code, 2, 'sed -i is a write');
  assert.equal(b('echo x > cook/baseline/motion.json').code, 2, 'redirect is a write');
  assert.equal(b('mv cook/baseline/stills/a.png /tmp/').code, 2, 'mv is blocked');
  assert.equal(b('rm cook/baseline/checks.json').code, 2, 'rm is blocked');
  assert.equal(b('diff a b > cook/baseline/slop.json').code, 2, 'diff with a redirect is a write');
});

test('redesign motion: an Edit that keeps an existing transition and changes a color is allowed, an added @keyframes is blocked', () => {
  const dir = makeProj(redesignGates(['0', '1', '2', '3', '4', '5']));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'card.css'), 'a {\n  transition: all 0.6s ease;\n  color: red;\n}\n');
  assert.equal(ed(dir, 'src/card.css', '  transition: all 0.6s ease;\n  color: red;', '  transition: all 0.6s ease;\n  color: blue;').code, 0,
    'the existing transition line is not new');
  const kf = ed(dir, 'src/card.css', 'color: red;', 'color: red;\n@keyframes spin { to { transform: rotate(360deg) } }');
  assert.equal(kf.code, 2, 'an added @keyframes is blocked in static');
  assert.match(kf.err, /static first/);
  assert.match(kf.err, /@keyframes spin/);
  assert.match(kf.err, new RegExp(`motion-allow src/card\\.css [0-9a-f]{12} --reason`));
  const multi = runIn(dir, { tool_name: 'MultiEdit', tool_input: { file_path: 'src/card.css', edits: [
    { old_string: 'color: red;', new_string: 'color: blue;' },
    { old_string: 'a {', new_string: 'a {\n  animation: spin 1s linear infinite;' },
  ] } });
  assert.equal(multi.code, 2, 'MultiEdit adding an animation is blocked');
  assert.equal(runIn(dir, { tool_name: 'MultiEdit', tool_input: { file_path: 'src/card.css', edits: [
    { old_string: 'color: red;', new_string: 'color: blue;' },
  ] } }).code, 0, 'MultiEdit that only changes a color is allowed');
  assert.equal(runIn(dir, { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'cook/mockup/a.ipynb', new_source: 'x = 1' } }).code, 0, 'NotebookEdit without motion');
});

test('redesign motion: a Write over a file with the same motion lines is allowed, a new motion line is blocked', () => {
  const dir = makeProj(redesignGates(['0', '1', '2', '3', '4', '5']));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'hero.css'), 'a { transition: transform .8s }\n.x { color: red }\n');
  assert.equal(wr(dir, 'src/hero.css', 'a { transition: transform .8s }\n.x { color: blue }\n').code, 0, 'same motion lines');
  assert.equal(wr(dir, 'src/hero.css', 'a { transition: transform .8s }\n@keyframes pulse { }\n').code, 2, 'a new keyframes line is blocked');
});

test('redesign motion: an allowed hash (motion_allow) can be added, only in its file', () => {
  const line = 'const o = new IntersectionObserver(cb)';
  const dir = makeProj(redesignGates(['0', '1', '2', '3', '4', '5'], {
    motion_allow: [{ file: 'src/hooks/useLazy.js', hash: lineHash(line), reason: 'lazy loading' }],
  }));
  assert.equal(wr(dir, 'src/hooks/useLazy.js', line).code, 0, 'the approved line is allowed in its file');
  assert.equal(wr(dir, 'src/other.js', line).code, 2, 'the same line in another file is still blocked');
});

test('redesign motion: after step 6a, motion is allowed; with motion none it is blocked again', () => {
  const dir = makeProj(redesignGates(['0', '1', '2', '3', '4', '5', '6a']));
  assert.equal(wr(dir, 'src/a.css', '@keyframes rise {}').code, 0, 'motion allowed after 6a');
  const none = makeProj(redesignGates(['0', '1', '2', '3', '4', '5', '6a'], { motion: 'none', motion_quote: 'no animation' }));
  assert.match(wr(none, 'src/a.css', '@keyframes rise {}').err, /chose no motion/);
});
