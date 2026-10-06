import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'

/**
 * P5-20: the usage dashboard's data endpoints are internal-tier now.
 * `/api/usage` and `/api/health/usage` require a logged-in internal user
 * (session cookie) — a staging-tier bearer token no longer grants access.
 * Runs against the real createApp() so the wiring under test is production's.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'
process.env.STAGING_PASSWORD = 'staging-pass-for-test'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('usage-pass-123')
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('ops', $1, 'internal')`,
    [passwordHash],
  )
})

afterEach(async () => {
  await closeLibraryDb()
})

async function loginCookie(): Promise<string> {
  const res = await request(app)
    .post('/api/login')
    .send({ username: 'ops', password: 'usage-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return cookie.split(';')[0]
}

describe('/api/usage gate (P5-20)', () => {
  it('200 with the usage payload for a logged-in internal user', async () => {
    const cookie = await loginCookie()
    const res = await request(app).get('/api/usage').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ windowDays: 14, persistence: expect.any(String) })
    expect(Array.isArray(res.body.daily)).toBe(true)
    expect(res.body.today).toBeDefined()
  })

  it('bare 401 with no session', async () => {
    const res = await request(app).get('/api/usage')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  it('a valid STAGING-tier bearer token does NOT grant access', async () => {
    const auth = await request(app).post('/api/auth').send({ password: 'staging-pass-for-test' })
    expect(auth.status).toBe(200)
    expect(auth.body.tier).toBe('staging')
    const res = await request(app)
      .get('/api/usage')
      .set('Authorization', `Bearer ${auth.body.token}`)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })
})

describe('/api/health/usage gate (P5-20)', () => {
  it('200 for a logged-in internal user', async () => {
    const cookie = await loginCookie()
    const res = await request(app).get('/api/health/usage').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.usage).toBeDefined()
  })

  it('bare 401 with no session (staging token included)', async () => {
    const auth = await request(app).post('/api/auth').send({ password: 'staging-pass-for-test' })
    const res = await request(app)
      .get('/api/health/usage')
      .set('Authorization', `Bearer ${auth.body.token}`)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })
})

describe('/dashboard page', () => {
  it('still serves its assets publicly (the data behind it is what is gated)', async () => {
    const html = await request(app).get('/dashboard')
    expect(html.status).toBe(200)
    expect(html.type).toBe('text/html')
    // No staging-password prompt anywhere in the shipped page.
    expect(html.text.toLowerCase()).not.toContain('staging')
    const js = await request(app).get('/dashboard.js')
    expect(js.status).toBe(200)
    expect(js.text).not.toContain('/api/auth')
  })
})
