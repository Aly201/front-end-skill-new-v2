#!/usr/bin/env node
// Takes repeatable screenshots (and optional scroll recordings) of a URL or a local build.
// Used for references, the mockup and every round, so all of them are shot the same way.
//
// Usage: node shoot.mjs <url | file.html | folder> --out <dir> [options]
//   --name <prefix>        file prefix (default "shot"); one viewport -> <prefix>.png, several -> <prefix>-<viewport>.png
//   --pages <list>         comma-separated pages relative to the base (e.g. /,/pricing). The target is the base URL
//                          (or a folder/file, read as a folder). Files are <page-slug>-<viewport>.png; --name is ignored.
//   --steps <json>         interaction steps run after load (see _steps.mjs), e.g. '[{"click":{"role":"button","name":"Menu"}}]'
//   --suffix <state>       required with --steps: names the state shot, e.g. home-mobile-menu.png (with -fold and -motion too)
//   --viewports <list>     desktop,mobile (default) | any of desktop, laptop, tablet, mobile, or WxH
//   --fold                 also save the first screen only (<name>-<viewport>-fold.png)
//   --live                 keep animations running (default: settle every animation to its end state)
//   --video <seconds>      also record a scroll-through video + filmstrip (needs ffmpeg for the filmstrip)
//   --wait <ms>            extra settle time after load (default 600)
//   --dark                 emulate prefers-color-scheme: dark
import { mkdirSync, existsSync, statSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadPlaywright, launchBrowser, pageUrl, pageSlug } from './_common.mjs';
import { runSteps } from './_steps.mjs';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 834, height: 1194, isMobile: true, hasTouch: true },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const VALUED = new Set(['--out', '--name', '--viewports', '--video', '--wait', '--pages', '--steps', '--suffix']);
const target = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
const out = opt('--out');
if (!target || !out) {
  console.error('usage: node shoot.mjs <url | file.html | folder> --out <dir> [--name R01] [--pages /,/pricing] [--steps \'[...]\' --suffix menu] [--viewports desktop,mobile] [--fold] [--live] [--video 12] [--wait 600] [--dark]');
  process.exit(2);
}

function toUrl(t) {
  if (/^https?:\/\//i.test(t) || t.startsWith('file:')) return t;
  const p = resolve(t);
  if (!existsSync(p)) { console.error(`shoot: not found: ${t}`); process.exit(2); }
  return pathToFileURL(statSync(p).isDirectory() ? join(p, 'index.html') : p).href;
}

// The base for --pages: a URL as given (with a trailing '/'), or the file URL of the folder (of the file's folder).
function baseOf(t) {
  if (/^https?:\/\//i.test(t)) return t.endsWith('/') ? t : t + '/';
  if (t.startsWith('file:')) return new URL('./', t).href;
  const p = resolve(t);
  if (!existsSync(p)) { console.error(`shoot: not found: ${t}`); process.exit(2); }
  const dir = statSync(p).isDirectory() ? p : dirname(p);
  const href = pathToFileURL(dir).href;
  return href.endsWith('/') ? href : href + '/';
}

// A file: base has no server, so a page maps to a file: <p>/index.html, then <p>.html, then <p> itself.
// Http(s) bases (and absolute page URLs) are used as they are.
function resolvePage(base, page) {
  const u = pageUrl(base, page);
  if (!u.startsWith('file:')) return u;
  const rel = String(page).replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  const dir = fileURLToPath(base);
  const cands = rel ? [join(dir, rel, 'index.html'), join(dir, `${rel}.html`), join(dir, rel)] : [join(dir, 'index.html')];
  const found = cands.find((c) => existsSync(c) && statSync(c).isFile());
  if (!found) throw new Error(`page ${page} not found under ${base}`);
  return pathToFileURL(found).href;
}

const name = opt('--name', 'shot');
const pagesOpt = opt('--pages');
const pages = pagesOpt === null ? null : pagesOpt.split(',').map((s) => s.trim()).filter(Boolean);
if (pages && pages.length === 0) { console.error('shoot: --pages needs at least one page, e.g. --pages /,/pricing'); process.exit(2); }
// Two pages with the same slug would write over each other's files.
if (pages) {
  const bySlug = new Map();
  for (const p of pages) bySlug.set(pageSlug(p), [...(bySlug.get(pageSlug(p)) || []), p]);
  for (const [slug, same] of bySlug) {
    if (same.length > 1) { console.error(`shoot: --pages ${same.join(' and ')} would write the same files (${slug}-<viewport>.png); keep one of them`); process.exit(2); }
  }
}
// Resolve every page before anything is shot, so a missing file fails the run up front.
let targets;
try {
  targets = pages
    ? pages.map((p) => ({ page: p, url: resolvePage(baseOf(target), p) }))
    : [{ page: null, url: toUrl(target) }];
} catch (e) { console.error(`shoot: ${e.message}`); process.exit(1); }

const hasSteps = argv.includes('--steps');
const suffix = opt('--suffix');
let steps = null;
if (hasSteps) {
  if (!suffix) { console.error('shoot: --steps needs --suffix <state> (it names the screenshot, e.g. --suffix menu)'); process.exit(2); }
  try { steps = JSON.parse(opt('--steps')); } catch (e) { console.error(`shoot: --steps is not valid JSON: ${e.message}`); process.exit(2); }
  if (!Array.isArray(steps)) { console.error('shoot: --steps must be a JSON array of steps'); process.exit(2); }
}
if (suffix !== null && !/^[a-z0-9][a-z0-9_-]*$/i.test(suffix)) {
  console.error(`shoot: --suffix must be letters, digits, - or _ (got ${suffix})`);
  process.exit(2);
}
const suffixPart = suffix ? `-${suffix}` : '';

const vpNames = opt('--viewports', 'desktop,mobile').split(',').map((s) => s.trim()).filter(Boolean);
const settle = Number(opt('--wait', '600'));
const videoSecs = Number(opt('--video', '0'));
const LIVE = argv.includes('--live');
mkdirSync(out, { recursive: true });

// File name without extension for one page (or the single target) at one viewport.
function fileBase(page, vn) {
  if (pages) return `${pageSlug(page)}-${vn}${suffixPart}`;
  if (suffix) return `${name}-${vn}${suffixPart}`;
  return vpNames.length === 1 ? name : `${name}-${vn}`;
}

const SETTLE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}`;

// Opens a URL; an HTTP error status fails the run instead of shooting the error page.
async function gotoPage(page, url) {
  const res = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  const status = res ? res.status() : 0;
  if (status >= 400) throw new Error(`page ${url} returned ${status}`);
}

async function prepare(page, url) {
  await gotoPage(page, url);
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* busy pages */ }
  // Walk down the page so lazy images and scroll reveals fire, then go back up.
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    const max = Math.min(document.documentElement.scrollHeight, 30000);
    for (let y = 0; y < max; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
    window.scrollTo(0, 0);
  });
  if (!LIVE) await page.addStyleTag({ content: SETTLE_CSS });
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 4000); })));
  });
  await page.waitForTimeout(settle);
}

// Runs the --steps (if any) and lets the resulting state settle.
async function applySteps(page, where) {
  if (!steps) return;
  try { await runSteps(page, steps); }
  catch (e) { throw new Error(`steps failed on ${where}: ${String(e.message).split('\n')[0]}`); }
  await page.waitForTimeout(300);
}

const pw = loadPlaywright();
if (!pw) { console.error('shoot: Playwright not found. Run the setup check: node preflight.mjs'); process.exit(1); }
const { browser } = await launchBrowser(pw);
const written = [];
try {
  for (const t of targets) {
    for (const vn of vpNames) {
      let vp = VIEWPORTS[vn];
      if (!vp) {
        const m = /^(\d+)x(\d+)$/.exec(vn);
        if (!m) throw new Error(`unknown viewport ${vn}`);
        vp = { width: +m[1], height: +m[2] };
      }
      const { width, height, ...rest } = vp;
      const base = fileBase(t.page, vn);
      const where = `${t.url} (${vn})`;
      const ctx = await browser.newContext({ viewport: { width, height }, ...rest, colorScheme: argv.includes('--dark') ? 'dark' : 'light', reducedMotion: 'no-preference' });
      const page = await ctx.newPage();
      await prepare(page, t.url);
      await applySteps(page, where);
      const file = join(out, `${base}.png`);
      try { await page.screenshot({ path: file, fullPage: true, timeout: 60000 }); }
      catch {
        // Very tall pages can exceed the capture limit: clip to 16000px.
        await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height: Math.min(16000, await page.evaluate(() => document.documentElement.scrollHeight)) } });
      }
      written.push(file);
      if (argv.includes('--fold')) { const f = join(out, `${base}-fold.png`); await page.screenshot({ path: f }); written.push(f); }
      await ctx.close();

      if (videoSecs > 0) {
        const vdir = join(out, `.video-${base}`);
        const vctx = await browser.newContext({ viewport: { width, height }, ...rest, recordVideo: { dir: vdir, size: { width, height } } });
        const vpage = await vctx.newPage();
        await gotoPage(vpage, t.url);
        await vpage.waitForTimeout(Math.min(2500, videoSecs * 200)); // let the intro play
        await applySteps(vpage, where);
        const total = await vpage.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
        const moves = Math.max(10, Math.round(videoSecs * 12));
        for (let i = 1; i <= moves; i++) {
          await vpage.mouse.wheel(0, Math.max(1, total / moves));
          await vpage.waitForTimeout((videoSecs * 1000 * 0.8) / moves);
        }
        await vpage.waitForTimeout(600);
        await vctx.close();
        const webm = readdirSync(vdir).find((f) => f.endsWith('.webm'));
        const vfile = join(out, `${base}-motion.webm`);
        renameSync(join(vdir, webm), vfile);
        rmSync(vdir, { recursive: true, force: true });
        written.push(vfile);
        const strip = join(out, `${base}-motion-strip.jpg`);
        const ff = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', vfile, '-vf', 'fps=2,scale=480:-1,tile=6x4', '-frames:v', '1', '-q:v', '3', strip], { encoding: 'utf8' });
        if (ff.status === 0) written.push(strip); else console.error(`shoot: filmstrip skipped (ffmpeg): ${(ff.stderr || ff.error?.message || '').trim().split('\n')[0]}`);
      }
    }
  }
} catch (e) {
  console.error(`shoot: ${e.message}`);
  process.exitCode = 1;
} finally { await browser.close(); }
for (const f of written) console.log(`wrote ${f}`);
