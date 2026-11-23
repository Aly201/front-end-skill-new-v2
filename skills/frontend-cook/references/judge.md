# Judges

The builder never scores its own work. Judges are fresh: no history, no code, no brief, no ledger, no previous scores, no idea who built it or how long it took.

## How to run them

- **Subagents (default):** start each one with the Agent tool as a new agent (not a fork: a fork inherits your context). Give it only the prompt below and the image paths. Use at least 2 per round (3 recommended for step 8). Where the harness lets you pick the model, put at least one judge on a different model from yours.
- **Separate session (required for step 8):** the user opens a new Claude Code session in the project and runs `/frontend-cook-judge <round>`. That judge has never seen the conversation. The gate does not trust the file's own `"session"` field: it checks the guard log (`cook/.ledger.jsonl`) for a judge file written by a session that never edited the build or the mockup, and for the reads that session logged (below). That judge must meet the bar on its own; the other judges do not carry it.
- **Script judge (any platform, also valid for step 8):** `node <skill>/scripts/judge.mjs --round <round>`. It sends only the round's side-by-sides, A/B pairs and fold stills, with this prompt and the rubric, to the Claude API, and writes the judge file itself with the API message id and the sha1 of every image. The gate counts it as fresh and separate when those images are unchanged and from this round; it needs no ledger. Run it once per judge. Details and setup: `references/portable.md`.
- **Judge files are written once.** The guard refuses a second write to a judge file. To change a score, add a judge or start a new round. `gate.mjs archive-judges <round>` moves the old files aside; if a later judge reuses a filename, the gate attributes that file to its latest writer (the newest ledger entry for that path), not to the writer that came first.
- **Every judge scores every dimension.** Each file needs a score for every dimension in the prompt below (`layout`, `typography`, `color`, `components`, `imagery`, `responsive`, and `motion` from step 6b on). `gate.mjs score` rejects a file that misses one with `<file>: missing score for <dim>`. No judge may skip a dimension it cannot judge: it gives its best score and names the gap.

## What a judge may read (checked from the log)

The guard logs every Read, Glob and Grep, with the file or pattern. A judge file counts only when its session read:
- at least one image from `cook/compare/<round>/` and at least one from `cook/stills/<round>/` (for the baseline round: `cook/baseline/stills/`), and
- none of the following: any file under the build source (any `--src` folder), `cook/BRIEF.md`, `cook/ROUNDS.md`, `cook/SECTIONS.md`, `cook/judge/<round>/summary.json`, or another judge's file in the round.

A rejected file says which read broke the rule, for example `judge-B.json: its session read cook/BRIEF.md (not fresh)`. Reading `cook/bans.json` (its `user_bans` and `brand_constraints` only), the `target` block of `cook/GATES.json` and the rubric is allowed. Other folders are off limits as well: `cook/reports/`, `cook/baseline/` (except its stills for the baseline round), the rest of `cook/judge/`, and `.abkey.json`, which says which side of an `ab` pair is new. The judge skill (`frontend-cook-judge`) states these rules to the judge.

If the log has no reads at all (the hook was installed before 1.5.0), step 8 fails with `judge reads not logged: update the hook with preflight --install`. Update the hook, then judge again in a new session. Other steps are not affected.
- **Judge the current build.** A judge file older than the latest source change does not count. Judge the new build in a new round.
- **No second session and no API credentials for `judge.mjs`:** the run cannot pass step 8. Say so; do not self-score.

## What a judge gets

- `cook/compare/<round>/*.jpg`: references left, build right.
- `cook/stills/<round>/*-fold.png` and the full-page stills, desktop and mobile.
- For motion rounds: `cook/stills/<round>/*-motion-strip.jpg` and the `.webm` path.
- Redesign rounds only: `cook/compare/<round>/ab-*.jpg`, pairs of the old site and the round's build, side by side, with no labels. Left or right is random. Judges never learn which side is new.
- Redesign baseline (step 1): `cook/compare/baseline/*.jpg` (reference left, old site right), scored into `cook/judge/baseline/`. No `ab` key: pairs are made only for rounds.
- The bar numbers, this prompt, and the `user_bans` and `brand_constraints` lists from `cook/bans.json`. Nothing else.
- `brand_constraints` (redesign of an existing brand, or a brand the user already has): the owner's approved rules, each with the user's words, e.g. `{ "rule": "dark graphite ground, no cards or shadows", "quote": "..." }`. Tell judges not to mark the work down for following them, and to score execution within them.

## The prompt

```text
You are a senior art director at a studio that wins Awwwards Site of the Day.
You are seeing this work for the first time. You have no reason to be kind.

Images: [paths]. In each side-by-side, the left is a real reference site and the right is the build.
Score the BUILD from 0 to 10 on each dimension:
layout, typography, color, components, imagery, responsive, and motion (from step 6b on).
Anchors: 10 = Site of the Day, 9 = professional studio quality next to the references,
8 = a clean template, 7 = generic / visibly AI-made, 6 or less = visible problems.
Also give an overall score (your verdict, not an average) and similarity 0-100
(how close the build is to the references in quality and feel).

Name at least 3 gaps, most important first: where (section and viewport), what is wrong,
what exactly to change (sizes, spacing, colors, weights, crops). No vague advice.
List any of these you see: beige, purple gradients, eyebrow labels, monospace uppercase,
01/02/03 counters, glowing orbs, gradient text, emoji icons, stock-photo people, fake dashboards,
three identical icon cards, everything centered, everything in rounded shadowed cards, grey low-contrast text,
generic phrases like "Unlock the power", em dashes[, and the user's own bans: <user_bans from cook/bans.json>].
[Approved brand rules, do NOT mark down for following them, judge execution within them: <brand_constraints from cook/bans.json>]

[Redesign rounds only] Also look at each ab-*.jpg pair. Say which page is better, left or right, and why, in one line. Judge the page, not the position. The ab list is required for every pair listed in the round.

Write ONLY this JSON to [cook/judge/<round>/judge-<letter>.json]:
{"judge":"<letter>","fresh":true,"model":"<your model>","session":"subagent",
 "scores":{"layout":0,"typography":0,"color":0,"components":0,"imagery":0,"responsive":0[,"motion":0]},
 "overall":0,"similarity":0,
 "gaps":[{"where":"","what":"","fix":""}],
 "slop_seen":[],"would_ship":false}
```

Redesign rounds add one key to that JSON: `"ab":[{"pair":"ab-1","better":"left|right","why":"..."}]`, with one entry per pair in `ab-*.jpg`.

Set `"different_model": true` in a judge's file when it ran on a different model from the builder. It is recorded but not proof: only the separate session is verified.

## After the judges

1. `gate.mjs score <round>`. It rejects files that are not fresh, have scores outside 0-10, name fewer than 3 gaps, or miss a dimension (`<file>: missing score for <dim>`). The first check applies to every judge file in a round, and the forbidden-read check to every judge session. Both run in `verify 8`.
2. Redesign: `pair.mjs` keeps the old/new key in a protected file. Every judge in the final round must have an `ab` entry for every pair, and every choice must be the new side. `verify 8` checks this. A judge that prefers the old side in any pair fails the round: fix the design, do not re-run the judge.
3. Agreement: with 2 judges, their overall scores must be within 1.0. With 3 or more, the lowest must be within 1.0 of the median. If not, fix what the low judge named, or add a judge in a new round.
4. The weakest dimension and the top gaps become the next round's focus.
5. Never edit a judge's file. Never re-run a judge until you like the number. Fix the work instead.
