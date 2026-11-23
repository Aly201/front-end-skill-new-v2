#!/usr/bin/env node
// Checks everything frontend-cook needs, and with --install adds what is missing.
//
// Usage: node preflight.mjs [--install] [--write] [--json] [--skip-browser]
//   --install   install the cook skill, add the Inspo and Awwwards MCP servers and the guard hook
//   --write     save the result to cook/PREFLIGHT.json (the gate for step 1 reads it)
//   --json      print JSON only
//
// Exit code 0 only when every required check passes.
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findSkill, loadPlaywright, loadPackage, cookIgnoreText, LOCAL_FILES, COOK_IGNORE_LINE, launchBrowser, homeDir, STATE_DIR } from './_common.mjs';

const args = new Set(process.argv.slice(2));
const INSTALL = args.has('--install');
const WRITE = args.has('--write');
const JSON_ONLY = args.has('--json');
const cwd = process.cwd();

const MCPS = {
  inspo: {
    match: (name, cfg) => /inspo/i.test(name) || /inspomcp\.dev|inspo-mcp/i.test(JSON.stringify(cfg || {})),
    claudeAdd: ['mcp', 'add', '-s', 'user', '--transport', 'http', 'inspo', 'https://inspomcp.dev/api/mcp'],
    json: { type: 'http', url: 'https://inspomcp.dev/api/mcp' },
    why: '832 real production sites with captures, palettes, type ramps and DESIGN.md files',
  },
  awwwards: {
    match: (name, cfg) => /awwwards/i.test(name) || /awwwards-mcp/i.test(JSON.stringify(cfg || {})),
    claudeAdd: ['mcp', 'add', '-s', 'user', 'awwwards', '--', 'npx', '-y', 'awwwards-mcp'],
    json: { command: 'npx', args: ['-y', 'awwwards-mcp'] },
    why: 'award-winning sites from Awwwards with design DNA, elements and motion analysis',
  },
};

function run(cmd, argv, timeout = 180000) {
  // On Windows, npx/npm/claude are .cmd shims and need a shell to run.
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout, cwd, shell: process.platform === 'win32' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: r.error?.code === 'ENOENT' };
}

// Every MCP server Claude Code can use in this project: ~/.claude.json (user and local scope) and .mcp.json.
function configuredMcps() {
  const found = {};
  const add = (name, cfg, where) => { found[name] = { cfg, where }; };
  const claudeJson = join(homeDir(), '.claude.json');
  try {
    const j = JSON.parse(readFileSync(claudeJson, 'utf8'));
    for (const [n, c] of Object.entries(j.mcpServers || {})) add(n, c, '~/.claude.json (user)');
    for (const [p, proj] of Object.entries(j.projects || {})) {
      const norm = (s) => s.replace(/\\/g, '/');
      if (norm(cwd) === norm(p) || norm(cwd).startsWith(norm(p) + '/')) {
        for (const [n, c] of Object.entries(proj.mcpServers || {})) add(n, c, '~/.claude.json (local)');
      }
    }
  } catch { /* none */ }
  try {
    const j = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'));
    for (const [n, c] of Object.entries(j.mcpServers || {})) add(n, c, '.mcp.json (project)');
  } catch { /* none */ }
  return found;
}

// MCP servers configured for Codex only. Reported for information: Claude Code cannot use them.
function codexMcps() {
  const found = {};
  try {
    const t = readFileSync(join(homeDir(), '.codex', 'config.toml'), 'utf8');
    for (const m of t.matchAll(/^\[mcp_servers\.([^\]]+)\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)) found[m[1]] = { cfg: m[2], where: '~/.codex/config.toml' };
  } catch { /* none */ }
  return found;
}

function findMcp(key, all) {
  for (const [name, { cfg, where }] of Object.entries(all)) if (MCPS[key].match(name, cfg)) return { name, where };
  return null;
}

async function checkBrowser() {
  if (args.has('--skip-browser')) return { ok: false, detail: 'skipped (--skip-browser)' };
  const pw = loadPlaywright(cwd);
  if (!pw) return { ok: false, detail: 'Playwright not found. Install it in the project: npm i -D playwright && npx playwright install chromium' };
  try {
    const { browser, executablePath } = await launchBrowser(pw);
    const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
    await page.setContent('<p style="font:16px sans-serif">ok</p>');
    const shot = await page.screenshot();
    await browser.close();
    return { ok: shot.length > 100, detail: `Playwright + Chromium (${executablePath}) took a test screenshot` };
  } catch (e) { return { ok: false, detail: String(e.message) }; }
}

const result = { checked_at: new Date().toISOString(), cwd, checks: {}, installed: [], notes: [], warnings: [] };
const C = result.checks;

// Node
const major = Number(process.versions.node.split('.')[0]);
C.node = { ok: major >= 18, detail: `Node ${process.versions.node} (needs 18+)` };

// ffmpeg (cook's side-by-side script needs it)
const ff = run('ffmpeg', ['-version'], 15000);
C.ffmpeg = { ok: ff.ok, detail: ff.ok ? ff.out.split('\n')[0] : 'ffmpeg not on PATH. Install it (macOS: brew install ffmpeg, Debian/Ubuntu: apt install ffmpeg, Windows: winget install ffmpeg)' };

// cook skill
let cook = findSkill('cook', cwd);
if (!cook && INSTALL) {
  const r = run('npx', ['-y', 'skills', 'add', 'Leonxlnx/cook', '-g', '-y', '-a', 'claude-code']);
  result.installed.push({ what: 'cook skill', ok: r.ok, command: 'npx -y skills add Leonxlnx/cook -g -y -a claude-code', out: r.out.slice(-400) });
  cook = findSkill('cook', cwd);
}
C.cook = {
  ok: Boolean(cook && existsSync(join(cook, 'scripts', 'side-by-side.mjs'))),
  path: cook,
  detail: cook ? `cook skill at ${cook}` : 'cook skill not installed. Run: npx skills add Leonxlnx/cook -g',
};

// MCP servers
let mcps = configuredMcps();
for (const key of Object.keys(MCPS)) {
  let hit = findMcp(key, mcps);
  if (!hit && INSTALL) {
    const r = run('claude', MCPS[key].claudeAdd, 30000);
    if (r.ok) {
      result.installed.push({ what: `${key} MCP`, ok: true, command: `claude ${MCPS[key].claudeAdd.join(' ')}` });
    } else {
      // No Claude Code CLI: write a project .mcp.json entry instead.
      const p = join(cwd, '.mcp.json');
      const j = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
      j.mcpServers = { ...(j.mcpServers || {}), [key]: MCPS[key].json };
      writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
      result.installed.push({ what: `${key} MCP`, ok: true, command: `wrote ${key} to .mcp.json`, note: r.missing ? 'claude CLI not found' : r.out.slice(-300) });
    }
    mcps = configuredMcps();
    hit = findMcp(key, mcps);
    result.notes.push(`${key} MCP was just added. Its tools load in a NEW session: restart Claude Code (or run /mcp) before step 1.`);
  }
  C[`mcp_${key}`] = {
    ok: Boolean(hit),
    name: hit?.name,
    detail: hit ? `${key} MCP configured as "${hit.name}" in ${hit.where}`
      : findMcp(key, codexMcps())
        ? `${key} MCP is configured for Codex only (~/.codex/config.toml); Claude Code cannot use that. Run: claude ${MCPS[key].claudeAdd.join(' ')}`
        : `${key} MCP not configured (${MCPS[key].why}). Run: claude ${MCPS[key].claudeAdd.join(' ')}`,
  };
}

// Guard hook in the project's .claude/settings.json: enforces mockup-first and static-first,
// protects script-written files and logs activity for the separate-judge and time checks.
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs');
const guardCmd = `node "${GUARD}"`;
const settingsPath = join(cwd, '.claude', 'settings.json');
function hookState() {
  let j = {};
  try {
    j = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  } catch {
    return { j, invalid: true, ok: false };
  }
  // Matchers (or UserPromptSubmit entries) that hold the guard command.
  const guardMatchers = (ev) => (j.hooks?.[ev] || []).filter((m) => (m.hooks || []).some((h) => h.command === guardCmd));
  const pres = guardMatchers('PreToolUse');
  const pre = pres[0];
  // A matcher without Read, Glob or Grep is an older install: it is outdated and --install upgrades it.
  const needTools = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Read', 'Glob', 'Grep'];
  const matcherOk = Boolean(pre && needTools.every((t) => new RegExp(`(^|\\|)${t}(\\||$)`).test(pre.matcher || '')) && /mcp__/.test(pre.matcher));
  // Exactly one guard entry per event: duplicates are cleaned up by --install.
  const single = pres.length === 1 && guardMatchers('UserPromptSubmit').length === 1;
  const present = pres.length > 0 || guardMatchers('UserPromptSubmit').length > 0;
  return { j, invalid: false, present, ok: pres.length > 0 && guardMatchers('UserPromptSubmit').length > 0 && matcherOk && single && existsSync(GUARD) };
}
let hs = hookState();
if (hs.invalid && INSTALL) {
  result.installed.push({ what: 'guard hook', ok: false, command: `not changed: ${settingsPath} is not valid JSON` });
}
if (!hs.ok && !hs.invalid && INSTALL) {
  const j = hs.j;
  j.hooks = j.hooks || {};
  // Drop stale frontend-cook entries (e.g. from an old install path), then add ours.
  for (const ev of ['PreToolUse', 'UserPromptSubmit']) {
    j.hooks[ev] = (j.hooks[ev] || []).map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => h.command !== guardCmd && !/frontend-cook[\\/]scripts[\\/]guard\.mjs/.test(h.command || '')) })).filter((m) => m.hooks.length);
  }
  j.hooks.PreToolUse.push({ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|Read|Glob|Grep|mcp__.*', hooks: [{ type: 'command', command: guardCmd }] });
  j.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: guardCmd }] });
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(j, null, 2) + '\n');
  result.installed.push({ what: 'guard hook', ok: true, command: `added to ${settingsPath}` });
  result.notes.push('The guard hook was just added to .claude/settings.json. Hooks load at session start: restart Claude Code (or review it in /hooks).');
  hs = hookState();
}
C.guard_hook = {
  ok: hs.ok,
  detail: hs.invalid
    ? `settings.json is not valid JSON (${settingsPath}). Fix or remove it, then run preflight.mjs --install again`
    : hs.ok ? `guard hook active in .claude/settings.json (${GUARD})`
      : hs.present ? 'guard hook is outdated or duplicated in .claude/settings.json (its matcher lacks Read, Glob or Grep, or it appears twice). Run preflight.mjs --install to upgrade it'
      : 'guard hook not installed in this project. Run preflight.mjs --install (it adds PreToolUse and UserPromptSubmit hooks to .claude/settings.json)',
};

// .gitignore: cook/ is shared through git (references, gates, judges, STATUS.md), so every agent on every computer
// sees the same state. Only what belongs to one computer stays out: the prompt log (it holds every prompt typed),
// the preflight result and the checkout id. A failure, not a warning, when the prompt log could be committed or
// already is. With --install, these lines are added, and the old whole-folder line `cook/` (1.6.0 and before) is
// replaced. Tracked local files are reported, never untracked automatically.
function checkGitignore() {
  if (!run('git', ['rev-parse', '--is-inside-work-tree'], 15000).ok) {
    return { ok: true, detail: 'not a git repository, nothing to ignore' };
  }
  const isIgnored = (f) => run('git', ['check-ignore', '-q', '--no-index', f], 15000).ok;
  const localIgnored = () => LOCAL_FILES.every(isIgnored);
  const shared = () => !isIgnored('cook/GATES.json');
  const tracked = () => run('git', ['ls-files', '--', ...LOCAL_FILES], 15000).out.split('\n').filter(Boolean);
  const trackedMsg = (t) => `${t.join(', ')} ${t.length > 1 ? 'are' : 'is'} already committed: git keeps tracking ${t.length > 1 ? 'them' : 'it'} even when ignored. Run: git rm --cached ${t.join(' ')} && git commit`;
  const verdict = () => {
    const t = tracked();
    if (t.length) return { ok: false, detail: trackedMsg(t) };
    if (!shared()) return { ok: false, detail: 'cook/ is git-ignored as a whole, so other agents and computers cannot see the references or the status. Run preflight.mjs --install to ignore only the local files' };
    return { ok: true, detail: 'cook/ is shared through git; the prompt log, the preflight result and cook/.checkout stay on this computer' };
  };
  if (localIgnored() && (shared() || !INSTALL)) return verdict();
  if (INSTALL) {
    const gi = join(cwd, '.gitignore');
    const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    const text = cookIgnoreText(cur);
    if (text !== cur) {
      writeFileSync(gi, text);
      result.installed.push({ what: '.gitignore', ok: true, command: `${cur.split(/\r?\n/).some((l) => COOK_IGNORE_LINE.test(l.trim())) ? 'replaced the whole-folder cook/ line with' : 'added'} ${LOCAL_FILES.join(', ')} in ${gi}` });
    }
    if (localIgnored()) return verdict();
  }
  return { ok: false, detail: `the prompt log could be committed: ${LOCAL_FILES.filter((f) => !isIgnored(f)).join(', ')} not git-ignored. Run preflight.mjs --install` };
}
// Public repository: committing cook/ publishes the reference screenshots (other people's sites). A warning:
// make the repository private before committing cook/.
function checkPublicRepo() {
  const url = run('git', ['remote', 'get-url', 'origin'], 15000);
  const m = url.ok && url.out.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/);
  if (!m) return null;
  const r = run('curl', ['-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '-w', '%{http_code}', '--max-time', '8', `https://api.github.com/repos/${m[1]}/${m[2]}`], 15000);
  if (r.ok && r.out.trim() === '200') return `the GitHub repository ${m[1]}/${m[2]} is public: committing cook/ would publish the reference screenshots (other people's sites). Make it private before you commit cook/`;
  return null;
}
C.gitignore = checkGitignore();
if (C.gitignore.warn) result.warnings.push(C.gitignore.detail);
const publicWarn = args.has('--offline') ? null : checkPublicRepo();
if (publicWarn) { result.warnings.push(publicWarn); result.public_repo = true; }

// Project folder: Claude Code loads a nested .claude/settings.json only from the folder it starts in, so a
// session started in a parent folder runs without the guard hook. A warning only: it never makes result.ok false.
function checkProjectFolder() {
  const top = run('git', ['rev-parse', '--show-toplevel'], 15000);
  if (!top.ok || !top.out) return null;
  const gitRoot = top.out.split(/\r?\n/)[0].trim();
  const real = (p) => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };
  if (real(gitRoot) === real(cwd)) return null;
  return `start Claude Code in the project folder: the git root is ${gitRoot} and this run is in ${cwd}. A nested .claude/settings.json is not loaded from a parent folder`;
}
const projectWarn = checkProjectFolder();
if (projectWarn) result.warnings.push(projectWarn);

// Browser: with --install, add Playwright and Chromium under ~/.frontend-cook when no Playwright is found.
if (INSTALL && !args.has('--skip-browser') && !loadPlaywright(cwd)) {
  const dir = join(homeDir(), '.frontend-cook');
  mkdirSync(dir, { recursive: true });
  const pw = run('npm', ['i', '--prefix', dir, 'playwright'], 300000);
  result.installed.push({ what: 'Playwright', ok: pw.ok, command: `npm i --prefix ${dir} playwright`, out: pw.out.slice(-400) });
  const cr = run('npx', ['--prefix', dir, 'playwright', 'install', 'chromium'], 600000);
  result.installed.push({ what: 'Chromium', ok: cr.ok, command: `npx --prefix ${dir} playwright install chromium`, out: cr.out.slice(-400) });
}

// Browser for stills, audits and motion recordings (re-checked after any install above)
C.browser = await checkBrowser();

// Script judge (judge.mjs, any platform): the Claude API SDK, and credentials. Reported, never a failure:
// in Claude Code a separate session can judge instead.
if (INSTALL && !loadPackage('@anthropic-ai/sdk', cwd)) {
  const dir = join(homeDir(), '.frontend-cook');
  mkdirSync(dir, { recursive: true });
  const sdk = run('npm', ['i', '--prefix', dir, '@anthropic-ai/sdk'], 300000);
  result.installed.push({ what: 'Claude API SDK (for judge.mjs)', ok: sdk.ok, command: `npm i --prefix ${dir} @anthropic-ai/sdk`, out: sdk.out.slice(-400) });
}
{
  const hasSdk = Boolean(loadPackage('@anthropic-ai/sdk', cwd));
  const hasCreds = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  result.judge = { sdk: hasSdk, credentials: hasCreds };
  if (!hasSdk || !hasCreds) {
    result.warnings.push(`script judge (judge.mjs) not ready: ${!hasSdk ? 'the @anthropic-ai/sdk package is missing (preflight --install adds it)' : ''}${!hasSdk && !hasCreds ? '; ' : ''}${!hasCreds ? 'no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in this environment (an `ant auth login` profile may still work; the user sets keys in their own environment, never in chat or a tracked file)' : ''}. Outside Claude Code this is the only separate judge`);
  }
}

result.ok = Object.values(C).every((c) => c.ok);
result.next = result.ok
  ? (result.notes.length ? 'Restart the session so the new MCP tools load, then run /frontend-cook.' : 'All set. Run /frontend-cook.')
  : 'Fix the failed checks above (or rerun with --install), then run this again.';

if (WRITE) {
  mkdirSync(join(cwd, STATE_DIR), { recursive: true });
  writeFileSync(join(cwd, STATE_DIR, 'PREFLIGHT.json'), JSON.stringify(result, null, 2) + '\n');
}

if (JSON_ONLY) console.log(JSON.stringify(result, null, 2));
else {
  for (const [k, c] of Object.entries(C)) console.log(`${c.warn ? 'WARN' : c.ok ? 'PASS' : 'FAIL'}  ${k.padEnd(13)} ${c.detail}`);
  for (const i of result.installed) console.log(`${i.ok ? 'ADDED' : 'ERROR'} ${i.what}: ${i.command}`);
  for (const n of result.notes) console.log(`NOTE  ${n}`);
  for (const w of result.warnings) console.log(`WARN  ${w}`);
  console.log(`\n${result.ok ? 'READY' : 'NOT READY'}: ${result.next}`);
}
process.exit(result.ok ? 0 : 1);
