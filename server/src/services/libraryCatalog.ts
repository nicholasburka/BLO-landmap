import { libraryQuery } from './libraryDb.js'
import { listFiles, getFile, putFile, deleteFile, isBucketEnabled } from './libraryBucket.js'
import { parseSourceMeta, sourceDropWarning, type SourceMeta } from './sourceMeta.js'
import { markReplicatedPlans, parseIngestPlan } from './ingestPlan.js'
import { readinessOf, type Readiness } from './readiness.js'
import siteLayerRegistry from '../prompt/siteLayers.generated.json' with { type: 'json' }
import {
  CATEGORY_IDS,
  isPurpose,
  isTopic,
  isTopicable,
  normalizeCategory,
  normalizeSourceTopics,
  normalizeTags,
  purposeFor,
  isShape,
  shapeLabel,
  stateCodeFor,
  topicFor,
} from './taxonomy.js'
import { isOrganizationId, organizationForMeta, organizationLabel } from './organizations.js'
import { fieldValueOf, hasUnverifiedValue, provenanceReport } from './provenance.js'
import {
  WORKING_SET_CATEGORY,
  WORKING_SET_KIND,
  readWorkingSet,
  workingSetManifest,
} from './workingSetMeta.js'
import { deriveShape, isShapedKind, shapeFromManifest, type ShapeId } from './shape.js'
import { coverageFromManifest, coverageMatches, deriveCoverage, asCoverage, type Coverage } from './coverage.js'
import { datesFromManifest, deriveDates, type DataDates } from './dataDates.js'

/**
 * Catalog index for the internal data library (P5-8).
 *
 * Files are the truth; this module rebuilds the Postgres index by walking
 * the bucket tree and reading each entry's meta.json — a re-indexing job,
 * not a migration. Only file-backed kinds are cleared on reindex; every kind
 * we have is file-backed — P5-12 resolved the old hedge by making text-only
 * notes bucket-backed too (body inside the manifest), so nothing in the
 * catalog can outlive a rebuild.
 */

const FILE_BACKED_KINDS: Record<string, string> = {
  'library/datasets/': 'dataset',
  'library/documents/': 'document',
  // P5-10: raw uploads. Slug is the upload uuid; meta.json is the upload
  // manifest (uploader, timestamp, filing-form fields), so reindex rebuilds
  // incoming entries from the bucket exactly like datasets/documents.
  'library/incoming/': 'incoming',
  // P5-12: text-only entries. The manifest carries the note body and
  // creator attribution, so notes survive reindex from the bucket alone.
  'library/notes/': 'note',
  // P5-56: data sources — datasets we index but do NOT hold (EPA, FEMA, a
  // state agency). Manifest-only by nature; a sample or data dictionary may
  // sit beside it. Walked after notes and before wiki so a slug shared with a
  // page warns and loses, exactly like every other kind.
  'library/sources/': 'source',
  // P7-1: working sets — the compound data object an analysis runs against
  // (the datasets in it, the sites that anchor it, P7-5's derived columns).
  // Walked LAST, so a slug a set shares with a real dataset is the dataset's.
  'library/working-sets/': 'working-set',
}

/** Bucket prefix for the source kind — the filing route moves entries here. */
export const SOURCES_PREFIX = 'library/sources/'

/** Hooks run at the end of every successful reindex (P5-40/41: derived
 *  caches that must follow the catalog). Synchronous and best-effort. */
const reindexHooks: Array<() => void> = []
export function onReindex(hook: () => void): void {
  reindexHooks.push(hook)
}

/**
 * P5-88: the catalog's generation — a counter bumped by every write that can
 * change a row, so a derived read can cache its answer and know when the
 * answer expired.
 *
 * Every row in `library_catalog` is written by `insertCatalogRow` below —
 * uploads, filings, notes, saved views, wiki upserts, the manifest patches in
 * entryManifest/documentPull/linkFetchQueue/placeFetch (each a DELETE
 * followed by `indexFileBackedEntry`), and the reindex itself. Nothing else
 * in the server inserts one. So bumping here is complete coverage, and a
 * cache keyed on this number cannot outlive the rows it was built from —
 * including across a test's DB swap, because a fresh store has no rows until
 * something inserts one and bumps.
 */
let catalogGeneration = 0

export function catalogGenerationNow(): number {
  return catalogGeneration
}

/** Bump the generation — every derived cache keyed on it recomputes next
 *  time it is asked. */
export function bumpCatalogGeneration(): void {
  catalogGeneration++
}

/** Lifecycle statuses for datasets/documents (P5-13, spec "Data lifecycle"):
 *  needs-review → in-cleaning → published (or archived). The catalog shows
 *  all; only `published` datasets become internal map layers (P5-18). */
export const DATASET_STATUSES = ['needs-review', 'in-cleaning', 'published', 'archived'] as const

export interface CatalogEntryRow {
  slug: string
  kind: string
  title: string
  category: string
  status: string
  tags: string[]
  meta: Record<string, unknown>
  files: { key: string; size: number }[]
  bytes: number
  /** ISO time the entry's content last changed: the newest bucket object
   *  among its files, falling back to the index time when the bucket reports
   *  none. Drives the "recently updated" lists (UX pass) — the reindex time
   *  itself would make every entry "just now" after each rebuild. */
  updatedAt?: string
  /**
   * P5-82: what this entry is ready to be used as, and whether a place report
   * can run on it. Computed by `readinessOf` every time a row is READ and
   * never stored — a verdict is a view over the row's own files and manifest,
   * so it cannot go stale and no reindex is needed to correct one.
   */
  readiness?: Readiness
  /**
   * P6-1: who published it — a vocabulary id, or an unknown publisher's own
   * text as its own group. Stored in the manifest at reindex (`meta.organization`)
   * and promoted onto the row on every read, beside its label, so a list, a
   * facet and a filter all read one field.
   */
  organization?: string
  organizationLabel?: string
  /** P6-2: what kind of thing it is — areas, points, statistics, records.
   *  Derived at reindex (it can need a file read) and stored the same way. */
  shape?: string
  shapeLabel?: string
  /**
   * P6-19: how much ground it covers — the scope, the states, and the words.
   * Derived at reindex from the same file read the shape costs, stored in the
   * manifest and promoted here. ABSENT, never a scope, when nothing could be
   * worked out: a dataset we cannot place must not answer "what is
   * nationwide?", and the admin queue counts the gap instead.
   */
  coverage?: Coverage
  /**
   * P7-10: WHEN the data is from — the period it covers, when the publisher
   * put it out, and when we pulled it. Folded on every read out of the
   * manifest's own `dates:` block, the layer block's `year` and our fetch
   * records, and promoted here beside `coverage` for the same reason: the list
   * projection cuts the manifest down, and the legend, the needs-a-look row
   * and `search_library` must not each have to ask for the whole thing.
   *
   * ABSENT when the entry says nothing. Deliberately NOT `updatedAt`, which
   * says when the bytes last moved — re-pushing a 2019 file would make it read
   * as 2026 data, which is the misreading this field exists to stop.
   */
  dates?: DataDates
}

/** The later of two optional ISO times. */
function newerOf(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return Date.parse(b) > Date.parse(a) ? b : a
}

/** Normalise a DB row: numeric bytes, ISO updatedAt (pg returns Date, pg-mem
 *  may return a string), and the P5-82 readiness verdict — the one place every
 *  read of the catalog passes through, so no consumer can be handed a row
 *  without one. */
function withUpdatedAt(row: CatalogEntryRow & { updated_at?: unknown }): CatalogEntryRow {
  const { updated_at, ...rest } = row
  const updatedAt =
    updated_at instanceof Date ? updated_at.toISOString() : typeof updated_at === 'string' ? new Date(updated_at).toISOString() : undefined
  const entry = { ...rest, bytes: Number(rest.bytes), ...(updatedAt ? { updatedAt } : {}) }
  const organization = storedOrganization(entry)
  const shape = storedShape(entry)
  const coverage = storedCoverage(entry)
  const dates = storedDates(entry)
  return {
    ...entry,
    readiness: readinessOf(entry),
    // P6-1/P6-2/P6-19: stored in the manifest, shown as id + plain words.
    // Promoted here rather than left in the meta because the list projection
    // cuts the manifest down and a browser that groups by publisher — or asks
    // what we hold for Georgia — must not be one of the callers that has to
    // ask for the whole thing.
    ...(organization ? { organization, organizationLabel: organizationLabel(organization) } : {}),
    ...(shape ? { shape, shapeLabel: shapeLabel(shape) } : {}),
    ...(coverage ? { coverage } : {}),
    ...(dates ? { dates } : {}),
  }
}

/**
 * P7-10: the dates a row carries.
 *
 * The same fold `storedCoverage` does on the spot, for the same reason: a
 * person's `dates:` block works the moment it is pushed, a layer block's
 * `year` is read for free, and our own fetch records are already in the
 * manifest. Only a held table's own year column needs the reindex, because
 * only it needs the file — and a reindex stores that answer into `meta.dates`,
 * where this reads it back as a stated one.
 */
function storedDates(row: Pick<CatalogEntryRow, 'kind' | 'meta' | 'files' | 'slug'>): DataDates | null {
  if (!isShapedKind(row.kind)) return null
  const dates = datesFromManifest({
    kind: row.kind,
    meta: row.meta,
    files: (row.files ?? []).map(f => basenameInEntry(f.key)),
    slug: row.slug,
  })
  const out: DataDates = {}
  if (dates.covers) out.covers = dates.covers
  if (dates.published) out.published = dates.published
  if (dates.fetched) out.fetched = dates.fetched
  return Object.keys(out).length ? out : null
}

/**
 * P6-1: the organization a row carries.
 *
 * Reindex writes it into `meta.organization`; a row that predates the write —
 * or one inserted by a path that never reads the bucket — is folded on the
 * spot, which costs one string comparison and means the field is never simply
 * absent. The two answers are the same function over the same manifest.
 */
function storedOrganization(row: Pick<CatalogEntryRow, 'meta'>): string {
  return organizationForMeta(row.meta)
}

/** P6-2: the shape a row carries. Unlike the organization this cannot be
 *  recomputed cheaply (a held table's columns are in the bucket), so only the
 *  part the manifest can answer is filled in for a row indexed without one. */
function storedShape(row: Pick<CatalogEntryRow, 'kind' | 'meta'>): string {
  const stored = row.meta?.shape
  if (typeof stored === 'string' && isShape(stored)) return stored
  if (!isShapedKind(row.kind)) return ''
  return shapeFromManifest({ kind: row.kind, meta: row.meta }) ?? ''
}

/**
 * P6-19: the coverage a row carries.
 *
 * The object a reindex stored is the answer and is taken as read. Everything
 * else is the same fold on the spot that the organization gets: a human's
 * `coverage: state:GA` works the moment it is pushed, and a source's own block
 * is re-read for free — so a row inserted by a path that never looked at the
 * bucket still answers the question. Only a held table's own GEOIDs need the
 * reindex, because only they need the file.
 */
function storedCoverage(row: Pick<CatalogEntryRow, 'kind' | 'meta'>): Coverage | null {
  const stored = row.meta?.coverage
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) return asCoverage(stored as Record<string, unknown>)
  if (!isShapedKind(row.kind)) return null
  return coverageFromManifest({ kind: row.kind, meta: row.meta })
}

function parseMeta(buf: Buffer, slug: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(buf.toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    /* fall through */
  }
  console.warn(`[library] malformed meta.json for "${slug}" — indexing with defaults.`)
  return {}
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * P5-63: a manifest's `category` and `tags`, spoken in the one vocabulary.
 *
 * Manifests are hand-written and have been for months, so the words in them
 * are the words people typed: `demographics` beside `demographic`,
 * `environmental-risk` beside `environment`, `Flooding` beside `flood`. The
 * alias table folds those together at index time so every filter, facet and
 * count downstream compares one spelling with one spelling.
 *
 * A category the taxonomy does not know is KEPT — the vocabulary is allowed
 * to grow, and dropping somebody's word would lose it — and warned about
 * exactly once, naming the entry so it can be fixed with `library retag`.
 */
function applyTaxonomy(entry: CatalogEntryRow): void {
  entry.tags = normalizeTags(entry.tags)
  const category = normalizeCategory(entry.category ?? '')
  entry.category = category
  if (!category || !isTopicable(entry.kind)) return
  if (isTopic(category) || isPurpose(category)) return
  console.warn(
    `[library] "${entry.slug}" has category "${category}", which is not one of ${CATEGORY_IDS.join(', ')} — ` +
      'kept as-is; run `npm run library -- retag` to see what it should be',
  )
}

/**
 * P7-1: normalise a working set's manifest, and recompute the line that
 * describes it.
 *
 * `applySourceBlock`'s grain, and for the same reason: the manifest is
 * hand-editable and hand-pushable, so the one place that turns a raw block
 * into a clean one is here, and the row a route writes has to be spelled
 * identically to the row the next reindex rebuilds. The description counts the
 * members, so recomputing it is what stops a row claiming "11 datasets" after
 * somebody edited the manifest down to nine.
 */
function applyWorkingSet(entry: CatalogEntryRow): void {
  if (entry.kind !== WORKING_SET_KIND) return
  const doc = readWorkingSet(entry.meta, entry.slug)
  entry.meta = { ...entry.meta, ...workingSetManifest(doc) }
  entry.title = doc.title
  entry.category = WORKING_SET_CATEGORY
}

/**
 * P6-1: file the entry under a publisher.
 *
 * The answer is written back into the manifest the row carries, so every later
 * read — a filter, a facet, a group heading — compares one stored word rather
 * than folding a provider string again. An entry that names nobody loses the
 * key entirely rather than carrying an empty one.
 */
function applyOrganization(entry: CatalogEntryRow): void {
  const organization = organizationForMeta(entry.meta)
  if (organization) entry.meta = { ...entry.meta, organization }
  else if (entry.meta.organization !== undefined) {
    const { organization: _blank, ...rest } = entry.meta
    entry.meta = rest
  }
}

/**
 * P6-2 and P6-19: file the entry under a shape and a coverage.
 *
 * `readFile` is the one part that touches the bucket, and only for a held
 * table whose manifest says nothing — a source, a map layer, a stated `shape:`
 * and a stated `coverage:` are all answered from the manifest already in hand.
 *
 * **One function because it is one read.** Both derivations want the same file
 * (`pickShapeFile` and `pickCoverageFile` are the same rule over the same
 * names), and pulling a 20 MB table across the wire twice to answer two
 * questions about it would double the cost of every reindex. The reader below
 * hands the text out once however many derivations ask for it.
 *
 * A coverage that cannot be worked out REMOVES the key rather than storing a
 * scope — same as a blank organization, and for a stronger reason: a row
 * carrying `coverage: national` by default would answer "what is nationwide?"
 * with a guess and vanish from the queue that would get it fixed.
 */
async function applyShapeAndCoverage(entry: CatalogEntryRow, readFile?: ShapeFileReaderForEntry): Promise<void> {
  if (!isShapedKind(entry.kind)) return
  const names = entry.files.map(f => basenameInEntry(f.key))
  const input = { kind: entry.kind, meta: entry.meta, files: names, slug: entry.slug }
  const read = readFile ? readOncePerEntry(entry, readFile) : undefined
  const shape: ShapeId = await deriveShape(input, read)
  const coverage = await deriveCoverage(input, read)
  // P7-10: the third question of the same file read (P6-19's rule — a 20 MB
  // table must not cross the wire twice to answer two questions about it, and
  // three is the same argument). Only `covers` can need the file; the other
  // two dates are read off the manifest and are folded again on every read by
  // `storedDates`, so this write is the year column and nothing else.
  const dates = await deriveDates(input, read)
  entry.meta = { ...entry.meta, shape }
  if (coverage) entry.meta = { ...entry.meta, coverage }
  else if (entry.meta.coverage !== undefined) {
    const { coverage: _unplaceable, ...rest } = entry.meta
    entry.meta = rest
  }
  if (Object.keys(dates).length) entry.meta = { ...entry.meta, dates }
  else if (entry.meta.dates !== undefined) {
    const { dates: _undated, ...rest } = entry.meta
    entry.meta = rest
  }
}

type ShapeFileReaderForEntry = (entry: CatalogEntryRow, fileName: string) => Promise<string | null>

/** One file, read once, however many derivations ask for it. */
function readOncePerEntry(entry: CatalogEntryRow, readFile: ShapeFileReaderForEntry): (fileName: string) => Promise<string | null> {
  const seen = new Map<string, Promise<string | null>>()
  return fileName => {
    const cached = seen.get(fileName)
    if (cached) return cached
    const reading = readFile(entry, fileName)
    seen.set(fileName, reading)
    return reading
  }
}

/** Basename inside the entry folder: `library/datasets/<slug>/<name>`. */
function basenameInEntry(key: string): string {
  return key.split('/').slice(3).join('/') || key
}

/**
 * The bucket read behind `applyShapeAndCoverage`, capped.
 *
 * A schema question does not justify pulling a hundred-megabyte table across
 * the wire, and the browse limit is already the size past which we tell people
 * to download a file instead — so the same cap applies here and an oversized
 * table simply stays `records`, with no coverage, until somebody writes
 * `shape:` or `coverage:` in its manifest.
 *
 * `fresh`, like every manifest read in the walk above, and newly load-bearing
 * in P6-19. `getFile` otherwise answers from the local mirror, which is a
 * cache of whole objects by key and has no idea a push replaced one — so a
 * cleaned table pushed over its old self would have been re-indexed from the
 * copy already on disk, and its coverage derived from the GEOIDs it had
 * BEFORE the geocoder ran. A reindex exists to rebuild from the files as they
 * now are; this is one of the files.
 */
const SHAPE_READ_MAX_BYTES = 25 * 1024 * 1024

const readEntryFileForShape: ShapeFileReaderForEntry = async (entry, fileName) => {
  const file = entry.files.find(f => basenameInEntry(f.key) === fileName)
  if (!file || file.size > SHAPE_READ_MAX_BYTES) return null
  return (await getFile(file.key, { fresh: true })).toString('utf8')
}

/** Walk the bucket tree and rebuild the catalog index. Returns counts. */
export interface ReindexResult {
  indexed: number
  collisions: number
}

let inFlightReindex: Promise<ReindexResult> | null = null

/** A reindex walks the whole bucket, then DELETEs every file-backed row and
 *  reinserts. Two overlapping runs (a CLI push while someone hits Reindex)
 *  race one run's delete against the other's inserts — a duplicate-slug
 *  crash — and double the bucket reads for an identical result. Callers that
 *  arrive mid-run get the run already in progress. */
export function reindexCatalog(): Promise<ReindexResult> {
  if (!inFlightReindex) {
    inFlightReindex = runReindex().finally(() => {
      inFlightReindex = null
    })
  }
  return inFlightReindex
}

async function runReindex(): Promise<ReindexResult> {
  if (!isBucketEnabled()) throw new Error('library bucket is not initialized')

  // Group files into (kind, slug) entries.
  const entries = new Map<string, CatalogEntryRow>()
  for (const file of await listFiles('library/')) {
    // P5-14: wiki pages are FLAT files (library/wiki/<slug>.md), not
    // entry-per-directory like the kinds below. Strays (non-.md, bad names)
    // are ignored — the wiki tree is hand-editable via the sync CLI.
    if (file.key.startsWith(WIKI_PREFIX)) {
      const match = file.key.slice(WIKI_PREFIX.length).match(/^([a-z0-9][a-z0-9-]*)\.md$/)
      if (!match) continue
      const slug = match[1]
      entries.set(`wiki:${slug}`, {
        slug,
        kind: 'wiki',
        title: slug,
        // Wiki pages are the knowledge base itself, not a category of it
        // (Nick, 2026-09-03) — kind already distinguishes them.
        category: '',
        status: 'published',
        tags: [],
        meta: {},
        files: [{ key: file.key, size: file.size }],
        bytes: file.size,
        updatedAt: file.lastModified,
      })
      continue
    }
    // P5-16: saved views are flat JSON snapshots (library/views/<slug>.json),
    // same shape as wiki. Strays are ignored; title/meta come from the
    // document itself in the fresh-read pass below.
    if (file.key.startsWith(VIEWS_PREFIX)) {
      const match = file.key.slice(VIEWS_PREFIX.length).match(/^([a-z0-9][a-z0-9-]*)\.json$/)
      if (!match) continue
      const slug = match[1]
      entries.set(`view:${slug}`, {
        slug,
        kind: 'view',
        title: slug,
        category: 'views',
        status: 'published',
        tags: [],
        meta: {},
        files: [{ key: file.key, size: file.size }],
        bytes: file.size,
        updatedAt: file.lastModified,
      })
      continue
    }
    for (const [prefix, kind] of Object.entries(FILE_BACKED_KINDS)) {
      if (!file.key.startsWith(prefix)) continue
      const slug = file.key.slice(prefix.length).split('/')[0]
      if (!slug) continue
      const mapKey = `${kind}:${slug}`
      let entry = entries.get(mapKey)
      if (!entry) {
        entry = { slug, kind, title: slug, category: '', status: 'needs-review', tags: [], meta: {}, files: [], bytes: 0 }
        entries.set(mapKey, entry)
      }
      entry.files.push({ key: file.key, size: file.size })
      entry.bytes += file.size
      entry.updatedAt = newerOf(entry.updatedAt, file.lastModified)
    }
  }

  const mentions = new Map<string, CatalogRef[]>()

  // Read each entry's meta.json FRESH from the bucket — a CLI push (or
  // rclone) can change a manifest behind the running server's back, and the
  // mirror cache would otherwise serve the stale copy forever (found live
  // during P5-13 verification). Fresh reads also repair the mirror copy.
  for (const entry of entries.values()) {
    // Wiki pages carry no manifest — the title IS the markdown's first
    // heading, so read the page itself (fresh, same staleness rule).
    if (entry.kind === 'wiki') {
      const md = (await getFile(entry.files[0].key, { fresh: true })).toString('utf8')
      entry.title = extractWikiTitle(md, entry.slug)
      // P5-37: backlink index — which entries this page links or embeds.
      for (const target of extractWikiMentions(md)) {
        const list = mentions.get(target) ?? []
        if (!list.some(m => m.slug === entry.slug)) list.push({ slug: entry.slug, title: entry.title })
        mentions.set(target, list)
      }
      continue
    }
    // Views: the snapshot document IS the manifest. Malformed JSON indexes
    // with slug-fallback title (a hand-pushed broken file shouldn't kill the
    // whole rebuild).
    if (entry.kind === 'view') {
      const doc = parseViewDoc(await getFile(entry.files[0].key, { fresh: true }), entry.slug)
      if (doc) {
        if (typeof doc.name === 'string' && doc.name) entry.title = doc.name
        entry.meta = savedViewMeta(doc)
      }
      continue
    }
    const metaFile = entry.files.find(f => f.key.endsWith('/meta.json'))
    if (!metaFile) continue
    const meta = parseMeta(await getFile(metaFile.key, { fresh: true }), entry.slug)
    entry.meta = meta
    if (typeof meta.title === 'string' && meta.title) entry.title = meta.title
    if (typeof meta.category === 'string') entry.category = meta.category
    if (typeof meta.status === 'string' && meta.status) entry.status = meta.status
    entry.tags = asStringArray(meta.tags)
    applyTaxonomy(entry)
    applySourceBlock(entry)
    applyWorkingSet(entry)
    // P6-1/P6-2, after the source block: both read it, and the cleaned block
    // is the one every other consumer sees.
    applyOrganization(entry)
    await applyShapeAndCoverage(entry, readEntryFileForShape)
  }

  // Full rebuild of the file-backed kinds. Sequential delete+insert (not a
  // transaction) keeps pg-mem compatibility; the index is rebuildable at any
  // time, so a failed run mid-way is repaired by simply running it again.
  // Slugs are globally unique in library_catalog (wiki links, embeds, and
  // /library/<slug> all key on the bare slug). A hand-pushed tree can still
  // reuse one across kinds — e.g. a document and a wiki page both called
  // "why-five-million" (found during the first content load). Skip the
  // later one with a log line instead of letting the INSERT kill the whole
  // rebuild; precedence is the walk order (datasets, documents, incoming,
  // notes, then wiki pages, then views).
  const bySlug = new Map<string, CatalogEntryRow>()
  const collisions: string[] = []
  for (const entry of entries.values()) {
    const winner = bySlug.get(entry.slug)
    if (winner) {
      collisions.push(`"${entry.slug}": ${entry.kind} skipped, ${winner.kind} kept`)
      continue
    }
    bySlug.set(entry.slug, entry)
  }
  for (const line of collisions) console.warn(`[library] slug collision — ${line} (rename one of them and reindex)`)
  // Attach the computed backlinks (P5-37). Stored in the row's meta so the
  // entry page can list "Mentioned in" without scanning pages at read time.
  for (const entry of bySlug.values()) {
    const list = mentions.get(entry.slug)
    entry.meta = { ...entry.meta, mentionedBy: list ? list.sort((a, b) => a.title.localeCompare(b.title)) : [] }
  }
  for (const entry of bySlug.values()) {
    const target = supersededBySlug(entry.meta)
    if (target && !bySlug.has(target)) {
      console.warn(`[library] "${entry.slug}" is supersededBy "${target}", which does not exist — fix the manifest and reindex`)
    }
  }
  // P5-59: a `replicate` plan is done the moment a dataset turns up whose
  // lineage names the entry. Nick's manual path ends in a push and a reindex,
  // so this is exactly where that news arrives. Computed from the two
  // manifests we have just read rather than stored, so deleting the dataset
  // correctly reopens the plan.
  markReplicatedPlans(bySlug.values())

  await libraryQuery(
    `DELETE FROM library_catalog WHERE kind IN ('dataset', 'document', 'incoming', 'note', 'source', 'wiki', 'view', 'working-set')`,
  )
  // A reindex that finds an EMPTY bucket inserts nothing, so the bump every
  // insert carries would never happen — and the caches keyed on the
  // generation would keep answering from the tree that just disappeared.
  bumpCatalogGeneration()
  for (const entry of bySlug.values()) {
    await insertCatalogRow(entry)
  }
  // Derived caches (search index, kb config, …) rebuild after every reindex.
  // Registered by their own modules so this function stays ignorant of them.
  for (const hook of reindexHooks) {
    try {
      hook()
    } catch (err: any) {
      console.warn(`[library] reindex hook failed: ${err?.message || err}`)
    }
  }
  return { indexed: bySlug.size, collisions: collisions.length }
}

/**
 * P5-56: replace a raw `source` OBJECT with the cleaned block, warning ONCE
 * per entry about everything thrown away. The entry is indexed either way — a
 * typo in one field must not cost us the source.
 *
 * A plain-STRING `source` is left exactly as it is: datasets have carried
 * provenance prose there since the first content load ("DC Open Data, 2024"),
 * and that is not this block.
 */
function applySourceBlock(entry: CatalogEntryRow): void {
  const raw = entry.meta.source
  if (raw === undefined || raw === null || typeof raw === 'string') return
  const { source, dropped } = parseSourceMeta(raw)
  if (dropped.length) console.warn(sourceDropWarning(entry.slug, dropped))
  if (source) {
    // P5-63: a source's topics speak the same vocabulary as everything else
    // wherever they name one of its words; the publisher's own prose survives.
    const topics = source.topics?.length ? normalizeSourceTopics(source.topics) : undefined
    entry.meta = { ...entry.meta, source: topics ? { ...source, topics } : source }
    return
  }
  // Nothing usable (no provider): drop the key rather than ship half a block.
  const { source: _unusable, ...rest } = entry.meta
  entry.meta = rest
}

/** The words a `source` block contributes to catalog search (P5-56): who
 *  publishes it, under what program, about what, with which columns. */
function sourceSearchText(meta: Record<string, unknown> | undefined | null): string[] {
  const raw = meta?.source
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const source = raw as Record<string, unknown>
  const out: string[] = []
  for (const key of ['provider', 'program'] as const) {
    if (typeof source[key] === 'string') out.push(source[key] as string)
  }
  out.push(...asStringArray(source.topics))
  if (Array.isArray(source.fields)) {
    for (const field of source.fields) {
      if (field && typeof field === 'object' && typeof (field as { name?: unknown }).name === 'string') {
        out.push((field as { name: string }).name)
      }
    }
  }
  return out
}

async function insertCatalogRow(entry: CatalogEntryRow): Promise<void> {
  await libraryQuery(
    `INSERT INTO library_catalog (slug, kind, title, category, status, tags, meta, files, bytes, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.slug,
      entry.kind,
      entry.title,
      entry.category,
      entry.status,
      JSON.stringify(entry.tags),
      JSON.stringify(entry.meta),
      JSON.stringify(entry.files),
      entry.bytes,
      // Content time from the bucket walk; rows inserted directly (uploads,
      // filings) are changing right now, so "now" is the honest stamp.
      entry.updatedAt ? new Date(entry.updatedAt) : new Date(),
    ],
  )
  bumpCatalogGeneration()
}

/** Insert one file-backed entry directly, without waiting for a full reindex
 *  (P5-10 uploads, P5-34 link drops, P5-56 sources). The bucket tree remains
 *  the truth — a later reindex reconstructs the identical row from
 *  <kind-prefix>/<slug>/meta.json. */
export async function indexFileBackedEntry(
  kind: string,
  slug: string,
  meta: Record<string, unknown>,
  files: { key: string; size: number }[],
): Promise<void> {
  // P5-63: normalised on the way in, exactly as a reindex would — a row
  // inserted by an upload must not be spelled differently from the same entry
  // after the next rebuild.
  const row: CatalogEntryRow = {
    slug,
    kind,
    title: typeof meta.title === 'string' && meta.title ? meta.title : slug,
    category: typeof meta.category === 'string' ? meta.category : '',
    status: typeof meta.status === 'string' && meta.status ? meta.status : 'needs-review',
    tags: asStringArray(meta.tags),
    meta,
    files,
    bytes: files.reduce((sum, f) => sum + f.size, 0),
  }
  applyTaxonomy(row)
  applyWorkingSet(row)
  // P6-1/P6-2, for the same reason as the normalising above: a row inserted by
  // an upload must not be filed differently from the same entry after the next
  // rebuild.
  applyOrganization(row)
  await applyShapeAndCoverage(row, readEntryFileForShape)
  await insertCatalogRow(row)
}

/** Insert one incoming entry directly (P5-10): the upload is visible in the
 *  catalog immediately, without waiting for a full reindex. */
export async function indexIncomingEntry(
  slug: string,
  meta: Record<string, unknown>,
  files: { key: string; size: number }[],
): Promise<void> {
  await indexFileBackedEntry('incoming', slug, meta, files)
}

export interface FilingUpdates {
  title?: string
  category?: string
  tags?: string[]
  description?: string
  /** P6-8a: the publisher (a vocabulary id) and the shape, as the person
   *  accepted or typed them. The route validates both; '' clears the field
   *  so a reindex derives it again. */
  organization?: string
  shape?: string
  /** P5-56: a block already cleaned by parseSourceMeta. Present ⇒ the entry
   *  becomes kind `source` and its manifest moves to library/sources/. */
  source?: SourceMeta
}

export type FilingResult =
  | { error: 'not-found' | 'wrong-kind' | 'has-files' }
  | { error?: undefined; entry: CatalogEntryRow; kindChangedTo?: string }

const INCOMING_PREFIX = 'library/incoming/'

function metaKeyFor(kind: string, slug: string): string {
  return `${kind === 'source' ? SOURCES_PREFIX : INCOMING_PREFIX}${slug}/meta.json`
}

/** File (or re-file) an incoming entry from the needs-cataloging queue
 *  (P5-11, Example 5): rewrite the bucket manifest with the filing fields
 *  and status needs-review — bucket-first, so a reindex reproduces the
 *  filed entry — then rebuild the catalog row. Upload attribution
 *  (uploadedBy/At, originalFilename…) is preserved by merging. */
export async function fileIncomingEntry(slug: string, updates: FilingUpdates): Promise<FilingResult> {
  const existing = await getCatalogEntry(slug)
  if (!existing) return { error: 'not-found' }
  // P5-56: a source is re-filed here too — "register it now, fill the rest in
  // later" only works if you can come back to it.
  if (existing.kind !== 'incoming' && existing.kind !== 'source') return { error: 'wrong-kind' }

  const kind = updates.source || existing.kind === 'source' ? 'source' : 'incoming'
  const oldMetaKey = metaKeyFor(existing.kind, slug)
  const metaKey = metaKeyFor(kind, slug)
  // A source POINTS at data we do not hold. An incoming entry with a file
  // attached is held data — a document or a dataset, not a source — so refuse
  // rather than shuffle someone's upload between prefixes.
  if (metaKey !== oldMetaKey && existing.files.some(f => f.key !== oldMetaKey)) {
    return { error: 'has-files' }
  }

  const meta: Record<string, unknown> = { ...existing.meta }
  if (updates.title !== undefined && updates.title) meta.title = updates.title
  if (updates.category !== undefined) meta.category = updates.category
  if (updates.tags !== undefined) meta.tags = updates.tags
  if (updates.description !== undefined) {
    if (updates.description) meta.description = updates.description
    else delete meta.description
  }
  if (updates.source) meta.source = updates.source
  for (const field of ['organization', 'shape'] as const) {
    const value = updates[field]
    if (value === undefined) continue
    if (value) meta[field] = value
    else delete meta[field]
  }
  // Filing an upload always means "reviewed enough to look at" (P5-11). An
  // entry that is ALREADY a source keeps the status it earned — editing a
  // published source must not quietly demote it.
  if (existing.kind === 'incoming') meta.status = 'needs-review'

  const metaJson = JSON.stringify(meta, null, 2)
  await putFile(metaKey, metaJson, 'application/json')
  // Bucket-first, and the tree is the truth: leaving the old manifest behind
  // would resurrect the incoming entry on the next reindex.
  if (metaKey !== oldMetaKey) await deleteFile(oldMetaKey)

  const files =
    metaKey !== oldMetaKey
      ? [{ key: metaKey, size: Buffer.byteLength(metaJson) }]
      : existing.files.map(f => (f.key === metaKey ? { key: f.key, size: Buffer.byteLength(metaJson) } : f))
  // Delete + insert (not UPDATE) mirrors reindex and stays pg-mem-portable.
  await libraryQuery(`DELETE FROM library_catalog WHERE slug = $1`, [slug])
  await indexFileBackedEntry(kind, slug, meta, files)
  const entry = await getCatalogEntry(slug)
  if (!entry) return { error: 'not-found' } // unreachable; satisfies the types
  return { entry, ...(kind !== existing.kind ? { kindChangedTo: kind } : {}) }
}

// --- Text-only entries (P5-12) ---------------------------------------------

/** Statuses an idea moves through (spec line 93). Notes created outside the
 *  ideas category start at needs-review like everything else. */
export const NOTE_STATUSES = ['open', 'planned', 'done'] as const

/** Lowercase, non-alphanumerics → '-', collapsed and trimmed. Returns '' for
 *  titles with nothing sluggable (caller rejects those). Output always
 *  satisfies the bucket's SAFE_KEY charset. */
// A slug is both a URL path and a bucket key segment, so an unbounded
// title must not produce a key the bucket's own guard would later reject.
const SLUG_MAX = 80

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
}

export interface NoteInput {
  title: string
  body: string
  category: string
  tags: string[]
  createdBy: string
  createdById: number | null
}

export type NoteCreateResult =
  | { error: 'bad-title' }
  | { error?: undefined; entry: CatalogEntryRow }

/** Create a text-only entry at library/notes/<slug>/meta.json — body and
 *  attribution live inside the manifest, so a reindex reproduces the note
 *  from the bucket alone. Slug collisions get -2/-3… suffixes (slug is
 *  globally unique in library_catalog). */
export async function createNoteEntry(input: NoteInput): Promise<NoteCreateResult> {
  const base = slugify(input.title)
  if (!base) return { error: 'bad-title' }
  let slug = base
  for (let n = 2; await getCatalogEntry(slug); n++) slug = `${base}-${n}`

  const meta: Record<string, unknown> = {
    title: input.title,
    body: input.body,
    category: input.category,
    status: input.category === 'ideas' ? 'open' : 'needs-review',
    tags: input.tags,
    createdBy: input.createdBy,
    createdById: input.createdById,
    createdAt: new Date().toISOString(),
  }

  // Bucket first: the manifest is the truth, the catalog row just mirrors it.
  const metaKey = `library/notes/${slug}/meta.json`
  const metaJson = JSON.stringify(meta, null, 2)
  await putFile(metaKey, metaJson, 'application/json')

  const row: CatalogEntryRow = {
    slug,
    kind: 'note',
    title: input.title,
    category: input.category,
    status: meta.status as string,
    tags: input.tags,
    meta,
    files: [{ key: metaKey, size: Buffer.byteLength(metaJson) }],
    bytes: Buffer.byteLength(metaJson),
  }
  applyTaxonomy(row)
  applyOrganization(row)
  await insertCatalogRow(row)
  const entry = await getCatalogEntry(slug)
  if (!entry) return { error: 'bad-title' } // unreachable; satisfies the types
  return { entry }
}

export interface NoteUpdates {
  title?: string
  body?: string
  category?: string
  tags?: string[]
  status?: string
}

export type NoteUpdateResult =
  | { error: 'not-found' | 'wrong-kind' | 'bad-status' }
  | { error?: undefined; entry: CatalogEntryRow }

/** Edit a note in place (slug is stable). Status changes are allowlisted to
 *  the idea lifecycle; bucket-first like every other catalog mutation. */
export async function updateNoteEntry(slug: string, updates: NoteUpdates): Promise<NoteUpdateResult> {
  const existing = await getCatalogEntry(slug)
  if (!existing) return { error: 'not-found' }
  if (existing.kind !== 'note') return { error: 'wrong-kind' }
  if (
    updates.status !== undefined &&
    !NOTE_STATUSES.includes(updates.status as (typeof NOTE_STATUSES)[number])
  ) {
    return { error: 'bad-status' }
  }

  const meta: Record<string, unknown> = { ...existing.meta }
  if (updates.title !== undefined && updates.title) meta.title = updates.title
  if (updates.body !== undefined && updates.body) meta.body = updates.body
  if (updates.category !== undefined && updates.category) meta.category = updates.category
  if (updates.tags !== undefined) meta.tags = updates.tags
  if (updates.status !== undefined) meta.status = updates.status

  const metaKey = `library/notes/${slug}/meta.json`
  const metaJson = JSON.stringify(meta, null, 2)
  await putFile(metaKey, metaJson, 'application/json')

  // Delete + insert (not UPDATE) mirrors reindex and stays pg-mem-portable.
  await libraryQuery(`DELETE FROM library_catalog WHERE slug = $1`, [slug])
  const row: CatalogEntryRow = {
    slug,
    kind: 'note',
    title: typeof meta.title === 'string' && meta.title ? meta.title : slug,
    category: typeof meta.category === 'string' ? meta.category : '',
    status: typeof meta.status === 'string' && meta.status ? meta.status : 'needs-review',
    tags: asStringArray(meta.tags),
    meta,
    files: [{ key: metaKey, size: Buffer.byteLength(metaJson) }],
    bytes: Buffer.byteLength(metaJson),
  }
  applyTaxonomy(row)
  applyOrganization(row)
  await insertCatalogRow(row)
  const entry = await getCatalogEntry(slug)
  if (!entry) return { error: 'not-found' } // unreachable; satisfies the types
  return { entry }
}

export interface CatalogFilters {
  q?: string
  /** P5-63: what an entry is ABOUT. Matches the derived topic, so a `research`
   *  brief tagged `land` answers `topic=land` without a manifest edit. */
  topic?: string
  /** P5-63: what an entry is FOR — strategy, research, outreach, ideas. */
  purpose?: string
  /** Kept working as an alias for whichever of the two the word names, so
   *  every `?category=` link written before P5-63 still opens the same list. */
  category?: string
  /** P6-1: who published it. A vocabulary id, or the exact text an unknown
   *  publisher's group is headed with. */
  organization?: string
  /** P6-2: what kind of thing it is — areas, points, statistics, records. */
  shape?: string
  /**
   * P6-19: where it applies. One word, read as either a scope (`national`,
   * `multi-state`, `state`, `county`, `local`), a state (`GA`, `Georgia`,
   * `13`), or `none` for the rows nothing could place. One key because the
   * chip row it backs is one row: "National" and "Georgia" are the same
   * question asked of the same field.
   */
  coverage?: string
  /** P6-19: the explicit form of the same question, which is how MCP and the
   *  chat ask it — `state=GA` matches every row covering Georgia, whether
   *  that is all it covers or one of twenty-six. */
  state?: string
  status?: string
  kind?: string
  tag?: string
  /**
   * P6-5a: who is asking, when that changes what comes back.
   *
   * Only the to-file queue (`kind: incoming`) is scoped: an unfiled drop is
   * shown to the person who dropped it and to admins, and to nobody else —
   * it is somebody's half-finished work, often with their filename and their
   * note on it. Everything else in the catalog is the team's.
   *
   * Absent means "no viewer to scope to", which is the SERVER reading its own
   * catalog — the Ask index, text extraction, the place report, MCP — and
   * those readers see the whole library as they always have. The HTTP list
   * route passes the session's user, so the scope applies exactly where a
   * person is looking.
   */
  viewer?: { username: string; role: string } | null
  /** P5-35: include `archived` rows (hidden by default). */
  includeArchived?: boolean
  /** P5-59: the ingest plan on the entry. `none` means "no plan block at all". */
  plan?: string
  /**
   * P5-59: one row of the admin "to ingest" queue, so a row's count and the
   * list it opens are the same set. `no-plan` (an entry that COULD carry a
   * plan and does not), `replicate-todo`, `unreachable` (the last look at the
   * link failed), `source-failing` (its adapter errored and has not worked
   * since), P5-63's `uncategorised` (nothing on the entry names a topic), and
   * P5-83's `no-summary` (read, but the model pass never produced one), and
   * P6-1's `no-organization` (a dataset or a source whose publisher is not one
   * the vocabulary knows), and P6-19's `no-coverage` (one whose ground nothing
   * could place).
   *
   * P6-33 adds `needs-a-look`, which is the four metadata gaps plus P6-34's
   * `unverified` asked as ONE question — the panel's one row. The per-field
   * keys all still answer, so a link saved before the collapse opens exactly
   * the field it named.
   */
  attention?: string
  /**
   * P5-64. `held-first` (the default) ranks by KIND_RANK and then by recency;
   * `recent` is recency alone — what a list that says "recently updated" means.
   */
  sort?: CatalogSort
  /**
   * P5-88. Send the FULL manifest on every row instead of the list projection
   * (`listRowMeta`). `?full=1` on the route — for a caller that wants whole
   * manifests in bulk (the CLI, a one-off audit) rather than the fields a list
   * is read for.
   *
   * Honoured by `searchCatalogPage`, the function behind the list endpoint.
   * `searchCatalog` itself always returns full manifests: the place report
   * reads `source.access`, the kb index chunks a note's `body`, and text
   * extraction walks `files` — those are server-side readers of whole rows,
   * not a list, and quietly trimming them would break a feature apiece.
   */
  full?: boolean
}

/**
 * Entries the ingest plan is a real decision for: a DROPPED LINK, and nothing
 * else.
 *
 * P5-59, found live: counting sources too put 47 rows behind "no ingest plan
 * yet" for 7 links. A source's plan is already implicit — it is indexed, and
 * fetched on demand when it has an adapter — so nobody is waiting on a
 * decision about it, and a queue row nobody can clear is noise.
 */
function isPlannable(row: CatalogEntryRow): boolean {
  return row.kind === 'incoming' && typeof row.meta?.url === 'string' && !!row.meta.url
}

/**
 * P6-33's roll-up: the four metadata gaps and P6-34's unverified values are
 * one row on the panel and one key here. Counted as DISTINCT entries — an
 * entry missing three fields is one row of work, not three — which falls out
 * of asking it as one predicate rather than summing four.
 */
const ROLLED_UP_ATTENTION = [
  'uncategorised',
  'no-organization',
  'no-coverage',
  'no-answers-line',
  'no-period-covered',
  'no-published-date',
  'no-summary',
  'unverified',
] as const

/** The tag `saveAnswerAsNote` / `saveReportAsNote` write (`ANSWER_NOTE_TAG` in
 *  `src/lib/ask.ts`): this note is the library's own output, kept. */
const GENERATED_NOTE_TAG = 'ask'

function attentionMatches(row: CatalogEntryRow, which: string): boolean {
  const ingest = parseIngestPlan(row.meta?.ingest)
  switch (which) {
    case 'needs-a-look':
      return ROLLED_UP_ATTENTION.some(key => attentionMatches(row, key))
    // P6-34: a model wrote a value and nobody has looked at it. A DERIVED
    // value never lands here — it is re-derived at every reindex and a person
    // "verifying" it adds nothing a re-run would not — and a person's edit
    // removes it permanently. Mirrors the client's `hasUnverifiedValue`.
    case 'unverified':
      return hasUnverifiedValue(row)
    case 'no-plan':
      return isPlannable(row) && !ingest
    case 'replicate-todo':
      return ingest?.plan === 'replicate' && !ingest.done
    case 'unreachable': {
      const inspection = row.meta?.inspection as { kind?: unknown } | undefined
      return !!inspection && typeof inspection === 'object' && inspection.kind === 'unreachable'
    }
    case 'source-failing': {
      const source = row.meta?.source as { lastError?: unknown } | undefined
      return !!source && typeof source === 'object' && !!source.lastError
    }
    // P5-63 "Entries with no topic": neither the category nor any tag says
    // what this is ABOUT, so it is invisible to the topic facet. Only kinds
    // that carry a manifest category are asked — a wiki page IS the knowledge
    // base rather than a category of it, and a saved view's category is a
    // machine word, so counting either would put a row on the queue that
    // nobody could clear.
    case 'uncategorised':
      // A note the library GENERATED and somebody kept — a saved Ask answer
      // or a kept place report, both tagged `ask` — is not waiting to be
      // filed: its subject is the question that was asked, and nobody is
      // going to assign a topic to our own output. A queue that counts what
      // it generates never drains (P5-59's lesson, found again live). Mirrors
      // the client's `isGeneratedNote` in `src/lib/kb.ts`.
      if (row.kind === 'note' && row.tags.includes(GENERATED_NOTE_TAG)) return false
      return isTopicable(row.kind) && !topicFor(row.category, row.tags)
    // P5-83 "read, but not summarised": the model pass recorded that it could
    // not run, or the fetch says the page was read and no suggestion was ever
    // written. The same rule as the client's `modelPassGap`, so the count on
    // the landing and the list this opens are one set.
    case 'no-summary':
      return isReadWithNoSummary(row)
    // P6-1 "Datasets with no organization": a dataset or a source whose
    // publisher string names nobody the vocabulary knows — so the browser
    // heads a group with a provider's raw prose instead of a publisher. Only
    // the two dataset-shaped kinds are asked; a note or a page has no
    // publisher to be missing.
    case 'no-organization':
      return isShapedKind(row.kind) && !isOrganizationId(storedOrganization(row))
    // P6-19 "Datasets with no coverage": a dataset or a source whose ground
    // nothing could work out — no GEOIDs, no coordinates, no source block that
    // says, and nobody has written `coverage:`. Counted here precisely so that
    // the alternative, calling it national, never has to be considered. Only
    // the two dataset-shaped kinds are asked, exactly as above.
    case 'no-coverage':
      return isShapedKind(row.kind) && !storedCoverage(row)
    // P7-7 "Datasets with no answers line": nothing on the entry says what
    // QUESTION it can answer, so Chat can only pick it by subject and place —
    // which is why a place report ran all forty sources (§F.4d). The fifth
    // rolled-up gap rather than a fifth row: P6-33 collapsed these precisely
    // so that this field could land without a near-identical row beside the
    // other four. Only the two dataset-shaped kinds are asked — a document's
    // "what it answers" is its summary.
    case 'no-answers-line':
      return isShapedKind(row.kind) && !fieldValueOf(row, 'whatItAnswers')
    // P7-10 "when is this from?" — TWO keys, because they are two facts.
    // `covers` is the period the data describes and ages into being
    // historical; `published` is when the publisher put it out and ages into
    // being STALE, which is a different and worse thing. A row that read "no
    // dates" would hide which of the two is missing. `fetched` has no key:
    // we work it out ourselves, and most of the library was never fetched
    // from anywhere, so a gap row for it would never drain.
    case 'no-period-covered':
      return isShapedKind(row.kind) && !fieldValueOf(row, 'covers')
    case 'no-published-date':
      return isShapedKind(row.kind) && !fieldValueOf(row, 'published')
    default:
      return true
  }
}

/** A suggestion that actually proposed something — an `unavailable` marker is
 *  not one. Mirrors the client's `hasSuggestion`. */
function hasSuggestion(meta: Record<string, unknown> | undefined): boolean {
  const raw = meta?.suggested
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const suggestion = raw as { title?: unknown; category?: unknown; summary?: unknown; tags?: unknown; error?: unknown }
  if (suggestion.error) return false
  return !!(suggestion.title || suggestion.category || suggestion.summary || (Array.isArray(suggestion.tags) && suggestion.tags.length))
}

/** P5-83: read, and left with an empty summary — which a reader must be able
 *  to tell apart from "never read". */
function isReadWithNoSummary(row: CatalogEntryRow): boolean {
  if (hasSuggestion(row.meta)) return false
  const suggested = row.meta?.suggested as { error?: unknown } | undefined
  const failed = !!suggested && typeof suggested === 'object' && suggested.error === 'unavailable'
  const fetch = row.meta?.fetch as { status?: unknown } | undefined
  const readWithNothingToShow = !suggested && fetch?.status === 'fetched'
  return failed || readWithNothingToShow
}

/**
 * P5-64: what we HOLD ranks before what we only INDEX.
 *
 * The registry outnumbers the held material several times over, so ordering a
 * mixed list by recency alone buried the five datasets under two screens of
 * pointers. One rank, server-side, so every consumer (the Library list, ⌘K,
 * MCP) agrees about what comes first.
 */
export const KIND_RANK: Record<string, number> = {
  dataset: 0,
  // P7-1: a working set is a curated answer to "which datasets, together, for
  // this purpose" — it ranks with the saved views that present it, not behind
  // the registry it points into. A tie breaks on recency.
  'working-set': 1,
  view: 1,
  wiki: 2,
  document: 3,
  note: 4,
  incoming: 5,
  source: 6,
}

/** A kind this table has never met is something we hold, not something we
 *  point at, so it ranks with the documents rather than behind the registry. */
function kindRank(kind: string): number {
  return KIND_RANK[kind] ?? KIND_RANK.document
}

export const CATALOG_SORTS = ['held-first', 'recent'] as const
export type CatalogSort = (typeof CATALOG_SORTS)[number]

const MAX_RESULTS = 200

/** Search the catalog index. Equality filters run in SQL; the free-text and
 *  tag filters run in JS over the (bounded, ≤~10k rows) result — well inside
 *  the spec's 500 ms budget and free of pg-mem/jsonb-operator portability
 *  concerns. */
/** Superseded material is filed as `archived` and hidden by default (P5-35):
 *  the list shows the latest unless the caller asks for archived rows
 *  (explicit `status=archived` or `includeArchived`). `archivedCount` says
 *  how many were hidden under the same other filters, for the UI's toggle. */
export interface CatalogSearchResult {
  entries: CatalogEntryRow[]
  archivedCount: number
}

/**
 * P5-88: the manifest as a LIST row carries it.
 *
 * A catalog list answer was 214 KB, 91 KB of it `meta.source` — field
 * dictionaries, access blocks, licences and update cadences for two dozen
 * agencies, on every page load, read by nothing. The same list also shipped
 * every note's whole body, every inspection's link and document harvest, and
 * every dataset's lineage. A card shows a title, a badge, a provider and a
 * chip.
 *
 * So the list sends what the LIST is read for, and one entry sends
 * everything. The keys below are exactly what the client's list consumers
 * touch — audited against `src/lib/kb.ts` (the attention predicates),
 * `src/lib/libraryCatalog.ts` (`sourceOf`, `fetchStateOf`, `inspectionOf`,
 * `ingestOf`, `linkOf`, `layerIdForEntry`, `modelPassGap`,
 * `fetchViewsUsingLayer`), `LibraryView.vue`, `KnowledgeBaseView.vue`,
 * `GlobalSearch.vue`, `EmbedPicker.vue`, `WikiView.vue`, `AskView.vue`,
 * `PlaceView.vue` — plus `meta.description`, which MCP `search_library`
 * returns for every result.
 *
 * Two rules for whoever changes this:
 *
 * 1. A list consumer that starts reading a new manifest field MUST add it
 *    here, or it will simply be absent in production and present in every
 *    fixture. `listRowMeta.test.ts` names the kept keys so that is a
 *    deliberate edit rather than a surprise.
 * 2. `getCatalogEntry` (and so `GET /api/library/catalog/:slug`) is
 *    untouched — it keeps the full manifest, and it is what the entry page,
 *    the ingest panel and the source form read. `?full=1` on the list is the
 *    escape hatch for a caller that wants whole manifests in bulk.
 *
 * Nested blocks are cut down rather than dropped, because the client's
 * guards read one field and ignore the rest: `sourceOf` needs a non-empty
 * `provider`, `inspectionOf` a known `kind`, `fetchStateOf` a known
 * `status`, `ingestOf` a known `plan`.
 */
export const LIST_ROW_META_KEYS = [
  /** Cards, ⌘K, and every `search_library` result. */
  'description',
  /**
   * P7-7: the one line saying what this data ANSWERS. On a LIST row because
   * `search_library` is assembled from one — the whole point of the field is
   * that a model picking datasets reads it in the result rows rather than
   * after a `get_entry` per candidate — and because the needs-a-look line and
   * the unverified badge are computed per row like every other gap.
   */
  'whatItAnswers',
  /** `linkOf` — the 🔗 host line, `isUnfetchedLink`, `isPlannable`. */
  'url',
  /** `layerIdForEntry` reads PRESENCE only (the block's plumbing never
   *  leaves the server), so ⌘K can offer "Show on map". Small; kept whole. */
  'layer',
  /** P5-35's "superseded" badge. One slug. */
  'supersededBy',
  /** Saved views (`kind=view`): ⌘K's "map view / table view" line, and
   *  `fetchViewsUsingLayer`, which is a LIST call made from the entry page
   *  to answer "which saved views use this layer?" — it needs the whole
   *  `layers` array, not a count. */
  'type',
  /** A saved view's table and its row count — one string and one number, read
   *  by the views route's own tests and cheap enough for a card to show. */
  'dataset',
  'resultCount',
  'layers',
  'savedBy',
  'savedAt',
  /**
   * P7-1: the working set a view presents, and a working set's own members.
   *
   * `workingSet` on a VIEW row is one slug — absent/'' means the view is
   * ad-hoc, which is a permanent first-class state and not a gap. `datasets`,
   * `sites` and `purpose` on a WORKING-SET row are the set itself: the
   * datasets browser answers "which sets is this dataset in?" off the one
   * catalog query the page already makes, rather than a request per set.
   * `layers` above is shared with the saved views, which ask the same
   * question of the same field.
   */
  'workingSet',
  'datasets',
  'sites',
  'purpose',
  /**
   * P6-34: how each remediated value got there. A list row has to be able to
   * say "a model wrote this and nobody has looked" — that is the `unverified`
   * half of P6-33's one attention row, and the browsers compute it per row
   * through `hasUnverifiedValue`. Kept whole: a record is a mechanism, a date,
   * the value, one evidence sentence and the verification, and the list reads
   * all five.
   */
  'provenance',
  /** Trimmed blocks — see the constants below. */
  'source',
  'fetch',
  'suggested',
  'inspection',
  'ingest',
] as const

/** `provider` is the gate the client's `sourceOf` opens on; `lastError` is the
 *  `source-failing` attention row (presence only, but it is three short
 *  fields). Everything else about a source — access methods, field
 *  dictionary, licence, cadence, relevance, replication — is the entry page's. */
const LIST_SOURCE_KEYS = ['provider', 'lastError'] as const
/** `status` is the fetch chip and its CSS class; `at` is `modelPassGap`'s
 *  `readAt`. `bytes`/`name` are the entry page's file line. */
const LIST_FETCH_KEYS = ['status', 'at'] as const
/** `kind` is `inspectionFailed` ("could not be reached"); `checkedAt` is
 *  `modelPassGap`'s first choice of `readAt`. The harvest — links, documents,
 *  layers, dropped, prose, notes, fields, the summary — is the ingest
 *  panel's, and it is the biggest single thing on an inspected link. */
const LIST_INSPECTION_KEYS = ['kind', 'checkedAt'] as const
/** `plan` and `done` are the `no-plan` and `replicate-todo` queue rows. The
 *  decision's owner, note and timestamps are the ingest panel's. */
const LIST_INGEST_KEYS = ['plan', 'done'] as const
/** Kept whole: `hasSuggestion` tests `title`, `category`, `summary` and
 *  `tags` for truthiness, `error` decides "no summary yet", and
 *  `modelPassGap` returns `reason` and `at`. That is the entire block. If
 *  fetched links ever dominate the list, `summary` is the one field here
 *  nothing on a list renders. */

/** One nested block, cut to the fields a list reads. Returns undefined when
 *  there is nothing to keep — including when the value is not an object at
 *  all (a dataset's `source` has been plain provenance prose since the first
 *  content load, and no list consumer reads that). */
function pickKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const from = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of keys) if (from[key] !== undefined) out[key] = from[key]
  return Object.keys(out).length ? out : undefined
}

/**
 * P6-8: the title a machine proposed and nobody has accepted yet, or null.
 *
 * A derived field rather than a manifest key — it is already inside
 * `suggested`, but a card must not have to work out whether the proposal still
 * stands, and "accepted" has exactly one meaning: the entry's own title IS the
 * proposal. Present ⇒ show it greyed with a "suggested" badge; absent ⇒ there
 * is nothing outstanding to show.
 */
function unacceptedTitle(meta: Record<string, unknown>): string | null {
  const suggested = meta.suggested
  if (!suggested || typeof suggested !== 'object' || Array.isArray(suggested)) return null
  const title = (suggested as { title?: unknown }).title
  if (typeof title !== 'string' || !title.trim()) return null
  return title.trim() === String(meta.title ?? '').trim() ? null : title.trim()
}

/** The one place the list projection is written down. */
export function listRowMeta(meta: Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!meta || typeof meta !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const key of LIST_ROW_META_KEYS) {
    if (meta[key] === undefined) continue
    switch (key) {
      case 'source': {
        const source = pickKeys(meta.source, LIST_SOURCE_KEYS)
        if (source) out.source = source
        break
      }
      case 'fetch': {
        const fetch = pickKeys(meta.fetch, LIST_FETCH_KEYS)
        if (fetch) out.fetch = fetch
        break
      }
      case 'inspection': {
        const inspection = pickKeys(meta.inspection, LIST_INSPECTION_KEYS)
        if (inspection) out.inspection = inspection
        break
      }
      case 'ingest': {
        const ingest = pickKeys(meta.ingest, LIST_INGEST_KEYS)
        if (ingest) out.ingest = ingest
        break
      }
      default:
        out[key] = meta[key]
    }
  }
  const suggestedTitle = unacceptedTitle(meta)
  if (suggestedTitle) out.suggestedTitle = suggestedTitle
  // P6-5a: who dropped it, under one name whichever door it came through, so
  // the docs browser can show a person their own to-file queue. Derived
  // rather than copied — `uploadedBy` and `linkedBy` are two spellings of one
  // fact, and a list should not have to know that.
  const owner = entryOwner(meta)
  if (owner) out.uploadedBy = owner
  return out
}

/** A row as a list sends it: same row, smaller manifest. `readiness` is
 *  computed in `withUpdatedAt` from the FULL manifest before this runs, so
 *  cutting the manifest down cannot change a verdict. */
function asListRow(row: CatalogEntryRow): CatalogEntryRow {
  return { ...row, meta: listRowMeta(row.meta) }
}

export async function searchCatalogPage(filters: CatalogFilters): Promise<CatalogSearchResult> {
  const rows = await searchCatalog({ ...filters, includeArchived: true })
  // P5-88: the projection is the LAST thing that happens — every filter,
  // count and sort above has already read the full manifest.
  const project = (list: CatalogEntryRow[]): CatalogEntryRow[] => (filters.full ? list : list.map(asListRow))
  if (filters.includeArchived || filters.status === 'archived') return { entries: project(rows), archivedCount: 0 }
  const entries = rows.filter(r => r.status !== 'archived')
  return { entries: project(entries), archivedCount: rows.length - entries.length }
}

/**
 * P6-5a: who dropped this, by username, or '' when nothing says.
 *
 * Two paths create an unfiled entry and each writes its own field: an upload
 * (and a bulk drop) records `uploadedBy`, a dropped link records `linkedBy`.
 * Both are read here so the queue rule does not depend on which door the
 * thing came through, and the list row publishes the answer as one key.
 *
 * A legacy row from before either field was written comes back '' — which no
 * username equals, so it stays admin-only. That is the safe direction: the
 * alternative is showing one person's half-filed drop to everybody.
 */
export function entryOwner(meta: Record<string, unknown> | undefined | null): string {
  if (!meta || typeof meta !== 'object') return ''
  for (const field of ['uploadedBy', 'linkedBy'] as const) {
    const value = meta[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** The to-file queue is the one thing in the catalog that is not everybody's
 *  (P6-5a). See `CatalogFilters.viewer` for why an absent viewer sees all. */
function visibleToViewer(row: CatalogEntryRow, viewer: CatalogFilters['viewer']): boolean {
  if (row.kind !== 'incoming') return true
  if (viewer === undefined) return true
  if (!viewer) return false
  if (viewer.role === 'admin') return true
  return entryOwner(row.meta) === viewer.username
}

export async function searchCatalog(filters: CatalogFilters): Promise<CatalogEntryRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  // `category` is deliberately not here any more (P5-63): it is no longer a
  // stored word compared with a typed word — it is a question about the
  // taxonomy, asked in JS below beside `topic` and `purpose`.
  for (const field of ['status', 'kind'] as const) {
    const value = filters[field]
    if (value) {
      params.push(value)
      where.push(`${field} = $${params.length}`)
    }
  }
  const sql = `SELECT slug, kind, title, category, status, tags, meta, files, bytes, updated_at
               FROM library_catalog
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY updated_at DESC`
  const result = await libraryQuery(sql, params)

  let rows = result.rows as CatalogEntryRow[]
  // P6-5a: before anything else, so a hidden queue row cannot be counted by a
  // facet, matched by a search, or leak through `archivedCount`.
  if (filters.viewer !== undefined) rows = rows.filter(r => visibleToViewer(r, filters.viewer))
  if (filters.q) {
    // P5-38: global search matches title, slug, tags, category, and the
    // manifest description — not file contents (the table has its own search).
    // P5-84: "Georgia landowner" is two words that may sit in two fields
    // ("TELE landowner profiles — Georgia"); every word must be found, in
    // any field, rather than the phrase in one.
    const words = filters.q.toLowerCase().split(/\s+/).filter(Boolean)
    rows = rows.filter(r => {
      const description = typeof r.meta?.description === 'string' ? r.meta.description : ''
      // P5-56: "what datasets tell me about contamination?" has to find the
      // EPA source whose title says none of those words — so provider,
      // program, topics and field names are searched too.
      const haystack = [r.title, r.slug, r.category ?? '', description, ...asStringArray(r.tags), ...sourceSearchText(r.meta)].map(v =>
        v.toLowerCase(),
      )
      if (words.length && words.every(word => haystack.some(v => v.includes(word)))) {
        return true
      }
      // P5-63: the words are stored folded, so a search for a spelling we fold
      // ("environmental-risk", "flooding", "demographics") would otherwise
      // find nothing at all. Ask the same question of the canonical word.
      const folded = normalizeCategory(filters.q!)
      return !!folded && (topicFor(r.category, r.tags) === folded || normalizeTags(asStringArray(r.tags)).includes(folded))
    })
  }
  if (filters.tag) {
    // Through the aliases on both sides, so `?tag=flooding` finds the entries
    // filed under `flood` (P5-63).
    const tag = normalizeCategory(filters.tag)
    rows = rows.filter(r => normalizeTags(asStringArray(r.tags)).includes(tag))
  }
  // P5-63. A topic is DERIVED (the category when that is a topic, else the
  // first tag that is one), so these filters read an entry exactly the way the
  // facet, the cards and the place report do.
  if (filters.topic) {
    const topic = normalizeCategory(filters.topic)
    rows = rows.filter(r => topicFor(r.category, r.tags) === topic)
  }
  if (filters.purpose) {
    const purpose = normalizeCategory(filters.purpose)
    rows = rows.filter(r => purposeFor(r.category) === purpose)
  }
  if (filters.category) {
    // The old key, still working. A word that names a topic asks the topic
    // question, one that names a purpose asks the purpose question, and a word
    // the taxonomy has never heard of is matched literally — which is what it
    // did before this ticket, and the only honest answer for a category
    // somebody invented last week.
    const category = normalizeCategory(filters.category)
    rows = rows.filter(r =>
      isTopic(category)
        ? topicFor(r.category, r.tags) === category
        : isPurpose(category)
          ? purposeFor(r.category) === category
          : normalizeCategory(r.category ?? '') === category,
    )
  }
  // P6-1/P6-2. Both are stored words, compared with a typed word — but read
  // through the same helpers the row is promoted with, so a row that has not
  // been reindexed since the field appeared still answers correctly.
  if (filters.organization) {
    const organization = filters.organization.trim()
    rows = rows.filter(r => storedOrganization(r) === organization)
  }
  if (filters.shape) {
    const shape = filters.shape.trim().toLowerCase()
    rows = rows.filter(r => storedShape(r) === shape)
  }
  // P6-19. `coverage` takes a scope, a state or `none`; `state` only ever
  // takes a state. Both read the row through `storedCoverage`, the same helper
  // the row is promoted with, so the list and the chip counting it cannot
  // disagree. A state nothing in the vocabulary names matches nothing, rather
  // than quietly matching everything.
  // Both are asked only of the kinds that can answer. "Where does this apply"
  // is a category error for a page or a note, so `coverage=none` must mean
  // "the datasets nobody could place" and not "everything that is not a
  // dataset" — the same gate the `no-coverage` queue row uses.
  if (filters.coverage) {
    const coverage = filters.coverage.trim()
    rows = rows.filter(r => isShapedKind(r.kind) && coverageMatches(storedCoverage(r), coverage))
  }
  if (filters.state) {
    const code = stateCodeFor(filters.state)
    rows = code ? rows.filter(r => isShapedKind(r.kind) && (storedCoverage(r)?.states ?? []).includes(code)) : []
  }
  if (filters.plan) {
    // In JS with the other content filters: `ingest` lives inside the meta
    // jsonb, and a SQL predicate on it would not survive pg-mem.
    rows = rows.filter(r => {
      const ingest = parseIngestPlan(r.meta?.ingest)
      return filters.plan === 'none' ? !ingest : ingest?.plan === filters.plan
    })
  }
  if (filters.attention) {
    rows = rows.filter(r => attentionMatches(r, filters.attention!))
  }
  if (!filters.includeArchived && filters.status !== 'archived') {
    rows = rows.filter(r => r.status !== 'archived')
  }
  if (filters.sort !== 'recent') {
    // P5-64. The SQL already ordered by recency and Array#sort is stable, so
    // ranking by kind leaves "newest first" intact inside each rank. Sorting
    // before the cap matters: it is what puts the held material in the first
    // page rather than past the 200th row.
    rows = [...rows].sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
  }
  return rows.slice(0, MAX_RESULTS).map(r => withUpdatedAt(r))
}

export interface CatalogRef {
  slug: string
  title: string
}

/** An entry plus its supersession relations (P5-35): `supersededBy` comes
 *  from the entry's own manifest (resolved to a title when the target
 *  exists), `supersedes` is the reverse relation computed from the archived
 *  rows that point at it — no manifest edit on the current entry. */
export interface CatalogEntryDetail extends CatalogEntryRow {
  supersededBy: CatalogRef | null
  supersedes: CatalogRef[]
}

function supersededBySlug(meta: unknown): string | null {
  const v = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).supersededBy : undefined
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * P5-88: who supersedes whom, read once per catalog generation.
 *
 * `supersedes` is the REVERSE relation, so answering it means looking at
 * every archived row's manifest — a scan that pulled each archived entry's
 * whole `meta` out of the jsonb column and threw all but one string of it
 * away. It ran on every `getCatalogEntry`, and the kb landing calls that once
 * per pinned slug: twelve scans to render the front door (1.1 s measured).
 *
 * The whole relation is a few dozen pairs, so it is built once and kept until
 * a row changes. `catalogGeneration` is the expiry — see its comment for why
 * it cannot miss a write.
 */
let supersedesCache: { generation: number; bySlug: Map<string, CatalogRef[]> } | null = null

async function supersedesIndex(): Promise<Map<string, CatalogRef[]>> {
  if (supersedesCache && supersedesCache.generation === catalogGeneration) return supersedesCache.bySlug
  const archived = await libraryQuery(`SELECT slug, title, meta FROM library_catalog WHERE status = 'archived'`)
  const bySlug = new Map<string, CatalogRef[]>()
  for (const row of archived.rows as { slug: string; title: string; meta: unknown }[]) {
    const target = supersededBySlug(row.meta)
    if (!target) continue
    const list = bySlug.get(target)
    if (list) list.push({ slug: row.slug, title: row.title })
    else bySlug.set(target, [{ slug: row.slug, title: row.title }])
  }
  supersedesCache = { generation: catalogGeneration, bySlug }
  return bySlug
}

export async function getCatalogEntry(slug: string): Promise<CatalogEntryDetail | null> {
  const result = await libraryQuery(
    `SELECT slug, kind, title, category, status, tags, meta, files, bytes, updated_at
     FROM library_catalog WHERE slug = $1`,
    [slug],
  )
  const row = result.rows[0] as CatalogEntryRow | undefined
  if (!row) return null
  // A copy: the cached array outlives this call, and a caller that sorted or
  // spliced the list it was handed would quietly rewrite everyone else's.
  const supersedes: CatalogRef[] = [...((await supersedesIndex()).get(slug) ?? [])]
  let supersededBy: CatalogRef | null = null
  const target = supersededBySlug(row.meta)
  if (target) {
    const t = await libraryQuery(`SELECT slug, title FROM library_catalog WHERE slug = $1`, [target])
    const hit = t.rows[0] as { slug: string; title: string } | undefined
    supersededBy = hit ? { slug: hit.slug, title: hit.title } : { slug: target, title: target }
  }
  return { ...withUpdatedAt(row), supersededBy, supersedes }
}

// --- Wiki pages (P5-14) ---------------------------------------------------
// Pages are flat markdown files: library/wiki/<slug>.md. No manifest — the
// title is the first `# Heading` in the page (fallback: the slug), so pages
// stay 100% readable outside the app and ride along in the sync CLI.

const WIKI_PREFIX = 'library/wiki/'

export const WIKI_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

/** Slugs of library entries a wiki page links (`/library/<slug>`) or embeds
 *  (` ```entry:<slug> `). Deduplicated, in first-seen order. */
export function extractWikiMentions(markdown: string): string[] {
  const out: string[] = []
  const add = (slug: string) => {
    if (WIKI_SLUG.test(slug) && !out.includes(slug)) out.push(slug)
  }
  // The slug ends at `)` or at a `/`, `?` or `#` tail. A `)` must not be part
  // of the optional tail, or one link swallows the next one on the same line.
  for (const m of markdown.matchAll(/\(\/library\/([a-z0-9][a-z0-9-]{0,79})(?:[/?#][^)]*)?\)/g)) add(m[1])
  for (const m of markdown.matchAll(/```entry:([a-z0-9][a-z0-9-]{0,79})/g)) add(m[1])
  return out
}

export function extractWikiTitle(markdown: string, slug: string): string {
  for (const line of markdown.split('\n')) {
    const match = line.match(/^#\s+(.+)/)
    if (match) return match[1].trim()
  }
  return slug
}

export interface WikiPage {
  slug: string
  title: string
  markdown: string
}

export type WikiUpsertResult =
  | { error?: undefined; slug: string; title: string; created: boolean }
  | { error: 'slug-taken' }

/** Create-or-update a wiki page: bucket-first write, then delete+insert the
 *  catalog row (kind 'wiki'). Slugs are globally unique in library_catalog,
 *  so a slug occupied by a non-wiki entry is refused rather than clobbered. */
export async function upsertWikiPage(slug: string, markdown: string): Promise<WikiUpsertResult> {
  const existing = await getCatalogEntry(slug)
  if (existing && existing.kind !== 'wiki') return { error: 'slug-taken' }

  const key = `${WIKI_PREFIX}${slug}.md`
  await putFile(key, markdown, 'text/markdown')

  const title = extractWikiTitle(markdown, slug)
  const bytes = Buffer.byteLength(markdown)
  await libraryQuery(`DELETE FROM library_catalog WHERE slug = $1`, [slug])
  await insertCatalogRow({
    slug,
    kind: 'wiki',
    title,
    category: '',
    status: 'published',
    tags: [],
    meta: {},
    files: [{ key, size: bytes }],
    bytes,
  })
  return { slug, title, created: !existing }
}

/** Read a page: the catalog row is the existence check (reindex keeps it
 *  honest), the mirror-cached file is the body. */
export async function getWikiPage(slug: string): Promise<WikiPage | null> {
  const entry = await getCatalogEntry(slug)
  if (!entry || entry.kind !== 'wiki') return null
  const md = await getFile(`${WIKI_PREFIX}${slug}.md`)
  return { slug, title: entry.title, markdown: md.toString('utf8') }
}

// --- Saved views (P5-16) ---------------------------------------------------
// A view is a flat JSON snapshot: library/views/<slug>.json. The document
// carries everything (name, attribution, map/query state, result rows), so a
// reindex reproduces the catalog row from the bucket alone. The server
// slugifies the user's name (collisions auto-suffix like notes) and stamps
// savedBy/savedAt; the state payload is the client's business and is stored
// verbatim.

const VIEWS_PREFIX = 'library/views/'

/** Result rows are a snapshot for embeds, not an export format — the cap
 *  keeps view files small and embed cards honest. */
export const VIEW_RESULTS_MAX = 100

/** A view is the map's query state, a table in the explorer (P5-54), or a
 *  county comparison (P5-55). Documents written before P5-54 have no `type`
 *  — those are map views. */
export type SavedViewType = 'map' | 'table' | 'compare'

export interface SavedViewDoc {
  name: string
  type: SavedViewType
  savedBy: string
  savedById: number | null
  savedAt: string
  state: Record<string, unknown>
  results: unknown[]
  /**
   * P7-1: the working set this view PRESENTS, when it presents one.
   *
   * Top-level, beside `state` and deliberately not inside it: `state` is
   * framing — layers with weights, filters, a viewport, a sort — and a working
   * set is the opposite of framing. Which set a view is about is a fact about
   * the view, not part of the picture it restores.
   *
   * **Absent means ad-hoc**, which is a permanent, first-class state and not a
   * legacy one (spec §F.1): an existing view keeps a null pointer and behaves
   * exactly as it does today. Nothing is backfilled — a set auto-built from a
   * view's layer list would be one to three registry layers with no sites and
   * no sources, satisfying the schema and meaning nothing. A curated set comes
   * into being through a deliberate promote action instead. This is the same
   * stated-absence rule `siteLayers` follows.
   */
  workingSet?: string
}

/** A view document's kind, defaulting old files to 'map'. */
export function savedViewType(doc: Record<string, unknown>): SavedViewType {
  if (doc.type === 'table' || doc.type === 'compare') return doc.type
  return 'map'
}

function parseViewDoc(buf: Buffer, slug: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(buf.toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    /* fall through */
  }
  console.warn(`[library] malformed view document for "${slug}" — indexing with defaults.`)
  return null
}

/** How a saved filter reads out loud (P5-54) — "HQ State is Georgia", not
 *  "{column: 'HQ State', op: 'eq'}". Mirrors the explorer's own words. */
const FILTER_PHRASE: Record<string, (column: string, value: string) => string> = {
  eq: (c, v) => `${c} is ${v}`,
  contains: (c, v) => `${c} contains ${v}`,
  gte: (c, v) => `${c} at least ${v}`,
  lte: (c, v) => `${c} at most ${v}`,
  empty: c => `${c} is blank`,
  notEmpty: c => `${c} has a value`,
}

/** Filters worth naming in one line; the rest become "+2 more filters". */
const DESCRIPTION_FILTERS_SHOWN = 3

/**
 * The contamination overlays a map view remembers, named the way a person
 * reads them (P5-78). The ids are validated when the view is saved, so a
 * document that names one we no longer publish simply has it dropped here
 * rather than printing a raw id into every list and search result.
 */
function siteLayerNames(state: Record<string, unknown>): string[] {
  if (!Array.isArray(state.siteLayers)) return []
  const names: string[] = []
  for (const id of state.siteLayers) {
    const layer = siteLayerRegistry.find(l => l.id === id)
    if (layer && !names.includes(layer.name)) names.push(layer.name)
  }
  return names
}

/**
 * The one line that says what a saved view IS, e.g.
 * "Organizations · HQ State is Georgia · 13 rows".
 *
 * It is stored on the catalog row so every surface reads the same sentence:
 * the views list, ⌘K, the wiki embed, and Ask's index (which indexes
 * `meta.description` for every entry — see kbSearch.entryChunkText).
 */
export function describeSavedView(doc: Record<string, unknown>): string {
  const state = doc.state && typeof doc.state === 'object' ? (doc.state as Record<string, unknown>) : {}
  const parts: string[] = []
  const type = savedViewType(doc)
  // P5-55: a comparison is its own shape — "3 counties × 4 layers" is the
  // whole of what it is, and it reads the same in the views list, in ⌘K and
  // on the embed card.
  if (type === 'compare') {
    const counties = Array.isArray(state.counties) ? state.counties.length : 0
    const layers = Array.isArray(state.layers) ? state.layers.length : 0
    return `${counties} ${counties === 1 ? 'county' : 'counties'} × ${layers} ${layers === 1 ? 'layer' : 'layers'}`
  }
  if (type === 'table') {
    const title = typeof state.datasetTitle === 'string' && state.datasetTitle ? state.datasetTitle : ''
    const dataset = typeof state.dataset === 'string' ? state.dataset : ''
    if (title || dataset) parts.push(title || dataset)
    if (typeof state.q === 'string' && state.q) parts.push(`search “${state.q}”`)
    const filters = Array.isArray(state.filters) ? state.filters : []
    for (const f of filters.slice(0, DESCRIPTION_FILTERS_SHOWN)) {
      if (!f || typeof f !== 'object') continue
      const { column, op, value } = f as Record<string, unknown>
      const phrase = typeof op === 'string' ? FILTER_PHRASE[op] : undefined
      if (phrase && typeof column === 'string') parts.push(phrase(column, String(value ?? '')))
    }
    if (filters.length > DESCRIPTION_FILTERS_SHOWN) {
      parts.push(`+${filters.length - DESCRIPTION_FILTERS_SHOWN} more filters`)
    }
    const summary = state.summary && typeof state.summary === 'object' ? (state.summary as Record<string, unknown>) : null
    if (summary && typeof summary.groupBy === 'string') parts.push(`counted by ${summary.groupBy}`)
    else if (summary && typeof summary.column === 'string') parts.push(`chart of ${summary.column}`)
    const rows = typeof state.savedRowCount === 'number' ? state.savedRowCount : null
    if (rows !== null) parts.push(`${rows.toLocaleString('en-US')} rows`)
    return parts.join(' · ')
  }
  parts.push('Map view')
  if (typeof state.prompt === 'string' && state.prompt.trim()) parts.push(state.prompt.trim().slice(0, 120))
  // P5-78: the contamination overlays that were on. They are half of what a
  // view like "Superfund sites over the equity index" IS, so the sentence
  // says so before it counts the counties.
  const sites = siteLayerNames(state)
  if (sites.length > 0) parts.push(sites.join(', '))
  const results = Array.isArray(doc.results) ? doc.results.length : 0
  if (results > 0) parts.push(`${results.toLocaleString('en-US')} ${results === 1 ? 'county' : 'counties'}`)
  return parts.join(' · ')
}

/** The catalog meta a view row carries: enough for list/embed summaries
 *  without shipping the whole snapshot. */
export function savedViewMeta(doc: Record<string, unknown>): Record<string, unknown> {
  // P5-37: which layers the view uses (scoring layers + point layers, and
  // P5-78's contamination site layers), so an entry page can list the saved
  // views built on its layer. A table view's
  // `layers` are the county-context ids it carries (P5-48), so plain strings
  // count too — the same question ("which views use this layer?") applies.
  const state = doc.state && typeof doc.state === 'object' ? (doc.state as Record<string, unknown>) : {}
  const layers = new Set<string>()
  if (Array.isArray(state.layers)) {
    for (const l of state.layers) {
      if (typeof l === 'string' && l) layers.add(l)
      else if (l && typeof l === 'object' && typeof (l as any).layerId === 'string') layers.add((l as any).layerId)
    }
  }
  if (Array.isArray(state.pointLayers)) {
    for (const l of state.pointLayers) if (l && typeof l === 'object' && typeof (l as any).id === 'string') layers.add((l as any).id)
  }
  // P5-78: the contamination overlays count too — "which views use this
  // layer?" is the same question for a site layer as for a scoring one.
  if (Array.isArray(state.siteLayers)) {
    for (const id of state.siteLayers) if (typeof id === 'string' && id) layers.add(id)
  }
  const type = savedViewType(doc)
  return {
    type,
    // P5-54: which table this view opens, so the explorer can list its own
    // saved views without reading every document. A comparison opens no
    // table, so it stays blank — it is found by `type` instead (P5-55).
    dataset: type === 'table' && typeof state.dataset === 'string' ? state.dataset : '',
    description: describeSavedView(doc),
    savedBy: typeof doc.savedBy === 'string' ? doc.savedBy : '',
    savedAt: typeof doc.savedAt === 'string' ? doc.savedAt : '',
    resultCount: Array.isArray(doc.results) ? doc.results.length : 0,
    layers: [...layers],
    // P7-1: which working set this view presents, so "the views of this set"
    // is one list query rather than a read of every document. '' is the
    // ad-hoc view, exactly as a map view's `dataset` is '' — a stated absence
    // on the row, matching nothing rather than being a gap to fill.
    workingSet: typeof doc.workingSet === 'string' ? doc.workingSet : '',
  }
}

export interface SavedViewInput {
  name: string
  /** Defaults to a map view — the only kind that existed before P5-54. */
  type?: SavedViewType
  state: Record<string, unknown>
  results: unknown[]
  savedBy: string
  savedById: number | null
  /** P7-1: the working set this view presents. Omit for an ad-hoc view. */
  workingSet?: string
}

export type SavedViewCreateResult =
  | { error: 'bad-name' }
  | { error?: undefined; slug: string; name: string }

export async function createSavedView(input: SavedViewInput): Promise<SavedViewCreateResult> {
  const base = slugify(input.name)
  if (!base) return { error: 'bad-name' }
  let slug = base
  for (let n = 2; await getCatalogEntry(slug); n++) slug = `${base}-${n}`

  const doc: SavedViewDoc = {
    name: input.name,
    type: input.type ?? 'map',
    savedBy: input.savedBy,
    savedById: input.savedById,
    savedAt: new Date().toISOString(),
    state: input.state,
    results: input.results,
    // Omitted, not stored empty: an ad-hoc view's document should look exactly
    // like every document written before P7-1.
    ...(input.workingSet ? { workingSet: input.workingSet } : {}),
  }
  const key = `${VIEWS_PREFIX}${slug}.json`
  const json = JSON.stringify(doc, null, 2)
  await putFile(key, json, 'application/json')

  await insertCatalogRow({
    slug,
    kind: 'view',
    title: input.name,
    category: 'views',
    status: 'published',
    tags: [],
    meta: savedViewMeta(doc as unknown as Record<string, unknown>),
    files: [{ key, size: Buffer.byteLength(json) }],
    bytes: Buffer.byteLength(json),
  })
  return { slug, name: input.name }
}

/** Read a view: catalog row is the existence check, the mirror-cached JSON is
 *  the body. A row whose file turns out malformed reads as missing. */
export async function getSavedView(
  slug: string,
): Promise<(SavedViewDoc & { slug: string }) | null> {
  const entry = await getCatalogEntry(slug)
  if (!entry || entry.kind !== 'view') return null
  const doc = parseViewDoc(await getFile(`${VIEWS_PREFIX}${slug}.json`), slug)
  if (!doc) return null
  return {
    slug,
    name: typeof doc.name === 'string' && doc.name ? doc.name : slug,
    type: savedViewType(doc),
    savedBy: typeof doc.savedBy === 'string' ? doc.savedBy : '',
    savedById: typeof doc.savedById === 'number' ? doc.savedById : null,
    savedAt: typeof doc.savedAt === 'string' ? doc.savedAt : '',
    state: doc.state && typeof doc.state === 'object' && !Array.isArray(doc.state)
      ? (doc.state as Record<string, unknown>)
      : {},
    results: Array.isArray(doc.results) ? doc.results : [],
    // Absent stays absent all the way out to the client, where `workingSet`
    // being undefined is what "ad-hoc" means.
    ...(typeof doc.workingSet === 'string' && doc.workingSet ? { workingSet: doc.workingSet } : {}),
  }
}

/**
 * Point a saved view at a working set, or clear the pointer (P7-1).
 *
 * The one mutation a view has ever had. It is here rather than in the route
 * because both ways a view comes to present a set go through it: the promote
 * action ("make a working set from this view"), and a second view joining a
 * set that already exists — which is how "a set may carry several views"
 * becomes reachable at all.
 *
 * Bucket-first then the row, like every other write: the document is the
 * truth, so a reindex reproduces the pointer without this function running.
 * `null` removes the field rather than storing an empty one, so a view that
 * was never promoted and a view that was un-promoted are the same document.
 */
export async function setViewWorkingSet(
  slug: string,
  workingSet: string | null,
): Promise<{ error: 'not-found' } | { error?: undefined; view: SavedViewDoc & { slug: string } }> {
  const existing = await getSavedView(slug)
  if (!existing) return { error: 'not-found' }
  const { slug: _slug, ...doc } = existing
  const next: SavedViewDoc = workingSet
    ? { ...doc, workingSet }
    : (() => {
        const { workingSet: _cleared, ...rest } = doc
        return rest
      })()
  const key = `${VIEWS_PREFIX}${slug}.json`
  const json = JSON.stringify(next, null, 2)
  await putFile(key, json, 'application/json')
  // Delete + insert mirrors reindex and stays pg-mem-portable, the same way
  // every other row rewrite in this module does it.
  await libraryQuery(`DELETE FROM library_catalog WHERE slug = $1`, [slug])
  await insertCatalogRow({
    slug,
    kind: 'view',
    title: next.name,
    category: 'views',
    status: 'published',
    tags: [],
    meta: savedViewMeta(next as unknown as Record<string, unknown>),
    files: [{ key, size: Buffer.byteLength(json) }],
    bytes: Buffer.byteLength(json),
  })
  return { view: { ...next, slug } }
}
