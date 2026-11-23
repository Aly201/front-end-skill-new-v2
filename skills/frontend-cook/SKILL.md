---
name: frontend-cook
description: Opt-in workflow for flagship landing pages and major redesigns that must reach award level without AI slop. Gated steps (references from Inspo and Awwwards, a judged mockup, a numeric bar, time, bans, static then motion, feedback, a separate-session judge) with browser, usability and regression checks. Long and costly; for routine UI work use a lighter skill. Run it only when the user types /frontend-cook.
disable-model-invocation: true
---

# frontend-cook

An opt-in design workflow for flagship landing pages, multi-page sites and major redesigns. It does not accept "looks good" from anyone, including the user and itself: every step has requirements a script checks before it starts and proof a script checks before it counts as done. A claim with no file behind it does not count. It is slow by design (judged rounds, hours of active time); for routine UI changes, a lighter workflow is the right tool.

## The gate

`<skill>` is the real path of this skill folder. All state lives in `cook/` at the project root (git-ignored; it holds the user's logged prompts).

- **Before every step:** read that step's section in `references/workflow.md`, then `node <skill>/scripts/gate.mjs check <step>`. Exit 0 or do not start; tell the user the FAIL lines in plain words.
- **After every step:** `node <skill>/scripts/gate.mjs verify <step>`. Exit 0 or the step is not done. Never write "done" before this passes.
- **Lost?** `node <skill>/scripts/gate.mjs next` prints the next step, what to read and what is still missing. Run it after every action.
- **The user's words** come from their own messages (Claude Code logs them) or from `gate.mjs say` / `gate.mjs approve <kind>`, which the user runs in their own terminal. You never type them. Outside Claude Code, read `references/portable.md`.
- After a context compaction: `gate.mjs status`, then `cook/BRIEF.md`, `cook/SHOTS.md` and the last two entries of `cook/ROUNDS.md`. Do not restart work that passed.
- **The guard hook** (installed by setup) blocks design code before the mockup and the design rules pass, added motion before the static design passes, hand edits to script-written files, and agent-browser. It logs every tool call, every read and every user prompt to `cook/.ledger.jsonl`, which is how the gate checks the user's words, judge independence and active time. A block means a step is not done: do not work around it.

## Do not agree. Verify.

Read `references/pushback.md` once per run. In short:
1. **Nothing is good because someone said so.** Not you, not a subagent, not the user. A score comes from fresh judges plus measured checks (`slop_scan.mjs`, `audit.mjs`).
2. **When a request would make the work worse** (fewer references, skip the mockup, a lower bar, a banned pattern, "just ship it"), say what it costs in one or two concrete lines, name the better option, then let the user decide. If they insist, record it with their exact words: `gate.mjs override <step> --quote "..." --reason "..."`. It stays in the final report.
   The words must appear in a message the user actually typed in this project. The guard hook logs every prompt to `cook/.ledger.jsonl` and the gate checks the quote against that log. Approvals, overrides, a lower bar or time floor, "no motion", "no feedback", calibration and switched-off bans all need this. An approval expires when the stills change after it.
3. **The user's estimate only ever lowers scores.** "You're at 6/10" → `gate.mjs calibrate --user 6 --quote "<their words, with the 6>"`, every later score drops. The offset is re-based on each newer round they rate, and never goes above the judges. "Looks perfect!" → thank them, still run the judges. The gate refuses to raise scores.
4. **Never report a check you did not run** or a number no command produced. Write "not measured".
5. **Push back on yourself.** If the first version "works", that is the start of round 1, not the end.

## Steps

Read the step's section in `references/workflow.md` before each one.

| Step | What | Done when (`gate.mjs verify`) |
|---|---|---|
| 0 Setup | `preflight.mjs --write` (or `/frontend-cook-setup`), then `gate.mjs init --project <name> --type <landing/site/app/component> --languages <en or en,ar>` (`--mode redesign` for an existing site), then call one Inspo and one Awwwards tool. | preflight passed, no override |
| Intake | One message, every question with a default, except the user's own references: ask and wait. | |
| 0b Baseline (redesign) | `baseline.mjs`, KEEP.md, probes that prove something, the user's approval (`references/redesign.md`). | baseline captured and approved |
| 1 References | The user's references first; the rest from Inspo and Awwwards; the count, industry minimum and inspiration-only rules for the type; the user picks the set (`references/references.md`). | references approved by the user |
| 2 Mockup | One static file, judged by 2+ fresh judges, approved by the user. | mockup at its bar, approved |
| 3 Bar | 9.2 overall, 8.5 per dimension by default (`references/rubric.md`). | bar recorded |
| 4 Time | Floor or cap from the project type; caps and short floors need the user's words. | time recorded |
| 5 Bans | `slop_scan.mjs --init`, the user's bans (`references/slop.md`). | bans recorded |
| 6a Static | The real build without motion, in rounds; `JOURNEYS.json`; the user approves (`references/usability.md`). | rounds pass at the bar, approved |
| 6b Motion | Motion taken from references with any tool, with reduced-motion paths (`references/motion.md`). | motion rounds pass |
| 7 Feedback | Every remark pinned to a section, closed with proof (`references/feedback.md`). | no open feedback |
| 8 Judge | Fresh judges plus a separate judge: a second session (`/frontend-cook-judge`) or `judge.mjs` (`references/judge.md`), the release checklist, the user's final approval, `gate.mjs report`. | final bar met, checklist ticked, approved |

**The round** (6a, 6b, after feedback): fix the weakest thing in depth, take stills, side-by-sides, `slop_scan.mjs`, `audit.mjs` on every page, `journeys.mjs` (and `regress.mjs` in redesign mode), 2+ fresh judges, update SECTIONS.md and ROUNDS.md, send the stills. Full commands: `references/workflow.md`, "The round".

## Never

- Start a step whose `check` fails, or call a step done before its `verify` passes.
- Record an approval, an override or a "no motion" without the user's own words.
- Show the judges your own score, the brief, the code, or who built it.
- Raise a score because the user liked it, or lower the bar to finish.
- Copy one reference 1:1, or publish third-party references.
- Use agent-browser. The hook blocks it. Use `shoot.mjs` / `audit.mjs` (Playwright), or the browser tools the session already has.

## Files

| File | Read when |
|---|---|
| `references/workflow.md` | Before every step: the full instructions and commands for each step and the round. |
| `references/pushback.md` | Once per run, and whenever the user asks for something that lowers quality. |
| `references/redesign.md` | Existing site (redesign mode): step 0b, the keep list, in-place strategy, regression and old-vs-new checks. |
| `references/cook-bridge.md` | Step 0: which cook files to read, and where this skill overrides cook. |
| `references/references.md` | Step 1. |
| `references/rubric.md` | Steps 2, 3 and every scoring. |
| `references/judge.md` | Every time judges run: what each judge may read, the prompt, the read checks. |
| `references/portable.md` | Outside Claude Code (Codex, Cursor, Antigravity), or whenever the user's words or a separate judge are needed without the hook. |
| `references/usability.md` | Step 6a and every round: audit checks (keyboard, focus, labels, reduced motion, SEO, performance), `JOURNEYS.json`, RTL projects. |
| `references/slop.md` | Step 5, and before any visible change. |
| `references/motion.md` | Step 6b. |
| `references/feedback.md` | Step 7, and whenever the user gives feedback. |
| `templates/` | BRIEF, SOURCES, SHOTS, SECTIONS, MOTION, RELEASE, CREDITS, judge JSON, KEEP.md and probes (redesign). |
| `scripts/gate.mjs` | Before and after every step; `report` for the final report. |
| `scripts/preflight.mjs` | Step 0. |
| `scripts/judge.mjs` | Any round: a script judge that sends only the images and the rubric to the Claude API. |
| `scripts/shoot.mjs` | Every capture: references, mockup, rounds. |
| `scripts/slop_scan.mjs` | Step 5 and every round. |
| `scripts/baseline.mjs` | Step 0b (redesign); `--probes-only` after writing the probes. |
| `scripts/regress.mjs` | Every round (redesign): inventory diff, probes, checks. |
| `scripts/pair.mjs` | Step 8 (redesign): unlabeled old/new pairs. |
| `scripts/audit.mjs` | Every round, on every page (`audit-rNN-<slug>.json`). |
| `scripts/journeys.mjs` | Every round, both modes: `cook/JOURNEYS.json` on desktop and mobile. |
