# Step 5: ban the slop

Models fall back to the same few looks when nothing stops them. Naming them explicitly is what gets past the generic "AI website". There are two kinds of bans: the ones a script can find in the code (enforced by `slop_scan.mjs`, the build fails), and the visual ones only a viewer can see (enforced by the judges, who list them in `slop_seen`).

## Enforced by the scanner (errors fail the build)

| id | What |
|---|---|
| `beige` | Beige / cream / sand backgrounds and fills (hue 25-55, light 78-96%), named colors like `wheat`, `linen`, Tailwind `stone-50`, `amber-50`. |
| `purple-gradient` | Gradients with purple / violet / indigo stops (CSS or Tailwind `from-purple-*`). |
| `em-dash` | Em dashes in copy. |
| `slop-copy` | "Unlock the power", "Elevate your", "Supercharge", "Revolutionize", "Seamless", "Cutting-edge", "Game-changer", "Next-level", "Unleash", "Harness the power", "In today's fast-paced", "Look no further", "Delve into", "Effortless". |
| `lorem-ipsum` | Placeholder text. |
| `placeholder-names` | Acme, John Doe, Jane Doe, Your Company, Company Name. |
| `eyebrow-label` | Small uppercase letter-spaced label above a heading. |
| `mono-uppercase` | Monospace uppercase text. |
| `counter-01` | 01 / 02 / 03 numbering. |
| `glow-orb` | Big blurred circles and blobs. |
| `ping-ring` | Shockwave rings (`animate-ping`). |
| `particles` | Decorative particle libraries. |
| `gradient-text` | Gradient-filled headline text. |
| `reduced-motion` | Animation anywhere with no `prefers-reduced-motion` handling. |

Warnings (shown, do not fail, judges weigh them): `purple-accent`, `emoji-icon`, `sparkles-icon`, `glass-card`, `default-typeface` (only Inter / Roboto / system), `font-sprawl` (more than 3 typefaces).

Run it on the source folder, not the build output:

```bash
node <skill>/scripts/slop_scan.mjs src --out cook/reports/slop-r03.json
```

## Enforced by the judges (visual)

- Centered hero with a headline, a sub-line, two buttons and a gradient blob behind. The default AI landing page.
- Three identical cards with an icon on top, a bold title and two lines of text.
- Everything inside rounded-2xl cards with soft shadows.
- A fake product dashboard with random charts as the hero image.
- Dark navy background with one neon accent.
- Stock photos of people smiling at laptops; 3D blob illustrations; generic isometric art.
- Grey-on-white body text with low contrast; tiny light-grey captions.
- Every section the same height and the same padding; no rhythm.
- Everything fades up on scroll.
- Long thin decorative lines, random serif accents, logo clouds of fake companies.
- Testimonials from people who do not exist, with stock avatars.

The fix is never "remove it and leave a hole". Look at what the references do in that spot and do that.

## The user's own bans

- Greppable (a color, a word, a class): add to `extra` in `cook/bans.json`:
  `{ "id": "no-rounded-xl", "pattern": "rounded-(xl|2xl|3xl)", "message": "user: no big radii" }`
- Visual: add plain words to `user_bans`. The judges get that list in their prompt.

## Switching a ban off

Only the user can, only with their own words: `{ "id": "em-dash", "quote": "em dashes are part of our editorial voice" }` in `allowed`. Before adding it, say once what the ban protects against (`pushback.md`). The scanner rejects entries without a real quote.
