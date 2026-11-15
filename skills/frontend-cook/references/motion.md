# Step 6b: motion, taken from references

Static first, motion second (the guard hook blocks animation code until step 6a passed). A layout that fails as a still will not be saved by animation, and animating an unfinished layout wastes the work when the layout changes. Motion starts only after step 6a passed and the user approved the static stills.

## 1. Get motion references

The user can hand over references in any form: site URLs, screen recordings, a folder of videos, or just "the motion on R02 and R05". Use them first. If they gave none, pick 3 to 6 sites whose motion fits the references (Awwwards `search_sites` with motion-heavy tags, Inspo exemplars).

- User videos go in `cook/refs/` as `V01.mp4`, `V02.webm`...
- Sites keep their R or V id from SOURCES.md.

## 2. Extract the motion, with any tool or skill that works

Pick whatever gets the most exact numbers. Examples, not a required list:

| Tool | Gives you |
|---|---|
| `shoot.mjs <url> --out cook/refs/motion --name V01 --live --video 12` | a scroll-through recording and a filmstrip |
| ffmpeg on any video (`ffmpeg -i V01.mp4 -vf fps=10 cook/refs/motion/V01-frames/f_%04d.png`) | frames to measure duration, distance, stagger (cook's method, `<cook>/references/target-and-bar.md`) |
| Awwwards `get_motion_dna` | animation libraries, ScrollTrigger use, easing and duration vocabulary |
| Awwwards `analyze_scroll_map`, `analyze_hover_census`, `record_site_motion` | per-element scroll triggers, hover recipes with timings, recordings (need Playwright in the MCP's install) |
| any other installed skill, MCP or browser tool | whatever it measures |

**Save what each tool produced** in `cook/refs/motion/`, named after the reference: `V01-frames/`, `R03-motion-dna.json`, `R05-hover-census.md`, `R02-notes.md` (your measurements from frames). The gate checks that every reference cited in MOTION.md has evidence there (or a user video in `cook/refs/`). No evidence means the motion was invented, and the step fails.

"Things fade in" is 1% of what a reference holds. Measure: how many frames a move takes, how position changes per frame (easing), what moves first (order, stagger), how far it travels.

## 3. Write `cook/MOTION.md`

One table row per effect. The gate needs 5+ rows, from 2+ references, each with a reference id in the first column and a duration plus an easing in the "How" column:

```text
| Ref | Time | What moves | How (duration, easing, distance, stagger) | Why it works | Use in |
|---|---|---|---|---|---|
| V01 | 0:02 | hero headline lines | 700ms, cubic-bezier(.2,.7,.2,1), 24px up, 80ms stagger per line | reads in order, feels heavy | S1 |
| R03 | scroll | nav on scroll | hides after 120px down, back on up, 250ms ease-out | content first | S0 |
```

Pick a small core (5 to 10 effects that carry the feel) and a set of small ones (hover, focus, press). Take from many references, never one effect copied 1:1.

## 4. Build rules

- Animate `transform` and `opacity`. Not `width`, `height`, `top`, `left`, `margin` or `box-shadow` on scroll.
- Durations: UI feedback 120-250ms, entrances 400-900ms, nothing over 1200ms unless it is a deliberate hero moment.
- No linear easing on movement. No bouncy springs on a serious brand.
- Every animation has a `prefers-reduced-motion` path (the scanner fails the build without one).
- Content is readable with JavaScript off or before animations start: no permanent `opacity: 0` waiting for a script.
- Motion banned unless the user asks: everything fading up on scroll, icons floating for no reason, parallax on every image, cursor followers, marquees of fake logos, typewriter headlines.

## 5. Check it

Each round in 6b also records the build: `shoot.mjs <url> --out cook/stills/rNN --name S01 --live --video 12`. Judges get the filmstrips and score `motion`. `audit.mjs` must still pass (no console errors from animation libraries).
