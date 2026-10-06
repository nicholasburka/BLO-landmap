import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'
import { getFile, isBucketEnabled, isSafeKey, listFiles, putFile } from './libraryBucket.js'
import { getCatalogEntry, indexFileBackedEntry, indexIncomingEntry, SOURCES_PREFIX } from './libraryCatalog.js'
import { isLibraryEnabled, libraryQuery, writeAudit } from './libraryDb.js'
import { queueSuggestion } from './linkFetchQueue.js'
import { geocodeAddress, reverseGeocode, validGeoid, validPoint } from './geocodePlace.js'
import { PlaceFetchError, type PlaceFetchFailure, failureText, type GuardedGetOptions } from './placeHttp.js'
import { isByHandOnly, runnableAccess } from './readiness.js'
import { SOURCE_SLICES_MAX, type SourceAccess, type SourceAccessType, type SourceMeta, type SourceSlice } from './sourceMeta.js'
import { fetchArcgis } from './placeAdapters/arcgis.js'
import { fetchSocrata } from './placeAdapters/socrata.js'
import { fetchDownload } from './placeAdapters/download.js'
import { fetchRest } from './placeAdapters/rest.js'
import {
  bboxAround,
  ttlDaysFor,
  type AdapterContext,
  type PlaceRows,
  type PlaceTarget,
  type SliceGeometry,
} from './placeAdapters/shared.js'

/**
 * Lazy replication (P5-57).
 *
 * P5-56 indexed forty datasets we do not hold. The next question is always
 * about a place — "any Superfund sites near this address?" — so instead of
 * copying a national dataset we fetch exactly the slice the question needs,
 * keep it, and let a slice that keeps mattering be promoted to a real dataset.
 * The library grows as fast as the questions do, and no faster.
 *
 * Storage:
 *   library/derived/sources/<slug>/<placeKey>.json   one cached slice
 *   library/derived/sources/<slug>/full.<ext>        the `download` adapter's copy
 *
 * Derived, so a reindex walks past them and they never look like content
 * somebody pushed. The source entry's own manifest records what we hold:
 * `replication.status` becomes `partial` and `replication.slices` lists the
 * places, so the entry page can say so without reading the bucket.
 */

export const SLICE_PREFIX = 'library/derived/sources/'
export const RADIUS_MILES_DEFAULT = 5
export const RADIUS_MILES_MAX = 100

/**
 * The network seam a route suite fills in. Only tests set it — a route test can
 * then drive the REAL service (real bucket writes, real catalog rows, the real
 * cache) with a faked agency, which is the same arrangement P5-47's queue uses.
 * Production leaves it empty and every request goes to the real internet.
 */
let defaults: GuardedGetOptions = {}

export function setPlaceFetchDefaults(next: GuardedGetOptions): void {
  defaults = next
}

export function resetPlaceFetchDefaults(): void {
  defaults = {}
}

const ADAPTERS: Record<string, (ctx: AdapterContext) => Promise<PlaceRows>> = {
  arcgis: fetchArcgis,
  socrata: fetchSocrata,
  download: fetchDownload,
  rest: fetchRest,
}

// --- Places ------------------------------------------------------------------

export interface SlicePlace {
  label: string
  lat: number | null
  lng: number | null
  geoid: string | null
  radiusMiles: number
  /** How we got here: what the person typed, when they typed an address. */
  address?: string
}

/**
 * The cache key for a place.
 *
 * A county is its FIPS (`g13121`) — every question about that county is the
 * same slice. A point is rounded to four decimals (about 11 m, finer than any
 * geocoder is honest about) plus the radius, so "the same address again" hits
 * the cache and a genuinely different parcel does not.
 */
export function placeKeyFor(place: SlicePlace): string {
  if (place.geoid && place.lat === null) return `g${place.geoid}`
  if (place.lat === null || place.lng === null) return `g${place.geoid ?? 'unknown'}`
  const miles = String(Number(place.radiusMiles.toFixed(2)))
  return `p${place.lat.toFixed(4)}_${place.lng.toFixed(4)}_r${miles}`
}

export function sliceKey(slug: string, placeKey: string): string {
  const key = `${SLICE_PREFIX}${slug}/${placeKey}.json`
  if (!isSafeKey(key)) throw new PlaceFetchError(`unsafe slice key for "${slug}"`, 'bad-place')
  return key
}

let countyNames: Map<string, string> | null = null

/** "Fulton County, GA" for a FIPS code, so slices read like places rather than
 *  numbers. The lookup is the map's own county file; if it is not beside the
 *  server (a deployment without the repo's public tree) the code stands in. */
async function countyLabel(geoid: string): Promise<string> {
  if (!countyNames) {
    try {
      const path = fileURLToPath(new URL('../../../public/datasets/geographic/county-lookup.json', import.meta.url))
      const entries = JSON.parse(await fs.readFile(path, 'utf8')) as { geoId: string; name: string; stateAbbr: string }[]
      countyNames = new Map(entries.map(e => [e.geoId, `${e.name}, ${e.stateAbbr}`]))
    } catch {
      countyNames = new Map()
    }
  }
  return countyNames.get(geoid) ?? `County ${geoid}`
}

/** The coordinates as a label — the fallback whenever a point has no name. */
export function coordinateLabel(lat: number, lng: number): string {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
}

/**
 * Give a point-derived place its name (P6-15).
 *
 * Deliberately NOT part of `resolvePlace`. A point used to BE its label, so a
 * report run from the map was headed "40.7785, -73.9572" and — because the
 * saved note takes its title from the label — so was the library row it left
 * behind. But `resolvePlace` is called once per source, and `runPlaceReport`
 * passes the resolved numbers down precisely so that no source geocodes
 * again; naming there would have put a lookup in front of all forty, and in
 * front of every cache hit. The name is presentation, the numbers are
 * identity (`placeKeyFor` reads only the numbers), so this is called once,
 * after the cache check, by the one caller that renders a heading.
 *
 * An address already carries the geocoder's words and a county already
 * resolves a name, so both are returned untouched. A lookup that fails or
 * knows nothing leaves the coordinates rather than inventing a name.
 */
export async function namePlace(place: SlicePlace, http: GuardedGetOptions = defaults): Promise<SlicePlace> {
  if (place.address || place.lat === null || place.lng === null) return place
  const named = await reverseGeocode(place.lat, place.lng, http).catch(() => null)
  return named ? { ...place, label: named } : place
}

export interface PlaceInput {
  point?: { lat: unknown; lng: unknown } | null
  geoid?: unknown
  address?: unknown
  radiusMiles?: unknown
}

export function cleanRadius(raw: unknown, fallback?: number): number {
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return Math.min(n, RADIUS_MILES_MAX)
  const fromSource = Number(fallback)
  return Number.isFinite(fromSource) && fromSource > 0 ? Math.min(fromSource, RADIUS_MILES_MAX) : RADIUS_MILES_DEFAULT
}

/**
 * One place, from whichever of the three ways it was given.
 *
 * An address is geocoded here and nowhere else — by the time a place reaches
 * an adapter it is numbers and a five-digit code, which is what lets the URL
 * templates substitute without ever carrying free text.
 */
export async function resolvePlace(input: PlaceInput, radiusMiles: number, http?: GuardedGetOptions): Promise<SlicePlace> {
  const geoid = validGeoid(input.geoid)
  const point = input.point ? validPoint(input.point.lat, input.point.lng) : null
  const address = typeof input.address === 'string' ? input.address.trim() : ''

  if (point) {
    const county = geoid ?? null
    // The label here is the coordinates, deliberately: `resolvePlace` runs
    // once per SOURCE, and a report fans out across forty of them. Naming the
    // place is `namePlace`, called once per report — see P6-15 below.
    return {
      label: coordinateLabel(point.lat, point.lng),
      lat: point.lat,
      lng: point.lng,
      geoid: county,
      radiusMiles,
    }
  }
  if (address) {
    const found = await geocodeAddress(address, http)
    if (!found) throw new PlaceFetchError(`could not find "${address}"`, 'bad-place')
    return {
      label: found.matched || address,
      lat: found.lat,
      lng: found.lng,
      geoid: found.geoid,
      radiusMiles,
      address,
    }
  }
  if (geoid) {
    return { label: await countyLabel(geoid), lat: null, lng: null, geoid, radiusMiles }
  }
  throw new PlaceFetchError('give an address, a point, or a county', 'bad-place')
}

function targetFor(place: SlicePlace): PlaceTarget {
  const point = place.lat !== null && place.lng !== null ? { lat: place.lat, lng: place.lng } : null
  return {
    point,
    geoid: place.geoid,
    radiusMiles: place.radiusMiles,
    bbox: point ? bboxAround(point, place.radiusMiles) : null,
    label: place.label,
    key: placeKeyFor(place),
  }
}

// --- The source and its adapter ----------------------------------------------

export function sourceBlockOf(meta: Record<string, unknown> | undefined): SourceMeta | null {
  const raw = meta?.source
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as SourceMeta
  return typeof source.provider === 'string' && source.provider ? source : null
}

/** The first access method we have an adapter for. `manual`/`wfs` sources fall
 *  through to a refusal the reader can act on rather than a dead button.
 *  The pick itself is `readiness.runnableAccess` — the readiness verdict on
 *  the entry page and this button must agree about what can be run. */
export function pickAccess(source: SourceMeta): SourceAccess {
  const usable = runnableAccess(source)
  if (usable) return usable
  if (!source.access?.length || isByHandOnly(source)) {
    throw new PlaceFetchError(`"${source.provider}" publishes this by hand only`, 'manual-only')
  }
  throw new PlaceFetchError(`no access method for this source can be fetched automatically`, 'no-endpoint')
}

// --- Slices ------------------------------------------------------------------

export interface SliceDoc {
  slug: string
  cacheKey: string
  place: SlicePlace
  adapter: SourceAccessType
  fetchedAt: string
  /** How long this stays good, from the source's update cadence. */
  ttlDays: number
  columns: string[]
  rows: Record<string, string>[]
  count: number
  truncated: boolean
  geometry?: SliceGeometry
}

export function isFresh(doc: SliceDoc, now: number = Date.now()): boolean {
  const at = Date.parse(doc.fetchedAt)
  if (!Number.isFinite(at)) return false
  return now - at < doc.ttlDays * 24 * 60 * 60 * 1000
}

export async function readSlice(slug: string, placeKey: string): Promise<SliceDoc | null> {
  if (!isBucketEnabled()) return null
  try {
    const raw = await getFile(sliceKey(slug, placeKey), { fresh: true })
    const doc = JSON.parse(raw.toString('utf8')) as SliceDoc
    return doc && Array.isArray(doc.rows) ? doc : null
  } catch {
    return null
  }
}

export async function listSlices(slug: string): Promise<SliceDoc[]> {
  if (!isBucketEnabled()) return []
  const files = await listFiles(`${SLICE_PREFIX}${slug}/`)
  const docs: SliceDoc[] = []
  for (const file of files) {
    if (!file.key.endsWith('.json')) continue
    const placeKey = file.key.slice(`${SLICE_PREFIX}${slug}/`.length, -'.json'.length)
    // `full.*` is the download adapter's copy of the whole file, not a place.
    if (placeKey.startsWith('full')) continue
    const doc = await readSlice(slug, placeKey)
    // The list is for choosing a place, so it carries no rows.
    if (doc) docs.push({ ...doc, rows: [], geometry: undefined })
  }
  return docs.sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1))
}

// --- Recording what we hold --------------------------------------------------

function sliceRow(doc: SliceDoc, dataset?: string): SourceSlice {
  return {
    cacheKey: doc.cacheKey,
    place: doc.place.label,
    count: doc.count,
    fetchedAt: doc.fetchedAt,
    adapter: doc.adapter,
    ...(dataset ? { dataset } : {}),
  }
}

/**
 * Note that a fetch for this source failed, on the source's own manifest.
 *
 * Bucket-first and row-replaced like every other manifest write here. Cleared
 * by the next success (see `recordSlice`), so the queue shows what is broken
 * NOW rather than a history of every bad afternoon.
 */
export async function recordFetchFailure(slug: string, err: PlaceFetchError): Promise<void> {
  if (!isSourceFault(err.code)) return
  await patchSourceManifest(slug, source => ({
    ...source,
    lastError: { at: new Date().toISOString(), code: err.code, text: failureText(err.code) },
  }))
}

/**
 * Which failures are the SOURCE's fault. A source with no endpoint, or one the
 * team has marked hand-only, is not broken — it is what it is, and a place
 * report says so in its own "check by hand" section. A bad place is the
 * caller's. Recording those as "last fetch failed" put 15 of 40 sources in the
 * admin queue after one report, with nothing an admin could fix.
 */
const NOT_A_SOURCE_FAULT: ReadonlySet<PlaceFetchFailure> = new Set(['no-endpoint', 'manual-only', 'bad-place'])

export function isSourceFault(code: PlaceFetchFailure): boolean {
  return !NOT_A_SOURCE_FAULT.has(code)
}

/** Apply a change to an entry's `source` block, bucket first then the row. */
async function patchSourceManifest(
  slug: string,
  change: (source: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  if (!isLibraryEnabled() || !isBucketEnabled()) return
  const entry = await getCatalogEntry(slug)
  if (!entry) return
  const metaKey = `${SOURCES_PREFIX}${slug}/meta.json`
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse((await getFile(metaKey, { fresh: true })).toString('utf8')) as Record<string, unknown>
  } catch {
    return
  }
  const source = (meta.source && typeof meta.source === 'object' ? meta.source : {}) as Record<string, unknown>
  meta.source = change(source)
  const metaJson = JSON.stringify(meta, null, 2)
  await putFile(metaKey, metaJson, 'application/json')
  const files = entry.files.filter(f => f.key !== metaKey).concat([{ key: metaKey, size: Buffer.byteLength(metaJson) }])
  await libraryQuery(`DELETE FROM library_catalog WHERE slug = $1`, [slug])
  await indexFileBackedEntry(entry.kind, slug, meta, files)
}

/**
 * Record a slice on the source entry: bucket first, then the catalog row
 * replaced — the same order (and the same delete + insert) filing uses, so a
 * reindex and this path can never disagree about what the manifest says.
 */
export async function recordSlice(slug: string, doc: SliceDoc, dataset?: string): Promise<void> {
  if (!isLibraryEnabled() || !isBucketEnabled()) return
  const entry = await getCatalogEntry(slug)
  if (!entry) return
  const metaKey = `${SOURCES_PREFIX}${slug}/meta.json`
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse((await getFile(metaKey, { fresh: true })).toString('utf8')) as Record<string, unknown>
  } catch {
    // No manifest to update means nothing to record; the slice itself is
    // already in the bucket and the fetch stands.
    return
  }
  const source = (meta.source && typeof meta.source === 'object' ? meta.source : {}) as Record<string, unknown>
  const replication = (source.replication && typeof source.replication === 'object' ? source.replication : {}) as Record<string, unknown>
  const existing = Array.isArray(replication.slices) ? (replication.slices as (string | SourceSlice)[]) : []
  const row = sliceRow(doc, dataset)
  const kept = existing.filter(s => typeof s === 'string' || s.cacheKey !== doc.cacheKey)
  const previous = existing.find(s => typeof s !== 'string' && s.cacheKey === doc.cacheKey) as SourceSlice | undefined
  // Promotion adds a dataset to a slice; a re-fetch must not take it away.
  if (previous?.dataset && !row.dataset) row.dataset = previous.dataset

  // A fetch that worked means the adapter is not broken any more.
  delete source.lastError
  meta.source = {
    ...source,
    replication: {
      ...replication,
      // A source with slices is partly copied — unless the whole thing is
      // already here, which is a stronger claim and stays.
      status: replication.status === 'replicated' ? 'replicated' : 'partial',
      // Newest first, and capped where the manifest parser caps it — otherwise
      // a much-asked-about source would grow its catalog row without limit and
      // then have the tail silently trimmed at the next reindex.
      slices: [row, ...kept].slice(0, SOURCE_SLICES_MAX),
    },
  }

  const metaJson = JSON.stringify(meta, null, 2)
  await putFile(metaKey, metaJson, 'application/json')
  const files = entry.files
    .filter(f => f.key !== metaKey)
    .concat([{ key: metaKey, size: Buffer.byteLength(metaJson) }])
  await libraryQuery(`DELETE FROM library_catalog WHERE slug = $1`, [slug])
  await indexFileBackedEntry(entry.kind, slug, meta, files)
}

// --- The fetch ---------------------------------------------------------------

export interface FetchForPlaceInput extends PlaceInput {
  slug: string
  /** Skip the cache and ask the agency again. */
  refresh?: boolean
  /** Test seams; production passes nothing. */
  http?: GuardedGetOptions
  actor?: { id: number | null; username: string }
}

export interface FetchForPlaceResult {
  slug: string
  rows: Record<string, string>[]
  columns: string[]
  count: number
  truncated: boolean
  fetchedAt: string
  cacheKey: string
  cached: boolean
  adapter: SourceAccessType
  place: SlicePlace
  geometry?: SliceGeometry
}

/**
 * Fetch (or read back) one place's worth of a source.
 *
 * Order: find the source, work out the place, look in the cache, and only then
 * call the agency. Every outbound request inside this goes through the host
 * guard with a timeout, a byte cap and a per-source rate limit.
 */
export async function fetchForPlace(input: FetchForPlaceInput): Promise<FetchForPlaceResult> {
  const started = Date.now()
  const entry = await getCatalogEntry(input.slug)
  if (!entry) throw new PlaceFetchError(`no entry "${input.slug}"`, 'no-endpoint')
  const source = sourceBlockOf(entry.meta)
  if (!source) throw new PlaceFetchError(`"${entry.title}" is not a data source`, 'no-endpoint')

  const access = pickAccess(source)
  const radiusMiles = cleanRadius(input.radiusMiles, source.placeQuery?.radiusMiles)
  const http = input.http ?? defaults
  const place = await resolvePlace(input, radiusMiles, http)
  const cacheKey = placeKeyFor(place)

  if (!input.refresh) {
    const cached = await readSlice(input.slug, cacheKey)
    if (cached && isFresh(cached)) {
      return {
        slug: input.slug,
        rows: cached.rows,
        columns: cached.columns,
        count: cached.count,
        truncated: cached.truncated,
        fetchedAt: cached.fetchedAt,
        cacheKey,
        cached: true,
        adapter: cached.adapter,
        place: cached.place,
        geometry: cached.geometry,
      }
    }
  }

  const adapter = ADAPTERS[access.type]
  if (!adapter) throw new PlaceFetchError(`no adapter for ${access.type}`, 'no-endpoint')
  let result: PlaceRows
  try {
    result = await adapter({
      slug: input.slug,
      access,
      placeQuery: source.placeQuery,
      // P5-59: how wide a numeric sub-county range has to be depends on what
      // one row is, so the adapter is told.
      geography: source.geography,
      place: targetFor(place),
      updateCadence: source.updateCadence,
      http,
    })
  } catch (err) {
    // P5-59: remember that this source's adapter failed, so the admin queue
    // can list "sources that have been failing" without re-running all forty.
    // Best effort, and never allowed to replace the real error.
    if (err instanceof PlaceFetchError) await recordFetchFailure(input.slug, err).catch(() => {})
    throw err
  }

  const doc: SliceDoc = {
    slug: input.slug,
    cacheKey,
    place,
    adapter: access.type,
    fetchedAt: new Date().toISOString(),
    ttlDays: ttlDaysFor(source.updateCadence),
    columns: result.columns,
    rows: result.rows,
    count: result.count,
    truncated: result.truncated,
    ...(result.geometry ? { geometry: result.geometry } : {}),
  }

  if (isBucketEnabled()) {
    await putFile(sliceKey(input.slug, cacheKey), JSON.stringify(doc), 'application/json').catch(err => {
      // A slice we could not keep is still an answer to this question.
      console.error(`[place] could not cache slice ${input.slug}/${cacheKey}:`, err?.message || err)
    })
    await recordSlice(input.slug, doc).catch(err => {
      console.error(`[place] could not record slice on ${input.slug}:`, err?.message || err)
    })
  }

  void writeAudit({
    userId: input.actor?.id ?? null,
    actor: input.actor?.username ?? 'unknown',
    action: 'source.fetch',
    target: input.slug,
    detail: { slug: input.slug, placeKey: cacheKey, count: doc.count, adapter: doc.adapter, ms: Date.now() - started },
  })

  return {
    slug: input.slug,
    rows: doc.rows,
    columns: doc.columns,
    count: doc.count,
    truncated: doc.truncated,
    fetchedAt: doc.fetchedAt,
    cacheKey,
    cached: false,
    adapter: doc.adapter,
    place: doc.place,
    geometry: doc.geometry,
  }
}

// --- Promotion ---------------------------------------------------------------

export interface PromoteInput {
  slug: string
  cacheKey: string
  title?: string
  actor?: { id: number | null; username: string }
  clientIp?: string
}

/** A filename that survives a bucket key and a download folder. */
export function sliceFilename(slug: string, cacheKey: string): string {
  return `${slug}-${cacheKey}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) + '.csv'
}

export function sliceCsv(doc: SliceDoc): string {
  return (
    Papa.unparse(
      { fields: doc.columns, data: doc.rows.map(row => doc.columns.map(c => row[c] ?? '')) },
      { newline: '\n' },
    ) + '\n'
  )
}

/**
 * Turn a cached slice into a real incoming dataset entry — the moment a slice
 * stops being a look-up and starts being something we hold. From there the
 * ordinary explorer, layer and filing pipeline applies, which is why this
 * produces a plain CSV in the incoming queue rather than a special kind.
 */
export async function promoteSlice(input: PromoteInput): Promise<{ slug: string; rows: number }> {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    throw new PlaceFetchError('the library is not available right now', 'no-endpoint')
  }
  const doc = await readSlice(input.slug, input.cacheKey)
  if (!doc) throw new PlaceFetchError('that slice is no longer cached — run the fetch again', 'bad-place')
  const source = await getCatalogEntry(input.slug)

  const newSlug = randomUUID()
  const name = sliceFilename(input.slug, input.cacheKey)
  const key = `library/incoming/${newSlug}/${name}`
  const metaKey = `library/incoming/${newSlug}/meta.json`
  const csv = sliceCsv(doc)
  const title = (input.title ?? '').trim() || `${source?.title ?? input.slug} — ${doc.place.label}`

  const meta: Record<string, unknown> = {
    title,
    category: source?.category || '',
    status: 'needs-review',
    tags: [],
    description: `${doc.count} rows fetched for ${doc.place.label} from ${source?.title ?? input.slug}.`,
    uploadedBy: input.actor?.username ?? 'unknown',
    uploadedById: input.actor?.id ?? null,
    uploadedAt: new Date().toISOString(),
    originalFilename: name,
    contentType: 'text/csv',
    size: Buffer.byteLength(csv),
    lineage: {
      from: `source:${input.slug}`,
      place: doc.place,
      fetchedAt: doc.fetchedAt,
    },
  }

  await putFile(key, csv, 'text/csv')
  const metaJson = JSON.stringify(meta, null, 2)
  await putFile(metaKey, metaJson, 'application/json')
  await indexIncomingEntry(newSlug, meta, [
    { key, size: Buffer.byteLength(csv) },
    { key: metaKey, size: Buffer.byteLength(metaJson) },
  ])

  // The same assistant read a dropped file gets (P5-47) — a proposal for the
  // filing form, never a filing. Best effort: a full queue is not a failure.
  try {
    queueSuggestion({ slug: newSlug, userId: input.actor?.id ?? null, actor: input.actor?.username ?? 'unknown', clientIp: input.clientIp })
  } catch (err: any) {
    console.error('[place] could not queue a filing suggestion:', err?.message || err)
  }

  await recordSlice(input.slug, doc, newSlug).catch(err => {
    console.error(`[place] could not mark slice promoted on ${input.slug}:`, err?.message || err)
  })

  void writeAudit({
    userId: input.actor?.id ?? null,
    actor: input.actor?.username ?? 'unknown',
    action: 'source.promote',
    target: newSlug,
    detail: { from: input.slug, placeKey: input.cacheKey, rows: doc.count },
  })

  return { slug: newSlug, rows: doc.count }
}

export { PlaceFetchError }
export { failureText } from './placeHttp.js'
