#!/usr/bin/env node
// Builds blind A/B pairs for a redesign round: the baseline fold still and the round's fold still
// per page and viewport, side by side (same height), with the new side placed left or right at random.
// Writes cook/compare/rNN/ab-<n>.jpg and the key cook/judge/rNN/.abkey.json (never printed).
// Old ab-*.jpg files and the old key are deleted first, so a failed run cannot leave a stale pair behind.
// Exits 1 when a page that has a baseline fold still has no fold still for this round (the round is not
// complete). Pages without a baseline still are skipped with a note.
//
// Usage: node pair.mjs --round rNN [--height 900]    (from the project root)
import { mkdirSync, existsSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { projectRoot, readGates, pageSlug, STATE_DIR } from './_common.mjs';

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
function die(code, msg) { console.error(`pair: ${msg}`); process.exit(code); }

const round = opt('--round');
if (!round || !/^r\d+$/.test(round)) die(2, 'usage: node pair.mjs --round rNN');
const height = Number(opt('--height', '900'));
if (!Number.isInteger(height) || height < 100) die(2, '--height must be an integer of at least 100');

const root = projectRoot();
const gates = readGates(root);
if (!gates) die(2, `no ${STATE_DIR}/GATES.json here.`);
const pages = gates.pages?.length ? gates.pages : ['/'];
const VIEWPORTS = ['desktop', 'mobile'];

const compareDir = join(root, STATE_DIR, 'compare', round);
const judgeDir = join(root, STATE_DIR, 'judge', round);
mkdirSync(compareDir, { recursive: true });
mkdirSync(judgeDir, { recursive: true });

// Stale pairs and key from an earlier run go first.
for (const f of readdirSync(compareDir)) if (/^ab-\d+\.jpg$/.test(f)) rmSync(join(compareDir, f));
rmSync(join(judgeDir, '.abkey.json'), { force: true });

// Plan first: every page with a baseline still must have this round's still, before any pair is written.
const plan = [];
const skipped = [];
const missing = [];
for (const page of pages) {
  for (const vp of VIEWPORTS) {
    const slug = pageSlug(page);
    const oldFile = join(root, STATE_DIR, 'baseline', 'stills', `${slug}-${vp}-fold.png`);
    const newFile = join(root, STATE_DIR, 'stills', round, `${slug}-${vp}-fold.png`);
    if (!existsSync(oldFile)) { skipped.push(`${page} ${vp}`); continue; }
    if (!existsSync(newFile)) { missing.push(`${page} ${vp}`); continue; }
    plan.push({ page, vp, oldFile, newFile });
  }
}
if (missing.length) {
  die(1, `${STATE_DIR}/stills/${round} has no fold still for: ${missing.join(', ')} (the baseline has one). Shoot the round's stills for these pages first.`);
}
if (!plan.length) die(1, `no pairs: need ${STATE_DIR}/baseline/stills and ${STATE_DIR}/stills/${round} fold stills for the same pages`);
if (skipped.length) console.log(`note: skipped (no baseline fold still, so nothing to compare): ${skipped.join(', ')}`);

const pairs = [];
let n = 0;
for (const { page, vp, oldFile, newFile } of plan) {
  n += 1;
  const newSide = randomInt(2) === 0 ? 'left' : 'right';
  const [left, right] = newSide === 'left' ? [newFile, oldFile] : [oldFile, newFile];
  const name = `ab-${n}`;
  const out = join(compareDir, `${name}.jpg`);
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', left, '-i', right,
    '-filter_complex', `[0:v]scale=-2:${height}[a];[1:v]scale=-2:${height}[b];[a][b]hstack=inputs=2`,
    '-frames:v', '1', '-q:v', '3', out,
  ], { encoding: 'utf8' });
  if (r.status !== 0) die(1, `ffmpeg failed on ${name}: ${String(r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
  pairs.push({ pair: name, page, viewport: vp, new: newSide, file: relative(root, out).split(sep).join('/') });
}

const key = pairs.map(({ pair, page, viewport, new: side }) => ({ pair, page, viewport, new: side }));
writeFileSync(join(judgeDir, '.abkey.json'), JSON.stringify(key, null, 2) + '\n');

for (const p of pairs) console.log(`wrote ${p.file}`);
console.log(`pairs: ${pairs.length}${skipped.length ? `; skipped (no baseline still): ${skipped.join(', ')}` : ''}`);
process.exit(0);
