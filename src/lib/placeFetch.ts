/**
 * Fetching a source for a place (P5-57), from the browser.
 *
 * The server does the work — geocoding, the guard, the adapters, the cache —
 * so this file is the API client plus the small amount of arithmetic a table
 * of in-memory rows needs (sorting, a CSV). Types mirror the route's answer in
 * server/src/routes/librarySources.ts.
 */
import { internalFetch } from './apiBase'

export interface PlacePoint {
  lat: number
  lng: number
}

export interface SlicePlace {
  label: string
  lat: number | null
  lng: number | null
  geoid: string | null
  radiusMiles: number
  address?: string
}

/** Ask for a place one of three ways: an address, a point, or a county. */
export interface PlaceFetchRequest {
  address?: string
  point?: PlacePoint
  geoid?: string
  radiusMiles?: number
  /** Skip the cache and ask the agency again. */
  refresh?: boolean
}

export interface PlaceFetchResult {
  rows: Record<string, string>[]
  columns: string[]
  count: number
  truncated: boolean
  fetchedAt: string
  cacheKey: string
  cached: boolean
  adapter: string
  place: SlicePlace
  geometry?: { type: 'FeatureCollection'; features: unknown[] }
}

export interface SliceSummary {
  cacheKey: string
  place: SlicePlace
  count: number
  truncated: boolean
  adapter: string
  fetchedAt: string
  ttlDays: number
}

/**
 * What a reader is told when a fetch fails. The server sends a sentence with
 * every failure; this is the fallback for the ones it cannot (a dropped
 * connection, a 502 from a proxy in front of us) so the panel is never blank.
 */
export const PLACE_ERROR_FALLBACK = 'that fetch did not work. Try again, or a smaller radius.'

async function failureOf(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    /* not JSON — fall through to the generic sentence */
  }
  if (res.status === 401 || res.status === 403) return 'your session expired — sign in again.'
  if (res.status === 429) return 'that was a lot of questions at once. Wait a moment and try again.'
  if (res.status === 503) return 'the library is not available right now.'
  return PLACE_ERROR_FALLBACK
}

export async function fetchForPlace(slug: string, request: PlaceFetchRequest): Promise<PlaceFetchResult> {
  const res = await internalFetch(`/api/library/sources/${encodeURIComponent(slug)}/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!res.ok) throw new Error(await failureOf(res))
  return (await res.json()) as PlaceFetchResult
}

export async function fetchSlices(slug: string): Promise<SliceSummary[]> {
  const res = await internalFetch(`/api/library/sources/${encodeURIComponent(slug)}/slices`)
  if (!res.ok) throw new Error(await failureOf(res))
  const body = await res.json()
  return (body.slices ?? []) as SliceSummary[]
}

export async function promoteSlice(slug: string, cacheKey: string, title?: string): Promise<{ slug: string; rows: number }> {
  const res = await internalFetch(`/api/library/sources/${encodeURIComponent(slug)}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cacheKey, ...(title ? { title } : {}) }),
  })
  if (!res.ok) throw new Error(await failureOf(res))
  return (await res.json()) as { slug: string; rows: number }
}

// --- The table ---------------------------------------------------------------

export type SortDirection = 'asc' | 'desc'

/**
 * Sort rows by one column. Numbers sort as numbers when the whole column is
 * numeric — otherwise "10" would come before "9" in a column of scores — and
 * blanks always sink to the bottom, whichever way the arrow points, because an
 * empty cell is not the smallest value, it is the absence of one.
 */
export function sortRows(
  rows: Record<string, string>[],
  column: string,
  direction: SortDirection,
): Record<string, string>[] {
  const values = rows.map(r => r[column] ?? '')
  const numeric = values.some(v => v.trim() !== '') && values.every(v => v.trim() === '' || Number.isFinite(Number(v)))
  const sign = direction === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const x = (a[column] ?? '').trim()
    const y = (b[column] ?? '').trim()
    if (!x && !y) return 0
    if (!x) return 1
    if (!y) return -1
    if (numeric) return sign * (Number(x) - Number(y))
    return sign * x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' })
  })
}

/** RFC 4180 quoting: a field with a comma, a quote or a newline is quoted and
 *  its quotes doubled. */
export function toCsv(columns: string[], rows: Record<string, string>[]): string {
  const cell = (value: string): string => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
  const lines = [columns.map(cell).join(',')]
  for (const row of rows) lines.push(columns.map(c => cell(row[c] ?? '')).join(','))
  return `${lines.join('\n')}\n`
}

export function csvFilename(slug: string, cacheKey: string): string {
  return `${slug}-${cacheKey}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) + '.csv'
}

// --- Saying where ------------------------------------------------------------

/** A place in the words a person used, for the result header and the slice
 *  list. Falls back to the coordinates when nothing better was recorded. */
export function placeLabel(place: SlicePlace | undefined | null): string {
  if (!place) return 'this place'
  if (place.label) return place.label
  if (place.geoid) return `County ${place.geoid}`
  if (place.lat !== null && place.lng !== null) return `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`
  return 'this place'
}

/** The default radius for a source: what its manifest recommends, else five
 *  miles. Counties and other whole-area sources still carry one, because the
 *  panel also offers "near a point". */
export function defaultRadius(radiusMiles?: number): number {
  return Number.isFinite(radiusMiles) && (radiusMiles as number) > 0 ? (radiusMiles as number) : 5
}
