/**
 * Catalog browser helpers (P5-9). Types mirror the server's CatalogEntryRow
 * (server/src/services/libraryCatalog.ts); keep in sync by hand — the shape
 * is small and stable.
 */
import { internalFetch, API_URL } from './apiBase'
import { registerLogoutHook } from '@/composables/useAuth'
// Type only: ask.ts imports this module, and a value import would be a cycle.
import type { AskFailureReason } from './ask'
import { resolveDates, type DataDates, type ResolvedDates } from './dataDates'
import {
  PURPOSES,
  SHAPES,
  TOPICS,
  coverageScopeLabel,
  purposeFor,
  purposeLabel,
  shapeLabel,
  topicFor,
  topicLabel,
} from '@/config/taxonomy'
import { stateNameForCode } from '@/config/stateFips'
import { organizationLabel } from '@/config/organizations'

export interface CatalogFile {
  key: string
  size: number
}

export interface CatalogRef {
  slug: string
  title: string
}

/**
 * P6-19: where a dataset applies. Mirrors the server's `Coverage` (see
 * `server/src/services/coverage.ts`, where it is derived).
 *
 * `states` is empty for `national` on purpose: a nationwide table answers
 * "what is nationwide?" and not "what do we hold for Georgia?", so it sits
 * under the National chip and under no single state's.
 */
export interface Coverage {
  /** One of `national`, `multi-state`, `state`, `county`, `local`. */
  scope: string
  /** 2-letter postal codes, sorted. */
  states: string[]
  /** 5-digit county GEOIDs, when there were few enough to be worth naming. */
  counties?: string[]
  /** The words a chip or a heading reads — "National", "Georgia", "4 states". */
  label: string
}

/**
 * P5-82: what this entry is ready to be used as, and whether a place report can
 * run on it. Computed by the server when a row is read — never stored.
 */
export interface Readiness {
  as: 'dataset' | 'source' | 'collection' | 'document' | 'page' | 'link'
  placeReport: 'runs' | 'by-hand' | 'never' | 'candidate'
  notes: string[]
}

/** What each verdict is called on screen. */
export const READINESS_AS_LABELS: Record<Readiness['as'], string> = {
  dataset: 'a table we hold',
  source: 'a data source',
  collection: 'a document collection',
  document: 'a document',
  page: 'a web page',
  link: 'a link',
}

export const PLACE_REPORT_LABELS: Record<Readiness['placeReport'], string> = {
  runs: 'runs',
  'by-hand': 'by hand',
  never: 'never',
  candidate: 'could run if registered as a source',
}

/** The one line under an entry's title: what it is ready as, whether a place
 *  report can run on it, then the server's short reasons. */
export function readinessLine(readiness: Readiness): string {
  return [
    `Ready as: ${READINESS_AS_LABELS[readiness.as]}`,
    `Place report: ${PLACE_REPORT_LABELS[readiness.placeReport]}`,
    ...readiness.notes,
  ].join(' · ')
}

export interface CatalogEntry {
  slug: string
  kind: string
  title: string
  category: string
  status: string
  tags: string[]
  meta: Record<string, unknown>
  files: CatalogFile[]
  bytes: number
  /** P5-82: the readiness verdict, on every row the catalog returns. */
  readiness?: Readiness
  /** P6-1: who published it — a vocabulary id, or an unknown publisher's own
   *  text, which heads its own group. Absent when the entry names nobody. */
  organization?: string
  /** The plain words for `organization`, computed by the server so a row can
   *  be shown without the client resolving the vocabulary again. */
  organizationLabel?: string
  /** P6-2: what kind of thing it is — `areas`, `points`, `statistics`,
   *  `records`. Only datasets and sources carry one. */
  shape?: string
  shapeLabel?: string
  /** P6-19: how much ground it covers. ABSENT when nothing could place it —
   *  which is a different thing from national and must stay different. */
  coverage?: Coverage
  /**
   * P7-10: WHEN the data is from — the period it covers, when the publisher
   * put it out, and when we pulled it. Folded by the server on every read out
   * of the manifest's own `dates:` block, the layer block's year and our fetch
   * records, the way `coverage` is. ABSENT when the entry says nothing, which
   * is not a defect — tagging increases gradually and an untagged dataset is
   * simply untagged.
   *
   * Never `updatedAt`: that says when the BYTES last moved, so re-pushing a
   * 2019 file would make it read as 2026 data.
   */
  dates?: DataDates
  /** ISO timestamp of the last (re)index — recently-updated lists. */
  updatedAt?: string
  /** P5-35 (detail responses only): the current entry this archived one points at. */
  supersededBy?: CatalogRef | null
  /** P5-35 (detail responses only): archived entries this one replaces. */
  supersedes?: CatalogRef[]
}

export interface CatalogFilters {
  q?: string
  kind?: string
  /** P5-63: what an entry is ABOUT — one taxonomy topic id. */
  topic?: string
  /** P5-63: what it is FOR — strategy, research, outreach, ideas. */
  purpose?: string
  /** The old key. Still sent, still honoured by the server as an alias for
   *  whichever of the two the word names, so links written before P5-63 open
   *  the same list. */
  category?: string
  /** P6-1: who published it. The id for a publisher the vocabulary knows, and
   *  the exact group heading for one it does not. */
  organization?: string
  /** P6-2: one of `areas`, `points`, `statistics`, `records`. */
  shape?: string
  /** P6-19: a scope (`national`, `multi-state`, `state`, `county`, `local`), a
   *  state however it is written (`GA`, `Georgia`, `13`), or `none` for the
   *  entries nothing could place. */
  coverage?: string
  /** P6-19: the explicit form of the same question — every entry covering one
   *  state, whether that is all it covers or one of twenty-six. */
  state?: string
  status?: string
  tag?: string
  /** P5-35: include archived rows (the server hides them by default). */
  archived?: boolean
  /** P5-59: the ingest plan on the entry, or `none` for entries with no plan
   *  block at all. */
  plan?: string
  /** P5-59: one row of the admin "to ingest" queue — see `attentionItems`. */
  attention?: string
  /**
   * P5-64: `held-first` (the server's default) puts what we hold — datasets,
   * views, pages, documents, notes, files to file — ahead of the data sources
   * we only index, newest first inside each. `recent` is recency alone, for a
   * list that says "recently updated" and means it.
   */
  sort?: CatalogSort
}

/** Mirror of the server's CATALOG_SORTS; anything else is a 400. */
export type CatalogSort = 'held-first' | 'recent'

export interface CatalogPage {
  entries: CatalogEntry[]
  /** How many archived rows the server hid under the same filters. */
  archivedCount: number
}

/** Build the /api/library/catalog query string. Empty/whitespace values are
 *  dropped; everything else is URL-encoded. Returns '' when no filters. */
export function buildCatalogQuery(filters: CatalogFilters): string {
  const params = new URLSearchParams()
  for (const field of [
    'q',
    'kind',
    'topic',
    'purpose',
    'category',
    'organization',
    'shape',
    'coverage',
    'state',
    'status',
    'tag',
    'plan',
    'attention',
    'sort',
  ] as const) {
    const value = filters[field]?.trim()
    if (value) params.set(field, value)
  }
  if (filters.archived) params.set('archived', '1')
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

// --- Topic and purpose (P5-63) ------------------------------------------------

/**
 * What an entry is ABOUT and what it is FOR, from the one taxonomy.
 *
 * Neither is stored on the row: the topic is the entry's category when that is
 * a topic, otherwise the first of its tags that is one. So a `research` brief
 * tagged `land` shows "Land" on its card with nobody editing a manifest — and
 * the server answers `?topic=land` for it by the same rule.
 */
export function topicOf(entry: Pick<CatalogEntry, 'category' | 'tags'>): string | null {
  return topicFor(entry.category, entry.tags)
}

export function purposeOf(entry: Pick<CatalogEntry, 'category'>): string | null {
  return purposeFor(entry.category)
}

/** The plain words a card, a row or a badge shows for an entry's subject. */
export function topicLabelOf(entry: Pick<CatalogEntry, 'category' | 'tags'>): string {
  const topic = topicOf(entry)
  return topic ? topicLabel(topic) : ''
}

// --- Organization and shape (P6-1, P6-2) --------------------------------------

/**
 * Who published an entry, and what kind of thing it is.
 *
 * Both are worked out at reindex and travel ON the row — unlike the topic,
 * which is derived from words the row already carries. A held table's shape
 * needs its columns read, and a publisher is folded out of prose the list
 * projection does not carry, so neither can be recomputed here. These helpers
 * exist so a view reads one function rather than a raw field, and so an
 * unknown publisher still shows as the words somebody wrote.
 */
export function organizationOf(entry: Pick<CatalogEntry, 'organization'>): string {
  return entry.organization ?? ''
}

export function organizationLabelOf(entry: Pick<CatalogEntry, 'organization' | 'organizationLabel'>): string {
  const organization = entry.organization ?? ''
  if (!organization) return ''
  return entry.organizationLabel || organizationLabel(organization)
}

export function shapeOf(entry: Pick<CatalogEntry, 'shape'>): string {
  return entry.shape ?? ''
}

export function shapeLabelOf(entry: Pick<CatalogEntry, 'shape' | 'shapeLabel'>): string {
  const shape = entry.shape ?? ''
  if (!shape) return ''
  return entry.shapeLabel || shapeLabel(shape)
}

/** The four shapes, for a filter row: id and plain words, in reading order. */
export const SHAPE_CHOICES: { id: string; label: string }[] = SHAPES.map(shape => ({ id: shape.id, label: shape.label }))

// --- Coverage (P6-19) ---------------------------------------------------------

/**
 * Where an entry applies, as a chip, as a heading, and as a filter.
 *
 * Three functions over ONE field, the way `publisherOf` (P6-25) is one
 * function behind the publisher heading, chip and filter — because the moment
 * a chip counts rows differently from the list it opens, the page starts
 * lying. `coverageChipsOf` is what the chips are built from AND what the
 * filter compares, so a chip's count and its list are the same set by
 * construction.
 *
 * The chips a row is under:
 *
 *  - nothing could place it → the "No coverage" chip, pinned last and shown
 *    muted like every other "has none of these";
 *  - national → **National only**, never the fifty states, which is the whole
 *    point of asking what we hold for Georgia;
 *  - any states → **one chip per state**, so a table whose rows are in four
 *    states is found under all four;
 *  - a scope naming no state (a `local` point table, a `regional` source) →
 *    that scope's own words.
 */
/** Anything carrying a coverage: a catalog row, or a browser's own row built
 *  from one. An explicit `null` means the same as leaving it off. */
type HasCoverage = { coverage?: Coverage | null }

export function coverageOf(entry: HasCoverage): Coverage | null {
  return entry.coverage ?? null
}

export function coverageLabelOf(entry: HasCoverage): string {
  return entry.coverage?.label ?? ''
}

/**
 * P7-10: when the entry's DATA is from, as three readable strings.
 *
 * One reader, like `coverageOf` beside it: the entry page, the needs-a-look
 * row and the verification queue all come through here, so what a page shows
 * and what the queue counts cannot disagree.
 */
export function datesOf(entry: { dates?: DataDates }): ResolvedDates {
  return resolveDates(entry.dates)
}

export function coverageChipsOf(entry: HasCoverage): { id: string; label: string }[] {
  const coverage = entry.coverage
  if (!coverage) return [{ id: '', label: 'No coverage' }]
  if (coverage.scope === 'national') return [{ id: 'national', label: 'National' }]
  if (coverage.states.length) return coverage.states.map(code => ({ id: code, label: stateNameForCode(code) || code }))
  return [{ id: coverage.scope, label: coverageScopeLabel(coverage.scope) }]
}

/**
 * The ONE heading a row goes under when the list is grouped by geography.
 *
 * A grouping has to be single-valued — a row under four headings would be
 * counted four times in a list of twelve — so a row covering several states
 * is headed "Several states" while still being found under each of its state
 * chips. One state names its own heading, which is what makes the Georgia
 * group and the Georgia chip read as the same thing.
 */
export function coverageGroupOf(entry: HasCoverage): { id: string; label: string } {
  const coverage = entry.coverage
  if (!coverage) return { id: '', label: 'No coverage' }
  if (coverage.scope === 'national') return { id: 'national', label: 'National' }
  if (coverage.states.length === 1) {
    const code = coverage.states[0]
    return { id: code, label: stateNameForCode(code) || code }
  }
  if (coverage.states.length > 1) return { id: 'multi-state', label: coverageScopeLabel('multi-state') }
  return { id: coverage.scope, label: coverageScopeLabel(coverage.scope) }
}

/**
 * The values the filter compares a row against: every chip it is under, plus
 * its scope.
 *
 * The scope is in here and NOT in the chips so that a link written in the
 * server's own grammar works — `?coverage=multi-state` from the chat or from
 * MCP narrows the page correctly — without putting a redundant chip beside the
 * states it would duplicate. Every chip id is still one of these, which is
 * what keeps a chip's count equal to the list it opens.
 */
export function coverageKeysOf(entry: HasCoverage): string[] {
  const ids = coverageChipsOf(entry).map(chip => chip.id)
  const scope = entry.coverage?.scope
  return scope && !ids.includes(scope) ? [...ids, scope] : ids
}

export function purposeLabelOf(entry: Pick<CatalogEntry, 'category'>): string {
  const purpose = purposeOf(entry)
  return purpose ? purposeLabel(purpose) : ''
}

/**
 * The topic facet: every topic that has something under it, in taxonomy order,
 * with its count — plus a row for the entries nothing has filed yet.
 *
 * Built from the entries the page already has, so the facet costs no request.
 * Topics with nothing under them are left out: a list of fourteen buttons,
 * eleven of them zero, is a worse answer than three.
 */
export interface TopicFacet {
  id: string
  label: string
  count: number
}

export function topicFacets(entries: Pick<CatalogEntry, 'category' | 'tags' | 'kind'>[]): TopicFacet[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const topic = topicOf(entry)
    if (topic) counts.set(topic, (counts.get(topic) ?? 0) + 1)
  }
  return TOPICS.filter(topic => counts.has(topic.id)).map(topic => ({
    id: topic.id,
    label: topic.label,
    count: counts.get(topic.id) ?? 0,
  }))
}

export function purposeFacets(entries: Pick<CatalogEntry, 'category'>[]): TopicFacet[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const purpose = purposeOf(entry)
    if (purpose) counts.set(purpose, (counts.get(purpose) ?? 0) + 1)
  }
  return PURPOSES.filter(purpose => counts.has(purpose.id)).map(purpose => ({
    id: purpose.id,
    label: purpose.label,
    count: counts.get(purpose.id) ?? 0,
  }))
}

/** Human-readable size: 0 B, 512 B, 1.2 KB, 3.4 MB, 1.1 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit++
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`
}

// --- One client-side catalog cache (P5-89) ----------------------------------

/**
 * Every catalog read in the app goes through here, and it does two things:
 *
 *  - **dedupes**: concurrent asks for the same query share one request, so the
 *    two reads a page makes while it mounts cost one round trip;
 *  - **stale-while-revalidate**: once a query has been answered, the next ask
 *    is answered from memory at once and the server is asked again in the
 *    background. A caller that wants the fresher answer passes `onFresh` and is
 *    handed it when it lands.
 *
 * The cache is whole-catalog, not per-row: a write changes rows the writer
 * never named (`supersededBy`, `mentionedBy`, readiness, the facet counts), so
 * every write drops the lot — see `invalidateCatalogCache`.
 */
interface CacheSlot<T> {
  /** The last answer, if the query has ever been answered. */
  value?: T
  /** The request in flight, if there is one. */
  inFlight?: Promise<T>
}

/** What a caller is handed when a background refresh lands. */
export type FreshHandler<T> = (fresh: T) => void

/** Bumped by every invalidation, so an answer to a request that started before
 *  a write cannot land in the cache after it. */
let cacheGeneration = 0
const catalogCache = new Map<string, CacheSlot<unknown>>()

/** How many queries the cache keeps. The palette mints a key per search, so
 *  without a bound a long session would hold every list anyone ever typed.
 *  A Map iterates in insertion order, so re-inserting a key on use makes the
 *  eviction below least-recently-used — the full catalog every page shares
 *  never falls out from under them. */
const CACHE_MAX_QUERIES = 24

function sendRequest<T>(key: string, slot: CacheSlot<T>, load: () => Promise<T>): Promise<T> {
  const startedAt = cacheGeneration
  const request = load()
  slot.inFlight = request
  // Both outcomes are settled in this one reaction, attached before any caller
  // gets to await the request: a `.finally` chained after a `.then` would leave
  // `inFlight` pointing at an already-settled promise for a couple of
  // microtasks, and the next ask would join it instead of refreshing.
  const settled = () => {
    if (slot.inFlight === request) slot.inFlight = undefined
  }
  void request.then(
    value => {
      settled()
      // A write (or a logout) that happened while this was in the air wins:
      // an answer from before it must not become the cached truth.
      if (startedAt === cacheGeneration && catalogCache.get(key) === slot) slot.value = value
    },
    () => {
      settled()
      // The asker sees the rejection; the cache simply keeps what it had.
    },
  )
  return request
}

function readThrough<T>(key: string, load: () => Promise<T>, onFresh?: FreshHandler<T>): Promise<T> {
  let slot = catalogCache.get(key) as CacheSlot<T> | undefined
  if (slot) {
    catalogCache.delete(key)
  } else {
    slot = {}
    if (catalogCache.size >= CACHE_MAX_QUERIES) {
      const coldest = catalogCache.keys().next().value
      if (coldest !== undefined) catalogCache.delete(coldest)
    }
  }
  catalogCache.set(key, slot as CacheSlot<unknown>)
  const known = slot.value
  const fresh = slot.inFlight ?? sendRequest(key, slot, load)
  // Nothing cached: this IS the answer, and a second caller joins this request.
  if (known === undefined) return fresh
  // Cached: answer now, and hand the refreshed answer to whoever asked for it.
  if (onFresh) void fresh.then(onFresh, () => {})
  else void fresh.catch(() => {})
  return Promise.resolve(known)
}

/**
 * Forget everything the catalog has said. Called by every write below, by the
 * writes that live in other modules (a saved view, a wiki page, documents
 * pulled in), and on logout — nothing internal may outlive the session.
 */
export function invalidateCatalogCache(): void {
  cacheGeneration += 1
  catalogCache.clear()
}

registerLogoutHook(invalidateCatalogCache)

export function fetchCatalogPage(
  filters: CatalogFilters = {},
  onFresh?: FreshHandler<CatalogPage>,
): Promise<CatalogPage> {
  const query = buildCatalogQuery(filters)
  return readThrough(
    `list${query}`,
    async () => {
      const res = await internalFetch(`/api/library/catalog${query}`)
      if (!res.ok) throw new Error(`catalog request failed (${res.status})`)
      const body = await res.json()
      return { entries: body.entries as CatalogEntry[], archivedCount: Number(body.archivedCount ?? 0) }
    },
    onFresh,
  )
}

export async function fetchCatalog(
  filters: CatalogFilters = {},
  onFresh?: FreshHandler<CatalogEntry[]>,
): Promise<CatalogEntry[]> {
  const page = await fetchCatalogPage(filters, onFresh && (fresh => onFresh(fresh.entries)))
  return page.entries
}

export function fetchCatalogEntry(
  slug: string,
  onFresh?: FreshHandler<CatalogEntry | null>,
): Promise<CatalogEntry | null> {
  return readThrough(
    `entry:${slug}`,
    async () => {
      const res = await internalFetch(`/api/library/catalog/${encodeURIComponent(slug)}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`catalog entry request failed (${res.status})`)
      const body = await res.json()
      return body.entry as CatalogEntry
    },
    onFresh,
  )
}

/** Client-side mirror of the server's default LIBRARY_UPLOAD_MAX_BYTES —
 *  oversize files are rejected before any bytes leave the browser (spec
 *  Example 8: client- AND server-side). Keep in sync with the server. */
export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024

export interface UploadMeta {
  title?: string
  category?: string
  tags?: string
  description?: string
}

export interface UploadResult {
  slug: string
  key: string
  size: number
  status: string
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    /* non-JSON error body */
  }
  return fallback
}

/** Upload one file to the incoming/ tree. Metadata fields are optional —
 *  omitting them all is a quick drop (status needs-cataloging). */
export async function uploadLibraryFile(file: File, meta: UploadMeta = {}): Promise<UploadResult> {
  if (file.size > UPLOAD_MAX_BYTES) {
    throw new Error(
      `"${file.name}" is too large — the upload limit is ${formatBytes(UPLOAD_MAX_BYTES)}.`,
    )
  }
  const form = new FormData()
  for (const field of ['title', 'category', 'tags', 'description'] as const) {
    const value = meta[field]?.trim()
    if (value) form.set(field, value)
  }
  // File part last so busboy sees the metadata fields before the stream.
  form.set('file', file, file.name)
  const res = await internalFetch('/api/library/upload', { method: 'POST', body: form })
  if (!res.ok) throw new Error(await errorMessage(res, `upload failed (${res.status})`))
  invalidateCatalogCache()
  return (await res.json()) as UploadResult
}

export interface NoteInput {
  title: string
  body: string
  category?: string
  tags?: string[]
}

/** Create a text-only entry (P5-12) — "New idea" and friends. The server
 *  slugs the title, defaults category to 'ideas', and sets ideas to open. */
export async function createNoteEntry(input: NoteInput): Promise<CatalogEntry> {
  const res = await internalFetch('/api/library/entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `note create failed (${res.status})`))
  invalidateCatalogCache()
  const body = await res.json()
  return body.entry as CatalogEntry
}

export interface FilingUpdates {
  title?: string
  category?: string
  tags?: string[]
  description?: string
  /** P6-8a: the publisher id and the shape as accepted or chosen; '' clears
   *  the field so a reindex derives it again. */
  organization?: string
  shape?: string
  /** note-only fields (P5-12) */
  body?: string
  status?: string
  /** P5-56: filing an already-dropped link as a data source moves it from the
   *  incoming queue to library/sources/ and flips its kind. */
  source?: Record<string, unknown>
}

/** Statuses an idea moves through — mirror of the server's NOTE_STATUSES. */
export const NOTE_STATUSES = ['open', 'planned', 'done'] as const

/** File an incoming entry from the queue, or edit a note in place — the
 *  server dispatches on the entry's kind. */
export async function fileCatalogEntry(slug: string, updates: FilingUpdates): Promise<CatalogEntry> {
  const res = await internalFetch(`/api/library/catalog/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `filing failed (${res.status})`))
  invalidateCatalogCache()
  const body = await res.json()
  return body.entry as CatalogEntry
}

export async function requestReindex(): Promise<number> {
  const res = await internalFetch('/api/library/reindex', { method: 'POST' })
  if (!res.ok) throw new Error(`reindex failed (${res.status})`)
  invalidateCatalogCache()
  const body = await res.json()
  return body.indexed as number
}

/** Download URL for one file of an entry (P5-25). A plain link works: the
 *  session cookie rides along on a top-level navigation and the server
 *  answers with Content-Disposition: attachment. `name` is the basename
 *  inside the entry folder (what the detail page lists). */
export function libraryFileUrl(slug: string, name: string): string {
  return `${API_URL}/api/library/file/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`
}

/** P5-36: the internal map layer id an entry powers (`internal-<slug>`) when
 *  its manifest carries a layer block, else null. Names only — the block's
 *  plumbing stays on the server. */
export function layerIdForEntry(entry: Pick<CatalogEntry, 'slug' | 'meta' | 'status'>): string | null {
  const layer = entry.meta?.layer
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return null
  if (entry.status !== 'published') return null
  return `internal-${entry.slug}`
}

/** Entry hub URL (P5-37): the entry page with an optional tab (`data`, `map`, `mentions`, `files`). */
export function entryUrl(slug: string, tab?: 'data' | 'map' | 'mentions' | 'files', extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra)
  if (tab) params.set('tab', tab)
  const qs = params.toString()
  return `/library/${encodeURIComponent(slug)}${qs ? `?${qs}` : ''}`
}

export interface ViewRef {
  slug: string
  title: string
  savedBy: string
  savedAt: string
}

function viewRefsFrom(entries: CatalogEntry[], matches: (view: CatalogEntry) => boolean): ViewRef[] {
  return entries
    .filter(v => v.kind === 'view' && v.status !== 'archived')
    .filter(matches)
    .map(v => ({
      slug: v.slug,
      title: v.title,
      savedBy: typeof v.meta.savedBy === 'string' ? v.meta.savedBy : '',
      savedAt: typeof v.meta.savedAt === 'string' ? v.meta.savedAt : '',
    }))
}

/** Saved views whose state uses the given layer id (from the catalog's view rows).
 *  P5-89: read off the one full catalog every internal page shares rather than
 *  a `kind=view` query of its own — same rows, no second request. */
export async function fetchViewsUsingLayer(layerId: string): Promise<ViewRef[]> {
  const entries = await fetchCatalog({ archived: true })
  return viewRefsFrom(
    entries,
    v => Array.isArray(v.meta.layers) && (v.meta.layers as unknown[]).includes(layerId),
  )
}

/**
 * The saved views PRESENTING a working set (P7-2).
 *
 * A set holds no framing, so it cannot be shown without a view — which makes
 * this the only route from a set's entry page to its two interfaces. Several
 * views over one set is the normal case, not an edge: that is what the two
 * objects being two objects is for. Same shared catalog as the layer list
 * above, so this costs no request.
 */
export async function fetchViewsOfWorkingSet(slug: string): Promise<ViewRef[]> {
  if (!slug) return []
  const entries = await fetchCatalog({ archived: true })
  return viewRefsFrom(entries, v => v.meta.workingSet === slug)
}

/** Wiki pages that link or embed the entry (built at reindex, see P5-37). */
export function mentionedBy(entry: Pick<CatalogEntry, 'meta'>): CatalogRef[] {
  const raw = entry.meta?.mentionedBy
  if (!Array.isArray(raw)) return []
  return raw.filter((m): m is CatalogRef => !!m && typeof m === 'object' && typeof (m as CatalogRef).slug === 'string' && typeof (m as CatalogRef).title === 'string')
}

/** P5-34: drop a link into the incoming queue (no file). A bare URL lands in
 *  the "to file" queue; a title/category/tags file it straight away. */
export interface LinkInput {
  url: string
  note?: string
  title?: string
  category?: string
  tags?: string[]
  /** P5-47: false records the link without downloading it. */
  fetch?: boolean
  /** P5-56: "This is a data source" — the server validates the block and files
   *  the entry as kind `source`. Only `provider` is required. */
  source?: Record<string, unknown>
}

export interface LinkResult {
  slug: string
  status: string
  title: string
  /** 'incoming' or, with a source block, 'source' (P5-56). */
  kind?: string
  /** P5-47: 'queued' when the server is fetching the link now, 'later' when
   *  the queue was full, 'skipped' for a source or an explicit fetch: false. */
  fetch?: FetchStatus | 'skipped'
  /** Fields the server dropped from the block — plain lines to show back. */
  dropped?: string[]
}

export async function createLinkEntry(input: LinkInput): Promise<LinkResult> {
  const res = await internalFetch('/api/library/links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `link drop failed (${res.status})`))
  invalidateCatalogCache()
  return (await res.json()) as LinkResult
}

/** The dropped URL of a link entry (http(s) only), else null. */
export function linkOf(entry: Pick<CatalogEntry, 'meta'>): string | null {
  const url = entry.meta?.url
  return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url.trim()) ? url.trim() : null
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// --- Fetch on drop + suggested filing (P5-47) -------------------------------
// The server fetches a dropped link in the background and asks the assistant
// to propose a filing. Both live on the entry's manifest; both are read-only
// here — a suggestion becomes a filing only when a person presses Apply.

export type FetchStatus = 'queued' | 'later' | 'fetching' | 'fetched' | 'failed'

export interface FetchState {
  status: FetchStatus
  at: string
  /** fetched: the file's size and its name inside the entry. */
  bytes?: number
  name?: string
  /** failed / later: why, in the server's own plain words. */
  reason?: string
}

const FETCH_STATUSES: readonly string[] = ['queued', 'later', 'fetching', 'fetched', 'failed']

export function fetchStateOf(entry: Pick<CatalogEntry, 'meta'>): FetchState | null {
  const raw = entry.meta?.fetch
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const state = raw as FetchState
  return FETCH_STATUSES.includes(state.status) ? state : null
}

/** True while the server still intends to fetch this link. */
export function isFetchPending(entry: Pick<CatalogEntry, 'meta'>): boolean {
  const status = fetchStateOf(entry)?.status
  return status === 'queued' || status === 'fetching'
}

/** The card chip, or null when there is nothing worth a chip (a link that has
 *  its file, or one nobody asked to fetch). */
export function fetchChip(entry: Pick<CatalogEntry, 'meta'>): string | null {
  switch (fetchStateOf(entry)?.status) {
    case 'queued':
    case 'fetching':
      return 'Fetching…'
    case 'fetched':
      return 'Fetched'
    case 'failed':
      return 'Fetch failed'
    default:
      return null
  }
}

export interface Suggestion {
  title?: string
  category?: string
  tags?: string[]
  summary?: string
  /** P6-8: the three the bulk pass adds. `category` is still the one field a
   *  filing applies — the topic when there is one, else the purpose — and
   *  these sit beside it so a row can show both halves of the answer. */
  topic?: string
  purpose?: string
  /** An id from the organization vocabulary (P6-1), never free text. */
  organization?: string
  /** One of the four shapes (P6-2). */
  shape?: string
  at?: string
  model?: string
  /** P5-59: the proposal was made from the first 64 kB of a file too large to
   *  extract, rather than from its text. */
  basis?: 'head'
  /** Set instead of the fields when the assistant could not be asked. */
  error?: 'unavailable'
  /** P5-75: WHY the model could not be asked, when the call itself failed.
   *  Admins are told the sentence; everyone else is told it was unavailable. */
  reason?: AskFailureReason
}

export function suggestionOf(entry: Pick<CatalogEntry, 'meta'>): Suggestion | null {
  const raw = entry.meta?.suggested
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Suggestion
}

/**
 * P6-8: the title a machine proposed and nobody has accepted yet, or null.
 *
 * Shown greyed with a "suggested" badge wherever an entry is named. A list row
 * carries the answer already (`meta.suggestedTitle`, derived on the server so
 * a card never has to work it out); a full entry is compared here, against the
 * one meaning "accepted" has — the entry's own title IS the proposal.
 */
export function suggestedTitleOf(entry: Pick<CatalogEntry, 'title' | 'meta'>): string | null {
  const fromRow = entry.meta?.suggestedTitle
  if (typeof fromRow === 'string') return fromRow.trim() || null
  const proposed = suggestionOf(entry)?.title?.trim()
  if (!proposed) return null
  return proposed === (entry.title ?? '').trim() ? null : proposed
}

/** A proposal with something in it — an `unavailable` marker is not one. */
export function hasSuggestion(entry: Pick<CatalogEntry, 'meta'>): boolean {
  const suggestion = suggestionOf(entry)
  if (!suggestion || suggestion.error) return false
  return !!(suggestion.title || suggestion.category || suggestion.summary || suggestion.tags?.length)
}

/** P5-83: a reading that happened without the model pass that should have
 *  followed it. */
export interface ModelPassGap {
  /** When the thing was read, when we know: the inspection's own time first,
   *  then the fetch, then the failed pass. */
  readAt?: string
  /** P5-75's reason, present only on an admin's copy of the entry. */
  reason?: AskFailureReason
}

/**
 * P5-83: read, but not summarised.
 *
 * Two shapes mean the same thing to a reader: the pass ran and recorded
 * `{ error: 'unavailable' }`, or the fetch says the page was read and no
 * suggestion was ever written. Either way the entry has an empty summary that
 * nobody should mistake for "never read". Returns null when a pass produced
 * something, and when nothing has been read yet.
 */
export function modelPassGap(entry: Pick<CatalogEntry, 'meta'>): ModelPassGap | null {
  if (hasSuggestion(entry)) return null
  const suggestion = suggestionOf(entry)
  const fetch = fetchStateOf(entry)
  const failed = suggestion?.error === 'unavailable'
  const readWithNothingToShow = !suggestion && fetch?.status === 'fetched'
  if (!failed && !readWithNothingToShow) return null
  const readAt = inspectionOf(entry)?.checkedAt || fetch?.at || suggestion?.at
  return { ...(readAt ? { readAt } : {}), ...(suggestion?.reason ? { reason: suggestion.reason } : {}) }
}

/** Ask the server to fetch this link again (a failure, or a drop made while
 *  the queue was full). Returns the new fetch status. */
export async function refetchLink(slug: string): Promise<FetchStatus> {
  const res = await internalFetch(`/api/library/catalog/${encodeURIComponent(slug)}/refetch`, { method: 'POST' })
  if (!res.ok) throw new Error(await errorMessage(res, `could not start the fetch (${res.status})`))
  invalidateCatalogCache()
  const body = await res.json()
  return body.fetch as FetchStatus
}

// --- Data sources (P5-56) ---------------------------------------------------
// A `source` entry indexes a dataset we do NOT hold — EPA, FEMA, USDA, a state
// agency. Types mirror server/src/services/sourceMeta.ts, which is the only
// thing allowed to CLEAN a block; everything here just reads the cleaned one.

export const SOURCE_GEOGRAPHIES = ['point', 'parcel', 'blockgroup', 'tract', 'county', 'state', 'national'] as const
export type SourceGeography = (typeof SOURCE_GEOGRAPHIES)[number]

export const SOURCE_ACCESS_TYPES = ['arcgis', 'socrata', 'rest', 'download', 'wfs', 'manual'] as const
export type SourceAccessType = (typeof SOURCE_ACCESS_TYPES)[number]

export interface SourceField {
  name: string
  description?: string
}

export interface SourceAccess {
  type: SourceAccessType
  url?: string
  docs?: string
  auth?: string
  format?: string
  notes?: string
}

/**
 * P5-57: one cached slice of a source — the rows we hold for one place.
 * `replication.slices` also still accepts a bare STRING, which is the dataset
 * slug P5-56 wrote there; an old manifest keeps rendering.
 */
export interface SourceSlice {
  /** `g<geoid>` or `p<lat>_<lng>_r<miles>`. */
  cacheKey: string
  place?: string
  count?: number
  fetchedAt?: string
  adapter?: SourceAccessType
  /** Set once the slice was saved as a dataset. */
  dataset?: string
}

export interface SourceReplication {
  status: 'indexed' | 'partial' | 'replicated'
  slices?: (string | SourceSlice)[]
  dataset?: string
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
  placeQuery?: {
    by?: string[]
    radiusMiles?: number
    fipsField?: string
    /** P5-59: `prefix` matches a tract or block-group id by its county's first
     *  five digits. Absent means `exact`. */
    fipsMatch?: 'exact' | 'prefix'
    /** P5-59: a `number` column is filtered by a numeric range instead, its
     *  leading zero being long gone. Absent means `text`. */
    fipsType?: 'text' | 'number'
    geoField?: string
    template?: string
  }
  license?: string
  updateCadence?: string
  lastChecked?: string
  relevance?: string
  notes?: string
  replication?: SourceReplication
  /** P5-59: the last time a fetch for this source failed. Cleared by the next
   *  success, so its presence means "failing now", not "failed once". */
  lastError?: { at: string; code: string; text: string }
}

/** The entry's `source` block, or null. A plain-STRING `source` (datasets have
 *  carried provenance prose there since the first content load) is not one. */
export function sourceOf(entry: Pick<CatalogEntry, 'meta'>): SourceMeta | null {
  const raw = entry.meta?.source
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as SourceMeta
  return typeof source.provider === 'string' && source.provider ? source : null
}

/** P5-56: the badge every list shows for a data source. Deliberately NOT
 *  kindLabel — a source reads as "Source", capital S, in cards, on the entry
 *  page and in ⌘K, and that label must not drift with the generic kind text. */
export const SOURCE_BADGE = 'Source'

export function sourceBadge(entry: Pick<CatalogEntry, 'kind'>): string | null {
  return entry.kind === 'source' ? SOURCE_BADGE : null
}

/** Plain-language names for the access methods. */
export const ACCESS_TYPE_LABELS: Record<SourceAccessType, string> = {
  arcgis: 'ArcGIS',
  socrata: 'Socrata',
  rest: 'REST API',
  download: 'Download',
  wfs: 'WFS',
  manual: 'Manual',
}

export function accessTypeLabel(type: string): string {
  return ACCESS_TYPE_LABELS[type as SourceAccessType] ?? type
}

/** "no key needed" / "key needed", or null when the manifest doesn't say. */
export function accessAuthLabel(access: Pick<SourceAccess, 'auth'>): string | null {
  const auth = typeof access.auth === 'string' ? access.auth.trim().toLowerCase() : ''
  if (!auth) return null
  return auth === 'none' ? 'no key needed' : 'key needed'
}

/** The "Covers" line: geography, coverage, granularity — whichever are set. */
export function coversLine(source: SourceMeta): string {
  const parts: string[] = []
  if (source.geography) parts.push(source.geography)
  if (source.coverage) parts.push(source.coverage)
  if (source.granularity?.length) parts.push(source.granularity.join(', '))
  return parts.join(' · ')
}

/** Access types P5-57 will have an adapter for. A `manual` or `wfs` source has
 *  nothing to fetch, so its Fetch action is hidden rather than shown dead. */
export const FETCHABLE_ACCESS_TYPES: readonly string[] = ['arcgis', 'socrata', 'rest', 'download']

export function canFetchForPlace(source: SourceMeta | null): boolean {
  return !!source?.access?.some(a => FETCHABLE_ACCESS_TYPES.includes(a.type))
}

/** One honest line about what we actually hold, plus the dataset to link to. */
export function replicationSummary(source: SourceMeta): { text: string; datasetSlug: string | null } {
  const replication = source.replication
  if (replication?.status === 'replicated') {
    return {
      text: replication.dataset ? 'Copied as' : 'Copied into the library',
      datasetSlug: replication.dataset ?? null,
    }
  }
  if (replication?.status === 'partial') {
    const count = replication.slices?.length ?? 0
    return { text: `Partly copied: ${count} ${count === 1 ? 'slice' : 'slices'}`, datasetSlug: null }
  }
  // No block, or `indexed`: we know where it lives, we do not hold it.
  return { text: 'Indexed — not copied here', datasetSlug: null }
}

/** The slices recorded on a source — the places we already hold rows for.
 *  A string entry is a promoted dataset slug, not a place, and is left to
 *  `replicationDatasets` below. */
export function slicesOf(source: SourceMeta | null): SourceSlice[] {
  return (source?.replication?.slices ?? []).filter((s): s is SourceSlice => typeof s !== 'string' && !!s?.cacheKey)
}

/** The dataset slugs on a source's replication line (P5-56 wrote bare strings;
 *  a promoted slice carries one too). */
export function replicationDatasets(source: SourceMeta | null): string[] {
  const slices = source?.replication?.slices ?? []
  const out: string[] = []
  for (const slice of slices) {
    const slug = typeof slice === 'string' ? slice : slice?.dataset
    if (slug && !out.includes(slug)) out.push(slug)
  }
  return out
}

/** How far a place is from a point, in the words the panel uses. */
export function radiusLabel(miles: number): string {
  const rounded = Number(miles.toFixed(2))
  if (rounded === 1) return '1 mile'
  if (rounded > 1) return `${rounded} miles`
  return `${rounded} of a mile`
}

/** The question the entry page's Ask box opens with. */
export function askQuestionForSource(title: string): string {
  return `What does ${title} cover and how do I query it for a place?`
}

/**
 * The "This is a data source" form (P5-56), shared by the drop-a-link form and
 * the filing form. Deliberately flat strings: a teammate who found a dataset
 * fills in what they know, and the rest gets added later on the entry page.
 */
export interface SourceFormState {
  provider: string
  program: string
  geography: string
  coverage: string
  /** comma-separated */
  topics: string
  accessType: string
  accessUrl: string
  license: string
  /** "Why it matters" — stored as the block's `relevance`. */
  notes: string
}

export function emptySourceForm(): SourceFormState {
  return { provider: '', program: '', geography: '', coverage: '', topics: '', accessType: '', accessUrl: '', license: '', notes: '' }
}

/** Prefill the form from a block so editing starts from what is already there. */
export function sourceFormFrom(source: SourceMeta | null): SourceFormState {
  const form = emptySourceForm()
  if (!source) return form
  form.provider = source.provider ?? ''
  form.program = source.program ?? ''
  form.geography = source.geography ?? ''
  form.coverage = source.coverage ?? ''
  form.topics = (source.topics ?? []).join(', ')
  const access = source.access?.[0]
  form.accessType = access?.type ?? ''
  form.accessUrl = access?.url ?? ''
  form.license = source.license ?? ''
  form.notes = source.relevance ?? ''
  return form
}

/**
 * Form → the `source` block the API takes, or null when there is no provider
 * (the one field we cannot guess). The server cleans it either way.
 *
 * `base` is the block the form was filled FROM. The form only renders nine
 * fields; a block can carry columns, a place query, a cadence and a
 * replication status besides. Without this those would be silently thrown
 * away the first time somebody pressed Save — which for a P5-59 proposal
 * would mean losing exactly the parts that took a probe to work out.
 */
export function sourceFromForm(form: SourceFormState, base?: SourceMeta | null): Record<string, unknown> | null {
  const provider = form.provider.trim()
  if (!provider) return null
  const carried: Record<string, unknown> = {}
  if (base) {
    for (const key of ['homepage', 'granularity', 'fields', 'placeQuery', 'updateCadence', 'lastChecked', 'notes', 'replication'] as const) {
      const value = (base as unknown as Record<string, unknown>)[key]
      if (value !== undefined && value !== null) carried[key] = value
    }
  }
  const source: Record<string, unknown> = { ...carried, provider }
  const put = (key: string, value: string) => {
    const trimmed = value.trim()
    if (trimmed) source[key] = trimmed
  }
  put('program', form.program)
  put('geography', form.geography)
  put('coverage', form.coverage)
  const topics = form.topics.split(',').map(t => t.trim()).filter(Boolean)
  if (topics.length) source.topics = topics
  const accessType = form.accessType.trim()
  const accessUrl = form.accessUrl.trim()
  if (accessType) {
    // Keep the format/auth/notes the proposal worked out, as long as the
    // person did not point the method somewhere else.
    const previous = base?.access?.[0]
    const keep = previous && previous.type === accessType && (previous.url ?? '') === accessUrl ? previous : null
    source.access = [{ ...(keep ?? {}), type: accessType, ...(accessUrl ? { url: accessUrl } : {}) }]
  }
  put('license', form.license)
  put('relevance', form.notes)
  return source
}

// --- Link inspection and the ingest plan (P5-59) -----------------------------
// The server probes a dropped link and says what it is; an admin then records
// how it comes in. Both live on the entry's manifest and both are read-only
// here — the inspection is data about the link, never a filing, and the plan is
// written by an admin-only route.

export const INSPECT_KINDS = ['arcgis-layer', 'arcgis-service', 'socrata', 'file', 'portal', 'page', 'unreachable'] as const
export type InspectKind = (typeof INSPECT_KINDS)[number]

export interface InspectField {
  name: string
  type?: string
  alias?: string
}

/** P5-61: what a kept link IS, once the model pass has read the page. */
export const LINK_ROLES = ['data-file', 'directory', 'api', 'service-layer', 'viewer', 'docs', 'landing'] as const
export type LinkRole = (typeof LINK_ROLES)[number]

/** Short enough for a badge, plain enough to mean something to a researcher. */
export const LINK_ROLE_LABELS: Record<LinkRole, string> = {
  'data-file': 'file',
  /** An FTP archive or a folder of files: the data, one click further away. */
  directory: 'folder of files',
  api: 'API',
  'service-layer': 'map layer',
  /** P5-62: a form a person fills in, not an endpoint a program calls. */
  viewer: 'query form / viewer',
  docs: 'docs',
  landing: 'page',
}

export interface InspectLink {
  url: string
  label?: string
  kind?: InspectKind
  /** P5-61: absent on a portal's own typed list, present on anything pruned. */
  role?: LinkRole
  /** P5-61: one line saying why this link survived and the others did not. */
  reason?: string
}

/** P5-61: how a page says its data can be got at, in the page's own words. */
export interface AccessNote {
  kind: 'api' | 'download' | 'viewer' | 'request'
  text: string
  url?: string
}

/** P5-61: what the page's PROSE said, each field with its evidence sentence. */
export interface ProseRead {
  provider?: string
  program?: string
  updateCadence?: string
  license?: string
  coverage?: string
  geography?: string
  accessNotes?: AccessNote[]
  evidence?: Record<string, string>
  isDataset?: boolean
}

export interface InspectLayerRef {
  id: number
  name: string
  url: string
  geometry?: string
}

export interface Inspection {
  kind: InspectKind
  confidence: 'high' | 'medium' | 'low'
  url: string
  finalUrl?: string
  title?: string
  provider?: string
  description?: string
  fields?: InspectField[]
  geometry?: 'point' | 'line' | 'polygon' | 'table'
  extent?: { xmin: number; ymin: number; xmax: number; ymax: number }
  rowCount?: number
  formats?: string[]
  contentType?: string
  bytes?: number
  links?: InspectLink[]
  /** P5-61: how many links the page offered before the prune. */
  candidates?: number
  /** P5-61: `model` when something read the page, `unranked` when the links
   *  were picked by URL shape alone. */
  pruned?: 'model' | 'unranked'
  /** P5-61: why it is unranked — the model failed, or was never asked. */
  pruneError?: string
  /** P5-75: why the model failed, when that was the problem — admins see a sentence for it. */
  pruneErrorCode?: 'no-key' | 'refused' | 'rate-limited' | 'model-error'
  /** P5-61: the URLs the pass left out (≤ 20), for a reviewer checking it. */
  dropped?: string[]
  /** P5-61: what the page said in words. */
  prose?: ProseRead
  /** P5-79: the page's own HTML about itself — the deterministic floor. */
  page?: { title?: string; description?: string; provider?: string; insecure?: boolean }
  /** P5-80: documents linked from the page that can be pulled in as one collection. */
  documents?: { url: string; label: string; context?: string }[]
  /** P5-61: the portal software we read instead of the HTML ('ckan'). */
  platform?: string
  layers?: InspectLayerRef[]
  cadence?: string
  topics?: string[]
  license?: string
  crs?: string
  notes?: string[]
  /** The one-line description, written by the server (naming the state an
   *  extent covers needs a table of bounding boxes we do not ship). */
  summary?: string
  checkedAt: string
}

export function inspectionOf(entry: Pick<CatalogEntry, 'meta'>): Inspection | null {
  const raw = entry.meta?.inspection
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const inspection = raw as Inspection
  return (INSPECT_KINDS as readonly string[]).includes(inspection.kind) ? inspection : null
}

/** The line under the title: what this link is, in one phrase. Falls back to
 *  the kind alone for an inspection written before summaries were stored. */
export function inspectionLine(inspection: Inspection): string {
  if (inspection.summary) return inspection.summary
  return inspection.kind === 'unreachable' ? 'Could not reach it — check the link' : INSPECT_KIND_LABELS[inspection.kind]
}

export const INSPECT_KIND_LABELS: Record<InspectKind, string> = {
  'arcgis-layer': 'ArcGIS layer',
  'arcgis-service': 'ArcGIS service',
  socrata: 'Socrata dataset',
  file: 'Data file',
  portal: 'Data portal page',
  page: 'Web page',
  unreachable: 'Could not reach it',
}

/** True when this link is a service we would query rather than a file we hold. */
export function isQueryableKind(kind: InspectKind): boolean {
  return kind === 'arcgis-layer' || kind === 'arcgis-service' || kind === 'socrata'
}

/**
 * P5-61: is this worth offering "Register as a data source" for?
 *
 * A recognised service or file always was. What is new is the page that turned
 * out to describe a dataset — the model said so AND there is something real to
 * point at, which is the same pair of signals the server's plan rule uses.
 */
export function canRegisterAsSource(inspection: Inspection | null): boolean {
  if (!inspection) return false
  if (isQueryableKind(inspection.kind) || inspection.kind === 'file') return true
  if (!inspection.prose?.isDataset) return !!(inspection.kind === 'portal' && inspection.links?.length)
  return !!inspection.links?.length || !!inspection.prose.accessNotes?.length
}

/**
 * P5-82: does this URL look like something a place report could query?
 *
 * A shape test on the URL alone — an ArcGIS service, a Socrata dataset, or a
 * data file — mirroring the server's `classifyByShape` (linkInspect.ts), which
 * is the real answer once the link has been looked at. It is used before that,
 * while somebody is still typing: a "data source" drop whose URL is a plain
 * page registers a pointer that no report can run, and the form says so.
 */
const ARCGIS_URL = /\/(FeatureServer|MapServer)(?:\/\d+)?\/?$/i
const SOCRATA_URL = /\/(?:resource|api\/views|d|dataset\/[^/]+)\/[a-z0-9]{4}-[a-z0-9]{4}/i
const DATA_FILE_URL = /\.(csv|tsv|json|geojson|zip|xlsx|xls|kml|kmz|gpkg|gdb)$/i

export function looksLikeEndpointUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return false
  }
  return ARCGIS_URL.test(url.pathname) || SOCRATA_URL.test(url.pathname) || DATA_FILE_URL.test(url.pathname)
}

/** P5-61: how many links the page had that we did not keep. */
export function droppedLinkCount(inspection: Inspection | null): number {
  if (!inspection?.candidates) return 0
  return Math.max(0, inspection.candidates - (inspection.links?.length ?? 0))
}

export const INGEST_PLANS = ['index', 'fetch-on-demand', 'replicate', 'document'] as const
export type IngestPlanName = (typeof INGEST_PLANS)[number]
export type IngestMode = 'auto' | 'manual'

export interface IngestPlan {
  plan: IngestPlanName
  mode?: IngestMode
  owner?: string
  note?: string
  decidedBy: string
  decidedAt: string
  done?: { at: string; dataset?: string }
}

export function ingestOf(entry: Pick<CatalogEntry, 'meta'>): IngestPlan | null {
  const raw = entry.meta?.ingest
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const plan = raw as IngestPlan
  return (INGEST_PLANS as readonly string[]).includes(plan.plan) ? plan : null
}

export const PLAN_LABELS: Record<IngestPlanName, string> = {
  index: 'Index only',
  'fetch-on-demand': 'Fetch for a place',
  replicate: 'Copy into the library',
  document: 'Read as a document',
}

/** What the plan means for whoever is looking at the entry, in plain words. */
export const PLAN_NEXT_STEPS: Record<IngestPlanName, string> = {
  index: 'We keep the pointer and nothing else. Open the link from here; nothing is downloaded and nothing goes on the map.',
  'fetch-on-demand':
    'Nobody copies this. When a report or a question needs it for one address or county, the server asks the agency then and keeps the answer.',
  replicate:
    'The whole dataset gets copied into the library so it can be cleaned, explored and mapped.',
  document: 'This is something to read, not a table. It is filed as a document and its text is searchable.',
}

export function whatHappensNext(plan: IngestPlanName, mode?: IngestMode, done?: IngestPlan['done']): string {
  const base = PLAN_NEXT_STEPS[plan]
  if (done) return `${base} Done — the dataset is here.`
  if (plan !== 'replicate' || !mode) return base
  return mode === 'auto'
    ? `${base} Press "Copy it in now" and the server does it.`
    : `${base} By hand: pull it, clean it, push it, then Reindex.`
}

export interface SourceProposal {
  title?: string
  category?: string
  tags?: string[]
  description?: string
  source: SourceMeta
  /** Dotted paths the server filled in: 'provider', 'placeQuery.by', … */
  inferred: string[]
  /** P5-61: for fields read out of a page's prose, the sentence behind each. */
  evidence?: Record<string, string>
}

export interface SuggestedPlan {
  plan: IngestPlanName
  mode?: IngestMode
  why: string
}

export interface ProposalResponse {
  inspection: Inspection
  summary: string
  proposal: SourceProposal
  suggestedPlan: SuggestedPlan | null
}

/**
 * Which form fields the machine filled in, from the proposal's dotted paths.
 *
 * The form is nine flat strings; the block has more structure than that, so
 * the mapping is explicit. Fields the form does not render are not chipped —
 * they are carried through unseen (see `sourceFromForm`) and shown in the
 * inspection panel instead.
 */
export function inferredFormFields(inferred: string[]): Set<keyof SourceFormState> {
  const map: Record<string, keyof SourceFormState> = {
    provider: 'provider',
    program: 'program',
    geography: 'geography',
    coverage: 'coverage',
    topics: 'topics',
    access: 'accessType',
    license: 'license',
    relevance: 'notes',
  }
  const out = new Set<keyof SourceFormState>()
  for (const path of inferred) {
    const field = map[path]
    if (field) out.add(field)
    if (path === 'access') out.add('accessUrl')
  }
  return out
}

/** Look at this link again. Reaches the agency, so it is a POST and limited. */
export async function inspectEntryLink(slug: string): Promise<ProposalResponse> {
  const res = await internalFetch(`/api/library/catalog/${encodeURIComponent(slug)}/inspect`, { method: 'POST' })
  if (!res.ok) throw new Error(await errorMessage(res, `we could not look at that link (${res.status})`))
  invalidateCatalogCache()
  return (await res.json()) as ProposalResponse
}

/** The source block we would propose, from what the last look already found. */
export async function fetchSourceProposal(slug: string): Promise<ProposalResponse> {
  const res = await internalFetch(`/api/library/catalog/${encodeURIComponent(slug)}/proposal`)
  if (!res.ok) throw new Error(await errorMessage(res, `no proposal for this entry yet (${res.status})`))
  return (await res.json()) as ProposalResponse
}

export interface IngestPlanInput {
  plan: IngestPlanName
  mode?: IngestMode
  owner?: string
  note?: string
}

/** Record how this comes in. Admin-only on the server; a non-admin gets 401. */
export async function setIngestPlan(slug: string, input: IngestPlanInput): Promise<IngestPlan> {
  const res = await internalFetch(`/api/library/catalog/${encodeURIComponent(slug)}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `could not save the plan (${res.status})`))
  invalidateCatalogCache()
  return (await res.json()).ingest as IngestPlan
}

/** Copy the whole dataset in. Queued on the server; returns once it started. */
export async function replicateEntryNow(slug: string): Promise<void> {
  const res = await internalFetch(`/api/library/catalog/${encodeURIComponent(slug)}/replicate`, { method: 'POST' })
  if (!res.ok) throw new Error(await errorMessage(res, `could not start the copy (${res.status})`))
  invalidateCatalogCache()
}
