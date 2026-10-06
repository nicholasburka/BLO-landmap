/**
 * County comparison (P5-55): the state, arithmetic and file formats behind
 * `/compare` — a handful of candidate counties as rows, the layers that
 * matter as columns.
 *
 * Everything here is pure or storage-only, so all of it is testable without
 * a browser. The two data loaders at the bottom reach their sources through
 * DYNAMIC imports on purpose: the public map's county modal imports the
 * shortlist helpers from this module, and a static import of the layer
 * loaders would drag the knowledge base's data code into the public bundle.
 *
 * Two caps run through the whole feature (URL, page, saved document, embed
 * card, and the server's validator): 12 counties and 12 layers. Past that a
 * comparison stops being something a person reads side by side, and the
 * table stops being something a saved view can carry.
 */
import { ref } from 'vue'
import type { Direction, LayerDefinition } from '@/config/layerRegistry'
import { INTERNAL_PREFIX } from '@/lib/mapDeepLinks'
import { registerLogoutHook } from '@/composables/useAuth'

/** More than a dozen columns is a spreadsheet, not a comparison. */
export const MAX_COMPARE_COUNTIES = 12
export const MAX_COMPARE_LAYERS = 12
/** Matches the server's own note cap. */
export const NOTE_MAX_CHARS = 500

/** Every county GEOID is five digits (state FIPS + county FIPS). */
const GEOID_RE = /^\d{5}$/
/** Same shape mapDeepLinks accepts, so a layer id that opens the map also
 *  opens a comparison. */
const LAYER_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/

export function isGeoId(value: unknown): value is string {
  return typeof value === 'string' && GEOID_RE.test(value)
}

export function isCompareLayerId(value: unknown): value is string {
  return typeof value === 'string' && LAYER_ID_RE.test(value)
}

export function isInternalCompareLayer(layerId: string): boolean {
  return layerId.startsWith(INTERNAL_PREFIX)
}

// --- The URL ----------------------------------------------------------------

export interface CompareUrlState {
  counties: string[]
  layers: string[]
  /** The saved comparison this page was opened from, if any (P5-54 shape). */
  view: string
}

type QueryValue = string | string[] | null | undefined

function values(v: QueryValue): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return typeof v === 'string' ? [v] : []
}

/** Split a `?counties=a,b&counties=c` style param into de-duplicated,
 *  validated ids, capped. Malformed entries are dropped, never thrown: a
 *  hand-edited URL should open a smaller comparison, not an error page. */
function readList(raw: QueryValue, valid: (v: string) => boolean, max: number): string[] {
  const seen = new Set<string>()
  for (const chunk of values(raw)) {
    for (const part of chunk.split(',')) {
      if (seen.size >= max) return [...seen]
      const trimmed = part.trim()
      if (valid(trimmed)) seen.add(trimmed)
    }
  }
  return [...seen]
}

export function parseCompareUrl(query: Record<string, QueryValue>): CompareUrlState {
  const view = values(query.view)[0] ?? ''
  return {
    counties: readList(query.counties, isGeoId, MAX_COMPARE_COUNTIES),
    layers: readList(query.layers, isCompareLayerId, MAX_COMPARE_LAYERS),
    view: /^[a-z0-9][a-z0-9-]{0,79}$/.test(view) ? view : '',
  }
}

/** The one place the compare URL shape is written. */
export function compareUrl(state: { counties: string[]; layers: string[]; view?: string }): string {
  const params = new URLSearchParams()
  const counties = state.counties.filter(isGeoId).slice(0, MAX_COMPARE_COUNTIES)
  const layers = state.layers.filter(isCompareLayerId).slice(0, MAX_COMPARE_LAYERS)
  if (counties.length) params.set('counties', counties.join(','))
  if (layers.length) params.set('layers', layers.join(','))
  if (state.view) params.set('view', state.view)
  const qs = params.toString()
  return qs ? `/compare?${qs}` : '/compare'
}

// --- The table --------------------------------------------------------------

export interface CompareCounty {
  geoId: string
  county: string
  state: string
}

/** GEOID → one layer's value for that county, already formatted by the
 *  layer's own formatter (the map's numbers and the table's must agree). */
export type LayerColumn = Record<string, { value: number | string | null; display: string }>

/** Where a cell sits among the counties being compared — not among all
 *  3,000 counties. "best of these" is the honest phrase, and the one the
 *  header uses. */
export type CompareRank = 'best' | 'worst' | null

export interface CompareCell {
  layerId: string
  value: number | string | null
  display: string
  rank: CompareRank
}

export interface CompareRow extends CompareCounty {
  cells: CompareCell[]
}

/** Shown wherever a layer has no number for a county. */
export const NO_VALUE = '—'

function numeric(value: number | string | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * The best and worst NUMBERS in one column, read through the layer's own
 * direction — for a "lower is better" layer the smallest number is the best
 * one. Both are null when fewer than two counties have a number: a highlight
 * that marks the only value, or every value, says nothing.
 */
export function extremesOf(
  values: (number | string | null)[],
  direction: Direction,
): { best: number | null; worst: number | null } {
  const numbers = values.map(numeric).filter((n): n is number => n !== null)
  if (new Set(numbers).size < 2) return { best: null, worst: null }
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  return direction === 'lower_better' ? { best: min, worst: max } : { best: max, worst: min }
}

/** Counties × layers → the rows the table renders, with the best and worst
 *  value in each column marked. */
export function buildCompareRows(
  counties: CompareCounty[],
  layers: LayerDefinition[],
  columns: Record<string, LayerColumn>,
): CompareRow[] {
  const extremes = new Map<string, { best: number | null; worst: number | null }>()
  for (const layer of layers) {
    const column = columns[layer.id] ?? {}
    extremes.set(
      layer.id,
      extremesOf(
        counties.map(c => column[c.geoId]?.value ?? null),
        layer.direction,
      ),
    )
  }
  return counties.map(county => ({
    ...county,
    cells: layers.map(layer => {
      const hit = columns[layer.id]?.[county.geoId]
      const value = hit?.value ?? null
      const n = numeric(value)
      const ends = extremes.get(layer.id) ?? { best: null, worst: null }
      const rank: CompareRank =
        n === null ? null : n === ends.best ? 'best' : n === ends.worst ? 'worst' : null
      return { layerId: layer.id, value, display: hit?.display ?? NO_VALUE, rank }
    }),
  }))
}

export type SortDirection = 'asc' | 'desc'
/** 'name' sorts by county; anything else is a layer id (no layer in the
 *  registry is called "name"). */
export type CompareSortKey = string

export function sortCompareRows(
  rows: CompareRow[],
  key: CompareSortKey,
  direction: SortDirection,
): CompareRow[] {
  const sign = direction === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    if (key === 'name') return sign * `${a.county} ${a.state}`.localeCompare(`${b.county} ${b.state}`)
    const av = a.cells.find(c => c.layerId === key)?.value ?? null
    const bv = b.cells.find(c => c.layerId === key)?.value ?? null
    // A blank is not the biggest number: rows with nothing to show sink to
    // the bottom whichever way the column is pointed.
    if (av === null || bv === null) return (av === null ? 1 : 0) - (bv === null ? 1 : 0)
    if (typeof av === 'number' && typeof bv === 'number') return sign * (av - bv)
    return sign * String(av).localeCompare(String(bv))
  })
}

// --- Download ---------------------------------------------------------------

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The comparison as a file. Columns are named after the layers rather than
 * their `dataKey`s (the way P5-45's single-layer export is): a comparison
 * mixes files, so nothing here lines up with one source CSV anyway, and the
 * reader is a person opening a spreadsheet.
 *
 * Raw values, not display strings — a spreadsheet should be able to add them
 * up. The notes column only appears when there are notes to carry.
 */
export function compareCsv(
  rows: CompareRow[],
  layers: LayerDefinition[],
  notes: Record<string, string> = {},
): string {
  const hasNotes = rows.some(r => (notes[r.geoId] ?? '').trim() !== '')
  const header = ['GEOID', 'County', 'State', ...layers.map(l => l.name), ...(hasNotes ? ['Notes'] : [])]
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    const cells = layers.map(layer => {
      const value = row.cells.find(c => c.layerId === layer.id)?.value ?? null
      return value === null ? '' : String(value)
    })
    lines.push(
      [row.geoId, row.county, row.state, ...cells, ...(hasNotes ? [notes[row.geoId] ?? ''] : [])]
        .map(csvCell)
        .join(','),
    )
  }
  return lines.join('\n')
}

export const COMPARE_CSV_FILENAME = 'county-comparison.csv'

// --- Saying what is being compared ------------------------------------------

/** "A, B and C" — the way a person would say a list out loud. */
export function listPhrase(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Mirrors ask.ts's QUESTION_MAX_CHARS. Kept as a local constant so the
 *  public map's modal never pulls the Ask client into its bundle. */
const QUESTION_MAX = 500

/** What the Ask box on /compare starts with. Twelve counties by twelve
 *  layers can outrun the question limit, so it is trimmed on a word
 *  boundary rather than refused. */
export function compareQuestion(countyNames: string[], layerNames: string[]): string {
  const question = `Compare ${listPhrase(countyNames)} on ${listPhrase(layerNames)}`
  if (question.length <= QUESTION_MAX) return question
  const cut = question.slice(0, QUESTION_MAX - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > QUESTION_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** "3 counties across 4 layers" — the page's own header. */
export function compareHeading(counties: number, layers: number): string {
  const c = `${counties} ${counties === 1 ? 'county' : 'counties'}`
  const l = `${layers} ${layers === 1 ? 'layer' : 'layers'}`
  return `Comparing ${c} across ${l}`
}

// --- The pending shortlist --------------------------------------------------
// GEOIDs only, so nothing internal is ever written to disk — the key still
// lives under a prefix useAuth wipes at logout (P5-19: nothing internal
// survives in this browser), because WHICH counties someone is weighing is
// itself research.

export const SHORTLIST_KEY = 'blo:shortlist'

function readStored(): string[] {
  try {
    const raw = localStorage.getItem(SHORTLIST_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter(isGeoId))].slice(0, MAX_COMPARE_COUNTIES)
  } catch {
    return []
  }
}

function writeStored(geoIds: string[]): void {
  try {
    if (geoIds.length === 0) localStorage.removeItem(SHORTLIST_KEY)
    else localStorage.setItem(SHORTLIST_KEY, JSON.stringify(geoIds))
  } catch {
    // storage unavailable (private mode) — the list still works this session
  }
}

/** The counties waiting to be compared. Reactive so the nav badge and the
 *  "Add to shortlist" buttons update the moment one is added anywhere. */
export const shortlist = ref<string[]>(readStored())

/** Re-read from storage (boot in another tab, tests). */
export function reloadShortlist(): void {
  shortlist.value = readStored()
}

export function isShortlisted(geoId: string): boolean {
  return shortlist.value.includes(geoId)
}

/** Add a county. Returns false when the id is not a GEOID or the list is
 *  full — the caller says so in words rather than failing silently. */
export function addToShortlist(geoId: string): boolean {
  if (!isGeoId(geoId)) return false
  if (shortlist.value.includes(geoId)) return true
  if (shortlist.value.length >= MAX_COMPARE_COUNTIES) return false
  shortlist.value = [...shortlist.value, geoId]
  writeStored(shortlist.value)
  return true
}

export function removeFromShortlist(geoId: string): void {
  if (!shortlist.value.includes(geoId)) return
  shortlist.value = shortlist.value.filter(id => id !== geoId)
  writeStored(shortlist.value)
}

export function clearShortlist(): void {
  shortlist.value = []
  writeStored([])
}

// Logout already removes the key (the `blo:` prefix list in useAuth); the
// in-memory copy has to go too or the badge would keep counting. The layer
// index goes with it — it holds internal layer names (P5-19 audit).
registerLogoutHook(() => {
  shortlist.value = []
  layerIndexPromise = null
})

// --- Loading what the table shows -------------------------------------------

/**
 * Every layer a comparison can use, by id: the public map registry plus the
 * internal county layers this session is allowed to see.
 *
 * Cached for the session (and dropped at logout) because the callers are a
 * page and a wiki embed card that may both be on screen — asking the layer
 * API once is the point. Logged out, or with the library off, the public
 * half is still the bulk of it, so a failed manifest is silence.
 */
let layerIndexPromise: Promise<Map<string, LayerDefinition>> | null = null

export function compareLayerIndex(): Promise<Map<string, LayerDefinition>> {
  if (!layerIndexPromise) {
    layerIndexPromise = (async () => {
      const index = new Map<string, LayerDefinition>()
      const { publicLayers } = await import('@/lib/publicLayers')
      for (const layer of publicLayers()) index.set(layer.id, layer)
      try {
        // P5-89: the shared manifest — one request per session, whoever asks.
        const { sharedManifest, toLayerDefinition } = await import('@/lib/internalLayers')
        for (const entry of await sharedManifest()) {
          // Point layers have no value per county, so they cannot be a column.
          if (entry.geometry === 'county') index.set(entry.id, toLayerDefinition(entry))
        }
      } catch {
        // Logged out, or the library is off — nothing internal to add.
      }
      return index
    })()
    layerIndexPromise.catch(() => {
      layerIndexPromise = null
    })
  }
  return layerIndexPromise
}

/** Test seam / logout: forget the layer index. */
export function clearCompareLayerIndex(): void {
  layerIndexPromise = null
}

/**
 * One layer's numbers for every county, as a GEOID → value map.
 *
 * Public layers come from the map's own CSV loaders (P5-45's
 * `loadCountyRows`, one loader per layer); internal county layers come from
 * the authenticated layer API. Both are reached by dynamic import so this
 * module stays safe to import from the public map.
 *
 * An internal POINT layer has no county values — it resolves to an empty
 * column rather than an error, so a stale saved comparison still opens.
 */
export async function loadLayerColumn(layer: LayerDefinition): Promise<LayerColumn> {
  const column: LayerColumn = {}
  if (isInternalCompareLayer(layer.id)) {
    const { fetchInternalLayerValues } = await import('@/lib/internalLayers')
    const data = await fetchInternalLayerValues(layer.id.slice(INTERNAL_PREFIX.length))
    if (data?.geometry !== 'county' || !data.values) return column
    for (const [geoId, value] of Object.entries(data.values)) {
      column[geoId] = { value, display: layer.formatValue(value) }
    }
    return column
  }
  const { loadCountyRows } = await import('@/lib/publicLayers')
  for (const row of await loadCountyRows(layer)) {
    column[row.geoId] = { value: row.value, display: row.display }
  }
  return column
}

/**
 * Names and states for the shortlisted GEOIDs, in the order they were
 * picked. A county the lookup does not know still gets a row (its GEOID as
 * the name): dropping it would silently shrink the comparison.
 */
export async function loadCompareCounties(geoIds: string[]): Promise<CompareCounty[]> {
  const wanted = geoIds.filter(isGeoId).slice(0, MAX_COMPARE_COUNTIES)
  if (wanted.length === 0) return []
  const { initCountyLookup, getCountyByGeoId } = await import('@/lib/countyLookup')
  try {
    await initCountyLookup()
  } catch {
    // County names are a nicety; which counties were picked is the point.
    return wanted.map(geoId => ({ geoId, county: geoId, state: '' }))
  }
  return wanted.map(geoId => {
    const hit = getCountyByGeoId(geoId)
    return { geoId, county: hit?.name ?? geoId, state: hit?.stateName ?? '' }
  })
}

/** Counties whose name or state matches, for the picker's search box. */
export async function searchCounties(query: string, limit = 8): Promise<CompareCounty[]> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const { initCountyLookup, getAllCounties } = await import('@/lib/countyLookup')
  await initCountyLookup()
  const matches: CompareCounty[] = []
  for (const county of getAllCounties()) {
    if (`${county.name} ${county.stateName} ${county.stateAbbr}`.toLowerCase().includes(needle)) {
      matches.push({ geoId: county.geoId, county: county.name, state: county.stateName })
      if (matches.length >= limit) break
    }
  }
  return matches
}
