/**
 * Search across everything (P6-6, spec §D).
 *
 * One query, every resource the knowledge base holds, grouped in the
 * held-first order — datasets, pages, analyses, docs, notes, layers, sources —
 * so what the team has vetted comes before what it only points at. The ⌘K
 * palette is the quick version of this; `/search` is the whole answer.
 *
 * The catalog searches what somebody FILED: a title, a description, tags, a
 * provider. When that finds almost nothing (fewer than five rows) the query is
 * put to the Ask index's page chunks as well, and the pages that match are
 * listed under "Inside documents" with the page number — the one case where a
 * search reads the text of a document rather than its filing.
 */
import { internalFetch } from './apiBase'
import {
  entryUrl,
  fetchCatalog,
  organizationLabelOf,
  organizationOf,
  purposeLabelOf,
  purposeOf,
  readinessLine,
  shapeLabelOf,
  shapeOf,
  sourceBadge,
  topicLabelOf,
  topicOf,
  type CatalogEntry,
  type CatalogFilters,
} from './libraryCatalog'
import { entryHref, kindLabel } from './kb'
import { matchesQuery } from './browse'
import {
  layerOrganization,
  layerOrganizationLabel,
  publicLayerShapeLabel,
  publicLayers,
  PUBLIC_LAYER_SHAPE,
} from './publicLayers'
import { topicForLayerCategory } from '@/config/taxonomy'

// --- Groups ------------------------------------------------------------------

/** The held-first order (spec §D.13). Order is meaning here: a reader scanning
 *  down the page meets what we hold before what we point at. */
export const GROUPS = ['Datasets', 'Pages', 'Analyses', 'Docs', 'Notes', 'Layers', 'Sources'] as const
export type GroupName = (typeof GROUPS)[number]

/** The second half of the answer (spec §D.14) — pages of documents rather than
 *  filed rows, so it is named apart from the kinds and always comes last. */
export const INSIDE_DOCUMENTS = 'Inside documents'

/**
 * Which group a catalog kind belongs to.
 *
 * A saved view is an analysis (it is the output of one). A dropped link nobody
 * has filed yet is a document with a job attached, so it rides with the docs
 * rather than becoming an eighth group. A kind this table has never met is
 * something we hold, not something we point at — the same rule the server's
 * `kindRank` follows — so it goes with the documents.
 */
const GROUP_BY_KIND: Record<string, GroupName> = {
  dataset: 'Datasets',
  wiki: 'Pages',
  view: 'Analyses',
  document: 'Docs',
  incoming: 'Docs',
  note: 'Notes',
  layer: 'Layers',
  source: 'Sources',
}

function groupFor(kind: string): GroupName {
  return GROUP_BY_KIND[kind] ?? 'Docs'
}

/** Kinds the readiness verdict is ABOUT: what we hold, what we point at, what
 *  somebody dropped. Every row carries one, but "ready as a document" says
 *  nothing about a wiki page that IS the knowledge base (same rule as the
 *  entry page's `READINESS_KINDS`). */
const VERDICT_KINDS = ['dataset', 'document', 'incoming', 'source']

export interface SearchItem {
  key: string
  title: string
  href: string
  /** The kind badge: `Source` for a pointer, the plain kind for a held row,
   *  and the page (or the file name) for a match inside a document. */
  badge: string
  /** The server's readiness verdict as one line, where the question applies. */
  verdict: string
  /** Inside-documents rows only: the page the match is on, or null for a
   *  format that has no pages of its own. */
  page?: number | null
  /** Inside-documents rows only: the excerpt around the match. */
  snippet?: string
}

export interface SearchGroup {
  name: GroupName | typeof INSIDE_DOCUMENTS
  items: SearchItem[]
}

export interface SearchOutcome {
  groups: SearchGroup[]
  /** The chips, counted off everything this query matched — see `facetsFor`. */
  facets: SearchFacets
  /** Catalog rows the query matched — what the threshold below reads, and what
   *  a "nothing matched" state is decided on. */
  matched: number
  /** Whether the documents themselves were searched as well. */
  searchedInsideDocuments: boolean
}

// --- Filters -----------------------------------------------------------------

/** The five chips, by their URL keys. `type` is the shape vocabulary (P6-2) —
 *  it is called `type` on screen and in a link, and `shape` in the catalog. */
export const FILTER_KEYS = ['kind', 'organization', 'topic', 'type', 'purpose'] as const
export type FilterKey = (typeof FILTER_KEYS)[number]
export type SearchFilters = Partial<Record<FilterKey, string>>

/** Read the filters off a route's query. A repeated key (`?topic=a&topic=b`)
 *  is an array and asks two questions at once, so it is ignored rather than
 *  half-answered. */
export function filtersFromQuery(query: Record<string, unknown>): SearchFilters {
  const filters: SearchFilters = {}
  for (const key of FILTER_KEYS) {
    const value = query[key]
    if (typeof value === 'string' && value.trim()) filters[key] = value.trim()
  }
  return filters
}

/** A grouped, filtered search as a link — every filter is a URL key, so the
 *  page a researcher is looking at is always something they can send. */
export function searchUrl(q: string, filters: SearchFilters = {}): string {
  const params = new URLSearchParams()
  if (q.trim()) params.set('q', q.trim())
  for (const key of FILTER_KEYS) {
    const value = filters[key]?.trim()
    if (value) params.set(key, value)
  }
  const qs = params.toString()
  return qs ? `/search?${qs}` : '/search'
}

/** One chip: the value a filter would be set to, in plain words, and how many
 *  of this query's rows carry it. */
export interface Facet {
  id: string
  label: string
  count: number
}

export type SearchFacets = Record<FilterKey, Facet[]>

/** What each row says for each filter — the same helpers the Library list and
 *  the datasets browser read, so a chip and a card never disagree. */
const FACET_READERS: Record<FilterKey, (entry: CatalogEntry) => { id: string; label: string }> = {
  kind: entry => ({ id: entry.kind, label: kindLabel(entry.kind) }),
  organization: entry => ({ id: organizationOf(entry), label: organizationLabelOf(entry) }),
  topic: entry => ({ id: topicOf(entry) ?? '', label: topicLabelOf(entry) }),
  type: entry => ({ id: shapeOf(entry), label: shapeLabelOf(entry) }),
  purpose: entry => ({ id: purposeOf(entry) ?? '', label: purposeLabelOf(entry) }),
}

/**
 * The chips, counted off the rows this query matched.
 *
 * Only values something is actually filed under appear: a row of fourteen
 * topics, eleven of them zero, is a worse answer than three. Biggest group
 * first, then alphabetically, so the chip row is stable between searches.
 */
export function facetsFor(entries: CatalogEntry[]): SearchFacets {
  const facets = {} as SearchFacets
  for (const key of FILTER_KEYS) {
    const counts = new Map<string, Facet>()
    for (const entry of entries) {
      const { id, label } = FACET_READERS[key](entry)
      if (!id) continue
      const seen = counts.get(id)
      if (seen) seen.count++
      else counts.set(id, { id, label: label || id, count: 1 })
    }
    facets[key] = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }
  return facets
}

// --- Map layers ---------------------------------------------------------------

/**
 * The public map layers, as catalog rows (P6-20).
 *
 * `/search` promises "layers" in the spec, in its own subtitle and in the
 * `Layers` group it already declares — but it only ever asked the catalog,
 * and a registry layer is not a catalog row. So ⌘K could find Median Home
 * Value and the page it escalates to could not: the quick search beat the
 * thorough one. `/datasets` has merged these rows in since P6-3; this is the
 * same merge, one page later.
 *
 * Shaping a layer as a `CatalogEntry` rather than a parallel row type is what
 * keeps it honest downstream: `groupFor` already files `layer` under `Layers`,
 * `entryHref` already sends it to `/layers/:id` (P5-45 anticipated exactly
 * this), and `FACET_READERS` counts its chips with the same helpers every
 * other row uses — so a layer cannot drift into disagreeing with the chip that
 * claims to count it. The registry ships in the bundle, so none of this costs
 * a request.
 */
function entryForLayer(layer: ReturnType<typeof publicLayers>[number]): CatalogEntry {
  const topic = topicForLayerCategory(layer.category) ?? ''
  return {
    slug: layer.id,
    kind: 'layer',
    title: layer.name,
    // `topicOf` reads a topic id straight back out of `category`, so the
    // layer's own category vocabulary is resolved here, once.
    category: topic,
    status: 'published',
    tags: [],
    meta: { description: layer.description },
    files: [],
    bytes: 0,
    organization: layerOrganization(layer),
    organizationLabel: layerOrganizationLabel(layer),
    shape: PUBLIC_LAYER_SHAPE,
    shapeLabel: publicLayerShapeLabel(),
  } as CatalogEntry
}

/** Every filter, read off the row by the same helpers that count the chips —
 *  so `purpose` (which no layer has) excludes layers without a special case. */
function passesFilters(entry: CatalogEntry, filters: SearchFilters): boolean {
  return FILTER_KEYS.every(key => {
    const want = filters[key]?.trim()
    return !want || FACET_READERS[key](entry).id === want
  })
}

/** The layers this query matches, by the catalog's own word rule. */
function layerEntries(query: string, filters: SearchFilters): CatalogEntry[] {
  return publicLayers()
    .map(entryForLayer)
    .filter(entry => {
      const haystack = [entry.title, entry.meta.description, entry.organizationLabel, entry.shapeLabel].join(' ')
      return matchesQuery(haystack, query) && passesFilters(entry, filters)
    })
}

function catalogFilters(q: string, filters: SearchFilters): CatalogFilters {
  return {
    q,
    kind: filters.kind,
    organization: filters.organization,
    topic: filters.topic,
    shape: filters.type,
    purpose: filters.purpose,
  }
}

// --- Inside documents ---------------------------------------------------------

/** Catalog rows below which the documents themselves are searched too. */
export const TEXT_SEARCH_BELOW = 5

/** One page of one document, as the server scored it. */
export interface TextHit {
  entryId: string
  title: string
  file: string
  page: number | null
  snippet: string
  score: number
}

export async function searchInsideDocuments(q: string, limit?: number): Promise<TextHit[]> {
  const params = new URLSearchParams({ q: q.trim() })
  if (limit) params.set('limit', String(limit))
  const res = await internalFetch(`/api/library/search-text?${params.toString()}`)
  if (!res.ok) throw new Error(`document search failed (${res.status})`)
  const body = await res.json()
  return (body.results ?? []) as TextHit[]
}

/**
 * Where a match inside a document opens: the entry hub's Files tab with the
 * viewer on that file and the page in the hash — the shape `openView` writes
 * (LibraryEntryView) and `pageFromHash` reads (DocumentViewer), so one link
 * works in the in-app text view and in the browser's own PDF viewer.
 *
 * A format with no pages of its own (a .docx is laid out by the reader) opens
 * at the file, with no page anchor to be wrong about.
 */
export function documentPageHref(entryId: string, file: string, page: number | null): string {
  const base = entryUrl(entryId, 'files', { view: file })
  return page == null ? base : `${base}#page=${page}`
}

// --- The search ---------------------------------------------------------------

function itemFor(entry: CatalogEntry): SearchItem {
  return {
    key: `${entry.kind}:${entry.slug}`,
    title: entry.title,
    href: entryHref(entry),
    badge: sourceBadge(entry) ?? kindLabel(entry.kind),
    verdict: entry.readiness && VERDICT_KINDS.includes(entry.kind) ? readinessLine(entry.readiness) : '',
  }
}

function itemForHit(hit: TextHit): SearchItem {
  return {
    key: `text:${hit.entryId}:${hit.file}:${hit.page ?? ''}`,
    title: hit.title,
    href: documentPageHref(hit.entryId, hit.file, hit.page),
    badge: hit.page == null ? hit.file : `page ${hit.page}`,
    verdict: '',
    page: hit.page,
    snippet: hit.snippet,
  }
}

function groupEntries(entries: CatalogEntry[]): SearchGroup[] {
  const byGroup = new Map<GroupName, SearchItem[]>()
  for (const entry of entries) {
    const name = groupFor(entry.kind)
    const items = byGroup.get(name) ?? []
    items.push(itemFor(entry))
    byGroup.set(name, items)
  }
  // The server already ordered the rows (held first, newest inside each rank);
  // grouping keeps that order inside a group and states it between them.
  return GROUPS.filter(name => byGroup.has(name)).map(name => ({ name, items: byGroup.get(name)! }))
}

/**
 * The whole answer for one query.
 *
 * The documents are searched only when the filed rows are thin AND no chip is
 * narrowing the list: the text route knows nothing about organizations or
 * topics, so showing its rows under an active filter would quietly contradict
 * the filter. A failed document search costs the reader nothing — the filed
 * rows are still the answer.
 */
export async function searchEverything(q: string, filters: SearchFilters = {}): Promise<SearchOutcome> {
  const query = q.trim()
  if (!query) return { groups: [], facets: facetsFor([]), matched: 0, searchedInsideDocuments: false }

  const filtered = FILTER_KEYS.some(key => !!filters[key]?.trim())
  // The chips are counted off everything the QUERY matched, not off what the
  // chips have already narrowed it to — otherwise picking a topic would hide
  // every other topic and the only way back would be Clear. Unfiltered the
  // two asks are the same request, and the catalog cache answers the second.
  const [entries, all] = await Promise.all([
    fetchCatalog(catalogFilters(query, filters)),
    filtered ? fetchCatalog({ q: query }) : Promise.resolve(null),
  ])
  // P6-20: the registry rows join the catalog rows before grouping, so they
  // land in the `Layers` group the order already reserves for them. Facets are
  // counted off the unfiltered match for the same reason the catalog half is.
  const groups = groupEntries([...entries, ...layerEntries(query, filters)])
  const facets = facetsFor([...(all ?? entries), ...layerEntries(query, {})])
  // `matched` stays a count of CATALOG rows: it is what decides whether the
  // documents are worth searching, and three map layers are no reason to stop
  // looking inside the documents. The empty state reads `groups`, not this.
  if (entries.length >= TEXT_SEARCH_BELOW || filtered) {
    return { groups, facets, matched: entries.length, searchedInsideDocuments: false }
  }

  const hits = await searchInsideDocuments(query).catch(() => [] as TextHit[])
  if (hits.length) groups.push({ name: INSIDE_DOCUMENTS, items: hits.map(itemForHit) })
  return { groups, facets, matched: entries.length, searchedInsideDocuments: true }
}
