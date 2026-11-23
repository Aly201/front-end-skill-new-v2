#!/usr/bin/env node
// A judge that is a script, not a session: it sends ONLY the round's images and the rubric to a model
// through the Claude API and writes the judge file itself. The building agent never writes a score, so it
// cannot fake one, on any platform (Claude Code, Codex, Cursor, Antigravity...). The file records the model,
// the API message id and the sha1 of every image sent; the gate checks those sha1s against the current files.
//
// Usage: node judge.mjs --round <mockup|baseline|rNN> [--model claude-opus-5-5] [--effort high] [--max-images 20]
// Needs: the @anthropic-ai/sdk package (preflight --install puts it in ~/.frontend-cook) and Claude API
// credentials (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile).
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename, extname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { projectRoot, readJson, readGates, loadPackage, isMain, STATE_DIR } from './_common.mjs';

const DIMS = ['layout', 'typography', 'color', 'components', 'imagery', 'responsive'];
const IMG = /\.(png|jpe?g|webp)$/i;
const MAX_SIDE = 7800; // the API's per-image limit is 8000 px on a side

function die(code, msg) { console.error(`judge: ${msg}`); process.exit(code); }
const sha1 = (p) => createHash('sha1').update(readFileSync(p)).digest('hex');
const list = (dir, re = IMG) => { try { return readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f)); } catch { return []; } };

// The images a judge may see for a round: side-by-sides (reference left, build right), the fold stills,
// motion filmstrips, and unlabeled old/new pairs (redesign step 8). Never source, brief, ledger or other judges.
export function judgeInputs(root, round) {
  const S = (...p) => join(root, STATE_DIR, ...p);
  const compare = list(S('compare', round));
  const sideBySides = compare.filter((p) => !/^ab-\d+\.jpe?g$/i.test(basename(p)));
  const pairs = compare.filter((p) => /^ab-\d+\.jpe?g$/i.test(basename(p)));
  const stillsDir = round === 'baseline' ? S('baseline', 'stills') : S('stills', round);
  const stills = list(stillsDir).filter((p) => /-fold\.(png|jpe?g)$/i.test(p) || /-motion-strip\.jpe?g$/i.test(p));
  return { sideBySides, pairs, stills, motion: stills.some((p) => /-motion-strip\./i.test(p)) };
}

export function schemaFor(dims, withPairs) {
  const scores = { type: 'object', properties: Object.fromEntries(dims.map((d) => [d, { type: 'number' }])), required: dims, additionalProperties: false };
  const props = {
    scores,
    overall: { type: 'number' },
    similarity: { type: 'number' },
    gaps: { type: 'array', items: { type: 'object', properties: { where: { type: 'string' }, what: { type: 'string' }, fix: { type: 'string' } }, required: ['where', 'what', 'fix'], additionalProperties: false } },
    slop_seen: { type: 'array', items: { type: 'string' } },
    would_ship: { type: 'boolean' },
  };
  const required = ['scores', 'overall', 'similarity', 'gaps', 'slop_seen', 'would_ship'];
  if (withPairs) {
    props.ab = { type: 'array', items: { type: 'object', properties: { pair: { type: 'string' }, better: { type: 'string', enum: ['left', 'right'] }, why: { type: 'string' } }, required: ['pair', 'better', 'why'], additionalProperties: false } };
    required.push('ab');
  }
  return { type: 'object', properties: props, required, additionalProperties: false };
}

export function promptFor({ dims, target, bans, pairNames }) {
  const lines = [
    'You are a senior art director at a studio that wins Awwwards Site of the Day. You are seeing this work for the first time and have no reason to be kind.',
    'In each side-by-side image, the LEFT is a real reference site and the RIGHT is the build. The other images are the build\'s own screenshots (first screen, desktop and mobile; filmstrips show motion).',
    `Score the BUILD from 0 to 10 on each dimension: ${dims.join(', ')}. Anchors: 10 = Site of the Day, 9 = professional studio quality next to the references, 8 = a clean template, 7 = generic or visibly AI-made, 6 or less = visible problems.`,
    'Give an overall score (your verdict, not an average) and similarity 0-100 (how close the build is to the references in quality and feel).',
    'Name at least 3 gaps, most important first: where (section and viewport), what is wrong, what exactly to change (sizes, spacing, colors, weights, crops). No vague advice.',
    'List any of these you see in slop_seen: beige, purple gradients, eyebrow labels, monospace uppercase, 01/02/03 counters, glowing orbs, gradient text, emoji icons, stock-photo people, fake dashboards, three identical icon cards, everything centered, everything in rounded shadowed cards, grey low-contrast text, generic phrases like "Unlock the power", em dashes.',
  ];
  if (bans.user_bans?.length) lines.push(`Also the owner's own bans: ${bans.user_bans.join('; ')}.`);
  if (bans.brand_constraints?.length) {
    lines.push(`Approved brand rules (do NOT mark the work down for following them; judge execution within them): ${bans.brand_constraints.map((b) => (typeof b === 'string' ? b : b.rule)).join('; ')}.`);
  }
  if (target) lines.push(`For context only: the bar is ${target.judge}/10 overall, ${target.floor}+ per dimension. Do not let it pull your scores up or down.`);
  if (pairNames.length) {
    lines.push(`The images named ${pairNames.join(', ')} each show two versions of the same page, left and right, with no labels. For every one, say which side is better designed (better: "left" or "right") and why, in ab.`);
  }
  lines.push('Reply only with the JSON the schema asks for.');
  return lines.join('\n');
}

// Downscale an image that is too large for the API, as JPEG, into a temp folder. Returns the path to send.
function fitForApi(path, tmp) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  const [w, h] = String(probe.stdout || '').trim().split(',').map(Number);
  if (!w || !h || (w <= MAX_SIDE && h <= MAX_SIDE)) return path;
  const out = join(tmp, `${basename(path, extname(path))}.jpg`);
  const scale = w >= h ? `${MAX_SIDE}:-2` : `-2:${MAX_SIDE}`;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vf', `scale=${scale}`, '-q:v', '3', out]);
  return r.status === 0 ? out : path;
}

const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

export function validate(out, dims, pairNames) {
  const bad = [];
  for (const d of dims) if (typeof out?.scores?.[d] !== 'number' || out.scores[d] < 0 || out.scores[d] > 10) bad.push(`score ${d}`);
  if (typeof out?.overall !== 'number' || out.overall < 0 || out.overall > 10) bad.push('overall');
  if (!Array.isArray(out?.gaps) || out.gaps.length < 3) bad.push('3+ gaps');
  for (const p of pairNames) if (!out?.ab?.some((x) => x.pair === p && (x.better === 'left' || x.better === 'right'))) bad.push(`ab ${p}`);
  return bad;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const round = opt('--round');
  if (!round || !/^(mockup|baseline|r\d{2,})$/.test(round)) die(2, 'usage: node judge.mjs --round <mockup|baseline|rNN> [--model claude-opus-5-5] [--effort high]');
  const model = opt('--model', 'claude-opus-5-5');
  const effort = opt('--effort', 'high');
  const maxImages = Number(opt('--max-images', '20'));
  const root = projectRoot();
  const g = readGates(root) || {};
  const bans = readJson(join(root, STATE_DIR, 'bans.json'), {}) || {};
  const { sideBySides, pairs, stills, motion } = judgeInputs(root, round);
  if (!sideBySides.length && !pairs.length) die(2, `no side-by-sides in cook/compare/${round}: build them first (reference left, build right)`);
  if (!stills.length) die(2, `no fold stills for ${round}: take them first (shoot.mjs --fold)`);
  const sent = [...sideBySides, ...pairs, ...stills].slice(0, maxImages);
  const pairNames = pairs.filter((p) => sent.includes(p)).map((p) => basename(p, extname(p)));
  const dims = motion ? [...DIMS, 'motion'] : DIMS;

  const tmp = mkdtempSync(join(tmpdir(), 'fecook-judge-'));
  const content = [];
  for (const p of sent) {
    const f = fitForApi(p, tmp);
    content.push({ type: 'text', text: `Image ${basename(p)}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: MEDIA[extname(f).toLowerCase()] || 'image/jpeg', data: readFileSync(f).toString('base64') } });
  }
  content.push({ type: 'text', text: promptFor({ dims, target: g.target, bans, pairNames }) });
  const params = {
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort, format: { type: 'json_schema', schema: schemaFor(dims, pairNames.length > 0) } },
    messages: [{ role: 'user', content }],
  };

  let response;
  try {
    if (process.env.FRONTEND_COOK_JUDGE_MOCK) {
      // Tests only: a module whose default export takes the request and returns a message.
      response = await (await import(pathToFileURL(process.env.FRONTEND_COOK_JUDGE_MOCK).href)).default(params);
    } else {
      const sdk = loadPackage('@anthropic-ai/sdk', root);
      if (!sdk) die(1, 'the @anthropic-ai/sdk package is not installed: run preflight.mjs --install (it installs it into ~/.frontend-cook) or npm i -D @anthropic-ai/sdk');
      const Anthropic = sdk.default || sdk.Anthropic || sdk;
      const client = new Anthropic();
      try {
        response = await client.beta.messages.create(params);
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) die(1, 'no valid Claude API credentials: set ANTHROPIC_API_KEY or run `ant auth login`');
        if (e instanceof Anthropic.RateLimitError) die(1, 'rate limited by the Claude API: wait and run it again');
        if (e instanceof Anthropic.BadRequestError) die(1, `the API refused the request: ${e.message}`);
        if (e instanceof Anthropic.APIError) die(1, `Claude API error ${e.status}: ${e.message}`);
        if (/authentication method|api ?key/i.test(String(e?.message))) die(1, 'no Claude API credentials: the user sets ANTHROPIC_API_KEY in their own environment (or runs `ant auth login`), never in chat');
        die(1, `the request failed: ${e?.message || e}`);
      }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  if (response.stop_reason === 'refusal') die(1, `the model declined to judge (${response.stop_details?.category || 'no category'}): no judge file written`);
  if (response.stop_reason === 'max_tokens') die(1, 'the judgment was cut off (max_tokens): run it again');
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { die(1, 'the model did not return valid JSON: run it again'); }
  const bad = validate(out, dims, pairNames);
  if (bad.length) die(1, `the judgment is incomplete (${bad.join(', ')}): run it again`);

  const dir = join(root, STATE_DIR, 'judge', round);
  mkdirSync(dir, { recursive: true });
  const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((l) => !existsSync(join(dir, `judge-${l}.json`)));
  if (!letter) die(1, `no free judge letter in cook/judge/${round}: run gate.mjs archive-judges ${round} first`);
  const file = join(dir, `judge-${letter}.json`);
  const doc = {
    judge: letter, fresh: true, session: 'script', judged_by: 'judge.mjs', provider: 'anthropic',
    model: response.model || model, message_id: response.id || null, request_id: response._request_id || null,
    effort, at: new Date().toISOString(),
    images: sent.map((p) => ({ path: relative(root, p).split('\\').join('/'), sha1: sha1(p) })),
    scores: out.scores, overall: out.overall, similarity: out.similarity, gaps: out.gaps,
    slop_seen: out.slop_seen, would_ship: out.would_ship, ...(pairNames.length ? { ab: out.ab } : {}),
  };
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote ${relative(root, file)}: overall ${out.overall}/10 (${doc.model}), ${sent.length} image(s). Next: gate.mjs score ${round}`);
}
