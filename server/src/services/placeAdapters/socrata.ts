import { guardedJson, PlaceFetchError } from '../placeHttp.js'
import {
  featureCollection,
  fipsFilterFor,
  milesToMeters,
  normalizeRows,
  requireUrl,
  ROWS_MAX,
  type AdapterContext,
  type PlaceRows,
} from './shared.js'

/**
 * Socrata (data.cityofx.gov, many state portals): SoQL over a resource URL.
 *
 * Two filters, the same pair as ArcGIS:
 *   - `within_circle(<geoField>, lat, lng, meters)` around a point;
 *   - `<fipsField> = '<geoid>'` for a county.
 *
 * Both are built from values that are already numbers or five digits, and
 * from column names the manifest parser has restricted to plain identifiers —
 * a SoQL clause is a query language, and nothing a person typed reaches it.
 */

/** Socrata's own hard ceiling for a single page is 50,000; we ask for far less
 *  because a slice is one place's worth of rows. */
export const SOQL_LIMIT = 5_000

export function soqlWhere(ctx: AdapterContext): string {
  const geoField = ctx.placeQuery?.geoField
  // The point wins when we have one, for the same reason as ArcGIS: an address
  // is a point, and its county is a much bigger place than the question.
  if (ctx.place.point && geoField) {
    return `within_circle(${geoField},${ctx.place.point.lat},${ctx.place.point.lng},${milesToMeters(ctx.place.radiusMiles)})`
  }
  const fips = fipsFilterFor(ctx)
  // A tract or block-group table is asked for the county's five digits as a
  // prefix; a county table is asked for the whole value (P5-59). A NUMBER
  // column cannot be prefixed at all — its ids have lost the leading zero —
  // so it is asked for the numeric range those ids fall in instead.
  if (fips) {
    if (fips.range) return `${fips.field} >= ${fips.range.min} AND ${fips.field} < ${fips.range.max}`
    if (fips.type === 'number') return `${fips.field} = ${Number(fips.geoid)}`
    return fips.match === 'prefix'
      ? `starts_with(${fips.field}, '${fips.geoid}')`
      : `${fips.field}='${fips.geoid}'`
  }
  throw new PlaceFetchError(
    `"${ctx.slug}" needs placeQuery.geoField (for a point) or placeQuery.fipsField (for a county) before it can be fetched`,
    'no-endpoint',
  )
}

export function queryUrl(ctx: AdapterContext): URL {
  const url = requireUrl(ctx)
  url.searchParams.set('$where', soqlWhere(ctx))
  url.searchParams.set('$limit', String(Math.min(SOQL_LIMIT, ROWS_MAX + 1)))
  return url
}

/** A Socrata location column is `{ type: 'Point', coordinates: [...] }` (or the
 *  older `{ latitude, longitude }`), which is the only geometry these answers
 *  carry. */
function geometryOf(record: Record<string, unknown>, geoField?: string): unknown {
  const value = geoField ? record[geoField] : null
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.type === 'string' && Array.isArray(v.coordinates)) return value
  const lat = Number(v.latitude)
  const lng = Number(v.longitude)
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { type: 'Point', coordinates: [lng, lat] }
  return null
}

export async function fetchSocrata(ctx: AdapterContext): Promise<PlaceRows> {
  const body = await guardedJson<any>(queryUrl(ctx), { ...ctx.http, source: ctx.slug })
  if (!Array.isArray(body)) {
    const message = body?.message || body?.error || 'the portal answered with something other than rows'
    throw new PlaceFetchError(`Socrata: ${message}`, 'bad-response')
  }
  const records = body as Record<string, unknown>[]
  const result = normalizeRows(records, records.length > ROWS_MAX)
  result.geometry = featureCollection(
    result.rows.map((properties, i) => ({ geometry: geometryOf(records[i], ctx.placeQuery?.geoField), properties })),
  )
  return result
}

export default fetchSocrata
