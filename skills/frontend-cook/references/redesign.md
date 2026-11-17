# Redesign mode: an existing site, from 2/10 to 9/10, without breaking it

Use this when the site already exists and works: a running app, a marketing site with a contact form, a nav with a mobile menu, pages people use today. A new site with nothing to keep uses the normal flow.

The bar does not change: 9.2 overall, 8.5 per dimension, 99 similarity as the stretch target. Redesign mode adds four things:
1. A **baseline**, measured before any change: the old site's stills, inventory, reports and motion.
2. A **keep contract** (`KEEP.md`) written with the user: what must survive, what is dropped on purpose, what copy changes.
3. **Regression proof** every round: lost links, nav items, forms, fields, headings or ids fail, and every probe must pass.
4. **Old against new** judging: the new side must win every pair.

## Start

```bash
node <skill>/scripts/gate.mjs init --project X --mode redesign --src src --exclude 'src/legacy/**' --url http://localhost:5173 --pages /,/pricing
node <skill>/scripts/gate.mjs set-checks --cmd "npm test" --cmd "npm run build"
```

- `--src` is the folder with the design code. Repeat it for more folders. `--exclude` takes globs for code you will not restyle (legacy, vendored). Excluded files are still scanned, but only for new slop.
- `--url` is the running dev server or the production URL of the current site.
- `--pages` lists every page that matters. Each gets its own stills, inventory and audit. Change it later with `set-pages`.
- `shoot.mjs` fails on an HTTP status of 400 or more, and on a missing page file. A SPA dev server answers 200 for every path, so a wrong path there is not caught by the status: check the page list by eye.
- `set-checks` lists commands that must keep passing (tests, build, typecheck). A command that already fails on the baseline is recorded and not held against you; one that passes there must keep passing.

Then run step 0 (setup) as usual.

## Step 0b. Baseline

```bash
node <skill>/scripts/baseline.mjs
```

It captures the site as it is, into `cook/baseline/`:
- `stills/`: every page, desktop and mobile, full and folded, plus an 8-second desktop recording of motion.
- `inventory.json`: per page, the links, nav items, forms and their fields, buttons, h1 to h3 headings, images, ids, title, meta description and console errors. `regress.mjs` diffs every later round against it.
- `slop.json` and `audit-<page>.json`: the starting numbers. They do not have to pass.
- `motion.json`: every animation hit in the source folders, with a hash per line.
- `checks.json`: the exit code of each `set-checks` command on the untouched tree.
- `probecheck.json`: each probe run once before and once after its steps (see Probes below).
- `meta.json`: commit, dirty flag, time, URL and pages. A dirty baseline also records `dirty_files`: a hash of each changed file under `--src`.

**A dirty tree is refused.** Commit or stash first. If the user wants the current working state as the baseline, get their words, then:

```bash
node <skill>/scripts/gate.mjs allow-dirty --quote "<their words>"
node <skill>/scripts/baseline.mjs --allow-dirty
```

Then write two files by hand (the agent writes them, the scripts only check them).

**`cook/baseline/KEEP.md`** (template: `templates/KEEP.md`). Four headings:
- `## Keep`: what must still work and be visible. Quote the user where they said it.
- `## Dropped`: each removed item, with the user's exact words in quotes. Every drop must be here, or `regress.mjs` fails it.
- `## Copy changes`: each text change, old and new, with the user's words.
- `## Motion`: a table with one row per hit in `motion.json`: `| file:line | hash | functional/decorative | keep/replace/remove |`. Copy the hashes from the file (12 hex characters each).

**`cook/baseline/probes.json`** (template: `templates/probes.example.json`). A list of checks, one per form and one per toggle in the inventory (menu, tabs, dialog, accordion):

```json
[{ "name": "contact form submits", "page": "/", "viewport": "desktop",
   "steps": [{ "fill": { "label": "Email", "value": "a@b.co" } }, { "click": { "role": "button", "name": "Send" } }],
   "expect": [{ "request": "/api/contact" }, { "text": "Thanks" }] }]
```

Selectors are by role and name, or by label or text, never by class or DOM path. The redesign changes classes; a probe that depends on them fails for the wrong reason. Step formats: `click`, `fill`, `hover`, `press`, `wait`. Expectations: `visible`, `text`, `request`. Probes must pass on the baseline.

Rules for probes:
- **Dev or staging only.** Probes run against a dev or staging URL, never production. A probe that submits a form changes real data there.
- **Mock the submits.** A per-probe `"mock"` fulfils matching requests in the browser, so a form submit does not reach a real backend. It is opt-in, per probe: `"mock": [{ "url": "/api/contact", "status": 200, "body": "{\"ok\":true}" }]`. The `url` matches as a substring of the request URL, so keep it specific: a bare `/` would answer every request, including the page itself.
- **Exact names where a loose match would pass a broken page.** Selectors match loosely by default. Add `"exact": true` to a selector to require the whole name (opt-in). A menu probe that must fail when the menu is broken targets `{ "role": "navigation" }` or uses `"exact": true`.
- **Every probe must prove something.** `node <skill>/scripts/baseline.mjs --probes-only` runs each probe once before its steps and once after, and writes `cook/baseline/probecheck.json`: `[{name, page, viewport, before:[bool], after:[bool], proves}]`. `proves` is true when some expectation is false before the steps and true after. A `request` expectation counts as false before. A probe that is already true before it acts passes on any page: fix it until `proves` is true.

`verify 0b` checks: stills for every page, desktop and mobile, full and folded; an audit for every page; the inventory; one probe per form, on that form's page; `probecheck.json`, newer than `probes.json`, with every probe proving something; KEEP.md has the four headings; every motion hit is classified; the baseline is approved (`approve baseline`, with the stills shown). Every round's `regress.mjs` runs the probes again.

**Approve the baseline in step 0b.** Show the user the baseline stills (every page, desktop and mobile), the KEEP.md and the probes, then `gate.mjs approve baseline --quote "<their words>"`. The approval expires if the stills change.

**Score the baseline in step 1.** Once the references exist, put the old site beside a reference (reference left, old site right) in `cook/compare/baseline/`, then have 2+ fresh judges score it into `cook/judge/baseline/`, the same way as every round, and run `gate.mjs score baseline`. These scores are the floor for "no dimension below the baseline" at the end.

## Step 1 (redesign)

Add a `Keep:` line to `cook/BRIEF.md` with the Keep list. Score the baseline (above).

## Step 2 (redesign): the mockup redesigns the real content

The mockup covers the same content as the old site, not invented copy. Every heading, nav label, form field and CTA label in the inventory for the sections it covers must appear in `cook/mockup/index.html`, or be listed under Copy changes or Dropped. Anything else fails `verify 2`.

Stills for the judges: a three-way sheet in `cook/compare/mockup/`: old site, mockup, closest reference.

## Step 3 (redesign): same bar, no regression

The bar is the same. Add the baseline rule: no dimension may end below its baseline score. `verify 8` checks it.

## Step 5 (redesign): scan against the baseline

```bash
node <skill>/scripts/slop_scan.mjs src --baseline cook/baseline/slop.json --exclude 'src/legacy/**' --out cook/reports/slop-step5.json
```

- Inside scope, the scan is as strict as ever: zero errors.
- Excluded files: only **new** findings fail. Old ones are listed as `remaining`; fixed ones as `fixed`.
- `verify 5` runs a git check: no design file under `--src` may differ from the baseline commit (changed or untracked). Design files are markup and style. Tests, config, server and API code, and logic files without markup or style (no JSX, class names, `styled`, `css`, `cva`, `style={{`, or a style module) are not design files. Outside a git repo the check is reported as not measured.
- Before step 5 the guard lets tests, config, server and API code, and logic fixes through. A logic fix passes `verify 5`. A markup or style change does not: design work starts in 6a, after step 5 passes.

## Step 6a (redesign): in place, in order

`gate.mjs set-strategy --in-place` is the default. Work in this order, one round for each stage, with before and after stills:
1. Tokens: type, colour, spacing, radius, in the theme or variables.
2. Shared components: nav, buttons, form controls.
3. Sections, top to bottom.
4. Dead CSS, once the sections that used it are gone.

`--rebuild` only with the user's own words (`set-strategy --rebuild --quote "..."`). Even then the new code ports the existing logic (handlers, validation, data fetching, state) and keeps the tests. Do not rewrite it from memory. Probes must pass on the new code before the round is judged.

**Motion in redesign:**
- Guard: only **added** animation is blocked. Existing lines may stay while you restyle around them.
- First 6a round: remove decorative existing motion (scroll reveals, counters, decorative loops, marquees). Step 6b redesigns motion from references.
- Functional motion (loading spinners, lazy-load observers, rAF debouncing, transitions the UI depends on) stays. Ask the user first, then allow each hit with their words:
  `gate.mjs motion-allow src/hooks/useLazy.js 9d0b7a44c1e2 --reason "lazy loading" --quote "<their words>"`. The hash (12 hex characters) comes from `motion.json`, or from the Motion table.
- A line you are about to write: `gate.mjs motion-allow <file> --text '<line>' --reason "..." --quote "<their words>"` allows it before it exists.
- Test files (`*.test.*`, `*.spec.*`, `__tests__/`) are not checked for motion. `animation: none` resets are not motion, so they need no allowance.

## Each round (redesign)

```bash
node <skill>/scripts/shoot.mjs http://localhost:5173 --pages /,/pricing --out cook/stills/rNN --fold
node <skill>/scripts/shoot.mjs http://localhost:5173 --pages / --steps '[{"click":{"role":"button","name":"Menu"}}]' --suffix menu --out cook/stills/rNN
node <skill>/scripts/regress.mjs --out cook/reports/regress-rNN.json
```

- Stills of every page, desktop and mobile, plus interactive states (`--steps`, `--suffix`): open menu, form error, hover.
- `regress.mjs` re-extracts every page's inventory and diffs it against the baseline (lost link, nav item, form, field, heading, id, or changed title is an error unless KEEP.md names it), runs every probe, and reruns the `set-checks` commands (an error only where the baseline passed). Its report must be ok and current.
- Slop scan and audit run as in the normal round, on each page.

## Step 8 (redesign): old against new

```bash
node <skill>/scripts/pair.mjs --round rNN
```

It makes `cook/compare/rNN/ab-<n>.jpg`: one pair per page and viewport that has both a baseline still and a round still, old and new placed left or right at random, with no labels. The key lives in `cook/judge/rNN/.abkey.json`, which is protected; `pair.mjs` never prints it.

Judges add an `ab` list to their JSON, one entry per pair: `"ab": [{ "pair": "ab-1", "better": "left", "why": "..." }]`. They never learn which side is new.

`verify 8` requires every judge in the final round to have an entry for every pair, and every choice to be the new side. One wrong choice fails the round. Fix the design, not the judges. Also required: the bar met, no dimension below its baseline, and `regress` ok.

## Final report

Run `node <skill>/scripts/gate.mjs report`. It writes `cook/REPORT.md` from the gate state and the reports, and prints it. It covers the steps, the overrides with the user's words, before and after scores, slop and audit counts, the Dropped items and the motion allowances. The regress results and the `set-checks` results are in `cook/reports/` and `cook/baseline/checks.json`: cite them from there.

- Before and after, per dimension: baseline judge scores against the final round.
- Slop and audit deltas: `slop.json` and `audit-<page>.json` against the last round.
- Every Dropped item, with the user's words.
