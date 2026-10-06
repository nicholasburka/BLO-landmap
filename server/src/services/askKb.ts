import Anthropic from '@anthropic-ai/sdk'
import { buildAskSystemPrompt, buildAskUserMessage } from '../prompt/askPrompt.js'
import { getKbIndex, selectContext, type KbChunk, type KbIndex } from './kbSearch.js'
import {
  readDataset,
  queryRows,
  parseRowsQuery,
  TabularError,
  type RowFilter,
  type ServedRow,
} from './libraryTabular.js'
import { fetchForPlace } from './placeFetch.js'
import { failureText, PlaceFetchError } from './placeHttp.js'
import { inspectUrl, inspectionSummary } from './linkInspect.js'
import { proposeIngestPlan, planSummary } from './ingestPlan.js'

/**
 * "Ask the knowledge base" (P5-41): retrieve, ask the model, let it run real
 * dataset queries, and hand back an answer whose every claim points at
 * something the reader can open.
 *
 * The model never touches the bucket or the database. Its one tool takes a
 * slug and filters, both validated against the REAL column list by the same
 * parser the table explorer uses (`parseRowsQuery`), and every executed query
 * comes back as a deep link into the explorer so a number in the answer is
 * one click from the rows behind it.
 */

// --- Configuration -------------------------------------------------------------

/** Sonnet by default: this reads a lot of context and has to be careful with
 *  citations. `LIBRARY_ASK_MODEL` swaps it (Haiku 4.5 is acceptable for cost). */
export function askModel(): string {
  return process.env.LIBRARY_ASK_MODEL || 'claude-sonnet-5'
}

/**
 * Answers are meant to be short; the cap is also the cost ceiling per round.
 *
 * 1,500, raised from 1,000 (P6-34, 2026-10-05). The cap is spent by the
 * THINKING BLOCK as well as the answer, and the same budget at 600 was making
 * `annotateEntry` return no text at all on longer documents — two of four
 * replays came back empty with `stop_reason: max_tokens`. Ask reads far more
 * context than the annotator does, so it was exposed to the same failure and
 * more so, and the failure is silent: an empty answer, not an error.
 *
 * An output cap is a ceiling, not a spend — a short answer still costs what a
 * short answer costs — so raising it buys headroom for nothing. That is P5-62's
 * reasoning for the same class of bug.
 */
export function askMaxTokens(): number {
  const raw = Number(process.env.LIBRARY_ASK_MAX_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1_500
}

/** Model turns that may call a tool before we force a final answer. */
export const MAX_TOOL_ROUNDS = 3
/** Rows scanned for a group-by. Counting is cheap; a whole 200k-row file in
 *  one prompt is not, and nobody reads 200k groups. */
export const GROUP_BY_MAX_ROWS = 5_000
/** Groups returned to the model (and shown on the query card). */
export const GROUP_BY_MAX_GROUPS = 25
/** Sample rows handed back for a non-grouped query. */
const SAMPLE_ROWS = 8
const SAMPLE_COLUMNS = 8
const SAMPLE_CELL_CHARS = 80
/** Characters of a chunk shown under a source in the UI. */
const SNIPPET_CHARS = 240

// --- Client --------------------------------------------------------------------

/** The slice of the SDK this module uses — so tests can pass a stub instead of
 *  a real client without mocking the module graph. */
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<Anthropic.Messages.Message>
  }
}

let defaultClient: AnthropicLike | null = null

/** Built lazily (not at import) so route suites can load the app without an
 *  API key present — same construction as services/haiku.ts otherwise. */
function getClient(): AnthropicLike {
  if (!defaultClient) defaultClient = new Anthropic() as unknown as AnthropicLike
  return defaultClient
}

/**
 * The model call itself failed — no key, a refused key, a rate limit, an
 * outage (P5-75).
 *
 * Its own class because the route has to tell this apart from a bug in our own
 * retrieval: one is "the model is unavailable, here is why", the other is a
 * 502 nobody but us can fix. The original error travels with it so the one
 * place that classifies SDK errors (`assistantCall.failureOf`) still does.
 */
export class AskModelError extends Error {
  constructor(readonly modelError: unknown) {
    super(String((modelError as { message?: unknown } | null)?.message ?? modelError ?? 'the model call failed'))
    this.name = 'AskModelError'
  }
}

// --- Deep links ----------------------------------------------------------------

/** Table deep link, matching the client's URL conventions exactly: the entry
 *  hub's Data tab (`?tab=data`, src/lib/libraryCatalog.ts `entryUrl`) plus the
 *  rows state as `buildRowsQuery` writes it (filters are a JSON array). */
export function tableHref(slug: string, filters: RowFilter[]): string {
  const params = new URLSearchParams()
  params.set('tab', 'data')
  if (filters.length) params.set('filter', JSON.stringify(filters))
  return `/library/${encodeURIComponent(slug)}?${params.toString()}`
}

/** Map deep link for an entry that powers an internal layer (P5-36). */
export function mapHref(layerId: string): string {
  return `/?layers=${encodeURIComponent(layerId)}`
}

// --- Group-by ------------------------------------------------------------------

export interface GroupCount {
  value: string
  count: number
}

export interface GroupByResult {
  groups: GroupCount[]
  /** Rows actually counted (≤ GROUP_BY_MAX_ROWS). */
  counted: number
  /** Distinct values found in those rows. */
  distinct: number
  /** True when more rows matched than were counted. */
  truncated: boolean
}

/** Count rows by a column's value. Counts only — no sums, no averages: the
 *  model must not be handed derived numbers it cannot verify against the
 *  table, and "how many X by Y" is the question researchers actually ask. */
export function groupByColumn(rows: ServedRow[], column: string, maxGroups = GROUP_BY_MAX_GROUPS): GroupByResult {
  const counts = new Map<string, number>()
  const scanned = rows.slice(0, GROUP_BY_MAX_ROWS)
  for (const row of scanned) {
    const raw = row[column]
    const value = (typeof raw === 'string' ? raw : '').trim() || '(blank)'
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  const groups = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxGroups)
    .map(([value, count]) => ({ value, count }))
  return { groups, counted: scanned.length, distinct: counts.size, truncated: rows.length > scanned.length }
}

// --- The tool ------------------------------------------------------------------

export const QUERY_DATASET_TOOL: Anthropic.Tool = {
  name: 'query_dataset',
  description:
    'Count or list rows in one of the library data tables. Use it whenever the question asks how many, which ones, or for a breakdown by category — never estimate those from an excerpt. ' +
    'Filter operators: eq (exact match), contains (text contains), gte / lte (at least / at most, for numbers and dates), empty, notEmpty. ' +
    'Set groupBy to a column name to get counts per value of that column.',
  input_schema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'The dataset slug, exactly as it appears in the excerpts.' },
      filters: {
        type: 'array',
        description: 'Conditions rows must meet. Omit for the whole table.',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'A column name from the table, spelled exactly.' },
            op: { type: 'string', enum: ['eq', 'contains', 'gte', 'lte', 'empty', 'notEmpty'] },
            value: { type: 'string', description: 'The value to compare against (not needed for empty / notEmpty).' },
          },
          required: ['column', 'op'],
        },
      },
      groupBy: { type: 'string', description: 'A column name to count rows by.' },
      limit: { type: 'number', description: 'How many example rows to return (1-20, default 8).' },
    },
    required: ['slug'],
  },
}

export interface AskQueryCard {
  slug: string
  title: string
  filters: RowFilter[]
  groupBy?: string
  groups?: GroupCount[]
  /** Rows matching the filters (the full match count, not the sample size). */
  rowCount: number
  href: string
  mapHref?: string
}

type ToolOutcome = { text: string; card: AskQueryCard } | { error: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function renderSample(rows: ServedRow[], columns: string[]): string {
  const shown = columns.slice(0, SAMPLE_COLUMNS)
  return rows
    .slice(0, SAMPLE_ROWS)
    .map(row => shown.map(c => `${c}: ${truncate(typeof row[c] === 'string' ? (row[c] as string) : '', SAMPLE_CELL_CHARS)}`).join(' | '))
    .join('\n')
}

/**
 * Execute one `query_dataset` call. Every rejection is returned as an error
 * STRING for the model to read and retry — an unknown slug or a misspelled
 * column is a normal thing for a model to do and must never crash the ask.
 */
export async function runQueryDataset(rawInput: unknown, index: KbIndex): Promise<ToolOutcome> {
  const input = isPlainObject(rawInput) ? rawInput : {}
  const slug = typeof input.slug === 'string' ? input.slug.trim() : ''
  if (!slug) return { error: 'query_dataset needs a "slug". Use one of the dataset slugs from the excerpts.' }

  let read: Awaited<ReturnType<typeof readDataset>>
  try {
    read = await readDataset(slug)
  } catch (err) {
    if (err instanceof TabularError) {
      const known = [...index.schemaBySlug.keys()]
      const hint = known.length ? ` Known data tables: ${known.slice(0, 12).join(', ')}.` : ''
      return { error: `Cannot query "${slug}": ${err.message}.${hint}` }
    }
    console.error('[ask] dataset read failed:', (err as Error)?.message || err)
    return { error: `Cannot query "${slug}" right now.` }
  }

  const { entry, parsed } = read
  const columns = parsed.columns.map(c => c.name)

  // Validate the model's filters with the SAME parser the table explorer
  // uses, against the real column list — one definition of a legal query.
  const filtersRaw = Array.isArray(input.filters) ? input.filters : []
  const validated = parseRowsQuery({ filter: JSON.stringify(filtersRaw) }, columns)
  if ('error' in validated) {
    return { error: `${validated.error}. Columns in "${slug}": ${columns.join(', ')}.` }
  }
  const filters = validated.filter ?? []

  const groupBy = typeof input.groupBy === 'string' && input.groupBy.trim() ? input.groupBy.trim() : undefined
  if (groupBy && !columns.includes(groupBy)) {
    return { error: `unknown column: ${groupBy}. Columns in "${slug}": ${columns.join(', ')}.` }
  }

  const limitRaw = Number(input.limit)
  const sampleLimit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.floor(limitRaw))) : SAMPLE_ROWS
  const page = queryRows(parsed, {
    filter: filters,
    page: 1,
    limit: groupBy ? GROUP_BY_MAX_ROWS : sampleLimit,
  })

  const layerId = index.entryBySlug.get(slug)?.layerId ?? null
  const card: AskQueryCard = {
    slug,
    title: entry.title,
    filters,
    ...(groupBy ? { groupBy } : {}),
    rowCount: page.total,
    href: tableHref(slug, filters),
    ...(layerId ? { mapHref: mapHref(layerId) } : {}),
  }

  const where = filters.length
    ? filters.map(f => `${f.column} ${f.op}${f.value === undefined ? '' : ` "${f.value}"`}`).join(' and ')
    : 'no filters'

  if (groupBy) {
    const grouped = groupByColumn(page.rows, groupBy)
    card.groups = grouped.groups
    const lines = grouped.groups.map(g => `${g.value}: ${g.count}`).join('\n')
    const note = grouped.truncated ? `\n(counted the first ${grouped.counted.toLocaleString()} matching rows)` : ''
    const more = grouped.distinct > grouped.groups.length ? `\n(+${grouped.distinct - grouped.groups.length} more values)` : ''
    return {
      text: `${entry.title} — ${page.total.toLocaleString()} rows match (${where}), counted by ${groupBy}:\n${lines}${more}${note}`,
      card,
    }
  }

  const sample = renderSample(page.rows, columns)
  return {
    text: `${entry.title} — ${page.total.toLocaleString()} rows match (${where}).${sample ? `\nExamples:\n${sample}` : ''}`,
    card,
  }
}

// --- Looking at a link (P5-59) -------------------------------------------------

/** One link per question. Inspecting reaches somebody else's server, and a
 *  question is about one link; a model that wants five is browsing. */
export const MAX_LINK_INSPECTIONS = 1

export const INSPECT_LINK_TOOL: Anthropic.Tool = {
  name: 'inspect_link',
  description:
    'Look at a public URL and say what is there: an ArcGIS layer or service, a Socrata dataset, a direct file (CSV, GeoJSON, zip, spreadsheet), a data-portal page listing downloads, or an ordinary web page with nothing to ingest. ' +
    'Use it when the question is about a link the reader has given or that appears in the excerpts, and answering needs to know what kind of thing it is or whether we could use it. ' +
    'It creates nothing — a person still has to drop the link.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'A public http(s) URL.' },
    },
    required: ['url'],
  },
}

/** Runs the inspector for the Ask loop. Returns errors as text the model can
 *  read, never throws — the same contract the other two runners keep. */
export async function runInspectLink(rawInput: unknown): Promise<{ text: string } | { error: string }> {
  const input = (rawInput ?? {}) as { url?: unknown }
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (!url) return { error: 'Give a public http(s) URL to look at.' }
  try {
    const inspection = await inspectUrl(url)
    const lines = [inspectionSummary(inspection), `Address looked at: ${inspection.finalUrl ?? inspection.url}`]
    if (inspection.title) lines.push(`Name: ${inspection.title}`)
    if (inspection.provider) lines.push(`Published by: ${inspection.provider}`)
    if (inspection.license) lines.push(`Terms: ${inspection.license}`)
    if (inspection.fields?.length) lines.push(`Columns: ${inspection.fields.map(f => f.name).join(', ')}`)
    if (inspection.layers?.length) lines.push(`Layers: ${inspection.layers.map(l => `${l.id} ${l.name}`).join('; ')}`)
    // P5-61: with the role and the reason each link was kept for, so an
    // answer can say WHICH of them is the data rather than listing addresses.
    if (inspection.links?.length) {
      const described = inspection.links.map(l => (l.role ? `${l.url} (${l.role}${l.reason ? ` - ${l.reason}` : ''})` : l.url))
      lines.push(`Data links on it: ${described.join('; ')}`)
      const dropped = (inspection.candidates ?? 0) - inspection.links.length
      if (dropped > 0) lines.push(`Other links on the page, left out: ${dropped}`)
    }
    if (inspection.prose?.updateCadence) lines.push(`Updated (from the page): ${inspection.prose.updateCadence}`)
    for (const note of inspection.prose?.accessNotes ?? []) {
      lines.push(`How to get it (${note.kind}): ${note.text}${note.url ? ` - ${note.url}` : ''}`)
    }
    const plan = proposeIngestPlan(inspection)
    if (plan) lines.push(`How it would come in: ${plan.plan} - ${planSummary(plan.plan, plan.mode)}`)
    if (inspection.notes?.length) lines.push(`Notes: ${inspection.notes.join(' ')}`)
    return { text: lines.join('\n') }
  } catch (err: any) {
    return { error: `That link could not be looked at: ${err?.message || 'we could not reach it'}.` }
  }
}

// --- Fetching a source for a place (P5-57) -------------------------------------

/** One fetch per question. A fetch reaches a public agency's server and costs a
 *  reader real seconds; "any Superfund sites near here?" needs one, and a model
 *  that wants five is looping. */
export const MAX_PLACE_FETCHES = 1

/** Rows shown back to the model. Enough to name every site within five miles,
 *  short enough that the answer is written from the rows and not the other way
 *  round. */
export const PLACE_SAMPLE_ROWS = 20

export const FETCH_FOR_PLACE_TOOL: Anthropic.Tool = {
  name: 'fetch_for_place',
  description:
    'Fetch the rows of an outside data source for one place — the facilities within a few miles of an address, the flood zones at a point, a county\'s row. ' +
    'Use it when the question is about a specific address, point or county AND the excerpts name a data source (kind "source") that covers it: those datasets are indexed here but not held, so the numbers do not exist until this runs. ' +
    'Give an address, a point, or a 5-digit county FIPS — one of the three. The result is cached, so asking again about the same place is free.',
  input_schema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'The source entry\'s slug, exactly as it appears in the excerpts.' },
      address: { type: 'string', description: 'A street address or place name, geocoded before anything is fetched.' },
      point: {
        type: 'object',
        description: 'Coordinates, when the question already gave them.',
        properties: { lat: { type: 'number' }, lng: { type: 'number' } },
        required: ['lat', 'lng'],
      },
      geoid: { type: 'string', description: 'A 5-digit county FIPS code.' },
      radiusMiles: { type: 'number', description: 'How far around the point to look. Defaults to what the source recommends.' },
    },
    required: ['source'],
  },
}

export interface AskPlaceCard {
  slug: string
  title: string
  /** What a person would call the place. */
  place: string
  cacheKey: string
  count: number
  adapter: string
  /** Deep link to the slice on the source entry. */
  href: string
  truncated: boolean
}

type PlaceOutcome = { text: string; card?: AskPlaceCard } | { error: string }

export function placeHref(slug: string, cacheKey: string): string {
  return `/library/${encodeURIComponent(slug)}?place=${encodeURIComponent(cacheKey)}`
}

function renderPlaceRows(rows: Record<string, string>[], columns: string[]): string {
  const shown = columns.slice(0, SAMPLE_COLUMNS)
  return rows
    .slice(0, PLACE_SAMPLE_ROWS)
    .map(row => shown.map(c => `${c}: ${truncate(row[c] ?? '', SAMPLE_CELL_CHARS)}`).join(' | '))
    .join('\n')
}

/**
 * Execute one `fetch_for_place` call.
 *
 * The same validation the route does, plus the model-specific part: every
 * refusal comes back as text the model can act on. A source nobody can fetch
 * automatically is not an error — it is the answer ("open it by hand"), so it
 * comes back as a normal result and the model relays it.
 */
export async function runFetchForPlace(rawInput: unknown, index: KbIndex): Promise<PlaceOutcome> {
  const input = isPlainObject(rawInput) ? rawInput : {}
  const slug = typeof input.source === 'string' ? input.source.trim() : ''
  if (!slug) return { error: 'fetch_for_place needs a "source" — the slug of a data source from the excerpts.' }

  const chunk = index.entryBySlug.get(slug)
  if (!chunk) {
    const known = [...index.entryBySlug.values()].filter(c => c.kind === 'source').map(c => c.slug).slice(0, 12)
    return {
      error: known.length
        ? `No source "${slug}". Data sources in the excerpts: ${known.join(', ')}.`
        : `No source "${slug}", and none of the excerpts are data sources.`,
    }
  }
  if (chunk.kind !== 'source') {
    return { error: `"${slug}" is a ${chunk.kind}, not a data source. Use query_dataset for a table we hold.` }
  }

  const point = isPlainObject(input.point) ? { lat: input.point.lat, lng: input.point.lng } : null
  if (!point && !input.geoid && typeof input.address !== 'string') {
    return { error: 'fetch_for_place needs an address, a point, or a 5-digit county geoid.' }
  }

  try {
    const result = await fetchForPlace({
      slug,
      point,
      geoid: input.geoid,
      address: input.address,
      radiusMiles: input.radiusMiles,
      actor: { id: null, username: 'ask' },
    })
    const href = placeHref(slug, result.cacheKey)
    const card: AskPlaceCard = {
      slug,
      title: chunk.title,
      place: result.place.label,
      cacheKey: result.cacheKey,
      count: result.count,
      adapter: result.adapter,
      href,
      truncated: result.truncated,
    }
    if (result.count === 0) {
      return { text: `${chunk.title} — nothing within ${result.place.radiusMiles} miles of ${result.place.label}. See ${href}`, card }
    }
    const sample = renderPlaceRows(result.rows, result.columns)
    const more = result.count > PLACE_SAMPLE_ROWS ? `\n…and ${result.count - PLACE_SAMPLE_ROWS} more.` : ''
    const cut = result.truncated ? '\nThe source had more than we kept — this is the first slice of it.' : ''
    return {
      text: `${chunk.title} — ${result.count.toLocaleString()} rows for ${result.place.label}:\n${sample}${more}${cut}\nSee ${href}`,
      card,
    }
  } catch (err) {
    if (err instanceof PlaceFetchError) {
      // "Open it by hand" is an answer, not a failure the model should retry.
      if (err.code === 'manual-only' || err.code === 'no-endpoint') {
        return { text: `${chunk.title}: ${failureText(err.code)} See ${chunk.href}` }
      }
      return { error: `Could not fetch ${chunk.title}: ${failureText(err.code)}` }
    }
    console.error('[ask] fetch_for_place failed:', (err as any)?.message || err)
    return { error: `Could not fetch ${chunk.title} right now.` }
  }
}

// --- The ask -------------------------------------------------------------------

export interface AskSource {
  n: number
  slug: string
  kind: string
  title: string
  href: string
  snippet: string
  /** Whether the answer actually cited this number (see below). */
  cited: boolean
}

export interface AskResult {
  answer: string
  sources: AskSource[]
  queries: AskQueryCard[]
  /** P5-57: places fetched while answering, each a deep link to the slice. */
  places: AskPlaceCard[]
  /** What retrieval read, for the client's "read 7 pages and 2 datasets" line. */
  counts: { pages: number; datasets: number; documents: number; notes: number }
  /** Tool calls executed (audited, and the budget's honest cost signal). */
  toolCalls: number
  usedTokens: number
  inputTokens: number
  outputTokens: number
}

/**
 * P5-58: one finding from a place report, handed to the model as an excerpt.
 *
 * The place report has already run every applicable source for one address —
 * so the numbers it needs are facts by the time the model sees them, not
 * something to go and fetch. Each item becomes a numbered excerpt AHEAD of
 * retrieval, which is what lets the summary's `[1]` point at the section on
 * the page rather than at a wiki page that happens to mention Superfund.
 */
export interface PlaceExcerpt {
  /** Identifies the finding (a source slug, `county:<geoid>`, `organizations`). */
  slug: string
  title: string
  /** Where the reader goes when they click the citation. */
  href: string
  text: string
}

export interface AskOptions {
  question: string
  dataset?: string
  client?: AnthropicLike
  index?: KbIndex
  /**
   * P5-58: findings to put in front of the retrieved excerpts. Passing any
   * TURNS THE TOOL LOOP OFF — the report already ran the fetches, and a model
   * running them again would spend the reader's seconds to maybe disagree
   * with the cards beside the prose.
   */
  placeContext?: PlaceExcerpt[]
}

/** A place finding in the shape retrieval produces, so one numbering, one
 *  citation sweep and one source list cover both kinds of excerpt. `kind` is
 *  `place`, which is what the excerpt header prints. */
export function placeChunk(item: PlaceExcerpt, index: number): KbChunk {
  return {
    id: `place:${index}`,
    slug: item.slug,
    kind: 'place',
    title: item.title,
    source: 'entry',
    text: item.text,
    href: item.href,
    layerId: null,
    // Scoring never touches these: they are given, not retrieved.
    tf: new Map(),
    titleTerms: new Set(),
    length: item.text.length,
  }
}

function textOf(message: Anthropic.Messages.Message): string {
  return message.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim()
}

function citedNumbers(answer: string): Set<number> {
  const out = new Set<number>()
  for (const match of answer.matchAll(/\[(\d{1,2})\]/g)) out.add(Number(match[1]))
  return out
}

/** Sources the reader gets: the excerpts the answer cited, keeping their
 *  numbers so every `[n]` in the text resolves. When the answer cites nothing
 *  (usually "the library doesn't cover that"), the top few excerpts ride along
 *  as leads so the reader is pointed somewhere rather than nowhere. */
export function sourcesFor(chunks: KbChunk[], answer: string): AskSource[] {
  const cited = citedNumbers(answer)
  const toSource = (chunk: KbChunk, n: number): AskSource => ({
    n,
    slug: chunk.slug,
    kind: chunk.kind,
    title: chunk.heading ? `${chunk.title} › ${chunk.heading}` : chunk.title,
    href: chunk.href,
    snippet: truncate(chunk.text, SNIPPET_CHARS),
    cited: cited.has(n),
  })
  const all = chunks.map((chunk, i) => toSource(chunk, i + 1))
  const hits = all.filter(s => s.cited)
  return hits.length > 0 ? hits : all.slice(0, 3)
}

/** Append the entries a fetch read, numbered after the excerpts so every
 *  existing `[n]` still resolves. */
export function withPlaceSources(sources: AskSource[], places: AskPlaceCard[], chunkCount: number): AskSource[] {
  const already = new Set(sources.map(s => s.slug))
  const extra = places
    .filter(p => !already.has(p.slug))
    .map((p, i) => ({
      n: chunkCount + i + 1,
      slug: p.slug,
      kind: 'source',
      title: p.title,
      href: p.href,
      snippet: `${p.count.toLocaleString()} rows fetched for ${p.place}.`,
      cited: true,
    }))
  return [...sources, ...extra]
}

/**
 * Retrieve → ask → (tool rounds) → answer. Deterministic parts (retrieval,
 * validation, links) are ours; only the prose is the model's.
 */
export async function askKb(options: AskOptions): Promise<AskResult> {
  const index = options.index ?? (await getKbIndex())
  const client = options.client ?? getClient()

  // A client-supplied slug reaches the prompt, so it is only honoured when the
  // catalog actually has it (haiku.ts's rule for client-supplied layer ids).
  const hintChunk = options.dataset ? index.entryBySlug.get(options.dataset) : undefined
  const dataset = hintChunk ? { slug: hintChunk.slug, title: hintChunk.title } : undefined

  const selection = selectContext(index, options.question, { dataset: dataset?.slug })

  // P5-58: a place report's findings lead, retrieval follows. One array from
  // here on, so `[n]` means the same thing whichever half it landed in.
  const given = (options.placeContext ?? []).map(placeChunk)
  const chunks = given.length ? [...given, ...selection.chunks] : selection.chunks
  const toolsOff = given.length > 0

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: buildAskUserMessage(options.question, chunks, dataset) },
  ]

  const queries: AskQueryCard[] = []
  const places: AskPlaceCard[] = []
  let placeFetches = 0
  let linkInspections = 0
  let inputTokens = 0
  let outputTokens = 0
  let answer = ''
  let toolCalls = 0

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS
    let message: Anthropic.Messages.Message
    try {
      message = await client.messages.create({
        model: askModel(),
        max_tokens: askMaxTokens(),
        system: buildAskSystemPrompt(),
        // On the final round the tools are withdrawn so the turn must end in
        // prose — otherwise a model that keeps querying returns no answer at
        // all. A place report withdraws them from the start: the fetches
        // already ran.
        ...(lastRound || toolsOff ? {} : { tools: [QUERY_DATASET_TOOL, FETCH_FOR_PLACE_TOOL, INSPECT_LINK_TOOL] }),
        messages,
      })
    } catch (err: unknown) {
      // Marked, not swallowed: retrieval already ran and there is no answer
      // without the model, so this still ends the request — but the caller can
      // now say WHY rather than "the answering service is having trouble".
      throw new AskModelError(err)
    }
    inputTokens += message.usage?.input_tokens ?? 0
    outputTokens += message.usage?.output_tokens ?? 0
    answer = textOf(message)

    const toolUses = message.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
    // With no tools offered there is nothing to answer, so one turn is the
    // whole conversation — stated rather than relied on from `stop_reason`.
    if (toolsOff || message.stop_reason !== 'tool_use' || toolUses.length === 0) break

    // Echo the assistant turn back verbatim (thinking blocks included) and
    // answer EVERY tool_use in one user message — splitting them teaches the
    // model to stop calling tools in parallel.
    messages.push({ role: 'assistant', content: message.content })
    const results: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const use of toolUses) {
      if (use.name === INSPECT_LINK_TOOL.name) {
        toolCalls++
        if (linkInspections >= MAX_LINK_INSPECTIONS) {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: 'Only one link may be looked at per question. Answer from what you already have.',
            is_error: true,
          })
          continue
        }
        linkInspections++
        const outcome = await runInspectLink(use.input)
        if ('error' in outcome) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.error, is_error: true })
          continue
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.text })
        continue
      }
      if (use.name === FETCH_FOR_PLACE_TOOL.name) {
        toolCalls++
        if (placeFetches >= MAX_PLACE_FETCHES) {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: 'Only one fetch for a place per question. Answer from what you already have.',
            is_error: true,
          })
          continue
        }
        placeFetches++
        const outcome = await runFetchForPlace(use.input, index)
        if ('error' in outcome) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.error, is_error: true })
          continue
        }
        if (outcome.card) places.push(outcome.card)
        results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.text })
        continue
      }
      if (use.name !== QUERY_DATASET_TOOL.name) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: `Unknown tool "${use.name}".`, is_error: true })
        continue
      }
      toolCalls++
      const outcome = await runQueryDataset(use.input, index)
      if ('error' in outcome) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.error, is_error: true })
        continue
      }
      queries.push(outcome.card)
      results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.text })
    }
    messages.push({ role: 'user', content: results })
  }

  if (!answer) {
    answer =
      chunks.length === 0
        ? 'The library does not have anything on that yet. Try different words, or drop the source in so it gets filed.'
        : 'I could not put an answer together for that one. Try asking it a shorter way.'
  }

  return {
    answer,
    // A source we actually fetched from is a source of the answer whether or
    // not the model wrote a [n] next to it, so it is appended rather than left
    // to the citation sweep.
    sources: withPlaceSources(sourcesFor(chunks, answer), places, chunks.length),
    queries,
    places,
    counts: selection.counts,
    toolCalls,
    usedTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
  }
}
