// The guard hook, fed the same JSON Claude Code sends it on stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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

test('does nothing in projects without frontend-cook', () => {
  const other = mkdtempSync(join(tmpdir(), 'other-'));
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: other, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(other, 'a.js'), content: '@keyframes x{}' } }), encoding: 'utf8' });
  assert.equal(r.status, 0);
});

test('mockup first, then static first, then motion', () => {
  setSteps(['0', '1']);
  assert.equal(write(join(proj, 'src/index.html'), '<h1>x</h1>').code, 2, 'build blocked before the mockup');
  assert.equal(write(join(proj, 'package.json'), '{}').code, 0, 'non-frontend files are fine');
  assert.equal(write('cook/mockup/index.html', '<h1>x</h1>').code, 0, 'static mockup allowed (relative path)');
  assert.equal(write('cook/mockup/index.html', '<style>@keyframes a{}</style>').code, 2, 'animated mockup blocked');
  setSteps(['0', '1', '2', '3', '4', '5']);
  assert.equal(write(join(proj, 'src/index.html'), '<h1>x</h1>').code, 0, 'build allowed after the mockup');
  const e = run({ tool_name: 'Edit', tool_input: { file_path: join(proj, 'src/app.jsx'), old_string: 'a', new_string: "import { motion } from 'framer-motion'" } });
  assert.equal(e.code, 2, 'animation in an Edit blocked during static');
  assert.match(e.err, /static first/);
  assert.equal(write(join(proj, 'src/a.css'), 'a { transition: color .2s }').code, 0, 'hover transitions allowed in static');
  setSteps(['0', '1', '2', '3', '4', '5', '6a']);
  assert.equal(write(join(proj, 'src/a.css'), '@keyframes rise {}').code, 0, 'motion allowed after 6a');
  setSteps(['0', '1', '2', '3', '4', '5', '6a'], { motion: 'none', motion_quote: 'no animation please' });
  assert.match(write(join(proj, 'src/a.css'), '@keyframes rise {}').err, /chose no motion/);
});

test('script-written files are protected, every call is logged', () => {
  setSteps(['0']);
  assert.equal(write('cook/GATES.json', '{}').code, 2);
  assert.equal(write('cook/judge/r01/summary.json', '{}').code, 2);
  assert.equal(write('cook/reports/audit-r01.json', '{}').code, 2);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: "echo '{}' > cook/GATES.json" } }).code, 2);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'node slop_scan.mjs src --out cook/reports/slop-r01.json' } }).code, 0, 'the scripts themselves may write reports');
  assert.equal(write('cook/judge/r01/judge-a.json', '{}').code, 0, 'judges write their own files');
  const ledger = readFileSync(join(proj, 'cook', '.ledger.jsonl'), 'utf8');
  assert.match(ledger, /"session_id":"s1","tool":"Write","file":"cook\/judge\/r01\/judge-a.json"/);
});

test('every prompt gets the current step', () => {
  setSteps(['0', '1']);
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: proj, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Current step: 2 \(mockup\)/);
});
