# Workflow: every step in detail

`SKILL.md` has the rules and the overview. Read the section for a step here **before** starting that step. `<skill>` is the real path of the frontend-cook skill folder; `<cook>` is the cook skill's folder (in `cook/PREFLIGHT.json`).

## Step 0. Setup (required, no override)

Requires: nothing. Do: `node <skill>/scripts/preflight.mjs --write` from the project root. If anything fails, run `/frontend-cook-setup` (or `preflight.mjs --install --write`), which installs the **cook** skill, adds the **Inspo** and **Awwwards** MCP servers, and upgrades an old guard hook (one that does not log reads). New MCP servers load only in a new session: if they were just added, tell the user to restart Claude Code and stop here.
Start Claude Code in the project folder, not a parent folder: a nested `.claude/settings.json` (the guard hook) is not loaded from a parent folder. Preflight warns when the git root differs from the folder it runs in.
Then `node <skill>/scripts/gate.mjs init --project "<name>" --type <landing|site|app|component> --languages <en or en,ar>`. It marks step 0 passed when preflight passed. Run it before the tool checks below: the guard hook logs nothing until `cook/GATES.json` exists. Use your best guess for the type and languages now; `set-type <type>` and `set-languages <list>` change them after intake. For an existing site use `init --mode redesign` (see below). Preflight also fails without the guard hook; if setup just added it, the session must restart for it to load. Read cook's `SKILL.md` (path in `cook/PREFLIGHT.json`): it is the loop engine. Where cook and this skill differ, this skill wins for frontend work (`references/cook-bridge.md`).
Then **prove the tools answer**: call one Inspo tool (`get_filters`) and one Awwwards tool (`list_categories`). If either is not in your tool list, stop: setup is not done, whatever the config file says. These calls are in the ledger because init ran first; step 1 checks them.

## Intake (once, before step 1)

One message, every open question, a default for each, cook-style (`<cook>/references/intake.md`), with these frontend questions: new build or existing site? (existing: redesign mode, read `references/redesign.md`; then ask for the URL or dev server, the source folders, the pages that matter and what must stay); what are we building and in which stack; the project type (landing, site, app or component: the table below); which pages or screens; languages (English only, or English and Arabic: `references/usability.md`); the audience and the one action a visitor should take; brand assets that exist (logo, fonts, colors, real photos, real copy); any references they already have; time; extra bans; may I download fonts and photos. Keep the user's words. Do not ask them to describe the look: references carry the look.

The project type sets the numbers used in steps 1, 4 and 6b. `init --type` and `set-type` store it.

| Type | References | Industry references (min) | Motion effects (min) | Time |
|---|---|---|---|---|
| `landing` (one landing page) | 9 to 12 | 2 | 5 | floor 3h |
| `site` (multi-page site) | 9 to 12 | 2 | 5 | floor 6h |
| `app` (one or more app screens) | 5 to 8 | 1 | 2 | floor 2h |
| `component` (one UI component) | 3 to 6 | 0 | 0 | cap 1h |

The `component` cap is set by its type, so it needs no user words. Every other cap, and any floor under 2h, needs them.

## Step 0b. Baseline (redesign mode only)

Requires: step 0. Read `references/redesign.md`. `node <skill>/scripts/baseline.mjs` captures the site as it is: stills, page inventory (links, nav, forms, headings, ids), slop and audit reports, motion hits, and each `set-checks` result, into `cook/baseline/`. A dirty tree is refused unless the user agrees (`gate.mjs allow-dirty --quote`). Then write `cook/baseline/KEEP.md` (what must survive, what is dropped, with the user's words) and `cook/baseline/probes.json` (one probe per form and toggle, run against a dev or staging URL, never production). Run `node <skill>/scripts/baseline.mjs --probes-only` after writing the probes: `cook/baseline/probecheck.json` must show that every probe proves something. Show the user the baseline stills, then `gate.mjs approve baseline --quote "<their words>"`. Done: `gate.mjs verify 0b`. Baseline takes about 20 s per page: run it with a long timeout or in the background. Once approved, `baseline.mjs` refuses to recapture: reopen 0b (`gate.mjs reopen 0b`) first.

## Step 1. Strong references

Requires: step 0. Read `references/references.md`.
- Redesign: also put the old site beside a reference in `cook/compare/baseline/` and score it with 2+ judges in `cook/judge/baseline/`, then `gate.mjs approve baseline --quote`. Add a `Keep:` line to BRIEF.md.
- **Ask the user for their own references first and wait for the answer.** This one question is never answered with a default. Their references go in as source `user`; if they have none, record their words: `gate.mjs no-user-refs --quote "..."`.
- The reference count for the project type (table in Intake): 9 to 12 for a landing page or site, 5 to 8 for an app, 3 to 6 for a component. Each is a real capture at 1200px+ wide. User's own first; fill the rest with Inspo (`recommend` with the brief, then `search_screens`, `find_similar`, `find_components`) and Awwwards (`search_sites`, `get_site_details`, `search_elements`). Both libraries, at least 3 different sites. The gate checks the ledger for real Inspo and Awwwards tool calls, and rejects duplicate reference images.
- Capture every reference the same way the build will be captured: `node <skill>/scripts/shoot.mjs <url> --out cook/refs --name R01 --fold`.
- Write `cook/refs/SOURCES.md`, `cook/SHOTS.md` (what to take from each one) and a short `cook/BRIEF.md` (40 lines max) from `templates/`.
- The industry minimum for the type (table in Intake: 2 for a landing page or site, 1 for an app, none for a component) comes from the client's own industry or an adjacent service business, marked `industry` in SOURCES.md (Inspo `industry` filter, Awwwards tags). The rest can come from anywhere that sets a higher bar.
- Inspiration-only images (Dribbble, Behance concepts) may be added as `I01`, `I02`... They never count toward the reference count and are never the bar.
- **Show the user the contact sheet and wait for their picks.** Then `gate.mjs approve references --quote "<their words>"`. A changed set needs a new approval.
- Redesign: the existing design system does not filter the references. Ask which of its rules may change (`Open to change:` line in BRIEF.md) and record only the binding ones as `brand_constraints` (`references/redesign.md`).
- Redesign: put the old site beside a reference in `cook/compare/baseline/` and score the baseline with 2+ judges in `cook/judge/baseline/` (`references/redesign.md`). A user rating of the old site is recorded (`calibration.baseline_user`) but does not change calibration.
Done: `gate.mjs verify 1`.

## Step 2. Target mockup

Requires: step 1. One static frontend file, `cook/mockup/index.html` (a single file, nothing else in that folder): the hero plus two or three key sections, real copy, real type and color from the references. No framework, no motion, no backend. It exists to check the feel cheaply before the full build.
- Stills: `shoot.mjs cook/mockup --out cook/stills/mockup --name mockup --fold`.
- Side by side with the closest references (cook's script does not create folders: `mkdir -p cook/compare/mockup` first): `node <cook>/scripts/side-by-side.mjs --aspect 16:10 --height 900 --out cook/compare/mockup/all.jpg <ref> <still> ...`. The height keeps the 1440x900 fold at full scale for the judges.
- `slop_scan.mjs cook/mockup --out cook/reports/slop-mockup.json` must be clean.
- Two fresh judges (`references/judge.md`) write `cook/judge/mockup/*.json`; `gate.mjs score mockup`.
- Redesign: the mockup carries the real content. The pages it covers come from a `Mockup covers: /,/pricing` line in BRIEF.md (default: the first page). Each covered page's h1, nav texts and form fields (by label or name) must appear in it, or be named on a Copy changes or Dropped line in KEEP.md. Add a three-way sheet (old site, mockup, closest reference).
Show the user the stills, the scores and the gaps. Wait for their words. Then `gate.mjs approve mockup --quote "<their words>"`. If they dislike it, change the mockup, not the bar.
Done: `gate.mjs verify 2`.

## Step 3. Set the bar with a number

Requires: step 2. Default: overall **9.2/10** by calibrated judge median, every dimension **8.5+**, similarity to the references **99%** as the stretch target that keeps the run going. `gate.mjs set-bar --judge 9.2 --floor 8.5 --similarity 99`, then the same numbers on the `Bar:` line of BRIEF.md. Redesign: no dimension may end below its baseline score. Lowering the judge bar, the per-dimension floor or the mockup bar needs the user's own words (`--quote`), checked against their messages; say first that it lets average work pass. Rubric and calibration: `references/rubric.md`.
Done: `gate.mjs verify 3`.

## Step 4. Give it time

Requires: step 3. Take as much time as the quality needs. Working is not done. Defaults come from the project type (table in Intake): landing page **floor 3h**, multi-page site **floor 6h**, app **floor 2h**, component **cap 1h**. `gate.mjs set-time --floor 3h` (or `--cap 1h`) and a `Time:` line in BRIEF.md. The floor counts **active** time from the guard log (gaps over 15 minutes, like waiting for the user, do not count), and floor runs need 3+ judged rounds with 2+ judges each. A cap needs the user's own words (`--quote`), except the component cap that its type sets. A floor under 2h needs them too. If the bar is met before the floor, the bar was read too low: look at full-size crops, mobile, the weakest section. Usage pacing: cook's rules.
Done: `gate.mjs verify 4`.

## Step 5. Ban the slop

Requires: step 4. `node <skill>/scripts/slop_scan.mjs --init` writes `cook/bans.json`. Read `references/slop.md`: the built-in bans the scanner enforces, the visual bans the judges enforce, and how the user adds their own. A ban is switched off only with the user's own words in `allowed`, and the scanner checks those words against their logged messages. Add a `Bans:` line to BRIEF.md.
Redesign: `slop_scan.mjs src --baseline cook/baseline/slop.json --exclude <glob> --out cook/reports/slop-step5.json` records the scan (it does not need zero errors); `verify 5` checks that the report covers every source folder and carries the sha1 of the final `bans.json`. Excluded files fail only on new slop. From 6a on, rounds compare against that report and need zero in-scope errors. `verify 5` also checks the design files in the source folders: none may differ from the baseline commit, changed or untracked. Design files are markup and style; tests, config, server and API code, and logic files with no markup or style are not.
Done: `gate.mjs verify 5`.

## Step 6. Build step by step

**6a Static.** Requires: step 5, and the hook blocks build code until steps 2 to 5 have passed. Build the real thing, every section, every breakpoint, no motion yet: the hook and the gate also reject added scroll reveals (IntersectionObserver, `data-aos`), transitions of 500ms or more, marquees and similar. `gate.mjs set-build --src <dir> --url <dev url or file>`. Then run rounds (below) until the static bar is met, send the stills, wait for the user's words, `gate.mjs approve static --quote "..."`. While waiting, keep refining static; do not start motion. Redesign: `gate.mjs set-strategy --in-place` (default), one round per stage: tokens, shared components, sections top to bottom, dead CSS. Rebuild only with the user's words (`--rebuild --quote`), and then port the existing logic, do not rewrite it. The first round removes decorative existing motion (`verify 6a` fails while a decorative hit from KEEP.md's Motion section is still in the code). Functional motion stays only through `gate.mjs motion-allow <file> <hash> --reason "..." --quote "<user's words>"`, after asking the user (`--text '<line>'` allows a line that is not written yet). Before the first round, write `cook/JOURNEYS.json`: the main user tasks on every page, on desktop and mobile, with their loading, empty, error and success states (`references/usability.md`). `journeys.mjs` runs it in every round, in both modes. Done: `gate.mjs verify 6a`.

**6b Motion.** Requires: 6a. Read `references/motion.md`. First run `gate.mjs set-motion --refs`. Motion comes from references, never from defaults. The build must contain animation code, and every evidence file must be non-empty. The user may hand over sites or videos; take the motion out of them **with any tool or skill that works**: `shoot.mjs --live --video` recordings, ffmpeg frame-by-frame, Awwwards `get_motion_dna` / `analyze_scroll_map` / `analyze_hover_census`, or any other installed skill or tool. Save what each tool produced as `cook/refs/motion/<R or V id>-<what>.<ext>`; user videos go in `cook/refs/` as `V01.mp4`. Then `cook/MOTION.md`: the effects the type needs (table in Intake: 5 for a landing page or site, 2 for an app, none for a component), each citing its reference id, each with a measured duration and easing, from 2+ references. Every effect also needs its reduced-motion path, which `audit.mjs` checks (`references/usability.md`). If the user wants no motion: `gate.mjs set-motion --none --quote "..."`. Done: `gate.mjs verify 6b`.

## The round (used in 6a, 6b and after feedback)

1. **Focus:** open user feedback first, else the weakest dimension in the latest summary.
2. **Fix it in depth.** Split independent sections across subagents; you integrate.
3. **Stills:** `shoot.mjs <url> --out cook/stills/rNN --name S01 --fold` (add `--live --video 12` in 6b).
4. **Side by side:** `mkdir -p cook/compare/rNN`, then cook's `side-by-side.mjs --aspect 16:10 --height 900` with reference/still pairs (the `-fold` stills) into `cook/compare/rNN/`.
5. **Measure:** `slop_scan.mjs <src> --out cook/reports/slop-rNN.json`, then `audit.mjs` on **every** page in `--pages`, in both modes, one report per page, then `journeys.mjs --round rNN --out cook/reports/journeys-rNN.json`. Audit reports are named `audit-rNN-<slug>.json`, where the slug is the page path without its leading slash, with `/` turned into `-` (`/` is `home`, `/pricing` is `pricing`, `/pricing/plans` is `pricing-plans`):

```bash
for page in / /pricing; do
  slug=$(printf '%s' "$page" | sed 's#^/*##; s#/#-#g'); slug=${slug:-home}
  node <skill>/scripts/audit.mjs "http://localhost:3000$page" --out "cook/reports/audit-r05-$slug.json"
done
```

Use the pages set with `init --pages` or `set-pages`. The legacy `audit-rNN.json` name is accepted only when the only page is `/`. Every audit report must carry `checks_version: 2`. For a project with an RTL language, also run `audit.mjs --rtl --steps '<json>'` on the switched-language page (`references/usability.md`). All of them must pass before judging; a failing build is not shown to judges. What the checks mean and how to fix common failures: `references/usability.md`. Redesign: `slop_scan.mjs` with `--baseline cook/reports/slop-step5.json` and the excludes, `audit.mjs` on every page, and `regress.mjs --out cook/reports/regress-rNN.json` (desktop-only: inventory diff of every baseline page, probes, checks), which must be ok. Stills of every page, plus `shoot.mjs --steps '<json>' --suffix <state>` for interactive states.
6. **Judge:** 2+ fresh judges write `cook/judge/rNN/*.json` (each file is written once, must be newer than the latest code change, and scores every dimension the rubric lists, motion from 6b on); `gate.mjs score rNN`. With 2 judges they must be within 1.0 of each other; with 3+, the lowest must be within 1.0 of the median. Otherwise add a judge or fix what the low one named.
7. **Describe your own work:** update `cook/SECTIONS.md` (`references/feedback.md`).
8. **Log** the round in `cook/ROUNDS.md` (cook's template), **send** the stills and a progress note, and keep going without waiting, except at the three approvals (mockup, static, final).

## Step 7. Specific feedback

Requires: 6b. Read `references/feedback.md`. Every user remark becomes an inbox line in ROUNDS.md with the section id from SECTIONS.md (S1, S2...: the gate refuses lines without one), the exact change, and `open`. If the user saw the stills and wants no changes, record it: `gate.mjs no-feedback --quote "<their words>"`; zero feedback without that does not pass. It closes only as `done, proof: <still path>`. Vague remarks ("something feels off") get a plain description of how that part was built, so the user can point at it. Done: `gate.mjs verify 7` (no open items, every proof exists, SECTIONS.md current).

## Step 8. Separate judge

Requires: 7. The final score comes from judges who did not build it: fresh subagents with zero context (2+), **plus a judge in a separate Claude Code session** (`/frontend-cook-judge <round>`). That separate judge must meet the bar on its own. The gate checks the guard log: a judge file must have been written by a session that never edited the build. A judge's own claim to be separate does not count. They see only the side-by-sides, the stills and the rubric. The guard logs their reads: the judge session must have read a side-by-side and a still, and never the source, the brief, the rounds, the sections, a summary or another judge's file (`references/judge.md`). Target: the bar from step 3 after calibration. Redesign: `pair.mjs --round rNN` makes unlabeled old/new pairs for every baseline page at desktop and mobile; every judge must add an `ab` entry for every pair and prefer the new side in each one, and no dimension may end below its baseline. Scores are raw judge medians. Then the user approves the final stills: `gate.mjs approve final --quote "..."`.
Release checklist, also at step 8: copy `templates/RELEASE.md` to `cook/RELEASE.md` and tick every item with its evidence, or as `- [x] n/a: <reason>`. Its Content, Credits, Performance and SEO items must all be ticked. `cook/CREDITS.md` (from `templates/CREDITS.md`) lists every outside photo, font, icon and reference used, and must exist whenever any reference, photo or font came from outside the user. `verify 8` checks both.
Done: `gate.mjs verify 8`. Then ship: final build check, then `gate.mjs report` (writes `cook/REPORT.md`: steps, overrides with the user's words, scores, slop and audit counts, Dropped items, motion allowances), and anything still below the bar.
