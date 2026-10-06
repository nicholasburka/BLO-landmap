import Papa from 'papaparse'
import { getFile } from './libraryBucket.js'
import { getCatalogEntry } from './libraryCatalog.js'

/**
 * Tabular service (P5-31): parse a library dataset file ONCE into rows +
 * an inferred schema with column stats, then answer paged / searched /
 * sorted / filtered row queries. The same parsed representation is what the
 * map layers project from (P5-18 county values, P5-24 points): one parser,
 * one cache.
 *
 * Paging bounds each RESPONSE, not what a caller may see: these routes are
 * internal-tier, and the same user can page to the end or download the file
 * whole. Nothing here is a confidentiality boundary — the auth guard is.
 *
 * Cells are kept as strings (what the file says); column types are inferred
 * for sorting, filtering, and stats. Files larger than TABULAR_MAX_BYTES or
 * longer than TABULAR_MAX_ROWS are refused with 413 ("download instead"),
 * files with no tabular shape with 415.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const TABULAR_MAX_BYTES = envInt('TABULAR_MAX_BYTES', 25 * 1024 * 1024)
export const TABULAR_MAX_ROWS = envInt('TABULAR_MAX_ROWS', 200_000)
export const ROWS_LIMIT_DEFAULT = 50
export const ROWS_LIMIT_MAX = 500
export const FILTERS_MAX = 20
/** Columns with at most this many distinct values get a topValues facet. */
const TOP_VALUES_MAX_DISTINCT = 200
const TOP_VALUES_N = 5
/** Type inference samples this many non-empty cells per column. */
const TYPE_SAMPLE = 1000

export class TabularError extends Error {
  constructor(
    public readonly status: 400 | 404 | 413 | 415,
    message: string,
  ) {
    super(message)
    this.name = 'TabularError'
  }
}

export type ColumnType = 'number' | 'string' | 'date' | 'boolean' | 'empty'

export interface ColumnStat {
  name: string
  type: ColumnType
  filled: number
  distinct: number
  min?: number
  max?: number
  mean?: number
  topValues?: { value: string; count: number }[]
}

export type Row = Record<string, string>

export interface ParsedDataset {
  /** Basename of the file inside the entry (what `?file=` addresses). */
  file: string
  columns: ColumnStat[]
  rows: Row[]
  rowCount: number
  bytes: number
  parsedAt: string
}

export type FilterOp = 'eq' | 'contains' | 'gte' | 'lte' | 'empty' | 'notEmpty'
const FILTER_OPS: ReadonlySet<string> = new Set<FilterOp>(['eq', 'contains', 'gte', 'lte', 'empty', 'notEmpty'])

export interface RowFilter {
  column: string
  op: FilterOp
  value?: string
}

export interface RowsQuery {
  q?: string
  sort?: string
  dir?: 'asc' | 'desc'
  filter?: RowFilter[]
  page?: number
  limit?: number
}

/** A row as served: every cell a string, plus `_row` (index in the parsed
 *  file — stable for the life of the parse, used by the row drawer). */
export interface ServedRow {
  [column: string]: string | number
  _row: number
}

export interface RowsPage {
  rows: ServedRow[]
  total: number
  page: number
  limit: number
}

// --- Parsing -----------------------------------------------------------------

const TABULAR_EXTENSIONS = new Set(['csv', 'tsv', 'json', 'geojson'])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Trim headers, name blanks, and de-duplicate so every column is addressable. */
function normalizeHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>()
  return raw.map((h, i) => {
    const base = (h ?? '').trim() || `column_${i + 1}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}_${n}`
  })
}

function parseDelimited(text: string, delimiter?: string): { columns: string[]; rows: Row[] } {
  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    ...(delimiter ? { delimiter } : {}),
  })
  const data = result.data.filter(r => Array.isArray(r))
  if (data.length === 0) return { columns: [], rows: [] }
  const columns = normalizeHeaders(data[0].map(c => String(c ?? '')))
  const rows: Row[] = []
  for (let i = 1; i < data.length; i++) {
    if (rows.length >= TABULAR_MAX_ROWS) throw tooManyRows()
    const cells = data[i]
    // Null-prototype: a column literally named __proto__ (a spreadsheet
    // accident, not usually an attack) is silently swallowed by a plain
    // object, and every later read of it hands back Object.prototype —
    // a 500 on a dataset the user is entitled to browse.
    const row: Row = Object.create(null)
    for (let c = 0; c < columns.length; c++) {
      const v = cells[c]
      row[columns[c]] = v == null ? '' : String(v)
    }
    rows.push(row)
  }
  return { columns, rows }
}

function cellString(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function rowsFromObjects(objects: Record<string, unknown>[], extra: string[] = []): { columns: string[]; rows: Row[] } {
  if (objects.length > TABULAR_MAX_ROWS) throw tooManyRows()
  const columns: string[] = []
  const seen = new Set<string>()
  for (const obj of objects) {
    for (const key of Object.keys(obj)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
    }
  }
  for (const key of extra) {
    if (!seen.has(key)) {
      seen.add(key)
      columns.push(key)
    }
  }
  const rows = objects.map(obj => {
    const row: Row = Object.create(null) // see parseDelimited
    for (const col of columns) row[col] = cellString(obj[col])
    return row
  })
  return { columns, rows }
}

function parseJson(text: string): { columns: string[]; rows: Row[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new TabularError(415, 'file is not valid JSON')
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every(isPlainObject)) throw new TabularError(415, 'JSON must be an array of objects')
    return rowsFromObjects(parsed as Record<string, unknown>[])
  }
  if (isPlainObject(parsed) && parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
    let anyPath = false
    const objects = (parsed.features as unknown[]).map(f => {
      const feature = isPlainObject(f) ? f : {}
      const props = isPlainObject(feature.properties) ? { ...feature.properties } : {}
      const geom = isPlainObject(feature.geometry) ? feature.geometry : null
      const coords = geom && geom.type === 'Point' && Array.isArray(geom.coordinates) ? geom.coordinates : null
      props._lng = coords && typeof coords[0] === 'number' ? coords[0] : ''
      props._lat = coords && typeof coords[1] === 'number' ? coords[1] : ''
      // P7-3: a line's vertices, kept rather than discarded. Compact JSON in
      // one cell, which `parseLinePath` reads back — the same column a
      // hand-written CSV can carry as WKT.
      const path = geom && (geom.type === 'LineString' || geom.type === 'MultiLineString') ? geom.coordinates : null
      if (path !== undefined && path !== null) {
        props._path = JSON.stringify(path)
        anyPath = true
      } else {
        props._path = ''
      }
      return props
    })
    // The column only exists when some feature is a line, so a point or
    // polygon collection's schema is exactly what it was before P7-3.
    if (!anyPath) for (const o of objects) delete (o as Record<string, unknown>)._path
    return rowsFromObjects(objects, anyPath ? ['_lng', '_lat', '_path'] : ['_lng', '_lat'])
  }
  throw new TabularError(415, 'JSON must be an array of objects or a GeoJSON FeatureCollection')
}

function tooManyRows(): TabularError {
  return new TabularError(413, `file has more than ${TABULAR_MAX_ROWS.toLocaleString()} rows — download it instead`)
}

/** Parse a file body into rows + schema. Pure: no catalog, no cache. */
export function parseTabular(buf: Buffer, fileKey: string): ParsedDataset {
  const ext = extensionOf(fileKey)
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const { columns, rows } =
    ext === 'json' || ext === 'geojson' ? parseJson(text) : parseDelimited(text, ext === 'tsv' ? '\t' : undefined)
  if (columns.length === 0) throw new TabularError(415, 'file has no tabular rows')
  return {
    file: fileKey.split('/').pop() ?? fileKey,
    columns: inferColumns(columns, rows),
    rows,
    rowCount: rows.length,
    bytes: buf.length,
    parsedAt: new Date().toISOString(),
  }
}

// --- Schema inference ----------------------------------------------------------

const NUMERIC_RE = /^[-+]?\d+(\.\d+)?$/
const DATE_RE = /^(\d{4}-\d{2}-\d{2}([T ].*)?|\d{1,2}\/\d{1,2}\/\d{2,4})$/
const BOOL_VALUES = new Set(['true', 'false', 'yes', 'no', 'y', 'n'])

/** Loose numeric parse: tolerates $, thousands commas, %, and whitespace. */
export function toNumber(cell: string): number | null {
  const cleaned = cell.replace(/[$,%\s]/g, '')
  if (!cleaned || !NUMERIC_RE.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function toDate(cell: string): number | null {
  const t = cell.trim()
  if (!DATE_RE.test(t)) return null
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : null
}

function inferType(sample: string[]): ColumnType {
  if (sample.length === 0) return 'empty'
  if (sample.every(v => BOOL_VALUES.has(v.trim().toLowerCase()))) return 'boolean'
  if (sample.every(v => toNumber(v) !== null)) return 'number'
  if (sample.every(v => toDate(v) !== null)) return 'date'
  return 'string'
}

function inferColumns(names: string[], rows: Row[]): ColumnStat[] {
  return names.map(name => {
    const counts = new Map<string, number>()
    let filled = 0
    const sample: string[] = []
    for (const row of rows) {
      const v = (row[name] ?? '').trim()
      if (!v) continue
      filled++
      counts.set(v, (counts.get(v) ?? 0) + 1)
      if (sample.length < TYPE_SAMPLE) sample.push(v)
    }
    const type = inferType(sample)
    const stat: ColumnStat = { name, type, filled, distinct: counts.size }
    if (type === 'number') {
      let min = Infinity
      let max = -Infinity
      let sum = 0
      let n = 0
      for (const [value, count] of counts) {
        const num = toNumber(value)
        if (num === null) continue
        min = Math.min(min, num)
        max = Math.max(max, num)
        sum += num * count
        n += count
      }
      if (n > 0) {
        stat.min = min
        stat.max = max
        stat.mean = sum / n
      }
    } else if (type !== 'empty' && counts.size <= TOP_VALUES_MAX_DISTINCT) {
      stat.topValues = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP_VALUES_N)
        .map(([value, count]) => ({ value, count }))
    }
    return stat
  })
}

// --- Querying ------------------------------------------------------------------

function columnType(ds: ParsedDataset, name: string): ColumnType {
  return ds.columns.find(c => c.name === name)?.type ?? 'string'
}

/** Comparable value for sorting/range filters; null = empty (sorts last). */
function keyFor(type: ColumnType, cell: string): number | string | null {
  const t = cell.trim()
  if (!t) return null
  if (type === 'number') return toNumber(t) ?? t.toLowerCase()
  if (type === 'date') return toDate(t) ?? t.toLowerCase()
  return t.toLowerCase()
}

function compareKeys(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function matchesFilter(ds: ParsedDataset, row: Row, f: RowFilter): boolean {
  const cell = row[f.column] ?? ''
  const trimmed = cell.trim()
  switch (f.op) {
    case 'empty':
      return trimmed === ''
    case 'notEmpty':
      return trimmed !== ''
    case 'eq':
      return trimmed.toLowerCase() === (f.value ?? '').trim().toLowerCase()
    case 'contains':
      return cell.toLowerCase().includes((f.value ?? '').toLowerCase())
    case 'gte':
    case 'lte': {
      const type = columnType(ds, f.column)
      const a = keyFor(type, cell)
      const b = keyFor(type, f.value ?? '')
      if (a === null || b === null) return false
      const c = compareKeys(a, b)
      return f.op === 'gte' ? c >= 0 : c <= 0
    }
  }
}

/** A row kept alongside its index in the parsed file (`_row`). */
export interface IndexedRow {
  row: Row
  i: number
}

/** Which rows the search + filters keep, in file order. Split out of
 *  queryRows so summaries (P5-42) describe exactly the set the table is
 *  showing: one definition of "the current filtered set", not two. */
export function filterRows(ds: ParsedDataset, q: Pick<RowsQuery, 'q' | 'filter'>): IndexedRow[] {
  let indexed: IndexedRow[] = ds.rows.map((row, i) => ({ row, i }))
  const needle = q.q?.trim().toLowerCase()
  if (needle) {
    indexed = indexed.filter(({ row }) => Object.values(row).some(v => v.toLowerCase().includes(needle)))
  }
  for (const f of q.filter ?? []) {
    indexed = indexed.filter(({ row }) => matchesFilter(ds, row, f))
  }
  return indexed
}

/** Sort in place of the file order: typed compare, empties always last,
 *  file order as the tie-break, `desc` reversing the filled block only. */
function sortRows(ds: ParsedDataset, indexed: IndexedRow[], sort: string, dir?: 'asc' | 'desc'): IndexedRow[] {
  const type = columnType(ds, sort)
  const keyed = indexed.map(item => ({ ...item, key: keyFor(type, item.row[sort] ?? '') }))
  const filled = keyed.filter(k => k.key !== null)
  const empties = keyed.filter(k => k.key === null)
  filled.sort((a, b) => compareKeys(a.key!, b.key!) || a.i - b.i)
  if (dir === 'desc') filled.reverse()
  return [...filled, ...empties]
}

/** The filtered rows in the requested order — every row, no paging. What
 *  the CSV export streams; queryRows is this plus a page slice. */
export function selectRows(ds: ParsedDataset, q: Pick<RowsQuery, 'q' | 'filter' | 'sort' | 'dir'>): IndexedRow[] {
  const indexed = filterRows(ds, q)
  return q.sort ? sortRows(ds, indexed, q.sort, q.dir) : indexed
}

export function queryRows(ds: ParsedDataset, q: RowsQuery): RowsPage {
  const limit = q.limit ?? ROWS_LIMIT_DEFAULT
  const page = q.page ?? 1
  const indexed = selectRows(ds, q)
  const total = indexed.length
  const start = (page - 1) * limit
  return {
    rows: indexed.slice(start, start + limit).map(({ row, i }): ServedRow => ({ ...row, _row: i })),
    total,
    page,
    limit,
  }
}

function firstParam(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

function parseIntParam(raw: unknown, name: string, min: number, max: number): number | { error: string } {
  const s = String(firstParam(raw)).trim()
  if (!/^\d+$/.test(s)) return { error: `${name} must be an integer between ${min} and ${max}` }
  const n = Number(s)
  if (n < min || n > max) return { error: `${name} must be an integer between ${min} and ${max}` }
  return n
}

/** Validate URL query params into a RowsQuery; every rejection names the field. */
export function parseRowsQuery(params: Record<string, unknown>, columns: string[]): RowsQuery | { error: string } {
  const known = new Set(columns)
  const out: RowsQuery = {}
  const q = firstParam(params.q)
  if (typeof q === 'string' && q.trim()) out.q = q.trim()

  const sort = firstParam(params.sort)
  if (sort !== undefined && sort !== '') {
    if (typeof sort !== 'string' || !known.has(sort)) return { error: `unknown column: ${String(sort)}` }
    out.sort = sort
  }
  const dir = firstParam(params.dir)
  if (dir !== undefined && dir !== '') {
    if (dir !== 'asc' && dir !== 'desc') return { error: 'dir must be asc or desc' }
    out.dir = dir
  }

  const filterRaw = firstParam(params.filter)
  if (filterRaw !== undefined && filterRaw !== '') {
    let parsed: unknown
    try {
      parsed = typeof filterRaw === 'string' ? JSON.parse(filterRaw) : filterRaw
    } catch {
      return { error: 'filter must be a JSON array of {column, op, value}' }
    }
    if (!Array.isArray(parsed)) return { error: 'filter must be a JSON array of {column, op, value}' }
    if (parsed.length > FILTERS_MAX) return { error: `filter: at most ${FILTERS_MAX} clauses` }
    const filters: RowFilter[] = []
    for (const item of parsed) {
      if (!isPlainObject(item)) return { error: 'filter clauses must be objects' }
      const column = item.column
      const op = item.op
      if (typeof column !== 'string' || !known.has(column)) return { error: `unknown column: ${String(column)}` }
      if (typeof op !== 'string' || !FILTER_OPS.has(op)) return { error: `filter op must be one of ${[...FILTER_OPS].join(', ')}` }
      const needsValue = op !== 'empty' && op !== 'notEmpty'
      const value = item.value
      if (needsValue && typeof value !== 'string' && typeof value !== 'number') {
        return { error: `filter value is required for op ${op}` }
      }
      filters.push(needsValue ? { column, op: op as FilterOp, value: String(value) } : { column, op: op as FilterOp })
    }
    if (filters.length > 0) out.filter = filters
  }

  if (params.page !== undefined && params.page !== '') {
    const page = parseIntParam(params.page, 'page', 1, Number.MAX_SAFE_INTEGER)
    if (typeof page !== 'number') return page
    out.page = page
  }
  if (params.limit !== undefined && params.limit !== '') {
    const limit = parseIntParam(params.limit, 'limit', 1, ROWS_LIMIT_MAX)
    if (typeof limit !== 'number') return limit
    out.limit = limit
  }
  return out
}

// --- Summaries (P5-42) -------------------------------------------------------------

/**
 * "What is in this column?" for a researcher who does not write code.
 * Everything here describes the CURRENT filtered set (the rows the table is
 * showing), never the whole file — that is the whole point: filter, then ask.
 */

/** One bar of the number histogram. `from`/`to` are the bin's edges; the
 *  last bin's `to` is the largest value itself, so the range is closed. */
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
  /** HISTOGRAM_BINS equal-width bins, or a single bin when every value is
   *  the same (ten zero-width bars would be a lie, not a chart). */
  histogram: HistogramBin[]
}

/** One period of the count-over-time series. `from` is the period's start as
 *  a plain string: "2024-03" for a month, "2024" for a year. */
export interface DateBucket {
  from: string
  count: number
}

/** The earliest and latest cell of a date column, as the file spells them,
 *  plus the counts per period behind the count-over-time chart (P5-54). */
export interface DateSummary {
  min: string
  max: string
  /** What one bucket covers. Months unless the range needs more of them
   *  than DATE_BUCKETS_MAX, in which case whole years. */
  unit: 'month' | 'year'
  /** Oldest first, EMPTY PERIODS INCLUDED — a two-year gap in the data has
   *  to read as a gap and not as a straight line between two points. */
  byMonth: DateBucket[]
}

export interface ColumnSummary {
  column: string
  type: ColumnType
  filled: number
  empty: number
  distinct: number
  /** Most common values, count descending, ties broken by value so the
   *  list is stable. Capped at SUMMARY_TOP_N — or SUMMARY_GROUP_TOP_N when
   *  the caller asked to group by this column (`?groupBy=1`), which is what
   *  makes "Group by" a cap change rather than a second endpoint. */
  top: { value: string; count: number }[]
  numbers: NumberSummary | null
  dates: DateSummary | null
}

export interface ColumnOverview {
  column: string
  type: ColumnType
  /** 0–100, one decimal: how much of the filtered set has a value here. */
  filledPct: number
  distinct: number
}

export const SUMMARY_TOP_N = 20
export const SUMMARY_GROUP_TOP_N = 200
export const HISTOGRAM_BINS = 10
/** Points on a count-over-time line. 120 is ten years of months — past that
 *  the line stops being readable at phone width, so the unit steps up. */
export const DATE_BUCKETS_MAX = 120

/** Count / distinct / min-max pass over one column of the filtered set. */
function tallyColumn(rows: IndexedRow[], column: string, wantNumbers: boolean, wantDates: boolean) {
  const counts = new Map<string, number>()
  const numbers: number[] = []
  const dates: number[] = []
  let filled = 0
  let minDate: { ms: number; text: string } | null = null
  let maxDate: { ms: number; text: string } | null = null
  for (const { row } of rows) {
    const value = (row[column] ?? '').trim()
    if (!value) continue
    filled++
    counts.set(value, (counts.get(value) ?? 0) + 1)
    if (wantNumbers) {
      const n = toNumber(value)
      if (n !== null) numbers.push(n)
    }
    if (wantDates) {
      const ms = toDate(value)
      if (ms !== null) {
        dates.push(ms)
        if (!minDate || ms < minDate.ms) minDate = { ms, text: value }
        if (!maxDate || ms > maxDate.ms) maxDate = { ms, text: value }
      }
    }
  }
  return { counts, filled, numbers, dates, minDate, maxDate }
}

/** The period a timestamp falls in, as the bucket's `from` string. Dates are
 *  parsed as UTC (see toDate), so the period is read in UTC too — otherwise a
 *  New Year's Day row would land in the previous year west of Greenwich. */
function periodOf(ms: number, unit: 'month' | 'year'): string {
  const d = new Date(ms)
  const year = String(d.getUTCFullYear()).padStart(4, '0')
  return unit === 'year' ? year : `${year}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Counts per period across the whole range, oldest first (P5-54). Months
 *  while they fit in DATE_BUCKETS_MAX, then whole years. */
function dateBuckets(values: number[]): { unit: 'month' | 'year'; byMonth: DateBucket[] } {
  const first = new Date(Math.min(...values))
  const last = new Date(Math.max(...values))
  const months =
    (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + (last.getUTCMonth() - first.getUTCMonth()) + 1
  const unit: 'month' | 'year' = months <= DATE_BUCKETS_MAX ? 'month' : 'year'

  const counts = new Map<string, number>()
  for (const ms of values) {
    const key = periodOf(ms, unit)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const byMonth: DateBucket[] = []
  if (unit === 'month') {
    const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1))
    for (let i = 0; i < months; i++) {
      const key = periodOf(cursor.getTime(), 'month')
      byMonth.push({ from: key, count: counts.get(key) ?? 0 })
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
  } else {
    for (let y = first.getUTCFullYear(); y <= last.getUTCFullYear(); y++) {
      const key = String(y).padStart(4, '0')
      byMonth.push({ from: key, count: counts.get(key) ?? 0 })
    }
  }
  // A range wider than 120 YEARS (a stray 1500 in a date column, usually)
  // would still blow the cap. Keep the recent end — that is the part anyone
  // reading a trend line is looking at.
  return { unit, byMonth: byMonth.length > DATE_BUCKETS_MAX ? byMonth.slice(-DATE_BUCKETS_MAX) : byMonth }
}

function numberSummary(values: number[]): NumberSummary | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const mean = sorted.reduce((sum, n) => sum + n, 0) / sorted.length
  const histogram: HistogramBin[] = []
  if (min === max) {
    histogram.push({ from: min, to: max, count: sorted.length })
  } else {
    const width = (max - min) / HISTOGRAM_BINS
    for (let b = 0; b < HISTOGRAM_BINS; b++) {
      histogram.push({ from: min + b * width, to: b === HISTOGRAM_BINS - 1 ? max : min + (b + 1) * width, count: 0 })
    }
    for (const v of sorted) {
      const b = Math.min(HISTOGRAM_BINS - 1, Math.floor(((v - min) / (max - min)) * HISTOGRAM_BINS))
      histogram[b].count++
    }
  }
  return { min, max, mean, median, histogram }
}

/** Summaries are cached against the PARSE, not the slug: when a reindex
 *  drops the parsed file (or the byte budget evicts it), every summary of
 *  it goes with it — no stale counts can outlive the rows they counted. */
let summaryCache = new WeakMap<ParsedDataset, Map<string, unknown>>()
/** Distinct filter signatures remembered per dataset (oldest evicted). */
const SUMMARY_CACHE_PER_DATASET = 64

function filtersSignature(q: Pick<RowsQuery, 'q' | 'filter'>): string {
  return JSON.stringify([q.q ?? '', (q.filter ?? []).map(f => [f.column, f.op, f.value ?? ''])])
}

function cachedSummary<T>(ds: ParsedDataset, key: string, make: () => T): T {
  let byKey = summaryCache.get(ds)
  if (!byKey) {
    byKey = new Map()
    summaryCache.set(ds, byKey)
  }
  if (byKey.has(key)) return byKey.get(key) as T
  const value = make()
  byKey.set(key, value)
  // A Map iterates in insertion order, so the head is the oldest entry.
  for (const oldest of byKey.keys()) {
    if (byKey.size <= SUMMARY_CACHE_PER_DATASET) break
    byKey.delete(oldest)
  }
  return value
}

/** One column of the filtered set, in the terms the panel shows: how much
 *  is filled in, how many different values, the most common ones, and —
 *  for numbers and dates — the range. */
export function summarizeColumn(
  ds: ParsedDataset,
  column: string,
  query: Pick<RowsQuery, 'q' | 'filter'> = {},
  options: { topLimit?: number } = {},
): ColumnSummary {
  const topLimit = options.topLimit ?? SUMMARY_TOP_N
  return cachedSummary(ds, `column ${column} ${topLimit} ${filtersSignature(query)}`, () => {
    const type = columnType(ds, column)
    const rows = filterRows(ds, query)
    const { counts, filled, numbers, dates, minDate, maxDate } = tallyColumn(rows, column, type === 'number', type === 'date')
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topLimit)
      .map(([value, count]) => ({ value, count }))
    return {
      column,
      type,
      filled,
      empty: rows.length - filled,
      distinct: counts.size,
      top,
      numbers: type === 'number' ? numberSummary(numbers) : null,
      dates:
        type === 'date' && minDate && maxDate
          ? { min: minDate.text, max: maxDate.text, ...dateBuckets(dates) }
          : null,
    }
  })
}

/** Every column of the filtered set at a glance — the "Summaries" list. */
export function overviewColumns(ds: ParsedDataset, query: Pick<RowsQuery, 'q' | 'filter'> = {}): ColumnOverview[] {
  return cachedSummary(ds, `overview ${filtersSignature(query)}`, () => {
    const rows = filterRows(ds, query)
    return ds.columns.map(c => {
      const { counts, filled } = tallyColumn(rows, c.name, false, false)
      return {
        column: c.name,
        type: c.type,
        filledPct: rows.length === 0 ? 0 : Math.round((filled / rows.length) * 1000) / 10,
        distinct: counts.size,
      }
    })
  })
}

// --- CSV export (P5-42) -------------------------------------------------------------

/**
 * A cell that opens a spreadsheet as a FORMULA rather than as text — the
 * CSV-injection classic. A leading apostrophe is the portable fix (Excel,
 * Sheets, and LibreOffice all read the rest as literal text). It also
 * escapes a leading "-", so a negative number exports as '-5: safety wins
 * over tidiness in a file we hand to someone else's spreadsheet.
 */
const FORMULA_START = /^[=+\-@]/

export function csvCell(value: string): string {
  const text = FORMULA_START.test(value) ? `'${value}` : value
  return /["\r\n,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** RFC 4180 CSV (CRLF endings) of `columns` out of `rows`. `header: false`
 *  writes rows only, so a large export can be streamed in chunks. */
export function toCsv(columns: string[], rows: Iterable<Row>, options: { header?: boolean } = {}): string {
  const lines: string[] = []
  if (options.header !== false) lines.push(columns.map(csvCell).join(','))
  for (const row of rows) lines.push(columns.map(c => csvCell(row[c] ?? '')).join(','))
  return lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`
}

// --- Catalog-backed reads + cache ------------------------------------------------

export interface TabularFileRef {
  key: string
  size: number
  name: string
}

/** Basename inside the entry folder (mirrors the client's fileName helper). */
function basenameInEntry(key: string): string {
  return key.split('/').slice(3).join('/') || key
}

/** Which files in an entry can be browsed as a table, and which one is chosen. */
export function pickTabularFile(
  files: { key: string; size: number }[],
  requested?: string,
): { candidates: string[]; chosen: TabularFileRef | null } {
  const refs = files
    .map(f => ({ key: f.key, size: f.size, name: basenameInEntry(f.key) }))
    .filter(f => TABULAR_EXTENSIONS.has(extensionOf(f.name)) && !f.name.endsWith('meta.json'))
  const candidates = refs.map(r => r.name)
  if (requested) return { candidates, chosen: refs.find(r => r.name === requested) ?? null }
  return { candidates, chosen: refs[0] ?? null }
}

/** Total file bytes the parse cache may hold. Parsed rows cost a multiple
 *  of the file on the heap, so this is a floor on the footprint, not a
 *  ceiling — but an unbounded Map of 25 MB files is how a long-lived
 *  process runs out of memory one browsed dataset at a time. */
export const TABULAR_CACHE_MAX_BYTES = envInt('TABULAR_CACHE_MAX_BYTES', 100 * 1024 * 1024)

const cache = new Map<string, { size: number; parsed: ParsedDataset }>()
let cacheBytes = 0
/** Parses in progress, so N simultaneous readers of one file download and
 *  parse it once rather than N times. */
const inFlight = new Map<string, Promise<ParsedDataset>>()

/** Drop every parsed file. Called after reindex (files may have changed
 *  behind the running server's back — same rule as the mirror sync). */
export function clearTabularCache(): void {
  cache.clear()
  cacheBytes = 0
  inFlight.clear()
  // Summaries are counts OF those rows; they must not outlive them.
  summaryCache = new WeakMap()
}

/** What the cache is holding — for tests and for an ops eye on memory. */
export function tabularCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cacheBytes }
}

function remember(key: string, size: number, parsed: ParsedDataset): void {
  const previous = cache.get(key)
  if (previous) cacheBytes -= previous.size
  cache.delete(key)
  cache.set(key, { size, parsed })
  cacheBytes += size
  // A Map iterates in insertion order, so the head is the oldest entry.
  for (const [oldest, entry] of cache) {
    if (cacheBytes <= TABULAR_CACHE_MAX_BYTES || cache.size <= 1) break
    cache.delete(oldest)
    cacheBytes -= entry.size
  }
}

function parseShared(chosen: TabularFileRef): Promise<ParsedDataset> {
  const pending = inFlight.get(chosen.key)
  if (pending) return pending
  const job = (async () => {
    const parsed = parseTabular(await getFile(chosen.key), chosen.key)
    parsed.file = chosen.name
    remember(chosen.key, chosen.size, parsed)
    return parsed
  })().finally(() => {
    inFlight.delete(chosen.key)
  })
  inFlight.set(chosen.key, job)
  return job
}

export interface DatasetRead {
  entry: { slug: string; title: string; kind: string; meta: Record<string, unknown> }
  candidates: string[]
  parsed: ParsedDataset
}

/** Resolve slug (+ optional file basename) → parsed dataset, via the cache. */
export async function readDataset(slug: string, requestedFile?: string): Promise<DatasetRead> {
  const entry = await getCatalogEntry(slug)
  if (!entry) throw new TabularError(404, 'not found')
  const { candidates, chosen } = pickTabularFile(entry.files ?? [], requestedFile)
  if (!chosen) {
    if (requestedFile) throw new TabularError(404, 'file not found')
    throw new TabularError(415, 'this entry has no tabular file (csv, tsv, json, geojson)')
  }
  if (chosen.size > TABULAR_MAX_BYTES) {
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`
    throw new TabularError(413, `${chosen.name} is ${mb(chosen.size)} — larger than the ${mb(TABULAR_MAX_BYTES)} browse limit; download it instead`)
  }
  const hit = cache.get(chosen.key)
  if (hit && hit.size === chosen.size) {
    return { entry: { slug: entry.slug, title: entry.title, kind: entry.kind, meta: entry.meta ?? {} }, candidates, parsed: hit.parsed }
  }
  const parsed = await parseShared(chosen)
  return { entry: { slug: entry.slug, title: entry.title, kind: entry.kind, meta: entry.meta ?? {} }, candidates, parsed }
}
