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

## C. The one hard problem: two scorers, two numbers

`composite.ts` states the divergence in its own header:

> *"The scale comes from the data, never from a declared range. The Lens
> normalises a registry layer against `LAYER_REGISTRY[id].range`, a literal."*

| | client Lens | server composite (P7-8) |
|---|---|---|
| scale source | `LAYER_REGISTRY[id].range`, declared in code | observed min/max in the data |
| missing data | divides by the full declared weight | same (deliberately matched) |

Same weights, same directions, **different output**. So "make the index a
working set" naively **changes published livability scores**, and the public
map's byte-for-byte snapshots will catch it — which is the system working.

### Proposed resolution

Give a composite an explicit **`scale`**: `'observed'` (default, P7-8's rule) or
`'declared'`, which reads each term's registry range.

P7-8 rejected declared ranges for a stated reason — a declared `range` lives on
a **mutable manifest**, is excluded from the staleness fingerprint as cosmetic,
and would let someone move a published index by editing a legend. That
objection is exact and it **does not apply to the registry**: `LAYER_REGISTRY`
is version-controlled code, reviewed, committed and covered by
`publicLayerValues`'s own fingerprint. A code literal is not mutable at runtime.

So: `scale: 'declared'` is permitted **only** for terms whose range comes from
code, and refused for library layers, where P7-8's reasoning stands untouched.
The livability index pins `declared` and its numbers do not move.

**Acceptance is numerical, not visual:** the migrated index must reproduce
today's scores for all 3,144 counties exactly, and the existing public-map
snapshots must pass unedited.

---

## D. The auth boundary — an open question, not a decision

The public map works **logged out**. Working sets are internal-tier
(`requireInternalUser` guards every `/api/working-sets/*` route), and the
catalog needs Postgres. So "the index is a working set" cannot mean the public
map fetches a working set.

Two candidate shapes, and I do not think this should be decided in a spec:

1. **Build-time artifact.** The public index stays what it is — registry plus
   preset, compiled into the bundle — and the *set object* is its internal
   mirror, generated from the same source so they cannot drift. Public map
   unchanged, zero risk, but "the index is a set" is then true by construction
   rather than at runtime.
2. **Published set.** A set can be marked public; a frozen copy of its
   definition and values is exported to the public bundle at build time by
   `npm run export:layers`, which already does exactly this job for the
   registry and the taxonomy.

(2) is the honest version of Nick's idea and reuses an existing mechanism.
(1) is a week cheaper. **This is the main question I want answered.**

---

## E. Near-zero-cost analysis — what qualifies

The constraint is "truly near-zero $". The thing that costs money is **model
calls**, not compute. So the line to draw is not cheap/expensive, it is:

- **Free, unlimited** — pure compute over bytes we already hold. 3,144 counties
  is nothing; much of this can run in the browser with no request at all.
- **Metered** — anything calling a model (Ask, remediation, inferred metadata).

Free analyses worth having, all expressible over layers we already have:

| analysis | over | notes |
|---|---|---|
| weighted index | county layers | P7-8, exists |
| proximity | points → lines/points | P7-5, exists; national transmission must go local |
| rank / top-N / percentile | any county layer | trivial, client-side |
| distribution + outliers | any county layer | histogram; names the tails |
| correlation between two layers | county layers | one pass; **must show n and a scatter**, never a bare r |
| compare two indices | two composites | the "how does re-weighting change it" question |
| point-in-county rollup | point layer → county | already done by hand for CEJST; generalise it |
| coverage / completeness | any layer | how many counties have a value |

**Three of these answer Nick's "test how re-weighting changes the analysis"
directly**: compare two indices, rank movement between them, and correlation.

The UX rule that makes this legible: **say where it runs and what it costs,
before it runs.** A card should read "Free · runs here" or "Free · runs on the
server" or "Too big for the server — run locally, here is the command." P7-5
already refuses with a sentence naming the CLI; that pattern becomes the house
style rather than an error path.

---

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

### P9-4 [FEATURE] `scale: 'declared' | 'observed'` on a composite
Per §C. `declared` permitted only for registry-backed terms. Tests must show a
declared-scale composite over `BLO_PRESET` reproducing today's Lens scores for
all 3,144 counties. **Size: M.** Blocks P9-5.

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
client-side over county-scale data. Each states its cost before running.
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
P9-1 ─► P9-2 ─────────────────┐
                              ├─► P9-6
P9-4 ─► P9-5 ─────────────────┘
P9-3   P9-7   P9-8   (parallel, independent)
```

**P9-1 and P9-2 first.** They fix the blocking audit finding, need no server
change and no data migration, and make the set surface honest before anything
is built on top of it.

---

## Open questions

1. **§D — build-time artifact or published set?** The main one. (2) is the real
   version of the idea; (1) is materially cheaper and lower risk.
2. **Does the public index's number being *re-derivable* matter, or only that
   it does not change?** If re-derivable, P9-4 is required. If only stability
   matters, the index could stay compiled and sets could use observed scale,
   and P9-4/P9-5 shrink a lot.
3. **Should re-weighting be public?** "Fork the index and see what changes" is a
   strong public artifact and also a way to publish a number that disagrees
   with ours. Internal-only first?
4. **`meta.layers[]` (P8-carried) — before or after P9-6?** CEJST's other 21
   columns cannot be terms until a manifest declares more than one layer. Not a
   blocker for the index, but it is the blocker for "more kinds of data feeding
   the analysis."
