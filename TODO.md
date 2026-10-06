# TODO — phase 7 (branch `phase6-knowledge-base`, clean at `9f8f289`)

## Current Task
- [ ] **P7-11 — real suite isolation.** Opus subagent in flight. The bar is
      twenty consecutive clean full runs, because the failures pass four times
      in five and a single green run proves nothing.

## Needs Nick's call (from P7-10)
- [ ] **The dev stack wrote to the real library while P7-10 was being built.**
      `tsx watch` restarted it on every server save, every restart reindexed,
      and remediation ran unattended: **40 entries gained P7-7's
      `whatItAnswers`** (its own committed code, 19:42–19:51) and **9 gained
      P7-10 dates** (19:59–21:30). Roughly **$1.50–$2** of model spend. All of
      it is `model`, unverified, on the queue, one press of Clear each —
      nothing created, nothing overwritten. **Two readings are wrong and worth
      seeing**: `msha-mines` reads `covers 1970` off *"every mine recorded
      since 1970"* (a start year as the whole period), and `regrid-parcels`
      reads `published 2026-10` off a **cadence** sentence. Say the word and
      the nine go.
- [ ] **A declined field has to stop being a gap.** P7-10's measured finding:
      `whatItAnswers` drains (40 of 45), a date does not (8 of 45 `covers`, 7
      of 45 `published`) — the material simply does not say. A field the model
      declined stays a candidate, so **every reindex pays to ask the same 37
      entries again and gets the same silence**, ~37¢ a time, for ever. P6-34's
      "a filled field is no longer a gap, so the second pass spends nothing"
      does not hold for a field the model cannot answer. The fix is a recorded
      decline ("asked, and the material does not say"); it changes what
      `missingInferredFields` means for every inferred field, so it is its own
      ticket and should land before the next one does. `LIBRARY_REMEDIATE=0` is
      the switch meanwhile.

## The P7-11 diagnosis, corrected
`fileParallelism: false` **does not fix this** and is still in the tree. Serial
execution runs every file in the same worker, so `libraryBucket`'s `dataDir`
and `placeHttp`'s `recentBySource` leak *forward* between files as happily as
they leaked sideways. Ordering is not isolation.

Two reproducers, both **teardown races**, and the pattern in both is an
`onReindex` subscriber registered by one test still alive when a later test's
teardown runs — a registry that is never unsubscribed is module state too:
- `libraryCatalog.test.ts`'s P5-37 backlinks case, `ENOTEMPTY` from its own
  `afterEach`, about one run in five **of that file alone**. `textExtract`'s
  fire-and-forget `onReindex` writes into the dir the test is removing.
- `routes/mcp.test.ts`, same signature, seen once during P7-5.

## Completed this phase (10 of 11)
- [x] **P7-1** working sets: one object, bucket-first, reindex rebuilds an
      identical row.
- [x] **P7-2** two interfaces over the one set, GEOID-keyed, the reader
      refusing anything else rather than half-joining.
- [x] **P7-3** lines on the map.
- [x] **P7-4** `WikiMapBlock` — a map view inside a page, which is what makes a
      data story a story and not a screenshot.
- [x] **P7-5** proximity between two layers. One primitive serving both tiers,
      so a batch number and a request number cannot differ.
- [x] **P7-6** stored results that know when they are stale. Content-keyed, not
      clock-keyed. One store: the set's own manifest.
- [x] **P7-7** `meta.whatItAnswers` — the fix for Chat running all forty
      sources, since every filter it had was descriptive and none was about
      capability. Nothing detects a restated title: the rule lives in the
      prompt, and two tests assert that no heuristic guesses at it.
- [x] **P7-8** composite layers — the Lens generalised into a saved weighted
      index. Scale is the observed min-max, never a declared `range`, so a
      legend edit cannot move a published number. Terms sort before summing,
      because float addition is not associative and reproducibility has to hold
      to the last bit.
- [x] **P7-9** state geometry, dissolved from county polygons by edge
      cancellation.
- [x] **P7-10** `dates.covers` / `dates.published` / `dates.fetched` — two
      facts and one that is about us, because a *stale* date and an *old* date
      fail differently: ACS 2019-2023 ages into being historical, a 2019 list
      of data centres ages into being misleading. The stored value's own
      grammar decides whether a legend says "Data from 2019–2023" or "As of
      October 2026", so no second flag says which kind of dataset it is.
      `covers` is the first field to carry BOTH mechanisms, which is what
      P6-34's ordered array was built for — derived off a layer year or a
      table's own year column it never queues, read off a page by a model it
      always does. The map legend says it for one layer and per row for a
      composite, which is the case the ticket existed for; all 26 public
      registry layers got a date with nothing added to the registry, because a
      declared `year` already WAS the period the data describes.

## Standing, outside phase 7
- [ ] **Git push + prod cutover.** Parked by Nick: *"we can do the git stuff
      later once the work is completed."* Four commits unpushed. Read
      `docs/GIT-HISTORY.md` before touching history here — it exists because I
      broke it once.
- [ ] **Bulk precompute of proximity columns** over the real library. Blocked,
      and not on code: **no working set exists** in the real library, so there
      is nothing to compute *for*. Every phase-7 ticket has deliberately left
      that true, because there is still no delete route.
- [ ] **P5-29 — donor-site PII exposure.** Still live. Oldest real liability on
      the board.
- [ ] Phase 6 leftovers: P6-12 (bundle weight), the KbNav placement bullet,
      bulk Keep. P6-11 deferred by Nick as an unproductive distinction.
