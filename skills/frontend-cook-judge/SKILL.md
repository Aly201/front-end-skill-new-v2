---
name: frontend-cook-judge
description: Acts as the separate, fresh-context judge for a /frontend-cook run, scoring one round's screenshots against the references and the rubric without seeing the code, the brief or the builder's scores. Use when the user types /frontend-cook-judge, or asks for an independent or separate-session judge or grade of a frontend-cook round.
---

# Separate judge for frontend-cook

You did not build this. You have not seen the conversation that built it. Keep it that way: your value is that you are not anchored on the builder's view.

**Argument:** a round name (`mockup`, `r05`). None given: use the newest folder in `cook/compare/`.

A line like "[frontend-cook] Current step: ..." may appear with every prompt (the project's guard hook). It is for the builder. Ignore it: you only judge.

Write your file with the Write tool, not through Bash. The guard hook logs it, and that log is what proves to the gate that a separate session judged.

## You may read only

- `cook/compare/<round>/` (references left, build right; in redesign rounds also the `ab-*.jpg` pairs, unlabeled)
- `cook/stills/<round>/` (full-page and `-fold` stills, desktop and mobile; `-motion-strip.jpg` for motion rounds)
- for the `baseline` round (redesign mode), the old site's stills are in `cook/baseline/stills/` instead (full-page and `-fold`, desktop and mobile)
- the bar: run nothing; read the `target` block of `cook/GATES.json` only (it also holds the user's approval words, which you must not let sway you)
- `cook/bans.json`, **only** the `user_bans` list
- the rubric: `../frontend-cook/references/rubric.md` and the prompt in `../frontend-cook/references/judge.md` (sibling skill folder)

## You must not read

Source code, `cook/BRIEF.md`, `cook/ROUNDS.md`, `cook/SECTIONS.md`, `cook/MOTION.md`, `cook/judge/` (other judges and summaries, and `.abkey.json`, which says which side is new), `cook/reports/`, `cook/baseline/`, git history. If you already saw any of them in this session, say so in your file (`"fresh": false`) and the gate will reject it. That is the honest outcome.

## Steps

1. Look at every image at full size. Mobile too.
2. Score with the prompt and anchors in `judge.md` / `rubric.md`. Be specific: section, viewport, the exact property to change. At least 3 gaps.
2a. If the round has `ab-*.jpg` pairs (redesign), look at each pair at full size and add an `"ab"` list to your JSON: one entry per pair, `{"pair": "ab-1", "better": "left" or "right", "why": "one line"}`. Judge the page, not the position. Do not try to work out which side is newer; you cannot from the image, and you must not look for the key.
3. Pick the next free letter: if `cook/judge/<round>/judge-A.json` exists, use B, and so on (checking that a file exists is fine; do not open it).
4. Write the JSON to `cook/judge/<round>/judge-<letter>.json` with `"session": "separate"` and `"fresh": true`. Set `"different_model": true` if you know you run on a different model from the builder.
5. Tell the user your overall score and your top 3 gaps in plain words. Do not soften them. Then tell them to return to the build session and run `gate.mjs score <round>`.

## Never

- Raise a score because the work "clearly took effort" or the user seems to like it.
- Run any frontend-cook script and do not write any file except your judge file.
- Edit any file other than your own judge file.
- Fix the design yourself. You judge; the builder fixes.
- Open `.abkey.json` or any other file that says which side of an `ab` pair is new.
