# Phase 9 — one map, one set, cheap analysis

Written 2026-10-07 from Nick's framing: *the BLO Livability Index should itself
be a working set, so every working set can be inspected and toggled the same
way — and the new analysis machinery should then be able to feed back into the
index, to weight different factors and test how that changes the answer.*

This spec argues that is not a refactor but a **correction**: the index already
*is* a composite over layers, and the working-set surface already *has* the
public map's machinery. Two small, specific things stop it working.

---

## A. The thesis

**A layer is drawn as itself. A score is one layer among many, not the frame.**

Today the code holds the opposite assumption, and it is the cause of the UX
audit's blocking finding. `useShowOnMap.apply()`:

```js
const points   = ids.filter(id => pointDefinitions.some(l => l.id === id))
const scorable = ids.filter(id => !points.includes(id))
query.apply({ layers: scorable.map(layerId => ({ layerId, weight: 5 })) })
```

Every layer that is not a point becomes **a scoring term at weight 5**. So a
working set's transmission lines, pipelines and CEJST column are not missing
from its map — they *are* the red/green choropleth, folded into a weighted
index nobody asked for, with no legend to say so. Line geometry (P7-3) has no
branch here at all: the split predates lines existing.

Invert it and the rest follows:

| | today | proposed |
|---|---|---|
| point layer | overlay | drawn as itself |
| line layer | **scored as a county metric** | drawn as itself |
| county layer | scored | drawn as itself |
| a score | the frame everything collapses into | **a county layer, produced by a definition** |

A composite is already shaped to be a layer: P7-8 serves one as
`internal-<set>~<column>` through the ordinary internal-layer path, with no
client drawing code. The index is a *product* of layers that is itself a layer.

---

## B. The good news — most of this already exists

Worth stating plainly, because it changes the size of the work.

- **`MapPane` is a 167-line wrapper around `MapCanvas` (2,049 lines)** and it
  already takes `layers: MapLayerState` *from `useMapState()` — the same object
  the public map uses*. The workspace is not running a second map engine. It is
  running the same one, fed badly.
- **`BLO_PRESET` is already a composite definition.** `{ layerId, weight,
  direction }[]` against `CompositeTerm`'s `{ layer, weight, direction }` — the
  same shape under a different key name.
- **Registry layers are already composite terms.** P7-8 built
  `publicLayerValues.ts` precisely so the workbook's class-and-race indicators
  could be terms, because "arbitrary layers rather than the registry means the
  registry stops being the boundary, not that it stops being a source."
- **The public map already has the inspection UI** a set needs: `LayerControls`
  (toggling), `LensLegend` (legend, now with P7-10 dates per row), the picker.

So the work is mostly **wiring and deletion**, not new engine.

---

## C. One scale concept: a range is observed, then optionally pinned

Two earlier drafts of this section were wrong, and tracing the original script
is what corrected them.

**What `calculate_blo_v2_scores.cjs` actually does.** It computes observed
min/max for most terms and declares bounds only where the measure *has* natural
bounds:

```js
diversityIndex:     { min: 0, max: 1 },              // already an index
pctBlack:           { min: 0, max: 100 },            // a percentage
homeownershipBlack: { min: 0, max: 100 },
povertyRateBlack:   { min: 0, max: 100 },
blackProgressIndex: { min: 0, max: 100 },
lifeExpectancy:     getMinMax(allCounties, …),       // observed
contamination:      getMinMax(allCounties, …),       // a count — observed
avgWeeklyWage:      getMinMax(allCounties, …),       // dollars — observed
medianIncomeBlack:  getMinMax(…), medianHomeValue: getMinMax(…), …
```

And `layerRegistry.ts` carries those forward with a `unit` beside each:

| layer | unit | range | what it is |
|---|---|---|---|
| `diversity_index` | index | 0 – 1 | natural bounds |
| `pct_Black` | % | 0 – 100 | natural bounds |
| `life_expectancy` | | 65 – 87 | observed, rounded |
| `avg_weekly_wage` | | 300 – 3000 | observed, rounded |
| `blo_score_v2` | score | 1.15 – 3.28 | pure observed, untouched |

So **the registry's ranges are not declarations competing with observation —
they ARE observation, recorded and tidied.** 65–87 and 300–3000 are the
script's computed values rounded; 1.15–3.28 was not rounded at all.

### Therefore: one concept, not two modes

Every layer has a **range**. A range is **derived from the data by default**,
and may be **pinned** once someone has decided it. There is no `declared` vs
`observed` mode to choose between — observed is how you *get* a range, pinned
is what you do with one you want to keep.

Two things make pinning worth having, and neither is the "mutable manifest"
argument an earlier draft made:

1. **Stability.** A floating range means every reindex silently moves every
   historical score, and two people's indices are not comparable because they
   were scaled against different denominators. Pinning is what makes a
   published index citable.
2. **Natural bounds beat observation.** A percentage runs 0–100 whether or not
   any county reaches either end. If Black homeownership actually spans 30–55%,
   observed scaling stretches that to 0–100 and manufactures a dramatic
   gradient out of a narrow real range. That is an analytical distortion, not a
   cosmetic preference — and `unit: '%'` already tells us when it applies.

For a new index over a library layer with no range, derive observed, show it,
and offer to pin. Nobody hand-tunes anything unless they want to.

### The scores do not shift

An earlier draft claimed migrating the index would move published scores and
should be released as "v3". **That was wrong.** The ranges are the script's own
observed values; carry each layer's range forward and the arithmetic is
identical.

**Acceptance is byte-identical output:** re-derive all 3,144 county scores
through the unified path and match `public/datasets/precomputed/
combined_scores_v2.json` exactly. The public map's snapshots pass **unedited** —
if they do not, the migration is wrong, not the snapshots.

## D. The public index is a frozen export of a real set — decided

The public map works **logged out**, and working sets are internal-tier, so the
public map cannot fetch one at runtime.

**Decision (Nick, 2026-10-07): export a frozen copy, so the index is a true
working set people can play with.** The set is real and lives in the library
like any other; a build step writes a frozen snapshot of its definition and its
county values into the public bundle. `npm run export:layers` already does
exactly this job for the layer registry and the taxonomy, and the staleness
test that guards those extends to this.

That gives both halves: the public map stays a static, logged-out,
zero-dependency artifact, and the thing it draws is genuinely the same object a
logged-in user can open, re-weight and fork.

## E. Cheap analysis — our problem, not the reader's

The constraint is "truly near-zero $". What costs money is **model calls**, not
compute. 3,144 counties is nothing: most of this can run in the browser with no
request at all.

Analyses worth having, all expressible over layers we already hold:

| analysis | over | notes |
|---|---|---|
| weighted index | county layers | P7-8, exists |
| proximity | points → lines/points | P7-5, exists |
| rank / top-N / percentile | any county layer | client-side |
| distribution + outliers | any county layer | histogram; names the tails |
| correlation between two layers | county layers | one pass; **must show n and a scatter**, never a bare r |
| compare two indices | two composites | the "how does re-weighting change it" question |
| point-in-county rollup | point layer → county | done by hand for CEJST; generalise it |
| coverage / completeness | any layer | how many counties have a value |

Three of these answer the re-weighting question directly: **compare two
indices, rank movement between them, and correlation.**

### Where it runs is OUR problem

An earlier draft proposed telling the reader where each analysis runs and what
it costs. **That was wrong** (Nick, 2026-10-07): it is product and architecture
leaking onto the screen. A person presses the button and gets the answer.
Making it cheap is our job.

So the rule is the inverse:

- **Default to the browser.** County-scale work needs no server and no request.
- **If it is too heavy for a request, precompute it locally and store the
  result** — P7-5's local CLI pass and P7-6's stored results exist for exactly
  this. National transmission proximity should be *already computed* before
  anyone asks, not refused at the moment they do.
- **A refusal is a design failure, not a message to write well.** P7-5's "run
  this on the CLI" sentence is correct as a developer backstop and must never
  be what a reader sees.

What IS legitimate on screen is **progress** when something takes a few
seconds — that is feedback, not a cost disclosure, and the place report's
streaming progress (P6-16) is the house pattern.

## F. A wide table is a set someone else authored

Nick, 2026-10-07: *"CEJST sounds like it's basically a working set that someone
else authored elsewhere — with 28 columns."* That is the right reading, and it
suggests the bridge is a concept rather than a field.

CEJST is one file, 3,234 county rows, ~22 measures: the disadvantaged share,
eight burden categories, the redlining share, twelve indicator percentiles.
That is not "a dataset with a layer" — it is **a curated bundle of measures
over one geography**, which is exactly what a working set is. Somebody at CEQ
did the curation; we imported the result.

### The three nouns, if we get them right

- **Measure** — one number per geography. The atom. (Today: a "layer", which is
  overloaded, since it also means the drawn thing.)
- **Dataset** — a file. May carry many measures. CEJST carries ~22.
- **Working set** — a named selection of measures, plus derived columns and
  framing. The thing you open, toggle, re-weight and fork.

Then everything is the same shape:

| | measures from | composite |
|---|---|---|
| BLO Livability Index | the registry | `BLO_PRESET` |
| CEJST | its own 22 columns | CEQ's disadvantaged flag |
| a user's index | anywhere in the library | theirs |

### What that implies

A dataset should **declare its measures** — the plumbing previously called
`meta.layers[]`, probably better named `measures`. And a dataset that declares
several should be **openable as a set**, without anyone hand-assembling one.
Whether that is an auto-projected set or just "the dataset page gains the set
surface" is an implementation choice; the concept is that **there is one thing
you open and play with, and it is called a working set.**

This also explains why `meta.layers[]` felt like a blocker in phase 8 and only
half-explained itself: it is not a manifest convenience, it is **the mechanism
by which imported analysis becomes ingredients.** Without it the library offers
roughly fifteen ingredients; with it, hundreds.

**Open:** whether "measure" replaces "layer" in the vocabulary, or whether
layer keeps both jobs. Worth deciding before writing it, because the name ends
up in the manifest and manifests are hand-edited.

## Tickets

### P9-1 [BUG] A layer is drawn as itself — fix `useShowOnMap`'s binary split
Replace points-vs-scorable with a dispatch on the layer's declared geometry
(`county | point | line | state`). Nothing is auto-scored: a set's layers are
drawn, and scoring is requested explicitly. Line layers get a branch.
Fixes UX audit §1. **Size: S.** No data-model change, no server change.

### P9-2 [FEATURE] The working set's map gets the public map's controls
Give `MapPane` (or the workspace around it) `LayerControls` and the legend, so
a set's layers can be toggled and read. These are the public map's components,
passed the same `MapLayerState` the workspace already holds. Fit the viewport
to the set. **Size: M.** Depends on P9-1.

### P9-3 [FEATURE] Proximity and the index, on the analysis surface
Put both in `/analysis`'s grid and on the set, set-scoped. Each card states
cost and where it runs (§E). The over-ceiling case shows the CLI command rather
than failing. Fixes UX audit §2. **Size: M.**

### P9-4 [BUG] One scorer, not two
`usePersonalizedScore` and `composite.ts` compute the same thing twice. Unify
on one, honouring each layer's range (§C): derived by default, pinned where one
exists, natural bounds where `unit` says so. **Acceptance is byte-identical
output** — all 3,144 county scores match `combined_scores_v2.json` exactly and
the public snapshots pass unedited. **Size: M.** Blocks P9-5.

### P9-5 [FEATURE] The livability index as a set definition
One definition, one scorer. `BLO_PRESET` becomes a composite definition;
`usePersonalizedScore` and `composite.ts` stop being two implementations of one
idea. Acceptance: identical scores, public snapshots unedited, public map works
logged out. **Size: L.** Depends on P9-4 and §D.

### P9-6 [FEATURE] Fork an index and compare
Open the index, change weights, see the map move, save as a new set. Then
compare two indices: rank movement, biggest movers, correlation. This is the
payoff — the reason for the whole phase. **Size: L.** Depends on P9-5.

### P9-7 [FEATURE] The free-analysis set
Rank, distribution, correlation, coverage, point-in-county rollup (§E). All
client-side over county-scale data, no request. No cost disclosure anywhere in
the UI — progress only, and only where it is slow enough to need it.
**Size: M.** Independent of the map work — can run in parallel.

### P9-0 [FEATURE] A dataset declares its measures
Per §F. One file, many measures; a wide table becomes openable as a set. This
is what turns imported analysis into ingredients — CEJST goes from 1 usable
measure to ~22, and the library from ~15 to hundreds. Decide the vocabulary
first (§F, open). **Size: M.** Blocks P9-6 in practice: forking an index is
thin without things to fork with.

### P9-8 [BUG] Carried UX fixes from the audit
Entry pages stop printing raw JSON and the nine mis-nested manifests are fixed
(§3); gap flags lose warning weight and "needs a look" splits by reason (§4);
provenance and readiness move below the content (§5); shape derivation reads
the layer block's geometry so a line layer stops being "Records without a
location" (§10). **Size: M.** Independent.

---

## Sequencing

```
P9-1 ─► P9-2 ─────────────────┐
                              ├─► P9-6
P9-4 ─► P9-5 ─────────────────┘
P9-3   P9-7   P9-8   (parallel, independent)
```

**P9-1 and P9-2 first.** They fix the blocking audit finding, need no server
change and no data migration, and make the set surface honest before anything
is built on top of it.

---

## Answered (Nick, 2026-10-07)

1. **Frozen export of a real set**, not a build-time lookalike (§D). The index
   is a working set people can open and play with.
2. **Re-derivable.** The point is that anyone can build their own index from
   the datasets available — so there is one scorer and one mechanism (§C), and
   the BLO index is simply the one we happen to publish.
3. **Internal publishing only, for now.** A logged-in user can publish an
   authored, modified index; nothing public-facing yet.
4. **Where an analysis runs is not the reader's concern** (§E).

## Still open

- **`meta.layers[]` — how much does it gate?** A manifest declares ONE drawable
  column today, so the CEJST file contributes 1 ingredient out of 28 (the eight
  burden categories, the redlining share and twelve percentiles are all
  invisible to the map and unusable in an index). "Anyone can build an index
  from the datasets available" is a thin offer while the library exposes ~15
  ingredients instead of hundreds. It does not block P9-1 or P9-2; it probably
  should land before P9-6, or forking an index has little to fork with.
- **What happens to the old index values at the v3 cutover** — kept beside the
  new ones for comparison, or archived? P9-6's compare-two-indices makes the
  first option nearly free.
