#!/usr/bin/env node
// Takes repeatable screenshots (and optional scroll recordings) of a URL or a local build.
// Used for references, the mockup and every round, so all of them are shot the same way.
//
// Usage: node shoot.mjs <url | file.html | folder> --out <dir> [options]
//   --name <prefix>        file prefix (default "shot"); one viewport -> <prefix>.png, several -> <prefix>-<viewport>.png
//   --viewports <list>     desktop,mobile (default) | any of desktop, laptop, tablet, mobile, or WxH
//   --fold                 also save the first screen only (<prefix>-<viewport>-fold.png)
//   --live                 keep animations running (default: settle every animation to its end state)
//   --video <seconds>      also record a scroll-through video + filmstrip (needs ffmpeg for the filmstrip)
//   --wait <ms>            extra settle time after load (default 600)
//   --dark                 emulate prefers-color-scheme: dark
import { mkdirSync, existsSync, statSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadPlaywright, launchBrowser } from './_common.mjs';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 834, height: 1194, isMobile: true, hasTouch: true },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const VALUED = new Set(['--out', '--name', '--viewports', '--video', '--wait']);
const target = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
const out = opt('--out');
if (!target || !out) {
  console.error('usage: node shoot.mjs <url | file.html | folder> --out <dir> [--name R01] [--viewports desktop,mobile] [--fold] [--live] [--video 12] [--wait 600] [--dark]');
  process.exit(2);
}

function toUrl(t) {
  if (/^https?:\/\//i.test(t) || t.startsWith('file:')) return t;
  const p = resolve(t);
  if (!existsSync(p)) { console.error(`shoot: not found: ${t}`); process.exit(2); }
  return pathToFileURL(statSync(p).isDirectory() ? join(p, 'index.html') : p).href;
}

const url = toUrl(target);
const name = opt('--name', 'shot');
const vpNames = opt('--viewports', 'desktop,mobile').split(',').map((s) => s.trim()).filter(Boolean);
const settle = Number(opt('--wait', '600'));
const videoSecs = Number(opt('--video', '0'));
const LIVE = argv.includes('--live');
mkdirSync(out, { recursive: true });

const SETTLE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}`;

async function prepare(page) {
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
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

const pw = loadPlaywright();
if (!pw) { console.error('shoot: Playwright not found. Run the setup check: node preflight.mjs'); process.exit(1); }
const { browser } = await launchBrowser(pw);
const written = [];
try {
  for (const vn of vpNames) {
    let vp = VIEWPORTS[vn];
    if (!vp) {
      const m = /^(\d+)x(\d+)$/.exec(vn);
      if (!m) throw new Error(`unknown viewport ${vn}`);
      vp = { width: +m[1], height: +m[2] };
    }
    const { width, height, ...rest } = vp;
    const base = vpNames.length === 1 ? name : `${name}-${vn}`;
    const ctx = await browser.newContext({ viewport: { width, height }, ...rest, colorScheme: argv.includes('--dark') ? 'dark' : 'light', reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    await prepare(page);
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
      await vpage.goto(url, { waitUntil: 'load', timeout: 45000 });
      await vpage.waitForTimeout(Math.min(2500, videoSecs * 200)); // let the intro play
      const total = await vpage.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      const steps = Math.max(10, Math.round(videoSecs * 12));
      for (let i = 1; i <= steps; i++) {
        await vpage.mouse.wheel(0, Math.max(1, total / steps));
        await vpage.waitForTimeout((videoSecs * 1000 * 0.8) / steps);
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
} finally { await browser.close(); }
for (const f of written) console.log(`wrote ${f}`);
