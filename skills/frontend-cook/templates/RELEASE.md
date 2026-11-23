# Release checklist

Copy this to `cook/RELEASE.md` at step 8, then tick each item once its evidence exists. An item that does not apply is ticked with its reason: `- [x] n/a: <reason>`. The gate checks that every line starting with `- [` is ticked, and that the headings Content, Credits, Performance and SEO are all here.

## Content

- [ ] Final copy is in place on every page, with no lorem ipsum, placeholder names, or invented prices, addresses and phone numbers.
- [ ] Every language in `languages` (see `cook/GATES.json`) has its final copy, and each one reads correctly where it appears.
- [ ] Every link goes somewhere real: no `#` placeholders, no dead links. The audit's empty-link check is clean.
- [ ] Contact details, opening hours and prices are the client's own, confirmed by them.

## Credits

- [ ] `cook/CREDITS.md` lists every outside photo, font, icon and reference used.
- [ ] Each licence in `cook/CREDITS.md` allows this use: commercial, on this domain, with the credit where the licence needs one.
- [ ] Nothing from a reference was copied one to one.

## Performance

- [ ] Images are sized for their slot and compressed.
- [ ] Every image has width and height, so the page does not shift while it loads.
- [ ] LCP is measured on desktop and mobile (audit `perf.lcp_ms`), and it is under 4000 ms.
- [ ] Page transfer is under 3000 KB (audit `perf`), or the reason it is not is written here.

## SEO

- [ ] Every page has a title and a meta description.
- [ ] `<html lang>` is set, and `dir="rtl"` too for a right-to-left language.
- [ ] Every page has exactly one h1.
- [ ] Every informative image has alt text. Decorative images have an empty alt.
- [ ] A social preview image is set (Open Graph), or `- [x] n/a: <reason>`.
