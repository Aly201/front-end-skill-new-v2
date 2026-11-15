#!/usr/bin/env node
// Claude Code hook for frontend-cook. Installed into the project's .claude/settings.json by
// preflight.mjs --install. It does nothing in projects without cook/GATES.json.
//
// PreToolUse (Write, Edit, MultiEdit, NotebookEdit, Bash):
//   - blocks frontend code outside cook/ until step 2 (the mockup) passed: mockup first
//   - blocks animation code in the mockup and the build until step 6a passed: static first
//   - blocks hand edits to files only the scripts write (GATES.json, PREFLIGHT.json, the ledger,
//     judge summaries, reports)
//   - logs every call to cook/.ledger.jsonl (time, session, tool, file), which proves which
//     session built and which one judged, and how long the work really took
// UserPromptSubmit: adds one line with the current step, so the run stays on the steps,
//   also after a context compaction.
//
// Exit 2 blocks the tool call; the message on stderr goes to Claude.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, extname, isAbsolute } from 'node:path';
import { projectRoot, readJson, STATE_DIR, MOTION_CODE, FRONTEND_EXT } from './_common.mjs';

const ORDER = ['0', '1', '2', '3', '4', '5', '6a', '6b', '7', '8'];
const NAMES = { 0: 'setup', 1: 'references', 2: 'mockup', 3: 'bar', 4: 'time', 5: 'bans', '6a': 'static build', '6b': 'motion', 7: 'feedback', 8: 'separate judge' };
const PROTECTED = [/^cook\/GATES\.json$/, /^cook\/PREFLIGHT\.json$/, /^cook\/\.ledger\.jsonl$/, /^cook\/judge\/[^/]+\/summary\.json$/, /^cook\/reports\/[^/]+\.json$/];
const SKIP = /(^|\/)(node_modules|dist|build|\.next|\.astro|\.svelte-kit|\.git)\//;

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const cwd = input.cwd || process.cwd();
const root = projectRoot(cwd);
const gatesPath = join(root, STATE_DIR, 'GATES.json');
if (!existsSync(gatesPath)) process.exit(0);
const g = readJson(gatesPath, {});
const passed = (s) => ['passed', 'overridden'].includes(g.steps?.[s]?.status);
const block = (msg) => { process.stderr.write(`frontend-cook guard: ${msg}\n`); process.exit(2); };
const log = (tool, file) => {
  try { appendFileSync(join(root, STATE_DIR, '.ledger.jsonl'), JSON.stringify({ at: new Date().toISOString(), session_id: input.session_id || null, tool, file }) + '\n'); } catch { /* never block on logging */ }
};

if (input.hook_event_name === 'UserPromptSubmit') {
  const next = ORDER.find((s) => !passed(s));
  console.log(next
    ? `[frontend-cook] Current step: ${next} (${NAMES[next]}). Before working on it run gate.mjs check ${next}; it is done only when gate.mjs verify ${next} passes.`
    : '[frontend-cook] All steps passed.');
  process.exit(0);
}

const tool = input.tool_name || '';
const ti = input.tool_input || {};

if (tool === 'Bash') {
  const cmd = String(ti.command || '');
  if (/(>|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|\brm\b|\btruncate\b)[^|;&]*cook\/(GATES\.json|PREFLIGHT\.json|\.ledger\.jsonl|judge\/\S*summary\.json|reports\/)/.test(cmd)) {
    block('cook/GATES.json, PREFLIGHT.json, the ledger, judge summaries and reports are written only by the scripts (gate.mjs, preflight.mjs, slop_scan.mjs, audit.mjs).');
  }
  log('Bash', null);
  process.exit(0);
}

const fileArg = ti.file_path || ti.notebook_path;
if (!fileArg) process.exit(0);
const abs = isAbsolute(fileArg) ? fileArg : resolve(cwd, fileArg);
const rel = relative(root, abs).split('\\').join('/');
if (rel.startsWith('..')) process.exit(0); // outside the project

if (PROTECTED.some((re) => re.test(rel))) {
  block(`${rel} is written only by the scripts. Use gate.mjs (approve, set-bar, score, ...) or rerun the check that produces it.`);
}

const ext = extname(rel).toLowerCase();
const isFrontend = FRONTEND_EXT.includes(ext) && !SKIP.test(rel);
const inMockup = rel.startsWith('cook/mockup/');
const inState = rel.startsWith('cook/') && !inMockup;

if (isFrontend && !inState) {
  if (!inMockup && !passed('2')) {
    block(`step 2 (mockup) has not passed. Build the mockup in cook/mockup/ first and get it approved; the full build starts after that. (${rel})`);
  }
  const text = [ti.content, ti.new_string, ti.new_source, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string) : [])].filter((x) => typeof x === 'string').join('\n');
  const staticStage = inMockup || !passed('6a') || g.motion === 'none';
  const hit = text.match(MOTION_CODE);
  if (staticStage && hit) {
    block(g.motion === 'none'
      ? `the user chose no motion ("${g.motion_quote}"). "${hit[0]}" is animation code. (${rel})`
      : `static first: animation code ("${hit[0]}") waits until step 6a passed and the user approved the static design. Hover and focus transitions are fine. (${rel})`);
  }
}

log(tool, rel);
process.exit(0);
