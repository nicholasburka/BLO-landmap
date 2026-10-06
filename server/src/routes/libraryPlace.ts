import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { isBucketEnabled } from '../services/libraryBucket.js'
import {
  foundCount,
  isReportFresh,
  readPlaceReport,
  runPlaceReport,
  type PlaceProgressEvent,
} from '../services/placeReport.js'
import { listPlaceReports } from '../services/placeReportIndex.js'
import { failureText, PlaceFetchError, type PlaceFetchFailure } from '../services/placeHttp.js'
import { PlaceScopeError } from '../services/placeReport.js'

/**
 * The place report (P5-58).
 *
 * Two routes: run one for a place, or read back the last one we ran. The
 * service does the work — resolving the place, running every applicable
 * source under a deadline, the county numbers, the organizations, the written
 * summary. This file's job is the guard, the limiter, the shape of the
 * request, and turning a failure into a sentence a researcher can act on.
 *
 * Internal + CSRF comes from `requireInternalUser`; `internalRateLimit` is on
 * the POST, which is the one that reaches twenty-five public agencies.
 */
const router = Router()
router.use('/api/library/place', requireInternalUser)

/** Same mapping the source-fetch route uses: our side of the conversation is
 *  a 400, the agency's a 502, too many questions a 429. */
const STATUS: Record<PlaceFetchFailure, number> = {
  'bad-scheme': 400,
  'not-public': 400,
  'no-endpoint': 400,
  'manual-only': 400,
  'bad-place': 400,
  'rate-limited': 429,
  'too-many-redirects': 502,
  'http-error': 502,
  'too-large': 502,
  timeout: 504,
  network: 502,
  'bad-response': 502,
}

/** A place key is `g<5 digits>` or `p<lat>_<lng>_r<miles>` — nothing else ever
 *  becomes a bucket key, whatever the URL says. */
export const PLACE_KEY_RE = /^(g\d{5}|p-?\d+(\.\d+)?_-?\d+(\.\d+)?_r\d+(\.\d+)?)$/

/** Slugs the caller may narrow the report to. Bounded, and each one has to
 *  look like a slug before it reaches a catalog query. */
export const SOURCES_MAX = 25
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

export interface ReportRequest {
  address?: string
  point?: { lat: unknown; lng: unknown } | null
  geoid?: string
  radiusMiles?: number
  sources?: string[]
  /** P7-1: run the report inside a working set — that set's sources, and no
   *  others. The slug is dereferenced by the service, never trusted as a list
   *  from the caller, which is what makes a scoped number citable. */
  workingSet?: string
  refresh?: boolean
}

/**
 * Read the body. Only the shape is checked here — whether the place can
 * actually be found is the geocoder's answer, and it comes back as a
 * `bad-place` failure with the words the reader needs.
 */
export function parseReportBody(raw: unknown): ReportRequest | { error: string } {
  const body = (raw ?? {}) as Record<string, unknown>

  const address = typeof body.address === 'string' ? body.address.trim() : ''
  if (address.length > 300) return { error: 'That address is too long to look up.' }

  const point =
    body.point && typeof body.point === 'object' && !Array.isArray(body.point)
      ? (body.point as { lat: unknown; lng: unknown })
      : null

  const geoid = typeof body.geoid === 'string' ? body.geoid.trim() : ''
  if (geoid && !/^\d{5}$/.test(geoid)) return { error: 'A county code is five digits.' }

  if (!address && !point && !geoid) {
    return { error: 'Give an address, a point on the map, or a county.' }
  }

  if (body.radiusMiles !== undefined && body.radiusMiles !== null) {
    const n = Number(body.radiusMiles)
    if (!Number.isFinite(n) || n <= 0) return { error: 'How far to look has to be a number of miles.' }
  }

  let sources: string[] | undefined
  if (body.sources !== undefined && body.sources !== null) {
    if (!Array.isArray(body.sources)) return { error: 'sources must be a list of source slugs.' }
    const slugs = body.sources.filter((s): s is string => typeof s === 'string').map(s => s.trim())
    if (slugs.some(s => !SLUG_RE.test(s))) return { error: 'One of those source names is not a slug.' }
    if (slugs.length > SOURCES_MAX) return { error: `A report covers at most ${SOURCES_MAX} sources.` }
    if (slugs.length) sources = [...new Set(slugs)]
  }

  let workingSet: string | undefined
  if (body.workingSet !== undefined && body.workingSet !== null && body.workingSet !== '') {
    if (typeof body.workingSet !== 'string') return { error: 'workingSet must be the name of a working set.' }
    const slug = body.workingSet.trim()
    if (!SLUG_RE.test(slug)) return { error: 'That is not the name of a working set.' }
    workingSet = slug
  }

  return {
    ...(address ? { address } : {}),
    ...(point ? { point } : {}),
    ...(geoid ? { geoid } : {}),
    ...(body.radiusMiles !== undefined && body.radiusMiles !== null ? { radiusMiles: Number(body.radiusMiles) } : {}),
    ...(sources ? { sources } : {}),
    ...(workingSet ? { workingSet } : {}),
    refresh: body.refresh === true,
  }
}

/**
 * A failure as a status and a sentence, once, so a refusal reads the same
 * whether it leaves as a status code or as the last line of a stream (P6-16).
 */
function failureOf(err: unknown, where: string): { status: number; error: string; code?: PlaceFetchFailure } {
  // P7-1: a scope we cannot honour is a sentence about the REQUEST — a working
  // set that does not exist, or one that names nothing yet. It leaves as a 400
  // with its own words rather than being dressed up as an agency's 502.
  if (err instanceof PlaceScopeError) {
    console.warn(`[place-report] ${where}: ${err.message}`)
    return { status: 400, error: err.message }
  }
  if (err instanceof PlaceFetchError) {
    console.error(`[place-report] ${where}: ${err.message}`)
    return { status: STATUS[err.code] ?? 502, error: failureText(err.code), code: err.code }
  }
  console.error(`[place-report] ${where} failed:`, (err as any)?.message || err)
  return { status: 500, error: 'Internal server error' }
}

function sendFailure(res: any, err: unknown, where: string): void {
  const { status, ...body } = failureOf(err, where)
  res.status(status).json(body)
}

function unavailable(res: any): boolean {
  if (isLibraryEnabled() && isBucketEnabled()) return false
  res.status(503).json({ error: 'library unavailable' })
  return true
}

/** The progress stream's media type — the same NDJSON the chat route speaks
 *  (`docs/CHAT.md`), which is how a caller asks for progress. */
export const NDJSON_TYPE = 'application/x-ndjson'

/**
 * Run every applicable source for one place and write the cited answer.
 *
 * Answers one JSON object, as it always has — unless the caller asked for
 * `application/x-ndjson`, in which case the run's progress goes out line by
 * line as it happens and the report is the last line (P6-16). No run state is
 * kept anywhere: the events are written straight onto the open response, from
 * inside the same call that produced them, so there is nothing to poll and no
 * queue to add.
 *
 * The stream opens LAZILY, on the first event. That keeps the two cases that
 * have no progress to report — a cached report, and a place that could not be
 * resolved at all — on the plain JSON path with their real status codes,
 * instead of committing a 200 before we know there is a run to describe.
 */
router.post('/api/library/place/report', internalRateLimit, async (req, res) => {
  if (unavailable(res)) return
  const user = res.locals.internalUser as { id: number; username: string } | undefined
  const parsed = parseReportBody(req.body)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }

  const wantsStream = String(req.headers.accept ?? '').includes(NDJSON_TYPE)
  let streaming = false
  const send = (event: PlaceProgressEvent | Record<string, unknown>): void => {
    if (!streaming) {
      streaming = true
      res.status(200)
      res.setHeader('Content-Type', `${NDJSON_TYPE}; charset=utf-8`)
      res.setHeader('Cache-Control', 'private, no-store')
      // Never let a proxy hold the stream back waiting for a full buffer.
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()
    }
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`)
  }

  try {
    const { report, placeKey, cached, ms } = await runPlaceReport({
      ...parsed,
      actor: { id: user?.id ?? null, username: user?.username ?? 'unknown' },
      ...(wantsStream ? { onProgress: send } : {}),
    })
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'place.report',
      target: placeKey,
      detail: { placeKey, sources: report.sections.length, found: foundCount(report), ms },
    })
    const body = { ...report, placeKey, cached }
    if (!streaming) {
      res.json(body)
      return
    }
    send({ type: 'report', report: body })
    res.end()
  } catch (err) {
    // Once the stream is open the status line is already spent, so the
    // refusal is the last event instead — carrying the status it would have
    // been, because that is what the page turns into its sentence.
    const failure = failureOf(err, 'report')
    if (!streaming) {
      const { status, ...body } = failure
      res.status(status).json(body)
      return
    }
    send({ type: 'error', ...failure })
    res.end()
  }
})

/**
 * P6-4: the reports we hold, newest first — "recent analyses" on `/analysis`.
 *
 * Read from the small index beside the cache, never by opening the reports:
 * the list is six lines a place and a report is up to fifty sections of rows.
 * Each row carries the place key, so one press reopens the cached report.
 */
export const REPORTS_LIMIT_DEFAULT = 20
export const REPORTS_LIMIT_MAX = 50

router.get('/api/library/place/reports', async (req, res) => {
  if (unavailable(res)) return
  const asked = Number(req.query.limit)
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), REPORTS_LIMIT_MAX) : REPORTS_LIMIT_DEFAULT
  try {
    res.json({ reports: await listPlaceReports(limit) })
  } catch (err) {
    sendFailure(res, err, 'reports')
  }
})

/** The last report for a place, if we still hold one. */
router.get('/api/library/place/report/:placeKey', async (req, res) => {
  if (unavailable(res)) return
  const placeKey = String(req.params.placeKey)
  if (!PLACE_KEY_RE.test(placeKey)) {
    res.status(400).json({ error: 'That is not a place we recognise.' })
    return
  }
  try {
    const report = await readPlaceReport(placeKey)
    // Past the week the cache is good for, "we have nothing" is the honest
    // answer — the page then offers to run it again.
    if (!report || !isReportFresh(report)) {
      res.status(404).json({ error: 'No report has been run for that place yet.' })
      return
    }
    res.json({ ...report, placeKey, cached: true })
  } catch (err) {
    sendFailure(res, err, `read ${placeKey}`)
  }
})

export default router
