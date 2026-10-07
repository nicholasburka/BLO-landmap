# Phase 8 — tickets

Opened 2026-10-07, from putting the first working set into production and
looking at it.

---

## P8-1 [BUG] Slug uniqueness is global when it only needs to be per-kind

`library_catalog` declares `slug TEXT NOT NULL UNIQUE` and `getCatalogEntry(slug)`
takes a bare slug with no kind. So a view and the working set it presents cannot
share a name — the second one created gets `-2`:

```
/library/redevelopment-dashboard      ← the set
/views/redevelopment-dashboard-2      ← the view that presents it
```

**The constraint is stricter than anything requires.** Both other namespaces
already partition by kind:

- URLs — `/library/<slug>` vs `/views/<slug>`
- Bucket paths — `library/working-sets/<slug>/meta.json` vs `library/views/<slug>.json`

Global uniqueness buys one thing: a single-argument lookup against one table.
It costs the **most natural naming pair in the system** — a set and its view
*should* share a name, since the set is the noun the view presents.

And it is systematic, not bad luck. The documented flow is set-first-then-view,
so if both are named for the thing, **the view always loses** — and the view is
the URL people open and share, while the set's slug is only ever read inside
manifests. Exactly backwards.

**Do:** make uniqueness `(kind, slug)`. Every `getCatalogEntry(slug)` caller
needs a kind or a kind-inferring wrapper — mechanical but wide, so count the
callers before starting. Bare-slug references in manifests (`workingSet`,
`datasets[]`, `kb.json` `homeSlug`/`pinned`, wiki `[[links]]`) each imply a kind
from their field; the ones that genuinely cannot must keep resolving by search
order, and the ticket should name them rather than assume there are none.

**Interim, costing nothing:** document `POST /api/working-sets/from-view/:slug`
as the default. Creating the view first gives the view the clean slug and the
set the suffix, which is the right way round. The docs currently teach the
wrong order.

Size: M (data layer, wide call-site change)

---

## P8-2 [BUG] Views and working sets cannot be deleted or renamed

Views offer `GET /api/views`, `GET /api/views/:slug`, `POST /api/views` and
`PUT /api/views/:slug/working-set`. Working sets have **no DELETE at all**.

So every misnamed or mistaken object is permanent. `redevelopment-dashboard-2`
cannot be cleaned up; a set created against the wrong datasets stays forever;
and the bad model readings found in P7-10 (`msha-mines` `covers: 1970` read off
"since 1970"; `regrid-parcels` `published: 2026-10` read off an update *cadence*)
can be cleared field-by-field but their entries cannot be removed.

A library where mistakes are permanent teaches people not to touch it.

**Do:** `DELETE /api/views/:slug` and `DELETE /api/working-sets/:slug` — remove
the bucket file and the catalog row, audited, internal-tier, CSRF. Decide what a
set's deletion does to views that present it: re-point is wrong (to what?),
cascade is dangerous, so the honest answer is probably **refuse while any view
presents it** and say which. Derived columns live on the set's own manifest, so
they go with it.

Rename is the harder half and can be separate: a slug is the primary key and the
bucket path, so renaming is copy + reindex + leave a redirect, or it breaks every
link that ever pointed at it.

Size: S for delete, M for rename

---

## P8-3 [BUG] The working-set entry page hides what it is and shows it twice

`/library/redevelopment-dashboard` today:

- **The datasets are invisible.** `workingSetBlock.datasets` is a full array of
  slugs and the template renders only `.length` — "4 datasets" — with the actual
  list behind a small green link reading *"Its datasets, and what is still
  missing"*. The single most useful fact about a set is which datasets are in it,
  and it is one click and one odd sentence away.
- **The description appears twice.** `describeWorkingSet()` composes
  `"Working set · <purpose> · 4 datasets · 6 layers"` for one-line contexts —
  cards, ⌘K rows, `search_library` — and the entry page renders *both* that
  composed line and the same facts broken out in the card above it.
- **"and what is still missing" is confusing here.** It describes a readiness
  check on the datasets page. On the entry page it reads as though something is
  wrong with the set.
- `working-sets` prints under the title as a subtitle — the storage directory,
  shown as if it were information.
- "Quick actions" holds a single "Files (0)" link.

**Do:** list the member datasets inline with links and their kind/status, the
way `members[]` already comes back from `GET /api/working-sets/:slug` (it
carries title, kind, status and readiness per member — the page just does not
use it). Drop the composed description on the entry page, where its parts are
already shown; keep it everywhere one line is all there is. Re-word or remove
the datasets link. Drop the directory subtitle.

The layers deserve the same treatment — 6 layers, named, is more useful than
"6 layers".

Size: S

---

## P8-4 [FEATURE] "When was this last touched" has no honest answer

There is no visible chronology and nothing to sort or filter by. `updatedAt`
reaches the client and renders on entry/KB/wiki/docs pages but appears on no
dataset card and in no sort.

The trap is already written down at `libraryCatalog.ts:124`:

> *"Never `updatedAt`: that says when the BYTES last moved, so re-pushing a 2019
> file would make it read as 2026 data."*

`updatedAt` means **"when we last reindexed this"**. A push on 2026-10-06 reset
it on 50 entries nobody edited, and a corrective push reset it again. A filter
built on it would be confidently wrong.

**Two different questions, two different fields:**

1. **"How current is the data?"** — P7-10's `dates.covers` / `dates.published`
   already answer this and are already on every row. Sparse (8 and 7 of 45),
   because the material often does not say. Surfacing a sparse field as a filter
   is a UX decision: most entries would fall into "unknown", and that may be
   honest rather than broken.
2. **"When did a person last touch this?"** — no field exists. Wants a real
   `editedAt`, written only by human edits (filing, annotation, page edit, status
   change) and explicitly NOT by reindex, remediation or a re-push.

**Do:** add `editedAt`; surface both it and `dates` on cards; add sort and a
top-level filter. Decide what an unknown date does in a filter before building
it.

Size: M

---

## P8-5 [BUG] A dead Reindex helper, and copy pointing at a button that does not exist

`reindexLibrary()` exists at `src/lib/libraryCatalog.ts:669` and **nothing calls
it.** Meanwhile `KnowledgeBaseView.vue:162` tells people *"Add a page, drop a
file, or push a dataset and press Reindex."* There is no Reindex button. Several
of this week's instructions repeated that in good faith.

Nick's read, and it is right: a reindex is a **cache rebuild**, and a button for
it asks a person to know that an index exists and has gone stale.

**Do:** delete the dead helper and the copy. Make external writes self-indexing —
`push` already reindexes when `DATABASE_URL` is reachable, and boot already
reindexes; make those the only paths and keep a manual trigger as CLI/admin-only,
not a product feature.

Note for whoever does it: a laptop `push` usually cannot reach prod's database,
so "push reindexes" is only true from somewhere that can. The honest fix may be
for the API to notice a changed bucket generation rather than trusting the
pusher.

Size: S

---

## P8-6 [BUG] The taxonomy has no `energy` topic

Six manifests staged on 2026-10-06 used `category: "energy"` — transmission
lines, three pipeline families, power plants. It is not in `src/config/taxonomy.ts`,
so reindex warns per entry, keeps the value, and the entries mis-facet.

They were refiled under `environment` on 2026-10-07 as the closest fit, which is
a workaround: energy infrastructure is the *subject* of the redevelopment
dashboard, not an environmental sub-topic.

**Do:** add `energy`, or decide deliberately that it belongs under `environment`
and refile. Either is fine; the current state — a value the system warns about on
every reindex — is not. Remember `npm run export:layers` after any taxonomy
change, or the generated copy goes stale and a test fails.

Size: XS

---

## Carried from phase 7

- **`meta.layers[]`** — a manifest declares one `meta.layer` with one `valueKey`,
  so CEJST's 22 columns yield exactly one map layer and the other 21 cannot be
  layers or terms in a weighted index. This is the main thing between us and the
  workbook's political-efficacy layer.
- **Polygon geometry** — `LAYER_GEOMETRIES` is `county | point | line | state`.
  Solar PV (6,611) and Superfund boundaries (2,114) cannot be ingested, and
  centroid-reducing both loses the point: a Superfund site's boundary *is* the
  finding, and a solar array's area is its capacity.
- **A recorded decline for inferred fields** — a declined field stays a
  candidate, so every reindex pays to ask the same ~37 entries for a date the
  source does not carry. P6-34's "a filled field is no longer a gap" does not
  hold for a field the material genuinely lacks.
