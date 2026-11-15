# Changelog

## 1.0.0
- `frontend-cook`: the 8-step gated design workflow on top of cook, with the Inspo and Awwwards MCPs.
- `frontend-cook-setup`: installs cook and both MCP servers and verifies Node, ffmpeg and a browser.
- `frontend-cook-judge`: the separate-session judge.
- Scripts: `gate.mjs` (step gates, scoring, calibration, approvals, overrides), `preflight.mjs`, `shoot.mjs`, `audit.mjs`, `slop_scan.mjs`.
- Tests for the gates and the scanner, run in CI.
