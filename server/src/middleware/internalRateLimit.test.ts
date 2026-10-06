import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { internalRateLimit, resetInternalRateLimit, INTERNAL_RATE_LIMIT_MAX } from './internalRateLimit.js'

/**
 * The internal tier is small and trusted, so this limiter is not a security
 * boundary against outsiders — it is the ceiling that stops one logged-in
 * account (or a runaway script holding its cookie) from pinning the box.
 */

/** A bare app so the limit can be exercised without a login per request. */
function appAs(userId: number | null) {
  const app = express()
  app.set('trust proxy', 1)
  app.use((_req, res, next) => {
    if (userId !== null) res.locals.internalUser = { id: userId, username: `u${userId}` }
    next()
  })
  app.get('/thing', internalRateLimit, (_req, res) => {
    res.json({ ok: true })
  })
  return app
}

beforeEach(async () => {
  await resetInternalRateLimit()
})

describe('internalRateLimit', () => {
  it('allows the quota then 429s with a JSON error', async () => {
    const app = appAs(7)
    for (let i = 0; i < INTERNAL_RATE_LIMIT_MAX; i++) {
      expect((await request(app).get('/thing')).status, `request ${i + 1}`).toBe(200)
    }
    const over = await request(app).get('/thing')
    expect(over.status).toBe(429)
    expect(over.body).toEqual({ error: 'too many requests' })
  })

  it('counts per user, not per address — and falls back to the address when there is no user', async () => {
    const one = appAs(1)
    for (let i = 0; i < INTERNAL_RATE_LIMIT_MAX; i++) await request(one).get('/thing')
    expect((await request(one).get('/thing')).status).toBe(429)
    // A different account, same address: its own budget.
    expect((await request(appAs(2)).get('/thing')).status).toBe(200)
    // No session at all: keyed by address, so it still has a budget.
    expect((await request(appAs(null)).get('/thing')).status).toBe(200)
  })
})
