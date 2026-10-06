import rateLimit, { MemoryStore } from 'express-rate-limit'

/**
 * Per-user ceiling for the internal library endpoints (phase 5 hardening).
 *
 * The IP limiters in rateLimit.ts guard the public surface; these routes sit
 * behind requireInternalUser, where the interesting subject is the ACCOUNT,
 * not the address — one logged-in session paging a 200 MB dataset in a loop
 * (or a leaked cookie replayed from a botnet) is the case that hurts, and an
 * IP key misses both. 120/min is far above the app's own burst (a table view
 * is a handful of calls) and far below what pins the box.
 */

const DEFAULT_INTERNAL_RATE_LIMIT_MAX = 120

/**
 * The ceiling, read per request — so a deployment can tune it (the daily
 * budget in budget.ts is configured the same way) and so a test can pin a
 * small one for its own case.
 *
 * P7-11: the two per-user-limiter cases found the ceiling by spending
 * `INTERNAL_RATE_LIMIT_MAX + 2` real HTTP round trips, and one of those
 * routes runs a whole place report — 121 requests inside a 30s budget, at
 * 250-800ms each on a box that also hosts the dev stack. That is why both
 * have been failing intermittently since 2026-09-29, and twice been written
 * off as contention: they WERE contention, of the test's own wall clock, and
 * no amount of module-state isolation was ever going to settle them. Six
 * requests against a ceiling of five prove the same rule in two seconds.
 */
export function internalRateLimitMax(): number {
  const raw = Number(process.env.INTERNAL_RATE_LIMIT_MAX)
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_INTERNAL_RATE_LIMIT_MAX
}

export const INTERNAL_RATE_LIMIT_MAX = internalRateLimitMax()
export const INTERNAL_RATE_LIMIT_WINDOW_MS = 60_000

// Held here (not just inside the middleware) so tests can empty it between
// cases — the limiter is module state shared by every route that uses it.
const store = new MemoryStore()

export const internalRateLimit = rateLimit({
  windowMs: INTERNAL_RATE_LIMIT_WINDOW_MS,
  limit: () => internalRateLimitMax(),
  store,
  standardHeaders: true,
  legacyHeaders: false,
  // The address is only a fallback: these routes are guarded, so an
  // unauthenticated request should not normally reach the limiter at all.
  keyGenerator: (req, res) => {
    const user = res.locals.internalUser as { id: number } | undefined
    return user ? `user:${user.id}` : `ip:${req.ip ?? 'unknown'}`
  },
  message: { error: 'too many requests' },
})

/** Drop every bucket. For tests, which share one process and one store. */
export async function resetInternalRateLimit(): Promise<void> {
  await store.resetAll()
}
