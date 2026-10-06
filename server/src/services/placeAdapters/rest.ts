import { guardedJson, PlaceFetchError } from '../placeHttp.js'
import { normalizeRows, ROWS_MAX, type AdapterContext, type PlaceRows } from './shared.js'

/**
 * A plain REST endpoint described by a URL template in the manifest
 * (`placeQuery.template`), e.g.
 *
 *   https://data.epa.gov/efservice/tri_facility/state_county_fips_code/{geoid}/rows/0:999/JSON
 *
 * Only five placeholders exist and each one is replaced by a value we
 * generated — a number we parsed, or five digits. **No free text is ever
 * substituted**: an address a person typed is geocoded into numbers long
 * before it reaches here, so a template can never be turned into a way to
 * smuggle a path or a query parameter into someone else's API.
 */

export const PLACEHOLDERS = ['lat', 'lng', 'geoid', 'radiusMiles', 'bbox'] as const
export type Placeholder = (typeof PLACEHOLDERS)[number]

/** The values a template may see. Every one is a number or a 5-digit code. */
export function templateValues(ctx: AdapterContext): Partial<Record<Placeholder, string>> {
  const values: Partial<Record<Placeholder, string>> = {}
  if (ctx.place.point) {
    values.lat = String(ctx.place.point.lat)
    values.lng = String(ctx.place.point.lng)
  }
  if (ctx.place.geoid) values.geoid = ctx.place.geoid
  values.radiusMiles = String(ctx.place.radiusMiles)
  if (ctx.place.bbox) values.bbox = ctx.place.bbox.map(n => String(n)).join(',')
  return values
}

export function fillTemplate(template: string, ctx: AdapterContext): URL {
  const values = templateValues(ctx)
  const missing: string[] = []
  const filled = template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) return whole
    const value = values[name as Placeholder]
    if (value === undefined) {
      missing.push(name)
      return whole
    }
    return encodeURIComponent(value)
  })
  if (missing.length) {
    throw new PlaceFetchError(`this source needs ${missing.join(' and ')} for a place, which we do not have`, 'bad-place')
  }
  try {
    return new URL(filled)
  } catch {
    throw new PlaceFetchError('the URL template in this source is not a url', 'no-endpoint')
  }
}

/**
 * Find the rows in an answer whose shape we were not told. A bare array is the
 * rows; otherwise the first array of objects within three levels is (EPA's
 * Envirofacts nests them one deep, ECHO two). Anything else is a `bad-response`
 * rather than a guess.
 */
export function findRecords(body: unknown, depth = 0): Record<string, unknown>[] | null {
  if (Array.isArray(body)) {
    return body.every(item => item && typeof item === 'object' && !Array.isArray(item))
      ? (body as Record<string, unknown>[])
      : null
  }
  if (depth >= 3 || !body || typeof body !== 'object') return null
  for (const value of Object.values(body as Record<string, unknown>)) {
    const found = findRecords(value, depth + 1)
    if (found && found.length) return found
  }
  return null
}

export async function fetchRest(ctx: AdapterContext): Promise<PlaceRows> {
  const template = ctx.placeQuery?.template ?? ctx.access.url
  if (!template) throw new PlaceFetchError(`"${ctx.slug}" has no URL template to fetch a place with`, 'no-endpoint')
  if (!/\{(lat|lng|geoid|radiusMiles|bbox)\}/.test(template)) {
    // Without a placeholder the URL is the same for every place, which would
    // quietly hand back the national table as if it were this parcel's answer.
    throw new PlaceFetchError(
      `"${ctx.slug}" needs a placeQuery.template with {lat}/{lng}, {geoid} or {bbox} in it before it can be fetched for a place`,
      'no-endpoint',
    )
  }
  const body = await guardedJson<unknown>(fillTemplate(template, ctx), { ...ctx.http, source: ctx.slug })
  const records = findRecords(body)
  if (!records) throw new PlaceFetchError('that endpoint answered with something that is not a table of rows', 'bad-response')
  return normalizeRows(records, records.length > ROWS_MAX)
}

export default fetchRest
