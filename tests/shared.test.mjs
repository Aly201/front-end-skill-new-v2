// Several agents on several computers share one state through git: cook/STATUS.md, the AGENTS.md block,
// and cook/FILES.json, which keeps the real file times across a clone. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, appendFileSync, cpSync, rmSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { cookIgnoreText } from '../skills/frontend-cook/scripts/_common.mjs';

const SCRIPTS = resolve(import.meta.dirname, '..', 'skills', 'frontend-cook', 'scripts');
const run = (dir, script, args) => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: dir, encoding: 'utf8', input: '' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const gate = (d, ...a) => run(d, 'gate.mjs', a);
const write = (p, t) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t); };
function png(p, w = 1440, h = 900) {
  const b = Buffer.alloc(41);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  randomBytes(8).copy(b, 33);
  mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, b);
}
const at = (p, secondsAgo) => { const t = new Date(Date.now() - secondsAgo * 1000); utimesSync(p, t, t); };
function project() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-share-')));
  write(join(d, 'cook', 'PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  return d;
}
// "git clone" on another computer: same content, every file stamped now, no local files.
function cloneOf(d) {
  const c = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-clone-')));
  cpSync(d, c, { recursive: true, preserveTimestamps: false });
  for (const f of ['.ledger.jsonl', '.checkout']) rmSync(join(c, 'cook', f), { force: true });
  return c;
}

test('init writes the AGENTS.md block (and into CLAUDE.md when there is one), once', () => {
  const d = project();
  write(join(d, 'CLAUDE.md'), '# My project\n\nKeep this.\n');
  write(join(d, 'AGENTS.md'), '# Agents\n\nOur rules.\n');
  assert.equal(gate(d, 'init', '--project', 'Shared').code, 0);
  const a = readFileSync(join(d, 'AGENTS.md'), 'utf8');
  assert.match(a, /^# Agents\n\nOur rules\.\n/);
  assert.match(a, /<!-- frontend-cook:start -->[\s\S]*cook\/STATUS\.md[\s\S]*gate\.mjs next[\s\S]*<!-- frontend-cook:end -->/);
  assert.match(readFileSync(join(d, 'CLAUDE.md'), 'utf8'), /Keep this\.[\s\S]*frontend-cook:start/);
  // share again: the block is replaced in place, not added twice.
  assert.equal(gate(d, 'share').code, 0);
  assert.equal(readFileSync(join(d, 'AGENTS.md'), 'utf8').split('frontend-cook:start').length, 2);
});

test('STATUS.md has the step, the bar, the user decisions, the references and what is missing', () => {
  const d = project();
  assert.equal(gate(d, 'init', '--project', 'Rope').code, 0);
  write(join(d, 'cook', 'refs', 'SOURCES.md'), 'R01 | inspo | https://a.com/ | take: type\nR02 | user | https://b.com/ | take: color | industry: rope\n');
  appendFileSync(join(d, 'cook', '.ledger.jsonl'), JSON.stringify({ tool: 'UserTTY', prompt: 'I have none, find them for me please' }) + '\n');
  assert.equal(gate(d, 'no-user-refs', '--quote', 'I have none, find them for me').code, 0);
  const n = gate(d, 'next');
  assert.equal(n.code, 0, n.out);
  const s = readFileSync(join(d, 'cook', 'STATUS.md'), 'utf8');
  assert.match(s, /# Frontend Cook status: Rope/);
  assert.match(s, /Bar: judges 9\.2\/10/);
  assert.match(s, /\| 0 \| /);
  assert.match(s, /No references of their own: "I have none, find them for me"/);
  assert.match(s, /\| R01 \| inspo \| https:\/\/a\.com\/ \| take: type \|/);
  assert.match(s, /\| R02 \| user \| https:\/\/b\.com\/ \| take: color; industry: rope \|/);
  assert.match(s, /## Still missing for step/);
  assert.match(s, /One agent builds at a time/);
});

test('a clone keeps the real file times: an approval made on one computer still holds on another', () => {
  const d = project();
  assert.equal(gate(d, 'init', '--project', 'Clone').code, 0);
  write(join(d, 'cook', 'mockup', 'index.html'), '<h1>x</h1>'); at(join(d, 'cook', 'mockup', 'index.html'), 600);
  png(join(d, 'cook', 'stills', 'mockup', 'mockup-desktop.png'), 1440, 2000); at(join(d, 'cook', 'stills', 'mockup', 'mockup-desktop.png'), 300);
  png(join(d, 'cook', 'stills', 'mockup', 'mockup-mobile.png'), 780, 3000); at(join(d, 'cook', 'stills', 'mockup', 'mockup-mobile.png'), 300);
  appendFileSync(join(d, 'cook', '.ledger.jsonl'), JSON.stringify({ tool: 'UserTTY', prompt: 'yes this mockup feels right' }) + '\n');
  const a = gate(d, 'approve', 'mockup', '--quote', 'yes this mockup feels right');
  assert.equal(a.code, 0, a.out);
  assert.doesNotMatch(gate(d, 'verify', '2').out, /stills changed after the approval/);
  const files = JSON.parse(readFileSync(join(d, 'cook', 'FILES.json'), 'utf8')).files;
  assert.ok(files['cook/stills/mockup/mockup-desktop.png'], 'stills are recorded');
  assert.equal(files['cook/.ledger.jsonl'], undefined, 'the prompt log is never shared');
  assert.equal(files['cook/PREFLIGHT.json'], undefined);

  // Another computer: every file is stamped "now" by the checkout.
  const c = cloneOf(d);
  const v = gate(c, 'verify', '2').out;
  assert.doesNotMatch(v, /stills changed after the approval/, 'the recorded times hold on the clone');
  assert.match(v, /user approved mockup: "yes this mockup feels right"/);
  // A still really re-taken on the clone changes the content: now the approval is out of date.
  png(join(c, 'cook', 'stills', 'mockup', 'mockup-desktop.png'), 1440, 2000);
  assert.match(gate(c, 'verify', '2').out, /stills changed after the approval/);
  // Without FILES.json (what 1.6.0 did), the clone alone breaks the approval.
  const c2 = cloneOf(d);
  rmSync(join(c2, 'cook', 'FILES.json'));
  assert.match(gate(c2, 'verify', '2').out, /stills changed after the approval/);
});

test('the guard protects STATUS.md and FILES.json, and lets agents commit cook/', () => {
  const d = project();
  assert.equal(gate(d, 'init', '--project', 'G').code, 0);
  const hook = (input) => spawnSync(process.execPath, [join(SCRIPTS, 'guard.mjs')], { cwd: d, input: JSON.stringify({ session_id: 's', cwd: d, ...input }), encoding: 'utf8' }).status;
  assert.equal(hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(d, 'cook', 'STATUS.md'), content: 'all done' } }), 2);
  assert.equal(hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(d, 'cook', 'FILES.json'), old_string: 'a', new_string: 'b' } }), 2);
  assert.equal(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo x > cook/STATUS.md' } }), 2);
  assert.equal(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git add cook/STATUS.md cook/GATES.json && git commit -m "step 2"' } }), 0);
});

test('preflight: only the local files are ignored; the old whole-folder line is replaced', () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-gi-')));
  spawnSync('git', ['init', '-q'], { cwd: d });
  write(join(d, '.gitignore'), 'node_modules/\n\n# frontend-cook working state (contains logged prompts)\ncook/\n');
  const pf = (args) => spawnSync(process.execPath, [join(SCRIPTS, 'preflight.mjs'), '--json', '--skip-browser', '--offline', ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH } });
  const before = JSON.parse(pf([]).stdout);
  assert.equal(before.checks.gitignore.ok, false);
  assert.match(before.checks.gitignore.detail, /ignored as a whole/);
  // What --install writes: the whole-folder line and its comment replaced, every other line kept.
  const text = cookIgnoreText(readFileSync(join(d, '.gitignore'), 'utf8'));
  assert.equal(text, 'node_modules/\n\n# frontend-cook: local to this computer (the prompt log holds every prompt typed)\ncook/.ledger.jsonl\ncook/PREFLIGHT.json\ncook/.checkout\n');
  assert.equal(cookIgnoreText(text), text, 'running it again changes nothing');
  writeFileSync(join(d, '.gitignore'), text);
  const ok = JSON.parse(pf([]).stdout);
  assert.equal(ok.checks.gitignore.ok, true, ok.checks.gitignore.detail);
  // A committed prompt log is a failure.
  write(join(d, 'cook', '.ledger.jsonl'), '{}\n');
  spawnSync('git', ['add', '-f', 'cook/.ledger.jsonl'], { cwd: d });
  assert.match(JSON.parse(pf([]).stdout).checks.gitignore.detail, /already committed/);
});
