import {
  fipsMatchOf,
  fipsTypeOf,
  type SourceAccess,
  type SourceAccessType,
  type SourceFipsMatch,
  type SourceFipsType,
  type SourceGeography,
  type SourcePlaceQuery,
} from '../sourceMeta.js'
import { PlaceFetchError, type GuardedGetOptions } from '../placeHttp.js'

/**
 * What every P5-57 adapter is handed and what every one of them returns.
 *
 * The shapes are deliberately dumb: a place, an access method, and rows of
 * strings back. An adapter knows one protocol and nothing about the bucket,
 * the cache or the catalog — `placeFetch.ts` owns all of that, so a new
 * protocol is one file and one line in the table.
 */

/** Most rows one slice may hold. A slice is meant to be the answer to a
 *  question about a place, not a replica; past this we say so and stop. */
export const ROWS_MAX = 5_000

/** Most features we keep for the map. Geometry is heavier than the rows it
 *  belongs to, and nothing useful is drawn past a couple of thousand points. */
export const GEOMETRY_MAX = 2_000

export const METERS_PER_MILE = 1609.344

export interface PlacePoint {
  lat: number
  lng: number
}

export interface PlaceTarget {
  point: PlacePoint | null
  /** 5-digit county FIPS, when the place is (or sits in) a county. */
  geoid: string | null
  radiusMiles: number
  /** [west, south, east, north] around the point — the download filter's box. */
  bbox: [number, number, number, number] | null
  /** What a person would call this place, for the slice list and the audit. */
  label: string
  /** The cache key: `g<geoid>` or `p<lat>_<lng>_r<miles>`. */
  key: string
}

export interface AdapterContext {
  slug: string
  access: SourceAccess
  placeQuery?: SourcePlaceQuery
  place: PlaceTarget
  /** What one row IS. P5-59: it is what says how wide a numeric sub-county
   *  range has to be — a tract id is six digits past the county, a block
   *  group's is seven. */
  geography?: SourceGeography
  /** Free text from the manifest — the `download` adapter's staleness clock. */
  updateCadence?: string
  http?: GuardedGetOptions
}

/** A GeoJSON feature collection, kept only so the map can draw the slice. */
export interface SliceGeometry {
  type: 'FeatureCollection'
  features: { type: 'Feature'; geometry: unknown; properties: Record<string, string> }[]
}

export interface PlaceRows {
  rows: Record<string, string>[]
  columns: string[]
  count: number
  /** True when the source had more than we kept. */
  truncated: boolean
  geometry?: SliceGeometry
}

export type PlaceAdapter = (ctx: AdapterContext) => Promise<PlaceRows>

// --- Place maths -------------------------------------------------------------

export function milesToMeters(miles: number): number {
  return Math.round(miles * METERS_PER_MILE)
}

/** A degrees box around a point. Rough on purpose — it is a pre-filter for a
 *  CSV with no geometry, and the radius check that follows is exact. */
export function bboxAround(point: PlacePoint, radiusMiles: number): [number, number, number, number] {
  const dLat = radiusMiles / 69
  // Longitude degrees shrink toward the poles; clamp so a point near one does
  // not produce an infinite box.
  const dLng = radiusMiles / Math.max(1, 69 * Math.cos((point.lat * Math.PI) / 180))
  return [point.lng - dLng, point.lat - dLat, point.lng + dLng, point.lat + dLat]
}

/** Great-circle miles between two points — the exact test after the box. */
export function distanceMiles(a: PlacePoint, b: PlacePoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 3958.7613 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

// --- Rows --------------------------------------------------------------------

/** One cell. Everything becomes a string, because that is what the explorer,
 *  the CSV and the table all speak; a nested object becomes its JSON rather
 *  than "[object Object]". */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * Records → the normalised shape. Columns are the union of the keys in the
 * order they were first seen, so the first row's column order survives and a
 * later row's extra field is still shown rather than silently dropped.
 */
export function normalizeRows(records: Record<string, unknown>[], hadMore = false): PlaceRows {
  const columns: string[] = []
  const seen = new Set<string>()
  const kept = records.slice(0, ROWS_MAX)
  for (const record of kept) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
    }
  }
  const rows = kept.map(record => {
    const row: Record<string, string> = {}
    for (const key of columns) row[key] = cellText(record[key])
    return row
  })
  return { rows, columns, count: rows.length, truncated: hadMore || records.length > ROWS_MAX }
}

/** Wrap geometries as a feature collection, capped. Features with no geometry
 *  are skipped rather than drawn at null island. */
export function featureCollection(
  entries: { geometry: unknown; properties: Record<string, string> }[],
): SliceGeometry | undefined {
  const features = entries
    .filter(e => e.geometry !== null && e.geometry !== undefined)
    .slice(0, GEOMETRY_MAX)
    .map(e => ({ type: 'Feature' as const, geometry: e.geometry, properties: e.properties }))
  return features.length ? { type: 'FeatureCollection', features } : undefined
}

// --- Manifest reading --------------------------------------------------------

/**
 * The column holding a county FIPS, if the manifest says. `placeQuery.fipsField`
 * is the answer when it is set; otherwise we read the note the researcher left
 * on the access method ("filter by county FIPS: ?where=STCOFIPS=…"), which is
 * where that fact lives for most of the seed sources. Only a name that already
 * looks like a FIPS column is taken from prose — a guess that is wrong is worse
 * than no filter at all.
 */
export function fipsFieldFor(access: SourceAccess, placeQuery?: SourcePlaceQuery): string | null {
  if (placeQuery?.fipsField) return placeQuery.fipsField
  const notes = access.notes ?? ''
  const match = /\bwhere=([A-Za-z_][A-Za-z0-9_]{0,62})\s*=/i.exec(notes)
  const name = match?.[1]
  return name && /fips|geoid/i.test(name) ? name : null
}

/** A county filter, ready for an adapter to write in its own dialect. */
export interface FipsFilter {
  field: string
  /** Five digits, checked. */
  geoid: string
  match: SourceFipsMatch
  type: SourceFipsType
  /** A numeric sub-county column's half-open range of ids inside this county,
   *  as numbers. Null for every other combination. */
  range: { min: number; max: number } | null
}

/**
 * How many digits a sub-county id adds to its county's five.
 *
 * A tract GEOID is 11 digits (5 + 6) and a block group's is 12 (5 + 7), so
 * every tract in county 13121 is a number from 13121·10⁶ up to (but not
 * including) 13122·10⁶. Multiplying rather than prefixing is what makes this
 * work on a numeric column, where 01001's leading zero is long gone — the
 * county code loses it in exactly the same way (`Number('01001')` is 1001).
 */
const SUBCOUNTY_DIGITS: Record<string, number> = { blockgroup: 1e7, tract: 1e6 }

function rangeFor(geoid: string, geography: SourceGeography | undefined): { min: number; max: number } {
  const scale = SUBCOUNTY_DIGITS[geography ?? ''] ?? SUBCOUNTY_DIGITS.tract
  const county = Number(geoid)
  return { min: county * scale, max: (county + 1) * scale }
}

/**
 * The county filter this source needs, or null when there is nothing to build
 * one from (no place, or no named column).
 *
 * P5-59: `prefix` exists because a tract or block-group GEOID BEGINS with its
 * county's five digits — an equality filter on one matches nothing and says
 * nothing, which is exactly the failure this replaces. The five-digit check is
 * here, at the one place both dialects pass through, because the value is
 * about to be pasted into a query: everything downstream may assume it.
 */
export function fipsFilterFor(ctx: AdapterContext): FipsFilter | null {
  const field = fipsFieldFor(ctx.access, ctx.placeQuery)
  const geoid = ctx.place.geoid
  if (!field || !geoid) return null
  if (!/^\d{5}$/.test(geoid)) {
    throw new PlaceFetchError(`"${ctx.slug}" was asked about "${geoid}", which is not a 5-digit county code`, 'bad-place')
  }
  const match = fipsMatchOf(ctx.placeQuery)
  const type = fipsTypeOf(ctx.placeQuery)
  return {
    field,
    geoid,
    match,
    type,
    range: match === 'prefix' && type === 'number' ? rangeFor(geoid, ctx.geography) : null,
  }
}

/** The endpoint an adapter is pointed at, or a plain refusal. */
export function requireUrl(ctx: AdapterContext): URL {
  const raw = ctx.access.url
  if (!raw) throw new PlaceFetchError(`the ${ctx.access.type} access method for "${ctx.slug}" has no url`, 'no-endpoint')
  try {
    return new URL(raw)
  } catch {
    throw new PlaceFetchError(`the ${ctx.access.type} url for "${ctx.slug}" is not a url`, 'no-endpoint')
  }
}

/** Adapter types that can actually run. `wfs` and `manual` are indexed, not
 *  fetched — the UI explains what to do by hand instead. */
export const ADAPTER_TYPES = ['arcgis', 'socrata', 'download', 'rest'] as const
export type AdapterType = (typeof ADAPTER_TYPES)[number]

export function isAdapterType(type: SourceAccessType): type is AdapterType {
  return (ADAPTER_TYPES as readonly string[]).includes(type)
}

// --- Staleness ---------------------------------------------------------------

/** How long a cached answer stays good, from the manifest's free-text cadence.
 *  Unknown means 30 days: long enough to be worth caching, short enough that a
 *  slice nobody looked at for a month is fetched again rather than trusted. */
export const DEFAULT_TTL_DAYS = 30

export function ttlDaysFor(updateCadence?: string): number {
  const cadence = (updateCadence ?? '').toLowerCase()
  if (!cadence) return DEFAULT_TTL_DAYS
  // Ordered most-frequent first: "continuous, with rulemakings twice a year"
  // must read as continuous, not annual.
  if (/continuous|real.?time|hourly|daily/.test(cadence)) return 1
  if (/weekly/.test(cadence)) return 7
  if (/monthly/.test(cadence)) return 30
  if (/quarterly/.test(cadence)) return 90
  if (/annual|yearly|each year|per year/.test(cadence)) return 365
  return DEFAULT_TTL_DAYS
}

/** Column names a place filter recognises without being told. */
export const GEOID_COLUMN_RE = /^(geoid|fips|county_?fips|stcofips|state_?county_?fips(_code)?|geo_?id)$/i
export const LAT_COLUMN_RE = /^(lat|latitude|y|pref_latitude)$/i
export const LNG_COLUMN_RE = /^(lon|lng|long|longitude|x|pref_longitude)$/i

export function findColumn(columns: string[], re: RegExp, preferred?: string): string | null {
  if (preferred && columns.includes(preferred)) return preferred
  return columns.find(c => re.test(c.trim())) ?? null
}
