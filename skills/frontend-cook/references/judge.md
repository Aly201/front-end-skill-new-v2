# Judges

The builder never scores its own work. Judges are fresh: no history, no code, no brief, no ledger, no previous scores, no idea who built it or how long it took.

## How to run them

- **Subagents (default):** start each one with the Agent tool as a new agent (not a fork: a fork inherits your context). Give it only the prompt below and the image paths. Use at least 2 per round, 3+ for step 8. Where the harness lets you pick the model, put at least one judge on a different model from yours.
- **Separate session (required for step 8):** the user opens a new Claude Code session in the project and runs `/frontend-cook-judge <round>`. That judge has never seen the conversation. The gate does not trust the file's own `"session"` field: it checks the guard log (`cook/.ledger.jsonl`) for a judge file written by a session that never edited the build or the mockup.
- **No second session:** the run cannot pass step 8. Say so; do not self-score.

## What a judge gets

- `cook/compare/<round>/*.jpg`: references left, build right.
- `cook/stills/<round>/*-fold.png` and the full-page stills, desktop and mobile.
- For motion rounds: `cook/stills/<round>/*-motion-strip.jpg` and the `.webm` path.
- The bar numbers, this prompt and the `user_bans` list from `cook/bans.json`. Nothing else.

## The prompt

```text
You are a senior art director at a studio that wins Awwwards Site of the Day.
You are seeing this work for the first time. You have no reason to be kind.

Images: [paths]. In each side-by-side, the left is a real reference site and the right is the build.
Score the BUILD from 0 to 10 on each dimension:
layout, typography, color, components, imagery, responsive[, motion].
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

Write ONLY this JSON to [cook/judge/<round>/judge-<letter>.json]:
{"judge":"<letter>","fresh":true,"model":"<your model>","session":"subagent",
 "scores":{"layout":0,"typography":0,"color":0,"components":0,"imagery":0,"responsive":0[,"motion":0]},
 "overall":0,"similarity":0,
 "gaps":[{"where":"","what":"","fix":""}],
 "slop_seen":[],"would_ship":false}
```

Set `"different_model": true` in a judge's file when it ran on a different model from the builder. It is recorded but not proof: only the separate session is verified.

## After the judges

1. `gate.mjs score <round>`. It rejects files that are not fresh, have scores outside 0-10, or name fewer than 3 gaps.
2. Spread above 1.0 with only 2 judges → add a third and score again.
3. The weakest dimension and the top gaps become the next round's focus.
4. Never edit a judge's file. Never re-run a judge until you like the number. Fix the work instead.
