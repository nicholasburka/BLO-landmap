# Adding data, and shipping it

Written 2026-10-06 after a cutover that went badly in four separate ways. Every
rule below is here because something broke, and the cost is named so the rule
is arguable rather than cargo-culted.

Companion docs: `DEPLOY.md` (infrastructure), `GIT-HISTORY.md` (rewrites).

---

## 0. The one fact that changes everything

**There is ONE bucket.** `blo-library` is shared by local dev and production.
There is no staging bucket.

So `npm run library -- push` from a laptop **is a production data change.** It
is not a local test. Treat every push the way you would treat a deploy.

What saves you: B2 has default-on versioning, so every overwrite keeps the
prior version. Nothing is unrecoverable. But "recoverable" is not "harmless" —
see §2.

The local stack, by contrast, has **no database** unless you give it one.
Without `DATABASE_URL`, the server logs *"library features disabled, public map
unaffected"* and you get the public map only — no catalog, no layers, no
working sets, no login. A local Postgres also needs SSL off; the pool asks for
SSL and a stock local server refuses, which surfaces as
*"The server does not support SSL connections"*.

---

## 1. Before any push: run `status` and READ it

```bash
cd server
npm run library -- status --dir <tree>
```

`status` is read-only and prints exactly what `push` would do, in four
sections: **Changed (size differs)**, **Local only**, **Remote only**,
**Remote strays**.

**`push --dir X` pushes the ENTIRE tree under `X/library` — not just the part
you were thinking about.** This is the mistake that cost the most today:
`--dir` was pointed at `library-staging/push`, believed to hold nine new
datasets. It was a stale **218-file full library tree** from weeks earlier. The
push uploaded 68 files: the 18 intended, plus **50 that overwrote that
morning's metadata work** — stripping `whatItAnswers`, `dates` and
`provenance` from 48 manifests and reverting two wiki pages.

`status` listed all 50 under "Changed". They were on screen and went unread.

**Rule: if "Changed" contains anything you did not deliberately edit, stop.**
A push that adds files shows them under "Local only". "Changed" means you are
overwriting something that already exists, and that is where the damage lives.

---

## 2. Pushing new data: build a tree that contains only what you are adding

Do not push a mirror, and do not push a tree that accumulated history. Stage a
clean tree holding exactly the entries you mean to publish:

```
<staging>/library/datasets/<slug>/meta.json
<staging>/library/datasets/<slug>/<file>.csv|.geojson
```

The local mirror (`server/library-data/library`) is **not** a staging tree. It
also contains ~241 locally-generated files — `derived/` text extracts, place
reports, `place-index.json` — that have no business in the bucket.

### Recovering from a bad push

The mirror holds the pre-push state (it syncs from the bucket at boot, so it
predates your mistake). So:

1. `status --dir server/library-data` to list what differs.
2. Extract just the "Changed" paths and copy those files from the mirror into a
   **minimal restore tree** — only those paths, nothing else.
3. `push --dir <restore-tree>`.

This restores the clobbered bytes without publishing the mirror's derived
junk. Today that was 50 files, and it worked.

**Push is resumable.** The first restore attempt died mid-stream
(*"non-retryable streaming request"*) after 22 of 50 files. Re-running
uploaded the remaining 28 and skipped the 22 — unchanged files are skipped by
size, manifests by content. A failed push is never a reason to start over.

---

## 3. Turn remediation OFF before anything that restarts the server

```bash
# local: server/.env          prod: railway variables --set
LIBRARY_REMEDIATE=0
```

The dev server runs under `tsx watch`. **Every server-file save restarts it,
every restart reindexes, and reindex runs model remediation against the real
bucket.** An agent working on server code for three hours therefore wrote 49
entries and spent **~$2** that nobody chose to spend.

Worse, it is easy to leave armed: the flag gets parked during work and removed
at the end, so the *next* restart resumes spending.

Turn it off at the start of any session that touches server code. Turn it on
deliberately, watching it.

**It also produces wrong values that need review**, which is by design
(apply-then-verify) but still needs a human:
- `msha-mines` read `covers: 1970` from *"every mine recorded since 1970"* — a
  start year taken as the whole covered period.
- `regrid-parcels` read `published: 2026-10` from *"Updated: continuous, with
  ownership refreshed daily"* — a **cadence**, which explicitly says there is
  no single publication date.

**A date does not drain the way a prose field does.** `whatItAnswers` filled 40
of 45 gaps; `covers` filled 8 of 45 and `published` 7 of 45, because the
material simply does not say. A declined field stays a candidate, so **every
reindex pays to ask the same ~37 entries again**. The fix is a recorded
decline; until then, watch the spend on repeat reindexes.

---

## 4. What the layer pipeline will actually accept

Check these **before** downloading 186 MB of anything.

| Constraint | Value | Where |
|---|---|---|
| Geometries | `county`, `point`, `line`, `state` — **no polygon** | `LAYER_GEOMETRIES` |
| Max features | 20,000 | `LAYER_MAX_FEATURES` (`envInt`) |
| Max vertices | 500,000 | `LAYER_MAX_VERTICES` (`envInt`) |
| Layers per dataset | **one** (`meta.layer`, singular) | `parseLayerBlock` |
| Tabular formats | `csv`, `tsv`, `json`, `geojson` | `TABULAR_EXTENSIONS` |

**Polygons cannot be ingested.** Solar PV (6,611 polygons) and Superfund site
boundaries (2,114) are both blocked. Centroid-reducing them is the wrong fix
for both: a Superfund site's *boundary is the finding*, and a solar array's
area is its capacity.

**One dataset declares one layer, with one `valueKey`.** A 28-column county
table yields exactly one map layer; the other 27 columns are readable through
`/api/library/data/:slug/rows` but cannot be layers, nor terms in a weighted
index. This is the sharpest limitation on building composite analyses from rich
sources.

**Measure vertices exactly. Never extrapolate from an average.** Transmission
lines average 30.1 vertices/feature, which badly understates high-voltage
lines. Estimating "220 kV+ will fit" gave ~325,000; the real count was
**721,877** — 1.4× over the cap. The caps refuse on the real number.

```
345 kV+      3,477 features    331,344 vertices   fits
220 kV+     10,782 features    721,877 vertices   does NOT fit
national    94,619 features  2,852,404 vertices   analysis input only
```

**The caps bound what the API SHIPS, not what a batch pass can compute.** Both
are `envInt`, so a local CLI run can exceed them deliberately. Hold the full
national file for analysis and ingest a subset for display.

### Layer-block fields that are easy to miss

`LayerBlockCommon` requires **`name`, `description`, `source`, `year`** on every
block. Omit any and `parseLayerBlock` rejects the layer — and the symptom is an
**empty map with no error**, which is near-impossible to debug from the UI. The
dashboard's central dataset shipped this way and would not have drawn.

GeoJSON gets synthesised columns: **`_lat` / `_lng`** for points, **`_path`**
for lines. Use those as `latKey`/`lngKey`/`pathKey`.

Validate before pushing — required keys per geometry, and that `layer.file`
exists on disk.

---

## 5. Cleaning federal data: three traps

**Sentinels.** Federal sources write absence as a value: numeric `-999999`
(also `-99999`, `-9999`) and text `NOT AVAILABLE` / `UNKNOWN` / `N/A`. Blank
them **at staging**, so the file on disk is what the map draws.

> Transmission `VOLTAGE` carried `-999999` on **14,248 of 94,619 features
> (15%)**. Left alone, a seventh of the national grid reads as a real negative
> voltage in any filter or voltage-weighted analysis.

**Dates come in three spellings**, and a parser keyed on one silently drops the
others:
- **epoch milliseconds** (ArcGIS default) — transmission `SOURCEDATE`,
  Superfund `LAST_CHANGE_DATE`
- **bare integer year** — `p_year` 1985..2025 on solar and wind
- text

Also treat epoch 0, `1899-12-30` and `1970-01-01` as absent, not as real dates.

And read what a date *means*: Superfund's `ORIGINAL_CREATION_DATE` is when the
**GIS record** was created, not when the site was contaminated. A date can be
precise and answer a different question than the reader assumes.

**Reporting bias — the trap that silently produces a false map.** A dataset
aggregated from state programs is not a national census:

```
RE-Powering brownfields:  WI 33,779   MN 24,885   FL 21,328   NJ 15,655
                          ...   TN 421
```

Four states are 50% of the layer. **Wisconsin is not 80× more contaminated
than Tennessee — it reports more.** A choropleth of raw counts would conclude
the upper Midwest is the most poisoned part of the country and that Memphis is
nearly clean. Normalise (per capita, per sq mi, within-state) or restrict to
one program. Nothing in the file warns you.

**Blank is not zero.** CEJST's `HRS_ET` redlining flag is blank where no HOLC
map ever covered the tract — only ~200 cities were mapped, so **only 213 of
3,234 counties (7%)** have any scored tract. Counting blank as zero would
declare 93% of US counties free of redlining. Blank leaves the denominator, and
the denominator ships as its own column.

**Aggregate population-weighted.** Rolling tracts to counties by plain mean
gives a 40-person rural tract the same weight as a 6,000-person urban one.
Weight by tract population, and state the lost resolution in the manifest.

### Federal sources disappear

Two sources cited in the planning workbook no longer resolve at all:
`static-data-screeningtool.geoplatform.gov` (CEJST/Justice40) and
`maps.nccs.nasa.gov`. The HIFLD transmission layer is titled "(Archive)".

This is the argument for the bucket-first library rather than a nuisance. Hold
our own copy; never point a dashboard at a live federal endpoint.

When a source is gone, **look for an archive of the original before accepting a
substitute.** Esri preserved CEJST itself (`usa_november_2022`), which is
strictly better than swapping in EJScreen — same definitions, same thresholds,
no silent change in what the layer means. Record the substitution in
`meta.substitution` so a reader meets it, not just a committer.

`eersc.usgs.gov` serves an **expired TLS certificate**. Do not `curl -k`
provenance you intend to cite; find a mirror with a valid chain.

ArcGIS hosts 403 urllib's default user agent — send a real `User-Agent`.

---

## 6. Deploy order

**Set flags → restore/push data → merge → DEPLOY THE API → reindex.**

The API step is the one that gets forgotten, and it is invisible when you do:
**the `blo-map-api` Railway service has no GitHub connection**, so a merge to
`main` deploys the **frontend only**. On 2026-10-07 production was found running
API code from **2026-09-22** — two weeks and two phases behind the frontend —
because every merge since had only ever rebuilt Netlify.

```bash
cd server && railway up --service blo-map-api --detach   # from server/, not the root
railway status                                            # confirm a new deployment appeared
```

`railway up` honours neither `.gitignore` nor `.railwayignore`: from the repo
root it packs ~389 MB and Cloudflare 413s it. `server/` is ~6 MB. Details and
the 401-vs-404 trap are in `DEPLOY.md` → "Deploying the API is MANUAL".

1. **`LIBRARY_REMEDIATE=0` on Railway** before the API redeploys (§3).
2. **Push data and verify `status` is clean.** A deploy re-syncs prod's mirror
   from the bucket but does **not** reindex, so prod's catalog keeps its
   existing rows. **The first reindex after a bad push is what publishes the
   damage** — so the bucket must be right before anyone touches Reindex.
3. **Merge to `main`.** Netlify rebuilds the frontend; Railway rebuilds the API
   (Root Directory = `server`).
4. **Reindex in the app.** Data needs no build and no deploy — it is bucket
   content. Only code changes need a deploy.

Local `push` reindexes only when `DATABASE_URL` points at the API's Postgres.
From a laptop it usually does not, so it warns and you press Reindex.

### Railway

`railway run` executes **locally** with prod env injected, so
`postgres.railway.internal` does not resolve and any DB command fails. To run
against prod's database, run **inside** the container:

```bash
railway ssh --service blo-map-api
npm run users -- list
npm run users -- reset-password <username>
```

`reset-password` takes no password argument — it always generates 16 chars of
base64url and prints it once. There is no "set it to a known string" path short
of editing the CLI and deploying.

Two separate auth surfaces, easily confused:
- **site gate** — `POST /api/auth`, env `BETA_PASSWORD` / `STAGING_PASSWORD`
- **library login** — `POST /api/login`, a `library_users` row in Postgres

The beta gate alone does not reach datasets, layers or working sets.

---

## 7. Push protection: squash before you rewrite

GitHub scans the **whole ref**, so a secret committed and later redacted still
blocks the push.

**If HEAD is already clean, squash instead of rewriting.** The blocked branch
carried a third party's Mapbox token in a saved copy of their page (introduced
2026-09-06, redacted 2026-09-22) — so the blob existed only in intermediate
commits. One commit containing HEAD's tree has nothing to find:

```bash
git checkout -b prod-cutover origin/main
git merge --squash <branch>
# verify the staged tree is identical before committing:
#   git write-tree  ==  git rev-parse <branch>^{tree}
git commit
```

No `filter-repo`, no force-push, no rewriting published history. The full
commit-by-commit history stays on the original branch locally.

Confirm which locations GitHub flagged. It lists **all** of them; if HEAD were
carrying the secret it would say so.

**Never use GitHub's "allow this secret" link.** It permanently whitelists
publishing a credential — here, somebody else's. See `GIT-HISTORY.md` for the
rewrite path when a squash will not do.

---

## 8. Repo gotchas

**`grep` silently skips `server/src/services/libraryTabular.ts`.** It contains
4 deliberate NUL bytes as cache-key separators (`` `column\0${column}\0…` ``),
which is sound practice — NUL cannot appear in a column name, so the key is
unambiguous. But `file` reports the source as binary data and grep returns
nothing at all. Search it with `grep -a`.

Anyone grepping for `_lat`, `_path` or `FeatureCollection` gets zero hits and
concludes GeoJSON is unsupported. It is supported.

---

## Checklist

Adding a dataset:

- [ ] `LIBRARY_REMEDIATE=0` set if touching server code
- [ ] Geometry is county/point/line/state
- [ ] Features ≤ 20,000 and vertices ≤ 500,000, **counted not estimated**
- [ ] Layer block has `name`, `description`, `source`, `year`
- [ ] GeoJSON uses `_lat`/`_lng` or `_path`
- [ ] Sentinels blanked; subsets applied in the staged file itself
- [ ] Dates parsed for all three spellings; semantics checked
- [ ] Aggregations population-weighted; blank ≠ zero; denominators shipped
- [ ] Reporting bias assessed and documented
- [ ] Staging tree holds **only** the new entries
- [ ] `status` run and **"Changed" section read line by line**
- [ ] `push`, then verify `status` is clean
- [ ] Reindex

---

## 9. Working sets and saved views — two objects, not one

A **working set** is the compound data object: datasets + layers + derived
columns. A **saved view** is what *presents* it — framing and presentation.
Nick's framing: *"working set can be the noun that a saved view presents."*

**Creating a set is not enough to see anything.** `/views/<set-slug>` returns
*"There is no saved view called …"*, because a set is not a view. A view has to
point at the set through its optional `workingSet` field; `ViewRedirect` renders
`WorkingSetWorkspace` only when `view.workingSet` is present.

They also **share one slug namespace**, so a view named after its set gets `-2`.

### Three steps

```bash
# 1. the set — datasets are catalog slugs, layers are `internal-<slug>`
POST /api/working-sets
{ "name": "...", "purpose": "...",
  "datasets": ["redevelopment-sites","cejst-county-burden"],
  "layers": ["internal-redevelopment-sites","internal-transmission-345kv"] }
#    → { "slug": "redevelopment-dashboard" }

# 2. the view that presents it
POST /api/views
{ "name": "...", "type": "map", "workingSet": "redevelopment-dashboard",
  "results": [],
  "state": { "layers": [], "filters": [], "limit": null, "regionStates": [],
             "prompt": "", "viewport": { "center": [-90.05, 35.12], "zoom": 4.2 },
             "pointLayers": [{ "id": "internal-power-plants", "name": "Power plants" }] } }
#    → { "slug": "redevelopment-dashboard-2" }

# 3. open the VIEW's slug, never the set's
/views/redevelopment-dashboard-2
```

`state` is required and must be an object; `results` must be an array. `type` is
one of `map | table | compare`.

**The easier path is the other direction:** frame the map, save a view, then
`POST /api/working-sets/from-view/<view-slug>` promotes it. The UI is built
around this, and the framing already exists when you promote.

Verify the round trip — the set should list the view back:

```bash
GET /api/working-sets/<set-slug>     # → views: [{ slug, name, type }]
```

### `status = 'published'` gates every layer

```sql
SELECT ... FROM library_catalog WHERE status = 'published'
```

A `needs-review` dataset **never becomes a layer**, and reading layer values
404s on the same check. This is the review gate working: unreviewed data must
not draw.

So newly ingested data is invisible on the map until someone publishes it. For
**local testing only**, flip it in the local database:

```sql
UPDATE library_catalog SET status='published' WHERE slug IN (...);
```

That touches nothing shared — but a reindex re-reads manifests from the bucket
and reverts it. **Publishing for real means editing `status` in the manifests
and pushing, which is a production change (§0).**

### Routes take the bare slug, not the layer id

The manifest id is `internal-transmission-345kv`; the route is
`/api/layers/internal/transmission-345kv`. Passing the id gives a flat **404**
that looks exactly like the status gate above. Check the URL before chasing
permissions.

Observed payloads, for a sense of scale:

```
transmission-345kv            13.1 MB   0.97s
pipelines-natgas-interstate    6.8 MB   0.37s
power-plants                   4.7 MB   0.66s
coal-mines                   154 KB     0.02s
cejst-county-burden           41 KB     0.07s
redevelopment-sites          3.8 KB     0.005s
```

### Give the dev server headroom

Creating a set over six layers framed ~23 MB of GeoJSON at once and the server
child was **killed silently — no stack trace, no OOM line in the log.**

`tsx watch` does not restart a killed child; it waits for a file change. So the
process list shows something alive that is not serving, and the browser says
"couldn't reach the server". Check for the child, not the watcher:

```bash
pgrep -P <watcher-pid>        # empty = the server is gone
```

Start the dev API with headroom when working with large layers:

```bash
NODE_OPTIONS=--max-old-space-size=4096 npm run dev
```

---

## 10. Local development from scratch

**Local login works where production login does not** — both halves are on
`localhost` (cookies ignore port, so same-site) and `NODE_ENV` is unset, so the
cookie is `SameSite=Lax`. **A working local login proves nothing about
production** (§Cookies and the API hostname in `DEPLOY.md`).

Out of the box there is **no database**, so the server logs *"library features
disabled, public map unaffected"* and you get the public map only — no catalog,
no layers, no working sets, no login. Setting it up:

```bash
createdb blo_library

# server/.env — sslmode=disable is REQUIRED: the pool asks for TLS and a stock
# local Postgres refuses, which surfaces as
#   "init failed (The server does not support SSL connections)"
DATABASE_URL=postgresql://<you>@localhost:5432/blo_library?sslmode=disable
LIBRARY_REMEDIATE=0          # see §3 — do not let a restart spend money

cd server && NODE_OPTIONS=--max-old-space-size=4096 npm run dev
# boot applies the schema itself (CREATE TABLE IF NOT EXISTS) — 12 tables
```

`.env` is read at boot and `tsx watch` only watches `src/`, so **an `.env`
change needs a manual restart.**

Then an account and a catalog:

```bash
cd server
npm run users -- create <name> --role admin     # prompts twice for a password
# a weak password is fine HERE and only here — localhost, no exposure

# the catalog starts empty; reindex reads the mirror's manifests
# in the app: Library → Reindex, or POST /api/library/reindex
```

The frontend is a separate process — `npm run dev` from the **repo root** (Vite,
port 5173). `npm run demo` runs both. Killing the API does not kill Vite and
vice versa, so check both ports when something looks dead.

### Do not kill someone else's dev server

On 2026-10-06 I `pkill`ed a running `tsx watch` to make it pick up a new
`DATABASE_URL`, and pointed the restarted server at an empty database. That
broke a stack mid-demo. An `.env` change does need a restart — but it is the
owner's process and the owner's call. Ask.
