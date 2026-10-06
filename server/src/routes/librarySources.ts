import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { isLibraryEnabled } from '../services/libraryDb.js'
import { isBucketEnabled } from '../services/libraryBucket.js'
import { fetchForPlace, listSlices, promoteSlice } from '../services/placeFetch.js'
import { failureText, PlaceFetchError, type PlaceFetchFailure } from '../services/placeHttp.js'

/**
 * Fetch a source for a place (P5-57).
 *
 * Three routes, all internal-tier: ask for a place, list what we already hold,
 * and turn one of those slices into a real dataset. The service does the work;
 * this file's job is the guard, the limiter, and turning a failure into a
 * sentence the person reading it can act on.
 *
 * Internal + CSRF comes from `requireInternalUser`; `internalRateLimit` is on
 * the two routes that reach the outside world, per user, on top of the
 * per-source limit the fetcher keeps.
 */
const router = Router()
router.use('/api/library/sources', requireInternalUser)

/** HTTP status per failure: our side of the conversation is a 400, the
 *  agency's is a 502, and too many questions is a 429. */
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

function sendFailure(res: any, err: unknown, where: string): void {
  if (err instanceof PlaceFetchError) {
    // The reader gets the plain sentence; the log keeps the detail.
    console.error(`[place] ${where}: ${err.message}`)
    res.status(STATUS[err.code] ?? 502).json({ error: failureText(err.code), code: err.code })
    return
  }
  console.error(`[place] ${where} failed:`, (err as any)?.message || err)
  res.status(500).json({ error: 'Internal server error' })
}

function unavailable(res: any): boolean {
  if (isLibraryEnabled() && isBucketEnabled()) return false
  res.status(503).json({ error: 'library unavailable' })
  return true
}

/** Fetch one place's worth of a source. Cached slices answer without a call. */
router.post('/api/library/sources/:slug/fetch', internalRateLimit, async (req, res) => {
  if (unavailable(res)) return
  const user = res.locals.internalUser
  const body = (req.body ?? {}) as Record<string, unknown>
  const point = body.point && typeof body.point === 'object' ? (body.point as { lat: unknown; lng: unknown }) : null
  try {
    const result = await fetchForPlace({
      slug: String(req.params.slug),
      point,
      geoid: body.geoid,
      address: body.address,
      radiusMiles: body.radiusMiles,
      refresh: body.refresh === true,
      actor: { id: user?.id ?? null, username: user?.username ?? 'unknown' },
    })
    res.json({
      rows: result.rows,
      columns: result.columns,
      count: result.count,
      truncated: result.truncated,
      fetchedAt: result.fetchedAt,
      cacheKey: result.cacheKey,
      cached: result.cached,
      adapter: result.adapter,
      place: result.place,
      ...(result.geometry ? { geometry: result.geometry } : {}),
    })
  } catch (err) {
    sendFailure(res, err, `fetch ${req.params.slug}`)
  }
})

/** What we already hold for this source — places, counts and ages, no rows. */
router.get('/api/library/sources/:slug/slices', async (req, res) => {
  if (unavailable(res)) return
  try {
    const slices = await listSlices(String(req.params.slug))
    res.json({
      slices: slices.map(s => ({
        cacheKey: s.cacheKey,
        place: s.place,
        count: s.count,
        truncated: s.truncated,
        adapter: s.adapter,
        fetchedAt: s.fetchedAt,
        ttlDays: s.ttlDays,
      })),
    })
  } catch (err) {
    sendFailure(res, err, `slices ${req.params.slug}`)
  }
})

/** Keep a slice: it becomes an incoming dataset and the ordinary pipeline
 *  (clean → file → explore → map) takes over from there. */
router.post('/api/library/sources/:slug/promote', internalRateLimit, async (req, res) => {
  if (unavailable(res)) return
  const user = res.locals.internalUser
  const body = (req.body ?? {}) as Record<string, unknown>
  const cacheKey = typeof body.cacheKey === 'string' ? body.cacheKey.trim() : ''
  if (!cacheKey) {
    res.status(400).json({ error: 'say which place to save (cacheKey)' })
    return
  }
  try {
    const result = await promoteSlice({
      slug: String(req.params.slug),
      cacheKey,
      title: typeof body.title === 'string' ? body.title : undefined,
      actor: { id: user?.id ?? null, username: user?.username ?? 'unknown' },
      clientIp: req.ip,
    })
    res.status(201).json({ slug: result.slug, rows: result.rows })
  } catch (err) {
    sendFailure(res, err, `promote ${req.params.slug}`)
  }
})

export default router
