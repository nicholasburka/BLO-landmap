/**
 * The place report (P5-58) — client half.
 *
 * "What datasets will tell me all environmental risks associated with this
 * property?" The server runs every applicable source, the county's public
 * layer values and the organizations nearby, then has Ask write the cited
 * summary. This file is the API client, the URL state, and the presentation
 * arithmetic: the plain-language status of each section, the report as
 * markdown (for a note or a page) and as a CSV.
 *
 * Types mirror the route's answer in server/src/routes/libraryPlace.ts.
 */
import { internalFetch } from './apiBase'
import { topicLabel } from '@/config/taxonomy'
import { groupRows, type BrowseGroup, type GroupKey } from './browse'
// P6-26: the same relative time `/analysis` prints beside a recent analysis,
// so "3d ago" in the list and "3d ago" on the report are the same sentence.
import { relativeTime } from './kb'
import { createNoteEntry, type CatalogEntry } from './libraryCatalog'
import { fetchWikiPage, saveWikiPage } from './wiki'
// The Ask page already decided how a kept answer is titled and filed; a kept
// report is the same kind of thing, so it reuses those decisions rather than
// inventing a second convention.
import { ANSWER_NOTE_CATEGORY, ANSWER_NOTE_TAG, noteTitleFromQuestion } from './ask'

export type SectionStatus = 'found' | 'none' | 'skipped' | 'failed' | 'timeout'

export interface ReportSection {
  slug: string
  title: string
  provider: string
  status: SectionStatus
  count: number
  rows: Record<string, string>[]
  columns: string[]
  cacheKey?: string
  /** P5-63: the taxonomy topic the source is filed under, or null when
   *  nothing on its entry names one. */
  topic?: string | null
  href: string
  reason?: string
}

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

export interface ReportSummary {
  text: string
  sources: { n: number; title: string; href: string }[]
}

export interface ReportPlace {
  label: string
  lat: number | null
  lng: number | null
  geoid: string | null
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
  placeKey: string
  cached: boolean
}

// --- The shape of the report (P6-17) -----------------------------------------
// Forty sources in one flat list is a wall: measured at 10,350 px on a desktop
// and 14,950 px on a phone, with no way to fold anything. Two thirds of that
// was sources that found nothing or could not be checked, each drawing a full
// card. Nothing is removed here — "fine to have available" is the requirement
// — but what a researcher came for is open and the housekeeping is one row
// until they ask for it.

/**
 * Which heading a section belongs under: the library's own topic vocabulary,
 * through `lib/browse`'s `GroupKey`, so a heading on this page reads in the
 * same words as the chip that filters to it on `/datasets`.
 */
export const NO_TOPIC_LABEL = 'Everything else'

export function sectionTopicKey(section: ReportSection): GroupKey {
  const topic = section.topic ?? ''
  return { id: topic, label: topic ? topicLabel(topic) : NO_TOPIC_LABEL }
}

/** The two summary rows. Prefixed so they can never collide with a topic slug,
 *  which is what the other group ids are. */
export const QUIET_NONE = 'status:none'
export const QUIET_UNCHECKED = 'status:unchecked'

/** A section that found nothing, or that we never managed to ask. */
export function isQuiet(section: ReportSection): boolean {
  return section.status !== 'found'
}

export interface ReportGroup extends BrowseGroup<ReportSection> {
  /**
   * Open when the report arrives?
   *
   * What was found is; the two quiet rows are not. That single rule is the
   * whole of this ticket's cheapest half: 40 open cards become 12.
   */
  open: boolean
}

/** "12 sources", "1 source" — the count on a group's header. */
export function groupCountLine(count: number): string {
  return plural(count, 'source')
}

/**
 * Every section, in groups: what was found under its topic heading, then one
 * row for what found nothing and one for what could not be checked.
 *
 * Grouping, ordering and the dropping of empty groups are all `groupRows`
 * from `lib/browse` — the browsers' rule (heaviest heading first, the
 * no-value group pinned last), not a second implementation. A topic no
 * source found anything under simply has no group, exactly as a publisher
 * with no datasets has no heading on `/datasets`.
 */
export function reportGroups(report: PlaceReport): ReportGroup[] {
  const groups: ReportGroup[] = groupRows(
    report.sections.filter(s => s.status === 'found'),
    sectionTopicKey,
  ).map(group => ({ ...group, open: true }))

  const none = report.sections.filter(s => s.status === 'none')
  if (none.length) {
    groups.push({
      id: QUIET_NONE,
      label: `Nothing within ${report.radiusMiles} miles`,
      count: none.length,
      rows: none,
      open: false,
    })
  }

  // Skipped, failed and timed out read the same way to a researcher — we do
  // not know — and they are 24 of the 40 on a real report. A failure is named
  // inside, on its own card, so it says so rather than vanishing.
  const unchecked = report.sections.filter(s => s.status !== 'found' && s.status !== 'none')
  if (unchecked.length) {
    groups.push({
      id: QUIET_UNCHECKED,
      label: 'Could not be checked',
      count: unchecked.length,
      rows: unchecked,
      open: false,
    })
  }

  return groups
}

/** How many sources stand out at the top before the reader has to open a
 *  group. Five is what fits the first screen beside the headline at 390 px. */
export const VERDICT_STANDOUTS = 5

export interface ReportVerdict {
  /** The answer, in one sentence. */
  headline: string
  /** The biggest finds, each anchored to its own card further down. */
  standouts: { slug: string; title: string; phrase: string; anchor: string }[]
  /** The housekeeping, quietly: what found nothing and what we could not ask. */
  rest: string
}

/**
 * What the report says, before the evidence for it (P6-17).
 *
 * The page used to open with a form and then forty cards, so "what should I
 * look at first" had no answer on it. Ranking the finds by how much each
 * source returned is the only signal the report actually carries — a count is
 * not importance, but it is what stands out, and every one of them is a link
 * to the rows it is counting.
 */
export function reportVerdict(report: PlaceReport, limit = VERDICT_STANDOUTS): ReportVerdict {
  const { found, none, unchecked } = reportTally(report)
  const total = report.sections.length
  const headline = found
    ? `${found} of ${plural(total, 'source')} found something within ${report.radiusMiles} miles.`
    : `Nothing found within ${report.radiusMiles} miles, from ${plural(total, 'source')}.`

  const standouts = report.sections
    .filter(s => s.status === 'found')
    // A tie keeps the server's order, which is alphabetical inside a status.
    .map((section, i) => ({ section, i }))
    .sort((a, b) => b.section.count - a.section.count || a.i - b.i)
    .slice(0, limit)
    .map(({ section }) => ({
      slug: section.slug,
      title: section.title,
      phrase: statusPhrase(section, report.radiusMiles),
      anchor: `#section-${section.slug}`,
    }))

  const rest = [none ? `${none} found nothing` : '', unchecked ? `${unchecked} could not be checked` : '']
    .filter(Boolean)
    .join(' · ')

  return { headline, standouts, rest }
}

/**
 * Whether this is today's answer or a copy (P6-26).
 *
 * `/analysis` says a report was run "3d ago" and the report itself used to say
 * nothing at all, so a reopened page could not be told from a fresh
 * forty-agency run. The relative time is `relativeTime` — the same words the
 * list uses — and the absolute date is there too, because "4d ago" is what
 * you scan and a date is what you cite.
 */
export function freshnessPhrase(report: PlaceReport, now = Date.now()): string {
  const when = relativeTime(report.generatedAt, now)
  if (!report.cached) return when ? `Checked ${when}` : 'Checked just now'
  if (!when) return 'Cached copy'
  return `Cached copy · checked ${when} on ${new Date(report.generatedAt).toLocaleDateString()}`
}

// --- The URL is the state ----------------------------------------------------

export interface PlaceUrlState {
  address: string
  lat: number | null
  lng: number | null
  geoid: string
  radius: number | null
  /** P7-1: the working set this run is scoped to — `?set=<slug>`. '' is the
   *  whole library, which is every link written before P7-1. */
  set: string
}

type QueryValue = string | string[] | null | undefined

function first(value: QueryValue): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : ''
  return typeof value === 'string' ? value : ''
}

function finite(raw: string, min: number, max: number): number | null {
  if (raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= min && n <= max ? n : null
}

export const RADIUS_MAX_MILES = 100
export const ADDRESS_MAX_CHARS = 300

/**
 * Read `/place?address=` | `?lat=&lng=` | `?geoid=` (+ `&radius=`).
 *
 * Everything is validated and anything malformed is dropped rather than
 * thrown: a hand-edited or truncated link should open the form, not an error
 * page.
 */
export function parsePlaceUrl(query: Record<string, QueryValue>): PlaceUrlState {
  const geoid = first(query.geoid).trim()
  return {
    address: first(query.address).trim().slice(0, ADDRESS_MAX_CHARS),
    lat: finite(first(query.lat), -90, 90),
    lng: finite(first(query.lng), -180, 180),
    geoid: /^\d{5}$/.test(geoid) ? geoid : '',
    radius: finite(first(query.radius), 0.1, RADIUS_MAX_MILES),
    // A slug or nothing. A malformed one drops to the whole library rather
    // than erroring, like everything else read out of this URL.
    set: WORKING_SET_SLUG.test(first(query.set).trim()) ? first(query.set).trim() : '',
  }
}

/** The shape a working-set slug has, so a hand-edited link cannot send
 *  arbitrary text to the report route. */
const WORKING_SET_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

/** The one place the /place URL shape is written. */
export function placeUrl(state: Partial<PlaceUrlState>): string {
  const params = new URLSearchParams()
  if (state.address) params.set('address', state.address.trim().slice(0, ADDRESS_MAX_CHARS))
  else if (state.lat !== null && state.lat !== undefined && state.lng !== null && state.lng !== undefined) {
    params.set('lat', String(state.lat))
    params.set('lng', String(state.lng))
  } else if (state.geoid) params.set('geoid', state.geoid)
  if (state.radius) params.set('radius', String(state.radius))
  // P7-1: the scope rides in the URL so a scoped report is a link somebody can
  // be sent — the same rule every other filter in this codebase follows.
  if (state.set) params.set('set', state.set)
  const qs = params.toString()
  return qs ? `/place?${qs}` : '/place'
}

export interface PlaceReportRequest {
  address?: string
  point?: { lat: number; lng: number }
  geoid?: string
  radiusMiles?: number
  sources?: string[]
  /**
   * P7-1: run the report INSIDE a working set — that set's sources and no
   * others, 11 instead of 40.
   *
   * A slug, not a list. The server dereferences it, which is what makes a
   * scoped number citable: "this asked the Memphis redevelopment set" is a
   * fact the server can stand behind, where a list the page assembled is only
   * a claim about one request.
   */
  workingSet?: string
  refresh?: boolean
}

/** The request a URL asks for, or null when it names no place yet. */
export function requestFromUrl(state: PlaceUrlState): PlaceReportRequest | null {
  // P7-1: `?set=` scopes the run. It rides on every request shape, because
  // which datasets to ask is a separate question from which place to ask about.
  const scope = { ...(state.radius ? { radiusMiles: state.radius } : {}), ...(state.set ? { workingSet: state.set } : {}) }
  if (state.address) return { address: state.address, ...scope }
  if (state.lat !== null && state.lng !== null) return { point: { lat: state.lat, lng: state.lng }, ...scope }
  if (state.geoid) return { geoid: state.geoid, ...scope }
  return null
}

// --- Talking to the server ---------------------------------------------------

/** Server refusal with its status, so the page can say the right thing. */
export class PlaceReportError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'PlaceReportError'
  }
}

async function refusal(res: Response): Promise<PlaceReportError> {
  let message = ''
  try {
    const body = await res.json()
    if (body && typeof body.error === 'string') message = body.error
  } catch {
    /* non-JSON body */
  }
  return new PlaceReportError(res.status, message)
}

/** The media type the route answers a progress-reporting caller in. */
export const NDJSON_TYPE = 'application/x-ndjson'

/** A stream that ended with neither a report nor a reason. */
export const STREAM_CUT_TEXT = 'The report stopped part way through. Please try again.'

/**
 * Run the report, and say what it is doing while it runs (P6-16).
 *
 * **Streamed, not polled.** Polling needs somewhere to read progress back
 * from between requests — a run id and its state, shared across requests and
 * surviving whichever instance answers the next one. That is a queue, and the
 * ticket rules one out; it would also be the first piece of shared run state
 * in this service. Streaming needs nothing new: the route already runs the
 * report inside the request, every source is already its own task resolving to
 * a complete section, and `POST /api/chats/:id/messages` already answers
 * NDJSON this way (`docs/CHAT.md`). So the channel is one `Accept` header.
 *
 * Pass no `onProgress` and the route answers exactly as it did before, which
 * is also what comes back when the whole report was cached — there is no
 * progress to report on an answer that was already written.
 */
export async function runPlaceReport(
  request: PlaceReportRequest,
  onProgress?: (event: PlaceProgressEvent) => void,
): Promise<PlaceReport> {
  let res: Response
  try {
    res = await internalFetch('/api/library/place/report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(onProgress ? { Accept: `${NDJSON_TYPE}, application/json` } : {}),
      },
      body: JSON.stringify(request),
    })
  } catch {
    throw new PlaceReportError(0, 'offline')
  }
  if (!res.ok) throw await refusal(res)
  // A cached report, or a server that does not stream: one JSON object, as
  // before. The content type decides, not what we asked for.
  const streamed = (res.headers?.get?.('Content-Type') ?? '').includes(NDJSON_TYPE)
  if (!onProgress || !streamed || !res.body) return (await res.json()) as PlaceReport
  return readReportStream(res.body, onProgress)
}

/** The progress events, then the report. Shapes are checked before they are
 *  used: a line this client does not understand is skipped rather than fatal,
 *  so the server can add an event type without breaking an open page. */
function asProgressEvent(value: unknown): PlaceProgressEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  switch (event.type) {
    case 'start':
      return typeof event.total === 'number' ? { type: 'start', total: event.total } : null
    case 'source':
      return typeof event.title === 'string' ? { type: 'source', slug: String(event.slug ?? ''), title: event.title } : null
    case 'section':
      return typeof event.title === 'string' && typeof event.done === 'number'
        ? {
            type: 'section',
            slug: String(event.slug ?? ''),
            title: event.title,
            status: event.status as SectionStatus,
            done: event.done,
            total: typeof event.total === 'number' ? event.total : 0,
          }
        : null
    case 'summary':
      return { type: 'summary' }
    default:
      return null
  }
}

async function readReportStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (event: PlaceProgressEvent) => void,
): Promise<PlaceReport> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let report: PlaceReport | null = null

  /** One line in; the report out when that was the line. Throws on `error`. */
  const handle = (line: string): PlaceReport | null => {
    const trimmed = line.trim()
    if (!trimmed) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null // a line we cannot read is skipped, never fatal
    }
    const event = parsed as Record<string, unknown>
    if (event?.type === 'error') {
      const status = typeof event.status === 'number' ? event.status : 502
      throw new PlaceReportError(status, typeof event.error === 'string' ? event.error : '')
    }
    if (event?.type === 'report') return (event.report ?? null) as PlaceReport | null
    const progress = asProgressEvent(parsed)
    if (progress) onProgress(progress)
    return null
  }

  try {
    while (!report) {
      const { value, done } = await reader.read()
      if (done) {
        report = handle(buffer)
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // A chunk can end mid-line; the tail waits for the next one.
      buffer = lines.pop() ?? ''
      for (const line of lines) report = handle(line) ?? report
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }

  if (!report) throw new PlaceReportError(502, STREAM_CUT_TEXT)
  return report
}

/** The last report for a place, or null when there is none to read. */
export async function fetchPlaceReport(placeKey: string): Promise<PlaceReport | null> {
  const res = await internalFetch(`/api/library/place/report/${encodeURIComponent(placeKey)}`)
  if (res.status === 404) return null
  if (!res.ok) throw await refusal(res)
  return (await res.json()) as PlaceReport
}

// --- The list of what has been run (P6-4) ------------------------------------

/** One line of the report index — what `/analysis` shows as a recent analysis. */
export interface PlaceReportRow {
  /** `g13121`, or `p33.7490_-84.3880_r5`. Reopens the cached report. */
  placeKey: string
  label: string
  /** The username who ran it. '' when nothing recorded one. */
  by: string
  /** When the report was generated (ISO). */
  at: string
  found: number
  sources: number
}

/**
 * The reports we still hold, newest first.
 *
 * Off the server's index, not the reports themselves: the list is six lines a
 * place and a report is up to fifty sections of rows.
 */
export async function fetchPlaceReports(limit?: number): Promise<PlaceReportRow[]> {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : ''
  const res = await internalFetch(`/api/library/place/reports${qs}`)
  if (!res.ok) throw await refusal(res)
  const body = (await res.json()) as { reports?: PlaceReportRow[] }
  return Array.isArray(body.reports) ? body.reports : []
}

/** A place key, back to the `/place?…` URL that reopens its cached report.
 *  '' for a key we do not recognise — the row then has nothing to link to
 *  rather than a link that lands on an empty form. */
export function placeUrlForKey(placeKey: string): string {
  const county = /^g(\d{5})$/.exec(placeKey)
  if (county) return placeUrl({ geoid: county[1] })
  const point = /^p(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)_r(\d+(?:\.\d+)?)$/.exec(placeKey)
  if (point) return placeUrl({ lat: Number(point[1]), lng: Number(point[2]), radius: Number(point[3]) })
  return ''
}

/** Plain-language failure text. The server's own sentence is used when it
 *  wrote one for a person; status codes never reach the screen. */
export function placeErrorMessage(error: unknown): string {
  if (!(error instanceof PlaceReportError)) return 'Something went wrong. Please try again.'
  switch (error.status) {
    case 0:
      return 'No connection. Check your network and try again.'
    case 400:
      return error.message || 'That place could not be read. Try a full street address, or pick a county.'
    case 401:
    case 403:
      return 'Your session ended. Sign in again to run a report.'
    case 429:
      return 'That is a lot of reports at once. Wait a minute, then try again.'
    case 503:
      return 'The library is not available right now.'
    case 504:
      return error.message || 'That took too long. Try a smaller radius.'
    default:
      return error.message || 'The report could not be finished. Please try again in a minute.'
  }
}

// --- Saying what happened ----------------------------------------------------

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
}

// --- Saying what the run is doing (P6-16) ------------------------------------
// This used to be a 1-second `setInterval` and nothing else: "Checking 40
// sources… 3s". A counting clock says the page is not frozen and nothing more,
// and for up to a minute it was the only thing moving. The run knows far more
// than that — every source is its own task and resolves to a complete section
// — so it now says it, over the stream the route opens.

/** One line of the run, as the server reports it. */
export type PlaceProgressEvent =
  /** How many sources will be checked. First event of every run. */
  | { type: 'start'; total: number }
  /** A source just went out to its agency. */
  | { type: 'source'; slug: string; title: string }
  /** A source came back — found, empty, or not checkable. */
  | { type: 'section'; slug: string; title: string; status: SectionStatus; done: number; total: number }
  /** Every source has settled; the model is writing the summary. */
  | { type: 'summary' }

export interface PlaceProgress {
  /** How many sources this run will check. */
  total: number
  /** How many have settled. Only ever climbs. */
  done: number
  found: number
  empty: number
  unchecked: number
  /** The source most recently sent out — what the run is on. */
  current: string
  /** The last source that could not be checked, named rather than swallowed. */
  trouble: string
  /** Past the sources, writing the summary. */
  writingSummary: boolean
}

/** The state before the stream has said anything. `total` is seeded from the
 *  source catalog, which is the honest upper bound until the server has
 *  decided which sources fit this place. */
export function initialProgress(total = 0): PlaceProgress {
  return { total, done: 0, found: 0, empty: 0, unchecked: 0, current: '', trouble: '', writingSummary: false }
}

/**
 * One event folded into the progress. Pure, and monotonic in `done` — a late
 * event from a source that resolved out of order must never make the count go
 * backwards, which is the one thing a progress number must promise.
 */
export function advanceProgress(state: PlaceProgress, event: PlaceProgressEvent): PlaceProgress {
  switch (event.type) {
    case 'start':
      return { ...state, total: Math.max(state.total, event.total) }
    case 'source':
      return { ...state, current: event.title }
    case 'section': {
      const next = {
        ...state,
        total: Math.max(state.total, event.total),
        done: Math.max(state.done, event.done),
      }
      if (event.status === 'found') next.found += 1
      else if (event.status === 'none') next.empty += 1
      else {
        next.unchecked += 1
        next.trouble = event.title
      }
      // The source that just answered is no longer the one in flight.
      if (state.current === event.title) next.current = ''
      return next
    }
    case 'summary':
      return { ...state, writingSummary: true, current: '', done: Math.max(state.done, state.total) }
  }
}

/**
 * What the page says it is doing. Names the source in flight and a
 * done-of-total count, so the sentence changes because something happened
 * rather than because a second passed.
 */
export function progressSentence(state: PlaceProgress): string {
  const counted = state.total ? `${state.done} of ${state.total} checked` : ''
  const found = state.done ? `${state.found} found so far` : ''
  const parts = [state.writingSummary ? 'Writing the summary' : state.current, counted, found].filter(Boolean)
  if (!parts.length) return 'Checking every data source we know about…'
  // Nothing has gone out yet, but we know how many will: say the number.
  if (!state.current && !state.writingSummary && !state.done) return `Checking ${plural(state.total, 'source')}…`
  return parts.join(' · ')
}

/**
 * The second line: elapsed time, and the reason the wait is reasonable.
 *
 * Elapsed time survives from the old line because it is genuinely useful — it
 * is just not the whole message. A named source that could not be checked
 * displaces the generic "slow sources" explanation: the concrete thing that
 * happened beats the general reason it might be slow.
 */
export function progressNote(state: PlaceProgress, elapsedSeconds = 0): string {
  const parts: string[] = []
  if (elapsedSeconds >= 1) parts.push(`${elapsedSeconds}s`)
  if (state.trouble) parts.push(`${state.trouble} could not be checked`)
  else if (elapsedSeconds >= 10) parts.push('slow sources get up to 30 seconds each, so this can take a minute')
  return parts.join(' · ')
}

/**
 * One section's status in words a researcher reads, not a status chip they
 * have to decode. The radius is in the sentence because "nothing" only means
 * anything next to how far we looked.
 */
export function statusPhrase(section: ReportSection, radiusMiles: number): string {
  switch (section.status) {
    case 'found':
      return `${plural(section.count, 'result')} within ${radiusMiles} miles`
    case 'none':
      return `Nothing within ${radiusMiles} miles`
    case 'skipped':
      return `Check by hand: ${section.reason ?? 'this one is published by hand.'}`
    case 'timeout':
      return 'Could not check in time'
    default:
      return `Could not check: ${section.reason ?? 'the source did not answer.'}`
  }
}

/** Higher/lower is better, in the words the compare table uses. */
export function directionCue(direction: string): string {
  return direction === 'lower_better' ? 'lower is better' : 'higher is better'
}

/**
 * Where the map is looking, if it has said.
 *
 * `/place` is its own route with no map on it, so "check where I am looking"
 * can only work if the map has left its centre somewhere. The contract is one
 * key in sessionStorage — deliberately NOT a module the map has to import,
 * because the map's bundle is the public one and must not gain a
 * knowledge-base library. Nothing there means the button is not offered,
 * which is the honest behaviour on a cold load anyway.
 *
 * Session-scoped and under the `blo:` prefix: where somebody was looking is
 * research, and it should not outlive the tab or the session.
 */
export const MAP_CENTRE_KEY = 'blo:map-centre'

export function readMapCentre(storage?: Pick<Storage, 'getItem'>): { lat: number; lng: number } | null {
  try {
    const store = storage ?? (typeof sessionStorage === 'undefined' ? null : sessionStorage)
    const raw = store?.getItem(MAP_CENTRE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { lat: unknown; lng: unknown }
    const lat = Number(parsed?.lat)
    const lng = Number(parsed?.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
    return { lat, lng }
  } catch {
    return null
  }
}

/**
 * Where a `[n]` in the summary should take the reader.
 *
 * The findings were numbered on the server and carry the href of the thing
 * they describe — so a citation of a source section can become an ANCHOR on
 * this page (the card is right there, with its rows) while anything else
 * keeps its link. Matching is on the href, which the server built from the
 * same section, rather than on the title, which a person could duplicate.
 */
export function citationTarget(
  source: { title: string; href: string },
  report: PlaceReport,
): { anchor: string } | { href: string } {
  const section = report.sections.find(s => s.href === source.href)
  if (section) return { anchor: `#section-${section.slug}` }
  // The county's link is matched on its county rather than the whole string:
  // the layer list is built on both sides and the two could legitimately
  // encode the comma differently.
  if (report.county && source.href.startsWith(`/compare?counties=${report.county.geoid}`)) return { anchor: '#county' }
  if (report.organizations.some(o => o.href === source.href)) return { anchor: '#organizations' }
  return { href: source.href }
}

/** "Compare" from the county card: this county, the layers actually shown. */
export function compareUrlFor(county: ReportCounty): string {
  const params = new URLSearchParams({ counties: county.geoid })
  if (county.layers.length) params.set('layers', county.layers.map(l => l.id).join(','))
  return `/compare?${params.toString()}`
}

/** "Show on map": the map framed on the county this place sits in. */
export function mapUrlFor(report: PlaceReport): string {
  return report.place.geoid ? `/?fit=${encodeURIComponent(report.place.geoid)}` : '/'
}

/** How many of each kind, for the one-line count under the heading. */
export function reportTally(report: PlaceReport): { found: number; none: number; unchecked: number } {
  const by = (status: SectionStatus) => report.sections.filter(s => s.status === status).length
  return { found: by('found'), none: by('none'), unchecked: by('skipped') + by('failed') + by('timeout') }
}

export function describeTally(report: PlaceReport): string {
  const { found, none, unchecked } = reportTally(report)
  const parts = [`${found} of ${report.sections.length} sources found something`]
  if (none) parts.push(`${none} found nothing`)
  if (unchecked) parts.push(`${unchecked} could not be checked`)
  return `${parts.join(' · ')}.`
}

// --- Keeping the report ------------------------------------------------------
// Same two ways out as an Ask answer (P5-48): a note of its own, or a section
// on a page that already collects the subject. Both write the SAME markdown,
// so a kept report reads the same wherever it lands; only the heading differs.

/** Square brackets in a title would close a markdown link early. */
function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1')
}

export function reportTitle(report: PlaceReport): string {
  return `Place report: ${report.place.label}`
}

export interface ReportMarkdownOptions {
  heading: string
  /** A note owns its outline and gets real headings; a section appended to
   *  someone else's page must not add to their table of contents. */
  subHeading: (text: string) => string
}

export function reportMarkdown(report: PlaceReport, options: ReportMarkdownOptions): string {
  const parts = [options.heading, '']
  const where = report.place.county ? `${report.place.county}, ${report.place.state}` : ''
  parts.push(
    `${report.place.label}${where ? ` — ${where}` : ''} · ${report.radiusMiles} miles · ${new Date(report.generatedAt).toLocaleDateString()}`,
  )
  parts.push('', describeTally(report))

  if (report.summary) {
    parts.push('', options.subHeading('Summary'), '', report.summary.text.trim())
  }

  parts.push('', options.subHeading('Data sources checked'))
  for (const section of report.sections) {
    parts.push(`- [${escapeLinkText(section.title)}](${section.href}) — ${statusPhrase(section, report.radiusMiles)}`)
  }

  if (report.county && report.county.layers.length) {
    parts.push('', options.subHeading(`${report.county.name}, ${report.county.state}`))
    for (const layer of report.county.layers) {
      parts.push(`- ${layer.name}: ${layer.formatted} (${directionCue(layer.direction)})`)
    }
    parts.push(`- [Compare this county](${compareUrlFor(report.county)})`)
  }

  if (report.organizations.length) {
    parts.push('', options.subHeading('Organizations nearby'))
    for (const org of report.organizations) {
      parts.push(`- [${escapeLinkText(org.name)}](${org.href}) — ${org.distanceMiles} miles`)
    }
  }

  parts.push('', `[Run this report again](${placeUrlFor(report)})`)
  return `${parts.join('\n')}\n`
}

/** The /place link that reopens this exact report. */
export function placeUrlFor(report: PlaceReport): string {
  if (report.place.lat !== null && report.place.lng !== null) {
    return placeUrl({ lat: report.place.lat, lng: report.place.lng, radius: report.radiusMiles })
  }
  return placeUrl({ geoid: report.place.geoid ?? '', radius: report.radiusMiles })
}

export function reportNoteMarkdown(report: PlaceReport): string {
  return reportMarkdown(report, { heading: `# ${reportTitle(report)}`, subHeading: t => `## ${t}` })
}

export function reportSectionMarkdown(report: PlaceReport): string {
  return reportMarkdown(report, { heading: `## ${reportTitle(report)}`, subHeading: t => `**${t}**` })
}

export function saveReportAsNote(report: PlaceReport): Promise<CatalogEntry> {
  return createNoteEntry({
    title: noteTitleFromQuestion(reportTitle(report)),
    body: reportNoteMarkdown(report),
    category: ANSWER_NOTE_CATEGORY,
    tags: [ANSWER_NOTE_TAG],
  })
}

/** Append a report to an existing page. The If-Unmodified-Since round trip is
 *  the point: if someone saved the page in between, the server says 412 and
 *  `saveWikiPage` throws rather than quietly overwriting their work. */
export async function addReportToPage(slug: string, report: PlaceReport): Promise<{ slug: string; title: string }> {
  const page = await fetchWikiPage(slug)
  if (!page) throw new Error(`There is no page named “${slug}” any more.`)
  const markdown = `${page.markdown.replace(/\s+$/, '')}\n\n${reportSectionMarkdown(report)}`
  const saved = await saveWikiPage(slug, markdown, { ifUnmodifiedSince: page.updatedAt })
  return { slug: saved.slug, title: saved.title || page.title }
}

// --- Download ----------------------------------------------------------------

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** The report as a file: one row per source with what it found. Not the rows
 *  themselves — those live behind "Open the full slice", one CSV per source
 *  (P5-57), because a report mixes twenty schemas and nothing lines up. */
export function reportCsv(report: PlaceReport): string {
  const header = ['Source', 'Provider', 'Status', 'Count', 'Notes', 'Link']
  const lines = [header.map(csvCell).join(',')]
  for (const section of report.sections) {
    lines.push(
      [
        section.title,
        section.provider,
        section.status,
        section.status === 'found' ? String(section.count) : '',
        section.reason ?? '',
        section.href,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

export function reportCsvFilename(report: PlaceReport): string {
  const stem = (report.place.label || 'place').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  return `place-report-${stem || 'place'}.csv`
}
