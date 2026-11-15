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
  const roots = [cwd, process.env.PLAYWRIGHT_ROOT, '/opt/node-tools'];
  const g = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
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
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
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
