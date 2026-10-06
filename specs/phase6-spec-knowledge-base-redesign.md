# Spec: Knowledge base redesign — three functions, three resources

**Status:** Approved for ticketing (Nick, 2026-09-22)
**Author:** Claude, from Nick's sketch (`/Users/mac/Desktop/BLO/BLO-library-redesign-mockup.jpg`, 2026-09-22)
**Date:** 2026-09-22

---

## Problem statement

The knowledge base grew one ticket at a time, so its front door offers eight strip items, a seven-block landing and two Ask boxes, and a research intern has to know the vocabulary (Library, Pages, Map layers, Compare, Check a place, Ideas) before finding anything. Nick's sketch reduces it to three things a person does — **Search**, **Chat**, **New** — and three kinds of thing the library holds — **Datasets**, **Docs**, **Analysis** — with datasets browsable by who published them, what they are about, and what shape they are. This spec turns the sketch into requirements against the system as it stands (phase 5, 76 commits on `phase5-auth-core`).

---

## Success criteria

We will know this works when:
- [ ] A first-time user reaches any held resource in two clicks from the landing: a resource tile, then the item — without reading help.
- [ ] Every internal surface is reachable from the four header items (Library · Search · Chat · New) or the three resource tabs; no page depends on a link buried in a card.
- [ ] The datasets browser groups all datasets — held tables, indexed sources, public and internal map layers — by **Organization**, **Topic** or **Type**, with counts, and every dataset has all three values (none "unknown") after the migration.
- [ ] Chat holds a conversation: a follow-up refers to the previous turn, every tool the assistant used is visible, and any answer can be saved as a note, added to a page, or opened as the analysis it came from.
- [ ] New accepts a link, one file, or many files at once; a bulk drop of 20 files lands as 20 filed entries with title, summary, organization, topic, type and tags filled in automatically and marked as machine-annotated, with a one-press accept per entry.
- [ ] The public map is untouched; the logged-out header stays byte-identical (existing snapshot test).
- [ ] Existing deep links (`/library/:slug`, `/wiki/:slug`, `/layers/:id`, `/views/:slug`, `/place?…`, `/compare?…`) keep working; retired list routes redirect.

---

## Solution overview

One header for the internal tier: **Library** (the landing), **Search**, **Chat**, **New**. The landing shows what was recently edited, the pinned items, three resource tiles and the most recent items of any kind. Each tile opens a browser for that resource kind; the datasets browser groups by organization by default and can regroup by topic or type. Search is one page across every resource. Chat is the Ask feature grown into a conversation with the full tool set the assistants already have over MCP. New is one page with three ways in — a link, a file, many files — and the bulk path annotates each item with the model and files it for review. Under the hood this is a reorganisation of existing pieces plus three new capabilities: an organization vocabulary, a dataset type (shape), and bulk annotation.

---

## Detailed requirements

### A. Information architecture

1. **Header (internal tier):** `Library` → `/kb` · `Search` → `/search` · `Chat` → `/chat` · `New` → `/new`. The phone menu lists the same four plus Account and Log out. The current strip (Overview · Ask · Check a place · Library · Pages · Map layers · Compare · Ideas) is removed.
2. **Resource tabs** on the landing and on each browser page: `Datasets` → `/datasets` · `Docs` → `/docs` · `Analysis` → `/analysis`.
3. **What belongs where:**
   - **Datasets** — held datasets (`kind: dataset`), indexed sources (`kind: source`), public map layers (the registry), internal map layers (a held dataset's layer). The held/indexed distinction stays visible as the readiness verdict and the "not copied here" badge, but they live in one browser.
   - **Docs** — wiki pages (`kind: wiki`), uploaded documents (`kind: document`), notes (`kind: note`), and the to-file queue (`kind: incoming`) shown only to the person who dropped them and to admins. The `ideas` purpose becomes a filter inside Docs, not a nav item.
   - **Analysis** — the tools: Check a place, Compare, the dataset explorer (a table with filters, summaries, county context), Show on map; and their outputs: saved views (`kind: view`, map/table/compare) and cached place reports, listed as "recent analyses" with who ran them and when.
4. **Landing (`/kb`)** in this order: header · **Recently edited** (last 3 items the current user edited or created; falls back to "recently updated by anyone" for a new user) · **Pinned items** (the kb config's pinned list, e.g. the 5-5-5 plan) · the three resource tiles with counts · **Most recent items** (last 5 of any kind, by content time) · admin-only rows (attention queues, activity) at the foot, as today.
5. **Retired routes redirect:** `/library` → `/datasets` when `kind=dataset|source`, `/docs` when `kind=document|wiki|note|incoming`, `/analysis` when `kind=view`, else `/search?q=…` with the same filters; `/layers` → `/datasets?type=statistics` ; `/ask` → `/chat`; `/place` and `/compare` stay as the tool pages under Analysis; `/wiki` → `/docs?kind=wiki`.

### B. Datasets browser (`/datasets`)

6. **Grouping**, one of three, remembered per user: **Organization** (default), **Topic**, **Type**. Each group is a collapsible section with a count ("EPA · 13 datasets"), sorted by count then name; the item rows inside show title, the held/indexed badge, type chip, topic chip, and the readiness one-liner.
7. **Organization** is a new, curated vocabulary in `src/config/organizations.ts` (exported to the server like the taxonomy): canonical id, display name, aliases. Seed from what the library holds today: US EPA, USGS, FEMA, NOAA, HUD, US Census Bureau, US DOT PHMSA, US Department of Labor MSHA, US Fish and Wildlife Service, US Energy Information Administration, USDA (with sub-units NASS, NRCS, Forest Service, FPAC as aliases of one parent shown as "USDA · Forest Service"), Georgia EPD, North Carolina DEQ, Alabama ADEM, DC Open Data, Memphis Horticulture Society, NCED partnership, Regrid, Urban Institute, Black Worker Data Center, Bureau of Labor Statistics, NAACP & Brookings, IHME, TELE (Yale / UMass), Black Land Ownership (BLO). Every dataset gets `organization: <id>` in its manifest (sources from `source.provider` through the aliases; held datasets from a new manifest field; public layers from the registry's `source`). Unknown providers are kept as their own group and counted in the admin "no organization" queue.
8. **Topic** is the existing taxonomy topic (the fourteen), unchanged: Nick's examples map onto it ("real estate" → Housing and Land; "pollution" → Environment). No new topic vocabulary in this phase; if the browser shows the fourteen are too fine, a second-level grouping is a later ticket.
9. **Type** is a new, small vocabulary, `shape`, one per dataset, with plain labels:
   - `areas` — **Areas and boundaries**: parcels, flood zones, wetlands, easements, service areas;
   - `points` — **Sites and points**: individual sites or facilities with coordinates (Superfund sites, storage tanks, mines, organizations);
   - `statistics` — **Statistics by county or tract**: values aggregated by area (the public map layers, ACS, the livability index);
   - `records` — **Records without a location**: a directory, a survey extract, a table with no coordinates or area codes.
   Derived once at reindex and stored: a layer block's `geometry` (point/county), the source's `placeQuery.by` and the presence of geometry in its access notes, a dataset's columns (a GEOID column → statistics; lat/lng → points; GeoJSON polygons → geospatial), else `table`. A manifest may override with `shape:`.
10. **Search and filters inside the browser:** a text box (same multi-word matching as the catalog), the readiness filter (held · indexed · map layers), and the three vocabularies as chips.

### C. Docs and Analysis browsers

11. **`/docs`** lists pages, documents, notes with the same grouping control: by **Purpose** (strategy · research · outreach · ideas) default, or **Topic**, or **Kind** (page · document · note). Recently updated first inside a group. The to-file queue appears as its own group for those who can see it.
12. **`/analysis`** has two halves: the tools as cards (Check a place · Compare · Explore a dataset · Show on map) each with a one-line description and a Start button, and **Recent analyses**: saved views and cached place reports, newest first, with who and when, opening in one click. A place report reopened from here is served from its cache.

### D. Search (`/search`)

13. One page, one box, results across every resource kind, grouped by kind in the held-first order (datasets · pages · analyses · docs · notes · layers · sources), each result with its badge and one-line verdict. Filters as chips: kind, organization, topic, type, purpose. The ⌘K palette stays as the quick version and its Enter-with-text goes to `/search?q=`.
14. The search matches the catalog fields today plus **extracted text** (the Ask index's page chunks) when the query finds fewer than 5 catalog hits, shown as a second group "Inside documents" with the page number.

### E. Chat (`/chat`)

15. **A conversation, not a question.** Threads persist per user (Postgres table `library_chats`: id, user, title, created, updated; messages with role, text, tool calls, citations). The page lists the user's threads on the left and the current thread on the right; New chat starts one. A thread's title is its first question, editable.
16. **Tools:** the assistant has the same tool set the MCP server exposes — search_library, get_entry, read_document, read_page, query_dataset (table filters, group-by, summaries), county values, fetch_for_place, place_report, compare counties, save_view, create_note, append_to_page, drop_link, inspect_link — with writes requiring an explicit confirm in the UI before they run. Every tool call is shown inline as a collapsed line ("Searched the library for … · 6 results") and every write is audited "via chat".
17. **Answers cite** as Ask does today ("Where this came from"), and each answer offers Save as note · Add to page · Open (when the answer is an analysis: the place report, the compare, the view).
18. The public map chat is unchanged. The internal Chat can hand a map question to the map by answering with a link (a saved view or a Show-on-map link), not by driving the map directly, in this phase.
19. Budget: the daily token budget applies per user; a thread over 30 turns is compacted by summarising the older turns (the model's compaction, or a server-side summary) so the context stays bounded.

### F. New (`/new`)

20. One page with three panels: **A link** (the drop form as today), **A document** (single upload with the taxonomy fields), **Many documents** (a folder or multi-file drop).
21. **Bulk drop:** up to 50 files, 100 MB per file, 500 MB per drop. Each file becomes its own entry (a folder becomes one **collection** entry holding its files, when the user ticks "keep as one collection"). For each entry the pipeline runs: extract text → the model reads the first ~6,000 characters and returns title, summary, organization, topic, purpose, tags, shape → the values are stored as the entry's **suggestion** (not applied), the entry is filed `needs-review`, and the New page shows a progress list (queued · reading · suggested · failed) where each row shows the suggested values greyed with **Accept** (applies them) and **Edit** (opens the fields prefilled; saving applies what the person typed), plus **Accept all**. Until accepted, cards and the entry page show the suggested title in grey with an "suggested" badge. The model pass costs about a cent per file; the page shows the estimate before starting and the running total after.
22. When the model is unavailable, bulk items still land with the deterministic floor (filename → title, extraction, shape from columns) and the honesty line, and the annotation can be re-run from the entry ("Look again") or from the New page's list.
23. The existing single-drop behaviour (suggestion offered, never applied) is unchanged for the single-file path; the difference between the two paths is stated on the page.

### Non-functional

- **Performance:** the datasets browser renders from the list-row projection plus the two new fields (organization, shape) — no per-row fetch; grouping is client-side over the cached catalog. Chat streams the answer. Bulk annotation runs in the existing fetch queue, three files in flight.
- **Security:** all new routes under the internal tier with CSRF; chat writes confirm in the UI and audit; bulk uploads pass the same size, type and key checks as single uploads; no file is fetched from a URL during a bulk file drop.
- **Reliability:** a failed annotation never loses the file; the entry exists with the floor and a retry.

---

## System context

### How it fits
- Reuses: the catalog and its list-row projection (P5-88), the taxonomy (P5-63), readiness (P5-82), the deterministic floor and pull-in (P5-79/80), the Ask loop and its three tools, the MCP tool table (P5-46..52, 57, 85), saved views (P5-54/55/78), the place report (P5-58), the client catalog cache (P5-89), the first-run checklist (P5-71).
- New: `organizations.ts` (+ export), `shape` derivation at reindex, `library_chats` tables and routes, the bulk-annotation path in the fetch queue, four new pages (`/search`, `/chat`, `/new`, `/datasets`), two rebuilt (`/docs`, `/analysis`), a rebuilt landing, redirects.

### Dependencies
- Anthropic credit on the account (Chat, bulk annotation). Without it: Chat answers from retrieval only with the honesty line; bulk lands with the floor.
- The content push tree: every dataset manifest gains `organization` (and optionally `shape`) — a `retag`-style migration with a dry-run report, like P5-63.

### Affected systems
- MCP tool descriptions (search results carry organization and shape); help recipes and the library guide; the first-run checklist's six steps become: read Start here, search for something, ask Chat a question, open a dataset, run an analysis, add something.

---

## Constraints and boundaries

### In scope
- Everything under A–F above; the migration of existing manifests; redirects; docs (DEPLOY, MCP, RUN-LOCAL, the library guide).

### Out of scope (this phase)
- Driving the public map from Chat; a second-level topic vocabulary; OCR or table extraction from PDFs; folder sync from Drive or Dropbox; sharing threads between users; changing the public map.

### Assumptions
- Machine annotation is acceptable for the **bulk** path only, always marked and always reviewable; single drops keep "suggest, never apply" (Nick's earlier rule).
- The fourteen taxonomy topics are the topic grouping; Nick's "real estate / pollution" examples are satisfied by Housing, Land and Environment.
- Sources (indexed-only) belong in Datasets, distinguished by readiness, rather than in a fourth kind.
- Notes and the ideas purpose belong in Docs.

### Technical constraints
- Vue 3 client, Express + Postgres server, B2 bucket; no new frameworks. The list-row projection must add `organization` and `shape` (both small) and nothing else. Public bundle must not gain internal data (leak check).

---

## Examples

### Example 1: browsing datasets by organization (happy path)
**Given** a logged-in intern on `/kb`
**When** they press the Datasets tile
**Then** `/datasets` opens grouped by organization: "US EPA · 13", "USDA · 6", "USGS · 3", … each collapsible; pressing "Topic" regroups the same rows under Environment, Water, Hazards, Land …; pressing "Type" regroups under Points, Geospatial, Statistics, Table; each row shows held/indexed and the verdict; the choice persists on their next visit.

### Example 2: bulk drop with the model available
**Given** the New page and a folder of 12 PDFs (8 MB total)
**When** the intern drops the folder and presses Start
**Then** 12 entries appear in the list as queued → reading → annotated within about two minutes; each shows its machine-written title, summary, organization, topic and tags with an "annotated automatically" badge; **Accept all** files them as published; one PDF that was a scanned image lands with its filename as title, "no text could be read" and a Look-again control; the cost line reads "about 12¢".

### Example 3: bulk drop with no credit (failure case)
**Given** the same folder and an exhausted account
**When** the intern presses Start
**Then** every file lands with the floor — filename title, extracted text, shape when derivable — status needs-review, the row says "Read on <date>. No model pass — the model refused the key" (admin) or "the model was unavailable" (member), and nothing is lost; re-running annotation later from the New page annotates them.

### Example 4: a chat that runs an analysis (happy path)
**Given** a new thread
**When** the lead types "what environmental risks are near 55 Trinity Ave SW Atlanta, and which sources actually had data"
**Then** the assistant shows "Ran a place report for 55 Trinity Ave SW … (cached, 40 sources)", answers with the found/none/by-hand split citing sections, offers Open the report · Save as note · Add to page; a follow-up "compare Fulton with DeKalb on flood risk" runs the compare tool and links the saved comparison.

### Example 5: search that reaches inside documents (edge case)
**Given** the search box and the query "absentee owners 50 acres"
**When** fewer than five catalog rows match
**Then** the page adds an "Inside documents" group listing the TELE Georgia profiles with the page numbers where the phrase occurs, each opening the viewer at that page.

### Example 6: a dataset with no organization (edge case)
**Given** a held dataset whose manifest says only "final folder for Homesteading plan / (Nick, 2026-09)"
**When** the browser groups by organization
**Then** it appears under "Black Land Ownership (BLO)" because the migration mapped that phrase; a provider the vocabulary does not know appears under its own name and is counted in the admin "no organization" row.

---

## Decisions (Nick, 2026-09-22)

- **Bulk annotation is a suggestion the person sees and accepts.** The model's title, summary, organization, topic, tags and type are shown on each row of the New page and on the entry, greyed until accepted; **Accept** applies them, editing a field and saving applies the edited values; nothing is written to the manifest by the machine alone. Same rule as single drops, so one UX for both.
- **Type** keeps the four cuts with plainer names: **Areas and boundaries** (`areas`: parcels, zones, wetlands), **Sites and points** (`points`), **Statistics by county or tract** (`statistics`), **Records without a location** (`records`: directories, extracts, survey tables).
- **Notes and ideas under Docs; sources under Datasets.** Confirmed.
- **Chat and the map:** links to saved views and Show-on-map in this phase. The chat page is laid out with a map pane in mind (answer on the left, a slot on the right) so a live map can be added without moving anything; a spike ticket scopes it.
- **Recently edited:** one short list — the current user's last three first, marked "yours", then the last few by anyone — no second heading.

## Open questions

- [ ] None blocking. Ticketed as `specs/phase6-tickets.md`.

## Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-09-22 | Claude | First draft from Nick's sketch and the phase 5 system |
