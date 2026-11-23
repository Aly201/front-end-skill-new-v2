// Any platform: approvals typed by the user in their own terminal (gate.mjs say / approve), the script judge
// (judge.mjs, with a mocked API), and gate.mjs next. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { userSaid } from '../skills/frontend-cook/scripts/_common.mjs';
import { schemaFor, validate, judgeInputs } from '../skills/frontend-cook/scripts/judge.mjs';

const SCRIPTS = resolve(import.meta.dirname, '..', 'skills', 'frontend-cook', 'scripts');
const run = (dir, script, args, env = {}) => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env }, input: '' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const write = (p, t) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t); };
function png(p, w = 1440, h = 900) {
  const b = Buffer.alloc(41);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  randomBytes(8).copy(b, 33);
  mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, b);
}
function project() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fecook-port-')));
  write(join(d, 'cook', 'PREFLIGHT.json'), JSON.stringify({ ok: true, checked_at: new Date().toISOString(), checks: {} }));
  assert.equal(run(d, 'gate.mjs', ['init', '--project', 'P']).code, 0);
  return d;
}
// A round with one side-by-side and one fold still: what judge.mjs sends.
function round(d, r = 'r01') {
  png(join(d, 'cook', 'compare', r, 'all.jpg'));
  png(join(d, 'cook', 'stills', r, 'S01-desktop-fold.png'));
}
const GAPS = [{ where: 'hero', what: 'x', fix: 'y' }, { where: 'nav', what: 'x', fix: 'y' }, { where: 'footer', what: 'x', fix: 'y' }];
// A mock API: answers with the given overall, or with the given stop reason.
function mock(d, { overall = 9.2, stop = 'end_turn' } = {}) {
  const p = join(d, 'mock-api.mjs');
  writeFileSync(p, `export default async function (params) {
    const dims = params.output_config.format.schema.properties.scores.required;
    globalThis.__seen = params;
    const out = { scores: Object.fromEntries(dims.map((k) => [k, ${overall}])), overall: ${overall}, similarity: 80, gaps: ${JSON.stringify(GAPS)}, slop_seen: [], would_ship: true };
    const images = params.messages[0].content.filter((b) => b.type === 'image').length;
    if (images < 2) throw new Error('images were not sent');
    return { id: 'msg_test_1', model: 'claude-opus-5-5', stop_reason: '${stop}', stop_details: { category: 'test' }, content: [{ type: 'text', text: JSON.stringify(out) }] };
  }\n`);
  return { FRONTEND_COOK_JUDGE_MOCK: p };
}

test('say and approve without --quote need the user at their own terminal (no TTY: refused)', () => {
  const d = project();
  const s = run(d, 'gate.mjs', ['say']);
  assert.equal(s.code, 2);
  assert.match(s.out, /own interactive terminal/);
  const a = run(d, 'gate.mjs', ['approve', 'references']);
  assert.equal(a.code, 2);
  assert.match(a.out, /own interactive terminal/);
  assert.equal(existsSync(join(d, 'cook', '.ledger.jsonl')) && /UserTTY/.test(readFileSync(join(d, 'cook', '.ledger.jsonl'), 'utf8')), false);
});

test('userSaid accepts words the user typed through gate.mjs say (UserTTY)', () => {
  const d = project();
  // No words logged at all: the gate says how the user types them on any platform.
  const before = run(d, 'gate.mjs', ['no-user-refs', '--quote', 'These references look right']);
  assert.equal(before.code, 2);
  assert.match(before.out, /gate\.mjs say/);
  appendFileSync(join(d, 'cook', '.ledger.jsonl'), JSON.stringify({ at: new Date().toISOString(), session_id: null, tool: 'UserTTY', file: null, prompt: 'These references look right, approved.' }) + '\n');
  assert.equal(userSaid(d, 'These references look right'), true);
  assert.equal(userSaid(d, 'ship it now'), false);
  // And the gate takes an approval quoted from those words, with no Claude Code hook at all.
  const r = run(d, 'gate.mjs', ['no-user-refs', '--quote', 'These references look right']);
  assert.equal(r.code, 0, r.out);
});

test('gate.mjs next names the step, the section to read and what is still missing', () => {
  const d = project();
  const r = run(d, 'gate.mjs', ['next']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /NEXT/);
  assert.match(r.out, /READ FIRST/);
  assert.match(r.out, /STILL MISSING/);
});

test('judge.mjs: schema, validation and inputs', () => {
  const sc = schemaFor(['layout', 'color'], true);
  assert.equal(sc.additionalProperties, false);
  assert.deepEqual(sc.properties.scores.required, ['layout', 'color']);
  assert.ok(sc.required.includes('ab'));
  assert.deepEqual(validate({ scores: { layout: 8, color: 8 }, overall: 8, gaps: GAPS }, ['layout', 'color'], []), []);
  assert.deepEqual(validate({ scores: { layout: 8 }, overall: 11, gaps: [] }, ['layout', 'color'], ['ab-1']), ['score color', 'overall', '3+ gaps', 'ab ab-1']);
  const d = project(); round(d); png(join(d, 'cook', 'compare', 'r01', 'ab-1.jpg')); png(join(d, 'cook', 'stills', 'r01', 'S01-desktop.png'));
  const i = judgeInputs(d, 'r01');
  assert.equal(i.sideBySides.length, 1); assert.equal(i.pairs.length, 1);
  assert.equal(i.stills.length, 1, 'only fold stills and motion strips go to the judge');
});

test('judge.mjs writes a verifiable judge file; the gate scores it with no ledger, and refuses it once an image changes', () => {
  const d = project(); round(d);
  const r = run(d, 'judge.mjs', ['--round', 'r01'], mock(d));
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(readFileSync(join(d, 'cook', 'judge', 'r01', 'judge-A.json'), 'utf8'));
  assert.equal(j.judged_by, 'judge.mjs'); assert.equal(j.session, 'script'); assert.equal(j.message_id, 'msg_test_1');
  assert.equal(j.images.length, 2);
  assert.ok(j.images.every((im) => /^[0-9a-f]{40}$/.test(im.sha1)));
  const s = run(d, 'gate.mjs', ['score', 'r01']);
  assert.equal(s.code, 0, s.out);
  assert.doesNotMatch(s.out, /REJECTED/);
  const v = run(d, 'gate.mjs', ['verify', '8']).out;
  assert.match(v, /script judge\(s\) verified: judge-A\.json/);
  assert.doesNotMatch(v, /no ledger and no script judge/);
  // A second run takes the next letter.
  assert.equal(run(d, 'judge.mjs', ['--round', 'r01'], mock(d)).code, 0);
  assert.ok(existsSync(join(d, 'cook', 'judge', 'r01', 'judge-B.json')));
  // The still changes after judging: the record no longer matches.
  png(join(d, 'cook', 'stills', 'r01', 'S01-desktop-fold.png'));
  const s2 = run(d, 'gate.mjs', ['score', 'r01']);
  assert.match(s2.out, /REJECTED judge-A\.json: judge\.mjs record: .*changed after it was judged/);
});

test('a hand-written "script judge" is refused: tampered record, or written with the Write tool', () => {
  const d = project(); round(d);
  assert.equal(run(d, 'judge.mjs', ['--round', 'r01'], mock(d)).code, 0);
  const p = join(d, 'cook', 'judge', 'r01', 'judge-A.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  // A forged sha1.
  writeFileSync(p, JSON.stringify({ ...j, images: j.images.map((im) => ({ ...im, sha1: '0'.repeat(40) })) }));
  assert.match(run(d, 'gate.mjs', ['score', 'r01']).out, /REJECTED judge-A\.json/);
  // An image from outside the round.
  writeFileSync(p, JSON.stringify({ ...j, images: [{ path: 'cook/BRIEF.md', sha1: 'x' }] }));
  assert.match(run(d, 'gate.mjs', ['score', 'r01']).out, /not this round's side-by-side or still/);
  // The right record, but the ledger shows an agent wrote it with Write.
  writeFileSync(p, JSON.stringify(j));
  appendFileSync(join(d, 'cook', '.ledger.jsonl'), JSON.stringify({ at: new Date().toISOString(), session_id: 'builder', tool: 'Write', file: 'cook/judge/r01/judge-A.json', agent: null }) + '\n');
  assert.match(run(d, 'gate.mjs', ['score', 'r01']).out, /written with the Write tool, not by judge\.mjs/);
});

test('judge.mjs writes nothing on a refusal, a cut-off answer, or a round with no images', () => {
  const d = project(); round(d);
  const r = run(d, 'judge.mjs', ['--round', 'r01'], mock(d, { stop: 'refusal' }));
  assert.equal(r.code, 1); assert.match(r.out, /declined to judge/);
  const m = run(d, 'judge.mjs', ['--round', 'r01'], mock(d, { stop: 'max_tokens' }));
  assert.equal(m.code, 1); assert.match(m.out, /cut off/);
  assert.equal(existsSync(join(d, 'cook', 'judge', 'r01', 'judge-A.json')), false);
  const e = run(d, 'judge.mjs', ['--round', 'r02'], mock(d));
  assert.equal(e.code, 2); assert.match(e.out, /no side-by-sides/);
  assert.equal(run(d, 'judge.mjs', ['--round', 'nope']).code, 2);
});
