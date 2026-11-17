# Keep, drop, change

Baseline: cook/baseline/ at commit [sha]. Written with the user. Quote their words wherever they said them.

## Keep

What must still work and be visible after the redesign. regress.mjs fails the round if any of it disappears.

- Contact form on /: Name, Email, Message, Send button. "The form has to keep working, it is how we get leads." (user)
- Nav: Home, Pricing, Docs, Log in. "Same pages, same order." (user)
- Mobile menu opens from the Menu button. (not yet said by the user: confirm before it goes here)

## Dropped

Removed on purpose. Every drop quotes the user's words. An item missing here that is missing from the site fails regress.

- Newsletter popup on /. "Get rid of the popup, nobody reads it." (user)

## Copy changes

Text that changes: old text, new text, and the user's words.

- Hero headline: "[old headline]" -> "[new headline]". "Say what we do in the first line." (user)

## Motion

One row per hit in cook/baseline/motion.json. Hashes are copied from that file.

| file:line | hash | functional/decorative | keep/replace/remove |
|---|---|---|---|
| src/components/Stats.jsx:4 | 3f2a9c1e | decorative | remove |
| src/hooks/useLazy.js:12 | 9d0b7a44 | functional | keep |
