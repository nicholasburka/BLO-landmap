# UX audit — phase 11, the set as an object

2026-10-14, after P11-1…P11-10. Measured in Chrome against the real library at
1440px and 375px, on the same principles as the P9 audits: the **Go / Show /
Write** vocabulary, navigability, coherence, and the responsive pass.

Four things were wrong. All four are fixed; three of them I had just built.

---

## What held

**Fill means consequence, still.** Across `/analysis`, and all three tabs of a
set, there is **exactly one filled control** — "New working set" — and it is a
write. P9-15's rule survived a phase that added three tabs, two scoped
surfaces and a chip.

**No horizontal overflow** on any new surface at 375px or 1440px, including
the Counties table at sixteen columns (it scrolls in its own box) and the
`kb-nav` strip (an intentional `overflow-x: auto`, not a defect).

**No heading inversions.** The set page runs h1 27.2 → h2 15.2 with nothing
out of order.

**Back works**, which is the thing P11-4 was for: it walks Map → Counties →
Datasets and steps out of an opened dataset into the list rather than out of
the set.

---

## 1. The set page said its own name three times

`h1` "BLO Livability Index v2", then "**Over** BLO Livability Index v2 · 11
layers", then a map pane titled "BLO Livability Index v2".

All three were right before P11-2, when the `h1` was the *view's* name —
"Livability index — play with it" over "BLO Livability Index v2" told you two
things. Making the page the set collapsed them into one thing said three
times, and I did not notice while making the change.

**Fixed.** The line under the title carries what it is actually for — the
counts, and a link to the set's **library entry**, which is a genuinely
different object from this working surface. The map pane falls back to naming
the layer it is *drawing*, which is the one thing on the page the headings do
not already say.

## 2. A scoped search showed library-wide counts

The facet chips under a search scoped to a set read **"source 17 · layer 1 ·
US EPA 15"** over a list of two. They are counted off everything the *query*
matched, across the whole library, and `narrowToSet` passed them through
untouched.

This is exactly the rule I cited in the commit that introduced it: a count
that disagrees with the list under it is the bug P6-23 named. Recounting
`matched` and not the facets was a half-measure.

**Fixed** by dropping the chips when a scope is on. Recounting them off the
narrowed set would be a second, differently-derived answer to "what is in this
set", and the set already answers that on its Datasets tab.

## 3. A scoped search that found nothing blamed the wrong thing

"Nothing matched — try fewer words, or ask in Chat" — under a chip saying the
search was confined to four datasets. The scope is almost always why, and the
copy sent the reader to fix their wording instead.

**Fixed.** Scoped: *"Nothing in **Redevelopment dashboard** matched that"*,
with a control that widens to the library. P9-3's rule — when something is
narrowing the answer, say so — applied to an empty state rather than a
disabled button.

## 4. Every tab bar in the product was a 34px touch target

The three tabs measured 34px high at 375px, under the 44px minimum.

A tab is the one control deliberately **not** `.blo-act` — it changes the URL
and already reads as a tab — so `base.css`'s phone rule never reached it. Two
components define `.tab-btn` separately, so this was wrong in both, and
pre-dates this phase.

**Fixed once, in `base.css`**, for the same reason P9-17 moved the other touch
rules there: a rule scoped to the page that needed it first is a rule every
later page misses. Scoped styles set no `min-height`, so one global rule
reaches all of them without fighting any.

---

## Not fixed, and why

**The scope chip wraps to three lines at 375px.** Its pill radius is for one
line, so it was reading as a blob; the radius drops to 10px on phones. The
wrapping itself stays — "Asking about / Redevelopment dashboard / ✕ Open the
set" is three pieces of information and a phone is 375px wide.

**Chat's transcript marks are session-local** (noted in P11-9's commit and in
the phase spec). Scope survives a reload through the URL; where it *changed*
does not. Persisting that needs a message kind the store does not have, and
half-building it would put a mark in the transcript that vanishes on reload —
worse than not having one, because a reader would learn to trust it.

**Two counties in the lookup have no name**, so the Counties table prints a
bare GEOID for them. They sort last now rather than first, which is what the
browser caught during P11-5. Naming them is a data fix, not a UI one.

---

## Gates

Client 2,421 / 2,421 across 113 files. Server 2,736 passed, 14 skipped, across
116 files. Both typecheck clean, run sequentially. Verified in Chrome against
the real library — including the `energy` set, which has no saved view and
before this phase could not be opened at all.
