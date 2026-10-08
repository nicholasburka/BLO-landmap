import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'

/**
 * GET /api/geocode/suggest (P9-11), against the real createApp().
 *
 * The route exists to be COUNTED, so what is under test is the guard chain
 * and the honesty of its answers — not geocoding, which is Mapbox's job and
 * is stubbed. A public proxy to a metered API is an invitation to spend
 * somebody else's money, so "logged out gets nothing" is the load-bearing
 * case here.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { resetInternalRateLimit } = await import('../middleware/internalRateLimit.js')
const { readMapboxFeatures, mapboxSuggestUrl, GEOCODE_MIN_CHARS } = await import('./geocode.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let passwordHash: string
let fetchMock: ReturnType<typeof vi.fn>

const MAPBOX_REPLY = {
  features: [{ place_name: '1 Main St, Memphis, Tennessee', center: [-90.05, 35.1] }],
}

beforeAll(async () => {
  passwordHash = await argon2.hash('geo-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

beforeEach(async () => {
  await resetInternalRateLimit()
  process.env.MAPBOX_ACCESS_TOKEN = 'pk.test-token'
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => MAPBOX_REPLY }) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  delete process.env.MAPBOX_ACCESS_TOKEN
  vi.unstubAllGlobals()
  await closeLibraryDb()
})

let loginIp = 0
async function login(): Promise<string> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.97.0.${++loginIp}`)
    .send({ username: 'maria', password: 'geo-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return cookie.split(';')[0]
}

const suggest = (cookie: string, q: string) =>
  request(app).get('/api/geocode/suggest').query({ q }).set('Cookie', cookie)

describe('GET /api/geocode/suggest', () => {
  it('refuses a logged-out caller, and spends nothing doing it', async () => {
    // The whole reason this is not a public proxy.
    const res = await request(app).get('/api/geocode/suggest').query({ q: '1 Main St Memphis' })
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers an internal caller with named points', async () => {
    const cookie = await login()
    const res = await suggest(cookie, '1 Main St Memphis')
    expect(res.status).toBe(200)
    expect(res.body.hits).toEqual([{ name: '1 Main St, Memphis, Tennessee', center: [-90.05, 35.1] }])
  })

  it('spends nothing on a query too short to mean anything', async () => {
    const cookie = await login()
    const res = await suggest(cookie, 'x'.repeat(GEOCODE_MIN_CHARS - 1))
    expect(res.status).toBe(200)
    expect(res.body.hits).toEqual([])
    // The client also holds this line; the server does not trust it to.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says it is NOT CONFIGURED rather than finding nothing', async () => {
    // Railway does not read server/.env, so this is what a prod box looks
    // like until somebody sets the variable. "Nothing found" would be a lie
    // about the address instead of the truth about the deploy.
    delete process.env.MAPBOX_ACCESS_TOKEN
    const cookie = await login()
    const res = await suggest(cookie, '1 Main St Memphis')
    expect(res.body).toEqual({ hits: [], unavailable: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('finds nothing, rather than failing, when the geocoder does', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 } as unknown as Response)
    const cookie = await login()
    const res = await suggest(cookie, '1 Main St Memphis')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ hits: [] })
  })

  it('finds nothing when the call throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const cookie = await login()
    const res = await suggest(cookie, '1 Main St Memphis')
    expect(res.status).toBe(200)
    expect(res.body.hits).toEqual([])
  })

  it('never returns the token to the browser', async () => {
    const cookie = await login()
    const res = await suggest(cookie, '1 Main St Memphis')
    expect(JSON.stringify(res.body)).not.toContain('pk.test-token')
  })
})

describe('the Mapbox call itself', () => {
  it('asks for addresses first — the reason this is not the Census geocoder', () => {
    const url = mapboxSuggestUrl('1 main st', 'pk.tok')
    expect(url).toContain('types=address')
    expect(url).toContain('autocomplete=true')
    expect(url).toContain('country=us')
  })

  it('escapes the query, so a search box is not a way to rewrite the URL', () => {
    const url = mapboxSuggestUrl('a&b?c=d #1', 'pk.tok')
    const [, qs] = url.split('?')
    // One access_token, one of each parameter: nothing was injected.
    expect(qs.match(/access_token=/g)).toHaveLength(1)
    expect(url).not.toContain('a&b?c=d')
  })

  it('drops a feature with no usable coordinates instead of placing it at 0,0', () => {
    expect(
      readMapboxFeatures({
        features: [
          { place_name: 'Nowhere', center: ['x', 'y'] },
          { place_name: '', center: [1, 2] },
          { place_name: 'Real', center: [1, 2] },
        ],
      }),
    ).toEqual([{ name: 'Real', center: [1, 2] }])
  })

  it('reads nonsense as nothing', () => {
    expect(readMapboxFeatures(null)).toEqual([])
    expect(readMapboxFeatures({})).toEqual([])
    expect(readMapboxFeatures({ features: 'no' })).toEqual([])
  })
})
