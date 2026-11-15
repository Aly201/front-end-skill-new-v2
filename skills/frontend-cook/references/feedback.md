# Step 7: specific feedback

Vague feedback gets vague fixes. Every change request must point at an exact place and an exact change, and must close with a still that proves it.

## Describe your own work: `cook/SECTIONS.md`

After every round, write the build section by section, so the user (and you) can point at things by name:

```text
## S1 Hero (desktop 0-900px, mobile 0-1200px)
Built: 2-line headline, Fraunces 96/92px, -0.02em; sub-line 20px, max 52ch; one button; photo bleeds right edge, 60% width.
Taken from: R01 (type), R04 (photo crop).
Weak spot: on mobile the photo goes below the button and the first screen is text only.

## S2 Proof strip
...
```

Section ids (S1, S2...) are what feedback refers to. The gate checks that SECTIONS.md is newer than the latest source change, and that every inbox line names a section that exists in it.

## Turn every remark into an inbox line

In `cook/ROUNDS.md` under "User feedback inbox", with the user's exact words and your precise reading of them:

```text
- 14:20 "the hero feels cramped" | S1 desktop: headline-to-button gap 24px -> 48px, sub-line max 52ch -> 44ch | round 4 | open
- 14:20 [annotated screenshot: red box around pricing cards] | S5: cards same height, price 40px semibold, remove card shadows | round 4 | done, proof: cook/stills/r04/S05-desktop.png
```

- Close an item only as `done, proof: <path>` to a still taken after the fix. The gate checks the file exists.
- User feedback comes before judge gaps in the next round's focus.
- No feedback at all does not pass. Send the stills and SECTIONS.md and ask. If the user says they want no changes, record their words: `gate.mjs no-feedback --quote "..."`.

## When the user cannot say what is wrong

"Something feels off about the middle." Do not guess and change five things. Describe in plain words how that part was built, from SECTIONS.md, short:

> S3 is a 3-column grid, each column an icon, a 20px title and two lines of grey 16px text, 96px padding above and below. It follows R02's spacing but not its type.

Then ask which part bothers them. They now have the words.

## Annotated screenshots

When the user marks up a screenshot, restate every mark as a line item with the section id and the exact property change, before changing code. If a mark is ambiguous, ask about that one mark only.

## Feedback that would lower quality

"Make the logo bigger", "add more colors", "put everything above the fold". Do it if they insist, but first, once, say what it costs and offer the better option (`pushback.md`). Then do it well.
