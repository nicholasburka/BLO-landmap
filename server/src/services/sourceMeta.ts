/**
 * Data-source manifests (P5-56).
 *
 * A `source` entry indexes a dataset we do NOT hold: EPA, FEMA, USDA, a state
 * agency. The manifest's `source` block is the whole entry — enough structure
 * to answer "what datasets tell me about environmental risks for this
 * property?" and, later (P5-57), to fetch a slice for a place.
 *
 * The block is hand-written (by a researcher, by the drop-a-link form, by the
 * push CLI), so it is never trusted. This module is the one place that turns a
 * raw block into a clean one: unknown keys, bad enum values, http URLs and
 * runaway arrays are dropped INDIVIDUALLY and reported, and the entry is still
 * indexed with whatever survived. A single typo in `geography` must not cost us
 * the whole source.
 *
 * Pure — no imports — so `scripts/validate-library.mjs` can load it directly
 * with Node's type stripping and check content before a push.
 */

/** Ticket: geography ∈ point | parcel | tract | county | state | national.
 *  `blockgroup` joined them in P5-59: a 15-digit GEOID is a real shape of row
 *  (the CDC tracking network publishes several), and calling one a tract would
 *  make the entry lie about what it holds. */
export const SOURCE_GEOGRAPHIES = ['point', 'parcel', 'blockgroup', 'tract', 'county', 'state', 'national'] as const
export type SourceGeography = (typeof SOURCE_GEOGRAPHIES)[number]

/**
 * P5-59: how a county code is compared with `placeQuery.fipsField`.
 *
 * `exact` is the old and default behaviour (`<field> = '13089'`). `prefix` is
 * for a table keyed BELOW the county — a tract or block-group GEOID begins
 * with its county's five digits, so "rows in Fulton County" is a starts-with,
 * and an equality filter there silently returns nothing.
 */
export const SOURCE_FIPS_MATCHES = ['exact', 'prefix'] as const
export type SourceFipsMatch = (typeof SOURCE_FIPS_MATCHES)[number]

/**
 * P5-59: whether the FIPS column holds the code as text or as a number.
 *
 * It changes the clause, not just the quoting: a numeric tract id has lost its
 * leading zero and cannot be matched with `starts_with` or `LIKE` at all, so a
 * number column is filtered with a range (`>= 13121000000 AND < 13122000000`)
 * instead. `text` is the default and what every block written before this
 * meant.
 */
export const SOURCE_FIPS_TYPES = ['text', 'number'] as const
export type SourceFipsType = (typeof SOURCE_FIPS_TYPES)[number]

/** Ticket: access[].type ∈ arcgis | socrata | rest | download | wfs | manual. */
export const SOURCE_ACCESS_TYPES = ['arcgis', 'socrata', 'rest', 'download', 'wfs', 'manual'] as const
export type SourceAccessType = (typeof SOURCE_ACCESS_TYPES)[number]

/** `indexed` = metadata only, `partial` = slices cached (P5-57), `replicated`
 *  = a dataset entry in this library holds it. */
export const SOURCE_REPLICATION_STATUSES = ['indexed', 'partial', 'replicated'] as const
export type SourceReplicationStatus = (typeof SOURCE_REPLICATION_STATUSES)[number]

// Caps exist so one bad manifest cannot blow up a catalog row (the block is
// stored inline in library_catalog.meta and shipped to every list response).
export const SOURCE_FIELDS_MAX = 40
export const SOURCE_ACCESS_MAX = 8
export const SOURCE_TOPICS_MAX = 20
/** granularity, placeQuery.by, replication.slices — short lists by nature. */
export const SOURCE_LIST_MAX = 8
/** Longest single string we keep (relevance is the long one in practice). */
export const SOURCE_STRING_MAX = 2000
/** P5-57: slices accumulate one per place asked about, so they get their own,
 *  larger cap than the "short lists by nature" above. */
export const SOURCE_SLICES_MAX = 50

/**
 * A column name we are willing to paste into a query we build
 * (`where=<fipsField>='13089'`, `$where=within_circle(<geoField>,…)`).
 * Letters, digits, underscore and dot only: a name carrying a quote, paren or
 * space could close our clause and write its own, and this manifest was
 * hand-typed by whoever indexed the source.
 */
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,62}$/

function cleanFieldName(value: unknown, label: string, dropped: string[]): string | undefined {
  const raw = cleanString(value)
  if (!raw) return undefined
  if (!FIELD_NAME_RE.test(raw)) {
    dropped.push(`${label} "${raw}" (not a plain column name)`)
    return undefined
  }
  return raw
}

export interface SourceField {
  name: string
  description?: string
}

export interface SourceAccess {
  type: SourceAccessType
  url?: string
  docs?: string
  /** Free text: 'none', 'api key', 'login'. The UI only asks "is it 'none'?". */
  auth?: string
  format?: string
  notes?: string
}

export interface SourcePlaceQuery {
  by?: string[]
  radiusMiles?: number
  /** P5-57: the column holding a 5-digit county FIPS, for a "by county" fetch
   *  (`where=STCOFIPS='13089'` on ArcGIS, `$where=fips='13089'` on Socrata). */
  fipsField?: string
  /** P5-59: `exact` (the default when absent) compares the whole value;
   *  `prefix` matches a sub-county GEOID by its first five digits. */
  fipsMatch?: SourceFipsMatch
  /** P5-59: `text` (the default when absent) or `number` — see
   *  SOURCE_FIPS_TYPES for why the difference is not just quoting. */
  fipsType?: SourceFipsType
  /** P5-57: the Socrata point/location column `within_circle()` filters on. */
  geoField?: string
  /** P5-57: a `rest` endpoint's URL template. Only the fixed placeholders
   *  {lat} {lng} {geoid} {radiusMiles} {bbox} are substituted, and only with
   *  numbers and 5-digit codes — never with anything a person typed. */
  template?: string
}

/**
 * How to compare a county code with this source's FIPS column.
 *
 * The default is `exact` — a block written before P5-59 carries no `fipsMatch`
 * and means what it always meant. Read it through this rather than off the
 * block, so every adapter defaults the same way.
 */
export function fipsMatchOf(placeQuery: SourcePlaceQuery | undefined): SourceFipsMatch {
  return placeQuery?.fipsMatch === 'prefix' ? 'prefix' : 'exact'
}

/** How the FIPS column stores its codes. `text` unless the block says number,
 *  for the same reason as `fipsMatchOf`: one default, in one place. */
export function fipsTypeOf(placeQuery: SourcePlaceQuery | undefined): SourceFipsType {
  return placeQuery?.fipsType === 'number' ? 'number' : 'text'
}

/**
 * P5-57: one cached slice of a source, recorded on the entry so the page can
 * list what we already hold for which places. A slice that has been promoted
 * to a real dataset carries that dataset's slug.
 *
 * `replication.slices` also still accepts a bare STRING — P5-56 wrote dataset
 * slugs there, and an old manifest must keep rendering.
 */
export interface SourceSlice {
  /** The place key: `g<geoid>` or `p<lat>_<lng>_r<miles>`. */
  cacheKey: string
  /** What a person would call the place ("Fulton County, GA", "33.7490,-84.3880"). */
  place?: string
  count?: number
  fetchedAt?: string
  adapter?: SourceAccessType
  /** Slug of the dataset this slice was promoted to, once it was. */
  dataset?: string
}

export interface SourceReplication {
  status: SourceReplicationStatus
  /** P5-57: cached slices, when status is `partial`. A bare string is a
   *  dataset slug (what P5-56 wrote); an object is a place slice. */
  slices?: (string | SourceSlice)[]
  /** Slug of the dataset entry holding it, when status is `replicated`. */
  dataset?: string
}

/**
 * P5-59: the last time a fetch for this source failed, so the admin queue can
 * say "this adapter has been failing" without re-running every source. Cleared
 * by the next success.
 */
export interface SourceFetchError {
  at: string
  /** The PlaceFetchFailure code, so the UI never matches on message text. */
  code: string
  /** The same sentence the reader would have seen under the Run button. */
  text: string
}

export interface SourceMeta {
  provider: string
  program?: string
  homepage?: string
  geography?: SourceGeography
  coverage?: string
  granularity?: string[]
  topics?: string[]
  fields?: SourceField[]
  access?: SourceAccess[]
  placeQuery?: SourcePlaceQuery
  license?: string
  updateCadence?: string
  lastChecked?: string
  relevance?: string
  /** Caveats for the researcher ("a missing feature means unmapped, not safe"). */
  notes?: string
  replication?: SourceReplication
  lastError?: SourceFetchError
}

export interface ParsedSourceMeta {
  /** The cleaned block, or null when there is nothing usable (no provider). */
  source: SourceMeta | null
  /** Plain-language notes on everything that was thrown away, for one warning. */
  dropped: string[]
}

const TOP_LEVEL_KEYS = [
  'provider',
  'program',
  'homepage',
  'geography',
  'coverage',
  'granularity',
  'topics',
  'fields',
  'access',
  'placeQuery',
  'license',
  'updateCadence',
  'lastChecked',
  'relevance',
  'notes',
  'replication',
  'lastError',
] as const

const ACCESS_KEYS = ['type', 'url', 'docs', 'auth', 'format', 'notes'] as const
const FIELD_KEYS = ['name', 'description'] as const
const PLACE_QUERY_KEYS = ['by', 'radiusMiles', 'fipsField', 'fipsMatch', 'fipsType', 'geoField', 'template'] as const
const REPLICATION_KEYS = ['status', 'slices', 'dataset'] as const
const LAST_ERROR_KEYS = ['at', 'code', 'text'] as const
const SLICE_KEYS = ['cacheKey', 'place', 'count', 'fetchedAt', 'adapter', 'dataset'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Trimmed, length-capped string — or undefined when there's nothing there. */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, SOURCE_STRING_MAX)
  return trimmed || undefined
}

/**
 * An https URL, or undefined. http is refused on purpose: these links are
 * followed by people and, later, by the P5-57 fetcher — a plaintext endpoint
 * is a wrong answer waiting to be trusted, and the drop is warned about so
 * whoever wrote the manifest can fix it.
 */
function cleanHttpsUrl(value: unknown): string | undefined {
  const raw = cleanString(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? raw : undefined
  } catch {
    return undefined
  }
}

/** Trimmed strings, deduplicated, capped. Reports the cap in `dropped`. */
function cleanStringList(value: unknown, max: number, label: string, dropped: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    dropped.push(`${label} (expected a list)`)
    return undefined
  }
  const out: string[] = []
  for (const item of value) {
    const s = cleanString(item)
    if (s && !out.includes(s)) out.push(s)
  }
  if (out.length > max) {
    dropped.push(`${label} (kept ${max} of ${out.length})`)
    out.length = max
  }
  return out.length ? out : undefined
}

function cleanEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  dropped: string[],
): T | undefined {
  const raw = cleanString(value)
  if (!raw) return undefined
  const hit = allowed.find(a => a === raw.toLowerCase())
  if (!hit) {
    dropped.push(`${label} "${raw}"`)
    return undefined
  }
  return hit
}

function reportUnknownKeys(obj: Record<string, unknown>, known: readonly string[], prefix: string, dropped: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) dropped.push(`unknown key "${prefix}${key}"`)
  }
}

function cleanFields(value: unknown, dropped: string[]): SourceField[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    dropped.push('fields (expected a list)')
    return undefined
  }
  const out: SourceField[] = []
  value.forEach((item, i) => {
    if (!isPlainObject(item)) {
      dropped.push(`fields[${i}] (expected an object)`)
      return
    }
    reportUnknownKeys(item, FIELD_KEYS, `fields[${i}].`, dropped)
    const name = cleanString(item.name)
    if (!name) {
      dropped.push(`fields[${i}] (no name)`)
      return
    }
    const description = cleanString(item.description)
    out.push(description ? { name, description } : { name })
  })
  if (out.length > SOURCE_FIELDS_MAX) {
    dropped.push(`fields (kept ${SOURCE_FIELDS_MAX} of ${out.length})`)
    out.length = SOURCE_FIELDS_MAX
  }
  return out.length ? out : undefined
}

function cleanAccess(value: unknown, dropped: string[]): SourceAccess[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    dropped.push('access (expected a list)')
    return undefined
  }
  const out: SourceAccess[] = []
  value.forEach((item, i) => {
    if (!isPlainObject(item)) {
      dropped.push(`access[${i}] (expected an object)`)
      return
    }
    reportUnknownKeys(item, ACCESS_KEYS, `access[${i}].`, dropped)
    // Without a known type there is no badge, no adapter and no honest way to
    // show the row — the whole method goes.
    const type = cleanEnum(item.type, SOURCE_ACCESS_TYPES, `access[${i}].type`, dropped)
    if (!type) {
      if (item.type === undefined) dropped.push(`access[${i}] (no type)`)
      return
    }
    const method: SourceAccess = { type }
    for (const [key, raw] of [
      ['url', item.url],
      ['docs', item.docs],
    ] as const) {
      if (raw === undefined || raw === null) continue
      const url = cleanHttpsUrl(raw)
      if (url) method[key] = url
      else dropped.push(`access[${i}].${key} (not https)`)
    }
    const auth = cleanString(item.auth)
    if (auth) method.auth = auth
    const format = cleanString(item.format)
    if (format) method.format = format
    const notes = cleanString(item.notes)
    if (notes) method.notes = notes
    out.push(method)
  })
  if (out.length > SOURCE_ACCESS_MAX) {
    dropped.push(`access (kept ${SOURCE_ACCESS_MAX} of ${out.length})`)
    out.length = SOURCE_ACCESS_MAX
  }
  return out.length ? out : undefined
}

function cleanPlaceQuery(value: unknown, dropped: string[]): SourcePlaceQuery | undefined {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) {
    dropped.push('placeQuery (expected an object)')
    return undefined
  }
  reportUnknownKeys(value, PLACE_QUERY_KEYS, 'placeQuery.', dropped)
  const out: SourcePlaceQuery = {}
  const by = cleanStringList(value.by, SOURCE_LIST_MAX, 'placeQuery.by', dropped)
  if (by) out.by = by
  if (value.radiusMiles !== undefined && value.radiusMiles !== null) {
    const n = Number(value.radiusMiles)
    if (Number.isFinite(n) && n > 0) out.radiusMiles = n
    else dropped.push('placeQuery.radiusMiles (expected a positive number)')
  }
  const fipsField = cleanFieldName(value.fipsField, 'placeQuery.fipsField', dropped)
  if (fipsField) out.fipsField = fipsField
  const fipsMatch = cleanEnum(value.fipsMatch, SOURCE_FIPS_MATCHES, 'placeQuery.fipsMatch', dropped)
  if (fipsMatch) out.fipsMatch = fipsMatch
  const fipsType = cleanEnum(value.fipsType, SOURCE_FIPS_TYPES, 'placeQuery.fipsType', dropped)
  if (fipsType) out.fipsType = fipsType
  const geoField = cleanFieldName(value.geoField, 'placeQuery.geoField', dropped)
  if (geoField) out.geoField = geoField
  if (value.template !== undefined && value.template !== null) {
    const template = cleanHttpsUrl(value.template)
    if (template) out.template = template
    else dropped.push('placeQuery.template (not https)')
  }
  return Object.keys(out).length ? out : undefined
}

/** P5-57 slices. A string stays a string (a dataset slug, P5-56); an object
 *  needs a cacheKey to be worth anything, and every other key is optional. */
function cleanSlices(value: unknown, dropped: string[]): (string | SourceSlice)[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    dropped.push('replication.slices (expected a list)')
    return undefined
  }
  const out: (string | SourceSlice)[] = []
  const seen = new Set<string>()
  value.forEach((item, i) => {
    if (typeof item === 'string') {
      const s = cleanString(item)
      if (s && !seen.has(s)) {
        seen.add(s)
        out.push(s)
      }
      return
    }
    if (!isPlainObject(item)) {
      dropped.push(`replication.slices[${i}] (expected a slice or a slug)`)
      return
    }
    reportUnknownKeys(item, SLICE_KEYS, `replication.slices[${i}].`, dropped)
    const cacheKey = cleanString(item.cacheKey)
    if (!cacheKey) {
      dropped.push(`replication.slices[${i}] (no cacheKey)`)
      return
    }
    if (seen.has(cacheKey)) return
    seen.add(cacheKey)
    const slice: SourceSlice = { cacheKey }
    const place = cleanString(item.place)
    if (place) slice.place = place
    const count = Number(item.count)
    if (Number.isFinite(count) && count >= 0) slice.count = Math.floor(count)
    const fetchedAt = cleanString(item.fetchedAt)
    if (fetchedAt) slice.fetchedAt = fetchedAt
    const adapter = cleanEnum(item.adapter, SOURCE_ACCESS_TYPES, `replication.slices[${i}].adapter`, dropped)
    if (adapter) slice.adapter = adapter
    const dataset = cleanString(item.dataset)
    if (dataset) slice.dataset = dataset
    out.push(slice)
  })
  if (out.length > SOURCE_SLICES_MAX) {
    dropped.push(`replication.slices (kept ${SOURCE_SLICES_MAX} of ${out.length})`)
    out.length = SOURCE_SLICES_MAX
  }
  return out.length ? out : undefined
}

function cleanReplication(value: unknown, dropped: string[]): SourceReplication | undefined {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) {
    dropped.push('replication (expected an object)')
    return undefined
  }
  reportUnknownKeys(value, REPLICATION_KEYS, 'replication.', dropped)
  const status = cleanEnum(value.status, SOURCE_REPLICATION_STATUSES, 'replication.status', dropped)
  // A replication block with no usable status says nothing the default
  // ("indexed — not copied here") doesn't already say.
  if (!status) return undefined
  const out: SourceReplication = { status }
  const slices = cleanSlices(value.slices, dropped)
  if (slices) out.slices = slices
  const dataset = cleanString(value.dataset)
  if (dataset) out.dataset = dataset
  return out
}

/** P5-59: the last failed fetch. Needs a time and a code to be worth keeping —
 *  a marker with neither says nothing the absence of one does not. */
function cleanLastError(value: unknown, dropped: string[]): SourceFetchError | undefined {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) {
    dropped.push('lastError (expected an object)')
    return undefined
  }
  reportUnknownKeys(value, LAST_ERROR_KEYS, 'lastError.', dropped)
  const at = cleanString(value.at)
  const code = cleanString(value.code)
  if (!at || !code) return undefined
  return { at, code, text: cleanString(value.text) ?? '' }
}

/**
 * Clean a raw `source` block. Never throws.
 *
 * - `undefined`/`null` in → `{ source: null, dropped: [] }` (nothing to say).
 * - anything but an object, or no `provider` → `{ source: null, dropped: [why] }`.
 * - otherwise the cleaned block plus one line per thing thrown away.
 *
 * Callers log `dropped` as ONE warning per entry and index the entry anyway.
 */
export function parseSourceMeta(raw: unknown): ParsedSourceMeta {
  if (raw === undefined || raw === null) return { source: null, dropped: [] }
  if (!isPlainObject(raw)) return { source: null, dropped: ['source (expected an object)'] }

  const dropped: string[] = []
  reportUnknownKeys(raw, TOP_LEVEL_KEYS, '', dropped)

  const provider = cleanString(raw.provider)
  if (!provider) {
    // Without "who publishes this" the entry cannot answer the question it
    // exists for, so the block goes rather than half-render.
    return { source: null, dropped: [...dropped, 'source (provider is required)'] }
  }

  const source: SourceMeta = { provider }

  const program = cleanString(raw.program)
  if (program) source.program = program

  if (raw.homepage !== undefined && raw.homepage !== null) {
    const homepage = cleanHttpsUrl(raw.homepage)
    if (homepage) source.homepage = homepage
    else dropped.push('homepage (not https)')
  }

  const geography = cleanEnum(raw.geography, SOURCE_GEOGRAPHIES, 'geography', dropped)
  if (geography) source.geography = geography

  const coverage = cleanString(raw.coverage)
  if (coverage) source.coverage = coverage

  const granularity = cleanStringList(raw.granularity, SOURCE_LIST_MAX, 'granularity', dropped)
  if (granularity) source.granularity = granularity

  const topics = cleanStringList(raw.topics, SOURCE_TOPICS_MAX, 'topics', dropped)
  if (topics) source.topics = topics

  const fields = cleanFields(raw.fields, dropped)
  if (fields) source.fields = fields

  const access = cleanAccess(raw.access, dropped)
  if (access) source.access = access

  const placeQuery = cleanPlaceQuery(raw.placeQuery, dropped)
  if (placeQuery) source.placeQuery = placeQuery

  for (const key of ['license', 'updateCadence', 'lastChecked', 'relevance', 'notes'] as const) {
    const value = cleanString(raw[key])
    if (value) source[key] = value
  }

  const replication = cleanReplication(raw.replication, dropped)
  if (replication) source.replication = replication

  const lastError = cleanLastError(raw.lastError, dropped)
  if (lastError) source.lastError = lastError

  return { source, dropped }
}

/** The one warning line an entry gets when parsing threw things away. */
export function sourceDropWarning(slug: string, dropped: string[]): string {
  return `[library] source block for "${slug}": dropped ${dropped.join(', ')} — the entry is indexed without them; fix the manifest and reindex.`
}
