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
//     Existing motion lines may stay; motion_allow lists lines the user approved (functional motion).
//     Test files are not checked for motion
//   - blocks hand edits to files only the scripts write (GATES.json, PREFLIGHT.json, the ledger,
//     judge summaries, reports, baseline meta/inventory/motion/checks/slop/probecheck/audit/stills,
//     judge .abkey.json), rewrites of a judge file that exists, and removing or moving judge files
//   - blocks Bash that writes those files through a glob, cp -t, or a removal of cook/ itself,
//     and git clean -x / -X (cook/ is git-ignored)
//   - blocks agent-browser: this skill takes screenshots with shoot.mjs and checks with audit.mjs
//   - logs every call to cook/.ledger.jsonl (time, session, agent, tool, file, command), which
//     proves which session built and which one judged, and how long the work really took
// UserPromptSubmit: logs the user's words (gate.mjs checks quotes against them) and adds one line
//   with the current step, so the run stays on the steps, also after a context compaction.
//
// Exit 2 blocks the tool call; the message on stderr goes to Claude.
import { readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, relative, extname, isAbsolute } from 'node:path';
import { projectRoot, rootForFile, readJson, unallowedMotion, motionHits, lineHash, globToRe, STATE_DIR, FRONTEND_EXT, isDesignFile as isDesignFileShared, STEPS_NEW, STEPS_REDESIGN_ORDER, STEP_SHORT_NAMES } from './_common.mjs';

const PROTECTED = [
  /^cook\/GATES\.json$/i, /^cook\/PREFLIGHT\.json$/i, /^cook\/\.ledger\.jsonl$/i,
  /^cook\/judge\/[^/]+\/summary\.json$/i, /^cook\/reports\/[^/]+\.json$/i,
  // written by baseline.mjs only (cook/baseline/KEEP.md and probes.json stay agent-editable)
  /^cook\/baseline\/(meta|inventory|motion|checks|slop|probecheck)\.json$/i,
  /^cook\/baseline\/audit-[^/]*\.json$/i,
  /^cook\/baseline\/stills\/.+$/i,
  /^cook\/judge\/[^/]+\/\.abkey\.json$/i,
];
// A judge file is written once: a second Write or Edit to it is blocked. summary.json is the script's.
const JUDGE_FILE = /^cook\/judge\/[^/]+\/(?!summary\.json$)[^/]+\.json$/i;
// Bash segments that name a script-written file. Allowed only when they read it or a script runs.
const PROTECTED_NAMES = /GATES\.json|PREFLIGHT\.json|\.ledger\.jsonl|summary\.json|cook[\\/](judge|reports)\b|cook[\\/]baseline[\\/](meta|inventory|motion|checks|slop|probecheck)\.json|cook[\\/]baseline[\\/]audit-|cook[\\/]baseline[\\/]stills\b|\.abkey\.json/i;
const READ_OR_SCRIPT = /^(node\s+\S*(gate|preflight|slop_scan|audit|shoot|baseline|regress|pair)\.mjs\b|cat\b|head\b|tail\b|ls\b|grep\b|jq\b|wc\b|test\b|\[|diff\b|cmp\b)/;
const WRITE_BY_SCRIPTS = 'cook/GATES.json, PREFLIGHT.json, the ledger, judge summaries, reports and baseline files are written only by the scripts (gate.mjs, preflight.mjs, baseline.mjs, slop_scan.mjs, audit.mjs, shoot.mjs, regress.mjs, pair.mjs).';
const AGENT_BROWSER = /\bagent-browser\b/i;
const AGENT_BROWSER_TOOL = /agent[-_]browser/i;
const AGENT_BROWSER_MSG = 'agent-browser is not used by this skill: take screenshots with shoot.mjs and check pages with audit.mjs.';
const SKIP = /(^|\/)(node_modules|dist|build|\.next|\.astro|\.svelte-kit|\.git)\//;
// Test files may stub browser APIs (requestAnimationFrame, IntersectionObserver): no motion check.
const TEST_FILE = /(^|\/)[^/]*\.(test|spec)\.[^/]*$|(^|\/)__tests__\//i;

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
const readDisk = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

// ---------- Bash ----------

// A word of a command as a path: no redirect prefix, quotes, ./ or trailing slash.
const cleanTok = (t) => String(t).replace(/^[0-9&]*>+/, '').replace(/^["']|["']$/g, '').replace(/^\.\//, '').replace(/\/+$/, '');

// `cp` whose last argument is outside cook/: it only reads its sources. With -t the last
// argument is a source, so it is not a read.
const cpReadsOut = (seg) => {
  if (/(^|\s)(-[A-Za-z]*t|--target-directory)(\s|=|$)/.test(seg)) return false;
  const args = seg.split(/\s+/).slice(1).filter((a) => a && !a.startsWith('-'));
  return args.length >= 2 && !/(^|[\\/])cook([\\/]|$)/i.test(args[args.length - 1]);
};

// Every file under cook/, dotfiles included, as project-relative paths with forward slashes.
function cookFiles(root) {
  const out = [];
  const walkDir = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkDir(p);
      else out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walkDir(join(root, STATE_DIR));
  return out;
}

// A project-relative path that only the scripts write. A judge file counts once it exists.
const protectedPath = (rel, root) => PROTECTED.some((re) => re.test(rel)) || (JUDGE_FILE.test(rel) && existsSync(join(root, rel)));

// Brace and bracket parts of a shell glob, in the simple form globToRe reads: {a,b} gives one
// pattern per alternative, [..] matches one character.
function globForms(tok) {
  const m = tok.match(/\{([^{}]*,[^{}]*)\}/);
  if (m) return m[1].split(',').flatMap((alt) => globForms(tok.slice(0, m.index) + alt + tok.slice(m.index + m[0].length)));
  return [tok.replace(/\[[^\]]*\]/g, '?')];
}

// A glob under cook/ that matches a protected file on disk (`cook/.ledger.json?`, `cook/*.jsonl`).
// The shell expands a glob to existing files only, so the glob is tested against the files under
// cook/. Globs that match only ordinary files (`rm cook/shots/*.png`) are not hits.
function globHitsProtected(seg, root) {
  const toks = seg.split(/\s+/).map(cleanTok).filter((t) => /^cook\//.test(t) && /[*?[{]/.test(t));
  if (!toks.length) return false;
  const files = cookFiles(root);
  return toks.some((tok) => globForms(tok).some((form) => {
    const re = globToRe(form);
    return files.some((f) => re.test(f) && protectedPath(f, root));
  }));
}

// `cp -t DIR src...` and `cp --target-directory=DIR src...` write into DIR. Blocked when a copied
// name lands on a protected file under cook/ (`cp -t cook/ /tmp/GATES.json`).
function cpIntoProtected(seg, root) {
  const toks = seg.split(/\s+/).slice(1).filter(Boolean);
  const srcs = [];
  let dir = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '-t' || t === '--target-directory' || /^-[A-Za-z]*t$/.test(t)) dir = toks[++i] ?? null;
    else if (t.startsWith('--target-directory=')) dir = t.slice('--target-directory='.length);
    else if (!t.startsWith('-')) srcs.push(t);
  }
  const d = dir ? cleanTok(dir) : null;
  if (!d || !(d === STATE_DIR || d.startsWith(`${STATE_DIR}/`))) return false;
  return srcs.some((s) => protectedPath(`${d}/${cleanTok(s).split('/').pop()}`, root));
}

// The reason a Bash command must not run, or null. Checked per segment, so a write hidden
// behind `cd` or `&&` is still seen. `2>&1` and `2>/dev/null` are not writes to a file.
function bashProblem(cmd, root) {
  const segs = cmd.replace(/2>&1|2>\/dev\/null/g, '').split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segs) {
    const args = seg.split(/\s+/).filter(Boolean);
    if (/^(rm|mv)\b/.test(seg) && /cook[\\/]judge\b/i.test(seg)) return 'judge files are written once: they are never removed or moved.';
    if (/^touch\b/.test(seg) && /cook[\\/]/i.test(seg)) return 'files under cook/ are dated by the scripts: do not touch them.';
    if (args[0] === 'git' && args[1] === 'clean' && args.slice(2).some((a) => /^-[^-]*[xX]/.test(a))) {
      return 'git clean -x and -X remove git-ignored files, and cook/ is git-ignored: the ledger, the baseline and the stills would go. Use git clean without x.';
    }
    if (args[0] === 'rm' && args.slice(1).some((a) => !a.startsWith('-') && cleanTok(a) === STATE_DIR)) {
      return 'cook/ is the frontend-cook state folder (ledger, baseline, stills, reports): do not remove it. To start over, move it aside (mv cook cook-archive/<date>), as the restart steps say.';
    }
    if (args[0] === 'cp' && cpIntoProtected(seg, root)) return WRITE_BY_SCRIPTS;
    if (PROTECTED_NAMES.test(seg) || globHitsProtected(seg, root)) {
      const readOnly = !seg.includes('>') && (READ_OR_SCRIPT.test(seg) || (/^cp\s/.test(seg) && cpReadsOut(seg)));
      if (!readOnly) return WRITE_BY_SCRIPTS;
    }
  }
  return null;
}

if (input.hook_event_name === 'UserPromptSubmit') {
  log('UserPrompt', null, { prompt: String(input.prompt || '').slice(0, 4000) });
  const order = g.mode === 'redesign' ? STEPS_REDESIGN_ORDER : STEPS_NEW;
  const next = order.find((s) => !passed(s));
  console.log(next
    ? `[frontend-cook] Current step: ${next} (${STEP_SHORT_NAMES[next]}). Before working on it run gate.mjs check ${next}; it is done only when gate.mjs verify ${next} passes.`
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
  const why = bashProblem(cmd, root);
  if (why) block(why);
  log('Bash', null, { cmd: cmd.slice(0, 300) });
  process.exit(0);
}

// ---------- file tools ----------

if (!fileArg) process.exit(0);
const abs = isAbsolute(fileArg) ? fileArg : resolve(cwd, fileArg);
const rel = relative(root, abs).split('\\').join('/');
if (rel.startsWith('..')) process.exit(0); // outside the project

// The text an edit puts into the file. The design check reads it with the content on disk.
const newText = () => {
  if (tool === 'Write') return typeof ti.content === 'string' ? ti.content : '';
  if (tool === 'Edit') return typeof ti.new_string === 'string' ? ti.new_string : '';
  if (tool === 'MultiEdit') return (Array.isArray(ti.edits) ? ti.edits : []).map((e) => e.new_string || '').join('\n');
  return '';
};
const isDesignFile = (r) => isDesignFileShared(r, g, `${readDisk(abs)}\n${newText()}`);

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
    before = readDisk(abs);
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
  // The whole line (motionHits keeps 160 characters), so the --text form stores the right hash.
  const lines = after.split('\n');
  return added.map((h) => ({ ...h, full: lines.find((l) => lineHash(l) === h.hash)?.trim() ?? h.text }));
}

// One argument, quoted for the shell (single quotes, an apostrophe written as '\'').
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

const ext = extname(rel).toLowerCase();
const isFrontend = FRONTEND_EXT.includes(ext) && !SKIP.test(rel);
const inMockup = rel.startsWith('cook/mockup/');
const inRefs = rel.startsWith('cook/refs/');

if (PROTECTED.some((re) => re.test(rel))) {
  block(`${rel} is written only by the scripts. Use gate.mjs (approve, set-bar, score, ...) or rerun the check that produces it.`);
}
if (JUDGE_FILE.test(rel) && existsSync(abs)) {
  block(`${rel} is a judge file and is written once: add another judge or start a new round.`);
}

if (!passed('5') && isDesignFile(rel)) {
  block(`steps 2 to 5 (mockup, bar, time, bans) must pass before build code. (${rel})`);
}

if ((isFrontend || tool === 'NotebookEdit') && !inRefs && !TEST_FILE.test(rel)) {
  const staticStage = inMockup || !passed('6a') || g.motion === 'none';
  if (staticStage) {
    const added = addedMotion(abs, rel, ext);
    if (added.length) {
      const first = added[0];
      // The hash form needs the line to be in the file already (gate.mjs motion-allow checks that).
      const onDisk = motionHits(readDisk(abs), ext).some((h) => h.hash === first.hash);
      const how = onDisk
        ? `For functional motion (spinners, lazy loading), ask the user, then run gate.mjs motion-allow ${rel} ${first.hash} --reason "..." --quote "<the user's words>".`
        : `For functional motion (spinners, lazy loading), ask the user, then run gate.mjs motion-allow ${rel} --text ${shellQuote(first.full)} --reason "..." --quote "<the user's words>" (the line is new: its hash is stored before the line exists).`;
      if (g.motion === 'none') {
        block(`the user chose no motion ("${g.motion_quote}"). "${first.text}" is animation code. ${how} (${rel})`);
      }
      block(`static first: this change adds animation code ("${first.text}") before step 6a passed. Hover and focus transitions are fine, and existing motion may stay. ${how} (${rel})`);
    }
  }
}

log(tool, rel);
process.exit(0);
