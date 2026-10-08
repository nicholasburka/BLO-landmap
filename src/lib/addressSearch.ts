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
 * Called straight from the browser, which is what `PromptInput` already does
 * for its place strip — the token is public and in the bundle for the map
 * tiles regardless. The authoritative number is therefore Mapbox's own usage
 * dashboard, which is also where the billing is; an in-app counter would need
 * a server-side token and would still only be an estimate of it.
 */
import { MAPBOX_ACCESS_TOKEN } from '@/config/constants'

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

/**
 * Addresses matching a partial query.
 *
 * `types` leads with `address` — the whole reason this is not the Census
 * geocoder — and keeps `place` and `postcode` so "Memphis" and "38109" still
 * work. Returns [] rather than throwing: a search box that explodes on a
 * flaky network is worse than one that finds nothing.
 */
export async function suggestAddresses(query: string, signal?: AbortSignal): Promise<AddressHit[]> {
  const normalised = key(query)
  if (normalised.length < MIN_QUERY) return []
  const known = cache.get(normalised)
  if (known) return known
  if (!MAPBOX_ACCESS_TOKEN) return []

  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(normalised)}.json` +
    `?access_token=${MAPBOX_ACCESS_TOKEN}` +
    `&country=us&types=address,place,postcode&limit=5&autocomplete=true`

  try {
    const response = await fetch(url, { signal })
    if (!response.ok) return []
    const body = (await response.json()) as { features?: unknown[] }
    const hits: AddressHit[] = []
    for (const raw of body.features ?? []) {
      const feature = raw as { place_name?: unknown; center?: unknown }
      const name = typeof feature.place_name === 'string' ? feature.place_name : ''
      const center = Array.isArray(feature.center) ? feature.center : []
      const [lng, lat] = center as number[]
      if (name && Number.isFinite(lng) && Number.isFinite(lat)) hits.push({ name, center: [lng, lat] })
    }
    cache.set(normalised, hits)
    return hits
  } catch {
    // Aborted, offline, rate-limited: no suggestions, no crash.
    return []
  }
}

/** Testing seam — the cache is module state and a test must not inherit
 *  another test's answers. */
export function clearAddressCache(): void {
  cache.clear()
}
