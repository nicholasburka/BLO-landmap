# Phase 11 — one home per set

Opened 2026-10-13. Signed off from the design note of the same date
(mockups: `https://claude.ai/code/artifact/ec446059-600f-4e53-898a-ec2474ad27d8`).

---

## Problem

**A working set is reachable only through a saved view it may not have.** The
workspace — map, weight editor, analyses, derived columns — renders at
`/views/<view-slug>`, and only when that view presents a set
(`src/views/ViewRedirect.vue:6`). The set itself has no page.

A set with no view is a dead end: `/analysis` renders
`data-testid="set-no-views"` → *"No views of it yet"*
(`src/views/AnalysisView.vue:502`) and offers nowhere to go.

**That case is not hypothetical — it is what the newest creation path makes.**
`createWorkingSet()` (`src/lib/workingSets.ts:142`) writes the set and no view,
and it is called from exactly one place: `ExploreMapPane.vue:211`, the P9-12
"Create a working set" flow shipped 2026-10-09. Every set made that way is
unreachable.

Around that, a set already answers to **four URLs and owns none of them**:

```
/library/<set>            the catalog entry
/views/<view>             the workspace — only via a view
/datasets?workingSet=     its datasets
/place?set=               a place report
```

## Success criteria

- [ ] A set created by any path is openable immediately, with no view involved.
- [ ] One URL identifies a set; every tab and drill-in is a linkable state of it.
- [ ] Browser Back walks tabs and leaves a drilled-in dataset, instead of
      exiting the workspace.
- [ ] A reader can answer *"what does this set say per county"* and *"what is
      in this set"* without leaving it.
- [ ] Search and chat can both be scoped to a set, and unscoped again, from the
      same control.

## Decisions taken (signed off 2026-10-13)

**Option A — the set owns its framing.** A set carries its default framing
inline; `/sets/<slug>` is its home. A saved view is demoted from *required
intermediary* to *optional saved framing*. Ad-hoc views (a view with no set)
are untouched and stay first-class — `ViewRedirect.vue:4` calls them
"permanent and first-class, never legacy", and that stands.

**The builder needs no separate work.** Its only identified defect was making
unreachable sets, which A fixes at the source.

**Chat scope changes both ways, mid-conversation** (P11-9).

### Calls I made on the four questions that came back unanswered

Override any of these and the ticket moves with it.

| Question | Call | Why |
|---|---|---|
| The two existing views | **Non-destructive**: copy the framing onto the set, keep the view, redirect its URL | There is no delete endpoint (P8-2 is open) and both view URLs may already be shared. Nothing is lost and nothing 404s. |
| Counties tab: sortable? filterable? | **Sortable in v1, filter deferred** | Sorting is what makes a 3,215-row county table answer a question. Filtering is a second control and the dataset explorer already has one if we want it later. |
| "Save this framing" in v1 | **Deferred** | Nobody has asked for a second framing of one set, and it is the only thing that requires a set to have more than one view. The data model still permits it; v1 ships no button. |
| Before or beside P8-2 | **Beside, not merged** | P11-3's migration needs no delete. But a set that owns its framing is a different object to delete, so P8-2 should be written after P11-1 lands, not before. |

---

## P11-1 [FEATURE] The set carries its own framing

**Type:** Feature · **Size:** M · **Depends:** none

Spec §F says a working set "holds no framing — no viewport, no sort, no
palette" (`server/src/services/workingSetMeta.ts:6`). That separation is what
forces every set through a view to be usable, and it is the root of the defect.

A set gains a `framing` field: the state the map restores when you open the
set, with no view involved. Views keep existing and keep reading the set's
rows, so the guarantee §F actually cares about — *no two framings can disagree
about a number* — is untouched. What changes is that the view is no longer the
only way in.

**Framing is a subset of `SavedViewState`** (`src/lib/views.ts:43`), not a copy
of it. Take `layers`, `filters`, `limit`, `regionStates`, `viewport`,
`pointLayers`, `siteLayers`. **Leave `prompt` out** — it records the chat
question that produced a view, which is a property of that saved moment and
means nothing as a set's default.

### Requirements
- [ ] `WorkingSetManifest` gains optional `framing`, normalised and serialised
      beside `datasets` / `layers` / `sites` / `derived`.
- [ ] Absent `framing` is valid and means "derive a default from the set's
      county layers" — the stated-absence rule the manifest already uses for
      `derived`, so no migration is required for a set to stay readable.
- [ ] `POST /api/working-sets` accepts an optional framing and stores it.
- [ ] `PATCH /api/working-sets/:slug` can replace it.
- [ ] `GET /api/working-sets/:slug` returns it.
- [ ] Framing is validated by the **same validator a map view's state already
      goes through**, against the real layer registry and internal manifest —
      one validator, or the two will drift.

### Acceptance criteria
**Given** a set created with no framing, **when** it is fetched, **then**
`framing` is absent and the response is valid.

**Given** a set created with a framing naming two county layers, **when** it is
fetched, **then** the framing round-trips exactly, `prompt` excluded.

**Given** a framing naming a layer id that is not in the registry, **when** the
set is written, **then** it is refused with the same error a view's state gets
— not silently dropped.

### Out of scope
The route and the UI (P11-2). Migration of existing views (P11-3).

### Files
- `server/src/services/workingSetMeta.ts` — the field, normaliser, serialiser
- `server/src/routes/workingSets.ts` — POST / PATCH / GET
- `src/lib/workingSets.ts` — the client type and `createWorkingSet`
- the shared view-state validator — reused, not copied

---

## P11-2 [FEATURE] `/sets/<slug>` is the set's home

**Type:** Feature · **Size:** M · **Depends:** P11-1

`WorkingSetWorkspace` takes `view: SavedView`
(`src/components/WorkingSetWorkspace.vue:89`) and reads the set out of
`view.workingSet`. Invert it: the component takes a **set**, and framing comes
from the set.

### Requirements
- [ ] New guarded route `/sets/:slug` rendering the workspace from the set.
- [ ] `WorkingSetWorkspace` takes `slug` (or a `WorkingSetDetail`); `SavedView`
      is no longer required to render it.
- [ ] `/views/<slug>` where the view **presents a set** redirects to
      `/sets/<set-slug>`, preserving any tab/query state. Use `replace`, so
      Back does not bounce through the redirect — the rule `ViewRedirect`
      already follows.
- [ ] `/views/<slug>` for an **ad-hoc** view behaves exactly as it does today.
      Not one line of that branch changes.
- [ ] `workingSetHref()` points at `/sets/<slug>`; every caller follows.
- [ ] A set with no view opens. This is the acceptance test for the whole phase.

### Acceptance criteria
**Given** a set made through Explore → "Create a working set", **when** its row
on `/analysis` is opened, **then** the workspace renders — where today it reads
"No views of it yet" and goes nowhere.

**Given** an existing `/views/livability-index-play-with-it` link, **when** it
is opened, **then** it lands on `/sets/blo-livability-index-v2` with the same
framing drawn, and Back returns to where the reader came from — not to the
redirect.

**Given** an ad-hoc view (no `workingSet`), **when** it is opened, **then** it
restores on the map exactly as before.

### Out of scope
Tabs (P11-4). The two new tabs (P11-5, P11-6).

### Files
- `src/router/index.ts` — the new route; `/views/:slug` keeps its guard
- `src/views/ViewRedirect.vue` — the set branch becomes a redirect
- `src/views/SetView.vue` *(new)* — thin host, the way `ViewRedirect` is
- `src/components/WorkingSetWorkspace.vue` — props
- `src/lib/workingSets.ts` — `workingSetHref`

---

## P11-3 [CHORE] Fold the existing views into their sets

**Type:** Chore · **Size:** S · **Depends:** P11-1

Two sets exist in dev and one in prod, each with exactly one view. Non-
destructive, per the call above: copy the framing, keep the view, let P11-2's
redirect carry the URL.

### Requirements
- [ ] A script that, for each set with exactly one presenting view, copies that
      view's state onto the set as `framing` (minus `prompt`).
- [ ] A set that already has a framing is left alone — the script is re-runnable.
- [ ] A set with **two or more** views picks none and **reports** them for a
      human to choose. Do not guess; there are none today, and if that changes
      the right answer is a question, not a heuristic.
- [ ] Nothing is deleted.
- [ ] Dry-run by default; `--write` to apply.

### Acceptance criteria
**Given** prod's `redevelopment-dashboard` and its one view, **when** the script
runs with `--write`, **then** the set gains that framing and the view still
resolves.

**Given** the script is run twice, **then** the second run reports no changes.

### Files
- `server/src/cli/` — a new subcommand beside `users` / `library`
- `DEPLOY.md` — one line, since this runs once against prod

---

## P11-4 [FEATURE] Tabs become navigations, so Back works

**Type:** Feature · **Size:** S · **Depends:** P11-2

The tab bar calls `replace` on the same path and says so:
*"Two interfaces, one object, one URL. `replace` on the same path, so this is
not a navigation"* (`src/components/WorkingSetWorkspace.vue:999-1000`). The
reasoning was sound for two tabs on one object. With three tabs and a drill-in
it costs the reader the Back button — Back from the Data tab leaves the
workspace entirely.

### Requirements
- [ ] Tab state rides on `?tab=map|counties|datasets`; `map` is the default and
      renders at the bare URL (no `?tab=map` on first load).
- [ ] Switching tabs **pushes**.
- [ ] An unknown `?tab=` value falls back to `map` without an error.
- [ ] The map canvas keeps `v-if`, never `v-show` — a reader on Counties must
      not hold a WebGL context or download a county file. That rule is already
      load-bearing and must survive the refactor.

### Acceptance criteria
**Given** a reader on Map, **when** they open Counties then press Back,
**then** they are on Map and still in the set.

**Given** `/sets/<slug>?tab=counties` pasted cold, **when** it loads, **then**
Counties is open.

### Files
- `src/components/WorkingSetWorkspace.vue` — the tab bar and `show()`

---

## P11-5 [FEATURE] The Counties tab

**Type:** Feature · **Size:** M · **Depends:** P11-4

Today's Data tab is the **anchor dataset's** rows
(`WorkingSetWorkspace.vue:1272`) and says *"This set is not anchored on a table
we hold"* when there is no anchor. For a set anchored on sites that is a list
of sites; for a set of county layers it is nothing at all. Neither answers
*what does this set say about a county*.

### Requirements
- [ ] One row per county across the set's coverage.
- [ ] Columns: each county layer in the set, plus every derived column.
- [ ] Point datasets in the set roll up to a per-county **count**. Reuse
      `src/lib/pointRollup.ts` — the rollup P9-7 already built and tested.
- [ ] Sortable by any column. Not filterable in v1.
- [ ] **Blank and zero are different and must read differently**: `—` for
      measured-but-missing, `0` for counted-and-absent. This is P9-7's
      distinction and the same rule that makes P9-9 a bug.
- [ ] Numerals tabular, so columns line up.
- [ ] The table scrolls inside its own container; the page never scrolls
      sideways.

### Acceptance criteria
**Given** a set with two county layers and one point dataset, **when** Counties
opens, **then** every county shows both values and a count.

**Given** a county absent from one layer's data, **then** that cell reads `—`,
and a county present with no points reads `0`.

**Given** a click on a column header, **then** rows sort by it, descending
first — the useful direction for an index.

### Out of scope
Filtering. Export. Editing.

### Files
- `src/components/SetCountyTable.vue` *(new)*
- `src/components/WorkingSetWorkspace.vue` — the tab
- `src/lib/pointRollup.ts` — reused as-is

---

## P11-6 [FEATURE] The Datasets tab

**Type:** Feature · **Size:** M · **Depends:** P11-4

What a set is made of currently lives on another page entirely —
`/datasets?workingSet=<slug>` (`src/lib/workingSets.ts:325`). Leaving the set
to see what is in the set is the navigability complaint in one sentence.

### Requirements
- [ ] The set's datasets listed in place: name, geometry, held / not-held.
- [ ] Opening one renders it **inside the tab** and adds `&open=<slug>`.
- [ ] Back closes it and returns to the list, still in the set.
- [ ] A not-held dataset offers the sourcing path instead of an empty table.
- [ ] The existing `/datasets?workingSet=` page stays and keeps working — it is
      what the progress line counts, and the two must not disagree.

### Acceptance criteria
**Given** the Datasets tab, **when** a held dataset is opened and Back pressed,
**then** the reader is on the list, not off the set.

**Given** `?tab=datasets&open=<slug>` pasted cold, **then** that dataset is open.

**Given** a dataset the library does not hold, **then** the row says so and
links to sourcing rather than opening an empty table.

### Files
- `src/components/SetDatasetList.vue` *(new)*
- `src/components/WorkingSetWorkspace.vue` — the tab
- `src/views/DatasetView.vue` — reused embedded, as the Data tab already does

---

## P11-7 [FEATURE] Analysis leads with sets

**Type:** Feature · **Size:** S · **Depends:** P11-2

`/analysis` opens with six tool cards and puts the working sets below them —
but five of the six need a set and say so in their own copy ("Inside a working
set — open one below"). The page leads with things you cannot use yet.

### Requirements
- [ ] Sets first, as the page's primary list, each linking to `/sets/<slug>`.
- [ ] The three genuinely library-wide tools — check a place, compare counties,
      browse a table — keep a compact group of their own.
- [ ] The three set-scoped tools move onto the set page, where they already act.
- [ ] "New working set" is the page's one `--write` control.
- [ ] `set-no-views` is deleted. There is no such state after P11-2.

### Acceptance criteria
**Given** `/analysis`, **when** it loads, **then** the first thing under the
heading is the list of working sets.

**Given** a set with no saved view, **then** its row links to its workspace and
says nothing about views.

### Files
- `src/views/AnalysisView.vue` — the ordering, the set row, the tool group

---

## P11-8 [FEATURE] Search scoped to a set

**Type:** Feature · **Size:** S · **Depends:** P11-2

There is no set filter in `SearchView` today.

### Requirements
- [ ] `/search?set=<slug>` restricts results to the set's members.
- [ ] The scope shows as a **removable chip**; removing it searches everything
      and drops the query param.
- [ ] A "Search in this set" entry point on the set page carries the slug.
- [ ] An unknown or deleted slug searches everything and says why, once.

### Acceptance criteria
**Given** a scoped search, **when** the chip is dismissed, **then** the same
query re-runs across the library and the URL loses `set=`.

**Given** `/search?set=<gone>`, **then** results are library-wide with one line
explaining the scope was dropped.

### Files
- `src/views/SearchView.vue`
- `src/components/ScopeChip.vue` *(new — shared with P11-9)*

---

## P11-9 [FEATURE] Chat scoped to a set, rescopable mid-conversation

**Type:** Feature · **Size:** M · **Depends:** P11-2, P11-8 (the chip)

`ChatView` has no scope concept. Signed off: scope changes **both ways,
including in the middle of a scoped conversation**.

A scope that is not recorded makes a saved conversation unreadable later — the
answer depended on a scope nobody can see. So the transcript carries it.

### Requirements
- [ ] `/chat?set=<slug>` opens scoped; the chip shows which set.
- [ ] Scope can be **set, cleared and changed mid-conversation**, without
      starting a new chat.
- [ ] A scope change is **recorded in the transcript** as its own entry, so the
      turns under it can be read against the right scope.
- [ ] Scope survives a reload (it is in the URL).
- [ ] The system prompt states the current scope and what it means: *this set's
      datasets and derived columns only*.
- [ ] "Ask about this set" on the set page carries the slug.

### Acceptance criteria
**Given** a chat scoped to a set, **when** the reader asks a question, **then**
the answer is drawn from that set's members only.

**Given** a scoped chat mid-conversation, **when** the scope is cleared,
**then** the next answer is library-wide, the earlier turns remain, and the
transcript shows where the scope changed.

**Given** a scoped chat, **when** the page is reloaded, **then** the scope is
still set and still shown.

### Out of scope
The chat **tools** that act on a set — that is P10-2/P10-3, and this ticket
amends them (below) rather than doing them.

### Files
- `src/views/ChatView.vue`
- `src/components/ScopeChip.vue` — shared with P11-8
- `server/src/prompt/chatPrompt.ts` — scope in the system prompt
- `server/src/routes/chat.ts` — accept and validate the scope

---

## P11-10 [CHORE] Spec §F says a set holds no framing

**Type:** Chore · **Size:** XS · **Depends:** P11-1

`workingSetMeta.ts:6` and `specs/phase7-spec-map-views.md` both state the separation this phase
changes. Leaving them is how the next person rebuilds the indirection.

### Requirements
- [ ] §F records that a set carries a default framing, and that a view is an
      optional saved framing rather than the way in.
- [ ] The guarantee that survives — every framing reads the same rows, so none
      can disagree about a number — is stated as the reason views still exist.
- [ ] Ad-hoc views are restated as first-class.

### Files
- `specs/phase7-spec-map-views.md` (§F), `server/src/services/workingSetMeta.ts` (the header comment)

---

## Amendments to phase 10

P11-9 changes two tickets in `specs/phase10-chat-parity.md`. Noted here rather
than edited there, so the phase-10 file stays the record of what was found.

- **P10-3** — chat holds a *current scope*, shown and changeable, rather than
  inferring a set per question. The scope control is P11-9; P10-3 becomes the
  **tools** that read it.
- **P10-2** (`get_working_set`) — now also fills the scope chip and is what the
  model reads when a scope is set. Unchanged in shape, higher in value.
- **New, P10-10** — MCP has no page to carry a chip, so it needs scope as an
  explicit tool argument or a session concept. Parity here means *the same
  capability*, not the same control.

---

## Sequencing

```
P11-1  set carries framing
  └─ P11-2  /sets/<slug> is home        ← the defect is fixed here
       ├─ P11-3  fold existing views    (run once against prod)
       ├─ P11-4  tabs push              → P11-5 counties
       │                                → P11-6 datasets
       ├─ P11-7  analysis leads with sets
       └─ P11-8  search scope  ─┬─ shared chip
            └─ P11-9  chat scope ┘

P11-10 spec §F   — with P11-1, not after
P8-2   rename/delete — write it after P11-1, against the new object
```

**P11-1 → P11-2 is the critical path and the whole point.** Everything after is
additive; a set that opens is the fix. If the phase has to stop early, stop
after P11-2 and the product is strictly better than it is today.
