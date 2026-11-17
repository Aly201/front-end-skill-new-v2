# Keep, drop, change

Baseline: cook/baseline/ at commit [sha]. Written with the user. Quote their words wherever they said them, in double quotes.

## Keep

What must still work and be visible after the redesign. regress.mjs fails the round if any of it disappears.

- Contact form on /: Name, Email, Message, Send button. "The form has to keep working, it is how we get leads."
- Nav: Home, Pricing, Docs, Log in. "Same pages, same order."
- Mobile menu opens from the Menu button. (not yet said by the user: confirm before it goes here)

## Dropped

Removed on purpose. An item missing here that is missing from the site fails regress.

Each line needs a quote of 8 or more characters that the user typed, in double quotes. One broad quote may cover several lines. Name the item exactly, in double quotes or backticks. A page or link drop names its path, such as `/blog`; that also covers the pages under it.

- "Newsletter popup" on /. "Get rid of the popup, nobody reads it."
- `/blog` (page). "Drop the blog, we do not post there any more."

## Copy changes

Text that changes. Each line is written `old -> new`: only the old text on the left is matched, so quote it exactly. Each line also needs the user's words in double quotes, as for Dropped.

- Hero headline: "Old headline text" -> "New headline text". "Say what we do in the first line."

## Motion

One row per hit in cook/baseline/motion.json. Hashes are copied from that file (12 hex characters each).

| file:line | hash | functional/decorative | keep/replace/remove |
|---|---|---|---|
| src/components/Stats.jsx:4 | 3f2a9c1e0b7d | decorative | remove |
| src/hooks/useLazy.js:12 | 9d0b7a44c1e2 | functional | keep |
