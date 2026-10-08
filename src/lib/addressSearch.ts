/**
 * Finding a street address, for a map that is showing data about counties
 * (P9-11).
 *
 * **Mapbox, not the Census geocoder** (Nick, 2026-10-08): the Census one is
 * free and returns a GEOID outright, but it cannot do partial input, and
 * type-ahead is the point of a search box. The cost is accepted and
 * controlled here rather than hoped about:
 *
 *  - nothing is asked until `MIN_QUERY` characters, so "1", "12", "123" are
 *    three keystrokes and zero requests;
 *  - `DEBOUNCE_MS` after the last one, so a typed address is one call and not
 *    thirty;
 *  - every answer is cached for the session, so backspacing through a query
 *    and retyping it costs nothing.
 *
 * Routed through OUR API rather than called from the browser (Nick gave the
 * token to the server, 2026-10-08). That buys no secrecy — the same public
 * token is in the client bundle for the map tiles and always will be — it
 * buys a PATH: `recordUsage` keys on one, so geocoding is a line on the
 * internal dashboard and something the rate limiter can hold down, and our
 * server cannot be used as an open geocoder by a stranger.
 */
import { internalFetch } from '@/lib/apiBase'

export interface AddressHit {
  /** What Mapbox calls it: "1600 Pennsylvania Ave NW, Washington, DC 20500". */
  name: string
  /** `[lng, lat]`, the order mapbox-gl and GeoJSON both use. */
  center: [number, number]
}

/** Below this, a query is too short to mean anything and is not sent. */
export const MIN_QUERY = 4

/** How long after the last keystroke to ask. */
export const DEBOUNCE_MS = 350

const cache = new Map<string, AddressHit[]>()

function key(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** What is already known, with no request. Exported so a caller can show an
 *  answer in the same frame rather than flashing an empty list. */
export function cachedAddresses(query: string): AddressHit[] | null {
  return cache.get(key(query)) ?? null
}

export interface Suggestions {
  hits: AddressHit[]
  /**
   * The search is not configured — no token on the server — as opposed to
   * finding nothing. Railway does not read `server/.env`, so this is what a
   * prod box looks like until someone sets the variable there, and "Nothing
   * found" would be a lie about the address instead of the truth about the
   * deploy.
   */
  unavailable: boolean
}

/**
 * Addresses matching a partial query.
 *
 * The server asks Mapbox with `types` leading on `address` — the whole reason
 * this is not the Census geocoder — keeping `place` and `postcode` so
 * "Memphis" and "38109" still work. Never throws: a search box that breaks
 * the page because a geocoder hiccuped is worse than one that finds nothing.
 */
export async function suggestAddresses(query: string, signal?: AbortSignal): Promise<Suggestions> {
  const normalised = key(query)
  if (normalised.length < MIN_QUERY) return { hits: [], unavailable: false }
  const known = cache.get(normalised)
  if (known) return { hits: known, unavailable: false }

  try {
    const response = await internalFetch(`/api/geocode/suggest?q=${encodeURIComponent(normalised)}`, { signal })
    if (!response.ok) return { hits: [], unavailable: false }
    const body = (await response.json()) as { hits?: unknown; unavailable?: unknown }
    if (body.unavailable === true) return { hits: [], unavailable: true }
    const hits: AddressHit[] = []
    for (const raw of Array.isArray(body.hits) ? body.hits : []) {
      const hit = (raw ?? {}) as { name?: unknown; center?: unknown }
      const name = typeof hit.name === 'string' ? hit.name : ''
      const center = Array.isArray(hit.center) ? (hit.center as unknown[]) : []
      const lng = typeof center[0] === 'number' ? center[0] : NaN
      const lat = typeof center[1] === 'number' ? center[1] : NaN
      if (name && Number.isFinite(lng) && Number.isFinite(lat)) hits.push({ name, center: [lng, lat] })
    }
    // Only a real answer is cached; a failure must not become a permanent
    // "nothing here" for the rest of the session.
    cache.set(normalised, hits)
    return { hits, unavailable: false }
  } catch {
    return { hits: [], unavailable: false }
  }
}

/** Testing seam — the cache is module state and a test must not inherit
 *  another test's answers. */
export function clearAddressCache(): void {
  cache.clear()
}
