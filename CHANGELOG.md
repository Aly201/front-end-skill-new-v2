# Changelog

## 1.7.0
Every agent on every computer shares the same references and status:
- `cook/` is now committed with the project. Only the prompt log (`cook/.ledger.jsonl`), `cook/PREFLIGHT.json` and the new `cook/.checkout` stay local. `preflight.mjs --install` replaces the old whole-folder `cook/` ignore line; a committed prompt log fails setup.
- `cook/STATUS.md`, written after every change of state: step, bar, the user's decisions, the references (source, URL, what to take), judged rounds and what is still missing.
- `gate.mjs init` and the new `gate.mjs share` write a marked block into `AGENTS.md` (and `CLAUDE.md` when present) that sends every agent to `cook/STATUS.md` and `gate.mjs next`.
- `cook/FILES.json` keeps each file's real change time and content hash, so freshness checks and approvals survive a clone or pull. A file whose content changed uses its new time.
- Preflight warns when the GitHub repository is public (committing `cook/refs/` would publish other sites' screenshots).
- The guard protects `cook/STATUS.md`, `cook/FILES.json` and `cook/.checkout`, and allows `git add`, `commit`, `pull`, `push` and other read or sync commands that name files in `cook/`.

## 1.6.0
Works on any coding platform (Codex, Cursor, Antigravity, ...), and holds a weaker or forgetful agent to the steps:
- `gate.mjs say` and `gate.mjs approve <kind>` (without `--quote`): the user types their words in their own interactive terminal; they are recorded in the ledger as `UserTTY` and count wherever the user's words are needed. Both refuse to run without a terminal, so an agent cannot answer them.
- `scripts/judge.mjs`: a script judge. It sends only the round's side-by-sides, A/B pairs and fold stills, with the rubric, to the Claude API (structured JSON output, refusal fallback), and writes the judge file itself with the model, the API message id and each image's sha1. `gate.mjs score` and step 8 accept it as fresh and separate without a ledger, and reject it when an image changed, a hash is forged, an image is from outside the round, or the file was written with an agent's Write tool.
- `gate.mjs next`: the next step, the section of `workflow.md` to read, and up to 10 missing items in order, flagging those that need the user.
- `preflight.mjs --install` adds `@anthropic-ai/sdk` to `~/.frontend-cook` and warns (without failing) when no API credentials are set.
- The guard allows `node .../judge.mjs`.
- New `references/portable.md`: the three commands, what still needs Claude Code's hook, and a short brief for another agent.

## 1.5.1
From a second external review (Gemini and Codex), each claim reproduced before fixing:
- Opt-in: all three skills are manual-only (`disable-model-invocation: true`); run `/frontend-cook` for flagship landing pages and major redesigns, not routine UI work.
- `SKILL.md` cut from about 4,000 to about 1,300 words; the per-step instructions moved unchanged to `references/workflow.md`, read before each step.
- The guard no longer blocks the documented `journeys.mjs --out cook/reports/...` command.
- A journey needs at least one step and one expectation (a page opened straight in a right-to-left language may skip steps: the dir check is its assertion); every state needs an expectation. Enforced by `journeys.mjs` and the gate.
- Setup no longer counts MCP servers configured only for Codex (`~/.codex/config.toml`) as available to Claude Code; it says so and gives the command.
- Git protection is a failure, not a warning: the prompt log `cook/.ledger.jsonl` must be ignored and nothing under `cook/` may already be tracked (git keeps tracking committed files even when ignored).

## 1.5.0
Thanks to an external review by Gemini and Codex. The maintainer verified each finding before it was fixed here.

Upgrading a run in progress: run `/frontend-cook-setup` (or `preflight.mjs --install --write`) to upgrade the guard hook, which now logs reads, and restart Claude Code. Rerun every audit (reports must be version 2, `checks_version: 2`), name them per page as below, and add `cook/JOURNEYS.json` before the next round.

Fixes:
- Step 0: `gate.mjs init` now comes before the "prove the tools answer" calls, so the hook logs them. The docs said those calls were logged before init, which was wrong.
- Audit naming: every page gets its own report in both modes, `audit-rNN-<slug>.json` (`/` is `home`, `/pricing` is `pricing`). A new multi-page build was audited on its home page only before. The legacy `audit-rNN.json` is accepted only when the only page is `/`.
- Judge attribution: after `archive-judges`, a reused judge filename was attributed to its first writer. It now goes to the latest writer.
- Judges: `score` accepted judge files that left out dimensions. Every judge now scores every applicable dimension, and a file missing one is rejected.

New:
- Project types: `landing`, `site`, `app` and `component`, set with `init --type` or `set-type`. Each has its own reference count (9 to 12, 9 to 12, 5 to 8, 3 to 6), industry minimum (2, 2, 1, 0), motion effects (5, 5, 2, 0) and time floor or cap (3h, 6h, 2h, cap 1h). The component cap needs no user words.
- Languages: `init --languages en,ar` or `set-languages`. An RTL language requires an RTL journey that passes on both viewports, and `audit.mjs --rtl --steps` checks the switched page.
- Usability checks in `audit.mjs` (checks version 2): keyboard reachability, visible focus, form labels, reduced-motion rendering, and basic SEO and performance warnings (transfer above 3000 KB, LCP above 4000 ms).
- `cook/JOURNEYS.json` and `journeys.mjs`: the main tasks per page on desktop and mobile, with loading, empty, error and success states and mocks. Required from step 6a in both modes.
- Reads are logged: the guard matches Read, Glob and Grep (never blocked). The gate checks that each judge read the round's side-by-sides and stills, and never the source, `BRIEF.md`, `ROUNDS.md`, `SECTIONS.md`, the summary or another judge's file. A hook from before 1.5.0 fails step 8 with "judge reads not logged" until `preflight --install` updates it.
- Step 8 release checklist: `cook/RELEASE.md` (Content, Credits, Performance, SEO) and `cook/CREDITS.md` for every outside photo, font, icon and reference.
- `skills/frontend-cook/references/usability.md`: why visual judging is not enough, the checks and how to fix them, journeys, RTL and reduced motion.

## 1.4.0
From a test run on a real Next.js app (cleaning-services):
- Step 1 asks the user for their own references and waits: the gate refuses step 1 until they supplied references (source `user`) or their words saying they have none are recorded (`gate.mjs no-user-refs --quote`).
- The user picks the reference set from the contact sheet: `gate.mjs approve references --quote`, invalidated when the set changes.
- At least 2 references from the client's industry or an adjacent service business, marked `industry` in SOURCES.md.
- Dribbble and Behance concepts may be saved as inspiration only (`I01`...): never counted, never the bar.
- Redesign: the existing design system no longer filters the references. The user says what is open to change (`Open to change:` line in BRIEF.md, required) and only binding rules become `brand_constraints`.
- Also fixed during that run: false beige on off-white text, fonts via next/font variables, focus rings, a `select` step for dropdown probes, Cook's side-by-side reading baseline stills, baseline judges seeing the old site's stills, brand rules for judges, `gate.mjs archive-judges`.

## 1.3.0
Upgrading a redesign that already passed step 0b: run `gate.mjs verify 0b` again (rounds now check the probe snapshot taken there), and re-run the step-5 slop scan and round slop scans (they now record the bans file and compare against `cook/reports/slop-step5.json`).
Redesign mode: improve an existing site without breaking what works.
- `gate.mjs init --mode redesign` takes the source folders, exclusions, pages and checks (`set-checks`). Step 0b captures a baseline with `baseline.mjs`: stills, page inventory, slop and audit reports, motion hits and check results, plus `KEEP.md` and `probes.json`.
- `regress.mjs` runs every round: lost links, nav items, forms, fields, headings and ids are errors unless `KEEP.md` names the drop with the user's words; probes and checks must still pass.
- `pair.mjs` and the judge `ab` field: unlabeled old/new pairs; every judge must prefer the new side in every pair.
- In-place strategy by default (`set-strategy`); a rebuild needs the user's words and ports the existing logic.
- Slop scan `--baseline` and `--exclude`: excluded legacy code fails only on new slop.
- Guard: blocks only added animation (functional motion can be allowed with `motion-allow`), and before step 5 only design files in the source folders; baseline files and the judge key are protected.
- Shoots every page and interactive state (`shoot.mjs --pages`, `--steps`, `--suffix`); audit URLs compare normalized.
- Calibration re-bases correctly when a baseline round is rated.
- Probes: `baseline.mjs --probes-only` writes `probecheck.json`, which must show every probe proving something (false before its steps, true after); verify 0b requires it. Selectors take an opt-in `"exact": true`; a probe can `"mock"` its requests.
- Baseline: approved in step 0b with the stills shown; scored in step 1 with 2+ judges. A dirty baseline records a hash per changed file, and verify 5 ignores each one while its content still matches.
- verify 5 checks design files only (markup and style, changed or untracked); outside a git repo it is reported as not measured. verify 6a fails while a decorative motion hit remains.
- Motion: `motion-allow --text '<line>'` allows a line before it exists; test files are not motion-checked; `animation: none` is not motion. Every allowance needs the user's words.
- `shoot.mjs` fails on an HTTP status of 400 or more and on a missing file page; duplicate slugs in `--pages` are rejected.
- Slop: repeated findings are counted, so a new copy of a baselined finding is new.
- `init --exclude` stores the pattern without a leading `./` or a trailing `/`.
- `gate.mjs report` writes `cook/REPORT.md`.
- Preflight warns (not fatal) when Claude Code is not started in the project's git root, where a nested `.claude/settings.json` is not loaded.

Second debate review:
- Step 5 in redesign mode records the slop scan in `slop-step5.json` (with the final bans, checked by `bans_sha1`) instead of requiring zero errors. From 6a on, rounds compare against that report and need zero in-scope errors.
- KEEP.md: every Dropped and Copy changes line quotes the user's words in double quotes, names its item exactly in double quotes or backticks, and page or link drops use the `/path`. On `old -> new` lines only the left side counts; a quote of 3+ words matches longer old copy.
- Unstable ids, links and nav items: baseline loads each page twice and leaves out what differs; generated ids (React and Radix style) that disappear only warn.
- Probes: a submit that becomes a full-page navigation fails; request expectations count only requests made after the steps; probes may change selectors but keep name, page, viewport and request expectations, and may not lose expectations after 0b.
- Baseline pages: every baseline page is checked every round; a page that leaves the page list or returns an error needs a Dropped line with its path; new pages are warnings; `baseline.mjs` refuses to run again after 0b (reopen 0b to recapture).
- Mockup: covers the pages on a `Mockup covers: /,/pricing` line in BRIEF.md (default the first page); checks h1, nav texts and form fields by label or name.
- Comparisons use raw judge medians; a user rating of the old site is recorded and does not change the calibration.
- A/B pairs cover every baseline page and viewport and must be fresh; the reference side-by-side is still required.
- Page errors fail a round, new console errors warn, and a nav link moved elsewhere on the page warns.
- Dev servers that change port no longer matter (links compare by path).
- Baseline takes about 20 s per page; run it with a long timeout or in the background. `regress` is desktop-only.

## 1.2.0
Fixes from an independent review of 1.1.0.
- User words are verified against the prompts the user actually typed (logged by the guard hook); approvals expire when the stills change.
- Judging: judge files are write-once, must be newer than the code and logged by the hook; 3+ judges must agree around the median; the separate-session judge must meet the bar on its own.
- Bar and time cannot be lowered silently; calibration re-bases on newer rounds the user rates.
- Proof is tied to the build: slop reports must scan the build folder, audits must run on the build URL, side-by-sides must be current.
- References: real Inspo and Awwwards tool calls are required (logged by the hook), duplicate images are rejected.
- Motion: step 6b can start from set-motion --refs, the build must contain animation, evidence must be non-empty.
- Guard: build code blocked until steps 2-5 pass, broader animation detection, stricter protection of script-written files, agent-browser blocked.
- Slop scan: catches beige and indigo/violet gradients in more forms (oklch, CSS variables, CSS-in-JS), fewer false positives; a page with no typeface set is an error.
- Setup installs Playwright when missing; Windows path and shell fixes; audit no longer fails off-screen skip links.

## 1.1.0
- Guard hook (installed by setup, required by preflight): blocks build code before the mockup passes, animation code before the static design passes, and hand edits to script-written files; logs every tool call; adds the current step to every prompt.
- Step 6b: motion can come from any references the user gives, extracted with any tool or skill; every effect cites a reference with saved evidence, a measured duration and an easing, from 2+ references.
- Step 6a and the mockup: the gate scans for animation code.
- Step 7: feedback must name a section; no feedback needs the user's words (`gate.mjs no-feedback`).
- Step 8: the separate-session judge is proven from the hook's log, not self-reported.
- Step 4: the floor counts active time from the log and needs 3+ judged rounds.
- Slop scan: reduced-motion is required for movement, not for color-only transitions.

## 1.0.0
- `frontend-cook`: the 8-step gated design workflow on top of cook, with the Inspo and Awwwards MCPs.
- `frontend-cook-setup`: installs cook and both MCP servers and verifies Node, ffmpeg and a browser.
- `frontend-cook-judge`: the separate-session judge.
- Scripts: `gate.mjs` (step gates, scoring, calibration, approvals, overrides), `preflight.mjs`, `shoot.mjs`, `audit.mjs`, `slop_scan.mjs`.
- Tests for the gates and the scanner, run in CI.
