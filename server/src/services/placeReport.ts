import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getFile, isBucketEnabled, isSafeKey, putFile } from './libraryBucket.js'
import { onReindex, searchCatalog, type CatalogEntryRow } from './libraryCatalog.js'
// P6-4: the small list of what has been run. One direction only — the index
// is handed the reader below, so it never has to know what a report contains.
import { rebuildPlaceReportIndex, recordPlaceReport } from './placeReportIndex.js'
import { parseLayerBlock } from './internalLayers.js'
import { topicFor } from './taxonomy.js'
import { readDataset } from './libraryTabular.js'
import { askKb, type PlaceExcerpt } from './askKb.js'
// Read-only: the public layer registry and the CSV/JSON reader the
// `county_values` MCP tool already uses (P5-45). One reader, one set of
// numbers — the report cannot disagree with the map about a county.
import { PUBLIC_LAYERS, countyValues, type PublicLayerRecord } from './mcpTools.js'
import {
  cleanRadius,
  fetchForPlace as realFetchForPlace,
  placeKeyFor,
  namePlace,
  resolvePlace,
  sourceBlockOf,
  pickAccess,
  type FetchForPlaceInput,
  type FetchForPlaceResult,
  type SlicePlace,
} from './placeFetch.js'
import { PlaceFetchError, failureText } from './placeHttp.js'
import { cannotAnswerPlace, fitsPlace } from './readiness.js'
import { distanceMiles } from './placeAdapters/shared.js'
import { workingSetMemberSlugs } from './libraryWorkingSets.js'
import type { SourceMeta } from './sourceMeta.js'

/**
 * The place report (P5-58).
 *
 * Nick's question — "what datasets will tell me all environmental risks
 * associated with x property I'm looking at?" — has never had one answer,
 * because the answer is forty separate lookups. This runs them all for one
 * place and writes the cited answer: every applicable source fetched (P5-57),
 * the county's public layer values (P5-45), the organizations nearby, and a
 * short written summary from Ask over exactly those findings.
 *
 * Three limits shape everything here, because the report reaches forty public
 * agencies at once and a researcher is watching a spinner while it does:
 *
 *  - **at most six sources in flight** (`REPORT_CONCURRENCY`) — each source is
 *    a different agency, so this is still one request per host; polite to
 *    the agencies, and the per-source limiter in placeHttp still applies,
 *  - **one overall deadline** (`PLACE_REPORT_TIMEOUT_MS`, 90 s) — when it
 *    fires, whatever is still running is reported as "could not check in
 *    time" rather than holding the whole report hostage to FEMA's slowest
 *    layer,
 *  - **at most `PLACE_REPORT_MAX_SOURCES` sources** (25) — past that a report
 *    stops being something a person reads.
 *
 * A finished report is cached whole at `library/derived/place/<placeKey>.json`
 * for a week: derived (so a reindex walks past it), keyed by the same place
 * key the slices use, and re-runnable with `refresh: true`.
 */

export const PLACE_REPORT_PREFIX = 'library/derived/place/'

/** How long a whole report stays worth showing. A week: long enough that
 *  coming back to a property tomorrow is free, short enough that a slice
 *  refreshed underneath it is not misreported for a month. */
export const REPORT_TTL_DAYS = 7

/** Rows kept per section. Ten names the sites without becoming the table —
 *  "Open the full slice" goes to all of them. */
export const REPORT_ROWS = 10

/** Rows of a section shown to the model when it writes the summary. */
export const SUMMARY_ROWS = 5

/** Columns of a row rendered into the summary context. */
const SUMMARY_COLUMNS = 8
const SUMMARY_CELL_CHARS = 60

/** Sources fetched at once. Three is polite to a public agency and still
 *  turns a 25-source report from minutes into well under one. */
export const REPORT_CONCURRENCY = 6

/** Organizations are a "who else is here" note, not a directory. */
export const ORGANIZATIONS_MAX = 10
export const ORGANIZATIONS_RADIUS_MILES = 50

/** Layer values shown for the county. All of them: the registry is fifteen
 *  layers, and "which ones matter" is the reader's judgement, not ours. */
export const COUNTY_LAYERS_MAX = 20

/** The whole report's clock. Sources still running when it fires are reported
 *  rather than waited for. */
export function reportTimeoutMs(): number {
  const raw = Number(process.env.PLACE_REPORT_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 90_000
}

export function reportMaxSources(): number {
  const raw = Number(process.env.PLACE_REPORT_MAX_SOURCES)
  // 50: the library holds 40 sources today and a cap below that silently
  // leaves some unchecked — the report must say "could not check in time"
  // rather than never look. Six at a time under the 90 s deadline covers it.
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50
}

// --- The shape ---------------------------------------------------------------

export type SectionStatus = 'found' | 'none' | 'skipped' | 'failed' | 'timeout'

export interface ReportSection {
  slug: string
  title: string
  provider: string
  status: SectionStatus
  count: number
  /** The first `REPORT_ROWS` rows; empty for anything but `found`. */
  rows: Record<string, string>[]
  columns: string[]
  /** The slice this came from, when one was fetched. */
  cacheKey?: string
  /** P5-63: the taxonomy topic this source is filed under, so the report
   *  groups its sections under a plain-word heading. Null when nothing on the
   *  entry names one. */
  topic: string | null
  href: string
  /** Why, for `skipped`, `failed` and `timeout`. In plain words. */
  reason?: string
}

/**
 * What the run reports about itself as it goes (P6-16).
 *
 * Every source is already its own task resolving to a complete section, so
 * none of this is new information — it is the information the run already had
 * and threw away. A caller that wants it passes `onProgress`; nothing else
 * changes, and no state is kept anywhere between requests.
 */
export type PlaceProgressEvent =
  | { type: 'start'; total: number }
  | { type: 'source'; slug: string; title: string }
  | { type: 'section'; slug: string; title: string; status: SectionStatus; done: number; total: number }
  | { type: 'summary' }

export interface ReportCountyLayer {
  id: string
  name: string
  value: number | string | null
  formatted: string
  direction: string
}

export interface ReportCounty {
  geoid: string
  name: string
  state: string
  layers: ReportCountyLayer[]
}

export interface ReportOrganization {
  name: string
  distanceMiles: number
  href: string
}

export interface ReportSummarySource {
  n: number
  title: string
  href: string
}

export interface ReportSummary {
  text: string
  sources: ReportSummarySource[]
}

export interface ReportPlace {
  label: string
  lat: number | null
  lng: number | null
  geoid: string | null
  /** County name for the geoid, when we know it. */
  county: string | null
  state: string | null
}

export interface PlaceReport {
  place: ReportPlace
  radiusMiles: number
  sections: ReportSection[]
  county: ReportCounty | null
  organizations: ReportOrganization[]
  summary: ReportSummary | null
  generatedAt: string
}

// --- Which sources apply -----------------------------------------------------

/**
 * Does this source answer a question about THIS place?
 *
 * The rule moved to `readiness.ts` in P5-82 so the readiness verdict on an
 * entry and the report itself cannot drift apart — one rule, read here and
 * shown there. Re-exported: every existing caller (and its tests) still asks
 * this module.
 */
export { fitsPlace }

export interface Candidate {
  entry: Pick<CatalogEntryRow, 'slug' | 'title' | 'meta' | 'category' | 'tags'>
  source: SourceMeta
  /** Null when an adapter can run it; a plain sentence when it cannot. */
  manualReason: string | null
}

/** Hand instructions for a source no adapter can run: what the researcher who
 *  indexed it wrote down, else the generic refusal. A reader who is told
 *  "check this one by hand" needs to know where. */
function handReason(source: SourceMeta, err: PlaceFetchError): string {
  return handReasonFor(source, failureText(err.code))
}

/** The by-hand sentence: the source's own note when it has one, else `why`,
 *  then the place to open. */
function handReasonFor(source: SourceMeta, why: string): string {
  const manual = (source.access ?? []).find(a => a.type === 'manual' || a.type === 'wfs')
  const notes = manual?.notes?.trim()
  const where = manual?.url || manual?.docs || source.homepage
  const parts = [notes || why]
  if (where) parts.push(where)
  return parts.join(' ')
}

/**
 * Every source entry that has something to say about this place, in title
 * order, capped. `only` is the caller's own shortlist (`sources: [slug]`).
 *
 * A source no adapter can run is KEPT — as a `skipped` section carrying the
 * hand instructions. "Nobody automated this one; here is where to look" is a
 * finding, and dropping it would quietly shrink the answer.
 */
export async function applicableSources(place: SlicePlace, only?: string[]): Promise<Candidate[]> {
  const wanted = only && only.length ? new Set(only) : null
  const rows = await searchCatalog({ kind: 'source' })
  const out: Candidate[] = []
  for (const entry of rows) {
    if (wanted && !wanted.has(entry.slug)) continue
    const source = sourceBlockOf(entry.meta)
    if (!source) continue
    if (!fitsPlace(source, place)) continue
    let manualReason: string | null = null
    try {
      const access = pickAccess(source)
      // The same static check the readiness verdict makes: a REST URL with no
      // place template or a download that is not a CSV/GeoJSON is listed by
      // hand up front, not after a fetch that would have refused it anyway.
      const why = cannotAnswerPlace(source, access)
      if (why) manualReason = handReasonFor(source, `${why} — open it by hand.`)
    } catch (err) {
      if (!(err instanceof PlaceFetchError)) throw err
      manualReason = handReason(source, err)
    }
    out.push({
      // P5-63: category and tags travel with the entry so the report can group
      // its sections by subject rather than listing forty sources flat.
      entry: { slug: entry.slug, title: entry.title, meta: entry.meta, category: entry.category, tags: entry.tags },
      source,
      manualReason,
    })
    if (out.length >= reportMaxSources()) break
  }
  return out
}

// --- Running them ------------------------------------------------------------

export function sliceHref(slug: string, cacheKey?: string): string {
  return cacheKey
    ? `/library/${encodeURIComponent(slug)}?place=${encodeURIComponent(cacheKey)}`
    : `/library/${encodeURIComponent(slug)}`
}

/** found → none → skipped → could-not-check. The reader wants what was found
 *  first and the housekeeping last; inside a rank, alphabetical. */
const STATUS_ORDER: Record<SectionStatus, number> = { found: 0, none: 1, skipped: 2, timeout: 3, failed: 4 }

export function sortSections(sections: ReportSection[]): ReportSection[] {
  return [...sections].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.title.localeCompare(b.title),
  )
}

type FetchForPlaceFn = (input: FetchForPlaceInput) => Promise<FetchForPlaceResult>

/**
 * Run up to `limit` tasks at a time, and stop handing out new ones once the
 * deadline has passed. Tasks already in flight are not cancelled (an HTTP
 * request the guard is already managing owns its own timeout) — they are
 * simply not waited for: `settled` says which finished in time.
 */
export async function runBounded<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  deadlineAt: number,
  now: () => number = Date.now,
): Promise<{ results: (T | undefined)[]; timedOut: boolean }> {
  const results: (T | undefined)[] = new Array(tasks.length).fill(undefined)
  let next = 0
  let timedOut = false

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= tasks.length) return
      if (now() >= deadlineAt) {
        // Whatever is left never starts. Marking it here (rather than
        // throwing) is what lets the report say "could not check in time"
        // per source instead of failing whole.
        timedOut = true
        return
      }
      results[i] = await tasks[i]()
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker)
  const raced = await Promise.race([
    Promise.all(workers).then(() => 'done' as const),
    sleepUntil(deadlineAt, now).then(() => 'deadline' as const),
  ])
  if (raced === 'deadline') timedOut = true
  return { results, timedOut }
}

function sleepUntil(at: number, now: () => number): Promise<void> {
  const ms = Math.max(0, at - now())
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    // A report must never hold the process open past its own answer.
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function sectionFor(candidate: Candidate, result: FetchForPlaceResult): ReportSection {
  return {
    slug: candidate.entry.slug,
    title: candidate.entry.title,
    provider: candidate.source.provider,
    topic: topicFor(candidate.entry.category, candidate.entry.tags),
    status: result.count > 0 ? 'found' : 'none',
    count: result.count,
    rows: result.count > 0 ? result.rows.slice(0, REPORT_ROWS) : [],
    columns: result.columns,
    cacheKey: result.cacheKey,
    href: sliceHref(candidate.entry.slug, result.cacheKey),
  }
}

function skippedSection(candidate: Candidate, status: SectionStatus, reason: string): ReportSection {
  return {
    slug: candidate.entry.slug,
    title: candidate.entry.title,
    provider: candidate.source.provider,
    topic: topicFor(candidate.entry.category, candidate.entry.tags),
    status,
    count: 0,
    rows: [],
    columns: [],
    href: sliceHref(candidate.entry.slug),
    reason,
  }
}

// --- The county's numbers ----------------------------------------------------

let countyIndex: Map<string, { name: string; state: string }> | null = null

/** County name + state for a FIPS code, from the map's own lookup file. Null
 *  when the file is not beside the server (a container built from `server/`
 *  alone) — the report then says the geoid and carries on. */
export async function countyInfo(geoid: string): Promise<{ name: string; state: string } | null> {
  if (!countyIndex) {
    try {
      const path = fileURLToPath(new URL('../../../public/datasets/geographic/county-lookup.json', import.meta.url))
      const rows = JSON.parse(await fs.readFile(path, 'utf8')) as { geoId: string; name: string; stateName: string }[]
      countyIndex = new Map(rows.map(r => [r.geoId, { name: r.name, state: r.stateName }]))
    } catch {
      countyIndex = new Map()
    }
  }
  return countyIndex.get(geoid) ?? null
}

/** Tests, and a data refresh. */
export function clearCountyIndex(): void {
  countyIndex = null
}

/**
 * One layer value as a person reads it. The map formats these in the client;
 * the report is written server-side (and goes into a note, a page and a CSV),
 * so the same few rules live here rather than a number with no unit.
 */
export function formatLayerValue(layer: PublicLayerRecord, value: number | string | null): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') return value
  switch (layer.dataType) {
    case 'currency':
      return `$${Math.round(value).toLocaleString('en-US')}`
    case 'percentage':
      return `${value.toFixed(1)}%`
    case 'years':
      return `${value.toFixed(1)} yrs`
    case 'index':
      return value.toFixed(2)
    default:
      return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
}

export type CountyValuesFn = (args: { layerId: string; geoids: string[] }) => Promise<Record<string, unknown>>

/**
 * Every public layer's value for one county. A layer whose file cannot be
 * read is dropped rather than failing the report: fourteen numbers and a
 * missing one is a better answer than an error page.
 */
export async function countyCard(geoid: string, read: CountyValuesFn = countyValues): Promise<ReportCounty> {
  const info = await countyInfo(geoid)
  const layers: ReportCountyLayer[] = []
  for (const layer of PUBLIC_LAYERS.slice(0, COUNTY_LAYERS_MAX)) {
    try {
      const answer = (await read({ layerId: layer.id, geoids: [geoid] })) as {
        counties?: { geoid: string; value: number | string | null }[]
      }
      const value = answer.counties?.[0]?.value ?? null
      if (value === null) continue
      layers.push({
        id: layer.id,
        name: layer.name,
        value,
        formatted: formatLayerValue(layer, value),
        direction: layer.direction,
      })
    } catch (err) {
      console.error(`[place-report] no county values for ${layer.id}:`, (err as Error)?.message || err)
    }
  }
  return { geoid, name: info?.name ?? `County ${geoid}`, state: info?.state ?? '', layers }
}

// --- Organizations nearby ----------------------------------------------------

export interface PointDataset {
  slug: string
  title: string
  file?: string
  latKey: string
  lngKey: string
  labelKey: string
}

/**
 * The dataset of places-with-coordinates this library holds — the
 * organizations list, in practice. Found by its LAYER BLOCK (a published
 * dataset drawn as points, so it has latitude, longitude and a label
 * column) rather than by slug, so renaming the entry does not silently empty
 * this card and a second point dataset could take over from it.
 */
export async function findPointDataset(): Promise<PointDataset | null> {
  const rows = await searchCatalog({ kind: 'dataset', status: 'published' })
  for (const entry of rows) {
    const meta = (entry.meta ?? {}) as Record<string, unknown>
    if (meta.layer === undefined) continue
    const parsed = parseLayerBlock(meta)
    if ('error' in parsed || parsed.block.geometry !== 'point') continue
    return {
      slug: entry.slug,
      title: entry.title,
      file: parsed.block.file,
      latKey: parsed.block.latKey,
      lngKey: parsed.block.lngKey,
      labelKey: parsed.block.labelKey,
    }
  }
  return null
}

function toNumber(cell: string | undefined): number | null {
  const t = (cell ?? '').trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** The record link the map and the table both use (P5-36). */
export function organizationHref(slug: string, label: string): string {
  return `/library/${encodeURIComponent(slug)}?tab=data&q=${encodeURIComponent(label)}`
}

/**
 * The nearest organizations to a point, closest first. Fifty miles is the
 * radius at which "who is already working here" is still a useful answer;
 * ten is as many as a card can show.
 */
export async function nearbyOrganizations(
  point: { lat: number; lng: number },
  dataset: PointDataset,
): Promise<ReportOrganization[]> {
  const { parsed } = await readDataset(dataset.slug, dataset.file)
  const near: ReportOrganization[] = []
  for (const row of parsed.rows) {
    const lat = toNumber(row[dataset.latKey])
    const lng = toNumber(row[dataset.lngKey])
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue
    const miles = distanceMiles(point, { lat, lng })
    if (miles > ORGANIZATIONS_RADIUS_MILES) continue
    const name = (row[dataset.labelKey] ?? '').trim()
    if (!name) continue
    near.push({ name, distanceMiles: Number(miles.toFixed(1)), href: organizationHref(dataset.slug, name) })
  }
  return near.sort((a, b) => a.distanceMiles - b.distanceMiles).slice(0, ORGANIZATIONS_MAX)
}

// --- The written summary -----------------------------------------------------

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The compare deep link for the county card: this county, the layers shown. */
export function compareHref(geoid: string, layerIds: string[]): string {
  const params = new URLSearchParams({ counties: geoid })
  if (layerIds.length) params.set('layers', layerIds.join(','))
  return `/compare?${params.toString()}`
}

/**
 * The report's own findings, as numbered excerpts for the model.
 *
 * Every section is here — including the empty ones — because "nothing within
 * five miles" is half the answer to "what are the risks", and a model that
 * only sees the hits will write as if the misses were never checked. Found
 * sections carry five rows so the prose can name a site instead of counting
 * one.
 */
export function summaryExcerpts(report: Omit<PlaceReport, 'summary'>): PlaceExcerpt[] {
  const out: PlaceExcerpt[] = []
  for (const section of report.sections) {
    const head = `${section.provider} — ${section.title}.`
    let body: string
    if (section.status === 'found') {
      const columns = section.columns.slice(0, SUMMARY_COLUMNS)
      const rows = section.rows
        .slice(0, SUMMARY_ROWS)
        .map(row => columns.map(c => `${c}: ${truncate(row[c] ?? '', SUMMARY_CELL_CHARS)}`).join(' | '))
        .join('\n')
      body = `${section.count} result${section.count === 1 ? '' : 's'} within ${report.radiusMiles} miles of ${report.place.label}.\n${rows}`
    } else if (section.status === 'none') {
      body = `Checked: nothing within ${report.radiusMiles} miles of ${report.place.label}.`
    } else if (section.status === 'skipped') {
      body = `Not checked automatically — ${section.reason ?? 'this source is published by hand.'}`
    } else {
      body = `Could not be checked — ${section.reason ?? 'the source did not answer.'}`
    }
    out.push({ slug: section.slug, title: section.title, href: section.href, text: `${head}\n${body}` })
  }

  if (report.county && report.county.layers.length) {
    const lines = report.county.layers.map(l => `${l.name}: ${l.formatted} (${l.direction.replace('_', ' ')})`).join('\n')
    out.push({
      slug: `county:${report.county.geoid}`,
      title: `${report.county.name}, ${report.county.state} — county numbers`,
      href: compareHref(report.county.geoid, report.county.layers.map(l => l.id)),
      text: `County-level values for ${report.county.name}, ${report.county.state}.\n${lines}`,
    })
  }

  if (report.organizations.length) {
    const lines = report.organizations.map(o => `${o.name} — ${o.distanceMiles} miles`).join('\n')
    out.push({
      slug: 'organizations',
      title: `Organizations near ${report.place.label}`,
      href: report.organizations[0].href,
      text: `Organizations within ${ORGANIZATIONS_RADIUS_MILES} miles.\n${lines}`,
    })
  }
  return out
}

export function summaryQuestion(label: string): string {
  return `What are the environmental and land risks for ${label}? Answer as a short report.`
}

export type AskFn = typeof askKb

/**
 * The written answer. Retrieval still runs (the library's own pages about
 * heirs property, a county's write-up) but the report's findings are numbered
 * FIRST, and the tool loop is off: everything the model could have fetched
 * has already been fetched, and a second round of the same calls would only
 * cost seconds and risk a different number in the prose than in the card.
 */
export async function writeSummary(
  report: Omit<PlaceReport, 'summary'>,
  ask: AskFn = askKb,
): Promise<ReportSummary | null> {
  const excerpts = summaryExcerpts(report)
  if (excerpts.length === 0) return null
  try {
    const answer = await ask({ question: summaryQuestion(report.place.label), placeContext: excerpts })
    return {
      text: answer.answer,
      sources: answer.sources.map(s => ({ n: s.n, title: s.title, href: s.href })),
    }
  } catch (err) {
    // A report without prose is still the whole set of findings; a report
    // that 500s because the model was busy is nothing.
    console.error('[place-report] summary failed:', (err as Error)?.message || err)
    return null
  }
}

// --- The derived cache -------------------------------------------------------

export function reportKey(placeKey: string): string {
  const key = `${PLACE_REPORT_PREFIX}${placeKey}.json`
  if (!isSafeKey(key)) throw new PlaceFetchError(`unsafe report key for "${placeKey}"`, 'bad-place')
  return key
}

export function isReportFresh(report: PlaceReport, now: number = Date.now()): boolean {
  const at = Date.parse(report.generatedAt)
  if (!Number.isFinite(at)) return false
  return now - at < REPORT_TTL_DAYS * 24 * 60 * 60 * 1000
}

export async function readPlaceReport(placeKey: string): Promise<PlaceReport | null> {
  if (!isBucketEnabled()) return null
  try {
    const raw = await getFile(reportKey(placeKey), { fresh: true })
    const doc = JSON.parse(raw.toString('utf8')) as PlaceReport
    return doc && Array.isArray(doc.sections) ? doc : null
  } catch {
    return null
  }
}

async function writePlaceReport(placeKey: string, report: PlaceReport): Promise<void> {
  if (!isBucketEnabled()) return
  try {
    await putFile(reportKey(placeKey), JSON.stringify(report), 'application/json')
  } catch (err) {
    // A report we could not keep is still the answer to this question.
    console.error(`[place-report] could not cache ${placeKey}:`, (err as Error)?.message || err)
  }
}

/**
 * P6-4: rebuild the index over the cached reports whenever the catalog is
 * rebuilt.
 *
 * A reindex is the moment the file tree is taken as the truth, which is
 * exactly when a report that has expired or been deleted should leave the
 * "recent analyses" list and one written by a path that never recorded an
 * entry should join it. Hooks are synchronous and best-effort, so this is
 * launched detached — a slow bucket walk must not hold up the reindex.
 */
onReindex(() => {
  void rebuildPlaceReportIndex(PLACE_REPORT_PREFIX, readPlaceReport).catch(err => {
    console.warn(`[place-report] could not rebuild the report index: ${(err as Error)?.message || err}`)
  })
})

// --- The report --------------------------------------------------------------

export interface PlaceReportDeps {
  fetchForPlace?: FetchForPlaceFn
  countyValues?: CountyValuesFn
  ask?: AskFn
  now?: () => number
}

/**
 * The seam a route suite fills in — the same arrangement `placeFetch`'s
 * `setPlaceFetchDefaults` uses. Only tests set it, and they set it so a route
 * test can drive the REAL service (real catalog, real bucket, real cache)
 * without an Anthropic key or fifteen CSV parses. Production leaves it empty.
 */
let defaults: PlaceReportDeps = {}

export function setPlaceReportDefaults(next: PlaceReportDeps): void {
  defaults = next
}

export function resetPlaceReportDefaults(): void {
  defaults = {}
}

/**
 * The report was asked for a scope it cannot honour (P7-1).
 *
 * Separate from `PlaceFetchError`, whose codes all describe a conversation
 * with an agency. "There is no working set called that" is a sentence about
 * the request, so it leaves as a 400 with its own words rather than being
 * dressed up as somebody else's 502.
 */
export class PlaceScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlaceScopeError'
  }
}

export interface PlaceReportInput {
  address?: unknown
  point?: { lat: unknown; lng: unknown } | null
  geoid?: unknown
  radiusMiles?: unknown
  /** Only these source slugs. Omit for every applicable source. */
  sources?: string[]
  /**
   * P7-1: run the report INSIDE a working set — ask that set's sources and no
   * others. 11 instead of 40.
   *
   * This is the whole point of the working set. `applicableSources` filters
   * candidates with `fitsPlace` and nothing else, which is a question about
   * *where* and never about *what was asked*; naming a set is how the caller
   * finally gets to say what was asked. The set's members are resolved here,
   * server-side, so the scope is a NAME rather than a list the caller assembled
   * — which is what makes a number from a scoped report citable.
   */
  workingSet?: string
  /** Re-run everything, cache and slices included. */
  refresh?: boolean
  actor?: { id: number | null; username: string }
  /**
   * Where to report progress (P6-16). Called synchronously as each source
   * goes out and comes back, in the order it happened. Production passes it —
   * it is a channel, not a test seam — and a cached report never calls it,
   * because there is no run to report on.
   */
  onProgress?: (event: PlaceProgressEvent) => void
  /** Test seams. Production passes none of these. */
  deps?: PlaceReportDeps
}

export interface PlaceReportResult {
  report: PlaceReport
  placeKey: string
  /** True when the whole thing came back from the derived cache. */
  cached: boolean
  ms: number
}

/**
 * Which sources this run may ask, or undefined for every applicable one.
 *
 * Two ways to narrow, and they are not the same thing. `sources` is a
 * caller's ad-hoc shortlist. `workingSet` names a curated object the library
 * owns, and the members are read HERE rather than trusted from the request —
 * that is what makes "this report asked the Memphis redevelopment set" a fact
 * the server can stand behind when a story quotes it.
 *
 * Both refusals are deliberate. A set that does not exist must not quietly
 * become "run all forty" — a typo in a slug would then cost forty agency
 * requests and answer a different question than the one asked. A set that
 * names nothing yet must not either: an empty report reads as "nothing found",
 * which is a false negative, where "this set names no datasets yet" is the
 * truth and points at the thing to go and fix.
 */
async function scopeFor(input: PlaceReportInput): Promise<string[] | undefined> {
  const asked = input.sources && input.sources.length ? input.sources : undefined
  const name = typeof input.workingSet === 'string' ? input.workingSet.trim() : ''
  if (!name) return asked
  const members = await workingSetMemberSlugs(name)
  if (!members) throw new PlaceScopeError(`There is no working set called “${name}”.`)
  if (members.length === 0) {
    throw new PlaceScopeError(`“${name}” names no datasets yet, so there is nothing in it to ask.`)
  }
  // Both given: the narrower of the two, never the union. A shortlist inside a
  // set is "these ones, of that set" — it cannot reach outside it.
  return asked ? members.filter(slug => asked.includes(slug)) : members
}

/**
 * Run the report.
 *
 * Order matters: the place is resolved ONCE (so an address is geocoded once,
 * not twenty-five times), the sources run in a bounded pool against a single
 * deadline, the county and organizations follow (both local reads), and only
 * then is the model asked to write the summary over what actually happened.
 */
export async function runPlaceReport(input: PlaceReportInput): Promise<PlaceReportResult> {
  const started = Date.now()
  const deps: PlaceReportDeps = { ...defaults, ...(input.deps ?? {}) }
  const now = deps.now ?? Date.now
  const fetchOne = deps.fetchForPlace ?? realFetchForPlace
  const radiusMiles = cleanRadius(input.radiusMiles)
  const place = await resolvePlace(
    { address: input.address, point: input.point, geoid: input.geoid, radiusMiles },
    radiusMiles,
  )
  const placeKey = placeKeyFor(place)
  const only = await scopeFor(input)

  // A cached report answers the same question for free — but only the WHOLE
  // question: a report filtered to three sources is a different document and
  // must never be served as, or saved over, the full one.
  if (!input.refresh && !only) {
    const cached = await readPlaceReport(placeKey)
    if (cached && isReportFresh(cached, now())) {
      return { report: cached, placeKey, cached: true, ms: Date.now() - started }
    }
  }

  // P6-15: name the place, once, and only now — after the cache answered, so a
  // reopened report costs no lookup, and outside the per-source path, so the
  // forty fetches below still geocode nothing. A point keeps its coordinates
  // when nothing can name it.
  const named = await namePlace(place)
  place.label = named.label

  const candidates = await applicableSources(place, only)
  const point = place.lat !== null && place.lng !== null ? { lat: place.lat, lng: place.lng } : null

  const runnable = candidates.filter(c => c.manualReason === null)
  const sections: ReportSection[] = candidates
    .filter(c => c.manualReason !== null)
    .map(c => skippedSection(c, 'skipped', c.manualReason as string))

  // P6-16: the run says what it is on. `done` is counted here rather than by
  // the reader, so the number a page shows is the number the run means, and it
  // only ever climbs — a pool of six settles out of order.
  const say = input.onProgress
  const total = candidates.length
  let done = 0
  /**
   * Reported once per source, whatever happens to it.
   *
   * `runBounded` does not cancel what is already in flight at the deadline —
   * it stops waiting for it — so a source reported as "could not check in
   * time" can still answer afterwards and ask to be counted a second time.
   * Deduplicating on the slug is what keeps `done` from climbing past `total`
   * and the tallies from counting one source twice.
   */
  const reported = new Set<string>()
  function settled(section: ReportSection): ReportSection {
    if (reported.has(section.slug)) return section
    reported.add(section.slug)
    done += 1
    say?.({ type: 'section', slug: section.slug, title: section.title, status: section.status, done, total })
    return section
  }
  say?.({ type: 'start', total })
  // The check-by-hand sources are already decided, so they are already done:
  // counting them later would make the first number a lie.
  for (const section of sections) settled(section)

  /** One source, start to finish. Its four endings are the report's four
   *  statuses, and every one of them is an answer rather than a gap. */
  async function runOne(candidate: Candidate): Promise<ReportSection> {
    try {
      const result = await fetchOne({
        slug: candidate.entry.slug,
        // The place is already resolved: pass the numbers, never the typed
        // address, so no source triggers a second geocode.
        point,
        geoid: place.geoid,
        radiusMiles,
        refresh: input.refresh === true,
        actor: input.actor,
      })
      return sectionFor(candidate, result)
    } catch (err) {
      // A source that turns out to have nothing we can query for this place
      // (a spreadsheet-only download, a template with no placeholder) is not
      // a failure — it is a "check by hand" like the manual ones, and should
      // read that way, with the researcher's own instructions and a link.
      if (err instanceof PlaceFetchError && (err.code === 'no-endpoint' || err.code === 'manual-only')) {
        return skippedSection(candidate, 'skipped', handReason(candidate.source, err))
      }
      if (err instanceof PlaceFetchError) return skippedSection(candidate, 'failed', failureText(err.code))
      console.error(`[place-report] ${candidate.entry.slug} failed:`, (err as Error)?.message || err)
      return skippedSection(candidate, 'failed', 'something went wrong reading this one.')
    }
  }

  const deadlineAt = now() + reportTimeoutMs()
  const tasks = runnable.map(candidate => async (): Promise<ReportSection> => {
    say?.({ type: 'source', slug: candidate.entry.slug, title: candidate.entry.title })
    return settled(await runOne(candidate))
  })

  const { results } = await runBounded(tasks, REPORT_CONCURRENCY, deadlineAt, now)
  results.forEach((section, i) => {
    // A source the deadline passed over never ran, so nothing has reported it.
    sections.push(section ?? settled(skippedSection(runnable[i], 'timeout', 'we ran out of time before this one was checked.')))
  })

  const countyGeoid = place.geoid
  const county = countyGeoid ? await countyCard(countyGeoid, deps.countyValues) : null
  const info = countyGeoid ? await countyInfo(countyGeoid) : null

  let organizations: ReportOrganization[] = []
  if (point) {
    try {
      const dataset = await findPointDataset()
      if (dataset) organizations = await nearbyOrganizations(point, dataset)
    } catch (err) {
      // No point dataset in this library, or its file will not parse: the
      // card simply does not appear.
      console.error('[place-report] organizations unavailable:', (err as Error)?.message || err)
    }
  }

  const withoutSummary: Omit<PlaceReport, 'summary'> = {
    place: {
      label: place.label,
      lat: place.lat,
      lng: place.lng,
      geoid: place.geoid,
      county: info?.name ?? null,
      state: info?.state ?? null,
    },
    radiusMiles,
    sections: sortSections(sections),
    county,
    organizations,
    generatedAt: new Date().toISOString(),
  }

  // The model reading forty sections takes seconds of its own. Without this
  // the count would sit at "40 of 40" with nothing moving — the exact
  // complaint this ticket exists for.
  say?.({ type: 'summary' })
  const summary = await writeSummary(withoutSummary, deps.ask)
  const report: PlaceReport = { ...withoutSummary, summary }

  // A filtered report is one reader's slice of the question and never becomes
  // the cached answer for the place.
  if (!only) {
    await writePlaceReport(placeKey, report)
    // P6-4: and the one line "recent analyses" reads, so that list never has
    // to open a report. Same rule as the cache above — a filtered report is
    // one reader's slice and is not an analysis of the place.
    await recordPlaceReport({
      placeKey,
      label: report.place.label,
      by: input.actor?.username ?? '',
      at: report.generatedAt,
      found: foundCount(report),
      sources: report.sections.length,
    })
  }

  return { report, placeKey, cached: false, ms: Date.now() - started }
}

/** How many sections actually found something — the audit's honest signal. */
export function foundCount(report: PlaceReport): number {
  return report.sections.filter(s => s.status === 'found').length
}
