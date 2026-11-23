#!/usr/bin/env node
// The step gate. Nothing in frontend-cook moves forward on a claim: every step has
// requirements checked here before it starts (check) and proof checked here before
// it counts as done (verify). State lives in cook/GATES.json.
//
// Commands (run from the project root):
//   init --project <name> [--type landing|site|app|component] [--languages en,ar]
//                                         create cook/GATES.json (needs a passing cook/PREFLIGHT.json)
//   init --project <name> --mode redesign --src <dir> [--src ...] --url <base url>
//                                         [--exclude <glob> ...] [--pages /,/pricing]
//                                         an existing site: steps include 0b (baseline)
//   set-pages /,/pricing                  pages that matter (each gets stills, inventory, audit)
//   set-type <landing|site|app|component> the project type: reference count, industry refs, motion and time (PROFILES)
//   set-languages en,ar                   languages the site ships in; a right-to-left one needs a passing rtl journey
//   set-checks --cmd "npm test" [--cmd ...]   commands that must keep passing (replaces the list)
//   set-strategy --in-place | --rebuild --quote "<user words>"
//   motion-allow <file> <hash> --reason "..." --quote "<user words>"
//                                         allow one existing animation line (hash from motion.json)
//   motion-allow <file> --text '<line>' --reason "..." --quote "<user words>"
//                                         allow a line before it is written (its hash is stored)
//   allow-dirty --quote "<user words>"    the baseline may be taken on a dirty tree
//   status                                every step, its state and the next step
//   check <step>                          may this step start? (previous steps passed, inputs present)
//   verify <step>                         is this step done? marks it passed only when every proof holds
//   approve <mockup|static|final|baseline|references> --quote "<user's exact words>"
//   no-user-refs --quote "..."         the user was asked for references and has none (step 1)
//   override <step> --quote "<user's exact words>" --reason "<why>"   user takes responsibility, logged
//   reopen <step>                         set this step and every later one back to pending
//   set-bar --judge 9.2 --floor 8.5 --similarity 99 [--mockup 8] [--quote "..."]
//                                         --quote: any bar below 9.0 / 8.5 / 8, or any lowering
//   set-time [--floor 3h | --cap 1.5h] [--quote "..."]
//                                         no flag: the type's default time (landing 3h floor, component 1h cap)
//                                         --quote: a cap, a floor under 2h, or a lower floor
//   set-build --src <dir> --url <url or file>
//   set-motion (--none --quote "..." | --refs)
//   no-feedback --quote "..."           the user saw the stills and wants no changes (step 7)
//   archive-judges <round>              move a round's judge files to an archive folder (to re-judge new work)
//   score <round>                         median of the judge files in cook/judge/<round>/, calibrated
//   calibrate --user <score 0-10> --quote "<user's words with that number>"
//   elapsed                               hours since the timer started
//   report                                final report, written to cook/REPORT.md (steps, overrides, redesign
//                                         before and after, slop and audit counts, Dropped, motion allowances)
//
// Steps: 0 setup, 1 references, 2 mockup, 3 bar, 4 time, 5 bans, 6a static build,
//        6b motion, 7 feedback, 8 separate judge.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, resolve, extname, basename, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isMain, projectRoot, readJson, mtime, walk, newestMtime, imageSize, median, STATE_DIR, FRONTEND_EXT, readLedger, activeHours, userSaid, motionHits, unallowedMotion, pageSlug, pageUrl, normUrl, isDesignFile, isExcluded, lineHash } from './_common.mjs';
import { isWaivedBy } from './_inventory.mjs';

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
// Project types: the reference count, the industry references, the MOTION.md effects and the time default of each.
// component has a cap (1h) instead of a floor; a cap of 1h or less needs no words from the user.
export const PROFILES = {
  landing: { refs: [9, 12], industry: 2, motion: 5, time: { floor: 3 } },
  site: { refs: [9, 12], industry: 2, motion: 5, time: { floor: 6 } },
  app: { refs: [5, 8], industry: 1, motion: 2, time: { floor: 2 } },
  component: { refs: [3, 6], industry: 0, motion: 0, time: { cap: 1 } },
};
const RTL_LANGS = ['ar', 'he', 'fa', 'ur'];
// Logged by the guard hook (since 1.5.0) but never an edit: they must not make a session a builder.
const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const MEDIA_EXT = ['.woff', '.woff2', '.ttf', '.otf', '.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'];
const typeOf = (g) => (PROFILES[g?.type] ? g.type : 'landing');
const profileOf = (g) => PROFILES[typeOf(g)];
// The cap that needs no user words: the component default. Any other cap needs the user's words.
const freeCapOf = (g) => (typeOf(g) === 'component' ? PROFILES.component.time.cap : 0);
const langsOf = (g) => (Array.isArray(g?.languages) && g.languages.length ? g.languages : ['en']);
const isRtl = (lang) => RTL_LANGS.includes(String(lang).split('-')[0].toLowerCase());
const JOURNEY_VIEWPORTS = ['desktop', 'mobile'];
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
// Language codes, comma-separated (en,ar): lower-cased, no duplicates.
function parseLangs(v) {
  const list = [...new Set(String(v ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (!list.length) fail('languages: list them comma-separated, e.g. en,ar');
  const bad = list.filter((x) => !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(x));
  if (bad.length) fail(`languages must be codes like en or ar-EG: ${bad.join(', ')}`);
  return list;
}
function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
// sha1 of a file's bytes (hex), or null when the file is missing.
function sha1File(p) { try { return createHash('sha1').update(readFileSync(p)).digest('hex'); } catch { return null; } }
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
// Pages that need evidence: GATES.pages, default ['/'].
const pagesOf = (g) => (g.pages?.length ? g.pages : ['/']);
// Source files the build is judged on. Redesign: every scope folder, with the excluded folders and globs left out
// (legacy code is not restyled, so its motion is not the build's). Mode new: the build folder.
function designSrcFiles(g) {
  if (g.mode !== 'redesign') return srcFiles(g);
  const dirs = g.scope?.src?.length ? g.scope.src : [g.build?.src].filter(Boolean);
  return dirs.flatMap((d) => walk(resolve(root, d), SRC_EXT))
    .filter((f) => !isExcluded(relative(root, f).split(sep).join('/'), g.scope?.exclude));
}
// The scope folders and exclude globs a redesign slop report must have been run with.
const scopeDirs = (g) => (g.scope?.src || []).map((x) => resolve(root, x));
const scopeExcludes = (g) => (g.scope?.exclude || []).map(normGlob);
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
  if (kind === 'references') return S('refs');
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
  // The A/B pairs (ab-N.jpg, made by pair.mjs) are not the side-by-side with the references: they never count here.
  const cmp = (() => { try { return readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f) && !/^ab-\d+\.jpg$/i.test(f)).map((f) => join(dir, f)); } catch { return []; } })();
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
  // expect: { target } one folder the slop report must have scanned; { targets } every folder it must
  // have scanned; { baseline } the --baseline file it must have used; { exclude } globs it must have
  // been run with; { url } the URL an audit must have run on (compared with normUrl).
  reportOk: (name, than, label, expect = {}) => {
    const r = report(name);
    const p = S('reports', name);
    if (!r) return [false, `${label} report missing (cook/reports/${name})`];
    if (mtime(p) < than) return [false, `${label} report is older than the latest source change: run it again`];
    const scannedText = (r.targets || []).map((t) => relative(root, t)).join(', ') || 'nothing';
    if (expect.target !== undefined && !(r.scanned > 0 && (r.targets || []).includes(expect.target))) {
      return [false, `${label}: the slop report scanned ${scannedText}, not the build folder`];
    }
    if (expect.targets) {
      const missing = expect.targets.filter((t) => !(r.targets || []).includes(t));
      if (!(r.scanned > 0) || missing.length) {
        return [false, `${label}: the slop report does not scan every source folder (missing ${missing.map((t) => relative(root, t)).join(', ') || 'all'}; it scanned ${scannedText})`];
      }
    }
    if (expect.baseline !== undefined && !String(r.baseline || '').endsWith(expect.baseline)) {
      return [false, `${label}: run slop_scan.mjs with --baseline ${expect.baseline} (the report has ${r.baseline ? `--baseline ${r.baseline}` : 'no baseline'})`];
    }
    if (expect.exclude) {
      const missing = expect.exclude.filter((x) => !(r.exclude || []).includes(x));
      if (missing.length) return [false, `${label}: run slop_scan.mjs with --exclude ${missing.join(' --exclude ')}`];
    }
    if (expect.bansSha1) {
      // The report must have been made with the bans file as it is now (or with none, when there is none).
      if (!('bans_sha1' in r) || r.bans_sha1 !== sha1File(S('bans.json'))) {
        return [false, `${label}: the report was made with other bans than cook/bans.json (or before bans_sha1 was recorded): run slop_scan.mjs again`];
      }
    }
    if (expect.anyOk) {
      // Recorded, not judged: the design has not started, so the old site's findings do not fail this step.
      return [true, `${label}: recorded against the baseline with the excludes (${r.errors} error(s), ${(r.new || []).length} new since the baseline; in-scope errors must be zero from the first round on)`];
    }
    if (expect.url !== undefined && normUrl(r.url) !== normUrl(expect.url)) {
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
// Judge files: every .json in the round folder except the summary and the hidden A/B key (.abkey.json).
function judgeFilesIn(round) {
  try { return readdirSync(S('judge', round)).filter((f) => f.endsWith('.json') && f !== 'summary.json' && !f.startsWith('.')); } catch { return []; }
}
// The ledger entry that wrote a judge file: the LAST one. After archive-judges a name is reused, and the newest writer owns it.
function judgeWriter(ledger, round, file) {
  const rel = `cook/judge/${round}/${file}`;
  for (let i = ledger.length - 1; i >= 0; i--) if (ledger[i].file === rel) return ledger[i];
  return null;
}

// Sessions that edited the build, the mockup or the project: the builders. A judge session
// reads only the judge files and writes only its own judge file.
function builderSessions(ledger) {
  const ids = new Set();
  for (const e of ledger) {
    if (!e.session_id || e.tool === 'UserPrompt' || READ_TOOLS.includes(e.tool)) continue;
    if (e.tool === 'Bash') {
      if (/(gate|shoot|audit|slop_scan|side-by-side)\.mjs/.test(e.cmd || '')) ids.add(e.session_id);
      continue;
    }
    if (!(e.file || '').startsWith('cook/judge/')) ids.add(e.session_id);
  }
  return ids;
}

// Judge reads. When the ledger has Read entries at all, a judge file counts only if its session read the round's
// side-by-side and a still of the round, and read nothing that shows it the build: no build source, no mockup source,
// no cook/BRIEF.md, cook/ROUNDS.md or cook/SECTIONS.md, and nothing in the round's judge folder but its own file
// (the summary, another judge, the hidden A/B key).
const readsLogged = (ledger) => ledger.some((e) => e.tool === 'Read');
// A judge session's reads. When the ledger tags reads with an agent and the judge is a subagent, only that agent's reads.
function readsOfJudge(ledger, w) {
  const mine = ledger.filter((e) => e.tool === 'Read' && e.session_id === w.session_id);
  if (w.agent != null && mine.some((e) => e.agent != null)) return mine.filter((e) => e.agent === w.agent);
  return mine;
}
// The build folders, project-relative: the build, and every scope folder in redesign mode.
function srcDirsRel(g) {
  const dirs = [g.build?.src, ...(g.scope?.src || [])].filter(Boolean).map((d) => String(d).trim().replace(/^\.\//, '').replace(/\/+$/, ''));
  return [...new Set(dirs)];
}
function underDir(file, dir) {
  if (dir === '.' || dir === '') return !file.startsWith('cook/');
  return file === dir || file.startsWith(`${dir}/`);
}
function forbiddenForJudge(file, round, own, g) {
  if (srcDirsRel(g).some((d) => underDir(file, d))) return true;
  if (['cook/BRIEF.md', 'cook/ROUNDS.md', 'cook/SECTIONS.md'].includes(file)) return true;
  if (underDir(file, 'cook/mockup')) return true;
  if (file.startsWith(`cook/judge/${round}/`)) return file !== `cook/judge/${round}/${own}`;
  return false;
}
// What is wrong with one judge file's reads, as sentences (empty when it may count). A file with no writer is
// reported by judgeProvenance as unlogged, not here.
function judgeReadProblems(ledger, round, file, g) {
  const w = judgeWriter(ledger, round, file);
  if (!w) return [];
  const reads = readsOfJudge(ledger, w).map((e) => String(e.file || ''));
  const compareDir = `cook/compare/${round}/`;
  const stillsDir = round === 'baseline' ? 'cook/baseline/stills/' : `cook/stills/${round}/`;
  const img = (f) => IMG.includes(extname(f).toLowerCase());
  const probs = [];
  const bad = reads.find((f) => forbiddenForJudge(f, round, file, g));
  if (bad) probs.push(`its session read ${bad} (not fresh)`);
  if (!reads.some((f) => f.startsWith(compareDir) && img(f)) || !reads.some((f) => f.startsWith(stillsDir) && img(f))) {
    probs.push(`its session did not read a side-by-side in ${compareDir} and a still in ${stillsDir}`);
  }
  return probs;
}

// Every judge file must come through the guard hook, the builder never judges itself, and (when reads are logged)
// the judge read only what a fresh judge may read.
function judgeProvenance(round, g) {
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
  const out = [
    [files.length > 0 && unlogged.length === 0, unlogged.length ? `no ledger Write entry for ${unlogged.join(', ')}: a judge writes its own judge file through the guard hook` : (files.length ? 'every judge file was written through the guard hook' : `no judge files in ${round}`)],
    [selfWritten.length === 0, selfWritten.length ? `${selfWritten.join(', ')} written by the builder itself, not by a judge` : 'no judge file was written by the builder itself'],
  ];
  if (!readsLogged(ledger)) {
    out.push([true, 'judge reads not logged: update the hook with preflight --install (not checked here)']);
  } else {
    for (const f of files) {
      if (!judgeWriter(ledger, round, f)) continue;
      const probs = judgeReadProblems(ledger, round, f, g);
      out.push(probs.length ? [false, `${f}: ${probs.join('; ')}`]
        : [true, `${f}: its session read the round's side-by-side and a still, and nothing a fresh judge must not see`]);
    }
  }
  return out;
}

function judgeChecks(g, round, stage, than) {
  const out = [];
  out.push(...judgeProvenance(round, g));
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
  // The motion and final stages: every judge file scores motion (unless the project has no motion).
  if ((stage === 'motion' || stage === 'final') && g.motion !== 'none') {
    for (const f of jpaths) {
      if (typeof readJson(f)?.scores?.motion !== 'number') out.push([false, `${basename(f)}: missing score for motion`]);
    }
  }
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
  // probecheck.json (baseline.mjs --probes-only): every probe in probes.json has a row, the rows are at least as
  // new as probes.json, and every row proves something (an expectation false before the steps and true after).
  const pcPath = B('probecheck.json');
  const rows = readJson(pcPath);
  if (!existsSync(pcPath)) out.push([false, 'cook/baseline/probecheck.json missing: run node baseline.mjs --probes-only'])
  else if (!Array.isArray(rows)) out.push([false, 'cook/baseline/probecheck.json is not a JSON array: run node baseline.mjs --probes-only'])
  else {
    if (Array.isArray(probes) && mtime(pcPath) < mtime(B('probes.json'))) {
      out.push([false, 'cook/baseline/probecheck.json is older than probes.json: run node baseline.mjs --probes-only']);
    }
    if (Array.isArray(probes)) {
      const names = probes.map((p, i) => p?.name || `probe ${i + 1}`);
      const have = new Set(rows.map((r) => r?.name));
      const missing = names.filter((n) => !have.has(n));
      if (missing.length) out.push([false, `probecheck.json has no row for: ${missing.join(', ')}: run node baseline.mjs --probes-only`]);
    }
    const weak = rows.filter((r) => r?.proves !== true);
    for (const r of weak) {
      out.push([false, `probe ${r?.name} proves nothing: its expectation already holds before the steps${r?.error ? ` (or it errored: ${r.error})` : ''}. Fix the probe and run baseline.mjs --probes-only`]);
    }
    if (!weak.length && rows.length) out.push([true, `probecheck.json: all ${rows.length} probe(s) prove something`]);
  }
  out.push(C.approval(g, 'baseline'));
  return out;
}

// Redesign, verify 2: the mockup covers the pages named on its "Mockup covers:" line of BRIEF.md (default: the first
// page). For each covered page, its h1s, nav texts and form fields (a field passes when its label or its name is in
// the mockup) must be in cook/mockup/index.html, or waived by a Dropped or Copy changes line of KEEP.md.
function redesignMockupChecks(g) {
  const out = [];
  const inv = readJson(S('baseline', 'inventory.json'));
  if (!inv?.pages) return [[false, 'baseline inventory missing: nothing to check the mockup against (verify 0b first)']];
  const html = readText(S('mockup', 'index.html')).toLowerCase();
  const keep = readText(S('baseline', 'KEEP.md'));
  const waivedLines = [...sectionOf(keep, 'Dropped').split('\n'), ...sectionOf(keep, 'Copy changes').split('\n')].filter((l) => l.trim());
  const covers = briefLine('Mockup covers');
  const want = covers === null ? [pagesOf(g)[0]] : covers.split(',').map((x) => x.trim()).filter(Boolean);
  const unknown = want.filter((p) => !inv.pages[p]);
  const known = want.filter((p) => inv.pages[p]);
  if (unknown.length) out.push([false, `"Mockup covers" names ${unknown.join(', ')}, which the baseline inventory does not have`]);
  const missing = [];
  let terms = 0;
  const here = (t) => t && html.includes(String(t).trim().toLowerCase());
  for (const page of known) {
    const p = inv.pages[page];
    const seen = new Set();
    const term = (text, kind) => {
      const t = String(text ?? '').trim();
      if (!t || seen.has(`${kind}:${t.toLowerCase()}`)) return;
      seen.add(`${kind}:${t.toLowerCase()}`);
      terms++;
      if (!here(t) && !isWaivedBy(waivedLines, t, kind)) missing.push(`"${t}" (${page})`);
    };
    for (const h of (p?.headings || []).filter((x) => x.level === 1)) term(h.text, 'text');
    for (const n of (p?.nav || [])) term(n, 'text');
    for (const f of (p?.forms || []).flatMap((x) => x.fields || [])) {
      const label = String(f.label ?? '').trim(), name = String(f.name ?? '').trim();
      if (!label && !name) continue;
      if (here(label) || here(name)) { terms++; continue; }
      terms++;
      const waived = [label, name].some((x) => x && isWaivedBy(waivedLines, x, 'field'));
      if (!waived) missing.push(`"${label || name}" (${page})`);
    }
  }
  out.push(missing.length === 0 ? [true, `mockup covers the baseline on ${known.join(', ')}: ${terms} h1, nav and form field(s) found in cook/mockup or waived in KEEP.md`]
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
        out.push(...judgeProvenance('baseline', g));
        out.push([briefLine('Keep') !== null, 'BRIEF.md has a "Keep:" line (what must survive the redesign)']);
      }
      const ids = refIds();
      const prof = profileOf(g);
      out.push([ids.size >= prof.refs[0] && ids.size <= prof.refs[1], `${ids.size} reference(s) in cook/refs (need ${prof.refs[0]} to ${prof.refs[1]}, named R01...)`]);
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
      // The user is asked for their own references, and an answer is required: their references
      // (source "user"), or their words saying they have none. Never a silent default.
      out.push([(kinds.user || 0) > 0 || quoteOk(g.user_refs_none),
        (kinds.user || 0) > 0 ? `${kinds.user} reference(s) supplied by the user`
          : g.user_refs_none ? `user has no references of their own: "${g.user_refs_none}"`
          : 'the user was not asked for their own references: ask, wait for the answer, then add them as source "user" (or record: gate.mjs no-user-refs --quote "<their words>")']);
      // References from the client's own industry or adjacent service businesses, marked "industry" in SOURCES.md.
      const industry = [...ids.keys()].filter((id) => src.split('\n').some((l) => new RegExp(`\\b${id}\\b`, 'i').test(l) && /\bindustry\b/i.test(l))).length;
      out.push([industry >= prof.industry, `${industry} reference(s) from the client's industry or an adjacent service business (need ${prof.industry}+; mark them "industry" in SOURCES.md)`]);
      if (g.mode === 'redesign') {
        out.push([briefLine('Open to change') !== null, briefLine('Open to change') !== null
          ? `BRIEF.md Open to change: ${briefLine('Open to change')}`
          : 'BRIEF.md has no "Open to change:" line: ask the user which rules of the existing design system may change (typeface, layout, photography...) and which are binding; record the binding ones as brand_constraints']);
      }
      // The user saw the contact sheet and picked the set.
      out.push(C.approval(g, 'references'));
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
      const anim = motionCodeIn(files, g);
      out.push([anim.length === 0, anim.length ? `animation code in the mockup (it must be static): ${anim.join(', ')}` : 'mockup is static']);
      if (g.mode === 'redesign') out.push(...redesignMockupChecks(g));
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
        // A cap of the component type's default needs no words; any other cap, and a floor under 2h, does.
        const needWords = !(t.mode === 'cap' && freeCapOf(g) > 0 && t.hours <= freeCapOf(g)) && (t.mode === 'cap' || t.hours < 2);
        out.push([!needWords || quoteOk(t.quote), !needWords ? `time ${t.mode} ${t.hours}h`
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
      if (g.mode === 'redesign') {
        // The step 5 record: every scope folder, against the baseline, with the bans as they are now.
        out.push(step5SlopCheck(g));
        out.push(designGitCheck(g));
      }
      break;
    }
    case '6a': {
      out.push([Boolean(g.build?.src && g.build?.url), g.build?.src ? `build: ${g.build.src} served at ${g.build.url}` : 'build not set (gate.mjs set-build --src <dir> --url <url>)']);
      const files = designSrcFiles(g);
      out.push([files.length > 0, `${files.length} source files in the build`]);
      if (g.mode === 'redesign') {
        out.push([Boolean(g.strategy), g.strategy ? `strategy: ${g.strategy}` : 'strategy not set (gate.mjs set-strategy --in-place, or --rebuild with the user\'s words)']);
      }
      const newest = newestMtime(files);
      const r = latestRound();
      out.push([Boolean(r), r ? `latest round ${r}` : 'no round yet (cook/judge/r01/...)']);
      if (!r) break;
      out.push(...roundEvidence(g, r, newest, false));
      const anim = motionCodeIn(files, g);
      out.push([anim.length === 0, anim.length ? `animation code in the static build (motion waits for step 6b): ${anim.slice(0, 5).join(', ')}` : 'no animation code in the static build (hover/focus transitions only)']);
      if (g.mode === 'redesign') out.push(decorativeCheck(g));
      out.push(...judgeChecks(g, r, 'static', newest));
      out.push(C.approval(g, 'static'));
      break;
    }
    case '6b': {
      if (g.motion === 'none') { out.push([quoteOk(g.motion_quote), `no motion, user said: "${g.motion_quote || ''}"`]); break; }
      const motion = (() => { try { return readFileSync(S('MOTION.md'), 'utf8'); } catch { return ''; } })();
      const rows = motion.split('\n').filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|?\s*$/.test(l) && !/^\s*\|\s*(Ref|Effect|Reference)\b/i.test(l) && !/\|\s*\[[^\]|]+\]\s*\|/.test(l));
      const prof = profileOf(g);
      out.push([rows.length >= prof.motion, `MOTION.md lists ${rows.length} effect(s) (need ${prof.motion}+ table rows)`]);
      const evidence = (() => { try { return readdirSync(S('refs', 'motion')); } catch { return []; } })();
      const refsDir = (() => { try { return readdirSync(S('refs')); } catch { return []; } })();
      const srcs = designSrcFiles(g);
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
      out.push([vague === 0 && (rows.length > 0 || prof.motion === 0), vague ? `${vague} effect(s) without a measured duration and easing in the "How" column (e.g. "700ms, cubic-bezier(.2,.7,.2,1), 24px up")` : 'every effect has a duration and an easing']);
      out.push([unsourced.length === 0, unsourced.length ? `effects not tied to a reference id (R01 / V01): ${[...new Set(unsourced)].join(', ')}` : 'every effect cites a reference']);
      if (prof.motion > 0) out.push([cited.size >= 2, `effects taken from ${cited.size} reference(s) (need 2+: take from many, copy none)`]);
      const anim = motionCodeIn(srcs, g);
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
      const files = designSrcFiles(g);
      const newest = newestMtime(files);
      const r = latestRound();
      if (!r) { out.push([false, 'no round yet']); break; }
      out.push(...roundEvidence(g, r, newest, g.motion !== 'none'));
      out.push(...judgeChecks(g, r, 'final', newest));
      if (g.mode === 'redesign') out.push(...abChecks(g, r));
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
      // Judge reads: the separate judge read the round's side-by-side and a still, and nothing a fresh judge must not see.
      const logged = readsLogged(ledger);
      if (!logged) {
        out.push([false, 'judge reads not logged: update the hook with preflight --install']);
      } else {
        const bad = separate.map((f) => [f, judgeReadProblems(ledger, r, f, g)]).filter(([, p]) => p.length);
        out.push(!separate.length ? [false, 'no separate judge session to check the reads of']
          : bad.length ? [false, bad.map(([f, p]) => `${f}: ${p.join('; ')}`).join(' / ')]
            : [true, `separate judge(s) ${separate.join(', ')}: read the round's side-by-side and a still, and nothing a fresh judge must not see`]);
      }
      const sepOk = logged ? separate.filter((f) => judgeReadProblems(ledger, r, f, g).length === 0) : [];
      const sepMed = median(sepOk.map((f) => readJson(S('judge', r, f))?.overall));
      const sepCal = sepMed === null ? null : Math.round((sepMed + g.calibration.offset) * 100) / 100;
      out.push([sepCal !== null && sepCal >= g.target.judge, sepCal === null ? 'no separate judge score to check' : `the separate judge scored ${sepCal} calibrated: it must meet the bar on its own (bar ${g.target.judge})`]);
      if (g.time?.mode === 'floor') {
        const act = activeHours(ledger.filter((e) => e.tool !== 'UserPrompt' && !READ_TOOLS.includes(e.tool) && (builders.has(e.session_id) || (e.file || '').startsWith('cook/'))));
        out.push([act >= g.time.hours, `${act.toFixed(1)}h of active work logged (floor ${g.time.hours}h; idle gaps over 15 min do not count). Done before the floor means the bar was read too low`]);
        const n = rounds().filter((x) => (summaryFor(x)?.judges ?? 0) >= 2).length;
        out.push([n >= 3, `${n} judged round(s) with 2+ judges (need 3+ before shipping)`]);
      }
      out.push(...releaseChecks(g));
      out.push(C.approval(g, 'final'));
      break;
    }
    default: fail(`unknown step ${step}. Steps: ${stepsFor(g).join(', ')}`);
  }
  return out;
}

// Files (and first line) that contain animation code. Comment lines and prose do not count, and a
// line allowed in GATES.motion_allow (its project-relative file and hash) does not count either.
function motionCodeIn(files, g = {}) {
  const hits = [];
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (!FRONTEND_EXT.includes(ext)) continue;
    const rel = relative(root, f).split(sep).join('/');
    const left = unallowedMotion(readFileSync(f, 'utf8'), ext, rel, g.motion_allow || []);
    if (left.length) hits.push(`${rel}:${left[0].line}`);
  }
  return hits;
}

// Slop report check. Redesign: the report scanned every scope folder, ran with the baseline and with
// every exclude glob (so only new findings in excluded code fail). Mode new: the build folder.
const normGlob = (x) => String(x).replace(/\\/g, '/').replace(/^\.\//, '');
// Rounds (6a, 6b, 8): the scan is measured from the step 5 record, so only findings that appeared after step 5
// are new; in-scope errors must be zero.
function slopCheck(g, name, than, label) {
  if (g.mode !== 'redesign') return C.reportOk(name, than, label, { target: g.build?.src ? resolve(root, g.build.src) : null });
  return C.reportOk(name, than, label, { targets: scopeDirs(g), baseline: 'cook/reports/slop-step5.json', exclude: scopeExcludes(g) });
}
// Step 5 (redesign): records the scan of every scope folder against the old site's slop, with the excludes and
// the bans in cook/bans.json as they are now. It does not need to be clean: the design has not started yet.
function step5SlopCheck(g) {
  return C.reportOk('slop-step5.json', 0, 'slop scan of the source folders (step 5)', {
    targets: scopeDirs(g), baseline: 'cook/baseline/slop.json', exclude: scopeExcludes(g), bansSha1: true, anyOk: true,
  });
}

// Redesign: every non-empty Dropped and Copy changes line quotes words the user typed (8+ characters, in quotes).
// One broad quote may serve several lines. A line that is only "none" is no entry.
function quotesUserWords(line) {
  return [...line.matchAll(/"([^"]+)"|“([^”]+)”/g)].some((m) => { const q = (m[1] ?? m[2]).trim(); return quoteOk(q) && userSaid(root, q); });
}
function keepWordsCheck() {
  const keep = readText(S('baseline', 'KEEP.md'));
  const lines = [...sectionOf(keep, 'Dropped').split('\n'), ...sectionOf(keep, 'Copy changes').split('\n')]
    .map((l) => l.trim()).filter((l) => /^[-*]\s+\S/.test(l) && !/^[-*]\s+none\.?$/i.test(l));
  const unsaid = lines.filter((l) => !quotesUserWords(l));
  return unsaid.length === 0
    ? [true, `every Dropped and Copy changes line (${lines.length}) quotes the user's own words`]
    : [false, `Dropped and Copy changes lines need the user's exact words in "..." (8+ characters, typed in this project): ${unsaid.slice(0, 3).map((l) => l.slice(0, 70)).join(' / ')}`];
}
// The probes as step 0b approved them, kept in g.baseline.probes: name, page, viewport, expect, and the request kinds
// (request_nav, from probecheck.json: whether each request was a full-page navigation).
function probeSnapshot() {
  const probes = readJson(S('baseline', 'probes.json'));
  const rows = readJson(S('baseline', 'probecheck.json'));
  if (!Array.isArray(probes)) return [];
  return probes.map((p, i) => {
    const name = p?.name || `probe ${i + 1}`;
    const row = Array.isArray(rows) ? rows.find((r) => r?.name === name) : null;
    return { name, page: p?.page ?? null, viewport: p?.viewport ?? null, expect: Array.isArray(p?.expect) ? p.expect : [], request_nav: row?.request_nav ?? null };
  });
}
// Redesign rounds: no probe approved at 0b may have been removed, moved, given other request expectations, or weakened
// (fewer expectations). Steps and selectors may change: a relabelled field is a real change.
function probeSnapshotChecks(g) {
  const snap = g.baseline?.probes;
  if (!Array.isArray(snap)) return [[false, 'no probe snapshot from step 0b: verify 0b again (it records the probes the user approved)']];
  const probes = readJson(S('baseline', 'probes.json'));
  const now = new Map((Array.isArray(probes) ? probes : []).map((p, i) => [p?.name || `probe ${i + 1}`, p]));
  const requests = (list) => (Array.isArray(list) ? list : []).filter((e) => e && typeof e.request === 'string').map((e) => e.request);
  const out = [];
  for (const s of snap) {
    const p = now.get(s.name);
    if (!p) { out.push([false, `probe "${s.name}" was removed since step 0b: restore it (cook/baseline/probes.json), or reopen 0b to re-approve the baseline`]); continue; }
    const problems = [];
    if (p.page !== s.page || p.viewport !== s.viewport) problems.push(`it was ${s.page} ${s.viewport} at step 0b, now ${p.page} ${p.viewport}`);
    if (JSON.stringify(requests(p.expect)) !== JSON.stringify(requests(s.expect))) problems.push('its request expectations changed');
    const had = (s.expect || []).length, has = Array.isArray(p.expect) ? p.expect.length : 0;
    if (has < had) problems.push(`it has ${has} expectation(s), it had ${had} at step 0b`);
    out.push(problems.length
      ? [false, `probe "${s.name}" weakened since step 0b: ${problems.join('; ')}. Restore the expectations, or reopen 0b to re-approve the baseline`]
      : [true, `probe "${s.name}" is as the user approved it at step 0b (page, viewport, request expectations, ${had} expectation(s))`]);
  }
  return out;
}

// The proof a round needs, newer than the newest source file. Mode new with the one default page keeps
// the old names (a still with desktop or mobile in its name, audit-rNN.json). Otherwise every page has
// <slug>-desktop.png and <slug>-mobile.png; in redesign mode also audit-rNN-<slug>.json with that page's URL.
function roundEvidence(g, r, newest, needVideo) {
  const out = [];
  const pages = pagesOf(g);
  const legacy = g.mode !== 'redesign' && pages.length === 1 && pages[0] === '/';
  if (legacy) {
    const st = images(S('stills', r));
    for (const vp of ['desktop', 'mobile']) {
      const f = st.filter((p) => basename(p).includes(vp)).sort((a, b) => mtime(a) - mtime(b))[0];
      out.push(f ? C.newer(f, newest, `${r} ${vp} stills`) : [false, `${r} ${vp} stills missing (shoot.mjs <url> --out cook/stills/${r} --name S01)`]);
    }
  } else {
    for (const page of pages) for (const vp of ['desktop', 'mobile']) {
      out.push(C.newer(S('stills', r, `${pageSlug(page)}-${vp}.png`), newest, `${r} ${page} ${vp} still`));
    }
  }
  if (needVideo) {
    let vids = []; try { vids = readdirSync(S('stills', r)).filter((f) => f.endsWith('-motion.webm')).map((f) => S('stills', r, f)); } catch { /* none */ }
    out.push(vids.length ? C.newer(vids[0], newest, `${r} motion recording`) : [false, `${r} motion recording missing (shoot.mjs <url> --out cook/stills/${r} --name S01 --live --video 12)`]);
  }
  out.push(compareCheck(S('compare', r), newest, `${r} side-by-side exists`, `${r} side-by-side missing (cook/compare/${r}/)`));
  out.push(slopCheck(g, `slop-${r}.json`, newest, `${r} slop scan`));
  if (g.mode === 'redesign') {
    out.push(keepWordsCheck());
    out.push(...probeSnapshotChecks(g));
    // Regression proof for the round: regress.mjs must have run on this build and passed, on the probes as they are now.
    out.push(C.reportOk(`regress-${r}.json`, newest, `${r} regress`));
    const reg = report(`regress-${r}.json`);
    const probesNow = sha1File(S('baseline', 'probes.json'));
    out.push(reg && 'probes_sha1' in reg && reg.probes_sha1 === probesNow
      ? [true, `${r} regress ran on the current probes.json`]
      : [false, `${r} regress was not run on the current probes.json (probes_sha1 ${reg && 'probes_sha1' in reg ? reg.probes_sha1 : 'missing'}, probes.json ${probesNow ?? 'missing'}): run regress again`]);
  }
  // One audit per page, in both modes. The legacy audit-rNN.json counts only when the pages are exactly ['/'].
  const base = buildUrl(g);
  const onlyHome = pages.length === 1 && pages[0] === '/';
  for (const page of pages) {
    const file = `audit-${r}-${pageSlug(page)}.json`;
    const legacy = onlyHome && !existsSync(S('reports', file)) && existsSync(S('reports', `audit-${r}.json`));
    out.push(auditCheck(legacy ? `audit-${r}.json` : file, newest, `${r} ${page} audit`, base ? pageUrl(base, page) : null));
  }
  out.push(...journeysCheck(g, r, newest));
  return out;
}

// One audit report of a round: it must come from audit.mjs with checks_version 2 (keyboard, labels, reduced motion,
// SEO, performance) and must have run on the page's URL.
function auditCheck(name, newest, label, url) {
  const rep = report(name);
  if (rep && !(rep.checks_version >= 2)) return [false, `${label}: audit report from an old audit.mjs: rerun it (checks_version ${rep.checks_version ?? 'missing'}, needs 2)`];
  return C.reportOk(name, newest, label, { url });
}

// The HTML file a page is served from in the build folders: index.html for '/', else <path>.html or <path>/index.html.
function pageHtmlFile(g, page) {
  try {
    let path = String(page);
    if (/^https?:/i.test(path)) path = new URL(path).pathname;
    const rel = path.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
    const names = rel ? [`${rel}.html`, `${rel}/index.html`] : ['index.html'];
    for (const d of srcDirsRel(g)) {
      for (const n of names) {
        const f = join(resolve(root, d), n);
        if (existsSync(f) && statSync(f).isFile()) return f;
      }
    }
  } catch { /* unreadable page path: no file */ }
  return null;
}
// A page needs a journey when it has a form or more than two links: the baseline inventory when there is one, else its HTML.
// A page whose HTML cannot be found needs one too.
function pageNeedsJourney(g, page) {
  const inv = readJson(S('baseline', 'inventory.json'));
  if (inv?.pages?.[page]) { const p = inv.pages[page]; return (p.forms || []).length > 0 || (p.links || []).length > 2; }
  const file = pageHtmlFile(g, page);
  if (!file) return true;
  const html = readText(file);
  return /<form\b/i.test(html) || (html.match(/<a\b[^>]*\bhref\s*=/gi) || []).length > 2;
}
// Journeys (roundEvidence, both modes): cook/JOURNEYS.json lists the main tasks; every page with a form or more than two
// links has one; the round's journeys report ran on this file, is no older than the latest source, and passed on desktop
// and mobile. A right-to-left language needs a journey with rtl: true that passed on both viewports.
function journeysCheck(g, r, newest) {
  const jPath = S('JOURNEYS.json');
  const js = readJson(jPath);
  if (!Array.isArray(js)) return [[false, 'cook/JOURNEYS.json missing or not a JSON array: write the main user tasks (sign up, choose a plan, contact, switch language)']];
  if (!js.length) return [[false, 'cook/JOURNEYS.json has no journeys: write at least one per page with a form or more than two links']];
  const out = [];
  const needs = pagesOf(g).filter((p) => pageNeedsJourney(g, p));
  const uncovered = needs.filter((p) => !js.some((j) => j?.page === p));
  out.push(uncovered.length ? [false, `no journey on ${uncovered.join(', ')} (a page with a form or more than two links needs one in cook/JOURNEYS.json)`]
    : [true, `cook/JOURNEYS.json covers every page with a form or more than two links (${needs.join(', ') || 'none'})`]);
  const repPath = S('reports', `journeys-${r}.json`);
  const rep = report(`journeys-${r}.json`);
  const fresh = Boolean(rep) && mtime(repPath) >= newest && rep.journeys_sha1 === sha1File(jPath);
  const entries = Array.isArray(rep?.journeys) ? rep.journeys : [];
  const passes = (name) => JOURNEY_VIEWPORTS.every((vp) => entries.some((e) => e?.name === name && e?.viewport === vp && e?.ok === true));
  if (!rep) out.push([false, `journeys report missing (cook/reports/journeys-${r}.json): run node journeys.mjs --round ${r}`]);
  else if (mtime(repPath) < newest) out.push([false, `journeys report is older than the latest source change: run node journeys.mjs --round ${r} again`]);
  else if (rep.journeys_sha1 !== sha1File(jPath)) out.push([false, `journeys report was made from other journeys than cook/JOURNEYS.json: run node journeys.mjs --round ${r} again`]);
  else {
    const missing = [], failing = [];
    for (const j of js) for (const vp of JOURNEY_VIEWPORTS) {
      const e = entries.find((x) => x?.name === j?.name && x?.viewport === vp);
      if (!e) missing.push(`${j?.name} (${vp})`);
      else if (e.ok !== true) failing.push(`${j?.name} (${vp})`);
    }
    if (missing.length) out.push([false, `journeys report has no result for ${missing.join(', ')}: run node journeys.mjs --round ${r} again`]);
    else if (failing.length) out.push([false, `journeys failing in ${r}: ${failing.join(', ')}. Fix them, then run node journeys.mjs --round ${r} again`]);
    else if (rep.ok !== true) out.push([false, `journeys report is not ok: run node journeys.mjs --round ${r} again`]);
    else out.push([true, `journeys report: all ${js.length} journey(s) pass on desktop and mobile in ${r}`]);
  }
  const rtl = langsOf(g).filter(isRtl);
  if (rtl.length) {
    const rtlNames = js.filter((j) => j?.rtl === true).map((j) => j.name);
    const ok = fresh && rtlNames.some(passes);
    out.push([ok, ok ? `languages ${langsOf(g).join(',')}: a journey with rtl: true passes on desktop and mobile in ${r} (${rtlNames.join(', ')})`
      : `languages ${langsOf(g).join(',')}: needs a journey with rtl: true that passes on desktop and mobile in ${r} (${rtlNames.length ? `${rtlNames.join(', ')} is failing, stale or missing a viewport` : 'none in cook/JOURNEYS.json'})`]);
  }
  return out;
}
// Step 8 release checklist: cook/RELEASE.md has the four headings and every "- [" item is checked (an n/a item gives its reason);
// cook/CREDITS.md exists when a reference, photo or font came from outside the user.
function releaseChecks(g) {
  const out = [];
  const p = S('RELEASE.md');
  if (!existsSync(p)) {
    out.push([false, 'cook/RELEASE.md missing: write the release checklist with ## Content, ## Credits, ## Performance and ## SEO']);
  } else {
    const md = readText(p);
    const heads = h2Set(md);
    const noHead = ['Content', 'Credits', 'Performance', 'SEO'].filter((h) => !heads.has(h.toLowerCase()));
    out.push(noHead.length ? [false, `RELEASE.md is missing ${noHead.map((h) => `## ${h}`).join(', ')}`]
      : [true, 'RELEASE.md has the four headings: Content, Credits, Performance, SEO']);
    const items = md.split('\n').filter((l) => l.startsWith('- ['));
    const open = items.filter((l) => !/^- \[[xX]\]/.test(l));
    if (open.length) out.push([false, `${open.length} unchecked release item(s): ${open.slice(0, 3).map((l) => l.trim().slice(0, 70)).join(' / ')}`]);
    else if (!items.length) out.push([false, 'RELEASE.md has no checklist items (lines starting with "- [")']);
    else out.push([true, `all ${items.length} release item(s) are checked`]);
    const noReason = items.filter((l) => /^- \[[xX]\]\s*n\/a\b/i.test(l) && !/^- \[[xX]\]\s*n\/a:\s*\S/i.test(l));
    if (noReason.length) out.push([false, `${noReason.length} n/a item(s) without a reason (write - [x] n/a: <reason>): ${noReason[0].trim().slice(0, 70)}`]);
  }
  // Credits: every reference whose source is not the user, and every font or photo in the build folders.
  const src = readText(S('refs', 'SOURCES.md'));
  const outside = [...refIds().keys()].filter((id) => {
    const line = src.split('\n').find((l) => new RegExp(`\\b${id}\\b`, 'i').test(l)) || '';
    return (line.match(/\b(user|inspo|awwwards|web)\b/i) || [])[1]?.toLowerCase() !== 'user';
  });
  const media = srcDirsRel(g).flatMap((d) => walk(resolve(root, d), MEDIA_EXT)).map((f) => relative(root, f).split(sep).join('/'));
  const from = [...outside, ...media];
  const credits = S('CREDITS.md');
  if (from.length) out.push([existsSync(credits), existsSync(credits) ? 'CREDITS.md lists the outside sources'
    : `CREDITS.md missing: ${from.slice(0, 6).join(', ')} came from outside the user`]);
  else out.push([true, 'no reference, photo or font from outside the user (CREDITS.md not needed)']);
  return out;
}

// Verify 5 (redesign): no design file may change before the mockup passed. Compares the scope folders
// with the baseline commit and adds untracked files; only design files count (isDesignFile).
function designGitCheck(g) {
  const label = 'design files vs the baseline commit';
  const commit = g.baseline?.commit ?? null;
  if (!commit) return [true, `${label}: not measured: not a git repo`];
  const scope = g.scope?.src || [];
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const diff = git(['diff', '--name-only', '--relative', commit, '--', ...scope]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...scope]);
  if (diff.status !== 0 || untracked.status !== 0) return [true, `${label}: not measured: not a git repo (git could not compare with ${commit.slice(0, 12)})`];
  const names = (text) => String(text).split('\n').map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean);
  const changed = [...new Set([...names(diff.stdout), ...names(untracked.stdout)])];
  // Files already dirty when the baseline was taken (sha1 of their content then) are not new edits, as long as
  // their content is still the same. g.baseline.dirty_files, or cook/baseline/meta.json when g.baseline lacks the file.
  const metaDirty = readJson(S('baseline', 'meta.json'))?.dirty_files || {};
  const preDirty = (x) => {
    const known = g.baseline?.dirty_files?.[x] ?? metaDirty[x];
    if (!known) return false;
    try { return createHash('sha1').update(readFileSync(resolve(root, x))).digest('hex') === known; } catch { return false; }
  };
  // The file text is passed so that JSX in a .js file counts as design (isDesignFile reads the text of logic files).
  const designNow = (x) => isDesignFile(x, g, readText(resolve(root, x)));
  const ignored = changed.filter((x) => designNow(x) && preDirty(x));
  const design = changed.filter((x) => designNow(x) && !ignored.includes(x));
  const why = ignored.length
    ? `${ignored.length} already dirty at the baseline and unchanged since, the rest not design`
    : 'none of them design';
  return design.length === 0
    ? [true, `${label}: none changed (${changed.length} file(s) in scope changed, ${why})`]
    : [false, `design files changed before the mockup passed: ${design.join(', ')}`];
}

// Verify 6a (redesign): every motion hit classified decorative in KEEP.md ## Motion must be gone from the code.
function decorativeCheck(g) {
  const motion = readJson(S('baseline', 'motion.json'), []);
  const decorative = new Set();
  for (const l of sectionOf(readText(S('baseline', 'KEEP.md')), 'Motion').split('\n')) {
    const cells = l.split('|').map((c) => c.trim());
    const i = cells.findIndex((c) => /^[0-9a-f]{12}$/.test(c));
    if (i >= 0 && /^decorative\b/i.test(cells[i + 1] || '')) decorative.add(cells[i]);
  }
  const want = new Set((Array.isArray(motion) ? motion : []).map((m) => m.hash).filter((h) => decorative.has(h)));
  const hits = [];
  for (const f of designSrcFiles(g)) {
    const ext = extname(f).toLowerCase();
    if (!FRONTEND_EXT.includes(ext)) continue;
    const rel = relative(root, f).split(sep).join('/');
    for (const h of motionHits(readText(f), ext)) if (want.has(h.hash)) hits.push(`${rel}:${h.line} "${h.text}"`);
  }
  return hits.length === 0
    ? [true, `no decorative motion left in the code (${want.size} hit(s) classified decorative in KEEP.md)`]
    : [false, `decorative motion still in the code (remove it in this round, redesign it in 6b): ${hits.slice(0, 5).join('; ')}`];
}

// Verify 8 (redesign): old against new. The A/B key covers every baseline page in g.pages on desktop and mobile; every
// judge file names the new side of every pair in .abkey.json; the key and the pairs (ab-N.jpg) are newer than the
// round's fold stills and the newest source; and no raw dimension of the round ends below the baseline's raw score.
// Raw means the judges' medians before the calibration offset: the offset is applied to both sides alike.
function abChecks(g, r) {
  const key = readJson(S('judge', r, '.abkey.json'));
  if (!Array.isArray(key) || key.length === 0) return [[false, `no A/B key for ${r}: run pair.mjs --round ${r}`]];
  const out = [];
  const inv = readJson(S('baseline', 'inventory.json'));
  const basePages = pagesOf(g).filter((p) => inv?.pages?.[p]);
  const uncovered = [];
  for (const p of basePages) for (const vp of VIEWPORTS) if (!key.some((k) => k && k.page === p && k.viewport === vp)) uncovered.push(`${p} ${vp}`);
  out.push(uncovered.length === 0 ? [true, `A/B key covers every baseline page on desktop and mobile (${basePages.length} page(s))`]
    : [false, `A/B key has no pair for ${uncovered.join(', ')}: run pair.mjs --round ${r} (it needs the fold stills of every baseline page)`]);
  // Freshness: the key and every pair must be at least as new as the newest fold still of the round and the newest source.
  const folds = (() => { try { return readdirSync(S('stills', r)).filter((f) => f.endsWith('-fold.png')).map((f) => S('stills', r, f)); } catch { return []; } })();
  const newest = Math.max(newestMtime(folds), newestMtime(designSrcFiles(g)));
  const keyPath = S('judge', r, '.abkey.json');
  const pairPaths = key.map((k) => S('compare', r, `${k.pair}.jpg`));
  const missingPairs = pairPaths.filter((f) => !existsSync(f)).map((f) => basename(f));
  out.push(missingPairs.length === 0 ? [true, `every A/B pair (${key.length}) has its side-by-side image`]
    : [false, `A/B side-by-side missing: ${missingPairs.join(', ')} (cook/compare/${r}/): run pair.mjs --round ${r}`]);
  const stale = [keyPath, ...pairPaths.filter(existsSync)].filter((f) => mtime(f) < newest).map((f) => basename(f));
  out.push(stale.length === 0 ? [true, `the A/B key and pairs are newer than the round's fold stills and the latest source`]
    : [false, `${stale.join(', ')} older than the round's fold stills or the latest source change: run pair.mjs --round ${r} again`]);
  const files = judgeFilesIn(r);
  if (!files.length) out.push([false, `no judge files in ${r} to check the A/B choices`]);
  for (const f of files) {
    const doc = readJson(S('judge', r, f)) || {};
    const ab = Array.isArray(doc.ab) ? doc.ab : [];
    const problems = [];
    for (const k of key) {
      const where = `${k.pair} (${k.page} ${k.viewport})`;
      const e = ab.find((x) => x && x.pair === k.pair);
      if (!e) problems.push(`no ab entry for ${where}`);
      else if (e.better !== k.new) problems.push(e.better === 'left' || e.better === 'right' ? `prefers the old site in ${where}` : `no valid better (left or right) for ${where}`);
    }
    out.push([problems.length === 0, problems.length ? `${f}: ${problems.join('; ')}` : `${f}: every A/B pair (${key.length}) chooses the new side`]);
  }
  const base = summaryFor('baseline');
  if (!base) { out.push([false, 'no baseline score to compare with: cook/judge/baseline/summary.json (score the baseline)']); return out; }
  if (!base.raw?.dims) { out.push([false, 'the baseline score has no raw dimensions: score the baseline again (gate.mjs score baseline)']); return out; }
  const now = summaryFor(r);
  const below = [];
  for (const [d, b] of Object.entries(base.raw.dims)) {
    const v = now?.raw?.dims?.[d];
    if (typeof v !== 'number') { if (!(d === MOTION_DIM && g.motion === 'none')) below.push(`${d} not scored in ${r}`); continue; }
    if (v < b) below.push(`${d} ${v} (baseline ${b})`);
  }
  out.push([below.length === 0, below.length ? `below the baseline in cook/judge/${r}/summary.json: ${below.join(', ')}` : 'no dimension below the baseline (raw judge medians, cook/judge/baseline/summary.json)']);
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
// rejected: { file: reason } for judge files the ledger refuses (their session read what a fresh judge must not read).
export function scoreRound(dir, offset = 0, rejected = {}) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'summary.json' && !f.startsWith('.'));
  const judges = [];
  const problems = [];
  for (const f of files) {
    if (rejected[f]) { problems.push(`${f}: ${rejected[f]}`); continue; }
    const j = readJson(join(dir, f));
    if (!j) { problems.push(`${f}: not valid JSON`); continue; }
    if (j.fresh !== true) { problems.push(`${f}: not marked fresh:true (a judge must have no build context)`); continue; }
    if (typeof j.overall !== 'number' || j.overall < 0 || j.overall > 10) { problems.push(`${f}: overall must be 0-10`); continue; }
    // Every judge scores every dimension: a judge missing one is rejected, not averaged over the rest.
    const missingDims = DIMS.filter((d) => typeof j.scores?.[d] !== 'number');
    if (missingDims.length) { for (const d of missingDims) problems.push(`${f}: missing score for ${d}`); continue; }
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

// ---------------- final report ----------------
// Read-only: the steps, the overrides and the motion allowances with the user's words. In redesign mode
// also the before and after scores (calibrated), slop and audit counts, and every Dropped line of KEEP.md.
function finalReport(g) {
  const r = latestRound();
  const L = [];
  const fmt = (n) => (typeof n === 'number' ? String(n) : '-');
  const r2 = (n) => Math.round(n * 100) / 100;
  L.push(`# Final report: ${g.project}`, '', `Mode: ${g.mode || 'new'}. Written ${new Date().toISOString()}.`, '');
  L.push('## Steps', '', '| Step | Status | Name |', '|---|---|---|');
  for (const s of stepsFor(g)) L.push(`| ${s} | ${g.steps[s]?.status || 'pending'} | ${STEP_NAMES[s]} |`);
  L.push('', '## Overrides', '');
  const ov = Object.entries(g.overrides || {});
  if (!ov.length) L.push('None.');
  for (const [s, o] of ov) L.push(`- Step ${s}, the user said "${o.quote}". Reason: ${o.reason}. Unmet at the time: ${(o.unmet || []).join('; ') || 'none'}`);
  if (g.mode === 'redesign') {
    const bs = summaryFor('baseline');
    const ls = r ? summaryFor(r) : null;
    L.push('', `## Before and after (raw judge medians, ${r ? `baseline against ${r}` : 'no round scored yet'})`, '');
    if (!bs) L.push('No baseline score (cook/judge/baseline/summary.json is missing).');
    else {
      L.push(`| Dimension | Baseline | ${r || 'Latest'} | Change |`, '|---|---|---|---|');
      const rows = [['overall', bs.raw?.overall, ls?.raw?.overall],
        ...Object.keys(bs.raw?.dims || {}).map((d) => [d, bs.raw.dims[d], ls?.raw?.dims?.[d]])];
      for (const [name, b, v] of rows) {
        const diff = typeof b === 'number' && typeof v === 'number' ? r2(v - b) : null;
        L.push(`| ${name} | ${fmt(b)} | ${fmt(v)} | ${diff === null ? '-' : diff >= 0 ? `+${diff}` : String(diff)} |`);
      }
      const ub = g.calibration?.baseline_user;
      if (ub) L.push('', `The user rated the old site ${ub.user} (the judges ${ub.judges}). Recorded, not applied: the offset is ${g.calibration?.offset ?? 0}.`);
    }
    const bslop = readJson(S('baseline', 'slop.json'));
    const lname = r && existsSync(S('reports', `slop-${r}.json`)) ? `slop-${r}.json` : 'slop-step5.json';
    const lslop = report(lname);
    L.push('', '## Slop', '', `| | Baseline (slop.json) | Now (${lname}) |`, '|---|---|---|');
    L.push(`| errors | ${fmt(bslop?.errors)} | ${fmt(lslop?.errors)} |`, `| warnings | ${fmt(bslop?.warnings)} | ${fmt(lslop?.warnings)} |`);
    if (lslop && Array.isArray(lslop.new)) L.push('', `Against the baseline: ${lslop.new.length} new, ${lslop.fixed?.length ?? 0} fixed, ${lslop.remaining?.length ?? 0} remaining.`);
    const aud = pagesOf(g).map((p) => {
      const slug = pageSlug(p);
      return { p, b: readJson(S('baseline', `audit-${slug}.json`))?.errors, l: r ? report(`audit-${r}-${slug}.json`)?.errors : undefined };
    });
    const sum = (k) => aud.reduce((n, a) => n + (typeof a[k] === 'number' ? a[k] : 0), 0);
    L.push('', '## Audit errors', '', `| Page | Baseline | ${r || 'Latest'} |`, '|---|---|---|');
    for (const a of aud) L.push(`| ${a.p} | ${fmt(a.b)} | ${fmt(a.l)} |`);
    L.push(`| total | ${sum('b')} | ${sum('l')} |`);
    const dropped = sectionOf(readText(S('baseline', 'KEEP.md')), 'Dropped').split('\n').map((l) => l.trim()).filter(Boolean);
    L.push('', '## Dropped (KEEP.md)', '');
    L.push(...(dropped.length ? dropped : ['None listed.']));
  }
  L.push('', '## Motion allowed as functional', '');
  const ma = g.motion_allow || [];
  if (!ma.length) L.push('None.');
  for (const a of ma) L.push(`- ${a.file} ${a.hash}: ${a.reason}. The user said: "${a.quote || 'no quote recorded'}"`);
  return L.join('\n') + '\n';
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
      const type = opt('--type', 'landing');
      if (!PROFILES[type]) fail(`init --type ${Object.keys(PROFILES).join('|')}`);
      const languages = opt('--languages') === null ? ['en'] : parseLangs(opt('--languages'));
      const srcs = optAll('--src');
      // Stored as the gate compares them: no leading ./ and no trailing /, so ./src/legacy/ is src/legacy.
      const excludes = optAll('--exclude').map((x) => String(x).trim().replace(/^\.\//, '').replace(/\/+$/, ''));
      if (excludes.some((x) => !x)) fail('init --exclude needs a folder or glob, e.g. --exclude src/legacy/');
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
        version: 1, project, created: new Date().toISOString(), mode, type, languages,
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
      console.log(`Type: ${typeOf(g)}   Languages: ${langsOf(g).join(', ')}`);
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
        // dirty_files: the pre-existing changes of a dirty baseline, so verify 5 can tell them from new edits.
        // g.baseline.probes: the probes the user approved, so later edits that weaken a probe are caught (roundEvidence).
        if (a1 === '0b') { const m = readJson(S('baseline', 'meta.json')) || {}; g.baseline = { commit: m.commit ?? null, dirty: m.dirty === true, at: m.at ?? null, dirty_files: m.dirty_files && typeof m.dirty_files === 'object' ? m.dirty_files : {}, probes: probeSnapshot() }; }
        save(g); console.log(`Step ${a1} marked PASSED.`);
      }
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'approve': {
      const g = load();
      if (!['mockup', 'static', 'final', 'baseline', 'references'].includes(a1)) fail('approve mockup|static|final|baseline|references --quote "<user words>"');
      const q = opt('--quote');
      needUserWords(q);
      // The approval is tied to the stills the user saw: a newer still makes it stale.
      const dir = stillsFor(a1);
      const imgs = dir ? images(dir) : [];
      const where = { mockup: 'cook/stills/mockup', baseline: 'cook/baseline/stills', references: 'cook/refs (the contact sheet)' }[a1] || 'cook/stills/<round>';
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
      // No flag: the type's default time (landing 3h floor, component 1h cap).
      let floor = null, cap = null;
      if (!argv.includes('--floor') && !argv.includes('--cap')) {
        if (profileOf(g).time.cap) cap = profileOf(g).time.cap; else floor = profileOf(g).time.floor;
      } else {
        floor = argv.includes('--floor') ? parseH(opt('--floor')) : null;
        cap = argv.includes('--cap') ? parseH(opt('--cap')) : null;
      }
      if ((floor === null) === (cap === null)) fail('set-time needs exactly one of --floor <hours> or --cap <hours>');
      const hours = floor ?? cap;
      if (!(hours > 0)) fail('set-time hours must be more than 0');
      const lowersFloor = floor !== null && g.time?.mode === 'floor' && floor < g.time.hours;
      // A cap of the component type's default needs no words; any other cap, and a floor under 2h, does.
      const needQuote = (cap !== null && !(freeCapOf(g) > 0 && cap <= freeCapOf(g))) || (floor !== null && floor < 2) || lowersFloor;
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
    case 'set-type': {
      const g = load();
      if (!PROFILES[a1]) fail(`set-type <${Object.keys(PROFILES).join('|')}>`);
      g.type = a1; save(g);
      const p = PROFILES[a1];
      console.log(`type: ${a1} (references ${p.refs.join(' to ')}, ${p.industry}+ industry, ${p.motion}+ motion effects, time ${p.time.cap ? `cap ${p.time.cap}h` : `floor ${p.time.floor}h`})`);
      break;
    }
    case 'set-languages': {
      const g = load();
      g.languages = parseLangs(a1 ?? opt('--languages'));
      save(g);
      console.log(`languages: ${g.languages.join(', ')}${g.languages.some(isRtl) ? ' (right-to-left: needs a passing rtl journey in every round)' : ''}`);
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
      const file = a1;
      const usage = 'motion-allow <file> <hash> | <file> --text \'<line>\' --reason "..." --quote "<user words>" (the hash is in cook/baseline/motion.json)';
      // Exactly one of <hash> (an existing line, from motion.json) or --text (a line that may not exist yet).
      const text = opt('--text');
      const hashArg = argv[2] && !argv[2].startsWith('--') ? argv[2] : null;
      if (!file || file.startsWith('--')) fail(usage);
      if ((text === null) === (hashArg === null)) fail(`motion-allow takes exactly one of <hash> or --text: ${usage}`);
      const reason = opt('--reason');
      if (!reason || !reason.trim()) fail('motion-allow needs a --reason (why this existing motion is functional)');
      // Only the user can say which motion is functional: their words, typed in this project.
      const q = opt('--quote');
      needUserWords(q);
      const abs = resolve(root, file);
      const rel = relative(root, abs).split(sep).join('/');
      if (text !== null) {
        // The hash of the line as motionHits computes it (trimmed), stored with the line's text for the record.
        if (!text.trim()) fail('motion-allow --text needs the line of code to allow');
        const hash = lineHash(text);
        g.motion_allow = [...(g.motion_allow || []).filter((a) => !(a.file === rel && a.hash === hash)), { file: rel, hash, reason: reason.trim(), quote: q.trim(), text: text.trim() }];
        save(g);
        console.log(`allowed ${rel} line hash ${hash} (before it is written): ${reason.trim()}`);
        break;
      }
      const hash = hashArg;
      let src = null;
      try { src = readFileSync(abs, 'utf8'); } catch { /* missing */ }
      if (src === null) fail(`file not found: ${file} (to allow a line before it exists, use --text)`);
      const hits = motionHits(src, extname(abs).toLowerCase());
      if (!hits.some((h) => h.hash === hash)) fail(`${rel} has no animation line with hash ${hash}. Hashes in this file: ${hits.map((h) => `${h.hash} (line ${h.line})`).join(', ') || 'none'}`);
      g.motion_allow = [...(g.motion_allow || []).filter((a) => !(a.file === rel && a.hash === hash)), { file: rel, hash, reason: reason.trim(), quote: q.trim() }];
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
    case 'no-user-refs': {
      const g = load();
      needUserWords(opt('--quote'));
      g.user_refs_none = opt('--quote'); save(g);
      console.log(`recorded: the user has no references of their own: "${g.user_refs_none}"`);
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
    case 'archive-judges': {
      // Retire a round's judge files (and its summary) after the work changed, so it can be judged again.
      // Files are moved, never deleted: cook/judge/<round>/archive-<timestamp>/.
      if (!a1) fail('archive-judges <round>');
      const dir = S('judge', a1);
      if (!existsSync(dir)) fail(`no folder cook/judge/${a1}`);
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      if (!files.length) { console.log(`nothing to archive in cook/judge/${a1}`); break; }
      const to = join(dir, `archive-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      mkdirSync(to, { recursive: true });
      for (const f of files) renameSync(join(dir, f), join(to, f));
      console.log(`moved ${files.length} file(s) to ${relative(root, to)}; judge the new version with fresh judges`);
      break;
    }
    case 'score': {
      const g = load();
      if (!a1) fail('score <round> (mockup, r01, r02, ...)');
      const dir = S('judge', a1);
      if (!existsSync(dir)) fail(`no folder cook/judge/${a1}`);
      // Judge reads (when logged): a judge whose session read what a fresh judge must not read is rejected here too.
      const ledger = readLedger(root);
      const rejected = {};
      if (readsLogged(ledger)) {
        for (const f of judgeFilesIn(a1)) {
          const probs = judgeWriter(ledger, a1, f) ? judgeReadProblems(ledger, a1, f, g) : [];
          if (probs.length) rejected[f] = probs.join('; ');
        }
      }
      const s = scoreRound(dir, g.calibration.offset, rejected);
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
      if (r === 'baseline') {
        // The baseline is the old site, not a calibration point: the user's rating is recorded for the report only.
        g.calibration.baseline_user = { user, judges: s.raw.overall, at: new Date().toISOString(), quote: q };
        save(g);
        console.log(`recorded: you rate the old site ${user}, the judges ${s.raw.overall}. The offset stays ${cur}: calibrate on a round, not on the baseline.`);
      } else if (next < cur || (newer && next !== cur)) {
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
    case 'report': {
      const g = load();
      const md = finalReport(g);
      writeFileSync(S('REPORT.md'), md);
      process.stdout.write(md);
      console.log(`\nWritten to ${relative(root, S('REPORT.md'))}`);
      break;
    }
    default:
      console.log('usage: gate.mjs init|status|check|verify|approve|override|reopen|set-bar|set-time|set-build|set-motion|set-pages|set-type|set-languages|set-checks|set-strategy|motion-allow|allow-dirty|score|calibrate|elapsed|report (see the header of this file)');
      process.exit(cmd ? 2 : 0);
  }
}
