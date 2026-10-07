# UX audit — phase 6 and 7, as shipped

2026-10-07. Walked the live surfaces logged in as an admin against a 97-entry
library with one working set, one saved view and twelve internal layers.
Screenshots in `/Users/mac/Desktop/BLO/ux-0*.png`.

Findings are ordered by **what they cost a person trying to do the work**, not
by which ticket shipped them.

---

## The summary

Phase 6 and 7 built a great deal of machinery, and most of it is sound. What
the walkthrough shows is that **the machinery has outrun its surfaces.** Two of
the flagship capabilities have no UI at all; the central phase-7 object renders
a map with none of its own layers on it; and across the library the loudest
thing on every screen is what is *missing* rather than what is *there*.

The through-line: **the system is built to be correct, and it is showing the
reader its correctness work instead of its content.** Verification gaps,
derivation vocabulary, readiness strings and raw manifest fragments are all
front-and-centre, while the data they describe is behind a link or absent.

---

## 1. Blocking — a working set's map draws none of its layers

`/views/redevelopment-dashboard-2` · `ux-05-workspace.png`

The set declares **six layers** — transmission lines, interstate gas pipelines,
power plants, coal mines, redevelopment sites, CEJST burden. The Map tab draws
**none of them**. What renders is the public red/green county choropleth, with:

- **no legend** (`[class*=legend]` finds nothing) — so the colours are unreadable
- **no layer named anywhere on the page** (checked all six; only the word "CEJST"
  appears, and only inside the purpose sentence)
- **no fit to the set** — "9 counties from 11 rows" sits above a national view

This is the central deliverable of phase 7. A working set exists so that a
person can see their data together; the one screen built for that shows
everything except their data.

**Direction.** The set's layers should be on by default, listed, and legended —
and the viewport should fit them. If the public scoring choropleth is meant to
be context underneath, it needs to say so and be dismissible. Until then a
reader cannot tell the page is working at all.

---

## 2. Blocking — proximity and the weighted index have no UI

`/analysis` · `ux-04-analysis.png`

The page reads *"The four things you can run over what the library holds"* and
offers: Check a place, Compare, Explore a dataset, Show on map. A full-text
scan finds **no mention of proximity, weighted index or composite** anywhere on
the page.

So P7-5 (great-circle proximity between two layers) and P7-8 (savable composite
index — the workbook's political-efficacy layer) are reachable only by API or
CLI. The two capabilities phase 7 was *for* are invisible to anyone using the
product.

**Direction.** They belong in that grid, set-scoped. They also need to be
honest about where they run: national transmission proximity exceeds the API
ceiling by design and must go to the CLI, which is a real constraint a UI
should explain rather than hide behind a failed request.

---

## 3. Serious — raw JSON is rendered at the reader

`/library/transmission-345kv` · `ux-03-entry.png`

The Overview tab prints:

```
meta   {"description":"High-voltage transmission backbone: every line HIFLD
       classifies at 345 kV or above, 3,477 of 94,619 national lines…",
       "whatItAnswers":"Answers: where the high-voltage transmission backbone
       runs, and how far a site is from it."}
```

Two separate defects, and the first is mine:

1. **A data error.** Nine manifests I staged nest `description` and
   `whatItAnswers` inside a `meta` key. Hand-written entries (`msha-mines`) put
   them at top level. So the page shows *"Answers: nothing could fill this"*
   at the top **while the answer sits in the JSON blob below it.**
2. **A resilience failure.** An unrecognised manifest key is dumped verbatim to
   a reader. A library of hand-editable manifests will always contain keys the
   page does not know; rendering them as JSON teaches people that the page is
   broken.

**Direction.** Fix the nine manifests. Separately, the entry page should never
print raw JSON: show known fields, and put anything else behind a "manifest"
disclosure for the one person who wants it.

---

## 4. Serious — the interface is louder about gaps than about content

Every dataset card on `/datasets` carries, in warning colour:

> *answers unverified · no period covered · no published date*

And `/kb`'s attention panel reads **"66 — Needs a look"** against a 97-entry
library. **Two thirds of the library is flagged.**

Each flag is individually correct. Together they are alarm fatigue: a queue
containing 68% of everything is not a queue, it is the background. And a card
whose most prominent element is an absence trains people to stop reading the
absences — including the ones that matter.

This is the predictable consequence of a design decision that was otherwise
right: P6-34's apply-then-verify deliberately fills fields and queues them. The
flaw is not the queuing, it is that **queued-for-review is being rendered with
the visual weight of an error.**

**Direction.** Three changes, cheapest first:
- Make the gap line quiet by default — it is a backlog, not a fault. Reserve
  warning colour for things that are *wrong*, not merely *unconfirmed*.
- Show what the entry **does** have on the card — its dates, its coverage, its
  answer line — and show gaps only where a reader would otherwise be misled.
- Split "needs a look" by *why*. 66 undifferentiated items is unworkable; "12
  datasets with no period covered" is a morning's work.

And a related finding already ticketed as P8-4: a date field that the source
genuinely does not carry will never drain, so a queue built on it grows
forever. Some gaps need a **recorded decline**, not a permanent flag.

---

## 5. Serious — "nothing could fill this", three times, above the content

Every entry page opens with:

```
Organization   nothing could fill this   [Edit]
Answers        nothing could fill this   [Edit]
Published      nothing could fill this   [Edit]
Ready as: a table we hold · Place report: never · text extracted from 0 of 1 file
```

Before the title's meaning, the data, or anything a reader came for, there are
three declarations of failure and a line of internal vocabulary.

- *"nothing could fill this"* is the system describing its own effort, not the
  entry's state. The reader's question is "is there an organization?" — the
  answer is "no", and the machinery that tried is not their concern.
- *"Place report: never"* reads as a fault; it means a report has not been run,
  which is neither good nor bad.
- *"text extracted from 0 of 1 file"* is pipeline telemetry.

**Direction.** Move provenance and readiness below the content, or behind a
disclosure. Lead with what the entry *is*. Keep the Edit affordances — they are
good — but attached to a quiet "add organization" rather than a report of
failure.

---

## 6. Moderate — the working set is styled as a footnote

On `/analysis`, the four analysis tools get cards with borders and buttons. The
**working set** — the newest and most important object in the system — gets:

```
Redevelopment dashboard  (4 of 4 held)
The eleven threat sites against energy infrastructure…
One view: Redevelopment dashboard
Check a place in this set  ·  Its datasets
```

Plain text and two small links, below the fold, under a heading. The visual
hierarchy says the set matters less than "Compare".

**Direction.** A set is a *place you go*, like a project. Give it card weight,
its member count, its views, and a primary action that opens it.

---

## 7. Moderate — two competing chronologies, both misleading

`/kb` shows **"Recently edited"** (1 item) and, separately, **"Most recent
items"** (5 datasets, all "2h ago"). A reader cannot tell what distinguishes
them, and the second is not an edit history at all: those five are "2h ago"
because a CLI push reindexed them. Nobody edited anything.

This is the `updatedAt` trap the code already warns about at
`libraryCatalog.ts:124` — *"that says when the BYTES last moved"* — surfaced as
if it were editorial history.

**Direction.** One chronology, built on a real `editedAt` written only by human
edits (P8-4). If reindex time is worth showing, label it as what it is.

---

## 8. Moderate — the counts do not reconcile

`/kb` tiles: **69 Datasets · 38 Docs · 12 Analysis** = 119, against 97 catalog
entries. `/datasets` chips: **Held 14 · Indexed 40 · Map layers 27** = 81, while
the working-set row reads **4 + 65 = 69**.

Every number is defensible — they count overlapping things — but a person
reading two screens gets three different sizes for the same library and no way
to reconcile them.

**Direction.** Say what is being counted ("69 tables, sources and layers"), and
make the same noun mean the same thing on both screens.

---

## 9. Moderate — six rows of filter chips before any content

`/datasets` spends roughly **320px** — a third of the first screen — on Group
by, scope, publisher, topic, type, geography and working-set rows, before the
first result.

The folding (`+17 more`, `+24 more`) and the always-visible active chip are
genuinely good work (P6-22, P6-26). The problem is that **all six rows are
expanded at once, always**, with no labels except the leading reset chip. A
reader must infer that "All publishers" heads the publisher row.

**Direction.** Collapse to the two or three facets with discriminating power
for the current result set, label the rows, and put the rest behind "More
filters". The counts are the valuable part and they survive collapsing.

---

## 10. Moderate — a line layer is labelled "Records without a location"

`transmission-345kv` has 3,477 LineString features and its catalog row says
`shape: records`. The entry page therefore chips it as **"Records without a
location"**.

P6-2's shape derivation is reading a GeoJSON layer as rows with no coordinates —
plausibly because the file synthesises `_path` rather than lat/lng columns. The
same will be true of every line layer we ingest.

**Direction.** Derive shape from the layer block's geometry when there is one;
a manifest that declares `geometry: line` has already answered the question.

---

## 11. Minor — naming drifts across the same surface

- Header says **BLO Knowledge base**; nav says **Library**; the page title
  says **Library**.
- The workspace reads **"Redevelopment dashboard / Over Redevelopment
  dashboard"** — circular, because the set and its view share a name, which is
  the slug collision from P8-1 seen from the other side.
- Two "Start" buttons carry italic disclaimers that they do not do the thing:
  *"Opens the datasets browser — pick a table, then its Data tab."* A button
  that explains it is a signpost should be a link.

---

## What is working, and should not be lost

Worth naming, because a list of problems misrepresents the whole:

- **The nav plane (P6-13) is right.** Map · About · Library above, and
  Datasets · Docs · Analysis │ Search · Chat · New within Library. The
  distinction Nick asked for holds up in use.
- **No horizontal overflow at 375px.** Verified: `scrollWidth` equals viewport;
  the nav scrolls inside itself. The P6-13 fix is holding.
- **"Data from 2024" (P7-10) is exactly right** — quiet, one line, under the
  title, and absent rather than apologetic when unknown. It is the model the
  rest of the metadata should follow.
- **Facet counts with folding** are better than most library UIs manage.
- **The getting-started checklist self-ticks** from real activity rather than
  being dismissed — a genuinely good pattern.
- **Attention counts link to the list they count** (P6-23's invariant), so the
  numbers can be trusted even when there are too many of them.

---

## If only three things get fixed

1. **Draw the set's layers on the set's map** (§1). Without it phase 7 has no
   visible product.
2. **Put proximity and the index on `/analysis`** (§2). Two shipped capabilities
   currently reachable only by CLI.
3. **Turn down the volume on gaps** (§4, §5). Nothing else changes how the
   library *feels* as much, and it costs the least.

§3's raw JSON is a one-line fix plus nine manifest corrections and should ride
along with any of them.
