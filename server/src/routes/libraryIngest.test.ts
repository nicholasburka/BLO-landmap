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
 * P5-59 over the wire: the real app, the real inspector, the real bucket and
 * catalog — only the agency at the far end is faked. The things this can get
 * wrong are all invisible against a mock: a researcher able to set the plan, a
 * missing CSRF token accepted, an inspection that never reaches the manifest.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { indexFileBackedEntry, getCatalogEntry } = await import('../services/libraryCatalog.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { resetInternalRateLimit } = await import('../middleware/internalRateLimit.js')
const { setInspectDefaults, resetInspectDefaults } = await import('../services/linkInspect.js')
const { setLinkFetchDefaults, resetLinkFetchQueue, whenQueueIdle } = await import('../services/linkFetchQueue.js')
const { setDocumentPullDefaults, resetDocumentPullDefaults } = await import('../services/documentPull.js')
const { ARCGIS_LAYER, CSV_BODY, PLAIN_PAGE, jsonProbe, probeResponse, publicLookup } = await import(
  '../testutils/fixtures/inspect/index.js'
)

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('ingest-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string
let ip = 0

/** A fetch that answers ArcGIS metadata for the layer URL and a page otherwise. */
function agency(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: any) => {
    const url = String(input)
    if (url.includes('returnCountOnly')) return jsonProbe({ count: 1337 })
    if (url.includes('FeatureServer')) return jsonProbe(ARCGIS_LAYER)
    if (url.includes('.csv')) return probeResponse(CSV_BODY, 'text/csv')
    return probeResponse(PLAIN_PAGE, 'text/html')
  })
}

async function seedLink(slug: string, url: string, extra: Record<string, unknown> = {}): Promise<void> {
  const meta = {
    title: `link ${slug}`,
    category: '',
    status: 'needs-cataloging',
    tags: [],
    url,
    linkedBy: 'maria',
    linkedAt: '2026-09-06T00:00:00.000Z',
    originalFilename: null,
    ...extra,
  }
  const key = `library/incoming/${slug}/meta.json`
  const json = JSON.stringify(meta, null, 2)
  fake.seed(key, json)
  await indexFileBackedEntry('incoming', slug, meta, [{ key, size: Buffer.byteLength(json) }])
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(`INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`, [passwordHash])
  await libraryQuery(`INSERT INTO library_users (username, password_hash, role) VALUES ('nick', $1, 'admin')`, [passwordHash])
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-ingest-route-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  setInspectDefaults({ fetchImpl: agency() as unknown as typeof fetch, lookup: publicLookup })
  resetLinkFetchQueue()
  await resetInternalRateLimit()
})

afterEach(async () => {
  await whenQueueIdle()
  resetLinkFetchQueue()
  resetDocumentPullDefaults()
  resetInspectDefaults()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

async function login(username: string): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.98.0.${++ip}`)
    .send({ username, password: 'ingest-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))!
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

const LAYER = 'https://services1.arcgis.com/ab/arcgis/rest/services/NPL_Sites/FeatureServer/0'

describe('POST /api/library/catalog/:slug/inspect', () => {
  it('is closed to the logged-out', async () => {
    await seedLink('a', LAYER)
    const res = await request(app).post('/api/library/catalog/a/inspect').send({})
    expect(res.status).toBe(401)
  })

  it('refuses without a CSRF token', async () => {
    await seedLink('a', LAYER)
    const { cookie } = await login('maria')
    const res = await request(app).post('/api/library/catalog/a/inspect').set('Cookie', cookie).send({})
    expect(res.status).toBe(403)
  })

  it('classifies the link, stores it on the entry, and proposes a source', async () => {
    await seedLink('a', LAYER)
    const { cookie, csrf } = await login('maria')
    const res = await request(app).post('/api/library/catalog/a/inspect').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({})

    expect(res.status).toBe(200)
    expect(res.body.inspection.kind).toBe('arcgis-layer')
    expect(res.body.summary).toContain('ArcGIS point layer')
    expect(res.body.proposal.source.access[0]).toMatchObject({ type: 'arcgis', url: LAYER })
    expect(res.body.proposal.inferred).toContain('provider')
    expect(res.body.suggestedPlan).toMatchObject({ plan: 'fetch-on-demand' })

    // Data on the entry, never applied: the title is untouched.
    const entry = await getCatalogEntry('a')
    expect((entry!.meta.inspection as any).kind).toBe('arcgis-layer')
    expect(entry!.title).toBe('link a')
    expect(entry!.status).toBe('needs-cataloging')
  })

  it('says so plainly when the entry has no link', async () => {
    const key = 'library/incoming/n/meta.json'
    const meta = { title: 'no link', status: 'needs-review' }
    fake.seed(key, JSON.stringify(meta))
    await indexFileBackedEntry('incoming', 'n', meta, [{ key, size: 30 }])
    const { cookie, csrf } = await login('maria')
    const res = await request(app).post('/api/library/catalog/n/inspect').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no link/i)
  })

  it('writes an audit row', async () => {
    await seedLink('a', LAYER)
    const { cookie, csrf } = await login('maria')
    await request(app).post('/api/library/catalog/a/inspect').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({})
    await new Promise(r => setTimeout(r, 30))
    const rows = await libraryQuery(`SELECT action, target FROM library_audit WHERE action = 'library.inspect'`)
    expect(rows.rows).toHaveLength(1)
    expect((rows.rows[0] as any).target).toBe('a')
  })
})

describe('GET /api/library/catalog/:slug/proposal', () => {
  it('answers from the stored inspection without asking the agency again', async () => {
    await seedLink('a', LAYER)
    const { cookie, csrf } = await login('maria')
    await request(app).post('/api/library/catalog/a/inspect').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({})

    const fetchImpl = vi.fn()
    setInspectDefaults({ fetchImpl: fetchImpl as unknown as typeof fetch, lookup: publicLookup })
    const res = await request(app).get('/api/library/catalog/a/proposal').set('Cookie', cookie)
    expect(res.status).toBe(200)
    // P5-59: the layer's own copyrightText names the publisher, so the
    // proposal says who it is rather than falling back to the hostname.
    expect(res.body.proposal.source.provider).toBe('US EPA Office of Land and Emergency Management')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('tells you to inspect first when nothing has looked at the link', async () => {
    await seedLink('a', LAYER)
    const { cookie } = await login('maria')
    const res = await request(app).get('/api/library/catalog/a/proposal').set('Cookie', cookie)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Inspect this link/i)
  })
})

describe('POST /api/library/catalog/:slug/plan', () => {
  it('is admin-only: a researcher gets the same bare 401 as a stranger', async () => {
    await seedLink('a', LAYER)
    const { cookie, csrf } = await login('maria')
    const res = await request(app)
      .post('/api/library/catalog/a/plan')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ plan: 'replicate' })
    expect(res.status).toBe(401)

    const anonymous = await request(app).post('/api/library/catalog/a/plan').send({ plan: 'replicate' })
    expect(anonymous.status).toBe(401)
  })

  it('records the decision, who made it and when', async () => {
    await seedLink('a', LAYER)
    const { cookie, csrf } = await login('nick')
    const res = await request(app)
      .post('/api/library/catalog/a/plan')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ plan: 'replicate', mode: 'manual', owner: 'Nick', note: 'pull, clean, push' })

    expect(res.status).toBe(200)
    expect(res.body.ingest).toMatchObject({ plan: 'replicate', mode: 'manual', owner: 'Nick', decidedBy: 'nick' })
    const entry = await getCatalogEntry('a')
    expect((entry!.meta.ingest as any).note).toBe('pull, clean, push')
  })

  it('refuses a plan that is not one of the four', async () => {
    await seedLink('a', LAYER)
    const { cookie, csrf } = await login('nick')
    const res = await request(app)
      .post('/api/library/catalog/a/plan')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ plan: 'magic' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/fetch-on-demand/)
  })

  it('changing the plan does not un-copy what already arrived', async () => {
    await seedLink('a', LAYER, {
      ingest: {
        plan: 'replicate',
        decidedBy: 'nick',
        decidedAt: '2026-09-01T00:00:00.000Z',
        done: { at: '2026-09-02T00:00:00.000Z', dataset: 'npl-sites' },
      },
    })
    const { cookie, csrf } = await login('nick')
    const res = await request(app)
      .post('/api/library/catalog/a/plan')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ plan: 'index' })
    expect(res.body.ingest.done).toEqual({ at: '2026-09-02T00:00:00.000Z', dataset: 'npl-sites' })
  })
})

describe('POST /api/library/catalog/:slug/replicate', () => {
  it('is admin-only and queues rather than making the caller wait', async () => {
    await seedLink('a', LAYER)
    const researcher = await login('maria')
    const denied = await request(app)
      .post('/api/library/catalog/a/replicate')
      .set('Cookie', researcher.cookie)
      .set('X-CSRF-Token', researcher.csrf)
      .send({})
    expect(denied.status).toBe(401)

    const ran: string[] = []
    setLinkFetchDefaults({ replicate: async job => void ran.push(job.slug) })
    const { cookie, csrf } = await login('nick')
    const res = await request(app).post('/api/library/catalog/a/replicate').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({})
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ replicate: 'queued' })

    await whenQueueIdle()
    expect(ran).toEqual(['a'])
  })

  it('404s an entry that is not there', async () => {
    const { cookie, csrf } = await login('nick')
    const res = await request(app).post('/api/library/catalog/gone/replicate').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({})
    expect(res.status).toBe(404)
  })
})

describe('GET /api/library/catalog?plan=', () => {
  it('filters by the plan, and by having none at all', async () => {
    await seedLink('planned', LAYER, {
      ingest: { plan: 'fetch-on-demand', decidedBy: 'nick', decidedAt: '2026-09-06T00:00:00.000Z' },
    })
    await seedLink('unplanned', 'https://example.org/other.csv')
    const { cookie } = await login('maria')

    const planned = await request(app).get('/api/library/catalog?plan=fetch-on-demand').set('Cookie', cookie)
    expect(planned.body.entries.map((e: any) => e.slug)).toEqual(['planned'])

    const none = await request(app).get('/api/library/catalog?plan=none').set('Cookie', cookie)
    expect(none.body.entries.map((e: any) => e.slug)).toEqual(['unplanned'])
  })
})

/**
 * P5-80 over the wire. The page's own document list is what makes the pull
 * safe, so the route test's job is the boundary: the session, the CSRF token,
 * the subset rule, and the files actually landing where the Files tab looks.
 */
describe('POST /api/library/catalog/:slug/documents', () => {
  const PAGE = 'https://land.example.org/profiles/'
  const JONES = 'https://land.example.org/files/jones-farm.pdf'
  const SMITH = 'https://land.example.org/files/smith-woodlot.pdf'

  const publicAddress = async () => [{ address: '93.184.216.34', family: 4 }]

  /** An agency that hands back a PDF for anything under /files/. */
  function documents(): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: any) => new Response(`%PDF-1.4 ${String(input)}`, { headers: { 'content-type': 'application/pdf' } }))
  }

  async function seedPage(slug: string): Promise<void> {
    await seedLink(slug, PAGE, {
      inspection: {
        kind: 'page',
        confidence: 'high',
        url: PAGE,
        documents: [
          { url: JONES, label: 'The Jones farm, 2024' },
          { url: SMITH, label: 'Smith woodlot' },
        ],
      },
    })
  }

  beforeEach(() => {
    setDocumentPullDefaults({ fetchImpl: documents() as unknown as typeof fetch, lookup: publicAddress, tmpDir: dataDir })
  })

  it('is closed to the logged-out, and refuses without a CSRF token', async () => {
    await seedPage('a')
    expect((await request(app).post('/api/library/catalog/a/documents').send({ urls: [JONES] })).status).toBe(401)

    const { cookie } = await login('maria')
    const res = await request(app).post('/api/library/catalog/a/documents').set('Cookie', cookie).send({ urls: [JONES] })
    expect(res.status).toBe(403)
  })

  it('pulls the ticked documents in and puts them on the entry', async () => {
    await seedPage('a')
    const { cookie, csrf } = await login('maria')
    const res = await request(app)
      .post('/api/library/catalog/a/documents')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ urls: [JONES, SMITH] })

    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([
      { url: JONES, status: 'stored', file: 'the-jones-farm-2024.pdf' },
      { url: SMITH, status: 'stored', file: 'smith-woodlot.pdf' },
    ])
    const entry = await getCatalogEntry('a')
    expect(entry!.files.map(f => f.key)).toContain('library/incoming/a/the-jones-farm-2024.pdf')
  })

  it('refuses anything the page did not offer, naming it, and fetches nothing', async () => {
    await seedPage('a')
    const fetchImpl = vi.fn()
    setDocumentPullDefaults({ fetchImpl: fetchImpl as unknown as typeof fetch, lookup: publicAddress, tmpDir: dataDir })
    const { cookie, csrf } = await login('maria')
    const res = await request(app)
      .post('/api/library/catalog/a/documents')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ urls: ['https://evil.example/payload.pdf'] })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('https://evil.example/payload.pdf')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('404s an entry that is not there', async () => {
    const { cookie, csrf } = await login('maria')
    const res = await request(app)
      .post('/api/library/catalog/gone/documents')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ urls: [JONES] })
    expect(res.status).toBe(404)
  })

  it('writes one audit row for the pull, with the counts', async () => {
    await seedPage('a')
    const { cookie, csrf } = await login('maria')
    await request(app)
      .post('/api/library/catalog/a/documents')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ urls: [JONES, SMITH] })
    await new Promise(r => setTimeout(r, 30))

    const rows = await libraryQuery(`SELECT action, target, detail FROM library_audit WHERE action = 'entry.pull-documents'`)
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0] as any
    expect(row.target).toBe('a')
    const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail
    expect(detail).toMatchObject({ asked: 2, stored: 2, failed: 0 })
  })
})
