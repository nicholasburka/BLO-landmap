import { searchCatalog, onReindex, type CatalogEntryRow } from './libraryCatalog.js'
import { topicById, topicFor, topicLabel } from './taxonomy.js'
import { getFile } from './libraryBucket.js'
import { readDataset } from './libraryTabular.js'
import { extractableFiles, isFailure, onExtracted, readDerived } from './textExtract.js'
import { parseLayerBlock, INTERNAL_LAYER_ID_PREFIX } from './internalLayers.js'
import publicLayerRegistry from '../prompt/publicLayers.generated.json' with { type: 'json' }

/**
 * Retrieval for "Ask the knowledge base" (P5-41) — without embeddings.
 *
 * The library is small (tens of entries, not millions), so a BM25 index over
 * text chunks answers "which pages talk about this?" well enough and costs
 * nothing to run: no vector store, no external service, no per-write cost,
 * and every score is explainable when a researcher asks why a source came up.
 *
 * What goes in (text only — never the bytes of a PDF or a spreadsheet):
 *   - one chunk per catalog entry (title, description, tags, category, kind,
 *     status) so an entry is findable by its filing alone;
 *   - wiki page markdown, chunked by heading;
 *   - a chunk per PAGE of every document whose text has been extracted
 *     (P5-46), so an answer can cite "the plan, page 12" and link to it;
 *   - note bodies (they live in the manifest);
 *   - dataset schemas (columns + types + row count) and a README in the
 *     dataset folder when one exists;
 *   - link URLs.
 *
 * The index is built lazily on the first ask and dropped on reindex (the
 * catalog is the truth and files may have changed behind us) — same rule as
 * the tabular parse cache, which it is registered alongside below.
 */

// --- Tokenising + chunking ---------------------------------------------------

/** Words carried by nearly every document, so they separate nothing. Kept
 *  deliberately short: an aggressive stop list drops real signal from short
 *  questions ("who is the fund for?"). */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'do', 'does', 'for', 'from',
  'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'our', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with', 'you', 'your',
])

/** Lowercase, split on anything that is not a letter/digit, drop 1-character
 *  fragments and stopwords. Numbers survive (years, FIPS codes, dollar
 *  figures are exactly what someone searches for). */
export function tokenise(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue
    if (STOPWORDS.has(raw)) continue
    out.push(raw)
  }
  return out
}

export const CHUNK_MAX_CHARS = 1_500

export interface MarkdownChunk {
  heading: string
  text: string
}

/** Split markdown into chunks at ATX headings, then hard-split any section
 *  longer than `maxChars` on paragraph boundaries. The heading rides along
 *  with every piece of its section so a chunk still says what it is about. */
export function chunkMarkdown(markdown: string, maxChars = CHUNK_MAX_CHARS): MarkdownChunk[] {
  const lines = markdown.split(/\r?\n/)
  const sections: MarkdownChunk[] = []
  let heading = ''
  let buffer: string[] = []
  const flush = () => {
    const text = buffer.join('\n').trim()
    if (text) sections.push({ heading, text })
    buffer = []
  }
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match) {
      flush()
      heading = match[2].trim()
      continue
    }
    buffer.push(line)
  }
  flush()

  const out: MarkdownChunk[] = []
  for (const section of sections) {
    if (section.text.length <= maxChars) {
      out.push(section)
      continue
    }
    let current: string[] = []
    let size = 0
    for (const para of section.text.split(/\n{2,}/)) {
      const piece = para.trim()
      if (!piece) continue
      // A single oversized paragraph is cut on character count — better a
      // split sentence than a chunk that eats the whole context budget.
      for (const slice of hardSlice(piece, maxChars)) {
        if (size + slice.length > maxChars && current.length > 0) {
          out.push({ heading: section.heading, text: current.join('\n\n') })
          current = []
          size = 0
        }
        current.push(slice)
        size += slice.length + 2
      }
    }
    if (current.length) out.push({ heading: section.heading, text: current.join('\n\n') })
  }
  return out
}

function hardSlice(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const out: string[] = []
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars))
  return out
}

// --- Index shape ---------------------------------------------------------------

/** Where a chunk's text came from. A link entry has no body of its own — its
 *  URL rides in the `entry` chunk with the rest of its filing. `document` is
 *  a page of an extracted PDF/Word/RTF file (P5-46); `page` is wiki markdown. */
export type KbSourceKind = 'entry' | 'page' | 'note' | 'schema' | 'readme' | 'layer' | 'document'

export interface KbChunk {
  id: string
  slug: string
  /** Catalog kind (wiki, dataset, document, note, incoming, view). */
  kind: string
  title: string
  heading?: string
  source: KbSourceKind
  text: string
  /** In-app link for the source list (external URL for link entries). */
  href: string
  /** `internal-<slug>` when the entry powers a map layer, else null. */
  layerId: string | null
  /** Term frequencies for BM25 over text + title. */
  tf: Map<string, number>
  /** Distinct terms from the title/heading — scored again with a boost so a
   *  page named for the question wins over a page that mentions it once. */
  titleTerms: Set<string>
  length: number
}

export interface KbCounts {
  pages: number
  datasets: number
  documents: number
  notes: number
  links: number
  views: number
  /** Public map layers (P5-45) — registry metadata, not catalog rows. */
  layers: number
  /** Data sources (P5-56) — pointers to datasets held elsewhere. */
  sources: number
}

export interface KbIndex {
  chunks: KbChunk[]
  /** term → number of chunks containing it. */
  df: Map<string, number>
  avgLength: number
  builtAt: string
  /** slug → the dataset's schema chunk (for the `dataset` hint). */
  schemaBySlug: Map<string, KbChunk>
  /** slug → the entry's catalog chunk (for source titles and hrefs). */
  entryBySlug: Map<string, KbChunk>
  counts: KbCounts
}

// --- Per-source caps -----------------------------------------------------------
// Every read below is bounded: one runaway file must not be able to blow up
// the index build, the heap, or (via selection) the model's context.

/** Wiki markdown read per page. */
const PAGE_MAX_CHARS = 200_000
/** Chunks kept per wiki page — a very long page cannot crowd out the library. */
const PAGE_MAX_CHUNKS = 40
/** Note body / README characters indexed. */
const NOTE_MAX_CHARS = 6_000
const README_MAX_CHARS = 8_000
/** Manifest description characters folded into an entry's catalog chunk. */
const DESCRIPTION_MAX_CHARS = 800
/** Columns named in a schema chunk. */
const SCHEMA_MAX_COLUMNS = 60
/** Datasets whose schema is read at build time (each is a parse). */
const SCHEMA_MAX_DATASETS = 60
/** Page chunks kept from one document — a 400-page appendix must not be the
 *  whole index. */
const DOCUMENT_MAX_CHUNKS = 150
/** Page chunks across the WHOLE library. At ~1.5 kB each this is a few MB of
 *  resident text: enough for every document the team has, bounded enough that
 *  a bulk upload cannot exhaust the box's memory. */
const DOCUMENT_CHUNK_BUDGET = 4_000

const README_NAMES = new Set(['readme.md', 'readme.txt', 'readme'])

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function basenameInEntry(key: string): string {
  return key.split('/').slice(3).join('/') || key
}

/** Where an entry opens in the app — mirrors the client's `entryHref`/`entryUrl`. */
export function hrefForEntry(entry: Pick<CatalogEntryRow, 'kind' | 'slug' | 'meta'>): string {
  if (entry.kind === 'wiki') return `/wiki/${entry.slug}`
  if (entry.kind === 'view') return `/views/${entry.slug}`
  return `/library/${encodeURIComponent(entry.slug)}`
}

/**
 * Deep link to one page of a document: the entry hub's Files tab with the
 * viewer open on that file (`?tab=files&view=…`, matching LibraryEntryView's
 * `openView`) and the page in the hash. `#page=N` is what Chrome's and
 * Firefox's built-in PDF viewers act on, and what the in-app text view
 * scrolls to — so one link works in both.
 *
 * `page` is omitted for a format with no pages (a .docx is laid out by the
 * reader, not the file), where a page anchor would be a lie.
 */
export function documentPageHref(slug: string, file: string, page?: number): string {
  const base = `/library/${encodeURIComponent(slug)}?tab=files&view=${encodeURIComponent(file)}`
  return page === undefined ? base : `${base}#page=${page}`
}

/** The internal map layer an entry powers, by the same rule listInternalLayers
 *  applies (published + a valid `layer` block) — computed here from the meta we
 *  already hold rather than a second pass over the catalog. */
export function layerIdForEntry(entry: Pick<CatalogEntryRow, 'slug' | 'status' | 'meta'>): string | null {
  if (entry.status !== 'published') return null
  const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {}
  if ((meta as Record<string, unknown>).layer === undefined) return null
  const parsed = parseLayerBlock(meta as Record<string, unknown>)
  return 'block' in parsed ? `${INTERNAL_LAYER_ID_PREFIX}${entry.slug}` : null
}

function makeChunk(
  entry: CatalogEntryRow,
  source: KbSourceKind,
  index: number,
  text: string,
  heading: string | undefined,
  href: string,
  layerId: string | null,
): KbChunk {
  const titleText = heading ? `${entry.title} ${heading}` : entry.title
  const bodyTerms = tokenise(text)
  const titleTerms = tokenise(titleText)
  const tf = new Map<string, number>()
  for (const term of [...bodyTerms, ...titleTerms]) tf.set(term, (tf.get(term) ?? 0) + 1)
  return {
    id: `${entry.slug}:${source}:${index}`,
    slug: entry.slug,
    kind: entry.kind,
    title: entry.title,
    ...(heading ? { heading } : {}),
    source,
    text,
    href,
    layerId,
    tf,
    titleTerms: new Set(titleTerms),
    length: bodyTerms.length + titleTerms.length,
  }
}

// --- Public map layers (P5-45) -------------------------------------------------

/**
 * The public map's county layers are data the team reasons with daily, but
 * they live in the client's TypeScript registry, which this process cannot
 * read. `npm run export:layers` (repo root) writes the metadata to the JSON
 * imported above; without it, "where does the homeownership layer come from?"
 * would have no source to name.
 *
 * These chunks are metadata only — the county numbers themselves stay in the
 * public CSVs the map loads.
 */
export interface PublicLayerMeta {
  id: string
  name: string
  category: string
  dataType: string
  direction: string
  unit: string
  range: { min: number; max: number }
  description: string
  source: string
  sourceUrl: string
  year: number | string
}

export const PUBLIC_LAYERS: PublicLayerMeta[] = publicLayerRegistry as PublicLayerMeta[]

export function publicLayerChunkText(layer: PublicLayerMeta): string {
  const better = layer.direction === 'lower_better' ? 'lower is better' : 'higher is better'
  const unit = layer.unit ? ` in ${layer.unit}` : ''
  const source = layer.source.trim()
  const year = String(layer.year ?? '').trim()
  const provenance = source
    ? `Source: ${source}${year ? ` (${year})` : ''}.${layer.sourceUrl ? ` ${layer.sourceUrl}` : ''}`
    : 'Source: not recorded.'
  return [
    `${layer.name} — a layer on the public map (${layer.category}).`,
    layer.description,
    `One value per county${unit} (${layer.dataType}); ${better}. Values run from ${layer.range.min} to ${layer.range.max}.`,
    provenance,
    `Layer id: ${layer.id}. About this layer: /layers/${layer.id}`,
  ].join('\n')
}

function publicLayerChunk(layer: PublicLayerMeta): KbChunk {
  const text = publicLayerChunkText(layer)
  const bodyTerms = tokenise(text)
  const titleTerms = tokenise(layer.name)
  const tf = new Map<string, number>()
  for (const term of [...bodyTerms, ...titleTerms]) tf.set(term, (tf.get(term) ?? 0) + 1)
  return {
    id: `layer:${layer.id}`,
    slug: layer.id,
    kind: 'layer',
    title: layer.name,
    source: 'layer',
    text,
    href: `/layers/${layer.id}`,
    layerId: layer.id,
    tf,
    titleTerms: new Set(titleTerms),
    length: bodyTerms.length + titleTerms.length,
  }
}

// --- Build ---------------------------------------------------------------------

/** Catalog filing as prose: what an entry IS, so "which datasets cover
 *  Georgia?" can match on tags and category alone. */
/** A data source (P5-56) is a pointer to a dataset held elsewhere. Its
 *  block carries exactly the words a "what data exists for X" question uses —
 *  provider, program, topics, field names, geography, how it is queried — so
 *  all of them go into the entry chunk. Values are already cleaned at reindex. */
export function sourceBlockText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const src = value as Record<string, unknown>
  const parts: string[] = ['Data source (indexed, not copied into the library)']
  const provider = str(src.provider)
  if (provider) parts.push(`Provider: ${provider}${str(src.program) ? ` — ${str(src.program)}` : ''}`)
  const covers = [str(src.geography), str(src.coverage), ...(Array.isArray(src.granularity) ? src.granularity.map(str) : [])].filter(Boolean)
  if (covers.length) parts.push(`Covers: ${covers.join(', ')}`)
  if (Array.isArray(src.topics) && src.topics.length) parts.push(`Topics: ${src.topics.map(str).filter(Boolean).join(', ')}`)
  if (Array.isArray(src.fields) && src.fields.length) {
    const names = src.fields.map(f => (f && typeof f === 'object' ? `${str((f as any).name)}${str((f as any).description) ? ` (${str((f as any).description)})` : ''}` : '')).filter(Boolean)
    if (names.length) parts.push(`Fields: ${names.join(', ')}`)
  }
  if (Array.isArray(src.access) && src.access.length) {
    const ways = src.access.map(a => (a && typeof a === 'object' ? `${str((a as any).type)}${str((a as any).auth) ? ` (${str((a as any).auth)})` : ''}` : '')).filter(Boolean)
    if (ways.length) parts.push(`Access: ${ways.join(', ')}`)
  }
  const pq = src.placeQuery
  if (pq && typeof pq === 'object' && Array.isArray((pq as any).by)) {
    // P5-59: "by county" against a tract-keyed table returns the tracts inside
    // that county, not one row for it. Saying so here is the difference
    // between a useful answer and a reader thinking the fetch is broken.
    const rows = str(src.geography) === 'blockgroup' ? 'block group' : str(src.geography) === 'tract' ? 'tract' : ''
    const prefix = (pq as any).fipsMatch === 'prefix' && rows
    const ways = (pq as any).by
      .map(str)
      .map((way: string) => (prefix && way === 'county' ? `county (${rows} rows within the county)` : way))
    parts.push(`Query for a place by: ${ways.join(', ')}${(pq as any).radiusMiles ? ` (radius ${(pq as any).radiusMiles} miles)` : ''}`)
  }
  for (const key of ['license', 'updateCadence', 'relevance', 'notes'] as const) {
    const v = str(src[key])
    if (v) parts.push(`${key === 'updateCadence' ? 'Updated' : key[0].toUpperCase() + key.slice(1)}: ${v}`)
  }
  const rep = src.replication
  if (rep && typeof rep === 'object' && str((rep as any).status)) parts.push(`Held here: ${str((rep as any).status)}`)
  return parts.join('\n')
}

function entryChunkText(entry: CatalogEntryRow): string {
  const meta = (entry.meta ?? {}) as Record<string, unknown>
  const parts = [`${entry.title} — ${entry.kind}`]
  if (entry.category) parts.push(`Category: ${entry.category}`)
  // P5-63: the subject in plain words, not just the id. Two reasons, and both
  // showed up the day the aliases landed: a question asks "what do we have on
  // water" rather than "category:water", and the ids are folded spellings — an
  // entry tagged `environmental-risk` is stored as `environment`, so the words
  // a person would actually type have to come from somewhere. The topic's own
  // one-line description is where.
  const topic = topicFor(entry.category, entry.tags)
  if (topic) parts.push(`Topic: ${topicLabel(topic)} — ${topicById(topic)?.description ?? ''}`.trim())
  if (entry.status) parts.push(`Status: ${entry.status}`)
  if (entry.tags?.length) parts.push(`Tags: ${entry.tags.join(', ')}`)
  const description = str(meta.description).slice(0, DESCRIPTION_MAX_CHARS)
  if (description) parts.push(description)
  // P7-7: what it ANSWERS, indexed as its own line. §F.4d calls the free-text
  // half of `search_library` "genuinely good, and all descriptive" — this is
  // the one line in the chunk that is about what could be asked of the data,
  // so a question phrased as a question ("which parcels near a transmission
  // line?") can match it rather than matching a title that never says.
  const answers = str(meta.whatItAnswers)
  if (answers) parts.push(`Answers: ${answers.replace(/^answers:\s*/i, '')}`)
  // P5-47: the assistant's proposed title and summary for a drop nobody has
  // filed yet. It is a proposal on the entry, not the entry's own filing, so
  // it is labelled as one — but it is indexed the moment it lands, which is
  // the point: a link dropped this morning is findable this morning.
  const suggested = meta.suggested
  if (suggested && typeof suggested === 'object' && !Array.isArray(suggested)) {
    const s = suggested as Record<string, unknown>
    const suggestedTitle = str(s.title)
    const suggestedSummary = str(s.summary).slice(0, DESCRIPTION_MAX_CHARS)
    if (suggestedTitle) parts.push(`Suggested title: ${suggestedTitle}`)
    if (suggestedSummary) parts.push(`Suggested summary: ${suggestedSummary}`)
  }
  const source = str(meta.source)
  if (source) parts.push(`Source: ${source}`)
  const block = sourceBlockText(meta.source)
  if (block) parts.push(block)
  const url = str(meta.url)
  if (url) parts.push(`Link: ${url}`)
  return parts.join('\n')
}

function schemaChunkText(title: string, file: string, rowCount: number, columns: { name: string; type: string }[]): string {
  const named = columns.slice(0, SCHEMA_MAX_COLUMNS)
  const more = columns.length > named.length ? ` (+${columns.length - named.length} more columns)` : ''
  return [
    `${title} — data table "${file}" with ${rowCount.toLocaleString()} rows and ${columns.length} columns.`,
    `Columns: ${named.map(c => `${c.name} (${c.type})`).join(', ')}${more}`,
  ].join('\n')
}

/**
 * Page chunks for one document entry, from the text P5-46 already extracted.
 *
 * Reads only — it never triggers an extraction. Extraction is the reindex
 * hook's job precisely because it is slow; an index build that could start
 * parsing PDFs would turn the first ask after a restart into a minutes-long
 * wait. A document with no stored text simply has no page chunks until the
 * sweep catches up, and the sweep clears this index when it does.
 */
async function documentPageChunks(
  entry: CatalogEntryRow,
  layerId: string | null,
  budget: number,
): Promise<KbChunk[]> {
  const chunks: KbChunk[] = []
  let index = 0
  for (const candidate of extractableFiles(entry)) {
    // A README is already in the index, chunked by heading, from the branch
    // below — indexing it twice would just let one file answer twice.
    if (README_NAMES.has(candidate.file.toLowerCase())) continue
    const derived = await readDerived(entry.slug, candidate.file)
    if (!derived || isFailure(derived)) continue
    // A single-page format (Word, RTF, a text file) has no page to cite, so
    // it gets the file's name as its label and a link with no page anchor.
    const paginated = derived.pages.length > 1
    for (const page of derived.pages) {
      if (!page.text.trim()) continue
      const heading = paginated ? `p. ${page.n}` : candidate.file
      const href = documentPageHref(entry.slug, candidate.file, paginated ? page.n : undefined)
      for (const piece of chunkMarkdown(page.text)) {
        if (chunks.length >= DOCUMENT_MAX_CHUNKS || chunks.length >= budget) return chunks
        // The chunker splits on markdown headings, which extracted text does
        // not really have — a line it read as one is just a line, so put its
        // words back rather than losing them.
        const text = piece.heading ? `${piece.heading}\n${piece.text}` : piece.text
        chunks.push(makeChunk(entry, 'document', index++, text, heading, href, layerId))
      }
    }
  }
  return chunks
}

async function readTextFile(key: string, maxChars: number): Promise<string | null> {
  try {
    const buf = await getFile(key)
    return buf.toString('utf8').slice(0, maxChars)
  } catch {
    return null
  }
}

/** Walk the catalog and build the chunk index. Archived entries are left out
 *  (P5-35: superseded material must not be quoted back as current). */
export async function buildKbIndex(): Promise<KbIndex> {
  const entries = await searchCatalog({})
  const chunks: KbChunk[] = []
  const schemaBySlug = new Map<string, KbChunk>()
  const entryBySlug = new Map<string, KbChunk>()
  const counts: KbCounts = { pages: 0, datasets: 0, documents: 0, notes: 0, links: 0, views: 0, layers: 0, sources: 0 }
  let datasetsRead = 0
  let documentChunks = 0

  for (const entry of entries) {
    const href = hrefForEntry(entry)
    const layerId = layerIdForEntry(entry)
    const meta = (entry.meta ?? {}) as Record<string, unknown>

    const catalogChunk = makeChunk(entry, 'entry', 0, entryChunkText(entry), undefined, href, layerId)
    chunks.push(catalogChunk)
    entryBySlug.set(entry.slug, catalogChunk)

    if (entry.kind === 'wiki') counts.pages++
    else if (entry.kind === 'dataset') counts.datasets++
    else if (entry.kind === 'document' || entry.kind === 'incoming') counts.documents++
    else if (entry.kind === 'note') counts.notes++
    else if (entry.kind === 'view') counts.views++
    else if (entry.kind === 'source') counts.sources++
    if (str(meta.url)) counts.links++

    // Wiki pages: the markdown itself, chunked by heading.
    if (entry.kind === 'wiki') {
      const key = entry.files?.[0]?.key
      const markdown = key ? await readTextFile(key, PAGE_MAX_CHARS) : null
      if (markdown) {
        chunkMarkdown(markdown)
          .slice(0, PAGE_MAX_CHUNKS)
          .forEach((piece, i) => {
            chunks.push(makeChunk(entry, 'page', i, piece.text, piece.heading || undefined, href, layerId))
          })
      }
      continue
    }

    // Notes: the body lives in the manifest, no file read needed.
    if (entry.kind === 'note') {
      const body = str(meta.body).slice(0, NOTE_MAX_CHARS)
      if (body) {
        chunkMarkdown(body).forEach((piece, i) => {
          chunks.push(makeChunk(entry, 'note', i, piece.text, piece.heading || undefined, href, layerId))
        })
      }
      continue
    }

    // Datasets and documents: schema + a README when the folder has one.
    const readmeKey = (entry.files ?? []).find(f => README_NAMES.has(basenameInEntry(f.key).toLowerCase()))?.key
    if (readmeKey) {
      const readme = await readTextFile(readmeKey, README_MAX_CHARS)
      if (readme) {
        chunkMarkdown(readme).forEach((piece, i) => {
          chunks.push(makeChunk(entry, 'readme', i, piece.text, piece.heading || undefined, href, layerId))
        })
      }
    }

    // Documents and uploads: a chunk per extracted page (P5-46), so an answer
    // can cite the page a claim came from and link straight to it.
    if (entry.kind === 'document' || entry.kind === 'incoming') {
      const pageChunks = await documentPageChunks(entry, layerId, DOCUMENT_CHUNK_BUDGET - documentChunks)
      documentChunks += pageChunks.length
      chunks.push(...pageChunks)
    }

    if (entry.kind === 'dataset' && datasetsRead < SCHEMA_MAX_DATASETS) {
      datasetsRead++
      try {
        const { parsed } = await readDataset(entry.slug)
        const chunk = makeChunk(
          entry,
          'schema',
          0,
          schemaChunkText(entry.title, parsed.file, parsed.rowCount, parsed.columns),
          undefined,
          `${href}?tab=data`,
          layerId,
        )
        chunks.push(chunk)
        schemaBySlug.set(entry.slug, chunk)
      } catch {
        // Not tabular, too large, or the bucket is unhappy — the entry is
        // still in the index by its filing; only the schema is missing.
      }
    }
  }

  // Public map layers are registry metadata, not catalog rows — they are the
  // same every build and cost no reads.
  for (const layer of PUBLIC_LAYERS) {
    chunks.push(publicLayerChunk(layer))
    counts.layers++
  }

  const df = new Map<string, number>()
  let totalLength = 0
  for (const chunk of chunks) {
    totalLength += chunk.length
    for (const term of chunk.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  }

  return {
    chunks,
    df,
    avgLength: chunks.length ? totalLength / chunks.length : 0,
    builtAt: new Date().toISOString(),
    schemaBySlug,
    entryBySlug,
    counts,
  }
}

// --- Cache ---------------------------------------------------------------------

let cached: KbIndex | null = null
let inFlight: Promise<KbIndex> | null = null

/** Build once, share the build across concurrent askers. */
export function getKbIndex(): Promise<KbIndex> {
  if (cached) return Promise.resolve(cached)
  if (!inFlight) {
    inFlight = buildKbIndex()
      .then(index => {
        cached = index
        return index
      })
      .finally(() => {
        inFlight = null
      })
  }
  return inFlight
}

/** Drop the index. Registered on reindex below; exported for tests. */
export function clearKbIndex(): void {
  cached = null
  inFlight = null
}

export function kbIndexStats(): { built: boolean; chunks: number; builtAt: string | null } {
  return { built: !!cached, chunks: cached?.chunks.length ?? 0, builtAt: cached?.builtAt ?? null }
}

// The catalog is the truth: after a reindex the old chunks may quote files
// that no longer exist. Same lifecycle as the tabular parse cache.
onReindex(clearKbIndex)

// Extraction (P5-46) runs detached from the reindex that started it, so the
// document pages usually arrive AFTER the index was cleared above. Drop it
// again when they land, or the first ask after a reindex would cache an index
// that cannot see the very documents the reindex brought in.
onExtracted(clearKbIndex)

// --- Scoring -------------------------------------------------------------------

/** BM25 saturation + length-normalisation constants (the standard defaults). */
const K1 = 1.2
const B = 0.75
/** Extra weight for a query term that appears in the chunk's title/heading. */
const TITLE_BOOST = 2.5

export interface ScoredChunk {
  chunk: KbChunk
  score: number
}

/** BM25 over the chunk index, with a title boost. Chunks scoring zero are
 *  dropped — a source that shares no term with the question is not a source. */
export function scoreChunks(index: KbIndex, question: string): ScoredChunk[] {
  const terms = tokenise(question)
  if (terms.length === 0 || index.chunks.length === 0) return []
  const n = index.chunks.length
  const avg = index.avgLength || 1
  const scored: ScoredChunk[] = []
  for (const chunk of index.chunks) {
    let score = 0
    for (const term of new Set(terms)) {
      const tf = chunk.tf.get(term)
      if (!tf) continue
      const df = index.df.get(term) ?? 0
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (chunk.length / avg)))
      score += idf * norm
      if (chunk.titleTerms.has(term)) score += idf * TITLE_BOOST
    }
    if (score > 0) scored.push({ chunk, score })
  }
  scored.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
  return scored
}

// --- Context selection -----------------------------------------------------------

/** Characters of excerpt text the prompt may carry. ~6k tokens — big enough
 *  for a real answer, small enough that one ask stays cheap. */
export const CONTEXT_BUDGET_CHARS = 24_000
/** Chunks taken from any one entry, so a long page cannot be the whole answer. */
const MAX_CHUNKS_PER_SLUG = 3
const MAX_CHUNKS = 14

export interface KbSelection {
  chunks: KbChunk[]
  chars: number
  /** What was read, for the client's "Reading 7 pages and 2 datasets…" line. */
  counts: { pages: number; datasets: number; documents: number; notes: number; sources: number }
}

function bump(counts: KbSelection['counts'], kind: string): void {
  if (kind === 'wiki') counts.pages++
  // A map layer IS county data — "read 2 datasets" is closer to the truth
  // than "read 2 documents" in the client's loading line.
  else if (kind === 'dataset' || kind === 'layer') counts.datasets++
  else if (kind === 'note') counts.notes++
  else if (kind === 'source') counts.sources++
  else counts.documents++
}

/**
 * Top-scoring chunks within the character budget. A `dataset` hint pins that
 * dataset's schema (and its catalog entry) into context first, so "ask about
 * this data" always knows the columns even when the question's words do not
 * match the schema at all.
 */
/** Words that ask "what data exists" rather than "what does the data say" —
 *  the cue for reserving context for data-source entries (P5-56). */
const DATA_INTENT = /\b(data ?sources?|data ?sets?|datasets?|sources?|databases?|layers?|what data|which data)\b/i
const SOURCE_RESERVE_SHARE = 0.5
const SOURCE_RESERVE_MAX = 12

export function selectContext(
  index: KbIndex,
  question: string,
  options: { dataset?: string; budget?: number; maxChunks?: number } = {},
): KbSelection {
  const budget = options.budget ?? CONTEXT_BUDGET_CHARS
  const maxChunks = options.maxChunks ?? MAX_CHUNKS
  const chosen: KbChunk[] = []
  const seen = new Set<string>()
  const perSlug = new Map<string, number>()
  let chars = 0

  const take = (chunk: KbChunk | undefined, ignorePerSlugCap = false): boolean => {
    if (!chunk || seen.has(chunk.id)) return false
    if (chosen.length >= maxChunks) return false
    if (!ignorePerSlugCap && (perSlug.get(chunk.slug) ?? 0) >= MAX_CHUNKS_PER_SLUG) return false
    if (chars + chunk.text.length > budget && chosen.length > 0) return false
    seen.add(chunk.id)
    perSlug.set(chunk.slug, (perSlug.get(chunk.slug) ?? 0) + 1)
    chosen.push(chunk)
    chars += chunk.text.length
    return true
  }

  if (options.dataset) {
    take(index.schemaBySlug.get(options.dataset), true)
    take(index.entryBySlug.get(options.dataset), true)
  }
  const scored = scoreChunks(index, question)
  // "What data exists for X" should surface the data-source catalog itself
  // (P5-56), not just the page that lists it: a wiki page naming forty
  // sources outscores any one source entry, and the model then answers from
  // the page's one-liners. Reserve part of the budget for source entries
  // first; ordinary questions are untouched.
  if (DATA_INTENT.test(question)) {
    const reserve = Math.floor(budget * SOURCE_RESERVE_SHARE)
    let used = 0
    let taken = 0
    for (const { chunk, score } of scored) {
      if (chunk.kind !== 'source' || score <= 0) continue
      if (taken >= SOURCE_RESERVE_MAX || used + chunk.text.length > reserve) break
      if (take(chunk)) {
        used += chunk.text.length
        taken++
      }
    }
  }
  for (const { chunk } of scored) take(chunk)

  const counts = { pages: 0, datasets: 0, documents: 0, notes: 0, sources: 0 }
  for (const slug of new Set(chosen.map(c => c.slug))) {
    const kind = chosen.find(c => c.slug === slug)!.kind
    bump(counts, kind)
  }
  return { chunks: chosen, chars, counts }
}
