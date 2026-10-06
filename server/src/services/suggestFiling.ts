import { promises as fs } from 'node:fs'
import { getCatalogEntry, type CatalogEntryRow } from './libraryCatalog.js'
import { ensureMirrored } from './libraryBucket.js'
import { extractFile, extractableFiles, readDerived, isFailure, extractMaxBytes, basenameInEntry } from './textExtract.js'
import { parseInspection, inspectionText } from './linkInspect.js'
import { askModel } from './askKb.js'
import {
  callAssistant,
  isAssistantError,
  jsonObjectIn,
  type AnthropicLike,
  type AssistantFailureCode,
} from './assistantCall.js'
import { CATEGORY_IDS, CROSS_TAGS, PURPOSES, TOPICS, normalizeCategory, normalizeTag } from './taxonomy.js'

/**
 * Propose how to file a dropped document (P5-47).
 *
 * A research intern drops a link or a file; the server fetches it, pulls its
 * text (P5-46), and asks the model for a title, a category, tags and a short
 * summary. The proposal is stored on the entry and NEVER applied — an admin
 * reads it, presses Apply, edits if they like, and files. That "never applied"
 * rule is the whole design: everything here is a suggestion box, so a model
 * that misreads a document costs a click, not a mis-filed record.
 */

/** Characters of the document the model sees. The first pages carry the title
 *  page, the abstract and the table of contents — which is what filing needs —
 *  and a cap keeps the cost of a 400-page PDF the same as a memo's. */
export const SUGGEST_TEXT_CHARS = 6_000

/** Short by design: this is four fields, not an essay. */
export function suggestMaxTokens(): number {
  const raw = Number(process.env.LIBRARY_SUGGEST_MAX_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 400
}

export const TITLE_MAX_CHARS = 160
export const SUMMARY_MAX_CHARS = 600
export const MAX_TAGS = 6

/**
 * The ids a filing may use: the taxonomy's topics and purposes (P5-63).
 *
 * This used to be a hand-kept list of twelve words UNION whatever the catalog
 * happened to be using, on the reasoning that categories were free strings
 * that evolve. They evolved into three vocabularies that did not agree, which
 * is the ticket. There is now one list, it is generated from
 * `src/config/taxonomy.ts`, and a word outside it is not a category — the
 * validator drops it rather than minting a thirteenth. A new subject is added
 * by editing the taxonomy and re-running `npm run export:layers`, which is a
 * deliberate act and reviewable in one place.
 */
export async function knownCategories(): Promise<string[]> {
  return [...CATEGORY_IDS]
}

export interface Suggestion {
  title?: string
  category?: string
  tags?: string[]
  summary?: string
  /** When it was proposed. */
  at: string
  /** Which model proposed it, so an old suggestion can be read in context. */
  model: string
  /** P5-59: set when the model was shown the first 64 kB of the file rather
   *  than its extracted text — a 26 MB CSV is over the extraction cap, and a
   *  head is far better than the nothing it used to get. */
  basis?: 'head'
}

export interface SuggestionError {
  error: 'unavailable'
  at: string
  /**
   * P5-75: WHY, when the model call itself failed. The pass is asynchronous,
   * so there is no response to put it in — it is recorded here, and the entry
   * can tell "nobody set a key" apart from "the account is out of credit".
   * Absent when the model answered but the answer was unusable.
   */
  reason?: AssistantFailureCode
}

export type SuggestOutcome = Suggestion | SuggestionError

export function isSuggestionError(value: SuggestOutcome): value is SuggestionError {
  return (value as SuggestionError).error === 'unavailable'
}

// --- Validation -----------------------------------------------------------

/** Lowercase kebab: "Flood Risk" → "flood-risk". Anything left that is not a
 *  word or a hyphen means the model wrote something we will not store. */
export function cleanTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const tag = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(tag) && tag.length <= 40 ? tag : null
}

/** Shared with P5-61's link prune, which parses the same kind of answer. */
export { jsonObjectIn }

/**
 * Model output → a suggestion, strictly. Every field is optional and each is
 * dropped on its own: an unknown category or an over-long summary loses that
 * field, not the whole proposal. Returns null when nothing survived.
 */
export function parseSuggestion(raw: string, categories: string[], model: string, at: string): Suggestion | null {
  const parsed = jsonObjectIn(raw)
  if (!parsed) return null
  const suggestion: Suggestion = { at, model }

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
  if (title && title.length <= TITLE_MAX_CHARS) suggestion.title = title

  // P5-63: through the aliases first, so a model that answers "demographics"
  // or "Flooding" is filing correctly rather than being dropped on a spelling.
  const category = typeof parsed.category === 'string' ? normalizeCategory(parsed.category) : ''
  if (category && categories.includes(category)) suggestion.category = category

  const tags = Array.isArray(parsed.tags)
    ? [
        ...new Set(
          parsed.tags
            .map(cleanTag)
            .filter((t): t is string => !!t)
            .map(normalizeTag)
            .filter(t => !!t),
        ),
      ].slice(0, MAX_TAGS)
    : []
  if (tags.length) suggestion.tags = tags

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (summary && summary.length <= SUMMARY_MAX_CHARS) suggestion.summary = summary

  return suggestion.title || suggestion.category || suggestion.tags || suggestion.summary ? suggestion : null
}

// --- Prompt ---------------------------------------------------------------

export function buildSuggestSystemPrompt(): string {
  return [
    'You help a small research team file documents into their internal library.',
    'You are shown the first pages of one document. Propose how to file it.',
    'Only describe what the text actually says — never guess at contents you cannot see.',
    'Answer with a single JSON object and nothing else.',
  ].join(' ')
}

export interface SuggestPromptInput {
  file: string
  text: string
  categories: string[]
  currentTitle?: string
  url?: string
}

/**
 * The vocabulary, written out for a model (P5-63).
 *
 * Ids with their plain labels, split into what a document is ABOUT and what it
 * is FOR, because those are different questions and a flat list of eighteen
 * words invited the model to answer the wrong one. Only the ids the caller
 * actually allows are shown — the validator and the prompt must never disagree
 * about what is choosable.
 */
export function categoryMenu(allowed: string[]): string[] {
  const lines: string[] = []
  const topics = TOPICS.filter(t => allowed.includes(t.id))
  const purposes = PURPOSES.filter(p => allowed.includes(p.id))
  if (topics.length) {
    lines.push(`What it is ABOUT — pick one of these when the document has a subject: ${topics.map(t => `${t.id} (${t.label})`).join(', ')}.`)
  }
  if (purposes.length) {
    lines.push(`What it is FOR — pick one of these when it is a plan, a piece of evidence, something we send out, or an idea: ${purposes.map(p => `${p.id} (${p.label})`).join(', ')}.`)
  }
  // Anything the caller allowed that the taxonomy does not name (a word the
  // library grew and nobody has folded in yet) is still offered, plainly.
  const rest = allowed.filter(id => !topics.some(t => t.id === id) && !purposes.some(p => p.id === id))
  if (rest.length) lines.push(`Also in use: ${rest.join(', ')}.`)
  return lines
}

/** Tags worth suggesting first: every topic's own, then the cross-cutting
 *  ones. Free tags are still allowed — this is a starting point, not a fence. */
export function suggestedTagMenu(): string {
  const tags = [...new Set([...TOPICS.flatMap(t => t.suggestedTags), ...CROSS_TAGS])]
  return tags.join(', ')
}

export function buildSuggestUserMessage(input: SuggestPromptInput): string {
  const parts = [
    `File name: ${input.file}`,
    input.currentTitle ? `Currently filed as: ${input.currentTitle}` : '',
    input.url ? `Dropped from: ${input.url}` : '',
    '',
    'Categories in use (pick exactly one, or leave the field out if none fit):',
    ...categoryMenu(input.categories).map(line => `  ${line}`),
    '',
    'First pages of the document:',
    '---',
    input.text,
    '---',
    '',
    'Reply with only this JSON object:',
    '{"title": "…", "category": "…", "tags": ["…"], "summary": "…"}',
    `- title: what a person would call this document (at most ${TITLE_MAX_CHARS} characters).`,
    '- category: one from the list above, spelled exactly. Leave it out rather than inventing one.',
    `- tags: at most ${MAX_TAGS}, lowercase and hyphenated. Use these words where they fit: ${suggestedTagMenu()}. A word of your own is fine when none of them does.`,
    `- summary: two or three plain sentences saying what this is and what is in it (at most ${SUMMARY_MAX_CHARS} characters).`,
  ]
  return parts.filter(p => p !== '').join('\n')
}

// --- The pass -------------------------------------------------------------

export interface SuggestOptions {
  client?: AnthropicLike
  /** The dropping user's IP: the token spend is attributed to them (P5-41's
   *  reserve/settle), because this call happens on their behalf. */
  clientIp?: string
  categories?: string[]
  entry?: CatalogEntryRow
  /** P5-59: text to file from when the entry holds no readable file — the
   *  metadata an inspection read off an ArcGIS layer or a Socrata dataset.
   *  There is no document to extract there, so the service's own description
   *  IS the document. */
  text?: { file: string; text: string }
}

export interface Pages {
  file: string
  text: string
  basis?: 'head'
}

/** Bytes of an oversized file we read. The suggester only ever sees the first
 *  ~6,000 characters, so this is generous already. */
export const HEAD_BYTES = 64 * 1024

/** Files whose first bytes are readable text as they stand. `.json`/`.geojson`
 *  are in here and not in the extractor's table: nobody wants a GeoJSON's
 *  "pages", but its head says what the columns are. */
const HEAD_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'md', 'markdown', 'json', 'geojson'])

function isHeadReadable(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot !== -1 && HEAD_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** The first HEAD_BYTES of a stored file, off the mirror so a 26 MB CSV is
 *  never held in memory whole. */
async function readHead(key: string): Promise<string> {
  const { path } = await ensureMirrored(key)
  const handle = await fs.open(path, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * P5-59, found live: a 26.5 MB `export.csv` downloaded fine and got no
 * suggestion at all, because extraction skips anything over EXTRACT_MAX_BYTES
 * and the suggester had nothing to read. It only ever needed the first few
 * thousand characters — so read the head of the stored bytes instead of
 * skipping, and say that is what was read.
 *
 * The inspection goes in beside it when it holds columns or a geometry, for
 * the same reason an ArcGIS layer's metadata does: it says what the table IS,
 * which a header row alone does not.
 */
async function headPages(entry: CatalogEntryRow): Promise<Pages | null> {
  // Same rule as extraction: a whole document entry or a drop, never a
  // dataset's data files (the table explorer is what reads those).
  if (entry.kind !== 'document' && entry.kind !== 'incoming') return null
  const file = (entry.files ?? []).find(f => {
    const name = basenameInEntry(f.key)
    return name !== 'meta.json' && isHeadReadable(name)
  })
  if (!file) return null
  const name = basenameInEntry(file.key)
  let head: string
  try {
    head = await readHead(file.key)
  } catch (err: any) {
    console.warn('[library] could not read the head of', file.key, '—', err?.message || err)
    return null
  }
  const inspection = parseInspection(entry.meta?.inspection)
  const preamble = inspection && (inspection.fields?.length || inspection.geometry) ? `${inspectionText(inspection)}\n\n` : ''
  const text = `${preamble}${head}`.slice(0, SUGGEST_TEXT_CHARS).trim()
  return text ? { file: name, text, basis: 'head' } : null
}

/**
 * The first ~6,000 characters of the entry's readable file, extracting it now
 * if the sweep has not reached it. Null when there is nothing to read.
 *
 * Exported for P6-8's bulk annotation, which asks the same document the same
 * question with a wider answer: one reader, so "what the model was shown"
 * means the same thing on both paths.
 */
export async function firstPages(entry: CatalogEntryRow): Promise<Pages | null> {
  const candidate = extractableFiles(entry)[0]
  // Over the extraction cap there is no text to wait for — go straight to the
  // head rather than storing a "too large" failure and giving up.
  if (candidate && candidate.size <= extractMaxBytes()) {
    let derived = await readDerived(candidate.slug, candidate.file)
    // The sweep runs after a reindex; a file that just landed has no text yet,
    // and waiting for the next sweep would mean no suggestion on the drop.
    if (!derived || (!isFailure(derived) && derived.sourceSize !== candidate.size)) {
      derived = await extractFile(candidate.slug, candidate.file, candidate.key, candidate.size)
    }
    if (!isFailure(derived)) {
      const text = derived.pages
        .map(page => page.text)
        .join('\n\n')
        .slice(0, SUGGEST_TEXT_CHARS)
        .trim()
      if (text) return { file: candidate.file, text }
    }
  }
  return headPages(entry)
}

/**
 * Read the entry's document and propose a filing.
 *
 * Returns null when there is nothing to read (no extractable file, or the
 * extraction failed) — the fetch itself still stands, and a document nobody
 * can read is not a reason to mark anything as broken. Returns
 * `{ error: 'unavailable' }` when the model could not be asked or answered
 * with nothing usable, so the entry can say so quietly.
 */
export async function suggestForEntry(slug: string, options: SuggestOptions = {}): Promise<SuggestOutcome | null> {
  const entry = options.entry ?? (await getCatalogEntry(slug))
  if (!entry) return null
  const pages: Pages | null = options.text ?? (await firstPages(entry))
  if (!pages) return null

  const at = new Date().toISOString()
  const model = askModel()
  const categories = options.categories ?? (await knownCategories())
  const url = typeof entry.meta?.url === 'string' ? entry.meta.url : undefined
  const user = buildSuggestUserMessage({
    file: pages.file,
    text: pages.text,
    categories,
    currentTitle: entry.title,
    url,
  })

  // Metered, budgeted and failure-tolerant in `assistantCall`, which P5-61's
  // link prune shares — a model outage never costs the drop its download.
  const answer = await callAssistant({
    label: `suggestion for ${slug}`,
    system: buildSuggestSystemPrompt(),
    user,
    maxTokens: suggestMaxTokens(),
    model,
    client: options.client,
    clientIp: options.clientIp,
  })
  if (isAssistantError(answer)) return { error: 'unavailable', at, reason: answer.code }
  const suggestion = parseSuggestion(answer.text, categories, model, at)
  if (!suggestion) return { error: 'unavailable', at }
  // Recorded on the proposal, because "read from the first 64 kB" is a caveat
  // a person applying it should be able to see.
  return pages.basis ? { ...suggestion, basis: pages.basis } : suggestion
}
