# Step 6b: motion, from reference videos

Static first, motion second. A layout that fails as a still will not be saved by animation, and animating an unfinished layout wastes the work when the layout changes. Motion starts only after step 6a passed and the user approved the static stills.

## 1. Get motion references

- 3 to 6 sites whose motion the user likes or that lead the references. Awwwards `get_motion_dna` (libraries, ScrollTrigger use, easing and duration vocabulary) and `search_sites` with motion-heavy tags help find and read them.
- Record each one the same way the build will be recorded:
  ```bash
  node <skill>/scripts/shoot.mjs https://motion-ref.com --out cook/refs --name V01 --live --video 12 --viewports desktop
  ```
  This writes `V01-motion.webm` and a filmstrip `V01-motion-strip.jpg`. User-supplied videos go in `cook/refs/` as V01, V02...

## 2. Analyze frame by frame

"Things fade in" is 1% of what a reference holds. Use cook's method (`<cook>/references/target-and-bar.md`, "Motion references"):

```bash
ffmpeg -i cook/refs/V01-motion.webm -vf fps=10 cook/refs/V01/f_%04d.png
```

Around a transition, extract every frame of that range (`-ss`/`-to`, no fps filter) and measure: how many frames it takes (duration), how the position changes per frame (easing), what moves first (stagger, order).

## 3. Write `cook/MOTION.md`

One line per effect (the gate needs at least 5):

```text
| Ref | Time | What moves | How (duration, easing, distance, stagger) | Why it works | Use in |
|---|---|---|---|---|---|
| V01 | 0:02 | hero headline lines | 700ms, cubic-bezier(.2,.7,.2,1), 24px up, 80ms stagger per line | reads in order, feels heavy | hero |
| V02 | 0:05 | nav on scroll | hides after 120px down, back on up, 250ms | content first | nav |
```

Pick a small core (5 to 10 effects that carry the feel) and a set of small ones (hover states, focus, press). Take from many references, never one effect copied 1:1.

## 4. Build rules

- Animate `transform` and `opacity`. Not `width`, `height`, `top`, `left`, `margin` or `box-shadow` on scroll.
- Durations: UI feedback 120-250ms, entrances 400-900ms, nothing over 1200ms unless it is a deliberate hero moment.
- No linear easing on movement. No bouncy springs on a serious brand.
- Every animation has a `prefers-reduced-motion` path (the scanner fails the build without one).
- Content is readable with JavaScript off or before animations start: no permanent `opacity: 0` waiting for a script.
- Motion banned unless the user asks: everything fading up on scroll, icons floating for no reason, parallax on every image, cursor followers, marquees of fake logos, typewriter headlines.

## 5. Check it

Each round in 6b also records the build: `shoot.mjs <url> --out cook/stills/rNN --name S01 --live --video 12`. Judges get the filmstrips and score `motion`. `audit.mjs` must still pass (no console errors from animation libraries).
