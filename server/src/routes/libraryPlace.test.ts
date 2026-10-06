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
 * P5-58 over the wire: the real app, the real report service, the real
 * catalog, the real bucket and the real P5-57 fetch — only the agency at the
 * far end, the model, and the county-values reader are faked. The things this
 * route can get wrong (an unauthenticated report, a missing CSRF token, a
 * hand-edited place key reaching the bucket, an unbounded `sources` list) are
 * invisible against a mocked service.
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
const { setPlaceReportDefaults, resetPlaceReportDefaults, clearCountyIndex } = await import('../services/placeReport.js')
const { resetRateLimits } = await import('../services/placeHttp.js')
const { REPORTS_LIMIT_MAX } = await import('./libraryPlace.js')
const { placeReportIndexSettled } = await import('../services/placeReportIndex.js')
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

const NPL = {
  title: 'EPA Superfund NPL sites',
  status: 'published',
  category: 'environment',
  source: {
    provider: 'US EPA',
    access: [{ type: 'arcgis', url: 'https://services.arcgis.com/x/rest/services/NPL/FeatureServer/0' }],
    placeQuery: { by: ['point', 'county'], radiusMiles: 5, fipsField: 'STCOFIPS' },
    updateCadence: 'weekly',
  },
}

const ASSESSOR = {
  title: 'County assessor parcels',
  status: 'published',
  source: {
    provider: 'Fulton County',
    homepage: 'https://example.gov/assessor',
    access: [{ type: 'manual', notes: 'Request a parcel export from the assessor’s office.' }],
    placeQuery: { by: ['county'] },
  },
}

const ask = vi.fn(async () => ({
  answer: 'Three Superfund sites sit within five miles [1].',
  sources: [{ n: 1, slug: 'epa-superfund-npl', kind: 'place', title: 'EPA Superfund NPL sites', href: '/library/epa-superfund-npl?place=g13121', snippet: '', cited: true }],
  queries: [],
  places: [],
  counts: { pages: 0, datasets: 0, documents: 0, notes: 0 },
  toolCalls: 0,
  usedTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
})) as any

const countyValues = vi.fn(async ({ layerId, geoids }: { layerId: string; geoids: string[] }) => ({
  layerId,
  counties: [{ geoid: geoids[0], value: layerId === 'pct_Black' ? 44.5 : null }],
})) as any

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(`INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`, [passwordHash])
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-place-report-route-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  fake.seed('library/sources/epa-superfund-npl/meta.json', JSON.stringify(NPL, null, 2))
  fake.seed('library/sources/fulton-assessor/meta.json', JSON.stringify(ASSESSOR, null, 2))
  await reindexCatalog()
  await resetInternalRateLimit()
  resetRateLimits()
  clearCountyIndex()
  ask.mockClear()
  countyValues.mockClear()
  agency = vi.fn(async () => jsonResponse(ARCGIS_GEOJSON))
  setPlaceFetchDefaults({ fetchImpl: agency as any, lookup: publicLookup as any })
  setPlaceReportDefaults({ ask, countyValues })
})

afterEach(async () => {
  resetPlaceFetchDefaults()
  resetPlaceReportDefaults()
  // P6-4: reindex launches the report-index rebuild detached — let it land
  // before the bucket's mirror directory is removed underneath it.
  await placeReportIndexSettled()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

let loginIp = 0
async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.97.0.${++loginIp}`)
    .send({ username: 'maria', password: 'place-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))!
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

function report(auth: { cookie: string; csrf: string }, body: unknown) {
  return request(app)
    .post('/api/library/place/report')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
    .send(body)
}

/** The same POST, asking for the progress stream (P6-16). `.buffer(true)` is
 *  what makes supertest collect a streamed body instead of leaving it open. */
function reportStream(auth: { cookie: string; csrf: string }, body: unknown) {
  return request(app)
    .post('/api/library/place/report')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
    .set('Accept', 'application/x-ndjson, application/json')
    .buffer(true)
    .send(body)
}

/** The stream, as the client reads it: one JSON event per line. */
function events(res: { text?: string; body?: unknown }): any[] {
  const raw =
    typeof res.text === 'string' && res.text
      ? res.text
      : Buffer.isBuffer(res.body)
        ? res.body.toString('utf8')
        : ''
  return raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
}

describe('the guard', () => {
  it('is internal-only and needs a CSRF token', async () => {
    expect((await request(app).post('/api/library/place/report').send({ geoid: '13121' })).status).toBe(401)
    expect((await request(app).get('/api/library/place/report/g13121')).status).toBe(401)
    const auth = await login()
    const noCsrf = await request(app).post('/api/library/place/report').set('Cookie', auth.cookie).send({ geoid: '13121' })
    expect(noCsrf.status).toBe(403)
    expect(agency).not.toHaveBeenCalled()
  })

  it('is subject to the per-user limiter', async () => {
    // P7-11: the ceiling is pinned low for this case. Walking up to the real
    // one cost 121 full place reports inside a 30s budget — the reason this
    // test has been flaky since 2026-09-29, and it was never module state.
    // Five also says WHERE the ceiling falls, which the old loop did not.
    process.env.INTERNAL_RATE_LIMIT_MAX = '5'
    await resetInternalRateLimit()
    try {
      const auth = await login()
      const codes: number[] = []
      for (let i = 0; i < 6; i++) codes.push((await report(auth, { geoid: '13121' })).status)
      expect(codes).toEqual([200, 200, 200, 200, 200, 429])
    } finally {
      delete process.env.INTERNAL_RATE_LIMIT_MAX
      await resetInternalRateLimit()
    }
  })
})

describe('POST /api/library/place/report', () => {
  it('runs every applicable source and returns the whole report', async () => {
    const auth = await login()
    const res = await report(auth, { geoid: '13121' })
    expect(res.status).toBe(200)
    expect(res.body.placeKey).toBe('g13121')
    expect(res.body.cached).toBe(false)
    expect(res.body.radiusMiles).toBe(5)
    expect(res.body.place).toMatchObject({ geoid: '13121', county: 'Fulton County', state: 'Georgia' })
    expect(res.body.sections.map((s: any) => [s.slug, s.status])).toEqual([
      ['epa-superfund-npl', 'found'],
      ['fulton-assessor', 'skipped'],
    ])
    expect(res.body.sections[0]).toMatchObject({ provider: 'US EPA', count: 3, cacheKey: 'g13121' })
    expect(res.body.sections[0].href).toBe('/library/epa-superfund-npl?place=g13121')
    expect(res.body.sections[1].reason).toContain('assessor')
    expect(res.body.county).toMatchObject({ geoid: '13121', name: 'Fulton County' })
    expect(res.body.county.layers[0]).toMatchObject({ id: 'pct_Black', formatted: '44.5%' })
    expect(res.body.summary.text).toContain('Three Superfund sites')
    expect(res.body.summary.sources[0].n).toBe(1)
    expect(typeof res.body.generatedAt).toBe('string')
  })

  it('answers the same place from the derived cache, and re-runs on refresh', async () => {
    const auth = await login()
    await report(auth, { geoid: '13121' })
    expect(agency).toHaveBeenCalledTimes(1)

    const again = await report(auth, { geoid: '13121' })
    expect(again.body.cached).toBe(true)
    expect(agency).toHaveBeenCalledTimes(1)

    const fresh = await report(auth, { geoid: '13121', refresh: true })
    expect(fresh.body.cached).toBe(false)
    expect(agency).toHaveBeenCalledTimes(2)
  })

  it('keeps the report at library/derived/place/<placeKey>.json', async () => {
    const auth = await login()
    await report(auth, { point: ATLANTA })
    expect([...fake.objects.keys()]).toContain('library/derived/place/p33.7490_-84.3880_r5.json')
  })

  it('narrows to the sources it was given without touching the cached report', async () => {
    const auth = await login()
    const res = await report(auth, { geoid: '13121', sources: ['epa-superfund-npl'] })
    expect(res.body.sections).toHaveLength(1)
    expect([...fake.objects.keys()].some(k => k.startsWith('library/derived/place/'))).toBe(false)
  })

  it.each([
    [{}, /an address, a point on the map, or a county/],
    [{ geoid: '131' }, /five digits/],
    [{ geoid: '13121', radiusMiles: 'far' }, /number of miles/],
    [{ geoid: '13121', sources: 'epa' }, /list of source slugs/],
    [{ geoid: '13121', sources: ['Not A Slug'] }, /not a slug/],
    [{ geoid: '13121', sources: Array.from({ length: 26 }, (_, i) => `s${i}`) }, /at most 25 sources/],
    [{ address: 'x'.repeat(400) }, /too long/],
  ])('refuses %j in words a person can act on', async (body, re) => {
    const auth = await login()
    const res = await report(auth, body)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(re)
    expect(agency).not.toHaveBeenCalled()
  })
})

describe('GET /api/library/place/report/:placeKey', () => {
  it('reads the last report back', async () => {
    const auth = await login()
    await report(auth, { geoid: '13121' })
    const res = await request(app).get('/api/library/place/report/g13121').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.cached).toBe(true)
    expect(res.body.sections).toHaveLength(2)
  })

  it('is a 404 for a place nobody has checked', async () => {
    const auth = await login()
    const res = await request(app).get('/api/library/place/report/g99999').set('Cookie', auth.cookie)
    expect(res.status).toBe(404)
    expect(res.body.error).toContain('No report')
  })

  it('refuses a place key that is not one', async () => {
    const auth = await login()
    for (const key of ['..%2Fsecrets', 'g131', 'nonsense']) {
      const res = await request(app).get(`/api/library/place/report/${key}`).set('Cookie', auth.cookie)
      expect(res.status).toBe(400)
    }
  })
})

describe('the audit trail', () => {
  it('records place.report with the place, the counts and the time', async () => {
    const auth = await login()
    await report(auth, { geoid: '13121' })
    // The audit write is fire-and-forget; give it the tick it needs.
    await new Promise(r => setTimeout(r, 20))
    const rows = await libraryQuery(`SELECT actor, action, target, detail FROM library_audit WHERE action = 'place.report'`)
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0] as any
    expect(row.actor).toBe('maria')
    expect(row.target).toBe('g13121')
    const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail
    expect(detail).toMatchObject({ placeKey: 'g13121', sources: 2, found: 1 })
    expect(typeof detail.ms).toBe('number')
  })
})

// --- Recent analyses (P6-4) --------------------------------------------------

describe('GET /api/library/place/reports', () => {
  it('lists what has been run, newest first, with who and when', async () => {
    const auth = await login()
    await report(auth, { geoid: '13121' })
    await report(auth, { point: ATLANTA })
    const res = await request(app).get('/api/library/place/reports').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.reports.map((r: any) => r.placeKey)).toEqual(['p33.7490_-84.3880_r5', 'g13121'])
    const [newest] = res.body.reports
    expect(newest.by).toBe('maria')
    expect(typeof newest.at).toBe('string')
    expect(typeof newest.found).toBe('number')
    expect(newest.label).toBeTruthy()
  })

  it('answers with an empty list before anything has been run', async () => {
    const auth = await login()
    const res = await request(app).get('/api/library/place/reports').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.reports).toEqual([])
  })

  it('honours ?limit= and caps it', async () => {
    const auth = await login()
    await report(auth, { geoid: '13121' })
    await report(auth, { point: ATLANTA })
    const one = await request(app).get('/api/library/place/reports?limit=1').set('Cookie', auth.cookie)
    expect(one.body.reports).toHaveLength(1)
    const silly = await request(app).get('/api/library/place/reports?limit=9999').set('Cookie', auth.cookie)
    expect(silly.status).toBe(200)
    expect(silly.body.reports.length).toBeLessThanOrEqual(REPORTS_LIMIT_MAX)
  })

  it('is internal-only', async () => {
    const res = await request(app).get('/api/library/place/reports')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })
})

/**
 * P6-16. The page used to show a seconds counter because the route was a
 * single JSON response and had no way to say anything else. It now answers
 * NDJSON — the same shape `POST /api/chats/:id/messages` uses — when the
 * caller asks for it, with no run state kept anywhere between requests.
 */
describe('POST /api/library/place/report — the progress stream (P6-16)', () => {
  it('streams the run and ends with the whole report', async () => {
    const auth = await login()
    const res = await reportStream(auth, { geoid: '13121' })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
    expect(res.headers['cache-control']).toBe('private, no-store')
    // No proxy may hold the stream back waiting for a full buffer.
    expect(res.headers['x-accel-buffering']).toBe('no')

    const stream = events(res)
    expect(stream[0]).toEqual({ type: 'start', total: 2 })
    expect(stream.map(e => e.type)).toEqual([
      'start',
      // The check-by-hand source is already decided, so it is already done.
      'section',
      'source',
      'section',
      'summary',
      'report',
    ])
    expect(stream[1]).toMatchObject({ slug: 'fulton-assessor', status: 'skipped', done: 1, total: 2 })
    expect(stream[2]).toMatchObject({ slug: 'epa-superfund-npl', title: 'EPA Superfund NPL sites' })
    expect(stream[3]).toMatchObject({ slug: 'epa-superfund-npl', status: 'found', done: 2, total: 2 })

    // The last line is exactly the body the plain JSON answer would have been.
    const report = stream.at(-1).report
    expect(report.placeKey).toBe('g13121')
    expect(report.cached).toBe(false)
    expect(report.sections.map((sec: any) => [sec.slug, sec.status])).toEqual([
      ['epa-superfund-npl', 'found'],
      ['fulton-assessor', 'skipped'],
    ])
    expect(report.summary.text).toContain('Three Superfund sites')
  })

  it('answers plain JSON when nobody asked for the stream', async () => {
    const auth = await login()
    const res = await report(auth, { geoid: '13121' })
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body.placeKey).toBe('g13121')
  })

  it('answers a cached report as plain JSON, because there is no run to report', async () => {
    const auth = await login()
    await report(auth, { geoid: '13121' })
    const again = await reportStream(auth, { geoid: '13121' })
    expect(again.status).toBe(200)
    expect(again.headers['content-type']).toMatch(/application\/json/)
    expect(again.body.cached).toBe(true)
  })

  it('refuses a bad request with a status code, not a stream', async () => {
    const auth = await login()
    const res = await reportStream(auth, { geoid: '1' })
    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body.error).toBeTruthy()
  })

  it('refuses a place it cannot resolve with a status code, before the stream opens', async () => {
    // Nothing has run, so nothing has been reported: the status line is still
    // available and is the honest way to refuse.
    const auth = await login()
    const res = await reportStream(auth, { address: '' })
    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toMatch(/application\/json/)
  })

  it('still audits a streamed report', async () => {
    const auth = await login()
    await reportStream(auth, { geoid: '13121' })
    const rows = await libraryQuery(`SELECT action, target, detail FROM library_audit WHERE action = 'place.report'`)
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].target).toBe('g13121')
  })

  it('writes the streamed report to the cache like any other', async () => {
    const auth = await login()
    await reportStream(auth, { geoid: '13121' })
    const again = await report(auth, { geoid: '13121' })
    expect(again.body.cached).toBe(true)
    expect(agency).toHaveBeenCalledTimes(1)
  })
})
