# Changelog

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
