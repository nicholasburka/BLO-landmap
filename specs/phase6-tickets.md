# Phase 6 Tickets — Knowledge base redesign (three functions, three resources)

Spec: `specs/phase6-spec-knowledge-base-redesign.md` (approved for ticketing 2026-09-22). Same routine as phase 5: TDD, gates (client + server suites, both type-checks, build + bundle-leak, Cypress), live verification on the dev stack, spec notes, commit. Public map untouched; logged-out header byte-identical.

Order: P6-1 and P6-2 first (they change data), then P6-3/4/5 together (the cutover), then P6-6, P6-7, P6-8. P6-9 is a spike (done: see its notes); P6-10 follows P6-7b.

---

## P6-1 [FEATURE] Organization vocabulary and migration

**Type:** Feature · **Priority:** P0 · **Size:** S · **Dependencies:** none

### Design
- `src/config/organizations.ts`: canonical id, display name, parent (USDA sub-units), aliases; exported to `server/src/prompt/organizations.generated.json` by `npm run export:layers` with stale-check tests both sides. Seeded from the 27 publisher strings in the library today plus the public layers' `source` names; `final folder for Homesteading plan` and `Black Land Ownership (BLO)` map to `blo`.
- Manifest field `organization: <id>` on datasets, sources and documents; reindex folds `source.provider` and the free `source` string through the aliases when the field is absent; unknown providers keep their text as their own group and count in the admin row **Datasets with no organization**.
- `npm run library -- retag --organizations --dir <push> [--apply]`: report and rewrite, like P5-63. Public layers take `organization` from the registry's `source`.
- List rows carry `organization` (id + label); `searchCatalog` takes `organization=`; MCP `search_library` exposes it.
- Tests: vocabulary shape and stale export, alias folding, reindex fallback, the CLI dry run/apply, the filter, the admin row.

### ✅ DONE (2026-09-23)
- `src/config/organizations.ts`: 29 ids — `epa usgs fema noaa hud census usdot-phmsa dol-msha usfws eia usda` (+ children `usda-nass usda-nrcs usda-fs usda-fpac`, labelled "USDA · Forest Service" etc.) `georgia-epd nc-deq alabama-adem dc-open-data memphis-horticulture nced regrid urban-institute bwdc bls naacp-brookings ihme tele blo`; `organizationFor`, `organizationLabel`, `isOrganizationId`; exported to `server/src/prompt/organizations.generated.json` with stale-check tests both sides. Matching folds case/punctuation to single spaces, whole alias or word-boundary prefix, longest alias first ("USDA NASS" → nass, not usda). The `blo` alias is the prefix "final folder for" because the module ships in the public bundle and `homesteading` is a bundle-leak canary (a test asserts the module stays canary-free).
- Reindex: `row.organization` from the manifest field, else the provider/source string through the aliases; unknown text kept as its own group; missing → attention row **Datasets with no organization** (`attention=no-organization`). Stored in `meta` JSONB (no ALTER TABLE) and promoted to `row.organization`/`row.organizationLabel`; recomputed cheaply at read so pre-ticket rows answer. Public layers via a helper in `src/lib/publicLayers.ts`; `GET /api/layers/internal` rows carry it. `searchCatalog` `organization=`; MCP `search_library` accepts it and rows show the label.
- `retag --organizations --dir <push> [--apply]` writes `<push>/retag-organizations.md`; `--apply` writes only ids the vocabulary knows. **Dry run on the real push tree (nothing applied): 72 entries, 72 would gain an organization, 0 unknown** — blo 22, epa 14, tele 8, usgs 3, fema/georgia-epd/noaa/usda-fs/usda-nass/usda-nrcs 2 each, the rest 1 each.
- One test-only edit outside the ticket: `KnowledgeBaseView.spec.ts` expects the third attention row.

---

## P6-2 [FEATURE] Dataset type (shape)

**Type:** Feature · **Priority:** P0 · **Size:** S · **Dependencies:** none

### Design
- `shape: 'areas' | 'points' | 'statistics' | 'records'` with labels **Areas and boundaries · Sites and points · Statistics by county or tract · Records without a location**, in `src/config/taxonomy.ts` next to the topics (one vocabulary module, exported the same way).
- Derived at reindex when the manifest does not set it: a layer block `geometry: point` → points, `county` → statistics; a source's `placeQuery.by` containing `parcel` or notes naming polygons/boundaries → areas, `point` → points, `county|tract|state` only → statistics; a held table: a GEOID/FIPS column → statistics, lat/lng columns → points, GeoJSON polygons → areas, else records; public layers → statistics. Stored on the row; list rows carry it; `shape=` filter; MCP exposes it.
- Migration report from the same `retag` run (`--shapes`), so Nick can see what each dataset was called before it ships.
- Tests: one case per derivation rule, override wins, the filter.

### ✅ DONE (2026-09-23)
- `SHAPES` beside the topics in `src/config/taxonomy.ts` (areas · points · statistics · records, with descriptions), exported with the taxonomy JSON. Only `dataset` and `source` rows carry a shape; `row.shape`/`row.shapeLabel`; `shape=` filter; MCP exposes it.
- Rules (`server/src/services/shape.ts`), in order: manifest `shape:` wins (unknown value dropped, one warning per entry); layer block `geometry: point` → points, `county`/absent → statistics; source: `placeQuery.by` has `parcel` **or** an access format/notes naming polygons/boundaries → areas, else `point` → points, else county/tract/blockgroup/state → statistics, else the block's own `geography`, else records; held table: GEOID/FIPS column → statistics, lat/lng pair → points, GeoJSON Polygon/MultiPolygon → areas, else records (header line only, 25 MB cap, never throws); public layers → statistics.
- `retag --shapes` is **report only** (`<push>/retag-shapes.md`) — the shape is re-derived at every reindex, so freezing a reading into a manifest would stop it improving. Dry run on the real tree: 45 rows (5 datasets, 40 sources) — points 22, areas 11, statistics 10, records 2. **Eight readings Nick may want to pin with `shape:`**: `epa-superfund-npl` → areas (an access note mentions unverified boundary polygons; the spec's example is points) · `fema-national-risk-index`, `hud-opportunity-zones` → points (really county/tract statistics; `by` lists point first) · `usda-nass-cropland-data-layer`, `usfs-wildfire-risk-to-communities` → points (rasters of areas) · `georgia-epd-ust-lust`, `usda-fsa-county-offices` → statistics (site points whose `by` is county-only) · `phmsa-npms-pipelines` → statistics (pipelines, `by: ['county']`).

---

## P6-3 [FEATURE] The datasets browser

**Type:** Feature · **Priority:** P0 · **Size:** M · **Dependencies:** P6-1, P6-2

### Design
- `/datasets`: every dataset-shaped resource in one list — held datasets, indexed sources, public and internal map layers (the registry rows carry organization and shape too) — grouped by **Organization** (default), **Topic** or **Type**; the choice remembered per user (localStorage `blo:datasets-group`). Groups are collapsible with counts, sorted by count then name; rows show title, held/indexed/layer badge, type chip, topic chip, the readiness one-liner.
- Text search (multi-word, same as the catalog), chips for readiness (held · indexed · map layers), organization, topic, type; URL keys for every filter so a grouped, filtered view is a link.
- Empty and loading states; phone layout with the P5-60 guards.
- Tests: grouping by each key with counts, persistence, filters via URL, layers appear as rows, the badges.

### ✅ DONE (2026-09-23)
- Shared browsing kit: `src/lib/browse.ts` (`groupRows`, `facetsOf`, `matchesQuery`, `matchesFilter`/`NONE_VALUE`, stored choice, `resolveChoice`, `browseQuery`; no Vue, no domain knowledge) and `src/components/browse/{GroupedList, GroupControl, FilterChips}.vue` — used by `/datasets` and `/docs`.
- `DatasetsView.vue`: one `DatasetRow` per thing — catalog `dataset` → **Held**, `source` → **Source** (archived dropped; organization/shape off the row, topic derived as everywhere, `readinessLine`), `publicLayers()` → **Map layer** (organization via `layerOrganization`, shape `statistics`, topic via `topicForLayerCategory`, href `/layers/:id`). **Internal layers are not separate rows**: a held dataset with a `layer` block gets a second Map-layer badge and matches the "Map layers" chip — so the page makes no `GET /api/layers/internal` request.
- URL keys `q readiness(held|indexed|layers) organization topic type group(organization|topic|type)`; "has none" chips travel as `none`; localStorage `blo:datasets-group`; URL wins over storage and only pressing the control writes storage; `group` is always written to the URL so a shared link opens the same way for everyone. Group order count-then-name with the "No organization/topic" group pinned last.
- Tests: browse 20, GroupedList 5, GroupControl 3, FilterChips 5, DatasetsView 24.

---

## P6-4 [FEATURE] Docs and Analysis browsers

**Type:** Feature · **Priority:** P0 · **Size:** M · **Dependencies:** P6-1

### Design
- `/docs`: pages, documents, notes grouped by **Purpose** (default), **Topic** or **Kind**; the to-file queue as its own group for its owner and admins; recently updated first inside groups; the ideas purpose as a chip.
- `/analysis`: tool cards (Check a place · Compare · Explore a dataset · Show on map) with one-line descriptions and Start; **Recent analyses**: saved views (map · table · compare) and cached place reports, newest first, with who and when, one click to open (a place report opens from its cache).
- The place-report cache gains an index (who, when, place label) so it can be listed without reading every report: written when a report is stored, rebuilt at reindex.
- Tests: grouping, the queue's visibility rule, the analyses list from views and the report index, the cards.

### ✅ DONE (2026-09-23)
- `DocsView.vue`: pages, documents, notes grouped by purpose (default) / topic / kind; keys `q purpose topic kind group`; storage `blo:docs-group`; `ideas` as a chip. **Queue visibility is only half-enforceable today:** `searchCatalog` does not scope `incoming` rows to their owner and list rows carry no `uploadedBy`/`createdBy`, so `canSeeQueueRow` implements the spec (admin → all; otherwise the row must name you) and members currently see no queue group — the safe half. See P6-5a.
- `AnalysisView.vue`: cards Check a place → `/place`, Compare → `/compare`, Explore a dataset → `/datasets?readiness=held` ("pick a table, then its Data tab"), Show on map → `/`; **Recent analyses** = saved views ∪ place reports (`src/lib/analyses.ts`, `Promise.allSettled` so each half degrades alone), newest first with who and when; a report opens from its cache via `placeUrlForKey`.
- Server: `services/placeReportIndex.ts` — `library/derived/place-index.json` in the bucket (outside the `place/` prefix), `{ reports: [{ placeKey, label, by, at, found, sources }] }` newest first, capped at 100; written inside `runPlaceReport` after `writePlaceReport` (filtered reports not recorded, same as the cache); rebuilt at reindex via the self-registering `onReindex` hook, recovering "who" from `library_audit` (`place.report`); writes serialised through one queue; an empty index is never written. Route `GET /api/library/place/reports?limit=` (20, cap 50) under the existing internal `router.use`.
- Tests: DocsView 21, AnalysisView 12, analyses 11, placeReport +5 (client) · placeReportIndex 10, placeReport +3, libraryPlace +4, auth sweep (server).

---

## P6-5a [TASK] Scope the to-file queue to its owner on the server

**Type:** Task · **Priority:** P1 · **Size:** XS · **Dependencies:** P6-4

`searchCatalog` returns `incoming` rows only to admins and to the person who dropped them (the manifest's `droppedBy`/uploader field — verify the name), and list rows carry `uploadedBy` so the Docs browser's `canSeeQueueRow` shows the owner's queue. Tests: a member sees their own queue rows and not another member's; an admin sees all; the list-row key.

### ✅ DONE (2026-09-23)
- The dropper was already two manifest fields — `uploadedBy` (upload/bulk) and `linkedBy` (link drop); `entryOwner()` reads either and `listRowMeta` publishes one derived `uploadedBy`. `CatalogFilters.viewer` scopes `incoming` rows (applied first, so nothing leaks through a facet, a search or `archivedCount`); **absent `viewer` means no scoping**, which keeps the server's own readers (Ask index, text extraction, place reports, MCP) seeing the whole library. Legacy rows with no owner stay admin-only. The Docs browser's queue group now shows the owner's rows.

### ✅ DONE (2026-09-23)
- **The field is two fields.** An upload (and a bulk drop) writes `uploadedBy`; a dropped link writes `linkedBy`. No new field was recorded: `entryOwner(meta)` in `libraryCatalog.ts` reads either, and `listRowMeta` publishes the answer as the single derived key **`uploadedBy`**, so a browser never has to know which door an entry came through. A row with neither (from before the fields existed) answers `''`, which no username equals — admin-only, the safe direction.
- `CatalogFilters.viewer?: { username, role } | null` scopes `kind: incoming` and nothing else, applied **first** in `searchCatalog` so a hidden row cannot be counted by a facet, matched by a search, or leak through `archivedCount`. **Absent `viewer` means no scoping**, which is the SERVER reading its own catalog (the Ask index, text extraction, the place report, MCP) — those keep seeing the whole library. `GET /api/library/catalog` passes `res.locals.internalUser`.
- Client: `DocsView.canSeeQueueRow` now reads `uploadedBy` / `linkedBy` (`createdBy` was never written by anything) and the rule is enforced on both sides.
- Tests: server 8 (`libraryCatalog.test.ts`: member sees own uploads and own links, not another member's; admin sees all including legacy; anonymous sees none; no-viewer unchanged; hidden from `kind=` and `q=`; the list-row key; `entryOwner`), client 2 (DocsView: the owner of a dropped link, a drop with no owner). One fixture edit outside the ticket: `routes/libraryCatalog.test.ts`'s `FAT_LINK` gains `linkedBy: 'maria'` — a dropped link records who dropped it, so the fixture was the unrealistic thing.

---

## P6-5 [FEATURE] The cutover: header, landing, redirects, guide

**Type:** Feature · **Priority:** P0 · **Size:** M · **Dependencies:** P6-3, P6-4

### Design
- Header: Library · Search · Chat · New (phone menu the same plus Account and Log out); the strip and its eight items removed; `/ask` keeps working as an alias of `/chat` until P6-7 lands.
- Landing `/kb`: header · **Recently edited** (the user's last three marked "yours", then the last few by anyone, one list) · **Pinned items** · the three resource tiles with counts · **Most recent items** (five, any kind) · admin rows at the foot. The P5-68 flow cards go; Search and Chat are one click away in the header.
- Redirects: `/library`, `/layers`, `/wiki`, `/library?kind=…`, `/library?purpose=ideas` per the spec §A.5; every existing deep link unchanged.
- First-run checklist rewritten to the six new steps; help recipes and `library-guide.md` / `home.md` updated to the new words; Cypress expectations updated.
- Tests: header items, landing order and the recently-edited rule, each redirect, checklist steps; the logged-out header snapshot unchanged.

### ✅ DONE (2026-09-23)
- Header: Library · Search · Chat · New (phone menu the same plus Account and Log out); the eight-item strip and `KbFlowCards` deleted; `KbNav` carries Datasets · Docs · Analysis. Logged-out header pinned unchanged. Entry chunk **498.86 kB / 166.21 kB gz** (down 1.68 kB from before the cutover — four views' worth of strings left the bundle).
- Landing: Recently edited (`GET /api/library/recent-edits` — `library_audit` through a narrower allowlist than the feed: upload, link, file, note, note.update, wiki.create, wiki.update, view.create; one row per entry; targets resolved so no row is a 404; `src/lib/recentlyEdited.ts` puts the user's last three first marked "yours", then the newest by anyone, six in one list) · Pinned items · the three tiles with counts · Most recent items · admin rows. Attention rows are one vocabulary (`ATTENTION_RULES` in `src/lib/kb.ts`): the panel counts and both browsers filter by the same predicate, so a count and its list cannot drift.
- Redirects (`src/lib/retiredRoutes.ts`, pure and unit-tested; `RetiredRedirect.vue` uses `replace`): `/library?kind=dataset|source` → `/datasets?readiness=held|indexed`; `?kind=document|wiki|note|incoming` → `/docs?kind=`; `?kind=view` → `/analysis`; `?purpose=`/`?category=` → `/docs?purpose=`; `?attention=` → `/datasets` (no-organization, source-failing, in-cleaning, replicate-todo) else `/docs`; `?status=needs-cataloging|needs-review|in-cleaning` → the matching `?attention=`; `?drop=`/`?upload=` → `/new`; anything else → `/search` with the same filters; `/layers` → `/datasets?type=statistics`; `/wiki` → `/docs?kind=wiki` (`/wiki?new=1` → `/docs?new=1&kind=wiki`, the new-page form extracted to `NewPageForm.vue` on `/docs`); `/ask` → `/chat` (**and `/chat?q=` now starts a thread with the question and drops the query** — the Ask boxes on entry, layer and compare pages land there). Entry pages, `/layers/:id`, `/views/:slug`, `/place`, `/compare` untouched.
- Retired and deleted: `LibraryView`, `LayersIndexView`, `WikiView`, `AskView`, `KbFlowCards` and their specs; kept `AskBox.vue` (used by entry, layer and compare pages), the P5-60 phone-guard cross-check (moved to `KnowledgeBaseView.spec.ts`). `LibraryEntryView`'s back-link goes to the browser the entry lives in (Datasets / Docs / Analysis).
- First-run checklist rewritten to six steps; help recipes and the push tree's `library-guide.md` / `home.md` updated to the new words (push them with the next library push); Cypress specs updated to the new nav.
- Tests: client 1,595 / 90 files, server 2,036 / 92 files at hand-off; both type-checks clean.

### ✅ DONE (2026-09-23)
- **Header:** `Library → /kb · Search → /search · Chat → /chat · New → /new`, sharing **one** `<template v-if="internalUser">` — a false `v-if` renders one `<!--v-if-->` marker, and the logged-out header's byte-for-byte snapshot counts them, so four links cost the same three markers the page always had. (Template comments render too: the explanation lives in the script.) `Library` stays lit all the way down a browse (`/kb`, the three browsers, `/library/:slug`, `/wiki/:slug`, `/place`, `/compare`, `/layers/:id`); Search, Chat and New mark themselves. The phone menu is Map · About · Library · Search · Chat · New · Account + Log out (the shortlist badge moved to KbNav's Analysis tab, where Compare now lives).
- **KbNav** is the three resource tabs `Datasets · Docs · Analysis`, marking the tab a page belongs to — `/layers/:id` lights Datasets, `/wiki/:slug` lights Docs, `/place`, `/compare` and `/views/:slug` light Analysis; `/library/:slug` lights nothing, because it could be either.
- **Landing:** one column — initiative hero (when configured) · first-run checklist (first run only) · **Recently edited** · **Pinned** (dropped when empty) · the three tiles · **Most recent items** · admin rows · the help foot. Tiles: datasets = held + sources + public layers (the registry ships in the bundle, so no third request), docs = pages + documents + notes, analyses = saved views + `GET /api/library/place/reports` (limit 50; a failed index counts 0 rather than breaking the tile). `KbFlowCards.vue` and its spec deleted.
- **Recently edited** reads a new route, `GET /api/library/recent-edits?limit=` (`routes/libraryActivity.ts`, `recentEdits` in `services/libraryActivity.ts`): `library_audit` through a narrower allowlist than the feed's — upload, link, file, note, note.update, wiki.create, wiki.update, view.create — one row per entry (three saves of a page is one thing that changed), targets resolved so a row is never a link to a 404. `src/lib/recentlyEdited.ts` splits it: the user's last three marked **yours**, then the newest by anyone not already listed, six in all, one list, no second heading. A new colleague gets the same block reading as "recently updated by anyone". The catalog cannot answer this — `updatedAt` is the newest bucket object with no name on it.
- **Attention rows** are one vocabulary now (`ATTENTION_RULES` in `src/lib/kb.ts`): the panel counts with a predicate and the browsers filter by the *same* predicate through `matchesAttention`/`attentionKeysFor`, so a count and the list it opens cannot drift. The href is decided by what the matched rows ARE — a majority of datasets/sources opens `/datasets?attention=…`, anything else `/docs?attention=…` — and both browsers honour the key, with a banner naming the queue and a "Show everything" way out. `status=` hrefs are gone.
- **Redirects** (`src/lib/retiredRoutes.ts`, a pure function, + `RetiredRedirect.vue`, which `replace`s so no retired URL sits in history): `/library?kind=dataset|source → /datasets?readiness=held|indexed` · `kind=document|wiki|note|incoming → /docs?kind=…` · `kind=view → /analysis` · `?purpose=|?category= → /docs?purpose=` · `?attention=<key> → /datasets|/docs` · `?status=needs-cataloging|needs-review|in-cleaning → ?attention=to-file|needs-review|in-cleaning` · `?drop=|?upload= → /new` · else `/search` with the same filters. `/layers → /datasets?type=statistics` · `/wiki → /docs?kind=wiki` · `/ask → /chat`. All four keep `meta.requiresInternal`, so a shared link still bounces a logged-out reader through login before it lands. `/library/:slug`, `/wiki/:slug`, `/layers/:id`, `/views/:slug`, `/place`, `/compare` are untouched.
- **Deleted:** `LibraryView.vue`, `LayersIndexView.vue`, `WikiView.vue`, `AskView.vue`, `KbFlowCards.vue` and their five specs. **Kept:** `AskBox.vue` (LibraryEntryView, LayerAboutView and CompareView still host it) and the pages index's new-page form, which moved to `src/components/NewPageForm.vue` and now sits at the top of `/docs` — `/wiki?new=1` redirects to `/docs?new=1&kind=wiki` and still focuses it. WikiView's cross-file "every internal page container has the phone guard" check moved into `KnowledgeBaseView.spec.ts` with the new view list.
- **First run** is six steps, one per surface: Find a dataset `/datasets` · Open a page or a document `/docs` · Run an analysis `/analysis` · Ask Chat a question `/chat` · Add something `/new` · Search for something `/search`. Ids kept where a surface reports them (`data`, `read`, `map`, `add` are called by DatasetView, LibraryEntryView, Map.vue and NewView); `start` went and `search` arrived. `matchFirstRunStep` now proves a step from `/search?q=`, `/place?address=|geoid=|lat=` and `/chat` — the last is the one honest compromise (Chat writes nothing to the URL), and its hint says "it ticks when you open Chat". `setFirstRunHomeSlug` and the `homeSlug` prop are gone.
- Help recipes rewritten to the new words (three new: `browse-datasets`, `browse-docs`, `chat-writes`; `browse-library`, `ask-layer` retired), with a test that no recipe or checklist step points at a retired path; `library-guide.md` gains a "Where everything lives" section and `home.md` a "Getting around" one (both in the push tree). Cypress: `internalAuth.cy.ts` covers the new nav words, the guard on all seven new routes, and the three redirects; the live drop test now goes through `/new` and files from `/docs`.
- Tests: **client 156 added/rewritten** — retiredRoutes 19, RetiredRedirect 6, recentlyEdited 12, firstRun 17, FirstRunChecklist 8, KbNav 7, App 26, KnowledgeBaseView 34, kb 19, DocsView +9, DatasetsView +6. Whole suite 1,513 green; `type-check`, `tsc` and the Cypress tsconfig clean.
- **Entry chunk 498.86 kB raw / 166.21 kB gzipped, down from 500.54 kB** — the cutover deleted more public-bundle words than it added. Bundle-leak gate green.
- **Known gap:** `AskBox` still routes to `/ask?q=…`, which now redirects to `/chat?q=…`, and `ChatView` does not read `q` — so asking from an entry, a layer or a comparison opens Chat with an empty composer. The fix is three lines in `ChatView.vue` (seed the composer from `route.query.q`), which belongs to P6-7b's owner.

---

## P6-6 [FEATURE] Search

**Type:** Feature · **Priority:** P1 · **Size:** S · **Dependencies:** P6-1, P6-2

### Design
- `/search?q=`: results across every kind in held-first order, grouped, each with badge and verdict; chips for kind, organization, topic, type, purpose; ⌘K's Enter-with-text goes here.
- **Inside documents**: when the catalog returns fewer than five rows, the Ask index's page chunks are searched (BM25) and matches are listed with page numbers, each opening the viewer at that page (`?view=<file>&page=N`).
- Tests: grouping and order, chips as URL keys, the inside-documents threshold and the page link.

### ✅ DONE (2026-09-23)
- Server: `GET /api/library/search-text?q=&limit=` (`server/src/routes/librarySearchText.ts`; internal tier, rate-limited, no-cache) → `{ results: [{ entryId, title, file, page, snippet, score }] }`; 400 on a blank `q`, 503 when the library is off; `limit` 10, clamped 1…25. Scores with `scoreChunks` from `kbSearch.ts` (the Ask index; already exported), document chunks only, deduped per entry+file+page keeping the best chunk, 220-char snippet opened on the first query term. **Visibility:** results are intersected with `searchCatalog({})`, so a row the catalog hides cannot leak from the cached index (mutation-tested).
- Client: `src/lib/search.ts` `searchEverything(q, filters)` → groups in the held-first order `dataset→Datasets · wiki→Pages · view→Analyses · document+incoming→Docs · note→Notes · layer→Layers · source→Sources` (unknown → Docs), "Inside documents" appended last; empty groups dropped. Text search runs only when the catalog returns **< 5 rows and no chip is active** (the text route cannot honour organization/topic/type). `facets` counted from the query's rows, not the filtered rows, so choosing a topic does not hide the others. Page links: `/library/<entryId>?view=<file>&tab=files#page=N` (the shape `LibraryEntryView.openView` writes and `DocumentViewer.pageFromHash` reads).
- `SearchView.vue` at `/search` (URL keys `q kind organization topic type purpose`), empty state "Nothing matched — try fewer words, or ask in Chat" → `/chat`. `GlobalSearch.vue`: the palette opens with nothing highlighted; Enter with text and no row → `/search?q=`; arrows still pick a row.
- Public registry layers are not pulled into `/search` (catalog rows only); the Layers group is ready for the rows P6-3 adds.
- Tests: server 8 (+ auth sweep entry), client 36 (lib 16, view 7, GlobalSearch 13).

---

## P6-7 [FEATURE] Chat: conversations with the library's tools

**Type:** Feature · **Priority:** P1 · **Size:** L (split: 7a server, 7b client) · **Dependencies:** P6-5

### Design
- **7a server:** `library_chats` and `library_chat_messages` tables (per user; title, created, updated; role, text, tool calls, citations); routes to list, create, rename, delete a thread and to send a message (streamed answer). The assistant loop runs with the MCP tool table (search_library, get_entry, read_document, read_page, query_dataset, county values, fetch_for_place, place_report, compare, save_view, create_note, append_to_page, drop_link, inspect_link); **writes are proposed, not executed** — the answer carries a pending action the client confirms with a second call; every executed write is audited "via chat". Threads over 30 turns are compacted by a server-side summary of the older turns. Per-user daily budget applies; the honesty line when the model is unavailable.
- **7b client:** `/chat` with the thread list on the left and the conversation on the right, a map pane slot on the right kept empty in this phase (spec decision 4); tool calls shown as collapsed lines; citations as today; per-answer Save as note · Add to page · Open; confirm dialog for a proposed write; "New chat"; the public map chat untouched.
- Tests: thread CRUD and ownership, the propose/confirm write path, compaction, streaming, the UI states; a live check with credit.

### ✅ 7a DONE (2026-09-23) — server
- Files: `server/src/services/libraryChat.ts` (store: threads, messages, ownership-keyed lookups, title derivation, `contextMessages`, `findAction`), `server/src/services/chatLoop.ts` (tool table built from the MCP tables, the turn loop, propose/confirm, compaction, system prompt), `server/src/routes/libraryChat.ts` (seven routes + the NDJSON stream), tables in `libraryDb.ts`, mount in `app.ts`, four auth-sweep canaries, `docs/CHAT.md` (wire protocol), one DEPLOY.md bullet. Named `libraryChat` (not `chat`) because `routes/chat.ts` is the public map chat, which stays untouched.
- Wire: `POST /api/chats/:id/messages` answers `200 application/x-ndjson`, one event per line — `text` deltas, `tool_call` started/finished with a one-line summary, `proposed_action`, `citations` (once), then exactly one `done` or `error`. NDJSON over `fetch` rather than SSE because the send is a POST with a CSRF header. Deltas are one per model round today (the call is non-streaming like Ask); token streaming can land later without a client change.
- Writes are proposals: stored on the assistant message as `status: "proposed"` with arguments; the model is told "not run — the person decides"; confirm runs the stored proposal through the same MCP handler, audits `chat.<tool>` with `{chatId, messageId, client:'chat'}`, entity rows read `via: "chat"`; a refused write becomes a `tool` message plus a `failed` audit row.
- Compaction: a fourth role `summary` with `meta.throughMessageId`; triggered 30 turns after the last compaction; model summary, or a plain trim carrying the reason when the model is unavailable. The thread keeps every message; only the model's view shrinks.
- Tools: every MCP read tool, the three place tools, the five write tools; `ask` excluded. Zod shapes reused for the model's JSON Schema and for validation, so a bad call is readable text. Caps: 6 rounds, 12 tool calls, 2 outside-service calls per turn (the outside cap is enforced, not unit-tested — no test reaches the network). No compare tool exists on the server, so none is offered; `county_values`/`list_layers`/saved views cover it.
- Honesty line defined in `chatLoop.ts` with a test pinning it to Ask's `MODEL_UNAVAILABLE`; the turn ends 200 with the line stored; admins alone get `reason`. `POST /api/chats`'s optional `message` only names the thread.
- Tests: 47 (store 10, loop 22, routes 15); 147 pass with `libraryDb.test.ts` and the auth sweep; `tsc` clean.

### ✅ 7b DONE (2026-09-23) — client
- Files: `src/lib/libraryChat.ts` (typed client, NDJSON reader with partial lines carried across chunks, `openTargetFor`), `src/composables/useLibraryChat.ts` (page state, the event reducer), `src/views/ChatView.vue`, `src/components/chat/` (`ChatThreadList`, `ChatMessageItem`, `ChatToolLine`, `ChatProposedAction`, `ChatAnswerActions`, `ChatComposer`), the `/chat` route (lazy, internal), `docs/CHAT.md` §7 "The client", `cypress/e2e/chat.cy.ts` (stubbed stream; 3 cases).
- Layout: `KbNav` · flex columns — thread list (a `<select>` on phones), the conversation (messages, error banners, composer), and `<aside v-if="paneOpen">` with `paneOpen === false` reserved for P6-10 (flex, not grid, so the empty slot leaves no gap; a test asserts it does not render).
- Open: `openTargetFor(message)` checks a confirmed write's `result.href` (`save_view`), then a citation of kind view/place/report, then the first same-origin analysis link in the answer; off-site links are rejected by `toAppPath`.
- Save as note / Add to page build an `AskAnswer`-shaped object and call Ask's `saveAnswerAsNote` / `addAnswerToPage` — same markdown, same `research`/`ask` filing, same `If-Unmodified-Since` round trip, `WikiConflictError` → "Try again".
- Errors reuse `AskRequestError` (`ChatStreamError` adds `reason`, `messageId`), so `askErrorMessage` covers budget/401/429/admin reason; an `error` event with a `messageId` keeps the honesty line as the message, without one both optimistic messages are removed and the text returns to the composer.
- Rename/archive inline (never `window.confirm`); the page opens the most recent thread on arrival; no thread id in the URL (threads are per person).
- Tests: 65 (lib 28, composable 19, view 18); `type-check` clean; Cypress spec type-checks. Server `ChatEvent` `done` now types `userMessageId` (fixed after the agent flagged it).
- `/chat?q=` starts a new thread with the question at once and drops the query (2 tests) — the Ask boxes on entry, layer and compare pages land here via the retired `/ask`. **Cypress:** the stubbed chat spec could never run against the plain production build (no `VITE_API_URL` ⇒ `useAuth` skips `/api/me` ⇒ the guard bounces to `/login`), so `npm run test:e2e` now builds its own copy into `dist-e2e/` with `VITE_API_URL=http://localhost:4173` (`build:e2e`; override with your own `VITE_API_URL` for the live-login specs) and previews that; the spec's intercepts are anchored path regexes. All 13 Cypress tests pass, 3 live-login cases pending.

---

## P6-8 [FEATURE] New: link, document, many documents

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** P6-1, P6-2

### Design
- `/new` with three panels: a link (the drop form), a document (single upload), many documents (multi-file or folder drop, up to 50 files, 100 MB each, 500 MB per drop; "keep as one collection" makes one entry).
- Each file: extract → the model suggests title, summary, organization, topic, purpose, tags, shape → stored as the suggestion, entry filed `needs-review`. The New page lists rows (queued · reading · suggested · failed) with the suggested values greyed, **Accept** (applies), **Edit** (fields prefilled; saving applies), **Accept all**; the cost estimate before Start and the running total. Until accepted, cards and the entry show the suggested title greyed with a "suggested" badge. Single drops use the same row UX. Nothing is applied by the machine alone.
- Without credit: rows land with the floor and the honesty line; annotation can be re-run from the row or the entry.
- Tests: the queue states, accept/edit/accept-all, the collection option, size and count caps, the no-credit path, the badge.

### ✅ DONE (2026-09-23)
- Server: `POST /api/library/bulk` (multipart `files`, fields `collection`, `collectionTitle`; 201 → status + `estimateCents`; 400 over 50 files, 413 over 100 MB/file or 500 MB/drop), `GET /api/library/bulk/:dropId` (owner or admin; `{ dropId, at, rows[{ slug, file, state, title, reason?, suggested?, costCents }], running, counts, spentCents }`), `POST /api/library/entries/:id/annotate` ("Look again"; `dailyBudgetMiddleware`; 409 for a kind that is not a dropped document). Files: `routes/libraryBulk.ts`, `services/bulkDrop.ts`, `services/annotateEntry.ts`, `services/uploadFields.ts` (the size/name/field rules extracted from `libraryUpload.ts`, imported by both). The queue gains `work: 'annotate'` with three in flight **alongside other annotations only** — fetch/suggest/replicate keep P5-47's one-at-a-time rule. The proposal lives at `meta.suggested`, widened with `topic/purpose/organization/shape`; shape is written only when columns can say so.
- The budget guards the re-run, not the drop: files always land (the spec's rule); per-file spend is metered in `callAssistant`'s reserve/settle. Cost **1¢ per file** (`ANNOTATE_COST_CENTS`, mirrored client-side; ~1,500 document tokens + ~900 prompt against a 600-token cap on the Ask model's rates); the page shows "about N¢" before Start and the running total after.
- Client: `NewView.vue` at `/new` with `components/ingest/{LinkDropForm, DocumentDropForm, BulkDropPanel, BulkDropRow}.vue` (reusing `TaxonomyFields`/`SourceFields` and the existing lib calls; `IngestPanel.vue` unchanged), `src/lib/bulkDrop.ts` (polling, Accept/Edit/Accept all, the collection title read from `webkitRelativePath`). `LibraryEntryView.vue` shows the grey suggested title with its badge and "Look again" now works for a dropped file (it was link-only). List rows carry **`suggestedTitle`** (present only while outstanding) with `suggestedTitleOf(entry)` in `src/lib/libraryCatalog.ts` for cards.
- Tests: 85 (server 46, client 39); type-check and `tsc` clean. The over-the-cap test lowers the cap via `LIBRARY_BULK_MAX_FILES` rather than sending 51 files.
- **Follow-up (P6-8a, below):** Accept applies title, topic-or-purpose as `category`, tags and summary, but **not `organization` and `shape`** yet — the accept path (`PATCH /api/library/catalog/:slug` → `fileIncomingEntry`, `FilingUpdates`) was owned by another agent this wave.

---

## P6-8a [TASK] Accept applies organization and shape

**Type:** Task · **Priority:** P0 · **Size:** XS · **Dependencies:** P6-8, P6-3

`FilingUpdates` and the catalog PATCH route carry `organization` (a vocabulary id, validated) and `shape` (validated against `SHAPES`) into the manifest on Accept / Edit-and-save, with the same audit; the client's accept call sends them when the suggestion has them. Tests: the PATCH with both, an unknown id rejected, the manifest after Accept.

### ✅ DONE (2026-09-23)
- Server: `FilingUpdates.organization/shape`; `fileIncomingEntry` writes them into the manifest ('' deletes so a reindex derives again); the PATCH route validates through `parseVocabularyFields` (`isOrganizationId`, `isShape`) and answers 400 with the offending word, writing nothing. Tests: both written, read back on the row, kept across reindex; unknown publisher and unknown shape refused; '' clears (3 tests).
- Client: `FilingUpdates` gains both; `AcceptedFiling`/`filingFrom`/`acceptFiling` carry them when set; new `src/components/OrganizationShapeFields.vue` (two selects: every publisher, the four shapes, "Not set") used by the bulk row's Edit form and the entry page's filing form; the entry page's suggestion panel shows Organization and Type, Apply fills the selects, and the filing sends them. Tests: component 3, bulkDrop +2, LibraryEntryView +1, NewView expectations updated (Accept now carries `organization`/`shape`; Edit prefills and can change them).

---

## P6-9 [SPIKE] A live map on the chat page

**Type:** Spike · **Priority:** P2 · **Size:** S · **Dependencies:** P6-7

### Question
Can the chat page host the same Mapbox map the home route uses (shared component, lazy chunk) with the assistant's map tools (show_layer, fit, focus) driving it, without loading the map's data until the pane opens and without the public map changing? Deliverable: a written recommendation with the component boundary, the data-loading rule, the cost on chat page weight, and a ticket if feasible.

### ✅ DONE (2026-09-23) — recommendation
- **Feasible, size M**, not S. The library weight is already paid: `src/router/index.ts` imports HomeView statically, so `Map.vue` and the mapbox-gl chunk (388 KB gz) ship on every route today; the chat page pays zero extra JS. Opening the pane costs the two county data files (~1.07 MB gz), tiles, a billed map load and a second WebGL context.
- **The blocker is mounting `Map.vue` twice.** It is 4,422 lines and owns everything (data load, colours, Lens, PromptInput, deep links, saved views, rails). Module-level state two instances would fight over: `layer.visible`/`layer.status` live on the module arrays in `src/config/layerConfig.ts` (wrapped in `reactive()` at `Map.vue:1774`), so instance B would think a layer is loaded that exists only on A's style; `LAYER_REGISTRY` is mutated by `registerInternalLayers`/`unregisterInternalLayers`/`applyLayerRange` (`src/lib/internalLayers.ts:234-249`) and one unmount deregisters under the other; `useChat` persists to the single key `blo:conversation` (`src/composables/useChat.ts:88`). Safe singletons: `bundleRequest` (JSON deduped), the manifest/values/points caches, `countyLookup`. **Geometry is not deduped** — `loadCountiesGeoJSON` (`useMapData.ts:100`) has no promise cache, so a second mount re-fetches and re-parses 1.86 MB (an 8-line fix mirroring `bundleRequest`).
- **Driving the map:** there is no bus or store; the map tools take a `ToolContext` of closures built at `Map.vue:2890` and handed to `useChat`, executed via `executeTool` (`src/lib/mapTools.ts:203`). A chat page must hold the context the canvas built (`emit('ready', ctx)` or `defineExpose`) and run the map-tool subset client-side against it, while the library tools stay on the server.
- **Fallback (S, no extraction):** a static frame per answer — a saved view link (`src/lib/views.ts`, `/?view=<slug>`) or a Mapbox Static Images thumbnail. Zero new client state, no second WebGL context. Use this if P6-7b runs late.
- Risks: no test seam around the map core; two WebGL contexts on phones (recommend desktop-only ≥1024 px); the bundle-leak gate and the byte-identical logged-out header must both stay green.

---

## P6-10 [FEATURE] The map pane on the chat page

**Type:** Feature · **Priority:** P1 (Nick, 2026-09-23: "we definitely need that bare map canvas refactor") · **Size:** M · **Dependencies:** P6-7b, P6-9

### Direction
The canvas is the first cut of a deeper split of `Map.vue`. Once the canvas exists, the public chrome comes apart along the same seams — Lens, the walkthrough, saved views and deep links, the county modal, the rails — each a component that talks to the canvas through the same props and `ToolContext`. The canvas boundary is also the only place a basemap swap (e.g. MapLibre GL, the open-source fork of mapbox-gl) would ever touch; not planned now.

### Design
- `src/components/MapCanvas.vue`, extracted from `Map.vue`: container, `mapboxgl.Map`, counties source, choropleth + colours, `zoomToGeoId`/`fitToGeoIds`/`inspectCounty`, point and contamination plumbing. Props `layers`, `query`, `focusGeoId`, `fit`; emits `ready(ToolContext)` and `county-click`. No Lens, no PromptInput, no rails, no saved views, no URL writing.
- `Map.vue` keeps every public surface and wraps `MapCanvas`; `HomeView.vue` untouched; the public map's rendered output and the logged-out header are unchanged.
- `useMapData`: geometry gets a shared promise cache beside `bundleRequest`; layer `visible`/`status` move to per-instance state so two canvases cannot lie to each other about a loaded layer.
- `/chat`'s right pane is closed by default and mounts `MapCanvas` with `v-if` on open — no county file is fetched until then. Header with the active layer name and a Close; desktop only (≥1024 px), collapsed on phones.
- The chat holds the canvas's `ToolContext` and runs the map-tool subset (`show_layer`, `zoom_to_county`, `show_county_details`, `set_query_state`) through `executeTool`; the library tools stay on the server.
- Tests: no `/datasets/build/*` request until the pane opens; both instances can hold different layers on; public-map snapshot and bundle-leak gate unchanged; a Cypress pass over the pane's open/close and one `show_layer` round trip.

### Baseline (2026-09-23, before the extraction)
Every "Show on map" form was driven live with Playwright on the demo stack and on production, all green: entry page and palette → `/?layers=internal-<slug>&fit=bbox:…` (point layer drawn, map framed on the layer's extent: Organizations 43 features nationally, Memphis at zoom 6.6), layer page → `/?layers=<public-id>` (choropleth + legend), compare → `&fit=<geoids>` (zoom 8 on Fulton/DeKalb), `?focus=<layer>:<label>` (zoom 9 on the point, entity rail open), place → `?fit=<geoid>`, and logged out the internal id is dropped silently with no request. `cypress/e2e/mapDeepLinks.cy.ts` pins this contract with stubbed layer routes and the real map, read through `window.__bloMap` (exposed in the e2e build by `VITE_E2E=1`). **The extraction must keep that spec green unchanged** — it is the shared behaviour between the public map and the chat pane. Nick's earlier "not working" report most likely came from a phone: Safari drops the cross-site session cookie, the map boots logged out, and internal ids are (correctly) ignored — the api.blacklandownership.com CNAME fixes that.

### ✅ DONE (2026-10-03)
- **Files.** New: `src/components/MapCanvas.vue` (1,838), `src/composables/useMapState.ts` (946), `src/lib/countyOverlays.ts` (112), `src/testing/mapboxStub.ts`, `src/components/__tests__/MapCanvas.spec.ts`, `src/composables/__tests__/useMapState.spec.ts`, `cypress/e2e/chatMapPane.cy.ts`. Changed: `Map.vue` (**4,427 → 2,312 lines**), `ChatView.vue` (+ pane), `useMapData.ts` (geometry cache), `internalLayers.ts` (per-owner registration), `mapTools.ts` (`QueryStateInput.only`), `useLibraryChat.ts` (`onToolCall`), `usePhoneLayout.ts` (`useMediaQuery` + `MAP_PANE_QUERY`), `docs/CHAT.md`. `HomeView.vue` untouched.
- **The boundary is three parts, not two.** `useMapState()` holds what a map *is showing* (selection, weights, filters, limit, the scoring chain, the internal layer lists); `MapCanvas.vue` holds everything that touches a `mapboxgl.Map`; `Map.vue` keeps every public surface — Lens, PromptInput, rails, walkthrough, saved views, deep links, the county modal — and wraps the canvas. The state had to come out separately because both the canvas (to paint) and the chrome (to render the Lens and the rails) read and write it; leaving it in the canvas would have had the chrome reading through a component ref that is null until mount.
- **Props** `layers`, `query`, `focusGeoId`, `fit`, plus `data` (the page's one `useMapData()` store, so the chrome and the canvas read one download) and `exposeHandle`. **Emits** `ready(ToolContext)`, `county-click`, plus `counties-ready` — the chrome's deferred replays (a snapshot-restored inspect, `?view=`, `?layers=`) need to know the polygons exist. `defineExpose` carries the imperative surface the chrome drives: `zoomToGeoId`, `fitToGeoIds`, `fitToBbox`, `focusEntity`, `showLayer`, `ensurePublicLayerOn/Off`, the contamination rows, `waitForPointData`.
- **The four module-level blockers.** (1) `layer.visible`/`layer.status`: each instance gets `reactive()` copies of the config arrays, which are definitions again and never mutated — a test asserts the exported arrays stay untouched. (2) `LAYER_REGISTRY`: `registerInternalLayers(entries, owner)` / `unregisterInternalLayers(owner)` hold registration per owner (the state's `instanceId`) and the last holder is what deletes; the default owner keeps the old single-caller behaviour, so the existing specs are unchanged. (3) `useChat`'s `blo:conversation`: the pane never instantiates `useChat` — it runs the map tools through `executeTool` against the canvas's context, so the key keeps one owner. (4) `loadCountiesGeoJSON`: a `geometryRequest` promise cache beside `bundleRequest`, same eviction-on-failure; two instances get the same parsed object, asserted by identity.
- **Driving it:** `MapCanvas` builds a complete `ToolContext` (`toggleRankingPanel` a no-op, `triggerHousingSearch` framing the county — a bare canvas has no panel and no listings); `Map.vue` builds its own on top for the two the public chrome owns. `useMapState.onQueryApplied` is how the chrome reacts to a query the model set — leaving a walkthrough, opening the ranking panel — so a prompt and a `set_query_state` do the same thing.
- **The chat pane:** closed by default, `MapCanvas` behind `defineAsyncComponent` + `v-if`, desktop only (`MAP_PANE_QUERY` = 1024 px; narrowing past it closes the pane rather than hiding a live map), header with the active layer name and a Close. A `tool_call` event naming one of the four map tools **with `args`** is executed client-side, opening the pane and queueing until the canvas is ready. Registering those four in the server's library-chat tool table is follow-up; `onToolCall` is the seam.
- **Beyond the chat pane (Nick, 2026-10-03):** "show on map … loses the context of the page where the show on map was happening … we'd want it so that show on map is like a submap like in chat". The canvas is built for that: `useMapState({ layers, filters, limit, only })` + `:fit`. The new piece is **`query.only`** — the GEOIDs of a page's own filtered rows, which a `?layers=…&fit=…` link cannot express; set, it *is* the answer (outlined, framed, everything else dimmed) with or without a scoring query. Null on the public map, so nothing there changed. Call sites are **not** built: see P6-14.
- **Gates:** client `npx vitest run` **92 files / 1,667 passing** (38 new; 1,620 before, the rest of the delta is the concurrent P6-13 work). Server `npm test` **2,030 passing / 14 skipped**, untouched by this ticket. `npm run type-check` clean. `npm run build` green, bundle-leak gate green; entry chunk measured HEAD vs HEAD+this in a clean worktree: **499.14 kB raw / 166.46 kB gz → 506.82 / 168.87** (+7.68 kB raw, +2.41 kB gz, the cost of the component boundary and the state facades); ChatView's own chunk 25.23 → 26.65 kB. Cypress: **all 5 specs pass** — `mapDeepLinks.cy.ts` 4/4 **green and unedited**, `smoke.cy.ts` 4/4, `chat.cy.ts` 3/3 unedited (its "the pane is not there" assertion still holds: closed by default), new `chatMapPane.cy.ts` 4/4.
- **The map core has a test seam now.** `src/testing/mapboxStub.ts` is a jsdom `mapbox-gl` stand-in that records sources, layers, paint, filters and the viewport, so `MapCanvas.spec.ts` can assert the choropleth paints, two canvases hold different layers on their own styles, a click reports a county and decides nothing, `window.__bloMap` goes to the one canvas that claims it, and `executeTool` moves *this* map and not the other one. Before this, mapbox-gl was untestable and `Map.vue` was stubbed wholesale.
- **Deliberately out of scope:** the deeper `Map.vue` split (Lens, walkthrough, saved views, rails as their own components — the canvas is the first cut, as the Direction section says); the server-side registration of the four map tools; "Show on map" call sites (P6-14); the ~2.4 kB gz entry growth, which P6-12 is the place to address.

---

## P6-14 [FEATURE] "Show on map" opens a submap in place

**Type:** Feature · **Priority:** P2 · **Size:** M · **Dependencies:** P6-10

### Why
Nick (2026-10-03): "show on map basically routes to the main map and zooms to fit, but doesnt necessarily show the data or filtered data in question, and loses the context of the page where the show on map was happening. we'd want it so that show on map is like a submap like in chat so i can easily x it out or stay within the original page but use show on map as additional context."

Every "Show on map" today is a link to `/?layers=…&fit=…`: it leaves the page, and the URL can say *which layer* and *where to look* but not *which rows you were looking at*. P6-10 built the component that fixes both — a closeable map pane that mounts anywhere and takes a page's own filtered row set as the answer.

### Design
- A `MapPane.vue` wrapper around `MapCanvas` — the header, the X, the breakpoint and the open/close state that `ChatView` currently holds inline, lifted so a page gets a pane in one line.
- Each call site opens it in place instead of linking away, passing what it is actually showing:
  `useMapState({ layers: [<layer id>], only: <the filtered GEOIDs>, filters, limit })` and `:fit="{ geoIds }"` (or `{ bbox }` for a point layer's extent).
  - **Layer page** → that layer on, `only` = the rows after the page's filters.
  - **Compare** → `only` = the counties being compared, `fit` = their union (what `&fit=` does today, minus the navigation).
  - **Dataset explorer / search results** → `only` = the visible rows, so the map shows the table.
  - **Entry page / palette** → the point layer, `fit` = its bbox.
  - **Place** → `focusGeoId` = the county.
- The deep links stay exactly as they are: a link is still how a view is *shared*, and `mapDeepLinks.cy.ts` still pins it. This is about not leaving the page you are reading.
- Tests: a pane opens and closes on a layer page without touching the route; `only` renders the filtered subset and nothing else; no county file is fetched until a pane opens; the existing "Show on map" links still work for anyone who opens them in a new tab.

---

## P6-11 [FEATURE] Provenance for compiled datasets — DEFERRED

> **Deferred (Nick, 2026-10-05):** *"let's defer 6-11, not an important
> distinction for us right now and potentially unproductive."* Not cancelled —
> the reasoning below still holds and the folder still carries the lineage — but
> publisher-vs-compiler is not a distinction worth paying for yet.
>
> Two notes for whoever picks it up. Its open question is already closed (Nick,
> 2026-10-04: the June 2026 mining pass's upstream is unknown, and provenance
> should record that rather than wait for it). And **`provenance` now means
> something else in this codebase**: P6-34 shipped `meta.provenance.<field>` for
> how a *metadata value* got there, while this ticket is about where a dataset's
> *rows* came from. Pick a name that does not collide.


**Type:** Feature · **Priority:** P2 (optional augmentation — Nick, 2026-09-23: the P6-1 reading "was fine as before but this also seems like a fine augmentation") · **Size:** S · **Dependencies:** P6-1, P6-3 (lands after wave 2 so it does not collide with the browsers)

### Why
Nick (2026-09-23): "BLO didn't really create any datasets, we aggregated them. the data provenance should be available or discernable from the datasets folder we used to generate those." (Said of the 22-entry BLO count, which is mostly BLO-authored documents; the three compiled datasets are the real case.) The P6-1 dry run put 22 entries under `blo`: 17 documents and 2 notes BLO authored (right), and the three network datasets `individuals`, `landholders`, `organizations`, which BLO **compiled**. What the folder shows: `lineage.from` names the master CSV or PDF each came from; `Individuals_Deduplicated.csv` has a per-row `Source` column and `Organizations.csv` an `Extraction Source` column, but both name the **extraction batch** ("41-50 extraction; uploaded extraction tables / mining pass", June 2026), not an upstream publisher; the HQ enrichment has a real per-row `hq_source` URL (each organization's own site, CauseIQ, IRS). So the upstream of the mining pass is not in the folder — it has to come from Nick (open question below).

### Design
- **Organization keeps one meaning: publisher of record.** A compiled dataset's organization is its compiler, but the manifest says so: `organizationRole: compiler` (default `publisher`). Derived at reindex when `lineage.from` is present and the manifest does not say otherwise.
- **`provenance` on the row**, derived at reindex and overridable in the manifest: `{ role, from: [{ label, kind: file|url|note, note? }], perRow: [{ column, distinct, top: [{ value, count }] }] }` — `from` from `lineage.from` / `lineage.enriched[].method` / `lineage.cleaning`; `perRow` from any column named `source`, `*_source` or `extraction source` (case-insensitive), first 5 values by count. Read from the held file once, cached like shape.
- **Datasets browser:** under the Organization grouping a compiled dataset sits under its compiler with the group label "BLO · compiled" (a separate group from anything BLO published), and its row one-liner reads "Compiled from Individuals_Deduplicated.csv (June 2026 extraction) · HQ fields from each organization's site". **Entry page:** a Provenance section — the lineage steps, the per-row source columns with counts, and the enrichment methods and dates.
- **MCP `get_entry`** exposes `provenance`; the chat's system prompt tells the model to say "compiled by" for role `compiler`.
- `retag --provenance` reports what each dataset's provenance reads as (report only).
- Manifests for the three network datasets get `organization: blo`, `organizationRole: compiler` and, once Nick answers, a `provenance.from` entry naming what the June 2026 mining pass drew from.
- Tests: role derivation, the per-row column scan (names, cap, missing file), the group label, the entry section, MCP.

### ✅ Open question CLOSED (Nick, 2026-10-04)
Asked: what were the "uploaded extraction tables" of the June 2026 mining pass drawn
from? Nick: *"i dk about the mining pass and i cant imagine its that important."*

**So the ticket proceeds without it, and that is a fine answer** — provenance records
what is knowable, not what we wish were knowable. The two CSV-backed network datasets
get `provenance.from` naming the extraction batch exactly as the folder states it
("41-50 extraction; uploaded extraction tables / mining pass", June 2026), with no
upstream publisher claimed. An honest "compiled by BLO from its own June 2026
extraction pass; upstream sources not recorded" is more useful than a blank, and it
stops a reader assuming the rows came from somewhere citable.

If the upstream ever matters — a funder asks, or a story wants to cite it — the
manifest field is already there to fill in. **P6-11 is no longer blocked.**

---

## P6-12 [TASK] Keep the vocabularies out of the public entry chunk

**Type:** Task · **Priority:** P2 · **Size:** XS · **Dependencies:** P6-1, P6-2

After wave 2 the public entry chunk grew from 163 KB to 166.7 KB gzipped (490 KB → 500.5 KB raw): `src/config/organizations.ts` (29 publishers with aliases) is imported by `src/lib/publicLayers.ts` for `layerOrganization`, and the shape labels ride in with the taxonomy. The public map never shows an organization or a shape. Move `layerOrganization` (and anything else the browsers need from the registry) into an internal-only module so the vocabularies load with the knowledge base, and add the two module names to the bundle-leak script's "must not appear in the entry chunk" list. Measure before and after.

---

## P6-13 [CHORE] The nav plane: Search, Chat and New belong to the library

**Type:** Chore · **Priority:** P1 · **Size:** S · **Dependencies:** P6-5 (which created the header)

### Why
Nick (2026-10-03): "map / about / library are on the same plane as search/chat/new, but those latter functions are top level library functions, that sit within library, not sitewide."

P6-5 put all four internal items — Library · Search · Chat · New — next to Map and About, which says they are site-level destinations. They are not: they are this spec's own **three functions** over its **three resources**, and both axes belong to the library. The code already admits the confusion — `OWN_PAGES` in `App.vue` treats `/search`, `/chat` and `/new` as *not* the library, so "Library" goes dark while you are using a library function.

### Design
Shape chosen by Nick (2026-10-03) — one strip, divided:

```
sitewide   ◉ BLO   Map   About   Library              ⌘K  ?  nick
library    Datasets  Docs  Analysis │ Search  Chat  New
           ───────── browse (nouns)   do (verbs)
```

- `src/App.vue`: the three RouterLinks leave the header. `Library` stays inside the single `<template v-if="internalUser">` — one template renders one `<!--v-if-->` marker whether it holds one link or four, so the **logged-out header's byte-for-byte snapshot must not move**. If it moves, the change is wrong.
- `OWN_PAGES` narrows from `/^\/(search|chat|new|account)(\/|$)/` to `/^\/(account)(\/|$)/`, so Library stays lit on the three function pages — they are inside the library now. `/account` stays its own page.
- Rewrite the P6-5 comment block above `INTERNAL_PATHS`; it describes the four-item header.
- `src/components/KbNav.vue`: `SECTIONS` splits into RESOURCES (`Datasets · Docs · Analysis`, matches unchanged) and FUNCTIONS (`Search → /search`, `Chat → /chat`, `New → /new`), rendered as one strip with a divider between the groups. Update the doc comment — it currently says "What a person *does* — Search, Chat, New — is in the header above" — and the `aria-label`, which says "Knowledge base resources" and now covers both axes.
- The ≤640px strip already scrolls (`flex-wrap: nowrap`, `overflow-x: auto`), so six items need no new rules; verify at 390px.
- **The audit (2026-10-03) confirms this lands cleanly:** `KbNav` **is** already rendered on `/search`, `/chat` and `/new`, so the three function items join a strip those pages already show. It is **not** rendered on `LibraryEntryView`, `WikiPageView` or `DatasetView` — which makes its `/wiki` → Docs match rule (`KbNav.vue:26`) unreachable code; delete it or render the strip there, but do not leave it. Today the only signal that Search, Chat and New sit inside the library is the site title swapping to "BLO Knowledge base" (`App.vue:46`) — which is exactly Nick's point.
- The ⌘K pill and a `Search` item are now both in view at the library level. Noted, not resolved here.

### Acceptance criteria
- **Given** a logged-out visitor on any public page, **when** the header renders, **then** it is byte-for-byte what it is today — the existing snapshot test is the judge.
- **Given** an internal user on `/search`, `/chat` or `/new`, **then** `Library` is lit and the matching item in the library strip carries `aria-current="page"`.
- **Given** an internal user on `/datasets`, `/docs` or `/analysis`, **then** the resource tab is lit and no function item is.
- **Given** a 390px viewport, **then** all six items are reachable by horizontal scroll with a ≥44px touch target each.

### Out of scope
The ⌘K-pill / `Search` redundancy. Any change to what the three function pages contain.

### Tests
`App.spec.ts` (header items, the lit rules, the logged-out snapshot), `KbNav.spec.ts` (two groups, the divider, active marking across six paths), `KnowledgeBaseView.spec.ts`, `cypress/e2e/internalAuth.cy.ts` (nav words, the guard on all seven routes).


### ✅ DONE (2026-10-03)
- **`App.vue`**: the sitewide header is `Map · About · Library` plus the ⌘K pill, Help and the account link. `Library` stays inside the single `<template v-if="internalUser">`, so the logged-out header's byte-for-byte snapshot **did not move** — one template renders one `<!--v-if-->` marker whether it holds one link or four, which is what made removing three links free.
- **`OWN_PAGES` narrowed** from `/^\/(search|chat|new|account)(\/|$)/` to `/^\/(account)(\/|$)/`. This was the bug in code form: the router treated the three functions as *not* the library, so the header's one lit item went out exactly while you were using the library. `/account` stays its own page — it belongs to the person, not the library.
- **`KbNav.vue`** carries both axes in one row: `RESOURCES` (Datasets · Docs · Analysis, matches unchanged) then a decorative `aria-hidden` divider then `FUNCTIONS` (Search · Chat · New, each marking itself exactly). `aria-label` moved from "Knowledge base resources" to "Library", since the strip is no longer only resources. The phone rules now earn their keep: six items scroll where three fitted, and the divider is `flex: 0 0 auto` so the two groups stay distinguishable mid-scroll.
- `KbNav.vue`'s `/wiki` → Docs rule is **kept, not deleted** (the audit flagged it as unreachable because `WikiPageView` does not render the strip): the match table is the vocabulary, not a list of today's call sites, and a page that starts rendering the strip should light Docs.
- **A Cypress test was passing for the wrong reason and now is not.** `internalAuth.cy.ts` asserted `cy.contains('nav a', 'Search')` under a comment calling them "header items" — but `KbNav` is itself a `<nav>`, so that selector matches either place and would have kept passing if the functions climbed back into the header. It is now scoped: each of the six must be in `[data-testid="kb-nav"]` **and** absent from `header nav`.
- Verified live at 1440px: header `Map · About · Library` with Library lit while standing on `/search`, and the strip reading `Datasets · Docs · Analysis │ Search · Chat · New` with Search marked.
- Tests: KbNav 10 (3 added/rewritten — both axes and their hrefs, the silent divider, each function marking itself; plus a phone rule for the divider), App 2 rewritten + 1 added (the sitewide three, the three functions absent, Library lit across all ten internal paths), KnowledgeBaseView 1 rewritten. Whole client suite **1671 green**; the logged-out header snapshot untouched.

---

## P6-14 [FEATURE] Show on map, in place

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** **Blocked by P6-10** — needs `MapCanvas` and its final prop contract

### Why
Nick (2026-10-03): "show on map basically routes to the main map and zooms to fit, but doesnt necessarily show the data or filtered data in question, and loses the context of the page where the show on map was happening. we'd want it so that show on map is like a submap like in chat so i can easily x it out or stay within the original page but use show on map as additional context."

Two defects behind one button:
1. **Context loss.** Every "Show on map" navigates to `/` with a deep link, so the page you were reading is gone and Back is the only way home.
2. **Fidelity loss.** The deep-link contract (`?layers=…&fit=…&focus=…`) expresses *a layer and a viewport*, not *the subset this page is showing*. A filtered or sorted table "shown on the map" draws the whole layer.

### Design
- Replace the navigation with an in-page pane: the P6-10 `MapCanvas` mounted beside the content on the page that asked, with a header naming the active layer and a Close (X). Closing leaves the page untouched; the route never changes.
- Same component and same `ToolContext` the chat pane uses — one canvas, several hosts.
- Call sites: `LibraryEntryView` (an entry with a layer block), `DatasetView` (the filter/sort currently on screen), `LayerAboutView`, `CompareView` (the shortlist). Exact props come from P6-10's reported contract.
- **The filtered-subset problem is the substance of this ticket.** If P6-10 reports that `query` cannot express a row subset, this ticket adds that expression — a GEOID / feature-id set the canvas filters to — rather than widening the URL grammar. Deep links are unchanged and `mapDeepLinks.cy.ts` stays green unedited.
- Desktop only (≥1024px), matching the chat pane; on a phone today's navigation stands.
- A pasted `/?layers=…` URL must still open the full map. This ticket changes what the **button** does, not what the **URL** means.

### Acceptance criteria
- **Given** a dataset page with a filter applied, **when** Show on map is pressed, **then** a pane opens on that page drawing only the filtered rows, and the page's filter state and scroll position survive.
- **Given** an open pane, **when** Close is pressed, **then** it unmounts, the page is unchanged, and re-opening re-fetches no county data.
- **Given** a phone viewport, **then** the pane does not mount.
- **Given** a pasted `/?layers=…&fit=…` URL, **then** the full map opens exactly as today.

### Out of scope
The chat pane (P6-10). The deep-link URL grammar. Phone support.

### Tests
One per call site that the pane mounts with the page's current selection; no `/datasets/build/*` request until a pane opens; `mapDeepLinks.cy.ts` unchanged and green; a Cypress pass over open → filter → close on one call site.

### ✅ DONE (2026-10-03)
- **Files.** New: `src/components/MapPane.vue` (167), `src/composables/useMapPane.ts` (63), `src/composables/useShowOnMap.ts` (145), `src/testing/viewport.ts`, `src/testing/countyData.ts`, `src/components/__tests__/MapPane.spec.ts`, `src/composables/__tests__/useMapPane.spec.ts`, `src/composables/__tests__/useShowOnMap.spec.ts`, `cypress/e2e/showOnMap.cy.ts`. Changed: `LayerAboutView.vue`, `DatasetView.vue`, `CompareView.vue` (the three call sites), `CountyTable.vue` (a `shown` emit), `ChatView.vue` (**−49 lines**: its inline pane is now `MapPane`). `MapCanvas.vue` and `useMapState.ts` **untouched** — P6-10 built exactly the surface this needed.
- **`query.only` carried every call site.** It is the whole fidelity half of the ticket and it needed no widening: set, it *is* the answer — the counties in it stay saturated, everything else drops to 0.35 alpha, and `fit` frames them. Each page says what it is showing and nothing more:
  - **Layer page** (`/layers/:id`) — `only` = the GEOIDs `CountyTable` is showing, the search applied, which the table now reports through a `shown` emit (the same set "Download what I see" writes out). Search "Mississippi" and the map flies to Mississippi with 81 counties lit and the other 3,043 dimmed, with the page still behind it.
  - **Dataset explorer** — `only` = the GEOIDs of `shownRows`, i.e. the server page after the search, the filters and the sort, read through `rowGeoId(row, geoIdColumn)`. Rows whose cell is not a GEOID are dropped: they are not counties, so the map says nothing about them.
  - **Compare** — `only` = the shortlist, `fit` = its union. `&fit=` already framed those counties; what it could not do was *say* they were the answer, so it drew the whole layer and put a box round the right part of it.
- **Three things `only` could not carry**, reported rather than papered over:
  1. **A point layer's rows.** `only` filters county *polygons*; a point overlay has its own source and its own markers, so dimming counties under an unfiltered scatter of dots would read as "these are your rows" while showing all of them. A point dataset therefore draws its whole overlay, framed on its own extent (`boundsForPointFeatures` after `waitForPointData`), and the pane's note says **"Every point in this layer"** out loud. Filtering points needs a feature-id filter on the point source — not this ticket.
  2. **A layer page with nothing searched.** "Every county this layer has a number for" is the layer, not a subset of it, and framing that union opens the map on the globe (it contains Guam and American Samoa — this was caught live, not in a test). Unsearched, `only` is null and the page means what the old link meant: the whole layer, default view. Searched, the subset is real. One rule, `shownSubset`, drives both the subset and the note.
  3. **A dataset with no county key column.** `geoIdColumn` is discovered from the data, not declared; without it there are no GEOIDs to send and the pane draws the layer unnarrowed.
- **The pane is three pieces, and the chat page gave up two of them.** `useMapPane()` is the switch — the ≥1024 px breakpoint, open/close, and the rule that narrowing the window *closes* the pane rather than hiding a live WebGL context (`onClose` runs either way, which is how `ChatView` still drops its `ToolContext`). `MapPane.vue` is the chrome — header, note, X, and the `defineAsyncComponent` that keeps mapbox-gl and the county files out of a page nobody opened a map on. `useShowOnMap(selection)` is the wiring: it holds a `useMapState()`, applies the page's layers and `only` synchronously on open (so the header never flashes the default), re-applies after the layer manifest resolves an `internal-…` id, and keeps following the page for as long as the pane is open. A call site is six lines.
- **A closed pane is not a live view.** Nothing is applied until someone opens one, and the watcher that follows the page is gated on `isOpen` — so a reader who never presses the button pays for none of it.
- **Deep links are untouched.** `mapDeepLinks.cy.ts` is **green and unedited** (`git diff` on it is empty), and `showOnMap.cy.ts` opens a pasted `/?layers=…` itself to say so. Below 1024 px every call site renders the RouterLink it always did, with the same href — the three existing href assertions (`layer-map-link`, `compare-map`, `show-on-map`) still pass unchanged, because jsdom's absent `matchMedia` puts those tests on the narrow path.
- **Not sticky, deliberately.** The first cut made the pane `position: sticky` so the map would hold its place while the table scrolled. It does not work and the reason is structural: these route roots are viewport-height flex items of `App.vue`'s `main`, so a sticky child's containing block is one screen tall and scrolls away with it. Keeping the map in view needs the shell's scroll model changed, which is not this ticket. The pane is a plain `26rem` column, `calc(100vh - 140px)` tall.
- **`LibraryEntryView` is out of scope** (another agent was in the file) and is the one call site left — *its own* entry-level "Show on map" (`show-on-map`, `map-open`) still navigates. Its **Data tab already has a pane**, because that tab is `<DatasetView embedded />` and the work landed inside `DatasetView`; verified live on `/library/organizations?tab=data`. Also still navigating: the dataset row drawer's per-row "Show on map", which focuses a *point by label* — `focusGeoId` takes a county, so that one needs the entity plumbing, not `only`. Both are follow-ups.
- **Known cost:** `fitToGeoIds` (P6-10, unchanged) resolves each GEOID with a linear `find` over ~3,220 features, so framing an *N*-county subset is O(N·3,220). Bounded in practice — compare ≤12, a dataset page ≤200 — but a layer-page search matching thousands of counties will frame slowly. A GEOID→feature index in `MapCanvas` would fix it; not needed yet.
- **Test seams, shared not copied.** `src/testing/viewport.ts` (a width-driven `matchMedia` that can also *resize*, so "the pane closes when the window narrows" is a real assertion) and `src/testing/countyData.ts` (the two county files as fixtures plus the `fetch` stub) replace three ad-hoc copies; `ChatView.spec.ts` was migrated onto both.
- **Verified live at 1440 px** on the dev stack, zero console errors or warnings: layer page open → the US choropleth beside the page → search "Mississippi" → the map flies there, note reads "81 of 3,124 counties", URL still `/layers/median_home_value` → close → the search box still says Mississippi and the page is untouched. Compare: three counties lit, header "Median Home Value · Life Expectancy", note "3 counties". Dataset: "Organizations (HQ)", "Every point in this layer", clusters framed nationally. Resizing to 900 px closed the pane and brought the link back. `/?layers=median_home_value&fit=13121,47157` still opens the full map at zoom 7.18 between Atlanta and Memphis. Screenshots: `p614-layer-before`, `p614-layer-pane-open`, `p614-layer-filtered`, `p614-compare-pane`, `p614-dataset-point-pane`, `p614-deeplink-unchanged`.
- **Gates:** client `npx vitest run` **95 files / 1,804 passing** (48 added here: MapPane 8, useMapPane 6, useShowOnMap 13, LayerAboutView +8, DatasetView +7, CompareView +6; the rest of the delta from 1,700 is the concurrent P6-15/P6-16 work). Server `cd server && npm test` **2,044 passed / 14 skipped**, untouched by this ticket — one `mcp.test.ts` assertion flakes under CPU contention and is 57/57 green in isolation. `npm run type-check` clean. `npm run build` green, bundle-leak gate green (56 files, 10 canaries). Entry chunk **508.64 kB raw / 169.52 kB gz** against the 508.56 / 169.49 baseline — **+0.08 kB raw, +0.03 kB gz**, because all of it lands in lazy chunks: `useMapPane` 2.50 kB (1.23 gz, holds `MapPane.vue`), `useShowOnMap` 2.18 kB (1.16 gz), 1.74 kB of CSS (0.80 gz); `ChatView`'s own chunk **shrank 26.65 → 26.05 kB** as its pane chrome moved out. Cypress: **all 6 specs pass** — new `showOnMap.cy.ts` 3/3, `mapDeepLinks.cy.ts` 4/4 green and unedited, `chatMapPane.cy.ts` 4/4 and `chat.cy.ts` 3/3 unedited through the `ChatView` refactor, `smoke.cy.ts` 4/4, `internalAuth.cy.ts` 6/6 + 3 pending.

---

## P6-15 [BUG] The place report is titled by coordinates, not by the place

**Type:** Bug · **Priority:** P1 · **Size:** S · **Dependencies:** none

### Bug
Nick (2026-10-03): "the place report resolves to latitude/longitude instead of the cleaned up / identified location name. this is far less readable, though its fine to have lat long as auxiliary data."

**Expected:** a report is headed by the identified place — the resolved name.
**Actual:** it is headed by raw coordinates.

### Root cause (traced by the UX audit, 2026-10-03)
Not a rendering miss — **the label is never captured for a point.** `server/src/services/placeFetch.ts:148-158`, the `if (point)` branch of `resolvePlace`:

```ts
label: `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`,
```

There is no reverse geocode. The *address* branch (160-170) keeps Nominatim's `display_name` via `found.matched`; the *geoid* branch resolves `countyLabel(geoid)`. Only the point branch stringifies the coordinates, and `src/views/PlaceView.vue:388` renders `report.place.label` verbatim as the `<h1>`.

The proof it is a capture failure and not a data failure: on the same page the model-written summary immediately below reads *"Environmental and land risk summary for 40.7785, -73.9572 **(Upper East Side, Manhattan area)**"* — the model named the place and the page could not.

**It also leaks into the library permanently.** `src/lib/placeReport.ts:440` titles the saved note `Place report: ${report.place.label}`, so `/kb` Recently edited, `/docs` and `/analysis` carry entries literally named *"Place report: 40.7785, -73.9572"*. Confirmed in the server index: `{"placeKey":"p40.7785_-73.9572_r5","label":"40.7785, -73.9572"}`.

### Fix
One reverse-geocode call in the point branch. `server/src/services/geocodePlace.ts` already talks to Nominatim but only uses `/search`, never `/reverse` — so this is one more call against a client that exists, not a new dependency. Coordinates stay as the auxiliary sub-line Nick asked for. Existing reports keep their coordinate labels until re-run; decide whether the reindex backfills them or they age out with the 7-day TTL.

### Design
- The heading, `document.title` and any "report for …" copy read the resolved place name; coordinates move to a secondary line, kept and still copyable.
- A report reached by raw coordinates that resolve to nothing falls back to coordinates — the fallback must not be the default path.
- Every surface that names a report (`/analysis` Recent analyses, the first-run checklist, chat citations) uses **one** helper, so two surfaces cannot name the same report differently.

### Acceptance criteria
- **Given** a report run from an address or a county, **then** the heading is the resolved place name and the coordinates are auxiliary detail.
- **Given** coordinates that resolve to nothing, **then** the heading is the coordinates and nothing renders as "undefined".
- **Given** the same report listed on `/analysis` and open on its own page, **then** both call it the same thing.

### Tests
The label helper (resolved, missing, coordinate-only); the heading; one case pinning the list and the page to the same string.


### ✅ DONE (2026-10-03)
- `reverseGeocode` + `parseNominatimReverse` in `server/src/services/geocodePlace.ts`, using Nominatim's `/reverse` (the client already talked to `/search` only). `zoom=10` asks for the area rather than a doorstep — a report covers a radius. The label is built from the **structured** `address` object (locality · county · state, deduplicated, at most three parts), because `display_name` is a full postal chain down to the postcode and country: accurate, unreadable as a heading. `display_name` is the fallback, null the floor.
- **The naming is NOT in `resolvePlace`** — and the first attempt that put it there was wrong in a way the existing suite caught. `resolvePlace` runs **once per source**, before the slice cache is consulted, so a report would have fired ~40 reverse lookups and one per cache hit; `runPlaceReport` passes resolved numbers down precisely so "no source triggers a second geocode", an invariant the code already documented. So: `namePlace(place)` is a separate step called **once, by `runPlaceReport`, after the cache check**. A reopened report costs no lookup. The name is presentation; `placeKeyFor` reads only the numbers.
- An address keeps the geocoder's words and a county keeps `countyLabel` — both are returned untouched. A failed or empty lookup leaves the coordinates rather than inventing a name.
- Existing reports keep their coordinate labels until re-run; they age out with the 7-day TTL. **Not backfilled** — the saved notes already in the library still read `Place report: 40.7785, -73.9572` and would need renaming separately if that matters.
- Tests: geocodePlace 5 added (17 total) — the URL shape and its `Number()` guard, the structured read, the locality fallback chain and deduplication, `display_name`/null fallbacks, and the guarded call. placeFetch 4 added — **`resolvePlace` making no call at all** (the regression the suite caught), naming on request, the coordinate fallback on empty and on failure, and address/county left alone.

---

## P6-16 [FEATURE] Say what the place report is doing, not how long it has been doing it

**Type:** Feature · **Priority:** P2 · **Size:** S · **Dependencies:** none

### Why
Nick (2026-10-03): "we should have a more descriptive progress than just counting seconds for the place based report."

A bare elapsed-seconds counter says the page is not frozen and nothing else. A place report fans out across many sources; it cannot say how long it will take, but it can say what it is on.

### Design
- Report per-source progress as the fan-out resolves: the source in flight, how many of how many are done, and which came back empty or failed — the run already knows all of this.
- **The open question is answered (UX audit, 2026-10-03): per-source completion is fully observable today.** `runBounded` (`server/src/services/placeReport.ts:286-315`) runs each source as its own task in a bounded pool, and each resolves to a complete `ReportSection` carrying a slug, a title and a status. The only thing missing is a channel — and the pattern already exists in this codebase: `POST /api/chats/:id/messages` streams NDJSON line-events (`server/src/routes/libraryChat.ts`, `docs/CHAT.md`), read by the NDJSON reader in `src/lib/libraryChat.ts`. The place route (`server/src/routes/libraryPlace.ts:124`) is a single JSON response. So *"Checked 14 of 40 · EPA ECHO · 6 found so far"* is a known-shape change, not new infrastructure. Do not add a queue.
- **A zero-server-change half is available if the streaming lands late:** the client already fetches the full `kind=source` catalog to get the count (`src/views/PlaceView.vue:110-120`), so it can at least name the sources it is about to check. Ship that only if the stream slips — it is a consolation prize, not the ticket.

### What it looks like today
`src/lib/placeReport.ts:314-322` builds `Checking 40 sources… 3s`, driven by a 1-second `setInterval` in `PlaceView.vue:126-138`, with a "slow sources get up to 30 seconds each" line after ten seconds. For up to a minute that counter is the only thing moving.
- Keep elapsed time as a secondary signal. It is useful, it is just not the whole message.
- A source that fails says so in the progress and in the finished report rather than vanishing.

### Acceptance criteria
- **Given** a running report, **then** the progress names the source in flight and a done-of-total count that only moves forward.
- **Given** a source that fails or returns nothing, **then** the progress says so and the run continues.
- **Given** a completed report, **then** the progress area is replaced by the report and no counter is left running.

### Tests
The progress reducer over an ordered event sequence including a failing source; the terminal state; no stuck counter after completion.

### ✅ DONE (2026-10-03)
- **Streamed, not polled — and the ticket's own reasoning held up.** Polling needs somewhere to read progress back from *between* requests: a run id and its state, shared across requests and surviving whichever instance answers the next one. That is a queue, which the ticket rules out, and it would have been the first piece of shared run state in this service. Streaming needed nothing new — the route already runs the report inside the request, every source is already its own task resolving to a complete `ReportSection`, and `POST /api/chats/:id/messages` already answers NDJSON. The whole channel is one `Accept` header.
- **The route opens the stream LAZILY, on the first event.** `POST /api/library/place/report` answers exactly as it did before — one JSON object, same status codes — until something has actually happened worth reporting. That keeps the two cases with no progress to report on the plain JSON path: **a cached report** (the common case when reopening from `/analysis`) and **a place that could not be resolved at all**, which keeps its real 400 instead of a 200 committed before we knew there was a run to describe. Headers, when it does open, are the chat route's: `application/x-ndjson; charset=utf-8`, `private, no-store`, `X-Accel-Buffering: no`, `flushHeaders()`. The app's gzip filter is already JSON-only, so nothing buffers it.
- **Four events, all of them things the run already knew and used to throw away** (`PlaceProgressEvent` in `server/src/services/placeReport.ts`): `start` with the total, `source` when one goes out, `section` when one comes back (slug, title, status, `done`, `total`), and `summary` when every source has settled and the model begins writing. Terminal is `report` or `error`, never both — the chat route's rule.
- **`done` is counted on the server, and deduplicated by slug.** A real bug the tests caught: `runBounded` does not cancel what is in flight at the deadline, it stops *waiting* for it — so a source already reported as "could not check in time" answers afterwards and asked to be counted twice. On the measured timeout case that produced **7 section events for a 4-section report**. `reported: Set<string>` fixes it, and the test now asserts `done` climbs `[1,2,3,4]` and that nothing arrives after the report is finished.
- **A refusal mid-stream carries the status it would have been** (`{ type: 'error', status, error, code }`), so the client rebuilds a `PlaceReportError` and `placeErrorMessage` produces the same sentence as before — the page never learns a new vocabulary for failure. `sendFailure` was refactored into `failureOf` so the status-code path and the stream path cannot drift.
- **The page says what it is on, not how long it has been on it.** `progressSentence` → `EPA ECHO · 14 of 40 checked · 6 found so far`; `Checking 40 sources…` before anything has gone out; `Writing the summary · 40 of 40 checked · 12 found so far` for the last phase. `advanceProgress` is a pure reducer and **monotonic in `done`** — a pool of six settles out of order and a progress number that goes backwards is the one thing it must never do.
- **Elapsed time survives as the second line**, as asked: `progressNote` gives `3s`, and at ten seconds the "slow sources get up to 30 seconds each" explanation. **A named failure displaces that explanation** — `12s · FEMA NRI could not be checked` — because the concrete thing that happened beats the general reason it might be slow. The progress block is `role="status" aria-live="polite"`, so it is read out without stealing focus.
- **Measured live** against the real server and a real agency (one-source filtered run, so one agency call rather than forty): `+75ms start` · `+75ms source EPA Superfund NPL` · `+463ms section (1/1)` · `+824ms summary` · `+6473ms report`. Note the shape of that: **5.6 of the 6.5 seconds is the model writing the summary** — which under the old line was a bare counter ticking with nothing else moving, and is now a sentence saying what is happening.
- **Rejected:** naming the sources up front from the catalog (the ticket's "zero-server-change half") — it was explicitly a consolation prize and the stream did not slip; a `?stream=1` query parameter (`Accept` is what content negotiation is for, and it leaves the URL alone); and emitting progress for a cached report, which would be theatre for an answer that was already written.
- Tests: placeReport lib 34 → 60 (the reducer over an ordered sequence including a failing source and an out-of-order straggler; the terminal state; the NDJSON reader over chunk boundaries, a mid-line split, a line it cannot parse, an unknown event type, a terminal event with no trailing newline, a refusal, and a cut stream). PlaceView 32 → 40 (the live line as events arrive, the failure note, `aria-live`, the clock as a second line, and `vi.getTimerCount() === 0` after completion — the "no stuck counter" assertion). Server service 37 → 43 (every section reported exactly once, the check-by-hand source counted before anything goes out, the deadline double-count regression, and silence for a cached report). Route 15 → 22 (the NDJSON headers and event order, plain JSON when unasked, plain JSON for a cached report, status codes for refusals before the stream opens, and that a streamed report is still audited and still cached).

---

## P6-17 [FEATURE] Give the place report a shape

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** P6-15 (shares the header work)

### Why
Nick (2026-10-03): "among that page also just showing an incredibly long list of data - fine to have available but not good ux."

Everything found for a place renders as one flat list. The data is right; the page has no answer to "what should I look at first".

### Measured (UX audit, 2026-10-03) — `/place?lat=40.7785&lng=-73.9572&radius=5`

| | desktop 1440 | phone 390 |
|---|---|---|
| page height | 10,350 px (≈11.5 screens) | 14,950 px (≈17.7 screens) |
| source sections | 40 | 40 |
| topic headings | 6 | 6 |
| inline tables / data rows | 12 / 98 | same |
| `<details>` or collapse controls | **0** | **0** |

Of the 40 sections, **12 found something, 4 found nothing, 24 could not be checked** — so about two-thirds of the page is sources that returned nothing actionable, each rendering a full card with a status sentence, an about block and a link.

**The structure for the fix is already in the data and already on the page.** `groupSections` (`src/lib/placeReport.ts:65`) already renders topic `h4`s (`PlaceView.vue:473-474` — Environment 15, Hazards 6, Water 6, Agriculture 6, Land 5, People 2), and every section carries a `status` (`found` / `none` / `skipped` / `failed` / `timeout`) rendered through `statusPhrase` (`placeReport.ts:329`). The tally line at the top of the page already *states* the split — nothing acts on it. Collapsing `none` + `skipped` + `failed` behind their own summary rows cuts the page to 12 open sections without losing a thing, which is the cheapest version of this ticket and should be the first commit.

### Design
- **Lead with a verdict, not a list:** what was found, from how many sources, and what stands out — then the detail.
- Group by vocabulary the library already has (topic, plus the organization and shape vocabularies from P6-1/P6-2) rather than inventing one for this page. Each group collapsed past the first few rows, with a count on its header.
- **Nothing is removed** — "fine to have available" is the requirement. Everything stays reachable, below the fold or behind a disclosure.
- Empty groups are dropped, as in the browsers; reuse `GroupedList` and `src/lib/browse.ts` rather than writing a second grouping implementation.
- Collapse thresholds come from a real inventory of what a typical report renders — measure, do not guess.

### Acceptance criteria
- **Given** a completed report, **then** the first screen states what was found without scrolling, and no collapsed group exceeds its threshold.
- **Given** any group, **when** expanded, **then** every row that was in the flat list is still there.
- **Given** a report with one source, **then** no empty groups and no grouping control with a single option.

### Tests
Grouping and ordering from a fixture report; a count assertion that nothing is dropped between flat and grouped; the collapse threshold; the single-source case.

### ✅ DONE (2026-10-03)

**Measured, same report as the audit** (`/place?lat=40.7785&lng=-73.9572&radius=5`, served from cache):

| | before | after |
|---|---|---|
| page height, 1440 | 10,350 px (11.5 screens) | **7,030 px (7.8 screens)** |
| page height, 390 | 14,950 px (17.7 screens) | **9,120 px (10.8 screens)** |
| open section cards | 40 | **12** |
| collapse controls | **0** | **7** |
| sections reachable | 40 | 40 |

- **The cheap half went in first, as its own step, and it is where the page height went.** Every section that is not `found` — `none` + `skipped` + `failed` + `timeout`, 28 of the 40 — now sits behind two summary rows: *Nothing within 5 miles · 4 sources* and *Could not be checked · 24 sources*. Opening both brings the page back to exactly 40 cards (verified in the browser: 12 → 40 → 12), so nothing is removed, which was the requirement.
- **`groupSections` is deleted.** It was the second grouping implementation the ticket objects to. Grouping is now `groupRows` from `src/lib/browse.ts` via a `sectionTopicKey(section): GroupKey`, so the report inherits the browsers' rules for free: heaviest heading first, the no-topic group pinned last and drawn quieter, and **empty groups never constructed at all** — on the real report "Agriculture and food" has six sections and none of them found anything, so it simply is not a heading. One behaviour did change: groups used to appear in the order of their first section, and now appear by count, which is the house rule.
- **`GroupedList` itself is not mounted, and that was a deliberate call.** Its markup is `<h2>` + `<ul>/<li>`, which cannot nest under this page's `<h3> Data sources checked` without either inverting the heading order (h3 → h2 → h4) or editing a shared kit component that `/datasets` and `/docs` both depend on — outside this ticket's file list, with two other agents in the tree. So the page keeps its own `h4` heading and reproduces `GroupedList`'s *control*: same caret, same `· N sources` count, same `aria-expanded`, same "folding is a way of reading, so it stays out of the URL" rule. Heading order is now h2 place → h3 "Data sources checked" → h4 group → h5 source.
- **The verdict leads.** `reportVerdict` gives a headline (`12 of 40 sources found something within 5 miles.`), the five biggest finds as anchored links with their counts, and the housekeeping quietly underneath (`4 found nothing · 24 could not be checked`). Ranking is by how much each source returned — not importance, but the only signal the report actually carries, and every one is a link to the rows it is counting. The old run-on tally in the sub-line is gone; `describeTally` stays, because the "Add to page" markdown still uses it.
- **A folded group cannot swallow a link.** The summary's citations and the verdict's standouts both anchor to `#section-…`, so `jumpToSection` opens the containing group and scrolls after `nextTick` when the card is not drawn yet; an open group keeps the plain anchor and the browser's own behaviour.
- **The collapse threshold was measured, and the honest answer is that it is not needed.** The real inventory is Environment 5 found, Hazards 3, Land 2, People 1, Water 1 — the largest group a real report produces is **five** cards. A "first N then show more" control inside a topic would never fire, so it was not built; the 28 non-found sections are the entire bulk, and they are what got folded. Revisit if a place ever yields a double-figure topic.
- **Rejected:** a `GroupControl` for choosing the grouping (the ticket's own AC forbids a control with one option, and topic is the only vocabulary every section carries — `organization`/`shape` are dataset-entry fields, not section fields); folding by status *within* each topic (twelve disclosures saying "and 3 more here" reads worse than two saying what they are); and dropping anything at all.
- Tests: placeReport lib 34 → 60 (group shape and order from a fixture built to the real inventory, the single-source case, the nothing-found case, a count assertion that the flat list and the groups hold the same slugs exactly once, empty groups dropped, and the verdict's headline/ranking/limit/empty cases). PlaceView 32 → 40 (the heading list with counts and `aria-expanded`, 4 open of 7, every row back when the groups are opened, fold and unfold, a citation into a folded group, and the phone rules for the 44 px fold control).

---

## P6-18 [FEATURE] Collapse the filter chips

**Type:** Feature · **Priority:** P1 · **Size:** S · **Dependencies:** P6-3 (the browse kit)

### Why
Nick (2026-10-03, on `/datasets`): "these should probably be expandable."

The page renders every facet value at once: 29 publishers across five rows, 14 topics across two, 4 types across two. About 700px of chips sits between the page title and the first dataset, and the `Group by` control — the thing that changes the page most — is pushed below all of it. The long tail is the cost: publishers run 15, 5, 4, 3, 3, 3, 2… and then seventeen values with a count of 1.

**On a phone it effectively blocks the page** (UX audit, 2026-10-03, 390×844). Measured chip-row heights from `DatasetsView.vue:363-376`: readiness 94 px · **organization 844 px — exactly one full phone screen of publisher chips** · topic 294 px · type 144 px. `Group by` sits at y=1,772 px and the first group heading at **y=1,856 px: 2.2 full screens of scrolling before any dataset is visible.** Nothing collapses at any breakpoint. This is the landing's first tile and step 1 of the first-run checklist. Consider a single "Filters" disclosure under ~640 px in addition to the 8-value cap.

### Design
- `src/components/browse/FilterChips.vue` shows the first **8** values per facet (already count-then-name ordered, so the heaviest are kept) behind a trailing `+N more` toggle; expanded, it shows all and offers `Show fewer`. The "All …" reset chip is always visible and never counts toward the 8.
- **A selected value is always visible, collapsed or not.** If the active filter is the 22nd publisher, it is pulled into the visible set rather than hidden behind the toggle — a filter you cannot see is a filter you cannot clear.
- Expansion is per facet and per visit: component state, not a URL key and not localStorage. A shared link must open the same page for everyone, and `browseQuery` stays as it is.
- A facet with 8 or fewer values renders exactly as it does today, with no toggle.
- This is in the shared kit, so `/docs` gets it in the same change; check it there too.
- `Group by` moves above the chip rows, so the control with the biggest effect on the page is not the one you have to scroll past everything to reach.

### Acceptance criteria
- **Given** a facet with more than 8 values, **then** 8 render plus a `+N more` toggle naming the true remainder.
- **Given** a collapsed facet whose selected value is outside the first 8, **then** that chip is visible anyway and can be cleared without expanding.
- **Given** a facet with ≤8 values, **then** no toggle renders.
- **Given** an expanded facet, **when** the page is shared by URL, **then** the recipient's page opens collapsed with the same filters applied.
- **Given** a 390px viewport, **then** the first dataset row is reachable without scrolling past more than one screen of controls.

### Out of scope
Changing which facets exist, the ordering within a facet, or the `browseQuery` URL keys.

### Tests
The cap and the remainder count; the selected-value-always-visible rule (the case that matters); the ≤8 no-toggle case; expansion not touching the URL; `/docs` inherits it.


### ✅ DONE (2026-10-03)
- `FilterChips.vue`: `VISIBLE_LIMIT = 8`, a `+N more` / `Show fewer` toggle carrying `aria-expanded`, styled borderless so the control never reads as one more publisher. `expanded` is a `ref` in the component — never a URL key, so a shared link opens the same page for everyone and `browseQuery` is untouched.
- **A chosen value is pulled into the folded row wherever it sits** in the order: `visibleFacets` appends the active facet when the first 8 do not contain it, so the twenty-second publisher stays clearable without expanding. A facet of 8 or fewer renders no toggle at all.
- `Group by` moved **above** the chip rows in `DatasetsView` — the control with the largest effect on the page was the one you had to scroll past everything to reach.
- Inherited by `/docs` in the same change (shared kit).
- Tests: FilterChips 7 added (11 total) — the cap and remainder, expand/collapse, no-toggle case, the pulled-in chip staying folded and clearable, and the zero-count chosen chip.

---

## P6-19 [FEATURE] Geographic coverage as a dataset facet

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** P6-1, P6-2 (same derive-at-reindex pattern); pairs with P6-18

### Why
Nick (2026-10-03): "datasets should have a geographic filter too — some datasets only apply to certain states or counties as should be filterable as such."

The catalog cannot currently answer "what do we hold for Georgia?" — the most natural question a place-based organization asks of its own library. The signal is visibly there and unused: Georgia EPD, Alabama ADEM, North Carolina DEQ, DC Open Data and Memphis Horticulture Society are all plainly sub-national publishers, and the held tables carry GEOIDs that say exactly which states and counties they cover. Organization is a poor proxy — a national publisher can hold a single-state dataset — so coverage must be derived from the data, the way `shape` is.

### Design
- **`coverage` on the row**, derived at reindex and overridable by a manifest `coverage:` (unknown value dropped with one warning, exactly like `shape`). Shape: `{ scope: 'national' | 'multi-state' | 'state' | 'county' | 'local', states: string[], counties?: string[], label: string }`.
- **Derivation**, in order, in a new `server/src/services/coverage.ts` beside `shape.ts`:
  1. manifest `coverage:` wins;
  2. a held table with a GEOID/FIPS column → distinct 2-digit state prefixes; ≥45 states ⇒ `national`, 2–44 ⇒ `multi-state`, 1 ⇒ `state` (carry the counties when few enough to be meaningful);
  3. a held table with lat/lng → the states the points fall in, if cheaply determinable, else `local` with no states claimed;
  4. a source → `placeQuery` scope and any state/county named in its notes or access block;
  5. a public registry layer → `national` (they are nationwide county statistics);
  6. nothing determinable → no coverage, which becomes an attention row **Datasets with no coverage**, mirroring `no-organization`.
  Reuse the existing header-only read with the 25 MB cap; never throw, and never read a file twice.
- Stored in `meta` JSONB and promoted to `row.coverage` at read, like `organization` — **no ALTER TABLE**.
- `searchCatalog` takes `coverage=` / `state=`; MCP `search_library` exposes it so chat can answer "what do we have for Georgia".
- **UI:** a Coverage chip row on `/datasets` — `National` plus the states actually present, count-ordered — and `Geography` as a fourth `Group by` option. With P6-18 in place the new row costs one line, which is why these two ship together.
- `npm run library -- retag --coverage` reports what each dataset's coverage reads as (**report only**, like `--shapes`: coverage is re-derived every reindex, and freezing a reading into a manifest would stop it improving). Run the dry run on the real push tree and record the distribution in this ticket before any UI is believed.

### Acceptance criteria
- **Given** a held table whose GEOIDs are all `13###`, **then** its coverage is `state` / Georgia and it appears under a `Georgia` chip.
- **Given** a nationwide county table, **then** its coverage is `national` and it does **not** appear under any single-state chip.
- **Given** a dataset with no determinable coverage, **then** it is excluded from state chips and counted in the "no coverage" attention row — never silently labelled national.
- **Given** `coverage: state:GA` in a manifest, **then** the override wins over derivation.
- **Given** a `state=GA` filter, **then** the list, the group counts and the facet counts all agree.
- **Given** a dataset file that cannot be read, **then** reindex completes and that row simply has no coverage.

### Out of scope
Drawing coverage on the map; coverage for docs and notes; a place-based search UI (that is `/place`); any geometry-based point-in-polygon service if step 3 proves expensive — degrade to `local` instead.

### Tests
One case per derivation rule plus the override; the 45-state national threshold at its boundary; the unreadable-file case; the filter; the group-by; the attention row; MCP exposure; the retag report.


### ✅ DONE (2026-10-04)

- **`server/src/services/coverage.ts`** — `shape.ts`'s sibling, same shape: a closed vocabulary in the taxonomy, a pure derivation with the one file read injected, never throws. `deriveCoverage` reads, in order: the manifest's `coverage:`; a source block; the held table's GEOIDs. `readCoverage` returns the same answer plus **one phrase naming what it was read off**, which is what the report prints — the evidence comes out of the derivation rather than being reconstructed beside it, so the two cannot drift.
- **The source block already answered this question and nobody had asked it.** All 40 sources in the push tree carry `source.coverage` — 36 `national`, 4 `state:XX` — written by hand or by `linkInspect`'s `extentLabel`. So rule 4 reads that field FIRST (then the publisher's own name, then a `national` place query), and the result is that the registry needed no new signal at all. **This is also why the source block is read before the held table**, where P6-2 reads the table first: a source is manifest-only by nature, so the two can only meet when one ships a sample beside its manifest — and a national register sampled for one county would read as that one state. Nothing in the tree has both.
- **A parenthetical is dropped, prose is refused.** `national (coastal states and territories only)` reads as `national`; `2013 to 2023, all 50 states and Puerto Rico` reads as **nothing**. The parser takes a scope word, a `scope:value` pair, or a list in which *every* item is a state — because `source.coverage` is partly model-written and a parser loose enough to find a state in any sentence finds the wrong one. A reading nobody can trust is worse than the queue row.
- **Nothing determinable produces no coverage**, never a scope: `applyShapeAndCoverage` removes the key rather than storing `national`, and the gap becomes **"Datasets with no coverage"** beside `no-organization` in `ATTENTION_RULES` (`src/lib/kb.ts`), inheriting P6-23's archived exclusion. The `coverage=` filter and that queue row share one kind gate, so `coverage=none` means "the datasets nobody could place" and not "everything that is not a dataset" — a test caught that one.
- **One read, two derivations.** `applyShape` is gone; `applyShapeAndCoverage` replaces it, with a per-entry memoising reader, because `pickShapeFile` and `pickCoverageFile` are the same rule over the same names and a 20 MB table must not cross the wire twice to answer two questions about it. `planShapes` in the CLI became `planEntries(rows, {shapes, coverage})` for the same reason.
- **The reindex read is now `fresh`,** like every manifest read in the same walk. Found by a real failure: coverage made the reindex read held tables that shape had answered from a layer block, which exposed that `getFile` was answering from the local mirror — a cache of whole objects by key with no idea a push replaced one. A cleaned table pushed over its old self would have had its coverage derived from the GEOIDs it carried *before* the geocoder ran. Pinned by a test.
- **Where the states live.** `FIPS_TO_STATE` (fips→name) and `STATE_ABBR_BY_NAME` (name→code, buried in `useMapState.ts`) were two halves of one table that could not reach each other. `src/config/stateFips.ts` now holds **one row per state with all three spellings**, the duplicate in `useMapState` is deleted, and `geocode.ts`'s third copy is deleted too (it gains the four territories it was missing). `COVERAGE_SCOPES` joins `SHAPES` in `src/config/taxonomy.ts`; both ride the `taxonomy.generated.json` export with the stale check extended on **both** sides.
- **No ALTER TABLE.** Stored in `meta` JSONB, promoted to `row.coverage` in `withUpdatedAt` like `organization` and `shape` — which is what gets it past the list projection that cuts `source.coverage` out of the manifest. A human's `coverage: state:GA` and a source block both re-fold on read, so only a held table's own GEOIDs need the reindex.
- **`facetsFor` is now multi-valued**, rather than a second function beside it: `keyOf` may return a list, so one row can be under four state chips, and P6-22's "the chosen chip always survives" guarantee stays in exactly one place. `groupRows` deliberately did NOT change — a heading has to total the list. `matchesAnyFilter` is its filter half.
- **One field, three readers** (the `publisherOf` lesson): `coverageChipsOf` builds the chips *and* is what the filter compares, so a chip's count and the list it opens are the same set by construction; `coverageGroupOf` picks the single heading — the state's own name when one state names it, "Several states" when more do. `coverageKeysOf` adds the scope word so a link in the server's grammar (`?coverage=multi-state`, from the chat) narrows the page without putting a redundant chip beside the states it duplicates.
- **UI:** a Coverage chip row on `/datasets` (`All` · National · the states present, count-ordered, "No coverage" pinned last and muted) and **Geography** as the fourth `Group by`. One URL key, `coverage`, which also accepts the `state=` spelling a link from MCP or the chat uses. P6-18's fold at 8 handles a long state list for free — no capping added.
- **`searchCatalog` takes `coverage=` and `state=`**; `search_library` exposes both and every result carries `coverage` / `coverageLabel` / `coverageStates`, with the tool description saying outright that `state="GA"` does not include the nationwide rows and that you ask again with `coverage="national"` when it should. A state is written however you like — `GA`, `Georgia`, `13`.

#### The real dry run — `retag --coverage --dir library-staging/push` (72 manifests, 45 of them datasets or sources)

| scope | entries | |
| --- | --- | --- |
| National | **36** | every federal register, read off its own `source.coverage` |
| One state | **4** | Georgia ×2, Alabama, North Carolina |
| Several states | **2** | `organizations` (26 states, 99 geocoded HQs), `memphis-green-resources` (4) |
| Local area | **1** | `dc-community-gardens` |
| Named counties | 0 | nothing names counties without naming a state |
| **No coverage** | **2** | `individuals`, `landholders` |

"What do we hold for Georgia?" now answers **4**: the two Georgia EPD sources, the Memphis directory and the organizations table. Then Alabama 2, Mississippi 2, North Carolina 2, Tennessee 2, Arkansas 1, and 21 more states at one each — all 21 from `organizations` alone. Report: `library-staging/push/retag-coverage.md`. **Never run with `--apply`; coverage is report-only.**

#### Readings worth pinning with an explicit `coverage:`

1. **`memphis-green-resources` → `multi-state` (AR, GA, MS, TN).** Literally true and misleading: 95 of its 100 geocoded rows are Shelby County TN. The MS rows are real Memphis metro (DeSoto, Marshall), but the Georgia row is a nursery in Fayetteville and the Arkansas one a farm at Roland, 130 miles away near Little Rock. As it stands a Memphis directory appears under the Georgia and Arkansas chips. **Suggest `coverage: state:TN`.** I deliberately did not add a dominance rule (">90% of rows in one state ⇒ that state") — that is re-deciding the agreed thresholds, and this is the one row it would affect.
2. **`dc-community-gardens` → `local`, no states.** 70 points, every one in DC, but the GeoJSON has no GEOID column so rule 3 applies. **Suggest `coverage: state:DC`.** See the point-in-polygon note below.
3. **`noaa-sea-level-rise` and `noaa-slosh-storm-surge` → `national`.** Their own blocks say `national (coastal states and territories only)` and `national (Gulf and Atlantic coasts, Hawaii, southern California, Puerto Rico, USVI, Guam, American Samoa)`. The parenthetical is a human's qualifier and is dropped, so both claim the National chip while being no use whatever for an inland county. **Suggest an explicit state list on each** if National is to mean "useful anywhere".
4. **`landholders` → no coverage.** Correct today and the most valuable gap in the library: 20 large private landowners with acreage, and the column that would place them does not exist yet. A `library geocode` pass would turn this into the most useful state facet we have.
5. **`individuals` → no coverage.** Correct, and should stay that way — a directory of named people has no ground, and it is marked `sensitive`.

#### Deliberately left out

- **Point-in-polygon for lat/lng tables.** Rule 3 degrades to `local` with no states claimed, which the ticket sanctions. State bounding boxes were the cheap alternative and they are not sound: DC's box sits inside Maryland's and Virginia's, so a Bethesda garden would be filed under DC. **Inventing a state is worse than declining to name one**, and `dc-community-gardens` is the only held table it would have placed — a manifest line fixes that for less than a geometry service costs.
- **A state-COLUMN rule.** `memphis-green-resources` has `state` and `organizations` has `HQ State`, and both already have GEOIDs, so the rule would be dead code on this tree. Worth adding the day a table arrives with a state column and no GEOID.
- **Coverage on the P6-8a filing form** (`OrganizationShapeFields.vue`). A manifest `coverage:` is honoured, but there is no admin input for it — the five pins above are manifest edits. One for its own ticket, alongside a `coverage` field on `parseVocabularyFields`.
- **A Coverage chip on `/search`.** `FACET_READERS` is single-valued by construction (P6-21 and P6-22 both say so) and would need the same generalisation as `browse.ts`; the ticket names `/datasets` and MCP, and `searchCatalog` already answers `coverage=` for anything that asks.
- **Coverage for docs and notes, and drawing it on the map** — the ticket's own out-of-scope list.

#### Gates

`npx vitest run` **1,836 / 95 files** (was 1,804; +32 across browse 32, libraryCatalog 100, kb 22, DatasetsView 48, config/taxonomy 25). `cd server && npm test` **2,098 passed / 14 skipped** (was 2,044; +54 — coverage.test.ts 26 new, retag 36, libraryCatalog 70, routes/libraryCatalog 53, mcp 60, taxonomy 18). `npm run type-check` clean. `npm run build` green, bundle-leak check passed (56 files, 10 canaries); entry chunk **511.74 kB raw / 170.60 kB gz**, up 3.10 kB / 1.08 kB — the canonical state table is public-bundle code because the map's ranking panel and county modal read it, minus the duplicate it deleted from `useMapState`.

---

## P6-20 [BUG] `/search` cannot find a map layer, but ⌘K can

**Type:** Bug · **Priority:** P0 · **Size:** S · **Dependencies:** P6-3 (shipped), P6-6 (shipped)

### Bug
**Spec** §D.13: "One page, one box, results across every resource kind, grouped by kind in the held-first order (datasets · pages · analyses · docs · notes · **layers** · sources)." The page's own subtitle promises the same.

**Expected:** searching "median home" on `/search` finds the Median Home Value map layer.
**Actual:** zero catalog results, plus ten unrelated "Inside documents" snippets. The quick search finds it; the thorough one does not.

**Repro:** ⌘K → `median home` → the palette lists **Median Home Value · layer · Housing** → press Enter (the spec'd escalation to the full page) → `/search?q=median+home` → nothing. Same for `epa`: 17 sources, and no "EPA Contamination Sites" layer.

### Cause
`src/lib/search.ts:287-290` — `searchEverything` builds results from `fetchCatalog()` alone and never consults `publicLayers()`, which `DatasetsView.vue` uses to put the 15 public map layers into `/datasets`. P6-6's DONE note states the gap outright ("Public registry layers are not pulled into `/search`… the Layers group is ready for the rows P6-3 adds"). P6-3 shipped; the wiring never followed.

### Design
Feed `publicLayers()` into `searchEverything` the way `DatasetsView` already does, into the existing Layers group. The registry ships in the bundle, so this costs no request. Honour the existing chips where they apply (topic, type) and leave the layer rows out of facets that cannot describe them rather than inventing values.

### Acceptance criteria
- **Given** `?q=median home`, **then** the Layers group contains Median Home Value, in the spec'd held-first group order.
- **Given** a term matching both a layer and a document, **then** both groups render and the counts match their lists.
- **Given** ⌘K with a term, **when** Enter escalates to `/search`, **then** every row the palette offered is present on the page.
- **Given** a logged-out visitor, **then** nothing internal leaks — the public registry is public, the catalog is not.

### Tests
A layer-matching query reaching the Layers group; the ⌘K→`/search` parity case (the one that caught it); facet counts with layers present; no new network request.


### ✅ DONE (2026-10-03)
- `entryForLayer` in `src/lib/search.ts` shapes a registry layer as a `CatalogEntry` with `kind: 'layer'`, which is what makes the rest free: `groupFor` already files `layer` under `Layers`, `entryHref` already sends it to `/layers/:id` (P5-45 anticipated exactly this), and `FACET_READERS` counts its chips with the same helpers every other row uses — so a layer cannot drift into disagreeing with the chip counting it.
- Matched with `matchesQuery` (the catalog's own word rule, client-side) and filtered through `passesFilters`, which reads each filter with those same `FACET_READERS` — so `purpose`, which no layer has, excludes layers with no special case.
- The registry ships in the bundle: **no new request.** `matched` deliberately stays a count of catalog rows, because it is what decides whether the documents are worth searching and three map layers are no reason to stop looking inside documents; the empty state reads `groups`, which now fills.
- Two existing chip tests were **isolated from the live registry** rather than re-baselined: they mock the catalog but used the real `publicLayers()`, so merging layers changed their arithmetic. They now ask a word no layer can answer, with a comment saying why — a new public layer must not be able to break facet maths that is about the fixture.
- Tests: search 7 added (23 total) — the audit's ⌘K-vs-page repro, the `/layers/` href, held-first order preserved, chip counts matching the rows, the purpose filter dropping layers, an explicit `kind=layer` filter, and a word no layer carries.

---

## P6-21 [BUG] Tag chips on every entry page dead-end at an empty search

**Type:** Bug · **Priority:** P0 · **Size:** S · **Dependencies:** P6-5 (the redirects)

### Bug
**Expected:** clicking a tag on an entry shows the other entries with that tag.
**Actual:** a blank `/search` page — empty box, no results, no indication that a filter was silently dropped. Every entry page carries 3–6 of these chips.

**Repro:** `/library/epa-echo-facilities` → click `environmental-risk` → `/search?tag=environmental-risk` → nothing.

### Cause
`src/views/LibraryEntryView.vue:813` still links tags at the retired `/library?tag=<t>`. `src/lib/retiredRoutes.ts:93` forwards the whole query to `/search`, and `src/lib/search.ts:111` (`FILTER_KEYS = ['kind','organization','topic','type','purpose']`) drops `tag` without a word. Spec §A.5's "else `/search?q=…` with the same filters" assumed `tag` was one of them; it never was.

### Design
Make `tag` a first-class search filter — add it to `FILTER_KEYS`, count it as a facet, and render it as a chip row like the others. Retarget the entry-page chips at `/search?tag=` directly rather than through the retired route. If tags are deliberately not a browse vocabulary, the alternative is to stop rendering them as links — but a chip that looks clickable and leads nowhere is the one option that must not survive.

### Acceptance criteria
- **Given** any tag chip on any entry, **when** clicked, **then** the result lists the entries carrying that tag.
- **Given** a tag matching nothing, **then** the empty state names the tag rather than rendering a blank page.
- **Given** a URL carrying an unknown filter key, **then** it is reported in the empty state, not dropped silently.

### Tests
`tag` surviving the redirect and the filter; the entry-chip href; the unknown-key case.


### ✅ DONE (2026-10-03)
- **Not the design this ticket first proposed, and here is why.** Making `tag` a real filter key means a facet, and the facet model is one value per row (`FACET_READERS` returns a single `{id,label}`) while tags are a list — and the server's `searchCatalog` has no `tag` filter at all, so it would need a server change too. That is an M, not the S this is, and it would have left the dead link in place meanwhile.
- What shipped instead: the chips point at `/search?q=<tag>`, which the catalog genuinely answers. `q` already matches tags (P5-38 searches title, slug, tags, category and description) **and** folds the spelling (P5-63 explicitly added a `normalizeTags(...).includes(folded)` fallback so "environmental-risk" finds what carries it). The machinery for this existed; the chips were pointing away from it.
- `retiredRoutes` now maps a retired `/library?tag=…` link to `q` as well, so links already shared keep working, and `tag` is stripped rather than forwarded into a key nothing reads. An explicit `q` wins over the tag — the person said what they were looking for.
- **The trade-off, stated:** this is a word search, not an exact tag filter, so a tag that is also a common word brings company. A true `tag=` filter wants a server-side filter and multi-value facets; worth doing if tags become a browse vocabulary, and not before.
- Tests: retiredRoutes 3 added (22 total) — the tag becoming the query, the key never carrying through, an explicit `q` winning; LibraryEntryView 1 added pinning the chip's href away from `tag=`.

---

## P6-22 [BUG] A filter chip that matches nothing erases itself

**Type:** Bug · **Priority:** P0 · **Size:** XS · **Dependencies:** P6-3

### Bug
**Repro:** `/datasets` → click **US EPA** → type `homestead`. The page says *"Nothing matches these filters."* The publisher row now reads **All publishers · Black Land Ownership (BLO) 3** — the EPA chip you just pressed is **gone**, so nothing says it is still on and nothing lets you un-pick it. The only exit is "Clear filters", which also wipes your query. Reachable through a spec'd redirect too: `/library?purpose=ideas` → `/docs?purpose=ideas` shows Outreach/Research/Strategy and no Ideas chip.

**Correction (while implementing, 2026-10-03):** this ticket first called the surviving "BLO 3" chip a second defect — a count contradicting "nothing matches". It is not. Counting each row off the *other* filters is the documented design, and that 3 is the way out: "EPA 0, BLO 3" reads as *nothing here, three next door*. It only reads that way once the 0 is visible, which is the whole of this fix. The vanishing chip is the bug; the sibling counts are the escape route and must stay.

### Cause
The codebase already states the correct rule, in `src/lib/search.ts:283-286`: *"The chips are counted off everything the QUERY matched, not off what the chips have already narrowed it to — otherwise picking a topic would hide every other topic and the only way back would be Clear."* `SearchView.vue:125` implements it by re-inserting the active facet at count 0. `DatasetsView.vue:253-255` and `DocsView.vue:219-221` cross-filter facets and never re-insert — so the two browsers violate a rule their sibling page documents.

### Design
Port the `SearchView.vue:125` behaviour into the shared `FilterChips.vue` so all three surfaces obey one rule: an active value is always rendered, at its true count, even when that count is 0. Ships naturally with P6-18, which is also editing this component.

### Acceptance criteria
- **Given** an active filter whose combination matches nothing, **then** its chip is still visible, marked active, showing 0, and clicking it clears just that filter.
- **Given** the empty state, **then** no chip advertises a non-zero count that the list contradicts.
- **Given** `/docs?purpose=ideas` with no such doc, **then** the Ideas chip renders at 0 rather than vanishing.

### Tests
The zero-count active chip on both browsers; clearing one filter without losing the query; the redirect case.


### ✅ DONE (2026-10-03)
- The rule now lives in the kit, not in one view: `facetsFor(all, filtered, keyOf, active)` in `src/lib/browse.ts` counts off the rows the OTHER filters left (unchanged, deliberate) and **always contains the chosen value**, re-inserted at a true count of 0 with its real label read from the unfiltered set. A value the whole set has never seen (a stale URL) falls back to the value itself.
- `DatasetsView` (organization, topic, type) and `DocsView` (purpose, topic, kind) both use it; the readiness row keeps the active choice when its count drops to 0.
- Tests: browse 6 added (26 total) covering the zero-count re-insert, the `NONE_VALUE` ↔ empty-id mapping and the unknown-value fallback; DatasetsView 2 added for the audit's exact repro.
- **The second half of this ticket was wrong and is withdrawn** (see the Correction above): the sibling counts are the way out of the empty state, not a contradiction, and a test asserting every chip must read 0 was replaced by its opposite — at least one chip must offer somewhere to go.

---

## P6-23 [BUG] Attention counts include archived rows the browsers hide

**Type:** Bug · **Priority:** P1 · **Size:** XS (+ S if archived entries should regain a way in) · **Dependencies:** P6-5

### Bug
**Repro:** `/kb` → **"14 Entries with no topic"** → `/docs?attention=uncategorised` → **12 rows**. `/datasets?attention=uncategorised` → *"Nothing matches these filters."*

P6-5's DONE note claims "a count and the list it opens cannot drift" because both share `ATTENTION_RULES`. They share the predicate but not the row set: `KnowledgeBaseView.vue:68` fetches `fetchCatalog({ archived: true })` and `:111` runs `attentionItems` over all 86 rows **including the 3 archived**, while `DatasetsView.vue:206` and `DocsView.vue:183` both filter `entry.status !== 'archived'`. The two missing rows are the archived documents `reference-manual-superseded` and `fact-manual-section-6-extract`. The other six attention rows do not drift — "5 Needs review" resolves to exactly 5.

### Design
- Exclude archived rows from `attentionItems` so the landing counts what the browsers will show. One predicate, one row set.
- **Second, larger question for Nick:** archived entries are now reachable from **no** browse surface at all — both browsers exclude them and `/search` does not request them — yet they are still counted on the landing and still hold files. Either they get a way back in (an `archived` chip on the browsers, off by default) or the landing should stop counting them. Decide before fixing only the count.

### Acceptance criteria
- **Given** any attention row, **when** opened, **then** the list length equals the count exactly, on both browsers.
- **Given** an archived entry matching an attention rule, **then** it is counted on the landing only if some surface can show it.

### Tests
Count-equals-list across all seven attention rows with an archived fixture in the set.


### ✅ DONE (2026-10-03) — the count half
- `attentionItems` (`src/lib/kb.ts`) drops `status === 'archived'` before counting. The fix belongs there, not in the view: the landing deliberately asks the catalog for archived rows (its tiles want them), so the exclusion has to live where the attention vocabulary lives. "14 Entries with no topic" now opens a list of 14.
- A row whose only matches are archived disappears from the panel rather than offering an empty list.
- Tests: kb 2 added — the mixed case, and the all-archived case.
- **Still open, deliberately (for Nick):** an archived entry is now reachable from no browse surface at all — both browsers exclude them, `/search` does not request them — yet they still hold files. Either the browsers gain an `archived` chip (off by default) or the landing should stop holding them entirely. A count fix is not the place to settle that, so it is noted in the code beside the filter.

---

## P6-24 [FEATURE] Entry pages speak the browsers' vocabulary

**Type:** Feature · **Priority:** P1 · **Size:** S · **Dependencies:** P6-1, P6-2

### Why
**Spec** §B.7 and §B.9 make organization and shape first-class curated vocabularies with canonical labels, and §B.6 shows them on every browser row. The entry page — where you land from that row — shows neither.

**Repro:** `/datasets` groups **Organizations** under **"Black Land Ownership (BLO)"** with the type chip **"Sites and points"**. Open `/library/organizations`: no "Black Land Ownership (BLO)" anywhere on the page, no type chip, and the publisher line reads **"Publisher: final folder for Homesteading plan / (Nick, 2026-09)"** — an internal folder note where the browser showed a publisher.

`LibraryEntryView.vue` imports `organizationLabel` (`:60`) and `shapeLabel` (`:61`) and uses them **only** inside the unaccepted machine-suggestion panel (`:1152`, `:1156`). A published entry prints raw prose at `:961` (`Publisher: {{ sourceNote }}`).

### Design
An entry shows the same canonical organization and shape its browser row showed, from the same helpers. The raw `source` prose stays available as provenance detail — it is real information, it is just not the publisher's name. Pairs naturally with P6-11, which adds a Provenance section to this page.

### Acceptance criteria
- **Given** an entry with an organization, **then** the page shows the canonical label the browser grouped it under.
- **Given** a dataset or source, **then** the page shows its shape with the same label as the browser's type chip.
- **Given** an entry whose organization is unknown text, **then** the page shows that text, as the browser does, and does not claim a canonical publisher.

### Tests
Label parity between a browser row and its entry page (the assertion that would have caught this); the unknown-organization case; the prose line surviving as provenance.

### ✅ DONE (2026-10-03)
- **A client-only fix: both answers were already on the row.** `GET /api/library/catalog/organizations` returns `organization: 'blo'`, `organizationLabel: 'Black Land Ownership (BLO)'`, `shape: 'points'`, `shapeLabel: 'Sites and points'` — worked out at reindex and carried on every row since P6-1/P6-2. The entry page simply never read them. Nothing on the server changed.
- **From the row's own helpers, not the config's.** `LibraryEntryView` now computes `publisher` and `shapeText` through `organizationLabelOf` / `shapeLabelOf` (`lib/libraryCatalog`) — the two functions `DatasetsView` reads — rather than through `organizationLabel` / `shapeLabel` (`config/organizations`, `config/taxonomy`), which take a bare id and were the page's only use of the vocabulary, inside the unaccepted suggestion panel. That panel still uses them, because a suggestion *is* a bare id; everything else on the page now goes the row's way. The distinction is load-bearing for the third acceptance criterion: `organizationLabelOf` prefers the row's own `organizationLabel`, which for an unknown publisher is the words somebody wrote.
- **In the meta row, in the row's reading order** — type chip, topic, purpose, publisher, then tags — so landing from `/datasets` lands on the same two words in the same order. The chip reuses the page's own `.badge` geometry with the row's lighter ground (`.badge.shape`), and the publisher takes `.row-publisher`'s weight and colour, so the two surfaces look like one vocabulary without a second set of chip styles.
- **The prose line keeps its information and loses its claim.** `Publisher: {{ sourceNote }}` → `Where it came from: {{ sourceNote }}` (`data-testid="entry-provenance"`). P5-65 deliberately named that line "Publisher" — right for a source's `source.provider`, wrong for the founding content load's free `meta.source` prose, which is a filing note ("final folder for Homesteading plan / (Nick, 2026-09)"). The genuine publisher line inside the source block (`source-publisher`, P5-65) is untouched: `source.provider` IS a publisher's name and carries the programme the canonical label does not, so `/library/epa-npl` now reads **US EPA** in the meta row and **Publisher US EPA · Superfund / CERCLIS** in the block. P6-11's Provenance section is where this line belongs eventually.
- **Found while verifying, same defect one block lower, fixed here:** `extraMeta`'s "everything nobody has given a home" list was printing `organization blo` and `shape points` as raw ids, because `organization` and `shape` were missing from its `shown` set. They are first-class UI now, so they are shown words-first and not twice.
- **Verified live at 1440 px and 390 px.** `/library/organizations` reads `Sites and points · Network · Black Land Ownership (BLO)` with `Where it came from: final folder for Homesteading plan / (Nick, 2026-09)` below, and the string `Publisher: final folder` appears nowhere on the page. Screenshots `p624-organizations-before.png`, `p624-organizations-after-1440.png`, `p624-organizations-after-390.png`.
- Tests: **LibraryEntryView 92** (was 73). The parity assertion mounts `DatasetsView` for the same entry and compares the row's rendered words with the page's — a shared helper asserted twice could be wrong in both places at once, which is exactly how this shipped. Plus the unknown publisher (`Memphis Horticulture Society`, parity again), the prose surviving as provenance and no longer saying "Publisher", an entry with neither rendering no blank chip, the raw ids gone from the leftover-meta block, and the source's own provider line proved untouched. One existing assertion changed on purpose: P5-65's `'Publisher: DC Open Data, 2024'` is now `'Where it came from: DC Open Data, 2024'`.

---

## P6-25 [BUG] USDA is four publisher groups instead of one

**Type:** Bug · **Priority:** P1 · **Size:** S · **Dependencies:** P6-1

### Bug
**Spec** §B.7: "USDA (with sub-units NASS, NRCS, Forest Service, FPAC **as aliases of one parent**…)", and Example 1 gives the shape concretely: `"US EPA · 13", "USDA · 6", "USGS · 3"` — one USDA group.

**Actual:** `/datasets` grouped by Organization shows four: USDA · Forest Service 2, USDA · NASS 2, USDA · NRCS 2, USDA · Farm Production and Conservation 1. Because groups sort by count, the second-largest publisher is fragmented into four shards that each sink down the order.

`src/config/organizations.ts:261` exports `organizationParent`, and it is called from **nowhere** outside its own module and tests — the `parent` field was modelled in P6-1 and never used for grouping.

### Design
Group on `organizationParent(id) ?? id`, keeping the sub-unit label on the row so a dataset still reads as "USDA · NASS". The filter chip may stay at sub-unit granularity or roll up — decide once and make the group count and the chip count agree, since P6-22 is already fixing exactly that class of disagreement.

### Acceptance criteria
- **Given** grouping by Organization, **then** one USDA group holds all four sub-units with a count equal to their sum.
- **Given** a row inside it, **then** the row still names its sub-unit.
- **Given** the publisher chips, **then** chip counts and group counts describe the same rows.

### Tests
The parent roll-up with a multi-sub-unit fixture; the row label; chip/group count agreement.


### ✅ DONE (2026-10-03)
- `publisherOf(row)` in `DatasetsView` files a sub-unit under `organizationParent(id)`, giving one `USDA` heading whose count is the sum. `passes()` compares the same rolled-up value, so the chip, the group and the filter share one vocabulary and cannot disagree.
- **Judgment call (Nick asked for calls, not questions):** the publisher **chips roll up too**, rather than staying at sub-unit granularity. One vocabulary means a chip count and a group count can never drift — the class of bug P6-22 just fixed. The cost is that no chip filters to NASS alone; the row still *names* its sub-unit and the sub-unit label stays in the row's search text, so typing "NASS" still finds it. Reversible if sub-unit chips turn out to be wanted.
- Unknown free-text publishers have no parent and are left exactly as written.
- Tests: DatasetsView 4 added — the single heading with a summed count, the sub-unit label surviving on the row, one chip filtering to all four, and a parentless publisher untouched.

---

## P6-26 [FEATURE] A reopened place report says when it was made

**Type:** Feature · **Priority:** P2 · **Size:** XS · **Dependencies:** P6-15 (same header)

### Why
**Spec** §C.12: recent analyses are listed "with who and **when**… A place report reopened from here is served from its cache." `src/lib/placeReport.ts:117` types `cached: boolean` on the response and nothing renders it; `PlaceView.vue:388-392` shows label · county · radius · tally and no date, though `report.generatedAt` exists and the "Add to page" markdown already prints it (`placeReport.ts:454`).

So `/analysis` tells you a report is "3d ago", you open it, and the page cannot tell you whether the numbers are three days old or seven. Reports also silently re-run past the 7-day TTL (`REPORT_TTL_DAYS = 7`, `placeReport.ts:65`) behind the same "Checking 40 sources…" spinner, so a researcher cannot distinguish a cache read from a fresh 40-agency run.

### Design
Render `generatedAt` in the report header, and say plainly whether this is the cached copy or a fresh run. Pairs with P6-16, which makes a fresh run legible while it happens.

### Acceptance criteria
- **Given** a report served from cache, **then** the header gives its date and says it is cached.
- **Given** a fresh run, **then** the header says so and the date is now.
- **Given** a report past the TTL, **then** the re-run is visible as a re-run rather than indistinguishable from a cache read.

### Tests
Both header states; the TTL boundary.

### ✅ DONE (2026-10-03)
- **`cached` was typed on the response, carried by the route, and rendered nowhere; it is now the header's second half.** `freshnessPhrase(report)` in the result head: `Checked just now` for a fresh run, `Cached copy · checked 4d ago on 9/29/2026` for a reopened one. The cached form gets both the age (what you scan) and the date (what you cite), and a `.cached` class so it reads as a state rather than as more sub-line text.
- **The relative time is `relativeTime` from `src/lib/kb.ts`** — literally the function `/analysis` uses for its "3d ago" column. That was the point of the ticket: the list says 3d ago, you open the report, and it now says the same thing in the same words instead of nothing.
- **The TTL case is answered by P6-16 rather than by more wording.** A report past `REPORT_TTL_DAYS` is re-run by the server, which answers `cached: false` with today's timestamp, so the header reads `Checked just now`; and the re-run is now visibly a run, because the progress stream names each of the forty sources as it goes. Before, both a cache read and a fresh 40-agency run sat behind the same "Checking 40 sources…" spinner — that is the half of this ticket that P6-16 fixed, and the test asserts the boundary from both sides.
- The header line is now `county, state · N miles · <freshness>`; the tally that used to run on at the end of it moved into P6-17's verdict card, where it is the headline rather than a fourth clause.
- **Rejected:** a bare `generatedAt` date with no cache/fresh word (the ticket asks for both, and a date alone cannot tell a cache read from a re-run); and `toLocaleDateString()` alone with no relative time, which would have said something different from `/analysis` about the same report.
- Tests: placeReport lib — the cached phrase (word, age and date), the fresh phrase (and that it never says "Cached"), the TTL boundary from both sides, and an unreadable timestamp inventing nothing. PlaceView — both header states rendered, including the `.cached` class and that the header still says where and how far.

---

## P6-27 [BUG] Nine of eleven recent analyses are attributed to "someone"

**Type:** Bug · **Priority:** P2 · **Size:** XS client / S if the recovery is broken · **Dependencies:** P6-4

### Bug
`AnalysisView.vue:137` renders `{{ analysis.by || 'someone' }}`, and nine of eleven rows show `someone · Sep 15`. P6-4's DONE note says "who" is recovered from `library_audit` (`place.report`) at reindex — so either the recovery is not running, or it is not matching the rows it should.

**Investigate before fixing.** If the recovery is broken, the client fallback is not the bug. If "who" is genuinely unrecoverable for pre-ticket rows, drop the word rather than attributing work to a fictional person.

### Acceptance criteria
- **Given** a report whose audit row names an actor, **then** the list names them.
- **Given** a report with no recoverable actor, **then** the row shows the date alone.

### Tests
Recovery against an audit fixture; the unattributed row rendering no placeholder name.

### ✅ DONE (2026-10-03)
- **Investigated first, and the ticket's instinct was right: the client fallback was not the bug.** The recovery is implemented (`services/placeReportIndex.ts`, `actorsByPlaceKey`), it is tested, it runs on every reindex (`placeReport.ts` registers the hook; `index.ts` reindexes at every dev boot), and **its join key is correct** — `library_audit.target` is the place key, which is exactly what `routes/libraryPlace.ts` writes. Nothing about the recovery is broken.
- **The bug is that the rebuild was lossy.** `walkAndWrite` took `by: actors.get(placeKey) ?? ''` and wrote the whole index object over the top. "Who" is the one field that is **not** in the stored report — it exists only on the index entry the live write path already stored — so a rebuild that could not find a matching audit row did not leave the name alone, it **erased** it. Every reindex de-attributed every report the audit log could not account for.
- **Which, in dev, is all of them, every time.** The dev store is pg-mem (`LIBRARY_DEV_PGMEM=1`, "all library data is lost on restart"), and the restart that empties `library_audit` is the same restart that triggers the rebuild. `tsx watch` restarts on every file save. The live index on disk had **11 entries, 0 with a name** — not nine of eleven; the ticket's snapshot was taken before a later rebuild. `GET /api/library/activity` returns zero audit rows of any action.
- **The fix is three lines in `walkAndWrite`:** read the existing index once, and resolve `by` as `actors.get(placeKey) || storedBy.get(placeKey) || ''` — the audit log first (it knows the newest run), then what we already had, then a blank. Everything else on the entry still comes from the report file, so a relabelled or re-run report still updates. The same read now serves the empty-library guard below it, so the rebuild makes one fewer bucket request than before.
- **It fixes two other paths for free.** A report run through MCP (`mcpPlaceTools.ts`) writes `action: 'mcp.place_report'` with the raw GEOID or address as its target, and one run through the chat (`chatLoop.ts`) writes a `NULL` target — neither can ever be joined on. Their authorship was recorded correctly by the live write and destroyed by the first reindex; now it survives. **Found, not fixed:** those two audit rows are still unjoinable, which only matters for a report whose index entry is gone. Not worth widening this ticket.
- **Client: the word is dropped, not replaced.** `{{ analysis.by || 'someone' }}` became `whoAndWhen(analysis)` — `[by, when].filter(Boolean).join(' · ')` — so an unattributed row reads `Sep 15` and a known one reads `dev-admin · 4d ago`. With neither, the line does not render at all rather than leaving a stray separator. For the eleven rows already de-attributed the name is gone for good (the stored reports carry no actor), and a date with no name reads as a date, while "someone" reads as a fact about a person.
- **Both halves checked:** saved views keep their author in the view document (`savedBy`, re-derived at reindex) and never depended on the audit log — but this library has **no saved views at all**, so all eleven rows were place reports and the unattributed half was the whole list.
- **Not touched:** `server/src/services/placeReport.ts` and `routes/libraryPlace.ts` — read for the trail, owned by another agent this session. Neither needs a change.
- Tests: **placeReportIndex 12** (was 10) — a rebuild with an empty audit table keeps the name the live write stored, twice over (the dev loop ran it on every save), while the label and the tallies still come from the report file; and the audit log still correcting a stored name, with a blank staying blank. **AnalysisView 15** (was 12) — the date alone with "someone" nowhere on the page, the named row reading `name · when`, and the line absent when neither is known.

---

## P6-28 [CHORE] Phone and chrome polish from the UX audit

**Type:** Chore · **Priority:** P2 · **Size:** XS · **Dependencies:** none

Three small, independent fixes found by the 2026-10-03 audit:

- **The place report's action toolbar clips off-screen on a phone.** At 390 px the `.toolbar strip` is 625 px of content in a 366 px box with no scrollbar or chevron: **"Download CSV" and "Show on map" are invisible**, with nothing to suggest they exist (`PlaceView.vue`, result toolbar). Screenshot `uxaudit-11-place-390.png`.
- **The resource tabs jump above or below the page title depending on the page.** `KbNav` renders **above** the `<h1>` in `DatasetsView:343`, `DocsView:295`, `AnalysisView:101`, `SearchView:137`, `NewView:37`, `LayerAboutView:79`, `ChatView:89` — and **below** it in `KnowledgeBaseView:176`, `PlaceView:311`, `CompareView:350`. `/analysis` → "Check a place" makes the strip visibly jump. Pick one and apply it everywhere.
- **"Searchable with ⌘K" is shown on phones** (`/kb` hero copy at 390 px, `uxaudit-09-kb-390.png`) — no keyboard, no palette trigger.

Also noted, not ticketed: `/new` advertises 200 MB for "A document" and 100 MB for "Many documents" on the same page. Confirm which is right before changing either.

### ✅ Third bullet DONE (2026-10-04) — the keyboard hints
- Both `.kbd-hint` spans are `display: none` under 640px: "Searchable with ⌘K" on the hero and "Press ? any time" at the foot. The ticket named only the first; the second is the same defect in the same stylesheet, so it went with it. There is no keyboard to press and no palette shortcut to reach, so each was an instruction the reader could not follow.
- `display: none` rather than removing the markup — the hint is correct on a laptop, and both still render there (asserted).
- **It replaced a P5-60 rule, deliberately.** That ticket asked the hint to claim no width of its own and kept it `inline` to get that; its test asserted `display: inline`. The concern was width, and a hint that is not rendered claims none — so the test now asserts `display: none` with a comment saying why it changed, rather than a new test contradicting an old one in silence.
- Tests: KnowledgeBaseView 36 (1 rewritten, 2 added).
- **Still open:** the first bullet (place-report toolbar) was closed by the P6-17 work; the **second** — `KbNav` rendering above the `<h1>` in seven views and below it in three — is untouched. It spans ten files, which is why it has not been taken while other agents are in them.

### Tests
One assertion per fix; the `KbNav` placement is worth a cross-file test like the P5-60 phone-guard check, so a tenth view cannot reintroduce the inconsistency.

### ✅ Bullet 1 DONE (2026-10-03) — the place report's toolbar
Done alongside P6-17/P6-16/P6-26, which were in these files already. **The other two bullets are untouched** and still open.

- **Measured first, at 390 px:** the `.toolbar strip` was 625 px of content in a 366 px box — 259 px of overflow, with **"Download CSV" and "Show on map" entirely outside the box**.
- **The decisive finding: the house affordance was already on this element and did not work.** The shared `.strip` in `InternalMobileStyles.vue` carries an unconditional 14 px `mask-image` fade at both edges, and `getComputedStyle` confirms it was applied to this toolbar at 390 px *during the audit that reported the buttons as invisible*. So "add a chevron or a fade" would have been adding a second hint beside a first one that had already failed — and an always-on fade says nothing about whether there is anything to scroll to. A swipe nobody takes hides two actions; two rows hide none.
- **The fix is to stop hiding them.** The toolbar drops the `strip` class and wraps at ≤640 px: `flex-wrap: wrap`, `row-gap: 8px`, `.tool-btn { flex: 0 0 auto }` so no label is squeezed, and a `.kept` status note takes its own full-width row rather than shoving buttons around. **Measured after: `scrollWidth` 366 = `clientWidth` 366, zero overflow, all five actions visible, 96 px over two rows** (was 46 px over one). That is 50 px on a page this same pass cut by 5,830 px.
- `width`/`min-width`/`max-width` are kept exactly as P5-60 left them, so the toolbar still cannot widen the page past its card — P6-30's `.strip` note explains why those three matter, and the test asserts them alongside the wrap.
- Screenshots: `p617-before-390-toolbar.png`, `p617-after-390-toolbar.png`.
- Tests: PlaceView — the toolbar no longer carries `strip`, the phone rule wraps rather than scrolling, the three width promises survive, and all five action labels are present.

---

## P6-29 [FEATURE] `/new`: Link or File, and the files decide single or many

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** P6-8 (which built the three panels), P6-13 (the library strip above them)

### Why
Nick (2026-10-03): "the new/upload screen - remove the 'add something', click between link or file, auto detect between single file or muliple files"

`/new` asks three questions before it will take anything. The page is titled **Add something** — which is the words on the button you just pressed, repeated — and under the lede it stacks three cards: **A link**, **A document**, **Many documents**. Two of those three are the same act with a different count, so the page makes the person classify their own files before it will accept them, and then offers **two separate drop zones** to do it in. Pick the wrong one and you are refused by the wrong rule.

That third question is also where the page starts lying. The audit (2026-10-03) found it advertises **200 MB** per file in "A document" (`UPLOAD_MAX_BYTES`) and **100 MB** per file in "Many documents" (`BULK_MAX_FILE_BYTES`), eight lines apart. Both numbers are true of their own path and neither is true of the page. With one drop zone the contradiction stops being a documentation nit and becomes a visible error.

A person arriving here has exactly one piece of information the page does not: whether the thing in their hand is a URL or a file. That is the only question worth asking. How many files there are is something the browser can count.

### Design
Two questions become one, and the second is answered by the drop itself.

- **No `<h1>`, no lede.** You got here by pressing `New`; the page does not need to introduce itself. `KbNav` stays, and is now the first thing on the page. The lede's one genuinely load-bearing sentence — the single/many difference — moves *into* the drop zone, where the decision is made, rather than sitting above three cards as preamble.
- **A two-way chooser: `Link` · `File`.** House `role="tablist"` pattern (`LibraryEntryView.vue:870`), one click per switch, `aria-selected` on the active one, and **only the chosen pane renders.** Default `Link` — today's first card, and the cheaper of the two to get wrong.
- **The chooser is component state, not a URL key.** It is written nowhere and read nowhere: `/new` is linked bare from `KbNav`, the header and the first-run checklist, and the page holds no other shareable state, so a `?kind=` would be a query parameter only this page ever writes. A `router.replace` per toggle is not free (history churn on a write surface, an invalid-value path to handle, a router dependency `NewView` does not currently have), so by the P6-18 rule — URL only when it costs nothing — it stays a `ref`.
- **One drop zone, on the File side.** It carries one `multiple` input plus a second `webkitdirectory multiple` input, because an OS folder picker is the only thing that sets `webkitRelativePath`, which is what names a collection (`folderNameOf`). That is a choice of *where the files come from*, not of *what happens to them* — the flow is still decided by the count alone.
- **`files.length` routes it.** `1` → `DocumentDropForm`; `2+` → `BulkDropPanel`. Both already expose a single `take(files)` entry point used by both their own `onPick` and `onDrop`, so this is a handoff, not a merge: `defineExpose({ take, clear, count })` on each, and the parent calls the right one and clears the other, so the single form and the bulk pre-flight can never both be on screen for the same pick.
- **The children's own drop zones are deleted, not hidden.** They are now duplicates of the parent's one zone — three zones on one pane is the bug, not the fix — so the zone markup, `onPick`, `onDrop`, `dragOver` and the two hidden inputs move up into `NewView` once. Each child's root gains a `v-if` so a child holding nothing draws nothing; everything below the zone (both forms, the pre-flight, the review queue, the notes) is untouched.
- **The size limit is stated for the action in hand, from the real constants.** Nothing picked: no byte figure at all, because none applies yet — `Any file type, up to 50 at a time. The size limit depends on how many you drop.` One file: `One file, up to 200 MB.` Many: `7 files · up to 100 MB each, 50 at a time.` Derived from `UPLOAD_MAX_BYTES`, `BULK_MAX_FILE_BYTES` and `BULK_MAX_FILES`, so the page cannot drift from the validators. **Neither constant changes** — the page stops claiming both at once for one action, which is the actual defect.
- **The way back to empty is the zone.** It stays on screen above whatever the pick produced, so a second drop re-routes; each child's existing `Cancel` empties it and, with the root `v-if`, the pane returns to just the zone.
- `completeFirstRunStep('add')` keeps firing from all three landings (`dropped`, `uploaded`, `changed`). The id is unchanged — `firstRun.ts` has four surfaces reporting their own ids and `matchFirstRunStep` proves `search`/`map`/`ask` only, so `/new` is the only proof of `add` there is.
- P5-60 guards: the chooser is a `.strip` of `.touch-target` buttons, the zone's own text floors at 14 px under 640 px, and the pane stacks. Verify at 390 px.

### Acceptance criteria
- **Given** `/new`, **then** there is no `<h1>` and no lede, and `KbNav` is the first thing on the page.
- **Given** `/new` on arrival, **then** the Link form renders and no drop zone does.
- **Given** the chooser, **when** `File` is clicked, **then** the drop zone renders and the link form is gone; `Link` brings it back. One click each way.
- **Given** the File pane, **when** one file is dropped or picked, **then** the single-document form renders holding that file and no bulk pre-flight exists.
- **Given** the File pane, **when** more than one file is dropped or picked, **then** the bulk pre-flight renders with that count and no single-document form exists.
- **Given** a pick of many, **when** one file is then picked, **then** the bulk pick is cleared — and the other way round.
- **Given** nothing picked, **then** no byte limit is claimed. **Given** one file, **then** 200 MB and not 100 MB. **Given** many, **then** 100 MB each and not 200 MB. The two figures never appear together.
- **Given** a landing on any of the three paths, **then** `completeFirstRunStep('add')` has been called.
- **Given** a 390 px viewport, **then** both chooser buttons are ≥44 px and the pane does not scroll sideways.

### Out of scope
`UPLOAD_MAX_BYTES` and `BULK_MAX_FILE_BYTES` themselves — the two limits stay as they are until somebody decides which is right (P6-28's open note). The link form, the single form's fields, the bulk review queue and `BulkDropRow` are untouched. The bulk collection checkbox stays where it is.

### Tests
`NewView.spec.ts` rewritten to the new contract — the absent heading, the default pane, the chooser both ways, routing by count in both directions and the cross-clear, the three limit strings, `completeFirstRunStep('add')` from all three paths, the chooser absent from the URL, and the P5-60 classes via `sfcStyles`. Every existing bulk assertion kept (polling start/stop, the greyed unapplied proposal, the running total, Accept, edited Save, Accept all, the refused-row cases) and re-pointed at the shared zone with a multi-file drop. `cypress/e2e/internalAuth.cy.ts` goes through the chooser.


### ✅ DONE (2026-10-03)
- **`NewView.vue` (125 → 357 lines)**: no `<h1>`, no lede. `KbNav`, then a `role="tablist"` chooser — `Link` · `File`, default Link — then the one chosen pane. The chooser is a `ref`, **not a URL key**: `/new` is linked bare from three places and holds nothing else shareable, so `?kind=` would be a query only this page ever writes, and P6-18's rule (the URL only when it costs nothing) said no.
- **One zone, and `files.length` is the whole decision.** `route(files)` sends `1` to `DocumentDropForm.take()` and `2+` to `BulkDropPanel.take()`, and **clears the other child first**, so the single form and the bulk pre-flight can never both stand for one pick. Both children now `defineExpose({ take, clear, count })`; nothing of their internals was merged or duplicated.
- **The children's own zones are gone, not hidden.** With a zone in the parent they were duplicates — three zones on one pane — so `onPick`, `onDrop`, `dragOver`, the three hidden inputs and their CSS were deleted from both (`DocumentDropForm` 229 → 181, `BulkDropPanel` 452 → 384) and exist once, here. Each child's root gained a `v-if`, so a child holding nothing renders nothing and both can sit mounted under the zone without costing a pixel — which is what makes the handoff look like one surface rather than two hidden ones. `clearChoice` was renamed `clear` to match its sibling.
- **A folder picker survives as a second *source*, not a second decision.** An OS folder pick is the only thing that sets `webkitRelativePath`, which `folderNameOf` needs to name a collection. The count still decides what happens to it.
- **The size-limit contradiction is fixed by making the line follow the pick**, and **neither constant moved**. Empty: `Any file type, up to 50 at a time. The size limit depends on how many you drop.` — no byte figure, because neither limit applies yet. One file: `One file, up to 200 MB.` Many: `Up to 100 MB each, 50 at a time.` All three are built from `UPLOAD_MAX_BYTES`, `BULK_MAX_FILE_BYTES` and `BULK_MAX_FILES`, so the page cannot drift from the validators, and a test asserts the two figures are never both on the page. P6-28's open note (which is right, and still open) is which of the two limits *should* win.
- The two lines under the zone are computed from the children's exposed `count`, **not mirrored in the parent** — so a child's own `Cancel` cannot leave the page describing files that are no longer there.
- `completeFirstRunStep('add')` fires from all three landings, with a test each. The id is untouched; `firstRun.ts` was read first and `matchFirstRunStep` proves `search`/`map`/`ask` only, so `/new` remains the only proof `add` has.
- **Verified live at 1440 px and 390 px** (dev server, logged in, no upload completed — `/new` writes to the real bucket). Routing, the cross-clear and all three limit strings behave as specified; zero console errors. At 390 px the chooser is two 179 × 46 px targets and the page's own content measures `scrollWidth` 390 = `clientWidth` 390.
- **Found, not fixed, and not ours:** `KbNav`'s `.strip` overflows the page at 390 px — the nav measures 543 px and drags `scrollWidth` to 562, cutting every page right of it. It reproduces identically on `/search`, which this change does not touch, and `KbNav.vue` was being edited concurrently (icons). Left alone; flagged.
- Tests: **NewView 34** (was 15; the file went 325 → 521 lines). Every P6-8 bulk assertion kept and re-pointed at the shared zone — polling start/stop, the greyed unapplied proposal, the running total, Accept, edited Save, Accept all, all three refused-row cases — plus the new contract: no heading, the default pane, the chooser both ways and out of the URL, routing by count in both directions, the cross-clear, an empty pick ignored, input-pick parity with drop, the three limit strings and the never-both rule, `add` from all three paths, and the P5-60 classes via `sfcStyles`. Client suite **92 files green**; server **2030 passed / 14 skipped**; `type-check` clean; `build` green with the bundle-leak check (55 files, 10 canaries); `test:e2e` **21 passing / 3 skipped across 5 specs**, with `internalAuth.cy.ts`'s live drop now going through the chooser and asserting the one-file limit.
- **A third server test flakes under CPU contention**, alongside the two rate-limiter ones: `mcp.test.ts > read_document` ("twelve landowners") failed on two full-suite runs and passes alone and on a third full run. Worth adding to the known-flaky note.

---

## P6-30 [FEATURE] Icons on the library strip

**Type:** Feature · **Priority:** P2 · **Size:** S · **Dependencies:** P6-13

### Why
Nick (2026-10-03): "add icons next to each of the nav butons for datasets, docs, analysis, saerch, chat, new as the original handdrawn mockup had."

The mockup is `BLO-library-redesign-mockup.jpg` in the project root. It draws a glyph beside every item: a grid for Datasets, a box of wavy lines for Docs, a bracketed bar chart for Analysis, a lens for Search, a bubble for Chat, and a vertical mark on a bar for New. Six words in a row all look alike at a glance; the glyph is what makes a destination findable without reading.

### Design
- `src/components/KbNavIcon.vue` — one component, a `name` prop, six inline SVGs.
  - **Inline SVG, not an icon font or a sprite sheet.** Six 16px glyphs are smaller as markup than any dependency that would draw them, they inherit `color` through `currentColor` so an active tab lights word and glyph together for free, and there is no extra request on a surface the whole knowledge base renders.
  - **Decorative by construction:** `aria-hidden`, `focusable="false"`, no `<title>`. Every item already carries its word; a titled glyph would be announced twice.
- `KbNav` carries the icon name on each section entry, so the markup never maps a label to a glyph. The link becomes an `inline-flex` row; the glyph rests at `opacity: 0.75` and goes full strength on the active and hovered item (those rules live in `KbNav`, which owns `.kb-nav-link`, reaching the icon through `:deep`).
- **Mockup vs. the current nav, deliberately not followed:** the mockup shows `Library · Search · Chat · New` on one row and `Datasets · Docs · Analysis` below — the P6-5 arrangement, which **predates** Nick's 2026-10-03 nav-plane correction (P6-13). The icons are applied to the P6-13 strip (one row, divided) because that instruction is the later one. Flag for Nick: the two-row split is easy to restore if the mockup's layout is what he wants back.

### ✅ DONE (2026-10-03)
- Built as designed. Verified at 1440px and 390px; `KbNav` 19 tests (6 added for the glyphs, 3 for the overflow fix below).
- **It exposed a real layout bug, and the fix is the substance of this ticket.** The audit of `/new` reported that `KbNav` was pushing the page wider than the viewport at 390px. My first measurement contradicted it — on `/datasets` the strip reported `clientWidth` 366 and the page did not overflow. Both were right: `/datasets` has no flex ancestor, `/search` does. On `/search`, `.search-panel` is a flex item with the default `min-width: auto`, so it sized to the strip's **min-content width of 543px** and pushed the document to 566px inside a 390px viewport, cutting every page to its right.
- `.strip`'s existing `min-width: 0` was not enough, and the comment above it said why it should have been: it lets the *strip* shrink, but does nothing about the strip's min-content width being handed up to an ancestor that refuses to go below its own contents. The fix is `width: 0; min-width: 100%` on `.strip` in `InternalMobileStyles.vue` — the strip contributes nothing to any ancestor's intrinsic width, then paints back out to the width it is given.
- **Six items made this reachable where three had fitted**, so it arrived with P6-13 rather than with the icons; the icons only widened it further. Measured after: all nine KbNav routes (`/kb`, `/datasets`, `/docs`, `/analysis`, `/search`, `/chat`, `/new`, `/compare`, `/place`) report `documentElement.scrollWidth` 390 in a 390px viewport, with the strip scrolling sideways and 44px touch targets intact.
- Tests: the glyph set and its order, the decorative attributes, labels unchanged, `currentColor`, the rest/active opacity rules, and three on the strip's width contract — jsdom computes no layout, so the rule is the behaviour there and the browser measurement is recorded above.

---

## P6-31 [BUG] A long URL on an entry page widens the whole phone layout

**Type:** Bug · **Priority:** P2 · **Size:** XS · **Dependencies:** none

### Bug
Found while verifying P6-30's overflow fix, and **unrelated to it** — this page renders no `KbNav` at all.

**Repro:** `/library/epa-echo-facilities` at 390×844. `documentElement.scrollWidth` measures **788px** in a 390px viewport, so the page scrolls sideways and the right half of every line is off screen.

**Cause:** one unbroken URL. `a.link-url`, inside `p.access-notes`, lays out **761px wide** with `white-space: normal`, `overflow-x: visible` and no `overflow-wrap`. A URL has no spaces to break at, so normal wrapping cannot help it. Exactly two elements on the page exceed the viewport and both are this one string.

### Design
`overflow-wrap: anywhere` (with `word-break: break-word` as the older fallback) on the URL display, wherever an entry prints a raw link — `access-notes` is the one found, but the same treatment belongs on any field that can hold a URL a person pasted. Check the source block, the lineage lines and the provenance section (P6-11) at the same time rather than fixing one class.

### Acceptance criteria
- **Given** an entry whose access notes carry a 700px URL, **when** the page renders at 390px, **then** `documentElement.scrollWidth` equals the viewport width and the URL wraps.
- **Given** the same entry at 1440px, **then** nothing about the layout changes.
- **Given** a URL that is still too long for one line, **then** it wraps mid-string rather than overflowing.

### Tests
The wrapping rule on the URL class; a check that no element on an entry fixture exceeds the viewport — jsdom computes no layout, so this is the rule plus the browser measurement recorded above.

### ✅ DONE (2026-10-03)
- **Reproduced exactly, and the audit named the wrong one of the two elements.** Fresh load at 390×844: `scrollWidth` **788**, two elements at **761 px**, `a.link-url` and `p.access-notes`. But `.link-url` already carried `word-break: break-all` and wraps fine — it was a *passenger*. The cause is `p.access-notes`, whose text is a 120-character ArcGIS query string (`?geometry=<lon>,<lat>&geometryType=…&f=json`) with no space in it. It is a flex item inside `.access-row` with the default `min-width: auto`, so its min-content width became the whole string, the flex line grew to 761 px, and the anchor was simply handed a 761 px line and had no reason to break. Proved by injecting `overflow-wrap: anywhere` on `.access-notes` alone: 788 → 390, and removing it: back to 788.
- **(Measure on a fresh load.)** Resizing an already-loaded 1440 px page down to 390 px reflows to 390 and hides the bug; only a load at 390 — the real phone — shows it. Worth knowing for the next one of these.
- **`overflow-wrap: anywhere` is the one that counts.** Unlike `break-word` it also shrinks the intrinsic min-content size, which is what a flex item's automatic minimum is computed from. `word-break: break-word` trails it as the older-engine fallback, per the ticket.
- **Applied per field, not per element found:** `.link-url`, `.link-note`, `.access-notes`, `.source-line` (Terms / Why it matters / Notes), `.source-replication`, `.entry-source`, `.entry-description`, `.tab-lede`, `.preview-text`, `.suggestion-list dd` — every field on the page that prints text somebody can paste a link into. The lineage lines and the extra-meta rows are `.meta-list dd`, which has carried `overflow-wrap: anywhere` since P5-13, so they were already right. **`.access-auth` and `.access-docs` are deliberately left out**: their text is "no key needed" and "docs", four words that cannot overflow anything — putting them in would have made the rule look thorough while saying something untrue about what they hold. `.link-url`'s own `word-break: break-all` was deleted rather than left beside the new rule.
- **Verified live.** `/library/epa-echo-facilities` at 390×844, fresh load: `documentElement.scrollWidth` **390** = `clientWidth`, **zero** elements wider than the viewport, the URL wrapping across three lines and the query string across four. At 1440 px the layout is unchanged (nothing overflowed there before or after). Screenshots `p631-echo-390-before.png`, `p631-echo-390-after.png`.
- Tests: **13** in `LibraryEntryView.spec.ts` — the rule asserted on each of the eleven selectors via `sfcStyles`, a guard that `.link-url` no longer leans on `break-all`, and the sibling check the ticket asked for: a URL-heavy source fixture is mounted and **every element that prints one of the pasted strings in its own text node** must be covered by a listed selector, so adding a field that can hold a URL without wrapping it fails here rather than on a phone.

---

## P6-33 [CHORE] One row for missing metadata, not one per field

**Type:** Chore · **Priority:** P2 · **Size:** S · **Dependencies:** P6-19 (which added the third of them)

### Why
Nick (2026-10-05), on being told the panel has twelve rules: *"11 attention queues? that's a lot."*

Twelve rules, eight of them non-empty on the real library today:

| | row |
|---|---|
| 5 | Needs review |
| 1 | Datasets in cleaning |
| 1 | Dropped links with no file yet |
| 1 | No ingest plan yet |
| 1 | Could not reach it — check the link |
| 3 | Sources whose last fetch failed |
| **12** | **Entries with no topic** |
| **2** | **Datasets with no coverage** |

They fall into three honest groups — **lifecycle** (needs-review, in-cleaning, to-file), **broken** (unreachable, source-failing, unfetched-links, replicate-todo) and **missing metadata** (no topic, no organization, no coverage, no summary, no plan). The first two groups earn their rows: each is a different job. **The third does not.** Opening an entry and filling in what is blank is one job whatever the blank is, and three rows reading 12 / 2 / 0 imply three jobs where there is one.

It is also the group that grows. P6-1 added organization, P6-19 added coverage, and the phase-7 spec proposes `whatItAnswers` (§F.4d) — which would make thirteen rules and four near-identical rows. Collapsing is cheaper to do before that lands than after.

### Design
- One row replacing `uncategorised`, `no-organization`, `no-coverage` and `no-summary`.
  **Its wording depends on P6-34**, which Nick inverted to apply-then-verify on
  2026-10-05: once remediation runs by default the row is mostly **"Unverified
  metadata · N"** rather than "missing", because the gaps fill themselves and what
  is left to do is *read what a model wrote*. Build it as **"Needs a look · N"**
  covering both — an entry nothing could fill and an entry a model filled are the
  same action (open it, decide) — with the per-row line saying which it is. `no-plan` stays out of it: a plan is a decision about what to DO with a source, not a label on it, and it sits with the broken/lifecycle work.
- `N` counts **entries**, not gaps, so an entry missing three fields counts once. The row is a list of entries to open, and the current rows would double-count the same entry.
- The list it opens says **which field each entry is missing**, so the collapse loses nothing: a per-row line reading "no topic · no coverage".
- `ATTENTION_RULES` keeps a predicate per field underneath — the browsers still filter by the same predicates, which is the invariant P6-23 had to repair. The collapse is in the panel and in the list's grouping, not in the vocabulary.
- Deep links to the old keys (`?attention=uncategorised` and friends) keep working, narrowed to that one field; shared links and the first-run checklist must not break.

### Acceptance criteria
- **Given** the real library, **then** the panel shows one missing-metadata row whose count equals the number of distinct entries missing at least one field.
- **Given** that row, **when** opened, **then** every listed entry says which fields it is missing.
- **Given** an old `?attention=no-coverage` link, **then** it still opens exactly the no-coverage entries.
- **Given** an entry missing nothing, **then** it is not listed.

### Tests
The count being distinct entries rather than summed gaps (the case that catches a naive implementation); the per-row field list; each old key still filtering to its own field; the panel count equalling its list, across all rows, which is P6-23's invariant.


### ✅ DONE (2026-10-05)

- **One row, built as "Needs a look", counting entries.** `ATTENTION_RULES` (`src/lib/kb.ts`) gains a `rolledUp` flag on `uncategorised`, `no-organization`, `no-coverage` and `no-summary`, plus P6-34's new `unverified`; one composite rule `needs-a-look` sits where `uncategorised` sat and tests `ROLLED_UP_RULES.some(...)`. `attentionItems` filters the rolled-up rules out of the panel, so **the count is distinct entries by construction** rather than by a de-duplication step somebody could later remove — asking one predicate once is what makes 3 + 1 read as 2.
- **`no-plan` stayed out of it**, as the ticket says: a plan is a decision about what to DO with a source, not a label on it. The panel went **8 rows → 7** on the real library.
- **The vocabulary did not collapse — only the panel did.** `ATTENTION_KEYS` is now 14 keys for 7 rows: every per-field key still answers `matchesAttention` and still rides on `attentionKeysFor`, which is what the browsers filter by, so `?attention=no-coverage` opens exactly the no-coverage entries and `?attention=uncategorised` exactly the no-topic ones. The server's mirror (`attentionMatches`, `services/libraryCatalog.ts`) gains the same two keys over the same `ROLLED_UP_ATTENTION` list.
- **The per-row line.** `needsALookFields(entry)` returns `{ field, label, state: 'missing' | 'unverified', value, note, provenance }` per field, in the field table's order; `needsALookNote` joins the notes into the row line ("no topic · no organization · no coverage"); `needsALookFieldsFor(entry, key)` narrows it exactly as the key does, so the detail a deep link shows can never be wider than the queue it opened. Both browsers print the line on every row — on the plain page too, because what a row says about itself is not a decision.
- **P6-23's invariant, found broken by the collapse and repaired.** `attentionHref` can only send a queue to ONE browser and picks by majority. That was survivable while each metadata row happened to be all-docs or all-datasets; the roll-up mixes them, so **"14 Needs a look" opened a list of 12 and said nothing about the other two** — the same class of bug P6-23 fixed, in a new costume. Rather than split the row back up or shrink the count to what one browser can show, each browser now computes how many of the queue's rows are in the other one and offers the way to it ("2 more are in the datasets browser →", `data-testid="docs-queue-elsewhere"` / `datasets-queue-elsewhere`). **This was already latent for every mixed queue** — `needs-review` can span both kinds too — so the fix is wider than the new row. Found by a live check, not by a test, which is noted as the reason the live check happened.
- **Verified live** on the dev library (83 entries, admin): the panel reads **"14 Needs a look" → `/docs?attention=needs-a-look`**, the list opens 12 rows with the other 2 linked, and the per-field keys underneath read 7 `uncategorised` / 0 `no-organization` / 2 `no-coverage` / 0 `no-summary` / 5 `unverified` — **14 summed, 14 distinct**, because today nothing overlaps. The distinct-vs-summed difference is therefore only visible in a fixture, which is exactly why it has its own test. Screenshot `p634-panel-one-row.png`.
- Tests: **kb.spec 25** (was 23) — the distinct-entry case asserting the summed reading out loud beside it, the per-row field list, every old key still filtering to its own field, the 14-key vocabulary against the 7-row panel, and the P6-23 archived cases re-pointed at the roll-up. Browsers **+9** across `DocsView.spec` (33) and `DatasetsView.spec` (54): the roll-up equalling the union of the per-field queues with nobody listed twice, the field names on the row, the actions off the plain page, and the cross-browser accounting in both directions. `KnowledgeBaseView.spec` re-pointed at the one row.

---

## P6-34 [FEATURE] Remediation runs by default; what a model wrote is flagged for verification

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** P6-33

### Why
Nick (2026-10-05): *"no metadata should be remediateable to some extent based on the mechanisms available per metadata - LLM labelling, etc"* and then, decisively: *"Remediation should run by default, and then per what you said, ask for review. So I guess i'm actually leaning - apply then flag for verification, rather than propose and then accept."*

**This inverts P6-8's propose-then-accept, and it is the right call here** — for a reason the codebase already demonstrates: `coverage` (P6-19) and `shape` (P6-2) are *already* applied by default. They are derived at every reindex and written without anyone being asked, and a hand-written manifest value overrides them. Nobody has ever proposed a shape. So apply-then-verify is not a new posture, it is the posture two of the five fields already have, and the proposal flow is the exception.

The practical argument is stronger still: **absent metadata is invisible metadata.** An entry with no topic cannot be found by the topic facet, cannot be narrowed to by Chat, and does not appear in a working set scoped by subject. A machine-written topic that is 85% right makes eleven of twelve entries findable *and leaves the twelfth visibly wrong where somebody can fix it*. A proposal nobody got round to accepting leaves all twelve invisible.

### The distinction that decides the behaviour: derived vs inferred
Not every mechanism needs verification, and treating them alike would either over-queue or under-protect:

- **Derived** — computed deterministically from data we hold: coverage from a table's GEOIDs, shape from its columns, organization from the provider string through the alias vocabulary. **Apply, and do not queue.** It is re-derived at every reindex, it is as correct as the data, and a human "verifying" it adds nothing a re-run would not. It is already how these work.
- **Inferred** — a model's reading of prose: topic, summary, `whatItAnswers`. **Apply, and queue for verification.** It can be wrong in ways re-running will not fix, so a person has to look once.

So the queue is not "missing metadata" any more. It is **"unverified metadata"** — and P6-33's row changes meaning with it.

### Design
- Remediation runs **on ingest and at reindex**, filling what it can by the per-field mechanism (the table in P6-33's notes).
- Every written value carries its **provenance**: the mechanism (`derived` / `model` / `person`), when, and — for a model reading prose — the evidence sentence (P5-61). This is the load-bearing part: an unverified value must never be indistinguishable from a curated one.
- **Only `model` values enter the verification queue.** A person editing a value marks it `person` and removes it from the queue; a re-derivation never enters it.
- The attention row becomes **"Unverified metadata · N"**, opening the same list, each row showing the field, the value, the mechanism and the evidence, with **Keep** / **Edit** / **Clear** on each. Bulk Keep for a reviewed screenful.
- **Derivation still beats the model** where both could answer: the rows know, a description only claims.
- Surfaces that carry a claim outward — the entry page, MCP/`get_entry`, a story citation — must be able to say a value is unverified. A number quoted in a data story should not silently rest on a model's guess.

### The risk this takes on, stated
Apply-by-default means the library fills with values nobody has read. Twelve is reviewable; twelve hundred is not. The mitigations are the provenance above and the queue — but if the queue grows faster than it drains, the honest fallback is to stop auto-applying the **inferred** half and keep only the derived half, which costs nothing and is always correct. Worth watching the ratio rather than assuming.

**One carve-out to consider (Nick's call):** `summary` and `description` are prose that gets *read as a claim*, not a chip that gets filtered on. A wrong topic is a bad filter; a wrong summary is a false statement in the library's own voice. These may be worth leaving as propose-then-accept even while everything else inverts. Flagged, not decided.

### Acceptance criteria
- **Given** an entry with no coverage whose table has GEOIDs, **then** it is filled at reindex, marked `derived`, and does **not** enter the verification queue.
- **Given** an entry with no topic, **then** a model fills it, marked `model` with its evidence, and it **does** enter the queue.
- **Given** a person editing any value, **then** it is marked `person` and leaves the queue permanently.
- **Given** an unverified value, **then** the entry page and `get_entry` both say so.
- **Given** the model being unavailable, **then** every derived mechanism still runs and the honesty line explains the rest.
- **Given** Clear on a row, **then** the field returns to empty and the entry rejoins the missing list rather than silently keeping the rejected value.

### Out of scope
New vocabularies; `no-plan` (a decision, not a label); changing what any field means.

### Tests
Derived values never queueing and inferred ones always doing; provenance surviving a reindex; a person's edit beating both and leaving the queue; derivation winning where both mechanisms could answer; the model-unavailable path; Clear returning a field to empty rather than to its rejected value.


### ✅ DONE (2026-10-05)

#### The rule, as built

**Derived vs inferred**, not propose vs apply:

| field | mechanism | runs where | queues? |
| --- | --- | --- | --- |
| `coverage` | derived (GEOIDs / source block / stated `coverage:`) | the index walk, unchanged | **no** |
| `shape` | derived (columns / layer block / stated `shape:`) | the index walk, unchanged | **no** |
| `organization` | derived (provider string → alias vocabulary) | the index walk, unchanged | **no** |
| `topic` | **inferred** — a model's reading of the entry's prose | ingest, and after every reindex | **yes** |
| `summary` | left alone (P5-83 "Look again") | — | counted, never written |

- **`src/lib/provenance.ts`** and **`server/src/services/provenance.ts`**: one `FieldRule` per field carrying its `mechanisms` **in order**, which is where *"derivation still beats the model"* lives — a field listing both takes the derived answer, and adding a model fallback later is appending to an array rather than a new rule. `server/src/services/provenance.test.ts` reads the client file and fails when the two tables drift (the contract `taxonomy.generated.json` has, done with a read because the table is five lines and a build step would be the heavier half of the deal).
- **`summary` is in the table with an empty `mechanisms` list.** That is the P5-83 carve-out made explicit rather than implicit: it is counted and shown and remediation cannot write it, because a wrong topic is a bad filter and a wrong summary is a false statement in the library's own voice. **Still Nick's call**, recorded above and not pre-empted.

#### Provenance is READ, not migrated

`meta.provenance.<field>` holds `{ mechanism, at, value, evidence?, via?, verifiedAt?, verifiedBy? }` — P5-61's vocabulary (`inferred` paths plus an `evidence` map, *the claim travels with its evidence*), stored per field rather than recomputed. `mechanismOf` answers from what is already there:

1. a stored record **whose `value` still matches the value on the row** — its mechanism;
2. otherwise `derived`, for a field something derives;
3. otherwise `person` — the only other way a topic or a summary gets onto an entry is that somebody wrote it.

Three consequences worth stating. **Nothing was backfilled**, and `model` is reported only where a record says so — so the verification queue of a library no remediation has touched is empty, which is the honest answer. **Only `model` and `person` records are stored**; a `derived` record would be a cache of a pure function that a push could make stale, and `withProvenance` drops one if asked. And **a record only speaks for the value it wrote** — a record about `land` says nothing about `housing`, so a value edited underneath a record reads as whatever it now is instead of inheriting a stale mechanism.

#### What runs, and where

- **Derived**: untouched. `applyOrganization` and `applyShapeAndCoverage` already ran at every index; this ticket only made them *reportable*, so a run can say what derivation answered.
- **Inferred**: `remediateEntry` / `remediateLibrary` (`services/remediate.ts`) through the existing `annotateEntry` pass. **One model call, two postures** — the topic is applied with its evidence and queued; the rest of the same answer (title, summary, tags, organization, shape) is stored as `meta.suggested` and still waits to be accepted. `annotateEntry` gained an `evidence` map in its prompt and `parseAnnotation` (capped at `EVIDENCE_MAX_CHARS` 300, trimmed rather than dropped, and only for the fields remediation can apply).
- **On ingest**: `runAnnotateJob` (`bulkDrop.ts`) calls `applyInferredTopic` right after `writeAnnotation`, so a dropped document is remediated the moment it is read.
- **After every reindex**: `installRemediationHook()`, registered from the catalog route (not from the CLI's `reindexCatalog`), fire-and-forget like the extraction hook next door. Capped at `LIBRARY_REMEDIATE_MAX` (25) per run, a no-op with no API key, and **switched off entirely by `LIBRARY_REMEDIATE=0`**, which is this ticket's own recorded fallback: keep the derived half, which costs nothing and is always correct. Under a test runner it does nothing at all — `linkFetchQueue.seamMissing`'s rule, and for its reason: every suite that reindexes would otherwise start an Anthropic call.
- **Never overwrites.** `applyInferredValues` fills a field only when it is EMPTY, which is one guard enforcing three rules at once: derivation beats the model, a person's edit beats both, and a re-run is idempotent (a filled field is no longer a gap, so the second pass reads nothing and spends nothing).

#### Keep / Edit / Clear

`POST /api/library/catalog/:slug/verify` — `{ field, action: 'keep' | 'edit' | 'clear', value? }`, audited as `library.verify.<action>`, writing through `patchEntryManifest` so the record lands in the bucket and survives the reindex that follows.

- **Keep** records `verifiedAt` / `verifiedBy` and **leaves `mechanism: 'model'`** — rewriting it to `person` would claim somebody wrote what a model wrote. The words stay the model's; the vouching is theirs, and the field leaves the queue permanently. A Keep on a derived or hand-written value is a **409** ("there is nothing unverified on this field").
- **Edit** empties the field first and then writes, marked `person` and verified. Without the empty-first step, editing a topic that rode on the category would add a tag the category still outranks and the edit would appear to do nothing — **found by a test**, not by reading.
- **Clear** returns the field to empty so the entry rejoins the needs-a-look list. `via` on the record says which manifest key carried it, because **a topic is not a stored field**: it is the entry's `category` when that is a topic, else the first of its tags that is one. With no record to go on, every tag that *is* a topic goes — otherwise the field is "cleared" and still answers, which is the silent-keep this ticket forbids. Clearing a hand-written topic must not take a PURPOSE category with it (`strategy` says what a document is FOR); **also found by a test**.
- **Works on any kind**, unlike the filing PATCH, which is `incoming`/`note`/`source` only. The gaps P6-33 counts are mostly documents and notes, and a queue nobody can clear from the list it opens is P6-23's bug in a different costume.
- `POST /api/library/remediate` (admin, budget-metered) runs the pass now, because the library this lands on already has a dozen gaps no future ingest will revisit.

#### Saying it outward

- **The entry page**: an orange `Topic unverified` badge in the meta row **beside the chips it is about**, not in a panel below the fold — an unverified value must never be indistinguishable from a curated one, and that is the load-bearing half of applying by default. Under it, the same `NeedsALookNote` component the queue list uses, so the two surfaces cannot drift in what they offer. This also closes a dead end the audit found on the way: the entry page never mentioned coverage at all, so `no-coverage` sent people to a page with nothing about the gap and no way to fix it.
- **MCP `get_entry`** returns `provenance` (a record per field) and `unverified` (the short list), with the tool description and `docs/MCP.md` both saying outright: *say so when you quote a value listed in `unverified`*. `meta.provenance` was added to `LIST_ROW_META_KEYS` so a list row can compute the queue without a second request.
- **`NeedsALookNote.vue`** shows field · value · mechanism · evidence with the three buttons, and says `no sentence was recorded` rather than nothing when a model left none. It sits **outside** the row's `RouterLink` — a button inside a link navigates instead of acting — and only on a needs-a-look queue: a plain browse list is not a place to be asked to decide things.

#### The real library, measured

The dev stack reindexed on a restart mid-build, so **remediation ran against the real bucket, unattended, and that is reported rather than tidied away.** Five entries were filled before a later restart cut the run short (~5¢):

| entry | topic | evidence (abridged) |
| --- | --- | --- |
| `philanthropic-giving-black-led` | `economic` | "…received $3.3 billion in charitable contributions in 2022, equal to 0.61% of overall charitable giving" |
| `funding-strategy` | `land` | "…raise $5 million to acquire 5,000 contiguous acres…" |
| `five-year-strategic-plan` | `land` | "…one of the largest Black-owned research, education, conservation… campuses" |
| `field-expedition-one-pager` | `land` | "…planning process for a 5,000-acre campus…" |
| `field-expedition-invitation` | `land` | "This work is part of our 5•5•5 Initiative…" |

All five rode on a **tag** (`via: 'tag'`), because each already carries a purpose category — the rule working as written. The readings are defensible and two are arguable (`funding-strategy` as `land` rather than `economic`), **which is the case for the queue rather than against the feature**. The panel still reads **14**: 7 no-topic + 5 unverified + 2 no-coverage, where before the run it was 12 + 0 + 2. Filling a gap does not clear the row — it changes what the row is *for*, which is the point of "Needs a look" over "missing".

**They are reversible and deliberately left in place** — Clear on each is one press, and they are a live example of the queue with real content. Say the word and they go.

#### The ratio, as asked

**It drains.** The library is 83 entries with 12 inferred gaps; a complete run queues 12 and a person clears them at one press each (Keep, where the reading is right — which on this sample is most of them). The queue is bounded by the gaps, not by the library: a field with a record is no longer a gap, so **the queue is a one-time drain of ~12 plus whatever arrives**, and what arrives is one entry per drop, remediated at the moment somebody is already looking at it. Nothing here grows faster than it drains.

The number to watch is not the queue, it is **the cap against the arrival rate**: 25 per reindex is far above the 12 that exist, so the first real test is a bulk drop of a folder — 50 files is 50 queue rows from one action, and nobody reviews 50 rows. `LIBRARY_REMEDIATE=0` is the switch; **bulk Keep is the missing mitigation** (see below).

#### Deliberately left out

- **Bulk Keep for a reviewed screenful** (the Design names it). Per-row Keep is built and tested; the bulk version is the honest answer to a 50-file drop and should land before one happens. Its own small ticket.
- **A model fallback for `organization` and `coverage`.** The mechanism lists are ordered so adding one is appending `'model'` to an array, and a test pins that a field listing both takes the derived answer — but only `topic` is wired, as the brief asked ("implement `topic` as the inferred exemplar"). P6-32's structured `SourceProposal.coverage` is still read by nothing, which is the natural first consumer.
- **`summary` / `description`.** Unchanged, by instruction. Counted and shown; remediation cannot write it.
- **The public entry chunk grew** 511.74 → **514.93 kB raw**, 170.60 → **171.49 kB gz** (+3.19 / +0.89). `lib/provenance.ts` joined `lib/kb.ts`, which Rollup already hoists into the entry chunk because six lazy route chunks share it. A `kindLabel`-only leaf for ⌘K was tried and **measured no gain** — the hoisting is the cause, not the import — so it was reverted rather than left as unmeasured churn. The fix is a `manualChunks` group for the internal library, which is P6-12's business and not a feature ticket's. Bundle-leak gate green (58 files, 10 canaries).
- **A reindex was never triggered by hand** against the real bucket, so the verification was the panel, the list, and four refusal paths probed live (`400` on an unknown field, `400` on an unknown action, `400` on an empty edit, **`409` on a Keep against a derived coverage** — the "a derived value never enters the queue" criterion, proven against the live server, writing nothing). The dev stack went down with the previous session, which is why there is one screenshot and not three; **restarting it will fire the hook on the remaining 7 gaps**, so that is Nick's press, not mine.

#### Gates

Client **1,869 passing / 97 files** (was 1,836 / 95). Server **2,151 passed / 14 skipped** (was 2,103 / 14) — `mcp.test.ts`'s text-extraction assertion fails only under parallel CPU contention and passes alone, confirmed twice. `type-check` clean; `build` green with the bundle-leak check.

New tests: `server/src/services/provenance.test.ts` **18** (the cross-side table check, derived never queueing, the unremediated library reading as nobody-queued, the stale-record rule, Keep's shape, and every Clear case), `server/src/services/remediate.test.ts` **14** (the applied topic with its evidence and provenance, the summary staying a proposal, the never-overwrite rule from both doors, the tag path, the model-unavailable and nothing-readable and switched-off paths, the cap, the honesty lines), `src/lib/__tests__/provenance.spec.ts` **8**, `src/components/browse/__tests__/NeedsALookNote.spec.ts` **8**. Plus `libraryCatalog.test.ts` **+8** route tests (provenance surviving a real reindex, Keep/Edit/Clear end to end, the refusals, the roll-up as the union of the per-field queues, admins-only on the run), `annotateEntry.test.ts` **+4**, `mcp.test.ts` **+1**, and `libraryBulk.test.ts`'s "applies none of it" rewritten to the new rule — the one assertion this inversion deliberately overturns.


### ✅ FOLLOW-UP (2026-10-05) — the zero run, diagnosed

A reindex after the first commit printed `0 value(s) applied across 7 entries — every one of them is on the verification queue`. Three things were wrong with that, and the third was a real bug in a shared path.

#### 1. The log line asserted a result it had not checked

`installRemediationHook` hardcoded "every one of them is on the verification queue" whatever the run did, so a run that applied **nothing** announced a queue that had not gained a row. **A log line nobody can act on is worse than no log line, because it reads like success.** `remediationSummary(result)` is now its own exported function — the zero case reads `read 7 entries and applied nothing — the verification queue is unchanged; 7 still empty (…)` — and it is unit-tested, including that it never contains "every one of them" when `applied` is 0.

#### 2. `notes` was collected and thrown away

`remediateLibrary` accumulated the per-entry honesty lines and the hook ignored them, so the one diagnostic that could explain a zero never reached anybody. The summary now carries them. Deduplicated notes still lost **which** entry failed, which cost a round of guessing, so the result also carries `declined: { slug, note }[]` — the log line stays short, the route's JSON is precise. That is what turned the next run into a one-shot diagnosis.

#### 3. Two different failures read identically

"The model was unavailable" covered both "the call did not happen" and "the call happened and came back with nothing we can use". They are now distinguished — `the model could not be asked (<code>)` versus `the model answered with nothing we could use` — and the distinction is what located the bug in one run.

#### The actual cause: the output cap, measured

`POST /api/library/remediate` named the entry: `why-five-million-memo → the model could not be asked (model-error)`. Three wrong guesses were checked and discarded first, which is worth recording so nobody re-runs them: the model id and key were fine (probed directly, HTTP 200); the extracted RTF *does* contain a C1 control character (`U+0097`, a cp1252 em-dash mis-decoded) and `U+2028`, and the API accepts both (probed, HTTP 200); and `illustrations` is not fed image bytes, because `png` is not in `HEAD_EXTENSIONS`.

The real answer came from replaying the exact annotate request four times at each cap:

| `max_tokens` | answers with NO text | `stop_reason` | output tokens |
| --- | --- | --- | --- |
| **600** (the default) | **2 of 4** | `max_tokens` on all four | 600 on all four |
| 1,500 | 0 of 4 | `end_turn` on all four | 562 – 1,058 |

**`annotateMaxTokens()` was sized for the answer and not for the thinking block spent out of the same budget.** The Ask model reasons before it answers, so at 600 the call fails every time on a document of this size, in one of two ways: the thinking block eats the whole budget and `textOf` gets nothing (`model-error`), or text starts and is cut mid-JSON so `jsonObjectIn` returns null. That is also why it looked intermittent — 5 entries succeeded, 7 failed, and the difference was input length, because a longer document earns a longer think.

Default **600 → 1,500**, which clears the worst observed answer by ~440 tokens. **An output cap is not a spend** — only tokens actually written are billed — the same reasoning P5-62 used to raise `LIBRARY_PRUNE_MAX_TOKENS` 3,000 → 6,000, and for the same underlying reason: the model does not know about our caps and writes what it likes. `callAssistant` now also **logs** the empty-answer case with the `stop_reason` and the cap; it returned silently before, which is precisely why there was no trace to follow.

**`askMaxTokens()` is 1,000 and shares this exposure.** Left alone deliberately — its own feature, budget line and tests — but it is the next one to measure, and it is noted in the code beside the new default.

#### A queue that counted its own output

Two of the seven candidates were kept **place reports** — `saveReportAsNote` writes `category: research` and the `ask` tag (`ANSWER_NOTE_TAG`), as `saveAnswerAsNote` does for a kept Ask answer. They had no description, no extractable file and nothing a model could read, so they could never be filled, and nobody was ever going to assign a topic to the library's own output. **A queue that counts what it generates never drains** — P5-59's lesson (47 seeded sources behind "no ingest plan yet") found again. `hasNoTopic` and the server's `uncategorised` case now both excuse a NOTE carrying the `ask` tag. Only a note: a document somebody tagged `ask` is still a document somebody has to file, and a note a *person* wrote is untouched.

#### A note is its body

`firstPages` looks for an extractable FILE and a note has only its `meta.json`, so **every note came back "nothing readable to read" however much it said.** `for-william-idea` is several hundred words of real content that no model was ever shown. `remediate.ts` now hands a note's `meta.body` over explicitly rather than widening `firstPages`, which the P5-47 suggestion path shares. It filled on the next run, with its own evidence sentence ("Today, roughly 96% of privately owned rural land is owned by…").

#### Where the live library landed

| | before | after |
| --- | --- | --- |
| **Needs a look** | 14 | **12** |
| unverified (the queue) | 5 | **8** |
| no topic | 7 | **2** |
| no coverage | 2 | 2 |
| kept place reports counted | 2 | **0** |

The two remaining no-topic entries are both correctly unfillable and now say so: `illustrations` is five PNGs with no text layer, and `72030990-…` is a dropped link whose file was never fetched (already counted by `unfetched-links`). Eight entries carry a model-written topic with its evidence sentence; `philanthropic-giving-black-led` reads `economic`, the other seven `land`, every one of them via a tag because each already carries a purpose category.

#### Gates

Client **1,870 / 97 files**. Server **2,158 passed / 14 skipped** — the three failures under full load are the documented contention flakes (`libraryPlace` and `librarySources` per-user-limiter, one `mcp.test.ts` assertion) and all three pass in isolation. `type-check` clean; `build` green with the bundle-leak check; entry chunk **515.01 kB raw / 171.52 kB gz**.

Tests added: `remediate.test.ts` **+6** (the summary's zero case, the singular and empty readings, the two distinguished declines, a note's body read, an empty body declined), `annotateEntry.test.ts` **+2** (a thinking-only answer and a mid-JSON truncation both reading as unavailable rather than as half a filing) plus the cap assertion updated, `kb.spec.ts` **+1** and `libraryCatalog.test.ts` **+1** (the library's own kept output never on the queue, on both sides of the mirror).

---

## P6-35 [BUG] `mcp.test.ts`'s text-extraction case is flaky in isolation, not just under load

**Type:** Bug · **Priority:** P2 · **Size:** S · **Dependencies:** none

### Bug
`src/routes/mcp.test.ts > get_entry / read_page / read_document > reads a text file, and says plainly when a PDF yields no text` fails intermittently.

It has been written off twice in this phase as a CPU-contention flake — the same bucket as `libraryPlace.test.ts` and `librarySources.test.ts`'s per-user-limiter cases, which genuinely are contention-bound because they fire `INTERNAL_RATE_LIMIT_MAX` requests each. **That diagnosis is wrong for this one.** Measured 2026-10-05, the file run **alone**, four times:

```
61 passed · 61 passed · 61 passed · 1 failed | 60 passed
```

Roughly one in four, with nothing else on the machine. A test that fails alone is a different and worse problem than one that fails under load: something in it — or in what it exercises — is nondeterministic.

### Why it matters beyond the noise
It has already cost real time twice: once when a server suite was being judged green, and once when it masked the question of whether a genuine regression had landed. A test that cries wolf at 25% trains everyone to ignore the file it lives in, and that file covers MCP's document reading — which is how Chat reads anything.

### Design
Find the nondeterminism rather than retrying it. Likely candidates, in order of cheapness to check: shared state between cases in the file (the suite builds a real catalog and bucket per run); an unawaited promise whose resolution order decides the assertion; `pdfjs-dist` worker setup racing its first use; a date or id generated inside the assertion window. **Do not add a retry or raise a timeout** — both hide it, and the point is that it fails with the machine idle.

### Acceptance criteria
- **Given** the file run alone twenty times, **then** it passes twenty times.
- **Given** the full server suite under load, **then** this case does not fail (the two per-user-limiter cases may still, and are a separate known issue).
- **Given** the fix, **then** no retry, no raised timeout, and no `it.skip`.

### Tests
The fix is the test. Record the repeat count that proved it.

### ✅ DONE (2026-10-05)

- **Not the test, not `pdfjs-dist`, not shared state: the mirror write was never atomic.** `writeMirrorFile` (`server/src/services/libraryBucket.ts`) did `fs.writeFile(mirrorPath(key), body)` straight onto the destination. That opens the file with `O_TRUNC` and writes the bytes *afterwards*, so for the length of the write the file on disk is **empty, then half-written**. `getFile()` reads the mirror first, so a read landing in that window returns `''`. That is precisely what the assertion saw — `expected '' to contain 'twelve landowners'`, with `textAvailable: true` and `bytes: 51` from the catalog sitting right beside it. A torn read, not a starved one, which is why an idle machine made no difference.
- **How it was caught.** The file was looped until it broke — **4 failures in 7 runs** on an idle box, a better rate than the ticket's 1-in-4 — and the one real diff said `''`, not "timed out", which eliminated contention on sight. `writeMirrorFile` and `getFile` were then instrumented with `process.hrtime.bigint()` plus a stack per call, writing to a **file** rather than the console (vitest prints console output only for failing tests, so the first three instrumented runs looked silent and taught nothing). The trace off a failing run names both ends:
  ```
  5962272814579 bucket-read  library/documents/field-notes/summary.txt fresh=true
  5962275158574 write-start  library/documents/field-notes/summary.txt len=51   ← runSweep → extractFile → getFile(fresh) → writeMirrorFile
  5962280078642 mirror-read  library/documents/field-notes/summary.txt len=0    ← readDocument → getFile, 4.9 ms into the write
  5962291727722 write-end    library/documents/field-notes/summary.txt len=51
  ```
- **The reader and the writer are ordinary neighbours, which is why this is a production bug and not a test artefact.** `ready()` reindexes; reindex runs `syncMirror()` *and* fires the detached post-reindex extraction sweep (`installExtractionHook` → `extractPending`). The sweep re-fetches every extractable file with `fresh: true` — which repairs, i.e. **rewrites**, the mirror copy — and `summary.txt` is extractable (`txt` → the `text` reader). So the sweep rewrites the mirror copy of the very file that MCP's `read_document`, `GET /api/library/text/...`, the ask index and `GET /api/library/file/...` are reading. The download route is the worst of them: `ensureMirrored()` would `stat` a size of **0** and then set `Content-Length: 0` on a file that has bytes.
- **The fix: write the whole file to a temp, then `rename(2)` it into place.** `rename` is atomic within a filesystem, so a reader now sees either the previous complete copy or the new one — never a torn one. Temps live in `dataDir/.mirror-tmp/` named `<pid>-<uuid>`: **outside the `library/` tree on purpose**, because `syncMirror()` prunes everything under it that the bucket does not hold and runs concurrently with these writes (it would delete a temp mid-flight); **on the same filesystem on purpose**, so the rename cannot degrade into a copy. A failed write removes its temp and rethrows, so bucket-first is unchanged.
- **`putFileFromPath` had the same tear and now shares the fix.** Its cross-device fallback and its `keepSource` path (the P5-13 sync CLI) both did `fs.copyFile(srcPath, dest)` straight onto the destination — an identical window, for uploads and pushes. Both now go through one `promoteIntoMirror` helper: rename when it can, else copy into `.mirror-tmp` and rename. The plain same-device rename it already did was always atomic and is kept as the fast path; the old inline branches are deleted. Every other `fs.writeFile` left in the server is a CLI one-shot (reports, the geocode cache, `library pull`) with no concurrent reader, so the fix stops where the bug does.
- **No retry, no raised timeout, no `it.skip` — and `mcp.test.ts` is untouched.** The fix is in the code the test exercises, which is the whole point of the ticket.
- Gates: **`npx vitest run src/routes/mcp.test.ts` twenty times → twenty passes**, 61 tests each, against 4 failures in the 7 pre-fix runs on the same idle machine. `npm test`: **2,161 passing / 14 skipped**, the baseline exactly, with the two per-user-limiter cases green on this run too. `npx tsc --noEmit` clean.
