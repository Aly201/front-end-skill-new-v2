# frontend-cook

A Claude Code skill for frontend design that does not accept "looks good" from anyone: not from the model, not from a subagent, not from you. It runs an 8-step workflow where every step has requirements a script checks **before** it starts and proof a script checks **before** it counts as done. Generic "AI-looking" pages fail the build.

It is built on top of [cook](https://github.com/Leonxlnx/cook) (the build, compare, critique, fix loop) and uses two design-reference libraries over MCP: [Inspo](https://inspomcp.dev) (832 real production sites with palettes, type ramps and DESIGN.md files) and [Awwwards MCP](https://github.com/INSANE0777/Awwwards-mcp) (award-winning sites with design DNA and motion analysis). It will not run without them, and installs them for you.

## The 8 steps and what the gate checks

| # | Step | The gate refuses to pass it until |
|---|---|---|
| 0 | Setup | cook is installed, the Inspo and Awwwards MCPs are configured, Node 18+, ffmpeg and a headless browser work. Cannot be overridden. |
| 1 | Strong references | 9 to 12 references, each a real capture 1200px+ wide, from 3+ different sites, every one a different image. The log must show real Inspo and Awwwards tool calls for what you did not supply, and every reference needs a source and a "take from it" note. The brief stays under 40 lines. |
| 2 | Target mockup | Steps 2 to 5 must pass before any build code is allowed. A single-file, animation-free mockup exists, its desktop and mobile stills are newer than its code, it is shown side by side with the references, it passes the slop scan, 2+ fresh judges scored its feel, and **you** approved it in your own words. The approval expires if the stills change. |
| 3 | Bar as a number | Overall 9.2/10 and every dimension 8.5+ (by default). Lowering the overall bar, the per-dimension floor or the mockup bar needs your own words. |
| 4 | Time | A floor (landing page 3h by default) or a cap is set. The floor counts **active** time from the hook's log (idle gaps over 15 minutes do not count) and needs 3+ judged rounds with 2+ judges each. A cap, or a floor under 2h, needs your words. Finishing early fails step 8. |
| 5 | Ban the slop | The ban file exists; a ban is switched off only with your own words. |
| 6a | Static build | No motion code in the build: scroll reveals, transitions of 500ms or more and marquees are blocked too. Latest stills, slop scan, browser audit and judge scores are all newer than the latest code change, the calibrated score meets the bar, and you approved the static design. |
| 6b | Motion | Starts with `set-motion --refs`. You give references (sites or videos) and it extracts the motion with any tool or skill (recordings, ffmpeg frames, Awwwards motion analysis, ...), saving the output. 5+ effects from 2+ references, each with a measured duration and easing and non-empty saved evidence; the build must contain animation code; recorded and judged. Or you said "no motion" in your own words. |
| 7 | Specific feedback | Every feedback item names a section (S1, S2...) from the section-by-section description, none is open, every closed one points to a screenshot that exists. No feedback at all needs your words. |
| 8 | Separate judge | 2+ fresh judges agree: with 2, their scores are within 1.0; with 3 or more, the lowest is within 1.0 of the median. Judge files are written once and must be newer than the latest code change. The hook's log proves a judge file was written by a separate session that never touched the build, and that judge must meet the bar on its own. The time floor is reached and you approved the final stills. |

## How it is enforced

Two layers. `gate.mjs` checks every step before it starts and before it counts as done. A **guard hook** (added to your project's `.claude/settings.json` by setup) makes Claude Code itself refuse: build code until steps 2 to 5 pass, motion code (scroll reveals, long transitions, marquees included) before the static design is approved, `agent-browser`, a second write to a judge file, and hand edits to the files only the scripts write. It also logs every action and every prompt you type, which is how your words, the separate judge and the active time are proven. Both behaviours were tested in a live Claude Code session.

## Why it does not agree with you

- **Your praise is not a score.** "Looks amazing" does not move a number. Fresh judges and measured checks do.
- **Your harsher estimate always counts.** Say "this is a 6" and every later score drops by the gap (`gate.mjs calibrate`). A kinder estimate is refused.
- **Your words are checked.** Approvals, overrides, a lower bar or time floor, "no motion", "no feedback", calibration and switched-off bans need words you actually typed in this project. The guard hook logs your prompts to `cook/.ledger.jsonl`, and the gate checks the quote against that log. Any other text does not count, including text the agent typed for you.
- **When you ask for something that makes it worse** (skip the mockup, three references, a purple gradient, ship at 8.1), it tells you what it costs and offers a better route. If you still want it, it does it and records your exact words as an override. Overrides appear in the final report.
- **Stale proof does not count.** A screenshot or score older than the latest code change is rejected.

## What the scripts measure

- `slop_scan.mjs`: beige, purple gradients, em dashes, "Unlock the power"-style copy, lorem ipsum, Acme/John Doe, eyebrow labels, monospace uppercase, 01/02/03 counters, glowing orbs, ping rings, particles, gradient text, animation without `prefers-reduced-motion`; warnings for emoji icons, sparkles, glass cards, default-only typefaces, font sprawl.
- `audit.mjs` (in a real browser): horizontal overflow, console and network errors, broken images, WCAG AA contrast on solid backgrounds, tap targets and body text size on mobile, unnamed links and buttons.
- `shoot.mjs`: the same capture settings for references, mockup and every round (desktop 1440, mobile 390), animations settled to their end state, plus scroll recordings and filmstrips for motion.
- `gate.mjs`: the step gates, judge score aggregation (median, spread, calibration) and approvals.

## Requirements

- Claude Code
- Node.js 18+
- ffmpeg
- Playwright with Chromium. Setup installs both automatically when they are missing (by hand: `npm i -D playwright && npx playwright install chromium`). A Chromium the scripts can find also works.
- Installed by `/frontend-cook-setup` if missing: the cook skill, the Inspo MCP, the Awwwards MCP, the guard hook

## Install

```bash
npx skills add Aly201/front-end-skill-new-v2
```

Then in Claude Code, inside your project:

1. `/frontend-cook-setup`: installs cook and the two MCP servers and checks the rest. Restart Claude Code if it added an MCP server.
2. `/frontend-cook build a landing page for ...` with any references you have. Keep the prompt short.
3. Answer the one intake message (or reply "defaults").
4. Approve the mockup, the static design and the final stills when it asks, in your own words.
5. For step 8, open a second Claude Code session in the same project and run `/frontend-cook-judge <round>`.

## Honest limits

- Judges are language models. They are calibrated by your estimates and checked by scripts, but a 9.2 is still a judgment, not a measurement.
- The slop scanner works on source code with patterns; it can miss a banned look built in an unusual way, and it can flag an allowed use. That is why visual bans are also on the judges' list and why a ban can be switched off with your words.
- Contrast is measured only on text over solid colors; text over images and gradients is reported as "not measured" for the judges to look at.
- New MCP servers and hooks load only after a session restart.
- User prompts are logged locally to `cook/.ledger.jsonl` (that is how your words are verified). Do not commit `cook/` if your prompts are private.
- The hook sees Claude Code's own tools. Code written by a program Claude runs (for example a Python script that writes files) gets past the hook. The gate still scans the build for animation code and rejects stale proof, so it cannot pass a step that way, but it can write the code.
- A subagent judge's "fresh context" cannot be proven; that is why step 8 requires a judge from a separate session, which can be proven.
- The Awwwards MCP index is a local cache that fills over time; early searches can be thin. Inspo fills the gap.

## License

MIT. See `LICENSE` and `LICENSE-THIRD-PARTY.md`.
