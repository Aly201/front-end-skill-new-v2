# How frontend-cook uses cook

frontend-cook is not a copy of cook. It runs cook's loop with frontend-specific steps, gates and tools on top. cook must be installed (step 0 checks it). Its path is in `cook/PREFLIGHT.json` under `checks.cook.path`, written as `<cook>` below.

## What to read from cook, and when

| cook file | Read at | Use for |
|---|---|---|
| `<cook>/SKILL.md` | step 0, once | The loop: rounds, gate, stop check, never list. |
| `<cook>/references/intake.md` | intake | One message, every question with a default. |
| `<cook>/references/target-and-bar.md` | steps 1 and 3 | References as the minimum bar, motion frame-by-frame analysis, stretch targets, calibration, measured vs eyeballed. |
| `<cook>/references/loop-and-critics.md` | step 6 | Focus order, parallel subagents, progress note, pacing, long runs. |
| `<cook>/templates/ROUNDS.md` | first round | Copy to `cook/ROUNDS.md`. |
| `<cook>/scripts/side-by-side.mjs` | every round | Reference left, build right. |

## Shared state

Both skills use `cook/` at the project root: `BRIEF.md`, `SHOTS.md`, `ROUNDS.md`, `refs/`, `stills/rNN/`, `compare/rNN/`. frontend-cook adds `GATES.json`, `PREFLIGHT.json`, `bans.json`, `mockup/`, `judge/<round>/`, `reports/`, `SECTIONS.md` and `MOTION.md`. A cook-aware agent can pick up a frontend-cook run from these files.

## Where frontend-cook overrides cook

| Topic | cook default | frontend-cook |
|---|---|---|
| Assets | Zero external assets (the flex is code). | Real fonts, real photos, real logos and real copy are allowed and better. Licensed only, credited in `cook/CREDITS.md`. No stock "people pointing at laptops". |
| Questions after intake | Never ask. | Never ask open questions, but wait at three approvals: mockup, static, final. While waiting, refine; do not move to the next stage. |
| Rubric | composition, light, color, materials, detail, motion | layout, typography, color, components, imagery, responsive, motion (`rubric.md`). |
| Bar | 99.9% stills, 9/10 video | 9.2/10 calibrated judge median, every dimension 8.5+, 99% similarity as stretch. |
| Time | floor 8h for demos | landing page floor 3h, multi-page floor 6h, app screen floor 2h, component cap 1h. |
| Stills | camera presets | `shoot.mjs` at fixed viewports: desktop 1440x900, mobile 390x844 (plus tablet if the brief needs it). |
| Measured checks | color per region, frame time | `slop_scan.mjs` and `audit.mjs` must pass before any judging; cook's color check (`target-and-bar.md`) is still useful for "too grey" problems. |
| Ship | video for X | A working build: production build passes, audit passes on the production URL, final stills, report. |
| Ban list | cook's list | cook's list plus the frontend list in `slop.md`, enforced by a scanner. |

Everything else in cook applies as written: references are the minimum bar, never copy one element 1:1, depth over breadth, never stop when it first works, never report what was not measured, the ledger is the handoff.
