import { guardedJson, PlaceFetchError } from '../placeHttp.js'
import {
  featureCollection,
  fipsFilterFor,
  milesToMeters,
  normalizeRows,
  requireUrl,
  ROWS_MAX,
  type AdapterContext,
  type FipsFilter,
  type PlaceRows,
} from './shared.js'

/**
 * ArcGIS FeatureServer / MapServer layers — 23 of the 40 seed sources.
 *
 * Two ways to ask, in this order:
 *   1. a county FIPS filter, when the place is a county and the manifest names
 *      the column (`placeQuery.fipsField`, or the researcher's note);
 *   2. a point with a distance buffer, which is what "within five miles of
 *      this parcel" means.
 *
 * `f=geojson` is asked for because the map wants the shapes, but plenty of
 * MapServer layers ignore it and answer in Esri JSON, so both are read.
 *
 * Paging is bounded at PAGE_CAP pages: a slice is an answer to a question
 * about one place, and a query that needs more than 5,000 features is a query
 * for a whole dataset — which is what "Save as dataset" and a real replication
 * are for.
 */

export const PAGE_SIZE = 1_000
export const PAGE_CAP = 5

/** A `/FeatureServer` with no layer index cannot be queried; layer 0 is the
 *  convention, and every seed manifest that omits the index means it. */
export function layerUrl(url: URL): URL {
  const path = url.pathname.replace(/\/+$/, '')
  if (/\/(FeatureServer|MapServer)$/i.test(path)) {
    const next = new URL(url.toString())
    next.pathname = `${path}/0`
    return next
  }
  return url
}

/** The county clause, in the dialect a layer's `where` speaks. */
function arcgisWhere(fips: FipsFilter): string {
  if (fips.range) return `${fips.field} >= ${fips.range.min} AND ${fips.field} < ${fips.range.max}`
  if (fips.type === 'number') return `${fips.field}=${Number(fips.geoid)}`
  return fips.match === 'prefix' ? `${fips.field} LIKE '${fips.geoid}%'` : `${fips.field}='${fips.geoid}'`
}

export function queryUrl(ctx: AdapterContext, offset: number): URL {
  const base = layerUrl(requireUrl(ctx))
  const url = new URL(`${base.toString().replace(/\/+$/, '')}/query`)
  const params = url.searchParams
  params.set('outFields', '*')
  params.set('outSR', '4326')
  params.set('f', 'geojson')
  params.set('resultOffset', String(offset))
  params.set('resultRecordCount', String(PAGE_SIZE))

  const fips = fipsFilterFor(ctx)
  // A point is the more specific question, and it is the one the person asked:
  // geocoding an address yields a county too, and filtering by that county
  // would quietly answer about somewhere thirty miles away.
  if (ctx.place.point) {
    params.set('where', '1=1')
    params.set('geometry', `${ctx.place.point.lng},${ctx.place.point.lat}`)
    params.set('geometryType', 'esriGeometryPoint')
    params.set('inSR', '4326')
    params.set('spatialRel', 'esriSpatialRelIntersects')
    params.set('distance', String(milesToMeters(ctx.place.radiusMiles)))
    params.set('units', 'esriSRUnit_Meter')
  } else if (fips) {
    // The field name is validated on the way into the manifest and the value
    // is checked to be five digits before it gets here, so this clause cannot
    // be widened by anything a person typed. LIKE with a trailing % is how a
    // tract or block-group layer answers "rows in this county" (P5-59); a
    // numeric column answers the same question as a range, because its ids
    // have lost the leading zero a prefix would need.
    params.set('where', arcgisWhere(fips))
  } else {
    throw new PlaceFetchError(
      `"${ctx.slug}" can be asked about a point, or about a county when the manifest names its FIPS column`,
      'no-endpoint',
    )
  }
  return url
}

interface EsriFeature {
  attributes?: Record<string, unknown>
  properties?: Record<string, unknown>
  geometry?: unknown
}

/** Esri point geometry (`{x, y}`) as GeoJSON, so one map layer can draw either
 *  answer. Anything more complicated in Esri form is left behind — the rows
 *  are the answer, the shapes are a bonus. */
function toGeoJsonGeometry(geometry: unknown): unknown {
  if (!geometry || typeof geometry !== 'object') return null
  const g = geometry as Record<string, unknown>
  if (typeof g.type === 'string') return geometry
  if (typeof g.x === 'number' && typeof g.y === 'number') return { type: 'Point', coordinates: [g.x, g.y] }
  return null
}

export function readPage(body: any): { records: Record<string, unknown>[]; geometries: unknown[]; exceeded: boolean } {
  if (body?.error) {
    const details = Array.isArray(body.error?.details) ? body.error.details.filter(Boolean).join('; ') : ''
    const message = body.error?.message || details || 'the layer refused the query'
    throw new PlaceFetchError(`ArcGIS: ${message}`, 'bad-response')
  }
  const features: EsriFeature[] = Array.isArray(body?.features) ? body.features : []
  const records = features.map(f => (f.properties ?? f.attributes ?? {}) as Record<string, unknown>)
  const geometries = features.map(f => toGeoJsonGeometry(f.geometry))
  return { records, geometries, exceeded: body?.exceededTransferLimit === true || body?.properties?.exceededTransferLimit === true }
}

export async function fetchArcgis(ctx: AdapterContext): Promise<PlaceRows> {
  const records: Record<string, unknown>[] = []
  const geometries: unknown[] = []
  let hadMore = false

  for (let page = 0; page < PAGE_CAP; page++) {
    const body = await guardedJson<any>(queryUrl(ctx, page * PAGE_SIZE), { ...ctx.http, source: ctx.slug })
    const parsed = readPage(body)
    records.push(...parsed.records)
    geometries.push(...parsed.geometries)
    if (parsed.records.length < PAGE_SIZE) break
    if (page === PAGE_CAP - 1) hadMore = true
    if (records.length >= ROWS_MAX) {
      hadMore = hadMore || parsed.exceeded || parsed.records.length === PAGE_SIZE
      break
    }
  }

  const result = normalizeRows(records, hadMore)
  result.geometry = featureCollection(result.rows.map((properties, i) => ({ geometry: geometries[i], properties })))
  return result
}

export default fetchArcgis
