import Papa from 'papaparse'
import { getFile, isBucketEnabled, listFiles, putFile } from '../libraryBucket.js'
import { guardedGet, PlaceFetchError } from '../placeHttp.js'
import {
  bboxAround,
  distanceMiles,
  featureCollection,
  findColumn,
  GEOID_COLUMN_RE,
  LAT_COLUMN_RE,
  LNG_COLUMN_RE,
  normalizeRows,
  requireUrl,
  ROWS_MAX,
  ttlDaysFor,
  type AdapterContext,
  type PlaceRows,
} from './shared.js'

/**
 * A source that publishes one file and no query API: pull it once, keep it,
 * and answer every place from the copy.
 *
 * The whole file is fetched under the same byte cap as everything else and
 * parked at `library/derived/sources/<slug>/full.<ext>` — derived, so a
 * reindex walks past it and it never looks like content a person pushed. It is
 * pulled again when it is older than the manifest's update cadence, and only
 * then; a monthly CSV is not worth 30 MB a question.
 *
 * Filtering is by county FIPS when we have one and the file has a GEOID
 * column, otherwise by the box around the point and then the exact radius.
 */

export const FULL_PREFIX = 'library/derived/sources/'

export function fullKey(slug: string, ext: string): string {
  return `${FULL_PREFIX}${slug}/full.${ext}`
}

/** csv or geojson, from the manifest's format, else the URL, else the answer's
 *  content type. Everything else (zip, shapefile, xlsx) we cannot filter here. */
export function extensionFor(ctx: AdapterContext, contentType?: string): 'csv' | 'geojson' {
  const declared = (ctx.access.format ?? '').toLowerCase()
  if (declared.includes('geojson') || declared === 'json') return 'geojson'
  if (declared.includes('csv')) return 'csv'
  const path = (ctx.access.url ?? '').toLowerCase()
  if (path.includes('.geojson') || path.includes('.json')) return 'geojson'
  if (path.includes('.csv')) return 'csv'
  if ((contentType ?? '').includes('json')) return 'geojson'
  return 'csv'
}

async function cachedAge(key: string): Promise<number | null> {
  if (!isBucketEnabled()) return null
  const files = await listFiles(key)
  const found = files.find(f => f.key === key)
  if (!found?.lastModified) return null
  return Date.now() - new Date(found.lastModified).getTime()
}

/** The file's bytes — from the bucket when the copy is still fresh, otherwise
 *  from the agency, once, under the guard. */
export async function loadFullFile(ctx: AdapterContext): Promise<{ text: string; ext: 'csv' | 'geojson'; cached: boolean }> {
  const url = requireUrl(ctx)
  const ext = extensionFor(ctx)
  const key = fullKey(ctx.slug, ext)
  const ttlMs = ttlDaysFor(ctx.updateCadence) * 24 * 60 * 60 * 1000

  const age = await cachedAge(key).catch(() => null)
  if (age !== null && age < ttlMs) {
    try {
      return { text: (await getFile(key)).toString('utf8'), ext, cached: true }
    } catch {
      /* the copy went missing between the listing and the read — pull it again */
    }
  }

  const { body, contentType } = await guardedGet(url, { ...ctx.http, source: ctx.slug })
  const realExt = extensionFor(ctx, contentType)
  if (isBucketEnabled()) {
    await putFile(fullKey(ctx.slug, realExt), body, realExt === 'csv' ? 'text/csv' : 'application/geo+json').catch(err => {
      // A file we could not keep is a slower next question, not a failed one.
      console.error(`[place] could not cache ${ctx.slug} full file:`, err?.message || err)
    })
  }
  return { text: body, ext: realExt, cached: false }
}

// --- Filters -----------------------------------------------------------------

function matchesGeoid(value: string, geoid: string): boolean {
  const digits = value.replace(/\D/g, '')
  // A tract or block GEOID starts with its county's five digits, so a prefix
  // match answers "is this row in my county?" for every level below it.
  return digits === geoid || (digits.length > 5 && digits.startsWith(geoid))
}

export function filterCsv(text: string, ctx: AdapterContext): PlaceRows {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const parsed = Papa.parse<Record<string, unknown>>(clean, { header: true, skipEmptyLines: 'greedy' })
  const columns = parsed.meta.fields ?? []
  const all = parsed.data

  const geoidColumn = findColumn(columns, GEOID_COLUMN_RE, ctx.placeQuery?.fipsField)
  if (ctx.place.geoid && geoidColumn) {
    const geoid = ctx.place.geoid
    return normalizeRows(all.filter(row => matchesGeoid(String(row[geoidColumn] ?? ''), geoid)))
  }

  const latColumn = findColumn(columns, LAT_COLUMN_RE)
  const lngColumn = findColumn(columns, LNG_COLUMN_RE)
  if (ctx.place.point && latColumn && lngColumn) {
    const point = ctx.place.point
    const [west, south, east, north] = ctx.place.bbox ?? bboxAround(point, ctx.place.radiusMiles)
    const kept: Record<string, unknown>[] = []
    const geometries: unknown[] = []
    for (const row of all) {
      const lat = Number(row[latColumn])
      const lng = Number(row[lngColumn])
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
      if (lng < west || lng > east || lat < south || lat > north) continue
      if (distanceMiles(point, { lat, lng }) > ctx.place.radiusMiles) continue
      kept.push(row)
      geometries.push({ type: 'Point', coordinates: [lng, lat] })
    }
    const result = normalizeRows(kept)
    result.geometry = featureCollection(result.rows.map((properties, i) => ({ geometry: geometries[i], properties })))
    return result
  }

  throw new PlaceFetchError(
    `"${ctx.slug}" is a file with no county column and no coordinates, so we cannot cut it to a place — open it by hand`,
    'no-endpoint',
  )
}

/** Every coordinate in a geometry, flattened — enough for a bounding box. */
function coordsOf(geometry: any, out: [number, number][] = []): [number, number][] {
  const c = geometry?.coordinates
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      out.push([node[0] as number, node[1] as number])
      return
    }
    for (const child of node) walk(child)
  }
  walk(c)
  return out
}

export function filterGeoJson(text: string, ctx: AdapterContext): PlaceRows {
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    throw new PlaceFetchError(`the file behind "${ctx.slug}" is not GeoJSON we can read`, 'bad-response')
  }
  const features: any[] = Array.isArray(body?.features) ? body.features : Array.isArray(body) ? body : []
  const [west, south, east, north] = ctx.place.bbox ??
    (ctx.place.point ? bboxAround(ctx.place.point, ctx.place.radiusMiles) : [-180, -90, 180, 90])

  const kept: Record<string, unknown>[] = []
  const geometries: unknown[] = []
  for (const feature of features) {
    const properties = (feature?.properties ?? {}) as Record<string, unknown>
    if (ctx.place.geoid) {
      const column = findColumn(Object.keys(properties), GEOID_COLUMN_RE, ctx.placeQuery?.fipsField)
      if (column) {
        if (!matchesGeoid(String(properties[column] ?? ''), ctx.place.geoid)) continue
        kept.push(properties)
        geometries.push(feature.geometry ?? null)
        continue
      }
    }
    const coords = coordsOf(feature?.geometry)
    if (!coords.length) continue
    // A polygon counts when any part of it is in the box — a flood zone that
    // touches the parcel matters even if its centroid is miles away.
    const hit = coords.some(([lng, lat]) => lng >= west && lng <= east && lat >= south && lat <= north)
    if (!hit) continue
    kept.push(properties)
    geometries.push(feature.geometry ?? null)
  }

  const result = normalizeRows(kept, kept.length > ROWS_MAX)
  result.geometry = featureCollection(result.rows.map((properties, i) => ({ geometry: geometries[i], properties })))
  return result
}

export async function fetchDownload(ctx: AdapterContext): Promise<PlaceRows> {
  const { text, ext } = await loadFullFile(ctx)
  return ext === 'geojson' ? filterGeoJson(text, ctx) : filterCsv(text, ctx)
}

export default fetchDownload
