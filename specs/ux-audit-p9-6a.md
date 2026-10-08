# UX audit — the weight editor, in a browser

2026-10-08. Chrome via Playwright, 1,440×900 unless stated, against the real
`blo-livability-index-v2` working set (eleven public layers, the published
formula) on a local API reading the real library bucket. Two real saves were
made; both are listed at the end.

This is the second pass. The [first](phase9-spec-one-map.md#p9-6a) found six
layout and correctness problems and they are fixed; this one is about what is
left once the thing works.

---

## What works, and is worth keeping

**The core loop delivers.** Press "Weigh it differently" on an index, drag a
slider, and the choropleth is your formula — 385px of map and the whole editor
visible together, no reload, no round trip. Saving writes a new column beside
the old one, draws it, and the comparison card appears in the same breath. The
eleven terms come back correctly named from the stored formula, with the
published weights (×4, ×6, ×2) and directions intact.

**The honesty furniture is right.** The orange "Showing an unsaved version of
X" band is impossible to miss; the layer list stops offering checkboxes that
would contradict the sliders; a dead-end control says why instead of greying
itself. Zero console errors or warnings across the whole session.

---

## 1. The comparison card shows the same artifact every time — **the big one**

"Moved furthest" is the card's payoff, and for **both** saved comparisons it
returned the same eight rows:

```
60010  #13   → #3166    3153 places
66010  #58.5 → #3211.5  3153 places
72003  #13   → #3166    3153 places
…
```

Every one is a **US territory** — American Samoa, Guam, the Northern Marianas,
Puerto Rico — and every one moves by the same ~3,150 places whatever you
re-weight. They are missing most of the eleven layers, and under
`missing: 'penalise'` (which this index uses) any change to the weights swings
them the length of the table. A reader asking "what did my re-weighting
actually do?" is shown eight places whose movement is a property of the missing
data, not of the formula.

It is structurally guaranteed to keep happening, so it is not a one-off.
**Ticketed as P9-6c.** The call — rank movers only among counties complete in
both, or flag incomplete ones, or both — is a research decision, not a tidy-up.

## 2. Counties were printed as bare GEOIDs — **fixed, with a caveat**

`72003 #13 → #3166` names nothing a reader knows. `IndexCompareCard` now
resolves names through `countyLookup` (a static file the map page has usually
already paid for, cached for the session) and prints "Aguada, PR".

**The caveat is the finding**: the lookup holds 3,142 counties and **no
territories at all**, so precisely the rows the card is currently showing are
the ones that cannot be named. The fallback prints the GEOID rather than
dropping the row. Fixing 1 would make this moot for the common case; the
lookup's coverage gap is worth knowing about on its own.

## 3. The map moves less than the feature promises

Removing an entire term from an eleven-term index repaints 10.5% of the canvas
with a **maximum channel delta of 20/255**. It is a real change and a correct
one, and it is nearly invisible. The headline promise — drag a weight, watch
the map move — is carried by a shift most people will not see.

The numbers are right there and would carry it: the two saves shifted scores by
a **mean of 10.8 points, max 95.3**. A live readout beside the sliders ("you
have moved 1,842 counties; the biggest mover is X") would make the feedback
legible without touching the map. **Ticketed as P9-6c** with 1, since both are
"say what changed in numbers".

## 4. Opening the editor has a visible delay and says nothing

`openEditor` awaits the internal layer manifest before seeding, so the terms
can be named rather than showing ids. On a cold pane that took **over a
second**, during which the button flips to "Close the weights" and nothing else
happens — long enough to press it twice and close it again, which is exactly
what happened during this audit. Either disable the button while it resolves or
show the rows immediately. **Ticketed as P9-6c.**

## 5. The page makes a claim that is not true

The view's description reads:

> The published index, as a set you can open, re-weight and fork. **Its
> composite reproduces `combined_scores_v2.json` exactly.**

It does not. Rank-correlating the stored column against the published file over
the 3,144 counties they share:

```
Spearman rho   : 0.9683
identical rank : 4 of 3,144  (0.1%)
```

Very close, and deliberately not identical — this is the drift P9-4 and P9-5
decided to keep, because the internal copy is the *more correct* one (it covers
3,215 counties to the published 3,144, and the published contamination term
counts absence as zero, which P9-9 still has open). The description was written
before those decisions and never caught up.

"Exactly" is the kind of claim someone will check. It should say what is
actually true and more interesting: *this is the published index recomputed
from the same formula on current data — close to the published scores
(ρ = 0.97) and deliberately not identical to them; see P9-9.*

This is a **content edit to a view in the library**, not a code change, so it
is left for a person rather than done here.

## 6. Accessibility — three gaps, all fixed

Good already: every slider and direction select carries an `aria-label` naming
its term, the editor has a heading, and everything is keyboard-reachable.

- The name field had **only a placeholder** — which disappears on input and is
  read inconsistently. Now has an `aria-label`.
- The disabled Save had **no link to the reason** it was disabled. Now
  `aria-describedby` points at it.
- The "showing an unsaved version" and "unsaved version from last time" banners
  were **silent to a screen reader**. Both are now `role="status"`, as is the
  save-blocked note — so dragging the last term out of a formula announces why
  Save went away instead of silently greying it.

## 7. Smaller things, not ticketed

- **Saving closes the editor.** Correct for one save, friction for a researcher
  saving three variants in a row — each one costs a reopen and the >1s wait of
  4. Worth revisiting if anyone actually works that way; not worth guessing now.
- **The derived-column method paragraph is a wall.** Accurate and genuinely
  useful ("…and 5 more; a county missing a layer is still divided by the full
  declared weight…"), but three indices on one set means three dense
  paragraphs stacked. A collapsed-by-default "how this was built" would keep
  the detail and the scannability.
- **Fractional ranks** read oddly — `#58.5 → #3211.5`. They are correct (tied
  counties share an averaged rank) and the alternative is worse. Leave them.

---

## Written to the real library by this audit

Two test columns on `blo-livability-index-v2`, both mine, both removable:

| id | label | what it is |
|---|---|---|
| `heavier-on-black-progress-test-save` | Heavier on Black Progress (test save) | Black Progress Index ×6 → ×10 |
| `no-property-tax-term-test-save-2` | No property tax term (test save 2) | Median Property Tax dropped |

There is no delete endpoint yet (**P8-2**), so removing them means editing the
set's manifest. They are harmless where they are — the set is explicitly the
"play with it" copy — but they are not research anybody asked for.
