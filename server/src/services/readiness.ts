import { isAdapterType } from './placeAdapters/shared.js'
import { isExtractable, basenameInEntry } from './textExtract.js'
import { pickTabularFile } from './libraryTabular.js'
import type { SourceAccess, SourceMeta } from './sourceMeta.js'

/**
 * What an entry is READY AS (P5-82).
 *
 * "Is it ready for ingestion, will it be useful" used to be answered by
 * reading a manifest. This is that answer as data: what the thing is ready to
 * be used as, whether a place report can run on it, and the short reasons
 * behind both.
 *
 * Pure and computed at READ time — never stored. A verdict is a view over the
 * row (its files, its manifest, the last inspection), so it can never go stale
 * against the row it describes, and a reindex is not needed to fix one.
 *
 * The module sits at the bottom of the stack on purpose: `fitsPlace` lives
 * here and `placeReport` re-exports it, so the rule that decides whether a
 * source can answer a place question is written once.
 */

export const READINESS_KINDS = ['dataset', 'source', 'collection', 'document', 'page', 'link'] as const
export type ReadinessKind = (typeof READINESS_KINDS)[number]

export const PLACE_REPORT_READINESS = ['runs', 'by-hand', 'never', 'candidate'] as const
export type PlaceReportReadiness = (typeof PLACE_REPORT_READINESS)[number]

export interface Readiness {
  as: ReadinessKind
  placeReport: PlaceReportReadiness
  /** Short plain reasons, in reading order. Never a directive. */
  notes: string[]
}

/**
 * What a verdict is computed from: a catalog row, or a row made up on the
 * spot for a link that has only been inspected (MCP `inspect_link`).
 */
export interface ReadinessRow {
  kind: string
  meta?: Record<string, unknown>
  files?: { key: string; size: number }[]
}

// --- The manifest bits it reads ------------------------------------------------

/**
 * The part of `meta.inspection` (linkInspect.ts) a verdict reads. Structural
 * on purpose: the inspector owns that type, and a verdict must not fail to
 * compile because a field it never looks at moved.
 */
interface InspectionView {
  kind?: string
  /** P5-79: what the page's own HTML said, including whether it is http. */
  page?: { insecure?: boolean }
  /** P5-80: documents linked from the page that can be pulled in. */
  documents?: unknown[]
}

function inspectionOf(meta: Record<string, unknown> | undefined): InspectionView | null {
  const raw = meta?.inspection
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as InspectionView
}

/** The cleaned source block, or null. Same test as placeFetch's
 *  `sourceBlockOf`: a block without a provider is not a source. */
function sourceOf(meta: Record<string, unknown> | undefined): SourceMeta | null {
  const raw = meta?.source
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as SourceMeta
  return typeof source.provider === 'string' && source.provider ? source : null
}

/** Inspection kinds that ARE an endpoint — something a source could be
 *  registered on and a place report could then run. */
const ENDPOINT_KINDS = new Set(['arcgis-layer', 'arcgis-service', 'socrata', 'file'])
/** Inspection kinds that are a page somebody read, not an endpoint. */
const PAGE_KINDS = new Set(['page', 'portal'])

// --- Can a source answer a place question? -------------------------------------

/**
 * Does this source answer a question about THIS place?
 *
 * A point can be asked of anything — every adapter can filter by a radius or
 * fall back to the county the point sits in. A bare county cannot: a source
 * that only publishes by parcel or by point has no row for "Fulton County",
 * and asking would return either everything or nothing, both of which are
 * lies. So a county-only place needs a source that says it answers by county
 * — or, when the manifest never said, one that at least names the column
 * holding a county FIPS.
 *
 * Lives here rather than in placeReport (which re-exports it) so the readiness
 * verdict and the report itself cannot drift apart. The `place` argument is
 * structural for the same reason: SlicePlace satisfies it without dragging the
 * fetcher into this module.
 */
export function fitsPlace(source: SourceMeta, place: { lat: number | null; lng: number | null }): boolean {
  if (place.lat !== null && place.lng !== null) return true
  const by = (source.placeQuery?.by ?? []).map(s => s.trim().toLowerCase())
  if (by.length === 0) return !!source.placeQuery?.fipsField
  return by.includes('county')
}

/** The strict place: a county with no point. An address resolves to a point,
 *  which `fitsPlace` says every source answers, so the county is the only
 *  place question a source can fail. */
const A_COUNTY = { lat: null, lng: null }

/**
 * The first access method an adapter can actually run — the same pick
 * `placeFetch.pickAccess` makes, minus the throwing.
 */
export function runnableAccess(source: SourceMeta): SourceAccess | undefined {
  return (source.access ?? []).find(a => isAdapterType(a.type) && (a.url || a.type === 'rest'))
}

/** Every access method this source has is one we read by hand (`manual`) or do
 *  not speak (`wfs`) — there IS an endpoint of sorts, it just is not ours. */
export function isByHandOnly(source: SourceMeta): boolean {
  const access = source.access ?? []
  return access.length > 0 && access.every(a => a.type === 'manual' || a.type === 'wfs')
}

/**
 * Whether a place report can run this source.
 *
 * An endpoint an adapter can run IS a report that runs: the report resolves an
 * address to a point, and `fitsPlace` answers yes for a point whatever the
 * manifest says. Whether it also answers a BARE COUNTY is the strict question
 * — asked below, and answered with a note rather than a different verdict,
 * because the source really does run for the question people ask most.
 *
 * `never` is "no endpoint at all", which includes a block with no access list
 * and one whose methods all lack a URL. (placeFetch calls the empty case
 * `manual-only` because that reads better under a dead Run button; here the
 * reader is asking what the entry IS, and "nothing to query" is the answer.)
 */
function sourcePlaceReport(source: SourceMeta): PlaceReportReadiness {
  const access = runnableAccess(source)
  if (access) return cannotAnswerPlace(source, access) ? 'by-hand' : 'runs'
  return isByHandOnly(source) ? 'by-hand' : 'never'
}

/** File names a download adapter can slice by place; anything else — a zip,
 *  a GeoTIFF, an HTML page that offers the file — is read by hand. */
const SLICEABLE_FORMAT = /geojson|json|csv/i

/**
 * Why an endpoint an adapter can call still cannot answer "what is near this
 * address" — the same two checks the adapters make before touching the
 * network, asked here so the verdict, the report's "check by hand" sections
 * and the progress count all agree without a fetch:
 *  - a `rest` URL is the same for every place unless its template carries a
 *    `{lat}`/`{lng}`, `{geoid}` or `{bbox}` placeholder (see `fetchRest`);
 *  - a `download` is sliced from a CSV or GeoJSON file — a zip, a raster or a
 *    landing page cannot be (see `extensionFor`).
 * Returns the reason, or null when the source can run.
 */
export function cannotAnswerPlace(source: SourceMeta, access: SourceAccess = runnableAccess(source) as SourceAccess): string | null {
  if (!access) return 'no endpoint to query'
  if (access.type === 'rest') {
    const template = source.placeQuery?.template ?? access.url ?? ''
    return /\{(lat|lng|geoid|radiusMiles|bbox)\}/.test(template) ? null : 'its REST endpoint has no place template'
  }
  if (access.type === 'download') {
    const declared = (access.format ?? '').toLowerCase()
    const path = (access.url ?? '').toLowerCase().split('?')[0]
    const sliceable = SLICEABLE_FORMAT.test(declared) || /\.(geojson|json|csv)$/.test(path)
    return sliceable ? null : 'a download we cannot slice by place'
  }
  return null
}

// --- The verdict ---------------------------------------------------------------

/** Names of the files that are the entry's CONTENT — the manifest is filing,
 *  not content, and is never counted or read. */
function contentFileNames(row: ReadinessRow): string[] {
  return (row.files ?? []).map(f => basenameInEntry(f.key)).filter(name => name !== 'meta.json')
}

/** Kinds that hold files of their own. A saved view's snapshot and a wiki
 *  page's markdown are the entry, not files it holds, so neither is weighed
 *  as a document or mistaken for a table. */
const HOLDS_FILES = new Set(['dataset', 'document', 'incoming'])

/** Kinds whose content is the entry itself (a note's body lives in its
 *  manifest, a page IS its markdown, a view IS its snapshot) — we hold the
 *  words, so there is nothing left to fetch. */
const SELF_CONTAINED_KINDS = new Set(['note', 'wiki', 'view', 'working-set'])

export function readinessOf(row: ReadinessRow): Readiness {
  const inspection = inspectionOf(row.meta)
  const source = sourceOf(row.meta)
  const files = contentFileNames(row)
  const readable = files.filter(isExtractable)
  const notes: string[] = []

  const as = verdictKind(row, { source, inspection, files, readable })
  const placeReport = source
    ? sourcePlaceReport(source)
    : ENDPOINT_KINDS.has(inspection?.kind ?? '')
      ? 'candidate'
      : 'never'

  if (as === 'link') notes.push(inspection?.kind === 'unreachable' ? 'could not be reached' : 'not read yet')
  if (files.length) notes.push(`text extracted from ${readable.length} of ${files.length} ${files.length === 1 ? 'file' : 'files'}`)
  const documents = inspection?.documents?.length ?? 0
  if (documents) notes.push(`${documents} ${documents === 1 ? 'document' : 'documents'} on the page can be pulled in`)
  if (inspection?.page?.insecure) notes.push('served over http')
  if (source && placeReport === 'never') notes.push('no endpoint to query')
  if (source && placeReport === 'by-hand') {
    const why = runnableAccess(source) ? cannotAnswerPlace(source) : null
    if (why) notes.push(why)
  }
  // The verdict says a report RUNS because an address becomes a point and any
  // adapter can filter by radius. When the manifest never said how to ask for
  // a whole county, that narrower truth is worth a line of its own — it is why
  // the source is missing from a county report.
  if (source && placeReport === 'runs' && !fitsPlace(source, A_COUNTY)) notes.push('answers a point, not a whole county')

  return { as, placeReport, notes }
}

function verdictKind(
  row: ReadinessRow,
  read: { source: SourceMeta | null; inspection: InspectionView | null; files: string[]; readable: string[] },
): ReadinessKind {
  // A pointer to data held elsewhere is what it says it is, whatever else it
  // carries (a sample file, a data dictionary).
  if (read.source || row.kind === 'source') return 'source'
  if (HOLDS_FILES.has(row.kind)) {
    // A table we hold, browsable in the explorer — the same pick the explorer
    // makes, so the verdict cannot promise a table it would refuse to open.
    if (pickTabularFile(row.files ?? []).chosen) return 'dataset'
    if (read.readable.length >= 3) return 'collection'
    // A file we hold whose text we cannot read (a spreadsheet, a slide deck)
    // is still a document — the extraction note says what is missing.
    if (read.files.length >= 1) return 'document'
  }
  if (SELF_CONTAINED_KINDS.has(row.kind)) return 'document'
  if (PAGE_KINDS.has(read.inspection?.kind ?? '')) return 'page'
  return 'link'
}
