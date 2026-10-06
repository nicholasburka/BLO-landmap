/**
 * County context for any table (P5-48).
 *
 * A researcher looking at a list of organizations, grants or parcels almost
 * always asks the same next question: "what is that county like?" The public
 * map already knows — median home value, poverty, life expectancy, one number
 * per county — so the answer is a join, not a new dataset.
 *
 * The join is client-side and deliberately narrow:
 *  - it happens on the rows CURRENTLY on screen, so a 200k-row file costs the
 *    same as a 25-row page;
 *  - the key is a 5-digit county GEOID that the dataset already carries (its
 *    own column, or the one P5-23's geocoder wrote next to lat/lng) — nothing
 *    here geocodes anything;
 *  - the values come from `loadCountyRows` (P5-45), which is the one loader
 *    for a layer's county numbers. One layer at a time, never the whole map.
 *
 * Everything below is pure except `loadContextValues`, so the join, the
 * sorting and the CSV are all testable without a browser.
 */
import type { LayerDefinition } from '@/config/layerRegistry'
import { csvCell, type DatasetRow } from './libraryData'
import {
  LAYER_DATA_SOURCES,
  getPublicLayer,
  groupLayers,
  loadCountyRows,
  publicLayers,
  searchLayers,
  type CountyValueRow,
  type LayerGroup,
} from './publicLayers'

/** What an unjoinable row shows. A blank cell reads as "zero" or "broken";
 *  an em dash reads as "we have no county for this row". */
export const MISSING_VALUE = '—'

/** Each layer is a separate CSV download, so this is both a sanity limit for
 *  the table's width and the bound that keeps a hand-edited `?layers=` from
 *  pulling twenty datasets at once. */
export const MAX_CONTEXT_LAYERS = 6

/** Column names that mean "the county this row is in". `GEOID` is what the
 *  map, the geocoder (P5-23) and the census files all use; `fips` is what
 *  people type by hand. Compared with punctuation and case stripped, so
 *  `County FIPS` and `county_fips` are the same name. */
const GEOID_COLUMN_NAMES = new Set(['geoid', 'fips', 'countyfips', 'fipscode', 'countygeoid', 'geoid5'])

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * A cell as a 5-digit county GEOID, or null when it is not one.
 *
 * Two forgiving cases, both from real files: a spreadsheet that dropped the
 * leading zero ("1001" is Autauga County, Alabama) and a CSV written from a
 * float column ("01001.0"). Anything else — a tract, a ZIP, a name — is not
 * a county and gets no context rather than a wrong one.
 */
export function normalizeGeoId(value: unknown): string | null {
  if (typeof value === 'number') return normalizeGeoId(String(value))
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\.0+$/, '')
  if (/^\d{5}$/.test(trimmed)) return trimmed
  if (/^\d{4}$/.test(trimmed)) return `0${trimmed}`
  return null
}

/** The row's county, or null when the row has none. */
export function rowGeoId(row: DatasetRow, column: string | null): string | null {
  if (!column) return null
  return normalizeGeoId(row[column])
}

/**
 * Which column holds the county GEOID, if any. Named candidates only — a
 * column of five-digit numbers could be anything (a ZIP, a score) — and when
 * rows are given at least one of them has to actually parse, so a `FIPS`
 * column full of state codes does not switch the feature on.
 */
export function findGeoIdColumn(columns: { name: string }[], rows: DatasetRow[] = []): string | null {
  const candidates = columns.filter(c => GEOID_COLUMN_NAMES.has(normalizeName(c.name)))
  if (candidates.length === 0) return null
  // `GEOID` wins over `fips` when a file carries both: it is the spelling our
  // own geocoder writes, so it is the one we know is county-level.
  const ordered = [...candidates].sort(
    (a, b) => Number(normalizeName(b.name) === 'geoid') - Number(normalizeName(a.name) === 'geoid'),
  )
  if (rows.length === 0) return ordered[0].name
  return ordered.find(c => rows.some(row => normalizeGeoId(row[c.name]) !== null))?.name ?? null
}

// --- Which layers can be joined ---------------------------------------------

/** Public county layers with a loader behind them. A layer with no entry in
 *  LAYER_DATA_SOURCES has no county numbers to offer. */
export function contextLayers(): LayerDefinition[] {
  return publicLayers().filter(layer => layer.id in LAYER_DATA_SOURCES)
}

export function isContextLayerId(id: string): boolean {
  return !!getPublicLayer(id) && id in LAYER_DATA_SOURCES
}

/** The picker's list: the same categories, in the same order, as /layers. */
export function contextLayerGroups(query = ''): LayerGroup[] {
  return groupLayers(searchLayers(contextLayers(), query))
}

export function contextLayerName(id: string): string {
  return getPublicLayer(id)?.name ?? id
}

// --- URL state ---------------------------------------------------------------

type QueryValue = string | string[] | null | undefined

/** `?layers=median_home_value,poverty_by_race` → the ids we can actually
 *  join. Unknown ids are dropped rather than thrown: a stale or hand-edited
 *  link degrades to a plain table. */
export function parseContextLayers(value: QueryValue): string[] {
  const chunks = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const ids: string[] = []
  for (const chunk of chunks) {
    for (const raw of chunk.split(',')) {
      const id = raw.trim()
      if (ids.length >= MAX_CONTEXT_LAYERS) break
      if (id && !ids.includes(id) && isContextLayerId(id)) ids.push(id)
    }
  }
  return ids
}

/** The `layers` query value, or '' when nothing is selected (the caller
 *  drops the key entirely so the URL stays clean). */
export function contextLayersParam(ids: string[]): string {
  return ids.filter(isContextLayerId).slice(0, MAX_CONTEXT_LAYERS).join(',')
}

// --- The join --------------------------------------------------------------

/** One layer's numbers, ready to look up by GEOID. */
export type CountyValues = Map<string, CountyValueRow>

/** Load one layer's county values. Lazy and one layer at a time by design:
 *  `loadCountyRows` pulls that layer's CSV, and pulling five at once is how
 *  a table page turns into a five-megabyte download. */
export async function loadContextValues(layerId: string): Promise<CountyValues> {
  const layer = getPublicLayer(layerId)
  if (!layer) throw new Error(`Unknown layer "${layerId}"`)
  const rows = await loadCountyRows(layer)
  return new Map(rows.map(row => [row.geoId, row]))
}

/** The cell text for one row and one layer — the layer's own formatter (so
 *  the table reads like the map) or the missing marker. */
export function contextCell(values: CountyValues | undefined, geoId: string | null): string {
  if (!values || !geoId) return MISSING_VALUE
  return values.get(geoId)?.display ?? MISSING_VALUE
}

/** The number behind the cell, for sorting. */
export function contextValue(values: CountyValues | undefined, geoId: string | null): number | string | null {
  if (!values || !geoId) return null
  return values.get(geoId)?.value ?? null
}

export type SortDirection = 'asc' | 'desc'

/** Sort the rows on screen by a joined column. Client-side because the
 *  column is client-side: the server has never heard of it. Rows with no
 *  county value sink to the bottom whichever way the column points — a blank
 *  is not the biggest number (same rule as the county tables in P5-45). */
export function sortRowsByContext(
  rows: DatasetRow[],
  geoIdColumn: string | null,
  values: CountyValues | undefined,
  direction: SortDirection,
): DatasetRow[] {
  const sign = direction === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const av = contextValue(values, rowGeoId(a, geoIdColumn))
    const bv = contextValue(values, rowGeoId(b, geoIdColumn))
    if (av == null || bv == null) return (av == null ? 1 : 0) - (bv == null ? 1 : 0)
    if (typeof av === 'number' && typeof bv === 'number') return sign * (av - bv)
    return sign * String(av).localeCompare(String(bv))
  })
}

export interface ContextColumn {
  /** The layer's name — what the column header says. */
  name: string
  values: CountyValues | undefined
}

/**
 * A joined column as the table holds one: an id to sort by, a header, and the
 * values.
 *
 * P5-48's county layers were the only kind when this file was written, so the
 * id was the layer id. P7-2 adds a second kind — a working set's derived
 * columns, which arrive already keyed by GEOID — and the table does not need
 * to know which kind it is looking at: it sorts by `id`, prints `values`
 * through `contextCell`, and writes `name` into the CSV. The ids are namespaced
 * by whoever makes them (`derived:<column>`) so two kinds cannot collide.
 */
export interface JoinedColumn extends ContextColumn {
  id: string
}

/**
 * The page as a CSV, joined columns included. The server export (P5-42) has
 * never seen these columns and must not be asked to invent them, so this one
 * is built in the browser from exactly what is on screen. Same cell escaping
 * as the server writes (`csvCell`), same CRLF line endings.
 */
export function tableCsv(
  rows: DatasetRow[],
  columns: string[],
  geoIdColumn: string | null,
  context: ContextColumn[],
): string {
  const lines = [[...columns, ...context.map(c => c.name)].map(csvCell).join(',')]
  for (const row of rows) {
    const geoId = rowGeoId(row, geoIdColumn)
    const cells = columns.map(name => csvCell(typeof row[name] === 'string' ? (row[name] as string) : ''))
    for (const column of context) cells.push(csvCell(contextCell(column.values, geoId)))
    lines.push(cells.join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}
