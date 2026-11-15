#!/usr/bin/env node
// Measured quality checks on a rendered page. Every number here comes from the browser,
// never from a guess. Errors fail the audit.
//
// Usage: node audit.mjs <url | file.html | folder> [--out cook/reports/audit-r03.json] [--viewports desktop,mobile] [--json]
//
// Checks per viewport:
//   overflow     no horizontal scroll (error)
//   console      no console errors, page errors or failed requests (error)
//   images       no broken images (error), alt text present (warn)
//   contrast     WCAG AA for visible text on solid backgrounds: 4.5:1 body, 3:1 large (error);
//                text over images or gradients is listed as "not measured"
//   tap-targets  links and buttons at least 24x24 CSS px on mobile (error), 44x44 advised (warn)
//   type         at most 3 font families (warn), at most 10 distinct font sizes (warn), body text >= 14px on mobile (error)
//   empty-links  links and buttons with no accessible name (error)
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPlaywright, launchBrowser } from './_common.mjs';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1194, isMobile: true, hasTouch: true },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
};
const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const VALUED = new Set(['--out', '--viewports']);
const target = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
if (!target) { console.error('usage: node audit.mjs <url | file.html | folder> [--out report.json] [--viewports desktop,mobile] [--json]'); process.exit(2); }
const url = /^(https?|file):/i.test(target) ? target : (() => {
  const p = resolve(target);
  if (!existsSync(p)) { console.error(`audit: not found: ${target}`); process.exit(2); }
  return pathToFileURL(statSync(p).isDirectory() ? join(p, 'index.html') : p).href;
})();

// Runs inside the page.
function inPage({ isMobile, vw }) {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0; };
  const sel = (el) => { const parts = []; let e = el; for (let i = 0; e && i < 4 && e !== document.body; i++, e = e.parentElement) { let s = e.tagName.toLowerCase(); if (e.id) { s += `#${e.id}`; parts.unshift(s); break; } const c = [...e.classList].slice(0, 2).join('.'); if (c) s += `.${c}`; parts.unshift(s); } return parts.join(' > '); };

  function background(el) {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return { unknown: 'background image or gradient' };
      if (['IMG', 'VIDEO', 'CANVAS', 'PICTURE'].includes(e.tagName)) return { unknown: 'media' };
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) bg = blend(l, bg);
    return { color: bg };
  }

  const doc = document.documentElement;
  const res = { overflow: Math.max(doc.scrollWidth, document.body.scrollWidth) - vw, contrastFails: [], contrastUnmeasured: 0, contrastChecked: 0, families: new Set(), sizes: new Set(), smallBody: [], tapSmall: [], tapAdvise: [], emptyNames: [], imagesBroken: [], imagesNoAlt: [] };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.textContent.trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !visible(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
    seen.add(el);
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize);
    res.families.add(s.fontFamily.split(',')[0].replace(/["']/g, '').trim());
    res.sizes.add(Math.round(size));
    const text = n.textContent.trim();
    if (isMobile && size < 14 && text.length > 40 && !['SUP', 'SUB', 'SMALL', 'FIGCAPTION', 'LABEL'].includes(el.tagName) && !el.closest('footer, small, figcaption, nav')) res.smallBody.push({ sel: sel(el), size, text: text.slice(0, 40) });
    const fg = parse(s.color);
    const bg = background(el);
    if (!fg || bg.unknown) { res.contrastUnmeasured++; continue; }
    const fgFlat = fg.a < 1 ? blend(fg, bg.color) : fg;
    const r = ratio(fgFlat, bg.color);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    res.contrastChecked++;
    if (r < need) res.contrastFails.push({ sel: sel(el), ratio: Math.round(r * 100) / 100, need, text: text.slice(0, 40) });
  }
  for (const el of document.querySelectorAll('a[href], button, [role="button"], input[type="submit"]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.querySelector('img[alt]')?.alt || el.value || '').trim();
    if (!name && !el.getAttribute('aria-labelledby')) res.emptyNames.push(sel(el));
    if (isMobile) {
      const inline = getComputedStyle(el).display === 'inline' && el.closest('p, li');
      if (!inline && (r.width < 24 || r.height < 24)) res.tapSmall.push({ sel: sel(el), w: Math.round(r.width), h: Math.round(r.height) });
      else if (!inline && (r.width < 44 || r.height < 44)) res.tapAdvise.push(sel(el));
    }
  }
  for (const img of document.images) {
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) res.imagesBroken.push(img.getAttribute('src').slice(0, 80));
    if (!img.hasAttribute('alt')) res.imagesNoAlt.push((img.getAttribute('src') || '').slice(0, 80));
  }
  res.families = [...res.families];
  res.sizes = [...res.sizes].sort((a, b) => a - b);
  return res;
}

const pw = loadPlaywright();
if (!pw) { console.error('audit: Playwright not found. Run the setup check: node preflight.mjs'); process.exit(1); }
const { browser } = await launchBrowser(pw);
const findings = [];
const add = (severity, check, viewport, message, detail) => findings.push({ severity, check, viewport, message, detail });
const per = {};
try {
  for (const vn of opt('--viewports', 'desktop,mobile').split(',')) {
    const vp = VIEWPORTS[vn]; if (!vp) throw new Error(`unknown viewport ${vn}`);
    const { width, height, ...rest } = vp;
    const ctx = await browser.newContext({ viewport: { width, height }, ...rest });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 160)}`); });
    page.on('pageerror', (e) => errs.push(`pageerror: ${String(e.message).slice(0, 160)}`));
    page.on('requestfailed', (r) => { const why = r.failure()?.errorText || ''; if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(why)) errs.push(`request failed: ${r.url().slice(0, 120)} (${why})`); }); // aborted = cancelled prefetch, not a failure
    page.on('response', (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()}: ${r.url().slice(0, 120)}`); });
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* busy pages */ }
    await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } window.scrollTo(0, 0); });
    await page.addStyleTag({ content: '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}' });
    await page.waitForTimeout(400);
    const r = await page.evaluate(inPage, { isMobile: Boolean(rest.isMobile), vw: width });
    per[vn] = { overflow_px: r.overflow, contrast_checked: r.contrastChecked, contrast_not_measured: r.contrastUnmeasured, font_families: r.families, font_sizes: r.sizes };
    if (r.overflow > 1) add('error', 'overflow', vn, `Page is ${r.overflow}px wider than the viewport (horizontal scroll).`);
    for (const e of errs) add('error', 'console', vn, e);
    for (const b of r.imagesBroken) add('error', 'images', vn, `Broken image: ${b}`);
    if (r.imagesNoAlt.length) add('warn', 'images', vn, `${r.imagesNoAlt.length} image(s) without alt`, r.imagesNoAlt.slice(0, 5));
    for (const c of r.contrastFails.slice(0, 25)) add('error', 'contrast', vn, `${c.ratio}:1, needs ${c.need}:1 at ${c.sel} "${c.text}"`);
    if (r.contrastFails.length > 25) add('error', 'contrast', vn, `...and ${r.contrastFails.length - 25} more contrast failures`);
    for (const t of r.tapSmall.slice(0, 15)) add('error', 'tap-targets', vn, `Tap target ${t.w}x${t.h}px at ${t.sel} (minimum 24x24)`);
    if (r.tapAdvise.length) add('warn', 'tap-targets', vn, `${r.tapAdvise.length} tap target(s) under 44x44px`, r.tapAdvise.slice(0, 5));
    for (const s of r.smallBody.slice(0, 10)) add('error', 'type', vn, `Body text ${s.size}px on mobile at ${s.sel} "${s.text}"`);
    if (r.families.length > 3) add('warn', 'type', vn, `${r.families.length} font families in use`, r.families);
    if (r.sizes.length > 10) add('warn', 'type', vn, `${r.sizes.length} distinct font sizes (type scale sprawl)`, r.sizes);
    for (const s of [...new Set(r.emptyNames)].slice(0, 10)) add('error', 'empty-links', vn, `Link or button with no accessible name: ${s}`);
    await ctx.close();
  }
} finally { await browser.close(); }

const errors = findings.filter((f) => f.severity === 'error').length;
const report = { ok: errors === 0, url, errors, warnings: findings.length - errors, viewports: per, findings, at: new Date().toISOString() };
const out = opt('--out');
if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  for (const f of findings) console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.check.padEnd(11)} [${f.viewport}] ${f.message}`);
  for (const [vn, v] of Object.entries(per)) console.log(`INFO  ${vn}: contrast checked on ${v.contrast_checked} text elements, not measured on ${v.contrast_not_measured} (over images or gradients: judge them by eye)`);
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'}: ${errors} errors, ${report.warnings} warnings${out ? `. Report: ${out}` : ''}`);
}
process.exit(report.ok ? 0 : 1);
