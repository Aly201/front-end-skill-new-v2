#!/usr/bin/env node
// Claude Code hook for frontend-cook. Installed into the project's .claude/settings.json by
// preflight.mjs --install. It does nothing in projects without cook/GATES.json.
//
// PreToolUse (Write, Edit, MultiEdit, NotebookEdit, Bash, mcp__*):
//   - the project root for a file tool is the folder that holds cook/GATES.json above the file
//     (rootForFile), so a sub-project works when the session starts in a monorepo root
//   - blocks design files before step 5 (mockup, bar, time, bans): markup and style files in the
//     redesign scope (or any frontend file when there is no scope). Logic files, tests, configs,
//     server and api folders, cook/mockup and cook/refs stay free
//   - blocks ADDED animation code in static stage (step 6a not passed, motion none, or cook/mockup).
//     Existing motion lines may stay; motion_allow lists lines the user approved (functional motion)
//   - blocks hand edits to files only the scripts write (GATES.json, PREFLIGHT.json, the ledger,
//     judge summaries, reports, baseline meta/inventory/motion/checks/slop/audit/stills, judge
//     .abkey.json), rewrites of a judge file that exists, and removing or moving judge files
//   - blocks agent-browser: this skill takes screenshots with shoot.mjs and checks with audit.mjs
//   - logs every call to cook/.ledger.jsonl (time, session, agent, tool, file, command), which
//     proves which session built and which one judged, and how long the work really took
// UserPromptSubmit: logs the user's words (gate.mjs checks quotes against them) and adds one line
//   with the current step, so the run stays on the steps, also after a context compaction.
//
// Exit 2 blocks the tool call; the message on stderr goes to Claude.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, extname, isAbsolute } from 'node:path';
import { projectRoot, rootForFile, readJson, unallowedMotion, globToRe, STATE_DIR, FRONTEND_EXT, isDesignFile as isDesignFileShared } from './_common.mjs';

const ORDER = ['0', '1', '2', '3', '4', '5', '6a', '6b', '7', '8'];
const NAMES = { 0: 'setup', 1: 'references', 2: 'mockup', 3: 'bar', 4: 'time', 5: 'bans', '6a': 'static build', '6b': 'motion', 7: 'feedback', 8: 'separate judge' };
const PROTECTED = [
  /^cook\/GATES\.json$/i, /^cook\/PREFLIGHT\.json$/i, /^cook\/\.ledger\.jsonl$/i,
  /^cook\/judge\/[^/]+\/summary\.json$/i, /^cook\/reports\/[^/]+\.json$/i,
  // written by baseline.mjs only (cook/baseline/KEEP.md and probes.json stay agent-editable)
  /^cook\/baseline\/(meta|inventory|motion|checks|slop)\.json$/i,
  /^cook\/baseline\/audit-[^/]*\.json$/i,
  /^cook\/baseline\/stills\/.+$/i,
  /^cook\/judge\/[^/]+\/\.abkey\.json$/i,
];
// A judge file is written once: a second Write or Edit to it is blocked. summary.json is the script's.
const JUDGE_FILE = /^cook\/judge\/[^/]+\/(?!summary\.json$)[^/]+\.json$/i;
// Bash segments that name a script-written file. Allowed only when they read it or a script runs.
const PROTECTED_NAMES = /GATES\.json|PREFLIGHT\.json|\.ledger\.jsonl|summary\.json|cook[\\/](judge|reports)\b|cook[\\/]baseline[\\/](meta|inventory|motion|checks|slop)\.json|cook[\\/]baseline[\\/]audit-|cook[\\/]baseline[\\/]stills\b|\.abkey\.json/i;
const READ_OR_SCRIPT = /^(node\s+\S*(gate|preflight|slop_scan|audit|shoot|baseline|regress|pair)\.mjs\b|cat\b|head\b|tail\b|ls\b|grep\b|jq\b|wc\b|test\b|\[|diff\b|cmp\b)/;
const AGENT_BROWSER = /\bagent-browser\b/i;
const AGENT_BROWSER_TOOL = /agent[-_]browser/i;
const AGENT_BROWSER_MSG = 'agent-browser is not used by this skill: take screenshots with shoot.mjs and check pages with audit.mjs.';
const SKIP = /(^|\/)(node_modules|dist|build|\.next|\.astro|\.svelte-kit|\.git)\//;

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const cwd = input.cwd || process.cwd();
const tool = input.tool_name || '';
const ti = input.tool_input || {};
const fileArg = typeof ti.file_path === 'string' ? ti.file_path : (typeof ti.notebook_path === 'string' ? ti.notebook_path : '');
const fileTool = Boolean(fileArg) && tool !== 'Bash' && !tool.startsWith('mcp__');
const root = fileTool ? rootForFile(fileArg, cwd) : projectRoot(cwd);
const gatesPath = join(root, STATE_DIR, 'GATES.json');
if (!existsSync(gatesPath)) process.exit(0);
const g = readJson(gatesPath, {});
const passed = (s) => ['passed', 'overridden'].includes(g.steps?.[s]?.status);
const block = (msg) => { process.stderr.write(`frontend-cook guard: ${msg}\n`); process.exit(2); };
const log = (toolName, file, extra = {}) => {
  try {
    appendFileSync(join(root, STATE_DIR, '.ledger.jsonl'), JSON.stringify({ at: new Date().toISOString(), session_id: input.session_id || null, tool: toolName, file, agent: input.agent_id || null, ...extra }) + '\n');
  } catch { /* never block on logging */ }
};

// `cp` whose last argument is outside cook/: it only reads its sources.
const cpReadsOut = (seg) => {
  const args = seg.split(/\s+/).slice(1).filter((a) => a && !a.startsWith('-'));
  return args.length >= 2 && !/(^|[\\/])cook([\\/]|$)/i.test(args[args.length - 1]);
};

// The reason a Bash command must not run, or null. Checked per segment, so a write hidden
// behind `cd` or `&&` is still seen. `2>&1` and `2>/dev/null` are not writes to a file.
function bashProblem(cmd) {
  const segs = cmd.replace(/2>&1|2>\/dev\/null/g, '').split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segs) {
    if (/^(rm|mv)\b/.test(seg) && /cook[\\/]judge\b/i.test(seg)) return 'judge files are written once: they are never removed or moved.';
    if (/^touch\b/.test(seg) && /cook[\\/]/i.test(seg)) return 'files under cook/ are dated by the scripts: do not touch them.';
    if (PROTECTED_NAMES.test(seg)) {
      const readOnly = !seg.includes('>') && (READ_OR_SCRIPT.test(seg) || (/^cp\s/.test(seg) && cpReadsOut(seg)));
      if (!readOnly) {
        return 'cook/GATES.json, PREFLIGHT.json, the ledger, judge summaries, reports and baseline files are written only by the scripts (gate.mjs, preflight.mjs, baseline.mjs, slop_scan.mjs, audit.mjs, shoot.mjs, regress.mjs, pair.mjs).';
      }
    }
  }
  return null;
}

// Design files: shared rule in _common.mjs (also used by the gate's verify 5 git check).
const isDesignFile = (rel) => isDesignFileShared(rel, g);

// Motion lines the edit adds: unallowed hits in the new text that are not in the old text,
// counted per hash. Edit compares old_string with new_string, MultiEdit all edits combined,
// Write the new content with the file on disk, NotebookEdit new_source with nothing.
function addedMotion(abs, rel, ext) {
  const allow = Array.isArray(g.motion_allow) ? g.motion_allow : [];
  let before = '';
  let after = '';
  if (tool === 'Edit') {
    before = ti.old_string || '';
    after = ti.new_string || '';
  } else if (tool === 'MultiEdit') {
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    before = edits.map((e) => e.old_string || '').join('\n');
    after = edits.map((e) => e.new_string || '').join('\n');
  } else if (tool === 'Write') {
    after = typeof ti.content === 'string' ? ti.content : '';
    try { before = readFileSync(abs, 'utf8'); } catch { before = ''; }
  } else if (tool === 'NotebookEdit') {
    after = typeof ti.new_source === 'string' ? ti.new_source : '';
  } else {
    after = [ti.content, ti.new_string, ti.new_source, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string) : [])]
      .filter((x) => typeof x === 'string').join('\n');
  }
  const seen = new Map();
  for (const h of unallowedMotion(before, ext, rel, allow)) seen.set(h.hash, (seen.get(h.hash) || 0) + 1);
  const added = [];
  for (const h of unallowedMotion(after, ext, rel, allow)) {
    const n = seen.get(h.hash) || 0;
    if (n > 0) seen.set(h.hash, n - 1); else added.push(h);
  }
  return added;
}

if (input.hook_event_name === 'UserPromptSubmit') {
  log('UserPrompt', null, { prompt: String(input.prompt || '').slice(0, 4000) });
  const next = ORDER.find((s) => !passed(s));
  console.log(next
    ? `[frontend-cook] Current step: ${next} (${NAMES[next]}). Before working on it run gate.mjs check ${next}; it is done only when gate.mjs verify ${next} passes.`
    : '[frontend-cook] All steps passed.');
  process.exit(0);
}

if (AGENT_BROWSER_TOOL.test(tool)) block(AGENT_BROWSER_MSG);
if (tool.startsWith('mcp__')) {
  log(tool, null);
  process.exit(0);
}

if (tool === 'Bash') {
  const cmd = String(ti.command || '');
  if (AGENT_BROWSER.test(cmd)) block(AGENT_BROWSER_MSG);
  const why = bashProblem(cmd);
  if (why) block(why);
  log('Bash', null, { cmd: cmd.slice(0, 300) });
  process.exit(0);
}

if (!fileArg) process.exit(0);
const abs = isAbsolute(fileArg) ? fileArg : resolve(cwd, fileArg);
const rel = relative(root, abs).split('\\').join('/');
if (rel.startsWith('..')) process.exit(0); // outside the project

if (PROTECTED.some((re) => re.test(rel))) {
  block(`${rel} is written only by the scripts. Use gate.mjs (approve, set-bar, score, ...) or rerun the check that produces it.`);
}
if (JUDGE_FILE.test(rel) && existsSync(abs)) {
  block(`${rel} is a judge file and is written once: add another judge or start a new round.`);
}

const ext = extname(rel).toLowerCase();
const isFrontend = FRONTEND_EXT.includes(ext) && !SKIP.test(rel);
const inMockup = rel.startsWith('cook/mockup/');
const inRefs = rel.startsWith('cook/refs/');

if (!passed('5') && isDesignFile(rel)) {
  block(`steps 2 to 5 (mockup, bar, time, bans) must pass before build code. (${rel})`);
}

if ((isFrontend || tool === 'NotebookEdit') && !inRefs) {
  const staticStage = inMockup || !passed('6a') || g.motion === 'none';
  if (staticStage) {
    const added = addedMotion(abs, rel, ext);
    if (added.length) {
      const first = added[0];
      const how = `For functional motion (spinners, lazy loading), ask the user, then run gate.mjs motion-allow ${rel} ${first.hash} --reason "..." .`;
      if (g.motion === 'none') {
        block(`the user chose no motion ("${g.motion_quote}"). "${first.text}" is animation code. ${how} (${rel})`);
      }
      block(`static first: this change adds animation code ("${first.text}") before step 6a passed. Hover and focus transitions are fine, and existing motion may stay. ${how} (${rel})`);
    }
  }
}

log(tool, rel);
process.exit(0);
