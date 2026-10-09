import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { getFile, isBucketEnabled } from '../services/libraryBucket.js'
import { getCatalogEntry, getSavedView, searchCatalog, setViewWorkingSet } from '../services/libraryCatalog.js'
import {
  createWorkingSet,
  getWorkingSet,
  listWorkingSets,
  updateWorkingSet,
  workingSetMembers,
  type WorkingSet,
} from '../services/libraryWorkingSets.js'
import {
  MEMBER_KINDS,
  WORKING_SET_DATASETS_MAX,
  WORKING_SET_LAYERS_MAX,
  WORKING_SET_PURPOSE_MAX,
  describeWorkingSet,
} from '../services/workingSetMeta.js'
import {
  derivedColumnKey,
  readDerivedColumns,
  readDerivedValues,
  analysisKeyOf,
  resolveDerivedColumn,
  type DerivedColumn,
} from '../services/workingSetColumns.js'
import { checkAnalysisInputs, type Freshness } from '../services/analysisInputs.js'
import {
  ProximityError,
  listWorkingSetProximity,
  runWorkingSetProximity,
} from '../services/workingSetProximity.js'
import {
  CompositeError,
  listWorkingSetComposites,
  runWorkingSetComposite,
} from '../services/workingSetComposite.js'
import { PublicLayerError } from '../services/publicLayerValues.js'
import { INTERNAL_LAYER_ID_PREFIX, listInternalLayers } from '../services/internalLayers.js'
import publicLayerRegistry from '../prompt/publicLayers.generated.json' with { type: 'json' }
import siteLayerRegistry from '../prompt/siteLayers.generated.json' with { type: 'json' }

/**
 * Working sets API (P7-1).
 *
 * A working set is the compound data object an analysis runs against — the
 * datasets in it, the sites that anchor it, and (P7-5) the derived columns
 * written onto it. A **saved view presents** one; the pointer lives on the
 * view, in `routes/views.ts`.
 *
 * Unlike a saved view, a set's payload is **not** opaque here. A view's state
 * is the client's business because only the client restores it; a set's members
 * are slugs the SERVER dereferences — to scope a place report, to answer "which
 * sets is this dataset in?" — so a set that names something the library does not
 * have is a 400 at the moment somebody can still fix it, not a silent gap found
 * later by an analysis that came back short.
 *
 * Nothing here is backfilled. A view with no set is permanent and first-class
 * (ad-hoc, not legacy); `POST /api/working-sets/from-view/:slug` is the
 * deliberate promote action that is the only way a curated set comes into being
 * from an existing view.
 */

const router = Router()
router.use('/api/working-sets', requireInternalUser)

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const NAME_MAX = 200

/** Every layer id a set may name: the public registry, the five contamination
 *  overlays, and — read only when one is actually present — the held datasets
 *  that carry a layer block. Same rule and same reason as `parseCompareState`. */
async function knownLayerIds(asked: string[]): Promise<Set<string>> {
  const known = new Set<string>(publicLayerRegistry.map(l => l.id))
  for (const l of siteLayerRegistry) known.add(l.id)
  if (asked.some(id => id.startsWith(INTERNAL_LAYER_ID_PREFIX))) {
    for (const layer of await listInternalLayers()) known.add(layer.id)
  }
  return known
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every(v => typeof v === 'string') ? (value as string[]) : null
}

interface ParsedFields {
  purpose?: string
  datasets?: string[]
  layers?: string[]
  sites?: string | null
}

/**
 * Check the fields a set can carry, and refuse with a sentence rather than a
 * code. Only the keys the body actually names come back, so the same parser
 * serves a create (everything) and an edit (replace these, leave the rest).
 */
async function parseFields(body: Record<string, unknown>): Promise<{ error: string } | ParsedFields> {
  const out: ParsedFields = {}

  if (body.purpose !== undefined && body.purpose !== null) {
    if (typeof body.purpose !== 'string') return { error: 'What this set is for has to be a line of text.' }
    if (body.purpose.length > WORKING_SET_PURPOSE_MAX) {
      return { error: `What this set is for: at most ${WORKING_SET_PURPOSE_MAX} characters.` }
    }
    out.purpose = body.purpose
  }

  if (body.datasets !== undefined && body.datasets !== null) {
    const datasets = stringList(body.datasets)
    if (!datasets) return { error: 'datasets must be a list of catalog slugs.' }
    if (datasets.length > WORKING_SET_DATASETS_MAX) {
      return { error: `A working set holds at most ${WORKING_SET_DATASETS_MAX} datasets.` }
    }
    const bad = datasets.find(slug => !SLUG_RE.test(slug))
    if (bad !== undefined) return { error: `That is not a slug: ${bad}` }
    for (const slug of [...new Set(datasets)]) {
      const entry = await getCatalogEntry(slug)
      if (!entry) return { error: `There is nothing in the library called “${slug}”.` }
      if (!(MEMBER_KINDS as readonly string[]).includes(entry.kind)) {
        return { error: `“${slug}” is a ${entry.kind}, not a dataset or a source.` }
      }
    }
    out.datasets = datasets
  }

  if (body.layers !== undefined && body.layers !== null) {
    const layers = stringList(body.layers)
    if (!layers) return { error: 'layers must be a list of layer ids.' }
    if (layers.length > WORKING_SET_LAYERS_MAX) {
      return { error: `A working set holds at most ${WORKING_SET_LAYERS_MAX} layers.` }
    }
    const known = await knownLayerIds(layers)
    const bad = layers.find(id => !known.has(id))
    if (bad !== undefined) return { error: `There is no layer called “${bad}”.` }
    out.layers = layers
  }

  if (body.sites !== undefined) {
    if (body.sites === null || body.sites === '') out.sites = null
    else if (typeof body.sites !== 'string') return { error: 'sites must be the slug of a dataset we hold.' }
    else {
      const slug = body.sites.trim()
      if (!SLUG_RE.test(slug)) return { error: `That is not a slug: ${slug}` }
      const entry = await getCatalogEntry(slug)
      // The anchor is the thing the set is ABOUT, so it has to be a table we
      // actually hold — a source we only point at has no rows to anchor on.
      if (!entry || entry.kind !== 'dataset') {
        return { error: `The sites a set is anchored on have to be a dataset we hold; “${slug}” is not.` }
      }
      out.sites = slug
    }
  }

  return out
}

/** One row of the list: the set, its counts, and the views that present it. */
function setRow(set: WorkingSet, views: { slug: string; name: string; type: string }[]) {
  return {
    slug: set.slug,
    name: set.title,
    purpose: set.purpose,
    description: describeWorkingSet(set),
    datasets: set.datasets,
    layers: set.layers,
    sites: set.sites,
    /** P7-5's columns, counted rather than sent: a list row has no use for the
     *  values and a proximity column over 190,000 rows must never ride in one. */
    derivedCount: Array.isArray(set.derived) ? set.derived.length : 0,
    savedBy: set.savedBy,
    savedAt: set.savedAt,
    updatedAt: set.updatedAt ?? '',
    ...(set.fromView ? { fromView: set.fromView } : {}),
    views,
  }
}

/** The views presenting each set, in one catalog query rather than one per
 *  set — this is what `meta.workingSet` on a view row is for. */
async function viewsBySet(): Promise<Map<string, { slug: string; name: string; type: string }[]>> {
  const out = new Map<string, { slug: string; name: string; type: string }[]>()
  for (const row of await searchCatalog({ kind: 'view' })) {
    const set = typeof row.meta.workingSet === 'string' ? row.meta.workingSet : ''
    if (!set) continue
    const list = out.get(set) ?? []
    list.push({ slug: row.slug, name: row.title, type: typeof row.meta.type === 'string' ? row.meta.type : 'map' })
    out.set(set, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

function unavailable(res: any): boolean {
  if (isLibraryEnabled() && isBucketEnabled()) return false
  res.status(503).json({ error: 'library unavailable' })
  return true
}

router.get('/api/working-sets', async (_req, res) => {
  if (unavailable(res)) return
  try {
    const [sets, views] = await Promise.all([listWorkingSets(), viewsBySet()])
    res.json({ sets: sets.map(set => setRow(set, views.get(set.slug) ?? [])) })
  } catch (err: any) {
    console.error('[working-sets] list failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * One set, with its members resolved.
 *
 * `missing` is the half that matters: a member can be archived or renamed out
 * from under a set, and the honest reading of that is "this set names something
 * the library no longer has" — never a silently shorter set (P6-23's rule, that
 * a count may not disagree with the list it opens).
 */
router.get('/api/working-sets/:slug', async (req, res) => {
  if (unavailable(res)) return
  try {
    const set = await getWorkingSet(req.params.slug)
    if (!set) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const [{ entries, missing }, views] = await Promise.all([workingSetMembers(set), viewsBySet()])
    res.json({
      ...setRow(set, views.get(set.slug) ?? []),
      members: entries.map(e => ({
        slug: e.slug,
        kind: e.kind,
        title: e.title,
        status: e.status,
        ...(e.readiness ? { readiness: e.readiness } : {}),
      })),
      missing,
    })
  } catch (err: any) {
    console.error('[working-sets] read failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * A set's derived columns, with their values — the ONE read both interfaces
 * share (P7-2).
 *
 * The whole point of the two objects being two objects is that a derived column
 * belongs to the SET and never to a view, so every view of it sees the same
 * number (spec §F.1). That only holds if there is one place to read it from.
 * This is that place: the map interface and the data interface of
 * `/views/:slug` each read it from here, once, and then share the result — the
 * map narrows to the counties it covers, the table sorts by it, and neither has
 * computed anything.
 *
 * Unlike the list and detail routes, which COUNT the columns rather than
 * sending them, this one sends the values, because sending them is what it is
 * for. Both storage shapes resolve here — inline on the manifest, or a file
 * beside it (the layout P7-1's directory exists to allow) — so P7-5 can write a
 * 190,000-row proximity column without anybody needing a second read surface.
 *
 * A column whose file cannot be read is REPORTED, never dropped: it comes back
 * with 0 rows and its id in `unreadable`, the same shape as `missing` on the
 * detail route, because "this set has a column we cannot open" is a thing to go
 * and fix (P6-23).
 *
 * **This route is where "stored, not recomputed" is actually spent (P7-6).**
 * Every reader of a derived number — the map pane, the explorer's table, the
 * CSV it exports — comes through here, and it computes nothing: it reads the
 * stored values and adds a verdict on whether the inputs they came from still
 * hold. So a page that draws a 190,000-row proximity column costs one manifest
 * read and two fingerprint comparisons, not a measurement. A stale column
 * comes back WITH its values and a sentence saying what moved, plus the
 * arguments a re-run would take; it is never hidden and never silently
 * refreshed, because a reader who cannot see the caveat cannot act on it.
 */
router.get('/api/working-sets/:slug/columns', async (req, res) => {
  if (unavailable(res)) return
  try {
    const set = await getWorkingSet(req.params.slug)
    if (!set) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const columns: DerivedColumn[] = []
    const unreadable: string[] = []
    // P7-6: a run writes TWO columns off one analysis — the distance and the
    // count — and they name the same two inputs, so checking per column would
    // ask the same question twice. Keyed on the record's own stamp, which is
    // what makes two columns one run.
    const checked = new Map<string, Freshness>()
    const freshnessFor = async (analysis: Record<string, unknown> | undefined): Promise<Freshness> => {
      // P7-8 moved the key into `analysisKeyOf`: a composite has no `from` or
      // `to`, so the old spelling collapsed every index written in the same
      // millisecond onto one key.
      const key = analysisKeyOf(analysis)
      if (key && checked.has(key)) return checked.get(key)!
      const freshness = await checkAnalysisInputs(analysis?.inputs)
      if (key) checked.set(key, freshness)
      return freshness
    }

    for (const doc of readDerivedColumns(set.derived)) {
      const freshness = await freshnessFor(doc.analysis)
      if (doc.file) {
        const key = doc.file ? derivedColumnKey(set.slug, doc.file) : null
        if (!key) {
          unreadable.push(doc.id)
          columns.push(resolveDerivedColumn(doc, {}, '', freshness, set.slug))
          continue
        }
        try {
          const buffer = await getFile(key)
          columns.push(
            resolveDerivedColumn(doc, readDerivedValues(JSON.parse(buffer.toString('utf8'))), key, freshness, set.slug),
          )
        } catch {
          unreadable.push(doc.id)
          columns.push(resolveDerivedColumn(doc, {}, key, freshness, set.slug))
        }
        continue
      }
      columns.push(resolveDerivedColumn(doc, readDerivedValues(doc.values), 'manifest', freshness, set.slug))
    }
    res.json({ slug: set.slug, name: set.title, columns, unreadable })
  } catch (err: any) {
    console.error('[working-sets] columns failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Measure proximity between two of a set's layers (P7-5, spec §F.2).
 *
 * The on-demand tier. For each row of dataset A, the miles to the nearest
 * feature of layer B, and optionally a count of B within *n* miles — written
 * back as a derived column on the set, where `GET …/columns` already serves it
 * to both of P7-2's interfaces. **Neither source dataset is touched.**
 *
 * Server-side for the spec's three reasons: the number must be stable and
 * citable because a story quotes it, it joins datasets the browser does not
 * hold, and chat/MCP has to be able to ask for it.
 *
 * **A 413 is the ceiling, and it is the interesting response.** §F.4b: the
 * cardinality decides where an analysis runs, not the operation, so this
 * refuses a whole-layer derivation with a sentence naming the local pass
 * rather than tying up the single instance for minutes — see
 * `PROXIMITY_SEGMENT_BUDGET` for why two seconds is the number that matters.
 */
router.post('/api/working-sets/:slug/proximity', async (req, res) => {
  if (unavailable(res)) return
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const user = res.locals.internalUser
    const run = await runWorkingSetProximity({
      set: req.params.slug,
      from: typeof body.from === 'string' ? body.from : undefined,
      to: typeof body.to === 'string' ? body.to : '',
      within: (body.within ?? null) as number | string | null,
      id: typeof body.id === 'string' ? body.id : undefined,
      recompute: body.recompute === true,
      by: user?.username ?? 'unknown',
      byId: user?.id ?? null,
    })
    // A served result is not an event: nothing was computed and nothing was
    // written, so there is nothing to put in the audit log.
    if (run.served === 'computed') {
      void writeAudit({
        userId: user?.id ?? null,
        actor: user?.username ?? 'unknown',
        action: 'workingset.proximity',
        target: run.set,
        detail: {
          from: run.from,
          to: run.to,
          within: run.within,
          columns: run.columns.map(c => c.id),
          rows: run.stats.rows,
          measured: run.stats.measured,
          targets: run.stats.targets,
          // P7-6: why it computed rather than serving. A log of measurements
          // that cannot say which ones were forced by a changed input cannot
          // answer "is this set's data churning?", which is the question an
          // owner watching compute would actually ask.
          ...(run.staleNote ? { recomputedBecause: run.staleNote } : {}),
        },
      })
    }
    res.json(run)
  } catch (err: any) {
    if (err instanceof ProximityError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    // The tabular reader's own refusals are already sentences with statuses —
    // a layer past its vertex cap, a file too big to parse — and reworded here
    // they would only become vaguer.
    if (err?.name === 'TabularError' && typeof err.status === 'number') {
      res.status(err.status).json({ error: err.message })
      return
    }
    console.error('[working-sets] proximity failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** The proximity analyses a set carries, with their per-row numbers — the read
 *  side of what the POST wrote, so a number a story quotes about one site
 *  survives the response that computed it. */
router.get('/api/working-sets/:slug/proximity', async (req, res) => {
  if (unavailable(res)) return
  try {
    const set = await getWorkingSet(req.params.slug)
    if (!set) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ slug: set.slug, analyses: await listWorkingSetProximity(set.slug) })
  } catch (err: any) {
    console.error('[working-sets] proximity list failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Build a weighted index over the set's layers (P7-8, spec §F.3).
 *
 * The second analysis type, and the one that lets a story cite a number it
 * invented: *"use class and race based indicators to come up with a political
 * efficacy layer"*. The result is one derived column on the set — so the table
 * sorts it and the map draws it with no second read surface — and, because a
 * composite declares which end of its scale is good, it is also listed in the
 * internal layer manifest and drawn as a county choropleth like any other
 * layer.
 *
 * Serving a stored result is the default, exactly as P7-6 made it for
 * proximity: an unchanged formula over unchanged inputs costs one manifest
 * read. The ceiling here is **pre-flight** — the bytes of the files the terms
 * would parse, read off the catalog with nothing opened — so a refusal costs
 * no parse at all.
 */
router.post('/api/working-sets/:slug/composite', async (req, res) => {
  if (unavailable(res)) return
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const user = res.locals.internalUser
    const run = await runWorkingSetComposite({
      set: req.params.slug,
      label: typeof body.label === 'string' ? body.label : '',
      terms: body.terms,
      id: typeof body.id === 'string' ? body.id : undefined,
      // P9-4: the missing-data rule is part of the definition, so it has to
      // cross the wire. Validated in the service, which owns the vocabulary.
      missing: typeof body.missing === 'string' ? body.missing : undefined,
      recompute: body.recompute === true,
      by: user?.username ?? 'unknown',
      byId: user?.id ?? null,
    })
    // A served result is not an event: nothing was computed and nothing was
    // written, so there is nothing to put in the audit log.
    if (run.served === 'computed') {
      void writeAudit({
        userId: user?.id ?? null,
        actor: user?.username ?? 'unknown',
        action: 'workingset.composite',
        target: run.set,
        detail: {
          column: run.column,
          label: run.label,
          // The formula itself, so the log answers "what was this index" and
          // not only "an index was built".
          terms: run.terms.map(t => `${t.layer}:${t.weight}:${t.direction}`),
          counties: run.counties,
          complete: run.complete,
          ...(run.staleNote ? { recomputedBecause: run.staleNote } : {}),
        },
      })
    }
    res.json(run)
  } catch (err: any) {
    if (err instanceof CompositeError || err instanceof PublicLayerError) {
      res.status(err instanceof CompositeError ? err.status : 400).json({ error: err.message })
      return
    }
    // The tabular reader's own refusals are already sentences with statuses,
    // and reworded here they would only become vaguer.
    if (err?.name === 'TabularError' && typeof err.status === 'number') {
      res.status(err.status).json({ error: err.message })
      return
    }
    console.error('[working-sets] composite failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** The indices a set carries, each with its saved formula, the scale each term
 *  was normalised against, and its standing. The read side of what the POST
 *  wrote: a story that quotes an index needs to be able to say what went into
 *  it, and `method` is one line where this is the whole record. */
router.get('/api/working-sets/:slug/composite', async (req, res) => {
  if (unavailable(res)) return
  try {
    const set = await getWorkingSet(req.params.slug)
    if (!set) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ slug: set.slug, indices: await listWorkingSetComposites(set.slug) })
  } catch (err: any) {
    console.error('[working-sets] composite list failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/api/working-sets', async (req, res) => {
  if (unavailable(res)) return
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      res.status(400).json({ error: 'A working set needs a name.' })
      return
    }
    if (name.length > NAME_MAX) {
      res.status(400).json({ error: `A name is at most ${NAME_MAX} characters.` })
      return
    }
    const fields = await parseFields(body)
    if ('error' in fields) {
      res.status(400).json({ error: fields.error })
      return
    }
    const user = res.locals.internalUser
    const made = await createWorkingSet({
      name,
      ...fields,
      savedBy: user?.username ?? 'unknown',
      savedById: user?.id ?? null,
    })
    if (made.error === 'bad-name') {
      res.status(400).json({ error: 'The name needs at least one letter or number.' })
      return
    }
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'workingset.create',
      target: made.slug,
      detail: { name: made.name, datasets: fields.datasets?.length ?? 0, layers: fields.layers?.length ?? 0 },
    })
    res.status(201).json({ slug: made.slug, name: made.name })
  } catch (err: any) {
    console.error('[working-sets] create failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Edit a set: replace the fields the body names, leave the rest.
 *
 * This is how "9 of 11 ingested" ever becomes 11 of 11 — a set grows as
 * sourcing does, which is why it is a mutable object and a saved view is not.
 * `derived` is never reachable from here: P7-5 writes those, and an edit that
 * dropped them would discard an analysis somebody is already quoting.
 */
router.put('/api/working-sets/:slug', async (req, res) => {
  if (unavailable(res)) return
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = body.name === undefined ? undefined : typeof body.name === 'string' ? body.name.trim() : ''
    if (name !== undefined && !name) {
      res.status(400).json({ error: 'A working set needs a name.' })
      return
    }
    if (name !== undefined && name.length > NAME_MAX) {
      res.status(400).json({ error: `A name is at most ${NAME_MAX} characters.` })
      return
    }
    const fields = await parseFields(body)
    if ('error' in fields) {
      res.status(400).json({ error: fields.error })
      return
    }
    const updated = await updateWorkingSet(req.params.slug, { ...(name ? { name } : {}), ...fields })
    if (!updated) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const user = res.locals.internalUser
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'workingset.update',
      target: updated.slug,
      detail: { datasets: updated.datasets.length, layers: updated.layers.length, sites: updated.sites },
    })
    const views = await viewsBySet()
    res.json(setRow(updated, views.get(updated.slug) ?? []))
  } catch (err: any) {
    console.error('[working-sets] update failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * "Make a working set from this view" — the promote action (P7-1, spec §F.1).
 *
 * The only way a curated set comes into being from a view, and deliberately
 * NOT a migration. What it can honestly take from a view is the layers the view
 * draws; a table view also names a real dataset, and an internal layer id names
 * a held dataset, so both become members. Everything else a view stores is
 * framing — weights, filters, a viewport, a prompt — and framing is exactly
 * what a working set does not hold.
 *
 * **The set it makes is a starting point, not a finished one.** That is the
 * whole argument against backfilling: auto-built from a view's layer list, a
 * set is one to three registry layers with no sites and no sources — it
 * satisfies the schema and means nothing. Done deliberately, by somebody who
 * decided this view matters, it is the first step of curation instead, and the
 * response says what it took so the next step is obvious.
 */
router.post('/api/working-sets/from-view/:slug', async (req, res) => {
  if (unavailable(res)) return
  try {
    const viewSlug = req.params.slug
    const view = await getSavedView(viewSlug)
    if (!view) {
      res.status(404).json({ error: 'There is no saved view with that name.' })
      return
    }
    if (view.workingSet) {
      // Not an error worth hiding: a second set made from the same view would
      // leave two objects claiming the same thing, which is the mess §F.1's
      // second argument is about.
      res.status(409).json({ error: 'That view already presents a working set.', workingSet: view.workingSet })
      return
    }

    const row = await getCatalogEntry(viewSlug)
    // `meta.layers` is the union savedViewMeta already computes: scoring
    // layers, point layers and the contamination overlays. One field, so the
    // promote and the "views using this layer" list cannot disagree.
    const layers = (Array.isArray(row?.meta.layers) ? row!.meta.layers : []).filter(
      (id): id is string => typeof id === 'string' && !!id,
    )
    const datasets: string[] = []
    const state = view.state as Record<string, unknown>
    if (view.type === 'table' && typeof state.dataset === 'string' && state.dataset) datasets.push(state.dataset)
    // An internal layer IS a held dataset with a layer block, so a view that
    // draws one names a real member rather than only a layer id.
    for (const id of layers) {
      if (!id.startsWith(INTERNAL_LAYER_ID_PREFIX)) continue
      const slug = id.slice(INTERNAL_LAYER_ID_PREFIX.length)
      const entry = await getCatalogEntry(slug)
      if (entry?.kind === 'dataset' && !datasets.includes(slug)) datasets.push(slug)
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, NAME_MAX) : view.name
    const purpose = typeof body.purpose === 'string' ? body.purpose.slice(0, WORKING_SET_PURPOSE_MAX) : ''

    const user = res.locals.internalUser
    const made = await createWorkingSet({
      name,
      purpose,
      datasets,
      layers,
      fromView: viewSlug,
      savedBy: user?.username ?? 'unknown',
      savedById: user?.id ?? null,
    })
    if (made.error === 'bad-name') {
      res.status(400).json({ error: 'The name needs at least one letter or number.' })
      return
    }
    const pointed = await setViewWorkingSet(viewSlug, made.slug)
    if (pointed.error) {
      res.status(404).json({ error: 'There is no saved view with that name.' })
      return
    }
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'workingset.promote',
      target: made.slug,
      detail: { fromView: viewSlug, datasets: datasets.length, layers: layers.length },
    })
    res.status(201).json({
      slug: made.slug,
      name: made.name,
      fromView: viewSlug,
      // What it took, named: a promoted set is a starting point and the caller
      // has to be able to say so rather than implying the set is complete.
      took: { datasets, layers },
    })
  } catch (err: any) {
    console.error('[working-sets] promote failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
