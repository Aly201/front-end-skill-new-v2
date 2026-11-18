# Step 1: strong references

Short prompt, strong references. One good screenshot tells the model the type, spacing, color, density and mood at once; a paragraph of adjectives does not. The references are the minimum bar, not loose inspiration.

## How many and what kind

- **9 to 12** images. Fewer leaves the judges nothing to measure against; more blurs the direction.
- Real production sites or real product screens, captured at **1200px+ wide**. No Dribbble shots of apps that do not exist, no AI-generated UI mockups (they carry the slop you are trying to avoid), no thumbnails.
- From **at least 3 different sites**. Take from many, copy none.
- Cover what the build needs: the hero, the main section types (features, pricing, testimonials, gallery, whatever the brief has), the footer, and mobile. One reference can lead on type and be ignored on layout; write that down.
- Motion references (videos, V01...) are separate and do not count toward the 9 to 12.

## Where they come from, in this order

1. **The user's own.** Brand sites, competitors they admire, screenshots they attached. Ask at intake and **wait for the answer**: this question never gets a default. Mark them `user` in SOURCES.md. If they have none, record their words with `gate.mjs no-user-refs --quote "..."`; the gate refuses step 1 otherwise.
2. **Inspo MCP** (832 real sites, captured on desktop and mobile, with traced palettes and type ramps):
   - `recommend` with the one-sentence brief: one call returns a macrostructure, 5 exemplars, reference components and a palette direction. Start here.
   - `search_screens` with `style`, `industry`, `macrostructure`, `mode` filters (call `get_filters` if unsure of the values).
   - `find_similar` on the best hit to widen around it.
   - `find_components` for a specific section (hero, pricing, nav, footer, faq, stat...).
   - `get_design_system` on the 2 or 3 references that lead on type and color: real fonts, palette roles, type ramp, spacing scale. Put these numbers in BRIEF.md; they are better than guessing.
   - `find_by_color` when the brand has a fixed color.
3. **Awwwards MCP** (award-winning sites with design DNA):
   - `search_sites` with free text and filters, e.g. `award: "sotd"` or `"soty"`, a tag or a technology. `list_categories` shows the filters.
   - `get_site_details` for palette, technologies, elements and awards.
   - `search_elements` / `get_site_elements` for single components.
   - `get_motion_dna` on the motion references (step 6b).
   - The npx install runs the core tools only; its browser tools may say they need Playwright. That is fine: captures are done with `shoot.mjs`.
   - Its index is a local cache that fills over time; if search is thin, use `get_collections` or `new_winners`, and lean on Inspo.
4. **The open web**, only if the three above leave a gap. Mark it `web` in SOURCES.md.

Use both MCPs for whatever the user did not supply. The gate checks the ledger for real Inspo and Awwwards tool calls, so a source word typed into SOURCES.md does not count. Each reference must be a different image: the gate rejects duplicates.

## The client's industry

At least 2 references must come from the client's own industry or an adjacent service business (a car-care brand, a home-services company, a subscription service people trust with their home or car). Mark them `industry` in SOURCES.md, e.g. `R02 | inspo | https://... | industry: home services | leads on: ...`. They show what customers in that market already expect; the other references raise the bar above it.

## Inspiration only: Dribbble and Behance

Concept shots (Dribbble, Behance, AI concepts) are often products that do not exist and carry the generic look this skill avoids, so they are never references. If the user likes one, or it shows an idea worth taking, save it as `I01`, `I02`... in `cook/refs/` with a line in SOURCES.md (`I01 | dribbble | <url> | idea: ...`). Inspiration images do not count toward the 9 to 12, are not used in side-by-sides, and never set the bar.

## Redesign: do not let the old design system filter the references

An existing DESIGN.md or brand book describes the site as it is, and a redesign is there to raise it. Before searching, ask the user which of its rules are binding (usually: logo, brand colours, token names, Arabic/RTL support, accessibility) and which are open to change (often: typeface, type scale, layout, photography, section patterns). Write their answer on an `Open to change:` line in BRIEF.md and record only the binding rules as `brand_constraints` in `cook/bans.json`, with their words. Search and pick references for the look, not for agreement with the old document; take open items from the references, not from DESIGN.md. (Inspo's own server notes say to follow a project's design system instead of searching: for a redesign whose goal is a better look, search anyway.)

## Capture them the same way the build will be captured

Every reference goes through `shoot.mjs` so references and build stills share viewport sizes and capture settings:

```bash
node <skill>/scripts/shoot.mjs https://example-reference.com --out cook/refs --name R01 --fold
```

This writes `R01-desktop.png`, `R01-mobile.png` and the first-screen `-fold` versions. If a site blocks headless capture, download the screenshot the MCP returned (Inspo and Awwwards give image URLs) as `cook/refs/R01.png` and note it in SOURCES.md.

Look at every capture at full size before using it. Cookie banners, empty lazy sections or a login wall make a bad reference: recapture (`--wait 2500`) or replace it.

## Files to write

`cook/refs/SOURCES.md` (one line per reference; the gate reads the source word and the URL):

```text
R01 | inspo | https://site-one.com/ | leads on: type ramp, hero density | ignore: dark mode
R02 | awwwards | https://site-two.com/ | leads on: section rhythm, imagery crops
R03 | user | brand site, supplied by the user | leads on: color, logo
```

`cook/SHOTS.md`: one row per reference. For UI, a shot is one screen state at one viewport.

```text
| Shot | Ref | Shows | Viewport | Take from it | Watch for |
|---|---|---|---|---|---|
| S01 | R01 | hero | desktop | 96px display type on a 12-col grid, one image bleeding right | our headline is longer: keep 2 lines max |
```

`cook/BRIEF.md` from `templates/BRIEF.md`. 40 lines max. The user's words verbatim on the `User's words:` line.

## Show the user and wait for their picks

Make a contact sheet and send it:

```bash
ffmpeg -y -i "cook/refs/R%02d-desktop-fold.png" -vf "scale=640:-1,tile=4x3" -frames:v 1 cook/refs/contact.jpg
```

(If file numbering has gaps, use cook's `side-by-side.mjs` with pairs instead.) Ask which ones to cut or replace. Their choice wins. Then `gate.mjs verify 1`.

Send the sheet to the user (in a non-interactive run, stop and hand it to whoever is acting for the user) and wait. Their picks beat yours. Record the approval in their words: `gate.mjs approve references --quote "..."`. If the set changes afterwards, show it again and get a new approval; the gate checks that the approval is newer than every file in `cook/refs`.
