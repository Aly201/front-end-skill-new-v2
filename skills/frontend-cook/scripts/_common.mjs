// Shared helpers for the frontend-cook scripts. No dependencies beyond Node 18+.
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export const STATE_DIR = 'cook';

// Find the project root: the nearest folder upward that holds cook/GATES.json,
// else the current folder.
export function projectRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, STATE_DIR, 'GATES.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function mtime(path) {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', '.svelte-kit', '.turbo', '.vercel', 'coverage', 'cook', 'cook-archive', '.cache']);

// Every file under dir, skipping build output and dependency folders.
export function walk(dir, exts = null, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') { if (e.isDirectory()) continue; }
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, exts, out); }
    else if (!exts || exts.includes(extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

export function newestMtime(paths) {
  let m = 0;
  for (const p of paths) m = Math.max(m, mtime(p));
  return m;
}

// Image size from the file header: PNG, JPEG, WebP. Returns {width, height} or null.
export function imageSize(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const b = buf.subarray(0, n);
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    return null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// Where an installed skill lives. Checks project, user and other agents' folders.
export function findSkill(name, cwd = process.cwd()) {
  const home = homedir();
  const candidates = [
    join(cwd, '.claude', 'skills', name),
    join(home, '.claude', 'skills', name),
    join(cwd, '.agents', 'skills', name),
    join(home, '.agents', 'skills', name),
    join(home, '.codex', 'skills', name),
  ];
  for (const c of candidates) if (existsSync(join(c, 'SKILL.md'))) return c;
  // Plugin installs: ~/.claude/plugins/**/skills/<name>/SKILL.md (shallow search).
  const plugins = join(home, '.claude', 'plugins');
  const found = walkForSkill(plugins, name, 6);
  return found;
}

function walkForSkill(dir, name, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.name === name && existsSync(join(p, 'SKILL.md'))) return p;
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const r = walkForSkill(p, name, depth - 1);
    if (r) return r;
  }
  return null;
}

// Load Playwright from wherever it is installed: the project, the global npm root,
// or a preinstalled tools folder. Returns the module or null.
export function loadPlaywright(cwd = process.cwd()) {
  const roots = [cwd, process.env.PLAYWRIGHT_ROOT, '/opt/node-tools', join(homedir(), '.frontend-cook')];
  const g = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (g.status === 0) roots.push(dirname(g.stdout.trim()));
  for (const r of roots.filter(Boolean)) {
    try { return createRequire(join(r, 'noop.js'))('playwright'); } catch { /* next */ }
  }
  return null;
}

// Launch Chromium with the first path that works. Fast path first.
export async function launchBrowser(pw) {
  const paths = [undefined, process.env.CHROME_PATH, '/opt/pw-browsers/chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'];
  const errors = [];
  for (const executablePath of paths) {
    if (executablePath !== undefined && (!executablePath || !existsSync(executablePath))) continue;
    try {
      const browser = await pw.chromium.launch({ executablePath, args: ['--no-sandbox'] });
      return { browser, executablePath: executablePath || 'playwright default' };
    } catch (e) { errors.push(`${executablePath || 'default'}: ${String(e.message).split('\n')[0]}`); }
  }
  throw new Error(`no Chromium could start:\n  ${errors.join('\n  ')}`);
}

export function median(nums) {
  const a = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function homeDir() { return homedir(); }

// True when the given module is the script node was started with (symlinks resolved).
export function isMain(metaUrl) {
  try { return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === metaUrl; } catch { return false; }
}

// Animation code. Banned in the mockup and the static build (step 6a), allowed from step 6b.
// Hover and focus transitions are allowed in static: they are states, not animation.
// The last alternative catches transitions of 500ms or longer (hover and focus transitions are shorter).
export const MOTION_CODE = /@keyframes|\banimation(?:-name|Name|Duration)?\s*:(?!\s*["']?none\b)|\bgsap\b|framer-motion|['"]motion\/react['"]|\bfrom\s+['"]motion['"]|\banimate-(?!none\b)[a-z]|\blenis\b|ScrollTrigger|useSpring|\.animate\(|\bview-timeline|\bscroll-timeline|animation-timeline|IntersectionObserver|requestAnimationFrame|data-aos|<marquee|['"]animejs['"]|\banime\(|react-spring|locomotive-scroll|tailwindcss-animate|\bwhileInView\b|\bwhileHover\b|<motion\.|\btransition(?:-duration)?\s*:[^;}]*?(?:\s|:|,)(?:[5-9]\d\dms|[1-9]\d{3,}ms|0?\.[5-9]\d*s|[1-9][\d.]*s)\b/;
export const FRONTEND_EXT = ['.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.mdx'];

// The activity ledger the guard hook writes: one JSON object per line.
export function readLedger(root) {
  try {
    return readFileSync(join(root, STATE_DIR, '.ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// True when the user typed the quote in this project. Quotes, case, and extra spaces are ignored.
// Only UserPrompt lines count: the guard hook logs the user's prompts there.
const normWords = (s) => String(s).toLowerCase().replace(/[“”"'‘’`]/g, '').replace(/\s+/g, ' ').trim();
export function userSaid(root, quote) {
  const q = normWords(quote);
  if (!q) return false;
  // Whole words only: "it" must not match inside "edit".
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u');
  return readLedger(root).some((e) => e.tool === 'UserPrompt' && re.test(normWords(e.prompt || '')));
}

// Hours of real activity: gaps between tool calls of up to `gapMin` minutes count, longer gaps
// (waiting for the user, idle sessions) do not.
export function activeHours(events, gapMin = 15) {
  const t = events.map((e) => Date.parse(e.at)).filter(Number.isFinite).sort((a, b) => a - b);
  let ms = 0;
  for (let i = 1; i < t.length; i++) { const d = t[i] - t[i - 1]; if (d <= gapMin * 60000) ms += d; }
  return ms / 3600000;
}

// ---------- shared contracts for redesign mode (see references/redesign.md) ----------
import { createHash as _createHash } from 'node:crypto';

// Stable id for one line of code: sha1 of the trimmed text, 12 hex chars. Used to allow
// specific existing motion lines (GATES.json motion_allow) and to fingerprint findings.
export function lineHash(text) {
  return _createHash('sha1').update(String(text).trim()).digest('hex').slice(0, 12);
}

const PROSE_EXT = ['.md', '.mdx', '.txt'];
// Lines that are only a comment do not count as motion code.
// Stateless (edit snippets can start mid-comment): strip inline /*...*/, then a line is a comment when
// it starts with // <!-- or "# ", or starts with * or /* and has no CSS/JS punctuation ({ } ;) left.
function isCommentLine(t) {
  const x = String(t).replace(/\/\*.*?\*\//g, '').trim();
  if (!x) return true;
  if (/^(\/\/|<!--|#\s)/.test(x)) return true;
  return /^(\*|\/\*)/.test(x) && !/[{};]/.test(x);
}

// Every animation-code line in a text: [{ line (1-based), text, hash }]. Prose files and comment
// lines are skipped. ext is the file extension including the dot ('' = treat as code).
export function motionHits(text, ext = '') {
  if (PROSE_EXT.includes(String(ext).toLowerCase())) return [];
  const out = [];
  String(text || '').split('\n').forEach((l, i) => {
    if (!l.trim() || isCommentLine(l)) return;
    if (MOTION_CODE.test(l.replace(/\/\*.*?\*\//g, ''))) out.push({ line: i + 1, text: l.trim().slice(0, 160), hash: lineHash(l) });
  });
  return out;
}

// Motion hits that are not allowed. allow = GATES.json motion_allow: [{ file, hash, reason }].
// file is project-relative with forward slashes.
export function unallowedMotion(text, ext, relFile, allow = []) {
  const ok = new Set((allow || []).filter((a) => a.file === relFile).map((a) => a.hash));
  return motionHits(text, ext).filter((h) => !ok.has(h.hash));
}

// URL compare without trailing-slash or default-port noise.
export function normUrl(u) {
  try {
    const x = new URL(u);
    let p = x.pathname.replace(/\/index\.html?$/i, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return `${x.protocol}//${x.host}${p || '/'}${x.search}`;
  } catch { return String(u || '').replace(/\/+$/, ''); }
}

// Full URL of a page path ('/', '/pricing') on a base URL ('http://localhost:5173' or a file: URL of a folder).
export function pageUrl(base, page = '/') {
  if (!page || page === '/') return base;
  if (/^https?:/i.test(page)) return page;
  return new URL(page.replace(/^\//, ''), base.endsWith('/') ? base : base + '/').href;
}

// File-name slug for a page path: '/' -> 'home', '/pricing/plans' -> 'pricing-plans'.
export function pageSlug(page = '/') {
  const s = String(page).replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return s || 'home';
}

// The project root for an edited file: walk up from the file, then from cwd.
export function rootForFile(file, cwd = process.cwd()) {
  const fromFile = file ? projectRoot(dirname(resolve(cwd, file))) : null;
  if (fromFile && existsSync(join(fromFile, STATE_DIR, 'GATES.json'))) return fromFile;
  return projectRoot(cwd);
}

// Simple glob ('src/legacy/**', '**/*.test.*') to a RegExp over forward-slash relative paths.
export function globToRe(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function readGates(root) { return readJson(join(root, STATE_DIR, 'GATES.json'), null); }

// What counts as a design file, for the guard (before step 5) and gate.mjs (the verify 5 git check).
// Logic, test, config and server/api files are not design; neither are cook/mockup and cook/refs.
const DESIGN_SKIP = /(^|\/)(node_modules|dist|build|\.next|\.astro|\.svelte-kit|\.git)\//;
const LOGIC_EXT = ['.js', '.mjs', '.cjs', '.ts'];
const NOT_DESIGN = [/(^|\/)[^/]*\.(test|spec)\.[^/]*$/i, /(^|\/)[^/]*\.config\.[^/]*$/i, /(^|\/)__tests__\//, /(^|\/)(server|api)\//];
// Exclude patterns: a glob, or a plain folder ('src/legacy', 'src/legacy/', './src/legacy') meaning
// that folder and everything under it.
export function excludeRe(pattern) {
  let g = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!/[*?]/.test(g)) g = `${g}/**`;
  const re = globToRe(g);
  const base = g.replace(/\/\*\*$/, '');
  return { test: (rel) => re.test(rel) || rel === base };
}
export function isExcluded(rel, patterns = []) {
  rel = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  return (Array.isArray(patterns) ? patterns : []).some((p) => excludeRe(p).test(rel));
}

// Logic-extension files that are really design: style modules by name, or JSX / class names /
// styled / cva by content (narrow on purpose: it must not flag ordinary logic files).
const STYLE_MODULE = /\.(css|styles?)\.[cm]?[jt]s$/i;
const DESIGN_CONTENT = /(return\s*\(?\s*<[A-Za-z>]|=>\s*\(?\s*<[A-Za-z>]|\bclassName\s*=\s*["'{]|\bstyled(\.[a-z]+|\([A-Z]\w*\))`|\bcss`|\bcva\(|\bstyle\s*=\s*\{\{)/;
export function looksLikeDesign(rel, text) {
  return STYLE_MODULE.test(String(rel)) || (typeof text === 'string' && DESIGN_CONTENT.test(text));
}

// text: the file content to judge logic-extension files by (guard: content on disk plus the new text;
// gate: content on disk). In mode "new" every frontend file is design, as before.
export function isDesignFile(rel, gates = {}, text = null) {
  rel = String(rel).replace(/\\/g, '/');
  const ext = extname(rel).toLowerCase();
  if (rel.startsWith('cook/mockup/') || rel.startsWith('cook/refs/')) return false;
  if (!FRONTEND_EXT.includes(ext) || DESIGN_SKIP.test(rel)) return false;
  if (NOT_DESIGN.some((re) => re.test(rel))) return false;
  if (LOGIC_EXT.includes(ext) && gates?.mode === 'redesign' && !looksLikeDesign(rel, text)) return false;
  if (isExcluded(rel, gates?.scope?.exclude)) return false;
  const src = (Array.isArray(gates?.scope?.src) ? gates.scope.src : [])
    .map((x) => String(x).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
  if (src.length) return src.some((x) => rel === x || rel.startsWith(`${x}/`));
  return true;
}

// Step order, shared by gate.mjs and the guard's per-prompt reminder.
export const STEPS_NEW = ['0', '1', '2', '3', '4', '5', '6a', '6b', '7', '8'];
export const STEPS_REDESIGN_ORDER = ['0', '0b', '1', '2', '3', '4', '5', '6a', '6b', '7', '8'];
export const STEP_SHORT_NAMES = { 0: 'setup', '0b': 'baseline', 1: 'references', 2: 'mockup', 3: 'bar', 4: 'time', 5: 'bans', '6a': 'static build', '6b': 'motion', 7: 'feedback', 8: 'separate judge' };
