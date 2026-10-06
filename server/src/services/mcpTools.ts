import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'
import { z } from 'zod'
import publicLayerRegistry from '../prompt/publicLayers.generated.json' with { type: 'json' }
import { isLibraryEnabled } from './libraryDb.js'
import { getFile, isBucketEnabled } from './libraryBucket.js'
import { entryHref } from './kbConfig.js'
import {
  getCatalogEntry,
  getSavedView,
  getWikiPage,
  searchCatalog,
  searchCatalogPage,
  type CatalogEntryRow,
} from './libraryCatalog.js'
// Read-only imports: the MCP tools are a second front door onto the SAME
// services the app uses, never a second implementation of them.
import { getKbIndex, scoreChunks } from './kbSearch.js'
import { askKb, runQueryDataset } from './askKb.js'
import { isExtractable, isFailure, readDerived, extractFile } from './textExtract.js'
import { inspectUrl, inspectionSummary } from './linkInspect.js'
import { proposeSource } from './sourceProposal.js'
import { readinessOf } from './readiness.js'
// The name a pulled document is STORED under (P5-80), so "do we already hold
// this one?" is asked with the same rule that answered it on the way in.
import { documentFilename } from './documentPull.js'
import { proposeIngestPlan, planSummary } from './ingestPlan.js'
import { COVERAGE_SCOPE_IDS, PURPOSES, SHAPES, TOPICS, isTopicable, purposeFor, topicFor, topicLabel } from './taxonomy.js'
import { coverageMatches, NO_COVERAGE } from './coverage.js'
import { organizationLabel } from './organizations.js'
import { fieldValueOf, provenanceReport, unverifiedFields } from './provenance.js'
import type { InternalUser } from './internalSessions.js'

/**
 * The read tools the MCP server exposes (P5-50).
 *
 * Every tool is a thin wrapper over a service the web app already calls, with
 * the same validators — so an assistant cannot reach anything a logged-in
 * person could not, and a fix to a query rule fixes both surfaces at once.
 *
 * Three rules the whole file obeys:
 *  1. Results are DATA. No tool result contains instructions, advice, or
 *     anything phrased as a directive: a model reading its own tool output
 *     must not be steerable by whatever someone typed into a wiki page.
 *  2. Descriptions are written FOR A MODEL — what the tool returns and when
 *     to reach for it, not marketing.
 *  3. Failures are `McpToolError`s carrying one plain sentence. A stack trace
 *     is server internals and never crosses the wire.
 *
 * Each tool's `run` is an ordinary async function, so the suite can exercise
 * the logic directly as well as through a real MCP client.
 */

/** An expected failure — the message is shown to the caller verbatim. */
export class McpToolError extends Error {}

/** Exported for services/mcpWriteTools.ts — a write must refuse on exactly
 *  the same "is the library there at all" condition a read does. */
export function requireLibrary(): void {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    throw new McpToolError('The library is not available on this server right now.')
  }
}

// --- Deep links ----------------------------------------------------------------

/**
 * Absolute-URL prefix for links handed to a client that is NOT a browser
 * sitting on the site. Unset (the default) means relative links, which are
 * still correct inside the app; set PUBLIC_SITE_URL in a deployment so a
 * desktop assistant can open what it cites.
 */
export function publicSiteUrl(): string {
  return (process.env.PUBLIC_SITE_URL || '').replace(/\/+$/, '')
}

/** A path on the app, absolute when PUBLIC_SITE_URL says where the app is. */
export function appUrl(path: string): string {
  return `${publicSiteUrl()}${path}`
}

/** The map, restored to a saved view. Mirrors the client's `?view=` handling. */
export function viewUrl(slug: string): string {
  return appUrl(`/?view=${encodeURIComponent(slug)}`)
}

// --- Shared shapes ---------------------------------------------------------------

const slugArg = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe('The entry slug, e.g. "homesteading-fact-manual".')

function description(entry: Pick<CatalogEntryRow, 'meta'>): string {
  const value = entry.meta?.description
  return typeof value === 'string' ? value : ''
}

/** P7-7's line, as stored. Read through the field table's own accessor so the
 *  tool, the needs-a-look row and the verification queue cannot disagree about
 *  what the field says. */
function whatItAnswersOf(entry: CatalogEntryRow): string {
  return fieldValueOf(entry, 'whatItAnswers')
}

function summarize(entry: CatalogEntryRow): Record<string, unknown> {
  return {
    slug: entry.slug,
    kind: entry.kind,
    title: entry.title,
    category: entry.category,
    // P5-63: what it is ABOUT and what it is FOR, from the one taxonomy, so a
    // caller can group results the way the library itself does.
    topic: topicFor(entry.category, entry.tags),
    purpose: purposeFor(entry.category),
    // P6-1/P6-2: who published it and what kind of thing it is. The label is
    // sent beside the id because a caller writing an answer needs the words a
    // person would use ("USDA · Forest Service"), not the filing key.
    organization: entry.organization ?? '',
    organizationLabel: entry.organization ? organizationLabel(entry.organization) : '',
    shape: entry.shape ?? '',
    shapeLabel: entry.shapeLabel ?? '',
    // P6-19: where it applies, in both the words a person would say and the
    // state codes an answer can be checked against. Absent means nobody could
    // work it out — which the caller must be able to tell apart from "the
    // whole country", so it is `''` and `[]`, never `national`.
    coverage: entry.coverage?.scope ?? '',
    coverageLabel: entry.coverage?.label ?? '',
    coverageStates: entry.coverage?.states ?? [],
    status: entry.status,
    tags: entry.tags,
    description: description(entry),
    // P7-7: the one CAPABILITY field. Everything above it is descriptive —
    // who published it, what subject bucket it sits in, what shape its rows
    // are — and none of that says whether the thing bears on what was asked,
    // which is why a place report ran all forty sources (§F.4d). '' means
    // nobody has written one yet, which a caller must be able to tell apart
    // from "it answers nothing".
    whatItAnswers: whatItAnswersOf(entry),
    // P7-10: WHEN the data is from, so an answer can say how current a number
    // is. Three keys because they are three different facts and a caller
    // quoting one must not be able to mistake them:
    //   `covers`    — the period the data DESCRIBES (a 2019-2023 survey is
    //                 about 2019-2023 however recently we pulled it);
    //   `published` — when the publisher put it out, which is the one that
    //                 goes STALE;
    //   `fetched`   — when WE pulled it.
    // `''` means nobody has written one, which a caller must be able to tell
    // apart from "it is from no particular time". `updatedAt` below is NOT one
    // of these: it says when the bytes last moved.
    dates: datesOf(entry),
    href: appUrl(entryHref(entry.kind, entry.slug)),
    updatedAt: entry.updatedAt ?? null,
  }
}

/** P7-10's block, read through the field table's own accessor so the tool, the
 *  needs-a-look row and the verification queue cannot disagree. */
function datesOf(entry: CatalogEntryRow): { covers: string; published: string; fetched: string } {
  return {
    covers: fieldValueOf(entry, 'covers'),
    published: fieldValueOf(entry, 'published'),
    fetched: fieldValueOf(entry, 'fetched'),
  }
}

// --- search_library --------------------------------------------------------------

export const SEARCH_LIMIT_DEFAULT = 10
export const SEARCH_LIMIT_MAX = 50

/**
 * Two ways of matching, merged. The catalog search matches an entry's own
 * NAME (title, slug, tags, category, description); the kb index matches its
 * CONTENTS. A researcher asking "heirs property" wants both the dataset
 * called that and the page that discusses it, so name matches lead and
 * content matches fill in behind them.
 */
export async function searchLibrary(args: {
  query: string
  kind?: string
  topic?: string
  organization?: string
  shape?: string
  coverage?: string
  state?: string
  limit?: number
}): Promise<Record<string, unknown>> {
  requireLibrary()
  const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, args.limit ?? SEARCH_LIMIT_DEFAULT))
  const { entries } = await searchCatalogPage({
    q: args.query,
    kind: args.kind,
    topic: args.topic,
    organization: args.organization,
    shape: args.shape,
    coverage: args.coverage,
    state: args.state,
  })

  const results = entries.slice(0, limit).map(summarize)
  const seen = new Set(results.map(r => r.slug as string))

  if (results.length < limit) {
    const index = await getKbIndex()
    for (const { chunk } of scoreChunks(index, args.query)) {
      if (results.length >= limit) break
      if (seen.has(chunk.slug)) continue
      if (args.kind && chunk.kind !== args.kind) continue
      const entry = await getCatalogEntry(chunk.slug)
      // A chunk can outlive its catalog row between reindexes; skip rather
      // than hand back a slug that no longer opens.
      if (!entry) continue
      // The topic filter has to hold for the content matches too, or a
      // `topic=water` search quietly fills up with pages about anything.
      if (args.topic && topicFor(entry.category, entry.tags) !== args.topic) continue
      // Same for the other two narrowing arguments: a content match that does
      // not meet the filter is not a result the caller asked for.
      if (args.organization && entry.organization !== args.organization) continue
      if (args.shape && entry.shape !== args.shape) continue
      // P6-19, through the same matcher the catalog filter uses, so a page
      // whose CONTENTS mention Georgia is not handed back as a Georgia dataset.
      if (args.coverage && !coverageMatches(entry.coverage ?? null, args.coverage)) continue
      if (args.state && !coverageMatches(entry.coverage ?? null, args.state)) continue
      seen.add(chunk.slug)
      results.push({ ...summarize(entry), matchedIn: chunk.source })
    }
  }

  return { query: args.query, count: results.length, results }
}

// --- list_topics -----------------------------------------------------------------

/**
 * The library's subject spine, with a count of what is filed under each
 * (P5-63).
 *
 * The point of the tool is that "what do we have on water?" has an answer
 * before any searching happens: here are the subjects, here is how much is
 * under each, and `search_library` takes the id. Counts come from the catalog
 * the same way the Library page's facet does — the topic of an entry is its
 * category when that is a topic, otherwise the first of its tags that is one.
 */
export async function listTopics(): Promise<Record<string, unknown>> {
  requireLibrary()
  const rows = await searchCatalog({})
  const counts = new Map<string, number>()
  let uncategorised = 0
  for (const row of rows) {
    if (!isTopicable(row.kind)) continue
    const topic = topicFor(row.category, row.tags)
    if (!topic) {
      uncategorised++
      continue
    }
    counts.set(topic, (counts.get(topic) ?? 0) + 1)
  }
  return {
    topics: TOPICS.map(topic => ({
      id: topic.id,
      label: topic.label,
      description: topic.description,
      entries: counts.get(topic.id) ?? 0,
    })),
    purposes: PURPOSES.map(purpose => ({ id: purpose.id, label: purpose.label, description: purpose.description })),
    uncategorised,
  }
}

// --- get_entry -------------------------------------------------------------------

export async function getEntry(args: { slug: string }): Promise<Record<string, unknown>> {
  requireLibrary()
  const entry = await getCatalogEntry(args.slug)
  if (!entry) throw new McpToolError(`No library entry with the slug "${args.slug}".`)
  const url = typeof entry.meta.url === 'string' ? entry.meta.url : null
  return {
    ...summarize(entry),
    source: typeof entry.meta.source === 'string' ? entry.meta.source : '',
    // A link entry's whole payload is its URL; datasets and documents have files.
    url,
    files: entry.files.map(f => ({ file: fileNameOf(f.key), key: f.key, bytes: f.size })),
    bytes: entry.bytes,
    // P5-82: what this entry is ready to be used as, and whether a place
    // report can run on it. Computed when the row is read, never stored.
    readiness: entry.readiness,
    // P5-85: the document copies the library HOLDS, and how many more the
    // page offered. MCP never fetches one of those — see documentsOf.
    documents: documentsOf(entry),
    supersededBy: entry.supersededBy,
    supersedes: entry.supersedes,
    // P6-34: how each value got there — `derived` from data we hold, `model`
    // from a model's reading of prose, `person` written by hand — and which
    // of them nobody has checked yet. A surface that carries a claim outward
    // must be able to say a value is unverified: a number quoted in a data
    // story should not silently rest on a model's guess.
    provenance: provenanceReport(entry),
    unverified: unverifiedFields(entry),
    meta: entry.meta,
  }
}

/** The name a caller uses for a file: the part after `library/<kind>/<slug>/`. */
function fileNameOf(key: string): string {
  return key.split('/').slice(3).join('/') || key
}

// --- Documents an entry holds (P5-85) --------------------------------------------

/**
 * What an entry's documents look like over MCP: the copies the library
 * already HOLDS, and a count of the ones only the page has.
 *
 * MCP never fetches a document from a source URL. Pulling documents in is a
 * decision a person makes in the app (`pullDocuments`, P5-80), where the
 * fetch guard, the byte budget and the filing all live; a tool that did it on
 * a model's say-so would turn a read token into a crawler. So the record says
 * what is here, says how many more the page offered, and stops there.
 */
export const DOCUMENTS_NOTE = 'Pulling documents in is done in the app; MCP reads only what the library already holds.'

export interface HeldDocument {
  file: string
  bytes: number
  /** Whether the text extractor can read this type — the same test the
   *  readiness verdict counts readable files with. */
  readable: boolean
}

export interface EntryDocuments {
  held: HeldDocument[]
  /** Documents on the page that are NOT already held, by address or by name. */
  offered: number
  note: string
}

/** One offer read back off the manifest. Structural and defensive: this is
 *  JSON from the bucket, and only `url` and `label` are ever looked at. */
interface OfferedDocument {
  url: string
  label: string
}

/** The documents the last inspection found on the page (P5-80). */
function offeredDocuments(meta: Record<string, unknown>): OfferedDocument[] {
  const inspection = meta.inspection
  if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection)) return []
  const raw = (inspection as Record<string, unknown>).documents
  if (!Array.isArray(raw)) return []
  const out: OfferedDocument[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { url, label } = item as { url?: unknown; label?: unknown }
    if (typeof url === 'string' && url) out.push({ url, label: typeof label === 'string' ? label : '' })
  }
  return out
}

/** The addresses a pull already brought in, from the manifest's lineage
 *  records (`pulledDocuments[].from`). */
function pulledFrom(meta: Record<string, unknown>): Set<string> {
  const raw = meta.pulledDocuments
  if (!Array.isArray(raw)) return new Set()
  const out = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { from } = item as { from?: unknown }
    if (typeof from === 'string' && from) out.add(from)
  }
  return out
}

/** The name a pull would store this document under, or null when its address
 *  is not one a filename can be made from. */
function storedNameFor(doc: OfferedDocument): string | null {
  try {
    return documentFilename(doc.label, doc.url)
  } catch {
    return null
  }
}

/**
 * The entry's own files, and how many of the page's documents are missing
 * from them.
 *
 * Two ways a document counts as held: the manifest records it was pulled from
 * that address, or a file already carries the name a pull would give it — the
 * second catches a copy that arrived by hand or by CLI push, the first catches
 * one that was renamed on the way in.
 */
export function documentsOf(entry: Pick<CatalogEntryRow, 'meta' | 'files'>): EntryDocuments {
  const held: HeldDocument[] = []
  for (const f of entry.files) {
    const file = fileNameOf(f.key)
    // The manifest is filing, not content: it is never a document a caller
    // can read (the rule read_document and the readiness verdict both apply).
    if (file === 'meta.json') continue
    held.push({ file, bytes: f.size, readable: isExtractable(file) })
  }

  const names = new Set(held.map(f => f.file.toLowerCase()))
  const from = pulledFrom(entry.meta)
  const isHeld = (doc: OfferedDocument): boolean => {
    if (from.has(doc.url)) return true
    const name = storedNameFor(doc)
    return !!name && names.has(name.toLowerCase())
  }

  return { held, offered: offeredDocuments(entry.meta).filter(doc => !isHeld(doc)).length, note: DOCUMENTS_NOTE }
}

// --- read_page -------------------------------------------------------------------

export async function readPage(args: { slug: string }): Promise<Record<string, unknown>> {
  requireLibrary()
  const page = await getWikiPage(args.slug)
  if (!page) throw new McpToolError(`No wiki page with the slug "${args.slug}".`)
  return { slug: page.slug, title: page.title, markdown: page.markdown, href: appUrl(`/wiki/${page.slug}`) }
}

// --- read_document ---------------------------------------------------------------

/** Extensions whose bytes ARE the text. Everything else needs extraction. */
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yml', 'yaml'])
/** Characters returned for one document. Past this the caller should query
 *  the dataset or read the page instead of streaming a file through a model. */
export const DOCUMENT_MAX_CHARS = 100_000

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

export async function readDocument(args: { slug: string; file?: string }): Promise<Record<string, unknown>> {
  requireLibrary()
  const entry = await getCatalogEntry(args.slug)
  if (!entry) throw new McpToolError(`No library entry with the slug "${args.slug}".`)
  if (entry.files.length === 0) throw new McpToolError(`"${args.slug}" has no files.`)

  const wanted = args.file?.trim()
  // Default to the entry's CONTENT, not its filing. `meta.json` sorts first
  // in most entries and is the manifest — get_entry already reports it, and a
  // caller asking to "read the document" never means the manifest.
  const contentFiles = entry.files.filter(f => fileNameOf(f.key) !== 'meta.json')
  const match = wanted
    ? entry.files.find(f => fileNameOf(f.key) === wanted || f.key === wanted)
    : (contentFiles[0] ?? entry.files[0])
  if (!match) {
    const names = entry.files.map(f => fileNameOf(f.key)).join(', ')
    throw new McpToolError(`"${args.slug}" has no file named "${wanted}". Files: ${names}.`)
  }

  const name = fileNameOf(match.key)
  const ext = extensionOf(name)
  const downloadNote = `Download it at ${appUrl(`/api/library/file/${encodeURIComponent(args.slug)}/${encodeURIComponent(name)}`)}`
  if (!TEXT_EXTENSIONS.has(ext)) {
    if (!isExtractable(name)) {
      // Images, archives, spreadsheets: nothing to read as text.
      return { slug: args.slug, file: name, bytes: match.size, text: null, textAvailable: false, note: `There is no text to pull out of a .${ext || 'unknown'} file. ${downloadNote}` }
    }
    // PDFs, Word and RTF go through the extraction service (P5-46): the
    // stored text is reused when it matches the current file size, otherwise
    // it is extracted now — the same staleness rule the text route applies.
    const stored = await readDerived(args.slug, name)
    const derived = stored && stored.sourceSize === match.size ? stored : await extractFile(args.slug, name, match.key, match.size)
    if (isFailure(derived)) {
      return { slug: args.slug, file: name, bytes: match.size, text: null, textAvailable: false, note: `Text could not be extracted: ${derived.error} ${downloadNote}` }
    }
    const joined = derived.pages.length > 1
      ? derived.pages.map(p => `— page ${p.n} —\n${p.text}`).join('\n\n')
      : (derived.pages[0]?.text ?? '')
    const truncated = joined.length > DOCUMENT_MAX_CHARS
    return {
      slug: args.slug,
      file: name,
      bytes: match.size,
      pages: derived.pages.length,
      text: truncated ? joined.slice(0, DOCUMENT_MAX_CHARS) : joined,
      textAvailable: true,
      truncated,
      ...(truncated ? { note: `Truncated to the first ${DOCUMENT_MAX_CHARS.toLocaleString()} characters of ${joined.length.toLocaleString()}.` } : {}),
    }
  }

  const buf = await getFile(match.key)
  const full = buf.toString('utf8')
  const truncated = full.length > DOCUMENT_MAX_CHARS
  return {
    slug: args.slug,
    file: name,
    bytes: match.size,
    text: truncated ? full.slice(0, DOCUMENT_MAX_CHARS) : full,
    textAvailable: true,
    truncated,
    ...(truncated
      ? { note: `Truncated to the first ${DOCUMENT_MAX_CHARS.toLocaleString()} characters of ${full.length.toLocaleString()}.` }
      : {}),
  }
}

// --- query_dataset ---------------------------------------------------------------

/**
 * The P5-41 tool, unchanged. `runQueryDataset` already validates the slug,
 * every filter and the group-by column against the file's real columns, and
 * returns its refusals as readable strings — exactly what a model needs.
 */
export async function queryDataset(args: {
  slug: string
  filters?: unknown[]
  groupBy?: string
  limit?: number
}): Promise<Record<string, unknown>> {
  requireLibrary()
  const outcome = await runQueryDataset(args, await getKbIndex())
  if ('error' in outcome) throw new McpToolError(outcome.error)
  const { card, text } = outcome
  return {
    slug: card.slug,
    title: card.title,
    filters: card.filters,
    ...(card.groupBy ? { groupBy: card.groupBy } : {}),
    ...(card.groups ? { groups: card.groups } : {}),
    rowCount: card.rowCount,
    summary: text,
    href: appUrl(card.href),
    ...(card.mapHref ? { mapHref: appUrl(card.mapHref) } : {}),
  }
}

// --- Layers ------------------------------------------------------------------------

export interface PublicLayerRecord {
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
  /** Path under the site's public root, e.g. `/datasets/housing/x.csv`. */
  dataPath: string
  /** Column (CSV) or record field (JSON) holding this layer's value. */
  valueColumn: string
}

export const PUBLIC_LAYERS = publicLayerRegistry as PublicLayerRecord[]

function layerSummary(layer: PublicLayerRecord): Record<string, unknown> {
  return {
    id: layer.id,
    name: layer.name,
    category: layer.category,
    description: layer.description,
    unit: layer.unit,
    dataType: layer.dataType,
    direction: layer.direction,
    range: layer.range,
    source: layer.source,
    sourceUrl: layer.sourceUrl,
    year: layer.year,
    href: appUrl(`/layers/${encodeURIComponent(layer.id)}`),
    mapHref: appUrl(`/?layers=${encodeURIComponent(layer.id)}`),
  }
}

export async function listLayers(): Promise<Record<string, unknown>> {
  return { count: PUBLIC_LAYERS.length, layers: PUBLIC_LAYERS.map(layerSummary) }
}

export async function getLayer(args: { id: string }): Promise<Record<string, unknown>> {
  const layer = PUBLIC_LAYERS.find(l => l.id === args.id)
  if (!layer) {
    throw new McpToolError(`No public map layer with the id "${args.id}". Call list_layers for the ids.`)
  }
  return layerSummary(layer)
}

// --- county_values -----------------------------------------------------------------

export const COUNTY_VALUES_MAX = 200
/** Parsed layer files held in memory. Each is a county-sized map (~3k rows);
 *  a handful is a few MB, and re-parsing a CSV per tool call is the thing
 *  worth avoiding. Oldest entry is dropped when the cap is reached. */
export const LAYER_CACHE_MAX_FILES = 6
const layerCache = new Map<string, Record<string, number | string>>()

/** Tests (and a data refresh) need to forget what was parsed. */
export function clearLayerValueCache(): void {
  layerCache.clear()
}

/** 5-digit county FIPS from the spellings these files use. Same rule as
 *  services/internalLayers.ts `normalizeGeoId`, applied to public files. */
export function normalizeGeoid(raw: unknown): string | null {
  const t = String(raw ?? '').trim()
  const affgeoid = /US(\d{5})$/.exec(t)
  if (affgeoid) return affgeoid[1]
  if (/^\d{1,5}$/.test(t)) return t.padStart(5, '0')
  return null
}

function numberOrString(raw: unknown): number | string | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : t
}

/** GEOID column in a public dataset CSV: they all ship one, spelled `GEOID`
 *  or `fips`, so a header match is enough and guessing is not needed. */
export function pickGeoidColumn(columns: string[]): string | null {
  const byName = columns.find(c => /^(geo_?id|fips|county_?fips)$/i.test(c.trim()))
  return byName ?? null
}

/** `{ GEOID → value }` from a CSV's text. Exported for the suite: the
 *  file-reading half below is environment, this half is the logic. */
export function parseLayerCsv(text: string, valueColumn: string): Record<string, number | string> {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  })
  const columns = parsed.meta.fields ?? []
  const geoColumn = pickGeoidColumn(columns)
  if (!geoColumn) {
    throw new McpToolError(`That layer's file has no GEOID column (columns: ${columns.join(', ')}).`)
  }
  if (!columns.includes(valueColumn)) {
    throw new McpToolError(`That layer's file has no "${valueColumn}" column (columns: ${columns.join(', ')}).`)
  }
  const values: Record<string, number | string> = {}
  for (const row of parsed.data) {
    const geoid = normalizeGeoid(row[geoColumn])
    const value = numberOrString(row[valueColumn])
    if (geoid === null || value === null) continue
    values[geoid] = value
  }
  return values
}

/** `{ GEOID → value }` from a JSON file keyed by GEOID — the precomputed
 *  score and contamination files, whose records are objects (or, for the
 *  simplest ones, a bare number). */
export function parseLayerJson(text: string, valueColumn: string): Record<string, number | string> {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new McpToolError("That layer's data file could not be read.")
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new McpToolError("That layer's data file is not keyed by county.")
  }
  const values: Record<string, number | string> = {}
  for (const [key, record] of Object.entries(doc as Record<string, unknown>)) {
    const geoid = normalizeGeoid(key)
    if (geoid === null) continue
    const raw =
      record && typeof record === 'object' && !Array.isArray(record)
        ? (record as Record<string, unknown>)[valueColumn]
        : record
    const value = numberOrString(raw)
    if (value === null) continue
    values[geoid] = value
  }
  return values
}

/**
 * Where a layer's numbers come from. The datasets are static files served by
 * the site, and in a normal checkout they sit right next to the server
 * package — so read the disk first (no network, always current with the repo)
 * and fall back to the deployed site when the server runs without them
 * (a container built from server/ alone).
 */
async function loadLayerFile(dataPath: string): Promise<string> {
  const relative = dataPath.replace(/^\/+/, '')
  const local = fileURLToPath(new URL(`../../../public/${relative}`, import.meta.url))
  try {
    return await readFile(local, 'utf8')
  } catch {
    /* not in this deployment — try the site */
  }
  const site = publicSiteUrl()
  if (!site) {
    throw new McpToolError(
      'County values are unavailable on this server: the dataset files are not present and PUBLIC_SITE_URL is not configured.',
    )
  }
  const res = await fetch(`${site}/${relative}`)
  if (!res.ok) throw new McpToolError(`That layer's data file could not be fetched (${res.status}).`)
  return await res.text()
}

async function layerValues(layer: PublicLayerRecord): Promise<Record<string, number | string>> {
  const cached = layerCache.get(layer.id)
  if (cached) return cached
  const text = await loadLayerFile(layer.dataPath)
  const values = layer.dataPath.toLowerCase().endsWith('.json')
    ? parseLayerJson(text, layer.valueColumn)
    : parseLayerCsv(text, layer.valueColumn)
  if (layerCache.size >= LAYER_CACHE_MAX_FILES) {
    const oldest = layerCache.keys().next().value
    if (oldest !== undefined) layerCache.delete(oldest)
  }
  layerCache.set(layer.id, values)
  return values
}

export async function countyValues(args: { layerId: string; geoids: string[] }): Promise<Record<string, unknown>> {
  const layer = PUBLIC_LAYERS.find(l => l.id === args.layerId)
  if (!layer) {
    throw new McpToolError(`No public map layer with the id "${args.layerId}". Call list_layers for the ids.`)
  }
  if (args.geoids.length === 0) throw new McpToolError('Pass at least one 5-digit county GEOID.')
  if (args.geoids.length > COUNTY_VALUES_MAX) {
    throw new McpToolError(`county_values reads at most ${COUNTY_VALUES_MAX} counties at a time.`)
  }
  const values = await layerValues(layer)
  // A county with no value is reported as null rather than dropped: "we have
  // no number for this one" is the answer to half the questions asked here.
  const rows = args.geoids.map(raw => {
    const geoid = normalizeGeoid(raw)
    return {
      geoid: geoid ?? String(raw),
      value: geoid === null ? null : (values[geoid] ?? null),
      ...(geoid === null ? { note: 'not a 5-digit county GEOID' } : {}),
    }
  })
  return {
    layerId: layer.id,
    layer: layer.name,
    unit: layer.unit,
    direction: layer.direction,
    source: layer.source,
    year: layer.year,
    counties: rows,
    found: rows.filter(r => r.value !== null).length,
  }
}

// --- Saved views ---------------------------------------------------------------------

export async function listViews(): Promise<Record<string, unknown>> {
  requireLibrary()
  const entries = await searchCatalog({ kind: 'view' })
  const views = entries.map(e => ({
    slug: e.slug,
    name: e.title,
    savedBy: typeof e.meta.savedBy === 'string' ? e.meta.savedBy : '',
    savedAt: typeof e.meta.savedAt === 'string' ? e.meta.savedAt : '',
    resultCount: typeof e.meta.resultCount === 'number' ? e.meta.resultCount : 0,
    layers: Array.isArray(e.meta.layers) ? e.meta.layers : [],
    href: viewUrl(e.slug),
  }))
  views.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  return { count: views.length, views }
}

export async function getView(args: { slug: string }): Promise<Record<string, unknown>> {
  requireLibrary()
  const view = await getSavedView(args.slug)
  if (!view) throw new McpToolError(`No saved view with the slug "${args.slug}".`)
  return {
    slug: view.slug,
    name: view.name,
    savedBy: view.savedBy,
    savedAt: view.savedAt,
    state: view.state,
    results: view.results,
    href: viewUrl(view.slug),
  }
}

// --- ask ---------------------------------------------------------------------------

export const ASK_QUESTION_MAX = 500

export async function ask(args: { question: string }): Promise<Record<string, unknown>> {
  requireLibrary()
  const question = args.question.trim()
  if (question.length < 3) throw new McpToolError('Ask a question — a few words at least.')
  if (question.length > ASK_QUESTION_MAX) {
    throw new McpToolError(`That question is too long (${ASK_QUESTION_MAX} characters max).`)
  }
  let result
  try {
    result = await askKb({ question })
  } catch (err) {
    console.error('[mcp] ask failed:', (err as Error)?.message || err)
    throw new McpToolError('The answering service is unavailable right now.')
  }
  return {
    answer: result.answer,
    sources: result.sources.map(s => ({ ...s, href: appUrl(s.href) })),
    queries: result.queries.map(q => ({ ...q, href: appUrl(q.href) })),
    read: result.counts,
  }
}

// --- The tool table ------------------------------------------------------------------

/**
 * Who is calling, for the tools that need to know (P5-52 writes). Read tools
 * ignore it — nothing they return depends on who asked.
 */
export interface McpToolContext {
  user: InternalUser
  /**
   * The program doing the work, in words: an OAuth client's registered
   * `client_name` ("ChatGPT"), or a personal token's own name ("Claude
   * Desktop — laptop"). Every write records it as `detail.via`, which is what
   * puts "via ChatGPT" on the activity feed.
   */
  via: string
  /** The caller's address, so a fetch's model budget bills where a browser
   *  drop would have. */
  clientIp?: string
}

export interface McpToolDefinition {
  name: string
  title: string
  description: string
  /** Zod raw shape — the SDK turns it into the JSON Schema clients see. */
  inputSchema: z.ZodRawShape
  /** P5-52: this tool changes the library. It needs the `write` scope and is
   *  annotated `readOnlyHint: false` so a host can prompt before running it. */
  write?: boolean
  /** Running it twice with the same arguments leaves the same result. */
  idempotent?: boolean
  /** P5-59: this tool reaches a server outside this one, so a host is told
   *  `openWorldHint: true` — the same annotation `fetch_for_place` carries. */
  openWorld?: boolean
  run: (args: any, ctx: McpToolContext) => Promise<unknown>
}

/**
 * "What is this link, and can we use it?" (P5-59).
 *
 * Read-only in the sense that matters: it creates NOTHING. No entry, no
 * manifest, no plan — an assistant can look at a URL a person pasted into a
 * chat and say what it is and how it would come in, and the researcher still
 * has to drop it. It does reach the outside world, hence the annotation.
 */
export async function inspectLink(args: { url?: unknown }, _ctx: McpToolContext): Promise<Record<string, unknown>> {
  const raw = typeof args?.url === 'string' ? args.url.trim() : ''
  if (!raw) throw new McpToolError('Give a public http(s) URL to look at.')
  const inspection = await inspectUrl(raw)
  // P5-82: the same verdict the catalog puts on a row, for a link that is not
  // an entry yet — asked of a row made up on the spot from this inspection.
  const readiness = readinessOf({ kind: 'incoming', meta: { inspection }, files: [] })
  if (inspection.kind === 'unreachable') {
    return {
      kind: 'unreachable',
      summary: inspectionSummary(inspection),
      notes: inspection.notes ?? [],
      readiness,
      checkedAt: inspection.checkedAt,
    }
  }
  const proposal = proposeSource(inspection)
  const plan = proposeIngestPlan(inspection)
  return {
    kind: inspection.kind,
    confidence: inspection.confidence,
    summary: inspectionSummary(inspection),
    title: inspection.title,
    provider: inspection.provider,
    endpoint: inspection.finalUrl,
    geometry: inspection.geometry,
    rowCount: inspection.rowCount,
    formats: inspection.formats,
    fields: (inspection.fields ?? []).map(f => f.name),
    layers: inspection.layers,
    // P5-61: each kept link now carries the role and the reason it survived
    // the prune, and the raw count says how many were left out.
    links: inspection.links,
    candidates: inspection.candidates,
    pruned: inspection.pruned,
    /** P5-61: what the page's prose said, when the page was prose. */
    readFromThePage: inspection.prose,
    license: inspection.license,
    updateCadence: inspection.cadence,
    notes: inspection.notes ?? [],
    suggestedSource: proposal.source,
    inferred: proposal.inferred,
    /** P5-61: the sentence behind each field read from words. */
    evidence: proposal.evidence,
    suggestedPlan: plan ? { ...plan, whatHappensNext: planSummary(plan.plan, plan.mode) } : null,
    readiness,
    checkedAt: inspection.checkedAt,
  }
}

const filterSchema = z
  .object({
    column: z.string().describe('A column name from the table, spelled exactly.'),
    op: z.enum(['eq', 'contains', 'gte', 'lte', 'empty', 'notEmpty']),
    value: z.string().optional().describe('The value to compare against (not needed for empty / notEmpty).'),
  })
  .describe('One condition a row must meet.')

/** Zod wants a non-empty tuple; the taxonomy is a plain array. */
const TOPIC_ENUM = TOPICS.map(t => t.id) as [string, ...string[]]
const SHAPE_ENUM = SHAPES.map(s => s.id) as [string, ...string[]]
/** P6-19: the scopes, plus the word for the rows nothing could place. A STATE
 *  is not in here — it goes in `state`, which takes any of its spellings. */
const COVERAGE_ENUM = [NO_COVERAGE, ...COVERAGE_SCOPE_IDS] as [string, ...string[]]

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'search_library',
    title: 'Search the library',
    description:
      'Search the internal research library by name and by contents. Returns matching entries — wiki pages, datasets, documents, notes, saved views, and data sources (pointers to datasets held elsewhere, with how to query them for a place) — each with its slug, kind, title, category, who published it (organization), what kind of thing it is (shape), how much ground it covers (coverage, coverageLabel, coverageStates), a one-line description, a link, and "whatItAnswers": one line naming a question that dataset can answer. Choose between results on whatItAnswers where they have one — it is the only field that says what the data can be ASKED, rather than what subject it belongs to — and treat it as a claim no person may have checked (get_entry says which values are unverified). An empty whatItAnswers means nobody has written one, not that the dataset answers nothing. Each result also carries "dates": when the data is from, as three separate facts — "covers" is the period the data DESCRIBES (a 2019-2023 survey is about 2019-2023 however recently we pulled it), "published" is when the publisher put it out, and "fetched" is when we pulled it. Say which one you are quoting, and never read "updatedAt" as a date about the data: it is when the bytes last moved in our own storage, so re-pushing a 2019 file moves it to today. "covers" being old is not a problem; "published" being old on something that claims to be current IS, and is worth saying out loud. Use this first when you do not already know the slug of the thing you need. To answer "what do we have for Georgia?", pass state="GA" — that returns the entries whose own ground includes Georgia; nationwide datasets are deliberately NOT among them, so ask again with coverage="national" when the answer should include those too.',
    inputSchema: {
      query: z.string().trim().min(1).max(200).describe('Words to search for.'),
      kind: z
        .enum(['wiki', 'dataset', 'document', 'note', 'view', 'incoming', 'link', 'source', 'working-set'])
        .optional()
        .describe('Restrict to one kind of entry.'),
      topic: z
        .enum(TOPIC_ENUM)
        .optional()
        .describe('Restrict to one subject. Call list_topics for the ids, what each covers, and how much is filed under it.'),
      organization: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe('Restrict to one publisher, by the id every result carries as "organization" (e.g. "epa", "usda-fs").'),
      shape: z
        .enum(SHAPE_ENUM)
        .optional()
        .describe(
          'Restrict to one kind of dataset: areas (areas and boundaries), points (sites with coordinates), statistics (values by county or tract), records (a table with no location).',
        ),
      coverage: z
        .enum(COVERAGE_ENUM)
        .optional()
        .describe(
          'Restrict by how much ground it covers: national (the whole country), multi-state, state (one state), county, local, or none (the entries whose ground nobody has been able to work out). For a PARTICULAR state use `state` instead.',
        ),
      state: z
        .string()
        .trim()
        .min(2)
        .max(40)
        .optional()
        .describe(
          'Restrict to the entries covering one state, written however you like: "GA", "Georgia" or the FIPS "13". Matches an entry whose coverage includes that state, whether it is all it covers or one of twenty-six. Nationwide entries are not matched — ask for coverage="national" as well if the answer should include them.',
        ),
      limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional().describe(`Results to return (default ${SEARCH_LIMIT_DEFAULT}).`),
    },
    run: searchLibrary,
  },
  {
    name: 'list_topics',
    title: 'List library topics',
    description:
      'The subjects the internal library files everything under: id, plain-word label, what each covers, and how many entries carry it. Also lists the four purposes (strategy, research, outreach, ideas), which say what a document is FOR rather than what it is about. Use the ids with search_library\'s "topic" argument.',
    inputSchema: {},
    run: listTopics,
  },
  {
    name: 'get_entry',
    title: 'Get a library entry',
    description:
      'Full catalog record for one library entry by slug: title, kind, category, status, tags, description, source, the files it holds (with names and sizes), any URL, supersession pointers to and from other entries, a readiness verdict (what the entry is ready to be used as, and whether a place report can run on it), "documents": the document copies the library already holds (with whether each can be read as text) and a count of the ones only the source page has, "whatItAnswers" (one line naming a question this data can answer), "dates" (covers: the period the data describes; published: when the publisher put it out; fetched: when we pulled it — never "updatedAt", which is when the bytes last moved), and "provenance"/"unverified": how each of topic, organization, coverage, type, summary, the answers line and the two dates got onto the entry ("derived" from data the library holds, "model" from a model\'s reading of its prose, "person" written by hand) and which of them nobody has checked yet. Say so when you quote a value listed in "unverified" — it is a machine\'s reading that no person has confirmed. Read the body of a wiki page with read_page and of a held file with read_document; a document that is only offered cannot be read here, because pulling one in happens in the app.',
    inputSchema: { slug: slugArg },
    run: getEntry,
  },
  {
    name: 'read_page',
    title: 'Read a wiki page',
    description: 'The full markdown source of one internal wiki page, by slug.',
    inputSchema: { slug: slugArg },
    run: readPage,
  },
  {
    name: 'read_document',
    title: 'Read a document file',
    description:
      'The text of one file held by a library entry. Plain-text formats (txt, md, csv, json, yaml) come back as-is; PDFs come back page by page ("— page N —" separators), Word and RTF files as extracted text; all truncated past 100,000 characters. Scanned PDFs and images have no text and say so with a download link. Omit "file" to read the entry\'s first file.',
    inputSchema: {
      slug: slugArg,
      file: z.string().trim().max(200).optional().describe('File name as listed by get_entry.'),
    },
    run: readDocument,
  },
  {
    name: 'query_dataset',
    title: 'Query a dataset',
    description:
      'Count or list rows in one of the library data tables. Use it whenever the question asks how many, which ones, or for a breakdown by category — never estimate those from an excerpt. Returns the number of matching rows, a sample or a per-value count, and a link to the same query in the table explorer.',
    inputSchema: {
      slug: z.string().trim().min(1).max(120).describe('The dataset slug.'),
      filters: z.array(filterSchema).optional().describe('Conditions rows must meet. Omit for the whole table.'),
      groupBy: z.string().trim().optional().describe('A column name to count rows by.'),
      limit: z.number().int().min(1).max(20).optional().describe('How many example rows to return (default 8).'),
    },
    run: queryDataset,
  },
  {
    name: 'list_layers',
    title: 'List map layers',
    description:
      'Every county layer on the public map: id, name, category, what it measures, its unit, its range, which direction is better, and where the data came from.',
    inputSchema: {},
    run: listLayers,
  },
  {
    name: 'get_layer',
    title: 'Get a map layer',
    description: 'One public map layer by id, with its description, unit, range, direction, source and links.',
    inputSchema: { id: z.string().trim().min(1).max(80).describe('Layer id, e.g. "pct_Black".') },
    run: getLayer,
  },
  {
    name: 'county_values',
    title: 'County values for a layer',
    description: `One layer's value for specific counties, by 5-digit GEOID (FIPS). Up to ${COUNTY_VALUES_MAX} counties per call. A county the layer has no number for comes back with a null value.`,
    inputSchema: {
      layerId: z.string().trim().min(1).max(80).describe('Layer id from list_layers.'),
      geoids: z
        .array(z.string().trim().min(1).max(20))
        .min(1)
        .max(COUNTY_VALUES_MAX)
        .describe('5-digit county GEOIDs, e.g. ["47157", "01001"].'),
    },
    run: countyValues,
  },
  {
    name: 'list_views',
    title: 'List saved map views',
    description:
      'Saved map views: named snapshots of layers, weights, filters and viewport. Each carries a link that opens the map with that view restored.',
    inputSchema: {},
    run: listViews,
  },
  {
    name: 'get_view',
    title: 'Get a saved map view',
    description:
      'One saved map view by slug: who saved it and when, its full definition (layers and weights, filters, region, viewport), its snapshotted result rows, and a link that opens the map with it restored.',
    inputSchema: { slug: slugArg },
    run: getView,
  },
  {
    name: 'ask',
    title: 'Ask the library',
    description:
      'A cited answer drawn from the whole library. The server retrieves the relevant pages, documents and dataset schemas, runs any dataset queries the answer needs, and returns prose with numbered citations plus the sources those numbers point at. Slower and more expensive than the other tools — reach for it for a broad question, not to fetch a known page.',
    inputSchema: {
      question: z.string().trim().min(3).max(ASK_QUESTION_MAX).describe('A research question, one thing at a time.'),
    },
    run: ask,
  },
  {
    name: 'inspect_link',
    title: 'Look at a link',
    description:
      'Work out what is at a public URL and how it could come into the library: an ArcGIS layer or service, a Socrata dataset, a direct file (CSV, GeoJSON, zip, spreadsheet), a data-portal page listing downloads, or an ordinary web page with nothing to ingest. Returns the classification, the columns and coverage where the service reports them, a proposed data-source block, the ingest plan that would be suggested, and a readiness verdict (what a drop of this link would be ready as, and whether a place report could run on it). It creates nothing — use drop_link to actually file the link.',
    inputSchema: {
      url: z.string().trim().min(1).max(2048).describe('A public http(s) URL.'),
    },
    openWorld: true,
    run: inspectLink,
  },
]

// --- Resources -------------------------------------------------------------------------

export const RESOURCE_LIST_MAX = 200

/** `library://page/<slug>` — a wiki page's markdown. */
export async function listPageResources(): Promise<{ uri: string; name: string; mimeType: string }[]> {
  requireLibrary()
  const entries = await searchCatalog({ kind: 'wiki' })
  return entries.slice(0, RESOURCE_LIST_MAX).map(e => ({
    uri: `library://page/${e.slug}`,
    name: e.title || e.slug,
    mimeType: 'text/markdown',
  }))
}

/** `library://entry/<slug>` — a catalog record as JSON. */
export async function listEntryResources(): Promise<{ uri: string; name: string; mimeType: string }[]> {
  requireLibrary()
  const entries = await searchCatalog({})
  return entries.slice(0, RESOURCE_LIST_MAX).map(e => ({
    uri: `library://entry/${e.slug}`,
    name: e.title || e.slug,
    mimeType: 'application/json',
  }))
}
