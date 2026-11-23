# Rubric, bar and calibration

## Dimensions

Every judge scores every dimension from 0 to 10, plus one overall score that is a holistic verdict, not an average. The six visual dimensions are scored in every round; `motion` is added from step 6b on. A judge file missing any dimension that applies is rejected by `gate.mjs score`. Using separate numbers stops the weakest dimension from hiding behind the others.

| Dimension | Checks | Typical failure |
|---|---|---|
| `layout` | grid, alignment, section rhythm, white space, hierarchy, what the eye hits first | everything centered, every section the same height, cramped or randomly loose spacing |
| `typography` | typeface choice, type scale, line length, line height, weight contrast, headline craft | one default sans everywhere, 6 near-identical sizes, 120-character lines, widows |
| `color` | palette from the references, contrast, accent restraint, light/dark balance | beige, purple gradients, grey-on-grey, accent on everything |
| `components` | buttons, nav, cards, forms, footers: consistent, crafted, with real states | default shadcn look, every block in a rounded card with a shadow, mismatched radii |
| `imagery` | photos, illustrations, product shots, icons: real, cropped with intent, consistent | stock photos, emoji icons, fake dashboards with random charts, blurry or stretched images |
| `responsive` | mobile is designed, not squeezed: type scale, order, tap targets, no overflow | desktop layout stacked into one long column, 11px text, horizontal scroll |
| `motion` (6b on) | timing, easing, purpose, restraint, reduced-motion | everything fades up on scroll, linear easing, bouncy springs on serious brands |

Optional: `similarity`, 0 to 100, how close the build is to the references in quality and feel (not a 1:1 copy).

## Anchors (what the numbers mean)

| Score | Means |
|---|---|
| 10 | Could win Site of the Day. Nothing to change. |
| 9.5 | Award-level. A designer would screenshot it. |
| 9.0 | Professional studio quality. Holds up next to the references. |
| 8.0 | Clean and competent. Looks like a good template. |
| 7.0 | Generic. You can tell an AI or a template made it. |
| 6.0 or less | Visible problems: broken spacing, bad contrast, slop patterns. |

The default bar is **9.2 overall, 8.5 every dimension**, by calibrated median. 8.0 ("good template") is exactly what this skill exists to beat. Lowering the overall bar, the per-dimension floor or the mockup bar needs the user's own words (`--quote`), checked against their messages.

## Measured beats eyeballed

Before any judging, the build must pass:
- `slop_scan.mjs`: the greppable bans (`slop.md`).
- `audit.mjs`, on every page: horizontal overflow, console and network errors, broken images, WCAG AA contrast on solid backgrounds, tap targets on mobile, body size on mobile, empty links, and (checks version 2) keyboard reachability, visible focus, form labels, reduced-motion rendering, and basic SEO and performance warnings (`references/usability.md`).
- `journeys.mjs`: the main user tasks in `cook/JOURNEYS.json`, on desktop and mobile.

A build that fails any of them is not sent to judges. In ROUNDS.md, label every number as measured (a command produced it) or eyeballed (a judge gave it).

## Calibration

- The offset starts at 0 and never goes above 0, so scores are never raised above the judges.
- The user gives an estimate below the judges' raw median → `gate.mjs calibrate --user <n> --quote "<their words, containing n>"` sets the offset to the gap; every later score is lowered by it. The offset is re-based on each newer round the user rates, so a later higher rating can bring it back up. Rescore open rounds.
- If the offset makes the bar unreachable, the gate warns. Ask the user to rate the next round.
- The user gives an estimate above the judges → nothing changes. The gaps the judges named still stand.
- Blind pair test, when a round scores suspiciously high: give a fresh judge one reference and one still without labels and ask which one is the real production site and why. A confident correct answer names the next focus.

## Similarity stretch target

99% similarity is not expected to be reached. It is the number that tells the loop the job is not done when it first works. It is reported every round; the hard gate is the quality bar plus the time floor.
