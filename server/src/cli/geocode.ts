import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Papa from 'papaparse'
import { stateCodeFor } from '../services/taxonomy.js'

/**
 * Enrichment pathway (P5-23): `npm run library -- geocode <csv> …`
 *
 * Adds `lat`, `lng`, `GEOID` (5-digit county FIPS), `geocode_method`, and
 * `geocode_confidence` to a CSV so a dataset can become a point layer
 * (P5-24) or a county aggregate (P5-18). Resolution order per row:
 *
 *   1. lat/lng already present  → county lookup only        (existing-latlng+census-county)
 *   2. county + state names     → offline FIPS join          (fips-join)
 *   3. street address           → Census one-line geocoder   (census-address)
 *   4. city + state             → Nominatim place → Census   (nominatim-place+census-county)
 *
 * Every remote answer (including "no match") is cached in a sidecar
 * `<csv>.geocode-cache.json`, so re-runs are idempotent and offline.
 * Existing lat/lng/GEOID values are never overwritten without --force.
 *
 * Provenance convention (documented in DEPLOY.md): enriched columns travel
 * with `<field>_source` / `<field>_confidence` / `<field>_conflict` /
 * `<field>_alt_location` siblings. When a `<field>_conflict` column marks a
 * city-level disagreement, the alternate location is geocoded too and
 * `<field>_alt_geoid` + `<field>_same_county` are emitted — Nick's rule:
 * conflicts are fine when they land in the same county.
 *
 * The resolver is injected so the unit tests never touch the network.
 */

export type GeocodeRow = Record<string, string>

/** The resolver — its types, its URLs and the live implementation — moved to
 *  `services/geocodePlace.ts` for P5-57 so a request can geocode one address
 *  with the same code this CLI geocodes ten thousand rows with. Re-exported
 *  here because this module's callers (and tests) have always imported it. */
export {
  liveResolver,
  type Resolver,
  type AddressMatch,
  type PlaceMatch,
} from '../services/geocodePlace.js'
import { liveResolver, type Resolver } from '../services/geocodePlace.js'

export interface GeocodeOptions {
  address?: string
  city?: string
  state?: string
  lat?: string
  lng?: string
  county?: string
  /** Provenance field prefix whose `_conflict`/`_alt_location` columns drive alt geocoding (auto-detected when omitted). */
  conflictField?: string
  force?: boolean
}

export type Confidence = 'high' | 'medium' | 'low'

export interface UnmatchedRow {
  row: number
  key: string
  reason: string
}

export interface ConflictRow {
  row: number
  key: string
  geoId: string | null
  altGeoId: string | null
  sameCounty: boolean | null
}

export interface GeocodeReport {
  rows: number
  geocoded: number
  kept: number
  unmatched: UnmatchedRow[]
  conflicts: ConflictRow[]
  methods: Record<string, number>
  resolverCalls: number
}

export const OUTPUT_COLUMNS = ['lat', 'lng', 'GEOID', 'geocode_method', 'geocode_confidence'] as const

// --- Cache -----------------------------------------------------------------------

export interface GeocodeCache {
  get(key: string): unknown | undefined
  set(key: string, value: unknown): void
  size(): number
}

export function memoryCache(initial: Record<string, unknown> = {}): GeocodeCache & { entries(): Record<string, unknown> } {
  const map = new Map(Object.entries(initial))
  return {
    get: k => map.get(k),
    set: (k, v) => void map.set(k, v),
    size: () => map.size,
    entries: () => Object.fromEntries(map),
  }
}

export async function loadCacheFile(path: string): Promise<ReturnType<typeof memoryCache>> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return memoryCache(parsed.entries as Record<string, unknown>)
    }
  } catch {
    /* missing or unreadable → start empty */
  }
  return memoryCache()
}

export async function saveCacheFile(path: string, cache: ReturnType<typeof memoryCache>): Promise<void> {
  await fs.writeFile(path, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries: cache.entries() }, null, 2))
}

/** Memoise a resolver through the cache (negative answers included). */
export function cachedResolver(inner: Resolver, cache: GeocodeCache, counter?: { calls: number }): Resolver {
  async function through<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit !== undefined) return hit as T
    if (counter) counter.calls++
    const value = await fn()
    cache.set(key, value)
    return value
  }
  return {
    address: line => through(`address:${normalizeKey(line)}`, () => inner.address(line)),
    place: (city, state) => through(`place:${normalizeKey(city)}|${normalizeKey(state)}`, () => inner.place(city, state)),
    county: (lat, lng) => through(`county:${lat.toFixed(5)},${lng.toFixed(5)}`, () => inner.county(lat, lng)),
  }
}

function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

// --- FIPS join (offline) -----------------------------------------------------------

export interface CountyLookupEntry {
  geoId: string
  name: string
  baseName: string
  stateName: string
  stateAbbr: string
}

export function normalizeStateAbbr(state: string): string | null {
  const t = state.trim()
  if (!t) return null
  // Any two letters are taken as a code, as they always have been here: a
  // bogus one simply finds no county downstream, and being strict would reject
  // a territory the table had not got round to.
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase()
  // P6-19: the name lookup is the one state table now (it had its own copy of
  // this, missing the four Pacific and Caribbean territories).
  return stateCodeFor(t) || null
}

const COUNTY_TYPE_RE = /\b(county|parish|borough|census area|city and borough|municipality|municipio)\b/g

export function normalizeCountyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bst\.?\s/g, 'saint ')
    .replace(/\bste\.?\s/g, 'sainte ')
    .replace(/[.'’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export class FipsIndex {
  private byFull = new Map<string, string>()
  private byBase = new Map<string, string[]>()

  constructor(entries: CountyLookupEntry[]) {
    for (const e of entries) {
      const st = e.stateAbbr.toUpperCase()
      this.byFull.set(`${st}|${normalizeCountyName(e.name)}`, e.geoId)
      const base = normalizeCountyName(e.baseName || e.name.replace(COUNTY_TYPE_RE, ''))
      const key = `${st}|${base}`
      this.byBase.set(key, [...(this.byBase.get(key) ?? []), e.geoId])
    }
  }

  /** "Orleans Parish" / "St. Louis city" / "Autauga" + state → GEOID; null when unknown or ambiguous. */
  find(countyName: string, state: string): string | null {
    const st = normalizeStateAbbr(state)
    if (!st || !countyName.trim()) return null
    const full = normalizeCountyName(countyName)
    const exact = this.byFull.get(`${st}|${full}`)
    if (exact) return exact
    const base = normalizeCountyName(countyName.replace(COUNTY_TYPE_RE, ''))
    const candidates = this.byBase.get(`${st}|${base}`) ?? []
    return candidates.length === 1 ? candidates[0] : null
  }
}

export async function loadFipsIndex(path?: string): Promise<FipsIndex> {
  const file = path ?? resolve(dirname(new URL(import.meta.url).pathname), '../../../public/datasets/geographic/county-lookup.json')
  const entries = JSON.parse(await fs.readFile(file, 'utf8')) as CountyLookupEntry[]
  return new FipsIndex(entries)
}

// --- Row geocoding ------------------------------------------------------------------

function cell(row: GeocodeRow, col: string | undefined): string {
  return col ? (row[col] ?? '').trim() : ''
}

function num(s: string): number | null {
  const n = Number(s)
  return s.trim() !== '' && Number.isFinite(n) ? n : null
}

/** First "City, ST" (or "City, State") in free text like "Atlanta, GA (IRS BMF); Chicago, IL (older)". */
export function parseAltLocation(text: string): { city: string; state: string } | null {
  const m = /([A-Za-z.'’\- ]+?),\s*([A-Za-z]{2}|[A-Za-z ]{4,20}?)(?=\s*[(;,]|\s*$)/.exec(text.trim())
  if (!m) return null
  const state = normalizeStateAbbr(m[2])
  if (!state) return null
  return { city: m[1].trim(), state }
}

/** Auto-detect a provenance prefix from `<x>_conflict` + `<x>_alt_location` columns. */
export function detectConflictField(columns: string[]): string | null {
  for (const c of columns) {
    const m = /^(.*)_conflict$/.exec(c)
    if (m && columns.includes(`${m[1]}_alt_location`)) return m[1]
  }
  return null
}

export async function geocodeRows(
  rows: GeocodeRow[],
  options: GeocodeOptions,
  resolver: Resolver,
  fips: FipsIndex | null,
): Promise<{ rows: GeocodeRow[]; columns: string[]; report: GeocodeReport }> {
  const counter = { calls: 0 }
  const counted: Resolver = {
    address: l => (counter.calls++, resolver.address(l)),
    place: (c, s) => (counter.calls++, resolver.place(c, s)),
    county: (a, b) => (counter.calls++, resolver.county(a, b)),
  }
  const report: GeocodeReport = { rows: rows.length, geocoded: 0, kept: 0, unmatched: [], conflicts: [], methods: {}, resolverCalls: 0 }
  const inputColumns = rows.length ? Object.keys(rows[0]) : []
  const conflictField = options.conflictField ?? detectConflictField(inputColumns)
  const altCols = conflictField ? [`${conflictField}_alt_geoid`, `${conflictField}_same_county`] : []
  const out: GeocodeRow[] = []
  const keyCol = inputColumns.find(c => /^(name|organization|title)$/i.test(c)) ?? inputColumns[0]

  for (let i = 0; i < rows.length; i++) {
    const row = { ...rows[i] }
    const key = row[keyCol] ?? String(i + 1)
    const bump = (m: string) => (report.methods[m] = (report.methods[m] ?? 0) + 1)
    const existingLat = num(row.lat ?? ''), existingLng = num(row.lng ?? '')
    const hasExisting = existingLat !== null && existingLng !== null && (row.GEOID ?? '').trim() !== ''

    if (hasExisting && !options.force) {
      report.kept++
    } else {
      let lat: number | null = null, lng: number | null = null, geoId: string | null = null
      let method = '', confidence: Confidence = 'low', reason = ''

      const givenLat = num(cell(row, options.lat)), givenLng = num(cell(row, options.lng))
      const countyName = cell(row, options.county)
      const state = cell(row, options.state)
      const city = cell(row, options.city)
      const address = cell(row, options.address)

      if (givenLat !== null && givenLng !== null) {
        lat = givenLat; lng = givenLng
        geoId = await counted.county(lat, lng)
        method = 'existing-latlng+census-county'; confidence = geoId ? 'high' : 'low'
        if (!geoId) reason = 'coordinates fall outside any US county'
      } else if (countyName && state && fips) {
        geoId = fips.find(countyName, state)
        method = 'fips-join'; confidence = 'high'
        if (!geoId) reason = `no unique county "${countyName}" in ${state}`
      } else if (address) {
        const line = [address, city, state].filter(Boolean).join(', ')
        const m = await counted.address(line)
        if (m) {
          lat = m.lat; lng = m.lng; geoId = m.geoId ?? (await counted.county(m.lat, m.lng))
          method = 'census-address'; confidence = m.exact ? 'high' : 'medium'
        } else if (city && state) {
          const p = await counted.place(city, state)
          if (p) {
            lat = p.lat; lng = p.lng; geoId = await counted.county(p.lat, p.lng)
            method = 'nominatim-place+census-county'; confidence = 'medium'
            if (!geoId) reason = 'place resolved but no county'
          } else reason = `address and place unresolved: ${line}`
        } else reason = `address unresolved: ${line}`
      } else if (city && state) {
        const p = await counted.place(city, state)
        if (p) {
          lat = p.lat; lng = p.lng; geoId = await counted.county(p.lat, p.lng)
          method = 'nominatim-place+census-county'; confidence = 'medium'
          if (!geoId) reason = 'place resolved but no county'
        } else reason = `place unresolved: ${city}, ${state}`
      } else {
        reason = 'no location columns filled'
      }

      if (lat !== null && lng !== null) { row.lat = String(lat); row.lng = String(lng) }
      else if (options.force) { row.lat = ''; row.lng = '' }
      else { row.lat = row.lat ?? ''; row.lng = row.lng ?? '' }
      row.GEOID = geoId ?? (options.force ? '' : row.GEOID ?? '')
      row.geocode_method = method
      row.geocode_confidence = method ? confidence : ''
      if (geoId || lat !== null) { report.geocoded++; bump(method) }
      if (reason) report.unmatched.push({ row: i + 1, key, reason })
    }

    // Conflict handling: geocode the alternate city and compare counties.
    if (conflictField) {
      const flag = (row[`${conflictField}_conflict`] ?? '').toLowerCase()
      const alt = parseAltLocation(row[`${conflictField}_alt_location`] ?? '')
      let altGeoId: string | null = null
      if (flag.includes('city') && alt) {
        const p = await counted.place(alt.city, alt.state)
        altGeoId = p ? await counted.county(p.lat, p.lng) : null
        const primary = (row.GEOID ?? '').trim() || null
        const same = primary && altGeoId ? primary === altGeoId : null
        row[`${conflictField}_alt_geoid`] = altGeoId ?? ''
        row[`${conflictField}_same_county`] = same === null ? '' : same ? 'yes' : 'no'
        report.conflicts.push({ row: i + 1, key, geoId: primary, altGeoId, sameCounty: same })
      } else {
        row[`${conflictField}_alt_geoid`] = row[`${conflictField}_alt_geoid`] ?? ''
        row[`${conflictField}_same_county`] = row[`${conflictField}_same_county`] ?? ''
      }
    }
    out.push(row)
  }
  report.resolverCalls = counter.calls
  const columns = [...inputColumns]
  for (const c of [...OUTPUT_COLUMNS, ...altCols]) if (!columns.includes(c)) columns.push(c)
  return { rows: out, columns, report }
}

// --- CSV I/O -------------------------------------------------------------------------

export function parseCsv(text: string): { rows: GeocodeRow[]; columns: string[] } {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const result = Papa.parse<GeocodeRow>(clean, { header: true, skipEmptyLines: 'greedy' })
  const columns = result.meta.fields ?? []
  const rows = result.data.map(r => {
    const row: GeocodeRow = {}
    for (const c of columns) row[c] = r[c] == null ? '' : String(r[c])
    return row
  })
  return { rows, columns }
}

export function toCsv(rows: GeocodeRow[], columns: string[]): string {
  return Papa.unparse({ fields: columns, data: rows.map(r => columns.map(c => r[c] ?? '')) }, { newline: '\n' }) + '\n'
}

// --- CLI entry (called from library.ts) -----------------------------------------------

export interface GeocodeCliArgs {
  input: string
  out?: string
  inPlace?: boolean
  dryRun?: boolean
  options: GeocodeOptions
}

export function parseGeocodeArgs(args: string[]): GeocodeCliArgs | { error: string } {
  const input = args.find(a => !a.startsWith('--') && a !== 'geocode')
  if (!input) return { error: 'geocode: missing <csv> path' }
  const val = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined
  }
  const options: GeocodeOptions = {
    address: val('--address'),
    city: val('--city'),
    state: val('--state'),
    lat: val('--lat'),
    lng: val('--lng'),
    county: val('--county'),
    conflictField: val('--conflict-field'),
    force: args.includes('--force'),
  }
  if (!options.address && !(options.city && options.state) && !(options.lat && options.lng) && !(options.county && options.state)) {
    return { error: 'geocode: give --address COL, --city COL --state COL, --lat COL --lng COL, or --county COL --state COL' }
  }
  return { input: resolve(input), out: val('--out') ? resolve(val('--out')!) : undefined, inPlace: args.includes('--in-place'), dryRun: args.includes('--dry-run'), options }
}

export function formatReport(report: GeocodeReport, outPath: string | null): string {
  const lines = [
    `Rows: ${report.rows} · geocoded now: ${report.geocoded} · kept existing: ${report.kept} · resolver calls: ${report.resolverCalls}`,
  ]
  for (const [m, n] of Object.entries(report.methods)) lines.push(`  ${m}: ${n}`)
  if (report.conflicts.length) {
    const diff = report.conflicts.filter(c => c.sameCounty === false)
    lines.push(`Conflicts checked: ${report.conflicts.length} · different county: ${diff.length}`)
    for (const c of diff) lines.push(`  row ${c.row} ${c.key}: ${c.geoId ?? '?'} vs alt ${c.altGeoId ?? '?'} — review`)
  }
  if (report.unmatched.length) {
    lines.push(`WARNING: ${report.unmatched.length} unmatched row(s):`)
    for (const u of report.unmatched) lines.push(`  row ${u.row} ${u.key}: ${u.reason}`)
  }
  lines.push(outPath ? `Wrote ${outPath}` : 'Dry run — nothing written.')
  return lines.join('\n')
}

export async function runGeocode(cli: GeocodeCliArgs, resolver: Resolver = liveResolver(), log: (s: string) => void = console.log): Promise<GeocodeReport> {
  const text = await fs.readFile(cli.input, 'utf8')
  const { rows } = parseCsv(text)
  const cachePath = `${cli.input}.geocode-cache.json`
  const cache = await loadCacheFile(cachePath)
  const fips = await loadFipsIndex().catch(() => null)
  const { rows: outRows, columns, report } = await geocodeRows(rows, cli.options, cachedResolver(resolver, cache), fips)
  await saveCacheFile(cachePath, cache)
  let outPath: string | null = null
  if (!cli.dryRun) {
    outPath = cli.inPlace ? cli.input : cli.out ?? cli.input.replace(/\.csv$/i, '') + '.geocoded.csv'
    await fs.writeFile(outPath, toCsv(outRows, columns))
  }
  log(formatReport(report, outPath))
  log(`Cache: ${cachePath} (${cache.size()} entries)`)
  return report
}
