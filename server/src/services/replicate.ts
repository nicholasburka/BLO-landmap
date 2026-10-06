import Papa from 'papaparse'
import { getFile, putFile, isBucketEnabled } from './libraryBucket.js'
import { libraryQuery, isLibraryEnabled, writeAudit } from './libraryDb.js'
import { getCatalogEntry, indexFileBackedEntry, slugify, type CatalogEntryDetail } from './libraryCatalog.js'
import { guardedGet, guardedJson, PlaceFetchError, type GuardedGetOptions } from './placeHttp.js'
import { pickAccess, sourceBlockOf } from './placeFetch.js'
import { patchEntryManifest } from './entryManifest.js'
import { queueSuggestion, type LinkFetchJob } from './linkFetchQueue.js'
import { parseInspection, toLonLat, WEB_MERCATOR_WKIDS, declaredCrs } from './linkInspect.js'
import { parseIngestPlan } from './ingestPlan.js'
import { countyFipsField } from './sourceProposal.js'
import { TABULAR_MAX_ROWS } from './libraryTabular.js'
import { LAT_COLUMN_RE, LNG_COLUMN_RE } from './placeAdapters/shared.js'
import type { SourceAccess } from './sourceMeta.js'

/**
 * "Replicate now" (P5-59).
 *
 * The moment a source stops being a pointer and becomes something we hold: the
 * whole dataset, paged in, written as a plain CSV (plus GeoJSON when there is
 * geometry) under `library/datasets/<slug>/`, at status `needs-review`. From
 * there the ORDINARY pipeline applies — clean, file, explore, publish, map —
 * which is why this produces a normal dataset entry and not a special kind.
 *
 * Two things it deliberately will not do:
 *  - copy more than the caps allow. Over them the plan falls back to
 *    fetch-on-demand with a note, because a half-copied table is worse than an
 *    honest pointer.
 *  - write coordinates it cannot vouch for. Web Mercator is converted with
 *    arithmetic; any other projection is refused by name, because "the
 *    latitudes are all 3,990,000" is a bug nobody finds for months.
 */

/** Most bytes one replication may pull. 100 MB is a large national CSV and a
 *  long way short of what would hurt the box the public map shares. */
export function replicateMaxBytes(): number {
  const raw = Number(process.env.REPLICATE_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100 * 1024 * 1024
}

/** Most rows. The explorer refuses to parse a file bigger than this anyway, so
 *  copying more would produce a dataset nobody could open. */
export function replicateMaxRows(): number {
  const raw = Number(process.env.REPLICATE_MAX_ROWS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : TABULAR_MAX_ROWS
}

/** Rows asked for per ArcGIS/Socrata request. Servers cap this themselves. */
export const REPLICATE_PAGE_SIZE = 1_000
/** A stop even if every page says there is more — a source that never ends
 *  must not hold the queue for an afternoon. */
const PAGE_HARD_CAP = 2_000

export interface ReplicateInput {
  slug: string
  actor: string
  userId: number | null
  clientIp?: string
  /** Overrides for one run; production passes neither. */
  maxRows?: number
  maxBytes?: number
  /** Test seam. */
  http?: GuardedGetOptions
}

export type ReplicateOutcome =
  | { ok: true; dataset: string; rows: number; truncated: boolean }
  | { ok: false; reason: string; fallback?: 'fetch-on-demand' }

// --- Collecting rows ---------------------------------------------------------

interface Collected {
  columns: string[]
  rows: Record<string, string>[]
  /** Parallel to `rows`; null where a record had no shape. */
  geometries: (unknown | null)[]
  truncated: boolean
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

class Accumulator {
  columns: string[] = []
  private seen = new Set<string>()
  rows: Record<string, string>[] = []
  geometries: (unknown | null)[] = []
  truncated = false
  bytes = 0

  constructor(
    private maxRows: number,
    private maxBytes: number,
  ) {}

  get full(): boolean {
    return this.rows.length >= this.maxRows || this.bytes >= this.maxBytes
  }

  add(record: Record<string, unknown>, geometry: unknown | null): void {
    if (this.full) {
      this.truncated = true
      return
    }
    for (const key of Object.keys(record)) {
      if (!this.seen.has(key)) {
        this.seen.add(key)
        this.columns.push(key)
      }
    }
    const row: Record<string, string> = {}
    for (const key of Object.keys(record)) row[key] = cellText(record[key])
    this.rows.push(row)
    this.geometries.push(geometry ?? null)
  }

  countBytes(n: number): void {
    this.bytes += n
  }

  result(): Collected {
    return { columns: this.columns, rows: this.rows, geometries: this.geometries, truncated: this.truncated }
  }
}

// --- Coordinates -------------------------------------------------------------

/** The CRS a GeoJSON document declares, or null for the 4326 default. */
function crsOf(body: any, sample: string): string | null {
  const named = body?.crs?.properties?.name
  if (typeof named === 'string' && named) {
    return /(^|:)(4326|CRS84)$/i.test(named) ? null : named
  }
  return declaredCrs(sample) ?? null
}

function isWebMercator(crs: string): boolean {
  const code = /(\d{4,6})\s*$/.exec(crs)?.[1]
  return code ? WEB_MERCATOR_WKIDS.has(Number(code)) : false
}

/** Every coordinate pair in a GeoJSON geometry, converted in place. */
function reproject(geometry: unknown): unknown {
  if (!geometry || typeof geometry !== 'object') return geometry
  const g = geometry as Record<string, unknown>
  const walk = (coords: unknown): unknown => {
    if (!Array.isArray(coords)) return coords
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [lng, lat] = toLonLat(coords[0] as number, coords[1] as number)
      return [lng, lat, ...coords.slice(2)]
    }
    return coords.map(walk)
  }
  return { ...g, coordinates: walk(g.coordinates) }
}

/**
 * The representative point of any geometry: the centre of its bounding box.
 *
 * Exact for a point. For a polygon or a line it is not the true centroid, and
 * it does not need to be — it is where a pin goes and which county the row is
 * in. P5-59, found live: a 4,254-row conservation-lands replication landed
 * with no coordinates at all, so it could neither go on the map nor be given
 * county context; the first vertex would have put every pin on a corner.
 */
function pointOf(geometry: unknown): { lat: number; lng: number } | null {
  if (!geometry || typeof geometry !== 'object') return null
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  const walk = (coords: unknown): void => {
    if (!Array.isArray(coords)) return
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [lng, lat] = coords as number[]
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
      minLng = Math.min(minLng, lng)
      maxLng = Math.max(maxLng, lng)
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
      return
    }
    for (const item of coords) walk(item)
  }
  walk((geometry as Record<string, unknown>).coordinates)
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null
  return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 }
}

// --- Pulling -----------------------------------------------------------------

function urlOf(access: SourceAccess, slug: string): URL {
  if (!access.url) throw new PlaceFetchError(`the ${access.type} method for "${slug}" has no url`, 'no-endpoint')
  return new URL(access.url)
}

/** ArcGIS, paged. */
async function pullArcgis(access: SourceAccess, input: ReplicateInput, acc: Accumulator): Promise<void> {
  const base = urlOf(access, input.slug)
  const path = base.pathname.replace(/\/+$/, '')
  // A FeatureServer with no layer index cannot be queried; layer 0 is the
  // convention, and it is what the P5-57 adapter assumes too.
  if (/\/(FeatureServer|MapServer)$/i.test(path)) base.pathname = `${path}/0`

  let offset = 0
  for (let page = 0; page < PAGE_HARD_CAP; page++) {
    const url = new URL(`${base.toString().replace(/\/+$/, '')}/query`)
    url.searchParams.set('where', '1=1')
    url.searchParams.set('outFields', '*')
    url.searchParams.set('outSR', '4326')
    url.searchParams.set('f', 'geojson')
    url.searchParams.set('resultOffset', String(offset))
    url.searchParams.set('resultRecordCount', String(REPLICATE_PAGE_SIZE))
    const body = await guardedJson<any>(url, { ...input.http, source: input.slug, maxBytes: input.maxBytes ?? replicateMaxBytes() })
    if (body?.error) {
      throw new PlaceFetchError(`ArcGIS: ${body.error?.message || 'the layer refused the query'}`, 'bad-response')
    }
    const features: any[] = Array.isArray(body?.features) ? body.features : []
    if (!features.length) break
    acc.countBytes(JSON.stringify(features).length)
    for (const feature of features) {
      acc.add((feature?.properties ?? feature?.attributes ?? {}) as Record<string, unknown>, feature?.geometry ?? null)
    }
    offset += features.length
    // Never trust the requested count: a server that answers 3 of the 1,000
    // asked for while flagging more has more (NC OneMap does exactly this).
    const more = body?.exceededTransferLimit === true || body?.properties?.exceededTransferLimit === true
    if (!more && features.length < REPLICATE_PAGE_SIZE) break
    if (acc.full) {
      acc.truncated = true
      break
    }
  }
}

/** Socrata, paged by `$offset` with a stable order. */
async function pullSocrata(access: SourceAccess, input: ReplicateInput, acc: Accumulator): Promise<void> {
  const base = urlOf(access, input.slug)
  let offset = 0
  for (let page = 0; page < PAGE_HARD_CAP; page++) {
    const url = new URL(base.toString())
    url.searchParams.set('$limit', String(REPLICATE_PAGE_SIZE))
    url.searchParams.set('$offset', String(offset))
    // Without an order the portal may repeat or skip rows between pages.
    if (!url.searchParams.has('$order')) url.searchParams.set('$order', ':id')
    const body = await guardedJson<any>(url, { ...input.http, source: input.slug, maxBytes: input.maxBytes ?? replicateMaxBytes() })
    if (!Array.isArray(body)) {
      throw new PlaceFetchError(`Socrata: ${body?.message || 'the portal answered with something other than rows'}`, 'bad-response')
    }
    if (!body.length) break
    acc.countBytes(JSON.stringify(body).length)
    for (const record of body) acc.add(record as Record<string, unknown>, null)
    offset += body.length
    if (body.length < REPLICATE_PAGE_SIZE) break
    if (acc.full) {
      acc.truncated = true
      break
    }
  }
}

/** One whole file: CSV or GeoJSON, from a URL or from bytes we already hold. */
function readTable(text: string, contentType: string, acc: Accumulator): { crs?: string } {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let body: any
    try {
      body = JSON.parse(text)
    } catch {
      throw new PlaceFetchError('that file is not readable JSON', 'bad-response')
    }
    const crs = crsOf(body, text.slice(0, 8192))
    if (crs && !isWebMercator(crs)) {
      throw new PlaceFetchError(
        `the coordinates are in ${crs}, which we cannot convert here — clean it by hand and push it`,
        'bad-response',
      )
    }
    const features: any[] = Array.isArray(body?.features) ? body.features : Array.isArray(body) ? body : []
    for (const feature of features) {
      const properties = (feature?.properties ?? feature) as Record<string, unknown>
      const geometry = feature?.geometry ?? null
      acc.add(properties, crs && geometry ? reproject(geometry) : geometry)
    }
    acc.countBytes(Buffer.byteLength(text))
    return crs ? { crs } : {}
  }
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true })
  for (const row of parsed.data) {
    if (row && typeof row === 'object') acc.add(row, null)
  }
  acc.countBytes(Buffer.byteLength(text))
  void contentType
  return {}
}

async function pullDownload(access: SourceAccess, input: ReplicateInput, acc: Accumulator): Promise<void> {
  const url = urlOf(access, input.slug)
  const res = await guardedGet(url, {
    ...input.http,
    source: input.slug,
    maxBytes: input.maxBytes ?? replicateMaxBytes(),
  })
  readTable(res.body, res.contentType, acc)
}

// --- Writing the dataset -----------------------------------------------------

/** Path words that name a route or a format, never a dataset. */
const ROUTE_SEGMENTS = new Set([
  'api', 'v1', 'v2', 'v3', 'rest', 'services', 'download', 'downloads', 'items', 'item', 'datasets', 'dataset',
  'files', 'file', 'sites', 'default', 'query', 'resource', 'geojson', 'json', 'csv', 'tsv', 'zip', 'xlsx', 'xls', 'pdf',
])

/** Last resort: a readable name from the address itself. Host plus the last
 *  path segment that is a name rather than a route word, a format or an id —
 *  `hub.arcgis.com/api/download/v1/items/<32 hex>/geojson` has none, and
 *  "hub.arcgis.com" is a better dataset name than that id. */
function nameFromUrl(raw: string): string {
  let host = ''
  let segments: string[] = []
  try {
    const url = new URL(raw)
    host = url.hostname.replace(/^www\./i, '')
    segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map(part => decodeURIComponent(part).replace(/\.[A-Za-z0-9]{1,6}$/, ''))
  } catch {
    return raw
  }
  const named = [...segments]
    .reverse()
    .find(
      part =>
        part.length > 2 &&
        part.length <= 60 &&
        !ROUTE_SEGMENTS.has(part.toLowerCase()) &&
        !/^\d+$/.test(part) &&
        !/^[0-9a-f]{16,}$/i.test(part),
    )
  return [host, named].filter(Boolean).join(' ')
}

/** A title that is really just the link it came from. A dropped link is filed
 *  under its own URL until somebody names it. */
function isJustTheUrl(title: string, url: string): boolean {
  const trimmed = title.trim()
  if (!trimmed) return true
  if (/^https?:\/\//i.test(trimmed)) return true
  const bare = (value: string) => value.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '')
  return !!url && bare(trimmed).toLowerCase() === bare(url).toLowerCase()
}

/**
 * What to call the copy — and so what its slug and its stored file are named.
 *
 * P5-59, found live: using the entry's title produced
 * `www-ers-usda-gov-sites-default-files-laserfiche-datafiles-53251-…`, because
 * a dropped link IS titled with its URL until it is filed. In order: what the
 * model suggested, the entry's own title when it is a title, what the service
 * calls itself, and only then something readable built from the address.
 */
function datasetNameFor(entry: CatalogEntryDetail): string {
  const suggested = entry.meta.suggested
  if (suggested && typeof suggested === 'object' && !Array.isArray(suggested)) {
    const title = (suggested as Record<string, unknown>).title
    if (typeof title === 'string' && title.trim()) return title.trim()
  }
  const url = typeof entry.meta.url === 'string' ? entry.meta.url.trim() : ''
  if (entry.title && !isJustTheUrl(entry.title, url)) return entry.title.trim()
  const inspection = parseInspection(entry.meta.inspection)
  if (inspection?.title?.trim()) return inspection.title.trim()
  return url ? nameFromUrl(url) : entry.slug
}

/** A slug nobody is using. Datasets are addressed by name in wiki links and
 *  `/library/<slug>`, so a collision would hide one of them. */
async function freeDatasetSlug(title: string, fallback: string): Promise<string> {
  const base = slugify(title) || slugify(fallback) || 'replicated-dataset'
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`
    const hit = await libraryQuery(`SELECT slug FROM library_catalog WHERE slug = $1`, [candidate])
    if (!hit.rows.length) return candidate
  }
  return `${base}-${Date.now()}`
}

function toCsv(columns: string[], rows: Record<string, string>[]): string {
  return (
    Papa.unparse({ fields: columns, data: rows.map(row => columns.map(c => row[c] ?? '')) }, { newline: '\n' }) + '\n'
  )
}

/** The columns a person reads: not a key, not a coordinate, not a code.
 *  P5-59, found live: the Georgia conservation-lands popup was FID, rowid and
 *  four internal codes, with the actual `name` column used as nothing. */
const ID_LIKE_RE = /^(fid|objectid|rowid|oid|id|.*_id|.*_code|geoid|latitude|longitude|lat|lng|lon)$/i

/** Column names that ARE the label, in the spellings agencies use for it. */
const LABEL_EXACT_RE = /^(name|site_?name|facility|parcel|owner_?name|title|label|address)$/i
/** Anything else that reads like a name. */
const LABEL_CONTAINS_RE = /name|title|label/i

const SAMPLE_ROWS = 20

function isNumericColumn(rows: Record<string, string>[], column: string): boolean {
  const values = rows.slice(0, SAMPLE_ROWS).map(r => r[column] ?? '').filter(v => v !== '')
  return values.length > 0 && values.every(v => !Number.isNaN(Number(v)))
}

/** How many different values the column takes — how well it tells rows apart. */
function distinctValues(rows: Record<string, string>[], column: string): number {
  return new Set(rows.slice(0, 50).map(r => r[column] ?? '').filter(Boolean)).size
}

/**
 * Which column a person would recognise a row by.
 *
 * Ranked, because the first column that merely CONTAINS "owner" is how
 * `owner_code` beat `name` on the live run: an exact name first, then anything
 * name-shaped that is not an id, then the text column that best distinguishes
 * one row from another.
 */
function labelColumnIn(columns: string[], rows: Record<string, string>[]): string | undefined {
  const exact = columns.find(c => LABEL_EXACT_RE.test(c.trim()))
  if (exact) return exact
  const named = columns.find(c => LABEL_CONTAINS_RE.test(c) && !ID_LIKE_RE.test(c.trim()))
  if (named) return named
  let best: string | undefined
  let bestCount = 0
  for (const column of columns) {
    if (ID_LIKE_RE.test(column.trim()) || isNumericColumn(rows, column)) continue
    const count = distinctValues(rows, column)
    if (count > bestCount) {
      best = column
      bestCount = count
    }
  }
  // Last resort: any column with something readable in it. A code beats a
  // blank popup, and this only happens when every column is an id.
  return best ?? columns.find(c => rows.slice(0, SAMPLE_ROWS).some(r => r[c] && Number.isNaN(Number(r[c]))))
}

/** Up to six columns worth showing in a popup, in the order the file has them.
 *  Text and short categories first, because those are the ones that say what a
 *  feature IS; numbers fill whatever room is left. */
function popupFieldsIn(columns: string[], rows: Record<string, string>[], exclude: string[]): string[] {
  const candidates = columns.filter(c => !exclude.includes(c) && !ID_LIKE_RE.test(c.trim()))
  const readable = (c: string) =>
    !isNumericColumn(rows, c) && rows.slice(0, SAMPLE_ROWS).every(r => (r[c] ?? '').length <= 60)
  const preferred = candidates.filter(readable)
  return [...preferred, ...candidates.filter(c => !preferred.includes(c))].slice(0, 6)
}

function numericColumnIn(columns: string[], rows: Record<string, string>[], except: string[]): string | undefined {
  return columns.find(
    c =>
      !except.includes(c) &&
      rows.slice(0, 20).filter(r => r[c] !== '').length > 0 &&
      rows.slice(0, 20).every(r => r[c] === '' || !Number.isNaN(Number(r[c]))),
  )
}

/**
 * A layer block for the admin to look at, never one that goes live on its own:
 * the dataset is `needs-review`, and only a `published` dataset becomes a map
 * layer (P5-18). Proposing one saves the manual step of writing six fields by
 * hand; getting it slightly wrong costs an edit, not a wrong map.
 */
function proposeLayer(
  title: string,
  file: string,
  columns: string[],
  rows: Record<string, string>[],
  coords: { latKey: string; lngKey: string } | null,
  provider: string,
  /** The `.geojson` written beside the CSV, when what it holds is lines. */
  lineFile: string | null,
): Record<string, unknown> | null {
  const common = { file, name: title, description: `Replicated from ${provider}.`, source: provider, year: new Date().getFullYear() }
  // P7-3: a source whose shapes are lines proposes a LINE layer over the
  // GeoJSON beside the CSV — the file this function's old comment said was
  // "kept for" the day something could draw it. A transmission corridor drawn
  // from the centre of its bounding box is a dot in a field, which is what
  // this used to propose.
  if (lineFile) {
    const labelKey = labelColumnIn(columns, rows)
    if (labelKey) {
      return {
        ...common,
        file: lineFile,
        geometry: 'line',
        pathKey: '_path',
        labelKey,
        popupFields: popupFieldsIn(columns, rows, [labelKey]),
        color: null,
        width: null,
      }
    }
  }
  // Anything else with a shape gets a point layer: polygons are still drawn
  // from their centroid until somebody builds the polygon layer the GeoJSON
  // beside it is kept for (P5-59).
  if (coords) {
    const notCoords = (c: string) => c !== coords.latKey && c !== coords.lngKey
    const labelKey = labelColumnIn(columns.filter(notCoords), rows)
    if (!labelKey) return null
    return {
      ...common,
      geometry: 'point',
      latKey: coords.latKey,
      lngKey: coords.lngKey,
      labelKey,
      popupFields: popupFieldsIn(columns.filter(notCoords), rows, [labelKey]),
      color: null,
    }
  }
  const geoKey = countyFipsField(columns.map(name => ({ name })))
  if (!geoKey) return null
  const valueKey = numericColumnIn(columns, rows, [geoKey])
  if (!valueKey) return null
  return {
    ...common,
    geometry: 'county',
    geoKey,
    valueKey,
    dataType: 'count',
    unit: '',
    direction: 'higher_better',
    range: null,
  }
}

// --- The service ---------------------------------------------------------------

/** Where the rows are going to come from, and what to record as their origin. */
function planFor(entry: CatalogEntryDetail): { kind: 'source'; access: SourceAccess } | { kind: 'file'; key: string } | null {
  const source = sourceBlockOf(entry.meta)
  if (source) {
    try {
      return { kind: 'source', access: pickAccess(source) }
    } catch {
      return null
    }
  }
  // A dropped link the P5-47 fetch already downloaded: the bytes are here.
  const file = entry.files.find(f => !f.key.endsWith('/meta.json'))
  if (file) return { kind: 'file', key: file.key }
  return null
}

export async function replicateEntry(input: ReplicateInput): Promise<ReplicateOutcome> {
  if (!isLibraryEnabled() || !isBucketEnabled()) return { ok: false, reason: 'the library is not available right now' }
  const entry = await getCatalogEntry(input.slug)
  if (!entry) return { ok: false, reason: 'that entry is gone' }

  const plan = planFor(entry)
  if (!plan) {
    return {
      ok: false,
      reason:
        'There is nothing to copy here yet — this entry has no file and no endpoint we can query. Register an access method first, or drop the download link itself.',
    }
  }

  const maxRows = input.maxRows ?? replicateMaxRows()
  const maxBytes = input.maxBytes ?? replicateMaxBytes()
  const acc = new Accumulator(maxRows, maxBytes)
  const source = sourceBlockOf(entry.meta)
  const from = plan.kind === 'source' ? `source:${input.slug}` : String(entry.meta.url ?? input.slug)

  try {
    if (plan.kind === 'file') {
      const bytes = await getFile(plan.key)
      if (bytes.byteLength > maxBytes) {
        return { ok: false, reason: `that file is ${Math.round(bytes.byteLength / (1024 * 1024))} MB, over the copy limit`, fallback: 'fetch-on-demand' }
      }
      readTable(bytes.toString('utf8'), '', acc)
    } else if (plan.access.type === 'arcgis') {
      await pullArcgis(plan.access, { ...input, maxRows, maxBytes }, acc)
    } else if (plan.access.type === 'socrata') {
      await pullSocrata(plan.access, { ...input, maxRows, maxBytes }, acc)
    } else if (plan.access.type === 'download') {
      await pullDownload(plan.access, { ...input, maxRows, maxBytes }, acc)
    } else {
      return { ok: false, reason: `a ${plan.access.type} source cannot be copied automatically — pull it by hand` }
    }
  } catch (err: any) {
    const message = err instanceof PlaceFetchError ? err.message : err?.message || 'the copy did not work'
    const tooBig = err instanceof PlaceFetchError && err.code === 'too-large'
    return { ok: false, reason: message, ...(tooBig ? { fallback: 'fetch-on-demand' as const } : {}) }
  }

  const collected = acc.result()
  if (!collected.rows.length) return { ok: false, reason: 'the source answered with no rows' }
  if (collected.truncated) {
    return {
      ok: false,
      reason: `this source has more than ${maxRows.toLocaleString('en-US')} rows, which is too big to copy here`,
      fallback: 'fetch-on-demand',
    }
  }

  // Every shape gets its coordinates as ordinary columns — points from their
  // own position, polygons and lines from the centre of their box. That is
  // what a layer block names, what the explorer can sort and filter on, and
  // what lets a county be worked out for a row later.
  const hasGeometry = collected.geometries.some(g => g)
  const existingLat = collected.columns.find(c => LAT_COLUMN_RE.test(c.trim()))
  const existingLng = collected.columns.find(c => LNG_COLUMN_RE.test(c.trim()))
  const addCoords = hasGeometry && !(existingLat && existingLng)
  const coords = hasGeometry
    ? { latKey: addCoords ? 'latitude' : existingLat!, lngKey: addCoords ? 'longitude' : existingLng! }
    : null
  const columns = addCoords ? [...collected.columns, 'longitude', 'latitude'] : [...collected.columns]
  if (addCoords) {
    collected.rows.forEach((row, i) => {
      const point = pointOf(collected.geometries[i])
      row.longitude = point ? String(point.lng) : ''
      row.latitude = point ? String(point.lat) : ''
    })
  }
  // County context, under the name the rest of the pipeline looks for. Only a
  // column we already believe holds a 5-digit county code is copied — an
  // invented GEOID would be worse than none.
  const fipsColumn = countyFipsField(collected.columns.map(name => ({ name })))
  if (hasGeometry && fipsColumn && !columns.includes('GEOID')) {
    columns.push('GEOID')
    for (const row of collected.rows) row.GEOID = row[fipsColumn] ?? ''
  }

  const name = datasetNameFor(entry)
  const title = `${name} (copied)`
  const datasetSlug = await freeDatasetSlug(name, input.slug)
  const prefix = `library/datasets/${datasetSlug}/`
  const csvName = `${datasetSlug}.csv`
  const csv = toCsv(columns, collected.rows)
  const files: { key: string; size: number }[] = []

  await putFile(`${prefix}${csvName}`, csv, 'text/csv')
  files.push({ key: `${prefix}${csvName}`, size: Buffer.byteLength(csv) })

  const features = collected.geometries
    .map((geometry, i) => (geometry ? { type: 'Feature' as const, geometry, properties: collected.rows[i] } : null))
    .filter(f => f !== null)
  let lineFile: string | null = null
  if (features.length) {
    const geojson = JSON.stringify({ type: 'FeatureCollection', features })
    await putFile(`${prefix}${datasetSlug}.geojson`, geojson, 'application/geo+json')
    files.push({ key: `${prefix}${datasetSlug}.geojson`, size: Buffer.byteLength(geojson) })
    // P7-3: only when MOST of what came back is a line. A points layer with
    // one stray polyline is still a points layer, and a mixed bag proposing a
    // line layer would silently drop everything that is not one.
    const typeOf = (f: (typeof features)[number]): string =>
      f && typeof f.geometry === 'object' && f.geometry ? String((f.geometry as { type?: unknown }).type ?? '') : ''
    const lines = features.filter(f => typeOf(f) === 'LineString' || typeOf(f) === 'MultiLineString').length
    if (lines > features.length / 2) lineFile = `${datasetSlug}.geojson`
  }

  const provider = source?.provider ?? entry.title
  const layer = proposeLayer(title, csvName, columns, collected.rows, coords, provider, lineFile)
  const meta: Record<string, unknown> = {
    title,
    category: entry.category || '',
    status: 'needs-review',
    tags: [],
    description: `${collected.rows.length.toLocaleString('en-US')} rows copied from ${provider}. Not cleaned yet.`,
    lineage: { from, fetchedAt: new Date().toISOString(), rows: collected.rows.length },
    ...(layer ? { layer } : {}),
  }
  const metaJson = JSON.stringify(meta, null, 2)
  await putFile(`${prefix}meta.json`, metaJson, 'application/json')
  files.push({ key: `${prefix}meta.json`, size: Buffer.byteLength(metaJson) })
  await indexFileBackedEntry('dataset', datasetSlug, meta, files)

  await recordOnOrigin(entry, datasetSlug, from)

  // The same proposal a dropped file gets. Best effort: a full queue is not a
  // reason to fail a copy that already landed.
  try {
    queueSuggestion({ slug: datasetSlug, userId: input.userId, actor: input.actor, clientIp: input.clientIp })
  } catch (err: any) {
    console.error('[library] could not queue a filing suggestion:', err?.message || err)
  }

  void writeAudit({
    userId: input.userId,
    actor: input.actor,
    action: 'library.replicate',
    target: datasetSlug,
    detail: { from: input.slug, origin: from, rows: collected.rows.length, geometry: features.length > 0 },
  })

  return { ok: true, dataset: datasetSlug, rows: collected.rows.length, truncated: false }
}

/** Say on the entry we copied FROM that the copy exists: a source records it
 *  as replication, a dropped link records it as its ingest plan being done. */
async function recordOnOrigin(entry: CatalogEntryDetail, dataset: string, from: string): Promise<void> {
  const at = new Date().toISOString()
  await patchEntryManifest(entry.slug, meta => {
    const next: Record<string, unknown> = { ...meta }
    const source = meta.source
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      next.source = { ...(source as Record<string, unknown>), replication: { status: 'replicated', dataset } }
    }
    const ingest = parseIngestPlan(meta.ingest)
    if (ingest && !ingest.done) next.ingest = { ...ingest, done: { at, dataset } }
    return next
  }).catch(err => {
    console.error(`[library] could not mark ${entry.slug} replicated:`, err?.message || err)
    return null
  })
  void from
}

/** Fall back to a pointer when the copy was too big, saying so on the entry. */
async function fallBackToFetchOnDemand(slug: string, reason: string): Promise<void> {
  await patchEntryManifest(slug, meta => {
    const ingest = parseIngestPlan(meta.ingest)
    if (!ingest) return null
    return {
      ...meta,
      ingest: {
        ...ingest,
        plan: 'fetch-on-demand',
        mode: undefined,
        note: `Copying it was tried and did not fit: ${reason}`,
        decidedAt: new Date().toISOString(),
      },
    }
  }).catch(() => null)
}

/** What the queue runs. Never throws: it is detached from every request. */
export async function runReplicateJob(job: LinkFetchJob): Promise<void> {
  const outcome: ReplicateOutcome = await replicateEntry({
    slug: job.slug,
    actor: job.actor,
    userId: job.userId,
    clientIp: job.clientIp,
  }).catch((err: any): ReplicateOutcome => ({ ok: false, reason: err?.message || 'the copy did not work' }))
  if (outcome.ok) return
  console.warn('[library] replicate failed for', job.slug, '-', outcome.reason)
  if (outcome.fallback === 'fetch-on-demand') await fallBackToFetchOnDemand(job.slug, outcome.reason)
  // The entry keeps its plan and shows the failure through the queue; a note
  // on the manifest would need a schema for "the last attempt", and the
  // inspection already says what this link is.
  await patchEntryManifest(job.slug, meta => {
    const ingest = parseIngestPlan(meta.ingest)
    if (!ingest || outcome.fallback) return null
    return { ...meta, ingest: { ...ingest, note: `Last copy attempt: ${outcome.reason}` } }
  }).catch(() => null)
}

export { parseInspection }
