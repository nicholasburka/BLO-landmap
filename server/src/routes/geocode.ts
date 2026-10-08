import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { recordUsage, hashIp } from '../services/usageStore.js'

/**
 * GET /api/geocode/suggest?q=… (P9-11) — address type-ahead for the set map.
 *
 * **This exists to be counted.** The browser could call Mapbox directly and
 * for a while it did — the token is in the client bundle for the map tiles
 * regardless, so proxying buys no secrecy whatsoever. What it buys is a path:
 * `recordUsage` keys on one, so geocoding becomes a line on the internal
 * dashboard and a thing `internalRateLimit` can hold down. Nick asked that
 * the cost be monitored, and a number nobody can see is not monitoring.
 *
 * Mapbox rather than the free Census geocoder because the Census one cannot
 * do partial input, and type-ahead is the whole feature (Nick, 2026-10-08).
 *
 * Internal-tier only: a public, unauthenticated proxy to a metered API is an
 * invitation to spend somebody else's money.
 */
const router = Router()

/** Below this a query means nothing, and the client does not send one. The
 *  server checks anyway: a client is not a guarantee. */
export const GEOCODE_MIN_CHARS = 4
export const GEOCODE_MAX_CHARS = 200
const SUGGESTION_LIMIT = 5

export interface GeocodeHit {
  name: string
  center: [number, number]
}

/** Mapbox's answer, reduced to what a caller can use. Anything without a
 *  name and two finite numbers is dropped rather than placed at 0,0. */
export function readMapboxFeatures(body: unknown): GeocodeHit[] {
  const features = (body as { features?: unknown[] } | null)?.features
  if (!Array.isArray(features)) return []
  const hits: GeocodeHit[] = []
  for (const raw of features) {
    const feature = (raw ?? {}) as { place_name?: unknown; center?: unknown }
    const name = typeof feature.place_name === 'string' ? feature.place_name.trim() : ''
    const center = Array.isArray(feature.center) ? (feature.center as unknown[]) : []
    const lng = typeof center[0] === 'number' ? center[0] : NaN
    const lat = typeof center[1] === 'number' ? center[1] : NaN
    if (name && Number.isFinite(lng) && Number.isFinite(lat)) hits.push({ name, center: [lng, lat] })
  }
  return hits
}

export function mapboxSuggestUrl(query: string, token: string): string {
  return (
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
    `?access_token=${encodeURIComponent(token)}` +
    `&country=us&types=address,place,postcode&limit=${SUGGESTION_LIMIT}&autocomplete=true`
  )
}

router.get('/api/geocode/suggest', requireInternalUser, internalRateLimit, async (req, res) => {
  const raw = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (raw.length < GEOCODE_MIN_CHARS || raw.length > GEOCODE_MAX_CHARS) {
    // Not an error: a short query is the normal state of a box being typed
    // into, and 400ing it would make the client's restraint load-bearing.
    res.json({ hits: [] })
    return
  }

  const token = process.env.MAPBOX_ACCESS_TOKEN
  if (!token) {
    // NOT an empty list: that would render as "Nothing found for that", which
    // is a lie about the address rather than the truth about the deploy.
    // Railway does not read `server/.env`, so this is exactly what a prod box
    // looks like until someone sets the variable there.
    console.warn('[geocode] MAPBOX_ACCESS_TOKEN is not set — address search is off.')
    res.json({ hits: [], unavailable: true })
    return
  }

  const start = Date.now()
  let status = 200
  let hits: GeocodeHit[] = []
  try {
    const upstream = await fetch(mapboxSuggestUrl(raw, token))
    if (upstream.ok) hits = readMapboxFeatures(await upstream.json())
    else status = upstream.status === 429 ? 429 : 502
  } catch (err: any) {
    console.warn(`[geocode] lookup failed (${err?.message || err})`)
    status = 502
  }

  // Recorded whatever happened, because a failed call is a call that was
  // made and may well have been billed.
  recordUsage({
    ts: Date.now(),
    path: '/api/geocode/suggest',
    status,
    durationMs: Date.now() - start,
    inputTokens: 0,
    outputTokens: 0,
    tier: (res.locals.authTier as string) || 'internal',
    themes: [],
    ipHash: hashIp((res.locals.clientIp as string) || 'unknown'),
  })

  // A failure upstream is still an empty list here: a search box that breaks
  // the page because a geocoder hiccuped is worse than one that finds nothing.
  res.json({ hits })
})

export default router
