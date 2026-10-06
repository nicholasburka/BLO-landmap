/**
 * Client helpers for saved data views (P5-16).
 *
 * A view is a named snapshot of map+query state that lives server-side as
 * library/views/<slug>.json (API: GET/POST /api/views, GET /api/views/:slug).
 * The server owns naming (it slugifies the name; collisions auto-suffix) and
 * attribution (savedBy/savedAt from the session) — the client just sends the
 * state it wants to be able to restore, plus a bounded results snapshot so
 * wiki embeds stay meaningful even if underlying data is later revised.
 *
 * P5-54 adds a second kind, `type: 'table'` — a saved explorer view. That
 * one is a recipe rather than a snapshot (it re-runs its query on open), so
 * it stores no result rows; see the "Saved TABLE views" section below.
 *
 * P5-55 adds a third, `type: 'compare'` — a shortlist of counties and the
 * layers they are being weighed on, plus a note per county. Like a table
 * view it is a recipe: opening it re-reads today's numbers.
 *
 * P7-1 adds ONE optional field, `workingSet` — the set this view PRESENTS. It
 * sits beside `state` rather than inside it, because `state` is framing and a
 * working set is the opposite of framing. **Absent means ad-hoc**, which is a
 * permanent, first-class state and not a legacy one: every view saved before
 * P7-1 keeps a null pointer and behaves exactly as it does today. See
 * `lib/workingSets.ts`.
 */

import { isSiteLayerId } from '@/config/siteLayers'
import type { LayerSelection } from './mapTools'
import type { ScoringFilter } from '@/types/mapTypes'
import { invalidateCatalogCache } from './libraryCatalog'
import { internalFetch } from './apiBase'
import { FILTER_OPS, type FilterOp, type RowFilter } from './libraryData'
import {
  MAX_COMPARE_COUNTIES,
  MAX_COMPARE_LAYERS,
  NOTE_MAX_CHARS,
  compareUrl,
  isCompareLayerId,
  isGeoId,
} from './compare'

/** Everything needed to restore "her exact layers, query, and viewport". */
export interface SavedViewState {
  layers: { layerId: string; weight: number; direction?: string }[]
  filters: unknown[]
  limit: number | null
  regionStates: string[]
  prompt: string
  viewport: { center: [number, number]; zoom: number } | null
  /** P5-24: toggled internal point layers (ids + names so embeds can list them without the manifest). */
  pointLayers?: { id: string; name: string }[]
  /** P5-78: the contamination site layers that were on (ids from
   *  `config/siteLayers.ts`). Absent means none were — which is every
   *  document written before P5-78. */
  siteLayers?: string[]
}

/**
 * The site layers a saved state names, dropped down to the ones that still
 * exist (P5-78).
 *
 * A view document can be hand-edited or hand-pushed, and the five EPA ids are
 * the only vocabulary the map can act on, so anything else is dropped with one
 * warning rather than throwing — the same rule `tableStateOf` and the map's
 * restore already follow. Order and duplicates are the caller's problem here:
 * the list comes back de-duplicated in the order it was saved.
 */
export function readSiteLayers(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    console.warn('[views] siteLayers is not a list — ignoring it')
    return []
  }
  const kept: string[] = []
  const dropped: unknown[] = []
  for (const id of value) {
    if (!isSiteLayerId(id)) dropped.push(id)
    else if (!kept.includes(id)) kept.push(id)
  }
  if (dropped.length > 0) {
    console.warn(`[views] dropped unknown site layers: ${dropped.map(String).join(', ')}`)
  }
  return kept
}

/**
 * Which contamination layers a restore has to switch on, and which it has to
 * switch off (P5-78).
 *
 * Restoring a view is "put the map back the way it was", the same rule the
 * scoring query and the point layers follow — so a layer that is on now and
 * was not on then goes off, and a view saved before P5-78 (no `siteLayers`)
 * turns them all off. Pure, so the map's restore path is testable without
 * Mapbox: `on` goes through the on-demand loader, `off` is a visibility flip.
 */
export function siteLayerRestore(
  value: unknown,
  visible: string[],
): { on: string[]; off: string[] } {
  const saved = readSiteLayers(value)
  return {
    on: saved.filter(id => !visible.includes(id)),
    off: visible.filter(id => !saved.includes(id)),
  }
}

/** One snapshotted ranking row (already shaped for display in embeds). */
export interface SavedViewResult {
  rank: number
  geoId: string
  name: string
  state: string
  score: number
}

export interface SavedView {
  slug: string
  name: string
  /** 'map' (the default, and every document written before P5-54), 'table'
   *  (read with `tableStateOf`) or 'compare' (read with `compareStateOf`). */
  type: SavedViewType
  savedBy: string
  savedAt: string
  /** The server's one-line description of what this view is. */
  description?: string
  state: SavedViewState
  results: SavedViewResult[]
  /**
   * P7-1: the slug of the working set this view presents.
   *
   * **Absent means ad-hoc** — the same stated-absence rule `siteLayers` above
   * follows, and for the same reason: there is no migration, no deprecated
   * state, one well-understood optional field. A reader that finds nothing
   * here is looking at a view somebody saved after exploring, which is a
   * reasonable thing to have done and must not look broken.
   */
  workingSet?: string
}

/** Mirrors the server's VIEW_RESULTS_MAX: the snapshot is for embed cards,
 *  not a data export, so the client trims rather than erroring. */
export const VIEW_RESULTS_MAX = 100

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    // non-JSON body — fall through
  }
  return fallback
}

/** Save the current map+query state as a named view. Returns the slug the
 *  server chose (needed for embed blocks and share links). */
export async function saveView(input: {
  name: string
  /** Omitted for map views — the server defaults to 'map'. */
  type?: SavedViewType
  state: SavedViewState | SavedTableViewState | SavedCompareViewState
  /** Table views snapshot no rows: they re-run their query when opened. */
  results?: SavedViewResult[]
  /** P7-1: the working set this view presents. Omit for an ad-hoc view —
   *  which is most of them, and permanently fine. */
  workingSet?: string
}): Promise<{ slug: string; name: string }> {
  const res = await internalFetch('/api/views', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      ...(input.type ? { type: input.type } : {}),
      ...(input.workingSet ? { workingSet: input.workingSet } : {}),
      state: input.state,
      results: (input.results ?? []).slice(0, VIEW_RESULTS_MAX),
    }),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to save view (${res.status})`))
  }
  // A saved view is a catalog row (P5-89): the list, the landing and the
  // entry page's "views using this layer" are all stale until they refetch.
  invalidateCatalogCache()
  return (await res.json()) as { slug: string; name: string }
}

/** Fetch a full view snapshot. Returns null on 404. */
export async function fetchView(slug: string): Promise<SavedView | null> {
  const res = await internalFetch(`/api/views/${encodeURIComponent(slug)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to load view (${res.status})`))
  }
  const view = (await res.json()) as SavedView
  // A document written before P5-54 has no type — it is a map view.
  const type: SavedViewType = view.type === 'table' || view.type === 'compare' ? view.type : 'map'
  return { ...view, type }
}

// --- Saved TABLE views (P5-54) ----------------------------------------------

/** A view is the map's query state, a table in the explorer, or a county
 *  comparison. Documents written before P5-54 carry no type — map views. */
export type SavedViewType = 'map' | 'table' | 'compare'

/** Which picture a saved summary asks for. */
export type SavedChartKind = 'bars' | 'histogram' | 'line'

/** The saved summary: one column as a chart, or a group-by table. */
export type SavedSummary = { column: string; chart: SavedChartKind } | { groupBy: string }

/**
 * A saved table view's state — the explorer's URL plus the parts of the
 * panel that do not live in the URL (visible columns, the open summary).
 *
 * It is a RECIPE, not a snapshot: opening it re-runs the query against
 * today's rows. `savedRowCount` is what matched when it was saved, which is
 * the only way the explorer can say "saved with 13 rows, now 15".
 */
export interface SavedTableViewState {
  dataset: string
  /** The dataset's title when it was saved (the server stamps it). */
  datasetTitle?: string
  file?: string
  q?: string
  filters: RowFilter[]
  sort?: string
  dir?: 'asc' | 'desc'
  /** Columns that were on screen; absent means "all of them". */
  columns?: string[]
  /** P5-48 county-context layer ids, carried through every deep link. */
  layers?: string[]
  summary?: SavedSummary
  savedRowCount: number
}

/** One row of GET /api/views (both kinds). */
export interface SavedViewSummary {
  slug: string
  name: string
  type: SavedViewType
  /** The dataset a table view opens; '' for map views. */
  dataset: string
  /** The server's one-line description, e.g. "Organizations · HQ State is Georgia · 13 rows". */
  description: string
  savedBy: string
  savedAt: string
  resultCount: number
  /** P7-1: the working set this view presents; '' for an ad-hoc view. A
   *  stated absence on the row, exactly as `dataset` is '' for a map view. */
  workingSet: string
}

function isFilterOp(op: unknown): op is FilterOp {
  return typeof op === 'string' && (FILTER_OPS as string[]).includes(op)
}

function readFilters(value: unknown): RowFilter[] {
  if (!Array.isArray(value)) return []
  const filters: RowFilter[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { column, op, value: v } = item as Record<string, unknown>
    if (typeof column !== 'string' || !column || !isFilterOp(op)) continue
    const needsValue = op !== 'empty' && op !== 'notEmpty'
    if (needsValue && typeof v !== 'string') continue
    filters.push(needsValue ? { column, op, value: v as string } : { column, op })
  }
  return filters
}

function readStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((v): v is string => typeof v === 'string' && v !== '')
  return list.length > 0 ? list : undefined
}

function readSummary(value: unknown): SavedSummary | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { column, chart, groupBy } = value as Record<string, unknown>
  if (typeof groupBy === 'string' && groupBy) return { groupBy }
  if (typeof column === 'string' && column && (chart === 'bars' || chart === 'histogram' || chart === 'line')) {
    return { column, chart }
  }
  return undefined
}

/**
 * Read a view's state as a table view, or null when it is not one.
 *
 * The server validates a table view's state when it is saved, but a
 * hand-edited or hand-pushed document has to degrade rather than throw —
 * same rule the map's restore follows.
 */
export function tableStateOf(view: SavedView): SavedTableViewState | null {
  if (view.type !== 'table') return null
  const raw = view.state as unknown as Record<string, unknown>
  const dataset = typeof raw?.dataset === 'string' ? raw.dataset : ''
  if (!dataset) return null
  const dir = raw.dir === 'desc' ? 'desc' : raw.dir === 'asc' ? 'asc' : undefined
  return {
    dataset,
    ...(typeof raw.datasetTitle === 'string' && raw.datasetTitle ? { datasetTitle: raw.datasetTitle } : {}),
    ...(typeof raw.file === 'string' && raw.file ? { file: raw.file } : {}),
    ...(typeof raw.q === 'string' && raw.q ? { q: raw.q } : {}),
    filters: readFilters(raw.filters),
    ...(typeof raw.sort === 'string' && raw.sort ? { sort: raw.sort } : {}),
    ...(dir ? { dir } : {}),
    ...(readStrings(raw.columns) ? { columns: readStrings(raw.columns) } : {}),
    ...(readStrings(raw.layers) ? { layers: readStrings(raw.layers) } : {}),
    ...(readSummary(raw.summary) ? { summary: readSummary(raw.summary) } : {}),
    savedRowCount: typeof raw.savedRowCount === 'number' && raw.savedRowCount >= 0 ? raw.savedRowCount : 0,
  }
}

/**
 * A table view's saved query, as the explorer reads it — the state without the
 * place it is going.
 *
 * Two surfaces restore a table view now: the entry hub's Data tab
 * (`tableViewUrl`), and P7-2's Data interface at `/views/:slug`, which puts the
 * same keys on a URL it is already on rather than navigating anywhere. Both
 * read the state through here, so "what a saved table view restores" is one
 * answer and not two that can drift.
 *
 * `view=<slug>` rides along so the explorer can fetch the document and restore
 * what the URL does not carry (visible columns, the open summary) and say
 * whether the row count has moved since it was saved.
 */
export function tableViewQuery(state: SavedTableViewState, slug?: string): Record<string, string> {
  const query: Record<string, string> = {}
  if (state.file) query.file = state.file
  if (state.q) query.q = state.q
  if (state.sort) {
    query.sort = state.sort
    if (state.dir === 'desc') query.dir = 'desc'
  }
  if (state.filters.length > 0) query.filter = JSON.stringify(state.filters)
  if (state.layers?.length) query.layers = state.layers.join(',')
  if (slug) query.view = slug
  return query
}

/** Where a table view opens: the entry hub's Data tab with the saved query in
 *  the URL. */
export function tableViewUrl(state: SavedTableViewState, slug?: string): string {
  const params = new URLSearchParams({ tab: 'data', ...tableViewQuery(state, slug) })
  return `/library/${encodeURIComponent(state.dataset)}?${params.toString()}`
}

// --- Reading a MAP view's state (P7-4) ---------------------------------------

/**
 * A map view's state, read: the scoring query it saved, the overlays it had
 * on, and where it was looking.
 *
 * The third sibling of `tableStateOf` and `compareStateOf`, and it exists for
 * the same reason they do — **a saved view's state is an opaque payload to the
 * server**, so a hand-edited or hand-pushed document has to degrade rather than
 * throw, and exactly one reader should decide what degrading means.
 *
 * Until P7-4 there were nearly two. `Map.vue`'s `applySavedView` carried this
 * field-by-field reader inline for `?view=<slug>`, and a map block in a page
 * needs the same answer — so a second copy would have been two definitions of
 * "what a saved map view shows", free to drift the way §F.1 warns a number can.
 * This is that copy, lifted out and tested; `Map.vue` calls it now.
 *
 * `layers`, `filters`, `limit` and `regionStates` are shaped to go straight
 * into `MapQueryState.apply` (= the `set_query_state` tool's own input), so a
 * caller never re-shapes them. `pointLayers` and `siteLayers` are NOT part of
 * the scoring query — they are overlays, applied separately — and `viewport`
 * is framing, which is `MapFitRequest`'s job.
 */
export interface SavedMapViewState {
  layers: LayerSelection[]
  filters: ScoringFilter[]
  limit: number | null
  regionStates: string[]
  /** P5-24 point-layer ids, by id alone: the saved names are for embed cards. */
  pointLayers: string[]
  /** P5-78 contamination site layer ids, through `readSiteLayers`. */
  siteLayers: string[]
  /** Where the map was looking, or null when the document does not say. */
  viewport: { center: [number, number]; zoom: number } | null
}

function readViewport(value: unknown): SavedMapViewState['viewport'] {
  if (!value || typeof value !== 'object') return null
  const { center, zoom } = value as Record<string, unknown>
  // A half-written viewport is not a viewport: jumping to one axis of it would
  // put the reader somewhere nobody chose.
  if (!Array.isArray(center) || center.length !== 2) return null
  if (typeof center[0] !== 'number' || typeof center[1] !== 'number') return null
  if (typeof zoom !== 'number') return null
  return { center: [center[0], center[1]], zoom }
}

/**
 * Read a view's state as a map view's, or null when it is not one.
 *
 * Null for a table or compare view on purpose: both of those also store a
 * `layers` key, and a table view's is a list of county-context layer ids
 * (P5-48) rather than weighted scoring layers. Applying one as the other would
 * silently draw nothing, which is the failure mode that looks like a bug in the
 * data.
 */
export function mapStateOf(view: SavedView): SavedMapViewState | null {
  if (view.type !== 'map') return null
  const raw = (view.state ?? {}) as unknown as Record<string, unknown>
  const layers = (Array.isArray(raw.layers) ? raw.layers : [])
    .filter(
      (l): l is { layerId: string; weight: number; direction?: unknown } =>
        !!l && typeof l === 'object' && typeof (l as LayerSelection).layerId === 'string' &&
        typeof (l as LayerSelection).weight === 'number',
    )
    .map((l): LayerSelection => ({
      layerId: l.layerId,
      weight: l.weight,
      // Anything the scoring engine does not know falls back to the layer
      // registry's default direction, which is what `undefined` means here.
      direction:
        l.direction === 'higher_better' || l.direction === 'lower_better' ? l.direction : undefined,
    }))
  const filters = (Array.isArray(raw.filters) ? raw.filters : []).filter(
    (f): f is ScoringFilter =>
      !!f && typeof f === 'object' && typeof (f as ScoringFilter).layerId === 'string' &&
      typeof (f as ScoringFilter).value === 'number',
  )
  return {
    layers,
    filters,
    limit: typeof raw.limit === 'number' ? raw.limit : null,
    regionStates: (Array.isArray(raw.regionStates) ? raw.regionStates : []).filter(
      (r): r is string => typeof r === 'string',
    ),
    pointLayers: (Array.isArray(raw.pointLayers) ? raw.pointLayers : [])
      .filter((p): p is { id: string } => !!p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string')
      .map(p => p.id),
    siteLayers: readSiteLayers(raw.siteLayers),
    viewport: readViewport(raw.viewport),
  }
}

/**
 * Whether this view has a map in it to draw (P7-4).
 *
 * A map block needs to know before it mounts a canvas, because the honest
 * answer for a view that names nothing is a sentence, not an empty map: an
 * all-grey country reads as broken data where *"this view does not name a map
 * layer"* points at the thing to fix (P6-23's rule).
 *
 * Point overlays count on their own. A view saved with no scoring layer but an
 * organizations layer switched on is a perfectly good map — the points ARE what
 * it shows.
 */
export function describesAMap(view: SavedView): boolean {
  const state = mapStateOf(view)
  if (!state) return false
  return state.layers.length > 0 || state.pointLayers.length > 0
}

// --- Saved COMPARE views (P5-55) --------------------------------------------

/**
 * A saved comparison: which counties, which layers, and what the researcher
 * wrote about each county.
 *
 * Like a table view this is a RECIPE — the numbers are re-read when it opens,
 * so a comparison saved last month shows this month's data. Only GEOIDs and
 * layer ids are stored, which is also why the document is small enough to
 * embed in a page.
 */
export interface SavedCompareViewState {
  counties: string[]
  layers: string[]
  /** GEOID → the note the researcher wrote, at most NOTE_MAX_CHARS. */
  notes?: Record<string, string>
}

function readNotes(value: unknown, counties: string[]): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const notes: Record<string, string> = {}
  for (const [geoId, note] of Object.entries(value as Record<string, unknown>)) {
    // A note for a county that is no longer in the comparison has nowhere to
    // render; dropping it beats showing an orphan.
    if (!counties.includes(geoId) || typeof note !== 'string') continue
    const trimmed = note.trim()
    if (trimmed) notes[geoId] = trimmed.slice(0, NOTE_MAX_CHARS)
  }
  return Object.keys(notes).length > 0 ? notes : undefined
}

/**
 * Read a view's state as a comparison, or null when it is not one.
 *
 * The server validates this state when it is saved, but a hand-edited or
 * hand-pushed document has to degrade rather than throw — the same rule the
 * map's restore and `tableStateOf` follow. A document with no counties or no
 * layers left is not a comparison any more, so it reads as null.
 */
export function compareStateOf(view: SavedView): SavedCompareViewState | null {
  if (view.type !== 'compare') return null
  const raw = view.state as unknown as Record<string, unknown>
  const counties = (Array.isArray(raw?.counties) ? raw.counties : [])
    .filter(isGeoId)
    .slice(0, MAX_COMPARE_COUNTIES)
  const layers = (Array.isArray(raw?.layers) ? raw.layers : [])
    .filter(isCompareLayerId)
    .slice(0, MAX_COMPARE_LAYERS)
  if (counties.length === 0 || layers.length === 0) return null
  const notes = readNotes(raw.notes, counties)
  return { counties, layers, ...(notes ? { notes } : {}) }
}

/** Where a saved comparison opens: /compare with its counties and layers,
 *  plus `view=<slug>` so the page can name it and restore the notes. */
export function compareViewUrl(state: SavedCompareViewState, slug?: string): string {
  return compareUrl({ counties: state.counties, layers: state.layers, ...(slug ? { view: slug } : {}) })
}

// --- Two interfaces over one working set (P7-2) -------------------------------------

/**
 * Which interface `/views/:slug` is showing.
 *
 * Both are over the SAME object, at the same URL, so this is a query key and
 * not a route: switching is a `router.replace`, nothing unmounts that holds
 * data, and nothing is fetched twice. A deep link to either opens there.
 */
export type SetInterface = 'map' | 'data'

export const SET_INTERFACE_KEY = 'interface'

/**
 * Which interface a view opens in when the URL does not say.
 *
 * The view's own type is the answer, because the view IS the framing: a view
 * somebody saved off the map opens on the map, one saved off a table opens on
 * the table. The set is the same either way, which is the point.
 */
export function interfaceForViewType(type: string): SetInterface {
  return type === 'table' ? 'data' : 'map'
}

/** `?interface=` → an interface, falling back to the view's own kind. An
 *  unknown value degrades rather than throwing: a hand-edited link should
 *  still open the view. */
export function parseSetInterface(value: unknown, fallback: SetInterface): SetInterface {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === 'map' || raw === 'data') return raw
  return fallback
}

/**
 * A deep link to one interface of a set-backed view.
 *
 * The interface is omitted when it is the one the view's own type opens in, so
 * the canonical link to a map view stays `/views/<slug>` and does not grow a
 * parameter restating what the document already says.
 */
export function workingSetViewHref(viewSlug: string, iface?: SetInterface, viewType = 'map'): string {
  const path = `/views/${encodeURIComponent(viewSlug)}`
  if (!iface || iface === interfaceForViewType(viewType)) return path
  return `${path}?${SET_INTERFACE_KEY}=${iface}`
}

/**
 * Where any saved view opens — the map for a map view, the explorer for a
 * table view, /compare for a comparison. Falls back to the map shim if the
 * document is unreadable.
 *
 * P7-2: a view that PRESENTS a working set opens on `/views/:slug` instead,
 * where the set's two interfaces are, in whichever one the view's own type
 * names. That is not a special case bolted on — it is the same rule as the rest
 * of this function, which has always sent a view to the surface that can show
 * what it is of.
 */
export function viewOpenUrl(view: SavedView): string {
  if (view.workingSet) return workingSetViewHref(view.slug, undefined, view.type)
  const table = tableStateOf(view)
  if (table) return tableViewUrl(table, view.slug)
  const compare = compareStateOf(view)
  if (compare) return compareViewUrl(compare, view.slug)
  return `/?view=${encodeURIComponent(view.slug)}`
}

/** List saved views, newest first. `dataset` narrows the list to one
 *  table's views (the explorer's "Saved views of this table" strip);
 *  `type` narrows it to one kind (the compare page's "Saved comparisons");
 *  `workingSet` narrows it to the views presenting one set (P7-1). */
export async function fetchViews(
  options: { dataset?: string; type?: SavedViewType; workingSet?: string } = {},
): Promise<SavedViewSummary[]> {
  const params = new URLSearchParams()
  if (options.dataset) params.set('dataset', options.dataset)
  if (options.type) params.set('type', options.type)
  // P7-1: the views of one set — "a set may carry several views", asked.
  if (options.workingSet) params.set('workingSet', options.workingSet)
  const qs = params.toString() ? `?${params.toString()}` : ''
  const res = await internalFetch(`/api/views${qs}`)
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load views (${res.status})`))
  const body = (await res.json()) as { views?: SavedViewSummary[] }
  return Array.isArray(body.views) ? body.views : []
}
