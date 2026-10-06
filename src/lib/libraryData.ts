/**
 * Dataset explorer helpers (P5-31). Types mirror the server's tabular
 * service (server/src/services/libraryTabular.ts) — keep in sync by hand.
 *
 * The URL is the source of truth for a table view: `parseRowsState` reads
 * route.query into a RowsState and `buildRowsQuery` writes it back, so a
 * filtered/sorted table is linkable from wiki pages and survives reload.
 */
import { API_URL, internalFetch } from './apiBase'

export type ColumnType = 'number' | 'string' | 'date' | 'boolean' | 'empty'

export interface DatasetColumn {
  name: string
  type: ColumnType
  filled: number
  distinct: number
  min?: number
  max?: number
  mean?: number
  topValues?: { value: string; count: number }[]
}

export interface DatasetSchema {
  entry: { slug: string; title: string; kind: string }
  /** P5-36: the internal map layer this entry powers (names only), or null. */
  layer?: { id: string; geometry: 'county' | 'point' | 'line' | 'state'; name: string; labelKey: string | null } | null
  file: string
  files: string[]
  columns: DatasetColumn[]
  rowCount: number
  bytes: number
  parsedAt: string
}

export type FilterOp = 'eq' | 'contains' | 'gte' | 'lte' | 'empty' | 'notEmpty'
export const FILTER_OPS: FilterOp[] = ['contains', 'eq', 'gte', 'lte', 'empty', 'notEmpty']

export interface RowFilter {
  column: string
  op: FilterOp
  value?: string
}

export interface RowsState {
  file?: string
  q?: string
  sort?: string
  dir?: 'asc' | 'desc'
  filter?: RowFilter[]
  page?: number
  limit?: number
}

/** A served row: every cell a string plus `_row`, the row's index in the
 *  parsed file (stable for the life of the parse; used by the row drawer). */
export interface DatasetRow {
  [column: string]: string | number
  _row: number
}

export interface RowsPage {
  rows: DatasetRow[]
  total: number
  page: number
  limit: number
}

export const ROWS_LIMIT_DEFAULT = 50
export const ROWS_LIMIT_MAX = 500

/** Server refusal with its status + user-facing message (404/413/415/400). */
export class DatasetRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DatasetRequestError'
  }
}

type QueryValue = string | string[] | null | undefined

function first(value: QueryValue): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' && v !== '' ? v : undefined
}

function isFilterOp(op: unknown): op is FilterOp {
  return typeof op === 'string' && (FILTER_OPS as string[]).includes(op)
}

/** route.query → RowsState. Invalid values are dropped, never thrown — a
 *  hand-edited or stale URL degrades to the default view. */
export function parseRowsState(query: Record<string, QueryValue>): RowsState {
  const state: RowsState = {}
  const file = first(query.file)
  if (file) state.file = file
  const q = first(query.q)?.trim()
  if (q) state.q = q
  const sort = first(query.sort)
  if (sort) state.sort = sort
  const dir = first(query.dir)
  if (dir === 'asc' || dir === 'desc') state.dir = dir
  const filterRaw = first(query.filter)
  if (filterRaw) {
    try {
      const parsed: unknown = JSON.parse(filterRaw)
      if (Array.isArray(parsed)) {
        const filters: RowFilter[] = []
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue
          const { column, op, value } = item as Record<string, unknown>
          if (typeof column !== 'string' || !column || !isFilterOp(op)) continue
          const needsValue = op !== 'empty' && op !== 'notEmpty'
          if (needsValue && typeof value !== 'string') continue
          filters.push(needsValue ? { column, op, value: value as string } : { column, op })
        }
        if (filters.length) state.filter = filters
      }
    } catch {
      /* malformed filter param — ignore */
    }
  }
  const page = Number(first(query.page))
  if (Number.isInteger(page) && page > 1) state.page = page
  const limit = Number(first(query.limit))
  if (Number.isInteger(limit) && limit >= 1 && limit <= ROWS_LIMIT_MAX && limit !== ROWS_LIMIT_DEFAULT) state.limit = limit
  return state
}

/** RowsState → query string ('' when everything is default). Defaults
 *  (page 1, limit 50) are omitted so canonical URLs stay short. */
export function buildRowsQuery(state: RowsState): string {
  const params = new URLSearchParams()
  if (state.file) params.set('file', state.file)
  if (state.q?.trim()) params.set('q', state.q.trim())
  if (state.sort) {
    params.set('sort', state.sort)
    if (state.dir === 'desc') params.set('dir', 'desc')
  }
  if (state.filter?.length) params.set('filter', JSON.stringify(state.filter))
  if (state.page && state.page > 1) params.set('page', String(state.page))
  if (state.limit && state.limit !== ROWS_LIMIT_DEFAULT) params.set('limit', String(state.limit))
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/** Same state as a plain object for router.replace({ query }). */
export function rowsStateToQuery(state: RowsState): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(buildRowsQuery(state)).entries())
}

async function readError(res: Response, fallback: string): Promise<DatasetRequestError> {
  let message = fallback
  try {
    const body = await res.json()
    if (body && typeof body.error === 'string') message = body.error
  } catch {
    /* non-JSON body */
  }
  return new DatasetRequestError(res.status, message)
}

export async function fetchDatasetSchema(slug: string, file?: string): Promise<DatasetSchema> {
  const qs = file ? `?file=${encodeURIComponent(file)}` : ''
  const res = await internalFetch(`/api/library/data/${encodeURIComponent(slug)}${qs}`)
  if (!res.ok) throw await readError(res, `dataset request failed (${res.status})`)
  return (await res.json()) as DatasetSchema
}

export async function fetchDatasetRows(slug: string, state: RowsState): Promise<RowsPage> {
  const res = await internalFetch(`/api/library/data/${encodeURIComponent(slug)}/rows${buildRowsQuery(state)}`)
  if (!res.ok) throw await readError(res, `dataset rows request failed (${res.status})`)
  return (await res.json()) as RowsPage
}

// --- Summaries + export (P5-42) ------------------------------------------------

/** One bar of the number histogram; the last bin's `to` is the largest value. */
export interface HistogramBin {
  from: number
  to: number
  count: number
}

export interface NumberSummary {
  min: number
  max: number
  mean: number
  median: number
  /** Ten equal bins — or a single bin when every value is the same. */
  histogram: HistogramBin[]
}

/** One period of the count-over-time series: "2024-03" (a month) or "2024"
 *  (a year), and how many rows fall in it. */
export interface DateBucket {
  from: string
  count: number
}

export interface DateSummary {
  min: string
  max: string
  /** P5-54: what one bucket covers. Optional so an older response (or a
   *  hand-built fixture) simply draws no timeline. */
  unit?: 'month' | 'year'
  /** Counts per period, oldest first, empty periods included. */
  byMonth?: DateBucket[]
}

/** What one column looks like across the rows currently on screen. */
export interface ColumnSummary {
  column: string
  type: ColumnType
  filled: number
  empty: number
  distinct: number
  /** Most common values, commonest first (≤ 20, or ≤ 200 when grouping). */
  top: { value: string; count: number }[]
  numbers: NumberSummary | null
  dates: DateSummary | null
}

export interface ColumnOverview {
  column: string
  type: ColumnType
  /** 0–100: how much of the filtered set has a value in this column. */
  filledPct: number
  distinct: number
}

/** Plain words for a column type — nobody outside a database asks for a
 *  "varchar". Used by the summary panel's one-line description. */
export const TYPE_WORDS: Record<ColumnType, string> = {
  number: 'numbers',
  string: 'text',
  date: 'dates',
  boolean: 'yes / no',
  empty: 'always blank',
}

/** The part of a table view that decides WHICH rows: file + search +
 *  filters. Summaries describe that set, so sort/page/limit are left out
 *  (the export adds sort back — the order it writes matters). */
function filterParams(state: RowsState): URLSearchParams {
  const params = new URLSearchParams()
  if (state.file) params.set('file', state.file)
  if (state.q?.trim()) params.set('q', state.q.trim())
  if (state.filter?.length) params.set('filter', JSON.stringify(state.filter))
  return params
}

async function getJson<T>(path: string, fallback: string): Promise<T> {
  const res = await internalFetch(path)
  if (!res.ok) throw await readError(res, fallback)
  return (await res.json()) as T
}

/** One column's distribution over the current filtered set. `groupBy`
 *  raises the server's most-common cap from 20 to 200 — that larger list
 *  IS the group-by table. */
export function fetchColumnSummary(
  slug: string,
  state: RowsState,
  column: string,
  options: { groupBy?: boolean } = {},
): Promise<ColumnSummary> {
  const params = filterParams(state)
  params.set('column', column)
  if (options.groupBy) params.set('groupBy', '1')
  return getJson<ColumnSummary>(
    `/api/library/data/${encodeURIComponent(slug)}/summary?${params.toString()}`,
    'summary request failed',
  )
}

/** Every column of the current filtered set, one line each. */
export function fetchColumnOverview(slug: string, state: RowsState): Promise<ColumnOverview[]> {
  const qs = filterParams(state).toString()
  return getJson<ColumnOverview[]>(
    `/api/library/data/${encodeURIComponent(slug)}/summary${qs ? `?${qs}` : ''}`,
    'summary request failed',
  )
}

/** Download URL for the filtered rows as CSV. A plain link works: the
 *  session cookie rides along on a top-level navigation and the server
 *  answers with Content-Disposition: attachment (same as libraryFileUrl).
 *  `columns` narrows the file to the columns on screen. */
export function datasetExportUrl(slug: string, state: RowsState, columns?: string[]): string {
  const params = filterParams(state)
  if (state.sort) {
    params.set('sort', state.sort)
    if (state.dir === 'desc') params.set('dir', 'desc')
  }
  if (columns?.length) params.set('columns', JSON.stringify(columns))
  const qs = params.toString()
  return `${API_URL}/api/library/data/${encodeURIComponent(slug)}/export.csv${qs ? `?${qs}` : ''}`
}

/** A cell that would open as a spreadsheet FORMULA is prefixed with an
 *  apostrophe, then quoted if it needs it. Mirrors the server's csvCell
 *  (server/src/services/libraryTabular.ts) — keep the two in step. */
export function csvCell(value: string): string {
  const text = /^[=+\-@]/.test(value) ? `'${value}` : value
  return /["\r\n,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The group-by table as a CSV the browser can save without a round trip:
 *  value, how many rows, and what share of the filtered set that is. */
export function groupByCsv(column: string, values: { value: string; count: number }[], matched: number): string {
  const lines = [[column, 'Count', 'Percent'].map(csvCell).join(',')]
  for (const v of values) {
    lines.push([csvCell(v.value), String(v.count), matched > 0 ? ((v.count / matched) * 100).toFixed(1) : '0.0'].join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

/** A share as a person reads it: whole percents once it is big enough to
 *  round, one decimal below that, never "NaN%". */
export function sharePct(count: number, total: number): string {
  if (!total || total <= 0) return '0%'
  const pct = (count / total) * 100
  if (pct > 0 && pct < 1) return `${(Math.round(pct * 10) / 10).toFixed(1)}%`
  return `${Math.round(pct)}%`
}

/** Numbers as a reader expects them: thousands separated, no long tails. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return value.toLocaleString()
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

const TABULAR_EXTENSIONS = new Set(['csv', 'tsv', 'json', 'geojson'])

/** Does a catalog entry have a file the explorer can open? (basename check
 *  mirrors the server's pickTabularFile — meta.json is never data). */
export function hasTabularFile(files: { key: string }[]): boolean {
  return files.some(f => {
    const name = f.key.split('/').slice(3).join('/') || f.key
    if (name.endsWith('meta.json')) return false
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    return TABULAR_EXTENSIONS.has(ext)
  })
}

/** Cell text for a column (the `_row` marker is never a cell). */
export function cellOf(row: DatasetRow, column: string): string {
  const v = row[column]
  return typeof v === 'string' ? v : ''
}

/** Absolute http(s) URLs render as links in the row drawer; nothing else does. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

/** Compact stat line for the schema panel, e.g. "number · 73/100 filled · 50 – 1,200". */
export function describeColumn(col: DatasetColumn, rowCount: number): string {
  const parts = [col.type, `${col.filled}/${rowCount} filled`]
  if (col.type === 'number' && col.min != null && col.max != null) {
    parts.push(`${col.min.toLocaleString()} – ${col.max.toLocaleString()}`)
  } else if (col.type !== 'empty') {
    parts.push(`${col.distinct} distinct`)
  }
  return parts.join(' · ')
}
