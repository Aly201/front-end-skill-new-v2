#!/usr/bin/env node
// The step gate. Nothing in frontend-cook moves forward on a claim: every step has
// requirements checked here before it starts (check) and proof checked here before
// it counts as done (verify). State lives in cook/GATES.json.
//
// Commands (run from the project root):
//   init --project <name>                 create cook/GATES.json (needs a passing cook/PREFLIGHT.json)
//   init --project <name> --mode redesign --src <dir> [--src ...] --url <base url>
//                                         [--exclude <glob> ...] [--pages /,/pricing]
//                                         an existing site: steps include 0b (baseline)
//   set-pages /,/pricing                  pages that matter (each gets stills, inventory, audit)
//   set-checks --cmd "npm test" [--cmd ...]   commands that must keep passing (replaces the list)
//   set-strategy --in-place | --rebuild --quote "<user words>"
//   motion-allow <file> <hash> --reason "..."   allow one existing animation line (hash from motion.json)
//   allow-dirty --quote "<user words>"    the baseline may be taken on a dirty tree
//   status                                every step, its state and the next step
//   check <step>                          may this step start? (previous steps passed, inputs present)
//   verify <step>                         is this step done? marks it passed only when every proof holds
//   approve <mockup|static|final|baseline> --quote "<user's exact words>"
//   override <step> --quote "<user's exact words>" --reason "<why>"   user takes responsibility, logged
//   reopen <step>                         set this step and every later one back to pending
//   set-bar --judge 9.2 --floor 8.5 --similarity 99 [--mockup 8] [--quote "..."]
//                                         --quote: any bar below 9.0 / 8.5 / 8, or any lowering
//   set-time (--floor 3h | --cap 1.5h) [--quote "..."]
//                                         --quote: a cap, a floor under 2h, or a lower floor
//   set-build --src <dir> --url <url or file>
//   set-motion (--none --quote "..." | --refs)
//   no-feedback --quote "..."           the user saw the stills and wants no changes (step 7)
//   score <round>                         median of the judge files in cook/judge/<round>/, calibrated
//   calibrate --user <score 0-10> --quote "<user's words with that number>"
//   elapsed                               hours since the timer started
//
// Steps: 0 setup, 1 references, 2 mockup, 3 bar, 4 time, 5 bans, 6a static build,
//        6b motion, 7 feedback, 8 separate judge.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname, basename, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isMain, projectRoot, readJson, mtime, walk, newestMtime, imageSize, median, STATE_DIR, MOTION_CODE, FRONTEND_EXT, readLedger, activeHours, userSaid, motionHits, pageSlug } from './_common.mjs';

export const STEPS = ['0', '1', '2', '3', '4', '5', '6a', '6b', '7', '8'];
// An existing site (mode redesign) starts with the baseline, step 0b.
export const STEPS_REDESIGN = ['0', '0b', '1', '2', '3', '4', '5', '6a', '6b', '7', '8'];
export function stepsFor(g) { return g?.mode === 'redesign' ? STEPS_REDESIGN : STEPS; }
export const STEP_NAMES = {
  0: 'Setup: cook skill, Inspo MCP, Awwwards MCP, browser',
  '0b': 'Baseline: capture, keep list and probes',
  1: 'Strong references (9 to 12)',
  2: 'Target mockup',
  3: 'Bar set as numbers',
  4: 'Time set',
  5: 'Slop bans set',
  '6a': 'Static build',
  '6b': 'Motion pass',
  7: 'Specific feedback closed',
  8: 'Separate judge',
};
export const DIMS = ['layout', 'typography', 'color', 'components', 'imagery', 'responsive'];
export const MOTION_DIM = 'motion';
const IMG = ['.png', '.jpg', '.jpeg', '.webp'];
const SRC_EXT = ['.html', '.htm', '.css', '.scss', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.json', '.svg', '.md', '.mdx'];

const root = projectRoot();
const S = (...p) => join(root, STATE_DIR, ...p);
const GATES = S('GATES.json');

function load() {
  const g = readJson(GATES);
  if (!g) fail(`No ${STATE_DIR}/GATES.json here or above. Run: node gate.mjs init --project <name>`);
  return g;
}
function save(g) { writeFileSync(GATES, JSON.stringify(g, null, 2) + '\n'); }
function fail(msg) { console.error(`gate: ${msg}`); process.exit(2); }
const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
// Every value of a repeatable option: --src a --src b gives ['a', 'b'].
const optAll = (k) => argv.flatMap((a, i) => (a === k && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
const quoteOk = (q) => typeof q === 'string' && q.trim().length >= 8;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// True when the number appears as a number of its own (not inside 99% or 9.25).
const numberIn = (text, n) => new RegExp(`(^|[^\\d.])${escapeRe(n)}(?![\\d.])`).test(text || '');
// Rounds in calibration order: the baseline (the old site) first, then the mockup, then r01, r02...
const roundRank = (r) => (r === 'baseline' ? -2 : r === 'mockup' ? -1 : Number(String(r).replace(/^r/i, '')));
// Pages: '/' , '/pricing' or full URLs. Duplicates are dropped.
function parsePages(v) {
  const list = [...new Set(String(v ?? '').split(',').map((p) => p.trim()).filter(Boolean))];
  if (!list.length) fail('pages: list them comma-separated, e.g. /,/pricing');
  const bad = list.filter((p) => !(p.startsWith('/') || /^https?:\/\//i.test(p)));
  if (bad.length) fail(`pages must start with / or be full URLs: ${bad.join(', ')}`);
  return list;
}
function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
// The lines under one "## <name>" heading of a markdown file (up to the next heading of level 1 to 3).
function sectionOf(md, name) {
  const out = [];
  let on = false;
  for (const l of String(md).split('\n')) {
    const h = /^(#{1,3})\s+(.+?)\s*$/.exec(l);
    if (h) { on = h[1] === '##' && h[2].toLowerCase() === name.toLowerCase(); continue; }
    if (on) out.push(l);
  }
  return out.join('\n');
}
// The "## " headings of a markdown file, lower-cased.
function h2Set(md) {
  return new Set(String(md).split('\n').map((l) => /^##\s+(.+?)\s*$/.exec(l)).filter(Boolean).map((m) => m[1].toLowerCase()));
}

// The user's exact words: 8+ characters that the user typed in this project. The guard hook
// logs the user's prompts to the ledger; the words must appear there.
function needUserWords(q) {
  if (!quoteOk(q)) fail('this needs the user\'s exact words in --quote (8+ characters). Never write them yourself.');
  if (!readLedger(root).some((e) => e.tool === 'UserPrompt')) fail('guard hook is not logging prompts: run /frontend-cook-setup and restart');
  if (!userSaid(root, q)) fail('these words are not in any message the user typed in this project. Paste their exact words; never write them yourself.');
}

// ---------------- proof helpers ----------------
function brief() { try { return readFileSync(S('BRIEF.md'), 'utf8'); } catch { return ''; } }
function briefLine(label) { const m = brief().match(new RegExp(`^\\s*${label}\\s*:(.*)$`, 'mi')); return m ? m[1].trim() : null; }
function srcFiles(g) {
  if (!g.build?.src) return [];
  return walk(resolve(root, g.build.src), SRC_EXT);
}
function mockupFiles() { return walk(S('mockup'), SRC_EXT); }
function images(dir) { try { return readdirSync(dir).filter((f) => IMG.includes(extname(f).toLowerCase())).map((f) => join(dir, f)); } catch { return []; } }
function rounds() {
  try { return readdirSync(S('judge')).filter((d) => /^r\d{2,}$/.test(d)).sort(); } catch { return []; }
}
export function latestRound() { const r = rounds(); return r.length ? r[r.length - 1] : null; }
function report(name) { return readJson(S('reports', name)); }
function hoursElapsed(g) { return g.time?.started ? (Date.now() - Date.parse(g.time.started)) / 3600000 : 0; }
// The stills a person approves: the mockup's, or the latest round's.
function stillsFor(kind) {
  if (kind === 'mockup') return S('stills', 'mockup');
  if (kind === 'baseline') return S('baseline', 'stills');
  const r = latestRound();
  return r ? S('stills', r) : null;
}

// The build URL the audit must have run on: http(s)/file URLs as given, a folder means its index.html.
function buildUrl(g) {
  const u = g.build?.url;
  if (!u) return null;
  if (/^(https?|file):/i.test(u)) return u;
  let p = resolve(root, u);
  try { if (statSync(p).isDirectory()) p = join(p, 'index.html'); } catch { /* missing: compared as the file path */ }
  return pathToFileURL(p).href;
}
// A file with bytes in it, or a folder with something in it.
function nonEmpty(p) {
  try { const s = statSync(p); return s.isDirectory() ? readdirSync(p).length > 0 : s.size > 0; } catch { return false; }
}
// A side-by-side must be at least as new as the newest source file it compares.
function compareCheck(dir, newest, okMsg, missingMsg) {
  const cmp = (() => { try { return readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => join(dir, f)); } catch { return []; } })();
  if (!cmp.length) return [false, missingMsg];
  if (newestMtime(cmp) < newest) return [false, 'side-by-side is older than the latest source change: rebuild it from the new stills'];
  return [true, okMsg];
}

function refIds() {
  const ids = new Map();
  for (const f of images(S('refs'))) {
    const m = /^(R\d{2,})(?:[-_][\w-]+)?\.\w+$/i.exec(basename(f));
    if (m) { const id = m[1].toUpperCase(); if (!ids.has(id)) ids.set(id, []); ids.get(id).push(f); }
  }
  return ids;
}
function videoRefs() { try { return readdirSync(S('refs')).filter((f) => /^V\d{2,}.*\.(mp4|webm|mov|gif)$/i.test(f)); } catch { return []; } }

// Each check returns [ok, message].
const C = {
  stepPassed: (g, s) => [['passed', 'overridden'].includes(g.steps[s]?.status), `step ${s} (${STEP_NAMES[s]}) is ${g.steps[s]?.status || 'pending'}`],
  preflight: () => {
    const p = readJson(S('PREFLIGHT.json'));
    if (!p) return [false, 'cook/PREFLIGHT.json missing: run preflight.mjs --write'];
    const ageDays = (Date.now() - Date.parse(p.checked_at)) / 86400000;
    const failed = Object.entries(p.checks || {}).filter(([, c]) => !c.ok).map(([k]) => k);
    return [p.ok && ageDays < 7, p.ok ? (ageDays < 7 ? `preflight passed ${ageDays.toFixed(1)} days ago` : 'preflight is older than 7 days: run it again') : `preflight failed: ${failed.join(', ')}`];
  },
  file: (p, label) => [existsSync(p), `${label} ${existsSync(p) ? 'exists' : 'missing'} (${relative(root, p)})`],
  newer: (p, than, label) => {
    const a = mtime(p);
    return [a > 0 && a >= than, a === 0 ? `${label} missing (${relative(root, p)})` : a >= than ? `${label} is newer than the latest source change` : `${label} is OLDER than the latest source change: it does not show the current build. Redo it.`];
  },
  // expect: { target } for a slop report (the folder it must have scanned), { url } for an audit (the build URL).
  reportOk: (name, than, label, expect = {}) => {
    const r = report(name);
    const p = S('reports', name);
    if (!r) return [false, `${label} report missing (cook/reports/${name})`];
    if (mtime(p) < than) return [false, `${label} report is older than the latest source change: run it again`];
    if (expect.target !== undefined && !(r.scanned > 0 && (r.targets || []).includes(expect.target))) {
      const x = (r.targets || []).map((t) => relative(root, t)).join(', ') || 'nothing';
      return [false, `${label}: the slop report scanned ${x}, not the build folder`];
    }
    if (expect.url !== undefined && r.url !== expect.url) {
      return [false, `${label}: the audit ran on ${r.url || 'nothing'}, not the build (${expect.url ?? 'no build URL set'})`];
    }
    return [r.ok === true, r.ok ? `${label}: clean (${r.warnings} warnings)` : `${label}: ${r.errors} errors. Fix them, then run it again`];
  },
  approval: (g, k) => {
    const a = g.approvals?.[k];
    if (!a || !quoteOk(a.quote)) return [false, `user has not approved the ${k} yet (needs their words in chat, then: gate.mjs approve ${k} --quote "...")`];
    if (a.shown === undefined) return [false, `the ${k} approval has no record of the stills it saw: show the stills and approve again`];
    const dir = stillsFor(k);
    const newest = dir ? newestMtime(images(dir)) : 0;
    if (newest > a.shown) return [false, 'stills changed after the approval: show the new ones and ask again'];
    return [true, `user approved ${k}: "${a.quote}"`];
  },
};

function summaryFor(round) { return readJson(S('judge', round, 'summary.json')); }
function judgeFilesIn(round) {
  try { return readdirSync(S('judge', round)).filter((f) => f.endsWith('.json') && f !== 'summary.json'); } catch { return []; }
}
// The ledger entry that wrote a judge file (the first one: a judge file is written once).
function judgeWriter(ledger, round, file) {
  const rel = `cook/judge/${round}/${file}`;
  return ledger.find((e) => e.file === rel) || null;
}

// Sessions that edited the build, the mockup or the project: the builders. A judge session
// reads only the judge files and writes only its own judge file.
function builderSessions(ledger) {
  const ids = new Set();
  for (const e of ledger) {
    if (!e.session_id || e.tool === 'UserPrompt') continue;
    if (e.tool === 'Bash') {
      if (/(gate|shoot|audit|slop_scan|side-by-side)\.mjs/.test(e.cmd || '')) ids.add(e.session_id);
      continue;
    }
    if (!(e.file || '').startsWith('cook/judge/')) ids.add(e.session_id);
  }
  return ids;
}

// Every judge file must come through the guard hook, and the builder never judges itself.
function judgeProvenance(round) {
  const ledger = readLedger(root);
  if (!ledger.length) return [[false, 'no ledger: the guard hook is not installed (run /frontend-cook-setup)']];
  const files = judgeFilesIn(round);
  const builders = builderSessions(ledger);
  const hasAgents = ledger.some((e) => e.agent != null);
  const unlogged = [], selfWritten = [];
  for (const f of files) {
    const w = judgeWriter(ledger, round, f);
    if (!w) { unlogged.push(f); continue; }
    if (hasAgents && w.agent == null && builders.has(w.session_id)) selfWritten.push(f);
  }
  return [
    [files.length > 0 && unlogged.length === 0, unlogged.length ? `no ledger Write entry for ${unlogged.join(', ')}: a judge writes its own judge file through the guard hook` : (files.length ? 'every judge file was written through the guard hook' : `no judge files in ${round}`)],
    [selfWritten.length === 0, selfWritten.length ? `${selfWritten.join(', ')} written by the builder itself, not by a judge` : 'no judge file was written by the builder itself'],
  ];
}

function judgeChecks(g, round, stage, than) {
  const out = [];
  out.push(...judgeProvenance(round));
  const s = summaryFor(round);
  if (!s) { out.push([false, `no judge summary for ${round}: have 2+ fresh judges write cook/judge/${round}/*.json, then run gate.mjs score ${round}`]); return out; }
  const p = S('judge', round, 'summary.json');
  out.push([mtime(p) >= than, mtime(p) >= than ? `judge summary ${round} is current` : `judge summary ${round} is older than the latest source change: judge the current build`]);
  // Summary must be newer than every judge file in the folder.
  const jpaths = judgeFilesIn(round).map((f) => S('judge', round, f));
  out.push([mtime(p) >= newestMtime(jpaths), mtime(p) >= newestMtime(jpaths) ? 'summary includes every judge file' : `a judge file changed after scoring: run gate.mjs score ${round}`]);
  // Every judge file must be at least as new as the build it judged.
  const stale = jpaths.filter((f) => mtime(f) < than).map((f) => basename(f));
  out.push([stale.length === 0, stale.length ? `${stale.join(', ')} is older than the latest source change: judge the current build in a new round` : 'every judge file is newer than the latest source change']);
  out.push([s.judges >= 2, `${s.judges} fresh judge(s) (need 2+)`]);
  const spreadMsg = s.spread_ok ? `judges agree within 1.0 (spread ${s.spread_overall})`
    : (s.judges >= 3 ? `the lowest judge (${s.lowest_overall}) is more than 1.0 under the median (${s.raw.overall}): fix what it named`
      : `judges disagree by ${s.spread_overall}: add another fresh judge, then score again`);
  out.push([s.spread_ok, spreadMsg]);
  if (stage === 'mockup') {
    out.push([s.calibrated.overall >= g.target.mockup, `mockup feel ${s.calibrated.overall}/10 calibrated (needs ${g.target.mockup})`]);
    return out;
  }
  const dims = stage === 'static' ? DIMS : (g.motion === 'none' ? DIMS : [...DIMS, MOTION_DIM]);
  out.push([s.calibrated.overall >= g.target.judge, `overall ${s.calibrated.overall}/10 calibrated (bar ${g.target.judge}, offset ${s.offset})`]);
  for (const d of dims) {
    const v = s.calibrated.dims[d];
    out.push([typeof v === 'number' && v >= g.target.floor, `${d} ${v ?? 'not scored'} (floor ${g.target.floor})`]);
  }
  return out;
}

// ---------------- requirements to START a step ----------------
function startChecks(g, step) {
  const i = stepsFor(g).indexOf(step);
  const out = [];
  for (const prev of stepsFor(g).slice(0, i)) out.push(C.stepPassed(g, prev));
  if (step !== '0') out.push(C.preflight());
  if (step === '6b' && g.motion !== 'none') {
    const motionDir = (() => { try { return readdirSync(S('refs', 'motion')).length > 0; } catch { return false; } })();
    const why = g.motion === 'refs' ? 'set-motion --refs' : existsSync(S('MOTION.md')) ? 'cook/MOTION.md'
      : videoRefs().length > 0 ? 'video references (cook/refs/V01...)' : motionDir ? 'cook/refs/motion' : null;
    out.push([why !== null, why ? `motion source: ${why}` : 'say where motion comes from: gate.mjs set-motion --refs (or --none with the user\'s words)']);
  }
  return out;
}

// ---------------- redesign: step 0b, the baseline of the old site ----------------
const VIEWPORTS = ['desktop', 'mobile'];
const KEEP_HEADINGS = ['Keep', 'Dropped', 'Copy changes', 'Motion'];
function baselineChecks(g) {
  const out = [];
  const B = (...p) => S('baseline', ...p);
  const pages = g.pages?.length ? g.pages : ['/'];
  const meta = readJson(B('meta.json'));
  for (const f of ['meta.json', 'inventory.json', 'motion.json', 'checks.json', 'slop.json']) out.push(C.file(B(f), `baseline ${f}`));
  const inv = readJson(B('inventory.json'));
  const missingInv = pages.filter((p) => !inv?.pages?.[p]);
  out.push([Boolean(inv) && missingInv.length === 0, !inv ? 'baseline inventory.json is not readable'
    : missingInv.length ? `baseline inventory has no entry for ${missingInv.join(', ')}` : `baseline inventory covers every page (${pages.join(', ')})`]);
  // Stills: every page, both viewports, full and folded.
  const stills = [];
  for (const p of pages) for (const vp of VIEWPORTS) for (const fold of ['', '-fold']) {
    const rel = `${pageSlug(p)}-${vp}${fold}.png`;
    if (!existsSync(B('stills', rel))) stills.push(`cook/baseline/stills/${rel}`);
  }
  out.push(stills.length ? [false, `baseline stills missing: ${stills.join(', ')}`]
    : [true, `baseline stills exist for every page (${pages.length}), desktop and mobile, full and fold`]);
  const audits = pages.map((p) => `audit-${pageSlug(p)}.json`).filter((f) => !existsSync(B(f)));
  out.push(audits.length ? [false, `baseline audits missing: ${audits.map((f) => `cook/baseline/${f}`).join(', ')}`]
    : [true, 'a baseline audit exists for every page']);
  // A dirty tree is the user's choice, with their words.
  if (meta?.dirty === true) out.push([quoteOk(g.dirty_quote), quoteOk(g.dirty_quote)
    ? `baseline taken on a dirty tree, the user said: "${g.dirty_quote}"`
    : 'baseline was taken on a dirty tree without the user\'s words: gate.mjs allow-dirty --quote "..."']);
  else out.push([Boolean(meta), meta ? 'baseline taken on a clean tree' : 'baseline meta.json is not readable']);
  // KEEP.md: the four headings, and every motion hit classified in the Motion section.
  if (!existsSync(B('KEEP.md'))) out.push([false, 'cook/baseline/KEEP.md missing (write the keep list with the user: Keep, Dropped, Copy changes, Motion)']);
  else {
    const keep = readText(B('KEEP.md'));
    const heads = h2Set(keep);
    const noHead = KEEP_HEADINGS.filter((h) => !heads.has(h.toLowerCase()));
    out.push(noHead.length ? [false, `KEEP.md is missing ${noHead.map((h) => `## ${h}`).join(', ')}`]
      : [true, 'KEEP.md has the four headings: Keep, Dropped, Copy changes, Motion']);
    const hits = Array.isArray(readJson(B('motion.json'))) ? readJson(B('motion.json')) : [];
    const motionLines = sectionOf(keep, 'Motion').split('\n');
    const unclassified = hits.filter((h) => !motionLines.some((l) => l.includes(h.hash) && /functional|decorative/i.test(l) && /keep|replace|remove/i.test(l)));
    out.push(unclassified.length ? [false, `motion hits not classified in KEEP.md ## Motion (functional or decorative, keep, replace or remove): ${unclassified.slice(0, 5).map((h) => `${h.file}:${h.line}`).join(', ')}`]
      : [true, `every motion hit (${hits.length}) is classified in KEEP.md ## Motion`]);
  }
  // Probes: one per form, each one fills or clicks something, and each page with a form has one.
  const probes = readJson(B('probes.json'));
  if (!Array.isArray(probes)) out.push([false, 'cook/baseline/probes.json missing or not a JSON array (one probe per form: templates/probes.example.json)']);
  else {
    const acting = probes.filter((p) => Array.isArray(p?.steps) && p.steps.some((s) => s && (s.fill || s.click)));
    const formsBy = Object.entries(inv?.pages || {}).map(([page, p]) => [page, (p?.forms || []).length]).filter(([, n]) => n > 0);
    const total = formsBy.reduce((a, [, n]) => a + n, 0);
    out.push([acting.length >= total, `${acting.length} probe(s) that fill or click, for ${total} form(s) in the inventory (need one per form)`]);
    for (const [page, n] of formsBy) {
      const ok = acting.some((p) => p.page === page);
      out.push([ok, ok ? `a probe covers the form(s) on ${page}` : `no probe on ${page} for its ${n} form(s): add one to cook/baseline/probes.json with "page": "${page}"`]);
    }
  }
  out.push(C.approval(g, 'baseline'));
  return out;
}

// Redesign, verify 2: every h1 and form field of the old site is in the mockup, or waived under Dropped / Copy changes.
function redesignMockupChecks() {
  const out = [];
  const inv = readJson(S('baseline', 'inventory.json'));
  if (!inv?.pages) return [[false, 'baseline inventory missing: nothing to check the mockup against (verify 0b first)']];
  const html = readText(S('mockup', 'index.html')).toLowerCase();
  const keep = readText(S('baseline', 'KEEP.md'));
  const waived = `${sectionOf(keep, 'Dropped')}\n${sectionOf(keep, 'Copy changes')}`.toLowerCase();
  const missing = [];
  let terms = 0;
  for (const [page, p] of Object.entries(inv.pages)) {
    const names = [
      ...(p?.headings || []).filter((h) => h.level === 1).map((h) => h.text),
      ...(p?.forms || []).flatMap((f) => (f.fields || []).map((x) => x.name)),
    ].map((t) => String(t ?? '').trim()).filter(Boolean);
    for (const t of new Set(names)) {
      terms++;
      const k = t.toLowerCase();
      if (!html.includes(k) && !waived.includes(k)) missing.push(`"${t}" (${page})`);
    }
  }
  out.push(missing.length === 0 ? [true, `mockup covers the baseline: ${terms} h1 and form field name(s) found in cook/mockup or waived in KEEP.md`]
    : [false, `mockup does not cover the baseline: missing ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` and ${missing.length - 12} more` : ''}. Keep them, or list them under Dropped / Copy changes in KEEP.md`]);
  const three = images(S('compare', 'mockup')).filter((f) => /three|3way/i.test(basename(f)));
  out.push(three.length ? [true, `three-way sheet: ${basename(three[0])} (old site, mockup, closest reference)`]
    : [false, 'no three-way sheet in cook/compare/mockup (name it with "three" or "3way": old site, mockup, closest reference)']);
  return out;
}

// ---------------- proof that a step is DONE ----------------
function doneChecks(g, step) {
  const out = [];
  switch (step) {
    case '0': out.push(C.preflight()); break;
    case '0b': out.push(...baselineChecks(g)); break;
    case '1': {
      out.push(C.file(S('BRIEF.md'), 'BRIEF.md'));
      const lines = brief().split('\n').filter((l) => l.trim()).length;
      out.push([lines > 0 && lines <= 40, `BRIEF.md is ${lines} lines (keep it short: 40 max, the references carry the look)`]);
      out.push([briefLine('Target') !== null, 'BRIEF.md has a "Target:" line']);
      out.push([briefLine("User's words") !== null, 'BRIEF.md has a "User\'s words:" line']);
      if (g.mode === 'redesign') {
        const kept = nonEmpty(S('compare', 'baseline'));
        out.push([kept, kept ? 'cook/compare/baseline has the old site beside a reference' : 'cook/compare/baseline is empty: put the old site beside a reference there (reference left, old site right)']);
        const bs = summaryFor('baseline');
        out.push([(bs?.judges ?? 0) >= 2, bs ? `baseline scored by ${bs.judges} judge(s) (need 2+)` : 'no judge summary for the baseline: have 2+ fresh judges write cook/judge/baseline/*.json, then gate.mjs score baseline']);
        out.push(...judgeProvenance('baseline'));
        out.push([briefLine('Keep') !== null, 'BRIEF.md has a "Keep:" line (what must survive the redesign)']);
      }
      const ids = refIds();
      out.push([ids.size >= 9 && ids.size <= 12, `${ids.size} reference(s) in cook/refs (need 9 to 12, named R01...)`]);
      for (const [id, files] of ids) {
        const best = files.map(imageSize).filter(Boolean).sort((a, b) => b.width - a.width)[0];
        out.push([Boolean(best && best.width >= 1200 && best.height >= 600), `${id}: ${best ? `${best.width}x${best.height}` : 'unreadable'} (need 1200x600+, real captures, not thumbnails)`]);
      }
      const src = (() => { try { return readFileSync(S('refs', 'SOURCES.md'), 'utf8'); } catch { return ''; } })();
      const kinds = {}, hosts = new Set();
      let missing = [];
      for (const id of ids.keys()) {
        const line = src.split('\n').find((l) => new RegExp(`\\b${id}\\b`, 'i').test(l));
        if (!line) { missing.push(id); continue; }
        const k = (line.match(/\b(user|inspo|awwwards|web)\b/i) || [])[1]?.toLowerCase();
        if (!k) { missing.push(id); continue; }
        kinds[k] = (kinds[k] || 0) + 1;
        const u = line.match(/https?:\/\/([^/\s|)]+)/);
        hosts.add(u ? u[1].replace(/^www\./, '') : `${k}:${id}`);
      }
      out.push([missing.length === 0 && ids.size > 0, missing.length ? `SOURCES.md has no source (user/inspo/awwwards/web) for: ${missing.join(', ')}` : 'every reference has a source in refs/SOURCES.md']);
      out.push([hosts.size >= 3, `references come from ${hosts.size} different sites (need 3+: take from many, copy none)`]);
      if ((kinds.user || 0) < ids.size) {
        out.push([(kinds.inspo || 0) >= 1 && (kinds.awwwards || 0) >= 1, `found references: inspo ${kinds.inspo || 0}, awwwards ${kinds.awwwards || 0} (use both libraries for what the user did not supply)`]);
        // The libraries must have been called, not just named in SOURCES.md: the guard logs MCP calls.
        const pf = readJson(S('PREFLIGHT.json')) || {};
        const mcpCalls = readLedger(root).map((e) => e.tool).filter((t) => typeof t === 'string' && t.startsWith('mcp__'));
        const callsTo = (key, fallback) => {
          const name = pf.checks?.[`mcp_${key}`]?.name;
          return mcpCalls.filter((t) => (name ? t.startsWith(`mcp__${name}__`) : fallback.test(t))).length;
        };
        const nInspo = callsTo('inspo', /inspo/i), nAwwwards = callsTo('awwwards', /awwwards/i);
        out.push([nInspo > 0 && nAwwwards > 0, nInspo > 0 && nAwwwards > 0
          ? 'Inspo and Awwwards tool calls are logged'
          : `no Inspo/Awwwards tool call is logged: the libraries were not used (Inspo calls logged: ${nInspo}, Awwwards calls logged: ${nAwwwards})`]);
      }
      // Two reference files that are the same image (same size, same bytes) are one reference, not two.
      const seen = new Map(), dupes = [];
      for (const [id, files] of ids) {
        for (const f of files) {
          let key;
          try { key = `${statSync(f).size}:${createHash('sha1').update(readFileSync(f)).digest('hex')}`; } catch { continue; }
          if (seen.has(key) && seen.get(key) !== id) dupes.push(`${seen.get(key)} and ${id}`);
          else seen.set(key, id);
        }
      }
      out.push([dupes.length === 0, dupes.length ? `${dupes.join('; ')} are the same image: each reference must be a different capture` : 'no two references are the same image']);
      const shots = (() => { try { return readFileSync(S('SHOTS.md'), 'utf8'); } catch { return ''; } })();
      const noShot = [...ids.keys()].filter((id) => !new RegExp(`\\b${id}\\b`, 'i').test(shots));
      out.push([shots.length > 0 && noShot.length === 0, noShot.length ? `SHOTS.md does not cover: ${noShot.join(', ')}` : 'SHOTS.md covers every reference with what to take from it']);
      break;
    }
    case '2': {
      const files = mockupFiles();
      const newest = newestMtime(files);
      out.push(C.file(S('mockup', 'index.html'), 'mockup'));
      const single = walk(S('mockup'), FRONTEND_EXT);
      out.push([single.length === 1, single.length === 1 ? 'mockup is a single file' : `the mockup must be a single file (one .html with its CSS and JS inside), found ${single.length} frontend files`]);
      const st = images(S('stills', 'mockup'));
      for (const vp of ['desktop', 'mobile']) {
        const f = st.find((p) => basename(p).includes(vp));
        out.push(f ? C.newer(f, newest, `mockup ${vp} still`) : [false, `mockup ${vp} still missing (shoot.mjs cook/mockup --out cook/stills/mockup --name mockup)`]);
      }
      out.push(compareCheck(S('compare', 'mockup'), newest, 'side-by-side with the references exists', 'no side-by-side in cook/compare/mockup (cook/scripts/side-by-side.mjs)'));
      out.push(C.reportOk('slop-mockup.json', newest, 'slop scan of the mockup', { target: resolve(S('mockup')) }));
      const anim = motionCodeIn(files);
      out.push([anim.length === 0, anim.length ? `animation code in the mockup (it must be static): ${anim.join(', ')}` : 'mockup is static']);
      if (g.mode === 'redesign') out.push(...redesignMockupChecks());
      out.push(...judgeChecks(g, 'mockup', 'mockup', newest));
      out.push(C.approval(g, 'mockup'));
      break;
    }
    case '3': {
      const t = g.target || {};
      out.push([Boolean(t.judge), `bar set: judge ${t.judge}/10, floor ${t.floor}, similarity stretch ${t.similarity}%`]);
      const weak = t.judge < 9 || t.floor < 8.5 || t.mockup < 8 || t.similarity < 99;
      out.push([!weak || quoteOk(t.lowered_by_user), !weak ? 'bar is at or above the defaults (9.0 overall, 8.5 floor, 8 mockup, 99% similarity)'
        : (quoteOk(t.lowered_by_user) ? `bar lowered below the defaults by the user: "${t.lowered_by_user}"` : 'bar is below the defaults without the user\'s words: gate.mjs set-bar ... --quote "..."')]);
      const bar = briefLine('Bar');
      const barOk = Boolean(bar) && numberIn(bar, t.judge) && numberIn(bar, t.floor);
      out.push([barOk, !bar ? `BRIEF.md has no "Bar:" line` : barOk ? `BRIEF.md Bar: ${bar}` : `BRIEF.md Bar line must show ${t.judge} and ${t.floor} as numbers (a bare "99%" is not "9"): ${bar}`]);
      if (g.mode === 'redesign') {
        out.push([t.delta === true, t.delta === true ? 'the bar carries the baseline rule (target.delta)' : 'the bar has no baseline rule yet: run gate.mjs set-bar']);
        const bs = summaryFor('baseline');
        out.push(bs ? [true, `no dimension may end below the baseline (baseline overall ${bs.raw?.overall}, cook/judge/baseline/summary.json)`]
          : [false, 'no dimension may end below the baseline: cook/judge/baseline/summary.json missing (score the baseline)']);
      }
      break;
    }
    case '4': {
      const t = g.time || {};
      out.push([Boolean(t.started && t.mode), t.mode ? `time: ${t.mode} ${t.hours}h, started ${t.started}` : 'time not set (gate.mjs set-time --floor 3h)']);
      if (t.mode) {
        const needWords = t.mode === 'cap' || t.hours < 2;
        out.push([!needWords || quoteOk(t.quote), !needWords ? `time floor ${t.hours}h`
          : (quoteOk(t.quote) ? `${t.mode} ${t.hours}h, the user's words: "${t.quote}"` : `a ${t.mode} of ${t.hours}h needs the user's words (gate.mjs set-time ... --quote "...")`)]);
      }
      out.push([briefLine('Time') !== null, 'BRIEF.md has a "Time:" line']);
      break;
    }
    case '5': {
      out.push(C.file(S('bans.json'), 'bans file'));
      const b = readJson(S('bans.json'), {});
      const bad = (b.allowed || []).filter((a) => !quoteOk(a.quote) || !userSaid(root, a.quote));
      out.push([bad.length === 0, bad.length ? `bans switched off without the user's own words (typed in this project): ${bad.map((a) => a.id).join(', ')}` : 'every switched-off ban has the user\'s words']);
      out.push([briefLine('Bans') !== null, 'BRIEF.md has a "Bans:" line']);
      break;
    }
    case '6a': {
      out.push([Boolean(g.build?.src && g.build?.url), g.build?.src ? `build: ${g.build.src} served at ${g.build.url}` : 'build not set (gate.mjs set-build --src <dir> --url <url>)']);
      const files = srcFiles(g);
      out.push([files.length > 0, `${files.length} source files in the build`]);
      const newest = newestMtime(files);
      const r = latestRound();
      out.push([Boolean(r), r ? `latest round ${r}` : 'no round yet (cook/judge/r01/...)']);
      if (!r) break;
      out.push(...roundEvidence(g, r, newest, false));
      const anim = motionCodeIn(files);
      out.push([anim.length === 0, anim.length ? `animation code in the static build (motion waits for step 6b): ${anim.slice(0, 5).join(', ')}` : 'no animation code in the static build (hover/focus transitions only)']);
      out.push(...judgeChecks(g, r, 'static', newest));
      out.push(C.approval(g, 'static'));
      break;
    }
    case '6b': {
      if (g.motion === 'none') { out.push([quoteOk(g.motion_quote), `no motion, user said: "${g.motion_quote || ''}"`]); break; }
      const motion = (() => { try { return readFileSync(S('MOTION.md'), 'utf8'); } catch { return ''; } })();
      const rows = motion.split('\n').filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|?\s*$/.test(l) && !/^\s*\|\s*(Ref|Effect|Reference)\b/i.test(l) && !/\|\s*\[[^\]|]+\]\s*\|/.test(l));
      out.push([rows.length >= 5, `MOTION.md lists ${rows.length} effect(s) (need 5+ table rows)`]);
      const evidence = (() => { try { return readdirSync(S('refs', 'motion')); } catch { return []; } })();
      const refsDir = (() => { try { return readdirSync(S('refs')); } catch { return []; } })();
      const srcs = srcFiles(g);
      const cited = new Set();
      let vague = 0, unsourced = [];
      for (const row of rows) {
        const cells = row.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
        const id = (cells[0] || '').toUpperCase();
        const how = cells[3] || '';
        if (!/\d+(\.\d+)?\s*(ms|s)\b/i.test(how) || !/(ease|cubic-bezier|linear|spring|power\d|expo|sine|quad|cubic|quart|quint|circ|back|elastic|steps)/i.test(how)) vague++;
        if (!/^(R|V)\d{2,}$/.test(id)) { unsourced.push(id || '(empty)'); continue; }
        cited.add(id);
      }
      out.push([vague === 0 && rows.length > 0, vague ? `${vague} effect(s) without a measured duration and easing in the "How" column (e.g. "700ms, cubic-bezier(.2,.7,.2,1), 24px up")` : 'every effect has a duration and an easing']);
      out.push([unsourced.length === 0, unsourced.length ? `effects not tied to a reference id (R01 / V01): ${[...new Set(unsourced)].join(', ')}` : 'every effect cites a reference']);
      out.push([cited.size >= 2, `effects taken from ${cited.size} reference(s) (need 2+: take from many, copy none)`]);
      const anim = motionCodeIn(srcs);
      out.push([anim.length > 0, anim.length ? `animation code in the build: ${anim.slice(0, 3).join(', ')}` : 'the build has no animation code yet']);
      for (const id of cited) {
        // Evidence, non-empty: the user's video (refs/V01.*), a recording, or any tool's extraction output in
        // refs/motion/<ID>*. The id must be followed by a non-digit: R030 is not evidence for R03.
        const idRe = new RegExp('^' + id + '(?!\\d)', 'i');
        const found = [
          ...refsDir.filter((f) => idRe.test(f) && /\.(mp4|webm|mov|gif)$/i.test(f)).map((f) => S('refs', f)),
          ...evidence.filter((f) => idRe.test(f)).map((f) => S('refs', 'motion', f)),
        ].filter(nonEmpty);
        out.push([found.length > 0, found.length ? `${id}: motion evidence ${found.slice(0, 3).map((p) => basename(p)).join(', ')}` : `${id}: no motion evidence. Save what you extracted (recording, frames, get_motion_dna / analyze_scroll_map output, any tool's notes) as cook/refs/motion/${id}-<what>.<ext>`]);
      }
      const newest = newestMtime(srcs);
      const r = latestRound();
      if (!r) { out.push([false, 'no round yet']); break; }
      out.push(...roundEvidence(g, r, newest, true));
      out.push(...judgeChecks(g, r, 'motion', newest));
      break;
    }
    case '7': {
      const led = (() => { try { return readFileSync(S('ROUNDS.md'), 'utf8'); } catch { return ''; } })();
      out.push([/^##\s+Round\s+\d+/m.test(led), 'ROUNDS.md has round entries']);
      const inbox = (led.split(/^##\s+User feedback inbox/m)[1] || '').split(/^(?:##|---)/m)[0];
      const items = inbox.split('\n').filter((l) => /^\s*-\s+\S/.test(l) && !/\[quote\]/.test(l));
      const open = items.filter((l) => /\|\s*open\b/i.test(l));
      const sections = (() => { try { return readFileSync(S('SECTIONS.md'), 'utf8'); } catch { return ''; } })();
      const known = new Set([...sections.matchAll(/^#+\s*S(\d+)\b/gm)].map((m) => `S${Number(m[1])}`));
      if (items.length === 0) out.push([quoteOk(g.no_feedback_quote), g.no_feedback_quote ? `no changes requested, user said: "${g.no_feedback_quote}"` : 'no feedback recorded. Send the stills and SECTIONS.md and ask for feedback; if the user wants no changes: gate.mjs no-feedback --quote "<their words>"']);
      for (const l of items) {
        const ids = [...l.split(/proof:/i)[0].matchAll(/\bS(\d+)\b/g)].map((m) => `S${Number(m[1])}`);
        const ok = ids.length > 0 && ids.every((x) => known.has(x));
        out.push([ok, ok ? `feedback pinned to ${ids.join(', ')}` : `feedback not pinned to a section in SECTIONS.md (write S1, S2...): ${l.trim().slice(0, 60)}`]);
      }
      out.push([open.length === 0, open.length ? `${open.length} open feedback item(s): ${open.map((l) => l.trim().slice(0, 70)).join(' / ')}` : `${items.length} feedback item(s), none open`]);
      for (const l of items.filter((x) => /\|\s*done\b/i.test(x))) {
        const pr = (l.match(/proof:\s*([^\s|]+)/i) || [])[1];
        out.push([Boolean(pr && existsSync(resolve(root, pr))), pr ? `proof ${pr} ${existsSync(resolve(root, pr)) ? 'exists' : 'MISSING'}` : `done without proof: ${l.trim().slice(0, 70)}`]);
      }
      const newest = newestMtime(srcFiles(g));
      out.push(C.newer(S('SECTIONS.md'), newest, 'SECTIONS.md (the build described section by section)'));
      break;
    }
    case '8': {
      const files = srcFiles(g);
      const newest = newestMtime(files);
      const r = latestRound();
      if (!r) { out.push([false, 'no round yet']); break; }
      out.push(...roundEvidence(g, r, newest, g.motion !== 'none'));
      out.push(...judgeChecks(g, r, 'final', newest));
      // Separate judge, proven by the guard hook's ledger: a judge file in this round written
      // by a session that never edited the build, the mockup or the project.
      const ledger = readLedger(root);
      const builders = builderSessions(ledger);
      const separate = judgeFilesIn(r).filter((f) => {
        const w = judgeWriter(ledger, r, f);
        return Boolean(w && w.session_id && !builders.has(w.session_id));
      });
      out.push([ledger.length > 0, ledger.length ? 'guard hook ledger present' : 'no ledger: the guard hook is not installed (run /frontend-cook-setup)']);
      out.push([separate.length > 0, separate.length ? `separate-session judge verified: ${separate.join(', ')}` : `no judge file in ${r} was written from a separate session (one that never edited the build). Open a new Claude Code session here and run /frontend-cook-judge ${r}`]);
      const sepMed = median(separate.map((f) => readJson(S('judge', r, f))?.overall));
      const sepCal = sepMed === null ? null : Math.round((sepMed + g.calibration.offset) * 100) / 100;
      out.push([sepCal !== null && sepCal >= g.target.judge, sepCal === null ? 'no separate judge score to check' : `the separate judge scored ${sepCal} calibrated: it must meet the bar on its own (bar ${g.target.judge})`]);
      if (g.time?.mode === 'floor') {
        const act = activeHours(ledger.filter((e) => e.tool !== 'UserPrompt' && (builders.has(e.session_id) || (e.file || '').startsWith('cook/'))));
        out.push([act >= g.time.hours, `${act.toFixed(1)}h of active work logged (floor ${g.time.hours}h; idle gaps over 15 min do not count). Done before the floor means the bar was read too low`]);
        const n = rounds().filter((x) => (summaryFor(x)?.judges ?? 0) >= 2).length;
        out.push([n >= 3, `${n} judged round(s) with 2+ judges (need 3+ before shipping)`]);
      }
      out.push(C.approval(g, 'final'));
      break;
    }
    default: fail(`unknown step ${step}. Steps: ${stepsFor(g).join(', ')}`);
  }
  return out;
}

// Files (and first line) that contain animation code.
function motionCodeIn(files) {
  const hits = [];
  for (const f of files) {
    if (!FRONTEND_EXT.includes(extname(f).toLowerCase())) continue;
    const lines = readFileSync(f, 'utf8').split('\n');
    const i = lines.findIndex((l) => MOTION_CODE.test(l));
    if (i >= 0) hits.push(`${relative(root, f)}:${i + 1}`);
  }
  return hits;
}

function roundEvidence(g, r, newest, needVideo) {
  const out = [];
  const st = images(S('stills', r));
  for (const vp of ['desktop', 'mobile']) {
    const f = st.filter((p) => basename(p).includes(vp)).sort((a, b) => mtime(a) - mtime(b))[0];
    out.push(f ? C.newer(f, newest, `${r} ${vp} stills`) : [false, `${r} ${vp} stills missing (shoot.mjs <url> --out cook/stills/${r} --name S01)`]);
  }
  if (needVideo) {
    let vids = []; try { vids = readdirSync(S('stills', r)).filter((f) => f.endsWith('-motion.webm')).map((f) => S('stills', r, f)); } catch { /* none */ }
    out.push(vids.length ? C.newer(vids[0], newest, `${r} motion recording`) : [false, `${r} motion recording missing (shoot.mjs <url> --out cook/stills/${r} --name S01 --live --video 12)`]);
  }
  out.push(compareCheck(S('compare', r), newest, `${r} side-by-side exists`, `${r} side-by-side missing (cook/compare/${r}/)`));
  out.push(C.reportOk(`slop-${r}.json`, newest, `${r} slop scan`, { target: g.build?.src ? resolve(root, g.build.src) : null }));
  out.push(C.reportOk(`audit-${r}.json`, newest, `${r} audit`, { url: buildUrl(g) }));
  return out;
}

function print(title, checks) {
  console.log(title);
  for (const [ok, msg] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  const bad = checks.filter(([ok]) => !ok).length;
  console.log(bad ? `\n${bad} requirement(s) not met.` : '\nAll requirements met.');
  return bad === 0;
}

function nextStep(g) { return stepsFor(g).find((s) => !['passed', 'overridden'].includes(g.steps[s]?.status)) || null; }

// ---------------- score ----------------
export function scoreRound(dir, offset = 0) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'summary.json');
  const judges = [];
  const problems = [];
  for (const f of files) {
    const j = readJson(join(dir, f));
    if (!j) { problems.push(`${f}: not valid JSON`); continue; }
    if (j.fresh !== true) { problems.push(`${f}: not marked fresh:true (a judge must have no build context)`); continue; }
    if (typeof j.overall !== 'number' || j.overall < 0 || j.overall > 10) { problems.push(`${f}: overall must be 0-10`); continue; }
    const badDim = Object.entries(j.scores || {}).find(([, v]) => typeof v !== 'number' || v < 0 || v > 10);
    if (badDim) { problems.push(`${f}: score ${badDim[0]} must be 0-10`); continue; }
    if (!Array.isArray(j.gaps) || j.gaps.length < 3) { problems.push(`${f}: a judge must name at least 3 specific gaps (where, what, fix)`); continue; }
    judges.push({ file: f, ...j });
  }
  const r1 = (n) => (n === null ? null : Math.round(n * 100) / 100);
  const overalls = judges.map((j) => j.overall);
  const dims = {};
  for (const d of [...DIMS, MOTION_DIM]) { const m = median(judges.map((j) => j.scores?.[d])); if (m !== null) dims[d] = r1(m); }
  const raw = { overall: r1(median(overalls)), dims, similarity: r1(median(judges.map((j) => j.similarity))) };
  const cal = { overall: raw.overall === null ? null : r1(raw.overall + offset), dims: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, r1(v + offset)])) };
  const spread = overalls.length ? r1(Math.max(...overalls) - Math.min(...overalls)) : null;
  const lowest = overalls.length ? Math.min(...overalls) : null;
  // Two judges: they must agree within 1.0. Three or more: the lowest judge may be at most 1.0 under the median.
  const spreadOk = judges.length === 2 ? spread <= 1.0 : (judges.length >= 3 && raw.overall - lowest <= 1.0);
  const models = new Set(judges.map((j) => `${j.model || 'unknown'}|${j.session || 'subagent'}`));
  const gaps = judges.flatMap((j) => (j.gaps || []).map((x) => ({ judge: j.judge || j.file, ...x })));
  return {
    judges: judges.length, problems, raw, offset, calibrated: cal,
    spread_overall: spread, lowest_overall: lowest, spread_ok: spreadOk,
    different_model: judges.some((j) => j.different_model === true || j.session === 'separate'),
    models: [...models], weakest: Object.entries(cal.dims).sort((a, b) => a[1] - b[1])[0] || null,
    slop_seen: [...new Set(judges.flatMap((j) => j.slop_seen || []))],
    gaps, at: new Date().toISOString(),
  };
}

// ---------------- CLI ----------------
const isMainRun = isMain(import.meta.url);
if (isMainRun) {
  const [cmd, a1] = argv;
  switch (cmd) {
    case 'init': {
      if (existsSync(GATES)) fail('cook/GATES.json already exists. Use status, or move cook/ to cook-archive/<date>/ to start over.');
      const project = opt('--project');
      if (!project) fail('init needs --project <name>');
      const mode = opt('--mode', 'new');
      if (!['new', 'redesign'].includes(mode)) fail('init --mode new|redesign');
      const srcs = optAll('--src'), excludes = optAll('--exclude');
      const url = opt('--url');
      const pagesArg = opt('--pages');
      const pages = pagesArg === null ? ['/'] : parsePages(pagesArg);
      if (mode === 'new' && (srcs.length || excludes.length || url !== null)) fail('--src, --exclude and --url are for init --mode redesign');
      if (mode === 'redesign') {
        if (!srcs.length || !url) fail('init --mode redesign needs --src <dir> (repeat for more folders) and --url <base url of the running site>');
        const missing = srcs.filter((s) => !existsSync(resolve(root, s)));
        if (missing.length) fail(`source folder not found: ${missing.join(', ')}`);
      }
      mkdirSync(S(), { recursive: true });
      const g = {
        version: 1, project, created: new Date().toISOString(), mode,
        target: { judge: 9.2, floor: 8.5, similarity: 99, mockup: 8.0 },
        time: null, build: null, motion: null, pages,
        calibration: { offset: 0, history: [] },
        approvals: {}, overrides: {},
      };
      if (mode === 'redesign') { g.scope = { src: srcs, exclude: excludes }; g.build = { src: srcs[0], url }; }
      g.steps = Object.fromEntries(stepsFor(g).map((s) => [s, { status: 'pending' }]));
      save(g);
      const pre = C.preflight();
      if (pre[0]) { g.steps['0'] = { status: 'passed', at: new Date().toISOString(), evidence: [pre[1]] }; save(g); }
      console.log(`created cook/GATES.json for "${project}". Step 0: ${pre[0] ? 'passed' : 'NOT passed: ' + pre[1]}`);
      break;
    }
    case 'status': {
      const g = load();
      console.log(`Project: ${g.project}   Bar: ${g.target.judge}/10 (floor ${g.target.floor})   Calibration offset: ${g.calibration.offset}`);
      if (g.mode === 'redesign') console.log(`Mode: redesign of an existing site (baseline first). Pages: ${(g.pages || ['/']).join(', ')}`);
      if (g.time) console.log(`Time: ${g.time.mode} ${g.time.hours}h, ${hoursElapsed(g).toFixed(1)}h elapsed`);
      for (const s of stepsFor(g)) {
        const st = g.steps[s] || { status: 'pending' };
        console.log(`  ${s.padEnd(3)} ${st.status.toUpperCase().padEnd(10)} ${STEP_NAMES[s]}${st.status === 'overridden' ? `  (user: "${g.overrides[s]?.quote}")` : ''}`);
      }
      const r = latestRound();
      if (r) { const s = summaryFor(r); if (s) console.log(`Latest round ${r}: overall ${s.calibrated.overall} calibrated, weakest ${s.weakest?.join(' ')}`); }
      const n = nextStep(g);
      console.log(n ? `\nNext: step ${n} (${STEP_NAMES[n]}). Run: gate.mjs check ${n}` : '\nAll steps passed.');
      break;
    }
    case 'check': {
      const g = load();
      if (!stepsFor(g).includes(a1)) fail(`check needs a step: ${stepsFor(g).join(', ')}`);
      process.exit(print(`May step ${a1} (${STEP_NAMES[a1]}) start?`, startChecks(g, a1)) ? 0 : 1);
      break;
    }
    case 'verify': {
      const g = load();
      if (!stepsFor(g).includes(a1)) fail(`verify needs a step: ${stepsFor(g).join(', ')}`);
      const pre = startChecks(g, a1);
      const done = doneChecks(g, a1);
      const ok = print(`Is step ${a1} (${STEP_NAMES[a1]}) done?`, [...pre, ...done]);
      if (ok) {
        g.steps[a1] = { status: 'passed', at: new Date().toISOString(), evidence: done.map(([, m]) => m) };
        // The baseline's commit and tree state travel with the gates, for the final report and the regress check.
        if (a1 === '0b') { const m = readJson(S('baseline', 'meta.json')) || {}; g.baseline = { commit: m.commit ?? null, dirty: m.dirty === true, at: m.at ?? null }; }
        save(g); console.log(`Step ${a1} marked PASSED.`);
      }
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'approve': {
      const g = load();
      if (!['mockup', 'static', 'final', 'baseline'].includes(a1)) fail('approve mockup|static|final|baseline --quote "<user words>"');
      const q = opt('--quote');
      needUserWords(q);
      // The approval is tied to the stills the user saw: a newer still makes it stale.
      const dir = stillsFor(a1);
      const imgs = dir ? images(dir) : [];
      const where = { mockup: 'cook/stills/mockup', baseline: 'cook/baseline/stills' }[a1] || 'cook/stills/<round>';
      if (!imgs.length) fail(`no stills to approve yet for ${a1}: show the user the stills first (${where})`);
      g.approvals[a1] = { quote: q, at: new Date().toISOString(), shown: newestMtime(imgs) };
      save(g);
      console.log(`recorded ${a1} approval: "${q}"`);
      break;
    }
    case 'override': {
      const g = load();
      if (!stepsFor(g).includes(a1) || a1 === '0') fail('override <step 1-8> --quote "<user words>" --reason "<why>" (setup cannot be overridden: the other skills are required)');
      const q = opt('--quote'), reason = opt('--reason');
      if (!reason) fail('an override needs a --reason');
      needUserWords(q);
      g.overrides[a1] = { quote: q, reason, at: new Date().toISOString(), unmet: doneChecks(g, a1).filter(([ok]) => !ok).map(([, m]) => m) };
      g.steps[a1] = { status: 'overridden', at: new Date().toISOString() };
      save(g);
      console.log(`step ${a1} OVERRIDDEN by the user. Logged unmet requirements:\n  ${g.overrides[a1].unmet.join('\n  ') || '(none)'}\nThis stays in the final report.`);
      break;
    }
    case 'reopen': {
      const g = load();
      const steps = stepsFor(g);
      const i = steps.indexOf(a1); if (i < 0) fail('reopen <step>');
      for (const s of steps.slice(i)) g.steps[s] = { status: 'pending' };
      if (i <= steps.indexOf('0b')) delete g.approvals.baseline;
      if (i <= steps.indexOf('2')) delete g.approvals.mockup;
      if (i <= steps.indexOf('6a')) delete g.approvals.static;
      delete g.approvals.final;
      save(g);
      console.log(`steps ${steps.slice(i).join(', ')} set back to pending`);
      break;
    }
    case 'set-bar': {
      const g = load();
      const t = g.target;
      const judge = Number(opt('--judge', t.judge));
      const floor = Number(opt('--floor', t.floor));
      const sim = Number(opt('--similarity', t.similarity));
      const mock = Number(opt('--mockup', t.mockup));
      if (![judge, floor, sim, mock].every(Number.isFinite)) fail('numbers only');
      if (floor < 0) fail('the floor cannot be below 0');
      if (judge > 10) fail('the bar cannot be above 10');
      if (floor > judge) fail('floor cannot be above the bar');
      const lowering = judge < t.judge || floor < t.floor || sim < t.similarity || mock < t.mockup;
      const needQuote = lowering || judge < 9 || floor < 8.5 || mock < 8;
      const q = opt('--quote');
      if (needQuote) {
        if (!quoteOk(q)) fail('a bar below 9.0 (or 8.5 floor, 8 mockup), or any lowering, needs the user\'s words: --quote "..."');
        needUserWords(q);
      }
      // In redesign mode no dimension may end below the baseline: the bar carries that rule.
      const delta = g.mode === 'redesign' || t.delta === true ? { delta: true } : {};
      g.target = { judge, floor, similarity: sim, mockup: mock, ...delta, ...(needQuote ? { lowered_by_user: q } : t.lowered_by_user ? { lowered_by_user: t.lowered_by_user } : {}) };
      save(g);
      console.log(`bar: overall ${judge}/10, every dimension ${floor}+, similarity stretch ${sim}%, mockup feel ${mock}/10`);
      break;
    }
    case 'set-time': {
      const g = load();
      const parseH = (v) => { const m = /^(\d+(?:\.\d+)?)\s*(h|m)?$/i.exec(v || ''); return m ? (m[2]?.toLowerCase() === 'm' ? +m[1] / 60 : +m[1]) : null; };
      const floor = parseH(opt('--floor')), cap = parseH(opt('--cap'));
      if ((floor === null) === (cap === null)) fail('set-time needs exactly one of --floor <hours> or --cap <hours>');
      const hours = floor ?? cap;
      if (!(hours > 0)) fail('set-time hours must be more than 0');
      const lowersFloor = floor !== null && g.time?.mode === 'floor' && floor < g.time.hours;
      const needQuote = cap !== null || (floor !== null && floor < 2) || lowersFloor;
      const q = opt('--quote');
      if (needQuote) {
        if (!quoteOk(q)) fail('a cap, a floor under 2 hours, or a lower floor needs the user\'s words: --quote "..."');
        needUserWords(q);
      }
      g.time = { mode: floor !== null ? 'floor' : 'cap', hours, started: g.time?.started || new Date().toISOString(), ...(needQuote ? { quote: q } : {}) };
      save(g);
      console.log(`time: ${g.time.mode} ${g.time.hours}h, started ${g.time.started}`);
      break;
    }
    case 'set-build': {
      const g = load();
      const src = opt('--src'), url = opt('--url');
      if (!src || !url) fail('set-build --src <dir> --url <url or file>');
      if (!existsSync(resolve(root, src))) fail(`source folder not found: ${src}`);
      g.build = { src, url }; save(g);
      console.log(`build: ${src} at ${url}`);
      break;
    }
    case 'set-pages': {
      const g = load();
      g.pages = parsePages(a1);
      save(g);
      console.log(`pages: ${g.pages.join(', ')}`);
      break;
    }
    case 'set-checks': {
      const g = load();
      const cmds = optAll('--cmd').map((c) => c.trim()).filter(Boolean);
      if (!cmds.length) fail('set-checks --cmd "npm test" [--cmd "npm run build"] (replaces the list)');
      g.checks = cmds;
      save(g);
      console.log(`checks that must keep passing: ${cmds.join(' ; ')}`);
      break;
    }
    case 'set-strategy': {
      const g = load();
      if (argv.includes('--rebuild')) {
        const q = opt('--quote');
        needUserWords(q);
        g.strategy = 'rebuild'; g.strategy_quote = q;
      } else if (argv.includes('--in-place')) {
        g.strategy = 'in-place'; delete g.strategy_quote;
      } else fail('set-strategy --in-place | --rebuild --quote "<user words>"');
      save(g);
      console.log(`strategy: ${g.strategy}`);
      break;
    }
    case 'motion-allow': {
      const g = load();
      const file = a1, hash = argv[2];
      if (!file || !hash || hash.startsWith('--')) fail('motion-allow <file> <hash> --reason "..." (the hash is in cook/baseline/motion.json)');
      const reason = opt('--reason');
      if (!reason || !reason.trim()) fail('motion-allow needs a --reason (why this existing motion is functional)');
      const abs = resolve(root, file);
      let text = null;
      try { text = readFileSync(abs, 'utf8'); } catch { /* missing */ }
      if (text === null) fail(`file not found: ${file}`);
      const rel = relative(root, abs).split(sep).join('/');
      const hits = motionHits(text, extname(abs).toLowerCase());
      if (!hits.some((h) => h.hash === hash)) fail(`${rel} has no animation line with hash ${hash}. Hashes in this file: ${hits.map((h) => `${h.hash} (line ${h.line})`).join(', ') || 'none'}`);
      g.motion_allow = [...(g.motion_allow || []).filter((a) => !(a.file === rel && a.hash === hash)), { file: rel, hash, reason: reason.trim() }];
      save(g);
      console.log(`allowed ${rel} line hash ${hash}: ${reason.trim()}`);
      break;
    }
    case 'allow-dirty': {
      const g = load();
      const q = opt('--quote');
      needUserWords(q);
      g.dirty_quote = q; save(g);
      console.log(`recorded: the baseline may be taken on a dirty tree: "${q}"`);
      break;
    }
    case 'set-motion': {
      const g = load();
      if (argv.includes('--none')) {
        const q = opt('--quote');
        needUserWords(q);
        g.motion = 'none'; g.motion_quote = q;
      } else g.motion = 'refs';
      save(g); console.log(`motion: ${g.motion}`);
      break;
    }
    case 'no-feedback': {
      const g = load();
      const q = opt('--quote');
      needUserWords(q);
      g.no_feedback_quote = q; save(g);
      console.log(`recorded: user wants no changes: "${g.no_feedback_quote}"`);
      break;
    }
    case 'score': {
      const g = load();
      if (!a1) fail('score <round> (mockup, r01, r02, ...)');
      const dir = S('judge', a1);
      if (!existsSync(dir)) fail(`no folder cook/judge/${a1}`);
      const s = scoreRound(dir, g.calibration.offset);
      s.round = a1;
      writeFileSync(join(dir, 'summary.json'), JSON.stringify(s, null, 2) + '\n');
      for (const p of s.problems) console.log(`REJECTED ${p}`);
      console.log(`${a1}: ${s.judges} judge(s). Overall raw ${s.raw.overall}, calibrated ${s.calibrated.overall} (offset ${s.offset}), spread ${s.spread_overall}${s.spread_ok ? '' : ' -> ADD A JUDGE'}`);
      for (const [d, v] of Object.entries(s.calibrated.dims)) console.log(`  ${d.padEnd(11)} ${v}${v < g.target.floor ? '  BELOW FLOOR' : ''}`);
      if (s.raw.similarity !== null) console.log(`  similarity  ${s.raw.similarity}% (stretch ${g.target.similarity}%)`);
      if (s.weakest) console.log(`Weakest: ${s.weakest[0]} ${s.weakest[1]}`);
      const bar = a1 === 'mockup' ? g.target.mockup : g.target.judge;
      console.log(s.calibrated.overall >= bar ? `At or above the bar (${bar}).` : `Below the bar (${bar}). Not done.`);
      break;
    }
    case 'calibrate': {
      const g = load();
      const raw = opt('--user');
      const user = Number(raw);
      if (raw === null || !Number.isFinite(user) || user < 0 || user > 10) fail('calibrate --user <0-10> --quote "<user words with that number>"');
      const q = opt('--quote');
      needUserWords(q);
      if (!numberIn(q, raw)) fail(`the user's words must contain their number (${raw}), e.g. "I rate it ${raw} out of 10"`);
      const r = opt('--round') || latestRound() || (existsSync(S('judge', 'mockup', 'summary.json')) ? 'mockup' : null);
      const s = r && summaryFor(r);
      if (s?.raw?.overall === null || s?.raw?.overall === undefined) fail('no scored round to calibrate against: run gate.mjs score <round> first');
      // The offset never raises a score above the judges: it is 0 or lower.
      const next = Math.round(Math.min(0, user - s.raw.overall) * 100) / 100;
      const cur = g.calibration.offset;
      const last = g.calibration.history.at(-1)?.round;
      const newer = last !== undefined && roundRank(r) > roundRank(last);
      if (next < cur || (newer && next !== cur)) {
        g.calibration.offset = next;
        g.calibration.history.push({ at: new Date().toISOString(), round: r, user, judges: s.raw.overall, offset: next, quote: q });
        save(g);
        console.log(`calibration offset now ${next}${newer && next >= cur ? ` (re-based on ${r})` : ''}: every score is lowered by ${-next} from now on. Rescore open rounds with gate.mjs score <round>.`);
      } else if (next === cur) {
        console.log(`offset stays ${cur}`);
      } else {
        g.calibration.history.push({ at: new Date().toISOString(), round: r, user, judges: s.raw.overall, offset: cur, note: 'user higher than judges: not applied' });
        save(g);
        console.log(`Not applied. You rate it ${user}, the judges ${s.raw.overall}. Scores are never raised to match a kinder estimate: the gaps the judges named still stand. Offset stays ${cur}.`);
      }
      if (10 + g.calibration.offset < g.target.judge) console.log(`WARNING: with this offset the bar cannot be reached; ask the user to rate the next round`);
      break;
    }
    case 'elapsed': { const g = load(); console.log(`${hoursElapsed(g).toFixed(2)}h${g.time ? ` of ${g.time.mode} ${g.time.hours}h` : ' (timer not set)'}`); break; }
    default:
      console.log('usage: gate.mjs init|status|check|verify|approve|override|reopen|set-bar|set-time|set-build|set-motion|set-pages|set-checks|set-strategy|motion-allow|allow-dirty|score|calibrate|elapsed (see the header of this file)');
      process.exit(cmd ? 2 : 0);
  }
}
