import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * P5-57 over the wire: the real app, the real service, the real bucket and
 * catalog — only the agency at the far end is faked. That is deliberate: the
 * things this route can get wrong (an unauthenticated fetch, a missing CSRF
 * token, a failure the reader cannot act on) are invisible against a mock.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { reindexCatalog } = await import('../services/libraryCatalog.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { resetInternalRateLimit } = await import('../middleware/internalRateLimit.js')
const { setPlaceFetchDefaults, resetPlaceFetchDefaults } = await import('../services/placeFetch.js')
const { resetRateLimits } = await import('../services/placeHttp.js')
const { ARCGIS_GEOJSON, ATLANTA, jsonResponse, publicLookup } = await import('../testutils/fixtures/place/index.js')

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('place-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string
let agency: ReturnType<typeof vi.fn>

const SUPERFUND = {
  title: 'EPA Superfund NPL sites',
  status: 'published',
  category: 'environment',
  source: {
    provider: 'US EPA',
    access: [{ type: 'arcgis', url: 'https://services.arcgis.com/x/arcgis/rest/services/NPL/FeatureServer/0' }],
    placeQuery: { by: ['point', 'county'], radiusMiles: 5, fipsField: 'STCOFIPS' },
    updateCadence: 'weekly',
    replication: { status: 'indexed' },
  },
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(`INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`, [passwordHash])
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-place-route-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  fake.seed('library/sources/epa-superfund-npl/meta.json', JSON.stringify(SUPERFUND, null, 2))
  fake.seed(
    'library/sources/georgia-epd-ust/meta.json',
    JSON.stringify({ title: 'Georgia EPD USTs', source: { provider: 'Georgia EPD', access: [{ type: 'manual' }] } }, null, 2),
  )
  await reindexCatalog()
  await resetInternalRateLimit()
  resetRateLimits()
  agency = vi.fn(async () => jsonResponse(ARCGIS_GEOJSON))
  setPlaceFetchDefaults({ fetchImpl: agency as any, lookup: publicLookup as any })
})

afterEach(async () => {
  resetPlaceFetchDefaults()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

let loginIp = 0
async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.96.0.${++loginIp}`)
    .send({ username: 'maria', password: 'place-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))!
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

function fetchFor(auth: { cookie: string; csrf: string }, slug: string, body: unknown) {
  return request(app)
    .post(`/api/library/sources/${slug}/fetch`)
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
    .send(body)
}

describe('the guard', () => {
  it('is internal-only and needs a CSRF token to fetch', async () => {
    expect((await request(app).post('/api/library/sources/epa-superfund-npl/fetch').send({ geoid: '13121' })).status).toBe(401)
    expect((await request(app).get('/api/library/sources/epa-superfund-npl/slices')).status).toBe(401)
    const auth = await login()
    const noCsrf = await request(app).post('/api/library/sources/epa-superfund-npl/fetch').set('Cookie', auth.cookie).send({ geoid: '13121' })
    expect(noCsrf.status).toBe(403)
    expect(agency).not.toHaveBeenCalled()
  })
})

describe('POST /fetch', () => {
  it('returns the rows, the columns and the cache key, and says it was not cached', async () => {
    const auth = await login()
    const res = await fetchFor(auth, 'epa-superfund-npl', { point: ATLANTA })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      count: 3,
      truncated: false,
      cached: false,
      adapter: 'arcgis',
      cacheKey: 'p33.7490_-84.3880_r5',
    })
    expect(res.body.columns).toEqual(['Site_Name', 'Site_EPA_ID', 'Status', 'Site_Score'])
    expect(res.body.rows[0].Site_Name).toBe('Lakewood Landfill')
    expect(res.body.geometry.features).toHaveLength(2)
    expect(typeof res.body.fetchedAt).toBe('string')
  })

  it('answers the same question from the cache without calling out again', async () => {
    const auth = await login()
    await fetchFor(auth, 'epa-superfund-npl', { geoid: '13121' })
    const again = await fetchFor(auth, 'epa-superfund-npl', { geoid: '13121' })
    expect(again.body.cached).toBe(true)
    expect(agency).toHaveBeenCalledTimes(1)
  })

  it('explains a spreadsheets-only source instead of failing silently', async () => {
    const auth = await login()
    const res = await fetchFor(auth, 'georgia-epd-ust', { geoid: '13121' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('manual-only')
    expect(res.body.error).toContain('by hand')
  })

  it('says which part of the place is missing', async () => {
    const auth = await login()
    const res = await fetchFor(auth, 'epa-superfund-npl', {})
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('bad-place')
  })

  it('reports an agency that times out as the agency’s problem, in plain words', async () => {
    setPlaceFetchDefaults({
      fetchImpl: (async () => {
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
      }) as any,
      lookup: publicLookup as any,
    })
    const auth = await login()
    const res = await fetchFor(auth, 'epa-superfund-npl', { geoid: '13121' })
    expect(res.status).toBe(504)
    expect(res.body.error).toContain('took too long')
  })

  it('never calls a host that is not public', async () => {
    const called = vi.fn()
    setPlaceFetchDefaults({ fetchImpl: called as any, lookup: async () => [{ address: '10.1.2.3', family: 4 }] })
    const auth = await login()
    const res = await fetchFor(auth, 'epa-superfund-npl', { geoid: '13121' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('not-public')
    expect(called).not.toHaveBeenCalled()
  })

  it('is subject to the per-user limiter like every other internal route', async () => {
    // P7-11: a ceiling pinned low for this case — see libraryPlace's twin.
    // 121 real round trips to find the real one is what made this flaky.
    process.env.INTERNAL_RATE_LIMIT_MAX = '5'
    await resetInternalRateLimit()
    try {
      const auth = await login()
      const codes: number[] = []
      for (let i = 0; i < 6; i++) {
        codes.push((await fetchFor(auth, 'epa-superfund-npl', { geoid: '13121' })).status)
      }
      expect(codes).toEqual([200, 200, 200, 200, 200, 429])
    } finally {
      delete process.env.INTERNAL_RATE_LIMIT_MAX
      await resetInternalRateLimit()
    }
  })
})

describe('GET /slices', () => {
  it('lists what we hold, with counts and ages but no rows', async () => {
    const auth = await login()
    await fetchFor(auth, 'epa-superfund-npl', { geoid: '13121' })
    const res = await request(app).get('/api/library/sources/epa-superfund-npl/slices').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.slices).toHaveLength(1)
    expect(res.body.slices[0]).toMatchObject({ cacheKey: 'g13121', count: 3, adapter: 'arcgis', ttlDays: 7 })
    expect(res.body.slices[0].rows).toBeUndefined()
  })

  it('is empty rather than an error for a source nobody has asked about', async () => {
    const auth = await login()
    const res = await request(app).get('/api/library/sources/georgia-epd-ust/slices').set('Cookie', auth.cookie)
    expect(res.body.slices).toEqual([])
  })
})

describe('POST /promote', () => {
  it('creates an incoming dataset from a cached slice, with its lineage', async () => {
    const auth = await login()
    const fetched = await fetchFor(auth, 'epa-superfund-npl', { geoid: '13121' })
    const res = await request(app)
      .post('/api/library/sources/epa-superfund-npl/promote')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ cacheKey: fetched.body.cacheKey, title: 'NPL near the farm' })
    expect(res.status).toBe(201)
    expect(res.body.rows).toBe(3)

    const entry = await request(app).get(`/api/library/catalog/${res.body.slug}`).set('Cookie', auth.cookie)
    expect(entry.body.entry.title).toBe('NPL near the farm')
    expect(entry.body.entry.meta.lineage.from).toBe('source:epa-superfund-npl')
    expect(entry.body.entry.status).toBe('needs-review')
  })

  it('needs to be told which place, and refuses one it does not hold', async () => {
    const auth = await login()
    const noKey = await request(app)
      .post('/api/library/sources/epa-superfund-npl/promote')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({})
    expect(noKey.status).toBe(400)
    const missing = await request(app)
      .post('/api/library/sources/epa-superfund-npl/promote')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ cacheKey: 'g99999' })
    expect(missing.status).toBe(400)
    expect(missing.body.code).toBe('bad-place')
  })
})
