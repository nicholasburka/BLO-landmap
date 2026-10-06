import { guardedJson, PlaceFetchError, type GuardedGetOptions } from './placeHttp.js'

/**
 * Turning a place a person typed into coordinates and a county (P5-23, moved
 * here for P5-57).
 *
 * This was the live resolver inside `cli/geocode.ts`, where it enriched a CSV.
 * P5-57 needs the same two calls from a request — "any Superfund sites near
 * 123 Main St?" starts with an address — so the resolver, its URLs and its
 * parsers moved into a service and the CLI re-exports them. Behaviour is
 * unchanged for the CLI: `liveResolver()` still speaks to a plain `fetch` it
 * can be handed, which is what its tests inject.
 *
 * The server-side entry points (`geocodeAddress`, `countyForPoint`) go through
 * the host guard instead, because they run inside a request.
 *
 * Census first (it is authoritative for US addresses and returns the county in
 * the same answer), Nominatim second (it finds towns and landmarks the Census
 * address matcher will not) — the same order the CLI resolves a row in.
 */

export interface AddressMatch {
  lat: number
  lng: number
  geoId: string | null
  matched: string
  exact: boolean
}

export interface PlaceMatch {
  lat: number
  lng: number
  label: string
}

export interface Resolver {
  /** Street address (one line) → coordinates + county FIPS. null = no match. */
  address(oneLine: string): Promise<AddressMatch | null>
  /** City + state → coordinates. null = no match. */
  place(city: string, state: string): Promise<PlaceMatch | null>
  /** Coordinates → 5-digit county FIPS. null = outside any county. */
  county(lat: number, lng: number): Promise<string | null>
}

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies'
const CENSUS_QS = 'benchmark=Public_AR_Current&vintage=Current_Current&format=json'
const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse'
const USER_AGENT = process.env.GEOCODE_USER_AGENT || 'BLO-library-geocode/1.0 (internal data library)'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// --- URLs and parsers, shared by both callers --------------------------------

export function censusAddressUrl(oneLine: string): string {
  return `${CENSUS}/onelineaddress?address=${encodeURIComponent(oneLine)}&${CENSUS_QS}`
}

/** `Number()` on both, always: these values arrive from a remote JSON body and
 *  are pasted into this URL, so a string could otherwise carry a query
 *  separator (or a path) into the next request. */
export function censusCountyUrl(lat: number, lng: number): string {
  return `${CENSUS}/coordinates?x=${Number(lng)}&y=${Number(lat)}&${CENSUS_QS}`
}

export function nominatimUrl(query: string): string {
  return `${NOMINATIM}?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&countrycodes=us`
}

/** Coordinates → the place they are in (P6-15). `zoom=10` asks for the
 *  city/county level rather than a doorstep: a report covers a radius, so the
 *  honest name is the area, not the nearest building. `Number()` on both for
 *  the reason `censusCountyUrl` gives. */
export function nominatimReverseUrl(lat: number, lng: number): string {
  return `${NOMINATIM_REVERSE}?lat=${Number(lat)}&lon=${Number(lng)}&format=jsonv2&zoom=10`
}

export const NOMINATIM_HEADERS = { 'User-Agent': USER_AGENT }

export function parseCensusAddress(body: any): AddressMatch | null {
  const m = body?.result?.addressMatches?.[0]
  if (!m) return null
  return {
    lat: Number(m.coordinates?.y),
    lng: Number(m.coordinates?.x),
    geoId: m.geographies?.Counties?.[0]?.GEOID ?? null,
    matched: m.matchedAddress ?? '',
    // The JSON endpoint returns only matches it considers usable; the batch
    // CSV's Exact/Non_Exact flag isn't exposed here, so treat a returned
    // match as high confidence.
    exact: true,
  }
}

export function parseCensusCounty(body: any): string | null {
  return body?.result?.geographies?.Counties?.[0]?.GEOID ?? null
}

export function parseNominatim(body: any): PlaceMatch | null {
  const hit = Array.isArray(body) ? body[0] : null
  if (!hit) return null
  return { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name ?? '' }
}

/**
 * A reverse lookup, as words a person would use (P6-15).
 *
 * Nominatim's `display_name` is a full postal chain — "Upper East Side,
 * Manhattan, New York County, City of New York, New York, 10065, United
 * States" — which is accurate and unreadable as a heading. The structured
 * `address` object is better: the locality, the county and the state, in that
 * order, deduplicated, at most three parts. `display_name` is the fallback
 * when the structure is missing, and null when there is nothing at all.
 */
export function parseNominatimReverse(body: any): string | null {
  const a = body?.address
  if (a && typeof a === 'object') {
    const locality = a.neighbourhood || a.suburb || a.city || a.town || a.village || a.hamlet || ''
    const parts = [locality, a.county || '', a.state || '']
      .map((part: unknown) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
    const unique = [...new Set(parts)].slice(0, 3)
    if (unique.length) return unique.join(', ')
  }
  const display = body?.display_name
  return typeof display === 'string' && display.trim() ? display.trim() : null
}


// --- The CLI's resolver (unguarded, injectable fetch) ------------------------

/** Network resolver: Census for addresses + county lookup, Nominatim (1 req/s)
 *  for places. Used by `npm run library -- geocode`, which is a one-shot local
 *  process working from a CSV a person chose — not a request. */
export function liveResolver(fetchImpl: typeof fetch = fetch): Resolver {
  let lastNominatim = 0
  return {
    async address(oneLine) {
      const res = await fetchImpl(censusAddressUrl(oneLine))
      if (!res.ok) throw new Error(`census address geocoder ${res.status}`)
      return parseCensusAddress(await res.json())
    },
    async place(city, state) {
      const wait = 1100 - (Date.now() - lastNominatim)
      if (wait > 0) await sleep(wait)
      lastNominatim = Date.now()
      const res = await fetchImpl(nominatimUrl(`${city}, ${state}, USA`), { headers: { ...NOMINATIM_HEADERS } })
      if (!res.ok) throw new Error(`nominatim ${res.status}`)
      return parseNominatim(await res.json())
    },
    async county(lat, lng) {
      await sleep(100)
      const res = await fetchImpl(censusCountyUrl(lat, lng))
      if (!res.ok) throw new Error(`census coordinates ${res.status}`)
      return parseCensusCounty(await res.json())
    },
  }
}

// --- The server's entry points (guarded) -------------------------------------

export interface GeocodedPlace {
  lat: number
  lng: number
  /** 5-digit county FIPS, when the address landed in one. */
  geoid: string | null
  /** What the geocoder thinks it matched — shown back so a person can check. */
  matched: string
  method: 'census-address' | 'nominatim-place'
}

export type GeocodeOptions = Pick<GuardedGetOptions, 'fetchImpl' | 'lookup' | 'timeoutMs'>

/** Coordinates → county FIPS, under the guard. Null when the point is outside
 *  every US county (the sea, Canada, a typo). */
export async function countyForPoint(lat: number, lng: number, options: GeocodeOptions = {}): Promise<string | null> {
  const body = await guardedJson<any>(new URL(censusCountyUrl(lat, lng)), options)
  return parseCensusCounty(body)
}

/** Coordinates → what that place is called, under the guard. Null when the
 *  lookup knows nothing — the caller falls back to the coordinates rather
 *  than inventing a name. */
export async function reverseGeocode(lat: number, lng: number, options: GeocodeOptions = {}): Promise<string | null> {
  const body = await guardedJson<any>(new URL(nominatimReverseUrl(lat, lng)), {
    ...options,
    headers: { ...NOMINATIM_HEADERS },
  })
  return parseNominatimReverse(body)
}

/**
 * One typed address → a point and its county.
 *
 * Census first; if it finds nothing (rural routes, a town name, a landmark)
 * Nominatim gets the same string and the county comes from a second Census
 * call. Null means neither knew the place — the caller says so in plain words
 * rather than guessing.
 */
export async function geocodeAddress(address: string, options: GeocodeOptions = {}): Promise<GeocodedPlace | null> {
  const query = address.trim()
  if (!query) return null

  const census = parseCensusAddress(await guardedJson<any>(new URL(censusAddressUrl(query)), options))
  if (census && Number.isFinite(census.lat) && Number.isFinite(census.lng)) {
    const geoid = census.geoId ?? (await countyForPoint(census.lat, census.lng, options).catch(() => null))
    return { lat: census.lat, lng: census.lng, geoid, matched: census.matched || query, method: 'census-address' }
  }

  const place = parseNominatim(
    await guardedJson<any>(new URL(nominatimUrl(query)), { ...options, headers: { ...NOMINATIM_HEADERS } }),
  )
  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return null
  const geoid = await countyForPoint(place.lat, place.lng, options).catch(() => null)
  return { lat: place.lat, lng: place.lng, geoid, matched: place.label || query, method: 'nominatim-place' }
}

/** A latitude/longitude pair we are willing to put in a URL.
 *
 *  `Number(null)` and `Number('')` are both 0, so a half-filled point would
 *  otherwise geocode to null island off the coast of Africa and answer the
 *  question about there. Only a number, or a string that is one, counts. */
export function validPoint(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const numeric = (value: unknown): number =>
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  const latNum = numeric(lat)
  const lngNum = numeric(lng)
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null
  if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) return null
  return { lat: latNum, lng: lngNum }
}

/** A 5-digit county FIPS, or null. Nothing else ever reaches a query. */
export function validGeoid(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
  return /^\d{5}$/.test(raw) ? raw : null
}

/** Turn a geocode miss into the failure the panel explains. */
export function noPlaceError(what: string): PlaceFetchError {
  return new PlaceFetchError(`could not find "${what}"`, 'bad-place')
}
