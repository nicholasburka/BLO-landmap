/**
 * Ask the knowledge base (P5-41) — client half.
 *
 * One request, one answer, sources you can open. Everything here is written
 * for readers who are researchers rather than engineers: filter clauses come
 * back as "HQ State is GA", and every failure has a sentence a person can act
 * on instead of a status code.
 */
import { internalFetch } from './apiBase'
import { createNoteEntry, type CatalogEntry } from './libraryCatalog'
import type { FilterOp, RowFilter } from './libraryData'
import { fetchWikiPage, saveWikiPage } from './wiki'

export interface AskSource {
  /** The bracketed number the answer cites, e.g. [2]. */
  n: number
  slug: string
  kind: string
  title: string
  href: string
  snippet: string
  /** False for the "related" leads shown when the answer cited nothing. */
  cited: boolean
}

export interface AskQueryGroup {
  value: string
  count: number
}

export interface AskQuery {
  slug: string
  title: string
  filters: RowFilter[]
  groupBy?: string
  groups?: AskQueryGroup[]
  rowCount: number
  /** Deep link into the table explorer with these filters applied. */
  href: string
  /** Deep link to the map, when the dataset powers an internal layer. */
  mapHref?: string
}

export interface AskRead {
  pages: number
  /** Data sources (P5-56) — pointers to datasets held elsewhere. */
  sources?: number
  datasets: number
  documents: number
  notes: number
}

export interface AskAnswer {
  answer: string
  sources: AskSource[]
  queries: AskQuery[]
  read: AskRead
}

/**
 * Why the model could not be asked (P5-75), when the server chose to say.
 *
 * Sent only to admins, because only an admin can act on any of it: set a key,
 * fix the billing, or wait. It mirrors `AssistantFailureCode` on the server.
 */
export type AskFailureReason = 'no-key' | 'refused' | 'rate-limited' | 'model-error'

const FAILURE_REASONS: AskFailureReason[] = ['no-key', 'refused', 'rate-limited', 'model-error']

function failureReasonIn(body: unknown): AskFailureReason | undefined {
  const reason = (body as { reason?: unknown } | null)?.reason
  return FAILURE_REASONS.find(known => known === reason)
}

/** Server refusal with its status, so the page can say the right thing. */
export class AskRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Present only when the server told an admin why the model is down. */
    public readonly reason?: AskFailureReason,
  ) {
    super(message)
    this.name = 'AskRequestError'
  }
}

export const QUESTION_MAX_CHARS = 500

export async function askLibrary(question: string, dataset?: string): Promise<AskAnswer> {
  let res: Response
  try {
    res = await internalFetch('/api/library/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, ...(dataset ? { dataset } : {}) }),
    })
  } catch {
    throw new AskRequestError(0, 'offline')
  }
  if (!res.ok) {
    let message = ''
    let reason: AskFailureReason | undefined
    try {
      const body = await res.json()
      if (body && typeof body.error === 'string') message = body.error
      reason = failureReasonIn(body)
    } catch {
      /* non-JSON body */
    }
    throw new AskRequestError(res.status, message, reason)
  }
  return (await res.json()) as AskAnswer
}

/**
 * What an admin is told for each reason (P5-75) — one sentence, one action.
 *
 * A member never sees these: they would say "we are out of credit" to someone
 * who cannot top it up, and the generic sentence already tells them the only
 * thing they can do, which is come back in a minute.
 */
export const ADMIN_REASON_TEXT: Record<AskFailureReason, string> = {
  'no-key': 'The answering model is not configured on the server.',
  refused: 'The model refused the key — check billing or the key.',
  'rate-limited': 'The model is rate-limiting us — try again in a minute.',
  'model-error': 'The model returned an error — try again in a minute.',
}

export interface AskErrorOptions {
  /** Passed in by the caller rather than read from the auth composable here,
   *  so this module stays a pure function of its arguments. */
  isAdmin?: boolean
}

/** Plain-language failure text. The server's own message is used when it
 *  wrote one for a person (bad question, budget); status codes never reach
 *  the screen. */
export function askErrorMessage(error: unknown, options: AskErrorOptions = {}): string {
  if (!(error instanceof AskRequestError)) return 'Something went wrong. Please try again.'
  // A reason only ever arrives on an admin's response, but the flag is checked
  // anyway: one shared page, two roles, and the sharper sentence is the whole
  // point of the ticket.
  if (options.isAdmin && error.reason) return ADMIN_REASON_TEXT[error.reason]
  switch (error.status) {
    case 0:
      return 'No connection. Check your network and try again.'
    case 400:
      return error.message || 'That question could not be read. Try rephrasing it.'
    case 401:
      return 'Your session ended. Sign in again to keep asking.'
    case 403:
      return 'Your session ended. Reload the page and try again.'
    case 429:
      return 'That is a lot of questions at once. Wait a minute, then ask again.'
    case 503:
      return error.message || "The team has used up today's question budget. It resets tomorrow."
    default:
      return error.message || 'The answering service is having trouble. Please try again in a minute.'
  }
}

// --- Recent questions ------------------------------------------------------
// Internal content, so the key lives under the `blo:ask` prefix that useAuth
// wipes at logout (P5-19: nothing internal survives in the browser).

export const RECENT_KEY = 'blo:ask'
export const RECENT_MAX = 20

export interface RecentQuestion {
  q: string
  dataset?: string
  at: number
}

export function recentQuestions(): RecentQuestion[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is RecentQuestion => !!item && typeof item === 'object' && typeof (item as RecentQuestion).q === 'string')
      .slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/** Newest first, de-duplicated on the question + dataset pair. */
export function rememberQuestion(question: string, dataset?: string): void {
  const q = question.trim()
  if (!q) return
  const entry: RecentQuestion = { q, ...(dataset ? { dataset } : {}), at: Date.now() }
  const kept = recentQuestions().filter(item => !(item.q === q && (item.dataset ?? '') === (dataset ?? '')))
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...kept].slice(0, RECENT_MAX)))
  } catch {
    // storage unavailable (private mode) — asking still works
  }
}

export function clearRecentQuestions(): void {
  try {
    localStorage.removeItem(RECENT_KEY)
  } catch {
    /* nothing to clear */
  }
}

// --- Presentation helpers --------------------------------------------------

/** The /ask URL for a question (the one place the query shape is written). */
export function askUrl(question: string, dataset?: string): string {
  const params = new URLSearchParams({ q: question.trim() })
  if (dataset) params.set('dataset', dataset)
  return `/ask?${params.toString()}`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** "7 pages and 2 datasets" — what the answer was drawn from. */
export function describeRead(read: AskRead | undefined): string {
  if (!read) return ''
  const parts: string[] = []
  if (read.pages) parts.push(plural(read.pages, 'page'))
  if (read.datasets) parts.push(plural(read.datasets, 'dataset'))
  if (read.documents) parts.push(plural(read.documents, 'document'))
  if (read.notes) parts.push(plural(read.notes, 'note'))
  if (read.sources) parts.push(plural(read.sources, 'data source'))
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

const OP_WORDS: Record<FilterOp, string> = {
  eq: 'is',
  contains: 'contains',
  gte: 'is at least',
  lte: 'is at most',
  empty: 'is empty',
  notEmpty: 'is filled in',
}

/** One filter in plain words: "HQ State is GA". */
export function describeFilter(filter: RowFilter): string {
  const word = OP_WORDS[filter.op] ?? filter.op
  return filter.value === undefined ? `${filter.column} ${word}` : `${filter.column} ${word} ${filter.value}`
}

/** The whole query card subtitle: "Everything" when nothing was filtered. */
export function describeQuery(query: AskQuery): string {
  const where = query.filters.length ? query.filters.map(describeFilter).join(', ') : 'the whole table'
  return query.groupBy ? `${where}, counted by ${query.groupBy}` : where
}

// --- Keeping an answer (P5-48) ---------------------------------------------
// An answer is worth nothing if it dies with the tab. Two ways to keep one:
// as a note of its own, or appended to a page that already collects the
// subject. Both write the SAME markdown, so a saved answer reads the same
// wherever it lands; only the heading level differs.


/** Long enough for a real question, short enough to read in a list. */
export const NOTE_TITLE_MAX = 160

/** Notes from Ask file themselves as research, tagged so they can be found
 *  again as a group ("everything we kept from Ask"). */
export const ANSWER_NOTE_CATEGORY = 'research'
export const ANSWER_NOTE_TAG = 'ask'

/** The question as a title: one line, never longer than the list can show.
 *  Cuts on a word boundary so the ellipsis lands between words. */
export function noteTitleFromQuestion(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim()
  if (line.length <= NOTE_TITLE_MAX) return line
  const cut = line.slice(0, NOTE_TITLE_MAX - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > NOTE_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** Square brackets in a source title would close the link early. */
function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1')
}

export interface AnswerMarkdownOptions {
  /** The whole block's heading line, e.g. `# question` or `## From Ask: …`. */
  heading: string
  /** How the sources list is introduced — "Where this came from" (P5-65),
   *  the same words the answer page uses. A note owns its outline and gets a
   *  real heading; a section appended to someone else's page must not add
   *  headings to their table of contents, so it uses a bold line. */
  sourcesHeading: string
}

/** Question, answer, sources and a link back to the live question. The Ask
 *  link matters most: a saved answer is a snapshot, and the reader needs a
 *  one-click way to ask it again against today's library. */
export function answerMarkdown(
  question: string,
  answer: AskAnswer,
  dataset: string | undefined,
  options: AnswerMarkdownOptions,
): string {
  const parts = [options.heading, '', answer.answer.trim()]
  if (answer.sources.length) {
    parts.push('', options.sourcesHeading)
    for (const source of answer.sources) {
      parts.push(`- [${escapeLinkText(source.title)}](${source.href})`)
    }
  }
  parts.push('', `[Ask this question again](${askUrl(question, dataset)})`)
  return `${parts.join('\n')}\n`
}

/** The body of a note: the question is the note's own top heading. */
export function answerNoteMarkdown(question: string, answer: AskAnswer, dataset?: string): string {
  return answerMarkdown(question, answer, dataset, {
    heading: `# ${question.replace(/\s+/g, ' ').trim()}`,
    sourcesHeading: '## Where this came from',
  })
}

/** The same block as a section on an existing page — it sits under that
 *  page's own title, so it starts one level down and says where it came from. */
export function answerSectionMarkdown(question: string, answer: AskAnswer, dataset?: string): string {
  return answerMarkdown(question, answer, dataset, {
    heading: `## From Ask: ${question.replace(/\s+/g, ' ').trim()}`,
    sourcesHeading: '**Where this came from**',
  })
}

/** Save an answer as its own note. Returns the created entry so the page can
 *  link straight to it. */
export function saveAnswerAsNote(question: string, answer: AskAnswer, dataset?: string): Promise<CatalogEntry> {
  return createNoteEntry({
    title: noteTitleFromQuestion(question),
    body: answerNoteMarkdown(question, answer, dataset),
    category: ANSWER_NOTE_CATEGORY,
    tags: [ANSWER_NOTE_TAG],
  })
}

/** Append an answer to an existing wiki page: read it, add the section at the
 *  end, write it back with the version we read. The If-Unmodified-Since round
 *  trip is the point — if someone else saved the page in between, the server
 *  says 412 and `saveWikiPage` throws WikiConflictError instead of quietly
 *  overwriting their work. Calling this again re-reads, so retry is safe. */
export async function addAnswerToPage(
  slug: string,
  question: string,
  answer: AskAnswer,
  dataset?: string,
): Promise<{ slug: string; title: string }> {
  const page = await fetchWikiPage(slug)
  if (!page) throw new Error(`There is no page named “${slug}” any more.`)
  const section = answerSectionMarkdown(question, answer, dataset)
  const markdown = `${page.markdown.replace(/\s+$/, '')}\n\n${section}`
  const saved = await saveWikiPage(slug, markdown, { ifUnmodifiedSince: page.updatedAt })
  return { slug: saved.slug, title: saved.title || page.title }
}
