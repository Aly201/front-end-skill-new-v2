#!/usr/bin/env node
// The step gate. Nothing in frontend-cook moves forward on a claim: every step has
// requirements checked here before it starts (check) and proof checked here before
// it counts as done (verify). State lives in cook/GATES.json.
//
// Commands (run from the project root):
//   init --project <name>                 create cook/GATES.json (needs a passing cook/PREFLIGHT.json)
//   status                                every step, its state and the next step
//   check <step>                          may this step start? (previous steps passed, inputs present)
//   verify <step>                         is this step done? marks it passed only when every proof holds
//   approve <mockup|static|final> --quote "<user's exact words>"
//   override <step> --quote "<user's exact words>" --reason "<why>"   user takes responsibility, logged
//   reopen <step>                         set this step and every later one back to pending
//   set-bar --judge 9.2 --floor 8.5 --similarity 99 [--mockup 8] [--quote "..."]
//   set-time (--floor 3h | --cap 1.5h)
//   set-build --src <dir> --url <url or file>
//   set-motion (--none --quote "..." | --refs)
//   score <round>                         median of the judge files in cook/judge/<round>/, calibrated
//   calibrate --user <score 0-10>         the user's estimate; only ever lowers scores
//   elapsed                               hours since the timer started
//
// Steps: 0 setup, 1 references, 2 mockup, 3 bar, 4 time, 5 bans, 6a static build,
//        6b motion, 7 feedback, 8 separate judge.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { isMain, projectRoot, readJson, mtime, walk, newestMtime, imageSize, median, STATE_DIR } from './_common.mjs';

export const STEPS = ['0', '1', '2', '3', '4', '5', '6a', '6b', '7', '8'];
export const STEP_NAMES = {
  0: 'Setup: cook skill, Inspo MCP, Awwwards MCP, browser',
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
const quoteOk = (q) => typeof q === 'string' && q.trim().length >= 8;

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

function refIds() {
  const ids = new Map();
  for (const f of images(S('refs'))) {
    const m = /^(R\d{2,})(?:[-_][\w-]+)?\.\w+$/i.exec(f.split('/').pop());
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
  file: (p, label) => [existsSync(p), `${label} ${existsSync(p) ? 'exists' : 'missing'} (${p.replace(root + '/', '')})`],
  newer: (p, than, label) => {
    const a = mtime(p);
    return [a > 0 && a >= than, a === 0 ? `${label} missing (${p.replace(root + '/', '')})` : a >= than ? `${label} is newer than the latest source change` : `${label} is OLDER than the latest source change: it does not show the current build. Redo it.`];
  },
  reportOk: (name, than, label) => {
    const r = report(name);
    const p = S('reports', name);
    if (!r) return [false, `${label} report missing (cook/reports/${name})`];
    if (mtime(p) < than) return [false, `${label} report is older than the latest source change: run it again`];
    return [r.ok === true, r.ok ? `${label}: clean (${r.warnings} warnings)` : `${label}: ${r.errors} errors. Fix them, then run it again`];
  },
  approval: (g, k) => {
    const a = g.approvals?.[k];
    return [Boolean(a && quoteOk(a.quote)), a ? `user approved ${k}: "${a.quote}"` : `user has not approved the ${k} yet (needs their words in chat, then: gate.mjs approve ${k} --quote "...")`];
  },
};

function summaryFor(round) { return readJson(S('judge', round, 'summary.json')); }

function judgeChecks(g, round, stage, than) {
  const out = [];
  const s = summaryFor(round);
  if (!s) { out.push([false, `no judge summary for ${round}: have 2+ fresh judges write cook/judge/${round}/*.json, then run gate.mjs score ${round}`]); return out; }
  const p = S('judge', round, 'summary.json');
  out.push([mtime(p) >= than, mtime(p) >= than ? `judge summary ${round} is current` : `judge summary ${round} is older than the latest source change: judge the current build`]);
  // Summary must be newer than every judge file in the folder.
  const jfiles = readdirSync(S('judge', round)).filter((f) => f.endsWith('.json') && f !== 'summary.json').map((f) => S('judge', round, f));
  out.push([mtime(p) >= newestMtime(jfiles), mtime(p) >= newestMtime(jfiles) ? 'summary includes every judge file' : `a judge file changed after scoring: run gate.mjs score ${round}`]);
  out.push([s.judges >= 2, `${s.judges} fresh judge(s) (need 2+)`]);
  out.push([s.spread_ok, s.spread_ok ? `judges agree within 1.0 (spread ${s.spread_overall})` : `judges disagree by ${s.spread_overall}: add another fresh judge, then score again`]);
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
  const i = STEPS.indexOf(step);
  const out = [];
  for (const prev of STEPS.slice(0, i)) out.push(C.stepPassed(g, prev));
  if (step !== '0') out.push(C.preflight());
  if (step === '6b' && g.motion !== 'none') out.push([existsSync(S('MOTION.md')) || videoRefs().length > 0, 'motion references (cook/refs/V01...) or cook/MOTION.md present']);
  return out;
}

// ---------------- proof that a step is DONE ----------------
function doneChecks(g, step) {
  const out = [];
  switch (step) {
    case '0': out.push(C.preflight()); break;
    case '1': {
      out.push(C.file(S('BRIEF.md'), 'BRIEF.md'));
      const lines = brief().split('\n').filter((l) => l.trim()).length;
      out.push([lines > 0 && lines <= 40, `BRIEF.md is ${lines} lines (keep it short: 40 max, the references carry the look)`]);
      out.push([briefLine('Target') !== null, 'BRIEF.md has a "Target:" line']);
      out.push([briefLine("User's words") !== null, 'BRIEF.md has a "User\'s words:" line']);
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
      }
      const shots = (() => { try { return readFileSync(S('SHOTS.md'), 'utf8'); } catch { return ''; } })();
      const noShot = [...ids.keys()].filter((id) => !new RegExp(`\\b${id}\\b`, 'i').test(shots));
      out.push([shots.length > 0 && noShot.length === 0, noShot.length ? `SHOTS.md does not cover: ${noShot.join(', ')}` : 'SHOTS.md covers every reference with what to take from it']);
      break;
    }
    case '2': {
      const files = mockupFiles();
      const newest = newestMtime(files);
      out.push(C.file(S('mockup', 'index.html'), 'mockup'));
      const st = images(S('stills', 'mockup'));
      for (const vp of ['desktop', 'mobile']) {
        const f = st.find((p) => p.split('/').pop().includes(vp));
        out.push(f ? C.newer(f, newest, `mockup ${vp} still`) : [false, `mockup ${vp} still missing (shoot.mjs cook/mockup --out cook/stills/mockup --name mockup)`]);
      }
      const cmp = (() => { try { return readdirSync(S('compare', 'mockup')).filter((f) => /\.(jpe?g|png)$/i.test(f)); } catch { return []; } })();
      out.push([cmp.length > 0, cmp.length ? 'side-by-side with the references exists' : 'no side-by-side in cook/compare/mockup (cook/scripts/side-by-side.mjs)']);
      out.push(C.reportOk('slop-mockup.json', newest, 'slop scan of the mockup'));
      out.push(...judgeChecks(g, 'mockup', 'mockup', newest));
      out.push(C.approval(g, 'mockup'));
      break;
    }
    case '3': {
      out.push([Boolean(g.target?.judge), `bar set: judge ${g.target?.judge}/10, floor ${g.target?.floor}, similarity stretch ${g.target?.similarity}%`]);
      out.push([g.target.judge >= 9 || quoteOk(g.target.lowered_by_user), g.target.judge >= 9 ? 'bar is 9.0 or higher' : `bar lowered below 9.0 by the user: "${g.target.lowered_by_user || ''}"`]);
      const bar = briefLine('Bar');
      out.push([Boolean(bar && bar.includes(String(g.target.judge))), bar ? `BRIEF.md Bar: ${bar}` : 'BRIEF.md has no "Bar:" line with the same number']);
      break;
    }
    case '4': {
      out.push([Boolean(g.time?.started && g.time?.mode), g.time?.mode ? `time: ${g.time.mode} ${g.time.hours}h, started ${g.time.started}` : 'time not set (gate.mjs set-time --floor 3h)']);
      out.push([briefLine('Time') !== null, 'BRIEF.md has a "Time:" line']);
      break;
    }
    case '5': {
      out.push(C.file(S('bans.json'), 'bans file'));
      const b = readJson(S('bans.json'), {});
      const bad = (b.allowed || []).filter((a) => !quoteOk(a.quote));
      out.push([bad.length === 0, bad.length ? `bans switched off without the user's words: ${bad.map((a) => a.id).join(', ')}` : 'every switched-off ban has the user\'s words']);
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
      out.push(...judgeChecks(g, r, 'static', newest));
      out.push(C.approval(g, 'static'));
      break;
    }
    case '6b': {
      if (g.motion === 'none') { out.push([quoteOk(g.motion_quote), `no motion, user said: "${g.motion_quote || ''}"`]); break; }
      const motion = (() => { try { return readFileSync(S('MOTION.md'), 'utf8'); } catch { return ''; } })();
      const effects = motion.split('\n').filter((l) => /^\s*(-|\|\s*[^-\s|])/.test(l) && !/^\s*\|\s*(Ref|Effect|Reference)\b/i.test(l)).length;
      out.push([effects >= 5, `MOTION.md lists ${effects} effect(s) taken from the motion references (need 5+, timings and easing included)`]);
      const files = srcFiles(g);
      const newest = newestMtime(files);
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
      const s = summaryFor(r);
      if (s) out.push([s.different_model === true || quoteOk(g.single_model_quote), s.different_model ? 'at least one judge ran on a different model or in a separate session' : 'every judge ran on the builder\'s model in this session: add one from a different model or a separate session (/frontend-cook-judge)']);
      if (g.time?.mode === 'floor') { const h = hoursElapsed(g); out.push([h >= g.time.hours, `${h.toFixed(1)}h elapsed (floor ${g.time.hours}h). Done before the floor means the bar was read too low`]); }
      out.push(C.approval(g, 'final'));
      break;
    }
    default: fail(`unknown step ${step}. Steps: ${STEPS.join(', ')}`);
  }
  return out;
}

function roundEvidence(g, r, newest, needVideo) {
  const out = [];
  const st = images(S('stills', r));
  for (const vp of ['desktop', 'mobile']) {
    const f = st.filter((p) => p.split('/').pop().includes(vp)).sort((a, b) => mtime(a) - mtime(b))[0];
    out.push(f ? C.newer(f, newest, `${r} ${vp} stills`) : [false, `${r} ${vp} stills missing (shoot.mjs <url> --out cook/stills/${r} --name S01)`]);
  }
  if (needVideo) {
    let vids = []; try { vids = readdirSync(S('stills', r)).filter((f) => f.endsWith('-motion.webm')).map((f) => S('stills', r, f)); } catch { /* none */ }
    out.push(vids.length ? C.newer(vids[0], newest, `${r} motion recording`) : [false, `${r} motion recording missing (shoot.mjs <url> --out cook/stills/${r} --name S01 --live --video 12)`]);
  }
  const cmp = (() => { try { return readdirSync(S('compare', r)).filter((f) => /\.(jpe?g|png)$/i.test(f)); } catch { return []; } })();
  out.push([cmp.length > 0, cmp.length ? `${r} side-by-side exists` : `${r} side-by-side missing (cook/compare/${r}/)`]);
  out.push(C.reportOk(`slop-${r}.json`, newest, `${r} slop scan`));
  out.push(C.reportOk(`audit-${r}.json`, newest, `${r} audit`));
  return out;
}

function print(title, checks) {
  console.log(title);
  for (const [ok, msg] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  const bad = checks.filter(([ok]) => !ok).length;
  console.log(bad ? `\n${bad} requirement(s) not met.` : '\nAll requirements met.');
  return bad === 0;
}

function nextStep(g) { return STEPS.find((s) => !['passed', 'overridden'].includes(g.steps[s]?.status)) || null; }

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
  const models = new Set(judges.map((j) => `${j.model || 'unknown'}|${j.session || 'subagent'}`));
  const gaps = judges.flatMap((j) => (j.gaps || []).map((x) => ({ judge: j.judge || j.file, ...x })));
  return {
    judges: judges.length, problems, raw, offset, calibrated: cal,
    spread_overall: spread, spread_ok: judges.length >= 3 || (spread !== null && spread <= 1.0),
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
      mkdirSync(S(), { recursive: true });
      const g = {
        version: 1, project, created: new Date().toISOString(),
        target: { judge: 9.2, floor: 8.5, similarity: 99, mockup: 8.0 },
        time: null, build: null, motion: null,
        calibration: { offset: 0, history: [] },
        approvals: {}, overrides: {},
        steps: Object.fromEntries(STEPS.map((s) => [s, { status: 'pending' }])),
      };
      save(g);
      const pre = C.preflight();
      if (pre[0]) { g.steps['0'] = { status: 'passed', at: new Date().toISOString(), evidence: [pre[1]] }; save(g); }
      console.log(`created cook/GATES.json for "${project}". Step 0: ${pre[0] ? 'passed' : 'NOT passed: ' + pre[1]}`);
      break;
    }
    case 'status': {
      const g = load();
      console.log(`Project: ${g.project}   Bar: ${g.target.judge}/10 (floor ${g.target.floor})   Calibration offset: ${g.calibration.offset}`);
      if (g.time) console.log(`Time: ${g.time.mode} ${g.time.hours}h, ${hoursElapsed(g).toFixed(1)}h elapsed`);
      for (const s of STEPS) {
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
      if (!STEPS.includes(a1)) fail(`check needs a step: ${STEPS.join(', ')}`);
      process.exit(print(`May step ${a1} (${STEP_NAMES[a1]}) start?`, startChecks(g, a1)) ? 0 : 1);
      break;
    }
    case 'verify': {
      const g = load();
      if (!STEPS.includes(a1)) fail(`verify needs a step: ${STEPS.join(', ')}`);
      const pre = startChecks(g, a1);
      const done = doneChecks(g, a1);
      const ok = print(`Is step ${a1} (${STEP_NAMES[a1]}) done?`, [...pre, ...done]);
      if (ok) { g.steps[a1] = { status: 'passed', at: new Date().toISOString(), evidence: done.map(([, m]) => m) }; save(g); console.log(`Step ${a1} marked PASSED.`); }
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'approve': {
      const g = load();
      if (!['mockup', 'static', 'final'].includes(a1)) fail('approve mockup|static|final --quote "<user words>"');
      const q = opt('--quote');
      if (!quoteOk(q)) fail('an approval needs the user\'s exact words in --quote (8+ characters). Never approve on the user\'s behalf.');
      g.approvals[a1] = { quote: q, at: new Date().toISOString() };
      save(g);
      console.log(`recorded ${a1} approval: "${q}"`);
      break;
    }
    case 'override': {
      const g = load();
      if (!STEPS.includes(a1) || a1 === '0') fail('override <step 1-8> --quote "<user words>" --reason "<why>" (setup cannot be overridden: the other skills are required)');
      const q = opt('--quote'), reason = opt('--reason');
      if (!quoteOk(q) || !reason) fail('an override needs the user\'s exact words (--quote) and a --reason');
      g.overrides[a1] = { quote: q, reason, at: new Date().toISOString(), unmet: doneChecks(g, a1).filter(([ok]) => !ok).map(([, m]) => m) };
      g.steps[a1] = { status: 'overridden', at: new Date().toISOString() };
      save(g);
      console.log(`step ${a1} OVERRIDDEN by the user. Logged unmet requirements:\n  ${g.overrides[a1].unmet.join('\n  ') || '(none)'}\nThis stays in the final report.`);
      break;
    }
    case 'reopen': {
      const g = load();
      const i = STEPS.indexOf(a1); if (i < 0) fail('reopen <step>');
      for (const s of STEPS.slice(i)) g.steps[s] = { status: 'pending' };
      if (i <= STEPS.indexOf('2')) delete g.approvals.mockup;
      if (i <= STEPS.indexOf('6a')) delete g.approvals.static;
      delete g.approvals.final;
      save(g);
      console.log(`steps ${STEPS.slice(i).join(', ')} set back to pending`);
      break;
    }
    case 'set-bar': {
      const g = load();
      const judge = Number(opt('--judge', g.target.judge));
      const floor = Number(opt('--floor', g.target.floor));
      const sim = Number(opt('--similarity', g.target.similarity));
      const mock = Number(opt('--mockup', g.target.mockup));
      if (![judge, floor, sim, mock].every(Number.isFinite)) fail('numbers only');
      if (judge < 9 && !quoteOk(opt('--quote'))) fail(`a bar below 9.0 makes average work pass. Only with the user's words: --quote "..."`);
      if (floor > judge) fail('floor cannot be above the bar');
      g.target = { judge, floor, similarity: sim, mockup: mock, ...(judge < 9 ? { lowered_by_user: opt('--quote') } : {}) };
      save(g);
      console.log(`bar: overall ${judge}/10, every dimension ${floor}+, similarity stretch ${sim}%, mockup feel ${mock}/10`);
      break;
    }
    case 'set-time': {
      const g = load();
      const parseH = (v) => { const m = /^(\d+(?:\.\d+)?)\s*(h|m)?$/i.exec(v || ''); return m ? (m[2]?.toLowerCase() === 'm' ? +m[1] / 60 : +m[1]) : null; };
      const floor = parseH(opt('--floor')), cap = parseH(opt('--cap'));
      if ((floor === null) === (cap === null)) fail('set-time needs exactly one of --floor <hours> or --cap <hours>');
      g.time = { mode: floor !== null ? 'floor' : 'cap', hours: floor ?? cap, started: g.time?.started || new Date().toISOString() };
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
    case 'set-motion': {
      const g = load();
      if (argv.includes('--none')) {
        if (!quoteOk(opt('--quote'))) fail('no motion only with the user\'s words: --none --quote "..."');
        g.motion = 'none'; g.motion_quote = opt('--quote');
      } else g.motion = 'refs';
      save(g); console.log(`motion: ${g.motion}`);
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
      const user = Number(opt('--user'));
      if (!Number.isFinite(user) || user < 0 || user > 10) fail('calibrate --user <0-10>');
      const r = opt('--round') || latestRound() || (existsSync(S('judge', 'mockup', 'summary.json')) ? 'mockup' : null);
      const s = r && summaryFor(r);
      if (!s) fail('no scored round to calibrate against');
      const gap = Math.round((user - s.raw.overall) * 100) / 100;
      if (gap < g.calibration.offset) {
        g.calibration.offset = gap;
        g.calibration.history.push({ at: new Date().toISOString(), round: r, user, judges: s.raw.overall, offset: gap });
        save(g);
        console.log(`calibration offset now ${gap}: every later score is lowered by ${-gap}. Rescore open rounds with gate.mjs score <round>.`);
      } else if (gap > 0) {
        g.calibration.history.push({ at: new Date().toISOString(), round: r, user, judges: s.raw.overall, offset: g.calibration.offset, note: 'user higher than judges: not applied' });
        save(g);
        console.log(`Not applied. You rate it ${user}, the judges ${s.raw.overall}. Scores are never raised to match a kinder estimate: the gaps the judges named still stand. Offset stays ${g.calibration.offset}.`);
      } else console.log(`offset stays ${g.calibration.offset}`);
      break;
    }
    case 'elapsed': { const g = load(); console.log(`${hoursElapsed(g).toFixed(2)}h${g.time ? ` of ${g.time.mode} ${g.time.hours}h` : ' (timer not set)'}`); break; }
    default:
      console.log('usage: gate.mjs init|status|check|verify|approve|override|reopen|set-bar|set-time|set-build|set-motion|score|calibrate|elapsed (see the header of this file)');
      process.exit(cmd ? 2 : 0);
  }
}
