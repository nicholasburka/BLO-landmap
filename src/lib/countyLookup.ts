/**
 * County Name → GEOID Lookup
 *
 * Shared module usable in both browser and Node (no environment-specific imports).
 * Data is loaded lazily from the generated lookup JSON.
 *
 * Used by Phase 3 LLM tool handlers and any backend scripts that need
 * to resolve county names to FIPS GEOIDs.
 */

export interface CountyLookup {
  geoId: string
  /** Full display name, e.g., "Mecklenburg County" or "Baltimore city" */
  name: string
  /** Name without suffix, e.g., "Mecklenburg" */
  baseName: string
  stateName: string
  stateAbbr: string
}

let cache: CountyLookup[] | null = null
let loadPromise: Promise<CountyLookup[]> | null = null

/** URL where the lookup JSON is served (browser) */
const LOOKUP_URL = '/datasets/geographic/county-lookup.json'

/**
 * Load the county lookup data. Caches on first call.
 * In browser, fetches from the static dataset.
 * In Node, callers should inject data via `setCountyData()`.
 */
async function loadData(): Promise<CountyLookup[]> {
  if (cache) return cache
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    // Browser: fetch the static file
    if (typeof fetch !== 'undefined') {
      const res = await fetch(LOOKUP_URL)
      if (!res.ok) throw new Error(`Failed to load county lookup: ${res.status}`)
      const data = (await res.json()) as CountyLookup[]
      cache = data
      return data
    }
    throw new Error('County lookup data not loaded. Call setCountyData() first in Node environments.')
  })()

  return loadPromise
}

/** Inject data directly (useful for Node scripts that read the file directly) */
export function setCountyData(data: CountyLookup[]): void {
  cache = data
}

/** Ensure the lookup is loaded before querying */
export async function initCountyLookup(): Promise<void> {
  await loadData()
}

/** Normalize a string for comparison: lowercase, strip "county"/"parish"/etc. suffixes */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(county|parish|borough|census area|city and borough|municipality|island)\b/g, '')
    .replace(/[.,]/g, '')
    .trim()
}

/** Normalize a state query to match against full name or abbreviation */
function normalizeState(s: string): string {
  return s.toUpperCase().trim()
}

/**
 * Find counties matching a name, optionally filtered by state.
 *
 * @param name - County name (with or without "County" suffix)
 * @param stateHint - State name ("North Carolina") or 2-letter abbr ("NC")
 * @returns Array of matches (may be empty, may contain multiple)
 */
export function findCounty(name: string, stateHint?: string): CountyLookup[] {
  if (!cache) {
    throw new Error('County lookup not initialized. Call initCountyLookup() first.')
  }

  const normalizedQuery = normalize(name)
  if (!normalizedQuery) return []

  // Match counties where baseName contains the query (or vice-versa for exact)
  let matches = cache.filter((c) => {
    const baseNorm = normalize(c.baseName)
    return baseNorm === normalizedQuery || baseNorm.includes(normalizedQuery)
  })

  // Prefer exact matches over substring
  const exactMatches = matches.filter((c) => normalize(c.baseName) === normalizedQuery)
  if (exactMatches.length > 0) matches = exactMatches

  // Apply state filter
  if (stateHint) {
    const stateNorm = normalizeState(stateHint)
    matches = matches.filter(
      (c) => c.stateAbbr === stateNorm || c.stateName.toUpperCase() === stateNorm
    )
  }

  return matches
}

/** Look up a single county by GEOID (exact match) */
export function getCountyByGeoId(geoId: string): CountyLookup | undefined {
  if (!cache) {
    throw new Error('County lookup not initialized. Call initCountyLookup() first.')
  }
  return cache.find((c) => c.geoId === geoId)
}

/** Get all loaded counties (for iteration, testing, etc.) */
export function getAllCounties(): CountyLookup[] {
  if (!cache) {
    throw new Error('County lookup not initialized. Call initCountyLookup() first.')
  }
  return cache
}
