#!/usr/bin/env node
// Checks everything frontend-cook needs, and with --install adds what is missing.
//
// Usage: node preflight.mjs [--install] [--write] [--json] [--skip-browser]
//   --install   install the cook skill, add the Inspo and Awwwards MCP servers and the guard hook
//   --write     save the result to cook/PREFLIGHT.json (the gate for step 1 reads it)
//   --json      print JSON only
//
// Exit code 0 only when every required check passes.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findSkill, loadPlaywright, launchBrowser, homeDir, STATE_DIR } from './_common.mjs';

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
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout, cwd });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: r.error?.code === 'ENOENT' };
}

// Every MCP server configured for this project, from Claude Code, Codex and .mcp.json.
function configuredMcps() {
  const found = {};
  const add = (name, cfg, where) => { found[name] = { cfg, where }; };
  const claudeJson = join(homeDir(), '.claude.json');
  try {
    const j = JSON.parse(readFileSync(claudeJson, 'utf8'));
    for (const [n, c] of Object.entries(j.mcpServers || {})) add(n, c, '~/.claude.json (user)');
    for (const [p, proj] of Object.entries(j.projects || {})) {
      if (cwd === p || cwd.startsWith(p + '/')) {
        for (const [n, c] of Object.entries(proj.mcpServers || {})) add(n, c, '~/.claude.json (local)');
      }
    }
  } catch { /* none */ }
  try {
    const j = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'));
    for (const [n, c] of Object.entries(j.mcpServers || {})) add(n, c, '.mcp.json (project)');
  } catch { /* none */ }
  try {
    const t = readFileSync(join(homeDir(), '.codex', 'config.toml'), 'utf8');
    for (const m of t.matchAll(/^\[mcp_servers\.([^\]]+)\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)) add(m[1], m[2], '~/.codex/config.toml');
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

const result = { checked_at: new Date().toISOString(), cwd, checks: {}, installed: [], notes: [] };
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
    detail: hit ? `${key} MCP configured as "${hit.name}" in ${hit.where}` : `${key} MCP not configured (${MCPS[key].why}). Run: claude ${MCPS[key].claudeAdd.join(' ')}`,
  };
}

// Guard hook in the project's .claude/settings.json: enforces mockup-first and static-first,
// protects script-written files and logs activity for the separate-judge and time checks.
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs');
const guardCmd = `node "${GUARD}"`;
const settingsPath = join(cwd, '.claude', 'settings.json');
function hookState() {
  const j = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const has = (ev) => (j.hooks?.[ev] || []).some((m) => (m.hooks || []).some((h) => h.command === guardCmd));
  const pre = (j.hooks?.PreToolUse || []).find((m) => (m.hooks || []).some((h) => h.command === guardCmd));
  const matcherOk = Boolean(pre && ['Write', 'Edit', 'MultiEdit', 'Bash'].every((t) => new RegExp(`(^|\\|)${t}(\\||$)`).test(pre.matcher || '')));
  return { j, ok: has('PreToolUse') && has('UserPromptSubmit') && matcherOk && existsSync(GUARD) };
}
let hs = hookState();
if (!hs.ok && INSTALL) {
  const j = hs.j;
  j.hooks = j.hooks || {};
  // Drop stale frontend-cook entries (e.g. from an old install path), then add ours.
  for (const ev of ['PreToolUse', 'UserPromptSubmit']) {
    j.hooks[ev] = (j.hooks[ev] || []).map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !/frontend-cook[\\/]scripts[\\/]guard\.mjs/.test(h.command || '')) })).filter((m) => m.hooks.length);
  }
  j.hooks.PreToolUse.push({ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: guardCmd }] });
  j.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: guardCmd }] });
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(j, null, 2) + '\n');
  result.installed.push({ what: 'guard hook', ok: true, command: `added to ${settingsPath}` });
  result.notes.push('The guard hook was just added to .claude/settings.json. Hooks load at session start: restart Claude Code (or review it in /hooks).');
  hs = hookState();
}
C.guard_hook = { ok: hs.ok, detail: hs.ok ? `guard hook active in .claude/settings.json (${GUARD})` : 'guard hook not installed in this project. Run preflight.mjs --install (it adds PreToolUse and UserPromptSubmit hooks to .claude/settings.json)' };

// Browser for stills, audits and motion recordings
C.browser = await checkBrowser();

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
  for (const [k, c] of Object.entries(C)) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${k.padEnd(13)} ${c.detail}`);
  for (const i of result.installed) console.log(`${i.ok ? 'ADDED' : 'ERROR'} ${i.what}: ${i.command}`);
  for (const n of result.notes) console.log(`NOTE  ${n}`);
  console.log(`\n${result.ok ? 'READY' : 'NOT READY'}: ${result.next}`);
}
process.exit(result.ok ? 0 : 1);
