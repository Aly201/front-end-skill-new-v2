# Usability: checks, journeys, right-to-left and reduced motion

Read this at step 6a, and again when an audit or journey fails. Judges score how a page looks. They cannot see that a button is unreachable by keyboard, that a field has no label, that the text is invisible under reduced motion, or that the sign-up form stops working on mobile. These checks measure that, and the journeys check the tasks a visitor came to do. Measured checks come before judging: a build that fails them is not shown to judges.

## What audit.mjs checks now

`audit.mjs` runs on every page, at desktop and mobile width. Its report is version 2 (`checks_version: 2`); the gate rejects an older report. Each viewport has an `interaction` block with the raw numbers (`focus_checked`, `focus_missing`, `unreachable`, `unlabeled_fields`, `reduced_motion_hidden`, `infinite_animations`, `seo`, `perf`), and the findings the gate reads come from these checks:

| Check | Level | What it means |
|---|---|---|
| `keyboard` | error | A visible link, button or input that Tab never reaches among the first 60 Tab stops. |
| `keyboard` | error | A focused element with no visible focus indicator: its outline, box-shadow, border and background are all unchanged from unfocused. |
| `labels` | error | An input, select or textarea with no accessible name. |
| `reduced-motion` | error | With reduced motion requested, text in the first two screens stays at opacity below 0.1, or is `visibility: hidden`, one second after load. |
| `reduced-motion` | warn | Infinite animations still run with reduced motion requested. |
| `seo` | warn | Missing `<title>`, missing meta description, missing `lang` on `<html>`, or an h1 count other than 1. |
| `perf` | warn | Page transfer above 3000 KB, or LCP above 4000 ms. LCP is measured where the browser reports it; otherwise it is `null` and not measured. |

The `seo` block also records `img_no_dims` (images without width and height). It is reported as evidence, not as a finding, and it feeds the Performance items of `RELEASE.md`.

These are heuristics. The keyboard check looks at the first 60 Tab stops and compares focus styles before and after focus. It does not prove that every path through the page can be used from the keyboard.

## How to fix the common failures

- **Unreachable by Tab.** Use a real `<a href>` or `<button>` for anything clickable. A `<div onClick>` is invisible to the keyboard. Do not put `tabindex="-1"` on a control the user needs. A custom menu must make each item a link or button.
- **No visible focus.** Do not remove the outline without a replacement. Use a visible focus style with enough contrast, for example `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }`, with `--focus` set in the tokens and at least 3:1 against the background.
- **Unlabeled fields.** Give every input a `<label for="...">`, or `aria-label` when the visible label is an icon. A placeholder is not a label. A search box with only a magnifier icon needs `aria-label="Search"`.
- **Hidden under reduced motion.** A reveal that starts at `opacity: 0` and waits for a script or an observer must end visible when the user asks for less motion:
  ```css
  @media (prefers-reduced-motion: reduce) {
    .reveal { opacity: 1; transform: none; transition: none; animation: none; }
  }
  ```
- **Infinite animation under reduced motion.** Stop decorative loops (marquees, pulsing rings, floating shapes) under `prefers-reduced-motion: reduce`. A loading indicator that shows real progress may keep moving.
- **SEO.** One `<title>` and one `<meta name="description" content="...">` per page; `<html lang="en">` (or `lang="ar" dir="rtl"`); exactly one `<h1>`.
- **Perf: transfer.** Compress images, size them to their slot, drop unused font weights and scripts, and lazy-load what is below the fold (not the hero).
- **Perf: LCP.** Size and preload the hero image, do not lazy-load it, and set fonts to `font-display: swap`.

## JOURNEYS.json: the main tasks

Judges see stills; journeys check that the tasks work. Write `cook/JOURNEYS.json` before the first round (step 6a), in both modes. Each journey is one main user task: sign up, choose a plan, send a message, find a location, switch language. `journeys.mjs` runs each one on each viewport in a fresh browser context, applies the mocks, runs the steps and checks the expectations, then takes a screenshot.

The file is a list:

```json
[
  {
    "name": "contact: send a message",
    "page": "/contact",
    "viewports": ["desktop", "mobile"],
    "rtl": false,
    "steps": [
      { "fill": { "label": "Email", "value": "a@b.co" } },
      { "fill": { "label": "Message", "value": "I would like a quote." } },
      { "click": { "role": "button", "name": "Send" } }
    ],
    "expect": [{ "request": "/api/contact" }, { "text": "Thanks" }],
    "mock": [{ "url": "/api/contact", "status": 200, "body": "{\"ok\":true}" }],
    "states": [
      { "name": "success", "steps": [], "expect": [{ "text": "Thanks" }] }
    ]
  }
]
```

- **Fields.** `name`, `page`, `viewports` (both `desktop` and `mobile` for every journey: the gate checks both), `rtl`, `steps`, `expect`, `mock`, and `states`. Steps and expectations use the same formats as the probes in `redesign.md`: steps `click`, `fill`, `select`, `hover`, `press`, `wait`; expectations `visible`, `text`, `request`. A `request` expectation counts only requests made after the steps.
- **Which journeys.** At least one journey for every page that has a form or more than two links. Cover the tasks a visitor came for, not every link.
- **Mocks.** Fulfil submits so no real backend is called. `url` matches as a substring of the request URL, so keep it specific. Journeys run against a dev or staging URL, never production.
- **States.** Each state runs in a fresh context with its own steps and expectations, and writes its own screenshot. The four states to cover are loading, empty, error and success, where the page has them. A state uses the journey's `mock` list. If a state needs a different answer from the server (for example a 500 for the error screen), give it its own journey with that mock.
- **Run it.** `node <skill>/scripts/journeys.mjs --round rNN --out cook/reports/journeys-rNN.json`. It exits 0 only when every journey, viewport and state passes. Screenshots go to `cook/stills/rNN/journey-<slug>-<viewport>.png` and `journey-<slug>-<state>.png`. The report records `journeys_sha1`, the hash of the file it ran. The gate requires the report to be newer than the latest source change and to carry the hash of the current `JOURNEYS.json`, so edit the file, then run it again.

## Arabic and right-to-left projects

Use `init --languages en,ar` (or `set-languages`). RTL languages are `ar`, `he`, `fa` and `ur`. When any of them is in the list:

- **A journey for RTL.** Every round needs at least one journey with `"rtl": true` that passes on both mobile and desktop. Its steps switch the language first, using the page's own control, for example `{ "click": { "role": "button", "name": "العربية" } }`. The journey then checks that `document.documentElement.dir` is `rtl`, that the page has no horizontal overflow, and it writes a screenshot ending in `-rtl.png`.
- **Audit in RTL.** `audit.mjs <url> --rtl --steps '<json>'` runs the steps (the language switch) after load, then measures the switched page. With `--rtl`, an error is reported when `document.documentElement.dir` is not `rtl`. Run it on the home page and on each page that the language switch reaches.
- **Layout.** Use logical properties (`margin-inline-start`, `padding-inline-end`, `inset-inline-start`) instead of left and right. Mirror directional icons such as arrows and chevrons. Keep phone numbers, prices and codes in their own LTR spans.
- **Type.** Use a typeface that has Arabic glyphs. Check the line height of Arabic text; it often needs more than the Latin value.
- **Copy.** Both languages carry real copy, not a machine placeholder. `RELEASE.md` checks this under Content.

## Reduced motion

Every animation needs a `prefers-reduced-motion` path. `audit.mjs` renders each page with reduced motion requested, so it catches the failures: content that stays hidden (error), and loops that keep running (warning). The motion step (6b) also requires the path for every effect in `MOTION.md`. With reduced motion the content must be visible, and movement must stop or reduce to a fade or nothing. Judges score `motion` on the result, including its reduced version.

## Order in a round

1. `slop_scan.mjs` on the source.
2. `audit.mjs` on every page, one report per page (`audit-rNN-<slug>.json`).
3. `audit.mjs --rtl --steps` for RTL projects.
4. `journeys.mjs --round rNN`.
5. Redesign only: `regress.mjs`.
6. Stills, side-by-sides, then judges.

Anything that fails in 1 to 5 is fixed first. The judges see the build only after all of it passes.
