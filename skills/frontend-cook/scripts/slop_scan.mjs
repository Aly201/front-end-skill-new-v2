#!/usr/bin/env node
// Scans frontend source for banned "AI-looking" patterns. Errors fail the scan.
//
// Usage: node slop_scan.mjs <dir-or-file>... [--out cook/reports/slop-r03.json] [--bans cook/bans.json] [--json]
//        node slop_scan.mjs --init [--bans cook/bans.json]   write the default bans file
//
// The bans file can switch a rule off only with the user's own words:
//   { "allowed": [ { "id": "em-dash", "quote": "em dashes are fine in the blog copy" } ],
//     "extra":   [ { "id": "no-blue", "pattern": "#0000ff", "flags": "i", "message": "no pure blue" } ] }
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { dirname, extname, relative } from 'node:path';
import { walk, isMain } from './_common.mjs';

const MARKUP = ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.astro', '.md', '.mdx'];
const SCRIPT = ['.js', '.mjs', '.cjs', '.ts'];
const STYLE = ['.css', '.scss', '.sass', '.less', '.pcss'];
const ALL = [...MARKUP, ...SCRIPT, ...STYLE];

// ---------- color helpers ----------
function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
export function colorsIn(line) {
  const out = [];
  for (const m of line.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi)) {
    const rgb = hexToRgb(m[0]); if (rgb) out.push({ text: m[0], hsl: rgbToHsl(rgb) });
  }
  for (const m of line.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) {
    out.push({ text: m[0], hsl: rgbToHsl([+m[1], +m[2], +m[3]]) });
  }
  for (const m of line.matchAll(/hsla?\(\s*(\d+(?:\.\d+)?)(?:deg)?[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%/gi)) {
    out.push({ text: m[0], hsl: [+m[1], +m[2], +m[3]] });
  }
  return out;
}
export const isBeige = ([h, s, l]) => h >= 25 && h <= 55 && s >= 10 && s <= 70 && l >= 78 && l <= 96;
export const isPurple = ([h, s, l]) => h >= 250 && h <= 300 && s >= 25 && l >= 15 && l <= 85;
const BEIGE_NAMES = /\b(beige|wheat|antiquewhite|linen|oldlace|cornsilk|bisque|blanchedalmond|papayawhip|floralwhite|navajowhite|moccasin)\b/i;
const TW_BEIGE = /\b(bg|from|via|to)-(stone|amber|orange|yellow)-(50|100)\b/;
const TW_PURPLE_GRAD = /\b(from|via|to)-(purple|violet|fuchsia|indigo)-\d{2,3}\b/;
const TW_PURPLE_ACCENT = /\b(bg|text|border|ring)-(purple|violet|indigo)-(400|500|600|700)\b/;

// ---------- line rules ----------
// test(line, ctx) returns a short matched text or null.
const LINE_RULES = [
  { id: 'em-dash', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: 'Em dash in copy. Use a comma, colon, period or parentheses.',
    test: (l) => (l.match(/—|&mdash;|&#8212;|\\u2014/) || [])[0] },
  { id: 'lorem-ipsum', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: 'Placeholder text. Write real copy for this product.',
    test: (l) => (l.match(/lorem ipsum|dolor sit amet/i) || [])[0] },
  { id: 'placeholder-names', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: 'Placeholder brand or person. Use the real name or a believable specific one.',
    test: (l) => (l.match(/\b(Acme( Inc| Corp)?|John Doe|Jane Doe|Your Company|Company Name|Your Name)\b/) || [])[0] },
  { id: 'slop-copy', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: 'Generic AI marketing phrase. Say the specific thing the product does.',
    test: (l) => (l.match(/\b(unlock(ing)? the (full )?(power|potential)|elevate your|supercharge|revolutioni[sz]e|seamless(ly)?|cutting[- ]edge|game[- ]chang\w*|next[- ]level|unleash|harness the power|in today'?s (fast[- ]paced|digital)|look no further|delve into|transform the way you|effortless(ly)?)\b/i) || [])[0] },
  { id: 'emoji-icon', sev: 'warn', files: MARKUP, msg: 'Emoji used as an icon. Use a real icon set or a drawn mark.',
    test: (l) => { const m = l.match(/(?![©®™])\p{Extended_Pictographic}/u); return m ? m[0] : null; } },
  { id: 'counter-01', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: '01 / 02 / 03 counters. Drop the numbering or use a real label.',
    test: (l) => (l.match(/>\s*0[1-9]\s*(?:[<.\/]|$)|padStart\(\s*2\s*,\s*['"]0['"]\s*\)|\b(?:number|num|step|index|count)\s*:\s*['"]0[1-9]['"]/) || [])[0] },
  { id: 'eyebrow-label', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: 'Eyebrow label (small uppercase tracked text above a heading).',
    test: (l) => classHas(l, [/\buppercase\b/, /\btracking-(wide|wider|widest|\[)/]) },
  { id: 'mono-uppercase', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: 'Monospace uppercase text.',
    test: (l) => classHas(l, [/\buppercase\b/, /\bfont-mono\b/]) },
  { id: 'glow-orb', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: 'Blurred glowing orb / blob.',
    test: (l) => classHas(l, [/\brounded-full\b/, /\bblur-(2xl|3xl|\[\d{2,}px\])/]) },
  { id: 'ping-ring', sev: 'error', files: [...MARKUP, ...SCRIPT, ...STYLE], msg: 'Shockwave / ping ring animation.',
    test: (l) => (l.match(/\banimate-ping\b/) || [])[0] },
  { id: 'particles', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: 'Decorative particles library.',
    test: (l) => (l.match(/tsparticles|particles\.js|react-particles|particlesjs|@tsparticles/i) || [])[0] },
  { id: 'gradient-text', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: 'Gradient-filled headline text.',
    test: (l) => classHas(l, [/\bbg-clip-text\b/, /\btext-transparent\b/]) },
  { id: 'sparkles-icon', sev: 'warn', files: [...MARKUP, ...SCRIPT], msg: 'Sparkles icon, the stock "AI" signifier.',
    test: (l) => (l.match(/<Sparkles\b|\bSparklesIcon\b|✨/) || [])[0] },
  { id: 'glass-card', sev: 'warn', files: [...MARKUP, ...SCRIPT], msg: 'Default glassmorphism card (backdrop blur on translucent white).',
    test: (l) => classHas(l, [/\bbackdrop-blur/, /\bbg-white\/(5|10|20)\b/]) },
  { id: 'beige', sev: 'error', files: ALL, msg: 'Beige / cream color.',
    test: (l) => {
      if (BEIGE_NAMES.test(l) && /(color|background|bg|fill|--)/i.test(l)) return l.match(BEIGE_NAMES)[0];
      if (TW_BEIGE.test(l)) return l.match(TW_BEIGE)[0];
      const c = colorsIn(l).find((x) => isBeige(x.hsl));
      return c ? c.text : null;
    } },
  { id: 'purple-gradient', sev: 'error', files: ALL, msg: 'Purple / violet gradient.',
    test: (l) => {
      if (TW_PURPLE_GRAD.test(l) && /\b(bg-gradient|bg-linear|bg-radial|from-)/.test(l)) return l.match(TW_PURPLE_GRAD)[0];
      if (/gradient\(/i.test(l)) { const c = colorsIn(l).find((x) => isPurple(x.hsl)); if (c) return c.text; }
      return null;
    } },
  { id: 'purple-accent', sev: 'warn', files: ALL, msg: 'Purple as the accent color. Only keep it if the references or the brand use it.',
    test: (l) => {
      if (TW_PURPLE_ACCENT.test(l)) return l.match(TW_PURPLE_ACCENT)[0];
      if (/--(primary|accent|brand)[\w-]*\s*:/.test(l)) { const c = colorsIn(l).find((x) => isPurple(x.hsl)); if (c) return c.text; }
      return null;
    } },
];

// True when one quoted class string (class="..." / className="..." / `...`) holds every pattern.
function classHas(line, patterns) {
  for (const m of line.matchAll(/(?:class(?:Name)?\s*=\s*\{?\s*|cn\(|clsx\(|tw`)?(["'`])([^"'`]{3,})\1/g)) {
    const s = m[2];
    if (patterns.every((p) => p.test(s))) return s.length > 60 ? s.slice(0, 57) + '...' : s;
  }
  return null;
}

// ---------- CSS block rules ----------
const BLOCK_RULES = [
  { id: 'eyebrow-label', sev: 'error', msg: 'Eyebrow label (uppercase + letter-spacing).',
    test: (b) => /text-transform\s*:\s*uppercase/i.test(b) && /letter-spacing\s*:\s*(0?\.[0-9]+|[1-9][0-9.]*)(em|rem|px)/i.test(b) && !/font-size\s*:\s*(clamp|[3-9]\.?\d*rem|[4-9]\dpx|\d{3}px)/i.test(b) },
  { id: 'mono-uppercase', sev: 'error', msg: 'Monospace uppercase text.',
    test: (b) => /text-transform\s*:\s*uppercase/i.test(b) && /font-family\s*:[^;]*mono/i.test(b) },
  { id: 'glow-orb', sev: 'error', msg: 'Blurred glowing orb / blob.',
    test: (b) => /filter\s*:\s*blur\(\s*([2-9]\d|\d{3,})px/i.test(b) && /(border-radius\s*:\s*(50%|9999px|100%)|radial-gradient)/i.test(b) },
  { id: 'gradient-text', sev: 'error', msg: 'Gradient-filled text.',
    test: (b) => /background-clip\s*:\s*text/i.test(b) && /gradient\(/i.test(b) },
];

const MOTION = /@keyframes|\banimation\s*:|\btransition\s*:|\bgsap\b|framer-motion|motion\/react|\banimate-[a-z]|\blenis\b|useSpring|ScrollTrigger/;
const REDUCED = /prefers-reduced-motion|useReducedMotion|reducedMotion|motion-safe:|motion-reduce:/;
const GENERIC_FONTS = new Set(['inter', 'roboto', 'arial', 'helvetica', 'helvetica neue', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'sans-serif', 'serif', 'monospace', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'inherit', 'initial', 'var', 'open sans']);

function fontFamilies(text) {
  const fams = new Set();
  for (const m of text.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    for (const f of m[1].split(',')) {
      const n = f.trim().replace(/["']/g, '').toLowerCase();
      if (n && !n.startsWith('var(')) fams.add(n);
    }
  }
  for (const m of text.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&)\s]+)/gi)) {
    for (const f of m[1].split('|')) fams.add(decodeURIComponent(f.split(':')[0]).replace(/\+/g, ' ').toLowerCase());
  }
  for (const m of text.matchAll(/from\s+['"]next\/font\/google['"]/g)) void m;
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]next\/font\/google['"]/g)) {
    for (const f of m[1].split(',')) fams.add(f.trim().replace(/_/g, ' ').toLowerCase());
  }
  for (const m of text.matchAll(/@fontsource(?:-variable)?\/([a-z0-9-]+)/gi)) fams.add(m[1].replace(/-/g, ' ').toLowerCase());
  return fams;
}

function loadBans(path) {
  if (!path || !existsSync(path)) return { allowed: [], extra: [] };
  const j = JSON.parse(readFileSync(path, 'utf8'));
  return { allowed: j.allowed || [], extra: j.extra || [], user_bans: j.user_bans || [] };
}

export function scan(targets, bansPath) {
  const bans = loadBans(bansPath);
  const allowed = new Map();
  const findings = [];
  for (const a of bans.allowed) {
    if (a && a.id && typeof a.quote === 'string' && a.quote.trim().length >= 8) allowed.set(a.id, a.quote);
    else findings.push({ id: 'bans-file', severity: 'error', file: bansPath, line: 0, text: JSON.stringify(a), message: 'A rule was switched off without the user\'s own words (quote, 8+ characters).' });
  }
  const extra = bans.extra.map((e) => ({ id: e.id, sev: e.severity || 'error', files: ALL, msg: e.message || `User ban: ${e.id}`,
    test: (l) => { const m = l.match(new RegExp(e.pattern, e.flags || '')); return m ? m[0] : null; } }));
  const rules = [...LINE_RULES, ...extra].filter((r) => !allowed.has(r.id));
  const blockRules = BLOCK_RULES.filter((r) => !allowed.has(r.id));

  const files = [];
  for (const t of targets) {
    let st; try { st = statSync(t); } catch { findings.push({ id: 'missing-target', severity: 'error', file: t, line: 0, text: '', message: 'Path does not exist.' }); continue; }
    if (st.isDirectory()) files.push(...walk(t, ALL)); else files.push(t);
  }
  let anyMotion = false, anyReduced = false;
  const fams = new Set();
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    const text = readFileSync(f, 'utf8');
    if (MOTION.test(text)) anyMotion = true;
    if (REDUCED.test(text)) anyReduced = true;
    for (const x of fontFamilies(text)) fams.add(x);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if ((SCRIPT.includes(ext) || STYLE.includes(ext)) && /^(\/\/|\*|\/\*)/.test(trimmed)) return;
      for (const r of rules) {
        if (!r.files.includes(ext)) continue;
        const hit = r.test(line);
        if (hit) findings.push({ id: r.id, severity: r.sev, file: f, line: i + 1, text: String(hit).slice(0, 80), message: r.msg });
      }
    });
    if (STYLE.includes(ext) || ['.html', '.htm', '.vue', '.svelte', '.astro'].includes(ext)) {
      let offset = 0;
      for (const block of text.split('}')) {
        const startLine = text.slice(0, offset).split('\n').length + (block.match(/^\s*\n*/)?.[0].split('\n').length || 1) - 1;
        offset += block.length + 1;
        for (const r of blockRules) {
          if (r.test(block)) findings.push({ id: r.id, severity: r.sev, file: f, line: startLine, text: block.trim().split('{')[0].trim().slice(0, 80), message: r.msg });
        }
      }
    }
  }
  if (anyMotion && !anyReduced && !allowed.has('reduced-motion')) {
    findings.push({ id: 'reduced-motion', severity: 'error', file: '(project)', line: 0, text: '', message: 'Animations exist but nothing honors prefers-reduced-motion.' });
  }
  const named = [...fams].filter((f) => !GENERIC_FONTS.has(f));
  if (files.length && fams.size && !named.length && !allowed.has('default-typeface')) {
    findings.push({ id: 'default-typeface', severity: 'warn', file: '(project)', line: 0, text: [...fams].join(', '), message: 'Only default typefaces (Inter / Roboto / system). Pick type from the references.' });
  }
  if (named.length > 3 && !allowed.has('font-sprawl')) {
    findings.push({ id: 'font-sprawl', severity: 'warn', file: '(project)', line: 0, text: named.join(', '), message: 'More than 3 named typefaces.' });
  }
  const errors = findings.filter((x) => x.severity === 'error').length;
  return { ok: errors === 0 && files.length > 0, scanned: files.length, errors, warnings: findings.length - errors,
    allowed_by_user: [...allowed.entries()].map(([id, quote]) => ({ id, quote })), findings, at: new Date().toISOString() };
}

export const DEFAULT_BANS = {
  note: 'Default slop bans are built into slop_scan.mjs. Switch one off only with the user\'s exact words in "allowed". Add the user\'s own bans to "extra" (regex) or, when they are visual and cannot be grepped, to "user_bans" (plain words the judge checks).',
  allowed: [],
  extra: [],
  user_bans: [],
};

// ---------- CLI ----------
if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const bansPath = opt('--bans') || (existsSync('cook/bans.json') ? 'cook/bans.json' : null);
  if (argv.includes('--init')) {
    const p = opt('--bans') || 'cook/bans.json';
    if (existsSync(p)) { console.log(`${p} already exists, left as it is`); process.exit(0); }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(DEFAULT_BANS, null, 2) + '\n');
    console.log(`wrote ${p}`);
    process.exit(0);
  }
  const skip = new Set(['--out', '--bans']);
  const targets = argv.filter((a, i) => !a.startsWith('--') && !skip.has(argv[i - 1]));
  if (!targets.length) { console.error('usage: node slop_scan.mjs <dir-or-file>... [--out report.json] [--bans cook/bans.json] [--json]'); process.exit(2); }
  const report = scan(targets, bansPath);
  report.targets = targets;
  const out = opt('--out');
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const f of report.findings) console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.id.padEnd(17)} ${relative(process.cwd(), f.file) || f.file}:${f.line}  ${f.text}  -> ${f.message}`);
    for (const a of report.allowed_by_user) console.log(`ALLOW ${a.id.padEnd(17)} user said: "${a.quote}"`);
    console.log(`\n${report.ok ? 'CLEAN' : 'SLOP FOUND'}: ${report.errors} errors, ${report.warnings} warnings in ${report.scanned} files${out ? `. Report: ${out}` : ''}`);
    if (!report.scanned) console.log('Nothing was scanned: check the path.');
  }
  process.exit(report.ok ? 0 : 1);
}
