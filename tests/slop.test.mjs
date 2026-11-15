import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scan, isBeige, isPurple, colorsIn } from '../skills/frontend-cook/scripts/slop_scan.mjs';

const fx = (n) => resolve(import.meta.dirname, 'fixtures', n);

test('the sloppy fixture trips every planted ban', () => {
  const r = scan([fx('slop')], null);
  assert.equal(r.ok, false);
  const ids = new Set(r.findings.map((f) => f.id));
  for (const id of ['beige', 'purple-gradient', 'em-dash', 'slop-copy', 'gradient-text', 'eyebrow-label', 'glow-orb', 'lorem-ipsum', 'placeholder-names', 'counter-01', 'reduced-motion', 'emoji-icon', 'default-typeface']) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
});

test('the clean fixture passes with no findings', () => {
  const r = scan([fx('clean')], null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('a ban switches off only with the user words', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bans-'));
  const bans = join(dir, 'bans.json');
  writeFileSync(bans, JSON.stringify({ allowed: [{ id: 'em-dash', quote: 'ok' }] }));
  assert.ok(scan([fx('slop')], bans).findings.some((f) => f.id === 'bans-file'), 'short quote is rejected');
  writeFileSync(bans, JSON.stringify({ allowed: [{ id: 'em-dash', quote: 'em dashes are part of our brand voice' }], extra: [{ id: 'no-ghost', pattern: '\\.ghost' }] }));
  const r = scan([fx('slop')], bans);
  assert.ok(!r.findings.some((f) => f.id === 'em-dash'));
  assert.ok(r.findings.some((f) => f.id === 'no-ghost'), 'user ban applies');
});

test('color classification', () => {
  assert.ok(isBeige(colorsIn('#f5efe3')[0].hsl));
  assert.ok(isBeige(colorsIn('rgb(245, 240, 225)')[0].hsl));
  assert.ok(!isBeige(colorsIn('#ffffff')[0].hsl));
  assert.ok(!isBeige(colorsIn('#f4f7f5')[0].hsl));
  assert.ok(isPurple(colorsIn('#7c3aed')[0].hsl));
  assert.ok(!isPurple(colorsIn('#1f6f4a')[0].hsl));
  assert.ok(!isPurple(colorsIn('#2563eb')[0].hsl), 'blue is not purple');
});
