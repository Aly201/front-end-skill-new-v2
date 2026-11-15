# Changelog

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
