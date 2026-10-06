# Phase 7 Tickets — Map views for data stories

Spec: `specs/phase7-spec-map-views.md`. Same routine as phases 5 and 6: TDD, gates
(client + server suites, both type-checks, build + bundle-leak, Cypress), live
verification on the dev stack, DONE notes in the ticket, commit.

**Order.** P7-1 first and alone — it is the noun everything else hangs off, and
ticketing it wrong is expensive to undo. P7-2 can start the same day and needs
nothing new. Then P7-3 (line geometry) unblocks the dashboard at all, P7-4 puts a
map in a page, P7-5 is the analysis that makes a working set worth having. P7-6
and P7-7 follow the data. P7-8 and P7-9 are the long tail.

**What is already decided** (spec §E, Nick 2026-10-03/04/05) and must not be
re-litigated:
- A **working set is the data object**; a saved view **presents** it, and a set may
  have several views. Derived columns belong to the set, never to a view.
- **United States only.** Non-US rows are out of scope entirely.
- "Redescribing layers as potential" is the **data-story featureset**, not a map
  primitive.
- **No backfill**: a view with no working set is permanent and first-class
  (*ad-hoc*, not *legacy*); a curated set is created by a deliberate promote action.

---

## P7-1 [FEATURE] The working set

**Type:** Feature · **Priority:** P0 · **Size:** M · **Dependencies:** none

### Why
Spec §C.3. `/place` runs **every applicable source** — 40 of them — because
`applicableSources` filters with `fitsPlace` and nothing else, which is a question
about *where*, never about *what was asked*. The Redevelopment workbook names **11**
sources that bear on siting. Nick (2026-10-03): *"analyzing specific sites within
the context of their relevant datasets specifically instead of all the possible
datasets."*

There is no concept in the library for "these datasets, together, for this purpose".
Saved views save a map state; collections group documents. Neither groups datasets
for an analysis.

### Design
- A **working set**: `slug`, `title`, the datasets in it (catalog slugs + registry
  layer ids), optionally the sites dataset that anchors it, and the derived columns
  analysis writes onto it (P7-5). **It holds no framing** — no viewport, no sort, no
  palette. Those belong to a view.
- A **saved view gains a pointer** to the set it presents. A set may have several
  views; a view may have none (see below).
- **Nothing is backfilled.** An existing view keeps a null pointer and behaves
  exactly as it does today. The distinction is *ad-hoc vs curated*, not *legacy vs
  migrated*, and both are permanent. A deliberate **"Make a working set from this
  view"** action is how a curated set comes into being — P5-57's promotion shape,
  applied to analysis rather than data.
- The datasets browser gains "in a working set" as a filter, so sourcing progress is
  visible: *9 of 11 ingested, 2 could not be reached*. The existing attention
  predicates scoped to a set **are** that project's progress tracker.

### Acceptance criteria
- **Given** a working set of 11 sources, **when** a place report runs inside it,
  **then** it asks those 11 and no others.
- **Given** a set, **then** it can carry more than one saved view, and each presents
  the same rows.
- **Given** an existing saved view, **then** it works exactly as before and shows no
  broken or empty working-set affordance.
- **Given** the promote action on an ad-hoc view, **then** a set is created from it
  and the view points at it.

### Out of scope
Derived columns (P7-5); the data interface (P7-2); anything about framing.

### Tests
The scoped report asking only the set's sources; several views over one set; an
ad-hoc view unchanged; promotion; the browser filter and its progress counts.

### ✅ DONE (2026-10-05)

#### The object model, as built

Two objects and **one optional pointer**, which is the whole design:

| | **Working set** | **Saved view** |
|---|---|---|
| is | the data — what the analysis is *about* | the framing — what it *shows* |
| kind | `working-set` (new) | `view` (unchanged) |
| lives at | `library/working-sets/<slug>/meta.json` | `library/views/<slug>.json` |
| holds | `title`, `purpose`, `datasets`, `layers`, `sites`, `derived`, `savedBy/ById/At`, `fromView` | `state` (layers+weights, filters, limit, regionStates, prompt, viewport, pointLayers, siteLayers), `results` |
| points at | nothing | `workingSet?` — **absent means ad-hoc** |
| cardinality | one set, **many views** | one view, at most one set |

**The set is a DIRECTORY, not a flat document — the one place this deliberately
departs from the saved-view precedent it otherwise copies.** A view is written
once and read; a set is *edited* — members added as sourcing progresses, derived
columns written onto it by P7-5 — so it takes the nested-manifest layout that
`patchEntryManifest` and `indexFileBackedEntry` already serve, and it leaves
room for a 190,000-row proximity column to land as a **file beside the
manifest** instead of inside a catalog row. The manifest IS the row's meta (the
`note` pattern), so a reindex rebuilds an identical row from the bucket alone;
`applyWorkingSet` in `libraryCatalog.ts` is `applySourceBlock`'s grain and is
what makes a route-written row and a rebuilt one the same row.

**It holds no framing, and that is asserted rather than assumed.** Two tests
push `viewport`, `sort`, `palette`, `filters`, `limit`, `regionStates` and
`prompt` at a set as if a caller had confused the two objects, and check that
none of it is stored. If a viewport ever lands in a set, those tests fail — the
collapse §E.1 corrects cannot happen quietly.

**`derived` exists before the analysis that fills it**, carried verbatim by
every writer and never reachable from the edit route. A test seeds a derived
column into a manifest, edits the set, and asserts the column survives: P7-6
keys a stored result on its inputs, and adding a twelfth dataset must not
discard a number somebody is already quoting.

#### How the scoped report proves it

`applicableSources` already took an `only` shortlist; what it never had was a
way for the caller to say *what was asked*. `PlaceReportInput.workingSet` is a
**slug, dereferenced server-side** — not a list the caller assembled — which is
what makes a scoped number citable.

In the fixture library four sources fit the place and the set names two: the
fetcher is called **twice**, with exactly `epa-brownfields` and
`epa-superfund-npl`, and the same place unscoped calls it four times. The set's
held table and its anchor are members but are not sources, so a set of five does
not become five agency requests.

**Two refusals, because the failure modes are worse than the feature.** A set
that does not exist must not quietly become "run all forty" — a typo would then
cost forty agency requests and answer a different question. A set that names
nothing yet must not either: an empty report reads as *nothing found*, a false
negative, where *"this set names no datasets yet"* is the truth and points at
the thing to fix. Both leave as `PlaceScopeError` → **400 with a sentence**,
verified live:

```
POST /api/library/place/report {"geoid":"47157","workingSet":"no-such-set"}
  → 400 {"error":"There is no working set called “no-such-set”."}
POST … {"workingSet":"Not A Slug!"}
  → 400 {"error":"That is not the name of a working set."}
```

Naming both `sources` and `workingSet` takes the **narrower** of the two, never
the union: a shortlist inside a set cannot reach outside it.

The page says the scoped number too. `/place?set=<slug>` seeds its progress line
from the set's members, so a run that asks two sources says *"Checking 2
sources…"* and not *"Checking 4"* — a count disagreeing with what happened is
the one thing this codebase does not do.

#### What happened to existing views: nothing, by construction

- An ad-hoc view's **document has no `workingSet` key at all** (asserted on the
  stored JSON, not just the API), and its row carries `''`, which matches no
  set. Clearing a pointer returns the document to exactly that state — ad-hoc is
  somewhere a view can go back to, not a one-way door.
- **Verified live against the real bucket:** a reindex indexed **86 entries, 0
  collisions**, and `GET /api/working-sets` answered `{"sets":[]}` afterwards.
  The library invented nothing. The same reindex reports **40 sources**, all 40
  of which a place report would ask — the ticket's own number, measured rather
  than quoted.
- The promote action is the only way an existing view comes to present a set,
  and it **refuses a second set from the same view (409)** rather than leaving
  two objects claiming it. What it can honestly take is the layers the view
  draws (`meta.layers`, the union `savedViewMeta` already computes) plus the
  datasets underneath them — a table view's dataset, and the held dataset behind
  an `internal-<slug>` layer id. The response names what it took, and the page
  says *"add the sources that bear on it to finish it"*, because a promoted set
  is a starting point and must not look finished.

#### The browser filter

A fifth chip row on `/datasets`, through the existing kit — `facetsFor`,
`FilterChips`, folding at 8, keeping an active chip visible at its true count of
0. Multi-valued like P6-19's coverage (a dataset eleven projects depend on is
under all eleven chips) with `In no working set` as a pressable chip rather than
a silence. **The row is not drawn at all when there are no sets**, which is what
every library looks like before the first one.

Narrowed to a set, the page is that project's sourcing checklist:
`1 of 3 held · 1 indexed · 1 no longer in the library`. The denominator is what
the set **NAMES** — a member archived out from under it is reported, never
folded into a tidier number (P6-23's rule) — and the "could not be reached" half
is the existing `unreachable` / `source-failing` predicates scoped to the set,
not a second vocabulary.

**One bug found by the gates and worth recording:** loading the sets beside the
catalog with `Promise.allSettled` held the whole dataset list behind the slower
of the two requests, which `LibraryEntryView`'s cross-page consistency tests
caught. The sets are one filter row; the catalog IS the page, so the list now
never waits on them and never fails with them.

#### Also landed

- Routes: `GET/POST /api/working-sets`, `GET/PUT /api/working-sets/:slug`,
  `POST /api/working-sets/from-view/:slug`, `PUT /api/views/:slug/working-set`,
  and `?workingSet=` on `GET /api/views`. A set's payload is **not** opaque
  here, unlike a view's: the server dereferences these slugs, so a member the
  library does not have, a member that is a document, an anchor we only *point*
  at, or a layer that does not exist are each a 400 naming the offender.
- MCP `place_report` gained `workingSet`, and `search_library` accepts the kind —
  the spec's own reason for a server-side analysis applies to chat too.
- `/analysis` lists the sets with their views and carries the promote control;
  the entry page gets a small block (a set's real surface is P7-2's).

#### Deliberately left

- **A scoped report is still uncached** — the existing rule for a narrowed
  report, unchanged on purpose. Storing one under its own key is **P7-6**, where
  a result is keyed on its inputs rather than on a 7-day clock; inventing a
  second keying scheme here would only give P7-6 something to undo.
- **A working set's readiness verdict reads `document`.** It is in
  `SELF_CONTAINED_KINDS` so it is not mistaken for an unfetched link, but the
  vocabulary has no word for it yet and inventing one before **P7-2** gives a
  set its two interfaces would be guessing.
- No delete route for a set, and **no set was created in the real library** —
  created objects are hard to un-create, which is §F.1's own second argument.
  Every live check was read-only apart from a reindex, which writes only the
  index.

#### Gates

Client **1,928 / 98 files** (was 1,870 / 97). Server **2,222 passed / 14
skipped** (was 2,161 / 14) — the two per-user-limiter cases flake under
contention and pass alone, as ever; `mcp.test.ts` stayed green. Both
type-checks clean. Build green, bundle-leak check passed (59 files, 10
canaries); entry chunk **515.18 kB raw / 171.60 kB gz** against 515.01 / 171.52
— **+0.17 kB raw, +0.08 kB gz**. New suites: `libraryWorkingSets.test.ts` 26,
`routes/workingSets.test.ts` 25, `lib/__tests__/workingSets.spec.ts` 16, plus
the browser, analysis, place, entry-page and view-pointer cases. Screenshots
`p7-1-analysis-no-sets.png`, `p7-1-datasets-no-chip-row.png`,
`p7-1-datasets-real-library.png`.

---

## P7-2 [FEATURE] Two interfaces over one working set

**Type:** Feature · **Priority:** P0 · **Size:** M · **Dependencies:** P7-1

### Why
Nick (2026-10-03): a working set *"can be mapped or explored in terms of data (two
interfaces to the same compound data object)"*.

### Design
`/views/:slug` offers a **Map** interface (the `MapCanvas` pane, P6-10/P6-14) and a
**Data** interface (the explorer's table) over the same object, at the same URL.
Both read the set's rows and its derived columns; the map draws a column and the
table sorts it, from one computation. Switching interface is not a navigation.

### Acceptance criteria
- **Given** a set with a derived column, **then** both interfaces show it without a
  second computation.
- **Given** a filter applied in the data interface, **when** the map is opened,
  **then** it shows that subset (`query.only`, P6-10).
- **Given** a deep link to either interface, **then** it opens there.

### Tests
Both interfaces over one fixture; the filtered subset reaching the map; the deep
link; no duplicate fetch.

### ✅ DONE (2026-10-05)

#### Where the two interfaces live, and why not on the set

`/views/:slug` renders them. That reads like a detail and is the ticket's
hardest decision, because `workingSetHref` had carried a note since yesterday
saying *"P7-2 gives a set its two interfaces"* — and the right answer turned
out to be that **it cannot**. A set holds no framing. There is nothing to show
it *with* until something supplies a viewport, a sort, a dataset to open on;
that something is a view. So the set's entry page stays what P7-1 made it, and
the interfaces live on each view **over** the set:

| | holds | at |
|---|---|---|
| working set | the data — members, anchor, derived columns | `/library/<set>` |
| saved view | the framing — and the two interfaces over the set | `/views/<view>` |

This **strengthens** §F.1 rather than bending it: a set with three views has
three framings over one object, which is exactly what the two objects being two
objects is for, and the workspace says so in a line (*"Also presented by …"*).
A set with no view yet is not broken — it has an entry page and a sourcing
checklist, which is the honest amount of surface for data nobody has framed.
The set's entry page gained the return leg (`fetchViewsOfWorkingSet`, off the
shared catalog, no second request), so a set with no views says so in words
instead of showing an empty list.

`ViewRedirect.vue` is a **fork** now, not only a shim — and the ad-hoc branch is
byte-for-byte the branch that was there yesterday:

```ts
if (view.workingSet) { workspaceView.value = view; return }   // the only new line
const table = tableStateOf(view)                              // P5-54, untouched
…
```

#### One object, two readers, no second computation

A derived column belongs to the set and never to a view (§F.1), which only
means something if there is **one place to read it from**. That place is
`GET /api/working-sets/:slug/columns`, and both interfaces are handed its
result:

- **The data interface sorts it.** P5-48 already joins county numbers into any
  table carrying a GEOID — a `Map<GEOID, …>`, a cell formatter, a client-side
  sort, a CSV that includes the joined columns. A derived column **is** that
  shape, so `derivedColumnValues` hands it straight to `contextCell`,
  `contextValue` and `sortRowsByContext`, and the explorer sorts a set's
  analysis through code that already existed and was already tested. The one
  change inside the table was renaming `contextSort.layerId` → `columnId` and
  routing every lookup through `columnValuesFor(id)`, so a joined column cannot
  end up sortable-but-unprintable.
- **The map interface reports it** over the counties it is drawing — the range,
  the coverage, and the value for a county you press — read off *the same*
  `Map`s the table is sorting (`joined.value[index].values`, not a second
  conversion). Drawing a derived **choropleth** needs the layer pipeline, which
  P7-3 is in and which this ticket was told not to touch; what the map can say
  without it, it says.

`fetchWorkingSetColumns` is called **once** per page and a test counts the
calls across four interface switches. So does `fetchDatasetRows`.

**Keyed on the county GEOID, and that is the one real constraint.** It comes
from the map: county polygons are what the canvas draws, so a GEOID is the only
key *both* interfaces can read. A column keyed on some column of the anchor
table would be readable by the table alone — half a feature wearing the name of
a whole one — so the reader does not pretend to offer it. Values under any
other key are dropped, with the same two forgivenesses `normalizeGeoId` already
makes (a spreadsheet's missing leading zero, a float column's `.0`), and a
column left with none is still **listed with a count of 0**: "this column has no
county values" is a thing to go and fix (P6-23). Same rule for a column whose
file cannot be opened — it comes back in `unreadable`, never dropped.

**Both storage shapes resolve through that one route**: inline on the manifest,
or a file beside it — the layout P7-1's directory exists to allow — so P7-5 can
write a 190,000-row proximity column without anybody needing a second read
surface. `derivedColumnKey` refuses to leave the set's own directory, and
refuses an absolute key rather than quietly reinterpreting it as a relative one.

#### Deep links

```
/views/<slug>                   → the interface the view's own kind names
                                  (map view → Map, table view → Data)
/views/<slug>?interface=data    → Data
/views/<slug>?interface=map     → Map
```

The default is left **unsaid**: a map view's canonical link stays `/views/x` and
does not grow a parameter restating what the document already says. Switching
is `router.replace` on the path you are already on with every other key
untouched — asserted three ways (the path does not change, `push` is never
called, `?q=` survives). A hand-edited `?interface=sideways` degrades to the
view's own kind rather than breaking the page.

`SetInterface` and `workingSetViewHref` live in `lib/views.ts`, not
`lib/workingSets.ts`, and that is §F.1 again: **an interface is framing**. It
also keeps the public map's entry chunk out of the working-set client — putting
them in `workingSets.ts` first pulled that whole module into `index.js`'s import
graph, which the build caught. A set-backed view's `viewOpenUrl` answers
`/views/<slug>` by the same rule the rest of that function follows.

#### What a view with no working set does: exactly what it did

- The pointer is absent → `ViewRedirect` takes the P5-16/P5-54/P5-55 path
  unchanged; an **empty** pointer reads as ad-hoc too (tested), because absent
  and blank both mean "nobody said".
- Its eight existing tests are untouched and still pass. The new block exists to
  assert the other half: a set-backed view stops here, and an ad-hoc one still
  lands on `/`, `/library/<dataset>?tab=data…` or `/compare`.
- A set-backed **table** view no longer redirects to the explorer — it opens on
  the Data interface instead, with its saved query seeded onto the URL it is
  already on (`tableViewQuery`, factored out of `tableViewUrl` so "what a saved
  table view restores" stays one answer). A shared link carrying its own filters
  wins over the document's, which is the rule everywhere else.

#### Two things the live check found that the tests had not

- **The pane must wait for the table's first answer.** An empty `only` means
  *the whole layer* to `query.only`, so a pane opened before the rows landed
  painted all 3,142 counties and snapped to the subset a moment later — and that
  late repaint lands in the middle of the Mapbox style load. `DatasetView`'s
  `shown` emit now carries `loading`, and the workspace opens on a **one-way**
  latch: before it, the first paint is already the right subset; one-way,
  because otherwise every filter would tear the canvas down and build it again.
  (`loading` needed a third term — `loadingSchema`'s `finally` runs before
  `loadRows` sets its own flag, and in that tick neither loader is running and
  there are still no rows.)
- **"1 counties from 1 rows"** on the pane note. Pluralised.

#### Also landed

- `DatasetView` gained three props and one emit, and nothing else: `slug` (the
  route is about the view, not the dataset), `extraColumns`, `hostMap` — so the
  table offers no "Show on map" of its own when the host already draws the whole
  set, because two buttons would be two answers to one question — and `shown`.
  A derived column's header carries no remove ×: it is the **set's**, and
  removing it would be an edit to what the analysis is about, so no control is
  offered that cannot do what it says.
- A saved table view's `layers` now records only the chosen county layers. It
  was keyed off `contextColumns.length`, which would have written a derived
  column's presence into a view's state — the one thing §F.1 forbids.
- `src/views/DatasetView.vue` held a **literal NUL byte** (a `.join('\x00')`
  written as the raw character), which made `grep` treat the whole 2,300-line
  file as binary and silently skip it — `grep -rn "useShowOnMap" src/` did not
  list the file that uses it. Now `'\u0000'`; same separator, same behaviour,
  the file is text again.

#### Deliberately left

- **The map does not paint a derived column as a choropleth.** That needs the
  layer-drawing pipeline, which P7-3 owns right now. The map reports the column
  over the subset it draws instead, from the same values — honest, and no edit
  to `MapCanvas.vue`.
- **A console-noise race in `MapCanvas` is reported, not fixed.** Its `onRepaint`
  hook calls `updateChoroplethVisibility()` with no style guard, so any repaint
  between the canvas mounting and the style finishing logs *"The layer
  'county-choropleth' does not exist"*. It is pre-existing — the same stack
  appears through `ensureInternalLayerValues` on P6-14's own pane — and
  intermittent, and the fix is a two-line guard in a file this ticket was told
  not to touch.
- **No set was created in the real library**, keeping P7-1's rule: there is still
  no delete route. `GET /api/working-sets` answered `{"sets":[]}` before and
  after. The live check of the two interfaces ran against a **fixture API on a
  separate port** serving literals, with P6-14's own pane over the same dataset
  as the control that proved the console noise was not new.

#### Gates

Client **2,008 / 99 files**; server **2,272 passed / 14 skipped**, run alone,
both per-user-limiter cases green and `mcp.test.ts` green. Of those, P7-2's own
are **+62 client** (`workingSets.spec` 16→27, `views.spec` 37→43,
`DatasetView.spec` 69→79, `ViewRedirect.spec` 8→12, new
`WorkingSetWorkspace.spec` 31) and **+23 server** (new `workingSetColumns.test`
14, `routes/workingSets.test` 25→34); the rest of the delta from the 1,928 /
2,222 baselines is P7-3 landing in the same tree. Both type-checks clean. Build
green, bundle-leak check passed (61 files, 10 canaries). Entry chunk **518.34 kB
raw / 172.64 kB gz** against 515.18 / 171.60 — but that number is two tickets, so
P7-2's own share was measured in a clean worktree at `e698d37` with only this
ticket's files copied in: **514.67 → 515.13 kB raw, 171.25 → 171.43 kB gz,
+0.46 kB raw / +0.18 kB gz.** The workspace rides in `ViewRedirect`'s lazy chunk
and reuses `DatasetView`'s existing one (39.11 kB, unchanged). Screenshots
`p7-2-map-interface.png`, `p7-2-map-derived-column.png`,
`p7-2-data-interface.png`, `p7-2-data-sorts-derived-column.png`,
`p7-2-filter-reaches-map.png`, `p7-2-real-library-untouched.png`.

---

## P7-3 [FEATURE] Line geometry in the layer pipeline

**Type:** Feature · **Priority:** P0 · **Size:** M · **Dependencies:** none

### Why
Spec §C.2: **nothing in the pipeline draws a `LineString`.** Transmission lines are
the second most-cited layer in the workbook — *"energy regions / transmission lines
/ distance from site to development"*, *"brownfields in connection to transmission
lines"* — and we cannot render one. This is the smallest change that makes the
dashboard possible at all, and P7-5's proximity needs it for its headline case.

### Design
Lines join points and polygons as a geometry a layer can declare and the canvas can
draw: styling, hover, popup fields, and the fit/frame vocabulary. Internal point
layers (P5-24) are the shape to follow.

### Acceptance criteria
- **Given** a layer whose features are `LineString`, **then** it draws, hovers and
  popups like any other layer.
- **Given** a mixed set (points, lines, polygons), **then** all three draw together.
- **Given** the public map, **then** its rendered output is unchanged.

### Tests
A line layer end to end; mixed geometry; the public map's snapshot unchanged;
`mapDeepLinks.cy.ts` green and unedited.

### ✅ DONE (2026-10-05)

#### Where the LineString was actually being lost

Not in the canvas. **In the parser, three weeks before anything could draw.**
`parseJson` in `libraryTabular.ts` flattened a GeoJSON `FeatureCollection` to
rows and kept `_lng`/`_lat` **for `Point` features only** — a `LineString`'s
coordinates were read, discarded, and the row handed on with two empty
columns. Every layer downstream was innocent: there was no path left to draw.

So the first change is four lines in the parser, and the shape of the fix is
set by what the library already holds. `replicate.ts` has been writing
`<slug>.geojson` beside every copied CSV since P5-59, under a comment reading
*"polygons and lines are drawn from their centroid until somebody builds the
polygon layer the GeoJSON beside it is kept for"*. The file was already there,
with the real geometry in it. This ticket is mostly the day that comment came
due.

`_path` carries the vertices through as compact JSON, and **the column exists
only when the collection actually holds line geometry** — so every point and
polygon `.geojson` in the library keeps the exact columns it had, asserted by a
test that parses a point-only collection and compares the column list.

#### What a line layer declares

The point block (P5-24) with its coordinate pair replaced by one path column.
Nothing else moved:

| | **point** (P5-24) | **line** (P7-3) |
|---|---|---|
| geometry columns | `latKey`, `lngKey` | `pathKey` |
| title column | `labelKey` | `labelKey` |
| popup allowlist | `popupFields` | `popupFields` |
| swatch | `color` | `color` + `width` (0.5–10 px, default 2) |
| caps | `LAYER_MAX_FEATURES` | `LAYER_MAX_FEATURES` **+ `LAYER_MAX_VERTICES`** |

```json
"layer": { "geometry": "line", "file": "transmission.geojson", "pathKey": "_path",
           "labelKey": "NAME", "popupFields": ["OWNER", "VOLTAGE"],
           "color": "#2b6cb0", "width": 3, "name": "Transmission lines", … }
```

`pathKey` is **required and named explicitly**, exactly as `latKey`/`lngKey`
are — the manifest says what it reads. It is `_path` for a GeoJSON file; a CSV
may instead carry **WKT** (`LINESTRING (…)` / `MULTILINESTRING ((…),(…))`) or a
JSON coordinate array in a column of its own and name that. Two spellings
because a path reaches the library in two, and an ArcGIS CSV export is the
second one.

`parseFeatureFields` is new and is a **deletion**: the label/popup/colour
checks were about to exist twice, so point and line now read them from one
function. The geometry's own columns are validated *first*, so a block
re-labelled from one geometry to another is told what that geometry needs
rather than being sent off after a field both share.

The payload says what it is: **one part is a `LineString`, several a
`MultiLineString`**. Both are what a Mapbox `line` layer draws, and a reader
inspecting a simple line does not find it wrapped in a Multi.

**`LAYER_MAX_VERTICES` (500 000) exists because the feature cap cannot see the
payload.** A few hundred transmission corridors is a few hundred rows and can
be millions of coordinates; the row cap would wave through a 40 MB response.
Writing that test found a real crash, not a test artifact: `vertices.push(
...part)` on a dense line passes every vertex as an argument and overflows the
call stack — **one long real-world line would have taken the server down**
before the cap could refuse it. Both accumulators now push one at a time.

#### A line has no single coordinate — the three decisions

This was the question the ticket asked, and it has three different answers
because "where is this line" means three different things.

- **The popup anchors where you clicked** (`e.lngLat`). A 200-mile corridor has
  no position; the honest answer is *where you touched it*. A popup opening 80
  miles from the pointer reads as some other feature's.
- **Focus FRAMES the line** (`fitBounds` on the feature's own extent,
  `maxZoom: 12`), where a point still eases to zoom ≥ 9. Easing to a line's
  midpoint at zoom 9 shows three miles of it and no sense of where it runs;
  "show me this transmission line" means the line. The popup still opens at the
  anchor, because a popup needs one coordinate.
- **That anchor is the middle vertex of the path**, never the centre of the
  bounding box. A box centre is the obvious choice and is wrong: for an
  L-shaped or diagonal corridor it sits off the wire entirely, in a field. The
  middle vertex is always a coordinate the line passes through, and a test
  asserts exactly that — the anchor is `toContainEqual`'d against the feature's
  own vertices, and asserted **not** to equal the box centre.

**Hover is paint, not re-render.** `generateId: true` on the source plus
`feature-state` lets the stroke widen under the pointer through a `['case', …]`
width expression. It earns its place because transmission corridors cross: with
several lines overlapping, the highlight is the only thing that says which one a
click would take.

**Every line layer gets a wide invisible twin.** `internal-<slug>-line-hit` is
14 px at zero opacity, under `internal-<slug>-line`. A 2 px stroke is below a
finger's accuracy and nearly below a mouse's, and `line-opacity: 0` still
hit-tests. It is also in the click guard — without that, clicking a
transmission line would inspect the county it crosses.

The rendered feature is matched back to its rail row **by `feature.id`**, not by
the label-plus-nearest-coordinate a point uses: `generateId` numbers features by
index, which is exact, and matters because a click on a long line is nowhere
near the vertex that stands for it.

#### The names that moved, and the ones that could not

A type called `InternalPointLayer` holding a line is a lie a reader trips on, so
the types tell the truth now — `InternalFeatureLayer`, `InternalFeatureCollection`,
`featureLayersFrom`, `fetchInternalLayerFeatures`, and
`lib/internalPointLayers.ts` → `lib/internalFeatureLayers.ts`. All compile-time,
so the type-check found every site.

**Four names deliberately did not move, each because it is a contract with
something outside this ticket:**

| kept | why |
|---|---|
| `state.pointLayers` | **stored in the real bucket** — every saved view holds it |
| `internal-<slug>-points` and the other point map-layer ids | **pinned by `mapDeepLinks.cy.ts`**, which must not be edited |
| `internalPointLayers` / `waitForPointData` / `toggle.points` | component props and the `MapLayerState` facade |
| `data-testid="internal-point-layer"` | the row is the overlay row; only its swatch changed |

Lines therefore ride in saved views, deep links, wiki embed cards and MCP
`create_view` **with no change to any of them** — `pointLayers` simply holds a
line id now. One real bug came out of the rename and is worth recording: the
camelCase pass caught `selectedInternalPointLayers` as a substring but **not the
kebab-case `:selected-internal-point-layers` template bindings**, leaving a
prop declared under one name and passed under another — silently unchecked
checkboxes. Chased down by grepping the kebab spellings, not by the type-check,
which cannot see them.

#### Everything else that switches on geometry

Swept rather than left to be found later: the chat prompt lists a line as
`show_layer`-only and names it a *line* layer; MCP `parseMapState` treats every
non-county geometry as an unscorable overlay; the explorer's layer summary
returns a line's `labelKey`; "Show on map" frames a line on its corridor; the
Layers panel draws a **stroke-shaped swatch** instead of a dot; and the entity
rail says *Lines*, *Points*, or *Overlays* for a mixed set rather than claiming
"3 point layers" over a corridor.

And `replicate.ts` now **proposes a line layer over the `.geojson` it was
already writing**, when most of what it copied is a line — so replicating a
HIFLD/EIA transmission source produces a drawable layer with no hand editing.
*Most*, not *any*: a points layer with one stray polyline is still a points
layer, and a mixed bag proposing a line layer would silently drop everything
that is not one.

#### Verified live, read-only

Against the running dev stack and the **real** library — nothing created,
nothing pushed, the staged `redevelopment-sites` dataset left where it is:

- `GET /api/layers/internal` → 3 layers, **all still `point`**, `width` present
  on every row, every `bbox` unchanged. The library invented nothing.
- All three point layers' payloads re-fetched: identical counts, identical
  property sets, `_path` absent from every one. The parser change is invisible
  to them, as intended. (No `.geojson`-backed entry exists in the library's 83
  rows yet, so nothing's schema could have shifted.)
- A line layer **drawn on real Mapbox**, stubbed at the browser's `fetch` so the
  bucket was never touched: three strokes over Memphis in the declared
  `#2b6cb0` including the `MultiLineString`, the popup showing `_label` +
  `OWNER`/`VOLTAGE` with "Open record →", the rail headed **LINES** listing all
  three, the stroke swatch in the Layers panel, and the map framed on one line's
  extent after a rail click — `p7-3-line-layer-framed.png`.

#### Deliberately left

- **Proximity.** `findPointDataset` in `placeReport.ts` stays point-only, and
  `_lng`/`_lat` stay empty for a line row rather than being filled with its
  anchor. Distance from a site to a line is **P7-5**, and it wants real
  point-to-segment distance; seeding a centroid here would give P7-5 a plausible
  wrong number to undo.
- **Polygons and state geometry.** `LAYER_GEOMETRIES` is `county | point | line`
  and refuses the rest by name. State-level choropleth is **P7-9**.
- **`LibraryEntryView.vue` still says "Internal point or county layer"** for a
  line, from a `geometry === 'point' ? 'point' : 'county'` ternary at
  `src/views/LibraryEntryView.vue:1374`. **A one-line fix I did not make** —
  `src/views/` is P7-2's territory this round. Reported rather than edited.
- No legend entry for a line, matching points (P5-28's deferral); the swatch is
  the only colour affordance.

#### Gates

Client **1,999 / 99 files** (was 1,928 / 98). Server **2,272 passed / 14
skipped** (was 2,222 / 14) — the two per-user-limiter cases fail only under
full-suite contention and pass alone, verified; `mcp.test.ts` green. Both test
trees also carry P7-2's concurrent work, so neither delta is all this ticket's.
Client and server type-checks clean — the two remaining `vue-tsc` errors are in
`WorkingSetWorkspace.spec.ts`, an **untracked file P7-2 created mid-run**, and
neither is caused by this change (`popupFields` was already required at HEAD).
Build green, bundle-leak check passed (**61 files, 10 canaries**); entry chunk
**518.00 kB raw / 172.52 kB gz** against 515.18 / 171.60 — the +2.82 / +0.92 is
the line paint and geometry arithmetic, which sits in the entry chunk because
the canvas imports it; P7-2's new surface is in a lazy chunk. E2E **all 6 specs
passed, 24 passing / 3 pending**, and **`cypress/e2e/mapDeepLinks.cy.ts` is
byte-for-byte unedited** (`git diff` empty, and no file under `cypress/` is
modified at all).

---

## P7-4 [FEATURE] A map block in a page

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** P6-14, P7-1

### Why
The embedded map views Nick named: *"richer page + data analysis combined editing
and interactivity with embedded map views"*. `WikiPageView` renders markdown and has
no block that mounts a canvas. P6-14 settled the in-page pane contract for browsers;
this applies it to pages.

### Design
A page gains a block that mounts `MapCanvas` against a saved view or a working set.
A page embeds **views**; views read from the set — so changing what a story *shows*
is a view change and changing what it is *about* is a working-set change.

**Known obstacle, found by P6-14 and recorded rather than discovered again:**
`position: sticky` does not work for a pane here. These route roots are
viewport-height flex items of `App.vue`'s `main`, so a sticky child's containing
block is one screen tall. A story map that follows the reader down the page needs
the shell's scroll model changed — size that honestly or scope it out.

### Acceptance criteria
- **Given** a page with a map block, **then** it renders the named view's state.
- **Given** a page with no map block, **then** no map code is fetched.
- **Given** a phone, **then** the block degrades rather than mounting a second WebGL
  context.

### Tests
The block rendering a view; nothing fetched without one; the phone path.

### ✅ DONE (2026-10-06)

#### How a block names its view

A third keyword on the fence `view:`/`entry:` already use:

````
```map:memphis-siting
```
````

**It names a VIEW, never a working set**, and that is §F.1 rather than a
shortcut. A set holds no framing — no viewport, no palette, no sort — so there
is nothing to show it *with* until a view supplies one; P7-2 hit the identical
wall and put the two interfaces on `/views/:slug` for the identical reason. What
the block draws follows from which kind of view it got:

| the view | draws | framed by |
|---|---|---|
| ad-hoc | its own saved state — layers **with their weights**, filters, limit, region, point overlays | its own saved viewport |
| set-backed | the **set's** layers (P7-2: what to draw is a question about the data) | still the view's viewport |

So changing what a story *shows* is a view change and changing what it is
*about* is a working-set change, and a story wanting a second framing of one
set embeds a second view of it rather than copying a number.

`map:` is a third **keyword**, not a new tag or attribute: the placeholder is
byte-identical to a card's but for the word, so `WIKI_TAGS` and `WIKI_ATTR` did
not move and the worst a forged `map:` div can do is what a forged `view:` div
could — a test asserts that equivalence by rewriting one into the other.

**The likeliest authoring mistake is answered rather than reported.** Because
§F.1 says a page embeds views, `map:<working-set-slug>` is the natural slip, and
*"Saved view not found"* is a true sentence that sends somebody looking in the
wrong place. A 404 therefore asks whether the slug is a set, and if it is says
so and **names the views over it** — the things that can be embedded. That
lookup is itself a dynamic import, so a page whose blocks all resolve never
loads the working-set client at all.

#### The sticky/scroll obstacle: scoped out, and why

**The map does not follow the reader, deliberately.** P6-14 recorded the reason
and it is structural, not a CSS mistake: `App.vue` sets `.app-container` to
`height: 100vh` with `main` a `flex` box at `min-height: 0`, so every route root
is a viewport-height flex item and a sticky child's containing block is one
screen tall. Making a story map track the scroll means moving the scroll to the
document, and three things hang off it not being there: the public map's
full-bleed canvas, every internal route's internal scrolling, and the
byte-for-byte logged-out header snapshot `App.vue` carries. That is a change to
the **shell**, in a ticket about putting a map in a **page** — so this ticket
does not make it, and does not half-make it either: `App.vue` is untouched.

The block sits in the document flow instead, and that is also the better reading
of what was asked. A data story's map is an illustration at the point in the
argument that needs it — the same thing P5-54's embed card already is, "an
illustration beside an argument" — placed by the author, and a page may hold
more than one. A persistent sidebar would have been one map for a whole page,
which is a different and smaller feature.

#### A page with no map block fetches no map code

Expressed as code, not as care: `renderMapBlock` reaches the component through a
**dynamic `import()` inside the `map` branch**, and everything decidable without
a map — the slug is not a view, the view is a table view, the page is already
full — is decided above that import. A page with no `map:` placeholder never
calls the function, so the factory never runs.

Measured three ways:

1. **The module graph**, in `wikiEmbeds.spec`: the component is mocked with a
   factory that counts its own evaluations, and a page of `view:` + `entry:`
   cards leaves the count at **0**. A mocked factory that never ran is the whole
   claim, since mapbox-gl and the county files sit behind the component.
2. **The chunk graph**: `WikiMapBlock-*.js` (4.16 kB / 1.93 kB gz) and
   `useMapPane-*.js` (2.50 kB / 1.22 kB gz) are their own chunks, reached only
   through `WikiPageView`'s **dynamic** import list.
3. **A real build, two pages, same bytes** — `vite preview` over a fixture API,
   one page with blocks and one without, the only difference being the fence:

   | fetched | page with a block | control |
   |---|---|---|
   | `WikiMapBlock-*.js` + css | ✅ | ✗ |
   | `useMapPane-*.js` + css | ✅ | ✗ |
   | `workingSets-*.js` | ✅ (the set diagnosis) | ✗ |
   | `counties.*.geojson` | ✅ **507 kB gz** | ✗ |
   | `county-data.*.json` | ✅ **563 kB gz** | ✗ |

   **1.07 MB gzipped of county data, paid by the page that shows a map and by no
   other** — which is the number the criterion is really about.

**One thing the criterion does NOT get, stated rather than glossed.**
`mapbox-gl` (390 kB gz) is in the **entry** chunk's static graph and is
`modulepreload`ed from `index.html` on *every* route — because `Map.vue` imports
it and the router imports `HomeView` statically. That is pre-existing and
untouched by this ticket (the control page fetches it too, identically), and
`MapCanvas` is in the entry chunk for the same reason. Worth a ticket; it is not
this one, and claiming the block fixed it would be false.

#### The hazard this found: a canvas per keystroke

`PageEditor`'s preview re-renders its whole `v-html` on **every keystroke** and
re-runs `hydrateEmbeds` over the new DOM. For a chart that is cheap. For a map
it is a mapbox-gl **WebGL context built and torn down per keystroke**, and a
browser keeps only so many before it starts dropping the oldest — a writer would
have blanked the maps higher up their own page by typing.

So hydration takes a host option: the page says nothing (it draws), the editor
says `liveMaps: false`, and the block renders *itself* — naming the view it will
draw — with no canvas. Verified live: **15 keystrokes, 0 WebGL contexts**, and
the writer still sees both blocks and what each will be. Related, and the reason
the bookkeeping is now load-bearing rather than tidy: `mountedCharts` became
`mountedApps`, because the sweep that unmounts an app whose node left the
document is what calls `map.remove()` and releases the context.

A page is also capped at **`MAP_BLOCKS_LIVE = 3`** live canvases, the same
bounded-by-construction rule `EMBED_RESULTS_SHOWN` and `EMBED_ROWS_SHOWN`
already follow; the rest say how many a page holds and link out. The slots are
assigned **synchronously, in document order, before anything is awaited** —
three blocks checking a running count in the same tick would all read zero and
all mount — which also means the cap falls on the blocks furthest down the page.

#### One reader of a saved map view, not two

`Map.vue`'s `applySavedView` carried a 40-line inline field-by-field reader for
`?view=<slug>`, and the block needed the same answer. A second copy would have
been two definitions of *"what a saved map view shows"*, free to drift the way
§F.1 warns a number can — so it is now **`mapStateOf`** in `lib/views.ts`, the
third sibling of `tableStateOf` and `compareStateOf`, and `Map.vue` calls it.
The inline copy is deleted. It is null for a table or compare view on purpose:
both also store a `layers` key, and a table view's is county-context ids (P5-48)
which, applied as scoring layers, would silently draw nothing — the failure mode
that looks like a bug in the data. That reader had no tests before and has
eleven now, including every way a hand-edited document can be wrong.

`MapFitRequest` gained `center`/`zoom`, because a **saved viewport is a decision
and the other two fits are derivations**: a host says which rows matter and the
canvas computes a box, but nobody computes the place somebody chose to look at.
A block holds no mapbox handle, so it needs to say it through the one
"where to put the map" door. Both halves required together; half a viewport is
ignored rather than jumped to.

#### A pre-existing bug this fell over

**`embedFence` has never produced a working embed.** It wrote
<code>```view:x```</code> on one line, and CommonMark forbids backticks in a
fence's info string — so that is not a fenced block at all, it is a paragraph
containing an inline code span, and every embed the picker inserted since P5-49
rendered as the literal text `view:x`. The opening fence has to end the line.
Found while adding `map:`, which would otherwise have shipped a button that
produced a dead block. Fixed, and the test that claimed to check "the fenced
block hydrateEmbeds understands" now checks it by rendering it, for all three
kinds.

#### Also landed

- **`WikiMapBlock.vue`** is six lines of map (`useMapPane` + `useMapState` +
  `MapPane`) and mostly degrading, which is right: a block sits in somebody's
  prose, so every way it can fail to be a map has to be a sentence — not a view,
  no layers, preview, capped, too narrow, set gone. Each names what to do
  instead, and for a set-backed view that is the set's workspace rather than the
  public map, because that is where its two interfaces are.
- **The reader can put it away.** Close unmounts the canvas (releasing the
  context) and offers it back; a resize does **not** undo a Close — the reader
  decided, the window did not — while a window growing past the breakpoint does
  draw the map it could not hold. `useMapPane` still owns the other direction.
- **The picker can insert one**: a saved *map* view with at least one layer gets
  an "as a map" action beside the card action, read off the catalog row's own
  `meta.type` / `meta.layers` (`savedViewMeta` already puts them there — no
  second request, no new endpoint). Offered only where it can work: a button
  leading to "there is no map in it" is worse than no button.
- The host lends its router to the mounted app, since `MapCanvas` resolves one
  for its feature popups and an app created by `createApp` has no plugins. The
  block's own links are plain anchors, which `WikiPageView`'s existing click
  interceptor already routes.
- The block component is imported through **one memoised promise**. Several
  `map:` placeholders hydrate concurrently, and N concurrent `import()`s of one
  module is N chances to resolve it differently for no benefit — which is not
  theoretical: it is what the spec caught, one block getting the stub and the
  next the real component.

#### Deliberately left

- **Site layers (P5-78) are not restored by a block.** `MapCanvas` has no
  site-layer support at all — `restoreSiteLayers` lives in `Map.vue`, which owns
  the on-demand GeoJSON loader — so no `MapPane`-based map draws them, P7-2's
  workspace included. A block renders the scoring layers, the point overlays and
  the viewport; the "Open the full map" link is where a view's contamination
  overlays still come back.
- **No page and no view were created in the real library.** Both live checks ran
  against a **fixture API on port 4599 serving literals**, with the client built
  against it on its own port — P7-2's method, and P7-1's rule: created objects
  are hard to un-create. The real bucket was not read or written.

#### Gates

Client **2,088 passed / 100 files** (was 2,008 / 99) — P7-4's own share is
**+55**: `views.spec` 42→53, `renderMarkdown.spec` 20→25, `wikiEmbeds.spec`
32→45, new `WikiMapBlock.spec` 22, plus `MapCanvas.spec` +1, `PageEditor.spec`
+2 and `WikiPageView.spec` +2; the rest of the delta is P7-5 landing in the same
tree. Server **2,367 passed / 14 skipped** (was 2,272 / 14), run one file at a
time, green — **this ticket touched no server file**, so that delta is P7-5's
entirely. Both type-checks clean. Build green, bundle-leak passed (63 files, 10
canaries). Cypress **27 / 24 passing, 3 pending, all specs passed**, with
`mapDeepLinks.cy.ts` unedited (`git diff` empty) and 4/4 green.

Entry chunk **519.05 kB raw / 172.83 kB gz** in the shared tree, but that is two
tickets, so P7-4's own share was measured the way P7-2's was — a clean worktree
at `f4b2b47` with only this ticket's files copied in: **517.83 → 518.54 kB raw,
172.27 → 172.48 kB gz, +0.71 kB raw / +0.21 kB gz.** That is `mapStateOf` and
the viewport fit, which `Map.vue` pulls, minus the inline reader it gave up; the
map block itself is **entirely lazy** and adds nothing to the entry. Screenshots
`p7-4-map-block-in-a-page.png`, `p7-4-degraded-blocks.png`,
`p7-4-phone-degrades.png`, `p7-4-editor-preview-no-canvas.png`.

---

## P7-5 [FEATURE] Proximity between two layers

**Type:** Feature · **Priority:** P1 · **Size:** L · **Dependencies:** P7-1, P7-3

### Why
Spec §F.2. *"Distance from site to development"*, *"brownfields in connection to
transmission lines"*, *"greenfields + their capacity + proximity"*. **Nothing in the
system relates two datasets to each other** — every analysis today is single-dataset
or single-place.

### Design
For each row of dataset A, the distance to the nearest feature of layer B, and
optionally a count of B within *n* miles. Output is a **derived column on the
working set**, never a mutation of either source — provenance stays clean and the
source stays re-fetchable.

**Server-side**, for three reasons: the result must be stable and citable (a story
quotes it), it joins datasets the browser does not hold, and chat/MCP must be able to
ask for it. `@turf/turf` is already a dependency; `distanceMiles` already exists in
`placeAdapters/shared.ts`.

**Tiering is not optional here** (spec §F.4b): proximity over 13 sites × 1 layer is
microseconds; over 190,000 brownfields it is a batch job. Build the on-demand tier
with an **explicit row-count ceiling that refuses rather than crawls**, and a local
`npm run library -- proximity` pass for bulk. The cardinality decides the home, not
the operation.

### Acceptance criteria
- **Given** 13 sites and a line layer, **then** each site gains a distance to the
  nearest feature, written to the set.
- **Given** a row count over the ceiling, **then** it refuses with a plain reason
  naming the local pass, rather than running slowly.
- **Given** a re-run with unchanged inputs, **then** the stored result is reused.
- **Given** the source datasets, **then** neither is modified.

### Tests
Point-to-point and point-to-line; the ceiling refusing; reuse on unchanged inputs;
sources untouched; the CLI pass.

### ✅ DONE (2026-10-06)

#### The shape of a derived proximity column

It is the shape P7-2 already reads, because P7-2 said what it could read and
this had to be written to fit — **GEOID-keyed, no exceptions**:

```json
{ "id": "miles-to-transmission",
  "label": "Miles to nearest Transmission lines",
  "unit": "miles",                       // 'count' for the second column
  "method": "Great-circle miles from each of 11 rows of Redevelopment sites to the
             nearest of 4 features of Transmission lines; counting features within
             10 miles; point-to-segment where the feature is a line; by county, the
             nearest row's distance (distinct features for a count); 2 rows have no
             coordinates.",
  "computedAt": "2026-10-06T05:59:03.647Z",
  "values": { "47157": 1.2313, "04019": 13.0733, "39159": 21.9613, … },
  "analysis": { "type": "proximity", "from": "redevelopment-sites",
                "to": "internal-transmission", "within": 10,
                "columns": ["miles-to-transmission", "miles-to-transmission-within-10mi"],
                "rowsFile": "derived/miles-to-transmission.rows.json",
                "rows": 11, "measured": 9, "targets": 4,
                "by": "npm run library -- proximity", "at": "2026-10-06T05:59:03.647Z" } }
```

A run writes **one column, or two** — the distance always, the count when a
radius was asked for. `formatDerivedValue` already knew both units: P7-2 wrote
`'miles'` and `'count'` into it before anything produced one, so the explorer
printed `1.2 mi` and `1` with no client change at all.

**The per-row numbers are the analysis; the county column is a projection of
them.** "Distance from site to development" is a fact about a *site*, and the
Memphis cluster is four sites in 47157 — so the full per-row table (label,
county, miles, nearest feature's name, count) goes in `derived/<id>.rows.json`
beside the manifest, and `GET /api/working-sets/:slug/proximity` serves it back
so a sentence a story quotes outlives the response that computed it. The two
aggregations into the county column are the only honest ones, and `method` says
both out loud:

- **distance: the nearest row's.** A mean of four unrelated sites is not a fact
  about anything; "how close does this county get to the wire" is.
- **count: DISTINCT features across the county's rows**, never the sum — two
  sites each near both corridors is two corridors, not four.

A county whose rows reach nothing gets **0**, not an absence: *"no transmission
line within five miles of this site"* is the finding.

**`analysis` is provenance, not a cache key.** §F.4c wants what produced a
number, from which inputs, when and by whom; reuse falls out of it by field
equality — same table, same layer, same radius — which is readable in the
manifest rather than hidden in a digest. No hash and no clock were invented.

#### How point-to-line distance is computed — and why not with turf

P7-3 left this deliberately: `_lng`/`_lat` stay empty for a line because
site-to-line *"wants real point-to-segment maths; a centroid here would give it
a plausible wrong number to undo."* So it is the real thing — exact spherical
geometry, in `services/proximity.ts`:

For segment **A→B** and point **P** as 3D unit vectors, `n = A × B` is the
normal of the arc's plane. The nearest point on the great *circle* is P
projected into it, at angular distance `asin(|P·n| / |n|)` — no normalisation
and no square root in the common case. Whether that foot lies **on the arc**
rather than on the far side of the planet is two sign tests (q rotationally
between A and B about n); when it does not, the answer is the nearer endpoint —
the distance to the end of the wire. Angles use `atan2(|u × v|, u·v)` and never
`acos`, which loses all its precision at exactly the small angles every real
site-to-wire distance is. A degenerate segment — a repeated vertex, which real
shipped geometry has — falls back to a point distance instead of dividing by
zero.

A point target is a one-vertex "part", so **point-to-point and point-to-line are
one code path**, and a test asserts the point case agrees with
`placeAdapters/shared.ts`'s own `distanceMiles` to ten places. Same sphere, same
radius, one answer.

**`@turf/turf` is not usable here, and that is a finding rather than a
preference.** It is a dependency of the **root** package, for the browser. The
API deploys with Root Directory = `server` (DEPLOY.md), and every bare import
under `server/src` is declared in `server/package.json` — checked, with no
exception. A `@turf/turf` import would resolve in dev and in the whole test run
by node's upward walk to the root `node_modules`, and be **absent in
production**: every gate green, a module-not-found on Railway. The maths wanted
was `nearestPointOnLine`, which is the forty lines above.

Writing it also bought the speed the bulk tier needs. Vertices are converted to
unit vectors **once**, into a flat `Float64Array`, so the inner loop allocates
nothing; and each feature carries a bounding box whose **rigorous lower bound**
on distance lets a row skip it outright. That bound has to be a true
under-estimate — over-estimating does not make the answer slow, it makes it
*wrong*, silently returning somebody else's nearest feature — so both terms are
the exact haversine components (`cos φ₁·cos φ₂ ≥ cos²(max|φ|)` is what licenses
the longitude one) rather than a miles-per-degree approximation, the
antimeridian gap is folded rather than clamped, and a test checks 2,400
point/feature pairs against the brute force for **exact** equality.

#### Where the ceiling sits, and what it says

Two bounds, in `proximity.ts`, applied by the request and **not** by the CLI —
that split is the ticket's architecture in one line:

| | bound | why |
|---|---|---|
| `PROXIMITY_ROWS_MAX` | **5,000 rows** | the spec's own "explicit row-count ceiling"; the same order as `ROWS_MAX`, and far past any curated set |
| `PROXIMITY_SEGMENT_BUDGET` | **20,000,000** rows × vertices | **the row cap cannot see the work** |
| `PROXIMITY_WITHIN_MAX` | 500 miles | past the width of the country a "count within" is counting the layer |

The second exists for P7-3's reason, which cost a stack overflow to learn: a few
hundred transmission corridors is a few hundred features and can be millions of
vertices, so a thousand rows against a dense national layer is a billion segment
tests while every declared cap reads green.

**20 million is measured, not guessed: ~10 million tests per second**, in the
worst case where the prefilter can skip nothing (one feature whose extent is the
whole country). So the budget is about **two seconds** — and two seconds is the
number that matters because this is *synchronous* work on one Node event loop.
A forty-second proximity run does not make one request slow, it makes the whole
API unresponsive, health check included, and it is the same single instance
whose rate-limit and budget counters DEPLOY.md says are in-memory. Refusing is
the better failure.

It is deliberately a **nominal** bound — rows × vertices, no credit for the
prefilter, which in practice skips about 98% (5,000 rows against a real
200,000-vertex transmission layer measures in 1.2s, not 100s). So it refuses
some work that would have been fast. That is the right direction to be wrong in:
§F.4b says build tier 2 for small-N only and keep tier 1 as the answer above it.

What it says, verbatim, as a **413** — and the sentence is the instruction, so it
is relayed unchanged through the route, through MCP, and onto the page:

```
6,000 rows is a batch job, not a request — this runs at most 5,000 rows so it
answers rather than crawls. Run it locally instead: npm run library -- proximity
<set> --to <layer> [--within <miles>], then push and reindex.
```

```
1,500 rows against 480,000 vertices is 720,000,000 point-to-segment tests, past
the 20,000,000 this runs in a request. The row count alone cannot see this — a
few hundred transmission corridors can be millions of vertices. Run it locally
instead: …
```

A refusal is never a half-run: the set is asserted to carry zero derived columns
afterwards.

#### The local pass

`npm run library -- proximity <set> --to <layer> [--from <dataset>] [--within
<miles>] [--id <column>] [--apply] [--dir <path>]`, over a **pulled tree** like
`retag` — no bucket, no database, and **no ceiling at all**, which is the whole
reason it exists. **Dry run by default**, `--apply` to write: this rewrites a
manifest, so it follows `retag` rather than `geocode`, and the manifest is
re-serialised from the parsed object so every field the pass does not touch
comes back byte-identical.

It reads layer B's geometry through a new `featureGeometryOf`, **uncapped** —
`LAYER_MAX_VERTICES` bounds what the API *ships* and this ships nothing. The
on-demand tier deliberately keeps going through the capped projection, so a
layer too big to ship is refused there by name; the two tiers can never disagree
about a number, one of them declines instead.

Run against the **staged 11-row `redevelopment-sites` table**, read-only from a
copy, four synthetic corridors:

```
From Redevelopment sites (11 rows) → Transmission lines (4 features, 164 vertices), counting within 10 miles

row                                   county  miles    within  nearest
Valero Memphis Refinery               47157   1.23     1       Allen–Southaven 500kV
TVA Allen Combined Cycle Plant        47157   2.56     1       Allen–Southaven 500kV
xAI supercomputer                     47157   2.95     1       Allen–Southaven 500kV
Nucor Steel Memphis Plant             47157   3.06     1       Allen–Southaven 500kV
Project Blue                          04019   13.07    0       Tucson–Vail 345kV
…
11 rows · 9 measured · 6 counties · 2 with no coordinates
Nothing was written. Rerun with --apply once the report reads right.
```

Nine of eleven located is the real table's own state, which its manifest already
says. The four Memphis rows land in one county and the column takes 1.23 — the
nearest — which is why the aggregation is not an edge case.

#### Two refusals that are design decisions, not validation

- **The county comes from a column, never from a reverse geocode.** P7-2's
  reader is GEOID-keyed and `countyForPoint` is one Census request *per row*;
  `coverage.ts` already refuses to grow a geometry service on this server for
  exactly this reason (P6-19: *"inventing a state is worse than declining to
  name one"*). So a county column is an **input**, and a table without one is
  told the `geocode` command that makes it — the pass that produced the staged
  table's own GEOIDs.
- **The set is the scope.** A dataset or layer the set does not name is refused
  by name: *"a measurement against something outside the set would not be the
  question the set is asking."* P7-1's rule that a shortlist inside a set cannot
  reach outside it, applied to the analysis. A county layer is refused too —
  it has values, not features.

#### Also landed

- `POST` and `GET /api/working-sets/:slug/proximity`; MCP **`measure_proximity`**,
  the sixth write tool and the first that is an *analysis* rather than a filing —
  §F.2's own third reason for server-side is that chat must be able to ask. A
  reuse is **not** audited, because nothing happened.
- `putDerivedColumns` in `libraryWorkingSets.ts` — the only writer of `derived`,
  replacing by id **in place** so a re-run does not shuffle the column order a
  table's headers are drawn in. Inline under 64 kB, a file beside the manifest
  over it: a county column tops out at 3,142 entries so inline is the normal
  case, and the file path exists because P7-1 made the set a directory for it and
  *a path nothing ever takes is a path nobody can trust*.
- **A row-shape bug P7-1 could not have seen.** Reindex groups **every** file
  under `library/working-sets/<slug>/` onto the entry and sums the bytes, and
  `writeWorkingSet` listed only `meta.json` — so the first ticket to put a second
  file in that directory would have made a route-written row differ from a
  rebuilt one, which is the single invariant P7-1's design note stands on. The
  file list is now read from the same place reindex reads it; a test writes a
  column, reindexes, and asserts identical keys and identical `bytes`.
- `/analysis` gains spec §F.5's first set-scoped tool card, **Measure proximity**
  — offered only when the set has both halves of the question, and listing only
  point and line layers, read off the catalog the page already loaded (a
  dataset's `meta.layer` *is* its layer declaration, so this costs no request).
- `normalizeGeoId` now forgives a trailing `.0`. It was the one spelling the
  server's canonical reader rejected while `derivedKeyAsGeoId` and the client's
  own normaliser both accepted it — so a GEOID column a spreadsheet wrote as a
  float read as no county at all, and a county layer over it drew nothing.
- **One real bug the specs caught**, worth recording because the test found what
  review would not: `v-model` on `<input type="number">` **casts to a number**,
  so `proximityWithin.value.trim()` threw a `TypeError` the instant anybody typed
  a radius — in the browser, not only in jsdom. Read through `Number()` now.

#### Deliberately left to P7-6

- **Staleness, and a results table.** The column records its inputs and who ran
  it; P7-6 adds their **versions** and the "changed input marks it stale, still
  renders, offers a re-run" half. Reuse here is field equality on that same
  record, so there is no second keying scheme to undo — which is what the ticket
  asked for.
- **The on-demand tier still writes only onto a set.** §F.4c's one table that
  tier 1 and tier 2 both write to is P7-6's; today the CLI writes a manifest and
  the route writes the same manifest, which is already "the map and the table do
  not care which produced a number".
- **No composite layers** (P7-8), and the derived column still is not painted as
  a choropleth — P7-2's deferral, unchanged.

#### Gates

Client **2,088 / 100 files** (was 2,008 / 99). Server **2,367 passed / 14
skipped** (was 2,272 / 14). New suites: `services/proximity.test` 31,
`services/workingSetProximity.test` 27, `cli/proximity.test` 24, plus
`routes/workingSets.test` 34→44 and **+80 client** (`lib/workingSets.spec`
27→40, `views/AnalysisView.spec` 27→40, the rest P7-4's concurrent work). Both
type-checks clean.

**One server failure on the first full run, reported rather than papered over:**
`mcp.test.ts` threw `ENOTEMPTY` from `rmSync(dataDir)` in its own `afterEach` —
a filesystem teardown race, not an assertion, in a file this ticket only edited
two expectation lists in. It did not recur: the file passes alone (61/61) and the
whole suite re-run is **2,367 passed, 100 files passed / 1 skipped**. Worth
noting against **P7-11**, which made the suite trustworthy by serialising it:
this is a *different* flake class — not shared module state but a temp-dir
removal racing an in-flight mirror write.

Build green, bundle-leak check passed (**63 files, 10 canaries**). Entry chunk
**519.05 kB raw / 172.83 kB gz** against 518.34 / 172.64 — **but that delta is
not this ticket's.** The tree carries P7-4's concurrent edits to `Map.vue`,
`MapCanvas.vue`, `wikiEmbeds.ts` and `views.ts`, all of which are in the entry
chunk. Measured by rebuilding with only this ticket's two client files reverted:
**519.05 / 172.84 without, 519.05 / 172.83 with — P7-5's own share of the entry
chunk is zero.** The whole surface rides in `AnalysisView`'s lazy chunk, 8.30 →
11.46 kB raw (4.29 kB gz) plus 6.63 kB of its own CSS.

**Nothing was created in the real library**, keeping P7-1's and P7-2's rule —
there is still no delete route. The live check ran against a **fixture API on a
separate port** serving literals, with the numbers copied out of the local CLI's
own report rather than invented, so what the browser shows is a real
measurement. The staged `redevelopment-sites` dataset was **copied** to a temp
tree and read there; its files are byte-identical and unpushed. Screenshots
`p7-5-analysis-form.png`, `p7-5-analysis-measured.png`,
`p7-5-ceiling-refusal.png`, `p7-5-data-interface-sorted.png`,
`p7-5-map-interface.png`, `p7-5-map-derived-columns.png`.

---

## P7-6 [FEATURE] Analysis results are stored, not recomputed

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** P7-5

### Why
Nick (2026-10-03): *"we should also be saving to the db when new composite layers /
analyses are generated so they don't need to be regenerated anytime someone wants to
relate those layers."*

### Design
One table of analysis results, keyed by the analysis definition (type + parameters)
and the working set. **Tier 1 (local batch) and tier 2 (on-demand) write to the same
place**, so the map and the table do not care which produced a number.

**Keyed by content, not by clock.** The place report's 7-day TTL is right for a
report of the live world; an analysis over held datasets is stale only when an
*input* changes. So the key records the inputs and their versions, and a changed
input marks the result stale rather than a timer expiring.

**Stale must be visible, never silent.** A published data story quoting a number that
quietly drifted is worse than one that recomputes — the same honesty rule P6-26
applied to cached reports, and the same rule P6-34 applied to unverified metadata.

### Acceptance criteria
- **Given** a stored result and unchanged inputs, **then** nothing recomputes.
- **Given** a changed input, **then** the result is marked stale, still renders, and
  offers a re-run.
- **Given** a result, **then** it records what produced it, from which inputs, when
  and by whom.

### Tests
Reuse; staleness on a changed input; stale rendering rather than vanishing;
provenance per result.

### ✅ DONE (2026-10-06)

#### One record, one field wider — not a second store

P7-5 said what it was leaving: *"the column records its inputs and who ran it;
P7-6 adds their **versions** and the stale-but-still-rendering half … no hash,
no clock, no second keying scheme to undo."* That is exactly what this is. The
`analysis` block on a derived column gained **`inputs`** and nothing beside it:

```json
"analysis": {
  "type": "proximity", "from": "redevelopment-sites", "to": "internal-transmission",
  "within": 10, "columns": [...], "rowsFile": "derived/...", "rows": 11,
  "measured": 9, "targets": 4,
  "inputs": [
    { "slug": "redevelopment-sites", "role": "from", "file": "redevelopment-sites.csv",
      "bytes": 4821, "keys": "point|redevelopment-sites.csv|lat|lng||||name",
      "content": "a28deff27a8ab1e4", "at": "2026-10-06T05:58:11.204Z" },
    { "slug": "transmission", "role": "to", "file": "transmission.geojson",
      "bytes": 18244, "keys": "line|transmission.geojson||||||NAME",
      "content": "7b91de0c4a1f8e32", "at": "2026-10-05T22:14:03.880Z" }
  ],
  "by": "maria", "at": "2026-10-06T05:59:03.647Z"
}
```

§F.4c's *"one table of analysis results, keyed by the analysis definition
(type + parameters) and the working set"* **already existed** — it is the set's
manifest, written by the CLI and by the route alike, which is why P7-5 could
say the map and the table do not care which produced a number. Adding a DB
table would have broken P7-1's load-bearing invariant that *a reindex rebuilds
an identical row from the bucket alone*, so the store stayed where it was and
only the key got deeper. Reuse is still field equality a person can read —
same table, same layer, same radius — and staleness is the same comparison one
level down, on the bytes those slugs named.

#### What counts as an input version, and how a change is detected

Four facts about the file the run actually read. Three are the comparison; one
is only ever a hint.

| field | in the comparison? | what it catches |
|---|---|---|
| `bytes` | **yes** | a different size is a different file — decided with no read at all |
| `keys` | **yes** | the layer block's geometry/column declaration. A block repointed from `lat` to `latitude`, or at another file, changes the answer and **cannot change the byte count** — the same keys `internalLayers.ts` folds into its own version string, for the same reason |
| `content` | **yes**, and it is the tie-break | `35.060080` → `35.060081`. A corrected coordinate is a real edit that preserves every byte count, and only a hash sees it |
| `at` | **no** | the entry's `updatedAt` when the run read it — a **short circuit only** |

**`at` is a hint and never a verdict, and that is the whole of "never by
clock".** If nothing has been written to the entry since the run, its bytes
cannot have moved, so the hash is skipped and the check costs one row read. A
stamp that *has* moved never means stale — it means *read the bytes and ask
them*. That asymmetry is load-bearing in both directions: `patchEntryManifest`
re-indexes with no `updatedAt`, so **a retag, an inspection pass or an
organization being filled in bumps the stamp**. Had the stamp been the verdict,
every metadata edit would have marked every derived column on the set stale,
and a reader would have learned within a week to ignore the label. A label that
cries wolf is worse than no label, which is this ticket's own argument.

The two tests that pin the rule pull in opposite directions, because either one
alone can be passed by the wrong implementation:

- *stays FRESH when the clock moves and the bytes do not* — the same bytes
  re-pushed with a later `LastModified`, reindexed. **Nothing recomputes.**
- *goes STALE when the content changes and the byte count does not* — one
  digit, byte count asserted identical first.

**Cosmetics are deliberately excluded.** `color`, `width`, `name` and
`popupFields` are not in `keys`: they change how a layer is drawn and not one
number it produces. A test restyles a layer and asserts the column stays fresh.

**Three verdicts, not two.** `unknown` is its own answer, for a result written
before this ticket (no versions recorded) or a file the bucket cannot re-read.
Calling that fresh would be a claim nobody made; calling it stale would
recompute work that is probably fine. "This cannot be checked" is the P6-34
answer, and the client's reader defaults a missing verdict to `unknown` **never
to `fresh`** — a column drawn as current because a field was absent is the exact
failure this ticket exists to prevent, and it is the kind that looks like
nothing at all.

#### What a stale result looks like to a reader

It **renders, with every value it had**, and gains a label. P6-26's cached
report is the precedent for the vocabulary but not for the behaviour: today a
stale place report is **404'd** and the page offers to run it again. A derived
column cannot do that — a published story quotes the number — so this is the
first thing in the library that is stale *and still answers*.

On the map interface, per column:

```
Miles to nearest Transmission lines  [OUT OF DATE]  1.2 mi to 22.0 mi across 2 counties  [Run again]
Measured 10h ago by npm run library -- proximity · “redevelopment-sites” has changed
since this ran — 4,821 bytes, now 5,002, so this number may have drifted.

Transmission lines within 10 miles  [UNCHECKED]  0 to 1 across 2 counties
Measured 8d ago · This was computed before its inputs were recorded, so whether it
still stands cannot be checked.
```

Three things that are decisions rather than styling:

- **Which input moved, not merely that one did** — *"4,821 bytes, now 5,002"*,
  the two numbers side by side, which is how the explorer's own saved-view note
  already says a table has grown. Every changed input is named; none is
  swallowed into "an input changed".
- **The badge is `--blo-orange-deep`**, P6-34's "waiting on a person" colour,
  not another quiet grey chip. An out-of-date value must never be
  indistinguishable from a current one.
- **A fresh column says only when and by whom**, and `by` prints nothing when
  nobody was recorded rather than "someone" (P6-27). A caveat on every column is
  a caveat on none.

**The label reaches BOTH interfaces, which took a second surface.** The derived
list lives inside the map pane, and inside the explorer's table a derived column
is indistinguishable from a county-context one — same header, same cells, same
CSV (P7-2). So the count also sits in the workspace **header**, outside both
panes: *"A derived column is out of date: Miles to nearest Transmission lines.
… The numbers still show, with what changed, on the Map interface."* A caveat
that only held on the map would be half a feature wearing the name of a whole
one.

**The re-run is offered where the number is read**, not on a form elsewhere.
`rerun` comes back on the column, read off the stored record — `{type, from,
to, within}` — so nothing is retyped and nothing is guessed, and a column that
records no analysis gets **no button at all** rather than one that would have to
guess. A refused re-run shows the ceiling's own 413 sentence naming the local
pass, with the number still on screen behind it.

#### Served, not recomputed — and the response says which

This is the half the owner asked for, and it inverts P7-5's default. A stored
result whose inputs still hold is **served**: nothing parsed, nothing measured,
nothing written. The response says `served: "stored" | "computed"` outright,
because *"minimise Railway computation"* is only a claim you can check if the
answer says which it did.

- **`GET /api/working-sets/:slug/columns` computes nothing, ever.** Every reader
  of a derived number comes through it — the map pane, the table, the CSV — and
  it now returns the stored values plus a verdict. A page drawing a 190,000-row
  proximity column costs one manifest read and two fingerprint comparisons. Two
  columns from one run are checked **once**, keyed on the analysis's own stamp.
- **`POST …/proximity` serves when it can.** Stale is the only thing that makes
  it compute, and then `staleNote` rides back with the new number — *"Measured
  again — “redevelopment-sites” has changed since this ran…"* — because a reader
  who presses Measure and reads "Measured." must not miss that the number in
  front of them just moved. An `unknown` result is **served too**: recomputing
  every pre-P7-6 column on sight is precisely the compute this ticket exists to
  avoid.
- A serve is **not audited** — nothing happened. A computation that was forced
  by a changed input records `recomputedBecause`, so the log can answer "is this
  set's data churning?" rather than only "how often was this measured?".

**The proof that nothing recomputes is a test that makes computing
impossible.** After one run it deletes **both** input files from the bucket,
wipes the local mirror, and clears the parse cache and the fingerprint memo —
deliberately *without* reindexing, so the catalog row still says both files are
there at the sizes the run recorded, which is the state a server is in between
pushes. The second call returns `served: 'stored'`, byte-identical `perRow`,
the same `computedAt`, and `fake.calls` shows neither input was asked for and
nothing was written. The same test then forces `recompute: true` and asserts it
**throws** — which is what stops the assertion above from being true by
accident.

#### Two bugs found on the way, both worth recording

- **The two tiers read different files.** The local pass has always read the
  file the layer block names (`readTable(fromEntry, declared?.file)`); the
  request tier called `readDataset(from)` with no file and got *whichever table
  came first*. An entry holding two tables could therefore be measured
  differently by the two tiers — against P7-5's own rule that they can never
  disagree about a number, one of them declines. Fixed, and a declaration
  pointing at a file that is no longer there falls back rather than 404ing: a
  hand-editable manifest gone wrong must not take the measurement down when
  there is still a table to read.
- **Two spans with no space between them.** `.proximity-done span` was written
  for the counts; P7-6 put a second span in that paragraph, so the bare selector
  flattened the headline's emphasis, and Vue's whitespace condensing ran
  *"Nothing was recomputed."* straight into *"9 of 11 rows"*. Found by looking at
  the screenshot, not by a test — scoped to `.proximity-counts` with an explicit
  leading space.

#### Deliberately left to P7-8

- **`rerunOf` is proximity-shaped.** It needs a `type`, a `from` and a `to`; a
  weighted index over six layers has a type and a list, so it will come back
  `rerun: null` and simply offer no button until P7-8 widens it. The
  **staleness machinery is already type-agnostic** — `checkAnalysisInputs` takes
  a list of inputs and knows nothing about proximity — so a composite layer gets
  versions, verdicts and the stale label for free by writing `inputs` the same
  way. That was the point of putting it in its own module.
- **No second analysis type**, and the derived column still is not painted as a
  choropleth (P7-2's deferral, unchanged).
- **One residual gap, declared rather than hidden:** an entry that gains a
  *second* tabular file which sorts ahead of the one measured, *and* whose
  manifest declares no layer file, would not be detected — the recorded name is
  still present and unchanged. Every declared-file case is covered by `keys`.

#### Gates

Client **2,147 / 101 files** (was 2,088 / 100). Server **2,432 passed / 14
skipped** (was 2,367 / 14). New suite `services/analysisInputs.test` **26**;
plus `services/workingSetProximity.test` 27→36, `routes/workingSets.test` 44→54,
`cli/proximity.test` 24→26, `services/mcpWriteTools.test` 40→41, and +23 client
(`lib/workingSets.spec` 40→53, `views/AnalysisView.spec` 40→42,
`components/WorkingSetWorkspace.spec` 31→39). Both type-checks clean. Build
green, bundle-leak check passed (63 files, 10 canaries).

**One real failure, caught by the full run and fixed rather than papered over:**
`analysisInputs.test` asserted a capture records nothing for a file the entry
does not hold — written before the `pickTabularFile` fallback existed, and so a
stale expectation of my own rather than a flake. The behaviour was right; the
assertion was not.

**Two failures that are not this ticket's**, reported rather than absorbed:
`MapCanvas.spec` and `lib/internalLayers.spec` on one run, and
`routes/layers.test` on another — all in **P7-9's** concurrently-edited files
(state geometry). None references `workingSets`, `analysisInputs` or any module
this ticket touches, and `routes/layers.test` passes alone, with its sibling,
and on a later full run. The tree moved under three consecutive full runs; the
final run of each suite is green.

Entry chunk **523.76 kB raw / 174.51 kB gz** against 519.05 / 172.83 — **but
that delta is not this ticket's.** The tree carries P7-9's concurrent edits to
`internalLayers.ts`, `MapCanvas.vue`, `internalFeatureLayers.ts`,
`layerConfig.ts` and the new `stateGeometry.ts`, all of which are in the entry
chunk. Measured by rebuilding with only this ticket's three client files
reverted: **523.76 / 174.50 without, 523.76 / 174.51 with — P7-6's own share of
the entry chunk is zero.** The surface rides in two lazy chunks:
`ViewRedirect` (the workspace) 9.44 → **11.26 kB** raw, 3.62 → 4.21 kB gz, and
`AnalysisView` 11.46 → **11.54 kB** raw, 4.29 → 4.28 kB gz.

**Nothing was created in the real library**, keeping P7-1's, P7-2's and P7-5's
rule — there is still no delete route, and no reindex was run against the real
bucket. Live verification used a **fixture API on port 3099** serving literals
to a Vite dev server on 5199, with the column payloads and every sentence copied
out of this ticket's own server tests, so what the browser shows is what
`analysisInputs.ts` actually produces. Screenshots
`p7-6-data-interface-stale-banner.png`, `p7-6-map-interface-stale-column.png`,
`p7-6-after-rerun.png`, `p7-6-analysis-served-stored.png`,
`p7-6-analysis-recomputed-because.png`.

---

## P7-7 [FEATURE] A dataset says what it answers

**Type:** Feature · **Priority:** P1 · **Size:** S · **Dependencies:** P6-34

### Why
Spec §F.4d. Chat picks datasets from free text plus topic/organization/shape chips —
**all descriptive, none capability**. There is no column or measure metadata
anywhere: no units, no column meanings. Chat can `query_dataset` and get numbers back
it cannot safely interpret.

### Design
- A short **`whatItAnswers`** line per dataset — *"Answers: which parcels sit within
  N miles of a transmission line"* — in `meta`, surfaced in `search_library` rows and
  `get_entry`. Models choose well from this, far better than from a topic chip.
- It is an **inferred** field in P6-34's sense: the model proposes it, it applies by
  default, and it joins the verification queue. The ingest inspection pass already
  reads a source's page.
- **The caveat is a writing problem, not a schema one:** a `whatItAnswers` everyone
  fills with the title restated is worse than no field, because it looks like signal.
  The verification queue is what keeps it honest.

### Acceptance criteria
- **Given** a dataset with the line, **then** `search_library` and `get_entry` carry
  it.
- **Given** a model-written line, **then** it is marked unverified and queued.
- **Given** a line that restates the title, **then** nothing special happens — this
  is a review problem, and the ticket must not pretend to detect it.

### Tests
The field through search and MCP; the inferred path; the queue entry.

### ✅ DONE (2026-10-06)

#### Where the line lives

**`meta.whatItAnswers` — a manifest string, no schema change**, exactly as §F.4d
said it should be: *"a manifest field plus a reindex — `meta` JSONB"*. One or
two sentences, capped at **240 characters** (`WHAT_IT_ANSWERS_MAX_CHARS`),
because the cap is set by where the line is READ: a dozen of them ride in one
`search_library` answer the model has to choose between, and a paragraph each
would crowd out the results it exists to rank.

It is surfaced in five places, four of them for free:

| surface | how |
| --- | --- |
| **`search_library` rows** | `summarize()` in `mcpTools.ts` — one function feeds both tools, so the row and the entry cannot disagree. `''` (never absent) when nobody has written one, which a caller must be able to tell from "it answers nothing" |
| **`get_entry`** | the same row, plus `provenance.whatItAnswers` and the `unverified` list P6-34 already returned |
| **free text** | `entryChunkText` gains an `Answers:` line, so a question phrased *as* a question ("which parcels near a transmission line?") matches a dataset whose title never says. Invalidated by the `clearKbIndex()` calls that already existed |
| **the entry page** | above the description, with the lead-in carrying the weight — a reader deciding *"does this bear on my question?"* is asking the capability question, and the description answers a different one |
| **the needs-a-look row** | both halves: the gap (`no answers line`) and the claim (`answers unverified`), each with its action |

`LIST_ROW_META_KEYS` gained `whatItAnswers` — the one judgement call in the
plumbing. A list row carries it because **`search_library` is assembled from a
list row**: the whole point of the field is that a model choosing between a
dozen candidates reads it in the results rather than making a `get_entry` call
per candidate.

#### It rides P6-34's path and brings no rules of its own

One row in the field table on each side of the mirror, and that is the feature:

```
{ field: 'whatItAnswers', label: 'Answers', mechanisms: ['model'], missingKey: 'no-answers-line' }
```

Everything P6-34 built then applies without being re-implemented — which is why
`INFERRED_FIELDS` is derived from the table rather than written out anywhere:

- **Applied by default, and queued.** `applyInferredValues` loops
  `INFERRED_FIELDS`; `evidenceField` asks the same list for which fields may
  carry an evidence sentence; `unverifiedFields`, `hasUnverifiedValue`,
  `needsALookFields` and the orange badge are all over the table.
- **It carries its evidence** — mechanism `model`, when, the value, and the
  sentence it was read from (P5-61: *the claim travels with its evidence*).
- **A hand-written value always wins and never queues.** `applyInferredValues`
  fills a field only when it is EMPTY — one guard enforcing three rules at once
  (a person beats the model, a re-run is idempotent, a filled field is no longer
  a gap so the second pass spends nothing). With no derivation for this field,
  `mechanismOf`'s third step reads a line with no record as `person`.
- **Keep / Edit / Clear work already.** `POST …/verify` is generic over
  `isRemediableField`; `withFieldValue`/`withoutFieldValue`'s default branch
  writes and removes `meta.whatItAnswers` by its own key.
- **The gap is on the existing row.** `no-answers-line` is the sixth rolled-up
  key, where P6-33 said it would be: *"the phase-7 spec proposes `whatItAnswers`
  (§F.4d) — which would make thirteen rules and four near-identical rows.
  Collapsing is cheaper to do before that lands than after."* The panel still
  shows **7 rows**; the vocabulary is now **15 keys**, and
  `?attention=no-answers-line` opens exactly its own field.

**Nothing detects a restated title**, and a test says so out loud
(`does NOTHING SPECIAL about a line that restates the title`). The ticket and
the spec's caveat both say the same thing: that is a review problem, the queue
is what keeps the field honest, and a heuristic that half-worked would be worse
than the queue. The only place the rule lives is where it can: the prompt, which
says *"Never restate the title."*

#### Three doors, and the one that costs nothing

The field is asked of a **dataset or a source** (`isShapedKind`, the gate P6-1
and P6-19 already use — a document's "what it answers" is its summary). Those
two kinds mostly hold no readable document, so the reading had to come from
somewhere other than `firstPages`:

| door | what the model is shown | when |
| --- | --- | --- |
| **the document drop** | the file's first pages | `applyInferredAtDrop`, unchanged from P6-34 except for the name |
| **the page-read** | the source's own page | `applyInferredFromInspection`, called where `writeInspection` already was — the inspect route ("Look again") and the link-fetch queue |
| **the source block** | the entry's own record | `ownWords()` — remediation's text door |

**A source IS its block.** Forty registry sources hold no file at all, so
`firstPages` returns null for every one of them and `whatItAnswers` would have
been a gap on forty entries that nothing could ever fill — the
queue-that-never-drains mistake for the third time (P5-59's 47 seeded sources,
P6-34's two kept place reports). The material was there the whole time: the
provider, the programme, the field dictionary with its descriptions, the
geography, how it is queried. `ownWords` hands over **`sourceBlockText`**, the
renderer `kbSearch` already builds the index from, so the model reads the same
words the index does rather than a second rendering that could drift. The old
`noteBody` is folded into it and deleted — a note is still its body.

**The stored page-read is checked before anything is spent.** A dropped link is
`incoming` at inspection time, a kind this field is never asked of, so the
reading waits on the manifest in `meta.inspection.prose`; the moment the entry
is a source, `remediateEntry` applies it **for free and from the page**, which is
better material than the manifest a re-read would get. `parseInspection` revalidates
it on the way in, so a hand-edited block is held to P5-62's quotation rule.

**A source's own filing is not proposed back to it.** `remediateEntry` stores
the rest of the annotation as `meta.suggested` as before — except when the words
came off the entry's own record, where it would be circular: forty hand-curated
registry entries would each gain a greyed "suggested title" that is their own
title, read back to them by a machine. A NOTE is deliberately not this case; its
body is content a person wrote, and proposing a title for it is what P5-47 is for.

#### Two small corrections the field forced

- **`remediateLibrary` asked one queue.** It was hardcoded to
  `attention: 'uncategorised'`, so a pass would never have visited the forty
  sources missing an answers line. It now asks **one query per inferred field's
  own `missingKey`**, read off the field table — so the next inferred field is
  found by adding its rule and nothing else — and de-duplicates by slug, because
  an entry on two queues is one entry of work.
- **The per-row line leaked a key.** `${rule.field} unverified` would have read
  `whatItAnswers unverified` in a sentence a person reads. It is the label
  lowercased now — identical for every field that can actually be unverified today.

#### Found while verifying, and fixed

The entry page dumped **the whole `meta.provenance` record as raw JSON** at the
bottom of every remediated entry, four lines below `NeedsALookNote` saying the
same thing in words. That is P6-24's defect one block lower ("the words are
upstairs, so the ids are noise"), and a second field in the record would only
have made a bigger wall. `provenance` joined the `shown` set beside
`whatItAnswers`.

#### Nothing was written to the real library, and the model spend is zero

`LIBRARY_REMEDIATE=0` was put in `server/.env` for the duration of the build
(the dev stack runs under `tsx watch`, so every server save restarts it and a
restart reindexes) and **removed again before verification**; `.env` is back to
exactly what it was. The real mirror carries **no `whatItAnswers` key on any of
its 75 manifests** — checked by grep, and `putFile` writes the mirror beside the
bucket, so that is the bucket's state too. **No model call was made at any
point — the spend on this ticket is $0.**

Live verification followed P7-6's pattern: a **fixture API on 3099** serving
literals copied out of this ticket's own server tests to a Vite dev server on
**5199**, so what the browser shows is the shape `summarize()` and the catalog
actually produce. Screenshots `p7-7-entry-answers-unverified.png` (the line, the
`Answers unverified` badge beside the chips it is about, the evidence sentence
and Keep / Edit / Clear), `p7-7-needs-a-look-gap-and-claim.png` (both halves on
one row: a dataset reading `answers unverified`, a source reading `no answers
line`), `p7-7-edit-a-sentence.png`, `p7-7-phone.png`.

**What a run would cost, stated before it happens.** 45 of the 83 live entries
are datasets or sources, so a first pass is ~45 gaps at `ANNOTATE_COST_CENTS`
(1¢) and `LIBRARY_REMEDIATE_MAX` (25) per reindex — **about 45¢ over two
reindexes**, after which the field is no longer a gap and the pass spends
nothing. "Needs a look" will rise from 12 to roughly 50 the moment the first
reindex runs and drain back as the queue is read. That is the apply-then-verify
bargain working as P6-34 described it, and `LIBRARY_REMEDIATE=0` is still the
switch if the ratio goes wrong.

#### Deliberately left out

- **Column and measure metadata — the larger half of §F.4d, and the half that
  cannot wait long.** *"There is no column or measure metadata anywhere. No
  units, no column meanings… For analysis outputs this is fatal: a derived
  `distance_to_transmission` is a bare number with no declared unit, no inputs
  and no method."* This ticket is the cheap, high-leverage line; the mandatory
  per-column declaration at generation time (name · what it measures · unit ·
  inputs · method) is a different shape — it belongs to the write path of every
  analysis, not to a manifest field — and it wants its own ticket. **Nothing
  here half-starts it.**
- **Subject fitness in `applicableSources`.** The third gap in §F.4d: a report is
  still narrowed by place and never by question. This field is what such a filter
  would read, and it now exists on the rows — but giving `applicableSources` a
  second filter is its own decision about what a report is.
- **The proposal's client half.** `SourceProposal.whatItAnswers` rides the wire
  with its `inferred` path and its evidence, the way P6-32 carries structured
  coverage — but the client type is deliberately **not** widened, because the
  server already applies the line and a field "read by nothing" is the criticism
  P6-34 made of P6-32's coverage. The form has nothing to show that the entry
  page does not already say.
- **A model fallback for `organization` and `coverage`** stays unwired (P6-34's
  note); appending `'model'` to those arrays is still all it would take.

#### Gates

Client **2,190 passing / 101 files**, server **2,585 passed / 1 failed / 14
skipped** in one full run (the failure is below, and it is not this ticket's). Both totals include the P7-8 agent's work in the same tree, so the
honest per-file numbers are mine: `provenance.test.ts` 18 → **25**,
`annotateEntry.test.ts` 21 → **25**, `remediate.test.ts` 20 → **33**,
`sourceProposal.test.ts` 53 → **56**, `linkPrune.test.ts` 69 → **73**,
`routes/libraryCatalog.test.ts` 62 → **66**, `routes/mcp.test.ts` 61 → **66**,
`kb.spec.ts` 25 → **26**, `NeedsALookNote.spec.ts` 8 → **11**,
`LibraryEntryView.spec.ts` **+4**, plus the contract edits to
`libraryCatalog.test.ts`'s `LIST_ROW_META_KEYS` list, `provenance.spec.ts` and
`DatasetsView.spec.ts`.

**One failure in the full server run, and it is not this ticket's:**
`libraryCatalog.test.ts`'s P5-37 backlinks case died in `afterEach` with
`ENOTEMPTY: directory not empty` on `rmSync`. It is a teardown race —
`textExtract`'s `onReindex(() => { void extractPending() })` writes derived files
into the temp dir the hook's own test is removing — and it reproduced about once
in five runs of that file **alone**, in a test that ran before this ticket's
block and whose `dataDir` is made fresh per test. P7-11's territory, reported
rather than absorbed.

`type-check` clean. `build` green, bundle-leak check passed (63 files, 10
canaries). Entry chunk **523.76 → 524.19 kB raw / 174.51 → 174.63 kB gz**
(+0.43 / +0.12), and the share is **all this ticket's**: rebuilding with only
these four client files reverted gives **523.77 / 174.51**, so the P7-8 work in
the same tree adds nothing to the entry chunk. The growth is `lib/provenance.ts`
and `lib/kb.ts`, which Rollup hoists into the entry chunk because six lazy routes
share them — P6-34 measured the same thing and `manualChunks` is still P6-12's
business. The entry page's own lazy chunk went 66.61 → **66.92 kB** raw, 20.45 →
**20.55 kB** gz; `DocsView` and `DatasetsView` are unchanged.


---

## P7-8 [FEATURE] Composite layers — the Lens, generalised and savable

**Type:** Feature · **Priority:** P2 · **Size:** L · **Dependencies:** P7-1, P7-6

### Why
Spec §F.3. The workbook's *political efficacy layer* — *"use class and race based
indicators to come up with a political efficacy layer"* — is a formula over several
layers. The Lens already does weighted scoring with directions, but only over
registry **county** layers, only in client memory, and the result cannot be named,
saved, cited or drawn as its own layer. This is how a story cites a number it
invented.

### Design
Generalise the Lens: arbitrary layers rather than the registry, a **saved
definition**, and an output that behaves like any other layer. It is a derived
result, so it lives on the working set and obeys P7-6.

### Acceptance criteria
- **Given** a definition over several layers, **then** it produces a layer that draws
  and can be cited.
- **Given** a saved definition, **then** re-running it reproduces the same values.
- **Given** the existing Lens, **then** the public map is unchanged.

### Tests
The composite over a fixture; reproducibility; the public map unchanged.

### ✅ DONE (2026-10-06)

#### The definition, and where it lives

There is **no definitions table and no second store**. A composite's definition
is the `analysis` block of the derived column it produced, on the set's
manifest — which is exactly where P7-6 put the one results store, and which is
what keeps P7-1's load-bearing invariant that *a reindex rebuilds an identical
row from the bucket alone*:

```json
{ "id": "political-efficacy",
  "label": "Political efficacy",
  "unit": "index",
  "method": "Weighted index of 4 county layers, each min–max normalised over its own
             counties: Local election turnout ×4 higher is better, Black voter
             registration ×6 higher is better, Percent Black ×4 higher is better,
             Poverty Rate (Black) ×4 lower is better; a county missing a layer is still
             divided by the full declared weight, so incomplete counties score lower;
             3,142 counties, 4 with every layer.",
  "values": { "13121": 100, "47157": 71.4, … },
  "analysis": {
    "type": "composite",
    "terms": [ { "layer": "internal-turnout",  "weight": 4, "direction": "higher_better" },
               { "layer": "internal-votes",    "weight": 6, "direction": "higher_better" },
               { "layer": "pct_Black",         "weight": 4, "direction": "higher_better" },
               { "layer": "poverty_by_race",   "weight": 4, "direction": "lower_better"  } ],
    "scales": [ { "layer": "internal-votes", "weight": 6, "direction": "higher_better",
                  "min": 38.6, "max": 80.2, "counties": 6 }, … ],
    "columns": ["political-efficacy"], "counties": 3142, "complete": 4, "partial": 3138,
    "inputs": [ { "slug": "internal-votes", "role": "term", "file": "votes.csv", "bytes": 2048,
                  "keys": "county|votes.csv|||GEOID|registered_pct|", "content": "a28deff27a8ab1e4",
                  "at": "2026-10-06T08:00:00.000Z" },
                { "slug": "pct_Black", "role": "term", "source": "public",
                  "file": "/datasets/demographics/county_pctBlack_diversity_index_with_stats.csv",
                  "bytes": 474942, "keys": "/datasets/…csv|pct_nhBlack",
                  "content": "7b91de0c4a1f8e32", "at": "" } ],
    "by": "maria", "at": "2026-10-06T17:46:11.207Z" } }
```

So a saved index is a **name** (the column's label, which is also the layer's
name), a **formula**, the **scale each term was normalised against**, **input
versions**, and **who ran it, when**. That is §F.4d's "declare, in the same
write: the column name, what it measures, its unit, the inputs and the method"
in one object, and §F.3's *"a story cites a number it invented"* needs every
line of it.

**Three things are different from the Lens, and each one is there to make the
number survive being written down.**

| | the Lens | a saved index |
|---|---|---|
| scale | `LAYER_REGISTRY[id].range`, a literal | the term's **observed** min–max, recorded |
| direction | falls back to the registry's | **required**, stated per term |
| term order | whatever the URL said | **sorted by layer id** before anything is summed |

- **The scale has to be a function of the bytes, because the bytes are what
  P7-6's fingerprint covers.** A declared `range` on a layer block is a legend
  domain — `color`, `width` and `name` are already excluded from `layerKeysOf`
  as cosmetics for exactly this reason — so normalising against one would let
  somebody change a published index by editing a legend while every freshness
  verdict still read green. The observed min and max are therefore recorded per
  term, which is also the only honest answer to *"what does 100 mean"*.
- **Nothing in the formula is read off a manifest**, so a saved index cannot
  change meaning underneath a story. The picker pre-fills each direction from
  what the layer declares and leaves it as a visible control: what a person
  leaves in that box is what gets saved.
- **Sorting the terms is not tidiness.** Floating-point addition is not
  associative, so a fixed summation order is what makes "re-running a saved
  definition reproduces the same values" true to the last bit rather than to
  the last decimal. It is also what makes reuse readable field equality — the
  same six layers typed in another order are the same index and must not
  recompute.

Everything else is the Lens's arithmetic verbatim, including the rule its own
comment argues for: **missing data divides by the FULL declared weight**, so a
county carrying half the formula scores about half rather than tying a complete
one at the top. (`scripts/calculate_blo_v2_scores.cjs` redistributes instead —
a third convention in this codebase, and the wrong one to carry forward.)

**Arbitrary layers, which turned out to mean two kinds.** The workbook's
*"class and race based indicators"* are `pct_Black`, `poverty_by_race`,
`median_income_by_race`, `homeownership_by_race` — **public registry layers**,
not library datasets. An index that could not take one could not build the
thing this ticket exists for. So `publicLayerValues.ts` reads the registry's
own files server-side (reusing `mcpTools.ts`'s exported `PUBLIC_LAYERS`,
`parseLayerCsv`, `parseLayerJson` and `normalizeGeoid` — only its private
disk-then-site loader is duplicated, and folding the two together is left until
P7-7 is out of that file). The registry stops being the boundary; it becomes
one of two sources.

#### Staleness, which cost one field and no second scheme

P7-6's offer was taken exactly as written — *"a composite layer gets versions,
verdicts and the stale label for free by writing `inputs` the same way"* — and
it is free: the stale badge, the "which input moved" sentence, the workspace
header count and `GET …/columns`'s verdict all work with no knowledge of what a
composite is.

The one thing P7-6 could not have foreseen is that **a term may be a public
registry layer, which has no catalog row at all** — so `checkOne` would have
found no entry and returned *stale*, forever, for every index over `pct_Black`.
The fix is a widening by **kind of input**, never by kind of analysis:
`AnalysisInput.source` is `'public'` or absent, and absent is every record ever
written before today. A library input is checked exactly as it was; a public
one is checked against the registry mirror and the file, with the same three
verdicts and the same sentences — *"“pct_Black” has changed since this ran —
474,942 bytes, now 474,980"*, *"is no longer a layer on the public map"*. There
is no `at` for a static dataset file, so the clock short circuit simply never
fires and the content always decides, which is the right way round.

The public branch is reached through a **dynamic import**. `analysisInputs.ts`
is deliberately light — one catalog read, one bucket read — and the public
loader hangs off `mcpTools.ts`, whose import graph is most of the MCP surface;
loading it only when a stored result actually names a public layer keeps every
other freshness check, and every other test file, where it was.

#### How reproducibility was proved

It is the acceptance criterion that matters, so it is pinned four ways rather
than asserted once:

- **Same definition, run again** — caches cleared between, `recompute` forced
  so it is the arithmetic agreeing and not a memo: `JSON.stringify` of the
  values is byte-identical.
- **From the SAVED definition** — not from the arguments still in hand. The
  test reads the stored record back through `rerunOf`, asserts the formula it
  gets, and re-runs from *that* — which is exactly what the button on the page
  sends. Same values, same per-term scales.
- **Order-independence** — the same formula typed in reverse, on a second set:
  byte-identical, which is what the canonical sort buys.
- **Scale-invariance** — every weight multiplied by four: identical values, so
  6/4/4 and 3/2/2 really are one index.

And the serve is proved the way P7-6 proved its own, by **making computing
impossible**: both input files deleted from the bucket, the local mirror wiped,
every cache cleared, deliberately *without* reindexing — the state a server is
in between pushes — and the second call returns `served: 'stored'` with neither
input asked for and nothing written. The same test then forces `recompute` and
asserts it **throws**, which is what stops the assertion above from being true
by accident.

#### What widening `rerunOf` took

A **discriminated union**, not a widened record with optional halves:

```ts
export type DerivedRerun =
  | { type: 'proximity'; from: string; to: string; within: number | null }
  | { type: 'composite'; terms: { layer: string; weight: number; direction: string }[] }
```

P7-6's rule survives unchanged and is the reason this returns `null` so
readily: **a button that cannot say what it would re-run is worse than no
button.** For a composite that means every line of the formula needs a layer, a
weight above zero and a direction — and **a missing direction is not
defaulted**, because `composite.ts` refuses to guess one at write time and
reading one back and inventing it would put a number on the map the definition
does not describe. Proximity's branch is byte-for-byte what it was; its tests
did not move.

Two things came with it. `resolveDerivedColumn` gained `layerId`, so a column
can say which layer it is. And the `/columns` freshness memo's key moved out of
the route into **`analysisKeyOf`**: P7-6 keyed it `` `${at}|${from}|${to}` `` to
make a proximity run's two columns one check, and a composite has neither
`from` nor `to` — so every index written in the same millisecond would have
collapsed onto one key and taken the first one's verdict. A test pins that two
different formulas sharing a timestamp are two keys.

#### "An output that behaves like any other layer" — literally

A composite column is listed in the **internal layer manifest** as
`internal-<set>~<column>`, geometry `county`, `dataType: 'index'`, range a
declared 0–100, and `readInternalLayerValues` serves its stored values. So it
draws through **exactly the path every other internal county layer takes, and
needed no client drawing code at all** — which matters more than it sounds,
because the hard constraint here is the public map and the safest way to
generalise the Lens is to add nothing to the bundle that draws it. It is also
deep-linkable, and the Lens can score it.

`~` is the separator because it is URL-unreserved (so `encodeURIComponent`
leaves it alone and the client's generic loader learns no new rule) and because
`SLUG_RE` forbids it in a dataset slug, so `<set>~<column>` can never collide
with a dataset's own layer id. Listing them costs **no extra query**: a working
set *is* a catalog row, so `listInternalLayers` reads them out of the one
`SELECT` it already runs, and serving the values computes nothing — the numbers
were written when the analysis ran.

**A proximity column is deliberately NOT a layer, and that is a decision rather
than a deferral.** A layer needs a direction, and nothing in a proximity record
says whether being close to a transmission line is an asset or a hazard — it
depends entirely on the story. P6-19's rule applies: inventing a direction is
worse than declining to name one. A composite has no such problem, because
every term's direction is already in the formula and has already been applied,
so more of the index is by construction more of what the index measures.

On the workspace's map interface the control is **instead of**, not as well as.
The pane hands every layer it names to the Lens at equal weight, so a set with
three layers is already painting a three-way composite of them; adding a saved
index as a fourth term would dilute the very number somebody asked to look at,
and the choropleth would stop being what the column says it is. So it is a
switch, it says which state it is in, and a column that drops out from under it
(a re-run that renamed it, a set edited elsewhere) turns it off rather than
leaving the map pointed at a layer the manifest no longer has.

#### Where the ceiling sits, and why it is better than the last one

Two bounds, in `composite.ts`, applied by the request and **not** by the CLI:

| | bound | why |
|---|---|---|
| `COMPOSITE_TERMS_MAX` | **12 layers** | §F.4b's explicit ceiling on the *definition*. The largest formula this codebase has ever shipped is the eleven-layer `BLO_PRESET`, and an index nobody can hold in their head is a number nobody can defend |
| `COMPOSITE_BYTES_BUDGET` | **32 MB** of source tables | **the layer count cannot see the work** |

The second is P7-5's lesson in a new dimension. There, a row cap could not see
that a few hundred transmission corridors are millions of vertices. Here,
`LAYER_MAX_VALUES` caps the county values a layer *projects* (10,000) but not
the rows it parses to get there — so a county block over a two-million-row
table passes every declared cap, and twelve of those is twenty-four million
rows parsed while the request reads green.

**32 MB is measured, not guessed: parse + project runs at ~17–20 MB/s** for
county-shaped CSVs on this hardware (50,000 rows / 2.2 MB in 130 ms;
200,000 rows / 9.1 MB in 464 ms), so the budget is about **two seconds** — the
number that matters for the same reason it was for proximity, because this is
synchronous work on one Node event loop on the single instance whose
rate-limit and budget counters DEPLOY.md says are in memory.

It improves on the proximity budget in one way worth recording: it is
**pre-flight**. A file's size is a catalog column or a `stat`, so the refusal
costs **no parse at all**, where `PROXIMITY_SEGMENT_BUDGET` could only count
vertices after layer B had already been read. A size that cannot be known
cheaply counts as zero — the budget declines to refuse work it has no evidence
against, which is the right direction to be wrong in.

What it says, verbatim as a **413**, relayed unchanged through the route,
through MCP and onto the page:

```
4 layers over 90.0 MB of source tables is past the 32.0 MB this parses in a
request. The layer count alone cannot see this — a county layer caps the values
it projects, not the rows it reads to get them. Run it locally instead:
npm run library -- index <set> --name <label> --layer <layer>:<weight>:<direction> …,
then push and reindex.
```

A refusal is never a half-run: the set is asserted to carry zero derived
columns afterwards.

The local pass is real, because *a path nothing ever takes is a path nobody can
trust*: `npm run library -- index <set> --name "<label>" --layer
<layer>:<weight>:<direction> … [--id <column>] [--apply] [--dir <path>]`, over a
pulled tree like `retag` and `proximity` — no bucket, no database, **no
ceiling**, dry run by default. County values come through a new uncapped
`countyValuesOf` (the county counterpart of P7-5's `featureGeometryOf`, and
there for the same reason: `LAYER_MAX_VALUES` bounds what the API *ships* and
this ships nothing), and the public registry files come straight off
`public/datasets/`, so the pass that needs the `pct_Black` column needs no
network. It writes the **same record** the route writes, `inputs` and all —
§F.4c's one store means one shape, and a staleness check must not need to know
which tier produced the number it is checking.

#### Four refusals that are design decisions, not validation

- **A derived layer cannot be a term.** A composite *is* a county layer, so an
  index over an index is expressible — and would need a chain of staleness
  P7-6's one-level input fingerprint does not keep, so a changed input two
  steps back would read as fresh. Refused by name.
- **A term with no spread is refused**, where the Lens scores it 0. A constant
  layer ranks nothing and drags every county down by its whole weight share,
  and it *looks fine*. In client memory with a slider to drag that is
  recoverable; written onto a working set and quoted by a story it is a wrong
  number with provenance.
- **An unnamed index is refused.** It becomes a layer and a column a story
  cites, and an unnamed number cannot be cited.
- **A name that collides with another kind of column is refused.**
  `putDerivedColumns` replaces by id, so without this an index could silently
  overwrite a measurement somebody is quoting, under the same header.

And P7-1's scope rule, applied to the formula: a layer the set does not name is
refused, because an index over something outside the set would not be the
question the set is asking.

#### Also landed

- `POST` and `GET /api/working-sets/:slug/composite`; MCP **`build_index`**,
  the seventh write tool and the second that is an analysis — §F.5's *"Build an
  index"* card reaching chat as well as the page. Its description makes the
  model state every direction rather than default one, and relay the refusals
  rather than retry smaller. A serve is **not** audited, because nothing
  happened; a computation records `recomputedBecause` and the formula itself,
  so the log answers *"what was this index"* and not only *"an index was
  built"*.
- `/analysis` gains the tool card, offered only when the set names **at least
  two county layers** — over one layer an index is that layer rescaled and the
  server refuses it, and an option that can only ever be refused is not an
  option. It arrives with **nothing ticked**: an index is a claim about what
  matters, and a form that opens with every layer selected invites somebody to
  press Build without having made one.
- `'index'` joins `DERIVED_UNITS` and `formatDerivedValue`, printing a bare
  number to one decimal — `toFixed` rather than `toLocaleString`, so 71 prints
  as `71.0` beside `71.4` and a column of them lines up.
- `compositeMethod` fits `METHOD_MAX`: twelve long layer names do not, so terms
  are named until the budget runs out and the rest counted (*"…and 4 more"*),
  with the full per-term record in the stored `analysis` and on the GET. A
  truncated list is better than a truncated sentence, and a test asserts a
  twelve-term method is ≤ 500 characters.
- DEPLOY.md gains the bulk-analysis entry beside P7-5's.

#### Deliberately left

- **The two tiers still cannot disagree about a number**, and the one place
  they could was closed by construction: both call `computeComposite`, and a
  CLI test computes the same fixture through the primitive directly and asserts
  `JSON.stringify` equality with what the pass wrote.
- **`mcpTools.ts`'s private `loadLayerFile` is duplicated**, declared rather
  than hidden: that file is being edited by P7-7 right now, so folding the two
  readers together is the obvious follow-up rather than a conflict to create.
- **A composite is not offered as a term in the public map's Lens UI**, though
  it is registered as a layer and the engine would score it. Nothing was added
  to `LayerControls` for it; whether a derived index belongs in the public
  map's layer list is a question for the ticket that asks it.
- **No set was created in the real library**, keeping P7-1's, P7-2's, P7-5's
  and P7-6's rule — there is still no delete route, and no reindex was run
  against the real bucket.

#### Gates

Client **2,190 / 101 files** (was 2,147 / 101). Server **2,586 passed / 14
skipped** (was 2,432 / 14), **zero failures on the full run**. Both type-checks
clean. New server suites: `services/composite.test` **25**,
`services/workingSetComposite.test` **28**, `services/publicLayerValues.test`
**9**, `cli/composite.test` **17**; plus `routes/workingSets.test` 54→63,
`services/workingSetColumns.test` 14→23, `services/analysisInputs.test` 26→35,
`routes/layers.test` 15→20, `services/mcpWriteTools.test` 41→42, and the two
pinned MCP tool tables updated to seven write tools. Client: `lib/workingSets.spec`
53→72, `views/AnalysisView.spec` 42→53, `components/WorkingSetWorkspace.spec`
39→45. The remainder of both deltas is **P7-7's concurrent work in the same
tree** — `kb.ts`, `provenance.ts`, `NeedsALookNote.vue`, `LibraryEntryView.vue`
and their specs, plus its server half.

Build green, bundle-leak check passed (**63 files, 10 canaries**). Entry chunk
**524.19 kB raw / 174.63 kB gz** against 523.76 / 174.51 — **but that delta is
not this ticket's.** The tree carries P7-7's concurrent edits to `kb.ts` and
`provenance.ts`, both of which are in the entry chunk. Measured by rebuilding
with only this ticket's three client files reverted: **524.18 / 174.63 without,
524.19 / 174.63 with — P7-8's own share of the entry chunk is +0.01 kB raw and
zero gzipped.** That is the design paying off: an index draws through the
ordinary internal-layer path, so nothing about drawing one is in the bundle.
The surface rides in three lazy chunks: `workingSets` 6.70 → **9.45 kB**
(3.31 kB gz), `AnalysisView` 11.29 → **16.40 kB** (5.47 gz, CSS 6.54 → 7.50),
and `ViewRedirect` 11.02 → **11.72 kB** (4.37 gz, CSS 3.35 → 3.43).

**The public map's snapshots say nothing happened, which is the point.**
`Lens.spec`'s `LOGGED_OUT_PANEL` and `App.spec`'s `LOGGED_OUT_HEADER_AT_375`
are byte-for-byte string contracts and both pass untouched, as do
`LensLegend.spec`, `usePersonalizedScore.spec`, `MapCanvas.spec`,
`internalLayers.spec` and `publicLayers.spec` — 121 tests across the seven
files that pin the public map, all green, none edited. `usePersonalizedScore.ts`
was **not modified**: the server's `composite.ts` is a separate implementation
of the same arithmetic, written so the client Lens could stay exactly as it is.

Live verification used a **fixture API on port 3098** serving literals to a
Vite dev server on 5198, with every sentence and number copied out of this
ticket's own tests, so what the browser shows is what `composite.ts` actually
produces. Verified: the picker lists two held layers and two registry layers
with poverty pre-filled `lower_better`; Build reports *"3,142 counties · 4 with
every layer · 3,138 missing at least one"* and names each term's scale; a
second press says *"Already built — the stored index, unchanged. Nothing was
recomputed."*; a third shows the 413 verbatim with the result cleared; and on
the workspace's map interface **Draw on the map** paints the index as a
choropleth on 0–100 and flips to *"Show the set's layers"*. The public map at
`/` was loaded logged out from the real dev stack and is the Lens exactly as it
was. Screenshots `p7-8-index-form.png`, `p7-8-index-built.png`,
`p7-8-index-served-stored.png`, `p7-8-ceiling-refusal.png`,
`p7-8-map-set-layers.png`, `p7-8-map-index-drawn.png`,
`p7-8-public-map-unchanged.png`.

---

## P7-9 [FEATURE] State-level geometry

**Type:** Feature · **Priority:** P2 · **Size:** S · **Dependencies:** P7-3

### Why
Spec §B: *"Permit + Laws state by state — pop-up about the specific state
requirements + permitting processes"*. The registry is county-indexed (5-digit
GEOID); there is no state level, so that criterion has nowhere to live. P6-19's
coverage vocabulary already speaks in states, so the data half exists.

### Design
A state-level layer with rich popup content, beside counties and points.

### Acceptance criteria
- **Given** a state-keyed dataset, **then** it draws at state level with its popup.
- **Given** the county layers, **then** they are unchanged.

### Tests
A state layer end to end; counties unchanged.

### ✅ DONE (2026-10-06)

#### Where state geometry comes from, and what it costs

**Nowhere new.** The state outlines are dissolved at runtime from the county
polygons the map has already downloaded — `fetchCountiesGeoJSON()`'s shared,
cached 1.86 MB, which every canvas fetches on mount because the choropleth and
the hover outline are drawn from it. `src/lib/stateGeometry.ts` is the whole of
the decision.

| | this choice | the build-time file considered instead |
|---|---|---|
| public payload | **0 bytes** | 0 (lazy) |
| CDN / repo | **0** | ~266 kB, a third artifact in `datasets/build/` |
| entry chunk | **1,446 B min / 803 B gz** (measured alone) | about the same, plus a fetch |
| build | unchanged | manifest key + `BUILT_FILE_PATTERN` **in two places** + the build spec's "exactly two files" assertions |
| first toggle | one dissolve, **~150 ms**, cached for the session | a 266 kB download |
| consistency | the union of the counties drawn under it, **by construction** | a second copy that can drift |

The public map's first load is already 3.5 MB and P5-90 went to real trouble to
hash it; the honest answer to "add a megabyte?" was to add nothing. The cost is
real and is the 150 ms: it is main-thread, it happens when you tick the
checkbox, and it happens once.

**Not a polygon union — edge cancellation**, which a county tessellation makes
exact. Every county ring is a closed loop of directed edges; where two counties
of one state meet they traverse the shared boundary in opposite directions, so
that edge appears twice and in both directions, while a state-line edge appears
once. Drop every edge whose reverse is present and the survivors *are* the state
boundary; stitch them head to tail and they close.

That this works is a property of the shipped file, not an assumption, so it is
**measured and reported**: `dissolveStateOutlines` returns how many boundary
edges closed into no ring. Over the real
`public/datasets/build/counties.<hash>.geojson`:

> **52 states, 0 dropped, 55,906 county vertices → 13,746 boundary vertices, 150 ms.**

Zero is the number that matters — it survives P5-90's 4-decimal rounding because
both copies of a shared edge round identically. If a future `--geometry`
candidate ever breaks that topology the states draw ragged rather than crashing,
and `dropped` is the thing to look at.

Georgia comes out a `Polygon`; Hawaii, Michigan and California `MultiPolygon`s —
one part per closed ring, so **no ring is ever read as a hole in another**. A
county tessellation leaves no interior void for a hole to be.

#### How a state layer declares itself

The point block (P5-24) with its coordinate pair replaced by one state column,
and one field a point has no use for:

| | **point** (P5-24) | **line** (P7-3) | **state** (P7-9) |
|---|---|---|---|
| geometry columns | `latKey`, `lngKey` | `pathKey` | `stateKey` |
| title column | `labelKey` | `labelKey` | `labelKey` **optional** |
| popup allowlist | `popupFields` | `popupFields` | `popupFields` **+ `detailFields`** |
| swatch | `color` | `color` + `width` | `color` |
| caps | `LAYER_MAX_FEATURES` | + `LAYER_MAX_VERTICES` | **`LAYER_MAX_POPUP_CHARS`** |

```json
"layer": { "geometry": "state", "file": "permits.csv", "stateKey": "State",
           "popupFields": ["Permit authority", "Typical timeline", "Statute"],
           "detailFields": ["Process"], "color": "#2f855a",
           "name": "Permitting + laws by state", … }
```

`stateKey` is **required and named explicitly**, exactly as `pathKey` and
`latKey`/`lngKey` are, and it reads all three spellings P6-19 consolidated —
`GA`, `Georgia`, `13`. That needed the one direction of the table that did not
exist yet, `stateFipsFor` in `taxonomy.ts`, which forgives exactly one spelling
`stateCodeFor` does not: a FIPS a spreadsheet wrote as `1` or `1.0`. P7-5's
lesson about `normalizeGeoId` — a leading zero a tool dropped is not another
state; a fraction that is not zeros is still not an id.

**`labelKey` is the only optional geometry field in the file**, and only here: a
state's title is the state's name, which the canonical table already knows.
Requiring the column would be requiring a dataset keyed `GA` to restate
`Georgia`. `parseFeatureFields` — P7-3's deduplication of the label/popup/colour
checks — takes its third consumer and a `labelRequired: false`, through an
overload so a point and a line keep a non-null `labelKey` at the type level.

**`parseLayerBlock` names `stateKey` first**, before any field the three share,
so a point block relabelled `state` is told what a state needs rather than being
sent after a `labelKey` it already has. Asserted.

#### What the popup carries, because the popup IS the feature

The criterion is *"a pop-up about the specific state requirements + permitting
processes"* — someone **reading**. A permitting process is paragraphs, and a
paragraph in the `<dd>` of a 300 px two-column list is unreadable, so a state
block declares two lists:

- **`popupFields`** — short facts, the two-column `<dl>` a point and a line get.
  *Permit authority · Georgia EPD. Typical timeline · 120 days.*
- **`detailFields`** — prose, rendered under them as a headed block, **a blank
  line kept as a paragraph break** and every other newline treated as a wrap
  (which is how a person writing a CSV cell spells one), in a 260 px block that
  **scrolls inside itself** so a long answer never pushes "Open record →" off
  the map. The popup is 380 px rather than 300.

A column named in both renders once: `popupFields` wins, because it is the list
the other two geometries also have. Values are still `textContent` only — they
are untrusted dataset cells — and a value that is only an http(s) URL becomes a
link, in the prose as in the list.

`buildFeaturePopup` now takes **the layer** instead of three of its fields.
Adding a fourth positional string to `(properties, popupFields, layerName,
recordHref)` was how this starts being called with its arguments transposed; all
four came off one object at every call site anyway.

#### The payload: the server ships rows, the client locates them

A state layer is the one geometry whose shapes the server never sees, so it
sends **unlocated features** — `geometry: null`, which GeoJSON allows for
exactly this — keyed `_state` by the 2-digit FIPS every county GEOID begins
with, and `bbox: null`.

`fetchInternalLayerFeatures` joins them to the dissolved outlines **before
returning**, and that one decision is why nothing else needed a state-shaped
exception: by the time the canvas, the rail, the framing or the popup sees a
state layer it is an ordinary FeatureCollection of polygons. The bbox is
computed there, from the outlines, which is why the server sends none — and
`bbox: null` is also *right* for the manifest's "Show on map", because a layer
about permitting **state by state** opens on the national view.

Three ways a row does not become a state, all counted as `skipped` rather than
failing the layer — one bad row must not cost the other fifty: the cell names no
state (a 5-digit county GEOID lands here **deliberately** — a state layer
pointed at a county column is a block to fix, not a file to reinterpret); the
state already has a row (one state, one polygon, and silently overwriting would
make which row you read depend on file order); or the row says nothing at all.
Features come out **ordered by state name**, because fifty states have one
obvious order and it is not the CSV's.

**`LAYER_MAX_POPUP_CHARS` (400,000) exists for P7-3's reason:** the feature cap
cannot see the payload. A state layer is at most 56 rows, so
`LAYER_MAX_FEATURES` can never refuse one, and its entire content is prose —
the one axis that runs to megabytes.

#### The paint, and the one thing a third geometry forced

A **wash**, not a block of colour: `fill-opacity` 0.18, lifted to 0.38 on hover,
under a full-strength outline. Fifty opaque states would hide the basemap and
the choropleth under them, and the thing a reader came for is the popup.
`fill-antialias` is **off** — Mapbox antialiases every polygon edge, and on
edge-to-edge translucent washes that draws a double-blended seam along every
shared state line.

The fill is also the hit target. A line needs a wide invisible twin because a
2 px stroke is under a finger's accuracy; a state is the opposite problem.

**Hover and the rail match are P7-3's, unchanged in reasoning:** `generateId` on
the source, `feature-state` doing the lift in the paint, and the clicked row
matched **by `feature.id`** — a state has no coordinate to match on at all, so
the point layer's label-plus-nearest-vertex rule has nothing to work with.

**`orderFeatureLayers` is the one thing a third geometry forced.** Mapbox
appends, so a fifty-state wash switched on after a transmission layer would
cover the corridors it is context for *and take their clicks*. The overlays are
now restacked after every add — **states, then lines, then points, bottom to
top** — so the stack is a function of which layers are on rather than of the
order somebody ticked them. That needed `featureDrawOrder` beside
`featureMapLayerIds`: the existing list is in **hit-test** order (clickable
first), and for a point layer that is the reverse of the draw order. Confusing
the two is how the circles would end up under their own clusters.

#### Everything else that switches on geometry

Swept, not left to be found later: a state's **anchor** is a vertex of its
outline, never the centre of its box (Michigan's is in Lake Michigan, Florida's
in the Gulf) — P7-3's rule holding for a shape with even less of a position than
a line; **focus frames** anything that is not a point, which makes a case for
lines into a rule about shape; the chat counts "2 states"; `show_layer`'s own
description now says **overlay** rather than point, so the model does not read
the tool as point-only while the prompt context offers it a state layer; the
prompt bullet reads *Point, line and state layers cannot be scored*; the rail
says **States**; the Layers panel draws a **third swatch shape** — a filled
rectangle at the wash's opacity inside a solid border, which is the two paint
layers it draws; `shape.ts` derives **`areas`** from a state block (a boundary,
not values keyed by an area code); and MCP `parseMapState` already treated every
non-county geometry as an unscorable overlay, so a state rides into saved views
with nothing changed.

**Nothing in `views.ts` or `mapDeepLinks.ts` knows about geometry at all**, so
— exactly as P7-3 found for lines — saved views, deep links, wiki embed cards
and MCP `create_view` carry a state layer with **no change to any of them**:
`pointLayers` simply holds a state id now.

One thing that was tempting and is wrong: `featureLayersFrom`'s filter is an
**allowlist** of the three drawn geometries, not `!== 'county'`. A browser
holding this bundle can meet a newer server, and a geometry it has never heard
of must be left off the map rather than drawn as whatever the fallback happens
to be — which, for the point/line/state dispatch, is a point.

One P7-3 miss came out in passing: `DatasetView`'s pane note read
`geometry === 'point'`, so a line layer — and then a state layer — fell through
to counting GEOIDs and told the reader *"No counties in these rows"*. True, and
not the fidelity claim they need. Both named now.

#### The one consequence worth knowing

**While a state layer is on, a click reads the state, not the county under it.**
The state fill is in the click guard, which is P7-3's rule applied without a
special case — *"without that, clicking a transmission line would inspect the
county it crosses"*. A corridor covers about one per cent of the map and a state
covers all of it, so the rule that is obviously right at one per cent is worth
saying out loud at a hundred: the layer is a mode, and the same checkbox leaves
it.

Deliberate, and the alternatives are worse. Letting both fire puts a county card
and a state popup on screen for every click. Guarding only the 1.2 px outline
would make the popup unreachable for all but a pixel of each state. If this
reads wrong in use it is one line — dropping `state` from `featureMapLayerIds`'
guard list — and the test that pins it says so by name.

#### Deliberately left

- **No value dimension.** A state layer is a flat tint plus a popup, like a
  point and a line. A state *choropleth* wants the registry, the legend and the
  Lens, all of which are county-indexed — a different ticket, and not the one
  spec §B asks for.
- **Proximity.** `measurableLayersOf` already offers only points and lines, and
  the bulk CLI now refuses a state **by name** beside a county: neither carries a
  coordinate to measure to. Three lines in `cli/proximity.ts`, which P7-6 is
  otherwise in; nothing else of P7-6's was touched.
- **`replicate.ts` proposes no state layer.** A permitting table is hand-written
  content, not a replicated feed, and a 2-digit column is ambiguous with every
  other code a source might carry.
- **`detailFields` is state-only.** A point or a line may declare none; whether
  a 200-word note belongs in a site's popup is a question for whoever has one.

#### Verified live, read-only

Against the running dev stack and the **real** library — nothing created,
nothing pushed, no state dataset exists in the bucket and none was made:

- `GET /api/layers/internal` → 3 layers, **all still `point`**, `detailFields:
  []` on every row, every `bbox` and `popupFields` unchanged. The library
  invented nothing.
- A state layer **drawn on real Mapbox**, stubbed at the browser's `fetch` so
  the bucket was never asked for it: five states located against outlines
  dissolved from the counties the page had already loaded — Georgia a 266-vertex
  `Polygon`, California a `MultiPolygon` with its Channel Islands — the wash and
  outline in the declared `#2f855a`, **no county hairlines on any state
  boundary**, the rail headed **STATES**, the area swatch in the Layers panel
  (`p7-9-state-layer-drawn.png`); Georgia's popup at the click point with its
  three facts, PROCESS as three paragraphs, "Open record →", and its rail row
  lit (`p7-9-state-popup.png`); and a rail click **framing** California on its
  own extent rather than easing to a vertex (`p7-9-state-framed.png`).

#### Gates

Client **2,147 / 101 files** (was 2,088 / 100). Server **2,432 passed / 14
skipped** (was 2,367 / 14). Both trees also carry P7-6's concurrent work, so
neither delta is all this ticket's. **Both type-checks clean.**

One full server run of the four showed `libraryCatalog > filters by
status=needs-review`, and it is **P7-11, not this change**: that file passes
alone (62 of 62), the runs either side of it were green over byte-identical
server code, `libraryCatalog` is one of the three files P7-11 names by
name, and nothing here touches filing status — `libraryCatalog.test.ts`
contains no `layer` block at all, so the one line added to `shape.ts` is
unreachable from it. Recorded rather than retried away; it is a fourth
instance of the bug P7-11 says has been misdiagnosed as contention three
times, and it is now happening with `fileParallelism` already off.

Build green, bundle-leak check passed (**63 files, 10 canaries**); entry chunk
**523.76 kB raw / 174.51 kB gz** against 519.05 / 172.83 — the +4.71 / +1.68 is
the dissolve (**803 B gz measured on its own**), the state paint, the layer
ordering and the popup's prose branch, all of which sit in the entry chunk
because the canvas imports them; P7-6's surface is in lazy chunks. E2E **all 6
specs passed, 27 tests, 24 passing / 3 pending**, and
**`cypress/e2e/mapDeepLinks.cy.ts` is byte-for-byte unedited** (`git diff
cypress/` empty, and no file under `cypress/` is modified at all).

---

## Not ticketed, deliberately

- **The data story surface itself** — page + analysis co-editing, and sharing. Nick
  (2026-10-03): *"let's not worry about the shareable part right now."* The spec is
  scoped to map views, and these tickets with it.
- **Tier 1 batch analysis** stays where it is (local Python / `scripts/`, committed).
  The one change it wants — outputs landing in the **library bucket** and picked up by
  a reindex rather than requiring a build and a deploy — is spec §F.4b's handoff fix
  and belongs with whoever next touches the ingest path. Without it the dev is in the
  loop at publish time as well as at script time.
- **Ingesting the workbook itself** (11 source links, 2 PDFs, the Sites sheet as a
  geocoded point layer, the Tools + Methods adaptations as pages). Spec §D.3: this
  needs **no new capability** and can start immediately. It is content work, not a
  ticket, and doing it first is how we find out which of P7-3…P7-9 actually bites.

---

## P7-10 [FEATURE] A dataset says when it is from

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** P6-34 (the derive/infer discipline and the verification queue)

### Why
Nick (2026-10-05): *"layers — especially those displayed on the map — need either a last updated (in the case of data centers) or published date (in the case of research datasets that track to a particular year or something)."*

**What exists today is about half of one of these.**

| | what it means | where |
|---|---|---|
| `updatedAt` | when **we** last wrote the bytes to the bucket | every catalog row |
| `year` | a vintage, but only on the registry / internal-layer shape, and it reaches the UI in exactly one place (`Map.vue`) | `layerConfig`, the layer block |
| `updateCadence` | how often the publisher *says* it refreshes | sources only, free text |

No held dataset carries a date about its **data**. `redevelopment-sites`, written 2026-10-05, carries none. And `updatedAt` is actively misleading if read as one: it says when the bytes last moved, so re-pushing a 2019 file makes it look like 2026 data.

**Where it bites hardest is the map.** A choropleth gives no indication of when its numbers are from. Two layers drawn together can be a decade apart and the reader cannot tell. For a dashboard that *argues* from a map — "where is potential?" — that is a correctness problem, not a nicety, and it lands on the rule §F.4c already set: a published story quoting a number must never rest on something quietly stale.

It is also a **relevance signal**, the way coverage turned out to be. *"What do we hold that is current?"* is unanswerable today.

### The three dates, because they conflate badly
1. **`covers`** — the period the data *describes*. "ACS 2019–2023"; "sites as of October 2026".
2. **`published`** — when the publisher released it.
3. **`fetched`** — when we last pulled it. The only one that is about us.

A 2024-published dataset of 2010 census tracts has all three and they are years apart. Nick's own split maps onto the first two: a **living inventory** (the 164 AWS data centres) wants *last updated*, because the question is "how stale is this?"; a **research dataset** wants *period covered*, because the question is "what moment does this describe?". Both are in the same workbook, so one field cannot serve.

### Design
- A `dates` block on a dataset, source or layer: `{ covers?, published?, fetched? }`. **Plain noun, not "vintage"** — Nick, 2026-10-05, and the house vocabulary is `coverage`, `shape`, `organization`.
- **Derive vs infer, exactly as P6-34 settled it:**
  - `fetched` is **derived** — we know it, we wrote it. Applies, never queues.
  - `published` and `covers` are **inferred** where a model can read them off the source page, or **stated** by hand in the manifest. They apply by default and **join the verification queue**, carrying their evidence sentence.
  - A hand-written value always wins, as everywhere else.
- **Tagging increases gradually and that is the intent** (Nick: *"gradually increase in tagging sounds good"*). **Nothing is backfilled and an untagged dataset is not a defect** — it is simply untagged, and the gap surfaces on the existing "Needs a look" row like every other missing field. No migration, no separate campaign.
- **Surfaces, in order of how much they matter:** the map legend and the layer page (a reader looking at a choropleth), the entry page, `get_entry` over MCP (so Chat can say how current a number is), and anywhere a story cites one.
- `updateCadence` keeps its own meaning — what the publisher *promises* — and is not folded in. A promise is not a date.

### Acceptance criteria
- **Given** a dataset with no dates, **then** nothing breaks and it appears on the needs-a-look row.
- **Given** a layer drawn on the map with a `covers`, **then** the legend says it.
- **Given** two layers drawn together with different `covers`, **then** both are legible — this is the case the ticket exists for.
- **Given** a model-read `published`, **then** it applies, is marked unverified and queues.
- **Given** a hand-written date, **then** it wins and does not queue.
- **Given** `updatedAt` and `dates.fetched` both present, **then** nothing presents `updatedAt` as a date about the data.

### Out of scope
Backfilling anything; a date on wiki pages and notes (they have an edit history already); changing `updateCadence`.

### Tests
The three fields round-tripping; derived `fetched` never queueing while inferred `published` always does; a hand-written value winning; the legend with one layer and with two of different periods; MCP exposure; an untagged dataset behaving exactly as now.

### ✅ DONE (2026-10-06)

#### Two fields, because a stale date and an old date fail differently

**`dates.covers` and `dates.published`**, plus the derived **`dates.fetched`** —
one `dates` block on the manifest, promoted onto the row.

| | the question it answers | how it ages |
| --- | --- | --- |
| `covers` | *what moment does this describe?* | into being **historical** — ACS 2019–2023 is about 2019–2023 however recently we pulled it, and being old is never wrong |
| `published` | *when did the publisher last put this out?* | into being **stale** — a list of data centres last published in 2019 is actively misleading, not merely dated |
| `fetched` | *when did WE pull it?* | it is about us, not about the data |

That asymmetry is the whole case for two fields. One `date` would make a 2019
study indistinguishable from a 2019-stale inventory, and the reader could not
tell which kind of wrong they were looking at — which is exactly the
distinction Nick drew ("either a last updated… or published date"). Nick's own
split then lands inside `covers`: a living inventory's `covers` is an *instant*
("sites as of October 2026") and a research dataset's is a *period*
("2019/2023"), and **the stored value's own grammar decides which sentence it
earns**, so no second flag says which kind of dataset this is.

`updateCadence` is untouched and is not folded in. A promise is not a date —
and that distinction turned out to be the single hardest thing to get the model
to respect (see the live run below).

#### One sortable string, and the source's own spelling stays as evidence

`YYYY` · `YYYY-MM` · `YYYY-MM-DD` · `A/B` for a period — ISO 8601-2's interval
spelling, so a period is one value rather than two fields that can disagree,
and plain string comparison sorts the lot. `normalizeDataDate` **accepts
generously and stores canonically**: the three dashes, the word `to`, a month
in words either way round, an ISO instant with its time dropped, and a bare
year held as a number (which is what a layer block carries).

**There is no second field for the publisher's own wording**, deliberately. The
source's spelling is already carried — in the provenance evidence sentence
(P5-61, *the claim travels with its evidence*), where `American Community
Survey 2019-2023 5-year estimates.` sits beside the `2019/2023` it was read
from. A parallel `stated` field would be a second copy nothing could check.

**No `Date` object is constructed to parse or render a date-only value.**
`new Date('2024-03-12')` is midnight UTC, so `toLocaleDateString()` renders
"Mar 11, 2024" anywhere west of Greenwich, and a dataset's vintage must not
depend on where the reader is sitting. The one place a `Date` appears is epoch
conversion, where `toISOString()` is UTC by definition.

#### Derive where you can, infer only where you must

P6-34 settled the discipline and §E restates it; this ticket is the first to
exercise the **ordered `mechanisms` array** for real, because `covers` carries
both and the order is what makes derivation win:

| field | mechanisms | what derives it | how the reading is checked |
| --- | --- | --- | --- |
| `covers` | `['derived', 'model']` | 1 a stated `dates:` block; 2 **a layer block's `year`** (three real entries already carry one); 3 **the held table's own year column**, under an exact name allowlist | against the layer's own declaration, or against the rows themselves — and a model-read one against its evidence sentence |
| `published` | `['model']` | **nothing.** A release date is not in the bytes | only against the page it was read from |
| `fetched` | `['derived']` | `lineage.fetchedAt`, then `fetch.at` where the status is `fetched`, then the newest `source.replication.slices[].fetchedAt` | it is our own record |

So a `covers` the data declares **applies and never queues**; the same field
read off a page by a model **applies and queues**. One field, two mechanisms,
two behaviours, and the only thing that decides is which answered first.

**`fetched` is never `updatedAt`.** That is the acceptance criterion and it is
also the point: `updatedAt` is when the bytes last moved in our storage, so
re-pushing a 2019 file makes it read as 2026. There are three real fetch
records in the live library and `fetched` reads those instead; nothing anywhere
in `dataDates.ts` looks at a row stamp, and a test says so out loud on both
sides.

**The year-column derivation is deliberately narrow.** An exact allowlist —
`year`, `data_year`, `survey_year`, `reference_year`, `vintage` — and one
unreadable value refuses the whole column. A rule matching any column
*containing* "year" would read `year_built` and declare a housing table to be
"about 1890–2015"; P6-19's lesson, that inventing an answer is worse than
declining to name one, holds here exactly.

**A filename year was considered and rejected.** `sites_2024.csv` is as likely
to be the vintage as the release and nothing can tell which — so it is not a
mechanism, and a test says the release date is derived from nothing.

#### Where it shows: the legend, because that is what Nick was looking at

A date that only reaches a manifest does not answer the complaint. The legend
is where a layer announces itself, so that is where it goes —
`LensLegend.vue`, in both of its two states:

- **One layer drawn** → a line under the title, from the value's own grammar:
  **"Data from 2019–2023"** for a period, **"As of October 2026"** for a
  snapshot, and a release date when that is all the layer has
  (`data-testid="legend-when"`).
- **Two or more drawn** → the composite's **breakdown row** gains a date per
  layer (`legend-breakdown-when`), compact with the full sentence on hover.
  This is the criterion the ticket exists for, and it fell out of a list that
  already enumerated the contributing layers. There is deliberately **no single
  date over a composite**: one date above a 2014 layer and a 2024 one would be
  a claim about neither.

**All 26 public registry layers announce a date with nothing added to the
registry**, because `year` has been a declared vintage on each of them since
long before this ticket and *a declared vintage IS the period the data
describes*. `layerDatesOf` is the one reader and the fallback lives only there
— and only for a layer carrying **no** block at all, so a P7-8 composite (which
carries `{published}` and no `covers` on purpose, since what it describes is
its inputs' business) cannot claim to cover the year somebody pressed the
button.

Beyond the legend: the **layer About page** gets all three dates spelled out as
its own fact card ("When it is from"), the **entry page** gets a line above the
description, **`search_library` and `get_entry`** carry the block with the tool
descriptions teaching the difference and warning off `updatedAt`, and
`docs/MCP.md` gains a section whose three rules are *say which one you are
quoting*, *an old `covers` is fine and an old `published` often is not*, and
*never read `updatedAt` as a date about the data*.

One wording correction, found by reading the page rather than by a test: the
period label was **"Covers 2019–2023"** until a source entry page turned out to
have carried **"Covers national · county"** since P5-56 — one about time, one
about ground, two lines apart. The field keeps its name; the sentence a reader
sees is "Data from …".

#### It rides P6-34's path, and three rows in the table are the feature

```
{ field: 'covers',    label: 'Period covered', mechanisms: ['derived','model'], missingKey: 'no-period-covered' }
{ field: 'published', label: 'Published',      mechanisms: ['model'],           missingKey: 'no-published-date' }
{ field: 'fetched',   label: 'Fetched',        mechanisms: ['derived'],         missingKey: null }
```

Everything else is inherited and nothing was re-implemented: applied by
default; queued only where a model answered; provenance carrying the evidence
sentence; a hand-written value winning and never queuing; generic Keep / Edit /
Clear; the orange badge; the per-row line. **P7-7's fix to `remediateLibrary`
is what made this a table row** — it reads every inferred field's own
`missingKey` now, so the two new queues are found by adding the rules and
nothing else, and a test asserts exactly that.

`fetched` carries `missingKey: null`, beside `shape`'s. Most of the library was
never fetched from anywhere, so a row reading "no record of fetching this"
would be a queue nobody could ever drain — P5-59's lesson, which this phase has
now found four times.

**The "Needs a look" row gains two keys and, on a fixture, not one unit of
work.** `ATTENTION_KEYS` goes 15 → **17** for the same **7 panel rows**; the
rolled-up set goes 6 → **8**. The count is distinct entries, and the entries
missing a date are the same shaped entries `no-answers-line` already counted —
so the number a person sees does not move and what grows is the per-row line.
A test says that out loud, and the live row reads:

```
no answers line · no period covered · no published date     (nothing could fill this)
period covered unverified · published unverified            (a model filled it)
no published date                                           (one fact present, one missing)
```

`?attention=no-period-covered` and `?attention=no-published-date` each open
exactly their own field — verified live, including on a row whose line names
three gaps, which is P6-23's invariant holding.

#### Four doors, and the cheapest one is the page

The dates ride the doors P7-7 built, plus the one that matters most for them:

| door | material | cost |
| --- | --- | --- |
| the index walk | a layer block's `year`, a table's year column, our fetch records | **free** — the third question of a file read P6-19 already pays for |
| the page-read | `ProseRead.covers` / `.published`, beside `updateCadence` | **free** — `linkInspect` is already reading the page, and *"Last updated: March 12, 2024"* is on the portal page and in no manifest we hold |
| the document drop | the file's first pages | one call, already made |
| the source block | `ownWords()` | one call |

The page-read door is where the two dates sit beside `updateCadence` on
purpose: that is the distinction they live or die on, and the prompt says
`"Updated annually" is a schedule, not a date` in as many words.

#### Dates as federal data actually ships them

Field evidence arrived mid-build, from four federal layers downloaded into
`library-staging/download/` — and it corroborates the split from outside:
**HIFLD transmission lines** carry `SOURCEDATE` *and* `VAL_DATE` beside
`VAL_METHOD` (a publisher separating when the data is from, when it was
checked, and by what mechanism — which is derive-vs-infer provenance, arrived
at independently); **EPA Superfund NPL boundaries** carry
`ORIGINAL_CREATION_DATE` and `LAST_CHANGE_DATE`, published and last-updated in
those words.

Two parsing notes came with it and **both were real holes**, now closed and
tested:

- **ArcGIS hands dates back as epoch integers**, and the same logical field is
  an integer on one export path and ISO text on another. The parser took only
  the text spellings, so `1710201600000` read as nothing — *a date that exists
  upstream and reads as absent here*, which is the worst failure available.
  Epoch milliseconds and seconds are now both read, as integers or as text, and
  the ranges are chosen so a four-digit year can never collide with an epoch
  (year 1790–2200; seconds from 1e8; millis from 1e11).
- **Null-ish sentinels are everywhere.** HIFLD writes `-999999`; an unknown
  ArcGIS DATE comes out as epoch 0 or a spreadsheet zero day. `1899-12-30`,
  `1899-12-31`, `1900-01-01` and `1970-01-01` are refused — a sentinel read as
  a value would put **"Data from 1899"** on a legend. Only *day-precision*
  sentinels are refused: `1900` on its own is a perfectly good vintage for a
  census table, and refusing it would be the opposite mistake.

Both constants are part of the cross-side contract test, because a drift there
would have one side read an ArcGIS export as a date and the other as nothing.

#### Written to the real library, unattended — reported, not tidied away

**This is the one thing that went wrong, and it is mine to report.** The dev
stack on 3001 runs under `tsx watch`, so every server save restarted it, every
restart reindexed, and the reindex hook ran remediation **against the real
bucket**. `LIBRARY_REMEDIATE=0` was not parked in `server/.env` at the start of
the build; it should have been. What landed, by timestamp:

| when | field | entries | whose code |
| --- | --- | --- | --- |
| 2026-10-05 | `topic` | 8 | P6-34's, already reported there |
| 19:42 – 19:51 | **`whatItAnswers`** | **40** | **P7-7's**, committed at `9f8f289` before this ticket began |
| 19:51 | `topic` | 2 | P6-34's |
| 19:59 – 21:30 | **`covers` 8 · `published` 7** | **9 entries** | **this ticket's** |

Every one of them is `mechanism: 'model'`, unverified, on the queue, and one
press of Clear away. **Nothing was created** — these are fields added to
existing manifests — and nothing was deleted or overwritten, because
`applyInferredValues` only ever fills an EMPTY field.

The nine dated entries, with the sentence each was read from:

| entry | dates | the reading |
| --- | --- | --- |
| `epa-ejscreen` | covers 2024 · published 2024 | right |
| `epa-pfas-analytic-tools` | covers 2023/2025 · published 2026 | right — *"UCMR 5 sampling ran 2023-2025 with the final dataset published in 2026"* |
| `georgia-water-withdrawal-permits` | covers 2025 · published 2025-04/2025-12 | right, and **an interval as a published date**, which the grammar allows on purpose: *"the four lists were last revised between April and December 2025"* is honestly a range |
| `heirs-property-research` | both 2017/2023 | defensible — two one-off publications |
| `usda-census-of-agriculture` | covers 1920/2022 · published 2022 | arguable: the 2022 Census is the data, 1920–2022 is a series it feeds |
| `nced-conservation-easements` | both 2025-01 | right, and useful — the register stopped being maintained that month |
| `usda-nass-cropland-data-layer` | covers 2008/2025 | right |
| **`msha-mines`** | **covers 1970** | **WRONG.** The evidence is *"Every mine MSHA has recorded since 1970"* — a start year read as the whole period. A legend would say "Data from 1970" about a current register |
| **`regrid-parcels`** | **published 2026-10** | **read off the CADENCE.** The evidence is *"Updated: continuous, with ownership refreshed daily"* — the exact confusion the prompt warns against twice |

**Both bad readings are the argument for the queue rather than against the
field**, and both are visible on the needs-a-look row with their evidence
beside them. They are left in place rather than silently reverted — undoing
them means writing to the bucket again — and they go on one word.

**The model spend.** `ANNOTATE_COST_CENTS` is 1¢ per entry read and
`LIBRARY_REMEDIATE_MAX` is 25 per reindex. Nine reindex-triggered passes wrote
something between 19:42 and 21:30, so the ceiling is 225 reads = **$2.25**; the
realistic figure is **$1.50–$2**, of which roughly 45¢ is P7-7's answers-line
pass and the rest is this ticket's date passes. The exact call count is in the
dev audit log, which I did not read (its connection string is not in `.env`).
`LIBRARY_REMEDIATE=0` is in `server/.env` as of now and **is removed before
this ticket is handed over** — so the next restart will resume, which is Nick's
press and not mine.

#### The measured finding that matters more than the spend

A date is **far more often simply absent from the material** than a capability
line is, and that changes the apply-then-verify arithmetic:

| | filled | still a gap | of 45 shaped entries |
| --- | --- | --- | --- |
| `whatItAnswers` (P7-7) | 40 | 5 | **89% drains** |
| `covers` | 8 | 37 | **18%** |
| `published` | 7 | 38 | **16%** |

P6-34's reassurance was *"a filled field is no longer a gap, so the second pass
reads nothing and spends nothing."* **That does not hold for a date.** A field
the model declined stays a gap, so every reindex pays to ask the same 37
entries again and gets the same silence — a queue that does not drain and a
spend that does not stop. On this library that is ~37¢ per reindex, for ever.

Two mitigations, neither taken here on purpose:

- **`LIBRARY_REMEDIATE=0`**, the existing switch, which keeps the derived half
  (free, always correct, and the half that answers for a layer with a declared
  year or a table with a year column).
- **Record a decline.** A `mechanism: 'model'` record with no value — *"asked,
  and the material does not say"* — would take a declined field off the
  candidate list and out of the gap count. It applies equally to
  `whatItAnswers`'s five, it changes what `missingInferredFields` means for
  every inferred field, and it is therefore **its own ticket**, not a thing to
  bolt onto this one. It is the right fix and it should land before the next
  inferred field does.

Related, and the reason the row's number *does* move on the real library even
though it does not move on a fixture: with 39 of 45 shaped entries missing at
least one date, **"Needs a look" is now effectively a list of every dataset and
source we hold**. That is the ratio P6-34 said to watch, watched.

#### Live verification

A **fixture API on 3098** serving literals copied out of this ticket's own
tests, to its own Vite on **5198** — so nothing read or wrote the real bucket,
and what the browser showed is the shape `summarize()` and the catalog actually
produce. Screenshots under `.playwright-mcp/`:

- `p7-10-legend-one-layer.png` — the **public** map, no login: *Median Home
  Value · Data from 2022*, off the registry's own declared year.
- `p7-10-legend-two-layers.png` — Life Expectancy **2014** and Median Home
  Value **2022** in one score, eight years apart and both legible.
- `p7-10-legend-inventory-vs-survey.png` — Nick's own pair: *AWS data centres ·
  October 2026* beside *Renter households · 2019–2023*.
- `p7-10-entry-three-dates.png` — *Data from 2019–2023 · Published March 2024 ·
  Fetched Sep 29, 2026*, the `Period covered and Published unverified` badge,
  and Keep / Edit / Clear on each with its evidence sentence.
- `p7-10-needs-a-look-both-halves.png` — the gap and the claim on one list.
- `p7-10-phone.png` — both dates in the Lens drawer at 390 px, no horizontal
  overflow.

Also checked live: `?attention=no-published-date` narrows to that one field on
a row whose line names three gaps; the layer About page's new "When it is from"
card; and the entry page showing `Fetched` from the fetch record while
`updatedAt` says something else entirely.

#### Deliberately left out

- **The decline marker** — above. The most valuable thing this ticket
  discovered and the wrong thing to have improvised inside it.
- **A date on a wiki page or a note.** The ticket's own out-of-scope line: they
  have an edit history already. `fieldAppliesTo` gates all three fields to
  datasets, sources and layers, and a test asks each kind.
- **Backfilling anything.** Nothing was migrated; the live writes above are
  remediation running, not a backfill, and every one of them is reversible.
- **A date on the P7-4 map block.** `MapPane` has no legend at all — only a
  title — so giving it one is P7-4's business, not a date's.
- **`updateCadence` unchanged**, as the ticket says. A promise is not a date.
- **`published` is not restricted to an instant.** The live run justified it
  within the hour: *"last revised between April and December 2025"* is honestly
  `2025-04/2025-12`.
- **The CLI report** (`retag --dates`, the way `--coverage` reads). The
  derivation returns the phrase naming what it read off (`readDates(...).from`),
  so the report is a CLI flag away — but a report that writes nothing was not
  worth a flag nobody asked for.

#### Gates

Client **2,247 passing / 102 files** (was 2,190 / 101 — the new file is
`src/lib/__tests__/dataDates.spec.ts`). Server **2,673 passed / 14 skipped**
(was 2,586 / 14). Both totals include the **P7-11 agent's work in the same
tree** — `vitest.config.ts`, `textExtract.ts`, `internalRateLimit.ts`,
`linkFetchQueue.ts`, `placeReportIndex.ts` and three of its test files are
theirs and carry none of this ticket's changes — so the honest per-file numbers
are below. **Zero failures in both**, including a full run of
`libraryCatalog.test.ts` — the P5-37 `ENOTEMPTY` teardown race did not
reproduce in either full run here, which proves nothing either way and is
reported as such. Two client files failed in one earlier full run
(`App.spec.ts`, `WorkingSetWorkspace.spec.ts`) and **both pass alone**: the
documented contention flakes, neither of them this ticket's.

Per-file: `dataDates.spec.ts` **29** (new), `dataDates.test.ts` **34** (new),
`mcpToolsDates.test.ts` **9** (new — `routes/mcp.test.ts` is P7-11's, so the
MCP exposure is asserted in its own file with no bucket and no temp dir to tear
down), `provenance.test.ts` 25 → **37**, `provenance.spec.ts` 8 → **15**,
`kb.spec.ts` 26 → **29**, `remediate.test.ts` 33 → **40**,
`annotateEntry.test.ts` 25 → **31**, `linkPrune.test.ts` 73 → **78**,
`routes/libraryCatalog.test.ts` 66 → **74**, `LensLegend.spec.ts` 3 → **11**,
`NeedsALookNote.spec.ts` 11 → **15**, `LibraryEntryView.spec.ts` **+6**, plus
contract edits to `DatasetsView.spec.ts` and `LayerAboutView.spec.ts`.

Both type-checks clean. `build` green, bundle-leak check passed (63 files, 10
canaries).

**Entry chunk 524.19 → 528.84 kB raw, 174.63 → 176.15 kB gz (+4.65 / +1.52),
and the whole delta is this ticket's** — proved by reverting the nine client
files and rebuilding, which reproduced `524.19 / 174.63` byte for byte.
`src/lib/dataDates.ts` is **3.3 kB** of that, minified and bundled alone, and
it is in the public bundle **because `LensLegend.vue` reads it** — which is the
ticket. This is the first of these fields whose growth is load-bearing *public*
code rather than P6-12's hoisting, so a `manualChunks` split would not recover
it: taking the module out of the entry chunk means taking the date off the map.
`LibraryEntryView` 66.92 → **67.27** raw (20.55 → **20.65** gz);
`LayerAboutView` 9.30 → **9.70** raw (3.73 → **3.88** gz).

Two speculative exports (`hasAnyDate`, `sortableFrom`) were written and then
deleted on measuring that nothing outside their own tests called them; the
entry chunk was **byte-identical** afterwards, so Rollup had already shaken
them out and the deletion bought cleanliness rather than bytes. Said here
because the measurement is the only reason to believe it. The server's copy
carries the **grammar and the derivation only** — no label functions, because
nothing on that side renders words for a person.

---

## P7-11 [BUG] The server suite shares module state across test files

**Type:** Bug · **Priority:** P1 · **Size:** M · **Dependencies:** none

### Bug
Run the server suite with file parallelism and **one test fails — a different one each time**. Three consecutive runs, 2026-10-06:

| run | failure |
|---|---|
| default workers | `workingSets > refuses a member that is not a dataset or a source` |
| default workers | `libraryCatalog > gzips the catalog list for a caller that accepts it` |
| `--maxWorkers=2` | `libraryCatalog > answers needs-a-look with the union of the per-field queues` |

Every one passes alone. `--no-file-parallelism`: **2,272 of 2,272, repeatedly.**

Capping workers at 2 did **not** help, which is what rules out CPU contention. The suites share module-level singletons and two files in flight configure them against each other:

- `libraryBucket.ts` — `let client`, `let bucket`, `let dataDir`
- `placeHttp.ts` — `const recentBySource = new Map()`, the per-source limiter
- the pg-mem store, and the catalog caches

**This reframes a diagnosis this project has made three times.** The two per-user-limiter cases (`libraryPlace`, `librarySources`) have been written off as contention flakes since 2026-09-29 — but `recentBySource` is module state, so a neighbouring file's requests count against yours. That is the same bug, not a slow machine. P6-35's torn mirror read was a third instance of "intermittent, therefore contention" being wrong.

### What has been done already (2026-10-06)
`vitest.config.ts` sets `fileParallelism: false`, with the evidence in a comment. It trades wall-clock for an answerable question. **That is a tourniquet, not the fix — and it has since proved insufficient.**

**Correction, same day.** P7-9 saw `libraryCatalog > filters by status=needs-review` fail on one of four full runs **with `fileParallelism: false` already on**; that file passes 62/62 alone, the runs either side were green over byte-identical code, and the failing test touches nothing the ticket changed. P7-6 saw the same pattern from the other side.

The reason is obvious in hindsight and worth writing down: **serial execution still runs every file in the same worker.** Module-level state — `libraryBucket`'s `dataDir`, `placeHttp`'s `recentBySource` — persists from one file to the *next* one just as happily as it leaks sideways. Serialising reduced the interleaving and isolated nothing. So the symptom is rarer now and the bug is untouched, which is the worst of both unless this is finished.

**The fix therefore needs real isolation, not ordering:** a fresh module registry per file (vitest's `isolate`, or a pool that recycles workers between files), or genuine reset hooks the suites call. Prove whichever with twenty consecutive full runs, and only then restore `fileParallelism`.

### Design
Isolate the state rather than serialising around it. In rough order of value:
- `libraryBucket`'s `client`/`bucket`/`dataDir` should be per-test-context, not module-global — this is the one that makes two route suites fight over the same mirror directory.
- `placeHttp`'s `recentBySource` needs a reset hook the route suites call, or to hang off an injectable context. `resetRateLimits()` exists; find out why it is not enough across files.
- The pg-mem store and the catalog caches want the same treatment.

Then restore file parallelism and prove it: **twenty full-suite runs, twenty greens.** Not one.

### Acceptance criteria
- **Given** `fileParallelism` restored, **then** twenty consecutive full-suite runs pass.
- **Given** two route suites run together, **then** neither can see the other's bucket, limiter counters or catalog rows.
- **Given** the two per-user-limiter cases, **then** they pass under parallelism — they are the canary.

### Out of scope
The client suite (it has its own issue: jsdom specs make real calls to `localhost:3001`).

### Tests
The fix is the twenty runs. Record the count.

### ✅ DONE (2026-10-06)

#### The suites do not share module state across test files, and never did

This ticket's diagnosis was wrong, and so was its correction. Both belong in
the record, because this is the fourth reading of the same symptom and the
third and fourth were ours.

`vitest.config.ts` sets no `pool` and no `isolate`, so the suite runs on
vitest 4.1.9's defaults: **pool `forks`, `isolate: true`** — a new child
process with a new module registry **per test file**, whatever
`fileParallelism` says. Two probe files sharing one module-level counter
settle it:

| configuration | what the second file saw |
|---|---|
| default (parallel) | different `pid`, counter **0** |
| `--no-file-parallelism` | different `pid`, counter **0** |
| `--no-isolate` (parallel) | same `pid`, counter **2** — leaked |
| `--no-isolate --no-file-parallelism` | same `pid`, counter **2** — leaked |

So `libraryBucket`'s `dataDir`, `placeHttp`'s `recentBySource`, the pg-mem
store and the catalog caches **cannot** reach another file, sideways or
forwards, under this config. The correction's premise — *"serial execution
still runs every file in the same worker"* — is the one thing that is not true
of it. Serialising 101 already-isolated files bought ordering, which was never
the problem, for 73 seconds a run. That probe pair is now
`src/__tests__/isolation.{a,b}.test.ts`, so the premise this fix stands on is
pinned by a test rather than by a paragraph: set `isolate: false` and it fails.

#### What actually crossed a boundary: a writer, not a value

`onReindex` keeps its hooks in an append-only array that nothing unsubscribes,
and two of them launch work and return — `textExtract`'s
`void extractPending()`, `placeReport`'s `void rebuildPlaceReportIndex(...)` —
while `linkFetchQueue` does the same for uploads and dropped links.

Detached is right for a request: parsing a shelf of PDFs must never be what an
HTTP caller waits for. It is wrong under a test runner because of **when**
those writers resolve the singletons they use:

- `libraryQuery` (libraryDb.ts:267) reads the module-level `pool` **per call**
- `writeMirrorFile` (libraryBucket.ts:162) reads `dataDir` **per write**

A sweep armed by one test and still running during the next therefore queries
the next test's pg-mem store and writes into the next test's temp mirror — or,
if nothing has started yet, it is recreating directories inside the tree the
armer's own `afterEach` is removing. That is `ENOTEMPTY` **thrown from a
test's own teardown**, which is what P7-7 and P7-5 saw. Between tests it finds
`pool` null and logs `[library] text extraction sweep failed` instead.

**Every route suite arms this without asking:** `app.ts` imports
`routes/libraryText.ts`, which calls `installExtractionHook()` at import
(line 34). Any route test that reindexes a seeded library starts a writer it
never joins — `routes/libraryCatalog.test.ts`, one of the three files this
ticket named, arms both that sweep and `linkFetchQueue` jobs and joined
neither.

| reading | blamed | what it missed |
|---|---|---|
| 2026-09-29 on | "contention", on the two limiter cases | right about those two, wrong about why — see below |
| P7-3a | singletons shared **across files** | forks + isolate: a file cannot see another file's registry |
| P7-11's correction | the same singletons persisting **forward**, file to file in one worker | right that it is forward in time; wrong vehicle. The registry is fresh per file. What survives is the in-flight writer, test to test, inside one file |

A test that fails one run in five of **its own file, run alone** was never
evidence about parallelism at all.

#### Isolation, or reset hooks? Neither

- A **fresh module registry** is already there, per file, and gave nothing.
- A **reset hook** clears a value. What leaked is not a value — it is a
  `Promise` with a `writeFile` in it. `recentBySource.clear()` cannot
  un-schedule a sweep; clearing `dataDir` mid-sweep only moves where the bytes
  land.

The only cures for work in flight are to join it or to never start it, and
which you need is decided by a measured fact about vitest: **hook order is
stack order.**

```
setup:beforeEach → file:beforeEach → test → file:afterEach → setup:afterEach
```

A setup file's `afterEach` runs *after* the test file's own. So a central
drain can protect the **next** test but can never beat the `rmSync` in the
afterEach of the test that armed the writer. Hence two layers:

1. **Do not arm unbounded detached work under the runner.**
   `installExtractionHook({ detachedUnderTest })` — inert under `VITEST`
   unless a suite asks. This is `linkFetchQueue`'s `seamMissing` rule (*"under
   a test runner, a step with no injected seam does nothing at all"*), which
   this codebase already applies in four places, turned one step further. The
   sweep is the unbounded writer: it walks the whole catalog and re-parses
   every document. The suites that mean to exercise it already call
   `await extractPending()` themselves, at thirteen sites across four files.
2. **Join everything else centrally.** `services/detachedWork.ts` is a
   dependency-free registry; `textExtract`, `placeReportIndex` and
   `linkFetchQueue` hand it the settle handles they already had, and
   `testutils/quiesce.ts` — a new `setupFiles` — awaits all of them after
   every test. Five files had worked this out and drained by hand
   (`textExtract.test.ts` joined the sweep, four place-report suites await
   `placeReportIndexSettled()`, three await `whenQueueIdle()`). The other
   ninety-six now get it without knowing which services they transitively
   armed.

`extractionSettled()` is new because `extractPending()` **cannot** be a drain:
called when nothing is running it *starts* a sweep. The one teardown that used
it as one was re-parsing every fixture in the file into the directory its next
line deletes, twenty-five times a run.

The registry imports nothing on purpose. `quiesce.ts` loads in all 103 files,
and importing a service there would pull `libraryBucket` and `libraryCatalog`
into files whose `await import()` headers exist precisely to control when
those modules first read `process.env`. Modules register themselves when they
load, so a suite drains exactly what it armed and nothing else.

#### What was left armed, and why

`placeReport`'s rebuild still runs under test. It is bounded, serialised
through a queue, and `walkAndWrite` ends with *"a library with no place
reports in it — which is most of them — should not have an object written
saying so at every reindex"*, so in nearly every suite it is one `listFiles`
and a return. The four suites that do hold reports already await its handle;
everyone else now gets it through the drain.

`void writeAudit(...)` — twenty-five route sites, the most widespread
fire-and-forget in the server — was inventoried and deliberately left alone:
it calls `pool.query` **at call time**, so its insert is bound to the pool of
the test that fired it and cannot land in the next one's store.

#### The canary was telling the truth, and it was not about state

AC3's two per-user-limiter cases fail as **`Test timed out in 30000ms`**,
never as an assertion, and the request log of a failing run shows every
request answering `200` in 62–792ms. The reason is in the test:

```ts
for (let i = 0; i < INTERNAL_RATE_LIMIT_MAX + 2 && last !== 429; i++)
  last = (await report(auth, { geoid: '13121' })).status   // a whole place report
```

The ceiling is 120, so finding it costs **121 real HTTP round trips**, one
route of which runs a full place report. At 250ms each that is the entire 30s
budget. **These two were contention — of the test's own wall clock.** The
2026-09-29 reading was right, and this ticket's reframing of them (*"a
neighbour's requests count against yours"*) is impossible under forks +
isolate: a neighbour is a different process with its own `recentBySource`.

So the ceiling is now read per request and env-tunable, exactly as `budget.ts`
reads the daily budget, and both cases pin a small one for their own case:
six requests against a ceiling of five, asserting
`[200, 200, 200, 200, 200, 429]`, which also says **where** the ceiling falls
— something the old loop never checked. The seven files that touch the limiter
run green in 13s. Both files also now `await` the `resetInternalRateLimit()`
their `beforeEach` was calling bare.

`hookTimeout` is raised to 30s beside `testTimeout`, which it should always
have matched: the first twenty-run attempt lost a run to
`librarySearchText`'s `beforeEach` — which seeds a library, reindexes it and
extracts a PDF — blowing vitest's 10s default and reporting it as a failure in
a test that had not begun.

#### The one test that was depending on the leak

Exactly one, and it is the one that should: `textExtract.test.ts`'s *"a
reindex on its own extracts everything, once the hook is installed"*. It went
red the moment the guard landed, which is the guard working. It now asks for
the detached sweep explicitly and — because `extractionSettled()` is a real
handle — waits on it instead of polling `readDerived()` every 20ms against a
twenty-second deadline. Nothing else in 2,592 tests needed the hook's sweep:
the suites that want extracted text were already awaiting it.

#### Twenty runs

Twenty consecutive full-suite runs, **file parallelism restored**, zero
failures, identical counts every time: **2,592 passed / 14 skipped (2,606)**
— the 2,586 baseline plus this ticket's six new tests.

| runs | load (1-min, at finish) | wall clock | result |
|---|---|---|---|
| 1–8 | 344 – 559 | 323s – 559s | 8 green |
| 9–20 | 49 – 292 | 98s – 198s | 12 green |

Run honestly disclosed: the runner was killed from outside the session after
run 8; runs 9–20 were resumed against a worktree verified byte-identical to
the first eight (`diff` on all fourteen files). The load column is not noise —
a sibling agent was running the P7-10 suite throughout the first half and the
box was also in a video call. **Twenty green across a 10× spread in machine
load is a stronger result than twenty green on an idle box**, because the
failures this ticket chased were all timing.

They were run in a `git worktree` pinned to `9f8f289` plus this ticket's diff
alone. That was not tidiness: P7-10 was being edited in the main tree at the
same time, and `dataDates.test.ts` (8 failures) and `provenance.test.ts` (13)
were each red there at different moments. Twenty runs against a tree somebody
else is editing would have measured their afternoon, not this fix.

#### Wall clock

Interleaved on the same quiet box, same worktree, to cancel drift:

| | run 1 | run 2 |
|---|---|---|
| `fileParallelism: false` (what shipped before) | 154s | 150s |
| restored (what ships now) | **77s** | **81s** |

**Just over 2×, and 73s a run.** The 150–154s reproduces this ticket's 155s
figure exactly, which is the control that makes the pair worth quoting.

Can parallelism be restored? **Yes, and it is** — because isolation was never
missing. The slow config was treating a symptom whose cause lives inside a
single file, which is also why it kept the symptom (P7-9, P7-6) while costing
twice the time.

#### Gates

- `cd server && npm test`: **2,592 passed / 14 skipped**, 103 files, 20/20 runs.
- `cd server && npx tsc --noEmit`: clean.
- Client `npx vitest run`: **102 files, 2,247 passed** (baseline 2,190/101; the
  delta is P7-10's new spec).
- `npm run build`: green, `bundle-leak check passed (63 files scanned, 10
  canaries)`. Entry chunk 528.84 kB raw / 176.15 kB gz against a 524.19 /
  174.63 baseline — **P7-10's client code, not this ticket, which touches no
  file under `src/`**.
- `npm run type-check` (client): **red**, and none of it from here —
  `publishedLabel`/`fetchedLabel` in `LibraryEntryView.vue` and ten
  *"Property 'dates' is missing in type … InternalLayerManifestEntry"*, all
  traceable to the uncommitted `+ dates: DataDates` in
  `src/lib/internalLayers.ts`. P7-10's to finish.

#### Files

| file | change |
|---|---|
| `server/vitest.config.ts` | `fileParallelism: false` **deleted**; `setupFiles`; `hookTimeout: 30_000`; the evidence above in a comment |
| `server/src/services/detachedWork.ts` | **new** — the settle-handle registry, no imports by design |
| `server/src/testutils/quiesce.ts` | **new** — the `afterEach` drain, every suite |
| `server/src/services/textExtract.ts` | `installExtractionHook({ detachedUnderTest })`; `extractionSettled()`; registers |
| `server/src/services/placeReportIndex.ts` | registers its existing handle |
| `server/src/services/linkFetchQueue.ts` | registers `whenQueueIdle` |
| `server/src/middleware/internalRateLimit.ts` | ceiling read per request, env-tunable (documented in `.env.example`) |
| `server/src/services/detachedWork.test.ts` | **new** — both invariants, both directions |
| `server/src/__tests__/isolation.{a,b}.test.ts`, `server/src/testutils/isolationProbe.ts` | **new** — pins per-file isolation |
| `server/src/services/textExtract.test.ts` | opts in; drains with the handle instead of starting a sweep |
| `server/src/routes/libraryPlace.test.ts`, `librarySources.test.ts` | the canaries: pinned low, made exact, reset awaited |
