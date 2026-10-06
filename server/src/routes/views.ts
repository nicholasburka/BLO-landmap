import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { isBucketEnabled } from '../services/libraryBucket.js'
import {
  createSavedView,
  getCatalogEntry,
  getSavedView,
  savedViewMeta,
  searchCatalog,
  setViewWorkingSet,
  VIEW_RESULTS_MAX,
} from '../services/libraryCatalog.js'
import { WORKING_SET_KIND } from '../services/workingSetMeta.js'
import { readDataset, parseRowsQuery, TabularError } from '../services/libraryTabular.js'
import { listInternalLayers } from '../services/internalLayers.js'
import publicLayerRegistry from '../prompt/publicLayers.generated.json' with { type: 'json' }
import siteLayerRegistry from '../prompt/siteLayers.generated.json' with { type: 'json' }

/**
 * Saved data views API (P5-16). A view is a named snapshot of map+query
 * state (library/views/<slug>.json) indexed as catalog kind 'view'.
 *
 * The server owns naming (slugify + collision suffix) and attribution
 * (savedBy/savedAt from the session); the `state` payload is opaque here —
 * the client is the only reader and restorer. Bodies ride the app-wide
 * express.json parser (64 kb), which comfortably fits the 100-row result cap.
 *
 * P5-54 adds `type: 'table'` — the explorer's dataset + search + filters +
 * sort + visible columns + optional summary chart. A table view is a RECIPE,
 * not a snapshot: opening it re-runs the query against today's data. That is
 * exactly why its state is the one thing here that is NOT opaque — it is
 * validated at save time with the rows route's own parser against the
 * columns the dataset really has, so a saved view cannot 400 when opened.
 * Documents with no `type` are map views (every file written before P5-54).
 *
 * P5-55 adds `type: 'compare'` — a shortlist of counties and the layers they
 * are being weighed on. Its state is validated here for the same reason a
 * table view's is: the page re-reads today's numbers when it opens, so the
 * document must name counties and layers that still resolve.
 *
 * P5-78 puts the first check on a MAP view's state: `siteLayers` (the
 * contamination overlays that were on) is the one field the server has to
 * understand, because it also writes the view's description. Everything else
 * about a map view is still the client's business.
 *
 * P7-1 adds ONE optional field beside `state`, not inside it: `workingSet`,
 * the set this view PRESENTS. Beside, because `state` is framing — layers with
 * weights, filters, a viewport — and a working set is the opposite of framing.
 * **Absent means ad-hoc**, which is permanent and first-class: every view
 * written before P7-1 keeps a null pointer and behaves exactly as it does
 * today, and nothing is backfilled. A view joins a set either at save time or
 * through `PUT /api/views/:slug/working-set`, which is also how a SECOND view
 * comes to present a set that already exists.
 */

const router = Router()
router.use('/api/views', requireInternalUser)

/** Chart types a saved summary may ask for (P5-54). */
const CHART_TYPES = ['bars', 'histogram', 'line'] as const
/** County-context layers a table view may carry (P5-48 caps the picker at 6). */
const VIEW_LAYERS_MAX = 6

/** A comparison is something a person reads side by side (P5-55). Past a
 *  dozen either way it is a spreadsheet, and the document stops being small
 *  enough to embed in a page. */
const COMPARE_COUNTIES_MAX = 12
const COMPARE_LAYERS_MAX = 12
/** A note is a sentence about a county, not a document of its own. */
const COMPARE_NOTE_MAX = 500
/** Every county GEOID is five digits (state FIPS + county FIPS). */
const GEOID_RE = /^\d{5}$/
/** Runtime-registered library layers; the public ones come from the
 *  generated registry export. */
const INTERNAL_LAYER_PREFIX = 'internal-'

/** The five EPA contamination overlays a map view may name (P5-78).
 *  Generated from the client's `src/config/siteLayers.ts` — see
 *  `npm run export:layers`. */
const SITE_LAYER_IDS = new Set(siteLayerRegistry.map(l => l.id))

const VIEW_TYPES = ['map', 'table', 'compare'] as const
type ViewType = (typeof VIEW_TYPES)[number]

function viewTypeOf(value: unknown): ViewType {
  return typeof value === 'string' && (VIEW_TYPES as readonly string[]).includes(value)
    ? (value as ViewType)
    : 'map'
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every(v => typeof v === 'string') ? (value as string[]) : null
}

/**
 * Normalise a MAP view's state (P5-78).
 *
 * A map view's state is otherwise opaque here, and stays that way: the only
 * field checked is `siteLayers`, the contamination overlays that were on when
 * the view was saved. Unknown ids are DROPPED with a warning rather than
 * 400ing, because a saved view has to keep opening — a layer we later retire
 * must not turn every document that named it into an error. A state with no
 * `siteLayers` is returned untouched, so every document written before P5-78
 * is stored exactly as it always was.
 *
 * Exported for the same reason `parseTableState` is: the MCP `save_view` tool
 * has to speak the same vocabulary as the route.
 */
export function normaliseMapState(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.siteLayers === undefined) return raw
  const listed = Array.isArray(raw.siteLayers) ? raw.siteLayers : []
  if (!Array.isArray(raw.siteLayers)) {
    console.warn('[views] siteLayers is not a list — dropping it')
  }
  const kept: string[] = []
  const dropped: unknown[] = []
  for (const id of listed) {
    if (typeof id !== 'string' || !SITE_LAYER_IDS.has(id)) dropped.push(id)
    else if (!kept.includes(id)) kept.push(id)
  }
  if (dropped.length > 0) {
    console.warn(`[views] dropped unknown site layers: ${dropped.map(String).join(', ')}`)
  }
  const state = { ...raw }
  if (kept.length > 0) state.siteLayers = kept
  else delete state.siteLayers
  return state
}

/**
 * Validate + normalise a table view's state against the real dataset.
 *
 * Everything the explorer puts in its URL goes through `parseRowsQuery`, the
 * same validator the /rows route uses, so "unknown column" means the same
 * thing here as it does there. The dataset's title is stamped in so a
 * reindex can describe the view from the document alone.
 *
 * Exported for P5-52: the MCP `save_view` tool must validate a table view the
 * same way this route does, and "the same way" only holds if there is one
 * function. Nothing else about the route moved.
 */
export async function parseTableState(
  raw: Record<string, unknown>,
): Promise<{ error: string } | { state: Record<string, unknown> }> {
  const dataset = typeof raw.dataset === 'string' ? raw.dataset.trim() : ''
  if (!dataset) return { error: 'a table view needs a dataset' }
  const file = typeof raw.file === 'string' && raw.file ? raw.file : undefined

  let read
  try {
    read = await readDataset(dataset, file)
  } catch (err) {
    // "not found" / "file not found" / "too big to browse" are all reasons
    // this view could never open — a 400 on the save, not a 500.
    if (err instanceof TabularError) return { error: err.message }
    throw err
  }
  const names = read.parsed.columns.map(c => c.name)

  // `filter` is validated as the JSON string the table's URL actually
  // carries, so the two paths cannot drift.
  const query = parseRowsQuery(
    {
      q: raw.q,
      filter: raw.filters === undefined ? undefined : JSON.stringify(raw.filters),
      sort: raw.sort,
      dir: raw.dir,
    },
    names,
  )
  if ('error' in query) return { error: query.error }

  const state: Record<string, unknown> = {
    dataset,
    datasetTitle: read.entry.title,
    filters: query.filter ?? [],
  }
  if (file) state.file = read.parsed.file
  if (query.q) state.q = query.q
  if (query.sort) state.sort = query.sort
  if (query.dir) state.dir = query.dir

  if (raw.columns !== undefined) {
    const columns = stringList(raw.columns)
    if (!columns) return { error: 'columns must be a list of column names' }
    const unknown = columns.find(c => !names.includes(c))
    if (unknown !== undefined) return { error: `unknown column: ${unknown}` }
    if (columns.length > 0) state.columns = columns
  }

  if (raw.layers !== undefined) {
    const layers = stringList(raw.layers)
    if (!layers) return { error: 'layers must be a list of layer ids' }
    if (layers.length > VIEW_LAYERS_MAX) return { error: `layers: at most ${VIEW_LAYERS_MAX}` }
    if (layers.length > 0) state.layers = layers
  }

  if (raw.summary !== undefined && raw.summary !== null) {
    const summary = raw.summary
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      return { error: 'summary must be {column, chart} or {groupBy}' }
    }
    const { column, chart, groupBy } = summary as Record<string, unknown>
    if (typeof groupBy === 'string') {
      if (!names.includes(groupBy)) return { error: `unknown column: ${groupBy}` }
      state.summary = { groupBy }
    } else if (typeof column === 'string') {
      if (!names.includes(column)) return { error: `unknown column: ${column}` }
      if (typeof chart !== 'string' || !(CHART_TYPES as readonly string[]).includes(chart)) {
        return { error: `chart must be one of ${CHART_TYPES.join(', ')}` }
      }
      state.summary = { column, chart }
    } else {
      return { error: 'summary must be {column, chart} or {groupBy}' }
    }
  }

  // How many rows matched when it was saved — the number the explorer
  // compares against today's count to say "saved with 13 rows, now 15".
  const saved = raw.savedRowCount
  if (saved !== undefined) {
    if (typeof saved !== 'number' || !Number.isInteger(saved) || saved < 0) {
      return { error: 'savedRowCount must be a row count of 0 or more' }
    }
  }
  state.savedRowCount = typeof saved === 'number' ? saved : 0

  return { state }
}

/**
 * Validate + normalise a comparison's state (P5-55).
 *
 * Unlike a table view there is no dataset to check against, so the checks
 * are on the two vocabularies the page speaks: five-digit county GEOIDs, and
 * layer ids that really exist — public ones from the generated registry
 * export, internal ones from the live layer manifest. The manifest is only
 * read when an internal id is actually present, so an all-public comparison
 * costs no query.
 *
 * Notes are keyed by GEOID and bounded, because they ride inside the same
 * document as the shortlist and get rendered into embed cards.
 */
export async function parseCompareState(
  raw: Record<string, unknown>,
): Promise<{ error: string } | { state: Record<string, unknown> }> {
  const rawCounties = stringList(raw.counties)
  if (!rawCounties) return { error: 'counties must be a list of GEOIDs' }
  const counties = [...new Set(rawCounties)]
  if (counties.length === 0) return { error: 'a comparison needs at least one county' }
  if (counties.length > COMPARE_COUNTIES_MAX) {
    return { error: `counties: at most ${COMPARE_COUNTIES_MAX}` }
  }
  const badCounty = counties.find(c => !GEOID_RE.test(c))
  if (badCounty !== undefined) return { error: `not a county GEOID: ${badCounty}` }

  const rawLayers = stringList(raw.layers)
  if (!rawLayers) return { error: 'layers must be a list of layer ids' }
  const layers = [...new Set(rawLayers)]
  if (layers.length === 0) return { error: 'a comparison needs at least one layer' }
  if (layers.length > COMPARE_LAYERS_MAX) return { error: `layers: at most ${COMPARE_LAYERS_MAX}` }

  const known = new Set<string>(publicLayerRegistry.map(l => l.id))
  if (layers.some(id => id.startsWith(INTERNAL_LAYER_PREFIX))) {
    for (const layer of await listInternalLayers()) known.add(layer.id)
  }
  const badLayer = layers.find(id => !known.has(id))
  if (badLayer !== undefined) return { error: `unknown layer: ${badLayer}` }

  const state: Record<string, unknown> = { counties, layers }

  if (raw.notes !== undefined && raw.notes !== null) {
    const raws = raw.notes
    if (typeof raws !== 'object' || Array.isArray(raws)) {
      return { error: 'notes must be an object keyed by GEOID' }
    }
    const notes: Record<string, string> = {}
    for (const [geoId, note] of Object.entries(raws as Record<string, unknown>)) {
      if (!counties.includes(geoId)) return { error: `notes: ${geoId} is not one of these counties` }
      if (typeof note !== 'string') return { error: `notes: ${geoId} must be text` }
      if (note.length > COMPARE_NOTE_MAX) {
        return { error: `notes: at most ${COMPARE_NOTE_MAX} characters per county` }
      }
      const trimmed = note.trim()
      if (trimmed) notes[geoId] = trimmed
    }
    if (Object.keys(notes).length > 0) state.notes = notes
  }

  return { state }
}

/** List row for GET /api/views: summary fields only, never the payload. */
function viewSummary(entry: { slug: string; title: string; meta: Record<string, unknown> }) {
  const meta = entry.meta
  return {
    slug: entry.slug,
    name: entry.title,
    type: viewTypeOf(meta.type),
    dataset: typeof meta.dataset === 'string' ? meta.dataset : '',
    description: typeof meta.description === 'string' ? meta.description : '',
    savedBy: typeof meta.savedBy === 'string' ? meta.savedBy : '',
    savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : '',
    resultCount: typeof meta.resultCount === 'number' ? meta.resultCount : 0,
    // P7-1: '' is the ad-hoc view — a stated absence on the row, exactly as a
    // map view's `dataset` is ''. It matches no set rather than being a gap.
    workingSet: typeof meta.workingSet === 'string' ? meta.workingSet : '',
  }
}

/** The set a request names, checked to be one. Shared by the save and the
 *  re-point, so a view can never end up pointing at a slug that is not a set
 *  — a pointer to nothing would be worse than no pointer at all. */
async function checkWorkingSet(value: unknown): Promise<{ error: string } | { workingSet: string }> {
  if (typeof value !== 'string' || !value.trim()) return { error: 'workingSet must be the slug of a working set.' }
  const slug = value.trim()
  const entry = await getCatalogEntry(slug)
  if (!entry || entry.kind !== WORKING_SET_KIND) {
    return { error: `There is no working set called “${slug}”.` }
  }
  return { workingSet: slug }
}

router.get('/api/views', async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    const entries = await searchCatalog({ kind: 'view' })
    // P5-54: `?dataset=` is the explorer's "saved views of this table" strip.
    // An unknown slug matches nothing rather than 400ing — a list filter is
    // not a lookup.
    const dataset = Array.isArray(req.query.dataset) ? req.query.dataset[0] : req.query.dataset
    // P5-55: `?type=` is the compare page's "Saved comparisons" strip. Same
    // rule — an unrecognised value matches nothing rather than 400ing.
    const type = Array.isArray(req.query.type) ? req.query.type[0] : req.query.type
    // P7-1: `?workingSet=` is "the views of this set" — the list that makes
    // "a set may carry several views" one query instead of a read per
    // document. Same rule as the two above: an unknown value matches nothing
    // rather than 400ing, because a list filter is not a lookup.
    const workingSet = Array.isArray(req.query.workingSet) ? req.query.workingSet[0] : req.query.workingSet
    const views = entries
      .filter(e => (typeof dataset === 'string' && dataset ? e.meta.dataset === dataset : true))
      .map(viewSummary)
      .filter(v => (typeof type === 'string' && type ? v.type === type : true))
      .filter(v => (typeof workingSet === 'string' && workingSet ? v.workingSet === workingSet : true))
    // Catalog order is updated_at DESC already; sort on the document's own
    // timestamp so the API contract doesn't lean on index insert order.
    views.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
    res.json({ views })
  } catch (err: any) {
    console.error('[views] list failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/api/views/:slug', async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    const view = await getSavedView(req.params.slug)
    if (!view) {
      res.status(404).json({ error: 'not found' })
      return
    }
    // The same sentence the list and ⌘K show, so an embed card and a search
    // result never describe one view two ways.
    const description = savedViewMeta(view as unknown as Record<string, unknown>).description
    res.json({ ...view, description })
  } catch (err: any) {
    console.error('[views] read failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/api/views', async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    const { name, type, state, results, workingSet } = req.body ?? {}
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'a view name is required' })
      return
    }
    if (type !== undefined && !(VIEW_TYPES as readonly unknown[]).includes(type)) {
      res.status(400).json({ error: `type must be one of ${VIEW_TYPES.join(', ')}` })
      return
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      res.status(400).json({ error: 'state must be an object' })
      return
    }
    if (!Array.isArray(results)) {
      res.status(400).json({ error: 'results must be an array' })
      return
    }
    if (results.length > VIEW_RESULTS_MAX) {
      res.status(400).json({ error: `views snapshot at most ${VIEW_RESULTS_MAX} result rows` })
      return
    }
    // P7-1: omitting this is the ordinary case and means ad-hoc. Naming a set
    // that does not exist is refused rather than stored — a pointer to nothing
    // is worse than no pointer, because every reader would have to tell the
    // two apart.
    let presents = ''
    if (workingSet !== undefined && workingSet !== null && workingSet !== '') {
      const checked = await checkWorkingSet(workingSet)
      if ('error' in checked) {
        res.status(400).json({ error: checked.error })
        return
      }
      presents = checked.workingSet
    }

    // A table or compare view's state has to open, so it is checked here —
    // against the real dataset, or against the real counties and layers. A
    // map view's state stays the client's business apart from its site
    // layers, which the server also has to describe (P5-78).
    let stored: Record<string, unknown> = state
    if (type === 'table' || type === 'compare') {
      const parsed =
        type === 'table'
          ? await parseTableState(state as Record<string, unknown>)
          : await parseCompareState(state as Record<string, unknown>)
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error })
        return
      }
      stored = parsed.state
    } else {
      stored = normaliseMapState(state as Record<string, unknown>)
    }

    const user = res.locals.internalUser
    const result = await createSavedView({
      name: name.trim(),
      type: type ?? 'map',
      state: stored,
      results,
      savedBy: user?.username ?? 'unknown',
      savedById: user?.id ?? null,
      ...(presents ? { workingSet: presents } : {}),
    })
    if (result.error === 'bad-name') {
      res.status(400).json({ error: 'the view name needs at least one letter or number' })
      return
    }
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'view.create',
      target: result.slug,
      detail: { name: result.name, type: type ?? 'map', resultCount: results.length, ...(presents ? { workingSet: presents } : {}) },
    })
    res.status(201).json({ slug: result.slug, name: result.name })
  } catch (err: any) {
    console.error('[views] create failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Point a saved view at a working set, or clear the pointer (P7-1).
 *
 * The second of the two ways a view comes to present a set — the first being
 * the promote action, which creates the set at the same time. This one exists
 * because **a set may carry several views**: the second framing of a set that
 * already exists is saved like any other view and then pointed here, and
 * because a pointer set by mistake has to be correctable without deleting the
 * view somebody has already linked to.
 *
 * `null` clears it, and clearing leaves exactly the document a never-promoted
 * view has — ad-hoc is a state a view can return to, not a one-way door.
 */
router.put('/api/views/:slug/working-set', async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    const asked = (req.body ?? {}).workingSet
    let workingSet: string | null = null
    if (asked !== undefined && asked !== null && asked !== '') {
      const checked = await checkWorkingSet(asked)
      if ('error' in checked) {
        res.status(400).json({ error: checked.error })
        return
      }
      workingSet = checked.workingSet
    }
    const result = await setViewWorkingSet(req.params.slug, workingSet)
    if (result.error === 'not-found') {
      res.status(404).json({ error: 'not found' })
      return
    }
    const user = res.locals.internalUser
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'view.workingSet',
      target: req.params.slug,
      detail: { workingSet },
    })
    res.json({ slug: req.params.slug, workingSet })
  } catch (err: any) {
    console.error('[views] working-set pointer failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
