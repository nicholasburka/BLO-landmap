# Phase 7 spec (DRAFT, not approved) — Map views for data stories

**Status:** draft for Nick, 2026-10-03. Written from `Redevelopment Planning.xlsx`
(5 sheets) and the Read to Grow reference screenshots. Scoped deliberately to
**map view functionality** — the rest of the data-story surface (page+analysis
co-editing, sharing) is named only where the map forces a decision.

---

## A. What the workbook is asking for

The Redevelopment Dashboard is not a list of sites. It is an **argument**, and the
argument is the thing the map has to carry:

> "co-developing a dashboard of potential areas of development based on both
> ecological indicators, areas of development, and human-indicators,
> **redescribing each layer as potentials/opportunities**"
> — Sites sheet, row 0

and, stated plainly in Tools + Methods:

> "traditional EJ indicators = NO DEVELOPMENT; new indicators = DEVELOPMENT"

Every existing screening tool (CEJST, RE-Powering Mapper, Justice40) answers
*where is it unsafe to build*. This dashboard inverts the same indicators to answer
*where should we build, with whom*. Its three questions:

> "Where is potential? How does it look across these different threat sites?
> What is being utilized, what is underutilized?"

**Consequence for the map:** a layer is not a value any more, it is a value *plus a
reading*. The same transmission-line proximity that reads as burden in one frame
reads as opportunity in another. Nothing in the map today can express that a layer
has been re-read — see §C.1.

### What the five sheets contain

| Sheet | Rows | What it is | Where it belongs |
|---|---|---|---|
| **Sites** | 13 rows (**11 in scope**) + 6 links | Name, address, development threat, community response, restoration attempt | One held dataset, geocoded → a point layer |
| **Case Study Interviews** | 5 | City entity, partner org, development entity, engagement, analysis state (`ONGOING` / `NEW` / `IMPLEMENTED`), themes, compromises | A held dataset; the analysis state is work-tracking, not content |
| **Development Data** | 11 + 5 | Mapping datasets with URLs — transmission lines, ISOs, RTOs, PUCs, 48C credits, solar manufacturing, USPVDB, USWTDB, RE-Powering Mapper, semiconductor ecosystem | 11 link drops → indexed sources |
| **Tools + Methods** | 7 | Existing tools, their usability, and **BLO's adaptation of each** | Documents/pages — the adaptation column is BLO's own analysis |
| **Siting Criteria** | 10 | Criterion, development info, and **"Feature on Map"** | The map requirements, below |

**Eleven US sites**, heterogeneous on purpose: a Memphis cluster (xAI, Valero,
TVA, Nucor) and single sites in VA, KY, TX, CA, AZ and OH. The workbook's two
Saudi rows are **out of scope** (Nick, 2026-10-04) — an artifact of how the sheet
was gathered, not something to map or model.

One wrinkle survives: a "site" is not one shape. `Project Blue` is already a
lat/lng pair (32.048593, -110.790806) while the rest are postal addresses, so
ingest geocodes some rows and not others.

---

## B. The map requirements, read off "Feature on Map"

The Siting Criteria sheet states its own map requirements. Verbatim, with what
each needs that we do not have:

| Criterion | "Feature on Map" | Needs |
|---|---|---|
| Permit + Laws state by state | "pop-up about the specific state requirements + permitting processes" | A **state-level** layer with rich popup content. We have county and point; not state. |
| Distance to Load | "energy regions / transmission lines / distance from site to development" | **Line geometry** + a **computed distance** from each site |
| Environmental Impact Statements | "documentation on the success and limitations of EIS" | Documents attached to map features |
| Community Resistance | "use class and race based indicators to come up with a **political efficacy layer**" | A **derived layer composed from several sources** |
| Greenfields | "locate greenfields + their capacity + proximity" | Proximity again |
| Brownfields | "locate brownfields + in connection to transmission lines > add community needs" | **Two layers related to each other**, not just both drawn |

Four capabilities fall out, and only the first is close to done:

1. **Several layers at once, of mixed geometry** — points, lines, polygons, together.
2. **Proximity between layers** — "distance from site to development", "brownfields in connection to transmission lines". This is a spatial join, not a visual overlay.
3. **Derived/composite layers** — "come up with a political efficacy layer" from class, race and voting. A layer that is a *formula over other layers*.
4. **Site-centric reading** — stand on one site and see only what bears on it.

---

## C. Where the map is today, honestly

### C.1 What exists and helps
- **`MapCanvas`** (P6-10, just landed): the map, extracted from its chrome, mountable anywhere, closeable, with its own `ToolContext`. A page can host a map at all now — that was impossible a week ago.
- **`query.only`**: the GEOIDs of a page's filtered rows. Set, it *is* the answer — framed, outlined, everything else dimmed. This is the mechanism for §B.4.
- **Internal point layers** from held datasets with a `layer` block, with popup fields and per-layer colour. The Sites sheet is exactly this shape.
- **County choropleths** over the public registry, plus contamination overlays.
- **`fitToGeoIds` / `fitToBbox` / `inspectCounty` / `focusGeoId`** — the framing vocabulary a story needs to move the reader.
- **Saved views** (`/views/:slug`) — a named map state that already round-trips.

### C.2 What does not exist
- **Line geometry.** Nothing draws a `LineString`. Transmission lines are the second most-requested layer in the workbook and we cannot render one.
- **State-level choropleth.** The registry is county-indexed (5-digit GEOID). "Permit + laws state by state" has no home.
- **Any spatial relation between two layers.** `distanceMiles` exists server-side for the place report's organization list, but no layer knows about another layer.
- **Composite layers.** `useMapState` scores *counties* across registry layers (the Lens). It cannot compose a new layer from two internal datasets.
- **Embedding a map in a page.** `WikiPageView` renders markdown; there is no block that mounts a canvas. P6-14 is wiring in-page panes for *browsers*, not for pages.

### C.3 The one that matters most
> "analyzing specific sites within the context of their relevant datasets
> specifically instead of all the possible datasets" — Nick, 2026-10-03

`/place` today runs **every applicable source** — 40 of them, which is what makes
P6-17's report 10,350px long. The workbook's 11 sources are a *working set*: the
ones that bear on redevelopment siting. Running all 40 against a Memphis site to
answer a siting question is the wrong question asked expensively.

**There is no concept in the library for "these datasets, together, for this
purpose."** Saved views save a *map state*; collections group *documents*. Neither
groups datasets for an analysis. This is the missing noun.

---

## D. Proposal

### D.1 The missing noun: a **working set**

> **Resolved since this was written** — the working set IS the noun, and a saved
> view is one *presentation* of it. Nick, 2026-10-04: *"working set can be the noun
> that a saved view presents … it is the compound noun data object that facilitates
> the views."* See §E.1 and §F.1; the shape and the uses described below still stand.

A named, owned set of datasets + sites that an analysis runs against. Minimum
viable shape:

- `slug`, `title`, the datasets in it (catalog slugs + registry layer ids), and
  optionally the sites dataset that anchors it.
- A place report run *in* a working set asks only its sources. 11 instead of 40 —
  faster, cheaper, and the result is readable without P6-17's collapsing.
- The datasets browser gains "in a working set" as a filter, so sourcing progress
  is visible: *9 of 11 ingested, 2 could not be reached*.
- It is the thing a data story is **about**, so the story page and the map pane
  both read from it.

This subsumes the sourcing/work-tracking Nick asked for: the working set is the
checklist. The existing attention queues (`needs-cataloging`, `source-failing`,
`no-ingest-plan`) already report per-dataset state; scoped to a working set they
become that project's progress.

### D.2 Map capability, in dependency order
1. **Line geometry in the layer pipeline** (M). Unblocks transmission lines, the
   single most-cited layer in the workbook. Smallest change that makes the
   dashboard possible at all.
2. **A map block in a page** (M). `WikiPageView` gains a block that mounts
   `MapCanvas` against a saved view or a working set. This is the "embedded map
   views" Nick named. Depends on P6-14 settling the in-page pane contract.
3. **Proximity between two layers** (L). "Distance from site to development",
   "brownfields in connection to transmission lines". Server-side spatial join
   producing a derived column, not a client-side computation.
4. **Composite layers** (L). The "political efficacy layer" — a formula over
   several sources, saved as a layer in its own right. The Lens already scores
   counties across layers; this generalises that into something nameable and
   savable.
5. **State-level geometry** (S). For permits and laws.

### D.3 What ingests now, without any new capability
The 11 Development Data URLs are ordinary link drops; the 2 PDFs and the Tools +
Methods adaptations are documents and pages; the Sites sheet is a held dataset
with a `layer` block once geocoded. **None of that waits on D.2** — it can start
immediately and is how we find out which of D.2 actually bites.

---

## E. Answered by Nick, 2026-10-03

1. **The working set is the data object; a saved view presents it.** Nick,
   2026-10-04: *"working set can be the noun that a saved view presents, i think
   that's a little more to the point. it is the compound noun data object that
   facilitates the views."* — which corrects an earlier reading in this spec that
   collapsed the two into one thing. They are two objects: the **working set** holds
   the datasets, the sites and the derived columns; a **saved view** is one framing
   of it (a map state, a table state), and a set may have several. See §F.1.
2. **United States only, and nothing out of the country is in scope at all.**
   Nick, 2026-10-04: *"we should remove all non us stuff from spec7, this is an
   artifact of the orig spreadsheet beyond our interest."* So the two Saudi rows are
   not map features, not context rows, and not a case to design around. County and
   state geometry, the registry, coverage (P6-19) and every proximity calculation
   assume the United States throughout.
3. **The reframe is the data-story featureset, not a map primitive.** "Redescribing
   each layer as potentials/opportunities" lives in the story layer — the page's
   words, its chosen framing, its chosen palette — not in a second kind of layer.
   D.2.4 (composites) stays on the list because the *political efficacy layer* is a
   real derived quantity, but re-reading an existing layer is narrative.
4. **Existing saved views are not migrated.** A view with no working set is a
   permanent, first-class state — *ad-hoc*, not *legacy* — and a curated set comes
   into being through a deliberate "make a working set from this view" action rather
   than a backfill that guesses. Reasoning in §F.1.
5. Still open, low cost: does the **VA Brownfields Dashboard** (the stated
   reference) have behaviour worth matching? Not yet looked at.

---

## F. The analysis capabilities this needs

Nick, 2026-10-03: *"are we provisioning new data analysis capabilities (both
backend/local and available in the site analysis tab) to address the new
capabilities, like proximity?"* — **Yes. Two new primitives and one generalisation.**

### F.0 What analysis exists today

| Capability | Where it runs | Shape |
|---|---|---|
| Place report | Server (`runPlaceReport`) | A place → every applicable source, within a radius |
| Compare | Client | Counties side by side |
| Lens scoring | Client (`useMapState`) | Weights + directions over **registry county layers**, in memory, unsavable |
| Dataset explorer | Client + `libraryTabular` | Filter / sort / summarise one table |
| `county_values`, `fetch_for_place`, `place_report` | Server, via MCP | The same, to the assistant |

Everything above is **single-dataset or single-place**. Nothing relates two
datasets to each other. That is precisely the gap the workbook opens.

### F.1 The working set is the object; views present it

Two nouns, and the distinction earns its keep:

- A **working set** is the compound data object: the datasets in it, the sites that
  anchor it, and the derived columns §F.2 computes onto it. It holds no framing — no
  viewport, no sort, no chosen palette.
- A **saved view** is one presentation of a working set: a map state, or a table
  state. `/views/:slug` stays what it is today and gains a pointer to the set it
  presents.

**A working set may have several views**, which is the part that matters. One set
about Memphis redevelopment can carry a map framed on the cluster, a table sorted by
distance to transmission, and a third framing written for a story — all reading the
same rows and the same derived columns, none of them able to disagree about a number
because none of them owns one.

That is also what settles §F.4c cleanly: **a derived column belongs to the working
set, never to a view.** Proximity is computed once for the set, and every view of it
sees the result — rather than each view recomputing, or worse, caching its own copy
and drifting.

For the data story, the consequence is that a page embeds **views**, and the views
read from the set. Changing what a story *shows* is a view change; changing what it
is *about* is a working-set change.

**What this means for what exists — do not backfill.** (Recommended and
**approved by Nick, 2026-10-04**.)

A view without a working set should be a **permanent, first-class state, not a
legacy one**. Three reasons:

1. **A view's layers are what it *shows*, not what it is *about*.** A saved view
   stores `layers` with weights, `filters`, `limit`, `regionStates`, `prompt`,
   `viewport`, `pointLayers`, `siteLayers` — almost entirely framing. Auto-building a
   set from that yields one to three registry layers, no sites and no sources: the
   view's own layer list restated as a second object. It would satisfy the schema
   and mean nothing, and the library would gain N sets nobody asked for.
2. **Not backfilling is the reversible choice.** Backfilling creates objects, and
   created objects are hard to un-create — exactly the mess P6-23 found, where
   archived entries were counted everywhere and reachable nowhere. We can always
   backfill later with better information; we cannot easily withdraw a hundred junk
   sets.
3. **The codebase already settles this kind of question the same way.** `siteLayers`
   is optional with its absence given a meaning — *"Absent means none were — which
   is every document written before P5-78"* (`src/lib/views.ts`). No migration, no
   deprecated state, one well-understood optional field.

So the real distinction is **ad-hoc vs curated, not legacy vs migrated**, and both
are legitimate forever. Saving the map after exploring is a reasonable thing to do
and must not require naming a dataset collection first.

What this does need is a **promote action**: "Make a working set from this view",
taken deliberately when an ad-hoc view turns out to matter. That is P5-57's shape
again — start cheap, promote what keeps mattering — and it is the honest way for a
curated set to come into being: because somebody decided it should, not because a
migration guessed.

**The cost, stated:** an optional relationship means every reader handles the null.
That is real, but cheaper than a deprecated state — there is no cleanup pending and
no ambiguity about which kind to write.

### F.2 Proximity — new, and the one that unblocks the dashboard
*"distance from site to development"*, *"brownfields in connection to transmission
lines"*, *"greenfields + their capacity + proximity"*.

- **What:** for each row of dataset A, the distance to the nearest feature of layer
  B, and optionally a count of B within *n* miles. Output is a **derived column on
  the working set**, not a mutation of either source dataset — provenance stays
  clean and the source stays re-fetchable.
- **Where: server.** Three reasons — the result must be stable and citable (a story
  quotes it), it joins datasets the browser does not hold, and chat/MCP must be
  able to ask for it. `@turf/turf` is already a dependency and gives
  nearest-point-on-line, distance and buffers; `distanceMiles` already exists in
  `placeAdapters/shared.ts` for the place report's organization list.
- **Local too:** a `npm run library -- proximity` pass for bulk recomputation, the
  same way `geocode` and `retag` work, so a 190,000-row brownfield layer is not
  computed inside a request.
- **Blocked on line geometry** (D.2.1) for the transmission-line case; point-to-point
  works today.

### F.3 Composite index — the Lens, generalised and savable
The *political efficacy layer* ("class and race based indicators … areas of greater
engagement") is a formula over several layers. The Lens already does weighted
scoring with directions — but only over registry **county** layers, only in client
memory, and the result cannot be named, saved, cited or drawn as its own layer.
Generalising it means: arbitrary layers (not just the registry), a saved definition,
and an output that behaves like any other layer. This is how a story cites a number
it invented.

### F.4 Scoped place report — not new, but newly bounded
`runPlaceReport` already fans out across sources. Run it **inside a working set**
and it asks that set's sources only: 11 instead of 40. No new analysis, one new
argument — and it is the direct answer to *"analyze specific sites in the context
of their relevant datasets specifically."*

### F.4b Where analysis runs — the real architectural question

Nick, 2026-10-03: *"a lot of these kind of analyses we manually python script
(including with claude code) in the local directory, then push, so this is also a
potential change to where analysis happens, which is potentially challenging or not
intended, though maybe necessary to enable the kind of analysis functionality we
want available to non technical users."*

He is right that it is a change, and right to be wary. It should **not** be a
wholesale move.

**What today's model actually is.** `scripts/` holds eleven analysis scripts —
`calculate_blo_v2_scores`, `calculate_combined_scores`,
`precompute_contamination_counts`, `build-county-lookup` — run locally over
`source-data/` (which includes a `.gdb` geodatabase), output committed, folded in at
build. Its virtues are real and must not be given up: reproducible, reviewable in a
diff, version-controlled, no runtime cost, no timeout, and the full Python/geo stack
when it is wanted. Its cost is equally real: it needs a developer and a deploy, so a
non-technical user cannot ask a new question.

**The thing that decides where an analysis belongs is not the operation, it is the
cardinality.** Proximity over 13 sites × 1 layer is microseconds. Proximity over
190,000 brownfields × 1 layer is a batch job. Same primitive, different home. Any
rule phrased as "proximity goes server-side" will be wrong half the time.

#### Three tiers, and a bridge

1. **Batch — stays exactly where it is.** Whole-dataset derivations, heavy geometry,
   anything that wants geopandas or a `.gdb`. Local Python / Claude Code / `scripts/`,
   committed and pushed. **One change only:** the output becomes a first-class
   library dataset with a manifest recording the script, its inputs and its run date,
   rather than a bare file under `public/datasets/`. That makes a scripted result
   citable by a story and visible in the datasets browser — which it is not today.
2. **On-demand — new.** Small-N, parameterised, user-triggered: proximity over a
   working set's sites, a weighted index over a handful of layers, a scoped report.
   Runs server-side, result written to the DB (§F.4c). This is the tier that serves
   non-technical users.
3. **Promotion — the bridge.** When an on-demand analysis keeps being asked for, or
   outgrows what a request can do, it becomes a batch job. **The library already does
   exactly this for data**: P5-57 fetches "exactly the slice the question needs, keeps
   it, and lets a slice that keeps mattering be promoted to a real dataset"
   (`placeFetch.ts`). Analysis should follow the same path rather than inventing one.

   Nick, 2026-10-03: *"promotion is basically saying, hey dev, can you make a script
   that does these analyses so that we can load them trivially after youve scripted
   and run them … the right separation of concerns."* Yes — with the refinement that
   **two different things get promoted, in opposite directions**:

   - **A result is promoted down into batch** (what Nick described). It is popular or
     expensive, so a dev scripts it once and the output is loaded. This is a
     *performance* move: the capability already existed.
   - **A script is promoted up into a type.** Somebody — a dev, or Claude Code —
     writes a one-off script for one question, and its *shape* turns out to be
     general. It becomes a parameterised analysis type anyone can apply to their own
     working set. This is a *capability* move, and it is how the menu in §F.4b grows
     beyond the three types we start with.

   The second direction is the one that compounds. Without it, every genuinely new
   question is a dev round-trip forever; with it, each round-trip can leave behind
   something reusable. Choosing the first three types broadly matters for the same
   reason — a type that takes parameters answers a family of questions, not one.

#### What has to change for the handoff to be cheap

The separation only pays off if "load them trivially" is actually trivial, and
**today it is not — it is a deploy.** A script writes into `public/datasets/`,
`build-datasets.mjs` folds it into the content-hashed bundle file, and the result
reaches anyone only after a build and a Netlify publish. A new derived column is
therefore a code change, a build and a deploy, which is the opposite of trivial.

The fix is to split by audience, not by habit:

- **Public map layers** (the registry, county choropleths) keep shipping in the
  bundle. The public map must paint fast and work logged out; that is why P5-90
  prebuilt and hashed them, and none of that should change.
- **Internal analysis outputs go to the library bucket and are picked up by a
  reindex** — no build, no deploy. They then arrive as ordinary datasets: citable by
  a story, visible in the datasets browser, carrying a manifest that names the script
  and inputs that produced them, and usable by a working set the day they land.

That is the concrete change that makes Nick's separation of concerns real. Without
it the dev is still in the loop at *publish* time as well as at *script* time.

#### The honest limit on "available to non-technical users"

Arbitrary analysis by non-technical users is a notebook, and a notebook is a
different product. What is actually achievable — and sufficient for this workbook —
is that **a developer defines an analysis *type* once, and anyone then applies it**
with their own parameters to their own working set. Three types cover every "Feature
on Map" in the Siting Criteria sheet:

- **proximity** (A → nearest B, and count of B within *n* miles)
- **weighted index** (the Lens, generalised and savable)
- **scoped report** (the existing fan-out, bounded by a working set)

That is parameterisation, not scripting, and it is the honest promise to make.

#### What is genuinely risky about tier 2

- The API is **one small Railway instance**, and DEPLOY.md's own scaling note says
  the rate-limit and budget counters are in-memory and must move to Redis before
  scaling horizontally. Analysis that takes minutes does not belong in it yet.
- Node's geo stack is `@turf/turf` — fine for distance, buffer and point-in-polygon
  at modest N; **not** geopandas. Anything wanting projections, topology repair or a
  real spatial index stays in tier 1.
- The 90-second place-report deadline is the existing precedent for "a request may
  not run forever". Tier 2 needs the same kind of bound, declared up front.

**Recommendation:** build tier 2 for small-N only, with an explicit row-count ceiling
that refuses rather than crawls, and keep tier 1 as the answer for everything above
it. Revisit a Python worker only if the ceiling proves too low in practice — naming
it now as the escape hatch, not building it.

### F.4c Results are stored, not recomputed

Nick, 2026-10-03: *"we should also be saving to the db when new composite layers /
analyses are generated so they don't need to be regenerated anytime someone wants to
relate those layers."* Agreed, and the design detail that matters is **staleness**.

- **One table of analysis results**, keyed by the analysis definition (type +
  parameters) and the working set, holding the derived column(s). Tier 1 and tier 2
  write to the same place, so the map and the table do not care which produced a
  number.
- **Keyed by content, not by clock.** The place report's 7-day TTL is right for a
  report of the live world; an analysis over held datasets is different — it is
  stale only when an *input* changes. So the key records the inputs and their
  versions, and a changed input marks the result stale rather than a timer expiring.
- **Stale must be visible, never silent.** A published data story quoting a number
  that quietly drifted is worse than one that recomputes. A stale result still
  renders, labelled, with a way to re-run — the same honesty rule P6-26 applied to
  cached reports.
- Provenance per result: what produced it, from which inputs, when, and by whom —
  the same question P6-11 asks of compiled datasets, and the reason a scripted
  tier-1 result should carry its script name.

### F.4d Metadata, so Chat can pick the right datasets

Nick, 2026-10-03: *"let's also make sure we're in a good position now or after this
work in terms of new analysis outputs having good metadata so the chat feature can
also identify relevant datasets appropriately (rather than simply running all 40)."*

**Checked, not assumed. We are not in a good position, and this work does not fix it
by itself.** One part must be done *before* the analysis work, because retrofitting
it is expensive.

#### What Chat can see today
`search_library` filters on `kind`, `topic`, `organization`, `shape` and free text
over title, slug, tags, category, description and (P5-56) source field names. The
system prompt's instruction is simply *"search_library to find something"*.
`get_entry`, `query_dataset`, `list_layers` and `list_topics` fill in the rest.

That is all **descriptive** metadata — who published it, what subject bucket it sits
in, what shape it is. It is genuinely good, and most of it did not exist a month ago
(P6-1 organization, P6-2 shape, P5-63 topics, P5-82 readiness).

#### The three gaps, in order of leverage

1. **Relevance is decided geographically, never by subject.** `applicableSources`
   filters candidates with `fitsPlace` and nothing else — `readiness.ts`'s own
   comment says it answers *"does this source answer a question about THIS place"*.
   Place, not question. **That is precisely why the report runs 40 sources**: every
   one of them fits the place, and nothing asks whether it bears on what was asked.
2. **There is no column or measure metadata anywhere.** No units, no column meanings,
   no statement of what a dataset measures. Chat can `query_dataset` and get numbers
   back that it cannot safely interpret or compare. For **analysis outputs this is
   fatal**: a derived `distance_to_transmission` is a bare number with no declared
   unit, no inputs and no method, and a model reading it can only guess.
3. **No tool takes a scope.** Once working sets exist, `search_library`,
   `query_dataset` and `place_report` should all accept one. A working set is itself
   a strong relevance signal — scoped to a story's 11 datasets, the model has an
   11-way choice instead of a 100-way one.

#### What to do, and when

- **Before the analysis work — mandatory column metadata at generation time.** Any
  analysis that writes a derived column must declare, in the same write: the column
  name, what it **measures**, its **unit**, the **inputs** it came from, and the
  **method**. This is nearly free if designed in now and costly to backfill once
  results exist, which is the one thing in this section that cannot wait. It also
  feeds §F.4c's provenance and P6-11's "compiled by" reading for nothing.
- **Cheap and high-leverage — a "what this answers" line per dataset.** One or two
  sentences in the manifest, surfaced in `search_library` rows and `get_entry`:
  *"Answers: which parcels sit within N miles of a transmission line."* Models choose
  well from exactly this, far better than from a topic chip. It is a manifest field
  plus a reindex — `meta` JSONB, no schema change — and it can be written for the 11
  workbook sources as they are ingested rather than as a separate pass.
- **Then — subject fitness beside place fitness.** Give `applicableSources` a second
  filter so a report can be narrowed by what is being asked, not only by where. With
  working sets this is mostly moot for stories (the set *is* the filter), but it is
  what stops the general `/place` report being 40 sources forever.

#### Honest caveat
Metadata quality is a **writing** problem as much as a schema one. A `whatItAnswers`
field that everyone fills with the title restated is worse than no field, because it
looks like signal. Worth generating a first draft per dataset with the model at
ingest (the inspection pass already reads a source's page) and having a person edit
it — the P6-8 "proposed, not applied" pattern, which already exists and is already
how titles and summaries are handled.

### F.5 Where they surface
`/analysis` gains tool cards that operate on a working set rather than on the whole
library: **Measure proximity**, **Build an index**, **Run a scoped report**. Each
writes a derived column back to the working set, so the map pane and the data table
both show it without a second computation. MCP exposes each, so Chat can run them
and cite the result.
