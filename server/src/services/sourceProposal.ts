import type { SourceAccess, SourceAccessType, SourceFipsType, SourceGeography, SourceMeta, SourcePlaceQuery } from './sourceMeta.js'
import { SOURCE_ACCESS_MAX, SOURCE_FIELDS_MAX, SOURCE_TOPICS_MAX, SOURCE_GEOGRAPHIES } from './sourceMeta.js'
import type { AccessNote, KeptLink, ProseRead } from './linkPrune.js'
import { GEOID_COLUMN_RE, LAT_COLUMN_RE, LNG_COLUMN_RE } from './placeAdapters/shared.js'
import { extentLabel, type Inspection, type InspectField, type InspectGeometry, type InspectLink } from './linkInspect.js'
import { parseCoverage, type Coverage } from './coverage.js'
import type { Suggestion } from './suggestFiling.js'
import { normalizeSourceTopics, normalizeTags } from './taxonomy.js'

/**
 * Turn an inspection into a data-source block a person can press Save on
 * (P5-59).
 *
 * Pure — no network, no bucket — because the whole point is that this is a
 * PROPOSAL. It goes to the entry page, the form marks every value it filled
 * in with an "inferred" chip, and the ordinary filing route (P5-56) is what
 * actually writes anything. Nothing here is applied.
 *
 * The block is built to survive `parseSourceMeta` unchanged: only https URLs,
 * only column names a where-clause could safely carry, at most the field cap
 * the manifest parser enforces. A proposal the filing route would silently
 * trim is a proposal that lied to the person who approved it.
 */

export interface SourceProposal {
  /** Filing-form fields, from the P5-47 suggestion or the service's own name. */
  title?: string
  category?: string
  tags?: string[]
  description?: string
  /**
   * P6-32: the entry's own `coverage:`, as STRUCTURE rather than a sentence.
   *
   * `source.coverage` stays the human-readable string it has always been —
   * that is what a person reads on the form. This is the same claim in the
   * shape the catalog actually filters on, so accepting a proposal writes a
   * `{ scope, states }` object and nothing downstream has to parse prose back
   * into structure. Absent when the reading was not unambiguous, which is the
   * honest answer and leaves the entry on the no-coverage queue.
   */
  coverage?: Coverage
  /**
   * P7-7: the one line saying what this data ANSWERS (§F.4d).
   *
   * Carried the same way P6-32 carries structured coverage — a top-level field
   * beside the filing form's own, with `whatItAnswers` in `inferred` and its
   * sentence in `evidence`, because it is a model's reading of a page and the
   * person approving it has to be able to check the claim.
   *
   * Unlike coverage it is NOT in the `source` block: it is a claim about the
   * dataset as the library holds it, not a field of somebody's service
   * record, and `meta.whatItAnswers` is where every reader looks for it.
   */
  whatItAnswers?: string
  /** The block itself. */
  source: SourceMeta
  /** Dotted paths of everything the machine filled in, for the chips. */
  inferred: string[]
  /**
   * P5-61: for the fields read out of a page's PROSE, the sentence they were
   * read from, keyed by the same dotted path.
   *
   * A value a model inferred from words is a weaker claim than one a service
   * declared about itself, and the person approving it has to be able to check
   * it without reading the page. So the claim travels with its evidence.
   */
  evidence?: Record<string, string>
}

/** A name we would paste into `where=<name>='13089'` (sourceMeta's own rule). */
const PLAIN_COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,62}$/
/** Broader than the exact list: `county_geoid`, `cnty_fips`, `fips_code`. */
const FIPS_LIKE_RE = /fips|geoid/i

/** State-only keys. `where=STATEFP='13089'` matches nothing, forever. */
const STATE_ONLY_RE = /^(st|state)_?(fp|fips|fipscode|fips_code|geoid)$/i
/** Sub-county keys: a tract or block GEOID BEGINS with the county FIPS, so an
 *  equality filter on one never matches a 5-digit code. */
const SUBCOUNTY_RE = /tract|block|blkgrp|bg_?fips|zcta|^zip|_zip$|^ct_?(fips|geoid|id)$/i
/** `ct_fips` is the census-tract key the CDC tracking network publishes. */
const TRACT_KEY_RE = /^(ct|tract|census_?tract)_?(fips|geoid|id)$|tract/i
/** Block groups: a tract id plus one digit, and named for it. */
const BLOCKGROUP_KEY_RE = /block_?group|blkgrp|^bg_?(fips|geoid|id)$|_bg_?(fips|geoid)$/i
const PARCEL_RE = /parcel|^apn$|_apn$|^pin$|_pin$|taxlot/i

/** State + county together, in the many spellings agencies use:
 *  `stcntyfips`, `STCO_FIPSCODE`, `state_county_fips_code`. */
const STATE_COUNTY_RE = /^(st|state)_?(co|cnty|cty|county)_?(fips|geoid)/i
/** County alone. Sometimes 5-digit, sometimes the 3-digit within-state code —
 *  which is why it ranks below the unambiguous spellings above. */
const COUNTY_RE = /^(county|cnty|cty|co)_?(fips|geoid)|^(county|cnty)fp/i

function names(fields: InspectField[] | undefined): string[] {
  return (fields ?? []).map(f => f.name).filter(name => typeof name === 'string' && name.length > 0)
}

/** What one value of a FIPS column identifies. A county is filtered exactly;
 *  the two sub-county units are filtered by the county code they begin with. */
export type FipsUnit = 'county' | 'tract' | 'blockgroup'

export interface FipsColumn {
  field: string
  unit: FipsUnit
  /** How the column stores the code. A `number` column has dropped the leading
   *  zero of every state below 10, so it cannot be prefix-matched as text. */
  valueType: SourceFipsType
}

/** Column types that mean "this is stored as a number". */
const NUMERIC_TYPE_RE = /^(number|numeric|int|integer|long|double|float|decimal|real|money|smallint|bigint)$/i

/**
 * Text or number, from the declared type and, failing that, from the value.
 *
 * P5-59, found live: the CDC set declares `ct_fips` as `number` and samples it
 * as "36119002000.0" — a portal formatting a float. Either signal alone is
 * enough to know a `starts_with` would never match.
 */
function valueTypeOf(field: InspectField): SourceFipsType {
  if (NUMERIC_TYPE_RE.test((field.type ?? '').trim())) return 'number'
  return /^\s*-?\d+\.\d+\s*$/.test(field.sample ?? '') ? 'number' : 'text'
}

/**
 * Census GEOID lengths. Nothing else is a code we can filter with.
 *
 * 12 is a block group and 15 is a block; both are grouped under `blockgroup`
 * because the schema has no finer word and because the only thing that changes
 * with the difference is nothing we do — every one of them begins with its
 * county's five digits and is matched by that prefix.
 */
const UNIT_BY_LENGTH: Record<number, FipsUnit> = { 5: 'county', 11: 'tract', 12: 'blockgroup', 15: 'blockgroup' }

/**
 * The same lengths as a NUMBER, where the leading zero of every state below 10
 * is gone: Alabama's 01001 is stored as 1001. One digit short of a real length
 * is therefore a real code, and 11 is read as a tract (the full-length one)
 * rather than as a block group that lost a zero, because tracts are far more
 * common and the range filter for a tract is the narrower guess.
 */
const NUMERIC_UNIT_BY_LENGTH: Record<number, FipsUnit> = {
  4: 'county',
  5: 'county',
  10: 'tract',
  11: 'tract',
  12: 'blockgroup',
  14: 'blockgroup',
  15: 'blockgroup',
}

/**
 * What one sample value proves about a column: a unit, or 'unusable'.
 *
 * P5-59, found live twice over. First: the CDC well-water set names its
 * census-tract URI `geo_id` ("1400000US39017011131") and its real tract key
 * `ct_fips`. Both names read as FIPS; only the values tell them apart, and
 * choosing the URI produced a county fetch that returned 0 rows in silence.
 * Then: `ct_fips` is a NUMBER, sampled as "36119002000.0" — a trailing `.0` is
 * how a portal prints a float, not part of the code, and reading it as one
 * left the proposal with no place query at all.
 */
function unitFromSample(sample: string | undefined, valueType: SourceFipsType): FipsUnit | 'unusable' | null {
  if (sample === undefined) return null
  // A float's fraction is formatting: `.0`, `.00`. Anything else after the
  // point is a real fraction, and a real fraction is not an id.
  const value = sample.trim().replace(/\.0+$/, '')
  if (!/^\d+$/.test(value)) return 'unusable'
  const lengths = valueType === 'number' ? NUMERIC_UNIT_BY_LENGTH : UNIT_BY_LENGTH
  return lengths[value.length] ?? 'unusable'
}

/** Names that could be a FIPS-ish key at all. */
function isFipsName(name: string): boolean {
  if (STATE_ONLY_RE.test(name)) return false
  return (
    GEOID_COLUMN_RE.test(name.trim()) ||
    STATE_COUNTY_RE.test(name) ||
    COUNTY_RE.test(name) ||
    FIPS_LIKE_RE.test(name) ||
    BLOCKGROUP_KEY_RE.test(name) ||
    TRACT_KEY_RE.test(name)
  )
}

/**
 * The best FIPS-shaped column, and what it actually identifies.
 *
 * Ranked, not first-match, because real layers carry several at once: NC
 * OneMap parcels have `cntyfips` (3-digit, within state), `stfips` (state) and
 * `stcntyfips` (the 5-digit code we want) side by side, and picking the wrong
 * one produces a county fetch that silently returns nothing.
 *
 * Sample values, when the inspection carries them, outrank every name rule —
 * a name is a guess about the contents and a value is the contents.
 */
export function fipsColumnIn(fields: InspectField[] | undefined): FipsColumn | null {
  const usable = (fields ?? []).filter(f => typeof f.name === 'string' && PLAIN_COLUMN_RE.test(f.name))
  const verdict = new Map<string, FipsUnit | 'unusable'>()
  const valueTypes = new Map<string, SourceFipsType>()
  for (const field of usable) {
    const valueType = valueTypeOf(field)
    valueTypes.set(field.name, valueType)
    const unit = unitFromSample(field.sample, valueType)
    if (unit) verdict.set(field.name, unit)
  }
  const found = (field: string, unit: FipsUnit): FipsColumn => ({
    field,
    unit,
    valueType: valueTypes.get(field) ?? 'text',
  })

  const named = usable.map(f => f.name).filter(isFipsName)
  const tiers: ((name: string) => boolean)[] = [
    name => GEOID_COLUMN_RE.test(name.trim()),
    name => STATE_COUNTY_RE.test(name),
    name => COUNTY_RE.test(name),
    name => FIPS_LIKE_RE.test(name),
    () => true,
  ]

  // 1. Evidence. County first: it is the only unit an exact filter can use,
  //    so where both exist it is the more useful key.
  for (const unit of ['county', 'tract', 'blockgroup'] as const) {
    for (const matches of tiers) {
      const hit = named.find(name => verdict.get(name) === unit && matches(name))
      if (hit) return found(hit, unit)
    }
  }

  // 2. No sample: the name rules, with anything a sample ruled out left out.
  for (const matches of tiers.slice(0, -1)) {
    for (const name of named) {
      if (verdict.get(name) === 'unusable') continue
      if (SUBCOUNTY_RE.test(name)) continue
      if (matches(name)) return found(name, 'county')
    }
  }
  // Nothing county-level. A sub-county key is still the key: the adapters
  // match a county by the first five digits of one (P5-59).
  for (const name of named) {
    if (verdict.get(name) === 'unusable') continue
    if (BLOCKGROUP_KEY_RE.test(name)) return found(name, 'blockgroup')
  }
  for (const name of named) {
    if (verdict.get(name) === 'unusable') continue
    if (TRACT_KEY_RE.test(name) && FIPS_LIKE_RE.test(name)) return found(name, 'tract')
  }
  return null
}

/**
 * The column a "rows in this county" filter would use, or null.
 *
 * Null is the right answer far more often than a guess is: a wrong column
 * makes the fetch return nothing (or, worse, somebody else's county) and the
 * researcher has no way to tell that from "this place has none".
 */
export function countyFipsField(fields: InspectField[] | undefined): string | null {
  const hit = fipsColumnIn(fields)
  return hit && hit.unit === 'county' ? hit.field : null
}

/** The Socrata point/location column a `within_circle()` filter needs. */
export function locationField(fields: InspectField[] | undefined): string | null {
  for (const field of fields ?? []) {
    const type = (field.type ?? '').toLowerCase()
    if ((type === 'point' || type === 'location' || type === 'multipoint') && PLAIN_COLUMN_RE.test(field.name)) {
      return field.name
    }
  }
  return null
}

/** What one row IS: a point, a parcel, a tract, a county. Undefined when the
 *  metadata does not say — better than filing a flood polygon as a "point". */
export function rowGeography(
  fields: InspectField[] | undefined,
  geometry: InspectGeometry | undefined,
): SourceGeography | undefined {
  if (geometry === 'point') return 'point'
  const columns = names(fields)
  const fips = fipsColumnIn(fields)
  // A sub-county key means a row IS that shape even when a county column sits
  // beside it: the county is context, the tract is the row.
  if (fips && fips.unit !== 'county') return fips.unit
  if (columns.some(n => BLOCKGROUP_KEY_RE.test(n))) return 'blockgroup'
  if (columns.some(n => TRACT_KEY_RE.test(n) && FIPS_LIKE_RE.test(n))) return 'tract'
  if (columns.some(n => PARCEL_RE.test(n))) return 'parcel'
  if (fips) return fips.unit
  return undefined
}

function httpsOnly(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    return new URL(raw).protocol === 'https:' ? raw : undefined
  } catch {
    return undefined
  }
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./i, '')
  } catch {
    return raw
  }
}

/** The last path segment, for a file with no title of its own. */
function basenameOf(raw: string): string | undefined {
  try {
    const parts = new URL(raw).pathname.split('/').filter(Boolean)
    return parts[parts.length - 1] || undefined
  } catch {
    return undefined
  }
}

/** The access method this kind of endpoint is called with, or null when there
 *  is no single endpoint (a portal page, a service holding many layers). */
function accessFor(inspection: Inspection): SourceAccess | null {
  const endpoint = httpsOnly(inspection.finalUrl) ?? httpsOnly(inspection.url)
  if (!endpoint) return null
  switch (inspection.kind) {
    case 'arcgis-layer':
      return { type: 'arcgis', url: endpoint, auth: 'none', notes: 'inferred from the service' }
    case 'socrata':
      return { type: 'socrata', url: endpoint, format: 'json', auth: 'none', notes: 'inferred from the service' }
    case 'file':
      return {
        type: 'download',
        url: endpoint,
        ...(inspection.formats?.[0] ? { format: inspection.formats[0] } : {}),
        auth: 'none',
        notes: 'inferred from the link',
      }
    default:
      return null
  }
}

/** Ways this source can be asked about a place, from what the columns allow. */
function placeQueryFor(inspection: Inspection, access: SourceAccess | null): SourcePlaceQuery | undefined {
  if (!access) return undefined
  const by: string[] = []
  const out: SourcePlaceQuery = {}

  const fips = fipsColumnIn(inspection.fields)
  const geoField = access.type === 'socrata' ? locationField(inspection.fields) : null
  const columns = names(inspection.fields)
  const hasLatLng = columns.some(n => LAT_COLUMN_RE.test(n.trim())) && columns.some(n => LNG_COLUMN_RE.test(n.trim()))

  // "By point" means different things per adapter, and each needs its own
  // evidence: ArcGIS filters on the layer's own geometry, Socrata needs a
  // named location column, a downloaded file needs lat/lng columns.
  const pointable =
    (access.type === 'arcgis' && !!inspection.geometry && inspection.geometry !== 'table') ||
    (access.type === 'socrata' && !!geoField) ||
    (access.type === 'download' && hasLatLng)
  if (pointable) by.push('point')
  // Every FIPS unit can be asked about by county now: a county code is the
  // whole value for a county table and the first five digits of a tract or
  // block-group id, and the adapters build the clause each one needs.
  if (fips) by.push('county')

  if (by.length) out.by = by
  if (fips) {
    out.fipsField = fips.field
    // Said out loud rather than re-derived: the manifest is hand-editable, and
    // an adapter must never have to guess how to compare the column. Both keys
    // are written only when they are not the default, so an ordinary text
    // county column reads exactly as it always did.
    if (fips.unit !== 'county') out.fipsMatch = 'prefix'
    if (fips.valueType === 'number') out.fipsType = 'number'
  }
  if (geoField) out.geoField = geoField
  return Object.keys(out).length ? out : undefined
}

/** How a page's own words about getting at the data read in the notes. */
function accessNoteLabel(kind: AccessNote['kind']): string {
  switch (kind) {
    case 'api':
      return 'The page describes an API'
    case 'download':
      return 'The page describes a download'
    case 'viewer':
      return 'The page describes a viewer'
    default:
      return 'The page says to ask for it'
  }
}

/** Why there is no endpoint yet, in words that say what to do next. */
function accessNote(inspection: Inspection): string | undefined {
  switch (inspection.kind) {
    case 'portal':
      return inspection.platform === 'ckan'
        ? 'Read from the portal’s own catalogue record — its resources are listed below as access methods.'
        : 'This is a catalogue page — pick one of the downloads it lists and register that as the endpoint.'
    case 'arcgis-service':
      return 'This service holds several layers — pick a layer and register that as the endpoint.'
    case 'page':
      // P5-61: a page whose links were pruned to real data is a source, and
      // must stop being told it is not one.
      return inspection.links?.length
        ? 'Read off the page itself — check the links below against what the page actually says before saving.'
        : 'This is a web page, not a dataset. File it as a document unless it turns out to link to data.'
    case 'unreachable':
      return 'We could not reach this link, so nothing below was read from the source itself.'
    default:
      // A recognised dataset with no https endpoint: say which rule refused it.
      return httpsOnly(inspection.finalUrl) ?? httpsOnly(inspection.url)
        ? undefined
        : 'The link is not https, so it was not recorded as an endpoint — find an https address for it.'
  }
}

// --- What a page SAID (P5-61) ------------------------------------------------

/**
 * A kept link as an access method.
 *
 * P5-61: a page or a CKAN record has no single endpoint the way an ArcGIS
 * layer does — it has a list. Each kept link carries a role the prune (or the
 * portal's own format field) put on it, and the role plus the URL shape is
 * what decides which adapter would ever call it.
 */
export function accessTypeFor(link: Pick<InspectLink, 'kind' | 'role'>): SourceAccessType | null {
  // A file is a download however it is served: Socrata's own
  // `rows.csv?accessType=DOWNLOAD` lives on a Socrata host but is not the
  // Socrata query API, and sending the Socrata adapter at it would fail.
  if (link.role === 'data-file') return 'download'
  // A directory is where the files ARE, not a file: pointing the download
  // adapter at an HTML index would fetch the listing and call it data.
  if (link.role === 'directory') return 'manual'
  // P5-62: and a viewer is a form. Real access, and honestly not something an
  // adapter will ever drive — the same honest answer as a directory.
  if (link.role === 'viewer') return 'manual'
  if (link.kind === 'arcgis-layer' || link.kind === 'arcgis-service') return 'arcgis'
  if (link.kind === 'socrata') return 'socrata'
  switch (link.role) {
    case 'api':
    case 'service-layer':
      return 'rest'
    default:
      // docs and landing are not endpoints. A docs URL is attached to the
      // endpoint it documents instead (see `accessFromLinks`).
      return null
  }
}

/** The access type an access NOTE describes, once its URL is known to be one
 *  of the links we kept. A viewer or an "email us" is `manual`: real, and
 *  honestly not something an adapter will ever call. */
function accessTypeForNote(note: AccessNote, link: KeptLink | undefined): SourceAccessType {
  if (note.kind === 'viewer' || note.kind === 'request') return 'manual'
  const byLink = link ? accessTypeFor(link) : null
  if (byLink) return byLink
  return note.kind === 'download' ? 'download' : 'rest'
}

/**
 * Access methods from the links a page turned out to hold.
 *
 * Only endpoint-shaped roles become entries; the first docs link becomes the
 * `docs` of the first entry, because that is what `docs` is for and a
 * documentation page is not somewhere data comes from.
 */
function accessFromLinks(links: InspectLink[] | undefined): SourceAccess[] {
  const out: SourceAccess[] = []
  const docs = httpsOnly(links?.find(link => link.role === 'docs')?.url)
  for (const link of links ?? []) {
    if (out.length >= SOURCE_ACCESS_MAX) break
    const type = accessTypeFor(link)
    const url = httpsOnly(link.url)
    if (!type || !url || out.some(existing => existing.url === url)) continue
    out.push({ type, url, auth: 'none', notes: link.reason ?? 'inferred from the page' })
  }
  if (docs && out.length) out[0] = { ...out[0], docs }
  return out
}

/** The geography words a page uses, mapped onto the schema's fixed set. Free
 *  text that matches nothing goes to `notes` instead — the enum must never be
 *  filled in with a phrase nobody can filter on. */
export function geographyInWords(text: string | undefined): SourceGeography | null {
  if (!text) return null
  const lower = text.toLowerCase()
  if (/\bblock ?group|\bblockgroup/.test(lower)) return 'blockgroup'
  if (/\bcensus tract|\btract\b/.test(lower)) return 'tract'
  if (/\bparcel|\btax ?lot|\bproperty\b/.test(lower)) return 'parcel'
  if (/\bcounty|\bcounties\b/.test(lower)) return 'county'
  if (/\bstate(s|wide)?\b/.test(lower)) return 'state'
  if (/\bnational|\bnationwide|\bcountry-?wide/.test(lower)) return 'national'
  if (/\bpoint|\bsite\b|\bwell\b|\bfacilit|\baddress|\blocation/.test(lower)) return 'point'
  return SOURCE_GEOGRAPHIES.find(g => lower === g) ?? null
}

/**
 * The proposal.
 *
 * `suggestion` is the P5-47 filing proposal, which for a service is made from
 * the inspection text rather than from a document. It supplies the words a
 * person would use (title, category, tags, why it matters); the inspection
 * supplies the facts (endpoint, columns, geography, licence).
 */
export function proposeSource(inspection: Inspection, suggestion?: Suggestion | null): SourceProposal {
  const inferred: string[] = []
  const extraNotes: string[] = []
  const evidence: Record<string, string> = {}
  const mark = (path: string) => {
    if (!inferred.includes(path)) inferred.push(path)
  }
  /**
   * P5-61: mark a field AND record the sentence it was read from.
   *
   * Only for values that came out of a page's prose. A service that declares
   * its own licence needs no evidence — the endpoint IS the evidence — but a
   * model's reading of a paragraph does.
   */
  const prose: ProseRead | undefined = inspection.prose
  const fromProse = (path: string, proseKey: keyof ProseRead) => {
    mark(path)
    const sentence = prose?.evidence?.[proseKey as string]
    if (sentence) evidence[path] = sentence
  }

  const source: SourceMeta = { provider: '' }

  // Who publishes it. The service's own attribution first (it declared it),
  // then what the page says in words, then the host — which is a fact, not a
  // guess, and is what a person would type.
  source.provider = inspection.provider || prose?.provider || hostOf(inspection.url)
  if (!inspection.provider && prose?.provider) fromProse('provider', 'provider')
  else mark('provider')

  const program = inspection.title || prose?.program || basenameOf(inspection.finalUrl ?? inspection.url)
  if (program) {
    source.program = program
    if (!inspection.title && prose?.program) fromProse('program', 'program')
    else mark('program')
  }

  const homepage = httpsOnly(inspection.url)
  if (homepage) {
    source.homepage = homepage
    mark('homepage')
  }

  let structuredCoverage: Coverage | null = null

  const geography = rowGeography(inspection.fields, inspection.geometry) ?? geographyInWords(prose?.geography)
  if (geography) {
    source.geography = geography
    if (!rowGeography(inspection.fields, inspection.geometry) && prose?.geography) fromProse('geography', 'geography')
    else mark('geography')
  } else if (prose?.geography) {
    // Words that map onto no shape in the schema are still worth keeping — as
    // a note, where they cannot be filtered on by mistake.
    extraNotes.push(`What one row is, from the page: ${prose.geography}`)
  }

  const coverage = extentLabel(inspection.extent) ?? prose?.coverage
  if (coverage) {
    source.coverage = coverage
    if (!extentLabel(inspection.extent) && prose?.coverage) fromProse('coverage', 'coverage')
    else mark('coverage')
    // P6-32: and the same claim as structure, so accepting writes an object
    // the catalog can filter on rather than a sentence something has to read
    // back. `parseCoverage` declines anything it cannot read unambiguously, so
    // an unreadable proposal simply carries no structured coverage — the entry
    // stays on the no-coverage queue rather than gaining a guess.
    structuredCoverage = parseCoverage(coverage)
  }

  if (inspection.fields?.length) {
    source.fields = inspection.fields.slice(0, SOURCE_FIELDS_MAX).map(field => {
      const description = field.alias ?? field.type
      return description && description !== field.name ? { name: field.name, description } : { name: field.name }
    })
    mark('fields')
  }

  const access = accessFor(inspection)
  // P5-61: a page or a portal record has a LIST of endpoints rather than one.
  // The kept links become access methods; an access note the prose described
  // becomes one too when it points at a link we kept, and the rest of what the
  // page said about getting at the data goes into the notes.
  const fromLinks = access ? [] : accessFromLinks(inspection.links)
  const noteAccess: SourceAccess[] = []
  for (const note of prose?.accessNotes ?? []) {
    const link = note.url ? (inspection.links ?? []).find(l => l.url === note.url) : undefined
    const url = link ? httpsOnly(link.url) : undefined
    if (!url) {
      extraNotes.push(`${accessNoteLabel(note.kind)}: ${note.text}`)
      continue
    }
    const type = accessTypeForNote(note, link as KeptLink)
    const existing = [...fromLinks, ...noteAccess].find(a => a.url === url)
    // The prose's own words beat "inferred from the page" on a link we already
    // had: they say what the method IS, which is what a reader needs.
    if (existing) existing.notes = note.text
    else noteAccess.push({ type, url, auth: 'none', notes: note.text })
  }
  const allAccess = access ? [access] : [...fromLinks, ...noteAccess].slice(0, SOURCE_ACCESS_MAX)
  if (allAccess.length) {
    source.access = allAccess
    mark('access')
  }

  const placeQuery = placeQueryFor(inspection, access)
  if (placeQuery) {
    source.placeQuery = placeQuery
    if (placeQuery.by) mark('placeQuery.by')
    if (placeQuery.fipsField) mark('placeQuery.fipsField')
    if (placeQuery.fipsMatch) mark('placeQuery.fipsMatch')
    if (placeQuery.fipsType) mark('placeQuery.fipsType')
    if (placeQuery.geoField) mark('placeQuery.geoField')
  }
  const fips = fipsColumnIn(inspection.fields)
  if (fips && fips.unit !== 'county') {
    // Named so a person can see the join key, and explained so nobody reads
    // "by county" as "one row per county".
    const unit = fips.unit === 'tract' ? 'census tracts' : 'census block groups'
    extraNotes.push(
      `Rows are ${unit}, keyed by ${fips.field}. A county sits in the first five digits, so a fetch by county returns every ${fips.unit === 'tract' ? 'tract' : 'block group'} inside it.`,
    )
  }

  const cadence = inspection.cadence ?? prose?.updateCadence
  if (cadence) {
    source.updateCadence = cadence
    if (!inspection.cadence && prose?.updateCadence) fromProse('updateCadence', 'updateCadence')
    else mark('updateCadence')
  }
  const license = inspection.license ?? prose?.license
  if (license) {
    source.license = license
    if (!inspection.license && prose?.license) fromProse('license', 'license')
    else mark('license')
  }

  const note = accessNote(inspection)
  const allNotes = [note, ...extraNotes].filter((n): n is string => !!n)
  if (allNotes.length) {
    source.notes = allNotes.join(' ')
    mark('notes')
  }

  // P5-63: the words come from the one taxonomy wherever they can. The filing
  // pass's tags first, then the tags the page-reading pass chose (both already
  // normalised through the aliases), then the publisher's own keywords.
  const proseTags = prose?.tags?.length ? prose.tags : []
  if (suggestion?.tags?.length) {
    source.topics = suggestion.tags
    mark('topics')
  } else if (proseTags.length) {
    source.topics = proseTags
    fromProse('topics', 'tags')
  } else if (inspection.topics?.length) {
    // P5-61: a CKAN record ships the publisher's own keywords, which beat
    // nothing at all when the filing pass produced no tags.
    source.topics = normalizeSourceTopics(inspection.topics).slice(0, SOURCE_TOPICS_MAX)
    mark('topics')
  }
  if (suggestion?.summary) {
    source.relevance = suggestion.summary
    mark('relevance')
  }

  // P7-7: the capability line, if the page said anything that is one. Marked
  // through `fromProse` so it arrives with its sentence, exactly as every
  // other prose reading does — there is no deterministic half for this field,
  // so a page that says nothing simply proposes nothing and the entry stays on
  // the needs-a-look row.
  if (prose?.whatItAnswers) fromProse('whatItAnswers', 'whatItAnswers')

  const proposal: SourceProposal = {
    source,
    inferred,
    ...(structuredCoverage ? { coverage: structuredCoverage } : {}),
    ...(prose?.whatItAnswers ? { whatItAnswers: prose.whatItAnswers } : {}),
    ...(Object.keys(evidence).length ? { evidence } : {}),
  }

  const title = suggestion?.title || inspection.title
  if (title) {
    proposal.title = title
    mark('title')
  }
  // P5-63: the filing form's category is a taxonomy id whichever pass supplied
  // it — the document reader's answer, or the page reader's topic. Before this
  // ticket the two spoke different vocabularies, so a dropped link filed
  // itself under a word the library list had never heard of.
  if (suggestion?.category) {
    proposal.category = suggestion.category
    mark('category')
  } else if (prose?.topic) {
    proposal.category = prose.topic
    fromProse('category', 'topic')
  }
  if (suggestion?.tags?.length) {
    proposal.tags = suggestion.tags
    mark('tags')
  } else if (proseTags.length) {
    proposal.tags = normalizeTags(proseTags)
    fromProse('tags', 'tags')
  }
  // The service's own words describe what it IS; the model's summary says why
  // it matters and already lives in `relevance`. Preferring the service keeps
  // the two fields saying different things.
  const description = inspection.description || suggestion?.summary
  if (description) {
    proposal.description = description
    mark('description')
  }

  return proposal
}
