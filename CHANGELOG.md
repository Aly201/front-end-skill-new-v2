# Changelog

## 1.3.0
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
