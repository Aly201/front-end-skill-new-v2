#!/usr/bin/env node
// Scans frontend source for banned "AI-looking" patterns. Errors fail the scan.
//
// Usage: node slop_scan.mjs <dir-or-file>... [--out cook/reports/slop-r03.json] [--bans cook/bans.json] [--json]
//                           [--baseline cook/baseline/slop.json] [--exclude <glob>]...
//        node slop_scan.mjs --init [--bans cook/bans.json]   write the default bans file
//
// --baseline: an earlier slop report. Each finding is fingerprinted as id|file|text (no line number).
//   Findings are counted per fingerprint: if the baseline has N findings with a fingerprint, the first N
//   findings with that fingerprint are "remaining"; any extra ones are "is_new". "fixed" lists the baseline
//   occurrences that no longer appear.
// The report records bans_sha1: the sha1 of the bans file it used (null when there is none), so the gate
//   can tell a report made with the current bans from one made before a ban was added.
// --exclude: a glob or a folder (relative to the current directory, '/' separators; `src/legacy`,
//   `src/legacy/` and `./src/legacy` all work). Excluded files are still scanned; their findings are out of
//   scope, so they fail the scan only when they are new.
//
// The bans file can switch a rule off only with the user's own words:
//   { "allowed": [ { "id": "em-dash", "quote": "em dashes are fine in the blog copy" } ],
//     "extra":   [ { "id": "no-blue", "pattern": "#0000ff", "flags": "i", "message": "no pure blue" } ] }
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { walk, isMain, MOTION_CODE, projectRoot, userSaid, isExcluded } from './_common.mjs';

const MARKUP = ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.astro', '.md', '.mdx'];
const SCRIPT = ['.js', '.mjs', '.cjs', '.ts'];
const STYLE = ['.css', '.scss', '.sass', '.less', '.pcss'];
const ALL = [...MARKUP, ...SCRIPT, ...STYLE];
// Files whose <style> blocks and style="" attributes hold CSS that the block rules read.
const HTML_LIKE = ['.html', '.htm', '.vue', '.svelte', '.astro'];
// CSS-in-JS files (style objects, template strings).
const JSX_FILES = ['.js', '.jsx', '.ts', '.tsx'];
// Files that can name a typeface.
const TYPE_MARKUP = ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.astro'];

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
// oklch(L C H) with L as a number or a percentage. Tailwind v4 emits this form.
export function oklchIn(line) {
  const out = [];
  for (const m of line.matchAll(/oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/gi)) {
    out.push({ text: m[0], L: +m[1] / (m[2] ? 100 : 1), C: +m[3], H: +m[4] });
  }
  return out;
}
const isOklchBeige = (o) => o.L >= 0.88 && o.C >= 0.008 && o.C <= 0.09 && o.H >= 50 && o.H <= 110;
const isOklchPurpleGrad = (o) => o.C >= 0.08 && o.H >= 265 && o.H <= 330;

export const isBeige = ([h, s, l]) => h >= 20 && h <= 65 && s >= 8 && l >= 82 && l <= 98.5;
export const isPurple = ([h, s, l]) => h >= 250 && h <= 300 && s >= 25 && l >= 15 && l <= 85;
// Used only by the gradient rule: indigo, violet and fuchsia stops.
export const isPurpleGrad = ([h, s, l]) => h >= 235 && h <= 310 && s >= 25 && l >= 15 && l <= 85;
const BEIGE_NAMES = /\b(beige|wheat|antiquewhite|linen|oldlace|cornsilk|bisque|blanchedalmond|papayawhip|floralwhite|navajowhite|moccasin)\b/i;
const TW_BEIGE = /\b(bg|from|via|to)-(stone|amber|orange|yellow)-(50|100)\b/;
const TW_PURPLE_GRAD = /\b(from|via|to)-(purple|violet|fuchsia|indigo)-\d{2,3}\b/;
const TW_PURPLE_ACCENT = /\b(bg|text|border|ring)-(purple|violet|indigo)-(400|500|600|700)\b/;
const PURPLE_MSG = 'Purple / violet gradient.';

// Every gradient(...) in text, with its balanced argument list. at is the index of "gradient(".
function gradientsIn(text) {
  const out = [];
  for (const m of text.matchAll(/gradient\(/gi)) {
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    while (i < text.length && depth > 0 && i - start < 2000) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    out.push({ at: m.index, args: text.slice(start, depth === 0 ? i - 1 : i) });
  }
  return out;
}
// The purple stop inside one gradient's arguments, or null.
function purpleIn(args) {
  const c = colorsIn(args).find((x) => isPurpleGrad(x.hsl));
  if (c) return c.text;
  const o = oklchIn(args).find(isOklchPurpleGrad);
  return o ? o.text : null;
}

// ---------- line rules ----------
// test(line, ctx) returns a short matched text or null. ctx = { i, lines } gives multi-line rules their neighbours.
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
  // ">05<" alone is usually table data, so it is collected and reported only when the file holds two or more values (see scan).
  { id: 'counter-01', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: '01 / 02 / 03 counters. Drop the numbering or use a real label.', aggregate: true,
    test: (l) => (l.match(/>\s*0[1-9]\s*(?:[<.\/]|$)/) || [])[0] },
  { id: 'counter-01', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: '01 / 02 / 03 counters. Drop the numbering or use a real label.',
    test: (l) => (l.match(/padStart\(\s*2\s*,\s*['"]0['"]\s*\)|\b(?:number|num|step|index|count)\s*:\s*['"]0[1-9]['"]|[`'"]0\$\{|\bdecimal-leading-zero\b/) || [])[0] },
  { id: 'eyebrow-label', sev: 'error', files: [...MARKUP, ...SCRIPT], msg: 'Eyebrow label (small uppercase tracked text above a heading).',
    test: (l) => classHas(l, [/\buppercase\b/, /\btracking-(wide|wider|widest|\[)/]) },
  { id: 'eyebrow-label', sev: 'error', files: JSX_FILES, msg: 'Eyebrow label (small uppercase tracked text above a heading).',
    test: (l, ctx) => {
      const m = l.match(/textTransform\s*:\s*['"]uppercase/);
      if (!m) return null;
      const lo = Math.max(0, ctx.i - 3), hi = Math.min(ctx.lines.length - 1, ctx.i + 3);
      for (let j = lo; j <= hi; j++) if (/letterSpacing\s*:/.test(ctx.lines[j])) return m[0];
      return null;
    } },
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
  { id: 'gradient-text', sev: 'error', files: JSX_FILES, msg: 'Gradient-filled headline text.',
    test: (l) => (l.match(/(Webkit)?[bB]ackgroundClip\s*:\s*['"]text/) || [])[0] },
  { id: 'sparkles-icon', sev: 'warn', files: [...MARKUP, ...SCRIPT], msg: 'Sparkles icon, the stock "AI" signifier.',
    test: (l) => (l.match(/<Sparkles\b|\bSparklesIcon\b|✨/) || [])[0] },
  { id: 'glass-card', sev: 'warn', files: [...MARKUP, ...SCRIPT], msg: 'Default glassmorphism card (backdrop blur on translucent white).',
    test: (l) => classHas(l, [/\bbackdrop-blur/, /\bbg-white\/(5|10|20)\b/]) },
  { id: 'beige', sev: 'error', files: ALL, msg: 'Beige / cream background.',
    test: (l) => {
      // The ban is on beige/cream SURFACES. A warm off-white used for text, lines or borders on a
      // dark ground is not that look, so only background-like properties (or unknown context) count.
      const ok = (hit) => (hit && !isNonSurfaceUse(l, hit) ? hit : null);
      if (BEIGE_NAMES.test(l) && /(color|background|bg|fill|--)/i.test(l)) { const r = ok(l.match(BEIGE_NAMES)[0]); if (r) return r; }
      if (TW_BEIGE.test(l)) return l.match(TW_BEIGE)[0];
      for (const c of colorsIn(l).filter((x) => isBeige(x.hsl))) { const r = ok(c.text); if (r) return r; }
      for (const o of oklchIn(l).filter(isOklchBeige)) { const r = ok(o.text); if (r) return r; }
      return null;
    } },
  { id: 'purple-gradient', sev: 'error', files: ALL, msg: PURPLE_MSG,
    test: (l) => {
      if (TW_PURPLE_GRAD.test(l) && /\b(bg-gradient|bg-linear|bg-radial|from-)/.test(l)) return l.match(TW_PURPLE_GRAD)[0];
      for (const g of gradientsIn(l)) { const hit = purpleIn(g.args); if (hit) return hit; }
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

// Movement that needs a reduced-motion path. Color/opacity-only transitions do not count.
const MOTION_TRANSITION = /\btransition(?:-property)?\s*:[^;}]*\b(transform|translate|scale|rotate|all|top|left|margin|height|width)\b|\btransition-(transform|all)\b/;
const isMotion = (t) => MOTION_CODE.test(t) || MOTION_TRANSITION.test(t);
const REDUCED = /prefers-reduced-motion|useReducedMotion|reducedMotion|motion-safe:|motion-reduce:/;
const GENERIC_FONTS = new Set(['inter', 'roboto', 'arial', 'helvetica', 'helvetica neue', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'sans-serif', 'serif', 'monospace', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'inherit', 'initial', 'var', 'open sans']);

// Custom properties: "--name: value" declarations, and var(--name) references.
const VAR_DECL = /(--[\w-]+)\s*:\s*([^;}{]+)/g;
const VAR_REF = /var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)/g;
function expandVars(s, vars) {
  let out = s;
  for (let pass = 0; pass < 3; pass++) {
    const next = out.replace(VAR_REF, (m, name) => (vars.has(name) ? vars.get(name) : m));
    if (next === out) break;
    out = next;
  }
  return out;
}

// The text a CSS block rule reads: a whole stylesheet or script, or for HTML-like files the
// text of each <style> element and each style="" attribute, so separate inline styles never combine.
function segmentsOf(text, ext) {
  if (!HTML_LIKE.includes(ext)) return [{ text, offset: 0 }];
  const segs = [];
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    segs.push({ text: m[1], offset: m.index + m[0].indexOf('>') + 1 });
  }
  for (const m of text.matchAll(/(?<![\w-])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const v = m[1] ?? m[2];
    segs.push({ text: v, offset: m.index + m[0].length - 1 - v.length });
  }
  return segs;
}

// Splits a segment on "}" into blocks, each with the absolute offset of its first non-space character.
function blocksOf(seg) {
  const out = [];
  let pos = seg.offset;
  for (const piece of seg.text.split('}')) {
    out.push({ text: piece, start: pos + (piece.length - piece.trimStart().length) });
    pos += piece.length + 1;
  }
  return out;
}

// Offset to 1-based line number for one file.
function lineMap(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

// The property a color value belongs to, from the text before it on the line ("--fg: #ECE9E2" -> "--fg",
// "color: rgba(...)" -> "color"). Text, line, border and shadow uses of a warm off-white are not a beige surface.
const NON_SURFACE_PROP = /^(color|caret-color|--(fg|text|ink|on|line|border|rule|stroke|outline|shadow|ring|focus|muted)[\w-]*|--[\w-]*-(fg|text|ink|line|border|stroke)(-[\w-]*)?|border[\w-]*|outline[\w-]*|stroke|text-decoration[\w-]*|box-shadow|text-shadow|column-rule[\w-]*|-webkit-text-fill-color)$/i;
function isNonSurfaceUse(line, hit) {
  const i = line.indexOf(hit);
  if (i < 0) return false;
  const m = /([-\w]+)\s*:[^:;{}]*$/.exec(line.slice(0, i));
  if (m) return NON_SURFACE_PROP.test(m[1]);
  return /\b(text|border|ring|stroke|outline|decoration|divide)-\[/.test(line.slice(Math.max(0, i - 20), i)); // Tailwind text-[#..]
}

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

// sha1 of the bans file's bytes, or null when there is no bans file.
export function bansSha1(path) {
  if (!path || !existsSync(path)) return null;
  return createHash('sha1').update(readFileSync(path)).digest('hex');
}

function loadBans(path) {
  if (!path || !existsSync(path)) return { allowed: [], extra: [] };
  const j = JSON.parse(readFileSync(path, 'utf8'));
  return { allowed: j.allowed || [], extra: j.extra || [], user_bans: j.user_bans || [] };
}

const finding = (r, file, line, hit) => ({ id: r.id, severity: r.sev, file, line, text: String(hit).slice(0, 80), message: r.msg });

// File path relative to root with '/' separators. Project-level findings keep '(project)'.
const PROJECT = '(project)';
const relPath = (file, root) => (file === PROJECT ? PROJECT : relative(root, resolve(root, file)).split(sep).join('/'));
const fingerprintOf = (f, root) => `${f.id}|${relPath(f.file, root)}|${f.text}`;

// opts: { baseline: report object or null, baselinePath: path shown in the report, exclude: [globs], cwd }
export function scan(targets, bansPath, opts = {}) {
  const cwd = resolve(opts.cwd || process.cwd());
  const exclude = (opts.exclude || []).map((g) => String(g).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
  const bans = loadBans(bansPath);
  const allowed = new Map();
  const findings = [];
  for (const a of bans.allowed) {
    // The quote must be words the user really typed (the guard hook logs prompts to cook/.ledger.jsonl).
    if (a && a.id && typeof a.quote === 'string' && a.quote.trim().length >= 8 && userSaid(projectRoot(dirname(resolve(bansPath))), a.quote)) allowed.set(a.id, a.quote);
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

  // Read everything first: custom properties are collected across all scanned files before any color test.
  const docs = files.map((f) => ({ f, ext: extname(f).toLowerCase(), text: readFileSync(f, 'utf8') }));
  const vars = new Map();
  for (const d of docs) for (const m of d.text.matchAll(VAR_DECL)) vars.set(m[1], m[2].trim());
  const expand = (s) => expandVars(s, vars);

  let anyMotion = false, anyReduced = false, markupScanned = false;
  const fams = new Set();
  // Fonts set through a CSS variable (next/font `variable:`, a design-token --font) or @font-face count as set:
  // the family name is not visible here, but a typeface was chosen.
  let fontsByVariable = false;
  for (const { f, ext, text } of docs) {
    if (isMotion(text)) anyMotion = true;
    if (REDUCED.test(text)) anyReduced = true;
    if (TYPE_MARKUP.includes(ext)) markupScanned = true;
    for (const x of fontFamilies(text)) fams.add(x);
    if (/font-family\s*:\s*var\(|next\/font|@font-face|--font[\w-]*\s*:/i.test(text)) fontsByVariable = true;

    // Line rules. A rule that misses the raw line gets a second try on the line with vars expanded.
    const lines = text.split('\n');
    const skipComments = SCRIPT.includes(ext) || STYLE.includes(ext);
    const counted = [];
    lines.forEach((line, i) => {
      if (skipComments && /^(\/\/|\*|\/\*)/.test(line.trim())) return;
      const probe = line.includes('var(') ? expand(line) : line;
      const ctx = { i, lines };
      for (const r of rules) {
        if (!r.files.includes(ext)) continue;
        const hit = r.test(line, ctx) || (probe !== line ? r.test(probe, ctx) : null);
        if (!hit) continue;
        if (r.aggregate) counted.push({ r, line: i + 1, hit });
        else findings.push(finding(r, f, i + 1, hit));
      }
    });
    if (new Set(counted.map((c) => c.hit.replace(/\D/g, ''))).size >= 2) {
      for (const c of counted) findings.push(finding(c.r, f, c.line, c.hit));
    }

    // Block rules: CSS, and the CSS parts of HTML-like files.
    const lineOf = lineMap(text);
    const segs = segmentsOf(text, ext);
    if (STYLE.includes(ext) || HTML_LIKE.includes(ext)) {
      for (const seg of segs) for (const b of blocksOf(seg)) for (const r of blockRules) {
        if (r.test(b.text)) findings.push({ id: r.id, severity: r.sev, file: f, line: lineOf(b.start), text: b.text.trim().split('{')[0].trim().slice(0, 80), message: r.msg });
      }
    }
    // Purple gradients may span lines: newlines become spaces (length kept), vars are expanded.
    // Skipped when the line rules already flagged this file.
    const lineIds = new Set(findings.filter((x) => x.file === f).map((x) => x.id));
    if (!allowed.has('purple-gradient') && !lineIds.has('purple-gradient')) {
      for (const seg of segs) {
        const flat = seg.text.replace(/[\r\n]/g, ' ');
        for (const g of gradientsIn(flat)) {
          const hit = purpleIn(expand(g.args));
          if (hit) findings.push({ id: 'purple-gradient', severity: 'error', file: f, line: lineOf(seg.offset + g.at), text: hit.slice(0, 80), message: PURPLE_MSG });
        }
      }
    }
  }

  if (anyMotion && !anyReduced && !allowed.has('reduced-motion')) {
    findings.push({ id: 'reduced-motion', severity: 'error', file: '(project)', line: 0, text: '', message: 'Animations exist but nothing honors prefers-reduced-motion.' });
  }
  const named = [...fams].filter((f) => !GENERIC_FONTS.has(f));
  if (files.length && !fams.size && markupScanned && !fontsByVariable && !allowed.has('default-typeface')) {
    findings.push({ id: 'default-typeface', severity: 'error', file: '(project)', line: 0, text: 'no typeface set', message: 'No font family is set. Pick type from the references.' });
  } else if (files.length && fams.size && !named.length && !allowed.has('default-typeface')) {
    findings.push({ id: 'default-typeface', severity: 'warn', file: '(project)', line: 0, text: [...fams].join(', '), message: 'Only default typefaces (Inter / Roboto / system). Pick type from the references.' });
  }
  if (named.length > 3 && !allowed.has('font-sprawl')) {
    findings.push({ id: 'font-sprawl', severity: 'warn', file: '(project)', line: 0, text: named.join(', '), message: 'More than 3 named typefaces.' });
  }
  // Fingerprints, scope and novelty. Project-level findings are always in scope.
  // Counted: a fingerprint that appears N times in the baseline allows its first N occurrences; extra ones are new.
  const base = opts.baseline && Array.isArray(opts.baseline.findings) ? opts.baseline : null;
  const baseCount = new Map();
  if (base) {
    for (const b of base.findings) {
      const fp = b.fingerprint || fingerprintOf(b, resolve(base.cwd || cwd));
      baseCount.set(fp, (baseCount.get(fp) || 0) + 1);
    }
  }
  const seen = new Map();
  for (const f of findings) {
    f.fingerprint = fingerprintOf(f, cwd);
    f.in_scope = f.file === PROJECT || !isExcluded(relPath(f.file, cwd), exclude);
    const n = (seen.get(f.fingerprint) || 0) + 1;
    seen.set(f.fingerprint, n);
    f.is_new = base ? n > (baseCount.get(f.fingerprint) || 0) : true;
  }
  const newFp = findings.filter((f) => f.is_new).map((f) => f.fingerprint);
  const remaining = findings.filter((f) => !f.is_new).map((f) => f.fingerprint);
  const fixed = [];
  for (const [fp, n] of baseCount) for (let i = seen.get(fp) || 0; i < n; i++) fixed.push(fp);

  const errors = findings.filter((x) => x.severity === 'error').length;
  // An error fails when it is in scope, or when it is new (an excluded error that already existed does not fail).
  const failing = findings.some((x) => x.severity === 'error' && (x.in_scope || x.is_new));
  return { ok: !failing && files.length > 0, scanned: files.length, errors, warnings: findings.length - errors,
    allowed_by_user: [...allowed.entries()].map(([id, quote]) => ({ id, quote })),
    baseline: opts.baselinePath || null, exclude, new: newFp, fixed, remaining,
    bans_sha1: bansSha1(bansPath), findings, cwd, at: new Date().toISOString() };
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
  const skip = new Set(['--out', '--bans', '--baseline', '--exclude']);
  const targets = argv.filter((a, i) => !a.startsWith('--') && !skip.has(argv[i - 1]));
  if (!targets.length) { console.error('usage: node slop_scan.mjs <dir-or-file>... [--out report.json] [--bans cook/bans.json] [--baseline report.json] [--exclude <glob>]... [--json]'); process.exit(2); }
  const baselinePath = opt('--baseline');
  let baseline = null;
  if (baselinePath) {
    try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch (e) { console.error(`cannot read --baseline ${baselinePath}: ${e.message}`); process.exit(2); }
  }
  const exclude = argv.flatMap((a, i) => (a === '--exclude' && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const report = scan(targets, bansPath, { baseline, baselinePath, exclude, cwd: process.cwd() });
  report.targets = targets.map((t) => resolve(t));
  const out = opt('--out');
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const f of report.findings) {
      const tags = [baselinePath && f.is_new ? 'NEW' : '', f.in_scope ? '' : 'EXCLUDED'].filter(Boolean).join(' ');
      console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.id.padEnd(17)} ${relative(process.cwd(), f.file) || f.file}:${f.line}  ${f.text}  -> ${f.message}${tags ? `  [${tags}]` : ''}`);
    }
    for (const a of report.allowed_by_user) console.log(`ALLOW ${a.id.padEnd(17)} user said: "${a.quote}"`);
    console.log(`\n${report.ok ? 'CLEAN' : 'SLOP FOUND'}: ${report.errors} errors, ${report.warnings} warnings in ${report.scanned} files`);
    console.log(`Baseline: ${report.new.length} new, ${report.fixed.length} fixed, ${report.remaining.length} remaining${baselinePath ? '' : ' (no --baseline: every finding is new)'}`);
    if (out) console.log(`Report: ${out}`);
    if (!report.scanned) console.log('Nothing was scanned: check the path.');
  }
  process.exit(report.ok ? 0 : 1);
}
