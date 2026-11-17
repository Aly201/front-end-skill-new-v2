---
name: frontend-cook
description: Builds websites, landing pages and app screens that hold up next to award-level references, through an 8-step gated workflow of 9 to 12 strong references from the Inspo and Awwwards MCPs, a target mockup, a numeric bar, a time floor, a slop ban list, static build then motion, specific feedback, and a separate judge. Every step's requirements are checked by a script before it starts, and its proof is checked before it counts as done. Requires the cook skill and the Inspo and Awwwards MCP servers; installs them through /frontend-cook-setup. Also takes an existing site to 9/10 without breaking what works (redesign mode, with a baseline, a keep list and regression checks). Use when the user types /frontend-cook, asks for a frontend, website, landing page, UI or redesign that must look high-end, says "no AI-looking design", "match these references", "make it award-level", "9.2/10", or attaches reference screenshots for a UI build.
---

# frontend-cook

A frontend design loop that does not accept "looks good" from anyone, including the user and itself. Each of the 8 steps (and 0b in redesign mode) has requirements that a script checks before the step starts, and proof that a script checks before it counts as done. A claim with no file behind it does not count.

## Before anything: the gate

`<skill>` below means the real path of this skill folder. All state lives in `cook/` at the project root (shared with the cook skill, so cook's resume logic works).

- **Before every step:** `node <skill>/scripts/gate.mjs check <step>`. Exit 0 or do not start. Show the user the FAIL lines in plain words.
- **After every step:** `node <skill>/scripts/gate.mjs verify <step>`. Exit 0 or the step is not done. Fix what failed and run it again. Never write "done" before this passes.
- `gate.mjs status` says where the run is and what is next. Run it after every context compaction, then read `cook/BRIEF.md`, `cook/SHOTS.md` and the last two entries of `cook/ROUNDS.md`, and continue. Do not restart work that passed.
- Steps: `0` setup, `0b` baseline (redesign only), `1` references, `2` mockup, `3` bar, `4` time, `5` bans, `6a` static, `6b` motion, `7` feedback, `8` judge.
- **The guard hook** (installed by setup into `.claude/settings.json`) enforces this even if you forget: until steps 2 to 5 passed (mockup, bar, time, bans) it blocks design code in the source folders (not tests, config, server or API code); it blocks **added** motion code (scroll reveals, long transitions, marquees) until the static design passed, so existing animation can stay, and functional animation can be allowed with the user's words (`motion-allow`). Test files are not checked for motion, and `animation: none` resets are not motion. It also blocks hand edits to `GATES.json`, `PREFLIGHT.json`, judge summaries, reports, the baseline files and the judge key, writes a second copy of a judge file, and blocks `agent-browser` outright. It logs every tool call and every user prompt to `cook/.ledger.jsonl`. That log is how the gate checks the user's words, proves the judge was a separate session and counts step 4's active time. Do not work around a block (for example by writing files through Bash): it means a step is not done.

## Do not agree. Verify.

Read `references/pushback.md` once per run. In short:
1. **Nothing is good because someone said so.** Not you, not a subagent, not the user. A score comes from fresh judges plus measured checks (`slop_scan.mjs`, `audit.mjs`).
2. **When a request would make the work worse** (fewer references, skip the mockup, a lower bar, a banned pattern, "just ship it"), say what it costs in one or two concrete lines, name the better option, then let the user decide. If they insist, record it with their exact words: `gate.mjs override <step> --quote "..." --reason "..."`. It stays in the final report.
   The words must appear in a message the user actually typed in this project. The guard hook logs every prompt to `cook/.ledger.jsonl` and the gate checks the quote against that log. Approvals, overrides, a lower bar or time floor, "no motion", "no feedback", calibration and switched-off bans all need this. An approval expires when the stills change after it.
3. **The user's estimate only ever lowers scores.** "You're at 6/10" → `gate.mjs calibrate --user 6 --quote "<their words, with the 6>"`, every later score drops. The offset is re-based on each newer round they rate, and never goes above the judges. "Looks perfect!" → thank them, still run the judges. The gate refuses to raise scores.
4. **Never report a check you did not run** or a number no command produced. Write "not measured".
5. **Push back on yourself.** If the first version "works", that is the start of round 1, not the end.

## Step 0. Setup (required, no override)

Requires: nothing. Do: `node <skill>/scripts/preflight.mjs --write` from the project root. If anything fails, run `/frontend-cook-setup` (or `preflight.mjs --install --write`), which installs the **cook** skill and adds the **Inspo** and **Awwwards** MCP servers. New MCP servers load only in a new session: if they were just added, tell the user to restart Claude Code and stop here.
Then **prove the tools answer**: call one Inspo tool (`get_filters`) and one Awwwards tool (`list_categories`). If either is not in your tool list, stop: setup is not done, whatever the config file says. The ledger records these calls; step 1 checks them.
Start Claude Code in the project folder, not a parent folder: a nested `.claude/settings.json` (the guard hook) is not loaded from a parent folder. Preflight warns when the git root differs from the folder it runs in.
Then `gate.mjs init --project "<name>"` (marks step 0 passed when preflight passed). For an existing site use `init --mode redesign` (see below). Preflight also fails without the guard hook; if setup just added it, the session must restart for it to load. Read cook's `SKILL.md` (path in `cook/PREFLIGHT.json`): it is the loop engine. Where cook and this skill differ, this skill wins for frontend work (`references/cook-bridge.md`).

## Intake (once, before step 1)

One message, every open question, a default for each, cook-style (`<cook>/references/intake.md`), with these frontend questions: new build or existing site? (existing: redesign mode, read `references/redesign.md`; then ask for the URL or dev server, the source folders, the pages that matter and what must stay); what are we building and in which stack; which pages or screens; the audience and the one action a visitor should take; brand assets that exist (logo, fonts, colors, real photos, real copy); any references they already have; time; extra bans; may I download fonts and photos. Keep the user's words. Do not ask them to describe the look: references carry the look.

## Step 0b. Baseline (redesign mode only)

Requires: step 0. Read `references/redesign.md`. `node <skill>/scripts/baseline.mjs` captures the site as it is: stills, page inventory (links, nav, forms, headings, ids), slop and audit reports, motion hits, and each `set-checks` result, into `cook/baseline/`. A dirty tree is refused unless the user agrees (`gate.mjs allow-dirty --quote`). Then write `cook/baseline/KEEP.md` (what must survive, what is dropped, with the user's words) and `cook/baseline/probes.json` (one probe per form and toggle, run against a dev or staging URL, never production). Run `node <skill>/scripts/baseline.mjs --probes-only` after writing the probes: `cook/baseline/probecheck.json` must show that every probe proves something. Show the user the baseline stills, then `gate.mjs approve baseline --quote "<their words>"`. Done: `gate.mjs verify 0b`.

## Step 1. Strong references

Requires: step 0. Read `references/references.md`.
- Redesign: also put the old site beside a reference in `cook/compare/baseline/` and score it with 2+ judges in `cook/judge/baseline/`, then `gate.mjs approve baseline --quote`. Add a `Keep:` line to BRIEF.md.
- 9 to 12 references, each a real capture at 1200px+ wide. User's own first; fill the rest with Inspo (`recommend` with the brief, then `search_screens`, `find_similar`, `find_components`) and Awwwards (`search_sites`, `get_site_details`, `search_elements`). Both libraries, at least 3 different sites. The gate checks the ledger for real Inspo and Awwwards tool calls, and rejects duplicate reference images.
- Capture every reference the same way the build will be captured: `node <skill>/scripts/shoot.mjs <url> --out cook/refs --name R01 --fold`.
- Write `cook/refs/SOURCES.md`, `cook/SHOTS.md` (what to take from each one) and a short `cook/BRIEF.md` (40 lines max) from `templates/`.
- Send the user a contact sheet of the references and ask which to cut. Their picks beat yours.
- Redesign: put the old site beside a reference in `cook/compare/baseline/` and score the baseline with 2+ judges in `cook/judge/baseline/` (`references/redesign.md`).
Done: `gate.mjs verify 1`.

## Step 2. Target mockup

Requires: step 1. One static frontend file, `cook/mockup/index.html` (a single file, nothing else in that folder): the hero plus two or three key sections, real copy, real type and color from the references. No framework, no motion, no backend. It exists to check the feel cheaply before the full build.
- Stills: `shoot.mjs cook/mockup --out cook/stills/mockup --name mockup --fold`.
- Side by side with the closest references (cook's script does not create folders: `mkdir -p cook/compare/mockup` first): `node <cook>/scripts/side-by-side.mjs --aspect 16:10 --height 900 --out cook/compare/mockup/all.jpg <ref> <still> ...`. The height keeps the 1440x900 fold at full scale for the judges.
- `slop_scan.mjs cook/mockup --out cook/reports/slop-mockup.json` must be clean.
- Two fresh judges (`references/judge.md`) write `cook/judge/mockup/*.json`; `gate.mjs score mockup`.
- - Redesign: the mockup carries the real content. Every covered heading, nav label, form field and CTA from the baseline inventory appears in it, or is listed under Copy changes or Dropped. Add a three-way sheet (old site, mockup, closest reference).
Show the user the stills, the scores and the gaps. Wait for their words. Then `gate.mjs approve mockup --quote "<their words>"`. If they dislike it, change the mockup, not the bar.
Done: `gate.mjs verify 2`.

## Step 3. Set the bar with a number

Requires: step 2. Default: overall **9.2/10** by calibrated judge median, every dimension **8.5+**, similarity to the references **99%** as the stretch target that keeps the run going. `gate.mjs set-bar --judge 9.2 --floor 8.5 --similarity 99`, then the same numbers on the `Bar:` line of BRIEF.md. Redesign: no dimension may end below its baseline score. Lowering the judge bar, the per-dimension floor or the mockup bar needs the user's own words (`--quote`), checked against their messages; say first that it lets average work pass. Rubric and calibration: `references/rubric.md`.
Done: `gate.mjs verify 3`.

## Step 4. Give it time

Requires: step 3. Take as much time as the quality needs. Working is not done. Defaults: landing page **floor 3h**, multi-page site **floor 6h**, one app screen **floor 2h**, one component **cap 1h**. `gate.mjs set-time --floor 3h` and a `Time:` line in BRIEF.md. The floor counts **active** time from the guard log (gaps over 15 minutes, like waiting for the user, do not count), and floor runs need 3+ judged rounds with 2+ judges each. A cap, or a floor under 2h, needs the user's own words (`--quote`). If the bar is met before the floor, the bar was read too low: look at full-size crops, mobile, the weakest section. Usage pacing: cook's rules.
Done: `gate.mjs verify 4`.

## Step 5. Ban the slop

Requires: step 4. `node <skill>/scripts/slop_scan.mjs --init` writes `cook/bans.json`. Read `references/slop.md`: the built-in bans the scanner enforces, the visual bans the judges enforce, and how the user adds their own. A ban is switched off only with the user's own words in `allowed`, and the scanner checks those words against their logged messages. Add a `Bans:` line to BRIEF.md.
Redesign: `slop_scan.mjs src --baseline cook/baseline/slop.json --exclude <glob>`. Excluded files fail only on new slop. `verify 5` also checks the design files in the source folders: none may differ from the baseline commit, changed or untracked. Design files are markup and style; tests, config, server and API code, and logic files with no markup or style are not.
Done: `gate.mjs verify 5`.

## Step 6. Build step by step

**6a Static.** Requires: step 5, and the hook blocks build code until steps 2 to 5 have passed. Build the real thing, every section, every breakpoint, no motion yet: the hook and the gate also reject added scroll reveals (IntersectionObserver, `data-aos`), transitions of 500ms or more, marquees and similar. `gate.mjs set-build --src <dir> --url <dev url or file>`. Then run rounds (below) until the static bar is met, send the stills, wait for the user's words, `gate.mjs approve static --quote "..."`. While waiting, keep refining static; do not start motion. Redesign: `gate.mjs set-strategy --in-place` (default), one round per stage: tokens, shared components, sections top to bottom, dead CSS. Rebuild only with the user's words (`--rebuild --quote`), and then port the existing logic, do not rewrite it. The first round removes decorative existing motion (`verify 6a` fails while a decorative hit from KEEP.md's Motion section is still in the code). Functional motion stays only through `gate.mjs motion-allow <file> <hash> --reason "..." --quote "<user's words>"`, after asking the user (`--text '<line>'` allows a line that is not written yet). Done: `gate.mjs verify 6a`.

**6b Motion.** Requires: 6a. Read `references/motion.md`. First run `gate.mjs set-motion --refs`. Motion comes from references, never from defaults. The build must contain animation code, and every evidence file must be non-empty. The user may hand over sites or videos; take the motion out of them **with any tool or skill that works**: `shoot.mjs --live --video` recordings, ffmpeg frame-by-frame, Awwwards `get_motion_dna` / `analyze_scroll_map` / `analyze_hover_census`, or any other installed skill or tool. Save what each tool produced as `cook/refs/motion/<R or V id>-<what>.<ext>`; user videos go in `cook/refs/` as `V01.mp4`. Then `cook/MOTION.md`: 5+ effects, each citing its reference id, each with a measured duration and easing, from 2+ references. If the user wants no motion: `gate.mjs set-motion --none --quote "..."`. Done: `gate.mjs verify 6b`.

## The round (used in 6a, 6b and after feedback)

1. **Focus:** open user feedback first, else the weakest dimension in the latest summary.
2. **Fix it in depth.** Split independent sections across subagents; you integrate.
3. **Stills:** `shoot.mjs <url> --out cook/stills/rNN --name S01 --fold` (add `--live --video 12` in 6b).
4. **Side by side:** `mkdir -p cook/compare/rNN`, then cook's `side-by-side.mjs --aspect 16:10 --height 900` with reference/still pairs (the `-fold` stills) into `cook/compare/rNN/`.
5. **Measure:** `slop_scan.mjs <src> --out cook/reports/slop-rNN.json` and `audit.mjs <url> --out cook/reports/audit-rNN.json`. Both must pass before judging; a failing build is not shown to judges. Redesign: `audit.mjs` on every page, and `regress.mjs --out cook/reports/regress-rNN.json` (inventory diff, probes, checks), which must be ok. Stills of every page, plus `shoot.mjs --steps '<json>' --suffix <state>` for interactive states.
6. **Judge:** 2+ fresh judges write `cook/judge/rNN/*.json` (each file is written once, and must be newer than the latest code change); `gate.mjs score rNN`. With 2 judges they must be within 1.0 of each other; with 3+, the lowest must be within 1.0 of the median. Otherwise add a judge or fix what the low one named.
7. **Describe your own work:** update `cook/SECTIONS.md` (`references/feedback.md`).
8. **Log** the round in `cook/ROUNDS.md` (cook's template), **send** the stills and a progress note, and keep going without waiting, except at the three approvals (mockup, static, final).

## Step 7. Specific feedback

Requires: 6b. Read `references/feedback.md`. Every user remark becomes an inbox line in ROUNDS.md with the section id from SECTIONS.md (S1, S2...: the gate refuses lines without one), the exact change, and `open`. If the user saw the stills and wants no changes, record it: `gate.mjs no-feedback --quote "<their words>"`; zero feedback without that does not pass. It closes only as `done, proof: <still path>`. Vague remarks ("something feels off") get a plain description of how that part was built, so the user can point at it. Done: `gate.mjs verify 7` (no open items, every proof exists, SECTIONS.md current).

## Step 8. Separate judge

Requires: 7. The final score comes from judges who did not build it: fresh subagents with zero context (2+), **plus a judge in a separate Claude Code session** (`/frontend-cook-judge <round>`). That separate judge must meet the bar on its own. The gate checks the guard log: a judge file must have been written by a session that never edited the build. A judge's own claim to be separate does not count. They see only the side-by-sides, the stills and the rubric. Target: the bar from step 3 after calibration. Redesign: `pair.mjs --round rNN` makes unlabeled old/new pairs; every judge must add an `ab` entry for every pair and prefer the new side in each one, and no dimension may end below its baseline. Then the user approves the final stills: `gate.mjs approve final --quote "..."`.
Done: `gate.mjs verify 8`. Then ship: final build check, then `gate.mjs report` (writes `cook/REPORT.md`: steps, overrides with the user's words, scores, slop and audit counts, Dropped items, motion allowances), and anything still below the bar.

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
| `references/pushback.md` | Once per run, and whenever the user asks for something that lowers quality. |
| `references/redesign.md` | Existing site (redesign mode): step 0b, the keep list, in-place strategy, regression and old-vs-new checks. |
| `references/cook-bridge.md` | Step 0: which cook files to read, and where this skill overrides cook. |
| `references/references.md` | Step 1. |
| `references/rubric.md` | Steps 2, 3 and every scoring. |
| `references/judge.md` | Every time judges run. |
| `references/slop.md` | Step 5, and before any visible change. |
| `references/motion.md` | Step 6b. |
| `references/feedback.md` | Step 7, and whenever the user gives feedback. |
| `templates/` | BRIEF, SOURCES, SHOTS, SECTIONS, MOTION, judge JSON, KEEP.md and probes (redesign). |
| `scripts/gate.mjs` | Before and after every step; `report` for the final report. |
| `scripts/preflight.mjs` | Step 0. |
| `scripts/shoot.mjs` | Every capture: references, mockup, rounds. |
| `scripts/slop_scan.mjs` | Step 5 and every round. |
| `scripts/baseline.mjs` | Step 0b (redesign); `--probes-only` after writing the probes. |
| `scripts/regress.mjs` | Every round (redesign): inventory diff, probes, checks. |
| `scripts/pair.mjs` | Step 8 (redesign): unlabeled old/new pairs. |
| `scripts/audit.mjs` | Every round. |
