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

## F. Measure and layer are different things — and the split is the set/view split

Nick, 2026-10-07: *"CEJST is basically a working set that someone else authored
elsewhere — with 28 columns"*, and *"separate measure and layer — that
separation maps between working set and view."*

That is the organising idea of this phase.

### The four nouns

| noun | is | lives on | example |
|---|---|---|---|
| **measure** | one number per geography, and what it means | a **working set** | "share of population in a disadvantaged tract", % , 0–100, lower is better |
| **dataset** | a file; may carry many measures | the library | the CEJST county table, ~22 measures |
| **layer** | a measure **as drawn** — colour, width, order, on/off | a **view** | that measure, orange, visible, on top |
| **view** | framing: viewport, which layers are on, how they look | presents one set | "Redevelopment dashboard, fit to the 11 sites" |

So: **a set holds measures; a view draws some of them as layers.** One set,
many views — which is P7-1's premise, now with a reason the two objects are
genuinely different rather than merely separate.

### This split is already latent in the code

`layerKeysOf`, the staleness fingerprint, hashes exactly:

```js
['geometry', 'file', 'latKey', 'lngKey', 'pathKey', 'geoKey', 'valueKey', 'labelKey']
```

— *where the data is and how to read it* — and deliberately excludes `color`,
`width`, `name` and `popupFields`. P7-8 called those "cosmetics" when it
refused to let a legend edit move a published index. **That is the measure/
layer boundary, drawn already, for a different reason.** Making it explicit
does not invent a distinction; it names one the code already enforces.

Today's `LayerBlock` conflates the two, which is why the working set stores
`layers: ["internal-transmission-345kv"]` — presentation data on a data object.

Three groups, precisely:

1. **Where the data is** — `geometry`, `file`, the key columns. Fingerprinted.
2. **What the number means** — `unit`, `direction`, `range`. Changes the score,
   not the bytes. **(1) + (2) = the measure.**
3. **How it looks** — `color`, `width`, `name`, `popupFields`. **= the layer.**

### What this buys: the view is the sandbox, the set is the record

Re-weighting is **exploration**, and it belongs in a view: instant,
client-side, free, nothing saved, nothing to clean up. The moment the answer is
worth keeping, you **save it to the set**, where it becomes a measure other
people can draw, cite and build on.

That is exactly Nick's "anyone can make their own index and test how
re-weighting changes the analysis", and it falls straight out of the split
rather than needing to be designed:

- open the index (a set) in a view
- drag weights — the map moves, no request, no cost
- like it? **Save as a measure** on a set. Now it is a layer anyone can draw.
- compare it against the one you forked from (P9-6)

### Then every index is the same shape

| | measures from | composite |
|---|---|---|
| BLO Livability Index | the registry | `BLO_PRESET` |
| CEJST | its own ~22 columns | CEQ's disadvantaged flag |
| yours | anywhere in the library | yours |

### Vocabulary decision (settled)

**"Measure" and "layer" are separate words with separate jobs**, and the
manifest says `measures`. `layer` stops meaning "a column of numbers" and means
only "a measure being drawn". A dataset declaring several measures is
**openable as a set**, so an imported wide table needs no hand-assembly.

This is what P8's `meta.layers[]` was reaching for and could not explain: it is
not a manifest convenience, it is **the mechanism by which imported analysis
becomes ingredients.** Without it the library offers roughly fifteen; with it,
hundreds.

## Tickets

### P9-0 [FEATURE] A dataset declares its `measures` — DONE
`meta.measures` is a list of the other columns a file carries. Each says only
what DIFFERS from the primary `layer` block — its column, and what that column
means; where the data is (file, geoKey, geometry, source, year) is inherited,
because it is the same file and repeating it would be two places to be wrong.

A measure is served as `internal-<slug>~<column>`, the **same id shape as a
set's derived column** (P7-8) — because it is the same idea, a value living
inside something else, and the client needed no new code to draw one. The two
are told apart by **the owner's kind**, not by the separator: a `working-set`
owner routes to the derived path, anything else to the measure path.

County-shaped only, deliberately: a point or line layer's extra columns are
popup fields, and calling them measures would promise a choropleth we cannot
draw from them.

Proved on the real CEJST file: nine measures declared, **12 → 21 internal
layers from one manifest edit**, and `pct_pop_redlined` reads back exactly
**213 counties** — the count of counties with any HOLC-scored tract, so
blank-is-not-zero survives from the rollup through the manifest to the API.

Remaining, and worth doing when someone needs it: the twelve `pctile_*`
columns are still undeclared, which would take CEJST to ~21 measures alone.
Per §F. One file, many measures; a wide table becomes openable as a set. The
mechanism by which imported analysis becomes ingredients — CEJST goes from 1
usable measure to ~22, the library from ~15 to hundreds. Vocabulary is settled:
`measures` in the manifest, `layer` reserved for a measure being drawn.
**Size: M.** Blocks P9-6 in practice — forking an index is thin without things
to fork with.

### P9-1 [BUG] A layer is drawn as itself — fix `useShowOnMap`'s binary split
Replace points-vs-scorable with a dispatch on the layer's declared geometry
(`county | point | line | state`). Nothing is auto-scored: a set's layers are
drawn, and scoring is requested explicitly. Line layers get a branch.
Fixes UX audit §1. **Size: S.** No data-model change, no server change.

### P9-1b [BUG] The canvas cannot take sources before the style loads, and nothing retries
Found while verifying P9-1, and **pre-existing** — the console showed
`Error: Style is not done loading` and `The layer 'county-choropleth' does not
exist in the map's style` before P9-1 touched anything. Applying feature layers
the moment the manifest lands (~800ms) throws, and there is no retry, so the
set's points and lines never draw even once they are classified correctly.

`MapCanvas` already polls for readiness (`isStyleLoaded()`, around line 371)
but the feature-layer path does not go through it. The state layer should stay
declarative — "these layers are on" — and the canvas should reconcile when it
can draw, rather than callers guessing when that is.
**Size: S.** Blocks the visible half of P9-1.

### P9-2 [FEATURE] The working set's map gets layer-by-layer display and toggling — DONE
`SetLayerList` names every layer the set holds, with its own colour, its
geometry and a checkbox, and toggles through the **same state the canvas draws
from** (`layers.toggle.points` / `.internal`).

Deliberately NOT `LayerControls`: that component carries fourteen emits and
the public map's categories, weights, filters and contamination with it. What
is worth reusing is the state and the toggle semantics, not the panel's
markup — a set's map should offer the set's layers and nothing else.

A layer the set names but the library has lost is **listed and labelled**, not
dropped (P6-23: a count may not disagree with the list it opens).

**Framing was investigated and left alone.** The subset already wins over a
layer's extent in the ordinary case, and the set's nine counties genuinely
span Arizona to Virginia — so a near-national view IS the correct fit here. An
earlier draft of this ticket called that a regression; it was not.

### P9-2b [BUG] `LayerControls` hand-wrote one row twelve times — DONE
839 lines, 22 props, 14 emits, and `class="layer-item"` twelve times. Six of
those were **byte-identical** once the array, the selection and the emit name
were normalised — the only remaining difference was `?.` optional chaining.
`LayerScoringControls` was already its own component; the shell around it was
not. `LayerRow` now owns that shell; LayerControls lost 119 lines and gained 60.

**Extracted, not parameterised.** A `mode="set"` flag is how a component
reaches 22 props and 14 emits in the first place.

**The styling trick that made it safe:** Vue applies a parent's scoped styles
to a child component's ROOT node, so `.layer-item` as `LayerRow`'s root keeps
being styled by LayerControls with nothing copied or kept in sync. Only inner
nodes — the label, the tooltip — needed `:deep()` in the host. Verified against
a DOM baseline captured before the change: 33 rows, `display: block`,
`margin-bottom: 10px`, label `margin-left: 5px`, tooltip `position: relative`,
all identical after.

**`SetLayerList` deliberately does NOT use it.** Its row is swatch-led with a
geometry label and no tooltip; routing it through `LayerRow` would mean two
optional props plus a scoped-style dance for one consumer whose row genuinely
differs. The place the two surfaces really converge is **P9-6**, when a set
needs weight controls — and what gets shared there is
`LayerScoringControls`, which is already a component.

The other six `layer-item` blocks (internal layers, point/line overlays,
contamination) keep their hand-written markup: their innards differ — links, a
text tooltip built from `description`, load-state and retry. They can migrate
as they are touched, and should not be forced now.

### P9-3 [BUG] A gated capability says why, instead of vanishing — DONE
**The audit was wrong about this one.** It reported proximity and the weighted
index as having "no UI at all". They have a full UI — forms, results, the lot.
They were **silently gated**: proximity needs `set.sites` (an anchor table) and
an index needs **two** county layers, and the test set had neither. A full-text
scan of the page found nothing because nothing rendered.

P7-5's comment said the control "is not there to be refused", which is right
when a reader cannot act on the reason and wrong when they can. Both of these
are properties of the set a reader can change, so the missing half is now
named — *"Measure proximity — needs an anchor table, the rows to measure
from"*, *"Build an index — needs two or more county layers to weigh against
each other"*. The two tests that asserted the old behaviour were updated with
the reasoning rather than quietly flipped.

One half stays silent on purpose: a set with no point or line layer has
nothing to measure TO, and that is not a precondition a reader can read off
the set — county choropleths are not places.

The page lede said "the four things you can run" while six exist.

Still open from the audit's §2 and §6: the set-scoped tools live in a run-on
line of plain text under a heading, while the four library-wide tools get
cards. That is the "working sets styled as a footnote" finding and belongs
with a visual pass, not here.

### P9-4 [BUG] Two research calls become settings, not constants — DONE
The two places the published index and the server disagreed turned out to be
**questions a researcher should answer per index**, not bugs to settle once
(Nick, 2026-10-08).

**How a county missing a layer counts.** `calculate_blo_v2_scores.cjs`
divides by the weight it HAS, scoring a county on its available data;
`computeComposite` divided by the FULL declared weight, so an absent layer
drags the county down as though it scored zero. Roughly two thirds of US
counties are missing at least one of the eleven BLO terms, so the two answers
are far apart — and both are defensible. Now `missing: 'penalise' | 'ignore'`,
defaulting to `penalise` (the prior behaviour), stored with the result and
surfaced on the run, so a number reads back as *this index, under these
rules*.

**Which span a term scales against.** Per-term `scale: 'pinned' | 'observed'`.
Contamination is the live case: the published script scaled it against the
observed spread of site counts while the registry pins 0–500. Absent means
"pinned if the layer pins one", so nothing changes for a term that says
nothing. `scale` is part of the FORMULA — `canonicalTerms` carries it and
`sameTerms` compares it, because a definition that lost it would re-run
against a different denominator and quietly produce different numbers.

**Still not one module.** The API deploys from `server/` and cannot import
from `../src`, so the Lens and `composite.ts` remain two implementations of
one algorithm — the boundary that made P7-5 hand-write its great-circle maths.

**And the reproduction is now a configuration, not a migration.** Matching the
published index means running it with `missing: 'ignore'` and contamination
at `scale: 'observed'`. Worth doing as the proof, and no longer a blocker:
nothing has to change for the published numbers to be reproducible, because
the rules that produced them are now expressible.
**Done: the two now agree.** A composite term may carry a pinned range, and
`spanOf` prefers it over the observed span. Registry terms take their range
from the registry — the same literals `calculate_blo_v2_scores.cjs` computed
and rounded — so the server and the Lens produce the same number from the same
weights. Held layers take theirs from the manifest's `layer` block, or from
the matching `measures` entry (P9-0), and fall back to observed when nothing
is pinned. A pinned `min === max` says nothing and is ignored rather than
dividing by zero. Each scale records **which span it used**, because "what
does 100 mean" has a different answer for a pinned term and an observed one.

**It also unblocked measures as ingredients.** P7-8 refused every
`<owner>~<column>` id as "an index over an index" — correct for a working
set's derived column, wrong for one of a file's measures, which is a plain
column with an ordinary staleness story. The refusal now asks the owner's
kind, the same way `readInternalLayerValues` routes. Without this, P9-0 made
CEJST's nine burden categories layers that no index could use.

**Not done: there is still one implementation per side.** The API deploys from
`server/` and cannot import from `../src`, so "one scorer" cannot mean one
module without a shared package — the same boundary that made P7-5 hand-write
its great-circle maths rather than use turf. What exists now is one *algorithm*
agreeing across two implementations, proved by a test that a registry term
scales against the registry's pinned 0–100.

**Still owed, and it is the real acceptance test:** reproduce all 3,144
`combined_scores_v2.json` values through the server path. Two known obstacles —
`BLO_PRESET` includes `contamination`, which the Lens computes from a
contamination count map rather than a registry layer; and the missing-data
divisor needs checking term by term. Until that runs, "the scores do not
shift" is argued from the ranges being the same literals, not demonstrated.
`usePersonalizedScore` and `composite.ts` compute the same thing twice. Unify
on one, honouring each layer's range (§C): derived by default, pinned where one
exists, natural bounds where `unit` says so. **Acceptance is byte-identical
output** — all 3,144 county scores match `combined_scores_v2.json` exactly and
the public snapshots pass unedited. **Size: M.** Blocks P9-5.

### P9-5 [FEATURE] The livability index as a set definition — PARITY PROVEN
**3,144 of 3,144 county scores reproduced exactly**, max delta 0.0000.
`src/config/bloIndexV2.ts` is `calculate_blo_v2_scores.cjs` written as data,
and `server/src/services/compositeParity.test.ts` asserts the reproduction
against the published file's own `raw` values — so it tests the arithmetic,
a data refresh cannot break it, and a change to the scorer will.

The configuration that does it, and all three parts were needed:

1. **`missing: 'ignore'`.** Under `penalise` only 1,360 of 3,144 reproduce.
   The test asserts the wrong rule FAILS, so the right one is proving
   something.
2. **A MIX of spans, not a policy.** Five terms have natural bounds (0-1,
   0-100) and six are money, years and counts taking the data's own spread.
   All-pinned gave 1/3144; all-observed gave 6/3144.
3. **The script's weights exactly.** `BLO_PRESET` says it mapped percentages
   "roughly"; every one is exactly ×40, and weights are relative, so it is
   the same formula.

**A correction to §C.** The registry's ranges are NOT the script's observed
values rounded: `life_expectancy` is 65–87 there against 69–89.5 in the data,
`avg_weekly_wage` 300–3000 against 601–4514. Close enough to look like
roundings, far enough to change the answer — which is why the definition pins
its own spans rather than borrowing the registry's.

**The spans are pinned, not recomputed, on purpose.** Recomputing would mean
every data refresh silently moved every historical score and two vintages of
the index would not be comparable. These are the spans the published numbers
were made with: a property of THIS index, not of today's files.

**The index exists internally as a real working set.** `blo-livability-index-v2`
holds the eleven registry layers, its composite carries the full definition
(weights, directions, per-term spans, `missing: 'ignore'`), and
`/views/livability-index-play-with-it` opens it. The public bundle is
deliberately untouched (Nick, 2026-10-08) — the published map keeps the
compiled index, and this is the copy you can re-weight and fork.

**Recomputing it live does NOT give the published numbers, and the reason is
not the formula.** Median delta 0.0024 on a 0–5 scale, worst 0.528. Two causes,
both verified rather than assumed:

1. **Absent contamination means ZERO in the script, MISSING in the service.**
   `contamination ? contamination.total : 0` — a county with no EPA record
   scores that term at its best. The service drops it from the divisor
   instead. The file covers 2,482 of 3,144 counties, so **662 counties**
   diverge, and that is where every large delta is.
2. **The data was corrected after publication**, not refetched: commit
   `68a77fd "Data: fix 10x population inflation in diversity CSV"`. `pct_Black`
   for 01001 is 21.406 in the published scores and 20.990 today. That accounts
   for the small median delta across the rest.

**Both differences are improvements, so the internal set keeps them** (Nick,
2026-10-08). Counting an absent EPA record as zero sites is wrong, not a
convention; and the corrected diversity data is simply better data. The
internal working set is therefore **the more correct index**, and the
published `combined_scores_v2.json` is a vintage carrying a known defect.

The parity test stays exactly as it is. It feeds the published file's **own**
inputs, so it pins the FORMULA and is unaffected by either improvement — which
is what makes it safe to improve the data without losing the ability to detect
a change in the arithmetic.

Patching the public index is deferred, tracked as **P9-9**.

**Remaining:** the frozen export (§D) — creating the
working set whose composite is this definition, and the build step that
writes its values into the public bundle. The hard part, proving the numbers
survive the move, is done.
One definition, one scorer. `BLO_PRESET` becomes a composite definition;
`usePersonalizedScore` and `composite.ts` stop being two implementations of one
idea. Acceptance: identical scores, public snapshots unedited, public map works
logged out. **Size: L.** Depends on P9-4 and §D.

### P9-9 [BUG] A county with no EPA record scores as if it had no contamination
**Affects the PUBLISHED index.** Deferred by Nick on 2026-10-08 — noted now,
fixed later.

`calculate_blo_v2_scores.cjs:151` reads

```js
contamination: contamination ? contamination.total : 0,
```

so a county absent from the contamination file is scored as **zero sites**,
which on a `lower_better` term is the best possible value. The file covers
**2,482 of 3,144 counties**, so **662 counties** are being credited with a
clean environmental record they have not been shown to have.

Absence of an EPA record is not absence of contamination. This is the same
class of error as the RE-Powering reporting bias in
`library-staging/download/FINDINGS.md` — Wisconsin has 33,779 brownfield
records and Tennessee 421, which measures state reporting rather than
contamination — and it bites harder here, because the missing value is
silently replaced with the most favourable one rather than left out.

**Do:** treat an absent record as missing, which is what the composite path
already does, and regenerate the published scores. Expect county-level moves:
the live recomputation differs by up to 0.53 on a 0–5 scale, concentrated on
exactly these counties. Worth saying publicly which counties moved and why,
rather than quietly reissuing.

**Size: S** to fix, and the regeneration is a decision about publishing, not
a technical problem.

### P9-6 [FEATURE] Fork an index and compare — COMPARISON DONE
**Forking needs no new mechanism.** A set holds up to 24 derived columns
(`DERIVED_COLUMNS_MAX`), so two indices over the same ingredients with
different weights are simply two columns on one set. P9-4 and P9-5 made the
definition carry everything that distinguishes them — weights, directions,
per-term spans, the missing-data rule — so a fork is a second `POST
/composite` with a changed definition, and `sameTerms` already refuses to
confuse the two.

**`src/lib/indexCompare.ts` answers the actual question**, which is not "are
the numbers different" (they always are) but **did the ordering change, and
for whom**:

- **Spearman rank correlation**, with proper tie handling — tied counties
  share the average rank, and without that the statistic is quietly wrong for
  any index built from banded layers, which is most of them.
- **`n` always**, because two indices agreeing across four counties is not
  evidence. Null rather than a number when it would be meaningless: too few
  shared counties, or one side with no spread to order.
- **The movers**, furthest first, with both ranks — the counties a re-weighting
  actually moved.
- Ranks are computed **within the shared set**, so an index covering more
  ground is not thereby better correlated.

Pure and client-side: 3,144 counties costs no request and no money (§E).

**Proved on the real pair** — the published index against the corrected one:
`n=3144, Spearman 0.9683`. Close agreement on order, with individual counties
moving **over a thousand places**: 48311 McMullen TX 702 → 1775, 48109
Culberson TX 1450 → 455, 16033 Clark ID, 02066 and 02164 in Alaska. All tiny,
sparse-data counties — exactly where P9-9's contamination-as-zero and the
diversity fix bite hardest. The statistic says "these broadly agree"; the
movers say "and here is who it does not agree about", which is the pair a
researcher needs.

**`IndexCompareCard` shows it on the set's view**, when the set holds two or
more index columns. Both columns' values are already in memory, so it fetches
nothing and recomputes on every change of selection.

Never a bare coefficient: the words, the number and the count it is over, or
nothing. *"Almost the same ranking — 0.97 across 3,144 counties they both
cover"*, then the counties that moved furthest with both their ranks. A
correlation is a number most readers cannot place, and the judgement is the
point.

**Remaining:** a weight editor — changing weights in the view and saving the
result as a second index. Today a fork is a second `POST /composite` with a
changed definition, which is right but not yet reachable from the page.
Open the index, change weights, see the map move, save as a new set. Then
compare two indices: rank movement, biggest movers, correlation. This is the
payoff — the reason for the whole phase. **Size: L.** Depends on P9-5.

### P9-6a [FEATURE] Wire the weight editor into the set's view
`IndexWeightEditor` is built and tested (8 cases) but connected to nothing.
Connecting it is not one step, and the questions below are why this is a
ticket rather than a loose end.

**Where the terms come from.** A set with an index already has a formula —
the `analysis.terms` on its derived column — and that is what to edit. A set
with county layers and no index yet has candidates but no formula: offer its
indexable layers at an equal starting weight, or require an index first?
Equal weights is a real formula and a bad default, because it looks
considered and is not. Leaning toward: edit an existing index, and send a set
without one to "Build an index" (P9-3's path), so there is exactly one way to
make the first formula.

**What the map shows while dragging.** The editor emits a scoring query; the
canvas can draw it immediately. But the set's SAVED index is also a layer,
and both on at once is two choropleths arguing. Proposal: dragging replaces
the drawn index with the live preview, and the layer list says so — "showing
an unsaved version" — because a reader must never mistake a preview for the
record.

**What a save does.** `POST /composite` with the formula, then the new column
has to appear in `columns` without a page reload, and probably become the
drawn layer. Whether it also becomes the compared-against default in
`IndexCompareCard` is a smaller call that follows.

**What happens on leaving.** An unsaved preview is lost, which is correct —
but silently losing a formula somebody spent five minutes on is not. Either
warn, or do not let the preview outlive the page in a way that feels like
state.

**Size: M.** Depends on nothing; everything it needs is built.

### P9-6b [BUG] The client test suite has its own contention flake
`App.spec.ts`'s "gives an internal user a Help button beside Search" failed
on two separate full runs today, passed alone twice each time, and passed on
the immediately following full run. It is not new and it is not P9's.

P7-11 proved the SERVER suite's flakes were detached writers outliving the
test that armed them, and fixed them to 20/20. The client suite has never had
that treatment. The known leads are in `project-natl-map-test-gotchas`: the
jsdom suite makes real network calls to `localhost:3001`, so behaviour
depends on whether a dev server is up.

A suite that fails one run in three teaches people to re-run rather than to
read, which is how a real failure gets waved through. Worth the same
treatment the server suite got: find the mechanism, prove it with twenty
consecutive clean runs, do not paper it with a retry.
**Size: M.**

### P9-7 [FEATURE] The free-analysis set
Rank, distribution, correlation, coverage, point-in-county rollup (§E). All
client-side over county-scale data, no request. No cost disclosure anywhere in
the UI — progress only, and only where it is slow enough to need it.
**Size: M.** Independent of the map work — can run in parallel.

### P9-8 [BUG] Carried UX fixes from the audit
Entry pages stop printing raw JSON and the nine mis-nested manifests are fixed
(§3); gap flags lose warning weight and "needs a look" splits by reason (§4);
provenance and readiness move below the content (§5); shape derivation reads
the layer block's geometry so a line layer stops being "Records without a
location" (§10). **Size: M.** Independent.

---

## Sequencing

```
DONE: P9-0 ─ P9-1 ─ P9-1b ─ P9-2 ─ P9-2b ─ P9-3 ─ P9-4 ─ P9-5 ─ P9-6 (maths + compare UI)

next:  P9-6a  wire the weight editor      ← the payoff becomes usable
       P9-8   carried audit fixes          (independent)
       P9-7   free analyses                (independent)
       P9-6b  client suite flake           (independent, and quietly expensive)
       P9-9   contamination                (deferred by Nick)
```

**P9-6a first.** Everything it needs is built and tested; until it is wired,
the weight editor exists and nobody can reach it.

## Answered (Nick, 2026-10-07)

1. **Frozen export of a real set**, not a build-time lookalike (§D). The index
   is a working set people can open and play with.
2. **Re-derivable.** The point is that anyone can build their own index from
   the datasets available — so there is one scorer and one mechanism (§C), and
   the BLO index is simply the one we happen to publish.
3. **Internal publishing only, for now.** A logged-in user can publish an
   authored, modified index; nothing public-facing yet.
4. **Where an analysis runs is not the reader's concern** (§E).
5. **Measure and layer are separate words**, and that separation is the
   working-set/view separation (§F). A set holds measures; a view draws some of
   them as layers.

## Still open

- **How far does the measure/layer rename reach?** `LayerBlock` conflates both
  today (§F). The manifest gains `measures`; whether the internal layer
  manifest, `MapLayerState` and `LayerControls` are renamed with it, or keep
  saying "layer" because at that point they genuinely mean the drawn thing, is
  a judgement to make while writing P9-0 rather than before.
- **Does a measure need a stable id across datasets?** If CEJST's
  `pct_pop_energy` and a future EJScreen equivalent are both "energy burden",
  comparing two indices built on different sources needs either a shared id or
  an explicit mapping. Not a blocker; it is the question that arrives the first
  time someone forks an index onto different data.
