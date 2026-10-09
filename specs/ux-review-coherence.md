# UX review — does it feel like one product?

2026-10-09, after P9-13/P9-14. Chrome at 1440×1000, dev server, logged in,
nine surfaces: `/kb`, `/analysis`, `/datasets`, `/docs`, `/place`, `/compare`,
`/new`, a library entry, a working set's workspace.

"Feel" is not measurable, so I measured the things that produce it: every
interactive control's computed appearance (background, colour, border, size,
weight, radius, padding), every heading's size and weight, and which pages
carry the global nav. Claims below are counts.

**Verdict: individual pages read well; the app does not yet read as one
app.** The page title changes size four times depending where you are, there
are 24 distinct button appearances, and — the one that matters most for
Nick's question — **the most visually prominent control in the product is a
navigation, while the control that writes to the shared library is one of the
quietest.**

---

## 1. Prominence is inverted — **the one to fix first**

Nick asked whether important actions show up as important. Measured, they do
the opposite.

| Control | What it does | How it looks |
|---|---|---|
| **Open the place report** | navigates to a page | solid black, 13px/600, 6×18px padding |
| **Browse the tables we hold** | navigates to a filtered list | solid black, 13px/600, 6×18px padding |
| **Save as an index** | **writes a column to the shared library** | green, 12px/600, 2×8px padding |
| **Run again** | **recomputes server-side, rewrites a stored column** | green, 12px/600, 2×8px padding |

The two heaviest controls in the app are the two with the least consequence:
you can press them all day and nothing changes. The two that change stored
data for everybody are roughly a third of the visual weight.

This is my doing and it is one day old. P9-13 gave *Write* a solid green
treatment — correct in isolation — without reconciling it against the solid
black `tool-start` that already existed. So the product now has **two
"primary action" looks**, and the heavier one means less.

## 2. The page title is four different sizes

| Page | `<h1>` |
|---|---|
| `/kb`, `/place`, `/compare` | 28px / 400 |
| `/analysis`, `/datasets`, `/docs` | 27.2px / 500 |
| a library entry | 25.6px / 500 |
| a working set's workspace | **22px / 400** |

Nothing distinguishes these pages in importance — they are all top-level
destinations — so the variation reads as drift rather than as hierarchy. The
workspace, which is the deepest and densest page in the product, has the
smallest title.

And on the workspace the hierarchy actually inverts: an `<h3>` at **15.2px**
sits among `<h2>`s at **14px and 13px**. The subheading is bigger than the
heading above it.

## 3. Twenty-four distinct button appearances

Across nine pages. Some of that is legitimate — a filter chip should not look
like a submit — but 24 is more vocabulary than anyone can hold, and the
distribution shows the problem is the long tail: the top three looks account
for 94 uses, the remaining 21 looks for about 30. Most of those 21 appear on
one page each.

Per page, the newest surface is the most fragmented:

| Page | distinct button looks | distinct panel looks |
|---|---|---|
| `/kb` | 2 | 3 |
| `/analysis` | 2 | 2 |
| `/datasets`, `/docs` | 4 | 0 |
| a library entry | 5 | 1 |
| **the workspace** | **7** | **4** |

The workspace is where five features landed in a week, each bringing its own
styling. That is exactly how 24 happens.

## 4. The deepest pages are the only ones you cannot navigate from

Seven of nine surfaces carry the global nav — *Datasets · Docs · Analysis ·
Search · Chat · New*. **Two do not: a library entry, and a working set's
workspace.** They offer a single contextual back link and nothing else.

Those are the two pages a researcher spends the most time on. From a
workspace you cannot reach Datasets, Docs, Search, Chat or New at all; you
must go back to `/analysis` first and start again. The contextual back link
(`← Analysis` / `← Datasets`, depending where you came from) is a nice touch
and should stay — but it is one step of history, not navigation.

## 5. An unstyled control survives on `/new`

A `<select>` rendering at Chrome's UA default of **13.3333px** — the same
defect I fixed in the analysis card yesterday, still present on another page.
One fix per component does not hold a system together; this is the argument
for the shared vocabulary doing the work instead.

## What is genuinely good

- **`/kb` and `/analysis` are tight**: two button looks each, clear hierarchy,
  nothing competing. `/analysis` in particular now reads well — seven cards,
  four with a solid control and three visibly secondary because they are
  gated. A reader can see at a glance which ones they can act on.
- **The overlay panels on the map share one tier** (`.blo-panel--reference`)
  and read as a family rather than as two separate widgets.
- **The contents strip does its job** — three destinations, quiet, above the
  map.
- **Shape and kind chips are consistent everywhere** and genuinely answer
  "what sort of thing is this".
- **The cream/green palette is coherent across every page.** The problem is
  never colour; it is size, weight and prominence.

---

## The approach

### 1. Prominence follows consequence (**S, do first**)

One primary look, and it belongs to the most consequential control on the
page — which is almost never a navigation. Concretely: `tool-start` stops
being solid black and becomes a bordered link-button; `.blo-act--write` keeps
the solid fill and grows to match the size `tool-start` had. A reader should
be able to scan any page and find the thing that changes something.

This also retires the two-primaries problem, because there would be one.

### 2. One type scale (**S**)

A page title is one size and weight everywhere. Fix the workspace's inverted
`h2`/`h3` while there. No new tokens — `base.css` already has the palette and
the panel tiers; it needs the same for type.

### 3. The global nav goes on every internal page (**S**)

Add `KbNav` to the library entry and the workspace, keeping the contextual
back link above it. Two components, one line each.

### 4. Then prune the tail (**M**)

With 1–3 done, sweep the remaining one-off button looks into `.blo-act` /
`.blo-act--write` / chip, starting with the workspace's seven and the stray
`<select>` on `/new`. This is last on purpose: it is the biggest and the
least valuable, and doing it before the rules exist would just re-create the
tail in a different shape.

**1–3 are each an hour or less and would carry most of the "does it feel like
one product" weight.** 4 is housekeeping that gets easier once they are done.

---

## Found while doing P9-15/16/17, not acted on

Two things turned up under measurement that are real but outside what the
three tickets authorised.

### Every internal page has two `<h1>`s
`App.vue` renders the site title as an `<h1>` ("BLO Knowledge base" inside the
library, "U.S. Livability Index" outside it), and each page then renders its
own. Measured on `/datasets`, `/library/:slug` and `/views/:slug`: two `h1`
elements, the site's at 22.4px *preceding* the page's at 27.2px.

A screen-reader user asking "what is this page?" gets the site's name first.
This is **pre-existing and app-wide** — `/datasets` has carried `KbNav` since
P6-13 and shows it too — so P9-16 did not introduce it, which is the only
reason it is a note rather than part of that fix. The site title wants to be a
`<p>` or a `<span>`, or the page titles want to be `<h2>`; either is a
one-line change and a decision about the whole app, so it should be its own
ticket rather than a side effect of a nav fix.

### `CountyRail` still has a solid-green "act on this county"
`CountyRail.vue:951` describes a solid-green affordance chosen "so it visually
outweighs" its neighbours. That is the public map's own design language, on a
public-facing surface, and Nick asked specifically about not regressing the
public map's styling — so it was left alone. Worth deciding deliberately
whether `.blo-act--write`'s "fill means consequence" rule governs the public
map too, or whether the public map is explicitly a second vocabulary. Right
now it is neither, which is how `tool-start` happened.
